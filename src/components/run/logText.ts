import { t } from "../../i18n";
import type { LogEntry } from "../../types";

/** Words a log entry: run codes first, then error codes, then the raw code. */
export function logText(e: LogEntry): string {
  const m = t();
  const params = { ...(e.params ?? {}) };
  if (params.reason) params.reason = m.run.reasons[params.reason] ?? params.reason;
  if (params.id) params.id = m.run.stages[params.id] ?? params.id;
  const run = m.run.codes[e.code];
  if (run) return run(params);
  const err = m.errors.codes[e.code];
  if (err) return err(params);
  const extra = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ");
  return extra ? `${e.code}: ${extra}` : e.code;
}
