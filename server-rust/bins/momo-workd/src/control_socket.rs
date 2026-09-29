//! The app ↔ workd channel (ADR-0188 D2, #2778): a user-only Unix socket and
//! the peer's code signature. Nothing else — **no TCP, not even loopback**.
//!
//! The desktop app starts `momo-workd run --control-socket <path>` as its
//! child and asks it a few things over this socket: `status` (who this host is
//! and whether the server is taking its heartbeat), `shutdown`, and — R2,
//! ADR-0146 개정 D-6·D-7 (#3024) — `pin_root` (hand over the public half of
//! the app's Secure Enclave key, once) and `revoke_device` (a root-signed
//! revocation, so a revocation the server hides still lands). Controls,
//! sessions and private keys never cross it. The root is pinned **only** here:
//! a second, different public key is refused, and only a local `momo-workd
//! reset-root` clears it; nothing on the server path can reach it. The same
//! public key under a new key id (a re-login, #3078) is rebound here too —
//! and only here.
//!
//! `status` also says whether the host **requires** device signatures, why,
//! and what the server last said (#3117, [`crate::signature_requirement`]):
//! the server can latch the requirement on but never off. The latch is lowered
//! only here, by `reset_signature_requirement` — a local, explicit act of the
//! code-signed app. It does not touch the pinned root (`reset-root` is a CLI
//! command, not an op).
//!
//! ## Who may connect
//!
//! Three fences, each checked for every connection:
//!
//! 1. **the folder** — the socket's parent folder is this user's and nobody
//!    else can enter it (`mode & 0o077 == 0`). Checked at bind; the socket
//!    itself is `0600`.
//! 2. **the user** — `getpeereid` says the peer runs as this user.
//! 3. **the code signature** (macOS) — the peer's code, identified by its
//!    **audit token** (`LOCAL_PEERTOKEN`, not the pid, which can be reused
//!    between the check and the use), must satisfy
//!    `anchor apple generic and identifier "app.momo.desktop" and
//!    certificate leaf[subject.OU] = "<this binary's team>"`. The team is read
//!    from **this** binary's own signature, so the rule needs no configuration
//!    that a same-user process could rewrite.
//!
//! A workd that carries no team signature (a local development build) cannot
//! form that rule and refuses every peer, unless it was started with
//! `--dev-unsigned-peer`: then fences 1–2 still hold and fence 3 is skipped with
//! a warning. A **signed** workd refuses that flag at start, so the flag can
//! never loosen a shipped binary.
//!
//! ## Wire
//!
//! One JSON line in, one JSON line out, then the connection closes. A request
//! is at most [`MAX_REQUEST_BYTES`] and must arrive within
//! [`REQUEST_TIMEOUT`].
//!
//! ```text
//! → {"op":"status"}
//! ← {"ok":true,"hostId":"…","workspaceId":"…","ownerMemberId":"…",
//!    "version":"…","heartbeat":{"lastOkAtMs":…,"lastAttemptAtMs":…,"failing":false},
//!    "humanSignatures":{"required":bool,"requiredBy":"config"|"server"|"unreadable"|null,
//!       "latchedSinceMs":…|null,"latchSaved":bool,"serverRequired":bool|null,
//!       "rootKeyId":…|null,"rootPublicKey":…|null}}
//!   `serverRequired: true` with `required: false` is the half state: the
//!   server requires signatures and this host does not enforce them yet (no
//!   root pinned). It latches on the first poll after `pin_root`.
//! → {"op":"shutdown"}
//! ← {"ok":true}
//! → {"op":"pin_root","keyId":"…","alg":"p256","publicKey":"<b64 33-byte SEC1>"}
//! ← {"ok":true,"pinned":true}        (false: the same key and id were already pinned;
//!                                     true also when the same key moved to a new id, #3078)
//! ← {"ok":false,"error":"root_already_pinned"}     (another public key)
//! ← {"ok":false,"error":"root_key_id_retired"}     (an id this key held before)
//! → {"op":"revoke_device","revocation":{"workspaceId","memberId","rootKeyId",
//!    "targetKeyId","revokedAtMs","signature","targetPublicKey"}}
//! ← {"ok":true}
//! → {"op":"reset_signature_requirement"}
//! ← {"ok":true,"required":bool}   (still true when the owner's config says so)
//! → {"op":"prepare_remote_profile","harness":"claude"|"codex","label":"<label>"}
//! ← {"ok":true,"path":"<state>/profiles/<harness>/<label>"}   (#3033: makes the
//!    A lane profile folder `0700` — or finds it — and returns the exact path the
//!    app signs the official CLI in to as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`)
//! → {"op":"set_remote_profile","harness":"claude"|"codex","label":"<label>"|null}
//! ← {"ok":true,"reset":bool}     (#3033: this Mac's 「원격 작업」 account — the profile folder
//!                    remote sessions of that harness run as; `null` clears it.
//!                    `reset: true`: the choice file was unreadable and the clear
//!                    reset every harness to no choice)
//! ← {"ok":false,"error":"invalid_request"|"unknown_harness"|"invalid_label"|
//!                       "profile_not_found"|"profile_refused"|"profiles_unavailable"}
//! ```

use std::io;
use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};
use std::os::unix::io::{AsRawFd as _, RawFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

pub use crate::controls::{HostHealth, SocketShared};

/// The desktop app's code-signing identifier (its bundle id). The only program
/// whose connections workd answers.
pub const APP_SIGNING_IDENTIFIER: &str = "app.momo.desktop";

/// Longest request line accepted.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024;

/// How long a connected peer has to send its one line.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// `sockaddr_un.sun_path` is 104 bytes on macOS, including the NUL.
const MAX_SOCKET_PATH_BYTES: usize = 103;

#[derive(Debug, thiserror::Error)]
pub enum ControlSocketError {
    #[error("control socket {path}: {detail}")]
    Unsafe { path: String, detail: String },
    #[error("another momo-workd already answers on {0}")]
    AlreadyRunning(String),
    #[error("control socket {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    Policy(String),
}

/// Why a connection was closed without an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PeerRefusal {
    #[error("the peer runs as uid {peer}, not {own}")]
    OtherUser { peer: u32, own: u32 },
    #[error("the peer's code signature does not satisfy {requirement}: {detail}")]
    Signature { requirement: String, detail: String },
    #[error("this momo-workd is not team-signed, so it cannot check a peer's signature; refused (development builds pass --dev-unsigned-peer)")]
    UnsignedSelf,
    #[error("peer credentials unavailable: {0}")]
    Credentials(String),
}

/// How peers are judged, fixed at start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerPolicy {
    /// This binary is team-signed: the peer must be the desktop app signed by
    /// the same team.
    SameTeamApp { requirement: String },
    /// Unsigned development build started with `--dev-unsigned-peer`: the
    /// folder and user fences only.
    DevUnsigned,
    /// Unsigned and no flag: nobody is answered.
    RefuseAll,
}

impl PeerPolicy {
    /// Decide the policy from this binary's own signature.
    ///
    /// `own_team` is `None` for an unsigned or ad-hoc signed binary.
    pub fn decide(own_team: Option<&str>, dev_unsigned_peer: bool) -> Result<Self, String> {
        match (own_team, dev_unsigned_peer) {
            (Some(_), true) => Err(
                "--dev-unsigned-peer is for unsigned development builds; this momo-workd is \
                 team-signed and checks its peer's signature"
                    .to_string(),
            ),
            (Some(team), false) => Ok(Self::SameTeamApp {
                requirement: app_requirement(team)?,
            }),
            (None, true) => Ok(Self::DevUnsigned),
            (None, false) => Ok(Self::RefuseAll),
        }
    }

    /// The policy for the binary that is running.
    pub fn for_this_binary(dev_unsigned_peer: bool) -> Result<Self, String> {
        let team = signing::own_team_identifier()?;
        Self::decide(team.as_deref(), dev_unsigned_peer)
    }
}

/// This binary's team id (`None` when unsigned or ad-hoc signed).
pub fn own_team_identifier() -> Result<Option<String>, String> {
    signing::own_team_identifier()
}

/// The code requirement a peer must satisfy. The team id is Apple's ten
/// upper-case letters and digits; anything else is refused rather than
/// spliced into requirement language.
pub fn app_requirement(team: &str) -> Result<String, String> {
    let valid = team.len() == 10
        && team
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !valid {
        return Err(format!(
            "unexpected team identifier {team:?} in own signature"
        ));
    }
    Ok(format!(
        "anchor apple generic and identifier \"{APP_SIGNING_IDENTIFIER}\" and \
         certificate leaf[subject.OU] = \"{team}\""
    ))
}

/// Who this host is, as `status` reports it.
#[derive(Debug, Clone)]
pub struct HostIdentity {
    pub host_id: Uuid,
    pub workspace_id: Uuid,
    pub owner_member_id: Uuid,
}

/// A bound control socket. Dropping it removes the socket file.
pub struct ControlSocket {
    path: PathBuf,
    listener: UnixListener,
    policy: PeerPolicy,
}

impl Drop for ControlSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The parent folder must be this user's and closed to everyone else.
fn check_socket_folder(path: &Path) -> Result<(), ControlSocketError> {
    let refuse = |detail: String| ControlSocketError::Unsafe {
        path: path.display().to_string(),
        detail,
    };
    if !path.is_absolute() {
        return Err(refuse("must be an absolute path".into()));
    }
    if path.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
        return Err(refuse(format!(
            "longer than {MAX_SOCKET_PATH_BYTES} bytes (sun_path)"
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| refuse("has no parent folder".into()))?;
    let metadata = std::fs::symlink_metadata(parent).map_err(|source| ControlSocketError::Io {
        path: parent.display().to_string(),
        source,
    })?;
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    if !metadata.file_type().is_dir() {
        return Err(refuse("its folder is not a directory".into()));
    }
    if metadata.uid() != uid {
        return Err(refuse(format!(
            "its folder is owned by uid {}, not {uid}",
            metadata.uid()
        )));
    }
    let mode = metadata.mode() & 0o7777;
    if mode & 0o077 != 0 {
        return Err(refuse(format!(
            "its folder (mode {mode:04o}) is open to other users; it must be 0700"
        )));
    }
    Ok(())
}

impl ControlSocket {
    /// Bind `path` after the folder check. A stale socket left by a crashed run
    /// is replaced; a live one means another workd is running.
    pub fn bind(path: &Path, policy: PeerPolicy) -> Result<Self, ControlSocketError> {
        check_socket_folder(path)?;
        let io_error = |source: io::Error| ControlSocketError::Io {
            path: path.display().to_string(),
            source,
        };
        match std::fs::symlink_metadata(path) {
            Ok(existing) => {
                if !existing.file_type().is_socket() {
                    return Err(ControlSocketError::Unsafe {
                        path: path.display().to_string(),
                        detail: "exists and is not a socket".into(),
                    });
                }
                if std::os::unix::net::UnixStream::connect(path).is_ok() {
                    return Err(ControlSocketError::AlreadyRunning(
                        path.display().to_string(),
                    ));
                }
                std::fs::remove_file(path).map_err(io_error)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        let listener = UnixListener::bind(path).map_err(io_error)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(io_error)?;
        Ok(Self {
            path: path.to_path_buf(),
            listener,
            policy,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Answer connections until the task is dropped. `shutdown` is signalled
    /// through `stop`.
    pub async fn serve(self, identity: HostIdentity, shared: SocketShared) {
        let this = Arc::new(self);
        loop {
            let stream = match this.listener.accept().await {
                Ok((stream, _)) => stream,
                Err(error) => {
                    tracing::warn!(error = %error, "control socket accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let (this, identity, shared) = (this.clone(), identity.clone(), shared.clone());
            tokio::spawn(async move {
                if let Err(refusal) = check_peer(stream.as_raw_fd(), &this.policy) {
                    tracing::warn!(refusal = %refusal, "control socket peer refused");
                    return;
                }
                answer(stream, &identity, &shared).await;
            });
        }
    }
}

/// Fences 2 and 3 for one connection.
pub fn check_peer(fd: RawFd, policy: &PeerPolicy) -> Result<(), PeerRefusal> {
    let mut peer_uid: libc::uid_t = 0;
    let mut peer_gid: libc::gid_t = 0;
    // SAFETY: `fd` is a connected socket owned by the caller; both out
    // pointers are valid for the call.
    let status = unsafe { libc::getpeereid(fd, &mut peer_uid, &mut peer_gid) };
    if status != 0 {
        return Err(PeerRefusal::Credentials(
            io::Error::last_os_error().to_string(),
        ));
    }
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let own = unsafe { libc::geteuid() };
    if peer_uid != own {
        return Err(PeerRefusal::OtherUser {
            peer: peer_uid,
            own,
        });
    }
    match policy {
        PeerPolicy::RefuseAll => Err(PeerRefusal::UnsignedSelf),
        PeerPolicy::DevUnsigned => {
            tracing::warn!(
                "control socket peer accepted WITHOUT a code-signature check \
                 (--dev-unsigned-peer, development build)"
            );
            Ok(())
        }
        PeerPolicy::SameTeamApp { requirement } => signing::check_peer_signature(fd, requirement),
    }
}

async fn answer(stream: UnixStream, identity: &HostIdentity, shared: &SocketShared) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read.take_limited());
    let mut line = String::new();
    let read = tokio::time::timeout(REQUEST_TIMEOUT, reader.read_line(&mut line)).await;
    let response = match read {
        Ok(Ok(_)) if line.ends_with('\n') => respond(line.trim_end(), identity, shared),
        Ok(Ok(_)) => json!({"ok": false, "error": "request_too_long_or_unterminated"}),
        Ok(Err(_)) => return,
        Err(_) => json!({"ok": false, "error": "timeout"}),
    };
    let mut out = response.to_string();
    out.push('\n');
    let _ = write.write_all(out.as_bytes()).await;
    let _ = write.shutdown().await;
}

/// Limit how much a peer can make us buffer.
trait TakeLimited: Sized {
    fn take_limited(self) -> tokio::io::Take<Self>;
}

impl TakeLimited for tokio::net::unix::OwnedReadHalf {
    fn take_limited(self) -> tokio::io::Take<Self> {
        tokio::io::AsyncReadExt::take(self, MAX_REQUEST_BYTES as u64)
    }
}

/// One request → one response. Testable without a socket.
pub fn respond(line: &str, identity: &HostIdentity, shared: &SocketShared) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return json!({"ok": false, "error": "invalid_json"}),
    };
    let lock_trust = || shared.trust.lock().unwrap_or_else(|p| p.into_inner());
    match request.get("op").and_then(Value::as_str) {
        Some("status") => {
            let heartbeat = shared.health.snapshot();
            let requirement = shared.requirement.lock().unwrap_or_else(|p| p.into_inner());
            let (root_key_id, root_public_key) = lock_trust()
                .root()
                .map(|root| (root.key_id, root.public_key.clone()))
                .unzip();
            json!({
                "ok": true,
                "hostId": identity.host_id,
                "workspaceId": identity.workspace_id,
                "ownerMemberId": identity.owner_member_id,
                "version": env!("CARGO_PKG_VERSION"),
                "heartbeat": {
                    "lastOkAtMs": heartbeat.last_ok_ms,
                    "lastAttemptAtMs": heartbeat.last_attempt_ms,
                    "failing": heartbeat.failing,
                },
                "humanSignatures": {
                    "required": requirement.required(),
                    "requiredBy": requirement.required_by().map(|by| by.label()),
                    "latchedSinceMs": requirement.latched_since_ms(),
                    "latchSaved": requirement.latch_saved(),
                    "serverRequired": requirement.server_required(),
                    "rootKeyId": root_key_id,
                    // The pin's identity (#3078): the app compares this, not
                    // the id, to tell a re-login from another key.
                    "rootPublicKey": root_public_key,
                },
            })
        }
        Some("shutdown") => {
            shared.stop.notify_one();
            json!({"ok": true})
        }
        Some("pin_root") => {
            let (Some(key_id), Some(alg), Some(public_key)) = (
                request
                    .get("keyId")
                    .and_then(Value::as_str)
                    .and_then(|raw| Uuid::parse_str(raw).ok()),
                request.get("alg").and_then(Value::as_str),
                request.get("publicKey").and_then(Value::as_str),
            ) else {
                return json!({"ok": false, "error": "invalid_root_key"});
            };
            match lock_trust().pin_root(key_id, alg, public_key, crate::client::now_ms()) {
                Ok(pinned) => {
                    shared.grants.retire_all();
                    json!({"ok": true, "pinned": pinned})
                }
                Err(error) => json!({"ok": false, "error": error}),
            }
        }
        Some("revoke_device") => {
            let Some(revocation) = request.get("revocation") else {
                return json!({"ok": false, "error": "invalid_revocation"});
            };
            match lock_trust()
                .apply_revocation(revocation, crate::human_trust::RevocationSource::LocalApp)
            {
                Ok(()) => {
                    shared.grants.retire_all();
                    json!({"ok": true})
                }
                Err(error) => json!({"ok": false, "error": error}),
            }
        }
        Some("set_remote_profile") => {
            let (Some(harness), label) = (
                request.get("harness").and_then(Value::as_str),
                request.get("label"),
            ) else {
                return json!({"ok": false, "error": "invalid_request"});
            };
            // A label, or an explicit `null` to clear; anything else (a
            // missing key, a number) is not a choice.
            let label = match label {
                Some(Value::String(label)) => Some(label.as_str()),
                Some(Value::Null) => None,
                _ => return json!({"ok": false, "error": "invalid_request"}),
            };
            match crate::profile::RemoteProfiles::set(&shared.state_folder, harness, label) {
                // `reset: true` — the choice file was unreadable and clearing
                // reset every harness to no choice; the app tells the person.
                Ok(reset) => json!({"ok": true, "reset": reset}),
                Err(error) => json!({"ok": false, "error": error.label()}),
            }
        }
        Some("prepare_remote_profile") => {
            let (Some(harness), Some(label)) = (
                request.get("harness").and_then(Value::as_str),
                request.get("label").and_then(Value::as_str),
            ) else {
                return json!({"ok": false, "error": "invalid_request"});
            };
            match crate::profile::prepare(&shared.state_folder, harness, label) {
                Ok(path) => json!({"ok": true, "path": path.display().to_string()}),
                Err(error) => json!({"ok": false, "error": error.label()}),
            }
        }
        Some("reset_signature_requirement") => {
            let mut requirement = shared.requirement.lock().unwrap_or_else(|p| p.into_inner());
            match requirement.reset() {
                Ok(()) => {
                    shared.grants.retire_all();
                    json!({"ok": true, "required": requirement.required()})
                }
                Err(error) => {
                    tracing::error!(error = %error, "could not reset the signature requirement");
                    json!({"ok": false, "error": "requirement_unavailable"})
                }
            }
        }
        _ => json!({"ok": false, "error": "unknown_op"}),
    }
}

mod signing {
    //! The two Security.framework questions: "what team signed me?" and "does
    //! the process behind this audit token satisfy this requirement?".

    use std::ffi::c_void;
    use std::os::unix::io::RawFd;
    use std::str::FromStr as _;

    use core_foundation::base::TCFType as _;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::CFStringRef;
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };

    use super::PeerRefusal;

    /// `kSecCSSigningInformation` (`CSCommon.h`).
    const K_SEC_CS_SIGNING_INFORMATION: u32 = 1 << 1;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecCodeInfoTeamIdentifier: CFStringRef;
        fn SecCodeCopySigningInformation(
            code: *const c_void,
            flags: u32,
            information: *mut CFDictionaryRef,
        ) -> i32;
    }

    /// This binary's team id, or `None` when it has none (unsigned/ad-hoc).
    pub fn own_team_identifier() -> Result<Option<String>, String> {
        let code = SecCode::for_self(Flags::empty())
            .map_err(|error| format!("SecCodeCopySelf: {error}"))?;
        let mut info: CFDictionaryRef = std::ptr::null();
        // SAFETY: `code` is a live SecCode (a SecStaticCode-compatible ref, as
        // Apple documents for this call); `info` is a valid out pointer and,
        // on success, holds a +1 dictionary we take ownership of below.
        let status = unsafe {
            SecCodeCopySigningInformation(
                code.as_concrete_TypeRef() as *const c_void,
                K_SEC_CS_SIGNING_INFORMATION,
                &mut info,
            )
        };
        if status != 0 || info.is_null() {
            return Err(format!("SecCodeCopySigningInformation: OSStatus {status}"));
        }
        // SAFETY: created by the call above (Copy rule).
        let info: CFDictionary = unsafe { CFDictionary::wrap_under_create_rule(info) };
        // SAFETY: an immutable framework constant.
        let key = unsafe { kSecCodeInfoTeamIdentifier };
        let Some(value) = info.find(key as *const c_void) else {
            return Ok(None);
        };
        // SAFETY: the Security framework documents this value as a CFString.
        let team = unsafe { CFString::wrap_under_get_rule(*value as CFStringRef) };
        let team = team.to_string();
        Ok((!team.is_empty()).then_some(team))
    }

    /// `audit_token_t` is eight 32-bit words.
    const AUDIT_TOKEN_BYTES: usize = 32;

    pub fn check_peer_signature(fd: RawFd, requirement: &str) -> Result<(), PeerRefusal> {
        let mut token = [0u8; AUDIT_TOKEN_BYTES];
        let mut length = AUDIT_TOKEN_BYTES as libc::socklen_t;
        // SAFETY: `fd` is a connected AF_UNIX socket; `token` is writable for
        // `length` bytes.
        let status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != 0 || length as usize != AUDIT_TOKEN_BYTES {
            return Err(PeerRefusal::Credentials(format!(
                "LOCAL_PEERTOKEN: {}",
                std::io::Error::last_os_error()
            )));
        }
        let refuse = |detail: String| PeerRefusal::Signature {
            requirement: requirement.to_string(),
            detail,
        };
        let requirement_ref =
            SecRequirement::from_str(requirement).map_err(|error| refuse(error.to_string()))?;
        let token = CFData::from_buffer(&token);
        let mut attributes = GuestAttributes::new();
        attributes.set_audit_token(token.as_concrete_TypeRef());
        let guest = SecCode::copy_guest_with_attribues(None, &attributes, Flags::empty())
            .map_err(|error| refuse(format!("no code for the peer: {error}")))?;
        guest
            .check_validity(Flags::empty(), &requirement_ref)
            .map_err(|error| refuse(error.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> HostIdentity {
        HostIdentity {
            host_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            owner_member_id: Uuid::from_u128(3),
        }
    }

    #[test]
    fn the_policy_follows_the_binarys_own_signature() {
        assert_eq!(
            PeerPolicy::decide(None, false).unwrap(),
            PeerPolicy::RefuseAll
        );
        assert_eq!(
            PeerPolicy::decide(None, true).unwrap(),
            PeerPolicy::DevUnsigned
        );
        assert!(
            PeerPolicy::decide(Some("ABCDE12345"), true).is_err(),
            "a signed workd refuses the dev flag"
        );
        let PeerPolicy::SameTeamApp { requirement } =
            PeerPolicy::decide(Some("ABCDE12345"), false).unwrap()
        else {
            panic!("signed → same-team rule");
        };
        assert_eq!(
            requirement,
            "anchor apple generic and identifier \"app.momo.desktop\" and \
             certificate leaf[subject.OU] = \"ABCDE12345\""
        );
    }

    #[test]
    fn a_team_id_that_is_not_apples_shape_is_never_spliced_into_a_requirement() {
        for bad in [
            "",
            "abcde12345",
            "ABCDE1234",
            "ABC\" or true",
            "ABCDE123456",
        ] {
            assert!(app_requirement(bad).is_err(), "{bad:?}");
        }
    }

    fn shared(dir: &Path) -> SocketShared {
        let identity = identity();
        SocketShared {
            health: Arc::new(HostHealth::default()),
            stop: Arc::new(tokio::sync::Notify::new()),
            trust: Arc::new(std::sync::Mutex::new(
                crate::human_trust::HumanTrust::open(
                    dir,
                    crate::human_trust::TrustIdentity {
                        workspace_id: identity.workspace_id,
                        owner_member_id: identity.owner_member_id,
                        host_id: identity.host_id,
                    },
                )
                .unwrap(),
            )),
            requirement: Arc::new(std::sync::Mutex::new(
                crate::signature_requirement::SignatureRequirement::open(dir, false),
            )),
            state_folder: dir.to_path_buf(),
            grants: crate::session_grant::GrantEpoch::default(),
        }
    }

    fn scratch() -> PathBuf {
        use std::os::unix::fs::DirBuilderExt as _;
        let dir = std::env::temp_dir().join(format!("momo-workd-sock-{}", Uuid::new_v4().simple()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }

    #[test]
    fn the_wire_answers_its_ops_only() {
        let dir = scratch();
        let shared = shared(&dir);
        let health = &shared.health;
        let status = respond(r#"{"op":"status"}"#, &identity(), &shared);
        assert_eq!(status["ok"], true);
        assert_eq!(status["hostId"], Uuid::from_u128(1).to_string());
        assert_eq!(status["heartbeat"]["lastOkAtMs"], Value::Null);
        assert_eq!(status["humanSignatures"]["required"], false);
        assert_eq!(status["humanSignatures"]["requiredBy"], Value::Null);
        assert_eq!(status["humanSignatures"]["serverRequired"], Value::Null);
        assert_eq!(status["humanSignatures"]["rootKeyId"], Value::Null);
        assert_eq!(status["humanSignatures"]["rootPublicKey"], Value::Null);
        health.heartbeat_accepted();
        let status = respond(r#"{"op":"status"}"#, &identity(), &shared);
        assert!(status["heartbeat"]["lastOkAtMs"].as_i64().unwrap() > 0);
        assert_eq!(status["heartbeat"]["failing"], false);
        health.heartbeat_failed();
        let status = respond(r#"{"op":"status"}"#, &identity(), &shared);
        assert_eq!(status["heartbeat"]["failing"], true);
        for other in [
            r#"{"op":"spawn"}"#,
            r#"{"op":"register"}"#,
            r#"{"op":"reset_root"}"#,
            r#"{"op":"pin_root"}"#,
            r#"{"op":"revoke_device"}"#,
            "not json",
            "{}",
        ] {
            assert_eq!(respond(other, &identity(), &shared)["ok"], false, "{other}");
        }
        assert_eq!(
            respond(r#"{"op":"shutdown"}"#, &identity(), &shared)["ok"],
            true
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// #3095: a 「이 세션 동안」 grant must not outlive a root (re)pin or a
    /// ratchet reset, and a refused op retires nothing.
    #[test]
    fn the_local_ops_retire_session_grants_and_refused_ones_do_not() {
        use base64::Engine as _;
        let mut secret = [0u8; 32];
        secret[31] = 3;
        let key = p256::ecdsa::SigningKey::from_slice(&secret).unwrap();
        let public = base64::engine::general_purpose::STANDARD
            .encode(key.verifying_key().to_sec1_point(true).as_bytes());
        let dir = scratch();
        let shared = shared(&dir);
        let epoch = || shared.grants.current();
        let start = epoch();
        // Refused ops retire nothing.
        let bad_pin = respond(
            r#"{"op":"pin_root","keyId":"00000000-0000-0000-0000-000000000009","alg":"p256","publicKey":"nope"}"#,
            &identity(),
            &shared,
        );
        assert_eq!(bad_pin["ok"], false);
        let bad_revoke = respond(
            r#"{"op":"revoke_device","revocation":{}}"#,
            &identity(),
            &shared,
        );
        assert_eq!(bad_revoke["ok"], false);
        assert_eq!(epoch(), start, "a refused op retires nothing");
        // A root pin does.
        let pin = respond(
            &json!({"op":"pin_root","keyId":Uuid::from_u128(9),"alg":"p256","publicKey":public})
                .to_string(),
            &identity(),
            &shared,
        );
        assert_eq!(pin["ok"], true);
        assert!(epoch() > start, "pin_root retires the grants");
        // So does the ratchet reset.
        let before = epoch();
        respond(
            r#"{"op":"reset_signature_requirement"}"#,
            &identity(),
            &shared,
        );
        assert!(epoch() > before, "reset_signature_requirement retires them");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn set_remote_profile_takes_a_label_or_null_and_saves_nothing_else() {
        let dir = scratch();
        let shared = shared(&dir);
        let ask = |request: &str| respond(request, &identity(), &shared);
        for (request, error) in [
            (r#"{"op":"set_remote_profile"}"#, "invalid_request"),
            (
                r#"{"op":"set_remote_profile","harness":"claude"}"#,
                "invalid_request",
            ),
            (
                r#"{"op":"set_remote_profile","harness":"claude","label":7}"#,
                "invalid_request",
            ),
            (
                r#"{"op":"set_remote_profile","harness":"grok","label":"Work"}"#,
                "unknown_harness",
            ),
            (
                r#"{"op":"set_remote_profile","harness":"claude","label":"../../x"}"#,
                "invalid_label",
            ),
        ] {
            let answer = ask(request);
            assert_eq!(answer["ok"], false, "{request}");
            assert_eq!(answer["error"], error, "{request}");
        }
        assert!(
            !dir.join(crate::profile::PROFILES_FILE).exists(),
            "a refused choice saved nothing"
        );
        // A label with no folder yet is not saved either: sign in first.
        let answer = ask(r#"{"op":"set_remote_profile","harness":"claude","label":"Work"}"#);
        assert_eq!(answer["error"], "profile_not_found");
        // `prepare_remote_profile` makes the folder and names the path to
        // sign the CLI in to; only then the choice is taken.
        let prepared = ask(r#"{"op":"prepare_remote_profile","harness":"claude","label":"Work"}"#);
        assert_eq!(prepared["ok"], true);
        assert_eq!(
            prepared["path"],
            crate::profile::profile_dir(&dir, "claude", "Work")
                .display()
                .to_string()
        );
        assert_eq!(
            ask(r#"{"op":"set_remote_profile","harness":"claude","label":"Work"}"#)["ok"],
            true
        );
        for request in [
            r#"{"op":"prepare_remote_profile","harness":"claude"}"#,
            r#"{"op":"prepare_remote_profile","label":"Work"}"#,
        ] {
            assert_eq!(ask(request)["error"], "invalid_request", "{request}");
        }
        assert_eq!(
            ask(r#"{"op":"prepare_remote_profile","harness":"claude","label":"../x"}"#)["error"],
            "invalid_label"
        );
        // Clearing the choice leaves an empty object: no choice.
        assert_eq!(
            ask(r#"{"op":"set_remote_profile","harness":"claude","label":null}"#)["ok"],
            true
        );
        let saved = std::fs::read_to_string(dir.join(crate::profile::PROFILES_FILE)).unwrap();
        assert_eq!(saved, "{}");
    }

    #[test]
    fn only_the_local_op_lowers_a_latched_requirement() {
        let dir = scratch();
        let shared = shared(&dir);
        let status =
            || respond(r#"{"op":"status"}"#, &identity(), &shared)["humanSignatures"].clone();
        // The server's word without a root: the half state, reported.
        shared
            .requirement
            .lock()
            .unwrap()
            .note_server(true, false, 5)
            .unwrap();
        assert_eq!(status()["required"], false);
        assert_eq!(status()["serverRequired"], true);
        // With a root: latched.
        shared
            .requirement
            .lock()
            .unwrap()
            .note_server(true, true, 6)
            .unwrap();
        assert_eq!(status()["required"], true);
        assert_eq!(status()["requiredBy"], "server");
        assert_eq!(status()["latchedSinceMs"], 6);
        // The server takes it back: still required.
        shared
            .requirement
            .lock()
            .unwrap()
            .note_server(false, true, 7)
            .unwrap();
        assert_eq!(status()["required"], true);
        assert_eq!(status()["serverRequired"], false);
        // The local op lowers it, and it stays lowered after a restart.
        assert_eq!(
            respond(
                r#"{"op":"reset_signature_requirement"}"#,
                &identity(),
                &shared
            ),
            json!({"ok": true, "required": false})
        );
        assert_eq!(status()["required"], false);
        let reopened = self::shared(&dir);
        assert_eq!(
            respond(r#"{"op":"status"}"#, &identity(), &reopened)["humanSignatures"]["required"],
            false
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_root_is_pinned_once_and_a_second_key_is_refused() {
        use base64::Engine as _;
        let point = |scalar: u8| {
            let mut secret = [0u8; 32];
            secret[31] = scalar;
            let key = p256::ecdsa::SigningKey::from_slice(&secret).unwrap();
            base64::engine::general_purpose::STANDARD
                .encode(key.verifying_key().to_sec1_point(true).as_bytes())
        };
        let (g, g2) = (point(1), point(2));
        let (G, G2) = (g.as_str(), g2.as_str());
        let dir = scratch();
        let shared = shared(&dir);
        let pin = |key: &str, id: u128| {
            respond(
                &json!({"op":"pin_root","keyId":Uuid::from_u128(id),"alg":"p256","publicKey":key})
                    .to_string(),
                &identity(),
                &shared,
            )
        };
        assert_eq!(pin("not a key", 9)["error"], "invalid_root_key");
        assert_eq!(pin(G, 9), json!({"ok": true, "pinned": true}));
        assert_eq!(
            pin(G, 9),
            json!({"ok": true, "pinned": false}),
            "idempotent"
        );
        assert_eq!(pin(G2, 10)["error"], "root_already_pinned");
        assert_eq!(pin(G2, 9)["error"], "root_already_pinned");
        let status = respond(r#"{"op":"status"}"#, &identity(), &shared);
        assert_eq!(
            status["humanSignatures"]["rootKeyId"],
            Uuid::from_u128(9).to_string()
        );
        assert_eq!(status["humanSignatures"]["rootPublicKey"], G);
        // #3078: the same key under a new id (a re-login) is rebound here.
        assert_eq!(pin(G, 11), json!({"ok": true, "pinned": true}));
        assert_eq!(pin(G, 11), json!({"ok": true, "pinned": false}));
        assert_eq!(pin(G, 9)["error"], "root_key_id_retired");
        assert_eq!(pin(G2, 12)["error"], "root_already_pinned");
        let status = respond(r#"{"op":"status"}"#, &identity(), &shared);
        assert_eq!(
            status["humanSignatures"]["rootKeyId"],
            Uuid::from_u128(11).to_string()
        );
        assert_eq!(status["humanSignatures"]["rootPublicKey"], G);
        // Persisted: a restarted host still refuses the second key.
        let reopened = self::shared(&dir);
        let again = respond(
            &json!({"op":"pin_root","keyId":Uuid::from_u128(10),"alg":"p256","publicKey":G2})
                .to_string(),
            &identity(),
            &reopened,
        );
        assert_eq!(again["error"], "root_already_pinned");
        let _ = std::fs::remove_dir_all(dir);
    }
}
