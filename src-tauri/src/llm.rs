//! OpenAI-compatible chat completions client (same behaviour as worklog-tracker).
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n).collect::<String>() + "…" }
}

/// Text deltas of one server-sent-events chunk of an OpenAI-compatible streaming response.
pub fn sse_deltas(buffer: &mut String, chunk: &str) -> (Vec<String>, bool) {
    buffer.push_str(chunk);
    let mut out = Vec::new();
    let mut done = false;
    while let Some(pos) = buffer.find('\n') {
        let line: String = buffer.drain(..=pos).collect();
        let line = line.trim();
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            done = true;
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                out.push(t.to_string());
            }
        }
    }
    (out, done)
}

/// Streaming variant: `on_delta` receives the text as it arrives (shown live in the app). Gateways that ignore
/// `stream` and answer with plain JSON still work; 400/422 retries without `response_format`, like `chat`.
pub async fn chat_stream(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    on_delta: impl Fn(&str),
) -> AppResult<String> {
    use futures_util::StreamExt;
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return Err(AppError::new("llmNotConfigured"));
    }
    let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
    let mut body = json!({
        "model": model,
        "temperature": 0.2,
        "stream": true,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "response_format": { "type": "json_object" }
    });
    for attempt in 0..2 {
        let mut req = client.post(&url).json(&body);
        if let Some(k) = api_key {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await.map_err(|e| AppError::service("LLM", e))?;
        let status = resp.status();
        if (status.as_u16() == 400 || status.as_u16() == 422) && attempt == 0 {
            body.as_object_mut().unwrap().remove("response_format");
            continue;
        }
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::http("LLM", status, &truncate(&text, 300)));
        }
        let is_sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("event-stream"));
        if !is_sse {
            let text = resp.text().await.map_err(AppError::raw)?;
            let v: Value = serde_json::from_str(&text).map_err(|e| AppError::service("LLM", format!("JSON: {e}")))?;
            let content = v["choices"][0]["message"]["content"].as_str().map(String::from).ok_or_else(|| AppError::new("llmNoContent").with("body", truncate(&text, 300)))?;
            on_delta(&content);
            return Ok(content);
        }
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::service("LLM", e))?;
            let (deltas, done) = sse_deltas(&mut buffer, &String::from_utf8_lossy(&chunk));
            for d in deltas {
                on_delta(&d);
                text.push_str(&d);
            }
            if done {
                break;
            }
        }
        if text.is_empty() {
            return Err(AppError::new("llmNoContent"));
        }
        return Ok(text);
    }
    Err(AppError::new("llmNoAnswer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_server_sent_events_across_chunks() {
        let mut buf = String::new();
        let (a, done) = sse_deltas(&mut buf, "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"fea\"}}]}\n\ndata: {\"choices\":[{\"del");
        assert_eq!(a, vec!["{\"fea"]);
        assert!(!done);
        let (b, done) = sse_deltas(&mut buf, "ta\":{\"content\":\"tures\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(b, vec!["tures"]);
        assert!(done);
    }
}

pub async fn chat(client: &reqwest::Client, base_url: &str, api_key: Option<&str>, model: &str, system: &str, user: &str) -> AppResult<String> {
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return Err(AppError::new("llmNotConfigured"));
    }
    let url = format!("{}/chat/completions", base_url.trim().trim_end_matches('/'));
    let mut body = json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "response_format": { "type": "json_object" }
    });

    for attempt in 0..2 {
        let mut req = client.post(&url).json(&body);
        if let Some(k) = api_key {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await.map_err(|e| AppError::service("LLM", e))?;
        let status = resp.status();
        let text = resp.text().await.map_err(AppError::raw)?;

        // Some gateways do not know `response_format`; retry once without it.
        if (status.as_u16() == 400 || status.as_u16() == 422) && attempt == 0 {
            body.as_object_mut().unwrap().remove("response_format");
            continue;
        }
        if !status.is_success() {
            return Err(AppError::http("LLM", status, &truncate(&text, 300)));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| AppError::service("LLM", format!("JSON: {e}")))?;
        return v["choices"][0]["message"]["content"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| AppError::new("llmNoContent").with("body", truncate(&text, 300)));
    }
    Err(AppError::new("llmNoAnswer"))
}
