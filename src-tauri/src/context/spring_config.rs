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

/// Profile of a file name: `application-prod.yml` -> Some("prod"), `application.yml` -> None.
fn profile_of(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let stem = name.rsplit_once('.')?.0;
    stem.strip_prefix("application-").map(String::from)
}

/// Line of the first `key:` / `key=` for the last segment of a property, for "where is it defined".
fn line_of(text: &str, key: &str) -> u32 {
    let last = key.rsplit('.').next().unwrap_or(key).split('[').next().unwrap_or(key);
    text.lines()
        .position(|l| {
            let t = l.trim_start();
            t.starts_with(&format!("{key}=")) || t.starts_with(&format!("{key}:")) || t.starts_with(&format!("{last}:")) || t.starts_with(&format!("{last}="))
        })
        .map(|i| i as u32 + 1)
        .unwrap_or(1)
}

impl ContextSource for SpringConfig {
    fn id(&self) -> &'static str {
        "spring-config"
    }

    /// Base files give `properties`; `application-<profile>` files and YAML documents with
    /// `spring.config.activate.on-profile` (or legacy `spring.profiles`) give `profiles`. Secrets are masked.
    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let mut files: Vec<(String, bool, bool)> = repo
            .files(|p| file_kind(p).is_some())
            .into_iter()
            .filter_map(|p| file_kind(&p).map(|(yaml, base)| (p, yaml, base)))
            .collect();
        files.sort_by_key(|(p, _, base)| (!*base, p.clone()));
        let mut facts = ContextFacts::default();
        for (path, yaml, _) in files {
            let text = repo.read(&path)?;
            let file_profile = profile_of(&path);
            let mut docs: Vec<(Option<String>, BTreeMap<String, String>)> = Vec::new();
            if yaml {
                for doc in serde_yaml::Deserializer::from_str(&text) {
                    if let Ok(v) = <Value as serde::Deserialize>::deserialize(doc) {
                        let mut flat = BTreeMap::new();
                        flatten("", &v, &mut flat);
                        let on = flat.remove("spring.config.activate.on-profile").or_else(|| flat.remove("spring.profiles"));
                        docs.push((on.or_else(|| file_profile.clone()), flat));
                    }
                }
            } else {
                let mut flat = BTreeMap::new();
                properties(&text, &mut flat);
                docs.push((file_profile.clone(), flat));
            }
            for (profile, flat) in docs {
                for (k, v) in flat {
                    let masked = redact::value(&k, &v);
                    facts.property_sources.entry(k.clone()).or_insert_with(|| format!("{path}:{}", line_of(&text, &k)));
                    match &profile {
                        None => {
                            facts.properties.entry(k).or_insert(masked);
                        }
                        Some(p) => {
                            facts.profiles.entry(p.clone()).or_default().entry(k).or_insert(masked);
                        }
                    }
                }
            }
        }
        Ok(facts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_base_and_profile_values() {
        let dir = tempfile::tempdir().unwrap();
        let res = dir.path().join("src/main/resources");
        std::fs::create_dir_all(&res).unwrap();
        std::fs::write(res.join("application.yml"), "a:\n  b: base\n---\nspring:\n  config:\n    activate:\n      on-profile: dev\na:\n  b: dev-value\n").unwrap();
        std::fs::write(res.join("application-prod.yml"), "a:\n  b: prod-value\ndb:\n  password: secret\n").unwrap();
        let repo = RepoSnapshot::open(dir.path().to_str().unwrap()).unwrap();
        let f = SpringConfig.collect(&repo).unwrap();
        assert_eq!(f.properties["a.b"], "base");
        assert_eq!(f.profiles["dev"]["a.b"], "dev-value");
        assert_eq!(f.profiles["prod"]["a.b"], "prod-value");
        assert_eq!(f.profiles["prod"]["db.password"], redact::MASK);
        assert_eq!(f.property_sources["a.b"], "src/main/resources/application.yml:2");
    }
}
