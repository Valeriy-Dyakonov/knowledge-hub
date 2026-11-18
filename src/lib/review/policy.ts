import { SUMMARY_ITEM, type Claim, type CloseDecision, type KnowledgeModel, type ReviewAnswer, type ReviewBatch, type ReviewItem } from "../../types";
import { stableHash } from "../model/ids";
import { controlItem } from "./controls";

export interface ReviewSelection {
  model: KnowledgeModel;
  reviewer: string;
  /** Claims already in another open batch. */
  exclude: Set<string>;
  now: string;
}

/** Review rules (docs/04-review.md). A new rule set is a new policy in `POLICIES`. */
export interface ReviewPolicy {
  readonly id: string;
  selectForReview(sel: ReviewSelection): ReviewBatch[];
  canClose(batch: ReviewBatch, answers: ReviewAnswer[]): CloseDecision;
}

interface PolicyOptions {
  id: string;
  batchSize: number;
  /** Mix a deliberately wrong claim into each batch. */
  controls: boolean;
  /** The static summary is accepted only when the reviewer types the number of facts. */
  requireCount: boolean;
  /** Median time per item below which a batch is flagged as suspiciously fast. */
  tooFastMs: number;
}

const pending = (c: Claim) => c.status === "PROPOSED" || c.status === "STALE" || !!c.conflict;

/** STATIC + HIGH facts that are new are accepted as a summary; everything else is looked at one by one. */
export const needsHuman = (c: Claim) =>
  c.origin !== "STATIC" || c.confidence !== "HIGH" || c.kind === "DESCRIBES" || c.status === "STALE" || !!c.conflict || !!c.previousPayload;

/** Lower is riskier, reviewed first: conflicts, stale, low confidence, inferred, names, the rest. */
export function risk(c: Claim): number {
  if (c.conflict) return 0;
  if (c.status === "STALE") return 1;
  if (c.previousPayload) return 2;
  if (c.confidence === "LOW") return 3;
  if (c.origin === "INFERRED" && c.kind !== "DESCRIBES") return 4;
  if (c.kind === "DESCRIBES") return 5;
  return 6;
}

const SINK_CLAIMS = new Set(["WRITES_TO", "READS", "PUBLISHES_TO", "HTTP_CALLS"]);

/** A doubtful sink claim becomes a question with options instead of "is this right?". */
function options(c: Claim, model: KnowledgeModel): string[] | undefined {
  if (!SINK_CLAIMS.has(c.kind) || c.confidence === "HIGH" || c.payload.toType !== "SINK") return undefined;
  const actual = model.catalog.sinks.find((s) => s.id === c.payload.to);
  if (!actual) return undefined;
  const others = model.catalog.sinks.filter((s) => s.kind === actual.kind && s.id !== actual.id).slice(0, 2).map((s) => s.id);
  return [actual.id, ...others].sort((a, b) => stableHash([c.id, a]).localeCompare(stableHash([c.id, b])));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : Infinity;
}

export function makePolicy(o: PolicyOptions): ReviewPolicy {
  return {
    id: o.id,

    selectForReview({ model, reviewer, exclude, now }) {
      const owners = new Map(model.features.map((f) => [f.id, f.owner ?? ""]));
      const candidates = [...model.catalog.claims, ...model.features.flatMap((f) => f.claims)].filter((c) => pending(c) && !exclude.has(c.id));
      const human = candidates.filter(needsHuman);
      const bulk = candidates.filter((c) => !needsHuman(c));
      // Items go to the feature owner; within an owner, riskiest first.
      const ownerOf = (c: Claim) => owners.get(c.featureId ?? "") ?? "";
      human.sort((a, b) => ownerOf(a).localeCompare(ownerOf(b)) || risk(a) - risk(b) || a.id.localeCompare(b.id));

      const batches: ReviewBatch[] = [];
      let i = 0;
      while (i < human.length) {
        const owner = ownerOf(human[i]);
        const chunk: Claim[] = [];
        while (i < human.length && chunk.length < o.batchSize && ownerOf(human[i]) === owner) chunk.push(human[i++]);
        const id = "b-" + stableHash([now, reviewer, chunk[0].id], 12);
        const items: ReviewItem[] = chunk.map((c) => ({ id: c.id, claim: c, options: options(c, model) }));
        const control = o.controls ? controlItem(model, chunk, id) : undefined;
        if (control) items.splice(parseInt(stableHash([id], 6), 16) % (items.length + 1), 0, control);
        batches.push({ id, serviceId: model.service.id, policy: o.id, kind: "REGULAR", reviewer, owner: owner || undefined, items, openedAt: now });
      }
      if (bulk.length) {
        const byKind: Record<string, number> = {};
        for (const c of bulk) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
        const files = new Set(bulk.flatMap((c) => c.evidence.map((e) => e.path))).size;
        const examples = [...bulk].sort((a, b) => stableHash([now, a.id]).localeCompare(stableHash([now, b.id]))).slice(0, 5).map((c) => c.id);
        batches.push({
          id: "b-" + stableHash([now, reviewer, "summary"], 12),
          serviceId: model.service.id, policy: o.id, kind: "STATIC_SUMMARY", reviewer,
          items: bulk.map((c) => ({ id: c.id, claim: c })),
          summary: { count: bulk.length, byKind, files, examples },
          openedAt: now,
        });
      }
      return batches;
    },

    canClose(batch, answers) {
      const by = new Map(answers.map((a) => [a.itemId, a]));
      if (batch.kind === "STATIC_SUMMARY") {
        const a = by.get(SUMMARY_ITEM);
        if (!a) return { accepted: false, reasonCode: "batchIncomplete", params: { missing: "1" }, flags: [], failedControlItems: [] };
        if (a.action === "CONFIRM" && o.requireCount && a.acknowledgedCount !== batch.summary?.count) {
          return { accepted: false, reasonCode: "summaryNotAcknowledged", flags: [], failedControlItems: [] };
        }
        return { accepted: true, flags: [], failedControlItems: [] };
      }
      const missing = batch.items.filter((it) => !by.has(it.id)).length;
      if (missing) return { accepted: false, reasonCode: "batchIncomplete", params: { missing: String(missing) }, flags: [], failedControlItems: [] };
      const failed = batch.items.filter((it) => it.control && by.get(it.id)?.action === "CONFIRM").map((it) => it.id);
      const flags: string[] = [];
      const times = answers.map((a) => a.millisSpent).filter((x): x is number => typeof x === "number");
      if (times.length && median(times) < o.tooFastMs) flags.push("tooFast");
      const real = batch.items.filter((it) => !it.control);
      if (real.length >= 5 && real.every((it) => by.get(it.id)?.action === "CONFIRM")) flags.push("allConfirmed");
      if (failed.length) return { accepted: false, reasonCode: "controlFailed", flags, failedControlItems: failed };
      return { accepted: true, flags, failedControlItems: [] };
    },
  };
}

export const strictPolicy = makePolicy({ id: "strict", batchSize: 15, controls: true, requireCount: true, tooFastMs: 2500 });
export const lenientPolicy = makePolicy({ id: "lenient", batchSize: 40, controls: false, requireCount: false, tooFastMs: 800 });

/** Registered policies; chosen in Settings. */
export const POLICIES: ReviewPolicy[] = [strictPolicy, lenientPolicy];

export const policyById = (id: string): ReviewPolicy => POLICIES.find((p) => p.id === id) ?? strictPolicy;
