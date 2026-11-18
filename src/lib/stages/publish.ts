import { RENDERERS } from "../render";
import { runStep } from "../steps";
import type { Stage } from "./types";

/** Stage 6: markdown and diagrams generated from the model. Unreviewed content is rendered with its status. */
export const renderStage: Stage = {
  id: "render",
  required: true,
  skipReason: () => (RENDERERS.length ? null : "noRenderers"),
  async run(ctx) {
    const model = ctx.state.model;
    if (!model) return;
    let files = 0;
    for (const r of RENDERERS) {
      await runStep(ctx, "renderer", r.id, false, null, async () => {
        const out = r.render(model, { language: ctx.options.language });
        await ctx.backend.writeGenerated(ctx.options.serviceId, out);
        files += out.length;
      });
    }
    ctx.log("ok", "renderSummary", { files: String(files) });
  },
};

/** Stage 7: the full-text index (SQLite FTS5, Rust) is rebuilt from the saved model; MCP `search` reads it. */
export const indexStage: Stage = {
  id: "index",
  required: false,
  async run(ctx) {
    const n = await ctx.backend.indexService(ctx.options.serviceId);
    ctx.log("ok", "indexSummary", { features: String(n) });
  },
};
