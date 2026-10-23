//! Source scans that pin ADR-0208 D14 point 4: **only three named functions bind somebody else's
//! owner scope** (`app.member_id`), and nothing sets that GUC behind the helper's back.
//!
//! A text scan can be written so that it cannot fail (an allow-list nobody reads, a regex that
//! matches nothing), so the scans below are plain functions over `(path, text)` pairs and the suite
//! proves each one **goes red on a synthetic fourth offender** before it trusts it on the real tree.
//!
//! * **Scan A — bypass guard.** The set of non-test source files that contain a raw
//!   `set_config('app.member_id' …` (or a `SET [LOCAL] app.member_id`) is exactly
//!   [`RAW_BINDER_FILES`]: the binder module and the two older bindings. Anyone binding without the
//!   helper adds a file, and the set stops matching.
//! * **Scan B — misuse guard.** The functions that call `bind_foreign_owner_guc(` and
//!   `restore_owner_guc(` are exactly [`FOREIGN_BINDERS`]. Scan A alone could not see this: the
//!   scheduled module legitimately binds its callers' own ids all day.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const RAW_BINDER_FILES: [&str; 3] = [
    "bins/momo-server/src/routes/approvals.rs",
    "crates/momo-messaging/src/memory.rs",
    "crates/momo-messaging/src/owner_scope.rs",
];

pub const FOREIGN_BINDERS: [&str; 3] = [
    "cancel_member_schedules_in_tx",
    "hold_lineage_schedules_in_tx",
    "hold_member_schedules_in_tx",
];

pub struct Source {
    pub path: String,
    pub text: String,
}

/// Every non-test `.rs` file under `crates/*/src` and `bins/*/src` of the workspace at `root`.
pub fn load_sources(root: &Path) -> Vec<Source> {
    let mut out = Vec::new();
    for group in ["crates", "bins"] {
        let Ok(members) = std::fs::read_dir(root.join(group)) else {
            continue;
        };
        for member in members.flatten() {
            walk(&member.path().join("src"), root, &mut out);
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<Source>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if path.is_dir() {
            walk(&path, root, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(Source {
                path: relative,
                text,
            });
        }
    }
}

/// The part of a file that is not its unit-test module (`#[cfg(test)]` closes the production code).
pub fn production_part(text: &str) -> &str {
    match text.find("#[cfg(test)]") {
        Some(at) => &text[..at],
        None => text,
    }
}

fn squashed(text: &str) -> String {
    production_part(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// Scan A: the files that set `app.member_id` themselves.
pub fn raw_binder_files(sources: &[Source]) -> BTreeSet<String> {
    let needles = [
        "set_config('app.member_id'",
        "set_config(\"app.member_id\"",
        "setlocalapp.member_id",
        "setsessionapp.member_id",
        "setapp.member_id",
    ];
    sources
        .iter()
        .filter(|source| {
            let text = squashed(&source.text);
            needles.iter().any(|needle| text.contains(needle))
        })
        .map(|source| source.path.clone())
        .collect()
}

/// Scan B: for each call of `callee(` in non-test code, the name of the function it sits in →
/// how many calls it makes. The definition (`fn callee(`) is not a call.
pub fn callers_of(sources: &[Source], callee: &str) -> BTreeMap<String, usize> {
    let call = format!("{callee}(");
    let mut out = BTreeMap::new();
    for source in sources {
        let text = production_part(&source.text);
        let functions = function_starts(text);
        let mut from = 0;
        while let Some(found) = text[from..].find(&call) {
            let at = from + found;
            from = at + call.len();
            // a definition, or a longer identifier that merely ends with the name
            let before = text[..at].trim_end();
            if before.ends_with("fn") {
                continue;
            }
            if text[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_')
            {
                continue;
            }
            let enclosing = functions
                .iter()
                .rev()
                .find(|(start, _)| *start < at)
                .map(|(_, name)| name.clone())
                .unwrap_or_else(|| "<outside any fn>".to_string());
            *out.entry(enclosing).or_insert(0) += 1;
        }
    }
    out
}

/// `(byte offset, name)` of every `fn name` in `text`.
fn function_starts(text: &str) -> Vec<(usize, String)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = text[at..].find("fn ") {
        let start = at + found;
        at = start + 3;
        let boundary =
            start == 0 || !(bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_');
        if !boundary {
            continue;
        }
        let name: String = text[start + 3..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            out.push((start, name));
        }
    }
    out
}

/// What is wrong with the real tree, as sentences; empty = both scans hold.
pub fn violations(sources: &[Source]) -> Vec<String> {
    let mut problems = Vec::new();
    let raw = raw_binder_files(sources);
    let allowed: BTreeSet<String> = RAW_BINDER_FILES
        .iter()
        .map(|path| path.to_string())
        .collect();
    for extra in raw.difference(&allowed) {
        problems.push(format!(
            "{extra} sets app.member_id itself (use owner_scope::bind_owner_guc)"
        ));
    }
    for missing in allowed.difference(&raw) {
        problems.push(format!(
            "{missing} no longer sets app.member_id: the allow-list is stale or the scan stopped seeing it"
        ));
    }
    let expected: BTreeMap<String, usize> = FOREIGN_BINDERS
        .iter()
        .map(|name| (name.to_string(), 1))
        .collect();
    for callee in ["bind_foreign_owner_guc", "restore_owner_guc"] {
        let found = callers_of(sources, callee);
        if found != expected {
            problems.push(format!(
                "{callee} is called from {found:?}, expected exactly {expected:?}: only the three named \
                 lifecycle functions may bind another member's owner scope"
            ));
        }
    }
    problems
}
