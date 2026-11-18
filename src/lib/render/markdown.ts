import { messagesFor } from "../../i18n";
import type { Evidence, Feature, KnowledgeModel } from "../../types";
import { isUnverified } from "../model/claims";
import { statusOf } from "../model/status";
import { componentsDiagram, contextDiagram, flowDiagram } from "./mermaid";
import { activeEdges, namer } from "./names";
import type { Renderer } from "./types";

const loc = (e?: Evidence) => (e ? ` — \`${e.path}${e.lines ? `:${e.lines.start}` : ""}\`` : "");
const fence = (diagram: string) => "```mermaid\n" + diagram.split("\n").filter((l) => !l.startsWith("%% ")).join("\n").trimEnd() + "\n```";
const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

export function featureMarkdown(model: KnowledgeModel, f: Feature, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const status = statusOf(f.claims);
  const unverified = f.claims.filter(isUnverified).length;
  const edges = new Map(activeEdges(f).map((e) => [e.id, e]));
  const out = [
    `<!-- ${m.header} -->`,
    `# ${md(n.feature(f))}`,
    "",
    `- ${m.statusLabel}: **${m.status[status]}**${unverified ? ` — ${m.unverified(unverified)}` : ""}`,
    `- ${m.group}: \`${f.group}\` · \`${f.id}\``,
    `- ${m.owner}: ${f.owner ?? m.noOwner}`,
    "",
    f.description[lang] ? md(f.description[lang]) : `_${m.noDescription}_`,
    "",
    `## ${m.triggers}`,
    "",
    ...f.triggers.map((t) => `- \`${t.technicalName}\`${loc(t.evidence)}`),
    "",
    `## ${m.flow}`,
    "",
    ...f.steps.flatMap((s) => {
      const e = s.edgeId ? edges.get(s.edgeId) : undefined;
      if (!e) return [];
      const from = e.from.type === "TRIGGER" ? f.triggers.find((t) => t.id === e.from.id)?.technicalName ?? e.from.id : e.from.type === "SINK" ? n.sink(e.from.id) : n.component(e.from.id);
      const to = e.to.type === "SINK" ? n.sink(e.to.id) : n.component(e.to.id);
      return [`${s.order}. ${md(from)} ${m.edges[e.kind] ?? e.kind} **${md(to)}** (\`${e.label}\`)${e.origin === "INFERRED" ? ` ${m.inferredMark}` : ""}${loc(e.evidence)}`];
    }),
    "",
    fence(flowDiagram(model, f, lang)),
    "",
    `## ${m.sinks}`,
    "",
    ...f.sinkIds.map((id) => `- ${m.sinkKinds[n.sinkKind(id)] ?? ""} **${md(n.sink(id))}**`),
  ];
  if (f.breaks.length) {
    out.push("", `## ${m.breaks}`, "", ...f.breaks.map((b) => `- ${m.breakReasons[b.reason] ?? b.reason}: \`${b.componentId.split(".").pop()}.${b.method}\`${b.detail ? ` ${md(b.detail)}` : ""}${loc(b.evidence)}`));
  }
  return out.join("\n") + "\n";
}

export function serviceMarkdown(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const out = [
    `<!-- ${m.header} -->`,
    `# ${md(m.serviceTitle(model.service.name))}`,
    "",
    model.service.lastAnalyzedCommit ? m.commit(model.service.lastAnalyzedCommit) : "",
    "",
    `## ${m.features}`,
    "",
    `| ${m.feature} | ${m.group} | ${m.statusLabel} |`,
    "|---|---|---|",
    ...model.features.map((f) => `| [${md(n.feature(f))}](features/${f.id}/README.md) | \`${f.group}\` | ${m.status[statusOf(f.claims)]} |`),
    "",
    `## ${m.diagrams}`,
    "",
    `### ${m.contextDiagram}`,
    "",
    fence(contextDiagram(model, lang)),
    "",
    `### ${m.componentsDiagram}`,
    "",
    fence(componentsDiagram(model, lang)),
  ];
  return out.join("\n") + "\n";
}

export const markdownRenderer: Renderer = {
  id: "markdown",
  render(model, view) {
    return [
      { relativePath: "README.md", content: serviceMarkdown(model, view.language) },
      ...model.features.map((f) => ({ relativePath: `features/${f.id}/README.md`, content: featureMarkdown(model, f, view.language) })),
    ];
  },
};
