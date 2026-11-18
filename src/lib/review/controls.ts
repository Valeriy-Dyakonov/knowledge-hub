import type { Claim, KnowledgeModel, ReviewItem } from "../../types";
import { stableHash } from "../model/ids";

const SWAPPABLE = new Set(["WRITES_TO", "READS", "PUBLISHES_TO", "HTTP_CALLS", "CALLS"]);

/**
 * A control item: a real edge claim of the batch's features with its target swapped for a wrong one (another table,
 * topic or component; a made-up table if there is no other). The evidence stays real, so only a reviewer who looks at
 * the code notices. Confirming it fails the batch. Control items never reach the model.
 */
export function controlItem(model: KnowledgeModel, batchClaims: Claim[], batchId: string): ReviewItem | undefined {
  const featureIds = new Set(batchClaims.map((c) => c.featureId));
  const pool = model.features
    .filter((f) => featureIds.has(f.id))
    .flatMap((f) => f.claims)
    .concat(model.features.flatMap((f) => f.claims))
    .filter((c) => SWAPPABLE.has(c.kind) && c.payload.to && c.status !== "REJECTED" && c.evidence.length);
  const source = pool[parseInt(stableHash([batchId, "control"], 6), 16) % Math.max(pool.length, 1)];
  if (!source) return undefined;

  const to = source.payload.to;
  let wrong: string | undefined;
  if (source.payload.toType === "SINK") {
    const kind = model.catalog.sinks.find((s) => s.id === to)?.kind;
    wrong = model.catalog.sinks.find((s) => s.kind === kind && s.id !== to)?.id;
    if (!wrong) wrong = `${to}_archive`;
  } else {
    // Another component the source does not call in this feature.
    const called = new Set(model.features.flatMap((f) => f.edges).filter((e) => e.from.id === source.payload.from).map((e) => e.to.id));
    wrong = model.catalog.components.find((c) => c.id !== to && c.id !== source.payload.from && !called.has(c.id))?.id;
  }
  if (!wrong) return undefined;
  const id = "ctl-" + stableHash([batchId, source.id, wrong], 12);
  const claim: Claim = { ...source, id, payload: { ...source.payload, to: wrong }, status: "PROPOSED", review: undefined, conflict: undefined, previousPayload: undefined, staleReasons: undefined };
  return { id, claim, control: true };
}
