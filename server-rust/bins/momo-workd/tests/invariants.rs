//! ADR-0188 D6 invariants, proven end to end without a database: the real
//! control loop and session manager, the real ACP transport, a test-only stub
//! agent (`momo-workd-acp-stub`), and a fake server that records every call.
//!
//! | test | the guard whose removal turns it red |
//! |---|---|
//! | `inv_1_remote_shell_is_refused_even_when_allowlisted` | `policy::check_remote_tool` in `SessionManager::spawn` |
//! | `inv_2_a_session_outside_the_fixed_mode_is_corrected_before_its_first_prompt_or_refused` | `policy::check_session_modes`, `session::correct_mode` and `policy::check_mode_confirmed` in `session::handshake` (ADR-0188 §8, #2607); the agent's last mode report wins, before and after its answer (#2630 F2) |
//! | `inv_3_every_permission_request_is_denied_with_a_reason` | `policy::decide_permission` (never `allow_*`) |
//! | `inv_4_round_trip_events_idle_input_kill` | the curated projection, idle/running, owner-only input, kill → ended |
//! | `inv_5_leaving_the_fixed_mode_mid_session_closes_it` | `policy::check_mode_update` |
//! | `inv_6_codex_runs_only_from_the_hosts_own_home` | `policy::prepare_codex_home` and `policy::check_project_config` in `SessionManager::spawn`, the Codex launch environment (ADR-0188 §8, #2607) |
//! | `inv_8_a_spawn_from_anyone_but_the_owner_is_refused` | `ControlLoop::require_owner` on spawn (#2602 M-4); a refused spawn never ends a session the host runs (#2607 N-6) |
//! | `inv_9_a_refused_resume_ends_its_preallocated_session` | `ControlLoop::end_preallocated_session` (#2602 M-4) |
//! | `inv_10_run_serves_member_hosts_only` | the scope gate in `cli::run` (#2602 M-4) |
//! | `inv_11_credentials_never_leave_the_host_even_split_across_flushes` | `projection::redact_credentials` and the relay's hold (`session::ready_len`) (#2602 M-1) |
//! | `inv_11b_codex_events_are_sanitised_and_split_the_same_way` | the same relay for a Codex session (ADR-0188 §8, #2607) |
//! | `inv_12_a_slash_command_never_reaches_the_agent` | `policy::check_prompt` on the spawn label and on input (#2602 L-7) |
//! | `inv_13_rows_for_another_host_or_not_dispatched_are_ignored` | the host/status filter in `ControlLoop::poll_once` (#2602 L-6) |
//! | `inv_14_sessions_and_queued_inputs_are_bounded` | `max_sessions` in `SessionManager::spawn`, `MAX_QUEUED_PROMPTS` in the session task (#2602 L-2) |
//! | `inv_15_a_kill_ends_the_whole_tree_even_a_setsid_grandchild` | the process-tree census and member signals in `AcpConnection::terminate` (#2602 L-1, #2607) |
//! | `inv_16_an_agent_that_exits_on_its_own_takes_its_tree_with_it` | the census on every tick and `AcpConnection::wait_exit` (#2602 L-1, #2607) |
//! | `inv_17_an_executable_that_is_not_the_named_adapter_is_stopped_at_initialize` | the `agentInfo.name` check in `session::handshake` (#2607 N-9) |
//! | `inv_18_a_token_split_by_a_tool_event_is_still_masked` | `EventRelay::status` flushing only complete lines (#2607 N-4) |
//! | `inv_19_an_open_key_header_does_not_hold_the_rest_of_the_answer` | the open-key hold bound in `session::ready_len` (#2607 N-5) |
//! | `inv_7_a_lost_spawn_ack_response_still_starts_the_session` | the settled-verdict sweep in `ControlLoop::poll_once` |
//! | `inv_20_the_hosts_environment_never_reaches_an_agent_or_its_commands` | `policy::AGENT_ENV_ALLOWLIST` in `policy::launch_spec` (#2630 F1); `HOME` in Codex's isolation environment (#2630 F5) |

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
use momo_workd::policy::{AdapterKind, CodexHome};
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
    codex: CodexHome,
    /// The owner's `HOME` in the host's environment: a fixture folder holding
    /// an owner-layer Codex skill (`.agents/skills/zz-owner-skill`), never the
    /// real one.
    owner_home: PathBuf,
}

/// #2630 F1: fake credentials planted in the host's environment. Synthetic,
/// and shaped like the names codex's own default excludes look for.
const PLANTED_TOKEN: (&str, &str) = ("ZZ_TEST_TOKEN", "zz-fake-token-2630");
const PLANTED_API_KEY: (&str, &str) = ("ZZ_TEST_API_KEY", "zz-fake-api-key-2630");

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
    let owner_home = dir.join("owner-home");
    let owner_skill = owner_home
        .join(".agents")
        .join("skills")
        .join("zz-owner-skill");
    std::fs::create_dir_all(&owner_skill).unwrap();
    std::fs::write(
        owner_skill.join("SKILL.md"),
        "---\nname: zz-owner-skill\ndescription: an owner-layer skill (fixture)\n---\n",
    )
    .unwrap();
    let mut parent_env: Vec<(String, String)> =
        std::env::vars().filter(|(key, _)| key != "HOME").collect();
    parent_env.push(("HOME".into(), owner_home.display().to_string()));
    // Present in the host's own environment; must never reach an agent.
    parent_env.push(("MOMO_WORKD_REGISTER_TOKEN".into(), "owner-token".into()));
    for (key, value) in [PLANTED_TOKEN, PLANTED_API_KEY] {
        parent_env.push((key.into(), value.into()));
    }
    let settings = SessionSettings {
        tools: tools
            .iter()
            .map(|(key, adapter, extra)| (key.to_string(), stub_entry(&record, *adapter, extra)))
            .collect::<BTreeMap<_, _>>(),
        working_directory: dir.join("repo"),
        acp_start_timeout: Duration::from_secs(10),
        parent_env,
        max_sessions: 2,
        codex: CodexHome::beside(&dir.join("state").join("host.json"))
            .with_owner_home(Some(owner_home.clone())),
    };
    let owner = Uuid::new_v4();
    let codex = settings.codex.clone();
    let sessions = SessionManager::new(server.clone(), settings);
    Harness {
        controls: ControlLoop::new(server.clone(), sessions, owner),
        server,
        owner,
        channel: Uuid::new_v4(),
        record,
        dir,
        codex,
        owner_home,
    }
}

/// The owner signed Codex in to the host's own home once
/// (`CODEX_HOME=… codex login`); only the file's presence matters here.
fn sign_in_codex(h: &Harness) {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&h.codex.home)
        .unwrap();
    let auth = h.codex.home.join("auth.json");
    std::fs::write(&auth, "{\"auth_mode\":\"test\"}").unwrap();
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
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

/// A spawn as a member host receives it: its owner's (#2602 M-4).
fn spawn(h: &Harness, tool: &str, label: &str) -> WorkControl {
    control(
        h,
        "spawn",
        h.owner,
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
async fn inv_2_a_session_outside_the_fixed_mode_is_corrected_before_its_first_prompt_or_refused() {
    // ADR-0188 D6 as amended on 2026-09-24 (§8, 성재 「시작 직후 교정」): an
    // agent whose own settings open it in another mode is set to the fixed
    // mode before any prompt, and runs only once it confirms.
    let mut h = harness(&[
        ("auto", &["--mode", "auto"]),
        ("bypass", &["--mode", "bypassPermissions"]),
    ]);
    for tool in ["auto", "bypass"] {
        let request = spawn(&h, tool, "fix the bug");
        h.server.push(request.clone());
        h.controls.poll_once().await.unwrap();
        let session = ack_for(&h, request.id)
            .session_id
            .unwrap_or_else(|| panic!("{tool}: corrected, then opened"));
        wait_for("the corrected turn to end", || {
            h.server
                .statuses(session)
                .contains(&SessionStatus::Idle { exit_code: 0 })
        })
        .await;
    }
    let log = stub_log(&h);
    let methods: Vec<&str> = log
        .iter()
        .filter_map(|entry| entry["received"]["method"].as_str())
        .collect();
    let first_prompt = methods
        .iter()
        .position(|method| *method == "session/prompt")
        .expect("a prompt ran");
    let set_mode = methods
        .iter()
        .position(|method| *method == "session/set_mode")
        .expect("the host asked for the fixed mode");
    assert!(
        set_mode < first_prompt,
        "corrected before the first prompt: {methods:?}"
    );
    assert!(log
        .iter()
        .filter(|entry| entry["received"]["method"] == "session/set_mode")
        .all(|entry| entry["received"]["params"]["modeId"] == "default"));
    let prompt_modes: Vec<&str> = log
        .iter()
        .filter_map(|entry| entry["prompt_mode"].as_str())
        .collect();
    assert_eq!(
        prompt_modes,
        ["default", "default"],
        "every prompt ran in the fixed mode"
    );

    // A correction the agent refuses, does not confirm, or confirms as
    // another mode: no session, no prompt.
    let mut h = harness(&[
        ("refuses", &["--mode", "auto", "--set-mode-error"]),
        ("silent", &["--mode", "auto", "--set-mode-silent"]),
        (
            "lies",
            &["--mode", "auto", "--set-mode-reports", "acceptEdits"],
        ),
    ]);
    for tool in ["refuses", "silent", "lies"] {
        let request = spawn(&h, tool, "fix the bug");
        h.server.push(request.clone());
        h.controls.poll_once().await.unwrap();
        assert_eq!(
            ack_for(&h, request.id),
            ControlAck::refused("permission_mode_refused"),
            "{tool}: an unconfirmed correction must not open a session"
        );
    }
    assert!(
        h.server.creates().is_empty(),
        "no server session was created"
    );
    assert!(
        !received_methods(&h)
            .iter()
            .any(|method| method == "session/prompt"),
        "the agent never saw a prompt"
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

    // #2630 F2: the agent's LAST report is its mode. `default` then `auto`
    // with the answer is `auto`: refused, whatever the first report said.
    let mut h = harness(&[(
        "flips",
        &["--mode", "auto", "--set-mode-reports", "default,auto"],
    )]);
    let flips = spawn(&h, "flips", "fix the bug");
    h.server.push(flips.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, flips.id),
        ControlAck::refused("permission_mode_refused"),
        "default then auto: the last report wins"
    );
    assert!(h.server.creates().is_empty());
    assert!(!received_methods(&h)
        .iter()
        .any(|method| method == "session/prompt"));
    // And after the answer: `auto` then `default` is `default` — the
    // correction is confirmed by the later report, not refused by the first.
    let mut h = harness(&[(
        "settles",
        &[
            "--mode",
            "auto",
            "--set-mode-reports",
            "auto,default",
            "--set-mode-reports-late",
        ],
    )]);
    let settles = spawn(&h, "settles", "fix the bug");
    h.server.push(settles.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, settles.id)
        .session_id
        .expect("auto then default: the last report wins");
    wait_for("the confirmed turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    let prompt_modes: Vec<String> = stub_log(&h)
        .iter()
        .filter_map(|entry| entry["prompt_mode"].as_str().map(str::to_string))
        .collect();
    assert_eq!(prompt_modes, ["default"]);
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
    // configuration but the host's (none), no bypass mode in the catalog — and
    // (#2602 M-1) reads fenced to the folder, credential files denied.
    assert_eq!(
        new_session["received"]["params"]["_meta"]["claudeCode"]["options"],
        json!({
            "settingSources": [],
            "strictMcpConfig": true,
            "allowDangerouslySkipPermissions": false,
            "settings": {
                "permissions": {
                    "blockReadsOutsideWorkingDirectories": true,
                    "disableBypassPermissionsMode": "disable",
                    "deny": momo_workd::policy::claude_read_deny(),
                },
                // #2607 N-1: every Bash command in the OS sandbox.
                "sandbox": {
                    "enabled": true,
                    "failIfUnavailable": true,
                    "autoAllowBashIfSandboxed": false,
                    "allowUnsandboxedCommands": false,
                    "filesystem": {"denyRead": momo_workd::policy::CLAUDE_SANDBOX_DENY_READ},
                    "credentials": {"files": momo_workd::policy::CLAUDE_HOME_CREDENTIALS
                        .iter()
                        .map(|path| json!({"path": path, "mode": "deny"}))
                        .collect::<Vec<_>>()},
                },
            },
        })
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
async fn inv_6_codex_runs_only_from_the_hosts_own_home() {
    // ADR-0188 §8 (2026-09-24): Codex runs inside its accepted sandbox, from
    // the host's own CODEX_HOME, signed in there by the owner.
    let mut h = harness_with(&[(
        "codex",
        AdapterKind::Codex,
        &["--codex-modes", "--mode", "read-only"],
    )]);

    // Not signed in to the host's home yet: refused before anything launches.
    let early = spawn(&h, "codex", "look around");
    h.server.push(early.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, early.id),
        ControlAck::refused("codex_login_required")
    );
    assert!(!h.record.exists(), "nothing launched: {:?}", stub_log(&h));

    // A project `.codex` in the folder is still refused.
    sign_in_codex(&h);
    std::fs::create_dir_all(h.dir.join("repo").join(".codex")).unwrap();
    let project = spawn(&h, "codex", "look around");
    h.server.push(project.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, project.id),
        ControlAck::refused("project_config_refused")
    );
    assert!(!h.record.exists());
    std::fs::remove_dir_all(h.dir.join("repo").join(".codex")).unwrap();

    // Signed in: the session runs, from the host's home, in the fixed preset.
    let request = spawn(&h, "codex", "summarise the repo");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    wait_for("the first turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    let log = stub_log(&h);
    let env = &log[0]["env_isolation"];
    assert_eq!(
        env["CODEX_HOME"].as_str().map(PathBuf::from),
        Some(h.codex.home.clone()),
        "the owner's ~/.codex is never Codex's home"
    );
    assert_eq!(
        env["TMPDIR"].as_str().map(PathBuf::from),
        Some(h.codex.tmp.clone())
    );
    assert_eq!(env["INITIAL_AGENT_MODE"], "read-only");
    let config: Value = serde_json::from_str(env["CODEX_CONFIG"].as_str().unwrap()).unwrap();
    for feature in momo_workd::policy::CODEX_DISABLED_FEATURES {
        assert_eq!(config["features"][*feature], false, "{feature}");
    }
    assert_eq!(
        std::fs::read_to_string(h.codex.home.join("config.toml")).unwrap(),
        momo_workd::policy::codex_home_config(&h.codex),
        "the host's own config, written before the session"
    );
    let answer: String = h
        .server
        .events()
        .iter()
        .filter(|event| event.event_type == "agent.partial")
        .map(|event| event.payload["text_delta"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(answer, "stub heard: summarise the repo — done.");
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

#[tokio::test]
async fn inv_8_a_spawn_from_anyone_but_the_owner_is_refused() {
    // A spawn an agent asked for, delivered anyway (a server regression or a
    // row from before R0): the host refuses it before launching anything.
    let mut h = harness(&[("claude", &[])]);
    let foreign = control(
        &h,
        "spawn",
        Uuid::new_v4(),
        None,
        json!({"tool": "claude", "label": "agent asks"}),
    );
    h.server.push(foreign.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, foreign.id),
        ControlAck::refused("requester_not_owner"),
        "a member host runs its owner's spawns only"
    );
    assert!(
        !h.record.exists(),
        "nothing was launched: {:?}",
        stub_log(&h)
    );
    assert!(h.server.creates().is_empty());

    // #2607 N-6 (the reviewer's Probe M4): a refused spawn that names a
    // session the owner is running must not end it — neither from someone
    // else, nor as a duplicate of the owner's own.
    let request = spawn(&h, "claude", "keep working");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let live = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    wait_for("the owner's first turn to end", || {
        h.server
            .statuses(live)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    let hijack = control(
        &h,
        "spawn",
        Uuid::new_v4(),
        Some(live),
        json!({"tool": "claude", "label": "agent asks"}),
    );
    h.server.push(hijack.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, hijack.id),
        ControlAck::refused("requester_not_owner")
    );
    let duplicate = control(
        &h,
        "spawn",
        h.owner,
        Some(live),
        json!({"tool": "claude", "label": "again"}),
    );
    h.server.push(duplicate.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, duplicate.id),
        ControlAck::refused("invalid_control")
    );
    assert!(
        !h.server
            .statuses(live)
            .iter()
            .any(|status| matches!(status, SessionStatus::Ended { .. })),
        "the owner's running session was not ended: {:?}",
        h.server.statuses(live)
    );
    assert_eq!(h.controls.sessions().live_sessions(), vec![live]);
}

#[tokio::test]
async fn inv_17_an_executable_that_is_not_the_named_adapter_is_stopped_at_initialize() {
    // #2607 N-9: an allowlist entry labelled `claude` whose executable is
    // codex-acp (its `initialize` names itself) never reaches `session/new`,
    // where codex-acp would trust the folder and read its `.codex`.
    let mut h = harness(&[(
        "claude",
        &["--agent-name", "@agentclientprotocol/codex-acp"],
    )]);
    let request = spawn(&h, "claude", "look around");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, request.id),
        ControlAck::refused("adapter_mismatch")
    );
    assert_eq!(
        received_methods(&h),
        ["initialize"],
        "stopped before session/new"
    );
    assert!(h.server.creates().is_empty());
}

#[tokio::test]
async fn inv_9_a_refused_resume_ends_its_preallocated_session() {
    // A resume carries the session the server already opened for it. The
    // agent opens in `auto` and refuses the correction, so the host refuses —
    // and must close that session rather than leave it `running` with nothing
    // behind it.
    let mut h = harness(&[("claude", &["--mode", "auto", "--set-mode-error"])]);
    let preallocated = Uuid::new_v4();
    let resume = control(
        &h,
        "spawn",
        h.owner,
        Some(preallocated),
        json!({"tool": "claude", "label": "resume me"}),
    );
    h.server.push(resume.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, resume.id),
        ControlAck::refused("permission_mode_refused")
    );
    assert_eq!(
        h.server.statuses(preallocated),
        vec![SessionStatus::Ended { exit_code: None }],
        "the refused resume's session is ended by the host"
    );
    assert!(
        h.server.creates().is_empty(),
        "a resume never creates a session"
    );
}

#[test]
fn inv_10_run_serves_member_hosts_only() {
    let dir = std::env::temp_dir().join(format!("momo-workd-scope-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(dir.join("repo")).unwrap();
    {
        // The owner's own folder whatever the umask (`config::check_parent_folder`).
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let key_path = dir.join("keys").join("host.key");
    let key = momo_workd::keystore::HostKey::generate().unwrap();
    momo_workd::keystore::KeyStore::dev_file(key_path.clone())
        .store(&key, false)
        .unwrap();
    let workspace = Uuid::new_v4();
    // Port 9 (discard): nothing may be reached before the scope gate refuses.
    let server = "http://127.0.0.1:9";
    let config = dir.join("workd.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&json!({
            "server_url": server,
            "workspace_id": workspace,
            "display_name": "scope gate",
            "state_path": dir.join("state.json"),
            "working_directory": dir.join("repo"),
            "tools": {"claude": {"adapter": "claude", "executable": STUB}},
            "poll_interval_ms": 200,
            "heartbeat_interval_ms": 500,
        }))
        .unwrap(),
    )
    .unwrap();
    // The owner's own file whatever the umask (`config::read_owned_file`).
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    momo_workd::config::HostState {
        server_url: server.to_string(),
        workspace_id: workspace,
        host_id: Uuid::new_v4(),
        owner_member_id: Uuid::new_v4(),
        public_key: key.public_key_b64(),
        scope: "workspace".to_string(),
    }
    .save(&dir.join("state.json"))
    .unwrap();

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_momo-workd"))
        .args(["run", "--config"])
        .arg(&config)
        .arg("--dev-key-file")
        .arg(&key_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            panic!("a workspace-scoped host must not be served: momo-workd kept running");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut stderr = String::new();
    use std::io::Read as _;
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(status.code(), Some(2), "usage exit: {stderr}");
    assert!(stderr.contains("serves only"), "{stderr}");
}

#[tokio::test]
async fn inv_11_credentials_never_leave_the_host_even_split_across_flushes() {
    let mut h = harness(&[("claude", &["--leak"])]);
    assert_nothing_leaks(&mut h, "claude").await;
}

#[tokio::test]
async fn inv_11b_codex_events_are_sanitised_and_split_the_same_way() {
    // ADR-0188 §8: Codex reads the whole disk, so the event-stream
    // sanitisation (#2602 M-1) is what stands between a read secret and the
    // server — the same relay, the same result.
    let mut h = harness_with(&[
        (
            "codex",
            AdapterKind::Codex,
            &["--codex-modes", "--mode", "read-only", "--leak"],
        ),
        (
            "codex-long",
            AdapterKind::Codex,
            &[
                "--codex-modes",
                "--mode",
                "read-only",
                "--long-answer",
                "9000",
            ],
        ),
    ]);
    sign_in_codex(&h);
    assert_nothing_leaks(&mut h, "codex").await;

    // And a long Codex answer is split into fields of at most 3,500
    // characters without losing a character.
    let request = spawn(&h, "codex-long", "write a lot");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    wait_for("the long turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    let partials: Vec<String> = h
        .server
        .events()
        .into_iter()
        .filter(|event| {
            event.event_type == "agent.partial"
                && event.payload["work_session_id"] == json!(session)
        })
        .map(|event| event.payload["text_delta"].as_str().unwrap().to_string())
        .collect();
    assert!(partials.len() >= 3, "9,000 characters take three fields");
    assert!(partials
        .iter()
        .all(|partial| partial.chars().count() <= momo_workd::projection::MAX_FIELD_CHARS));
    let long: String = "lorem ".chars().cycle().take(9000).collect();
    assert_eq!(
        partials.concat(),
        format!("stub heard: write a lot{long} — done.")
    );
}

async fn assert_nothing_leaks(h: &mut Harness, tool: &str) {
    let request = spawn(h, tool, "show me the config");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(h, request.id).session_id.expect("ok spawn ack");
    wait_for("the leaking turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;

    let partials: Vec<String> = h
        .server
        .events()
        .into_iter()
        .filter(|event| event.event_type == "agent.partial")
        .map(|event| event.payload["text_delta"].as_str().unwrap().to_string())
        .collect();
    assert!(
        partials.len() >= 3,
        "the age flushes did land between the pieces: {partials:?}"
    );
    let relayed = partials.concat();
    for fragment in [
        "sk-ant-api03-AAAA",
        "api03-",
        "ghp_abcdef",
        concat!("AKIA", "ABCDEFGHIJKLMNOP"),
        "b3BlbnNzaC1rZXkt",
        "OPENSSH PRIV",
        "xoxb-1234567890",
        "eyJhbGciOi",
    ] {
        assert!(
            !relayed.contains(fragment),
            "{fragment} left the host: {partials:?}"
        );
    }
    assert_eq!(
        relayed
            .matches(momo_workd::projection::REDACTED_CREDENTIAL)
            .count(),
        5,
        "{relayed}"
    );
    assert_eq!(
        relayed
            .matches(momo_workd::projection::REDACTED_PRIVATE_KEY)
            .count(),
        1,
        "{relayed}"
    );
    assert!(relayed.ends_with("end — done."), "{relayed}");
    for partial in &partials {
        assert!(partial.chars().count() <= momo_workd::projection::MAX_FIELD_CHARS);
    }
}

#[tokio::test]
async fn inv_12_a_slash_command_never_reaches_the_agent() {
    let mut h = harness(&[("claude", &[])]);
    // A label that is an adapter command: refused before anything launches.
    let logout = spawn(&h, "claude", "/logout");
    h.server.push(logout.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, logout.id),
        ControlAck::refused("slash_command_refused")
    );
    assert!(
        h.server.creates().is_empty(),
        "no session for a refused label"
    );
    assert!(stub_log(&h).is_empty(), "the agent was never launched");

    // An input that is an adapter command: refused, the session carries on.
    let request = spawn(&h, "claude", "hello");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    wait_for("the first turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    let compact = control(
        &h,
        "input",
        h.owner,
        Some(session),
        json!({"text": "  /compact"}),
    );
    h.server.push(compact.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(
        ack_for(&h, compact.id),
        ControlAck::refused("slash_command_refused")
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let prompts: Vec<String> = stub_log(&h)
        .iter()
        .filter(|entry| entry["received"]["method"] == "session/prompt")
        .filter_map(|entry| {
            entry["received"]["params"]["prompt"][0]["text"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert_eq!(
        prompts,
        ["hello"],
        "only the plain prompt reached the agent"
    );
}

#[tokio::test]
async fn inv_13_rows_for_another_host_or_not_dispatched_are_ignored() {
    let mut h = harness(&[("claude", &[])]);
    let mut elsewhere = spawn(&h, "claude", "for another host");
    elsewhere.target_host_id = Uuid::new_v4();
    let mut pending = spawn(&h, "claude", "not approved yet");
    pending.status = "pending_approval".to_string();
    h.server.push(elsewhere);
    h.server.push(pending);
    let handled = h.controls.poll_once().await.unwrap();
    assert_eq!(handled, 0, "neither row is this host's to act on");
    assert!(h.server.acks().is_empty(), "nothing was acknowledged");
    assert!(h.server.creates().is_empty(), "no session was opened");
    assert!(stub_log(&h).is_empty(), "no agent was launched");
}

#[tokio::test]
async fn inv_14_sessions_and_queued_inputs_are_bounded() {
    // The harness allows two sessions; the agent never finishes a turn, so
    // every later input waits in the session's queue.
    let mut h = harness(&[("claude", &["--hang"])]);
    let mut sessions = Vec::new();
    for label in ["one", "two"] {
        let request = spawn(&h, "claude", label);
        h.server.push(request.clone());
        h.controls.poll_once().await.unwrap();
        sessions.push(ack_for(&h, request.id).session_id.expect("ok spawn ack"));
    }
    let third = spawn(&h, "claude", "three");
    h.server.push(third.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(ack_for(&h, third.id), ControlAck::refused("host_busy"));
    assert_eq!(h.server.creates().len(), 2, "no third session was opened");

    let session = sessions[0];
    for index in 0..=momo_workd::session::MAX_QUEUED_PROMPTS {
        let input = control(
            &h,
            "input",
            h.owner,
            Some(session),
            json!({"text": format!("next {index}")}),
        );
        h.server.push(input.clone());
        h.controls.poll_once().await.unwrap();
        let expected = if index < momo_workd::session::MAX_QUEUED_PROMPTS {
            ControlAck::ok(Some(session))
        } else {
            ControlAck::refused("input_queue_full")
        };
        assert_eq!(ack_for(&h, input.id), expected, "input {index}");
    }
    for session in sessions {
        let kill = control(&h, "kill", h.owner, Some(session), json!({}));
        h.server.push(kill.clone());
        h.controls.poll_once().await.unwrap();
        assert_eq!(ack_for(&h, kill.id), ControlAck::ok(Some(session)));
    }
}

/// "<sleeper pid> <helper pid>" as the stub's `--setsid-grandchild` wrote it.
fn read_tree_pids(path: &Path) -> Option<(i32, i32)> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut parts = text.split_whitespace();
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// Exists and is not a zombie (`kill(pid, 0)` alone counts a zombie).
fn is_running(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let exists = unsafe { libc::kill(pid, 0) } == 0;
    exists && momo_workd::proctree::info(pid).is_some_and(|process| !process.zombie)
}

/// Test hygiene: whatever the assertions say, these pids do not outlive the
/// test.
struct Reap(Vec<i32>);

impl Drop for Reap {
    fn drop(&mut self) {
        for pid in &self.0 {
            // SAFETY: plain syscall on processes this test started.
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }
}

async fn detached_tree(pids: &Path) -> (i32, i32, Reap) {
    wait_for("the helper to start its detached sleeper", || {
        read_tree_pids(pids).is_some()
    })
    .await;
    let (sleeper, helper) = read_tree_pids(pids).unwrap();
    let reap = Reap(vec![sleeper, helper]);
    assert!(is_running(sleeper) && is_running(helper));
    // The shape #2602 L-1 is about: the sleeper left the agent's process
    // group (codex's `setsid()`), so a group signal cannot reach it.
    // SAFETY: plain syscalls.
    let (sleeper_group, helper_group) = unsafe { (libc::getpgid(sleeper), libc::getpgid(helper)) };
    assert_ne!(sleeper_group, helper_group);
    (sleeper, helper, reap)
}

#[tokio::test]
async fn inv_15_a_kill_ends_the_whole_tree_even_a_setsid_grandchild() {
    let pids = std::env::temp_dir().join(format!("momo-workd-tree-{}", Uuid::new_v4().simple()));
    let path = pids.display().to_string();
    let mut h = harness(&[("claude", &["--setsid-grandchild", &path, "--hang"])]);
    let request = spawn(&h, "claude", "start a long build");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    let (sleeper, helper, _reap) = detached_tree(&pids).await;

    let kill = control(&h, "kill", h.owner, Some(session), json!({}));
    h.server.push(kill.clone());
    h.controls.poll_once().await.unwrap();
    assert_eq!(ack_for(&h, kill.id), ControlAck::ok(Some(session)));
    wait_for(
        "the setsid sleeper and the TERM-ignoring helper to be gone",
        || !is_running(sleeper) && !is_running(helper),
    )
    .await;
    let _ = std::fs::remove_file(&pids);
}

#[tokio::test]
async fn inv_16_an_agent_that_exits_on_its_own_takes_its_tree_with_it() {
    let pids = std::env::temp_dir().join(format!("momo-workd-tree-{}", Uuid::new_v4().simple()));
    let path = pids.display().to_string();
    let mut h = harness(&[(
        "claude",
        &["--setsid-grandchild", &path, "--exit-after-turn"],
    )]);
    let request = spawn(&h, "claude", "one turn, then exit");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(&h, request.id).session_id.expect("ok spawn ack");
    let (sleeper, helper, _reap) = detached_tree(&pids).await;

    wait_for("the session to end on its own", || {
        matches!(
            h.server.statuses(session).last(),
            Some(SessionStatus::Ended { .. })
        )
    })
    .await;
    wait_for("what the exited agent left running to be gone", || {
        !is_running(sleeper) && !is_running(helper)
    })
    .await;
    let _ = std::fs::remove_file(&pids);
}

fn relayed_text(h: &Harness, session: Uuid) -> String {
    h.server
        .events()
        .into_iter()
        .filter(|event| {
            event.event_type == "agent.partial"
                && event.payload["work_session_id"] == json!(session)
        })
        .map(|event| event.payload["text_delta"].as_str().unwrap().to_string())
        .collect()
}

async fn one_turn(h: &mut Harness, tool: &str) -> Uuid {
    let request = spawn(h, tool, "go");
    h.server.push(request.clone());
    h.controls.poll_once().await.unwrap();
    let session = ack_for(h, request.id).session_id.expect("ok spawn ack");
    wait_for("the turn to end", || {
        h.server
            .statuses(session)
            .contains(&SessionStatus::Idle { exit_code: 0 })
    })
    .await;
    session
}

#[tokio::test]
async fn inv_18_a_token_split_by_a_tool_event_is_still_masked() {
    // #2607 N-4, the reviewer's Probe B: a tool event between the two halves
    // of a token used to flush the first half on its own.
    let mut h = harness(&[("claude", &["--split-by-status"])]);
    let session = one_turn(&mut h, "claude").await;
    let relayed = relayed_text(&h, session);
    assert!(!relayed.contains("api03-AAAA"), "{relayed}");
    assert!(!relayed.contains("AAAAAAAAAA"), "{relayed}");
    assert_eq!(
        relayed
            .matches(momo_workd::projection::REDACTED_CREDENTIAL)
            .count(),
        1,
        "{relayed}"
    );
    assert!(h
        .server
        .events()
        .iter()
        .any(|event| event.payload["tool_call_name"] == "read"));
}

#[tokio::test]
async fn inv_19_an_open_key_header_does_not_hold_the_rest_of_the_answer() {
    // #2607 N-5, the reviewer's Probe D: after a PEM header that never
    // closes, the relay held everything until the turn ended and then masked
    // it all. Now the hold is bounded: the block is released masked, and the
    // answer after it is relayed.
    let mut h = harness(&[("claude", &["--pem-flood", "40000"])]);
    let session = one_turn(&mut h, "claude").await;
    let relayed = relayed_text(&h, session);
    assert!(
        relayed.contains(momo_workd::projection::REDACTED_PRIVATE_KEY),
        "{}",
        &relayed[..relayed.len().min(300)]
    );
    assert!(
        !relayed.contains("lorem ipsum"),
        "the block itself stays masked"
    );
    assert!(
        relayed.contains("visible tail"),
        "the answer after the block arrives"
    );
}

/// The names an agent may see from the host's environment (#2630 F1), written
/// out here rather than read from the policy: this is the contract the test
/// holds the policy to.
fn allowed_from_host(name: &str) -> bool {
    [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG",
    ]
    .contains(&name)
        || name.starts_with("LC_")
}

fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("a list of names: {value}"))
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn inv_20_the_hosts_environment_never_reaches_an_agent_or_its_commands() {
    // #2630 F1 (the #2621 re-review): the host's environment went to the
    // agent whole, minus MOMO_*/OORT_*, and from there to every command the
    // agent runs without asking. Two fake credentials are planted in it.
    let mut h = harness_with(&[
        ("claude", AdapterKind::Claude, &[]),
        (
            "codex",
            AdapterKind::Codex,
            &["--codex-modes", "--mode", "read-only"],
        ),
    ]);
    sign_in_codex(&h);
    for tool in ["claude", "codex"] {
        one_turn(&mut h, tool).await;
    }
    let starts: Vec<Value> = stub_log(&h)
        .into_iter()
        .filter(|entry| entry.get("env_keys").is_some())
        .collect();
    assert_eq!(starts.len(), 2, "one launch per adapter");
    for start in &starts {
        let codex = start["env_isolation"]["CODEX_HOME"].is_string();
        let agent = names(&start["env_keys"]);
        let command = names(&start["command_env_keys"]);
        for planted in [
            PLANTED_TOKEN.0,
            PLANTED_API_KEY.0,
            "MOMO_WORKD_REGISTER_TOKEN",
        ] {
            assert!(
                !agent.iter().any(|name| name == planted),
                "{planted} reached the agent (codex: {codex}): {agent:?}"
            );
            assert!(
                !command.iter().any(|name| name == planted),
                "{planted} reached a command the agent ran (codex: {codex}): {command:?}"
            );
        }
        // Only the allowlist, and what the host sets itself.
        let host_set: &[&str] = if codex {
            &[
                "CODEX_HOME",
                "TMPDIR",
                "INITIAL_AGENT_MODE",
                "CODEX_CONFIG",
                "HOME",
            ]
        } else {
            &[]
        };
        for name in &agent {
            assert!(
                allowed_from_host(name) || host_set.contains(&name.as_str()),
                "{name} is neither allowlisted nor set by the host (codex: {codex})"
            );
        }
    }
    // #2630 F5: Codex reads the user skill layer from `$HOME/.agents/skills`
    // (codex `ext/skills/src/host_roots.rs`), so its HOME is not the owner's.
    let codex_start = starts
        .iter()
        .find(|start| start["env_isolation"]["CODEX_HOME"].is_string())
        .unwrap();
    let codex_home_dir = codex_start["env_isolation"]["HOME"]
        .as_str()
        .map(PathBuf::from)
        .expect("Codex runs with a HOME");
    assert_ne!(
        codex_home_dir, h.owner_home,
        "the owner's HOME (and its ~/.agents/skills) is never Codex's"
    );
    assert_eq!(
        codex_home_dir, h.codex.user_home,
        "Codex's HOME is the host's own empty folder"
    );
    assert!(!codex_home_dir.join(".agents").exists());
    let claude_start = starts
        .iter()
        .find(|start| !start["env_isolation"]["CODEX_HOME"].is_string())
        .unwrap();
    assert_eq!(
        claude_start["env_isolation"]["HOME"]
            .as_str()
            .map(PathBuf::from),
        Some(h.owner_home.clone()),
        "Claude keeps the owner's HOME: its sign-in lives there"
    );
}
