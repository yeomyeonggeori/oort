// Local git reads for the work tab (ADR-0190 D3-c, #2855).
//
// The work tab's worktree view and log panel show a pane's repository,
// branch, commits ahead/behind and diff numbers. They are read on this Mac,
// by eight fixed git commands, and only parsed fields cross to the webview:
//
//   workbench_git_read { command: "g1".."g8", paneId } -> GitReadResult
//
// The boundary (every point is pinned by a test below or in
// `shell_contract.rs`):
//
// 1. **Exactly eight commands.** `GIT_COMMANDS` is the whole allowlist, one
//    row per G1..G8, arguments literal and identical to the ADR table. It is
//    a separate list from the login-status one (D3-a, `harness_status.rs`).
//    No write command (`fetch`, `gc`, `commit`, `checkout` …), nothing that
//    uses the network, no `gh`.
// 2. **The webview names a number and a pane, nothing else.** The request is
//    `{ command, paneId }` with unknown fields refused. The folder is the one
//    the shell recorded when it opened that pane (`folder_of`); a pane that is
//    gone, or a folder that no longer exists, is "unknown" — there is no
//    fallback folder. No event listener, deep link, server message or workd
//    path calls into this module.
// 3. **No shell, fixed prefix, fixed environment.** `<git>` is the absolute
//    path found once on the app's search PATH. It runs directly with an argv
//    array (never `sh -c`, never a joined command line), always behind
//    `GIT_PREFIX`: no pager, no optional locks, fsmonitor off, pager `cat`, no
//    colour. Every inherited `GIT_*` variable is removed (an app started with
//    `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CONFIG_PARAMETERS` would otherwise read
//    another repository or config than the pane's), then `GIT_ENV` is set.
//    `--no-ext-diff --no-textconv` on the two diffs stop the repository's
//    external diff and textconv programs. Known gap, reported on #2855: a
//    `filter.<driver>.clean` program named by the repository's own config and
//    attributes still runs when git hashes a touched worktree file (G6, G8).
//    The ADR's prefix does not cover it; closing it changes the ADR.
// 4. **Parsed here, fields only.** stdin and stderr are null, stdout is piped
//    into a buffer of at most `MAX_STDOUT` bytes and parsed in this file. The
//    webview gets the fields the ADR table lists — never stdout itself, a
//    commit subject or body, a remote URL, file contents, a full path (G1 and
//    G3 give the last path element), or an e-mail address.
// 5. **Bounded.** `GIT_TIMEOUT` per command; over time or over the byte cap
//    the child is killed and the answer is "unknown".
// 6. **No server.** The result goes to this Mac's webview only. This module
//    has no network code; what is shared is D4-b's business, not this one's.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::harness_path;

/// Prefix of every git command, before the command's own arguments.
pub const GIT_PREFIX: &[&str] = &[
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=false",
];

/// Set on every git child after every inherited `GIT_*` is removed.
pub const GIT_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_PAGER", "cat"),
];

/// Inherited variables starting with this are removed before `GIT_ENV` is
/// set (`GIT_EXTERNAL_DIFF` among them).
pub const GIT_ENV_STRIPPED_PREFIX: &str = "GIT_";

/// One command's wall-clock limit. The reads are local and small; a busy
/// disk on a large repository is the slow case.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// stdout bytes one command may produce. A diff of ~50,000 files fits; more
/// than that is "unknown" rather than a partial answer.
pub const MAX_STDOUT: usize = 4 << 20;

// Output caps: D4-b's field limits, applied here too so the webview never
// holds more than the share payload could carry.
const MAX_NAME_CHARS: usize = 100;
const MAX_BRANCH_CHARS: usize = 200;
const MAX_CO_AUTHOR_CHARS: usize = 80;
const MAX_CO_AUTHORS: usize = 8;
const MAX_PATH_CHARS: usize = 1024;

/// G1..G8 of ADR-0190 D3-c.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRead {
    G1,
    G2,
    G3,
    G4,
    G5,
    G6,
    G7,
    G8,
}

#[derive(Debug, PartialEq, Eq)]
pub struct GitCommand {
    pub read: GitRead,
    pub args: &'static [&'static str],
}

/// The complete allowlist, verbatim from the ADR table.
pub const GIT_COMMANDS: &[GitCommand] = &[
    GitCommand {
        read: GitRead::G1,
        args: &["rev-parse", "--show-toplevel"],
    },
    GitCommand {
        read: GitRead::G2,
        args: &["branch", "--show-current"],
    },
    GitCommand {
        read: GitRead::G3,
        args: &["worktree", "list", "--porcelain", "-z"],
    },
    GitCommand {
        read: GitRead::G4,
        args: &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    },
    GitCommand {
        read: GitRead::G5,
        args: &[
            "log",
            "--no-color",
            "--format=%h%x00%ct%x00%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)",
            "-n",
            "50",
            "@{upstream}..HEAD",
        ],
    },
    GitCommand {
        read: GitRead::G6,
        args: &[
            "diff",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            "HEAD",
        ],
    },
    GitCommand {
        read: GitRead::G7,
        args: &[
            "diff",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            "@{upstream}...HEAD",
        ],
    },
    GitCommand {
        read: GitRead::G8,
        args: &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    },
];

impl GitRead {
    fn row(self) -> &'static GitCommand {
        GIT_COMMANDS
            .iter()
            .find(|row| row.read == self)
            .expect("every GitRead has a row")
    }

    /// G4, G5 and G7 compare against the upstream: git exits non-zero when
    /// there is none. stderr is discarded, so "no upstream" cannot be told
    /// from "not a repository" here — G1 answers that.
    fn needs_upstream(self) -> bool {
        matches!(self, GitRead::G4 | GitRead::G5 | GitRead::G7)
    }
}

/// What the webview may ask: a command number and a pane. Nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitReadRequest {
    pub command: GitRead,
    pub pane_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Last path element of the worktree's folder.
    pub folder: String,
    /// `None` = detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    /// Commit time, seconds since the epoch.
    pub time: i64,
    /// `Co-Authored-By` names, e-mail addresses dropped.
    pub co_authors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    /// Repository-relative path (the new path of a rename).
    pub path: String,
    /// `None` for a binary file.
    pub added: Option<u64>,
    pub deleted: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTotals {
    pub files: u64,
    pub added: u64,
    pub deleted: u64,
    pub binary: u64,
}

/// The parsed value of one command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitValue {
    /// G1: last path element of the top-level folder.
    Repo { name: String },
    /// G2: `None` = detached HEAD.
    Branch { name: Option<String> },
    /// G3
    Worktrees { worktrees: Vec<Worktree> },
    /// G4
    AheadBehind { behind: u64, ahead: u64 },
    /// G5
    Commits { commits: Vec<Commit> },
    /// G6 (worktree vs HEAD) and G7 (since the upstream).
    Diff {
        files: Vec<DiffFile>,
        totals: DiffTotals,
    },
    /// G8: counts only, no paths.
    Status {
        modified: u64,
        added: u64,
        deleted: u64,
        untracked: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", content = "value", rename_all = "camelCase")]
pub enum GitReadResult {
    Ok(GitValue),
    /// G4/G5/G7 exited non-zero: no upstream (「기준점 없음」).
    NoUpstream,
    /// Could not run, timed out, too much output, failed, or unparseable
    /// (「확인 못 함」).
    Unknown,
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/// What one run produced: the exit and stdout, or nothing (did not start,
/// timed out, over the byte cap).
struct Ran {
    success: bool,
    stdout: Vec<u8>,
}

/// Run one allowlisted row by absolute path in `folder`.
fn run_git(git: &Path, folder: &Path, row: &GitCommand, timeout: Duration) -> Option<Ran> {
    if !git.is_absolute() || !folder.is_dir() {
        return None;
    }
    let mut cmd = Command::new(git);
    cmd.args(GIT_PREFIX)
        .args(row.args)
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_none_or(|k| k.starts_with(GIT_ENV_STRIPPED_PREFIX))
        {
            cmd.env_remove(&key);
        }
    }
    for key in harness_path::STRIPPED_ENV {
        cmd.env_remove(key);
    }
    for (key, value) in GIT_ENV {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Drain on a thread so a full pipe cannot stall the child while this one
    // watches the clock. Past the cap it stops reading and reports overflow.
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) if buf.len() + n <= MAX_STDOUT => buf.extend_from_slice(&chunk[..n]),
                Ok(_) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
        let _ = tx.send(Some(buf));
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                if let Ok(None) = rx.try_recv() {
                    break None; // over the cap
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let left = deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(500);
    let stdout = rx.recv_timeout(left).ok().flatten()?;
    Some(Ran {
        success: status.success(),
        stdout,
    })
}

/// One command, end to end: run, then parse into fields.
pub fn read(git: &Path, folder: &Path, read: GitRead, timeout: Duration) -> GitReadResult {
    let Some(ran) = run_git(git, folder, read.row(), timeout) else {
        return GitReadResult::Unknown;
    };
    if !ran.success {
        return if read.needs_upstream() {
            GitReadResult::NoUpstream
        } else {
            GitReadResult::Unknown
        };
    }
    parse(read, &ran.stdout).map_or(GitReadResult::Unknown, GitReadResult::Ok)
}

// ---------------------------------------------------------------------------
// Parsing (pure; the tests drive these directly)
// ---------------------------------------------------------------------------

pub fn parse(read: GitRead, out: &[u8]) -> Option<GitValue> {
    match read {
        GitRead::G1 => parse_toplevel(out),
        GitRead::G2 => parse_branch(out),
        GitRead::G3 => Some(parse_worktrees(out)),
        GitRead::G4 => parse_ahead_behind(out),
        GitRead::G5 => Some(parse_commits(out)),
        GitRead::G6 | GitRead::G7 => parse_numstat(out),
        GitRead::G8 => Some(parse_status(out)),
    }
}

fn cap(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// Last element of an absolute path, capped; never a separator.
fn last_element(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_string_lossy();
    let name = cap(&name, MAX_NAME_CHARS);
    (!name.is_empty() && !name.contains('/') && !name.contains('\\')).then_some(name)
}

fn one_line(out: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(out).ok()?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    (!text.contains('\n')).then(|| text.to_string())
}

fn parse_toplevel(out: &[u8]) -> Option<GitValue> {
    let line = one_line(out)?;
    if !line.starts_with('/') {
        return None;
    }
    Some(GitValue::Repo {
        name: last_element(&line)?,
    })
}

fn branch_name(name: &str) -> Option<String> {
    let name = cap(name, MAX_BRANCH_CHARS);
    (!name.is_empty()).then_some(name)
}

fn parse_branch(out: &[u8]) -> Option<GitValue> {
    let line = one_line(out)?;
    Some(GitValue::Branch {
        name: branch_name(line.trim()),
    })
}

fn parse_worktrees(out: &[u8]) -> GitValue {
    let mut worktrees = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in out.split(|b| *b == 0) {
        let field = String::from_utf8_lossy(field);
        if field.is_empty() {
            worktrees.extend(current.take());
            continue;
        }
        if let Some(path) = field.strip_prefix("worktree ") {
            worktrees.extend(current.take());
            current = last_element(path).map(|folder| Worktree {
                folder,
                branch: None,
                detached: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(tree) = current.as_mut() else {
            continue;
        };
        let (key, rest) = field.split_once(' ').unwrap_or((&field, ""));
        match key {
            "branch" => tree.branch = branch_name(rest.strip_prefix("refs/heads/").unwrap_or(rest)),
            "detached" => tree.detached = true,
            // A reason may follow; it is dropped.
            "locked" => tree.locked = true,
            "prunable" => tree.prunable = true,
            _ => {}
        }
    }
    worktrees.extend(current);
    GitValue::Worktrees { worktrees }
}

fn parse_ahead_behind(out: &[u8]) -> Option<GitValue> {
    let line = one_line(out)?;
    let (behind, ahead) = line.split_once('\t')?;
    Some(GitValue::AheadBehind {
        behind: behind.parse().ok()?,
        ahead: ahead.parse().ok()?,
    })
}

/// One `Co-Authored-By` value → the name, without the address.
fn co_author_name(value: &str) -> Option<String> {
    let name = match value.find('<') {
        Some(at) => &value[..at],
        None => value,
    };
    let name = cap(name.trim(), MAX_CO_AUTHOR_CHARS);
    (!name.is_empty() && !name.contains('@')).then_some(name)
}

fn parse_commits(out: &[u8]) -> GitValue {
    let text = String::from_utf8_lossy(out);
    let mut commits: Vec<Commit> = Vec::new();
    for line in text.split('\n') {
        let fields: Vec<&str> = line.split('\0').collect();
        // A record is exactly `<hash>\0<seconds>\0<trailers>`. Anything
        // else (a folded trailer's continuation line, noise) is dropped.
        let [hash, time, trailers] = fields.as_slice() else {
            continue;
        };
        let hash_ok = (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit());
        let Ok(time) = time.parse::<i64>() else {
            continue;
        };
        if !hash_ok {
            continue;
        }
        let co_authors = trailers
            .split(',')
            .filter_map(co_author_name)
            .take(MAX_CO_AUTHORS)
            .collect();
        commits.push(Commit {
            hash: hash.to_ascii_lowercase(),
            time,
            co_authors,
        });
    }
    GitValue::Commits { commits }
}

fn count(field: &str) -> Option<Option<u64>> {
    match field {
        "-" => Some(None),
        n => n.parse().ok().map(Some),
    }
}

fn parse_numstat(out: &[u8]) -> Option<GitValue> {
    let mut fields = out.split(|b| *b == 0);
    let mut files = Vec::new();
    let mut totals = DiffTotals {
        files: 0,
        added: 0,
        deleted: 0,
        binary: 0,
    };
    while let Some(head) = fields.next() {
        if head.is_empty() {
            continue;
        }
        let head = String::from_utf8_lossy(head);
        let mut parts = head.splitn(3, '\t');
        let added = count(parts.next()?)?;
        let deleted = count(parts.next()?)?;
        let inline = parts.next()?;
        // A rename is `A\tD\t\0old\0new\0`: the path field is empty and the
        // next two fields are the two paths.
        let path = if inline.is_empty() {
            let _old = fields.next()?;
            String::from_utf8_lossy(fields.next()?).into_owned()
        } else {
            inline.to_string()
        };
        let binary = added.is_none() || deleted.is_none();
        totals.files += 1;
        totals.added += added.unwrap_or(0);
        totals.deleted += deleted.unwrap_or(0);
        totals.binary += u64::from(binary);
        files.push(DiffFile {
            path: cap(&path, MAX_PATH_CHARS),
            added: if binary { None } else { added },
            deleted: if binary { None } else { deleted },
            binary,
        });
    }
    Some(GitValue::Diff { files, totals })
}

fn parse_status(out: &[u8]) -> GitValue {
    let (mut modified, mut added, mut deleted, mut untracked) = (0, 0, 0, 0);
    let mut fields = out.split(|b| *b == 0);
    while let Some(entry) = fields.next() {
        if entry.len() < 3 {
            continue;
        }
        let (x, y) = (entry[0], entry[1]);
        // A rename or copy carries the original path as the next field.
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            let _ = fields.next();
        }
        match (x, y) {
            (b'?', b'?') => untracked += 1,
            (b'!', b'!') => {}
            _ if x == b'D' || y == b'D' => deleted += 1,
            _ if x == b'A' => added += 1,
            _ => modified += 1,
        }
    }
    GitValue::Status {
        modified,
        added,
        deleted,
        untracked,
    }
}

// ---------------------------------------------------------------------------
// Webview command
// ---------------------------------------------------------------------------

/// git on the app's search PATH, found once.
fn git_binary() -> Option<PathBuf> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(|| {
        let path: OsString = harness_path::current_search_path();
        harness_path::find_on_path("git", &path)
    })
    .clone()
}

/// Best-effort; never an error. The page names a command number and a pane.
#[tauri::command]
pub async fn workbench_git_read(
    state: tauri::State<'_, crate::pty::PtyState>,
    request: GitReadRequest,
) -> Result<GitReadResult, ()> {
    let Some(folder) = state.0.folder_of(request.pane_id) else {
        return Ok(GitReadResult::Unknown);
    };
    let Some(git) = git_binary() else {
        return Ok(GitReadResult::Unknown);
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        read(&git, &folder, request.command, GIT_TIMEOUT)
    })
    .await
    .unwrap_or(GitReadResult::Unknown))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production_source() -> &'static str {
        include_str!("git_read.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source")
    }

    // ── The allowlist ──────────────────────────────────────────────────────

    /// Exactly eight commands, arguments verbatim from ADR-0190 D3-c.
    #[test]
    fn allowlist_is_exactly_the_eight_adr_commands() {
        let table: Vec<(GitRead, Vec<&str>)> = GIT_COMMANDS
            .iter()
            .map(|row| (row.read, row.args.to_vec()))
            .collect();
        assert_eq!(
            table,
            vec![
                (GitRead::G1, vec!["rev-parse", "--show-toplevel"]),
                (GitRead::G2, vec!["branch", "--show-current"]),
                (GitRead::G3, vec!["worktree", "list", "--porcelain", "-z"]),
                (
                    GitRead::G4,
                    vec!["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]
                ),
                (
                    GitRead::G5,
                    vec![
                        "log",
                        "--no-color",
                        "--format=%h%x00%ct%x00%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)",
                        "-n",
                        "50",
                        "@{upstream}..HEAD",
                    ]
                ),
                (
                    GitRead::G6,
                    vec!["diff", "--numstat", "--no-ext-diff", "--no-textconv", "-z", "HEAD"]
                ),
                (
                    GitRead::G7,
                    vec![
                        "diff",
                        "--numstat",
                        "--no-ext-diff",
                        "--no-textconv",
                        "-z",
                        "@{upstream}...HEAD"
                    ]
                ),
                (
                    GitRead::G8,
                    vec!["status", "--porcelain=v1", "-z", "--untracked-files=normal"]
                ),
            ]
        );
        assert_eq!(
            GIT_PREFIX,
            [
                "--no-pager",
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.pager=cat",
                "-c",
                "color.ui=false"
            ]
        );
        assert_eq!(
            GIT_ENV,
            [
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_OPTIONAL_LOCKS", "0"),
                ("GIT_PAGER", "cat")
            ]
        );
        // The request enum has exactly the eight numbers.
        for (n, row) in GIT_COMMANDS.iter().enumerate() {
            let wire = serde_json::to_value(row.read).unwrap();
            assert_eq!(wire, serde_json::json!(format!("g{}", n + 1)));
        }
    }

    /// The login-status list (D3-a/D3-b) and this list are separate: neither
    /// carries the other's commands.
    #[test]
    fn the_git_list_and_the_login_status_list_are_separate() {
        let status = crate::harness_status::STATUS_COMMANDS;
        assert_eq!(status.len(), 2);
        assert!(status.iter().all(|c| c.program != "git"));
        for row in GIT_COMMANDS {
            for word in row.args {
                assert!(!["auth", "login", "status\u{0}"].contains(word), "{word}");
            }
            assert!(!status.iter().any(|c| c.args == row.args), "{row:?}");
        }
        // The only program this file runs is the git binary.
        let src = production_source();
        assert!(src.contains("harness_path::find_on_path(\"git\", &path)"));
        for program in ["\"claude\"", "\"codex\"", "\"gh\""] {
            assert!(!src.contains(program), "git_read mentions {program}");
        }
    }

    /// No write or network subcommand can appear as a command word.
    #[test]
    fn no_write_or_network_command_is_listed() {
        for row in GIT_COMMANDS {
            let verb = row.args[0];
            assert!(
                [
                    "rev-parse",
                    "branch",
                    "worktree",
                    "rev-list",
                    "log",
                    "diff",
                    "status"
                ]
                .contains(&verb),
                "{verb}"
            );
        }
        // `branch` and `worktree` are read-only only with these flags.
        assert_eq!(GitRead::G2.row().args, ["branch", "--show-current"]);
        assert_eq!(GitRead::G3.row().args[1], "list");
    }

    // ── No shell, one builder, fixed prefix and environment ───────────────

    #[test]
    fn one_command_builder_and_no_shell() {
        let src = production_source();
        assert_eq!(src.matches("Command::new(").count(), 1);
        assert!(src.contains("Command::new(git)"));
        for needle in [
            "\"sh\"",
            "\"/bin/sh\"",
            "\"-c\"\n",
            "\"zsh\"",
            "\"bash\"",
            "\"cmd\"",
            "\"/C\"",
            ".arg(format!",
            "split_whitespace",
        ] {
            assert!(!src.contains(needle), "git_read must not use {needle}");
        }
        // The prefix and the row's args are the only argv, in that order.
        let run = &src[src.find("fn run_git(").unwrap()..];
        let run = &run[..run.find("\n}\n").unwrap()];
        assert_eq!(run.matches(".args(").count(), 2, "{run}");
        assert_eq!(run.matches(".arg(").count(), 0, "{run}");
        assert!(run.contains("cmd.args(GIT_PREFIX)\n        .args(row.args)"));
        assert!(run.contains(".stdin(Stdio::null())"));
        assert!(run.contains(".stderr(Stdio::null())"));
        assert!(run.contains(".current_dir(folder)"));
        assert!(run.contains("for (key, value) in GIT_ENV {"));
    }

    /// The webview input carries a number and a pane: no string, no path,
    /// no argv field, and unknown fields are refused.
    #[test]
    fn the_request_is_a_command_number_and_a_pane_only() {
        let ok: GitReadRequest =
            serde_json::from_value(serde_json::json!({ "command": "g6", "paneId": 3 })).unwrap();
        assert_eq!(
            ok,
            GitReadRequest {
                command: GitRead::G6,
                pane_id: 3
            }
        );
        for bad in [
            serde_json::json!({ "command": "g6", "paneId": 3, "cwd": "/tmp" }),
            serde_json::json!({ "command": "g6", "paneId": 3, "args": ["log"] }),
            serde_json::json!({ "command": "g9", "paneId": 3 }),
            serde_json::json!({ "command": "log", "paneId": 3 }),
            serde_json::json!({ "command": "G1", "paneId": 3 }),
            serde_json::json!({ "command": "g1", "paneId": "/Users" }),
            serde_json::json!({ "command": "g1" }),
        ] {
            assert!(
                serde_json::from_value::<GitReadRequest>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        let src = production_source();
        let request = &src[src.find("pub struct GitReadRequest {").unwrap()..];
        let request = &request[..request.find('}').unwrap()];
        assert_eq!(
            request
                .lines()
                .filter(|l| l.trim().starts_with("pub "))
                .count(),
            3,
            "{request}"
        );
        assert!(request.contains("pub command: GitRead,"));
        assert!(request.contains("pub pane_id: u32,"));
        for field in ["String", "PathBuf", "Path", "Vec", "OsString"] {
            assert!(!request.contains(field), "request has a {field} field");
        }
        let command = &src[src.find("pub async fn workbench_git_read(").unwrap()..];
        let signature = &command[..command.find('{').unwrap()];
        for field in ["String", "PathBuf", "&str", "Vec<"] {
            assert!(!signature.contains(field), "command takes {field}");
        }
        assert_eq!(
            signature.matches(':').count() - signature.matches("::").count() * 2,
            2
        );
    }

    // ── Parsers ───────────────────────────────────────────────────────────

    #[test]
    fn g1_is_the_last_path_element_only() {
        assert_eq!(
            parse(GitRead::G1, b"/Users/me/projects/momo\n"),
            Some(GitValue::Repo {
                name: "momo".into()
            })
        );
        assert_eq!(parse(GitRead::G1, b"relative/path\n"), None);
        assert_eq!(parse(GitRead::G1, b"/a\n/b\n"), None);
        assert_eq!(parse(GitRead::G1, b"/\n"), None);
    }

    #[test]
    fn g2_is_a_branch_or_detached() {
        assert_eq!(
            parse(GitRead::G2, b"feat/x\n"),
            Some(GitValue::Branch {
                name: Some("feat/x".into())
            })
        );
        assert_eq!(
            parse(GitRead::G2, b"\n"),
            Some(GitValue::Branch { name: None })
        );
    }

    #[test]
    fn g3_worktrees_keep_folder_branch_and_flags() {
        let out = b"worktree /Users/me/momo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0\
worktree /Users/me/wt/2855-x\0HEAD 2222222222222222222222222222222222222222\0detached\0locked moving disks\0prunable gitdir file points to non-existent location\0\0";
        assert_eq!(
            parse(GitRead::G3, out),
            Some(GitValue::Worktrees {
                worktrees: vec![
                    Worktree {
                        folder: "momo".into(),
                        branch: Some("main".into()),
                        detached: false,
                        locked: false,
                        prunable: false,
                    },
                    Worktree {
                        folder: "2855-x".into(),
                        branch: None,
                        detached: true,
                        locked: true,
                        prunable: true,
                    },
                ]
            })
        );
        let wire = serde_json::to_string(&parse(GitRead::G3, out)).unwrap();
        for leak in ["/Users/me", "moving disks", "gitdir", "1111111"] {
            assert!(!wire.contains(leak), "{leak} in {wire}");
        }
    }

    #[test]
    fn g4_is_behind_then_ahead() {
        assert_eq!(
            parse(GitRead::G4, b"3\t12\n"),
            Some(GitValue::AheadBehind {
                behind: 3,
                ahead: 12
            })
        );
        assert_eq!(parse(GitRead::G4, b"3 12\n"), None);
        assert_eq!(parse(GitRead::G4, b"fix the thing\n"), None);
    }

    #[test]
    fn g5_keeps_hash_time_and_co_author_names() {
        let out = b"abc1234\x001790000000\x00Claude <noreply@anthropic.com>,Ada Lovelace <ada@example.com>\n\
def5678\x001790000100\x00\n\
not a record: SECRET SUBJECT\n\
0123abc\x001790000200\x00x@y.z\x00SECRET SUBJECT\n";
        assert_eq!(
            parse(GitRead::G5, out),
            Some(GitValue::Commits {
                commits: vec![
                    Commit {
                        hash: "abc1234".into(),
                        time: 1_790_000_000,
                        co_authors: vec!["Claude".into(), "Ada Lovelace".into()],
                    },
                    Commit {
                        hash: "def5678".into(),
                        time: 1_790_000_100,
                        co_authors: vec![],
                    },
                ]
            })
        );
        let wire = serde_json::to_string(&parse(GitRead::G5, out)).unwrap();
        assert!(!wire.contains('@'), "{wire}");
        assert!(!wire.contains("SECRET"), "{wire}");
    }

    #[test]
    fn g6_numstat_handles_renames_binaries_and_totals() {
        let out = b"3\t1\tsrc/a.rs\0-\t-\tlogo.png\0\x30\t0\t\0old name.txt\0new name.txt\0";
        assert_eq!(
            parse(GitRead::G6, out),
            Some(GitValue::Diff {
                files: vec![
                    DiffFile {
                        path: "src/a.rs".into(),
                        added: Some(3),
                        deleted: Some(1),
                        binary: false,
                    },
                    DiffFile {
                        path: "logo.png".into(),
                        added: None,
                        deleted: None,
                        binary: true,
                    },
                    DiffFile {
                        path: "new name.txt".into(),
                        added: Some(0),
                        deleted: Some(0),
                        binary: false,
                    },
                ],
                totals: DiffTotals {
                    files: 3,
                    added: 3,
                    deleted: 1,
                    binary: 1,
                },
            })
        );
        assert_eq!(parse(GitRead::G7, b"SECRET SUBJECT\0"), None);
    }

    #[test]
    fn g8_is_four_counts_and_no_paths() {
        let out =
            b" M a.rs\0M  b.rs\0A  c.rs\0 D d.rs\0R  new.rs\0old.rs\0?? secret-plan.txt\0UU e.rs\0";
        let value = parse(GitRead::G8, out).unwrap();
        assert_eq!(
            value,
            GitValue::Status {
                modified: 4,
                added: 1,
                deleted: 1,
                untracked: 1,
            }
        );
        let wire = serde_json::to_string(&value).unwrap();
        assert!(!wire.contains(".rs") && !wire.contains("secret"), "{wire}");
    }

    #[test]
    fn the_wire_shape_is_tagged() {
        assert_eq!(
            serde_json::to_value(GitReadResult::Ok(GitValue::AheadBehind {
                behind: 1,
                ahead: 2
            }))
            .unwrap(),
            serde_json::json!({ "outcome": "ok", "value": { "kind": "aheadBehind", "behind": 1, "ahead": 2 } })
        );
        assert_eq!(
            serde_json::to_value(GitReadResult::NoUpstream).unwrap(),
            serde_json::json!({ "outcome": "noUpstream" })
        );
        assert_eq!(
            serde_json::to_value(GitReadResult::Unknown).unwrap(),
            serde_json::json!({ "outcome": "unknown" })
        );
    }

    // ── Isolation: nothing but the command table reaches this module ──────

    /// Every production source of the shell except this file and the test
    /// module file, cut at the unit-test module.
    fn other_sources() -> Vec<(String, String)> {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name == "git_read.rs" || name == "shell_contract.rs" {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            let production = src
                .split("#[cfg(test)]\nmod tests")
                .next()
                .unwrap_or("")
                .to_string();
            out.push((name, production));
        }
        assert!(out.iter().any(|(n, _)| n == "lib.rs"));
        out
    }

    #[test]
    fn only_the_command_table_reaches_the_git_reads() {
        for (name, src) in other_sources() {
            let calls = src.matches("git_read::").count();
            let allowed = if name == "lib.rs" { 1 } else { 0 };
            assert_eq!(calls, allowed, "{name} calls into git_read {calls}x");
            for needle in ["GIT_COMMANDS", "run_git", "workbench_git_read", "GitRead"] {
                let hits = src.matches(needle).count();
                let allowed = usize::from(name == "lib.rs" && needle == "workbench_git_read");
                assert_eq!(hits, allowed, "{name} mentions {needle}");
            }
        }
        assert!(include_str!("lib.rs").contains("git_read::workbench_git_read,"));
    }

    /// No network, event or server path in this module.
    #[test]
    fn this_module_has_no_network_or_event_code() {
        let src: String = production_source()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let src = src.as_str();
        for needle in [
            "reqwest",
            "hyper",
            "TcpStream",
            "UdpSocket",
            "UnixStream",
            "emit",
            "listen",
            "http://",
            "https://",
        ] {
            assert!(!src.contains(needle), "git_read uses {needle}");
        }
        assert!(!src.contains(&format!("{}(", "invoke")));
    }

    // ── Running against fake and real git ───────────────────────────────

    #[cfg(unix)]
    mod run {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        const SUBJECT: &str = "SECRET-SUBJECT-Acme-Project-Falcon";
        const TOKEN: &str = "ghp_FAKE2855TOKENvalueXYZ";

        struct Scratch(PathBuf);

        impl Scratch {
            fn new(tag: &str) -> Self {
                let dir =
                    std::env::temp_dir().join(format!("oort-2855-{tag}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Scratch(dir.canonicalize().unwrap())
            }

            fn script(&self, name: &str, body: &str) -> PathBuf {
                let path = self.0.join(name);
                std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
                path
            }
        }

        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        const T: Duration = Duration::from_secs(10);

        /// A fake git receives exactly prefix + row, for every row.
        #[test]
        fn the_fixed_argv_is_what_git_receives() {
            let dir = Scratch::new("argv");
            let log = dir.0.join("argv.log");
            let git = dir.script(
                "git",
                &format!(
                    "for a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{}'\nprintf '/x/repo\\n'",
                    log.display()
                ),
            );
            for row in GIT_COMMANDS {
                let _ = read(&git, &dir.0, row.read, T);
                let got = std::fs::read_to_string(&log).unwrap();
                let want: Vec<&str> = GIT_PREFIX.iter().chain(row.args).copied().collect();
                assert_eq!(got.lines().collect::<Vec<_>>(), want, "{:?}", row.read);
            }
        }

        /// A fake git that answers with commit subjects and tokens in every
        /// position the parser does not keep: none of it reaches the wire.
        #[test]
        fn noise_on_stdout_and_stderr_never_reaches_the_webview_value() {
            let dir = Scratch::new("noise");
            let git = dir.script(
                "git",
                &format!(
                    "echo '{SUBJECT} {TOKEN}' >&2\n\
                     case \"$9\" in\n\
                     rev-parse) printf '/x/repo\\n{SUBJECT}\\n' ;;\n\
                     rev-list) printf '1\\t2\\t{SUBJECT}\\n' ;;\n\
                     log) printf 'abc1234\\0%s\\0Ann <{TOKEN}@x>\\0{SUBJECT}\\n{SUBJECT}\\n{TOKEN}\\n' 1790000000 ;;\n\
                     status) printf ' M {SUBJECT}\\0?? {TOKEN}\\0' ;;\n\
                     diff) printf '{SUBJECT}\\t{TOKEN}\\tx\\0' ;;\n\
                     worktree) printf 'HEAD {TOKEN}\\0{SUBJECT}\\0\\0' ;;\n\
                     *) printf '\\n' ;;\n\
                     esac"
                ),
            );
            let mut wire = String::new();
            for row in GIT_COMMANDS {
                let result = read(&git, &dir.0, row.read, T);
                wire.push_str(&serde_json::to_string(&result).unwrap());
            }
            assert!(!wire.contains("SECRET"), "{wire}");
            assert!(!wire.contains("FAKE2855"), "{wire}");
            // And the values that should survive did.
            assert!(wire.contains("\"outcome\":\"ok\""), "{wire}");
        }

        #[test]
        fn a_hang_is_unknown_within_the_limit_and_non_zero_is_no_upstream_where_it_can_be() {
            let dir = Scratch::new("verdicts");
            let hang = dir.script("git-hang", "exec /bin/sleep 30");
            let started = Instant::now();
            assert_eq!(
                read(&hang, &dir.0, GitRead::G6, Duration::from_millis(500)),
                GitReadResult::Unknown
            );
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "timeout not enforced"
            );

            let fail = dir.script("git-fail", "exit 128");
            for row in GIT_COMMANDS {
                let want = if row.read.needs_upstream() {
                    GitReadResult::NoUpstream
                } else {
                    GitReadResult::Unknown
                };
                assert_eq!(read(&fail, &dir.0, row.read, T), want, "{:?}", row.read);
            }
            assert_eq!(
                [GitRead::G4, GitRead::G5, GitRead::G7]
                    .into_iter()
                    .filter(|r| r.needs_upstream())
                    .count(),
                3
            );
            let missing = dir.0.join("no-such-folder");
            let ok = dir.script("git-ok", "printf '/x/repo\\n'");
            assert_eq!(read(&ok, &missing, GitRead::G1, T), GitReadResult::Unknown);
            assert_eq!(
                read(Path::new("git"), &dir.0, GitRead::G1, T),
                GitReadResult::Unknown,
                "a relative program is refused"
            );
        }

        #[test]
        fn output_over_the_cap_is_unknown() {
            let dir = Scratch::new("cap");
            let git = dir.script(
                "git",
                &format!("head -c {} /dev/zero | tr '\\0' 'a'", MAX_STDOUT + 1),
            );
            assert_eq!(read(&git, &dir.0, GitRead::G8, T), GitReadResult::Unknown);
        }

        /// The child sees no inherited `GIT_*` other than the fixed three.
        #[test]
        fn inherited_git_variables_do_not_reach_the_child() {
            let dir = Scratch::new("env");
            let git = dir.script(
                "git",
                "[ -z \"${GIT_DIR+x}\" ] && [ -z \"${GIT_WORK_TREE+x}\" ] && \
                 [ -z \"${GIT_EXTERNAL_DIFF+x}\" ] && [ -z \"${GIT_CONFIG_PARAMETERS+x}\" ] && \
                 [ -z \"${GIT_INDEX_FILE+x}\" ] && \
                 [ \"$GIT_TERMINAL_PROMPT\" = 0 ] && [ \"$GIT_OPTIONAL_LOCKS\" = 0 ] && \
                 [ \"$GIT_PAGER\" = cat ] && printf '/x/repo\\n'",
            );
            let set = [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_EXTERNAL_DIFF",
                "GIT_CONFIG_PARAMETERS",
                "GIT_INDEX_FILE",
            ];
            for key in set {
                std::env::set_var(key, "dummy-2855");
            }
            let result = read(&git, &dir.0, GitRead::G1, T);
            for key in set {
                std::env::remove_var(key);
            }
            assert_eq!(
                result,
                GitReadResult::Ok(GitValue::Repo {
                    name: "repo".into()
                })
            );
        }

        // ── Real git, hostile repository config ──────────────────────────

        fn real_git() -> Option<PathBuf> {
            let git = harness_path::find_on_path("git", &harness_path::current_search_path())?;
            // /usr/bin/git without the Command Line Tools opens an install
            // dialog; only run where it answers.
            clean(Command::new(&git))
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()?
                .success()
                .then_some(git)
        }

        /// Test-side commands must not pick up a `GIT_*` another test set.
        fn clean(mut cmd: Command) -> Command {
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("GIT_") {
                    cmd.env_remove(key);
                }
            }
            cmd
        }

        fn sh(dir: &Path, script: &str) {
            let ok = clean(Command::new("/bin/sh"))
                .arg("-c")
                .arg(script)
                .current_dir(dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", dir)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "setup failed: {script}");
        }

        /// A repository whose own config names a program for every hook the
        /// ADR closes (fsmonitor, external diff, diff driver command,
        /// textconv, pager, alias shadowing a builtin, signature check,
        /// trailer command, hooks). Each program would create a marker. The
        /// eight reads run and no marker appears; the parsed values are
        /// right; no commit subject, body or token is in the wire.
        ///
        /// `filter.<x>.clean` is deliberately NOT here: the ADR prefix does
        /// not stop it (see `a_clean_filter_still_runs_known_gap`).
        #[test]
        fn a_hostile_repository_config_runs_no_program() {
            let Some(git) = real_git() else {
                eprintln!("skip: no working git on this machine");
                return;
            };
            let dir = Scratch::new("hostile");
            let repo = dir.0.join("repo");
            let marks = dir.0.join("marks");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::create_dir_all(&marks).unwrap();
            let m = marks.display();
            let g = git.display();
            let pwn = |name: &str| {
                dir.script(
                    &format!("pwn-{name}"),
                    &format!("touch '{m}/{name}'\nexit 0"),
                )
            };
            let hooks = dir.0.join("hooks");
            std::fs::create_dir_all(&hooks).unwrap();
            for hook in [
                "post-index-change",
                "reference-transaction",
                "post-checkout",
                "pre-auto-gc",
            ] {
                let path = hooks.join(hook);
                std::fs::write(&path, format!("#!/bin/sh\ntouch '{m}/hook-{hook}'\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            sh(
                &repo,
                &format!(
                    "'{g}' init -q -b main . && '{g}' config user.email t@example.com && \
                     '{g}' config user.name t && '{g}' config commit.gpgsign false && \
                     printf 'one\\n' > a.txt && printf 'x\\0y' > bin.dat && \
                     printf 'a.txt diff=pwn\\n' > .gitattributes && \
                     '{g}' add . && '{g}' commit -q -m 'base' && \
                     '{g}' branch -q up && '{g}' branch -q --set-upstream-to=up && \
                     printf 'two\\n' >> a.txt && '{g}' commit -q -am '{SUBJECT}' -m 'body {TOKEN}' \
                        -m 'Co-Authored-By: Ada Lovelace <ada@example.com>' && \
                     printf 'three\\n' >> a.txt && printf 'new\\n' > untracked.txt && \
                     '{g}' worktree add -q ../side -b side"
                ),
            );
            let cfg = [
                ("core.fsmonitor", pwn("fsmonitor")),
                ("diff.external", pwn("external-diff")),
                ("diff.pwn.command", pwn("diff-command")),
                ("diff.pwn.textconv", pwn("textconv")),
                ("core.pager", pwn("pager")),
                ("pager.log", pwn("pager-log")),
                ("pager.diff", pwn("pager-diff")),
                ("pager.status", pwn("pager-status")),
                ("gpg.program", pwn("gpg")),
                ("trailer.pwn.cmd", pwn("trailer")),
            ];
            for (key, program) in &cfg {
                sh(
                    &repo,
                    &format!("'{g}' config {key} '{}'", program.display()),
                );
            }
            for alias in [
                "status",
                "diff",
                "log",
                "branch",
                "rev-parse",
                "rev-list",
                "worktree",
            ] {
                sh(
                    &repo,
                    &format!("'{g}' config alias.{alias} '!touch {m}/alias-{alias}'"),
                );
            }
            sh(&repo, &format!("'{g}' config log.showSignature true"));
            sh(
                &repo,
                &format!("'{g}' config core.hooksPath '{}'", hooks.display()),
            );
            // Make the worktree file stat-dirty so git has to look inside it.
            sh(&repo, "touch -t 200001010000 a.txt");

            let mut wire = String::new();
            let mut results = Vec::new();
            for row in GIT_COMMANDS {
                let result = read(&git, &repo, row.read, T);
                wire.push_str(&serde_json::to_string(&result).unwrap());
                results.push(result);
            }
            let fired: Vec<String> = std::fs::read_dir(&marks)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert!(fired.is_empty(), "programs ran: {fired:?}");

            assert!(!wire.contains("SECRET"), "{wire}");
            assert!(!wire.contains("FAKE2855"), "{wire}");
            assert!(!wire.contains("ada@example.com"), "{wire}");
            assert!(
                !wire.contains(&dir.0.display().to_string()),
                "full path in {wire}"
            );

            assert_eq!(
                results[0],
                GitReadResult::Ok(GitValue::Repo {
                    name: "repo".into()
                })
            );
            assert_eq!(
                results[1],
                GitReadResult::Ok(GitValue::Branch {
                    name: Some("main".into())
                })
            );
            let GitReadResult::Ok(GitValue::Worktrees { worktrees }) = &results[2] else {
                panic!("{:?}", results[2]);
            };
            assert_eq!(
                worktrees
                    .iter()
                    .map(|w| (w.folder.as_str(), w.branch.as_deref()))
                    .collect::<Vec<_>>(),
                [("repo", Some("main")), ("side", Some("side"))]
            );
            assert_eq!(
                results[3],
                GitReadResult::Ok(GitValue::AheadBehind {
                    behind: 0,
                    ahead: 1
                })
            );
            let GitReadResult::Ok(GitValue::Commits { commits }) = &results[4] else {
                panic!("{:?}", results[4]);
            };
            assert_eq!(commits.len(), 1);
            assert_eq!(commits[0].co_authors, ["Ada Lovelace"]);
            let GitReadResult::Ok(GitValue::Diff { totals, .. }) = &results[5] else {
                panic!("{:?}", results[5]);
            };
            assert_eq!((totals.files, totals.added), (1, 1));
            let GitReadResult::Ok(GitValue::Diff { totals, .. }) = &results[6] else {
                panic!("{:?}", results[6]);
            };
            assert_eq!((totals.files, totals.added), (1, 1));
            assert_eq!(
                results[7],
                GitReadResult::Ok(GitValue::Status {
                    modified: 1,
                    added: 0,
                    deleted: 0,
                    untracked: 1
                })
            );

            // Control: the same config does run the programs when git is
            // called without the prefix — so the empty marker folder above
            // means the prefix held, not that the traps were broken.
            let bare = clean(Command::new(&git))
                .args(["status", "--porcelain=v1"])
                .stdin(Stdio::null())
                .current_dir(&repo)
                .env("GIT_PAGER", "cat")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = bare;
            let bare_diff = clean(Command::new(&git))
                .args(["diff", "HEAD"])
                .stdin(Stdio::null())
                .current_dir(&repo)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = bare_diff;
            let fired: Vec<String> = std::fs::read_dir(&marks)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert!(fired.iter().any(|f| f == "fsmonitor"), "{fired:?}");
            // The driver's own command outranks `diff.external`.
            assert!(fired.iter().any(|f| f == "diff-command"), "{fired:?}");
        }

        /// Known gap (reported on #2855, not closed by ADR-0190 D3-c): a
        /// clean filter the repository's own config and attributes name
        /// still runs on G6/G8 when a worktree file is stat-dirty. This test
        /// pins today's behaviour so whoever closes the gap has to touch it
        /// and the ADR together.
        #[test]
        fn a_clean_filter_still_runs_known_gap() {
            let Some(git) = real_git() else {
                eprintln!("skip: no working git on this machine");
                return;
            };
            let dir = Scratch::new("filter");
            let repo = dir.0.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            let mark = dir.0.join("clean-ran");
            let g = git.display();
            sh(
                &repo,
                &format!(
                    "'{g}' init -q -b main . && '{g}' config user.email t@example.com && \
                     '{g}' config user.name t && printf 'a.txt filter=pwn\\n' > .gitattributes && \
                     printf 'one\\n' > a.txt && '{g}' add . && '{g}' commit -q -m base && \
                     '{g}' config filter.pwn.clean 'touch {m}; cat' && \
                     printf 'two\\n' >> a.txt && touch -t 200001010000 a.txt",
                    m = mark.display()
                ),
            );
            let _ = read(&git, &repo, GitRead::G6, T);
            assert!(
                mark.exists(),
                "the clean filter no longer runs: update ADR-0190 D3-c and this test"
            );
        }
    }
}
