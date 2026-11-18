//! Kotlin + Spring Boot extractor: tree-sitter syntax (`syntax.rs`) + Spring semantics (`spring.rs`).
mod anon;
mod diagnose;
mod spring;
pub mod syntax;

use super::{Extractor, Progress};
use crate::error::AppResult;
use crate::model::facts::SourceFacts;
use crate::model::Evidence;
use crate::repo::RepoSnapshot;
use std::collections::HashMap;

pub struct KotlinSpringExtractor;

/// Sources under test source sets are not part of the service.
fn is_main_source(path: &str) -> bool {
    path.ends_with(".kt")
        && !path.ends_with(".kts")
        && !["src/test/", "src/testFixtures/", "src/integrationTest/", "src/it/", "src/androidTest/"].iter().any(|t| path.starts_with(t) || path.contains(&format!("/{t}")))
}

fn is_build_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(name, "build.gradle.kts" | "build.gradle" | "pom.xml") && path.matches('/').count() <= 1
}

struct Texts<'a> {
    repo: &'a RepoSnapshot,
    texts: HashMap<String, String>,
}

impl spring::EvidenceSource for Texts<'_> {
    fn evidence(&self, path: &str, lines: (u32, u32)) -> Option<Evidence> {
        self.texts.get(path).map(|t| self.repo.evidence(path, t, Some(lines)))
    }
}

impl Extractor for KotlinSpringExtractor {
    fn id(&self) -> &'static str {
        "kotlin-spring"
    }

    fn version(&self) -> &'static str {
        "0.1.0"
    }

    fn supports(&self, repo: &RepoSnapshot) -> bool {
        let builds = repo.files(is_build_file);
        let spring_build = builds.iter().any(|b| repo.read(b).is_ok_and(|t| t.contains("spring-boot") || t.contains("org.springframework")));
        let kotlin = repo.files(is_main_source);
        !kotlin.is_empty() && (spring_build || kotlin.iter().take(200).any(|k| repo.read(k).is_ok_and(|t| t.contains("org.springframework"))))
    }

    fn extract(&self, repo: &RepoSnapshot, progress: Progress) -> AppResult<SourceFacts> {
        let mut texts = HashMap::new();
        let mut files = Vec::new();
        let paths = repo.files(is_main_source);
        for (i, path) in paths.iter().enumerate() {
            progress(i + 1, paths.len(), path);
            let path = path.clone();
            let text = repo.read(&path)?;
            files.push(syntax::parse(&path, &text));
            texts.insert(path, text);
        }
        Ok(spring::analyse(&files, &Texts { repo, texts }))
    }
}

#[cfg(test)]
mod golden;
