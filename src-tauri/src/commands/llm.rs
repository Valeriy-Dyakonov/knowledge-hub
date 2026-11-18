use crate::error::{AppError, AppResult};
use crate::{llm, secrets, settings};

/// Streaming chat: every text delta is sent to the window as `llm-delta` `{ requestId, delta }`.
#[tauri::command]
pub async fn llm_chat_stream(app: tauri::AppHandle, request_id: String, system: String, user: String) -> AppResult<String> {
    use tauri::Emitter;
    let s = settings::load()?;
    let key = secrets::get(secrets::LLM.name);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(AppError::raw)?;
    llm::chat_stream(&client, &s.llm_base_url, key.as_deref(), &s.llm_model, &system, &user, |delta| {
        let _ = app.emit("llm-delta", serde_json::json!({ "requestId": request_id, "delta": delta }));
    })
    .await
}

#[tauri::command]
pub async fn llm_chat(system: String, user: String) -> AppResult<String> {
    let s = settings::load()?;
    let key = secrets::get(secrets::LLM.name);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(180)).build().map_err(AppError::raw)?;
    llm::chat(&client, &s.llm_base_url, key.as_deref(), &s.llm_model, &system, &user).await
}
