//! #2677 — a session that ends takes its push registration with it.
//!
//! The bug: `POST /v1/auth/logout` revoked the session tokens and nothing else.
//! The judgment (`momo_push::judge_targets`) only filters
//! `push_token.invalidated_at IS NULL`, and the phone's notification extension
//! fails open without a session, so a signed-out phone kept receiving the
//! relay's placeholder ("oort / 새 알림") and the previous person's badge.
//!
//! Every test here drives the real routes on an ephemeral port and then runs
//! ONE real notifier drain against a recording relay (the `push_conformance_pg`
//! double) — login → register → end the session → send → drain. Nothing
//! contacts Apple.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `logout_ends_this_phones_push_registration` | drop the logout invalidation, or stop binding `push_token.session_id` on INSERT |
//! | `logout_after_a_rotation_still_ends_the_registration` | mint a fresh `token.session_id` on a plain refresh instead of inheriting it |
//! | `signing_back_in_on_the_same_phone_rebinds_the_registration` | leave `session_id` out of the reclaim UPDATE branch |
//! | `logging_out_one_phone_leaves_the_other_phone_alone` | invalidate by member instead of by session on logout |
//! | `logout_never_touches_a_registration_it_cannot_attribute` | same over-reach, against a pre-lineage (NULL) row |
//! | `a_logout_racing_an_in_flight_registration_still_ends_it` | drop `FOR SHARE` from `lock_session_for_registration` |
//! | `unlinking_a_linked_phone_ends_its_registration` | drop the unlink invalidation, or mint a fresh lineage on the linked refresh |
//! | `a_password_change_ends_every_registration_of_the_member` | drop the password-change invalidation |
//! | `a_password_reset_claim_ends_every_registration_of_the_member` | drop the reset-claim invalidation |
//! | `suspension_ends_registrations_and_reinstatement_does_not_revive_them` | drop the suspend invalidation |
//! | `removal_ends_every_registration_of_the_member` | drop the remove invalidation |
//! | `leaving_the_workspace_ends_every_registration_of_the_member` | drop the self-leave invalidation |
//! | `a_password_change_also_ends_a_registration_from_before_the_lineage` | scope the member-wide invalidation to `session_id IS NOT NULL` |
//! | `an_access_only_logout_leaves_a_session_that_can_still_rotate` | let a logout that did not revoke the refresh half end the lineage anyway |
//! | `a_logout_holding_a_spent_refresh_cannot_end_the_session` | end the lineage on any presented refresh, not only one this call revoked (`revoked_now`) |
//! | `the_upgrade_silences_a_phone_that_signed_out_before_it` | drop the 088 backfill |
//! | `a_phone_signed_in_across_the_upgrade_rebinds_on_its_next_launch` | drop the 088 backfill, or narrow it to members with no live session |
//! | `set_owner_ends_the_owners_registrations_and_only_theirs` | drop the `push_token` UPDATE from `set_initial_owner.sql` |
//!
//! The two `the_upgrade…`/`…across_the_upgrade…` tests and the set-owner test
//! each run in a database of their own ([`ScratchDb`]): the first two must put
//! rows in place BEFORE migration 088 runs, and set-owner rewrites the demo
//! owner every other suite shares.
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test push_session_end_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Assertion messages never interpolate session secrets or APNs tokens.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, discover_migrations, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "push-session-end-conformance-signing-secret";
const TEST_PASSWORD: &str = "push-session-end-password";
const NEW_PASSWORD: &str = "push-session-end-password-2";
const TOPIC: &str = "kim.dawn.momo.e2e";

/// The workspace and owner `002_seed.sql` creates and `set_initial_owner.sql`
/// rotates (both ids are literals in that file).
const DEMO_WORKSPACE: Uuid = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001);
const DEMO_OWNER: Uuid = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0101);

// ---------------------------------------------------------------------------
// harness
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

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    superuser_pool_at(&database_url()).await
}

async fn superuser_pool_at(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(url)
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool_at(url: &str, role: &str, env_key: &str, fallback: &str) -> PgPool {
    let options: PgConnectOptions = url
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username(role)
        .password(&role_password(env_key, fallback));
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap_or_else(|_| panic!("connect as {role} (run bootstrap_roles.sql first)"))
}

/// The API role (NOBYPASSRLS): every route under test runs as this.
async fn momo_app_pool() -> PgPool {
    momo_app_pool_at(&database_url()).await
}

async fn momo_app_pool_at(url: &str) -> PgPool {
    role_pool_at(url, "momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await
}

/// The drain's credential (BYPASSRLS), exactly as the notifier process holds it.
async fn momo_notifier_pool_at(url: &str) -> PgPool {
    role_pool_at(
        url,
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await
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
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles(&database_url());
    *ready = true;
}

/// The runtime roles and their grants. The roles are cluster-wide, the grants
/// per database (`current_database()`), so a scratch database needs its own run.
fn apply_bootstrap_roles(url: &str) {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(url)
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

/// A database of its own, created from the conformance superuser connection and
/// dropped when the test is done.
///
/// Two kinds of test need one. A migration's data step (088's backfill) only
/// ever sees rows that exist when it runs, so its proof must write "yesterday's"
/// rows into a database that stops at 087 and THEN upgrade it — the shared
/// conformance database is already past 088. And `set_initial_owner.sql`
/// rewrites the demo owner's credentials, which the shared database must keep.
///
/// A failed test leaves its database behind inside the throwaway conformance
/// container; nothing here can reach a database the test did not create.
struct ScratchDb {
    name: String,
    url: String,
}

impl ScratchDb {
    async fn create() -> ScratchDb {
        let name = format!("pse_scratch_{}", Uuid::new_v4().simple());
        let admin = superuser_pool().await;
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("create scratch database");
        admin.close().await;
        let url = database_url_named(&name);
        ScratchDb { name, url }
    }

    /// Apply the canonical migrations up to and including `last` — the state of
    /// an instance that has not yet received the later ones. The runner keys
    /// its history on file names, so a later [`ScratchDb::migrate_all`] applies
    /// exactly the files after `last` (the same files, never copies).
    fn migrate_through(&self, last: i64) {
        let dir = std::env::temp_dir().join(format!("{}_migrations", self.name));
        std::fs::create_dir_all(&dir).expect("scratch migrations dir");
        for migration in discover_migrations(&default_migrations_dir()).expect("discover") {
            if migration.version <= last {
                std::os::unix::fs::symlink(&migration.path, dir.join(&migration.name))
                    .expect("link a canonical migration");
            }
        }
        let report = run_migrations(&self.url, &dir, SeedMode::None);
        std::fs::remove_dir_all(&dir).expect("remove scratch migrations dir");
        let report = report.expect("migrations through the given version apply");
        assert_eq!(
            report.applied.len() as i64,
            last,
            "a fresh database applies every file up to {last}"
        );
    }

    /// Bring the database to the current tree; returns what this call applied.
    fn migrate_all(&self) -> Vec<String> {
        run_migrations(&self.url, &default_migrations_dir(), SeedMode::None)
            .expect("apply the remaining migrations")
            .applied
    }

    async fn drop(self) {
        let admin = superuser_pool().await;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&admin)
        .await
        .expect("drop scratch database");
        admin.close().await;
    }
}

/// `DATABASE_URL` with its database name replaced (query string kept).
fn database_url_named(name: &str) -> String {
    let base = database_url();
    let (head, query) = match base.split_once('?') {
        Some((head, query)) => (head.to_string(), Some(query.to_string())),
        None => (base.clone(), None),
    };
    let slash = head.rfind('/').expect("DATABASE_URL names a database");
    let mut url = format!("{}/{name}", &head[..slash]);
    if let Some(query) = query {
        url.push('?');
        url.push_str(&query);
    }
    url
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        RealtimeAdvert::SameOrigin,
    ));
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
// the injected relay (same double as momo-notifier/tests/push_conformance_pg.rs)
// ---------------------------------------------------------------------------

struct RecordingDispatcher {
    sent: Mutex<Vec<PushDispatch>>,
}

impl RecordingDispatcher {
    fn accepting() -> Arc<Self> {
        Arc::new(RecordingDispatcher {
            sent: Mutex::new(Vec::new()),
        })
    }

    fn sent(&self) -> Vec<PushDispatch> {
        self.sent.lock().expect("recorder lock").clone()
    }
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingDispatcher {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent
            .lock()
            .expect("recorder lock")
            .push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/// One workspace, an owner who talks (`sender`) and the person whose phone is
/// under test (`person`), joined by a DM — a DM notifies its other member on
/// every message, so each send is exactly one judgment for `person`.
struct World {
    su: PgPool,
    notifier: PgPool,
    http: reqwest::Client,
    base: String,
    host: String,
    workspace: Uuid,
    person_id: Uuid,
    person_email: String,
    sender: Session,
    dm: Uuid,
}

#[derive(Clone)]
struct Session {
    access: String,
    refresh: String,
}

/// A phone's push identity: the per-install device id and its APNs token.
struct Phone {
    device_id: Uuid,
    apns_token: String,
}

impl Phone {
    fn new() -> Phone {
        Phone {
            device_id: Uuid::new_v4(),
            apns_token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        }
    }
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("pse-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@push-session-end.test");
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

async fn seed_dm(su: &PgPool, workspace: Uuid, members: [Uuid; 2]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'dm', NULL, $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(channel.simple().to_string())
    .execute(su)
    .await
    .expect("seed dm channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed dm membership");
    }
    channel
}

/// Who is in the room before any server starts. Plain rows only, so the same
/// seed also works on a scratch database that is still at 087.
struct Fixture {
    workspace: Uuid,
    sender_email: String,
    person_id: Uuid,
    person_email: String,
    dm: Uuid,
}

async fn seed_fixture(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("pse-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let (sender_id, sender_email) = seed_human(su, workspace, "owner").await;
    let (person_id, person_email) = seed_human(su, workspace, "member").await;
    let dm = seed_dm(su, workspace, [sender_id, person_id]).await;
    Fixture {
        workspace,
        sender_email,
        person_id,
        person_email,
        dm,
    }
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed_fixture(&su).await;
    World::open(&database_url(), su, fixture).await
}

impl World {
    /// Start the API on `url`'s database as `momo_app`, hold the notifier's
    /// credential for the drain, and sign the sender in.
    async fn open(url: &str, su: PgPool, fixture: Fixture) -> World {
        let notifier = momo_notifier_pool_at(url).await;
        let base = start_server(momo_app_pool_at(url).await).await;
        let host = base.trim_start_matches("http://").to_string();
        let http = reqwest::Client::new();
        let sender = login(
            &http,
            &base,
            fixture.workspace,
            &fixture.sender_email,
            TEST_PASSWORD,
        )
        .await;
        World {
            su,
            notifier,
            http,
            base,
            host,
            workspace: fixture.workspace,
            person_id: fixture.person_id,
            person_email: fixture.person_email,
            sender,
            dm: fixture.dm,
        }
    }
}

/// A registration as the server wrote it before 088 — the statement
/// `register_device` ran then, with no `session_id` column to fill. Also the
/// shape of a post-088 row nobody could attribute. Works at 087 and after.
async fn seed_unbound_registration(su: &PgPool, workspace: Uuid, member: Uuid, phone: &Phone) {
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(phone.device_id)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed unbound device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, $5)",
    )
    .bind(workspace)
    .bind(phone.device_id)
    .bind(member)
    .bind(&phone.apns_token)
    .bind(TOPIC)
    .execute(su)
    .await
    .expect("seed unbound push token");
}

/// A session signed in before 088: a real pair signed with the server's key,
/// recorded with the statement `record_session_token` ran then (no lineage).
async fn seed_pre_088_session(su: &PgPool, workspace: Uuid, member: Uuid) -> Session {
    let scopes = vec!["messages:write".to_string(), "messages:read".to_string()];
    let access = momo_auth::sign_access(member, workspace, &scopes, TEST_JWT_SECRET)
        .expect("sign a pre-088 access token");
    let refresh = momo_auth::sign_refresh(member, workspace, &scopes, TEST_JWT_SECRET)
        .expect("sign a pre-088 refresh token");
    for (raw, label, expires_at) in [
        (&access.token, "access", access.expires_at),
        (&refresh.token, "refresh", refresh.expires_at),
    ] {
        sqlx::query(
            "INSERT INTO token \
               (workspace_id, kind, actor_member_id, token_hash, scopes, label, expires_at) \
             VALUES \
               ($1, 'session', $2, digest($3::text, 'sha256'), $4, $5, to_timestamp($6))",
        )
        .bind(workspace)
        .bind(member)
        .bind(raw)
        .bind(&scopes)
        .bind(label)
        .bind(expires_at as f64)
        .execute(su)
        .await
        .expect("record a pre-088 session token");
    }
    Session {
        access: access.token,
        refresh: refresh.token,
    }
}

/// An existing instance the day before this PR deploys: every migration up to
/// 087 applied long ago, and people already in the workspace. Whatever the test
/// writes next is "yesterday's" data.
async fn instance_at_087(db: &ScratchDb) -> (PgPool, Fixture) {
    db.migrate_through(87);
    let su = superuser_pool_at(&db.url).await;
    let fixture = seed_fixture(&su).await;
    (su, fixture)
}

/// The deploy: `migrate` applies 088 (and only 088), then the new API starts.
async fn upgrade_to_088(db: &ScratchDb, su: PgPool, fixture: Fixture) -> World {
    assert_eq!(
        db.migrate_all(),
        vec!["088_push_session_lineage.sql".to_string()],
        "the upgrade applies 088 and nothing else"
    );
    apply_bootstrap_roles(&db.url);
    World::open(&db.url, su, fixture).await
}

// ---------------------------------------------------------------------------
// route drivers
// ---------------------------------------------------------------------------

fn session_from(body: &Value) -> Session {
    Session {
        access: body["accessToken"]
            .as_str()
            .expect("response carries an access token")
            .to_string(),
        refresh: body["refreshToken"]
            .as_str()
            .expect("response carries a refresh token")
            .to_string(),
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
        .json(&json!({
            "email": email,
            "password": password,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    session_from(&response.json::<Value>().await.expect("login body"))
}

impl World {
    async fn person_login(&self) -> Session {
        self.person_login_with(TEST_PASSWORD).await
    }

    async fn person_login_with(&self, password: &str) -> Session {
        login(
            &self.http,
            &self.base,
            self.workspace,
            &self.person_email,
            password,
        )
        .await
    }

    /// `POST /v1/workspaces/{ws}/devices` — exactly the body the phone sends
    /// (`clients/mobile/src/push/devices.ts` `registerDevice`).
    async fn register(&self, session: &Session, phone: &Phone) {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/devices",
                self.base, self.workspace
            ))
            .bearer_auth(&session.access)
            .json(&json!({
                "deviceId": phone.device_id.to_string(),
                "platform": "ios",
                "appBuild": null,
                "apnsToken": phone.apns_token,
                "env": "sandbox",
                "topic": TOPIC,
            }))
            .send()
            .await
            .expect("register device");
        let status = response.status().as_u16();
        assert!(
            status == 200 || status == 201,
            "device registration answered {status}"
        );
    }

    /// `POST /v1/auth/logout` with the refresh half, as `@momo/core` sends it.
    async fn logout(&self, session: &Session) {
        let response = self
            .http
            .post(format!("{}/v1/auth/logout", self.base))
            .bearer_auth(&session.access)
            .json(&json!({ "refreshToken": session.refresh }))
            .send()
            .await
            .expect("logout");
        assert_eq!(response.status().as_u16(), 200, "logout succeeds");
        let body: Value = response.json().await.expect("logout body");
        assert_eq!(
            body["revokedRefresh"], true,
            "logout killed the refresh half"
        );
    }

    async fn rotate(&self, session: &Session) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base))
            .json(&json!({ "refreshToken": session.refresh }))
            .send()
            .await
            .expect("refresh");
        assert_eq!(response.status().as_u16(), 200, "refresh rotates");
        session_from(&response.json::<Value>().await.expect("refresh body"))
    }

    /// The owner speaks in the DM through the real send route, which is what
    /// enqueues the push candidate (011 trigger on the message INSERT).
    async fn send(&self, body: &str) {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                self.base, self.workspace, self.dm
            ))
            .bearer_auth(&self.sender.access)
            .json(&json!({ "clientMsgId": Uuid::new_v4(), "body": body }))
            .send()
            .await
            .expect("send message");
        let status = response.status().as_u16();
        assert!(status == 200 || status == 201, "send answered {status}");
    }

    /// One real notifier drain over THIS workspace's candidates only, returning
    /// what reached the relay for `phone`.
    async fn drain_to(&self, phone: &Phone) -> usize {
        self.drain()
            .await
            .iter()
            .filter(|d| is_for(d, phone))
            .count()
    }

    async fn drain(&self) -> Vec<PushDispatch> {
        // Park every other fixture's pending candidates: the drain is
        // cross-tenant by construction (BYPASSRLS), so an unrelated suite's
        // leftovers must not be claimed by this one. Reschedule only.
        sqlx::query(
            "UPDATE outbox \
                SET available_at = clock_timestamp() + interval '1 hour' \
              WHERE kind = 'push_candidate' \
                AND status = 'pending' \
                AND workspace_id <> $1",
        )
        .bind(self.workspace)
        .execute(&self.su)
        .await
        .expect("park foreign push candidates");

        let relay = RecordingDispatcher::accepting();
        let drain = PushDrain::new(
            self.notifier.clone(),
            PushConfig::for_target(),
            relay.clone(),
        );
        let stats = drain.drain_once(64).await.expect("drain");
        assert_eq!(stats.failed, 0, "no candidate failed");
        assert_eq!(stats.requeued, 0, "no candidate was requeued");
        relay
            .sent()
            .into_iter()
            .filter(|d| d.workspace_id == self.workspace.to_string())
            .collect()
    }

    /// Is the phone's registration still live in the table the judgment reads?
    async fn registration_live(&self, phone: &Phone) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS ( \
               SELECT 1 FROM push_token \
                WHERE device_id = $1 AND invalidated_at IS NULL)",
        )
        .bind(phone.device_id)
        .fetch_one(&self.su)
        .await
        .expect("read registration liveness")
    }

    async fn admin_post(&self, path: &str) {
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.sender.access)
            .send()
            .await
            .expect("admin post");
        let status = response.status().as_u16();
        assert!((200..300).contains(&status), "{path} answered {status}");
    }

    /// `POST /v1/auth/logout` exactly as given — `refresh: None` sends no body,
    /// which is the access-only logout. Returns the status and the JSON body.
    async fn logout_with(&self, access: &str, refresh: Option<&str>) -> (u16, Value) {
        let request = self
            .http
            .post(format!("{}/v1/auth/logout", self.base))
            .bearer_auth(access);
        let request = match refresh {
            Some(refresh) => request.json(&json!({ "refreshToken": refresh })),
            None => request,
        };
        let response = request.send().await.expect("logout");
        let status = response.status().as_u16();
        (status, response.json().await.expect("logout body"))
    }

    /// How many of the person's session rows are still usable.
    async fn live_person_sessions(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM token \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'session' \
                AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(self.workspace)
        .bind(self.person_id)
        .fetch_one(&self.su)
        .await
        .expect("count live sessions")
    }

    /// The lineage a presented token belongs to (`token.session_id`).
    async fn lineage_of(&self, raw_token: &str) -> Option<Uuid> {
        sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT session_id FROM token WHERE token_hash = digest($1::text, 'sha256')",
        )
        .bind(raw_token)
        .fetch_one(&self.su)
        .await
        .expect("read token lineage")
    }

    /// The lineage the phone's live registration is bound to (`None` when it
    /// has no live registration, or one with no lineage).
    async fn registration_lineage(&self, phone: &Phone) -> Option<Uuid> {
        sqlx::query_scalar::<_, Option<Uuid>>(
            "SELECT session_id FROM push_token \
              WHERE device_id = $1 AND invalidated_at IS NULL",
        )
        .bind(phone.device_id)
        .fetch_optional(&self.su)
        .await
        .expect("read registration lineage")
        .flatten()
    }
}

fn is_for(dispatch: &PushDispatch, phone: &Phone) -> bool {
    dispatch.device_id == phone.device_id.to_string()
}

// ---------------------------------------------------------------------------
// session-scoped ends: logout and linked-device disconnect
// ---------------------------------------------------------------------------

/// The issue as reported: sign in on the phone, get pushes; sign out on the
/// phone, keep getting them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logout_ends_this_phones_push_registration() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let session = w.person_login().await;
    w.register(&session, &phone).await;

    w.send("before logout").await;
    assert_eq!(
        w.drain_to(&phone).await,
        1,
        "control: a signed-in phone is notified of a DM"
    );

    w.logout(&session).await;
    w.send("after logout").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "a signed-out phone must receive no push — not even the placeholder"
    );
    assert!(
        !w.registration_live(&phone).await,
        "logout must invalidate the push token this session registered"
    );
}

/// A session is a lineage, not a token pair. The phone registers with the
/// access token it has at launch, rotates every ~15 minutes, and signs out
/// with whatever pair it holds by then.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logout_after_a_rotation_still_ends_the_registration() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let first = w.person_login().await;
    w.register(&first, &phone).await;

    let second = w.rotate(&first).await;
    let third = w.rotate(&second).await;
    w.send("after two rotations").await;
    assert_eq!(
        w.drain_to(&phone).await,
        1,
        "rotating the session must not end its registration"
    );

    w.logout(&third).await;
    assert!(
        !w.registration_live(&phone).await,
        "logging out with a rotated pair ends the registration made before the rotation"
    );
    w.send("after logout").await;
    assert_eq!(w.drain_to(&phone).await, 0, "no push after logout");
}

/// Same phone, same person, signing out and back in. The second registration
/// re-sends the same device id and APNs token, which takes the reclaim
/// (UPDATE) branch of `register_device` rather than the INSERT branch.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn signing_back_in_on_the_same_phone_rebinds_the_registration() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let first = w.person_login().await;
    w.register(&first, &phone).await;
    w.logout(&first).await;

    let second = w.person_login().await;
    w.register(&second, &phone).await;
    assert!(
        w.registration_live(&phone).await,
        "re-registering after a new sign-in reclaims the invalidated token"
    );
    w.send("signed back in").await;
    assert_eq!(w.drain_to(&phone).await, 1, "the new session is notified");

    w.logout(&second).await;
    w.send("signed out again").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "the reclaimed registration belongs to the NEW session and ends with it"
    );
}

/// Logging out is per session. The same person's other phone keeps working.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logging_out_one_phone_leaves_the_other_phone_alone() {
    let _lock = test_lock().await;
    let w = world().await;
    let leaving = Phone::new();
    let staying = Phone::new();
    let leaving_session = w.person_login().await;
    let staying_session = w.person_login().await;
    w.register(&leaving_session, &leaving).await;
    w.register(&staying_session, &staying).await;

    w.logout(&leaving_session).await;
    w.send("one phone left").await;
    let sent = w.drain().await;
    assert_eq!(
        sent.iter().filter(|d| is_for(d, &leaving)).count(),
        0,
        "the signed-out phone is silent"
    );
    assert_eq!(
        sent.iter().filter(|d| is_for(d, &staying)).count(),
        1,
        "the other phone's session is untouched and still notified"
    );
}

/// Design judgment 5 (L5 in the review): a logout that revokes only the access
/// half — no body, a shape `@momo/core` never sends but the API accepts — does
/// not end the session. Its refresh half is alive and can rotate, so the phone
/// is still signed in and keeps its registration. The session, and with it the
/// registration, ends when a logout kills the refresh half.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_access_only_logout_leaves_a_session_that_can_still_rotate() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let session = w.person_login().await;
    w.register(&session, &phone).await;

    let (status, body) = w.logout_with(&session.access, None).await;
    assert_eq!(status, 200, "an access-only logout succeeds");
    assert_eq!(body["revokedAccess"], true, "it revoked the access half");
    assert_eq!(
        body["revokedRefresh"], false,
        "and never saw a refresh half"
    );
    assert!(
        w.registration_live(&phone).await,
        "a session that can still rotate has not ended, and neither has its registration"
    );
    w.send("after an access-only logout").await;
    assert_eq!(
        w.drain_to(&phone).await,
        1,
        "the phone is still signed in and still notified"
    );

    let rotated = w.rotate(&session).await;
    w.logout(&rotated).await;
    assert!(
        !w.registration_live(&phone).await,
        "the logout that kills the refresh half ends the session and its registration"
    );
    w.send("after the full logout").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "no push after the session ended"
    );
}

/// M1 in the review, server half. Logout checks only signatures, so what it may
/// end is decided by what it actually revoked (`revoked_now`). A refresh half a
/// rotation already spent is no longer the session — its successor is. The
/// client race the phone/core PR closes (logout sent with the pair a rotation
/// was spending) must therefore end nothing here: the session lives on in the
/// successor pair, and that pair's logout ends it. Loosening the gate would let
/// anyone holding a stale pair end a session they no longer hold.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_logout_holding_a_spent_refresh_cannot_end_the_session() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let spent = w.person_login().await;
    w.register(&spent, &phone).await;
    let successor = w.rotate(&spent).await;

    let (status, body) = w.logout_with(&spent.access, Some(&spent.refresh)).await;
    assert_eq!(status, 200, "a logout with a spent pair still answers 200");
    assert_eq!(
        body["revokedRefresh"], false,
        "the rotation had already spent that refresh half"
    );
    assert!(
        w.registration_live(&phone).await,
        "a spent pair cannot end the session its successor still holds"
    );

    w.logout(&successor).await;
    assert!(
        !w.registration_live(&phone).await,
        "the successor pair's logout ends the session and its registration"
    );
    w.send("after the successor's logout").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "no push after the session ended"
    );
}

/// A registration with no lineage (`session_id` NULL) cannot be attributed to
/// any session, so no single-session logout may take it. 088 invalidates every
/// such row that exists when it runs; one can still appear later — written by
/// the old server while a deploy is under way, or by a credential that is not a
/// session. A launch re-registers and binds it; a member-wide end takes it
/// regardless (`a_password_change_also_ends_a_registration_from_before_the_lineage`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logout_never_touches_a_registration_it_cannot_attribute() {
    let _lock = test_lock().await;
    let w = world().await;
    let legacy = Phone::new();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(legacy.device_id)
    .bind(w.workspace)
    .bind(w.person_id)
    .execute(&w.su)
    .await
    .expect("seed legacy device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, $5)",
    )
    .bind(w.workspace)
    .bind(legacy.device_id)
    .bind(w.person_id)
    .bind(&legacy.apns_token)
    .bind(TOPIC)
    .execute(&w.su)
    .await
    .expect("seed legacy push token");

    let web = w.person_login().await;
    w.logout(&web).await;
    assert!(
        w.registration_live(&legacy).await,
        "a web logout must not end a phone registration it cannot attribute"
    );
    w.send("legacy row").await;
    assert_eq!(
        w.drain_to(&legacy).await,
        1,
        "the legacy row still delivers"
    );
}

/// The race `register_device` closes with `lock_session_for_registration`: a
/// phone registers at launch and the person taps sign-out while that request
/// is still in flight. The registration transaction here is held open right
/// after the real lock call (the rest of `register_device` cannot be paused, so
/// its two writes are replayed by hand with the lineage the lock returned);
/// the logout is the real route.
///
/// With the share lock the logout WAITS for the registration and then ends the
/// row it wrote. Without it the logout commits first, its invalidation sees
/// nothing, and the row written afterwards lives on under a dead session.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_logout_racing_an_in_flight_registration_still_ends_it() {
    let _lock = test_lock().await;
    let w = world().await;
    let session = w.person_login().await;
    let access_id: Uuid =
        sqlx::query_scalar("SELECT id FROM token WHERE token_hash = digest($1::text, 'sha256')")
            .bind(&session.access)
            .fetch_one(&w.su)
            .await
            .expect("the access row the phone registers with");

    let phone = Phone::new();
    let app = momo_app_pool().await;
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel::<()>();
    let (proceed_tx, proceed_rx) = tokio::sync::oneshot::channel::<()>();
    let (workspace, person, device_id, apns_token) = (
        w.workspace,
        w.person_id,
        phone.device_id,
        phone.apns_token.clone(),
    );
    let registration = tokio::spawn(async move {
        momo_db::with_tenant_tx(&app, workspace, move |conn| {
            Box::pin(async move {
                let lineage = match momo_auth::lock_session_for_registration(
                    conn, workspace, person, access_id,
                )
                .await?
                {
                    momo_auth::RegistrationSession::Live(Some(lineage)) => lineage,
                    other => panic!("a live post-088 session is expected, got {other:?}"),
                };
                locked_tx.send(()).expect("signal: lock held");
                proceed_rx.await.expect("signal: proceed");
                sqlx::query(
                    "INSERT INTO device (id, workspace_id, member_id, platform) \
                     VALUES ($1, $2, $3, 'ios'::device_platform)",
                )
                .bind(device_id)
                .bind(workspace)
                .bind(person)
                .execute(&mut *conn)
                .await?;
                sqlx::query(
                    "INSERT INTO push_token \
                       (workspace_id, device_id, member_id, apns_token, env, topic, session_id) \
                     VALUES ($1, $2, $3, $4, 'sandbox'::push_env, $5, $6)",
                )
                .bind(workspace)
                .bind(device_id)
                .bind(person)
                .bind(&apns_token)
                .bind(TOPIC)
                .bind(lineage)
                .execute(&mut *conn)
                .await?;
                Ok::<(), momo_db::DbError>(())
            })
        })
        .await
    });
    locked_rx.await.expect("the registration holds its lock");

    let (http, base, pair) = (w.http.clone(), w.base.clone(), session.clone());
    let logout = tokio::spawn(async move {
        http.post(format!("{base}/v1/auth/logout"))
            .bearer_auth(&pair.access)
            .json(&json!({ "refreshToken": pair.refresh }))
            .send()
            .await
            .expect("logout")
            .status()
            .as_u16()
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        !logout.is_finished(),
        "logout must wait for the registration that holds its session row"
    );

    proceed_tx.send(()).expect("release the registration");
    registration
        .await
        .expect("registration task")
        .expect("registration commits");
    assert_eq!(logout.await.expect("logout task"), 200, "logout succeeds");
    assert!(
        !w.registration_live(&phone).await,
        "the registration committed during the logout must still end with the session"
    );
}

/// ADR-0180 D5: 설정 › 기기 disconnects a linked phone. The phone's session
/// dies — and, with this fix, so does its push registration. The phone rotates
/// once first, through the linked refresh path, so the lineage has to survive
/// that path too.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn unlinking_a_linked_phone_ends_its_registration() {
    let _lock = test_lock().await;
    let w = world().await;
    let desktop = w.person_login().await;

    let issued = w
        .http
        .post(format!("{}/v1/auth/device-link", w.base))
        .bearer_auth(&desktop.access)
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .send()
        .await
        .expect("issue device link");
    assert_eq!(issued.status().as_u16(), 201, "desktop issues a link");
    let voucher = issued.json::<Value>().await.expect("issue body")["token"]
        .as_str()
        .expect("voucher")
        .to_string();
    let redeemed = w
        .http
        .post(format!("{}/v1/auth/device-link/redeem", w.base))
        .header("host", &w.host)
        .header("x-forwarded-proto", "http")
        .json(&json!({ "token": voucher, "device": { "name": "Phone 2677", "platform": "ios" } }))
        .send()
        .await
        .expect("redeem device link");
    assert_eq!(redeemed.status().as_u16(), 200, "phone redeems the link");
    let linked = session_from(&redeemed.json::<Value>().await.expect("redeem body"));

    let phone = Phone::new();
    w.register(&linked, &phone).await;
    let _rotated = w.rotate(&linked).await;
    w.send("linked phone").await;
    assert_eq!(
        w.drain_to(&phone).await,
        1,
        "control: the linked phone is notified"
    );

    let listed = w
        .http
        .get(format!("{}/v1/auth/devices", w.base))
        .bearer_auth(&desktop.access)
        .send()
        .await
        .expect("list linked devices")
        .json::<Value>()
        .await
        .expect("devices body");
    let link_id = listed["devices"]
        .as_array()
        .expect("devices array")
        .iter()
        .find(|row| row["label"] == "Phone 2677")
        .and_then(|row| row["id"].as_str())
        .expect("the linked phone is listed")
        .to_string();
    let unlinked = w
        .http
        .delete(format!("{}/v1/auth/devices/{link_id}", w.base))
        .bearer_auth(&desktop.access)
        .send()
        .await
        .expect("unlink");
    assert_eq!(
        unlinked.status().as_u16(),
        204,
        "desktop disconnects the phone"
    );

    assert!(
        !w.registration_live(&phone).await,
        "disconnecting a linked phone must invalidate its push registration"
    );
    w.send("after unlink").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "an unlinked phone receives no push"
    );
}

// ---------------------------------------------------------------------------
// member-wide ends: every session of the person dies at once
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_change_ends_every_registration_of_the_member() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let phone_session = w.person_login().await;
    w.register(&phone_session, &phone).await;

    let desktop = w.person_login().await;
    let changed = w
        .http
        .patch(format!(
            "{}/v1/workspaces/{}/members/me/password",
            w.base, w.workspace
        ))
        .bearer_auth(&desktop.access)
        .json(&json!({ "currentPassword": TEST_PASSWORD, "newPassword": NEW_PASSWORD }))
        .send()
        .await
        .expect("change password");
    assert_eq!(changed.status().as_u16(), 200, "password change succeeds");

    assert!(
        !w.registration_live(&phone).await,
        "a password change revokes every session — and every registration they made"
    );
    w.send("after password change").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "the phone is signed out and silent"
    );
}

/// L3 in the review. The member-wide ends are the ONLY path that reaches a
/// registration with no lineage: no single session can claim it. So a password
/// change must end those too, not just the rows it can attribute.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_change_also_ends_a_registration_from_before_the_lineage() {
    let _lock = test_lock().await;
    let w = world().await;
    let unbound = Phone::new();
    seed_unbound_registration(&w.su, w.workspace, w.person_id, &unbound).await;
    assert_eq!(
        w.registration_lineage(&unbound).await,
        None,
        "control: a live registration with no lineage"
    );
    assert!(w.registration_live(&unbound).await, "control: it is live");

    let desktop = w.person_login().await;
    let changed = w
        .http
        .patch(format!(
            "{}/v1/workspaces/{}/members/me/password",
            w.base, w.workspace
        ))
        .bearer_auth(&desktop.access)
        .json(&json!({ "currentPassword": TEST_PASSWORD, "newPassword": NEW_PASSWORD }))
        .send()
        .await
        .expect("change password");
    assert_eq!(changed.status().as_u16(), 200, "password change succeeds");

    assert!(
        !w.registration_live(&unbound).await,
        "every session ended, so every registration ends — attributable or not"
    );
    w.send("after password change").await;
    assert_eq!(
        w.drain_to(&unbound).await,
        0,
        "the unattributed phone is silent too"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_reset_claim_ends_every_registration_of_the_member() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let phone_session = w.person_login().await;
    w.register(&phone_session, &phone).await;

    let issued = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/members/{}/password-reset",
            w.base, w.workspace, w.person_id
        ))
        .bearer_auth(&w.sender.access)
        .send()
        .await
        .expect("issue password reset");
    assert_eq!(issued.status().as_u16(), 201, "owner issues a reset claim");
    let claim_token = issued.json::<Value>().await.expect("reset body")["token"]
        .as_str()
        .expect("reset token")
        .to_string();
    let claimed = w
        .http
        .post(format!("{}/v1/claim", w.base))
        .json(&json!({ "token": claim_token, "password": NEW_PASSWORD }))
        .send()
        .await
        .expect("claim reset");
    assert_eq!(
        claimed.status().as_u16(),
        200,
        "the reset claim is consumed"
    );

    assert!(
        !w.registration_live(&phone).await,
        "a password reset revokes every session — and every registration they made"
    );
    w.send("after reset").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "the phone is signed out and silent"
    );
}

/// Suspension alone hides the phone (judgment reads only active members), which
/// is why the real proof is reinstatement: the sessions stay dead, so the
/// registrations must too.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn suspension_ends_registrations_and_reinstatement_does_not_revive_them() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let session = w.person_login().await;
    w.register(&session, &phone).await;

    let member_path = format!("/v1/workspaces/{}/members/{}", w.workspace, w.person_id);
    w.admin_post(&format!("{member_path}/suspend")).await;
    w.admin_post(&format!("{member_path}/reinstate")).await;

    assert!(
        !w.registration_live(&phone).await,
        "suspension revoked every session; their registrations end with them"
    );
    w.send("after reinstatement").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "reinstatement restores the member, not the dead session's pushes"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn removal_ends_every_registration_of_the_member() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let session = w.person_login().await;
    w.register(&session, &phone).await;

    let removed = w
        .http
        .delete(format!(
            "{}/v1/workspaces/{}/members/{}",
            w.base, w.workspace, w.person_id
        ))
        .bearer_auth(&w.sender.access)
        .send()
        .await
        .expect("remove member");
    assert_eq!(removed.status().as_u16(), 200, "owner removes the member");
    assert!(
        !w.registration_live(&phone).await,
        "removal revokes every session; their registrations end with them"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn leaving_the_workspace_ends_every_registration_of_the_member() {
    let _lock = test_lock().await;
    let w = world().await;
    let phone = Phone::new();
    let phone_session = w.person_login().await;
    w.register(&phone_session, &phone).await;

    let desktop = w.person_login().await;
    let left = w
        .http
        .delete(format!(
            "{}/v1/workspaces/{}/members/me",
            w.base, w.workspace
        ))
        .bearer_auth(&desktop.access)
        .send()
        .await
        .expect("leave workspace");
    assert_eq!(left.status().as_u16(), 200, "the member leaves");
    assert!(
        !w.registration_live(&phone).await,
        "leaving revokes every session; their registrations end with them"
    );
}

// ---------------------------------------------------------------------------
// what 088 finds when it runs (H1), and the operator's set-owner (L2)
// ---------------------------------------------------------------------------

/// H1 in the review — REVIEW-GAP-A made into a proof of the upgrade itself.
///
/// A phone signed out BEFORE this PR deployed. The old server wrote its
/// registration with no lineage and its logout revoked the session without
/// touching push. After the upgrade nothing can reach that row: there is no
/// session left to end, and a member-wide end needs a password change or an
/// exit. Without 088's backfill it is notified for good (the review measured
/// `dispatches=1`); with it, the upgrade itself silences the phone.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_upgrade_silences_a_phone_that_signed_out_before_it() {
    let _lock = test_lock().await;
    let db = ScratchDb::create().await;
    let (su, fixture) = instance_at_087(&db).await;
    let signed_out = Phone::new();
    seed_unbound_registration(&su, fixture.workspace, fixture.person_id, &signed_out).await;
    let old = seed_pre_088_session(&su, fixture.workspace, fixture.person_id).await;
    // The old logout: both halves revoked, the registration left alone.
    sqlx::query(
        "UPDATE token SET revoked_at = now() \
          WHERE token_hash IN (digest($1::text, 'sha256'), digest($2::text, 'sha256'))",
    )
    .bind(&old.access)
    .bind(&old.refresh)
    .execute(&su)
    .await
    .expect("the old server's logout");

    let w = upgrade_to_088(&db, su, fixture).await;

    // REVIEW-GAP-A, after the upgrade: in and out again on the web.
    let web = w.person_login().await;
    w.logout(&web).await;
    assert_eq!(
        w.live_person_sessions().await,
        0,
        "the person has no live session anywhere"
    );
    w.send("after the upgrade").await;
    let dispatches = w.drain_to(&signed_out).await;
    println!("H1 legacy signed-out phone dispatches={dispatches}");
    assert_eq!(
        dispatches, 0,
        "a phone that signed out before the upgrade receives nothing after it"
    );
    assert!(
        !w.registration_live(&signed_out).await,
        "088 invalidated the registration no session could end"
    );
    drop(w);
    db.drop().await;
}

/// The cost of the full backfill (integrator decision (b)) and how it heals.
///
/// A phone still signed in across the upgrade loses its registration with
/// everyone else's: no pre-088 row says which session made it. It is silent
/// until its next cold start, where the boot rotation gives the pre-088 session
/// its lineage, PushProvider registers the same device and APNs token again,
/// and the reclaim UPDATE binds the row to that lineage — so this phone's own
/// logout ends it from then on.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_phone_signed_in_across_the_upgrade_rebinds_on_its_next_launch() {
    let _lock = test_lock().await;
    let db = ScratchDb::create().await;
    let (su, fixture) = instance_at_087(&db).await;
    let phone = Phone::new();
    seed_unbound_registration(&su, fixture.workspace, fixture.person_id, &phone).await;
    let signed_in = seed_pre_088_session(&su, fixture.workspace, fixture.person_id).await;

    let w = upgrade_to_088(&db, su, fixture).await;

    w.send("right after the upgrade").await;
    let dispatches = w.drain_to(&phone).await;
    println!("H1 legacy signed-in phone before its next launch dispatches={dispatches}");
    assert_eq!(
        dispatches, 0,
        "the cost of the full backfill: a signed-in phone is silent until it registers again"
    );

    // The next cold start: the boot rotation first …
    let launched = w.rotate(&signed_in).await;
    let lineage = w
        .lineage_of(&launched.access)
        .await
        .expect("the first rotation gives a pre-088 session its lineage");
    // … then PushProvider registers the same device and APNs token (reclaim).
    w.register(&launched, &phone).await;
    assert_eq!(
        w.registration_lineage(&phone).await,
        Some(lineage),
        "the reclaimed registration is bound to the session that made it"
    );
    w.send("after the next launch").await;
    assert_eq!(w.drain_to(&phone).await, 1, "the phone is notified again");

    w.logout(&launched).await;
    w.send("after signing out").await;
    assert_eq!(
        w.drain_to(&phone).await,
        0,
        "and its own logout now ends the registration"
    );
    drop(w);
    db.drop().await;
}

/// `momo-migrate set-owner` exactly as the binary runs `set_initial_owner.sql`
/// (`psql_file`: the file's own BEGIN/COMMIT, `ON_ERROR_STOP`, both values
/// through the environment only — never argv).
fn run_set_owner(url: &str, email: &str, password: &str) {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/set_initial_owner.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("-f")
        .arg(path)
        .env("MOMO_INITIAL_OWNER_EMAIL", email)
        .env("MOMO_INITIAL_OWNER_PASSWORD", password)
        .status()
        .expect("spawn psql for set_initial_owner.sql");
    assert!(status.success(), "set_initial_owner.sql failed to apply");
}

/// L2 in the review. `set-owner` is a credential rotation at the database-owner
/// boundary and already revokes every session of the owner, like a password
/// reset. So, like a password reset, it ends every registration those sessions
/// made — and only the owner's.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn set_owner_ends_the_owners_registrations_and_only_theirs() {
    let _lock = test_lock().await;
    let db = ScratchDb::create().await;
    assert!(
        !db.migrate_all().is_empty(),
        "a fresh database applies the tree"
    );
    apply_bootstrap_roles(&db.url);
    let su = superuser_pool_at(&db.url).await;

    // The operator's first run gives the seeded owner a way in.
    let owner_email = format!("owner-{}@push-session-end.test", Uuid::new_v4().simple());
    run_set_owner(&db.url, &owner_email, TEST_PASSWORD);
    let (teammate_id, teammate_email) = seed_human(&su, DEMO_WORKSPACE, "member").await;
    let dm = seed_dm(&su, DEMO_WORKSPACE, [teammate_id, DEMO_OWNER]).await;
    let w = World::open(
        &db.url,
        su,
        Fixture {
            workspace: DEMO_WORKSPACE,
            sender_email: teammate_email,
            person_id: DEMO_OWNER,
            person_email: owner_email,
            dm,
        },
    )
    .await;

    let owners_phone = Phone::new();
    let owner = w.person_login().await;
    w.register(&owner, &owners_phone).await;
    let teammates_phone = Phone::new();
    let teammate = w.sender.clone();
    w.register(&teammate, &teammates_phone).await;
    w.send("before the rotation").await;
    assert_eq!(
        w.drain_to(&owners_phone).await,
        1,
        "control: the owner's phone is notified"
    );

    // The rotation.
    run_set_owner(&db.url, &w.person_email, NEW_PASSWORD);
    assert_eq!(
        w.live_person_sessions().await,
        0,
        "control: set-owner revoked every session of the owner"
    );
    assert!(
        !w.registration_live(&owners_phone).await,
        "set-owner ends every registration the owner's sessions made"
    );
    assert!(
        w.registration_live(&teammates_phone).await,
        "a teammate's registration is not the owner's to end"
    );
    w.send("after the rotation").await;
    assert_eq!(
        w.drain_to(&owners_phone).await,
        0,
        "the owner's old phone is silent"
    );
    drop(w);
    db.drop().await;
}
