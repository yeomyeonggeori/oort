//! Which account a remote work session runs as (ADR-0191 D1 조건 1·8, #3033).
//!
//! A remote session (started from the phone or the web, run by this host)
//! follows **this Mac's own choice** — the 「원격 작업」 row of the desktop's
//! 기본 AI table — and nothing the server or the phone says. The desktop app
//! hands the choice over the code-signed control socket (`set_remote_profile`,
//! [`crate::control_socket`]); it lands in `remote-profiles.json` in the host
//! state folder (`0600`, this user's, read through
//! [`crate::config::read_owned_file`]). The spawn control, its device
//! signature and the server never carry an account or a path, so no relay can
//! switch it (ADR-0191 D1: 「경로는 서버에 싣지 않는다」).
//!
//! ## What a profile is
//!
//! **A lane profiles are not the local terminal's** (ADR-0191 D1): the local
//! folders (`~/Library/Application Support/oort/profiles`, #2878) grow user
//! layer settings — hooks, allow rules, MCP — that a remote session must
//! never inherit. An A lane profile is one `0700` folder per (harness, label)
//! **under the host state folder**:
//! `<state>/profiles/<harness>/<label>/`. The owner signs the official CLI in
//! to it once (`prepare_remote_profile` makes the folder and returns the exact
//! path to sign in with); the CLI keeps its own sign-in there. Claude Code
//! names its keychain item after a hash of the `CLAUDE_CONFIG_DIR` *string*,
//! so the value set here is exactly `<state folder>/profiles/<harness>/<label>`
//! as the host was configured with it — no trailing slash, the last step never
//! resolved.
//!
//! ## No silent fallback
//!
//! A label is set, or none is. With none, a session runs as before (Claude in
//! the host's default sign-in, Codex in the host-only `codex-home`). With one,
//! the session runs as that profile **or is refused** with an honest label
//! ([`Refusal::ProfileNotFound`], [`Refusal::ProfileRefused`],
//! [`Refusal::ProfileLoginRequired`]) — never as the default account. An
//! unreadable choice file is a refusal too, not "no choice".
//!
//! ## Checked at every spawn
//!
//! * the label is one folder name ([`check_label`]), the folder is a real
//!   directory at every step from `profiles` down (no symlink), its name on
//!   disk is byte-for-byte the label, it resolves under the profile root, and
//!   is this user's and `0700`;
//! * it lies neither inside nor around the allowed folder (nor the state
//!   folder's other contents: the root is *inside* the state folder by
//!   construction, a path outside it cannot be named);
//! * Claude: no configuration entry the CLI would apply ([`CLAUDE_FORBIDDEN`],
//!   and a `settings.json` with hooks, MCP servers, allow rules, an `env` block
//!   or a helper command, [`check_claude_settings`]). A remote Claude session
//!   reads no settings file anyway (`settingSources: []`,
//!   [`crate::policy::AdapterKind::session_new_meta`]), so the host refuses
//!   rather than rewrites;
//! * Codex: the folder is the session's `CODEX_HOME` and must pass
//!   [`crate::policy::prepare_codex_home`] like the host-only home does (the
//!   host rewrites its `config.toml` — the folder is the host's, so no local
//!   terminal shares it).
//! * the whole profiles folder is denied to a session's own tools and commands
//!   ([`crate::policy::session_new_params_protecting`]).

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{read_owned_file, write_private_file};
use crate::policy::{holds_any, AdapterKind, Refusal};

/// The folder under the host state folder that holds every A lane profile.
pub const PROFILES_DIR: &str = "profiles";
pub const MAX_LABEL_CHARS: usize = 32;
/// The choice file in the host state folder.
pub const PROFILES_FILE: &str = "remote-profiles.json";
/// Serializes the read-modify-write of the choice file and folder creation
/// (each control-socket connection runs on its own task).
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// Largest `settings.json` read.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

/// Entries of a Claude profile folder that would configure the CLI beyond its
/// sign-in (ADR-0191 D1 조건 8). Claude Code writes its own state there
/// (`projects/`, `todos/`, `statsig/`, history, its `.claude.json`); those are
/// not configuration and are left alone, as with `CODEX_HOME_FORBIDDEN`.
pub const CLAUDE_FORBIDDEN: &[&str] = &[
    "settings.local.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
    "agents",
    "commands",
    "skills",
    "plugins",
    "hooks",
    "output-styles",
    "rules",
    "keybindings.json",
    ".mcp.json",
];

/// Top-level `settings.json` keys that run code, add tools, change the
/// account/endpoint or widen permissions.
const CLAUDE_SETTINGS_FORBIDDEN_KEYS: &[&str] = &[
    "hooks",
    "mcpServers",
    "enabledMcpjsonServers",
    "enabledPlugins",
    "extraKnownMarketplaces",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "otelHeadersHelper",
    "statusLine",
    "env",
];

/// The harness name a profile folder is filed under.
pub fn harness_of(adapter: AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::Claude => "claude",
        AdapterKind::Codex => "codex",
    }
}

/// A label is one folder name the person chose: 1..=32 characters, no
/// separator, no control or invisible character, not hidden, no edge spaces.
/// Same rules as `harness_profile::check_label` (desktop crate), so one label
/// names both the local and the remote folder.
pub fn check_label(label: &str) -> bool {
    let count = label.chars().count();
    count != 0
        && count <= MAX_LABEL_CHARS
        && label.trim() == label
        && !label.starts_with('.')
        && !label
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control() || is_invisible(c))
}

/// Format characters that draw nothing or reorder text, and non-ASCII spaces:
/// two labels that look the same must not be two folders.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{2800}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{E0000}'..='\u{E007F}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{3164}'
            | '\u{FFA0}'
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

// ---------------------------------------------------------------------------
// the choice file
// ---------------------------------------------------------------------------

/// `remote-profiles.json`: one optional label per harness. Unknown keys are
/// refused, so a typo cannot pass for "no choice".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteProfiles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
}

impl RemoteProfiles {
    /// Read the choice. No file is "no choice"; a file that cannot be read
    /// safely or parsed is a refusal (closed, never the default account).
    pub fn load(state_folder: &Path) -> Result<Self, Refusal> {
        let path = state_folder.join(PROFILES_FILE);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(_) => return Err(Refusal::ProfileRefused),
            Ok(_) => {}
        }
        let raw = read_owned_file(&path).map_err(|_| Refusal::ProfileRefused)?;
        // An object only: serde would read `[]` as a struct with no fields.
        let value: Value = serde_json::from_str(&raw).map_err(|_| Refusal::ProfileRefused)?;
        if !value.is_object() {
            return Err(Refusal::ProfileRefused);
        }
        serde_json::from_value(value).map_err(|_| Refusal::ProfileRefused)
    }

    /// The label chosen for `adapter`, if any.
    pub fn label_for(&self, adapter: AdapterKind) -> Option<&str> {
        match adapter {
            AdapterKind::Claude => self.claude.as_deref(),
            AdapterKind::Codex => self.codex.as_deref(),
        }
    }

    /// Set or clear (`None`) the choice for `harness`, after checking that the
    /// label names a usable, signed-in-once profile folder now — so the desktop
    /// learns of a typo when it saves, not when the phone asks. Other
    /// harnesses' choices are kept.
    ///
    /// `Ok(true)` when the choice file could not be read and clearing reset
    /// it: every harness is back to no choice, which the caller must tell the
    /// person (never silent).
    pub fn set(state_folder: &Path, harness: &str, label: Option<&str>) -> Result<bool, SetError> {
        // Two overlapping saves must not lose one of the choices.
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let adapter = match harness {
            "claude" => AdapterKind::Claude,
            "codex" => AdapterKind::Codex,
            _ => return Err(SetError::UnknownHarness),
        };
        // A choice file that cannot be read is not overwritten by a new
        // choice (the other harness's would silently fall back to the default
        // account); clearing one harness's choice resets it.
        let mut reset = false;
        let mut current = match (Self::load(state_folder), label) {
            (Ok(current), _) => current,
            (Err(_), None) => {
                reset = true;
                Self::default()
            }
            (Err(_), Some(_)) => return Err(SetError::Unavailable),
        };
        let slot = match adapter {
            AdapterKind::Claude => &mut current.claude,
            AdapterKind::Codex => &mut current.codex,
        };
        match label {
            Some(label) => {
                if !check_label(label) {
                    return Err(SetError::InvalidLabel);
                }
                resolve(state_folder, harness, label).map_err(|refusal| match refusal {
                    Refusal::ProfileNotFound => SetError::NotFound,
                    _ => SetError::Refused,
                })?;
                *slot = Some(label.to_string());
            }
            None => *slot = None,
        }
        let body = serde_json::to_vec(&current).map_err(|_| SetError::Unavailable)?;
        write_private_file(&state_folder.join(PROFILES_FILE), &body)
            .map_err(|_| SetError::Unavailable)?;
        Ok(reset)
    }
}

/// Why `set_remote_profile` did not save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetError {
    UnknownHarness,
    InvalidLabel,
    NotFound,
    Refused,
    Unavailable,
}

impl SetError {
    pub fn label(self) -> &'static str {
        match self {
            Self::UnknownHarness => "unknown_harness",
            Self::InvalidLabel => "invalid_label",
            Self::NotFound => "profile_not_found",
            Self::Refused => "profile_refused",
            Self::Unavailable => "profiles_unavailable",
        }
    }
}

// ---------------------------------------------------------------------------
// the folder
// ---------------------------------------------------------------------------

/// Every A lane profile lives under this folder.
pub fn profile_root(state_folder: &Path) -> PathBuf {
    state_folder.join(PROFILES_DIR)
}

/// The profile folder as the path string the CLI will hash: pure, no disk.
pub fn profile_dir(state_folder: &Path, harness: &str, label: &str) -> PathBuf {
    profile_root(state_folder).join(harness).join(label)
}

/// The profiles folder as the agent's read/edit deny rules must name it: as
/// configured, and resolved when the OS resolves it differently (`/var` →
/// `/private/var`), since a rule matches the path the tool asks for.
pub fn protected_roots(state_folder: &Path) -> Vec<PathBuf> {
    let root = profile_root(state_folder);
    let mut roots = vec![root.clone()];
    if let Ok(canonical) = root.canonicalize() {
        if canonical != root {
            roots.push(canonical);
        }
    }
    roots
}

fn own_private_dir(metadata: &std::fs::Metadata) -> bool {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0
}

/// The folder as it is on disk (see the module docs). [`Refusal::ProfileNotFound`]
/// when a step is missing; [`Refusal::ProfileRefused`] for anything unsafe.
pub fn resolve(state_folder: &Path, harness: &str, label: &str) -> Result<PathBuf, Refusal> {
    if !check_label(label) || !matches!(harness, "claude" | "codex") {
        return Err(Refusal::ProfileRefused);
    }
    let dir = profile_dir(state_folder, harness, label);
    let mut step = state_folder.to_path_buf();
    for segment in [PROFILES_DIR, harness, label] {
        step = step.join(segment);
        let metadata = match std::fs::symlink_metadata(&step) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(Refusal::ProfileNotFound)
            }
            Err(_) => return Err(Refusal::ProfileRefused),
        };
        // A link is never followed; every step is this user's and private.
        if metadata.file_type().is_symlink() || !own_private_dir(&metadata) {
            return Err(Refusal::ProfileRefused);
        }
    }
    // APFS matches names case- and normalization-insensitively, but the CLI
    // hashes the string it is given: the name on disk must be the label.
    let parent = dir.parent().ok_or(Refusal::ProfileRefused)?;
    let exact = std::fs::read_dir(parent)
        .map_err(|_| Refusal::ProfileRefused)?
        .filter_map(Result::ok)
        .any(|entry| entry.file_name() == std::ffi::OsStr::new(label));
    if !exact {
        return Err(Refusal::ProfileNotFound);
    }
    let canonical = dir.canonicalize().map_err(|_| Refusal::ProfileRefused)?;
    let canonical_root = profile_root(state_folder)
        .canonicalize()
        .map_err(|_| Refusal::ProfileRefused)?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err(Refusal::ProfileRefused);
    }
    Ok(dir)
}

/// Make the profile folder for the owner to sign in to (or find it, when it
/// exists and is usable): each step from `profiles` down is created `0700`
/// one at a time and checked before the next, so nothing is made through a
/// link. Returns the exact path to hand to the CLI as `CLAUDE_CONFIG_DIR` /
/// `CODEX_HOME`.
pub fn prepare(state_folder: &Path, harness: &str, label: &str) -> Result<PathBuf, SetError> {
    use std::os::unix::fs::DirBuilderExt as _;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if !matches!(harness, "claude" | "codex") {
        return Err(SetError::UnknownHarness);
    }
    if !check_label(label) {
        return Err(SetError::InvalidLabel);
    }
    let mut step = state_folder.to_path_buf();
    for segment in [PROFILES_DIR, harness, label] {
        step = step.join(segment);
        match std::fs::symlink_metadata(&step) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&step)
                    .map_err(|_| SetError::Unavailable)?;
            }
            Err(_) => return Err(SetError::Unavailable),
            // Never made through, or reused across, a link.
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(SetError::Refused)
            }
            Ok(_) => {}
        }
    }
    resolve(state_folder, harness, label).map_err(|refusal| match refusal {
        Refusal::ProfileNotFound => SetError::NotFound,
        _ => SetError::Refused,
    })
}

/// The folder overlaps not the allowed folder: the agent may write there, and
/// the sandbox of a Codex session too. (The allowed folder around the state
/// folder is caught here as well: it would contain the profile.)
pub fn check_placement(dir: &Path, cwd: &Path) -> Result<(), Refusal> {
    let dir = dir.canonicalize().map_err(|_| Refusal::ProfileRefused)?;
    if dir.starts_with(cwd) || cwd.starts_with(&dir) {
        return Err(Refusal::ProfileRefused);
    }
    Ok(())
}

/// Claude: no configuration entry the CLI would apply (ADR-0191 D1 조건 8).
pub fn check_claude_profile(dir: &Path) -> Result<(), Refusal> {
    if holds_any(dir, CLAUDE_FORBIDDEN) {
        return Err(Refusal::ProfileRefused);
    }
    check_claude_settings(&dir.join("settings.json"))
}

/// `settings.json` may exist (the CLI or the person wrote one) but may not
/// hook, add tools or widen permissions.
pub fn check_claude_settings(path: &Path) -> Result<(), Refusal> {
    use std::io::Read as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(Refusal::ProfileRefused),
    };
    let metadata = file.metadata().map_err(|_| Refusal::ProfileRefused)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_SETTINGS_BYTES {
        return Err(Refusal::ProfileRefused);
    }
    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .map_err(|_| Refusal::ProfileRefused)?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| Refusal::ProfileRefused)?;
    let Some(object) = value.as_object() else {
        return Err(Refusal::ProfileRefused);
    };
    if CLAUDE_SETTINGS_FORBIDDEN_KEYS
        .iter()
        .any(|key| object.contains_key(*key))
    {
        return Err(Refusal::ProfileRefused);
    }
    // Any `permissions.allow` (even an empty list is left alone) that names a
    // rule widens what runs without asking.
    if let Some(permissions) = object.get("permissions") {
        let Some(permissions) = permissions.as_object() else {
            return Err(Refusal::ProfileRefused);
        };
        let allows = permissions
            .get("allow")
            .map(|allow| allow.as_array().is_none_or(|rules| !rules.is_empty()))
            .unwrap_or(false);
        if allows {
            return Err(Refusal::ProfileRefused);
        }
    }
    Ok(())
}

/// Everything a spawn needs from the choice: `None` when none is set for this
/// adapter, else the checked folder. Errors are refusals — see the module docs.
pub fn for_spawn(
    state_folder: &Path,
    adapter: AdapterKind,
    cwd: &Path,
) -> Result<Option<PathBuf>, Refusal> {
    let profiles = RemoteProfiles::load(state_folder)?;
    let Some(label) = profiles.label_for(adapter) else {
        return Ok(None);
    };
    let dir = resolve(state_folder, harness_of(adapter), label)?;
    check_placement(&dir, cwd)?;
    if adapter == AdapterKind::Claude {
        check_claude_profile(&dir)?;
    }
    Ok(Some(dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};

    struct Fixture {
        root: PathBuf,
        /// The host state folder.
        state: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn private(path: &Path) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    /// A fake state folder with `profiles/<harness>/<label>` folders (0700).
    fn fixture(profiles: &[(&str, &str)]) -> Fixture {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "momo-workd-profile-{}",
                uuid::Uuid::new_v4().simple()
            ));
        private(&root);
        let state = root.join("state");
        private(&state);
        for (harness, label) in profiles {
            private(&profile_dir(&state, harness, label));
        }
        Fixture { root, state }
    }

    #[test]
    fn the_folder_string_is_state_profiles_harness_label() {
        // Claude Code hashes this exact string for its keychain item: the
        // sign-in (`prepare_remote_profile`) and every spawn build it here.
        assert_eq!(
            profile_dir(Path::new("/state/workd"), "claude", "Work").to_str(),
            Some("/state/workd/profiles/claude/Work")
        );
    }

    #[test]
    fn labels_follow_the_desktops_rules() {
        for good in ["Work", "개인", "a b", &"x".repeat(32)] {
            assert!(check_label(good), "{good:?}");
        }
        for bad in [
            "",
            &"x".repeat(33),
            " lead",
            "trail ",
            ".hidden",
            "a/b",
            "a\\b",
            "a:b",
            "a\nb",
            "a\u{200B}b",
            "a\u{00A0}b",
            "a\u{3000}b",
            "..",
        ] {
            assert!(!check_label(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_profile_folder_resolves_under_the_state_folder() {
        let f = fixture(&[("claude", "Work"), ("codex", "Work")]);
        assert_eq!(
            resolve(&f.state, "claude", "Work"),
            Ok(profile_dir(&f.state, "claude", "Work"))
        );
        assert_eq!(
            resolve(&f.state, "codex", "Work"),
            Ok(profile_dir(&f.state, "codex", "Work"))
        );
    }

    #[test]
    fn a_missing_or_misnamed_profile_is_not_found_not_a_fallback() {
        let f = fixture(&[("claude", "Work")]);
        assert_eq!(
            resolve(&f.state, "claude", "Gone"),
            Err(Refusal::ProfileNotFound)
        );
        // Same label, other harness: no such folder.
        assert_eq!(
            resolve(&f.state, "codex", "Work"),
            Err(Refusal::ProfileNotFound)
        );
        // A different case reaches the folder on APFS but names another
        // keychain item: not found either way.
        assert_eq!(
            resolve(&f.state, "claude", "work"),
            Err(Refusal::ProfileNotFound)
        );
        // Not a label at all, and no path can be named.
        for label in ["../..", "../../x", "/etc", "a/b"] {
            assert_eq!(
                resolve(&f.state, "claude", label),
                Err(Refusal::ProfileRefused),
                "{label}"
            );
        }
        assert_eq!(
            resolve(&f.state, "grok", "Work"),
            Err(Refusal::ProfileRefused)
        );
    }

    #[test]
    fn a_symlink_anywhere_from_profiles_down_is_refused() {
        let f = fixture(&[("claude", "Real")]);
        let elsewhere = f.root.join("elsewhere");
        private(&elsewhere);
        // The label itself.
        std::os::unix::fs::symlink(&elsewhere, profile_dir(&f.state, "claude", "Link")).unwrap();
        assert_eq!(
            resolve(&f.state, "claude", "Link"),
            Err(Refusal::ProfileRefused)
        );
        // The harness folder.
        let root = profile_root(&f.state);
        std::fs::rename(root.join("claude"), f.root.join("moved")).unwrap();
        std::os::unix::fs::symlink(f.root.join("moved"), root.join("claude")).unwrap();
        assert_eq!(
            resolve(&f.state, "claude", "Real"),
            Err(Refusal::ProfileRefused)
        );
        // The profiles folder itself.
        std::fs::remove_file(root.join("claude")).unwrap();
        std::fs::rename(&root, f.root.join("moved-root")).unwrap();
        std::os::unix::fs::symlink(f.root.join("moved-root"), &root).unwrap();
        assert_eq!(
            resolve(&f.state, "claude", "Real"),
            Err(Refusal::ProfileRefused)
        );
    }

    #[test]
    fn a_folder_others_can_enter_is_refused_at_every_step() {
        for step in [
            PathBuf::from(PROFILES_DIR),
            PathBuf::from(PROFILES_DIR).join("claude"),
            PathBuf::from(PROFILES_DIR).join("claude").join("Work"),
        ] {
            let f = fixture(&[("claude", "Work")]);
            std::fs::set_permissions(f.state.join(&step), std::fs::Permissions::from_mode(0o750))
                .unwrap();
            assert_eq!(
                resolve(&f.state, "claude", "Work"),
                Err(Refusal::ProfileRefused),
                "{step:?}"
            );
        }
    }

    #[test]
    fn a_profile_may_not_overlap_the_allowed_folder() {
        let f = fixture(&[("claude", "Work")]);
        let dir = profile_dir(&f.state, "claude", "Work");
        let repo = f.root.join("repo");
        private(&repo);
        assert_eq!(check_placement(&dir, &repo), Ok(()));
        // The agent may write in the allowed folder: a profile inside it (or
        // an allowed folder inside the profile) is refused.
        for cwd in [
            &f.root,
            &f.state,
            &dir,
            &dir.join("projects"),
            &profile_root(&f.state),
        ] {
            assert_eq!(
                check_placement(&dir, cwd),
                Err(Refusal::ProfileRefused),
                "{cwd:?}"
            );
        }
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn a_claude_profile_with_only_its_sign_in_and_runtime_state_is_clean() {
        let f = fixture(&[("claude", "Work")]);
        let dir = profile_dir(&f.state, "claude", "Work");
        assert_eq!(check_claude_profile(&dir), Ok(()));
        // What Claude Code itself writes is not configuration.
        write(&dir, ".credentials.json", "{}");
        write(&dir, ".claude.json", "{\"mcpServers\":{}}");
        write(&dir, "projects/x/session.jsonl", "");
        write(&dir, "todos/a.json", "[]");
        write(&dir, "statsig/cache", "");
        write(&dir, "history.jsonl", "");
        write(
            &dir,
            "settings.json",
            "{\"theme\":\"dark\",\"permissions\":{\"deny\":[\"Read(x)\"],\"allow\":[]}}",
        );
        assert_eq!(check_claude_profile(&dir), Ok(()));
    }

    #[test]
    fn every_configuration_entry_of_a_claude_profile_is_refused() {
        for name in CLAUDE_FORBIDDEN {
            let f = fixture(&[("claude", "Work")]);
            let dir = profile_dir(&f.state, "claude", "Work");
            // A file, and (for folders) a non-empty folder, both count.
            write(&dir, name, "x");
            assert_eq!(
                check_claude_profile(&dir),
                Err(Refusal::ProfileRefused),
                "{name} as a file"
            );
            std::fs::remove_file(dir.join(name)).unwrap();
            write(&dir, &format!("{name}/inner"), "x");
            assert_eq!(
                check_claude_profile(&dir),
                Err(Refusal::ProfileRefused),
                "{name} as a folder"
            );
        }
    }

    #[test]
    fn a_settings_json_that_hooks_adds_tools_or_widens_permissions_is_refused() {
        let hooks =
            "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"true\"}]}]}}";
        let mut bodies = vec![
            hooks.to_string(),
            "{\"permissions\":{\"allow\":[\"Bash(ls:*)\"]}}".into(),
            "{\"permissions\":{\"allow\":\"Bash\"}}".into(),
            "{\"permissions\":[]}".into(),
            "not json".into(),
            "[]".into(),
        ];
        for key in CLAUDE_SETTINGS_FORBIDDEN_KEYS {
            bodies.push(format!("{{\"{key}\":{{}}}}"));
        }
        for body in bodies {
            let f = fixture(&[("claude", "Work")]);
            let dir = profile_dir(&f.state, "claude", "Work");
            write(&dir, "settings.json", &body);
            assert_eq!(
                check_claude_profile(&dir),
                Err(Refusal::ProfileRefused),
                "{body}"
            );
        }
    }

    #[test]
    fn a_settings_json_that_is_a_link_or_huge_is_refused() {
        let f = fixture(&[("claude", "Work")]);
        let dir = profile_dir(&f.state, "claude", "Work");
        write(&f.root, "elsewhere.json", "{}");
        std::os::unix::fs::symlink(f.root.join("elsewhere.json"), dir.join("settings.json"))
            .unwrap();
        assert_eq!(check_claude_profile(&dir), Err(Refusal::ProfileRefused));
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        write(
            &dir,
            "settings.json",
            &format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_SETTINGS_BYTES as usize)),
        );
        assert_eq!(check_claude_profile(&dir), Err(Refusal::ProfileRefused));
    }

    #[test]
    fn preparing_makes_the_private_folder_once_and_returns_the_sign_in_path() {
        let f = fixture(&[]);
        let path = prepare(&f.state, "claude", "개인(Max)").unwrap();
        assert_eq!(path, profile_dir(&f.state, "claude", "개인(Max)"));
        for step in [
            profile_root(&f.state),
            profile_root(&f.state).join("claude"),
            path.clone(),
        ] {
            assert_eq!(
                std::fs::metadata(&step).unwrap().mode() & 0o777,
                0o700,
                "{step:?}"
            );
        }
        // Again: the same folder, untouched.
        write(&path, ".credentials.json", "{}");
        assert_eq!(prepare(&f.state, "claude", "개인(Max)").unwrap(), path);
        assert!(path.join(".credentials.json").exists());
        // Refusals make nothing.
        for (harness, label, want) in [
            ("grok", "Work", SetError::UnknownHarness),
            ("claude", "../x", SetError::InvalidLabel),
            ("codex", ".hidden", SetError::InvalidLabel),
        ] {
            assert_eq!(prepare(&f.state, harness, label), Err(want));
        }
        assert!(!profile_root(&f.state).join("codex").exists());
        // Never through a link.
        let elsewhere = f.root.join("elsewhere");
        private(&elsewhere);
        std::os::unix::fs::symlink(&elsewhere, profile_root(&f.state).join("codex")).unwrap();
        assert_eq!(prepare(&f.state, "codex", "Work"), Err(SetError::Refused));
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
    }

    #[test]
    fn the_choice_is_saved_read_and_cleared_per_harness() {
        let f = fixture(&[("claude", "Work"), ("codex", "Team")]);
        assert_eq!(
            RemoteProfiles::load(&f.state),
            Ok(RemoteProfiles::default()),
            "no file is no choice"
        );
        RemoteProfiles::set(&f.state, "claude", Some("Work")).unwrap();
        RemoteProfiles::set(&f.state, "codex", Some("Team")).unwrap();
        let saved = RemoteProfiles::load(&f.state).unwrap();
        assert_eq!(saved.label_for(AdapterKind::Claude), Some("Work"));
        assert_eq!(saved.label_for(AdapterKind::Codex), Some("Team"));
        let mode = std::fs::metadata(f.state.join(PROFILES_FILE))
            .unwrap()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(
            RemoteProfiles::set(&f.state, "claude", None),
            Ok(false),
            "a readable file is not a reset"
        );
        let saved = RemoteProfiles::load(&f.state).unwrap();
        assert_eq!(saved.label_for(AdapterKind::Claude), None);
        assert_eq!(saved.label_for(AdapterKind::Codex), Some("Team"), "kept");
    }

    #[test]
    fn overlapping_saves_for_two_harnesses_both_land() {
        let f = fixture(&[("claude", "Work"), ("codex", "Team")]);
        for round in 0..40 {
            let state = f.state.clone();
            let saves: Vec<_> = [("claude", "Work"), ("codex", "Team")]
                .into_iter()
                .map(|(harness, label)| {
                    let state = state.clone();
                    std::thread::spawn(move || {
                        RemoteProfiles::set(&state, harness, Some(label)).unwrap()
                    })
                })
                .collect();
            for save in saves {
                save.join().unwrap();
            }
            let saved = RemoteProfiles::load(&f.state).unwrap();
            assert_eq!(
                saved.label_for(AdapterKind::Claude),
                Some("Work"),
                "{round}"
            );
            assert_eq!(saved.label_for(AdapterKind::Codex), Some("Team"), "{round}");
            RemoteProfiles::set(&f.state, "claude", None).unwrap();
            RemoteProfiles::set(&f.state, "codex", None).unwrap();
        }
    }

    #[test]
    fn labels_that_look_alike_through_combining_or_tag_characters_are_refused() {
        for bad in ["a\u{034F}b", "a\u{FE0F}", "a\u{2800}b", "a\u{E0041}b"] {
            assert!(!check_label(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_choice_that_names_no_usable_profile_is_not_saved() {
        let f = fixture(&[("claude", "Work")]);
        for (harness, label, want) in [
            ("claude", "Gone", SetError::NotFound),
            ("claude", "../x", SetError::InvalidLabel),
            ("claude", "", SetError::InvalidLabel),
            ("grok", "Work", SetError::UnknownHarness),
            ("codex", "Work", SetError::NotFound),
        ] {
            assert_eq!(
                RemoteProfiles::set(&f.state, harness, Some(label)),
                Err(want),
                "{harness} {label:?}"
            );
        }
        assert!(!f.state.join(PROFILES_FILE).exists());
    }

    #[test]
    fn an_unreadable_or_unsafe_choice_file_is_a_refusal_not_no_choice() {
        let f = fixture(&[("claude", "Work")]);
        let file = f.state.join(PROFILES_FILE);
        for body in ["not json", "{\"claude\":1}", "{\"claudee\":\"Work\"}", "[]"] {
            std::fs::write(&file, body).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                RemoteProfiles::load(&f.state),
                Err(Refusal::ProfileRefused),
                "{body}"
            );
        }
        // A corrupt file is not replaced by a new choice; a clear resets it.
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(
            RemoteProfiles::set(&f.state, "claude", Some("Work")),
            Err(SetError::Unavailable)
        );
        assert_eq!(
            RemoteProfiles::set(&f.state, "claude", None),
            Ok(true),
            "the caller is told the file was reset"
        );
        assert_eq!(
            RemoteProfiles::load(&f.state),
            Ok(RemoteProfiles::default())
        );
        // A file others can write is not this host's word.
        std::fs::write(&file, "{}").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(RemoteProfiles::load(&f.state), Err(Refusal::ProfileRefused));
        // A link, likewise.
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(f.root.join("x"), &file).unwrap();
        assert_eq!(RemoteProfiles::load(&f.state), Err(Refusal::ProfileRefused));
    }

    #[test]
    fn a_spawn_gets_the_chosen_folder_or_a_refusal_never_the_default_account() {
        let f = fixture(&[("claude", "Work")]);
        let repo = f.root.join("repo");
        private(&repo);
        // No choice: the default account, as before.
        assert_eq!(for_spawn(&f.state, AdapterKind::Claude, &repo), Ok(None));
        RemoteProfiles::set(&f.state, "claude", Some("Work")).unwrap();
        assert_eq!(
            for_spawn(&f.state, AdapterKind::Claude, &repo),
            Ok(Some(profile_dir(&f.state, "claude", "Work")))
        );
        // The choice is per harness.
        assert_eq!(for_spawn(&f.state, AdapterKind::Codex, &repo), Ok(None));
        // The folder is removed behind the choice's back: refused.
        std::fs::remove_dir_all(profile_dir(&f.state, "claude", "Work")).unwrap();
        assert_eq!(
            for_spawn(&f.state, AdapterKind::Claude, &repo),
            Err(Refusal::ProfileNotFound)
        );
    }

    #[test]
    fn a_claude_profile_with_hooks_stops_the_spawn() {
        let f = fixture(&[("claude", "Work")]);
        let repo = f.root.join("repo");
        private(&repo);
        RemoteProfiles::set(&f.state, "claude", Some("Work")).unwrap();
        write(
            &profile_dir(&f.state, "claude", "Work"),
            "settings.json",
            "{\"hooks\":{}}",
        );
        assert_eq!(
            for_spawn(&f.state, AdapterKind::Claude, &repo),
            Err(Refusal::ProfileRefused)
        );
    }

    #[test]
    fn a_profile_inside_the_allowed_folder_stops_the_spawn() {
        let f = fixture(&[("claude", "Work")]);
        RemoteProfiles::set(&f.state, "claude", Some("Work")).unwrap();
        // The allowed folder is the state folder (or above it).
        assert_eq!(
            for_spawn(&f.state, AdapterKind::Claude, &f.state),
            Err(Refusal::ProfileRefused)
        );
        assert_eq!(
            for_spawn(&f.state, AdapterKind::Claude, &f.root),
            Err(Refusal::ProfileRefused)
        );
    }
}
