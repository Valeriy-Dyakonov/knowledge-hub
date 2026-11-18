//! Tauri commands, grouped by area. Names, arguments and returned JSON are the frontend contract (src/api.ts).
pub mod knowledge;
pub mod llm;
pub mod repo;
pub mod runs;
pub mod settings;

use crate::error::AppResult;
use crate::store::FsStore;

/// The knowledge base selected in the settings.
pub fn store() -> AppResult<FsStore> {
    Ok(FsStore::new(crate::settings::load()?.knowledge_root()))
}
