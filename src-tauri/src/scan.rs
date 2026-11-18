//! Stage Scan on the Rust side: every applicable extractor and every context source, under the common
//! skip/required/warning policy. The TypeScript stage only calls this and records the result.
use crate::context::{self, ContextSource};
use crate::error::{AppError, AppResult};
use crate::extract::{self, Extractor};
use crate::model::facts::{ContextFacts, SourceFacts};
use crate::repo::RepoSnapshot;
use serde::Serialize;

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

pub fn scan(repo: &RepoSnapshot) -> AppResult<ScanResult> {
    scan_with(repo, &extract::registry(), &context::registry())
}

pub fn scan_with(repo: &RepoSnapshot, extractors: &[Box<dyn Extractor>], sources: &[Box<dyn ContextSource>]) -> AppResult<ScanResult> {
    let applicable: Vec<_> = extractors.iter().filter(|e| e.supports(repo)).collect();
    if applicable.is_empty() {
        let available: Vec<_> = extractors.iter().map(|e| e.id()).collect();
        return Err(AppError::new("noExtractor").with("available", available.join(",")));
    }
    let mut steps = Vec::new();
    let mut facts = SourceFacts::default();
    for e in applicable {
        match e.extract(repo) {
            Ok(f) => {
                facts.extend(f);
                steps.push(ScanStep { kind: "extractor", id: e.id(), version: Some(e.version()), status: "done", error: None });
            }
            Err(err) if e.required() => return Err(err),
            Err(err) => steps.push(ScanStep { kind: "extractor", id: e.id(), version: Some(e.version()), status: "failed", error: Some(err) }),
        }
    }
    let mut context = ContextFacts::default();
    for s in sources {
        match s.collect(repo) {
            Ok(c) => {
                context.extend(c);
                steps.push(ScanStep { kind: "contextSource", id: s.id(), version: None, status: "done", error: None });
            }
            Err(err) if s.required() => return Err(err),
            Err(err) => steps.push(ScanStep { kind: "contextSource", id: s.id(), version: None, status: "failed", error: Some(err) }),
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
        fn extract(&self, _: &RepoSnapshot) -> AppResult<SourceFacts> {
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
        let err = scan_with(&r, &[Box::new(Fake(false, false))], &[]).unwrap_err();
        assert_eq!(err.code, "noExtractor");
    }

    #[test]
    fn scans_the_fixture_with_the_registered_sources() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/refunds-service");
        let res = scan(&RepoSnapshot::open(path.to_str().unwrap()).unwrap()).unwrap();
        assert!(res.steps.iter().all(|s| s.status == "done"), "{:?}", res.steps);
        assert_eq!(res.steps.iter().filter(|s| s.kind == "extractor").map(|s| s.id).collect::<Vec<_>>(), vec!["kotlin-spring"]);
        assert_eq!(res.facts.triggers.len(), 7);
        let json = serde_json::to_value(&res).unwrap();
        // Contract with src/types.ts (ScanResult / SourceFacts).
        assert!(json["facts"]["sinkAccesses"].is_array());
        assert!(json["facts"]["components"][0]["isInterface"].is_boolean());
        assert!(json["context"]["apiOperations"].is_array());
    }

    #[test]
    fn optional_extractor_failure_is_reported_not_fatal() {
        let (_d, r) = repo();
        let res = scan_with(&r, &[Box::new(Fake(true, true))], &[]).unwrap();
        assert_eq!(res.steps[0].status, "failed");
    }
}
