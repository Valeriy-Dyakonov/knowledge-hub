import type { Stage } from "./types";

const str = (p?: Record<string, unknown>) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, String(v)]));

/** Stage 1: Rust extractors and context sources collect static facts. No LLM. */
export const scanStage: Stage = {
  id: "scan",
  required: true,
  async run(ctx) {
    const result = await ctx.backend.scanRepo(ctx.options.repoPath, (p) =>
      ctx.progress({ code: p.kind === "extractor" ? "scanFile" : "scanSource", params: { id: p.id, item: p.item }, current: p.current, total: p.total }),
    );
    for (const step of result.steps) {
      if (step.version) ctx.versions[`${step.kind}.${step.id}`] = step.version;
      const params = { id: step.id, millis: String(step.millis ?? 0), ...str(step.stats) };
      if (step.status === "failed" && step.error) ctx.warn(step.error.code, { ...params, ...str(step.error.params) });
      else ctx.log("info", step.kind === "extractor" ? "extractorDone" : `source:${step.id}`, params);
    }
    ctx.state.scan = result;
    const f = result.facts;
    for (const u of f.unresolved.filter((x) => x.reason === "PARSE_ERROR")) ctx.warn("parseError", { file: u.componentId, detail: u.detail });
    ctx.log("ok", "scanSummary", {
      components: String(f.components.length),
      triggers: String(f.triggers.length),
      calls: String(f.calls.length),
      sinkAccesses: String(f.sinkAccesses.length),
      properties: String(Object.keys(result.context.properties).length),
    });
  },
};
