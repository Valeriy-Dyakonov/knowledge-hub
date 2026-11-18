//! Extractors analyse source code of one language/framework and emit facts with evidence only.
//! A new extractor is a module implementing `Extractor` plus an entry in `registry()`.
pub mod kotlin_spring;

use crate::error::AppResult;
use crate::model::facts::SourceFacts;
use crate::repo::RepoSnapshot;

pub trait Extractor: Send + Sync {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn required(&self) -> bool {
        false
    }
    fn supports(&self, repo: &RepoSnapshot) -> bool;
    fn extract(&self, repo: &RepoSnapshot) -> AppResult<SourceFacts>;
}

/// Registered extractors, tried in order; every one whose `supports` is true runs.
pub fn registry() -> Vec<Box<dyn Extractor>> {
    vec![Box::new(kotlin_spring::KotlinSpringExtractor)]
}
