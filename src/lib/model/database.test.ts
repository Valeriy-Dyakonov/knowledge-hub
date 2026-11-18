import { describe, expect, it } from "vitest";
import { analyse, scan } from "../testing/fixture";
import { erNeighbourhood } from "../render/reference";
import { parseDatasource } from "./database";
import { tableUsage } from "./usage";

const model = analyse(scan);

describe("database", () => {
  it("merges migrations with entities", () => {
    const db = model.database!;
    expect(db.tables.map((t) => `${t.name}:${t.source}`)).toEqual(["audit_log:migration", "refund_items:both", "refunds:both"]);
    const items = db.tables.find((t) => t.name === "refund_items")!;
    expect(items.entity).toBe("com.example.refunds.persistence.RefundItemEntity");
    const ref = items.columns.find((c) => c.name === "refund_id")!;
    expect(ref.references).toEqual({ table: "refunds", column: "id" });
    expect(ref.field).toBe("refund");
    expect(items.columns.find((c) => c.name === "sku")!.field).toBe("stockKeepingUnit");
    const refunds = db.tables.find((t) => t.name === "refunds")!;
    expect(refunds.columns.map((c) => c.name)).toEqual(["id", "amount", "status", "refund_reason", "created_at"]);
    expect(refunds.evidence?.path).toContain("V1__init.sql");
  });

  it("describes the datasource without credentials", () => {
    expect(model.database!.datasources[0]).toMatchObject({ kind: "postgresql", host: "db:5432", database: "refunds" });
    expect(parseDatasource("x", "jdbc:postgresql://user:pw@h:5432/app?ssl=true").url).not.toContain("pw");
    expect(parseDatasource("x", "mongodb://u:p@m1:27017/docs")).toMatchObject({ kind: "mongodb", host: "m1:27017", database: "docs" });
  });
});

describe("table views", () => {
  it("draw a table with its foreign-key neighbours and list the features using it", () => {
    expect(erNeighbourhood(model.database!, "refund_items").map((t) => t.name)).toEqual(["refunds", "refund_items"].sort());
    expect(erNeighbourhood(model.database!, "refunds").map((t) => t.name)).toEqual(["audit_log", "refund_items", "refunds"]);
    const create = tableUsage(model, "refunds").find((u) => u.feature.id === "refunds/create-refund")!;
    expect(create.writes).toBe(true);
  });
});

describe("configuration", () => {
  const props = new Map(model.config!.properties.map((p) => [p.key, p]));

  it("shows values per profile and who reads them", () => {
    expect(model.config!.profiles).toEqual(["prod"]);
    const topic = props.get("payments.topics.completed")!;
    expect(topic.value).toBe("payments.completed");
    expect(topic.profiles.prod).toBe("prod.payments.completed");
    expect(topic.usages.map((u) => `${u.componentId.split(".").pop()}.${u.method}:${u.kind}`)).toEqual(["PaymentEventsConsumer.onPaymentCompleted:annotation"]);
    expect(topic.source).toContain("application.yml:");
  });

  it("attaches @ConfigurationProperties prefixes to every property under them", () => {
    const max = props.get("refunds.limits.max-amount")!;
    expect(max.profiles.prod).toBe("100000");
    expect(max.usages.map((u) => u.componentId.split(".").pop()).sort()).toEqual(["ReconciliationJob", "RefundLimits"]);
  });

  it("flags properties read by code but defined nowhere", () => {
    expect(props.get("refunds.region")!.missing).toBe(true);
    expect(props.get("refunds.reconciliation.cron")!.missing).toBe(false); // has a default
    expect(props.get("spring.datasource.password")!.secret).toBe(true);
  });
});
