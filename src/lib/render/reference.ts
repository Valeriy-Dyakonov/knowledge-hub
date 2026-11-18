import { messagesFor } from "../../i18n";
import type { DatabaseInfo, KnowledgeModel, TableInfo } from "../../types";
import { tableUsage } from "../model/usage";
import { namer } from "./names";
import type { Renderer } from "./types";

/** Mermaid ER identifiers and types: letters, digits and underscores only. */
export const erIdent = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "_";
/** Column types may keep sizes and arrays: `varchar(255)`, `numeric(10,2)`, `int[]`. */
const erType = (s: string) => s.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_()[\],-]/g, "_").replace(/^([^A-Za-z_])/, "_$1") || "unknown";
const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

/** SQL tables only: collections, Redis keyspaces and indices have no relational schema to draw. */
const sqlTables = (db: DatabaseInfo) => db.tables.filter((t) => t.store === "sql");

/** Tables to draw: all of them, or one table with the tables it references and those referencing it. */
export function erNeighbourhood(db: DatabaseInfo, focus?: string): TableInfo[] {
  const all = sqlTables(db);
  if (!focus) return all;
  const names = new Set([focus]);
  for (const t of all) {
    for (const c of t.columns) {
      if (!c.references) continue;
      if (t.name === focus) names.add(c.references.table);
      if (c.references.table === focus) names.add(t.name);
    }
  }
  return all.filter((t) => names.has(t.name));
}

/** Mermaid erDiagram; `nodes` maps entity ids to table names for clicks. */
export function erDiagram(db: DatabaseInfo, lang: string, focus?: string): { text: string; nodes: Record<string, string> } {
  const m = messagesFor(lang).render;
  const tables = erNeighbourhood(db, focus);
  const shown = new Set(tables.map((t) => t.name));
  const out = [`%% ${m.header}`, "erDiagram"];
  const nodes: Record<string, string> = {};
  for (const t of tables) {
    nodes[erIdent(t.name)] = t.name;
    out.push(`  ${erIdent(t.name)} {`);
    if (!t.columns.length) out.push(`    unknown ${erIdent(m.noColumns)}`);
    for (const c of t.columns) {
      const keys = [c.primaryKey && "PK", c.references && "FK"].filter(Boolean).join(", ");
      out.push(`    ${erType(c.dataType)} ${erIdent(c.name)}${keys ? ` ${keys}` : ""}${c.nullable || c.primaryKey ? "" : ` "${m.notNull}"`}`);
    }
    out.push("  }");
  }
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references || !shown.has(c.references.table)) continue;
      out.push(`  ${erIdent(t.name)} }o--${c.nullable ? "o|" : "||"} ${erIdent(c.references.table)} : "${c.name}"`);
    }
  }
  return { text: out.join("\n") + "\n", nodes };
}

export function databaseMarkdown(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const n = namer(model, lang);
  const db = model.database ?? { datasources: [], tables: [] };
  const out = [`<!-- ${m.header} -->`, `# ${m.databaseTitle}`, ""];
  if (db.datasources.length) {
    out.push(`## ${m.datasources}`, "");
    for (const d of db.datasources) {
      const where = [d.host && `\`${d.host}\``, d.database && `\`${d.database}\``].filter(Boolean).join(" / ");
      out.push(`- \`${d.kind}\` ${where}${d.profile ? ` (${m.profile(d.profile)})` : ""} — \`${d.property}\``);
    }
    out.push("");
  }
  if (!db.tables.length) out.push(`## ${m.tables}`, "", `_${m.noTables}_`, "");
  let store = "";
  for (const t of db.tables) {
    if (t.store !== store) {
      store = t.store;
      out.push(`## ${m.stores[store] ?? store}`, "");
    }
    out.push(`### ${md(t.name)}`, "", `- ${m.tableSource}: ${m.tableSources[t.source]}${t.evidence ? ` — \`${t.evidence.path}\`` : ""}`);
    if (t.entity) out.push(`- ${m.entity}: \`${t.entity}\``);
    const uses = tableUsage(model, t.name);
    if (uses.length) {
      const list = uses.map((u) => `${md(n.feature(u.feature))} (${[u.reads && m.edges.READ, u.writes && m.edges.WRITE].filter(Boolean).join(", ")})`);
      out.push(`- ${m.usedBy}: ${list.join("; ")}`);
    }
    if (t.columns.length) {
      out.push("", `| ${m.column} | ${m.dataType} | ${m.keys} | ${m.field} |`, "|---|---|---|---|");
      for (const c of t.columns) {
        const keys = [c.primaryKey && "PK", c.references && `FK → ${c.references.table}.${c.references.column}`, !c.nullable && !c.primaryKey && "NOT NULL"].filter(Boolean).join(", ");
        out.push(`| \`${c.name}\` | ${md(c.dataType)} | ${keys} | ${c.field ? `\`${c.field}\`` : ""} |`);
      }
    }
    out.push("");
  }
  if (sqlTables(db).length) {
    const er = erDiagram(db, lang).text.split("\n").filter((l) => l && !l.startsWith("%% "));
    out.push(`## ${m.erDiagram}`, "", "```mermaid", ...er, "```", "");
  }
  return out.join("\n");
}

export function configMarkdown(model: KnowledgeModel, lang: string): string {
  const m = messagesFor(lang).render;
  const cfg = model.config ?? { profiles: [], properties: [] };
  const cell = (v?: string) => (v === undefined ? "" : `\`${v.replace(/\|/g, "\\|").replace(/`/g, "'")}\``);
  const out = [`<!-- ${m.header} -->`, `# ${m.configTitle}`, ""];
  if (!cfg.properties.length) return [...out, `_${m.noProperties}_`, ""].join("\n");
  const profileCols = cfg.profiles.map((p) => ` ${m.profile(p)} |`).join("");
  out.push(`| ${m.property} | ${m.baseValue} |${profileCols} ${m.readBy} |`);
  out.push(`|---|---|${cfg.profiles.map(() => "---|").join("")}---|`);
  for (const p of cfg.properties) {
    const readers = p.usages.map((u) => `\`${u.componentId.split(".").pop()}${u.method ? `.${u.method}` : ""}\``).join(", ");
    const flags = [p.missing && `**${m.missing}**`, p.secret && m.secret].filter(Boolean).join(" ");
    const values = cfg.profiles.map((pr) => ` ${cell(p.profiles[pr])} |`).join("");
    out.push(`| \`${p.key}\`${flags ? ` ${flags}` : ""} | ${cell(p.value)} |${values} ${readers} |`);
  }
  return out.join("\n") + "\n";
}

/** Reference views of the database and the configuration. */
export const referenceRenderer: Renderer = {
  id: "reference",
  render(model, view) {
    const files = [
      { relativePath: "database.md", content: databaseMarkdown(model, view.language) },
      { relativePath: "config.md", content: configMarkdown(model, view.language) },
    ];
    if (model.database && sqlTables(model.database).length) files.push({ relativePath: "diagrams/er.mmd", content: erDiagram(model.database, view.language).text });
    return files;
  },
};
