import type { Claim, Evidence, Feature, KnowledgeModel, LocalizedText, NodeType } from "../../types";
import { markStale } from "./claims";

export const REASON_MISSING = "missing";

const same = (a?: Record<string, string>, b?: Record<string, string>) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).sort(([x], [y]) => x.localeCompare(y))) : m);

/** Paths whose fragment changed (fingerprint differs) or disappeared. */
function changedEvidence(old: Evidence[], fresh: Evidence[]): string[] {
  const reasons = old
    .filter((o) => !fresh.some((n) => n.path === o.path && n.fingerprint === o.fingerprint))
    .map((o) => `changed:${o.path}`);
  return [...new Set(reasons)];
}

function mergeClaim(old: Claim | undefined, fresh: Claim): Claim {
  const proposed: Claim = { ...fresh, analysisPayload: fresh.payload };
  if (!old) return proposed;
  const changed = changedEvidence(old.evidence, fresh.evidence);
  const keep = (c: Claim): Claim => ({ ...c, evidence: fresh.evidence, analysisPayload: fresh.payload });
  switch (old.status) {
    case "REJECTED":
      return keep(old);
    case "PROPOSED":
      return proposed;
    case "CONFIRMED":
      // A changed confirmed claim is a diff to review; unchanged meaning but changed code -> stale.
      if (!same(fresh.payload, old.payload)) return { ...proposed, previousPayload: old.payload };
      return changed.length ? markStale(keep(old), changed) : keep(old);
    case "EDITED":
      // Human edits are never overwritten silently: a different proposal becomes a conflict.
      if (old.analysisPayload && !same(fresh.payload, old.analysisPayload)) return { ...keep(old), conflict: fresh.payload };
      return changed.length ? markStale(keep(old), changed) : keep(old);
    case "STALE":
      if (old.origin === "HUMAN") return markStale(keep(old), changed);
      if (!same(fresh.payload, old.payload)) return { ...keep(old), payload: fresh.payload, previousPayload: old.payload };
      return markStale(keep(old), changed);
  }
}

/** What happens to a previous claim the fresh analysis did not produce. */
function carryOver(c: Claim): Claim | null {
  if (c.kind === "DESCRIBES") return c; // not regenerated (LLM skipped or reused): stays as it was
  if (c.status === "REJECTED") return c;
  if (c.origin === "HUMAN" || c.status === "CONFIRMED" || c.status === "EDITED" || c.status === "STALE") return markStale(c, [REASON_MISSING]);
  return null;
}

/**
 * Merges a fresh analysis into the previous (reviewed) model so that reviews survive re-runs: rejected claims stay
 * rejected, confirmed claims go stale when their code changed, changed confirmed claims become a diff to review,
 * human edits are kept and a different proposal is recorded as a conflict.
 */
export function mergeModels(previous: KnowledgeModel | null, fresh: KnowledgeModel): KnowledgeModel {
  if (!previous) {
    const withAnalysis = (cs: Claim[]) => cs.map((c) => ({ ...c, analysisPayload: c.payload }));
    return project({
      ...fresh,
      catalog: { ...fresh.catalog, claims: withAnalysis(fresh.catalog.claims) },
      features: fresh.features.map((f) => ({ ...f, claims: withAnalysis(f.claims) })).sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  const all = (m: KnowledgeModel) => [...m.catalog.claims, ...m.features.flatMap((f) => f.claims)];
  const old = new Map(all(previous).map((c) => [c.id, c]));
  const freshIds = new Set(all(fresh).map((c) => c.id));
  const leftovers = new Map<string, Claim[]>();
  for (const c of all(previous)) {
    if (freshIds.has(c.id)) continue;
    const kept = carryOver(c);
    if (!kept) continue;
    const key = c.featureId ?? "";
    leftovers.set(key, [...(leftovers.get(key) ?? []), kept]);
  }
  const features: Feature[] = fresh.features.map((f) => ({
    ...f,
    aliases: previous.features.find((p) => p.id === f.id)?.aliases ?? f.aliases,
    owner: f.owner ?? previous.features.find((p) => p.id === f.id)?.owner,
    claims: [...f.claims.map((c) => mergeClaim(old.get(c.id), c)), ...(leftovers.get(f.id) ?? [])],
  }));
  const freshFeatureIds = new Set(fresh.features.map((f) => f.id));
  // A feature that disappeared but had reviewed knowledge stays, with its claims marked stale.
  const vanished = previous.features
    .filter((f) => !freshFeatureIds.has(f.id) && (leftovers.get(f.id)?.length ?? 0) > 0)
    .map((f) => ({ ...f, claims: leftovers.get(f.id) ?? [] }));
  const catalogClaims = [...fresh.catalog.claims.map((c) => mergeClaim(old.get(c.id), c)), ...(leftovers.get("") ?? [])];
  return project({
    ...fresh,
    catalog: { ...fresh.catalog, claims: catalogClaims },
    features: [...features, ...vanished].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** subject -> field -> language -> text, from active DESCRIBES claims. */
function texts(claims: Claim[]): Map<string, Record<string, LocalizedText>> {
  const out = new Map<string, Record<string, LocalizedText>>();
  for (const c of claims) {
    if (c.kind !== "DESCRIBES" || c.status === "REJECTED") continue;
    const key = `${c.subject.type}:${c.subject.id}`;
    const fields = out.get(key) ?? {};
    const field = c.payload.field ?? "";
    const lang = c.payload.language;
    if (lang) fields[field] = { ...(fields[field] ?? {}), [lang]: c.payload.text ?? "" };
    out.set(key, fields);
  }
  return out;
}

/** Derives names and edited edge targets from claims, so claims stay the single source of reviewed values. */
export function project(model: KnowledgeModel): KnowledgeModel {
  const cat = texts(model.catalog.claims);
  return {
    ...model,
    catalog: {
      ...model.catalog,
      components: model.catalog.components.map((c) => ({ ...c, businessName: cat.get(`COMPONENT:${c.id}`)?.businessName ?? {} })),
      sinks: model.catalog.sinks.map((s) => ({ ...s, businessName: cat.get(`SINK:${s.id}`)?.businessName ?? {} })),
    },
    features: model.features.map((f) => {
      const t = texts(f.claims).get(`FEATURE:${f.id}`) ?? {};
      const edits = new Map(f.claims.filter((c) => c.subject.type === "EDGE" && c.status === "EDITED" && c.payload.to).map((c) => [c.subject.id, c]));
      const edges = f.edges.map((e) => {
        const ed = edits.get(e.id);
        return ed ? { ...e, to: { type: (ed.payload.toType as NodeType) ?? e.to.type, id: ed.payload.to } } : e;
      });
      const sinkIds = [...new Set([...f.sinkIds, ...edges.filter((e) => e.to.type === "SINK").map((e) => e.to.id)])];
      return { ...f, businessName: t.businessName ?? {}, description: t.description ?? {}, edges, sinkIds };
    }),
  };
}
