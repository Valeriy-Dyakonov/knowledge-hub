//! Context sources read non-code facts (configuration, API specs, migrations, ownership).
//! A new source is a module implementing `ContextSource` plus an entry in `registry()`.
use crate::error::AppResult;
use crate::model::facts::ContextFacts;
use crate::repo::RepoSnapshot;

pub trait ContextSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn required(&self) -> bool {
        false
    }
    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts>;
}

/// Registered context sources; the first ones arrive with the Kotlin/Spring extractor (M2).
pub fn registry() -> Vec<Box<dyn ContextSource>> {
    vec![]
}
