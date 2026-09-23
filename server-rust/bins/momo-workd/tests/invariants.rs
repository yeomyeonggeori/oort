//! ADR-0188 D6 invariants, proven end to end without a database: the real
//! control loop and session manager, the real ACP transport, a test-only stub
//! agent (`momo-workd-acp-stub`), and a fake server that records every call.
//!
//! | test | the guard whose removal turns it red |
//! |---|---|
//! | `inv_1_remote_shell_is_refused_even_when_allowlisted` | `policy::check_remote_tool` in `SessionManager::spawn` |
//! | `inv_2_a_session_outside_the_fixed_mode_is_never_opened` | `policy::check_session_modes` in `session::handshake` |
//! | `inv_3_every_permission_request_is_denied_with_a_reason` | `policy::decide_permission` (never `allow_*`) |
//! | `inv_4_round_trip_events_idle_input_kill` | the curated projection, idle/running, owner-only input, kill → ended |
//! | `inv_5_leaving_the_fixed_mode_mid_session_closes_it` | `policy::check_mode_update` |
//! | `inv_6_codex_is_never_launched_remotely` | `policy::check_adapter_admitted` in `SessionManager::spawn` (#2602 M-2) |
//! | `inv_7_a_lost_spawn_ack_response_still_starts_the_session` | the settled-verdict sweep in `ControlLoop::poll_once` |

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use momo_workd::client::{
    AcpEvent, ClientError, ControlAck, CreateSession, HostApi, SessionStatus, WorkControl,
    WorkSession,
};
use momo_workd::config::ToolEntry;
use momo_workd::controls::ControlLoop;
use momo_workd::policy::AdapterKind;
use momo_workd::session::{
    SessionManager, SessionSettings, MODE_ESCAPED_DETAIL, PERMISSION_DENIED_DETAIL,
};
use serde_json::{json, Value};
use uuid::Uuid;

const STUB: &str = env!("CARGO_BIN_EXE_momo-workd-acp-stub");

#[derive(Debug, Clone)]
enum Call {
    Ack(Uuid, ControlAck),
    Create(CreateSession),
    Event(Uuid, AcpEvent),
    Status(Uuid, SessionStatus),
}

/// A server that hands out queued controls and records what the host does.
struct FakeServer {
    host_id: Uuid,
    controls: Mutex<VecDeque<WorkControl>>,
    calls: Mutex<Vec<Call>>,
    /// Commit the next ack, then answer as if its response was lost.
    lose_next_ack_response: Mutex<bool>,
}

impl FakeServer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            host_id: Uuid::new_v4(),
            controls: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
            lose_next_ack_response: Mutex::new(false),
        })
    }

    fn push(&self, control: WorkControl) {
        self.controls.lock().unwrap().push_back(control);
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn acks(&self) -> Vec<(Uuid, ControlAck)> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Ack(id, ack) => Some((id, ack)),
                _ => None,
            })
            .collect()
    }

    fn creates(&self) -> Vec<CreateSession> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Create(request) => Some(request),
                _ => None,
            })
            .collect()
    }

    fn events(&self) -> Vec<AcpEvent> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Event(session, event) => {
                    // The PATCH path names the session the payload binds to.
                    assert_eq!(event.payload["work_session_id"], json!(session));
                    Some(event)
                }
                _ => None,
            })
            .collect()
    }

    fn statuses(&self, session: Uuid) -> Vec<SessionStatus> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                Call::Status(id, status) if id == session => Some(status),
                _ => None,
            })
            .collect()
    }
}

#[async_trait]
impl HostApi for FakeServer {
    fn host_id(&self) -> Uuid {
        self.host_id
    }

    async fn heartbeat(&self) -> Result<(), ClientError> {
        Ok(())
    }

    async fn pending_controls(&self) -> Result<Vec<WorkControl>, ClientError> {
        Ok(self.controls.lock().unwrap().iter().cloned().collect())
    }

    async fn ack(&self, control_id: Uuid, ack: &ControlAck) -> Result<(), ClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Ack(control_id, ack.clone()));
        // An acked control leaves the queue, as it does on the server.
        self.controls
            .lock()
            .unwrap()
            .retain(|control| control.id != control_id);
        if std::mem::take(&mut *self.lose_next_ack_response.lock().unwrap()) {
            return Err(ClientError::Transport("response lost".into()));
        }
        Ok(())
    }

    async fn create_session(&self, request: &CreateSession) -> Result<WorkSession, ClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Create(request.clone()));
        Ok(WorkSession {
            id: Uuid::new_v4(),
            channel_id: request.channel_id,
            host_id: request.host_id,
            tool: request.tool.clone(),
            label: request.label.clone(),
            status: "running".to_string(),
        })
    }

    async fn record_event(&self, session_id: Uuid, event: &AcpEvent) -> Result<(), ClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Event(session_id, event.clone()));
        Ok(())
    }

    async fn set_status(&self, session_id: Uuid, status: SessionStatus) -> Result<(), ClientError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Status(session_id, status));
        Ok(())
    }
}

struct Harness {
    server: Arc<FakeServer>,
    controls: ControlLoop,
    owner: Uuid,
    channel: Uuid,
    record: PathBuf,
    dir: PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stub_entry(record: &Path, adapter: AdapterKind, extra: &[&str]) -> ToolEntry {
    let mut args = vec!["--record".to_string(), record.display().to_string()];
    args.extend(extra.iter().map(|arg| arg.to_string()));
    ToolEntry {
        adapter,
        executable: PathBuf::from(STUB),
        args,
    }
}

/// Every tool is the stub, speaking as a Claude adapter, with `extra` flags.
fn harness(tools: &[(&str, &[&str])]) -> Harness {
    let tools: Vec<(&str, AdapterKind, &[&str])> = tools
        .iter()
        .map(|(key, extra)| (*key, AdapterKind::Claude, *extra))
        .collect();
    harness_with(&tools)
}

fn harness_with(tools: &[(&str, AdapterKind, &[&str])]) -> Harness {
    let dir = std::env::temp_dir().join(format!("momo-workd-inv-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(dir.join("repo")).unwrap();
    let record = dir.join("stub.jsonl");
    let server = FakeServer::new();
    let mut parent_env: Vec<(String, String)> = std::env::vars().collect();
    // Present in the host's own environment; must never reach an agent.
    parent_env.push(("MOMO_WORKD_REGISTER_TOKEN".into(), "owner-token".into()));
    let settings = SessionSettings {
        tools: tools
            .iter()
            .map(|(key, adapter, extra)| (key.to_string(), stub_entry(&record, *adapter, extra)))
            .collect::<BTreeMap<_, _>>(),
        working_directory: dir.join("repo"),
        acp_start_timeout: Duration::from_secs(10),
        parent_env,
    };
    let owner = Uuid::new_v4();
    let sessions = SessionManager::new(server.clone(), settings);
    Harness {
        controls: ControlLoop::new(server.clone(), sessions, owner),
        server,
        owner,
        channel: Uuid::new_v4(),
        record,
        dir,
    }
}

fn control(
    h: &Harness,
    kind: &str,
    requester: Uuid,
    session: Option<Uuid>,
    payload: Value,
) -> WorkControl {
    WorkControl {
        id: Uuid::new_v4(),
        workspace_id: Uuid::new_v4(),
        channel_id: h.channel,
        requester_member_id: requester,
        target_host_id: h.server.host_id,
        session_id: session,
        kind: kind.to_string(),
        payload,
        status: "dispatched".to_string(),
    }
}

fn spawn(h: &Harness, tool: &str, label: &str) -> WorkControl {
    // A spawn's requester is the agent that asked for it.
    control(
        h,
        "spawn",
        Uuid::new_v4(),
        None,
        json!({"tool": tool, "label": label}),
    )
}

fn stub_log(h: &Harness) -> Vec<Value> {
    std::fs::read_to_string(&h.record)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn received_methods(h: &Harness) -> Vec<String> {
    stub_log(h)
        .iter()
        .filter_map(|entry| entry["received"]["method"].as_str().map(str::to_string))
        .collect()
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

fn ack_for(h: &Harness, control: Uuid) -> ControlAck {
    h.server
        .acks()
        .into_iter()
        .find(|(id, _)| *id == control)
        .map(|(_, ack)| ack)
        .unwrap_or_else(|| panic!("no ack for control {control}"))
}

#[tokio::test]
async fn inv_1_remote_shell_is_refused_even_when_allowlisted() {
    // The owner's allowlist names a tool called `shell`, pointing at a real,
    // launchable agent. ADR-0188 D6 still forbids it remotely.
    let mut h = harness(&[("shell", &[]), ("claude", &[])]);
    let shell = spawn(&h, "shell", "open a shell");
    h.server.push(shell.clone());
    h.controls.poll_once().await.unwrap();

    assert_eq!(
        ack_for(&h, shell.id),
        ControlAck::refused("shell_refused"),
        "a remote shell spawn must be refused"
    );
    assert!(
        h.server.creates().is_empty(),
        "no server session for a refused shell"
    );
    assert!(
        !h.record.exists(),
        "the shell tool's executable must never be launched: {:?}",
        stub_log(&h)
    );

    // A tool that is not allowlisted is refused as well, without launching.
    let unknown = spawn(&h, "codex", "run");
    h.server.push(unknown.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, unknown.id),
        ControlAck::refused("tool_not_allowlisted")
    );
    assert!(!h.record.exists());
}

#[tokio::test]
async fn inv_2_a_session_outside_the_fixed_mode_is_never_opened() {
    // The agent's own settings put it in bypassPermissions (ADR-0188 D6:
    // 「설정이 bypass·auto를 요구하면 세션을 열지 않는다」).
    let mut h = harness(&[("claude", &["--mode", "bypassPermissions"])]);
    let bypass = spawn(&h, "claude", "fix the bug");
    h.server.push(bypass.clone());
    h.controls.poll_once().await.unwrap();

    assert_eq!(
        ack_for(&h, bypass.id),
        ControlAck::refused("permission_mode_refused"),
        "a bypass-mode agent must not get a session"
    );
    assert!(
        h.server.creates().is_empty(),
        "no server session was created"
    );
    let methods = received_methods(&h);
    assert_eq!(
        methods,
        vec!["initialize".to_string(), "session/new".to_string()],
        "the agent saw the handshake and nothing else — no prompt"
    );
    assert!(h.controls.sessions().live_sessions().is_empty());

    // An agent that reports no mode at all cannot prove it is safe either.
    let mut h = harness(&[("claude", &["--no-modes"])]);
    let silent = spawn(&h, "claude", "fix the bug");
    h.server.push(silent.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, silent.id),
        ControlAck::refused("permission_mode_refused")
    );
    assert!(h.server.creates().is_empty());
}

#[tokio::test]
async fn inv_3_every_permission_request_is_denied_with_a_reason() {
    let mut h = harness(&[("claude", &["--permission"])]);
    let request = spawn(&h, "claude", "read the secret");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id)
        .session_id
        .expect("spawn acked with its session");

    wait_for("the turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;

    let outcomes: Vec<Value> = stub_log(&h)
        .into_iter()
        .filter_map(|entry| entry.get("permission_outcome").cloned())
        .collect();
    assert_eq!(
        outcomes,
        vec![json!({"outcome": "selected", "optionId": "reject-once"})],
        "the host must answer the agent's own one-time rejection — never an allow option"
    );

    let events = h.server.events();
    let decided = events
        .iter()
        .find(|event| event.event_type == "approval.decided")
        .expect("the denial is on the stream");
    assert_eq!(decided.payload["status"], "rejected");
    assert!(
        events.iter().any(|event| event.event_type == "agent.status"
            && event.payload["detail"] == PERMISSION_DENIED_DETAIL),
        "the reason is on the stream"
    );
    assert!(
        events
            .iter()
            .all(|event| event.event_type != "approval.requested"),
        "no preview of the request (its tool call or options) crosses to the room"
    );
}

#[tokio::test]
async fn inv_4_round_trip_events_idle_input_kill() {
    let mut h = harness(&[("claude", &[])]);
    let request = spawn(&h, "claude", "summarise the repo");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();

    let create = h.server.creates().pop().expect("one session create");
    assert_eq!(create.control_id, request.id);
    assert_eq!(create.tool, "claude");
    assert_eq!(create.host_id, h.server.host_id);
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");

    wait_for("the first turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;

    // The launch: allowlisted binary, the owner's fixed args, the resolved
    // folder, no MCP servers, and none of the host's own MOMO_* environment.
    let log = stub_log(&h);
    let start = &log[0];
    assert_eq!(
        start["env_has_momo"], false,
        "the registration token never reaches an agent"
    );
    assert_eq!(
        start["cwd"].as_str().map(PathBuf::from),
        Some(std::fs::canonicalize(h.dir.join("repo")).unwrap())
    );
    let new_session = log
        .iter()
        .find(|entry| entry["received"]["method"] == "session/new")
        .unwrap();
    assert_eq!(new_session["received"]["params"]["mcpServers"], json!([]));
    // ADR-0188 D6: no filesystem settings (hooks, allow rules, plugins), no MCP
    // configuration but the host's (none), no bypass mode in the catalog.
    assert_eq!(
        new_session["received"]["params"]["_meta"]["claudeCode"]["options"],
        json!({"settingSources": [], "strictMcpConfig": true, "allowDangerouslySkipPermissions": false})
    );
    let initialize = log
        .iter()
        .find(|entry| entry["received"]["method"] == "initialize")
        .unwrap();
    assert_eq!(
        initialize["received"]["params"]["clientCapabilities"],
        json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false})
    );

    // The stream: the answer (coalesced), the plan, the tool KIND — and never
    // the tool title, the raw input, or the thought chunk.
    let events = h.server.events();
    let text: String = events
        .iter()
        .filter(|event| event.event_type == "agent.partial")
        .map(|event| event.payload["text_delta"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(text, "stub heard: summarise the repo — done.");
    assert!(events.iter().any(|event| event.payload["has_plan"] == true));
    assert!(events
        .iter()
        .any(|event| event.payload["tool_call_name"] == "execute"));
    let encoded =
        serde_json::to_string(&events.iter().map(|e| &e.payload).collect::<Vec<_>>()).unwrap();
    assert!(
        !encoded.contains("ssh"),
        "tool titles/raw input never cross: {encoded}"
    );
    assert!(
        !encoded.contains("private reasoning"),
        "thoughts are not relayed"
    );
    for event in &events {
        assert_eq!(event.v, 1);
        assert_eq!(event.payload["work_session_id"], json!(session));
        assert_eq!(event.payload["run_id"], json!(session));
        assert_eq!(event.payload["channel_id"], json!(h.channel));
    }

    // An agent's input is refused (ADR-0188 D3); the owner's is the next turn.
    let agent_input = control(
        &h,
        "input",
        Uuid::new_v4(),
        Some(session),
        json!({"text": "rm -rf"}),
    );
    h.server.push(agent_input.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, agent_input.id),
        ControlAck::refused("requester_not_owner")
    );

    let owner_input = control(
        &h,
        "input",
        h.owner,
        Some(session),
        json!({"text": "and the tests"}),
    );
    h.server.push(owner_input.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(ack_for(&h, owner_input.id), ControlAck::ok(Some(session)));
    wait_for("the second turn to end", || {
        h.server
            .statuses(session)
            .iter()
            .filter(|status| **status == SessionStatus::Idle { exit_code: 0 })
            .count()
            == 2
    })
    .await;
    let statuses = h.server.statuses(session);
    assert_eq!(
        statuses,
        vec![
            SessionStatus::Idle { exit_code: 0 },
            SessionStatus::Running,
            SessionStatus::Idle { exit_code: 0 },
        ],
        "idle after each turn, running again before the next"
    );

    // `read` is not served.
    let read = control(&h, "read", h.owner, Some(session), json!({}));
    h.server.push(read.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, read.id),
        ControlAck::refused("unsupported_control")
    );

    // Kill: acked, the session reports ended, the agent is gone.
    let kill = control(&h, "kill", Uuid::new_v4(), Some(session), json!({}));
    h.server.push(kill.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(ack_for(&h, kill.id), ControlAck::ok(Some(session)));
    assert!(matches!(
        h.server.statuses(session).last(),
        Some(SessionStatus::Ended { exit_code: Some(_) })
    ));
    assert!(h.controls.sessions().live_sessions().is_empty());

    // A kill for a session this host does not run is refused, not faked.
    let stale = control(&h, "kill", Uuid::new_v4(), Some(session), json!({}));
    h.server.push(stale.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, stale.id),
        ControlAck::refused("session_not_found")
    );
}

#[tokio::test]
async fn inv_5_leaving_the_fixed_mode_mid_session_closes_it() {
    let mut h = harness(&[("claude", &["--escape-mode", "bypassPermissions", "--hang"])]);
    let request = spawn(&h, "claude", "work");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");

    wait_for("the escaped session to end", || {
        matches!(
            h.server.statuses(session).last(),
            Some(SessionStatus::Ended { .. })
        )
    })
    .await;
    assert!(h
        .server
        .events()
        .iter()
        .any(|event| event.payload["detail"] == MODE_ESCAPED_DETAIL));
    assert!(
        received_methods(&h).contains(&"session/cancel".to_string()),
        "the running turn is cancelled before the agent is stopped"
    );
    wait_for("the session task to finish", || {
        h.controls.sessions().live_sessions().is_empty()
    })
    .await;

    // The same escape announced only as a session config option (codex-acp
    // does this when a slash command in a prompt sets the `mode` option).
    let mut h = harness(&[(
        "claude",
        &[
            "--escape-mode",
            "bypassPermissions",
            "--escape-via-config",
            "--hang",
        ],
    )]);
    let request = spawn(&h, "claude", "work");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    wait_for("the config-option escape to end the session", || {
        matches!(
            h.server.statuses(session).last(),
            Some(SessionStatus::Ended { .. })
        )
    })
    .await;
    assert!(h
        .server
        .events()
        .iter()
        .any(|event| event.payload["detail"] == MODE_ESCAPED_DETAIL));
}

#[tokio::test]
async fn inv_6_codex_is_never_launched_remotely() {
    // #2602 M-2: even a Codex that would report the host's preset
    // (`read-only`) is refused — that preset runs sandboxed commands and
    // writes without a permission request.
    let mut h = harness_with(&[("codex", AdapterKind::Codex, &["--mode", "read-only"])]);
    let request = spawn(&h, "codex", "look around");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, request.id),
        ControlAck::refused("adapter_refused"),
        "a Codex spawn must be refused"
    );
    assert!(
        !h.record.exists(),
        "the Codex adapter is never launched: {:?}",
        stub_log(&h)
    );
    assert!(h.server.creates().is_empty());
    assert!(h.controls.sessions().live_sessions().is_empty());
}

#[tokio::test]
async fn inv_7_a_lost_spawn_ack_response_still_starts_the_session() {
    let mut h = harness(&[("claude", &[])]);
    *h.server.lose_next_ack_response.lock().unwrap() = true;
    let request = spawn(&h, "claude", "summarise the repo");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id)
        .session_id
        .expect("the committed ack carried the session");
    assert_eq!(
        received_methods(&h),
        vec!["initialize".to_string(), "session/new".to_string()],
        "no prompt before the ack is known to have landed"
    );

    // The server no longer lists the control: the ack landed. The session gets
    // its first prompt now, and the ack is not re-sent.
    h.controls.poll_once().await.unwrap();
    wait_for("the first turn to go idle", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    assert_eq!(
        h.server
            .acks()
            .iter()
            .filter(|(id, _)| *id == request.id)
            .count(),
        1
    );
    assert!(received_methods(&h).contains(&"session/prompt".to_string()));
}
