//! The blind relay (ADR-0197 D5, M4 증보 2): the server's half of the personal-cloud-box terminal.
//!
//! **What this module is allowed to know.** It pairs two WebSockets (the owner's device and the box-agent
//! inside the box) and moves their binary messages from one to the other **unread**. It never imports the
//! protocol crate (`isolation.rs` keeps it that way), never opens a message, never holds a key, and logs
//! nothing derived from a message: sizes and counts are the whole of what it measures. After the first
//! device message (whose SHA-256 must equal the `Hello` the signed attach control bound) a message is
//! just a `Vec<u8>` with a length.
//!
//! **Authorization is not a one-time check.** [`RelayHub::open_session`] is called once the route has verified
//! the owner device's signature in a short database transaction; from then on no transaction or RLS context
//! is held while a socket lives. A supervisor re-reads the facts that made the attach lawful — device key
//! live, member active, box owner unchanged, box running, host not revoked, the instance switch on — on a short
//! timer and **immediately** when a route that changes one of them calls [`RelayHub::kick`], and ends the session
//! (both sockets) the moment one stops holding. The relay is also bounded: message size, queue depth with
//! back-pressure (never a dropped message — a gap kills a session by design), a stall timeout, a per-direction
//! rate, sessions per box, and a cap on sessions that have not finished their handshake.
//!
//! **Limits.** The registry lives in this process's memory: both sockets of a session must arrive at the same
//! server process (one API instance, or sticky routing). That is a deployment fact the ADR amendment records.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use momo_auth::device_key::load_device_key_in_tx;
use momo_auth::{active_workspace_role, WorkspaceRole};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, PgPool};
use momo_settings::cloud_box::BoxState;
use momo_settings::cloud_box_relay::attach_context_in_tx;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch, Notify};
use uuid::Uuid;

/// One relayed WebSocket message, at most. `counter 8 + kind 1 + payload ≤ 16 384 + tag 16` = 16 409 bytes is
/// the largest protocol frame (`momo_blind_pty::MAX_PAYLOAD + 25`, asserted by `momo-box-e2e`); every
/// handshake message is smaller. A larger message ends the session.
pub const MAX_RELAY_MESSAGE: usize = 16_409;
/// The `Hello` the signed attach control binds is 115 bytes; the route refuses anything past this before hashing.
pub const MAX_HELLO_BYTES: usize = 256;
/// Box → device messages that complete the handshake (`Challenge`, `Ready`). Counting them is not reading them.
const HANDSHAKE_BOX_MESSAGES: u32 = 2;
/// The audit schema of a relay session row.
pub const RELAY_AUDIT_SCHEMA: &str = "momo.cloud_box.relay.v1";

/// Every limit, with the ADR's defaults. Tests shrink them.
#[derive(Debug, Clone)]
pub struct RelayLimits {
    pub max_message: usize,
    /// Messages a direction may have queued; a full queue makes the sender wait (back-pressure).
    pub queue_messages: usize,
    /// How long a sender may wait on a full queue / a client may refuse a write before the session ends.
    pub stall_timeout: Duration,
    /// Messages per second per direction.
    pub messages_per_second: u32,
    pub max_sessions_per_box: usize,
    /// Sessions of one member that have not finished their handshake (pre-authentication).
    pub pending_per_member: usize,
    pub pending_global: usize,
    pub ticket_ttl: Duration,
    pub handshake_deadline: Duration,
    pub max_session: Duration,
    pub idle: Duration,
    /// The supervisor's backstop interval (a `kick` wakes it at once).
    pub recheck: Duration,
    /// The box-agent's listen socket is replaced only if silent this long (a cloned volume must not displace it).
    pub listener_silence: Duration,
    pub ping_interval: Duration,
}

impl Default for RelayLimits {
    fn default() -> Self {
        RelayLimits {
            max_message: MAX_RELAY_MESSAGE,
            queue_messages: 32,
            stall_timeout: Duration::from_secs(10),
            messages_per_second: 2_000,
            max_sessions_per_box: 2,
            pending_per_member: 3,
            pending_global: 64,
            ticket_ttl: Duration::from_secs(30),
            handshake_deadline: Duration::from_secs(20),
            max_session: Duration::from_secs(8 * 3600),
            idle: Duration::from_secs(30 * 60),
            recheck: Duration::from_secs(2),
            listener_silence: Duration::from_secs(45),
            ping_interval: Duration::from_secs(15),
        }
    }
}

/// Why a session ended. Static words only: they reach the audit row and the WebSocket close reason, and
/// nothing from a message can be in either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    PeerClosed,
    DeviceRevoked,
    MemberInactive,
    OwnerChanged,
    BoxNotRunning,
    BoxGone,
    HostRevoked,
    SettingOff,
    MaxLength,
    Idle,
    SlowConsumer,
    MessageTooLarge,
    RateLimited,
    ProtocolViolation,
    HandshakeTimeout,
    HelloMismatch,
    TicketExpired,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::PeerClosed => "peer_closed",
            EndReason::DeviceRevoked => "device_revoked",
            EndReason::MemberInactive => "member_inactive",
            EndReason::OwnerChanged => "owner_changed",
            EndReason::BoxNotRunning => "box_not_running",
            EndReason::BoxGone => "box_gone",
            EndReason::HostRevoked => "host_revoked",
            EndReason::SettingOff => "setting_off",
            EndReason::MaxLength => "max_length",
            EndReason::Idle => "idle",
            EndReason::SlowConsumer => "slow_consumer",
            EndReason::MessageTooLarge => "message_too_large",
            EndReason::RateLimited => "rate_limited",
            EndReason::ProtocolViolation => "protocol_violation",
            EndReason::HandshakeTimeout => "handshake_timeout",
            EndReason::HelloMismatch => "hello_mismatch",
            EndReason::TicketExpired => "ticket_expired",
        }
    }

    /// WebSocket close code: 1000 for an ordinary end, 1008 (policy) for an authorization end, 1009 too big,
    /// 1013 try-again for pressure.
    fn close_code(self) -> u16 {
        match self {
            EndReason::PeerClosed | EndReason::Idle | EndReason::MaxLength => 1000,
            EndReason::MessageTooLarge => 1009,
            EndReason::SlowConsumer | EndReason::RateLimited => 1013,
            _ => 1008,
        }
    }
}

/// Everything fixed about a session at the moment its attach was authorised.
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub box_id: Uuid,
    pub host_id: Uuid,
    pub member_id: Uuid,
    pub device_key_id: Uuid,
    /// SHA-256 of the `Hello` the signed attach control bound.
    pub hello_sha256: [u8; 32],
}

pub struct OpenParams {
    /// Pre-assigned by the route so the verified signature can be recorded against it in the same
    /// transaction that authorised the attach.
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub box_id: Uuid,
    pub host_id: Uuid,
    pub member_id: Uuid,
    pub device_key_id: Uuid,
    pub hello_sha256: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct Opened {
    pub session_id: Uuid,
    /// Shown once. Only its hash is kept.
    pub ticket: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    Disabled,
    /// No live listen socket for the box host: the box-agent is not connected.
    AgentOffline,
    /// The box already has its maximum sessions.
    BoxBusy,
    TooManyPendingForMember,
    TooManyPendingGlobal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenerRefused {
    /// A live listener already exists for this host (a second connection with one key is refused).
    AlreadyConnected,
}

/// One end of a paired session, handed to a socket task.
pub struct End {
    pub meta: SessionMeta,
    /// Messages to the peer. Awaiting a full queue is the back-pressure.
    pub to_peer: mpsc::Sender<Vec<u8>>,
    pub from_peer: mpsc::Receiver<Vec<u8>>,
    pub cancel: watch::Receiver<Option<EndReason>>,
    pub activity: Arc<AtomicU64>,
    /// Box → device messages seen so far (handshake progress).
    pub box_messages: Arc<AtomicU32>,
    pub is_device: bool,
}

struct SessionEntry {
    meta: SessionMeta,
    ticket_hash: Option<[u8; 32]>,
    created: Instant,
    started: Instant,
    d2b_tx: mpsc::Sender<Vec<u8>>,
    d2b_rx: Option<mpsc::Receiver<Vec<u8>>>,
    b2d_tx: mpsc::Sender<Vec<u8>>,
    b2d_rx: Option<mpsc::Receiver<Vec<u8>>>,
    cancel: watch::Sender<Option<EndReason>>,
    activity: Arc<AtomicU64>,
    box_messages: Arc<AtomicU32>,
    device_connected: bool,
    box_connected: bool,
}

impl SessionEntry {
    fn handshaken(&self) -> bool {
        self.box_messages.load(Ordering::Relaxed) >= HANDSHAKE_BOX_MESSAGES
    }
}

struct ListenerEntry {
    conn: u64,
    tx: mpsc::Sender<String>,
    last_seen_ms: Arc<AtomicU64>,
}

#[derive(Default)]
struct Inner {
    listeners: HashMap<Uuid, ListenerEntry>,
    sessions: HashMap<Uuid, SessionEntry>,
    next_conn: u64,
}

/// A snapshot row for the supervisor (no channels).
struct Watched {
    meta: SessionMeta,
    started: Instant,
    created: Instant,
    handshaken: bool,
    device_connected: bool,
    activity: Arc<AtomicU64>,
}

/// The only thing the relay measures: how many messages and bytes it forwarded and how many sessions it opened and
/// ended (ADR-0197 D5: 「바이트 수와 시각만 센다」). Numbers; there is no label, no key, no content, no per-session
/// breakdown that could carry one.
#[derive(Debug, Default)]
pub struct RelayStats {
    pub messages_forwarded: AtomicU64,
    pub bytes_forwarded: AtomicU64,
    pub sessions_opened: AtomicU64,
    pub sessions_ended: AtomicU64,
}

pub struct RelayHub {
    stats: RelayStats,
    pool: PgPool,
    limits: RelayLimits,
    enabled: AtomicBool,
    inner: Mutex<Inner>,
    kick: Notify,
    started_at: Instant,
    supervisor_started: AtomicBool,
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

impl RelayHub {
    pub fn new(pool: PgPool, limits: RelayLimits) -> Arc<Self> {
        Arc::new(RelayHub {
            stats: RelayStats::default(),
            pool,
            limits,
            enabled: AtomicBool::new(true),
            inner: Mutex::new(Inner::default()),
            kick: Notify::new(),
            started_at: Instant::now(),
            supervisor_started: AtomicBool::new(false),
        })
    }

    pub fn limits(&self) -> &RelayLimits {
        &self.limits
    }

    pub fn stats(&self) -> &RelayStats {
        &self.stats
    }

    /// The instance switch (runtime). `false` ends every session at the next supervisor pass (immediately
    /// via [`Self::kick`]) and refuses new ones. The workspace-level setting surface is M5's; this is its seam.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        self.kick();
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Something that makes an attach lawful changed (a device key revoked, a member deactivated, a box stopped
    /// or deleted, the switch turned off): re-check every live session now instead of at the next interval.
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means another task panicked mid-update; the maps stay usable.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn mono_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    // ---- the box-agent's listen socket ---------------------------------------------------------

    /// Register the box-agent's listen socket. One per host: a second is refused while the first has been
    /// heard from recently (a volume clone with the same key must not displace the real box).
    pub fn register_listener(
        &self,
        host_id: Uuid,
    ) -> Result<(u64, mpsc::Receiver<String>, Arc<AtomicU64>), ListenerRefused> {
        let mut inner = self.lock();
        let now = self.mono_ms();
        if let Some(existing) = inner.listeners.get(&host_id) {
            let silent = now.saturating_sub(existing.last_seen_ms.load(Ordering::Relaxed));
            if !existing.tx.is_closed() && silent < self.limits.listener_silence.as_millis() as u64
            {
                return Err(ListenerRefused::AlreadyConnected);
            }
        }
        inner.next_conn += 1;
        let conn = inner.next_conn;
        let (tx, rx) = mpsc::channel(8);
        let last_seen = Arc::new(AtomicU64::new(now));
        inner.listeners.insert(
            host_id,
            ListenerEntry {
                conn,
                tx,
                last_seen_ms: last_seen.clone(),
            },
        );
        Ok((conn, rx, last_seen))
    }

    pub fn listener_gone(&self, host_id: Uuid, conn: u64) {
        let mut inner = self.lock();
        if inner.listeners.get(&host_id).is_some_and(|l| l.conn == conn) {
            inner.listeners.remove(&host_id);
        }
    }

    pub fn listener_online(&self, host_id: Uuid) -> bool {
        let inner = self.lock();
        inner.listeners.get(&host_id).is_some_and(|l| {
            !l.tx.is_closed()
                && self.mono_ms().saturating_sub(l.last_seen_ms.load(Ordering::Relaxed))
                    < self.limits.listener_silence.as_millis() as u64
        })
    }

    pub fn touch_listener(last_seen: &AtomicU64, hub: &RelayHub) {
        last_seen.store(hub.mono_ms(), Ordering::Relaxed);
    }

    // ---- sessions ------------------------------------------------------------------------------

    /// The route verified the signed attach control; reserve a session and tell the box-agent.
    pub fn open_session(self: &Arc<Self>, params: OpenParams) -> Result<Opened, OpenError> {
        if !self.enabled() {
            return Err(OpenError::Disabled);
        }
        self.ensure_supervisor();
        let mut inner = self.lock();
        let listener_tx = match inner.listeners.get(&params.host_id) {
            Some(l) if !l.tx.is_closed() => l.tx.clone(),
            _ => return Err(OpenError::AgentOffline),
        };
        let on_box = inner
            .sessions
            .values()
            .filter(|s| s.meta.box_id == params.box_id)
            .count();
        if on_box >= self.limits.max_sessions_per_box {
            return Err(OpenError::BoxBusy);
        }
        let pending: Vec<&SessionEntry> = inner
            .sessions
            .values()
            .filter(|s| !s.handshaken())
            .collect();
        if pending.len() >= self.limits.pending_global {
            return Err(OpenError::TooManyPendingGlobal);
        }
        if pending
            .iter()
            .filter(|s| s.meta.member_id == params.member_id)
            .count()
            >= self.limits.pending_per_member
        {
            return Err(OpenError::TooManyPendingForMember);
        }
        let session_id = params.session_id;
        let mut raw = [0u8; 32];
        if getrandom::getrandom(&mut raw).is_err() {
            return Err(OpenError::Disabled);
        }
        use base64::Engine as _;
        let ticket = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        let notice = json!({"t": "attach", "session": session_id.to_string()}).to_string();
        // The notice goes out before anything is stored: a full or closed listener is "offline".
        if listener_tx.try_send(notice).is_err() {
            return Err(OpenError::AgentOffline);
        }
        self.stats.sessions_opened.fetch_add(1, Ordering::Relaxed);
        let (d2b_tx, d2b_rx) = mpsc::channel(self.limits.queue_messages);
        let (b2d_tx, b2d_rx) = mpsc::channel(self.limits.queue_messages);
        let (cancel, _) = watch::channel(None);
        let now = Instant::now();
        inner.sessions.insert(
            session_id,
            SessionEntry {
                meta: SessionMeta {
                    session_id,
                    workspace_id: params.workspace_id,
                    box_id: params.box_id,
                    host_id: params.host_id,
                    member_id: params.member_id,
                    device_key_id: params.device_key_id,
                    hello_sha256: params.hello_sha256,
                },
                ticket_hash: Some(sha256(ticket.as_bytes())),
                created: now,
                started: now,
                d2b_tx,
                d2b_rx: Some(d2b_rx),
                b2d_tx,
                b2d_rx: Some(b2d_rx),
                cancel,
                activity: Arc::new(AtomicU64::new(self.mono_ms())),
                box_messages: Arc::new(AtomicU32::new(0)),
                device_connected: false,
                box_connected: false,
            },
        );
        Ok(Opened {
            session_id,
            ticket,
            expires_at_ms: now_ms() + self.limits.ticket_ttl.as_millis() as i64,
        })
    }

    /// The device's socket presents its ticket. Every failure is the same `None`.
    pub fn claim_device(
        &self,
        workspace_id: Uuid,
        box_id: Uuid,
        session_id: Uuid,
        ticket: &str,
    ) -> Option<End> {
        let mut inner = self.lock();
        let entry = inner.sessions.get_mut(&session_id)?;
        if entry.meta.workspace_id != workspace_id
            || entry.meta.box_id != box_id
            || entry.device_connected
            || entry.created.elapsed() > self.limits.ticket_ttl
        {
            return None;
        }
        let expected = entry.ticket_hash?;
        if !ct_eq(&expected, &sha256(ticket.as_bytes())) {
            return None;
        }
        // Single use: the hash is gone whether or not the upgrade completes.
        entry.ticket_hash = None;
        entry.device_connected = true;
        let from_peer = entry.b2d_rx.take()?;
        Some(End {
            meta: entry.meta.clone(),
            to_peer: entry.d2b_tx.clone(),
            from_peer,
            cancel: entry.cancel.subscribe(),
            activity: entry.activity.clone(),
            box_messages: entry.box_messages.clone(),
            is_device: true,
        })
    }

    /// The box-agent's session socket. It must be the host the session was authorised for.
    pub fn claim_box(&self, workspace_id: Uuid, host_id: Uuid, session_id: Uuid) -> Option<End> {
        let mut inner = self.lock();
        let entry = inner.sessions.get_mut(&session_id)?;
        if entry.meta.workspace_id != workspace_id
            || entry.meta.host_id != host_id
            || entry.box_connected
        {
            return None;
        }
        entry.box_connected = true;
        let from_peer = entry.d2b_rx.take()?;
        Some(End {
            meta: entry.meta.clone(),
            to_peer: entry.b2d_tx.clone(),
            from_peer,
            cancel: entry.cancel.subscribe(),
            activity: entry.activity.clone(),
            box_messages: entry.box_messages.clone(),
            is_device: false,
        })
    }

    /// End a session: both sockets see the reason and close. Returns whether this call ended it.
    pub fn end(self: &Arc<Self>, session_id: Uuid, reason: EndReason) -> bool {
        let removed = self.lock().sessions.remove(&session_id);
        let Some(entry) = removed else { return false };
        self.stats.sessions_ended.fetch_add(1, Ordering::Relaxed);
        let _ = entry.cancel.send(Some(reason));
        let hub = self.clone();
        let meta = entry.meta;
        let lived = entry.started.elapsed();
        tokio::spawn(async move {
            hub.audit_end(&meta, reason, lived).await;
        });
        true
    }

    pub fn session_count(&self) -> usize {
        self.lock().sessions.len()
    }

    pub fn sessions_of_box(&self, box_id: Uuid) -> usize {
        self.lock()
            .sessions
            .values()
            .filter(|s| s.meta.box_id == box_id)
            .count()
    }

    async fn audit_end(&self, meta: &SessionMeta, reason: EndReason, lived: Duration) {
        let meta = meta.clone();
        let outcome = with_tenant_tx(&self.pool, meta.workspace_id, move |conn| {
            Box::pin(async move {
                // Ids, a static word and a duration. Never a message, a key or a ticket.
                let mut entry = AuditEntry::new(meta.workspace_id, "cloud_box.pty_end")
                    .about(meta.member_id)
                    .target("cloud_box", meta.box_id)
                    .with_schema(
                        RELAY_AUDIT_SCHEMA,
                        json!({
                            "box_id": meta.box_id.to_string(),
                            "session_id": meta.session_id.to_string(),
                            "device_key_id": meta.device_key_id.to_string(),
                            "reason": reason.as_str(),
                            "seconds": lived.as_secs(),
                        }),
                    );
                entry.actor_member_id = None;
                write_audit(conn, &entry).await?;
                Ok::<_, momo_db::DbError>(())
            })
        })
        .await;
        if let Err(error) = outcome {
            tracing::warn!(%error, "cloud box relay: end audit row failed");
        }
    }

    // ---- the supervisor ------------------------------------------------------------------------

    fn ensure_supervisor(self: &Arc<Self>) {
        if self.supervisor_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(hub) = weak.upgrade() else { return };
                let wait = hub.limits.recheck;
                let kick = hub.kick.notified();
                tokio::select! {
                    _ = kick => {}
                    _ = tokio::time::sleep(wait) => {}
                }
                hub.supervise_once().await;
            }
        });
    }

    fn watched(&self) -> Vec<Watched> {
        self.lock()
            .sessions
            .values()
            .map(|s| Watched {
                meta: s.meta.clone(),
                started: s.started,
                created: s.created,
                handshaken: s.handshaken(),
                device_connected: s.device_connected,
                activity: s.activity.clone(),
            })
            .collect()
    }

    /// One pass: time limits locally, then the database facts, one transaction per workspace.
    pub async fn supervise_once(self: &Arc<Self>) {
        let watched = self.watched();
        if watched.is_empty() {
            return;
        }
        let enabled = self.enabled();
        let mut to_check: HashMap<Uuid, Vec<SessionMeta>> = HashMap::new();
        for w in &watched {
            let id = w.meta.session_id;
            if !enabled {
                self.end(id, EndReason::SettingOff);
                continue;
            }
            if !w.device_connected && w.created.elapsed() > self.limits.ticket_ttl {
                self.end(id, EndReason::TicketExpired);
                continue;
            }
            if !w.handshaken && w.created.elapsed() > self.limits.handshake_deadline {
                self.end(id, EndReason::HandshakeTimeout);
                continue;
            }
            if w.started.elapsed() > self.limits.max_session {
                self.end(id, EndReason::MaxLength);
                continue;
            }
            let quiet = self
                .mono_ms()
                .saturating_sub(w.activity.load(Ordering::Relaxed));
            if quiet > self.limits.idle.as_millis() as u64 {
                self.end(id, EndReason::Idle);
                continue;
            }
            to_check
                .entry(w.meta.workspace_id)
                .or_default()
                .push(w.meta.clone());
        }
        for (workspace_id, sessions) in to_check {
            let verdicts = with_tenant_tx(&self.pool, workspace_id, move |conn| {
                Box::pin(async move {
                    let mut out = Vec::with_capacity(sessions.len());
                    for meta in sessions {
                        let reason = recheck(conn, &meta).await?;
                        out.push((meta.session_id, reason));
                    }
                    Ok::<_, momo_db::DbError>(out)
                })
            })
            .await;
            match verdicts {
                Ok(verdicts) => {
                    for (session_id, reason) in verdicts {
                        if let Some(reason) = reason {
                            self.end(session_id, reason);
                        }
                    }
                }
                // A database that cannot answer is not a reason to keep a terminal open forever, but it is
                // not proof of revocation either: retry at the next pass (the time limits still run).
                Err(error) => tracing::warn!(%error, "cloud box relay: recheck failed"),
            }
        }
    }
}

/// The facts that made the attach lawful, read now. `None` = still lawful.
async fn recheck(
    conn: &mut momo_db::PgConnection,
    meta: &SessionMeta,
) -> Result<Option<EndReason>, momo_db::DbError> {
    // 1. The device key: live, and its sign-in lineage still alive.
    match load_device_key_in_tx(conn, meta.device_key_id).await? {
        Some(key) if key.is_live() && key.lineage_live => {}
        _ => return Ok(Some(EndReason::DeviceRevoked)),
    }
    // 2. The member: active, and not demoted to a guest.
    match active_workspace_role(conn, meta.workspace_id, meta.member_id).await? {
        None | Some(WorkspaceRole::Guest) => return Ok(Some(EndReason::MemberInactive)),
        Some(_) => {}
    }
    // 3. The box, its owner and its host.
    let Some(context) = attach_context_in_tx(conn, meta.workspace_id, meta.box_id).await? else {
        return Ok(Some(EndReason::BoxGone));
    };
    if context.box_info.member_id != meta.member_id || context.host_owner != meta.member_id {
        return Ok(Some(EndReason::OwnerChanged));
    }
    if context.host_id != meta.host_id || context.host_revoked {
        return Ok(Some(EndReason::HostRevoked));
    }
    if !matches!(context.box_info.state, BoxState::Running | BoxState::Idle) {
        return Ok(Some(EndReason::BoxNotRunning));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------------------------
// socket tasks
// ---------------------------------------------------------------------------------------------

/// Window counter for the per-direction message rate.
struct RateWindow {
    started: Instant,
    count: u32,
    limit: u32,
}

impl RateWindow {
    fn new(limit: u32) -> Self {
        RateWindow {
            started: Instant::now(),
            count: 0,
            limit,
        }
    }

    /// `false` once the direction exceeded its budget for the current second.
    fn admit(&mut self) -> bool {
        if self.started.elapsed() >= Duration::from_secs(1) {
            self.started = Instant::now();
            self.count = 0;
        }
        self.count += 1;
        self.count <= self.limit
    }
}

/// Drive one socket of a paired session until it ends, then end the session (so the other socket follows).
/// **The loop never inspects a message**: it checks its length, counts it, hashes the very first device
/// message once, and forwards the bytes.
pub async fn run_end(hub: Arc<RelayHub>, mut socket: WebSocket, mut end: End) {
    let limits = hub.limits().clone();
    let mut rate = RateWindow::new(limits.messages_per_second);
    let mut first_device_message = end.is_device;
    let mut ping = tokio::time::interval(limits.ping_interval);
    ping.reset();
    let reason = loop {
        tokio::select! {
            changed = end.cancel.changed() => {
                // The other side (or the supervisor) ended the session.
                let reason = if changed.is_ok() { *end.cancel.borrow() } else { None };
                let reason = reason.unwrap_or(EndReason::PeerClosed);
                send_close(&mut socket, reason).await;
                return;
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break EndReason::PeerClosed };
                match message {
                    Message::Binary(bytes) => {
                        if bytes.len() > limits.max_message {
                            break EndReason::MessageTooLarge;
                        }
                        if !rate.admit() {
                            break EndReason::RateLimited;
                        }
                        if first_device_message {
                            first_device_message = false;
                            // The single place a device message is looked at: it must be the Hello the signed
                            // attach control bound. The bytes are hashed, not parsed.
                            if bytes.len() > MAX_HELLO_BYTES
                                || !ct_eq(&sha256(&bytes), &end.meta.hello_sha256)
                            {
                                break EndReason::HelloMismatch;
                            }
                        }
                        if !end.is_device {
                            end.box_messages.fetch_add(1, Ordering::Relaxed);
                        }
                        end.activity.store(hub.mono_ms(), Ordering::Relaxed);
                        hub.stats.messages_forwarded.fetch_add(1, Ordering::Relaxed);
                        hub.stats.bytes_forwarded.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        // Back-pressure: wait for room; never drop.
                        match tokio::time::timeout(limits.stall_timeout, end.to_peer.send(bytes.to_vec())).await {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => break EndReason::PeerClosed,
                            Err(_) => break EndReason::SlowConsumer,
                        }
                    }
                    Message::Close(_) => break EndReason::PeerClosed,
                    Message::Ping(_) | Message::Pong(_) => {}
                    // Text is not part of the relay protocol on a session socket.
                    Message::Text(_) => break EndReason::ProtocolViolation,
                }
            }
            outgoing = end.from_peer.recv() => {
                let Some(bytes) = outgoing else { break EndReason::PeerClosed };
                end.activity.store(hub.mono_ms(), Ordering::Relaxed);
                match tokio::time::timeout(limits.stall_timeout, socket.send(Message::Binary(bytes.into()))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break EndReason::PeerClosed,
                    Err(_) => break EndReason::SlowConsumer,
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break EndReason::PeerClosed;
                }
            }
        }
    };
    send_close(&mut socket, reason).await;
    hub.end(end.meta.session_id, reason);
}

async fn send_close(socket: &mut WebSocket, reason: EndReason) {
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Close(Some(CloseFrame {
            code: reason.close_code(),
            reason: reason.as_str().into(),
        }))),
    )
    .await;
}

/// The box-agent's listen socket: the server sends `{"t":"attach","session":"…"}` text notices and pings;
/// it reads only to notice the box going away. Nothing the box sends here is stored or forwarded.
pub async fn run_listener(
    hub: Arc<RelayHub>,
    mut socket: WebSocket,
    host_id: Uuid,
    conn: u64,
    mut notices: mpsc::Receiver<String>,
    last_seen: Arc<AtomicU64>,
) {
    let mut ping = tokio::time::interval(hub.limits().ping_interval);
    ping.reset();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    // Any frame, pongs included, proves the box is there.
                    Some(Ok(_)) => RelayHub::touch_listener(&last_seen, &hub),
                }
            }
            notice = notices.recv() => {
                let Some(notice) = notice else { break };
                if tokio::time::timeout(hub.limits().stall_timeout, socket.send(Message::Text(notice.into())))
                    .await
                    .map_or(true, |sent| sent.is_err())
                {
                    break;
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    hub.listener_gone(host_id, conn);
    let _ = socket.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rate_window_admits_its_budget_and_refuses_the_rest_until_the_second_turns() {
        let mut window = RateWindow::new(3);
        assert!(window.admit() && window.admit() && window.admit());
        assert!(!window.admit());
        window.started = Instant::now() - Duration::from_secs(2);
        assert!(window.admit());
    }

    #[test]
    fn constant_time_equality_agrees_with_plain_equality() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    #[test]
    fn every_end_reason_has_a_static_word_and_a_close_code() {
        for reason in [
            EndReason::PeerClosed,
            EndReason::DeviceRevoked,
            EndReason::MemberInactive,
            EndReason::OwnerChanged,
            EndReason::BoxNotRunning,
            EndReason::BoxGone,
            EndReason::HostRevoked,
            EndReason::SettingOff,
            EndReason::MaxLength,
            EndReason::Idle,
            EndReason::SlowConsumer,
            EndReason::MessageTooLarge,
            EndReason::RateLimited,
            EndReason::ProtocolViolation,
            EndReason::HandshakeTimeout,
            EndReason::HelloMismatch,
            EndReason::TicketExpired,
        ] {
            assert!(reason.as_str().chars().all(|c| c.is_ascii_lowercase() || c == '_'));
            assert!((1000..=1015).contains(&reason.close_code()));
        }
    }
}
