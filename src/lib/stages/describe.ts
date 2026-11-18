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
    const limits = ctx.options.llm ?? DEFAULT_LIMITS;
    const chunks: (typeof todo)[] = [];
    for (let i = 0; i < todo.length; i += CHUNK_SIZE) chunks.push(todo.slice(i, i + CHUNK_SIZE));
    // Budget per run: the features beyond it keep technical names until the next run.
    const allowed = chunks.slice(0, Math.max(0, limits.maxRequests));
    if (allowed.length < chunks.length) {
      ctx.warn("llmBudgetExceeded", { needed: String(chunks.length), allowed: String(allowed.length), features: String(chunks.slice(allowed.length).flat().length) });
    }
    ctx.log("info", "describePlan", { features: String(todo.length), reused: String(traced.length - todo.length), requests: String(allowed.length), perMinute: String(limits.requestsPerMinute) });
    const limiter = new RateLimiter(limits.requestsPerMinute, ctx.sleep ?? sleep);

    for (const [n, chunk] of allowed.entries()) {
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
      const progress = { request: String(n + 1), total: String(allowed.length), features: chunk.map((t) => t.feature.id).join(", ") };
      try {
        const waited = await limiter.acquire((seconds) => {
          ctx.progress({ code: "llmWaiting", params: { seconds: String(seconds), perMinute: String(limits.requestsPerMinute) }, current: n, total: allowed.length });
        });
        if (waited) ctx.log("detail", "llmWaited", { seconds: String(Math.round(waited / 1000)), perMinute: String(limits.requestsPerMinute) });
        ctx.progress({ code: "llmRequest", params: progress, current: n + 1, total: allowed.length });
        const started = Date.now();
        const text = await withRetry(() => ctx.backend.llmChat(describePrompt(lang), redact(JSON.stringify(slice))), ctx.sleep ?? sleep, (attempt, seconds) => {
          ctx.log("warn", "llmRetry", { attempt: String(attempt), seconds: String(seconds) });
        });
        const answer = parse(text);
        const before = Object.keys(result.features).length;
        for (const x of list(answer.features)) {
          const name = str(x.name);
          if (name && ids.has(str(x.id))) result.features[str(x.id)] = { name, description: str(x.description) } satisfies FeatureDescription;
        }
        for (const x of list(answer.components)) if (str(x.name) && components.has(str(x.id))) result.components[str(x.id)] = str(x.name);
        for (const x of list(answer.sinks)) if (str(x.name) && sinks.has(str(x.id))) result.sinks[str(x.id)] = str(x.name);
        ctx.log("detail", "llmAnswered", { ...progress, seconds: (Math.round((Date.now() - started) / 100) / 10).toString(), named: String(Object.keys(result.features).length - before) });
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

export const DEFAULT_LIMITS = { requestsPerMinute: 6, maxRequests: 20 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keeps requests at least 60/perMinute seconds apart, so the gateway is not flooded. */
export class RateLimiter {
  private last = -Infinity;
  constructor(private perMinute: number, private wait: (ms: number) => Promise<void>, private clock: () => number = Date.now) {}

  /** Waits for the next slot; returns how long it waited (ms). */
  async acquire(onWait: (seconds: number) => void): Promise<number> {
    const gap = this.perMinute > 0 ? 60_000 / this.perMinute : 0;
    const due = this.last + gap - this.clock();
    let waited = 0;
    if (due > 0) {
      onWait(Math.ceil(due / 1000));
      await this.wait(due);
      waited = due;
    }
    this.last = this.clock();
    return waited;
  }
}

/** Retries a request the gateway rejected as too frequent (HTTP 429), with growing pauses. */
async function withRetry(call: () => Promise<string>, wait: (ms: number) => Promise<void>, onRetry: (attempt: number, seconds: number) => void): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const { code, params } = errorInfo(e);
      if (code !== "http" || !String(params.status).startsWith("429") || attempt > 2) throw e;
      const seconds = 15 * attempt;
      onRetry(attempt, seconds);
      await wait(seconds * 1000);
    }
  }
}

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

