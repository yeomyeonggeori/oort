//! Whether this host **requires** the owner's device signature (R2) — ADR-0146
//! 개정 D-10, 증보 2026-09-29 (#3117, E10 검수 B1).
//!
//! D-10 puts the security boundary on the host: a spawn, an input or an allow
//! the server inserts unsigned, or whose envelope it strips, is refused here.
//! That only holds while the host enforces it, so **what switches enforcement
//! on, and what can switch it off**, is itself part of the boundary.
//!
//! * **The owner's config** — `require_human_signatures: true` in `workd.json`
//!   — forces it on for as long as the file says so.
//! * **The server's word, latched.** `pending-controls` says whether the server
//!   requires signatures (`humanControlSignatureRequired`, the same
//!   `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` `signing-context` reports). The
//!   first answer that says `true` **while a root is pinned on this Mac** is
//!   written to `human-required.json` (0600, sibling + rename) **before** any
//!   control in that answer is looked at, and from then on the host requires
//!   signatures whatever the server says later. A server can only tighten the
//!   host this way — which it could do anyway by withholding controls — never
//!   loosen it (D-6: the server cannot change the host's trust).
//! * **No root, no latch.** Latched without a pinned root the host would
//!   refuse every signed spawn, input and allow and stop the owner's work; the
//!   server's `true` is then remembered in memory only (`serverRequired`) and
//!   reported, so the desktop app can say plainly that the server requires
//!   signatures and this Mac does not enforce them yet. The first poll after
//!   the app pins its root latches it.
//! * **Off only locally.** The latch is removed by the code-signed control
//!   socket's `reset_signature_requirement` (see [`crate::control_socket`]), or
//!   by `forget`/`register` (a new registration is a new host). Nothing on the
//!   server path reaches it. `reset-root` leaves it: a latched host without a
//!   root refuses until a root is pinned again, which is the intended order.
//! * **Unreadable is on.** A latch file that exists but cannot be read or
//!   parsed counts as latched (fail closed); resetting it locally clears it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{read_owned_file, write_private_file, ConfigError};

pub const REQUIRED_FILE: &str = "human-required.json";

/// Why the host requires signatures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredBy {
    /// `require_human_signatures: true` in the owner's config.
    Config,
    /// The server said so while a root was pinned; latched on disk.
    Server,
    /// A latch file this host cannot read. Treated as latched.
    Unreadable,
}

impl RequiredBy {
    pub fn label(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Server => "server",
            Self::Unreadable => "unreadable",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Latch {
    /// When this host latched it (host clock).
    since_ms: i64,
    /// `"server"` — the only way a latch is written today.
    source: String,
}

/// What [`SignatureRequirement::note_server`] did with the server's word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Noted {
    /// Nothing changed.
    Unchanged,
    /// Latched now.
    Latched,
    /// The server requires signatures but no root is pinned here: not latched.
    WaitingForRoot,
}

#[derive(Debug)]
pub struct SignatureRequirement {
    /// `None`: in memory only (tests, and a host whose state folder is gone).
    path: Option<PathBuf>,
    config: bool,
    latch: Option<Latch>,
    unreadable: bool,
    /// The last `humanControlSignatureRequired` the server sent. Memory only:
    /// the server's word is reported, never trusted to lower anything.
    server_required: Option<bool>,
}

impl SignatureRequirement {
    /// Read the latch kept in `state_dir`. A missing file is "not latched"; a
    /// file that is there but unreadable is latched (see the module docs).
    pub fn open(state_dir: &Path, config_required: bool) -> Self {
        let path = state_dir.join(REQUIRED_FILE);
        let (latch, unreadable) = match read_owned_file(&path) {
            Ok(raw) => match serde_json::from_str::<Latch>(&raw) {
                Ok(latch) => (Some(latch), false),
                Err(error) => {
                    tracing::error!(path = %path.display(), error = %error, "signature requirement unreadable; requiring signatures");
                    (None, true)
                }
            },
            Err(ConfigError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                (None, false)
            }
            Err(error) => {
                tracing::error!(path = %path.display(), error = %error, "signature requirement unreadable; requiring signatures");
                (None, true)
            }
        };
        Self {
            path: Some(path),
            config: config_required,
            latch,
            unreadable,
            server_required: None,
        }
    }

    /// Required from the start, nothing on disk (a test harness that turns R2
    /// on directly, as `require_human_signatures: true` does).
    pub fn forced() -> Self {
        Self {
            path: None,
            config: true,
            latch: None,
            unreadable: false,
            server_required: None,
        }
    }

    /// Not required and never latched on disk.
    pub fn off() -> Self {
        Self {
            path: None,
            config: false,
            latch: None,
            unreadable: false,
            server_required: None,
        }
    }

    pub fn required(&self) -> bool {
        self.required_by().is_some()
    }

    pub fn required_by(&self) -> Option<RequiredBy> {
        if self.config {
            Some(RequiredBy::Config)
        } else if self.latch.is_some() {
            Some(RequiredBy::Server)
        } else if self.unreadable {
            Some(RequiredBy::Unreadable)
        } else {
            None
        }
    }

    pub fn latched_since_ms(&self) -> Option<i64> {
        self.latch.as_ref().map(|latch| latch.since_ms)
    }

    pub fn server_required(&self) -> Option<bool> {
        self.server_required
    }

    /// The server's word from one `pending-controls` answer. `true` with a
    /// pinned root latches it (written before this returns); `false` changes
    /// nothing but the report.
    pub fn note_server(
        &mut self,
        server_required: bool,
        root_pinned: bool,
        now_ms: i64,
    ) -> Result<Noted, ConfigError> {
        let first_word = self.server_required != Some(server_required);
        self.server_required = Some(server_required);
        if !server_required || self.latch.is_some() {
            return Ok(Noted::Unchanged);
        }
        if !root_pinned {
            if first_word {
                tracing::warn!(
                    "the server requires device signatures, but no root is pinned on this Mac: \
                     not enforcing them until the desktop app pins its root"
                );
            }
            return Ok(Noted::WaitingForRoot);
        }
        let latch = Latch {
            since_ms: now_ms,
            source: RequiredBy::Server.label().to_string(),
        };
        if let Some(path) = &self.path {
            let mut body = serde_json::to_vec_pretty(&latch).expect("latch serialises");
            body.push(b'\n');
            write_private_file(path, &body)?;
        }
        self.latch = Some(latch);
        self.unreadable = false;
        tracing::info!("R2 latched: the server requires device signatures and a root is pinned; this host now requires them whatever the server says later");
        Ok(Noted::Latched)
    }

    /// Local reset (the code-signed control socket only): forget the latch.
    /// The owner's config, if it says `true`, still holds.
    pub fn reset(&mut self) -> Result<(), ConfigError> {
        if let Some(path) = &self.path {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(ConfigError::Io {
                        path: path.display().to_string(),
                        source,
                    })
                }
            }
        }
        self.latch = None;
        self.unreadable = false;
        tracing::warn!("R2 latch reset locally; the host requires signatures again only when the server says so (with a root pinned) or the config does");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("momo-req-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn the_server_latches_it_only_with_a_root_and_never_lowers_it() {
        let dir = folder();
        let mut req = SignatureRequirement::open(&dir, false);
        assert_eq!(req.required_by(), None);

        // No root: reported, not latched, nothing written.
        assert_eq!(
            req.note_server(true, false, 1).unwrap(),
            Noted::WaitingForRoot
        );
        assert!(!req.required());
        assert_eq!(req.server_required(), Some(true));
        assert!(!dir.join(REQUIRED_FILE).exists());

        // A root: latched and on disk.
        assert_eq!(req.note_server(true, true, 2).unwrap(), Noted::Latched);
        assert_eq!(req.required_by(), Some(RequiredBy::Server));
        assert!(dir.join(REQUIRED_FILE).exists());

        // The server takes it back: still required, here and after a restart.
        assert_eq!(req.note_server(false, true, 3).unwrap(), Noted::Unchanged);
        assert!(req.required());
        assert_eq!(req.server_required(), Some(false));
        let reopened = SignatureRequirement::open(&dir, false);
        assert_eq!(reopened.required_by(), Some(RequiredBy::Server));
        assert_eq!(reopened.latched_since_ms(), Some(2));

        // Only the local reset lowers it.
        let mut reopened = reopened;
        reopened.reset().unwrap();
        assert!(!reopened.required());
        assert!(!SignatureRequirement::open(&dir, false).required());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unreadable_latch_requires_and_the_config_cannot_be_reset() {
        let dir = folder();
        std::fs::write(dir.join(REQUIRED_FILE), b"not json").unwrap();
        std::fs::set_permissions(
            dir.join(REQUIRED_FILE),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let mut req = SignatureRequirement::open(&dir, false);
        assert_eq!(req.required_by(), Some(RequiredBy::Unreadable));
        req.reset().unwrap();
        assert!(!req.required());

        let mut forced = SignatureRequirement::open(&dir, true);
        forced.reset().unwrap();
        assert_eq!(forced.required_by(), Some(RequiredBy::Config));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
