// Secrets never leave the process: text going to the LLM is redacted here (the Rust side masks configuration values).
const MASK = "***";

const PATTERNS: [RegExp, string][] = [
  [/((?:password|passwd|pwd|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credentials?)[\w.-]*\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi, `$1$2${MASK}$2`],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/sk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/glpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/AKIA[0-9A-Z]{16}/g, MASK],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/(:\/\/[^/:@\s]+:)[^@\s]+(@)/g, `$1${MASK}$2`],
];

export function redact(text: string): string {
  return PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), text);
}
