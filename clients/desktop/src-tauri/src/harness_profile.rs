// Harness account profiles on this Mac (ADR-0191 D1, ADR-0190 D3-f, #2878).
//
// A profile is one folder per (harness, label) under
// `~/Library/Application Support/oort/profiles/<harness>/<label>/`. The
// official CLI keeps its own sign-in for that folder: Claude Code through
// `CLAUDE_CONFIG_DIR`, Codex through `CODEX_HOME`. This module decides the
// folder and nothing else about the account:
//
// - **The webview names a harness and a label, never a path.** `profile_dir`
//   is the one mapping from those two to a folder. The sign-in PTY, the
//   sign-out PTY, the status probe and the removal all call it, so the
//   variable a CLI gets at sign-in is byte-for-byte the one it gets at
//   sign-out. (Claude Code names its keychain item after a hash of that exact
//   string; a trailing slash or a resolved symlink would point sign-out at a
//   different item — measured for #2878, see the PR.)
// - **Sign-out is the official CLI's.** `LOGOUT_COMMANDS` is the whole list
//   (ADR-0190 D3-f A2·A5). It runs in the same hidden PTY as the sign-in and
//   only ever with a profile folder: this Mac's default sign-in (the CLI's own
//   folder in the home directory) has no sign-out here. That one is only taken
//   off the list, by the page.
// - **Removal is guarded here, not in the page.** `remove_profile` deletes a
//   folder only if every step from the `oort` folder down is a real directory
//   (no symlink anywhere), the resolved folder is under the profile root and
//   is not one of the CLIs' default folders, and the official status command
//   run against that folder answers "not signed in". A folder that is still
//   signed in, or whose state is unknown, stays.
// - **Nothing here opens a file inside a profile.** Listing reads folder
//   names; removal deletes a folder the CLI has already signed out of. The
//   CLI's credential store is the CLI's (ADR-0191 D2).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::harness_status;
use crate::profile_signout::{self, SignOut};

/// Harnesses that take a profile folder, and the variable that points the
/// official CLI at it (ADR-0191 D1). Grok has no profile yet (Q7).
pub const PROFILE_HARNESSES: &[ProfileHarness] = &[
    ProfileHarness {
        id: "claude",
        env: "CLAUDE_CONFIG_DIR",
    },
    ProfileHarness {
        id: "codex",
        env: "CODEX_HOME",
    },
];

#[derive(Debug, PartialEq, Eq)]
pub struct ProfileHarness {
    pub id: &'static str,
    pub env: &'static str,
}

/// One allowlisted sign-out: harness id and fixed arguments.
#[derive(Debug, PartialEq, Eq)]
pub struct LogoutCommand {
    pub id: &'static str,
    pub args: &'static [&'static str],
}

/// The complete sign-out allowlist (ADR-0190 D3-f rows A2, A5; checked
/// against `claude` 2.1.283 and `codex-cli` 0.156.1 `--help`). Kept apart
/// from the sign-in list (D3-g): a row moving between them fails a test.
pub const LOGOUT_COMMANDS: &[LogoutCommand] = &[
    LogoutCommand {
        id: "claude",
        args: &["auth", "logout"],
    },
    LogoutCommand {
        id: "codex",
        args: &["logout"],
    },
];

/// Below the home directory, in order. The last one is the profile root.
const ROOT_SEGMENTS: &[&str] = &["Library", "Application Support", "oort", "profiles"];
/// How many of `ROOT_SEGMENTS` belong to the system (not checked for
/// symlinks: a user may have moved `Library`). From `oort` down, every step is
/// ours and must be a real directory.
const SYSTEM_SEGMENTS: usize = 2;
/// A CLI's own default folder in the home directory. A profile never resolves
/// to one of these (checked on disk, not by name only).
const DEFAULT_FOLDERS: &[&str] = &[".claude", ".codex"];

pub const MAX_LABEL_CHARS: usize = 32;

/// What the webview sends: a harness id and a label. No path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileRef {
    pub harness: String,
    pub label: String,
}

/// The canonical home directory, as every caller here and the PTY's
/// `HostFacts::current` compute it. One definition so the profile folder
/// string never differs between sign-in and sign-out.
pub fn current_home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "refused: HOME unset".to_string())?
        .canonicalize()
        .map_err(|e| format!("refused: home: {e}"))
}

pub fn profile_root(home: &Path) -> PathBuf {
    ROOT_SEGMENTS
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment))
}

pub fn harness_env(harness: &str) -> Result<&'static str, String> {
    PROFILE_HARNESSES
        .iter()
        .find(|row| row.id == harness)
        .map(|row| row.env)
        .ok_or_else(|| format!("refused: {harness:?} has no profiles"))
}

/// A label is one folder name the person chose: 1..=32 characters, no
/// separator, no control character, not hidden, not `.`/`..`, no edge spaces.
pub fn check_label(label: &str) -> Result<(), String> {
    let count = label.chars().count();
    if count == 0 || count > MAX_LABEL_CHARS {
        return Err(format!(
            "refused: label must be 1..={MAX_LABEL_CHARS} characters"
        ));
    }
    if label.trim() != label {
        return Err("refused: label has leading or trailing space".into());
    }
    if label.starts_with('.') {
        return Err("refused: label starts with a dot".into());
    }
    if label
        .chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control() || is_invisible(c))
    {
        return Err("refused: label has a separator, control or invisible character".into());
    }
    Ok(())
}

/// Format characters that draw nothing or reorder text (Unicode Cf, the ones a
/// label could carry): two labels that look the same must not be two folders
/// (#2878 security review L-4).
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            // Hangul fillers that render as nothing (#2996 re-review N-1).
            | '\u{115F}'
            | '\u{1160}'
            | '\u{3164}'
            | '\u{FFA0}'
            // Line/paragraph separators and non-ASCII spaces: 「a b」 and
            // 「a\u{00A0}b」 must not become two folders.
            | '\u{2028}'
            | '\u{2029}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

/// The one mapping (harness, label) → folder, and the variable to set. Pure:
/// it does not look at the disk. `check_on_disk` does.
pub fn profile_dir(
    home: &Path,
    harness: &str,
    label: &str,
) -> Result<(PathBuf, &'static str), String> {
    let env = harness_env(harness)?;
    check_label(label)?;
    Ok((profile_root(home).join(harness).join(label), env))
}

/// The folder as it is on disk: every step from `oort` down is a real
/// directory (a symlink anywhere is refused, not followed), it resolves under
/// the profile root, and it is not (and does not contain, and is not inside)
/// the home directory or a CLI's default folder.
pub fn check_on_disk(home: &Path, dir: &Path) -> Result<(), String> {
    let root = profile_root(home);
    let relative = dir
        .strip_prefix(&root)
        .map_err(|_| "refused: not under the profile root".to_string())?;
    if relative.components().count() != 2 {
        return Err("refused: not a profile folder".into());
    }
    let mut step = ROOT_SEGMENTS[..SYSTEM_SEGMENTS]
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment));
    let ours = ROOT_SEGMENTS[SYSTEM_SEGMENTS..]
        .iter()
        .map(Path::new)
        .chain(relative.components().map(|c| Path::new(c.as_os_str())));
    for segment in ours {
        step = step.join(segment);
        let meta = std::fs::symlink_metadata(&step)
            .map_err(|_| "refused: profile folder does not exist".to_string())?;
        if meta.file_type().is_symlink() {
            return Err("refused: a step of the profile folder is a symlink".into());
        }
        if !meta.is_dir() {
            return Err("refused: a step of the profile folder is not a directory".into());
        }
    }
    // The folder's own name on disk must be byte-for-byte the requested one.
    // APFS matches names case- and normalization-insensitively, so `WORK`
    // reaches the folder `Work` — but the CLI would get the string `.../WORK`
    // and hash it to a different keychain item (#2878 security review M-1).
    let (parent, name) = (
        dir.parent()
            .ok_or_else(|| "refused: not a profile folder".to_string())?,
        dir.file_name()
            .ok_or_else(|| "refused: not a profile folder".to_string())?,
    );
    let exact = std::fs::read_dir(parent)
        .map_err(|_| "refused: profile folder does not exist".to_string())?
        .filter_map(Result::ok)
        .any(|entry| entry.file_name() == name);
    if !exact {
        return Err("refused: the profile folder's name on disk differs from the label".into());
    }
    let canonical = dir
        .canonicalize()
        .map_err(|_| "refused: profile folder does not resolve".to_string())?;
    check_resolved(home, &root, &canonical)
}

/// The resolved folder (symlinks, firmlinks and all followed by the OS) is
/// strictly under the resolved profile root, and is not — does not contain,
/// is not inside — a CLI's default folder. Behind the
/// no-symlink walk this only fires for links the walk cannot see (a firmlink
/// or bind mount), so its tests drive it directly with such a resolved path.
fn check_resolved(home: &Path, root: &Path, canonical: &Path) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "refused: profile root does not resolve".to_string())?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err("refused: profile folder resolves outside the profile root".into());
    }
    let home = home
        .canonicalize()
        .map_err(|_| "refused: home does not resolve".to_string())?;
    // No separate "is the home directory" check: the root lives inside home,
    // so a folder strictly under the resolved root can neither be home nor
    // contain it (a guard that could never fail was removed, #2878 review L-1).
    for name in DEFAULT_FOLDERS {
        if let Ok(default) = home.join(name).canonicalize() {
            if canonical == default
                || canonical.starts_with(&default)
                || default.starts_with(canonical)
            {
                return Err("refused: that is a CLI's default folder".into());
            }
        }
    }
    Ok(())
}

/// A checked, existing profile folder and its variable: what the sign-in and
/// sign-out PTYs and the status probe run with.
pub fn existing_profile(
    home: &Path,
    harness: &str,
    label: &str,
) -> Result<(PathBuf, &'static str), String> {
    let (dir, env) = profile_dir(home, harness, label)?;
    check_on_disk(home, &dir)?;
    Ok((dir, env))
}

/// Make a new, empty profile folder (0700). An existing label is refused:
/// adding an account never reuses someone's folder.
pub fn create_profile(home: &Path, harness: &str, label: &str) -> Result<(), String> {
    let (dir, _) = profile_dir(home, harness, label)?;
    let parent = dir.parent().expect("profile folder has a parent");
    // The system part (`Library/Application Support`) may be made as a whole;
    // from `oort` down each step is made one at a time and checked before the
    // next, so nothing is ever created through a symlink (#2878 review L-2).
    let system = ROOT_SEGMENTS[..SYSTEM_SEGMENTS]
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment));
    create_private_dir_all(&system)?;
    let tail = parent
        .strip_prefix(&system)
        .map_err(|_| "refused: not under the profile root".to_string())?;
    let mut step = system;
    for segment in tail.components() {
        step = step.join(segment.as_os_str());
        match std::fs::symlink_metadata(&step) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_private_dir(&step)?,
            Err(e) => return Err(format!("refused: {e}")),
            Ok(_) => {}
        }
        let meta = std::fs::symlink_metadata(&step).map_err(|e| format!("refused: {e}"))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("refused: a step of the profile root is not a real directory".into());
        }
    }
    check_steps_above(home, parent)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(_) => return Err("refused: that label already exists".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("refused: {e}")),
    }
    create_private_dir(&dir)?;
    check_on_disk(home, &dir)
}

fn check_steps_above(home: &Path, parent: &Path) -> Result<(), String> {
    let mut step = ROOT_SEGMENTS[..SYSTEM_SEGMENTS]
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment));
    let root = profile_root(home);
    let tail = parent
        .strip_prefix(&root)
        .map_err(|_| "refused: not under the profile root".to_string())?;
    for segment in ROOT_SEGMENTS[SYSTEM_SEGMENTS..]
        .iter()
        .map(Path::new)
        .chain(tail.components().map(|c| Path::new(c.as_os_str())))
    {
        step = step.join(segment);
        let meta = std::fs::symlink_metadata(&step)
            .map_err(|_| "refused: profile root does not exist".to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("refused: a step of the profile root is not a real directory".into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("refused: {e}"))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir(dir).map_err(|e| format!("refused: {e}"))
}

#[cfg(unix)]
fn create_private_dir_all(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("refused: {e}"))
}

#[cfg(not(unix))]
fn create_private_dir_all(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("refused: {e}"))
}

/// Every profile folder on this Mac: names only, real directories only, valid
/// labels only, sorted. Nothing inside a folder is opened.
pub fn list_profiles(home: &Path) -> Vec<ProfileRef> {
    let root = profile_root(home);
    let mut out = Vec::new();
    for harness in PROFILE_HARNESSES {
        let Ok(entries) = std::fs::read_dir(root.join(harness.id)) else {
            continue;
        };
        let mut labels: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            })
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|label| check_label(label).is_ok())
            .collect();
        labels.sort();
        out.extend(labels.into_iter().map(|label| ProfileRef {
            harness: harness.id.to_string(),
            label,
        }));
    }
    out
}

/// How the removal ended. The page words each one; the folder stays for every
/// value but `Removed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveOutcome {
    Removed,
    /// The official status command still says signed in.
    StillSignedIn,
    /// The status command did not answer (not installed, timed out, killed).
    Unknown,
}

/// Delete a profile folder the official CLI has signed out of. `check` is
/// the structured sign-out check (`profile_signout`, D3-d) run with the
/// folder's variable (injected by tests). Only an explicit "signed out" in
/// the CLI's own structured output deletes: an exit code cannot tell a crash
/// from a sign-out, both CLIs end either with 1 (PR #2996 re-review M-1).
pub fn remove_profile(
    home: &Path,
    harness: &str,
    label: &str,
    check: impl FnOnce(&str, &str, &Path) -> SignOut,
) -> Result<RemoveOutcome, String> {
    let (dir, env) = existing_profile(home, harness, label)?;
    match check(harness, env, &dir) {
        SignOut::SignedOut => {}
        SignOut::SignedIn => return Ok(RemoveOutcome::StillSignedIn),
        SignOut::Unknown => return Ok(RemoveOutcome::Unknown),
    }
    // Re-check right before deleting: the status command ran for seconds.
    check_on_disk(home, &dir)?;
    // `remove_dir_all` does not follow symlinks inside the folder, and the
    // folder itself was just checked to be a real directory.
    std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove: {e}"))?;
    Ok(RemoveOutcome::Removed)
}

// ---------------------------------------------------------------------------
// Commands. Main webview, bundled origin only (`capabilities/harness-profile.json`).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn harness_profile_list() -> Vec<ProfileRef> {
    tauri::async_runtime::spawn_blocking(|| current_home().map(|home| list_profiles(&home)))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn harness_profile_create(profile: ProfileRef) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_profile(&current_home()?, &profile.harness, &profile.label)
    })
    .await
    .map_err(|e| format!("create did not run: {e}"))?
}

/// The D3-a status command against one profile folder.
#[tauri::command]
pub async fn harness_profile_status(
    profile: ProfileRef,
) -> Result<harness_status::LocalHarnessProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = current_home()?;
        let (dir, env) = existing_profile(&home, &profile.harness, &profile.label)?;
        harness_status::probe_profile(&profile.harness, env, &dir, &home)
    })
    .await
    .map_err(|e| format!("status did not run: {e}"))?
}

#[tauri::command]
pub async fn harness_profile_remove(profile: ProfileRef) -> Result<RemoveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = current_home()?;
        remove_profile(
            &home,
            &profile.harness,
            &profile.label,
            |harness, env, dir| profile_signout::check_signed_out(harness, env, dir, &home),
        )
    })
    .await
    .map_err(|e| format!("remove did not run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A throwaway home: never the real one.
    struct Home(PathBuf);

    impl Home {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("oort-2878-{tag}-{}", std::process::id()))
                .canonicalize_or_create();
            Home(dir)
        }
        fn root(&self) -> PathBuf {
            profile_root(&self.0)
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    trait CanonicalizeOrCreate {
        fn canonicalize_or_create(self) -> PathBuf;
    }
    impl CanonicalizeOrCreate for PathBuf {
        fn canonicalize_or_create(self) -> PathBuf {
            let _ = std::fs::remove_dir_all(&self);
            std::fs::create_dir_all(&self).unwrap();
            self.canonicalize().unwrap()
        }
    }

    fn signed_out(_: &str, _: &str, _: &Path) -> SignOut {
        SignOut::SignedOut
    }

    #[test]
    fn the_lists_are_exact() {
        assert_eq!(
            LOGOUT_COMMANDS,
            &[
                LogoutCommand {
                    id: "claude",
                    args: &["auth", "logout"],
                },
                LogoutCommand {
                    id: "codex",
                    args: &["logout"],
                },
            ]
        );
        assert_eq!(
            PROFILE_HARNESSES,
            &[
                ProfileHarness {
                    id: "claude",
                    env: "CLAUDE_CONFIG_DIR",
                },
                ProfileHarness {
                    id: "codex",
                    env: "CODEX_HOME",
                },
            ]
        );
        // Kept apart from the sign-in list: see pty.rs
        // `the_sign_out_list_is_not_the_sign_in_list`.
    }

    #[test]
    fn a_label_is_one_plain_folder_name() {
        for ok in [
            "개인",
            "회사",
            "work-2",
            "Team (Max)",
            "가".repeat(32).as_str(),
        ] {
            assert!(check_label(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            ".",
            "..",
            ".hidden",
            "a/b",
            "../x",
            "/tmp/x",
            "a\\b",
            "a:b",
            " 개인",
            "개인 ",
            "a\nb",
            "a\0b",
            &"가".repeat(33),
        ] {
            assert!(check_label(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_folder_is_decided_here_from_harness_and_label() {
        let home = PathBuf::from("/Users/someone");
        let (dir, env) = profile_dir(&home, "claude", "회사").unwrap();
        assert_eq!(
            dir,
            PathBuf::from("/Users/someone/Library/Application Support/oort/profiles/claude/회사")
        );
        assert_eq!(env, "CLAUDE_CONFIG_DIR");
        let (_, env) = profile_dir(&home, "codex", "개인").unwrap();
        assert_eq!(env, "CODEX_HOME");
        // No trailing slash: the CLI hashes this exact string.
        assert!(!dir.to_string_lossy().ends_with('/'));
        for harness in ["grok", "../claude", "", "sh"] {
            assert!(profile_dir(&home, harness, "개인").is_err(), "{harness}");
        }
    }

    #[test]
    fn create_list_and_remove_a_signed_out_profile() {
        let home = Home::new("roundtrip");
        create_profile(&home.0, "claude", "회사").unwrap();
        create_profile(&home.0, "codex", "개인").unwrap();
        assert!(create_profile(&home.0, "claude", "회사")
            .unwrap_err()
            .contains("already exists"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.root().join("claude/회사"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert_eq!(
            list_profiles(&home.0),
            vec![
                ProfileRef {
                    harness: "claude".into(),
                    label: "회사".into()
                },
                ProfileRef {
                    harness: "codex".into(),
                    label: "개인".into()
                },
            ]
        );
        let dir = home.root().join("claude/회사");
        std::fs::write(dir.join("left-by-cli"), b"x").unwrap();
        assert_eq!(
            remove_profile(&home.0, "claude", "회사", signed_out).unwrap(),
            RemoveOutcome::Removed
        );
        assert!(!dir.exists());
    }

    #[test]
    fn a_folder_the_cli_still_signs_in_with_stays() {
        let home = Home::new("still");
        create_profile(&home.0, "claude", "개인").unwrap();
        let dir = home.root().join("claude/개인");
        assert_eq!(
            remove_profile(&home.0, "claude", "개인", |_, _, _| SignOut::SignedIn).unwrap(),
            RemoveOutcome::StillSignedIn
        );
        assert!(dir.is_dir());
        assert_eq!(
            remove_profile(&home.0, "claude", "개인", |_, _, _| SignOut::Unknown).unwrap(),
            RemoveOutcome::Unknown
        );
        assert!(dir.is_dir());
    }

    /// The status command gets the profile's own variable and folder.
    #[test]
    fn the_status_is_asked_about_this_folder() {
        let home = Home::new("asked");
        create_profile(&home.0, "codex", "회사").unwrap();
        let mut seen = None;
        remove_profile(&home.0, "codex", "회사", |harness, env, dir| {
            seen = Some((harness.to_string(), env.to_string(), dir.to_path_buf()));
            SignOut::SignedIn
        })
        .unwrap();
        assert_eq!(
            seen,
            Some((
                "codex".into(),
                "CODEX_HOME".into(),
                home.root().join("codex/회사")
            ))
        );
    }

    /// The CLI's default folders are never removed: a profile step that is a
    /// symlink to one (or anywhere) is refused before the status command runs.
    #[test]
    fn a_symlinked_profile_is_refused_and_the_target_survives() {
        let home = Home::new("symlink");
        // Stand-ins for the CLIs' default folders, in the throwaway home.
        let default = home.0.join(DEFAULT_FOLDERS[0]);
        std::fs::create_dir_all(&default).unwrap();
        std::fs::write(default.join("keep"), b"x").unwrap();
        create_profile(&home.0, "claude", "개인").unwrap();
        let evil = home.root().join("claude/evil");
        symlink(&default, &evil).unwrap();
        let mut ran = false;
        let err = remove_profile(&home.0, "claude", "evil", |_, _, _| {
            ran = true;
            SignOut::SignedOut
        })
        .unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(!ran, "status ran for a symlinked folder");
        assert!(default.join("keep").is_file());
        // Listing skips it, too.
        assert!(list_profiles(&home.0).iter().all(|p| p.label != "evil"));

        // A symlinked harness folder (every profile under it) is refused.
        let other = home.0.join("elsewhere");
        std::fs::create_dir_all(other.join("x")).unwrap();
        std::fs::remove_dir_all(home.root().join("codex")).ok();
        symlink(&other, home.root().join("codex")).unwrap();
        assert!(remove_profile(&home.0, "codex", "x", signed_out)
            .unwrap_err()
            .contains("symlink"));
        assert!(other.join("x").is_dir());

        // A symlinked `oort` folder too.
        let home2 = Home::new("symlink-root");
        let real = home2.0.join("real-oort");
        std::fs::create_dir_all(real.join("profiles/claude/a")).unwrap();
        std::fs::create_dir_all(home2.0.join("Library/Application Support")).unwrap();
        symlink(&real, home2.0.join("Library/Application Support/oort")).unwrap();
        assert!(remove_profile(&home2.0, "claude", "a", signed_out)
            .unwrap_err()
            .contains("symlink"));
        assert!(real.join("profiles/claude/a").is_dir());
        assert!(create_profile(&home2.0, "claude", "b").is_err());
    }

    /// Even with no symlink on the way, a folder that resolves to a CLI's
    /// default folder (a hard-to-make case: a bind or firmlink) is refused by
    /// the resolved-path check. Driven directly: `check_on_disk` with the
    /// default folder itself.
    #[test]
    fn the_default_folders_and_home_are_never_a_profile() {
        let home = Home::new("defaults");
        for name in DEFAULT_FOLDERS {
            let default = home.0.join(name);
            std::fs::create_dir_all(&default).unwrap();
            assert!(check_on_disk(&home.0, &default).is_err(), "{name}");
        }
        assert!(check_on_disk(&home.0, &home.0).is_err());
        assert!(check_on_disk(&home.0, &home.root()).is_err());
        assert!(check_on_disk(&home.0, &home.root().join("claude")).is_err());
        assert!(check_on_disk(&home.0, Path::new("/tmp")).is_err());
        // A path that names the root but walks out of it.
        let out = home.root().join("claude/../../../../..");
        assert!(check_on_disk(&home.0, &out).is_err());
    }

    /// What a firmlink or bind mount would do: the walk sees real directories,
    /// but the folder resolves somewhere else. The resolved-path check refuses
    /// the root itself, anything outside it, and a CLI's default folder even
    /// when that folder were mounted under the root.
    #[test]
    fn a_folder_that_resolves_elsewhere_is_refused() {
        let home = Home::new("resolved");
        create_profile(&home.0, "claude", "개인").unwrap();
        let root = home.root();
        let inside = root.join("claude/개인").canonicalize().unwrap();
        assert!(check_resolved(&home.0, &root, &inside).is_ok());
        let outside = home.0.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        for resolved in [
            outside.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
            home.0.clone(),
        ] {
            assert!(
                check_resolved(&home.0, &root, &resolved).is_err(),
                "{resolved:?}"
            );
        }
        // A CLI's default folder, and one "mounted" under the root: the
        // default folder check alone refuses both.
        for name in DEFAULT_FOLDERS {
            let default = home.0.join(name);
            std::fs::create_dir_all(&default).unwrap();
            let default = default.canonicalize().unwrap();
            assert!(check_resolved(&home.0, &root, &default).is_err(), "{name}");
        }
        let fake_root = home.0.join(DEFAULT_FOLDERS[0]).join("profiles");
        std::fs::create_dir_all(fake_root.join("claude/x")).unwrap();
        let mounted = fake_root.join("claude/x").canonicalize().unwrap();
        assert!(check_resolved(&home.0, &fake_root, &mounted)
            .unwrap_err()
            .contains("default folder"));
    }

    /// Only an explicit structured "signed out" deletes; "signed in" and
    /// "unknown" keep the folder (PR #2996 re-review Medium-1).
    #[test]
    fn only_a_structured_signed_out_opens_the_removal_gate() {
        let home = Home::new("gate");
        create_profile(&home.0, "claude", "개인").unwrap();
        assert_eq!(
            remove_profile(&home.0, "claude", "개인", |_, _, _| SignOut::Unknown).unwrap(),
            RemoveOutcome::Unknown
        );
        assert_eq!(
            remove_profile(&home.0, "claude", "개인", |_, _, _| SignOut::SignedIn).unwrap(),
            RemoveOutcome::StillSignedIn
        );
        assert!(home.root().join("claude/개인").is_dir());
    }

    /// End to end with a fake `claude` on PATH: a crash that exits 1 keeps the
    /// folder, a real structured "signed out" deletes it.
    #[test]
    fn a_fake_cli_crash_keeps_the_folder_and_a_real_sign_out_deletes_it() {
        use std::os::unix::fs::PermissionsExt;
        let home = Home::new("e2e");
        let bin = home.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = std::env::join_paths([bin.clone(), "/bin".into(), "/usr/bin".into()]).unwrap();
        let write = |body: &str| {
            let f = bin.join("claude");
            std::fs::write(&f, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        create_profile(&home.0, "claude", "회사").unwrap();
        let check = |harness: &str, env: &str, dir: &Path| {
            profile_signout::check_with(
                harness,
                env,
                dir,
                &home.0,
                &path,
                std::time::Duration::from_secs(5),
            )
        };
        write("echo 'TypeError: cannot read keychain' >&2\nexit 1");
        assert_eq!(
            remove_profile(&home.0, "claude", "회사", check).unwrap(),
            RemoveOutcome::Unknown
        );
        assert!(home.root().join("claude/회사").is_dir());
        write("echo '{\"loggedIn\": false, \"authMethod\": \"none\"}'\nexit 1");
        assert_eq!(
            remove_profile(&home.0, "claude", "회사", check).unwrap(),
            RemoveOutcome::Removed
        );
        assert!(!home.root().join("claude/회사").exists());
    }

    /// A label that reaches the folder only through the file system's
    /// case/normalization folding is refused: the CLI would get a different
    /// string than the one it signed in with (#2878 security review M-1).
    #[test]
    fn a_label_must_match_the_folder_name_byte_for_byte() {
        let home = Home::new("exact");
        create_profile(&home.0, "claude", "Work").unwrap();
        create_profile(&home.0, "claude", "회사").unwrap();
        let nfd = "회사".chars().collect::<String>(); // stays NFC; build NFD below
        assert_eq!(nfd, "회사");
        // Decomposed 「회사」: ㅎ ㅚ ㅅ ㅏ as conjoining jamo.
        let decomposed = "\u{1112}\u{116C}\u{1109}\u{1161}";
        for variant in ["WORK", "work", decomposed] {
            let mut ran = false;
            let result = remove_profile(&home.0, "claude", variant, |_, _, _| {
                ran = true;
                SignOut::SignedOut
            });
            assert!(result.is_err(), "{variant:?}: {result:?}");
            assert!(!ran, "{variant:?}: status ran");
            assert!(
                existing_profile(&home.0, "claude", variant).is_err(),
                "{variant:?}"
            );
        }
        assert!(home.root().join("claude/Work").is_dir());
        assert!(existing_profile(&home.0, "claude", "Work").is_ok());
        assert!(existing_profile(&home.0, "claude", "회사").is_ok());
    }

    /// The folder is checked again after the status command: if it turned into
    /// a symlink meanwhile, nothing is deleted through it.
    #[test]
    fn the_folder_is_checked_again_right_before_deleting() {
        let home = Home::new("recheck");
        let default = home.0.join(DEFAULT_FOLDERS[1]);
        std::fs::create_dir_all(&default).unwrap();
        std::fs::write(default.join("keep"), b"x").unwrap();
        create_profile(&home.0, "codex", "개인").unwrap();
        let dir = home.root().join("codex/개인");
        let err = remove_profile(&home.0, "codex", "개인", |_, _, d| {
            std::fs::remove_dir_all(d).unwrap();
            symlink(&default, d).unwrap();
            SignOut::SignedOut
        })
        .unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(std::fs::symlink_metadata(&dir)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(default.join("keep").is_file());
    }

    /// `check_on_disk` takes a profile folder only: two steps under the root,
    /// never the harness folder or something inside a profile.
    #[test]
    fn only_a_profile_folder_passes_the_disk_check() {
        let home = Home::new("depth");
        create_profile(&home.0, "claude", "개인").unwrap();
        let inner = home.root().join("claude/개인/projects");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(check_on_disk(&home.0, &home.root().join("claude/개인")).is_ok());
        for path in [home.root().join("claude"), inner] {
            assert_eq!(
                check_on_disk(&home.0, &path).unwrap_err(),
                "refused: not a profile folder",
                "{path:?}"
            );
        }
    }

    /// Nothing is created through a symlinked `oort` folder.
    #[test]
    fn create_makes_nothing_through_a_symlink() {
        let home = Home::new("create-link");
        let real = home.0.join("real-oort");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(home.0.join("Library/Application Support")).unwrap();
        symlink(&real, home.0.join("Library/Application Support/oort")).unwrap();
        assert!(create_profile(&home.0, "claude", "개인")
            .unwrap_err()
            .contains("not a real directory"));
        assert_eq!(
            std::fs::read_dir(&real).unwrap().count(),
            0,
            "created through the link"
        );
    }

    #[test]
    fn a_label_has_no_invisible_character() {
        for bad in [
            "회\u{200B}사",
            "\u{202E}lanosrep",
            "a\u{FEFF}",
            "a\u{2066}b",
            "soft\u{00AD}hy",
            "\u{3164}",
            "\u{115F}x",
            "a\u{00A0}b",
            "a\u{2028}b",
            "a\u{3000}b",
        ] {
            assert!(check_label(bad).is_err(), "{bad:?}");
        }
        // An ordinary space in the middle stays allowed.
        assert!(check_label("Team (Max)").is_ok());
    }

    #[test]
    fn remove_refuses_a_missing_or_invalid_profile() {
        let home = Home::new("missing");
        assert!(remove_profile(&home.0, "claude", "없음", signed_out).is_err());
        assert!(remove_profile(&home.0, "claude", "..", signed_out).is_err());
        assert!(remove_profile(&home.0, "grok", "a", signed_out).is_err());
        let file_home = Home::new("file");
        std::fs::create_dir_all(file_home.root().join("claude")).unwrap();
        std::fs::write(file_home.root().join("claude/plain"), b"x").unwrap();
        assert!(remove_profile(&file_home.0, "claude", "plain", signed_out)
            .unwrap_err()
            .contains("not a directory"));
    }

    #[test]
    fn the_request_names_a_harness_and_a_label_only() {
        let ok: ProfileRef =
            serde_json::from_str(r#"{"harness":"claude","label":"회사"}"#).unwrap();
        assert_eq!(ok.label, "회사");
        for extra in [
            r#"{"harness":"claude","label":"a","path":"/tmp"}"#,
            r#"{"harness":"claude","label":"a","env":{"CLAUDE_CONFIG_DIR":"/tmp"}}"#,
            r#"{"harness":"claude"}"#,
        ] {
            assert!(
                serde_json::from_str::<ProfileRef>(extra).is_err(),
                "{extra}"
            );
        }
    }

    /// Nothing here opens a file, prints, or names a credential store.
    #[test]
    fn the_module_opens_no_file_and_logs_nothing() {
        let src = include_str!("harness_profile.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        for needle in [
            "File::open",
            "File::create",
            "read_to_string",
            "read_to_end",
            "std::fs::read(",
            "std::fs::write",
            "OpenOptions",
            "println!",
            "eprintln!",
            "dbg!(",
            "log::",
            "tracing::",
            "Command::new(",
            "\"security\"",
            "delete-generic-password",
        ] {
            assert!(!src.contains(needle), "harness_profile.rs uses {needle}");
        }
    }
}
