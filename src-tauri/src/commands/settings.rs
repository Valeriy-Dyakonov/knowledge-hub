use crate::error::{AppError, AppResult};
use crate::repo::display;
use crate::secrets;
use crate::settings::{self, Settings};
use std::collections::HashMap;

#[tauri::command]
pub fn load_settings() -> AppResult<Settings> {
    settings::load()
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> AppResult<()> {
    settings::save(&settings)
}

/// The knowledge base folder actually used (the default when the setting is empty).
#[tauri::command]
pub fn knowledge_dir() -> AppResult<String> {
    Ok(display(&settings::load()?.knowledge_root()))
}

/// An empty value removes the secret.
#[tauri::command]
pub fn set_secret(name: String, value: String) -> AppResult<()> {
    if !secrets::is_known(&name) {
        return Err(AppError::new("unknownSecret").with("secret", name));
    }
    secrets::set(&name, &value)
}

/// Which secrets are present, without revealing them.
#[tauri::command]
pub fn secrets_status() -> HashMap<String, bool> {
    secrets::ALL.iter().map(|s| (s.name.to_string(), secrets::get(s.name).is_some())).collect()
}
