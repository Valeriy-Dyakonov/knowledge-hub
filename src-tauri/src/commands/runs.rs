use super::store;
use crate::error::{AppError, AppResult};
use crate::state::StateDb;
use serde_json::Value;

fn db(service_id: &str) -> AppResult<StateDb> {
    StateDb::open(&store()?.state_dir(service_id)?)
}

fn service_of(run: &Value) -> AppResult<String> {
    run["options"]["serviceId"].as_str().map(String::from).ok_or_else(|| AppError::new("invalidArgument").with("value", "run.options.serviceId"))
}

#[tauri::command]
pub fn save_run(run: Value) -> AppResult<()> {
    db(&service_of(&run)?)?.save_run(&run)
}

#[tauri::command]
pub fn list_runs(service_id: String) -> AppResult<Vec<Value>> {
    db(&service_id)?.list_runs()
}

#[tauri::command]
pub fn save_checkpoint(service_id: String, run_id: String, state: Value) -> AppResult<()> {
    db(&service_id)?.save_checkpoint(&run_id, &state)
}

#[tauri::command]
pub fn load_checkpoint(service_id: String, run_id: String) -> AppResult<Option<Value>> {
    db(&service_id)?.load_checkpoint(&run_id)
}

#[tauri::command]
pub fn append_run_log(service_id: String, run_id: String, entries: Vec<Value>) -> AppResult<()> {
    db(&service_id)?.append_logs(&run_id, &entries)
}

#[tauri::command]
pub fn run_logs(service_id: String, run_id: String) -> AppResult<Vec<Value>> {
    db(&service_id)?.logs(&run_id)
}
