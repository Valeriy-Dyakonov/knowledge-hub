//! Table names from Flyway/Liquibase migrations: used to check DB_TABLE sinks derived from code.
use super::ContextSource;
use crate::error::AppResult;
use crate::model::facts::ContextFacts;
use crate::repo::RepoSnapshot;
use regex::Regex;
use std::sync::LazyLock;

pub struct Migrations;

static SQL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`\[\]]+)"#).unwrap());
static LIQUIBASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?is)createTable.{0,300}?tableName\s*[:=]\s*["']?([\w.]+)"#).unwrap());

fn candidate(path: &str) -> bool {
    let in_dir = ["db/migration", "db/changelog", "/migrations/", "liquibase", "flyway"].iter().any(|d| path.contains(d));
    in_dir && [".sql", ".xml", ".yaml", ".yml"].iter().any(|e| path.ends_with(e))
}

/// `"public"."refunds"` -> `refunds`
fn table_name(raw: &str) -> String {
    raw.rsplit('.').next().unwrap_or(raw).trim_matches(|c| matches!(c, '"' | '`' | '[' | ']')).to_lowercase()
}

impl ContextSource for Migrations {
    fn id(&self) -> &'static str {
        "migrations"
    }

    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let mut tables: Vec<String> = Vec::new();
        let mut add = |t: String| {
            if !tables.contains(&t) {
                tables.push(t);
            }
        };
        for path in repo.files(candidate) {
            let text = repo.read(&path)?;
            for c in SQL.captures_iter(&text) {
                add(table_name(&c[1]));
            }
            if !path.ends_with(".sql") {
                for c in LIQUIBASE.captures_iter(&text) {
                    add(table_name(&c[1]));
                }
            }
        }
        Ok(ContextFacts { tables, ..Default::default() })
    }
}
