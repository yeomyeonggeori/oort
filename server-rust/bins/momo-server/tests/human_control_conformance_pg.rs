//! #3023 — R2-E3: a person's signed control on the server (ADR-0146 개정
//! 2026-09-28 D-5 · D-8 · D-9 · D-10, migration 095).
//!
//! Every HTTP test drives the real routes on an ephemeral port against the real
//! schema, as the NOBYPASSRLS api role. The chokepoint tests call
//! `momo_auth::human_control::verify_human_control_in_tx` /
//! `momo_server::human_control::authorize_human_control_in_tx` inside a real
//! tenant transaction, for the kinds no human route writes yet (`input`,
//! `spawn` — E7 #3027). The person's Secure Enclave keys are software P-256
//! keys signing the exact bytes E1 (`momo-wire` `human_control`) builds.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `migration_095_reapplies_as_a_noop_and_keeps_rls_forced` | a non-idempotent 095 statement, a missing FORCE, or a signature CHECK that lets a half-set row in |
//! | `flag_off_keeps_todays_decision_and_poll` | verify or require a signature when none is sent and the flag is off |
//! | `flag_on_refuses_an_unsigned_allow_but_never_a_reject` | drop the `required` judgment, or require it for a reject |
//! | `a_signed_allow_rides_on_the_control_and_is_recorded_once` | drop the columns, the envelope, the provenance row, or answer a retry by re-verifying |
//! | `every_misplaced_signed_allow_is_refused_by_name` | rebuild from the request instead of the stored option / session / host / instance, skip the chain, the revocation, the window or the nonce |
//! | `a_phone_allow_falls_with_its_roots_sign_in` | drop the endorser-lineage check and the endorser-live read (review M1) |
//! | `the_chokepoint_holds_for_input_and_spawn` | same, for the kinds E7 will route; mode swap, other host, resume session, NFC |
//! | `a_resume_onto_a_member_host_is_refused_while_signatures_are_required` | drop the resume refusal |
//! | `host_register_spends_its_nonce_and_records_provenance` | drop the nonce or the provenance on the signed registration |
//! | `the_signing_context_serves_the_one_instance_id_and_the_clock` | serve a second source, or drop the 503 |
//! | `a_previewed_allow_must_name_the_stored_preview` (#3118) | rebuild the allow without the stored preview hash (a v2 allow or an allow over another preview then passes), broadcast the preview, or serve it to someone other than the owner |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26773/momo \
//!   cargo test -p momo-server --test human_control_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_auth::human_control::{
    verify_human_control_in_tx, ControlSubject, ControlTarget, HumanControlRefusal,
    HumanSignatureInput,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use momo_wire::human_control::{
    ControlContent, ControlSchema, DeviceEndorse, DeviceKeyAlg, HumanControl,
};
use momo_wire::human_control::{InputMode, PermissionScope};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "human-control-conformance-signing-secret";
const TEST_PASSWORD: &str = "human-control-password";
const INSTANCE_ID: &str = "inst_3023_conformance";
const HOST_SEED: u8 = 61;

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
        ..DeviceKeySettings::default()
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
    app: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    person: Uuid,
    access: String,
    other_access: String,
    other: Uuid,
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

/// A phone QR-linked (ADR-0180) from the sign-in `desktop_access` — since #3119
/// the only kind of sign-in a phone key registers on. Its access token.
async fn link_phone(http: &reqwest::Client, base: &str, desktop_access: &str) -> String {
    let host = base.trim_start_matches("http://");
    let issued = http
        .post(format!("{base}/v1/auth/device-link"))
        .bearer_auth(desktop_access)
        .header("host", host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device link");
    assert_eq!(issued.status().as_u16(), 201, "issue device link");
    let voucher = issued.json::<Value>().await.expect("link body")["token"]
        .as_str()
        .expect("token")
        .to_string();
    let redeemed = http
        .post(format!("{base}/v1/auth/device-link/redeem"))
        .header("host", host)
        .header("x-forwarded-proto", "http")
        .json(&json!({ "token": voucher, "device": { "name": "폰", "platform": "ios" } }))
        .send()
        .await
        .expect("redeem device link");
    assert_eq!(redeemed.status().as_u16(), 200, "redeem device link");
    let body: Value = redeemed.json().await.expect("redeem body");
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

    /// The host relays an `approval.requested`; returns its event id.
    async fn permission_request(&self, session: Uuid) -> Uuid {
        self.permission_request_with(session, None).await
    }

    /// … optionally with the host's preview and its hash (#3118).
    async fn permission_request_with(&self, session: Uuid, preview: Option<&Value>) -> Uuid {
        let event_id = Uuid::new_v4();
        let mut payload = json!({
            "run_id": session, "work_session_id": session,
            "channel_id": self.channel,
            "action": "requested", "action_type": "tool_call", "status": "pending",
            "options": [
                {"option_id": "allow-once", "kind": "allow_once", "name": "Allow once"},
                {"option_id": "reject-once", "kind": "reject_once", "name": "Reject"}
            ]
        });
        if let Some(preview) = preview {
            payload["preview"] = preview.clone();
            payload["preview_sha256"] =
                json!(momo_wire::permission_preview::preview_sha256(preview).unwrap());
        }
        let (status, body) = self
            .host_request(
                "PATCH",
                &format!("/v1/workspaces/{}/work-sessions/{session}", self.workspace),
                Some(json!({ "event": {
                    "event_id": event_id,
                    "type": "approval.requested",
                    "v": 1,
                    "ts": now_ms(),
                    "payload": payload,
                }})),
            )
            .await;
        assert_eq!(status, 200, "the host relays the request: {body}");
        event_id
    }

    #[allow(clippy::too_many_arguments)]
    fn permission_statement(
        &self,
        key: &DeviceKeyPair,
        key_id: Uuid,
        host: Uuid,
        session: Uuid,
        request_event_id: Uuid,
        option_id: &str,
        option_kind: &str,
        nonce: Uuid,
        issued_at_ms: i64,
        instance_id: &str,
    ) -> Value {
        self.permission_statement_over(
            key,
            key_id,
            host,
            session,
            request_event_id,
            (option_id, option_kind),
            nonce,
            issued_at_ms,
            instance_id,
            None,
        )
    }

    /// A permission statement; with `preview_sha256` a v3 one (#3118), without
    /// the v2 one a request relayed with no preview is answered by.
    #[allow(clippy::too_many_arguments)]
    fn permission_statement_over(
        &self,
        key: &DeviceKeyPair,
        key_id: Uuid,
        host: Uuid,
        session: Uuid,
        request_event_id: Uuid,
        option: (&str, &str),
        nonce: Uuid,
        issued_at_ms: i64,
        instance_id: &str,
        preview_sha256: Option<&str>,
    ) -> Value {
        self.permission_statement_scoped(
            key,
            key_id,
            host,
            session,
            request_event_id,
            option,
            nonce,
            issued_at_ms,
            instance_id,
            preview_sha256,
            PermissionScope::Once,
        )
    }

    /// … with the scope the owner chose (#3095: 「이 세션 동안」).
    #[allow(clippy::too_many_arguments)]
    fn permission_statement_scoped(
        &self,
        key: &DeviceKeyPair,
        key_id: Uuid,
        host: Uuid,
        session: Uuid,
        request_event_id: Uuid,
        (option_id, option_kind): (&str, &str),
        nonce: Uuid,
        issued_at_ms: i64,
        instance_id: &str,
        preview_sha256: Option<&str>,
        scope: PermissionScope,
    ) -> Value {
        let expires_at_ms = issued_at_ms + 5 * 60 * 1000;
        let schema = if preview_sha256.is_some() {
            ControlSchema::V3
        } else {
            ControlSchema::V2
        };
        let bytes = HumanControl {
            instance_id,
            workspace_id: self.workspace,
            member_id: self.person,
            device_key_id: key_id,
            host_id: host,
            session_id: Some(session),
            nonce,
            issued_at_ms,
            expires_at_ms,
            content: ControlContent::Permission {
                request_event_id,
                option_id,
                option_kind,
                scope,
                preview_sha256,
            },
        }
        .signed_bytes_as(schema)
        .expect("permission bytes");
        json!({
            "deviceKeyId": key_id,
            "nonce": nonce,
            "issuedAtMs": issued_at_ms,
            "expiresAtMs": expires_at_ms,
            "scope": scope.as_str(),
            "signature": key.sign(&bytes),
        })
    }

    /// The phone's honest signature over `allow-once` of `request`.
    fn phone_allow(&self, session: Uuid, request: Uuid) -> Value {
        self.permission_statement(
            &self.phone,
            self.phone_id,
            self.host,
            session,
            request,
            "allow-once",
            "allow_once",
            Uuid::new_v4(),
            now_ms(),
            INSTANCE_ID,
        )
    }

    /// The phone's signature over `allow-once` of `request` for the whole
    /// session (#3095).
    fn phone_session_allow(&self, session: Uuid, request: Uuid) -> Value {
        self.permission_statement_scoped(
            &self.phone,
            self.phone_id,
            self.host,
            session,
            request,
            ("allow-once", "allow_once"),
            Uuid::new_v4(),
            now_ms(),
            INSTANCE_ID,
            None,
            PermissionScope::Session,
        )
    }

    async fn decide(&self, session: Uuid, body: Value) -> (u16, Value) {
        self.decide_as(&self.access, session, body).await
    }

    async fn decide_as(&self, bearer: &str, session: Uuid, body: Value) -> (u16, Value) {
        self.post(
            &format!(
                "/v1/workspaces/{}/work-sessions/{session}/permission-decisions",
                self.workspace
            ),
            bearer,
            body,
        )
        .await
    }

    async fn controls_of(&self, session: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM work_control WHERE session_id = $1")
            .bind(session)
            .fetch_one(&self.su)
            .await
            .expect("count controls")
    }

    async fn request_status(&self, request: Uuid) -> String {
        sqlx::query_scalar("SELECT status FROM work_permission_request WHERE request_event_id = $1")
            .bind(request)
            .fetch_one(&self.su)
            .await
            .expect("request status")
    }

    async fn human_rows(&self) -> (i64, i64) {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT (SELECT count(*) FROM human_control_nonce WHERE workspace_id = $1), \
                    (SELECT count(*) FROM action_signature WHERE workspace_id = $1 AND alg = 'p256')",
        )
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("count human rows")
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
    let (other, other_email) = seed_human(&su, workspace, "member").await;
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
        app,
        http,
        base,
        workspace,
        person,
        access,
        other_access,
        other,
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
    let phone_access = link_phone(&stage.http, &stage.base, &stage.access).await;
    let (status, body) = stage
        .post(
            &stage.keys_path(),
            &phone_access,
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
// migration
// ---------------------------------------------------------------------------

async fn constraint_snapshot(su: &PgPool) -> Vec<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint \
          WHERE conrelid IN ('work_control'::regclass, 'human_control_nonce'::regclass) \
          ORDER BY conname",
    )
    .fetch_all(su)
    .await
    .expect("constraint snapshot")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn migration_095_reapplies_as_a_noop_and_keeps_rls_forced() {
    let _lock = test_lock().await;
    let s = stage(false).await;
    let before = constraint_snapshot(&s.su).await;
    for _ in 0..2 {
        let out = psql_file(default_migrations_dir().join("095_human_control_nonce.sql"));
        assert!(
            out.status.success(),
            "095 re-applies: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert_eq!(
        constraint_snapshot(&s.su).await,
        before,
        "re-apply is a no-op"
    );
    let (enabled, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'human_control_nonce'",
    )
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(enabled && forced, "human_control_nonce is RLS FORCE");

    // The signature CHECK: a half-set row and a kill carrying a signature are
    // refused even to the superuser.
    let session = s.session().await;
    let sig = format!("{}==", "A".repeat(86));
    for (kind, payload, with_nonce, what) in [
        ("kill", json!({}), false, "a signature without a nonce"),
        ("kill", json!({}), true, "a signed kill"),
        (
            "input",
            json!({"text": "hi"}),
            true,
            "an input without a mode",
        ),
    ] {
        let inserted = sqlx::query(
            "INSERT INTO work_control \
               (workspace_id, channel_id, requester_member_id, target_host_id, session_id, kind, payload, status, \
                device_key_id, human_instance_id, human_issued_at_ms, human_expires_at_ms, human_signature, human_nonce) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, 'inst', 1, 2, $9, \
                     CASE WHEN $10 THEN gen_random_uuid() ELSE NULL END)",
        )
        .bind(s.workspace)
        .bind(s.channel)
        .bind(s.person)
        .bind(s.host)
        .bind(session)
        .bind(kind)
        .bind(&payload)
        .bind(s.root_id)
        .bind(&sig)
        .bind(with_nonce)
        .execute(&s.su)
        .await;
        let error = inserted.expect_err("the signature CHECK refuses the row");
        assert!(
            error
                .to_string()
                .contains("work_control_human_signature_ck"),
            "{what}: {error}"
        );
    }
    // The honest shape is accepted.
    sqlx::query(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, session_id, kind, payload, status, \
            device_key_id, human_instance_id, human_issued_at_ms, human_expires_at_ms, human_signature, \
            human_nonce, human_mode) \
         VALUES ($1, $2, $3, $4, $5, 'input', '{\"text\":\"hi\"}', 'approved', $6, 'inst', 1, 2, $7, \
                 gen_random_uuid(), 'queue')",
    )
    .bind(s.workspace)
    .bind(s.channel)
    .bind(s.person)
    .bind(s.host)
    .bind(session)
    .bind(s.root_id)
    .bind(&sig)
    .execute(&s.su)
    .await
    .expect("an all-set, per-kind signed input is accepted");
}

// ---------------------------------------------------------------------------
// the permission route
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn flag_off_keeps_todays_decision_and_poll() {
    let _lock = test_lock().await;
    let s = stage(false).await;
    let session = s.session().await;
    let request = s.permission_request(session).await;
    let (status, body) = s
        .decide(
            session,
            json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once" }),
        )
        .await;
    assert_eq!(status, 200, "an unsigned allow is today's allow: {body}");
    assert_eq!(s.human_rows().await, (0, 0), "no nonce, no p256 provenance");
    let polled = s.poll().await;
    let controls = polled["workControls"].as_array().unwrap();
    assert_eq!(controls.len(), 1, "{polled}");
    assert!(
        controls[0].get("humanSignature").is_none(),
        "today's bytes: no humanSignature key ({polled})"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn flag_on_refuses_an_unsigned_allow_but_never_a_reject() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let request = s.permission_request(session).await;
    let (status, body) = s
        .decide(
            session,
            json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once" }),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (403, Some("device_signature_required")),
        "{body}"
    );
    assert_eq!(s.controls_of(session).await, 0, "nothing reaches the host");
    assert_eq!(s.request_status(request).await, "pending");
    // The switch-off side needs no signature (D-8).
    let (status, body) = s
        .decide(
            session,
            json!({ "requestEventId": request, "optionId": "reject-once", "kind": "reject_once" }),
        )
        .await;
    assert_eq!(status, 200, "a reject is never signed: {body}");
    assert_eq!(s.request_status(request).await, "rejected");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_allow_rides_on_the_control_and_is_recorded_once() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let request = s.permission_request(session).await;
    let signature = s.phone_allow(session, request);
    let body = json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once",
                       "humanSignature": signature });
    let (status, answer) = s.decide(session, body.clone()).await;
    assert_eq!(status, 200, "the phone's signed allow: {answer}");
    let control_id = answer["permissionRequest"]["controlId"]
        .as_str()
        .unwrap()
        .to_string();

    // The control row carries the verified columns.
    let (key, scope, nonce, stored_sig): (Uuid, String, Uuid, String) = sqlx::query_as(
        "SELECT device_key_id, human_scope, human_nonce, human_signature FROM work_control WHERE id = $1::uuid",
    )
    .bind(&control_id)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(key, s.phone_id);
    assert_eq!(scope, "once");
    assert_eq!(nonce.to_string(), signature["nonce"].as_str().unwrap());
    // One nonce, one p256 provenance row bound to the control.
    assert_eq!(s.human_rows().await, (1, 1));
    let (entity_type, entity_id, alg, signer, stored): (String, Uuid, String, Uuid, String) =
        sqlx::query_as(
            "SELECT entity_type, entity_id, alg, signer_member_id, signature \
               FROM action_signature WHERE workspace_id = $1 AND alg = 'p256'",
        )
        .bind(s.workspace)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert_eq!(entity_type, "work_control");
    assert_eq!(entity_id.to_string(), control_id);
    assert_eq!((alg.as_str(), signer), ("p256", s.person));
    assert_eq!(
        stored, stored_sig,
        "the canonical low-s form, the same bytes"
    );

    // The host is handed the envelope, with the root's letter for the phone.
    let polled = s.poll().await;
    let control = &polled["workControls"][0];
    let envelope = &control["humanSignature"];
    assert_eq!(envelope["alg"], "p256");
    assert_eq!(envelope["instanceId"], INSTANCE_ID);
    assert_eq!(envelope["deviceKeyId"], s.phone_id.to_string());
    assert_eq!(envelope["devicePublicKey"], s.phone.public_b64);
    assert_eq!(envelope["endorsement"]["rootKeyId"], s.root_id.to_string());
    assert_eq!(envelope["endorsement"]["label"], "폰");
    assert_eq!(envelope["scope"], "once");
    assert_eq!(envelope["nonce"], signature["nonce"]);
    assert_eq!(envelope["signature"], json!(stored_sig));
    assert!(envelope.get("mode").is_none() && envelope.get("folderId").is_none());

    // The retry of the same decided request answers 200 with the same control
    // and spends nothing again.
    let (status, again) = s.decide(session, body).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["permissionRequest"]["controlId"], json!(control_id));
    assert_eq!(
        s.human_rows().await,
        (1, 1),
        "a retry is not a second action"
    );
    assert_eq!(s.controls_of(session).await, 1);
}

/// #3095 (ADR-0146 증보, D-8): 「이 세션 동안」 is an allow the owner's device
/// signed with scope `session`. The server verifies it, stores the scope on
/// the control row, hands the host the envelope, and tells the owner's
/// surfaces and the audit trail the scope. It is refused as a reject, and
/// nothing unsigned can carry it (the scope lives only in the signed statement).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_session_allow_is_accepted_and_carries_its_scope() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let request = s.permission_request(session).await;
    let signature = s.phone_session_allow(session, request);
    let body = json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once",
                       "humanSignature": signature });
    let (status, answer) = s.decide(session, body).await;
    assert_eq!(status, 200, "the phone's signed session allow: {answer}");
    let control_id = answer["permissionRequest"]["controlId"].as_str().unwrap();

    // The control row, the host's envelope and the payload all say `session`.
    let (scope, payload): (String, Value) =
        sqlx::query_as("SELECT human_scope, payload FROM work_control WHERE id = $1::uuid")
            .bind(control_id)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(scope, "session");
    // The closed payload (092) stays three keys: the scope is the signature's.
    assert_eq!(payload.as_object().unwrap().len(), 3, "{payload}");
    assert_eq!(payload["kind"], "allow_once");
    assert_eq!(s.human_rows().await, (1, 1));
    let polled = s.poll().await;
    assert_eq!(
        polled["workControls"][0]["humanSignature"]["scope"],
        "session"
    );

    // The owner's other devices are told the scope; the audit row records it.
    let event_scope: Option<String> = sqlx::query_scalar(
        "SELECT props->'event'->>'scope' FROM message \
          WHERE workspace_id = $1 AND props->>'event_type' = 'approval.decided' \
            AND props->'event'->>'request_event_id' = $2",
    )
    .bind(s.workspace)
    .bind(request.to_string())
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(event_scope.as_deref(), Some("session"));
    let audited: Option<String> = sqlx::query_scalar(
        "SELECT detail->>'scope' FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.permission.decided'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(audited.as_deref(), Some("session"));

    // An unsigned decision carries no scope: `once`.
    let request2 = s.permission_request(session).await;
    let (status, plain) = s
        .decide(
            session,
            json!({ "requestEventId": request2, "optionId": "reject-once", "kind": "reject_once" }),
        )
        .await;
    assert_eq!(status, 200, "{plain}");
    let control2 = plain["permissionRequest"]["controlId"].as_str().unwrap();
    let scope2: Option<String> =
        sqlx::query_scalar("SELECT human_scope FROM work_control WHERE id = $1::uuid")
            .bind(control2)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(scope2, None, "an unsigned reject carries no scope");

    // A host that is not a member host cannot honour it: 400 by name, and the
    // signature is not spent.
    let request3 = s.permission_request(session).await;
    let before = s.human_rows().await;
    sqlx::query("UPDATE work_host SET scope = 'workspace' WHERE id = $1")
        .bind(s.host)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, refused) = s
        .decide(
            session,
            json!({ "requestEventId": request3, "optionId": "allow-once", "kind": "allow_once",
                    "humanSignature": s.phone_session_allow(session, request3) }),
        )
        .await;
    sqlx::query("UPDATE work_host SET scope = 'member' WHERE id = $1")
        .bind(s.host)
        .execute(&s.su)
        .await
        .unwrap();
    assert_eq!(
        (status, code(&refused)),
        (400, Some("permission_scope_unsupported")),
        "{refused}"
    );
    assert_eq!(s.human_rows().await, before, "no nonce spent");
    assert_eq!(s.request_status(request3).await, "pending");

    // The host's own record of an automatic allow under the grant: a distinct
    // event type (never `approval.decided`), audited once, malformed ones
    // refused.
    let hash = "a".repeat(64);
    let auto = |event_id: Uuid, payload: Value| {
        let s = &s;
        async move {
            s.host_request(
                "PATCH",
                &format!("/v1/workspaces/{}/work-sessions/{session}", s.workspace),
                Some(json!({ "event": {
                    "event_id": event_id, "type": "approval.auto_allowed", "v": 1,
                    "ts": now_ms(), "payload": payload,
                }})),
            )
            .await
        }
    };
    let payload = json!({
        "run_id": session, "work_session_id": session, "channel_id": s.channel,
        "action": "auto_allowed", "status": "approved", "scope": "session",
        "tool_kind": "execute", "preview_sha256": hash,
    });
    for (name, bad) in [
        ("scope once", json!({ "scope": "once" })),
        ("no hash", json!({ "preview_sha256": null })),
        ("a short hash", json!({ "preview_sha256": "abc" })),
        ("no tool kind", json!({ "tool_kind": "" })),
        ("rejected", json!({ "status": "rejected" })),
        ("names a request", json!({ "request_event_id": request2 })),
    ] {
        let mut body = payload.clone();
        for (key, value) in bad.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, answer) = auto(Uuid::new_v4(), body).await;
        assert_eq!(status, 400, "{name}: {answer}");
    }
    let event_id = Uuid::new_v4();
    let (status, answer) = auto(event_id, payload.clone()).await;
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = auto(event_id, payload.clone()).await;
    assert_eq!(status, 200, "a retry: {answer}");
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.permission.auto_allowed' \
            AND detail->>'preview_sha256' = $2 AND detail->>'tool_kind' = 'execute'",
    )
    .bind(s.workspace)
    .bind(&hash)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(rows, 1, "one audit row, however many retries");
}

/// #3118 (ADR-0146 증보, R2 H1): a request the host relayed with a preview is
/// allowed only by a v3 statement naming the **stored** preview hash. A v2
/// allow (no preview line) and an allow over a preview the server showed
/// instead are refused by name, and the preview never reaches the thread.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_previewed_allow_must_name_the_stored_preview() {
    use momo_wire::permission_preview::{preview_sha256, PermissionPreview};
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let preview = PermissionPreview {
        kind: "execute".into(),
        title: "Run `git push --force origin main`".into(),
        locations: String::new(),
        input: r#"{"command":"git push --force origin main"}"#.into(),
        truncated: false,
    }
    .to_value();
    let hash = preview_sha256(&preview).unwrap();
    let request = s.permission_request_with(session, Some(&preview)).await;

    // Stored for the owner, never broadcast: the thread message has the hash
    // and not the command.
    let (stored_preview, stored_hash): (Option<Value>, Option<String>) = sqlx::query_as(
        "SELECT preview, preview_sha256 FROM work_permission_request WHERE request_event_id = $1",
    )
    .bind(request)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(stored_preview.as_ref(), Some(&preview));
    assert_eq!(stored_hash.as_deref(), Some(hash.as_str()));
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE channel_id = $1 \
            AND (props::text LIKE '%git push%' OR coalesce(body, '') LIKE '%git push%')",
    )
    .bind(s.channel)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(leaked, 0, "the preview is the owner's, not the thread's");
    // 097: a preview never stands without its hash, nor a hash without its
    // preview (a NULL hash once passed the CHECK — `NULL ~ …` is NULL).
    for (preview_sql, hash_sql) in [
        ("'{}'::jsonb", "NULL"),
        ("NULL", "repeat('a', 64)"),
        ("'{}'::jsonb", "repeat('A', 64)"),
    ] {
        let refused = sqlx::query(&format!(
            "INSERT INTO work_permission_request \
               (workspace_id, work_session_id, host_id, channel_id, request_event_id, \
                options, expires_at, preview, preview_sha256) \
             SELECT workspace_id, work_session_id, host_id, channel_id, gen_random_uuid(), \
                    options, now(), {preview_sql}, {hash_sql} \
               FROM work_permission_request WHERE request_event_id = $1"
        ))
        .bind(request)
        .execute(&s.su)
        .await;
        assert!(
            refused.is_err(),
            "{preview_sql} / {hash_sql} must violate the preview CHECK"
        );
    }
    let with_hash: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE channel_id = $1 AND props::text LIKE '%' || $2 || '%'",
    )
    .bind(s.channel)
    .bind(&hash)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(with_hash, 1, "the thread's event carries the hash");

    // The owner reads it; another member of the room cannot.
    let path = format!(
        "/v1/workspaces/{}/work-sessions/{session}/permission-requests/{request}",
        s.workspace
    );
    let (status, read) = s.call(reqwest::Method::GET, &path, &s.access, None).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["preview"], preview);
    assert_eq!(read["permissionRequest"]["previewSha256"], json!(hash));
    assert_eq!(read["options"][0]["optionId"], "allow-once");
    let (status, _) = s
        .call(reqwest::Method::GET, &path, &s.other_access, None)
        .await;
    assert_eq!(status, 404, "a non-owner learns nothing");

    let sign = |preview_sha256: Option<&str>| {
        s.permission_statement_over(
            &s.phone,
            s.phone_id,
            s.host,
            session,
            request,
            ("allow-once", "allow_once"),
            Uuid::new_v4(),
            now_ms(),
            INSTANCE_ID,
            preview_sha256,
        )
    };
    let decide = |signature: Value| {
        json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once",
                "humanSignature": signature })
    };
    // A v2 allow — no preview line — does not stand for a previewed request.
    let (status, answer) = s.decide(session, decide(sign(None))).await;
    assert_eq!(status, 403, "{answer}");
    assert_eq!(code(&answer), Some("device_signature_invalid"), "{answer}");
    // Nor does an allow over the preview a server showed instead.
    let mut shown = preview.clone();
    shown["kind"] = json!("read");
    shown["title"] = json!("Read README.md");
    let shown_hash = preview_sha256(&shown).unwrap();
    let (status, answer) = s.decide(session, decide(sign(Some(&shown_hash)))).await;
    assert_eq!(status, 403, "{answer}");
    assert_eq!(code(&answer), Some("device_signature_invalid"), "{answer}");
    assert_eq!(s.request_status(request).await, "pending");
    assert_eq!(s.controls_of(session).await, 0);
    // The allow over what the host relayed is the one that works.
    let (status, answer) = s.decide(session, decide(sign(Some(&hash)))).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer["permissionRequest"]["previewSha256"],
        json!(hash),
        "{answer}"
    );
    assert_eq!(s.request_status(request).await, "approved");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn every_misplaced_signed_allow_is_refused_by_name() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let other_session = s.session().await;
    let request = s.permission_request(session).await;
    let allow = |signature: Value| {
        json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once",
                "humanSignature": signature })
    };
    let now = now_ms();
    let statement = |key: &DeviceKeyPair,
                     key_id: Uuid,
                     host: Uuid,
                     session_line: Uuid,
                     option_id: &str,
                     option_kind: &str,
                     issued: i64,
                     instance: &str| {
        s.permission_statement(
            key,
            key_id,
            host,
            session_line,
            request,
            option_id,
            option_kind,
            Uuid::new_v4(),
            issued,
            instance,
        )
    };

    // An unendorsed phone key (승인서 없는 폰 키).
    let bare = DeviceKeyPair::new("bare phone");
    let bare_phone = link_phone(&s.http, &s.base, &s.access).await;
    let (status, body) = s
        .post(
            &s.keys_path(),
            &bare_phone,
            json!({ "alg": "p256", "publicKey": bare.public_b64, "platform": "ios", "label": "새 폰" }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let bare_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    // A teammate's own (root) key.
    let theirs = DeviceKeyPair::new("teammate mac");
    let _ = &s.other_access;
    let (status, body) = s
        .post(
            &s.keys_path(),
            &s.other_access,
            json!({ "alg": "p256", "publicKey": theirs.public_b64, "platform": "macos",
                    "label": "남의 맥", "currentPassword": TEST_PASSWORD }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let theirs_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();

    let cases: Vec<(&str, Value, u16, &str)> = vec![
        (
            "signed the reject option, sent an allow",
            allow(statement(
                &s.phone,
                s.phone_id,
                s.host,
                session,
                "reject-once",
                "reject_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "another host",
            allow(statement(
                &s.phone,
                s.phone_id,
                Uuid::new_v4(),
                session,
                "allow-once",
                "allow_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "another session",
            allow(statement(
                &s.phone,
                s.phone_id,
                s.host,
                other_session,
                "allow-once",
                "allow_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "another instance",
            allow(statement(
                &s.phone,
                s.phone_id,
                s.host,
                session,
                "allow-once",
                "allow_once",
                now,
                "inst_other",
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "the phone's id with the root's signature",
            allow(statement(
                &s.root,
                s.phone_id,
                s.host,
                session,
                "allow-once",
                "allow_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "a teammate's key",
            allow(statement(
                &theirs,
                theirs_id,
                s.host,
                session,
                "allow-once",
                "allow_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_signature_invalid",
        ),
        (
            "an unendorsed phone",
            allow(statement(
                &bare,
                bare_id,
                s.host,
                session,
                "allow-once",
                "allow_once",
                now,
                INSTANCE_ID,
            )),
            403,
            "device_key_not_endorsed",
        ),
        (
            "issued 6 minutes ago",
            allow(statement(
                &s.phone,
                s.phone_id,
                s.host,
                session,
                "allow-once",
                "allow_once",
                now - 6 * 60 * 1000,
                INSTANCE_ID,
            )),
            403,
            "device_signature_expired",
        ),
        (
            "scope swapped to session after signing once (#3095)",
            {
                let mut body = allow(s.phone_allow(session, request));
                body["humanSignature"]["scope"] = json!("session");
                body
            },
            403,
            "device_signature_invalid",
        ),
        (
            "scope swapped to once after signing session (#3095)",
            {
                let mut body = allow(s.phone_session_allow(session, request));
                body["humanSignature"]["scope"] = json!("once");
                body
            },
            403,
            "device_signature_invalid",
        ),
        (
            "a session scope on a reject (#3095)",
            {
                let mut body = allow(s.phone_session_allow(session, request));
                body["optionId"] = json!("reject-once");
                body["kind"] = json!("reject_once");
                body
            },
            400,
            "permission_kind_refused",
        ),
        (
            "a mode on a permission",
            {
                let mut body = allow(s.phone_allow(session, request));
                body["humanSignature"]["mode"] = json!("queue");
                body
            },
            403,
            "device_signature_invalid",
        ),
    ];
    for (name, body, want_status, want_code) in cases {
        let (status, answer) = s.decide(session, body).await;
        assert_eq!(
            (status, code(&answer)),
            (want_status, Some(want_code)),
            "{name}: {answer}"
        );
        assert_eq!(
            s.controls_of(session).await,
            0,
            "{name}: nothing reached the host"
        );
        assert_eq!(s.request_status(request).await, "pending", "{name}");
    }
    assert_eq!(
        s.human_rows().await,
        (0, 0),
        "no refused statement spent a nonce"
    );

    // A revoked key: the root's letter revokes the phone, then its allow is refused.
    let at = now_ms();
    let letter = s.root.sign(
        &momo_wire::human_control::DeviceRevoke {
            workspace_id: s.workspace,
            member_id: s.person,
            root_key_id: s.root_id,
            target_key_id: s.phone_id,
            revoked_at_ms: at,
        }
        .signed_bytes_v2(&s.phone.public_b64)
        .expect("v2 letter"),
    );
    let signed_before_revocation = s.phone_allow(session, request);
    let (status, body) = s
        .post(
            &format!("{}/{}/revocation", s.keys_path(), s.phone_id),
            &s.access,
            json!({ "rootKeyId": s.root_id, "revokedAtMs": at, "signature": letter }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, answer) = s.decide(session, allow(signed_before_revocation)).await;
    assert_eq!(
        (status, code(&answer)),
        (403, Some("device_key_revoked")),
        "{answer}"
    );

    // Nonce reuse: the root signs this request once (200), then signs the
    // second request with the same nonce (409).
    let nonce = Uuid::new_v4();
    let first = s.permission_statement(
        &s.root,
        s.root_id,
        s.host,
        session,
        request,
        "allow-once",
        "allow_once",
        nonce,
        now_ms(),
        INSTANCE_ID,
    );
    let (status, answer) = s.decide(session, allow(first)).await;
    assert_eq!(status, 200, "the root's own allow: {answer}");
    let second_request = s.permission_request(session).await;
    let reused = s.permission_statement(
        &s.root,
        s.root_id,
        s.host,
        session,
        second_request,
        "allow-once",
        "allow_once",
        nonce,
        now_ms(),
        INSTANCE_ID,
    );
    let (status, answer) = s
        .decide(
            session,
            json!({ "requestEventId": second_request, "optionId": "allow-once",
                    "kind": "allow_once", "humanSignature": reused }),
        )
        .await;
    assert_eq!(
        (status, code(&answer)),
        (409, Some("device_nonce_replayed")),
        "{answer}"
    );
    assert_eq!(s.request_status(second_request).await, "pending");
}

/// Review M1: a phone's allow stands on its root's sign-in as well as its own.
/// The Mac's lineage ends on its own (its refresh rows revoked, the key row
/// untouched — no session end reached it): the phone signed on another sign-in
/// is 「지시 불가」 from then on.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_phone_allow_falls_with_its_roots_sign_in() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    // The phone links on its own lineage (QR, #3119) and registers there.
    let phone_access = link_phone(&s.http, &s.base, &s.access).await;
    let handset = DeviceKeyPair::new("second phone");
    let (status, body) = s
        .post(
            &s.keys_path(),
            &phone_access,
            json!({ "alg": "p256", "publicKey": handset.public_b64, "platform": "ios", "label": "둘째 폰" }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let handset_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    let letter = s.root.sign(
        &DeviceEndorse {
            workspace_id: s.workspace,
            member_id: s.person,
            root_key_id: s.root_id,
            target_alg: DeviceKeyAlg::P256,
            target_public_key_b64: &handset.public_b64,
            label: "둘째 폰",
        }
        .signed_bytes()
        .unwrap(),
    );
    let (status, body) = s
        .post(
            &format!("{}/{handset_id}/endorsement", s.keys_path()),
            &phone_access,
            json!({ "rootKeyId": s.root_id, "signature": letter }),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let session = s.session().await;
    let request = s.permission_request(session).await;
    let signed = |nonce: Uuid| {
        s.permission_statement(
            &handset,
            handset_id,
            s.host,
            session,
            request,
            "allow-once",
            "allow_once",
            nonce,
            now_ms(),
            INSTANCE_ID,
        )
    };
    // The Mac's sign-in lapses; its key row still reads live.
    let lapsed = sqlx::query(
        "UPDATE token SET revoked_at = now() \
          WHERE session_id = (SELECT session_id FROM member_device_key WHERE id = $1) \
            AND revoked_at IS NULL",
    )
    .bind(s.root_id)
    .execute(&s.su)
    .await
    .unwrap()
    .rows_affected();
    assert!(lapsed > 0, "the Mac's lineage had live rows");
    let (status, answer) = s
        .decide_as(
            &phone_access,
            session,
            json!({ "requestEventId": request, "optionId": "allow-once", "kind": "allow_once",
                    "humanSignature": signed(Uuid::new_v4()) }),
        )
        .await;
    assert_eq!(
        (status, code(&answer)),
        (403, Some("device_key_not_endorsed")),
        "{answer}"
    );
    assert_eq!(s.controls_of(session).await, 0);
}

// ---------------------------------------------------------------------------
// the chokepoint, for the kinds E7 will route
// ---------------------------------------------------------------------------

/// The tool and channel a probed spawn names (v2 #3027 signs both).
const PROBE_TOOL: &str = "claude";
const PROBE_CHANNEL: Uuid = Uuid::from_u128(0x3027_cc01);

#[derive(Clone)]
struct Probe {
    subject: ProbeSubject,
    host: Uuid,
    session: Option<Uuid>,
    input: HumanSignatureInput,
}

#[derive(Clone)]
enum ProbeSubject {
    Input(String),
    Spawn(String),
}

async fn probe(s: &Stage, probe: Probe) -> Result<(), HumanControlRefusal> {
    let workspace = s.workspace;
    let member = s.person;
    with_tenant_tx(&s.app, workspace, move |conn| {
        Box::pin(async move {
            let subject = match &probe.subject {
                ProbeSubject::Input(text) => ControlSubject::Input { text },
                ProbeSubject::Spawn(prompt) => ControlSubject::Spawn {
                    first_prompt: prompt,
                    tool: PROBE_TOOL,
                    channel_id: PROBE_CHANNEL,
                },
            };
            let target = ControlTarget {
                workspace_id: workspace,
                member_id: member,
                host_id: probe.host,
                session_id: probe.session,
                subject,
            };
            let verdict =
                verify_human_control_in_tx(conn, INSTANCE_ID, &target, &probe.input, now_ms())
                    .await
                    .map_err(DbError::from)?;
            Ok::<_, DbError>(verdict.map(|_| ()))
        })
    })
    .await
    .expect("tenant tx")
}

#[allow(clippy::too_many_arguments)]
fn signed_input(
    s: &Stage,
    key: &DeviceKeyPair,
    key_id: Uuid,
    host: Uuid,
    session: Uuid,
    signed_mode: InputMode,
    sent_mode: &str,
    text: &str,
    nonce: Uuid,
) -> HumanSignatureInput {
    let issued = now_ms();
    let bytes = HumanControl {
        instance_id: INSTANCE_ID,
        workspace_id: s.workspace,
        member_id: s.person,
        device_key_id: key_id,
        host_id: host,
        session_id: Some(session),
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 60_000,
        content: ControlContent::Input {
            mode: signed_mode,
            text,
        },
    }
    .signed_bytes()
    .unwrap();
    HumanSignatureInput {
        device_key_id: key_id,
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 60_000,
        signature_b64: key.sign(&bytes),
        mode: Some(sent_mode.into()),
        scope: None,
        agent_member_id: None,
        folder_id: None,
    }
}

fn signed_spawn(
    s: &Stage,
    key: &DeviceKeyPair,
    key_id: Uuid,
    agent: Uuid,
    prompt: &str,
    nonce: Uuid,
) -> HumanSignatureInput {
    let issued = now_ms();
    let bytes = HumanControl {
        instance_id: INSTANCE_ID,
        workspace_id: s.workspace,
        member_id: s.person,
        device_key_id: key_id,
        host_id: s.host,
        session_id: None,
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 60_000,
        content: ControlContent::Spawn {
            agent_member_id: agent,
            folder_id: "folder-1",
            tool: PROBE_TOOL,
            channel_id: PROBE_CHANNEL,
            first_prompt: prompt,
        },
    }
    .signed_bytes()
    .unwrap();
    HumanSignatureInput {
        device_key_id: key_id,
        nonce,
        issued_at_ms: issued,
        expires_at_ms: issued + 60_000,
        signature_b64: key.sign(&bytes),
        mode: None,
        scope: None,
        agent_member_id: Some(agent),
        folder_id: Some("folder-1".into()),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_chokepoint_holds_for_input_and_spawn() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let session = s.session().await;
    let text = "테스트를 돌려 줘";

    // input: the honest queue instruction verifies once; its replay does not.
    let nonce = Uuid::new_v4();
    let honest = signed_input(
        &s,
        &s.phone,
        s.phone_id,
        s.host,
        session,
        InputMode::Queue,
        "queue",
        text,
        nonce,
    );
    let input = |i: HumanSignatureInput| Probe {
        subject: ProbeSubject::Input(text.into()),
        host: s.host,
        session: Some(session),
        input: i,
    };
    assert_eq!(probe(&s, input(honest.clone())).await, Ok(()));
    assert_eq!(
        probe(&s, input(honest)).await,
        Err(HumanControlRefusal::NonceReplayed),
        "a nonce is spent once"
    );
    // Mode swap: signed interrupt, sent as queue (and the reverse).
    for (signed, sent) in [
        (InputMode::Interrupt, "queue"),
        (InputMode::Queue, "interrupt"),
    ] {
        let swapped = signed_input(
            &s,
            &s.phone,
            s.phone_id,
            s.host,
            session,
            signed,
            sent,
            text,
            Uuid::new_v4(),
        );
        assert_eq!(
            probe(&s, input(swapped)).await,
            Err(HumanControlRefusal::Invalid),
            "mode {sent}"
        );
    }
    // Another host.
    let elsewhere = signed_input(
        &s,
        &s.phone,
        s.phone_id,
        Uuid::new_v4(),
        session,
        InputMode::Queue,
        "queue",
        text,
        Uuid::new_v4(),
    );
    assert_eq!(
        probe(&s, input(elsewhere)).await,
        Err(HumanControlRefusal::Invalid)
    );
    // Other text than signed.
    let mut altered = input(signed_input(
        &s,
        &s.phone,
        s.phone_id,
        s.host,
        session,
        InputMode::Queue,
        "queue",
        text,
        Uuid::new_v4(),
    ));
    altered.subject = ProbeSubject::Input("rm -rf 를 돌려 줘".into());
    assert_eq!(probe(&s, altered).await, Err(HumanControlRefusal::Invalid));
    // A non-NFC spelling of signed NFC text.
    let decomposed = "caf\u{0065}\u{0301}";
    let mut nfd = input(signed_input(
        &s,
        &s.phone,
        s.phone_id,
        s.host,
        session,
        InputMode::Queue,
        "queue",
        decomposed,
        Uuid::new_v4(),
    ));
    nfd.subject = ProbeSubject::Input(decomposed.into());
    assert_eq!(probe(&s, nfd).await, Err(HumanControlRefusal::Invalid));
    // A missing mode.
    let mut modeless = signed_input(
        &s,
        &s.phone,
        s.phone_id,
        s.host,
        session,
        InputMode::Queue,
        "queue",
        text,
        Uuid::new_v4(),
    );
    modeless.mode = None;
    assert_eq!(
        probe(&s, input(modeless)).await,
        Err(HumanControlRefusal::Invalid)
    );

    // spawn: the root's honest spawn verifies; with a session line it cannot.
    let agent = Uuid::new_v4();
    let spawn = signed_spawn(&s, &s.root, s.root_id, agent, "새 작업", Uuid::new_v4());
    let as_spawn = |i: HumanSignatureInput, session: Option<Uuid>| Probe {
        subject: ProbeSubject::Spawn("새 작업".into()),
        host: s.host,
        session,
        input: i,
    };
    assert_eq!(probe(&s, as_spawn(spawn, None)).await, Ok(()));
    let resume = signed_spawn(&s, &s.root, s.root_id, agent, "새 작업", Uuid::new_v4());
    assert_eq!(
        probe(&s, as_spawn(resume, Some(session))).await,
        Err(HumanControlRefusal::Invalid),
        "v1 cannot sign a spawn into a session the server chose"
    );
    let mut swapped_agent = signed_spawn(&s, &s.root, s.root_id, agent, "새 작업", Uuid::new_v4());
    swapped_agent.agent_member_id = Some(Uuid::new_v4());
    assert_eq!(
        probe(&s, as_spawn(swapped_agent, None)).await,
        Err(HumanControlRefusal::Invalid)
    );

    // Unsigned input / spawn through the server chokepoint while required.
    let settings = settings(true);
    for subject in ["input", "spawn"] {
        let workspace = s.workspace;
        let member = s.person;
        let host = s.host;
        let config = settings.clone();
        let refused = with_tenant_tx(&s.app, workspace, move |conn| {
            Box::pin(async move {
                let target = ControlTarget {
                    workspace_id: workspace,
                    member_id: member,
                    host_id: host,
                    session_id: (subject == "input").then_some(session),
                    subject: if subject == "input" {
                        ControlSubject::Input { text: "hi" }
                    } else {
                        ControlSubject::Spawn {
                            first_prompt: "hi",
                            tool: PROBE_TOOL,
                            channel_id: PROBE_CHANNEL,
                        }
                    },
                };
                let outcome = momo_server::human_control::authorize_human_control_in_tx(
                    conn, &config, &target, None, true,
                )
                .await?;
                Ok::<_, DbError>(outcome.err().and_then(|error| error.code))
            })
        })
        .await
        .expect("tenant tx");
        assert_eq!(refused, Some("device_signature_required"), "{subject}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_resume_onto_a_member_host_is_refused_while_signatures_are_required() {
    let _lock = test_lock().await;
    for (required, want) in [(true, 403_u16), (false, 201)] {
        let s = stage(required).await;
        // A second member host of the person: the old laptop.
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
                json!({ "channelId": s.channel, "hostId": old, "tool": "claude", "label": "옛 세션" }),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        let source = body["workSession"]["id"].as_str().unwrap().to_string();
        sqlx::query(
            "UPDATE work_session SET status = 'orphaned', idle_at = NULL, host_lost_at = NULL \
              WHERE id = $1::uuid",
        )
        .bind(&source)
        .execute(&s.su)
        .await
        .unwrap();
        let (status, body) = s
            .post(
                &format!(
                    "/v1/workspaces/{}/work-sessions/{source}/resume",
                    s.workspace
                ),
                &s.access,
                json!({ "targetHostId": s.host }),
            )
            .await;
        assert_eq!(status, want, "required={required}: {body}");
        if required {
            assert_eq!(code(&body), Some("device_signature_required"));
            let spawns: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM work_control WHERE target_host_id = $1 AND kind = 'spawn'",
            )
            .bind(s.host)
            .fetch_one(&s.su)
            .await
            .unwrap();
            assert_eq!(spawns, 0, "no unsignable spawn is written");
        }
    }
}

// ---------------------------------------------------------------------------
// host_register (the #3022 handoff) and the signing context
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn host_register_spends_its_nonce_and_records_provenance() {
    let _lock = test_lock().await;
    let s = stage(false).await;
    let register = |host_id: Uuid, nonce: Uuid, host_key: String, label: &'static str| {
        let issued = now_ms();
        let bytes = HumanControl {
            instance_id: INSTANCE_ID,
            workspace_id: s.workspace,
            member_id: s.person,
            device_key_id: s.root_id,
            host_id,
            session_id: None,
            nonce,
            issued_at_ms: issued,
            expires_at_ms: issued + 60_000,
            content: ControlContent::HostRegister {
                host_public_key_b64: &host_key,
                host_id,
                label,
            },
        }
        .signed_bytes()
        .unwrap();
        json!({
            "scope": "member", "type": "workd", "displayName": label, "publicKey": host_key,
            "registration": {
                "deviceKeyId": s.root_id, "hostId": host_id, "nonce": nonce,
                "issuedAtMs": issued, "expiresAtMs": issued + 60_000,
                "signature": s.root.sign(&bytes),
            }
        })
    };
    let path = format!("/v1/workspaces/{}/work-hosts", s.workspace);
    let nonce = Uuid::new_v4();
    let host_id = Uuid::new_v4();
    let first = register(host_id, nonce, ed25519_host_key(71), "서명 맥");
    let (status, body) = s.post(&path, &s.access, first.clone()).await;
    assert_eq!(status, 201, "{body}");
    let (entity_type, entity_id, alg, signer): (String, Uuid, String, Uuid) = sqlx::query_as(
        "SELECT entity_type, entity_id, alg, signer_member_id FROM action_signature \
          WHERE workspace_id = $1 AND alg = 'p256'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .expect("one p256 provenance row");
    assert_eq!(
        (entity_type.as_str(), entity_id, alg.as_str(), signer),
        ("work_host.register", host_id, "p256", s.person)
    );
    // The same statement again is still #3022's named replay.
    let (status, body) = s.post(&path, &s.access, first).await;
    assert_eq!(
        (status, code(&body)),
        (409, Some("host_register_replayed")),
        "{body}"
    );
    // A new host id under the spent nonce is a nonce replay.
    let (status, body) = s
        .post(
            &path,
            &s.access,
            register(Uuid::new_v4(), nonce, ed25519_host_key(72), "또 맥"),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (409, Some("device_nonce_replayed")),
        "{body}"
    );
    assert_eq!(s.human_rows().await, (1, 1));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_signing_context_serves_the_one_instance_id_and_the_clock() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let path = format!("{}/signing-context", s.keys_path());
    let before = now_ms();
    let (status, body) = s.call(reqwest::Method::GET, &path, &s.access, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["instanceId"], INSTANCE_ID);
    let server = body["serverTimeMs"].as_i64().unwrap();
    assert!(
        (server - before).abs() < 60_000,
        "the server clock: {server}"
    );
    assert_eq!(body["maxLifetimeMs"], 600_000);
    assert_eq!(body["maxClockSkewMs"], 300_000);
    assert_eq!(body["humanControlSignatureRequired"], true);
    assert_eq!(body["hostRegisterSignatureRequired"], false);

    let bare = stage_with(DeviceKeySettings::default()).await;
    let (status, body) = bare
        .call(
            reqwest::Method::GET,
            &format!("{}/signing-context", bare.keys_path()),
            &bare.access,
            None,
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (503, Some("instance_id_unconfigured")),
        "{body}"
    );
    let _ = (&s.other, &bare.other);
}
