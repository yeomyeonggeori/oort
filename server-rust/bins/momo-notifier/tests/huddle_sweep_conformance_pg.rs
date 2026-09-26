//! DB-backed conformance for the huddle ghost sweep (#2758 / ADR-0122 증보
//! D-H4).
//!
//! Pools mirror production: the candidate read runs as `momo_notifier`
//! (BYPASSRLS, read only), every settlement as `momo_app` (RLS-bound).
//!
//! A real PG (every migration + `bootstrap_roles.sql`) and a mock LiveKit
//! RoomService on a loopback port. The mock verifies the HS256 RoomService
//! token the sweep signs (issuer, `roomAdmin`, room scope) and answers
//! `ListParticipants` from a per-room table. Rooms the table does not name
//! answer **503**, so huddles other suites left in a shared DB are "unreachable"
//! to this sweep and are never touched.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test huddle_sweep_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `crashed_participant_ends_the_huddle_after_two_sweeps_and_frees_the_channel` | remove the sweep's settlement call, settle on the first miss, or end outside the shared end path (no `huddle_ended` outbox) |
//! | `a_present_participant_is_never_closed` | stop consulting the LiveKit answer |
//! | `unreachable_livekit_changes_nothing` | read an error/503/dead port as an empty room |
//! | `a_participant_still_connecting_is_not_a_ghost` | drop the join grace |
//! | `a_just_started_huddle_is_not_judged` | drop the `started_at` grace (the room does not exist until the first connection) |
//! | `a_write_pool_that_bypasses_rls_is_refused` | drop the RLS-bound write-pool check, or write through the BYPASSRLS notifier pool |
//! | `a_never_joined_huddle_ends_after_two_empty_sweeps` | drop the empty-huddle branch |
//! | `a_rejoin_after_the_observation_survives_the_settlement` | key `left_at` on `(huddle_id, member_id)` without `joined_at` |
//! | `real_livekit_observes_an_empty_room_and_the_ghost_is_settled` | change the RoomService token or Twirp call shape (real `livekit-server`; skipped without `LIVEKIT_TEST_*`) |

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_messaging::huddle_sweep::{settle_swept_departures, SweptParticipant};
use momo_messaging::{join_huddle, leave_huddle, start_huddle, HuddleActor};
use momo_notifier::huddle_sweep::{HuddleSweepConfig, HuddleSweeper};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const LK_KEY: &str = "sweep-test-key";
const LK_SECRET: &str = "sweep-test-secret-0123456789abcdef";

// ---------------------------------------------------------------------------
// harness (same contract as notifier_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, password: String) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

async fn momo_app_pool() -> PgPool {
    role_pool(
        "momo_app",
        role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await
}

async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        role_password("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
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
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The sweep reads every active huddle; serialize the tests in this binary.
async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// mock LiveKit RoomService
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MockLiveKit {
    /// room (uppercase huddle id) → identities LiveKit reports. Absent = 503.
    rooms: HashMap<String, Vec<String>>,
    calls: usize,
    rejected_tokens: usize,
}

type Shared = Arc<Mutex<MockLiveKit>>;

async fn list_participants(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let room = body["room"].as_str().unwrap_or_default().to_string();
    let mut mock = state.lock().unwrap();
    mock.calls += 1;

    // The token the sweep signs must be a RoomService admin grant scoped to
    // exactly this room, issued by the configured key.
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[LK_KEY]);
    let claims = decode::<Value>(
        token,
        &DecodingKey::from_secret(LK_SECRET.as_bytes()),
        &validation,
    );
    let authorized = matches!(&claims, Ok(data)
        if data.claims["video"]["roomAdmin"] == json!(true)
            && data.claims["video"]["room"] == json!(room));
    if !authorized {
        mock.rejected_tokens += 1;
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code": "unauthenticated", "msg": "permissions denied"})),
        );
    }

    match mock.rooms.get(&room) {
        Some(identities) => (
            StatusCode::OK,
            Json(json!({
                "participants": identities
                    .iter()
                    .map(|identity| json!({"sid": format!("PA_{identity}"), "identity": identity}))
                    .collect::<Vec<_>>()
            })),
        ),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code": "unavailable", "msg": "mock: room not staged"})),
        ),
    }
}

async fn spawn_mock_livekit() -> (Shared, String) {
    let state: Shared = Arc::default();
    let app = Router::new()
        .route(
            "/twirp/livekit.RoomService/ListParticipants",
            post(list_participants),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock LiveKit");
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (state, format!("ws://{address}"))
}

fn sweeper_for(url: &str) -> HuddleSweeper {
    HuddleSweeper::new(
        HuddleSweepConfig::parse(
            Some(LK_KEY),
            Some(LK_SECRET),
            Some(url),
            Duration::from_secs(30),
        )
        .expect("complete LiveKit config"),
    )
}

fn stage_room(mock: &Shared, huddle_id: Uuid, present: &[Uuid]) {
    mock.lock().unwrap().rooms.insert(
        huddle_id.to_string().to_uppercase(),
        present
            .iter()
            .map(|id| id.to_string().to_uppercase())
            .collect(),
    );
}

fn unstage_room(mock: &Shared, huddle_id: Uuid) {
    mock.lock()
        .unwrap()
        .rooms
        .remove(&huddle_id.to_string().to_uppercase());
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace_id: Uuid,
    channel_id: Uuid,
    members: Vec<Uuid>,
}

async fn seed_tenant(su: &PgPool, member_count: usize) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(format!("hs-{}", workspace_id.simple()))
        .execute(su)
        .await
        .expect("seed workspace");
    let mut members = Vec::new();
    for _ in 0..member_count {
        let member_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human', 'active', $3, $3)",
        )
        .bind(member_id)
        .bind(workspace_id)
        .bind(format!("hs-{}", &member_id.simple().to_string()[..12]))
        .execute(su)
        .await
        .expect("seed member");
        members.push(member_id);
    }
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', $3, $4)",
    )
    .bind(channel_id)
    .bind(workspace_id)
    .bind(format!("hs-{}", &channel_id.simple().to_string()[..8]))
    .bind(members[0])
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (workspace_id, channel_id, last_seq) VALUES ($1, $2, 0)")
        .bind(workspace_id)
        .bind(channel_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member_id in &members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed membership");
    }
    Tenant {
        workspace_id,
        channel_id,
        members,
    }
}

fn actor(member_id: Uuid) -> HuddleActor {
    HuddleActor {
        member_id,
        via_token_id: None,
    }
}

/// Start a huddle and join the given members through the product functions,
/// as the runtime role — exactly the rows a real client leaves behind.
async fn open_huddle(app: &PgPool, tenant: &Tenant, joiners: &[Uuid]) -> Uuid {
    let started = start_huddle(
        app,
        tenant.workspace_id,
        tenant.channel_id,
        actor(tenant.members[0]),
    )
    .await
    .expect("start huddle");
    assert!(started.created, "fixture channel has no active huddle");
    for member_id in joiners {
        join_huddle(
            app,
            tenant.workspace_id,
            started.huddle.id,
            actor(*member_id),
            |_, _, _| Ok(()),
        )
        .await
        .expect("join huddle");
    }
    started.huddle.id
}

/// Age the huddle and its rows past the join grace: the client "crashed" long
/// enough ago that it cannot still be connecting.
async fn age_huddle(su: &PgPool, huddle_id: Uuid) {
    sqlx::query("UPDATE huddle SET started_at = started_at - interval '10 minutes' WHERE id = $1")
        .bind(huddle_id)
        .execute(su)
        .await
        .expect("age huddle");
    sqlx::query(
        "UPDATE huddle_participant SET joined_at = joined_at - interval '5 minutes' \
          WHERE huddle_id = $1",
    )
    .bind(huddle_id)
    .execute(su)
    .await
    .expect("age participants");
}

/// Age only the huddle row, leaving participant rows fresh.
async fn age_huddle_only(su: &PgPool, huddle_id: Uuid) {
    sqlx::query("UPDATE huddle SET started_at = started_at - interval '10 minutes' WHERE id = $1")
        .bind(huddle_id)
        .execute(su)
        .await
        .expect("age huddle");
}

/// Age only the participant rows, leaving the huddle just started.
async fn age_participants_only(su: &PgPool, huddle_id: Uuid) {
    sqlx::query(
        "UPDATE huddle_participant SET joined_at = joined_at - interval '5 minutes' \
          WHERE huddle_id = $1",
    )
    .bind(huddle_id)
    .execute(su)
    .await
    .expect("age participants");
}

async fn huddle_ended(su: &PgPool, huddle_id: Uuid) -> bool {
    sqlx::query_scalar("SELECT ended_at IS NOT NULL FROM huddle WHERE id = $1")
        .bind(huddle_id)
        .fetch_one(su)
        .await
        .expect("read huddle")
}

async fn open_members(su: &PgPool, huddle_id: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(
        "SELECT member_id FROM huddle_participant \
          WHERE huddle_id = $1 AND left_at IS NULL ORDER BY joined_at",
    )
    .bind(huddle_id)
    .fetch_all(su)
    .await
    .expect("read participants")
}

async fn huddle_events(su: &PgPool, huddle_id: Uuid, event_type: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE kind = 'broadcast' \
            AND payload->'data'->>'type' = $2 \
            AND payload->'data'->'payload'->>'huddle_id' = $1",
    )
    .bind(huddle_id.to_string().to_uppercase())
    .bind(event_type)
    .fetch_one(su)
    .await
    .expect("count huddle outbox rows")
}

async fn sweep_audits(su: &PgPool, huddle_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE action = 'huddle.sweep_settled' AND target_id = $1 AND actor_member_id IS NULL",
    )
    .bind(huddle_id)
    .fetch_one(su)
    .await
    .expect("count sweep audit rows")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// The issue's acceptance scenario: crash → two sweeps → huddle ended → a new
/// huddle starts in the same channel.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn crashed_participant_ends_the_huddle_after_two_sweeps_and_frees_the_channel() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    let crashed = tenant.members[0];
    let huddle_id = open_huddle(&app, &tenant, &[crashed]).await;
    age_huddle(&su, huddle_id).await;
    // The client died: LiveKit has nobody in the room.
    stage_room(&mock, huddle_id, &[]);

    let mut sweeper = sweeper_for(&url);

    let first = sweeper.sweep_once(&notifier, &app).await.expect("sweep 1");
    assert_eq!(first.participants_marked_left, 0, "one miss is not enough");
    assert_eq!(first.first_misses, 1);
    assert_eq!(open_members(&su, huddle_id).await, vec![crashed]);
    assert!(!huddle_ended(&su, huddle_id).await);

    let second = sweeper.sweep_once(&notifier, &app).await.expect("sweep 2");
    assert_eq!(second.participants_marked_left, 1);
    assert_eq!(second.huddles_ended, 1);
    assert!(open_members(&su, huddle_id).await.is_empty());
    assert!(huddle_ended(&su, huddle_id).await, "the ghost huddle ended");
    assert_eq!(
        huddle_events(&su, huddle_id, "huddle_ended").await,
        1,
        "exactly one huddle_ended outbox row, from the shared end path"
    );
    assert_eq!(sweep_audits(&su, huddle_id).await, 1);
    assert_eq!(mock.lock().unwrap().rejected_tokens, 0);

    // The channel is free again.
    let restarted = start_huddle(
        &app,
        tenant.workspace_id,
        tenant.channel_id,
        actor(tenant.members[0]),
    )
    .await
    .expect("start a new huddle in the same channel");
    assert!(restarted.created, "a new huddle starts after the sweep");
    assert_ne!(restarted.huddle.id, huddle_id);

    // A third sweep has nothing left to do for the old huddle.
    let third = sweeper.sweep_once(&notifier, &app).await.expect("sweep 3");
    assert_eq!(third.participants_marked_left, 0);
    assert_eq!(huddle_events(&su, huddle_id, "huddle_ended").await, 1);

    // Tidy: end the restarted huddle so later tests see only their own.
    unstage_room(&mock, huddle_id);
    sqlx::query("UPDATE huddle SET ended_at = now() WHERE id = $1")
        .bind(restarted.huddle.id)
        .execute(&su)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_present_participant_is_never_closed() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 2).await;
    let (alive, crashed) = (tenant.members[0], tenant.members[1]);
    let huddle_id = open_huddle(&app, &tenant, &[alive, crashed]).await;
    age_huddle(&su, huddle_id).await;
    stage_room(&mock, huddle_id, &[alive]);

    let mut sweeper = sweeper_for(&url);
    for _ in 0..3 {
        sweeper.sweep_once(&notifier, &app).await.expect("sweep");
    }

    assert_eq!(
        open_members(&su, huddle_id).await,
        vec![alive],
        "only the absent member is closed"
    );
    assert!(
        !huddle_ended(&su, huddle_id).await,
        "someone is still there"
    );
    assert_eq!(huddle_events(&su, huddle_id, "huddle_ended").await, 0);
    assert!(
        huddle_events(&su, huddle_id, "huddle_participants_changed").await >= 3,
        "two joins + the sweep's departure all broadcast"
    );

    // The survivor leaves normally; the human path still ends the huddle.
    let left = leave_huddle(&app, tenant.workspace_id, huddle_id, actor(alive))
        .await
        .expect("leave");
    assert!(left.ended);
    unstage_room(&mock, huddle_id);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn unreachable_livekit_changes_nothing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    let member = tenant.members[0];
    let huddle_id = open_huddle(&app, &tenant, &[member]).await;
    age_huddle(&su, huddle_id).await;

    // (a) LiveKit answers 503 for this room (not staged).
    let mut sweeper = sweeper_for(&url);
    for _ in 0..3 {
        let stats = sweeper.sweep_once(&notifier, &app).await.expect("sweep");
        assert!(stats.livekit_unreachable >= 1);
        assert_eq!(stats.participants_marked_left, 0);
    }
    // (b) Nothing listens at all.
    let dead = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("ws://{address}")
    };
    let mut deaf = sweeper_for(&dead);
    for _ in 0..3 {
        let stats = deaf.sweep_once(&notifier, &app).await.expect("sweep");
        assert!(stats.livekit_unreachable >= 1);
        assert_eq!(stats.participants_marked_left, 0);
    }

    assert_eq!(open_members(&su, huddle_id).await, vec![member]);
    assert!(!huddle_ended(&su, huddle_id).await);
    assert_eq!(huddle_events(&su, huddle_id, "huddle_ended").await, 0);
    assert_eq!(sweep_audits(&su, huddle_id).await, 0);

    // (c) An outage between two misses does not turn one miss into two.
    stage_room(&mock, huddle_id, &[]);
    let first = sweeper.sweep_once(&notifier, &app).await.expect("miss 1");
    assert_eq!(first.first_misses, 1);
    unstage_room(&mock, huddle_id);
    let outage = sweeper.sweep_once(&notifier, &app).await.expect("outage");
    assert_eq!(outage.participants_marked_left, 0);
    assert_eq!(open_members(&su, huddle_id).await, vec![member]);

    leave_huddle(&app, tenant.workspace_id, huddle_id, actor(member))
        .await
        .expect("leave");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_participant_still_connecting_is_not_a_ghost() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    let member = tenant.members[0];
    // The huddle is old enough to judge, but this row was written just now:
    // the client may still be reaching LiveKit.
    let huddle_id = open_huddle(&app, &tenant, &[member]).await;
    age_huddle_only(&su, huddle_id).await;
    stage_room(&mock, huddle_id, &[]);

    let mut sweeper = sweeper_for(&url);
    for _ in 0..3 {
        let stats = sweeper.sweep_once(&notifier, &app).await.expect("sweep");
        assert_eq!(stats.participants_marked_left, 0);
    }
    assert_eq!(open_members(&su, huddle_id).await, vec![member]);
    assert!(!huddle_ended(&su, huddle_id).await);

    leave_huddle(&app, tenant.workspace_id, huddle_id, actor(member))
        .await
        .expect("leave");
    unstage_room(&mock, huddle_id);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_never_joined_huddle_ends_after_two_empty_sweeps() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    // Started, and the starter's join never arrived.
    let huddle_id = open_huddle(&app, &tenant, &[]).await;
    age_huddle(&su, huddle_id).await;
    stage_room(&mock, huddle_id, &[]);

    let mut sweeper = sweeper_for(&url);
    sweeper.sweep_once(&notifier, &app).await.expect("sweep 1");
    assert!(
        !huddle_ended(&su, huddle_id).await,
        "one empty look is not enough"
    );
    let second = sweeper.sweep_once(&notifier, &app).await.expect("sweep 2");
    assert_eq!(second.huddles_ended, 1);
    assert!(huddle_ended(&su, huddle_id).await);
    assert_eq!(huddle_events(&su, huddle_id, "huddle_ended").await, 1);

    let restarted = start_huddle(
        &app,
        tenant.workspace_id,
        tenant.channel_id,
        actor(tenant.members[0]),
    )
    .await
    .expect("restart");
    assert!(restarted.created);
    sqlx::query("UPDATE huddle SET ended_at = now() WHERE id = $1")
        .bind(restarted.huddle.id)
        .execute(&su)
        .await
        .unwrap();
    unstage_room(&mock, huddle_id);
}

/// The LiveKit room does not exist until the first participant connects, so a
/// huddle that has just started looks exactly like a ghost. It is not judged
/// until `started_at` is past the start grace — even with an old-looking row.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_just_started_huddle_is_not_judged() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    let member = tenant.members[0];
    let huddle_id = open_huddle(&app, &tenant, &[member]).await;
    age_participants_only(&su, huddle_id).await;
    stage_room(&mock, huddle_id, &[]);

    let mut sweeper = sweeper_for(&url);
    for _ in 0..3 {
        let stats = sweeper.sweep_once(&notifier, &app).await.expect("sweep");
        assert!(stats.too_young >= 1, "the fresh huddle is skipped");
        assert_eq!(stats.participants_marked_left, 0);
    }
    assert_eq!(open_members(&su, huddle_id).await, vec![member]);
    assert!(!huddle_ended(&su, huddle_id).await);

    // A never-joined huddle inside the grace is spared the same way.
    let tenant2 = seed_tenant(&su, 1).await;
    let empty_id = open_huddle(&app, &tenant2, &[]).await;
    stage_room(&mock, empty_id, &[]);
    for _ in 0..3 {
        sweeper.sweep_once(&notifier, &app).await.expect("sweep");
    }
    assert!(!huddle_ended(&su, empty_id).await);

    leave_huddle(&app, tenant.workspace_id, huddle_id, actor(member))
        .await
        .expect("leave");
    sqlx::query("UPDATE huddle SET ended_at = now() WHERE id = $1")
        .bind(empty_id)
        .execute(&su)
        .await
        .unwrap();
    unstage_room(&mock, huddle_id);
    unstage_room(&mock, empty_id);
}

/// The sweep adds no RLS-bypassing write path: a write pool whose role is
/// BYPASSRLS (the notifier's own) is refused before anything is written, and
/// the `momo_app` pool it does write through is filtered by the tenant GUC.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_write_pool_that_bypasses_rls_is_refused() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let (mock, url) = spawn_mock_livekit().await;
    let tenant = seed_tenant(&su, 1).await;
    let member = tenant.members[0];
    let huddle_id = open_huddle(&app, &tenant, &[member]).await;
    age_huddle(&su, huddle_id).await;
    stage_room(&mock, huddle_id, &[]);

    let mut sweeper = sweeper_for(&url);
    for _ in 0..2 {
        let error = sweeper
            .sweep_once(&notifier, &notifier)
            .await
            .expect_err("a BYPASSRLS write pool must be refused");
        assert!(
            error.to_string().contains("momo_notifier"),
            "the refusal names the role: {error}"
        );
    }
    assert_eq!(open_members(&su, huddle_id).await, vec![member]);
    assert!(!huddle_ended(&su, huddle_id).await);
    assert_eq!(sweep_audits(&su, huddle_id).await, 0);

    // The RLS-bound pool really is bound: under another tenant's GUC the
    // huddle is invisible, so the settlement is a no-op race.
    let joined_at = sqlx::query_scalar(
        "SELECT joined_at FROM huddle_participant WHERE huddle_id = $1 AND left_at IS NULL",
    )
    .bind(huddle_id)
    .fetch_one(&su)
    .await
    .unwrap();
    let foreign = seed_tenant(&su, 1).await;
    let settlement = settle_swept_departures(
        &app,
        foreign.workspace_id,
        huddle_id,
        vec![SweptParticipant {
            member_id: member,
            joined_at,
        }],
        true,
    )
    .await
    .expect("settle under a foreign GUC");
    assert!(settlement.raced, "RLS hides another tenant's huddle");
    assert_eq!(open_members(&su, huddle_id).await, vec![member]);

    leave_huddle(&app, tenant.workspace_id, huddle_id, actor(member))
        .await
        .expect("leave");
    unstage_room(&mock, huddle_id);
}

/// The observation is made outside the transaction. A member who leaves and
/// re-joins in between has a new row; the settlement aimed at the old row must
/// not close the new one, and must not end the huddle.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) + bootstrap roles"]
async fn a_rejoin_after_the_observation_survives_the_settlement() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    let tenant = seed_tenant(&su, 2).await;
    let (member, other) = (tenant.members[0], tenant.members[1]);
    let huddle_id = open_huddle(&app, &tenant, &[member, other]).await;
    age_huddle(&su, huddle_id).await;
    let stale: SweptParticipant = {
        let joined_at = sqlx::query_scalar(
            "SELECT joined_at FROM huddle_participant \
              WHERE huddle_id = $1 AND member_id = $2 AND left_at IS NULL",
        )
        .bind(huddle_id)
        .bind(member)
        .fetch_one(&su)
        .await
        .unwrap();
        SweptParticipant {
            member_id: member,
            joined_at,
        }
    };
    // Leave and re-join after the sweep's observation.
    leave_huddle(&app, tenant.workspace_id, huddle_id, actor(member))
        .await
        .unwrap();
    join_huddle(
        &app,
        tenant.workspace_id,
        huddle_id,
        actor(member),
        |_, _, _| Ok(()),
    )
    .await
    .unwrap();

    let settlement = settle_swept_departures(
        &notifier,
        tenant.workspace_id,
        huddle_id,
        vec![stale],
        false,
    )
    .await
    .expect("settle");
    assert!(settlement.raced);
    assert!(settlement.marked_left.is_empty());
    let mut open = open_members(&su, huddle_id).await;
    open.sort();
    let mut expected = vec![member, other];
    expected.sort();
    assert_eq!(open, expected, "the re-joined row survives");
    assert!(!huddle_ended(&su, huddle_id).await);

    for id in [member, other] {
        leave_huddle(&app, tenant.workspace_id, huddle_id, actor(id))
            .await
            .unwrap();
    }
}

/// Against a real `livekit/livekit-server` (the pinned compose image), when
/// `LIVEKIT_TEST_URL` / `LIVEKIT_TEST_KEY` / `LIVEKIT_TEST_SECRET` are set:
/// the token and Twirp call the sweep makes are accepted, and a room nobody is
/// in is an *observation* (two of them close the ghost), not an outage.
/// Skipped (passes trivially, with a note) when the variables are absent.
#[tokio::test]
#[ignore = "needs DATABASE_URL + LIVEKIT_TEST_{URL,KEY,SECRET} (real livekit-server)"]
async fn real_livekit_observes_an_empty_room_and_the_ghost_is_settled() {
    let (Ok(url), Ok(key), Ok(secret)) = (
        std::env::var("LIVEKIT_TEST_URL"),
        std::env::var("LIVEKIT_TEST_KEY"),
        std::env::var("LIVEKIT_TEST_SECRET"),
    ) else {
        eprintln!("LIVEKIT_TEST_* unset — real LiveKit leg skipped");
        return;
    };
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let (su, app, notifier) = (
        superuser_pool().await,
        momo_app_pool().await,
        momo_notifier_pool().await,
    );
    // The real server answers an empty list for every room, so any other
    // active huddle in this DB would be swept too. Refuse to run beside one.
    let residue: i64 = sqlx::query_scalar("SELECT count(*) FROM huddle WHERE ended_at IS NULL")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        residue, 0,
        "run this leg on a DB with no other active huddle"
    );

    let tenant = seed_tenant(&su, 1).await;
    let member = tenant.members[0];
    let huddle_id = open_huddle(&app, &tenant, &[member]).await;
    age_huddle(&su, huddle_id).await;

    let mut sweeper = HuddleSweeper::new(
        HuddleSweepConfig::parse(
            Some(&key),
            Some(&secret),
            Some(&url),
            Duration::from_secs(30),
        )
        .expect("complete LiveKit config"),
    );
    let first = sweeper.sweep_once(&notifier, &app).await.expect("sweep 1");
    assert_eq!(
        first.livekit_unreachable, 0,
        "real LiveKit accepted the call"
    );
    assert_eq!(first.first_misses, 1);
    let second = sweeper.sweep_once(&notifier, &app).await.expect("sweep 2");
    assert_eq!(second.livekit_unreachable, 0);
    assert_eq!(second.participants_marked_left, 1);
    assert!(huddle_ended(&su, huddle_id).await);

    // A wrong secret is refused by the real server and changes nothing.
    let tenant = seed_tenant(&su, 1).await;
    let huddle_id = open_huddle(&app, &tenant, &[tenant.members[0]]).await;
    age_huddle(&su, huddle_id).await;
    let mut forged = HuddleSweeper::new(
        HuddleSweepConfig::parse(
            Some(&key),
            Some("not-the-livekit-secret-0123456789"),
            Some(&url),
            Duration::from_secs(30),
        )
        .unwrap(),
    );
    for _ in 0..2 {
        let stats = forged
            .sweep_once(&notifier, &app)
            .await
            .expect("forged sweep");
        assert_eq!(stats.livekit_unreachable, 1, "401 is not an empty room");
    }
    assert_eq!(open_members(&su, huddle_id).await, vec![tenant.members[0]]);
    leave_huddle(
        &app,
        tenant.workspace_id,
        huddle_id,
        actor(tenant.members[0]),
    )
    .await
    .unwrap();
}
