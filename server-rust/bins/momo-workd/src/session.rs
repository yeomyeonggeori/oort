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
//!    ready and signed in ([`policy::prepare_codex_home`], ADR-0188 §8);
//! 5. ACP `initialize` — the process must be the adapter its entry names
//!    ([`policy::AdapterKind::agent_name`]) — then `session/new` with no MCP
//!    servers and the adapter's isolation switches;
//! 6. the agent must be in the adapter's fixed permission mode, or be
//!    corrected to it and confirm ([`policy::check_session_modes`],
//!    [`policy::check_mode_confirmed`]) — only then is a server session
//!    created, and only after that the first prompt sent.
//!
//! After that the session task owns the agent. It relays the curated event
//! stream ([`crate::projection`]), answers every `session/request_permission`
//! with a denial plus the reason on the stream ([`policy::decide_permission`]),
//! reports `idle` when a turn ends and `running` before the next one, and closes
//! the session if the agent ever leaves the fixed mode.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
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
use crate::projection::{self, chunk_field, Projection, MAX_FIELD_CHARS};

/// ACP protocol version this client speaks.
pub const ACP_PROTOCOL_VERSION: i64 = 1;
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

/// Shown on the session stream when a permission request is refused.
pub const PERMISSION_DENIED_DETAIL: &str =
    "권한 요청을 거부했습니다. 원격 세션의 권한 승인은 아직 열리지 않았습니다.";
/// Shown when the agent leaves the fixed permission mode.
pub const MODE_ESCAPED_DETAIL: &str = "권한 모드가 고정 모드를 벗어나 원격 세션을 닫았습니다.";

/// What the session layer needs from the host configuration.
#[derive(Debug, Clone)]
pub struct SessionSettings {
    pub tools: BTreeMap<String, ToolEntry>,
    pub working_directory: PathBuf,
    pub acp_start_timeout: Duration,
    /// The host's environment at startup; filtered per launch by the policy.
    pub parent_env: Vec<(String, String)>,
    /// Most sessions (agent processes) this host runs at once (#2602 L-2).
    pub max_sessions: usize,
    /// Codex's host-only home and temp folder (ADR-0188 §8).
    pub codex: policy::CodexHome,
}

/// Most instructions one session keeps queued behind its running turn
/// (#2602 L-2).
pub const MAX_QUEUED_PROMPTS: usize = 16;

enum Command {
    Prompt {
        text: String,
        reply: oneshot::Sender<Result<(), Refusal>>,
    },
    Kill {
        reply: oneshot::Sender<i32>,
    },
}

struct SessionHandle {
    commands: mpsc::Sender<Command>,
    task: JoinHandle<()>,
    /// The spawn label, sent as the first prompt once the spawn ack landed.
    initial_prompt: Option<String>,
}

pub struct SessionManager {
    api: Arc<dyn HostApi>,
    settings: Arc<SessionSettings>,
    sessions: HashMap<Uuid, SessionHandle>,
}

impl SessionManager {
    pub fn new(api: Arc<dyn HostApi>, settings: SessionSettings) -> Self {
        Self {
            api,
            settings: Arc::new(settings),
            sessions: HashMap::new(),
        }
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
        // ADR-0188 §8: Codex runs only from the host's own home, signed in.
        if entry.adapter == AdapterKind::Codex {
            if let Err(refusal) = policy::prepare_codex_home(&self.settings.codex, &cwd) {
                if refusal == Refusal::CodexLoginRequired {
                    tracing::warn!(
                        login = %self.settings.codex.login_command(),
                        "Codex is not signed in to the host's own home; sign in once with this command"
                    );
                }
                return Err(refusal);
            }
        }
        let spec = policy::launch_spec(
            &entry,
            &cwd,
            self.settings.parent_env.clone(),
            &self.settings.codex,
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
        )
        .await
        {
            Ok(id) => id,
            Err(refusal) => {
                conn.terminate(TERMINATE_GRACE).await;
                return Err(refusal);
            }
        };

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
        let _ = handle.commands.send(Command::Prompt { text, reply }).await;
    }

    /// Queue one owner instruction for the session (ADR-0188 D4: a reply is the
    /// next turn, not an interruption).
    pub async fn input(&mut self, session_id: Uuid, text: String) -> Result<(), Refusal> {
        self.reap();
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(Refusal::SessionNotFound)?;
        let (reply, answer) = oneshot::channel();
        handle
            .commands
            .send(Command::Prompt { text, reply })
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
            policy::session_new_params(adapter, cwd),
            timeout,
        )
        .await
        .map_err(|failure| {
            tracing::warn!(error = %failure, "ACP session/new failed");
            Refusal::AgentStartFailed
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
                Event::Command(Some(Command::Prompt { text, reply })) => {
                    if self.queue.len() >= MAX_QUEUED_PROMPTS {
                        let _ = reply.send(Err(Refusal::InputQueueFull));
                        None
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
                    if self.start_pending {
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
        match message {
            Incoming::Notification { method, params } if method == "session/update" => {
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
                // ADR-0188 D5/D6: denied, always, until the R1 bridge exists.
                let decision = policy::decide_permission(&policy::permission_options(&params));
                if self.conn.respond(id, decision.to_result()).is_err() {
                    return Some(End::AgentExited);
                }
                self.relay.permission_denied().await;
                None
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

    /// The denial and its reason, as two events: `approval.decided` (rejected)
    /// marks the interrupted tool row, and an `agent.status` note says why.
    /// Neither carries the request's tool call or options — no preview crosses
    /// (ADR-0188 D5: previews go to the owner's devices only, and that bridge is
    /// R1's next slice).
    pub async fn permission_denied(&mut self) {
        self.flush_ready().await;
        let mut decided = Map::new();
        decided.insert("action".into(), json!("decided"));
        decided.insert("status".into(), json!("rejected"));
        self.send("approval.decided", decided).await;
        self.send(
            "agent.status",
            projection::status_payload("thinking", [("detail", json!(PERMISSION_DENIED_DETAIL))]),
        )
        .await;
    }

    async fn send(&mut self, event_type: &str, fields: Map<String, Value>) {
        if self.revoked {
            return;
        }
        let mut payload = Map::new();
        // The server binds an event to its session through these three keys
        // (`run_id` is the session id on this path).
        payload.insert("run_id".into(), json!(self.session_id));
        payload.insert("work_session_id".into(), json!(self.session_id));
        payload.insert("channel_id".into(), json!(self.channel_id));
        payload.extend(fields);
        let event = AcpEvent {
            // One id per event, reused across retries: the server dedupes on it.
            event_id: Uuid::new_v4(),
            event_type: event_type.to_string(),
            v: 1,
            ts: now_ms(),
            payload: Value::Object(payload),
        };
        for attempt in 0..3u32 {
            match self.api.record_event(self.session_id, &event).await {
                Ok(()) => return,
                Err(ClientError::Unauthorized) => {
                    self.revoked = true;
                    return;
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
                    return;
                }
            }
        }
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
