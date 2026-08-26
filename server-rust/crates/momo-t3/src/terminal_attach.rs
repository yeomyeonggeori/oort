//! Attach **capability control plane** (ADR-0125 D10 / ADR-0126 D1 / ADR-0165),
//! ported from Swift `Routes/TerminalAttachRoutes.swift` (480 lines).
//!
//! ## Two kinds, one machine
//!
//! A session can expose two things a person may dial: its **PTY** (023) and,
//! since LIVE-1, its **display** — the live screen, carried by WebRTC from a
//! producer inside the sandbox (ADR-0165 D1). Both are the same act at this
//! layer: momo mints a 60-second bearer for a host endpoint it does not own and
//! answers whether that bearer is still good.
//!
//! So [`AttachKind`] is a parameter, not a second module. `issue`, `validate`,
//! the sweep, the observer count, the RLS policy and the revoke joins are one
//! implementation each. A parallel display machine would give this workspace two
//! definitions of "the host was revoked, cut everyone off" — and the day one of
//! them fell behind, 「관전을 끊었다」 would be half true.
//!
//! The kinds used to diverge in what they may be — display capabilities existed
//! only as `observer` (075's `terminal_attach_display_observer_ck`) while input
//! waited on a decision. ADR-0004 증보 3 made that decision on 2026-08-15 and
//! 076 dropped the CHECK, so both kinds now carry both grades.
//!
//! What a display controller grant additionally implies lives in
//! [`crate::display_control`]: a grant opens a **control window**, and while
//! that window stands the agent's own path to the session is refused. This
//! module still mints and validates; it does not know about that, and the one
//! seam between them is [`ValidatedAttach::capability_id`], which the display
//! route uses to renew the window a live producer is keeping open.
//!
//! ## What this module is, and the line it does not cross
//!
//! momo's servers never carry terminal bytes, and never carry a video frame
//! either (ADR-0165 D5). The durable ledger (`023_terminal_attach.sql`,
//! `075_display_attach.sql`) stores a remote PTY identifier, a display
//! identifier, their direct endpoints, and SHA-256 capability digests — and
//! nothing else. This module is the whole server-side story:
//!
//! 1. an authorized human is minted an opaque, 60-second bearer;
//! 2. the direct PTY host validates that bearer through its own signature
//!    before accepting a socket, and re-validates on a timer while the stream
//!    is open.
//!
//! Everything after that — the WebSocket, stdin, resize, kill, the ring-buffer
//! replay of ADR-0139 D2; and on the display side the signalling handshake, the
//! ICE candidates and the media itself — is the host's. There is deliberately no
//! stream, socket, signalling or relay function in this crate, and
//! `docs/security/README.ko.md`'s "실행 내용 미보관" stays literally true.
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

/// `attach_endpoint` / `display_endpoint` length ceiling
/// (`work_session_attach_endpoint_ck` 023:22-24, `work_session_display_endpoint_ck`
/// 075 — and `RemotePTYBinding.validated`, :30).
const MAX_ATTACH_ENDPOINT_BYTES: usize = 2_048;

/// The `work_host.capabilities` flag a host must advertise before this server
/// will mint a display capability for one of its sessions (021:28-35 closes that
/// jsonb to boolean values, so this key is a boolean or the row does not exist).
///
/// The gate is **fail-closed and provider-blind**: policy asks the host what it
/// offers, never the adapter registry what vendor it is (invariant #7 /
/// `provider::registry` module rule). BYOC is excluded as a *consequence* —
/// momo neither creates nor images a BYOC box, so nothing there ever runs a
/// producer or advertises this flag — rather than by a provider-name test that
/// would teach policy code a vendor's identity.
pub const HOST_DISPLAY_CAPABILITY_KEY: &str = "display_attach";

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

/// Which surface of a session a capability addresses
/// (`terminal_attach_capability_kind_ck`, 075).
///
/// Deliberately a parameter of the existing machine rather than a second table:
/// see the module header. `Pty` is the DEFAULT the migration backfills, so every
/// row written before LIVE-1 names itself correctly without a data migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachKind {
    /// The terminal (023). Both grades exist.
    Pty,
    /// The live screen (075, ADR-0165). **Observer only** — the CHECK says so.
    Display,
}

impl AttachKind {
    pub fn as_db_label(self) -> &'static str {
        match self {
            AttachKind::Pty => "pty",
            AttachKind::Display => "display",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "pty" => Some(AttachKind::Pty),
            "display" => Some(AttachKind::Display),
            _ => None,
        }
    }

    /// The grades this kind may be minted at.
    ///
    /// Both kinds now permit both grades. Until LIVE-3 this function was the
    /// Rust half of `terminal_attach_display_observer_ck` and answered `false`
    /// for display+controller; 076 dropped that CHECK when ADR-0004 증보 3 was
    /// Accepted, and the two halves moved together as 075's comment promised.
    ///
    /// It is kept rather than deleted because it is the shape of the question,
    /// and the answer is a fact about a vocabulary rather than about a
    /// permission: **who** may hold a display controller grant is the session
    /// owner (`issue_in_tx`), and **what must be true while they hold it** is
    /// [`crate::display_control`]. Neither of those belongs in an enum.
    pub fn permits_mode(self, _mode: AttachMode) -> bool {
        match self {
            AttachKind::Pty => true,
            AttachKind::Display => true,
        }
    }
}

/// The host-side binding a client dials (`RemotePTYBinding`, :6-49).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePtyBinding {
    pub pty_id: String,
    pub attach_endpoint: String,
}

/// The host-side **display** binding a client dials (075, ADR-0165 D2).
///
/// `display_endpoint` is the VM's own WebRTC **signalling** WS URL. It is not a
/// media address (media is negotiated peer-to-peer over ICE and never named
/// here) and it is emphatically not a momo address: the server signs a
/// capability and steps out, exactly as it does for a PTY. The grammar is 023's
/// — credential-free `https`/`wss`, ≤ 2048 bytes — because this string is handed
/// to a browser and to a log for the same reasons it was there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDisplayBinding {
    pub display_id: String,
    pub display_endpoint: String,
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
    if !is_valid_attach_target_id(pty_id) || !is_credential_free_stream_url(attach_endpoint) {
        return None;
    }
    Some(RemotePtyBinding {
        pty_id: pty_id.to_string(),
        attach_endpoint: attach_endpoint.to_string(),
    })
}

/// Write-time twin of [`validated_binding`] — Swift `RemotePTYBinding.validated`
/// (`TerminalAttachRoutes.swift:19-48`). The read path returns `None` for a
/// half-set or illegal pair (a stored row that can no longer be handed out);
/// a host *publishing* one must hear which half failed, in Swift's sentences.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyBindingParseError {
    MissingHalf,
    InvalidPtyId,
    InvalidEndpoint,
}

impl PtyBindingParseError {
    pub fn message(self) -> &'static str {
        match self {
            Self::MissingHalf => "ptyId and attachEndpoint must be provided together",
            Self::InvalidPtyId => "ptyId is invalid",
            Self::InvalidEndpoint => "attachEndpoint must be a credential-free HTTPS or WSS URL",
        }
    }
}

/// Parse a host-supplied PTY pair. `Ok(None)` = both absent (create without a
/// binding). Either half alone, or a pair that fails the CHECK grammar, is an
/// error — the host is told which, not that "the session cannot be attached".
pub fn parse_remote_pty_binding(
    pty_id: Option<&str>,
    attach_endpoint: Option<&str>,
) -> Result<Option<RemotePtyBinding>, PtyBindingParseError> {
    match (pty_id, attach_endpoint) {
        (None, None) => Ok(None),
        (Some(pty_id), Some(endpoint)) => {
            if !is_valid_attach_target_id(pty_id) {
                return Err(PtyBindingParseError::InvalidPtyId);
            }
            if !is_credential_free_stream_url(endpoint) {
                return Err(PtyBindingParseError::InvalidEndpoint);
            }
            Ok(Some(RemotePtyBinding {
                pty_id: pty_id.to_string(),
                attach_endpoint: endpoint.to_string(),
            }))
        }
        _ => Err(PtyBindingParseError::MissingHalf),
    }
}

/// Swift `requireRemotePTYCapableHost` (`WorkSessionRoutes.swift:2468-2491`).
///
/// A host may publish a PTY binding only when it is unrevoked **and** advertised
/// `capabilities.terminal_attach`. Fail-closed either way: a missing row and a
/// revoked/incapable row are different 403s at the route, so they stay distinct
/// here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePtyHostStatus {
    Capable,
    NotFound,
    NotCapable,
}

pub async fn remote_pty_host_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<RemotePtyHostStatus, T3Error> {
    let row = sqlx::query(
        "SELECT revoked_at IS NULL AS active, \
                COALESCE((capabilities->>'terminal_attach')::boolean, false) AS supported \
           FROM work_host \
          WHERE id = $1 \
            AND workspace_id = $2 \
          FOR SHARE",
    )
    .bind(host_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(RemotePtyHostStatus::NotFound);
    };
    let active: bool = row.try_get("active")?;
    let supported: bool = row.try_get("supported")?;
    if active && supported {
        Ok(RemotePtyHostStatus::Capable)
    } else {
        Ok(RemotePtyHostStatus::NotCapable)
    }
}

/// [`validated_binding`]'s display twin, applied to the **stored** pair.
///
/// Same shape, same re-validate-on-read discipline, and deliberately the same
/// two predicates: 075 copied 023's CHECKs byte for byte, so a display binding
/// that would be illegal as a PTY binding is illegal here too. `None` means
/// "this session has no display to attach to", which the route answers with the
/// same 409 it uses for every other unavailability — never with a
/// partially-trusted endpoint.
pub fn validated_display_binding(
    display_id: Option<&str>,
    display_endpoint: Option<&str>,
) -> Option<RemoteDisplayBinding> {
    let (display_id, display_endpoint) = match (display_id, display_endpoint) {
        (Some(display_id), Some(endpoint)) => (display_id, endpoint),
        // `work_session_remote_display_pair_ck` (075) makes a half-set pair
        // unrepresentable, so either both are present or neither.
        _ => return None,
    };
    if !is_valid_attach_target_id(display_id) || !is_credential_free_stream_url(display_endpoint) {
        return None;
    }
    Some(RemoteDisplayBinding {
        display_id: display_id.to_string(),
        display_endpoint: display_endpoint.to_string(),
    })
}

/// `work_session_pty_id_ck` (023) and `work_session_display_id_ck` (075) — one
/// grammar, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (Swift `:27`).
///
/// One function because the two CHECKs are one regex: a display id is a name a
/// host chose for a stream, exactly as a pty id is a name it chose for a
/// terminal, and both end up in a URL path and a log line.
fn is_valid_attach_target_id(raw: &str) -> bool {
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
    /// The display half of the same row (075). `None` = this session exposes no
    /// screen, which is the state every pre-LIVE-1 session is in.
    pub display_binding: Option<RemoteDisplayBinding>,
    /// `work_host.capabilities.display_attach` — see [`HOST_DISPLAY_CAPABILITY_KEY`].
    pub host_display_capable: bool,
}

impl AttachTarget {
    /// Swift `:209-216`: a live session (running **or** idle — ADR-0139 D1
    /// makes idle attachable, which is the whole point of the state), an
    /// unrevoked host, and a binding that still parses.
    pub fn is_attachable(&self) -> bool {
        self.is_live() && self.binding.is_some()
    }

    /// [`is_attachable`](Self::is_attachable) plus the one clause the display
    /// side adds: **the host must have advertised a display**.
    ///
    /// It is a separate clause rather than an implication of the binding because
    /// the two are written by different acts at different times — a host
    /// advertises at registration, and publishes a binding per session. A box
    /// that stopped offering screens (re-registered without the flag) must stop
    /// being dialable even while a stale binding is still in its row, and this
    /// is the clause that makes that true.
    pub fn is_display_attachable(&self) -> bool {
        self.is_live() && self.display_binding.is_some() && self.host_display_capable
    }

    fn is_live(&self) -> bool {
        (self.status == "running" || self.status == "idle") && !self.host_revoked
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
                ws.attach_endpoint, ws.display_id, ws.display_endpoint, \
                ws.status, ws.observation, \
                (h.revoked_at IS NOT NULL) AS host_revoked, \
                ((h.capabilities->>$3)::boolean IS TRUE) AS host_display_capable \
           FROM work_session ws \
           JOIN work_host h \
             ON h.id = ws.host_id \
            AND h.workspace_id = ws.workspace_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2 \
          FOR UPDATE OF ws, h",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(HOST_DISPLAY_CAPABILITY_KEY)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let pty_id: Option<String> = row.try_get("pty_id")?;
    let attach_endpoint: Option<String> = row.try_get("attach_endpoint")?;
    let display_id: Option<String> = row.try_get("display_id")?;
    let display_endpoint: Option<String> = row.try_get("display_endpoint")?;
    Ok(Some(AttachTarget {
        owner_member_id: row.try_get("member_id")?,
        host_id: row.try_get("host_id")?,
        channel_id: row.try_get("channel_id")?,
        status: row.try_get("status")?,
        observation: row.try_get("observation")?,
        host_revoked: row.try_get("host_revoked")?,
        binding: validated_binding(pty_id.as_deref(), attach_endpoint.as_deref()),
        display_binding: validated_display_binding(
            display_id.as_deref(),
            display_endpoint.as_deref(),
        ),
        host_display_capable: row.try_get("host_display_capable")?,
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
///
/// **Kind-agnostic on purpose.** A display grant is an observer grant that
/// happens to point at a screen; retiring it on a different clock, or not at
/// all, would leave one of the two kinds accumulating spent rows forever.
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
///
/// `kind` is the LIVE-1 axis. Passing [`AttachKind::Display`] with
/// [`AttachMode::Controller`] is rejected by
/// `terminal_attach_display_observer_ck` rather than silently downgraded — the
/// route is expected to have refused it with a sentence long before, and this
/// statement failing loudly is the backstop for the day it does not.
#[allow(clippy::too_many_arguments)]
pub async fn issue_attach_capability_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    host_id: Uuid,
    owner_member_id: Uuid,
    token: &str,
    mode: AttachMode,
    kind: AttachKind,
) -> Result<IssuedCapability, T3Error> {
    let row = sqlx::query(
        "INSERT INTO terminal_attach_capability \
           (workspace_id, work_session_id, host_id, owner_member_id, \
            token_hash, expires_at, mode, kind) \
         VALUES ($1, $2, $3, $4, digest($5::text, 'sha256'), \
                 clock_timestamp() + make_interval(secs => $6::double precision), $7, $8) \
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
    .bind(kind.as_db_label())
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
///
/// **Kind-agnostic, and that is the whole point.** The number answers "how many
/// people are watching this session", and someone watching the screen is
/// watching. Splitting it per kind would invent a second observer model on a
/// surface whose count is already published to every client and already
/// rendered as one badge — LIVE-1 was told to keep the observer계수 as it is,
/// not to fork it.
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
    /// The capability row this bearer resolved to.
    ///
    /// Not part of the wire response — no client is told its grant's row id —
    /// but the display path needs it to renew the control window this exact
    /// grant opened ([`crate::display_control::renew_control_window_lease_in_tx`]).
    /// Keying that renewal by capability rather than by session is what stops a
    /// stale bearer from holding a newer window open.
    pub capability_id: Uuid,
    pub work_session_id: Uuid,
    /// `work_session.pty_id` for [`AttachKind::Pty`], `display_id` for
    /// [`AttachKind::Display`] — the identifier the *asking host* uses to pick
    /// which of its own streams this bearer opens.
    pub target_id: String,
    /// ISO-8601 with fractional seconds, rendered by PostgreSQL so the wire
    /// format cannot drift from Swift's `ISO8601DateFormatter` output
    /// (`iso8601`, :464-468).
    pub expires_at: String,
    pub mode: AttachMode,
    pub kind: AttachKind,
}

/// The whole authorization decision, in one join (`validate`, :322-365).
///
/// `revalidating` = the `stream: true` flag: the host is re-checking a socket it
/// already serves, so the expiry clause is skipped and **only** the expiry
/// clause. Every other predicate — session still running or idle, host
/// unrevoked, grantee still an active human, controller is still the owner,
/// observer's session still `open` and their channel membership still live — is
/// evaluated exactly as on the first call.
///
/// The observer arm carries one exemption, added by LIVE-3: on a **display**
/// capability the session's own owner is not cut by `owner_only`. 성재 settled
/// `owner_only` as 「소유자만 본다」 rather than 「아무도 못 본다」, and the
/// exemption is scoped to `kind = 'display'` because PTY never had the problem
/// it fixes — there, an owner reaches their own closed session as controller.
/// Widening it to PTY observers would silently change a shipped permission.
///
/// `kind` pins which surface the asking host is serving, and it is a predicate
/// rather than a projection: a PTY daemon presenting a display bearer, or the
/// producer presenting a terminal one, gets the ordinary refusal. Two hosts do
/// not share a socket just because they share a box.
///
/// The display arm carries one extra clause the PTY arm does not have — the
/// host must **still** advertise `display_attach`. The join is the whole
/// authorization decision (module header), so an operator who re-registers a
/// box without the flag revokes every live display stream on it within one
/// re-validation period, without touching a capability row.
pub async fn validate_attach_capability_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    token: &str,
    revalidating: bool,
    kind: AttachKind,
) -> Result<Option<ValidatedAttach>, T3Error> {
    let row = sqlx::query(
        "SELECT c.id AS capability_id, c.work_session_id, c.mode, c.kind, \
                CASE WHEN c.kind = 'display' THEN ws.display_id ELSE ws.pty_id END \
                  AS target_id, \
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
            AND c.kind = $5 \
            AND ws.status IN ('running', 'idle') \
            AND h.revoked_at IS NULL \
            AND ( \
              ( \
                c.kind = 'pty' \
                AND ws.pty_id IS NOT NULL \
                AND ws.attach_endpoint IS NOT NULL \
              ) \
              OR ( \
                c.kind = 'display' \
                AND ws.display_id IS NOT NULL \
                AND ws.display_endpoint IS NOT NULL \
                AND (h.capabilities->>$6)::boolean IS TRUE \
              ) \
            ) \
            AND ( \
              (c.mode = 'controller' AND c.owner_member_id = ws.member_id) \
              OR ( \
                c.mode = 'observer' \
                AND ( \
                  ws.observation = 'open' \
                  OR (c.kind = 'display' AND c.owner_member_id = ws.member_id) \
                ) \
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
    .bind(kind.as_db_label())
    .bind(HOST_DISPLAY_CAPABILITY_KEY)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let mode_label: String = row.try_get("mode")?;
    // An unknown mode is a row this build cannot reason about; refusing beats
    // guessing a grade that decides whether stdin is allowed.
    let Some(mode) = AttachMode::from_db_label(&mode_label) else {
        return Ok(None);
    };
    let kind_label: String = row.try_get("kind")?;
    // Same reasoning one axis over: an unknown kind is a row that names a
    // surface this build has never heard of, and guessing which one would hand a
    // host the wrong stream's identifier.
    let Some(kind) = AttachKind::from_db_label(&kind_label) else {
        return Ok(None);
    };
    // Belt and braces for the boundary 075 exists to hold: a display row that
    // somehow reached `controller` is refused here too, so the lock survives a
    // CHECK being dropped by a future migration without this line being noticed.
    if !kind.permits_mode(mode) {
        return Ok(None);
    }
    Ok(Some(ValidatedAttach {
        capability_id: row.try_get("capability_id")?,
        work_session_id: row.try_get("work_session_id")?,
        target_id: row.try_get("target_id")?,
        expires_at: row.try_get("expires_at_iso")?,
        mode,
        kind,
    }))
}

// ---------------------------------------------------------------------------
// display binding — the host-signed publish path (LIVE-1)
// ---------------------------------------------------------------------------

/// The session row a display-binding publish is judged against.
///
/// Ports the shape Swift reads before writing a PTY binding
/// (`WorkSessionRoutes.swift:1583-1620`): the owning host, the status, and
/// whatever binding is already there — because publishing is **once**, and the
/// second call has to be able to tell "the same daemon said the same thing
/// again" from "something else is claiming this session's screen".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayBindingTarget {
    /// The host the session is bound to. The signer must BE this host.
    pub host_id: Uuid,
    pub status: String,
    pub host_revoked: bool,
    pub host_display_capable: bool,
    /// The raw stored pair, **not** re-validated — a publish decision compares
    /// what is stored against what is offered, and a stored value that no longer
    /// parses must still block a different one rather than look absent.
    pub existing: Option<(String, String)>,
}

/// Lock the session and its host for a display-binding publish.
///
/// `FOR UPDATE OF ws, h` for [`lock_attach_target_in_tx`]'s reason: the decision
/// reads both rows, and a concurrent host revoke landing between the read and
/// the UPDATE would publish a screen on a host that is already gone.
pub async fn lock_display_binding_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<DisplayBindingTarget>, T3Error> {
    let row = sqlx::query(
        "SELECT ws.host_id, ws.status, ws.display_id, ws.display_endpoint, \
                (h.revoked_at IS NOT NULL) AS host_revoked, \
                ((h.capabilities->>$3)::boolean IS TRUE) AS host_display_capable \
           FROM work_session ws \
           JOIN work_host h \
             ON h.id = ws.host_id \
            AND h.workspace_id = ws.workspace_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2 \
          FOR UPDATE OF ws, h",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(HOST_DISPLAY_CAPABILITY_KEY)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let display_id: Option<String> = row.try_get("display_id")?;
    let display_endpoint: Option<String> = row.try_get("display_endpoint")?;
    Ok(Some(DisplayBindingTarget {
        host_id: row.try_get("host_id")?,
        status: row.try_get("status")?,
        host_revoked: row.try_get("host_revoked")?,
        host_display_capable: row.try_get("host_display_capable")?,
        existing: match (display_id, display_endpoint) {
            (Some(id), Some(endpoint)) => Some((id, endpoint)),
            // `work_session_remote_display_pair_ck` makes a half-set pair
            // unrepresentable; treating anything else as absent is safe.
            _ => None,
        },
    }))
}

impl DisplayBindingTarget {
    /// Whether the offered binding is byte-identical to the stored one — the
    /// idempotent replay a daemon produces when it restarts and re-publishes.
    pub fn already_bound_to(&self, binding: &RemoteDisplayBinding) -> bool {
        self.existing.as_ref().is_some_and(|(id, endpoint)| {
            id == &binding.display_id && endpoint == &binding.display_endpoint
        })
    }

    /// Whether a *different* binding is already published. Publishing over it is
    /// Swift's 409: two producers claiming one session's screen is a state the
    /// ledger cannot describe, and picking a winner silently would point half
    /// the observers at a stream that is not this session.
    pub fn conflicts_with(&self, binding: &RemoteDisplayBinding) -> bool {
        self.existing.is_some() && !self.already_bound_to(binding)
    }
}

/// Write the display binding (075's two columns).
///
/// The `status` clause is repeated here even though the caller checked it under
/// the same lock: this statement is the only writer of these columns, and a
/// guard that lives only in the caller is a guard the next caller does not have.
/// `Ok(false)` means the row moved out of `running|idle` and the caller answers
/// Swift's 409 rather than reporting a write that did not happen.
pub async fn write_display_binding_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    binding: &RemoteDisplayBinding,
) -> Result<bool, T3Error> {
    let updated = sqlx::query(
        "UPDATE work_session \
            SET display_id = $3, display_endpoint = $4 \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND status IN ('running', 'idle')",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(&binding.display_id)
    .bind(&binding.display_endpoint)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(updated == 1)
}

/// PTY twin of [`write_display_binding_in_tx`] — Swift `bindRemotePTY` update
/// (`WorkSessionRoutes.swift:1627-1635`). Same `running|idle` guard: a binding
/// on an ended session is a pointer at a machine that is no longer serving.
pub async fn write_remote_pty_binding_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    binding: &RemotePtyBinding,
) -> Result<bool, T3Error> {
    let updated = sqlx::query(
        "UPDATE work_session \
            SET pty_id = $3, attach_endpoint = $4 \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND status IN ('running', 'idle')",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(&binding.pty_id)
    .bind(&binding.attach_endpoint)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(updated == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display_binding(id: &str, endpoint: &str) -> RemoteDisplayBinding {
        RemoteDisplayBinding {
            display_id: id.into(),
            display_endpoint: endpoint.into(),
        }
    }

    #[test]
    fn attach_kinds_match_the_check_constraint_vocabulary() {
        for kind in [AttachKind::Pty, AttachKind::Display] {
            assert_eq!(
                AttachKind::from_db_label(kind.as_db_label()),
                Some(kind),
                "075 allows exactly these two"
            );
        }
        assert!(AttachKind::from_db_label("vnc").is_none());
        assert!(AttachKind::from_db_label("PTY").is_none());
    }

    /// LIVE-3 replaced the LIVE-1 boundary rather than removing it. Both kinds
    /// carry both grades now (076 dropped
    /// `terminal_attach_display_observer_ck`), and what a display controller
    /// grant costs — owner-only issuance, a control window, and the agent's
    /// access to the session refused while it stands — lives in
    /// `routes::display_attach` and [`crate::display_control`] where the
    /// question can actually be answered.
    #[test]
    fn both_kinds_carry_both_grades_since_live3() {
        for kind in [AttachKind::Pty, AttachKind::Display] {
            assert!(kind.permits_mode(AttachMode::Observer));
            assert!(
                kind.permits_mode(AttachMode::Controller),
                "ADR-0004 증보 3 opened display control; 076 dropped the CHECK \
                 that made it unrepresentable"
            );
        }
    }

    #[test]
    fn display_binding_requires_both_halves_and_the_same_url_grammar() {
        assert!(validated_display_binding(None, None).is_none());
        assert!(validated_display_binding(Some("display-1"), None).is_none());
        assert!(validated_display_binding(None, Some("wss://host/signal")).is_none());
        assert_eq!(
            validated_display_binding(Some("display-1"), Some("wss://host.example/signal")),
            Some(display_binding("display-1", "wss://host.example/signal"))
        );
        // 075 copied 023's CHECKs, so every refusal the PTY pair makes is made
        // here too — a credentialed signalling URL is exactly as unacceptable.
        assert!(validated_display_binding(
            Some("display-1"),
            Some("wss://user:pw@host.example/signal")
        )
        .is_none());
        assert!(
            validated_display_binding(Some("display-1"), Some("wss://host.example/s?t=1"))
                .is_none()
        );
        assert!(
            validated_display_binding(Some("-bad"), Some("wss://host.example/signal")).is_none()
        );
        assert!(
            validated_display_binding(Some("display-1"), Some("ws://host.example/signal"))
                .is_none()
        );
    }

    #[test]
    fn parse_remote_pty_binding_names_the_half_that_failed() {
        assert_eq!(parse_remote_pty_binding(None, None), Ok(None));
        assert_eq!(
            parse_remote_pty_binding(Some("pty"), None),
            Err(PtyBindingParseError::MissingHalf)
        );
        assert_eq!(
            parse_remote_pty_binding(None, Some("wss://host.example/pty")),
            Err(PtyBindingParseError::MissingHalf)
        );
        assert_eq!(
            parse_remote_pty_binding(Some("-bad"), Some("wss://host.example/pty")),
            Err(PtyBindingParseError::InvalidPtyId)
        );
        assert_eq!(
            parse_remote_pty_binding(Some("pty"), Some("ws://host.example/pty")),
            Err(PtyBindingParseError::InvalidEndpoint)
        );
        assert_eq!(
            parse_remote_pty_binding(Some("pty-1"), Some("wss://host.example/pty")),
            Ok(Some(RemotePtyBinding {
                pty_id: "pty-1".into(),
                attach_endpoint: "wss://host.example/pty".into(),
            }))
        );
        assert_eq!(
            PtyBindingParseError::MissingHalf.message(),
            "ptyId and attachEndpoint must be provided together"
        );
        assert_eq!(
            PtyBindingParseError::InvalidEndpoint.message(),
            "attachEndpoint must be a credential-free HTTPS or WSS URL"
        );
    }

    #[test]
    fn a_display_needs_a_binding_and_a_host_that_advertises_one() {
        let target = |bound: bool, capable: bool, status: &str, revoked: bool| AttachTarget {
            owner_member_id: Uuid::from_u128(1),
            host_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            status: status.to_string(),
            observation: "open".to_string(),
            host_revoked: revoked,
            binding: None,
            display_binding: bound.then(|| display_binding("display", "wss://host.example/signal")),
            host_display_capable: capable,
        };
        assert!(target(true, true, "running", false).is_display_attachable());
        assert!(target(true, true, "idle", false).is_display_attachable());
        assert!(
            !target(true, false, "running", false).is_display_attachable(),
            "fail-closed: a host that never advertised a display has none — this \
             is also what keeps BYOC out without policy naming a provider"
        );
        assert!(!target(false, true, "running", false).is_display_attachable());
        assert!(!target(true, true, "running", true).is_display_attachable());
        assert!(!target(true, true, "ended", false).is_display_attachable());
        assert!(!target(true, true, "orphaned", false).is_display_attachable());
        // The two kinds are independent: a screen does not imply a terminal.
        assert!(!target(true, true, "running", false).is_attachable());
    }

    #[test]
    fn republishing_the_same_display_binding_is_not_a_conflict() {
        let offered = display_binding("display-1", "wss://host.example/signal");
        let bound = |existing: Option<(&str, &str)>| DisplayBindingTarget {
            host_id: Uuid::from_u128(2),
            status: "running".into(),
            host_revoked: false,
            host_display_capable: true,
            existing: existing.map(|(id, endpoint)| (id.to_string(), endpoint.to_string())),
        };
        let fresh = bound(None);
        assert!(!fresh.already_bound_to(&offered));
        assert!(
            !fresh.conflicts_with(&offered),
            "an empty slot is not a rival"
        );

        let same = bound(Some(("display-1", "wss://host.example/signal")));
        assert!(same.already_bound_to(&offered));
        assert!(
            !same.conflicts_with(&offered),
            "a restarted daemon republishing its own binding is idempotent"
        );

        for other in [
            ("display-2", "wss://host.example/signal"),
            ("display-1", "wss://other.example/signal"),
        ] {
            let rival = bound(Some(other));
            assert!(!rival.already_bound_to(&offered));
            assert!(
                rival.conflicts_with(&offered),
                "a second producer claiming this screen is a 409, not a silent overwrite"
            );
        }
    }

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
    fn attach_target_id_matches_the_check_constraint() {
        assert!(is_valid_attach_target_id("a"));
        assert!(is_valid_attach_target_id("A0._:-"));
        assert!(is_valid_attach_target_id(&format!("a{}", "b".repeat(127))));
        assert!(!is_valid_attach_target_id(""));
        assert!(!is_valid_attach_target_id("-leading"));
        assert!(!is_valid_attach_target_id("has space"));
        assert!(
            !is_valid_attach_target_id(&format!("a{}", "b".repeat(128))),
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
            display_binding: None,
            host_display_capable: false,
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
