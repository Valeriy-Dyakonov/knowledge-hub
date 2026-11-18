#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("mcp") {
        knowledge_hub_lib::run_mcp(&args[1..]);
    } else {
        knowledge_hub_lib::run()
    }
}
