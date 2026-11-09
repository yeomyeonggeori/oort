//! DB-backed conformance for the work-session stop notices (#5594, ADR-0188 D7·D8, ADR-0220 P2 ③·④).
//!
//! When a member Mac's work stops, the session's owner hears it — and nobody else does:
//!
//! * the tier sweep orphans a session whose Mac went quiet → one System line in the session's thread
//!   (「맥 연결이 끊겨 작업이 멈췄어요」), the session's pending permission requests cancelled, and the
//!   owner pushed on the existing `resume_offer` reason (`momo.work`);
//! * the work-permission expiry sweep closes a request at its deadline → one line
//!   (「10분이 지나 이 요청은 닫혔어요」) and the owner pushed on the `work_notice` arm (`mention`,
//!   `momo.work`);
//! * a failure line (written by the server when the Mac ends a session with an error) reaches the
//!   owner the same way, not while they are reading, and not when they switched 「에이전트의 답」 off;
//! * a refused-spawn line pushes nobody — not even a DM peer through the `dm` arm.
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles (the harness applies every migration
//! and `bootstrap_roles.sql`, then sweeps and drains as `momo_notifier`):
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:25912/w5594 \
//!   cargo test -p momo-notifier --test work_session_notice_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_lost_mac_writes_one_line_pushes_only_the_owner_and_its_request_does_not_speak_twice` | drop the line from `converge_in_tx`; drop the owner condition or the arm; let the expiry sweep write a line for a session that is not running |
//! | `a_lost_mac_in_a_dm_never_reaches_the_dm_peer` | put the owner condition back in the arm's `WHEN` (the peer falls through to `dm`) |
//! | `a_lost_mac_under_a_finished_session_writes_the_line_but_pushes_nobody` | drop the `was_running` gate (every finished session of a sleeping Mac pushes) |
//! | `a_policy_that_ends_the_session_is_a_failure_notice_not_a_resume_offer` | push `resume_offer` for a session that cannot be resumed |
//! | `a_lapsed_permission_request_is_closed_once_with_one_line_and_an_owner_push` | drop the sweep's line; expire a request before its deadline; write a line for a session that is not running; push the peer |
//! | `a_failure_line_reaches_the_owner_unless_reading_or_switched_off` | drop the reading window or the `agentAnswer` switch from the arm |
//! | `a_refused_spawn_line_pushes_nobody_even_in_a_dm` | let `spawn_refused` select the owner, or let the arm fall through to `dm` |
//! | `a_notice_naming_someone_elses_session_pushes_nobody` | drop the `work_session` re-check |
//! | `a_switched_off_persona_in_an_admitted_dm_holds_back_neither_sweep` (#5614 H1) | drop the DM seat check (the persona's line is refused and nothing says the Mac was lost) |
//! | `a_line_that_cannot_be_written_never_holds_back_the_fact` (#5614 H1) | write the line without its SAVEPOINT (the transition and the expiry roll back, tick after tick) |
//! | `the_expiry_sweep_refuses_a_write_pool_that_bypasses_rls` (#5614 M2) | drop `ensure_write_pool_rls_bound` from the sweep |

use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_notifier::work_permission_sweep::sweep_lapsed_work_permissions;
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
use momo_t3::sweep::{converge_stale_session, stale_session_candidates};
use momo_t3::work_notice::{
    post_work_notice_in_tx, NoticeSite, SpawnRefusalReason, WorkNotice, BODY_HOST_LOST,
    BODY_PERMISSION_EXPIRED,
};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same shape as work_permission_push_conformance_pg.rs)
// ---------------------------------------------------------------------------

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

/// The BYPASSRLS notifier credential (`bootstrap_roles.sql`).
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_notifier").password(&password))
        .await
        .expect("connect as momo_notifier (run bootstrap_roles.sql first)")
}

/// The RLS-bound application credential (`bootstrap_roles.sql`): the expiry sweep's write pool.
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

/// One expiry-sweep pass the way the notifier runs it: the read on the notifier pool, every write
/// on the RLS-bound app pool.
async fn expiry_sweep() -> momo_notifier::work_permission_sweep::WorkPermissionSweepStats {
    sweep_lapsed_work_permissions(&momo_notifier_pool().await, &momo_app_pool().await, 10_000)
        .await
        .expect("expiry sweep")
}

fn resolve_psql() -> std::path::PathBuf {
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
        let path = std::path::PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn ensure_schema_and_roles() {
    static READY: std::sync::Mutex<bool> = std::sync::Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let status = std::process::Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The sweeps and the drain are global, so two tests at once would eat each other's rows.
async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Push every candidate this test does not own out of the claim window (only reschedules).
async fn focus_candidates(su: &PgPool, keep_workspace: Uuid) {
    sqlx::query(
        "UPDATE outbox SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind = 'push_candidate' AND status = 'pending' AND workspace_id <> $1",
    )
    .bind(keep_workspace)
    .execute(su)
    .await
    .expect("park candidates belonging to other fixtures");
}

struct RecordingDispatcher {
    sent: Mutex<Vec<PushDispatch>>,
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingDispatcher {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    PublicChannel,
    /// A DM of the owner and a peer human: the `dm` arm is in sight.
    GroupDm,
    /// A group DM the owner's personal agent was admitted to (`dm_key = 'admitted:' || id`, the
    /// `dm_agents.rs` shape): the DM write boundary (migration 156) judges the agent's INSERTs.
    /// The agent is a member.
    AdmittedDm,
}

struct Room {
    workspace_id: Uuid,
    channel_id: Uuid,
    owner: Uuid,
    owner_device: Uuid,
    peer: Uuid,
    peer_device: Uuid,
    alias: Uuid,
    host_id: Uuid,
    session_id: Uuid,
    root_id: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("h{}", id.simple());
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
    id
}

async fn seed_device(su: &PgPool, workspace: Uuid, member: Uuid) -> Uuid {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed push token");
    device
}

/// A running session of `owner` on their own Mac. `persona`: the session was called through the
/// owner's personal agent, so its lines speak as the agent (ADR-0198 T5 확정 6).
async fn seed_room(su: &PgPool, shape: Shape, persona: bool) -> Room {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_member(su, workspace_id, "human").await;
    let peer = seed_member(su, workspace_id, "human").await;
    let alias = seed_member(su, workspace_id, "agent").await;
    let channel_id = Uuid::new_v4();
    match shape {
        Shape::PublicChannel => sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)",
        )
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("room-{}", &channel_id.simple().to_string()[..8])),
        Shape::GroupDm => sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
             VALUES ($1, $2, 'dm', 'dm', $3)",
        )
        .bind(channel_id)
        .bind(workspace_id)
        .bind(channel_id.simple().to_string()),
        Shape::AdmittedDm => sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
             VALUES ($1, $2, 'dm', 'dm', $3)",
        )
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("admitted:{channel_id}")),
    }
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 1)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    let seated: &[Uuid] = if shape == Shape::AdmittedDm {
        &[owner, peer, alias]
    } else {
        &[owner, peer]
    };
    for member in seated.iter().copied() {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("seed membership");
    }
    let owner_device = seed_device(su, workspace_id, owner).await;
    let peer_device = seed_device(su, workspace_id, peer).await;
    let host_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'workd', 'mac', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host_id)
    .bind(workspace_id)
    .bind(owner)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed work host");
    let root_id: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props) \
         VALUES ($1, $2, 1, 1, 0, $3, 'system', '{\"kind\":\"work_session\"}'::jsonb) RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(owner)
    .fetch_one(su)
    .await
    .expect("seed session root card");
    let session_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, \
            persona_member_id) \
         VALUES ($1, $2, $3, $4, $5, 'claude', '빌드 보기', $6) RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(owner)
    .bind(host_id)
    .bind(root_id)
    .bind(persona.then_some(alias))
    .fetch_one(su)
    .await
    .expect("seed work session");
    Room {
        workspace_id,
        channel_id,
        owner,
        owner_device,
        peer,
        peer_device,
        alias,
        host_id,
        session_id,
        root_id,
    }
}

impl Room {
    fn author(&self, persona: bool) -> Uuid {
        if persona {
            self.alias
        } else {
            self.owner
        }
    }
}

/// The Mac went quiet ten minutes ago.
async fn mac_goes_quiet(su: &PgPool, room: &Room) {
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - interval '10 minutes' \
          WHERE id = $1",
    )
    .bind(room.host_id)
    .execute(su)
    .await
    .expect("stale host");
}

/// One tier-sweep pass over this room's session only, as `momo_notifier`.
async fn sweep_room(room: &Room) -> Option<momo_t3::sweep::StaleConvergence> {
    let pool = momo_notifier_pool().await;
    let candidates = stale_session_candidates(&pool, 90, 10_000)
        .await
        .expect("candidate read");
    let candidate = candidates
        .into_iter()
        .find(|candidate| candidate.session_id == room.session_id)?;
    Some(
        converge_stale_session(&pool, &candidate, 90)
            .await
            .expect("converge"),
    )
}

/// A pending permission request of the room's session, `lapsed` past its deadline or not.
async fn seed_permission_request(su: &PgPool, room: &Room, lapsed: bool) -> (Uuid, Uuid) {
    let event_id = Uuid::new_v4();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_permission_request \
           (workspace_id, work_session_id, host_id, channel_id, request_event_id, options, \
            expires_at) \
         VALUES ($1, $2, $3, $4, $5, \
                 '[{\"option_id\":\"allow-once\",\"kind\":\"allow_once\"}]'::jsonb, \
                 CASE WHEN $6 THEN clock_timestamp() - interval '1 second' \
                      ELSE clock_timestamp() + interval '10 minutes' END) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.session_id)
    .bind(room.host_id)
    .bind(room.channel_id)
    .bind(event_id)
    .bind(lapsed)
    .fetch_one(su)
    .await
    .expect("seed permission request");
    (id, event_id)
}

async fn request_status(su: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM work_permission_request WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("request status")
}

/// One stop notice: (id, body, root, author, props).
type Notice = (Uuid, String, Option<Uuid>, Uuid, Value);
/// The same row as it is read (the body may be NULL).
type NoticeRow = (Uuid, Option<String>, Option<Uuid>, Uuid, Value);

/// Every stop notice in the room, oldest first.
async fn notices(su: &PgPool, room: &Room) -> Vec<Notice> {
    let rows: Vec<NoticeRow> = sqlx::query_as(
        "SELECT id, body, root_id, author_member_id, props FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 \
            AND props->>'kind' = 'work_session_notice' \
          ORDER BY seq",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .fetch_all(su)
    .await
    .expect("read notices");
    rows.into_iter()
        .map(|(id, body, root, author, props)| (id, body.unwrap_or_default(), root, author, props))
        .collect()
}

/// Drain this workspace's candidates and return what was dispatched for `message`.
async fn dispatched_for(su: &PgPool, room: &Room, message: Uuid) -> Vec<PushDispatch> {
    focus_candidates(su, room.workspace_id).await;
    let relay = Arc::new(RecordingDispatcher {
        sent: Mutex::new(Vec::new()),
    });
    let pool = momo_notifier_pool().await;
    PushDrain::new(pool, PushConfig::for_target(), relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent.lock().unwrap().clone();
    sent.into_iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .collect()
}

/// Write one notice line as the server does, in a tenant transaction.
async fn post_notice(su: &PgPool, room: &Room, author: Uuid, notice: WorkNotice) -> Uuid {
    let site = NoticeSite {
        channel_id: room.channel_id,
        root_id: Some(room.root_id),
        author_member_id: author,
    };
    let workspace_id = room.workspace_id;
    with_tenant_tx(su, workspace_id, move |conn| {
        Box::pin(async move {
            post_work_notice_in_tx(conn, workspace_id, site, &notice)
                .await
                .map_err(|error| match error {
                    momo_t3::T3Error::Db(db) => db,
                    other => panic!("{other}"),
                })
        })
    })
    .await
    .expect("post notice");
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM message WHERE workspace_id = $1 AND channel_id = $2 \
          AND props->>'kind' = 'work_session_notice' ORDER BY seq DESC LIMIT 1",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .fetch_one(su)
    .await
    .expect("the notice");
    id
}

fn assert_owner_only(sent: &[PushDispatch], room: &Room, reason: &str) {
    assert_eq!(sent.len(), 1, "exactly the owner's one device: {sent:?}");
    let push = &sent[0];
    assert_eq!(push.device_id, room.owner_device.to_string(), "{sent:?}");
    assert_ne!(push.device_id, room.peer_device.to_string(), "{sent:?}");
    assert_eq!(push.reason, reason, "{push:?}");
    assert_eq!(
        push.category, "momo.work",
        "nothing to reply to or decide: {push:?}"
    );
    assert!(push.approval_id.is_none(), "{push:?}");
    assert_eq!(
        push.thread_id,
        room.root_id.to_string(),
        "a tap lands on the session's thread"
    );
    momo_push_relay::PushDispatch::decode_closed(&serde_json::to_vec(push).expect("render"))
        .expect("the relay accepts the dispatch as it is (no new vocabulary)");
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_lost_mac_writes_one_line_pushes_only_the_owner_and_its_request_does_not_speak_twice() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    // The agent was waiting on the owner when the Mac went quiet; the request is already past
    // its deadline by the time the expiry sweep runs.
    let (waiting, _) = seed_permission_request(&su, &room, true).await;
    mac_goes_quiet(&su, &room).await;

    let outcome = sweep_room(&room).await.expect("the session is a candidate");
    assert!(outcome.transitioned && outcome.noticed, "{outcome:?}");
    let status: String = sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(room.session_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(status, "orphaned");

    let lines = notices(&su, &room).await;
    assert_eq!(lines.len(), 1, "one line per transition: {lines:?}");
    let (line, body, root, author, props) = &lines[0];
    assert_eq!(body, BODY_HOST_LOST);
    assert_eq!(*root, Some(room.root_id), "in the session's thread");
    assert_eq!(*author, room.owner, "in the session's voice");
    assert_eq!(props["code"], "host_lost");
    assert_eq!(props["resumable"], true);
    assert_eq!(props["was_running"], true);
    assert_eq!(props["owner_member_id"], room.owner.to_string());
    assert_eq!(props["session_id"], room.session_id.to_string());
    assert_eq!(
        request_status(&su, waiting).await,
        "pending",
        "the tier sweep (the settlement path) does not touch work_permission_request"
    );
    // The room hears the line through the outbox (no direct publish).
    let broadcast: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(room.workspace_id)
    .bind(line.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(broadcast >= 1, "the line is broadcast through the outbox");

    let sent = dispatched_for(&su, &room, *line).await;
    assert_owner_only(&sent, &room, "resume_offer");

    // A second pass finds nothing to move and writes nothing.
    assert!(sweep_room(&room).await.is_none(), "no longer a candidate");
    assert_eq!(notices(&su, &room).await.len(), 1);

    // The expiry sweep closes the lost session's request at its deadline — and says nothing
    // more: one cause, one notice (ADR-0220 P5).
    expiry_sweep().await;
    assert_eq!(request_status(&su, waiting).await, "expired");
    assert_eq!(
        notices(&su, &room).await.len(),
        1,
        "no 「10분이 지나 닫혔어요」 on top of 「맥 연결이 끊겨…」"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_lost_mac_in_a_dm_never_reaches_the_dm_peer() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, true).await;
    mac_goes_quiet(&su, &room).await;
    let outcome = sweep_room(&room).await.expect("candidate");
    assert!(outcome.noticed);
    let lines = notices(&su, &room).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0].3, room.alias,
        "the persona speaks the session's lines"
    );
    let sent = dispatched_for(&su, &room, lines[0].0).await;
    assert_owner_only(&sent, &room, "resume_offer");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_lost_mac_under_a_finished_session_writes_the_line_but_pushes_nobody() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, false).await;
    sqlx::query("UPDATE work_session SET status = 'idle', idle_at = now() WHERE id = $1")
        .bind(room.session_id)
        .execute(&su)
        .await
        .expect("the turn had finished");
    mac_goes_quiet(&su, &room).await;
    let outcome = sweep_room(&room)
        .await
        .expect("an idle session is a candidate too");
    assert!(outcome.transitioned && outcome.noticed, "{outcome:?}");
    let lines = notices(&su, &room).await;
    assert_eq!(lines.len(), 1, "the thread still records it");
    assert_eq!(lines[0].4["was_running"], false);
    let sent = dispatched_for(&su, &room, lines[0].0).await;
    assert!(
        sent.is_empty(),
        "no turn was running: one cause, no interruption (ADR-0220 P5) — and no `dm` for the peer: {sent:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_policy_that_ends_the_session_is_a_failure_notice_not_a_resume_offer() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    sqlx::query(
        "INSERT INTO work_tier_policy (workspace_id, member_id, mode) VALUES ($1, $2, 't1_only')",
    )
    .bind(room.workspace_id)
    .bind(room.owner)
    .execute(&su)
    .await
    .expect("t1_only policy");
    mac_goes_quiet(&su, &room).await;
    let outcome = sweep_room(&room).await.expect("candidate");
    assert!(outcome.transitioned && outcome.noticed);
    let status: String = sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(room.session_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(status, "ended");
    let lines = notices(&su, &room).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].4["resumable"], false);
    let sent = dispatched_for(&su, &room, lines[0].0).await;
    assert_owner_only(&sent, &room, "mention");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_lapsed_permission_request_is_closed_once_with_one_line_and_an_owner_push() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let (lapsed, lapsed_event) = seed_permission_request(&su, &room, true).await;
    let (fresh, _) = seed_permission_request(&su, &room, false).await;
    // A second room whose session is no longer running: its lapsed request closes silently.
    let idle_room = seed_room(&su, Shape::PublicChannel, false).await;
    sqlx::query("UPDATE work_session SET status = 'idle', idle_at = now() WHERE id = $1")
        .bind(idle_room.session_id)
        .execute(&su)
        .await
        .expect("idle session");
    let (idle_lapsed, _) = seed_permission_request(&su, &idle_room, true).await;

    let stats = expiry_sweep().await;
    assert!(stats.expired >= 2 && stats.noticed >= 1, "{stats:?}");
    assert_eq!(request_status(&su, lapsed).await, "expired");
    assert_eq!(
        request_status(&su, fresh).await,
        "pending",
        "a request inside its deadline stays decidable"
    );
    assert_eq!(request_status(&su, idle_lapsed).await, "expired");
    assert!(
        notices(&su, &idle_room).await.is_empty(),
        "a session that is not running gets no expiry line (its own end already spoke)"
    );

    let lines = notices(&su, &room).await;
    assert_eq!(lines.len(), 1, "{lines:?}");
    let (line, body, root, author, props) = &lines[0];
    assert_eq!(body, BODY_PERMISSION_EXPIRED);
    assert_eq!(*root, Some(room.root_id));
    assert_eq!(*author, room.alias);
    assert_eq!(props["code"], "permission_expired");
    assert_eq!(props["request_event_id"], lapsed_event.to_string());
    let sent = dispatched_for(&su, &room, *line).await;
    assert_owner_only(&sent, &room, "mention");

    // Closed once: the next pass moves nothing and writes nothing.
    expiry_sweep().await;
    assert_eq!(notices(&su, &room).await.len(), 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_failure_line_reaches_the_owner_unless_reading_or_switched_off() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let failed = |room: &Room| WorkNotice::Failed {
        session_id: room.session_id,
        owner_member_id: room.owner,
        exit_code: 1,
    };

    // Away: pushed, owner only (a DM peer included in the room).
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let line = post_notice(&su, &room, room.author(true), failed(&room)).await;
    let sent = dispatched_for(&su, &room, line).await;
    assert_owner_only(&sent, &room, "mention");

    // Reading the channel right now: not pushed (ADR-0188 D8 「활동 중이 아닐 때만」).
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    sqlx::query(
        "INSERT INTO channel_viewing (workspace_id, channel_id, member_id, seen_at) \
         VALUES ($1, $2, $3, clock_timestamp())",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.owner)
    .execute(&su)
    .await
    .expect("viewing beat");
    let line = post_notice(&su, &room, room.owner, failed(&room)).await;
    assert!(dispatched_for(&su, &room, line).await.is_empty());

    // 「에이전트의 답」 switched off on the phone: not pushed, and nothing falls through.
    let room = seed_room(&su, Shape::GroupDm, false).await;
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, kinds) \
         VALUES ($1, $2, '{\"agentAnswer\":{\"phone\":false}}'::jsonb)",
    )
    .bind(room.workspace_id)
    .bind(room.owner)
    .execute(&su)
    .await
    .expect("switch off");
    let line = post_notice(&su, &room, room.owner, failed(&room)).await;
    assert!(dispatched_for(&su, &room, line).await.is_empty());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_refused_spawn_line_pushes_nobody_even_in_a_dm() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, false).await;
    let line = post_notice(
        &su,
        &room,
        room.owner,
        // A refused resume: the line names a real session of the owner, so only the code keeps
        // the owner from being pushed (the session re-check would otherwise mask it).
        WorkNotice::SpawnRefused {
            control_id: Uuid::new_v4(),
            owner_member_id: room.owner,
            session_id: Some(room.session_id),
            reason: SpawnRefusalReason::HostBusy,
        },
    )
    .await;
    let sent = dispatched_for(&su, &room, line).await;
    assert!(
        sent.is_empty(),
        "a refusal is a line, not a push — and never a `dm` for the peer: {sent:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_notice_naming_someone_elses_session_pushes_nobody() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    // The line names the peer as the owner of a session that is the owner's.
    let line = post_notice(
        &su,
        &room,
        room.owner,
        WorkNotice::Failed {
            session_id: room.session_id,
            owner_member_id: room.peer,
            exit_code: 1,
        },
    )
    .await;
    let sent = dispatched_for(&su, &room, line).await;
    assert!(sent.is_empty(), "{sent:?}");
}

// ---------------------------------------------------------------------------
// #5614 H1 — a stop line must never hold back the fact it reports
// ---------------------------------------------------------------------------

/// One more running session of the room's owner, on `host`, in `channel` (seeded as a superuser:
/// the card is written directly, as `seed_room` does). Returns `(session, root)`.
async fn add_session(
    su: &PgPool,
    room: &Room,
    channel: Uuid,
    host: Uuid,
    persona: Option<Uuid>,
    seq: i64,
) -> (Uuid, Uuid) {
    let root: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'system', '{\"kind\":\"work_session\"}'::jsonb) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(channel)
    .bind(seq)
    .bind(room.owner)
    .fetch_one(su)
    .await
    .expect("seed another session card");
    // The card took `seq` directly; keep the room's counter past it so the send spine's next
    // line does not collide on (channel_id, seq).
    sqlx::query("UPDATE channel_seq SET last_seq = GREATEST(last_seq, $2) WHERE channel_id = $1")
        .bind(channel)
        .bind(seq)
        .execute(su)
        .await
        .expect("move the room's counter past the card");
    let session: Uuid = sqlx::query_scalar(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, \
            persona_member_id) \
         VALUES ($1, $2, $3, $4, $5, 'claude', '또 다른 일', $6) RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(channel)
    .bind(room.owner)
    .bind(host)
    .bind(root)
    .bind(persona)
    .fetch_one(su)
    .await
    .expect("seed another session");
    (session, root)
}

/// A second Mac of the room's owner that answers (fresh heartbeat).
async fn add_live_host(su: &PgPool, room: &Room) -> Uuid {
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'workd', 'mac2', $4, '{}'::jsonb, \
                 clock_timestamp() + interval '1 day')",
    )
    .bind(host)
    .bind(room.workspace_id)
    .bind(room.owner)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed live host");
    host
}

/// A public room of the same workspace, owner and peer seated.
async fn add_public_room(su: &PgPool, room: &Room) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel)
        .bind(room.workspace_id)
        .bind(format!("room-{}", &channel.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed public room");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 10)")
        .bind(channel)
        .bind(room.workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in [room.owner, room.peer] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(room.workspace_id)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed membership");
    }
    channel
}

async fn seed_request_for(
    su: &PgPool,
    room: &Room,
    session: Uuid,
    host: Uuid,
    channel: Uuid,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO work_permission_request \
           (workspace_id, work_session_id, host_id, channel_id, request_event_id, options, \
            expires_at) \
         VALUES ($1, $2, $3, $4, gen_random_uuid(), \
                 '[{\"option_id\":\"allow-once\",\"kind\":\"allow_once\"}]'::jsonb, \
                 clock_timestamp() - interval '1 second') \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(session)
    .bind(host)
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("seed lapsed permission request")
}

async fn session_status(su: &PgPool, session: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("session status")
}

/// The stop lines of one session's thread: (author, code).
async fn lines_of(su: &PgPool, root: Uuid) -> Vec<(Uuid, String)> {
    sqlx::query_as(
        "SELECT author_member_id, props->>'code' FROM message \
          WHERE root_id = $1 AND props->>'kind' = 'work_session_notice' ORDER BY seq",
    )
    .bind(root)
    .fetch_all(su)
    .await
    .expect("read session lines")
}

/// The reviewer's reproduction (#5614 H1): the owner switched their personal agent off, and the
/// agent is the persona of sessions in a DM it was admitted to — the DM write boundary refuses every
/// INSERT it authors (42501, for every role). Before the fix the stop line's refusal rolled the whole
/// transition back, tick after tick: the session never became `orphaned`, and the expiry sweep held
/// every lapsed request of the workspace `pending`. Now the line speaks as the owner, and both facts
/// land.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_switched_off_persona_in_an_admitted_dm_holds_back_neither_sweep() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::AdmittedDm, true).await;
    let live = add_live_host(&su, &room).await;
    let public = add_public_room(&su, &room).await;
    let (dm_session, dm_root) =
        add_session(&su, &room, room.channel_id, live, Some(room.alias), 2).await;
    let (plain_session, plain_root) = add_session(&su, &room, public, live, None, 2).await;
    let dm_request = seed_request_for(&su, &room, dm_session, live, room.channel_id).await;
    let plain_request = seed_request_for(&su, &room, plain_session, live, public).await;
    sqlx::query("UPDATE member SET status = 'suspended', updated_at = now() WHERE id = $1")
        .bind(room.alias)
        .execute(&su)
        .await
        .expect("the owner switches the personal agent off");
    let can_speak: bool = sqlx::query_scalar("SELECT dm_agent_can_speak($1, $2, $3)")
        .bind(room.workspace_id)
        .bind(room.channel_id)
        .bind(room.alias)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(!can_speak, "the fixture must be the boundary's refusal");

    // The tier sweep: the persona session on the quiet Mac is orphaned and its owner told.
    mac_goes_quiet(&su, &room).await;
    let outcome = sweep_room(&room)
        .await
        .expect("the persona session is a candidate");
    assert!(outcome.transitioned, "{outcome:?}");
    assert!(
        outcome.noticed,
        "the line is written, in the owner's voice: {outcome:?}"
    );
    assert_eq!(session_status(&su, room.session_id).await, "orphaned");
    let lost = lines_of(&su, room.root_id).await;
    assert_eq!(
        lost,
        vec![(room.owner, "host_lost".to_string())],
        "{lost:?}"
    );
    let line: Uuid = sqlx::query_scalar(
        "SELECT id FROM message WHERE root_id = $1 AND props->>'kind' = 'work_session_notice'",
    )
    .bind(room.root_id)
    .fetch_one(&su)
    .await
    .unwrap();
    let sent = dispatched_for(&su, &room, line).await;
    assert_owner_only(&sent, &room, "resume_offer");

    // The expiry sweep: both lapsed requests of the workspace close, the DM one included.
    let stats = expiry_sweep().await;
    assert_eq!(stats.failed, 0, "{stats:?}");
    assert_eq!(request_status(&su, dm_request).await, "expired");
    assert_eq!(request_status(&su, plain_request).await, "expired");
    assert_eq!(
        lines_of(&su, dm_root).await,
        vec![(room.owner, "permission_expired".to_string())]
    );
    assert_eq!(
        lines_of(&su, plain_root).await,
        vec![(room.owner, "permission_expired".to_string())]
    );
}

/// The guard itself (#5614 H1): whatever refuses a stop line — here the room's `channel_seq` row is
/// gone, so the send spine cannot place it — the line is dropped alone and the fact still commits:
/// the session is orphaned, the request expired, and the other room of the workspace still gets its
/// line.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_line_that_cannot_be_written_never_holds_back_the_fact() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    let live = add_live_host(&su, &room).await;
    let healthy = add_public_room(&su, &room).await;
    let (broken_session, broken_root) =
        add_session(&su, &room, room.channel_id, live, None, 2).await;
    let (healthy_session, healthy_root) = add_session(&su, &room, healthy, live, None, 2).await;
    let broken_request = seed_request_for(&su, &room, broken_session, live, room.channel_id).await;
    let healthy_request = seed_request_for(&su, &room, healthy_session, live, healthy).await;
    sqlx::query("DELETE FROM channel_seq WHERE channel_id = $1")
        .bind(room.channel_id)
        .execute(&su)
        .await
        .expect("break the room's send spine");

    mac_goes_quiet(&su, &room).await;
    let outcome = sweep_room(&room).await.expect("candidate");
    assert!(outcome.transitioned, "the transition commits: {outcome:?}");
    assert!(
        !outcome.noticed,
        "the line that could not be written is dropped: {outcome:?}"
    );
    assert_eq!(session_status(&su, room.session_id).await, "orphaned");
    assert!(lines_of(&su, room.root_id).await.is_empty());

    let stats = expiry_sweep().await;
    assert_eq!(stats.failed, 0, "{stats:?}");
    assert_eq!(request_status(&su, broken_request).await, "expired");
    assert_eq!(request_status(&su, healthy_request).await, "expired");
    assert!(lines_of(&su, broken_root).await.is_empty());
    assert_eq!(
        lines_of(&su, healthy_root).await,
        vec![(room.owner, "permission_expired".to_string())]
    );
}

/// #5614 M2: the expiry sweep writes only through an RLS-bound pool — handed a role that bypasses
/// RLS (the notifier's own) as its write pool, it refuses to run and touches nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_expiry_sweep_refuses_a_write_pool_that_bypasses_rls() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    let (request, _) = seed_permission_request(&su, &room, true).await;
    let notifier = momo_notifier_pool().await;
    let refused = sweep_lapsed_work_permissions(&notifier, &notifier, 10_000).await;
    assert!(
        refused.is_err(),
        "a BYPASSRLS write pool is refused: {refused:?}"
    );
    assert_eq!(
        request_status(&su, request).await,
        "pending",
        "nothing was written"
    );
}
