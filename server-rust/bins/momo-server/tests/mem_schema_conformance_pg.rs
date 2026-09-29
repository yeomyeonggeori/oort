//! #3161 / ADR-0196 — team-memory M1 schema: read policy + 「channel readable」.
//!
//! Proves against real Postgres, as `momo_app` (NOBYPASSRLS, not the table owner):
//!   1. **R1 parity** — `mem_can_read_channel` answers exactly what the message
//!      read path answers (`momo_messaging::is_channel_member`) for member /
//!      left member / public-channel non-member / foreign workspace / agent, and
//!      is narrower in exactly one documented way (suspended member, as search).
//!   2. (a) cross-workspace isolation of every new table.
//!   3. (b) a same-workspace non-reader of the stored channel never sees the digest.
//!   4. (c) a reader of every evidence channel sees it.
//!   5. (d) a digest with evidence in two channels is hidden if any is unreadable,
//!      and a deleted evidence message hides it at once (D6-2).
//!   6. Receipts follow the answer channel; personal settings are owner-only;
//!      an unset `app.member_id` fails closed; all five tables are ENABLE+FORCE.
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
    sqlx::query(&format!(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, '{kind}', $3, '', $4)"
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

struct World {
    ws: Uuid,
    ws_b: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    dave_left: Uuid,
    erin_suspended: Uuid,
    agent: Uuid,
    bob_b: Uuid,
    public_p1: Uuid,
    public_p2: Uuid,
    private_s1: Uuid,
    d_p1: Uuid,
    d_s1: Uuid,
    d_multi: Uuid,
    d_del: Uuid,
    d_no_evidence: Uuid,
    d_b: Uuid,
    del_message: Uuid,
    run: Uuid,
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
    let bob_b = seed_member(su, ws_b, "human").await;

    let public_p1 = seed_channel(su, ws, "public", alice).await;
    // A public channel nobody in the fixture joined: the R1 "public non-member" case.
    let public_p2 = seed_channel(su, ws, "public", alice).await;
    let private_s1 = seed_channel(su, ws, "private", alice).await;
    let channel_b = seed_channel(su, ws_b, "public", bob_b).await;

    for m in [alice, bob, dave_left, erin_suspended, agent] {
        join(su, ws, public_p1, m).await;
    }
    join(su, ws, private_s1, alice).await;
    join(su, ws_b, channel_b, bob_b).await;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(public_p1)
        .bind(dave_left)
        .execute(su)
        .await
        .expect("dave leaves");
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(erin_suspended)
        .execute(su)
        .await
        .expect("erin suspended");

    let (m_p1, s_p1) = seed_message(su, ws, public_p1, alice).await;
    let (m_s1, s_s1) = seed_message(su, ws, private_s1, alice).await;
    let (m_del, s_del) = seed_message(su, ws, public_p1, alice).await;
    let (m_b, s_b) = seed_message(su, ws_b, channel_b, bob_b).await;

    let d_p1 = seed_digest(su, ws, public_p1, s_p1, &[(m_p1, public_p1)]).await;
    let d_s1 = seed_digest(su, ws, private_s1, s_s1, &[(m_s1, private_s1)]).await;
    // Stored in the public channel, but one piece of evidence is in the private one.
    let d_multi = seed_digest(
        su,
        ws,
        public_p1,
        s_p1 + 100,
        &[(m_p1, public_p1), (m_s1, private_s1)],
    )
    .await;
    let d_del = seed_digest(su, ws, public_p1, s_del, &[(m_del, public_p1)]).await;
    let d_no_evidence = seed_digest(su, ws, public_p1, s_p1 + 200, &[]).await;
    let d_b = seed_digest(su, ws_b, channel_b, s_b, &[(m_b, channel_b)]).await;

    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
         max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(ws)
    .bind(alice)
    .execute(su)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(run)
    .bind(ws)
    .bind(agent)
    .bind(private_s1)
    .execute(su)
    .await
    .expect("run");
    sqlx::query(
        "INSERT INTO mem_serving (workspace_id, run_id, channel_id, digest_ids, withheld_count) \
         VALUES ($1, $2, $3, ARRAY[$4::uuid], 2)",
    )
    .bind(ws)
    .bind(run)
    .bind(private_s1)
    .bind(d_s1)
    .execute(su)
    .await
    .expect("receipt");

    World {
        ws,
        ws_b,
        alice,
        bob,
        carol,
        dave_left,
        erin_suspended,
        agent,
        bob_b,
        public_p1,
        public_p2,
        private_s1,
        d_p1,
        d_s1,
        d_multi,
        d_del,
        d_no_evidence,
        d_b,
        del_message: m_del,
        run,
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

async fn visible_digests(app: &PgPool, ws: Uuid, member: Option<Uuid>) -> Vec<Uuid> {
    let mut tx = viewer_tx(app, ws, member).await;
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM mem_digest")
        .fetch_all(&mut *tx)
        .await
        .expect("select digests");
    tx.rollback().await.expect("rollback");
    ids
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

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn mem_schema_read_policy_and_channel_readable_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = build_world(&su).await;

    // ---- (e) R1 parity: mem_can_read_channel == is_channel_member --------------
    let channels = [w.public_p1, w.public_p2, w.private_s1];
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
                "R1 parity broke for {label} on channel {channel}"
            );
        }
    }
    // Spot-pin the rule's content, not only the equality: the R1 answers.
    let expect: [(Uuid, Uuid, bool); 8] = [
        (w.alice, w.public_p1, true),
        (w.bob, w.public_p1, true),
        (w.bob, w.public_p2, false), // public channel, non-member: NOT readable
        (w.bob, w.private_s1, false),
        (w.carol, w.public_p1, false),
        (w.dave_left, w.public_p1, false), // left member
        (w.agent, w.public_p1, true),      // agents are members like any other
        (w.alice, w.private_s1, true),
    ];
    for (member, channel, want) in expect {
        let mut tx = viewer_tx(&app, w.ws, Some(member)).await;
        let got: bool = sqlx::query_scalar("SELECT mem_can_read_channel($1)")
            .bind(channel)
            .fetch_one(&mut *tx)
            .await
            .expect("fn");
        tx.rollback().await.expect("rollback");
        assert_eq!(got, want, "member {member} channel {channel}");
    }
    // Foreign workspace: bob_b holds a valid membership of workspace B only.
    {
        let mut tx = viewer_tx(&app, w.ws, Some(w.bob_b)).await;
        let got: bool = sqlx::query_scalar("SELECT mem_can_read_channel($1)")
            .bind(w.public_p1)
            .fetch_one(&mut *tx)
            .await
            .expect("fn");
        tx.rollback().await.expect("rollback");
        assert!(!got, "a foreign-workspace member must not read");
    }
    // Documented narrowing (search.rs:297-301): a suspended member still has a
    // membership row (is_channel_member says yes) but the digest rule says no.
    {
        let mut tx = viewer_tx(&app, w.ws, Some(w.erin_suspended)).await;
        let rust_rule = momo_messaging::is_channel_member(&mut tx, w.public_p1, w.erin_suspended)
            .await
            .expect("is_channel_member");
        let sql_rule: bool = sqlx::query_scalar("SELECT mem_can_read_channel($1)")
            .bind(w.public_p1)
            .fetch_one(&mut *tx)
            .await
            .expect("fn");
        tx.rollback().await.expect("rollback");
        assert!(rust_rule && !sql_rule, "suspended: narrower, never wider");
    }
    // Fail closed: no app.member_id at all.
    assert!(visible_digests(&app, w.ws, None).await.is_empty());

    // ---- (c) reader of every evidence channel sees the digests ------------------
    let mut alice_sees = visible_digests(&app, w.ws, Some(w.alice)).await;
    alice_sees.sort();
    let mut want = vec![w.d_p1, w.d_s1, w.d_multi, w.d_del];
    want.sort();
    assert_eq!(alice_sees, want, "alice reads P1 and S1, so all four");

    // ---- (b) same-workspace non-reader of the stored channel --------------------
    let bob_sees = visible_digests(&app, w.ws, Some(w.bob)).await;
    assert!(
        !bob_sees.contains(&w.d_s1),
        "bob is not in S1: no S1 digest"
    );
    assert!(bob_sees.contains(&w.d_p1));
    assert!(visible_digests(&app, w.ws, Some(w.carol)).await.is_empty());
    assert!(visible_digests(&app, w.ws, Some(w.dave_left))
        .await
        .is_empty());

    // ---- (d) multi-channel digest: hidden if ANY evidence channel is unreadable ---
    assert!(
        !bob_sees.contains(&w.d_multi),
        "d_multi is stored in P1 (bob reads it) but cites S1 (bob cannot)"
    );
    assert!(alice_sees.contains(&w.d_multi));
    // A digest with no evidence row is never shown.
    assert!(!alice_sees.contains(&w.d_no_evidence));

    // ---- deletion hides at once (D6-2) ------------------------------------------
    sqlx::query(
        "UPDATE message SET state = 'deleted', body = NULL, deleted_at = now() WHERE id = $1",
    )
    .bind(w.del_message)
    .execute(&su)
    .await
    .expect("delete message");
    let after = visible_digests(&app, w.ws, Some(w.alice)).await;
    assert!(
        !after.contains(&w.d_del),
        "deleted evidence hides the digest"
    );
    assert!(after.contains(&w.d_p1));

    // ---- (a) cross-workspace isolation, every new table -------------------------
    for table in ["mem_digest", "mem_evidence", "mem_serving"] {
        // alice's identity under workspace B's tenant GUC sees nothing of A's rows.
        let n = count(&app, w.ws_b, Some(w.alice), table).await;
        // Evidence is tenant-scoped ids (workspace B owns exactly one); alice is no
        // member of B's channel, so the digest/receipt read policies show nothing.
        let own_b = i64::from(table == "mem_evidence");
        assert_eq!(n, own_b, "{table}: workspace B GUC sees only B's own rows");
    }
    assert_eq!(
        visible_digests(&app, w.ws_b, Some(w.bob_b)).await,
        vec![w.d_b]
    );
    assert!(!visible_digests(&app, w.ws, Some(w.bob_b))
        .await
        .contains(&w.d_b));
    {
        // WITH CHECK: a tenant tx cannot write into another workspace.
        let mut tx = viewer_tx(&app, w.ws_b, Some(w.bob_b)).await;
        let res = sqlx::query(
            "INSERT INTO mem_cursor (channel_id, workspace_id, last_seq) VALUES ($1, $2, 1)",
        )
        .bind(w.public_p1)
        .bind(w.ws)
        .execute(&mut *tx)
        .await;
        assert!(res.is_err(), "cross-workspace INSERT must violate RLS");
        tx.rollback().await.expect("rollback");
    }

    // ---- receipts follow the answer channel (D7) ---------------------------------
    assert_eq!(count(&app, w.ws, Some(w.alice), "mem_serving").await, 1);
    assert_eq!(count(&app, w.ws, Some(w.bob), "mem_serving").await, 0);
    assert_eq!(count(&app, w.ws, None, "mem_serving").await, 0);
    let _ = w.run;

    // ---- worker-style write with tenant GUC only (no member identity) -----------
    {
        let mut tx = viewer_tx(&app, w.ws, None).await;
        let digest = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO mem_digest (id, workspace_id, channel_id, level, from_seq, to_seq, \
             body, prompt_version) VALUES ($1, $2, $3, 'day', 1, 2, 'd', 'v1')",
        )
        .bind(digest)
        .bind(w.ws)
        .bind(w.public_p1)
        .execute(&mut *tx)
        .await
        .expect("tenant-only INSERT is allowed (no RETURNING)");
        let dup = sqlx::query(
            "INSERT INTO mem_digest (workspace_id, channel_id, level, from_seq, to_seq, body, \
             prompt_version) VALUES ($1, $2, 'day', 1, 2, 'again', 'v1')",
        )
        .bind(w.ws)
        .bind(w.public_p1)
        .execute(&mut *tx)
        .await;
        assert!(dup.is_err(), "(channel, level, to_seq, thread) is unique");
        tx.rollback().await.expect("rollback");
    }

    // ---- mem_settings: personal rows are owner-only -------------------------------
    for (scope, channel, member) in [
        ("workspace", None, None),
        ("channel", Some(w.public_p1), None),
        ("member", None, Some(w.alice)),
    ] {
        sqlx::query(
            "INSERT INTO mem_settings (workspace_id, scope, channel_id, member_id, paused) \
             VALUES ($1, $2, $3, $4, true)",
        )
        .bind(w.ws)
        .bind(scope)
        .bind(channel)
        .bind(member)
        .execute(&su)
        .await
        .expect("settings");
    }
    assert_eq!(count(&app, w.ws, Some(w.alice), "mem_settings").await, 3);
    assert_eq!(count(&app, w.ws, Some(w.bob), "mem_settings").await, 2);
    assert_eq!(count(&app, w.ws, None, "mem_settings").await, 2);
    assert_eq!(count(&app, w.ws_b, Some(w.alice), "mem_settings").await, 0);
    {
        let mut tx = viewer_tx(&app, w.ws, Some(w.bob)).await;
        let res = sqlx::query(
            "INSERT INTO mem_settings (workspace_id, scope, member_id, paused) \
             VALUES ($1, 'member', $2, true)",
        )
        .bind(w.ws)
        .bind(w.alice)
        .execute(&mut *tx)
        .await;
        assert!(res.is_err(), "bob must not write alice's personal row");
        tx.rollback().await.expect("rollback");
    }
    // A member-scope row cannot carry workspace-only switches.
    let bad = sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, member_id, enabled) \
         VALUES ($1, 'member', $2, false)",
    )
    .bind(w.ws)
    .bind(w.bob)
    .execute(&su)
    .await;
    assert!(bad.is_err(), "scope column CHECK");

    // ---- ENABLE + FORCE on every new table ----------------------------------------
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
