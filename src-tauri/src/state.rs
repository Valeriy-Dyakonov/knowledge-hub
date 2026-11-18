//! Working data of a service in `<service>/.state/hub.db` (SQLite, git-ignored): runs, checkpoints and run logs.
//! Records are stored as JSON documents whose shape the frontend owns (`RunRecord`, `RunState`, `LogEntry` in src/types.ts).
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

const SCHEMA: &str = "
create table if not exists runs (id text primary key, started_at text not null, json text not null);
create table if not exists checkpoints (run_id text primary key, json text not null);
create table if not exists run_logs (seq integer primary key autoincrement, run_id text not null, json text not null);
";

pub struct StateDb {
    conn: Connection,
}

impl StateDb {
    pub fn open(state_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(state_dir).map_err(AppError::state)?;
        let conn = Connection::open(state_dir.join("hub.db")).map_err(AppError::state)?;
        conn.execute_batch(SCHEMA).map_err(AppError::state)?;
        Ok(Self { conn })
    }

    pub fn save_run(&self, run: &Value) -> AppResult<()> {
        let id = run["id"].as_str().ok_or_else(|| AppError::new("invalidArgument").with("value", "run.id"))?;
        let started = run["startedAt"].as_str().unwrap_or_default();
        self.conn
            .execute("insert or replace into runs (id, started_at, json) values (?1, ?2, ?3)", params![id, started, run.to_string()])
            .map_err(AppError::state)?;
        Ok(())
    }

    /// Newest first.
    pub fn list_runs(&self) -> AppResult<Vec<Value>> {
        self.json_rows("select json from runs order by started_at desc", params![])
    }

    pub fn save_checkpoint(&self, run_id: &str, state: &Value) -> AppResult<()> {
        self.conn
            .execute("insert or replace into checkpoints (run_id, json) values (?1, ?2)", params![run_id, state.to_string()])
            .map_err(AppError::state)?;
        Ok(())
    }

    pub fn load_checkpoint(&self, run_id: &str) -> AppResult<Option<Value>> {
        let json: Option<String> = self
            .conn
            .query_row("select json from checkpoints where run_id = ?1", params![run_id], |r| r.get(0))
            .optional()
            .map_err(AppError::state)?;
        json.map(|s| serde_json::from_str(&s).map_err(AppError::state)).transpose()
    }

    pub fn append_logs(&self, run_id: &str, entries: &[Value]) -> AppResult<()> {
        for e in entries {
            self.conn.execute("insert into run_logs (run_id, json) values (?1, ?2)", params![run_id, e.to_string()]).map_err(AppError::state)?;
        }
        Ok(())
    }

    pub fn logs(&self, run_id: &str) -> AppResult<Vec<Value>> {
        self.json_rows("select json from run_logs where run_id = ?1 order by seq", params![run_id])
    }

    fn json_rows(&self, sql: &str, args: impl rusqlite::Params) -> AppResult<Vec<Value>> {
        let mut stmt = self.conn.prepare(sql).map_err(AppError::state)?;
        let rows = stmt.query_map(args, |r| r.get::<_, String>(0)).map_err(AppError::state)?;
        rows.map(|r| serde_json::from_str(&r.map_err(AppError::state)?).map_err(AppError::state)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_runs_checkpoints_and_logs() {
        let dir = tempfile::tempdir().unwrap();
        let db = StateDb::open(dir.path()).unwrap();
        db.save_run(&json!({"id": "r1", "startedAt": "2026-01-01T00:00:00Z", "status": "RUNNING"})).unwrap();
        db.save_run(&json!({"id": "r2", "startedAt": "2026-01-02T00:00:00Z", "status": "RUNNING"})).unwrap();
        db.save_run(&json!({"id": "r1", "startedAt": "2026-01-01T00:00:00Z", "status": "FAILED"})).unwrap();
        let runs = db.list_runs().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["id"], "r2");
        assert_eq!(runs[1]["status"], "FAILED");

        assert!(db.load_checkpoint("r1").unwrap().is_none());
        db.save_checkpoint("r1", &json!({"candidates": []})).unwrap();
        assert_eq!(db.load_checkpoint("r1").unwrap().unwrap(), json!({"candidates": []}));

        db.append_logs("r1", &[json!({"code": "a"}), json!({"code": "b"})]).unwrap();
        assert_eq!(db.logs("r1").unwrap().iter().map(|e| e["code"].as_str().unwrap()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
}
