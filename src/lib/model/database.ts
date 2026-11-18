import type { ContextFacts, Datasource, DatabaseInfo, Sink, SourceFacts, TableInfo } from "../../types";

/** `jdbc:postgresql://db:5432/refunds?ssl=true` -> postgresql, db:5432, refunds. Credentials never kept. */
export function parseDatasource(property: string, url: string, profile?: string): Datasource {
  const noCreds = url.replace(/\/\/[^/@]*@/, "//");
  const m = /^(?:jdbc:)?([\w:+-]+?):(?:\/\/([^/;?]+))?\/?([^;?]*)/.exec(noCreds.replace(/^jdbc:/, ""));
  const kind = (m?.[1] ?? "unknown").split(":")[0];
  return { property, profile, kind, host: m?.[2] || undefined, database: m?.[3] || undefined, url: noCreds };
}

const DATASOURCE_KEY = /(^|\.)(datasource\.(url|jdbc-url)|r2dbc\.url|mongodb\.uri|flyway\.url|liquibase\.url)$/;

/**
 * The database as the hub knows it: tables from migrations (authoritative structure) completed by JPA entities
 * (mapping and relations; the only source when there are no migrations), plus tables only seen in code.
 */
export function buildDatabase(facts: SourceFacts, context: ContextFacts, sinks: Sink[]): DatabaseInfo {
  const tables = new Map<string, TableInfo>();
  for (const t of context.schema ?? []) {
    tables.set(t.name.toLowerCase(), { name: t.name, columns: t.columns.map((c) => ({ ...c })), source: "migration", evidence: t.evidence });
  }
  const entityTable = new Map((facts.entities ?? []).map((e) => [e.id, e.table.toLowerCase()]));
  for (const e of facts.entities ?? []) {
    const name = e.table.toLowerCase();
    const known = tables.get(name);
    const t: TableInfo = known ?? { name, columns: [], source: "entity", evidence: e.evidence };
    if (known) t.source = "both";
    t.entity = e.id;
    for (const c of e.columns) {
      const ref = c.referencesEntity ? entityTable.get(c.referencesEntity) : undefined;
      const col = t.columns.find((x) => x.name === c.column.toLowerCase());
      if (col) {
        col.field = c.field;
        if (!col.references && ref) col.references = { table: ref, column: "id" };
      } else if (!known) {
        t.columns.push({ name: c.column.toLowerCase(), dataType: c.kotlinType, nullable: c.nullable, primaryKey: c.primaryKey, field: c.field, references: ref ? { table: ref, column: "id" } : undefined });
      }
    }
    tables.set(name, t);
  }
  for (const s of sinks.filter((x) => x.kind === "DB_TABLE")) {
    const name = s.technicalName.toLowerCase();
    if (!tables.has(name)) tables.set(name, { name, columns: [], source: "code" });
  }

  const datasources: Datasource[] = [];
  for (const [k, v] of Object.entries(context.properties)) if (DATASOURCE_KEY.test(k) && v) datasources.push(parseDatasource(k, v));
  for (const [p, values] of Object.entries(context.profiles ?? {})) {
    for (const [k, v] of Object.entries(values)) if (DATASOURCE_KEY.test(k) && v) datasources.push(parseDatasource(k, v, p));
  }
  return { datasources, tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
