// Where the shell looks for a harness CLI (`claude`, `codex`, ...) — one
// module shared by every caller that has to turn a harness name into an
// absolute path (ADR-0190 D3: the local PATH is the source of truth).
//
// Callers today: `harness_status.rs` (#2813). The local terminal lane (#2772)
// resolves the same names for its panes and should call `search_path` and
// `find_on_path` here instead of keeping its own copy.
//
// **Why not ask the login shell for its PATH.** A Finder-launched app gets
// launchd's narrow PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the inherited
// value alone misses Homebrew and npm installs. The login shell knows better,
// but asking it means running `$SHELL -l -c ...`, which executes the user's rc
// files — a third program next to the two status commands ADR-0190 D3-a
// allows, and the ADR says "no shell". So this module never executes
// anything: it reads the inherited PATH and appends a fixed list of install
// folders, plus the per-version `bin` folders of the Node version managers
// (listing folder names only).
//
// Known loss: an install that lives only in a folder not listed here and not
// on the inherited PATH is reported as "not installed". In particular the
// retired per-user installer location under the Claude config folder is not
// searched — its path names the config folder, which this crate never names
// (ADR-0190 D3-b); the current native installer puts the binary in
// `~/.local/bin`, which is searched.
//
// Nothing here opens a file. `is_executable` reads metadata only.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Folders under `$HOME` where harness CLIs install, in search order.
pub const HOME_BIN_DIRS: &[&str] = &[
    ".local/bin",
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
    ".asdf/shims",
    ".local/share/mise/shims",
    // fnm's default Node (a symlink to one installed version).
    ".local/share/fnm/aliases/default/bin",
    "Library/Application Support/fnm/aliases/default/bin",
];

/// System folders where harness CLIs install (Homebrew on Apple silicon and
/// Intel, npm's default global prefix).
pub const SYSTEM_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Node version managers keep one `bin` per installed Node:
/// `$HOME/<versions>/<version>/<suffix>`. Searched after everything above,
/// newest version first.
pub const NODE_VERSION_DIRS: &[(&str, &str)] = &[
    (".nvm/versions/node", "bin"),
    (".local/share/fnm/node-versions", "installation/bin"),
    (
        "Library/Application Support/fnm/node-versions",
        "installation/bin",
    ),
];

/// Account variables removed from every harness child's environment (ADR-0191
/// D2), so a key the app happened to inherit does not decide which account a
/// harness runs as — or reports as logged in. Removing a variable does not
/// read its value.
pub const ACCOUNT_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
];

/// The search PATH: the inherited one first (it is what the user chose when
/// they launched us from a terminal), then the install folders above,
/// absolute entries only, duplicates removed.
pub fn search_path(home: Option<&Path>, inherited: Option<&OsString>) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(inherited) = inherited {
        dirs.extend(std::env::split_paths(inherited));
    }
    if let Some(home) = home {
        dirs.extend(HOME_BIN_DIRS.iter().map(|dir| home.join(dir)));
    }
    dirs.extend(SYSTEM_BIN_DIRS.iter().map(PathBuf::from));
    if let Some(home) = home {
        for (versions, suffix) in NODE_VERSION_DIRS {
            dirs.extend(version_bins(&home.join(versions), suffix));
        }
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    dirs.retain(|dir| {
        if !dir.is_absolute() || seen.contains(dir) {
            return false;
        }
        seen.push(dir.clone());
        true
    });
    std::env::join_paths(dirs).unwrap_or_default()
}

/// `<versions>/<v>/<suffix>` for every installed Node, newest version first
/// (numeric, so `v24.14.0` sorts above `v24.9.0`).
fn version_bins(versions: &Path, suffix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(versions) else {
        return Vec::new();
    };
    let mut names: Vec<OsString> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.file_name())
        .collect();
    names.sort_by_key(|name| std::cmp::Reverse(version_key(&name.to_string_lossy())));
    names
        .into_iter()
        .map(|name| versions.join(name).join(suffix))
        .collect()
}

fn version_key(name: &str) -> Vec<u64> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// PATH the app would use right now.
pub fn current_search_path() -> OsString {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    search_path(home.as_deref(), std::env::var_os("PATH").as_ref())
}

/// First executable file named `name` on `path`. `name` must be a bare file
/// name — a caller cannot smuggle a path through it.
pub fn find_on_path(name: &str, path: &OsString) -> Option<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return None;
    }
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(path: &OsString) -> Vec<PathBuf> {
        std::env::split_paths(path).collect()
    }

    #[test]
    fn inherited_first_then_install_folders_without_duplicates() {
        let home = Path::new("/Users/someone");
        let inherited = OsString::from("/usr/bin:/opt/homebrew/bin:relative/bin");
        let dirs = split(&search_path(Some(home), Some(&inherited)));
        assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
        assert_eq!(dirs[1], PathBuf::from("/opt/homebrew/bin"));
        assert!(dirs.contains(&home.join(".local/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert_eq!(
            dirs.iter()
                .filter(|d| d.as_path() == Path::new("/opt/homebrew/bin"))
                .count(),
            1
        );
        assert!(dirs.iter().all(|d| d.is_absolute()));
    }

    #[test]
    fn a_gui_launch_path_still_reaches_homebrew_and_local_bin() {
        let home = Path::new("/Users/someone");
        let launchd = OsString::from("/usr/bin:/bin:/usr/sbin:/sbin");
        let dirs = split(&search_path(Some(home), Some(&launchd)));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&home.join(".local/bin")));
        assert!(dirs.contains(&home.join(".local/share/fnm/aliases/default/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn finds_only_executable_files_by_bare_name() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("oort-2813-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nvm/v24.9.0/bin")).unwrap();
        std::fs::create_dir_all(dir.join("nvm/v24.14.0/bin")).unwrap();
        std::fs::create_dir_all(dir.join("nvm/v18.20.8/bin")).unwrap();
        let exe = dir.join("tool");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let plain = dir.join("plain");
        std::fs::write(&plain, "").unwrap();

        let path = std::env::join_paths([dir.clone()]).unwrap();
        assert_eq!(find_on_path("tool", &path), Some(exe));
        assert_eq!(find_on_path("plain", &path), None);
        assert_eq!(find_on_path("missing", &path), None);
        assert_eq!(find_on_path("../tool", &path), None);
        assert_eq!(find_on_path("", &path), None);

        assert_eq!(
            version_bins(&dir.join("nvm"), "bin"),
            vec![
                dir.join("nvm/v24.14.0/bin"),
                dir.join("nvm/v24.9.0/bin"),
                dir.join("nvm/v18.20.8/bin"),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
