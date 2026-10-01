// Where a new session starts (ADR-0190 D3-c 증보 2026-10-01, #2775).
//
// The new-session menu offers 「최근 프로젝트」, 「폴더 고르기…」 and 「홈에서
// 시작」, and an opt-in 「새 worktree에서 격리」. Three commands serve it:
//
//   workbench_folder_pick       -> FolderFacts | null   (native folder dialog)
//   workbench_folder_inspect    { path } -> FolderFacts (is it still a folder, a repo?)
//   workbench_worktree_create   { path } -> WorktreeMade (the one git WRITE)
//
// The boundary (every point is pinned by a test below or in `shell_contract.rs`):
//
// 1. **One folder rule.** `check_folder` is the only validator: absolute, no
//    `..` component, exists, is a directory, is readable, and — after
//    canonicalization — is inside the user's home. `pty.rs` calls the same
//    function for `pty_spawn`'s `cwd`, so the picker, the recents list and the
//    PTY cannot disagree. The webview stores the canonical path this module
//    returns, not what it sent.
// 2. **The native dialog is opened here.** The webview gets no `dialog:*`
//    permission (no capability grants one): it cannot ask the plugin to open
//    or save anything, only to call `workbench_folder_pick`, which opens a
//    folder-only picker starting in home and returns the checked folder.
// 3. **One git write, user-initiated.** `workbench_worktree_create` runs
//    `git worktree add -b <branch> <dir> HEAD` and nothing else that writes:
//    no `fetch`, `checkout`, `commit`, `reset`, `gc`, `branch -D`, no remote.
//    The page names a folder; the branch and the directory are generated
//    HERE (`oort/wt-<8 hex>` under `~/.oort/worktrees/<repo>/wt-<8 hex>`,
//    always inside home and never in the user's repository or its parent).
//    The program is the absolute `git` found on the app's search PATH, run
//    with an argv array (never `sh -c`), every inherited `GIT_*` removed,
//    hooks off (`core.hooksPath=/dev/null`), fsmonitor off, no prompt, its own
//    process group and a time limit. A repository whose configured clean /
//    smudge / process filter is not git-lfs's is refused: a checkout would
//    run that program (same rule as the reads, `FILTER_ALLOWED`).
// 4. **Fields only.** The reads here (`rev-parse`) return a state and a name,
//    never stdout or stderr; a failed `worktree add` answers a short code.
// 5. **No network, no event, no server.** Nothing here emits, listens or
//    talks to a socket; nothing from the server or a deep link reaches it.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::harness_path;

/// Where worktrees live, under home: `<home>/.oort/worktrees/<repo>/<leaf>`.
pub const MANAGED_SEGMENTS: &[&str] = &[".oort", "worktrees"];

/// Branch prefix of a generated worktree branch.
pub const BRANCH_PREFIX: &str = "oort/";

const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// A checkout of a large repository is the slow case.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STDOUT: usize = 64 * 1024;
const MAX_NAME_CHARS: usize = 60;

/// Prefix of every git command here, before its own arguments.
pub const GIT_PREFIX: &[&str] = &[
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=false",
];

pub const GIT_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_PAGER", "cat"),
    ("GIT_NO_LAZY_FETCH", "1"),
];

/// Same list and same verbatim values as the reads' `FILTER_ALLOWED`.
const FILTER_CHECK_ARGS: &[&str] = &[
    "config",
    "--get-regexp",
    r"^filter\..*\.(clean|smudge|process)$",
];
const FILTER_ALLOWED: &[(&str, &str)] = &[
    ("filter.lfs.clean", "git-lfs clean -- %f"),
    ("filter.lfs.smudge", "git-lfs smudge -- %f"),
    ("filter.lfs.process", "git-lfs filter-process"),
];

/// Whether a folder can host a worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoState {
    /// Not inside a git repository.
    None,
    /// A repository without a commit: `worktree add` needs one.
    Empty,
    /// A repository with a commit.
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFacts {
    /// Canonical absolute path.
    pub path: String,
    /// Last path element, for the menu.
    pub name: String,
    pub repo: RepoState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMade {
    /// Canonical absolute path of the new worktree.
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderRequest {
    pub path: String,
}

// ---------------------------------------------------------------------------
// The folder rule
// ---------------------------------------------------------------------------

/// The single folder validator (see the module header, point 1).
pub fn check_folder(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("refused: folder must be an absolute path".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("refused: folder path must not contain '..'".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "refused: folder does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("refused: folder is not a directory".into());
    }
    if !canonical.starts_with(home) {
        return Err("refused: folder is outside the home directory".into());
    }
    if std::fs::read_dir(&canonical).is_err() {
        return Err("refused: folder is not readable".into());
    }
    Ok(canonical)
}

fn current_home() -> Result<PathBuf, String> {
    crate::harness_profile::current_home()
}

fn display_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    cap(&name, MAX_NAME_CHARS)
}

fn cap(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// A repository's name as one safe path segment.
pub fn safe_segment(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "repo".into()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

struct Ran {
    code: Option<i32>,
    stdout: Vec<u8>,
}

fn git_binary() -> Option<PathBuf> {
    static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    GIT.get_or_init(|| {
        let path: OsString = harness_path::current_search_path();
        harness_path::find_on_path("git", &path)
    })
    .clone()
}

/// The argv of the one write. Generated names only; the folder is where git
/// runs (`current_dir`), never an argument.
pub fn worktree_add_args(branch: &str, dir: &Path) -> Vec<OsString> {
    vec![
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.into(),
        dir.as_os_str().to_os_string(),
        "HEAD".into(),
    ]
}

fn run_start_git(git: &Path, folder: &Path, args: &[OsString], timeout: Duration) -> Option<Ran> {
    if !git.is_absolute() || !folder.is_dir() {
        return None;
    }
    let mut cmd = Command::new(git);
    cmd.args(GIT_PREFIX)
        .args(args)
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_none_or(|k| k.starts_with("GIT_")) {
            cmd.env_remove(&key);
        }
    }
    for key in harness_path::STRIPPED_ENV {
        cmd.env_remove(key);
    }
    for (key, value) in GIT_ENV {
        cmd.env(key, value);
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() + n <= MAX_STDOUT {
                        buf.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        let _ = tx.send(buf);
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => break None,
        }
    };
    let Some(status) = status else {
        kill_group(&mut child);
        let _ = child.wait();
        return None;
    };
    let stdout = rx
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_default();
    Some(Ran {
        code: status.code(),
        stdout,
    })
}

fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(child.id()) {
        if pid > 0 {
            // SAFETY: plain syscall on a pid this process spawned.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

/// The repository's top-level folder, or `None` outside one.
fn toplevel(git: &Path, folder: &Path) -> Option<PathBuf> {
    let ran = run_start_git(
        git,
        folder,
        &args(&["rev-parse", "--show-toplevel"]),
        READ_TIMEOUT,
    )?;
    if ran.code != Some(0) {
        return None;
    }
    let text = std::str::from_utf8(&ran.stdout).ok()?;
    let line = text.lines().next()?.trim_end();
    if line.is_empty() {
        return None;
    }
    PathBuf::from(line).canonicalize().ok()
}

fn repo_state(git: &Path, folder: &Path) -> RepoState {
    if toplevel(git, folder).is_none() {
        return RepoState::None;
    }
    let has_commit = run_start_git(
        git,
        folder,
        &args(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
        READ_TIMEOUT,
    )
    .is_some_and(|ran| ran.code == Some(0));
    if has_commit {
        RepoState::Ready
    } else {
        RepoState::Empty
    }
}

fn filters_allowed(git: &Path, folder: &Path) -> bool {
    let Some(ran) = run_start_git(git, folder, &args(FILTER_CHECK_ARGS), READ_TIMEOUT) else {
        return false;
    };
    match ran.code {
        Some(1) if ran.stdout.is_empty() => true,
        Some(0) => configured_filters_allowed(&ran.stdout),
        _ => false,
    }
}

pub fn configured_filters_allowed(out: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(out) else {
        return false;
    };
    text.split('\n')
        .filter(|line| !line.is_empty())
        .all(|line| {
            line.split_once(' ')
                .is_some_and(|(key, value)| FILTER_ALLOWED.contains(&(key, value)))
        })
}

// ---------------------------------------------------------------------------
// The commands' bodies (home and git are parameters so tests use a temp home)
// ---------------------------------------------------------------------------

pub fn inspect_in(git: Option<&Path>, raw: &str, home: &Path) -> Result<FolderFacts, String> {
    let path = check_folder(raw, home)?;
    let repo = match git {
        Some(git) if path != home => repo_state(git, &path),
        _ => RepoState::None,
    };
    Ok(FolderFacts {
        name: display_name(&path),
        path: path.to_string_lossy().into_owned(),
        repo,
    })
}

/// A new generated leaf: `wt-<8 hex>`.
fn new_leaf() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("wt-{}", &id[..8])
}

pub fn create_worktree_in(
    git: Option<&Path>,
    raw: &str,
    home: &Path,
    leaf: &str,
) -> Result<WorktreeMade, String> {
    let folder = check_folder(raw, home)?;
    let git = git.ok_or_else(|| "worktree_failed: git not found".to_string())?;
    if folder == home {
        return Err("worktree_failed: not a repository".into());
    }
    let top =
        toplevel(git, &folder).ok_or_else(|| "worktree_failed: not a repository".to_string())?;
    if repo_state(git, &folder) != RepoState::Ready {
        return Err("worktree_failed: no commit yet".into());
    }
    if !filters_allowed(git, &top) {
        return Err("worktree_failed: unsupported filter".into());
    }
    let repo_name = safe_segment(&display_name(&top));
    let parent = MANAGED_SEGMENTS
        .iter()
        .fold(home.to_path_buf(), |p, s| p.join(s))
        .join(&repo_name);
    std::fs::create_dir_all(&parent)
        .map_err(|_| "worktree_failed: cannot create folder".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|_| "worktree_failed: cannot create folder".to_string())?;
    if !parent.starts_with(home) {
        return Err("worktree_failed: managed folder is outside home".into());
    }
    let dir = parent.join(leaf);
    if dir.exists() {
        return Err("worktree_failed: folder exists".into());
    }
    let branch = format!("{BRANCH_PREFIX}{leaf}");
    let ran = run_start_git(git, &top, &worktree_add_args(&branch, &dir), WRITE_TIMEOUT)
        .ok_or_else(|| "worktree_failed: timed out".to_string())?;
    if ran.code != Some(0) {
        return Err("worktree_failed: git refused".into());
    }
    let made = check_folder(&dir.to_string_lossy(), home)
        .map_err(|_| "worktree_failed: folder missing after add".to_string())?;
    Ok(WorktreeMade {
        path: made.to_string_lossy().into_owned(),
        branch,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Folder-only native picker starting in home. `None` = the user cancelled.
#[tauri::command]
pub async fn workbench_folder_pick(app: tauri::AppHandle) -> Result<Option<FolderFacts>, String> {
    use tauri_plugin_dialog::DialogExt;
    let home = current_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_directory(&home)
            .blocking_pick_folder();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|_| "refused: folder must be an absolute path".to_string())?;
        inspect_in(git_binary().as_deref(), &path.to_string_lossy(), &home).map(Some)
    })
    .await
    .map_err(|_| "refused: picker failed".to_string())?
}

/// Re-check a remembered folder (recents, last used): does it still exist,
/// is it a repository. Refuses with the folder rule's message.
#[tauri::command]
pub async fn workbench_folder_inspect(request: FolderRequest) -> Result<FolderFacts, String> {
    let home = current_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        inspect_in(git_binary().as_deref(), &request.path, &home)
    })
    .await
    .map_err(|_| "refused: inspect failed".to_string())?
}

/// The one git write: a new worktree of the repository containing `path`.
#[tauri::command]
pub async fn workbench_worktree_create(request: FolderRequest) -> Result<WorktreeMade, String> {
    let home = current_home()?;
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_in(git_binary().as_deref(), &request.path, &home, &new_leaf())
    })
    .await
    .map_err(|_| "worktree_failed: task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A fresh temp "home" (canonical) the test owns. Never the user's.
    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oort-2775-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn git() -> PathBuf {
        git_binary().expect("git on PATH for tests")
    }

    /// `git init` + one commit in `dir`, with identity and hooks isolated.
    fn init_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        let run = |a: &[&str]| {
            let status = Command::new(git())
                .args(a)
                .current_dir(dir)
                .env_clear()
                .env("HOME", dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {a:?}");
        };
        run(&["init", "-q"]);
        run(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
    }

    #[test]
    fn the_folder_rule_refuses_relative_traversal_missing_file_and_outside_home() {
        let home = temp_home("rule");
        let file = home.join("a-file");
        fs::write(&file, b"x").unwrap();
        let inside = home.to_string_lossy().into_owned();
        let traversal = format!("{inside}/sub/../sub");
        let missing = format!("{inside}/does-not-exist");
        let outside = std::env::temp_dir()
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        fs::create_dir_all(home.join("sub")).unwrap();
        for (raw, needle) in [
            ("relative/dir", "absolute"),
            ("", "absolute"),
            (traversal.as_str(), "'..'"),
            (missing.as_str(), "does not exist"),
            (file.to_str().unwrap(), "not a directory"),
            ("/", "outside the home"),
            (outside.as_str(), "outside the home"),
        ] {
            let err = check_folder(raw, &home).unwrap_err();
            assert!(err.starts_with("refused"), "{raw}: {err}");
            assert!(err.contains(needle), "{raw}: {err}");
        }
        assert_eq!(check_folder(&inside, &home).unwrap(), home);
        assert_eq!(
            check_folder(&format!("{inside}/sub"), &home).unwrap(),
            home.join("sub")
        );
        fs::remove_dir_all(&home).unwrap();
    }

    /// A symlink inside home that points outside it is judged by where it
    /// lands, not by how it is spelled.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_home_is_outside_home() {
        let home = temp_home("link");
        let elsewhere = temp_home("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, home.join("link")).unwrap();
        let err = check_folder(home.join("link").to_str().unwrap(), &home).unwrap_err();
        assert!(err.contains("outside the home"), "{err}");
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("unreadable");
        let dir = home.join("locked");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        // root reads anything; the check is meaningless there.
        let readable = fs::read_dir(&dir).is_ok();
        let result = check_folder(dir.to_str().unwrap(), &home);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        if !readable {
            let err = result.unwrap_err();
            assert!(err.contains("not readable"), "{err}");
        }
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_worktree_argv_is_a_fixed_shape_with_generated_names() {
        let argv = worktree_add_args(
            "oort/wt-ab12cd34",
            Path::new("/h/.oort/worktrees/r/wt-ab12cd34"),
        );
        let text: Vec<String> = argv
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            text,
            [
                "worktree",
                "add",
                "-b",
                "oort/wt-ab12cd34",
                "/h/.oort/worktrees/r/wt-ab12cd34",
                "HEAD"
            ]
        );
        // The prefix turns hooks and fsmonitor off before any argument.
        assert!(GIT_PREFIX
            .windows(2)
            .any(|w| w == ["-c", "core.hooksPath=/dev/null"]));
        assert!(GIT_PREFIX
            .windows(2)
            .any(|w| w == ["-c", "core.fsmonitor=false"]));
        // A branch can never look like an option or climb out.
        let leaf = new_leaf();
        assert!(leaf.starts_with("wt-") && leaf.len() == 11, "{leaf}");
        assert!(!leaf.contains('/') && !leaf.starts_with('-'));
    }

    #[test]
    fn segments_are_one_safe_path_element() {
        assert_eq!(safe_segment("my repo/../x"), "my_repo_.._x");
        assert_eq!(safe_segment(".."), "repo");
        assert_eq!(safe_segment(""), "repo");
        assert_eq!(safe_segment("oort"), "oort");
        assert!(!safe_segment("a/b").contains('/'));
    }

    #[test]
    fn a_folder_is_none_empty_or_ready() {
        let home = temp_home("state");
        let plain = home.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let empty = home.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let init = Command::new(git())
            .args(["init", "-q"])
            .current_dir(&empty)
            .env("HOME", &home)
            .status()
            .unwrap();
        assert!(init.success());
        let ready = home.join("ready");
        init_repo(&ready);
        let sub = ready.join("src");
        fs::create_dir_all(&sub).unwrap();
        let g = git();
        let state = |p: &Path| inspect_in(Some(&g), p.to_str().unwrap(), &home).unwrap();
        assert_eq!(state(&plain).repo, RepoState::None);
        assert_eq!(state(&empty).repo, RepoState::Empty);
        assert_eq!(state(&ready).repo, RepoState::Ready);
        assert_eq!(state(&sub).repo, RepoState::Ready);
        // Home itself is never offered a worktree, whatever is in it.
        assert_eq!(state(&home).repo, RepoState::None);
        assert_eq!(state(&ready).name, "ready");
        // No git on the machine reads as "not a repository".
        assert_eq!(
            inspect_in(None, ready.to_str().unwrap(), &home)
                .unwrap()
                .repo,
            RepoState::None
        );
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_worktree_is_made_under_the_managed_folder_on_a_generated_branch() {
        let home = temp_home("add");
        let repo = home.join("proj");
        init_repo(&repo);
        let g = git();
        let made =
            create_worktree_in(Some(&g), repo.to_str().unwrap(), &home, "wt-test0001").unwrap();
        let managed = home
            .join(".oort")
            .join("worktrees")
            .join("proj")
            .join("wt-test0001");
        assert_eq!(PathBuf::from(&made.path), managed.canonicalize().unwrap());
        assert_eq!(made.branch, "oort/wt-test0001");
        // It is a real worktree, on the new branch, and the folder rule accepts it.
        assert!(managed.join(".git").exists());
        let head = Command::new(&g)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&managed)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "oort/wt-test0001"
        );
        assert!(check_folder(&made.path, &home).is_ok());
        // From inside the new worktree a second one still lands under the managed root.
        let again = create_worktree_in(Some(&g), &made.path, &home, "wt-test0002").unwrap();
        assert!(Path::new(&again.path).starts_with(home.join(".oort")));
        // The same leaf twice is refused, never overwritten.
        let err =
            create_worktree_in(Some(&g), repo.to_str().unwrap(), &home, "wt-test0001").unwrap_err();
        assert!(err.starts_with("worktree_failed"), "{err}");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_worktree_is_refused_outside_a_repository_with_a_commit() {
        let home = temp_home("refuse");
        let plain = home.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let empty = home.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(Command::new(git())
            .args(["init", "-q"])
            .current_dir(&empty)
            .env("HOME", &home)
            .status()
            .unwrap()
            .success());
        let g = git();
        for folder in [&plain, &empty, &home] {
            let err =
                create_worktree_in(Some(&g), folder.to_str().unwrap(), &home, "wt-x").unwrap_err();
            assert!(err.starts_with("worktree_failed"), "{folder:?}: {err}");
        }
        // No managed folder was created for a refused request.
        assert!(!home.join(".oort").exists());
        // Outside home is refused by the folder rule before git runs.
        let err = create_worktree_in(Some(&g), "/", &home, "wt-x").unwrap_err();
        assert!(err.starts_with("refused"), "{err}");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn a_repository_filter_other_than_lfs_is_refused() {
        assert!(configured_filters_allowed(b""));
        assert!(configured_filters_allowed(
            b"filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.smudge git-lfs smudge -- %f\n"
        ));
        assert!(!configured_filters_allowed(
            b"filter.x.smudge touch /tmp/pwned\n"
        ));
        assert!(!configured_filters_allowed(
            b"filter.lfs.smudge git-lfs smudge -- %f; id\n"
        ));
        let home = temp_home("filter");
        let repo = home.join("proj");
        init_repo(&repo);
        let set = Command::new(git())
            .args(["config", "filter.evil.smudge", "touch evil-ran"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(set.success());
        let err =
            create_worktree_in(Some(&git()), repo.to_str().unwrap(), &home, "wt-f").unwrap_err();
        assert_eq!(err, "worktree_failed: unsupported filter");
        assert!(!home.join(".oort").exists() || !home.join(".oort/worktrees/proj/wt-f").exists());
        fs::remove_dir_all(&home).unwrap();
    }

    /// A repository hook does not run on `worktree add` (hooks are off).
    #[test]
    fn repository_hooks_do_not_run() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("hook");
        let repo = home.join("proj");
        init_repo(&repo);
        let hook = repo.join(".git/hooks/post-checkout");
        let marker = home.join("hook-ran");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        create_worktree_in(Some(&git()), repo.to_str().unwrap(), &home, "wt-hook").unwrap();
        assert!(!marker.exists(), "post-checkout hook ran");
        fs::remove_dir_all(&home).unwrap();
    }
}
