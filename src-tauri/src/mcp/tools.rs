//! MCP tools (docs/08-mcp.md). Read-only: they never run an analysis and never change knowledge.
//! Every answer is the standard envelope `{ data, meta }` where `meta` says how far the data can be trusted;
//! errors are `{ error: { code, params } }`. Independent of the transport (`stdio.rs`).
use crate::error::{AppError, AppResult};
use crate::index::{FtsIndex, Indexer};
use crate::model::{status_of, Claim, Feature, KnowledgeModel};
use crate::store::{FsStore, KnowledgeStore};
use serde_json::{json, Value};

pub struct Tools {
    pub store: FsStore,
}

pub fn definitions() -> Value {
    let s = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    let service = json!({ "type": "string", "description": "Service id (folder in the knowledge base). Optional when there is one service." });
    json!([
        { "name": "list_features", "description": "Short index of a service: features with business name, one line, review status. Start here.",
          "inputSchema": s(json!({ "service": service }), &[]) },
        { "name": "get_feature", "description": "One feature. depth: summary (what and who), flow (steps from trigger to sinks with evidence), full (plus every claim).",
          "inputSchema": s(json!({ "id": { "type": "string" }, "depth": { "type": "string", "enum": ["summary", "flow", "full"] }, "service": service }), &["id"]) },
        { "name": "get_flow", "description": "The flow of a feature from its trigger to databases, queues and external APIs, step by step with file:lines evidence and the places where static analysis was unsure.",
          "inputSchema": s(json!({ "id": { "type": "string" }, "service": service }), &["id"]) },
        { "name": "get_diagram", "description": "A Mermaid diagram: level 'context' (L1: who calls the service, which systems it uses and for which features), 'features' (L2: features by area and the systems each touches, chains through topics), 'components' (technical layers), or the flow (L3) of a feature id.",
          "inputSchema": s(json!({ "id": { "type": "string", "description": "Feature id for a flow diagram" }, "level": { "type": "string", "enum": ["context", "features", "components"] }, "format": { "type": "string", "enum": ["mermaid", "svg"] }, "service": service }), &[]) },
        { "name": "search", "description": "Full-text search over features: names, descriptions, endpoints, topics, tables, components.",
          "inputSchema": s(json!({ "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "maximum": 50 }, "service": service }), &["query"]) },
        { "name": "who_touches", "description": "Which features read, write, publish to or call a table, topic/queue or external service (by name or id, e.g. 'refunds' or 'topic:refunds.created').",
          "inputSchema": s(json!({ "sink": { "type": "string" }, "service": service }), &["sink"]) },
        { "name": "freshness", "description": "Review status of a feature (or the whole service): verified commit, review time, why it is stale, how many claims are unverified.",
          "inputSchema": s(json!({ "id": { "type": "string" }, "service": service }), &[]) },
    ])
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn first_name(m: &std::collections::BTreeMap<String, String>) -> Option<String> {
    m.get("ru").or_else(|| m.get("en")).or_else(|| m.values().next()).cloned()
}

/// Trust metadata of a set of claims (docs/08-mcp.md "Формат ответа").
pub fn meta<'a>(claims: impl IntoIterator<Item = &'a Claim> + Clone) -> Value {
    let latest = claims.clone().into_iter().filter_map(|c| c.review.as_ref().map(|r| (r.at.clone(), c.verified_at.clone()))).max_by(|a, b| a.0.cmp(&b.0));
    let mut stale: Vec<String> = claims.clone().into_iter().filter(|c| c.status == "STALE").flat_map(|c| c.stale_reasons.clone().unwrap_or_default()).collect();
    stale.sort();
    stale.dedup();
    let unverified = claims.clone().into_iter().filter(|c| c.status == "PROPOSED" || c.status == "STALE").count();
    json!({
        "reviewStatus": status_of(claims),
        "verifiedAtCommit": latest.as_ref().and_then(|l| l.1.clone()),
        "reviewedAt": latest.map(|l| l.0),
        "staleReasons": stale,
        "unverifiedClaims": unverified,
    })
}

fn location(e: &Option<crate::model::Evidence>) -> Value {
    match e {
        Some(e) => json!(format!("{}{}@{}", e.path, e.lines.as_ref().map(|l| format!(":{}-{}", l.start, l.end)).unwrap_or_default(), &e.commit[..e.commit.len().min(7)])),
        None => Value::Null,
    }
}

impl Tools {
    pub fn call(&self, name: &str, args: &Value) -> AppResult<Value> {
        match name {
            "list_features" => self.list_features(args),
            "get_feature" => self.get_feature(args),
            "get_flow" => self.get_flow(args),
            "get_diagram" => self.get_diagram(args),
            "search" => self.search(args),
            "who_touches" => self.who_touches(args),
            "freshness" => self.freshness(args),
            _ => Err(AppError::new("unknownTool").with("name", name)),
        }
    }

    fn models(&self, service: Option<&str>) -> AppResult<Vec<KnowledgeModel>> {
        let ids = match service {
            Some(s) => vec![s.to_string()],
            None => self.store.services()?,
        };
        let mut out = Vec::new();
        for id in ids {
            match self.store.load(&id)? {
                Some(m) => out.push(m),
                None => return Err(AppError::new("serviceNotIndexed").with("service", id)),
            }
        }
        if out.is_empty() {
            return Err(AppError::new("serviceNotIndexed"));
        }
        Ok(out)
    }

    fn feature(&self, args: &Value) -> AppResult<(KnowledgeModel, Feature)> {
        let id = arg(args, "id").ok_or_else(|| AppError::new("invalidArgument").with("name", "id"))?;
        for m in self.models(arg(args, "service"))? {
            if let Some(f) = m.features.iter().find(|f| f.id == id || f.aliases.iter().any(|a| a == id)).cloned() {
                return Ok((m, f));
            }
        }
        Err(AppError::new("featureNotFound").with("id", id))
    }

    fn summary(&self, m: &KnowledgeModel, f: &Feature) -> Value {
        json!({
            "service": m.service.id,
            "id": f.id,
            "name": first_name(&f.business_name).unwrap_or_else(|| f.technical_name.clone()),
            "businessName": f.business_name,
            "technicalName": f.technical_name,
            "description": f.description,
            "group": f.group,
            "owner": f.owner,
            "triggers": f.triggers.iter().map(|t| json!({ "type": t.kind, "name": t.technical_name, "attributes": t.attributes, "evidence": location(&t.evidence) })).collect::<Vec<_>>(),
            "status": status_of(&f.claims),
        })
    }

    fn list_features(&self, args: &Value) -> AppResult<Value> {
        let models = self.models(arg(args, "service"))?;
        let data: Vec<Value> = models
            .iter()
            .flat_map(|m| {
                m.features.iter().map(move |f| {
                    json!({
                        "service": m.service.id,
                        "id": f.id,
                        "name": first_name(&f.business_name).unwrap_or_else(|| f.technical_name.clone()),
                        "summary": first_name(&f.description).unwrap_or_else(|| f.technical_name.clone()),
                        "status": status_of(&f.claims),
                    })
                })
            })
            .collect();
        let claims: Vec<&Claim> = models.iter().flat_map(|m| m.catalog.claims.iter().chain(m.features.iter().flat_map(|f| f.claims.iter()))).collect();
        Ok(json!({ "data": data, "meta": meta(claims) }))
    }

    fn flow(&self, m: &KnowledgeModel, f: &Feature) -> Value {
        let rejected: Vec<&str> = f.claims.iter().filter(|c| c.status == "REJECTED").map(|c| c.id.as_str()).collect();
        let name = |kind: &str, id: &str| -> String {
            match kind {
                "SINK" => m.catalog.sinks.iter().find(|s| s.id == id).map(|s| first_name(&s.business_name).unwrap_or_else(|| s.technical_name.clone())).unwrap_or_else(|| id.into()),
                "TRIGGER" => f.triggers.iter().find(|t| t.id == id).map(|t| t.technical_name.clone()).unwrap_or_else(|| id.into()),
                _ => m.catalog.components.iter().find(|c| c.id == id).map(|c| first_name(&c.business_name).unwrap_or_else(|| c.technical_name.clone())).unwrap_or_else(|| id.into()),
            }
        };
        let claim_status = |id: &Option<String>| id.as_ref().and_then(|id| f.claims.iter().find(|c| &c.id == id)).map(|c| c.status.clone());
        let steps: Vec<Value> = f
            .steps
            .iter()
            .filter_map(|s| f.edges.iter().find(|e| Some(&e.id) == s.edge_id.as_ref()))
            .filter(|e| e.claim_id.as_ref().is_none_or(|c| !rejected.contains(&c.as_str())))
            .map(|e| {
                json!({
                    "from": name(&e.from.kind, &e.from.id),
                    "fromId": e.from.id,
                    "action": e.kind,
                    "to": name(&e.to.kind, &e.to.id),
                    "toId": e.to.id,
                    "label": e.label,
                    "origin": e.origin,
                    "confidence": e.confidence,
                    "reviewStatus": claim_status(&e.claim_id),
                    "evidence": location(&e.evidence),
                })
            })
            .collect();
        let sinks: Vec<Value> = f
            .sink_ids
            .iter()
            .map(|id| json!({ "id": id, "kind": m.catalog.sinks.iter().find(|s| &s.id == id).map(|s| s.kind.clone()), "name": name("SINK", id) }))
            .collect();
        let breaks: Vec<Value> = f.breaks.iter().map(|b| json!({ "reason": b.reason, "component": b.component_id, "method": b.method, "detail": b.detail, "evidence": location(&b.evidence) })).collect();
        json!({ "steps": steps, "sinks": sinks, "breaks": breaks })
    }

    fn get_feature(&self, args: &Value) -> AppResult<Value> {
        let (m, f) = self.feature(args)?;
        let mut data = self.summary(&m, &f);
        let depth = arg(args, "depth").unwrap_or("summary");
        if depth == "flow" || depth == "full" {
            let flow = self.flow(&m, &f);
            data["flow"] = flow;
        }
        if depth == "full" {
            data["claims"] = json!(f
                .claims
                .iter()
                .map(|c| json!({ "id": c.id, "kind": c.kind, "payload": c.payload, "origin": c.origin, "confidence": c.confidence, "status": c.status,
                                 "evidence": c.evidence.iter().map(|e| location(&Some(e.clone()))).collect::<Vec<_>>() }))
                .collect::<Vec<_>>());
        }
        Ok(json!({ "data": data, "meta": meta(&f.claims) }))
    }

    fn get_flow(&self, args: &Value) -> AppResult<Value> {
        let (m, f) = self.feature(args)?;
        let mut data = self.flow(&m, &f);
        data["feature"] = json!(f.id);
        data["triggers"] = self.summary(&m, &f)["triggers"].clone();
        Ok(json!({ "data": data, "meta": meta(&f.claims) }))
    }

    fn get_diagram(&self, args: &Value) -> AppResult<Value> {
        let format = arg(args, "format").unwrap_or("mermaid");
        if format != "mermaid" {
            return Err(AppError::new("formatUnsupported").with("format", format));
        }
        let (service, path, claims): (String, String, Vec<Claim>) = if arg(args, "id").is_some() {
            let (m, f) = self.feature(args)?;
            (m.service.id.clone(), format!("features/{}/flow.mmd", f.id), f.claims.clone())
        } else {
            let level = arg(args, "level").unwrap_or("context");
            if !matches!(level, "context" | "features" | "components") {
                return Err(AppError::new("invalidArgument").with("name", "level"));
            }
            let m = self.models(arg(args, "service"))?.into_iter().next().unwrap();
            let claims = m.catalog.claims.iter().chain(m.features.iter().flat_map(|f| f.claims.iter())).cloned().collect();
            (m.service.id.clone(), format!("diagrams/{level}.mmd"), claims)
        };
        let text = self.store.read_generated(&service, &path)?.ok_or_else(|| AppError::new("diagramNotFound").with("path", path.clone()))?;
        Ok(json!({ "data": { "format": "mermaid", "path": path, "diagram": text }, "meta": meta(&claims) }))
    }

    fn search(&self, args: &Value) -> AppResult<Value> {
        let query = arg(args, "query").ok_or_else(|| AppError::new("invalidArgument").with("name", "query"))?;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10).clamp(1, 50) as usize;
        let hits = FtsIndex::new(&self.store).search(query, arg(args, "service"), limit)?;
        let models = self.models(arg(args, "service")).unwrap_or_default();
        let claims: Vec<&Claim> = hits
            .iter()
            .filter_map(|h| models.iter().find(|m| m.service.id == h.service).and_then(|m| m.features.iter().find(|f| f.id == h.feature_id)))
            .flat_map(|f| f.claims.iter())
            .collect();
        Ok(json!({ "data": hits, "meta": meta(claims) }))
    }

    fn who_touches(&self, args: &Value) -> AppResult<Value> {
        let needle = arg(args, "sink").ok_or_else(|| AppError::new("invalidArgument").with("name", "sink"))?.to_lowercase();
        let mut data = Vec::new();
        let mut claims: Vec<Claim> = Vec::new();
        for m in self.models(arg(args, "service"))? {
            let sinks: Vec<&crate::model::Sink> = m
                .catalog
                .sinks
                .iter()
                .filter(|s| s.id.to_lowercase() == needle || s.technical_name.to_lowercase() == needle || s.business_name.values().any(|n| n.to_lowercase() == needle))
                .collect();
            for f in &m.features {
                let rejected: Vec<&str> = f.claims.iter().filter(|c| c.status == "REJECTED").map(|c| c.id.as_str()).collect();
                for e in f.edges.iter().filter(|e| e.claim_id.as_ref().is_none_or(|c| !rejected.contains(&c.as_str()))) {
                    let sink = sinks.iter().find(|s| (e.to.kind == "SINK" && e.to.id == s.id) || (e.from.kind == "SINK" && e.from.id == s.id));
                    let Some(sink) = sink else { continue };
                    let component = if e.to.kind == "SINK" { &e.from.id } else { &e.to.id };
                    data.push(json!({
                        "service": m.service.id, "feature": f.id, "featureName": first_name(&f.business_name).unwrap_or_else(|| f.technical_name.clone()),
                        "sink": sink.id, "action": e.kind, "component": component, "operation": e.label,
                        "origin": e.origin, "confidence": e.confidence, "evidence": location(&e.evidence),
                        "reviewStatus": e.claim_id.as_ref().and_then(|id| f.claims.iter().find(|c| &c.id == id)).map(|c| c.status.clone()),
                    }));
                    claims.extend(e.claim_id.as_ref().and_then(|id| f.claims.iter().find(|c| &c.id == id)).cloned());
                }
            }
        }
        Ok(json!({ "data": data, "meta": meta(&claims) }))
    }

    fn freshness(&self, args: &Value) -> AppResult<Value> {
        if arg(args, "id").is_some() {
            let (m, f) = self.feature(args)?;
            let meta = meta(&f.claims);
            return Ok(json!({ "data": { "service": m.service.id, "feature": f.id, "lastAnalyzedCommit": m.service.last_analyzed_commit, "freshness": meta.clone() }, "meta": meta }));
        }
        let models = self.models(arg(args, "service"))?;
        let data: Vec<Value> = models
            .iter()
            .map(|m| {
                let claims: Vec<&Claim> = m.catalog.claims.iter().chain(m.features.iter().flat_map(|f| f.claims.iter())).collect();
                json!({ "service": m.service.id, "lastAnalyzedCommit": m.service.last_analyzed_commit, "freshness": meta(claims),
                        "features": m.features.iter().map(|f| json!({ "id": f.id, "status": status_of(&f.claims) })).collect::<Vec<_>>() })
            })
            .collect();
        let claims: Vec<&Claim> = models.iter().flat_map(|m| m.catalog.claims.iter().chain(m.features.iter().flat_map(|f| f.claims.iter()))).collect();
        Ok(json!({ "data": data, "meta": meta(claims) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::fixture_store;
    use crate::model::{GeneratedFile, ReviewInfo};

    fn tools() -> (tempfile::TempDir, Tools) {
        let (dir, store, model) = fixture_store();
        FtsIndex::new(&store).index(&model).unwrap();
        store.write_generated("refunds", &[GeneratedFile { relative_path: "diagrams/context.mmd".into(), content: "flowchart LR\n".into() }]).unwrap();
        (dir, Tools { store })
    }

    #[test]
    fn lists_features_with_trust_metadata() {
        let (_d, t) = tools();
        let r = t.call("list_features", &json!({})).unwrap();
        assert_eq!(r["data"].as_array().unwrap().len(), 6);
        assert_eq!(r["meta"]["reviewStatus"], "DRAFT");
        assert!(r["meta"]["unverifiedClaims"].as_u64().unwrap() > 0);
    }

    #[test]
    fn gives_a_feature_at_three_depths_and_its_flow() {
        let (_d, t) = tools();
        let summary = t.call("get_feature", &json!({ "id": "refunds/create-refund" })).unwrap();
        assert!(summary["data"].get("flow").is_none());
        let full = t.call("get_feature", &json!({ "id": "refunds/create-refund", "depth": "full" })).unwrap();
        assert!(full["data"]["claims"].as_array().unwrap().len() > 5);
        let flow = t.call("get_flow", &json!({ "id": "refunds/create-refund" })).unwrap();
        let steps = flow["data"]["steps"].as_array().unwrap();
        assert!(steps.iter().any(|s| s["action"] == "WRITE" && s["toId"] == "db_table:refunds"));
        assert!(steps[0]["evidence"].as_str().unwrap().contains("RefundController.kt:"));
        assert_eq!(t.call("get_flow", &json!({ "id": "nope" })).unwrap_err().code, "featureNotFound");
    }

    #[test]
    fn answers_who_touches_a_table() {
        let (_d, t) = tools();
        let r = t.call("who_touches", &json!({ "sink": "refunds" })).unwrap();
        let features: std::collections::BTreeSet<&str> = r["data"].as_array().unwrap().iter().map(|x| x["feature"].as_str().unwrap()).collect();
        assert!(features.contains("refunds/create-refund"));
        assert!(features.contains("approvals/approve"));
        assert!(features.contains("reconciliation/reconcile"));
        assert!(r["data"].as_array().unwrap().iter().any(|x| x["action"] == "WRITE"));
    }

    #[test]
    fn searches_and_reads_diagrams() {
        let (_d, t) = tools();
        let r = t.call("search", &json!({ "query": "approve" })).unwrap();
        assert_eq!(r["data"][0]["featureId"], "approvals/approve");
        assert_eq!(t.call("get_diagram", &json!({ "level": "context" })).unwrap()["data"]["diagram"], "flowchart LR\n");
        assert_eq!(t.call("get_diagram", &json!({ "level": "context", "format": "svg" })).unwrap_err().code, "formatUnsupported");
        assert_eq!(t.call("get_diagram", &json!({ "id": "approvals/approve" })).unwrap_err().code, "diagramNotFound");
    }

    #[test]
    fn freshness_reports_verified_commit_and_stale_reasons() {
        let (_d, t) = tools();
        let mut m = t.store.load("refunds").unwrap().unwrap();
        for c in m.features[0].claims.iter_mut() {
            c.status = "CONFIRMED".into();
            c.verified_at = Some("abc1234".into());
            c.review = Some(ReviewInfo { reviewer: "ann".into(), at: "2026-11-18T10:00:00Z".into(), action: "CONFIRM".into(), comment: None });
        }
        m.features[0].claims[0].status = "STALE".into();
        m.features[0].claims[0].stale_reasons = Some(vec!["changed:src/A.kt".into()]);
        t.store.save("refunds", &m).unwrap();
        let r = t.call("freshness", &json!({ "id": m.features[0].id })).unwrap();
        assert_eq!(r["meta"]["reviewStatus"], "STALE");
        assert_eq!(r["meta"]["verifiedAtCommit"], "abc1234");
        assert_eq!(r["meta"]["staleReasons"], json!(["changed:src/A.kt"]));
        assert_eq!(t.call("freshness", &json!({ "service": "other" })).unwrap_err().code, "serviceNotIndexed");
    }
}
