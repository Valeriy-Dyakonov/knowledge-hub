import { assembleStage } from "./assemble";
import { describeStage } from "./describe";
import { discoverStage } from "./discover";
import { indexStage, renderStage } from "./publish";
import { scanStage } from "./scan";
import { traceStage } from "./trace";
import type { Stage } from "./types";

/** The stages in run order (docs/03-pipeline.md). A new stage is a new file plus an entry here. */
export const STAGES: Stage[] = [scanStage, discoverStage, traceStage, describeStage, assembleStage, renderStage, indexStage];

export type { Activity, FeatureCandidate, RunContext, RunState, Stage } from "./types";
