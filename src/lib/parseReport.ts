import { t } from "../i18n";
import { redact } from "./redact";

export interface ParseProblem { file: string; detail: string }

/** "line 12: `companion object { … }`; line 15: `…`" (written by the Rust extractor) -> [[12, "companion…"], …]. */
export function parseDetail(detail: string): [number, string][] {
  return [...detail.matchAll(/line (\d+): `([^`]*)`/g)].map((m) => [Number(m[1]), m[2]]);
}

const CONTEXT = 4;

/**
 * A ready-to-paste message for a chat with a developer or an AI assistant: what the extractor could not parse,
 * the code around it (secrets redacted) and where the parser lives — enough to reproduce and fix the grammar gap.
 */
export async function parseReport(
  problems: ParseProblem[],
  readFile: (path: string) => Promise<string>,
  meta: { extractor: string; version?: string; commit?: string },
): Promise<string> {
  const m = t().run.parseReport;
  const out = [...m.intro(meta.extractor, meta.version ?? "", meta.commit?.slice(0, 7) ?? "?"), ""];
  for (const p of problems.slice(0, 10)) {
    const errors = parseDetail(p.detail);
    out.push(`## ${p.file}`, "", m.lines(errors.map(([l, near]) => `${l} (\`${near}\`)`).join(", ") || p.detail), "");
    let text: string;
    try {
      text = await readFile(p.file);
    } catch {
      out.push(m.unreadable, "");
      continue;
    }
    const lines = text.split(/\r?\n/);
    const marked = new Set(errors.map(([l]) => l));
    // Nearby errors share one fragment.
    const windows: [number, number][] = [];
    for (const [l] of errors.slice(0, 5)) {
      const from = Math.max(1, l - CONTEXT);
      const to = Math.min(lines.length, l + CONTEXT);
      const last = windows[windows.length - 1];
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else windows.push([from, to]);
    }
    for (const [from, to] of windows) {
      out.push("```kotlin");
      for (let n = from; n <= to; n++) out.push(`${marked.has(n) ? ">>" : "  "}${String(n).padStart(5)} | ${redact(lines[n - 1] ?? "")}`);
      out.push("```", "");
    }
  }
  if (problems.length > 10) out.push(m.more(problems.length - 10));
  return out.join("\n");
}
