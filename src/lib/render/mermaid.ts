import { messagesFor } from "../../i18n";
import type { Edge, Feature, KnowledgeModel, SinkKind, Trigger } from "../../types";
import { activeEdges, label, namer, type Namer } from "./names";
import type { Renderer } from "./types";

// Readability rules (docs/06-diagrams.md): at most ~12 nodes, business names, one shape and colour per node kind,
// left to right with triggers on the left and sinks on the right, every node/edge traceable to a claim.
export const MAX_NODES = 12;

const CLASSES = [
  "classDef trigger fill:#2f6fed,stroke:#1f4fb8,color:#fff",
  "classDef component fill:#ede7f9,stroke:#8e63d8,color:#2b1d4a",
  "classDef service fill:#8e63d8,stroke:#5e3aa6,color:#fff",
  "classDef db fill:#e3f5ea,stroke:#1f9d55,color:#123d24",
  "classDef queue fill:#fbf0dc,stroke:#c27c0e,color:#4a3006",
  "classDef external fill:#fde5e0,stroke:#e24329,color:#4f1307",
];

type NodeClass = "trigger" | "component" | "service" | "db" | "queue" | "external";

const sinkClass = (k: SinkKind | string): NodeClass => (k === "DB_TABLE" ? "db" : k === "TOPIC" || k === "QUEUE" ? "queue" : k === "EXTERNAL_HTTP" ? "external" : "component");

function shape(id: string, text: string, cls: NodeClass): string {
  const t = `"${label(text)}"`;
  const body = { trigger: `([${t}])`, component: `[${t}]`, service: `[[${t}]]`, db: `[(${t})]`, queue: `[/${t}/]`, external: `{{${t}}}` }[cls];
  return `  ${id}${body}:::${cls}`;
}

class Graph {
  private ids = new Map<string, string>();
  nodes: string[] = [];
  edges = new Map<string, string>();

  node(key: string, text: string, cls: NodeClass): string {
    let id = this.ids.get(key);
    if (!id) {
      id = `n${this.ids.size + 1}`;
      this.ids.set(key, id);
      this.nodes.push(shape(id, text, cls));
    }
    return id;
  }

  edge(from: string, to: string, text: string, inferred = false, claimId?: string) {
    const key = `${from}>${to}>${text}`;
    if (this.edges.has(key)) return;
    const t = label(text);
    const arrow = (inferred ? "-.->" : "-->") + (t ? `|${t}|` : "");
    this.edges.set(key, `${claimId ? `  %% claim ${claimId}\n` : ""}  ${from} ${arrow} ${to}`);
  }

  get size() {
    return this.ids.size;
  }

  text(header: string): string {
    return [`%% ${header}`, "flowchart LR", ...this.nodes, ...this.edges.values(), ...CLASSES.map((c) => `  ${c}`)].join("\n") + "\n";
  }
}

/** L1: the service, who triggers it, and what it reaches outside. For everyone, including non-technical readers. */
export function contextDiagram(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const g = new Graph();
  const svc = g.node("service", model.service.name, "service");

  const triggers = model.features.flatMap((f) => f.triggers);
  const byType = (t: Trigger["type"]) => triggers.filter((x) => x.type === t);
  const http = byType("HTTP");
  if (http.length) g.edge(g.node("clients", m.clients, "trigger"), svc, `${http.length} HTTP`);
  const consumed = [...new Set(byType("MESSAGE").map((t) => t.attributes.destination ?? ""))];
  if (consumed.length > 4) g.edge(g.node("in-topics", m.topics(consumed.length), "queue"), svc, m.edges.CONSUME);
  else for (const d of consumed) g.edge(g.node(`in:${d}`, d, "queue"), svc, m.edges.CONSUME);
  if (byType("SCHEDULE").length) g.edge(g.node("schedule", m.schedule, "trigger"), svc, String(byType("SCHEDULE").length));
  if (byType("EVENT").length) g.edge(g.node("events", m.events, "trigger"), svc, String(byType("EVENT").length));
  if (byType("STARTUP").length) g.edge(g.node("startup", m.startup, "trigger"), svc, "");

  const outgoing = model.features.flatMap(activeEdges).filter((e) => e.to.type === "SINK" && e.kind !== "CONSUME");
  const sinkIds = [...new Set(outgoing.map((e) => e.to.id))];
  const tables = sinkIds.filter((s) => n.sinkKind(s) === "DB_TABLE");
  const topics = sinkIds.filter((s) => n.sinkKind(s) === "TOPIC" || n.sinkKind(s) === "QUEUE");
  const externals = sinkIds.filter((s) => n.sinkKind(s) === "EXTERNAL_HTTP");
  if (tables.length) g.edge(svc, g.node("db", m.database(tables.length), "db"), `${m.edges.READ} / ${m.edges.WRITE}`);
  if (topics.length > 4) g.edge(svc, g.node("out-topics", m.topics(topics.length), "queue"), m.edges.PUBLISH);
  else for (const s of topics) g.edge(svc, g.node(s, n.sink(s), "queue"), m.edges.PUBLISH);
  if (externals.length > 4) g.edge(svc, g.node("externals", m.externals(externals.length), "external"), m.edges.HTTP_CALL);
  else for (const s of externals) g.edge(svc, g.node(s, n.sink(s), "external"), m.edges.HTTP_CALL);
  return g.text(m.header);
}

/** L2: main building blocks and the stores, queues and APIs they touch; grouped by kind when too large. */
export function componentsDiagram(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const edges = model.features.flatMap(activeEdges).filter((e) => e.from.type === "COMPONENT" && (e.to.type === "COMPONENT" || e.to.type === "SINK"));
  const components = new Set(edges.flatMap((e) => [e.from.id, ...(e.to.type === "COMPONENT" ? [e.to.id] : [])]));
  const sinks = new Set(edges.filter((e) => e.to.type === "SINK").map((e) => e.to.id));
  const groupSinks = components.size + sinks.size > MAX_NODES;
  const groupComponents = groupSinks && components.size + new Set([...sinks].map(n.sinkKind)).size > MAX_NODES;

  const sinkCount = (kind: string) => [...sinks].filter((s) => n.sinkKind(s) === kind).length;
  const g = new Graph();
  const componentNode = (id: string) => {
    if (!groupComponents) return g.node(id, n.component(id), "component");
    const kind = n.componentKind(id);
    const count = [...components].filter((c) => n.componentKind(c) === kind).length;
    return g.node(`kind:${kind}`, `${m.kinds[kind] ?? kind} (${count})`, "component");
  };
  const sinkNode = (id: string) => {
    const kind = n.sinkKind(id);
    if (!groupSinks) return g.node(id, n.sink(id), sinkClass(kind));
    const text = kind === "DB_TABLE" ? m.database(sinkCount(kind)) : kind === "EXTERNAL_HTTP" ? m.externals(sinkCount(kind)) : m.topics(sinkCount(kind));
    return g.node(`sinks:${kind}`, text, sinkClass(kind));
  };
  for (const e of edges) {
    const from = componentNode(e.from.id);
    const to = e.to.type === "SINK" ? sinkNode(e.to.id) : componentNode(e.to.id);
    if (from === to) continue;
    g.edge(from, to, m.edges[e.kind] ?? e.kind, e.origin === "INFERRED", groupComponents || groupSinks ? undefined : e.claimId);
  }
  return g.text(m.header);
}

/** L3: sequence from the trigger through the steps to the sinks, for one feature. */
export function flowDiagram(model: KnowledgeModel, f: Feature, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const edges = new Map(activeEdges(f).map((e) => [e.id, e]));
  const steps = f.steps
    .map((s) => (s.edgeId ? edges.get(s.edgeId) : undefined))
    .filter((e): e is Edge => e !== undefined && e.kind !== "CONSUME");

  const componentIds = [...new Set(steps.flatMap((e) => [e.from, e.to]).filter((x) => x.type === "COMPONENT").map((x) => x.id))];
  const sinkIds = [...new Set(steps.filter((e) => e.to.type === "SINK").map((e) => e.to.id))];
  const room = MAX_NODES - f.triggers.length - sinkIds.length;
  // Too many participants: components of one kind share a lane.
  const grouped = componentIds.length > room;
  const lane = (id: string) => (grouped ? `kind:${n.componentKind(id)}` : id);
  const laneName = (id: string) => (grouped ? m.kinds[n.componentKind(id)] ?? n.componentKind(id) : n.component(id));

  const ids = new Map<string, string>();
  const lines = [`%% ${m.header}`, "sequenceDiagram"];
  const participant = (key: string, text: string, actor = false) => {
    if (!ids.has(key)) {
      const id = `p${ids.size + 1}`;
      ids.set(key, id);
      lines.push(`  ${actor ? "actor" : "participant"} ${id} as ${label(text)}`);
    }
    return ids.get(key)!;
  };
  const triggerText = (t: Trigger) => (t.type === "MESSAGE" ? `${m.sinkKinds.TOPIC} ${t.attributes.destination ?? ""}` : t.technicalName);
  for (const t of f.triggers) participant(`trigger:${t.id}`, triggerText(t), t.type === "HTTP");
  for (const c of componentIds) participant(lane(c), laneName(c));
  for (const s of sinkIds) participant(`sink:${s}`, `${m.sinkKinds[n.sinkKind(s)] ?? ""} ${n.sink(s)}`);

  for (const e of steps) {
    const from = e.from.type === "TRIGGER" ? ids.get(`trigger:${e.from.id}`)! : ids.get(lane(e.from.id))!;
    const to = e.to.type === "SINK" ? ids.get(`sink:${e.to.id}`)! : ids.get(lane(e.to.id))!;
    const verb = e.kind === "CALL" ? e.label : `${m.edges[e.kind] ?? e.kind}: ${e.label}`;
    if (e.claimId) lines.push(`  %% claim ${e.claimId}`);
    lines.push(`  ${from}${e.origin === "INFERRED" ? "-->>" : "->>"}${to}: ${label(verb)}${e.origin === "INFERRED" ? ` ${label(m.inferredMark)}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export const mermaidRenderer: Renderer = {
  id: "mermaid",
  render(model, view) {
    return [
      { relativePath: "diagrams/context.mmd", content: contextDiagram(model, view.language) },
      { relativePath: "diagrams/components.mmd", content: componentsDiagram(model, view.language) },
      ...model.features.map((f) => ({ relativePath: `features/${f.id}/flow.mmd`, content: flowDiagram(model, f, view.language) })),
    ];
  },
};

export type { Namer };
