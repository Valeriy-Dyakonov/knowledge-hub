//! Anonymised Kotlin fragments for parse problem reports: the shape of the code without its names, literals or
//! comments, so a report can be shared outside the team. Keywords, punctuation, indentation and well-known
//! Kotlin/Spring names stay; every other identifier becomes `A1`/`x1` (consistently within one fragment).
use std::collections::HashMap;

const KEYWORDS: &[&str] = &[
    "package", "import", "as", "class", "interface", "object", "companion", "fun", "val", "var", "const", "lateinit", "constructor", "init",
    "this", "super", "return", "if", "else", "when", "for", "while", "do", "try", "catch", "finally", "throw", "in", "is", "out", "by",
    "where", "typealias", "null", "true", "false", "private", "protected", "internal", "public", "open", "abstract", "final", "override",
    "sealed", "data", "enum", "annotation", "inner", "value", "inline", "noinline", "crossinline", "reified", "suspend", "tailrec",
    "operator", "infix", "external", "expect", "actual", "vararg", "get", "set", "field", "it", "break", "continue", "fun",
];

/// Framework and standard names: harmless and needed to understand the construct.
const KNOWN: &[&str] = &[
    "String", "Int", "Long", "Short", "Byte", "Double", "Float", "Boolean", "Char", "Unit", "Any", "Nothing", "List", "MutableList",
    "Set", "MutableSet", "Map", "MutableMap", "Array", "Pair", "Triple", "Sequence", "Flow", "Result", "UUID", "BigDecimal", "Instant",
    "LocalDate", "LocalDateTime", "Optional", "Mono", "Flux", "listOf", "mapOf", "setOf", "emptyList", "lazy", "let", "apply", "also", "run",
    "with", "require", "check", "println",
    "Service", "Component", "Repository", "RestController", "Controller", "Configuration", "Bean", "Autowired", "Value", "Qualifier",
    "Transactional", "Async", "Scheduled", "EventListener", "TransactionalEventListener", "KafkaListener", "RabbitListener", "JmsListener",
    "SqsListener", "RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestBody",
    "PathVariable", "RequestParam", "RequestHeader", "ResponseStatus", "Valid", "Entity", "Table", "Column", "Id", "GeneratedValue",
    "ManyToOne", "OneToMany", "OneToOne", "ManyToMany", "JoinColumn", "Embedded", "Embeddable", "Query", "Modifying", "Param",
    "FeignClient", "JpaRepository", "CrudRepository", "KafkaTemplate", "RestTemplate", "WebClient", "JdbcTemplate", "ConfigurationProperties",
    "SpringBootApplication", "JvmStatic", "JvmField", "JvmOverloads", "Throws", "Suppress", "Deprecated", "JsonProperty", "JsonIgnore",
];

/// Anonymises a fragment of Kotlin source.
pub fn anonymise(src: &str) -> String {
    let mut names: HashMap<String, String> = HashMap::new();
    let (mut upper, mut lower) = (0, 0);
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
        } else if c == '"' {
            let triple = chars.get(i + 1) == Some(&'"') && chars.get(i + 2) == Some(&'"');
            i += if triple { 3 } else { 1 };
            while i < chars.len() {
                if triple && chars[i] == '"' && chars.get(i + 1) == Some(&'"') && chars.get(i + 2) == Some(&'"') {
                    i += 3;
                    break;
                }
                if !triple && chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if !triple && (chars[i] == '"' || chars[i] == '\n') {
                    i += 1;
                    break;
                }
                i += 1;
            }
            out.push_str("\"…\"");
        } else if c == '\'' {
            i += 1;
            while i < chars.len() && chars[i] != '\'' && chars[i] != '\n' {
                i += if chars[i] == '\\' { 2 } else { 1 };
            }
            i += 1;
            out.push_str("'c'");
        } else if c.is_ascii_digit() {
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                i += 1;
            }
            out.push('0');
        } else if c.is_alphabetic() || c == '_' || c == '`' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '`') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if KEYWORDS.contains(&word.as_str()) || KNOWN.contains(&word.as_str()) {
                out.push_str(&word);
            } else {
                let alias = names.entry(word.clone()).or_insert_with(|| {
                    if word.starts_with(|ch: char| ch.is_uppercase()) {
                        upper += 1;
                        format!("A{upper}")
                    } else {
                        lower += 1;
                        format!("x{lower}")
                    }
                });
                out.push_str(alias);
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    // Trailing spaces from removed comments are noise.
    out.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")
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
}
