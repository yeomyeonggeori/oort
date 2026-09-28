//! DB-backed conformance for **#3027** (R2-E7): the owner's signed
//! instruction route and the signed resume (ADR-0146 개정 2026-09-28 D-5b ·
//! D-8 · D-10, ADR-0188 D3 · D4), against the real router on an isolated PG
//! as `momo_app` (NOBYPASSRLS).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `flag_off_refuses_by_name_and_writes_nothing` | open the route without `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` |
//! | `a_signed_instruction_is_a_control_and_a_thread_message_in_one_tx` | drop the thread message, its `client_msg_id`/root/props, the outbox row, the signature columns, the provenance row, the dispatch or the audit row |
//! | `a_retry_answers_the_same_and_a_reused_nonce_is_refused` | drop the pre-verify lookup (a retry becomes 409 `device_nonce_replayed`) or answer a different instruction as a retry |
//! | `offline_and_closed_are_refused_before_the_nonce_is_spent` | check the host or the session after the signature (the nonce burns; the resend is 409) |
//! | `only_the_owner_instructs` | drop the session-owner or host-owner check |
//! | `every_misplaced_signature_is_refused_and_v1_input_still_verifies` | rebuild from the request instead of the session/host/text/mode, or refuse the v1 `input` the phone signs today |
//! | `a_signed_resume_runs_under_the_session_the_owner_named` | allocate the successor id on the server, drop the tool/channel binding, or keep the E3 blanket 403 |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26775/momo \
//!   cargo test -p momo-server --test work_instruction_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use momo_wire::human_control::{ControlContent, DeviceEndorse, DeviceKeyAlg, HumanControl};
use momo_wire::human_control::{ControlSchema, InputMode};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "work-instruction-conformance-signing-secret";
const TEST_PASSWORD: &str = "human-control-password";
const INSTANCE_ID: &str = "inst_3027_conformance";
const HOST_SEED: u8 = 71;

// ---------------------------------------------------------------------------
// harness (same shape as device_key_conformance_pg.rs)
// ---------------------------------------------------------------------------

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
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

fn psql_file(path: PathBuf) -> std::process::Output {
    Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .output()
        .expect("spawn psql")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = psql_file(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    )));
    assert!(
        roles.status.success(),
        "bootstrap_roles.sql failed to apply"
    );
    *ready = true;
}

fn settings(required: bool) -> DeviceKeySettings {
    DeviceKeySettings {
        instance_id: Some(INSTANCE_ID.to_string()),
        host_register_signature_required: false,
        refresh_reuse_sweep_all_sessions: false,
        human_control_signature_required: required,
    }
}

async fn start_server(settings: DeviceKeySettings) -> String {
    let app = build_app(
        AppState::new(
            momo_app_pool().await,
            TEST_JWT_SECRET.to_string(),
            RealtimeAdvert::SameOrigin,
        )
        .with_device_keys(settings),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn code(body: &Value) -> Option<&str> {
    body["error"]["code"].as_str().or(body["code"].as_str())
}

/// A software stand-in for a device's Secure Enclave key.
struct DeviceKeyPair {
    signing: SigningKey,
    public_b64: String,
}

impl DeviceKeyPair {
    fn new(label: &str) -> DeviceKeyPair {
        let seed = Sha256::digest(format!("#3023 {label} {}", Uuid::new_v4()).as_bytes());
        let signing = SigningKey::from_slice(&seed).expect("a SHA-256 is a valid scalar here");
        let point = signing.verifying_key().to_sec1_point(true);
        DeviceKeyPair {
            public_b64: BASE64.encode(point.as_bytes()),
            signing,
        }
    }

    fn sign(&self, bytes: &[u8]) -> String {
        let signature: Signature = self.signing.sign(bytes);
        BASE64.encode(signature.to_bytes())
    }
}

fn ed25519_host_key(seed: u8) -> String {
    let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    BASE64.encode(key.verifying_key().to_bytes())
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Stage {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    person: Uuid,
    access: String,
    other_access: String,
    channel: Uuid,
    host: Uuid,
    root: DeviceKeyPair,
    root_id: Uuid,
    phone: DeviceKeyPair,
    phone_id: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("hc-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@human-control.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (id, email)
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": TEST_PASSWORD, "workspace": workspace.to_string() }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"].as_str().expect("access").to_string()
}

impl Stage {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        bearer: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(bearer);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, bearer: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, bearer, Some(body))
            .await
    }

    fn keys_path(&self) -> String {
        format!("/v1/workspaces/{}/device-keys", self.workspace)
    }

    /// A host-signed request exactly as workd sends it (v2).
    async fn host_request(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let raw = body
            .as_ref()
            .map(|body| serde_json::to_vec(body).expect("json"))
            .unwrap_or_default();
        let sent_at_ms = now_ms();
        let request_id = Uuid::new_v4();
        let payload = momo_wire::signing::request_payload(
            method,
            path,
            self.workspace,
            self.host,
            sent_at_ms,
            &momo_wire::signing::sha256_hex(&raw),
            request_id,
        );
        let signature = momo_wire::signing::sign_base64(&[HOST_SEED; 32], &payload).expect("sign");
        let mut request = self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}{path}", self.base),
            )
            .header("Authorization", format!("MomoHost {}", self.host))
            .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
            .header("X-Momo-Work-Host-Signature", signature)
            .header("X-Momo-Work-Host-Request-ID", request_id.to_string());
        if body.is_some() {
            request = request.header("content-type", "application/json").body(raw);
        }
        let response = request.send().await.expect("host request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn poll(&self) -> Value {
        let (status, body) = self
            .host_request(
                "GET",
                &format!(
                    "/v1/workspaces/{}/work-hosts/{}/pending-controls",
                    self.workspace, self.host
                ),
                None,
            )
            .await;
        assert_eq!(status, 200, "the host polls its own queue: {body}");
        body
    }

    /// A running session on the member host, owned by the person.
    async fn session(&self) -> Uuid {
        let (status, body) = self
            .post(
                &format!("/v1/workspaces/{}/work-sessions", self.workspace),
                &self.access,
                json!({ "channelId": self.channel, "hostId": self.host,
                        "tool": "claude", "label": "r2 session" }),
            )
            .await;
        assert_eq!(status, 201, "the owner opens a session: {body}");
        Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).unwrap()
    }
}

async fn stage(required: bool) -> Stage {
    stage_with(settings(required)).await
}

async fn stage_with(config: DeviceKeySettings) -> Stage {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("hc-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let (person, person_email) = seed_human(&su, workspace, "member").await;
    let (_other, other_email) = seed_human(&su, workspace, "member").await;
    let channel = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("hc-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: person,
        },
    )
    .await
    .expect("create channel")
    .id;
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, 'claude', 'claude', $2, true, $3, $3) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
    )
    .bind(workspace)
    .bind(json!({"command": "never-run", "arguments": []}))
    .bind(person)
    .execute(&su)
    .await
    .expect("seed work tool profile");

    let base = start_server(config).await;
    let http = reqwest::Client::new();
    let access = login(&http, &base, workspace, &person_email).await;
    let other_access = login(&http, &base, workspace, &other_email).await;
    let mut stage = Stage {
        su,
        http,
        base,
        workspace,
        person,
        access,
        other_access,
        channel,
        host: Uuid::nil(),
        root: DeviceKeyPair::new("mac"),
        root_id: Uuid::nil(),
        phone: DeviceKeyPair::new("phone"),
        phone_id: Uuid::nil(),
    };

    // The member host (unsigned registration: the host_register flag is off).
    let (status, body) = stage
        .post(
            &format!("/v1/workspaces/{workspace}/work-hosts"),
            &stage.access,
            json!({ "scope": "member", "type": "workd", "displayName": "맥",
                    "publicKey": ed25519_host_key(HOST_SEED) }),
        )
        .await;
    assert_eq!(status, 201, "register the member host: {body}");
    stage.host = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();

    // Root (macos, password) and an endorsed phone.
    let (status, body) = stage
        .post(
            &stage.keys_path(),
            &stage.access,
            json!({ "alg": "p256", "publicKey": stage.root.public_b64, "platform": "macos",
                    "label": "맥", "currentPassword": TEST_PASSWORD }),
        )
        .await;
    assert_eq!(status, 201, "register root: {body}");
    stage.root_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    let (status, body) = stage
        .post(
            &stage.keys_path(),
            &stage.access,
            json!({ "alg": "p256", "publicKey": stage.phone.public_b64, "platform": "ios",
                    "label": "폰" }),
        )
        .await;
    assert_eq!(status, 201, "register phone: {body}");
    stage.phone_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    let letter = stage.root.sign(
        &DeviceEndorse {
            workspace_id: workspace,
            member_id: person,
            root_key_id: stage.root_id,
            target_alg: DeviceKeyAlg::P256,
            target_public_key_b64: &stage.phone.public_b64,
            label: "폰",
        }
        .signed_bytes()
        .expect("endorse bytes"),
    );
    let (status, body) = stage
        .post(
            &format!("{}/{}/endorsement", stage.keys_path(), stage.phone_id),
            &stage.access,
            json!({ "rootKeyId": stage.root_id, "signature": letter }),
        )
        .await;
    assert_eq!(status, 200, "endorse phone: {body}");
    stage
}

// ---------------------------------------------------------------------------
// #3027 helpers
// ---------------------------------------------------------------------------

/// A signed `input` statement's envelope, in `schema`.
#[allow(clippy::too_many_arguments)]
fn instruction_signature(
    s: &Stage,
    key: &DeviceKeyPair,
    key_id: Uuid,
    session: Uuid,
    text: &str,
    mode: InputMode,
    nonce: Uuid,
    schema: ControlSchema,
) -> Value {
    let issued = now_ms();
    let bytes = HumanControl {
        instance_id: INSTANCE_ID,
        workspace_id: s.workspace,
        member_id: s.person,
        device_key_id: key_id,
        host_id: s.host,
        session_id: Some(session),
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 5 * 60_000,
        content: ControlContent::Input { mode, text },
    }
    .signed_bytes_as(schema)
    .expect("input bytes");
    json!({
        "deviceKeyId": key_id, "nonce": nonce, "issuedAtMs": issued,
        "expiresAtMs": issued + 5 * 60_000, "mode": mode.as_str(),
        "signature": key.sign(&bytes),
    })
}

fn instruction_body(text: &str, mode: InputMode, nonce: Uuid, signature: Value) -> Value {
    json!({ "text": text, "mode": mode.as_str(), "clientMsgId": nonce, "humanSignature": signature })
}

impl Stage {
    fn instructions_path(&self, session: Uuid) -> String {
        format!(
            "/v1/workspaces/{}/work-sessions/{session}/instructions",
            self.workspace
        )
    }

    /// The phone signs `text` for `session` (v2) and the owner sends it.
    async fn instruct(&self, session: Uuid, text: &str, mode: InputMode) -> (u16, Value, Uuid) {
        let nonce = Uuid::new_v4();
        let signature = instruction_signature(
            self,
            &self.phone,
            self.phone_id,
            session,
            text,
            mode,
            nonce,
            ControlSchema::V2,
        );
        let (status, body) = self
            .post(
                &self.instructions_path(session),
                &self.access,
                instruction_body(text, mode, nonce, signature),
            )
            .await;
        (status, body, nonce)
    }

    /// The heartbeat's own column, stamped (the host is online for 90 s).
    async fn host_online(&self, online: bool) {
        sqlx::query(
            "UPDATE work_host SET last_seen_at = CASE WHEN $2 THEN clock_timestamp() \
                                               ELSE clock_timestamp() - interval '1 hour' END \
              WHERE id = $1",
        )
        .bind(self.host)
        .bind(online)
        .execute(&self.su)
        .await
        .expect("stamp last_seen_at");
    }

    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect(sql)
    }

    async fn input_controls(&self) -> i64 {
        self.count("SELECT count(*) FROM work_control WHERE workspace_id = $1 AND kind = 'input'")
            .await
    }

    async fn spent_nonces(&self) -> i64 {
        self.count("SELECT count(*) FROM human_control_nonce WHERE workspace_id = $1")
            .await
    }
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn flag_off_refuses_by_name_and_writes_nothing() {
    let _lock = test_lock().await;
    let s = stage(false).await;
    let session = s.session().await;
    s.host_online(true).await;
    let (status, body, _) = s
        .instruct(session, "테스트 돌려 줘", InputMode::Queue)
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("signed_instructions_disabled"));
    assert_eq!(s.input_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_instruction_is_a_control_and_a_thread_message_in_one_tx() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    s.host_online(true).await;
    let (status, body, nonce) = s
        .instruct(session, "테스트 돌려 줘", InputMode::Queue)
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["replayed"], false);
    assert_eq!(body["workControl"]["kind"], "input");
    assert_eq!(body["workControl"]["status"], "dispatched");
    assert_eq!(
        body["workControl"]["payload"],
        json!({"text": "테스트 돌려 줘"})
    );
    assert_eq!(body["message"]["clientMsgId"], json!(nonce.to_string()));
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let message = Uuid::parse_str(body["message"]["id"].as_str().unwrap()).unwrap();

    // The control carries the verified statement.
    let (mode, human_nonce, key): (Option<String>, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT human_mode, human_nonce, device_key_id FROM work_control WHERE id = $1",
    )
    .bind(control)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(
        (mode.as_deref(), human_nonce, key),
        (Some("queue"), Some(nonce), Some(s.phone_id))
    );
    // The thread message: the session root, the nonce as client_msg_id, the
    // server-owned props, the owner as author.
    let (root, client_msg_id, author, props, text): (
        Option<Uuid>,
        Option<Uuid>,
        Uuid,
        Value,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT root_id, client_msg_id, author_member_id, props, body FROM message WHERE id = $1",
    )
    .bind(message)
    .fetch_one(&s.su)
    .await
    .unwrap();
    let session_root: Uuid =
        sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
            .bind(session)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(root, Some(session_root));
    assert_eq!(client_msg_id, Some(nonce));
    assert_eq!(author, s.person);
    assert_eq!(text.as_deref(), Some("테스트 돌려 줘"));
    assert_eq!(
        props["momo.instruction"]["control_id"],
        json!(control.to_string())
    );
    assert_eq!(props["momo.instruction"]["mode"], "queue");
    // Its broadcast rides the outbox (the relay publishes it; nobody else).
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(s.workspace)
    .bind(message.to_string())
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(outbox >= 1, "the message broadcast is in the outbox");
    // Provenance and audit, same commit.
    let provenance: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM action_signature \
          WHERE workspace_id = $1 AND entity_type = 'work_control' AND entity_id = $2 AND alg = 'p256'",
    )
    .bind(s.workspace)
    .bind(control)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(provenance, 1);
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'work.instruction.sent' \
            AND target_id = $2",
    )
    .bind(s.workspace)
    .bind(control)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(audit.to_string().contains(&message.to_string()), "{audit}");

    // The host's poll carries the envelope workd verifies, mode included.
    let poll = s.poll().await;
    let relayed = poll["workControls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == json!(control.to_string()))
        .cloned()
        .expect("the instruction is dispatched to the host");
    assert_eq!(relayed["humanSignature"]["mode"], "queue");
    assert_eq!(relayed["humanSignature"]["nonce"], json!(nonce.to_string()));
    assert!(
        relayed["humanSignature"]["endorsement"].is_object(),
        "a phone key carries its letter"
    );

    // interrupt: the signed mode travels to the host.
    let (status, body, _) = s
        .instruct(session, "멈추고 이것부터", InputMode::Interrupt)
        .await;
    assert_eq!(status, 201, "{body}");
    let control = body["workControl"]["id"].clone();
    let poll = s.poll().await;
    let relayed = poll["workControls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == control)
        .cloned()
        .unwrap();
    assert_eq!(relayed["humanSignature"]["mode"], "interrupt");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_retry_answers_the_same_and_a_reused_nonce_is_refused() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    s.host_online(true).await;
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "한 번만",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let body = instruction_body("한 번만", InputMode::Queue, nonce, signature);
    let (status, first) = s
        .post(&s.instructions_path(session), &s.access, body.clone())
        .await;
    assert_eq!(status, 201, "{first}");
    // The session ended and the Mac fell asleep since: a retry of the
    // accepted instruction is still the same answer.
    sqlx::query("UPDATE work_session SET status = 'ended', ended_at = now() WHERE id = $1")
        .bind(session)
        .execute(&s.su)
        .await
        .unwrap();
    s.host_online(false).await;
    let (status, again) = s.post(&s.instructions_path(session), &s.access, body).await;
    assert_eq!(status, 200, "a retry is not a replay: {again}");
    assert_eq!(again["replayed"], true);
    assert_eq!(again["workControl"]["id"], first["workControl"]["id"]);
    assert_eq!(again["message"]["id"], first["message"]["id"]);
    assert_eq!(s.input_controls().await, 1);
    let messages: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND client_msg_id = $2",
    )
    .bind(s.workspace)
    .bind(nonce)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(messages, 1);

    // The same nonce under a genuinely signed, different instruction.
    s.host_online(true).await;
    let other = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "다른 지시",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let (status, body) = s
        .post(
            &s.instructions_path(session),
            &s.access,
            instruction_body("다른 지시", InputMode::Queue, nonce, other),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("instruction_nonce_reused"));
    assert_eq!(s.input_controls().await, 1);

    // A nonce the owner already used as a chat message's clientMsgId would
    // fold the instruction into that old row: refused before it is spent.
    let live = s.session().await;
    let chat_nonce = Uuid::new_v4();
    let (status, body) = s
        .post(
            &format!(
                "/v1/workspaces/{}/channels/{}/messages",
                s.workspace, s.channel
            ),
            &s.access,
            json!({ "clientMsgId": chat_nonce, "body": "그냥 채팅" }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let spent = s.spent_nonces().await;
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        live,
        "채팅과 같은 키",
        InputMode::Queue,
        chat_nonce,
        ControlSchema::V2,
    );
    let (status, body) = s
        .post(
            &s.instructions_path(live),
            &s.access,
            instruction_body("채팅과 같은 키", InputMode::Queue, chat_nonce, signature),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (409, Some("instruction_nonce_reused")),
        "{body}"
    );
    assert_eq!(
        s.spent_nonces().await,
        spent,
        "refused before the nonce is spent"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn offline_and_closed_are_refused_before_the_nonce_is_spent() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "맥이 깨면",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let body = instruction_body("맥이 깨면", InputMode::Queue, nonce, signature);

    s.host_online(false).await;
    let (status, refused) = s
        .post(&s.instructions_path(session), &s.access, body.clone())
        .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(code(&refused), Some("work_host_offline"));
    assert_eq!(
        s.spent_nonces().await,
        0,
        "the nonce is not spent on an offline host"
    );

    // The Mac is back: the very same signed instruction goes through.
    s.host_online(true).await;
    let (status, sent) = s.post(&s.instructions_path(session), &s.access, body).await;
    assert_eq!(status, 201, "{sent}");
    assert_eq!(s.spent_nonces().await, 1);

    // An ended session and a revoked host are refused by name too.
    let ended = s.session().await;
    sqlx::query("UPDATE work_session SET status = 'ended', ended_at = now() WHERE id = $1")
        .bind(ended)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body, _) = s.instruct(ended, "끝난 세션", InputMode::Queue).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("work_session_not_accepting"));
    sqlx::query("UPDATE work_host SET revoked_at = now() WHERE id = $1")
        .bind(s.host)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body, _) = s.instruct(session, "폐기된 맥", InputMode::Queue).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("work_host_revoked"));
    assert_eq!(s.spent_nonces().await, 1, "no refusal spent a nonce");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_owner_instructs() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    s.host_online(true).await;
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "남의 세션",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let (status, body) = s
        .post(
            &s.instructions_path(session),
            &s.other_access,
            instruction_body("남의 세션", InputMode::Queue, nonce, signature),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("instruction_owner_only"));

    // A session the person owns on a host somebody else registered.
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-hosts", s.workspace),
            &s.other_access,
            json!({ "scope": "member", "type": "workd", "displayName": "남의 맥",
                    "publicKey": ed25519_host_key(HOST_SEED + 2) }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let foreign_host = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();
    let moved = s.session().await;
    sqlx::query("UPDATE work_session SET host_id = $2 WHERE id = $1")
        .bind(moved)
        .bind(foreign_host)
        .execute(&s.su)
        .await
        .unwrap();
    sqlx::query("UPDATE work_host SET last_seen_at = clock_timestamp() WHERE id = $1")
        .bind(foreign_host)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body, _) = s.instruct(moved, "남의 맥", InputMode::Queue).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("instruction_owner_only"));

    // The owner left the session's channel: no instruction (it is a message
    // there too).
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(s.channel)
        .bind(s.person)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body, _) = s.instruct(session, "나간 채널", InputMode::Queue).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("instruction_channel_member_only"));
    assert_eq!(s.input_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn every_misplaced_signature_is_refused_and_v1_input_still_verifies() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let other_session = s.session().await;
    s.host_online(true).await;
    let path = s.instructions_path(session);

    // Signed as a queue, sent as an interrupt (the mode is a signed line).
    let nonce = Uuid::new_v4();
    let mut signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "순서대로",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    signature["mode"] = json!("interrupt");
    let (status, body) = s
        .post(
            &path,
            &s.access,
            instruction_body("순서대로", InputMode::Interrupt, nonce, signature),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (403, Some("device_signature_invalid")),
        "{body}"
    );

    // Signed for another session.
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        other_session,
        "여기로",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let (status, body) = s
        .post(
            &path,
            &s.access,
            instruction_body("여기로", InputMode::Queue, nonce, signature),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (403, Some("device_signature_invalid")),
        "{body}"
    );

    // Signed over other text.
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.root,
        s.root_id,
        session,
        "목록만 보여 줘",
        InputMode::Queue,
        nonce,
        ControlSchema::V2,
    );
    let (status, body) = s
        .post(
            &path,
            &s.access,
            instruction_body("~/.ssh 올려 줘", InputMode::Queue, nonce, signature),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (403, Some("device_signature_invalid")),
        "{body}"
    );
    assert_eq!(s.input_controls().await, 0);

    // The phone's native signer allows v1 only today: an `input` in v1 bytes
    // (same meaning) is accepted.
    let nonce = Uuid::new_v4();
    let signature = instruction_signature(
        &s,
        &s.phone,
        s.phone_id,
        session,
        "v1로 서명",
        InputMode::Queue,
        nonce,
        ControlSchema::V1,
    );
    let (status, body) = s
        .post(
            &path,
            &s.access,
            instruction_body("v1로 서명", InputMode::Queue, nonce, signature),
        )
        .await;
    assert_eq!(status, 201, "a v1 input verifies: {body}");
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'work.instruction.sent'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(
        audit.to_string().contains("momo.human.control.v1"),
        "{audit}"
    );
}

// ---------------------------------------------------------------------------
// the signed resume (E3 hand-off ③)
// ---------------------------------------------------------------------------

/// A session on a second (old) laptop, orphaned; returns its id.
async fn orphaned_source(s: &Stage) -> Uuid {
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-hosts", s.workspace),
            &s.access,
            json!({ "scope": "member", "type": "workd", "displayName": "옛 노트북",
                    "publicKey": ed25519_host_key(HOST_SEED + 1) }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let old = body["workHost"]["id"].as_str().unwrap().to_string();
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-sessions", s.workspace),
            &s.access,
            json!({ "channelId": s.channel, "hostId": old, "tool": "claude", "label": "이어서 할 일" }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let source = Uuid::parse_str(body["workSession"]["id"].as_str().unwrap()).unwrap();
    sqlx::query(
        "UPDATE work_session SET status = 'orphaned', idle_at = NULL, host_lost_at = NULL WHERE id = $1",
    )
    .bind(source)
    .execute(&s.su)
    .await
    .unwrap();
    source
}

fn resume_signature(s: &Stage, successor: Uuid, tool: &str, channel: Uuid, nonce: Uuid) -> Value {
    let issued = now_ms();
    let agent = Uuid::from_u128(0x3027_a9e7);
    let bytes = HumanControl {
        instance_id: INSTANCE_ID,
        workspace_id: s.workspace,
        member_id: s.person,
        device_key_id: s.root_id,
        host_id: s.host,
        session_id: Some(successor),
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 5 * 60_000,
        content: ControlContent::Spawn {
            agent_member_id: agent,
            folder_id: "folder-1",
            tool,
            channel_id: channel,
            first_prompt: "이어서 할 일",
        },
    }
    .signed_bytes()
    .expect("spawn bytes");
    json!({
        "deviceKeyId": s.root_id, "nonce": nonce, "issuedAtMs": issued,
        "expiresAtMs": issued + 5 * 60_000, "agentMemberId": agent, "folderId": "folder-1",
        "signature": s.root.sign(&bytes),
    })
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_resume_runs_under_the_session_the_owner_named() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let source = orphaned_source(&s).await;
    let path = format!(
        "/v1/workspaces/{}/work-sessions/{source}/resume",
        s.workspace
    );

    // Half a signed resume is refused before anything.
    let (status, body) = s
        .post(
            &path,
            &s.access,
            json!({ "targetHostId": s.host, "sessionId": Uuid::new_v4() }),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (400, Some("resume_signature_incomplete")),
        "{body}"
    );

    // A signature over another tool, or another channel, does not verify.
    for (tool, channel) in [("codex", s.channel), ("claude", Uuid::new_v4())] {
        let successor = Uuid::new_v4();
        let (status, body) = s
            .post(
                &path,
                &s.access,
                json!({ "targetHostId": s.host, "sessionId": successor,
                        "humanSignature": resume_signature(&s, successor, tool, channel, Uuid::new_v4()) }),
            )
            .await;
        assert_eq!(
            (status, code(&body)),
            (403, Some("device_signature_invalid")),
            "{tool}: {body}"
        );
    }

    // The owner's signed resume: the successor is exactly the signed id.
    let successor = Uuid::new_v4();
    let (status, body) = s
        .post(
            &path,
            &s.access,
            json!({ "targetHostId": s.host, "sessionId": successor,
                    "humanSignature": resume_signature(&s, successor, "claude", s.channel, Uuid::new_v4()) }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["workSession"]["id"], json!(successor.to_string()));
    let (human_nonce, spawn_agent): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT human_nonce, human_spawn_agent_member_id FROM work_control \
          WHERE session_id = $1 AND kind = 'spawn'",
    )
    .bind(successor)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(human_nonce.is_some(), "the spawn carries the statement");
    assert_eq!(spawn_agent, Some(Uuid::from_u128(0x3027_a9e7)));
    let poll = s.poll().await;
    let spawn = poll["workControls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "spawn")
        .cloned()
        .expect("the signed resume is dispatched");
    assert_eq!(spawn["sessionId"], json!(successor.to_string()));
    assert!(spawn["humanSignature"].is_object());

    // A second resume naming a taken successor id is refused by name.
    let source = orphaned_source(&s).await;
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-sessions/{source}/resume", s.workspace),
            &s.access,
            json!({ "targetHostId": s.host, "sessionId": successor,
                    "humanSignature": resume_signature(&s, successor, "claude", s.channel, Uuid::new_v4()) }),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (409, Some("resume_session_id_taken")),
        "{body}"
    );
}
