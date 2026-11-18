import { describe, expect, it } from "vitest";
import type { Backend } from "../api";
import type { KnowledgeModel, LogEntry, RunOptions, RunRecord } from "../types";
import { HubError } from "./errors";
import { describeRun, resumeRun, runAnalysis } from "./pipeline";
import type { Stage } from "./stages";

function fakeBackend() {
  const runs: RunRecord[] = [];
  const checkpoints = new Map<string, unknown>();
  const logs: LogEntry[] = [];
  let model: KnowledgeModel | null = null;
  const backend: Backend = {
    inspectRepo: async (path) => ({ path, name: "svc", commit: "abc1234", branch: "main" }),
    scanRepo: async () => { throw new Error("not used"); },
    loadModel: async () => model,
    saveModel: async (_, m) => { model = m; },
    writeGenerated: async () => {},
    saveRun: async (r) => { runs.push(r); },
    saveCheckpoint: async (_, id, s) => { checkpoints.set(id, JSON.parse(JSON.stringify(s))); },
    loadCheckpoint: async (_, id) => checkpoints.get(id) ?? null,
    appendRunLog: async (_, __, e) => { logs.push(...e); },
    indexService: async () => 0,
    llmChat: async () => "{}",
  };
  return { backend, runs, logs, checkpoints };
}

const options: RunOptions = { serviceId: "svc", serviceName: "Service", repoPath: "/repo", language: "ru", describe: false };

const stage = (id: string, run: Stage["run"], required = true): Stage => ({ id, required, run });

describe("runAnalysis", () => {
  it("runs stages in order and completes", async () => {
    const f = fakeBackend();
    const order: string[] = [];
    const stages = ["a", "b", "c"].map((id) => stage(id, async () => { order.push(id); }));
    const run = await runAnalysis(options, { backend: f.backend, stages });
    expect(order).toEqual(["a", "b", "c"]);
    expect(run.status).toBe("COMPLETED");
    expect(run.completedStages).toEqual(["a", "b", "c"]);
    expect(f.logs.map((l) => l.code)).toContain("runCompleted");
  });

  it("logs a skip reason and does not run a skipped stage", async () => {
    const f = fakeBackend();
    let ran = false;
    const skipped: Stage = { id: "x", required: true, skipReason: () => "disabledByOption", run: async () => { ran = true; } };
    await runAnalysis(options, { backend: f.backend, stages: [skipped] });
    expect(ran).toBe(false);
    expect(f.logs.find((l) => l.code === "stepSkipped")?.params?.reason).toBe("disabledByOption");
  });

  it("turns a failed optional stage into a warning", async () => {
    const f = fakeBackend();
    const stages = [stage("opt", async () => { throw new HubError("llmUnavailable"); }, false), stage("b", async () => {})];
    const run = await runAnalysis(options, { backend: f.backend, stages });
    expect(run.status).toBe("COMPLETED");
    expect(f.logs.some((l) => l.level === "warn" && l.code === "llmUnavailable")).toBe(true);
  });

  it("fails on a required stage and resumes from it with the checkpoint", async () => {
    const f = fakeBackend();
    let fail = true;
    const seen: unknown[] = [];
    const stages: Stage[] = [
      stage("a", async (ctx) => { ctx.state.candidates = []; }),
      stage("b", async (ctx) => {
        seen.push(ctx.state.candidates);
        if (fail) throw new HubError("stageFailed", { id: "b" });
      }),
    ];
    await expect(runAnalysis(options, { backend: f.backend, stages })).rejects.toThrow("stageFailed");
    const failed = f.runs[f.runs.length - 1];
    expect(failed.status).toBe("FAILED");
    expect(failed.error?.code).toBe("stageFailed");
    expect(failed.completedStages).toEqual(["a"]);

    fail = false;
    const resumed = await resumeRun(failed, { backend: f.backend, stages });
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.completedStages).toEqual(["a", "b"]);
    expect(seen[1]).toEqual([]); // state of stage "a" came from the checkpoint
  });

  it("describes the result of a finished static run without scanning again", async () => {
    const f = fakeBackend();
    const ran: string[] = [];
    const stages: Stage[] = ["scan", "discover", "trace", "describe", "assemble"].map((id) =>
      stage(id, async (ctx) => {
        ran.push(id);
        if (id === "trace") ctx.state.traced = [];
      }));
    const base = await runAnalysis({ ...options, mode: "static" }, { backend: f.backend, stages });
    ran.length = 0;
    const llm = await describeRun(base, { language: "ru" }, { backend: f.backend, stages });
    expect(ran).toEqual(["describe", "assemble"]);
    expect(llm).toMatchObject({ status: "COMPLETED", basedOn: base.id, commit: base.commit });
    expect(llm.options).toMatchObject({ mode: "llm", describe: true });
    expect(f.logs.some((l) => l.code === "runBasedOn" && l.params?.basedOn === base.id)).toBe(true);
    await expect(describeRun({ ...base, status: "FAILED" }, { language: "ru" }, { backend: f.backend, stages })).rejects.toThrow("baseRunNotCompleted");
  });
});
