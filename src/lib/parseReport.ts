import { t } from "../i18n";
import { redact } from "./redact";

/** One parse error as logged by stage Scan: file and line stay local, context and pattern are anonymous. */
export interface ParseProblem {
  file: string; detail: string; context?: string; pattern?: string; unparsed?: string; first?: boolean;
  /** The grammar dropped a whole `{ … }` body; parsed alone, the body fails here. */
  innerContext?: string; innerPattern?: string;
}

/** A construct the grammar could not parse, with how often and where it occurs. */
export interface ParseConstruct { context: string; pattern: string; unparsed: string; files: string[]; count: number; first: boolean; innerContext?: string; innerPattern?: string }

/** Groups errors by construct (same place in the tree and same anonymised code), most frequent first. */
export function constructs(problems: ParseProblem[]): ParseConstruct[] {
  const by = new Map<string, ParseConstruct>();
  for (const p of problems) {
    const context = p.context ?? "";
    const pattern = p.pattern ?? "";
    const key = `${context}\u0000${pattern}`;
    const c = by.get(key) ?? { context, pattern, unparsed: p.unparsed ?? "", files: [], count: 0, first: false, innerContext: p.innerContext || undefined, innerPattern: p.innerPattern || undefined };
    c.count++;
    c.first ||= !!p.first;
    if (!c.files.includes(p.file)) c.files.push(p.file);
    by.set(key, c);
  }
  // First errors of a file come first: the following ones are often only their consequences.
  return [...by.values()].sort((a, b) => Number(b.first) - Number(a.first) || b.files.length - a.files.length || b.count - a.count);
}

/**
 * A ready-to-paste message for a developer or an AI assistant: which Kotlin constructs the grammar could not parse,
 * as anonymised code (project names, literals and comments replaced) and their place in the syntax tree.
 * No file names, paths, line numbers or commits: it can be shared outside the team.
 */
export function parseReport(problems: ParseProblem[], meta: { extractor: string; version?: string }): string {
  const m = t().run.parseReport;
  const list = constructs(problems);
  const files = new Set(problems.map((p) => p.file)).size;
  const out = [...m.intro(meta.extractor, meta.version ?? "", list.length, files), ""];
  list.slice(0, 15).forEach((c, i) => {
    out.push(m.construct(i + 1, c.files.length, c.count), "", c.first ? m.first : m.consequence, m.context(c.context || "?"), "");
    // The pattern is anonymised in Rust already; redaction is a second line of defence.
    out.push("```kotlin", redact(c.pattern || "?"), "```", "");
    if (c.unparsed) out.push(m.unparsed, "```kotlin", redact(c.unparsed), "```", "");
    if (c.innerPattern) out.push(m.inner, m.context(c.innerContext || "?"), "", "```kotlin", redact(c.innerPattern), "```", "");
  });
  if (list.length > 15) out.push(m.more(list.length - 15));
  return out.join("\n");
}
