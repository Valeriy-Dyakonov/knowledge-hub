//! Spring configuration (`application.yml`/`.properties`, profiles) flattened to `a.b.c -> value`.
//! Values of secret-looking keys are masked before they leave this module.
use super::ContextSource;
use crate::error::AppResult;
use crate::model::facts::ContextFacts;
use crate::redact;
use crate::repo::RepoSnapshot;
use serde_yaml::Value;
use std::collections::BTreeMap;

pub struct SpringConfig;

/// (is yaml, is a base file) for configuration files under `src/main/resources/`.
fn file_kind(path: &str) -> Option<(bool, bool)> {
    let name = path.rsplit('/').next()?;
    if !path.contains("src/main/resources/") {
        return None;
    }
    let (stem, ext) = name.rsplit_once('.')?;
    let yaml = matches!(ext, "yml" | "yaml");
    if !yaml && ext != "properties" {
        return None;
    }
    let base = stem == "application" || stem == "bootstrap";
    let profile = stem.starts_with("application-");
    (base || profile).then_some((yaml, base))
}

pub fn flatten(prefix: &str, v: &Value, out: &mut BTreeMap<String, String>) {
    match v {
        Value::Mapping(m) => {
            for (k, val) in m {
                let key = match k {
                    Value::String(s) => s.clone(),
                    other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
                };
                let full = if prefix.is_empty() { key } else { format!("{prefix}.{key}") };
                flatten(&full, val, out);
            }
        }
        Value::Sequence(seq) => {
            for (i, val) in seq.iter().enumerate() {
                flatten(&format!("{prefix}[{i}]"), val, out);
            }
        }
        Value::Null => {}
        Value::String(s) => {
            out.entry(prefix.to_string()).or_insert_with(|| s.clone());
        }
        Value::Tagged(t) => flatten(prefix, &t.value, out),
        other => {
            out.entry(prefix.to_string()).or_insert_with(|| serde_yaml::to_string(other).unwrap_or_default().trim().to_string());
        }
    }
}

fn properties(text: &str, out: &mut BTreeMap<String, String>) {
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        if let Some(i) = line.find(['=', ':']) {
            out.entry(line[..i].trim().to_string()).or_insert_with(|| line[i + 1..].trim().to_string());
        }
    }
}

impl ContextSource for SpringConfig {
    fn id(&self) -> &'static str {
        "spring-config"
    }

    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let mut files: Vec<(String, bool, bool)> = repo
            .files(|p| file_kind(p).is_some())
            .into_iter()
            .filter_map(|p| file_kind(&p).map(|(yaml, base)| (p, yaml, base)))
            .collect();
        // Base files first: their values win; profile files only add keys that are missing.
        files.sort_by_key(|(p, _, base)| (!*base, p.clone()));
        let mut raw = BTreeMap::new();
        for (path, yaml, _) in files {
            let text = repo.read(&path)?;
            if yaml {
                for doc in serde_yaml::Deserializer::from_str(&text) {
                    if let Ok(v) = <Value as serde::Deserialize>::deserialize(doc) {
                        flatten("", &v, &mut raw);
                    }
                }
            } else {
                properties(&text, &mut raw);
            }
        }
        let properties = raw.into_iter().map(|(k, v)| {
            let masked = redact::value(&k, &v);
            (k, masked)
        }).collect();
        Ok(ContextFacts { properties, ..Default::default() })
    }
}
