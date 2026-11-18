//! Finds what makes the grammar fail when the error window shows nothing wrong: the file is parsed again with one
//! kind of text neutralised at a time (comments, string text, non-ASCII characters, tabs). When one of them makes the
//! first error go away, the single literal responsible is searched for and described by its shape only — length,
//! character classes, punctuation and Unicode code points of unusual characters — never by its words.
use tree_sitter::Parser;

/// What a re-parse found, as `key=value` pairs (formatted by the frontend):
/// `fixedBy` (comments | strings | nonAscii | tabs), `kind` (string | raw | comment), `linesBefore` (where the culprit
/// starts relative to the error line; negative = below), `length`, `classes`, `punct`, `unicode`.
pub type Diagnosis = Vec<(String, String)>;

/// Upper bound of re-parses per file: a diagnosis must stay cheap on large files.
const MAX_PARSES: usize = 300;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Comment,
    Text,
    Raw,
}

/// A comment or the text of a string literal (between its quotes), as a byte range.
#[derive(Clone, Copy, Debug)]
struct Region {
    kind: Kind,
    start: usize,
    end: usize,
}

/// First line (1-based) with a grammar error, after the same rewrites as the real parse.
fn first_error(source: &str) -> Option<u32> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_kotlin_ng::LANGUAGE.into()).ok()?;
    let tree = parser.parse(super::syntax::sanitize(source), None)?;
    let root = tree.root_node();
    if !root.has_error() {
        return None;
    }
    let mut n = root;
    'down: loop {
        if n.is_error() || n.is_missing() {
            return Some(n.start_position().row as u32 + 1);
        }
        let mut c = n.walk();
        for ch in n.children(&mut c) {
            if ch.has_error() || ch.is_missing() {
                n = ch;
                continue 'down;
            }
        }
        return Some(n.start_position().row as u32 + 1);
    }
}

pub fn diagnose(source: &str) -> Option<Diagnosis> {
    let base = first_error(source)?;
    let fixed = |text: &str| first_error(text).is_none_or(|l| l > base);
    let regions = regions(source);
    let mut budget = MAX_PARSES;

    let attempts: [(&str, Box<dyn Fn(&str) -> String>); 4] = [
        ("comments", Box::new(|s: &str| blank(s, regions.iter().filter(|r| r.kind == Kind::Comment)))),
        ("strings", Box::new(|s: &str| blank(s, regions.iter().filter(|r| r.kind != Kind::Comment)))),
        ("nonAscii", Box::new(|s: &str| s.chars().map(ascii).collect())),
        ("tabs", Box::new(|s: &str| s.replace('\t', " "))),
    ];
    for (name, rewrite) in &attempts {
        budget -= 1;
        if !fixed(&rewrite(source)) {
            continue;
        }
        let mut out: Diagnosis = vec![("fixedBy".into(), (*name).into())];
        match *name {
            "comments" | "strings" => {
                let want_comment = *name == "comments";
                // Nearest to the error first: the culprit is usually just above it.
                let mut candidates: Vec<&Region> = regions.iter().filter(|r| (r.kind == Kind::Comment) == want_comment).collect();
                candidates.sort_by_key(|r| (line_of(source, r.start) as i64 - base as i64).abs());
                for r in candidates {
                    if budget == 0 {
                        break;
                    }
                    budget -= 1;
                    if fixed(&blank(source, std::iter::once(r))) {
                        let kind = match r.kind {
                            Kind::Comment => "comment",
                            Kind::Text => "string",
                            Kind::Raw => "raw",
                        };
                        out.push(("kind".into(), kind.into()));
                        out.push(("linesBefore".into(), (base as i64 - line_of(source, r.start) as i64).to_string()));
                        out.extend(profile(&source[r.start..r.end]));
                        break;
                    }
                }
            }
            "nonAscii" => {
                // The line whose non-ASCII characters alone break the parse.
                for (i, l) in source.lines().enumerate() {
                    if l.is_ascii() || budget == 0 {
                        continue;
                    }
                    budget -= 1;
                    let text: String = source
                        .lines()
                        .enumerate()
                        .map(|(k, x)| if k == i { x.chars().map(ascii).collect() } else { x.to_string() })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if fixed(&text) {
                        out.push(("linesBefore".into(), (base as i64 - i as i64 - 1).to_string()));
                        out.extend(profile(l));
                        break;
                    }
                }
            }
            _ => {}
        }
        return Some(out);
    }
    Some(vec![("fixedBy".into(), "none".into())])
}

/// Non-ASCII made harmless: spaces and invisible characters (NBSP, zero-width, BOM) become a space, the rest `x`.
fn ascii(c: char) -> char {
    if c.is_ascii() {
        c
    } else if c.is_whitespace() || matches!(c, '\u{200B}'..='\u{200F}' | '\u{2060}' | '\u{FEFF}') {
        ' '
    } else {
        'x'
    }
}

fn line_of(source: &str, byte: usize) -> u32 {
    source[..byte].matches('\n').count() as u32 + 1
}

/// Every character of the regions except line breaks becomes `x`: lines stay where they were.
fn blank<'a>(source: &str, regions: impl Iterator<Item = &'a Region>) -> String {
    let mut ranges: Vec<(usize, usize)> = regions.map(|r| (r.start, r.end)).collect();
    ranges.sort();
    let mut out = String::with_capacity(source.len());
    let mut k = 0;
    for (i, c) in source.char_indices() {
        while k < ranges.len() && ranges[k].1 <= i {
            k += 1;
        }
        let inside = k < ranges.len() && ranges[k].0 <= i && i < ranges[k].1;
        out.push(if inside && c != '\n' && c != '\r' { 'x' } else { c });
    }
    out
}

/// The shape of a text without its words.
fn profile(text: &str) -> Diagnosis {
    let mut classes = Vec::new();
    let has = |f: &dyn Fn(char) -> bool| text.chars().any(f);
    if has(&|c| c.is_ascii_alphabetic()) {
        classes.push("latin");
    }
    if has(&|c| c.is_ascii_digit()) {
        classes.push("digits");
    }
    if has(&|c| ('\u{0400}'..='\u{04FF}').contains(&c)) {
        classes.push("cyrillic");
    }
    if has(&|c| c.is_alphabetic() && !c.is_ascii() && !('\u{0400}'..='\u{04FF}').contains(&c)) {
        classes.push("otherLetters");
    }
    if has(&|c| c == ' ') {
        classes.push("spaces");
    }
    if has(&|c| c == '\t') {
        classes.push("tabs");
    }
    if has(&|c| c == '\n') {
        classes.push("lineBreaks");
    }
    if has(&|c| c == '\r') {
        classes.push("carriageReturns");
    }
    let mut punct: Vec<char> = text.chars().filter(|c| c.is_ascii_punctuation()).collect();
    punct.sort();
    punct.dedup();
    let mut unicode: Vec<String> = text
        .chars()
        .filter(|c| !c.is_ascii() && !c.is_alphabetic())
        .map(|c| format!("U+{:04X}", c as u32))
        .collect();
    unicode.sort();
    unicode.dedup();
    unicode.truncate(12);
    vec![
        ("length".into(), text.chars().count().to_string()),
        ("classes".into(), classes.join(",")),
        ("punct".into(), punct.into_iter().collect()),
        ("unicode".into(), unicode.join(",")),
    ]
}

/// Comments and string texts of a Kotlin source (templates `${…}` stay inside the string region: blanking them
/// keeps the string valid).
fn regions(source: &str) -> Vec<Region> {
    let b = source.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                let start = i + 2;
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                out.push(Region { kind: Kind::Comment, start, end: i });
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let start = i + 2;
                let mut nest = 0;
                let mut end = b.len();
                while i < b.len() {
                    if b[i..].starts_with(b"/*") {
                        nest += 1;
                        i += 2;
                    } else if b[i..].starts_with(b"*/") {
                        nest -= 1;
                        i += 2;
                        if nest == 0 {
                            end = i - 2;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                out.push(Region { kind: Kind::Comment, start, end: end.max(start) });
            }
            b'\'' => {
                i += 1;
                while i < b.len() && b[i] != b'\'' && b[i] != b'\n' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'"' if b[i..].starts_with(b"\"\"\"") => {
                let start = i + 3;
                i = start;
                let mut depth = 0usize;
                while i < b.len() {
                    if depth == 0 && b[i..].starts_with(b"\"\"\"") {
                        let mut close = i;
                        while close + 3 < b.len() && b[close + 3] == b'"' {
                            close += 1; // extra quotes before the closing ones belong to the text
                        }
                        out.push(Region { kind: Kind::Raw, start, end: close });
                        i = close + 3;
                        break;
                    }
                    if b[i..].starts_with(b"${") {
                        depth += 1;
                        i += 2;
                        continue;
                    }
                    if depth > 0 && b[i] == b'}' {
                        depth -= 1;
                    }
                    i += 1;
                }
            }
            b'"' => {
                let start = i + 1;
                i = start;
                let mut depth = 0usize;
                while i < b.len() && b[i] != b'\n' {
                    if depth == 0 && b[i] == b'"' {
                        break;
                    }
                    if b[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if b[i..].starts_with(b"${") {
                        depth += 1;
                        i += 2;
                        continue;
                    }
                    if depth > 0 && b[i] == b'}' {
                        depth -= 1;
                    }
                    i += 1;
                }
                let end = i.min(b.len());
                out.push(Region { kind: Kind::Text, start, end });
                i = end + 1;
            }
            _ => i += 1,
        }
    }
    // Ranges must end on character boundaries for slicing.
    out.retain(|r| r.start <= r.end && source.is_char_boundary(r.start) && source.is_char_boundary(r.end));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(d: &'a Diagnosis, k: &str) -> &'a str {
        d.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str()).unwrap_or("")
    }

    #[test]
    fn finds_an_invisible_character_that_breaks_the_grammar() {
        // A non-breaking space pasted into code: invisible in the error window, fatal for the grammar.
        let src = "class A {\n    val ok = \"fine\"\n    val\u{00A0}bad = 2\n    fun f() = 1\n}\n";
        assert!(first_error(src).is_some());
        let d = diagnose(src).unwrap();
        assert_eq!(get(&d, "fixedBy"), "nonAscii", "{d:?}");
        assert_eq!(get(&d, "unicode"), "U+00A0");
        // The grammar reports the error at the class `{` (line 1); the culprit is two lines below it.
        assert_eq!(get(&d, "linesBefore"), "-2", "{d:?}");
        assert!(!format!("{d:?}").contains("fine") && !format!("{d:?}").contains("bad"));
    }

    #[test]
    fn blanking_keeps_lines_and_delimiters() {
        let src = "val a = \"é b\" // c\nval b = 1\n";
        assert_eq!(blank(src, regions(src).iter()), "val a = \"xxx\" //xx\nval b = 1\n");
    }

    #[test]
    fn finds_a_comment_and_describes_it_without_words() {
        let regions = regions("val a = 1 // note: 5 \"x\"\n/* outer /* inner */ */\nval b = \"q${x}r\"\nval c = \"\"\"raw\"\"\"\"\n");
        let kinds: Vec<Kind> = regions.iter().map(|r| r.kind).collect();
        assert_eq!(kinds, vec![Kind::Comment, Kind::Comment, Kind::Text, Kind::Raw]);
        let p = profile("Ошибка: id=5\t«x»");
        assert_eq!(get(&p, "classes"), "latin,digits,cyrillic,spaces,tabs");
        assert_eq!(get(&p, "punct"), ":=");
        assert_eq!(get(&p, "unicode"), "U+00AB,U+00BB");
    }

    #[test]
    fn says_nothing_for_a_clean_file() {
        assert!(diagnose("class A {\n    val x = 1\n}\n").is_none());
    }
}
