import { describe, expect, it } from "vitest";
import type { Claim, Feature, KnowledgeModel } from "../../types";
import { confirm, edit, newClaim, reject } from "./claims";
import { mergeModels } from "./merge";

const ev = (fp: string) => ({ repo: "r", path: "A.kt", lines: { start: 1, end: 1 }, commit: "c1", fingerprint: fp });

const writes = (to: string, fp = "f1") =>
  newClaim("f", "WRITES_TO", { type: "EDGE", id: "e1" }, "e1", { to, edgeKind: "WRITE" }, [ev(fp)], "STATIC", "HIGH");

const name = (text: string) =>
  newClaim("f", "DESCRIBES", { type: "FEATURE", id: "f" }, "businessName:ru", { field: "businessName", language: "ru", text }, [ev("f1")], "INFERRED", "MEDIUM");

function model(claims: Claim[], features = ["f"]): KnowledgeModel {
  const feature = (id: string): Feature => ({
    id, group: "g", technicalName: id, businessName: {}, description: {}, aliases: [], triggers: [], componentIds: [], sinkIds: [], edges: [], steps: [], breaks: [],
    claims: claims.filter((c) => c.featureId === id),
  });
  return { schemaVersion: 1, service: { id: "s", name: "s", repo: "/r", stack: [] }, catalog: { components: [], sinks: [], claims: [] }, features: features.map(feature) };
}

const merged = (prev: Claim[], fresh: Claim[], freshFeatures = ["f"]) => mergeModels(model(prev), model(fresh, freshFeatures));
const only = (m: KnowledgeModel) => m.features[0].claims[0];

describe("mergeModels", () => {
  it("keeps a confirmed claim when nothing changed", () => {
    const m = merged([confirm(writes("t"), "ann", "now", "c1")], [writes("t")]);
    expect(only(m).status).toBe("CONFIRMED");
  });

  it("marks a confirmed claim stale when its code changed", () => {
    const c = only(merged([confirm(writes("t"), "ann", "now", "c1")], [writes("t", "f2")]));
    expect(c.status).toBe("STALE");
    expect(c.staleReasons).toEqual(["changed:A.kt"]);
    expect(c.evidence[0].fingerprint).toBe("f2");
  });

  it("turns a changed confirmed claim into a diff to review", () => {
    const c = only(merged([confirm(writes("t"), "ann", "now", "c1")], [writes("other")]));
    expect(c.status).toBe("PROPOSED");
    expect(c.previousPayload?.to).toBe("t");
  });

  it("keeps rejected claims rejected", () => {
    expect(only(merged([reject(writes("t"), "ann", "now")], [writes("t")])).status).toBe("REJECTED");
  });

  it("never overwrites a human edit; a different proposal becomes a conflict", () => {
    const edited = edit({ ...writes("t"), analysisPayload: writes("t").payload }, { to: "audit", edgeKind: "WRITE" }, "ann", "now", "c1");
    const c = only(merged([edited], [writes("other")]));
    expect(c.status).toBe("EDITED");
    expect(c.payload.to).toBe("audit");
    expect(c.conflict?.to).toBe("other");
    expect(only(merged([edited], [writes("t")])).conflict).toBeUndefined();
  });

  it("keeps reviewed knowledge of a vanished feature as stale and drops unreviewed proposals", () => {
    const m = merged([confirm(writes("t"), "ann", "now", "c1")], [], []);
    expect(m.features).toHaveLength(1);
    expect(only(m).status).toBe("STALE");
    expect(only(m).staleReasons).toEqual(["missing"]);
    expect(merged([writes("t")], [], []).features).toHaveLength(0);
  });

  it("carries over descriptions that were not regenerated and projects them into names", () => {
    const m = merged([confirm(name("Создание возврата"), "ann", "now", "c1")], []);
    expect(only(m).status).toBe("CONFIRMED");
    expect(m.features[0].businessName).toEqual({ ru: "Создание возврата" });
  });

  it("takes rejected names out of the projection", () => {
    const m = merged([reject(name("Плохое имя"), "ann", "now")], [name("Плохое имя")]);
    expect(m.features[0].businessName).toEqual({});
  });
});
