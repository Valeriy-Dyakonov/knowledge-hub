//! Anonymised Kotlin fragments for parse problem reports: the shape of the code without its names, literal contents or
//! comments, so a report can be shared outside the team. Keywords, punctuation, indentation, line breaks, string
//! delimiters and templates (`"…${x1.x2}…"`, `"""…"""`, `$$"…"`) and well-known Kotlin/Spring names stay; every other
//! identifier becomes `A1`/`x1`, consistently within one report entry.
use std::collections::HashMap;

const KEYWORDS: &[&str] = &[
    "package", "import", "as", "class", "interface", "object", "companion", "fun", "val", "var", "const", "lateinit", "constructor", "init",
    "this", "super", "return", "if", "else", "when", "for", "while", "do", "try", "catch", "finally", "throw", "in", "is", "out", "by",
    "where", "typealias", "null", "true", "false", "private", "protected", "internal", "public", "open", "abstract", "final", "override",
    "sealed", "data", "enum", "annotation", "inner", "value", "inline", "noinline", "crossinline", "reified", "suspend", "tailrec",
    "operator", "infix", "external", "expect", "actual", "vararg", "get", "set", "field", "it", "break", "continue", "context",
];

/// Framework and standard names: harmless and needed to understand the construct.
const KNOWN: &[&str] = &[
    "String", "Int", "Long", "Short", "Byte", "Double", "Float", "Boolean", "Char", "Unit", "Any", "Nothing", "List", "MutableList",
    "Set", "MutableSet", "Map", "MutableMap", "Array", "Pair", "Triple", "Sequence", "Flow", "Result", "UUID", "BigDecimal", "Instant",
    "LocalDate", "LocalDateTime", "Optional", "Mono", "Flux", "listOf", "mapOf", "setOf", "mutableListOf", "mutableMapOf", "emptyList",
    "emptyMap", "to", "lazy", "let", "apply", "also", "run", "with", "require", "check", "println", "copy", "trimIndent", "trimMargin",
    "Service", "Component", "Repository", "RestController", "Controller", "Configuration", "Bean", "Autowired", "Value", "Qualifier",
    "Transactional", "Async", "Scheduled", "EventListener", "TransactionalEventListener", "KafkaListener", "RabbitListener", "JmsListener",
    "SqsListener", "RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestBody",
    "PathVariable", "RequestParam", "RequestHeader", "ResponseStatus", "Valid", "Entity", "Table", "Column", "Id", "GeneratedValue",
    "ManyToOne", "OneToMany", "OneToOne", "ManyToMany", "JoinColumn", "Embedded", "Embeddable", "Query", "Modifying", "Param",
    "FeignClient", "JpaRepository", "CrudRepository", "KafkaTemplate", "RestTemplate", "WebClient", "JdbcTemplate", "ConfigurationProperties",
    "SpringBootApplication", "JvmStatic", "JvmField", "JvmOverloads", "Throws", "Suppress", "Deprecated", "JsonProperty", "JsonIgnore",
    "ConcurrentHashMap", "AtomicInteger", "AtomicLong", "Duration", "ZonedDateTime", "OffsetDateTime",
];

/// Anonymises a fragment of Kotlin source; line breaks are kept so markers can be put on lines afterwards.
pub fn anonymise(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut a = Anon { names: HashMap::new(), upper: 0, lower: 0 };
    let mut out = String::new();
    a.code(&chars, 0, chars.len(), &mut out);
    out.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")
}

struct Anon {
    names: HashMap<String, String>,
    upper: usize,
    lower: usize,
}

impl Anon {
    fn name(&mut self, word: &str) -> String {
        if KEYWORDS.contains(&word) || KNOWN.contains(&word) {
            return word.to_string();
        }
        if let Some(n) = self.names.get(word) {
            return n.clone();
        }
        let alias = if word.trim_matches('`').starts_with(|c: char| c.is_uppercase()) {
            self.upper += 1;
            format!("A{}", self.upper)
        } else {
            self.lower += 1;
            format!("x{}", self.lower)
        };
        self.names.insert(word.to_string(), alias.clone());
        alias
    }

    /// Code in `[i, end)`; returns where it stopped (at `end`, or at an unmatched `}` when inside a template).
    fn code(&mut self, c: &[char], mut i: usize, end: usize, out: &mut String) -> usize {
        while i < end {
            let ch = c[i];
            if ch == '/' && c.get(i + 1) == Some(&'/') {
                while i < end && c[i] != '\n' {
                    i += 1;
                }
            } else if ch == '/' && c.get(i + 1) == Some(&'*') {
                i += 2;
                while i + 1 < end && !(c[i] == '*' && c[i + 1] == '/') {
                    if c[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i += 2;
            } else if ch == '"' {
                i = self.string(c, i, end, out, 1);
            } else if ch == '$' && i + 1 < end && (c[i + 1] == '$' || c[i + 1] == '"') {
                // Multi-dollar string: `$$"…"` / `$$"""…"""`.
                let mut d = 0;
                while i + d < end && c[i + d] == '$' {
                    d += 1;
                }
                if c.get(i + d) == Some(&'"') {
                    out.push_str(&"$".repeat(d));
                    i = self.string(c, i + d, end, out, d);
                } else {
                    out.push_str(&"$".repeat(d));
                    i += d;
                }
            } else if ch == '\'' {
                i += 1;
                while i < end && c[i] != '\'' && c[i] != '\n' {
                    i += if c[i] == '\\' { 2 } else { 1 };
                }
                i += 1;
                out.push_str("'c'");
            } else if ch.is_ascii_digit() {
                while i < end && (c[i].is_ascii_alphanumeric() || c[i] == '_' || (c[i] == '.' && c.get(i + 1).is_some_and(|n| n.is_ascii_digit()))) {
                    i += 1;
                }
                out.push('0');
            } else if ch.is_alphabetic() || ch == '_' || ch == '`' {
                let start = i;
                i += 1;
                while i < end && (c[i].is_alphanumeric() || c[i] == '_' || (c[start] == '`' && c[i] != '`' && c[i] != '\n')) {
                    i += 1;
                }
                if c[start] == '`' && i < end && c[i] == '`' {
                    i += 1;
                }
                let word: String = c[start..i].iter().collect();
                let n = self.name(&word);
                out.push_str(&n);
            } else {
                out.push(ch);
                i += 1;
            }
        }
        i
    }

    /// A string literal starting at the opening quote `i`; `dollars` is the interpolation prefix length ($ or $$...).
    fn string(&mut self, c: &[char], mut i: usize, end: usize, out: &mut String, dollars: usize) -> usize {
        let raw = c.get(i + 1) == Some(&'"') && c.get(i + 2) == Some(&'"');
        let quote = if raw { "\"\"\"" } else { "\"" };
        out.push_str(quote);
        i += quote.len();
        let mut text = false; // inside a run of literal text, already shown as "…"
        while i < end {
            if raw && c[i] == '"' && c.get(i + 1) == Some(&'"') && c.get(i + 2) == Some(&'"') {
                i += 3;
                while i < end && c[i] == '"' {
                    i += 1; // extra quotes before the closing ones belong to the text
                }
                break;
            }
            if !raw && (c[i] == '"' || c[i] == '\n') {
                i += 1;
                break;
            }
            if !raw && c[i] == '\\' {
                // Escapes say nothing about the project, and `\$` or `\"` may be what the grammar trips on.
                out.push('\\');
                if let Some(&e) = c.get(i + 1).filter(|e| e.is_ascii_punctuation() || matches!(e, 'n' | 'r' | 't' | 'b' | 'u')) {
                    out.push(e);
                }
                text = false;
                i += 2;
                continue;
            }
            // Template: `dollars` dollar signs followed by `{` or an identifier.
            let is_dollars = (0..dollars).all(|k| c.get(i + k) == Some(&'$'));
            if is_dollars && c.get(i + dollars) == Some(&'{') {
                out.push_str(&"$".repeat(dollars));
                out.push('{');
                let inner_end = matching_brace(c, i + dollars, end);
                self.code(c, i + dollars + 1, inner_end, out);
                out.push('}');
                i = (inner_end + 1).min(end);
                text = false;
                continue;
            }
            if is_dollars && c.get(i + dollars).is_some_and(|n| n.is_alphabetic() || *n == '_') {
                out.push_str(&"$".repeat(dollars));
                let start = i + dollars;
                i = start;
                while i < end && (c[i].is_alphanumeric() || c[i] == '_') {
                    i += 1;
                }
                let word: String = c[start..i].iter().collect();
                let n = self.name(&word);
                out.push_str(&n);
                text = false;
                continue;
            }
            if c[i] == '\n' {
                out.push('\n');
                text = false;
            } else if STRING_PUNCTUATION.contains(&c[i]) {
                // The shape of the text without its words: quotes, `$`, braces and brackets stay.
                out.push(c[i]);
                text = false;
            } else if !text {
                out.push('…');
                text = true;
            }
            i += 1;
        }
        out.push_str(quote);
        i
    }
}

/// Characters of string text shown as they are: they carry no project names and are what the grammar can trip on.
const STRING_PUNCTUATION: [char; 8] = ['$', '"', '\'', '{', '}', '[', ']', '\\'];

/// Index of the `}` closing the `{` at `open`, skipping nested braces and strings.
fn matching_brace(c: &[char], open: usize, end: usize) -> usize {
    let mut depth = 0;
    let mut i = open;
    while i < end {
        match c[i] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            '"' => {
                i += 1;
                while i < end && c[i] != '"' {
                    i += if c[i] == '\\' { 2 } else { 1 };
                }
            }
            _ => {}
        }
        i += 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_shape_and_hides_names_literals_and_comments() {
        let src = r#"@Service
class RefundAudit(private val repo: RefundRepo) { // secret note
    companion object { val TOKEN = "s3cr3t-123" }
    fun audit(id: Long) = repo.findById(id, 42)
}"#;
        let a = anonymise(src);
        assert_eq!(
            a,
            "@Service\nclass A1(private val x1: A2) {\n    companion object { val A3 = \"…\" }\n    fun x2(x3: Long) = x1.x4(x3, 0)\n}"
        );
        assert!(!a.contains("Refund") && !a.contains("s3cr3t") && !a.contains("secret"));
    }

    #[test]
    fn keeps_string_templates_and_kinds() {
        assert_eq!(anonymise(r#"x.copy(status = "${order.id}-${"done"}")"#), r#"x1.copy(x2 = "${x3.x4}…${"…"}")"#);
        assert_eq!(anonymise(r#"val s = "Hello $name, \"q\"""#), r#"val x1 = "…$x2…\"…\"""#);
        // Punctuation of the text stays: a lone `$`, JSON braces, regex escapes.
        assert_eq!(anonymise(r#"jsonPath("$.items[0].id", """{"a": "\d+"}""")"#), r#"x1("$…[…]…", """{"…"…"\…"}""")"#);
        assert_eq!(anonymise("val j = $$\"\"\"\n{\"k\": \"$$value\"}\n\"\"\""), "val x1 = $$\"\"\"\n{\"…\"…\"$$value\"}\n\"\"\"");
        assert_eq!(anonymise("val sql = \"\"\"\n  select * from t\n\"\"\".trimIndent()"), "val x1 = \"\"\"\n…\n\"\"\".trimIndent()");
    }
}
