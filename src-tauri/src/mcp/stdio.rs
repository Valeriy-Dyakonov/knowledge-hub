//! MCP transport over stdio: newline-delimited JSON-RPC 2.0 (initialize, tools/list, tools/call, ping).
//! Logs never go to stdout: stdout belongs to the protocol.
use super::tools::{definitions, Tools};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const DEFAULT_PROTOCOL: &str = "2025-06-18";

fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Handles one message; None for notifications (no response).
pub fn handle(tools: &Tools, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let id = match id {
        Some(id) if !id.is_null() => id,
        _ => return None, // notification, e.g. notifications/initialized
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL);
            response(&id, json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "knowledge-hub", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Reviewed knowledge about services: features, flows from trigger to sink, diagrams. Start with list_features or search; every answer carries meta.reviewStatus — DRAFT or STALE parts need checking in the code.",
            }))
        }
        "ping" => response(&id, json!({})),
        "tools/list" => response(&id, json!({ "tools": definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let (body, is_error) = match tools.call(name, &args) {
                Ok(v) => (v, false),
                // Errors are codes, not prose: the client words them.
                Err(e) => (json!({ "error": { "code": e.code, "params": e.params } }), true),
            };
            response(&id, json!({
                "content": [{ "type": "text", "text": serde_json::to_string(&body).unwrap_or_default() }],
                "structuredContent": body,
                "isError": is_error,
            }))
        }
        _ => error(&id, -32601, "method not found"),
    })
}

pub fn serve(tools: &Tools, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(tools, &msg),
            Err(_) => Some(error(&Value::Null, -32700, "parse error")),
        };
        if let Some(r) = reply {
            writeln!(output, "{r}")?;
            output.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::tests::fixture_store;

    #[test]
    fn speaks_json_rpc_over_lines() {
        let (_d, store, _) = fixture_store();
        let tools = Tools { store };
        let input = [
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_features","arguments":{}}}"#,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_feature","arguments":{"id":"missing"}}}"#,
            r#"not json"#,
            r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#,
        ]
        .join("\n");
        let mut out = Vec::new();
        serve(&tools, input.as_bytes(), &mut out).unwrap();
        let replies: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(replies.len(), 6, "the notification gets no reply");
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 9);
        assert_eq!(replies[2]["result"]["isError"], false);
        assert_eq!(replies[2]["result"]["structuredContent"]["meta"]["reviewStatus"], "DRAFT");
        assert_eq!(replies[3]["result"]["isError"], true);
        assert_eq!(replies[3]["result"]["structuredContent"]["error"]["code"], "featureNotFound");
        assert_eq!(replies[4]["error"]["code"], -32700);
        assert_eq!(replies[5]["error"]["code"], -32601);
    }
}
