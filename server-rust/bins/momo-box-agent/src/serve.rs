//! The box-agent's network side (ADR-0197 D5, M4 증보 2): **outbound only**, no listener.
//!
//! ```text
//!  register ──► POST …/cloud-boxes/{box}/agent/register      (proves the pairing code with an HMAC; the code is never sent)
//!  listen   ──► GET  …/work-hosts/{host}/cloud-box/listen    (WebSocket, host-signed v2): the server says {"t":"attach","session":…}
//!  session  ──► GET  …/work-hosts/{host}/cloud-box/relay/{s} (WebSocket, host-signed v2): bytes only, one per attach
//! ```
//!
//! **Every security decision is the protocol's (`momo-blind-pty`), made here, in the box.** The relay is a pipe: the
//! handshake (`Hello`/`Challenge`/`Auth`/`Ready`), the owner-device signature check, the device list, the one-time
//! challenge store and the AEAD all run inside [`crate::host::BoxHost`] and its [`crate::host::Attachment`]. Nothing
//! in this module consults, trusts or even reads a server verdict: a server that says "authorised" for a device that
//! is not on the owner's list gets no `Challenge`, and a server posing as a device gets no session (S2's red tests,
//! repeated against the real routes in `momo-box-e2e`).
//!
//! The PTY and the protocol live on plain threads (the PTY read polls, the protocol is synchronous); this module is
//! the async glue between a WebSocket and a thread. The box also holds its own limits (session length, idle), so
//! a server that fails to end a session does not keep a terminal open.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt as _, StreamExt as _};
use momo_blind_pty::codec::{Auth, Hello};
use serde_json::Value;
use tokio::sync::{mpsc as async_mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::host::{BoxHost, Inbound};

/// Largest relayed message: `counter 8 + kind 1 + payload ≤ 16 384 + tag 16`. Anything larger is not a frame.
pub const MAX_MESSAGE: usize = 16_409;

/// What the agent was told about the server and itself.
#[derive(Debug, Clone)]
pub struct ServeConfig {
    /// `https://…` (or `http://…` in development): scheme becomes `wss`/`ws` for the sockets.
    pub server_url: String,
    pub workspace_id: Uuid,
    pub host_id: Uuid,
    pub limits: BoxLimits,
}

/// The box's own bounds, independent of the server's.
#[derive(Debug, Clone, Copy)]
pub struct BoxLimits {
    /// A session older than this ends (ADR-0197 D5: 8 hours).
    pub max_session: Duration,
    /// No frame in either direction for this long ends it.
    pub idle: Duration,
    /// How long the handshake may take from the first byte to `Ready`.
    pub handshake: Duration,
    /// PTY read poll, milliseconds (the input latency floor).
    pub poll_ms: i32,
}

impl Default for BoxLimits {
    fn default() -> Self {
        BoxLimits {
            max_session: Duration::from_secs(8 * 3600),
            idle: Duration::from_secs(30 * 60),
            handshake: Duration::from_secs(20),
            poll_ms: 20,
        }
    }
}

/// Why [`run`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Shutdown,
    /// The spawn helper stopped answering (L-A). The agent holds no capability to start another, so it ends its
    /// serving cleanly once no session is attached and the box entry starts it again, helper included.
    HelperPoisoned,
}

/// Where the nonce store goes after every `Auth` (the box's persistence, via the fs gate).
pub type NonceSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

// ---------------------------------------------------------------------------
// signed upgrade
// ---------------------------------------------------------------------------

fn ws_base(server_url: &str) -> String {
    let trimmed = server_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// The headers of a v2-signed `GET` (no query, empty body: the signed path is the whole of what is covered).
pub fn signed_headers(
    key: &SigningKey,
    workspace_id: Uuid,
    host_id: Uuid,
    path: &str,
    sent_at_ms: i64,
    request_id: Uuid,
) -> Vec<(&'static str, String)> {
    let payload = momo_wire::request_payload(
        "GET",
        path,
        workspace_id,
        host_id,
        sent_at_ms,
        &momo_wire::sha256_hex(&[]),
        request_id,
    );
    let signature = BASE64.encode(ed25519_dalek::Signer::sign(key, &payload).to_bytes());
    vec![
        ("Authorization", format!("MomoHost {host_id}")),
        ("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string()),
        ("X-Momo-Work-Host-Signature", signature),
        ("X-Momo-Work-Host-Request-ID", request_id.to_string()),
    ]
}

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn connect_signed(
    cfg: &ServeConfig,
    key: &SigningKey,
    path: &str,
) -> Result<Socket, String> {
    let url = format!("{}{}", ws_base(&cfg.server_url), path);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    for (name, value) in signed_headers(key, cfg.workspace_id, cfg.host_id, path, now_ms(), Uuid::new_v4())
    {
        request.headers_mut().insert(
            name,
            value.parse().map_err(|_| "header value".to_string())?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (socket, _) = tokio_tungstenite::connect_async_with_config(request, Some(config), false)
        .await
        .map_err(|e| e.to_string())?;
    Ok(socket)
}

// ---------------------------------------------------------------------------
// one attached session: a thread that owns the protocol and the PTY
// ---------------------------------------------------------------------------

struct SessionIo {
    inbound: mpsc::Receiver<Vec<u8>>,
    outbound: async_mpsc::Sender<Vec<u8>>,
}

fn send_out(io: &SessionIo, bytes: Vec<u8>) -> bool {
    io.outbound.blocking_send(bytes).is_ok()
}

/// Everything one attach does, start to end. Returns when the session is over for any reason; dropping the
/// channels is what closes the WebSocket.
fn session_thread(
    host: Arc<Mutex<BoxHost>>,
    io: SessionIo,
    limits: BoxLimits,
    nonces: NonceSink,
    poisoned: Arc<AtomicBool>,
) {
    let started = Instant::now();
    // 1. Hello → Challenge. A device that is not on the owner's list gets no challenge at all.
    let Ok(first) = io.inbound.recv_timeout(limits.handshake) else {
        return;
    };
    let Ok(hello) = Hello::from_bytes(&first) else {
        return;
    };
    let challenge = match host.lock().map(|mut h| h.on_hello(hello)) {
        Ok(Ok(challenge)) => challenge,
        _ => return,
    };
    if !send_out(&io, challenge.to_bytes()) {
        return;
    }
    // 2. Auth → Ready. The box verifies the owner device's signature itself.
    let remaining = limits.handshake.saturating_sub(started.elapsed());
    let Ok(second) = io.inbound.recv_timeout(remaining) else {
        return;
    };
    let Ok(auth) = Auth::from_bytes(&second) else {
        return;
    };
    let answered = match host.lock() {
        Ok(mut h) => {
            let answered = h.on_auth(auth);
            // The spent-challenge store survives a restart (L11): written before the session can do anything.
            if answered.is_ok() {
                if let Some(bytes) = h.nonce_store_bytes() {
                    nonces(bytes);
                }
            }
            answered
        }
        Err(_) => return,
    };
    let (mut attachment, ready) = match answered {
        Ok(done) => done,
        Err(_) => return,
    };
    if !send_out(&io, ready) {
        return;
    }
    // 3. Frames and PTY output until anything ends it.
    let mut last_activity = Instant::now();
    loop {
        if started.elapsed() > limits.max_session || last_activity.elapsed() > limits.idle {
            return;
        }
        match io.inbound.recv_timeout(Duration::from_millis(1)) {
            Ok(frame) => {
                last_activity = Instant::now();
                match attachment.on_frame(&frame) {
                    Ok(Inbound::Closed) => return,
                    Ok(_) => {}
                    Err(error) => {
                        // A helper that cannot give a terminal is dead for this agent (L-A): say so, end this
                        // session; the agent restarts once nothing is attached.
                        if host.lock().is_ok_and(|h| h.helper_poisoned()) {
                            poisoned.store(true, Ordering::SeqCst);
                        }
                        tracing_log(&format!("session ends: {}", error_kind(&error)));
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        match attachment.pump(limits.poll_ms) {
            Ok(frames) => {
                if !frames.is_empty() {
                    last_activity = Instant::now();
                }
                for frame in frames {
                    if !send_out(&io, frame) {
                        return;
                    }
                }
            }
            Err(_) => return,
        }
        if attachment.is_finished() {
            return;
        }
    }
}

/// A static word for a session error. Never the error's own text: it could carry a terminal byte.
fn error_kind(error: &crate::host::HostError) -> &'static str {
    use crate::host::HostError;
    match error {
        HostError::Protocol(_) => "protocol",
        HostError::Pty(_) => "pty",
        HostError::NotOpened => "not_opened",
        HostError::BadFrame => "bad_frame",
        _ => "other",
    }
}

/// The agent logs words, never bytes: stderr is the container's only log and the PTY's bytes must never reach it.
fn tracing_log(message: &str) {
    eprintln!("momo-box-agent: {message}");
}

/// Bridge one session WebSocket to a session thread.
async fn run_session(
    cfg: ServeConfig,
    key: SigningKey,
    session: Uuid,
    host: Arc<Mutex<BoxHost>>,
    nonces: NonceSink,
    poisoned: Arc<AtomicBool>,
) {
    let path = format!(
        "/v1/workspaces/{}/work-hosts/{}/cloud-box/relay/{}",
        cfg.workspace_id, cfg.host_id, session
    );
    let Ok(socket) = connect_signed(&cfg, &key, &path).await else {
        tracing_log("could not open a session socket");
        return;
    };
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::sync_channel::<Vec<u8>>(64);
    let (out_tx, mut out_rx) = async_mpsc::channel::<Vec<u8>>(64);
    let limits = cfg.limits;
    let worker = std::thread::spawn(move || {
        session_thread(
            host,
            SessionIo {
                inbound: in_rx,
                outbound: out_tx,
            },
            limits,
            nonces,
            poisoned,
        );
    });
    loop {
        tokio::select! {
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        if bytes.len() > MAX_MESSAGE || in_tx.try_send(bytes.to_vec()).is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    // Text, a close or an error ends the session.
                    _ => break,
                }
            }
            outgoing = out_rx.recv() => {
                match outgoing {
                    Some(bytes) => {
                        if sink.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    // The thread is done: close the socket.
                    None => break,
                }
            }
        }
    }
    drop(in_tx);
    let _ = sink.send(Message::Close(None)).await;
    // The thread ends because its channels closed; do not block the runtime on it.
    let _ = tokio::task::spawn_blocking(move || {
        let _ = worker.join();
    })
    .await;
}

// ---------------------------------------------------------------------------
// the listen loop
// ---------------------------------------------------------------------------

/// Parse a listen-socket notice. Anything that is not an attach notice with a UUID is ignored.
pub fn attach_notice(text: &str) -> Option<Uuid> {
    let value: Value = serde_json::from_str(text).ok()?;
    if value.get("t")?.as_str()? != "attach" {
        return None;
    }
    Uuid::parse_str(value.get("session")?.as_str()?).ok()
}

/// Listen for attach notices until `shutdown` or until the spawn helper dies. Reconnects with a short, capped
/// backoff; a refused signature (the host was revoked or the box stopped) keeps retrying quietly, because a
/// restarted box has to find its way back.
pub async fn run(
    cfg: ServeConfig,
    key: SigningKey,
    host: Arc<Mutex<BoxHost>>,
    nonces: NonceSink,
    mut shutdown: watch::Receiver<bool>,
) -> Exit {
    let poisoned = Arc::new(AtomicBool::new(false));
    let path = format!(
        "/v1/workspaces/{}/work-hosts/{}/cloud-box/listen",
        cfg.workspace_id, cfg.host_id
    );
    let mut backoff = Duration::from_millis(500);
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        if *shutdown.borrow() {
            return Exit::Shutdown;
        }
        if poisoned.load(Ordering::SeqCst) {
            // Wait for the sessions to end, then hand back to the entry (it starts a new helper with the
            // capabilities this process no longer has).
            let deadline = Instant::now() + Duration::from_secs(10);
            while !tasks.is_empty() && Instant::now() < deadline {
                let _ = tokio::time::timeout(Duration::from_millis(200), tasks.join_next()).await;
            }
            return Exit::HelperPoisoned;
        }
        match connect_signed(&cfg, &key, &path).await {
            Ok(mut socket) => {
                backoff = Duration::from_millis(500);
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => {
                            let _ = socket.close(None).await;
                            return Exit::Shutdown;
                        }
                        message = socket.next() => {
                            match message {
                                Some(Ok(Message::Text(text))) => {
                                    if let Some(session) = attach_notice(text.as_str()) {
                                        tasks.spawn(run_session(
                                            cfg.clone(),
                                            key.clone(),
                                            session,
                                            host.clone(),
                                            nonces.clone(),
                                            poisoned.clone(),
                                        ));
                                    }
                                }
                                Some(Ok(_)) => {}
                                _ => break,
                            }
                            // Reap finished sessions and look at the helper.
                            while tasks.try_join_next().is_some() {}
                            if poisoned.load(Ordering::SeqCst) {
                                break;
                            }
                        }
                    }
                }
            }
            Err(_) => {
                tokio::select! {
                    _ = shutdown.changed() => return Exit::Shutdown,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(15));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_is_an_attach_with_a_uuid_and_nothing_else() {
        let id = Uuid::new_v4();
        assert_eq!(
            attach_notice(&format!(r#"{{"t":"attach","session":"{id}"}}"#)),
            Some(id)
        );
        for bad in [
            "",
            "not json",
            r#"{"t":"detach","session":"00000000-0000-0000-0000-000000000000"}"#,
            r#"{"t":"attach"}"#,
            r#"{"t":"attach","session":"nope"}"#,
            r#"["attach"]"#,
        ] {
            assert_eq!(attach_notice(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_scheme_becomes_a_websocket_scheme() {
        assert_eq!(ws_base("https://oort.example/"), "wss://oort.example");
        assert_eq!(ws_base("http://127.0.0.1:8080"), "ws://127.0.0.1:8080");
    }

    #[test]
    fn a_signed_upgrade_verifies_under_the_servers_verifier_for_exactly_its_path() {
        let key = SigningKey::from_bytes(&[5u8; 32]);
        let (ws, host, rid) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let path = format!("/v1/workspaces/{ws}/work-hosts/{host}/cloud-box/listen");
        let headers = signed_headers(&key, ws, host, &path, 1_790_000_000_000, rid);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
                .unwrap()
        };
        assert_eq!(get("Authorization"), format!("MomoHost {host}"));
        let public = BASE64.encode(key.verifying_key().to_bytes());
        let verify = |method: &str, path: &str| {
            momo_wire::verify_work_host_request(
                &public,
                &get("X-Momo-Work-Host-Signature"),
                method,
                path,
                ws,
                host,
                1_790_000_000_000,
                &momo_wire::sha256_hex(&[]),
                rid,
            )
        };
        assert!(verify("GET", &path));
        assert!(!verify("POST", &path), "another method");
        assert!(!verify("GET", &format!("{path}x")), "another path");
    }
}
