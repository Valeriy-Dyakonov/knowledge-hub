import { describe, expect, it } from "vitest";
import { SUMMARY_ITEM, type JournalEntry, type KnowledgeModel, type ReviewAnswer, type ReviewBatch, type ReviewQuestion, type StoredBatch } from "../../types";
import { mergeModels } from "../model/merge";
import { analyse, scan } from "../testing/fixture";
import { lenientPolicy, risk, strictPolicy } from "./policy";
import { ReviewService, type ReviewBackend } from "./service";
import { statement } from "./statement";

const descriptions = { language: "ru", features: { "refunds/create-refund": { name: "Создание возврата", description: "" } }, components: {}, sinks: {} };
const fixture = () => mergeModels(null, analyse(scan, null, descriptions));
const allClaims = (m: KnowledgeModel) => [...m.catalog.claims, ...m.features.flatMap((f) => f.claims)];

function fakeBackend(initial: KnowledgeModel) {
  let model = initial;
  const batches = new Map<string, StoredBatch>();
  const journal: JournalEntry[] = [];
  const questions: ReviewQuestion[] = [];
  let renders = 0;
  const backend: ReviewBackend = {
    loadModel: async () => model,
    saveModel: async (_, m) => { model = m; },
    writeGenerated: async () => { renders++; },
    saveBatch: async (_, b) => { batches.set(b.id, { batch: b, state: "OPEN", answers: [], flags: [] }); },
    findBatch: async (_, id) => batches.get(id) ?? null,
    openBatches: async () => [...batches.values()].filter((b) => b.state === "OPEN"),
    saveAnswer: async (_, id, a) => {
      const b = batches.get(id)!;
      b.answers = [...b.answers.filter((x) => x.itemId !== a.itemId), a];
    },
    closeBatch: async (_, id, state, flags) => { Object.assign(batches.get(id)!, { state, flags }); },
    appendJournal: async (_, e) => { journal.push(...e); },
    addQuestion: async (_, q) => { questions.push(q); },
  };
  return { backend, journal, questions, get model() { return model; }, get renders() { return renders; } };
}

const service = (backend: ReviewBackend, policy = strictPolicy) =>
  new ReviewService({ backend, serviceId: "refunds", policy, reviewer: "ann", language: "ru", now: () => "2026-11-18T10:00:00Z" });

const answer = (itemId: string, action: ReviewAnswer["action"], extra: Partial<ReviewAnswer> = {}): ReviewAnswer =>
  ({ itemId, action, answeredAt: "2026-11-18T10:01:00Z", millisSpent: 8000, ...extra });

/** Answers a regular batch the way a careful reviewer would: confirms real items, rejects the control. */
async function answerAll(s: ReviewService, b: ReviewBatch, real: ReviewAnswer["action"] = "CONFIRM") {
  for (const it of b.items) await s.answer(b.id, answer(it.id, it.control ? "REJECT" : real));
}

describe("strict policy", () => {
  const model = fixture();
  const batches = strictPolicy.selectForReview({ model, reviewer: "ann", exclude: new Set(), now: "t" });
  const regular = batches.filter((b) => b.kind === "REGULAR");
  const summary = batches.find((b) => b.kind === "STATIC_SUMMARY")!;

  it("puts static high-confidence facts into one summary and everything else into small batches", () => {
    const human = allClaims(model).filter((c) => c.origin !== "STATIC" || c.confidence !== "HIGH" || c.kind === "DESCRIBES");
    expect(regular.flatMap((b) => b.items.filter((i) => !i.control)).length).toBe(human.length);
    expect(summary.items.length + human.length).toBe(allClaims(model).length);
    expect(summary.summary!.count).toBe(summary.items.length);
    for (const b of regular) expect(b.items.filter((i) => !i.control).length).toBeLessThanOrEqual(15);
  });

  it("mixes exactly one control item into each batch and puts the riskiest first", () => {
    for (const b of regular) expect(b.items.filter((i) => i.control).length).toBe(1);
    for (const b of regular) {
      const order = b.items.filter((i) => !i.control).map((i) => risk(i.claim));
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
    expect(regular.map((b) => b.owner)).toEqual([...regular.map((b) => b.owner)].sort());
  });

  it("asks a question with options for a doubtful sink", () => {
    const withOptions = regular.flatMap((b) => b.items).filter((i) => i.options);
    for (const i of withOptions) expect(i.options).toContain(i.claim.payload.to);
  });

  it("refuses to close an incomplete batch and fails a batch whose control item was confirmed", () => {
    const b = regular[0];
    expect(strictPolicy.canClose(b, []).reasonCode).toBe("batchIncomplete");
    const all = b.items.map((i) => answer(i.id, "CONFIRM"));
    const d = strictPolicy.canClose(b, all);
    expect(d.accepted).toBe(false);
    expect(d.reasonCode).toBe("controlFailed");
  });

  it("accepts the summary only with the right count", () => {
    expect(strictPolicy.canClose(summary, [answer(SUMMARY_ITEM, "CONFIRM", { acknowledgedCount: 1 })]).reasonCode).toBe("summaryNotAcknowledged");
    expect(strictPolicy.canClose(summary, [answer(SUMMARY_ITEM, "CONFIRM", { acknowledgedCount: summary.summary!.count })]).accepted).toBe(true);
    expect(lenientPolicy.canClose(summary, [answer(SUMMARY_ITEM, "CONFIRM")]).accepted).toBe(true);
  });

  it("flags suspiciously fast batches", () => {
    const b = regular[0];
    const fast = b.items.map((i) => answer(i.id, i.control ? "REJECT" : "CONFIRM", { millisSpent: 400 }));
    expect(strictPolicy.canClose(b, fast).flags).toContain("tooFast");
  });
});

describe("review service", () => {
  it("applies a closed batch to the model, journals it and regenerates the views", async () => {
    const f = fakeBackend(fixture());
    const s = service(f.backend);
    const { batch } = (await s.next())!;
    expect((await s.next())!.batch.id).toBe(batch.id); // the open batch is continued, not replaced
    await answerAll(s, batch);
    const r = await s.close(batch.id);
    expect(r.accepted).toBe(true);
    const real = batch.items.filter((i) => !i.control).map((i) => i.claim.id);
    const after = allClaims(f.model);
    for (const id of real) expect(after.find((c) => c.id === id)!.status).toBe("CONFIRMED");
    expect(after.some((c) => c.id.startsWith("ctl-"))).toBe(false);
    expect(f.journal).toHaveLength(batch.items.length);
    expect(f.journal.find((j) => j.control)?.action).toBe("REJECT");
    expect(f.renders).toBeGreaterThan(0);
    expect((await s.next())!.batch.items.some((i) => real.includes(i.claim.id))).toBe(false);
  });

  it("writes nothing when the control item was confirmed", async () => {
    const f = fakeBackend(fixture());
    const s = service(f.backend);
    const { batch } = (await s.next())!;
    for (const it of batch.items) await s.answer(batch.id, answer(it.id, "CONFIRM"));
    const before = JSON.stringify(f.model);
    const r = await s.close(batch.id);
    expect(r.reasonCode).toBe("controlFailed");
    expect(r.controls?.[0].shown.id).toMatch(/^ctl-/);
    expect(JSON.stringify(f.model)).toBe(before);
    expect(f.journal.every((j) => j.batchId === batch.id)).toBe(true);
  });

  it("records corrections as human edits and turns 'don't know' into a question", async () => {
    const f = fakeBackend(fixture());
    const s = service(f.backend);
    let batch = (await s.next())!.batch;
    while (batch.items.filter((i) => !i.control).length < 2) {
      await answerAll(s, batch);
      await s.close(batch.id);
      batch = (await s.next())!.batch;
    }
    const [first, second] = batch.items.filter((i) => !i.control);
    await expect(s.answer(batch.id, answer(first.id, "EDIT"))).rejects.toThrow("answerInvalid");
    for (const it of batch.items) {
      const a = it.id === first.id ? answer(it.id, "EDIT", { payload: { to: "db_table:audit_log", toType: "SINK" } })
        : it.id === second.id ? answer(it.id, "DONT_KNOW", { comment: "?" })
        : answer(it.id, it.control ? "REJECT" : "CONFIRM");
      await s.answer(batch.id, a);
    }
    await s.close(batch.id);
    const edited = allClaims(f.model).find((c) => c.id === first.claim.id)!;
    expect(edited.status).toBe("EDITED");
    expect(edited.origin).toBe("HUMAN");
    expect(edited.payload.to).toBe("db_table:audit_log");
    expect(allClaims(f.model).find((c) => c.id === second.claim.id)!.status).toBe("PROPOSED");
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0].owner).toBe("@team-refunds");
  });

  it("confirms all static facts through the summary", async () => {
    const f = fakeBackend(fixture());
    const s = service(f.backend);
    let stored = await s.next();
    while (stored && stored.batch.kind === "REGULAR") {
      await answerAll(s, stored.batch);
      await s.close(stored.batch.id);
      stored = await s.next();
    }
    const summary = stored!.batch;
    expect(summary.kind).toBe("STATIC_SUMMARY");
    await s.answer(summary.id, answer(SUMMARY_ITEM, "CONFIRM", { acknowledgedCount: summary.summary!.count }));
    expect((await s.close(summary.id)).accepted).toBe(true);
    expect(allClaims(f.model).every((c) => c.status === "CONFIRMED")).toBe(true);
    expect(f.model.features.every((x) => x.claims.every((c) => c.status === "CONFIRMED"))).toBe(true);
    expect(await s.next()).toBeNull();
  });
});

describe("statements", () => {
  it("say what the claim means in plain words", () => {
    const m = fixture();
    const create = m.features.find((f) => f.id === "refunds/create-refund")!;
    const texts = create.claims.map((c) => statement(c, m, "ru"));
    expect(texts).toContain("Есть точка входа POST /api/v1/refunds");
    expect(texts).toContain("RefundRepository пишет в таблицу «refunds»");
    expect(texts).toContain("Бизнес-название фичи POST /api/v1/refunds: «Создание возврата»");
    expect(texts.some((t) => t.includes("POST /api/v1/refunds вызывает RefundController"))).toBe(true);
  });
});
