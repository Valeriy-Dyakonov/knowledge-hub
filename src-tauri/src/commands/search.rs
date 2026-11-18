use super::store;
use crate::error::{AppError, AppResult};
use crate::index::{FtsIndex, Indexer, SearchHit};
use crate::repo::display;
use crate::store::KnowledgeStore;

/// Stage Index: rebuilds the search index of a service from its saved model.
#[tauri::command]
pub fn index_service(service_id: String) -> AppResult<usize> {
    let store = store()?;
    let model = store.load(&service_id)?.ok_or_else(|| AppError::new("serviceNotIndexed").with("service", service_id.clone()))?;
    FtsIndex::new(&store).index(&model)?;
    Ok(model.features.len())
}

#[tauri::command]
pub fn search(query: String, service_id: Option<String>, limit: Option<usize>) -> AppResult<Vec<SearchHit>> {
    let store = store()?;
    FtsIndex::new(&store).search(&query, service_id.as_deref(), limit.unwrap_or(20).clamp(1, 100))
}

/// How a harness starts the MCP server: this executable with the `mcp` argument.
#[tauri::command]
pub fn mcp_command() -> AppResult<String> {
    Ok(display(&std::env::current_exe().map_err(AppError::raw)?))
}
