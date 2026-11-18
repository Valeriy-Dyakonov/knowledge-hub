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
    /// PARSE_ERROR: `context` (grammar nodes around the error) and `pattern` (anonymised code).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

/// A column of a JPA entity: field, mapped column, type, key and relation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntityColumnFact {
    pub field: String,
    pub column: String,
    pub kotlin_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    /// `@ManyToOne`/`@OneToOne` with a join column: the referenced entity (FQN).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references_entity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntityFact {
    pub id: String,
    /// Where it is stored: sql | mongo | redis | elasticsearch | cassandra | neo4j | unknown.
    #[serde(default = "sql_store")]
    pub store: String,
    /// Table, collection, Redis keyspace, index or label.
    pub table: String,
    pub columns: Vec<EntityColumnFact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

/// A place where code reads configuration: `@Value`, a placeholder in an annotation, `@ConfigurationProperties`,
/// `Environment.getProperty`. `key` ends with `.*` for a whole prefix.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUsageFact {
    pub key: String,
    pub component_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// value | annotation | properties | environment
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceFacts {
    pub components: Vec<ComponentFact>,
    pub triggers: Vec<TriggerFact>,
    pub calls: Vec<CallFact>,
    pub sink_accesses: Vec<SinkAccessFact>,
    pub events: Vec<EventPublishFact>,
    pub unresolved: Vec<UnresolvedFact>,
    pub entities: Vec<EntityFact>,
    pub config_usages: Vec<ConfigUsageFact>,
}

impl SourceFacts {
    pub fn extend(&mut self, other: SourceFacts) {
        self.components.extend(other.components);
        self.triggers.extend(other.triggers);
        self.calls.extend(other.calls);
        self.sink_accesses.extend(other.sink_accesses);
        self.events.extend(other.events);
        self.unresolved.extend(other.unresolved);
        self.entities.extend(other.entities);
        self.config_usages.extend(other.config_usages);
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFact {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<ColumnRef>,
}

/// A table as the migrations leave it after all of them are applied in order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableFact {
    pub name: String,
    pub columns: Vec<ColumnFact>,
    /// Where the table is created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Evidence>,
}

/// Facts from configuration, API specs, migrations, ownership. Secret values are already redacted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContextFacts {
    /// Configuration without a profile (application.yml / .properties).
    pub properties: BTreeMap<String, String>,
    /// Profile -> its own values (application-<profile>.yml, documents with spring.config.activate.on-profile).
    pub profiles: BTreeMap<String, BTreeMap<String, String>>,
    /// Where each property is defined: key -> "path:line".
    pub property_sources: BTreeMap<String, String>,
    pub api_operations: Vec<ApiOperation>,
    pub tables: Vec<String>,
    pub schema: Vec<TableFact>,
    pub ownership: Vec<OwnershipRule>,
}

impl ContextFacts {
    pub fn extend(&mut self, other: ContextFacts) {
        self.properties.extend(other.properties);
        for (p, values) in other.profiles {
            self.profiles.entry(p).or_default().extend(values);
        }
        self.property_sources.extend(other.property_sources);
        self.api_operations.extend(other.api_operations);
        self.tables.extend(other.tables);
        self.schema.extend(other.schema);
        self.ownership.extend(other.ownership);
    }
}

fn sql_store() -> String {
    "sql".into()
}
