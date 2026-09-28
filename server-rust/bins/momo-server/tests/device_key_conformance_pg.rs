//! #3022 — R2-E2: device signing keys, their session lineage, refresh-token
//! reuse (R1), and the root key's `host_register` signature (ADR-0146 개정
//! 2026-09-28 D-6 · D-7 · D-8, migration 094).
//!
//! Every test drives the real routes on an ephemeral port against the real
//! schema, as the NOBYPASSRLS api role. The person's Secure Enclave key is
//! played by a software P-256 key signing the exact bytes E1 (`momo-wire`
//! `human_control`) builds.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_mac_key_is_a_root_and_a_phone_key_cannot_instruct_until_endorsed` | derive `root` from anything but live+macos+unendorsed, or let an unendorsed key instruct |
//! | `a_key_is_only_ever_the_callers_own` | trust a body `memberId`, drop the live-key unique index, or drop the member check on the target / root |
//! | `an_endorsement_verifies_against_the_stored_rows_only` | verify against the request instead of the stored label/key, accept a phone or revoked root, or skip `verify` |
//! | `a_signed_revocation_is_kept_and_a_forged_one_refused` | skip `verify` on the letter, or drop the member check |
//! | `logout_revokes_the_sessions_key_and_a_rotation_keeps_it` | drop the key half of the logout cascade, or mint a fresh lineage on rotation |
//! | `unlinking_a_phone_revokes_its_key` | drop the key half of the unlink cascade |
//! | `a_member_wide_session_end_revokes_every_key` | drop the key half of `end_member_sessions_in_tx` |
//! | `an_access_token_outliving_its_logout_cannot_register_a_key` | check the access row instead of a live refresh of the lineage |
//! | `a_reused_refresh_token_ends_the_whole_lineage` | **R1** — drop `end_reused_lineage` from the `Revoked` arm |
//! | `host_register_signature_is_optional_until_the_flag_and_verified_whenever_sent` | drop the verification when the flag is off, or the flag check |
//! | `host_register_refuses_every_forged_or_misplaced_signature` | skip `verify`, accept a non-root key, rebuild from the request instead of the stored row, or drop the host-id collision |
//! | `migration_094_reapplies_as_a_noop_and_keeps_rls_forced` | a non-idempotent statement in 094, or a missing FORCE |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26772/momo \
//!   cargo test -p momo-server --test device_key_conformance_pg \
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
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use momo_wire::human_control::{
    ControlContent, DeviceEndorse, DeviceKeyAlg, DeviceRevoke, HumanControl,
};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "device-key-conformance-signing-secret";
const TEST_PASSWORD: &str = "device-key-password";
const NEW_PASSWORD: &str = "device-key-password-2";
const INSTANCE_ID: &str = "inst_3022_conformance";

// ---------------------------------------------------------------------------
// harness (same shape as push_session_end_conformance_pg.rs)
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

fn flag(required: bool) -> DeviceKeySettings {
    DeviceKeySettings {
        instance_id: Some(INSTANCE_ID.to_string()),
        host_register_signature_required: required,
        refresh_reuse_sweep_all_sessions: false,
    }
}

/// `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`: password sign-ins are swept too.
fn sweep_all() -> DeviceKeySettings {
    DeviceKeySettings {
        refresh_reuse_sweep_all_sessions: true,
        ..flag(false)
    }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Session {
    access: String,
    refresh: String,
}

struct World {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    host: String,
    workspace: Uuid,
    owner: Session,
    person_id: Uuid,
    person_email: String,
    other_id: Uuid,
    other_email: String,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("dk-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@device-key.test");
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

async fn world_with(settings: DeviceKeySettings) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("dk-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let (_, owner_email) = seed_human(&su, workspace, "owner").await;
    let (person_id, person_email) = seed_human(&su, workspace, "member").await;
    let (other_id, other_email) = seed_human(&su, workspace, "member").await;
    let base = start_server(settings).await;
    let host = base.trim_start_matches("http://").to_string();
    let http = reqwest::Client::new();
    let owner = login(&http, &base, workspace, &owner_email, TEST_PASSWORD).await;
    World {
        su,
        http,
        base,
        host,
        workspace,
        owner,
        person_id,
        person_email,
        other_id,
        other_email,
    }
}

async fn world() -> World {
    world_with(flag(false)).await
}

fn session_from(body: &Value) -> Session {
    Session {
        access: body["accessToken"].as_str().expect("access").to_string(),
        refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
    }
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> Session {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": password, "workspace": workspace.to_string() }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    session_from(&response.json::<Value>().await.expect("login body"))
}

/// A software stand-in for a device's Secure Enclave key.
struct DeviceKeyPair {
    signing: SigningKey,
    public_b64: String,
}

impl DeviceKeyPair {
    fn new(label: &str) -> DeviceKeyPair {
        let seed = Sha256::digest(format!("#3022 {label} {}", Uuid::new_v4()).as_bytes());
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

impl World {
    async fn person(&self) -> Session {
        login(
            &self.http,
            &self.base,
            self.workspace,
            &self.person_email,
            TEST_PASSWORD,
        )
        .await
    }

    async fn other(&self) -> Session {
        login(
            &self.http,
            &self.base,
            self.workspace,
            &self.other_email,
            TEST_PASSWORD,
        )
        .await
    }

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

    async fn register_key(
        &self,
        session: &Session,
        key: &DeviceKeyPair,
        platform: &str,
        label: &str,
    ) -> (u16, Value) {
        // A root (macos) key needs the password re-entered (review H1).
        let mut body = json!({ "alg": "p256", "publicKey": key.public_b64, "platform": platform, "label": label });
        if platform == "macos" {
            body["currentPassword"] = json!(TEST_PASSWORD);
        }
        self.post(&self.keys_path(), &session.access, body).await
    }

    /// Push the spent refresh row's `revoked_at` past the reuse grace window,
    /// so a replay reads as a second holder rather than the same client's retry.
    async fn age_spent(&self, raw_refresh: &str) {
        let aged = sqlx::query(
            "UPDATE token SET revoked_at = revoked_at - interval '31 seconds' \
              WHERE token_hash = digest($1::text, 'sha256') AND revoked_at IS NOT NULL",
        )
        .bind(raw_refresh)
        .execute(&self.su)
        .await
        .expect("age the spent refresh row")
        .rows_affected();
        assert_eq!(aged, 1, "the presented refresh row was spent");
    }

    /// Register and return the new key id, asserting 201.
    async fn key(&self, session: &Session, key: &DeviceKeyPair, platform: &str) -> Uuid {
        let (status, body) = self.register_key(session, key, platform, "기기").await;
        assert_eq!(status, 201, "register {platform} key: {body}");
        Uuid::parse_str(body["deviceKey"]["id"].as_str().expect("id")).expect("uuid")
    }

    async fn list(&self, session: &Session) -> Vec<Value> {
        let (status, body) = self
            .call(
                reqwest::Method::GET,
                &self.keys_path(),
                &session.access,
                None,
            )
            .await;
        assert_eq!(status, 200, "list keys: {body}");
        body["deviceKeys"].as_array().expect("array").clone()
    }

    async fn key_row(&self, id: Uuid) -> (Option<String>, bool) {
        sqlx::query_as::<_, (Option<String>, bool)>(
            "SELECT revoked_reason, revoked_at IS NOT NULL FROM member_device_key WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&self.su)
        .await
        .expect("read key row")
    }

    fn endorsement(
        &self,
        member: Uuid,
        root: &DeviceKeyPair,
        root_id: Uuid,
        target: &DeviceKeyPair,
        label: &str,
    ) -> String {
        root.sign(
            &DeviceEndorse {
                workspace_id: self.workspace,
                member_id: member,
                root_key_id: root_id,
                target_alg: DeviceKeyAlg::P256,
                target_public_key_b64: &target.public_b64,
                label,
            }
            .signed_bytes()
            .expect("endorse bytes"),
        )
    }

    async fn endorse(
        &self,
        session: &Session,
        target_id: Uuid,
        root_id: Uuid,
        signature: &str,
    ) -> (u16, Value) {
        self.post(
            &format!("{}/{target_id}/endorsement", self.keys_path()),
            &session.access,
            json!({ "rootKeyId": root_id, "signature": signature }),
        )
        .await
    }

    async fn rotate(&self, session: &Session) -> (u16, Option<Session>) {
        let response = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base))
            .json(&json!({ "refreshToken": session.refresh }))
            .send()
            .await
            .expect("refresh");
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        (status, (status == 200).then(|| session_from(&body)))
    }

    async fn logout(&self, session: &Session) {
        let (status, body) = self
            .post(
                "/v1/auth/logout",
                &session.access,
                json!({ "refreshToken": session.refresh }),
            )
            .await;
        assert_eq!(status, 200, "logout: {body}");
        assert_eq!(
            body["revokedRefresh"], true,
            "logout killed the refresh half"
        );
    }

    /// An authenticated read with `access`: 200 while the token is usable.
    async fn access_works(&self, access: &str) -> bool {
        self.call(reqwest::Method::GET, &self.keys_path(), access, None)
            .await
            .0
            == 200
    }

    #[allow(clippy::too_many_arguments)]
    fn host_statement(
        &self,
        member: Uuid,
        signer: &DeviceKeyPair,
        signer_id: Uuid,
        host_id: Uuid,
        host_key: &str,
        label: &str,
        issued_at_ms: i64,
    ) -> Value {
        let nonce = Uuid::new_v4();
        let expires_at_ms = issued_at_ms + 5 * 60 * 1000;
        let bytes = HumanControl {
            instance_id: INSTANCE_ID,
            workspace_id: self.workspace,
            member_id: member,
            device_key_id: signer_id,
            host_id,
            session_id: None,
            nonce,
            issued_at_ms,
            expires_at_ms,
            content: ControlContent::HostRegister {
                host_public_key_b64: host_key,
                host_id,
                label,
            },
        }
        .signed_bytes()
        .expect("host_register bytes");
        json!({
            "deviceKeyId": signer_id,
            "hostId": host_id,
            "nonce": nonce,
            "issuedAtMs": issued_at_ms,
            "expiresAtMs": expires_at_ms,
            "signature": signer.sign(&bytes),
        })
    }

    async fn register_host(
        &self,
        session: &Session,
        scope: &str,
        host_key: &str,
        name: &str,
        registration: Option<Value>,
    ) -> (u16, Value) {
        let mut body = json!({
            "scope": scope,
            "type": "workd",
            "displayName": name,
            "publicKey": host_key,
        });
        if let Some(registration) = registration {
            body["registration"] = registration;
        }
        self.post(
            &format!("/v1/workspaces/{}/work-hosts", self.workspace),
            &session.access,
            body,
        )
        .await
    }
}

fn code(body: &Value) -> Option<&str> {
    body["error"]["code"].as_str().or(body["code"].as_str())
}

// ---------------------------------------------------------------------------
// registration, state, ownership
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_mac_key_is_a_root_and_a_phone_key_cannot_instruct_until_endorsed() {
    let _lock = test_lock().await;
    let w = world().await;
    let mac = w.person().await;
    let phone = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let handset = DeviceKeyPair::new("phone");

    let (status, body) = w.register_key(&mac, &root, "macos", "맥북").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["deviceKey"]["state"], "root");
    assert_eq!(body["deviceKey"]["canInstruct"], true);
    assert_eq!(body["deviceKey"]["current"], true);
    let root_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();

    let (status, body) = w.register_key(&phone, &handset, "ios", "아이폰").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["deviceKey"]["state"], "unendorsed",
        "a phone key starts 지시 불가"
    );
    assert_eq!(body["deviceKey"]["canInstruct"], false);
    let phone_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();

    let signature = w.endorsement(w.person_id, &root, root_id, &handset, "아이폰");
    let (status, body) = w.endorse(&mac, phone_id, root_id, &signature).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["deviceKey"]["state"], "endorsed");
    assert_eq!(body["deviceKey"]["canInstruct"], true);
    assert_eq!(body["deviceKey"]["endorsedByKeyId"], root_id.to_string());

    // The listing is the caller's own, and `current` marks this sign-in.
    let listed = w.list(&phone).await;
    assert_eq!(listed.len(), 2);
    let own = listed
        .iter()
        .find(|k| k["id"] == phone_id.to_string())
        .unwrap();
    assert_eq!(own["current"], true);

    // Shape refusals.
    for (alg, key, platform) in [
        ("ed25519", root.public_b64.clone(), "macos"),
        ("p256", "AAAA".to_string(), "macos"),
        ("p256", DeviceKeyPair::new("x").public_b64, "android"),
    ] {
        let (status, body) = w
            .post(
                &w.keys_path(),
                &mac.access,
                json!({ "alg": alg, "publicKey": key, "platform": platform }),
            )
            .await;
        assert_eq!(status, 400, "{alg}/{platform}: {body}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_key_is_only_ever_the_callers_own() {
    let _lock = test_lock().await;
    let w = world().await;
    let mine = w.person().await;
    let theirs = w.other().await;
    let root = DeviceKeyPair::new("mac");
    let handset = DeviceKeyPair::new("phone");
    let root_id = w.key(&mine, &root, "macos").await;
    let phone_id = w.key(&mine, &handset, "ios").await;

    // Naming another member in the body.
    let fresh = DeviceKeyPair::new("fresh");
    let (status, body) = w
        .post(
            &w.keys_path(),
            &theirs.access,
            json!({ "alg": "p256", "publicKey": fresh.public_b64, "platform": "ios",
                    "memberId": w.person_id }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_member_mismatch"));

    // Registering a key that is live under someone else.
    let (status, body) = w.register_key(&theirs, &handset, "ios", "").await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("device_key_already_registered"));

    // Endorsing someone else's phone with one's own root, and someone else's
    // root endorsing one's own phone.
    let their_root = DeviceKeyPair::new("their mac");
    let their_root_id = w.key(&theirs, &their_root, "macos").await;
    let signature = w.endorsement(w.other_id, &their_root, their_root_id, &handset, "기기");
    let (status, body) = w
        .endorse(&theirs, phone_id, their_root_id, &signature)
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_member_mismatch"));
    let their_phone = DeviceKeyPair::new("their phone");
    let their_phone_id = w.key(&theirs, &their_phone, "ios").await;
    let signature = w.endorsement(w.other_id, &root, root_id, &their_phone, "기기");
    let (status, body) = w
        .endorse(&theirs, their_phone_id, root_id, &signature)
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_member_mismatch"));

    // Their listing does not include mine.
    let listed = w.list(&theirs).await;
    assert!(listed
        .iter()
        .all(|k| k["memberId"] == w.other_id.to_string()));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_endorsement_verifies_against_the_stored_rows_only() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let handset = DeviceKeyPair::new("phone");
    let root_id = w.key(&session, &root, "macos").await;
    let phone_id = w.key(&session, &handset, "ios").await; // stored label 기기

    let expect_refused = |status: u16, body: &Value, want: &str| {
        assert_eq!(code(body), Some(want), "{status} {body}");
        assert!(status == 403 || status == 409, "{status} {body}");
    };

    // A label the request made up (stored is 기기).
    let signature = w.endorsement(w.person_id, &root, root_id, &handset, "다른 이름");
    let (status, body) = w.endorse(&session, phone_id, root_id, &signature).await;
    expect_refused(status, &body, "device_signature_invalid");

    // A signature by a key that is not the named root.
    let impostor = DeviceKeyPair::new("impostor");
    let signature = w.endorsement(w.person_id, &impostor, root_id, &handset, "기기");
    let (status, body) = w.endorse(&session, phone_id, root_id, &signature).await;
    expect_refused(status, &body, "device_signature_invalid");

    // One flipped bit of a genuine signature.
    let genuine = w.endorsement(w.person_id, &root, root_id, &handset, "기기");
    let mut raw = BASE64.decode(&genuine).unwrap();
    raw[10] ^= 1;
    let (status, body) = w
        .endorse(&session, phone_id, root_id, &BASE64.encode(raw))
        .await;
    expect_refused(status, &body, "device_signature_invalid");

    // A phone is not a root, even an endorsed one.
    let second = DeviceKeyPair::new("second phone");
    let second_id = w.key(&session, &second, "ios").await;
    let signature = w.endorsement(w.person_id, &handset, phone_id, &second, "기기");
    let (status, body) = w.endorse(&session, second_id, phone_id, &signature).await;
    expect_refused(status, &body, "device_root_not_eligible");

    // A Mac is not endorsable (Mac-to-Mac is the next stage).
    let other_mac = DeviceKeyPair::new("mac 2");
    let other_mac_id = w.key(&session, &other_mac, "macos").await;
    let signature = w.endorsement(w.person_id, &root, root_id, &other_mac, "기기");
    let (status, body) = w.endorse(&session, other_mac_id, root_id, &signature).await;
    expect_refused(status, &body, "device_key_not_endorsable");

    assert_eq!(
        w.list(&session)
            .await
            .iter()
            .find(|k| k["id"] == phone_id.to_string())
            .unwrap()["state"],
        "unendorsed",
        "no refused letter endorsed anything"
    );

    // The genuine letter works, once.
    let (status, body) = w.endorse(&session, phone_id, root_id, &genuine).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = w.endorse(&session, phone_id, root_id, &genuine).await;
    expect_refused(status, &body, "device_key_not_endorsable");

    // A revoked root endorses nothing, and its endorsements stop counting.
    let root_session = w.person().await;
    let lone_root = DeviceKeyPair::new("lone mac");
    let lone_root_id = w.key(&root_session, &lone_root, "macos").await;
    let third = DeviceKeyPair::new("third phone");
    let third_id = w.key(&session, &third, "ios").await;
    let signature = w.endorsement(w.person_id, &lone_root, lone_root_id, &third, "기기");
    let (status, _) = w
        .endorse(&session, third_id, lone_root_id, &signature)
        .await;
    assert_eq!(status, 200);
    w.logout(&root_session).await;
    let listed = w.list(&session).await;
    let third_row = listed
        .iter()
        .find(|k| k["id"] == third_id.to_string())
        .unwrap();
    assert_eq!(
        third_row["state"], "unendorsed",
        "an endorsement from a revoked root no longer counts"
    );
    let fourth = DeviceKeyPair::new("fourth phone");
    let fourth_id = w.key(&session, &fourth, "ios").await;
    let signature = w.endorsement(w.person_id, &lone_root, lone_root_id, &fourth, "기기");
    let (status, body) = w
        .endorse(&session, fourth_id, lone_root_id, &signature)
        .await;
    expect_refused(status, &body, "device_key_revoked");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_signed_revocation_is_kept_and_a_forged_one_refused() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let handset = DeviceKeyPair::new("phone");
    let root_id = w.key(&session, &root, "macos").await;
    let phone_id = w.key(&session, &handset, "ios").await;
    let at = now_ms();
    let letter = |signer: &DeviceKeyPair, target: Uuid, member: Uuid| {
        signer.sign(
            &DeviceRevoke {
                workspace_id: w.workspace,
                member_id: member,
                root_key_id: root_id,
                target_key_id: target,
                revoked_at_ms: at,
            }
            .signed_bytes(),
        )
    };
    let path = format!("{}/{phone_id}/revocation", w.keys_path());

    let impostor = DeviceKeyPair::new("impostor");
    let (status, body) = w
        .post(
            &path,
            &session.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at,
                    "signature": letter(&impostor, phone_id, w.person_id) }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_invalid"));
    // The letter's time is part of what was signed.
    let (status, body) = w
        .post(
            &path,
            &session.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at + 1,
                    "signature": letter(&root, phone_id, w.person_id) }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert!(!w.key_row(phone_id).await.1, "no forged letter revoked it");

    // Another member cannot revoke my key, even holding my root's letter.
    let theirs = w.other().await;
    let (status, body) = w
        .post(
            &path,
            &theirs.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at,
                    "signature": letter(&root, phone_id, w.person_id) }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_member_mismatch"));

    let (status, body) = w
        .post(
            &path,
            &session.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at,
                    "signature": letter(&root, phone_id, w.person_id) }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["deviceKey"]["state"], "revoked");
    assert_eq!(body["deviceKey"]["revokedReason"], "signed");
    assert_eq!(body["deviceKey"]["revocationSignedAtMs"], at);
    assert!(
        body["deviceKey"]["revocationSignature"].is_string(),
        "the letter is kept for workd"
    );
}

// ---------------------------------------------------------------------------
// the lineage (D-7)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logout_revokes_the_sessions_key_and_a_rotation_keeps_it() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person().await;
    let bystander = w.person().await;
    let key_id = w.key(&session, &DeviceKeyPair::new("phone"), "ios").await;
    let other_key = w.key(&bystander, &DeviceKeyPair::new("mac"), "macos").await;

    let (status, rotated) = w.rotate(&session).await;
    assert_eq!(status, 200);
    let rotated = rotated.unwrap();
    assert!(
        !w.key_row(key_id).await.1,
        "a rotation continues the lineage"
    );

    w.logout(&rotated).await;
    assert_eq!(
        w.key_row(key_id).await,
        (Some("logout".to_string()), true),
        "logout ends the lineage's key"
    );
    assert!(
        !w.key_row(other_key).await.1,
        "another sign-in's key is untouched"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn unlinking_a_phone_revokes_its_key() {
    let _lock = test_lock().await;
    let w = world().await;
    let desktop = w.person().await;
    let issued = w
        .http
        .post(format!("{}/v1/auth/device-link", w.base))
        .bearer_auth(&desktop.access)
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device link");
    assert_eq!(issued.status().as_u16(), 201);
    let voucher = issued.json::<Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let redeemed = w
        .http
        .post(format!("{}/v1/auth/device-link/redeem", w.base))
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .json(&json!({ "token": voucher, "device": { "name": "Phone 3022", "platform": "ios" } }))
        .send()
        .await
        .expect("redeem");
    assert_eq!(redeemed.status().as_u16(), 200);
    let linked = session_from(&redeemed.json::<Value>().await.unwrap());
    let key_id = w.key(&linked, &DeviceKeyPair::new("phone"), "ios").await;
    let desktop_key = w.key(&desktop, &DeviceKeyPair::new("mac"), "macos").await;

    let (_, listed) = w
        .call(
            reqwest::Method::GET,
            "/v1/auth/devices",
            &desktop.access,
            None,
        )
        .await;
    let link_id = listed["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["label"] == "Phone 3022")
        .and_then(|row| row["id"].as_str())
        .unwrap()
        .to_string();
    let (status, _) = w
        .call(
            reqwest::Method::DELETE,
            &format!("/v1/auth/devices/{link_id}"),
            &desktop.access,
            None,
        )
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        w.key_row(key_id).await,
        (Some("device_unlinked".to_string()), true)
    );
    assert!(!w.key_row(desktop_key).await.1, "the desktop's key stays");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_wide_session_end_revokes_every_key() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = w.person().await;
    let desktop = w.person().await;
    let phone_key = w.key(&phone, &DeviceKeyPair::new("phone"), "ios").await;
    let mac_key = w.key(&desktop, &DeviceKeyPair::new("mac"), "macos").await;
    let theirs = w.other().await;
    let their_key = w.key(&theirs, &DeviceKeyPair::new("theirs"), "ios").await;

    let (status, body) = w
        .call(
            reqwest::Method::PATCH,
            &format!("/v1/workspaces/{}/members/me/password", w.workspace),
            &desktop.access,
            Some(json!({ "currentPassword": TEST_PASSWORD, "newPassword": NEW_PASSWORD })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    for key in [phone_key, mac_key] {
        assert_eq!(
            w.key_row(key).await,
            (Some("member_sessions_ended".to_string()), true)
        );
    }
    assert!(!w.key_row(their_key).await.1, "another member is untouched");

    // Suspension ends the other member's.
    let (status, body) = w
        .call(
            reqwest::Method::POST,
            &format!(
                "/v1/workspaces/{}/members/{}/suspend",
                w.workspace, w.other_id
            ),
            &w.owner.access,
            None,
        )
        .await;
    assert!((200..300).contains(&status), "{status} {body}");
    assert!(w.key_row(their_key).await.1, "suspension ends every key");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_access_token_outliving_its_logout_cannot_register_a_key() {
    let _lock = test_lock().await;
    let w = world().await;
    let first = w.person().await;
    let (_, rotated) = w.rotate(&first).await;
    let rotated = rotated.unwrap();
    w.logout(&rotated).await;
    // `first.access` is the older access half: a rotation does not revoke it,
    // so it still authenticates — but its lineage is over.
    assert!(w.access_works(&first.access).await, "precondition");
    let (status, body) = w
        .register_key(&first, &DeviceKeyPair::new("late"), "ios", "")
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("session_lineage_ended"));
}

/// R1 (ADR-0188 §4): 「재사용이 보이면 그 기기의 세션 계열을 전부 폐기」.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reused_refresh_token_ends_the_whole_lineage() {
    let _lock = test_lock().await;
    let w = world_with(sweep_all()).await;
    let stolen = w.person().await;
    let bystander = w.person().await;
    let key_id = w.key(&stolen, &DeviceKeyPair::new("phone"), "ios").await;

    // The thief rotates first.
    let (status, thief) = w.rotate(&stolen).await;
    assert_eq!(status, 200);
    let thief = thief.unwrap();

    // Inside the grace window a replay is the same client's retry (a second
    // tab, a lost response): refused, and nothing else ends (review H2).
    let (status, _) = w.rotate(&stolen).await;
    assert_eq!(status, 401, "a spent refresh token is refused");
    assert!(
        w.access_works(&thief.access).await,
        "a replay inside the grace window does not end the lineage"
    );
    assert!(!w.key_row(key_id).await.1);

    // Past the window, the victim's replay is a second holder.
    w.age_spent(&stolen.refresh).await;
    let (status, _) = w.rotate(&stolen).await;
    assert_eq!(status, 401, "a spent refresh token is refused");

    let (status, _) = w.rotate(&thief).await;
    assert_eq!(
        status, 401,
        "the reuse ended the lineage: the thief's newer refresh is dead too"
    );
    assert!(
        !w.access_works(&thief.access).await,
        "and so is the thief's access token"
    );
    assert!(
        !w.access_works(&stolen.access).await,
        "and every older access half of the lineage"
    );
    assert_eq!(
        w.key_row(key_id).await,
        (Some("refresh_reuse".to_string()), true),
        "the lineage's device key ends with it"
    );
    assert!(
        w.access_works(&bystander.access).await,
        "another sign-in of the same person is untouched"
    );
    let (status, _) = w.rotate(&bystander).await;
    assert_eq!(status, 200);
}

// ---------------------------------------------------------------------------
// host_register (D-8)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn host_register_signature_is_optional_until_the_flag_and_verified_whenever_sent() {
    let _lock = test_lock().await;
    // Flag off (the default): today's unsigned registration still works…
    let w = world().await;
    let session = w.person().await;
    let (status, body) = w
        .register_host(&session, "member", &ed25519_host_key(1), "맥", None)
        .await;
    assert_eq!(
        status, 201,
        "unsigned member host with the flag off: {body}"
    );
    // …but a signature that is sent is verified.
    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&session, &root, "macos").await;
    let host_id = Uuid::new_v4();
    let key = ed25519_host_key(2);
    let mut statement =
        w.host_statement(w.person_id, &root, root_id, host_id, &key, "맥", now_ms());
    statement["signature"] = json!(DeviceKeyPair::new("forger").sign(b"x"));
    let (status, body) = w
        .register_host(&session, "member", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_invalid"));

    // Flag on.
    let w = world_with(flag(true)).await;
    let session = w.person().await;
    let (status, body) = w
        .register_host(&session, "member", &ed25519_host_key(3), "맥", None)
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_signature_required"));
    // A workspace host is the workspace's, not a person's: no signature.
    let (status, body) = w
        .register_host(&w.owner, "workspace", &ed25519_host_key(4), "팀", None)
        .await;
    assert_eq!(status, 201, "{body}");

    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&session, &root, "macos").await;
    let host_id = Uuid::new_v4();
    let key = ed25519_host_key(5);
    let statement = w.host_statement(w.person_id, &root, root_id, host_id, &key, "맥", now_ms());
    let (status, body) = w
        .register_host(&session, "member", &key, "맥", Some(statement.clone()))
        .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        body["workHost"]["id"],
        host_id.to_string(),
        "the host is created under the id the root signed"
    );
    let (status, body) = w
        .register_host(&session, "member", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(code(&body), Some("host_register_replayed"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn host_register_refuses_every_forged_or_misplaced_signature() {
    let _lock = test_lock().await;
    let w = world_with(flag(true)).await;
    let session = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&session, &root, "macos").await;
    let handset = DeviceKeyPair::new("phone");
    let phone_id = w.key(&session, &handset, "ios").await;
    let signature = w.endorsement(w.person_id, &root, root_id, &handset, "기기");
    assert_eq!(
        w.endorse(&session, phone_id, root_id, &signature).await.0,
        200
    );
    let hosts_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_host WHERE workspace_id = $1")
            .bind(w.workspace)
            .fetch_one(&w.su)
            .await
            .unwrap();

    let key = ed25519_host_key(9);
    let now = now_ms();
    let cases: Vec<(&str, Value, &str, &str)> = vec![
        (
            "an endorsed phone is not the root",
            w.host_statement(
                w.person_id,
                &handset,
                phone_id,
                Uuid::new_v4(),
                &key,
                "맥",
                now,
            ),
            "맥",
            "device_root_not_eligible",
        ),
        (
            "the name registered differs from the name signed",
            w.host_statement(w.person_id, &root, root_id, Uuid::new_v4(), &key, "맥", now),
            "다른 맥",
            "device_signature_invalid",
        ),
        (
            "a stale statement",
            w.host_statement(
                w.person_id,
                &root,
                root_id,
                Uuid::new_v4(),
                &key,
                "맥",
                now - 20 * 60 * 1000,
            ),
            "맥",
            "device_signature_invalid",
        ),
        (
            "signed for another member",
            w.host_statement(w.other_id, &root, root_id, Uuid::new_v4(), &key, "맥", now),
            "맥",
            "device_signature_invalid",
        ),
    ];
    for (why, statement, name, want) in cases {
        let (status, body) = w
            .register_host(&session, "member", &key, name, Some(statement))
            .await;
        assert_eq!(status, 403, "{why}: {body}");
        assert_eq!(code(&body), Some(want), "{why}");
    }
    // A different host key than the one signed.
    let statement = w.host_statement(w.person_id, &root, root_id, Uuid::new_v4(), &key, "맥", now);
    let (status, body) = w
        .register_host(
            &session,
            "member",
            &ed25519_host_key(10),
            "맥",
            Some(statement),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    // Someone else's root.
    let theirs = w.other().await;
    let statement = w.host_statement(w.person_id, &root, root_id, Uuid::new_v4(), &key, "맥", now);
    let (status, body) = w
        .register_host(&theirs, "member", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_member_mismatch"));
    // A signature on a workspace host is a shape error.
    let statement = w.host_statement(w.person_id, &root, root_id, Uuid::new_v4(), &key, "맥", now);
    let (status, _) = w
        .register_host(&w.owner, "workspace", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 400);
    // A revoked root (its sign-in logged out).
    let statement = w.host_statement(w.person_id, &root, root_id, Uuid::new_v4(), &key, "맥", now);
    w.logout(&session).await;
    let again = w.person().await;
    let (status, body) = w
        .register_host(&again, "member", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_revoked"));

    let hosts_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_host WHERE workspace_id = $1")
            .bind(w.workspace)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(
        hosts_before, hosts_after,
        "no refused registration wrote a host"
    );
}

// ---------------------------------------------------------------------------
// migration 094
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn migration_094_reapplies_as_a_noop_and_keeps_rls_forced() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let snapshot = |su: PgPool| async move {
        sqlx::query_scalar::<_, String>(
            "SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ';' ORDER BY conname) \
               FROM pg_constraint \
              WHERE conrelid IN ('member_device_key'::regclass, 'action_signature'::regclass)",
        )
        .fetch_one(&su)
        .await
        .expect("constraint snapshot")
    };
    let before = snapshot(su.clone()).await;
    let path = default_migrations_dir().join("094_member_device_key.sql");
    for round in 1..=2 {
        let output = psql_file(path.clone());
        assert!(
            output.status.success(),
            "re-applying 094 (round {round}) failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        before,
        snapshot(su.clone()).await,
        "a re-run changes nothing"
    );

    let (enabled, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'member_device_key'::regclass",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(enabled && forced, "member_device_key is ENABLE + FORCE RLS");
    let policies: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_policies WHERE tablename = 'member_device_key' AND policyname = 'ws_isolation'",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(policies, 1);

    // action_signature: a row written without `alg` (every row before 094, and
    // every Ed25519 writer that has not changed) is ed25519, and the key CHECK
    // is per-alg.
    let default: Option<String> = sqlx::query_scalar(
        "SELECT column_default FROM information_schema.columns \
          WHERE table_name = 'action_signature' AND column_name = 'alg'",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(default.as_deref(), Some("'ed25519'::text"));
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(format!("dk-{ws}"))
        .execute(&su)
        .await
        .unwrap();
    let insert = |alg: &'static str, key: String| {
        let su = su.clone();
        async move {
            sqlx::query(
                "INSERT INTO action_signature \
                   (workspace_id, entity_type, entity_id, signer_pubkey, signature, \
                    signed_payload_digest, alg) \
                 VALUES ($1, 'work_host.register', $2, $3, $4, $5, $6)",
            )
            .bind(ws)
            .bind(Uuid::new_v4())
            .bind(key)
            .bind(BASE64.encode([Uuid::new_v4().as_bytes().as_slice(), &[7u8; 48]].concat()))
            .bind(hex_digest())
            .bind(alg)
            .execute(&su)
            .await
        }
    };
    let p256_key = DeviceKeyPair::new("audit").public_b64;
    assert!(
        insert("p256", p256_key.clone()).await.is_ok(),
        "a P-256 row fits"
    );
    assert!(
        insert("ed25519", ed25519_host_key(11)).await.is_ok(),
        "Ed25519 still fits"
    );
    assert!(
        insert("ed25519", p256_key).await.is_err(),
        "a P-256 key labelled ed25519 is refused"
    );
    assert!(
        insert("p256", ed25519_host_key(12)).await.is_err(),
        "an Ed25519 key labelled p256 is refused"
    );
    assert!(
        insert("rsa", ed25519_host_key(13)).await.is_err(),
        "an unknown alg is refused"
    );
}

fn hex_digest() -> String {
    Sha256::digest(Uuid::new_v4().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// review follow-ups (H1, M3, M4, M5, L9)
// ---------------------------------------------------------------------------

/// H1: a bearer token alone cannot mint a root.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_root_key_needs_the_password_and_a_password_sign_in() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person().await;
    let root = DeviceKeyPair::new("mac");
    for body in [
        json!({ "alg": "p256", "publicKey": root.public_b64, "platform": "macos" }),
        json!({ "alg": "p256", "publicKey": root.public_b64, "platform": "macos",
                "currentPassword": "wrong-password" }),
    ] {
        let (status, body) = w.post(&w.keys_path(), &session.access, body).await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(code(&body), Some("device_root_password_required"));
    }
    let (status, body) = w.register_key(&session, &root, "macos", "맥").await;
    assert_eq!(status, 201, "the password makes it a root: {body}");
    // A phone key needs no password.
    let (status, _) = w
        .register_key(&session, &DeviceKeyPair::new("phone"), "ios", "")
        .await;
    assert_eq!(status, 201);

    // A QR-linked session is a phone, never a root — even with the password.
    let issued = w
        .http
        .post(format!("{}/v1/auth/device-link", w.base))
        .bearer_auth(&session.access)
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device link");
    let voucher = issued.json::<Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let redeemed = w
        .http
        .post(format!("{}/v1/auth/device-link/redeem", w.base))
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .json(&json!({ "token": voucher, "device": { "name": "Linked 3022", "platform": "ios" } }))
        .send()
        .await
        .expect("redeem");
    let linked = session_from(&redeemed.json::<Value>().await.unwrap());
    let (status, body) = w
        .register_key(&linked, &DeviceKeyPair::new("linked mac"), "macos", "")
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_root_linked_session"));
}

/// M4: a root whose sign-in expired on its own signs nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_root_whose_sign_in_expired_signs_nothing() {
    let _lock = test_lock().await;
    let w = world_with(flag(true)).await;
    let mac = w.person().await;
    let phone = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&mac, &root, "macos").await;
    let handset = DeviceKeyPair::new("phone");
    let phone_id = w.key(&phone, &handset, "ios").await;
    let endorsed = DeviceKeyPair::new("endorsed phone");
    let endorsed_id = w.key(&phone, &endorsed, "ios").await;
    let letter = w.endorsement(w.person_id, &root, root_id, &endorsed, "기기");
    assert_eq!(w.endorse(&mac, endorsed_id, root_id, &letter).await.0, 200);
    sqlx::query(
        "UPDATE token SET expires_at = now() - interval '1 minute' \
          WHERE session_id = (SELECT session_id FROM member_device_key WHERE id = $1) \
            AND label = 'refresh'",
    )
    .bind(root_id)
    .execute(&w.su)
    .await
    .expect("expire the root's sign-in");

    let signature = w.endorsement(w.person_id, &root, root_id, &handset, "기기");
    let (status, body) = w.endorse(&phone, phone_id, root_id, &signature).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_revoked"));

    let key = ed25519_host_key(21);
    let statement = w.host_statement(
        w.person_id,
        &root,
        root_id,
        Uuid::new_v4(),
        &key,
        "맥",
        now_ms(),
    );
    let (status, body) = w
        .register_host(&phone, "member", &key, "맥", Some(statement))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body), Some("device_key_revoked"));

    // A phone that root approved is no longer instructable (M4 residual)…
    let row = w
        .list(&phone)
        .await
        .into_iter()
        .find(|k| k["id"] == endorsed_id.to_string())
        .unwrap();
    assert_eq!(row["state"], "unendorsed", "{row}");
    assert_eq!(row["canInstruct"], false);
    // …and a new root on a live sign-in may approve it again (L9).
    let mac2 = w.person().await;
    let new_root = DeviceKeyPair::new("new mac");
    let new_root_id = w.key(&mac2, &new_root, "macos").await;
    let letter = w.endorsement(w.person_id, &new_root, new_root_id, &endorsed, "기기");
    let (status, body) = w.endorse(&mac2, endorsed_id, new_root_id, &letter).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["deviceKey"]["state"], "endorsed");
}

/// H2: by default only a QR-linked (phone) lineage is swept; a password
/// sign-in — possibly a browser with several tabs — is only refused.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn by_default_a_reuse_ends_a_linked_phone_lineage_but_not_a_password_sign_in() {
    let _lock = test_lock().await;
    let w = world().await;

    // A password sign-in (a second browser tab rotated minutes ago).
    let tab_a = w.person().await;
    let (status, tab_b) = w.rotate(&tab_a).await;
    assert_eq!(status, 200);
    let tab_b = tab_b.unwrap();
    w.age_spent(&tab_a.refresh).await;
    let (status, _) = w.rotate(&tab_a).await;
    assert_eq!(status, 401, "the stale tab is refused");
    assert!(
        w.access_works(&tab_b.access).await,
        "and the other tab keeps the session"
    );
    let (status, _) = w.rotate(&tab_b).await;
    assert_eq!(status, 200);

    // A QR-linked phone: one process, so a stale presentation is a second holder.
    let desktop = w.person().await;
    let issued = w
        .http
        .post(format!("{}/v1/auth/device-link", w.base))
        .bearer_auth(&desktop.access)
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device link");
    let voucher = issued.json::<Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();
    let redeemed = w
        .http
        .post(format!("{}/v1/auth/device-link/redeem", w.base))
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .json(&json!({ "token": voucher, "device": { "name": "Reuse 3022", "platform": "ios" } }))
        .send()
        .await
        .expect("redeem");
    let phone = session_from(&redeemed.json::<Value>().await.unwrap());
    let key_id = w.key(&phone, &DeviceKeyPair::new("phone"), "ios").await;
    let (status, thief) = w.rotate(&phone).await;
    assert_eq!(status, 200);
    let thief = thief.unwrap();
    w.age_spent(&phone.refresh).await;
    let (status, _) = w.rotate(&phone).await;
    assert_eq!(status, 401);
    let (status, _) = w.rotate(&thief).await;
    assert_eq!(
        status, 401,
        "a linked lineage is swept by default (ADR-0188 R1)"
    );
    assert_eq!(
        w.key_row(key_id).await,
        (Some("refresh_reuse".to_string()), true)
    );
    assert!(
        w.access_works(&desktop.access).await,
        "the desktop is untouched"
    );
}

/// M3 and L9: a letter is used once, and a phone whose root is gone can be
/// approved again by a new root.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_endorsement_letter_is_used_once_and_a_lost_root_can_be_replaced() {
    let _lock = test_lock().await;
    let w = world().await;
    let mac = w.person().await;
    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&mac, &root, "macos").await;
    let handset = DeviceKeyPair::new("phone");

    // Endorse, revoke by letter, re-register the same key, replay the letter.
    let phone = w.person().await;
    let first_id = w.key(&phone, &handset, "ios").await;
    let letter = w.endorsement(w.person_id, &root, root_id, &handset, "기기");
    assert_eq!(w.endorse(&mac, first_id, root_id, &letter).await.0, 200);
    let at = now_ms();
    let revoke = root.sign(
        &DeviceRevoke {
            workspace_id: w.workspace,
            member_id: w.person_id,
            root_key_id: root_id,
            target_key_id: first_id,
            revoked_at_ms: at,
        }
        .signed_bytes(),
    );
    let (status, body) = w
        .post(
            &format!("{}/{first_id}/revocation", w.keys_path()),
            &mac.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at, "signature": revoke }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let again_id = w.key(&phone, &handset, "ios").await;
    let (status, body) = w.endorse(&mac, again_id, root_id, &letter).await;
    assert_eq!(status, 409, "a spent letter endorses nothing again: {body}");
    assert_eq!(code(&body), Some("device_key_not_endorsable"));

    // The root's sign-in ends; a new root on a new sign-in re-approves.
    let second = DeviceKeyPair::new("second phone");
    let second_id = w.key(&phone, &second, "ios").await;
    let letter = w.endorsement(w.person_id, &root, root_id, &second, "기기");
    assert_eq!(w.endorse(&mac, second_id, root_id, &letter).await.0, 200);
    w.logout(&mac).await;
    let mac2 = w.person().await;
    let new_root = DeviceKeyPair::new("new mac");
    let new_root_id = w.key(&mac2, &new_root, "macos").await;
    let letter = w.endorsement(w.person_id, &new_root, new_root_id, &second, "기기");
    let (status, body) = w.endorse(&mac2, second_id, new_root_id, &letter).await;
    assert_eq!(
        status, 200,
        "a phone whose root is gone is approved again: {body}"
    );
    assert_eq!(body["deviceKey"]["state"], "endorsed");
}

/// M5: a sign-in from before 088 is swept too, once it has rotated.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_pre_lineage_session_is_swept_on_reuse() {
    let _lock = test_lock().await;
    let w = world_with(sweep_all()).await;
    let old = w.person().await;
    sqlx::query(
        "UPDATE token SET session_id = NULL \
          WHERE token_hash IN (digest($1::text, 'sha256'), digest($2::text, 'sha256'))",
    )
    .bind(&old.access)
    .bind(&old.refresh)
    .execute(&w.su)
    .await
    .expect("make the session pre-088");
    let (status, thief) = w.rotate(&old).await;
    assert_eq!(status, 200);
    let thief = thief.unwrap();
    w.age_spent(&old.refresh).await;
    let (status, _) = w.rotate(&old).await;
    assert_eq!(status, 401);
    let (status, _) = w.rotate(&thief).await;
    assert_eq!(
        status, 401,
        "the replay of a pre-088 token ends its successor"
    );
}

/// A signed `GET …/pending-controls` exactly as workd sends it (v2 request).
async fn poll_as_host(w: &World, host: Uuid, seed: u8) -> Value {
    let path = format!(
        "/v1/workspaces/{}/work-hosts/{host}/pending-controls",
        w.workspace
    );
    let sent_at_ms = now_ms();
    let request_id = Uuid::new_v4();
    let payload = momo_wire::signing::request_payload(
        "GET",
        &path,
        w.workspace,
        host,
        sent_at_ms,
        &momo_wire::signing::sha256_hex(b""),
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(&[seed; 32], &payload).expect("sign");
    let response = w
        .http
        .get(format!("{}{path}", w.base))
        .header("Authorization", format!("MomoHost {host}"))
        .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
        .header("X-Momo-Work-Host-Signature", signature)
        .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
        .send()
        .await
        .expect("poll");
    assert_eq!(
        response.status().as_u16(),
        200,
        "a host polls its own queue"
    );
    response.json().await.expect("pending body")
}

/// D-7 / E4 #3024: the owner's signed revocation letters reach the member
/// host in `pendingControls.deviceRevocations`, verifiable as they stand.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_host_is_handed_its_owners_signed_revocation_letters() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person().await;
    let (status, body) = w
        .register_host(&session, "member", &ed25519_host_key(40), "맥", None)
        .await;
    assert_eq!(status, 201, "{body}");
    let host = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();
    let (status, body) = w
        .register_host(&w.owner, "workspace", &ed25519_host_key(41), "팀", None)
        .await;
    assert_eq!(status, 201, "{body}");
    let team_host = Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap();

    let before = poll_as_host(&w, host, 40).await;
    assert!(
        before.get("deviceRevocations").is_none(),
        "no letters: today's bytes ({before})"
    );

    let root = DeviceKeyPair::new("mac");
    let root_id = w.key(&session, &root, "macos").await;
    let handset = DeviceKeyPair::new("phone");
    let phone_id = w.key(&session, &handset, "ios").await;
    // A session-end revocation (no letter) is not relayed.
    let other_phone = w.person().await;
    w.key(&other_phone, &DeviceKeyPair::new("other"), "ios")
        .await;
    w.logout(&other_phone).await;
    let at = now_ms();
    let letter = DeviceRevoke {
        workspace_id: w.workspace,
        member_id: w.person_id,
        root_key_id: root_id,
        target_key_id: phone_id,
        revoked_at_ms: at,
    };
    let (status, body) = w
        .post(
            &format!("{}/{phone_id}/revocation", w.keys_path()),
            &session.access,
            json!({ "rootKeyId": root_id, "revokedAtMs": at,
                    "signature": root.sign(&letter.signed_bytes()) }),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let relayed = poll_as_host(&w, host, 40).await["deviceRevocations"].clone();
    let relayed = relayed.as_array().expect("deviceRevocations");
    assert_eq!(relayed.len(), 1, "only the signed letter: {relayed:?}");
    let entry = &relayed[0];
    assert_eq!(entry["targetKeyId"], phone_id.to_string());
    assert_eq!(entry["rootKeyId"], root_id.to_string());
    assert_eq!(entry["memberId"], w.person_id.to_string());
    assert_eq!(entry["revokedAtMs"], at);
    assert_eq!(entry["targetPublicKey"], handset.public_b64);
    let root_key = BASE64.decode(&root.public_b64).unwrap();
    let signature = BASE64.decode(entry["signature"].as_str().unwrap()).unwrap();
    assert!(
        letter.verify(&root_key, &signature).is_ok(),
        "the relayed letter verifies as it stands"
    );

    let team = poll_as_host(&w, team_host, 41).await;
    assert!(
        team.get("deviceRevocations").is_none(),
        "a workspace host gets no personal letters ({team})"
    );
}
