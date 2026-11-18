import type { Confidence, EdgeKind, Evidence, Feature, KnowledgeModel, NodeRef, Origin } from "../../types";

/** A step of a flow as a reader sees it. */
export interface FlowStep {
  from: NodeRef;
  to: NodeRef;
  kind: EdgeKind;
  label: string;
  origin: Origin;
  confidence: Confidence;
  evidence?: Evidence;
  /** The repository or client the step goes through, when two model edges are shown as one step. */
  via?: { componentId: string; method: string };
  claimIds: string[];
}

const PASS_THROUGH = new Set(["REPOSITORY", "CLIENT"]);
const RANK: Confidence[] = ["LOW", "MEDIUM", "HIGH"];
const weaker = (a: Confidence, b: Confidence) => (RANK.indexOf(a) < RANK.indexOf(b) ? a : b);

/**
 * Steps of a feature for reading: rejected edges dropped, the consumed topic left to the trigger, and
 * "service calls repository.save" + "repository writes table (save)" shown as one step
 * "service writes table (via repository.save)" — the model keeps both edges and both claims.
 */
export function flowSteps(model: KnowledgeModel, f: Feature): FlowStep[] {
  const rejected = new Set(f.claims.filter((c) => c.status === "REJECTED").map((c) => c.id));
  const edges = new Map(f.edges.filter((e) => !e.claimId || !rejected.has(e.claimId)).map((e) => [e.id, e]));
  const kinds = new Map(model.catalog.components.map((c) => [c.id, c.kind]));
  const seq = f.steps.map((s) => (s.edgeId ? edges.get(s.edgeId) : undefined)).filter((e) => e !== undefined && e.kind !== "CONSUME");
  const out: FlowStep[] = [];
  const used = new Set<number>();
  for (let i = 0; i < seq.length; i++) {
    if (used.has(i)) continue;
    const e = seq[i]!;
    if (e.kind === "CALL" && e.to.type === "COMPONENT" && PASS_THROUGH.has(kinds.get(e.to.id) ?? "")) {
      const j = seq.findIndex((n, k) => k > i && !used.has(k) && n!.from.id === e.to.id && n!.to.type === "SINK" && n!.label === e.label);
      if (j >= 0) {
        const n = seq[j]!;
        used.add(j);
        out.push({
          from: e.from, to: n.to, kind: n.kind, label: e.label,
          origin: e.origin === "INFERRED" || n.origin === "INFERRED" ? "INFERRED" : n.origin,
          confidence: weaker(e.confidence, n.confidence),
          evidence: e.evidence ?? n.evidence,
          via: { componentId: e.to.id, method: e.label },
          claimIds: [e.claimId, n.claimId].filter((x): x is string => !!x),
        });
        continue;
      }
    }
    out.push({ from: e.from, to: e.to, kind: e.kind, label: e.label, origin: e.origin, confidence: e.confidence, evidence: e.evidence, claimIds: e.claimId ? [e.claimId] : [] });
  }
  return out;
}
