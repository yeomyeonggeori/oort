//! #3079 — refresh-token sender constraint (ADR-0146 D-7 증보 2026-09-29,
//! migration 096): a native client binds its sign-in lineage to a refresh key
//! and signs every refresh with `momo.human.refresh_proof.v1`.
//!
//! Every test drives the real `POST /v1/auth/refresh` on an ephemeral port
//! against the real schema, as the NOBYPASSRLS api role. The device's Secure
//! Enclave refresh key is played by a software P-256 key signing the bytes
//! momo-wire `RefreshProof` builds.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_device_that_lost_a_rotation_response_long_ago_recovers_with_its_proof` | **the issue** — drop `recover_lineage` (pre-#3079: 401 and the lineage ends) |
//! | `a_linked_phone_recovers_and_its_link_follows_the_fresh_pair` | skip the link rebind in `recover_lineage` |
//! | `a_copy_without_the_key_ends_a_bound_lineage_even_inside_the_window` | keep the #3074 reissue for an unproven presentation under `require` |
//! | `another_keys_proof_is_a_copy_and_never_rotates_a_live_token` | verify against the request's key instead of the bound one |
//! | `a_replayed_or_stale_proof_is_refused_and_the_lineage_kept` | skip the nonce consume (SABOTAGE nonce-noop), or treat a key-holder's stale/replayed proof as a copy |
//! | `require_refuses_a_live_token_without_proof_and_spends_nothing` | move the `require` check after the single-use revoke |
//! | `observe_honors_proofs_but_changes_nothing_without_them` | enforce under `observe` |
//! | `a_browser_session_is_unchanged_under_require` | require a proof of an unbound lineage |
//! | `a_proof_never_resurrects_an_ended_lineage` | recover from a lineage with no live refresh row |
//! | `a_suspended_member_is_not_recovered` | drop the member check in `recover_lineage` |
//! | `a_sign_out_racing_a_recovery_is_not_undone` | skip the tail check after the lineage lock (SABOTAGE recover-no-tail-gate; review H1), or lock the tail before the lower ids (deadlock) |
//! | `a_key_binds_only_to_a_fresh_sign_ins_first_token` | drop `lineage_is_bindable` (review M1) |
//! | `migration_096_reapplies_as_a_noop_and_keeps_rls_forced` | a non-idempotent statement in 096, or a missing FORCE |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26979/momo \
//!   cargo test -p momo-server --test refresh_proof_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_auth::RefreshProofMode;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use momo_wire::human_control::{refresh_token_sha256_hex, RefreshProof};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "refresh-proof-conformance-signing-secret";
const TEST_PASSWORD: &str = "refresh-proof-password";

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

fn mode(mode: RefreshProofMode) -> DeviceKeySettings {
    DeviceKeySettings {
        refresh_proof_mode: mode,
        ..DeviceKeySettings::default()
    }
}

/// `observe` plus the #3022 sweep of password sign-ins, so a reuse the
/// server takes for a copy visibly ends the lineage in these tests.
fn observe_sweeping() -> DeviceKeySettings {
    DeviceKeySettings {
        refresh_reuse_sweep_all_sessions: true,
        ..mode(RefreshProofMode::Observe)
    }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Session {
    access: String,
    refresh: String,
}

fn session_from(body: &Value) -> Session {
    Session {
        access: body["accessToken"].as_str().expect("access").to_string(),
        refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
    }
}

/// A software stand-in for a device's Secure Enclave refresh key.
struct RefreshKey {
    signing: SigningKey,
    public_b64: String,
}

impl RefreshKey {
    fn new(label: &str) -> RefreshKey {
        let seed = Sha256::digest(format!("#3079 {label} {}", Uuid::new_v4()).as_bytes());
        let signing = SigningKey::from_slice(&seed).expect("a SHA-256 is a valid scalar here");
        let point = signing.verifying_key().to_sec1_point(true);
        RefreshKey {
            public_b64: BASE64.encode(point.as_bytes()),
            signing,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

struct World {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    host: String,
    workspace: Uuid,
    person_id: Uuid,
    person_email: String,
}

async fn world_with(settings: DeviceKeySettings) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("rp-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let person_id = Uuid::new_v4();
    let handle = format!("rp-{}", &person_id.simple().to_string()[..10]);
    let person_email = format!("{person_id}@refresh-proof.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(person_id)
    .bind(workspace)
    .bind(&handle)
    .execute(&su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(person_id)
    .bind(workspace)
    .bind(&person_email)
    .bind(TEST_PASSWORD)
    .execute(&su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner'::membership_role)",
    )
    .bind(workspace)
    .bind(person_id)
    .execute(&su)
    .await
    .expect("seed workspace membership");
    let base = start_server(settings).await;
    let host = base.trim_start_matches("http://").to_string();
    World {
        su,
        http: reqwest::Client::new(),
        base,
        host,
        workspace,
        person_id,
        person_email,
    }
}

fn code(body: &Value) -> Option<&str> {
    body["error"]["code"].as_str()
}

impl World {
    async fn login(&self) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": self.person_email,
                "password": TEST_PASSWORD,
                "workspace": self.workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
        session_from(&response.json::<Value>().await.expect("login body"))
    }

    /// A QR-linked phone session (ADR-0180 device link), from `desktop`.
    async fn link_phone(&self, desktop: &Session) -> Session {
        let issued = self
            .http
            .post(format!("{}/v1/auth/device-link", self.base))
            .bearer_auth(&desktop.access)
            .header("host", &self.host)
            .header("x-forwarded-proto", "http")
            .send()
            .await
            .expect("issue device link");
        let voucher = issued.json::<Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_string();
        let redeemed = self
            .http
            .post(format!("{}/v1/auth/device-link/redeem", self.base))
            .header("host", &self.host)
            .header("x-forwarded-proto", "http")
            .json(
                &json!({ "token": voucher, "device": { "name": "phone 3079", "platform": "ios" } }),
            )
            .send()
            .await
            .expect("redeem");
        session_from(&redeemed.json::<Value>().await.unwrap())
    }

    /// A proof by `key` for presenting `refresh`, with its own fresh nonce.
    fn proof(&self, key: &RefreshKey, refresh: &str, signed_at_ms: i64) -> Value {
        let nonce = Uuid::new_v4();
        let hash = refresh_token_sha256_hex(refresh);
        let bytes = RefreshProof {
            workspace_id: self.workspace,
            member_id: self.person_id,
            public_key_b64: &key.public_b64,
            refresh_token_sha256: &hash,
            nonce,
            signed_at_ms,
        }
        .signed_bytes()
        .expect("proof bytes");
        let signature: Signature = key.signing.sign(&bytes);
        json!({
            "publicKey": key.public_b64,
            "nonce": nonce,
            "signedAtMs": signed_at_ms,
            "signature": BASE64.encode(signature.to_bytes()),
        })
    }

    async fn refresh_body(&self, body: Value) -> (u16, Value) {
        let response = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base))
            .json(&body)
            .send()
            .await
            .expect("refresh");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Present `refresh` with no proof (a browser, or a copy).
    async fn rotate(&self, session: &Session) -> (u16, Value) {
        self.refresh_body(json!({ "refreshToken": session.refresh }))
            .await
    }

    /// Present `refresh` with a fresh proof by `key`.
    async fn rotate_with(&self, session: &Session, key: &RefreshKey) -> (u16, Value) {
        let proof = self.proof(key, &session.refresh, now_ms());
        self.refresh_body(json!({ "refreshToken": session.refresh, "deviceProof": proof }))
            .await
    }

    /// A signed-in lineage bound to `key` (its first proof binds it).
    async fn bound(&self, session: Session, key: &RefreshKey) -> Session {
        let (status, body) = self.rotate_with(&session, key).await;
        assert_eq!(status, 200, "the first proof rotates and binds: {body}");
        let next = session_from(&body);
        assert_eq!(
            self.bound_key(&next.refresh).await.as_deref(),
            Some(key.public_b64.as_str()),
            "the lineage is bound to the key that proved first"
        );
        next
    }

    async fn bound_key(&self, raw_refresh: &str) -> Option<String> {
        sqlx::query_scalar(
            "SELECT k.public_key FROM session_refresh_key k \
               JOIN token t ON t.session_id = k.session_id AND t.workspace_id = k.workspace_id \
              WHERE t.token_hash = digest($1::text, 'sha256')",
        )
        .bind(raw_refresh)
        .fetch_optional(&self.su)
        .await
        .expect("read binding")
    }

    async fn session_id(&self, raw: &str) -> Uuid {
        sqlx::query_scalar(
            "SELECT session_id FROM token WHERE token_hash = digest($1::text, 'sha256')",
        )
        .bind(raw)
        .fetch_one(&self.su)
        .await
        .expect("lineage of a token")
    }

    /// The rotation response is lost *long ago*: the spent row was spent an
    /// hour back, and the pair that rotation minted has an expired access
    /// half (the Cmd+Q / sleep case — #3074's 30 s window and live-pair rule
    /// both fail).
    async fn lose_long_ago(&self, spent: &Session, lost: &Session) {
        let aged = sqlx::query(
            "UPDATE token SET revoked_at = revoked_at - interval '1 hour' \
              WHERE token_hash = digest($1::text, 'sha256') AND revoked_at IS NOT NULL",
        )
        .bind(&spent.refresh)
        .execute(&self.su)
        .await
        .expect("age the spent row")
        .rows_affected();
        assert_eq!(aged, 1, "the presented refresh row was spent");
        let expired = sqlx::query(
            "UPDATE token SET expires_at = now() - interval '1 minute' \
              WHERE token_hash = digest($1::text, 'sha256')",
        )
        .bind(&lost.access)
        .execute(&self.su)
        .await
        .expect("expire the lost access half")
        .rows_affected();
        assert_eq!(expired, 1);
    }

    /// Age a spent row past the 30 s grace only.
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

    /// Live (unrevoked, unexpired) refresh rows of a lineage.
    async fn live_refresh_rows(&self, session_id: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token WHERE session_id = $1 AND label = 'refresh' \
               AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(session_id)
        .fetch_one(&self.su)
        .await
        .expect("count live refresh rows")
    }

    async fn nonces(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM refresh_proof_nonce WHERE workspace_id = $1")
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect("count nonces")
    }

    /// An authenticated read with `access`: 200 while the token is usable.
    async fn access_works(&self, access: &str) -> bool {
        self.http
            .get(format!(
                "{}/v1/workspaces/{}/device-keys",
                self.base, self.workspace
            ))
            .bearer_auth(access)
            .send()
            .await
            .expect("authenticated read")
            .status()
            .as_u16()
            == 200
    }
}

// ---------------------------------------------------------------------------
// the issue: a lost response recovers with the key
// ---------------------------------------------------------------------------

/// **#3079 RED case.** The device rotated, the response never arrived (Cmd+Q
/// mid-rotation, sleep, a dead network), and it comes back an hour later
/// holding only the spent token. Before #3079 that was a reuse: 401, and —
/// with the lineage swept — a sign-out. With its key's proof it is recovered:
/// a fresh pair in the same lineage, and whatever the lost response carried
/// is dead.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_device_that_lost_a_rotation_response_long_ago_recovers_with_its_proof() {
    let _lock = test_lock().await;
    let w = world_with(observe_sweeping()).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;
    let lineage = w.session_id(&held.refresh).await;

    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 200);
    let lost = session_from(&body); // never reaches the device
    w.lose_long_ago(&held, &lost).await;

    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(
        status, 200,
        "the device's proof recovers its lineage, however long ago the token was spent: {body}"
    );
    let recovered = session_from(&body);
    assert_ne!(recovered.refresh, lost.refresh, "a fresh pair");
    assert_eq!(
        w.session_id(&recovered.refresh).await,
        lineage,
        "in the same lineage: push registrations and keys stay"
    );
    assert!(w.access_works(&recovered.access).await, "the session lives");
    assert_eq!(
        w.live_refresh_rows(lineage).await,
        1,
        "only the recovered pair can rotate — the lost pair is dead"
    );
    let lost_revoked: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM token WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(&lost.refresh)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert!(lost_revoked, "the lost response's refresh half is revoked");
    let (status, body) = w.rotate_with(&recovered, &key).await;
    assert_eq!(
        status, 200,
        "and the recovered pair rotates normally: {body}"
    );
}

/// A QR-linked phone lineage: the same recovery, and the device link follows
/// the fresh pair, so the phone keeps rotating and its unlink still reaches it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_linked_phone_recovers_and_its_link_follows_the_fresh_pair() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let desktop = w.login().await;
    let key = RefreshKey::new("phone");
    let phone = w.bound(w.link_phone(&desktop).await, &key).await;

    let (status, body) = w.rotate_with(&phone, &key).await;
    assert_eq!(status, 200);
    let lost = session_from(&body);
    w.lose_long_ago(&phone, &lost).await;

    let (status, body) = w.rotate_with(&phone, &key).await;
    assert_eq!(status, 200, "the phone recovers: {body}");
    let recovered = session_from(&body);
    let bound_refresh: Option<Uuid> = sqlx::query_scalar(
        "SELECT redeemed_refresh_token_id FROM device_link_token \
          WHERE workspace_id = $1 AND member_id = $2 AND redeemed_refresh_token_id IS NOT NULL",
    )
    .bind(w.workspace)
    .bind(w.person_id)
    .fetch_one(&w.su)
    .await
    .expect("the link row");
    let recovered_id: Uuid =
        sqlx::query_scalar("SELECT id FROM token WHERE token_hash = digest($1::text, 'sha256')")
            .bind(&recovered.refresh)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(
        bound_refresh,
        Some(recovered_id),
        "the link points at the recovered pair"
    );
    let (status, body) = w.rotate_with(&recovered, &key).await;
    assert_eq!(status, 200, "the linked rotation finds its binding: {body}");
}

// ---------------------------------------------------------------------------
// copies
// ---------------------------------------------------------------------------

/// Under `require`, a key-bound lineage's spent token presented without the
/// key is a copy, and the lineage ends at once — even inside the 30 s window
/// where #3074 would have handed the live pair to anyone holding the token.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_copy_without_the_key_ends_a_bound_lineage_even_inside_the_window() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let stolen = w.bound(w.login().await, &key).await;
    let lineage = w.session_id(&stolen.refresh).await;

    let (status, body) = w.rotate_with(&stolen, &key).await;
    assert_eq!(status, 200);
    let device = session_from(&body);

    // The thief presents the copied (now spent) token a second later.
    let (status, body) = w.rotate(&stolen).await;
    assert_eq!(
        status, 401,
        "a copy gets nothing inside the window (pre-#3079: the device's live pair): {body}"
    );
    assert_eq!(
        w.live_refresh_rows(lineage).await,
        0,
        "and the lineage is over — a password sign-in too, sweep flag or not"
    );
    assert!(!w.access_works(&device.access).await);

    // A browser sign-in of the same person is untouched.
    let browser = w.login().await;
    let (status, _) = w.rotate(&browser).await;
    assert_eq!(status, 200);
}

/// A proof by any key but the lineage's is a copy's. On a spent token it ends
/// the lineage (`require`); on a live token it is refused and spends nothing,
/// so the device still rotates.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn another_keys_proof_is_a_copy_and_never_rotates_a_live_token() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("device");
    let thief_key = RefreshKey::new("thief");
    let live = w.bound(w.login().await, &key).await;

    let (status, body) = w.rotate_with(&live, &thief_key).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(code(&body), Some("refresh_proof_invalid"));
    assert_eq!(
        w.bound_key(&live.refresh).await.as_deref(),
        Some(key.public_b64.as_str()),
        "a binding is first-come and never replaced"
    );
    let (status, body) = w.rotate_with(&live, &key).await;
    assert_eq!(
        status, 200,
        "the refused copy spent nothing — the device rotates: {body}"
    );
    let device = session_from(&body);
    let lineage = w.session_id(&device.refresh).await;

    // The spent token with another key's proof: a copy.
    let (status, _) = w.rotate_with(&live, &thief_key).await;
    assert_eq!(status, 401);
    assert_eq!(w.live_refresh_rows(lineage).await, 0, "the lineage ended");
}

/// The honest failures of a key holder: the same body sent twice (the nonce
/// is spent) and a clock off by more than 5 minutes. Refused with a code the
/// client acts on — sign again — and the lineage is kept.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_replayed_or_stale_proof_is_refused_and_the_lineage_kept() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;
    let lineage = w.session_id(&held.refresh).await;

    // Stale, on a live token: refused before anything is spent.
    let stale = w.proof(&key, &held.refresh, now_ms() - 10 * 60 * 1000);
    let nonces = w.nonces().await;
    let (status, body) = w
        .refresh_body(json!({ "refreshToken": held.refresh, "deviceProof": stale }))
        .await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(code(&body), Some("refresh_proof_stale"));
    assert_eq!(w.nonces().await, nonces, "a stale proof spends no nonce");

    // One body, sent twice: the first rotates (its response is lost) …
    let proof = w.proof(&key, &held.refresh, now_ms());
    let body = json!({ "refreshToken": held.refresh, "deviceProof": proof });
    let (status, _) = w.refresh_body(body.clone()).await;
    assert_eq!(status, 200);
    w.age_spent(&held.refresh).await;
    // … the identical resend is a replay of the nonce.
    let (status, answer) = w.refresh_body(body.clone()).await;
    assert_eq!(status, 401, "{answer}");
    assert_eq!(code(&answer), Some("refresh_proof_replayed"));
    assert_eq!(
        w.live_refresh_rows(lineage).await,
        1,
        "the key's own replay ends nothing"
    );

    // Signed again, it recovers.
    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 200, "{body}");
}

/// Under `require`, a live token of a key-bound lineage without a proof is
/// refused *before* the single-use gate: nothing is spent, the lineage lives,
/// and the device's next (proven) refresh of the same token succeeds.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn require_refuses_a_live_token_without_proof_and_spends_nothing() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let live = w.bound(w.login().await, &key).await;

    let (status, body) = w.rotate(&live).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(code(&body), Some("refresh_proof_required"));
    assert!(w.access_works(&live.access).await, "nothing ended");
    let (status, body) = w.rotate_with(&live, &key).await;
    assert_eq!(status, 200, "the token was not spent: {body}");
}

/// `observe` (the default): proofs bind and a verified one recovers, but a
/// missing proof changes nothing — the #3074 reissue still answers inside
/// the window, exactly as before.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn observe_honors_proofs_but_changes_nothing_without_them() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Observe)).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;

    let (status, _) = w.rotate(&held).await;
    assert_eq!(status, 200, "a bound lineage still rotates without a proof");
    let (status, _) = w.rotate(&held).await;
    assert_eq!(
        status, 200,
        "and the #3074 in-window reissue still answers an unproven retry"
    );
}

/// A browser never binds a key; `require` does not touch it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_browser_session_is_unchanged_under_require() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let tab = w.login().await;
    let (status, body) = w.rotate(&tab).await;
    assert_eq!(status, 200, "{body}");
    let next = session_from(&body);
    let (status, again) = w.rotate(&tab).await;
    assert_eq!(status, 200, "#3074 in-window reissue is kept for browsers");
    assert_eq!(session_from(&again).refresh, next.refresh);
    assert_eq!(w.bound_key(&next.refresh).await, None, "nothing bound");
}

/// A proof recovers a sign-in; it never brings back one that ended.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_proof_never_resurrects_an_ended_lineage() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;
    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 200);
    let current = session_from(&body);

    let response = w
        .http
        .post(format!("{}/v1/auth/logout", w.base))
        .bearer_auth(&current.access)
        .json(&json!({ "refreshToken": current.refresh }))
        .send()
        .await
        .expect("logout");
    assert_eq!(response.status().as_u16(), 200);

    w.age_spent(&held.refresh).await;
    let (status, _) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 401, "an older spent token of a logged-out lineage");
    let (status, _) = w.rotate_with(&current, &key).await;
    assert_eq!(status, 401, "the logged-out token itself");
    assert_eq!(
        w.live_refresh_rows(w.session_id(&held.refresh).await).await,
        0
    );
}

/// Recovery checks the member like a rotation does.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_suspended_member_is_not_recovered() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;
    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 200);
    let lost = session_from(&body);
    w.lose_long_ago(&held, &lost).await;
    sqlx::query("UPDATE member SET status = 'suspended'::member_status WHERE id = $1")
        .bind(w.person_id)
        .execute(&w.su)
        .await
        .expect("suspend (the guard alone, without the session end)");

    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 403, "a suspended member is not recovered: {body}");
}

/// Review H1: a sign-out that commits while a recovery is under way wins.
/// The test takes the lineage's lowest live row the way every id-ordered
/// sweep does, lets the recovery read the tail and block, then ends the whole
/// lineage (which needs the tail row too) and commits: no deadlock (re-review
/// M — a recovery that locked the tail first would form a cycle here and one
/// side would die with 40P01), and the recovery mints nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_sign_out_racing_a_recovery_is_not_undone() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Require)).await;
    let key = RefreshKey::new("desktop");
    let held = w.bound(w.login().await, &key).await;
    let lineage = w.session_id(&held.refresh).await;
    let (status, body) = w.rotate_with(&held, &key).await;
    assert_eq!(status, 200);
    let lost = session_from(&body);
    w.lose_long_ago(&held, &lost).await;

    let mut signout = w.su.begin().await.expect("begin");
    sqlx::query(
        "SELECT id FROM token WHERE session_id = $1 AND revoked_at IS NULL \
          ORDER BY id LIMIT 1 FOR UPDATE",
    )
    .bind(lineage)
    .fetch_all(&mut *signout)
    .await
    .expect("hold the lineage's live rows");

    let proof = w.proof(&key, &held.refresh, now_ms());
    let url = format!("{}/v1/auth/refresh", w.base);
    let refresh = held.refresh.clone();
    let http = w.http.clone();
    let recovery = tokio::spawn(async move {
        let response = http
            .post(url)
            .json(&json!({ "refreshToken": refresh, "deviceProof": proof }))
            .send()
            .await
            .expect("recovery");
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    });
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    sqlx::query("UPDATE token SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL")
        .bind(lineage)
        .execute(&mut *signout)
        .await
        .expect("end the lineage");
    signout.commit().await.expect("commit the sign-out");

    let (status, body) = recovery.await.expect("recovery task");
    assert_eq!(
        status, 401,
        "the recovery lost to the sign-out and minted nothing: {body}"
    );
    assert_eq!(
        w.live_refresh_rows(lineage).await,
        0,
        "the ended lineage stays ended"
    );
}

/// Review M1: first-come binding is trust-on-first-use, so it is kept to the
/// sign-in's own first refresh token, young. A lineage that has rotated (a
/// browser tab, an older client) or is older than the window never binds —
/// otherwise one copied live token would let its holder bind a key and take
/// the lineage over by "recovering" it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_key_binds_only_to_a_fresh_sign_ins_first_token() {
    let _lock = test_lock().await;
    let w = world_with(mode(RefreshProofMode::Observe)).await;
    let key = RefreshKey::new("copy");

    // A lineage that already rotated once without a key.
    let tab = w.login().await;
    let (status, body) = w.rotate(&tab).await;
    assert_eq!(status, 200);
    let rotated = session_from(&body);
    let (status, body) = w.rotate_with(&rotated, &key).await;
    assert_eq!(
        status, 200,
        "observe: the refresh itself goes through: {body}"
    );
    assert_eq!(
        w.bound_key(&session_from(&body).refresh).await,
        None,
        "a rotated lineage never binds"
    );

    // A first token older than the window.
    let old = w.login().await;
    sqlx::query(
        "UPDATE token SET created_at = now() - interval '11 minutes' \
          WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(&old.refresh)
    .execute(&w.su)
    .await
    .unwrap();
    let (status, body) = w.rotate_with(&old, &key).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        w.bound_key(&session_from(&body).refresh).await,
        None,
        "an old sign-in never binds"
    );

    // The fresh sign-in's first token does.
    let fresh = w.login().await;
    w.bound(fresh, &key).await;
}

// ---------------------------------------------------------------------------
// migration 096
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn migration_096_reapplies_as_a_noop_and_keeps_rls_forced() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let snapshot = |su: PgPool| async move {
        sqlx::query_scalar::<_, String>(
            "SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ';' ORDER BY conname) \
               FROM pg_constraint \
              WHERE conrelid IN ('session_refresh_key'::regclass, 'refresh_proof_nonce'::regclass)",
        )
        .fetch_one(&su)
        .await
        .expect("constraint snapshot")
    };
    let before = snapshot(su.clone()).await;
    let path = default_migrations_dir().join("096_session_refresh_key.sql");
    for round in 1..=2 {
        let output = psql_file(path.clone());
        assert!(
            output.status.success(),
            "re-applying 096 (round {round}) failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(
        before,
        snapshot(su.clone()).await,
        "a re-run changes nothing"
    );
    for table in ["session_refresh_key", "refresh_proof_nonce"] {
        let (enabled, forced): (bool, bool) = sqlx::query_as(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        )
        .bind(table)
        .fetch_one(&su)
        .await
        .unwrap();
        assert!(enabled && forced, "{table} is ENABLE + FORCE RLS");
        let policies: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_policies WHERE tablename = $1 AND policyname = 'ws_isolation'",
        )
        .bind(table)
        .fetch_one(&su)
        .await
        .unwrap();
        assert_eq!(policies, 1, "{table} has ws_isolation");
    }
    // The api role sees nothing outside its tenant scope.
    let app = momo_app_pool().await;
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM session_refresh_key")
        .fetch_one(&app)
        .await
        .unwrap();
    assert_eq!(visible, 0, "no tenant GUC, no rows");
}
