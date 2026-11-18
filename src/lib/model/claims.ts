import type { Claim, ClaimKind, Confidence, EdgeKind, Evidence, FeatureId, Origin, SubjectRef } from "../../types";
import { claimId } from "./ids";

/** INFERRED claims never get HIGH confidence. */
export const capConfidence = (origin: Origin, c: Confidence): Confidence => (origin === "INFERRED" && c === "HIGH" ? "MEDIUM" : c);

export function newClaim(
  featureId: FeatureId | null,
  kind: ClaimKind,
  subject: SubjectRef,
  key: string,
  payload: Record<string, string>,
  evidence: Evidence[],
  origin: Origin,
  confidence: Confidence,
): Claim {
  return { id: claimId(featureId, kind, subject, key), featureId, subject, kind, payload, evidence, origin, confidence: capConfidence(origin, confidence), status: "PROPOSED" };
}

export const EDGE_CLAIM: Record<EdgeKind, ClaimKind> = {
  CALL: "CALLS",
  READ: "READS",
  WRITE: "WRITES_TO",
  PUBLISH: "PUBLISHES_TO",
  CONSUME: "CONSUMES",
  HTTP_CALL: "HTTP_CALLS",
};

export const isActive = (c: Claim) => c.status !== "REJECTED";
export const isUnverified = (c: Claim) => c.status === "PROPOSED" || c.status === "STALE";

/** CONFIRMED/EDITED (and already STALE) claims become STALE when their evidence changed or vanished. */
export function markStale(c: Claim, reasons: string[]): Claim {
  if (c.status !== "CONFIRMED" && c.status !== "EDITED" && c.status !== "STALE") return c;
  return { ...c, status: "STALE", staleReasons: [...new Set([...(c.staleReasons ?? []), ...reasons])] };
}

export function confirm(c: Claim, reviewer: string, at: string, commit: string, comment?: string): Claim {
  return { ...c, status: "CONFIRMED", review: { reviewer, at, action: "CONFIRM", comment }, verifiedAt: commit, staleReasons: undefined, previousPayload: undefined, conflict: undefined };
}

/** A human correction: origin HUMAN, protected from being overwritten by re-analysis. */
export function edit(c: Claim, payload: Record<string, string>, reviewer: string, at: string, commit: string, comment?: string): Claim {
  return {
    ...c, payload, origin: "HUMAN", confidence: "HIGH", status: "EDITED",
    review: { reviewer, at, action: "EDIT", comment }, verifiedAt: commit, staleReasons: undefined, previousPayload: undefined, conflict: undefined,
  };
}

/** Rejected claims are remembered so the analysis does not propose them again. */
export function reject(c: Claim, reviewer: string, at: string, comment?: string): Claim {
  return { ...c, status: "REJECTED", review: { reviewer, at, action: "REJECT", comment }, conflict: undefined };
}
