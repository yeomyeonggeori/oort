//! End-to-end conformance for the **managed provisioning curve** (ADR-0136
//! D1-A, ADR-0156 D4-④).
//!
//! Drives the real router over HTTP, against a real Postgres and a **fake
//! CubeAPI** on a loopback socket, and closes the whole curve the packet names:
//!
//! ```text
//! tier policy auto_target=cloud
//!   → POST …/work-hosts/cloud        (durable row, provider create, handle recorded)
//!   → the substrate's sandbox carries MOMO_WORKD_REGISTRATION_TOKEN
//!   → POST …/work-hosts/cloud/register  (the workd spends it, host bound, ready)
//!   → POST …/work-sessions              (existing routing, 201, ledger opens)
//! ```
//!
//! and the failure halves beside it: a substrate that refuses the create, a
//! bootstrap token whose TTL ran out, and a provision nobody ever registers.
//!
//! `#[ignore]` because it needs a real DB. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test cloud_provisioner_conformance_pg -- --ignored --nocapture
//! ```
//!
//! ## Why the substrate is a fake, and what makes it worth trusting
//!
//! ADR-0156 D4-② owns the real host and this suite must not wait for it. The
//! double is the same one `momo-t3`'s adapter conformance uses, reduced to what
//! this curve exercises, and it keeps the two upstream behaviours that make the
//! curve hard:
//!
//! * **no idempotency key** — every `POST /sandboxes` mints a new billable
//!   sandbox, so nothing but momo's own reconstruction stands between a retry
//!   and a second instance;
//! * **`envVars` are delivered once, at create time** — CubeSandbox hands them
//!   to a listener inside the guest during the create call and never again
//!   (#1437), so a sandbox cannot be told a new bootstrap token later. That is
//!   exactly why ADR-0136 D2 requires the token to be *derived* rather than
//!   minted: a retry has to re-derive what the first attempt already delivered.
//!   The registration below uses the token the substrate actually holds, never
//!   the one the test wishes it held.
//!
//! ## The two red proofs this suite carries
//!
//! 1. [`a_lost_create_response_yields_one_host_not_two`] — the ADR-0136 D2
//!    convergence clause. Inject a non-deterministic
//!    `CloudProvisioner::bootstrap_token`, or delete the replay branch in
//!    `cloud_hosts::provision`, and a single logical request ends with two
//!    provisions, two paid sandboxes and two registered hosts.
//! 2. [`a_disabled_t3_never_reaches_the_substrate`] — ADR-0140's activation
//!    gate. With `MOMO_T3_ENABLED` off the route answers 503, **no row exists**
//!    and the fake substrate recorded **zero** requests. Delete the `ready_t3`
//!    call from the handler and the fake's request log is no longer empty: an
//!    instance nobody activated has started paying.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json as AxumJson, Router};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::T3Settings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness — same contract as t3_smoke_pg.rs (superuser DATABASE_URL, momo_app
// server role, re-runnable schema step, fresh UUIDs per fixture)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

const TEST_JWT_SECRET: &str = "cloud-provisioner-conformance-secret";
const TEST_PASSWORD: &str = "cloud-provisioner-conformance-password";
const UNIT_RATE_MICRO_USD_SECOND: i64 = 41;
const TOPUP_MICRO_USD: i64 = 5_000_000;
/// The operator credential the fake demands. ADR-0004: it exists only in this
/// process's environment map and in the adapter that owns it — in particular the
/// assertions below check it never reached a sandbox or the database.
const OPERATOR_KEY: &str = "cube-operator-key-not-a-real-secret";
const TEMPLATE_ID: &str = "tpl-oort-workd";

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
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

// ---------------------------------------------------------------------------
// the fake CubeAPI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Sandbox {
    id: String,
    metadata: BTreeMap<String, String>,
    env_vars: BTreeMap<String, String>,
}

impl Sandbox {
    fn detail(&self) -> Value {
        json!({
            "sandboxID": self.id,
            "templateID": TEMPLATE_ID,
            "state": "running",
            "metadata": self.metadata,
        })
    }
}

#[derive(Debug, Default)]
struct FakeState {
    /// Instance-id prefix, unique per fake.
    ///
    /// `work_cloud_host.provider_sandbox_id` is UNIQUE **globally** (045:95), not
    /// per workspace — which is the schema saying that two rows may never claim
    /// one instance. Every test in this binary shares one database, so a fake
    /// that counted from 1 would hand the second test an id the first already
    /// recorded, and the insert would fail for a reason that has nothing to do
    /// with what the test is measuring.
    id_prefix: String,
    sandboxes: Vec<Sandbox>,
    requests: Vec<(String, String)>,
    create_bodies: Vec<Value>,
    /// Whether the create response is delivered. `false` = the sandbox is made
    /// and the caller never learns its id — the failure the reconstruction and
    /// the derived token exist for.
    deliver_create_response: bool,
    /// Refuse the create **without** making anything: the substrate is out of
    /// room, or down.
    refuse_create_without_making: Option<u16>,
    next_id: u64,
}

#[derive(Debug, Clone, Default)]
struct FakeCube(Arc<Mutex<FakeState>>);

impl FakeCube {
    fn new() -> Self {
        FakeCube(Arc::new(Mutex::new(FakeState {
            deliver_create_response: true,
            // Upstream's documented shape is `iiny0783cype8gmoawzmx-ce30bc46`:
            // an opaque token that satisfies `validated_cloud_instance_id`.
            id_prefix: Uuid::new_v4().as_simple().to_string(),
            ..FakeState::default()
        })))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live_count(&self) -> usize {
        self.lock().sandboxes.len()
    }

    fn create_count(&self) -> usize {
        self.lock().create_bodies.len()
    }

    fn request_count(&self) -> usize {
        self.lock().requests.len()
    }

    fn only_sandbox(&self) -> Sandbox {
        let state = self.lock();
        assert_eq!(
            state.sandboxes.len(),
            1,
            "expected exactly one sandbox, found {}",
            state.sandboxes.len()
        );
        state.sandboxes[0].clone()
    }

    /// The bootstrap token the substrate actually baked into the instance. The
    /// tests register with **this**, never with a value they computed
    /// themselves — that is what makes the determinism assertion mean something.
    fn baked_registration_token(&self, sandbox: &Sandbox) -> String {
        sandbox
            .env_vars
            .get("MOMO_WORKD_REGISTRATION_TOKEN")
            .cloned()
            .expect("the sandbox was handed a registration token")
    }
}

fn unauthorized(headers: &HeaderMap) -> bool {
    headers
        .get("X-API-Key")
        .and_then(|value| value.to_str().ok())
        != Some(OPERATOR_KEY)
}

fn status_only(code: u16) -> Response {
    StatusCode::from_u16(code)
        .expect("valid status")
        .into_response()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

async fn create_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    AxumJson(body): AxumJson<Value>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("POST".to_string(), "/sandboxes".to_string()));
    if unauthorized(&headers) {
        return status_only(401);
    }
    if let Some(code) = state.refuse_create_without_making {
        return status_only(code);
    }
    state.create_bodies.push(body.clone());

    state.next_id += 1;
    let id = format!("{}-ce30bc{:02}", state.id_prefix, state.next_id);
    state.sandboxes.push(Sandbox {
        id: id.clone(),
        metadata: string_map(body.get("metadata")),
        env_vars: string_map(body.get("envVars")),
    });

    if !state.deliver_create_response {
        // The sandbox exists and is billing; the caller never learns its id.
        return status_only(502);
    }
    (
        StatusCode::CREATED,
        AxumJson(json!({ "sandboxID": id, "templateID": TEMPLATE_ID })),
    )
        .into_response()
}

async fn list_sandboxes(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    Query(query): Query<Vec<(String, String)>>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("GET".to_string(), "/sandboxes".to_string()));
    if unauthorized(&headers) {
        return status_only(401);
    }
    let filters: Vec<(String, String)> = query
        .iter()
        .filter(|(key, _)| key == "metadata")
        .filter_map(|(_, value)| {
            let (key, value) = value.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect();
    let matched: Vec<Value> = state
        .sandboxes
        .iter()
        .filter(|sandbox| {
            filters
                .iter()
                .all(|(key, value)| sandbox.metadata.get(key) == Some(value))
        })
        .map(Sandbox::detail)
        .collect();
    AxumJson(Value::Array(matched)).into_response()
}

async fn get_sandbox(
    State(fake): State<FakeCube>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let mut state = fake.lock();
    state
        .requests
        .push(("GET".to_string(), format!("/sandboxes/{id}")));
    if unauthorized(&headers) {
        return status_only(401);
    }
    match state.sandboxes.iter().find(|sandbox| sandbox.id == id) {
        None => status_only(404),
        Some(sandbox) => AxumJson(sandbox.detail()).into_response(),
    }
}

async fn spawn_fake_cube() -> (String, FakeCube) {
    let fake = FakeCube::new();
    let app = Router::new()
        .route("/sandboxes", post(create_sandbox).get(list_sandboxes))
        .route("/sandboxes/{id}", get(get_sandbox))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake cube api");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), fake)
}

/// The provider environment, as an explicit map.
///
/// Deliberately **not** the process environment: these tests run concurrently in
/// one binary, each against its own fake substrate on its own port, and a shared
/// process env would make them race for one base URL. It is also the same map
/// shape `momo_t3::provisioner_from_process_env` reads in production, so the
/// factory under test is the production one.
fn provider_env(base_url: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            base_url.to_string(),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
            OPERATOR_KEY.to_string(),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
            TEMPLATE_ID.to_string(),
        ),
    ])
}

const MANAGED_PROVIDER_ID: &str = "cubesandbox";

/// Boot the real router with T3 on and the managed provisioner attached.
async fn start_server(
    pool: PgPool,
    operator_email: &str,
    provider_base_url: Option<&str>,
    t3_enabled: bool,
) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_t3(T3Settings {
        enabled: t3_enabled,
        default_provider_id: MANAGED_PROVIDER_ID.to_string(),
        public_base_url: Some("https://provisioner.momo.invalid".to_string()),
        unit_rate_micro_usd_second: UNIT_RATE_MICRO_USD_SECOND,
        platform_admin_emails: vec![operator_email.to_lowercase()],
    });
    if let Some(base_url) = provider_base_url {
        // The production factory, over an explicit env map (see `provider_env`).
        let provisioner =
            momo_t3::provisioner_from_env(MANAGED_PROVIDER_ID, &provider_env(base_url))
                .expect("the operator configured a managed substrate");
        state = state.with_t3_provisioner(Arc::new(provisioner));
    }
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{member}@cloud-provisioner.test");

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    sqlx::query("INSERT INTO workspace_credit (workspace_id, balance_micro_usd) VALUES ($1, 0)")
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed credit ledger");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("cloud-prov-{}", Uuid::new_v4()),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("create channel");

    Fixture {
        workspace,
        member,
        email,
        channel: channel.id,
    }
}

/// A throwaway Ed25519 keypair for the "cloud workd".
fn workd_keypair() -> ([u8; 32], String) {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
    workspace: Uuid,
}

impl Client {
    async fn login(base: String, workspace: Uuid, email: &str) -> Client {
        let http = reqwest::Client::new();
        let login: Value = http
            .post(format!("{base}/v1/auth/login"))
            .json(&json!({
                "email": email,
                "password": TEST_PASSWORD,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login")
            .json()
            .await
            .expect("login body");
        let token = login["accessToken"]
            .as_str()
            .expect("accessToken")
            .to_string();
        Client {
            http,
            base,
            token,
            workspace,
        }
    }

    async fn topup(&self) {
        let workspace = self.workspace;
        let response = self
            .http
            .post(format!(
                "{}/v1/admin/workspaces/{workspace}/credits/topups",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&json!({
                "amountMicroUsd": TOPUP_MICRO_USD,
                "idempotencyRef": Uuid::new_v4().to_string(),
            }))
            .send()
            .await
            .expect("topup");
        assert_eq!(response.status(), 200, "a listed operator may top up");
    }

    /// The ADR-0136 D1-A trigger, set through the real policy route.
    async fn set_tier_policy(&self, mode: &str, auto_target: Option<&str>) {
        let workspace = self.workspace;
        let mut body = serde_json::Map::new();
        body.insert("mode".to_string(), json!(mode));
        if let Some(target) = auto_target {
            body.insert("autoTarget".to_string(), json!(target));
        }
        let response = self
            .http
            .put(format!(
                "{}/v1/workspaces/{workspace}/work-tier-policy/me",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&Value::Object(body))
            .send()
            .await
            .expect("put tier policy");
        assert_eq!(response.status(), 200, "the member sets their own policy");
    }

    /// Register an ordinary local host (`POST …/work-hosts`), so the pinned-host
    /// policy arm below can point at something that exists — `tier_target_allowed`
    /// refuses an `autoTarget` naming a host the workspace does not have, and
    /// that refusal would mask the one this test is actually about.
    async fn register_local_host(&self) -> String {
        let workspace = self.workspace;
        let (_, public_key) = workd_keypair();
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/work-hosts",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&json!({
                "scope": "workspace",
                "type": "workd",
                "displayName": "the laptop the policy pins to",
                "publicKey": public_key,
            }))
            .send()
            .await
            .expect("register work host");
        assert_eq!(response.status(), 201, "a human registers their own daemon");
        let body: Value = response.json().await.expect("work host body");
        body["workHost"]["id"]
            .as_str()
            .expect("workHost.id")
            .to_string()
    }

    async fn provision(&self, idempotency_ref: Uuid) -> (StatusCode, Value) {
        let workspace = self.workspace;
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/work-hosts/cloud",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&json!({
                "displayName": "managed cloud box",
                "scope": "workspace",
                "idempotencyRef": idempotency_ref.to_string(),
            }))
            .send()
            .await
            .expect("provision");
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    async fn register(&self, bootstrap_token: &str, public_key: &str) -> (StatusCode, Value) {
        let workspace = self.workspace;
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/work-hosts/cloud/register",
                self.base
            ))
            .header("Authorization", format!("MomoBootstrap {bootstrap_token}"))
            .json(&json!({
                "scope": "workspace",
                "type": "cloud",
                "displayName": "managed cloud box",
                "publicKey": public_key,
                "capabilities": {"terminal_attach": false},
            }))
            .send()
            .await
            .expect("cloud register");
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        (status, body)
    }
}

async fn provision_row_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_cloud_host WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count provisions")
}

async fn cloud_host_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM work_host WHERE workspace_id = $1 AND type = 'cloud'")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count cloud hosts")
}

// ---------------------------------------------------------------------------
// the closed curve
// ---------------------------------------------------------------------------

/// Request → create → bootstrap → self-registration → session routing → 201.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_cloud_policy_acquires_registers_and_runs_a_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    // ADR-0136 D1-A: the flow begins at a cloud session request, which is a
    // member whose policy says work goes to the cloud.
    client.set_tier_policy("auto", Some("cloud")).await;

    // ---- acquisition -----------------------------------------------------
    let (status, body) = client.provision(Uuid::new_v4()).await;
    assert_eq!(
        status, 201,
        "a cloud policy may acquire a paid host: {body}"
    );
    let provision = &body["provision"];
    let provision_id = provision["provisionId"].as_str().expect("provisionId");
    assert_eq!(provision["provider"], json!(MANAGED_PROVIDER_ID));
    assert_eq!(
        provision["state"],
        json!("provisioning"),
        "the row stays provisioning until a workd registers — the substrate answering is not a \
         host joining"
    );
    assert_eq!(provision["instanceKnown"], json!(true));
    assert_eq!(provision["replayed"], json!(false));
    assert!(provision.get("bootstrapToken").is_none());
    assert!(provision["registerUrl"]
        .as_str()
        .is_some_and(|url| url.starts_with("https://provisioner.momo.invalid/v1/workspaces/")));

    // The substrate really made one instance, and the ledger names it.
    let sandbox = fake.only_sandbox();
    let stored_sandbox_id: String =
        sqlx::query_scalar("SELECT provider_sandbox_id FROM work_cloud_host WHERE id = $1::uuid")
            .bind(provision_id)
            .fetch_one(&su)
            .await
            .expect("stored sandbox id");
    assert_eq!(
        stored_sandbox_id, sandbox.id,
        "the ledger must name the instance the substrate actually made, or nothing can pause, \
         probe or destroy it"
    );

    // ADR-0004: the operator credential reached the substrate as a header and
    // nowhere else — not into the sandbox, not into PostgreSQL.
    for (name, value) in &sandbox.env_vars {
        assert!(
            !value.contains(OPERATOR_KEY),
            "named regression: the provider credential reached the sandbox through {name}"
        );
    }
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_cloud_host \
          WHERE workspace_id = $1 \
            AND (provider_sandbox_id LIKE '%' || $2 || '%' \
                 OR bootstrap_token_digest LIKE '%' || $2 || '%' \
                 OR requested_display_name LIKE '%' || $2 || '%')",
    )
    .bind(workspace)
    .bind(OPERATOR_KEY)
    .fetch_one(&su)
    .await
    .expect("scan for the operator credential");
    assert_eq!(leaked, 0, "invariant #7: no part of the key reaches PG");

    // Only the DIGEST of the bootstrap token is stored.
    let baked_token = fake.baked_registration_token(&sandbox);
    let stored_digest: String = sqlx::query_scalar(
        "SELECT bootstrap_token_digest FROM work_cloud_host WHERE id = $1::uuid",
    )
    .bind(provision_id)
    .fetch_one(&su)
    .await
    .expect("stored digest");
    assert_ne!(
        stored_digest, baked_token,
        "the raw bootstrap token must never be persisted"
    );
    assert_eq!(stored_digest.len(), 64);

    // ---- the workd inside the instance spends the token it was given ------
    let (signing_seed, public_key) = workd_keypair();
    let (status, registered) = client.register(&baked_token, &public_key).await;
    assert_eq!(
        status, 201,
        "the token the substrate baked must be the one the ledger honours: {registered}"
    );
    let host_id = registered["workHost"]["id"]
        .as_str()
        .expect("workHost.id")
        .to_string();
    assert_eq!(registered["workHost"]["type"], json!("cloud"));
    assert_eq!(
        registered["workHost"]["ownerMemberId"],
        json!(fixture.member.to_string()),
        "the host is attributed to the member whose policy acquired it"
    );

    // The provider handle was recorded before registration, so binding lifts the
    // row straight to `ready`.
    let (state, bound_host): (String, Option<Uuid>) =
        sqlx::query_as("SELECT state, host_id FROM work_cloud_host WHERE id = $1::uuid")
            .bind(provision_id)
            .fetch_one(&su)
            .await
            .expect("cloud host row");
    assert_eq!(state, "ready");
    assert_eq!(bound_host.map(|id| id.to_string()), Some(host_id.clone()));

    // A one-shot token is one-shot even when it is derivable.
    let (replay_status, _) = client.register(&baked_token, &public_key).await;
    assert_eq!(
        replay_status, 401,
        "a derived token is still consumed on first use — determinism is about the *retry of the \
         create*, never about the spend"
    );

    // ---- the workd reports in, and the session opens (existing routing) ---
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let host_uuid = Uuid::parse_str(&host_id).expect("host uuid");
    let signature = momo_wire::signing::sign_base64(
        &signing_seed,
        &momo_wire::signing::heartbeat_payload(workspace, host_uuid, sent_at_ms),
    )
    .expect("sign heartbeat");
    let response = client
        .http
        .post(format!(
            "{}/v1/workspaces/{workspace}/work-hosts/{host_id}/heartbeat",
            client.base
        ))
        .json(&json!({"sentAtMs": sent_at_ms, "signature": signature}))
        .send()
        .await
        .expect("heartbeat");
    assert_eq!(response.status(), 200);

    let response = client
        .http
        .post(format!(
            "{}/v1/workspaces/{workspace}/work-sessions",
            client.base
        ))
        .bearer_auth(&client.token)
        .json(&json!({
            "channelId": fixture.channel.to_string(),
            "hostId": host_id,
            "tool": "claude",
            "label": "managed provisioning run",
        }))
        .send()
        .await
        .expect("create session");
    assert_eq!(
        response.status(),
        201,
        "session routing is unchanged: a registered cloud host takes a session like any other"
    );
    let created: Value = response.json().await.expect("session body");
    let session_id = created["workSession"]["id"].as_str().expect("session id");
    assert_eq!(created["workSession"]["status"], json!("running"));

    let (cloud_state, usage_started): (String, bool) = sqlx::query_as(
        "SELECT ch.state, \
                EXISTS(SELECT 1 FROM work_host_usage u \
                        WHERE u.session_id = $1::uuid AND u.settled_at IS NULL) \
           FROM work_cloud_host ch WHERE ch.id = $2::uuid",
    )
    .bind(session_id)
    .bind(provision_id)
    .fetch_one(&su)
    .await
    .expect("cloud state + usage");
    assert_eq!(cloud_state, "running");
    assert!(usage_started, "the T3 ledger opened with the session");

    // One request, one instance, one host — end to end.
    assert_eq!(fake.live_count(), 1);
    assert_eq!(provision_row_count(&su, workspace).await, 1);
    assert_eq!(cloud_host_count(&su, workspace).await, 1);
}

// ---------------------------------------------------------------------------
// RED PROOF ① — ADR-0136 D2: the bootstrap token is derived, not minted
// ---------------------------------------------------------------------------

/// The substrate made the instance and the response was lost.
///
/// **Red proof ①.** Two one-line injections turn this red, and both are the same
/// root cause — a bootstrap token momo cannot reproduce:
///
/// * make `CloudProvisioner::bootstrap_token` mint a random token
///   (`mint_bootstrap_token()`): the retry bakes a credential the ledger row's
///   digest does not match, `register` answers **401**, and the paid sandbox
///   bills without ever becoming a host;
/// * delete the replay branch in `cloud_hosts::provision`: unable to reuse a row
///   whose raw token it never kept, each attempt allocates a **new provision** —
///   two rows, two billable sandboxes and two registered cloud hosts for one
///   logical request. That is the double registration ADR-0136 D2 names.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_lost_create_response_yields_one_host_not_two() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    client.set_tier_policy("auto", Some("cloud")).await;

    // The substrate makes the sandbox and swallows the response.
    fake.lock().deliver_create_response = false;
    let idempotency_ref = Uuid::new_v4();
    let (status, body) = client.provision(idempotency_ref).await;
    assert_eq!(
        status, 503,
        "a create momo could not confirm is not a success: {body}"
    );
    assert_eq!(fake.live_count(), 1, "the sandbox is real and is billing");
    assert_eq!(
        provision_row_count(&su, workspace).await,
        1,
        "the durable row was committed before the provider call, which is what makes the retry \
         below a retry rather than a second acquisition"
    );
    let (state, sandbox_known): (String, bool) = sqlx::query_as(
        "SELECT state, provider_sandbox_id IS NOT NULL \
           FROM work_cloud_host WHERE workspace_id = $1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("provisioning row");
    assert_eq!(state, "provisioning");
    assert!(
        !sandbox_known,
        "momo must not claim a handle it never received"
    );

    // ---- the retry, same idempotencyRef ----------------------------------
    fake.lock().deliver_create_response = true;
    let (status, body) = client.provision(idempotency_ref).await;
    assert_eq!(status, 201, "the retry converges: {body}");

    // The counts come first, and the `replayed` flag second, on purpose: the
    // counts are what cost money, the flag is only a report about them. An
    // implementation that lost the ability to reuse the row would trip the flag
    // assertion too, and the failure a reader should see first is the one with a
    // bill attached.
    assert_eq!(
        fake.live_count(),
        1,
        "named regression: the retry must adopt the orphan the lost response left behind, not \
         make a second billable instance"
    );
    assert_eq!(
        fake.create_count(),
        1,
        "only the first POST ever created anything — the second create was answered by the \
         metadata reconstruction"
    );
    assert_eq!(
        provision_row_count(&su, workspace).await,
        1,
        "named regression: one logical request, one provision. A second row here means the retry \
         could not reuse the first — which is what happens the moment the bootstrap token stops \
         being derivable, since momo kept only its digest (ADR-0136 D2)"
    );
    assert_eq!(
        body["provision"]["replayed"],
        json!(true),
        "a repeated idempotencyRef is a replay, not a second acquisition"
    );

    // ---- and the token the FIRST attempt baked still works ---------------
    let sandbox = fake.only_sandbox();
    let baked_token = fake.baked_registration_token(&sandbox);
    let (_, public_key) = workd_keypair();
    let (status, registered) = client.register(&baked_token, &public_key).await;
    assert_eq!(
        status, 201,
        "named regression: momo stores only the token's DIGEST and a sandbox's environment is \
         baked at create time, so a credential minted on the retry could never match the ledger \
         row. The instance would bill forever and never register. ADR-0136 D2 requires the token \
         to be DERIVED from the provision id: {registered}"
    );
    assert_eq!(
        cloud_host_count(&su, workspace).await,
        1,
        "named regression: one logical request, one registered host. Two here is the double \
         registration ADR-0136 D2 exists to prevent"
    );
}

// ---------------------------------------------------------------------------
// RED PROOF ② — the activation gate (ADR-0140 / MOMO_T3_ENABLED)
// ---------------------------------------------------------------------------

/// T3 is off, so the path is unreachable — and "unreachable" is measured at the
/// substrate, not at the status code.
///
/// **Red proof ②.** Delete the `ready_t3` call from `cloud_hosts::provision` and
/// the fake's request log stops being empty: an instance nobody activated has
/// created a paid sandbox. The 503 alone would not have caught it — a handler
/// could answer 503 *after* provisioning.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_disabled_t3_never_reaches_the_substrate() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    // Everything an operator could configure is configured — a live substrate, a
    // credit balance, a cloud policy — and the ONLY thing missing is the
    // activation flag. That is the deployment this assertion is about.
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), false).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    // Credit is seeded in SQL rather than through the top-up route because that
    // route is itself T3-gated: going through it would leave the *credit* check
    // as the thing that stopped the request, and this test would then pass even
    // with the activation gate deleted. Every other precondition is satisfied for
    // the same reason — the activation flag must be the only thing missing, or
    // the assertion below measures the wrong refusal.
    sqlx::query("UPDATE workspace_credit SET balance_micro_usd = $2 WHERE workspace_id = $1")
        .bind(workspace)
        .bind(TOPUP_MICRO_USD)
        .execute(&su)
        .await
        .expect("seed a positive balance");
    client.set_tier_policy("auto", Some("cloud")).await;

    let (status, body) = client.provision(Uuid::new_v4()).await;
    // The substrate and the ledger are checked before the status code, and the
    // order is the point: a handler could answer 503 *after* creating a paid
    // sandbox, and the status alone would never say so.
    assert_eq!(
        fake.request_count(),
        0,
        "named regression: an unactivated instance must not reach the substrate at all. Response \
         body was: {body}"
    );
    assert_eq!(
        provision_row_count(&su, workspace).await,
        0,
        "named regression: no durable billable row may exist on an instance T3 was never enabled \
         on"
    );
    assert_eq!(
        status, 503,
        "oort Cloud(T3) is default-off and every T3 surface says so: {body}"
    );

    // The registration surface is shut for the same reason, so a workd that
    // somehow existed could not join either.
    let (_, public_key) = workd_keypair();
    let (status, _) = client.register(&"a".repeat(64), &public_key).await;
    assert_eq!(status, 503);
}

// ---------------------------------------------------------------------------
// the failure halves
// ---------------------------------------------------------------------------

/// A substrate that refuses the create: a named failure, a slot still held, and
/// a row the next retry can finish.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_refused_create_is_a_named_failure_the_retry_can_finish() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    client.set_tier_policy("auto", Some("cloud")).await;

    fake.lock().refuse_create_without_making = Some(503);
    let idempotency_ref = Uuid::new_v4();
    let (status, _) = client.provision(idempotency_ref).await;
    assert_eq!(status, 503, "a 5xx from the substrate is a 503 here");
    assert_eq!(
        fake.live_count(),
        0,
        "nothing was created, so nothing bills"
    );
    assert_eq!(
        provision_row_count(&su, workspace).await,
        1,
        "the durable row stays — it is the only thing that can name the instance a later attempt \
         might discover"
    );

    // The slot is still occupied: `provisioning` counts toward the ceiling, and
    // it must, because the instance may in fact exist.
    let occupied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_cloud_host \
          WHERE workspace_id = $1 AND state IN ('provisioning','ready','running','paused')",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("occupancy");
    assert_eq!(occupied, 1);

    // The same ref, once the substrate recovers, finishes the same row.
    fake.lock().refuse_create_without_making = None;
    let (status, body) = client.provision(idempotency_ref).await;
    assert_eq!(
        status, 201,
        "the retry finishes what the first attempt began"
    );
    assert_eq!(body["provision"]["replayed"], json!(true));
    assert_eq!(body["provision"]["instanceKnown"], json!(true));
    assert_eq!(provision_row_count(&su, workspace).await, 1);
    assert_eq!(fake.live_count(), 1);
}

/// A bootstrap token whose 15-minute TTL ran out cannot register, and the ledger
/// says so by leaving the row exactly where it was.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_expired_bootstrap_token_registers_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    client.set_tier_policy("auto", Some("cloud")).await;
    let (status, body) = client.provision(Uuid::new_v4()).await;
    assert_eq!(status, 201);
    let provision_id = body["provision"]["provisionId"]
        .as_str()
        .expect("provisionId")
        .to_string();

    // Wind the clock past ADR-0136's 15-minute window. Done in SQL because the
    // TTL is enforced in SQL (`claim_bootstrap_in_tx`'s WHERE clause) — moving it
    // here rather than in Rust is what keeps the test honest about where the
    // rule lives.
    sqlx::query(
        "UPDATE work_cloud_host \
            SET bootstrap_expires_at = clock_timestamp() - interval '1 second' \
          WHERE id = $1::uuid",
    )
    .bind(&provision_id)
    .execute(&su)
    .await
    .expect("expire the bootstrap window");

    let baked_token = fake.baked_registration_token(&fake.only_sandbox());
    let (_, public_key) = workd_keypair();
    let (status, _) = client.register(&baked_token, &public_key).await;
    assert_eq!(
        status, 401,
        "an expired one-shot credential is indistinguishable from an invalid one, on purpose"
    );

    let (state, host_id, consumed): (String, Option<Uuid>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT state, host_id, bootstrap_consumed_at FROM work_cloud_host WHERE id = $1::uuid",
        )
        .bind(&provision_id)
        .fetch_one(&su)
        .await
        .expect("provision row");
    assert_eq!(
        state, "provisioning",
        "a refused registration changes nothing"
    );
    assert_eq!(host_id, None);
    assert_eq!(consumed, None);
    assert_eq!(cloud_host_count(&su, workspace).await, 0);
}

/// A provision nobody registers: what the ledger holds, stated rather than
/// assumed.
///
/// The row stays `provisioning`, holds its slot, and opens **no** usage — which
/// is correct: the instance exists and may be billing at the substrate, but momo
/// bills active *session* time and there is no session. The absence of a
/// `work_host` row is what keeps it out of every selector.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_unregistered_provision_holds_its_slot_and_bills_no_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, _fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    client.set_tier_policy("auto", Some("cloud")).await;
    let (status, _) = client.provision(Uuid::new_v4()).await;
    assert_eq!(status, 201);

    let (state, usage_rows, host_rows): (String, i64, i64) = sqlx::query_as(
        "SELECT ch.state, \
                (SELECT count(*) FROM work_host_usage u WHERE u.workspace_id = $1), \
                (SELECT count(*) FROM work_host h WHERE h.workspace_id = $1) \
           FROM work_cloud_host ch WHERE ch.workspace_id = $1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("ledger state");
    assert_eq!(state, "provisioning");
    assert_eq!(
        usage_rows, 0,
        "no session, no usage row — acquiring a host is not a billable interval (ADR-0140 D3)"
    );
    assert_eq!(
        host_rows, 0,
        "an unregistered provision is in no selector: there is no work_host to target"
    );
}

// ---------------------------------------------------------------------------
// the policy gate and the capability gate
// ---------------------------------------------------------------------------

/// The tier policy decides, and both refusals are named.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_policy_that_excludes_cloud_acquires_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (cube_url, fake) = spawn_fake_cube().await;
    let base = start_server(app_pool, &fixture.email, Some(&cube_url), true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;

    let pinned_host = client.register_local_host().await;

    client.set_tier_policy("t1_only", None).await;
    let (status, _) = client.provision(Uuid::new_v4()).await;
    assert_eq!(status, 409, "t1_only means no paid host, ever");

    client.set_tier_policy("auto", Some(&pinned_host)).await;
    let (status, _) = client.provision(Uuid::new_v4()).await;
    assert_eq!(
        status, 409,
        "a policy pinned to one host does not silently acquire a different one"
    );

    assert_eq!(
        fake.request_count(),
        0,
        "named regression: the policy gate runs before the provider call, so a refused request \
         costs nothing"
    );
    assert_eq!(provision_row_count(&su, workspace).await, 0);
}

/// An instance that named a managed provider but configured no endpoint refuses
/// the acquisition — and keeps serving everything else.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_unconfigured_provisioner_refuses_instead_of_guessing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    // T3 on, provider named, NO provisioner attached — the half-configured
    // instance ADR-0142 D4 is about.
    let base = start_server(app_pool, &fixture.email, None, true).await;
    let client = Client::login(base, fixture.workspace, &fixture.email).await;
    let workspace = fixture.workspace;

    client.topup().await;
    client.set_tier_policy("auto", Some("cloud")).await;

    let (status, _) = client.provision(Uuid::new_v4()).await;
    assert_eq!(
        status, 503,
        "named regression: a managed provider with no endpoint must refuse, never fall back to \
         something that can create billable instances (ADR-0142 D4)"
    );
    assert_eq!(provision_row_count(&su, workspace).await, 0);

    // …and the rest of the T3 surface is untouched: BYOC still enrolls.
    let response = client
        .http
        .post(format!(
            "{}/v1/workspaces/{workspace}/work-hosts/byoc/enrollments",
            client.base
        ))
        .bearer_auth(&client.token)
        .json(&json!({
            "displayName": "owner box",
            "scope": "workspace",
            "idempotencyRef": Uuid::new_v4().to_string(),
        }))
        .send()
        .await
        .expect("enroll");
    assert_eq!(
        response.status(),
        201,
        "the acquisition verb this instance cannot perform is the only one it refuses"
    );
}
