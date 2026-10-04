//! The one door through which the box-agent touches the filesystem
//! (ADR-0197 D4.5): **a harness login is never opened by the agent.**
//!
//! `~/.claude/…`, `~/.codex/auth.json`, the credential directory and every
//! file that looks like a login are refused here, after symlinks and `..` are
//! resolved, and re-checked on the descriptor that was actually opened. The
//! agent's own state (nonce store, owner list) goes through [`FsGate::read`] /
//! [`FsGate::write_private`]; `tests/fs_discipline.rs` reads the source and
//! fails if any other module opens a file by itself.
//!
//! The kernel is the first wall (the credential directory belongs to the
//! person's uid and is `0700`; the agent's uid cannot open it). This gate is
//! the second: a mistake in the agent's own code cannot become a read of a
//! login, which is the property ADR-0197 asks a test to lock.

use std::ffi::OsStr;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Component, Path, PathBuf};

/// Largest file the agent reads through the gate (its own small state).
pub const MAX_READ: u64 = 1 << 20;

/// File names that are a login or a private key wherever they sit.
pub const DENIED_NAMES: &[&str] = &[
    ".credentials.json",
    "auth.json",
    ".claude.json",
    ".netrc",
    "id_rsa",
    "id_ed25519",
];

/// Directory names (anywhere in the path) that hold a harness login.
pub const DENIED_DIR_NAMES: &[&str] = &[".claude", ".codex", ".ssh"];

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("refused: {0} is a credential path (ADR-0197 D4.5)")]
    Refused(String),
    #[error("refused: {0} is not an absolute path without '..'")]
    BadPath(String),
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("refused: {0} is larger than the agent ever reads")]
    TooLarge(String),
}

#[derive(Debug, Clone)]
pub struct FsGate {
    deny_roots: Vec<PathBuf>,
}

/// Lexical normalisation: absolute, no `..`, no `.`. Never touches the disk.
fn lexical(path: &Path) -> Result<PathBuf, FsError> {
    if !path.is_absolute() {
        return Err(FsError::BadPath(path.display().to_string()));
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(FsError::BadPath(path.display().to_string())),
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// `path` with its deepest existing ancestor resolved through symlinks, so a
/// link out of an allowed folder into a denied one is seen for what it is.
fn resolve(path: &Path) -> PathBuf {
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut probe = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(probe) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (probe.parent(), probe.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                probe = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

fn names_a_credential(path: &Path) -> bool {
    let lower = |s: &OsStr| s.to_string_lossy().to_ascii_lowercase();
    let file_denied = path
        .file_name()
        .is_some_and(|n| DENIED_NAMES.contains(&lower(n).as_str()));
    let dir_denied = path.components().any(|c| match c {
        Component::Normal(n) => DENIED_DIR_NAMES.contains(&lower(n).as_str()),
        _ => false,
    });
    file_denied || dir_denied
}

impl FsGate {
    /// Gate with explicit credential roots (tests, and [`Self::for_box`]).
    pub fn new(deny_roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            deny_roots: deny_roots.into_iter().filter(|p| p.is_absolute()).collect(),
        }
    }

    /// The box's gate: the credential directory, both harness config
    /// directories as the environment names them, and the person's whole home.
    pub fn for_box(get: &dyn Fn(&str) -> Option<String>, home: &str) -> Self {
        let mut roots: Vec<PathBuf> = vec![PathBuf::from("/cred"), PathBuf::from(home)];
        for name in ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
            if let Some(dir) = get(name).filter(|v| !v.is_empty()) {
                roots.push(PathBuf::from(dir));
            }
        }
        Self::new(roots)
    }

    pub fn deny_roots(&self) -> &[PathBuf] {
        &self.deny_roots
    }

    fn denied(&self, path: &Path) -> bool {
        if names_a_credential(path) {
            return true;
        }
        self.deny_roots.iter().any(|root| {
            path.starts_with(root) || {
                let real_root = resolve(root);
                path.starts_with(&real_root)
            }
        })
    }

    /// Refuse a credential path. Checks the path as written and as it resolves.
    pub fn check(&self, path: &Path) -> Result<PathBuf, FsError> {
        let written = lexical(path)?;
        let resolved = resolve(&written);
        if self.denied(&written) || self.denied(&resolved) {
            return Err(FsError::Refused(path.display().to_string()));
        }
        Ok(resolved)
    }

    /// The path of the descriptor the kernel actually opened (Linux:
    /// `/proc/self/fd`, macOS: `F_GETPATH`), re-checked: a link swapped in
    /// between the check and the open still lands on a denied path here.
    fn opened_path(file: &std::fs::File) -> Option<PathBuf> {
        use std::os::fd::AsRawFd as _;
        #[cfg(target_os = "linux")]
        {
            std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
        }
        #[cfg(target_os = "macos")]
        {
            let mut buf = [0u8; libc::PATH_MAX as usize];
            // SAFETY: F_GETPATH writes a NUL-terminated path of at most
            // PATH_MAX bytes into the buffer we pass.
            let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
            if rc < 0 {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0)?;
            Some(PathBuf::from(
                std::str::from_utf8(&buf[..end]).ok()?.to_string(),
            ))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = file;
            None
        }
    }

    fn io(path: &Path, source: std::io::Error) -> FsError {
        FsError::Io {
            path: path.display().to_string(),
            source,
        }
    }

    /// Read a small regular file, `O_NOFOLLOW`, checked before and after open.
    pub fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        let target = self.check(path)?;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&target)
            .map_err(|e| Self::io(path, e))?;
        if let Some(real) = Self::opened_path(&file) {
            if self.denied(&real) {
                return Err(FsError::Refused(path.display().to_string()));
            }
        }
        let metadata = file.metadata().map_err(|e| Self::io(path, e))?;
        if !metadata.file_type().is_file() {
            return Err(FsError::BadPath(path.display().to_string()));
        }
        if metadata.len() > MAX_READ {
            return Err(FsError::TooLarge(path.display().to_string()));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        (&mut file)
            .take(MAX_READ)
            .read_to_end(&mut bytes)
            .map_err(|e| Self::io(path, e))?;
        Ok(bytes)
    }

    /// Write the agent's own state: a sibling created `O_EXCL` `0600`, synced,
    /// renamed into place. The folder must already exist.
    pub fn write_private(&self, path: &Path, bytes: &[u8]) -> Result<(), FsError> {
        let target = self.check(path)?;
        let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temporary)
            .map_err(|e| Self::io(path, e))?;
        let written = file
            .write_all(bytes)
            .and_then(|()| file.sync_all())
            .and_then(|()| {
                std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            });
        drop(file);
        if let Err(e) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(Self::io(path, e));
        }
        std::fs::rename(&temporary, &target).map_err(|e| {
            let _ = std::fs::remove_file(&temporary);
            Self::io(path, e)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "momo-box-agent-{tag}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            // macOS /tmp is a symlink: work on the real path.
            Self(std::fs::canonicalize(dir).unwrap())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn gate_for(s: &Scratch) -> (FsGate, PathBuf, PathBuf) {
        let cred = s.0.join("cred");
        let home = s.0.join("home");
        std::fs::create_dir_all(cred.join("claude")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let get = |n: &str| match n {
            "CLAUDE_CONFIG_DIR" => Some(cred.join("claude").display().to_string()),
            "CODEX_HOME" => Some(cred.join("codex").display().to_string()),
            _ => None,
        };
        let gate = FsGate::for_box(&get, &home.display().to_string());
        (gate, cred, home)
    }

    #[test]
    fn credential_directories_and_names_are_refused() {
        let s = Scratch::new("deny");
        let (gate, cred, home) = gate_for(&s);
        std::fs::write(cred.join("claude/.credentials.json"), b"{\"marker\":1}").unwrap();
        for path in [
            cred.join("claude/.credentials.json"),
            cred.join("codex/auth.json"),
            cred.join("claude/anything-at-all"),
            cred.join("codex/anything-at-all"),
            home.join(".claude/settings.json"),
            home.join(".codex/auth.json"),
            home.join("notes.txt"),
            s.0.join("elsewhere/.ssh/id_rsa"),
            s.0.join("elsewhere/auth.json"),
            s.0.join("elsewhere/.claude.json"),
        ] {
            assert!(
                matches!(gate.read(&path), Err(FsError::Refused(_))),
                "{} must be refused",
                path.display()
            );
            assert!(matches!(gate.check(&path), Err(FsError::Refused(_))));
            assert!(matches!(
                gate.write_private(&path, b"x"),
                Err(FsError::Refused(_))
            ));
        }
    }

    #[test]
    fn dotdot_symlinks_and_case_do_not_get_around_the_gate() {
        let s = Scratch::new("bypass");
        let (gate, cred, _home) = gate_for(&s);
        let state = s.0.join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(cred.join("claude/secret.txt"), b"marker").unwrap();
        // `..` is not even normalised: it is refused as a bad path.
        let via_dotdot = state.join("../cred/claude/secret.txt");
        assert!(matches!(gate.read(&via_dotdot), Err(FsError::BadPath(_))));
        // A link from allowed state into the credential directory.
        symlink(cred.join("claude"), state.join("link")).unwrap();
        assert!(matches!(
            gate.read(&state.join("link/secret.txt")),
            Err(FsError::Refused(_))
        ));
        // A link to a file, named innocently.
        symlink(cred.join("claude/secret.txt"), state.join("innocent.txt")).unwrap();
        assert!(matches!(
            gate.read(&state.join("innocent.txt")),
            Err(FsError::Refused(_))
        ));
        // The credential directory itself reached through a symlinked root.
        let alias = s.0.join("alias");
        symlink(&cred, &alias).unwrap();
        assert!(matches!(
            gate.read(&alias.join("claude/secret.txt")),
            Err(FsError::Refused(_))
        ));
        // Case games on a name.
        assert!(matches!(
            gate.read(&state.join("AUTH.JSON")),
            Err(FsError::Refused(_))
        ));
        assert!(matches!(
            gate.read(Path::new("relative/file")),
            Err(FsError::BadPath(_))
        ));
    }

    #[test]
    fn the_agents_own_state_passes_and_round_trips_private() {
        let s = Scratch::new("state");
        let (gate, _cred, _home) = gate_for(&s);
        let state = s.0.join("state");
        std::fs::create_dir_all(&state).unwrap();
        let file = state.join("nonces.bin");
        gate.write_private(&file, b"abc").unwrap();
        assert_eq!(gate.read(&file).unwrap(), b"abc");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(matches!(
            gate.read(&state.join("missing")),
            Err(FsError::Io { .. })
        ));
    }

    #[test]
    fn an_oversized_file_is_refused_not_slurped() {
        let s = Scratch::new("big");
        let (gate, _c, _h) = gate_for(&s);
        let file = s.0.join("big.bin");
        std::fs::write(&file, vec![0u8; (MAX_READ + 1) as usize]).unwrap();
        assert!(matches!(gate.read(&file), Err(FsError::TooLarge(_))));
    }
}
