import { messagesFor } from "../../i18n";
import type { Claim, KnowledgeModel } from "../../types";
import { namer } from "../render/names";

/** A claim in plain words, so the reviewer reads a sentence, not a payload. */
export function statement(c: Claim, model: KnowledgeModel, lang: string, payload: Record<string, string> = c.payload): string {
  const m = messagesFor(lang).review;
  const n = namer(model, lang);
  const node = (id?: string, type?: string) =>
    !id ? "" : type === "SINK" ? n.sink(id) : type === "TRIGGER" ? triggerName(model, id) : n.component(id);
  const fromType = c.subject.type === "EDGE" ? model.features.flatMap((f) => f.edges).find((e) => e.id === c.subject.id)?.from.type : undefined;
  const params: Record<string, string> = {
    ...payload,
    from: fromType === "TRIGGER" ? triggerName(model, payload.from) : fromType === "SINK" ? n.sink(payload.from ?? "") : node(payload.from, "COMPONENT"),
    to: node(payload.to, payload.toType),
    toKind: m.sinkKinds[n.sinkKind(payload.to ?? "")] ?? "",
    trigger: triggerName(model, c.subject.id),
    feature: model.features.find((f) => f.id === payload.feature)?.technicalName ?? payload.feature ?? "",
  };
  if (c.kind === "DESCRIBES") {
    const subject = c.subject.type === "FEATURE"
      ? model.features.find((f) => f.id === c.subject.id)?.technicalName ?? c.subject.id
      : c.subject.type === "SINK" ? model.catalog.sinks.find((s) => s.id === c.subject.id)?.technicalName ?? c.subject.id : n.component(c.subject.id);
    params.what = (m.describes[`${c.subject.type}:${payload.field}`] ?? ((x: string) => x))(subject);
  }
  return (m.statements[c.kind] ?? (() => `${c.kind} ${JSON.stringify(payload)}`))(params);
}

function triggerName(model: KnowledgeModel, id?: string): string {
  if (!id) return "";
  return model.features.flatMap((f) => f.triggers).find((t) => t.id === id)?.technicalName ?? id;
}
