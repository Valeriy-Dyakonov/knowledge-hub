use crate::error::{AppError, AppResult};
use crate::repo::display;
use crate::secrets;
use crate::settings::{self, Settings};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

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

#[derive(Debug, Serialize, Default)]
pub struct GitUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

fn git_config(key: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["config", "--global", "--get", key]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no console window flashing in the GUI app
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !v.is_empty()).then_some(v)
}

/// The person from the global git config: the default reviewer name.
#[tauri::command]
pub fn git_user() -> GitUser {
    GitUser { name: git_config("user.name"), email: git_config("user.email") }
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
