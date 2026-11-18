import { messagesFor } from "../../i18n";
import type { ComponentKind, Edge, EdgeKind, Feature, KnowledgeModel, SinkKind, Trigger, TriggerType } from "../../types";
import { flowSteps } from "../model/flow";
import { activeEdges, label, namer } from "./names";
import type { Renderer } from "./types";

// Readability rules (docs/06-diagrams.md): about a dozen nodes per view, business names, one shape and colour per node
// kind, who triggers on the left and the systems reached on the right, every edge traceable to a claim.
// Large groups are never cut with "and N more": they collapse into one node that the app expands on click.
export const MAX_NODES = 12;
/** A frame with more items than this collapses into one node until it is expanded. */
export const GROUP_LIMIT = 8;

const CLASSES = [
  "classDef trigger fill:#2f6fed,stroke:#1f4fb8,color:#fff",
  "classDef component fill:#ede7f9,stroke:#8e63d8,color:#2b1d4a",
  "classDef feature fill:#e8f0fe,stroke:#2f6fed,color:#14274e",
  "classDef service fill:#8e63d8,stroke:#5e3aa6,color:#fff",
  "classDef db fill:#e3f5ea,stroke:#1f9d55,color:#123d24",
  "classDef queue fill:#fbf0dc,stroke:#c27c0e,color:#4a3006",
  "classDef external fill:#fde5e0,stroke:#e24329,color:#4f1307",
  "classDef more fill:#ffffff,stroke:#8b95a5,color:#1c2330,stroke-dasharray:4 3",
];

type NodeClass = "trigger" | "component" | "feature" | "service" | "db" | "queue" | "external" | "more";

/** Mermaid text plus which logical key each Mermaid node id stands for, so the app can react to clicks. */
export interface DiagramSpec {
  text: string;
  /** Mermaid node id -> key (`sink:<id>`, `feature:<id>`, `kind:SERVICE`, `component:<id>`, `expand:<frame>`...). */
  nodes: Record<string, string>;
}

export interface ViewOptions {
  /** Frames shown in full even when larger than GROUP_LIMIT. */
  expand?: Set<string>;
  /** Components view: show this component with its callers, callees and sinks. */
  focus?: string;
}

export const sinkClass = (k: SinkKind | string): NodeClass =>
  k === "DB_TABLE" ? "db" : k === "TOPIC" || k === "QUEUE" ? "queue" : k === "EXTERNAL_HTTP" ? "external" : "component";

/** Several label lines; each line escaped, joined with a Mermaid line break. */
const lines = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).map(label).join("<br/>");

function shape(id: string, text: string, cls: NodeClass): string {
  const t = `"${text}"`;
  const body = { trigger: `([${t}])`, component: `[${t}]`, feature: `(${t})`, service: `[[${t}]]`, db: `[(${t})]`, queue: `[/${t}/]`, external: `{{${t}}}`, more: `[${t}]` }[cls];
  return `${id}${body}:::${cls}`;
}

interface Frame { id: string; title: string; dir?: "TB" | "LR" }

/** Frames with more nodes than this are laid out in columns instead of one long line. */
const COLUMN_AT = 6;

/** "refund_items" / "refunds.created" -> "refund" / "refunds": names sharing a prefix are put in one column. */
export const prefixOf = (name: string) => name.toLowerCase().split(/[_.\-:/]/).find((p) => p.length > 1) ?? name.toLowerCase();

/**
 * How a large frame is split: by name prefix when that gives real groups (at least two prefixes shared by two or more
 * names, covering most of them), otherwise into even columns. Returns [title, members] in display order.
 */
export function columns<T>(items: T[], nameOf: (t: T) => string): [string, T[]][] {
  if (items.length <= COLUMN_AT) return [["", items]];
  const byPrefix = new Map<string, T[]>();
  for (const it of items) byPrefix.set(prefixOf(nameOf(it)), [...(byPrefix.get(prefixOf(nameOf(it))) ?? []), it]);
  const groups = [...byPrefix.entries()].filter(([, xs]) => xs.length >= 2);
  const covered = groups.reduce((n, [, xs]) => n + xs.length, 0);
  if (groups.length >= 2 && covered >= items.length * 0.6) {
    const rest = items.filter((it) => !groups.some(([, xs]) => xs.includes(it)));
    return [...groups.map(([p, xs]): [string, T[]] => [`${p}*`, xs]), ...(rest.length ? [["…", rest] as [string, T[]]] : [])];
  }
  const per = Math.ceil(Math.sqrt(items.length));
  const out: [string, T[]][] = [];
  for (let i = 0; i < items.length; i += per) out.push(["", items.slice(i, i + per)]);
  return out;
}

class Graph {
  private ids = new Map<string, string>();
  private frames = new Map<string, { mid: string; title: string; dir?: string; nodes: { line: string; name: string }[] }>();
  private loose: string[] = [];
  private edges = new Map<string, string>();
  readonly keys: Record<string, string> = {};

  /** `text` is already escaped (use `lines`). */
  node(key: string, text: string, cls: NodeClass, frame?: Frame): string {
    let id = this.ids.get(key);
    if (!id) {
      id = `n${this.ids.size + 1}`;
      this.ids.set(key, id);
      this.keys[id] = key;
      const line = shape(id, text, cls);
      // The plain first line of the label is the name used for column grouping.
      if (frame) this.frame(frame).nodes.push({ line, name: text.split("<br/>")[0] });
      else this.loose.push(line);
    }
    return id;
  }

  /** A frame (subgraph); edges may point to a frame as a whole through its Mermaid id. */
  frame(f: Frame) {
    let fr = this.frames.get(f.id);
    if (!fr) {
      fr = { mid: `g${this.frames.size + 1}`, title: f.title, dir: f.dir, nodes: [] };
      this.frames.set(f.id, fr);
    }
    return fr;
  }

  edge(from: string, to: string, text: string, inferred = false, claimIds: string[] = []) {
    const key = `${from}>${to}>${text}`;
    if (this.edges.has(key) || from === to) return;
    // Braces (path variables like {id}) would open a diamond shape inside an edge label.
    const t = label(text).replace(/\{/g, "#123;").replace(/\}/g, "#125;");
    const arrow = (inferred ? "-.->" : "-->") + (t ? `|${t}|` : "");
    this.edges.set(key, `${claimIds.map((c) => `  %% claim ${c}\n`).join("")}  ${from} ${arrow} ${to}`);
  }

  spec(header: string, direction: "LR" | "TB" = "LR"): DiagramSpec {
    const styles: string[] = [];
    const frames = [...this.frames.values()]
      .filter((f) => f.nodes.length)
      .flatMap((f) => {
        const cols = columns(f.nodes, (n) => n.name);
        if (cols.length === 1) return [`  subgraph ${f.mid}["${label(f.title)}"]`, ...(f.dir ? [`    direction ${f.dir}`] : []), ...f.nodes.map((n) => `    ${n.line}`), "  end"];
        // Columns side by side, each a small frame of its own: titled by prefix, or invisible for an even grid.
        const body = cols.flatMap(([title, nodes], i) => {
          const cid = `${f.mid}c${i + 1}`;
          if (!title) styles.push(`  style ${cid} fill:transparent,stroke:transparent`);
          return [`    subgraph ${cid}["${title ? label(title) : " "}"]`, "      direction TB", ...nodes.map((n) => `      ${n.line}`), "    end"];
        });
        return [`  subgraph ${f.mid}["${label(f.title)}"]`, "    direction LR", ...body, "  end"];
      });
    const text = [`%% ${header}`, `flowchart ${direction}`, ...this.loose.map((n) => `  ${n}`), ...frames, ...this.edges.values(), ...CLASSES.map((c) => `  ${c}`), ...styles].join("\n") + "\n";
    return { text, nodes: { ...this.keys } };
  }
}

/** Every sink edge of every feature (and consumed topics) with the feature it belongs to. */
function sinkUses(model: KnowledgeModel): { feature: Feature; edge: Edge }[] {
  return model.features.flatMap((f) => activeEdges(f).filter((e) => e.to.type === "SINK" || e.kind === "CONSUME").map((edge) => ({ feature: f, edge })));
}

/**
 * Puts items into a frame, or — when there are more than GROUP_LIMIT and the frame is not expanded — one
 * "N items" node that stands for all of them (key `expand:<frame>`). Returns the frame's Mermaid id for edges.
 */
function fill(g: Graph, frame: Frame, items: { key: string; text: string; cls: NodeClass }[], collapsedText: string, opts: ViewOptions): string {
  const fr = g.frame(frame);
  if (items.length > GROUP_LIMIT && !opts.expand?.has(frame.id)) g.node(`expand:${frame.id}`, lines(collapsedText), "more", frame);
  else for (const it of items) g.node(it.key, it.text, it.cls, frame);
  return fr.mid;
}

/**
 * L1: the service as a whole. Left: who calls it (API clients by area, topics it listens to, jobs). Right: what it
 * works with (database tables, topics it publishes to, external services). One arrow per frame says how.
 */
export function contextDiagram(model: KnowledgeModel, lang: string, opts: ViewOptions = {}): DiagramSpec {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const g = new Graph();
  const svc = g.node("service", lines(model.service.name, m.featureCount(model.features.length)), "service");

  const withType = (...t: TriggerType[]) => model.features.filter((f) => f.triggers.some((x) => t.includes(x.type)));
  const http = withType("HTTP");
  if (http.length) {
    const areas = [...new Set(http.map((f) => f.group))].sort();
    const items = areas.map((a) => ({ key: `area:${a}`, text: lines(a, m.featureCount(http.filter((f) => f.group === a).length)), cls: "trigger" as NodeClass }));
    g.edge(fill(g, { id: "in-http", title: m.frames.clients, dir: "TB" }, items, m.collapsed(areas.length, m.frames.clients), opts), svc, `${http.length} HTTP`);
  }
  const consumed = [...new Set(model.features.flatMap((f) => f.triggers.filter((t) => t.type === "MESSAGE").map((t) => t.attributes.destination ?? "")))].sort();
  if (consumed.length) {
    const items = consumed.map((d) => ({ key: `topic-in:${d}`, text: lines(d), cls: "queue" as NodeClass }));
    g.edge(fill(g, { id: "in-topics", title: m.frames.consumes, dir: "TB" }, items, m.collapsed(consumed.length, m.frames.consumes), opts), svc, m.edges.CONSUME);
  }
  const jobs = withType("SCHEDULE", "ASYNC", "EVENT", "STARTUP");
  if (jobs.length) {
    const items = jobs.map((f) => ({ key: `feature:${f.id}`, text: lines(n.feature(f), m.triggerKinds[f.triggers[0].type]), cls: "trigger" as NodeClass }));
    g.edge(fill(g, { id: "in-jobs", title: m.frames.jobs, dir: "TB" }, items, m.collapsed(jobs.length, m.frames.jobs), opts), svc, "");
  }

  const uses = sinkUses(model).filter((u) => u.edge.kind !== "CONSUME");
  const out = (kinds: string[], frame: Frame, verbsOf: EdgeKind[]) => {
    const us = uses.filter((u) => kinds.includes(n.sinkKind(u.edge.to.id)));
    const ids = [...new Set(us.map((u) => u.edge.to.id))].sort((a, b) => n.sink(a).localeCompare(n.sink(b)));
    if (!ids.length) return;
    const items = ids.map((id) => ({ key: `sink:${id}`, text: lines(n.sink(id)), cls: sinkClass(n.sinkKind(id)) }));
    const verbs = verbsOf.filter((k) => us.some((u) => u.edge.kind === k)).map((k) => m.edges[k]).join(" / ");
    g.edge(svc, fill(g, frame, items, m.collapsed(ids.length, frame.title), opts), verbs);
  };
  out(["DB_TABLE"], { id: "out-db", title: m.frames.database, dir: "TB" }, ["WRITE", "READ"]);
  out(["TOPIC", "QUEUE"], { id: "out-topics", title: m.frames.publishes, dir: "TB" }, ["PUBLISH"]);
  out(["EXTERNAL_HTTP", "FILE"], { id: "out-external", title: m.frames.externals, dir: "TB" }, ["HTTP_CALL", "WRITE", "READ"]);
  return g.spec(m.header);
}

/**
 * L2 as a diagram (for files and MCP): areas side by side at the top with their features, the systems in rows at the
 * bottom; topics link a publishing feature to a consuming one. In the app the same map is also shown as a table.
 */
export function featureMapDiagram(model: KnowledgeModel, lang: string, opts: ViewOptions = {}): DiagramSpec {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const g = new Graph();
  const uses = sinkUses(model);
  const areas = [...new Set(model.features.map((f) => f.group))].sort();
  // An area with many features is one node until expanded.
  const featureNode = (f: Feature) => {
    const inArea = model.features.filter((x) => x.group === f.group);
    const frame = { id: `area:${f.group}`, title: f.group, dir: "TB" as const };
    if (inArea.length > GROUP_LIMIT && !opts.expand?.has(frame.id)) return g.node(`expand:${frame.id}`, lines(m.collapsed(inArea.length, m.featureWord)), "more", frame);
    const kind = f.triggers[0]?.type ?? "HTTP";
    return g.node(`feature:${f.id}`, lines(n.feature(f), m.triggerKinds[kind] ?? kind), "feature", frame);
  };
  for (const a of areas) for (const f of model.features.filter((x) => x.group === a)) featureNode(f);
  const sinkFrame = (kind: string): Frame =>
    kind === "DB_TABLE" ? { id: "out-db", title: m.frames.database, dir: "LR" } : kind === "EXTERNAL_HTTP" ? { id: "out-external", title: m.frames.externals, dir: "LR" } : { id: "out-topics", title: m.frames.topics, dir: "LR" };
  const sinkIds = [...new Set(uses.map((u) => (u.edge.kind === "CONSUME" ? u.edge.from.id : u.edge.to.id)))];
  const sinkNode = (id: string) => {
    const kind = n.sinkKind(id);
    const frame = sinkFrame(kind);
    const count = sinkIds.filter((s) => sinkFrame(n.sinkKind(s)).id === frame.id).length;
    if (count > GROUP_LIMIT && !opts.expand?.has(frame.id)) return g.node(`expand:${frame.id}`, lines(m.collapsed(count, frame.title)), "more", frame);
    return g.node(`sink:${id}`, lines(n.sink(id)), sinkClass(kind), frame);
  };
  for (const { feature, edge } of uses) {
    const claims = edge.claimId ? [edge.claimId] : [];
    if (edge.kind === "CONSUME") g.edge(sinkNode(edge.from.id), featureNode(feature), m.edges.CONSUME, false, claims);
    else g.edge(featureNode(feature), sinkNode(edge.to.id), m.edges[edge.kind] ?? edge.kind, edge.origin === "INFERRED", claims);
  }
  return g.spec(m.header, "TB");
}

const LAYER: Record<string, number> = { CONTROLLER: 0, LISTENER: 0, SERVICE: 1, COMPONENT: 1, PUBLISHER: 1, CONFIGURATION: 1, REPOSITORY: 2, CLIENT: 2 };

/**
 * Technical view for developers: components by layer (entry points → logic → data access → systems). Kinds with many
 * components are one node (`kind:<KIND>`) until expanded; with `focus`, one component with its callers, callees, sinks.
 */
export function componentsDiagram(model: KnowledgeModel, lang: string, opts: ViewOptions = {}): DiagramSpec {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  let edges = model.features.flatMap(activeEdges).filter((e) => e.from.type === "COMPONENT" && (e.to.type === "COMPONENT" || e.to.type === "SINK"));
  if (opts.focus) edges = edges.filter((e) => e.from.id === opts.focus || e.to.id === opts.focus);
  const components = new Set(edges.flatMap((e) => [e.from.id, ...(e.to.type === "COMPONENT" ? [e.to.id] : [])]));
  if (opts.focus) components.add(opts.focus);
  const layers = [m.layers.entry, m.layers.logic, m.layers.data];
  const layerFrame = (id: string): Frame => {
    const l = LAYER[n.componentKind(id)] ?? 1;
    return { id: `layer${l}`, title: layers[l], dir: "TB" };
  };
  const byKind = (kind: string) => [...components].filter((c) => n.componentKind(c) === kind);

  const g = new Graph();
  const componentNode = (id: string) => {
    const kind = n.componentKind(id) as ComponentKind;
    const many = byKind(kind).length > GROUP_LIMIT && !opts.expand?.has(`kind:${kind}`) && id !== opts.focus;
    if (many) return g.node(`kind:${kind}`, lines(`${m.kinds[kind] ?? kind} (${byKind(kind).length})`), "more", layerFrame(id));
    return g.node(`component:${id}`, lines(n.component(id)), id === opts.focus ? "service" : "component", layerFrame(id));
  };
  const systems = { id: "systems", title: m.layers.systems, dir: "TB" as const };
  const sinkIds = [...new Set(edges.filter((e) => e.to.type === "SINK").map((e) => e.to.id))];
  const sinkNode = (id: string) => {
    const kind = n.sinkKind(id);
    const count = sinkIds.filter((s) => n.sinkKind(s) === kind).length;
    if (count > GROUP_LIMIT && !opts.expand?.has(`sinks:${kind}`)) {
      const what = kind === "DB_TABLE" ? m.frames.database : kind === "EXTERNAL_HTTP" ? m.frames.externals : m.frames.topics;
      return g.node(`expand:sinks:${kind}`, lines(m.collapsed(count, what)), "more", systems);
    }
    return g.node(`sink:${id}`, lines(n.sink(id), m.sinkKinds[kind]), sinkClass(kind), systems);
  };
  // Nodes in layer order, so the layers come out left to right.
  for (const id of [...components].sort((a, b) => (LAYER[n.componentKind(a)] ?? 1) - (LAYER[n.componentKind(b)] ?? 1))) componentNode(id);
  for (const e of edges) {
    const from = componentNode(e.from.id);
    const to = e.to.type === "SINK" ? sinkNode(e.to.id) : componentNode(e.to.id);
    g.edge(from, to, m.edges[e.kind] ?? e.kind, e.origin === "INFERRED", e.claimId ? [e.claimId] : []);
  }
  return g.spec(m.header);
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

/** Written files and MCP show everything: no frame is collapsed there. */
export const expandAll = (model: KnowledgeModel): ViewOptions => ({
  expand: new Set(["in-http", "in-topics", "in-jobs", "out-db", "out-topics", "out-external", ...model.features.map((f) => `area:${f.group}`)]),
});

export const mermaidRenderer: Renderer = {
  id: "mermaid",
  render(model, view) {
    const all = expandAll(model);
    return [
      { relativePath: "diagrams/context.mmd", content: contextDiagram(model, view.language, all).text },
      { relativePath: "diagrams/features.mmd", content: featureMapDiagram(model, view.language, all).text },
      { relativePath: "diagrams/components.mmd", content: componentsDiagram(model, view.language).text },
      ...model.features.map((f) => ({ relativePath: `features/${f.id}/flow.mmd`, content: flowDiagram(model, f, view.language) })),
    ];
  },
};
