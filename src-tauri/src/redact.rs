//! Removes secrets before anything goes to the LLM or the store. Conservative: false positives are acceptable.
use regex::Regex;
use std::sync::LazyLock;

pub const MASK: &str = "***";

static SECRET_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(password|passwd|pwd|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credential|client[-_.]?secret)").unwrap());

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // key = value / key: value where the key looks secret
        (Regex::new(r#"(?i)((?:password|passwd|pwd|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credentials?)[\w.-]*\s*[:=]\s*)(["']?)[^\s"',;]+(["']?)"#).unwrap(), "${1}${2}***${3}"),
        (Regex::new(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap(), "${1}***"),
        (Regex::new(r"sk-[A-Za-z0-9_-]{16,}").unwrap(), "***"),
        (Regex::new(r"gh[pousr]_[A-Za-z0-9]{20,}").unwrap(), "***"),
        (Regex::new(r"glpat-[A-Za-z0-9_-]{16,}").unwrap(), "***"),
        (Regex::new(r"AKIA[0-9A-Z]{16}").unwrap(), "***"),
        (Regex::new(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}").unwrap(), "***"),
        // user:password@host in URLs
        (Regex::new(r"(://[^/:@\s]+:)[^@\s]+(@)").unwrap(), "${1}***${2}"),
    ]
});

pub fn is_secret_key(key: &str) -> bool {
    SECRET_KEY.is_match(key)
}

/// Value of a configuration property: masked entirely when the key looks secret, pattern-redacted otherwise.
pub fn value(key: &str, value: &str) -> String {
    if is_secret_key(key) && !value.trim().is_empty() && !value.trim_start().starts_with("${") {
        return MASK.into();
    }
    text(value)
}

pub fn text(input: &str) -> String {
    let mut out = input.to_string();
    for (re, rep) in PATTERNS.iter() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secret_keys_and_known_token_shapes() {
        assert_eq!(value("spring.datasource.password", "s3cr3t"), MASK);
        assert_eq!(value("clients.payments.api-key", "abc"), MASK);
        // A placeholder is not a secret: it only names where the secret comes from.
        assert_eq!(value("spring.datasource.password", "${DB_PASSWORD}"), "${DB_PASSWORD}");
        assert_eq!(value("payments.url", "http://payments:8080"), "http://payments:8080");
        assert_eq!(text("password=hunter2 next"), "password=*** next");
        assert_eq!(text("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer ***");
        assert_eq!(text("jdbc://user:pa55@db/x"), "jdbc://user:***@db/x");
        assert_eq!(text("key sk-abcdefghijklmnopqrstuv"), "key ***");
    }
}
