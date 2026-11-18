import type { ClaimKind, FeatureId, SubjectRef } from "../../types";

// cyrb53: fast, well-distributed 53-bit string hash; two seeds give 106 bits, plenty for ids within one service.
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Deterministic short hash of the parts; the separator cannot occur inside ids. */
export function stableHash(parts: (string | null | undefined)[], length = 16): string {
  const s = parts.map((p) => p ?? "").join("\u0000");
  return (cyrb53(s, 1).toString(16).padStart(14, "0") + cyrb53(s, 2).toString(16).padStart(14, "0")).slice(0, length);
}

/**
 * Claim ids are built from scope, kind, subject and key features — never from line numbers — so a re-run produces the
 * same id and the review survives (docs/02-domain-model.md, "Стабильные идентификаторы").
 */
export const claimId = (featureId: FeatureId | null, kind: ClaimKind, subject: SubjectRef, key: string): string =>
  "c-" + stableHash([featureId ?? "_service", kind, subject.type, subject.id, key]);

export const edgeId = (fromType: string, from: string, toType: string, to: string, kind: string, label: string): string =>
  "e-" + stableHash([fromType, from, toType, to, kind, label], 12);

export const sinkId = (kind: string, name: string): string => `${kind.toLowerCase()}:${name}`;

/** `RefundController` / `refunds_created` -> `refund-controller` / `refunds-created`. */
export function kebab(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const simpleName = (fqn: string): string => fqn.slice(fqn.lastIndexOf(".") + 1);
