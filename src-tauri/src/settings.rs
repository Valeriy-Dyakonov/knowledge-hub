//! `settings.json` in the app config folder. Readable without a Tauri handle, because the MCP mode runs headless.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const APP_ID: &str = "dev.knowledge.hub";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoEntry {
    /// Absolute path to the analysed repository (read-only).
    pub path: String,
    /// Folder name in the knowledge base.
    pub service_id: String,
    pub name: String,
}

impl Default for RepoEntry {
    fn default() -> Self {
        Self { path: String::new(), service_id: String::new(), name: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Knowledge base folder; empty = Documents/knowledge-hub.
    pub knowledge_dir: String,
    pub repos: Vec<RepoEntry>,
    pub llm_base_url: String,
    pub llm_model: String,
    /// At most this many LLM requests per minute (the analysis waits between requests).
    pub llm_requests_per_minute: u32,
    /// At most this many LLM requests in one analysis run; the rest of the features keep technical names.
    pub llm_max_requests: u32,
    pub review_policy: String,
    /// Overrides the reviewer name; empty = `user.name` from the global git config.
    pub reviewer: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            knowledge_dir: String::new(),
            repos: vec![],
            llm_base_url: String::new(),
            llm_model: String::new(),
            llm_requests_per_minute: 6,
            llm_max_requests: 20,
            review_policy: "strict".into(),
            reviewer: String::new(),
        }
    }
}

impl Settings {
    /// The knowledge base folder actually used.
    pub fn knowledge_root(&self) -> PathBuf {
        if !self.knowledge_dir.trim().is_empty() {
            return PathBuf::from(self.knowledge_dir.trim());
        }
        dirs::document_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from(".")).join("knowledge-hub")
    }
}

fn path() -> AppResult<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| AppError::raw("no config dir"))?.join(APP_ID);
    fs::create_dir_all(&dir).map_err(AppError::raw)?;
    Ok(dir.join("settings.json"))
}

pub fn load() -> AppResult<Settings> {
    let p = path()?;
    if !p.exists() {
        return Ok(Settings::default());
    }
    let s = fs::read_to_string(p).map_err(AppError::raw)?;
    serde_json::from_str(&s).map_err(AppError::raw)
}

pub fn save(settings: &Settings) -> AppResult<()> {
    let json = serde_json::to_string_pretty(settings).map_err(AppError::raw)?;
    fs::write(path()?, json).map_err(AppError::raw)
}
