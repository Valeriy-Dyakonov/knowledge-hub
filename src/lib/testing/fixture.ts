// Shared by tests: the fixture service as scanned by the Rust extractor, and the TS stages 2-5 applied to it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KnowledgeModel, ScanResult } from "../../types";
import { assemble } from "../stages/assemble";
import { discover } from "../stages/discover";
import { Tracer } from "../stages/trace";
import type { Descriptions, RunContext, RunState } from "../stages/types";

export const root = resolve(__dirname, "../../../src-tauri/tests/fixtures");
export const scan = JSON.parse(readFileSync(resolve(root, "refunds-service.scan.json"), "utf8")) as ScanResult;

export function analyse(s: ScanResult, previous: KnowledgeModel | null = null, descriptions?: Descriptions): KnowledgeModel {
  const candidates = discover(s.facts, s.context, previous);
  const tracer = new Tracer(s.facts, s.context);
  const traced = candidates.map((c) => tracer.trace(c));
  const state: RunState = {
    scan: s,
    candidates,
    traced: traced.map(({ candidate, feature }) => ({ candidate, feature })),
    catalogComponents: tracer.catalogComponents(),
    catalogSinks: [...new Map(traced.flatMap((t) => t.sinks).map((x) => [x.id, x])).values()],
    descriptions,
  };
  const ctx = {
    options: { serviceId: "refunds", serviceName: "Refunds", repoPath: "/repo", language: "ru", describe: false },
    state,
    previous,
    versions: { "extractor.kotlin-spring": "0.1.0" },
  } as unknown as RunContext;
  return assemble(ctx);
}

