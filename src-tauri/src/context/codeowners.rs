//! CODEOWNERS: owners of paths, used as feature owners for review routing.
use super::ContextSource;
use crate::error::AppResult;
use crate::model::facts::{ContextFacts, OwnershipRule};
use crate::repo::RepoSnapshot;

pub struct CodeOwners;

const LOCATIONS: [&str; 4] = ["CODEOWNERS", ".github/CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS"];

pub fn parse(text: &str) -> Vec<OwnershipRule> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('[') && !l.starts_with("^["))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let pattern = parts.next()?.to_string();
            let owners: Vec<String> = parts.take_while(|p| !p.starts_with('#')).map(String::from).collect();
            Some(OwnershipRule { pattern, owners })
        })
        .collect()
}

impl ContextSource for CodeOwners {
    fn id(&self) -> &'static str {
        "codeowners"
    }

    fn collect(&self, repo: &RepoSnapshot) -> AppResult<ContextFacts> {
        let Some(path) = LOCATIONS.iter().find(|p| repo.exists(p)) else { return Ok(ContextFacts::default()) };
        Ok(ContextFacts { ownership: parse(&repo.read(path)?), ..Default::default() })
    }
}
