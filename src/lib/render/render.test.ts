// @vitest-environment jsdom
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import { messagesFor } from "../../i18n";
import type { Feature, KnowledgeModel } from "../../types";
import { mergeModels } from "../model/merge";
import { reject } from "../model/claims";
import { analyse, scan } from "../testing/fixture";
import { RENDERERS } from ".";
import { columns, componentsDiagram, contextDiagram, featureMapDiagram, flowDiagram, MAX_NODES } from "./mermaid";

const descriptions = {
  language: "ru",
  features: { "refunds/create-refund": { name: "Создание возврата", description: "Клиент создаёт возврат; он сохраняется и резервируется в платежах." } },
  components: { "com.example.refunds.service.RefundService": "Сервис возвратов" },
  sinks: { "db_table:refunds": "Возвраты" },
};
const model = mergeModels(null, analyse(scan, null, descriptions));
const render = (m: KnowledgeModel, lang = "ru") => RENDERERS.flatMap((r) => r.render(m, { language: lang }));
const nodeCount = (diagram: string) => diagram.split("\n").filter((l) => /^\s+n\d+[[({/]/.test(l)).length;

describe("renderers", () => {
  it("match the golden output for the fixture service", () => {
    const actual = render(model).map((f) => `=== ${f.relativePath}\n${f.content}`).join("\n");
    const golden = resolve(__dirname, "../stages/__golden__/refunds-service.render.txt");
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, actual);
    expect(actual).toBe(readFileSync(golden, "utf8").replace(/\r\n/g, "\n"));
  });

  it("write the generated header into every file", () => {
    for (const lang of ["ru", "en"]) {
      for (const f of render(model, lang)) expect(f.content).toContain(messagesFor(lang).render.header);
    }
  });

  it("produce diagrams that Mermaid parses", async () => {
    const diagrams = render(model).filter((f) => f.relativePath.endsWith(".mmd"));
    expect(diagrams.length).toBe(3 + model.features.length);
    for (const d of diagrams) await expect(mermaid.parse(d.content), d.relativePath).resolves.toBeTruthy();
  });

  it("are deterministic and cope with an empty model", () => {
    expect(render(model)).toEqual(render(model));
    const empty: KnowledgeModel = { ...model, features: [], catalog: { components: [], sinks: [], claims: [] } };
    expect(() => render(empty)).not.toThrow();
  });

  it("use business names when they exist", () => {
    const create = model.features.find((f) => f.id === "refunds/create-refund")!;
    expect(flowDiagram(model, create, "ru")).toContain("Сервис возвратов");
    expect(flowDiagram(model, create, "ru")).toContain("таблица Возвраты");
  });

  it("leave rejected edges out of the views", () => {
    const create = model.features.find((f) => f.id === "refunds/create-refund")!;
    const http = create.edges.find((e) => e.kind === "HTTP_CALL")!;
    const without: Feature = { ...create, claims: create.claims.map((c) => (c.id === http.claimId ? reject(c, "ann", "now") : c)) };
    expect(flowDiagram(model, create, "ru")).toContain("payments");
    expect(flowDiagram(model, without, "ru")).not.toContain("payments");
  });

  it("lay out an expanded large group in columns by name prefix, or in an even grid", async () => {
    expect(columns(["refund_a", "refund_b", "refund_c", "payment_a", "payment_b", "audit"], (x) => x)).toEqual([["", ["refund_a", "refund_b", "refund_c", "payment_a", "payment_b", "audit"]]]);
    const named = ["refund_a", "refund_b", "refund_c", "payment_a", "payment_b", "payment_c", "audit"];
    expect(columns(named, (x) => x).map(([t, xs]) => `${t}:${xs.length}`)).toEqual(["refund*:3", "payment*:3", "…:1"]);
    const plain = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
    expect(columns(plain, (x) => x).map(([t, xs]) => `${t}:${xs.length}`)).toEqual([":3", ":3", ":3"]);

    const tables = [...named, "refund_d", "payment_d"];
    const wide: KnowledgeModel = {
      ...model,
      catalog: { ...model.catalog, sinks: tables.map((t) => ({ id: `db_table:${t}`, kind: "DB_TABLE" as const, technicalName: t, businessName: {} })) },
      features: [{
        ...model.features[0], claims: [],
        edges: tables.map((t, i) => ({ id: `w${i}`, from: { type: "COMPONENT" as const, id: "c" }, to: { type: "SINK" as const, id: `db_table:${t}` }, kind: "WRITE" as const, label: "save", origin: "STATIC" as const, confidence: "HIGH" as const })),
      }],
    };
    const collapsedView = contextDiagram(wide, "ru").text;
    expect(collapsedView).toContain("нажмите, чтобы раскрыть");
    const expanded = contextDiagram(wide, "ru", { expand: new Set(["out-db"]) }).text;
    expect(expanded).toContain('["refund*"]');
    expect(expanded).toContain('["payment*"]');
    await expect(mermaid.parse(expanded)).resolves.toBeTruthy();

    // No common prefixes: an even grid of invisible columns.
    const gridModel: KnowledgeModel = {
      ...wide,
      catalog: { ...wide.catalog, sinks: plain.map((t) => ({ id: `db_table:${t}`, kind: "DB_TABLE" as const, technicalName: t, businessName: {} })) },
      features: [{ ...wide.features[0], edges: plain.map((t, i) => ({ ...wide.features[0].edges[0], id: `p${i}`, to: { type: "SINK" as const, id: `db_table:${t}` } })) }],
    };
    const grid = contextDiagram(gridModel, "ru", { expand: new Set(["out-db"]) }).text;
    expect(grid).toContain("fill:transparent,stroke:transparent");
    await expect(mermaid.parse(grid)).resolves.toBeTruthy();
  });

  it("keep L1 and L2 within the node limit by grouping", async () => {
    // 30 features, each writing its own table and calling its own service: far beyond 12 nodes.
    const big: KnowledgeModel = {
      ...model,
      catalog: {
        components: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, kind: "SERVICE" as const, technicalName: `S${i}`, businessName: {} })),
        sinks: Array.from({ length: 30 }, (_, i) => ({ id: `db_table:t${i}`, kind: "DB_TABLE" as const, technicalName: `t${i}`, businessName: {} })),
        claims: [],
      },
      features: Array.from({ length: 30 }, (_, i): Feature => ({
        ...model.features[0], id: `g/f${i}`, claims: [],
        edges: [
          { id: `a${i}`, from: { type: "COMPONENT", id: "c" }, to: { type: "COMPONENT", id: `s${i}` }, kind: "CALL", label: "x", origin: "STATIC", confidence: "HIGH" },
          { id: `b${i}`, from: { type: "COMPONENT", id: `s${i}` }, to: { type: "SINK", id: `db_table:t${i}` }, kind: "WRITE", label: "save", origin: "STATIC", confidence: "HIGH" },
        ],
      })),
    };
    for (const d of [contextDiagram(big, "ru").text, featureMapDiagram(big, "ru").text, componentsDiagram(big, "ru").text]) {
      expect(nodeCount(d)).toBeLessThanOrEqual(MAX_NODES);
      await expect(mermaid.parse(d)).resolves.toBeTruthy();
    }
  });
});
