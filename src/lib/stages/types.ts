import type { Backend } from "../../api";
import type { Component, Feature, KnowledgeModel, LogEntry, LogLevel, RunOptions, RunRecord, ScanResult, Sink, Trigger } from "../../types";

/** Output of Discover: one entry point grouped into a candidate feature. */
export interface FeatureCandidate {
  id: string;
  group: string;
  technicalName: string;
  triggers: Trigger[];
  /** Why this grouping was chosen: openApiTag | path | class | previousModel. */
  groupingReason: string;
}

export interface FeatureDescription { name: string; description: string }

/** Business names produced by Describe, in `language`. Keys are feature/component/sink ids. */
export interface Descriptions {
  language: string;
  features: Record<string, FeatureDescription>;
  components: Record<string, string>;
  sinks: Record<string, string>;
}

/** Everything stages accumulate; saved as a checkpoint after each stage so a failed run resumes. */
export interface RunState {
  scan?: ScanResult;
  candidates?: FeatureCandidate[];
  traced?: { candidate: FeatureCandidate; feature: Feature }[];
  catalogComponents?: Component[];
  catalogSinks?: Sink[];
  descriptions?: Descriptions;
  model?: KnowledgeModel;
}

/** Shared state of one analysis run, handed to every stage. */
export interface RunContext {
  readonly run: RunRecord;
  readonly options: RunOptions;
  readonly backend: Backend;
  readonly state: RunState;
  /** The reviewed model saved before this run, if any. */
  readonly previous: KnowledgeModel | null;
  readonly versions: Record<string, string>;
  readonly warnings: LogEntry[];
  log(level: LogLevel, code: string, params?: Record<string, string>): void;
  warn(code: string, params?: Record<string, string>): void;
  now(): string;
}

export interface Stage {
  readonly id: string;
  /** A failed required stage stops the run; an optional one becomes a warning. */
  readonly required: boolean;
  /** Reason code when the stage should be skipped, or null to run it. */
  skipReason?(ctx: RunContext): string | null;
  run(ctx: RunContext): Promise<void>;
}
