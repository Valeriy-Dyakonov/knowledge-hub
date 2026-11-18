//! Knowledge base on a local folder (docs/07-storage.md):
//! `<service>/service.yaml`, `<service>/features/<feature-id>/feature.yaml`, generated views next to them,
//! and git-ignored working data in `<service>/.state/`.
use crate::error::{AppError, AppResult};
use crate::model::{Catalog, Claim, Component, Feature, GeneratedFile, KnowledgeModel, Service, Sink, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component as PathPart, Path, PathBuf};

pub const SERVICE_FILE: &str = "service.yaml";
pub const FEATURE_FILE: &str = "feature.yaml";
pub const FEATURES_DIR: &str = "features";
pub const DATABASE_FILE: &str = "database.yaml";
pub const CONFIG_FILE: &str = "config.yaml";
pub const STATE_DIR: &str = ".state";

/// A saved previous version of a feature. Part of the store contract; no screen shows the history yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRevision {
    pub feature_id: String,
    pub at: String,
    pub reference: String,
}

pub trait KnowledgeStore {
    fn services(&self) -> AppResult<Vec<String>>;
    fn load(&self, service: &str) -> AppResult<Option<KnowledgeModel>>;
    fn save(&self, service: &str, model: &KnowledgeModel) -> AppResult<()>;
    #[allow(dead_code)]
    fn history(&self, service: &str, feature: &str) -> AppResult<Vec<ModelRevision>>;
    fn write_generated(&self, service: &str, files: &[GeneratedFile]) -> AppResult<()>;
    fn read_generated(&self, service: &str, relative_path: &str) -> AppResult<Option<String>>;
}

/// service.yaml: everything service-wide.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceDocument {
    schema_version: u32,
    service: Service,
    #[serde(default)]
    components: Vec<Component>,
    #[serde(default)]
    sinks: Vec<Sink>,
    #[serde(default)]
    claims: Vec<Claim>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureDocument {
    schema_version: u32,
    feature: Feature,
}

pub struct FsStore {
    pub root: PathBuf,
}

impl FsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn service_dir(&self, service: &str) -> AppResult<PathBuf> {
        Ok(self.root.join(safe_relative(service)?))
    }

    /// `<service>/.state`, created on demand.
    pub fn state_dir(&self, service: &str) -> AppResult<PathBuf> {
        let dir = self.service_dir(service)?.join(STATE_DIR);
        fs::create_dir_all(&dir).map_err(AppError::store)?;
        Ok(dir)
    }

    fn feature_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = fs::read_dir(&d) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.file_name().is_some_and(|n| n == FEATURE_FILE) {
                    out.push(p);
                }
            }
        }
        out.sort();
        out
    }
}

fn check_version(version: u32, file: &Path) -> AppResult<()> {
    // Older versions would be migrated here; there is only version 1 so far.
    if version > SCHEMA_VERSION {
        return Err(AppError::new("schemaUnsupported").with("version", version).with("file", file.display().to_string()));
    }
    Ok(())
}

fn read_yaml<T: for<'de> Deserialize<'de>>(file: &Path) -> AppResult<T> {
    let text = fs::read_to_string(file).map_err(AppError::store)?;
    serde_yaml::from_str(&text).map_err(|e| AppError::new("storeFailed").with("file", file.display().to_string()).with("detail", e.to_string()))
}

fn write_if_changed(file: &Path, content: &str) -> AppResult<bool> {
    if fs::read_to_string(file).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(AppError::store)?;
    }
    fs::write(file, content).map_err(AppError::store)?;
    Ok(true)
}

/// Relative path inside the knowledge base: no absolute paths, no `..`.
pub fn safe_relative(path: &str) -> AppResult<PathBuf> {
    let clean = path.replace('\\', "/");
    let clean = clean.trim_matches('/');
    let p = Path::new(clean);
    if clean.is_empty() || p.components().any(|c| !matches!(c, PathPart::Normal(_))) {
        return Err(AppError::new("invalidArgument").with("path", path));
    }
    Ok(p.to_path_buf())
}

impl KnowledgeStore for FsStore {
    fn services(&self) -> AppResult<Vec<String>> {
        let Ok(entries) = fs::read_dir(&self.root) else { return Ok(vec![]) };
        let mut out: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().join(SERVICE_FILE).is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        out.sort();
        Ok(out)
    }

    fn load(&self, service: &str) -> AppResult<Option<KnowledgeModel>> {
        let dir = self.service_dir(service)?;
        let file = dir.join(SERVICE_FILE);
        if !file.is_file() {
            return Ok(None);
        }
        let doc: ServiceDocument = read_yaml(&file)?;
        check_version(doc.schema_version, &file)?;
        let mut features = Vec::new();
        for f in Self::feature_files(&dir.join(FEATURES_DIR)) {
            let fd: FeatureDocument = read_yaml(&f)?;
            check_version(fd.schema_version, &f)?;
            features.push(fd.feature);
        }
        features.sort_by(|a, b| a.id.cmp(&b.id));
        let extra = |name: &str| -> AppResult<Option<serde_json::Value>> {
            let f = dir.join(name);
            if !f.is_file() {
                return Ok(None);
            }
            Ok(Some(read_yaml(&f)?))
        };
        Ok(Some(KnowledgeModel {
            schema_version: SCHEMA_VERSION,
            service: doc.service,
            catalog: Catalog { components: doc.components, sinks: doc.sinks, claims: doc.claims },
            features,
            database: extra(DATABASE_FILE)?,
            config: extra(CONFIG_FILE)?,
        }))
    }

    fn save(&self, service: &str, model: &KnowledgeModel) -> AppResult<()> {
        let dir = self.service_dir(service)?;
        fs::create_dir_all(&dir).map_err(AppError::store)?;
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            fs::write(&ignore, format!("{STATE_DIR}/\n")).map_err(AppError::store)?;
        }
        let doc = ServiceDocument {
            schema_version: SCHEMA_VERSION,
            service: model.service.clone(),
            components: model.catalog.components.clone(),
            sinks: model.catalog.sinks.clone(),
            claims: model.catalog.claims.clone(),
        };
        write_if_changed(&dir.join(SERVICE_FILE), &serde_yaml::to_string(&doc).map_err(AppError::store)?)?;
        // Database and configuration in files of their own: large, and diffs stay readable.
        for (name, value) in [(DATABASE_FILE, &model.database), (CONFIG_FILE, &model.config)] {
            match value {
                Some(v) => {
                    write_if_changed(&dir.join(name), &serde_yaml::to_string(v).map_err(AppError::store)?)?;
                }
                None => {
                    let _ = fs::remove_file(dir.join(name));
                }
            }
        }

        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string();
        let features_dir = dir.join(FEATURES_DIR);
        let mut keep = Vec::new();
        for feature in &model.features {
            let fdir = features_dir.join(safe_relative(&feature.id)?);
            let file = fdir.join(FEATURE_FILE);
            let content = serde_yaml::to_string(&FeatureDocument { schema_version: SCHEMA_VERSION, feature: feature.clone() }).map_err(AppError::store)?;
            if let Ok(old) = fs::read_to_string(&file) {
                if old != content {
                    // Previous revision goes to history so a feature can be compared or rolled back.
                    let hist = dir.join(STATE_DIR).join("history").join(safe_relative(&feature.id)?);
                    fs::create_dir_all(&hist).map_err(AppError::store)?;
                    fs::write(hist.join(format!("{stamp}.yaml")), old).map_err(AppError::store)?;
                }
            }
            write_if_changed(&file, &content)?;
            keep.push(fdir);
        }
        // Folders of features that left the model are removed with their generated views.
        for file in Self::feature_files(&features_dir) {
            let fdir = file.parent().unwrap().to_path_buf();
            if !keep.contains(&fdir) {
                if let Ok(entries) = fs::read_dir(&fdir) {
                    for e in entries.flatten().filter(|e| e.path().is_file()) {
                        let _ = fs::remove_file(e.path());
                    }
                }
                let mut d = fdir.as_path();
                while d != features_dir && fs::remove_dir(d).is_ok() {
                    d = d.parent().unwrap();
                }
            }
        }
        Ok(())
    }

    fn history(&self, service: &str, feature: &str) -> AppResult<Vec<ModelRevision>> {
        let dir = self.service_dir(service)?.join(STATE_DIR).join("history").join(safe_relative(feature)?);
        let Ok(entries) = fs::read_dir(&dir) else { return Ok(vec![]) };
        let mut out: Vec<ModelRevision> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let at = name.strip_suffix(".yaml")?.to_string();
                Some(ModelRevision { feature_id: feature.into(), at, reference: format!("{STATE_DIR}/history/{feature}/{name}") })
            })
            .collect();
        out.sort_by(|a, b| a.at.cmp(&b.at));
        Ok(out)
    }

    fn write_generated(&self, service: &str, files: &[GeneratedFile]) -> AppResult<()> {
        let dir = self.service_dir(service)?;
        for f in files {
            write_if_changed(&dir.join(safe_relative(&f.relative_path)?), &f.content)?;
        }
        Ok(())
    }

    fn read_generated(&self, service: &str, relative_path: &str) -> AppResult<Option<String>> {
        let file = self.service_dir(service)?.join(safe_relative(relative_path)?);
        Ok(fs::read_to_string(file).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn model(features: Vec<Feature>) -> KnowledgeModel {
        KnowledgeModel {
            schema_version: SCHEMA_VERSION,
            service: Service { id: "svc".into(), name: "Svc".into(), repo: "/r".into(), branch: None, stack: vec![], last_analyzed_commit: Some("abc".into()) },
            catalog: Catalog::default(),
            features,
            database: None,
            config: None,
        }
    }

    fn feature(id: &str, name: &str) -> Feature {
        Feature {
            id: id.into(),
            group: id.split('/').next().unwrap().into(),
            technical_name: name.into(),
            business_name: BTreeMap::new(),
            description: BTreeMap::new(),
            owner: None,
            aliases: vec![],
            triggers: vec![],
            component_ids: vec![],
            sink_ids: vec![],
            edges: vec![],
            steps: vec![],
            breaks: vec![],
            claims: vec![],
        }
    }

    // Contract of KnowledgeStore: every implementation must pass these.
    #[test]
    fn round_trips_history_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsStore::new(dir.path());
        assert!(store.load("svc").unwrap().is_none());

        let m = model(vec![feature("refunds/create", "POST /refunds"), feature("refunds/get", "GET /refunds/{id}")]);
        store.save("svc", &m).unwrap();
        assert_eq!(store.load("svc").unwrap().unwrap(), m);
        assert_eq!(store.services().unwrap(), vec!["svc"]);
        assert!(dir.path().join("svc/.gitignore").is_file());

        let changed = model(vec![feature("refunds/create", "POST /api/refunds")]);
        store.save("svc", &changed).unwrap();
        assert_eq!(store.load("svc").unwrap().unwrap(), changed);
        assert_eq!(store.history("svc", "refunds/create").unwrap().len(), 1);
        assert!(!dir.path().join("svc/features/refunds/get").exists());
    }

    /// The model produced by the TypeScript pipeline (written by src/lib/stages/golden.test.ts) must survive the
    /// serde mirror and a save/load cycle without losing a field.
    #[test]
    fn round_trips_the_model_written_by_the_frontend() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/refunds-service.model.json");
        let original: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let model: KnowledgeModel = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(serde_json::to_value(&model).unwrap(), original);

        let dir = tempfile::tempdir().unwrap();
        let store = FsStore::new(dir.path());
        store.save("refunds", &model).unwrap();
        assert_eq!(serde_json::to_value(store.load("refunds").unwrap().unwrap()).unwrap(), original);
    }

    #[test]
    fn generated_files_stay_inside_the_service() {
        let dir = tempfile::tempdir().unwrap();
        let store = FsStore::new(dir.path());
        store.write_generated("svc", &[GeneratedFile { relative_path: "diagrams/context.mmd".into(), content: "x".into() }]).unwrap();
        assert_eq!(store.read_generated("svc", "diagrams/context.mmd").unwrap().as_deref(), Some("x"));
        let bad = GeneratedFile { relative_path: "../evil".into(), content: String::new() };
        assert_eq!(store.write_generated("svc", &[bad]).unwrap_err().code, "invalidArgument");
    }

    #[test]
    fn refuses_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("svc")).unwrap();
        fs::write(dir.path().join("svc/service.yaml"), "schemaVersion: 99\nservice: {id: svc, name: s, repo: r}\n").unwrap();
        assert_eq!(FsStore::new(dir.path()).load("svc").unwrap_err().code, "schemaUnsupported");
    }
}
