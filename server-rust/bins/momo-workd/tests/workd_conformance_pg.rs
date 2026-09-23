//! DB-backed conformance for **#2571** (ADR-0188 R1, first slice): the real
//! `momo-workd` binary against the real server router on an isolated PG.
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the runtime
//! roles, exactly like `momo-server`'s `*_conformance_pg` suites:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:19522/momo \
//!   cargo test -p momo-workd --test workd_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! The server runs as `momo_app` (NOBYPASSRLS); fixtures and ledger reads use
//! the superuser. Dispatched controls are written straight to `work_control`:
//! how a control *becomes* dispatched is the server's business (and ADR-0188 R0
//! changes it for member-scoped hosts); what this suite measures is the host's
//! half — poll, apply, ack, session, events, end.
//!
//! | test | what it proves |
//! |---|---|
//! | `wdc_1_register_heartbeat_spawn_events_kill_round_trip` | register with the owner's token → v2 heartbeat marks the host online → spawn → curated events (answer, plan, tool kind, denial + reason) → idle → kill → ended; no listening TCP socket. The heartbeat step needs the #2570 server (v2 heartbeat). |
//! | `wdc_2_shell_and_auto_mode_are_refused_on_the_ledger` | a remote `shell` spawn and an agent in `auto` mode are refused with their labels, and no session exists |
//! | `wdc_3_a_revoked_host_stops` | ADR-0188 D7: after revoke the host gets 401 and exits (code 3) |

use std::net::SocketAddr;
use std::os::unix::fs::MetadataExt as _;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const WORKD: &str = env!("CARGO_BIN_EXE_momo-workd");
const STUB: &str = env!("CARGO_BIN_EXE_momo-workd-acp-stub");
const TEST_JWT_SECRET: &str = "wdc-2571-workd-conformance-secret";
const TEST_PASSWORD: &str = "wdc-2571-conformance-password";
const PERMISSION_DENIED_DETAIL: &str = momo_workd::session::PERMISSION_DENIED_DETAIL;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql?)")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_email: String,
    channel: Uuid,
    agent: Uuid,
}

async fn seed_fixture(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = Uuid::new_v4();
    let owner_email = format!("{owner}@wdc2571.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(owner.to_string())
    .execute(su)
    .await
    .expect("seed owner");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed owner auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed owner membership");
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("wdc-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    // Session create re-checks that the spawn's tool is enabled in the
    // workspace catalog. Its launch_template is never read by the host.
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, 'claude', 'claude', $2, true, $3, $3) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
    )
    .bind(workspace)
    .bind(json!({"command": "server-side-template-the-host-never-runs", "arguments": []}))
    .bind(owner)
    .execute(su)
    .await
    .expect("seed work tool profile");
    // The agent a spawn control names as its requester; its owner is the
    // session owner (`dispatched_spawn_owner_in_tx`).
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(agent.to_string())
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent membership");
    Fixture {
        workspace,
        owner,
        owner_email,
        channel,
        agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.owner_email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

/// One workd installation: its own folder, config, dev key file and logs.
struct Workd {
    dir: PathBuf,
    config: PathBuf,
    key: PathBuf,
    log: PathBuf,
    child: Option<tokio::process::Child>,
}

impl Drop for Workd {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Workd {
    /// `tools`: key → stub arguments (each tool gets its own record file,
    /// `<key>.jsonl`).
    fn new(base: &str, fixture: &Fixture, tools: &[(&str, &[&str])]) -> Self {
        let dir = std::env::temp_dir().join(format!("momo-wdc-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        let tools: serde_json::Map<String, Value> = tools
            .iter()
            .map(|(key, extra)| {
                let mut args = vec![
                    "--record".to_string(),
                    dir.join(format!("{key}.jsonl")).display().to_string(),
                ];
                args.extend(extra.iter().map(|arg| arg.to_string()));
                (
                    key.to_string(),
                    json!({"adapter": "claude", "executable": STUB, "args": args}),
                )
            })
            .collect();
        let config = dir.join("workd.json");
        std::fs::write(
            &config,
            serde_json::to_vec_pretty(&json!({
                "server_url": base,
                "workspace_id": fixture.workspace,
                "display_name": "wdc-2571 host",
                "state_path": dir.join("state").join("host.json"),
                "working_directory": dir.join("repo"),
                "tools": tools,
                "poll_interval_ms": 200,
                "heartbeat_interval_ms": 500,
                "acp_start_timeout_ms": 10_000,
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            key: dir.join("keys").join("host.key"),
            log: dir.join("workd.log"),
            config,
            dir,
            child: None,
        }
    }

    fn record(&self, key: &str) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join(format!("{key}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn log_tail(&self) -> String {
        let log = std::fs::read_to_string(&self.log).unwrap_or_default();
        let lines: Vec<&str> = log.lines().collect();
        lines[lines.len().saturating_sub(40)..].join("\n")
    }

    /// `momo-workd register` with the owner's token in the environment.
    async fn register(&self, token: &str) -> Value {
        let output = tokio::process::Command::new(WORKD)
            .args(["register", "--config"])
            .arg(&self.config)
            .arg("--dev-key-file")
            .arg(&self.key)
            .env("MOMO_WORKD_REGISTER_TOKEN", token)
            .output()
            .await
            .expect("run momo-workd register");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "register failed: {stderr}");
        assert!(
            !stderr.contains(token),
            "the owner's token never reaches a log line"
        );
        serde_json::from_slice(&output.stdout).expect("register prints one JSON line")
    }

    fn start(&mut self) -> u32 {
        let log = std::fs::File::create(&self.log).unwrap();
        let child = tokio::process::Command::new(WORKD)
            .args(["run", "--config"])
            .arg(&self.config)
            .arg("--dev-key-file")
            .arg(&self.key)
            .env("MOMO_WORKD_LOG", "momo_workd=debug,info")
            .stdout(std::process::Stdio::null())
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn momo-workd run");
        let pid = child.id().expect("running pid");
        self.child = Some(child);
        pid
    }

    async fn stop(&mut self) -> Option<i32> {
        let child = self.child.as_mut()?;
        let pid = child.id()? as libc::pid_t;
        // SAFETY: plain syscall on our own child.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        tokio::time::timeout(Duration::from_secs(15), child.wait())
            .await
            .expect("workd exits after SIGTERM")
            .ok()
            .and_then(|status| status.code())
    }
}

async fn wait_until<T, F, Fut>(what: &str, workd: &Workd, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..200 {
        if let Some(value) = probe().await {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "timed out waiting for {what}\n--- workd log ---\n{}",
        workd.log_tail()
    );
}

async fn insert_control(
    su: &PgPool,
    fixture: &Fixture,
    host: Uuid,
    requester: Uuid,
    session: Option<Uuid>,
    kind: &str,
    payload: Value,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, session_id, \
            kind, payload, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'dispatched') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(requester)
    .bind(host)
    .bind(session)
    .bind(kind)
    .bind(payload)
    .fetch_one(su)
    .await
    .expect("insert a dispatched control")
}

async fn control_state(su: &PgPool, control: Uuid) -> (String, Option<Uuid>) {
    sqlx::query_as("SELECT status, session_id FROM work_control WHERE id = $1")
        .bind(control)
        .fetch_one(su)
        .await
        .expect("read control")
}

async fn session_status(su: &PgPool, session: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("read session")
}

async fn ack_error_label(su: &PgPool, fixture: &Fixture, control: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT payload->'data'->'payload'->>'error_label' FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.control.acked' \
            AND payload->'data'->'payload'->>'control_id' = $2",
    )
    .bind(fixture.workspace)
    .bind(control.to_string())
    .fetch_optional(su)
    .await
    .expect("read ack envelope")
    .flatten()
}

async fn host_row(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
    host: Uuid,
) -> Value {
    let body: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/work-hosts",
            fixture.workspace
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("list hosts")
        .json()
        .await
        .expect("hosts body");
    body["workHosts"]
        .as_array()
        .expect("workHosts")
        .iter()
        .find(|row| row["id"] == json!(host.to_string()))
        .cloned()
        .expect("the registered host is listed")
}

fn listening_tcp_sockets(pid: u32) -> String {
    let output = Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"])
        .output()
        .expect("lsof is available");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_1_register_heartbeat_spawn_events_kill_round_trip() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;

    // ---- register: the owner's token, the key's public half only ----------
    let mut workd = Workd::new(&base, &fixture, &[("claude", &["--permission"])]);
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();
    assert_eq!(
        registered["ownerMemberId"],
        json!(fixture.owner.to_string())
    );
    let key_mode = std::fs::metadata(&workd.key).unwrap().mode() & 0o777;
    assert_eq!(key_mode, 0o600, "the dev key file is private");
    let row = host_row(&http, &base, &token, &fixture, host).await;
    assert_eq!(
        row["scope"], "member",
        "ADR-0188 D3: a desktop host is its owner's"
    );
    assert_eq!(row["type"], "workd");
    assert_eq!(row["ownerMemberId"], json!(fixture.owner.to_string()));
    let stored_key = std::fs::read_to_string(&workd.key).unwrap();
    assert!(
        !serde_json::to_string(&row)
            .unwrap()
            .contains(stored_key.trim()),
        "the server never sees the private key"
    );
    eprintln!("wdc_1: registered host {host}");

    // ---- run: no listening socket of any kind ------------------------------
    let pid = workd.start();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        listening_tcp_sockets(pid),
        "",
        "ADR-0188 D2: momo-workd opens no TCP port"
    );

    // ---- spawn → session → curated events → idle ----------------------------
    let spawn = insert_control(
        &su,
        &fixture,
        host,
        fixture.agent,
        None,
        "spawn",
        json!({"tool": "claude", "label": "summarise the repo"}),
    )
    .await;
    let session = wait_until("the spawn ack", &workd, || async {
        match control_state(&su, spawn).await {
            (status, Some(session)) if status == "acked" => Some(session),
            _ => None,
        }
    })
    .await;
    eprintln!("wdc_1: spawn {spawn} acked with session {session}");
    wait_until("the first turn to go idle", &workd, || async {
        (session_status(&su, session).await == "idle").then_some(())
    })
    .await;

    let root: Uuid = sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(&su)
        .await
        .unwrap();
    let replies: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages/{root}/replies",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("read the session thread")
        .json()
        .await
        .expect("replies body");
    let events: Vec<&Value> = replies["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|row| row["props"]["kind"] == "work_session_event")
        .collect();
    let of_type = |kind: &str| -> Vec<&Value> {
        events
            .iter()
            .copied()
            .filter(|row| row["props"]["event_type"] == kind)
            .collect()
    };
    let answer: String = of_type("agent.partial")
        .iter()
        .map(|row| {
            row["props"]["event"]["text_delta"]
                .as_str()
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(answer, "stub heard: summarise the repo — done.");
    assert!(of_type("agent.status")
        .iter()
        .any(|row| row["props"]["event"]["has_plan"] == true));
    assert!(of_type("agent.status")
        .iter()
        .any(|row| row["props"]["event"]["tool_call_name"] == "execute"));
    let decided = of_type("approval.decided");
    assert_eq!(decided.len(), 1, "one denial on the ledger");
    assert_eq!(decided[0]["props"]["event"]["status"], "rejected");
    assert!(
        of_type("agent.status")
            .iter()
            .any(|row| row["body"] == PERMISSION_DENIED_DETAIL),
        "the reason is on the ledger"
    );
    assert!(
        of_type("approval.requested").is_empty(),
        "no preview crosses"
    );
    let ledger = serde_json::to_string(&events).unwrap();
    assert!(
        !ledger.contains("ssh"),
        "tool titles and raw input never reach the server"
    );
    assert!(
        !ledger.contains("private reasoning"),
        "thoughts are not relayed"
    );
    let outcomes: Vec<Value> = workd
        .record("claude")
        .into_iter()
        .filter_map(|entry| entry.get("permission_outcome").cloned())
        .collect();
    assert_eq!(
        outcomes,
        vec![json!({"outcome": "selected", "optionId": "reject-once"})],
        "the agent was answered with its own one-time rejection"
    );
    eprintln!(
        "wdc_1: {} session events on the ledger, denial + reason present",
        events.len()
    );

    // ---- kill → acked → ended -------------------------------------------------
    let kill = insert_control(
        &su,
        &fixture,
        host,
        fixture.agent,
        Some(session),
        "kill",
        json!({}),
    )
    .await;
    wait_until("the kill ack", &workd, || async {
        (control_state(&su, kill).await.0 == "acked").then_some(())
    })
    .await;
    wait_until("the session to end", &workd, || async {
        (session_status(&su, session).await == "ended").then_some(())
    })
    .await;
    eprintln!("wdc_1: kill {kill} acked, session ended");

    // ---- heartbeat (v2, #2570) ---------------------------------------------------
    // The host has been heartbeating since it started. Only a server that serves
    // the ADR-0188 D7 v2 heartbeat (#2570) accepts it; the v1 route refuses the
    // v2 request and the host stays offline.
    let row = host_row(&http, &base, &token, &fixture, host).await;
    assert_eq!(
        row["online"], true,
        "the v2-signed heartbeat must mark the host online (requires the #2570 server)\n--- workd log ---\n{}",
        workd.log_tail()
    );
    assert!(row["lastSeenAtMs"].as_i64().is_some());
    eprintln!("wdc_1: host online via v2 heartbeat");

    assert_eq!(workd.stop().await, Some(0), "SIGTERM is a clean stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_2_shell_and_auto_mode_are_refused_on_the_ledger() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;

    // The owner allowlisted something called `shell` (a launchable agent), and
    // a Claude whose own settings put it in `auto` mode.
    let mut workd = Workd::new(
        &base,
        &fixture,
        &[("shell", &[]), ("claude", &["--mode", "auto"])],
    );
    let host = Uuid::parse_str(workd.register(&token).await["hostId"].as_str().unwrap()).unwrap();
    workd.start();

    let shell = insert_control(
        &su,
        &fixture,
        host,
        fixture.agent,
        None,
        "spawn",
        json!({"tool": "shell", "label": "open a shell"}),
    )
    .await;
    let auto = insert_control(
        &su,
        &fixture,
        host,
        fixture.agent,
        None,
        "spawn",
        json!({"tool": "claude", "label": "fix the bug"}),
    )
    .await;
    for (control, label) in [(shell, "shell_refused"), (auto, "permission_mode_refused")] {
        wait_until(label, &workd, || async {
            (control_state(&su, control).await.0 == "failed").then_some(())
        })
        .await;
        assert_eq!(
            ack_error_label(&su, &fixture, control).await.as_deref(),
            Some(label),
            "the refusal reaches the room with its reason"
        );
        eprintln!("wdc_2: control {control} failed with {label}");
    }
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM work_session WHERE host_id = $1")
        .bind(host)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(sessions, 0, "no session exists for a refused spawn");
    assert!(
        workd.record("shell").is_empty(),
        "the shell entry was never launched"
    );
    let methods: Vec<String> = workd
        .record("claude")
        .iter()
        .filter_map(|entry| entry["received"]["method"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        methods,
        ["initialize", "session/new"],
        "no prompt reached an auto-mode agent"
    );
    assert_eq!(workd.stop().await, Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_3_a_revoked_host_stops() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;

    let mut workd = Workd::new(&base, &fixture, &[("claude", &[])]);
    let host = Uuid::parse_str(workd.register(&token).await["hostId"].as_str().unwrap()).unwrap();
    workd.start();
    tokio::time::sleep(Duration::from_millis(600)).await;

    let revoked = http
        .delete(format!(
            "{base}/v1/workspaces/{}/work-hosts/{host}",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), 200);

    let child = workd.child.as_mut().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap_or_else(|_| panic!("a revoked host must stop\n{}", workd.log_tail()))
        .expect("exit status");
    assert_eq!(
        status.code(),
        Some(3),
        "revocation is exit 3\n{}",
        workd.log_tail()
    );
    workd.child = None;
    eprintln!("wdc_3: revoked host {host} stopped with exit 3");
}
