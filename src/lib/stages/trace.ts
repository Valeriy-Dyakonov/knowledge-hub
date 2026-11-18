import type { Stage } from "./types";

/** Stage 3: graph from each trigger to its sinks. Filled in M3. */
export const traceStage: Stage = {
  id: "trace",
  required: true,
  async run(ctx) {
    ctx.state.traced = [];
    ctx.state.catalogComponents = [];
    ctx.state.catalogSinks = [];
    ctx.log("ok", "traceSummary", { features: "0", breaks: "0" });
  },
};
