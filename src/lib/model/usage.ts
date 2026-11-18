import type { Feature, KnowledgeModel } from "../../types";
import { activeEdges } from "../render/names";

export interface TableUse { feature: Feature; reads: boolean; writes: boolean }

/** Features that read or write a table (through the `db_table:<name>` sink of their flow). */
export function tableUsage(model: KnowledgeModel, table: string): TableUse[] {
  const sinkId = `db_table:${table.toLowerCase()}`;
  const out: TableUse[] = [];
  for (const f of model.features) {
    const edges = activeEdges(f).filter((e) => e.to.type === "SINK" && e.to.id.toLowerCase() === sinkId);
    if (!edges.length) continue;
    out.push({ feature: f, reads: edges.some((e) => e.kind === "READ"), writes: edges.some((e) => e.kind === "WRITE") });
  }
  return out;
}

/** Features whose flow goes through a component (e.g. one that reads a property). */
export function componentFeatures(model: KnowledgeModel, componentId: string): Feature[] {
  return model.features.filter((f) => f.componentIds.includes(componentId) || f.triggers.some((t) => t.componentId === componentId));
}
