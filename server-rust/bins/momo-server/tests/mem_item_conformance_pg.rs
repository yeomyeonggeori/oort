//! #3168 / ADR-0196 — team-memory M2 items: `mem_item`, `mem_event`, `mem_add_item`,
//! `mem_search_items`, `mem_item_audience_ok`.
//!
//! Real Postgres, as `momo_app` (NOBYPASSRLS, not the table owner) after `bootstrap_roles.sql`
//! has re-granted ALL TABLES, and as `momo_worker` + `SET ROLE momo_memory` for the write side —
//! the states a running deployment has.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `an_extracted_item_is_stored_with_its_evidence_and_an_event` | evidence not copied from the digest, no event, no dedupe |
//! | `add_item_refuses_what_it_must_and_each_guard_is_load_bearing` | each `RAISE` in `mem_add_item` (sabotaged one at a time) |
//! | `item_read_policy_hides_what_the_viewer_may_not_see` | any clause of `mem_item_evidence_ok` (sabotaged one at a time) |
//! | `the_api_role_cannot_write_and_the_event_log_is_append_only` | a permissive write policy, or dropping the RESTRICTIVE deny |
//! | `search_respects_rls_and_narrows_the_audience` | the audience predicate, the RLS read, the stem/threshold |
//! | `the_item_audience_rule_pins_adr_d6_4` | the evidence-channel clause, the owner clause, the switch |
//! | `worker_only_item_functions_are_closed_to_the_api` | EXECUTE on `mem_add_item` / `mem_item_live` / `mem_item_audience_ok` |
//!
//! `#[ignore]` — needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test mem_item_conformance_pg -- --ignored --test-threads=1 --nocapture
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

async fn bool_of(pool: &PgPool, ws: Uuid, member: Option<Uuid>, sql: &str) -> bool {
    let mut tx = viewer_tx(pool, ws, member).await;
    let v: Option<bool> = sqlx::query_scalar(sql)
        .fetch_one(&mut *tx)
        .await
        .expect("bool query");
    tx.rollback().await.expect("rollback");
    v.expect("non-null bool")
}

// --- world -----------------------------------------------------------------------

struct W {
    ws: Uuid,
    ws_b: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    agent: Uuid,
    bob_b: Uuid,
    general: Uuid, // public: alice bob carol
    hr: Uuid,      // private: alice bob
    dm_aa: Uuid,   // dm: alice + agent
    dm_bc: Uuid,   // dm: bob + carol (human only)
    chan_b: Uuid,
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
            .bind(format!("mem-{ws}"))
            .execute(su)
            .await
            .expect("workspace");
        ids.push(ws);
    }
    let (ws, ws_b) = (ids[0], ids[1]);
    let alice = member(su, ws, "human").await;
    let bob = member(su, ws, "human").await;
    let carol = member(su, ws, "human").await;
    let agent = member(su, ws, "agent").await;
    let bob_b = member(su, ws_b, "human").await;
    let general = channel(su, ws, "public", alice).await;
    let hr = channel(su, ws, "private", alice).await;
    let dm_aa = channel(su, ws, "dm", alice).await;
    let dm_bc = channel(su, ws, "dm", bob).await;
    let chan_b = channel(su, ws_b, "public", bob_b).await;
    for m in [alice, bob, carol, agent] {
        join(su, ws, general, m).await;
    }
    for m in [alice, bob] {
        join(su, ws, hr, m).await;
    }
    for m in [alice, agent] {
        join(su, ws, dm_aa, m).await;
    }
    for m in [bob, carol] {
        join(su, ws, dm_bc, m).await;
    }
    join(su, ws_b, chan_b, bob_b).await;
    W {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        agent,
        bob_b,
        general,
        hr,
        dm_aa,
        dm_bc,
        chan_b,
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

fn add_sql(digest: Uuid, kind: &str, evidence: &[Uuid], ephemeral: bool) -> String {
    format!(
        "SELECT mem_add_item('{digest}', '{kind}', $1, NULL, {}, 0.8::real, {ephemeral}, 'items-v1', 'test-model')",
        arr(evidence)
    )
}

async fn add_item(
    wk: &PgPool,
    ws: Uuid,
    digest: Uuid,
    kind: &str,
    body: &str,
    evidence: &[Uuid],
) -> Result<Option<Uuid>, String> {
    let mut tx = viewer_tx(wk, ws, None).await;
    let r = sqlx::query_scalar::<_, Option<Uuid>>(&add_sql(digest, kind, evidence, false))
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

/// A superuser transaction in which `function` has been redefined with each `from` replaced by
/// `to`. The caller runs its scenario in it and rolls back. The RED evidence: what the shipped
/// function refuses, the sabotaged one lets through.
async fn sabotage_tx(
    su: &PgPool,
    function: &str,
    edits: &[(&str, &str)],
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin");
    redefine(&mut tx, function, edits).await;
    tx
}

/// Redefine `function` inside `tx` with each `from` replaced by `to` (more than one function can be
/// sabotaged in the same transaction).
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

/// Continue as `role` with the tenant (and optionally viewer) GUCs set, inside `tx`.
async fn become_role(tx: &mut sqlx::PgConnection, role: &str, ws: Uuid, member: Option<Uuid>) {
    set_gucs(tx, Some(ws), member).await;
    sqlx::query(&format!("SET LOCAL ROLE {role}"))
        .execute(&mut *tx)
        .await
        .expect("set role");
}

/// Rows a viewer reads from `mem_item` with `function` sabotaged.
async fn items_seen_with(
    su: &PgPool,
    function: &str,
    edits: &[(&str, &str)],
    ws: Uuid,
    viewer: Uuid,
) -> Vec<Uuid> {
    let mut tx = sabotage_tx(su, function, edits).await;
    become_role(&mut tx, "momo_app", ws, Some(viewer)).await;
    let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM mem_item")
        .fetch_all(&mut *tx)
        .await
        .expect("read");
    ids.sort();
    tx.rollback().await.expect("rollback");
    ids
}

// ---------------------------------------------------------------------------
// write: the happy path and the event
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn an_extracted_item_is_stored_with_its_evidence_and_an_event() {
    let (su, _app, wk, w) = setup().await;
    let m1 = say(
        &su,
        w.ws,
        w.general,
        w.alice,
        "배포는 금요일 오후에 하기로 했어요",
    )
    .await;
    let m2 = say(&su, w.ws, w.general, w.bob, "좋아요 제가 준비할게요").await;
    let d = apply_digest(&wk, w.ws, w.general, &[m1, m2]).await;

    let body = "배포는 금요일 오후에 한다";
    let item = add_item(&wk, w.ws, d, "decision", body, &[m1.0])
        .await
        .expect("add")
        .expect("a new item");
    let row: (
        String,
        String,
        Option<Uuid>,
        Uuid,
        String,
        i32,
        String,
        String,
        bool,
    ) = sqlx::query_as(
        "SELECT space_kind, kind, owner_member_id, channel_id, origin, source_count, \
                    extractor_version, model, forget_after IS NULL FROM mem_item WHERE id = $1",
    )
    .bind(item)
    .fetch_one(&su)
    .await
    .expect("row");
    assert_eq!(
        row,
        (
            "channel".into(),
            "decision".into(),
            None,
            w.general,
            "extracted".into(),
            1,
            "items-v1".into(),
            "test-model".into(),
            true
        )
    );
    // valid_from is the evidence's time, not the caller's.
    let same: bool = sqlx::query_scalar(
        "SELECT i.valid_from = m.created_at FROM mem_item i, message m WHERE i.id = $1 AND m.id = $2",
    )
    .bind(item)
    .bind(m1.0)
    .fetch_one(&su)
    .await
    .expect("valid_from");
    assert!(same);
    // Evidence: copied from the digest's evidence (same snapshot time), item-owned.
    let ev: Vec<(Uuid, Uuid, bool)> = sqlx::query_as(
        "SELECT e.message_id, e.channel_id, \
                e.created_at = (SELECT de.created_at FROM mem_evidence de WHERE de.digest_id = $2 AND de.message_id = e.message_id) \
           FROM mem_evidence e WHERE e.item_id = $1",
    )
    .bind(item)
    .bind(d)
    .fetch_all(&su)
    .await
    .expect("evidence");
    assert_eq!(ev, vec![(m1.0, w.general, true)]);
    // The lifecycle event carries ids and counters, never the body.
    let (action, detail): (String, String) = sqlx::query_as(
        "SELECT action, detail::text FROM mem_event WHERE target_kind = 'item' AND target_id = $1",
    )
    .bind(item)
    .fetch_one(&su)
    .await
    .expect("event");
    assert_eq!(action, "created");
    assert!(
        detail.contains(&d.to_string()) && !detail.contains("금요일"),
        "{detail}"
    );

    // Idempotent: the same content (whitespace-insensitively) adds nothing and logs nothing.
    assert_eq!(
        add_item(
            &wk,
            w.ws,
            d,
            "decision",
            "  배포는   금요일 오후에 한다 ",
            &[m1.0]
        )
        .await,
        Ok(None)
    );
    let (items, events): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM mem_item WHERE channel_id = $1), \
                (SELECT count(*) FROM mem_event WHERE workspace_id = $2 AND action = 'created')",
    )
    .bind(w.general)
    .bind(w.ws)
    .fetch_one(&su)
    .await
    .expect("counts");
    assert_eq!((items, events), (1, 1));
    // A different kind with the same words is a different item.
    assert!(matches!(
        add_item(&wk, w.ws, d, "fact", body, &[m1.0]).await,
        Ok(Some(_))
    ));
    // An ephemeral item gets a forget horizon (~14 days).
    let mut tx = viewer_tx(&wk, w.ws, None).await;
    let eph: Uuid = sqlx::query_scalar(&add_sql(d, "fact", &[m2.0], true))
        .bind("이번 주 목요일에는 자리를 비운다")
        .fetch_one(&mut *tx)
        .await
        .expect("ephemeral");
    tx.commit().await.expect("commit");
    let days: f64 = sqlx::query_scalar(
        "SELECT (extract(epoch FROM forget_after - now()) / 86400)::float8 FROM mem_item WHERE id = $1",
    )
    .bind(eph)
    .fetch_one(&su)
    .await
    .expect("horizon");
    assert!((13.0..=14.1).contains(&days), "{days}");

    // A regenerated item: if the old row lost its evidence (edit), the re-extraction lands as a
    // NEW row and the old one is marked stale (the dedupe index excludes stale rows).
    su_exec(
        &su,
        &format!(
            "UPDATE message SET edited_at = now() + interval '1 second' WHERE id = '{}'",
            m2.0
        ),
    )
    .await;
    let m3 = say(
        &su,
        w.ws,
        w.general,
        w.bob,
        "이번 주 목요일에는 자리를 비운다",
    )
    .await;
    let d2 = apply_digest(&wk, w.ws, w.general, &[m3]).await;
    let again = add_item(
        &wk,
        w.ws,
        d2,
        "fact",
        "이번 주 목요일에는 자리를 비운다",
        &[m3.0],
    )
    .await
    .expect("re-extraction")
    .expect("the dead twin does not block the new row");
    assert_ne!(again, eph);
    let old_stale: bool = sqlx::query_scalar("SELECT stale FROM mem_item WHERE id = $1")
        .bind(eph)
        .fetch_one(&su)
        .await
        .expect("stale");
    assert!(old_stale, "the row that lost its evidence was marked stale");

    // A human ↔ agent DM item is a personal-space item; the owner comes from the DM, not the caller.
    let dm1 = say(
        &su,
        w.ws,
        w.dm_aa,
        w.alice,
        "내 알림은 오전에만 받고 싶어요",
    )
    .await;
    let dd = apply_digest(&wk, w.ws, w.dm_aa, &[dm1]).await;
    let pi = add_item(&wk, w.ws, dd, "fact", "알림은 오전에만 받는다", &[dm1.0])
        .await
        .expect("dm item")
        .expect("id");
    let (space, owner): (String, Option<Uuid>) =
        sqlx::query_as("SELECT space_kind, owner_member_id FROM mem_item WHERE id = $1")
            .bind(pi)
            .fetch_one(&su)
            .await
            .expect("personal");
    assert_eq!((space.as_str(), owner), ("personal", Some(w.alice)));
}

// ---------------------------------------------------------------------------
// write: every guard, and proof each is load-bearing
// ---------------------------------------------------------------------------

const ADD_FN: &str =
    "public.mem_add_item(uuid, text, text, text, uuid[], real, boolean, text, text)";

fn secret_body() -> String {
    // Built at run time so the source carries no token-shaped literal.
    format!(
        "배포 키는 {}{} 입니다",
        "ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3"
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn add_item_refuses_what_it_must_and_each_guard_is_load_bearing() {
    let (su, app, wk, w) = setup().await;
    let a1 = say(&su, w.ws, w.general, w.alice, "금요일 배포로 결정했습니다").await;
    let a2 = say(&su, w.ws, w.general, w.bob, "제가 담당할게요").await;
    let a3 = say(&su, w.ws, w.general, w.alice, "이 메시지는 요약 밖입니다").await;
    let bot = say(
        &su,
        w.ws,
        w.general,
        w.agent,
        "에이전트가 배포는 목요일이라고 말했다",
    )
    .await;
    let other = say(&su, w.ws, w.hr, w.alice, "다른 채널의 메시지").await;
    let d = apply_digest(&wk, w.ws, w.general, &[a1, a2, bot]).await;
    let ok_body = "금요일 배포로 결정했다";

    // ---- one row per guard: (label, kind, body, evidence, digest, expected SQLSTATE)
    let secret = secret_body();
    let long = "가".repeat(601);
    type GuardCase<'a> = (&'a str, &'a str, String, Vec<Uuid>, Uuid, &'a str);
    let cases: Vec<GuardCase> = vec![
        (
            "kind outside decision/fact/commitment",
            "preference",
            ok_body.into(),
            vec![a1.0],
            d,
            "23514",
        ),
        (
            "blank body",
            "decision",
            "   ".into(),
            vec![a1.0],
            d,
            "23514",
        ),
        (
            "body over 600 characters",
            "decision",
            long,
            vec![a1.0],
            d,
            "23514",
        ),
        (
            "secret-shaped body",
            "decision",
            secret.clone(),
            vec![a1.0],
            d,
            "23514",
        ),
        (
            "no evidence",
            "decision",
            ok_body.into(),
            vec![],
            d,
            "23514",
        ),
        (
            "duplicate evidence",
            "decision",
            ok_body.into(),
            vec![a1.0, a1.0],
            d,
            "23514",
        ),
        (
            "evidence outside the digest",
            "decision",
            ok_body.into(),
            vec![a3.0],
            d,
            "23503",
        ),
        (
            "evidence of another channel",
            "decision",
            ok_body.into(),
            vec![other.0],
            d,
            "23503",
        ),
        (
            "evidence written by an agent",
            "decision",
            ok_body.into(),
            vec![bot.0],
            d,
            "23514",
        ),
        (
            "unknown digest",
            "decision",
            ok_body.into(),
            vec![a1.0],
            Uuid::new_v4(),
            "23503",
        ),
    ];
    for (label, kind, body, evidence, digest, want) in &cases {
        let got = add_item(&wk, w.ws, *digest, kind, body, evidence).await;
        assert_eq!(got, Err((*want).to_string()), "{label}");
    }
    // tenant: the digest lives in the other workspace as far as the GUC is concerned.
    assert_eq!(
        add_item(&wk, w.ws_b, d, "decision", ok_body, &[a1.0]).await,
        Err("23503".into()),
        "cross-tenant digest"
    );
    // no tenant GUC at all.
    let mut bare = wk.begin().await.expect("begin");
    let r = sqlx::query_scalar::<_, Option<Uuid>>(&add_sql(d, "decision", &[a1.0], false))
        .bind(ok_body)
        .fetch_one(&mut *bare)
        .await;
    assert_eq!(
        r.map_err(|e| sqlstate(&e)),
        Err("42501".to_string()),
        "no GUC"
    );
    bare.rollback().await.expect("rollback");

    // ---- the API role cannot call it at all
    let call = add_sql(d, "decision", &[a1.0], false).replace("$1", "'x'");
    assert_eq!(
        exec(&app, w.ws, Some(w.alice), &call).await,
        Err("42501".into())
    );

    // ---- evidence deleted / edited after the digest was written
    let gone = say(&su, w.ws, w.general, w.bob, "곧 지워질 메시지").await;
    let edited = say(&su, w.ws, w.general, w.bob, "곧 고쳐질 메시지").await;
    let d_gone = apply_digest(&wk, w.ws, w.general, &[gone, edited]).await;
    // Through the product the edit/delete trigger marks the digest stale in the same tx (102 L-2),
    // and add_item refuses a stale digest. The checks below are the SECOND line — the race the
    // trigger cannot see (an edit that commits between the worker's read and this call, or a
    // path that skips the trigger) — so switch the trigger off for the sabotage of the source.
    su_exec(
        &su,
        "ALTER TABLE message DISABLE TRIGGER mem_message_changed_trg",
    )
    .await;
    su_exec(
        &su,
        &format!(
            "UPDATE message SET state = 'deleted', deleted_at = now() WHERE id = '{}'",
            gone.0
        ),
    )
    .await;
    su_exec(
        &su,
        &format!(
            "UPDATE message SET edited_at = now() + interval '1 second' WHERE id = '{}'",
            edited.0
        ),
    )
    .await;
    su_exec(
        &su,
        "ALTER TABLE message ENABLE TRIGGER mem_message_changed_trg",
    )
    .await;
    assert_eq!(
        add_item(&wk, w.ws, d_gone, "fact", "지워질 사실", &[gone.0]).await,
        Err("23503".into()),
        "deleted after the digest"
    );
    assert_eq!(
        add_item(&wk, w.ws, d_gone, "fact", "고쳐질 사실", &[edited.0]).await,
        Err("40001".into()),
        "edited after the digest (the worker re-reads and retries)"
    );

    // ---- stale digest
    let s1 = say(&su, w.ws, w.general, w.alice, "stale 요약의 근거").await;
    let d_stale = apply_digest(&wk, w.ws, w.general, &[s1]).await;
    su_exec(
        &su,
        &format!("UPDATE mem_digest SET stale = true WHERE id = '{d_stale}'"),
    )
    .await;
    assert_eq!(
        add_item(
            &wk,
            w.ws,
            d_stale,
            "fact",
            "stale 요약에서 온 사실",
            &[s1.0]
        )
        .await,
        Err("23514".into())
    );

    // ---- switches: channel excluded, workspace paused, human ↔ human DM
    let sw = say(&su, w.ws, w.general, w.alice, "스위치 시험 메시지").await;
    let d_sw = apply_digest(&wk, w.ws, w.general, &[sw]).await;
    su_exec(
        &su,
        &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.general),
    )
    .await;
    assert_eq!(
        add_item(&wk, w.ws, d_sw, "fact", "제외된 채널의 사실", &[sw.0]).await,
        Err("55000".into()),
        "channel excluded"
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE channel_id = '{}'", w.dm_aa),
    )
    .await;
    su_exec(
        &su,
        &format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws),
    )
    .await;
    assert_eq!(
        add_item(
            &wk,
            w.ws,
            d_sw,
            "fact",
            "정지된 워크스페이스의 사실",
            &[sw.0]
        )
        .await,
        Err("55000".into()),
        "workspace paused"
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
    )
    .await;
    let hh = say(&su, w.ws, w.dm_bc, w.bob, "사람끼리의 대화").await;
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_digest (workspace_id, channel_id, level, from_seq, to_seq, body, source_count, prompt_version) \
             VALUES ('{}', '{}', 'window', {}, {}, 'x', 1, 'v')",
            w.ws, w.dm_bc, hh.1, hh.1
        ),
    )
    .await;
    let d_hh: Uuid = sqlx::query_scalar("SELECT id FROM mem_digest WHERE channel_id = $1")
        .bind(w.dm_bc)
        .fetch_one(&su)
        .await
        .expect("dm digest");
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_evidence (workspace_id, digest_id, message_id, channel_id) VALUES ('{}', '{d_hh}', '{}', '{}')",
            w.ws, hh.0, w.dm_bc
        ),
    )
    .await;
    assert_eq!(
        add_item(&wk, w.ws, d_hh, "fact", "사람끼리 DM 의 사실", &[hh.0]).await,
        Err("55000".into()),
        "human-to-human DM is never remembered"
    );

    // ---- sabotage: remove each RAISE and the call goes through (RED for the guard)
    // Every case below reuses a scenario proven to fail above.
    struct Sab {
        label: &'static str,
        raise: &'static str,
        body: String,
        evidence: Vec<Uuid>,
        digest: Uuid,
        channel_ws: Uuid,
    }
    let sabs = vec![
        Sab {
            label: "agent-authored evidence",
            raise: "RAISE EXCEPTION 'mem_add_item: evidence written by an agent or bot cannot support a memory item'\n      USING ERRCODE = '23514';",
            body: "에이전트 발언에서 나온 사실".into(),
            evidence: vec![bot.0],
            digest: d,
            channel_ws: w.ws,
        },
        Sab {
            label: "evidence outside the digest",
            raise: "RAISE EXCEPTION 'mem_add_item: evidence must be a subset of the digest evidence' USING ERRCODE = '23503';",
            body: "요약 밖 근거로 만든 사실".into(),
            evidence: vec![a3.0],
            digest: d,
            channel_ws: w.ws,
        },
        Sab {
            label: "evidence deleted after the digest",
            raise: "RAISE EXCEPTION 'mem_add_item: evidence message is not a live message of the digest channel'\n      USING ERRCODE = '23503';",
            body: "지워진 근거로 만든 사실".into(),
            evidence: vec![gone.0],
            digest: d_gone,
            channel_ws: w.ws,
        },
        Sab {
            label: "secret-shaped body",
            raise: "RAISE EXCEPTION 'mem_add_item: body looks like a credential' USING ERRCODE = '23514';",
            body: secret.clone(),
            evidence: vec![a1.0],
            digest: d,
            channel_ws: w.ws,
        },
        Sab {
            label: "edited after the digest",
            raise: "RAISE EXCEPTION 'mem_add_item: evidence was edited after it was read' USING ERRCODE = '40001';",
            body: "고쳐진 근거로 만든 사실".into(),
            evidence: vec![edited.0],
            digest: d_gone,
            channel_ws: w.ws,
        },
        Sab {
            label: "stale digest / non-window digest",
            raise: "RAISE EXCEPTION 'mem_add_item: items come from a live window digest' USING ERRCODE = '23514';",
            body: "stale 요약에서 온 사실".into(),
            evidence: vec![s1.0],
            digest: d_stale,
            channel_ws: w.ws,
        },
    ];
    for s in sabs {
        // control: the shipped function refuses.
        assert!(
            add_item(&wk, s.channel_ws, s.digest, "fact", &s.body, &s.evidence)
                .await
                .is_err(),
            "control: {} is refused",
            s.label
        );
        let sql = add_sql(s.digest, "fact", &s.evidence, false);
        let l4 = "RAISE EXCEPTION 'mem_add_item: inserted % evidence rows, expected %', v_inserted, v_n\n      USING ERRCODE = '23503';";
        let mut edits = vec![(s.raise, "NULL;")];
        if s.label == "evidence outside the digest" {
            // L-4 is the second net for this shape: with only the subset check gone the count
            // check on the inserted evidence rows still refuses.
            let mut tx = sabotage_tx(&su, ADD_FN, &edits).await;
            become_role(&mut tx, "momo_memory", s.channel_ws, None).await;
            let net = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
                .bind(&s.body)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| sqlstate(&e));
            tx.rollback().await.ok();
            eprintln!("RED(net) subset check gone, L-4 row-count check still refuses -> {net:?}");
            assert_eq!(net, Err("23503".to_string()));
            edits.push((l4, "NULL;"));
        }
        let mut tx = sabotage_tx(&su, ADD_FN, &edits).await;
        become_role(&mut tx, "momo_memory", s.channel_ws, None).await;
        let outcome = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
            .bind(&s.body)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| sqlstate(&e));
        tx.rollback().await.ok();
        eprintln!("RED {}: guard removed -> {outcome:?}", s.label);
        assert!(
            outcome.is_ok(),
            "{}: without its guard the call must succeed: {outcome:?}",
            s.label
        );
    }
    // The switch and the DM rule live in mem_channel_eligible, not in mem_add_item: sabotage that.
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.general)).await;
    let sql = add_sql(d_sw, "fact", &[sw.0], false);
    let mut tx = sabotage_tx(
        &su,
        "public.mem_channel_switch(uuid)",
        &[("SELECT COALESCE((", "SELECT true OR COALESCE((")],
    )
    .await;
    become_role(&mut tx, "momo_memory", w.ws, None).await;
    let outcome = sqlx::query_scalar::<_, Option<Uuid>>(&sql)
        .bind("제외 스위치를 무시하면 저장된다")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    eprintln!("RED channel switch: switch check neutralised -> {outcome:?}");
    assert!(outcome.is_ok(), "{outcome:?}");
    su_exec(
        &su,
        &format!(
            "DELETE FROM mem_settings WHERE channel_id = '{}'",
            w.general
        ),
    )
    .await;
}

// ---------------------------------------------------------------------------
// read policy
// ---------------------------------------------------------------------------

const EVIDENCE_OK: &str = "public.mem_item_readable_by(uuid, uuid)";

struct Items {
    gen_item: Uuid, // general, evidence: general
    hr_item: Uuid,  // hr, evidence: hr
    multi: Uuid,    // home general, evidence: general + hr (forged straight into the table)
    dm_item: Uuid,  // personal, alice ↔ agent DM
    gen_msg: (Uuid, i64),
    hr_msg: (Uuid, i64),
}

async fn seed_items(su: &PgPool, wk: &PgPool, w: &W) -> Items {
    let g = say(su, w.ws, w.general, w.alice, "공개 채널의 결정 기억테스트").await;
    let h = say(
        su,
        w.ws,
        w.hr,
        w.alice,
        "연봉 조정은 11월 CANARY 기억테스트",
    )
    .await;
    let d_g = apply_digest(wk, w.ws, w.general, &[g]).await;
    let d_h = apply_digest(wk, w.ws, w.hr, &[h]).await;
    let gen_item = add_item(
        wk,
        w.ws,
        d_g,
        "decision",
        "공개 채널의 결정 기억테스트",
        &[g.0],
    )
    .await
    .expect("gen")
    .expect("id");
    let hr_item = add_item(
        wk,
        w.ws,
        d_h,
        "fact",
        "연봉 조정은 11월 CANARY 기억테스트",
        &[h.0],
    )
    .await
    .expect("hr")
    .expect("id");
    let dm = say(
        su,
        w.ws,
        w.dm_aa,
        w.alice,
        "내 개인 선호 기억테스트 오전 알림",
    )
    .await;
    let d_dm = apply_digest(wk, w.ws, w.dm_aa, &[dm]).await;
    let dm_item = add_item(
        wk,
        w.ws,
        d_dm,
        "fact",
        "내 개인 선호 기억테스트 오전 알림",
        &[dm.0],
    )
    .await
    .expect("dm")
    .expect("id");
    // A multi-channel item cannot be written through mem_add_item (D6-1); forge one to prove
    // the READ rule (intersection of evidence channels) on its own.
    let multi = Uuid::new_v4();
    su_exec(
        su,
        &format!(
            "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, body, valid_from, \
                content_hash, extractor_version, source_count) \
             VALUES ('{multi}', '{}', 'channel', '{}', 'fact', '합성 항목 기억테스트', now(), 'h-multi', 'forged', 2)",
            w.ws, w.general
        ),
    )
    .await;
    for (msg, ch) in [(g.0, w.general), (h.0, w.hr)] {
        su_exec(
            su,
            &format!(
                "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ('{}', '{multi}', '{msg}', '{ch}')",
                w.ws
            ),
        )
        .await;
    }
    Items {
        gen_item,
        hr_item,
        multi,
        dm_item,
        gen_msg: g,
        hr_msg: h,
    }
}

async fn visible(app: &PgPool, w: &W, viewer: Option<Uuid>) -> Vec<Uuid> {
    ids_of(app, w.ws, viewer, "SELECT id FROM mem_item").await
}

fn sorted(mut v: Vec<Uuid>) -> Vec<Uuid> {
    v.sort();
    v
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn item_read_policy_hides_what_the_viewer_may_not_see() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;

    // reader / non-reader / multi-channel intersection / personal owner
    assert_eq!(
        visible(&app, &w, Some(w.alice)).await,
        sorted(vec![it.gen_item, it.hr_item, it.multi, it.dm_item]),
        "alice reads everything she is a member of, incl. her own DM item"
    );
    assert_eq!(
        visible(&app, &w, Some(w.bob)).await,
        sorted(vec![it.gen_item, it.hr_item, it.multi]),
        "bob is in #general and #hr, but not alice's DM"
    );
    assert_eq!(
        visible(&app, &w, Some(w.carol)).await,
        sorted(vec![it.gen_item]),
        "carol reads #general only: the item with one unreadable evidence channel is hidden entirely"
    );
    assert_eq!(
        visible(&app, &w, Some(w.agent)).await,
        sorted(vec![it.gen_item]),
        "the agent is a DM member but not the owner of a personal item"
    );
    assert!(
        visible(&app, &w, None).await.is_empty(),
        "no app.member_id: nothing"
    );
    assert!(
        ids_of(&app, w.ws_b, Some(w.bob_b), "SELECT id FROM mem_item")
            .await
            .is_empty(),
        "another workspace sees nothing"
    );
    assert!(
        ids_of(&app, w.ws_b, Some(w.alice), "SELECT id FROM mem_item")
            .await
            .is_empty(),
        "a member id from workspace A under workspace B's tenant sees nothing"
    );

    // membership: leaving hides it at once.
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = now() WHERE channel_id = '{}' AND member_id = '{}'",
            w.hr, w.bob
        ),
    )
    .await;
    assert_eq!(
        visible(&app, &w, Some(w.bob)).await,
        sorted(vec![it.gen_item])
    );
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = NULL WHERE channel_id = '{}' AND member_id = '{}'",
            w.hr, w.bob
        ),
    )
    .await;
    // a suspended member reads nothing.
    su_exec(
        &su,
        &format!(
            "UPDATE member SET status = 'suspended' WHERE id = '{}'",
            w.bob
        ),
    )
    .await;
    assert!(visible(&app, &w, Some(w.bob)).await.is_empty());
    su_exec(
        &su,
        &format!("UPDATE member SET status = 'active' WHERE id = '{}'", w.bob),
    )
    .await;

    // ---- sabotage each clause of mem_item_evidence_ok on one scenario each
    // (label, sabotage edit, mutation that should hide the item, viewer, item that must leak)
    struct Case {
        label: &'static str,
        edits: Vec<(&'static str, &'static str)>,
        mutate: String,
        undo: String,
        viewer: Uuid,
        leaks: Uuid,
    }
    // home clause: an item stored in #hr whose only evidence is a #general message (forged; mem_add_item
    // cannot produce it) must still be hidden from someone who cannot read #hr.
    let odd = Uuid::new_v4();
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) \
             VALUES ('{odd}', '{}', 'channel', '{}', 'fact', '홈 채널 시험 항목', now(), 'h-odd', 'forged', 1)",
            w.ws, w.hr
        ),
    )
    .await;
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ('{}', '{odd}', '{}', '{}')",
            w.ws, it.gen_msg.0, w.general
        ),
    )
    .await;
    assert!(
        !visible(&app, &w, Some(w.carol)).await.contains(&odd),
        "home channel unreadable => hidden"
    );
    let leaked = items_seen_with(
        &su,
        EVIDENCE_OK,
        &[(
            "AND public.mem_member_can_read(i.channel_id, p_viewer)",
            "AND true",
        )],
        w.ws,
        w.carol,
    )
    .await;
    eprintln!(
        "RED home-channel clause removed: carol sees the #hr-stored item = {}",
        leaked.contains(&odd)
    );
    assert!(leaked.contains(&odd));
    su_exec(&su, &format!("DELETE FROM mem_item WHERE id = '{odd}'")).await;
    let cases = vec![
        Case {
            label: "viewer must read every evidence channel (intersection)",
            edits: vec![(
                "public.mem_member_can_read(ev.channel_id, p_viewer)",
                "true",
            )],
            mutate: "SELECT 1".into(),
            undo: "SELECT 1".into(),
            viewer: w.carol,
            leaks: it.multi,
        },
        Case {
            label: "deleted evidence (state)",
            edits: vec![("AND m.state <> 'deleted'", "")],
            mutate: format!(
                "UPDATE message SET state = 'deleted' WHERE id = '{}'",
                it.hr_msg.0
            ),
            undo: format!(
                "UPDATE message SET state = 'sent' WHERE id = '{}'",
                it.hr_msg.0
            ),
            viewer: w.alice,
            leaks: it.hr_item,
        },
        Case {
            label: "deleted evidence (deleted_at)",
            edits: vec![("AND m.deleted_at IS NULL", "")],
            mutate: format!(
                "UPDATE message SET deleted_at = now() WHERE id = '{}'",
                it.hr_msg.0
            ),
            undo: format!(
                "UPDATE message SET deleted_at = NULL WHERE id = '{}'",
                it.hr_msg.0
            ),
            viewer: w.alice,
            leaks: it.hr_item,
        },
        Case {
            label: "edited evidence",
            edits: vec![(
                "AND (m.edited_at IS NULL OR m.edited_at <= ev.created_at)",
                "",
            )],
            mutate: format!(
                "UPDATE message SET edited_at = now() + interval '1 minute' WHERE id = '{}'",
                it.gen_msg.0
            ),
            undo: format!(
                "UPDATE message SET edited_at = NULL WHERE id = '{}'",
                it.gen_msg.0
            ),
            viewer: w.carol,
            leaks: it.gen_item,
        },
        Case {
            label: "evidence completeness (source_count)",
            edits: vec![(">= i.source_count", ">= 0")],
            mutate: format!("DELETE FROM mem_evidence WHERE item_id = '{}'", it.hr_item),
            undo: "SELECT 1".into(),
            viewer: w.alice,
            leaks: it.hr_item,
        },
        Case {
            label: "personal space owner",
            edits: vec![("AND i.owner_member_id = p_viewer", "")],
            mutate: "SELECT 1".into(),
            undo: "SELECT 1".into(),
            viewer: w.agent,
            leaks: it.dm_item,
        },
        Case {
            label: "stale flag",
            edits: vec![("SELECT NOT i.stale", "SELECT true")],
            mutate: format!(
                "UPDATE mem_item SET stale = true WHERE id = '{}'",
                it.gen_item
            ),
            undo: format!(
                "UPDATE mem_item SET stale = false WHERE id = '{}'",
                it.gen_item
            ),
            viewer: w.carol,
            leaks: it.gen_item,
        },
    ];
    for c in cases {
        // mutate the world for real, prove the shipped policy hides the item ...
        su_exec(&su, &c.mutate).await;
        let hidden = visible(&app, &w, Some(c.viewer)).await;
        assert!(
            !hidden.contains(&c.leaks),
            "{}: hidden by the shipped policy",
            c.label
        );
        // ... and that the sabotaged function shows it (guard is load-bearing).
        let leaked = items_seen_with(&su, EVIDENCE_OK, &c.edits, w.ws, c.viewer).await;
        eprintln!(
            "RED {}: clause removed -> viewer sees {} item(s), leak={}",
            c.label,
            leaked.len(),
            leaked.contains(&c.leaks)
        );
        assert!(
            leaked.contains(&c.leaks),
            "{}: without the clause the item leaks",
            c.label
        );
        su_exec(&su, &c.undo).await;
        if c.label.starts_with("evidence completeness") {
            // restore the evidence row we deleted
            su_exec(&su, &format!("INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ('{}', '{}', '{}', '{}')", w.ws, it.hr_item, it.hr_msg.0, w.hr)).await;
        }
    }
    // everything restored: alice sees all four again.
    assert_eq!(visible(&app, &w, Some(w.alice)).await.len(), 4);

    // a hard-deleted evidence message cascades its evidence row: the item is hidden, not orphaned.
    su_exec(
        &su,
        &format!("DELETE FROM message WHERE id = '{}'", it.gen_msg.0),
    )
    .await;
    assert!(!visible(&app, &w, Some(w.carol))
        .await
        .contains(&it.gen_item));
    assert!(
        !visible(&app, &w, Some(w.alice)).await.contains(&it.multi),
        "multi lost an evidence row too"
    );

    // the read policy recursion guard is load-bearing (twin of the digest one)
    let policy: String = sqlx::query_scalar(
        "SELECT qual FROM pg_policies WHERE tablename = 'mem_item' AND policyname = 'mem_item_sel'",
    )
    .fetch_one(&su)
    .await
    .expect("policy");
    assert!(policy.contains("mem_definer"), "guard present: {policy}");
    let mut tx = su.begin().await.expect("begin");
    sqlx::query("DROP POLICY mem_item_sel ON mem_item")
        .execute(&mut *tx)
        .await
        .expect("drop");
    sqlx::query("DROP POLICY mem_item_sel_definer ON mem_item")
        .execute(&mut *tx)
        .await
        .expect("drop");
    sqlx::query(
        "CREATE POLICY mem_item_sel ON mem_item FOR SELECT USING ( \
           workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid \
           AND mem_item_evidence_ok(id))",
    )
    .execute(&mut *tx)
    .await
    .expect("sabotaged policy");
    set_gucs(&mut tx, Some(w.ws), Some(w.alice)).await;
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .expect("role");
    let err =
        sqlx::query_scalar::<_, bool>("SELECT mem_item_evidence_ok(id) FROM mem_item LIMIT 1")
            .fetch_all(&mut *tx)
            .await
            .expect_err("without the guard and the definer arm the definer read must recurse");
    eprintln!("RED recursion guard removed: [{}] {err}", sqlstate(&err));
    assert!(
        ["42P17", "54001"].contains(&sqlstate(&err).as_str()),
        "{err}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// direct writes and the append-only log
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn the_api_role_cannot_write_and_the_event_log_is_append_only() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;

    // momo_app: no privilege to write ...
    for sql in [
        format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'channel', '{}', 'fact', 'forged', now(), 'x', 'x', 1)", w.ws, w.general),
        format!("UPDATE mem_item SET body = 'tampered' WHERE id = '{}'", it.gen_item),
        format!("DELETE FROM mem_item WHERE id = '{}'", it.gen_item),
        format!("INSERT INTO mem_event (workspace_id, target_kind, target_id, action) VALUES ('{}', 'item', '{}', 'forgotten')", w.ws, it.gen_item),
        format!("UPDATE mem_event SET action = 'retired' WHERE workspace_id = '{}'", w.ws),
        format!("DELETE FROM mem_event WHERE workspace_id = '{}'", w.ws),
        "TRUNCATE mem_item".to_string(),
    ] {
        assert_eq!(exec(&app, w.ws, Some(w.alice), &sql).await, Err("42501".into()), "{sql}");
    }
    // ... and even when a bootstrap re-grants every DML privilege, the RLS write policies
    // (TO mem_definer only) still deny: nothing changes.
    let mut tx = su.begin().await.expect("begin");
    sqlx::query("GRANT SELECT, INSERT, UPDATE, DELETE ON mem_item, mem_event TO momo_app")
        .execute(&mut *tx)
        .await
        .expect("regrant");
    set_gucs(&mut tx, Some(w.ws), Some(w.alice)).await;
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .expect("role");
    sqlx::query("SAVEPOINT s1")
        .execute(&mut *tx)
        .await
        .expect("savepoint");
    let forged = sqlx::query(&format!(
        "INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'channel', '{}', 'fact', 'forged', now(), 'x', 'x', 1)",
        w.ws, w.general
    ))
    .execute(&mut *tx)
    .await;
    assert_eq!(
        forged.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
        Err("42501".to_string()),
        "insert denied by RLS"
    );
    sqlx::query("ROLLBACK TO SAVEPOINT s1")
        .execute(&mut *tx)
        .await
        .expect("rollback to");
    let upd = sqlx::query(&format!(
        "UPDATE mem_item SET body = 'tampered' WHERE id = '{}'",
        it.gen_item
    ))
    .execute(&mut *tx)
    .await
    .expect("update runs");
    assert_eq!(upd.rows_affected(), 0, "update sees no writable row");
    let del = sqlx::query("DELETE FROM mem_event")
        .execute(&mut *tx)
        .await
        .expect("delete runs");
    assert_eq!(del.rows_affected(), 0);
    tx.rollback().await.expect("rollback");

    // The event log is append-only even for mem_definer: a permissive UPDATE policy added later
    // is ANDed with the RESTRICTIVE deny. Drop the RESTRICTIVE policies and it goes through (RED).
    let attempt = |drop_restrictive: bool| {
        let su = su.clone();
        let ws = w.ws;
        async move {
            let mut tx = su.begin().await.expect("begin");
            sqlx::query("GRANT UPDATE, DELETE ON mem_event TO mem_definer")
                .execute(&mut *tx)
                .await
                .expect("grant");
            sqlx::query("CREATE POLICY mem_event_upd_evil ON mem_event FOR UPDATE TO mem_definer USING (true) WITH CHECK (true)").execute(&mut *tx).await.expect("evil upd");
            sqlx::query("CREATE POLICY mem_event_del_evil ON mem_event FOR DELETE TO mem_definer USING (true)").execute(&mut *tx).await.expect("evil del");
            sqlx::query("CREATE POLICY mem_event_sel_evil ON mem_event FOR SELECT TO mem_definer USING (true)").execute(&mut *tx).await.ok();
            if drop_restrictive {
                sqlx::query("DROP POLICY mem_event_no_update ON mem_event")
                    .execute(&mut *tx)
                    .await
                    .expect("drop");
                sqlx::query("DROP POLICY mem_event_no_delete ON mem_event")
                    .execute(&mut *tx)
                    .await
                    .expect("drop");
            }
            set_gucs(&mut tx, Some(ws), None).await;
            sqlx::query("SET LOCAL ROLE mem_definer")
                .execute(&mut *tx)
                .await
                .expect("role");
            let u =
                sqlx::query("UPDATE mem_event SET detail = '{}'::jsonb WHERE workspace_id = $1")
                    .bind(ws)
                    .execute(&mut *tx)
                    .await;
            let d = sqlx::query("DELETE FROM mem_event WHERE workspace_id = $1")
                .bind(ws)
                .execute(&mut *tx)
                .await;
            let out = (
                u.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
                d.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e)),
            );
            tx.rollback().await.expect("rollback");
            out
        }
    };
    let control = attempt(false).await;
    assert_eq!(
        control,
        (Ok(0), Ok(0)),
        "RESTRICTIVE deny holds against later permissive policies"
    );
    let red = attempt(true).await;
    eprintln!("RED RESTRICTIVE deny dropped: {red:?}");
    assert!(
        matches!(red.0, Ok(n) if n > 0) && matches!(red.1, Ok(n) if n > 0),
        "{red:?}"
    );
    // the events are still there
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM mem_event WHERE workspace_id = $1")
        .bind(w.ws)
        .fetch_one(&su)
        .await
        .expect("count");
    assert!(n >= 3);

    // Events are readable only together with their item.
    assert_eq!(
        ids_of(&app, w.ws, Some(w.carol), "SELECT target_id FROM mem_event").await,
        vec![it.gen_item]
    );
    let alice_targets = ids_of(&app, w.ws, Some(w.alice), "SELECT target_id FROM mem_event").await;
    assert_eq!(
        alice_targets,
        sorted(vec![it.gen_item, it.hr_item, it.dm_item])
    );
    assert!(ids_of(&app, w.ws, None, "SELECT target_id FROM mem_event")
        .await
        .is_empty());

    // table constraints that back the rules
    for (label, sql) in [
        ("personal item without an owner", format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'personal', '{}', 'fact', 'x', now(), 'c1', 'x', 1)", w.ws, w.dm_aa)),
        ("channel item with an owner", format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, owner_member_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'channel', '{}', '{}', 'fact', 'x', now(), 'c2', 'x', 1)", w.ws, w.general, w.alice)),
        ("retired without a reason", format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count, retired_at) VALUES ('{}', 'channel', '{}', 'fact', 'x', now(), 'c3', 'x', 1, now())", w.ws, w.general)),
        ("unknown kind", format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'channel', '{}', 'gossip', 'x', now(), 'c4', 'x', 1)", w.ws, w.general)),
        ("item in a channel of another workspace", format!("INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) VALUES ('{}', 'channel', '{}', 'fact', 'x', now(), 'c5', 'x', 1)", w.ws, w.chan_b)),
    ] {
        let code = sqlx::query(&sql).execute(&su).await.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e));
        assert!(matches!(code.as_ref().map_err(|e| e.as_str()), Err("23514") | Err("23503")), "{label}: {code:?}");
    }
}

/// `mem_search_items` as `viewer` with `function` sabotaged.
async fn search_with(
    su: &PgPool,
    function: &str,
    edits: &[(&str, &str)],
    ws: Uuid,
    viewer: Uuid,
    query: &str,
) -> Vec<Uuid> {
    let mut tx = sabotage_tx(su, function, edits).await;
    become_role(&mut tx, "momo_app", ws, Some(viewer)).await;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM mem_search_items($1, 20)")
        .bind(query)
        .fetch_all(&mut *tx)
        .await
        .expect("search");
    tx.rollback().await.expect("rollback");
    ids
}

/// `mem_search_items_for` (the worker-only core) as the worker, with the function sabotaged.
async fn search_with_core(
    su: &PgPool,
    function: &str,
    edits: &[(&str, &str)],
    ws: Uuid,
    viewer: Uuid,
    query: &str,
    answer: Uuid,
) -> Vec<Uuid> {
    let mut tx = sabotage_tx(su, function, edits).await;
    become_role(&mut tx, "momo_memory", ws, None).await;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM mem_search_items_for($1, $2, 20, $3)")
        .bind(viewer)
        .bind(query)
        .bind(answer)
        .fetch_all(&mut *tx)
        .await
        .expect("search core");
    tx.rollback().await.expect("rollback");
    ids
}

/// `mem_item_audience_ok` as the worker with the function sabotaged.
async fn audience_with(
    su: &PgPool,
    edits: &[(&str, &str)],
    ws: Uuid,
    item: Uuid,
    answer: Uuid,
    who: Uuid,
) -> bool {
    let mut tx = sabotage_tx(su, "public.mem_item_audience_ok(uuid, uuid, uuid)", edits).await;
    become_role(&mut tx, "momo_memory", ws, None).await;
    let ok: bool = sqlx::query_scalar("SELECT mem_item_audience_ok($1, $2, $3)")
        .bind(item)
        .bind(answer)
        .bind(who)
        .fetch_one(&mut *tx)
        .await
        .expect("audience");
    tx.rollback().await.expect("rollback");
    ok
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async fn search(
    app: &PgPool,
    w: &W,
    viewer: Option<Uuid>,
    q: &str,
    answer: Option<Uuid>,
) -> Vec<Uuid> {
    if let Some(answer) = answer {
        // Serving: the worker-only entry point, requester as an argument, answer channel required.
        let Some(viewer) = viewer else {
            return Vec::new();
        };
        let wk = worker_pool(true).await;
        let mut tx = viewer_tx(&wk, w.ws, None).await;
        let ids: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM mem_search_items_for($1, $2, 20, $3)")
                .bind(viewer)
                .bind(q)
                .bind(answer)
                .fetch_all(&mut *tx)
                .await
                .expect("serve search");
        tx.rollback().await.expect("rollback");
        return ids;
    }
    let mut tx = viewer_tx(app, w.ws, viewer).await;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM mem_search_items($1, 20)")
        .bind(q)
        .fetch_all(&mut *tx)
        .await
        .expect("search");
    tx.rollback().await.expect("rollback");
    ids
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn search_respects_rls_and_narrows_the_audience() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;
    let word = "기억테스트";

    // RLS is the filter: search results == the readable rows that match (parity per viewer).
    su_exec(
        &su,
        &format!(
            "UPDATE mem_item SET retired_at = now(), retired_reason = 'wrong' WHERE id = '{}'",
            it.multi
        ),
    )
    .await;
    for viewer in [
        Some(w.alice),
        Some(w.bob),
        Some(w.carol),
        Some(w.agent),
        None,
    ] {
        let readable = ids_of(
            &app,
            w.ws,
            viewer,
            "SELECT id FROM mem_item WHERE retired_at IS NULL",
        )
        .await;
        let mut found = search(&app, &w, viewer, word, None).await;
        found.sort();
        assert_eq!(
            found, readable,
            "viewer {viewer:?}: search == RLS-readable non-retired rows"
        );
    }
    // The hidden canary is not findable by its own unique word, for the viewer who may not read it.
    assert!(
        search(&app, &w, Some(w.carol), "연봉", None)
            .await
            .is_empty(),
        "carol must not find #hr"
    );
    assert_eq!(
        search(&app, &w, Some(w.alice), "연봉", None).await,
        vec![it.hr_item]
    );
    assert!(search(&app, &w, Some(w.carol), "CANARY", None)
        .await
        .is_empty());
    // Another tenant finds nothing; so does a request with no viewer.
    assert!(ids_of(
        &app,
        w.ws_b,
        Some(w.bob_b),
        &format!("SELECT id FROM mem_search_items('{word}', 10)")
    )
    .await
    .is_empty());
    assert!(search(&app, &w, None, word, None).await.is_empty());
    // A left member stops finding it at once.
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = now() WHERE channel_id = '{}' AND member_id = '{}'",
            w.hr, w.bob
        ),
    )
    .await;
    assert!(search(&app, &w, Some(w.bob), "연봉", None).await.is_empty());
    su_exec(
        &su,
        &format!(
            "UPDATE membership SET left_at = NULL WHERE channel_id = '{}' AND member_id = '{}'",
            w.hr, w.bob
        ),
    )
    .await;
    // The plain worker session (BYPASSRLS) gets nothing out of it: no table privilege.
    let plain = worker_pool(false).await;
    assert_eq!(
        exec(
            &plain,
            w.ws,
            Some(w.alice),
            &format!("SELECT * FROM mem_search_items('{word}', 10)")
        )
        .await,
        Err("42501".into())
    );

    // Audience narrowing (D6-4): an agent answer posted in channel X only carries items whose
    // home and evidence channels are X — or, in the requester's own agent DM, the requester's.
    let in_general = search(&app, &w, Some(w.alice), word, Some(w.general)).await;
    assert_eq!(
        in_general,
        vec![it.gen_item],
        "alice calling the agent in #general: no #hr, no DM item"
    );
    let in_hr = search(&app, &w, Some(w.alice), word, Some(w.hr)).await;
    assert_eq!(in_hr, vec![it.hr_item], "in #hr: only #hr's own item");
    let mut in_dm = search(&app, &w, Some(w.alice), word, Some(w.dm_aa)).await;
    in_dm.sort();
    assert_eq!(
        in_dm,
        sorted(vec![it.gen_item, it.hr_item, it.dm_item]),
        "alice's own agent DM: union of what she may read"
    );
    assert!(
        search(&app, &w, Some(w.bob), word, Some(w.dm_aa))
            .await
            .is_empty(),
        "bob cannot borrow alice's DM as an audience"
    );
    assert!(
        search(&app, &w, Some(w.carol), word, Some(w.hr))
            .await
            .is_empty(),
        "carol cannot name #hr as the answer channel"
    );
    assert!(search(&app, &w, Some(w.carol), word, Some(w.dm_bc))
        .await
        .iter()
        .all(|i| *i != it.hr_item));

    // RED: the audience predicate and the read check are load-bearing in the search core ...
    let core = "public.mem_search_items_core(uuid, text, integer, uuid, boolean)";
    let leaked = search_with_core(
        &su,
        core,
        &[(
            "AND NOT public.mem_item_audience_ok(r.item_id, p_answer_channel_id, p_viewer) THEN",
            "AND false THEN",
        )],
        w.ws,
        w.alice,
        word,
        w.general,
    )
    .await;
    eprintln!(
        "RED audience filter removed from search: #hr item in a #general answer = {}",
        leaked.contains(&it.hr_item)
    );
    assert!(leaked.contains(&it.hr_item) && leaked.contains(&it.dm_item));
    // M-1: the membership narrowing is a second, independent wall in front of the read check: with the
    // read check gone, carol (not in #hr) still finds nothing ...
    let narrowing = "AND (i.channel_id IN (SELECT ms.channel_id FROM public.membership ms\n                              WHERE ms.workspace_id = v_ws AND ms.member_id = p_viewer\n                                AND ms.left_at IS NULL)\n            OR (i.space_kind = 'personal' AND i.owner_member_id = p_viewer))";
    let read_check = (
        "IF NOT public.mem_item_readable_by(r.item_id, p_viewer) THEN",
        "IF false THEN",
    );
    let only_read_gone = search_with(&su, core, &[read_check], w.ws, w.carol, "연봉").await;
    eprintln!(
        "M-1 narrowing alone (read check removed): carol finds {} #hr item(s)",
        only_read_gone.len()
    );
    assert!(
        only_read_gone.is_empty(),
        "the channel narrowing keeps #hr out of carol's scan"
    );
    // ... and only when BOTH are gone does the #hr item leak (RED for each wall).
    let leaked = search_with(
        &su,
        core,
        &[read_check, (narrowing, "")],
        w.ws,
        w.carol,
        "연봉",
    )
    .await;
    eprintln!(
        "RED read check AND channel narrowing removed: carol finds {} #hr item(s)",
        leaked.len()
    );
    assert_eq!(leaked, vec![it.hr_item]);
    let only_narrow_gone = search_with(&su, core, &[(narrowing, "")], w.ws, w.carol, "연봉").await;
    assert!(
        only_narrow_gone.is_empty(),
        "the read check keeps #hr out when only the narrowing is gone"
    );
    // ... and the DM union lives in the audience rule: without it alice's agent DM gets only its own item.
    let none = search_with_core(
        &su,
        "public.mem_item_audience_ok(uuid, uuid, uuid)",
        &[(
            "(v_dm AND public.mem_member_can_read(v_home, p_requester_member_id))",
            "false",
        )],
        w.ws,
        w.alice,
        word,
        w.dm_aa,
    )
    .await;
    eprintln!(
        "RED agent-DM union removed: {} result(s) in alice's agent DM",
        none.len()
    );
    assert_eq!(none, vec![it.dm_item]);
    // The session_user guard: a BYPASSRLS login (momo_worker) cannot read item text through the
    // PUBLIC-executable API function by setting the viewer GUC itself.
    let api_search = "SELECT count(*) FROM mem_search_items('기억테스트', 10)";
    let attempt = |strip_guard: bool| {
        let su = su.clone();
        let (ws, alice) = (w.ws, w.alice);
        async move {
            let mut tx = if strip_guard {
                sabotage_tx(
                    &su,
                    "public.mem_search_items(text, integer)",
                    &[(
                        "IF session_user::text <> 'momo_app'",
                        "IF false AND session_user::text <> 'momo_app'",
                    )],
                )
                .await
            } else {
                su.begin().await.expect("begin")
            };
            set_gucs(&mut tx, Some(ws), Some(alice)).await;
            sqlx::query("SET LOCAL SESSION AUTHORIZATION momo_worker")
                .execute(&mut *tx)
                .await
                .expect("session authorization");
            let out = sqlx::query_scalar::<_, i64>(api_search)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| sqlstate(&e));
            tx.rollback().await.ok();
            out
        }
    };
    assert_eq!(
        attempt(false).await,
        Err("42501".to_string()),
        "guard refuses momo_worker"
    );
    let red = attempt(true).await;
    eprintln!("RED session_user guard removed: momo_worker's search returns {red:?}");
    assert!(matches!(red, Ok(n) if n >= 3));

    // Korean matching: josa, two-syllable words, spacing.
    let kr = say(
        &su,
        w.ws,
        w.general,
        w.alice,
        "결제 승인은 금요일까지 받기로 했다",
    )
    .await;
    let d = apply_digest(&wk, w.ws, w.general, &[kr]).await;
    let kr_item = add_item(
        &wk,
        w.ws,
        d,
        "commitment",
        "결제 승인은 금요일까지 받기로 했다",
        &[kr.0],
    )
    .await
    .expect("kr")
    .expect("id");
    for q in ["승인", "승인을", "결제 승인이", "금요일에", "승인을 일정이"] {
        assert!(
            search(&app, &w, Some(w.carol), q, None)
                .await
                .contains(&kr_item),
            "query {q:?}"
        );
    }
    assert!(!search(&app, &w, Some(w.carol), "연봉조정", None)
        .await
        .contains(&kr_item));
    let cfg: Vec<String> = sqlx::query_scalar(
        "SELECT unnest(proconfig) FROM pg_proc WHERE proname = 'mem_search_items_core'",
    )
    .fetch_all(&su)
    .await
    .expect("proconfig");
    assert!(
        cfg.iter().any(|c| c.contains("word_similarity_threshold")),
        "{cfg:?}"
    );
    // Both search functions are definers owned by mem_definer (allow-listed); the API one refuses any
    // session that is not momo_app / a superuser (the guard is sabotaged above), the core is
    // worker-only (the closure test).
    let owners: Vec<(String, bool, String)> = sqlx::query_as(
        "SELECT proname::text, prosecdef, pg_get_userbyid(proowner)::text FROM pg_proc \
          WHERE proname IN ('mem_search_items', 'mem_search_items_core', 'mem_search_items_for') ORDER BY 1",
    )
    .fetch_all(&su)
    .await
    .expect("owners");
    assert_eq!(
        owners,
        vec![
            (
                "mem_search_items".to_string(),
                true,
                "mem_definer".to_string()
            ),
            (
                "mem_search_items_core".to_string(),
                true,
                "mem_definer".to_string()
            ),
            (
                "mem_search_items_for".to_string(),
                true,
                "mem_definer".to_string()
            ),
        ]
    );
}

// ---------------------------------------------------------------------------
// audience rule + worker-only closure
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn the_item_audience_rule_pins_adr_d6_4() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;
    let aud = |item: Uuid, answer: Uuid, who: Uuid| {
        let wk = wk.clone();
        let ws = w.ws;
        async move {
            bool_of(
                &wk,
                ws,
                None,
                &format!("SELECT mem_item_audience_ok('{item}', '{answer}', '{who}')"),
            )
            .await
        }
    };
    // same channel: yes; another channel: no.
    assert!(aud(it.gen_item, w.general, w.alice).await);
    assert!(aud(it.gen_item, w.general, w.carol).await);
    assert!(
        !aud(it.gen_item, w.hr, w.alice).await,
        "a #general item is not carried into #hr"
    );
    assert!(
        !aud(it.hr_item, w.general, w.alice).await,
        "#hr never reaches #general"
    );
    // the requester must be able to read the answer channel.
    assert!(!aud(it.hr_item, w.hr, w.carol).await);
    assert!(!aud(it.gen_item, w.hr, w.carol).await);
    // requester ↔ agent DM: the requester's own union, only there.
    assert!(aud(it.hr_item, w.dm_aa, w.alice).await);
    assert!(aud(it.gen_item, w.dm_aa, w.alice).await);
    assert!(
        aud(it.multi, w.dm_aa, w.alice).await,
        "multi-channel item in the DM: alice can read both"
    );
    assert!(
        !aud(it.multi, w.general, w.alice).await,
        "multi-channel item never goes to a group channel"
    );
    assert!(
        !aud(it.hr_item, w.dm_aa, w.bob).await,
        "bob is not in alice's DM"
    );
    assert!(
        !aud(it.hr_item, w.dm_bc, w.bob).await,
        "a human-to-human DM is not an agent DM"
    );
    // personal: owner only, only in the DM.
    assert!(aud(it.dm_item, w.dm_aa, w.alice).await);
    assert!(!aud(it.dm_item, w.general, w.alice).await);
    assert!(
        !aud(it.dm_item, w.dm_aa, w.agent).await,
        "the agent is not the owner"
    );
    // no requester / unknown item / other tenant.
    assert!(
        !bool_of(
            &wk,
            w.ws,
            None,
            &format!(
                "SELECT mem_item_audience_ok('{}', '{}', NULL)",
                it.gen_item, w.general
            )
        )
        .await
    );
    assert!(
        !bool_of(
            &wk,
            w.ws,
            None,
            &format!(
                "SELECT mem_item_audience_ok('{}', '{}', '{}')",
                Uuid::new_v4(),
                w.general,
                w.alice
            )
        )
        .await
    );
    assert!(
        !bool_of(
            &wk,
            w.ws_b,
            None,
            &format!(
                "SELECT mem_item_audience_ok('{}', '{}', '{}')",
                it.gen_item, w.general, w.alice
            )
        )
        .await
    );
    // switches: an excluded home channel is not served; retired / stale / dead evidence neither.
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.hr)).await;
    assert!(!aud(it.hr_item, w.hr, w.alice).await, "excluded channel");
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE channel_id = '{}'", w.hr),
    )
    .await;
    assert!(aud(it.hr_item, w.hr, w.alice).await);
    su_exec(
        &su,
        &format!(
            "UPDATE mem_item SET retired_at = now(), retired_reason = 'wrong' WHERE id = '{}'",
            it.gen_item
        ),
    )
    .await;
    assert!(!aud(it.gen_item, w.general, w.alice).await, "retired");
    su_exec(&su, &format!("UPDATE mem_item SET retired_at = NULL, retired_reason = NULL, stale = true WHERE id = '{}'", it.gen_item)).await;
    assert!(!aud(it.gen_item, w.general, w.alice).await, "stale");
    su_exec(
        &su,
        &format!(
            "UPDATE mem_item SET stale = false WHERE id = '{}'",
            it.gen_item
        ),
    )
    .await;
    su_exec(
        &su,
        &format!(
            "UPDATE message SET state = 'deleted', deleted_at = now() WHERE id = '{}'",
            it.hr_msg.0
        ),
    )
    .await;
    assert!(!aud(it.hr_item, w.hr, w.alice).await, "deleted evidence");
    su_exec(
        &su,
        &format!(
            "UPDATE message SET state = 'sent', deleted_at = NULL WHERE id = '{}'",
            it.hr_msg.0
        ),
    )
    .await;

    // an item stored in #hr whose only evidence is a #general message (forged: mem_add_item cannot
    // produce it) must not be carried into #general by an #hr member — only the home clause stops it.
    let odd = Uuid::new_v4();
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_item (id, workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) \
             VALUES ('{odd}', '{}', 'channel', '{}', 'fact', '홈 채널 시험 항목', now(), 'h-odd3', 'forged', 1)",
            w.ws, w.hr
        ),
    )
    .await;
    su_exec(
        &su,
        &format!(
            "INSERT INTO mem_evidence (workspace_id, item_id, message_id, channel_id) VALUES ('{}', '{odd}', '{}', '{}')",
            w.ws, it.gen_msg.0, w.general
        ),
    )
    .await;
    assert!(
        !aud(odd, w.general, w.alice).await,
        "stored in #hr, so not for a #general answer"
    );
    let leaked = audience_with(
        &su,
        &[(
            "IF NOT (v_home = p_answer_channel_id",
            "IF NOT (true OR v_home = p_answer_channel_id",
        )],
        w.ws,
        odd,
        w.general,
        w.alice,
    )
    .await;
    eprintln!("RED home-channel clause removed: #hr-stored item served into #general = {leaked}");
    assert!(leaked);
    su_exec(&su, &format!("DELETE FROM mem_item WHERE id = '{odd}'")).await;

    // RED for each clause.
    let leaked = audience_with(&su, &[("     WHERE ev.item_id = p_item_id AND ev.workspace_id = v_ws\n       AND NOT (ev.channel_id = p_answer_channel_id\n                OR (v_dm AND public.mem_member_can_read(ev.channel_id, p_requester_member_id)))", "     WHERE false")], w.ws, it.multi, w.general, w.alice).await;
    eprintln!(
        "RED evidence-channel clause removed: multi-channel item served into #general = {leaked}"
    );
    assert!(leaked);
    let leaked = audience_with(
        &su,
        &[(
            "IF v_space = 'personal' AND v_owner IS DISTINCT FROM p_requester_member_id THEN",
            "IF false THEN",
        )],
        w.ws,
        it.dm_item,
        w.dm_aa,
        w.agent,
    )
    .await;
    eprintln!("RED owner clause removed: personal item served to a non-owner = {leaked}");
    assert!(leaked);
    // switch on the item's HOME channel: #hr excluded, item served into alice's agent DM (union).
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.hr)).await;
    assert!(
        !aud(it.hr_item, w.dm_aa, w.alice).await,
        "home channel excluded"
    );
    let leaked = audience_with(
        &su,
        &[(
            "IF NOT public.mem_channel_switch(v_home) THEN",
            "IF false THEN",
        )],
        w.ws,
        it.hr_item,
        w.dm_aa,
        w.alice,
    )
    .await;
    eprintln!("RED home switch clause removed: excluded home channel still served = {leaked}");
    assert!(leaked);
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE channel_id = '{}'", w.hr),
    )
    .await;
    // M-3: switches on the ANSWER channel and the requester's personal pause (same as mem_serve_candidates).
    // The answer channel is alice's agent DM; the item's home (#hr) stays switched on.
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded) VALUES ('{}', 'channel', '{}', true)", w.ws, w.dm_aa)).await;
    assert!(
        !aud(it.hr_item, w.dm_aa, w.alice).await,
        "answer channel excluded"
    );
    assert!(
        aud(it.hr_item, w.hr, w.alice).await,
        "... but the item is still servable where its own channel is the answer"
    );
    let leaked = audience_with(
        &su,
        &[(
            "IF NOT public.mem_channel_switch(p_answer_channel_id) THEN",
            "IF false THEN",
        )],
        w.ws,
        it.hr_item,
        w.dm_aa,
        w.alice,
    )
    .await;
    eprintln!("RED answer-channel switch removed: excluded answer channel still served = {leaked}");
    assert!(leaked);
    su_exec(
        &su,
        &format!(
            "DELETE FROM mem_settings WHERE channel_id = '{}'",
            w.general
        ),
    )
    .await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, paused) VALUES ('{}', 'workspace', true)", w.ws)).await;
    assert!(
        !aud(it.gen_item, w.general, w.alice).await,
        "workspace paused"
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE workspace_id = '{}'", w.ws),
    )
    .await;
    su_exec(&su, &format!("INSERT INTO mem_settings (workspace_id, scope, member_id, paused) VALUES ('{}', 'member', '{}', true)", w.ws, w.alice)).await;
    assert!(
        !aud(it.gen_item, w.general, w.alice).await,
        "the requester paused their own memory"
    );
    assert!(
        aud(it.gen_item, w.general, w.carol).await,
        "... and only theirs"
    );
    let leaked = audience_with(
        &su,
        &[(
            "AND s.member_id = p_requester_member_id AND s.paused) THEN",
            "AND s.member_id = p_requester_member_id AND s.paused AND false) THEN",
        )],
        w.ws,
        it.gen_item,
        w.general,
        w.alice,
    )
    .await;
    eprintln!("RED personal pause removed: a paused requester is still served = {leaked}");
    assert!(leaked);
    // ... and the serving search obeys it (the audience filter is inside the SQL).
    assert!(
        search(&app, &w, Some(w.alice), "기억테스트", Some(w.general))
            .await
            .is_empty()
    );
    su_exec(
        &su,
        &format!("DELETE FROM mem_settings WHERE member_id = '{}'", w.alice),
    )
    .await;
    assert!(aud(it.gen_item, w.general, w.alice).await);
    let leaked = audience_with(
        &su,
        &[("mm.kind = 'agent' AND mm.status = 'active'", "true")],
        w.ws,
        it.hr_item,
        w.dm_bc,
        w.bob,
    )
    .await;
    eprintln!("RED agent-DM requirement removed: #hr item into a human-to-human DM = {leaked}");
    assert!(leaked);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn worker_only_item_functions_are_closed_to_the_api() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;
    let d: Uuid = sqlx::query_scalar("SELECT id FROM mem_digest WHERE channel_id = $1")
        .bind(w.general)
        .fetch_one(&su)
        .await
        .expect("digest");
    let calls = [
        (
            "mem_add_item",
            add_sql(d, "fact", &[it.gen_msg.0], false).replace("$1", "'x 사실'"),
        ),
        (
            "mem_item_live",
            format!("SELECT mem_item_live('{}')", it.hr_item),
        ),
        (
            "mem_item_readable_by",
            format!(
                "SELECT mem_item_readable_by('{}', '{}')",
                it.hr_item, w.alice
            ),
        ),
        (
            "mem_search_items_for",
            format!(
                "SELECT count(*) FROM mem_search_items_for('{}', '기억테스트', 10, '{}')",
                w.alice, w.general
            ),
        ),
        (
            "mem_item_audience_ok",
            format!(
                "SELECT mem_item_audience_ok('{}', '{}', '{}')",
                it.hr_item, w.hr, w.alice
            ),
        ),
    ];
    let plain = worker_pool(false).await;
    for (name, sql) in &calls {
        assert_eq!(
            exec(&app, w.ws, Some(w.alice), sql).await,
            Err("42501".into()),
            "momo_app must not run {name}"
        );
        assert_eq!(
            exec(&plain, w.ws, None, sql).await,
            Err("42501".into()),
            "momo_worker without SET ROLE must not run {name}"
        );
    }
    for (name, sql) in &calls {
        let out = exec(&wk, w.ws, None, sql).await;
        assert!(out.is_ok(), "momo_memory must run {name}: {out:?}");
    }
    // The policy helper is the one definer function the RLS policy needs PUBLIC for; it reads the
    // viewer from the GUC only, so a caller cannot ask about somebody else.
    assert!(
        bool_of(
            &app,
            w.ws,
            Some(w.alice),
            &format!("SELECT mem_item_evidence_ok('{}')", it.hr_item)
        )
        .await
    );
    assert!(
        !bool_of(
            &app,
            w.ws,
            Some(w.carol),
            &format!("SELECT mem_item_evidence_ok('{}')", it.hr_item)
        )
        .await
    );
    // momo_memory has no table access at all.
    for table in ["mem_item", "mem_event", "mem_evidence"] {
        assert_eq!(
            exec(&wk, w.ws, None, &format!("SELECT count(*) FROM {table}")).await,
            Err("42501".into()),
            "{table}"
        );
    }
}

// ---------------------------------------------------------------------------
// review hardening (M-1, M-4, M-6, L-2, L-5, L-6)
// ---------------------------------------------------------------------------

const CORE: &str = "public.mem_search_items_core(uuid, text, integer, uuid, boolean)";
const FOR_FN: &str = "public.mem_search_items_for(uuid, text, integer, uuid)";

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn serving_never_runs_without_an_audience_and_queries_are_capped() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;
    let word = "기억테스트";

    // M-4: the serving entry point refuses a missing answer channel ...
    let no_channel = format!(
        "SELECT count(*) FROM mem_search_items_for('{}', '{word}', 10, NULL)",
        w.alice
    );
    assert_eq!(
        exec(&wk, w.ws, None, &no_channel).await,
        Err("22023".into())
    );
    // ... the core refuses the two mismatched flag/channel combinations (superuser = owner-level access) ...
    for (label, sql) in [
        (
            "serve without a channel",
            format!(
                "SELECT count(*) FROM mem_search_items_core('{}', '{word}', 10, NULL, true)",
                w.alice
            ),
        ),
        (
            "browse with a channel",
            format!(
                "SELECT count(*) FROM mem_search_items_core('{}', '{word}', 10, '{}', false)",
                w.alice, w.general
            ),
        ),
    ] {
        assert_eq!(
            exec(&su, w.ws, None, &sql).await,
            Err("22023".into()),
            "{label}"
        );
    }
    // ... and nobody but the owner can call the core: not the worker role, not the API role.
    let core_call = format!(
        "SELECT count(*) FROM mem_search_items_core('{}', '{word}', 10, '{}', true)",
        w.alice, w.general
    );
    assert_eq!(exec(&wk, w.ws, None, &core_call).await, Err("42501".into()));
    assert_eq!(
        exec(&app, w.ws, Some(w.alice), &core_call).await,
        Err("42501".into())
    );
    // RED: serving regresses to "browse" (the wrapper passes false) — the core guard still stops it ...
    let serve_as_browse = (
        "mem_search_items_core(p_viewer, p_query, p_limit, p_answer_channel_id, true)",
        "mem_search_items_core(p_viewer, p_query, p_limit, p_answer_channel_id, false)",
    );
    let serve = format!(
        "SELECT id FROM mem_search_items_for('{}', '{word}', 20, '{}')",
        w.alice, w.general
    );
    let run_serve = |also_guard: bool| {
        let (su, serve) = (su.clone(), serve.clone());
        let ws = w.ws;
        async move {
            let mut tx = sabotage_tx(&su, FOR_FN, &[serve_as_browse]).await;
            if also_guard {
                redefine(
                    &mut tx,
                    CORE,
                    &[(
                        "IF p_serve IS DISTINCT FROM (p_answer_channel_id IS NOT NULL) THEN",
                        "IF false THEN",
                    )],
                )
                .await;
            }
            become_role(&mut tx, "momo_memory", ws, None).await;
            let out = sqlx::query_scalar::<_, Uuid>(&serve)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| sqlstate(&e));
            tx.rollback().await.ok();
            out
        }
    };
    assert_eq!(
        run_serve(false).await,
        Err("22023".to_string()),
        "the core's flag check holds on its own"
    );
    let leaked = run_serve(true).await.expect("without the guard it runs");
    eprintln!("RED serving without audience narrowing: {} item(s) returned into a #general answer, #hr included = {}", leaked.len(), leaked.contains(&it.hr_item));
    assert!(leaked.contains(&it.hr_item) && leaked.contains(&it.dm_item));
    // the shipped serving path narrows: only #general's own item.
    assert_eq!(
        search(&app, &w, Some(w.alice), word, Some(w.general)).await,
        vec![it.gen_item]
    );

    // M-1: p_query is cut to 200 characters inside the function.
    let long = format!("{} 연봉", "x".repeat(200));
    assert!(
        search(&app, &w, Some(w.alice), &long, None)
            .await
            .is_empty(),
        "the tail past 200 characters is ignored"
    );
    assert_eq!(
        search(&app, &w, Some(w.alice), "연봉", None).await,
        vec![it.hr_item]
    );
    let leaked = search_with(
        &su,
        CORE,
        &[(
            "pg_catalog.left(COALESCE(p_query, ''), 200)",
            "COALESCE(p_query, '')",
        )],
        w.ws,
        w.alice,
        &long,
    )
    .await;
    eprintln!(
        "RED query cap removed: a 205-character query now reaches its tail -> {} hit(s)",
        leaked.len()
    );
    assert_eq!(leaked, vec![it.hr_item]);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn secret_shapes_prose_passwords_and_retired_items() {
    let (su, app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;

    // M-6: the SQL check agrees with the Rust check on the shared example list.
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/momo-agent/tests/fixtures/memory_secret_shapes.json");
    let shapes: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
    for parts in shapes["positives"].as_array().unwrap() {
        let text: String = parts
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        let hit: bool = sqlx::query_scalar("SELECT mem_looks_like_secret($1)")
            .bind(&text)
            .fetch_one(&su)
            .await
            .unwrap();
        assert!(hit, "SQL must flag: {text}");
    }
    for text in shapes["negatives"].as_array().unwrap() {
        let text = text.as_str().unwrap();
        let hit: bool = sqlx::query_scalar("SELECT mem_looks_like_secret($1)")
            .bind(text)
            .fetch_one(&su)
            .await
            .unwrap();
        assert!(!hit, "SQL must not flag: {text}");
    }
    // ... mem_add_item refuses prose passwords and URL credentials, in the body AND in subject_key.
    let m = say(&su, w.ws, w.general, w.alice, "비밀번호 얘기는 하지 않았다").await;
    let d = apply_digest(&wk, w.ws, w.general, &[m]).await;
    let url = format!("{}{}", "postgres://app:", "s3cretpw@db.internal/x");
    for (label, body, subject) in [
        (
            "prose password in the body",
            "비밀번호는 abc12345 입니다".to_string(),
            None,
        ),
        (
            "english prose password",
            "the password is hunter22 ok".to_string(),
            None,
        ),
        (
            "url credential in the body",
            format!("접속은 {url} 로 한다"),
            None,
        ),
        (
            "url credential in subject_key",
            "무해한 본문".to_string(),
            Some(url.clone()),
        ),
        (
            "prose password in subject_key",
            "무해한 본문".to_string(),
            Some("비밀번호는 abc12345".to_string()),
        ),
    ] {
        let mut tx = viewer_tx(&wk, w.ws, None).await;
        let r = sqlx::query_scalar::<_, Option<Uuid>>(&format!(
            "SELECT mem_add_item('{d}', 'fact', $1, $2, {}, 0.5::real, false, 'items-v1', 'm')",
            arr(&[m.0])
        ))
        .bind(&body)
        .bind(subject.as_deref())
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| sqlstate(&e));
        assert_eq!(r, Err("23514".to_string()), "{label}");
    }
    // RED: the shared check neutralised -> the same calls succeed.
    let mut tx = sabotage_tx(
        &su,
        "public.mem_looks_like_secret(text)",
        &[("SELECT COALESCE(", "SELECT false AND COALESCE(")],
    )
    .await;
    become_role(&mut tx, "momo_memory", w.ws, None).await;
    let r = sqlx::query_scalar::<_, Option<Uuid>>(&format!(
        "SELECT mem_add_item('{d}', 'fact', '비밀번호는 abc12345 입니다', NULL, {}, 0.5::real, false, 'items-v1', 'm')", arr(&[m.0])))
        .fetch_one(&mut *tx).await.map_err(|e| sqlstate(&e));
    tx.rollback().await.ok();
    eprintln!("RED secret check neutralised: prose password stored -> {r:?}");
    assert!(matches!(r, Ok(Some(_))));

    // L-2: 'wrong' / 'forgotten' are invisible to everyone; other reasons stay visible as history.
    for (reason, visible) in [
        ("wrong", false),
        ("forgotten", false),
        ("edited", true),
        ("merged", true),
    ] {
        su_exec(&su, &format!("UPDATE mem_item SET retired_at = now(), retired_reason = '{reason}' WHERE id = '{}'", it.gen_item)).await;
        let seen = ids_of(&app, w.ws, Some(w.alice), "SELECT id FROM mem_item")
            .await
            .contains(&it.gen_item);
        assert_eq!(seen, visible, "retired_reason {reason}");
    }
    su_exec(
        &su,
        &format!(
            "UPDATE mem_item SET retired_at = now(), retired_reason = 'wrong' WHERE id = '{}'",
            it.gen_item
        ),
    )
    .await;
    let leaked = items_seen_with(
        &su,
        EVIDENCE_OK,
        &[(
            "AND (i.retired_reason IS NULL OR i.retired_reason NOT IN ('forgotten', 'wrong'))",
            "",
        )],
        w.ws,
        w.alice,
    )
    .await;
    eprintln!(
        "RED retired_reason clause removed: a 'wrong' item is visible again = {}",
        leaked.contains(&it.gen_item)
    );
    assert!(leaked.contains(&it.gen_item));
    su_exec(
        &su,
        &format!(
            "UPDATE mem_item SET retired_at = NULL, retired_reason = NULL WHERE id = '{}'",
            it.gen_item
        ),
    )
    .await;

    // L-6: same hash, different body is a collision, not "already remembered".
    let m2 = say(&su, w.ws, w.general, w.bob, "충돌 시험 메시지").await;
    let d2 = apply_digest(&wk, w.ws, w.general, &[m2]).await;
    su_exec(&su, &format!(
        "INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) \
         VALUES ('{}', 'channel', '{}', 'fact', '전혀 다른 본문', now(), \
                 encode(sha256(convert_to('fact:충돌 본문', 'UTF8')), 'hex'), 'forged', 1)", w.ws, w.general)).await;
    assert_eq!(
        add_item(&wk, w.ws, d2, "fact", "충돌 본문", &[m2.0]).await,
        Err("23514".into())
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn the_definer_may_only_mark_stale_and_the_deny_policies_are_restrictive() {
    let (su, _app, wk, w) = setup().await;
    let it = seed_items(&su, &wk, &w).await;
    // L-5: mem_definer's UPDATE is limited to `stale` by a column privilege ...
    let as_definer = |sql: String| {
        let su = su.clone();
        let ws = w.ws;
        async move {
            let mut tx = su.begin().await.expect("begin");
            become_role(&mut tx, "mem_definer", ws, None).await;
            let r = sqlx::query(&sql)
                .execute(&mut *tx)
                .await
                .map(|r| r.rows_affected())
                .map_err(|e| sqlstate(&e));
            tx.rollback().await.ok();
            r
        }
    };
    assert_eq!(
        as_definer(format!(
            "UPDATE mem_item SET body = 'x' WHERE id = '{}'",
            it.gen_item
        ))
        .await,
        Err("42501".to_string())
    );
    assert_eq!(
        as_definer(format!(
            "UPDATE mem_item SET retired_reason = 'wrong', retired_at = now() WHERE id = '{}'",
            it.gen_item
        ))
        .await,
        Err("42501".to_string())
    );
    assert_eq!(
        as_definer(format!(
            "UPDATE mem_item SET stale = true WHERE id = '{}'",
            it.gen_item
        ))
        .await,
        Ok(1)
    );
    assert_eq!(
        as_definer(format!("DELETE FROM mem_item WHERE id = '{}'", it.gen_item)).await,
        Err("42501".to_string())
    );
    // ... and a permissive write policy added for the API role later cannot open the door (RESTRICTIVE deny).
    let attempt = |drop_restrictive: bool| {
        let su = su.clone();
        let (ws, alice, ch) = (w.ws, w.alice, w.general);
        async move {
            let mut tx = su.begin().await.expect("begin");
            sqlx::query("GRANT SELECT, INSERT, UPDATE, DELETE ON mem_item TO momo_app")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("CREATE POLICY evil_all ON mem_item FOR ALL TO momo_app USING (true) WITH CHECK (true)").execute(&mut *tx).await.unwrap();
            if drop_restrictive {
                for p in [
                    "mem_item_only_definer_ins",
                    "mem_item_only_definer_upd",
                    "mem_item_only_definer_del",
                ] {
                    sqlx::query(&format!("DROP POLICY {p} ON mem_item"))
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
            }
            become_role(&mut tx, "momo_app", ws, Some(alice)).await;
            sqlx::query("SAVEPOINT s").execute(&mut *tx).await.unwrap();
            let ins = sqlx::query(&format!(
                "INSERT INTO mem_item (workspace_id, space_kind, channel_id, kind, body, valid_from, content_hash, extractor_version, source_count) \
                 VALUES ('{ws}', 'channel', '{ch}', 'fact', 'forged by the API role', now(), 'hx', 'x', 1)"))
                .execute(&mut *tx).await.map(|r| r.rows_affected()).map_err(|e| sqlstate(&e));
            sqlx::query("ROLLBACK TO SAVEPOINT s")
                .execute(&mut *tx)
                .await
                .unwrap();
            let upd = sqlx::query("UPDATE mem_item SET body = 'tampered'")
                .execute(&mut *tx)
                .await
                .map(|r| r.rows_affected())
                .map_err(|e| sqlstate(&e));
            tx.rollback().await.ok();
            (ins, upd)
        }
    };
    let control = attempt(false).await;
    assert_eq!(
        control,
        (Err("42501".to_string()), Ok(0)),
        "RESTRICTIVE deny holds against a permissive policy"
    );
    let red = attempt(true).await;
    eprintln!("RED RESTRICTIVE write denies dropped (mem_item): {red:?}");
    assert!(red.0 == Ok(1) && matches!(red.1, Ok(n) if n > 0));
}
