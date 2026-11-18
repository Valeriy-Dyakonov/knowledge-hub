//! Full-text search over the knowledge base: SQLite FTS5 in `<service>/.state/index.db`, rebuilt from the model.
//! A vector or graph index would be another `Indexer`.
use crate::error::{AppError, AppResult};
use crate::model::{status_of, KnowledgeModel};
use crate::store::{FsStore, KnowledgeStore};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub service: String,
    pub feature_id: String,
    pub title: String,
    pub snippet: String,
    pub status: String,
    pub score: f64,
}

pub trait Indexer {
    fn index(&self, model: &KnowledgeModel) -> AppResult<()>;
    fn search(&self, query: &str, service: Option<&str>, limit: usize) -> AppResult<Vec<SearchHit>>;
}

pub struct FtsIndex<'a> {
    store: &'a FsStore,
}

impl<'a> FtsIndex<'a> {
    pub fn new(store: &'a FsStore) -> Self {
        Self { store }
    }

    fn open(&self, service: &str) -> AppResult<Connection> {
        let conn = Connection::open(self.store.state_dir(service)?.join("index.db")).map_err(|e| AppError::new("indexUnavailable").with("detail", e.to_string()))?;
        conn.execute_batch(
            "create virtual table if not exists features using fts5(feature_id unindexed, title, body, status unindexed, tokenize = 'unicode61 remove_diacritics 2')",
        )
        .map_err(|e| AppError::new("indexUnavailable").with("detail", e.to_string()))?;
        Ok(conn)
    }
}

/// Everything a person might search for: names in all languages, descriptions, endpoints, topics, tables, components.
fn document(model: &KnowledgeModel, f: &crate::model::Feature) -> (String, String) {
    let title = f.business_name.values().next().cloned().unwrap_or_else(|| f.technical_name.clone());
    let mut parts: Vec<String> = vec![f.id.replace(['/', '-'], " "), f.group.clone(), f.technical_name.clone()];
    parts.extend(f.business_name.values().cloned());
    parts.extend(f.description.values().cloned());
    parts.extend(f.triggers.iter().map(|t| t.technical_name.clone()));
    parts.extend(f.triggers.iter().flat_map(|t| t.attributes.values().cloned()));
    for id in &f.component_ids {
        if let Some(c) = model.catalog.components.iter().find(|c| &c.id == id) {
            parts.push(c.technical_name.clone());
            parts.extend(c.business_name.values().cloned());
        }
    }
    for id in &f.sink_ids {
        if let Some(s) = model.catalog.sinks.iter().find(|s| &s.id == id) {
            parts.push(s.technical_name.clone());
            parts.extend(s.business_name.values().cloned());
        }
    }
    if let Some(o) = &f.owner {
        parts.push(o.clone());
    }
    (title, parts.join("\n"))
}

/// User text -> FTS5 query: every word must match as a prefix; FTS syntax characters are dropped.
pub fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w.to_lowercase()))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

impl Indexer for FtsIndex<'_> {
    fn index(&self, model: &KnowledgeModel) -> AppResult<()> {
        let mut conn = self.open(&model.service.id)?;
        let tx = conn.transaction().map_err(AppError::state)?;
        tx.execute("delete from features", []).map_err(AppError::state)?;
        for f in &model.features {
            let (title, body) = document(model, f);
            tx.execute("insert into features (feature_id, title, body, status) values (?1, ?2, ?3, ?4)", params![f.id, title, body, status_of(&f.claims)])
                .map_err(AppError::state)?;
        }
        tx.commit().map_err(AppError::state)
    }

    fn search(&self, query: &str, service: Option<&str>, limit: usize) -> AppResult<Vec<SearchHit>> {
        let Some(q) = fts_query(query) else { return Ok(vec![]) };
        let services = match service {
            Some(s) => vec![s.to_string()],
            None => self.store.services()?,
        };
        let mut hits = Vec::new();
        for s in services {
            if !self.store.state_dir(&s)?.join("index.db").exists() {
                continue;
            }
            let conn = self.open(&s)?;
            let mut stmt = conn
                .prepare("select feature_id, title, snippet(features, 2, '[', ']', '…', 12), status, bm25(features) from features where features match ?1 order by bm25(features) limit ?2")
                .map_err(|e| AppError::new("indexUnavailable").with("detail", e.to_string()))?;
            let rows = stmt
                .query_map(params![q, limit as i64], |r| {
                    Ok(SearchHit { service: s.clone(), feature_id: r.get(0)?, title: r.get(1)?, snippet: r.get::<_, String>(2)?.replace('\n', " · "), status: r.get(3)?, score: -r.get::<_, f64>(4)? })
                })
                .map_err(AppError::state)?;
            for r in rows {
                hits.push(r.map_err(AppError::state)?);
            }
        }
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The model written by the TypeScript pipeline for the fixture service, saved into a temporary store.
    pub fn fixture_store() -> (tempfile::TempDir, FsStore, KnowledgeModel) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/refunds-service.model.json");
        let model: KnowledgeModel = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = FsStore::new(dir.path());
        store.save(&model.service.id, &model).unwrap();
        (dir, store, model)
    }

    #[test]
    fn finds_features_by_endpoint_table_topic_and_prefix() {
        let (_d, store, model) = fixture_store();
        let index = FtsIndex::new(&store);
        index.index(&model).unwrap();
        let ids = |q: &str| index.search(q, None, 10).unwrap().into_iter().map(|h| h.feature_id).collect::<Vec<_>>();
        assert_eq!(ids("approve"), vec!["approvals/approve"]);
        assert!(ids("payments.completed").contains(&"payment-events/on-payment-completed".to_string()));
        assert!(ids("ledger").contains(&"reconciliation/reconcile".to_string()));
        assert!(ids("refun").len() >= 3, "prefix search");
        assert!(ids("\"; drop table").is_empty());
        assert!(index.search("", None, 10).unwrap().is_empty());
        // Re-indexing replaces, not duplicates.
        index.index(&model).unwrap();
        assert_eq!(ids("approve").len(), 1);
    }

    #[test]
    fn finds_business_names_in_russian() {
        let (_d, store, mut model) = fixture_store();
        model.features[0].business_name.insert("ru".into(), "Одобрение возврата".into());
        let index = FtsIndex::new(&store);
        index.index(&model).unwrap();
        let hits = index.search("одобрен", Some("refunds"), 5).unwrap();
        assert_eq!(hits[0].feature_id, model.features[0].id);
        assert_eq!(hits[0].title, "Одобрение возврата");
    }

    #[test]
    fn query_drops_fts_syntax() {
        assert_eq!(fts_query("POST /api/v1 refunds").unwrap(), "\"post\"* \"api\"* \"v1\"* \"refunds\"*");
        assert_eq!(fts_query("\"*:()"), None);
    }
}
