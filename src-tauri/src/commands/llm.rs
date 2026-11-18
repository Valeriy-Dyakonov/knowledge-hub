use crate::error::{AppError, AppResult};
use crate::{llm, secrets, settings};

#[tauri::command]
pub async fn llm_chat(system: String, user: String) -> AppResult<String> {
    let s = settings::load()?;
    let key = secrets::get(secrets::LLM.name);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(180)).build().map_err(AppError::raw)?;
    llm::chat(&client, &s.llm_base_url, key.as_deref(), &s.llm_model, &system, &user).await
}
