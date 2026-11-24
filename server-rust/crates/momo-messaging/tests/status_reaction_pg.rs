//! #6067 — the agent status reactions against a real PG18 (ADR-0200 증보 8).
//!
//! `DATABASE_URL` is a disposable superuser URL; the harness applies every migration and
//! `bootstrap_roles.sql`. Every write under test runs as `momo_app` (`rolbypassrls = false`) in a
//! tenant transaction — the api's and the request's shape. The run's own status change is written
//! in the same transaction right before the module is called, as the call sites do.
//!
//! | test | acceptance |
//! |---|---|
//! | `a_succeeded_run_ends_with_one_check_and_no_eye` | LA1 ①, LA2, LA3, LA8 |
//! | `every_other_end_leaves_no_eye_and_no_check` | LA1 ② ③ ④, LA2 |
//! | `a_queued_run_has_no_eye_and_the_fourth_take_adds_none` | LA4 |
//! | `the_switch_closes_adding_but_never_removing` | LA5 |
//! | `the_follow_up_removal_takes_the_notifiers_leftovers_in_its_own_tenant_only` | LA1 ⑤ ⑥, LA10, LA13 |
//! | `a_refused_reaction_never_holds_the_run` | LA6, LA7, LA9 |
//!
//! LA12 (the notifier holds no `reaction` privilege) is the runtime-role grant test
//! `scripts/tests/test_notifier_role_grants.sh` — this harness applies the development bootstrap.
//!
//! Run: `DATABASE_URL=… cargo test -p momo-messaging --test status_reaction_pg -- --ignored --test-threads=1`

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::status_reaction::{
    on_run_released_in_tx, on_run_taken_in_tx, on_run_terminal_in_tx, sweep_settled_eyes_in_tx,
    StatusReactionOutcome, STATUS_CHECK, STATUS_EYE,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

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
    Pools { su, app }
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
    .bind(format!("status-reaction:{run}"))
    .execute(su)
    .await
    .expect("run");
    run
}

#[derive(Clone, Copy)]
struct World {
    ws: Uuid,
    alice: Uuid,
    agent: Uuid,
    channel: Uuid,
    trigger: Uuid,
    run: Uuid,
}

async fn seed_agent_row(su: &PgPool, ws: Uuid, agent: Uuid) {
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url) VALUES ($1, $2, 'm', 'http://agent.invalid')",
    )
    .bind(agent)
    .bind(ws)
    .execute(su)
    .await
    .expect("agent row");
}

async fn world(su: &PgPool, status: &str) -> World {
    let ws = seed_workspace(su).await;
    let alice = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    seed_agent_row(su, ws, agent).await;
    let channel = seed_channel(su, ws, alice, &[alice, agent]).await;
    let trigger = seed_message(su, ws, channel, alice).await;
    let run = seed_run(su, ws, channel, agent, Some(trigger), status).await;
    World {
        ws,
        alice,
        agent,
        channel,
        trigger,
        run,
    }
}

/// Write the run's status (as the caller would) and call `step` in the same momo_app tenant tx.
async fn step(
    app: &PgPool,
    w: World,
    run: Uuid,
    status: &str,
    call: &'static str,
) -> StatusReactionOutcome {
    let ws = w.ws;
    let status = status.to_string();
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("UPDATE agent_run SET status = $2::run_status WHERE id = $1")
                .bind(run)
                .bind(&status)
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?;
            match call {
                "take" => on_run_taken_in_tx(conn, ws, run).await,
                "release" => on_run_released_in_tx(conn, ws, run).await,
                _ => on_run_terminal_in_tx(conn, ws, run).await,
            }
        })
    })
    .await
    .expect("tenant tx")
}

async fn count_reaction(su: &PgPool, message: Uuid, member: Uuid, emoji: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM reaction WHERE message_id=$1 AND member_id=$2 AND emoji=$3",
    )
    .bind(message)
    .bind(member)
    .bind(emoji)
    .fetch_one(su)
    .await
    .expect("count reaction")
}

async fn frames(su: &PgPool, ws: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1           AND (payload::text LIKE '%reaction.added%' OR payload::text LIKE '%reaction.removed%')",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .expect("frames")
}

async fn set_workspace_switch(su: &PgPool, ws: Uuid, value: serde_json::Value) {
    sqlx::query("UPDATE workspace SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{agent_reactions}', $2) WHERE id=$1")
        .bind(ws)
        .bind(value)
        .execute(su)
        .await
        .expect("switch");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_succeeded_run_ends_with_one_check_and_no_eye() {
    let p = pools().await;
    let w = world(&p.su, "queued").await;
    let before: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='push_candidate'),                 (SELECT count(*) FROM inbox_item WHERE workspace_id=$1),                 (SELECT last_seq FROM channel_seq WHERE channel_id=$2)",
    )
    .bind(w.ws)
    .bind(w.channel)
    .fetch_one(&p.su)
    .await
    .expect("before");
    assert!(step(&p.app, w, w.run, "running", "take").await.eye_added);
    assert_eq!(
        count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
        1
    );
    let out = step(&p.app, w, w.run, "succeeded", "terminal").await;
    assert!(out.eye_removed && out.check_added, "{out:?}");
    // A replayed completion adds nothing.
    let again = step(&p.app, w, w.run, "succeeded", "terminal").await;
    assert!(!again.check_added && !again.eye_removed);
    assert_eq!(
        count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
        0
    );
    assert_eq!(
        count_reaction(&p.su, w.trigger, w.agent, STATUS_CHECK).await,
        1
    );
    let after: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='push_candidate'),                 (SELECT count(*) FROM inbox_item WHERE workspace_id=$1),                 (SELECT last_seq FROM channel_seq WHERE channel_id=$2)",
    )
    .bind(w.ws)
    .bind(w.channel)
    .fetch_one(&p.su)
    .await
    .expect("after");
    assert_eq!(
        before, after,
        "LA3: push candidates, inbox rows and the channel seq stay"
    );
    assert_eq!(
        frames(&p.su, w.ws).await,
        3,
        "add eye, remove eye, add check"
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND run_id=$2           AND action LIKE 'reaction.%' AND detail->>'derived' = 'run_lifecycle'",
    )
    .bind(w.ws)
    .bind(w.run)
    .fetch_one(&p.su)
    .await
    .expect("audit");
    assert_eq!(
        audited, 3,
        "LA8: one audit row per change, derived + run_id"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn every_other_end_leaves_no_eye_and_no_check() {
    let p = pools().await;
    for end in ["failed", "cancelled", "timed_out"] {
        let w = world(&p.su, "queued").await;
        assert!(
            step(&p.app, w, w.run, "running", "take").await.eye_added,
            "{end}"
        );
        let out = step(&p.app, w, w.run, end, "terminal").await;
        assert!(out.eye_removed && !out.check_added, "{end}: {out:?}");
        assert_eq!(
            count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
            0,
            "{end}"
        );
        assert_eq!(
            count_reaction(&p.su, w.trigger, w.agent, STATUS_CHECK).await,
            0,
            "{end}"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_queued_run_has_no_eye_and_the_fourth_take_adds_none() {
    let p = pools().await;
    let w = world(&p.su, "queued").await;
    // Queued and not leased: not taken, no eye.
    assert!(!step(&p.app, w, w.run, "queued", "take").await.eye_added);
    assert_eq!(
        count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
        0
    );
    for take in 1..=4 {
        let took = step(&p.app, w, w.run, "running", "take").await;
        assert!(
            !took.rolled_back,
            "take {take}: the cap is the predicate, not a CHECK error"
        );
        let added = took.eye_added;
        let eyes = count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await;
        if take <= 3 {
            assert!(added && eyes == 1, "take {take}");
        } else {
            assert!(!added && eyes == 0, "take {take}: the cap");
        }
        // Handed back: queued again, the eye comes off.
        step(&p.app, w, w.run, "queued", "release").await;
        assert_eq!(
            count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
            0,
            "release {take}"
        );
    }
    step(&p.app, w, w.run, "running", "take").await;
    step(&p.app, w, w.run, "succeeded", "terminal").await;
    assert!(
        frames(&p.su, w.ws).await <= 7,
        "LA4: at most seven status frames a run"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_switch_closes_adding_but_never_removing() {
    let p = pools().await;
    // Workspace off: no eye.
    let w = world(&p.su, "queued").await;
    set_workspace_switch(&p.su, w.ws, serde_json::json!("off")).await;
    assert!(!step(&p.app, w, w.run, "running", "take").await.eye_added);
    // A word outside the three reads as off.
    let w2 = world(&p.su, "queued").await;
    set_workspace_switch(&p.su, w2.ws, serde_json::json!(true)).await;
    assert!(!step(&p.app, w2, w2.run, "running", "take").await.eye_added);
    // Turned off mid-run: the end still removes the eye, adds no check.
    let w3 = world(&p.su, "queued").await;
    assert!(step(&p.app, w3, w3.run, "running", "take").await.eye_added);
    set_workspace_switch(&p.su, w3.ws, serde_json::json!("off")).await;
    let out = step(&p.app, w3, w3.run, "succeeded", "terminal").await;
    assert!(out.eye_removed && !out.check_added, "{out:?}");
    // An agent value wider than the workspace's is read narrowed; narrower wins.
    let w4 = world(&p.su, "queued").await;
    sqlx::query("UPDATE agent SET agent_reactions='off' WHERE member_id=$1")
        .bind(w4.agent)
        .execute(&p.su)
        .await
        .expect("agent off");
    assert!(!step(&p.app, w4, w4.run, "running", "take").await.eye_added);
    let w5 = world(&p.su, "queued").await;
    set_workspace_switch(&p.su, w5.ws, serde_json::json!("off")).await;
    sqlx::query("UPDATE agent SET agent_reactions='free' WHERE member_id=$1")
        .bind(w5.agent)
        .execute(&p.su)
        .await
        .expect("agent free");
    assert!(!step(&p.app, w5, w5.run, "running", "take").await.eye_added);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn the_follow_up_removal_takes_the_notifiers_leftovers_in_its_own_tenant_only() {
    let p = pools().await;
    let a = world(&p.su, "queued").await;
    let b = world(&p.su, "queued").await;
    for w in [a, b] {
        assert!(step(&p.app, w, w.run, "running", "take").await.eye_added);
        // The notifier's end: a status write with no reaction write (superuser stands in for it).
        sqlx::query("UPDATE agent_run SET status='timed_out', finished_at=now() WHERE id=$1")
            .bind(w.run)
            .execute(&p.su)
            .await
            .expect("notifier end");
        assert_eq!(
            count_reaction(&p.su, w.trigger, w.agent, STATUS_EYE).await,
            1
        );
    }
    // The same-tx end of one run keeps the eye while another run of the pair is taken (LA10).
    let pair = world(&p.su, "queued").await;
    assert!(
        step(&p.app, pair, pair.run, "running", "take")
            .await
            .eye_added
    );
    let other = seed_run(
        &p.su,
        pair.ws,
        pair.channel,
        pair.agent,
        Some(pair.trigger),
        "running",
    )
    .await;
    let out = step(&p.app, pair, pair.run, "failed", "terminal").await;
    assert!(!out.eye_removed, "LA10: {out:?}");
    assert_eq!(
        count_reaction(&p.su, pair.trigger, pair.agent, STATUS_EYE).await,
        1
    );
    let out = step(&p.app, pair, other, "succeeded", "terminal").await;
    assert!(out.eye_removed && out.check_added, "{out:?}");
    // A second run of the same (message, agent) in A that is still taken keeps that eye...
    let live = seed_run(&p.su, a.ws, a.channel, a.agent, Some(a.trigger), "running").await;
    let kept = with_tenant_tx(&p.app, a.ws, move |conn| {
        Box::pin(async move { sweep_settled_eyes_in_tx(conn, a.ws, 100).await })
    })
    .await
    .expect("sweep a");
    assert_eq!(kept, 0, "LA10: a live run of the pair keeps the eye");
    assert_eq!(
        count_reaction(&p.su, a.trigger, a.agent, STATUS_EYE).await,
        1
    );
    // ...and once it ends, the next pass takes it.
    sqlx::query("UPDATE agent_run SET status='timed_out' WHERE id=$1")
        .bind(live)
        .execute(&p.su)
        .await
        .expect("live ends");
    let removed = with_tenant_tx(&p.app, a.ws, move |conn| {
        Box::pin(async move { sweep_settled_eyes_in_tx(conn, a.ws, 100).await })
    })
    .await
    .expect("sweep a again");
    assert_eq!(removed, 1);
    assert_eq!(
        count_reaction(&p.su, a.trigger, a.agent, STATUS_EYE).await,
        0
    );
    // B was not looked at: its eye stays until B's own pass.
    assert_eq!(
        count_reaction(&p.su, b.trigger, b.agent, STATUS_EYE).await,
        1,
        "two tenants"
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='reaction.removed'           AND detail->>'derived'='run_lifecycle'",
    )
    .bind(a.ws)
    .fetch_one(&p.su)
    .await
    .expect("audit");
    assert_eq!(audited, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn a_refused_reaction_never_holds_the_run() {
    let p = pools().await;
    // The agent left the channel: the end removes the eye, adds no check, and commits.
    let w = world(&p.su, "queued").await;
    assert!(step(&p.app, w, w.run, "running", "take").await.eye_added);
    sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
        .bind(w.channel)
        .bind(w.agent)
        .execute(&p.su)
        .await
        .expect("leave");
    let out = step(&p.app, w, w.run, "succeeded", "terminal").await;
    assert!(out.eye_removed && !out.check_added, "LA9: {out:?}");
    // The trigger message deleted: nothing added, the run still ends.
    let d = world(&p.su, "queued").await;
    sqlx::query("UPDATE message SET deleted_at=now(), state='deleted' WHERE id=$1")
        .bind(d.trigger)
        .execute(&p.su)
        .await
        .expect("delete");
    let out = step(&p.app, d, d.run, "succeeded", "terminal").await;
    assert!(!out.check_added && !out.rolled_back, "LA7: {out:?}");
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
        .bind(d.run)
        .fetch_one(&p.su)
        .await
        .expect("status");
    assert_eq!(status, "succeeded");
    // No trigger at all: nothing.
    let n = world(&p.su, "queued").await;
    let bare = seed_run(&p.su, n.ws, n.channel, n.agent, None, "queued").await;
    assert_eq!(
        step(&p.app, n, bare, "running", "take").await,
        StatusReactionOutcome::default()
    );
    assert_eq!(
        step(&p.app, n, bare, "succeeded", "terminal").await,
        StatusReactionOutcome::default()
    );
    let _ = n.alice;
}
