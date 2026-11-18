import type { EdgeKind, Feature, KnowledgeModel, SinkKind } from "../../types";
import { activeEdges, namer } from "./names";

/** One external party of the service: who calls it, or what it calls, how, and for which features. */
export interface Interaction {
  direction: "in" | "out";
  kind: SinkKind | "CLIENTS" | "SCHEDULE" | "ASYNC" | "EVENT" | "STARTUP";
  name: string;
  technicalName?: string;
  actions: EdgeKind[];
  features: Feature[];
}

/**
 * The service's interactions as a table: incoming (API clients, consumed topics, schedules, events) and outgoing
 * (tables, topics, external APIs). Text next to the diagrams, so a reader gets "with what, how and why" in words.
 */
export function interactions(model: KnowledgeModel, lang: string): Interaction[] {
  const n = namer(model, lang);
  const out: Interaction[] = [];
  const byType = (t: string) => model.features.filter((f) => f.triggers.some((x) => x.type === t));
  const http = byType("HTTP");
  if (http.length) out.push({ direction: "in", kind: "CLIENTS", name: "", actions: ["CALL"], features: http });
  const consumed = new Map<string, Feature[]>();
  for (const f of model.features) {
    for (const t of f.triggers.filter((x) => x.type === "MESSAGE")) {
      const d = t.attributes.destination ?? "";
      consumed.set(d, [...(consumed.get(d) ?? []), f]);
    }
  }
  for (const [d, fs] of consumed) out.push({ direction: "in", kind: "TOPIC", name: d, actions: ["CONSUME"], features: fs });
  for (const t of ["SCHEDULE", "ASYNC", "EVENT", "STARTUP"] as const) {
    const fs = byType(t);
    if (fs.length) out.push({ direction: "in", kind: t, name: "", actions: ["CALL"], features: fs });
  }

  const sinks = new Map<string, { actions: Set<EdgeKind>; features: Set<Feature> }>();
  for (const f of model.features) {
    for (const e of activeEdges(f).filter((x) => x.to.type === "SINK")) {
      const s = sinks.get(e.to.id) ?? { actions: new Set<EdgeKind>(), features: new Set<Feature>() };
      s.actions.add(e.kind);
      s.features.add(f);
      sinks.set(e.to.id, s);
    }
  }
  const order: SinkKind[] = ["DB_TABLE", "TOPIC", "QUEUE", "EXTERNAL_HTTP", "FILE"];
  const rows = [...sinks.entries()].map(([id, s]) => ({
    direction: "out" as const,
    kind: n.sinkKind(id) as SinkKind,
    name: n.sink(id),
    technicalName: model.catalog.sinks.find((x) => x.id === id)?.technicalName,
    actions: [...s.actions],
    features: [...s.features],
  }));
  rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  return [...out, ...rows];
}
