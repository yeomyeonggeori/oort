//! #3169 / ADR-0196 — team-memory M2: the agent's 「기억해 둘게요」 proposal
//! (`mem_proposal`, `mem_propose_item`, `mem_accept_proposal`, `mem_reject_proposal`) and the item
//! serving functions (`mem_serve_items`, `mem_record_serving`, `mem_serving_record_of`).
//!
//! Real Postgres. The propose side runs as `momo_worker` + `SET ROLE momo_memory` (the worker's memory
//! tx), the decide side and every read as `momo_app` (NOBYPASSRLS) with `app.member_id` set — the
//! states a running deployment has (after `bootstrap_roles.sql`).
//!
//! Every guard below is sabotaged: the function is redefined inside a superuser transaction with the
//! guard cut out, the same scenario is run, and the transaction is rolled back. The shipped function
//! refuses; the sabotaged one lets the thing through ("RED" lines on stderr).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_proposal_is_pending_and_nothing_reads_it_as_memory_until_accepted` | writing a proposal into `mem_item`, or a policy that lets a stranger read it |
//! | `only_a_human_who_can_read_the_channel_may_decide` | the reader clause, the human clause, the `session_user` guard of `mem_proposal_decider` |
//! | `accepting_revalidates_the_evidence_against_the_accepter` | each evidence clause of `mem_accept_proposal`, the switches, the expiry |
//! | `an_agent_cannot_propose_what_it_could_not_cite` | each evidence / switch / secret clause of `mem_propose_item` |
//! | `proposals_are_rate_limited` | the three limits |
//! | `the_proposal_table_is_closed_and_hides_what_it_should` | the read policy, `mem_proposal_evidence_ok`, the worker-only grants |
//! | `served_items_follow_the_audience_rule_and_the_receipt_checks_them` | `mem_serve_items` switches, `mem_record_serving` item / requester checks |
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test mem_proposal_conformance_pg -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use uuid::Uuid;

// --- harness -------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql)")
}

/// `momo_worker` (BYPASSRLS login). `set_role` = has done `SET ROLE momo_memory`.
async fn worker_pool(set_role: bool) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string());
    let mut pool = PgPoolOptions::new().max_connections(4);
    if set_role {
        pool = pool.after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE momo_memory").execute(conn).await?;
                Ok(())
            })
        });
    }
    pool.connect_with(options.username("momo_worker").password(&password))
        .await
        .expect("connect as momo_worker (bootstrap_roles.sql)")
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
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../infra/rust/sql")
        .join("bootstrap_roles.sql");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .env("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw")
        .env("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw")
        .env("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw")
        .env("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw")
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

fn sqlstate(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
        other => format!("non-db error: {other}"),
    }
}

fn arr(ids: &[Uuid]) -> String {
    if ids.is_empty() {
        "'{}'::uuid[]".to_string()
    } else {
        let items: Vec<String> = ids.iter().map(|i| format!("'{i}'")).collect();
        format!("ARRAY[{}]::uuid[]", items.join(","))
    }
}

async fn su_exec(su: &PgPool, sql: &str) {
    sqlx::query(sql).execute(su).await.expect(sql);
}

async fn su_count(su: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(su).await.expect(sql)
}

async fn viewer_tx<'a>(
    pool: &'a PgPool,
    ws: Uuid,
    member: Option<Uuid>,
) -> sqlx::Transaction<'a, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin");
    set_gucs(&mut tx, Some(ws), member).await;
    tx
}

async fn set_gucs(tx: &mut sqlx::PgConnection, ws: Option<Uuid>, member: Option<Uuid>) {
    if let Some(ws) = ws {
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(ws.to_string())
            .execute(&mut *tx)
            .await
            .expect("ws guc");
    }
    if let Some(member) = member {
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(member.to_string())
            .execute(&mut *tx)
            .await
            .expect("member guc");
    }
}

/// One statement in its own tenant tx. Ok(rows affected) commits; Err is the SQLSTATE.
async fn exec(pool: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> Result<u64, String> {
    let mut tx = viewer_tx(pool, ws, member).await;
    match sqlx::query(sql).execute(&mut *tx).await {
        Ok(done) => {
            tx.commit().await.expect("commit");
            Ok(done.rows_affected())
        }
        Err(error) => Err(sqlstate(&error)),
    }
}

/// A count as `member` (RLS on), rolled back.
async fn count_as(pool: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> i64 {
    let mut tx = viewer_tx(pool, ws, member).await;
    let n: i64 = sqlx::query_scalar(sql)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    tx.rollback().await.expect("rollback");
    n
}

/// A superuser transaction in which `function` has been redefined with each `from` replaced by
/// `to`. The caller runs its scenario in it and rolls back.
async fn sabotage_tx(
    su: &PgPool,
    function: &str,
    edits: &[(&str, &str)],
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin");
    redefine(&mut tx, function, edits).await;
    tx
}

async fn redefine(tx: &mut sqlx::PgConnection, function: &str, edits: &[(&str, &str)]) {
    let mut def: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(function)
        .fetch_one(&mut *tx)
        .await
        .expect("functiondef");
    for (from, to) in edits {
        assert!(
            def.contains(from),
            "sabotage fragment not found in {function}: {from}"
        );
        def = def.replacen(from, to, 1);
    }
    sqlx::query(&def).execute(&mut *tx).await.expect("redefine");
}

async fn become_role(tx: &mut sqlx::PgConnection, role: &str, ws: Uuid, member: Option<Uuid>) {
    set_gucs(tx, Some(ws), member).await;
    sqlx::query(&format!("SET LOCAL ROLE {role}"))
        .execute(&mut *tx)
        .await
        .expect("set role");
}

/// (label, the call's outcome, the SQLSTATE, the clauses whose removal lets it through).
type Scenario<'a> = (
    String,
    Result<Option<Uuid>, String>,
    &'a str,
    Vec<(&'a str, &'a str)>,
);

// --- world -----------------------------------------------------------------------

struct W {
    ws: Uuid,
    ws_b: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    dave: Uuid,
    erin: Uuid, // suspended
    agent: Uuid,
    bob_b: Uuid,
    general: Uuid, // public: alice bob carol erin agent
    hr: Uuid,      // private: alice bob (no agent)
    other: Uuid,   // public: alice dave agent
    dm_aa: Uuid,   // dm: alice + agent
}

async fn member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("m-{}", &id.simple().to_string()[..10]);
    sqlx::query(&format!(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, '{kind}', $3, $3)"
    ))
    .bind(id)
    .bind(ws)
    .bind(handle)
    .execute(su)
    .await
    .expect("member");
    id
}

async fn channel(su: &PgPool, ws: Uuid, kind: &str, creator: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    let dm_key = if kind == "dm" {
        format!("'k-{id}'")
    } else {
        "NULL".to_string()
    };
    sqlx::query(&format!(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, dm_key) \
         VALUES ($1, $2, '{kind}', $3, '', $4, {dm_key})"
    ))
    .bind(id)
    .bind(ws)
    .bind(format!("c-{}", &id.simple().to_string()[..10]))
    .bind(creator)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("channel_seq");
    id
}

async fn join(su: &PgPool, ws: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'member')",
    )
    .bind(ws)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
}

async fn build_world(su: &PgPool) -> W {
    let mut ids = Vec::new();
    for _ in 0..2 {
        let ws = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(ws)
            .bind(format!("prop-{ws}"))
            .execute(su)
            .await
            .expect("workspace");
        ids.push(ws);
    }
    let (ws, ws_b) = (ids[0], ids[1]);
    let alice = member(su, ws, "human").await;
    let bob = member(su, ws, "human").await;
    let carol = member(su, ws, "human").await;
    let dave = member(su, ws, "human").await;
    let erin = member(su, ws, "human").await;
    let agent = member(su, ws, "agent").await;
    let bob_b = member(su, ws_b, "human").await;
    let general = channel(su, ws, "public", alice).await;
    let hr = channel(su, ws, "private", alice).await;
    let other = channel(su, ws, "public", alice).await;
    let dm_aa = channel(su, ws, "dm", alice).await;
    for m in [alice, bob, carol, erin, agent] {
        join(su, ws, general, m).await;
    }
    for m in [alice, bob] {
        join(su, ws, hr, m).await;
    }
    for m in [alice, dave, agent] {
        join(su, ws, other, m).await;
    }
    for m in [alice, agent] {
        join(su, ws, dm_aa, m).await;
    }
    su_exec(
        su,
        &format!("UPDATE member SET status = 'suspended' WHERE id = '{erin}'"),
    )
    .await;
    W {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        dave,
        erin,
        agent,
        bob_b,
        general,
        hr,
        other,
        dm_aa,
    }
}

async fn setup() -> (PgPool, PgPool, PgPool, W) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let wk = worker_pool(true).await;
    let w = build_world(&su).await;
    (su, app, wk, w)
}

async fn say(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid, body: &str) -> (Uuid, i64) {
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
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("message");
    (id, seq)
}

/// `n` filler messages by `author` (advances the channel's seq).
async fn fill(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid, n: i64) {
    let start: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + $2 WHERE channel_id = $1 RETURNING last_seq - $2",
    )
    .bind(channel)
    .bind(n)
    .fetch_one(su)
    .await
    .expect("seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         SELECT gen_random_uuid(), $1, $2, $3 + g, 0, 0, $4, 'text', '잡담' FROM generate_series(1, $5::int) g",
    )
    .bind(ws)
    .bind(channel)
    .bind(start)
    .bind(author)
    .bind(n)
    .execute(su)
    .await
    .expect("fill");
}

/// A run triggered by `trigger` (a message) in `channel`, for `agent`.
async fn run_for(
    su: &PgPool,
    ws: Uuid,
    channel: Uuid,
    agent: Uuid,
    trigger: Option<Uuid>,
    status: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let trigger = trigger.map_or("NULL".to_string(), |t| format!("'{t}'"));
    su_exec(
        su,
        &format!(
            "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status) \
             VALUES ('{id}', '{ws}', '{agent}', '{channel}', {trigger}, '{status}')"
        ),
    )
    .await;
    id
}

/// A mention run: alice speaks in `channel`, the agent is asked.
async fn mention_run(su: &PgPool, w: &W, channel: Uuid, asker: Uuid, text: &str) -> (Uuid, Uuid) {
    let (t, _) = say(su, w.ws, channel, asker, text).await;
    let run = run_for(su, w.ws, channel, w.agent, Some(t), "running").await;
    (run, t)
}

fn propose_sql(run: Uuid, kind: &str, evidence: &[Uuid]) -> String {
    format!(
        "SELECT mem_propose_item('{run}', '{kind}', $1, NULL, {})",
        arr(evidence)
    )
}

/// `mem_propose_item` as the worker's memory tx.
async fn propose(
    wk: &PgPool,
    ws: Uuid,
    run: Uuid,
    kind: &str,
    body: &str,
    evidence: &[Uuid],
) -> Result<Option<Uuid>, String> {
    let mut tx = viewer_tx(wk, ws, None).await;
    let r = sqlx::query_scalar::<_, Option<Uuid>>(&propose_sql(run, kind, evidence))
        .bind(body)
        .fetch_one(&mut *tx)
        .await;
    match r {
        Ok(id) => {
            tx.commit().await.expect("commit");
            Ok(id)
        }
        Err(e) => Err(sqlstate(&e)),
    }
}

/// `mem_propose_item` inside a (possibly sabotaged) superuser tx, as the memory role.
async fn propose_in(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    ws: Uuid,
    run: Uuid,
    kind: &str,
    body: &str,
    evidence: &[Uuid],
) -> Result<Option<Uuid>, String> {
    become_role(&mut tx, "momo_memory", ws, None).await;
    let r = sqlx::query_scalar::<_, Option<Uuid>>(&propose_sql(run, kind, evidence))
        .bind(body)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    r
}

const PROPOSE_FN: &str = "public.mem_propose_item(uuid, text, text, text, uuid[])";
const ACCEPT_FN: &str = "public.mem_accept_proposal(uuid)";
const DECIDER_FN: &str = "public.mem_proposal_decider(uuid)";

async fn decide(
    app: &PgPool,
    ws: Uuid,
    viewer: Option<Uuid>,
    function: &str,
    proposal: Uuid,
) -> Result<String, String> {
    let mut tx = viewer_tx(app, ws, viewer).await;
    let r = sqlx::query_scalar::<_, Option<String>>(&format!("SELECT {function}($1)::text"))
        .bind(proposal)
        .fetch_one(&mut *tx)
        .await;
    match r {
        Ok(v) => {
            tx.commit().await.expect("commit");
            Ok(v.unwrap_or_default())
        }
        Err(e) => Err(sqlstate(&e)),
    }
}

async fn accept(app: &PgPool, ws: Uuid, viewer: Option<Uuid>, p: Uuid) -> Result<Uuid, String> {
    decide(app, ws, viewer, "mem_accept_proposal", p)
        .await
        .map(|s| Uuid::parse_str(&s).expect("item id"))
}

async fn reject(app: &PgPool, ws: Uuid, viewer: Option<Uuid>, p: Uuid) -> Result<(), String> {
    decide(app, ws, viewer, "mem_reject_proposal", p)
        .await
        .map(|_| ())
}

/// `function(proposal)` as `viewer` inside a sabotaged superuser tx (role momo_app).
async fn decide_in(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    ws: Uuid,
    viewer: Option<Uuid>,
    function: &str,
    proposal: Uuid,
    session: Option<&str>,
) -> Result<String, String> {
    set_gucs(&mut tx, Some(ws), viewer).await;
    if let Some(login) = session {
        sqlx::query(&format!("SET LOCAL SESSION AUTHORIZATION {login}"))
            .execute(&mut *tx)
            .await
            .expect("session authorization");
    } else {
        sqlx::query("SET LOCAL ROLE momo_app")
            .execute(&mut *tx)
            .await
            .expect("set role");
    }
    let r = sqlx::query_scalar::<_, Option<String>>(&format!("SELECT {function}($1)::text"))
        .bind(proposal)
        .fetch_one(&mut *tx)
        .await
        .map(|v| v.unwrap_or_default())
        .map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    r
}

/// A fresh pending proposal in `general` made by the agent for alice, with two evidence messages.
async fn pending(su: &PgPool, wk: &PgPool, w: &W, text: &str) -> (Uuid, Vec<Uuid>) {
    let (m1, _) = say(su, w.ws, w.general, w.alice, &format!("{text} — 근거 하나")).await;
    let (m2, _) = say(su, w.ws, w.general, w.bob, &format!("{text} — 근거 둘")).await;
    let (run, _) = mention_run(su, w, w.general, w.alice, "@agent 기억해 줄래요?").await;
    let id = propose(wk, w.ws, run, "decision", text, &[m1, m2])
        .await
        .expect("propose")
        .expect("a new proposal");
    (id, vec![m1, m2])
}

// ---------------------------------------------------------------------------
// pending is not memory
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_proposal_is_pending_and_nothing_reads_it_as_memory_until_accepted() {
    let (su, app, wk, w) = setup().await;
    let (m1, _) = say(&su, w.ws, w.general, w.alice, "배포는 금요일로 정했어요").await;
    let (m2, _) = say(&su, w.ws, w.general, w.bob, "금요일 오후 2시로 해요").await;
    let (run, _t) = mention_run(&su, &w, w.general, w.alice, "@agent 배포일이 언제였죠").await;
    let text = "배포는 2026-10-02 금요일 오후 2시로 정했어요";
    let pid = propose(&wk, w.ws, run, "decision", text, &[m1, m2])
        .await
        .expect("propose")
        .expect("new proposal");

    // The row: agent / requester / channel come from the run row, the state is pending.
    let row: (
        Uuid,
        Uuid,
        Uuid,
        Option<Uuid>,
        String,
        String,
        Option<String>,
        i32,
    ) = sqlx::query_as(
        "SELECT channel_id, agent_member_id, requester_member_id, run_id, status, kind, body, \
                    cardinality(evidence_message_ids) FROM mem_proposal WHERE id = $1",
    )
    .bind(pid)
    .fetch_one(&su)
    .await
    .expect("row");
    assert_eq!(row.0, w.general);
    assert_eq!(row.1, w.agent, "the run's agent");
    assert_eq!(row.2, w.alice, "derived from the trigger message's author");
    assert_eq!(row.3, Some(run));
    assert_eq!(row.4, "pending");
    assert_eq!(row.5, "decision");
    assert_eq!(row.6.as_deref(), Some(text));
    assert_eq!(row.7, 2);
    assert_eq!(
        su_count(
            &su,
            &format!("SELECT count(*) FROM mem_event WHERE target_id = '{pid}' AND target_kind = 'proposal' AND action = 'proposed' AND actor_member_id = '{}'", w.agent)
        )
        .await,
        1
    );

    // Invisible as memory: no item exists, no reader finds one, serving offers none.
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_item WHERE workspace_id = '{}'",
                w.ws
            )
        )
        .await,
        0
    );
    for viewer in [w.alice, w.bob, w.carol] {
        assert_eq!(
            count_as(&app, w.ws, Some(viewer), "SELECT count(*) FROM mem_item").await,
            0
        );
        assert_eq!(
            count_as(
                &app,
                w.ws,
                Some(viewer),
                "SELECT count(*) FROM mem_search_items('배포 금요일', 10)"
            )
            .await,
            0,
            "search must not find a pending proposal"
        );
    }
    let (probe_run, _) = mention_run(&su, &w, w.general, w.carol, "배포 금요일 언제죠").await;
    let served = count_as_worker(
        &wk,
        w.ws,
        &format!("SELECT count(*) FROM mem_serve_items('{probe_run}', 8, 600)"),
    )
    .await;
    assert_eq!(served, 0, "serving must not offer a pending proposal");

    // The card is visible to the channel's members and to nobody else.
    let list = "SELECT count(*) FROM mem_proposal WHERE status = 'pending'";
    for viewer in [w.alice, w.bob, w.carol] {
        assert_eq!(count_as(&app, w.ws, Some(viewer), list).await, 1);
    }
    for stranger in [Some(w.dave), None] {
        assert_eq!(count_as(&app, w.ws, stranger, list).await, 0);
    }
    assert_eq!(count_as(&app, w.ws_b, Some(w.bob_b), list).await, 0);

    // A person accepts: now (and only now) it is a confirmed memory of the channel.
    let item = accept(&app, w.ws, Some(w.bob), pid)
        .await
        .expect("bob may accept");
    let it: (String, String, String, Option<Uuid>, i32, String) = sqlx::query_as(
        "SELECT origin, space_kind, kind, owner_member_id, source_count, body FROM mem_item WHERE id = $1",
    )
    .bind(item)
    .fetch_one(&su)
    .await
    .expect("item");
    assert_eq!(
        (it.0.as_str(), it.1.as_str(), it.2.as_str(), it.3, it.4),
        ("confirmed", "channel", "decision", None, 2)
    );
    assert_eq!(it.5, text);
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_evidence WHERE item_id = '{item}' AND channel_id = '{}'",
                w.general
            )
        )
        .await,
        2
    );
    let events: Vec<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT action, actor_member_id FROM mem_event WHERE target_kind = 'item' AND target_id = $1 ORDER BY created_at, action",
    )
    .bind(item)
    .fetch_all(&su)
    .await
    .expect("events");
    assert!(
        events.contains(&("created".to_string(), None)),
        "{events:?}"
    );
    assert!(
        events.contains(&("confirmed".to_string(), Some(w.bob))),
        "{events:?}"
    );
    // The shell keeps no text.
    let shell: (String, Option<String>, i32, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT status, body, cardinality(evidence_message_ids), decided_by, item_id FROM mem_proposal WHERE id = $1",
    )
    .bind(pid)
    .fetch_one(&su)
    .await
    .expect("shell");
    assert_eq!(shell, ("accepted".into(), None, 0, Some(w.bob), Some(item)));
    // Readers now find it — the assertions above could fail.
    for viewer in [w.alice, w.bob, w.carol] {
        assert_eq!(
            count_as(
                &app,
                w.ws,
                Some(viewer),
                "SELECT count(*) FROM mem_search_items('배포 금요일', 10)"
            )
            .await,
            1
        );
    }
    assert_eq!(
        count_as(
            &app,
            w.ws,
            Some(w.dave),
            "SELECT count(*) FROM mem_search_items('배포 금요일', 10)"
        )
        .await,
        0,
        "dave is not in the channel"
    );
    let (run2, _) = mention_run(&su, &w, w.general, w.carol, "배포 금요일 언제였지요").await;
    assert_eq!(
        count_as_worker(
            &wk,
            w.ws,
            &format!("SELECT count(*) FROM mem_serve_items('{run2}', 8, 600)")
        )
        .await,
        1,
        "serving offers the accepted memory to a group answer in its own channel"
    );

    // Forgetting (a permanent delete of the item, #3208) leaves the shell without the item: the
    // foreign key nulls `item_id`, no text was ever kept on the proposal.
    let (m3, _) = say(&su, w.ws, w.general, w.alice, "잊을 결정의 근거예요").await;
    let (run_f, _) = mention_run(&su, &w, w.general, w.alice, "@agent 이것도 기억").await;
    let forget_p = propose(&wk, w.ws, run_f, "decision", "잊게 될 결정이에요", &[m3])
        .await
        .expect("propose")
        .expect("new");
    let forget_item = accept(&app, w.ws, Some(w.bob), forget_p)
        .await
        .expect("accept");
    su_exec(
        &su,
        &format!("DELETE FROM mem_item WHERE id = '{forget_item}'"),
    )
    .await;
    let after: (String, Option<Uuid>, Option<String>) =
        sqlx::query_as("SELECT status, item_id, body FROM mem_proposal WHERE id = $1")
            .bind(forget_p)
            .fetch_one(&su)
            .await
            .expect("shell after forget");
    assert_eq!(after, ("accepted".to_string(), None, None));

    // A decided proposal is decided.
    assert_eq!(
        accept(&app, w.ws, Some(w.alice), pid).await,
        Err("55000".into())
    );
    assert_eq!(
        reject(&app, w.ws, Some(w.alice), pid).await,
        Err("55000".into())
    );
    // The same text again is "already remembered": no second proposal.
    let (run3, _) = mention_run(&su, &w, w.general, w.alice, "@agent 또 기억해 줘").await;
    assert_eq!(
        propose(&wk, w.ws, run3, "decision", text, &[m1, m2]).await,
        Ok(None),
        "an identical live memory is not proposed again"
    );
}

/// A GitHub-token-shaped string, assembled at run time so the source holds no literal secret shape.
fn secret_token() -> String {
    ["ghp", "_", "abcdefghijklmnopqrstuvwxyz", "0123456789"].concat()
}

/// A count as the memory role (the worker's memory tx): the statement runs in a tx with the tenant set.
async fn count_as_worker(wk: &PgPool, ws: Uuid, sql: &str) -> i64 {
    let mut tx = viewer_tx(wk, ws, None).await;
    let n: i64 = sqlx::query_scalar(sql)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    tx.rollback().await.expect("rollback");
    n
}

// ---------------------------------------------------------------------------
// who may decide
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn only_a_human_who_can_read_the_channel_may_decide() {
    let (su, app, wk, w) = setup().await;
    let plain_worker = worker_pool(false).await;
    let (pid, _) = pending(&su, &wk, &w, "릴리스 담당은 캐롤로 정했어요").await;

    // Everyone who may not decide gets the same 42501 (no existence oracle for unknown ids either).
    let unknown = Uuid::new_v4();
    let cases: Vec<(&str, Option<Uuid>, Uuid)> = vec![
        ("a workspace member outside the channel", Some(w.dave), pid),
        ("an agent", Some(w.agent), pid),
        ("a suspended member", Some(w.erin), pid),
        ("another workspace's member", Some(w.bob_b), pid),
        ("nobody (no viewer)", None, pid),
        ("an unknown proposal id", Some(w.bob), unknown),
    ];
    for (who, viewer, target) in &cases {
        let ws = if *viewer == Some(w.bob_b) {
            w.ws_b
        } else {
            w.ws
        };
        assert_eq!(
            accept(&app, ws, *viewer, *target).await,
            Err("42501".into()),
            "accept by {who}"
        );
        assert_eq!(
            reject(&app, ws, *viewer, *target).await,
            Err("42501".into()),
            "reject by {who}"
        );
    }
    // A BYPASSRLS login (momo_worker) cannot decide by setting the viewer GUC itself.
    for f in ["mem_accept_proposal", "mem_reject_proposal"] {
        assert_eq!(
            decide(&plain_worker, w.ws, Some(w.bob), f, pid).await,
            Err("42501".into()),
            "momo_worker must not run {f}"
        );
        assert_eq!(
            decide(&wk, w.ws, Some(w.bob), f, pid).await,
            Err("42501".into()),
            "momo_memory must not run {f}"
        );
    }
    // A member who left the channel loses the right at once.
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = now() WHERE channel_id = '{}' AND member_id = '{}'",
            w.general, w.carol
        ),
    )
    .await;
    assert_eq!(
        accept(&app, w.ws, Some(w.carol), pid).await,
        Err("42501".into()),
        "a member who left"
    );
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = NULL WHERE channel_id = '{}' AND member_id = '{}'",
            w.general, w.carol
        ),
    )
    .await;
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_item WHERE workspace_id = '{}'",
                w.ws
            )
        )
        .await,
        0
    );
    assert_eq!(
        su_count(
            &su,
            &format!("SELECT count(*) FROM mem_proposal WHERE id = '{pid}' AND status = 'pending'")
        )
        .await,
        1
    );

    // RED: each clause of the decider is what refuses.
    let red = |label: &'static str,
               edits: Vec<(&'static str, &'static str)>,
               viewer: Uuid,
               session: Option<&'static str>| {
        let su = su.clone();
        let ws = w.ws;
        async move {
            let tx = sabotage_tx(&su, DECIDER_FN, &edits).await;
            let out = decide_in(tx, ws, Some(viewer), "mem_accept_proposal", pid, session).await;
            eprintln!("RED {label}: accept returns {out:?}");
            out
        }
    };
    // (a) without the channel-reader clause the decider lets dave through, and the accept's own
    //     evidence check (the accepter must read every evidence message) is the second wall.
    let second_wall = red(
        "reader clause removed from the decider",
        vec![(
            "OR NOT public.mem_member_can_read(v_channel, v_viewer)",
            "OR false",
        )],
        w.dave,
        None,
    )
    .await;
    assert_eq!(
        second_wall,
        Err("23503".into()),
        "the accept's evidence check still refuses"
    );
    let leaked = {
        let mut tx = sabotage_tx(
            &su,
            DECIDER_FN,
            &[(
                "OR NOT public.mem_member_can_read(v_channel, v_viewer)",
                "OR false",
            )],
        )
        .await;
        redefine(
            &mut tx,
            ACCEPT_FN,
            &[(
                "AND public.mem_member_can_read(m.channel_id, v_viewer)",
                "AND true",
            )],
        )
        .await;
        decide_in(tx, w.ws, Some(w.dave), "mem_accept_proposal", pid, None).await
    };
    eprintln!("RED both reader walls removed: dave's accept returns {leaked:?}");
    assert!(leaked.is_ok(), "sabotaged: {leaked:?}");
    // (b) without the human clause the agent accepts.
    let leaked = red(
        "human clause removed",
        vec![("AND h.kind = 'human'", "AND h.kind IN ('human', 'agent')")],
        w.agent,
        None,
    )
    .await;
    assert!(leaked.is_ok(), "sabotaged: {leaked:?}");
    // (d) without the session_user guard a momo_worker login accepts by naming a member.
    let leaked = red(
        "session_user guard removed",
        vec![(
            "IF session_user::text <> 'momo_app'",
            "IF false AND session_user::text <> 'momo_app'",
        )],
        w.bob,
        Some("momo_worker"),
    )
    .await;
    assert!(leaked.is_ok(), "sabotaged: {leaked:?}");
    // ... and with the guard in place the very same session is refused.
    let refused = {
        let tx = su.begin().await.expect("begin");
        decide_in(
            tx,
            w.ws,
            Some(w.bob),
            "mem_accept_proposal",
            pid,
            Some("momo_worker"),
        )
        .await
    };
    assert_eq!(refused, Err("42501".into()));

    // Any active human member who reads the channel may decide — carol is neither the requester
    // nor an author of the evidence (ADR-0196 D4 / D9 / D6-2).
    let (pid2, _) = pending(&su, &wk, &w, "회고는 목요일 오전으로 옮겼어요").await;
    reject(&app, w.ws, Some(w.carol), pid2)
        .await
        .expect("carol may reject");
    let shell: (String, Option<String>, Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT status, body, decided_by, item_id FROM mem_proposal WHERE id = $1")
            .bind(pid2)
            .fetch_one(&su)
            .await
            .expect("shell");
    assert_eq!(shell, ("rejected".into(), None, Some(w.carol), None));
    assert_eq!(
        su_count(&su, &format!("SELECT count(*) FROM mem_event WHERE target_kind = 'proposal' AND target_id = '{pid2}' AND action = 'rejected' AND actor_member_id = '{}'", w.carol)).await,
        1,
        "a rejection is logged"
    );
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_item WHERE workspace_id = '{}'",
                w.ws
            )
        )
        .await,
        0,
        "a rejection remembers nothing"
    );
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), pid2).await,
        Err("55000".into()),
        "rejected is final"
    );
    let accepted = accept(&app, w.ws, Some(w.carol), pid).await;
    assert!(accepted.is_ok(), "carol may accept: {accepted:?}");
}

// ---------------------------------------------------------------------------
// accept re-validates
// ---------------------------------------------------------------------------

/// Insert a proposal row as a superuser (what a buggy or hostile propose could have stored).
async fn forge(su: &PgPool, w: &W, channel: Uuid, body: &str, evidence: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(&format!(
        "INSERT INTO mem_proposal (id, workspace_id, channel_id, agent_member_id, requester_member_id, kind, body, \
         evidence_message_ids, content_hash) VALUES ($1, $2, $3, $4, $5, 'fact', $6, {}, $7)",
        arr(evidence)
    ))
    .bind(id)
    .bind(w.ws)
    .bind(channel)
    .bind(w.agent)
    .bind(w.alice)
    .bind(body)
    .bind(format!("forged-{id}"))
    .execute(su)
    .await
    .expect("forge");
    id
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn accepting_revalidates_the_evidence_against_the_accepter() {
    let (su, app, wk, w) = setup().await;
    let item_count = |sql_ws: Uuid| {
        let su = su.clone();
        async move {
            su_count(
                &su,
                &format!("SELECT count(*) FROM mem_item WHERE workspace_id = '{sql_ws}'"),
            )
            .await
        }
    };

    // Each case: (label, mutate the world, expected SQLSTATE, the clause to cut, viewer).
    // A fresh proposal per case; the sabotaged function must let the same case through.
    struct Case {
        label: &'static str,
        code: &'static str,
        edits: Vec<(&'static str, &'static str)>,
    }
    let cases = [
        Case {
            label: "an evidence message was deleted",
            code: "23503",
            edits: vec![(
                "AND m.deleted_at IS NULL AND m.state <> 'deleted'",
                "AND true",
            )],
        },
        Case {
            label: "an evidence message was edited after the proposal",
            code: "40001",
            edits: vec![(
                "AND m.edited_at IS NOT NULL AND m.edited_at > v_p.created_at",
                "AND false",
            )],
        },
        Case {
            label: "the memory switch is off for the channel",
            code: "55000",
            edits: vec![(
                "IF NOT public.mem_channel_eligible(v_p.channel_id) THEN",
                "IF false THEN",
            )],
        },
        Case {
            label: "the proposal expired",
            code: "55000",
            edits: vec![(
                "IF v_p.expires_at <= pg_catalog.now() THEN",
                "IF false THEN",
            )],
        },
    ];
    for (n, case) in cases.iter().enumerate() {
        let (pid, msgs) = pending(&su, &wk, &w, &format!("사례 {n} — 결정 내용이에요")).await;
        match n {
            0 => su_exec(&su, &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{}'", msgs[0])).await,
            1 => su_exec(&su, &format!("UPDATE message SET edited_at = now() + interval '1 second' WHERE id = '{}'", msgs[1])).await,
            2 => su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.general)).await,
            _ => su_exec(&su, &format!("UPDATE mem_proposal SET expires_at = now() - interval '1 minute' WHERE id = '{pid}'")).await,
        }
        let before = item_count(w.ws).await;
        assert_eq!(
            accept(&app, w.ws, Some(w.bob), pid).await,
            Err(case.code.into()),
            "{}",
            case.label
        );
        assert_eq!(
            item_count(w.ws).await,
            before,
            "{}: nothing remembered",
            case.label
        );
        assert_eq!(
            su_count(
                &su,
                &format!(
                    "SELECT count(*) FROM mem_proposal WHERE id = '{pid}' AND status = 'pending'"
                )
            )
            .await,
            1,
            "{}: still pending",
            case.label
        );
        let tx = sabotage_tx(&su, ACCEPT_FN, &case.edits).await;
        let out = decide_in(tx, w.ws, Some(w.bob), "mem_accept_proposal", pid, None).await;
        eprintln!("RED {}: sabotaged accept returns {out:?}", case.label);
        assert!(out.is_ok(), "{}: sabotaged: {out:?}", case.label);
        if n == 2 {
            su_exec(
                &su,
                &format!(
                    "DELETE FROM mem_settings WHERE channel_id = '{}'",
                    w.general
                ),
            )
            .await;
        }
    }

    // Workspace pause is a switch too.
    let (pid, _) = pending(&su, &wk, &w, "워크스페이스 정지 사례 결정이에요").await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws)).await;
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), pid).await,
        Err("55000".into()),
        "workspace paused"
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
    )
    .await;

    // Forged proposals: the accept does not trust what propose stored.
    let (hr_msg, _) = say(&su, w.ws, w.hr, w.bob, "인사 관련 비공개 내용이에요").await;
    let (agent_msg, _) = say(&su, w.ws, w.general, w.agent, "에이전트가 한 말이에요").await;
    // (1) evidence from a channel the accepter cannot read (carol is not in hr).
    let cross = forge(
        &su,
        &w,
        w.general,
        "다른 채널 근거로 만든 제안이에요",
        &[hr_msg],
    )
    .await;
    assert_eq!(
        accept(&app, w.ws, Some(w.carol), cross).await,
        Err("23503".into()),
        "evidence in a channel carol cannot read"
    );
    // Two independent walls: cut either and it is still refused; cut both and it leaks.
    let only_channel_wall = sabotage_tx(
        &su,
        ACCEPT_FN,
        &[(
            "AND public.mem_member_can_read(m.channel_id, v_viewer)",
            "AND true",
        )],
    )
    .await;
    let out = decide_in(
        only_channel_wall,
        w.ws,
        Some(w.carol),
        "mem_accept_proposal",
        cross,
        None,
    )
    .await;
    assert_eq!(
        out,
        Err("23503".into()),
        "the channel-equality wall alone still refuses"
    );
    let only_read_wall = sabotage_tx(
        &su,
        ACCEPT_FN,
        &[("AND m.channel_id = v_p.channel_id", "AND true")],
    )
    .await;
    let out = decide_in(
        only_read_wall,
        w.ws,
        Some(w.carol),
        "mem_accept_proposal",
        cross,
        None,
    )
    .await;
    assert_eq!(
        out,
        Err("23503".into()),
        "the reader wall alone still refuses"
    );
    let neither = sabotage_tx(
        &su,
        ACCEPT_FN,
        &[
            (
                "AND public.mem_member_can_read(m.channel_id, v_viewer)",
                "AND true",
            ),
            ("AND m.channel_id = v_p.channel_id", "AND true"),
        ],
    )
    .await;
    let out = decide_in(
        neither,
        w.ws,
        Some(w.carol),
        "mem_accept_proposal",
        cross,
        None,
    )
    .await;
    eprintln!("RED both cross-channel walls removed: accept returns {out:?}");
    assert!(out.is_ok(), "sabotaged: {out:?}");
    // (2) evidence written by an agent.
    let by_agent = forge(
        &su,
        &w,
        w.general,
        "에이전트 발언을 근거로 한 제안이에요",
        &[agent_msg],
    )
    .await;
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), by_agent).await,
        Err("23514".into()),
        "an agent's words are not evidence"
    );
    let tx = sabotage_tx(&su, ACCEPT_FN, &[("AND au.kind <> 'human'", "AND false")]).await;
    let out = decide_in(tx, w.ws, Some(w.bob), "mem_accept_proposal", by_agent, None).await;
    eprintln!("RED agent-author clause removed: accept returns {out:?}");
    assert!(out.is_ok(), "sabotaged: {out:?}");
    // (3) a credential shape in the text.
    let (m, _) = say(&su, w.ws, w.general, w.alice, "키를 공유했어요").await;
    let secret = forge(
        &su,
        &w,
        w.general,
        &format!("토큰은 {} 예요", secret_token()),
        &[m],
    )
    .await;
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), secret).await,
        Err("23514".into()),
        "credential shape"
    );
    assert_eq!(
        su_count(
            &su,
            "SELECT count(*) FROM mem_item WHERE body LIKE '%ghp_%'"
        )
        .await,
        0
    );

    // Already-decided: cut the status clause and the double accept no longer says 55000.
    let (pid, _) = pending(&su, &wk, &w, "이중 수락 사례 결정이에요").await;
    accept(&app, w.ws, Some(w.bob), pid)
        .await
        .expect("first accept");
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), pid).await,
        Err("55000".into())
    );
    let tx = sabotage_tx(
        &su,
        ACCEPT_FN,
        &[("IF v_p.status <> 'pending' THEN", "IF false THEN")],
    )
    .await;
    let out = decide_in(tx, w.ws, Some(w.bob), "mem_accept_proposal", pid, None).await;
    eprintln!("RED status clause removed: second accept returns {out:?}");
    assert_ne!(out, Err("55000".into()));

    // An identical live memory is pointed at, not duplicated (append-only).
    let (m1, _) = say(&su, w.ws, w.general, w.alice, "같은 내용 근거예요").await;
    let (run, _) = mention_run(&su, &w, w.general, w.alice, "@agent 이것도").await;
    let first = propose(
        &wk,
        w.ws,
        run,
        "fact",
        "고객사 회신 기한은 2026-10-10 예요",
        &[m1],
    )
    .await
    .expect("propose")
    .expect("new");
    let item_a = accept(&app, w.ws, Some(w.alice), first)
        .await
        .expect("accept");
    let hash: String = sqlx::query_scalar("SELECT content_hash FROM mem_item WHERE id = $1")
        .bind(item_a)
        .fetch_one(&su)
        .await
        .expect("hash");
    let twin = Uuid::new_v4();
    sqlx::query(&format!(
        "INSERT INTO mem_proposal (id, workspace_id, channel_id, agent_member_id, requester_member_id, kind, body, evidence_message_ids, content_hash) \
         VALUES ($1, $2, $3, $4, $5, 'fact', $6, {}, $7)",
        arr(&[m1])
    ))
    .bind(twin)
    .bind(w.ws)
    .bind(w.general)
    .bind(w.agent)
    .bind(w.alice)
    .bind("고객사 회신 기한은 2026-10-10 예요")
    .bind(hash)
    .execute(&su)
    .await
    .expect("twin");
    let item_b = accept(&app, w.ws, Some(w.bob), twin)
        .await
        .expect("accept twin");
    assert_eq!(item_a, item_b, "the existing live item is the answer");
    assert_eq!(
        su_count(
            &su,
            &format!("SELECT count(*) FROM mem_item WHERE id = '{item_a}'")
        )
        .await,
        1
    );

    // A proposal made in a 1:1 agent DM becomes a personal memory of that person.
    let (d1, _) = say(&su, w.ws, w.dm_aa, w.alice, "내 선호는 아침 회의예요").await;
    let (drun, _) = mention_run(&su, &w, w.dm_aa, w.alice, "@agent 기억해 줘").await;
    let dp = propose(
        &wk,
        w.ws,
        drun,
        "preference",
        "앨리스는 아침 회의를 선호해요",
        &[d1],
    )
    .await
    .expect("dm propose")
    .expect("new");
    let ditem = accept(&app, w.ws, Some(w.alice), dp)
        .await
        .expect("dm accept");
    let space: (String, Option<Uuid>) =
        sqlx::query_as("SELECT space_kind, owner_member_id FROM mem_item WHERE id = $1")
            .bind(ditem)
            .fetch_one(&su)
            .await
            .expect("dm item");
    assert_eq!(space, ("personal".into(), Some(w.alice)));
    assert_eq!(
        count_as(
            &app,
            w.ws,
            Some(w.alice),
            &format!("SELECT count(*) FROM mem_item WHERE id = '{ditem}'")
        )
        .await,
        1
    );
    assert_eq!(
        count_as(
            &app,
            w.ws,
            Some(w.bob),
            &format!("SELECT count(*) FROM mem_item WHERE id = '{ditem}'")
        )
        .await,
        0
    );
    assert_eq!(item_count(w.ws_b).await, 0);
}

// ---------------------------------------------------------------------------
// what an agent may cite
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn an_agent_cannot_propose_what_it_could_not_cite() {
    let (su, app, wk, w) = setup().await;
    let (good, _) = say(
        &su,
        w.ws,
        w.general,
        w.alice,
        "이번 스프린트 범위를 확정했어요",
    )
    .await;
    let (other_msg, _) = say(&su, w.ws, w.other, w.alice, "다른 채널의 이야기예요").await;
    let (hr_msg, _) = say(&su, w.ws, w.hr, w.alice, "에이전트가 못 읽는 채널이에요").await;
    let (agent_msg, _) = say(&su, w.ws, w.general, w.agent, "에이전트 자신의 말이에요").await;
    let (run, _trigger) = mention_run(&su, &w, w.general, w.alice, "@agent 이거 기억해 줘").await;
    let body = "이번 스프린트 범위는 결제 개선으로 확정했어요";

    // The happy path first, so every refusal below is a refusal of *that* input.
    let ok = propose(&wk, w.ws, run, "decision", body, &[good]).await;
    assert!(matches!(ok, Ok(Some(_))), "{ok:?}");
    su_exec(
        &su,
        &format!("DELETE FROM mem_proposal WHERE run_id = '{run}'"),
    )
    .await;

    let key_sentence = format!("키는 {} 예요", secret_token());
    // Each scenario: (label, the call, the SQLSTATE, the sabotage that lets it through).
    let mut scenarios: Vec<Scenario> = Vec::new();
    scenarios.push((
        "evidence in another channel the agent can read".into(),
        propose(&wk, w.ws, run, "decision", body, &[other_msg]).await,
        "23503",
        vec![(
            "AND m.channel_id = v_channel AND m.workspace_id = v_ws",
            "AND m.workspace_id = v_ws",
        )],
    ));
    scenarios.push((
        "evidence in a channel the agent is not in".into(),
        propose(&wk, w.ws, run, "decision", body, &[hr_msg]).await,
        "23503",
        // Cut both walls: the channel equality and the agent-readability clause.
        vec![
            (
                "AND m.channel_id = v_channel AND m.workspace_id = v_ws",
                "AND m.workspace_id = v_ws",
            ),
            (
                "AND public.mem_member_can_read(m.channel_id, v_agent)",
                "AND true",
            ),
        ],
    ));
    scenarios.push((
        "the agent's own words as evidence".into(),
        propose(&wk, w.ws, run, "decision", body, &[agent_msg]).await,
        "23514",
        vec![("AND au.kind <> 'human'", "AND false")],
    ));
    scenarios.push((
        "an unknown message id".into(),
        propose(&wk, w.ws, run, "decision", body, &[Uuid::new_v4()]).await,
        "23503",
        vec![], // no clause to cut: the count comparison is the wall; asserted refused only
    ));
    scenarios.push((
        "a credential shape".into(),
        propose(&wk, w.ws, run, "fact", &key_sentence, &[good]).await,
        "23514",
        vec![(
            "IF public.mem_looks_like_secret(v_body) OR",
            "IF false AND public.mem_looks_like_secret(v_body) OR",
        )],
    ));
    for (label, out, code, _) in &scenarios {
        assert_eq!(out, &Err((*code).to_string()), "{label}");
    }
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_proposal WHERE workspace_id = '{}'",
                w.ws
            )
        )
        .await,
        0,
        "no refusal stored anything"
    );
    for (label, _, _, edits) in &scenarios {
        if edits.is_empty() {
            continue;
        }
        let tx = sabotage_tx(&su, PROPOSE_FN, edits).await;
        let evidence: &[Uuid] = match label.as_str() {
            l if l.contains("another channel") => &[other_msg],
            l if l.contains("not in") => &[hr_msg],
            l if l.contains("agent's own") => &[agent_msg],
            _ => &[good],
        };
        let (kind, text) = if label.contains("credential") {
            ("fact", key_sentence.as_str())
        } else {
            ("decision", body)
        };
        let out = propose_in(tx, w.ws, run, kind, text, evidence).await;
        eprintln!("RED {label}: sabotaged propose returns {out:?}");
        assert!(matches!(out, Ok(Some(_))), "{label}: sabotaged: {out:?}");
    }
    // The two walls for a channel the agent is not in are independent.
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND m.channel_id = v_channel AND m.workspace_id = v_ws",
            "AND m.workspace_id = v_ws",
        )],
    )
    .await;
    assert_eq!(
        propose_in(tx, w.ws, run, "decision", body, &[hr_msg]).await,
        Err("23503".into()),
        "the agent-readability wall alone still refuses"
    );

    // Author and channel are not arguments: the signature carries text and ids only.
    let args: Vec<String> = sqlx::query_scalar(
        "SELECT pg_catalog.pg_get_function_identity_arguments('public.mem_propose_item(uuid, text, text, text, uuid[])'::regprocedure)",
    )
    .fetch_all(&su)
    .await
    .expect("args");
    assert_eq!(args, vec!["p_run_id uuid, p_kind text, p_body text, p_subject_key text, p_evidence_message_ids uuid[]".to_string()]);
    // A run of another workspace is not a run here.
    let chan_b = channel(&su, w.ws_b, "public", w.bob_b).await;
    let run_b = run_for(&su, w.ws_b, chan_b, w.bob_b, None, "running").await;
    assert_eq!(
        propose(&wk, w.ws, run_b, "decision", body, &[good]).await,
        Err("23503".into()),
        "a run of another workspace"
    );

    // Window: nothing after the trigger, nothing 200+ messages before it.
    let (after, _) = say(&su, w.ws, w.general, w.bob, "트리거 뒤에 온 메시지예요").await;
    assert_eq!(
        propose(&wk, w.ws, run, "decision", body, &[after]).await,
        Err("23503".into()),
        "after the trigger"
    );
    let tx = sabotage_tx(&su, PROPOSE_FN, &[(WINDOW_CLAUSE, "AND true")]).await;
    let out = propose_in(tx, w.ws, run, "decision", body, &[after]).await;
    eprintln!("RED trigger window removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
    let (old, _) = say(&su, w.ws, w.other, w.dave, "아주 오래된 메시지예요").await;
    let _ = old;
    let (early, _) = say(&su, w.ws, w.general, w.alice, "아주 오래전 결정이에요").await;
    fill(&su, w.ws, w.general, w.bob, 210).await;
    let (run_late, _) = mention_run(
        &su,
        &w,
        w.general,
        w.alice,
        "@agent 오래전 결정도 기억해 줘",
    )
    .await;
    assert_eq!(
        propose(
            &wk,
            w.ws,
            run_late,
            "decision",
            "오래전 결정을 기억해요",
            &[early]
        )
        .await,
        Err("23503".into()),
        "more than 200 messages back"
    );
    let tx = sabotage_tx(&su, PROPOSE_FN, &[(WINDOW_CLAUSE, "AND true")]).await;
    let out = propose_in(
        tx,
        w.ws,
        run_late,
        "decision",
        "오래전 결정을 기억해요",
        &[early],
    )
    .await;
    assert!(matches!(out, Ok(Some(_))), "{out:?}");

    // Deleted / edited-after-the-run evidence.
    let (gone, _) = say(&su, w.ws, w.general, w.alice, "곧 지울 메시지예요").await;
    let (run_x, _) = mention_run(&su, &w, w.general, w.alice, "@agent 방금 결정 기억").await;
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{gone}'"),
    )
    .await;
    assert_eq!(
        propose(
            &wk,
            w.ws,
            run_x,
            "decision",
            "지워진 근거로 제안해요",
            &[gone]
        )
        .await,
        Err("23503".into()),
        "deleted evidence"
    );
    let (edited, _) = say(&su, w.ws, w.general, w.alice, "고칠 메시지예요").await;
    let (run_e, _) = mention_run(&su, &w, w.general, w.alice, "@agent 이것도 기억").await;
    su_exec(
        &su,
        &format!(
            "UPDATE message SET edited_at = now() + interval '1 second' WHERE id = '{edited}'"
        ),
    )
    .await;
    assert_eq!(
        propose(
            &wk,
            w.ws,
            run_e,
            "decision",
            "고쳐진 근거로 제안해요",
            &[edited]
        )
        .await,
        Err("40001".into()),
        "edited after the run began"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND m.edited_at IS NOT NULL AND m.edited_at > v_run_created",
            "AND false",
        )],
    )
    .await;
    let out = propose_in(
        tx,
        w.ws,
        run_e,
        "decision",
        "고쳐진 근거로 제안해요",
        &[edited],
    )
    .await;
    eprintln!("RED edited-evidence clause removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");

    let (fresh, _) = say(&su, w.ws, w.general, w.alice, "새 근거 메시지예요").await;

    // Argument shape.
    for (label, kind, text, ev) in [
        ("unknown kind", "gossip", body, vec![good]),
        ("empty text", "fact", "   ", vec![good]),
        ("601 characters", "fact", &"가".repeat(601), vec![good]),
        ("no evidence", "fact", body, vec![]),
        ("nine evidence", "fact", body, vec![good; 9]),
        ("repeated evidence", "fact", body, vec![good, good]),
    ] {
        let out = propose(&wk, w.ws, run, kind, text, &ev).await;
        assert_eq!(out, Err("23514".into()), "{label}");
    }

    // The run decides whether and for whom.
    let (t_agent, _) = say(&su, w.ws, w.general, w.agent, "에이전트가 시작한 대화예요").await;
    let run_nobody = run_for(&su, w.ws, w.general, w.agent, Some(t_agent), "running").await;
    assert_eq!(
        propose(&wk, w.ws, run_nobody, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "no human requester"
    );
    let run_none = run_for(&su, w.ws, w.general, w.agent, None, "running").await;
    assert_eq!(
        propose(&wk, w.ws, run_none, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "a run nobody spoke to"
    );
    let (t_done, _) = say(&su, w.ws, w.general, w.alice, "@agent 끝난 run 이에요").await;
    let run_done = run_for(&su, w.ws, w.general, w.agent, Some(t_done), "succeeded").await;
    assert_eq!(
        propose(&wk, w.ws, run_done, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "a finished run"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "IF v_status IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN",
            "IF false THEN",
        )],
    )
    .await;
    let out = propose_in(tx, w.ws, run_done, "decision", body, &[fresh]).await;
    eprintln!("RED run-ended clause removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
    assert_eq!(
        propose(&wk, w.ws, Uuid::new_v4(), "decision", body, &[fresh]).await,
        Err("23503".into()),
        "unknown run"
    );

    // Switches: channel excluded, workspace paused, the requester's own pause.
    let (run_s, _) = mention_run(&su, &w, w.general, w.alice, "@agent 스위치 시험").await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.general)).await;
    assert_eq!(
        propose(&wk, w.ws, run_s, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "channel excluded"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "IF NOT public.mem_channel_eligible(v_channel) THEN",
            "IF false THEN",
        )],
    )
    .await;
    let out = propose_in(tx, w.ws, run_s, "decision", body, &[fresh]).await;
    eprintln!("RED eligibility clause removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
    su_exec(
        &su,
        &format!(
            "DELETE FROM mem_settings WHERE channel_id = '{}'",
            w.general
        ),
    )
    .await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ('{}', 'member', '{}', true)", w.ws, w.alice)).await;
    assert_eq!(
        propose(&wk, w.ws, run_s, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "the requester paused memory"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "IF EXISTS (SELECT 1 FROM public.mem_settings s",
            "IF false AND EXISTS (SELECT 1 FROM public.mem_settings s",
        )],
    )
    .await;
    let out = propose_in(tx, w.ws, run_s, "decision", body, &[fresh]).await;
    eprintln!("RED personal-pause clause removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE member_id = '{}'", w.alice),
    )
    .await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws)).await;
    assert_eq!(
        propose(&wk, w.ws, run_s, "decision", body, &[fresh]).await,
        Err("55000".into()),
        "workspace paused"
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
    )
    .await;

    // Dedupe: the same content is proposed once.
    let (run_d, _) = mention_run(&su, &w, w.general, w.alice, "@agent 중복 시험").await;
    let first = propose(
        &wk,
        w.ws,
        run_d,
        "decision",
        "중복 제안 시험 내용이에요",
        &[fresh],
    )
    .await;
    assert!(matches!(first, Ok(Some(_))), "{first:?}");
    assert_eq!(
        propose(
            &wk,
            w.ws,
            run_d,
            "decision",
            "중복  제안   시험 내용이에요",
            &[fresh]
        )
        .await,
        Ok(None),
        "same content modulo whitespace"
    );

    // Only the api role reads what it may.
    let _ = &app;
}

// ---------------------------------------------------------------------------
// rate limits
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn proposals_are_rate_limited() {
    let (su, _app, wk, w) = setup().await;
    let (good, _) = say(&su, w.ws, w.general, w.alice, "제안할 결정의 근거예요").await;

    // Three per run.
    let (run, _) = mention_run(&su, &w, w.general, w.alice, "@agent 여러 개 기억해 줘").await;
    for n in 0..3 {
        let out = propose(
            &wk,
            w.ws,
            run,
            "fact",
            &format!("한 run 의 {n}번째 사실이에요"),
            &[good],
        )
        .await;
        assert!(matches!(out, Ok(Some(_))), "{n}: {out:?}");
    }
    assert_eq!(
        propose(
            &wk,
            w.ws,
            run,
            "fact",
            "한 run 의 네 번째 사실이에요",
            &[good]
        )
        .await,
        Err("54000".into()),
        "a fourth proposal in one run"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND p.run_id = p_run_id) >= 3",
            "AND p.run_id = p_run_id) >= 3000",
        )],
    )
    .await;
    let out = propose_in(
        tx,
        w.ws,
        run,
        "fact",
        "한 run 의 네 번째 사실이에요",
        &[good],
    )
    .await;
    eprintln!("RED per-run limit removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");

    // Twenty waiting per channel: 3 already pending; 17 more across fresh runs, then the wall.
    let mut n = 0;
    while su_count(
        &su,
        &format!(
            "SELECT count(*) FROM mem_proposal WHERE channel_id = '{}' AND status = 'pending'",
            w.general
        ),
    )
    .await
        < 20
    {
        let (r, _) = mention_run(&su, &w, w.general, w.alice, "@agent 또 기억해 줘").await;
        let out = propose(
            &wk,
            w.ws,
            r,
            "fact",
            &format!("채널 대기 제안 {n} 번이에요"),
            &[good],
        )
        .await;
        assert!(matches!(out, Ok(Some(_))), "{n}: {out:?}");
        n += 1;
    }
    let (r, _) = mention_run(&su, &w, w.general, w.alice, "@agent 스물한 번째").await;
    assert_eq!(
        propose(&wk, w.ws, r, "fact", "스물한 번째 대기 제안이에요", &[good]).await,
        Err("54000".into()),
        "the channel already has twenty waiting"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND p.status = 'pending' AND p.expires_at > pg_catalog.now()) >= 20",
            "AND p.status = 'pending' AND p.expires_at > pg_catalog.now()) >= 2000",
        )],
    )
    .await;
    let out = propose_in(tx, w.ws, r, "fact", "스물한 번째 대기 제안이에요", &[good]).await;
    eprintln!("RED channel limit removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");

    // Thirty an hour per agent: a busy agent in another channel.
    let (good_o, _) = say(&su, w.ws, w.other, w.alice, "다른 채널의 결정 근거예요").await;
    su_exec(&su, &format!("UPDATE mem_proposal SET status = 'rejected', body = NULL, subject_key = NULL, evidence_message_ids = '{{}}', decided_by = '{}', decided_at = now() WHERE channel_id = '{}'", w.bob, w.general)).await;
    // 30 decided rows within the hour count for the agent (decided ones are not "waiting", but they are proposals made).
    let made: i64 = su_count(&su, &format!("SELECT count(*) FROM mem_proposal WHERE agent_member_id = '{}' AND created_at > now() - interval '1 hour'", w.agent)).await;
    assert!(made >= 20, "{made}");
    for i in made..30 {
        su_exec(&su, &format!(
            "INSERT INTO mem_proposal (workspace_id, channel_id, agent_member_id, requester_member_id, kind, status, decided_by, decided_at, content_hash) \
             VALUES ('{}', '{}', '{}', '{}', 'fact', 'rejected', '{}', now(), 'filler-{i}')",
            w.ws, w.other, w.agent, w.alice, w.bob
        )).await;
    }
    let (r2, _) = mention_run(&su, &w, w.other, w.alice, "@agent 시간당 한도").await;
    assert_eq!(
        propose(
            &wk,
            w.ws,
            r2,
            "fact",
            "시간당 한도 시험 사실이에요",
            &[good_o]
        )
        .await,
        Err("54000".into()),
        "thirty in an hour"
    );
    let tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND p.created_at > pg_catalog.now() - interval '1 hour') >= 30",
            "AND p.created_at > pg_catalog.now() - interval '1 hour') >= 3000",
        )],
    )
    .await;
    let out = propose_in(
        tx,
        w.ws,
        r2,
        "fact",
        "시간당 한도 시험 사실이에요",
        &[good_o],
    )
    .await;
    eprintln!("RED hourly limit removed: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
}

// ---------------------------------------------------------------------------
// the table itself
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn the_proposal_table_is_closed_and_hides_what_it_should() {
    let (su, app, wk, w) = setup().await;
    let plain_worker = worker_pool(false).await;
    let (pid, msgs) = pending(&su, &wk, &w, "표를 닫는 시험 결정이에요").await;
    let visible = |viewer: Option<Uuid>| {
        let app = app.clone();
        let ws = w.ws;
        async move { count_as(&app, ws, viewer, "SELECT count(*) FROM mem_proposal").await }
    };
    assert_eq!(visible(Some(w.alice)).await, 1);

    // momo_app reads (RLS) and cannot write; the BYPASSRLS login and the memory role read nothing.
    for sql in [
        format!("INSERT INTO mem_proposal (workspace_id, channel_id, agent_member_id, requester_member_id, kind, body, evidence_message_ids, content_hash) VALUES ('{}', '{}', '{}', '{}', 'fact', 'x', ARRAY['{}']::uuid[], 'h')", w.ws, w.general, w.agent, w.alice, msgs[0]),
        format!("UPDATE mem_proposal SET status = 'rejected' WHERE id = '{pid}'"),
        format!("DELETE FROM mem_proposal WHERE id = '{pid}'"),
    ] {
        assert_eq!(exec(&app, w.ws, Some(w.alice), &sql).await, Err("42501".into()), "{sql}");
    }
    assert_eq!(
        exec(
            &plain_worker,
            w.ws,
            None,
            "SELECT count(*) FROM mem_proposal"
        )
        .await,
        Err("42501".into()),
        "momo_worker (BYPASSRLS) reads no mem_proposal"
    );
    assert_eq!(
        exec(&wk, w.ws, None, "SELECT count(*) FROM mem_proposal").await,
        Err("42501".into()),
        "momo_memory has no table access"
    );

    // The worker-only functions are closed to the API and to the plain BYPASSRLS login; the internal
    // decider to everyone but its owner.
    let calls = [
        (
            "mem_propose_item",
            propose_sql(Uuid::new_v4(), "fact", &msgs).replace("$1", "'x'"),
        ),
        (
            "mem_serve_items",
            format!(
                "SELECT count(*) FROM mem_serve_items('{}', 8, 600)",
                Uuid::new_v4()
            ),
        ),
        (
            "mem_serving_record_of",
            format!(
                "SELECT count(*) FROM mem_serving_record_of('{}')",
                Uuid::new_v4()
            ),
        ),
    ];
    for (name, sql) in &calls {
        assert_eq!(
            exec(&app, w.ws, Some(w.alice), sql).await,
            Err("42501".into()),
            "momo_app must not run {name}"
        );
        assert_eq!(
            exec(&plain_worker, w.ws, None, sql).await,
            Err("42501".into()),
            "momo_worker without SET ROLE must not run {name}"
        );
        let out = exec(&wk, w.ws, None, sql).await;
        assert!(
            !matches!(out, Err(ref c) if c == "42501"),
            "momo_memory must run {name}: {out:?}"
        );
    }
    let decider = format!("SELECT mem_proposal_decider('{pid}')");
    for (label, pool, member) in [
        ("momo_app", &app, Some(w.alice)),
        ("momo_memory", &wk, None),
    ] {
        assert_eq!(
            exec(pool, w.ws, member, &decider).await,
            Err("42501".into()),
            "{label} must not run the decider"
        );
    }

    // The read policy: a channel reader only.
    assert_eq!(visible(Some(w.dave)).await, 0);
    let sabotage_policy = |ws: Uuid, viewer: Option<Uuid>, using: &'static str| {
        let su = su.clone();
        async move {
            let mut tx = su.begin().await.expect("begin");
            sqlx::query(&format!(
                "ALTER POLICY mem_proposal_sel ON mem_proposal USING ({using})"
            ))
            .execute(&mut *tx)
            .await
            .expect("alter policy");
            become_role(&mut tx, "momo_app", ws, viewer).await;
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_proposal")
                .fetch_one(&mut *tx)
                .await
                .expect("count");
            tx.rollback().await.ok();
            n
        }
    };
    let red = sabotage_policy(
        w.ws,
        Some(w.dave),
        "workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid",
    )
    .await;
    eprintln!("RED channel-reader clause removed: dave sees {red} proposal(s)");
    assert_eq!(red, 1);

    // A pending proposal whose evidence is deleted disappears; a decided shell does not need evidence.
    su_exec(
        &su,
        &format!(
            "UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{}'",
            msgs[0]
        ),
    )
    .await;
    assert_eq!(
        visible(Some(w.alice)).await,
        0,
        "deleted evidence hides the proposal text"
    );
    let mut tx = sabotage_tx(
        &su,
        "public.mem_proposal_evidence_ok(uuid)",
        &[("SELECT COALESCE((", "SELECT true OR COALESCE((")],
    )
    .await;
    become_role(&mut tx, "momo_app", w.ws, Some(w.alice)).await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_proposal")
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.rollback().await.ok();
    eprintln!("RED evidence helper neutered: {n} proposal(s) visible over deleted evidence");
    assert_eq!(n, 1);
    su_exec(
        &su,
        &format!(
            "UPDATE message SET deleted_at = NULL, state = 'sent' WHERE id = '{}'",
            msgs[0]
        ),
    )
    .await;
    assert_eq!(visible(Some(w.alice)).await, 1);

    // Expired proposals disappear too.
    su_exec(
        &su,
        &format!(
            "UPDATE mem_proposal SET expires_at = now() - interval '1 second' WHERE id = '{pid}'"
        ),
    )
    .await;
    assert_eq!(visible(Some(w.alice)).await, 0, "an expired proposal");
    let red = sabotage_policy(w.ws, Some(w.alice), "workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND mem_can_read_channel(channel_id)").await;
    assert_eq!(
        red, 1,
        "RED expiry clause removed: the expired proposal is visible again"
    );
    eprintln!("RED expiry/evidence clauses removed: {red} visible");
}

// ---------------------------------------------------------------------------
// serving and the receipt
// ---------------------------------------------------------------------------

/// What the summary worker does first: a window digest over `msgs`, in a memory tx.
async fn apply_digest(wk: &PgPool, ws: Uuid, channel: Uuid, msgs: &[(Uuid, i64)]) -> Uuid {
    let ids: Vec<Uuid> = msgs.iter().map(|m| m.0).collect();
    let from = msgs.iter().map(|m| m.1).min().expect("msgs");
    let to = msgs.iter().map(|m| m.1).max().expect("msgs");
    let nulls = vec!["NULL::timestamptz"; ids.len()].join(",");
    let sql = format!(
        "SELECT mem_apply_digest('{channel}', NULL, 'window', {from}, {to}, '요약', '{{}}'::uuid[], \
         'm', 'instance_default', 'digest-v1', {}, ARRAY[{nulls}]::timestamptz[], now())",
        arr(&ids)
    );
    let mut tx = viewer_tx(wk, ws, None).await;
    let id: Uuid = sqlx::query_scalar(&sql)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("apply digest: {e}"));
    tx.commit().await.expect("commit");
    id
}

/// An extracted item in `channel` about `body`, through the real write path.
async fn extracted_item(
    su: &PgPool,
    wk: &PgPool,
    w: &W,
    channel: Uuid,
    author: Uuid,
    body: &str,
) -> Uuid {
    let m = say(su, w.ws, channel, author, &format!("{body} (근거)")).await;
    let digest = apply_digest(wk, w.ws, channel, &[m]).await;
    let mut tx = viewer_tx(wk, w.ws, None).await;
    let id: Option<Uuid> = sqlx::query_scalar(&format!(
        "SELECT mem_add_item('{digest}', 'fact', $1, NULL, {}, 0.8::real, false, 'items-v1', 'test-model')",
        arr(&[m.0])
    ))
    .bind(body)
    .fetch_one(&mut *tx)
    .await
    .unwrap_or_else(|e| panic!("add item: {e}"));
    tx.commit().await.expect("commit");
    id.expect("a new item")
}

async fn serve_rows(wk: &PgPool, ws: Uuid, run: Uuid) -> Vec<(Uuid, Uuid, String)> {
    let mut tx = viewer_tx(wk, ws, None).await;
    let rows: Vec<(Uuid, Uuid, String)> = sqlx::query_as(&format!(
        "SELECT item_id, item_channel_id, kind FROM mem_serve_items('{run}', 8, 600)"
    ))
    .fetch_all(&mut *tx)
    .await
    .unwrap_or_else(|e| panic!("serve: {e}"));
    tx.rollback().await.ok();
    rows
}

const SERVE_ITEMS_FN: &str = "public.mem_serve_items(uuid, integer, integer)";
const RECORD_FN: &str =
    "public.mem_record_serving(uuid, uuid, uuid[], uuid[], integer, integer, integer)";

async fn record(
    wk: &PgPool,
    ws: Uuid,
    run: Uuid,
    requester: Option<Uuid>,
    digests: &[Uuid],
    items: &[Uuid],
) -> Result<Uuid, String> {
    let requester = requester.map_or("NULL".to_string(), |r| format!("'{r}'"));
    let mut tx = viewer_tx(wk, ws, None).await;
    let r = sqlx::query_scalar::<_, Uuid>(&format!(
        "SELECT mem_record_serving('{run}', {requester}, {}, {}, 0, 6000, 100)",
        arr(digests),
        arr(items)
    ))
    .fetch_one(&mut *tx)
    .await;
    match r {
        Ok(id) => {
            tx.commit().await.expect("commit");
            Ok(id)
        }
        Err(e) => Err(sqlstate(&e)),
    }
}

async fn record_in(
    mut tx: sqlx::Transaction<'static, sqlx::Postgres>,
    ws: Uuid,
    run: Uuid,
    requester: Option<Uuid>,
    items: &[Uuid],
) -> Result<Uuid, String> {
    become_role(&mut tx, "momo_memory", ws, None).await;
    let requester = requester.map_or("NULL".to_string(), |r| format!("'{r}'"));
    let r = sqlx::query_scalar::<_, Uuid>(&format!(
        "SELECT mem_record_serving('{run}', {requester}, '{{}}'::uuid[], {}, 0, 6000, 100)",
        arr(items)
    ))
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    r
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn served_items_follow_the_audience_rule_and_the_receipt_checks_them() {
    let (su, _app, wk, w) = setup().await;
    let general_item =
        extracted_item(&su, &wk, &w, w.general, w.alice, "배포 일정은 금요일이에요").await;
    let hr_item = extracted_item(&su, &wk, &w, w.hr, w.alice, "배포 담당 평가는 비공개예요").await;
    let dm_item = extracted_item(
        &su,
        &wk,
        &w,
        w.dm_aa,
        w.alice,
        "배포 알림은 아침에 받고 싶어요",
    )
    .await;

    // A group channel answer: only the channel's own items. Another channel's item (hr, which alice
    // reads) and a personal DM item stay out — the requester's union is for the 1:1 agent DM only.
    let (group_run, _) =
        mention_run(&su, &w, w.general, w.alice, "@agent 배포 일정이 언제죠").await;
    let group: Vec<Uuid> = serve_rows(&wk, w.ws, group_run)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(
        group,
        vec![general_item],
        "group channel: the answer's own channel only"
    );

    // The 1:1 agent DM: the requester's own permission union (general, hr, the DM's personal space).
    let (dm_run, _) = mention_run(&su, &w, w.dm_aa, w.alice, "배포 일정 알려줘").await;
    let mut dm: Vec<Uuid> = serve_rows(&wk, w.ws, dm_run)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    dm.sort();
    let mut want = vec![general_item, hr_item, dm_item];
    want.sort();
    assert_eq!(dm, want, "1:1 agent DM: the union of what alice may read");
    // bob asking in general does not get alice's hr / personal items either.
    let (bob_run, _) = mention_run(&su, &w, w.general, w.bob, "배포 일정 알려줘").await;
    assert_eq!(
        serve_rows(&wk, w.ws, bob_run)
            .await
            .into_iter()
            .map(|r| r.0)
            .collect::<Vec<_>>(),
        vec![general_item]
    );
    // carol cannot see hr at all; asking in general she gets general's item only.
    let (carol_run, _) = mention_run(&su, &w, w.general, w.carol, "배포 일정 알려줘").await;
    assert_eq!(serve_rows(&wk, w.ws, carol_run).await.len(), 1);

    // The query is the trigger message: an unrelated question finds nothing; a mention alone is no query.
    let (unrelated, _) = mention_run(&su, &w, w.general, w.alice, "@agent 점심 뭐 먹죠").await;
    assert!(serve_rows(&wk, w.ws, unrelated).await.is_empty());
    let (only_mention, _) = mention_run(&su, &w, w.general, w.alice, "@agent").await;
    assert!(serve_rows(&wk, w.ws, only_mention).await.is_empty());

    // Switches: nothing is served, and the sabotaged function serves.
    struct Sw {
        label: &'static str,
        setup: String,
        undo: String,
        edits: Vec<(&'static str, &'static str)>,
    }
    let switches = vec![
        Sw {
            label: "answer channel excluded",
            setup: format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.general),
            undo: format!("DELETE FROM mem_settings WHERE channel_id = '{}'", w.general),
            edits: vec![("IF NOT public.mem_channel_switch(v_channel) THEN", "IF false THEN")],
        },
        Sw {
            label: "requester paused personally",
            setup: format!("INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ('{}', 'member', '{}', true)", w.ws, w.alice),
            undo: format!("DELETE FROM mem_settings WHERE member_id = '{}'", w.alice),
            edits: vec![("IF EXISTS (SELECT 1 FROM public.mem_settings s", "IF false AND EXISTS (SELECT 1 FROM public.mem_settings s")],
        },
        Sw {
            label: "workspace paused",
            setup: format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws),
            undo: format!("DELETE FROM mem_settings WHERE workspace_id = '{}' AND scope = 'workspace'", w.ws),
            edits: vec![("IF NOT public.mem_channel_switch(v_channel) THEN", "IF false THEN")],
        },
    ];
    for sw in &switches {
        su_exec(&su, &sw.setup).await;
        assert!(
            serve_rows(&wk, w.ws, group_run).await.is_empty(),
            "{}: nothing served in the group",
            sw.label
        );
        assert!(
            serve_rows(&wk, w.ws, dm_run).await.is_empty() || sw.label == "answer channel excluded",
            "{}: nothing served in the DM",
            sw.label
        );
        // Even the items search itself filters (mem_item_audience_ok), so cut the search's own switch
        // check as well: a switch is enforced twice, and the function-level cut alone is not enough
        // to leak — asserting both walls exist independently.
        let mut tx = sabotage_tx(&su, SERVE_ITEMS_FN, &sw.edits).await;
        let inner_only: Vec<(Uuid,)> = {
            become_role(&mut tx, "momo_memory", w.ws, None).await;
            sqlx::query_as(&format!(
                "SELECT item_id FROM mem_serve_items('{group_run}', 8, 600)"
            ))
            .fetch_all(&mut *tx)
            .await
            .expect("rows")
        };
        tx.rollback().await.ok();
        eprintln!("RED {} (outer switch removed): {} row(s) — the search's own audience rule is the second wall", sw.label, inner_only.len());
        assert!(
            inner_only.is_empty(),
            "{}: the audience rule inside the search is an independent wall",
            sw.label
        );
        // Cut the search's own walls too, in the same transaction: now it serves.
        let mut tx = sabotage_tx(&su, SERVE_ITEMS_FN, &sw.edits).await;
        let inner: Vec<(&str, &str)> = if sw.label == "requester paused personally" {
            vec![(
                "IF EXISTS (SELECT 1 FROM public.mem_settings s",
                "IF false AND EXISTS (SELECT 1 FROM public.mem_settings s",
            )]
        } else {
            vec![
                (
                    "IF NOT public.mem_channel_switch(p_answer_channel_id) THEN",
                    "IF false THEN",
                ),
                (
                    "IF NOT public.mem_channel_switch(v_home) THEN",
                    "IF false THEN",
                ),
            ]
        };
        redefine(
            &mut tx,
            "public.mem_item_audience_ok(uuid, uuid, uuid)",
            &inner,
        )
        .await;
        become_role(&mut tx, "momo_memory", w.ws, None).await;
        let both: Vec<(Uuid,)> = sqlx::query_as(&format!(
            "SELECT item_id FROM mem_serve_items('{group_run}', 8, 600)"
        ))
        .fetch_all(&mut *tx)
        .await
        .expect("rows");
        tx.rollback().await.ok();
        eprintln!(
            "RED {} (all walls removed): {} row(s)",
            sw.label,
            both.len()
        );
        assert_eq!(
            both.len(),
            1,
            "{}: with every wall cut the item is served",
            sw.label
        );
        su_exec(&su, &sw.undo).await;
    }
    assert_eq!(
        serve_rows(&wk, w.ws, group_run).await.len(),
        1,
        "switches back on"
    );

    // No human requester → nothing served (welcome / schedule / agent-only chains).
    let (t_agent, _) = say(&su, w.ws, w.general, w.agent, "배포 일정 알림이에요").await;
    let run_agent = run_for(&su, w.ws, w.general, w.agent, Some(t_agent), "running").await;
    assert!(serve_rows(&wk, w.ws, run_agent).await.is_empty());
    assert!(serve_rows(&wk, w.ws, {
        let r = run_for(&su, w.ws, w.general, w.agent, None, "running").await;
        r
    })
    .await
    .is_empty());

    // The receipt: items are checked like digests, and the requester must be the run's own.
    assert_eq!(
        record(&wk, w.ws, group_run, Some(w.alice), &[], &[hr_item]).await,
        Err("23514".into()),
        "an hr item into a group answer"
    );
    assert_eq!(
        record(&wk, w.ws, group_run, Some(w.alice), &[], &[dm_item]).await,
        Err("23514".into()),
        "a personal item into a group answer"
    );
    assert_eq!(
        record(&wk, w.ws, group_run, Some(w.bob), &[], &[general_item]).await,
        Err("22023".into()),
        "another member's name"
    );
    assert_eq!(
        record(&wk, w.ws, group_run, None, &[], &[general_item]).await,
        Err("22023".into()),
        "no requester"
    );
    assert_eq!(
        record(&wk, w.ws, group_run, Some(w.alice), &[], &[Uuid::new_v4()]).await,
        Err("23503".into()),
        "unknown item"
    );
    assert_eq!(
        record(
            &wk,
            w.ws,
            group_run,
            Some(w.alice),
            &[],
            &[general_item, general_item]
        )
        .await,
        Err("23503".into()),
        "repeated item"
    );
    // RED: each check is what refuses.
    let tx = sabotage_tx(
        &su,
        RECORD_FN,
        &[(
            "NOT public.mem_item_audience_ok(x.id, v_channel, p_requester_member_id)",
            "false",
        )],
    )
    .await;
    let out = record_in(tx, w.ws, group_run, Some(w.alice), &[hr_item]).await;
    eprintln!(
        "RED item audience check removed: receipt for an hr item in a group answer returns {out:?}"
    );
    assert!(out.is_ok(), "{out:?}");
    let tx = sabotage_tx(
        &su,
        RECORD_FN,
        &[(
            "IF p_requester_member_id IS DISTINCT FROM public.mem_serve_requester(p_run_id) THEN",
            "IF false THEN",
        )],
    )
    .await;
    let out = record_in(tx, w.ws, group_run, Some(w.bob), &[general_item]).await;
    eprintln!("RED requester derivation removed: receipt in bob's name returns {out:?}");
    assert!(out.is_ok(), "{out:?}");

    let recorded = record(&wk, w.ws, group_run, Some(w.alice), &[], &[general_item]).await;
    assert!(recorded.is_ok(), "{recorded:?}");
    let mut tx = viewer_tx(&wk, w.ws, None).await;
    let back: (Vec<Uuid>, Vec<Uuid>) = sqlx::query_as(&format!(
        "SELECT served_digest_ids, served_item_ids FROM mem_serving_record_of('{group_run}')"
    ))
    .fetch_one(&mut *tx)
    .await
    .expect("record of");
    tx.rollback().await.ok();
    assert_eq!(back, (vec![], vec![general_item]));
    assert_eq!(
        record(&wk, w.ws, group_run, Some(w.alice), &[], &[general_item]).await,
        Err("23505".into()),
        "one receipt per run"
    );
}

// ---------------------------------------------------------------------------
// security review follow-ups (M-1, M-2, L-2, L-7)
// ---------------------------------------------------------------------------

const WINDOW_CLAUSE: &str = "AND (m.seq <= v_trigger_seq AND m.seq > v_trigger_seq - 200)";

/// A child run (no trigger of its own; the requester comes up `parent_run_id`).
async fn child_run(su: &PgPool, w: &W, parent: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    su_exec(
        su,
        &format!(
            "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, parent_run_id, status) \
             VALUES ('{id}', '{}', '{}', '{}', '{parent}', 'running')",
            w.ws, w.agent, w.general
        ),
    )
    .await;
    id
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_run_without_a_trigger_still_has_a_conversation_window() {
    let (su, _app, wk, w) = setup().await;
    let (old, _) = say(
        &su,
        w.ws,
        w.general,
        w.alice,
        "아주 오래전에 정한 결정이에요",
    )
    .await;
    fill(&su, w.ws, w.general, w.bob, 210).await;
    let (recent, _) = say(&su, w.ws, w.general, w.alice, "방금 정한 결정이에요").await;
    let (parent, _) = mention_run(&su, &w, w.general, w.alice, "@agent 위임해 줘").await;
    let child = child_run(&su, &w, parent).await;

    // M-1: the trigger-less run's window is anchored at the channel head when it began.
    assert_eq!(
        propose(
            &wk,
            w.ws,
            child,
            "decision",
            "오래된 근거로 제안해요",
            &[old]
        )
        .await,
        Err("23503".into()),
        "a message more than 200 back is not this run's conversation"
    );
    let ok = propose(
        &wk,
        w.ws,
        child,
        "decision",
        "방금 정한 결정을 제안해요",
        &[recent],
    )
    .await;
    assert!(
        matches!(ok, Ok(Some(_))),
        "a recent message still works: {ok:?}"
    );
    // A message that arrives after the run began is not in its conversation either.
    let (later, _) = say(&su, w.ws, w.general, w.bob, "run 이 끝난 뒤의 메시지예요").await;
    assert_eq!(
        propose(
            &wk,
            w.ws,
            child,
            "decision",
            "뒤의 메시지로 제안해요",
            &[later]
        )
        .await,
        Err("23503".into())
    );
    // RED: the old fail-open (no anchor => no window) lets the old message through.
    let mut tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[
            ("IF v_trigger_seq IS NULL THEN", "IF false THEN"),
            (WINDOW_CLAUSE, "AND (v_trigger_seq IS NULL OR (m.seq <= v_trigger_seq AND m.seq > v_trigger_seq - 200))"),
        ],
    )
    .await;
    become_role(&mut tx, "momo_memory", w.ws, None).await;
    let out = sqlx::query_scalar::<_, Option<Uuid>>(&propose_sql(child, "decision", &[old]))
        .bind("fail-open 으로 오래된 근거를 제안해요")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    eprintln!("RED trigger-less fail-open restored: {out:?}");
    assert!(matches!(out, Ok(Some(_))), "{out:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn guests_read_the_cards_but_never_decide_them() {
    let (su, app, wk, w) = setup().await;
    let ws_guest = member(&su, w.ws, "human").await;
    let ch_guest = member(&su, w.ws, "human").await;
    let regular = member(&su, w.ws, "human").await;
    for (m, role) in [
        (ws_guest, "guest"),
        (ch_guest, "member"),
        (regular, "member"),
    ] {
        su_exec(&su, &format!("INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ('{}', '{m}', '{role}')", w.ws)).await;
        join(&su, w.ws, w.general, m).await;
    }
    su_exec(&su, &format!("UPDATE membership SET role = 'guest' WHERE channel_id = '{}' AND member_id = '{ch_guest}'", w.general)).await;
    let (pid, _) = pending(&su, &wk, &w, "게스트 시험 결정이에요").await;

    // They see the card ...
    for g in [ws_guest, ch_guest] {
        assert_eq!(
            count_as(
                &app,
                w.ws,
                Some(g),
                "SELECT count(*) FROM mem_proposal WHERE status = 'pending'"
            )
            .await,
            1
        );
    }
    // ... and cannot decide it: the database says no, for either kind of guest.
    for (label, g) in [("workspace guest", ws_guest), ("channel guest", ch_guest)] {
        assert_eq!(
            accept(&app, w.ws, Some(g), pid).await,
            Err("42501".into()),
            "{label} accept"
        );
        assert_eq!(
            reject(&app, w.ws, Some(g), pid).await,
            Err("42501".into()),
            "{label} reject"
        );
    }
    assert_eq!(
        su_count(
            &su,
            &format!("SELECT count(*) FROM mem_proposal WHERE id = '{pid}' AND status = 'pending'")
        )
        .await,
        1
    );
    // RED: each guest clause is what refuses (the accept's own evidence check does not know roles).
    for (label, g, edit) in [
        (
            "workspace-guest clause removed",
            ws_guest,
            ("AND wm.role = 'guest')", "AND false)"),
        ),
        (
            "channel-guest clause removed",
            ch_guest,
            (
                "AND gm.left_at IS NULL AND gm.role = 'guest') THEN",
                "AND false) THEN",
            ),
        ),
    ] {
        let tx = sabotage_tx(&su, DECIDER_FN, &[edit]).await;
        let out = decide_in(tx, w.ws, Some(g), "mem_accept_proposal", pid, None).await;
        eprintln!("RED {label}: accept returns {out:?}");
        assert!(out.is_ok(), "{label}: {out:?}");
    }
    // A regular member of the same channel still decides.
    accept(&app, w.ws, Some(regular), pid)
        .await
        .expect("a member accepts");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn identical_proposals_race_without_a_unique_violation_and_expiry_is_logged() {
    let (su, _app, wk, w) = setup().await;
    let (m, _) = say(
        &su,
        w.ws,
        w.general,
        w.alice,
        "동시에 제안될 결정의 근거예요",
    )
    .await;
    // L-2: eight runs propose the same text at once; exactly one row, nobody sees 23505.
    let mut runs = Vec::new();
    for _ in 0..8 {
        let (r, _) = mention_run(&su, &w, w.general, w.alice, "@agent 기억해 줘").await;
        runs.push(r);
    }
    let text = "동시에 들어온 같은 결정이에요";
    let results = futures_join(&wk, w.ws, &runs, text, m).await;
    let created = results.iter().filter(|r| matches!(r, Ok(Some(_)))).count();
    let dup = results.iter().filter(|r| matches!(r, Ok(None))).count();
    assert_eq!((created, dup), (1, 7), "{results:?}");
    assert_eq!(su_count(&su, &format!("SELECT count(*) FROM mem_proposal WHERE workspace_id = '{}' AND status = 'pending'", w.ws)).await, 1);

    // L-7: an expired pending proposal is closed out of the way of the same text, as an `expired`
    // event by the agent (not a human `rejected`).
    su_exec(&su, &format!("UPDATE mem_proposal SET expires_at = now() - interval '1 second' WHERE workspace_id = '{}'", w.ws)).await;
    let (again, _) = mention_run(&su, &w, w.general, w.alice, "@agent 다시 제안").await;
    let fresh = propose(&wk, w.ws, again, "decision", text, &[m]).await;
    assert!(matches!(fresh, Ok(Some(_))), "{fresh:?}");
    let shells: Vec<(String, Option<Uuid>, Option<String>)> = sqlx::query_as(
        "SELECT status, decided_by, body FROM mem_proposal WHERE workspace_id = $1 AND status = 'rejected'",
    )
    .bind(w.ws)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(shells, vec![("rejected".to_string(), Some(w.agent), None)]);
    let events: Vec<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT action, actor_member_id FROM mem_event WHERE workspace_id = $1 AND target_kind = 'proposal' AND action IN ('expired', 'rejected')",
    )
    .bind(w.ws)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        events,
        vec![("expired".to_string(), Some(w.agent))],
        "expiry is not logged as a human rejection"
    );

    // RED: without the channel lock and the ON CONFLICT the same race surfaces as 23505. The
    // function is redefined for real (committed, others connect concurrently) and restored after.
    let original: String = sqlx::query_scalar("SELECT pg_get_functiondef($1::regprocedure)")
        .bind(PROPOSE_FN)
        .fetch_one(&su)
        .await
        .unwrap();
    let sabotaged = original
        .replacen(
            "PERFORM pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended('mem_proposal:' || v_channel::text, 0));",
            "NULL;",
            1,
        )
        .replacen(
            "ON CONFLICT (workspace_id, channel_id, content_hash) WHERE status = 'pending' DO NOTHING",
            "",
            1,
        );
    assert_ne!(sabotaged, original);
    sqlx::query(&sabotaged)
        .execute(&su)
        .await
        .expect("sabotage");
    let mut saw_23505 = false;
    for round in 0..15 {
        let mut runs = Vec::new();
        for _ in 0..8 {
            let (r, _) = mention_run(&su, &w, w.general, w.alice, "@agent 경쟁").await;
            runs.push(r);
        }
        let results = futures_join(
            &wk,
            w.ws,
            &runs,
            &format!("사보타주 경쟁 {round} 번 결정이에요"),
            m,
        )
        .await;
        if results.iter().any(|r| matches!(r, Err(c) if c == "23505")) {
            saw_23505 = true;
            break;
        }
    }
    sqlx::query(&original).execute(&su).await.expect("restore");
    eprintln!("RED lock and ON CONFLICT removed: 23505 seen = {saw_23505}");
    assert!(saw_23505, "the race must surface without the lock");
}

async fn futures_join(
    wk: &PgPool,
    ws: Uuid,
    runs: &[Uuid],
    text: &str,
    evidence: Uuid,
) -> Vec<Result<Option<Uuid>, String>> {
    let mut handles = Vec::new();
    for run in runs {
        let (wk, run, text) = (wk.clone(), *run, text.to_string());
        handles.push(tokio::spawn(async move {
            propose(&wk, ws, run, "decision", &text, &[evidence]).await
        }));
    }
    let mut out = Vec::new();
    for h in handles {
        out.push(h.await.expect("join"));
    }
    out
}

// ---------------------------------------------------------------------------
// #3208 M-5: a forgotten text is neither proposed again nor acceptable
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_forgotten_text_is_neither_proposed_again_nor_accepted() {
    let (su, app, wk, w) = setup().await;
    let text = "잊을 결정 lychee 문구예요";
    // A pending proposal with this text exists before the item does.
    let (pid, _) = pending(&su, &wk, &w, text).await;
    // X: a live item with the same kind/text in the same channel, forged the way extraction stores it.
    let (mx, _) = say(&su, w.ws, w.general, w.alice, "X 의 근거예요").await;
    let x = Uuid::new_v4();
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, origin, body, valid_from, \
             content_hash, extractor_version, source_count) \
             VALUES ('{x}', '{ws}', 'channel', '{ch}', 'decision', 'extracted', '{text}', now(), \
                     encode(sha256(convert_to('decision:' || lower('{text}'), 'UTF8')), 'hex'), 'forged', 1)",
            ws = w.ws,
            ch = w.general
        ),
    )
    .await;
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ('{}', '{x}', '{mx}', '{}')",
            w.ws, w.general
        ),
    )
    .await;
    // alice forgets X (as the API role): the hash is remembered.
    exec(
        &app,
        w.ws,
        Some(w.alice),
        &format!("SELECT mem_forget_item('{x}')"),
    )
    .await
    .expect("forget X");
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_suppress WHERE workspace_id = '{}'",
                w.ws
            )
        )
        .await,
        1
    );

    // Accepting the still-pending proposal with X's text is refused cleanly (55000 -> the route's
    // "can no longer be decided" 409), it stays pending, and no item appears.
    assert_eq!(
        accept(&app, w.ws, Some(w.bob), pid).await,
        Err("55000".to_string())
    );
    assert_eq!(
        su_count(
            &su,
            &format!("SELECT count(*) FROM mem_proposal WHERE id = '{pid}' AND status = 'pending'")
        )
        .await,
        1
    );
    assert_eq!(
        su_count(
            &su,
            &format!(
                "SELECT count(*) FROM mem_item WHERE workspace_id = '{}' AND body = '{text}'",
                w.ws
            )
        )
        .await,
        0
    );

    // A new proposal with X's text is not created; other text is.
    let (m1, _) = say(&su, w.ws, w.general, w.alice, "새 근거 하나예요").await;
    let (run, _) = mention_run(&su, &w, w.general, w.alice, "@agent 기억해 줘").await;
    assert_eq!(
        propose(&wk, w.ws, run, "decision", text, &[m1]).await,
        Ok(None)
    );
    assert_eq!(
        su_count(&su, &format!("SELECT count(*) FROM mem_proposal WHERE workspace_id = '{}' AND status = 'pending'", w.ws)).await,
        1,
        "only the pre-existing pending proposal"
    );
    assert!(matches!(
        propose(
            &wk,
            w.ws,
            run,
            "decision",
            "전혀 다른 새 결정 papayasalt 문구예요",
            &[m1]
        )
        .await,
        Ok(Some(_))
    ));

    // RED 1: without the accept check the insert trigger silently skips the row and the function
    // fails somewhere else with a raw error (not the clean refusal).
    const ACCEPT_CHECK: &str =
        "RAISE EXCEPTION 'mem_accept_proposal: this memory was forgotten' USING ERRCODE = '55000';";
    let tx = sabotage_tx(&su, ACCEPT_FN, &[(ACCEPT_CHECK, "NULL;")]).await;
    let unchecked = decide_in(tx, w.ws, Some(w.bob), "mem_accept_proposal", pid, None).await;
    eprintln!("RED [accept check removed]: shipped -> Err(55000); sabotaged -> {unchecked:?}");
    assert_ne!(unchecked, Err("55000".to_string()));
    // RED 2: without the check *and* the trigger a forgotten text is remembered again.
    let mut tx = sabotage_tx(&su, ACCEPT_FN, &[(ACCEPT_CHECK, "NULL;")]).await;
    sqlx::query("DROP TRIGGER mem_item_suppressed ON mem_item")
        .execute(&mut *tx)
        .await
        .expect("drop trigger");
    let resurrected = decide_in(tx, w.ws, Some(w.bob), "mem_accept_proposal", pid, None).await;
    eprintln!("RED [accept check + trigger removed]: sabotaged -> {resurrected:?} (a forgotten text is an item again)");
    assert!(resurrected.is_ok());
    // RED 3: without the propose check a proposal with the forgotten text is created.
    let mut tx = sabotage_tx(
        &su,
        PROPOSE_FN,
        &[(
            "AND s.channel_id = v_channel AND s.content_hash = v_hash",
            "AND false",
        )],
    )
    .await;
    // (the still-pending twin would otherwise dedupe the proposal; drop it inside the rolled-back tx)
    sqlx::query("DELETE FROM mem_proposal WHERE id = $1")
        .bind(pid)
        .execute(&mut *tx)
        .await
        .expect("drop the pending twin");
    let proposed = propose_in(tx, w.ws, run, "decision", text, &[m1]).await;
    eprintln!("RED [propose check removed]: shipped -> Ok(None); sabotaged -> {proposed:?}");
    assert!(matches!(proposed, Ok(Some(_))));
}
