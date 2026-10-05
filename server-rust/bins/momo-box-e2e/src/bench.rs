//! The bench: a real Postgres, the real `momo-server` router on an ephemeral port, the real runner code (with a
//! fake docker), the real box-agent serving code (in-process, PTY at the test's own uid), and the owner's
//! device played by `momo-blind-pty`'s `DeviceClient` + a software P-256 key (the Secure Enclave stand-in).
//!
//! Nothing here reaches into the server's internals except two switches a real server also has: the relay hub's
//! runtime switch (`AppState::cloud_relay`) and — for the compromised-server scenarios — the hub's own
//! `open_session`, which is exactly what a server that skipped every authorisation would call.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use momo_blind_pty::codec::{Challenge, BOX_ID_LEN};
use momo_blind_pty::handshake::{DeviceClient, NonceStore};
use momo_blind_pty::session::{FrameKind, Session};
use momo_blind_pty::trust::{dev_pub, DeviceList, DeviceListState};
use momo_box_agent::boot::{enroll_and_confirm, BootEnv};
use momo_box_agent::env::UserProfile;
use momo_box_agent::fsgate::FsGate;
use momo_box_agent::host::{BoxHost, MonotonicClock, SpawnTemplate};
use momo_box_agent::serve::{self, BoxLimits, Exit, NonceSink, ServeConfig};
use momo_box_runner::client::HttpServer;
use momo_box_runner::config::RunnerConfig;
use momo_box_runner::engine::Engine;
use momo_box_runner::executor::{Executor, Pacing};
use momo_box_runner::identity::RunnerIdentity;
use momo_box_runner::provision::{HostProvisioner, Provisioner};
use momo_box_runner::runner::{Runner, Trust};
use momo_box_runner::testing::FakeDocker;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::cloud_box_relay::RelayLimits;
use momo_server::config::{
    CloudBoxConfig, DeviceKeySettings, RateLimitConfig, SettingsConfig,
};
use momo_server::{build_app, AppState, RealtimeAdvert};
use momo_wire::human_control::{ControlContent, HumanControl};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub const JWT_SECRET: &str = "momo-box-e2e-jwt-secret";
pub const PASSWORD: &str = "pw-correct-horse-battery-staple";
pub const INSTANCE_ID: &str = "inst_m4_e2e";
pub const SUBPROTOCOL: &str = "oort.cloud-pty.v1";

// ---------------------------------------------------------------------------
// postgres
// ---------------------------------------------------------------------------

pub fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the isolated PG"))
}

pub fn resolve_tool(name: &str) -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for dir in ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"] {
        let path = PathBuf::from(dir).join(name);
        if path.is_file() {
            return path;
        }
    }
    panic!("{name} not found");
}

pub async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(24)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into()),
        ))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_tool("psql"))
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

/// Every row of every table, as text — the "dump" a plaintext marker must not be in.
pub fn pg_dump_text() -> String {
    let output = Command::new(resolve_tool("pg_dump"))
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "--data-only",
            "--column-inserts",
            &required_pg_env("PGDATABASE"),
        ])
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .output()
        .expect("spawn pg_dump");
    assert!(output.status.success(), "pg_dump failed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

// ---------------------------------------------------------------------------
// log capture (what "the server's logs" are, in this process)
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("capture")).into_owned()
    }
    pub fn clear(&self) {
        self.0.lock().expect("capture").clear();
    }
}

struct CaptureWriter(Capture);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 .0.lock().expect("capture").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Install (once) a global `tracing` subscriber at TRACE that records everything every crate in this process
/// logs — the server's relay included — into a buffer the plaintext tests grep.
pub fn install_capture() -> Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let capture = Capture::default();
            let writer = capture.clone();
            let _ = tracing::subscriber::set_global_default(
                tracing_subscriber::fmt()
                    .with_max_level(tracing::Level::TRACE)
                    .with_ansi(false)
                    .with_writer(move || CaptureWriter(writer.clone()))
                    .finish(),
            );
            capture
        })
        .clone()
}

// ---------------------------------------------------------------------------
// people, keys, letters
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Person {
    pub id: Uuid,
    pub email: String,
    pub access: String,
    pub refresh: String,
}

/// A software stand-in for a device's Secure Enclave key, registered with the server as the person's root key.
#[derive(Clone)]
pub struct Device {
    pub key: SigningKey,
    pub key_id: Uuid,
    pub public_b64: String,
    pub public: [u8; 33],
}

fn new_device_key(label: &str) -> (SigningKey, [u8; 33]) {
    let seed = Sha256::digest(format!("#3511 {label} {}", Uuid::new_v4()).as_bytes());
    let key = SigningKey::from_slice(&seed).expect("a SHA-256 is a valid scalar here");
    let public = dev_pub(&key);
    (key, public)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub struct World {
    pub su: PgPool,
    pub http: reqwest::Client,
    pub base: String,
    /// The server as the VM and the boxes reach it (`base` unless `external_host` was set).
    pub external_base: String,
    pub state: AppState,
    pub workspace: Uuid,
    pub owner: Person,
    pub admin: Person,
    pub other: Person,
    pub capture: Capture,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("m4-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@box-e2e.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(PASSWORD)
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("membership");
    (id, email)
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    id: Uuid,
    email: &str,
) -> Person {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": PASSWORD, "workspace": workspace.to_string() }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    Person {
        id,
        email: email.to_string(),
        access: body["accessToken"].as_str().expect("access").to_string(),
        refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
    }
}

#[derive(Clone)]
pub struct BenchOptions {
    pub relay: RelayLimits,
    pub box_limits: BoxLimits,
    /// The program the PTY starts (same uid as this test process). `cat` echoes what is typed.
    pub program: (String, Vec<String>),
    /// Listen on every interface and name this machine as `host` to everything outside (a VM, a box container).
    pub external_host: Option<String>,
}

impl Default for BenchOptions {
    fn default() -> Self {
        BenchOptions {
            relay: RelayLimits {
                recheck: Duration::from_millis(300),
                ..RelayLimits::default()
            },
            box_limits: BoxLimits {
                poll_ms: 10,
                ..BoxLimits::default()
            },
            program: ("/bin/cat".to_string(), vec![]),
            external_host: None,
        }
    }
}

impl World {
    pub async fn start(opts: &BenchOptions) -> World {
        ensure_schema_and_roles();
        let capture = install_capture();
        let su = superuser_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(workspace)
            .bind(format!("m4-{workspace}"))
            .execute(&su)
            .await
            .expect("workspace");
        let (owner_id, owner_email) = seed_human(&su, workspace, "member").await;
        let (admin_id, admin_email) = seed_human(&su, workspace, "owner").await;
        let (other_id, other_email) = seed_human(&su, workspace, "member").await;
        let app = momo_app_pool().await;
        let state = AppState::new(app, JWT_SECRET.to_string(), RealtimeAdvert::SameOrigin)
            .with_settings(SettingsConfig {
                provider_link_master_key: None,
                env_provider: momo_settings::ProviderConfig::default(),
                // The workspace owner is also the instance operator that registers the runner (D2: the
                // operator is a different role from the box's owner, who is a plain member here).
                platform_admin_emails: vec![admin_email.clone()],
                environment: "local".to_string(),
            })
            .with_device_keys(DeviceKeySettings {
                instance_id: Some(INSTANCE_ID.to_string()),
                host_register_signature_required: false,
                refresh_reuse_sweep_all_sessions: false,
                human_control_signature_required: false,
                ..DeviceKeySettings::default()
            })
            .with_cloud_box(CloudBoxConfig { enabled: true })
            .with_cloud_relay_limits(opts.relay.clone())
            .with_rate_limit(RateLimitConfig {
                claim_per_ip_limit: 0,
                ..RateLimitConfig::default()
            });
        let bind_to = if opts.external_host.is_some() { "0.0.0.0:0" } else { "127.0.0.1:0" };
        let listener = tokio::net::TcpListener::bind(bind_to).await.expect("bind");
        let address: SocketAddr = listener.local_addr().expect("address");
        let serving = state.clone();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                build_app(serving).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        let base = format!("http://127.0.0.1:{}", address.port());
        let external_base = match &opts.external_host {
            Some(host) => format!("http://{host}:{}", address.port()),
            None => base.clone(),
        };
        let http = reqwest::Client::new();
        let owner = login(&http, &base, workspace, owner_id, &owner_email).await;
        let admin = login(&http, &base, workspace, admin_id, &admin_email).await;
        let other = login(&http, &base, workspace, other_id, &other_email).await;
        World {
            su,
            http,
            base,
            external_base,
            state,
            workspace,
            owner,
            admin,
            other,
            capture,
        }
    }

    pub fn url(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}{tail}", self.base, self.workspace)
    }

    pub fn ws_url(&self, path: &str) -> String {
        format!("ws://{}{path}", self.base.trim_start_matches("http://"))
    }

    pub async fn call(
        &self,
        method: reqwest::Method,
        tail: &str,
        bearer: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let request = self
            .http
            .request(method, self.url(tail))
            .bearer_auth(bearer);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body");
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    pub async fn post(&self, tail: &str, bearer: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, tail, bearer, Some(body)).await
    }

    pub async fn put(&self, tail: &str, bearer: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::PUT, tail, bearer, Some(body)).await
    }

    pub async fn get(&self, tail: &str, bearer: &str) -> (u16, Value) {
        self.call(reqwest::Method::GET, tail, bearer, None).await
    }

    /// Register a fresh software device key as `person`'s root (macOS) key.
    pub async fn register_device(&self, person: &Person, label: &str) -> Device {
        let (key, public) = new_device_key(label);
        let public_b64 = BASE64.encode(public);
        let (status, body) = self
            .post(
                "/device-keys",
                &person.access,
                json!({
                    "alg": "p256", "publicKey": public_b64, "platform": "macos",
                    "label": label, "currentPassword": PASSWORD,
                }),
            )
            .await;
        assert_eq!(status, 201, "register device key: {body}");
        let key_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().expect("key id")).expect("uuid");
        Device {
            key,
            key_id,
            public_b64,
            public,
        }
    }

    /// The signed control (`momo.human.control.v3`) for `content`, addressed to `host_id`, as the request's
    /// `signature` object.
    pub fn letter(
        &self,
        person: &Person,
        device: &Device,
        host_id: Uuid,
        content: ControlContent<'_>,
    ) -> Value {
        self.letter_with(person, device, host_id, content, Uuid::new_v4(), now_ms(), now_ms() + 120_000)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn letter_with(
        &self,
        person: &Person,
        device: &Device,
        host_id: Uuid,
        content: ControlContent<'_>,
        nonce: Uuid,
        issued_at_ms: i64,
        expires_at_ms: i64,
    ) -> Value {
        let statement = HumanControl {
            instance_id: INSTANCE_ID,
            workspace_id: self.workspace,
            member_id: person.id,
            device_key_id: device.key_id,
            host_id,
            session_id: None,
            nonce,
            issued_at_ms,
            expires_at_ms,
            content,
        };
        let bytes = statement.signed_bytes().expect("signed bytes");
        let signature: Signature = device.key.sign(&bytes);
        json!({
            "deviceKeyId": device.key_id,
            "nonce": nonce,
            "issuedAtMs": issued_at_ms,
            "expiresAtMs": expires_at_ms,
            "signature": BASE64.encode(signature.to_bytes()),
        })
    }
}

// ---------------------------------------------------------------------------
// the box: runner (real code, fake docker) + box-agent (real serving code)
// ---------------------------------------------------------------------------

pub struct Agent {
    pub shutdown: watch::Sender<bool>,
    pub join: tokio::task::JoinHandle<Exit>,
    pub state_dir: PathBuf,
    pub host: Arc<Mutex<BoxHost>>,
}

pub struct Bench {
    pub world: World,
    pub tmp: PathBuf,
    pub owner_device: Device,
    pub box_id: Uuid,
    pub host_id: Uuid,
    pub owner_list: DeviceList,
    pub runner: Arc<Runner>,
    pub provisioner: Arc<HostProvisioner>,
    pub runner_identity_fingerprint: [u8; 32],
    pub runner_public: [u8; 32],
    pub host_public: [u8; 32],
    /// The box-agent's host key. Tests that need to speak AS the box (a second listen socket, a replayed
    /// request) sign with it; the server never has it.
    pub host_key: ed25519_dalek::SigningKey,
    pub agent: Option<Agent>,
    pub docker: Arc<FakeDocker>,
}

impl Bench {
    pub fn box16(&self) -> [u8; BOX_ID_LEN] {
        *self.box_id.as_bytes()
    }

    /// The whole provisioning story, through the real routes and the real code of both sides, up to a box whose
    /// agent is listening: create → owner device list (signed) → runner `create` → registration MAC → runner
    /// attestation → agent active and listening.
    pub async fn up(opts: BenchOptions) -> Bench {
        let world = World::start(&opts).await;
        let tmp = std::env::temp_dir().join(format!("momo-m4-bench-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).expect("tmp");
        let owner_device = world.register_device(&world.owner, "owner mac").await;

        // 1. The owner creates the box.
        let (status, body) = world.post("/cloud-boxes", &world.owner.access, json!({})).await;
        assert_eq!(status, 201, "create box: {body}");
        let box_id = Uuid::parse_str(body["id"].as_str().expect("box id")).expect("uuid");

        // 2. The owner's device signs the first owner list and plants it (R2-signed control).
        let box16 = *box_id.as_bytes();
        let owner_list = DeviceList::sign(box16, 1, vec![owner_device.public], &owner_device.key);
        let list_bytes = owner_list.to_bytes();
        let signature = world.letter(
            &world.owner,
            &owner_device,
            box_id,
            ControlContent::CloudBoxOwnerList {
                box_id,
                list_sha256: &hex_sha256(&list_bytes),
            },
        );
        let (status, body) = world
            .put(
                &format!("/cloud-boxes/{box_id}/owner-device-list"),
                &world.owner.access,
                json!({ "list": BASE64.encode(&list_bytes), "signature": signature }),
            )
            .await;
        assert_eq!(status, 200, "owner list: {body}\n{}", world.capture.text());

        // 3. The instance operator registers the runner; the runner's real code (fake docker) takes its create.
        let (status, body) = world
            .post("/cloud-box-runners", &world.admin.access, json!({ "name": "bench runner" }))
            .await;
        assert_eq!(status, 201, "register runner: {body}");
        let credential = body["credential"].as_str().expect("credential").to_string();
        let state_dir = tmp.join("runner-state");
        std::fs::create_dir_all(&state_dir).expect("runner state");
        let identity_path = tmp.join("runner.key");
        let identity = RunnerIdentity::create(&identity_path).expect("runner identity");
        let runner_public = identity.public_key();
        let fingerprint: [u8; 32] = Sha256::digest(runner_public).into();
        let cfg = Arc::new(
            RunnerConfig::parse(
                &json!({
                    "serverUrl": world.base,
                    "allowInsecureLoopback": true,
                    "workspaceId": world.workspace,
                    "credentialFile": "/nonexistent/credential",
                    "image": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    "namePrefix": "momo-m4-",
                    "network": "momo-m4-net",
                    "diskQuota": "unenforced-dev",
                    "stateDir": state_dir,
                    "signingKeyFile": identity_path,
                    "pollIntervalSeconds": 1,
                })
                .to_string(),
            )
            .expect("runner config"),
        );
        let server = Arc::new(
            HttpServer::new(&world.base, world.workspace, credential).expect("runner http"),
        );
        let provisioner = Arc::new(HostProvisioner::new(cfg.clone(), server.clone()).without_chown());
        let docker = Arc::new(FakeDocker::new());
        let engine = Engine::new(docker.clone(), cfg.clone());
        let executor = Executor::new(
            engine.clone(),
            Pacing {
                running_polls: 3,
                running_poll_delay: Duration::from_millis(1),
                create_attempts: 1,
                create_retry_delay: Duration::from_millis(1),
            },
        )
        .with_provisioner(provisioner.clone() as Arc<dyn Provisioner>);
        let runner = Arc::new(Runner::new(cfg, engine, executor, server).with_trust(Trust {
            identity,
            provisioner: provisioner.clone() as Arc<dyn Provisioner>,
        }));
        runner.announce_identity().await.expect("announce identity");
        let summary = runner.poll_once().await.expect("runner poll");
        assert_eq!(summary.executed, 1, "the runner took the create control");
        let (status, mine) = world.get("/cloud-boxes/mine", &world.owner.access).await;
        assert_eq!(status, 200);
        assert_eq!(mine["box"]["state"], "running", "{mine}");

        // 4. The box-agent's real boot code registers (proving the pairing code by MAC) while the runner's real
        //    code verifies and attests; then the agent listens.
        let host_key = ed25519_dalek::SigningKey::from_bytes(&rand_seed());
        let host_public = host_key.verifying_key().to_bytes();
        let agent_state = tmp.join("agent-state");
        std::fs::create_dir_all(&agent_state).expect("agent state");
        let profile = UserProfile {
            cwd: std::env::temp_dir().display().to_string(),
            ..UserProfile::box_default()
        };
        let mut host = BoxHost::new(
            box16,
            host_key.clone(),
            Arc::new(MonotonicClock::new()),
            NonceStore::default(),
            SpawnTemplate::same_uid_for_tests(
                profile,
                vec![("PATH".into(), "/usr/bin:/bin".into())],
                Some((PathBuf::from(&opts.program.0), opts.program.1.clone())),
            ),
        );
        let attesting = {
            let runner = runner.clone();
            tokio::spawn(async move {
                for _ in 0..300 {
                    if let Ok(summary) = runner.attest_registrations().await {
                        if summary.attested > 0 {
                            return true;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                false
            })
        };
        let gate = FsGate::new(Vec::<PathBuf>::new());
        let env = BootEnv {
            server_url: world.base.clone(),
            workspace_id: world.workspace,
            box_id,
            inject_dir: provisioner.inject_dir(box_id),
            state_dir: agent_state.clone(),
            give_up_after: Duration::from_secs(30),
            poll: Duration::from_millis(100),
        };
        let host_id = enroll_and_confirm(&mut host, &gate, &env)
            .await
            .expect("the box-agent registers and the owner confirms");
        assert!(attesting.await.expect("attest task"), "the runner attested");
        let host = Arc::new(Mutex::new(host));
        let nonce_gate = gate.clone();
        let nonce_path = momo_box_agent::boot::nonce_path(&agent_state);
        let sink: NonceSink = Arc::new(move |bytes: Vec<u8>| {
            nonce_gate
                .write_private(&nonce_path, &bytes)
                .expect("persist the spent-challenge store");
        });
        let (shutdown, rx) = watch::channel(false);
        let join = tokio::spawn(serve::run(
            ServeConfig {
                server_url: world.base.clone(),
                workspace_id: world.workspace,
                host_id,
                limits: opts.box_limits,
            },
            host_key.clone(),
            host.clone(),
            sink,
            rx,
        ));
        let bench = Bench {
            world,
            tmp,
            owner_device,
            box_id,
            host_id,
            owner_list,
            runner,
            provisioner,
            runner_identity_fingerprint: fingerprint,
            runner_public,
            host_public,
            host_key,
            agent: Some(Agent {
                shutdown,
                join,
                state_dir: agent_state,
                host,
            }),
            docker,
        };
        bench.wait_listening().await;
        bench
    }

    pub async fn wait_listening(&self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let (_, bundle) = self
                .world
                .get(&format!("/cloud-boxes/{}/trust-bundle", self.box_id), &self.world.owner.access)
                .await;
            if bundle["agentOnline"] == true {
                return;
            }
            assert!(Instant::now() < deadline, "the box-agent never started listening: {bundle}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn stop_agent(&mut self) -> Option<Exit> {
        let agent = self.agent.take()?;
        let _ = agent.shutdown.send(true);
        tokio::time::timeout(Duration::from_secs(10), agent.join)
            .await
            .ok()
            .and_then(Result::ok)
    }

    pub fn target(&self) -> Target<'_> {
        Target {
            world: &self.world,
            box_id: self.box_id,
            host_id: self.host_id,
            owner_device: &self.owner_device,
            owner_list: &self.owner_list,
            runner_fingerprint: self.runner_identity_fingerprint,
        }
    }

    pub async fn pinned_client(&self, device: &Device) -> DeviceClient {
        self.target().pinned_client(device).await
    }

    pub fn attach_body(&self, person: &Person, device: &Device, hello: &[u8]) -> Value {
        self.target().attach_body(person, device, hello)
    }

    pub async fn attach(&self, client: &DeviceClient, device: &Device) -> Result<DeviceConn, String> {
        self.target().attach(client, device).await
    }

    pub async fn open_relay_socket(&self, attach_answer: &Value) -> Result<RelaySocket, String> {
        self.target().open_relay_socket(attach_answer).await
    }
}

/// What a device needs to reach one box: the server, the box and its host, the owner's own device and list, and the
/// runner fingerprint the member typed in (from the operator, NOT from the server). The in-process bench and the
/// docker run both build one.
pub struct Target<'a> {
    pub world: &'a World,
    pub box_id: Uuid,
    pub host_id: Uuid,
    pub owner_device: &'a Device,
    pub owner_list: &'a DeviceList,
    pub runner_fingerprint: [u8; 32],
}

impl Target<'_> {
    pub fn box16(&self) -> [u8; BOX_ID_LEN] {
        *self.box_id.as_bytes()
    }

    /// A device client for `device` that knows the owner's list and the typed-in runner fingerprint, and has
    /// pinned the host (trust-bundle → `pin_host` → `PUT pin`), as the first-pairing UI does.
    pub async fn pinned_client(&self, device: &Device) -> DeviceClient {
        let mut client = DeviceClient::new(
            device.key.clone(),
            DeviceListState::bootstrap(self.owner_list.clone()).expect("owner list"),
        );
        // What the member typed in from the operator, out of band: NOT from the server.
        client.set_runner_fingerprint(self.runner_fingerprint);
        let (status, bundle) = self
            .world
            .get(&format!("/cloud-boxes/{}/trust-bundle", self.box_id), &self.world.owner.access)
            .await;
        assert_eq!(status, 200, "{bundle}");
        let decode = |value: &Value| BASE64.decode(value.as_str().expect("b64")).expect("decode");
        let runner_pub: [u8; 32] = decode(&bundle["runner"]["publicKey"]).try_into().expect("32");
        let host_pub: [u8; 32] = decode(&bundle["host"]["publicKey"]).try_into().expect("32");
        let attestation: [u8; 64] = decode(&bundle["host"]["attestation"]).try_into().expect("64");
        let pin = client
            .pin_host(self.box16(), host_pub, runner_pub, attestation)
            .expect("pin the host (fingerprint matches, attestation verifies)");
        let (status, body) = self
            .world
            .put(
                &format!("/cloud-boxes/{}/pin", self.box_id),
                &self.world.owner.access,
                json!({ "pin": BASE64.encode(pin.to_bytes()) }),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        client
    }

    /// The request body of `POST …/attach` for `hello`, signed by `device` for the box's host.
    pub fn attach_body(&self, person: &Person, device: &Device, hello: &[u8]) -> Value {
        json!({
            "hello": BASE64.encode(hello),
            "signature": self.world.letter(
                person,
                device,
                self.host_id,
                ControlContent::CloudPtyAttach { box_id: self.box_id, hello_sha256: &hex_sha256(hello) },
            ),
        })
    }

    /// The full, honest attach: signed control → ticket → socket → handshake → a session the owner can type in.
    pub async fn attach(&self, client: &DeviceClient, device: &Device) -> Result<DeviceConn, String> {
        let (hello, handshake) = client.hello(self.box16()).map_err(|e| format!("hello: {e}"))?;
        let hello_bytes = hello.to_bytes();
        let (status, body) = self
            .world
            .post(
                &format!("/cloud-boxes/{}/attach", self.box_id),
                &self.world.owner.access,
                self.attach_body(&self.world.owner, device, &hello_bytes),
            )
            .await;
        if status != 200 {
            return Err(format!("attach {status}: {body}"));
        }
        let mut socket = self.open_relay_socket(&body).await?;
        socket
            .send(Message::Binary(hello_bytes.into()))
            .await
            .map_err(|e| e.to_string())?;
        let challenge_bytes = next_binary(&mut socket, Duration::from_secs(10))
            .await?
            .ok_or("closed before the challenge")?;
        let challenge = Challenge::from_bytes(&challenge_bytes).map_err(|e| format!("challenge: {e}"))?;
        let (auth, pending) = handshake
            .on_challenge(challenge)
            .map_err(|e| format!("on_challenge: {e}"))?;
        socket
            .send(Message::Binary(auth.to_bytes().into()))
            .await
            .map_err(|e| e.to_string())?;
        let ready = next_binary(&mut socket, Duration::from_secs(10))
            .await?
            .ok_or("closed before Ready")?;
        let session = pending.confirm(&ready).map_err(|e| format!("confirm: {e}"))?;
        Ok(DeviceConn {
            session,
            socket,
            session_id: Uuid::parse_str(body["sessionId"].as_str().expect("session id")).expect("uuid"),
        })
    }

    /// Open the device relay socket named by an attach answer (ticket in the subprotocol header).
    pub async fn open_relay_socket(&self, attach_answer: &Value) -> Result<RelaySocket, String> {
        let path = attach_answer["relay"]["path"].as_str().ok_or("no relay path")?;
        let ticket = attach_answer["ticket"].as_str().ok_or("no ticket")?;
        open_socket(
            &self.world.ws_url(path),
            &[("Sec-WebSocket-Protocol", format!("{SUBPROTOCOL}, ticket.{ticket}"))],
        )
        .await
    }
}

fn rand_seed() -> [u8; 32] {
    let digest = Sha256::digest(Uuid::new_v4().as_bytes());
    digest.into()
}

pub type RelaySocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub async fn open_socket(url: &str, headers: &[(&str, String)]) -> Result<RelaySocket, String> {
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    for (name, value) in headers {
        request.headers_mut().insert(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?,
            value.parse().map_err(|_| "header".to_string())?,
        );
    }
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(socket)
}

/// The next binary message, `None` on a clean close, `Err` on timeout or a non-binary message.
pub async fn next_binary(socket: &mut RelaySocket, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, socket.next()).await {
            Err(_) => return Err("timed out".into()),
            Ok(None) => return Ok(None),
            Ok(Some(Err(_))) => return Ok(None),
            Ok(Some(Ok(Message::Binary(bytes)))) => return Ok(Some(bytes.to_vec())),
            Ok(Some(Ok(Message::Close(_)))) => return Ok(None),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Ok(Some(Ok(other))) => return Err(format!("unexpected message {other:?}")),
        }
    }
}

/// The owner's end of an attached session.
pub struct DeviceConn {
    pub session: Session,
    pub socket: RelaySocket,
    pub session_id: Uuid,
}

impl DeviceConn {
    pub async fn send(&mut self, kind: FrameKind, payload: &[u8]) -> Result<(), String> {
        let frame = self.session.seal(kind, payload).map_err(|e| e.to_string())?;
        self.socket
            .send(Message::Binary(frame.into()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn open_terminal(&mut self, cols: u16, rows: u16) -> Result<(), String> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&cols.to_be_bytes());
        payload.extend_from_slice(&rows.to_be_bytes());
        self.send(FrameKind::Resize, &payload).await
    }

    pub async fn type_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        for chunk in bytes.chunks(8192) {
            self.send(FrameKind::Data, chunk).await?;
        }
        Ok(())
    }

    /// Frames until `done(&collected)` says so. `Ok(collected)`; `Err` on timeout, a bad frame or the socket
    /// ending first (`collected` so far is in the error text length only — tests assert on the Ok path).
    pub async fn read_until(
        &mut self,
        timeout: Duration,
        done: impl Fn(&[u8]) -> bool,
    ) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        let mut collected = Vec::new();
        while !done(&collected) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Some(frame) = next_binary(&mut self.socket, remaining).await? else {
                return Err("the socket ended".into());
            };
            let (kind, payload) = self.session.open(&frame).map_err(|e| e.to_string())?;
            match kind {
                FrameKind::Data => collected.extend_from_slice(&payload),
                FrameKind::Close => return Err("the box closed the terminal".into()),
                _ => {}
            }
        }
        Ok(collected)
    }

    /// Wait for the relay socket to end (any way). Returns the WebSocket close reason when there is one.
    pub async fn wait_closed(&mut self, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, self.socket.next()).await {
                Err(_) => return None,
                Ok(None) | Ok(Some(Err(_))) => return Some(String::new()),
                Ok(Some(Ok(Message::Close(frame)))) => {
                    return Some(frame.map(|f| f.reason.to_string()).unwrap_or_default())
                }
                Ok(Some(Ok(_))) => continue,
            }
        }
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        if let Some(agent) = self.agent.take() {
            let _ = agent.shutdown.send(true);
            agent.join.abort();
        }
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

pub fn temp_path(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("momo-m4-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&path).expect("temp dir");
    path
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

/// The HTTP status a WebSocket upgrade was answered with when it did **not** upgrade (`None` when it did).
pub async fn upgrade_refused_with(url: &str, headers: &[(&str, String)]) -> Option<u16> {
    let mut request = url.into_client_request().expect("request");
    for (name, value) in headers {
        request.headers_mut().insert(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
            value.parse().expect("header value"),
        );
    }
    match tokio_tungstenite::connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Some(response.status().as_u16()),
        Err(_) => Some(0),
        Ok(_) => None,
    }
}

/// Whether the box's host row is revoked (`None` when the box has no host).
pub async fn host_revoked(world: &World, box_id: Uuid) -> Option<bool> {
    sqlx::query_scalar(
        "SELECT h.revoked_at IS NOT NULL FROM cloud_box_agent a JOIN work_host h ON h.id = a.host_id WHERE a.box_id = $1",
    )
    .bind(box_id)
    .fetch_optional(&world.su)
    .await
    .expect("host row")
}
