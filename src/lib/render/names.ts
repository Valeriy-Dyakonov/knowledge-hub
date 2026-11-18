import type { Edge, Feature, KnowledgeModel, LocalizedText } from "../../types";
import { simpleName } from "../model/ids";

const pick = (text: LocalizedText, lang: string) => text[lang] ?? Object.values(text)[0];

/** Display names: business name in the language when reviewed or proposed, technical name otherwise. */
export function namer(model: KnowledgeModel, lang: string) {
  const components = new Map(model.catalog.components.map((c) => [c.id, c]));
  const sinks = new Map(model.catalog.sinks.map((s) => [s.id, s]));
  return {
    feature: (f: Feature) => pick(f.businessName, lang) ?? f.technicalName,
    component: (id: string) => {
      const c = components.get(id);
      return (c && pick(c.businessName, lang)) ?? c?.technicalName ?? simpleName(id);
    },
    sink: (id: string) => {
      const s = sinks.get(id);
      return (s && pick(s.businessName, lang)) ?? s?.technicalName ?? id;
    },
    sinkKind: (id: string) => sinks.get(id)?.kind ?? "DB_TABLE",
    componentKind: (id: string) => components.get(id)?.kind ?? "COMPONENT",
  };
}

export type Namer = ReturnType<typeof namer>;

/** Edges without rejected claims: rejected knowledge never reaches a view. */
export function activeEdges(f: Feature): Edge[] {
  const rejected = new Set(f.claims.filter((c) => c.status === "REJECTED").map((c) => c.id));
  return f.edges.filter((e) => !e.claimId || !rejected.has(e.claimId));
}

/** Mermaid label text: no quotes, pipes, angle brackets or statement separators. */
export const label = (s: string) =>
  s.replace(/->/g, "→").replace(/"/g, "'").replace(/[;#]/g, ",").replace(/\|/g, "/").replace(/</g, "‹").replace(/>/g, "›").replace(/\s+/g, " ").trim();
