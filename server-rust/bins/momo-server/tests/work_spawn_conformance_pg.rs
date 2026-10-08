//! DB-backed conformance for **#3570** (T5): the owner's signed NEW-work spawn
//! (`POST …/work-spawns`, ADR-0198 D4 · 증보 1 D7, ADR-0146, ADR-0188 D3 · D6),
//! against the real router on an isolated PG as `momo_app` (NOBYPASSRLS).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `flag_off_refuses_by_name_and_writes_nothing` | open the route without `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` |
//! | `a_signed_spawn_is_one_control_and_never_a_message` | send a message / bump `channel_seq` / emit an outbox row from the route, drop the signature columns, the provenance row or the audit row |
//! | `the_owners_mac_runs_the_session_the_spawn_asked_for` | drop the human arm of `dispatched_spawn_owner_in_tx` or of `spawn_ack_session_matches_in_tx`, or let the ack event carry the prompt |
//! | `no_one_but_the_owner_reaches_the_owners_mac` | drop the `owner_member_id = requester` filter of the host derivation (a teammate with a valid key and a valid statement then spawns on the owner's Mac) |
//! | `an_agent_bearer_spawns_nothing` | add the route to `required_agent_scope` |
//! | `an_offline_or_revoked_mac_is_refused_before_the_nonce_is_spent` | drop the online check (`work_host_online_sql`), or verify the signature before it |
//! | `no_signature_a_stale_one_or_a_spent_nonce_is_refused` | skip `authorize_human_control_in_tx`, drop the replay lookup, or stop spending the nonce |
//! | `the_prompt_is_bound_by_the_signature` / `…_the_folder_…` / `…_the_harness_…` / `…_the_room_the_thread_and_the_message_…` / `…_the_agent_…` | drop that line of the v4 body (`momo-wire`), or rebuild the statement from something other than the request |
//! | `a_personal_agent_is_the_owners_own_and_matches_the_harness` | drop the `owner_human_id`, `owner_only`, live-member or harness check |
//! | `the_thread_and_message_must_be_the_owners_own_in_this_room` | drop the author / channel / thread checks |
//! | `a_full_pool_is_refused_before_the_nonce_is_spent` | drop `acquire_slot_in_tx` |
//! | `shell_and_unregistered_tools_are_refused` | drop `remote_host_refuses_tool_in_tx` or `work_tool_is_enabled_in_tx` |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26775/momo \
//!   cargo test -p momo-server --test work_spawn_conformance_pg \
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
use momo_wire::human_control::{
    ControlContent, ControlSchema, DeviceEndorse, DeviceKeyAlg, HumanControl,
};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "work-spawn-conformance-signing-secret";
const TEST_PASSWORD: &str = "human-control-password";
const INSTANCE_ID: &str = "inst_3570_conformance";
const HOST_SEED: u8 = 73;

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
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    person: Uuid,
    access: String,
    other_access: String,
    teammate: Uuid,
    channel: Uuid,
    /// The ids the owner's Mac announced (opaque; there is no path anywhere).
    project: String,
    question: String,
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
    let (teammate, other_email) = seed_human(&su, workspace, "member").await;
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
    for (key, command) in [("codex", "never-run"), ("shell", "sh")] {
        sqlx::query(
            "INSERT INTO work_tool_profile \
               (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
             VALUES ($1, $2, $2, $3, true, $4, $4) \
             ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true, launch_template = $3",
        )
        .bind(workspace)
        .bind(key)
        .bind(json!({"command": command, "arguments": []}))
        .bind(person)
        .execute(&su)
        .await
        .expect("seed extra work tool profile");
    }

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
        teammate,
        channel,
        project: format!("fld_{}", &Uuid::new_v4().simple().to_string()[..20]),
        question: format!("fld_{}", &Uuid::new_v4().simple().to_string()[..20]),
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
    stage
        .announce(stage.host, &stage.project, &stage.question)
        .await;

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
// #3570 helpers
// ---------------------------------------------------------------------------

/// What the owner's client asks for, and therefore what it signs.
#[derive(Clone)]
struct Req {
    tool: &'static str,
    label: &'static str,
    prompt: String,
    channel: Uuid,
    thread: Option<Uuid>,
    origin: Option<Uuid>,
    agent: Option<Uuid>,
    folder: String,
    hint: Option<Uuid>,
}

/// The signature columns of one stored spawn.
type StoredSpawn = (
    Option<Uuid>,
    Option<String>,
    Option<Uuid>,
    Option<Uuid>,
    Option<Uuid>,
    Option<Uuid>,
);

/// A person's key as the client holds it.
struct Signer<'a> {
    key: &'a DeviceKeyPair,
    key_id: Uuid,
    member: Uuid,
}

impl Stage {
    /// What the owner asks for by default: a question to their own tool, in the
    /// 질문용 폴더, from the room's main line, no agent.
    fn req(&self) -> Req {
        Req {
            tool: "claude",
            label: "빌드가 왜 깨지는지",
            prompt: "이 저장소의 빌드가 왜 깨지는지 봐 줘".to_string(),
            channel: self.channel,
            thread: None,
            origin: None,
            agent: None,
            folder: self.question.clone(),
            hint: None,
        }
    }

    fn phone_signer(&self) -> Signer<'_> {
        Signer {
            key: &self.phone,
            key_id: self.phone_id,
            member: self.person,
        }
    }

    fn mac_signer(&self) -> Signer<'_> {
        Signer {
            key: &self.root,
            key_id: self.root_id,
            member: self.person,
        }
    }

    /// The host announced its folders (as its signed heartbeat would): opaque
    /// ids and names, never a path.
    async fn announce(&self, host: Uuid, project: &str, question: &str) {
        for (id, name, kind) in [
            (project, "momo", "project"),
            (question, "질문용 폴더", "question"),
        ] {
            sqlx::query(
                "INSERT INTO work_host_folder (workspace_id, host_id, folder_id, display_name, kind) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(self.workspace)
            .bind(host)
            .bind(id)
            .bind(name)
            .bind(kind)
            .execute(&self.su)
            .await
            .expect("announce a folder");
        }
    }

    fn spawns_path(&self) -> String {
        format!("/v1/workspaces/{}/work-spawns", self.workspace)
    }

    /// A statement for `host`, signed by `signer`, over exactly `req`.
    fn sign_for(
        &self,
        signer: &Signer<'_>,
        host: Uuid,
        req: &Req,
        nonce: Uuid,
        issued: i64,
        expires: i64,
    ) -> Value {
        let bytes = HumanControl {
            instance_id: INSTANCE_ID,
            workspace_id: self.workspace,
            member_id: signer.member,
            device_key_id: signer.key_id,
            host_id: host,
            session_id: None,
            nonce,
            issued_at_ms: issued,
            expires_at_ms: expires,
            content: ControlContent::SpawnTask {
                agent_member_id: req.agent,
                folder_id: &req.folder,
                tool: req.tool,
                channel_id: req.channel,
                thread_root_id: req.thread,
                origin_message_id: req.origin,
                prompt: &req.prompt,
            },
        }
        .signed_bytes_as(ControlSchema::V4)
        .expect("v4 spawn bytes");
        let mut signature = json!({
            "deviceKeyId": signer.key_id, "nonce": nonce, "issuedAtMs": issued,
            "expiresAtMs": expires, "signature": signer.key.sign(&bytes),
            "folderId": req.folder,
        });
        if let Some(agent) = req.agent {
            signature["agentMemberId"] = json!(agent);
        }
        signature
    }

    fn body(req: &Req, signature: Value) -> Value {
        json!({
            "tool": req.tool, "label": req.label, "prompt": req.prompt,
            "channelId": req.channel, "threadRootId": req.thread,
            "originMessageId": req.origin, "targetHostId": req.hint,
            "humanSignature": signature,
        })
    }

    /// The owner's phone signs `req` for the owner's Mac and sends it.
    async fn spawn(&self, req: &Req) -> (u16, Value, Uuid) {
        self.spawn_as(&self.phone_signer(), &self.access, self.host, req)
            .await
    }

    async fn spawn_as(
        &self,
        signer: &Signer<'_>,
        bearer: &str,
        host: Uuid,
        req: &Req,
    ) -> (u16, Value, Uuid) {
        let nonce = Uuid::new_v4();
        let issued = now_ms();
        let signature = self.sign_for(signer, host, req, nonce, issued, issued + 5 * 60_000);
        let (status, body) = self
            .post(&self.spawns_path(), bearer, Self::body(req, signature))
            .await;
        (status, body, nonce)
    }

    /// The heartbeat's own column, stamped (the host is online for 90 s).
    async fn host_online(&self, host: Uuid, online: bool) {
        sqlx::query(
            "UPDATE work_host SET last_seen_at = CASE WHEN $2 THEN clock_timestamp() \
                                               ELSE clock_timestamp() - interval '1 hour' END \
              WHERE id = $1",
        )
        .bind(host)
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

    async fn spawn_controls(&self) -> i64 {
        self.count("SELECT count(*) FROM work_control WHERE workspace_id = $1 AND kind = 'spawn'")
            .await
    }

    async fn spent_nonces(&self) -> i64 {
        self.count("SELECT count(*) FROM human_control_nonce WHERE workspace_id = $1")
            .await
    }

    /// Everything the message path would have written.
    async fn message_path(&self) -> (i64, i64, i64) {
        (
            self.count(
                "SELECT COALESCE(sum(last_seq), 0)::bigint FROM channel_seq cs \
                   JOIN channel c ON c.id = cs.channel_id WHERE c.workspace_id = $1",
            )
            .await,
            self.count("SELECT count(*) FROM message WHERE workspace_id = $1")
                .await,
            self.count("SELECT count(*) FROM outbox WHERE workspace_id = $1")
                .await,
        )
    }

    /// A teammate who has their own Mac, folders and a root key — everything a
    /// real attacker among the team could have.
    async fn teammate_world(&self) -> TeammateWorld {
        let key = DeviceKeyPair::new("teammate-mac");
        let (status, body) = self
            .post(
                &self.keys_path(),
                &self.other_access,
                json!({ "alg": "p256", "publicKey": key.public_b64, "platform": "macos",
                        "label": "동료 맥", "currentPassword": TEST_PASSWORD }),
            )
            .await;
        assert_eq!(status, 201, "the teammate registers a root key: {body}");
        let key_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
        let (status, body) = self
            .post(
                &format!("/v1/workspaces/{}/work-hosts", self.workspace),
                &self.other_access,
                json!({ "scope": "member", "type": "workd", "displayName": "동료 맥",
                        "publicKey": ed25519_host_key(HOST_SEED + 1) }),
            )
            .await;
        assert_eq!(status, 201, "the teammate registers a Mac: {body}");
        let host = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();
        let project = format!("fld_{}", &Uuid::new_v4().simple().to_string()[..20]);
        let question = format!("fld_{}", &Uuid::new_v4().simple().to_string()[..20]);
        self.announce(host, &project, &question).await;
        self.host_online(host, true).await;
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(self.workspace)
        .bind(self.channel)
        .bind(self.teammate)
        .execute(&self.su)
        .await
        .expect("the teammate is in the room");
        TeammateWorld {
            key,
            key_id,
            host,
            project,
            question,
        }
    }

    /// An agent member. `owner_only` gives it a harness and an owner (the one
    /// transition migration 089 allows).
    async fn agent(&self, owner: Uuid, harness: Option<&str>) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'agent', 'Claude', $3)",
        )
        .bind(id)
        .bind(self.workspace)
        .bind(format!("kwak-claude-{}", id.simple()))
        .execute(&self.su)
        .await
        .expect("agent member");
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id) \
             VALUES ($1, $2, 'personal', 'https://personal.invalid/disabled', $3)",
        )
        .bind(id)
        .bind(self.workspace)
        .bind(owner)
        .execute(&self.su)
        .await
        .expect("agent row");
        if let Some(harness) = harness {
            sqlx::query(
                "UPDATE agent SET invocation_scope = 'owner_only', subscription_harness = $3 \
                  WHERE workspace_id = $1 AND member_id = $2",
            )
            .bind(self.workspace)
            .bind(id)
            .bind(harness)
            .execute(&self.su)
            .await
            .expect("owner_only agent");
        }
        id
    }

    /// A message the person posted, as the room sees it.
    async fn say(&self, bearer: &str, channel: Uuid, root: Option<Uuid>, text: &str) -> Uuid {
        let (status, body) = self
            .post(
                &format!(
                    "/v1/workspaces/{}/channels/{channel}/messages",
                    self.workspace
                ),
                bearer,
                json!({ "clientMsgId": Uuid::new_v4(), "body": text, "rootId": root }),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        let id = body["message"]["id"]
            .as_str()
            .or(body["id"].as_str())
            .unwrap_or_else(|| panic!("message id in {body}"));
        Uuid::parse_str(id).unwrap()
    }
}

struct TeammateWorld {
    key: DeviceKeyPair,
    key_id: Uuid,
    host: Uuid,
    project: String,
    question: String,
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn flag_off_refuses_by_name_and_writes_nothing() {
    let _lock = test_lock().await;
    let s = stage(false).await;
    s.host_online(s.host, true).await;
    let (status, body, _) = s.spawn(&s.req()).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("signed_spawn_disabled"));
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_spawn_is_one_control_and_never_a_message() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    // A message the owner already wrote, to call from.
    let origin = s
        .say(&s.access, s.channel, None, "@kwak-claude 빌드 봐 줘")
        .await;
    let before = s.message_path().await;

    let mut req = s.req();
    req.origin = Some(origin);
    req.agent = Some(s.agent(s.person, Some("claude_code")).await);
    let (status, body, nonce) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["replayed"], false);
    let control = &body["workControl"];
    assert_eq!(control["kind"], "spawn");
    assert_eq!(control["status"], "dispatched");
    assert_eq!(control["targetHostId"], json!(s.host.to_string()));
    assert_eq!(control["requesterMemberId"], json!(s.person.to_string()));
    assert_eq!(control["payload"]["prompt"], json!(req.prompt));
    assert_eq!(control["payload"]["tool"], "claude");
    assert!(control.get("sessionId").is_none(), "no session exists yet");
    let control_id = Uuid::parse_str(control["id"].as_str().unwrap()).unwrap();

    // The message path is untouched: no `channel_seq` bump, no message, no
    // outbox row — a spawn is a work-control, not a chat message.
    assert_eq!(
        s.message_path().await,
        before,
        "channel_seq · message · outbox unchanged"
    );

    // The signature columns, the spent nonce, the provenance and audit rows.
    let (agent, folder, thread, origin_col, key, human_nonce): StoredSpawn = sqlx::query_as(
        "SELECT human_spawn_agent_member_id, human_spawn_folder_id, human_spawn_thread_root_id, \
                human_spawn_origin_message_id, device_key_id, human_nonce \
           FROM work_control WHERE id = $1",
    )
    .bind(control_id)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(agent, req.agent);
    assert_eq!(folder.as_deref(), Some(s.question.as_str()));
    assert_eq!((thread, origin_col), (None, Some(origin)));
    assert_eq!((key, human_nonce), (Some(s.phone_id), Some(nonce)));
    assert_eq!(s.spent_nonces().await, 1);
    let provenance: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM action_signature \
          WHERE workspace_id = $1 AND entity_type = 'work_control' AND entity_id = $2 AND alg = 'p256'",
    )
    .bind(s.workspace)
    .bind(control_id)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(provenance, 1);
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'work.spawn.requested' \
            AND target_id = $2",
    )
    .bind(s.workspace)
    .bind(control_id)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(
        !audit.to_string().contains(&req.prompt),
        "the audit row says what was asked, never the prompt: {audit}"
    );

    // The host's poll carries the envelope workd verifies — folder and agent,
    // and the whole prompt for the host alone.
    let poll = s.poll().await;
    let relayed = poll["workControls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == json!(control_id.to_string()))
        .cloned()
        .expect("the spawn is dispatched to the host");
    assert_eq!(relayed["payload"]["prompt"], json!(req.prompt));
    assert_eq!(relayed["humanSignature"]["folderId"], json!(s.question));
    assert_eq!(
        relayed["humanSignature"]["agentMemberId"],
        json!(req.agent.unwrap().to_string())
    );
    assert_eq!(
        relayed["humanSignature"]["originMessageId"],
        json!(origin.to_string())
    );
    assert!(relayed["humanSignature"].get("threadRootId").is_none());

    // A harness spawn (「내 도구」) names no agent: nothing about one is stored.
    let mut tool = s.req();
    tool.folder = s.project.clone();
    let (status, body, _) = s.spawn(&tool).await;
    assert_eq!(status, 201, "{body}");
    let stored: Option<Uuid> =
        sqlx::query_scalar("SELECT human_spawn_agent_member_id FROM work_control WHERE id = $1")
            .bind(Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap())
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(stored, None, "a harness spawn has no agent member");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_owners_mac_runs_the_session_the_spawn_asked_for() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let req = s.req();
    // The desktop (the root key itself) signs this one.
    let (status, body, _) = s.spawn_as(&s.mac_signer(), &s.access, s.host, &req).await;
    assert_eq!(status, 201, "{body}");
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();

    // The host creates the session the control describes — same channel, host,
    // tool and label — and the OWNER (the human requester) owns it.
    let (status, created) = s
        .host_request(
            "POST",
            &format!("/v1/workspaces/{}/work-sessions", s.workspace),
            Some(
                json!({ "channelId": s.channel, "hostId": s.host, "tool": req.tool,
                         "label": req.label, "controlId": control }),
            ),
        )
        .await;
    assert_eq!(status, 201, "the host opens the session: {created}");
    let session = Uuid::parse_str(created["workSession"]["id"].as_str().unwrap()).unwrap();
    let owner: Uuid = sqlx::query_scalar("SELECT member_id FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert_eq!(owner, s.person);

    // A control that does not describe it is not dispatchable (another label).
    let (status, _) = s
        .host_request(
            "POST",
            &format!("/v1/workspaces/{}/work-sessions", s.workspace),
            Some(
                json!({ "channelId": s.channel, "hostId": s.host, "tool": req.tool,
                         "label": "다른 제목", "controlId": control }),
            ),
        )
        .await;
    assert_eq!(status, 409);

    // The ack binds that session and settles the control.
    let (status, acked) = s
        .host_request(
            "POST",
            &format!("/v1/workspaces/{}/work-controls/{control}/ack", s.workspace),
            Some(json!({ "ok": true, "sessionId": session })),
        )
        .await;
    assert_eq!(status, 200, "{acked}");
    assert_eq!(acked["workControl"]["status"], "acked");

    // The room hears that a task started — never the owner's whole prompt.
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(s.workspace)
    .bind(&req.prompt)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(leaked, 0, "no outbox event carries the prompt");
    let acked_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 \
            AND payload::text LIKE '%work.control.acked%'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert!(
        acked_events >= 1,
        "the ack is announced (without the prompt)"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn no_one_but_the_owner_reaches_the_owners_mac() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let t = s.teammate_world().await;
    let teammate = Signer {
        key: &t.key,
        key_id: t.key_id,
        member: s.teammate,
    };

    // 1. The teammate holds a valid key and signs a perfectly valid statement
    // for the OWNER'S Mac and the OWNER'S folder: no host of theirs issued that
    // folder, so there is no path to the owner's Mac.
    let mut onto_owner = s.req();
    onto_owner.folder = s.question.clone();
    let (status, body, _) = s
        .spawn_as(&teammate, &s.other_access, s.host, &onto_owner)
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(code(&body), Some("spawn_folder_not_found"));

    // 2. … naming the owner's host as a hint does not help: the hint only
    // narrows the teammate's OWN hosts.
    let mut hinted = s.req();
    hinted.folder = t.question.clone();
    hinted.hint = Some(s.host);
    let (status, body, _) = s
        .spawn_as(&teammate, &s.other_access, s.host, &hinted)
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(code(&body), Some("spawn_host_not_found"));

    // 3. The owner cannot be sent to the teammate's Mac either: the teammate's
    // folder id is nothing on the owner's hosts.
    let mut onto_teammate = s.req();
    onto_teammate.folder = t.question.clone();
    let (status, body, _) = s.spawn(&onto_teammate).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(code(&body), Some("spawn_folder_not_found"));
    let mut hinted_owner = s.req();
    hinted_owner.folder = t.project.clone();
    hinted_owner.hint = Some(t.host);
    let (status, body, _) = s.spawn(&hinted_owner).await;
    assert_eq!(status, 404, "{body}");

    // 4. A workspace-scoped host (a team machine) is no one's personal Mac.
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-hosts", s.workspace),
            &s.access,
            json!({ "scope": "workspace", "type": "workd", "displayName": "팀 서버",
                    "publicKey": ed25519_host_key(HOST_SEED + 2) }),
        )
        .await;
    // A member may not register one; an admin would. Either way it is no target.
    if status == 201 {
        let team = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();
        let team_folder = format!("fld_{}", &Uuid::new_v4().simple().to_string()[..20]);
        s.announce(team, &team_folder, &format!("{team_folder}q"))
            .await;
        s.host_online(team, true).await;
        let mut onto_team = s.req();
        onto_team.folder = team_folder;
        let (status, body, _) = s.spawn(&onto_team).await;
        assert_eq!(status, 404, "{body}");
    }

    assert_eq!(s.spawn_controls().await, 0, "no control reached any Mac");
    assert_eq!(s.spent_nonces().await, 0, "and no nonce was spent");
    // The owner's own spawn still works, and lands on the owner's Mac.
    let (status, body, _) = s.spawn(&s.req()).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["workControl"]["targetHostId"],
        json!(s.host.to_string())
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_spawns_nothing() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let agent = s.agent(s.person, None).await;
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", s.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 't5-conformance')",
    )
    .bind(s.workspace)
    .bind(agent)
    .bind(&token)
    .execute(&s.su)
    .await
    .expect("seed agent bearer");

    // Even carrying the owner's valid statement, an agent bearer is not a person.
    let (status, body, _) = s
        .spawn_as(&s.phone_signer(), &token, s.host, &s.req())
        .await;
    assert!(
        status == 403 || status == 401,
        "an agent bearer is refused: {status} {body}"
    );
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
    // The agent's own door still opens only for kill (ADR-0188 D3): a spawn
    // control addressed to the owner's Mac by an agent is refused as before.
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_offline_or_revoked_mac_is_refused_before_the_nonce_is_spent() {
    let _lock = test_lock().await;
    let s = stage(true).await;

    // Offline: the Mac has not heartbeated within the window.
    s.host_online(s.host, false).await;
    let req = s.req();
    let nonce = Uuid::new_v4();
    let issued = now_ms();
    let signature = s.sign_for(
        &s.phone_signer(),
        s.host,
        &req,
        nonce,
        issued,
        issued + 300_000,
    );
    let (status, body) = s
        .post(
            &s.spawns_path(),
            &s.access,
            Stage::body(&req, signature.clone()),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("work_host_offline"));
    assert_eq!((s.spawn_controls().await, s.spent_nonces().await), (0, 0));

    // The same signed statement goes through once the Mac is back: the refusal
    // did not spend it.
    s.host_online(s.host, true).await;
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&req, signature))
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(s.spawn_controls().await, 1);

    // Revoked: the host (and its folders) are gone; the owner is told so.
    let (status, body) = s
        .call(
            reqwest::Method::DELETE,
            &format!("/v1/workspaces/{}/work-hosts/{}", s.workspace, s.host),
            &s.access,
            None,
        )
        .await;
    assert!(status == 200 || status == 204, "revoke: {status} {body}");
    let (status, body, _) = s.spawn(&s.req()).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(code(&body), Some("spawn_host_not_found"));
    assert_eq!(s.spawn_controls().await, 1, "the revoked Mac took nothing");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn no_signature_a_stale_one_or_a_spent_nonce_is_refused() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let req = s.req();

    // No signature at all.
    let (status, body) = s
        .post(
            &s.spawns_path(),
            &s.access,
            json!({ "tool": req.tool, "label": req.label, "prompt": req.prompt,
                    "channelId": req.channel }),
        )
        .await;
    assert!(status == 400 || status == 422, "{status} {body}");
    // A signature of the wrong bytes.
    let nonce = Uuid::new_v4();
    let issued = now_ms();
    let mut forged = s.sign_for(
        &s.phone_signer(),
        s.host,
        &req,
        nonce,
        issued,
        issued + 300_000,
    );
    forged["signature"] = json!(s.phone.sign(b"not the statement"));
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&req, forged))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_invalid"));
    // A statement that expired an hour ago.
    let old = now_ms() - 3_600_000;
    let stale = s.sign_for(
        &s.phone_signer(),
        s.host,
        &req,
        Uuid::new_v4(),
        old,
        old + 300_000,
    );
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&req, stale))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_expired"));
    assert_eq!((s.spawn_controls().await, s.spent_nonces().await), (0, 0));

    // The first use is accepted and spends the nonce; the very same request
    // again is a retry (200, the same control), not a second spawn.
    let signature = s.sign_for(
        &s.phone_signer(),
        s.host,
        &req,
        nonce,
        issued,
        issued + 300_000,
    );
    let (status, first) = s
        .post(
            &s.spawns_path(),
            &s.access,
            Stage::body(&req, signature.clone()),
        )
        .await;
    assert_eq!(status, 201, "{first}");
    let (status, again) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&req, signature))
        .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["replayed"], true);
    assert_eq!(again["workControl"]["id"], first["workControl"]["id"]);
    assert_eq!(s.spawn_controls().await, 1);

    // The nonce on a DIFFERENT spawn is a replay, never a second control.
    let mut other = s.req();
    other.prompt = "이번엔 다른 일을 시켜 줘".to_string();
    let signature = s.sign_for(
        &s.phone_signer(),
        s.host,
        &other,
        nonce,
        issued,
        issued + 300_000,
    );
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&other, signature))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("spawn_nonce_reused"));
    assert_eq!(s.spawn_controls().await, 1);
    assert_eq!(s.spent_nonces().await, 1);

    // A nonce spent by a statement that left no control behind (a host
    // registration, say) is spent all the same: the barrier is the nonce table,
    // not the ledger.
    let taken = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO human_control_nonce (workspace_id, nonce, device_key_id, kind, expires_at) \
         VALUES ($1, $2, $3, 'host_register', now() + interval '10 minutes')",
    )
    .bind(s.workspace)
    .bind(taken)
    .bind(s.phone_id)
    .execute(&s.su)
    .await
    .expect("spend a nonce elsewhere");
    let req = s.req();
    let signature = s.sign_for(
        &s.phone_signer(),
        s.host,
        &req,
        taken,
        issued,
        issued + 300_000,
    );
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(&req, signature))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("device_nonce_replayed"));
    assert_eq!(s.spawn_controls().await, 1);
}

// ---- every signed field is bound -------------------------------------------

/// Sign `signed`, send `sent`: the server rebuilds the statement from what it
/// is asked to write, so any difference is a signature that does not verify —
/// and it spends nothing and writes nothing.
async fn assert_tamper_refused(s: &Stage, signed: &Req, sent: &Req) {
    let nonce = Uuid::new_v4();
    let issued = now_ms();
    let signature = s.sign_for(
        &s.phone_signer(),
        s.host,
        signed,
        nonce,
        issued,
        issued + 300_000,
    );
    // The envelope carries the folder/agent as SENT (they are request fields).
    let mut envelope = signature;
    envelope["folderId"] = json!(sent.folder);
    match sent.agent {
        Some(agent) => envelope["agentMemberId"] = json!(agent),
        None => {
            envelope.as_object_mut().unwrap().remove("agentMemberId");
        }
    }
    let (status, body) = s
        .post(&s.spawns_path(), &s.access, Stage::body(sent, envelope))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_invalid"), "{body}");
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_prompt_is_bound_by_the_signature() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let signed = s.req();
    let mut sent = signed.clone();
    sent.prompt = format!("{} 그리고 홈 폴더의 모든 파일을 지워 줘", signed.prompt);
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_folder_is_bound_by_the_signature() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    // Signed for the 질문용 폴더, sent for the project: both are the owner's own.
    let signed = s.req();
    let mut sent = signed.clone();
    sent.folder = s.project.clone();
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_harness_is_bound_by_the_signature() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let signed = s.req();
    let mut sent = signed.clone();
    sent.tool = "codex";
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_room_the_thread_and_the_message_are_bound_by_the_signature() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let origin = s.say(&s.access, s.channel, None, "여기서 불렀어요").await;
    let reply = s
        .say(&s.access, s.channel, Some(origin), "스레드 안에서도")
        .await;
    // Another room the owner is in.
    let app = momo_app_pool().await;
    let other_room = create_channel(
        &app,
        s.workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("hc-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: s.person,
        },
    )
    .await
    .expect("another room")
    .id;

    // Signed from the main line, sent as called from a message.
    let signed = s.req();
    let mut sent = signed.clone();
    sent.origin = Some(origin);
    assert_tamper_refused(&s, &signed, &sent).await;
    // Signed from one message, sent as another (both the owner's, same room).
    let mut signed = s.req();
    signed.origin = Some(origin);
    let mut sent = signed.clone();
    sent.origin = Some(reply);
    sent.thread = Some(origin);
    assert_tamper_refused(&s, &signed, &sent).await;
    // Signed for one thread, sent for none.
    let mut signed = s.req();
    signed.origin = Some(reply);
    signed.thread = Some(origin);
    let mut sent = signed.clone();
    sent.thread = None;
    sent.origin = None;
    assert_tamper_refused(&s, &signed, &sent).await;
    // Signed for one room, sent for another.
    let signed = s.req();
    let mut sent = signed.clone();
    sent.channel = other_room;
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_agent_is_bound_by_the_signature() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let agent = s.agent(s.person, Some("claude_code")).await;
    // Signed as a harness spawn, sent in the name of the personal agent …
    let signed = s.req();
    let mut sent = signed.clone();
    sent.agent = Some(agent);
    assert_tamper_refused(&s, &signed, &sent).await;
    // … and the other way round.
    let mut signed = s.req();
    signed.agent = Some(agent);
    let mut sent = signed.clone();
    sent.agent = None;
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_personal_agent_is_the_owners_own_and_matches_the_harness() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let t = s.teammate_world().await;
    let _ = t;

    // The teammate's personal agent, a workspace agent, a human, a made-up id.
    let others = s.agent(s.teammate, Some("claude_code")).await;
    let workspace_agent = s.agent(s.person, None).await;
    for (name, agent) in [
        ("someone else's personal agent", others),
        ("a workspace agent", workspace_agent),
        ("a human member", s.teammate),
        ("an id nothing has", Uuid::new_v4()),
    ] {
        let mut req = s.req();
        req.agent = Some(agent);
        let (status, body, _) = s.spawn(&req).await;
        assert_eq!(status, 403, "{name}: {body}");
        assert_eq!(code(&body), Some("spawn_agent_not_allowed"), "{name}");
    }
    // A Codex personal agent cannot launch Claude, nor the Claude one Codex.
    let codex_agent = s.agent(s.person, Some("codex")).await;
    let claude_agent = s.agent(s.person, Some("claude_code")).await;
    let mut req = s.req();
    req.agent = Some(codex_agent);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 403, "{body}");
    let mut req = s.req();
    req.tool = "codex";
    req.agent = Some(claude_agent);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);

    // The owner's own, with the matching harness, is accepted.
    let mut req = s.req();
    req.agent = Some(claude_agent);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    let mut req = s.req();
    req.tool = "codex";
    req.agent = Some(codex_agent);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_thread_and_message_must_be_the_owners_own_in_this_room() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let t = s.teammate_world().await;
    let _ = &t;
    let mine = s.say(&s.access, s.channel, None, "내 메시지").await;
    let mine_reply = s.say(&s.access, s.channel, Some(mine), "내 답글").await;
    let theirs = s
        .say(&s.other_access, s.channel, None, "동료의 메시지")
        .await;
    let app = momo_app_pool().await;
    let other_room = create_channel(
        &app,
        s.workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("hc-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: s.person,
        },
    )
    .await
    .expect("another room")
    .id;
    let elsewhere = s
        .say(&s.access, other_room, None, "다른 방의 내 메시지")
        .await;

    let refused: [(&str, Option<Uuid>, Option<Uuid>); 5] = [
        // A teammate's message is not the owner's instruction (ADR-0188 D3).
        ("a teammate's message", None, Some(theirs)),
        ("a message of another room", None, Some(elsewhere)),
        ("a message that does not exist", None, Some(Uuid::new_v4())),
        // The statement must name the thread the message is in.
        ("a reply claimed as top-level", None, Some(mine_reply)),
        (
            "a top-level message claimed as a thread's",
            Some(mine_reply),
            Some(mine),
        ),
    ];
    for (name, thread, origin) in refused {
        let mut req = s.req();
        req.thread = thread;
        req.origin = origin;
        let (status, body, _) = s.spawn(&req).await;
        assert_eq!(status, 400, "{name}: {body}");
        assert_eq!(code(&body), Some("spawn_origin_invalid"), "{name}");
    }
    // A thread root that is itself a reply, or of another room, is no thread.
    for thread in [mine_reply, elsewhere] {
        let mut req = s.req();
        req.thread = Some(thread);
        let (status, body, _) = s.spawn(&req).await;
        assert_eq!(status, 400, "{body}");
    }
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);

    // The owner's own message, and their own reply in its thread, are fine.
    let mut req = s.req();
    req.origin = Some(mine);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    let mut req = s.req();
    req.origin = Some(mine_reply);
    req.thread = Some(mine);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    // A spawn from a room the owner is not in is refused by name.
    let stranger_room = create_channel(
        &app,
        s.workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("hc-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: s.teammate,
        },
    )
    .await
    .expect("a room the owner is not in")
    .id;
    let mut req = s.req();
    req.channel = stranger_room;
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("spawn_channel_member_only"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_full_pool_is_refused_before_the_nonce_is_spent() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    // One session already running on the Mac, and the pool holds one.
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-sessions", s.workspace),
            &s.access,
            json!({ "channelId": s.channel, "hostId": s.host, "tool": "claude", "label": "먼저" }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    sqlx::query(
        "UPDATE work_pool SET max_active = 1, per_member_soft_limit = 1 WHERE workspace_id = $1",
    )
    .bind(s.workspace)
    .execute(&s.su)
    .await
    .expect("shrink the pool");
    let (status, body, _) = s.spawn(&s.req()).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn shell_and_unregistered_tools_are_refused() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let mut shell = s.req();
    shell.tool = "shell";
    let (status, body, _) = s.spawn(&shell).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("remote_host_shell_refused"));
    let mut unknown = s.req();
    unknown.tool = "nothing-registered";
    let (status, body, _) = s.spawn(&unknown).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

// ---- the request is judged before anything is read -------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn malformed_prompts_are_refused_before_the_nonce_is_spent() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    for (name, prompt) in [
        ("empty", String::new()),
        ("blank", "   \n ".to_string()),
        ("an adapter command", "/logout".to_string()),
        ("not NFC", "cafe\u{0301}".to_string()),
        ("too long", "가".repeat(32_769)),
    ] {
        let mut req = s.req();
        req.prompt = prompt;
        let nonce = Uuid::new_v4();
        let issued = now_ms();
        // The signer builds NFC bytes; the route must refuse before verifying.
        let signature = s.sign_for(
            &s.phone_signer(),
            s.host,
            &req,
            nonce,
            issued,
            issued + 300_000,
        );
        let (status, body) = s
            .post(&s.spawns_path(), &s.access, Stage::body(&req, signature))
            .await;
        assert_eq!(status, 400, "{name}: {body}");
    }
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
    // A prompt with many lines and Korean text is a prompt.
    let mut req = s.req();
    req.prompt = "첫 줄\n둘째 줄\n\n셋째 줄 — 길어도 괜찮아요".to_string();
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_ledger_itself_refuses_an_unsigned_prompt_and_a_resume_without_an_agent() {
    // The database is the invariant, the route is the sentence (migration 122):
    // even a writer that skipped the route cannot leave an unsigned prompt, a
    // new-work spawn with a stray session shape, or a resume with no agent.
    let _lock = test_lock().await;
    let s = stage(true).await;
    let insert = |extra_columns: &'static str, extra_values: &'static str, payload: Value| {
        let sql = format!(
            "INSERT INTO work_control (workspace_id, channel_id, requester_member_id, \
                target_host_id, kind, payload, status{extra_columns}) \
             VALUES ($1, $2, $3, $4, 'spawn', $5, 'dispatched'{extra_values})"
        );
        let su = s.su.clone();
        let (workspace, channel, person, host) = (s.workspace, s.channel, s.person, s.host);
        async move {
            sqlx::query(&sql)
                .bind(workspace)
                .bind(channel)
                .bind(person)
                .bind(host)
                .bind(payload)
                .execute(&su)
                .await
        }
    };
    // An agent bearer's spawn stays `{tool,label}`: a prompt without a signature
    // is not a thing the ledger can hold.
    let unsigned_prompt = insert(
        "",
        "",
        json!({"tool": "claude", "label": "x", "prompt": "서명 없는 프롬프트"}),
    )
    .await;
    assert!(unsigned_prompt.is_err(), "an unsigned prompt is refused");
    // The plain agent spawn is unchanged.
    let plain = insert("", "", json!({"tool": "claude", "label": "x"})).await;
    assert!(plain.is_ok(), "{plain:?}");
    // A signed spawn: a resume (no prompt) needs its agent; a new task does not.
    let signed_columns: &'static str = ", device_key_id, human_instance_id, human_nonce, \
         human_issued_at_ms, human_expires_at_ms, human_spawn_folder_id, human_signature";
    let signed_values = format!(
        ", '{}', 'i', '{}', 1, 2, 'f', '{}=='",
        s.phone_id,
        Uuid::new_v4(),
        "A".repeat(86)
    );
    let signed_values: &'static str = Box::leak(signed_values.into_boxed_str());
    let resume_without_agent = insert(
        signed_columns,
        signed_values,
        json!({"tool": "claude", "label": "x"}),
    )
    .await;
    assert!(
        resume_without_agent.is_err(),
        "a signed resume with no agent is refused"
    );
    // A prompt beyond the `input` bound, though signed.
    let too_long = insert(
        signed_columns,
        Box::leak(
            format!(
                ", '{}', 'i', '{}', 1, 2, 'f', '{}=='",
                s.phone_id,
                Uuid::new_v4(),
                "A".repeat(86)
            )
            .into_boxed_str(),
        ),
        json!({"tool": "claude", "label": "x", "prompt": "가".repeat(32_769)}),
    )
    .await;
    assert!(too_long.is_err(), "the prompt has the `input` bound");
    let new_task_without_agent = insert(
        signed_columns,
        Box::leak(
            format!(
                ", '{}', 'i', '{}', 1, 2, 'f', '{}=='",
                s.phone_id,
                Uuid::new_v4(),
                "A".repeat(86)
            )
            .into_boxed_str(),
        ),
        json!({"tool": "claude", "label": "x", "prompt": "에이전트 없는 새 작업"}),
    )
    .await;
    assert!(
        new_task_without_agent.is_ok(),
        "a new task may name no agent: {new_task_without_agent:?}"
    );
    // The thread and the message belong to a new task only.
    let resume_with_position = insert(
        ", device_key_id, human_instance_id, human_nonce, human_issued_at_ms, \
           human_expires_at_ms, human_spawn_folder_id, human_spawn_agent_member_id, \
           human_spawn_origin_message_id, human_signature",
        Box::leak(
            format!(
                ", '{}', 'i', '{}', 1, 2, 'f', '{}', '{}', '{}=='",
                s.phone_id,
                Uuid::new_v4(),
                Uuid::new_v4(),
                Uuid::new_v4(),
                "A".repeat(86)
            )
            .into_boxed_str(),
        ),
        json!({"tool": "claude", "label": "x"}),
    )
    .await;
    assert!(
        resume_with_position.is_err(),
        "a resume names no thread or message"
    );
}
