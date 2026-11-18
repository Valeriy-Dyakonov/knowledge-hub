use super::store;
use crate::error::AppResult;
use crate::model::{GeneratedFile, KnowledgeModel};
use crate::store::KnowledgeStore;

#[tauri::command]
pub fn list_services() -> AppResult<Vec<String>> {
    store()?.services()
}

#[tauri::command]
pub fn load_model(service_id: String) -> AppResult<Option<KnowledgeModel>> {
    store()?.load(&service_id)
}

#[tauri::command]
pub fn save_model(service_id: String, model: KnowledgeModel) -> AppResult<()> {
    store()?.save(&service_id, &model)
}

#[tauri::command]
pub fn write_generated(service_id: String, files: Vec<GeneratedFile>) -> AppResult<()> {
    store()?.write_generated(&service_id, &files)
}

#[tauri::command]
pub fn read_generated(service_id: String, relative_path: String) -> AppResult<Option<String>> {
    store()?.read_generated(&service_id, &relative_path)
}
