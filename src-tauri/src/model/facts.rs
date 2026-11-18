//! Static facts produced by extractors and context sources (stage Scan). Mirror of `SourceFacts`/`ContextFacts` in `src/types.ts`.
use super::Evidence;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MethodFact {
    pub name: String,
    pub parameter_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComponentFact {
    pub id: String,
    pub simple_name: String,
    pub kind: String,
    pub is_interface: bool,
    pub supertypes: Vec<String>,
    /// field name -> resolved type id (usually FQN)
    pub injected: BTreeMap<String, String>,
    pub methods: Vec<MethodFact>,
    pub attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TriggerFact {
    #[serde(rename = "type")]
    pub kind: String,
    pub component_id: String,
    pub method: String,
    pub attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CallFact {
    pub from_component: String,
    pub from_method: String,
    pub target_type: String,
    pub target_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

/// `sink_name` may contain `${placeholders}`, resolved later from configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SinkAccessFact {
    pub component_id: String,
    pub method: String,
    pub sink_kind: String,
    pub sink_name: String,
    pub edge_kind: String,
    pub origin: String,
    pub confidence: String,
    pub attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventPublishFact {
    pub component_id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedFact {
    pub component_id: String,
    pub method: String,
    pub reason: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceFacts {
    pub components: Vec<ComponentFact>,
    pub triggers: Vec<TriggerFact>,
    pub calls: Vec<CallFact>,
    pub sink_accesses: Vec<SinkAccessFact>,
    pub events: Vec<EventPublishFact>,
    pub unresolved: Vec<UnresolvedFact>,
}

impl SourceFacts {
    pub fn extend(&mut self, other: SourceFacts) {
        self.components.extend(other.components);
        self.triggers.extend(other.triggers);
        self.calls.extend(other.calls);
        self.sink_accesses.extend(other.sink_accesses);
        self.events.extend(other.events);
        self.unresolved.extend(other.unresolved);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiOperation {
    pub method: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct OwnershipRule {
    pub pattern: String,
    pub owners: Vec<String>,
}

/// Facts from configuration, API specs, migrations, ownership. Secret values are already redacted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextFacts {
    pub properties: BTreeMap<String, String>,
    pub api_operations: Vec<ApiOperation>,
    pub tables: Vec<String>,
    pub ownership: Vec<OwnershipRule>,
}

impl ContextFacts {
    pub fn extend(&mut self, other: ContextFacts) {
        self.properties.extend(other.properties);
        self.api_operations.extend(other.api_operations);
        self.tables.extend(other.tables);
        self.ownership.extend(other.ownership);
    }
}
