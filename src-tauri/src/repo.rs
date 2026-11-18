//! Read-only view of an analysed repository. The hub never writes to it; reads outside the root are refused.
//! The commit comes from `.git` files directly, without running git.
use crate::error::{AppError, AppResult};
use crate::model::{Evidence, LineRange};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const UNKNOWN_COMMIT: &str = "unknown";
const IGNORED_DIRS: [&str; 9] = [".git", ".gradle", ".idea", "build", "out", "target", "node_modules", ".kotlin", ".state"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub commit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

pub struct RepoSnapshot {
    pub root: PathBuf,
    pub name: String,
    pub commit: String,
    pub branch: Option<String>,
}

impl RepoSnapshot {
    pub fn open(path: &str) -> AppResult<Self> {
        let root = PathBuf::from(path);
        if !root.is_dir() {
            return Err(AppError::new("repoNotFound").with("path", path));
        }
        let root = root.canonicalize().map_err(AppError::raw)?;
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
        let (commit, branch) = git_head(&root);
        Ok(Self { root, name, commit, branch })
    }

    pub fn info(&self) -> RepoInfo {
        RepoInfo { path: display(&self.root), name: self.name.clone(), commit: self.commit.clone(), branch: self.branch.clone() }
    }

    /// Relative unix-style paths of files accepted by `filter`, skipping build output and VCS folders. Sorted.
    pub fn files(&self, filter: impl Fn(&str) -> bool) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    if !IGNORED_DIRS.contains(&name.as_str()) {
                        stack.push(path);
                    }
                } else if kind.is_file() {
                    if let Ok(rel) = path.strip_prefix(&self.root) {
                        let rel = rel.to_string_lossy().replace('\\', "/");
                        if filter(&rel) {
                            out.push(rel);
                        }
                    }
                }
            }
        }
        out.sort();
        out
    }

    pub fn read(&self, rel: &str) -> AppResult<String> {
        let path = self.resolve(rel)?;
        let bytes = fs::read(&path).map_err(|e| AppError::raw(format!("{rel}: {e}")))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.resolve(rel).map(|p| p.is_file()).unwrap_or(false)
    }

    /// Evidence for `rel` (whole file when `lines` is None) with the fingerprint of the referenced fragment.
    pub fn evidence(&self, rel: &str, text: &str, lines: Option<(u32, u32)>) -> Evidence {
        let fragment = match lines {
            Some((s, e)) => slice_lines(text, s, e),
            None => text.to_string(),
        };
        Evidence {
            repo: self.name.clone(),
            path: rel.to_string(),
            lines: lines.map(|(start, end)| LineRange { start, end: end.max(start) }),
            commit: self.commit.clone(),
            fingerprint: fingerprint(&fragment),
        }
    }

    fn resolve(&self, rel: &str) -> AppResult<PathBuf> {
        let p = Path::new(rel);
        let escapes = p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir));
        if escapes {
            return Err(AppError::new("pathOutsideRepo").with("path", rel));
        }
        Ok(self.root.join(p))
    }
}

pub fn slice_lines(text: &str, start: u32, end: u32) -> String {
    text.lines().skip(start.saturating_sub(1) as usize).take((end.max(start) - start + 1) as usize).collect::<Vec<_>>().join("\n")
}

/// Whitespace-insensitive hash of a code fragment, so reformatting alone does not make a claim stale.
pub fn fingerprint(fragment: &str) -> String {
    let compact: String = fragment.chars().filter(|c| !c.is_whitespace()).collect();
    let digest = Sha256::digest(compact.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Path shown to the user: without the `\\?\` prefix `canonicalize` adds on Windows.
pub fn display(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
}

fn git_head(root: &Path) -> (String, Option<String>) {
    let read = |p: PathBuf| fs::read_to_string(p).ok().map(|s| s.trim().to_string());
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if let Some(link) = read(dot_git.clone()) {
        root.join(link.trim_start_matches("gitdir:").trim())
    } else {
        return (UNKNOWN_COMMIT.into(), None);
    };
    let Some(head) = read(git_dir.join("HEAD")) else { return (UNKNOWN_COMMIT.into(), None) };
    let Some(reference) = head.strip_prefix("ref:").map(str::trim) else { return (head, None) };
    let branch = reference.strip_prefix("refs/heads/").map(String::from);
    let sha = read(git_dir.join(reference)).or_else(|| {
        read(git_dir.join("packed-refs"))?.lines().find_map(|l| {
            let mut it = l.split_whitespace();
            let (sha, name) = (it.next()?, it.next()?);
            (name == reference).then(|| sha.to_string())
        })
    });
    (sha.unwrap_or_else(|| UNKNOWN_COMMIT.into()), branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_commit_and_refuses_paths_outside() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git/refs/heads");
        fs::create_dir_all(&git).unwrap();
        fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(git.join("main"), "abc1234def\n").unwrap();
        fs::create_dir_all(dir.path().join("src/build")).unwrap();
        fs::write(dir.path().join("src/A.kt"), "class A").unwrap();
        fs::write(dir.path().join("src/build/B.kt"), "class B").unwrap();

        let repo = RepoSnapshot::open(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(repo.commit, "abc1234def");
        assert_eq!(repo.branch.as_deref(), Some("main"));
        assert_eq!(repo.files(|p| p.ends_with(".kt")), vec!["src/A.kt"]);
        assert_eq!(repo.read("../x").unwrap_err().code, "pathOutsideRepo");
    }

    #[test]
    fn fingerprint_ignores_whitespace() {
        assert_eq!(fingerprint("fun a() {\n  b()\n}"), fingerprint("fun a(){ b() }"));
        assert_ne!(fingerprint("fun a()"), fingerprint("fun b()"));
    }
}
