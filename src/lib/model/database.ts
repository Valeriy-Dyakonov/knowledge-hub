import type { ContextFacts, DataStore, Datasource, DatabaseInfo, Sink, SourceFacts, TableInfo } from "../../types";

/** `jdbc:postgresql://db:5432/refunds?ssl=true` -> postgresql, db:5432, refunds. Credentials never kept. */
export function parseDatasource(property: string, url: string, profile?: string): Datasource {
  const noCreds = url.replace(/\/\/[^/@]*@/, "//");
  const m = /^(?:jdbc:)?([\w:+-]+?):(?:\/\/([^/;?]+))?\/?([^;?]*)/.exec(noCreds.replace(/^jdbc:/, ""));
  const kind = (m?.[1] ?? "unknown").split(":")[0];
  return { property, profile, kind, host: m?.[2] || undefined, database: m?.[3] || undefined, url: noCreds };
}

export const STORE_ORDER: DataStore[] = ["sql", "mongo", "redis", "elasticsearch", "cassandra", "neo4j", "unknown"];

const DATASOURCE_KEY = /(^|\.)(datasource\.(url|jdbc-url)|r2dbc\.url|mongodb\.uri|flyway\.url|liquibase\.url)$/;

/**
 * The data the service keeps, as the hub knows it: SQL tables from migrations (authoritative structure) completed by
 * entities (mapping and relations; the only source when there are no migrations), MongoDB collections, Redis hashes,
 * Elasticsearch indices... from mapped classes, plus tables only seen in code.
 */
export function buildDatabase(facts: SourceFacts, context: ContextFacts, sinks: Sink[]): DatabaseInfo {
  const tables = new Map<string, TableInfo>();
  for (const t of context.schema ?? []) {
    tables.set(t.name.toLowerCase(), { name: t.name, store: "sql", columns: t.columns.map((c) => ({ ...c })), source: "migration", evidence: t.evidence });
  }
  const entityTable = new Map((facts.entities ?? []).map((e) => [e.id, e.table.toLowerCase()]));
  for (const e of facts.entities ?? []) {
    const store: DataStore = e.store ?? "sql";
    // SQL names are case-insensitive; collection, key and index names are kept as written.
    const name = store === "sql" ? e.table.toLowerCase() : e.table;
    const known = tables.get(store === "sql" ? name : `${store}:${name}`);
    const t: TableInfo = known ?? { name, store, columns: [], source: "entity", evidence: e.evidence };
    if (known) t.source = "both";
    t.entity = e.id;
    for (const c of e.columns) {
      const ref = c.referencesEntity ? entityTable.get(c.referencesEntity) : undefined;
      const col = t.columns.find((x) => x.name === c.column.toLowerCase());
      if (col) {
        col.field = c.field;
        if (!col.references && ref) col.references = { table: ref, column: "id" };
      } else if (!known) {
        t.columns.push({ name: store === "sql" ? c.column.toLowerCase() : c.column, dataType: c.kotlinType, nullable: c.nullable, primaryKey: c.primaryKey, field: c.field, references: ref ? { table: ref, column: "id" } : undefined });
      }
    }
    tables.set(store === "sql" ? name : `${store}:${name}`, t);
  }
  for (const s of sinks.filter((x) => x.kind === "DB_TABLE")) {
    const name = s.technicalName.toLowerCase();
    const mapped = [...tables.values()].some((t) => t.name.toLowerCase() === name);
    if (!mapped) tables.set(name, { name, store: "sql", columns: [], source: "code" });
  }

  const datasources: Datasource[] = [...datasourcesOf(context.properties)];
  for (const [p, values] of Object.entries(context.profiles ?? {})) datasources.push(...datasourcesOf(values, p));
  return { datasources, tables: [...tables.values()].sort((a, b) => STORE_ORDER.indexOf(a.store) - STORE_ORDER.indexOf(b.store) || a.name.localeCompare(b.name)) };
}

/** Datasources of one property set: JDBC/R2DBC/MongoDB/Elasticsearch URLs, Redis by URL or host and port, Cassandra contact points. */
function datasourcesOf(props: Record<string, string>, profile?: string): Datasource[] {
  const out: Datasource[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (!v) continue;
    if (DATASOURCE_KEY.test(k) || /(^|\.)redis\.url$/.test(k)) out.push(parseDatasource(k, v, profile));
    else if (/(^|\.)elasticsearch\.uris$/.test(k)) out.push({ ...parseDatasource(k, v.split(",")[0].trim(), profile), kind: "elasticsearch" });
    else if (/(^|\.)redis\.host$/.test(k)) {
      const port = props[k.replace(/host$/, "port")];
      const db = props[k.replace(/host$/, "database")];
      out.push({ property: k, profile, kind: "redis", host: port ? `${v}:${port}` : v, database: db, url: `redis://${v}${port ? `:${port}` : ""}` });
    } else if (/(^|\.)cassandra\.contact-points$/.test(k)) {
      out.push({ property: k, profile, kind: "cassandra", host: v, database: props[k.replace(/contact-points$/, "keyspace-name")], url: v });
    }
  }
  return out;
}
