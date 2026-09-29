//! DB-backed conformance for **#2571** (ADR-0188 R1, first slice) and its
//! hardening **#2602** (R1.1): the real `momo-workd` binary against the real
//! server router on an isolated PG.
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
//! the superuser. A kill or a pre-R0 row is written straight to `work_control`:
//! how such a control *becomes* dispatched is the server's business; what this
//! suite measures is the host's half — poll, apply, ack, session, events, end —
//! and, on a member host, which controls reach the host at all.
//!
//! ## Every served host is a member host (ADR-0188 D3, #2602 M-4)
//!
//! `momo-workd run` serves only the member-scoped host `momo-workd register`
//! creates, and there a spawn or an input is its owner's or nothing. So the
//! spawn round trip is the **owner's**, through the REST ledger with the
//! owner's human bearer: a session the owner opened on a second laptop is
//! orphaned (the sweep's transition) and resumed onto the served host
//! ([`owner_resume`]). That is the one owner-origin spawn the server dispatches
//! to a member host today — `POST …/work-controls` takes an agent bearer only, a
//! human `POST …/work-sessions` records a session without dispatching anything,
//! and the host-signed session create (`dispatched_spawn_owner_in_tx`) accepts
//! only a spawn an **agent** requested, so a fresh owner-origin spawn row would
//! be delivered and then refused at create (409).
//!
//! The #2582 adaptation measured the agent spawn round trip on a
//! workspace-scoped host the workspace owner registered through the API. That
//! no longer holds: `run` refuses every registration that is not `member`
//! (`wdc_5`), and a member host never receives an agent's spawn (`wdc_4`).
//!
//! Every request the server receives passes a recorder ([`Recorder`]), so the
//! suite can say what crossed the wire — not only what the server kept (#2602
//! M-5).
//!
//! | test | what it proves |
//! |---|---|
//! | `wdc_1_owner_resume_round_trip_and_no_seed_on_the_wire` | `momo-workd register` → the v2 heartbeat marks the host online; no listening TCP socket; the owner's resume → the pre-allocated session → curated events (answer, plan, tool kind, denial + reason) → idle → the owner's kill → ended; no request, from `register` to the last ack, carries the host key's seed in any encoding; and fake credentials planted in `run`'s environment reach neither the agent nor a command it runs (#2630 F1) |
//! | `wdc_2_mode_correction_codex_and_refusals_on_a_member_host` | the owner's resume onto an agent that opens in `auto` is corrected to the fixed mode before its first prompt and runs (#2607); one that refuses the correction is refused (`permission_mode_refused`) and the session the server allocated for it is ended by the host; a Codex resume runs from the host's own `CODEX_HOME`, with the host's own folder as `HOME` and the confined command environment in its config (ADR-0188 §8, #2630); a shell is refused at the resume (403 `remote_host_shell_refused`) and never reaches the host |
//! | `wdc_3_a_revoked_host_stops` | ADR-0188 D7: after revoke the host gets 401 and exits (code 3) |
//! | `wdc_4_a_member_host_takes_its_owner_and_kill_only` | the agent's spawn request is refused (`remote_host_kill_only`) and an agent-origin dispatched spawn is never delivered, while the owner's resume completes and an agent's `kill` is delivered; no seed on the wire |
//! | `wdc_6_the_owner_decides_a_permission_request_once_and_nobody_else_can` | ADR-0188 D5 (#3000): the agent's request becomes a `work_permission_request` row (FORCE RLS); an agent bearer (the owner's own agent), a teammate, an `allow_always` (by kind or by an option id relabelled `allow_once`), an instruction and an unknown request are refused and the agent keeps waiting; the owner's `allow_once` becomes a `permission` control the host acks, the agent gets exactly that option, the server's `approval.decided` and an audit row are written; the same decision again is 200 with one control, a different one 409; a lapsed request is 409 and `expired`; ending the session cancels what is pending and answers the agent `cancelled` |
//! | `wdc_7_r2_signed_resume_then_queue_and_interrupt_end_to_end` | #3027, R2 on at both ends (server flag, host `require_human_signatures` with the root pinned): the owner's resume signed over its successor session runs on the real binary; a signed `queue` sent through `POST …/instructions` waits behind the hung first turn, a signed `interrupt` cancels it (ACP `session/cancel`) and runs next, then the queued one; both instructions are session-thread messages keyed by their nonce |
//! | `wdc_8_r2_the_product_path_latches_the_host_and_the_server_cannot_undo_it` | #3117 (E10 검수 B1): the config the desktop app writes (no `require_human_signatures`), `run` with the control socket. The server flag on and no root: the socket reports the half state (`serverRequired` true, `required` false). `pin_root` on the socket → the next poll latches R2. A control row the server inserts unsigned, and a signed instruction whose envelope is stripped in the DB, are refused (`device_signature_required`) and reach no agent; a signed resume runs. The server restarted with the flag off: an unsigned input is still refused, and after a host restart the server's own unsigned resume is refused too. Only `reset_signature_requirement` on the socket lowers it: the next unsigned resume runs |
//! | `wdc_5_a_workspace_host_is_not_served` | a workspace-scoped host registered through the API by the workspace owner: `momo-workd run` refuses it (exit 2) and sends nothing |

use std::net::SocketAddr;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use base64::Engine as _;

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
/// #2630 F1: synthetic credentials planted in `momo-workd run`'s environment.
const PLANTED_ENV: [(&str, &str); 2] = [
    ("ZZ_TEST_TOKEN", "zz-fake-token-2630"),
    ("ZZ_TEST_API_KEY", "zz-fake-api-key-2630"),
];

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

/// Every request the in-process server received, as the wire carried it: the
/// method, the path with its query, every header, and the body bytes (#2602
/// M-5).
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<Recorded>>>);

struct Recorded {
    method: String,
    path: String,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}

async fn record(State(recorder): State<Recorder>, request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("buffer the request body");
    recorder.0.lock().unwrap().push(Recorded {
        method: parts.method.to_string(),
        path: parts.uri.to_string(),
        headers: parts
            .headers
            .iter()
            .map(|(name, value)| (name.as_str().to_string(), value.as_bytes().to_vec()))
            .collect(),
        body: body.to_vec(),
    });
    next.run(Request::from_parts(parts, Body::from(body))).await
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

impl Recorder {
    /// No request carried the host key's seed — raw, base64 (standard or
    /// URL-safe, padded or not) or hex (either case) — in its path, in any
    /// header, or in its body. The recorder must also have seen the
    /// registration and the host's signed traffic, so an empty log cannot pass.
    /// A failure names the request, the place and the encoding, never a value.
    fn assert_seed_never_sent(&self, key_file: &Path, public_key: &str) {
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        let seed = STANDARD
            .decode(
                std::fs::read_to_string(key_file)
                    .expect("dev key file")
                    .trim(),
            )
            .expect("the dev key file holds base64");
        assert_eq!(seed.len(), 32, "an Ed25519 seed");
        let hex: String = seed.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut needles: Vec<(String, Vec<u8>)> = vec![
            ("raw bytes".to_string(), seed.clone()),
            ("hex".to_string(), hex.clone().into_bytes()),
            (
                "upper-case hex".to_string(),
                hex.to_uppercase().into_bytes(),
            ),
        ];
        // #2607 N-8: base64 at every alignment. Wrapped in something else — a
        // PKCS#8 DER prefix of 16 bytes, say — the seed starts 0, 1 or 2 bytes
        // into a 3-byte group, and each start encodes it differently. The 40
        // characters that depend on seed bytes alone are the needle: after the
        // first group (which mixes in what comes before) and before the last
        // (which may mix in what comes after).
        for (alphabet, standard) in [("base64", true), ("URL-safe base64", false)] {
            for shift in 0..3usize {
                let mut shifted = vec![0u8; shift];
                shifted.extend_from_slice(&seed);
                let encoded = if standard {
                    STANDARD.encode(&shifted)
                } else {
                    URL_SAFE_NO_PAD.encode(&shifted)
                };
                let start = if shift == 0 { 0 } else { 4 };
                needles.push((
                    format!("{alphabet}, seed {shift} byte(s) into a group"),
                    encoded.as_bytes()[start..start + 40].to_vec(),
                ));
            }
        }
        let requests = self.0.lock().unwrap();
        let signed = requests
            .iter()
            .filter(|request| {
                request
                    .headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("x-momo-work-host-signature"))
            })
            .count();
        let registered = requests.iter().any(|request| {
            request.method == "POST"
                && request.path.ends_with("/work-hosts")
                && contains(&request.body, public_key.as_bytes())
        });
        eprintln!(
            "recorder: {} requests on the wire, {signed} host-signed",
            requests.len()
        );
        assert!(
            registered,
            "the recorder saw the registration carry the public key"
        );
        assert!(signed > 0, "the recorder saw the host's signed requests");
        for (index, request) in requests.iter().enumerate() {
            let mut places: Vec<(String, &[u8])> = vec![
                ("the path".to_string(), request.path.as_bytes()),
                ("the body".to_string(), &request.body),
            ];
            for (name, value) in &request.headers {
                places.push((format!("header {name}"), value));
            }
            for (encoding, needle) in &needles {
                for (place, bytes) in &places {
                    assert!(
                        !contains(bytes, needle),
                        "request #{index} ({}) carried the host key seed ({encoding}) in {place}",
                        request.method
                    );
                }
            }
        }
    }
}

struct Server {
    base: String,
    recorder: Recorder,
    address: SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Server {
    /// Stop serving and close every connection (a keep-alive one too, so a
    /// host's next request reaches whatever is bound here next).
    async fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            tokio::time::timeout(Duration::from_secs(15), task)
                .await
                .expect("the server drains its connections")
                .expect("the server task");
        }
    }
}

async fn start_server(pool: PgPool) -> Server {
    start_server_with(pool, momo_server::config::DeviceKeySettings::default()).await
}

async fn start_server_with(
    pool: PgPool,
    device_keys: momo_server::config::DeviceKeySettings,
) -> Server {
    start_server_at(pool, device_keys, "127.0.0.1:0".parse().unwrap()).await
}

/// The same router bound at `address` — a restart of the server a host
/// already knows (#3117: the operator switches a flag back).
async fn start_server_at(
    pool: PgPool,
    device_keys: momo_server::config::DeviceKeySettings,
    address: SocketAddr,
) -> Server {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_device_keys(device_keys);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let recorder = Recorder::default();
    let app = build_app(state).layer(axum::middleware::from_fn_with_state(
        recorder.clone(),
        record,
    ));
    let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .await;
    });
    Server {
        base: format!("http://{address}"),
        recorder,
        address,
        shutdown: Some(shutdown),
        task: Some(task),
    }
}

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_email: String,
    channel: Uuid,
    agent: Uuid,
    /// A running run of `agent` in `channel` — what an agent-bearer control
    /// request binds to.
    run: Uuid,
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
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'running'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(json!({"type": "work", "title": "wdc", "brief": "wdc"}))
    .bind(format!("wdc2571:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    Fixture {
        workspace,
        owner,
        owner_email,
        channel,
        agent,
        run,
    }
}

/// An `agent_bearer` for `fixture.agent` with `work:control`.
async fn agent_bearer(su: &PgPool, fixture: &Fixture) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", fixture.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control'], 'wdc-2571')",
    )
    .bind(fixture.workspace)
    .bind(fixture.agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
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
        // The owner's own folder whatever the umask (`config::check_parent_folder`).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
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
        // The owner's own file whatever the umask (`config::read_owned_file`).
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            key: dir.join("keys").join("host.key"),
            log: dir.join("workd.log"),
            config,
            dir,
            child: None,
        }
    }

    /// Add a Codex allowlist entry (the stub, speaking as codex-acp).
    fn add_codex_tool(&self, key: &str, extra: &[&str]) {
        let mut config: Value =
            serde_json::from_slice(&std::fs::read(&self.config).unwrap()).unwrap();
        let mut args = vec![
            "--record".to_string(),
            self.dir.join(format!("{key}.jsonl")).display().to_string(),
        ];
        args.extend(extra.iter().map(|arg| arg.to_string()));
        config["tools"][key] = json!({"adapter": "codex", "executable": STUB, "args": args});
        std::fs::write(&self.config, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    }

    /// Codex's host-only home, beside the registration state (ADR-0188 §8).
    fn codex_home(&self) -> PathBuf {
        self.dir.join("state").join("codex-home")
    }

    /// The owner signed Codex in to the host's own home once
    /// (`CODEX_HOME=… codex login`); only the file's presence matters here.
    fn sign_in_codex(&self) {
        use std::os::unix::fs::DirBuilderExt as _;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(self.codex_home())
            .unwrap();
        let auth = self.codex_home().join("auth.json");
        std::fs::write(&auth, "{\"auth_mode\":\"test\"}").unwrap();
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
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

    /// `momo-workd register --token-stdin`, the way the desktop app hands the
    /// owner's token over (#2778): one stdin line, not the environment.
    async fn register(&self, token: &str) -> Value {
        use tokio::io::AsyncWriteExt as _;
        let mut child = tokio::process::Command::new(WORKD)
            .args(["register", "--token-stdin", "--config"])
            .arg(&self.config)
            .arg("--dev-key-file")
            .arg(&self.key)
            .env_remove("MOMO_WORKD_REGISTER_TOKEN")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("run momo-workd register");
        let mut stdin = child.stdin.take().expect("stdin");
        stdin
            .write_all(format!("{token}\n").as_bytes())
            .await
            .unwrap();
        drop(stdin);
        let output = child.wait_with_output().await.expect("momo-workd register");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "register failed: {stderr}");
        assert!(
            !stderr.contains(token),
            "the owner's token never reaches a log line"
        );
        serde_json::from_slice(&output.stdout).expect("register prints one JSON line")
    }

    /// A workspace-scoped host, registered by the **workspace owner** through
    /// the server API (#2582: owner/admin only), with this installation handed
    /// its key and state as `register` would have left them. The product CLI
    /// never registers one, and `run` refuses to serve one (`wdc_5`).
    async fn register_as_workspace_host(
        &self,
        http: &reqwest::Client,
        base: &str,
        token: &str,
        fixture: &Fixture,
    ) -> Uuid {
        let key = momo_workd::keystore::HostKey::generate().expect("host key");
        momo_workd::keystore::KeyStore::dev_file(self.key.clone())
            .store(&key, false)
            .expect("dev key file");
        let response = http
            .post(format!(
                "{base}/v1/workspaces/{}/work-hosts",
                fixture.workspace
            ))
            .bearer_auth(token)
            .json(&json!({
                "scope": "workspace",
                "type": "workd",
                "displayName": "wdc-2571 team host",
                "publicKey": key.public_key_b64(),
                "capabilities": {"acp": true, "terminal_attach": false},
            }))
            .send()
            .await
            .expect("register workspace host");
        assert_eq!(
            response.status(),
            201,
            "the workspace owner may register a team host"
        );
        let body: Value = response.json().await.expect("host body");
        assert_eq!(body["workHost"]["scope"], "workspace");
        let host = Uuid::parse_str(body["workHost"]["id"].as_str().expect("id")).unwrap();
        momo_workd::config::HostState {
            server_url: base.to_string(),
            workspace_id: fixture.workspace,
            host_id: host,
            owner_member_id: fixture.owner,
            public_key: key.public_key_b64(),
            scope: "workspace".to_string(),
        }
        .save(&self.dir.join("state").join("host.json"))
        .expect("host state");
        host
    }

    fn start(&mut self) -> u32 {
        self.start_with(&[])
    }

    /// `run` as the desktop app starts it (#2778): with the control socket.
    /// The test binary is unsigned, so the socket takes it as a peer only
    /// with `--dev-unsigned-peer` (fences 1–2 still hold).
    fn start_with_socket(&mut self, socket: &Path) -> u32 {
        self.start_with(&[
            std::ffi::OsStr::new("--control-socket"),
            socket.as_os_str(),
            std::ffi::OsStr::new("--dev-unsigned-peer"),
        ])
    }

    fn start_with(&mut self, extra: &[&std::ffi::OsStr]) -> u32 {
        // Appended, so a restart keeps the earlier log lines.
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .unwrap();
        let child = tokio::process::Command::new(WORKD)
            .args(["run", "--config"])
            .arg(&self.config)
            .arg("--dev-key-file")
            .arg(&self.key)
            .args(extra)
            .env("MOMO_WORKD_LOG", "momo_workd=debug,info")
            // #2630 F1: fake credentials in the host's own environment; no
            // agent and no command an agent runs may see them.
            .envs(PLANTED_ENV)
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

/// A second member host of the owner, registered straight through the API —
/// the "old laptop" a session is resumed away from. Never served.
async fn register_idle_member_host(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
) -> Uuid {
    let key = momo_workd::keystore::HostKey::generate().expect("host key");
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-hosts",
            fixture.workspace
        ))
        .bearer_auth(token)
        .json(&json!({
            "scope": "member",
            "type": "workd",
            "displayName": "wdc-2571 old laptop",
            "publicKey": key.public_key_b64(),
        }))
        .send()
        .await
        .expect("register old laptop");
    assert_eq!(response.status(), 201);
    let body: Value = response.json().await.expect("host body");
    Uuid::parse_str(body["workHost"]["id"].as_str().expect("id")).unwrap()
}

/// The offline sweep's own transition (`momo_t3::sweep`), written directly:
/// the old laptop went away and its session is waiting to be resumed.
async fn orphan_session(su: &PgPool, session: Uuid) {
    let moved = sqlx::query(
        "UPDATE work_session SET status = 'orphaned', idle_at = NULL, host_lost_at = NULL \
          WHERE id = $1 AND status IN ('running', 'idle')",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("orphan the source session")
    .rows_affected();
    assert_eq!(moved, 1, "the source session was running");
}

/// The host reported `fixture.agent` on the session's thread: the record a
/// signed resume's agent is checked against (#3154).
async fn report_session_agent(su: &PgPool, fixture: &Fixture, session: Uuid) {
    sqlx::query(
        "WITH ws AS (SELECT channel_id, root_message_id FROM work_session WHERE id = $1), \
              bumped AS ( \
                UPDATE channel_seq SET last_seq = last_seq + 1 \
                 WHERE workspace_id = $2 AND channel_id = (SELECT channel_id FROM ws) \
                RETURNING last_seq AS seq) \
         INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            props, root_id) \
         SELECT $2, ws.channel_id, b.seq, 1, 0, $3, 'system', 'agent status', \
                jsonb_build_object('kind', 'work_session_event', \
                                   'event', jsonb_build_object('agent_member_id', $4::text)), \
                ws.root_message_id \
           FROM bumped b, ws",
    )
    .bind(session)
    .bind(fixture.workspace)
    .bind(fixture.owner)
    .bind(fixture.agent.to_string())
    .execute(su)
    .await
    .expect("report the session's agent");
}

/// The owner's own spawn onto `host` (see the module docs): a session the owner
/// opens on an idle second laptop, orphaned the way the sweep would, then
/// resumed onto `host` with the owner's human bearer. Returns the resume
/// response as the server gave it.
#[allow(clippy::too_many_arguments)]
async fn owner_resume(
    su: &PgPool,
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
    host: Uuid,
    tool: &str,
    label: &str,
) -> reqwest::Response {
    let workspace = fixture.workspace;
    let old_laptop = register_idle_member_host(http, base, token, fixture).await;
    let created = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(token)
        .json(&json!({
            "channelId": fixture.channel,
            "hostId": old_laptop,
            "tool": tool,
            "label": label,
        }))
        .send()
        .await
        .expect("create the source session");
    let created_status = created.status();
    let created: Value = created.json().await.expect("source body");
    assert_eq!(
        created_status, 201,
        "the owner opens a session on the old laptop: {created}"
    );
    let source = Uuid::parse_str(created["workSession"]["id"].as_str().expect("id")).unwrap();
    orphan_session(su, source).await;
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/work-sessions/{source}/resume"
    ))
    .bearer_auth(token)
    .json(&json!({"targetHostId": host}))
    .send()
    .await
    .expect("resume")
}

/// A resume the server accepted: the new session on `host` and its spawn
/// control, which is the owner's own.
async fn accepted_resume(
    su: &PgPool,
    fixture: &Fixture,
    host: Uuid,
    response: reqwest::Response,
) -> (Uuid, Uuid) {
    assert_eq!(
        response.status(),
        201,
        "the owner may resume onto their own host"
    );
    let body: Value = response.json().await.expect("resumed body");
    assert_eq!(body["workSession"]["hostId"], json!(host.to_string()));
    let session = Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).unwrap();
    let (control, requester): (Uuid, Uuid) = sqlx::query_as(
        "SELECT id, requester_member_id FROM work_control WHERE session_id = $1 AND kind = 'spawn'",
    )
    .bind(session)
    .fetch_one(su)
    .await
    .expect("the resume's spawn control");
    assert_eq!(
        requester, fixture.owner,
        "the resume is the owner's own control"
    );
    (session, control)
}

/// The session's `work_session_event` rows, as the thread shows them.
async fn session_events(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
    su: &PgPool,
    session: Uuid,
) -> Vec<Value> {
    let root: Uuid = sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .unwrap();
    let replies: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages/{root}/replies",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("read the session thread")
        .json()
        .await
        .expect("replies body");
    replies["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|row| {
            row["props"]["kind"] == "work_session_event"
                && row["props"]["event"]["work_session_id"] == json!(session.to_string())
        })
        .cloned()
        .collect()
}

/// ADR-0188 D5 (#3000): the session's pending permission request, once the
/// host has relayed it — its `approval.requested` event id.
async fn wait_for_pending_permission(su: &PgPool, session: Uuid, workd: &Workd) -> Uuid {
    wait_until("a pending permission request", workd, || async {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT request_event_id FROM work_permission_request \
              WHERE work_session_id = $1 AND status = 'pending' \
              ORDER BY created_at DESC LIMIT 1",
        )
        .bind(session)
        .fetch_optional(su)
        .await
        .expect("read permission requests")
    })
    .await
}

async fn permission_status(su: &PgPool, session: Uuid, request: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT status FROM work_permission_request \
          WHERE work_session_id = $1 AND request_event_id = $2",
    )
    .bind(session)
    .bind(request)
    .fetch_one(su)
    .await
    .expect("read permission request")
}

/// `POST …/work-sessions/{session}/permission-decisions` → (status, body).
async fn decide(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
    session: Uuid,
    body: Value,
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-sessions/{session}/permission-decisions",
            fixture.workspace
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("permission decision");
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// A teammate: an active human in the workspace and in the session's channel,
/// signed in. Returns their bearer.
async fn teammate_token(
    su: &PgPool,
    http: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
) -> String {
    let teammate = Uuid::new_v4();
    let email = format!("{teammate}@wdc3000.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(teammate)
    .bind(fixture.workspace)
    .bind(teammate.to_string())
    .execute(su)
    .await
    .expect("seed teammate");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(teammate)
    .bind(fixture.workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed teammate auth");
    // An admin, even: a role is not a substitute for being the owner.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'admin')",
    )
    .bind(fixture.workspace)
    .bind(teammate)
    .execute(su)
    .await
    .expect("seed teammate membership");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(teammate)
    .execute(su)
    .await
    .expect("seed teammate channel membership");
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("teammate login")
        .json()
        .await
        .expect("teammate login body");
    body["accessToken"]
        .as_str()
        .expect("teammate accessToken")
        .to_string()
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
async fn wdc_1_owner_resume_round_trip_and_no_seed_on_the_wire() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;

    // ---- register: a member host, the owner's -----------------------------
    let mut workd = Workd::new(base, &fixture, &[("claude", &["--permission"])]);
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();
    let row = host_row(&http, base, &token, &fixture, host).await;
    assert_eq!(
        row["scope"], "member",
        "ADR-0188 D3: a desktop host is its owner's"
    );
    let public_key = row["publicKey"].as_str().expect("publicKey").to_string();
    eprintln!("wdc_1: member host {host} registered by its owner");

    // ---- run: no listening socket of any kind ------------------------------
    let pid = workd.start();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        listening_tcp_sockets(pid),
        "",
        "ADR-0188 D2: momo-workd opens no TCP port"
    );

    // ---- the owner's resume → session → curated events → idle -------------
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "claude",
        "summarise the repo",
    )
    .await;
    let (session, spawn) = accepted_resume(&su, &fixture, host, resumed).await;
    wait_until("the resume spawn ack", &workd, || async {
        (control_state(&su, spawn).await == ("acked".to_string(), Some(session))).then_some(())
    })
    .await;
    eprintln!("wdc_1: the owner's resume {spawn} acked with session {session}");
    // ADR-0188 D5 (#3000): the agent's permission request waits for its
    // owner; the owner refuses it through the decision route.
    let request = wait_for_pending_permission(&su, session, &workd).await;
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "reject-once", "kind": "reject_once"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["permissionRequest"]["status"], "rejected");
    wait_until("the first turn to go idle", &workd, || async {
        (session_status(&su, session).await == "idle").then_some(())
    })
    .await;

    let events = session_events(&http, base, &token, &fixture, &su, session).await;
    let of_type = |kind: &str| -> Vec<&Value> {
        events
            .iter()
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
    assert_eq!(decided.len(), 1, "one decision on the ledger");
    assert_eq!(decided[0]["props"]["event"]["status"], "rejected");
    assert_eq!(
        decided[0]["props"]["event"]["request_event_id"],
        json!(request.to_string())
    );
    let requested = of_type("approval.requested");
    assert_eq!(requested.len(), 1, "one request on the ledger");
    assert_eq!(
        requested[0]["props"]["event"]["options"],
        json!([
            {"option_id": "allow-once", "kind": "allow_once", "name": "Allow once"},
            {"option_id": "reject-once", "kind": "reject_once", "name": "Reject"}
        ]),
        "only the one-time options, and no text the agent wrote"
    );
    assert!(
        !of_type("agent.status")
            .iter()
            .any(|row| row["body"] == PERMISSION_DENIED_DETAIL),
        "the host did not deny on its own"
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
        "the agent was answered with the owner's one-time rejection"
    );
    eprintln!(
        "wdc_1: {} session events on the ledger, the owner's rejection present",
        events.len()
    );
    // #2630 F1, through the real `run`: the host's environment reached
    // neither the agent nor a command it ran.
    let start = &workd.record("claude")[0];
    for list in ["env_keys", "command_env_keys"] {
        let names: Vec<&str> = start[list]
            .as_array()
            .unwrap_or_else(|| panic!("{list} recorded: {start}"))
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for (planted, _) in PLANTED_ENV {
            assert!(
                !names.contains(&planted),
                "{planted} reached the agent ({list}): {names:?}"
            );
        }
        assert!(
            !names.iter().any(|name| name.starts_with("MOMO_")),
            "{names:?}"
        );
    }
    eprintln!("wdc_1: the planted host credentials reached neither the agent nor its command");

    // ---- the owner's kill → acked → ended -------------------------------------
    let kill = insert_control(
        &su,
        &fixture,
        host,
        fixture.owner,
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
    // Only the ADR-0188 D7 v2 heartbeat is accepted; a v1 body would leave the
    // host offline.
    let row = host_row(&http, base, &token, &fixture, host).await;
    assert_eq!(
        row["online"],
        true,
        "the v2-signed heartbeat must mark the host online\n--- workd log ---\n{}",
        workd.log_tail()
    );
    assert!(row["lastSeenAtMs"].as_i64().is_some());
    eprintln!("wdc_1: host online via v2 heartbeat");

    assert_eq!(workd.stop().await, Some(0), "SIGTERM is a clean stop");

    // ---- #2602 M-5: what crossed the wire, register to the last ack -------
    server
        .recorder
        .assert_seed_never_sent(&workd.key, &public_key);
    eprintln!("wdc_1: no request carried the host key seed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_2_mode_correction_codex_and_refusals_on_a_member_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;

    // The workspace catalog carries three more tools: Codex, a `shell`, and —
    // under the one other key the session ledger accepts (`work_session_tool_ck`)
    // — a Claude that will not take the correction. The host allowlist, not
    // the key, decides what runs.
    for (tool, command) in [
        ("opencode", "claude-agent-acp"),
        ("codex", "codex-acp"),
        ("shell", "zsh"),
    ] {
        sqlx::query(
            "INSERT INTO work_tool_profile \
               (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
             VALUES ($1, $2, $2, $3, true, $4, $4) \
             ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
        )
        .bind(fixture.workspace)
        .bind(tool)
        .bind(json!({"command": command, "arguments": []}))
        .bind(fixture.owner)
        .execute(&su)
        .await
        .expect("seed a work tool profile");
    }
    // The owner's Claude opens in `auto` (its own settings say so); one
    // refuses the correction.
    let mut workd = Workd::new(
        base,
        &fixture,
        &[
            ("claude", &["--mode", "auto"]),
            ("opencode", &["--mode", "auto", "--set-mode-error"]),
            ("shell", &[]),
        ],
    );
    workd.add_codex_tool("codex", &["--codex-modes", "--mode", "read-only"]);
    let host = Uuid::parse_str(workd.register(&token).await["hostId"].as_str().unwrap()).unwrap();
    workd.sign_in_codex();
    workd.start();

    // ---- auto mode, corrected before the first prompt ----------------------
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "claude",
        "fix the bug",
    )
    .await;
    let (session, spawn) = accepted_resume(&su, &fixture, host, resumed).await;
    wait_until("the corrected resume to go idle", &workd, || async {
        (session_status(&su, session).await == "idle").then_some(())
    })
    .await;
    assert_eq!(
        control_state(&su, spawn).await,
        ("acked".to_string(), Some(session))
    );
    let log = workd.record("claude");
    let methods: Vec<&str> = log
        .iter()
        .filter_map(|entry| entry["received"]["method"].as_str())
        .collect();
    let set_mode = methods
        .iter()
        .position(|m| *m == "session/set_mode")
        .expect("corrected");
    let prompt = methods
        .iter()
        .position(|m| *m == "session/prompt")
        .expect("prompted");
    assert!(
        set_mode < prompt,
        "corrected before the first prompt: {methods:?}"
    );
    assert!(log.iter().any(|entry| entry["prompt_mode"] == "default"));
    eprintln!("wdc_2: resume {spawn} opened in auto, corrected to default before its first prompt");

    // ---- a correction the agent refuses: refused, allocated session ended --
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "opencode",
        "fix the bug",
    )
    .await;
    let (stuck, stuck_spawn) = accepted_resume(&su, &fixture, host, resumed).await;
    wait_until("the refused spawn", &workd, || async {
        (control_state(&su, stuck_spawn).await.0 == "failed").then_some(())
    })
    .await;
    assert_eq!(
        ack_error_label(&su, &fixture, stuck_spawn).await.as_deref(),
        Some("permission_mode_refused"),
        "the refusal reaches the room with its reason"
    );
    wait_until("the host to end the allocated session", &workd, || async {
        (session_status(&su, stuck).await == "ended").then_some(())
    })
    .await;
    assert!(
        !workd
            .record("opencode")
            .iter()
            .any(|entry| entry["received"]["method"] == "session/prompt"),
        "no prompt reached an agent that stayed in auto"
    );
    eprintln!("wdc_2: resume {stuck_spawn} refused the correction → permission_mode_refused, session {stuck} ended by the host");

    // ---- Codex, from the host's own home (ADR-0188 §8) ---------------------
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "codex",
        "summarise the repo",
    )
    .await;
    let (codex_session, codex_spawn) = accepted_resume(&su, &fixture, host, resumed).await;
    wait_until("the Codex resume to go idle", &workd, || async {
        (session_status(&su, codex_session).await == "idle").then_some(())
    })
    .await;
    let start = &workd.record("codex")[0];
    assert_eq!(
        start["env_isolation"]["CODEX_HOME"]
            .as_str()
            .map(PathBuf::from),
        Some(workd.codex_home()),
        "Codex runs from the host's own home"
    );
    // #2630 F5: and with the host's own empty folder as its HOME, so the
    // owner's `~/.agents/skills` is not its user skill layer.
    assert_eq!(
        start["env_isolation"]["HOME"].as_str().map(PathBuf::from),
        Some(workd.dir.join("state").join("codex-user-home")),
        "Codex's HOME is the host's own folder"
    );
    let config =
        std::fs::read_to_string(workd.codex_home().join("config.toml")).expect("host config");
    assert!(
        config.contains("[shell_environment_policy]\ninherit = \"core\"\n")
            && config.contains("shell_snapshot = false\n"),
        "the host's config confines what Codex's commands see (#2630 F1): {config}"
    );
    eprintln!("wdc_2: Codex resume {codex_spawn} ran from the host's own CODEX_HOME and HOME");

    // ---- shell: refused at the resume, never delivered ----------------------
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "shell",
        "open a shell",
    )
    .await;
    let status = resumed.status().as_u16();
    let body: Value = resumed.json().await.expect("refusal body");
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (403, Some("remote_host_shell_refused")),
        "a shell never goes to a member host, not even the owner's: {body}"
    );
    let shell_controls: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_control WHERE target_host_id = $1 AND payload->>'tool' = 'shell'",
    )
    .bind(host)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        shell_controls, 0,
        "no shell control was written for this host"
    );
    assert!(
        workd.record("shell").is_empty(),
        "the shell entry was never launched"
    );
    eprintln!("wdc_2: shell resume refused 403 remote_host_shell_refused");
    assert_eq!(workd.stop().await, Some(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_3_a_revoked_host_stops() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;

    let mut workd = Workd::new(base, &fixture, &[("claude", &[])]);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_4_a_member_host_takes_its_owner_and_kill_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;
    let agent_token = agent_bearer(&su, &fixture).await;
    let workspace = fixture.workspace;

    // ---- register: the owner's token, the key's public half only ----------
    let mut workd = Workd::new(base, &fixture, &[("claude", &[])]);
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();
    assert_eq!(
        registered["ownerMemberId"],
        json!(fixture.owner.to_string())
    );
    let key_mode = std::fs::metadata(&workd.key).unwrap().mode() & 0o777;
    assert_eq!(key_mode, 0o600, "the dev key file is private");
    let row = host_row(&http, base, &token, &fixture, host).await;
    assert_eq!(
        row["scope"], "member",
        "ADR-0188 D3: a desktop host is its owner's"
    );
    assert_eq!(row["type"], "workd");
    assert_eq!(row["ownerMemberId"], json!(fixture.owner.to_string()));
    let public_key = row["publicKey"].as_str().expect("publicKey").to_string();
    eprintln!("wdc_4: registered member host {host}");
    workd.start();

    // ---- refused: an agent asking to spawn on its owner's machine ----------
    let asked = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-controls"))
        .bearer_auth(&agent_token)
        .json(&json!({
            "channelId": fixture.channel,
            "runId": fixture.run,
            "targetHostId": host,
            "kind": "spawn",
            "payload": {"tool": "claude", "label": "agent asks"},
        }))
        .send()
        .await
        .expect("agent spawn request");
    let status = asked.status().as_u16();
    let body: Value = asked.json().await.expect("refusal body");
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (403, Some("remote_host_kill_only")),
        "an agent's spawn request for a member host is refused: {body}"
    );
    eprintln!("wdc_4: agent spawn request refused 403 remote_host_kill_only");

    // ---- an agent-origin spawn already on the ledger ------------------------
    // Shaped like a row dispatched before R0 (an auto-approved agent spawn).
    // A member host must never receive it (#2582 R0.1).
    let legacy = insert_control(
        &su,
        &fixture,
        host,
        fixture.agent,
        None,
        "spawn",
        json!({"tool": "claude", "label": "legacy agent spawn"}),
    )
    .await;

    // ---- the owner resumes an orphaned session onto this host --------------
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "claude",
        "resume me",
    )
    .await;
    let (session, resume_control) = accepted_resume(&su, &fixture, host, resumed).await;
    wait_until("the resume spawn ack", &workd, || async {
        (control_state(&su, resume_control).await == ("acked".to_string(), Some(session)))
            .then_some(())
    })
    .await;
    wait_until("the resumed turn to go idle", &workd, || async {
        (session_status(&su, session).await == "idle").then_some(())
    })
    .await;
    let answer: String = session_events(&http, base, &token, &fixture, &su, session)
        .await
        .iter()
        .filter(|row| row["props"]["event_type"] == "agent.partial")
        .map(|row| {
            row["props"]["event"]["text_delta"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert_eq!(answer, "stub heard: resume me — done.");
    eprintln!(
        "wdc_4: owner resume {resume_control} delivered and acked; session {session} ran its first turn"
    );

    // ---- the agent's row never reached the host -----------------------------
    // The host polled throughout the round trip above; this row was in the same
    // queue the whole time.
    assert_eq!(
        control_state(&su, legacy).await,
        ("dispatched".to_string(), None),
        "an agent-origin spawn must never reach a member host\n--- workd log ---\n{}",
        workd.log_tail()
    );
    let prompts: Vec<String> = workd
        .record("claude")
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
        ["resume me"],
        "only the owner's instruction reached the agent"
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM work_session WHERE host_id = $1")
        .bind(host)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        sessions, 1,
        "the resumed session is the host's only session"
    );
    eprintln!("wdc_4: agent-origin spawn {legacy} still dispatched (withheld)");

    // ---- kill reaches a member host from anyone ----------------------------
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
    eprintln!("wdc_4: agent kill {kill} delivered, session ended");

    assert_eq!(workd.stop().await, Some(0), "SIGTERM is a clean stop");
    server
        .recorder
        .assert_seed_never_sent(&workd.key, &public_key);
    eprintln!("wdc_4: no request carried the host key seed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_5_a_workspace_host_is_not_served() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;

    let mut workd = Workd::new(base, &fixture, &[("claude", &[])]);
    let host = workd
        .register_as_workspace_host(&http, base, &token, &fixture)
        .await;
    let before = server.recorder.0.lock().unwrap().len();
    workd.start();
    let child = workd.child.as_mut().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap_or_else(|_| panic!("a workspace host must not be served\n{}", workd.log_tail()))
        .expect("exit status");
    workd.child = None;
    let log = std::fs::read_to_string(&workd.log).unwrap_or_default();
    assert_eq!(status.code(), Some(2), "usage exit\n{log}");
    assert!(log.contains("serves only"), "{log}");
    assert_eq!(
        server.recorder.0.lock().unwrap().len(),
        before,
        "the refused host sent nothing"
    );
    let row = host_row(&http, base, &token, &fixture, host).await;
    assert_eq!(
        row["online"], false,
        "a host that is not served never comes online"
    );
    eprintln!("wdc_5: workspace host {host} refused by run (exit 2), nothing sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn wdc_6_the_owner_decides_a_permission_request_once_and_nobody_else_can() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server(app_pool.clone()).await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;
    let teammate = teammate_token(&su, &http, base, &fixture).await;
    // The owner's own agent (`agent.owner_human_id` = the owner) — the one
    // whose request this is, in spirit.
    let agent = agent_bearer(&su, &fixture).await;

    let mut workd = Workd::new(base, &fixture, &[("claude", &["--permission"])]);
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();
    workd.start();
    let resumed = owner_resume(
        &su,
        &http,
        base,
        &token,
        &fixture,
        host,
        "claude",
        "read the secret",
    )
    .await;
    let (session, _) = accepted_resume(&su, &fixture, host, resumed).await;
    let request = wait_for_pending_permission(&su, session, &workd).await;
    eprintln!("wdc_6: session {session} waits on permission request {request}");

    // ---- the table is a tenant table (FORCE RLS) ----------------------------
    let forced: bool = sqlx::query_scalar(
        "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class \
          WHERE oid = 'public.work_permission_request'::regclass",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(forced, "work_permission_request is ENABLE + FORCE RLS");
    // As `momo_app` (NOBYPASSRLS): another workspace's scope sees nothing,
    // this workspace's sees its request.
    for (scope, expected) in [(Uuid::new_v4(), 0i64), (fixture.workspace, 1i64)] {
        let mut tx = app_pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(scope.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let seen: i64 = sqlx::query_scalar("SELECT count(*) FROM work_permission_request")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(seen, expected, "RLS scope {scope}");
    }

    let allow = json!({"requestEventId": request, "optionId": "allow-once", "kind": "allow_once"});
    let refused = |status: u16, body: &Value, code: &str| {
        assert_eq!(body["error"]["code"], code, "{status} {body}");
    };

    // ---- refusals: the agent keeps waiting through all of them -------------
    // An agent bearer — the owner's own agent — cannot approve its request.
    let (status, body) = decide(&http, base, &agent, &fixture, session, allow.clone()).await;
    assert_eq!(status, 403, "an agent never decides: {body}");
    // A teammate — an admin, in the channel — is not the owner.
    let (status, body) = decide(&http, base, &teammate, &fixture, session, allow.clone()).await;
    assert_eq!(status, 403, "{body}");
    refused(status, &body, "permission_owner_only");
    // 「항상 허용」, by kind…
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "allow-once", "kind": "allow_always"}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    refused(status, &body, "permission_kind_refused");
    // …or by the agent's own always option relabelled as a once kind.
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "allow-always", "kind": "allow_once"}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    refused(status, &body, "permission_option_invalid");
    // An offered option under the other kind.
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "reject-once", "kind": "allow_once"}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    refused(status, &body, "permission_option_invalid");
    // 「거부하고 지시」's instruction is R2.
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "reject-once", "kind": "reject_once",
               "instruction": "use the public key instead"}),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    refused(status, &body, "permission_instruction_unsupported");
    // A request this session never made.
    let (status, _) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": Uuid::new_v4(), "optionId": "allow-once", "kind": "allow_once"}),
    )
    .await;
    assert_eq!(status, 404);
    // The host's own key cannot fake an owner's approval of the request
    // (review M-2): a host-relayed `approval.decided` naming a request must
    // say `rejected` (a withdrawal).
    {
        use momo_workd::client::HostApi as _;
        let key = momo_workd::keystore::KeyStore::dev_file(workd.key.clone())
            .load()
            .expect("dev key")
            .expect("key present");
        let signed = momo_workd::client::HostClient::new(
            base.to_string(),
            fixture.workspace,
            host,
            Arc::new(key),
        )
        .unwrap();
        let forged = momo_workd::client::AcpEvent {
            event_id: Uuid::new_v4(),
            event_type: "approval.decided".into(),
            v: 1,
            ts: 1,
            payload: json!({
                "run_id": session, "work_session_id": session, "channel_id": fixture.channel,
                "action": "decided", "status": "approved", "option_id": "allow-once",
                "request_event_id": request,
            }),
        };
        let refused = signed.record_event(session, &forged).await.unwrap_err();
        assert_eq!(refused.status(), Some(400), "{refused}");
    }
    assert_eq!(permission_status(&su, session, request).await, "pending");
    let controls: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_control WHERE session_id = $1 AND kind = 'permission'",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(controls, 0, "no refused decision made a control");
    assert!(
        workd
            .record("claude")
            .iter()
            .all(|entry| entry.get("permission_outcome").is_none()),
        "the agent is still waiting"
    );
    eprintln!(
        "wdc_6: agent 403, teammate 403, always 400×2, relabel 400, instruction 400, unknown 404"
    );

    // ---- the owner's allow_once ---------------------------------------------
    let (status, body) = decide(&http, base, &token, &fixture, session, allow.clone()).await;
    assert_eq!(status, 200, "{body}");
    let first = body["permissionRequest"].clone();
    assert_eq!(first["status"], "approved");
    assert_eq!(first["decidedKind"], "allow_once");
    assert_eq!(first["decidedBy"], json!(fixture.owner.to_string()));
    let control = Uuid::parse_str(first["controlId"].as_str().expect("controlId")).unwrap();
    wait_until("the permission control ack", &workd, || async {
        (control_state(&su, control).await.0 == "acked").then_some(())
    })
    .await;
    wait_until("the turn to go idle", &workd, || async {
        (session_status(&su, session).await == "idle").then_some(())
    })
    .await;
    let outcomes: Vec<Value> = workd
        .record("claude")
        .into_iter()
        .filter_map(|entry| entry.get("permission_outcome").cloned())
        .collect();
    assert_eq!(
        outcomes,
        vec![json!({"outcome": "selected", "optionId": "allow-once"})],
        "the agent got exactly the owner's choice"
    );
    let (kind, requester, payload): (String, Uuid, Value) =
        sqlx::query_as("SELECT kind, requester_member_id, payload FROM work_control WHERE id = $1")
            .bind(control)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(kind, "permission");
    assert_eq!(requester, fixture.owner);
    assert_eq!(
        payload,
        json!({"request_event_id": request.to_string(), "option_id": "allow-once", "kind": "allow_once"})
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.permission.decided' \
            AND actor_member_id = $2",
    )
    .bind(fixture.workspace)
    .bind(fixture.owner)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audited, 1, "the decision is in the audit log");
    let events = session_events(&http, base, &token, &fixture, &su, session).await;
    let decided: Vec<&Value> = events
        .iter()
        .filter(|row| row["props"]["event_type"] == "approval.decided")
        .collect();
    assert_eq!(decided.len(), 1);
    assert_eq!(decided[0]["props"]["event"]["status"], "approved");
    assert_eq!(
        decided[0]["props"]["event"]["request_event_id"],
        json!(request.to_string())
    );
    eprintln!("wdc_6: owner allow_once → control {control} acked, agent got allow-once, audited");

    // ---- once ------------------------------------------------------------------
    let (status, body) = decide(&http, base, &token, &fixture, session, allow.clone()).await;
    assert_eq!(status, 200, "the same decision again is the same answer");
    assert_eq!(body["permissionRequest"], first);
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": request, "optionId": "reject-once", "kind": "reject_once"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    refused(status, &body, "permission_already_decided");
    let controls: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_control WHERE session_id = $1 AND kind = 'permission'",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(controls, 1, "one decision, one control");

    // ---- a lapsed request -------------------------------------------------------
    // The owner's next instruction starts a turn with a new request.
    insert_control(
        &su,
        &fixture,
        host,
        fixture.owner,
        Some(session),
        "input",
        json!({"text": "and the other one"}),
    )
    .await;
    let second = wait_for_pending_permission(&su, session, &workd).await;
    assert_ne!(second, request);
    sqlx::query(
        "UPDATE work_permission_request SET expires_at = now() - interval '1 second' \
          WHERE work_session_id = $1 AND request_event_id = $2",
    )
    .bind(session)
    .bind(second)
    .execute(&su)
    .await
    .unwrap();
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": second, "optionId": "allow-once", "kind": "allow_once"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    refused(status, &body, "permission_request_closed");
    assert_eq!(permission_status(&su, session, second).await, "expired");

    // ---- the session ends: pending requests are cancelled -------------------
    let stray = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_permission_request \
           (workspace_id, work_session_id, host_id, channel_id, request_event_id, options, expires_at) \
         VALUES ($1, $2, $3, $4, $5, '[{\"option_id\":\"a\",\"kind\":\"allow_once\"}]', \
                 now() + interval '10 minutes')",
    )
    .bind(fixture.workspace)
    .bind(session)
    .bind(host)
    .bind(fixture.channel)
    .bind(stray)
    .execute(&su)
    .await
    .unwrap();
    let kill = insert_control(
        &su,
        &fixture,
        host,
        fixture.owner,
        Some(session),
        "kill",
        json!({}),
    )
    .await;
    wait_until("the session to end", &workd, || async {
        (control_state(&su, kill).await.0 == "acked"
            && session_status(&su, session).await == "ended")
            .then_some(())
    })
    .await;
    assert_eq!(
        permission_status(&su, session, stray).await,
        "cancelled",
        "ADR-0188 D5: the end cancels what is pending"
    );
    assert_eq!(
        permission_status(&su, session, second).await,
        "expired",
        "a closed request stays as it closed"
    );
    let outcomes: Vec<Value> = workd
        .record("claude")
        .into_iter()
        .filter_map(|entry| entry.get("permission_outcome").cloned())
        .collect();
    assert_eq!(
        outcomes.last(),
        Some(&json!({"outcome": "cancelled"})),
        "the waiting agent is answered `cancelled` when the session ends"
    );
    let (status, body) = decide(
        &http,
        base,
        &token,
        &fixture,
        session,
        json!({"requestEventId": stray, "optionId": "a", "kind": "allow_once"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    eprintln!("wdc_6: lapsed → 409 expired; end → pending cancelled, agent answered cancelled");

    assert_eq!(workd.stop().await, Some(0));
}

// ---------------------------------------------------------------------------
// #3027 — R2 end to end on the real binary
// ---------------------------------------------------------------------------

const INSTANCE_3027: &str = "inst_3027_wdc";

/// A software P-256 key standing in for the desktop app's Secure Enclave key.
struct RootKey {
    signing: p256::ecdsa::SigningKey,
    public_b64: String,
}

impl RootKey {
    fn new() -> RootKey {
        RootKey::from_scalar(27)
    }

    fn from_scalar(byte: u8) -> RootKey {
        let signing = p256::ecdsa::SigningKey::from_slice(&[byte; 32]).expect("scalar");
        let point = signing.verifying_key().to_sec1_point(true);
        RootKey {
            public_b64: base64::engine::general_purpose::STANDARD.encode(point.as_bytes()),
            signing,
        }
    }

    fn sign(&self, bytes: &[u8]) -> String {
        use p256::ecdsa::signature::Signer as _;
        let signature: p256::ecdsa::Signature = self.signing.sign(bytes);
        base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())
    }
}

fn now_ms_3027() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn stub_prompts(workd: &Workd, key: &str) -> Vec<String> {
    workd
        .record(key)
        .iter()
        .filter(|entry| entry["received"]["method"] == "session/prompt")
        .map(|entry| entry["received"]["params"]["prompt"][0]["text"].to_string())
        .collect()
}

fn stub_methods(workd: &Workd, key: &str) -> Vec<String> {
    workd
        .record(key)
        .iter()
        .filter_map(|entry| entry["received"]["method"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn wdc_7_r2_signed_resume_then_queue_and_interrupt_end_to_end() {
    use momo_wire::human_control::{ControlContent, HumanControl, InputMode};

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let server = start_server_with(
        app_pool,
        momo_server::config::DeviceKeySettings {
            instance_id: Some(INSTANCE_3027.to_string()),
            human_control_signature_required: true,
            ..Default::default()
        },
    )
    .await;
    let base = server.base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;
    let workspace = fixture.workspace;

    // The host, with R2 on and the desktop app's root pinned in its state
    // folder (as `pin_root` over the control socket leaves it).
    let mut workd = Workd::new(base, &fixture, &[("claude", &["--hang-first"])]);
    let mut config: Value = serde_json::from_slice(&std::fs::read(&workd.config).unwrap()).unwrap();
    config["require_human_signatures"] = json!(true);
    std::fs::write(&workd.config, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();

    let root = RootKey::new();
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/device-keys"))
        .bearer_auth(&token)
        .json(
            &json!({ "alg": "p256", "publicKey": root.public_b64, "platform": "macos",
                       "label": "맥", "currentPassword": TEST_PASSWORD }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201, "the root key registers");
    let body: Value = response.json().await.unwrap();
    let root_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    {
        let mut trust = momo_workd::human_trust::HumanTrust::open(
            &workd.dir.join("state"),
            momo_workd::human_trust::TrustIdentity {
                workspace_id: workspace,
                owner_member_id: fixture.owner,
                host_id: host,
            },
        )
        .expect("trust state");
        assert_eq!(
            trust.pin_root(root_id, "p256", &root.public_b64, now_ms_3027()),
            Ok(true)
        );
    }
    workd.start();
    wait_until("the host to heartbeat", &workd, || async {
        host_row(&http, base, &token, &fixture, host).await["lastSeenAtMs"]
            .as_i64()
            .map(|_| ())
    })
    .await;

    // ---- the owner's resume, signed over the successor session -------------
    let old_laptop = register_idle_member_host(&http, base, &token, &fixture).await;
    let created: Value = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(&token)
        .json(&json!({ "channelId": fixture.channel, "hostId": old_laptop,
                       "tool": "claude", "label": "first turn hangs" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let source = Uuid::parse_str(created["workSession"]["id"].as_str().unwrap()).unwrap();
    orphan_session(&su, source).await;
    report_session_agent(&su, &fixture, source).await;
    let successor = Uuid::new_v4();
    let issued = now_ms_3027();
    let nonce = Uuid::new_v4();
    let bytes = HumanControl {
        instance_id: INSTANCE_3027,
        workspace_id: workspace,
        member_id: fixture.owner,
        device_key_id: root_id,
        host_id: host,
        session_id: Some(successor),
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 5 * 60 * 1000,
        content: ControlContent::Spawn {
            agent_member_id: fixture.agent,
            folder_id: "repo",
            tool: "claude",
            channel_id: fixture.channel,
            first_prompt: "first turn hangs",
        },
    }
    .signed_bytes()
    .unwrap();
    let resumed = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{source}/resume"
        ))
        .bearer_auth(&token)
        .json(
            &json!({ "targetHostId": host, "sessionId": successor, "humanSignature": {
                "deviceKeyId": root_id, "nonce": nonce, "issuedAtMs": issued,
                "expiresAtMs": issued + 5 * 60 * 1000, "agentMemberId": fixture.agent,
                "folderId": "repo", "signature": root.sign(&bytes),
            }}),
        )
        .send()
        .await
        .unwrap();
    let (session, spawn) = accepted_resume(&su, &fixture, host, resumed).await;
    assert_eq!(
        session, successor,
        "the session is the one the owner signed"
    );
    wait_until("the signed resume to be acked", &workd, || async {
        (control_state(&su, spawn).await == ("acked".to_string(), Some(session))).then_some(())
    })
    .await;
    wait_until("the hung first turn", &workd, || async {
        (stub_prompts(&workd, "claude").len() == 1).then_some(())
    })
    .await;

    // ---- queue, then interrupt, through the instruction route --------------
    let instruct = |text: &str, mode: InputMode| {
        let issued = now_ms_3027();
        let nonce = Uuid::new_v4();
        let bytes = HumanControl {
            instance_id: INSTANCE_3027,
            workspace_id: workspace,
            member_id: fixture.owner,
            device_key_id: root_id,
            host_id: host,
            session_id: Some(session),
            nonce,
            issued_at_ms: issued,
            expires_at_ms: issued + 5 * 60 * 1000,
            content: ControlContent::Input { mode, text },
        }
        .signed_bytes()
        .unwrap();
        (
            nonce,
            json!({ "text": text, "mode": mode.as_str(), "clientMsgId": nonce,
            "humanSignature": {
                "deviceKeyId": root_id, "nonce": nonce, "issuedAtMs": issued,
                "expiresAtMs": issued + 5 * 60 * 1000, "mode": mode.as_str(),
                "signature": root.sign(&bytes),
            }}),
        )
    };
    let send = |body: Value| {
        let http = http.clone();
        let token = token.clone();
        async move {
            let response = http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/work-sessions/{session}/instructions"
                ))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .unwrap();
            let status = response.status().as_u16();
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };
    let (queue_nonce, body) = instruct("queued after the turn", InputMode::Queue);
    let (status, queued) = send(body).await;
    assert_eq!(status, 201, "{queued}");
    let queued_control = Uuid::parse_str(queued["workControl"]["id"].as_str().unwrap()).unwrap();
    wait_until("the queued instruction acked", &workd, || async {
        (control_state(&su, queued_control).await.0 == "acked").then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        stub_prompts(&workd, "claude").len(),
        1,
        "the queued instruction waits behind the running turn"
    );

    let (interrupt_nonce, body) = instruct("stop and do this now", InputMode::Interrupt);
    let (status, interrupted) = send(body).await;
    assert_eq!(status, 201, "{interrupted}");
    wait_until("the interrupt and the queued turn", &workd, || async {
        (stub_prompts(&workd, "claude").len() == 3).then_some(())
    })
    .await;
    let prompts = stub_prompts(&workd, "claude");
    assert_eq!(
        prompts,
        [
            json!("first turn hangs").to_string(),
            json!("stop and do this now").to_string(),
            json!("queued after the turn").to_string(),
        ],
        "interrupt goes first, then the queue"
    );
    let methods = stub_methods(&workd, "claude");
    let cancel = methods
        .iter()
        .position(|m| m == "session/cancel")
        .expect("the hung turn was cancelled");
    let second_prompt = methods
        .iter()
        .enumerate()
        .filter(|(_, m)| *m == "session/prompt")
        .nth(1)
        .map(|(i, _)| i)
        .unwrap();
    assert!(cancel < second_prompt, "{methods:?}");

    // Both instructions are thread messages keyed by their nonce.
    let root_message: Uuid =
        sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
            .bind(session)
            .fetch_one(&su)
            .await
            .unwrap();
    for (nonce, text) in [
        (queue_nonce, "queued after the turn"),
        (interrupt_nonce, "stop and do this now"),
    ] {
        let (root_id_row, body): (Option<Uuid>, Option<String>) = sqlx::query_as(
            "SELECT root_id, body FROM message WHERE channel_id = $1 AND client_msg_id = $2",
        )
        .bind(fixture.channel)
        .bind(nonce)
        .fetch_one(&su)
        .await
        .expect("the instruction's thread message");
        assert_eq!(root_id_row, Some(root_message));
        assert_eq!(body.as_deref(), Some(text));
    }
    workd.stop().await;
}

// ---------------------------------------------------------------------------
// #3117 — what switches R2 on, on the product path (E10 검수 B1)
// ---------------------------------------------------------------------------

/// A private 0700 folder under /tmp for the control socket (`sun_path` is 104
/// bytes; the Workd folder under `$TMPDIR` is too long on macOS).
struct SocketFolder(PathBuf);

impl SocketFolder {
    fn new() -> Self {
        let dir = PathBuf::from(format!(
            "/tmp/w3117-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(dir)
    }

    fn sock(&self) -> PathBuf {
        self.0.join("workd.sock")
    }
}

impl Drop for SocketFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One request on the control socket, as the desktop app sends it.
async fn ask_socket(path: &Path, request: Value) -> Value {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut stream = tokio::net::UnixStream::connect(path)
        .await
        .expect("connect the control socket");
    stream
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut out))
        .await
        .expect("the socket answers")
        .unwrap();
    serde_json::from_str(out.trim()).expect("one JSON line")
}

async fn socket_signatures(path: &Path) -> Value {
    ask_socket(path, json!({"op": "status"})).await["humanSignatures"].clone()
}

fn signal(workd: &Workd, signal: libc::c_int) {
    let pid = workd
        .child
        .as_ref()
        .and_then(|child| child.id())
        .expect("running") as libc::pid_t;
    // SAFETY: plain syscall on our own child.
    assert_eq!(unsafe { libc::kill(pid, signal) }, 0);
}

/// Every envelope column of a control set to NULL — what a server or DB
/// operator can do to a signed row (095 keeps them all set or all NULL).
async fn strip_envelope(su: &PgPool, control: Uuid) {
    let stripped = sqlx::query(
        "UPDATE work_control SET device_key_id = NULL, human_instance_id = NULL, \
           human_nonce = NULL, human_issued_at_ms = NULL, human_expires_at_ms = NULL, \
           human_mode = NULL, human_scope = NULL, human_spawn_agent_member_id = NULL, \
           human_spawn_folder_id = NULL, human_signature = NULL \
         WHERE id = $1 AND human_signature IS NOT NULL",
    )
    .bind(control)
    .execute(su)
    .await
    .expect("strip the envelope")
    .rows_affected();
    assert_eq!(stripped, 1, "the control was signed");
}

async fn wait_for_ack_label(
    su: &PgPool,
    fixture: &Fixture,
    workd: &Workd,
    control: Uuid,
) -> String {
    wait_until("the control's ack", workd, || async {
        match control_state(su, control).await.0.as_str() {
            "acked" | "failed" => Some(
                ack_error_label(su, fixture, control)
                    .await
                    .unwrap_or_default(),
            ),
            _ => None,
        }
    })
    .await
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn wdc_8_r2_the_product_path_latches_the_host_and_the_server_cannot_undo_it() {
    use momo_wire::human_control::{ControlContent, HumanControl, InputMode};

    // The control socket is macOS only (the peer is checked by code
    // signature); elsewhere `run --control-socket` refuses to start.
    if !cfg!(target_os = "macos") {
        eprintln!("wdc_8: the control socket needs macOS; skipped");
        return;
    }

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed_fixture(&su, &app_pool).await;
    let flag = |on: bool| momo_server::config::DeviceKeySettings {
        instance_id: Some(INSTANCE_3027.to_string()),
        human_control_signature_required: on,
        ..Default::default()
    };
    let mut server = start_server_with(app_pool.clone(), flag(true)).await;
    let base = server.base.clone();
    let base = base.as_str();
    let http = reqwest::Client::new();
    let token = login(&http, base, &fixture).await;
    let workspace = fixture.workspace;

    // The config exactly as the desktop app's `build_config` writes it: no
    // `require_human_signatures` (the test only adds its poll intervals).
    let mut workd = Workd::new(base, &fixture, &[("claude", &[])]);
    let written: Value = serde_json::from_slice(&std::fs::read(&workd.config).unwrap()).unwrap();
    assert!(written.get("require_human_signatures").is_none());
    let registered = workd.register(&token).await;
    let host = Uuid::parse_str(registered["hostId"].as_str().expect("hostId")).unwrap();
    let folder = SocketFolder::new();
    let socket = folder.sock();
    workd.start_with_socket(&socket);
    wait_until("the host to heartbeat", &workd, || async {
        host_row(&http, base, &token, &fixture, host).await["lastSeenAtMs"]
            .as_i64()
            .map(|_| ())
    })
    .await;

    // ---- the server requires signatures, no root here: the half state -----
    let half = wait_until("the server's word on the socket", &workd, || async {
        let status = socket_signatures(&socket).await;
        (status["serverRequired"] == true).then_some(status)
    })
    .await;
    assert_eq!(half["required"], false, "{half}");
    assert_eq!(half["requiredBy"], Value::Null, "{half}");
    assert_eq!(half["rootKeyId"], Value::Null, "{half}");
    assert!(!workd
        .dir
        .join("state")
        .join(momo_workd::signature_requirement::REQUIRED_FILE)
        .exists());
    eprintln!("wdc_8: server on, no root → {half}");

    // ---- the app pins its root on the socket: the next poll latches -------
    let root = RootKey::from_scalar(31);
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/device-keys"))
        .bearer_auth(&token)
        .json(
            &json!({ "alg": "p256", "publicKey": root.public_b64, "platform": "macos",
                       "label": "맥", "currentPassword": TEST_PASSWORD }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201, "the root key registers");
    let body: Value = response.json().await.unwrap();
    let root_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    let pinned = ask_socket(
        &socket,
        json!({"op": "pin_root", "keyId": root_id, "alg": "p256", "publicKey": root.public_b64}),
    )
    .await;
    assert_eq!(pinned, json!({"ok": true, "pinned": true}));
    let latched = wait_until("the host to latch R2", &workd, || async {
        let status = socket_signatures(&socket).await;
        (status["required"] == true).then_some(status)
    })
    .await;
    assert_eq!(latched["requiredBy"], "server", "{latched}");
    assert!(latched["latchedSinceMs"].as_i64().is_some(), "{latched}");
    eprintln!("wdc_8: root pinned → {latched}");

    // ---- a signed resume runs ----------------------------------------------
    let signed_resume = |label: &'static str| {
        let http = http.clone();
        let token = token.clone();
        let su = su.clone();
        let root = &root;
        let fixture = &fixture;
        async move {
            let old_laptop = register_idle_member_host(&http, base, &token, fixture).await;
            let created: Value = http
                .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
                .bearer_auth(&token)
                .json(&json!({ "channelId": fixture.channel, "hostId": old_laptop,
                               "tool": "claude", "label": label }))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let source = Uuid::parse_str(created["workSession"]["id"].as_str().unwrap()).unwrap();
            orphan_session(&su, source).await;
            report_session_agent(&su, fixture, source).await;
            let successor = Uuid::new_v4();
            let issued = now_ms_3027();
            let nonce = Uuid::new_v4();
            let bytes = HumanControl {
                instance_id: INSTANCE_3027,
                workspace_id: workspace,
                member_id: fixture.owner,
                device_key_id: root_id,
                host_id: host,
                session_id: Some(successor),
                nonce,
                issued_at_ms: issued,
                expires_at_ms: issued + 5 * 60 * 1000,
                content: ControlContent::Spawn {
                    agent_member_id: fixture.agent,
                    folder_id: "repo",
                    tool: "claude",
                    channel_id: fixture.channel,
                    first_prompt: label,
                },
            }
            .signed_bytes()
            .unwrap();
            let resumed = http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/work-sessions/{source}/resume"
                ))
                .bearer_auth(&token)
                .json(
                    &json!({ "targetHostId": host, "sessionId": successor, "humanSignature": {
                        "deviceKeyId": root_id, "nonce": nonce, "issuedAtMs": issued,
                        "expiresAtMs": issued + 5 * 60 * 1000, "agentMemberId": fixture.agent,
                        "folderId": "repo", "signature": root.sign(&bytes),
                    }}),
                )
                .send()
                .await
                .unwrap();
            accepted_resume(&su, fixture, host, resumed).await
        }
    };
    let (session, spawn) = signed_resume("signed first turn").await;
    wait_until("the signed resume to run", &workd, || async {
        (control_state(&su, spawn).await == ("acked".to_string(), Some(session))).then_some(())
    })
    .await;
    wait_until("the first turn", &workd, || async {
        (stub_prompts(&workd, "claude").len() == 1).then_some(())
    })
    .await;

    // ---- what the server inserts unsigned is refused ------------------------
    let unsigned = insert_control(
        &su,
        &fixture,
        host,
        fixture.owner,
        Some(session),
        "input",
        json!({"text": "inserted unsigned by the server"}),
    )
    .await;
    assert_eq!(
        wait_for_ack_label(&su, &fixture, &workd, unsigned).await,
        "device_signature_required"
    );

    // ---- a signed instruction whose envelope the DB loses is refused -------
    signal(&workd, libc::SIGSTOP);
    let issued = now_ms_3027();
    let nonce = Uuid::new_v4();
    let text = "signed, then stripped";
    let bytes = HumanControl {
        instance_id: INSTANCE_3027,
        workspace_id: workspace,
        member_id: fixture.owner,
        device_key_id: root_id,
        host_id: host,
        session_id: Some(session),
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 5 * 60 * 1000,
        content: ControlContent::Input {
            mode: InputMode::Queue,
            text,
        },
    }
    .signed_bytes()
    .unwrap();
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/instructions"
        ))
        .bearer_auth(&token)
        .json(
            &json!({ "text": text, "mode": "queue", "clientMsgId": nonce,
            "humanSignature": { "deviceKeyId": root_id, "nonce": nonce, "issuedAtMs": issued,
                "expiresAtMs": issued + 5 * 60 * 1000, "mode": "queue",
                "signature": root.sign(&bytes) }}),
        )
        .send()
        .await
        .unwrap();
    let sent_status = sent.status();
    let sent: Value = sent.json().await.unwrap();
    assert_eq!(sent_status, 201, "{sent}");
    let stripped = Uuid::parse_str(sent["workControl"]["id"].as_str().unwrap()).unwrap();
    strip_envelope(&su, stripped).await;
    signal(&workd, libc::SIGCONT);
    assert_eq!(
        wait_for_ack_label(&su, &fixture, &workd, stripped).await,
        "device_signature_required"
    );

    // ---- the operator switches the server flag back ------------------------
    server.stop().await;
    let address = server.address;
    let _server_off = start_server_at(app_pool.clone(), flag(false), address).await;
    let off = wait_until("the server's `false` on the socket", &workd, || async {
        let status = socket_signatures(&socket).await;
        (status["serverRequired"] == false).then_some(status)
    })
    .await;
    assert_eq!(
        off["required"], true,
        "the server's `false` lowers nothing: {off}"
    );
    let after_off = insert_control(
        &su,
        &fixture,
        host,
        fixture.owner,
        Some(session),
        "input",
        json!({"text": "unsigned after the server said false"}),
    )
    .await;
    assert_eq!(
        wait_for_ack_label(&su, &fixture, &workd, after_off).await,
        "device_signature_required"
    );

    // ---- a host restart: the latch is read back; the server's own ----------
    // unsigned resume (legal on the server with the flag off) is refused.
    assert_eq!(workd.stop().await, Some(0));
    workd.start_with_socket(&socket);
    let restarted = wait_until("the restarted host's status", &workd, || async {
        match tokio::net::UnixStream::connect(&socket).await {
            Ok(_) => Some(socket_signatures(&socket).await),
            Err(_) => None,
        }
    })
    .await;
    assert_eq!(restarted["required"], true, "{restarted}");
    assert_eq!(restarted["requiredBy"], "server", "{restarted}");
    let (refused_session, refused_spawn) = accepted_resume(
        &su,
        &fixture,
        host,
        owner_resume(
            &su,
            &http,
            base,
            &token,
            &fixture,
            host,
            "claude",
            "unsigned resume",
        )
        .await,
    )
    .await;
    assert_eq!(
        wait_for_ack_label(&su, &fixture, &workd, refused_spawn).await,
        "device_signature_required"
    );
    let _ = refused_session;

    // Nothing the host refused reached an agent.
    let prompts = stub_prompts(&workd, "claude");
    for refused in [
        "inserted unsigned by the server",
        "signed, then stripped",
        "unsigned after the server said false",
        "unsigned resume",
    ] {
        assert!(
            !prompts.iter().any(|prompt| prompt.contains(refused)),
            "{refused:?} reached the agent: {prompts:?}"
        );
    }

    // ---- only the local reset lowers it --------------------------------------
    let reset = ask_socket(&socket, json!({"op": "reset_signature_requirement"})).await;
    assert_eq!(reset, json!({"ok": true, "required": false}));
    let lowered = socket_signatures(&socket).await;
    assert_eq!(lowered["required"], false, "{lowered}");
    assert_eq!(lowered["serverRequired"], false, "{lowered}");
    let (session_after, spawn_after) = accepted_resume(
        &su,
        &fixture,
        host,
        owner_resume(
            &su,
            &http,
            base,
            &token,
            &fixture,
            host,
            "claude",
            "after the local reset",
        )
        .await,
    )
    .await;
    wait_until("the unsigned resume after the reset", &workd, || async {
        (control_state(&su, spawn_after).await == ("acked".to_string(), Some(session_after)))
            .then_some(())
    })
    .await;
    wait_until("its first turn", &workd, || async {
        stub_prompts(&workd, "claude")
            .iter()
            .any(|prompt| prompt.contains("after the local reset"))
            .then_some(())
    })
    .await;
    eprintln!("wdc_8: server off + restart → still required; local reset → unsigned resume runs");
    assert_eq!(workd.stop().await, Some(0));
}
