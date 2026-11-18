//! MCP server: the same executable started as `knowledge-hub mcp [--knowledge-dir <path>]`, no window, stdio.
//! Reads the knowledge base and the search index chosen in the app settings; never writes.
pub mod stdio;
pub mod tools;

use crate::store::FsStore;
use std::path::PathBuf;

pub fn run(args: &[String]) {
    let dir = args
        .iter()
        .position(|a| a == "--knowledge-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::settings::load().unwrap_or_default().knowledge_root());
    let tools = tools::Tools { store: FsStore::new(dir) };
    let stdin = std::io::stdin();
    if let Err(e) = stdio::serve(&tools, stdin.lock(), std::io::stdout().lock()) {
        eprintln!("knowledge-hub mcp: {e}");
        std::process::exit(1);
    }
}
