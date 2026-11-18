//! Context sources read non-code facts (configuration, API specs, migrations, ownership).
//! A new source is a module implementing `ContextSource` plus an entry in `registry()`.
pub mod codeowners;
pub mod migrations;
pub mod openapi;
pub mod spring_config;

use crate::error::AppResult;
use crate::model::facts::ContextFacts;
use crate::repo::RepoSnapshot;

pub trait ContextSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn required(&self) -> bool {
        false
    }
    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts>;
}

/// Registered context sources; all of them run on every scan.
pub fn registry() -> Vec<Box<dyn ContextSource>> {
    vec![Box::new(spring_config::SpringConfig), Box::new(openapi::OpenApi), Box::new(migrations::Migrations), Box::new(codeowners::CodeOwners)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_context_of_the_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/refunds-service");
        let repo = RepoSnapshot::open(path.to_str().unwrap()).unwrap();
        let mut facts = ContextFacts::default();
        for s in registry() {
            facts.extend(s.collect(&repo).unwrap());
        }
        let p = &facts.properties;
        assert_eq!(p["payments.topics.completed"], "payments.completed");
        assert_eq!(p["clients.payments.url"], "http://payments:8080");
        assert_eq!(p["spring.datasource.password"], crate::redact::MASK);
        assert_eq!(p["clients.payments.api-key"], crate::redact::MASK);
        assert_eq!(facts.tables, vec!["refunds", "audit_log", "refund_items"]);
        let refunds = &facts.schema[0];
        let cols: Vec<&str> = refunds.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(cols, vec!["id", "amount", "status", "refund_reason", "created_at"], "V10 renamed reason; tmp_import dropped");
        assert!(refunds.columns[0].primary_key);
        assert_eq!(refunds.evidence.as_ref().unwrap().path, "src/main/resources/db/migration/V1__init.sql");
        let items = &facts.schema[2];
        assert_eq!(items.columns.iter().find(|c| c.name == "refund_id").unwrap().references.as_ref().unwrap().table, "refunds");
        assert_eq!(facts.profiles["prod"]["payments.topics.completed"], "prod.payments.completed");
        let ops: Vec<String> = facts.api_operations.iter().map(|o| format!("{} {} {:?} {:?}", o.method, o.path, o.operation_id, o.tags)).collect();
        assert_eq!(
            ops,
            vec![
                r#"POST /api/v1/refunds Some("createRefund") ["refunds"]"#,
                r#"GET /api/v1/refunds/{id} Some("getRefund") ["refunds"]"#,
                r#"POST /api/v1/refunds/{id}/approve None ["approvals"]"#,
            ]
        );
        assert_eq!(facts.api_operations[0].evidence.as_ref().unwrap().lines.as_ref().unwrap().start, 6);
        assert_eq!(facts.ownership.len(), 2);
        assert_eq!(facts.ownership[1].owners, vec!["@team-ledger"]);
    }
}
