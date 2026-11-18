//! Stage Scan on the Rust side: every applicable extractor and every context source, under the common
//! skip/required/warning policy. The TypeScript stage only calls this and records the result.
use crate::context::{self, ContextSource};
use crate::error::{AppError, AppResult};
use crate::extract::{self, Extractor};
use crate::model::facts::{ContextFacts, SourceFacts};
use crate::repo::RepoSnapshot;
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStep {
    pub kind: &'static str,
    pub id: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<&'static str>,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    /// What the step found (files, components, triggers... / properties, tables...).
    pub stats: BTreeMap<&'static str, usize>,
    pub millis: u64,
}

/// Live progress of the scan, sent to the UI as `scan-progress` events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub kind: &'static str,
    pub id: &'static str,
    pub current: usize,
    pub total: usize,
    pub item: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub facts: SourceFacts,
    pub context: ContextFacts,
    pub steps: Vec<ScanStep>,
}

pub fn scan(repo: &RepoSnapshot, report: &dyn Fn(ScanProgress)) -> AppResult<ScanResult> {
    scan_with(repo, &extract::registry(), &context::registry(), report)
}

fn fact_stats(f: &SourceFacts, files: usize) -> BTreeMap<&'static str, usize> {
    BTreeMap::from([
        ("files", files),
        ("components", f.components.len()),
        ("triggers", f.triggers.len()),
        ("calls", f.calls.len()),
        ("sinkAccesses", f.sink_accesses.len()),
        ("events", f.events.len()),
        ("unresolved", f.unresolved.len()),
    ])
}

fn context_stats(c: &ContextFacts) -> BTreeMap<&'static str, usize> {
    BTreeMap::from([("properties", c.properties.len()), ("apiOperations", c.api_operations.len()), ("tables", c.tables.len()), ("ownership", c.ownership.len())])
}

pub fn scan_with(
    repo: &RepoSnapshot,
    extractors: &[Box<dyn Extractor>],
    sources: &[Box<dyn ContextSource>],
    report: &dyn Fn(ScanProgress),
) -> AppResult<ScanResult> {
    let applicable: Vec<_> = extractors.iter().filter(|e| e.supports(repo)).collect();
    if applicable.is_empty() {
        let available: Vec<_> = extractors.iter().map(|e| e.id()).collect();
        return Err(AppError::new("noExtractor").with("available", available.join(",")));
    }
    let mut steps = Vec::new();
    let mut facts = SourceFacts::default();
    for e in applicable {
        let started = Instant::now();
        let files = std::cell::Cell::new(0usize);
        let progress = |current: usize, total: usize, item: &str| {
            files.set(total);
            report(ScanProgress { kind: "extractor", id: e.id(), current, total, item: item.to_string() });
        };
        let result = e.extract(repo, &progress);
        let millis = started.elapsed().as_millis() as u64;
        match result {
            Ok(f) => {
                let stats = fact_stats(&f, files.get());
                facts.extend(f);
                steps.push(ScanStep { kind: "extractor", id: e.id(), version: Some(e.version()), status: "done", error: None, stats, millis });
            }
            Err(err) if e.required() => return Err(err),
            Err(err) => steps.push(ScanStep { kind: "extractor", id: e.id(), version: Some(e.version()), status: "failed", error: Some(err), stats: BTreeMap::new(), millis }),
        }
    }
    let mut context = ContextFacts::default();
    for (i, s) in sources.iter().enumerate() {
        report(ScanProgress { kind: "contextSource", id: s.id(), current: i + 1, total: sources.len(), item: String::new() });
        let started = Instant::now();
        let result = s.collect(repo);
        let millis = started.elapsed().as_millis() as u64;
        match result {
            Ok(c) => {
                let stats = context_stats(&c);
                context.extend(c);
                steps.push(ScanStep { kind: "contextSource", id: s.id(), version: None, status: "done", error: None, stats, millis });
            }
            Err(err) if s.required() => return Err(err),
            Err(err) => steps.push(ScanStep { kind: "contextSource", id: s.id(), version: None, status: "failed", error: Some(err), stats: BTreeMap::new(), millis }),
        }
    }
    Ok(ScanResult { commit: repo.commit.clone(), branch: repo.branch.clone(), facts, context, steps })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(bool, bool);
    impl Extractor for Fake {
        fn id(&self) -> &'static str { "fake" }
        fn version(&self) -> &'static str { "1" }
        fn supports(&self, _: &RepoSnapshot) -> bool { self.0 }
        fn extract(&self, _: &RepoSnapshot, _: crate::extract::Progress) -> AppResult<SourceFacts> {
            if self.1 { Err(AppError::raw("boom")) } else { Ok(SourceFacts::default()) }
        }
    }

    fn repo() -> (tempfile::TempDir, RepoSnapshot) {
        let dir = tempfile::tempdir().unwrap();
        let r = RepoSnapshot::open(dir.path().to_str().unwrap()).unwrap();
        (dir, r)
    }

    #[test]
    fn needs_an_applicable_extractor() {
        let (_d, r) = repo();
        let err = scan_with(&r, &[Box::new(Fake(false, false))], &[], &|_| {}).unwrap_err();
        assert_eq!(err.code, "noExtractor");
    }

    #[test]
    fn scans_the_fixture_with_the_registered_sources() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/refunds-service");
        let seen = std::cell::RefCell::new(Vec::new());
        let res = scan(&RepoSnapshot::open(path.to_str().unwrap()).unwrap(), &|p| seen.borrow_mut().push(p)).unwrap();
        let seen = seen.into_inner();
        assert!(seen.iter().any(|p| p.kind == "extractor" && p.item.ends_with("RefundService.kt")));
        assert_eq!(seen.iter().filter(|p| p.kind == "contextSource").count(), 4);
        assert_eq!(res.steps[0].stats["files"], 19);
        assert_eq!(res.steps[0].stats["triggers"], 9);
        assert!(res.steps.iter().all(|s| s.status == "done"), "{:?}", res.steps);
        assert_eq!(res.steps.iter().filter(|s| s.kind == "extractor").map(|s| s.id).collect::<Vec<_>>(), vec!["kotlin-spring"]);
        assert_eq!(res.facts.triggers.len(), 9);
        let mut json = serde_json::to_value(&res).unwrap();
        for step in json["steps"].as_array_mut().unwrap() {
            step["millis"] = serde_json::json!(0);
        }
        // Contract with src/types.ts (ScanResult / SourceFacts).
        assert!(json["facts"]["sinkAccesses"].is_array());
        assert!(json["facts"]["components"][0]["isInterface"].is_boolean());
        assert!(json["context"]["apiOperations"].is_array());

        // The same JSON feeds the TypeScript golden test of Discover/Trace/Assemble (src/lib/stages/golden.test.ts).
        let dump = path.parent().unwrap().join("refunds-service.scan.json");
        let text = serde_json::to_string_pretty(&json).unwrap() + "\n";
        if std::env::var("UPDATE_GOLDEN").is_ok() || !dump.exists() {
            std::fs::write(&dump, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&dump).unwrap().replace("\r\n", "\n"), text, "scan JSON differs from {}", dump.display());
    }

    #[test]
    fn optional_extractor_failure_is_reported_not_fatal() {
        let (_d, r) = repo();
        let res = scan_with(&r, &[Box::new(Fake(true, true))], &[], &|_| {}).unwrap();
        assert_eq!(res.steps[0].status, "failed");
    }
}
