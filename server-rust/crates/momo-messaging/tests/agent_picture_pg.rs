//! #5371 — the agent-worker's picture write against a real PG18 (ADR-0151 증보 8), the messaging half.
//!
//! `DATABASE_URL` is a disposable superuser URL; the harness applies every migration and
//! `bootstrap_roles.sql`, then
//!   * mints as `momo_worker` (the agent-worker's own BYPASSRLS role, inside a tenant tx — what the
//!     worker does right before it calls the api),
//!   * redeems the token and writes the attachment row as `momo_app` (`rolsuper=false`,
//!     `rolbypassrls=false`, inside a tenant tx bound to the path's workspace — what the api route does), and
//!   * sends the run's answer as `momo_worker` again (the worker's answer spine).
//!
//! The api route, the decoder child and the archive are the conformance test's half (`momo-server`);
//! everything here is the database contract the route stands on.
//!
//! Line numbers in the last column are at HEAD `1c931cbcb` (before the implementation-review round, which
//! added the agent-kind join and comments to `ap`: its lines below the binding have moved down, so find an
//! anchor by its text): `ap` = `src/agent_picture.rs`, `att` =
//! `src/attachment.rs`, `msg` = `src/message.rs`, `175` = `server/Migrations/175_attachment_write_token.sql`,
//! `173` = `server/Migrations/173_attachment_media.sql`. Where two lines guard the same fact, both are named:
//! deleting one of them alone leaves the test green (a belt and braces the tests cannot tell apart).
//!
//! | test | acceptance criterion | what turns it red |
//! |---|---|---|
//! | `a_healthy_run_gets_one_hash_only_row_…` | WA1, WA22, T1 | `ap:209` (the token stored instead of its hash), `ap:204` (the lifetime), `ap:197` (a second mint finds a free slot), `175:61` |
//! | `a_mint_writes_nothing_when_only_one_condition_is_wrong` | WA1, WA23 (mint) | `ap:120` (agent of the run; the run's workspace there only together with `att:270`), `ap:121` (run state), `ap:122` (`kind = 'human'`; its `status`/`deleted_at` only together with `att:267`/`att:268` of the requester call), `ap:132` (agent member), `ap:133` (requester member), `att:264` (`left_at`), `att:267` (agent `status`), `att:268` (agent `deleted_at`), `att:271` (`archived_at`), the binding's `a.kind = 'agent'` join (cell `AgentSeatIsHuman`: a run whose agent seat is a person) |
//! | `two_mints_for_the_same_slot_…` | WA1 | `ap:205` (`ON CONFLICT DO NOTHING`: the loser would error instead of getting `None`), `175:60` |
//! | `an_expired_unspent_slot_is_not_given_back_…` | W1 | `ap:190-199` (the slot search must not look at expiry or use), `175:62` (ttl check) |
//! | `eight_racing_connections_…`, `a_spent_token_…` | WA2, T14 | `ap:240` (`t.used_at IS NULL`; the racers then hit the guard trigger `175:77-88` and error) |
//! | `a_stale_or_forged_token_is_refused_by_the_spend_…` | WA2, WA3, WA24 | `ap:240` (`expires_at >`), `ap:241` (`slot <=`), `ap:244` (the run's agent), `ap:245` (run state: the token must not be burned); `ap:239`'s workspace condition is redundant with RLS `175:96-98` |
//! | `a_binding_that_stops_holding_refuses_after_the_spend_…` | WA2, WA3 | `ap:256-260` (the binding after the spend), `ap:122` (`kind = 'human'`: the agent-authored trigger), the binding's `a.kind = 'agent'` (the forged run that seats a person, and the cell `AgentSeatIsHuman`), the member and channel anchors of the mint row |
//! | `a_redeem_names_what_the_run_names_…` | WA3 | `ap:256-267` (the target comes from the token's own run), `175` column list (a requester or channel column) |
//! | `a_written_picture_is_…` | WA11, W9 | `ap:340-355` (the row's uploader, channel, status, `message_id`), `ap:373-395` (audit fields), `175:77-88` (record once) |
//! | `a_write_that_cannot_record_itself_…` | W9 L2 | `ap:356-372` (`used_at IS NOT NULL AND attachment_id IS NULL` at `ap:359`, `rows_affected() != 1` at `ap:368`) |
//! | `a_write_after_the_run_is_over_…` | WA10, WA23 (write) | `ap:318-323` (the third look) with the binding anchors of the mint row |
//! | `a_target_naming_another_…` | WA10, WA23 | `ap:324` (channel), `ap:120` (agent), `ap:368` (a run without a spent token) |
//! | `the_daily_ceiling_counts_…` | W12, WA24 | `ap:331` (`m.kind = 'agent'`, `a.status = 'complete'`; `a.workspace_id` there is redundant with RLS for `momo_app`), `ap:332` (24 hours), `ap:337` (`>=`) |
//! | `a_refusal_after_the_proof_…` | WA10, WA11 | `ap:402-428` (the closed fields) |
//! | `a_runs_picture_ids_…` | WA12, L2 | `ap:439` (`attachment_id IS NOT NULL`; the workspace and run scope), `ap:440` (`ORDER BY slot`) |
//! | `the_answer_binds_exactly_…`, `a_run_that_wrote_no_picture_…`, `a_retried_answer_…`, `three_recorded_pictures_…` | WA12 | `msg:1036` (ids only from the run's record), `msg:1033` (`!deduped`), `msg:1061` (`Skip` loses the file card; `Project` is refused to `momo_worker`), `att:577` |
//! | `a_refused_binding_leaves_nothing_…`, `a_human_cannot_…` | WA12, WA13, T7 | `att:599-607` (the four rejections), `msg:1049` (the refusal must be returned, not swallowed) |
//! | `the_worker_answers_without_the_media_table_…` | W9 | `msg:1061` (`ProjectWithoutMedia` → `Project`: SQLSTATE 42501 for the worker), `att:703-705` (complete, live message, oldest first), `173:109` (the lockdown that keeps the worker out), the lean projection's `a.workspace_id = $2 AND m.workspace_id = $2` (the other-tenant cell: the worker role skips RLS, so the statement is the guard; implementation review L-2) |
//! | `the_worker_role_cannot_bind_another_workspaces_attachment` | WA14, L1 | `att:577` (`AND workspace_id = $2`; the one at `att:609` is unreachable behind it) |
//! | `the_runtime_roles_hold_exactly_…` | WA18 | `175:127-129` and the same block in both bootstrap files |
//! | `the_guard_trigger_…` | WA18 | `175:77-88` |
//! | `the_checks_and_keys_…` | WA18 | `175:60` (UNIQUE), `175:61-65` (hash, slot, ttl, used, attachment checks), the primary key, the two foreign keys |
//! | `rls_…` | WA14, WA18 | `175:96-98` (ENABLE, FORCE, policy) |
//! | `a_parent_run_delete_…` | lockdown note | `175:52` (`ON DELETE CASCADE`) |
//! | `a_mint_clears_only_its_own_…` | WA21 | `ap:184` (`workspace_id = $1`; `expires_at < now() - 1 day`) |
//! | `mint_redeem_and_write_refuse_the_same_breakages` | WA23 | every anchor of the mint, binding and write rows, the binding's `a.kind = 'agent'` included (cell `AgentSeatIsHuman`, red in all three calls); the six run-state cells of `redeem` also stand on `ap:245`, so deleting `ap:121` alone leaves those six green |
//!
//! Run: `DATABASE_URL=… cargo test -p momo-messaging --test agent_picture_pg -- --ignored --test-threads=1`

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use momo_db::migrate::{run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    link_attachments_in_tx, message_attachments_in_tx, message_attachments_without_media_in_tx,
    mint_agent_picture_in_tx, mint_agent_picture_with_ttl_in_tx, picture_name,
    record_picture_refused_in_tx, redeem_agent_picture_in_tx, run_picture_ids_in_tx,
    send_thread_notice_in_tx, send_thread_notice_with_run_pictures_in_tx, token_hash,
    write_picture_in_tx, AgentPictureGrant, AgentPictureTarget, AttachmentLinkRejected,
    MessageAttachment, NewMessage, PictureWriteRefused, SentMessage, StoredPicture,
    AGENT_MEDIA_TTL_SECS, AGENT_PICTURES_DAILY_CEILING, AGENT_PICTURES_PER_RUN,
};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// --- harness (the same as `self_media_pg.rs`) ----------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set disposable PG18 DATABASE_URL")
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    let migrations = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../server/Migrations"
    ));
    run_migrations(&database_url(), &migrations, SeedMode::None).expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .arg(database_url())
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

struct Pools {
    su: PgPool,
    app: PgPool,
    worker: PgPool,
}

async fn pools() -> Pools {
    ensure_schema_and_roles();
    let url = database_url();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .expect("superuser pool");
    let as_role = |role: &str, password: String| {
        url.parse::<PgConnectOptions>()
            .expect("postgres URL")
            .username(role)
            .password(&password)
    };
    let app = PgPoolOptions::new()
        .max_connections(16)
        .connect_with(as_role(
            "momo_app",
            std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string()),
        ))
        .await
        .expect("momo_app pool");
    let worker = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(as_role(
            "momo_worker",
            std::env::var("MOMO_WORKER_PASSWORD")
                .unwrap_or_else(|_| "momo_worker_dev_pw".to_string()),
        ))
        .await
        .expect("momo_worker pool");
    Pools { su, app, worker }
}

/// A pool as one of the other runtime roles (the development passwords the bootstrap file sets), for the
/// privilege tests.
async fn pool_as(role: &str, password_env: &str, fallback: &str) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("postgres URL");
    let password = std::env::var(password_env).unwrap_or_else(|_| fallback.to_string());
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("{role} pool: {error}"))
}

// --- seeding -------------------------------------------------------------------------------------

/// One tenant at the moment a run is in flight: a workspace; the requester `alice` and a bystander `bob`
/// (humans); the run's agent; a public channel all three are in; alice's request in it and a `running`
/// run for that request.
#[derive(Clone, Copy)]
struct World {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    agent: Uuid,
    channel: Uuid,
    trigger: Uuid,
    run: Uuid,
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("workspace");
    ws
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
         VALUES($1,$2,$3::member_kind,'active',$4,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("member");
    id
}

/// A public channel with its sequence row and the given members in it.
async fn seed_channel(su: &PgPool, ws: Uuid, creator: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', $3, $4)",
    )
    .bind(channel)
    .bind(ws)
    .bind(format!("c-{}", channel.simple()))
    .bind(creator)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in members {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .expect("membership");
    }
    channel
}

async fn seed_message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("seq");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .expect("message");
    id
}

async fn seed_run(
    su: &PgPool,
    ws: Uuid,
    channel: Uuid,
    agent: Uuid,
    trigger: Option<Uuid>,
    status: &str,
) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, \
         status, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6::run_status, $7)",
    )
    .bind(run)
    .bind(ws)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(status)
    .bind(format!("agent-picture:{run}"))
    .execute(su)
    .await
    .expect("run");
    run
}

/// A `complete` image attachment row; `age` is a Postgres interval ("0 seconds", "25 hours") subtracted
/// from now for `created_at`. `message` binds it, `None` leaves it unbound.
async fn seed_attachment(
    su: &PgPool,
    ws: Uuid,
    channel: Uuid,
    uploader: Uuid,
    message: Option<Uuid>,
    status: &str,
    age: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
         drive_file_id, name, mime, size_bytes, status, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'seeded', 'image/png', 10, $7, clock_timestamp() - $8::interval)",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(uploader)
    .bind(message)
    .bind(format!("seed-drive-{id}"))
    .bind(status)
    .bind(age)
    .execute(su)
    .await
    .expect("attachment");
    id
}

async fn seed_world_with_status(su: &PgPool, status: &str) -> World {
    let ws = seed_workspace(su).await;
    let alice = seed_member(su, ws, "human").await;
    let bob = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    let channel = seed_channel(su, ws, alice, &[alice, bob, agent]).await;
    let trigger = seed_message(su, ws, channel, alice).await;
    let run = seed_run(su, ws, channel, agent, Some(trigger), status).await;
    World {
        ws,
        alice,
        bob,
        agent,
        channel,
        trigger,
        run,
    }
}

async fn seed_world(su: &PgPool) -> World {
    seed_world_with_status(su, "running").await
}

// --- the three calls, as the roles that make them ------------------------------------------------

async fn mint_for(pools: &Pools, ws: Uuid, run: Uuid, agent: Uuid) -> Option<AgentPictureGrant> {
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move { mint_agent_picture_in_tx(conn, ws, run, agent).await })
    })
    .await
    .expect("mint transaction")
}

async fn mint(pools: &Pools, w: &World) -> Option<AgentPictureGrant> {
    mint_for(pools, w.ws, w.run, w.agent).await
}

async fn redeem(pools: &Pools, ws: Uuid, token: &str) -> Option<AgentPictureTarget> {
    let token = token.to_string();
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move { redeem_agent_picture_in_tx(conn, ws, &token).await })
    })
    .await
    .expect("redeem transaction")
}

/// What the route would hand the row write for a PNG the decoder produced.
fn stored_png(target: &AgentPictureTarget) -> StoredPicture {
    StoredPicture {
        drive_file_id: format!("agent-picture-{}", Uuid::new_v4()),
        name: picture_name(target.slot, "image/png"),
        mime: "image/png".to_string(),
        size_bytes: 4096,
        mime_in: "image/png",
        bytes_in: 5000,
        decode_ms: 9,
        backend: "local",
    }
}

async fn write(
    pools: &Pools,
    ws: Uuid,
    target: AgentPictureTarget,
    picture: StoredPicture,
    ceiling: i64,
) -> Result<Result<Uuid, PictureWriteRefused>, DbError> {
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move { write_picture_in_tx(conn, ws, &target, &picture, ceiling).await })
    })
    .await
}

/// The whole happy flow for a run: mint (worker), redeem (api), write the row (api). Returns the new
/// attachment's id.
async fn picture_of(pools: &Pools, ws: Uuid, run: Uuid, agent: Uuid) -> Uuid {
    let grant = mint_for(pools, ws, run, agent).await.expect("a token");
    let target = redeem(pools, ws, &grant.token).await.expect("a target");
    write(
        pools,
        ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("write transaction")
    .expect("the picture is written")
}

/// A token string that passes the shape check, for rows the test writes itself.
fn forged_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), "A".repeat(11))
}

/// What a compromised worker could do with its INSERT privilege: a row of its own making.
async fn forge_as_worker(pools: &Pools, ws: Uuid, token: &str, run: Uuid, agent: Uuid, slot: i16) {
    let hash = token_hash(token).to_vec();
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment_write_token \
                   (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
                 VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + interval '60 seconds')",
            )
            .bind(ws)
            .bind(hash)
            .bind(run)
            .bind(agent)
            .bind(slot)
            .execute(&mut *conn)
            .await?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .expect("momo_worker may write a token row of its own making");
}

/// A row that is already spent and has recorded `attachment` (what the api leaves behind after a
/// write), written directly so that a test can have several slots without widening the code constant.
async fn forge_recorded(
    su: &PgPool,
    ws: Uuid,
    run: Uuid,
    agent: Uuid,
    slot: i16,
    attachment: Option<Uuid>,
) {
    sqlx::query(
        "INSERT INTO attachment_write_token \
           (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at, used_at, \
            attachment_id) \
         VALUES ($1, $2, $3, $4, $5, clock_timestamp() - interval '2 minutes', \
                 clock_timestamp() - interval '1 minute', clock_timestamp() - interval '90 seconds', $6)",
    )
    .bind(ws)
    .bind(token_hash(&forged_token()).to_vec())
    .bind(run)
    .bind(agent)
    .bind(slot)
    .bind(attachment)
    .execute(su)
    .await
    .expect("recorded token row");
}

// --- counters and reads (superuser: they see everything) -----------------------------------------

async fn count(su: &PgPool, sql: &str, ws: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(ws)
        .fetch_one(su)
        .await
        .expect("count")
}

async fn token_rows(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1",
        ws,
    )
    .await
}

async fn attachment_rows(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM attachment WHERE workspace_id = $1",
        ws,
    )
    .await
}

async fn mark_rows(su: &PgPool, ws: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM agent_picture_mark WHERE workspace_id = $1",
        ws,
    )
    .await
}

/// A mark row `age` old (a Postgres interval: "1 hour", "49 hours"), written directly — what the api's
/// write transaction leaves behind, at the age a test needs. Returns its attachment id.
async fn seed_mark(su: &PgPool, ws: Uuid, age: &str) -> Uuid {
    let attachment = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_picture_mark (workspace_id, attachment_id, run_id, agent_member_id, written_at) \
         VALUES ($1, $2, $3, $4, clock_timestamp() - $5::interval)",
    )
    .bind(ws)
    .bind(attachment)
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(age)
    .execute(su)
    .await
    .expect("mark row");
    attachment
}

async fn audit_rows(su: &PgPool, ws: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(ws)
        .bind(action)
        .fetch_one(su)
        .await
        .expect("audit count")
}

/// `used_at` of the row holding this token (`None` when the token is not spent).
async fn used_at(su: &PgPool, ws: Uuid, token: &str) -> Option<DateTime<Utc>> {
    sqlx::query_scalar(
        "SELECT used_at FROM attachment_write_token WHERE workspace_id = $1 AND token_hash = $2",
    )
    .bind(ws)
    .bind(token_hash(token).to_vec())
    .fetch_one(su)
    .await
    .expect("the token row exists")
}

async fn recorded_attachment(su: &PgPool, ws: Uuid, run: Uuid) -> Option<Uuid> {
    sqlx::query_scalar(
        "SELECT attachment_id FROM attachment_write_token WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(ws)
    .bind(run)
    .fetch_one(su)
    .await
    .expect("the token row exists")
}

// --- breaking one condition ----------------------------------------------------------------------

/// One thing that can stop being true between the calls. Every variant breaks exactly one condition of
/// the one binding function (a run state, a membership, a person, the channel).
#[derive(Debug, Clone, Copy)]
enum Break {
    RunSucceeded,
    RunFailed,
    RunCancelled,
    RunTimedOut,
    RunAwaitingApproval,
    RunPaused,
    RequesterLeft,
    AgentLeft,
    RequesterSuspended,
    RequesterDeleted,
    /// `deleted_at` set while `status` stays `active`: isolates the soft-delete stamp from the status.
    RequesterDeletedAt,
    AgentSuspended,
    /// Same for the agent: only `deleted_at`, `status` stays `active`.
    AgentDeletedAt,
    ChannelArchived,
    /// The run's agent seat is held by a PERSON, who is still an active member of the channel: the agent's
    /// `member.kind` flips to `human`. Everything else about the run holds, so only the binding's
    /// `a.kind = 'agent'` can refuse it (implementation review M-1: `agent_run.agent_member_id` only
    /// references `member`, so a run row can seat a person there and the picture would be uploaded by that
    /// person and escape the agent-written count).
    AgentSeatIsHuman,
}

const BREAKS: [Break; 15] = [
    Break::RunSucceeded,
    Break::RunFailed,
    Break::RunCancelled,
    Break::RunTimedOut,
    Break::RunAwaitingApproval,
    Break::RunPaused,
    Break::RequesterLeft,
    Break::AgentLeft,
    Break::RequesterSuspended,
    Break::RequesterDeleted,
    Break::RequesterDeletedAt,
    Break::AgentSuspended,
    Break::AgentDeletedAt,
    Break::ChannelArchived,
    Break::AgentSeatIsHuman,
];

impl Break {
    /// The run is no longer `queued`/`running`: the spend's own `EXISTS` refuses it, so the token is NOT
    /// burned. Every other break passes the spend and is refused by the binding afterwards (the token is
    /// burned, as `redeem_in_tx` documents).
    fn is_run_state(self) -> bool {
        matches!(
            self,
            Break::RunSucceeded
                | Break::RunFailed
                | Break::RunCancelled
                | Break::RunTimedOut
                | Break::RunAwaitingApproval
                | Break::RunPaused
        )
    }
}

async fn set_run_status(su: &PgPool, run: Uuid, status: &str) {
    sqlx::query("UPDATE agent_run SET status = $2::run_status WHERE id = $1")
        .bind(run)
        .bind(status)
        .execute(su)
        .await
        .expect("run status");
}

async fn leave(su: &PgPool, channel: Uuid, member: Uuid) {
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("leave");
}

async fn set_member_state(su: &PgPool, member: Uuid, status: &str, deleted: bool) {
    sqlx::query(
        "UPDATE member SET status = $2::member_status, \
                deleted_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1",
    )
    .bind(member)
    .bind(status)
    .bind(deleted)
    .execute(su)
    .await
    .expect("member state");
}

async fn apply(su: &PgPool, w: &World, fault: Break) {
    match fault {
        Break::RunSucceeded => set_run_status(su, w.run, "succeeded").await,
        Break::RunFailed => set_run_status(su, w.run, "failed").await,
        Break::RunCancelled => set_run_status(su, w.run, "cancelled").await,
        Break::RunTimedOut => set_run_status(su, w.run, "timed_out").await,
        Break::RunAwaitingApproval => set_run_status(su, w.run, "awaiting_approval").await,
        Break::RunPaused => set_run_status(su, w.run, "paused").await,
        Break::RequesterLeft => leave(su, w.channel, w.alice).await,
        Break::AgentLeft => leave(su, w.channel, w.agent).await,
        Break::RequesterSuspended => set_member_state(su, w.alice, "suspended", false).await,
        Break::RequesterDeleted => set_member_state(su, w.alice, "deleted", true).await,
        Break::RequesterDeletedAt => set_member_state(su, w.alice, "active", true).await,
        Break::AgentSuspended => set_member_state(su, w.agent, "suspended", false).await,
        Break::AgentDeletedAt => set_member_state(su, w.agent, "active", true).await,
        Break::ChannelArchived => {
            sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
                .bind(w.channel)
                .execute(su)
                .await
                .expect("archive");
        }
        Break::AgentSeatIsHuman => {
            sqlx::query("UPDATE member SET kind = 'human'::member_kind WHERE id = $1")
                .bind(w.agent)
                .execute(su)
                .await
                .expect("seat a person as the run's agent");
        }
    }
}

// =================================================================================================
// A. mint
// =================================================================================================

/// A healthy run mints exactly one row: the SHA-256 of the token and nothing else, slot 1, sixty seconds
/// to live, unspent and unrecorded. The token text is in no column of any row of the table, and a second
/// mint for the same run gets nothing (`AGENT_PICTURES_PER_RUN` is 1).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_healthy_run_gets_one_hash_only_row_that_lives_sixty_seconds_and_a_second_mint_gets_nothing(
) {
    let pools = pools().await;
    let su = &pools.su;
    assert_eq!(AGENT_PICTURES_PER_RUN, 1, "v1 writes one picture per run");
    assert_eq!(AGENT_MEDIA_TTL_SECS, 60, "the constant says sixty seconds");
    let w = seed_world(su).await;

    let grant = mint(&pools, &w).await.expect("a healthy run mints");
    assert_eq!(grant.slot, 1);
    assert_eq!(grant.token.len(), 43);

    assert_eq!(token_rows(su, w.ws).await, 1, "exactly one row");
    #[allow(clippy::type_complexity)]
    let row: (
        Vec<u8>,
        i64,
        Uuid,
        Uuid,
        i16,
        f64,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        Option<Uuid>,
    ) = sqlx::query_as(
        "SELECT token_hash, octet_length(token_hash)::int8, run_id, agent_member_id, slot, \
                EXTRACT(EPOCH FROM (expires_at - created_at))::float8, expires_at, used_at, \
                attachment_id \
           FROM attachment_write_token WHERE workspace_id = $1",
    )
    .bind(w.ws)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(
        row.0,
        token_hash(&grant.token).to_vec(),
        "the SHA-256 of the token text"
    );
    assert_eq!(row.1, 32, "a 32-byte hash");
    assert_eq!((row.2, row.3, row.4), (w.run, w.agent, 1));
    assert_eq!(
        row.5.round() as i64,
        60,
        "the address lives 60 seconds, measured on the row (WA22)"
    );
    assert_eq!(row.6, grant.expires_at, "the grant says what the row says");
    assert!(row.7.is_none(), "unspent");
    assert!(row.8.is_none(), "nothing recorded yet");

    // the token text is in no column of ANY row of the table
    let everything: Vec<String> =
        sqlx::query_scalar("SELECT to_jsonb(t)::text FROM attachment_write_token t")
            .fetch_all(su)
            .await
            .unwrap();
    assert!(!everything.is_empty());
    assert!(
        everything.iter().all(|text| !text.contains(&grant.token)),
        "the token must not be stored anywhere in the table: {everything:?}"
    );

    // a second mint for the same run: nothing, and no second row
    assert!(
        mint(&pools, &w).await.is_none(),
        "one picture per run: the slot is taken"
    );
    assert!(mint(&pools, &w).await.is_none());
    assert_eq!(token_rows(su, w.ws).await, 1, "still exactly one row");
}

/// Mint for `(run, agent)` and say whether it refused AND left the workspace's table empty.
async fn mint_wrote_nothing(pools: &Pools, ws: Uuid, run: Uuid, agent: Uuid) -> bool {
    let grant = mint_for(pools, ws, run, agent).await;
    grant.is_none() && token_rows(&pools.su, ws).await == 0
}

/// WA1: each of these is the ONLY thing wrong with an otherwise healthy run, and each is `None` with
/// zero rows. A queued run is healthy (the positive controls keep the refusals from being a dead path).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_mint_writes_nothing_when_only_one_condition_is_wrong() {
    let pools = pools().await;
    let su = &pools.su;
    let mut wrong: Vec<String> = Vec::new();

    // positive controls: queued and running both mint
    for status in ["running", "queued"] {
        let w = seed_world_with_status(su, status).await;
        if mint(&pools, &w).await.is_none() || token_rows(su, w.ws).await != 1 {
            wrong.push(format!("a {status} run must mint exactly one row"));
        }
    }

    // run missing
    let w = seed_world(su).await;
    if !mint_wrote_nothing(&pools, w.ws, Uuid::new_v4(), w.agent).await {
        wrong.push("a run that does not exist".into());
    }

    // every break of the one binding: ended / awaiting approval / paused, either person gone, the
    // channel archived
    for fault in BREAKS {
        let w = seed_world(su).await;
        apply(su, &w, fault).await;
        if !mint_wrote_nothing(&pools, w.ws, w.run, w.agent).await {
            wrong.push(format!("{fault:?}"));
        }
    }

    // the agent asked for is not the run's agent (it IS a member of the channel)
    let w = seed_world(su).await;
    let other_agent = seed_member(su, w.ws, "agent").await;
    sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
        .bind(w.ws)
        .bind(w.channel)
        .bind(other_agent)
        .execute(su)
        .await
        .unwrap();
    if !mint_wrote_nothing(&pools, w.ws, w.run, other_agent).await {
        wrong.push("an agent that is not the run's agent".into());
    }

    // the trigger's author is an agent, not a person
    let w = seed_world(su).await;
    let agent_message = seed_message(su, w.ws, w.channel, w.agent).await;
    let run = seed_run(su, w.ws, w.channel, w.agent, Some(agent_message), "running").await;
    if !mint_wrote_nothing(&pools, w.ws, run, w.agent).await {
        wrong.push("a trigger written by an agent".into());
    }

    // the run has no trigger message at all
    let w = seed_world(su).await;
    let run = seed_run(su, w.ws, w.channel, w.agent, None, "running").await;
    if !mint_wrote_nothing(&pools, w.ws, run, w.agent).await {
        wrong.push("a run with no trigger message".into());
    }

    // a run of ANOTHER workspace, asked for under this workspace's binding (the worker is BYPASSRLS, so
    // only the query's own workspace condition stops it)
    let here = seed_world(su).await;
    let there = seed_world(su).await;
    let asked = mint_for(&pools, here.ws, there.run, there.agent).await;
    if asked.is_some() || token_rows(su, here.ws).await != 0 || token_rows(su, there.ws).await != 0
    {
        wrong.push("a run of another workspace".into());
    }
    // and the other way round: this workspace's run named with the other workspace's id
    let asked = mint_for(&pools, there.ws, here.run, here.agent).await;
    if asked.is_some() || token_rows(su, here.ws).await != 0 || token_rows(su, there.ws).await != 0
    {
        wrong.push("a run named under another workspace's id".into());
    }

    assert!(
        wrong.is_empty(),
        "these must mint nothing, and did not: {wrong:?}"
    );
}

/// The exact moment two mints race for the same slot: the second one has already looked (the slot was
/// free in its snapshot) and its INSERT waits for the first to commit. It must come back `None` (the
/// `ON CONFLICT DO NOTHING`), not as a unique violation, and the table keeps one row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn two_mints_for_the_same_slot_leave_one_row_and_the_loser_gets_none_not_an_error() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let (ws, run, agent) = (w.ws, w.run, w.agent);

    let mut first = pools.worker.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *first)
        .await
        .unwrap();
    let won = mint_agent_picture_in_tx(&mut first, ws, run, agent)
        .await
        .unwrap();
    assert!(won.is_some(), "the first mint takes the slot (uncommitted)");

    let mut second = pools.worker.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *second)
        .await
        .unwrap();
    let racing = tokio::spawn(async move {
        let outcome = mint_agent_picture_in_tx(&mut second, ws, run, agent).await;
        second.commit().await.unwrap();
        outcome
    });

    // wait until the second INSERT is really blocked behind the first one's uncommitted row
    let mut blocked = false;
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
              WHERE datname = current_database() AND wait_event_type = 'Lock' \
                AND query LIKE 'INSERT INTO attachment_write_token%'",
        )
        .fetch_one(su)
        .await
        .unwrap();
        if waiting > 0 {
            blocked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        blocked,
        "the second mint never reached the conflicting INSERT"
    );
    first.commit().await.unwrap();

    let lost = tokio::time::timeout(Duration::from_secs(30), racing)
        .await
        .expect("the racing mint hung after the first one committed")
        .expect("the racing mint finished")
        .expect("losing the slot is None, not a unique violation");
    assert!(lost.is_none(), "the loser writes nothing");
    assert_eq!(token_rows(su, ws).await, 1, "one row for the one slot");
}

/// W1: a slot that was minted and never spent is not given back when it expires — one try — and the table
/// itself bounds the lifetime (ten minutes, positive).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn an_expired_unspent_slot_is_not_given_back_and_the_table_bounds_the_lifetime() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let (ws, run, agent) = (w.ws, w.run, w.agent);

    let short = with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move { mint_agent_picture_with_ttl_in_tx(conn, ws, run, agent, 1).await })
    })
    .await
    .expect("mint transaction")
    .expect("a one-second token");
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert!(
        redeem(&pools, ws, &short.token).await.is_none(),
        "expired, and not spent"
    );
    assert!(
        mint(&pools, &w).await.is_none(),
        "an expired, unspent slot is not given back: one try"
    );
    assert_eq!(token_rows(su, ws).await, 1);

    // the ceiling and the floor of the lifetime are the table's, not the caller's
    for (ttl, ok) in [(600_i64, true), (601, false), (0, false), (-5, false)] {
        let w = seed_world(su).await;
        let (ws, run, agent) = (w.ws, w.run, w.agent);
        let outcome = with_tenant_tx(&pools.worker, ws, move |conn| {
            Box::pin(
                async move { mint_agent_picture_with_ttl_in_tx(conn, ws, run, agent, ttl).await },
            )
        })
        .await;
        match (ok, outcome) {
            (true, Ok(Some(_))) => {}
            (false, Err(_)) => assert_eq!(token_rows(su, ws).await, 0, "ttl {ttl}: nothing stored"),
            (expected, other) => panic!("ttl {ttl}: expected ok={expected}, got {other:?}"),
        }
    }
}

// =================================================================================================
// B. redeem
// =================================================================================================

/// WA2: one token, eight connections, one transaction each, all started before any of them spends:
/// exactly one wins, seven get `None`, none errors.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn eight_racing_connections_spend_a_token_exactly_once() {
    let pools = pools().await;
    let w = seed_world(&pools.su).await;
    let grant = mint(&pools, &w).await.expect("a token");
    let barrier = Arc::new(tokio::sync::Barrier::new(8));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (app, ws, token, barrier) = (
            pools.app.clone(),
            w.ws,
            grant.token.clone(),
            Arc::clone(&barrier),
        );
        tasks.push(tokio::spawn(async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    // every transaction is open before any of them spends
                    barrier.wait().await;
                    redeem_agent_picture_in_tx(conn, ws, &token).await
                })
            })
            .await
        }));
    }
    let mut winners: Vec<AgentPictureTarget> = Vec::new();
    let (mut losers, mut errors) = (0, Vec::new());
    for task in tasks {
        let joined = tokio::time::timeout(Duration::from_secs(60), task)
            .await
            .expect("a racer hung (a transaction that never reached the barrier?)");
        match joined.expect("task") {
            Ok(Some(target)) => winners.push(target),
            Ok(None) => losers += 1,
            Err(error) => errors.push(error.to_string()),
        }
    }
    assert!(errors.is_empty(), "no racer may error: {errors:?}");
    assert_eq!(winners.len(), 1, "exactly one connection wins the token");
    assert_eq!(losers, 7, "the other seven get None");
    assert_eq!(
        winners[0],
        AgentPictureTarget {
            run_id: w.run,
            agent_member_id: w.agent,
            requester_member_id: w.alice,
            channel_id: w.channel,
            slot: 1,
        }
    );
    assert!(used_at(&pools.su, w.ws, &grant.token).await.is_some());
}

/// A spent token cannot be spent again, in a later transaction on any connection either, and the second
/// look changes nothing on the row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_spent_token_is_refused_in_every_later_transaction_and_the_row_keeps_its_first_spend() {
    let pools = pools().await;
    let w = seed_world(&pools.su).await;
    let grant = mint(&pools, &w).await.expect("a token");

    assert!(redeem(&pools, w.ws, &grant.token).await.is_some());
    let spent = used_at(&pools.su, w.ws, &grant.token).await.expect("spent");
    for _ in 0..3 {
        assert!(
            redeem(&pools, w.ws, &grant.token).await.is_none(),
            "spent once, refused after"
        );
    }
    assert_eq!(
        used_at(&pools.su, w.ws, &grant.token).await,
        Some(spent),
        "the first spend is the only one"
    );
}

/// The refusals the spend statement itself makes: nothing is spent, the token stays usable for whoever
/// may still use it. (WA2, WA3, WA24)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_stale_or_forged_token_is_refused_by_the_spend_and_stays_unspent() {
    let pools = pools().await;
    let su = &pools.su;

    // expired: created five minutes ago, died four minutes ago (the table's lifetime check allows it)
    let w = seed_world(su).await;
    let expired = forged_token();
    sqlx::query(
        "INSERT INTO attachment_write_token \
           (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, 1, clock_timestamp() - interval '5 minutes', \
                 clock_timestamp() - interval '4 minutes')",
    )
    .bind(w.ws)
    .bind(token_hash(&expired).to_vec())
    .bind(w.run)
    .bind(w.agent)
    .execute(su)
    .await
    .unwrap();
    assert!(redeem(&pools, w.ws, &expired).await.is_none(), "expired");
    assert!(used_at(su, w.ws, &expired).await.is_none());

    // another workspace's path: refused there, unspent, and its own workspace still spends it
    let one = seed_world(su).await;
    let two = seed_world(su).await;
    let grant = mint(&pools, &one).await.expect("a token");
    assert!(
        redeem(&pools, two.ws, &grant.token).await.is_none(),
        "presented under another workspace"
    );
    assert!(used_at(su, one.ws, &grant.token).await.is_none());
    assert_eq!(token_rows(su, two.ws).await, 0, "nothing appeared there");
    assert!(
        redeem(&pools, one.ws, &grant.token).await.is_some(),
        "its own workspace still redeems it"
    );

    // the run is not in flight any more: the spend refuses it, so the token is NOT burned
    for status in [
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "awaiting_approval",
        "paused",
    ] {
        let w = seed_world(su).await;
        let grant = mint(&pools, &w).await.expect("a token");
        set_run_status(su, w.run, status).await;
        assert!(
            redeem(&pools, w.ws, &grant.token).await.is_none(),
            "run {status}"
        );
        assert!(
            used_at(su, w.ws, &grant.token).await.is_none(),
            "run {status}: the spend's own run check refuses it before it is spent"
        );
    }

    // a forged row by the worker role with a slot above the v1 limit (the table allows up to 4)
    assert_eq!(AGENT_PICTURES_PER_RUN, 1);
    for slot in [2_i16, 4] {
        let w = seed_world(su).await;
        let forged = forged_token();
        forge_as_worker(&pools, w.ws, &forged, w.run, w.agent, slot).await;
        assert!(
            redeem(&pools, w.ws, &forged).await.is_none(),
            "a forged slot {slot} is above the limit"
        );
        assert!(
            used_at(su, w.ws, &forged).await.is_none(),
            "slot {slot}: refused by the spend"
        );
    }
    // ... and the same forged row at slot 1 is a perfectly good token: the slot was the only fault
    let w = seed_world(su).await;
    let forged = forged_token();
    forge_as_worker(&pools, w.ws, &forged, w.run, w.agent, 1).await;
    assert!(redeem(&pools, w.ws, &forged).await.is_some());

    // a forged row naming an agent other than the run's: a stranger's id, a real agent that IS a member
    // of the channel, and a person of the channel (each on a fresh tenant: one row per run and slot)
    for variant in [
        "a stranger's id",
        "another agent of the channel",
        "a person",
    ] {
        let w = seed_world(su).await;
        let named = match variant {
            "a stranger's id" => Uuid::new_v4(),
            "another agent of the channel" => {
                let other_agent = seed_member(su, w.ws, "agent").await;
                sqlx::query(
                    "INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)",
                )
                .bind(w.ws)
                .bind(w.channel)
                .bind(other_agent)
                .execute(su)
                .await
                .unwrap();
                other_agent
            }
            _ => w.bob,
        };
        let forged = forged_token();
        forge_as_worker(&pools, w.ws, &forged, w.run, named, 1).await;
        assert!(
            redeem(&pools, w.ws, &forged).await.is_none(),
            "a row naming {variant} is not this run's agent"
        );
        assert!(
            used_at(su, w.ws, &forged).await.is_none(),
            "naming {variant}: refused by the spend, not burned"
        );
    }

    // strings that are not tokens never reach the table, and an unknown token is just None
    let w = seed_world(su).await;
    let real = mint(&pools, &w).await.expect("a token");
    for bad in [
        "",
        "x",
        &"N".repeat(42),
        &"N".repeat(44),
        "../../etc/passwd",
        &"%".repeat(43),
        &"N".repeat(43),
    ] {
        assert!(redeem(&pools, w.ws, bad).await.is_none(), "{bad:?}");
    }
    assert!(
        used_at(su, w.ws, &real.token).await.is_none(),
        "nothing was spent by the bad strings"
    );
}

/// The refusals the binding makes AFTER the spend: the run is in flight and the token was good, but
/// somebody left, was suspended or deleted, or the channel was archived — or the trigger was an agent's.
/// `redeem_in_tx` documents that the spend commits anyway (the token is gone either way).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_binding_that_stops_holding_refuses_after_the_spend_and_the_token_is_gone() {
    let pools = pools().await;
    let su = &pools.su;
    for fault in BREAKS.into_iter().filter(|fault| !fault.is_run_state()) {
        let w = seed_world(su).await;
        let grant = mint(&pools, &w).await.expect("a token");
        apply(su, &w, fault).await;
        assert!(
            redeem(&pools, w.ws, &grant.token).await.is_none(),
            "{fault:?}"
        );
        assert!(
            used_at(su, w.ws, &grant.token).await.is_some(),
            "{fault:?}: the spend committed before the binding refused"
        );
    }

    // a forged row for a run whose trigger was written by an agent: the run is in flight and the
    // agent matches, so only the binding's "the requester is a person" can refuse it
    let w = seed_world(su).await;
    let agent_message = seed_message(su, w.ws, w.channel, w.agent).await;
    let run = seed_run(su, w.ws, w.channel, w.agent, Some(agent_message), "running").await;
    let forged = forged_token();
    forge_as_worker(&pools, w.ws, &forged, run, w.agent, 1).await;
    assert!(
        redeem(&pools, w.ws, &forged).await.is_none(),
        "an agent is not a requester"
    );
    assert!(used_at(su, w.ws, &forged).await.is_some());

    // a forged run that seats a PERSON as its agent (bob is an active member of the channel, the trigger is
    // alice's, the run is in flight and the row names it): only the binding's `a.kind = 'agent'` can
    // refuse it, and without that the picture would be uploaded by bob and never counted
    let w = seed_world(su).await;
    let run = seed_run(su, w.ws, w.channel, w.bob, Some(w.trigger), "running").await;
    let forged = forged_token();
    forge_as_worker(&pools, w.ws, &forged, run, w.bob, 1).await;
    assert!(
        redeem(&pools, w.ws, &forged).await.is_none(),
        "a person is not the run's agent"
    );
    assert!(used_at(su, w.ws, &forged).await.is_some());
    assert_eq!(
        attachment_rows(su, w.ws).await,
        0,
        "nothing was written for the person"
    );
    assert!(
        mint_for(&pools, w.ws, run, w.bob).await.is_none(),
        "and the worker cannot mint for a run whose agent seat is a person either"
    );
    assert_eq!(
        token_rows(su, w.ws).await,
        1,
        "only the forged row is in the table: the refused mint added none"
    );
}

/// WA3: the requester, the channel and the agent come from the RUN. The agent sits in two conversations
/// with two different requesters; each run's token names its own. The table has no column that could
/// carry a requester or a channel, so there is nothing for a forged row to say.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_redeem_names_what_the_run_names_and_the_table_has_no_column_for_a_requester_or_channel()
{
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    // the second conversation: the same agent, another person, another channel
    let carol = seed_member(su, w.ws, "human").await;
    let other_channel = seed_channel(su, w.ws, carol, &[carol, w.agent, w.alice]).await;
    let other_trigger = seed_message(su, w.ws, other_channel, carol).await;
    let other_run = seed_run(
        su,
        w.ws,
        other_channel,
        w.agent,
        Some(other_trigger),
        "running",
    )
    .await;

    let first = mint(&pools, &w).await.expect("first token");
    let second = mint_for(&pools, w.ws, other_run, w.agent)
        .await
        .expect("second token");
    assert_eq!(
        redeem(&pools, w.ws, &first.token).await,
        Some(AgentPictureTarget {
            run_id: w.run,
            agent_member_id: w.agent,
            requester_member_id: w.alice,
            channel_id: w.channel,
            slot: 1,
        }),
        "the first run's requester and channel, though the agent is in both"
    );
    assert_eq!(
        redeem(&pools, w.ws, &second.token).await,
        Some(AgentPictureTarget {
            run_id: other_run,
            agent_member_id: w.agent,
            requester_member_id: carol,
            channel_id: other_channel,
            slot: 1,
        }),
        "the second run's requester and channel"
    );

    // a row the worker wrote by hand derives just the same: it can only name the run and the agent
    let third_run = seed_run(su, w.ws, w.channel, w.agent, Some(w.trigger), "running").await;
    let forged = forged_token();
    forge_as_worker(&pools, w.ws, &forged, third_run, w.agent, 1).await;
    let target = redeem(&pools, w.ws, &forged).await.expect("a target");
    assert_eq!(
        (target.requester_member_id, target.channel_id),
        (w.alice, w.channel),
        "derived from the run's trigger and channel"
    );

    // the whole column set: nothing in it can say who asked or where
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns \
          WHERE table_schema = 'public' AND table_name = 'attachment_write_token' \
          ORDER BY ordinal_position",
    )
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(
        columns,
        [
            "workspace_id",
            "token_hash",
            "run_id",
            "agent_member_id",
            "slot",
            "created_at",
            "expires_at",
            "used_at",
            "attachment_id",
        ],
        "a new column that could carry a requester, a channel or an uploader must be a decision, not an accident"
    );
}

// =================================================================================================
// C. the row write
// =================================================================================================

/// One audit row as the tests read it: (actor, target type, target id, detail).
type AuditLine = (Option<Uuid>, Option<String>, Option<Uuid>, Value);

/// What a database error says, for the tests that expect one: (SQLSTATE, message, constraint name).
fn db_error(error: sqlx::Error) -> (String, String, Option<String>) {
    match error {
        sqlx::Error::Database(db) => (
            db.code().map(|code| code.to_string()).unwrap_or_default(),
            db.message().to_string(),
            db.constraint().map(str::to_string),
        ),
        other => panic!("expected a database error, got: {other}"),
    }
}

/// WA11: a write inserts ONE `complete` attachment row — uploader = the run's agent, channel = the run's
/// channel, unbound, a server-fixed name, the decoder's mime and size — one audit line with the documented
/// fields and none of the name, drive id or token, and records the attachment on the token row, once.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_written_picture_is_one_complete_agent_row_with_one_audit_line_and_one_token_record() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    // the agent is in a second conversation too: the row must land in the RUN's channel
    let other_channel = seed_channel(su, w.ws, w.alice, &[w.alice, w.agent]).await;
    assert_ne!(other_channel, w.channel);

    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");
    assert_eq!(
        attachment_rows(su, w.ws).await,
        0,
        "nothing before the write"
    );
    let picture = StoredPicture {
        drive_file_id: format!("canary-drive-{}", Uuid::new_v4()),
        name: picture_name(target.slot, "image/jpeg"),
        mime: "image/jpeg".to_string(),
        size_bytes: 2048,
        mime_in: "image/webp",
        bytes_in: 40_000,
        decode_ms: 17,
        backend: "local",
    };
    let id = write(
        &pools,
        w.ws,
        target,
        picture.clone(),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("write transaction")
    .expect("the picture is written");

    // the attachment row
    #[allow(clippy::type_complexity)]
    let row: (
        Uuid,
        Uuid,
        Option<Uuid>,
        String,
        String,
        String,
        i64,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT uploader_member_id, channel_id, message_id, status, name, mime, size_bytes, \
                drive_file_id \
           FROM attachment WHERE workspace_id = $1 AND id = $2",
    )
    .bind(w.ws)
    .bind(id)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            w.agent,
            w.channel,
            None,
            "complete".to_string(),
            "picture-1.jpg".to_string(),
            "image/jpeg".to_string(),
            2048,
            Some(picture.drive_file_id.clone()),
        ),
        "uploader = the run's agent, channel = the run's channel, unbound, complete, the fixed name"
    );
    assert_eq!(attachment_rows(su, w.ws).await, 1, "exactly one row");

    // the mark that makes the picture count (#5530): one row naming this write, written with it
    let marks: Vec<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT attachment_id, run_id, agent_member_id FROM agent_picture_mark WHERE workspace_id = $1",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(
        marks,
        vec![(id, w.run, w.agent)],
        "one mark: this attachment, this run, this agent"
    );

    // the audit line: the documented fields, exactly, and none of the secrets
    let audits: Vec<AuditLine> = sqlx::query_as(
        "SELECT actor_member_id, target_type, target_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'attachment.agent_picture_written'",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(audits.len(), 1, "exactly one audit line");
    assert_eq!(audits[0].0, Some(w.agent), "the actor is the agent member");
    assert_eq!(audits[0].1.as_deref(), Some("attachment"));
    assert_eq!(audits[0].2, Some(id), "the target is the attachment");
    assert_eq!(
        audits[0].3,
        json!({
            "schema": "momo.attachment.agent_picture_written.v1",
            "channel_id": w.channel.to_string(),
            "run_id": w.run.to_string(),
            "slot": 1,
            "mime_in": "image/webp",
            "mime": "image/jpeg",
            "bytes_in": 40_000,
            "bytes": 2048,
            "decode_ms": 17,
            "backend": "local",
        }),
        "the documented fields and no others"
    );
    let audit_text = audits[0].3.to_string();
    for secret in [
        grant.token.as_str(),
        picture.drive_file_id.as_str(),
        picture.name.as_str(),
        "picture-1",
    ] {
        assert!(
            !audit_text.contains(secret),
            "the audit line must not hold `{secret}`: {audit_text}"
        );
    }

    // the token row recorded the attachment, and only once
    assert_eq!(recorded_attachment(su, w.ws, w.run).await, Some(id));
    assert!(used_at(su, w.ws, &grant.token).await.is_some());
    let second =
        sqlx::query("UPDATE attachment_write_token SET attachment_id = $2 WHERE workspace_id = $1")
            .bind(w.ws)
            .bind(Uuid::new_v4())
            .execute(su)
            .await
            .expect_err("a token records its attachment once");
    let (code, message, _) = db_error(second);
    assert_eq!(code, "23514", "{message}");
    assert!(message.contains("records its attachment once"), "{message}");
    assert_eq!(
        recorded_attachment(su, w.ws, w.run).await,
        Some(id),
        "the record did not move"
    );

    // and the token text is still nowhere in the table
    let everything: Vec<String> = sqlx::query_scalar(
        "SELECT to_jsonb(t)::text FROM attachment_write_token t WHERE workspace_id = $1",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    assert!(everything.iter().all(|text| !text.contains(&grant.token)));
}

/// A write that cannot record itself on the token (the same target a second time, or a hand-built
/// target whose token was never spent) is a LOUD error — and the caller's transaction takes the attachment
/// row and the audit line it had already written back with it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_write_that_cannot_record_itself_fails_loudly_and_leaves_nothing() {
    let pools = pools().await;
    let su = &pools.su;

    // the same target twice
    let w = seed_world(su).await;
    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");
    let first = write(
        &pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction")
    .expect("the first write lands");
    let again = write(
        &pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await;
    assert!(
        again.is_err(),
        "the second write of one target must fail, not write a second picture: {again:?}"
    );
    assert_eq!(attachment_rows(su, w.ws).await, 1, "still one attachment");
    assert_eq!(mark_rows(su, w.ws).await, 1, "still one mark");
    assert_eq!(
        audit_rows(su, w.ws, "attachment.agent_picture_written").await,
        1,
        "still one audit line"
    );
    assert_eq!(recorded_attachment(su, w.ws, w.run).await, Some(first));

    // a hand-built target for a token that was minted and never spent
    let w = seed_world(su).await;
    let _unspent = mint(&pools, &w).await.expect("a token");
    let hand_built = AgentPictureTarget {
        run_id: w.run,
        agent_member_id: w.agent,
        requester_member_id: w.alice,
        channel_id: w.channel,
        slot: 1,
    };
    let outcome = write(
        &pools,
        w.ws,
        hand_built,
        stored_png(&hand_built),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await;
    assert!(
        outcome.is_err(),
        "a token that was never spent records nothing: {outcome:?}"
    );
    assert_eq!(attachment_rows(su, w.ws).await, 0, "rolled back with it");
    assert_eq!(mark_rows(su, w.ws).await, 0, "the mark rolled back with it");
    assert_eq!(
        audit_rows(su, w.ws, "attachment.agent_picture_written").await,
        0
    );
    assert!(recorded_attachment(su, w.ws, w.run).await.is_none());
}

/// mint → redeem → `fault` → write: `Ok(())` when the write answered `RunOver` AND wrote nothing at all.
async fn write_refused_after(pools: &Pools, fault: Break) -> Result<(), String> {
    let su = &pools.su;
    let w = seed_world(su).await;
    let grant = mint(pools, &w)
        .await
        .ok_or("the healthy mint refused (the premise is broken)")?;
    let target = redeem(pools, w.ws, &grant.token)
        .await
        .ok_or("the healthy redeem refused (the premise is broken)")?;
    apply(su, &w, fault).await;
    let outcome = write(
        pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await;
    if !matches!(outcome, Ok(Err(PictureWriteRefused::RunOver))) {
        return Err(format!("expected RunOver, got {outcome:?}"));
    }
    if attachment_rows(su, w.ws).await != 0 {
        return Err("an attachment row was written".into());
    }
    if mark_rows(su, w.ws).await != 0 {
        return Err("a mark row was written".into());
    }
    if audit_rows(su, w.ws, "attachment.agent_picture_written").await != 0 {
        return Err("an audit line was written".into());
    }
    if recorded_attachment(su, w.ws, w.run).await.is_some() {
        return Err("the token recorded an attachment".into());
    }
    Ok(())
}

/// WA10 / WA23: the run was over, the channel archived or a person gone by the time the decode finished
/// (AFTER the token was spent): the write is `RunOver` and writes nothing; and a target that names a
/// channel other than the run's is refused the same way.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_write_after_the_run_is_over_or_a_member_left_is_refused_and_writes_nothing() {
    let pools = pools().await;
    for fault in [
        Break::RunSucceeded,
        Break::RunCancelled,
        Break::ChannelArchived,
        Break::RequesterLeft,
        Break::AgentLeft,
    ] {
        write_refused_after(&pools, fault)
            .await
            .unwrap_or_else(|why| panic!("{fault:?}: {why}"));
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_target_naming_another_channel_is_refused_as_run_over_and_the_honest_target_still_writes()
{
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let other_channel = seed_channel(su, w.ws, w.alice, &[w.alice, w.agent]).await;
    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");

    let mut moved = target;
    moved.channel_id = other_channel;
    let outcome = write(
        &pools,
        w.ws,
        moved,
        stored_png(&moved),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction");
    assert_eq!(outcome, Err(PictureWriteRefused::RunOver));
    assert_eq!(attachment_rows(su, w.ws).await, 0);
    assert!(recorded_attachment(su, w.ws, w.run).await.is_none());

    // the refusal left the transaction clean: the honest target (same spent token) writes
    let id = write(
        &pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction")
    .expect("the honest target writes");
    let channel: Uuid = sqlx::query_scalar("SELECT channel_id FROM attachment WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .unwrap();
    assert_eq!(channel, w.channel, "the run's channel, not the other one");
}

/// The same kind of disagreement about WHO: a target naming an agent other than the run's (a member of the
/// channel, so only the run's own agent check can refuse it) is `RunOver`; one naming another run of the
/// same agent — in flight, with its own healthy binding, but whose token was never spent — fails loudly
/// because that run has no spent token to record on. Neither leaves anything behind, and the honest target
/// still writes.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_target_naming_another_agent_is_refused_as_run_over_and_one_naming_another_run_fails_loudly(
) {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let other_agent = seed_member(su, w.ws, "agent").await;
    sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
        .bind(w.ws)
        .bind(w.channel)
        .bind(other_agent)
        .execute(su)
        .await
        .unwrap();
    let other_run = seed_run(su, w.ws, w.channel, w.agent, Some(w.trigger), "running").await;
    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");

    let mut other_agents = target;
    other_agents.agent_member_id = other_agent;
    let outcome = write(
        &pools,
        w.ws,
        other_agents,
        stored_png(&other_agents),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction");
    assert_eq!(outcome, Err(PictureWriteRefused::RunOver));

    let mut other_runs = target;
    other_runs.run_id = other_run;
    let outcome = write(
        &pools,
        w.ws,
        other_runs,
        stored_png(&other_runs),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await;
    assert!(
        outcome.is_err(),
        "a run that never spent a token has nothing to record on: {outcome:?}"
    );
    assert_eq!(attachment_rows(su, w.ws).await, 0, "nothing was written");
    assert_eq!(
        audit_rows(su, w.ws, "attachment.agent_picture_written").await,
        0
    );
    assert!(recorded_attachment(su, w.ws, w.run).await.is_none());

    write(
        &pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction")
    .expect("the honest target still writes");
    assert_eq!(attachment_rows(su, w.ws).await, 1);
}

/// W12 / WA24, #5530: the api counts for itself, and what it counts is the MARKS (`agent_picture_mark`) of
/// this workspace from the last 24 hours — not `attachment` rows. With a ceiling of 2: an old mark, another
/// workspace's mark, and every kind of `attachment` row (an agent's complete one included, a person's, a
/// pending or failed one) do not count; one mark from 23 hours ago does. A refusal writes nothing and leaves
/// the spent token reusable under a higher ceiling. (The old source — the agent's `complete` attachment
/// rows — would count the three agent rows below and refuse the first write: that is the line this test
/// holds.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_daily_ceiling_counts_only_marks_of_this_workspace_from_the_last_day() {
    let pools = pools().await;
    let su = &pools.su;
    assert_eq!(
        AGENT_PICTURES_DAILY_CEILING, 200,
        "ADR-0151 증보 8 W12 [추정]: the same number as the highest settable delegation cap"
    );
    let w = seed_world(su).await;
    let other_agent = seed_member(su, w.ws, "agent").await;
    // what must NOT count: marks that are too old, and every attachment row there is
    for _ in 0..2 {
        seed_mark(su, w.ws, "25 hours").await; // too old
        seed_attachment(su, w.ws, w.channel, w.agent, None, "complete", "0 seconds").await; // no mark
        seed_attachment(su, w.ws, w.channel, w.alice, None, "complete", "0 seconds").await;
        // a person's
    }
    seed_attachment(su, w.ws, w.channel, other_agent, None, "complete", "1 hour").await;
    seed_attachment(su, w.ws, w.channel, w.agent, None, "pending", "0 seconds").await;
    seed_attachment(su, w.ws, w.channel, w.agent, None, "failed", "0 seconds").await;
    let elsewhere = seed_world(su).await;
    for _ in 0..3 {
        seed_mark(su, elsewhere.ws, "0 seconds").await; // another workspace's marks
    }
    // what counts: one mark from 23 hours ago
    seed_mark(su, w.ws, "23 hours").await;
    let (attachments_before, marks_before) =
        (attachment_rows(su, w.ws).await, mark_rows(su, w.ws).await);

    // count 1 < 2: the first picture is written — and it adds its mark
    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");
    write(&pools, w.ws, target, stored_png(&target), 2)
        .await
        .expect("transaction")
        .expect("one counted mark is below a ceiling of two");
    assert_eq!(attachment_rows(su, w.ws).await, attachments_before + 1);
    assert_eq!(mark_rows(su, w.ws).await, marks_before + 1);

    // count 2 >= 2: the next run's picture is refused
    let trigger = seed_message(su, w.ws, w.channel, w.alice).await;
    let run2 = seed_run(su, w.ws, w.channel, w.agent, Some(trigger), "running").await;
    let grant2 = mint_for(&pools, w.ws, run2, w.agent)
        .await
        .expect("a token");
    let target2 = redeem(&pools, w.ws, &grant2.token).await.expect("a target");
    let refused = write(&pools, w.ws, target2, stored_png(&target2), 2)
        .await
        .expect("transaction");
    assert_eq!(refused, Err(PictureWriteRefused::CapReached));
    assert_eq!(
        attachment_rows(su, w.ws).await,
        attachments_before + 1,
        "a refusal writes no row"
    );
    assert_eq!(mark_rows(su, w.ws).await, marks_before + 1, "and no mark");
    assert!(
        recorded_attachment(su, w.ws, run2).await.is_none(),
        "and the token records nothing"
    );
    assert_eq!(
        audit_rows(su, w.ws, "attachment.agent_picture_written").await,
        1,
        "and no audit line of a write"
    );

    // the refusal burned nothing: the same spent target writes under a higher ceiling
    write(&pools, w.ws, target2, stored_png(&target2), 3)
        .await
        .expect("transaction")
        .expect("below a ceiling of three");
    assert_eq!(attachment_rows(su, w.ws).await, attachments_before + 2);
    assert_eq!(mark_rows(su, w.ws).await, marks_before + 2);
}

/// WA10 / WA11: a refusal AFTER the caller proved the token is one audit line of closed words — the run,
/// the slot, a reason word and a byte count — and no name, no token, no address.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_refusal_after_the_proof_is_one_audit_line_of_closed_words() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let grant = mint(&pools, &w).await.expect("a token");
    let target = redeem(&pools, w.ws, &grant.token).await.expect("a target");
    let ws = w.ws;
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(
            async move { record_picture_refused_in_tx(conn, ws, &target, "run_over", 1234).await },
        )
    })
    .await
    .expect("record the refusal");

    let rows: Vec<AuditLine> = sqlx::query_as(
        "SELECT actor_member_id, target_type, target_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'attachment.agent_picture_refused'",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, Some(w.agent));
    assert_eq!(rows[0].1.as_deref(), Some("agent_run"));
    assert_eq!(rows[0].2, Some(w.run), "the target is the run");
    assert_eq!(
        rows[0].3,
        json!({
            "schema": "momo.attachment.agent_picture_refused.v1",
            "run_id": w.run.to_string(),
            "slot": 1,
            "reason": "run_over",
            "bytes_in": 1234,
        })
    );
    assert!(!rows[0].3.to_string().contains(&grant.token));
    assert_eq!(attachment_rows(su, w.ws).await, 0);
    assert_eq!(
        audit_rows(su, w.ws, "attachment.agent_picture_written").await,
        0,
        "a refusal is not a write"
    );
}

// =================================================================================================
// D. the ids a run recorded
// =================================================================================================

/// The ids of a run's recorded pictures, read as the BYPASSRLS worker (so only the query's own workspace
/// condition scopes it). Index and bitmap scans are off for the statement: without an `ORDER BY` the rows
/// then come back in heap order, so only the `ORDER BY slot` can put them in slot order.
async fn run_picture_ids(pools: &Pools, ws: Uuid, run: Uuid) -> Vec<Uuid> {
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SET LOCAL enable_indexscan = off")
                .execute(&mut *conn)
                .await?;
            sqlx::query("SET LOCAL enable_bitmapscan = off")
                .execute(&mut *conn)
                .await?;
            run_picture_ids_in_tx(conn, ws, run).await
        })
    })
    .await
    .expect("ids transaction")
}

/// W9 / L2: the answer binds what THIS run's token rows recorded and nothing else — in slot order, never
/// an unbound picture of another run of the same agent in the same channel, never a stray file, never a
/// row that was spent without recording, never another workspace's run.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_runs_picture_ids_are_only_what_its_own_tokens_recorded_in_slot_order() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let trigger2 = seed_message(su, w.ws, w.channel, w.alice).await;
    let run2 = seed_run(su, w.ws, w.channel, w.agent, Some(trigger2), "running").await;
    let mut ids = Vec::new();
    for _ in 0..5 {
        ids.push(
            seed_attachment(su, w.ws, w.channel, w.agent, None, "complete", "0 seconds").await,
        );
    }
    let (a, b, c, d, stray) = (ids[0], ids[1], ids[2], ids[3], ids[4]);
    // run 1 recorded a, b, c at slots 1, 2, 3 — inserted 3, 1, 2 so heap order is not slot order — and
    // spent slot 4 without recording anything; run 2 recorded d
    forge_recorded(su, w.ws, w.run, w.agent, 3, Some(c)).await;
    forge_recorded(su, w.ws, w.run, w.agent, 1, Some(a)).await;
    forge_recorded(su, w.ws, w.run, w.agent, 2, Some(b)).await;
    forge_recorded(su, w.ws, w.run, w.agent, 4, None).await;
    forge_recorded(su, w.ws, run2, w.agent, 1, Some(d)).await;

    assert_eq!(
        run_picture_ids(&pools, w.ws, w.run).await,
        vec![a, b, c],
        "this run's records in slot order; not d (run 2's), not the stray file, not the unrecorded slot"
    );
    assert_eq!(run_picture_ids(&pools, w.ws, run2).await, vec![d]);
    assert!(
        run_picture_ids(&pools, w.ws, Uuid::new_v4())
            .await
            .is_empty(),
        "a run that wrote nothing has no pictures"
    );
    let _ = stray;

    // another workspace asking about this run's id sees nothing
    let other = seed_world(su).await;
    assert!(
        run_picture_ids(&pools, other.ws, w.run).await.is_empty(),
        "the query is scoped to its own workspace even for a BYPASSRLS role"
    );

    // the real flow records exactly one id
    let w = seed_world(su).await;
    let id = picture_of(&pools, w.ws, w.run, w.agent).await;
    assert_eq!(run_picture_ids(&pools, w.ws, w.run).await, vec![id]);
}

// =================================================================================================
// E. the answer entry
// =================================================================================================

fn answer(channel: Uuid, agent: Uuid, run: Uuid, body: &str) -> NewMessage {
    NewMessage {
        run_id: Some(run),
        client_msg_id: Some(run),
        ..NewMessage::text(channel, agent, body)
    }
}

/// The caller's side of the contract (W9): a savepoint before the entry, and a refusal rolls back to it.
/// The transaction then commits, so what is left in the database is exactly what a caller that re-sends
/// afterwards starts from.
async fn send_answer(
    pools: &Pools,
    ws: Uuid,
    input: NewMessage,
) -> Result<SentMessage, AttachmentLinkRejected> {
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SAVEPOINT answer").execute(&mut *conn).await?;
            let outcome = send_thread_notice_with_run_pictures_in_tx(conn, ws, input).await?;
            if outcome.is_err() {
                sqlx::query("ROLLBACK TO SAVEPOINT answer")
                    .execute(&mut *conn)
                    .await?;
            }
            Ok(outcome)
        })
    })
    .await
    .expect("answer transaction")
}

/// What the caller falls back to after a refusal: the same answer without pictures, on the plain spine.
async fn send_plain(pools: &Pools, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move { send_thread_notice_in_tx(conn, ws, input).await })
    })
    .await
    .expect("plain answer transaction")
}

/// Every `message.new` broadcast payload (`data.payload`) of one channel, oldest first.
async fn message_new_frames(su: &PgPool, ws: Uuid, channel: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 AND partition_key = $2 AND kind::text = 'broadcast' \
            AND payload->'data'->>'type' = 'message.new' \
          ORDER BY id",
    )
    .bind(ws)
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("broadcast frames")
}

/// The file card a picture of `stored_png` shows on a message.
fn picture_card(id: Uuid) -> Value {
    json!({"id": id.to_string(), "name": "picture-1.png", "mime": "image/png", "sizeBytes": 4096})
}

fn picture_attachment(id: Uuid) -> MessageAttachment {
    MessageAttachment {
        id: id.to_string(),
        name: "picture-1.png".to_string(),
        mime: "image/png".to_string(),
        size_bytes: 4096,
        media: None,
    }
}

async fn message_count(su: &PgPool, channel: Uuid, client_msg_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1 AND client_msg_id = $2")
        .bind(channel)
        .bind(client_msg_id)
        .fetch_one(su)
        .await
        .expect("message count")
}

/// The message an attachment is bound to (`None` when unbound).
async fn linked_to(su: &PgPool, attachment: Uuid) -> Option<Uuid> {
    sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
        .bind(attachment)
        .fetch_one(su)
        .await
        .expect("the attachment row exists")
}

/// WA12: the answer entry binds exactly what the run's own tokens recorded, onto the one answer message,
/// and `message.new` carries the file card. The same agent's other still-unbound pictures — another run's
/// in the same channel, a stray file nobody recorded — are not touched (L2), in either direction.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_answer_binds_exactly_the_runs_recorded_pictures_and_publishes_them() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    // a second run of the same agent in the same channel, with its own request
    let trigger2 = seed_message(su, w.ws, w.channel, w.alice).await;
    let run2 = seed_run(su, w.ws, w.channel, w.agent, Some(trigger2), "running").await;
    let mine = picture_of(&pools, w.ws, w.run, w.agent).await;
    let theirs = picture_of(&pools, w.ws, run2, w.agent).await;
    let stray = seed_attachment(su, w.ws, w.channel, w.agent, None, "complete", "0 seconds").await;
    for id in [mine, theirs, stray] {
        assert_eq!(
            linked_to(su, id).await,
            None,
            "the premise: three unbound agent pictures in one channel"
        );
    }

    let sent = send_answer(
        &pools,
        w.ws,
        answer(w.channel, w.agent, w.run, "here is your picture"),
    )
    .await
    .expect("the run's picture is bound");
    assert!(!sent.deduped);
    assert!(sent.outbox_id.is_some());
    assert_eq!(sent.message.author_member_id, w.agent);
    assert_eq!(
        sent.attachments,
        vec![picture_attachment(mine)],
        "the send echoes the file card of the run's own picture"
    );

    // the rows: only the run's own picture is bound, to the answer
    assert_eq!(linked_to(su, mine).await, Some(sent.message.id));
    assert_eq!(
        linked_to(su, theirs).await,
        None,
        "another run's unbound picture is not bound (L2)"
    );
    assert_eq!(linked_to(su, stray).await, None, "nor is a stray file");
    let linked: Vec<Option<Uuid>> = sqlx::query_scalar(
        "SELECT target_id FROM audit_log WHERE workspace_id = $1 AND action = 'attachment.message_linked'",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(linked, vec![Some(mine)], "one link, audited");

    // the broadcast: exactly one message.new, and it carries the file card
    let frames = message_new_frames(su, w.ws, w.channel).await;
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["id"], json!(sent.message.id.to_string()));
    assert_eq!(
        frames[0]["attachments"],
        json!([picture_card(mine)]),
        "the realtime payload carries the attachment (the Project branch)"
    );

    // the history projection of the same message
    let (ws, message_id) = (w.ws, sent.message.id);
    let projected = with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move { message_attachments_in_tx(conn, message_id).await })
    })
    .await
    .unwrap();
    assert_eq!(projected, vec![picture_attachment(mine)]);

    // the other run's answer binds its own picture, and only that
    let sent2 = send_answer(&pools, w.ws, answer(w.channel, w.agent, run2, "and yours"))
        .await
        .expect("the second run's picture is bound");
    assert_ne!(sent2.message.id, sent.message.id);
    assert_eq!(sent2.attachments, vec![picture_attachment(theirs)]);
    assert_eq!(linked_to(su, mine).await, Some(sent.message.id));
    assert_eq!(linked_to(su, theirs).await, Some(sent2.message.id));
    assert_eq!(linked_to(su, stray).await, None);
    let frames = message_new_frames(su, w.ws, w.channel).await;
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1]["attachments"], json!([picture_card(theirs)]));
}

/// A run that recorded no picture answers like the plain notice — no file card, no `attachments` key on
/// the payload — even with another run's unbound picture of the same agent lying in the same channel.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_run_that_wrote_no_picture_answers_plainly_and_binds_nobody_elses() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let trigger2 = seed_message(su, w.ws, w.channel, w.alice).await;
    let run2 = seed_run(su, w.ws, w.channel, w.agent, Some(trigger2), "running").await;
    let theirs = picture_of(&pools, w.ws, run2, w.agent).await;
    let stray = seed_attachment(su, w.ws, w.channel, w.agent, None, "complete", "0 seconds").await;

    let sent = send_answer(
        &pools,
        w.ws,
        answer(w.channel, w.agent, w.run, "no picture this time"),
    )
    .await
    .expect("a plain answer");
    assert!(sent.attachments.is_empty());
    assert_eq!(linked_to(su, theirs).await, None);
    assert_eq!(linked_to(su, stray).await, None);
    assert_eq!(
        audit_rows(su, w.ws, "attachment.message_linked").await,
        0,
        "nothing was bound"
    );
    let frames = message_new_frames(su, w.ws, w.channel).await;
    assert_eq!(frames.len(), 1);
    assert!(
        frames[0].get("attachments").is_none(),
        "no attachments key: {}",
        frames[0]
    );
}

/// WA12: a retried send (`client_msg_id` = the run id) neither binds again nor publishes again, and
/// still echoes the file card it carries.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_retried_answer_binds_nothing_twice_and_publishes_nothing_twice() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let mine = picture_of(&pools, w.ws, w.run, w.agent).await;

    let first = send_answer(&pools, w.ws, answer(w.channel, w.agent, w.run, "here"))
        .await
        .expect("bound");
    for _ in 0..2 {
        let retried = send_answer(&pools, w.ws, answer(w.channel, w.agent, w.run, "here"))
            .await
            .expect("a retry is not a refusal (it would be AlreadyLinked if it bound again)");
        assert!(retried.deduped);
        assert!(retried.outbox_id.is_none(), "a retry publishes nothing");
        assert_eq!(retried.message.id, first.message.id);
        assert_eq!(retried.attachments, vec![picture_attachment(mine)]);
    }
    assert_eq!(message_count(su, w.channel, w.run).await, 1);
    assert_eq!(linked_to(su, mine).await, Some(first.message.id));
    assert_eq!(audit_rows(su, w.ws, "attachment.message_linked").await, 1);
    assert_eq!(message_new_frames(su, w.ws, w.channel).await.len(), 1);
}

/// WA13: whichever way the binding is refused, the caller's rollback leaves no message, no broadcast and
/// no half-bound picture, and the plain re-send lands exactly once (and dedupes on retry).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_refused_binding_leaves_nothing_behind_and_the_plain_resend_lands_exactly_once() {
    let pools = pools().await;
    let su = &pools.su;
    for expected in [
        AttachmentLinkRejected::ForeignChannel,
        AttachmentLinkRejected::AlreadyLinked,
        AttachmentLinkRejected::NotComplete,
        AttachmentLinkRejected::NotFound,
        AttachmentLinkRejected::ForeignUploader,
    ] {
        let w = seed_world(su).await;
        let other_channel = seed_channel(su, w.ws, w.alice, &[w.alice, w.agent]).await;
        let other_message = seed_message(su, w.ws, w.channel, w.agent).await;
        let picture = picture_of(&pools, w.ws, w.run, w.agent).await;
        // one thing about the recorded picture stops being true between the write and the answer
        match expected {
            AttachmentLinkRejected::ForeignChannel => {
                sqlx::query("UPDATE attachment SET channel_id = $2 WHERE id = $1")
                    .bind(picture)
                    .bind(other_channel)
                    .execute(su)
                    .await
            }
            AttachmentLinkRejected::AlreadyLinked => {
                sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
                    .bind(picture)
                    .bind(other_message)
                    .execute(su)
                    .await
            }
            AttachmentLinkRejected::NotComplete => {
                sqlx::query("UPDATE attachment SET status = 'failed' WHERE id = $1")
                    .bind(picture)
                    .execute(su)
                    .await
            }
            AttachmentLinkRejected::NotFound => {
                sqlx::query("DELETE FROM attachment WHERE id = $1")
                    .bind(picture)
                    .execute(su)
                    .await
            }
            AttachmentLinkRejected::ForeignUploader => {
                sqlx::query("UPDATE attachment SET uploader_member_id = $2 WHERE id = $1")
                    .bind(picture)
                    .bind(w.alice)
                    .execute(su)
                    .await
            }
            other => unreachable!("not a case of this test: {other:?}"),
        }
        .expect("the mutation");

        let refused = send_answer(&pools, w.ws, answer(w.channel, w.agent, w.run, "here"))
            .await
            .unwrap_err();
        assert_eq!(refused, expected);

        // nothing of the refused answer is left
        assert_eq!(
            message_count(su, w.channel, w.run).await,
            0,
            "{expected:?}: no message"
        );
        assert!(
            message_new_frames(su, w.ws, w.channel).await.is_empty(),
            "{expected:?}: no broadcast"
        );
        assert_eq!(
            audit_rows(su, w.ws, "attachment.message_linked").await,
            0,
            "{expected:?}: no link was audited"
        );
        if !matches!(expected, AttachmentLinkRejected::NotFound) {
            let want =
                matches!(expected, AttachmentLinkRejected::AlreadyLinked).then_some(other_message);
            assert_eq!(
                linked_to(su, picture).await,
                want,
                "{expected:?}: the picture is exactly where the mutation left it"
            );
        }

        // the caller's fallback: the same answer without pictures, once
        let plain = send_plain(
            &pools,
            w.ws,
            answer(w.channel, w.agent, w.run, "the picture could not be added"),
        )
        .await;
        assert!(!plain.deduped);
        assert!(plain.attachments.is_empty());
        assert_eq!(message_count(su, w.channel, w.run).await, 1);
        let frames = message_new_frames(su, w.ws, w.channel).await;
        assert_eq!(frames.len(), 1, "{expected:?}: one broadcast");
        assert!(frames[0].get("attachments").is_none());
        let retry = send_plain(
            &pools,
            w.ws,
            answer(w.channel, w.agent, w.run, "the picture could not be added"),
        )
        .await;
        assert!(retry.deduped, "{expected:?}: the retry dedupes");
        assert_eq!(message_count(su, w.channel, w.run).await, 1);
    }
}

/// T7 / WA12: a person cannot bind the agent's picture to their own message, and a run's record cannot
/// smuggle a person's file onto the agent's answer — both are `ForeignUploader`, and nothing moves.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_human_cannot_bind_the_agents_picture_and_a_run_record_cannot_smuggle_a_humans_file() {
    let pools = pools().await;
    let su = &pools.su;

    // a person naming the agent's picture on their own message
    let w = seed_world(su).await;
    let picture = picture_of(&pools, w.ws, w.run, w.agent).await;
    let alice_message = seed_message(su, w.ws, w.channel, w.alice).await;
    let (ws, channel, alice) = (w.ws, w.channel, w.alice);
    let outcome = with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move {
            link_attachments_in_tx(conn, ws, channel, alice_message, alice, None, &[picture]).await
        })
    })
    .await
    .expect("transaction");
    assert_eq!(outcome, Err(AttachmentLinkRejected::ForeignUploader));
    assert_eq!(linked_to(su, picture).await, None);

    // a run record naming a person's file: the entry refuses it for the same reason
    let w = seed_world(su).await;
    let human_file =
        seed_attachment(su, w.ws, w.channel, w.alice, None, "complete", "0 seconds").await;
    forge_recorded(su, w.ws, w.run, w.agent, 1, Some(human_file)).await;
    let refused = send_answer(&pools, w.ws, answer(w.channel, w.agent, w.run, "here"))
        .await
        .unwrap_err();
    assert_eq!(refused, AttachmentLinkRejected::ForeignUploader);
    assert_eq!(linked_to(su, human_file).await, None);
    assert_eq!(message_count(su, w.channel, w.run).await, 0);
}

/// WA14 / L1: with the BYPASSRLS worker role, naming an attachment id of ANOTHER workspace is `NotFound` —
/// not `ForeignUploader`/`ForeignChannel` (which would tell the caller the id exists) and never a bind. The
/// non-bypass role says the same by RLS; a file of the caller's own workspace binds.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_worker_role_cannot_bind_another_workspaces_attachment() {
    let pools = pools().await;
    let su = &pools.su;
    let here = seed_world(su).await;
    let there = seed_world(su).await;
    let theirs = seed_attachment(
        su,
        there.ws,
        there.channel,
        there.agent,
        None,
        "complete",
        "0 seconds",
    )
    .await;
    let message = seed_message(su, here.ws, here.channel, here.agent).await;

    // asked as this workspace, with the other workspace's uploader (what a guess at "the same author"
    // would try) and with this workspace's own agent
    for (pool_name, pool) in [("worker (BYPASSRLS)", &pools.worker), ("app", &pools.app)] {
        for uploader in [there.agent, here.agent] {
            let (ws, channel) = (here.ws, here.channel);
            let outcome = with_tenant_tx(pool, ws, move |conn| {
                Box::pin(async move {
                    link_attachments_in_tx(conn, ws, channel, message, uploader, None, &[theirs])
                        .await
                })
            })
            .await
            .expect("transaction");
            assert_eq!(
                outcome,
                Err(AttachmentLinkRejected::NotFound),
                "{pool_name}, uploader {uploader}: another workspace's file is not found"
            );
        }
    }
    assert_eq!(
        linked_to(su, theirs).await,
        None,
        "the other workspace's file was not touched"
    );

    // the positive control: this workspace's own file binds through the same call
    let own = seed_attachment(
        su,
        here.ws,
        here.channel,
        here.agent,
        None,
        "complete",
        "0 seconds",
    )
    .await;
    let (ws, channel, agent) = (here.ws, here.channel, here.agent);
    let outcome = with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move {
            link_attachments_in_tx(conn, ws, channel, message, agent, None, &[own]).await
        })
    })
    .await
    .expect("transaction");
    assert_eq!(outcome, Ok(()));
    assert_eq!(linked_to(su, own).await, Some(message));
}

/// WA12 (the general form, N = 3): several recorded pictures bind to ONE message, and the broadcast carries
/// them all.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn three_recorded_pictures_bind_to_one_answer_and_all_are_published() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let mut files = Vec::new();
    for slot in 1..=3_i16 {
        let id = seed_attachment(su, w.ws, w.channel, w.agent, None, "complete", "0 seconds").await;
        forge_recorded(su, w.ws, w.run, w.agent, slot, Some(id)).await;
        files.push(id);
    }

    let sent = send_answer(
        &pools,
        w.ws,
        answer(w.channel, w.agent, w.run, "three pictures"),
    )
    .await
    .expect("all three bind");
    let mut got: Vec<String> = sent
        .attachments
        .iter()
        .map(|card| card.id.clone())
        .collect();
    let mut want: Vec<String> = files.iter().map(Uuid::to_string).collect();
    got.sort();
    want.sort();
    assert_eq!(got, want, "all three on the one message");
    for id in &files {
        assert_eq!(linked_to(su, *id).await, Some(sent.message.id));
    }
    assert_eq!(message_count(su, w.channel, w.run).await, 1);
    assert_eq!(audit_rows(su, w.ws, "attachment.message_linked").await, 3);
    let frames = message_new_frames(su, w.ws, w.channel).await;
    assert_eq!(frames.len(), 1);
    assert_eq!(
        frames[0]["attachments"].as_array().map(Vec::len),
        Some(3),
        "the broadcast carries all three"
    );
}

/// Which message projection to run: the full one (it LEFT JOINs `attachment_media`) or the one the
/// agent-worker's answer uses (it does not).
#[derive(Clone, Copy)]
enum Projection {
    WithMedia,
    WithoutMedia,
}

/// Run a projection as `pool`'s role behind a savepoint, so a refused statement does not abort the
/// transaction; a database refusal comes back as (SQLSTATE, message).
async fn project(
    pool: &PgPool,
    ws: Uuid,
    message_id: Uuid,
    which: Projection,
) -> Result<Vec<MessageAttachment>, (String, String)> {
    with_tenant_tx(pool, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SAVEPOINT projection")
                .execute(&mut *conn)
                .await?;
            let outcome = match which {
                Projection::WithMedia => message_attachments_in_tx(&mut *conn, message_id).await,
                Projection::WithoutMedia => {
                    message_attachments_without_media_in_tx(&mut *conn, ws, message_id).await
                }
            };
            sqlx::query("ROLLBACK TO SAVEPOINT projection")
                .execute(&mut *conn)
                .await?;
            Ok(outcome.map_err(|error| match error {
                DbError::Sqlx(sqlx::Error::Database(db)) => (
                    db.code().map(|code| code.to_string()).unwrap_or_default(),
                    db.message().to_string(),
                ),
                other => ("not a database error".to_string(), other.to_string()),
            }))
        })
    })
    .await
    .expect("projection transaction")
}

/// The lean projection as `pool`'s role inside a tenant tx bound to `tenant`, but ASKING for `asked`'s
/// rows: what a BYPASSRLS caller can do (RLS does not stop it), so only the statement's own workspace
/// condition does (implementation review L-2).
async fn lean_projection_asking(
    pool: &PgPool,
    tenant: Uuid,
    asked: Uuid,
    message_id: Uuid,
) -> Vec<MessageAttachment> {
    with_tenant_tx(pool, tenant, move |conn| {
        Box::pin(async move {
            message_attachments_without_media_in_tx(&mut *conn, asked, message_id).await
        })
    })
    .await
    .expect("the lean projection")
}

/// W9 (the production fix found while this test was written): `momo_worker` holds nothing on
/// `attachment_media` (the attachment-media lockdown), and the full projection LEFT JOINs that table, so
/// the answer entry — which runs as the worker — projects without it. Pinned here: (1) the worker role
/// really cannot run the full projection; (2) the entry succeeds as the worker and the `message.new`
/// card has the four keys of a photo and no `media`; (3) the lean projection returns the same rows, in
/// the same order, with the same four values, as the full one run by the api role and the superuser, and
/// nothing for a deleted message.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_worker_answers_without_the_media_table_and_its_projection_agrees_with_the_full_one() {
    let pools = pools().await;
    let su = &pools.su;

    // (2) the entry works under the worker role; the card has exactly the photo's four keys
    let w = seed_world(su).await;
    let mine = picture_of(&pools, w.ws, w.run, w.agent).await;
    let sent = send_answer(&pools, w.ws, answer(w.channel, w.agent, w.run, "here"))
        .await
        .expect("the entry works under the worker role");
    let frames = message_new_frames(su, w.ws, w.channel).await;
    assert_eq!(frames.len(), 1);
    let cards = frames[0]["attachments"]
        .as_array()
        .expect("the broadcast carries an attachments array");
    assert_eq!(cards.len(), 1);
    let mut keys: Vec<&str> = cards[0]
        .as_object()
        .expect("a card")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["id", "mime", "name", "sizeBytes"], "{}", cards[0]);
    assert!(
        cards[0].get("media").is_none(),
        "no media key: {}",
        cards[0]
    );
    assert_eq!(cards[0]["id"], json!(mine.to_string()));

    // (1) why the entry does not use the full projection: the worker role is refused the table
    let (code, message) = project(&pools.worker, w.ws, sent.message.id, Projection::WithMedia)
        .await
        .expect_err("the worker role may not run the projection that joins attachment_media");
    assert_eq!(code, "42501", "{message}");
    assert!(message.contains("attachment_media"), "{message}");
    assert_eq!(
        project(
            &pools.worker,
            w.ws,
            sent.message.id,
            Projection::WithoutMedia
        )
        .await,
        Ok(vec![picture_attachment(mine)]),
        "the lean projection reads the same message fine"
    );

    // (3) agreement on a message with several attachments created out of order: the oldest first, the
    // not-yet-complete one left out
    let w = seed_world(su).await;
    let message = seed_message(su, w.ws, w.channel, w.agent).await;
    let mut ids = Vec::new();
    for age in ["3 minutes", "1 minute", "2 minutes"] {
        ids.push(
            seed_attachment(su, w.ws, w.channel, w.agent, Some(message), "complete", age).await,
        );
    }
    seed_attachment(
        su,
        w.ws,
        w.channel,
        w.agent,
        Some(message),
        "pending",
        "0 seconds",
    )
    .await;
    let oldest_first = vec![ids[0], ids[2], ids[1]];

    let full_app = project(&pools.app, w.ws, message, Projection::WithMedia)
        .await
        .expect("the api role runs the full projection");
    let full_su = project(&pools.su, w.ws, message, Projection::WithMedia)
        .await
        .expect("the superuser runs the full projection");
    let lean_worker = project(&pools.worker, w.ws, message, Projection::WithoutMedia)
        .await
        .expect("the worker runs the lean projection");
    let lean_app = project(&pools.app, w.ws, message, Projection::WithoutMedia)
        .await
        .expect("the api role runs the lean projection");
    let got: Vec<Uuid> = lean_worker
        .iter()
        .map(|card| card.id.parse().expect("a uuid"))
        .collect();
    assert_eq!(
        got, oldest_first,
        "oldest first, and not the pending upload"
    );
    for card in &lean_worker {
        assert_eq!(
            (card.name.as_str(), card.mime.as_str(), card.size_bytes),
            ("seeded", "image/png", 10)
        );
        assert!(card.media.is_none());
    }
    assert_eq!(lean_worker, full_app, "same rows, same order, same values");
    assert_eq!(lean_worker, full_su);
    assert_eq!(lean_worker, lean_app);

    // L-2: the lean projection is the BYPASSRLS worker's, so the workspace is asked in the statement. Asked
    // under ANOTHER tenant's id it reads nothing of this message, though the role skips RLS (the control:
    // asked under its own tenant's id from a tx bound to the other one, it reads the rows, which is exactly
    // why RLS is not what protects this)
    let other = seed_world(su).await;
    assert_eq!(
        lean_projection_asking(&pools.worker, other.ws, other.ws, message).await,
        Vec::new(),
        "another tenant's workspace id must read none of this tenant's attachments"
    );
    assert_eq!(
        lean_projection_asking(&pools.worker, other.ws, w.ws, message)
            .await
            .len(),
        3,
        "the control: the worker role is not bound by RLS, so the condition in the statement is the guard"
    );

    // the one thing the lean projection leaves out: a video's media summary (a picture the worker wrote is
    // never one, so nothing is lost in the answer)
    sqlx::query(
        "INSERT INTO attachment_media (workspace_id, attachment_id, duration_ms, width, height) \
         VALUES ($1, $2, 1000, 640, 480)",
    )
    .bind(w.ws)
    .bind(ids[1])
    .execute(su)
    .await
    .unwrap();
    let full_with_video = project(&pools.app, w.ws, message, Projection::WithMedia)
        .await
        .expect("full projection");
    let lean_with_video = project(&pools.worker, w.ws, message, Projection::WithoutMedia)
        .await
        .expect("lean projection");
    assert_eq!(full_with_video.len(), lean_with_video.len());
    for (full, lean) in full_with_video.iter().zip(&lean_with_video) {
        assert_eq!(
            (&full.id, &full.name, &full.mime, full.size_bytes),
            (&lean.id, &lean.name, &lean.mime, lean.size_bytes),
            "the four values are the same"
        );
        assert!(
            lean.media.is_none(),
            "the lean projection never reads media"
        );
    }
    assert!(
        full_with_video.iter().any(|card| card.media.is_some()),
        "the premise: the full projection does see the video's summary"
    );

    // a deleted message projects nothing, either way
    sqlx::query(
        "UPDATE message SET state = 'deleted'::message_state, deleted_at = now() WHERE id = $1",
    )
    .bind(message)
    .execute(su)
    .await
    .unwrap();
    for (label, pool, which) in [
        (
            "lean as the worker",
            &pools.worker,
            Projection::WithoutMedia,
        ),
        ("lean as the api role", &pools.app, Projection::WithoutMedia),
        ("full as the api role", &pools.app, Projection::WithMedia),
    ] {
        assert_eq!(
            project(pool, w.ws, message, which).await,
            Ok(Vec::new()),
            "{label}: a deleted message carries no attachment"
        );
    }
}

// =================================================================================================
// F. privileges, the guard trigger, the checks, RLS
// =================================================================================================

const VERBS: [&str; 7] = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
];

async fn role_exists(su: &PgPool, role: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
        .bind(role)
        .fetch_one(su)
        .await
        .expect("pg_roles")
}

/// Run one statement as a role and say whether the **privilege** let it through. `permission denied
/// for table` is the privilege missing; anything else that stops the statement later (a NOT NULL
/// constraint on an INSERT of `DEFAULT VALUES`, a row-level-security check for the non-bypass role,
/// whose SQLSTATE is also 42501) means the privilege check had already passed.
async fn privilege_probe(pool: &PgPool, sql: &str) -> &'static str {
    match sqlx::query(sql).execute(pool).await {
        Ok(_) => "allowed",
        Err(sqlx::Error::Database(error))
            if error.code().as_deref() == Some("42501")
                && error.message().starts_with("permission denied for table") =>
        {
            "denied"
        }
        Err(sqlx::Error::Database(error))
            if error.code().as_deref() == Some("23502")
                || error.message().contains("row-level security") =>
        {
            "allowed"
        }
        Err(other) => panic!("`{sql}` failed for a reason other than privilege: {other}"),
    }
}

/// The roles whose privileges on a lockdown table are measured, `public` included.
const LOCKDOWN_ROLES: [&str; 7] = [
    "momo_app",
    "momo_relay",
    "momo_worker",
    "momo_notifier",
    "momo_platform_admin",
    "momo_helper_read",
    "public",
];

/// What every runtime role holds on one table, said twice: the catalog (what is granted, every verb, every
/// role) and a real statement as each real login role (a privilege some other grant path still supplies
/// would show here and not in the catalog's table-level answer).
async fn assert_table_privileges(
    pools: &Pools,
    table: &str,
    statements: [(&str, &str); 4],
    expected: fn(&str) -> &'static [&'static str],
) {
    let mut drift: Vec<String> = Vec::new();
    let mut checked: Vec<&str> = Vec::new();
    for role in LOCKDOWN_ROLES {
        if role != "public" && !role_exists(&pools.su, role).await {
            // not created by the development bootstrap; the block's `CONTINUE WHEN NOT EXISTS` skips it
            eprintln!("role {role} does not exist in this database: not checked");
            continue;
        }
        checked.push(role);
        for verb in VERBS {
            let held: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
                .bind(role)
                .bind(format!("public.{table}"))
                .bind(verb)
                .fetch_one(&pools.su)
                .await
                .unwrap();
            let want = expected(role).contains(&verb);
            if held != want {
                drift.push(format!("{role}:{verb} held={held} want={want}"));
            }
        }
    }
    assert!(
        drift.is_empty(),
        "{table}: the table's privileges drifted from the lockdown: {drift:?}"
    );
    for role in [
        "momo_app",
        "momo_relay",
        "momo_worker",
        "momo_notifier",
        "public",
    ] {
        assert!(checked.contains(&role), "{table}: {role} was not checked");
    }

    // the same, as real statements run by the real roles
    let relay = pool_as("momo_relay", "MOMO_RELAY_PASSWORD", "momo_relay_dev_pw").await;
    let notifier = pool_as(
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await;
    let mut wrong: Vec<String> = Vec::new();
    for (role, pool) in [
        ("momo_app", &pools.app),
        ("momo_relay", &relay),
        ("momo_worker", &pools.worker),
        ("momo_notifier", &notifier),
    ] {
        for (verb, sql) in statements {
            let got = privilege_probe(pool, sql).await;
            let want = if expected(role).contains(&verb) {
                "allowed"
            } else {
                "denied"
            };
            if got != want {
                wrong.push(format!("{role} {verb}: {got}, want {want}"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{table}: a statement ran (or was refused) against the lockdown: {wrong:?}"
    );
}

/// WA18, #5530: the token table holds exactly what the flow uses, role by role
/// (`attachment-write-token-lockdown`): the worker mints and reads (SELECT, INSERT — no UPDATE, and **no
/// DELETE any more**: it could free its own spent slot, and the day-old sweep is the api's now), the api
/// spends, records and sweeps (SELECT, UPDATE, DELETE — no INSERT), and relay, notifier and platform_admin
/// touch nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_runtime_roles_hold_exactly_the_privileges_the_flow_uses() {
    let pools = pools().await;
    assert_table_privileges(
        &pools,
        "attachment_write_token",
        [
            ("SELECT", "SELECT count(*) FROM attachment_write_token"),
            (
                "INSERT",
                "INSERT INTO attachment_write_token DEFAULT VALUES",
            ),
            (
                "UPDATE",
                "UPDATE attachment_write_token SET used_at = used_at WHERE false",
            ),
            ("DELETE", "DELETE FROM attachment_write_token WHERE false"),
        ],
        |role| match role {
            "momo_app" => &["SELECT", "UPDATE", "DELETE"],
            "momo_worker" => &["SELECT", "INSERT"],
            _ => &[],
        },
    )
    .await;
}

/// #5530: the mark table (`agent-picture-mark-lockdown`) belongs to the api role alone — it counts, writes
/// the row and sweeps (SELECT, INSERT, DELETE; nobody updates) — and the worker holds **nothing**: not even
/// SELECT, not through the helper's read role, not through `PUBLIC`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_mark_table_belongs_to_the_api_role_alone() {
    let pools = pools().await;
    assert_table_privileges(
        &pools,
        "agent_picture_mark",
        [
            ("SELECT", "SELECT count(*) FROM agent_picture_mark"),
            ("INSERT", "INSERT INTO agent_picture_mark DEFAULT VALUES"),
            (
                "UPDATE",
                "UPDATE agent_picture_mark SET written_at = written_at WHERE false",
            ),
            ("DELETE", "DELETE FROM agent_picture_mark WHERE false"),
        ],
        |role| match role {
            "momo_app" => &["SELECT", "INSERT", "DELETE"],
            _ => &[],
        },
    )
    .await;

    // every other role there is — the memory role and the helper's read role the worker may SET to
    // included — holds nothing at table or column level (predefined `pg_*` roles are membership grants
    // nobody here holds: asserted below)
    let others: Vec<String> = sqlx::query_scalar(
        "SELECT r.rolname FROM pg_roles r \
          WHERE NOT r.rolsuper AND r.rolname <> 'momo_app' AND r.rolname NOT LIKE 'pg\\_%' \
            AND (has_any_column_privilege(r.oid, 'public.agent_picture_mark', 'SELECT') \
              OR has_any_column_privilege(r.oid, 'public.agent_picture_mark', 'INSERT') \
              OR has_any_column_privilege(r.oid, 'public.agent_picture_mark', 'UPDATE') \
              OR has_any_column_privilege(r.oid, 'public.agent_picture_mark', 'REFERENCES') \
              OR has_table_privilege(r.oid, 'public.agent_picture_mark', 'DELETE') \
              OR has_table_privilege(r.oid, 'public.agent_picture_mark', 'TRUNCATE') \
              OR has_table_privilege(r.oid, 'public.agent_picture_mark', 'TRIGGER')) \
          ORDER BY 1",
    )
    .fetch_all(&pools.su)
    .await
    .unwrap();
    assert!(
        others.is_empty(),
        "roles other than momo_app hold something on agent_picture_mark: {others:?}"
    );
    let members_of_predefined: Vec<String> = sqlx::query_scalar(
        "SELECT r.rolname FROM pg_roles r \
          WHERE r.rolname LIKE 'momo\\_%' \
            AND (pg_has_role(r.oid, 'pg_write_all_data', 'USAGE') OR pg_has_role(r.oid, 'pg_read_all_data', 'USAGE') \
              OR pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER') OR pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER'))",
    )
    .fetch_all(&pools.su)
    .await
    .unwrap();
    assert!(
        members_of_predefined.is_empty(),
        "a runtime role is a member of pg_read_all_data / pg_write_all_data: {members_of_predefined:?}"
    );
}

/// One statement as the api role in a tenant transaction behind a savepoint that is always rolled back:
/// the rows it touched, or the database's refusal as (SQLSTATE, message, constraint).
async fn app_probe(
    pools: &Pools,
    ws: Uuid,
    sql: String,
) -> Result<u64, (String, String, Option<String>)> {
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SAVEPOINT probe").execute(&mut *conn).await?;
            let outcome = sqlx::query(&sql).execute(&mut *conn).await;
            sqlx::query("ROLLBACK TO SAVEPOINT probe")
                .execute(&mut *conn)
                .await?;
            Ok(outcome.map(|done| done.rows_affected()).map_err(db_error))
        })
    })
    .await
    .expect("probe transaction")
}

/// Every statement must be refused by the table's guard (SQLSTATE 23514, the trigger's or a check's).
async fn assert_guarded(pools: &Pools, ws: Uuid, stage: &str, statements: Vec<(&str, String)>) {
    for (label, sql) in statements {
        match app_probe(pools, ws, sql.clone()).await {
            Err((code, message, _)) => {
                assert_eq!(code, "23514", "{stage}: {label}: `{sql}` → {message}")
            }
            Ok(rows) => panic!("{stage}: {label}: `{sql}` was allowed ({rows} rows)"),
        }
    }
}

/// WA18: the guard trigger lets a token be spent once and then record its attachment once, and refuses
/// every other UPDATE — whoever issues it, here the api role, the only one that may UPDATE the table.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_guard_trigger_lets_a_token_be_spent_once_and_record_once_and_nothing_else() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let other_run = seed_run(su, w.ws, w.channel, w.agent, Some(w.trigger), "running").await;
    let grant = mint(&pools, &w).await.expect("a token");
    let (recorded, other) = (Uuid::new_v4(), Uuid::new_v4());
    let scope = format!("workspace_id = '{}' AND run_id = '{}'", w.ws, w.run);
    let update = |set: &str| format!("UPDATE attachment_write_token SET {set} WHERE {scope}");

    // an unspent row: only `used_at` NULL → value passes (the control), nothing else does
    assert_eq!(
        app_probe(&pools, w.ws, update("used_at = clock_timestamp()")).await,
        Ok(1),
        "the control: spending is allowed"
    );
    assert_guarded(
        &pools,
        w.ws,
        "unspent",
        vec![
            ("slot", update("slot = 2")),
            (
                "lifetime",
                update("expires_at = expires_at + interval '1 minute'"),
            ),
            (
                "created_at",
                update("created_at = created_at - interval '1 second'"),
            ),
            ("run", update(&format!("run_id = '{other_run}'"))),
            ("agent", update(&format!("agent_member_id = '{}'", w.bob))),
            (
                "hash",
                update("token_hash = decode(repeat('ab', 32), 'hex')"),
            ),
            ("used_at stays NULL", update("used_at = NULL")),
            (
                "spend and change the slot",
                update("used_at = clock_timestamp(), slot = 2"),
            ),
            (
                "spend and record at once",
                update(&format!(
                    "used_at = clock_timestamp(), attachment_id = '{other}'"
                )),
            ),
            (
                "record before it is spent",
                update(&format!("attachment_id = '{other}'")),
            ),
        ],
    )
    .await;
    assert!(
        used_at(su, w.ws, &grant.token).await.is_none(),
        "the probes changed nothing"
    );

    // spend it for real
    assert!(redeem(&pools, w.ws, &grant.token).await.is_some());
    let spent = used_at(su, w.ws, &grant.token)
        .await
        .expect("spent by the redeem");

    // a spent row: only `attachment_id` NULL → value passes (the control), nothing else does
    assert_eq!(
        app_probe(
            &pools,
            w.ws,
            update(&format!("attachment_id = '{recorded}'"))
        )
        .await,
        Ok(1),
        "the control: recording the attachment is allowed"
    );
    assert_guarded(
        &pools,
        w.ws,
        "spent",
        vec![
            ("a second spend", update("used_at = clock_timestamp()")),
            ("un-spend", update("used_at = NULL")),
            ("slot", update("slot = 3")),
            (
                "lifetime",
                update("expires_at = expires_at + interval '1 minute'"),
            ),
            ("run", update(&format!("run_id = '{other_run}'"))),
            ("clear nothing", update("attachment_id = NULL")),
            (
                "record and change the slot",
                update(&format!("attachment_id = '{recorded}', slot = 3")),
            ),
        ],
    )
    .await;

    // record it for real, then nothing moves any more
    with_tenant_tx(&pools.app, w.ws, {
        let sql = update(&format!("attachment_id = '{recorded}'"));
        move |conn| {
            Box::pin(async move {
                sqlx::query(&sql).execute(&mut *conn).await?;
                Ok::<(), DbError>(())
            })
        }
    })
    .await
    .expect("record");
    assert_guarded(
        &pools,
        w.ws,
        "recorded",
        vec![
            (
                "record twice",
                update(&format!("attachment_id = '{other}'")),
            ),
            ("clear the record", update("attachment_id = NULL")),
            ("a second spend", update("used_at = clock_timestamp()")),
            ("slot", update("slot = 4")),
        ],
    )
    .await;
    let (final_used, final_record): (Option<DateTime<Utc>>, Option<Uuid>) = sqlx::query_as(
        "SELECT used_at, attachment_id FROM attachment_write_token WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(w.ws)
    .bind(w.run)
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(final_used, Some(spent), "spent once");
    assert_eq!(final_record, Some(recorded), "recorded once");
}

/// A direct INSERT as the superuser with explicit timestamps, for the checks. `Err` carries the
/// database's refusal as (SQLSTATE, message, constraint).
struct TokenRow<'a> {
    ws: Uuid,
    run: Uuid,
    agent: Uuid,
    hash: Vec<u8>,
    slot: i16,
    created_at: &'a str,
    expires_at: &'a str,
    used_at: Option<&'a str>,
    attachment_id: Option<Uuid>,
}

impl TokenRow<'_> {
    async fn insert(&self, su: &PgPool) -> Result<(), (String, String, Option<String>)> {
        sqlx::query(
            "INSERT INTO attachment_write_token \
               (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at, \
                used_at, attachment_id) \
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9)",
        )
        .bind(self.ws)
        .bind(&self.hash)
        .bind(self.run)
        .bind(self.agent)
        .bind(self.slot)
        .bind(self.created_at)
        .bind(self.expires_at)
        .bind(self.used_at)
        .bind(self.attachment_id)
        .execute(su)
        .await
        .map(|_| ())
        .map_err(db_error)
    }
}

/// WA18: the table's own checks and keys, at their edges — each refused row differs from an accepted row
/// by exactly one value.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_checks_and_keys_refuse_what_the_flow_never_writes_and_accept_the_edges() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let run2 = seed_run(su, w.ws, w.channel, w.agent, Some(w.trigger), "running").await;
    let created = "2026-01-01T00:00:00Z";
    let in_a_minute = "2026-01-01T00:01:00Z";
    let hash = || token_hash(&forged_token()).to_vec();
    let row = |run: Uuid, slot: i16| TokenRow {
        ws: w.ws,
        run,
        agent: w.agent,
        hash: hash(),
        slot,
        created_at: created,
        expires_at: in_a_minute,
        used_at: None,
        attachment_id: None,
    };

    // the edges that are accepted: every slot from 1 to 4, a lifetime of exactly ten minutes, a row spent
    // the instant it was created and already recording its attachment
    for slot in 1..=4_i16 {
        row(w.run, slot)
            .insert(su)
            .await
            .unwrap_or_else(|why| panic!("slot {slot} must be accepted: {why:?}"));
    }
    TokenRow {
        expires_at: "2026-01-01T00:10:00Z",
        ..row(run2, 1)
    }
    .insert(su)
    .await
    .unwrap_or_else(|why| panic!("exactly ten minutes must be accepted: {why:?}"));
    TokenRow {
        used_at: Some(created),
        attachment_id: Some(Uuid::new_v4()),
        ..row(run2, 2)
    }
    .insert(su)
    .await
    .unwrap_or_else(|why| panic!("spent at creation with a record must be accepted: {why:?}"));

    // the refusals, each by name
    let run3 = seed_run(su, w.ws, w.channel, w.agent, Some(w.trigger), "running").await;
    let refused: Vec<(&str, TokenRow<'_>, &str)> = vec![
        (
            "a 31-byte hash",
            TokenRow {
                hash: vec![7; 31],
                ..row(run3, 1)
            },
            "attachment_write_token_hash_ck",
        ),
        (
            "a 33-byte hash",
            TokenRow {
                hash: vec![7; 33],
                ..row(run3, 1)
            },
            "attachment_write_token_hash_ck",
        ),
        (
            "an empty hash",
            TokenRow {
                hash: Vec::new(),
                ..row(run3, 1)
            },
            "attachment_write_token_hash_ck",
        ),
        ("slot 0", row(run3, 0), "attachment_write_token_slot_ck"),
        ("slot 5", row(run3, 5), "attachment_write_token_slot_ck"),
        ("slot -1", row(run3, -1), "attachment_write_token_slot_ck"),
        (
            "a lifetime of zero",
            TokenRow {
                expires_at: created,
                ..row(run3, 1)
            },
            "attachment_write_token_ttl_ck",
        ),
        (
            "a negative lifetime",
            TokenRow {
                expires_at: "2025-12-31T23:59:59Z",
                ..row(run3, 1)
            },
            "attachment_write_token_ttl_ck",
        ),
        (
            "ten minutes and a second",
            TokenRow {
                expires_at: "2026-01-01T00:10:01Z",
                ..row(run3, 1)
            },
            "attachment_write_token_ttl_ck",
        ),
        (
            "spent before it was created",
            TokenRow {
                used_at: Some("2025-12-31T23:59:59Z"),
                ..row(run3, 1)
            },
            "attachment_write_token_used_ck",
        ),
        (
            "a recorded attachment on an unspent row",
            TokenRow {
                attachment_id: Some(Uuid::new_v4()),
                ..row(run3, 1)
            },
            "attachment_write_token_attachment_ck",
        ),
        (
            "the second token of a slot (the DB holds the one-picture-per-slot rule)",
            row(w.run, 1),
            "attachment_write_token_run_slot_uniq",
        ),
        (
            "the same token hash again",
            TokenRow {
                hash: token_hash("duplicate-hash-probe").to_vec(),
                ..row(run3, 3)
            },
            "attachment_write_token_pkey",
        ),
    ];
    // the primary-key probe needs its first copy to exist
    TokenRow {
        hash: token_hash("duplicate-hash-probe").to_vec(),
        ..row(run3, 4)
    }
    .insert(su)
    .await
    .unwrap_or_else(|why| panic!("the first copy of the hash must be accepted: {why:?}"));
    for (label, candidate, constraint) in refused {
        let (code, message, named) = candidate
            .insert(su)
            .await
            .expect_err(&format!("{label} must be refused"));
        assert_eq!(
            named.as_deref(),
            Some(constraint),
            "{label}: wrong constraint ({code}: {message})"
        );
    }

    // foreign keys: a run or a workspace that does not exist
    let (code, message, _) = TokenRow {
        run: Uuid::new_v4(),
        ..row(run3, 1)
    }
    .insert(su)
    .await
    .expect_err("an unknown run");
    assert_eq!(code, "23503", "{message}");
    let (code, message, _) = TokenRow {
        ws: Uuid::new_v4(),
        ..row(run3, 1)
    }
    .insert(su)
    .await
    .expect_err("an unknown workspace");
    assert_eq!(code, "23503", "{message}");
}

/// WA14 / WA18: RLS is enabled AND forced with the workspace policy; the non-bypass role sees nothing
/// without a bound workspace, only its own workspace's rows with one, and cannot spend another
/// workspace's token.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn rls_is_forced_and_scopes_the_api_role_to_the_workspace_it_is_bound_to() {
    let pools = pools().await;
    let su = &pools.su;
    let (enabled, forced, policies): (bool, bool, i64) = sqlx::query_as(
        "SELECT c.relrowsecurity, c.relforcerowsecurity, \
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'ws_isolation') \
           FROM pg_class c WHERE c.relname = 'attachment_write_token' AND c.relkind = 'r'",
    )
    .fetch_one(su)
    .await
    .unwrap();
    assert!(enabled && forced, "RLS must be enabled and FORCEd");
    assert_eq!(policies, 1, "the ws_isolation policy");

    let one = seed_world(su).await;
    let two = seed_world(su).await;
    let grant_one = mint(&pools, &one).await.expect("token one");
    mint(&pools, &two).await.expect("token two");
    let all: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_write_token")
        .fetch_one(su)
        .await
        .unwrap();
    assert!(all >= 2, "the superuser sees every workspace's rows");

    // no workspace bound: the api role sees no row at all
    let unbound: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_write_token")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert_eq!(unbound, 0, "without app.workspace_id the table is empty");

    // bound to one workspace: only its rows
    let ws = one.ws;
    let visible: Vec<Uuid> = with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT DISTINCT workspace_id FROM attachment_write_token")
                    .fetch_all(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, vec![one.ws]);

    // bound to the other one, an UPDATE aimed at the first workspace's row touches nothing
    let touched = app_probe(
        &pools,
        two.ws,
        format!(
            "UPDATE attachment_write_token SET used_at = clock_timestamp() WHERE workspace_id = '{}'",
            one.ws
        ),
    )
    .await;
    assert_eq!(
        touched,
        Ok(0),
        "another workspace's row is invisible to the UPDATE"
    );
    assert!(
        used_at(su, one.ws, &grant_one.token).await.is_none(),
        "and still unspent"
    );
}

/// The lockdown comment's claim: the worker holds no DELETE on the token table, yet deleting a parent run
/// still clears its tokens (the foreign-key cascade runs as the table's owner) — as the superuser and as the
/// worker's own role, which is the point of #5530: a count read from THIS table would shrink whenever a
/// worker that may delete runs (it holds DELETE on `agent_run` like on every ordinary table) deletes one.
/// That is why the daily ceiling counts `agent_picture_mark`, which nothing cascades into (see
/// `a_worker_compromised_at_the_database_level_cannot_make_todays_count_smaller`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_parent_run_delete_clears_the_tokens_though_the_deleting_role_holds_no_delete_on_them() {
    let pools = pools().await;
    let su = &pools.su;
    for by_worker in [false, true] {
        let w = seed_world(su).await;
        mint(&pools, &w).await.expect("a token");
        assert_eq!(token_rows(su, w.ws).await, 1);
        if by_worker {
            let denied = sqlx::query("DELETE FROM attachment_write_token WHERE workspace_id = $1")
                .bind(w.ws)
                .execute(&pools.worker)
                .await
                .expect_err("the worker holds no DELETE on the token table");
            assert_eq!(db_error(denied).0, "42501");
            sqlx::query("DELETE FROM agent_run WHERE id = $1")
                .bind(w.run)
                .execute(&pools.worker)
                .await
                .expect("momo_worker deletes the run");
        } else {
            sqlx::query("DELETE FROM agent_run WHERE id = $1")
                .bind(w.run)
                .execute(su)
                .await
                .unwrap();
        }
        assert_eq!(
            token_rows(su, w.ws).await,
            0,
            "the cascade cleared the token (deleted by {})",
            if by_worker {
                "momo_worker"
            } else {
                "the superuser"
            }
        );
    }
}

// =================================================================================================
// G. cleanup
// =================================================================================================

/// A token row that expired `ago` ago (an interval string), written directly.
async fn forge_expired(su: &PgPool, w: &World, slot: i16, ago: &str) {
    sqlx::query(
        "INSERT INTO attachment_write_token \
           (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, clock_timestamp() - $6::interval - interval '5 minutes', \
                 clock_timestamp() - $6::interval)",
    )
    .bind(w.ws)
    .bind(token_hash(&forged_token()).to_vec())
    .bind(w.run)
    .bind(w.agent)
    .bind(slot)
    .bind(ago)
    .execute(su)
    .await
    .expect("expired token row");
}

async fn slots_of(su: &PgPool, ws: Uuid) -> Vec<i16> {
    sqlx::query_scalar(
        "SELECT slot FROM attachment_write_token WHERE workspace_id = $1 ORDER BY slot",
    )
    .bind(ws)
    .fetch_all(su)
    .await
    .unwrap()
}

/// WA21, #5530: the sweep is the api's, inside the spend. A mint (the worker) drops nothing — it holds no
/// DELETE any more. A spend in one workspace drops that workspace's token rows that expired more than a day
/// ago and its mark rows older than 48 hours (twice the counting window), keeps the tokens that expired less
/// than a day ago and the ones still alive, keeps every mark a count can still see AND the ones between 24
/// and 48 hours, and leaves another workspace's old rows alone.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_spend_sweeps_only_its_own_workspaces_old_rows_and_a_mint_sweeps_nothing() {
    let pools = pools().await;
    let su = &pools.su;
    let one = seed_world(su).await;
    let two = seed_world(su).await;
    let mut marks_of: Vec<(Uuid, Vec<Uuid>)> = Vec::new();
    for tenant in [&one, &two] {
        forge_expired(su, tenant, 2, "25 hours").await; // a spend in its own workspace drops it
        forge_expired(su, tenant, 3, "23 hours").await; // expired, but within the day: stays
        sqlx::query(
            "INSERT INTO attachment_write_token \
               (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
             VALUES ($1, $2, $3, $4, 4, clock_timestamp() - interval '1 minute', \
                     clock_timestamp() + interval '5 minutes')",
        )
        .bind(tenant.ws)
        .bind(token_hash(&forged_token()).to_vec())
        .bind(tenant.run)
        .bind(tenant.agent)
        .execute(su)
        .await
        .unwrap(); // still alive: stays
        let mut marks = Vec::new();
        for age in [
            "1 hour",
            "23 hours",
            "25 hours",
            "47 hours",
            "49 hours",
            "100 hours",
        ] {
            marks.push(seed_mark(su, tenant.ws, age).await);
        }
        marks_of.push((tenant.ws, marks));
    }
    assert_eq!(slots_of(su, one.ws).await, vec![2, 3, 4]);

    // the mint sweeps nothing (and its INSERT still works without a DELETE privilege)
    let grant = mint(&pools, &one).await.expect("a token");
    assert_eq!(
        slots_of(su, one.ws).await,
        vec![1, 2, 3, 4],
        "the day-old row is still there after a mint: the worker does not sweep"
    );
    assert_eq!(mark_rows(su, one.ws).await, 6, "and no mark was touched");

    // the api's spend does
    redeem(&pools, one.ws, &grant.token)
        .await
        .expect("a target");
    assert_eq!(
        slots_of(su, one.ws).await,
        vec![1, 3, 4],
        "the spend dropped the day-old row; the spent row and the others stay"
    );
    let (ws_one, marks_one) = &marks_of[0];
    let left: Vec<Uuid> = sqlx::query_scalar(
        "SELECT attachment_id FROM agent_picture_mark WHERE workspace_id = $1 ORDER BY written_at DESC",
    )
    .bind(ws_one)
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(
        left,
        marks_one[..4].to_vec(),
        "marks of 1, 23, 25 and 47 hours stay (a count sees the first two, the sweep waits 48 hours); \
         the 49- and 100-hour marks went"
    );
    assert_eq!(
        slots_of(su, two.ws).await,
        vec![2, 3, 4],
        "another workspace's rows, the old one included, are not touched by the sweep"
    );
    assert_eq!(mark_rows(su, two.ws).await, 6, "and neither are its marks");
}

// =================================================================================================
// H. one predicate, three calls
// =================================================================================================

/// WA23: for each breakage, the mint, the redeem and the row write all refuse — each on a fresh tenant,
/// so each cell stands alone. If the predicate were two functions, a breakage one of them forgot would
/// show as a single red cell here.
///
/// The failure message names every red cell ("mint after X", "redeem after X", "write after X"). One
/// nuance for whoever sabotages: the spend statement in `redeem_in_tx` carries its own copy of the
/// run-state check, so deleting the status condition from the binding function alone turns the six run-state
/// cells of the mint and the write red and leaves the six `redeem` cells green.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn mint_redeem_and_write_refuse_the_same_breakages() {
    let pools = pools().await;
    let su = &pools.su;
    let mut red: Vec<String> = Vec::new();

    // the control: a healthy tenant passes all three
    let w = seed_world(su).await;
    let grant = mint(&pools, &w).await.expect("the healthy mint");
    let target = redeem(&pools, w.ws, &grant.token)
        .await
        .expect("the healthy redeem");
    write(
        &pools,
        w.ws,
        target,
        stored_png(&target),
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
    .expect("transaction")
    .expect("the healthy write");

    for fault in BREAKS {
        // mint: the breakage is already there
        let w = seed_world(su).await;
        apply(su, &w, fault).await;
        if !mint_wrote_nothing(&pools, w.ws, w.run, w.agent).await {
            red.push(format!("mint after {fault:?}"));
        }

        // redeem: the breakage comes after the mint
        let w = seed_world(su).await;
        match mint(&pools, &w).await {
            None => red.push(format!("redeem after {fault:?}: the healthy mint refused")),
            Some(grant) => {
                apply(su, &w, fault).await;
                if redeem(&pools, w.ws, &grant.token).await.is_some() {
                    red.push(format!("redeem after {fault:?}"));
                }
            }
        }

        // write: the breakage comes after the redeem
        if let Err(why) = write_refused_after(&pools, fault).await {
            red.push(format!("write after {fault:?}: {why}"));
        }
    }
    assert!(
        red.is_empty(),
        "a breakage that one of the three calls did not refuse (they must share ONE predicate): {red:?}"
    );
}

// =================================================================================================
// I. the daily count a compromised worker cannot make smaller (#5530)
// =================================================================================================

/// A second in-flight run for `w`'s agent in `w`'s channel (the first is spent: one picture per run).
async fn another_run(su: &PgPool, w: &World) -> Uuid {
    let trigger = seed_message(su, w.ws, w.channel, w.alice).await;
    seed_run(su, w.ws, w.channel, w.agent, Some(trigger), "running").await
}

/// A whole new healthy world INSIDE an existing workspace: two people, an agent, a channel, a request and a
/// running run. Made by the superuser, so a test can create it AFTER the worker has deleted what it likes.
async fn seed_world_in(su: &PgPool, ws: Uuid) -> World {
    let alice = seed_member(su, ws, "human").await;
    let bob = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    let channel = seed_channel(su, ws, alice, &[alice, bob, agent]).await;
    let trigger = seed_message(su, ws, channel, alice).await;
    let run = seed_run(su, ws, channel, agent, Some(trigger), "running").await;
    World {
        ws,
        alice,
        bob,
        agent,
        channel,
        trigger,
        run,
    }
}

/// Is today's count in `ws` still at least `n`? It asks the **api's own function**, not a query of the
/// test's: a fresh healthy run in the same workspace (created after whatever the worker did, so nothing the
/// worker deleted is needed), minted by the worker, spent and written by the api under a ceiling of `n`.
/// `CapReached` is "the count is still at least `n`"; a write that goes through means it fell below. (With
/// the old source, the agent's `complete` attachment rows, every attack below turns this `false`.)
async fn count_is_still_at_least(pools: &Pools, ws: Uuid, n: i64) -> bool {
    let probe = seed_world_in(&pools.su, ws).await;
    let grant = mint_for(pools, ws, probe.run, probe.agent)
        .await
        .expect("the probe's token");
    let target = redeem(pools, ws, &grant.token)
        .await
        .expect("the probe's target");
    match write(pools, ws, target, stored_png(&target), n).await {
        Ok(Err(PictureWriteRefused::CapReached)) => true,
        Ok(Ok(_)) => false,
        other => panic!("the probe was neither written nor capped: {other:?}"),
    }
}

/// A statement as the worker's own login role: the rows it touched, or the database's refusal as
/// (SQLSTATE, message). `via_role` runs it after `SET LOCAL ROLE` — the roles the worker may SET to.
async fn as_worker(
    pools: &Pools,
    via_role: Option<&str>,
    sql: &str,
) -> Result<u64, (String, String)> {
    let mut tx = pools.worker.begin().await.expect("a worker transaction");
    if let Some(role) = via_role {
        sqlx::query(&format!("SET LOCAL ROLE {role}"))
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|error| panic!("the worker may SET ROLE {role}: {error}"));
    }
    let outcome = sqlx::query(sql)
        .execute(&mut *tx)
        .await
        .map(|done| done.rows_affected());
    match outcome {
        Ok(rows) => {
            tx.commit().await.expect("commit");
            Ok(rows)
        }
        Err(error) => {
            let (code, message, _) = db_error(error);
            let _ = tx.rollback().await;
            Err((code, message))
        }
    }
}

/// Everything a worker compromised at the database level could try in order to make **today's count**
/// smaller, each in its own workspace that already holds two pictures the api wrote. The worker holds
/// SELECT/INSERT/UPDATE/DELETE on every ordinary table (`attachment`, `member`, `channel`, `agent_run`,
/// `workspace`…) and that is the whole problem with counting from them: the attempts that the database
/// allows are listed as allowed on purpose, and the count must be unmoved anyway, measured by the api's own
/// function (`count_is_still_at_least`) and by the mark rows themselves. The attempts on the mark and token
/// tables are refused by privilege. Sabotage: count from `attachment` again (rows 1–7 go red), count from
/// the token table (rows 5–7 go red), give the worker DELETE or any verb on the mark table (rows 9–12 go
/// red), give the mark table a foreign key (rows 5–7 go red).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_worker_compromised_at_the_database_level_cannot_make_todays_count_smaller() {
    const PICTURES: i64 = 2;
    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Outcome {
        /// the database lets the worker do it: the count must not care
        Allowed,
        /// refused by privilege (42501)
        Denied,
    }
    struct Attempt {
        label: &'static str,
        via_role: Option<&'static str>,
        statements: Vec<String>,
        /// what the FIRST statement must do (the later ones put the world back as a smarter attacker would)
        outcome: Outcome,
    }
    let pools = pools().await;
    let su = &pools.su;

    let attempts = |w: &World| -> Vec<Attempt> {
        let ws = w.ws;
        vec![
            Attempt {
                label: "1 UPDATE attachment.created_at back a day",
                via_role: None,
                statements: vec![format!(
                    "UPDATE attachment SET created_at = created_at - interval '25 hours' WHERE workspace_id = '{ws}'"
                )],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "2 UPDATE attachment.status away from complete",
                via_role: None,
                statements: vec![format!(
                    "UPDATE attachment SET status = 'failed' WHERE workspace_id = '{ws}'"
                )],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "3 DELETE the attachment rows",
                via_role: None,
                statements: vec![format!("DELETE FROM attachment WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "4 UPDATE the agent's member.kind to human",
                via_role: None,
                statements: vec![format!(
                    "UPDATE member SET kind = 'human' WHERE workspace_id = '{ws}' AND id = '{}'",
                    w.agent
                )],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "5 DELETE the channel (the cascade takes attachments, runs and tokens with it)",
                via_role: None,
                statements: vec![format!("DELETE FROM channel WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "6 DELETE the runs (the cascade takes the tokens)",
                via_role: None,
                statements: vec![format!("DELETE FROM agent_run WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "7 DELETE the workspace and create it again under the same id",
                via_role: None,
                statements: vec![
                    format!("DELETE FROM workspace WHERE id = '{ws}'"),
                    format!("INSERT INTO workspace(id, slug, name) VALUES ('{ws}', 'again-{ws}', 'again')"),
                ],
                outcome: Outcome::Allowed,
            },
            Attempt {
                label: "8 DELETE the spent token rows",
                via_role: None,
                statements: vec![format!(
                    "DELETE FROM attachment_write_token WHERE workspace_id = '{ws}'"
                )],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "9 DELETE the mark rows",
                via_role: None,
                statements: vec![format!("DELETE FROM agent_picture_mark WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "10 UPDATE the mark rows' written_at back a day",
                via_role: None,
                statements: vec![format!(
                    "UPDATE agent_picture_mark SET written_at = written_at - interval '25 hours' WHERE workspace_id = '{ws}'"
                )],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "11 TRUNCATE the mark table",
                via_role: None,
                statements: vec!["TRUNCATE agent_picture_mark".to_string()],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "12 TRUNCATE the token table",
                via_role: None,
                statements: vec!["TRUNCATE attachment_write_token".to_string()],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "13 UPDATE a spent token's used_at back to NULL",
                via_role: None,
                statements: vec![format!(
                    "UPDATE attachment_write_token SET used_at = NULL WHERE workspace_id = '{ws}'"
                )],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "14 DELETE the mark rows after SET ROLE momo_helper_read",
                via_role: Some("momo_helper_read"),
                statements: vec![format!("DELETE FROM agent_picture_mark WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Denied,
            },
            Attempt {
                label: "15 DELETE the mark rows after SET ROLE momo_memory",
                via_role: Some("momo_memory"),
                statements: vec![format!("DELETE FROM agent_picture_mark WHERE workspace_id = '{ws}'")],
                outcome: Outcome::Denied,
            },
        ]
    };

    // the list is the same for every world: count it on a throwaway
    let rows = attempts(&seed_world(su).await).len();
    assert_eq!(rows, 15, "the table in the doc comment names these rows");

    let mut failures: Vec<String> = Vec::new();
    for index in 0..rows {
        let w = seed_world(su).await;
        // two pictures the api really wrote: two runs, each minted, spent and written
        picture_of(&pools, w.ws, w.run, w.agent).await;
        let second = another_run(su, &w).await;
        picture_of(&pools, w.ws, second, w.agent).await;
        assert_eq!(mark_rows(su, w.ws).await, PICTURES, "two marks to start");
        assert!(
            count_is_still_at_least(&pools, w.ws, PICTURES).await,
            "the control: at a ceiling of {PICTURES} the api refuses a third picture"
        );

        let attempt = attempts(&w).swap_remove(index);
        let mut first = true;
        for sql in &attempt.statements {
            let result = as_worker(&pools, attempt.via_role, sql).await;
            if first {
                first = false;
                match (&result, attempt.outcome) {
                    (Ok(rows), Outcome::Allowed) if *rows >= 1 => {}
                    (Err((code, message)), Outcome::Denied)
                        if code == "42501" && message.contains("permission denied") => {}
                    (got, want) => failures.push(format!(
                        "{}: the first statement should be {want:?}, was {got:?}",
                        attempt.label
                    )),
                }
            }
        }
        // the count did not move: through the api's own function and in the table itself
        if mark_rows(su, w.ws).await != PICTURES {
            failures.push(format!("{}: the mark rows moved", attempt.label));
        }
        if !count_is_still_at_least(&pools, w.ws, PICTURES).await {
            failures.push(format!(
                "{}: the api's count fell below {PICTURES}",
                attempt.label
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "the worker shrank today's count, or an attempt did not behave as written:\n{}",
        failures.join("\n")
    );
}

/// The mark table's trigger, on its own, whoever asks: UPDATE is refused outright (23514 — the superuser
/// reaches the trigger because it holds the privilege; the api role never does), and DELETE is refused for
/// any row inside the 24-hour window and allowed for one outside it (the window of the api's count). Margins
/// of a minute, not exact boundaries. Sabotage: delete the trigger's DELETE branch (the in-window rows go),
/// its UPDATE branch (the first assertion goes), or make the window 0 (the 23-hour row goes).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_mark_table_refuses_every_update_and_every_delete_inside_the_window_whoever_asks() {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    let fresh = seed_mark(su, w.ws, "1 minute").await;
    let inside = seed_mark(su, w.ws, "23 hours 59 minutes").await;
    let outside = seed_mark(su, w.ws, "24 hours 1 minute").await;
    assert_eq!(mark_rows(su, w.ws).await, 3);

    // UPDATE: the superuser holds the privilege, so the trigger is what answers
    let update = sqlx::query("UPDATE agent_picture_mark SET written_at = written_at - interval '30 hours' WHERE workspace_id = $1")
        .bind(w.ws)
        .execute(su)
        .await
        .expect_err("a mark row is never updated");
    let (code, message, _) = db_error(update);
    assert_eq!(code, "23514", "{message}");
    assert!(message.contains("append-only"), "{message}");
    // and the api role has no UPDATE privilege to begin with
    let by_app = app_probe(
        &pools,
        w.ws,
        format!(
            "UPDATE agent_picture_mark SET run_id = run_id WHERE workspace_id = '{}'",
            w.ws
        ),
    )
    .await;
    assert_eq!(
        by_app.map_err(|(code, _, _)| code),
        Err("42501".to_string())
    );

    // DELETE as the api role, row by row, inside a savepoint that is rolled back each time
    for (label, attachment, refused) in [
        ("a minute old", fresh, true),
        ("23 h 59 min old", inside, true),
        ("24 h 1 min old", outside, false),
    ] {
        let outcome = app_probe(
            &pools,
            w.ws,
            format!(
                "DELETE FROM agent_picture_mark WHERE workspace_id = '{}' AND attachment_id = '{attachment}'",
                w.ws
            ),
        )
        .await;
        if refused {
            let (code, message, _) = outcome.expect_err(label);
            assert_eq!(code, "23514", "{label}: {message}");
            assert!(message.contains("counting window"), "{label}: {message}");
        } else {
            assert_eq!(outcome, Ok(1), "{label}: a row no count can see may go");
        }
    }
    // the superuser is held to the same window
    let swept_by_su = sqlx::query("DELETE FROM agent_picture_mark WHERE workspace_id = $1 AND written_at > clock_timestamp() - interval '24 hours'")
        .bind(w.ws)
        .execute(su)
        .await
        .expect_err("not even the owner deletes a row inside the window");
    assert_eq!(db_error(swept_by_su).0, "23514");
    assert_eq!(
        mark_rows(su, w.ws).await,
        3,
        "every probe was rolled back or refused"
    );
}

/// The sweep's OWN window, with the trigger taken out of the way: the superuser runs the api's spend with
/// `session_replication_role = replica` (triggers off), so the only thing between the marks and the sweep is
/// the number in the code. Marks inside 48 hours stay (the ones inside 24 hours are what the count sees;
/// the rest wait out the second window), older ones go. Sabotage: `MARK_SWEEP_AFTER_SECS` to 0 (every mark
/// goes, the count's own rows included — with the trigger on, the spend would fail instead; see the
/// trigger's test).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_sweeps_own_window_keeps_everything_a_count_can_see_even_with_the_trigger_out_of_the_way(
) {
    let pools = pools().await;
    let su = &pools.su;
    let w = seed_world(su).await;
    for age in [
        "1 minute",
        "12 hours",
        "23 hours 59 minutes",
        "30 hours",
        "47 hours",
        "49 hours",
        "200 hours",
    ] {
        seed_mark(su, w.ws, age).await;
    }
    let grant = mint(&pools, &w).await.expect("a token");
    let (ws, token) = (w.ws, grant.token.clone());
    let target = with_tenant_tx(&pools.su, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("SET LOCAL session_replication_role = 'replica'")
                .execute(&mut *conn)
                .await?;
            redeem_agent_picture_in_tx(conn, ws, &token).await
        })
    })
    .await
    .expect("the spend with triggers off");
    assert!(target.is_some(), "the control: the spend went through");
    let left: Vec<f64> = sqlx::query_scalar(
        "SELECT (extract(epoch FROM clock_timestamp() - written_at) / 3600.0)::float8 \
           FROM agent_picture_mark WHERE workspace_id = $1 ORDER BY written_at DESC",
    )
    .bind(w.ws)
    .fetch_all(su)
    .await
    .unwrap();
    let hours: Vec<i64> = left.iter().map(|h| h.round() as i64).collect();
    assert_eq!(
        hours,
        vec![0, 12, 24, 30, 47],
        "the marks of 0, 12, 24 (23 h 59 min), 30 and 47 hours stay; 49 and 200 hours went"
    );
}

/// The shape of the mark table, from the catalog: no foreign key to it or from it (a cascade runs as the
/// table's owner — every parent it could point at is a table the worker may delete from), the key is
/// (workspace, attachment), and RLS is enabled, forced and scoped by the workspace policy. Sabotage: add a
/// `REFERENCES` to the table (the first assertion), drop FORCE (the second).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_mark_table_has_no_foreign_key_in_either_direction_and_rls_is_forced() {
    let pools = pools().await;
    let su = &pools.su;
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT conname::text FROM pg_constraint \
          WHERE contype = 'f' \
            AND (conrelid = 'public.agent_picture_mark'::regclass \
              OR confrelid = 'public.agent_picture_mark'::regclass)",
    )
    .fetch_all(su)
    .await
    .unwrap();
    assert!(
        keys.is_empty(),
        "a foreign key on or to agent_picture_mark would let a cascade clear the count: {keys:?}"
    );
    let primary: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname::text FROM pg_index i \
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) \
          WHERE i.indrelid = 'public.agent_picture_mark'::regclass AND i.indisprimary \
          ORDER BY array_position(i.indkey::int2[], a.attnum)",
    )
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(primary, vec!["workspace_id", "attachment_id"]);
    let (enabled, forced, policies): (bool, bool, i64) = sqlx::query_as(
        "SELECT c.relrowsecurity, c.relforcerowsecurity, \
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'ws_isolation') \
           FROM pg_class c WHERE c.relname = 'agent_picture_mark' AND c.relkind = 'r'",
    )
    .fetch_one(su)
    .await
    .unwrap();
    assert!(enabled && forced, "RLS must be enabled and FORCEd");
    assert_eq!(policies, 1, "the ws_isolation policy");

    // the api role sees only the workspace it is bound to
    let one = seed_world(su).await;
    let two = seed_world(su).await;
    seed_mark(su, one.ws, "1 hour").await;
    seed_mark(su, two.ws, "1 hour").await;
    let unbound: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_picture_mark")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert_eq!(unbound, 0, "without app.workspace_id the table is empty");
    let ws = one.ws;
    let visible: Vec<Uuid> = with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT DISTINCT workspace_id FROM agent_picture_mark")
                    .fetch_all(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, vec![one.ws]);
}
