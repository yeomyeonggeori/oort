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
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
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
    for (workspace, channel) in [(ws, s1), (ws, p1), (ws_b, channel_b)] {
        let run = Uuid::new_v4();
        let agent_member = if workspace == ws { agent } else { bob_b };
        su_exec(
            su,
            &format!(
                "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id) \
                 VALUES ('{run}', '{workspace}', '{agent_member}', '{channel}')"
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
    format!(
        "SELECT mem_apply_digest('{channel}', {thread}, '{level}', {from}, {to}, 'body', {}, \
         'm', 'agent', 'v1', {})",
        arr(sources),
        arr(evidence)
    )
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
    let run = |sql: String| {
        let app = app.clone();
        async move { uuid_of(&app, ws, None, &sql).await }
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
    let mut tx = app.begin().await.expect("begin");
    let bare =
        sqlx::query_scalar::<_, Uuid>(&apply_sql(w.p1, None, "window", s1, s2, &[], &[a1, a2]))
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
        let app = app.clone();
        async move { ids_of(&app, ws, None, &sql).await }
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
    let call = |sql: String| {
        let app = app.clone();
        let ws = w.ws;
        async move {
            let mut tx = viewer_tx(&app, ws, None).await;
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
    let rec = |run: Uuid, digests: &[Uuid], withheld: i32, budget: i32, used: i32| {
        format!(
            "SELECT mem_record_serving('{run}', {}, '{{}}'::uuid[], {withheld}, {budget}, {used})",
            arr(digests)
        )
    };
    let r = uuid_of(&app, w.ws, None, &rec(w.run_s1, &[d], 2, 6000, 100))
        .await
        .expect("receipt");
    let ch: Uuid = sqlx::query_scalar("SELECT channel_id FROM mem_serving WHERE id = $1")
        .bind(r)
        .fetch_one(&su)
        .await
        .expect("row");
    assert_eq!(ch, w.s1, "channel_id == agent_run.channel_id");
    assert_eq!(
        uuid_of(&app, w.ws, None, &rec(w.run_s1, &[d], 0, 10, 1)).await,
        Err("23505".into()),
        "one receipt per run"
    );
    assert_eq!(
        uuid_of(
            &app,
            w.ws,
            None,
            &rec(w.run_p1, &[Uuid::new_v4()], 0, 10, 1)
        )
        .await,
        Err("23503".into()),
        "unknown digest"
    );
    assert_eq!(
        uuid_of(&app, w.ws, None, &rec(w.run_b, &[], 0, 10, 1)).await,
        Err("23503".into()),
        "run of another workspace"
    );
    assert_eq!(
        uuid_of(&app, w.ws, None, &rec(w.run_p1, &[], 0, 10, 11)).await,
        Err("23514".into()),
        "used > budget"
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
    let switch = |c: Uuid| format!("SELECT mem_channel_switch('{c}')");
    assert!(bool_of(&app, w.ws, None, &switch(w.p1)).await);
    assert!(
        !bool_of(&app, w.ws, None, &switch(w.s1)).await,
        "excluded channel"
    );
    su_exec(&su, &format!("UPDATE mem_settings SET paused = true WHERE scope = 'workspace' AND workspace_id = '{}'", w.ws)).await;
    assert!(
        !bool_of(&app, w.ws, None, &switch(w.p1)).await,
        "paused workspace"
    );
    assert!(
        bool_of(
            &app,
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
    let (su, app, w) = setup().await;
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
    let aud = |d: Uuid, answer: Uuid, requester: Uuid| {
        let app = app.clone();
        let ws = w.ws;
        async move {
            bool_of(
                &app,
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
            &app,
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
            &app,
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
