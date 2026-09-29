//! Work sessions: one ACP agent process and one task per server session.
//!
//! A spawn goes through the D6 checks in this order, and **nothing is
//! started until each earlier check passed** (the owner check,
//! `ControlLoop::require_owner`, comes before all of them):
//!
//! 1. the label, which becomes the first prompt, is not an adapter command
//!    ([`policy::check_prompt`]); the host is under its session limit; a
//!    resume does not name a session this host already runs;
//! 2. `shell` refused ([`policy::check_remote_tool`]);
//! 3. the tool must be in the host allowlist, which alone decides the binary
//!    and its arguments ([`policy::launch_spec`]);
//! 4. the allowed folder must resolve (`realpath`) to a directory, and carry no
//!    project agent configuration the adapter would apply regardless
//!    ([`policy::check_project_config`]); for Codex, the host's own home is
//!    ready and signed in, and Codex's own `HOME` holds no skill layer
//!    ([`policy::prepare_codex_home`], ADR-0188 §8, #2630 F5); the agent gets
//!    the allowlisted part of the host's environment only (#2630 F1); if this
//!    Mac chose an account for remote work, its profile folder is checked and
//!    becomes `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, or the spawn is refused
//!    ([`crate::profile`], ADR-0191 D1, #3033);
//! 5. ACP `initialize` — the process must be the adapter its entry names
//!    ([`policy::AdapterKind::agent_name`]) — then `session/new` with no MCP
//!    servers and the adapter's isolation switches;
//! 6. the agent must be in the adapter's fixed permission mode, or be
//!    corrected to it and confirm ([`policy::check_session_modes`],
//!    [`policy::check_mode_confirmed`]) — only then is a server session
//!    created, and only after that the first prompt sent.
//!
//! After that the session task owns the agent. It relays the curated event
//! stream ([`crate::projection`]), bridges every `session/request_permission`
//! to its owner (ADR-0188 D5, #3000 — below), reports `idle` when a turn ends
//! and `running` before the next one, and closes the session if the agent ever
//! leaves the fixed mode.
//!
//! ## The permission bridge (ADR-0188 D5)
//!
//! A request that offers an `allow_once` or a `reject_once` is relayed as an
//! `approval.requested` event carrying only those options
//! ([`policy::bridge_options`]); the event's id is the request's one-time
//! nonce. The agent is not answered until one of these happens:
//!
//! * a `permission` control from the owner names that event id and one of the
//!   relayed options with its kind ([`policy::owner_choice`]) — the agent gets
//!   exactly that option. A control naming anything else is refused and the
//!   request keeps waiting; one naming an unknown or answered id is refused
//!   (`permission_request_unknown`) and discarded;
//! * the host's own wait ([`SessionSettings::permission_wait`], longer than
//!   the server's deadline) runs out — the agent's own one-time rejection, and
//!   an `approval.decided` that withdraws the request on the server;
//! * the session ends — `cancelled`, as ACP requires of a client that cancels.
//!
//! A request that offers neither kind, or that the server does not take, is
//! denied at once with the reason on the stream ([`policy::decide_permission`]),
//! exactly as before the bridge existed.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::acp::{AcpConnection, Incoming, RpcFailure, RpcResult, METHOD_NOT_FOUND};
use crate::client::{
    now_ms, AcpEvent, ClientError, CreateSession, HostApi, SessionStatus, WorkControl,
};
use crate::config::ToolEntry;
use crate::policy::{self, AdapterKind, ModeAtOpen, Refusal};
use crate::profile;
use crate::projection::{self, chunk_field, Projection, MAX_FIELD_CHARS};

/// ACP protocol version this client speaks.
pub const ACP_PROTOCOL_VERSION: i64 = 1;
/// ACP's `auth_required` JSON-RPC error code.
const ACP_AUTH_REQUIRED: i64 = -32000;
/// The server's `agent.partial` ceiling (`text_delta` ≤ 4096 bytes).
pub const MAX_EVENT_TEXT_BYTES: usize = 4_096;
/// Coalesced answer text is flushed at this size…
const TEXT_FLUSH_BYTES: usize = 3_000;
/// …or once it has waited this long.
const TEXT_FLUSH_AGE: Duration = Duration::from_millis(400);
const RELAY_TICK: Duration = Duration::from_millis(200);
/// The longest unfinished line (or, past that, unbroken run) a flush holds
/// back — longer than any single credential in practice, large JWTs included.
const MAX_HELD_RUN_BYTES: usize = 16_384;
/// The longest open private-key block the relay holds (#2607 N-5): a real
/// PEM key is a few KiB (RSA-8192 is about 6.5 KiB). Past this the block is
/// sent masked to the end and the text after it flows again.
const MAX_HELD_KEY_BYTES: usize = 16_384;

/// How much of the buffered text a flush before the end of a message may
/// send: only **complete lines**, and nothing from an open private-key block
/// on — the rest may still become one credential with what comes next (a
/// token, a `secret=` value, a URL with a password, a key's next line).
///
/// Bounds (#2607 N-5): an open key block longer than [`MAX_HELD_KEY_BYTES`]
/// is released (masked to the end by the scan); an unfinished line longer
/// than [`MAX_HELD_RUN_BYTES`] keeps only its trailing unbroken run, and a
/// run longer than that is released too.
fn ready_len(text: &str) -> usize {
    let cut = match projection::open_private_key_block(text) {
        Some(start) if text.len() - start > MAX_HELD_KEY_BYTES => return text.len(),
        Some(start) => start,
        None => text.len(),
    };
    let head = &text[..cut];
    let line_start = head.rfind('\n').map_or(0, |newline| newline + 1);
    if head.len() - line_start <= MAX_HELD_RUN_BYTES {
        return line_start;
    }
    let run_start = head
        .char_indices()
        .rev()
        .find(|(_, character)| character.is_whitespace())
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    if head.len() - run_start <= MAX_HELD_RUN_BYTES {
        run_start
    } else {
        cut
    }
}
const TERMINATE_GRACE: Duration = Duration::from_secs(3);
/// After the agent accepted `session/set_mode`, how long the host waits for
/// its report of the new mode when it did not arrive with the answer.
const MODE_CONFIRM_GRACE: Duration = Duration::from_secs(2);
const CANCEL_GRACE: Duration = Duration::from_secs(2);

/// Shown on the session stream when a permission request is refused without
/// reaching the owner (nothing bridgeable on offer, or the server did not take
/// it).
pub const PERMISSION_DENIED_DETAIL: &str =
    "권한 요청을 거부했습니다. 이 요청은 원격 승인으로 보낼 수 없었습니다.";
/// Shown when the owner's decision did not arrive within the host's wait.
pub const PERMISSION_EXPIRED_DETAIL: &str = "권한 요청에 제때 답이 없어 거부했습니다.";
/// The owner interrupted the turn that was asking (#3027): its pending
/// permission requests are answered `cancelled`, as ACP requires of a client
/// that cancels a prompt turn, and withdrawn on the server.
pub const PERMISSION_INTERRUPTED_DETAIL: &str = "지시로 턴을 멈춰 권한 요청을 거뒀습니다.";
/// How long the host keeps an agent's permission request open for its owner:
/// the server's deadline (`momo_t3::work_permission::PERMISSION_REQUEST_TTL_SECONDS`,
/// 600 s) plus a margin, so an in-time decision is never discarded here.
pub const DEFAULT_PERMISSION_WAIT: Duration = Duration::from_secs(630);
/// Shown when the agent leaves the fixed permission mode.
pub const MODE_ESCAPED_DETAIL: &str = "권한 모드가 고정 모드를 벗어나 원격 세션을 닫았습니다.";

/// What the session layer needs from the host configuration.
#[derive(Debug, Clone)]
pub struct SessionSettings {
    pub tools: BTreeMap<String, ToolEntry>,
    pub working_directory: PathBuf,
    pub acp_start_timeout: Duration,
    /// The host's environment at startup; only `policy::AGENT_ENV_ALLOWLIST`
    /// of it reaches an agent (`policy::launch_spec`, #2630 F1).
    pub parent_env: Vec<(String, String)>,
    /// Most sessions (agent processes) this host runs at once (#2602 L-2).
    pub max_sessions: usize,
    /// Codex's host-only home and temp folder (ADR-0188 §8).
    pub codex: policy::CodexHome,
    /// The host state folder, where the desktop's 「원격 작업」 account choice
    /// lives ([`crate::profile`], #3033). Read at every spawn.
    pub state_folder: PathBuf,
    /// How long a bridged permission request waits for its owner
    /// ([`DEFAULT_PERMISSION_WAIT`]).
    pub permission_wait: Duration,
}

/// Most instructions one session keeps queued behind its running turn
/// (#2602 L-2).
pub const MAX_QUEUED_PROMPTS: usize = 16;
/// Room an owner's interrupt still has when the queue is full (#3027): the
/// server has already recorded the signed instruction and spent its nonce, so
/// the off-and-redirect signal must not be the one that bounces. Still
/// bounded, so no stream of controls grows the queue without limit.
pub const MAX_QUEUED_INTERRUPTS: usize = 8;

enum Command {
    Prompt {
        text: String,
        /// The owner's `interrupt` (#3027): cancel the running turn (ACP
        /// `session/cancel`) and go next, ahead of anything queued.
        interrupt: bool,
        reply: oneshot::Sender<Result<(), Refusal>>,
    },
    Kill {
        reply: oneshot::Sender<i32>,
    },
    /// The owner's decision on one bridged permission request (ADR-0188 D5).
    Permission {
        request_event_id: Uuid,
        option_id: String,
        kind: String,
        reply: oneshot::Sender<Result<(), Refusal>>,
    },
}

/// A permission request relayed to the owner and not yet answered.
struct PendingPermission {
    /// The agent's JSON-RPC request id.
    rpc_id: Value,
    /// What the owner may choose — the agent's own one-time options.
    offered: Vec<policy::PermissionOption>,
    deadline: Instant,
}

struct SessionHandle {
    commands: mpsc::Sender<Command>,
    task: JoinHandle<()>,
    /// The spawn label, sent as the first prompt once the spawn ack landed.
    initial_prompt: Option<String>,
}

/// #3118 (R2 H1): the preview hash of every permission request a session
/// relayed and still waits on, by `(session, request event id)`. Written by
/// the session task **before** the request leaves the host, read by the
/// control loop's signature check, so an owner's allow is verified against
/// the preview the host itself read from the agent — never the server's.
#[derive(Clone, Default)]
pub struct PreviewLedger(Arc<Mutex<HashMap<(Uuid, Uuid), String>>>);

impl PreviewLedger {
    fn insert(&self, session_id: Uuid, request_event_id: Uuid, preview_sha256: String) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert((session_id, request_event_id), preview_sha256);
    }

    fn remove(&self, session_id: Uuid, request_event_id: Uuid) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&(session_id, request_event_id));
    }

    /// Drop the entries of sessions that are gone (a task that ended without
    /// its own cleanup — aborted or panicked).
    fn retain_sessions(&self, live: impl Fn(&Uuid) -> bool) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|(session_id, _), _| live(session_id));
    }

    fn get(&self, session_id: Uuid, request_event_id: Uuid) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&(session_id, request_event_id))
            .cloned()
    }
}

pub struct SessionManager {
    api: Arc<dyn HostApi>,
    settings: Arc<SessionSettings>,
    sessions: HashMap<Uuid, SessionHandle>,
    previews: PreviewLedger,
}

impl SessionManager {
    pub fn new(api: Arc<dyn HostApi>, settings: SessionSettings) -> Self {
        Self {
            api,
            settings: Arc::new(settings),
            sessions: HashMap::new(),
            previews: PreviewLedger::default(),
        }
    }

    /// The preview hash this host relayed for `request_event_id` of
    /// `session_id`, while the session still waits on it (#3118). `None`
    /// for a request this host is not waiting on.
    pub fn permission_preview_sha256(
        &self,
        session_id: Uuid,
        request_event_id: Uuid,
    ) -> Option<String> {
        self.previews.get(session_id, request_event_id)
    }

    /// Sessions whose task is still alive.
    pub fn live_sessions(&mut self) -> Vec<Uuid> {
        self.reap();
        self.sessions.keys().copied().collect()
    }

    /// Whether this host is running `session_id`.
    pub fn runs(&mut self, session_id: Uuid) -> bool {
        self.reap();
        self.sessions.contains_key(&session_id)
    }

    /// Forget sessions whose task has finished (the agent exited on its own).
    pub fn reap(&mut self) {
        self.sessions.retain(|_, handle| !handle.task.is_finished());
        let sessions = &self.sessions;
        self.previews
            .retain_sessions(|session_id| sessions.contains_key(session_id));
    }

    /// Open a session for a dispatched spawn. On success the server session
    /// exists and is `running`, the agent is in its fixed mode, and **no prompt
    /// has been sent**: [`Self::activate`] sends the spawn label once the spawn
    /// ack has landed (the server only accepts that ack while the session is
    /// still `running`).
    pub async fn spawn(&mut self, control: &WorkControl) -> Result<Uuid, Refusal> {
        let (Some(tool), Some(label)) = (control.payload_str("tool"), control.payload_str("label"))
        else {
            return Err(Refusal::InvalidControl);
        };
        // The label becomes the first prompt: never an adapter command.
        policy::check_prompt(label)?;
        // A resume names the session the server allocated for it; one this
        // host already runs is not opened a second time (#2607 N-6).
        if control
            .session_id
            .is_some_and(|session_id| self.runs(session_id))
        {
            return Err(Refusal::InvalidControl);
        }
        self.reap();
        if self.sessions.len() >= self.settings.max_sessions {
            return Err(Refusal::HostBusy);
        }
        // (1) ADR-0188 D6: never a remote shell — checked before the allowlist.
        policy::check_remote_tool(tool)?;
        // (2) The allowlist decides the binary and its arguments.
        let entry = self
            .settings
            .tools
            .get(tool)
            .cloned()
            .ok_or(Refusal::ToolNotAllowlisted)?;
        // (3) The allowed folder, resolved at every spawn.
        let cwd = std::fs::canonicalize(&self.settings.working_directory)
            .ok()
            .filter(|path| path.is_dir())
            .ok_or(Refusal::WorkdirUnavailable)?;
        // Project agent configuration the adapter would apply regardless.
        policy::check_project_config(entry.adapter, &cwd)?;
        // #3033 (ADR-0191 D1): this Mac's 「원격 작업」 account, if it chose
        // one — that profile or a refusal, never the default account.
        let profile = profile::for_spawn(&self.settings.state_folder, entry.adapter, &cwd)?;
        // ADR-0188 §8: Codex runs only from the host's own home (or the
        // chosen profile, which has the same conditions), signed in.
        let codex = match (&profile, entry.adapter) {
            (Some(dir), AdapterKind::Codex) => self.settings.codex.with_profile_home(dir.clone()),
            _ => self.settings.codex.clone(),
        };
        if entry.adapter == AdapterKind::Codex {
            if let Err(refusal) = policy::prepare_codex_home(&codex, &cwd) {
                if refusal == Refusal::CodexLoginRequired {
                    tracing::warn!(
                        login = %codex.login_command(),
                        "Codex is not signed in to the folder remote work runs in; sign in once with this command"
                    );
                    if profile.is_some() {
                        return Err(Refusal::ProfileLoginRequired);
                    }
                }
                return Err(refusal);
            }
        }
        let claude_config_dir = match entry.adapter {
            AdapterKind::Claude => profile.as_deref(),
            AdapterKind::Codex => None,
        };
        let spec = policy::launch_spec(
            &entry,
            &cwd,
            self.settings.parent_env.clone(),
            &codex,
            claude_config_dir,
        );
        let mut conn = AcpConnection::spawn(&spec).map_err(|error| {
            tracing::warn!(tool, error = %error, "agent launch failed");
            Refusal::AgentStartFailed
        })?;

        // (4) + (5): handshake, then the mode check.
        let acp_session_id = match handshake(
            &mut conn,
            entry.adapter,
            &cwd,
            self.settings.acp_start_timeout,
            profile.is_some(),
            &[profile::profile_root(&self.settings.state_folder)],
        )
        .await
        {
            Ok(id) => id,
            Err(refusal) => {
                conn.terminate(TERMINATE_GRACE).await;
                return Err(refusal);
            }
        };
        // The first census while the adapter is certainly alive: what it
        // started at launch is known before any turn can end with its exit.
        conn.observe_tree();

        let session_id = match control.session_id {
            // A resume spawn: the server pre-allocated the session.
            Some(session_id) => session_id,
            None => {
                let created = self
                    .api
                    .create_session(&CreateSession {
                        channel_id: control.channel_id,
                        host_id: self.api.host_id(),
                        tool: tool.to_string(),
                        label: label.to_string(),
                        control_id: control.id,
                    })
                    .await;
                match created {
                    Ok(session) => session.id,
                    Err(error) => {
                        tracing::warn!(control_id = %control.id, error = %error, "session create refused");
                        conn.terminate(TERMINATE_GRACE).await;
                        return Err(Refusal::SessionCreateFailed);
                    }
                }
            }
        };

        let (commands, receiver) = mpsc::channel(32);
        let task = SessionTask {
            session_id,
            acp_session_id,
            adapter: entry.adapter,
            conn,
            relay: EventRelay::new(self.api.clone(), session_id, control.channel_id),
            api: self.api.clone(),
            status: ServerStatus::Running,
            queue: VecDeque::new(),
            in_flight: None,
            start_pending: false,
            cancel_sent: false,
            queued_interrupts: 0,
            permissions: HashMap::new(),
            permission_wait: self.settings.permission_wait,
            previews: self.previews.clone(),
            tool_calls: Vec::new(),
        };
        let join = tokio::spawn(task.run(receiver));
        self.sessions.insert(
            session_id,
            SessionHandle {
                commands,
                task: join,
                initial_prompt: Some(label.to_string()),
            },
        );
        tracing::info!(%session_id, tool, "work session opened");
        Ok(session_id)
    }

    /// Send the spawn label as the first prompt (once).
    pub async fn activate(&mut self, session_id: Uuid) {
        let Some(handle) = self.sessions.get_mut(&session_id) else {
            return;
        };
        let Some(text) = handle.initial_prompt.take() else {
            return;
        };
        let (reply, _) = oneshot::channel();
        let _ = handle
            .commands
            .send(Command::Prompt {
                text,
                interrupt: false,
                reply,
            })
            .await;
    }

    /// Hand one owner instruction to the session (#3027, ADR-0188 D4).
    ///
    /// * `queue` — the next turn after everything already queued; a running
    ///   turn finishes first.
    /// * `interrupt` — the running turn is cancelled (ACP `session/cancel`)
    ///   and this instruction goes next, ahead of the queue. With no turn
    ///   running it simply starts now.
    pub async fn input(
        &mut self,
        session_id: Uuid,
        text: String,
        interrupt: bool,
    ) -> Result<(), Refusal> {
        self.reap();
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(Refusal::SessionNotFound)?;
        let (reply, answer) = oneshot::channel();
        handle
            .commands
            .send(Command::Prompt {
                text,
                interrupt,
                reply,
            })
            .await
            .map_err(|_| Refusal::SessionClosed)?;
        answer.await.unwrap_or(Err(Refusal::SessionClosed))
    }

    /// Hand the owner's decision to the session waiting on it (ADR-0188 D5).
    pub async fn permission(
        &mut self,
        session_id: Uuid,
        request_event_id: Uuid,
        option_id: String,
        kind: String,
    ) -> Result<(), Refusal> {
        self.reap();
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(Refusal::SessionNotFound)?;
        let (reply, answer) = oneshot::channel();
        handle
            .commands
            .send(Command::Permission {
                request_event_id,
                option_id,
                kind,
                reply,
            })
            .await
            .map_err(|_| Refusal::SessionClosed)?;
        answer.await.unwrap_or(Err(Refusal::SessionClosed))
    }

    /// Stop the session's agent. The session task reports `ended` itself.
    pub async fn kill(&mut self, session_id: Uuid) -> Result<i32, Refusal> {
        self.reap();
        let handle = self
            .sessions
            .remove(&session_id)
            .ok_or(Refusal::SessionNotFound)?;
        let (reply, answer) = oneshot::channel();
        if handle.commands.send(Command::Kill { reply }).await.is_err() {
            let _ = handle.task.await;
            return Err(Refusal::SessionNotFound);
        }
        let code = answer.await.unwrap_or(-1);
        let _ = handle.task.await;
        Ok(code)
    }

    /// Stop every session (host shutdown or revocation).
    pub async fn shutdown(&mut self) {
        let ids: Vec<Uuid> = self.sessions.keys().copied().collect();
        for session_id in ids {
            let _ = self.kill(session_id).await;
        }
    }
}

/// `initialize` → `session/new` → mode check, and the correction to the
/// fixed mode when the agent opened in another one. Returns the ACP session
/// id. Nothing is prompted until this returns.
async fn handshake(
    conn: &mut AcpConnection,
    adapter: AdapterKind,
    cwd: &std::path::Path,
    timeout: Duration,
    profiled: bool,
    protected: &[PathBuf],
) -> Result<String, Refusal> {
    let initialized = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": ACP_PROTOCOL_VERSION,
                // No filesystem or terminal is lent to the agent: every file or
                // command it wants goes through its own tools, and therefore
                // through its permission requests.
                "clientCapabilities": {
                    "fs": {"readTextFile": false, "writeTextFile": false},
                    "terminal": false,
                },
                "clientInfo": {
                    "name": "momo-workd",
                    "title": "oort work host",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
            timeout,
        )
        .await
        .map_err(|failure| {
            tracing::warn!(error = %failure, "ACP initialize failed");
            Refusal::AgentStartFailed
        })?;
    if initialized.get("protocolVersion").and_then(Value::as_i64) != Some(ACP_PROTOCOL_VERSION) {
        tracing::warn!("ACP agent negotiated an unsupported protocol version");
        return Err(Refusal::AgentStartFailed);
    }
    // #2607 N-9: the adapter the allowlist entry names, before `session/new`
    // (codex-acp trusts the folder and reads its `.codex` there).
    let name = initialized
        .pointer("/agentInfo/name")
        .and_then(Value::as_str)
        .unwrap_or("<none>");
    if name != adapter.agent_name() {
        tracing::warn!(
            reported = name,
            expected = adapter.agent_name(),
            "the allowlisted executable is not the adapter its entry names; session refused"
        );
        return Err(Refusal::AdapterMismatch);
    }
    let created = conn
        .request(
            "session/new",
            policy::session_new_params_protecting(adapter, cwd, protected),
            timeout,
        )
        .await
        .map_err(|failure| {
            tracing::warn!(error = %failure, "ACP session/new failed");
            // ACP `auth_required` (-32000): a chosen account that is not
            // signed in says so, and is not "the agent failed to start".
            match failure {
                RpcFailure::Error { code, .. } if profiled && code == ACP_AUTH_REQUIRED => {
                    Refusal::ProfileLoginRequired
                }
                _ => Refusal::AgentStartFailed,
            }
        })?;
    let acp_session_id = created
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or(Refusal::AgentStartFailed)?
        .to_string();
    // ADR-0188 D6 as amended (§8): the fixed mode before the first prompt —
    // corrected and confirmed when the agent opened in another one.
    let opened = created
        .pointer("/modes/currentModeId")
        .and_then(|mode| mode.as_str())
        .unwrap_or("<none>")
        .to_string();
    match policy::check_session_modes(adapter, created.get("modes")) {
        Ok(ModeAtOpen::Fixed) => {}
        Ok(ModeAtOpen::Correct) => {
            if let Err(refusal) = correct_mode(conn, adapter, &acp_session_id, timeout).await {
                tracing::warn!(
                    opened = %opened,
                    required = adapter.fixed_mode(),
                    "the agent's mode could not be corrected and confirmed; session refused"
                );
                return Err(refusal);
            }
            tracing::info!(
                opened = %opened,
                now = adapter.fixed_mode(),
                "agent opened outside the fixed mode; corrected before the first prompt"
            );
        }
        Err(refusal) => {
            tracing::warn!(
                opened = %opened,
                required = adapter.fixed_mode(),
                "agent does not offer the host's fixed permission mode; session refused"
            );
            return Err(refusal);
        }
    }
    Ok(acp_session_id)
}

/// `session/set_mode` to the fixed mode, then the agent's own confirmation:
/// the last mode it reports — with its answer, or within
/// [`MODE_CONFIRM_GRACE`] after it — must be the fixed one
/// ([`policy::check_mode_confirmed`]). Anything else it sent meanwhile is
/// handed back to the connection for the session task.
async fn correct_mode(
    conn: &mut AcpConnection,
    adapter: AdapterKind,
    acp_session_id: &str,
    timeout: Duration,
) -> Result<(), Refusal> {
    let fixed = adapter.fixed_mode();
    conn.request(
        "session/set_mode",
        json!({"sessionId": acp_session_id, "modeId": fixed}),
        timeout,
    )
    .await
    .map_err(|failure| {
        tracing::warn!(error = %failure, "the agent refused session/set_mode");
        Refusal::PermissionModeRefused
    })?;
    let mut reported: Option<String> = None;
    let mut others = Vec::new();
    // Everything the agent wrote before its answer is queued by now.
    while let Some(message) = conn.try_next_incoming() {
        match mode_report(&message) {
            Some(mode) => reported = Some(mode),
            None => others.push(message),
        }
    }
    if reported.as_deref() != Some(fixed) {
        let deadline = tokio::time::Instant::now() + MODE_CONFIRM_GRACE.min(timeout);
        while reported.as_deref() != Some(fixed) {
            match tokio::time::timeout_at(deadline, conn.next_incoming()).await {
                Ok(Some(message)) => match mode_report(&message) {
                    Some(mode) => reported = Some(mode),
                    None => others.push(message),
                },
                _ => break,
            }
        }
    }
    conn.unread(others);
    policy::check_mode_confirmed(adapter, reported.as_deref())
}

/// The mode an agent message reports, if it is a mode report.
fn mode_report(message: &Incoming) -> Option<String> {
    match message {
        Incoming::Notification { method, params } if method == "session/update" => {
            match projection::project(params) {
                Projection::ModeChanged(mode) => Some(mode),
                _ => None,
            }
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// the session task
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerStatus {
    Running,
    Idle,
}

enum End {
    Killed(oneshot::Sender<i32>),
    AgentExited,
    ModeEscaped,
    /// The server no longer has this session running (ended by its owner or
    /// by the sweep) or no longer accepts this host.
    Gone,
}

enum Event {
    Incoming(Option<Incoming>),
    Command(Option<Command>),
    TurnEnded(Result<RpcResult, oneshot::error::RecvError>),
    Tick,
}

struct SessionTask {
    session_id: Uuid,
    acp_session_id: String,
    adapter: AdapterKind,
    conn: AcpConnection,
    relay: EventRelay,
    api: Arc<dyn HostApi>,
    status: ServerStatus,
    queue: VecDeque<String>,
    in_flight: Option<oneshot::Receiver<RpcResult>>,
    /// A queued prompt could not start (transient server error); retry on tick.
    start_pending: bool,
    /// `session/cancel` already went out for the running turn (#3027).
    cancel_sent: bool,
    /// How many of the queue's front entries are owner interrupts (#3027).
    queued_interrupts: usize,
    /// Bridged permission requests waiting for the owner, by event id.
    permissions: HashMap<Uuid, PendingPermission>,
    permission_wait: Duration,
    /// #3118: the preview hashes of `permissions`, shared with the manager.
    previews: PreviewLedger,
    /// #3118: what the agent announced of its tool calls, for the preview of
    /// a permission request that names one (bounded).
    tool_calls: Vec<(String, Map<String, Value>)>,
}

impl SessionTask {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        let mut tick = tokio::time::interval(RELAY_TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let end = loop {
            let has_in_flight = self.in_flight.is_some();
            let event = {
                let in_flight = self.in_flight.as_mut();
                tokio::select! {
                    message = self.conn.next_incoming() => Event::Incoming(message),
                    command = commands.recv() => Event::Command(command),
                    result = async { in_flight.expect("guarded by has_in_flight").await }, if has_in_flight => {
                        Event::TurnEnded(result)
                    }
                    _ = tick.tick() => Event::Tick,
                }
            };
            let outcome = match event {
                Event::Incoming(None) => Some(End::AgentExited),
                Event::Incoming(Some(message)) => self.on_incoming(message).await,
                Event::Command(None) => {
                    let (reply, _) = oneshot::channel();
                    Some(End::Killed(reply))
                }
                Event::Command(Some(Command::Kill { reply })) => Some(End::Killed(reply)),
                Event::Command(Some(Command::Permission {
                    request_event_id,
                    option_id,
                    kind,
                    reply,
                })) => {
                    let (answer, end) = self.on_owner_decision(request_event_id, &option_id, &kind);
                    let _ = reply.send(answer);
                    end
                }
                Event::Command(Some(Command::Prompt {
                    text,
                    interrupt,
                    reply,
                })) => {
                    let limit = if interrupt {
                        MAX_QUEUED_PROMPTS + MAX_QUEUED_INTERRUPTS
                    } else {
                        MAX_QUEUED_PROMPTS
                    };
                    if self.queue.len() >= limit {
                        let _ = reply.send(Err(Refusal::InputQueueFull));
                        None
                    } else if interrupt {
                        // Ahead of every queued instruction, behind earlier
                        // interrupts: two interrupts run in the order sent.
                        let at = self.queued_interrupts.min(self.queue.len());
                        self.queue.insert(at, text);
                        self.queued_interrupts = at + 1;
                        let _ = reply.send(Ok(()));
                        if self.in_flight.is_some() {
                            self.interrupt_running_turn().await
                        } else {
                            self.start_next_turn().await
                        }
                    } else {
                        self.queue.push_back(text);
                        let _ = reply.send(Ok(()));
                        self.start_next_turn().await
                    }
                }
                Event::TurnEnded(result) => {
                    self.in_flight = None;
                    // Updates the agent sent before its answer belong to this
                    // turn: handle them before the turn is reported over.
                    let mut ended = None;
                    while let Some(message) = self.conn.try_next_incoming() {
                        if let Some(end) = self.on_incoming(message).await {
                            ended = Some(end);
                            break;
                        }
                    }
                    match ended {
                        Some(end) => Some(end),
                        None => self.on_turn_end(result).await,
                    }
                }
                Event::Tick => {
                    // Keep the census current, so a tool that left the
                    // adapter's group is known before anything can orphan it.
                    self.conn.observe_tree();
                    self.relay.flush_due().await;
                    if let Some(end) = self.expire_permissions().await {
                        Some(end)
                    } else if self.start_pending {
                        self.start_next_turn().await
                    } else {
                        None
                    }
                }
            };
            if self.relay.revoked {
                break End::Gone;
            }
            if let Some(end) = outcome {
                break end;
            }
        };
        self.finish(end).await;
    }

    async fn on_incoming(&mut self, message: Incoming) -> Option<End> {
        // A tool is running or asking to: count the tree now rather than at
        // the next tick — the adapter may exit before it and orphan the tool.
        let tool_activity = match &message {
            Incoming::Notification { params, .. } => params
                .pointer("/update/sessionUpdate")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.starts_with("tool_call")),
            Incoming::Request { .. } => true,
        };
        if tool_activity {
            self.conn.observe_tree();
        }
        match message {
            Incoming::Notification { method, params } if method == "session/update" => {
                projection::remember_tool_call(&mut self.tool_calls, &params);
                match projection::project(&params) {
                    Projection::Text(text) => self.relay.push_text(&text).await,
                    Projection::Status(payload) => self.relay.status(payload).await,
                    Projection::ModeChanged(mode) => {
                        // ADR-0188 D6: leaving the fixed mode closes the remote
                        // path — in this slice every path into the session is
                        // remote, so the session ends.
                        if policy::check_mode_update(self.adapter, &mode).is_err() {
                            tracing::warn!(session_id = %self.session_id, "agent left the fixed permission mode");
                            return Some(End::ModeEscaped);
                        }
                    }
                    Projection::Ignore => {}
                }
                None
            }
            Incoming::Notification { .. } => None,
            Incoming::Request { id, method, params } if method == "session/request_permission" => {
                self.on_permission_request(id, &params).await
            }
            Incoming::Request { id, .. } => {
                // `fs/*` and `terminal/*` were not offered in `initialize`, and
                // nothing else is served.
                let _ = self.conn.respond_error(
                    id,
                    METHOD_NOT_FOUND,
                    "method not supported by this host",
                );
                None
            }
        }
    }

    /// ADR-0188 D5: relay the request to the owner, or deny it at once when
    /// it cannot be relayed.
    async fn on_permission_request(&mut self, id: Value, params: &Value) -> Option<End> {
        let options = policy::permission_options(params);
        let offered = policy::bridge_options(&options);
        if !offered.is_empty() {
            let event_id = Uuid::new_v4();
            // #3118: the host is the preview's source. Its hash is recorded
            // before the request leaves, so no decision can arrive first.
            let preview = projection::permission_preview(&mut self.tool_calls, params).to_value();
            let Ok(preview_sha256) = momo_wire::permission_preview::preview_sha256(&preview) else {
                // Unreachable for a host-built preview; refuse closed.
                tracing::error!(session_id = %self.session_id, "permission preview did not build; denied");
                return self.deny_unrelayed(id, &options).await;
            };
            self.previews
                .insert(self.session_id, event_id, preview_sha256.clone());
            if self
                .relay
                .permission_requested(event_id, &offered, preview, &preview_sha256)
                .await
            {
                self.permissions.insert(
                    event_id,
                    PendingPermission {
                        rpc_id: id,
                        offered,
                        deadline: Instant::now() + self.permission_wait,
                    },
                );
                return None;
            }
            self.previews.remove(self.session_id, event_id);
            tracing::warn!(session_id = %self.session_id, "permission request not relayed; denied");
        }
        self.deny_unrelayed(id, &options).await
    }

    /// Deny a request that could not be relayed (D5 「올릴 수 없는 요청은 즉시
    /// 거부」).
    async fn deny_unrelayed(
        &mut self,
        id: Value,
        options: &[policy::PermissionOption],
    ) -> Option<End> {
        let decision = policy::decide_permission(options);
        if self.conn.respond(id, decision.to_result()).is_err() {
            return Some(End::AgentExited);
        }
        self.relay
            .permission_denied(None, PERMISSION_DENIED_DETAIL)
            .await;
        None
    }

    /// The owner's decision, checked against what the agent offered.
    fn on_owner_decision(
        &mut self,
        request_event_id: Uuid,
        option_id: &str,
        kind: &str,
    ) -> (Result<(), Refusal>, Option<End>) {
        let Some(pending) = self.permissions.get(&request_event_id) else {
            return (Err(Refusal::PermissionRequestUnknown), None);
        };
        let decision = match policy::owner_choice(&pending.offered, option_id, kind) {
            Ok(decision) => decision,
            // The request keeps waiting: a malformed decision is not one.
            Err(refusal) => return (Err(refusal), None),
        };
        let pending = self
            .take_permission(request_event_id)
            .expect("looked up above");
        tracing::info!(session_id = %self.session_id, %request_event_id, kind, "owner decided a permission request");
        if self
            .conn
            .respond(pending.rpc_id, decision.to_result())
            .is_err()
        {
            return (Err(Refusal::SessionClosed), Some(End::AgentExited));
        }
        (Ok(()), None)
    }

    /// Forget one waiting request, and its preview hash with it.
    fn take_permission(&mut self, request_event_id: Uuid) -> Option<PendingPermission> {
        self.previews.remove(self.session_id, request_event_id);
        self.permissions.remove(&request_event_id)
    }

    /// Requests whose owner did not answer within the host's wait: the
    /// agent's own one-time rejection, and the request withdrawn on the server.
    async fn expire_permissions(&mut self) -> Option<End> {
        let now = Instant::now();
        let lapsed: Vec<Uuid> = self
            .permissions
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        for event_id in lapsed {
            let pending = self.take_permission(event_id).expect("listed above");
            let decision = policy::decide_permission(&pending.offered);
            if self
                .conn
                .respond(pending.rpc_id, decision.to_result())
                .is_err()
            {
                return Some(End::AgentExited);
            }
            self.relay
                .permission_denied(Some(event_id), PERMISSION_EXPIRED_DETAIL)
                .await;
        }
        None
    }

    /// The owner's interrupt (#3027): cancel the running turn. The agent
    /// answers the in-flight `session/prompt` with `cancelled`; that turn end
    /// starts the front of the queue — the interrupting instruction — next.
    /// Called only with a turn in flight. Pending permission requests of the
    /// cancelled turn are answered `cancelled` (ACP) and withdrawn on the
    /// server first, so no allow can land on a turn that is gone.
    async fn interrupt_running_turn(&mut self) -> Option<End> {
        if self.cancel_sent {
            return None;
        }
        let pending: Vec<Uuid> = self.permissions.keys().copied().collect();
        for event_id in pending {
            let pending = self.take_permission(event_id).expect("listed above");
            if self
                .conn
                .respond(
                    pending.rpc_id,
                    policy::PermissionDecision::Cancelled.to_result(),
                )
                .is_err()
            {
                return Some(End::AgentExited);
            }
            self.relay
                .permission_denied(Some(event_id), PERMISSION_INTERRUPTED_DETAIL)
                .await;
        }
        match self
            .conn
            .notify("session/cancel", json!({"sessionId": self.acp_session_id}))
        {
            Ok(()) => {
                self.cancel_sent = true;
                tracing::info!(session_id = %self.session_id, "owner interrupt: running turn cancelled");
                None
            }
            Err(_) => Some(End::AgentExited),
        }
    }

    async fn start_next_turn(&mut self) -> Option<End> {
        self.start_pending = false;
        if self.in_flight.is_some() || self.queue.is_empty() {
            return None;
        }
        if self.status == ServerStatus::Idle {
            match self
                .api
                .set_status(self.session_id, SessionStatus::Running)
                .await
            {
                Ok(()) => self.status = ServerStatus::Running,
                Err(error) if error.is_transient() => {
                    self.start_pending = true;
                    return None;
                }
                Err(error) => {
                    tracing::warn!(session_id = %self.session_id, error = %error, "session cannot resume running");
                    return Some(End::Gone);
                }
            }
        }
        let text = self.queue.pop_front().expect("checked non-empty");
        self.queued_interrupts = self.queued_interrupts.saturating_sub(1);
        self.cancel_sent = false;
        match self.conn.start_request(
            "session/prompt",
            json!({
                "sessionId": self.acp_session_id,
                "prompt": [{"type": "text", "text": text}],
            }),
        ) {
            Ok(receiver) => {
                self.in_flight = Some(receiver);
                None
            }
            Err(_) => Some(End::AgentExited),
        }
    }

    async fn on_turn_end(
        &mut self,
        result: Result<RpcResult, oneshot::error::RecvError>,
    ) -> Option<End> {
        self.conn.observe_tree();
        self.relay.flush_text().await;
        let exit_code = match &result {
            Ok(Ok(value))
                if value.get("stopReason").and_then(Value::as_str) == Some("end_turn") =>
            {
                0
            }
            Ok(Err(RpcFailure::TransportClosed)) | Err(_) => return Some(End::AgentExited),
            _ => 1,
        };
        if !self.queue.is_empty() {
            return self.start_next_turn().await;
        }
        match self
            .api
            .set_status(self.session_id, SessionStatus::Idle { exit_code })
            .await
        {
            Ok(()) => self.status = ServerStatus::Idle,
            Err(error) => {
                tracing::warn!(session_id = %self.session_id, error = %error, "idle report failed");
                if matches!(error.status(), Some(401 | 403 | 404)) {
                    return Some(End::Gone);
                }
            }
        }
        None
    }

    async fn finish(mut self, end: End) {
        // ACP: a client that cancels answers every pending permission request
        // `cancelled`. The server cancels the rows when the session ends.
        for (request_event_id, pending) in self.permissions.drain() {
            self.previews.remove(self.session_id, request_event_id);
            let _ = self.conn.respond(
                pending.rpc_id,
                policy::PermissionDecision::Cancelled.to_result(),
            );
        }
        if let Some(in_flight) = self.in_flight.take() {
            // ACP: cancel the running turn and give the agent a moment to
            // answer it with `cancelled` before its process is stopped.
            if self
                .conn
                .notify("session/cancel", json!({"sessionId": self.acp_session_id}))
                .is_ok()
            {
                let _ = tokio::time::timeout(CANCEL_GRACE, in_flight).await;
            }
        }
        let (exit_code, reply, report) = match end {
            End::Killed(reply) => {
                self.relay.flush_text().await;
                (
                    self.conn.terminate(TERMINATE_GRACE).await,
                    Some(reply),
                    true,
                )
            }
            End::AgentExited => {
                self.relay.flush_text().await;
                (self.conn.wait_exit(TERMINATE_GRACE).await, None, true)
            }
            End::ModeEscaped => {
                self.relay.flush_text().await;
                self.relay
                    .status(projection::status_payload(
                        "thinking",
                        [("detail", json!(MODE_ESCAPED_DETAIL))],
                    ))
                    .await;
                (self.conn.terminate(TERMINATE_GRACE).await, None, true)
            }
            End::Gone => (self.conn.terminate(TERMINATE_GRACE).await, None, false),
        };
        if report && !self.relay.revoked {
            if let Err(error) = self
                .api
                .set_status(
                    self.session_id,
                    SessionStatus::Ended {
                        exit_code: Some(exit_code),
                    },
                )
                .await
            {
                tracing::warn!(session_id = %self.session_id, error = %error, "end report failed");
            }
        }
        tracing::info!(session_id = %self.session_id, exit_code, "work session closed");
        if let Some(reply) = reply {
            let _ = reply.send(exit_code);
        }
    }
}

// ---------------------------------------------------------------------------
// event relay
// ---------------------------------------------------------------------------

/// Ordered, coalescing sender of one session's events. Answer text is buffered
/// and sent as `agent.partial`; any other event flushes the text first, so the
/// server sees the stream in the order it happened.
///
/// Every piece of text is credential-redacted and cut into fields of at most
/// [`projection::MAX_FIELD_CHARS`] characters (and the server's 4096 bytes)
/// before it leaves (ADR-0188 D5, #2602 M-1). A size or age flush sends only
/// the part that cannot be the first half of a credential: an unterminated
/// private-key block and the trailing whitespace-free run stay buffered until
/// more text completes them or the message ends. A message boundary — another
/// event, the end of the turn, the end of the session — flushes everything.
pub struct EventRelay {
    api: Arc<dyn HostApi>,
    session_id: Uuid,
    channel_id: Uuid,
    text: String,
    text_since: Option<Instant>,
    /// Set on a 401: the host is no longer accepted, nothing more is sent.
    pub revoked: bool,
}

impl EventRelay {
    pub fn new(api: Arc<dyn HostApi>, session_id: Uuid, channel_id: Uuid) -> Self {
        Self {
            api,
            session_id,
            channel_id,
            text: String::new(),
            text_since: None,
            revoked: false,
        }
    }

    pub async fn push_text(&mut self, text: &str) {
        if self.text.is_empty() {
            self.text_since = Some(Instant::now());
        }
        self.text.push_str(text);
        if self.text.len() >= TEXT_FLUSH_BYTES {
            self.flush_ready().await;
        }
    }

    pub async fn flush_due(&mut self) {
        if self
            .text_since
            .is_some_and(|since| since.elapsed() >= TEXT_FLUSH_AGE)
        {
            self.flush_ready().await;
        }
    }

    /// Send what can safely go now; keep a possible credential fragment.
    async fn flush_ready(&mut self) {
        let ready = ready_len(&self.text);
        if ready == 0 {
            return;
        }
        let text: String = self.text.drain(..ready).collect();
        self.text_since = (!self.text.is_empty()).then(Instant::now);
        self.send_text(&text).await;
    }

    /// A message boundary: send everything buffered.
    pub async fn flush_text(&mut self) {
        self.text_since = None;
        let text = std::mem::take(&mut self.text);
        self.send_text(&text).await;
    }

    async fn send_text(&mut self, text: &str) {
        let clean = projection::redact_credentials(text);
        for chunk in chunk_field(&clean, MAX_FIELD_CHARS, MAX_EVENT_TEXT_BYTES) {
            let mut payload = Map::new();
            payload.insert("text_delta".into(), json!(chunk));
            self.send("agent.partial", payload).await;
        }
    }

    /// Text before the status goes first — but only what can safely go: a
    /// trailing fragment stays to be joined with the text after the status
    /// (#2607 N-4). Everything is flushed only when a turn or the session
    /// ends.
    pub async fn status(&mut self, payload: Map<String, Value>) {
        self.flush_ready().await;
        self.send("agent.status", payload).await;
    }

    /// A host-made denial and its reason, as two events: `approval.decided`
    /// (rejected) marks the interrupted tool row — and, when it names the
    /// bridged request it answers, withdraws that request on the server — and
    /// an `agent.status` note says why.
    pub async fn permission_denied(&mut self, request_event_id: Option<Uuid>, detail: &str) {
        self.flush_ready().await;
        let mut decided = Map::new();
        decided.insert("action".into(), json!("decided"));
        decided.insert("status".into(), json!("rejected"));
        if let Some(request_event_id) = request_event_id {
            decided.insert("request_event_id".into(), json!(request_event_id));
        }
        self.send("approval.decided", decided).await;
        self.send(
            "agent.status",
            projection::status_payload("thinking", [("detail", json!(detail))]),
        )
        .await;
    }

    /// ADR-0188 D5: the request, for its owner. Only the options the owner may
    /// choose (the agent's own `allow_once`/`reject_once`), with fixed names —
    /// the agent's option labels never cross. The tool call crosses only as
    /// the sanitised **preview** (#3118, [`projection::permission_preview`])
    /// with its hash: the server keeps the preview for the owner and
    /// broadcasts the hash alone, and an owner's allow must sign that hash.
    /// The event id is the request's one-time nonce. `true` when the server
    /// took it; the agent is then answered by the owner's decision.
    pub async fn permission_requested(
        &mut self,
        event_id: Uuid,
        offered: &[policy::PermissionOption],
        preview: Value,
        preview_sha256: &str,
    ) -> bool {
        self.flush_ready().await;
        let options: Vec<Value> = offered
            .iter()
            .map(|option| {
                json!({
                    "option_id": option.option_id,
                    "kind": option.kind,
                    "name": if option.kind == "allow_once" { "Allow once" } else { "Reject" },
                })
            })
            .collect();
        let mut fields = Map::new();
        fields.insert("action".into(), json!("requested"));
        fields.insert("action_type".into(), json!("tool_call"));
        fields.insert("status".into(), json!("pending"));
        fields.insert("options".into(), Value::Array(options));
        fields.insert("preview".into(), preview);
        fields.insert("preview_sha256".into(), json!(preview_sha256));
        self.send_as(event_id, "approval.requested", fields).await
    }

    async fn send(&mut self, event_type: &str, fields: Map<String, Value>) {
        // One id per event, reused across retries: the server dedupes on it.
        self.send_as(Uuid::new_v4(), event_type, fields).await;
    }

    /// Send one event under `event_id`; `true` when the server recorded it.
    async fn send_as(
        &mut self,
        event_id: Uuid,
        event_type: &str,
        fields: Map<String, Value>,
    ) -> bool {
        if self.revoked {
            return false;
        }
        let mut payload = Map::new();
        // The server binds an event to its session through these three keys
        // (`run_id` is the session id on this path).
        payload.insert("run_id".into(), json!(self.session_id));
        payload.insert("work_session_id".into(), json!(self.session_id));
        payload.insert("channel_id".into(), json!(self.channel_id));
        payload.extend(fields);
        let event = AcpEvent {
            event_id,
            event_type: event_type.to_string(),
            v: 1,
            ts: now_ms(),
            payload: Value::Object(payload),
        };
        for attempt in 0..3u32 {
            match self.api.record_event(self.session_id, &event).await {
                Ok(()) => return true,
                Err(ClientError::Unauthorized) => {
                    self.revoked = true;
                    return false;
                }
                Err(error) if error.is_transient() && attempt < 2 => {
                    tokio::time::sleep(Duration::from_millis(250 * 4u64.pow(attempt))).await;
                }
                Err(error) => {
                    tracing::warn!(
                        session_id = %self.session_id,
                        event_type,
                        status = error.status(),
                        "session event dropped"
                    );
                    return false;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flush_holds_what_the_next_chunk_could_complete_into_a_credential() {
        // Only complete lines go before the message ends.
        assert_eq!(ready_len("see sk-ant-api03-"), 0);
        assert_eq!(
            ready_len("line one\nAWS_SECRET_ACCESS_KEY = "),
            "line one\n".len()
        );
        assert_eq!(ready_len("aws AKIA\n"), "aws AKIA\n".len());
        // So does an unfinished PEM header or an open block, spaces and all.
        assert_eq!(ready_len("key:\n-----BEGIN OPENSSH PRIV"), "key:\n".len());
        let open = concat!("key:\n-----BEGIN OPENSSH ", "PRIVATE KEY-----\nb3Blbn\n");
        assert_eq!(ready_len(open), "key:\n".len());
        // A closed block and a finished word go.
        let closed = concat!(
            "-----BEGIN OPENSSH ",
            "PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH ",
            "PRIVATE KEY-----\n"
        );
        assert_eq!(ready_len(closed), closed.len());
        assert_eq!(ready_len("done.\n"), "done.\n".len());
        // The holds are bounded: a line past the bound keeps only its last
        // run, an unbroken run past the bound is sent…
        let long = "x".repeat(MAX_HELD_RUN_BYTES + 1);
        assert_eq!(ready_len(&long), long.len());
        assert_eq!(
            ready_len(&format!("a {}", "x".repeat(MAX_HELD_RUN_BYTES))),
            2
        );
        // …and so is an open key block past its bound (#2607 N-5).
        let flood = format!(
            "{}{}",
            concat!("-----BEGIN RSA ", "PRIVATE KEY-----\n"),
            "lorem ipsum\n".repeat(MAX_HELD_KEY_BYTES / 12 + 1)
        );
        assert_eq!(ready_len(&flood), flood.len());
        assert_eq!(
            projection::redact_credentials(&flood),
            projection::REDACTED_PRIVATE_KEY,
            "released masked to the end"
        );
    }
}
