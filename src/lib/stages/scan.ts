import type { Stage } from "./types";

/** Stage 1: Rust extractors and context sources collect static facts. No LLM. */
export const scanStage: Stage = {
  id: "scan",
  required: true,
  async run(ctx) {
    const result = await ctx.backend.scanRepo(ctx.options.repoPath);
    for (const step of result.steps) {
      if (step.version) ctx.versions[`${step.kind}.${step.id}`] = step.version;
      if (step.status === "failed" && step.error) ctx.warn(step.error.code, { id: step.id, ...stringify(step.error.params) });
    }
    ctx.state.scan = result;
    const f = result.facts;
    ctx.log("ok", "scanSummary", {
      components: String(f.components.length),
      triggers: String(f.triggers.length),
      calls: String(f.calls.length),
      sinkAccesses: String(f.sinkAccesses.length),
      properties: String(Object.keys(result.context.properties).length),
    });
  },
};

const stringify = (p?: Record<string, unknown>) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, String(v)]));
