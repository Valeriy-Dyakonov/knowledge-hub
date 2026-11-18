import { SCHEMA_VERSION, type Claim, type Evidence, type Feature, type KnowledgeModel, type OwnershipRule, type SubjectRef } from "../../types";
import { EDGE_CLAIM, isUnverified, newClaim } from "../model/claims";
import { buildConfig } from "../model/config";
import { buildDatabase } from "../model/database";
import { mergeModels } from "../model/merge";
import type { Descriptions, FeatureCandidate, RunContext, Stage } from "./types";

/** Stage 5: wraps every fact into a claim, merges with the reviewed model and saves it. No LLM. */
export const assembleStage: Stage = {
  id: "assemble",
  required: true,
  async run(ctx) {
    const model = mergeModels(ctx.previous, assemble(ctx));
    ctx.state.model = model;
    await ctx.backend.saveModel(ctx.options.serviceId, model);
    const claims = [...model.catalog.claims, ...model.features.flatMap((f) => f.claims)];
    const by = (s: string) => String(claims.filter((c) => c.status === s).length);
    ctx.log("info", "mergeSummary", {
      proposed: by("PROPOSED"),
      confirmed: String(claims.filter((c) => c.status === "CONFIRMED" || c.status === "EDITED").length),
      stale: by("STALE"),
      rejected: by("REJECTED"),
      diffs: String(claims.filter((c) => c.previousPayload).length),
    });
    ctx.log("ok", "assembleSummary", {
      features: String(model.features.length),
      claims: String(claims.length),
      unverified: String(claims.filter(isUnverified).length),
      conflicts: String(claims.filter((c) => c.conflict).length),
    });
  },
};

const describes = (featureId: string | null, subject: SubjectRef, field: string, language: string, text: string, evidence: Evidence[]) =>
  newClaim(featureId, "DESCRIBES", subject, `${field}:${language}`, { field, language, text }, evidence, "INFERRED", "MEDIUM");

/** The fresh model of this run, before merging with the previous one. */
export function assemble(ctx: RunContext): KnowledgeModel {
  const scan = ctx.state.scan;
  const d: Descriptions = ctx.state.descriptions ?? { language: ctx.options.language, features: {}, components: {}, sinks: {} };
  const ownership = scan?.context.ownership ?? [];
  const features = (ctx.state.traced ?? []).map((t) => buildFeature(t.candidate, t.feature, d, ownership));
  const components = ctx.state.catalogComponents ?? [];
  const sinks = ctx.state.catalogSinks ?? [];
  const catalogClaims: Claim[] = [];
  for (const c of components) {
    const name = d.components[c.id];
    if (name) catalogClaims.push(describes(null, { type: "COMPONENT", id: c.id }, "businessName", d.language, name, c.evidence ? [c.evidence] : []));
  }
  for (const s of sinks) {
    const name = d.sinks[s.id];
    if (!name) continue;
    const ev = features.flatMap((f) => f.edges.filter((e) => e.to.id === s.id || e.from.id === s.id).map((e) => e.evidence)).find(Boolean);
    catalogClaims.push(describes(null, { type: "SINK", id: s.id }, "businessName", d.language, name, ev ? [ev] : []));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    service: {
      id: ctx.options.serviceId,
      name: ctx.options.serviceName,
      repo: ctx.options.repoPath,
      branch: scan?.branch,
      stack: Object.keys(ctx.versions).filter((k) => k.startsWith("extractor.")).map((k) => k.slice("extractor.".length)),
      lastAnalyzedCommit: scan?.commit,
    },
    catalog: { components, sinks, claims: catalogClaims },
    features,
    // Reference facts with evidence: regenerated on every run, not merged with review.
    database: scan ? buildDatabase(scan.facts, scan.context, sinks) : undefined,
    config: scan ? buildConfig(scan.facts, scan.context) : undefined,
  };
}

export function buildFeature(candidate: FeatureCandidate, traced: Feature, d: Descriptions, ownership: OwnershipRule[]): Feature {
  const fid = traced.id;
  const claims: Claim[] = [];
  for (const t of traced.triggers) {
    const ev = t.evidence ? [t.evidence] : [];
    const subject: SubjectRef = { type: "TRIGGER", id: t.id };
    claims.push(newClaim(fid, "EXISTS", subject, t.id, { type: t.type, technicalName: t.technicalName }, ev, "STATIC", "HIGH"));
    // Feature boundaries are a heuristic (an open question in docs/09-roadmap.md): always reviewed.
    claims.push(newClaim(fid, "BELONGS_TO_FEATURE", subject, fid, { feature: fid, group: candidate.group, reason: candidate.groupingReason }, ev, "INFERRED", "MEDIUM"));
  }
  const edges = traced.edges.map((e) => {
    const c = newClaim(
      fid, EDGE_CLAIM[e.kind], { type: "EDGE", id: e.id }, e.id,
      { from: e.from.id, to: e.to.id, toType: e.to.type, label: e.label, edgeKind: e.kind },
      e.evidence ? [e.evidence] : [], e.origin, e.confidence,
    );
    claims.push(c);
    return { ...e, claimId: c.id };
  });
  const featureEv = traced.triggers.flatMap((t) => (t.evidence ? [t.evidence] : []));
  const desc = d.features[fid];
  if (desc) {
    claims.push(describes(fid, { type: "FEATURE", id: fid }, "businessName", d.language, desc.name, featureEv));
    if (desc.description) claims.push(describes(fid, { type: "FEATURE", id: fid }, "description", d.language, desc.description, featureEv));
  }
  const owner = featureEv[0] ? ownerOf(featureEv[0].path, ownership) : undefined;
  return { ...traced, owner, edges, claims };
}

/** CODEOWNERS semantics: the last matching rule wins. */
export function ownerOf(path: string, rules: OwnershipRule[]): string | undefined {
  let owner: string | undefined;
  for (const r of rules) if (matches(r.pattern, path)) owner = r.owners[0];
  return owner;
}

function matches(pattern: string, path: string): boolean {
  const p = pattern.trim();
  if (p === "*") return true;
  const anchored = p.startsWith("/");
  const body = p.replace(/^\/+/, "");
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = body.split("**").map((part) => part.split("*").map(esc).join("[^/]*")).join(".*");
  const full = body.endsWith("/") ? `${re}.*` : `${re}(/.*)?`;
  return new RegExp(anchored ? `^${full}$` : `^(.*/)?${full}$`).test(path);
}
