import { describe, expect, it } from "vitest";
import type { KnowledgeModel, SourceFacts } from "../../types";
import { discover, restNaming } from "./discover";
import { emptyContext } from "./trace";

const facts = (path: string): SourceFacts => ({
  components: [{ id: "a.RefundController", simpleName: "RefundController", kind: "CONTROLLER", isInterface: false, supertypes: [], injected: {}, methods: [], attributes: {} }],
  triggers: [{ type: "HTTP", componentId: "a.RefundController", method: "create", attributes: { httpMethod: "POST", path } }],
  calls: [], sinkAccesses: [], events: [], unresolved: [],
});

describe("discover", () => {
  it("names REST endpoints by resource and verb", () => {
    expect(restNaming("POST", "/api/v1/refunds")).toEqual({ resource: "refunds", action: "create" });
    expect(restNaming("GET", "/refunds/{id}")).toEqual({ resource: "refunds", action: "get" });
    expect(restNaming("GET", "/refunds")).toEqual({ resource: "refunds", action: "list" });
    expect(restNaming("POST", "/refunds/{id}/approve")).toEqual({ resource: "refunds", action: "approve" });
    expect(restNaming("DELETE", "/refunds/{id}")).toEqual({ resource: "refunds", action: "delete" });
  });

  it("keeps the feature id of the previous model for the same trigger", () => {
    const previous = {
      features: [{ id: "returns/new", triggers: [{ id: "http:POST /api/v1/refunds" }] }],
    } as unknown as KnowledgeModel;
    const [c] = discover(facts("/api/v1/refunds"), emptyContext(), previous);
    expect(c.id).toBe("returns/new");
    expect(c.groupingReason).toBe("previousModel");
  });

  it("resolves placeholders in trigger attributes", () => {
    const f = facts("${api.base}/refunds");
    const [c] = discover(f, { ...emptyContext(), properties: { "api.base": "/api/v2" } }, null);
    expect(c.technicalName).toBe("POST /api/v2/refunds");
  });
});
