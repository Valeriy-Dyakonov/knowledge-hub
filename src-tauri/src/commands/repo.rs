use crate::error::{AppError, AppResult};
use crate::repo::{RepoInfo, RepoSnapshot};
use crate::scan::{self, ScanResult};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[tauri::command]
pub fn inspect_repo(path: String) -> AppResult<RepoInfo> {
    Ok(RepoSnapshot::open(&path)?.info())
}

/// Stage Scan: runs extractors and context sources off the UI thread, reporting progress as `scan-progress` events
/// (at most every 50 ms, plus the last item of each step).
#[tauri::command]
pub async fn scan_repo(app: tauri::AppHandle, path: String) -> AppResult<ScanResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let last = std::cell::Cell::new(Instant::now() - Duration::from_secs(1));
        let report = |p: scan::ScanProgress| {
            if p.current == p.total || last.get().elapsed() >= Duration::from_millis(50) {
                last.set(Instant::now());
                let _ = app.emit("scan-progress", p);
            }
        };
        scan::scan(&RepoSnapshot::open(&path)?, &report)
    })
    .await
    .map_err(AppError::raw)?
}

/// A file of the analysed repository, for showing evidence. Read-only; paths outside the repository are refused.
#[tauri::command]
pub fn read_repo_file(path: String, file: String) -> AppResult<String> {
    RepoSnapshot::open(&path)?.read(&file)
}
