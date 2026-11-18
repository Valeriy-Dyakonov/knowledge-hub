import type { Stage } from "./types";

/** Stage 2: groups entry points into candidate features. Filled in M3. */
export const discoverStage: Stage = {
  id: "discover",
  required: true,
  async run(ctx) {
    ctx.state.candidates = [];
    ctx.log("ok", "discoverSummary", { candidates: "0" });
  },
};
