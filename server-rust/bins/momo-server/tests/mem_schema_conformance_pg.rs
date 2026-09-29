//! #3161 / ADR-0196 — team-memory M1 schema: read policy, write lockdown, audience.
//!
//! Real Postgres, as `momo_app` (NOBYPASSRLS, not the table owner) after
//! `bootstrap_roles.sql` has re-granted ALL TABLES — so every claim below is about
//! the state a running deployment has, not the state right after the migration.
//!
//!   * R1 parity: `mem_can_read_channel` == `momo_messaging::is_channel_member`
//!     (+ one documented narrowing); `mem_can_read_channels` edge cases.
//!   * (a)-(e) read policy: isolation, non-reader, reader, multi-channel, R1.
//!     Deleted via `state` only and via `deleted_at` only; edited; stale.
//!   * write lockdown (review H1/M3): no direct DML on the four write tables, even
//!     with the grants restored (RLS write policies are `TO mem_definer` only).
//!   * write functions (H2/M3): forged digests, evidence, rollup, thread, cursor,
//!     receipts — each with its SQLSTATE.
//!   * settings (M2), audience rule (H3), rollup inputs / channel switch, GUC scope (L1).
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15461/momo \
//!   cargo test -p momo-server --test mem_schema_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use uuid::Uuid;

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

/// The summary worker's connection: `momo_worker` (BYPASSRLS login) that has done
/// `SET ROLE momo_memory` — the only role that may run the worker-only functions.
/// `set_role = false` is the plain `momo_worker` session.
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
    run_sql_file("bootstrap_roles.sql");
    *ready = true;
}

fn sql_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../infra/rust/sql")
}

/// Run SQL text through psql in one transaction; Ok(()) or Err(stderr).
fn run_sql_text(sql: &str) -> Result<(), String> {
    let output = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-c")
        .arg(sql)
        .output()
        .expect("spawn psql");
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

fn run_sql_file(name: &str) {
    let path = sql_dir().join(name);
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .env("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw")
        .env("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw")
        .env("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw")
        .env("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw")
        .status()
        .expect("spawn psql");
    assert!(status.success(), "{name} failed");
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(id)
        .bind(format!("mem-{id}"))
        .execute(su)
        .await
        .expect("workspace");
    id
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("m-{}", &id.simple().to_string()[..10]);
    sqlx::query(&format!(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, '{kind}', $3, $3)"
    ))
    .bind(id)
    .bind(ws)
    .bind(handle)
    .execute(su)
    .await
    .expect("member");
    id
}

async fn seed_channel(su: &PgPool, ws: Uuid, kind: &str, creator: Uuid) -> Uuid {
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
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(ws)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
}

async fn seed_message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> (Uuid, i64) {
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
    (id, seq)
}

/// A digest stored in `home` whose evidence is `(message, its channel)` pairs.
async fn seed_digest(
    su: &PgPool,
    ws: Uuid,
    home: Uuid,
    seq: i64,
    evidence: &[(Uuid, Uuid)],
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO mem_digest (id, workspace_id, channel_id, level, from_seq, to_seq, body, \
         source_count, prompt_version) VALUES ($1, $2, $3, 'window', $4, $4, 'summary', $5, 'v1')",
    )
    .bind(id)
    .bind(ws)
    .bind(home)
    .bind(seq)
    .bind(evidence.len() as i32)
    .execute(su)
    .await
    .expect("digest");
    for (message, channel) in evidence {
        sqlx::query(
            "INSERT INTO mem_evidence (workspace_id, digest_id, message_id, channel_id) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(ws)
        .bind(id)
        .bind(message)
        .bind(channel)
        .execute(su)
        .await
        .expect("evidence");
    }
    id
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async fn ws_role(su: &PgPool, ws: Uuid, member: Uuid, role: &str) {
    sqlx::query(&format!(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, '{role}') \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = EXCLUDED.role"
    ))
    .bind(ws)
    .bind(member)
    .execute(su)
    .await
    .expect("workspace_membership");
}

async fn join_role(su: &PgPool, ws: Uuid, channel: Uuid, member: Uuid, role: &str) {
    sqlx::query(&format!(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, '{role}')"
    ))
    .bind(ws)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
}

async fn su_exec(su: &PgPool, sql: &str) {
    sqlx::query(sql).execute(su).await.expect(sql);
}

fn arr(ids: &[Uuid]) -> String {
    if ids.is_empty() {
        "'{}'::uuid[]".to_string()
    } else {
        let items: Vec<String> = ids.iter().map(|i| format!("'{i}'")).collect();
        format!("ARRAY[{}]::uuid[]", items.join(","))
    }
}

fn sqlstate(error: &sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
        other => format!("non-db error: {other}"),
    }
}

async fn viewer_tx<'a>(
    app: &'a PgPool,
    ws: Uuid,
    member: Option<Uuid>,
) -> sqlx::Transaction<'a, sqlx::Postgres> {
    let mut tx = app.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("ws guc");
    if let Some(member) = member {
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(member.to_string())
            .execute(&mut *tx)
            .await
            .expect("member guc");
    }
    tx
}

/// Execute one statement in its own tenant tx. Ok(rows affected) commits; Err is the SQLSTATE.
async fn exec(app: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> Result<u64, String> {
    let mut tx = viewer_tx(app, ws, member).await;
    match sqlx::query(sql).execute(&mut *tx).await {
        Ok(done) => {
            tx.commit().await.expect("commit");
            Ok(done.rows_affected())
        }
        Err(error) => Err(sqlstate(&error)),
    }
}

async fn uuid_of(app: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> Result<Uuid, String> {
    let mut tx = viewer_tx(app, ws, member).await;
    match sqlx::query_scalar::<_, Uuid>(sql).fetch_one(&mut *tx).await {
        Ok(id) => {
            tx.commit().await.expect("commit");
            Ok(id)
        }
        Err(error) => Err(sqlstate(&error)),
    }
}

async fn bool_of(app: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> bool {
    let mut tx = viewer_tx(app, ws, member).await;
    let v: Option<bool> = sqlx::query_scalar(sql)
        .fetch_one(&mut *tx)
        .await
        .expect("bool query");
    tx.rollback().await.expect("rollback");
    v.expect("non-null bool")
}

async fn ids_of(app: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> Vec<Uuid> {
    let mut tx = viewer_tx(app, ws, member).await;
    let mut ids: Vec<Uuid> = sqlx::query_scalar(sql)
        .fetch_all(&mut *tx)
        .await
        .expect("ids query");
    tx.rollback().await.expect("rollback");
    ids.sort();
    ids
}

async fn visible_digests(app: &PgPool, ws: Uuid, member: Option<Uuid>) -> Vec<Uuid> {
    ids_of(app, ws, member, "SELECT id FROM mem_digest").await
}

async fn count(app: &PgPool, ws: Uuid, member: Option<Uuid>, table: &str) -> i64 {
    let mut tx = viewer_tx(app, ws, member).await;
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.rollback().await.expect("rollback");
    n
}

struct World {
    ws: Uuid,
    ws_b: Uuid,
    alice: Uuid,     // P1 + S1 member, workspace member
    bob: Uuid,       // P1 only
    carol: Uuid,     // no channel
    dave_left: Uuid, // left P1
    erin_suspended: Uuid,
    agent: Uuid,   // P1 + DM with alice
    wsadmin: Uuid, // workspace admin, P1 member (not S1)
    chadmin: Uuid, // channel admin of P1, workspace member
    bob_b: Uuid,
    p1: Uuid,
    p2: Uuid, // public, nobody joined
    s1: Uuid, // private, alice only
    dm_alice_agent: Uuid,
    dm_bob_carol: Uuid,
    channel_b: Uuid,
    m_p1: (Uuid, i64),
    m_s1: (Uuid, i64),
    m_b: (Uuid, i64),
    run_s1: Uuid,
    run_p1: Uuid,
    run_b: Uuid,
}

async fn build_world(su: &PgPool) -> World {
    let ws = seed_workspace(su).await;
    let ws_b = seed_workspace(su).await;
    let alice = seed_member(su, ws, "human").await;
    let bob = seed_member(su, ws, "human").await;
    let carol = seed_member(su, ws, "human").await;
    let dave_left = seed_member(su, ws, "human").await;
    let erin_suspended = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    let wsadmin = seed_member(su, ws, "human").await;
    let chadmin = seed_member(su, ws, "human").await;
    let bob_b = seed_member(su, ws_b, "human").await;
    for (m, role) in [
        (alice, "member"),
        (bob, "member"),
        (carol, "member"),
        (wsadmin, "admin"),
        (chadmin, "member"),
    ] {
        ws_role(su, ws, m, role).await;
    }
    ws_role(su, ws_b, bob_b, "owner").await;

    let p1 = seed_channel(su, ws, "public", alice).await;
    let p2 = seed_channel(su, ws, "public", alice).await;
    let s1 = seed_channel(su, ws, "private", alice).await;
    let channel_b = seed_channel(su, ws_b, "public", bob_b).await;
    let dm_alice_agent = seed_channel(su, ws, "dm", alice).await;
    let dm_bob_carol = seed_channel(su, ws, "dm", bob).await;

    for m in [alice, bob, dave_left, erin_suspended, agent, wsadmin] {
        join(su, ws, p1, m).await;
    }
    join_role(su, ws, p1, chadmin, "admin").await;
    join(su, ws, s1, alice).await;
    join(su, ws_b, channel_b, bob_b).await;
    join(su, ws, dm_alice_agent, alice).await;
    join(su, ws, dm_alice_agent, agent).await;
    join(su, ws, dm_bob_carol, bob).await;
    join(su, ws, dm_bob_carol, carol).await;
    su_exec(
        su,
        &format!("UPDATE membership SET left_at = now() WHERE channel_id = '{p1}' AND member_id = '{dave_left}'"),
    )
    .await;
    su_exec(
        su,
        &format!("UPDATE member SET status = 'suspended' WHERE id = '{erin_suspended}'"),
    )
    .await;

    let m_p1 = seed_message(su, ws, p1, alice).await;
    let m_s1 = seed_message(su, ws, s1, alice).await;
    let m_b = seed_message(su, ws_b, channel_b, bob_b).await;

    su_exec(
        su,
        &format!(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
             max_run_steps, owner_human_id) VALUES ('{agent}', '{ws}', 'hermes-agent', \
             'https://gateway.invalid/v1', 2, 50, '{alice}')"
        ),
    )
    .await;
    let mut runs = Vec::new();
    // #3169: a receipt's requester must be the run's own (derived from its trigger message), so the
    // two same-workspace runs are triggered by alice's messages, as a mention would be.
    for (workspace, channel, trigger) in [
        (ws, s1, Some(m_s1.0)),
        (ws, p1, Some(m_p1.0)),
        (ws_b, channel_b, None),
    ] {
        let run = Uuid::new_v4();
        let agent_member = if workspace == ws { agent } else { bob_b };
        let trigger = trigger.map_or("NULL".to_string(), |id| format!("'{id}'"));
        su_exec(
            su,
            &format!(
                "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id) \
                 VALUES ('{run}', '{workspace}', '{agent_member}', '{channel}', {trigger})"
            ),
        )
        .await;
        runs.push(run);
    }
    World {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        dave_left,
        erin_suspended,
        agent,
        wsadmin,
        chadmin,
        bob_b,
        p1,
        p2,
        s1,
        dm_alice_agent,
        dm_bob_carol,
        channel_b,
        m_p1,
        m_s1,
        m_b,
        run_s1: runs[0],
        run_p1: runs[1],
        run_b: runs[2],
    }
}

async fn setup() -> (PgPool, PgPool, World) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = build_world(&su).await;
    (su, app, w)
}

// ---------------------------------------------------------------------------
// R1 parity + function edge cases (e)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn channel_readable_rule_matches_the_message_read_path() {
    let (_su, app, w) = setup().await;
    let channels = [w.p1, w.p2, w.s1, w.dm_alice_agent];
    let members = [
        ("alice", w.alice),
        ("bob", w.bob),
        ("carol (no membership)", w.carol),
        ("dave (left P1)", w.dave_left),
        ("agent", w.agent),
    ];
    for (label, member) in members {
        for channel in channels {
            let mut tx = viewer_tx(&app, w.ws, Some(member)).await;
            let rust_rule = momo_messaging::is_channel_member(&mut tx, channel, member)
                .await
                .expect("is_channel_member");
            let sql_rule: bool = sqlx::query_scalar("SELECT mem_can_read_channel($1)")
                .bind(channel)
                .fetch_one(&mut *tx)
                .await
                .expect("mem_can_read_channel");
            tx.rollback().await.expect("rollback");
            assert_eq!(
                sql_rule, rust_rule,
                "R1 parity broke for {label} on {channel}"
            );
        }
    }
    let expect: [(Uuid, Uuid, bool); 8] = [
        (w.alice, w.p1, true),
        (w.bob, w.p1, true),
        (w.bob, w.p2, false), // public channel, non-member: NOT readable
        (w.bob, w.s1, false),
        (w.carol, w.p1, false),
        (w.dave_left, w.p1, false), // left member
        (w.agent, w.p1, true),      // agents are members like any other
        (w.alice, w.s1, true),
    ];
    for (member, channel, want) in expect {
        let got = bool_of(
            &app,
            w.ws,
            Some(member),
            &format!("SELECT mem_can_read_channel('{channel}')"),
        )
        .await;
        assert_eq!(got, want, "member {member} channel {channel}");
    }
    // Foreign-workspace member.
    assert!(
        !bool_of(
            &app,
            w.ws,
            Some(w.bob_b),
            &format!("SELECT mem_can_read_channel('{}')", w.p1)
        )
        .await
    );
    // Suspended: is_channel_member says yes, the digest rule says no (search.rs:297-301).
    let mut tx = viewer_tx(&app, w.ws, Some(w.erin_suspended)).await;
    let rust_rule = momo_messaging::is_channel_member(&mut tx, w.p1, w.erin_suspended)
        .await
        .expect("is_channel_member");
    let sql_rule: bool = sqlx::query_scalar("SELECT mem_can_read_channel($1)")
        .bind(w.p1)
        .fetch_one(&mut *tx)
        .await
        .expect("fn");
    tx.rollback().await.expect("rollback");
    assert!(rust_rule && !sql_rule, "suspended: narrower, never wider");
    // Unset app.member_id fails closed.
    assert!(
        !bool_of(
            &app,
            w.ws,
            None,
            &format!("SELECT mem_can_read_channel('{}')", w.p1)
        )
        .await
    );

    // mem_can_read_channels: all readable / one unreadable / empty / NULL / NULL element.
    let by = |ids: &str| format!("SELECT mem_can_read_channels({ids})");
    let both = arr(&[w.p1, w.s1]);
    assert!(bool_of(&app, w.ws, Some(w.alice), &by(&both)).await);
    assert!(
        !bool_of(&app, w.ws, Some(w.bob), &by(&both)).await,
        "S1 unreadable"
    );
    assert!(
        !bool_of(&app, w.ws, Some(w.alice), &by("'{}'::uuid[]")).await,
        "empty"
    );
    assert!(
        !bool_of(&app, w.ws, Some(w.alice), &by("NULL::uuid[]")).await,
        "NULL array"
    );
    assert!(
        !bool_of(
            &app,
            w.ws,
            Some(w.alice),
            &by(&format!("ARRAY['{}'::uuid, NULL]", w.p1))
        )
        .await,
        "NULL element"
    );
}

// ---------------------------------------------------------------------------
// read policy (a)-(d), deletion, edit, stale
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn digest_read_policy() {
    let (su, app, w) = setup().await;
    let (m_p1, s_p1) = w.m_p1;
    let (m_s1, s_s1) = w.m_s1;
    let (m_del_state, sq1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (m_del_at, sq2) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (m_edit, sq3) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let d_p1 = seed_digest(&su, w.ws, w.p1, s_p1, &[(m_p1, w.p1)]).await;
    let d_s1 = seed_digest(&su, w.ws, w.s1, s_s1, &[(m_s1, w.s1)]).await;
    let d_multi = seed_digest(&su, w.ws, w.p1, s_p1 + 100, &[(m_p1, w.p1), (m_s1, w.s1)]).await;
    let d_state = seed_digest(&su, w.ws, w.p1, sq1, &[(m_del_state, w.p1)]).await;
    let d_at = seed_digest(&su, w.ws, w.p1, sq2, &[(m_del_at, w.p1)]).await;
    let d_edit = seed_digest(&su, w.ws, w.p1, sq3, &[(m_edit, w.p1)]).await;
    let d_none = seed_digest(&su, w.ws, w.p1, s_p1 + 200, &[]).await;
    let d_stale = seed_digest(&su, w.ws, w.p1, s_p1 + 300, &[(m_p1, w.p1)]).await;
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = true WHERE id = '{d_stale}'"),
    )
    .await;
    // Evidence row that lies about the channel: message is in P1, claims S1.
    let d_lie = seed_digest(&su, w.ws, w.s1, s_p1 + 400, &[(m_p1, w.s1)]).await;
    let d_b = seed_digest(&su, w.ws_b, w.channel_b, w.m_b.1, &[(w.m_b.0, w.channel_b)]).await;

    // (c) reader of every evidence channel.
    let alice = visible_digests(&app, w.ws, Some(w.alice)).await;
    for d in [d_p1, d_s1, d_multi, d_state, d_at, d_edit] {
        assert!(alice.contains(&d), "alice reads P1+S1: {d}");
    }
    // (b) non-reader of the stored channel.
    let bob = visible_digests(&app, w.ws, Some(w.bob)).await;
    assert!(!bob.contains(&d_s1) && bob.contains(&d_p1));
    assert!(visible_digests(&app, w.ws, Some(w.carol)).await.is_empty());
    assert!(visible_digests(&app, w.ws, Some(w.dave_left))
        .await
        .is_empty());
    assert!(
        visible_digests(&app, w.ws, None).await.is_empty(),
        "no app.member_id"
    );
    // (d) multi-channel: stored in P1 (bob reads) but cites S1 (bob cannot).
    assert!(!bob.contains(&d_multi));
    // no evidence, stale, and a lying evidence row are never shown.
    for d in [d_none, d_stale, d_lie] {
        assert!(!alice.contains(&d), "never visible: {d}");
    }
    // Evidence rows are not a side door: only readers of the row's channel see them (M1).
    let ev_in_s1 = format!("SELECT id FROM mem_evidence WHERE channel_id = '{}'", w.s1);
    assert!(!ids_of(&app, w.ws, Some(w.alice), &ev_in_s1)
        .await
        .is_empty());
    assert!(
        ids_of(&app, w.ws, Some(w.bob), &ev_in_s1).await.is_empty(),
        "bob cannot see S1 evidence ids"
    );
    assert!(ids_of(&app, w.ws, None, &ev_in_s1).await.is_empty());
    // (a) isolation: other tenant GUC sees only its own; A's viewer under B sees nothing of A.
    assert_eq!(
        visible_digests(&app, w.ws_b, Some(w.bob_b)).await,
        vec![d_b]
    );
    assert!(visible_digests(&app, w.ws_b, Some(w.alice))
        .await
        .is_empty());
    assert!(!visible_digests(&app, w.ws, Some(w.bob_b))
        .await
        .contains(&d_b));

    // Deletion, each column on its own: either one alone must hide (D6-2).
    su_exec(
        &su,
        &format!("UPDATE message SET state = 'deleted' WHERE id = '{m_del_state}'"),
    )
    .await;
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now() WHERE id = '{m_del_at}'"),
    )
    .await;
    let after = visible_digests(&app, w.ws, Some(w.alice)).await;
    assert!(!after.contains(&d_state), "state='deleted' alone hides");
    assert!(!after.contains(&d_at), "deleted_at alone hides");
    assert!(after.contains(&d_p1) && after.contains(&d_edit));
    // An edit after the digest was built hides it until it is rebuilt (M5).
    su_exec(&su, &format!("UPDATE message SET edited_at = now() + interval '1 second', state = 'edited' WHERE id = '{m_edit}'")).await;
    assert!(!visible_digests(&app, w.ws, Some(w.alice))
        .await
        .contains(&d_edit));
}

// ---------------------------------------------------------------------------
// write lockdown (H1, M3)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn api_role_cannot_write_the_memory_tables_directly() {
    let (su, app, w) = setup().await;
    let d = seed_digest(&su, w.ws, w.s1, w.m_s1.1, &[(w.m_s1.0, w.s1)]).await;
    let ev: Uuid = sqlx::query_scalar("SELECT id FROM mem_evidence WHERE digest_id = $1")
        .bind(d)
        .fetch_one(&su)
        .await
        .expect("evidence id");
    let attempts = [
        format!("INSERT INTO mem_digest (workspace_id, channel_id, level, from_seq, to_seq, body, prompt_version) VALUES ('{}', '{}', 'window', 1, 1, 'forged', 'v')", w.ws, w.s1),
        format!("UPDATE mem_digest SET body = 'x' WHERE id = '{d}'"),
        format!("DELETE FROM mem_digest WHERE id = '{d}'"),
        format!("INSERT INTO mem_evidence (workspace_id, digest_id, message_id, channel_id) VALUES ('{}', '{d}', '{}', '{}')", w.ws, w.m_p1.0, w.p1),
        format!("UPDATE mem_evidence SET channel_id = '{}' WHERE id = '{ev}'", w.p1),
        format!("DELETE FROM mem_evidence WHERE id = '{ev}'"),
        format!("INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ('{}', '{}', 1)", w.p1, w.ws),
        format!("UPDATE mem_cursor SET last_seq = 9 WHERE channel_id = '{}'", w.s1),
        format!("DELETE FROM mem_cursor WHERE channel_id = '{}'", w.s1),
        format!("INSERT INTO mem_serving (workspace_id, run_id, channel_id) VALUES ('{}', '{}', '{}')", w.ws, w.run_p1, w.p1),
        format!("UPDATE mem_serving SET withheld_count = 9 WHERE workspace_id = '{}'", w.ws),
        format!("DELETE FROM mem_serving WHERE workspace_id = '{}'", w.ws),
    ];
    // Wall 1: privileges revoked (bootstrap re-granted ALL TABLES, then revoked these).
    for sql in &attempts {
        assert_eq!(
            exec(&app, w.ws, Some(w.alice), sql).await,
            Err("42501".into()),
            "{sql}"
        );
    }
    // Wall 2: even with the grants restored, no write policy applies to momo_app.
    su_exec(&su, "GRANT INSERT, UPDATE, DELETE ON mem_digest, mem_evidence, mem_cursor, mem_serving TO momo_app").await;
    let mut outcomes = Vec::new();
    for sql in &attempts {
        // UPDATE/DELETE find no writable row (0 affected); INSERT is a policy violation.
        outcomes.push((sql.clone(), exec(&app, w.ws, Some(w.alice), sql).await));
    }
    su_exec(&su, "REVOKE INSERT, UPDATE, DELETE ON mem_digest, mem_evidence, mem_cursor, mem_serving FROM momo_app").await;
    for (sql, outcome) in outcomes {
        match outcome {
            Err(code) => assert_eq!(code, "42501", "{sql}"),
            Ok(rows) => assert_eq!(rows, 0, "no row may change: {sql}"),
        }
    }
    // Nothing moved.
    let (body_ok, ev_ok): (bool, bool) = sqlx::query_as(
        "SELECT (SELECT body = 'summary' FROM mem_digest WHERE id = $1), \
                (SELECT count(*) = 1 FROM mem_evidence WHERE digest_id = $1)",
    )
    .bind(d)
    .fetch_one(&su)
    .await
    .expect("state");
    assert!(
        body_ok && ev_ok,
        "direct DML changed the digest or its evidence"
    );
    // Wall 3 (policy `TO mem_definer` + WITH CHECK): the definer role itself cannot
    // write a row for another tenant.
    let mut tx = su.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(w.ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    sqlx::query("SET LOCAL ROLE mem_definer")
        .execute(&mut *tx)
        .await
        .expect("role");
    let cross = sqlx::query(
        "INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ($1, $2, 1)",
    )
    .bind(w.channel_b)
    .bind(w.ws_b)
    .execute(&mut *tx)
    .await;
    assert_eq!(
        cross.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
        Err("42501".to_string())
    );
    tx.rollback().await.expect("rollback");
    // The write role is the constrained kind, and every definer function is its own.
    let (bypass, login, superuser): (bool, bool, bool) = sqlx::query_as(
        "SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'mem_definer'",
    )
    .fetch_one(&su)
    .await
    .expect("role attrs");
    assert!(!bypass && !login && !superuser);
    let bad: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
          WHERE n.nspname = 'public' AND p.proname LIKE 'mem\\_%' AND p.prosecdef \
            AND (pg_get_userbyid(p.proowner) <> 'mem_definer' \
                 OR NOT (COALESCE(p.proconfig, '{}')::text[] @> ARRAY['search_path=pg_catalog, public, pg_temp']))",
    )
    .fetch_one(&su)
    .await
    .expect("definer audit");
    assert_eq!(
        bad, 0,
        "definer functions must be owned by mem_definer with a pinned search_path"
    );
    let all_pinned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
          WHERE n.nspname = 'public' AND p.proname LIKE 'mem\\_%' \
            AND NOT (COALESCE(p.proconfig, '{}')::text[] @> ARRAY['search_path=pg_catalog, public, pg_temp'])",
    )
    .fetch_one(&su)
    .await
    .expect("search_path audit");
    assert_eq!(all_pinned, 0, "every mem_ function pins search_path");
    // FORCE RLS everywhere.
    let flags: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT relname::text, relrowsecurity, relforcerowsecurity FROM pg_class \
          WHERE relname IN ('mem_digest','mem_evidence','mem_cursor','mem_serving','mem_settings') \
            AND relkind = 'r' ORDER BY relname",
    )
    .fetch_all(&su)
    .await
    .expect("pg_class");
    assert_eq!(flags.len(), 5);
    for (table, enabled, forced) in flags {
        assert!(enabled && forced, "{table} must be ENABLE + FORCE RLS");
    }
}

// ---------------------------------------------------------------------------
// mem_apply_digest (H2)
// ---------------------------------------------------------------------------

fn apply_sql(
    channel: Uuid,
    thread: Option<Uuid>,
    level: &str,
    from: i64,
    to: i64,
    sources: &[Uuid],
    evidence: &[Uuid],
) -> String {
    let thread = thread
        .map(|t| format!("'{t}'"))
        .unwrap_or_else(|| "NULL".into());
    let ids: Vec<String> = evidence.iter().map(|e| e.to_string()).collect();
    format!(
        "SELECT mem_apply_digest('{channel}', {thread}, '{level}', {from}, {to}, 'body', {}, \
         'm', 'agent', 'v1', {}, @SNAP[{}]@, now())",
        arr(sources),
        arr(evidence),
        ids.join(",")
    )
}

/// Replace every `@SNAP[id,id]@` marker with the per-message `edited_at` snapshot a worker
/// would have taken when it read the messages (NULL = never edited), in the same order.
async fn resolve(su: &PgPool, sql: &str) -> String {
    let mut out = sql.to_string();
    while let Some(start) = out.find("@SNAP[") {
        let end = out[start..].find("]@").expect("marker end") + start;
        let ids: Vec<Uuid> = out[start + 6..end]
            .split(',')
            .filter(|p| !p.is_empty())
            .map(|p| p.parse().expect("uuid"))
            .collect();
        let mut items = Vec::new();
        for id in &ids {
            let snap: Option<String> =
                sqlx::query_scalar("SELECT edited_at::text FROM message WHERE id = $1")
                    .bind(id)
                    .fetch_optional(su)
                    .await
                    .expect("snapshot")
                    .flatten();
            items.push(match snap {
                Some(t) => format!("'{t}'::timestamptz"),
                None => "NULL::timestamptz".to_string(),
            });
        }
        let literal = if items.is_empty() {
            "'{}'::timestamptz[]".to_string()
        } else {
            format!("ARRAY[{}]::timestamptz[]", items.join(","))
        };
        out.replace_range(start..end + 2, &literal);
    }
    out
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn apply_digest_validates_what_it_writes() {
    let (su, app, w) = setup().await;
    let (a1, s1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (a2, s2) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (a3, _s3) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (root, sroot) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (reply, srep) = seed_message(&su, w.ws, w.p1, w.alice).await;
    su_exec(
        &su,
        &format!("UPDATE message SET root_id = '{root}' WHERE id = '{reply}'"),
    )
    .await;
    let ws = w.ws;
    let wk = worker_pool(true).await;
    let run = |sql: String| {
        let wk = wk.clone();
        let su = su.clone();
        async move {
            let sql = resolve(&su, &sql).await;
            uuid_of(&wk, ws, None, &sql).await
        }
    };

    // happy path: source_count is derived, not caller-supplied.
    let d1 = run(apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a2]))
        .await
        .expect("window digest");
    let (n, stale): (i32, bool) =
        sqlx::query_as("SELECT source_count, stale FROM mem_digest WHERE id = $1")
            .bind(d1)
            .fetch_one(&su)
            .await
            .expect("row");
    assert_eq!((n, stale), (2, false));
    // readable to a member of P1 through the read policy.
    assert!(visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d1));

    // H2: forged digest into a private channel with a public channel's evidence.
    assert_eq!(
        run(apply_sql(w.s1, None, "window", s1, s1, &[], &[a1])).await,
        Err("23503".into())
    );
    // forged: channel of another workspace / unknown channel.
    assert_eq!(
        run(apply_sql(w.channel_b, None, "window", 1, 1, &[], &[a1])).await,
        Err("23503".into())
    );
    // evidence from another channel, another workspace.
    assert_eq!(
        run(apply_sql(w.p1, None, "window", 1, 9999, &[], &[w.m_s1.0])).await,
        Err("23503".into())
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "window", 1, 9999, &[], &[w.m_b.0])).await,
        Err("23503".into())
    );
    // evidence outside the stated seq range.
    assert_eq!(
        run(apply_sql(w.p1, None, "window", s1, s1, &[], &[a3])).await,
        Err("23503".into())
    );
    // empty / duplicate evidence, bad level, bad range.
    assert_eq!(
        run(apply_sql(w.p1, None, "window", s1, s2, &[], &[])).await,
        Err("23514".into())
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a1])).await,
        Err("23514".into())
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "year", s1, s2, &[], &[a1])).await,
        Err("23514".into())
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "window", s2, s1, &[], &[a1])).await,
        Err("23514".into())
    );
    // no tenant GUC at all.
    let mut tx = wk.begin().await.expect("begin");
    let bare_sql = resolve(
        &su,
        &apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a2]),
    )
    .await;
    let bare = sqlx::query_scalar::<_, Uuid>(&bare_sql)
        .fetch_one(&mut *tx)
        .await;
    assert_eq!(bare.map_err(|e| sqlstate(&e)), Err("42501".to_string()));
    tx.rollback().await.expect("rollback");
    // a deleted message cannot become evidence.
    let (gone, sgone) = seed_message(&su, w.ws, w.p1, w.alice).await;
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{gone}'"),
    )
    .await;
    assert_eq!(
        run(apply_sql(w.p1, None, "window", sgone, sgone, &[], &[gone])).await,
        Err("23503".into())
    );

    // thread digests: root must be a top-level message of the channel; evidence in the thread.
    let t = run(apply_sql(
        w.p1,
        Some(root),
        "window",
        sroot,
        srep,
        &[],
        &[root, reply],
    ))
    .await
    .expect("thread digest");
    assert_ne!(t, d1);
    assert_eq!(
        run(apply_sql(w.p1, Some(w.m_s1.0), "window", 1, 9, &[], &[a1])).await,
        Err("23503".into()),
        "root in another channel"
    );
    assert_eq!(
        run(apply_sql(
            w.p1,
            Some(reply),
            "window",
            srep,
            srep,
            &[],
            &[reply]
        ))
        .await,
        Err("23503".into()),
        "a reply is not a thread root"
    );
    assert_eq!(
        run(apply_sql(w.p1, Some(root), "window", s1, srep, &[], &[a1])).await,
        Err("23503".into()),
        "evidence outside the thread"
    );

    // rollups: sources one level below, inside the range, evidence covers the sources'.
    assert_eq!(
        run(apply_sql(w.p1, None, "day", s1, s2, &[], &[a1, a2])).await,
        Err("23514".into()),
        "rollup needs sources"
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "window", s1, s2, &[d1], &[a1, a2])).await,
        Err("23514".into()),
        "window has no sources"
    );
    assert_eq!(
        run(apply_sql(
            w.p1,
            None,
            "day",
            s1,
            s2,
            &[Uuid::new_v4()],
            &[a1, a2]
        ))
        .await,
        Err("23503".into()),
        "unknown source"
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "week", s1, s2, &[d1], &[a1, a2])).await,
        Err("23503".into()),
        "week needs day sources"
    );
    assert_eq!(
        run(apply_sql(w.p1, None, "day", s1, s2, &[d1], &[a1])).await,
        Err("23514".into()),
        "evidence must cover the source's evidence"
    );
    let day = run(apply_sql(w.p1, None, "day", s1, s2, &[d1], &[a1, a2]))
        .await
        .expect("day rollup");
    let week = run(apply_sql(w.p1, None, "week", s1, s2, &[day], &[a1, a2]))
        .await
        .expect("week rollup");
    assert_ne!(day, week);

    // idempotent re-apply: same id, evidence replaced, stale cleared, created_at renewed.
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = true WHERE id = '{d1}'"),
    )
    .await;
    assert!(
        !visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d1),
        "stale is hidden"
    );
    let again = run(apply_sql(w.p1, None, "window", s1, s2, &[], &[a1]))
        .await
        .expect("re-apply");
    assert_eq!(again, d1);
    let (n, stale, ev): (i32, bool, i64) = sqlx::query_as(
        "SELECT source_count, stale, (SELECT count(*) FROM mem_evidence WHERE digest_id = $1) FROM mem_digest WHERE id = $1",
    )
    .bind(d1)
    .fetch_one(&su)
    .await
    .expect("row");
    assert_eq!((n, stale, ev), (1, false, 1));
    assert!(visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d1));

    // rollup inputs: only live, non-stale, one level below, inside the range.
    let inputs = |target: &'static str| {
        let sql = format!(
            "SELECT id FROM mem_digest_rollup_inputs('{}', NULL, '{target}', {s1}, {s2})",
            w.p1
        );
        let wk = wk.clone();
        async move { ids_of(&wk, ws, None, &sql).await }
    };
    assert_eq!(
        inputs("day").await,
        vec![d1],
        "worker reads without a viewer"
    );
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = true WHERE id = '{d1}'"),
    )
    .await;
    assert!(inputs("day").await.is_empty(), "stale is not an input");
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = false WHERE id = '{d1}'"),
    )
    .await;
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{a1}'"),
    )
    .await;
    assert!(
        inputs("day").await.is_empty(),
        "a digest with a deleted source message is not an input"
    );
}

// ---------------------------------------------------------------------------
// cursor + receipts (M3)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn cursor_and_receipts_only_through_their_functions() {
    let (su, app, w) = setup().await;
    let (_a, head) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (_b, head2) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let head = head.max(head2);
    let tok = Uuid::new_v4();
    let other = Uuid::new_v4();
    let adv = |channel: Uuid, seq: i64, token: Uuid, secs: i64| {
        format!("SELECT mem_advance_cursor('{channel}', {seq}, '{token}', now() + interval '{secs} seconds')")
    };
    let wk = worker_pool(true).await;
    let call = |sql: String| {
        let wk = wk.clone();
        let ws = w.ws;
        async move {
            let mut tx = viewer_tx(&wk, ws, None).await;
            match sqlx::query_scalar::<_, i64>(&sql).fetch_one(&mut *tx).await {
                Ok(v) => {
                    tx.commit().await.expect("commit");
                    Ok(v)
                }
                Err(e) => Err(sqlstate(&e)),
            }
        }
    };
    assert_eq!(call(adv(w.p1, 1, tok, 60)).await, Ok(1));
    assert_eq!(call(adv(w.p1, head, tok, 60)).await, Ok(head));
    assert_eq!(
        call(adv(w.p1, 1, tok, 60)).await,
        Err("23514".into()),
        "no going backwards"
    );
    assert_eq!(
        call(adv(w.p1, head + 5, tok, 60)).await,
        Err("23514".into()),
        "beyond the channel head"
    );
    assert_eq!(
        call(adv(w.p1, head, other, 60)).await,
        Err("55P03".into()),
        "live lease of another worker"
    );
    assert_eq!(
        call(adv(w.channel_b, 0, tok, 60)).await,
        Err("23503".into()),
        "channel of another workspace"
    );
    // an expired lease can be taken over.
    su_exec(&su, &format!("UPDATE mem_cursor SET leased_until = now() - interval '1 second' WHERE channel_id = '{}'", w.p1)).await;
    assert_eq!(call(adv(w.p1, head, other, 60)).await, Ok(head));
    // squatting: a cross-workspace pre-insert is impossible for a member (no direct DML).
    assert_eq!(
        exec(&app, w.ws, Some(w.bob), &format!("INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ('{}', '{}', 1)", w.p2, w.ws_b)).await,
        Err("42501".into())
    );
    // the composite FK ties the row's workspace to the channel's, even for a superuser.
    let squat = sqlx::query(
        "INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ($1, $2, 1)",
    )
    .bind(w.p2)
    .bind(w.ws_b)
    .execute(&su)
    .await;
    assert_eq!(
        squat.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
        Err("23503".to_string())
    );
    // cursor rows are visible only to readers of the channel.
    assert_eq!(count(&app, w.ws, Some(w.bob), "mem_cursor").await, 1);
    assert_eq!(count(&app, w.ws, Some(w.carol), "mem_cursor").await, 0);

    // receipts: channel comes from the run; unknown digest / foreign run / duplicate refused.
    let d = seed_digest(&su, w.ws, w.s1, w.m_s1.1, &[(w.m_s1.0, w.s1)]).await;
    let alice = w.alice;
    let rec = |run: Uuid, digests: &[Uuid], withheld: i32, budget: i32, used: i32| {
        format!(
            "SELECT mem_record_serving('{run}', '{alice}', {}, '{{}}'::uuid[], {withheld}, {budget}, {used})",
            arr(digests)
        )
    };
    let r = uuid_of(&wk, w.ws, None, &rec(w.run_s1, &[d], 2, 6000, 100))
        .await
        .expect("receipt");
    let ch: Uuid = sqlx::query_scalar("SELECT channel_id FROM mem_serving WHERE id = $1")
        .bind(r)
        .fetch_one(&su)
        .await
        .expect("row");
    assert_eq!(ch, w.s1, "channel_id == agent_run.channel_id");
    assert_eq!(
        uuid_of(&wk, w.ws, None, &rec(w.run_s1, &[d], 0, 10, 1)).await,
        Err("23505".into()),
        "one receipt per run"
    );
    assert_eq!(
        uuid_of(&wk, w.ws, None, &rec(w.run_p1, &[Uuid::new_v4()], 0, 10, 1)).await,
        Err("23503".into()),
        "unknown digest"
    );
    assert_eq!(
        uuid_of(&wk, w.ws, None, &rec(w.run_b, &[], 0, 10, 1)).await,
        Err("23503".into()),
        "run of another workspace"
    );
    assert_eq!(
        uuid_of(&wk, w.ws, None, &rec(w.run_p1, &[], 0, 10, 11)).await,
        Err("23514".into()),
        "used > budget"
    );
    // H-B: a digest that the answer channel's audience may not see cannot be recorded
    // (S1-only evidence into a P1 answer), and a missing requester fails closed.
    assert_eq!(
        uuid_of(&wk, w.ws, None, &rec(w.run_p1, &[d], 0, 10, 1)).await,
        Err("23514".into()),
        "S1 digest into a P1 answer"
    );
    assert_eq!(
        uuid_of(
            &wk,
            w.ws,
            None,
            &format!(
                "SELECT mem_record_serving('{}', NULL, {}, '{{}}'::uuid[], 0, 10, 1)",
                w.run_s1,
                arr(&[d])
            )
        )
        .await,
        // #3169: the requester must be the run's own (derived in SQL), so a missing one is a
        // mismatch (22023) before the audience rule is even asked.
        Err("22023".into()),
        "no requester"
    );
    // receipts follow the answer channel (D7).
    assert_eq!(count(&app, w.ws, Some(w.alice), "mem_serving").await, 1);
    assert_eq!(count(&app, w.ws, Some(w.bob), "mem_serving").await, 0);
    assert_eq!(count(&app, w.ws, None, "mem_serving").await, 0);
}

// ---------------------------------------------------------------------------
// mem_settings (M2)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn settings_writes_need_the_right_role() {
    let (su, app, w) = setup().await;
    let ins_ws = |ws: Uuid| {
        format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{ws}', 'workspace', true)")
    };
    let ins_ch = |c: Uuid| {
        format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{c}', true)", w.ws)
    };
    let ins_me = |m: Uuid| {
        format!("INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ('{}', 'member', '{m}', true)", w.ws)
    };

    // workspace scope: admin only.
    assert_eq!(
        exec(&app, w.ws, Some(w.bob), &ins_ws(w.ws)).await,
        Err("42501".into()),
        "plain member"
    );
    assert_eq!(
        exec(&app, w.ws, None, &ins_ws(w.ws)).await,
        Err("42501".into()),
        "no viewer"
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.wsadmin), &ins_ws(w.ws)).await,
        Ok(1),
        "workspace admin"
    );
    // channel scope: channel admin or workspace admin, and only for a channel they can read.
    assert_eq!(
        exec(&app, w.ws, Some(w.bob), &ins_ch(w.p1)).await,
        Err("42501".into()),
        "plain member"
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.wsadmin), &ins_ch(w.s1)).await,
        Err("42501".into()),
        "admin who cannot read S1"
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.chadmin), &ins_ch(w.p1)).await,
        Ok(1),
        "channel admin"
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.chadmin), &ins_ch(w.s1)).await,
        Err("42501".into()),
        "channel admin of another channel"
    );
    // member scope: own row only.
    assert_eq!(
        exec(&app, w.ws, Some(w.bob), &ins_me(w.alice)).await,
        Err("42501".into()),
        "someone else's row"
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.alice), &ins_me(w.alice)).await,
        Ok(1)
    );
    // Cross-workspace row from a workspace admin.
    assert_eq!(
        exec(&app, w.ws, Some(w.wsadmin), &ins_ws(w.ws_b)).await,
        Err("42501".into())
    );

    // UPDATE / DELETE of rows the caller may not touch: nothing changes.
    for (who, label) in [(w.bob, "bob"), (w.carol, "carol")] {
        let upd_me = exec(&app, w.ws, Some(who), &format!("UPDATE mem_settings SET paused = false WHERE scope = 'member' AND member_id = '{}'", w.alice)).await;
        let del_me = exec(
            &app,
            w.ws,
            Some(who),
            "DELETE FROM mem_settings WHERE scope = 'member'",
        )
        .await;
        let upd_ws = exec(
            &app,
            w.ws,
            Some(who),
            "UPDATE mem_settings SET paused = false WHERE scope = 'workspace'",
        )
        .await;
        let del_ch = exec(
            &app,
            w.ws,
            Some(who),
            "DELETE FROM mem_settings WHERE scope = 'channel'",
        )
        .await;
        for (r, what) in [
            (upd_me, "update personal"),
            (del_me, "delete personal"),
            (upd_ws, "update workspace"),
            (del_ch, "delete channel"),
        ] {
            assert_eq!(r, Ok(0), "{label} must not {what}");
        }
    }
    let (me_paused, ws_paused, ch_left): (bool, bool, i64) = sqlx::query_as(
        "SELECT (SELECT paused FROM mem_settings WHERE scope='member' AND workspace_id=$1), \
                (SELECT paused FROM mem_settings WHERE scope='workspace' AND workspace_id=$1), \
                (SELECT count(*) FROM mem_settings WHERE scope='channel' AND workspace_id=$1)",
    )
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .expect("state");
    assert!(
        me_paused && ws_paused && ch_left == 1,
        "rows were changed by non-owners"
    );
    // Owner and admins can edit/delete their own.
    assert_eq!(
        exec(
            &app,
            w.ws,
            Some(w.alice),
            "UPDATE mem_settings SET paused = false WHERE scope = 'member'"
        )
        .await,
        Ok(1)
    );
    assert_eq!(
        exec(
            &app,
            w.ws,
            Some(w.wsadmin),
            "UPDATE mem_settings SET paused = false WHERE scope = 'workspace'"
        )
        .await,
        Ok(1)
    );
    assert_eq!(
        exec(
            &app,
            w.ws,
            Some(w.chadmin),
            "DELETE FROM mem_settings WHERE scope = 'channel'"
        )
        .await,
        Ok(1)
    );
    assert_eq!(
        exec(
            &app,
            w.ws,
            Some(w.alice),
            "DELETE FROM mem_settings WHERE scope = 'member'"
        )
        .await,
        Ok(1)
    );
    assert_eq!(
        exec(
            &app,
            w.ws,
            Some(w.wsadmin),
            "DELETE FROM mem_settings WHERE scope = 'workspace'"
        )
        .await,
        Ok(1)
    );

    // Reads: workspace row for everyone in the workspace only; channel row only for its readers;
    // personal row only for its owner.
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope) VALUES ('{}', 'workspace'), ('{}', 'workspace')", w.ws, w.ws_b)).await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.s1)).await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ('{}', 'member', '{}', true)", w.ws, w.alice)).await;
    assert_eq!(
        count(&app, w.ws, Some(w.bob), "mem_settings").await,
        1,
        "bob: workspace row only"
    );
    assert_eq!(
        count(&app, w.ws, Some(w.alice), "mem_settings").await,
        3,
        "alice: workspace + S1 + personal"
    );
    assert_eq!(count(&app, w.ws, None, "mem_settings").await, 1);
    assert_eq!(
        count(&app, w.ws_b, Some(w.bob_b), "mem_settings").await,
        1,
        "tenant B sees only its own workspace row"
    );
    assert_eq!(count(&app, w.ws_b, Some(w.alice), "mem_settings").await, 1);
    // scope column CHECK.
    let bad = sqlx::query("INSERT INTO mem_settings (workspace_id, scope, member_id, enabled) VALUES ($1, 'member', $2, false)")
        .bind(w.ws).bind(w.bob).execute(&su).await;
    assert_eq!(
        bad.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
        Err("23514".to_string())
    );

    // worker-side switch: excluded channel / paused workspace, no viewer needed.
    let wk = worker_pool(true).await;
    let switch = |c: Uuid| format!("SELECT mem_channel_switch('{c}')");
    assert!(bool_of(&wk, w.ws, None, &switch(w.p1)).await);
    assert!(
        !bool_of(&wk, w.ws, None, &switch(w.s1)).await,
        "excluded channel"
    );
    su_exec(&su, &format!("UPDATE mem_settings SET paused = true WHERE scope = 'workspace' AND workspace_id = '{}'", w.ws)).await;
    assert!(
        !bool_of(&wk, w.ws, None, &switch(w.p1)).await,
        "paused workspace"
    );
    assert!(
        bool_of(
            &wk,
            w.ws_b,
            None,
            &format!("SELECT mem_channel_switch('{}')", w.channel_b)
        )
        .await,
        "other tenant unaffected"
    );
}

// ---------------------------------------------------------------------------
// audience rule (H3, ADR-0196 D6-4)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn audience_rule_pins_adr_d6_4() {
    let (su, _app, w) = setup().await;
    let (m_p1, s_p1) = w.m_p1;
    let (m_s1, s_s1) = w.m_s1;
    let (m_dm, s_dm) = seed_message(&su, w.ws, w.dm_alice_agent, w.alice).await;
    let d_p1 = seed_digest(&su, w.ws, w.p1, s_p1, &[(m_p1, w.p1)]).await;
    let d_s1 = seed_digest(&su, w.ws, w.s1, s_s1, &[(m_s1, w.s1)]).await;
    let d_multi = seed_digest(&su, w.ws, w.p1, s_p1 + 100, &[(m_p1, w.p1), (m_s1, w.s1)]).await;
    let d_dm = seed_digest(
        &su,
        w.ws,
        w.dm_alice_agent,
        s_dm,
        &[(m_dm, w.dm_alice_agent)],
    )
    .await;
    let wk = worker_pool(true).await;
    let aud = |d: Uuid, answer: Uuid, requester: Uuid| {
        let wk = wk.clone();
        let ws = w.ws;
        async move {
            bool_of(
                &wk,
                ws,
                None,
                &format!("SELECT mem_digest_audience_ok('{d}', '{answer}', '{requester}')"),
            )
            .await
        }
    };
    // Group channel: only digests entirely inside the answer channel.
    assert!(aud(d_p1, w.p1, w.alice).await, "P1 digest, answer in P1");
    assert!(aud(d_p1, w.p1, w.bob).await);
    assert!(
        !aud(d_s1, w.p1, w.alice).await,
        "alice reads S1, but the P1 answer is seen by everyone in P1"
    );
    assert!(
        !aud(d_multi, w.p1, w.alice).await,
        "evidence in S1 leaks into a P1 answer"
    );
    assert!(aud(d_s1, w.s1, w.alice).await, "S1 digest, answer in S1");
    assert!(
        !aud(d_p1, w.s1, w.alice).await,
        "a P1 digest is not for the S1 audience either (own channel only)"
    );
    // 1:1 DM with the agent: requester's readable channels are allowed.
    assert!(aud(d_p1, w.dm_alice_agent, w.alice).await);
    assert!(aud(d_s1, w.dm_alice_agent, w.alice).await, "alice reads S1");
    assert!(
        aud(d_multi, w.dm_alice_agent, w.alice).await,
        "alice reads both evidence channels"
    );
    assert!(aud(d_dm, w.dm_alice_agent, w.alice).await);
    // A "DM" with a third person is not 1:1: own channel only.
    let group_dm = seed_channel(&su, w.ws, "dm", w.alice).await;
    for m in [w.alice, w.agent, w.bob] {
        join(&su, w.ws, group_dm, m).await;
    }
    assert!(
        !aud(d_s1, group_dm, w.alice).await,
        "three participants: not a 1:1 DM"
    );
    // The requester must be able to read the channel the answer goes to.
    assert!(!aud(d_p1, w.p1, w.carol).await, "carol is not in P1");
    // A requester who cannot read the evidence channel gets nothing beyond it; a non-member
    // requester of the DM gets nothing at all.
    assert!(
        !aud(d_s1, w.dm_alice_agent, w.bob).await,
        "bob is not in the DM"
    );
    assert!(
        !aud(d_s1, w.dm_bob_carol, w.bob).await,
        "human-human DM has no agent: own channel only"
    );
    assert!(!aud(d_p1, w.dm_bob_carol, w.bob).await);
    assert!(
        !aud(d_s1, w.p2, w.alice).await,
        "requester must read the answer channel"
    );
    // Stale / deleted / edited evidence, unknown digest, no requester.
    assert!(!aud(Uuid::new_v4(), w.p1, w.alice).await);
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = true WHERE id = '{d_p1}'"),
    )
    .await;
    assert!(!aud(d_p1, w.p1, w.alice).await, "stale");
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{m_s1}'"),
    )
    .await;
    assert!(!aud(d_s1, w.s1, w.alice).await, "deleted evidence");
    assert!(
        !bool_of(
            &wk,
            w.ws,
            None,
            &format!(
                "SELECT mem_digest_audience_ok('{d_dm}', '{}', NULL)",
                w.dm_alice_agent
            )
        )
        .await
    );
    // Another tenant cannot ask about A's digest.
    assert!(
        !bool_of(
            &wk,
            w.ws_b,
            None,
            &format!(
                "SELECT mem_digest_audience_ok('{d_dm}', '{}', '{}')",
                w.dm_alice_agent, w.alice
            )
        )
        .await
    );
}

// ---------------------------------------------------------------------------
// GUC hygiene (L1)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn identity_gucs_do_not_outlive_the_transaction() {
    let (_su, _app, w) = setup().await;
    // One physical connection, reused: a leak would be visible to the next borrower.
    let options: PgConnectOptions = database_url().parse().expect("url");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    let single = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("single-connection pool");
    for finish_with_commit in [true, false] {
        let mut tx = viewer_tx(&single, w.ws, Some(w.alice)).await;
        let inside: String = sqlx::query_scalar("SELECT current_setting('app.member_id', true)")
            .fetch_one(&mut *tx)
            .await
            .expect("inside");
        assert_eq!(inside, w.alice.to_string());
        if finish_with_commit {
            tx.commit().await.expect("commit");
        } else {
            tx.rollback().await.expect("rollback");
        }
        let (ws_after, member_after): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT current_setting('app.workspace_id', true), current_setting('app.member_id', true)",
        )
        .fetch_one(&single)
        .await
        .expect("after");
        assert_eq!(
            ws_after.unwrap_or_default(),
            "",
            "app.workspace_id leaked past the tx"
        );
        assert_eq!(
            member_after.unwrap_or_default(),
            "",
            "app.member_id leaked past the tx"
        );
    }
    // ... and with nothing set, the digest is invisible (fail closed on the reused connection).
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_digest")
        .fetch_one(&single)
        .await
        .expect("count");
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------------------
// worker-only functions (review 2: H-A / H-B) and the privilege matrix (M-A / M-B)
// ---------------------------------------------------------------------------

/// SECURITY DEFINER functions that ignore `app.member_id`. EXECUTE belongs to `momo_memory`
/// alone. (`mem_digest_evidence_ok` is the one definer function the RLS policy needs PUBLIC for.)
const WORKER_ONLY: [&str; 7] = [
    "mem_apply_digest",
    "mem_advance_cursor",
    "mem_record_serving",
    "mem_digest_rollup_inputs",
    "mem_channel_switch",
    "mem_digest_live",
    "mem_digest_audience_ok",
];
const RUNTIME_ROLES: [&str; 5] = [
    "momo_app",
    "momo_relay",
    "momo_worker",
    "momo_notifier",
    "momo_platform_admin",
];

async fn worker_only_calls(su: &PgPool, w: &World, digest: Uuid) -> Vec<(&'static str, String)> {
    vec![
        (
            "mem_apply_digest",
            resolve(
                su,
                &apply_sql(w.p1, None, "window", w.m_p1.1, w.m_p1.1, &[], &[w.m_p1.0]),
            )
            .await,
        ),
        (
            "mem_advance_cursor",
            format!(
                "SELECT mem_advance_cursor('{}', 0, '{}', now() + interval '1 minute')",
                w.p1,
                Uuid::new_v4()
            ),
        ),
        (
            "mem_record_serving",
            format!(
                "SELECT mem_record_serving('{}', '{}', '{{}}'::uuid[], '{{}}'::uuid[], 0, 0, 0)",
                w.run_p1, w.alice
            ),
        ),
        (
            "mem_digest_rollup_inputs",
            format!(
                "SELECT * FROM mem_digest_rollup_inputs('{}', NULL, 'day', 0, 999999)",
                w.s1
            ),
        ),
        (
            "mem_channel_switch",
            format!("SELECT mem_channel_switch('{}')", w.s1),
        ),
        (
            "mem_digest_live",
            format!("SELECT mem_digest_live('{digest}')"),
        ),
        (
            "mem_digest_audience_ok",
            format!(
                "SELECT mem_digest_audience_ok('{digest}', '{}', '{}')",
                w.s1, w.alice
            ),
        ),
    ]
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn worker_only_functions_are_closed_to_the_api_and_open_to_momo_memory() {
    let (su, app, w) = setup().await;
    // A private digest whose body an API session must never be able to read via a helper.
    let d_s1 = seed_digest(&su, w.ws, w.s1, w.m_s1.1, &[(w.m_s1.0, w.s1)]).await;
    sqlx::query("UPDATE mem_digest SET level = 'window', body = 'PRIVATE-BODY' WHERE id = $1")
        .bind(d_s1)
        .execute(&su)
        .await
        .expect("body");
    let calls = worker_only_calls(&su, &w, d_s1).await;
    assert_eq!(calls.len(), WORKER_ONLY.len());
    let plain_worker = worker_pool(false).await;
    let memory = worker_pool(true).await;

    for (name, sql) in &calls {
        // H-A / H-B: an API session (even a channel member) is refused by EXECUTE.
        assert_eq!(
            exec(&app, w.ws, Some(w.alice), sql).await,
            Err("42501".into()),
            "momo_app must not run {name}"
        );
        // ... and so is momo_worker itself: the membership has INHERIT FALSE, so it must
        // SET ROLE momo_memory (which drops BYPASSRLS) before it can call these.
        assert_eq!(
            exec(&plain_worker, w.ws, None, sql).await,
            Err("42501".into()),
            "momo_worker without SET ROLE must not run {name}"
        );
    }
    // The leak the review named, spelled out: rollup inputs of a private channel.
    let leak = format!(
        "SELECT body FROM mem_digest_rollup_inputs('{}', NULL, 'day', 0, 999999)",
        w.s1
    );
    assert_eq!(
        exec(&app, w.ws, Some(w.bob), &leak).await,
        Err("42501".into())
    );
    // momo_worker + SET ROLE momo_memory runs every one of them.
    for (name, sql) in &calls {
        let outcome = exec(&memory, w.ws, None, sql).await;
        assert!(outcome.is_ok(), "momo_memory must run {name}: {outcome:?}");
    }
    // ... the way #3162 will: `SET LOCAL ROLE` inside its own transaction, BYPASSRLS shed
    // for the tx only.
    let mut tx = viewer_tx(&plain_worker, w.ws, None).await;
    let (before,): (bool,) =
        sqlx::query_as("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&mut *tx)
            .await
            .expect("before");
    assert!(before, "plain momo_worker is BYPASSRLS");
    sqlx::query("SET LOCAL ROLE momo_memory")
        .execute(&mut *tx)
        .await
        .expect("SET LOCAL ROLE momo_memory");
    let (bypass, who): (bool, String) = sqlx::query_as(
        "SELECT rolbypassrls, current_user::text FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&mut *tx)
    .await
    .expect("inside");
    assert_eq!((bypass, who.as_str()), (false, "momo_memory"));
    let inputs: Vec<String> = sqlx::query_scalar(&leak)
        .fetch_all(&mut *tx)
        .await
        .expect("worker reads its rollup inputs");
    assert_eq!(inputs, vec!["PRIVATE-BODY".to_string()]);
    tx.commit().await.expect("commit");
    let after: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&plain_worker)
        .await
        .expect("after");
    assert_eq!(after, "momo_worker");

    // Under momo_memory nothing is readable by table: no table grant, and the tenant GUC
    // still gates the functions.
    for table in [
        "mem_digest",
        "mem_evidence",
        "mem_cursor",
        "mem_serving",
        "mem_settings",
        "message",
    ] {
        assert_eq!(
            exec(
                &memory,
                w.ws,
                None,
                &format!("SELECT count(*) FROM {table}")
            )
            .await,
            Err("42501".into()),
            "momo_memory has no direct access to {table}"
        );
    }
    let mut bare = memory.begin().await.expect("begin");
    let none: Vec<Uuid> = sqlx::query_scalar(&format!(
        "SELECT id FROM mem_digest_rollup_inputs('{}', NULL, 'day', 0, 999999)",
        w.s1
    ))
    .fetch_all(&mut *bare)
    .await
    .expect("no GUC");
    assert!(none.is_empty(), "no app.workspace_id: zero rows");
    let no_ws = sqlx::query_scalar::<_, Uuid>(&calls[0].1)
        .fetch_one(&mut *bare)
        .await;
    assert_eq!(no_ws.map_err(|e| sqlstate(&e)), Err("42501".to_string()));
    bare.rollback().await.expect("rollback");
    // Another tenant's GUC sees nothing of this tenant's private digest.
    let mut other = viewer_tx(&memory, w.ws_b, None).await;
    let none: Vec<Uuid> = sqlx::query_scalar(&format!(
        "SELECT id FROM mem_digest_rollup_inputs('{}', NULL, 'day', 0, 999999)",
        w.s1
    ))
    .fetch_all(&mut *other)
    .await
    .expect("other tenant");
    assert!(none.is_empty());
    other.rollback().await.expect("rollback");
}

/// M-A/M-B: every `mem_%` table x every runtime role x every DML privilege, plus the function
/// and membership side. Loops over pg_class, so a future mem_* table is covered too.
async fn assert_privilege_matrix(su: &PgPool, when: &str) {
    let existing: Vec<String> =
        sqlx::query_scalar("SELECT rolname::text FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1")
            .bind(
                RUNTIME_ROLES
                    .iter()
                    .map(|r| r.to_string())
                    .collect::<Vec<_>>(),
            )
            .fetch_all(su)
            .await
            .expect("roles");
    for must in ["momo_app", "momo_relay", "momo_worker", "momo_notifier"] {
        assert!(existing.iter().any(|r| r == must), "{when}: role {must}");
    }
    let mut roles = existing.clone();
    roles.push("momo_memory".to_string());
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND c.relname LIKE 'mem\\_%' ORDER BY 1",
    )
    .fetch_all(su)
    .await
    .expect("tables");
    assert!(tables.len() >= 5, "{when}: mem_* tables: {tables:?}");
    // PUBLIC is checked like a role (`has_*_privilege('public', ...)`): it may hold nothing.
    let mut holders = roles.clone();
    holders.push("public".to_string());
    for role in &holders {
        for table in &tables {
            for privilege in [
                "SELECT",
                "INSERT",
                "UPDATE",
                "DELETE",
                "TRUNCATE",
                "REFERENCES",
                "TRIGGER",
            ] {
                // momo_app: SELECT (RLS-gated) everywhere; INSERT/UPDATE/DELETE only on its own
                // settings. TRUNCATE / REFERENCES / TRIGGER nowhere (#3186 M-1).
                let allowed = role == "momo_app"
                    && (privilege == "SELECT"
                        || (table == "mem_settings"
                            && matches!(privilege, "INSERT" | "UPDATE" | "DELETE")));
                let has: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
                    .bind(role)
                    .bind(format!("public.{table}"))
                    .bind(privilege)
                    .fetch_one(su)
                    .await
                    .expect("has_table_privilege");
                assert_eq!(has, allowed, "{when}: {role} {privilege} on {table}");
            }
            // Column-level grants are a side door around the table-level revokes (#3186 M-3).
            for privilege in ["SELECT", "INSERT", "UPDATE", "REFERENCES"] {
                let allowed = role == "momo_app"
                    && (privilege == "SELECT"
                        || (table == "mem_settings" && matches!(privilege, "INSERT" | "UPDATE")));
                let has: bool = sqlx::query_scalar("SELECT has_any_column_privilege($1, $2, $3)")
                    .bind(role)
                    .bind(format!("public.{table}"))
                    .bind(privilege)
                    .fetch_one(su)
                    .await
                    .expect("has_any_column_privilege");
                assert_eq!(
                    has, allowed,
                    "{when}: {role} column-level {privilege} on {table}"
                );
            }
        }
    }
    let functions: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.oid::regprocedure::text, p.proname::text FROM pg_proc p \
           JOIN pg_namespace n ON n.oid = p.pronamespace \
          WHERE n.nspname = 'public' AND p.proname LIKE 'mem\\_%' AND p.prosecdef",
    )
    .fetch_all(su)
    .await
    .expect("definer functions");
    for must in WORKER_ONLY {
        assert!(
            functions.iter().any(|(_, n)| n == must),
            "{when}: {must} exists"
        );
    }
    for (signature, name) in &functions {
        if name == "mem_digest_evidence_ok"
            || name == "mem_item_evidence_ok"
            || name == "mem_search_items"
            // #3169: the proposal decision entry points (session_user guard + GUC viewer inside) and
            // the RLS policy helper are PUBLIC on purpose, like their #3168 siblings.
            || name == "mem_accept_proposal"
            || name == "mem_reject_proposal"
            || name == "mem_proposal_evidence_ok"
        {
            // The RLS policies call the evidence helpers as the reading role; `mem_search_items`
            // is the API entry point (session_user guard inside; the worker-only twin is
            // `mem_search_items_for`, which the loop covers).
            continue;
        }
        let public_grants: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a \
              WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'",
        )
        .bind(signature)
        .fetch_one(su)
        .await
        .expect("acl");
        assert_eq!(public_grants, 0, "{when}: PUBLIC can execute {signature}");
        for role in &holders {
            let has: bool = sqlx::query_scalar(
                "SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE')",
            )
            .bind(role)
            .bind(signature)
            .fetch_one(su)
            .await
            .expect("has_function_privilege");
            // `mem_search_items_core` (#3168 M-4) is callable by its owner alone: not even the
            // worker role may run it, because it takes the serve/browse flag from its caller.
            // `mem_proposal_decider` (#3169) is an internal helper of the accept / reject
            // functions and is callable by its owner alone, like `mem_search_items_core`.
            let expected = role == "momo_memory"
                && name != "mem_search_items_core"
                && name != "mem_proposal_decider";
            assert_eq!(has, expected, "{when}: {role} EXECUTE {signature}");
        }
    }
    // Membership: only momo_worker, without inheritance.
    for role in &existing {
        let member: bool = sqlx::query_scalar("SELECT pg_has_role($1, 'momo_memory', 'MEMBER')")
            .bind(role)
            .fetch_one(su)
            .await
            .expect("member");
        assert_eq!(
            member,
            role == "momo_worker",
            "{when}: {role} membership of momo_memory"
        );
    }
    // #3186 M-3: nobody but a superuser (who is a member of everything) is a member of
    // mem_definer, and momo_worker is the only non-superuser member of momo_memory. PUBLIC
    // cannot be a role member; its privileges are the `public` rows above.
    let outsiders: Vec<String> = sqlx::query_scalar(
        "SELECT rolname::text FROM pg_roles WHERE NOT rolsuper \
            AND ((rolname <> 'mem_definer' AND pg_has_role(oid, 'mem_definer', 'MEMBER')) \
              OR (rolname NOT IN ('momo_worker', 'momo_memory') \
                  AND pg_has_role(oid, 'momo_memory', 'MEMBER'))) \
          ORDER BY 1",
    )
    .fetch_all(su)
    .await
    .expect("membership outsiders");
    assert!(
        outsiders.is_empty(),
        "{when}: unexpected members of mem_definer / momo_memory: {outsiders:?}"
    );
    let (usage, set): (bool, bool) = sqlx::query_as(
        "SELECT pg_has_role('momo_worker', 'momo_memory', 'USAGE'), pg_has_role('momo_worker', 'momo_memory', 'SET')",
    )
    .fetch_one(su)
    .await
    .expect("worker grant");
    assert_eq!(
        (usage, set),
        (false, true),
        "{when}: INHERIT FALSE, SET TRUE"
    );
    let (bypass, login, superuser): (bool, bool, bool) = sqlx::query_as(
        "SELECT rolbypassrls, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'momo_memory'",
    )
    .fetch_one(su)
    .await
    .expect("momo_memory");
    assert!(
        !bypass && !login && !superuser,
        "{when}: momo_memory attributes"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn runtime_privileges_match_the_lockdown_and_survive_both_bootstraps() {
    let (su, _app, _w) = setup().await; // migrations, then bootstrap_roles.sql
    assert_privilege_matrix(&su, "after migrations + bootstrap_roles.sql").await;
    run_sql_file("bootstrap_roles.sql");
    assert_privilege_matrix(&su, "bootstrap_roles.sql applied again").await;
    run_sql_file("bootstrap_runtime_roles.sql");
    assert_privilege_matrix(&su, "after bootstrap_runtime_roles.sql").await;
}

// ---------------------------------------------------------------------------
// mem_apply_digest: read snapshot (M-C), switch (M-D), source_count (L-C)
// ---------------------------------------------------------------------------

fn with_snapshot(sql: &str, literal: &str) -> String {
    let start = sql.find("@SNAP[").expect("marker");
    let end = sql[start..].find("]@").expect("end") + start + 2;
    format!("{}{}{}", &sql[..start], literal, &sql[end..])
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn apply_digest_rejects_edits_after_the_read_and_honours_the_switch() {
    let (su, app, w) = setup().await;
    let wk = worker_pool(true).await;
    let (a1, s1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (a2, s2) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let ws = w.ws;
    let apply = |sql: String| {
        let wk = wk.clone();
        async move { uuid_of(&wk, ws, None, &sql).await }
    };
    let base = apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a2]);

    // M-C: the worker reads (snapshot), an edit lands while the model runs, apply refuses.
    let snapshot_at_read = resolve(&su, &base).await;
    su_exec(
        &su,
        &format!("UPDATE message SET body = 'edited', edited_at = now() WHERE id = '{a1}'"),
    )
    .await;
    assert_eq!(
        apply(snapshot_at_read.clone()).await,
        Err("40001".into()),
        "edit between read and apply"
    );
    assert_eq!(count(&app, w.ws, Some(w.bob), "mem_digest").await, 0);
    // Re-reading (fresh snapshot) succeeds, and the digest is readable...
    let d = apply(resolve(&su, &base).await)
        .await
        .expect("fresh snapshot");
    assert!(visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d));
    // ... until the next edit, which hides it again (read policy: edited_at > created_at).
    su_exec(
        &su,
        &format!("UPDATE message SET edited_at = now() WHERE id = '{a2}'"),
    )
    .await;
    assert!(!visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d));
    // A message deleted after the read cannot be summarised either.
    let snapshot = resolve(&su, &base).await;
    su_exec(
        &su,
        &format!("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = '{a2}'"),
    )
    .await;
    assert_eq!(
        apply(snapshot).await,
        Err("23503".into()),
        "deleted after read"
    );

    // Malformed snapshots are refused, never silently accepted.
    let (b1, t1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let one = apply_sql(w.p1, None, "window", t1, t1, &[], &[b1]);
    for (label, sql) in [
        (
            "NULL snapshot array",
            with_snapshot(&one, "NULL::timestamptz[]"),
        ),
        (
            "length mismatch",
            with_snapshot(&one, "ARRAY[NULL, NULL]::timestamptz[]"),
        ),
        (
            "read_at in the future",
            resolve(&su, &one)
                .await
                .replace(", now())", ", now() + interval '1 hour')"),
        ),
        (
            "snapshot after read_at",
            with_snapshot(&one, "ARRAY[now() + interval '1 hour']::timestamptz[]"),
        ),
    ] {
        assert_eq!(apply(sql).await, Err("23514".into()), "{label}");
    }
    // The evidence carries the read time.
    let earlier = resolve(&su, &one)
        .await
        .replace(", now())", ", now() - interval '5 minutes')");
    let d2 = apply(earlier).await.expect("read 5 minutes ago");
    let old: bool = sqlx::query_scalar(
        "SELECT bool_and(created_at < now() - interval '4 minutes') FROM mem_evidence WHERE digest_id = $1",
    )
    .bind(d2)
    .fetch_one(&su)
    .await
    .expect("created_at");
    assert!(old, "evidence.created_at is the worker's read time");

    // M-D: paused workspace / disabled workspace / excluded or paused channel refuse writes.
    let (c1, u1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let sql = resolve(&su, &apply_sql(w.p1, None, "window", u1, u1, &[], &[c1])).await;
    for (label, set, reset) in [
        (
            "workspace paused",
            format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws),
            format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
        ),
        (
            "workspace disabled",
            format!("INSERT INTO mem_settings (workspace_id, scope, enabled) VALUES ('{}', 'workspace', false)", w.ws),
            format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
        ),
        (
            "channel excluded",
            format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.p1),
            format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
        ),
        (
            "channel paused",
            format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, paused) VALUES ('{}', 'channel', '{}', true)", w.ws, w.p1),
            format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
        ),
    ] {
        su_exec(&su, &set).await;
        assert_eq!(apply(sql.clone()).await, Err("55000".into()), "{label}");
        su_exec(&su, &reset).await;
    }
    assert!(apply(sql).await.is_ok(), "switch back on: writes resume");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_digest_with_fewer_evidence_rows_than_source_count_is_hidden() {
    let (su, app, w) = setup().await;
    let wk = worker_pool(true).await;
    let (a1, s1) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let (a2, s2) = seed_message(&su, w.ws, w.p1, w.alice).await;
    let sql = resolve(
        &su,
        &apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a2]),
    )
    .await;
    let d = uuid_of(&wk, w.ws, None, &sql).await.expect("digest");
    let live = |q: String| {
        let wk = wk.clone();
        let ws = w.ws;
        async move { bool_of(&wk, ws, None, &q).await }
    };
    assert!(visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d));
    assert!(live(format!("SELECT mem_digest_live('{d}')")).await);
    // A partial hard delete leaves one of two evidence rows (superuser bypasses RLS here).
    su_exec(
        &su,
        &format!("DELETE FROM mem_evidence WHERE digest_id = '{d}' AND message_id = '{a1}'"),
    )
    .await;
    assert!(
        !visible_digests(&app, w.ws, Some(w.bob)).await.contains(&d),
        "reader policy hides a digest short of its evidence"
    );
    assert!(!live(format!("SELECT mem_digest_live('{d}')")).await);
    assert!(
        !live(format!(
            "SELECT mem_digest_audience_ok('{d}', '{}', '{}')",
            w.p1, w.bob
        ))
        .await
    );
    let inputs = ids_of(
        &wk,
        w.ws,
        None,
        &format!(
            "SELECT id FROM mem_digest_rollup_inputs('{}', NULL, 'day', 0, 999999)",
            w.p1
        ),
    )
    .await;
    assert!(inputs.is_empty(), "not a rollup input either");
}

// ---------------------------------------------------------------------------
// #3186: lock-block identity, GRANT ALL recovery, views, definer allow-list, sabotage
// ---------------------------------------------------------------------------

/// The text between the BEGIN/END markers of one file.
fn lock_region(path: &std::path::Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    assert_eq!(
        text.matches("-- BEGIN mem-lockdown").count(),
        1,
        "{path:?}: exactly one BEGIN marker"
    );
    assert_eq!(
        text.matches("-- END mem-lockdown").count(),
        1,
        "{path:?}: exactly one END marker"
    );
    let start = text.find("-- BEGIN mem-lockdown").expect("begin");
    let end = text.find("-- END mem-lockdown").expect("end") + "-- END mem-lockdown".len();
    assert!(start < end, "{path:?}: markers in order");
    text[start..end].to_string()
}

fn migration_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../server/Migrations/101_mem_lockdown_hardening.sql")
}

/// The allow-list self-check is restated by every migration that adds a definer function (101 and 102
/// are merged and stay untouched, #3191 M-6); the newest one is the one that matches the real state.
fn worker_migration_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../server/Migrations/105_mem_proposal.sql")
}

/// M-1: the lock block is one text in three files. Compared byte for byte (stronger than a
/// hash); the digest is printed so the PR can quote it.
#[test]
fn lock_block_is_identical_in_migration_and_both_bootstraps() {
    let migration = lock_region(&migration_path());
    let roles = lock_region(&sql_dir().join("bootstrap_roles.sql"));
    let runtime = lock_region(&sql_dir().join("bootstrap_runtime_roles.sql"));
    assert!(migration.len() > 2000, "the extracted block is not empty");
    assert!(migration.contains("relkind IN ('r', 'p', 'v', 'm')"));
    for (name, other) in [
        ("bootstrap_roles.sql", &roles),
        ("bootstrap_runtime_roles.sql", &runtime),
    ] {
        if &migration != other {
            let line = migration
                .lines()
                .zip(other.lines())
                .position(|(a, b)| a != b)
                .map_or_else(|| "length".to_string(), |i| format!("line {}", i + 1));
            panic!("migration 101 and {name} differ at {line} of the lock block");
        }
    }
}

/// M-1: after `GRANT ALL ON ALL TABLES ... TO momo_app` (and the other runtime roles, PUBLIC and
/// the two internal roles) a bootstrap re-run locks everything again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn grant_all_then_bootstrap_locks_the_memory_tables_again() {
    let (su, _app, _w) = setup().await;
    assert_privilege_matrix(&su, "before GRANT ALL").await;
    for file in ["bootstrap_roles.sql", "bootstrap_runtime_roles.sql"] {
        su_exec(
            &su,
            "GRANT ALL ON ALL TABLES IN SCHEMA public TO momo_app, momo_relay, momo_worker, momo_notifier",
        )
        .await;
        // PUBLIC only on the memory tables: opening PUBLIC on the whole schema would leak into
        // the other tests of this shared database.
        su_exec(
            &su,
            "GRANT ALL ON mem_digest, mem_evidence, mem_cursor, mem_serving, mem_settings TO PUBLIC",
        )
        .await;
        su_exec(&su, "GRANT momo_memory TO momo_app").await;
        su_exec(&su, "GRANT mem_definer TO momo_relay").await;
        su_exec(
            &su,
            "GRANT EXECUTE ON FUNCTION public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz) TO PUBLIC, momo_app, momo_relay",
        )
        .await;
        su_exec(
            &su,
            "GRANT INSERT (id), UPDATE (id), REFERENCES (id) ON mem_digest TO momo_app, momo_worker",
        )
        .await;
        // The damage is real: the door is open before the bootstrap runs (else this proves nothing).
        let probe: bool = sqlx::query_scalar(
            "SELECT has_table_privilege('momo_app', 'public.mem_settings', 'TRUNCATE') \
                AND has_table_privilege('momo_app', 'public.mem_digest', 'INSERT') \
                AND pg_has_role('momo_app', 'momo_memory', 'MEMBER') \
                AND pg_has_role('momo_relay', 'mem_definer', 'MEMBER') \
                AND has_any_column_privilege('momo_worker', 'public.mem_digest', 'UPDATE') \
                AND has_function_privilege('momo_app', 'public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)', 'EXECUTE') \
                AND has_function_privilege('public', 'public.mem_apply_digest(uuid, uuid, text, bigint, bigint, text, uuid[], text, text, text, uuid[], timestamptz[], timestamptz)', 'EXECUTE')",
        )
        .fetch_one(&su)
        .await
        .expect("damage probe");
        assert!(probe, "{file}: GRANT ALL must actually open the door first");
        run_sql_file(file);
        assert_privilege_matrix(&su, &format!("GRANT ALL, then {file}")).await;
    }
    su_exec(
        &su,
        "REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM momo_app, momo_relay, momo_worker, momo_notifier",
    )
    .await;
}

/// L-5: views and materialized views named mem_* are walked by the lock block too.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn lock_block_also_locks_views_and_materialized_views() {
    let (su, _app, _w) = setup().await;
    su_exec(&su, "DROP VIEW IF EXISTS mem_probe_view").await;
    su_exec(&su, "DROP MATERIALIZED VIEW IF EXISTS mem_probe_mv").await;
    su_exec(
        &su,
        "CREATE VIEW mem_probe_view AS SELECT id FROM mem_digest",
    )
    .await;
    su_exec(
        &su,
        "CREATE MATERIALIZED VIEW mem_probe_mv AS SELECT 1 AS x",
    )
    .await;
    for object in ["mem_probe_view", "mem_probe_mv"] {
        su_exec(
            &su,
            &format!(
                "GRANT ALL ON {object} TO momo_app, momo_relay, momo_worker, momo_notifier, PUBLIC"
            ),
        )
        .await;
        let open: bool = sqlx::query_scalar(
            "SELECT has_table_privilege('momo_relay', $1, 'SELECT') AND has_table_privilege('public', $1, 'SELECT')",
        )
        .bind(format!("public.{object}"))
        .fetch_one(&su)
        .await
        .expect("open probe");
        assert!(open, "{object}: opened first");
    }
    run_sql_file("bootstrap_roles.sql");
    // The matrix loops relkind r, p, v, m, so it covers both probes (and would fail on them).
    assert_privilege_matrix(&su, "views and matviews after bootstrap").await;
    su_exec(&su, "DROP VIEW mem_probe_view").await;
    su_exec(&su, "DROP MATERIALIZED VIEW mem_probe_mv").await;
}

/// L-1: the SECURITY DEFINER functions owned by mem_definer are exactly this list.
const DEFINER_ALLOW_LIST: [&str; 35] = [
    "mem_accept_proposal",
    "mem_add_item",
    "mem_adjust_tokens",
    "mem_advance_cursor",
    "mem_apply_digest",
    "mem_channel_eligible",
    "mem_channel_switch",
    "mem_cursor_state",
    "mem_digest_audience_ok",
    "mem_digest_evidence_ok",
    "mem_digest_index",
    "mem_digest_live",
    "mem_digest_rollup_inputs",
    "mem_drop_digest",
    "mem_item_audience_ok",
    "mem_item_evidence_ok",
    "mem_item_live",
    "mem_item_readable_by",
    "mem_message_changed",
    "mem_proposal_decider",
    "mem_proposal_evidence_ok",
    "mem_propose_item",
    "mem_record_serving",
    "mem_reject_proposal",
    "mem_reserve_tokens",
    "mem_search_items",
    "mem_search_items_core",
    "mem_search_items_for",
    "mem_serve_candidates",
    "mem_serve_items",
    "mem_serve_requester",
    "mem_serving_of",
    "mem_serving_record_of",
    "mem_stale_digests",
    "mem_token_budget",
];

/// The `DO` block that starts at `marker`, up to (not including) `until` or the end of the file.
fn tail_block(path: &std::path::Path, marker: &str, until: Option<&str>) -> String {
    let text = std::fs::read_to_string(path).expect("read");
    let start = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} in {path:?}"));
    let rest = &text[start..];
    match until {
        Some(u) => rest[..rest.find(u).unwrap_or_else(|| panic!("{u} in {path:?}"))].to_string(),
        None => rest.to_string(),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn security_definer_functions_owned_by_mem_definer_are_allow_listed() {
    let (su, _app, _w) = setup().await;
    let owned: Vec<String> = sqlx::query_scalar(
        "SELECT p.proname::text FROM pg_proc p WHERE p.prosecdef \
            AND pg_get_userbyid(p.proowner) = 'mem_definer' ORDER BY 1",
    )
    .fetch_all(&su)
    .await
    .expect("definer functions");
    assert_eq!(
        owned,
        DEFINER_ALLOW_LIST.to_vec(),
        "a SECURITY DEFINER function owned by mem_definer must be added to the allow-list \
         here and in the newest migration's allow-list (105_mem_proposal.sql) on purpose"
    );
    // The migration's own self-check passes on the good state ...
    let check = tail_block(&worker_migration_path(), "-- ── L-1", None);
    run_sql_text(&check).expect("allow-list check passes on the real state");
    // ... and fails, loudly, when a stranger function is owned by mem_definer (sabotage; the
    // single transaction rolls the rogue function back).
    let rogue = format!(
        "CREATE FUNCTION public.mem_rogue() RETURNS int LANGUAGE sql SECURITY DEFINER \
         SET search_path = pg_catalog AS $f$ SELECT 1 $f$; \
         ALTER FUNCTION public.mem_rogue() OWNER TO mem_definer; {check}"
    );
    let err = run_sql_text(&rogue).expect_err("a rogue definer function must be refused");
    assert!(
        err.contains("mem_rogue") && err.contains("allow-list"),
        "RED output: {err}"
    );
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_proc WHERE proname = 'mem_rogue'")
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(left, 0, "the sabotage rolled back");
}

/// L-4: the membership self-check in the bootstrap files can fail, and fails loudly.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn membership_self_check_fails_loudly() {
    let (_su, _app, _w) = setup().await;
    for file in ["bootstrap_roles.sql", "bootstrap_runtime_roles.sql"] {
        let check = tail_block(
            &sql_dir().join(file),
            "-- Membership self-check",
            Some("-- END mem-lockdown"),
        );
        run_sql_text(&check)
            .unwrap_or_else(|e| panic!("{file}: check passes on the good state: {e}"));
        for (damage, expect) in [
            (
                "GRANT mem_definer TO momo_app",
                "runtime role momo_app must not be a member of mem_definer",
            ),
            (
                "GRANT mem_definer TO momo_relay",
                "runtime role momo_relay must not be a member of mem_definer",
            ),
            (
                "GRANT momo_memory TO momo_notifier",
                "runtime role momo_notifier must not be a member of momo_memory",
            ),
            (
                "GRANT momo_memory TO momo_worker WITH INHERIT TRUE",
                "momo_worker must hold momo_memory with INHERIT FALSE",
            ),
        ] {
            let err = run_sql_text(&format!("{damage}; {check}"))
                .expect_err("the membership check must refuse this");
            assert!(
                err.contains(expect),
                "{file}: `{damage}` -> RED output: {err}"
            );
        }
    }
    // Nothing leaked: the sabotage ran inside single transactions that aborted.
    assert_privilege_matrix(&_su, "after membership sabotage").await;
}

/// L-3: the read policy of `mem_digest` calls `mem_digest_evidence_ok`, which itself reads
/// `mem_digest` as `mem_definer`. Two things stop that from recursing: the
/// `current_user = 'mem_definer'` branch in `mem_digest_sel`, and the `mem_digest_sel_definer`
/// policy (`TO mem_definer`), which Postgres ORs in and folds (`A OR (A AND B)` -> `A`).
/// Each sabotage runs in a transaction that rolls back.
///   * guard removed alone   -> still safe today (the definer arm absorbs it): the guard is
///     defence in depth, and this test pins that so nobody assumes it is the only stop;
///   * guard AND definer arm removed -> the read recurses: SQLSTATE 54001 (stack depth) here
///     (42P17 on builds that detect the cycle while planning). That is the RED.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn recursion_guard_in_the_digest_policy_is_load_bearing() {
    let (su, _app, w) = setup().await;
    let policy: String = sqlx::query_scalar(
        "SELECT qual FROM pg_policies WHERE tablename = 'mem_digest' AND policyname = 'mem_digest_sel'",
    )
    .fetch_one(&su)
    .await
    .expect("policy");
    assert!(
        policy.contains("mem_definer"),
        "the real policy carries the guard: {policy}"
    );
    let definer_arm: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_policies WHERE tablename = 'mem_digest' AND policyname = 'mem_digest_sel_definer'",
    )
    .fetch_one(&su)
    .await
    .expect("definer arm");
    assert_eq!(definer_arm, 1, "the definer read policy exists");
    // A row must exist so the policy function is actually evaluated.
    seed_digest(&su, w.ws, w.p1, w.m_p1.1, &[(w.m_p1.0, w.p1)]).await;

    #[derive(Clone, Copy, PartialEq)]
    enum Sabotage {
        None,
        GuardOnly,
        GuardAndDefinerArm,
    }
    let attempt = |sabotage: Sabotage| {
        let su = su.clone();
        let ws = w.ws;
        async move {
            let mut tx = su.begin().await.expect("begin");
            if sabotage != Sabotage::None {
                for drop in [
                    "DROP POLICY mem_digest_sel ON mem_digest",
                    "DROP POLICY mem_digest_sel_definer ON mem_digest",
                ] {
                    sqlx::query(drop).execute(&mut *tx).await.expect("drop");
                }
                sqlx::query(
                    "CREATE POLICY mem_digest_sel ON mem_digest FOR SELECT USING ( \
                       workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid \
                       AND NOT stale AND mem_digest_evidence_ok(id))",
                )
                .execute(&mut *tx)
                .await
                .expect("sabotaged policy");
                if sabotage == Sabotage::GuardOnly {
                    sqlx::query(
                        "CREATE POLICY mem_digest_sel_definer ON mem_digest FOR SELECT TO mem_definer \
                         USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)",
                    )
                    .execute(&mut *tx)
                    .await
                    .expect("definer arm");
                }
            }
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(ws.to_string())
                .execute(&mut *tx)
                .await
                .expect("guc");
            sqlx::query("SET LOCAL ROLE momo_app")
                .execute(&mut *tx)
                .await
                .expect("set role");
            let result = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM mem_digest")
                .fetch_one(&mut *tx)
                .await;
            let _ = tx.rollback().await;
            result
        }
    };

    let control = attempt(Sabotage::None).await;
    assert!(control.is_ok(), "guarded policy reads fine: {control:?}");
    let guard_only = attempt(Sabotage::GuardOnly).await;
    assert!(
        guard_only.is_ok(),
        "guard removed alone stays safe behind the definer arm: {guard_only:?}"
    );
    let err = attempt(Sabotage::GuardAndDefinerArm)
        .await
        .expect_err("without the guard and the definer arm the policy must recurse");
    let text = format!("{err}");
    eprintln!("L-3 sabotage RED output: [{}] {text}", sqlstate(&err));
    assert!(
        ["42P17", "54001"].contains(&sqlstate(&err).as_str()),
        "RED output: {text}"
    );
    // The sabotage rolled back: guard and definer arm are still there.
    let after: String = sqlx::query_scalar(
        "SELECT qual FROM pg_policies WHERE tablename = 'mem_digest' AND policyname = 'mem_digest_sel'",
    )
    .fetch_one(&su)
    .await
    .expect("policy");
    assert!(after.contains("mem_definer"), "restored: {after}");
    let arm_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_policies WHERE tablename = 'mem_digest' AND policyname = 'mem_digest_sel_definer'",
    )
    .fetch_one(&su)
    .await
    .expect("arm");
    assert_eq!(arm_after, 1, "definer arm restored");
}
