//! Review queue commands. Batches, answers, journal entries and questions are JSON documents owned by the frontend
//! (`src/types.ts`); the policy and the use cases live in `src/lib/review/`.
use super::store;
use crate::error::AppResult;
use crate::state::StateDb;
use serde_json::Value;

fn db(service_id: &str) -> AppResult<StateDb> {
    StateDb::open(&store()?.state_dir(service_id)?)
}

#[tauri::command]
pub fn save_batch(service_id: String, batch: Value) -> AppResult<()> {
    db(&service_id)?.save_batch(&batch)
}

#[tauri::command]
pub fn find_batch(service_id: String, batch_id: String) -> AppResult<Option<Value>> {
    db(&service_id)?.find_batch(&batch_id)
}

#[tauri::command]
pub fn open_batches(service_id: String) -> AppResult<Vec<Value>> {
    db(&service_id)?.open_batches()
}

#[tauri::command]
pub fn save_answer(service_id: String, batch_id: String, answer: Value) -> AppResult<()> {
    db(&service_id)?.save_answer(&batch_id, &answer)
}

#[tauri::command]
pub fn close_batch(service_id: String, batch_id: String, state: String, flags: Vec<String>) -> AppResult<()> {
    db(&service_id)?.close_batch(&batch_id, &state, &flags)
}

#[tauri::command]
pub fn append_journal(service_id: String, entries: Vec<Value>) -> AppResult<()> {
    db(&service_id)?.append_journal(&entries)
}

#[tauri::command]
pub fn review_journal(service_id: String) -> AppResult<Vec<Value>> {
    db(&service_id)?.journal()
}

#[tauri::command]
pub fn add_question(service_id: String, question: Value) -> AppResult<()> {
    db(&service_id)?.add_question(&question)
}

#[tauri::command]
pub fn review_questions(service_id: String) -> AppResult<Vec<Value>> {
    db(&service_id)?.questions()
}
