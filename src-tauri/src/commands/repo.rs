use crate::error::{AppError, AppResult};
use crate::repo::{RepoInfo, RepoSnapshot};
use crate::scan::{self, ScanResult};

#[tauri::command]
pub fn inspect_repo(path: String) -> AppResult<RepoInfo> {
    Ok(RepoSnapshot::open(&path)?.info())
}

/// Stage Scan: runs extractors and context sources off the UI thread.
#[tauri::command]
pub async fn scan_repo(path: String) -> AppResult<ScanResult> {
    tauri::async_runtime::spawn_blocking(move || scan::scan(&RepoSnapshot::open(&path)?))
        .await
        .map_err(AppError::raw)?
}

/// A file of the analysed repository, for showing evidence. Read-only; paths outside the repository are refused.
#[tauri::command]
pub fn read_repo_file(path: String, file: String) -> AppResult<String> {
    RepoSnapshot::open(&path)?.read(&file)
}
