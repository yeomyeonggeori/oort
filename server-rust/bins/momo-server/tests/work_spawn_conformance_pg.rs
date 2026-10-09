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
//! | `a_personal_agent_is_turned_on_by_its_owner_and_only_the_owner_can_call_it` (#3591) | drop the `owner_human_id` / `owner_only` mark of `mark_personal_agent_in_tx`, or the owner filter of `personal_agent_ok_in_tx` |
//! | `an_alias_is_unique_and_nobody_touches_another_persons_personal_agent` (#3591) | drop the `owner_human_id` predicate of `find_owned_personal_agent_in_tx` / `mark_personal_agent_in_tx`, the `DuplicateHandle` arm, `require_human` or the one-per-harness lookup |
//! | `a_switched_off_personal_agent_cannot_be_called_and_keeps_its_history` (#3591) | drop `status = 'suspended'` from the off switch, or the `personal_disabled_at` guard of turning back on |
//! | `the_roster_reads_a_personal_agent_per_viewer` (#3591) | drop the owner comparison of `apply_personal_facts` |
//! | `conversion_is_for_owner_only_agents_with_nothing_attached` (#3591 M1) | drop the `owner_only` / attached-connection checks of `mark_personal_agent_in_tx` |
//! | `a_deleted_personal_agent_does_not_block_turning_on_again` (#3591 M2) | drop the delete branch of `personal_agent_member_guard` (migration 123) |
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
                label: req.label,
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
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
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

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_title_is_bound_by_the_signature() {
    // M-2: the card title is signed too — the server cannot retitle a task.
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let signed = s.req();
    let mut sent = signed.clone();
    sent.label = "전혀 다른 제목";
    assert_tamper_refused(&s, &signed, &sent).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_requests_with_one_nonce_at_once_make_exactly_one_control() {
    // M-3: the same signed statement sent twice concurrently.
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
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
    let body = Stage::body(&req, signature);
    let path = s.spawns_path();
    let (a, b) = tokio::join!(
        s.post(&path, &s.access, body.clone()),
        s.post(&path, &s.access, body.clone())
    );
    let mut statuses = [a.0, b.0];
    statuses.sort_unstable();
    assert!(
        statuses == [200, 201] || statuses == [201, 409],
        "one creates, the other is a retry or a replay: {a:?} {b:?}"
    );
    assert_eq!(s.spawn_controls().await, 1, "exactly one work_control row");
    assert_eq!(s.spent_nonces().await, 1);
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_control WHERE workspace_id = $1 AND human_nonce = $2",
    )
    .bind(s.workspace)
    .bind(nonce)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(rows, 1);
    let polled = s.poll().await;
    let pending = polled["workControls"].as_array().unwrap().len();
    assert_eq!(pending, 1, "the host is handed one control");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn control_characters_are_refused_before_the_signature() {
    // L-2: U+0000 and friends in the prompt or the title are a 400 by name,
    // never a 500 from the database and never a spent nonce.
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    for (what, prompt, label, expected) in [
        (
            "NUL in the prompt",
            "앞\u{0}뒤",
            "제목",
            "spawn_prompt_invalid",
        ),
        (
            "ESC in the prompt",
            "앞\u{1b}[31m뒤",
            "제목",
            "spawn_prompt_invalid",
        ),
        (
            "NUL in the title",
            "질문",
            "제\u{0}목",
            "spawn_label_invalid",
        ),
        (
            "newline in the title",
            "질문",
            "제\n목",
            "spawn_label_invalid",
        ),
    ] {
        // A signer would refuse these bytes; send a signature over the clean
        // request beside the bad text — the route must refuse before it looks.
        let clean = s.req();
        let mut req = s.req();
        req.prompt = prompt.to_string();
        req.label = label;
        let nonce = Uuid::new_v4();
        let issued = now_ms();
        let signature = s.sign_for(
            &s.phone_signer(),
            s.host,
            &clean,
            nonce,
            issued,
            issued + 300_000,
        );
        let (status, body) = s
            .post(&s.spawns_path(), &s.access, Stage::body(&req, signature))
            .await;
        assert_eq!(status, 400, "{what}: {body}");
        assert_eq!(code(&body), Some(expected), "{what}");
    }
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
    // Tabs and line breaks in a prompt are text.
    let mut req = s.req();
    req.prompt = "표:\n\t열1\t열2\n끝".to_string();
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
}

// ---------------------------------------------------------------------------
// #3591 P2 — personal agents (ADR-0198 증보 1 D7)
// ---------------------------------------------------------------------------

impl Stage {
    fn personal_path(&self) -> String {
        format!("/v1/workspaces/{}/personal-agents", self.workspace)
    }

    async fn turn_on(&self, bearer: &str, body: Value) -> (u16, Value) {
        self.post(&self.personal_path(), bearer, body).await
    }

    async fn turn_off(&self, bearer: &str, agent: Uuid) -> (u16, Value) {
        self.post(
            &format!("{}/{agent}/disable", self.personal_path()),
            bearer,
            json!({}),
        )
        .await
    }

    async fn on(&self, bearer: &str, harness: &str, alias: &str) -> Uuid {
        let (status, body) = self
            .turn_on(bearer, json!({ "harness": harness, "alias": alias }))
            .await;
        assert_eq!(status, 201, "{body}");
        Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap()
    }

    async fn members_named(&self, handle: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id = $1 AND handle = $2")
            .bind(self.workspace)
            .bind(handle)
            .fetch_one(&self.su)
            .await
            .unwrap()
    }

    async fn member_status(&self, id: Uuid) -> String {
        sqlx::query_scalar("SELECT status::text FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(self.workspace)
            .bind(id)
            .fetch_one(&self.su)
            .await
            .unwrap()
    }

    async fn display_name(&self, id: Uuid) -> String {
        sqlx::query_scalar("SELECT display_name FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(self.workspace)
            .bind(id)
            .fetch_one(&self.su)
            .await
            .unwrap()
    }
}

fn unique_alias(prefix: &str) -> String {
    format!("{prefix}-{}", &Uuid::new_v4().simple().to_string()[..8])
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_personal_agent_is_turned_on_by_its_owner_and_only_the_owner_can_call_it() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let t = s.teammate_world().await;
    let alias = unique_alias("kwak-claude");

    // A plain member (not an admin) turns their own harness on.
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": alias }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["reused"], json!(false));
    assert_eq!(body["agent"]["handle"], json!(alias));
    assert_eq!(body["agent"]["enabled"], json!(true));
    let owner_name = s.display_name(s.person).await;
    assert_eq!(
        body["agent"]["label"],
        json!(format!("{owner_name}의 개인 에이전트"))
    );
    let agent = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();

    // The row is the owner_only shape T5 already accepts, and nothing else:
    // no hosted connection, no token, no profile, no channel membership.
    let (kind, status_text, scope, harness, personal, owner): (
        String,
        String,
        String,
        Option<String>,
        bool,
        Option<Uuid>,
    ) = sqlx::query_as(
        "SELECT m.kind::text, m.status::text, a.invocation_scope, a.subscription_harness, \
                a.personal_agent, a.owner_human_id \
           FROM member m JOIN agent a ON a.member_id = m.id WHERE m.id = $1",
    )
    .bind(agent)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(
        (kind.as_str(), status_text.as_str(), scope.as_str()),
        ("agent", "active", "owner_only")
    );
    assert_eq!(harness.as_deref(), Some("claude_code"));
    assert!(personal);
    assert_eq!(owner, Some(s.person));
    for (name, sql) in [
        (
            "hosted connection",
            "SELECT count(*) FROM hosted_agent_connection WHERE workspace_id = $1 AND agent_member_id = $2",
        ),
        (
            "token",
            "SELECT count(*) FROM token WHERE workspace_id = $1 AND actor_member_id = $2",
        ),
        (
            "agent profile",
            "SELECT count(*) FROM agent_profile WHERE workspace_id = $1 AND agent_member_id = $2",
        ),
        (
            "channel membership",
            "SELECT count(*) FROM membership WHERE workspace_id = $1 AND member_id = $2",
        ),
    ] {
        let rows: i64 = sqlx::query_scalar(sql)
            .bind(s.workspace)
            .bind(agent)
            .fetch_one(&s.su)
            .await
            .unwrap();
        assert_eq!(rows, 0, "a personal agent has no {name}");
    }
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'personal_agent.enabled'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    // The owner's signed spawn naming it is accepted.
    let mut owners = s.req();
    owners.agent = Some(agent);
    let (status, body, _) = s.spawn(&owners).await;
    assert_eq!(status, 201, "{body}");
    let controls = s.spawn_controls().await;
    assert_eq!(controls, 1);

    // A teammate with a valid key, a valid statement and their own Mac cannot
    // name the owner's agent: 0 new controls, 0 spent nonces.
    let teammate = Signer {
        key: &t.key,
        key_id: t.key_id,
        member: s.teammate,
    };
    let nonces = s.spent_nonces().await;
    let mut theirs = s.req();
    theirs.folder = t.question.clone();
    theirs.agent = Some(agent);
    let (status, body, _) = s
        .spawn_as(&teammate, &s.other_access, t.host, &theirs)
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("spawn_agent_not_allowed"));
    assert_eq!(s.spawn_controls().await, controls, "no teammate call");
    assert_eq!(s.spent_nonces().await, nonces);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_alias_is_unique_and_nobody_touches_another_persons_personal_agent() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let members_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id = $1")
            .bind(s.workspace)
            .fetch_one(&s.su)
            .await
            .unwrap();

    // 1. Duplicate alias: another person's, in any case spelling, is refused.
    for taken in [alias.clone(), alias.to_uppercase()] {
        let (status, body) = s
            .turn_on(
                &s.other_access,
                json!({ "harness": "claude_code", "alias": taken }),
            )
            .await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(code(&body), Some("personal_agent_alias_taken"));
    }
    // … and so is a human's handle.
    let human_handle: String =
        sqlx::query_scalar("SELECT handle FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(s.workspace)
            .bind(s.person)
            .fetch_one(&s.su)
            .await
            .unwrap();
    let (status, body) = s
        .turn_on(
            &s.other_access,
            json!({ "harness": "codex", "alias": human_handle }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(s.members_named(&alias).await, 1);

    // 2. Nobody else's agent can be turned off, converted or listed.
    let (status, body) = s.turn_off(&s.other_access, agent).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(code(&body), Some("personal_agent_not_found"));
    assert_eq!(s.member_status(agent).await, "active");
    let (status, body) = s
        .turn_on(
            &s.other_access,
            json!({ "harness": "claude_code", "agentMemberId": agent }),
        )
        .await;
    assert_eq!(status, 404, "{body}");
    let owners_other = s.agent(s.person, Some("codex")).await;
    let (status, body) = s
        .turn_on(
            &s.other_access,
            json!({ "harness": "codex", "agentMemberId": owners_other }),
        )
        .await;
    assert_eq!(status, 404, "someone else's subscription agent: {body}");
    let still_plain: bool =
        sqlx::query_scalar("SELECT personal_agent FROM agent WHERE member_id = $1")
            .bind(owners_other)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert!(
        !still_plain,
        "the owner's agent was not converted by a teammate"
    );
    let (status, body) = s
        .call(
            reqwest::Method::GET,
            &s.personal_path(),
            &s.other_access,
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agents"], json!([]), "a teammate lists only their own");

    // 3. An agent bearer is not a person.
    let bot = s.agent(s.person, None).await;
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", s.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write'], 'p2-conformance')",
    )
    .bind(s.workspace)
    .bind(bot)
    .bind(&token)
    .execute(&s.su)
    .await
    .unwrap();
    let (status, _) = s
        .turn_on(
            &token,
            json!({ "harness": "codex", "alias": unique_alias("bot") }),
        )
        .await;
    assert_eq!(status, 403, "agent bearer");
    let (status, _) = s.turn_off(&token, agent).await;
    assert_eq!(status, 403, "agent bearer cannot switch off either");

    // 3b. A guest is not a member who may own one.
    let (guest, guest_email) = seed_human(&s.su, s.workspace, "guest").await;
    let _ = guest;
    let guest_access = login(&s.http, &s.base, s.workspace, &guest_email).await;
    let (status, body) = s
        .turn_on(
            &guest_access,
            json!({ "harness": "codex", "alias": unique_alias("g") }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, _) = s.turn_off(&guest_access, agent).await;
    assert_eq!(status, 403);
    let (status, _) = s
        .call(
            reqwest::Method::GET,
            &s.personal_path(),
            &guest_access,
            None,
        )
        .await;
    assert_eq!(status, 403);

    // 4. One personal agent per harness: a second alias is refused, the same
    // alias is the same agent.
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": unique_alias("second") }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("personal_agent_exists"));
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": alias }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["reused"], json!(true));
    assert_eq!(body["agent"]["id"], json!(agent.to_string()));

    // 5. Bad input.
    for bad in [
        json!({ "harness": "gemini", "alias": unique_alias("x") }),
        json!({ "harness": "codex" }),
        json!({ "harness": "codex", "alias": "a" }),
        json!({ "harness": "codex", "alias": "has space" }),
        json!({ "harness": "claude_code", "alias": "x-y", "agentMemberId": agent }),
    ] {
        let (status, body) = s.turn_on(&s.other_access, bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {body}");
    }

    // Only the one legitimate extra member (the owner's `bot`/`codex` fixtures
    // are rows this test made itself); no failed attempt created an agent.
    let members_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id = $1")
            .bind(s.workspace)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(
        members_after,
        members_before + 3,
        "the guest, owners_other and bot only"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_switched_off_personal_agent_cannot_be_called_and_keeps_its_history() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;

    // The agent has said something in the room.
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(s.workspace)
        .bind(s.channel)
        .bind(agent)
        .execute(&s.su)
        .await
        .unwrap();
    let said: Uuid = sqlx::query_scalar(
        "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, author_member_id, body) \
         VALUES ($1, $2, 1, 1, $3, '정리해 뒀어요') RETURNING id",
    )
    .bind(s.workspace)
    .bind(s.channel)
    .bind(agent)
    .fetch_one(&s.su)
    .await
    .unwrap();

    // Off.
    let (status, body) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agent"]["enabled"], json!(false));
    assert_eq!(s.member_status(agent).await, "suspended");

    // The owner's own signed spawn naming it is now refused, before a nonce.
    let nonces = s.spent_nonces().await;
    let mut req = s.req();
    req.agent = Some(agent);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("spawn_agent_not_allowed"));
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, nonces);

    // History and identity are untouched: same member, same message, same author.
    let author: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id = $1")
        .bind(said)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert_eq!(author, agent);
    assert_eq!(s.members_named(&alias).await, 1);
    // The alias stays reserved while it is off.
    let (status, body) = s
        .turn_on(
            &s.other_access,
            json!({ "harness": "codex", "alias": alias }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    // Off twice is still off.
    let (status, _) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200);
    let off_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'personal_agent.disabled'",
    )
    .bind(s.workspace)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(off_audits, 1, "the second call changed nothing");

    // The owner lists it as off, and turning it on brings back the same member.
    let (status, body) = s
        .call(reqwest::Method::GET, &s.personal_path(), &s.access, None)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agents"][0]["enabled"], json!(false));
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": alias }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["reused"], json!(true));
    assert_eq!(body["agent"]["id"], json!(agent.to_string()));
    assert_eq!(s.member_status(agent).await, "active");
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");

    // An administrator's suspension is not the owner's to undo (M3): a plain
    // status write, as the membership lifecycle makes it.
    sqlx::query("UPDATE member SET status = 'suspended' WHERE workspace_id = $1 AND id = $2")
        .bind(s.workspace)
        .bind(agent)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": alias }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("personal_agent_suspended"));
    assert_eq!(s.member_status(agent).await, "suspended");

    // … and so is the other order: the owner switched it off first, then an
    // administrator suspended the already-suspended member.
    sqlx::query("UPDATE member SET status = 'active' WHERE workspace_id = $1 AND id = $2")
        .bind(s.workspace)
        .bind(agent)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, _) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200);
    sqlx::query("UPDATE member SET status = 'suspended' WHERE workspace_id = $1 AND id = $2")
        .bind(s.workspace)
        .bind(agent)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": alias }),
        )
        .await;
    assert_eq!(status, 409, "owner-off then admin-suspend: {body}");
    assert_eq!(code(&body), Some("personal_agent_suspended"));
    assert_eq!(s.member_status(agent).await, "suspended");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_roster_reads_a_personal_agent_per_viewer() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let owner_name = s.display_name(s.person).await;
    let roster = format!("/v1/workspaces/{}/roster", s.workspace);

    let find = |body: &Value| -> Value {
        body["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == json!(agent.to_string()))
            .cloned()
            .unwrap_or_else(|| panic!("agent in roster: {body}"))
    };

    let (status, body) = s
        .call(reqwest::Method::GET, &roster, &s.other_access, None)
        .await;
    assert_eq!(status, 200, "{body}");
    let seen = find(&body);
    assert_eq!(seen["callableBy"], json!("owner_only"));
    assert_eq!(
        seen["personalAgent"]["label"],
        json!(format!("{owner_name}의 개인 에이전트"))
    );
    assert_eq!(seen["personalAgent"]["enabled"], json!(true));
    assert_eq!(
        seen["personalAgent"]["mentionable"],
        json!(false),
        "@ autocomplete never offers it to a teammate"
    );
    assert!(seen.get("hostOnline").is_none(), "no hosted liveness");
    assert!(seen.get("brainUnavailableReason").is_none());

    let (_, body) = s.call(reqwest::Method::GET, &roster, &s.access, None).await;
    assert_eq!(find(&body)["personalAgent"]["mentionable"], json!(true));

    // Off: the roster lists active members only, so it leaves the list for
    // everyone — nobody gets it as an `@` candidate. The owner still reads it
    // (switched off) from `GET …/personal-agents`.
    let (status, _) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200);
    for bearer in [&s.access, &s.other_access] {
        let (_, body) = s.call(reqwest::Method::GET, &roster, bearer, None).await;
        assert!(
            !body["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == json!(agent.to_string())),
            "a switched-off personal agent is not on the roster: {body}"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_existing_subscription_agent_becomes_personal_in_place() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    // The shape #3567 starts from: the owner's `kwak-claude`, owner_only, claude_code.
    let existing = s.agent(s.person, Some("claude_code")).await;
    let handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id = $1")
        .bind(existing)
        .fetch_one(&s.su)
        .await
        .unwrap();

    // The wrong harness, then the right one.
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "codex", "agentMemberId": existing }),
        )
        .await;
    assert_eq!(status, 404, "{body}");
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": existing }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["agent"]["id"],
        json!(existing.to_string()),
        "same member id"
    );
    assert_eq!(body["agent"]["handle"], json!(handle), "same handle");

    // Spawnable as before, and now listed as personal.
    let mut req = s.req();
    req.agent = Some(existing);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    // Converting twice is the same agent, not a second one.
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": existing }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["reused"], json!(true));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn conversion_is_for_owner_only_agents_with_nothing_attached() {
    let _lock = test_lock().await;
    let s = stage(true).await;

    // M1: a workspace-scope (team-callable) agent is never converted.
    let team = s.agent(s.person, None).await;
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": team }),
        )
        .await;
    assert_eq!(status, 404, "{body}");
    let (scope, personal): (String, bool) =
        sqlx::query_as("SELECT invocation_scope, personal_agent FROM agent WHERE member_id = $1")
            .bind(team)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!((scope.as_str(), personal), ("workspace", false));

    // An owner_only agent that still has a hosted connection is refused, by name.
    let hosted = s.agent(s.person, Some("claude_code")).await;
    sqlx::query(
        "UPDATE agent SET model = 'hosted-agent', base_url = 'https://hosted-agent.invalid/disabled', \
                config = '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb WHERE member_id = $1",
    )
    .bind(hosted)
    .execute(&s.su)
    .await
    .unwrap();
    let connection: Uuid = sqlx::query_scalar(
        "INSERT INTO hosted_agent_connection (workspace_id, agent_member_id, status, \
                pairing_challenge_hash, pairing_expires_at, created_by) \
         VALUES ($1, $2, 'pairing_pending', digest('x', 'sha256'), now() + interval '1 hour', $3) \
         RETURNING id",
    )
    .bind(s.workspace)
    .bind(hosted)
    .bind(s.person)
    .fetch_one(&s.su)
    .await
    .expect("hosted connection");
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": hosted }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("personal_agent_connections_remain"));

    // A live credential alone is refused too.
    sqlx::query("DELETE FROM hosted_agent_connection WHERE id = $1")
        .bind(connection)
        .execute(&s.su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write'], 'p2-leftover')",
    )
    .bind(s.workspace)
    .bind(hosted)
    .bind(Uuid::new_v4().to_string())
    .execute(&s.su)
    .await
    .unwrap();
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": hosted }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("personal_agent_connections_remain"));

    // Revoked (what #3567 does first), it converts.
    sqlx::query("UPDATE token SET revoked_at = now() WHERE actor_member_id = $1")
        .bind(hosted)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "agentMemberId": hosted }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_deleted_personal_agent_does_not_block_turning_on_again() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    let first = s.on(&s.access, "claude_code", &unique_alias("old")).await;
    sqlx::query("UPDATE member SET deleted_at = now() WHERE workspace_id = $1 AND id = $2")
        .bind(s.workspace)
        .bind(first)
        .execute(&s.su)
        .await
        .unwrap();
    let still: bool = sqlx::query_scalar("SELECT personal_agent FROM agent WHERE member_id = $1")
        .bind(first)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert!(
        !still,
        "deleting the member releases the personal-agent slot"
    );
    let (status, body) = s
        .turn_on(
            &s.access,
            json!({ "harness": "claude_code", "alias": unique_alias("new") }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    assert_ne!(body["agent"]["id"], json!(first.to_string()));
}

// ---------------------------------------------------------------------------
// #3592 (P1) — calling a personal agent by mention or DM (ADR-0198 증보 1 D7)
// ---------------------------------------------------------------------------
//
// | test | revert that makes it red |
// |---|---|
// | `a_teammates_call_of_a_personal_agent_is_refused_and_starts_nothing` | move the personal-agent arm of `route_agent_mentions_in_tx` after the `agent_not_channel_member` skip (the teammate then hears nothing), or drop the `NonOwner` arm of `owner_only_gate` |
// | `the_owners_mention_and_dm_start_nothing_by_themselves` | drop the personal-agent arm (the hosted selector then posts a "connection unavailable" notice) or let it create a run/job; let the two instance switches decide a personal agent (#3626 L2) |
// | `an_agent_bearer_mention_of_a_personal_agent_starts_nothing` | move the personal arm above the `author_is_agent` skip |
// | `a_switched_off_alias_is_not_called_at_all` | drop `m.status = 'active'` from `load_mention_candidates_in_tx` / the live check of `personal_agent_ok_in_tx` |
// | `a_called_session_speaks_as_the_alias_where_it_was_called` | author the card/event/idle line as the session owner again, drop `persona_member_id`, or let the host choose it |

impl Stage {
    async fn join(&self, channel: Uuid, member: Uuid) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(member)
        .execute(&self.su)
        .await
        .expect("join the room");
    }

    /// The reason the latest mention of `message` was skipped for `agent`.
    async fn skip_reason(&self, message: Uuid, agent: Uuid) -> Option<String> {
        sqlx::query_scalar(
            "SELECT detail->>'reason' FROM audit_log WHERE workspace_id = $1 \
               AND action = 'agent.mention.skipped' AND target_id = $2 AND subject_member_id = $3 \
             ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(self.workspace)
        .bind(message)
        .bind(agent)
        .fetch_optional(&self.su)
        .await
        .expect("read the skip diagnostic")
    }

    /// What the server said in the alias's name (the ADR-0193 notices).
    async fn spoken_by(&self, agent: Uuid) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT body FROM message WHERE workspace_id = $1 AND author_member_id = $2 \
               AND type = 'text' ORDER BY seq",
        )
        .bind(self.workspace)
        .bind(agent)
        .fetch_all(&self.su)
        .await
        .expect("read what the alias said")
    }

    async fn runs_and_jobs(&self) -> (i64, i64) {
        (
            self.count("SELECT count(*) FROM agent_run WHERE workspace_id = $1")
                .await,
            self.count(
                "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job'",
            )
            .await,
        )
    }

    async fn open_dm(&self, bearer: &str, with: Uuid) -> Uuid {
        let (status, body) = self
            .post(
                &format!("/v1/workspaces/{}/dms", self.workspace),
                bearer,
                json!({ "memberId": with }),
            )
            .await;
        assert!(status == 200 || status == 201, "open a DM: {status} {body}");
        Uuid::parse_str(body["channel"]["id"].as_str().unwrap()).unwrap()
    }

    /// The host opens the session `control` describes and acks it.
    async fn host_runs(&self, control: Uuid, channel: Uuid, req: &Req) -> Uuid {
        let (status, created) = self
            .host_request(
                "POST",
                &format!("/v1/workspaces/{}/work-sessions", self.workspace),
                Some(
                    json!({ "channelId": channel, "hostId": self.host, "tool": req.tool,
                              "label": req.label, "controlId": control }),
                ),
            )
            .await;
        assert_eq!(status, 201, "the host opens the session: {created}");
        let session = Uuid::parse_str(created["workSession"]["id"].as_str().unwrap()).unwrap();
        let (status, acked) = self
            .host_request(
                "POST",
                &format!(
                    "/v1/workspaces/{}/work-controls/{control}/ack",
                    self.workspace
                ),
                Some(json!({ "ok": true, "sessionId": session })),
            )
            .await;
        assert_eq!(status, 200, "{acked}");
        session
    }

    fn session_path(&self, session: Uuid) -> String {
        format!("/v1/workspaces/{}/work-sessions/{session}", self.workspace)
    }

    /// One host-signed ACP event and one idle report on `session`.
    async fn host_reports(&self, session: Uuid, channel: Uuid) {
        let (status, body) = self
            .host_request(
                "PATCH",
                &self.session_path(session),
                Some(json!({ "event": {
                    "event_id": Uuid::new_v4(), "type": "agent.status", "v": 1,
                    "ts": 1_784_678_400_000i64,
                    "payload": { "run_id": session, "work_session_id": session,
                                 "channel_id": channel, "phase": "thinking",
                                 "run_status": "running", "detail": "읽는 중", "has_plan": false }
                }})),
            )
            .await;
        assert_eq!(status, 200, "a host-signed event lands: {body}");
        let (status, body) = self
            .host_request(
                "PATCH",
                &self.session_path(session),
                Some(json!({ "status": "idle", "exitCode": 0 })),
            )
            .await;
        assert_eq!(status, 200, "the host reports idle: {body}");
    }

    /// `(author, reply_to_id, root_id)` of the card, and the authors of every
    /// reply under it.
    async fn card_and_thread(
        &self,
        session: Uuid,
    ) -> ((Uuid, Option<Uuid>, Option<Uuid>), Vec<Uuid>) {
        let root: Uuid =
            sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
                .bind(session)
                .fetch_one(&self.su)
                .await
                .unwrap();
        let card: (Uuid, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
            "SELECT author_member_id, reply_to_id, root_id FROM message WHERE id = $1",
        )
        .bind(root)
        .fetch_one(&self.su)
        .await
        .unwrap();
        let replies: Vec<Uuid> = sqlx::query_scalar(
            "SELECT author_member_id FROM message WHERE root_id = $1 ORDER BY seq",
        )
        .bind(root)
        .fetch_all(&self.su)
        .await
        .unwrap();
        (card, replies)
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_teammates_call_of_a_personal_agent_is_refused_and_starts_nothing() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    s.join(s.channel, s.teammate).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let owner_name = s.display_name(s.person).await;
    assert!(
        s.spoken_by(agent).await.is_empty(),
        "the alias is not a member of the room and has said nothing"
    );
    let before = s.spawn_controls().await;

    // The teammate mentions someone else's personal agent in a room the alias
    // never joined. The owner-only sentence answers; nothing starts.
    let called = s
        .say(
            &s.other_access,
            s.channel,
            None,
            &format!("@{alias} 빌드 봐 줘"),
        )
        .await;
    assert_eq!(
        s.skip_reason(called, agent).await.as_deref(),
        Some("owner_only_non_owner"),
        "a teammate hears whose agent this is, even though the alias is not in the room"
    );
    let said = s.spoken_by(agent).await;
    assert_eq!(said.len(), 1, "one sentence in the alias's name: {said:?}");
    assert!(
        said[0].contains(&format!("{owner_name}의 개인 에이전트")),
        "the existing NonOwner sentence names the owner: {}",
        said[0]
    );
    assert_eq!(s.spawn_controls().await, before, "no work for a teammate");
    assert_eq!(s.runs_and_jobs().await, (0, 0), "no run and no job either");

    // A DM with the alias is the same refusal.
    let dm = s.open_dm(&s.other_access, agent).await;
    let in_dm = s.say(&s.other_access, dm, None, "안녕, 이거 해 줘").await;
    assert_eq!(
        s.skip_reason(in_dm, agent).await.as_deref(),
        Some("owner_only_non_owner")
    );
    assert_eq!(s.spawn_controls().await, before);
    assert_eq!(s.runs_and_jobs().await, (0, 0));

    // And the spawn route, with the teammate's own valid Mac and key, names
    // the alias in vain.
    let world = s.teammate_world().await;
    let mut req = s.req();
    req.agent = Some(agent);
    req.folder = world.question.clone();
    let signer = Signer {
        key: &world.key,
        key_id: world.key_id,
        member: s.teammate,
    };
    let (status, body, _) = s.spawn_as(&signer, &s.other_access, world.host, &req).await;
    assert!(
        status == 403 || status == 404,
        "a teammate cannot name another person's alias: {status} {body}"
    );
    assert_eq!(s.spawn_controls().await, before);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_owners_mention_and_dm_start_nothing_by_themselves() {
    let _lock = test_lock().await;
    // Both ADR-0193 instance switches are off (the default): they do not decide
    // a personal agent (#3626 L2), and the owner is told nothing by the server.
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let before_path = s.message_path().await;

    // The room's main line, the alias not invited.
    let mention = s
        .say(&s.access, s.channel, None, &format!("@{alias} 빌드 봐 줘"))
        .await;
    assert_eq!(
        s.skip_reason(mention, agent).await.as_deref(),
        Some("personal_agent_client_signs"),
        "the owner's mention is an audited no-op: the owner's client signs the spawn"
    );

    // Invited to the room, the alias is still not delivered to by the hosted path.
    s.join(s.channel, agent).await;
    let invited = s
        .say(&s.access, s.channel, None, &format!("@{alias} 다시 봐 줘"))
        .await;
    assert_eq!(
        s.skip_reason(invited, agent).await.as_deref(),
        Some("personal_agent_client_signs")
    );

    // A DM with the alias needs no `@`.
    let dm = s.open_dm(&s.access, agent).await;
    let plain = s.say(&s.access, dm, None, "이 폴더 설명해 줘").await;
    assert_eq!(
        s.skip_reason(plain, agent).await.as_deref(),
        Some("personal_agent_client_signs"),
        "the 1:1 DM rule addresses the alias"
    );

    // Nothing started and nothing was said: no run, no job, no sentence, no
    // control. The message path wrote exactly the three messages.
    assert_eq!(s.runs_and_jobs().await, (0, 0));
    assert!(
        s.spoken_by(agent).await.is_empty(),
        "the server says nothing to the owner"
    );
    assert_eq!(s.spawn_controls().await, 0, "a mention is not a spawn");
    let after_path = s.message_path().await;
    assert_eq!(
        after_path.1 - before_path.1,
        3,
        "the three messages are the only rows the message path added"
    );
    let hosted_notices = s
        .count(
            "SELECT count(*) FROM message WHERE workspace_id = $1 \
               AND props->>'source' LIKE 'server.%notice%'",
        )
        .await;
    assert_eq!(hosted_notices, 0, "no hosted-delivery notice either");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_mention_of_a_personal_agent_starts_nothing() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let alias = unique_alias("kwak-claude");
    let alias_id = s.on(&s.access, "claude_code", &alias).await;
    let other = s.agent(s.person, None).await;
    s.join(s.channel, other).await;
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(s.workspace)
    .bind(other)
    .execute(&s.su)
    .await
    .expect("the agent is a workspace member");
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", s.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write'], 'p1-conformance')",
    )
    .bind(s.workspace)
    .bind(other)
    .bind(&token)
    .execute(&s.su)
    .await
    .expect("seed agent bearer");

    // Another agent mentions the owner's alias. Agents cannot call a personal
    // agent (ADR-0188 D3): no job, no spawn, no sentence.
    let (status, body) = s
        .post(
            &format!(
                "/v1/workspaces/{}/channels/{}/messages",
                s.workspace, s.channel
            ),
            &token,
            json!({ "clientMsgId": Uuid::new_v4(), "body": format!("@{alias} 부탁해") }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let said = Uuid::parse_str(
        body["message"]["id"]
            .as_str()
            .or(body["id"].as_str())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        s.skip_reason(said, alias_id).await.as_deref(),
        Some("a2a_source_run_unavailable")
    );
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.runs_and_jobs().await, (0, 0));
    assert!(s.spoken_by(alias_id).await.is_empty());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_switched_off_alias_is_not_called_at_all() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let (status, body) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200, "{body}");

    // A mention of a switched-off alias addresses nobody: no diagnostic, no job.
    let mention = s
        .say(&s.access, s.channel, None, &format!("@{alias} 빌드 봐 줘"))
        .await;
    assert_eq!(s.skip_reason(mention, agent).await, None);
    assert_eq!(s.runs_and_jobs().await, (0, 0));

    // And the owner's signed spawn that names it is refused by name, before
    // the nonce is spent.
    let mut req = s.req();
    req.agent = Some(agent);
    req.origin = Some(mention);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("spawn_agent_not_allowed"));
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(s.spent_nonces().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_called_session_speaks_as_the_alias_where_it_was_called() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    s.join(s.channel, s.teammate).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;

    // 1. Called from the room's main line; the alias is not a member of the
    //    room (결재: 소유자면 어디서나). Step one is the ordinary message...
    let message = s
        .say(&s.access, s.channel, None, &format!("@{alias} 빌드 봐 줘"))
        .await;
    let path_after_message = s.message_path().await;
    // ...step two is the signed spawn naming it; it adds nothing to the message path.
    let mut req = s.req();
    req.agent = Some(agent);
    req.origin = Some(message);
    let (status, body, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        s.message_path().await,
        path_after_message,
        "the spawn leaves channel_seq, message and outbox alone"
    );
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let session = s.host_runs(control, s.channel, &req).await;
    s.host_reports(session, s.channel).await;

    let owner: Uuid = sqlx::query_scalar("SELECT member_id FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert_eq!(owner, s.person, "the owner still owns the session");
    let ((card_author, quotes, card_root), reply_authors) = s.card_and_thread(session).await;
    assert_eq!(card_author, agent, "the card speaks as the alias");
    assert_eq!(
        quotes,
        Some(message),
        "the card quotes the message it answers"
    );
    assert_eq!(
        card_root, None,
        "the card is a top-level line whose thread is the session's"
    );
    assert!(
        !reply_authors.is_empty() && reply_authors.iter().all(|a| *a == agent),
        "every progress line and the idle line speak as the alias: {reply_authors:?}"
    );
    let alias_in_room: i64 = s
        .count(&format!(
            "SELECT count(*) FROM membership WHERE channel_id = '{}' AND member_id = '{agent}' \
               AND left_at IS NULL AND workspace_id = $1",
            s.channel
        ))
        .await;
    assert_eq!(alias_in_room, 0, "the alias never had to join the room");

    // A teammate in the room reads the alias's card and progress (read only).
    let root: Uuid = sqlx::query_scalar("SELECT root_message_id FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(&s.su)
        .await
        .unwrap();
    let (status, replies) = s
        .call(
            reqwest::Method::GET,
            &format!(
                "/v1/workspaces/{}/channels/{}/messages/{root}/replies",
                s.workspace, s.channel
            ),
            &s.other_access,
            None,
        )
        .await;
    assert_eq!(status, 200, "{replies}");
    let authors: Vec<&str> = replies["messages"]
        .as_array()
        .expect("replies")
        .iter()
        .filter_map(|m| m["authorMemberId"].as_str())
        .collect();
    assert!(
        !authors.is_empty() && authors.iter().all(|a| *a == agent.to_string()),
        "the room reads the progress as the alias: {authors:?}"
    );

    // 2. Called inside a thread, in a DM, and with no alias at all.
    let root = s.say(&s.access, s.channel, None, "스레드 시작").await;
    let in_thread = s
        .say(
            &s.access,
            s.channel,
            Some(root),
            &format!("@{alias} 이어서"),
        )
        .await;
    let mut threaded = s.req();
    threaded.agent = Some(agent);
    threaded.thread = Some(root);
    threaded.origin = Some(in_thread);
    let (status, body, _) = s.spawn(&threaded).await;
    assert_eq!(status, 201, "{body}");
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let session = s.host_runs(control, s.channel, &threaded).await;
    let ((author, quotes, _), _) = s.card_and_thread(session).await;
    assert_eq!((author, quotes), (agent, Some(in_thread)));

    let dm = s.open_dm(&s.access, agent).await;
    let in_dm = s.say(&s.access, dm, None, "이 폴더 설명해 줘").await;
    let mut dm_req = s.req();
    dm_req.agent = Some(agent);
    dm_req.channel = dm;
    dm_req.origin = Some(in_dm);
    let (status, body, _) = s.spawn(&dm_req).await;
    assert_eq!(
        status, 201,
        "a DM with the alias is a room the owner is in: {body}"
    );
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let session = s.host_runs(control, dm, &dm_req).await;
    let ((author, quotes, _), _) = s.card_and_thread(session).await;
    assert_eq!((author, quotes), (agent, Some(in_dm)));

    let plain = s.say(&s.access, s.channel, None, "도구로 직접").await;
    let mut tool = s.req();
    tool.origin = Some(plain);
    let (status, body, _) = s.spawn(&tool).await;
    assert_eq!(status, 201, "{body}");
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let session = s.host_runs(control, s.channel, &tool).await;
    let ((author, quotes, _), _) = s.card_and_thread(session).await;
    assert_eq!(
        (author, quotes),
        (s.person, Some(plain)),
        "a harness spawn (no alias) keeps speaking as the owner, and still quotes its origin"
    );
    let persona: Option<Uuid> =
        sqlx::query_scalar("SELECT persona_member_id FROM work_session WHERE id = $1")
            .bind(session)
            .fetch_one(&s.su)
            .await
            .unwrap();
    assert_eq!(persona, None);

    // 3. Switching the alias off later does not rewrite who spoke: a session
    //    already running keeps its speaker.
    let later = s
        .say(&s.access, s.channel, None, &format!("@{alias} 한 번 더"))
        .await;
    let mut again = s.req();
    again.agent = Some(agent);
    again.origin = Some(later);
    let (status, body, _) = s.spawn(&again).await;
    assert_eq!(status, 201, "{body}");
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();
    let session = s.host_runs(control, s.channel, &again).await;
    let (status, body) = s.turn_off(&s.access, agent).await;
    assert_eq!(status, 200, "{body}");
    s.host_reports(session, s.channel).await;
    let ((author, _, _), replies) = s.card_and_thread(session).await;
    assert_eq!(author, agent);
    assert!(replies.iter().all(|a| *a == agent), "{replies:?}");
}

// | `the_same_message_calls_one_task_per_agent_and_harness` (review M1) | drop the origin lookup in `spawn_in_tx` (a fresh nonce on the same origin then makes a second control) |
// | `invisible_and_carriage_return_text_is_refused_before_the_nonce_is_spent` (review M2·L2) | revert `spawn_prompt_problem` / `spawn_label_problem` to control-only |

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_same_message_calls_one_task_per_agent_and_harness() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let alias = unique_alias("kwak-claude");
    let agent = s.on(&s.access, "claude_code", &alias).await;
    let message = s
        .say(&s.access, s.channel, None, &format!("@{alias} 빌드 봐 줘"))
        .await;
    let mut req = s.req();
    req.agent = Some(agent);
    req.origin = Some(message);

    let (status, first, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "{first}");
    // The same call again with a fresh nonce: the Mac must not run it twice.
    let (status, second, _) = s.spawn(&req).await;
    assert_eq!(
        status, 200,
        "a resend of the same call answers the same control: {second}"
    );
    assert_eq!(second["replayed"], true);
    assert_eq!(second["workControl"]["id"], first["workControl"]["id"]);
    assert_eq!(s.spawn_controls().await, 1, "one control, one task");
    assert_eq!(
        s.spent_nonces().await,
        1,
        "the second nonce was never spent"
    );

    // The same message may still call a DIFFERENT agent/harness combination:
    // here the owner's plain tool from the same message.
    let mut tool = s.req();
    tool.origin = Some(message);
    let (status, third, _) = s.spawn(&tool).await;
    assert_eq!(status, 201, "{third}");
    assert_eq!(s.spawn_controls().await, 2);

    // After the first task failed, the owner can call again.
    sqlx::query("UPDATE work_control SET status = 'failed' WHERE id = $1")
        .bind(Uuid::parse_str(first["workControl"]["id"].as_str().unwrap()).unwrap())
        .execute(&s.su)
        .await
        .expect("fail the first");
    let (status, again, _) = s.spawn(&req).await;
    assert_eq!(status, 201, "a failed call may be called again: {again}");
    assert_eq!(s.spawn_controls().await, 3);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn invisible_and_carriage_return_text_is_refused_before_the_nonce_is_spent() {
    let _lock = test_lock().await;
    let s = stage(true).await;
    s.host_online(s.host, true).await;
    let doc: Value = serde_json::from_str(include_str!(
        "../../../../docs/api/human-control-signing-v4.vectors.json"
    ))
    .unwrap();
    for case in doc["text_rules"]["rejects"].as_array().unwrap() {
        let (name, field, value) = (
            case["name"].as_str().unwrap(),
            case["field"].as_str().unwrap(),
            case["value"].as_str().unwrap(),
        );
        // Not representable as the route's own typed request fields: a
        // slash command has its own code, an empty/blank title is not a body.
        // A title with a control character cannot even be signed by the test's
        // own (momo-wire) signer; the route's check on it is the same function.
        if value.is_empty()
            || value.trim_start().starts_with('/')
            || (field == "label" && value.chars().any(char::is_control))
        {
            continue;
        }
        let mut req = s.req();
        if field == "prompt" {
            req.prompt = value.to_string();
        } else {
            req.label = Box::leak(value.to_string().into_boxed_str());
        }
        let (status, body, _) = s.spawn(&req).await;
        assert_eq!(status, 400, "{name}: {body}");
        assert!(
            matches!(
                code(&body),
                Some("spawn_prompt_invalid") | Some("spawn_label_invalid")
            ),
            "{name}: {body}"
        );
    }
    assert_eq!(s.spawn_controls().await, 0);
    assert_eq!(
        s.spent_nonces().await,
        0,
        "refused before the signature spent a nonce"
    );
}
