//! Golden test: facts extracted from `tests/fixtures/refunds-service` must match `refunds-service.golden.txt`.
//! After an intended change, regenerate with `UPDATE_GOLDEN=1 cargo test golden` and review the diff.
use super::KotlinSpringExtractor;
use crate::extract::Extractor;
use crate::model::facts::SourceFacts;
use crate::model::Evidence;
use crate::repo::RepoSnapshot;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn at(e: &Option<Evidence>) -> String {
    e.as_ref().map(|e| format!(" @{}:{}", e.path, e.lines.as_ref().map(|l| format!("{}-{}", l.start, l.end)).unwrap_or_default())).unwrap_or_default()
}

fn attrs(m: &BTreeMap<String, String>) -> String {
    m.iter().map(|(k, v)| format!(" {k}={v}")).collect()
}

/// One sorted line per fact: readable in a diff and independent of traversal order.
pub fn summary(f: &SourceFacts) -> String {
    let mut lines = Vec::new();
    for c in &f.components {
        lines.push(format!("COMPONENT {} {}{} supertypes=[{}] injected=[{}]{}{}", c.kind, c.id, if c.is_interface { " interface" } else { "" }, c.supertypes.join(","), c.injected.iter().map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(","), attrs(&c.attributes), at(&c.evidence)));
    }
    for t in &f.triggers {
        lines.push(format!("TRIGGER {} {}.{}{}{}", t.kind, t.component_id, t.method, attrs(&t.attributes), at(&t.evidence)));
    }
    for c in &f.calls {
        lines.push(format!("CALL {}.{} -> {}.{}{}", c.from_component, c.from_method, c.target_type, c.target_method, at(&c.evidence)));
    }
    for s in &f.sink_accesses {
        lines.push(format!("SINK {}.{} {} {}:{}{}{}", s.component_id, s.method, s.edge_kind, s.sink_kind, s.sink_name, attrs(&s.attributes), at(&s.evidence)));
    }
    for e in &f.events {
        lines.push(format!("EVENT {}.{} -> {}{}", e.component_id, e.method, e.event_type.as_deref().unwrap_or("?"), at(&e.evidence)));
    }
    for u in &f.unresolved {
        lines.push(format!("UNRESOLVED {}.{} {} {}{}", u.component_id, u.method, u.reason, u.detail, at(&u.evidence)));
    }
    lines.sort();
    lines.join("\n") + "\n"
}

#[test]
fn golden_refunds_service() {
    let repo = RepoSnapshot::open(fixtures().join("refunds-service").to_str().unwrap()).unwrap();
    let ex = KotlinSpringExtractor;
    assert!(ex.supports(&repo));
    let actual = summary(&ex.extract(&repo, &|_, _, _| {}).unwrap());
    let golden = fixtures().join("refunds-service.golden.txt");
    if std::env::var("UPDATE_GOLDEN").is_ok() || !golden.exists() {
        std::fs::write(&golden, &actual).unwrap();
    }
    let expected = std::fs::read_to_string(&golden).unwrap().replace("\r\n", "\n");
    assert_eq!(actual, expected, "facts differ from {}", golden.display());
}

#[test]
fn does_not_support_plain_repositories() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("main.py"), "print(1)").unwrap();
    assert!(!KotlinSpringExtractor.supports(&RepoSnapshot::open(dir.path().to_str().unwrap()).unwrap()));
}
