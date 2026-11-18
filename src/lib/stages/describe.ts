import type { Claim, KnowledgeModel } from "../../types";
import { HubError, errorInfo } from "../errors";
import { describePrompt, PROMPT_VERSION } from "../prompt";
import { redact } from "../redact";
import type { Descriptions, FeatureDescription, Stage } from "./types";

export const CHUNK_SIZE = 8;

const reviewed = (c: Claim, lang: string) => c.kind === "DESCRIBES" && c.payload.language === lang && (c.status === "CONFIRMED" || c.status === "EDITED");

/**
 * Stage 4: business names and short descriptions through the LLM. Optional: when the LLM is missing or fails, the run
 * keeps the static model with technical names (like the AiAllocator -> HeuristicAllocator fallback in worklog-tracker).
 * Only a minimal slice goes out — names of triggers, components and sinks, never file contents — and it is redacted.
 * Names already confirmed or edited in review are not asked again.
 */
export const describeStage: Stage = {
  id: "describe",
  required: false,
  skipReason: (ctx) => (ctx.options.describe ? null : "disabledByOption"),
  async run(ctx) {
    ctx.versions["prompt.describe"] = PROMPT_VERSION;
    const lang = ctx.options.language;
    const traced = ctx.state.traced ?? [];
    const todo = traced.filter((t) => !reviewedFeature(ctx.previous, t.feature.id, lang));
    const done = reviewedCatalog(ctx.previous, lang);
    const components = new Map((ctx.state.catalogComponents ?? []).filter((c) => !done.has(c.id)).map((c) => [c.id, c]));
    const sinks = new Map((ctx.state.catalogSinks ?? []).filter((s) => !done.has(s.id)).map((s) => [s.id, s]));

    const result: Descriptions = { language: lang, features: {}, components: {}, sinks: {} };
    let failed = 0;
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
      const chunk = todo.slice(i, i + CHUNK_SIZE);
      const ids = new Set(chunk.map((t) => t.feature.id));
      const usedComponents = [...new Set(chunk.flatMap((t) => t.feature.componentIds))].filter((id) => components.has(id));
      const usedSinks = [...new Set(chunk.flatMap((t) => t.feature.sinkIds))].filter((id) => sinks.has(id));
      const slice = {
        features: chunk.map(({ feature: f }) => ({
          id: f.id,
          triggers: f.triggers.map((t) => t.technicalName),
          steps: f.steps.map((s) => `${components.get(s.componentId)?.technicalName ?? s.componentId.split(".").pop()}.${s.action}`),
          sinks: f.sinkIds.map((id) => sinks.get(id) ?? ctx.state.catalogSinks?.find((s) => s.id === id)).filter(Boolean).map((s) => `${s!.kind}:${s!.technicalName}`),
        })),
        components: usedComponents.map((id) => ({ id, name: components.get(id)!.technicalName, kind: components.get(id)!.kind })),
        sinks: usedSinks.map((id) => ({ id, name: sinks.get(id)!.technicalName, kind: sinks.get(id)!.kind })),
      };
      try {
        const answer = parse(await ctx.backend.llmChat(describePrompt(lang), redact(JSON.stringify(slice))));
        for (const x of list(answer.features)) {
          const name = str(x.name);
          if (name && ids.has(str(x.id))) result.features[str(x.id)] = { name, description: str(x.description) } satisfies FeatureDescription;
        }
        for (const x of list(answer.components)) if (str(x.name) && components.has(str(x.id))) result.components[str(x.id)] = str(x.name);
        for (const x of list(answer.sinks)) if (str(x.name) && sinks.has(str(x.id))) result.sinks[str(x.id)] = str(x.name);
      } catch (e) {
        failed++;
        const { code, params } = errorInfo(e);
        ctx.warn(code, params);
        // The LLM is not configured or unreachable: no point in asking again for every chunk.
        if (code === "llmNotConfigured" || code === "service") break;
      }
    }
    const missing = todo.filter((t) => !result.features[t.feature.id]).length;
    if (missing) ctx.warn("businessNamesMissing", { count: String(missing) });
    ctx.state.descriptions = result;
    ctx.log("ok", "describeSummary", { described: String(Object.keys(result.features).length), reused: String(traced.length - todo.length), failedRequests: String(failed) });
  },
};

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : []);

/** The JSON object in an answer, tolerating code fences or prose around it. */
export function parse(text: string): Json {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HubError("llmBadResponse", { reason: "noJson" });
  try {
    return JSON.parse(text.slice(start, end + 1)) as Json;
  } catch {
    throw new HubError("llmBadResponse", { reason: "invalidJson" });
  }
}

function reviewedFeature(previous: KnowledgeModel | null, id: string, lang: string): boolean {
  const f = previous?.features.find((x) => x.id === id);
  return !!f && f.claims.some((c) => reviewed(c, lang) && c.payload.field === "businessName");
}

function reviewedCatalog(previous: KnowledgeModel | null, lang: string): Set<string> {
  return new Set((previous?.catalog.claims ?? []).filter((c) => reviewed(c, lang)).map((c) => c.subject.id));
}

