//! OpenAPI/Swagger specifications in the repository: operations with tags, used to group endpoints into features.
use super::ContextSource;
use crate::error::AppResult;
use crate::model::facts::{ApiOperation, ContextFacts};
use crate::repo::RepoSnapshot;
use serde_yaml::Value;

pub struct OpenApi;

const METHODS: [&str; 7] = ["get", "post", "put", "patch", "delete", "head", "options"];

fn candidate(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    (name.contains("openapi") || name.contains("swagger") || name.starts_with("api.")) && (name.ends_with(".yaml") || name.ends_with(".yml") || name.ends_with(".json"))
}

/// First line where `needle` is a key, for evidence.
fn line_of(text: &str, needle: &str) -> u32 {
    text.lines()
        .position(|l| {
            let t = l.trim_start().trim_start_matches(['"', '\'']);
            t.strip_prefix(needle).is_some_and(|rest| rest.trim_start_matches(['"', '\'']).starts_with(':'))
        })
        .map(|i| i as u32 + 1)
        .unwrap_or(1)
}

impl ContextSource for OpenApi {
    fn id(&self) -> &'static str {
        "openapi"
    }

    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let mut ops = Vec::new();
        for path in repo.files(candidate) {
            let text = repo.read(&path)?;
            let Ok(doc) = serde_yaml::from_str::<Value>(&text) else { continue };
            if doc.get("openapi").is_none() && doc.get("swagger").is_none() {
                continue;
            }
            let base = doc.get("basePath").and_then(Value::as_str).unwrap_or("").trim_end_matches('/').to_string();
            let Some(paths) = doc.get("paths").and_then(Value::as_mapping) else { continue };
            for (p, item) in paths {
                let Some(p) = p.as_str() else { continue };
                let line = line_of(&text, p);
                for m in METHODS {
                    let Some(op) = item.get(m) else { continue };
                    let s = |k: &str| op.get(k).and_then(Value::as_str).map(String::from);
                    ops.push(ApiOperation {
                        method: m.to_uppercase(),
                        path: format!("{base}{p}"),
                        operation_id: s("operationId"),
                        tags: op.get("tags").and_then(Value::as_sequence).map(|t| t.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                        summary: s("summary"),
                        evidence: Some(repo.evidence(&path, &text, Some((line, line)))),
                    });
                }
            }
        }
        Ok(ContextFacts { api_operations: ops, ..Default::default() })
    }
}
