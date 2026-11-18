import type { Claim, FeatureStatus } from "../../types";

/** Review status from claims: any stale -> STALE, any proposed -> DRAFT, otherwise REVIEWED. Same rule in Rust `model::status_of`. */
export function statusOf(claims: Claim[]): FeatureStatus {
  if (claims.some((c) => c.status === "STALE")) return "STALE";
  if (claims.some((c) => c.status === "PROPOSED")) return "DRAFT";
  return "REVIEWED";
}
