// Dev helper: prints the tree-sitter syntax tree of a Kotlin file. `cargo run --example sexp -- File.kt`
fn main() {
    let path = std::env::args().nth(1).expect("file");
    let src = std::fs::read_to_string(path).unwrap();
    let mut p = tree_sitter::Parser::new();
    p.set_language(&tree_sitter_kotlin_ng::LANGUAGE.into()).unwrap();
    let tree = p.parse(&src, None).unwrap();
    print(tree.root_node(), &src, 0);
    if tree.root_node().has_error() {
        println!("HAS_ERROR");
    }
}

fn print(n: tree_sitter::Node, src: &str, depth: usize) {
    let field = "";
    let text = if n.child_count() == 0 { format!(" {:?}", &src[n.byte_range()]) } else { String::new() };
    if n.is_missing() {
        println!("{}MISSING {}", "  ".repeat(depth), n.kind());
    } else if n.is_named() {
        println!("{}{}{}{}", "  ".repeat(depth), field, n.kind(), text);
    }
    let mut c = n.walk();
    for (i, ch) in n.children(&mut c).enumerate() {
        let _ = i;
        print(ch, src, depth + 1);
    }
}
