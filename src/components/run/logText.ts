import { t } from "../../i18n";
import type { Activity } from "../../lib/stages";
import type { LogEntry } from "../../types";

/** Words a journal entry: run codes first, then error codes, then the raw code with its params. */
export function logText(e: LogEntry): string {
  const m = t();
  const params = { ...(e.params ?? {}) };
  if (e.code === "featureFound" && params.reason) params.reason = m.run.grouping[params.reason] ?? params.reason;
  else if (params.reason) params.reason = m.run.reasons[params.reason] ?? params.reason;
  if ((e.code === "stepDone" || e.code === "stepSkipped") && params.kind === "stage") params.id = m.run.stages[params.id] ?? params.id;
  if (e.code === "featureTraced") {
    // "db_table:refunds" -> "таблица refunds"; break codes -> short reasons.
    params.sinks = (params.sinks ?? "").split(", ").map((s) => {
      const i = s.indexOf(":");
      return i > 0 ? `${m.render.sinkKinds[s.slice(0, i).toUpperCase()] ?? s.slice(0, i)} ${s.slice(i + 1)}` : s;
    }).join(", ");
    params.breaks = (params.breaks ?? "").split(", ").map((b) => m.render.breakReasons[b] ?? b).join(", ");
  }
  const run = m.run.codes[e.code];
  if (run) return run(params);
  const err = m.errors.codes[e.code];
  if (err) return err(params);
  const extra = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ");
  return extra ? `${e.code}: ${extra}` : e.code;
}

export function activityText(a: Activity): string {
  const f = t().run.activity[a.code];
  return f ? f(a.params ?? {}) : a.code;
}

/** "14:03:27" in local time. */
export const clock = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};
