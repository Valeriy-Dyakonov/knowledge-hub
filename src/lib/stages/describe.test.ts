import { describe, expect, it } from "vitest";
import type { Backend } from "../../api";
import type { KnowledgeModel, LogEntry } from "../../types";
import { confirm } from "../model/claims";
import { mergeModels } from "../model/merge";
import { analyse, scan } from "../testing/fixture";
import { describeStage, parse, RateLimiter } from "./describe";
import { discover } from "./discover";
import { Tracer } from "./trace";
import type { RunContext, RunState } from "./types";

function context(llm: (system: string, user: string) => Promise<string>, previous: KnowledgeModel | null = null) {
  const candidates = discover(scan.facts, scan.context, previous);
  const tracer = new Tracer(scan.facts, scan.context);
  const traced = candidates.map((c) => tracer.trace(c));
  const state: RunState = {
    scan, candidates,
    traced: traced.map(({ candidate, feature }) => ({ candidate, feature })),
    catalogComponents: tracer.catalogComponents(),
    catalogSinks: [...new Map(traced.flatMap((t) => t.sinks).map((x) => [x.id, x])).values()],
  };
  const warnings: LogEntry[] = [];
  const requests: string[] = [];
  const slept: number[] = [];
  const ctx = {
    options: { serviceId: "refunds", serviceName: "Refunds", repoPath: "/r", language: "ru", describe: true },
    backend: { llmChat: (s: string, u: string) => { requests.push(u); return llm(s, u); } } as unknown as Backend,
    state, previous, versions: {}, warnings,
    log: () => {},
    warn: (code: string, params?: Record<string, string>) => warnings.push({ at: "", level: "warn", code, params }),
    progress: () => {},
    sleep: async (ms: number) => { slept.push(ms); },
    now: () => "",
  } as unknown as RunContext;
  return { ctx, warnings, requests, slept };
}

/** Names every feature, component and sink it was asked about. */
const echo = async (_: string, user: string) => {
  const req = JSON.parse(user) as { features: { id: string }[]; components: { id: string }[]; sinks: { id: string }[] };
  return "```json\n" + JSON.stringify({
    features: req.features.map((f) => ({ id: f.id, name: `Имя ${f.id}`, description: "Описание" })),
    components: req.components.map((c) => ({ id: c.id, name: `К ${c.id}` })),
    sinks: req.sinks.map((s) => ({ id: s.id, name: `С ${s.id}` })),
  }) + "\n```";
};

describe("describe stage", () => {
  it("collects business names in the analysis language", async () => {
    const { ctx, warnings, requests } = context(echo);
    await describeStage.run(ctx);
    const d = ctx.state.descriptions!;
    expect(Object.keys(d.features)).toHaveLength(6);
    expect(d.features["refunds/create-refund"].name).toBe("Имя refunds/create-refund");
    expect(d.sinks["db_table:refunds"]).toBe("С db_table:refunds");
    expect(warnings).toEqual([]);
    expect(requests).toHaveLength(1);
    // Only names go out, no source code.
    expect(requests[0]).not.toContain("fun ");
  });

  it("degrades to technical names on a bad answer", async () => {
    const { ctx, warnings } = context(async () => "sorry, I cannot");
    await describeStage.run(ctx);
    expect(ctx.state.descriptions!.features).toEqual({});
    expect(warnings.map((w) => w.code)).toEqual(["llmBadResponse", "businessNamesMissing"]);
  });

  it("stops asking when the LLM is not configured", async () => {
    let calls = 0;
    const { ctx, warnings } = context(async () => { calls++; throw { code: "llmNotConfigured" }; });
    await describeStage.run(ctx);
    expect(calls).toBe(1);
    expect(warnings[0].code).toBe("llmNotConfigured");
  });

  it("does not ask again for names confirmed in review", async () => {
    const first = context(echo);
    await describeStage.run(first.ctx);
    let model = mergeModels(null, analyse(scan, null, first.ctx.state.descriptions));
    model = { ...model, features: model.features.map((f) => ({ ...f, claims: f.claims.map((c) => (c.kind === "DESCRIBES" ? confirm(c, "ann", "now", "x") : c)) })) };
    const second = context(echo, model);
    await describeStage.run(second.ctx);
    expect(second.requests).toHaveLength(0);
  });

  it("keeps to the request budget and the rate limit", async () => {
    const { ctx, warnings, requests, slept } = context(echo);
    (ctx.options as { llm?: unknown }).llm = { requestsPerMinute: 2, maxRequests: 0 };
    await describeStage.run(ctx);
    expect(requests).toHaveLength(0);
    expect(warnings[0].code).toBe("llmBudgetExceeded");
    expect(slept).toEqual([]);

    const limiter = new RateLimiter(2, async (ms) => { now += ms; }, () => now);
    let now = 0;
    expect(await limiter.acquire(() => {})).toBe(0);
    now += 10_000;
    expect(await limiter.acquire(() => {})).toBe(20_000); // 2 per minute: 30 s apart
  });

  it("retries a request rejected with HTTP 429", async () => {
    let calls = 0;
    const { ctx, warnings, slept } = context(async (s, u) => {
      calls++;
      if (calls === 1) throw { code: "http", params: { service: "LLM", status: "429 Too Many Requests" } };
      return echo(s, u);
    });
    await describeStage.run(ctx);
    expect(calls).toBe(2);
    expect(slept).toContain(15_000);
    expect(warnings).toEqual([]);
    expect(Object.keys(ctx.state.descriptions!.features)).toHaveLength(6);
  });

  it("parses JSON wrapped in prose", () => {
    expect(parse('Here: {"a": 1} done')).toEqual({ a: 1 });
    expect(() => parse("{oops")).toThrow();
  });
});
