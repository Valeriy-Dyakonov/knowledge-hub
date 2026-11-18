import { useSyncExternalStore } from "react";
import type { RunHandlers } from "../../lib/pipeline";
import type { Activity } from "../../lib/stages";
import type { LogEntry, RunRecord } from "../../types";

/**
 * What the analysis screen shows for a service. Lives outside the screen: an analysis keeps running and keeps
 * its log and progress when the user switches tabs or repositories and comes back.
 */
export interface RunView {
  busy: boolean;
  log: LogEntry[];
  stage?: string;
  activity: Activity | null;
  /** Live text from the LLM while a Describe request streams. */
  stream: string;
  current: RunRecord | null;
  error: string;
}

const EMPTY: RunView = { busy: false, log: [], activity: null, stream: "", current: null, error: "" };
const views = new Map<string, RunView>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function update(serviceId: string, patch: Partial<RunView> | ((v: RunView) => Partial<RunView>)) {
  const v = views.get(serviceId) ?? EMPTY;
  views.set(serviceId, { ...v, ...(typeof patch === "function" ? patch(v) : patch) });
  emit();
}

export const useRunView = (serviceId: string): RunView => useSyncExternalStore(subscribe, () => views.get(serviceId) ?? EMPTY);

/** Services with an analysis running now (the navigation shows a spinner). */
export function useRunning(): string[] {
  const key = useSyncExternalStore(subscribe, runningKey);
  return key ? key.split("|") : [];
}
const runningKey = () => [...views.entries()].filter(([, v]) => v.busy).map(([k]) => k).join("|");

/** Shows a finished run (its saved log) when nothing is running. */
export function showRun(serviceId: string, run: RunRecord, log: LogEntry[]) {
  if (views.get(serviceId)?.busy) return;
  update(serviceId, { current: run, log, error: "", activity: null, stream: "" });
}

/** Runs an analysis (new or resumed) for a service; a second start while one runs is ignored. */
export async function startRun(serviceId: string, action: (h: RunHandlers) => Promise<RunRecord>, onDone?: () => void) {
  if (views.get(serviceId)?.busy) return;
  update(serviceId, { busy: true, log: [], error: "", activity: null, stage: undefined, stream: "", current: null });
  const handlers: RunHandlers = {
    onLog: (e) => update(serviceId, (v) => ({ log: [...v.log, e] })),
    onRun: (r) => update(serviceId, { current: r }),
    onProgress: (stage, activity) => update(serviceId, (v) => ({
      stage,
      activity,
      // A new LLM request starts a new live text; other activities keep the last answer visible.
      stream: activity?.code === "llmRequest" ? (activity.stream ?? "") : activity?.code === "llmWaiting" ? v.stream : activity ? "" : v.stream,
    })),
  };
  try {
    await action(handlers);
  } catch (e) {
    update(serviceId, { error: String(e) });
  } finally {
    update(serviceId, { busy: false, activity: null, stream: "" });
    onDone?.();
  }
}
