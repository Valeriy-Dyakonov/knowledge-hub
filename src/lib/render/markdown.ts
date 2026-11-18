import { messagesFor } from "../../i18n";
import type { Evidence, Feature, KnowledgeModel } from "../../types";
import { isUnverified } from "../model/claims";
import { statusOf } from "../model/status";
import { flowSteps } from "../model/flow";
import { componentsDiagram, contextDiagram, featureMapDiagram, flowDiagram } from "./mermaid";
import { namer } from "./names";
import type { Renderer } from "./types";

const loc = (e?: Evidence) => (e ? ` — \`${e.path}${e.lines ? `:${e.lines.start}` : ""}\`` : "");
const fence = (diagram: string) => "```mermaid\n" + diagram.split("\n").filter((l) => !l.startsWith("%% ")).join("\n").trimEnd() + "\n```";
const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

export function featureMarkdown(model: KnowledgeModel, f: Feature, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const status = statusOf(f.claims);
  const unverified = f.claims.filter(isUnverified).length;
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
    ...flowSteps(model, f).map((s, i) => {
      const from = s.from.type === "TRIGGER" ? f.triggers.find((t) => t.id === s.from.id)?.technicalName ?? s.from.id : s.from.type === "SINK" ? n.sink(s.from.id) : n.component(s.from.id);
      const to = s.to.type === "SINK" ? n.sink(s.to.id) : n.component(s.to.id);
      const via = s.via ? ` ${m.via(n.component(s.via.componentId))}` : "";
      return `${i + 1}. ${md(from)} ${m.edges[s.kind] ?? s.kind} **${md(to)}** (\`${s.label}\`)${via}${s.origin === "INFERRED" ? ` ${m.inferredMark}` : ""}${loc(s.evidence)}`;
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
    `### ${m.featureMapDiagram}`,
    "",
    fence(featureMapDiagram(model, lang)),
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
