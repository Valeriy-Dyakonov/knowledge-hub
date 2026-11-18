import { errorInfo } from "./errors";
import type { RunContext } from "./stages/types";

export type StepOutcome<T> = { status: "done"; value: T } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

/**
 * The single error policy for stages, renderers and indexers (like `sourceStep` in worklog-tracker):
 * a skipped step logs its reason, a failed required step stops the run, a failed optional step becomes a warning.
 */
export async function runStep<T>(
  ctx: RunContext,
  kind: string,
  id: string,
  required: boolean,
  skipReason: string | null,
  fn: () => Promise<T>,
): Promise<StepOutcome<T>> {
  if (skipReason) {
    ctx.log("info", "stepSkipped", { kind, id, reason: skipReason });
    return { status: "skipped", reason: skipReason };
  }
  try {
    const value = await fn();
    ctx.log("ok", "stepDone", { kind, id });
    return { status: "done", value };
  } catch (e) {
    const { code, params } = errorInfo(e);
    if (required) {
      ctx.log("error", code, { ...params, id });
      throw e;
    }
    ctx.warn(code, { ...params, id });
    return { status: "failed", code };
  }
}
