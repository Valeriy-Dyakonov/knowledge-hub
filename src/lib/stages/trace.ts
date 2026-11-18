import type {
  CallFact, Component, ComponentFact, Confidence, ContextFacts, Edge, EdgeKind, Evidence, Feature, FlowBreak, NodeRef, Origin,
  Sink, SinkAccessFact, SinkKind, SourceFacts, Step, TriggerFact,
} from "../../types";
import { edgeId, simpleName, sinkId } from "../model/ids";
import { resolvePlaceholders } from "../model/placeholders";
import type { FeatureCandidate, Stage } from "./types";

/** Stage 3: graph from each trigger to its sinks, with the places where static tracing breaks. No LLM. */
export const traceStage: Stage = {
  id: "trace",
  required: true,
  async run(ctx) {
    const scan = ctx.state.scan;
    const tracer = new Tracer(scan?.facts ?? emptyFacts(), scan?.context ?? emptyContext());
    const candidates = ctx.state.candidates ?? [];
    const traced = candidates.map((c, i) => {
      ctx.progress({ code: "tracing", params: { id: c.id }, current: i + 1, total: candidates.length });
      const t = tracer.trace(c);
      const f = t.feature;
      ctx.log("detail", "featureTraced", {
        id: f.id,
        steps: String(f.steps.length),
        sinks: f.sinkIds.join(", ") || "-",
        breaks: f.breaks.map((b) => b.reason).join(", ") || "-",
      });
      return t;
    });
    ctx.state.traced = traced.map(({ candidate, feature }) => ({ candidate, feature }));
    ctx.state.catalogComponents = tracer.catalogComponents();
    const sinks = new Map<string, Sink>();
    for (const t of traced) for (const s of t.sinks) sinks.set(s.id, s);
    ctx.state.catalogSinks = [...sinks.values()].sort((a, b) => a.id.localeCompare(b.id));
    const breaks = traced.reduce((n, t) => n + t.feature.breaks.length, 0);
    ctx.log("ok", "traceSummary", { features: String(traced.length), breaks: String(breaks) });
  },
};

export const emptyFacts = (): SourceFacts => ({ components: [], triggers: [], calls: [], sinkAccesses: [], events: [], unresolved: [] });
export const emptyContext = (): ContextFacts => ({ properties: {}, apiOperations: [], tables: [], ownership: [] });

const MAX_DEPTH = 25;

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

const at = (component: string, method: string) => `${component}#${method}`;
const minConfidence = (a: Confidence, b: Confidence): Confidence => (["LOW", "MEDIUM", "HIGH"].indexOf(a) < ["LOW", "MEDIUM", "HIGH"].indexOf(b) ? a : b);

export class Tracer {
  private components: Map<string, ComponentFact>;
  private calls: Map<string, CallFact[]>;
  private accesses: Map<string, SinkAccessFact[]>;
  private events: Map<string, SourceFacts["events"]>;
  private unresolved: Map<string, SourceFacts["unresolved"]>;
  private listeners: Map<string, TriggerFact[]>;
  private tables: Set<string>;

  constructor(private facts: SourceFacts, private context: ContextFacts) {
    this.components = new Map(facts.components.map((c) => [c.id, c]));
    this.calls = groupBy(facts.calls, (c) => at(c.fromComponent, c.fromMethod));
    this.accesses = groupBy(facts.sinkAccesses, (a) => at(a.componentId, a.method));
    this.events = groupBy(facts.events, (e) => at(e.componentId, e.method));
    this.unresolved = groupBy(facts.unresolved, (u) => at(u.componentId, u.method));
    this.listeners = groupBy(facts.triggers.filter((t) => t.type === "EVENT"), (t) => t.attributes.eventType ?? "");
    this.tables = new Set(context.tables.map((t) => t.toLowerCase()));
  }

  catalogComponents(): Component[] {
    return this.facts.components
      .map((c) => ({ id: c.id, kind: c.kind, technicalName: c.simpleName, businessName: {}, evidence: c.evidence }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  trace(candidate: FeatureCandidate): { candidate: FeatureCandidate; feature: Feature; sinks: Sink[] } {
    const w = new Walk();
    for (const t of candidate.triggers) {
      const handler: NodeRef = { type: "COMPONENT", id: t.componentId };
      w.edge({ type: "TRIGGER", id: t.id }, handler, "CALL", t.method, "STATIC", "HIGH", t.evidence, t.componentId, t.method);
      if (t.type === "MESSAGE") {
        const sink = w.sink(t.attributes.broker === "kafka" ? "TOPIC" : "QUEUE", t.attributes.destination ?? "");
        w.edge({ type: "SINK", id: sink.id }, handler, "CONSUME", t.method, "STATIC", "HIGH", t.evidence);
      }
      this.visit(w, t.componentId, t.method, 0);
    }
    const feature: Feature = {
      id: candidate.id,
      group: candidate.group,
      technicalName: candidate.technicalName,
      businessName: {},
      description: {},
      aliases: [],
      triggers: candidate.triggers,
      componentIds: [...w.componentIds],
      sinkIds: [...w.sinks.keys()],
      edges: [...w.edges.values()],
      steps: w.steps,
      breaks: w.breaks,
      claims: [],
    };
    return { candidate, feature, sinks: [...w.sinks.values()] };
  }

  private visit(w: Walk, component: string, method: string, depth: number) {
    const key = at(component, method);
    if (depth > MAX_DEPTH || w.visited.has(key)) return;
    w.visited.add(key);
    w.componentIds.add(component);
    const self: NodeRef = { type: "COMPONENT", id: component };

    for (const a of this.accesses.get(key) ?? []) this.sinkEdge(w, self, a);
    for (const u of this.unresolved.get(key) ?? []) w.addBreak({ componentId: component, method, reason: u.reason, detail: u.detail, evidence: u.evidence });
    for (const c of this.calls.get(key) ?? []) this.follow(w, self, c, depth);
    for (const e of this.events.get(key) ?? []) {
      const listeners = e.eventType ? this.listeners.get(e.eventType) ?? [] : [];
      if (!listeners.length) {
        w.addBreak({ componentId: component, method, reason: "EVENT", detail: e.eventType ?? "", evidence: e.evidence });
        continue;
      }
      // Event delivery is not a direct call: inferred, goes to review.
      for (const l of listeners) {
        const label = `event:${simpleName(e.eventType!)} -> ${l.method}`;
        w.edge(self, { type: "COMPONENT", id: l.componentId }, "CALL", label, "INFERRED", "MEDIUM", e.evidence, l.componentId, l.method);
        this.visit(w, l.componentId, l.method, depth + 1);
      }
    }
  }

  private follow(w: Walk, self: NodeRef, call: CallFact, depth: number) {
    if (call.targetType === call.fromComponent) {
      this.visit(w, call.fromComponent, call.targetMethod, depth + 1);
      return;
    }
    const targets = this.resolve(call.targetType);
    if (!targets.length) return; // library or non-bean type: not part of the flow
    if (targets.length > 1) {
      w.addBreak({ componentId: call.fromComponent, method: call.fromMethod, reason: "MULTIPLE_IMPLEMENTATIONS", detail: call.targetType, evidence: call.evidence });
    }
    const [origin, confidence]: [Origin, Confidence] = targets.length > 1 ? ["INFERRED", "LOW"] : ["STATIC", "HIGH"];
    for (const t of targets) {
      w.edge(self, { type: "COMPONENT", id: t.id }, "CALL", call.targetMethod, origin, confidence, call.evidence, t.id, call.targetMethod);
      this.visit(w, t.id, call.targetMethod, depth + 1);
    }
  }

  private sinkEdge(w: Walk, self: NodeRef, a: SinkAccessFact) {
    const r = resolvePlaceholders(a.sinkName, this.context.properties);
    let confidence = a.confidence;
    if (r.unresolved.length) {
      w.addBreak({ componentId: a.componentId, method: a.method, reason: "UNRESOLVED_PLACEHOLDER", detail: r.unresolved.join(","), evidence: a.evidence });
      confidence = "LOW";
    }
    // A table missing from the migrations may be derived wrongly from the entity name.
    if (a.sinkKind === "DB_TABLE" && this.tables.size && !this.tables.has(r.value.toLowerCase())) confidence = minConfidence(confidence, "MEDIUM");
    const sink = w.sink(a.sinkKind, r.value);
    const label = a.attributes.operation ?? a.method;
    w.edge(self, { type: "SINK", id: sink.id }, a.edgeKind, label, a.origin, confidence, a.evidence, a.componentId, label);
  }

  /** Implementations of a type: the class itself, the implementations of an interface, or a framework-implemented interface. */
  private resolve(type: string): ComponentFact[] {
    const declared = this.components.get(type);
    if (declared && !declared.isInterface) return [declared];
    const impls = this.facts.components.filter((c) => !c.isInterface && c.supertypes.includes(type));
    if (impls.length) return impls;
    return declared ? [declared] : [];
  }
}

class Walk {
  edges = new Map<string, Edge>();
  steps: Step[] = [];
  breaks: FlowBreak[] = [];
  sinks = new Map<string, Sink>();
  componentIds = new Set<string>();
  visited = new Set<string>();

  sink(kind: SinkKind, name: string): Sink {
    const id = sinkId(kind, name);
    let s = this.sinks.get(id);
    if (!s) this.sinks.set(id, (s = { id, kind, technicalName: name, businessName: {} }));
    return s;
  }

  edge(from: NodeRef, to: NodeRef, kind: EdgeKind, label: string, origin: Origin, confidence: Confidence, evidence?: Evidence, stepComponent?: string, stepAction?: string) {
    const id = edgeId(from.type, from.id, to.type, to.id, kind, label);
    // The same call made twice (or reached twice) is one step of the flow, not two.
    if (this.edges.has(id)) return;
    this.edges.set(id, { id, from, to, kind, label, origin, confidence, evidence });
    if (stepComponent && stepAction) this.steps.push({ order: this.steps.length + 1, componentId: stepComponent, action: stepAction, edgeId: id });
    for (const n of [from, to]) if (n.type === "COMPONENT") this.componentIds.add(n.id);
  }

  addBreak(b: FlowBreak) {
    if (!this.breaks.some((x) => x.componentId === b.componentId && x.method === b.method && x.reason === b.reason && x.detail === b.detail)) this.breaks.push(b);
  }
}
