import {
  SUMMARY_ITEM, type Claim, type CloseDecision, type GeneratedFile, type JournalEntry, type KnowledgeModel, type ReviewAnswer,
  type ReviewBatch, type ReviewQuestion, type StoredBatch,
} from "../../types";
import { HubError } from "../errors";
import { confirm, edit, reject } from "../model/claims";
import { stableHash } from "../model/ids";
import { project } from "../model/merge";
import { RENDERERS } from "../render";
import type { ReviewPolicy } from "./policy";

/** What the review use cases need from the backend; tests pass a fake. */
export interface ReviewBackend {
  loadModel(serviceId: string): Promise<KnowledgeModel | null>;
  saveModel(serviceId: string, model: KnowledgeModel): Promise<void>;
  writeGenerated(serviceId: string, files: GeneratedFile[]): Promise<void>;
  saveBatch(serviceId: string, batch: ReviewBatch): Promise<void>;
  findBatch(serviceId: string, batchId: string): Promise<StoredBatch | null>;
  openBatches(serviceId: string): Promise<StoredBatch[]>;
  saveAnswer(serviceId: string, batchId: string, answer: ReviewAnswer): Promise<void>;
  closeBatch(serviceId: string, batchId: string, state: "CLOSED" | "REJECTED", flags: string[]): Promise<void>;
  appendJournal(serviceId: string, entries: JournalEntry[]): Promise<void>;
  addQuestion(serviceId: string, question: ReviewQuestion): Promise<void>;
}

export interface CloseResult extends CloseDecision {
  /** Truth of each failed control item: the claim it was made from (its real target). */
  controls?: { itemId: string; shown: Claim }[];
}

/**
 * Review use cases: take a batch, answer items one by one, close the batch. No "approve all": every item needs its own
 * answer, the policy decides whether the batch can close, and only then answers reach the model.
 */
export class ReviewService {
  private readonly backend: ReviewBackend;
  private readonly serviceId: string;
  private readonly policy: ReviewPolicy;
  private readonly reviewer: string;
  /** Language of the regenerated documents. */
  private readonly language: string;
  private readonly now: () => string;

  constructor(o: { backend: ReviewBackend; serviceId: string; policy: ReviewPolicy; reviewer: string; language: string; now?: () => string }) {
    this.backend = o.backend;
    this.serviceId = o.serviceId;
    this.policy = o.policy;
    this.reviewer = o.reviewer;
    this.language = o.language;
    this.now = o.now ?? (() => new Date().toISOString());
  }

  /** The reviewer's open batch, or a new one with the riskiest pending items. Null when there is nothing to review. */
  async next(): Promise<StoredBatch | null> {
    const open = await this.backend.openBatches(this.serviceId);
    const mine = open.find((b) => b.batch.reviewer === this.reviewer);
    if (mine) return mine;
    const model = await this.backend.loadModel(this.serviceId);
    if (!model) return null;
    const exclude = new Set(open.flatMap((b) => b.batch.items.map((i) => i.claim.id)));
    const [batch] = this.policy.selectForReview({ model, reviewer: this.reviewer, exclude, now: this.now() });
    if (!batch) return null;
    await this.backend.saveBatch(this.serviceId, batch);
    return { batch, state: "OPEN", answers: [], flags: [] };
  }

  async answer(batchId: string, answer: ReviewAnswer): Promise<void> {
    const stored = await this.require(batchId);
    const known = stored.batch.kind === "STATIC_SUMMARY" ? answer.itemId === SUMMARY_ITEM : stored.batch.items.some((i) => i.id === answer.itemId);
    if (!known) throw new HubError("itemNotFound", { itemId: answer.itemId });
    if (answer.action === "EDIT" && (!answer.payload || !Object.keys(answer.payload).length)) throw new HubError("answerInvalid", { itemId: answer.itemId });
    await this.backend.saveAnswer(this.serviceId, batchId, answer);
  }

  async close(batchId: string): Promise<CloseResult> {
    const { batch, answers } = await this.require(batchId);
    const decision = this.policy.canClose(batch, answers);
    if (!decision.accepted && decision.reasonCode !== "controlFailed") return decision; // keep the batch open
    const at = this.now();
    const journal: JournalEntry[] = answers.map((a) => {
      const item = batch.items.find((i) => i.id === a.itemId);
      return { batchId, itemId: a.itemId, claimId: item?.claim.id ?? a.itemId, reviewer: batch.reviewer, action: a.action, control: !!item?.control, at: a.answeredAt, millisSpent: a.millisSpent, comment: a.comment };
    });
    if (!decision.accepted) {
      // A confirmed control item: the batch does not count, nothing is applied.
      await this.backend.closeBatch(this.serviceId, batchId, "REJECTED", [...decision.flags, "controlFailed"]);
      await this.backend.appendJournal(this.serviceId, journal);
      const controls = decision.failedControlItems.map((id) => ({ itemId: id, shown: batch.items.find((i) => i.id === id)!.claim }));
      return { ...decision, controls };
    }
    const model = await this.backend.loadModel(this.serviceId);
    if (!model) throw new HubError("serviceNotIndexed", { serviceId: this.serviceId });
    const { model: next, questions } = applyAnswers(model, batch, answers, at);
    await this.backend.saveModel(this.serviceId, next);
    for (const r of RENDERERS) await this.backend.writeGenerated(this.serviceId, r.render(next, { language: this.language }));
    for (const q of questions) await this.backend.addQuestion(this.serviceId, q);
    await this.backend.closeBatch(this.serviceId, batchId, "CLOSED", decision.flags);
    await this.backend.appendJournal(this.serviceId, journal);
    return decision;
  }

  private async require(batchId: string): Promise<StoredBatch> {
    const stored = await this.backend.findBatch(this.serviceId, batchId);
    if (!stored || stored.state !== "OPEN") throw new HubError("batchNotFound", { batchId });
    return stored;
  }
}

/** Applies accepted answers to the model; control items are skipped. "Don't know" leaves the claim and asks the owner. */
export function applyAnswers(model: KnowledgeModel, batch: ReviewBatch, answers: ReviewAnswer[], at: string): { model: KnowledgeModel; questions: ReviewQuestion[] } {
  const commit = model.service.lastAnalyzedCommit ?? "unknown";
  const updated = new Map<string, Claim>();
  const questions: ReviewQuestion[] = [];
  const owners = new Map(model.features.map((f) => [f.id, f.owner]));
  if (batch.kind === "STATIC_SUMMARY") {
    const a = answers.find((x) => x.itemId === SUMMARY_ITEM);
    if (a?.action === "CONFIRM") for (const it of batch.items) updated.set(it.claim.id, confirm(it.claim, batch.reviewer, at, commit, a.comment));
  } else {
    for (const a of answers) {
      const item = batch.items.find((i) => i.id === a.itemId);
      if (!item || item.control) continue;
      // Re-read the claim from the model: it may have changed since the batch was opened.
      const current = findClaim(model, item.claim.id) ?? item.claim;
      if (a.action === "CONFIRM") updated.set(current.id, confirm(current, batch.reviewer, at, commit, a.comment));
      else if (a.action === "EDIT") updated.set(current.id, edit(current, { ...current.payload, ...a.payload }, batch.reviewer, at, commit, a.comment));
      else if (a.action === "REJECT") updated.set(current.id, reject(current, batch.reviewer, at, a.comment));
      else {
        questions.push({
          id: "q-" + stableHash([batch.id, current.id], 12),
          serviceId: batch.serviceId,
          claimId: current.id,
          featureId: current.featureId,
          owner: current.featureId ? owners.get(current.featureId) : undefined,
          askedBy: batch.reviewer,
          comment: a.comment,
          at,
        });
      }
    }
  }
  const swap = (cs: Claim[]) => cs.map((c) => updated.get(c.id) ?? c);
  const next = project({
    ...model,
    catalog: { ...model.catalog, claims: swap(model.catalog.claims) },
    features: model.features.map((f) => ({ ...f, claims: swap(f.claims) })),
  });
  return { model: next, questions };
}

function findClaim(model: KnowledgeModel, id: string): Claim | undefined {
  return model.catalog.claims.find((c) => c.id === id) ?? model.features.flatMap((f) => f.claims).find((c) => c.id === id);
}
