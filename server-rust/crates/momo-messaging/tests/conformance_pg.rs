//! DB-backed conformance for the messaging write-path spine (ADR-0145 B안, D2).
//!
//! These are the orchestrator's docker-gate red tests: each proves one hard
//! invariant with a **named assertion that goes red if the invariant is
//! reverted** (momo red-test discipline, D2 §2). They are `#[ignore]` because
//! they need a throwaway `pgvector/pgvector:pg18` superuser DB plus the runtime
//! `momo_app` role. Run (per D2 #1/#3/#4/#5/#6):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-messaging --test conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract:
//!   * `DATABASE_URL` connects as a **superuser** (applies the 59 migrations via
//!     psql + `infra/e2e/bootstrap_roles.sql`, and seeds fixtures bypassing RLS).
//!   * the RLS-isolation and write-path assertions run as the runtime **`momo_app`**
//!     role (`NOBYPASSRLS`), the only faithful way to exercise the DB policies.
//!
//! Each `#[test]` seeds fresh random UUIDs, so the whole file can run against one
//! DB; the schema/role bootstrap runs once per process (guarded).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, send_message, send_message_in_tx, ChannelKind, NewChannel, NewMessage,
};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

/// The `momo_app` runtime password. This is the committed test-only credential
/// from `infra/e2e/bootstrap_roles.sql` (not a real secret); override via env.
fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

/// Pool connecting as the `momo_app` role (NOBYPASSRLS) to the same DB — the role
/// the RLS policies actually filter. Built by reusing the superuser DATABASE_URL
/// host/port/db and swapping in the app role's credentials.
async fn momo_app_pool() -> PgPool {
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
}

/// Locate psql the way `momo-db`'s runner does (PATH, then Homebrew libpq).
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

fn bootstrap_roles_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ))
}

/// Apply `infra/e2e/bootstrap_roles.sql` via psql (canonical mechanism; the file
/// is plain server-side SQL, no meta-commands, but psql keeps us off
/// `sqlx::raw_sql`, per B0's runner rule).
fn apply_bootstrap_roles() {
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(bootstrap_roles_path())
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

/// Apply the 59 migrations + bootstrap roles exactly once per test process.
fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all 59 migrations on a fresh pgvector/pg18 DB");
    apply_bootstrap_roles();
    *ready = true;
}

// ---------------------------------------------------------------------------
// seed helpers (run as superuser → bypass RLS)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool, ws: Uuid) {
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
}

async fn seed_member(su: &PgPool, ws: Uuid, id: Uuid, kind: &str) {
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("seed member");

    if kind == "agent" {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url) \
             VALUES ($1, $2, 'test-model', 'http://localhost/v1')",
        )
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed agent child");
    }
}

async fn seed_channel_with_seq(su: &PgPool, ws: Uuid, ch: Uuid, name: &str) {
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) \
         VALUES ($1, $2, 'public', $3)",
    )
    .bind(ch)
    .bind(ws)
    .bind(name)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(ch)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed channel_seq");
}

/// Seed a message directly (bypassing the write path) — used by #6 to place a
/// row in a *foreign* tenant that the assertion must never see.
async fn seed_raw_message(su: &PgPool, ws: Uuid, ch: Uuid, author: Uuid, seq: i64) {
    sqlx::query(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, $3, 1, 0, $4, 'text', 'foreign tenant row')",
    )
    .bind(ws)
    .bind(ch)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .expect("seed raw message");
}

// ---------------------------------------------------------------------------
// #1 — Postgres = SoT (+ idempotency parity)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_1_sot_message_and_outbox_persist_in_pg() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let member = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, member, "human").await;

    // Exercise the real create_channel path (channel + channel_seq + owner
    // membership) as momo_app under RLS.
    let channel = create_channel(
        &app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: "general".into(),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("create channel");

    let idem = Uuid::new_v4();
    let sent = send_message(
        &app,
        ws,
        NewMessage::text(channel.id, member, "hello world").with_client_msg_id(idem),
    )
    .await
    .expect("send message");
    assert!(!sent.deduped, "first send must insert");
    assert_eq!(sent.message.seq, 1, "first message in a channel is seq 1");
    let outbox_id = sent.outbox_id.expect("first send emits an outbox row");

    // The message is durable in PG (SoT), not just in a cache.
    let msg_present: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message WHERE id = $1 AND channel_id = $2 AND seq = 1)",
    )
    .bind(sent.message.id)
    .bind(channel.id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(msg_present, "message must be persisted in Postgres");

    // The broadcast is a durable outbox row (invariant #1/#3): kind broadcast,
    // partition_key = channel_id, payload shaped for the relay.
    let row =
        sqlx::query("SELECT kind::text AS kind, partition_key, payload FROM outbox WHERE id = $1")
            .bind(outbox_id)
            .fetch_one(&su)
            .await
            .unwrap();
    let kind: String = row.get("kind");
    let partition_key: Uuid = row.get("partition_key");
    let payload: Value = row.get("payload");
    assert_eq!(kind, "broadcast", "SoT→relay egress is a broadcast row");
    assert_eq!(partition_key, channel.id, "partition_key = channel_id");
    assert_eq!(payload["version"], Value::from(1), "version = seq");
    assert_eq!(payload["data"]["payload"]["seq"], Value::from(1));
    assert_eq!(payload["data"]["type"], Value::from("message.new"));

    // Idempotency parity: a retry with the same client_msg_id returns the same
    // seq and emits NO second broadcast (exactly-once effect).
    let retry = send_message(
        &app,
        ws,
        NewMessage::text(channel.id, member, "hello world").with_client_msg_id(idem),
    )
    .await
    .expect("retry send");
    assert!(retry.deduped, "retry must dedupe");
    assert_eq!(retry.message.seq, 1, "retry returns the original seq");
    assert!(retry.outbox_id.is_none(), "retry emits no outbox row");

    // Count only the app-emitted `broadcast`. A message insert also fires the
    // reused DB trigger `push_candidate_enqueue_trg` (011), which enqueues one
    // `push_candidate` outbox row (partition_key=channel_id) — a legitimate,
    // Swift-faithful side effect of the trigger layer, not the app's egress. The
    // single-write-path invariant here is about the broadcast the app authors.
    let broadcast_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE partition_key = $1 AND kind = 'broadcast'",
    )
    .bind(channel.id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        broadcast_count, 1,
        "idempotent retry must not double-broadcast"
    );
}

// ---------------------------------------------------------------------------
// #3 — single write path atomicity (message + outbox roll back together)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_3_single_write_path_rolls_back_atomically() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let member = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, member, "human").await;
    seed_channel_with_seq(&su, ws, channel, "atomic").await;

    // Run the real spine, then force an error before commit. If emit_outbox were
    // moved out of this transaction, its row would survive the rollback.
    let res: Result<(), DbError> = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let _ = send_message_in_tx(conn, ws, NewMessage::text(channel, member, "roll back"))
                .await?;
            Err(DbError::from(sqlx::Error::RowNotFound))
        })
    })
    .await;
    assert!(
        res.is_err(),
        "the forced failure must abort the transaction"
    );

    let msg_count: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(msg_count, 0, "message insert must roll back");

    let outbox_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM outbox WHERE partition_key = $1")
            .bind(channel)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        outbox_count, 0,
        "outbox row must roll back with the message (same tx)"
    );

    // The seq bump is part of the same tx, so it rolls back too.
    let last_seq: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(channel)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(last_seq, 0, "channel_seq bump must roll back with the tx");
}

// ---------------------------------------------------------------------------
// #4 — gapless seq under concurrency
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_4_gapless_seq_under_concurrent_sends() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let member = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, member, "human").await;
    seed_channel_with_seq(&su, ws, channel, "race").await;

    const N: i64 = 12;
    let mut set = tokio::task::JoinSet::new();
    for i in 0..N {
        let app = app.clone();
        set.spawn(async move {
            send_message(&app, ws, NewMessage::text(channel, member, format!("m{i}")))
                .await
                .map(|s| s.message.seq)
        });
    }
    let mut seqs = Vec::new();
    while let Some(joined) = set.join_next().await {
        let seq = joined.expect("task join").expect("concurrent send");
        seqs.push(seq);
    }
    seqs.sort_unstable();

    // Row-lock serialization ⇒ seqs are exactly 1..=N, contiguous, no dup/gap.
    // Swapping the lock for a sequence/nextval (gap-allowing) makes this red;
    // dropping serialization makes the DB `message_seq_uniq` fail a racing send.
    let expected: Vec<i64> = (1..=N).collect();
    assert_eq!(
        seqs, expected,
        "seqs must be gapless 1..=N with no duplicate"
    );

    let persisted: Vec<i64> =
        sqlx::query_scalar("SELECT seq FROM message WHERE channel_id = $1 ORDER BY seq")
            .bind(channel)
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(persisted, expected, "persisted seqs are gapless 1..=N");

    // Count only the app-emitted `broadcast` (the 011 push_candidate trigger
    // adds one `push_candidate` row per message with the same partition_key —
    // faithful trigger-layer behavior, out of this invariant's scope).
    let broadcast_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE partition_key = $1 AND kind = 'broadcast'",
    )
    .bind(channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        broadcast_count, N,
        "each committed send emits exactly one broadcast"
    );
}

// ---------------------------------------------------------------------------
// #5 — agent = member (identical write path)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_5_agent_sends_through_the_same_path() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let human = Uuid::new_v4();
    let agent = Uuid::new_v4();
    let channel = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, human, "human").await;
    seed_member(&su, ws, agent, "agent").await;
    seed_channel_with_seq(&su, ws, channel, "mixed").await;

    // Human and agent send through the identical send_message path.
    let human_sent = send_message(&app, ws, NewMessage::text(channel, human, "from human"))
        .await
        .expect("human send");
    let agent_sent = send_message(&app, ws, NewMessage::text(channel, agent, "from agent"))
        .await
        .expect("agent send");

    // Same seq path: contiguous seqs regardless of author kind.
    assert_eq!(human_sent.message.seq, 1);
    assert_eq!(
        agent_sent.message.seq, 2,
        "agent shares the gapless seq path"
    );

    // Same outbox path: the agent's broadcast is structurally identical and
    // carries the agent's member id as author (no special-casing).
    let row =
        sqlx::query("SELECT kind::text AS kind, partition_key, payload FROM outbox WHERE id = $1")
            .bind(agent_sent.outbox_id.expect("agent send emits outbox"))
            .fetch_one(&su)
            .await
            .unwrap();
    let kind: String = row.get("kind");
    let partition_key: Uuid = row.get("partition_key");
    let payload: Value = row.get("payload");
    assert_eq!(kind, "broadcast", "agent egress is the same broadcast kind");
    assert_eq!(
        partition_key, channel,
        "agent egress shares partition_key = channel_id"
    );
    assert_eq!(payload["data"]["type"], Value::from("message.new"));
    assert_eq!(
        payload["data"]["payload"]["author_member_id"],
        Value::from(agent.to_string()),
        "the agent is the author on the shared write path"
    );

    // The author really is an agent-kind member.
    let author_kind: String = sqlx::query_scalar("SELECT kind::text FROM member WHERE id = $1")
        .bind(agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(author_kind, "agent");
}

// ---------------------------------------------------------------------------
// #6 — RLS isolation (cross-tenant read = 0 rows, as momo_app / NOBYPASSRLS)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_6_rls_blocks_cross_tenant_reads() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    // Two independent workspaces, each with a channel + one message.
    let ws_a = Uuid::new_v4();
    let ws_b = Uuid::new_v4();
    let member_a = Uuid::new_v4();
    let member_b = Uuid::new_v4();
    let channel_a = Uuid::new_v4();
    let channel_b = Uuid::new_v4();
    seed_workspace(&su, ws_a).await;
    seed_workspace(&su, ws_b).await;
    seed_member(&su, ws_a, member_a, "human").await;
    seed_member(&su, ws_b, member_b, "human").await;
    seed_channel_with_seq(&su, ws_a, channel_a, "a").await;
    seed_channel_with_seq(&su, ws_b, channel_b, "b").await;
    seed_raw_message(&su, ws_a, channel_a, member_a, 1).await;
    seed_raw_message(&su, ws_b, channel_b, member_b, 1).await;

    // Scoped to workspace A via the sole GUC seam (with_tenant_tx), momo_app:
    //   * sees A's own message  (policy lets the owning tenant through), and
    //   * sees ZERO of B's rows  (cross-tenant isolation).
    // Drop the GUC set and even A's row disappears; run as a BYPASSRLS role and
    // B's row leaks — either revert makes an assertion below red.
    let (own_visible, foreign_visible): (i64, i64) = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            let own: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                .bind(channel_a)
                .fetch_one(&mut *conn)
                .await
                .map_err(DbError::from)?;
            let foreign: i64 =
                sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                    .bind(channel_b)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(DbError::from)?;
            Ok((own, foreign))
        })
    })
    .await
    .expect("scoped read as momo_app");

    assert_eq!(own_visible, 1, "workspace A must see its own message");
    assert_eq!(
        foreign_visible, 0,
        "workspace A must see ZERO of workspace B's messages (RLS isolation)"
    );

    // Symmetric check: an unscoped SELECT of everything visible to A returns only
    // A's row, never B's.
    let total_visible: i64 = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            sqlx::query_scalar("SELECT count(*) FROM message")
                .fetch_one(&mut *conn)
                .await
                .map_err(DbError::from)
        })
    })
    .await
    .expect("scoped count as momo_app");
    assert_eq!(total_visible, 1, "A sees exactly its own single message");
}
