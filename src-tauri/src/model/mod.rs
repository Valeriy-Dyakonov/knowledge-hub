//! Serde mirror of the domain model in `src/types.ts` (same camelCase names).
//! Kind/status fields are kept as strings: the TypeScript side owns their vocabulary.
pub mod facts;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

pub type Text = BTreeMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub repo: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<LineRange>,
    pub commit: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubjectRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewInfo {
    pub reviewer: String,
    pub at: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub id: String,
    pub feature_id: Option<String>,
    pub subject: SubjectRef,
    pub kind: String,
    #[serde(default)]
    pub payload: BTreeMap<String, String>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    pub origin: String,
    pub confidence: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_reasons: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis_payload: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_payload: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub repo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub stack: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_analyzed_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub technical_name: String,
    pub component_id: String,
    pub method: String,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub kind: String,
    pub technical_name: String,
    #[serde(default)]
    pub business_name: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sink {
    pub id: String,
    pub kind: String,
    pub technical_name: String,
    #[serde(default)]
    pub business_name: Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeRef {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from: NodeRef,
    pub to: NodeRef,
    pub kind: String,
    pub label: String,
    pub origin: String,
    pub confidence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_id: Option<String>,
    /// The call goes to an `@Async` method: the caller does not wait for it.
    #[serde(default, rename = "async", skip_serializing_if = "Option::is_none")]
    pub is_async: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub order: u32,
    pub component_id: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowBreak {
    pub component_id: String,
    pub method: String,
    pub reason: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub id: String,
    pub group: String,
    pub technical_name: String,
    #[serde(default)]
    pub business_name: Text,
    #[serde(default)]
    pub description: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<Trigger>,
    #[serde(default)]
    pub component_ids: Vec<String>,
    #[serde(default)]
    pub sink_ids: Vec<String>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub breaks: Vec<FlowBreak>,
    #[serde(default)]
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Catalog {
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub sinks: Vec<Sink>,
    #[serde(default)]
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeModel {
    pub schema_version: u32,
    pub service: Service,
    #[serde(default)]
    pub catalog: Catalog,
    #[serde(default)]
    pub features: Vec<Feature>,
    /// Tables, columns, keys, datasources (shape owned by `DatabaseInfo` in src/types.ts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<serde_json::Value>,
    /// Properties, values per profile, who reads them (`ConfigInfo` in src/types.ts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub relative_path: String,
    pub content: String,
}

/// Review status derived from claims, same rule as `src/lib/model/status.ts`.
pub fn status_of<'a>(claims: impl IntoIterator<Item = &'a Claim>) -> &'static str {
    let mut draft = false;
    for c in claims {
        match c.status.as_str() {
            "STALE" => return "STALE",
            "PROPOSED" => draft = true,
            _ => {}
        }
    }
    if draft { "DRAFT" } else { "REVIEWED" }
}
