//! Database schema from Flyway/Liquibase migrations, applied in version order: tables with columns, types,
//! nullability, primary and foreign keys. Used to describe the database and to check DB_TABLE sinks found in code.
use super::ContextSource;
use crate::error::AppResult;
use crate::model::facts::{ColumnFact, ColumnRef, ContextFacts, TableFact};
use crate::model::Evidence;
use crate::repo::RepoSnapshot;
use regex::Regex;
use serde_yaml::Value;
use std::sync::LazyLock;

pub struct Migrations;

fn candidate(path: &str) -> bool {
    let in_dir = ["db/migration", "db/changelog", "/migrations/", "liquibase", "flyway"].iter().any(|d| path.contains(d));
    in_dir && [".sql", ".xml", ".yaml", ".yml"].iter().any(|e| path.ends_with(e))
}

/// Flyway version of a file name: `V2_1__x.sql` -> [2, 1]; others sort by name after versioned ones.
fn version(path: &str) -> (u8, Vec<u64>, String) {
    let name = path.rsplit('/').next().unwrap_or(path);
    if let Some(v) = name.strip_prefix('V').or_else(|| name.strip_prefix('v')).and_then(|r| r.split("__").next()) {
        let parts: Vec<u64> = v.split(['_', '.']).filter_map(|p| p.parse().ok()).collect();
        if !parts.is_empty() {
            return (0, parts, name.to_string());
        }
    }
    (1, vec![], path.to_string())
}

/// `"public"."Refunds"` -> `refunds`
fn ident(raw: &str) -> String {
    raw.trim().rsplit('.').next().unwrap_or(raw).trim_matches(|c| matches!(c, '"' | '`' | '[' | ']')).to_lowercase()
}

#[derive(Default)]
pub struct Schema {
    pub tables: Vec<TableFact>,
}

impl Schema {
    fn table(&mut self, name: &str) -> Option<&mut TableFact> {
        self.tables.iter_mut().find(|t| t.name == name)
    }

    fn column(&mut self, table: &str, col: ColumnFact) {
        if let Some(t) = self.table(table) {
            t.columns.retain(|c| c.name != col.name);
            t.columns.push(col);
        }
    }

    fn reference(&mut self, table: &str, column: &str, to: ColumnRef) {
        if let Some(c) = self.table(table).and_then(|t| t.columns.iter_mut().find(|c| c.name == column)) {
            c.references = Some(to);
        }
    }

    fn primary(&mut self, table: &str, cols: &[String]) {
        if let Some(t) = self.table(table) {
            for c in t.columns.iter_mut().filter(|c| cols.contains(&c.name)) {
                c.primary_key = true;
                c.nullable = false;
            }
        }
    }
}

static CREATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`\[\]]+)\s*\((.*)\)"#).unwrap());
static ALTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."`\[\]]+)\s+(.*)$"#).unwrap());
static DROP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)^drop\s+table\s+(?:if\s+exists\s+)?([\w."`\[\],\s]+?)(?:\s+cascade|\s+restrict)?$"#).unwrap());
static FK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."`\[\]]+)\s*(?:\(([^)]+)\))?"#).unwrap());
static PK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)primary\s+key\s*\(([^)]+)\)"#).unwrap());
static INLINE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)\breferences\s+([\w."`\[\]]+)\s*(?:\(([^)]+)\))?"#).unwrap());

/// Splits on commas outside parentheses.
fn split_top(s: &str) -> Vec<String> {
    let (mut depth, mut cur, mut out) = (0, String::new(), Vec::new());
    for ch in s.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(cur.trim().to_string());
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(ch);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

const CONSTRAINT_WORDS: &[&str] = &["not", "null", "default", "primary", "references", "unique", "check", "constraint", "generated", "collate", "auto_increment", "identity"];

/// `refund_id UUID NOT NULL REFERENCES refunds (id)` -> column.
fn column_def(def: &str) -> Option<ColumnFact> {
    let mut words = def.split_whitespace();
    let name = ident(words.next()?);
    let rest: Vec<&str> = words.collect();
    let type_end = rest.iter().position(|w| CONSTRAINT_WORDS.contains(&w.to_lowercase().as_str())).unwrap_or(rest.len());
    let data_type = rest[..type_end].join(" ").to_lowercase();
    let lower = def.to_lowercase();
    let primary_key = lower.contains("primary key");
    let references = INLINE_REF.captures(def).map(|c| ColumnRef { table: ident(&c[1]), column: c.get(2).map(|m| ident(m.as_str())).unwrap_or_else(|| "id".into()) });
    Some(ColumnFact { name, data_type, nullable: !lower.contains("not null") && !primary_key, primary_key, references })
}

fn cols(list: &str) -> Vec<String> {
    list.split(',').map(ident).collect()
}

/// Applies one SQL statement to the schema.
pub fn apply_sql(schema: &mut Schema, stmt: &str, evidence: Option<Evidence>) {
    let stmt = stmt.trim();
    if let Some(c) = CREATE.captures(stmt) {
        let name = ident(&c[1]);
        schema.tables.retain(|t| t.name != name);
        schema.tables.push(TableFact { name: name.clone(), columns: vec![], evidence });
        let mut pks = Vec::new();
        let mut fks = Vec::new();
        for def in split_top(&c[2]) {
            let head = def.split_whitespace().next().unwrap_or("").to_lowercase();
            let body = if head == "constraint" { def.splitn(3, char::is_whitespace).nth(2).unwrap_or("").to_string() } else { def.clone() };
            let bhead = body.split_whitespace().next().unwrap_or("").to_lowercase();
            match bhead.as_str() {
                "primary" => pks.extend(PK.captures(&body).map(|p| cols(&p[1])).unwrap_or_default()),
                "foreign" => fks.extend(FK.captures(&body).map(|f| (cols(&f[1]), ident(&f[2]), f.get(3).map(|m| cols(m.as_str())).unwrap_or_default()))),
                "unique" | "check" | "index" | "key" | "exclude" | "like" => {}
                _ => {
                    if let Some(col) = column_def(&def) {
                        schema.column(&name, col);
                    }
                }
            }
        }
        schema.primary(&name, &pks);
        for (from, table, to) in fks {
            for (i, f) in from.iter().enumerate() {
                let column = to.get(i).cloned().unwrap_or_else(|| "id".into());
                schema.reference(&name, f, ColumnRef { table: table.clone(), column });
            }
        }
        return;
    }
    if let Some(c) = ALTER.captures(stmt) {
        let name = ident(&c[1]);
        for action in split_top(&c[2]) {
            let a = action.trim();
            let lower = a.to_lowercase();
            if let Some(rest) = lower.strip_prefix("rename to ").map(|_| &a[10..]) {
                let new = ident(rest);
                if let Some(t) = schema.table(&name) {
                    t.name = new;
                }
            } else if lower.starts_with("rename column ") || (lower.starts_with("rename ") && lower.contains(" to ")) {
                let parts: Vec<&str> = a.split_whitespace().collect();
                let (from, to) = if lower.starts_with("rename column ") { (parts.get(2), parts.get(4)) } else { (parts.get(1), parts.get(3)) };
                if let (Some(f), Some(t)) = (from, to) {
                    let (f, t) = (ident(f), ident(t));
                    if let Some(c) = schema.table(&name).and_then(|tb| tb.columns.iter_mut().find(|c| c.name == f)) {
                        c.name = t;
                    }
                }
            } else if lower.starts_with("drop column") || lower.starts_with("drop ") && !lower.starts_with("drop constraint") {
                let parts: Vec<&str> = a.split_whitespace().filter(|w| !matches!(w.to_lowercase().as_str(), "drop" | "column" | "if" | "exists")).collect();
                if let Some(col) = parts.first().map(|c| ident(c)) {
                    if let Some(t) = schema.table(&name) {
                        t.columns.retain(|c| c.name != col);
                    }
                }
            } else if lower.starts_with("add") {
                let body = a[3..].trim();
                let bl = body.to_lowercase();
                if let Some(f) = FK.captures(body) {
                    let to = f.get(3).map(|m| cols(m.as_str())).unwrap_or_default();
                    for (i, col) in cols(&f[1]).iter().enumerate() {
                        schema.reference(&name, col, ColumnRef { table: ident(&f[2]), column: to.get(i).cloned().unwrap_or_else(|| "id".into()) });
                    }
                } else if let Some(p) = PK.captures(body) {
                    schema.primary(&name, &cols(&p[1]));
                } else if !bl.starts_with("constraint") && !bl.starts_with("unique") && !bl.starts_with("check") && !bl.starts_with("index") {
                    let def = body.trim_start_matches(|c: char| c.is_whitespace());
                    let def = if bl.starts_with("column") { def[6..].trim() } else { def };
                    let def = if def.to_lowercase().starts_with("if not exists") { def[13..].trim() } else { def };
                    if let Some(col) = column_def(def) {
                        schema.column(&name, col);
                    }
                }
            }
        }
        return;
    }
    if let Some(c) = DROP.captures(stmt) {
        for t in c[1].split(',') {
            let t = ident(t);
            schema.tables.retain(|x| x.name != t);
        }
    }
}

/// Statements of a SQL file without comments, with the line each starts on.
pub fn statements(sql: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let (mut cur, mut start_line, mut line) = (String::new(), 1u32, 1u32);
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    line += 1;
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == '\'' {
            cur.push(c);
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                if chars[i] == '\n' {
                    line += 1;
                }
                cur.push(chars[i]);
                i += 1;
            }
        }
        if c == '\n' {
            line += 1;
        }
        if c == ';' {
            if !cur.trim().is_empty() {
                out.push((start_line, cur.split_whitespace().collect::<Vec<_>>().join(" ")));
            }
            cur.clear();
        } else {
            if cur.trim().is_empty() && !c.is_whitespace() {
                start_line = line;
            }
            if i < chars.len() {
                cur.push(chars[i]);
            }
        }
        i += 1;
    }
    if !cur.trim().is_empty() {
        out.push((start_line, cur.split_whitespace().collect::<Vec<_>>().join(" ")));
    }
    out
}

fn yaml_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str().map(String::from).or_else(|| x.as_bool().map(|b| b.to_string())))
}

/// Liquibase YAML: createTable / addColumn / addForeignKeyConstraint / addPrimaryKey / dropTable / renameColumn.
fn apply_liquibase_yaml(schema: &mut Schema, text: &str, ev: impl Fn(&str) -> Option<Evidence>) {
    let Ok(doc) = serde_yaml::from_str::<Value>(text) else { return };
    let Some(sets) = doc.get("databaseChangeLog").and_then(Value::as_sequence) else { return };
    let column = |c: &Value| -> Option<ColumnFact> {
        let c = c.get("column")?;
        let cons = c.get("constraints");
        let pk = cons.and_then(|x| yaml_str(x, "primaryKey")).is_some_and(|v| v == "true");
        let not_null = cons.and_then(|x| yaml_str(x, "nullable")).is_some_and(|v| v == "false");
        let references = cons.and_then(|x| yaml_str(x, "referencedTableName").map(|t| ColumnRef { table: ident(&t), column: yaml_str(x, "referencedColumnNames").map(|c| ident(&c)).unwrap_or_else(|| "id".into()) }));
        Some(ColumnFact { name: ident(&yaml_str(c, "name")?), data_type: yaml_str(c, "type").unwrap_or_default().to_lowercase(), nullable: !not_null && !pk, primary_key: pk, references })
    };
    for set in sets {
        let Some(changes) = set.get("changeSet").and_then(|c| c.get("changes")).and_then(Value::as_sequence) else { continue };
        for ch in changes {
            if let Some(ct) = ch.get("createTable") {
                let Some(name) = yaml_str(ct, "tableName").map(|n| ident(&n)) else { continue };
                schema.tables.retain(|t| t.name != name);
                schema.tables.push(TableFact { name: name.clone(), columns: vec![], evidence: ev(&format!("tableName: {name}")) });
                for c in ct.get("columns").and_then(Value::as_sequence).into_iter().flatten() {
                    if let Some(col) = column(c) {
                        schema.column(&name, col);
                    }
                }
            } else if let Some(ac) = ch.get("addColumn") {
                let Some(name) = yaml_str(ac, "tableName").map(|n| ident(&n)) else { continue };
                for c in ac.get("columns").and_then(Value::as_sequence).into_iter().flatten() {
                    if let Some(col) = column(c) {
                        schema.column(&name, col);
                    }
                }
            } else if let Some(fk) = ch.get("addForeignKeyConstraint") {
                if let (Some(t), Some(c), Some(rt)) = (yaml_str(fk, "baseTableName"), yaml_str(fk, "baseColumnNames"), yaml_str(fk, "referencedTableName")) {
                    let rc = yaml_str(fk, "referencedColumnNames").map(|c| ident(&c)).unwrap_or_else(|| "id".into());
                    schema.reference(&ident(&t), &ident(&c), ColumnRef { table: ident(&rt), column: rc });
                }
            } else if let Some(pk) = ch.get("addPrimaryKey") {
                if let (Some(t), Some(c)) = (yaml_str(pk, "tableName"), yaml_str(pk, "columnNames")) {
                    schema.primary(&ident(&t), &cols(&c));
                }
            } else if let Some(dt) = ch.get("dropTable") {
                if let Some(t) = yaml_str(dt, "tableName") {
                    let t = ident(&t);
                    schema.tables.retain(|x| x.name != t);
                }
            } else if let Some(rc) = ch.get("renameColumn") {
                if let (Some(t), Some(o), Some(nw)) = (yaml_str(rc, "tableName"), yaml_str(rc, "oldColumnName"), yaml_str(rc, "newColumnName")) {
                    let (o, nw) = (ident(&o), ident(&nw));
                    if let Some(c) = schema.table(&ident(&t)).and_then(|tb| tb.columns.iter_mut().find(|c| c.name == o)) {
                        c.name = nw;
                    }
                }
            }
        }
    }
}

static XML_TABLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)<createTable[^>]*tableName\s*=\s*"([^"]+)"[^>]*>(.*?)</createTable>"#).unwrap());
static XML_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)<column([^>]*?)(?:/>|>(.*?)</column>)"#).unwrap());
static XML_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(\w+)\s*=\s*"([^"]*)""#).unwrap());

/// Liquibase XML, the common part: createTable with columns and their constraints.
fn apply_liquibase_xml(schema: &mut Schema, text: &str, ev: impl Fn(&str) -> Option<Evidence>) {
    for t in XML_TABLE.captures_iter(text) {
        let name = ident(&t[1]);
        schema.tables.retain(|x| x.name != name);
        schema.tables.push(TableFact { name: name.clone(), columns: vec![], evidence: ev(&format!("tableName=\"{}\"", &t[1])) });
        for c in XML_COLUMN.captures_iter(&t[2]) {
            let attrs = |s: &str| XML_ATTR.captures_iter(s).map(|a| (a[1].to_string(), a[2].to_string())).collect::<Vec<_>>();
            let a = attrs(&c[1]);
            let cons = c.get(2).map(|m| attrs(m.as_str())).unwrap_or_default();
            let get = |v: &[(String, String)], k: &str| v.iter().find(|(x, _)| x == k).map(|(_, y)| y.clone());
            let Some(col) = get(&a, "name") else { continue };
            let pk = get(&cons, "primaryKey").is_some_and(|v| v == "true");
            let references = get(&cons, "referencedTableName").map(|t| ColumnRef { table: ident(&t), column: get(&cons, "referencedColumnNames").map(|c| ident(&c)).unwrap_or_else(|| "id".into()) });
            schema.column(&name, ColumnFact {
                name: ident(&col),
                data_type: get(&a, "type").unwrap_or_default().to_lowercase(),
                nullable: !pk && get(&cons, "nullable").is_none_or(|v| v != "false"),
                primary_key: pk,
                references,
            });
        }
    }
}

impl ContextSource for Migrations {
    fn id(&self) -> &'static str {
        "migrations"
    }

    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let mut files = repo.files(candidate);
        files.sort_by_key(|p| version(p));
        let mut schema = Schema::default();
        for path in files {
            let text = repo.read(&path)?;
            let ev_at = |line: u32| Some(repo.evidence(&path, &text, Some((line, line))));
            if path.ends_with(".sql") {
                for (line, stmt) in statements(&text) {
                    apply_sql(&mut schema, &stmt, ev_at(line));
                }
            } else {
                let find_line = |needle: &str| text.lines().position(|l| l.contains(needle)).map(|i| i as u32 + 1).unwrap_or(1);
                if path.ends_with(".xml") {
                    apply_liquibase_xml(&mut schema, &text, |n| ev_at(find_line(n)));
                } else {
                    apply_liquibase_yaml(&mut schema, &text, |n| ev_at(find_line(n)));
                }
            }
        }
        let tables = schema.tables.iter().map(|t| t.name.clone()).collect();
        Ok(ContextFacts { tables, schema: schema.tables, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(sql: &[&str]) -> Vec<TableFact> {
        let mut s = Schema::default();
        for f in sql {
            for (_, stmt) in statements(f) {
                apply_sql(&mut s, &stmt, None);
            }
        }
        s.tables
    }

    #[test]
    fn builds_tables_with_keys_and_applies_alters_in_order() {
        let t = run(&[
            "create table refunds (id uuid primary key, amount numeric not null, status varchar(32) not null);\n-- c\nCREATE TABLE IF NOT EXISTS audit_log (text varchar(255));",
            "CREATE TABLE refund_items (\n id BIGSERIAL PRIMARY KEY,\n refund_id UUID NOT NULL REFERENCES refunds (id),\n sku VARCHAR(64) NOT NULL,\n CONSTRAINT uq UNIQUE (refund_id, sku)\n);\nALTER TABLE refunds ADD COLUMN reason TEXT;\nALTER TABLE audit_log ADD COLUMN refund_id UUID;\nALTER TABLE audit_log ADD CONSTRAINT fk FOREIGN KEY (refund_id) REFERENCES refunds (id);",
            "CREATE TABLE tmp (id INT); DROP TABLE IF EXISTS tmp; ALTER TABLE refunds RENAME COLUMN reason TO refund_reason;",
        ]);
        let names: Vec<&str> = t.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["refunds", "audit_log", "refund_items"]);
        let refunds = &t[0];
        let cols: Vec<String> = refunds.columns.iter().map(|c| format!("{}:{}:{}{}", c.name, c.data_type, if c.nullable { "null" } else { "notnull" }, if c.primary_key { ":pk" } else { "" })).collect();
        assert_eq!(cols, vec!["id:uuid:notnull:pk", "amount:numeric:notnull", "status:varchar(32):notnull", "refund_reason:text:null"]);
        let items = &t[2];
        assert_eq!(items.columns.len(), 3);
        assert_eq!(items.columns[1].references, Some(ColumnRef { table: "refunds".into(), column: "id".into() }));
        assert!(items.columns[0].primary_key);
        assert_eq!(t[1].columns[1].references.as_ref().unwrap().table, "refunds");
    }

    #[test]
    fn reads_liquibase_yaml_and_xml() {
        let mut s = Schema::default();
        apply_liquibase_yaml(&mut s, "databaseChangeLog:\n  - changeSet:\n      id: 1\n      changes:\n        - createTable:\n            tableName: orders\n            columns:\n              - column:\n                  name: id\n                  type: BIGINT\n                  constraints:\n                    primaryKey: true\n              - column:\n                  name: customer_id\n                  type: BIGINT\n                  constraints:\n                    nullable: false\n                    referencedTableName: customers\n", |_| None);
        apply_liquibase_xml(&mut s, r#"<changeSet><createTable tableName="customers"><column name="id" type="BIGINT"><constraints primaryKey="true"/></column><column name="email" type="VARCHAR(255)"/></createTable></changeSet>"#, |_| None);
        assert_eq!(s.tables.len(), 2);
        assert!(s.tables[0].columns[0].primary_key);
        assert_eq!(s.tables[0].columns[1].references.as_ref().unwrap().table, "customers");
        assert!(!s.tables[0].columns[1].nullable);
        assert_eq!(s.tables[1].columns[1].data_type, "varchar(255)");
    }

    #[test]
    fn sorts_flyway_versions_numerically() {
        let mut v = vec!["db/migration/V10__a.sql", "db/migration/V2__b.sql", "db/migration/V1_1__c.sql"];
        v.sort_by_key(|p| version(p));
        assert_eq!(v, vec!["db/migration/V1_1__c.sql", "db/migration/V2__b.sql", "db/migration/V10__a.sql"]);
    }
}
