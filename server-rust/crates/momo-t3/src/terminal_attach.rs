//! Terminal-attach **capability control plane** (ADR-0125 D10 / ADR-0126 D1),
//! ported from Swift `Routes/TerminalAttachRoutes.swift` (480 lines).
//!
//! ## What this module is, and the line it does not cross
//!
//! momo's servers never carry terminal bytes. The durable ledger
//! (`023_terminal_attach.sql`) stores a remote PTY identifier, its direct
//! endpoint, and SHA-256 capability digests — and nothing else. This module is
//! the whole server-side story:
//!
//! 1. an authorized human is minted an opaque, 60-second bearer;
//! 2. the direct PTY host validates that bearer through its own signature
//!    before accepting a socket, and re-validates on a timer while the stream
//!    is open.
//!
//! Everything after that — the WebSocket, stdin, resize, kill, the ring-buffer
//! replay of ADR-0139 D2 — is the host daemon's (`TerminalAttachServer.swift`,
//! B5). There is deliberately no stream, socket or relay function in this crate,
//! and `docs/security/README.ko.md`'s "실행 내용 미보관" stays literally true.
//!
//! ## Why validation is a JOIN and not a token lookup
//!
//! [`validate_attach_capability_in_tx`] joins the live `work_session`,
//! `work_host` and grantee `member` on **every** call. That is what makes
//! session end, host revocation and member deactivation take effect
//! immediately: there is no cached verdict to go stale, and a 30-second
//! re-validation is a fresh authorization decision rather than a token
//! re-check. Ports `TerminalAttachRoutes.swift:322-365`.
//!
//! The `stream: true` re-validation relaxes exactly one clause — expiry — and
//! the reason is what the TTL is *for*: 60 seconds bounds the window between
//! minting a bearer and dialling with it, because that is when the token sits in
//! a clipboard, a URL bar, a proxy log. Once a host has accepted a socket on
//! that token after a full, TTL-enforcing validation, the dial window is closed
//! and the token has no further job; what must stay true every 30 seconds is the
//! AUTHORIZATION, which is every other clause in the join (MOMO-674,
//! `:72-96`).

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine as _;
use momo_db::PgConnection;
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// `TerminalAttachRoutes.capabilityTTLSeconds` (:124).
pub const CAPABILITY_TTL_SECONDS: i64 = 60;
/// `TerminalAttachRoutes.capabilityPrefix` (:125).
pub const CAPABILITY_PREFIX: &str = "momo_terminal_attach_v1";
/// How long a spent observer row is kept before the next issue on the same
/// session sweeps it (`observerCapabilityRetention`, :138).
///
/// This used to be zero — expired meant collectable. That was safe only while a
/// capability was checked once; now a host re-validates the SAME row for the
/// life of the stream, so deleting it the moment its dial window closes would
/// make one teammate pressing 관전 시작 cut every other observer off the session
/// within a revalidation period. Nothing user-visible reads these rows (the
/// grant badge counts `expires_at > clock_timestamp()` itself), so the window
/// can widen without changing what any client says.
pub const OBSERVER_CAPABILITY_RETENTION: &str = "1 hour";

/// `attach_endpoint` length ceiling (`work_session_attach_endpoint_ck`,
/// 023:22-24 — and `RemotePTYBinding.validated`, :30).
const MAX_ATTACH_ENDPOINT_BYTES: usize = 2_048;

/// The two capability grades (`terminal_attach_capability_mode_ck`, 024:17-18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    /// The session owner: stdin, resize, kill.
    Controller,
    /// A channel member watching an `observation = 'open'` session.
    Observer,
}

impl AttachMode {
    pub fn as_db_label(self) -> &'static str {
        match self {
            AttachMode::Controller => "controller",
            AttachMode::Observer => "observer",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "controller" => Some(AttachMode::Controller),
            "observer" => Some(AttachMode::Observer),
            _ => None,
        }
    }
}

/// The host-side binding a client dials (`RemotePTYBinding`, :6-49).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePtyBinding {
    pub pty_id: String,
    pub attach_endpoint: String,
}

/// `RemotePTYBinding.validated` (:19-48) applied to the **stored** pair.
///
/// Swift re-validates on read, not only on write, and keeps that: a row written
/// before a grammar tightened must not be handed to a client as if it were
/// still legal. `None` means "this session cannot be attached", which the route
/// answers with Swift's 409, never with a partially-trusted endpoint.
///
/// The endpoint rules, in Swift's order: both halves present, ≤ 2048 bytes, no
/// NUL, an `https`/`wss` scheme, a non-empty host, and **no** userinfo, query or
/// fragment — a credential-free URL, because this string is handed to a browser
/// and to a log.
pub fn validated_binding(
    pty_id: Option<&str>,
    attach_endpoint: Option<&str>,
) -> Option<RemotePtyBinding> {
    let (pty_id, attach_endpoint) = match (pty_id, attach_endpoint) {
        (Some(pty_id), Some(endpoint)) => (pty_id, endpoint),
        // The `work_session_remote_pty_pair_ck` CHECK (023:12-15) makes a
        // half-set pair unrepresentable, so either both are present or neither.
        _ => return None,
    };
    if !is_valid_pty_id(pty_id) || !is_credential_free_stream_url(attach_endpoint) {
        return None;
    }
    Some(RemotePtyBinding {
        pty_id: pty_id.to_string(),
        attach_endpoint: attach_endpoint.to_string(),
    })
}

/// `work_session_pty_id_ck` / Swift `:27` — `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
fn is_valid_pty_id(raw: &str) -> bool {
    let mut characters = raw.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let rest: Vec<char> = characters.collect();
    rest.len() <= 127
        && rest
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(*c))
}

/// Swift `:30-46`, without pulling a URL parser into a domain crate: the checks
/// are structural and each one is named in the source it ports.
fn is_credential_free_stream_url(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > MAX_ATTACH_ENDPOINT_BYTES || raw.contains('\0') {
        return false;
    }
    // A query or fragment anywhere is refused outright — Swift requires both to
    // be nil, and neither can appear before the authority.
    if raw.contains('?') || raw.contains('#') {
        return false;
    }
    let lowered = raw.to_ascii_lowercase();
    let after_scheme = if lowered.starts_with("https://") {
        &raw["https://".len()..]
    } else if lowered.starts_with("wss://") {
        &raw["wss://".len()..]
    } else {
        return false;
    };
    // The authority ends at the first '/'. Foundation reports an empty string,
    // not nil, for "wss:///path", which is why emptiness is checked explicitly.
    let authority = after_scheme.split('/').next().unwrap_or("");
    // '@' is userinfo: `components.user`/`components.password` must be nil.
    !authority.is_empty() && !authority.contains('@')
}

/// The session row an attach request is judged against (`issue`, :172-191).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachTarget {
    /// The session owner — the only member who may attach as controller.
    pub owner_member_id: Uuid,
    pub host_id: Uuid,
    pub channel_id: Uuid,
    pub status: String,
    pub observation: String,
    pub host_revoked: bool,
    pub binding: Option<RemotePtyBinding>,
}

impl AttachTarget {
    /// Swift `:209-216`: a live session (running **or** idle — ADR-0139 D1
    /// makes idle attachable, which is the whole point of the state), an
    /// unrevoked host, and a binding that still parses.
    pub fn is_attachable(&self) -> bool {
        (self.status == "running" || self.status == "idle")
            && !self.host_revoked
            && self.binding.is_some()
    }
}

/// Lock the session and its host for an attach decision (`FOR UPDATE OF ws, h`,
/// `:172-184`).
///
/// The lock is on both rows because the decision reads both: without it a
/// concurrent host revoke could land between the read and the capability
/// insert, minting a bearer for a host that is already gone.
pub async fn lock_attach_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<AttachTarget>, T3Error> {
    let row = sqlx::query(
        "SELECT ws.member_id, ws.host_id, ws.channel_id, ws.pty_id, \
                ws.attach_endpoint, ws.status, ws.observation, \
                (h.revoked_at IS NOT NULL) AS host_revoked \
           FROM work_session ws \
           JOIN work_host h \
             ON h.id = ws.host_id \
            AND h.workspace_id = ws.workspace_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2 \
          FOR UPDATE OF ws, h",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let pty_id: Option<String> = row.try_get("pty_id")?;
    let attach_endpoint: Option<String> = row.try_get("attach_endpoint")?;
    Ok(Some(AttachTarget {
        owner_member_id: row.try_get("member_id")?,
        host_id: row.try_get("host_id")?,
        channel_id: row.try_get("channel_id")?,
        status: row.try_get("status")?,
        observation: row.try_get("observation")?,
        host_revoked: row.try_get("host_revoked")?,
        binding: validated_binding(pty_id.as_deref(), attach_endpoint.as_deref()),
    }))
}

/// Mint an opaque capability bearer: `momo_terminal_attach_v1.<43 base64url>`
/// (`mintCapabilityToken` :382-384 → `WebhookCrypto.randomReference` :14-16 =
/// `base64URL(randomBytes(32))`).
///
/// The 32 bytes come from two v4 UUIDs — the same CSPRNG the rest of the
/// workspace draws ids from, and the pattern the T3 smoke already uses to seed a
/// throwaway keypair — so a domain crate does not grow an RNG dependency for one
/// call site.
pub fn mint_capability_token() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    format!("{CAPABILITY_PREFIX}.{}", BASE64URL.encode(bytes))
}

/// `validatedCapabilityToken` (:386-393): exactly two dot-separated parts, the
/// literal prefix, and 43 base64url characters. Shape is checked before the
/// database is touched so a malformed bearer costs no query.
pub fn is_valid_capability_token(raw: &str) -> bool {
    let mut parts = raw.split('.');
    let (Some(prefix), Some(reference), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    prefix == CAPABILITY_PREFIX
        && reference.len() == 43
        && reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Delete observer rows whose retention window has closed (`:218-221`). Runs
/// before each issue, so the table is pruned by use rather than by a timer.
pub async fn sweep_spent_observer_capabilities_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<u64, T3Error> {
    let deleted = sqlx::query(
        "DELETE FROM terminal_attach_capability \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
            AND mode = 'observer' \
            AND expires_at <= clock_timestamp() - $3::interval",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(OBSERVER_CAPABILITY_RETENTION)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(deleted)
}

/// A freshly minted grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCapability {
    pub id: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

/// Insert the capability row (`:222-233`). Only `digest(token, 'sha256')` is
/// persisted — the raw bearer exists in the response body and nowhere else, so
/// a database dump cannot dial a terminal.
///
/// `expires_at` is computed by PostgreSQL (`clock_timestamp() + interval`), not
/// by the application: `terminal_attach_expiry_ck` (023:37-40) validates the
/// pair against the DB's own clock, and an app-computed timestamp from a skewed
/// host would fail that CHECK for reasons no log would explain.
pub async fn issue_attach_capability_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    host_id: Uuid,
    owner_member_id: Uuid,
    token: &str,
    mode: AttachMode,
) -> Result<IssuedCapability, T3Error> {
    let row = sqlx::query(
        "INSERT INTO terminal_attach_capability \
           (workspace_id, work_session_id, host_id, owner_member_id, \
            token_hash, expires_at, mode) \
         VALUES ($1, $2, $3, $4, digest($5::text, 'sha256'), \
                 clock_timestamp() + make_interval(secs => $6::double precision), $7) \
         RETURNING id, \
                   floor(extract(epoch from issued_at) * 1000)::bigint AS issued_at_ms, \
                   floor(extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(host_id)
    .bind(owner_member_id)
    .bind(token)
    .bind(CAPABILITY_TTL_SECONDS as f64)
    .bind(mode.as_db_label())
    .fetch_one(&mut *conn)
    .await?;
    Ok(IssuedCapability {
        id: row.try_get("id")?,
        issued_at_ms: row.try_get("issued_at_ms")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
    })
}

/// Count the observer grants still inside their dial window (`:264-274`) — the
/// number the `work.session.observer` broadcast carries.
pub async fn active_observer_capability_count_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<i64, T3Error> {
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) \
           FROM terminal_attach_capability \
          WHERE workspace_id = $1 \
            AND work_session_id = $2 \
            AND mode = 'observer' \
            AND expires_at > clock_timestamp()",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(count)
}

/// What a host learns when a bearer checks out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedAttach {
    pub work_session_id: Uuid,
    pub pty_id: String,
    /// ISO-8601 with fractional seconds, rendered by PostgreSQL so the wire
    /// format cannot drift from Swift's `ISO8601DateFormatter` output
    /// (`iso8601`, :464-468).
    pub expires_at: String,
    pub mode: AttachMode,
}

/// The whole authorization decision, in one join (`validate`, :322-365).
///
/// `revalidating` = the `stream: true` flag: the host is re-checking a socket it
/// already serves, so the expiry clause is skipped and **only** the expiry
/// clause. Every other predicate — session still running or idle, host
/// unrevoked, grantee still an active human, controller is still the owner,
/// observer's session still `open` and their channel membership still live — is
/// evaluated exactly as on the first call.
pub async fn validate_attach_capability_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    token: &str,
    revalidating: bool,
) -> Result<Option<ValidatedAttach>, T3Error> {
    let row = sqlx::query(
        "SELECT c.work_session_id, ws.pty_id, c.mode, \
                to_char(c.expires_at AT TIME ZONE 'UTC', \
                        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires_at_iso \
           FROM terminal_attach_capability c \
           JOIN work_session ws \
             ON ws.id = c.work_session_id \
            AND ws.workspace_id = c.workspace_id \
            AND ws.host_id = c.host_id \
           JOIN work_host h \
             ON h.id = c.host_id \
            AND h.workspace_id = c.workspace_id \
           JOIN member grantee \
             ON grantee.id = c.owner_member_id \
            AND grantee.workspace_id = c.workspace_id \
            AND grantee.kind = 'human' \
            AND grantee.status = 'active' \
            AND grantee.deleted_at IS NULL \
          WHERE c.workspace_id = $1 \
            AND c.host_id = $2 \
            AND c.token_hash = digest($3::text, 'sha256') \
            AND ($4 OR c.expires_at > clock_timestamp()) \
            AND ws.status IN ('running', 'idle') \
            AND ws.pty_id IS NOT NULL \
            AND ws.attach_endpoint IS NOT NULL \
            AND h.revoked_at IS NULL \
            AND ( \
              (c.mode = 'controller' AND c.owner_member_id = ws.member_id) \
              OR ( \
                c.mode = 'observer' \
                AND ws.observation = 'open' \
                AND EXISTS ( \
                  SELECT 1 FROM membership ms \
                   WHERE ms.workspace_id = c.workspace_id \
                     AND ms.channel_id = ws.channel_id \
                     AND ms.member_id = c.owner_member_id \
                     AND ms.left_at IS NULL \
                ) \
              ) \
            ) \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(host_id)
    .bind(token)
    .bind(revalidating)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let mode_label: String = row.try_get("mode")?;
    // An unknown mode is a row this build cannot reason about; refusing beats
    // guessing a grade that decides whether stdin is allowed.
    let Some(mode) = AttachMode::from_db_label(&mode_label) else {
        return Ok(None);
    };
    Ok(Some(ValidatedAttach {
        work_session_id: row.try_get("work_session_id")?,
        pty_id: row.try_get("pty_id")?,
        expires_at: row.try_get("expires_at_iso")?,
        mode,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_modes_match_the_check_constraint_vocabulary() {
        for mode in [AttachMode::Controller, AttachMode::Observer] {
            assert_eq!(
                AttachMode::from_db_label(mode.as_db_label()),
                Some(mode),
                "024:17-18 allows exactly these two"
            );
        }
        assert!(AttachMode::from_db_label("admin").is_none());
    }

    #[test]
    fn a_minted_token_satisfies_its_own_grammar_and_is_not_reused() {
        let first = mint_capability_token();
        let second = mint_capability_token();
        assert!(is_valid_capability_token(&first));
        assert!(is_valid_capability_token(&second));
        assert_ne!(first, second, "each mint draws fresh randomness");
        assert!(first.starts_with("momo_terminal_attach_v1."));
        assert_eq!(
            first.split('.').nth(1).unwrap().len(),
            43,
            "32 random bytes, base64url, unpadded"
        );
    }

    #[test]
    fn token_grammar_rejects_every_shape_swift_rejects() {
        let reference = "a".repeat(43);
        assert!(is_valid_capability_token(&format!(
            "{CAPABILITY_PREFIX}.{reference}"
        )));
        // wrong prefix
        assert!(!is_valid_capability_token(&format!(
            "momo_hook_v1.{reference}"
        )));
        // three parts
        assert!(!is_valid_capability_token(&format!(
            "{CAPABILITY_PREFIX}.{reference}.x"
        )));
        // one part
        assert!(!is_valid_capability_token(CAPABILITY_PREFIX));
        // wrong length
        assert!(!is_valid_capability_token(&format!(
            "{CAPABILITY_PREFIX}.{}",
            "a".repeat(42)
        )));
        // base64 standard alphabet is not base64url
        assert!(!is_valid_capability_token(&format!(
            "{CAPABILITY_PREFIX}.{}+",
            "a".repeat(42)
        )));
    }

    #[test]
    fn binding_requires_both_halves() {
        assert!(validated_binding(None, None).is_none());
        assert!(validated_binding(Some("pty-1"), None).is_none());
        assert!(validated_binding(None, Some("wss://host/x")).is_none());
        assert_eq!(
            validated_binding(Some("pty-1"), Some("wss://host.example/attach")),
            Some(RemotePtyBinding {
                pty_id: "pty-1".into(),
                attach_endpoint: "wss://host.example/attach".into(),
            })
        );
    }

    #[test]
    fn endpoint_must_be_a_credential_free_https_or_wss_url() {
        assert!(is_credential_free_stream_url("https://host.example"));
        assert!(is_credential_free_stream_url(
            "wss://host.example/attach/pty"
        ));
        assert!(is_credential_free_stream_url("WSS://Host.Example/attach"));
        // Foundation reports an empty host, not nil, for a triple slash.
        assert!(!is_credential_free_stream_url("wss:///attach"));
        assert!(!is_credential_free_stream_url("ws://host.example"));
        assert!(!is_credential_free_stream_url("http://host.example"));
        assert!(
            !is_credential_free_stream_url("wss://user:pw@host.example/x"),
            "userinfo is a credential in a URL that is logged and pasted"
        );
        assert!(!is_credential_free_stream_url(
            "wss://host.example/x?token=1"
        ));
        assert!(!is_credential_free_stream_url("wss://host.example/x#frag"));
        assert!(!is_credential_free_stream_url("wss://host.example/\0"));
        assert!(!is_credential_free_stream_url(""));
        assert!(!is_credential_free_stream_url(&format!(
            "wss://host.example/{}",
            "a".repeat(MAX_ATTACH_ENDPOINT_BYTES)
        )));
    }

    #[test]
    fn pty_id_matches_the_check_constraint() {
        assert!(is_valid_pty_id("a"));
        assert!(is_valid_pty_id("A0._:-"));
        assert!(is_valid_pty_id(&format!("a{}", "b".repeat(127))));
        assert!(!is_valid_pty_id(""));
        assert!(!is_valid_pty_id("-leading"));
        assert!(!is_valid_pty_id("has space"));
        assert!(
            !is_valid_pty_id(&format!("a{}", "b".repeat(128))),
            "128 trailing characters exceeds the 0...127 quantifier"
        );
    }

    #[test]
    fn idle_is_attachable_and_a_revoked_host_is_not() {
        let live = |status: &str, revoked: bool, bound: bool| AttachTarget {
            owner_member_id: Uuid::from_u128(1),
            host_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            status: status.to_string(),
            observation: "open".to_string(),
            host_revoked: revoked,
            binding: bound.then(|| RemotePtyBinding {
                pty_id: "pty".into(),
                attach_endpoint: "wss://host.example/x".into(),
            }),
        };
        assert!(live("running", false, true).is_attachable());
        assert!(
            live("idle", false, true).is_attachable(),
            "ADR-0139 D1: idle keeps the PTY, which is what makes reattach 이어서 쓰기"
        );
        assert!(!live("orphaned", false, true).is_attachable());
        assert!(!live("ended", false, true).is_attachable());
        assert!(!live("running", true, true).is_attachable());
        assert!(!live("running", false, false).is_attachable());
    }
}
