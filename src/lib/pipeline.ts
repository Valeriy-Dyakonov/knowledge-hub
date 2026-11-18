import type { Backend } from "../api";
import type { KnowledgeModel, LogEntry, LogLevel, RunOptions, RunRecord } from "../types";
import { errorInfo, HubError } from "./errors";
import { STAGES, type RunContext, type RunState, type Stage } from "./stages";
import { runStep } from "./steps";

export interface RunHandlers {
  onLog?(entry: LogEntry): void;
  onRun?(run: RunRecord): void;
}

export interface PipelineDeps {
  backend: Backend;
  stages?: Stage[];
  now?: () => string;
}

const nowIso = () => new Date().toISOString();

function newRunId(now: string): string {
  return `run-${now.replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Starts a new analysis run: scan -> discover -> trace -> describe -> assemble -> render -> index. */
export async function runAnalysis(options: RunOptions, deps: PipelineDeps, h: RunHandlers = {}): Promise<RunRecord> {
  const now = deps.now ?? nowIso;
  const repo = await deps.backend.inspectRepo(options.repoPath);
  const startedAt = now();
  const run: RunRecord = {
    id: newRunId(startedAt),
    options,
    commit: repo.commit,
    branch: repo.branch,
    status: "RUNNING",
    completedStages: [],
    versions: {},
    startedAt,
  };
  await deps.backend.saveRun(run);
  return execute(run, {}, deps, h);
}

/** Continues a failed run from its first unfinished stage, using the saved checkpoint. */
export async function resumeRun(run: RunRecord, deps: PipelineDeps, h: RunHandlers = {}): Promise<RunRecord> {
  if (run.status === "COMPLETED") throw new HubError("runAlreadyCompleted", { runId: run.id });
  const state = ((await deps.backend.loadCheckpoint(run.options.serviceId, run.id)) ?? {}) as RunState;
  const resumed: RunRecord = { ...run, status: "RUNNING", error: undefined, finishedAt: undefined };
  await deps.backend.saveRun(resumed);
  return execute(resumed, state, deps, h);
}

/** Orchestration only: no parsing and no LLM calls here. Each stage's result is checkpointed. */
async function execute(initial: RunRecord, state: RunState, deps: PipelineDeps, h: RunHandlers): Promise<RunRecord> {
  const { backend } = deps;
  const now = deps.now ?? nowIso;
  const stages = deps.stages ?? STAGES;
  const serviceId = initial.options.serviceId;
  let run = initial;
  let stage: string | undefined;
  const pending: LogEntry[] = [];

  const log = (level: LogLevel, code: string, params?: Record<string, string>) => {
    const entry: LogEntry = { at: now(), level, stage, code, params };
    pending.push(entry);
    h.onLog?.(entry);
  };
  const flush = async () => {
    if (!pending.length) return;
    await backend.appendRunLog(serviceId, run.id, pending.splice(0));
  };
  const save = async (r: RunRecord) => {
    run = r;
    await backend.saveRun(r);
    h.onRun?.(r);
  };

  const warnings: LogEntry[] = [];
  const previous: KnowledgeModel | null = await backend.loadModel(serviceId);
  const ctx: RunContext = {
    get run() { return run; },
    options: run.options,
    backend,
    state,
    previous,
    versions: { ...run.versions },
    warnings,
    log,
    warn(code, params) {
      log("warn", code, params);
      warnings.push({ at: now(), level: "warn", stage, code, params });
    },
    now,
  };

  log("info", "runStarted", { runId: run.id, commit: run.commit, resumedAfter: run.completedStages.join(", ") });
  for (const s of stages) {
    if (run.completedStages.includes(s.id)) continue;
    stage = s.id;
    try {
      await runStep(ctx, "stage", s.id, s.required, s.skipReason?.(ctx) ?? null, () => s.run(ctx));
    } catch (e) {
      const { code, params } = errorInfo(e);
      await backend.saveCheckpoint(serviceId, run.id, state);
      await flush();
      await save({ ...run, status: "FAILED", versions: { ...ctx.versions }, finishedAt: now(), error: { code, params } });
      throw e;
    }
    await backend.saveCheckpoint(serviceId, run.id, state);
    await flush();
    await save({ ...run, completedStages: [...run.completedStages, s.id], versions: { ...ctx.versions } });
  }
  stage = undefined;
  log("ok", "runCompleted", { runId: run.id, features: String(state.model?.features.length ?? 0) });
  await flush();
  await save({ ...run, status: "COMPLETED", finishedAt: now() });
  return run;
}
