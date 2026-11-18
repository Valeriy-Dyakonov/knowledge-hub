import { SCHEMA_VERSION, type KnowledgeModel } from "../../types";
import type { RunContext, Stage } from "./types";

/** Stage 5: wraps facts into claims, merges with the reviewed model and saves it. Claims and merge come in M3. */
export const assembleStage: Stage = {
  id: "assemble",
  required: true,
  async run(ctx) {
    const model = assemble(ctx);
    ctx.state.model = model;
    await ctx.backend.saveModel(ctx.options.serviceId, model);
    ctx.log("ok", "assembleSummary", { features: String(model.features.length), claims: "0", unverified: "0", conflicts: "0" });
  },
};

export function assemble(ctx: RunContext): KnowledgeModel {
  const scan = ctx.state.scan;
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
    catalog: { components: ctx.state.catalogComponents ?? [], sinks: ctx.state.catalogSinks ?? [], claims: [] },
    features: ctx.previous?.features ?? [],
  };
}
