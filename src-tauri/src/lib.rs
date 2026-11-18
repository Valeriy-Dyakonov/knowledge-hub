mod commands;
mod context;
mod error;
mod extract;
mod llm;
mod model;
mod redact;
mod repo;
mod scan;
mod secrets;
mod settings;
mod state;
mod store;

use commands::{knowledge, llm as llm_cmd, repo as repo_cmd, runs, settings as config};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            config::load_settings,
            config::save_settings,
            config::knowledge_dir,
            config::set_secret,
            config::secrets_status,
            repo_cmd::inspect_repo,
            repo_cmd::scan_repo,
            repo_cmd::read_repo_file,
            knowledge::list_services,
            knowledge::load_model,
            knowledge::save_model,
            knowledge::write_generated,
            knowledge::read_generated,
            runs::save_run,
            runs::list_runs,
            runs::save_checkpoint,
            runs::load_checkpoint,
            runs::append_run_log,
            runs::run_logs,
            llm_cmd::llm_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
