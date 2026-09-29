//! 「이 세션 동안」 허락 — the host's memory of one (ADR-0146 증보 #3095,
//! D-8 · ADR-0188 §8.6).
//!
//! The owner's signed `allow` with scope `session` answers the request in
//! front of it **and** leaves a [`Grant`] in that session's task. A later
//! `session/request_permission` of the same session is answered `allow_once`
//! without asking only when a grant *covers* it. The rule is deliberately
//! narrow — a session grant is a convenience for repeating what the owner just
//! saw, not a policy:
//!
//! | tool kind | a grant covers a later request when |
//! |---|---|
//! | `execute` | the title and the input (the command) are byte-identical |
//! | `read`, `search` | every location is under the directory the granted request touched (its locations' deepest common directory, at least three components deep — never `/`, never a home directory) |
//! | `edit` | the locations are exactly the granted files |
//! | `delete`, `move`, `fetch`, `think`, `switch_mode`, `other` | never: the grant answers only the request the owner saw |
//!
//! Paths are compared after `canonicalize` (symlinks resolved, `..` gone); a
//! path that does not resolve, is relative, or has a hidden or
//! credential-looking component below the granted directory is asked about
//! again. A truncated preview neither creates nor matches a grant.
//!
//! **Where a grant ends.** It lives in the session task, so the session's end
//! (any cause: the turn's agent exiting, `kill`, the server closing it, the
//! host being revoked) drops it. A shared [`GrantEpoch`] outlives no task but
//! reaches all of them: the local app's `pin_root`, `revoke_device` and
//! `reset_signature_requirement`, and a relayed device revocation, bump it —
//! a grant of an older epoch never matches again (ratchet resets and key
//! revocations cannot leave a standing allowance behind).
//!
//! The preview hash the owner signed binds the *first* allow. Later automatic
//! allows are judged by this rule, and each is recorded (`approval.auto_allowed`
//! on the session stream, `work.permission.auto_allowed` in the audit log)
//! with the hash of the preview it matched.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use momo_wire::permission_preview::PermissionPreview;

/// The most grants one session keeps (the oldest is dropped).
pub const MAX_GRANTS_PER_SESSION: usize = 8;
/// The most locations a preview may name and still be matched.
const MAX_LOCATIONS: usize = 16;
/// A granted directory must be at least this deep (`/Users/me/project` = 4
/// components with the root; `/Users/me` = 3 and is refused as a home).
const MIN_DIR_COMPONENTS: usize = 4;

/// The generation every grant is stamped with. Bumping it retires all of them.
#[derive(Debug, Clone, Default)]
pub struct GrantEpoch(Arc<AtomicU64>);

impl GrantEpoch {
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    /// Retire every grant made so far.
    pub fn retire_all(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Rule {
    /// `execute`: this command and nothing else.
    Command { title: String, input: String },
    /// `read` / `search`: anything under this directory.
    Under { kind: String, dir: PathBuf },
    /// `edit`: these files.
    Files { files: Vec<PathBuf> },
}

/// One remembered 「이 세션 동안」.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    epoch: u64,
    rule: Rule,
}

/// A session's grants.
#[derive(Debug, Default)]
pub struct Grants(Vec<Grant>);

impl Grants {
    /// Remember what the owner just allowed for the session. `false` when this
    /// kind of request is never generalised (the allow stays one-shot).
    pub fn remember(&mut self, preview: &PermissionPreview, epoch: &GrantEpoch) -> bool {
        let Some(rule) = rule_for(preview) else {
            return false;
        };
        let grant = Grant {
            epoch: epoch.current(),
            rule,
        };
        self.0.retain(|known| known.rule != grant.rule);
        if self.0.len() >= MAX_GRANTS_PER_SESSION {
            self.0.remove(0);
        }
        self.0.push(grant);
        true
    }

    /// Whether a live grant covers `preview`. Retired grants are dropped here.
    pub fn covers(&mut self, preview: &PermissionPreview, epoch: &GrantEpoch) -> bool {
        let now = epoch.current();
        self.0.retain(|grant| grant.epoch == now);
        if self.0.is_empty() || preview.truncated {
            return false;
        }
        self.0.iter().any(|grant| covers(&grant.rule, preview))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn rule_for(preview: &PermissionPreview) -> Option<Rule> {
    if preview.truncated {
        return None;
    }
    match preview.kind.as_str() {
        "execute" => {
            if preview.input.trim().is_empty() {
                return None;
            }
            Some(Rule::Command {
                title: preview.title.clone(),
                input: preview.input.clone(),
            })
        }
        kind @ ("read" | "search") => {
            let paths = resolved_locations(&preview.locations)?;
            let dir = common_dir(&paths)?;
            if dir.components().count() < MIN_DIR_COMPONENTS {
                return None;
            }
            Some(Rule::Under {
                kind: kind.to_string(),
                dir,
            })
        }
        "edit" => {
            let mut files = resolved_locations(&preview.locations)?;
            files.sort();
            files.dedup();
            Some(Rule::Files { files })
        }
        _ => None,
    }
}

fn covers(rule: &Rule, preview: &PermissionPreview) -> bool {
    match rule {
        Rule::Command { title, input } => {
            preview.kind == "execute" && &preview.title == title && &preview.input == input
        }
        Rule::Under { kind, dir } => {
            if &preview.kind != kind {
                return false;
            }
            let Some(paths) = resolved_locations(&preview.locations) else {
                return false;
            };
            paths.iter().all(|path| {
                path.strip_prefix(dir)
                    .is_ok_and(|below| !below.components().any(sensitive_component))
            })
        }
        Rule::Files { files } => {
            if preview.kind != "edit" {
                return false;
            }
            let Some(mut paths) = resolved_locations(&preview.locations) else {
                return false;
            };
            paths.sort();
            paths.dedup();
            &paths == files
        }
    }
}

/// A component below a granted directory that a session grant never opens:
/// hidden entries (`.ssh`, `.env`, `.git`) and names that say what they hold.
fn sensitive_component(component: Component<'_>) -> bool {
    let Component::Normal(name) = component else {
        return true;
    };
    let name = name.to_string_lossy().to_lowercase();
    name.starts_with('.')
        || [
            "secret",
            "credential",
            "password",
            "passwd",
            "token",
            "private",
            "id_rsa",
            "id_ed25519",
        ]
        .iter()
        .any(|word| name.contains(word))
}

/// The preview's `locations` (one `path` or `path:line` per line) as resolved
/// absolute paths. `None` when there are none, too many, or any does not
/// resolve — the request is then asked about.
fn resolved_locations(locations: &str) -> Option<Vec<PathBuf>> {
    let lines: Vec<&str> = locations.lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() || lines.len() > MAX_LOCATIONS {
        return None;
    }
    lines
        .into_iter()
        .map(|line| resolve(Path::new(strip_line(line))))
        .collect()
}

/// `path:12` → `path` (only a trailing all-digit suffix is a line number).
fn strip_line(line: &str) -> &str {
    match line.rsplit_once(':') {
        Some((path, digits))
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            path
        }
        _ => line,
    }
}

/// An absolute, symlink-free path. A file that does not exist yet resolves
/// through its parent directory (an `edit` may create it).
fn resolve(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    if let Ok(real) = std::fs::canonicalize(path) {
        return Some(real);
    }
    let name = path.file_name()?;
    let parent = std::fs::canonicalize(path.parent()?).ok()?;
    Some(parent.join(name))
}

/// The deepest directory that contains every path (a file's own directory).
fn common_dir(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut dirs = paths.iter().map(|path| {
        if path.is_dir() {
            path.clone()
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or_default()
        }
    });
    let mut common = dirs.next()?;
    for dir in dirs {
        while !dir.starts_with(&common) {
            if !common.pop() {
                return None;
            }
        }
    }
    Some(common)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(kind: &str, title: &str, locations: &str, input: &str) -> PermissionPreview {
        PermissionPreview {
            kind: kind.into(),
            title: title.into(),
            locations: locations.into(),
            input: input.into(),
            truncated: false,
        }
    }

    /// A real directory tree under the temp dir (canonicalised: /var → /private/var).
    fn tree(name: &str) -> PathBuf {
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("momo-grant-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join(".ssh")).unwrap();
        std::fs::create_dir_all(dir.join("other")).unwrap();
        for file in [
            "src/a.rs",
            "src/b.rs",
            "src/deep/c.rs",
            ".ssh/id",
            ".env",
            "src/token.txt",
            "other/x.rs",
        ] {
            std::fs::write(dir.join(file), "x").unwrap();
        }
        dir
    }

    fn loc(dir: &Path, rel: &str) -> String {
        dir.join(rel).display().to_string()
    }

    #[test]
    fn execute_is_the_exact_command_only() {
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        let ran = preview("execute", "Run ls", "", "ls -la");
        assert!(grants.remember(&ran, &epoch));
        assert!(grants.covers(&ran, &epoch));
        assert!(!grants.covers(
            &preview("execute", "Run ls", "", "ls -la; rm -rf ~"),
            &epoch
        ));
        assert!(!grants.covers(&preview("execute", "Run ls", "", "ls -la "), &epoch));
        assert!(!grants.covers(&preview("execute", "Run other", "", "ls -la"), &epoch));
        assert!(!grants.covers(&preview("read", "Run ls", "", "ls -la"), &epoch));
        assert!(!grants.remember(&preview("execute", "empty", "", "  "), &epoch));
    }

    #[test]
    fn a_read_grant_covers_the_granted_directory_and_nothing_wider() {
        let dir = tree("read");
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        let first = preview("read", "Read", &loc(&dir, "src/a.rs:10"), "");
        assert!(grants.remember(&first, &epoch));
        // Same directory, a sibling, and below.
        assert!(grants.covers(&preview("read", "Read", &loc(&dir, "src/b.rs"), ""), &epoch));
        assert!(grants.covers(
            &preview("read", "Read", &loc(&dir, "src/deep/c.rs:3"), ""),
            &epoch
        ));
        // Above, beside, and a different tool kind.
        assert!(!grants.covers(
            &preview("read", "Read", &loc(&dir, "other/x.rs"), ""),
            &epoch
        ));
        assert!(!grants.covers(
            &preview("read", "Read", &dir.display().to_string(), ""),
            &epoch
        ));
        assert!(!grants.covers(
            &preview("search", "Search", &loc(&dir, "src/a.rs"), ""),
            &epoch
        ));
        assert!(!grants.covers(&preview("edit", "Edit", &loc(&dir, "src/a.rs"), ""), &epoch));
        // One location outside the directory refuses the whole request.
        let mixed = format!("{}\n{}", loc(&dir, "src/a.rs"), loc(&dir, "other/x.rs"));
        assert!(!grants.covers(&preview("read", "Read", &mixed, ""), &epoch));
        // Hidden and credential-looking names below the directory are asked about.
        assert!(!grants.covers(
            &preview("read", "Read", &loc(&dir, "src/token.txt"), ""),
            &epoch
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dotdot_symlinks_and_relative_paths_do_not_widen_a_grant() {
        let dir = tree("escape");
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        assert!(grants.remember(&preview("read", "Read", &loc(&dir, "src/a.rs"), ""), &epoch));
        let dotdot = format!("{}/src/../other/x.rs", dir.display());
        assert!(!grants.covers(&preview("read", "Read", &dotdot, ""), &epoch));
        assert!(!grants.covers(&preview("read", "Read", "src/a.rs", ""), &epoch));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("other"), dir.join("src/link")).unwrap();
            assert!(!grants.covers(
                &preview("read", "Read", &loc(&dir, "src/link/x.rs"), ""),
                &epoch
            ));
            std::os::unix::fs::symlink(dir.join(".ssh/id"), dir.join("src/innocent")).unwrap();
            assert!(!grants.covers(
                &preview("read", "Read", &loc(&dir, "src/innocent"), ""),
                &epoch
            ));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shallow_directory_is_never_granted() {
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        for shallow in ["/etc/hosts", "/tmp", "/"] {
            assert!(
                !grants.remember(&preview("read", "Read", shallow, ""), &epoch),
                "{shallow}"
            );
        }
        assert!(grants.is_empty());
    }

    #[test]
    fn an_edit_grant_is_the_exact_files() {
        let dir = tree("edit");
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        assert!(grants.remember(
            &preview("edit", "Edit", &loc(&dir, "src/a.rs:4"), ""),
            &epoch
        ));
        assert!(grants.covers(
            &preview("edit", "Edit", &loc(&dir, "src/a.rs:99"), ""),
            &epoch
        ));
        assert!(!grants.covers(&preview("edit", "Edit", &loc(&dir, "src/b.rs"), ""), &epoch));
        let two = format!("{}\n{}", loc(&dir, "src/a.rs"), loc(&dir, "src/b.rs"));
        assert!(!grants.covers(&preview("edit", "Edit", &two, ""), &epoch));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn destructive_and_unknown_kinds_are_never_generalised() {
        let dir = tree("never");
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        for kind in ["delete", "move", "fetch", "think", "switch_mode", "other"] {
            let p = preview(kind, "t", &loc(&dir, "src/a.rs"), "in");
            assert!(!grants.remember(&p, &epoch), "{kind}");
            assert!(!grants.covers(&p, &epoch), "{kind}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_truncated_preview_neither_creates_nor_matches() {
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        let mut cut = preview("execute", "Run", "", "ls");
        cut.truncated = true;
        assert!(!grants.remember(&cut, &epoch));
        let whole = preview("execute", "Run", "", "ls");
        assert!(grants.remember(&whole, &epoch));
        assert!(!grants.covers(&cut, &epoch));
    }

    #[test]
    fn retiring_the_epoch_ends_every_grant() {
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        let ran = preview("execute", "Run", "", "ls");
        grants.remember(&ran, &epoch);
        assert!(grants.covers(&ran, &epoch));
        epoch.retire_all();
        assert!(!grants.covers(&ran, &epoch));
        assert!(grants.is_empty(), "a retired grant is dropped, not kept");
        // A grant made after the reset lives.
        grants.remember(&ran, &epoch);
        assert!(grants.covers(&ran, &epoch));
    }

    #[test]
    fn a_session_keeps_a_bounded_number_of_grants() {
        let epoch = GrantEpoch::default();
        let mut grants = Grants::default();
        for n in 0..(MAX_GRANTS_PER_SESSION + 3) {
            grants.remember(&preview("execute", "Run", "", &format!("cmd {n}")), &epoch);
        }
        assert_eq!(grants.len(), MAX_GRANTS_PER_SESSION);
        assert!(!grants.covers(&preview("execute", "Run", "", "cmd 0"), &epoch));
        assert!(grants.covers(&preview("execute", "Run", "", "cmd 10"), &epoch));
    }
}
