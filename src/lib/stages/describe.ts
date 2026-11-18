import type { Stage } from "./types";

/** Stage 4: business names through the LLM. Optional: without it the model keeps technical names. Filled in M4. */
export const describeStage: Stage = {
  id: "describe",
  required: false,
  skipReason: (ctx) => (ctx.options.describe ? "notImplemented" : "disabledByOption"),
  async run() {},
};
