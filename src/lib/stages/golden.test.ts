// Golden test of Discover -> Trace -> Assemble on the real extractor output for the fixture service
// (src-tauri/tests/fixtures/refunds-service.scan.json, produced by the Rust scan test).
// After an intended change: `UPDATE_GOLDEN=1 npm test`, then review the diff of refunds-service.features.txt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend } from "../../api";
import type { KnowledgeModel } from "../../types";
import { confirm } from "../model/claims";
import { mergeModels } from "../model/merge";
import { runAnalysis } from "../pipeline";
import { simpleName } from "../model/ids";

import { analyse, root, scan } from "../testing/fixture";

const short = (id: string) => (id.includes(":") ? id : simpleName(id));

function summary(m: KnowledgeModel): string {
  const out: string[] = [];
  for (const f of m.features) {
    out.push(`FEATURE ${f.id} group=${f.group} owner=${f.owner ?? "-"} :: ${f.technicalName}`);
    const edges = new Map(f.edges.map((e) => [e.id, e]));
    for (const s of f.steps) {
      const e = s.edgeId ? edges.get(s.edgeId) : undefined;
      out.push(`  STEP ${s.order} ${simpleName(s.componentId)}.${s.action}${e ? ` [${short(e.from.id)} -${e.kind}-> ${short(e.to.id)} ${e.origin}/${e.confidence}]` : ""}`);
    }
    for (const e of f.edges.filter((x) => x.kind === "CONSUME")) out.push(`  CONSUME ${e.from.id} -> ${simpleName(e.to.id)}`);
    for (const id of f.sinkIds) out.push(`  SINK ${id}`);
    for (const b of f.breaks) out.push(`  BREAK ${b.reason} ${simpleName(b.componentId)}.${b.method} ${b.detail}`);
    const kinds = new Map<string, number>();
    for (const c of f.claims) kinds.set(`${c.kind}/${c.origin}/${c.confidence}`, (kinds.get(`${c.kind}/${c.origin}/${c.confidence}`) ?? 0) + 1);
    out.push(`  CLAIMS ${[...kinds].sort().map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }
  out.push(`CATALOG components=${m.catalog.components.length} sinks=${m.catalog.sinks.map((s) => s.id).join(",")}`);
  return out.join("\n") + "\n";
}

describe("Discover + Trace + Assemble on the fixture service", () => {
  it("matches the golden file", () => {
    const actual = summary(analyse(scan));
    const golden = resolve(__dirname, "__golden__/refunds-service.features.txt");
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, actual);
    expect(actual).toBe(readFileSync(golden, "utf8").replace(/\r\n/g, "\n"));
  });

  it("writes the model the Rust store must round-trip (src-tauri store contract test)", () => {
    const json = JSON.stringify(mergeModels(null, analyse(scan)), null, 2) + "\n";
    const file = resolve(root, "refunds-service.model.json");
    if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, json);
    expect(json).toBe(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  });

  it("keeps reviews through a full re-run of the pipeline", async () => {
    let saved: KnowledgeModel | null = null;
    const backend: Backend = {
      inspectRepo: async (path) => ({ path, name: "refunds-service", commit: "unknown" }),
      scanRepo: async () => scan,
      loadModel: async () => saved,
      saveModel: async (_, m) => { saved = JSON.parse(JSON.stringify(m)); },
      writeGenerated: async () => {},
      saveRun: async () => {},
      saveCheckpoint: async () => {},
      loadCheckpoint: async () => null,
      appendRunLog: async () => {},
      llmChat: async () => "{}",
    };
    const options = { serviceId: "refunds", serviceName: "Refunds", repoPath: "/repo", language: "ru", describe: false };
    const first = await runAnalysis(options, { backend });
    expect(first.status).toBe("COMPLETED");
    const model = saved as unknown as KnowledgeModel;
    const target = model.features[0].claims[0];
    saved = { ...model, features: model.features.map((f, i) => (i === 0 ? { ...f, claims: f.claims.map((c) => (c.id === target.id ? confirm(c, "ann", "now", "unknown") : c)) } : f)) };

    await runAnalysis(options, { backend });
    const after = saved as unknown as KnowledgeModel;
    const count = (m: KnowledgeModel) => m.features.reduce((n, f) => n + f.claims.length, 0);
    expect(count(after)).toBe(count(model));
    expect(after.features.flatMap((f) => f.claims).find((c) => c.id === target.id)?.status).toBe("CONFIRMED");
  });

  it("produces the same claim ids on a re-run", () => {
    const ids = (m: KnowledgeModel) => m.features.flatMap((f) => f.claims.map((c) => c.id)).sort();
    expect(ids(analyse(scan))).toEqual(ids(analyse(scan)));
  });
});
