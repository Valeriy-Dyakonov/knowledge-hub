import { describe, expect, it } from "vitest";
import type { SourceFacts } from "../../types";
import { emptyContext, Tracer } from "../stages/trace";
import { analyse, scan } from "../testing/fixture";
import { flowSteps } from "./flow";
import { mergeModels } from "./merge";

describe("flow steps", () => {
  it("show a call through a repository as one step", () => {
    const model = mergeModels(null, analyse(scan));
    const f = model.features.find((x) => x.id === "payment-events/on-payment-completed")!;
    const steps = flowSteps(model, f).map((s) => `${s.from.id.split(".").pop()} ${s.kind} ${s.to.id.split(".").pop()}${s.via ? ` via ${s.via.componentId.split(".").pop()}.${s.via.method}` : ""}`);
    expect(steps).toEqual([
      "onPaymentCompleted CALL PaymentEventsConsumer",
      "PaymentEventsConsumer CALL RefundService",
      "RefundService READ db_table:refunds via RefundRepository.findById",
      "RefundService WRITE db_table:refunds via RefundRepository.save",
    ]);
    expect(f.steps.length).toBe(6); // the model keeps both edges of each merged step
  });

  it("mark a call into an @Async method and make an uncalled one a feature of its own", () => {
    const model = mergeModels(null, analyse(scan));
    const create = model.features.find((x) => x.id === "refunds/create-refund")!;
    const asyncSteps = flowSteps(model, create).filter((s) => s.async);
    expect(asyncSteps.map((s) => `${s.to.id.split(".").pop()}.${s.label}`)).toEqual(["NotificationService.notifyCustomer"]);
    // Called from a flow: a step there, not a feature.
    expect(model.features.some((f) => f.triggers.some((t) => t.type === "ASYNC" && t.method === "notifyCustomer"))).toBe(false);
    // Called by nobody: its own feature.
    const warm = model.features.find((f) => f.triggers.some((t) => t.type === "ASYNC"))!;
    expect(warm.id).toBe("cache-warmer/warm-up");
  });

  it("do not repeat a call made twice", () => {
    const comp = (id: string) => ({ id, simpleName: id, kind: "SERVICE" as const, isInterface: false, supertypes: [], injected: {}, methods: [], attributes: {} });
    const call = (line: number) => ({ fromComponent: "A", fromMethod: "run", targetType: "B", targetMethod: "save", evidence: { repo: "r", path: "A.kt", lines: { start: line, end: line }, commit: "c", fingerprint: String(line) } });
    const facts: SourceFacts = {
      components: [comp("A"), comp("B")],
      triggers: [{ type: "SCHEDULE", componentId: "A", method: "run", attributes: {} }],
      calls: [call(3), call(7)],
      sinkAccesses: [], events: [], unresolved: [],
    };
    const t = new Tracer(facts, emptyContext());
    const trigger = { id: "schedule:A.run", type: "SCHEDULE" as const, technicalName: "A.run", componentId: "A", method: "run", attributes: {} };
    const { feature } = t.trace({ id: "a/run", group: "a", technicalName: "A.run", triggers: [trigger], groupingReason: "class" });
    expect(feature.steps.map((s) => `${s.componentId}.${s.action}`)).toEqual(["A.run", "B.save"]);
  });
});
