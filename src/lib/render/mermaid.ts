import { messagesFor } from "../../i18n";
import type { ComponentKind, Edge, EdgeKind, Feature, KnowledgeModel, SinkKind, Trigger, TriggerType } from "../../types";
import { flowSteps } from "../model/flow";
import { activeEdges, label, namer } from "./names";
import type { Renderer } from "./types";

// Readability rules (docs/06-diagrams.md): about a dozen nodes, business names, one shape and colour per node kind,
// left to right with who triggers on the left and the systems reached on the right, every edge traceable to a claim.
export const MAX_NODES = 12;

const CLASSES = [
  "classDef trigger fill:#2f6fed,stroke:#1f4fb8,color:#fff",
  "classDef component fill:#ede7f9,stroke:#8e63d8,color:#2b1d4a",
  "classDef feature fill:#e8f0fe,stroke:#2f6fed,color:#14274e",
  "classDef service fill:#8e63d8,stroke:#5e3aa6,color:#fff",
  "classDef db fill:#e3f5ea,stroke:#1f9d55,color:#123d24",
  "classDef queue fill:#fbf0dc,stroke:#c27c0e,color:#4a3006",
  "classDef external fill:#fde5e0,stroke:#e24329,color:#4f1307",
];

type NodeClass = "trigger" | "component" | "feature" | "service" | "db" | "queue" | "external";

export const sinkClass = (k: SinkKind | string): NodeClass =>
  k === "DB_TABLE" ? "db" : k === "TOPIC" || k === "QUEUE" ? "queue" : k === "EXTERNAL_HTTP" ? "external" : "component";

/** Several label lines; each line escaped, joined with a Mermaid line break. */
const lines = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).map(label).join("<br/>");

/** "A, B, C, ещё 2" — names on an edge, short enough to read. */
function some(names: string[], more: (n: number) => string, max = 3): string {
  const uniq = [...new Set(names)];
  return uniq.length <= max ? uniq.join(", ") : `${uniq.slice(0, max).join(", ")}, ${more(uniq.length - max)}`;
}

function shape(id: string, text: string, cls: NodeClass): string {
  const t = `"${text}"`;
  const body = { trigger: `([${t}])`, component: `[${t}]`, feature: `(${t})`, service: `[[${t}]]`, db: `[(${t})]`, queue: `[/${t}/]`, external: `{{${t}}}` }[cls];
  return `${id}${body}:::${cls}`;
}

class Graph {
  private ids = new Map<string, string>();
  private groups = new Map<string, { title: string; nodes: string[] }>();
  private loose: string[] = [];
  private edges = new Map<string, string>();

  /** `text` is already escaped (use `lines`). */
  node(key: string, text: string, cls: NodeClass, group?: { id: string; title: string }): string {
    let id = this.ids.get(key);
    if (!id) {
      id = `n${this.ids.size + 1}`;
      this.ids.set(key, id);
      const line = shape(id, text, cls);
      if (group) {
        const g = this.groups.get(group.id) ?? { title: group.title, nodes: [] };
        g.nodes.push(line);
        this.groups.set(group.id, g);
      } else this.loose.push(line);
    }
    return id;
  }

  edge(from: string, to: string, text: string, inferred = false, claimIds: string[] = []) {
    const key = `${from}>${to}>${text}`;
    if (this.edges.has(key) || from === to) return;
    // Braces (path variables like {id}) would open a diamond shape inside an edge label.
    const t = label(text).replace(/\{/g, "#123;").replace(/\}/g, "#125;");
    const arrow = (inferred ? "-.->" : "-->") + (t ? `|${t}|` : "");
    this.edges.set(key, `${claimIds.map((c) => `  %% claim ${c}\n`).join("")}  ${from} ${arrow} ${to}`);
  }

  text(header: string): string {
    const groups = [...this.groups.values()].flatMap((g, i) => [`  subgraph g${i + 1}["${label(g.title)}"]`, ...g.nodes.map((n) => `    ${n}`), "  end"]);
    return [`%% ${header}`, "flowchart LR", ...this.loose.map((n) => `  ${n}`), ...groups, ...this.edges.values(), ...CLASSES.map((c) => `  ${c}`)].join("\n") + "\n";
  }
}

/** Every sink edge of every feature (and consumed topics) with the feature it belongs to. */
function sinkUses(model: KnowledgeModel): { feature: Feature; edge: Edge }[] {
  return model.features.flatMap((f) => activeEdges(f).filter((e) => e.to.type === "SINK" || e.kind === "CONSUME").map((edge) => ({ feature: f, edge })));
}

/** L1: the service as a whole — who triggers it, which systems it reaches, and for which features. For everyone. */
export function contextDiagram(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const g = new Graph();
  const svc = g.node("service", lines(model.service.name, m.featureCount(model.features.length)), "service");
  const inGroup = { id: "in", title: m.whoTriggers };
  const outGroup = { id: "out", title: m.whatItUses };

  const withType = (t: TriggerType) => model.features.filter((f) => f.triggers.some((x) => x.type === t));
  const http = withType("HTTP");
  if (http.length) {
    const areas = [...new Set(http.map((f) => f.group))].map((a) => `${a}: ${http.filter((f) => f.group === a).length}`);
    const node = g.node("clients", lines(m.clients, ...areas.slice(0, 4), areas.length > 4 ? m.more(areas.length - 4) : undefined), "trigger", inGroup);
    g.edge(node, svc, some(http.map(n.feature), m.more));
  }
  const consumed = new Map<string, Feature[]>();
  for (const f of model.features) {
    for (const t of f.triggers.filter((x) => x.type === "MESSAGE")) {
      const d = t.attributes.destination ?? "";
      consumed.set(d, [...(consumed.get(d) ?? []), f]);
    }
  }
  if (consumed.size > 4) {
    const all = [...consumed.values()].flat();
    g.edge(g.node("in-topics", lines(m.topics(consumed.size), ...[...consumed.keys()].slice(0, 3)), "queue", inGroup), svc, `${m.edges.CONSUME}: ${some(all.map(n.feature), m.more)}`);
  } else {
    for (const [d, fs] of consumed) g.edge(g.node(`in:${d}`, lines(d), "queue", inGroup), svc, `${m.edges.CONSUME}: ${some(fs.map(n.feature), m.more)}`);
  }
  for (const [type, title] of [["SCHEDULE", m.schedule], ["ASYNC", m.asyncJobs], ["EVENT", m.events], ["STARTUP", m.startup]] as [TriggerType, string][]) {
    const fs = withType(type);
    if (fs.length) g.edge(g.node(type, lines(title, ...fs.slice(0, 3).map(n.feature), fs.length > 3 ? m.more(fs.length - 3) : undefined), "trigger", inGroup), svc, "");
  }

  // Outgoing: one node per system (tables together as the database); edges say what the service does there and for which features.
  const uses = sinkUses(model).filter((u) => u.edge.kind !== "CONSUME");
  const bySink = (pred: (kind: string) => boolean) => uses.filter((u) => pred(n.sinkKind(u.edge.to.id)));
  const verbs = (us: typeof uses) => {
    const parts: string[] = [];
    for (const k of ["WRITE", "READ", "PUBLISH", "HTTP_CALL"] as EdgeKind[]) {
      const fs = us.filter((u) => u.edge.kind === k).map((u) => n.feature(u.feature));
      if (fs.length) parts.push(`${m.edges[k]}: ${some(fs, m.more, 2)}`);
    }
    return parts.join(" · ");
  };
  const db = bySink((k) => k === "DB_TABLE");
  if (db.length) {
    const tables = [...new Set(db.map((u) => n.sink(u.edge.to.id)))];
    const node = g.node("db", lines(m.database(tables.length), tables.slice(0, 5).join(", ") + (tables.length > 5 ? `, ${m.more(tables.length - 5)}` : "")), "db", outGroup);
    g.edge(svc, node, verbs(db));
  }
  const grouped = (kindPred: (k: string) => boolean, key: string, title: (n: number) => string, cls: NodeClass) => {
    const us = bySink(kindPred);
    const ids = [...new Set(us.map((u) => u.edge.to.id))];
    if (ids.length > 4) g.edge(svc, g.node(key, lines(title(ids.length), ...ids.slice(0, 3).map(n.sink)), cls, outGroup), verbs(us));
    else for (const id of ids) g.edge(svc, g.node(id, lines(n.sink(id)), cls, outGroup), verbs(us.filter((u) => u.edge.to.id === id)));
  };
  grouped((k) => k === "TOPIC" || k === "QUEUE", "out-topics", m.topics, "queue");
  grouped((k) => k === "EXTERNAL_HTTP", "externals", m.externals, "external");
  return g.text(m.header);
}

/**
 * L2: the feature map — features by area, the systems each one touches and how, and the chains between features
 * through topics (A publishes, B consumes). Answers "which parts of the service work with what, and why".
 */
export function featureMapDiagram(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const g = new Graph();
  const uses = sinkUses(model);
  const sinkIds = [...new Set(uses.map((u) => (u.edge.kind === "CONSUME" ? u.edge.from.id : u.edge.to.id)))];
  const collapseFeatures = model.features.length > MAX_NODES;
  const featureNodes = collapseFeatures ? new Set(model.features.map((f) => f.group)).size : model.features.length;
  const collapseSinks = sinkIds.length + featureNodes > MAX_NODES + 4;

  const featureNode = (f: Feature) => {
    if (collapseFeatures) {
      const count = model.features.filter((x) => x.group === f.group).length;
      return g.node(`area:${f.group}`, lines(f.group, m.featureCount(count)), "feature");
    }
    const kind = f.triggers[0]?.type ?? "HTTP";
    return g.node(`f:${f.id}`, lines(n.feature(f), m.triggerKinds[kind] ?? kind), "feature", { id: f.group, title: f.group });
  };
  const sinkNode = (id: string) => {
    const kind = n.sinkKind(id);
    if (!collapseSinks) return g.node(`s:${id}`, lines(n.sink(id), m.sinkKinds[kind]), sinkClass(kind));
    const count = sinkIds.filter((s) => n.sinkKind(s) === kind).length;
    const title = kind === "DB_TABLE" ? m.database(count) : kind === "EXTERNAL_HTTP" ? m.externals(count) : m.topics(count);
    return g.node(`sinks:${kind}`, lines(title), sinkClass(kind));
  };
  for (const f of model.features) featureNode(f);
  for (const { feature, edge } of uses) {
    const claims = edge.claimId ? [edge.claimId] : [];
    if (edge.kind === "CONSUME") g.edge(sinkNode(edge.from.id), featureNode(feature), m.edges.CONSUME, false, claims);
    else g.edge(featureNode(feature), sinkNode(edge.to.id), m.edges[edge.kind] ?? edge.kind, edge.origin === "INFERRED", claims);
  }
  return g.text(m.header);
}

const LAYER: Record<string, number> = { CONTROLLER: 0, LISTENER: 0, SERVICE: 1, COMPONENT: 1, PUBLISHER: 1, CONFIGURATION: 1, REPOSITORY: 2, CLIENT: 2 };

/** Technical view for developers: components by layer (entry points → logic → data access) and the systems they reach. */
export function componentsDiagram(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const edges = model.features.flatMap(activeEdges).filter((e) => e.from.type === "COMPONENT" && (e.to.type === "COMPONENT" || e.to.type === "SINK"));
  const components = new Set(edges.flatMap((e) => [e.from.id, ...(e.to.type === "COMPONENT" ? [e.to.id] : [])]));
  const sinks = new Set(edges.filter((e) => e.to.type === "SINK").map((e) => e.to.id));
  const groupSinks = components.size + sinks.size > MAX_NODES;
  const groupComponents = groupSinks && components.size + new Set([...sinks].map(n.sinkKind)).size > MAX_NODES;
  const layers = [m.layers.entry, m.layers.logic, m.layers.data];
  const layerOf = (id: string) => {
    const l = LAYER[n.componentKind(id)] ?? 1;
    return { id: `layer${l}`, title: layers[l] };
  };

  const g = new Graph();
  const componentNode = (id: string) => {
    const kind = n.componentKind(id) as ComponentKind;
    if (!groupComponents) return g.node(id, lines(n.component(id)), "component", layerOf(id));
    const count = [...components].filter((c) => n.componentKind(c) === kind).length;
    return g.node(`kind:${kind}`, lines(`${m.kinds[kind] ?? kind} (${count})`), "component", layerOf(id));
  };
  const systems = { id: "systems", title: m.layers.systems };
  const sinkNode = (id: string) => {
    const kind = n.sinkKind(id);
    if (!groupSinks) return g.node(id, lines(n.sink(id), m.sinkKinds[kind]), sinkClass(kind), systems);
    const count = [...sinks].filter((s) => n.sinkKind(s) === kind).length;
    const text = kind === "DB_TABLE" ? m.database(count) : kind === "EXTERNAL_HTTP" ? m.externals(count) : m.topics(count);
    return g.node(`sinks:${kind}`, lines(text), sinkClass(kind), systems);
  };
  // Nodes in layer order, so the layers come out left to right.
  for (const id of [...components].sort((a, b) => (LAYER[n.componentKind(a)] ?? 1) - (LAYER[n.componentKind(b)] ?? 1))) componentNode(id);
  for (const e of edges) {
    const from = componentNode(e.from.id);
    const to = e.to.type === "SINK" ? sinkNode(e.to.id) : componentNode(e.to.id);
    g.edge(from, to, m.edges[e.kind] ?? e.kind, e.origin === "INFERRED", groupComponents || groupSinks || !e.claimId ? [] : [e.claimId]);
  }
  return g.text(m.header);
}

/** L3: sequence from the trigger through the steps to the systems, for one feature. */
export function flowDiagram(model: KnowledgeModel, f: Feature, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const steps = flowSteps(model, f);

  const componentIds = [...new Set(steps.flatMap((s) => [s.from, s.to]).filter((x) => x.type === "COMPONENT").map((x) => x.id))];
  const sinkIds = [...new Set(steps.filter((s) => s.to.type === "SINK").map((s) => s.to.id))];
  const room = MAX_NODES - f.triggers.length - sinkIds.length;
  // Too many participants: components of one kind share a lane.
  const grouped = componentIds.length > room;
  const lane = (id: string) => (grouped ? `kind:${n.componentKind(id)}` : id);
  const laneName = (id: string) => (grouped ? m.kinds[n.componentKind(id)] ?? n.componentKind(id) : n.component(id));

  const ids = new Map<string, string>();
  const out = [`%% ${m.header}`, "sequenceDiagram"];
  const participant = (key: string, text: string, actor = false) => {
    if (!ids.has(key)) {
      const id = `p${ids.size + 1}`;
      ids.set(key, id);
      out.push(`  ${actor ? "actor" : "participant"} ${id} as ${label(text)}`);
    }
    return ids.get(key)!;
  };
  const triggerText = (t: Trigger) => (t.type === "MESSAGE" ? `${m.sinkKinds.TOPIC} ${t.attributes.destination ?? ""}` : t.technicalName);
  for (const t of f.triggers) participant(`trigger:${t.id}`, triggerText(t), t.type === "HTTP");
  for (const c of componentIds) participant(lane(c), laneName(c));
  for (const s of sinkIds) participant(`sink:${s}`, `${m.sinkKinds[n.sinkKind(s)] ?? ""} ${n.sink(s)}`);

  for (const s of steps) {
    const from = s.from.type === "TRIGGER" ? ids.get(`trigger:${s.from.id}`)! : ids.get(lane(s.from.id))!;
    const to = s.to.type === "SINK" ? ids.get(`sink:${s.to.id}`)! : ids.get(lane(s.to.id))!;
    const via = s.via ? ` (${n.component(s.via.componentId)})` : "";
    const verb = s.kind === "CALL" ? s.label : `${m.edges[s.kind] ?? s.kind}: ${s.label}${via}`;
    for (const c of s.claimIds) out.push(`  %% claim ${c}`);
    // Async calls get Mermaid's open arrow: the caller goes on without waiting.
    const arrow = s.async ? (s.origin === "INFERRED" ? "--)" : "-)") : s.origin === "INFERRED" ? "-->>" : "->>";
    const marks = [s.async ? m.asyncMark : "", s.origin === "INFERRED" ? m.inferredMark : ""].filter(Boolean).map(label).join(" ");
    out.push(`  ${from}${arrow}${to}: ${label(verb)}${marks ? ` ${marks}` : ""}`);
  }
  return out.join("\n") + "\n";
}

export const mermaidRenderer: Renderer = {
  id: "mermaid",
  render(model, view) {
    return [
      { relativePath: "diagrams/context.mmd", content: contextDiagram(model, view.language) },
      { relativePath: "diagrams/features.mmd", content: featureMapDiagram(model, view.language) },
      { relativePath: "diagrams/components.mmd", content: componentsDiagram(model, view.language) },
      ...model.features.map((f) => ({ relativePath: `features/${f.id}/flow.mmd`, content: flowDiagram(model, f, view.language) })),
    ];
  },
};
