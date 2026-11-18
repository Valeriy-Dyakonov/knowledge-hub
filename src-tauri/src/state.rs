//! Working data of a service in `<service>/.state/hub.db` (SQLite, git-ignored): runs, checkpoints, run logs, and the
//! review queue (batches, answers, journal of reviewer actions, questions to owners).
//! Records are stored as JSON documents whose shape the frontend owns (`RunRecord`, `ReviewBatch`... in src/types.ts).
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

const SCHEMA: &str = "
create table if not exists runs (id text primary key, started_at text not null, json text not null);
create table if not exists checkpoints (run_id text primary key, json text not null);
create table if not exists run_logs (seq integer primary key autoincrement, run_id text not null, json text not null);
create table if not exists batches (id text primary key, state text not null, opened_at text not null, flags text not null, json text not null);
create table if not exists answers (batch_id text not null, item_id text not null, json text not null, primary key (batch_id, item_id));
create table if not exists journal (seq integer primary key autoincrement, json text not null);
create table if not exists questions (id text primary key, json text not null);
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

    pub fn save_batch(&self, batch: &Value) -> AppResult<()> {
        let id = batch["id"].as_str().ok_or_else(|| AppError::new("invalidArgument").with("value", "batch.id"))?;
        let opened = batch["openedAt"].as_str().unwrap_or_default();
        self.conn
            .execute("insert or replace into batches (id, state, opened_at, flags, json) values (?1, 'OPEN', ?2, '[]', ?3)", params![id, opened, batch.to_string()])
            .map_err(AppError::state)?;
        Ok(())
    }

    /// `{ batch, state, answers, flags }` — the frontend's `StoredBatch`.
    pub fn find_batch(&self, id: &str) -> AppResult<Option<Value>> {
        let row: Option<(String, String, String)> = self
            .conn
            .query_row("select json, state, flags from batches where id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(AppError::state)?;
        row.map(|(json, state, flags)| self.stored(id, &json, &state, &flags)).transpose()
    }

    pub fn open_batches(&self) -> AppResult<Vec<Value>> {
        let mut stmt = self.conn.prepare("select id, json, state, flags from batches where state = 'OPEN' order by opened_at").map_err(AppError::state)?;
        let rows: Vec<(String, String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(AppError::state)?
            .collect::<Result<_, _>>()
            .map_err(AppError::state)?;
        rows.iter().map(|(id, json, state, flags)| self.stored(id, json, state, flags)).collect()
    }

    pub fn save_answer(&self, batch_id: &str, answer: &Value) -> AppResult<()> {
        let item = answer["itemId"].as_str().ok_or_else(|| AppError::new("invalidArgument").with("value", "answer.itemId"))?;
        self.conn
            .execute("insert or replace into answers (batch_id, item_id, json) values (?1, ?2, ?3)", params![batch_id, item, answer.to_string()])
            .map_err(AppError::state)?;
        Ok(())
    }

    pub fn close_batch(&self, batch_id: &str, state: &str, flags: &[String]) -> AppResult<()> {
        if !matches!(state, "CLOSED" | "REJECTED") {
            return Err(AppError::new("invalidArgument").with("value", state));
        }
        let flags = serde_json::to_string(flags).map_err(AppError::state)?;
        self.conn.execute("update batches set state = ?1, flags = ?2 where id = ?3", params![state, flags, batch_id]).map_err(AppError::state)?;
        Ok(())
    }

    pub fn append_journal(&self, entries: &[Value]) -> AppResult<()> {
        for e in entries {
            self.conn.execute("insert into journal (json) values (?1)", params![e.to_string()]).map_err(AppError::state)?;
        }
        Ok(())
    }

    pub fn journal(&self) -> AppResult<Vec<Value>> {
        self.json_rows("select json from journal order by seq", params![])
    }

    pub fn add_question(&self, question: &Value) -> AppResult<()> {
        let id = question["id"].as_str().ok_or_else(|| AppError::new("invalidArgument").with("value", "question.id"))?;
        self.conn.execute("insert or replace into questions (id, json) values (?1, ?2)", params![id, question.to_string()]).map_err(AppError::state)?;
        Ok(())
    }

    pub fn questions(&self) -> AppResult<Vec<Value>> {
        self.json_rows("select json from questions order by id", params![])
    }

    fn stored(&self, id: &str, json: &str, state: &str, flags: &str) -> AppResult<Value> {
        let answers = self.json_rows("select json from answers where batch_id = ?1", params![id])?;
        Ok(serde_json::json!({
            "batch": serde_json::from_str::<Value>(json).map_err(AppError::state)?,
            "state": state,
            "answers": answers,
            "flags": serde_json::from_str::<Value>(flags).map_err(AppError::state)?,
        }))
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

    #[test]
    fn stores_the_review_queue() {
        let dir = tempfile::tempdir().unwrap();
        let db = StateDb::open(dir.path()).unwrap();
        db.save_batch(&json!({"id": "b1", "openedAt": "t1", "items": []})).unwrap();
        db.save_answer("b1", &json!({"itemId": "i1", "action": "CONFIRM"})).unwrap();
        db.save_answer("b1", &json!({"itemId": "i1", "action": "REJECT"})).unwrap();
        let open = db.open_batches().unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["state"], "OPEN");
        assert_eq!(open[0]["answers"].as_array().unwrap().len(), 1);
        assert_eq!(open[0]["answers"][0]["action"], "REJECT");

        db.close_batch("b1", "REJECTED", &["controlFailed".into()]).unwrap();
        assert!(db.open_batches().unwrap().is_empty());
        let b = db.find_batch("b1").unwrap().unwrap();
        assert_eq!(b["state"], "REJECTED");
        assert_eq!(b["flags"], json!(["controlFailed"]));
        assert_eq!(db.close_batch("b1", "OPEN", &[]).unwrap_err().code, "invalidArgument");

        db.append_journal(&[json!({"itemId": "i1"})]).unwrap();
        assert_eq!(db.journal().unwrap().len(), 1);
        db.add_question(&json!({"id": "q1", "claimId": "c1"})).unwrap();
        assert_eq!(db.questions().unwrap()[0]["claimId"], "c1");
    }
}
