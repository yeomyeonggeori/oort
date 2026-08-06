//! DB-backed conformance for message interactions (B11 — edit / delete / react;
//! 이슈 #1112 — pin).
//!
//! Red-test discipline: each assertion below goes red if the invariant it names
//! is reverted, and the invariant is named in the test's own name. They are
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime `momo_app` role — this worker never runs docker; the orchestrator
//! does:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-messaging --test interaction_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is the sibling files': `DATABASE_URL` connects as a
//! **superuser** (applies the migrations + `infra/e2e/bootstrap_roles.sql`, seeds
//! fixtures bypassing RLS), while every assertion about the domain runs as the
//! runtime **`momo_app`** role (`NOBYPASSRLS`) — the only faithful way to
//! exercise the policies. Fresh random UUIDs per test, so the file can run
//! against a DB another binary already migrated.
//!
//! **What is deliberately proven here and not in a unit test:** the four
//! statements are only interesting *against Postgres*. That an edit does not
//! advance `channel_seq`, that a tombstone keeps its row and drops its
//! reactions, that a duplicate reaction does not surface a unique violation, and
//! that RLS hides a foreign tenant's message — none of those can be observed
//! without the schema they are about.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    channel_pins, channel_reaction_snapshot, delete_message_in_tx, edit_message_in_tx,
    send_message_in_tx, set_pin_in_tx, InteractionRefused, NewMessage, PinAction, ReactionAction,
    StoredMessage, CHANNEL_PIN_LIMIT,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

/// The committed test-only `momo_app` password from
/// `infra/e2e/bootstrap_roles.sql` (not a real secret); override via env.
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on the conformance DB");
    apply_bootstrap_roles();
    *ready = true;
}

// ---------------------------------------------------------------------------
// seed helpers (superuser → bypass RLS)
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

    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
}

async fn seed_channel_with_seq(su: &PgPool, ws: Uuid, ch: Uuid) {
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(ch)
        .bind(ws)
        .bind(ch.to_string())
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

async fn seed_membership(su: &PgPool, ws: Uuid, ch: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(ws)
    .bind(ch)
    .bind(member)
    .execute(su)
    .await
    .expect("seed membership");
}

async fn channel_last_seq(su: &PgPool, ch: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(ch)
        .fetch_one(su)
        .await
        .expect("read channel_seq")
}

async fn broadcast_types(su: &PgPool, ch: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT payload->'data'->>'type' FROM outbox \
          WHERE partition_key = $1 AND kind::text = 'broadcast' \
          ORDER BY id",
    )
    .bind(ch)
    .fetch_all(su)
    .await
    .expect("read outbox broadcast types")
}

async fn reaction_row_count(su: &PgPool, message_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM reaction WHERE message_id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("count reactions")
}

/// One committed message in a seeded channel, written through the real spine.
async fn seed_sent_message(
    app: &PgPool,
    ws: Uuid,
    ch: Uuid,
    author: Uuid,
    body: &str,
) -> StoredMessage {
    with_tenant_tx(app, ws, move |conn| {
        let body = body.to_string();
        Box::pin(async move {
            let sent = send_message_in_tx(conn, ws, NewMessage::text(ch, author, body)).await?;
            Ok::<_, DbError>(sent.message)
        })
    })
    .await
    .expect("seed a sent message")
}

/// A fully wired fixture: workspace, channel, two members, both joined.
struct Fixture {
    ws: Uuid,
    ch: Uuid,
    author: Uuid,
    other: Uuid,
}

async fn seed_fixture(su: &PgPool, other_kind: &str) -> Fixture {
    let ws = Uuid::new_v4();
    let ch = Uuid::new_v4();
    let author = Uuid::new_v4();
    let other = Uuid::new_v4();
    seed_workspace(su, ws).await;
    seed_member(su, ws, author, "human").await;
    seed_member(su, ws, other, other_kind).await;
    seed_channel_with_seq(su, ws, ch).await;
    seed_membership(su, ws, ch, author).await;
    seed_membership(su, ws, ch, other).await;
    Fixture {
        ws,
        ch,
        author,
        other,
    }
}

// ---------------------------------------------------------------------------
// #1 — gapless seq: no interaction mints one
// ---------------------------------------------------------------------------

/// **The invariant B11 is most able to break.** Every interaction reuses the
/// target's seq; none advances `channel_seq`. Revert that (bump the counter for
/// an edit, or give a reaction its own message row) and this goes red on the
/// `last_seq` comparison — which is what would otherwise ship as "every 👍 marks
/// the channel unread for everyone".
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_no_interaction_consumes_a_channel_seq() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "before").await;
    let seq_after_send = channel_last_seq(&su, fx.ch).await;
    assert_eq!(
        seq_after_send, message.seq,
        "the send is the only thing that mints a seq"
    );

    let (ws, author, other, message_id) = (fx.ws, fx.author, fx.other, message.id);
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, message_id, author, "after")
                .await?
                .expect("the author may edit");
            momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                other,
                "👍",
                ReactionAction::Added,
            )
            .await?
            .expect("a channel member may react");
            momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                other,
                "👍",
                ReactionAction::Removed,
            )
            .await?
            .expect("…and un-react");
            delete_message_in_tx(conn, ws, message_id, author)
                .await?
                .expect("the author may delete");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("four interactions in one transaction");

    assert_eq!(
        channel_last_seq(&su, fx.ch).await,
        seq_after_send,
        "an edit, a reaction, an un-reaction and a delete must all reuse the \
         message's own seq — the channel counter may not move"
    );

    // …and every broadcast they enqueued names that same seq.
    let seqs: Vec<i64> = sqlx::query_scalar(
        "SELECT (payload->'data'->>'seq')::bigint FROM outbox \
          WHERE partition_key = $1 AND kind::text = 'broadcast' ORDER BY id",
    )
    .bind(fx.ch)
    .fetch_all(&su)
    .await
    .expect("read broadcast seqs");
    assert!(
        seqs.iter().all(|seq| *seq == message.seq),
        "every interaction broadcast reuses the target's seq, got {seqs:?}"
    );
}

// ---------------------------------------------------------------------------
// #2 — single write path: the notification is an outbox row, in the same tx
// ---------------------------------------------------------------------------

/// The realtime notification is an outbox row committed with the mutation, and
/// a rolled-back interaction takes it with it. Break the atomicity (publish
/// outside the transaction) and the second half goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_interactions_notify_only_through_the_outbox_and_roll_back_with_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "before").await;
    let (ws, author, message_id) = (fx.ws, fx.author, message.id);

    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, message_id, author, "after")
                .await?
                .expect("edit");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("committed edit");

    assert_eq!(
        broadcast_types(&su, fx.ch).await,
        vec!["message.new".to_string(), "message.edited".to_string()],
        "the edit's only egress is one broadcast row behind the message's own"
    );

    // A rolled-back edit leaves neither the new body nor a broadcast.
    let rolled_back: Result<(), DbError> = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, message_id, author, "never committed")
                .await?
                .expect("edit");
            Err(DbError::from(sqlx::Error::RowNotFound))
        })
    })
    .await;
    assert!(rolled_back.is_err(), "the closure returned Err");

    let body: Option<String> = sqlx::query_scalar("SELECT body FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("read body");
    assert_eq!(
        body.as_deref(),
        Some("after"),
        "a rolled-back edit must not reach the row"
    );
    assert_eq!(
        broadcast_types(&su, fx.ch).await.len(),
        2,
        "…nor leave its broadcast behind"
    );
}

// ---------------------------------------------------------------------------
// #3 — soft delete: the row and its seq survive, the reactions do not
// ---------------------------------------------------------------------------

/// A tombstone keeps its row, its id and its seq, drops its body, and takes its
/// reactions with it. A hard delete would punch a hole in the gapless seq and is
/// what the first assertion here forbids.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_delete_is_soft_and_sweeps_the_messages_reactions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "before").await;
    let (ws, author, other, message_id) = (fx.ws, fx.author, fx.other, message.id);

    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                other,
                "👍",
                ReactionAction::Added,
            )
            .await?
            .expect("react");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("one reaction");
    assert_eq!(reaction_row_count(&su, message_id).await, 1);

    let deleted = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let deleted = delete_message_in_tx(conn, ws, message_id, author)
                .await?
                .expect("the author may delete");
            Ok::<_, DbError>(deleted)
        })
    })
    .await
    .expect("delete");

    assert!(!deleted.already_deleted);
    assert_eq!(deleted.message.message.seq, message.seq, "the seq survives");
    assert_eq!(deleted.message.message.state, "deleted");
    assert!(deleted.message.message.body.is_none(), "the body is erased");
    assert!(deleted.message.message.deleted_at.is_some());

    let still_there: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(
        still_there, 1,
        "the row must remain — a hard delete would leave a hole in the channel's \
         gapless seq that no client could distinguish from a lost message"
    );
    assert_eq!(
        reaction_row_count(&su, message_id).await,
        0,
        "reactions annotate a body that no longer exists"
    );

    // Deleting again is idempotent, records nothing, and publishes nothing.
    let before = broadcast_types(&su, fx.ch).await.len();
    let again = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let deleted = delete_message_in_tx(conn, ws, message_id, author)
                .await?
                .expect("still the author");
            Ok::<_, DbError>(deleted)
        })
    })
    .await
    .expect("second delete");
    assert!(again.already_deleted, "the second delete is a no-op");
    assert_eq!(
        broadcast_types(&su, fx.ch).await.len(),
        before,
        "a repeated delete must not re-publish a tombstone"
    );

    // …and an edit of a tombstone is refused rather than resurrecting it.
    let refused = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                edit_message_in_tx(conn, ws, message_id, author, "resurrect")
                    .await?
                    .expect_err("a tombstone cannot be edited"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(refused, InteractionRefused::EditDeleted);
}

// ---------------------------------------------------------------------------
// #4 — reactions: idempotent, agent = member, snapshot shape
// ---------------------------------------------------------------------------

/// A duplicate reaction is a success that changes nothing — **not** a 500 from
/// `reaction_uniq`. That is the failure mode a double-tapped emoji produces in
/// practice, so it is the one worth a DB-backed test.
///
/// The reactor here is an **agent** member, which is the other half of the
/// assertion: there is no human/agent branch in the reaction path, and an agent
/// reacting through the identical statement is invariant #5 in action.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_a_duplicate_reaction_is_idempotent_and_an_agent_reacts_like_anyone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "agent").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "before").await;
    let (ws, ch, agent, message_id) = (fx.ws, fx.ch, fx.other, message.id);

    let (first, second, third) = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let first = momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                agent,
                "👍",
                ReactionAction::Added,
            )
            .await?
            .expect("an agent member may react");
            let second = momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                agent,
                "👍",
                ReactionAction::Added,
            )
            .await?
            .expect("a duplicate PUT is a success");
            let third = momo_messaging::set_reaction_in_tx(
                conn,
                ws,
                message_id,
                agent,
                "🎉",
                ReactionAction::Removed,
            )
            .await?
            .expect("removing one that was never there is a success");
            Ok::<_, DbError>((first, second, third))
        })
    })
    .await
    .expect("three reaction calls");

    assert!(first.changed, "the first add writes a row");
    assert!(
        !second.changed,
        "the duplicate must report no change — and must not have raised \
         reaction_uniq as a 500"
    );
    assert!(
        !third.changed,
        "removing an absent reaction changes nothing"
    );
    assert_eq!(reaction_row_count(&su, message_id).await, 1);

    assert_eq!(
        broadcast_types(&su, ch).await,
        vec!["message.new".to_string(), "reaction.added".to_string()],
        "only the call that changed something publishes"
    );

    // The snapshot is keyed exactly as Swift keys it: uppercase ids.
    let snapshot = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { channel_reaction_snapshot(conn, ch).await })
    })
    .await
    .expect("snapshot");
    let key = message_id.to_string().to_uppercase();
    assert_eq!(
        snapshot.get(&key).and_then(|by_emoji| by_emoji.get("👍")),
        Some(&vec![agent.to_string().to_uppercase()]),
        "message id -> emoji -> member ids, uppercase like Swift's uuidString: \
         {snapshot:?}"
    );
}

// ---------------------------------------------------------------------------
// #5 — authorship and tenancy
// ---------------------------------------------------------------------------

/// Two boundaries in one test because they are the two ways an interaction can
/// be *wrongly allowed*: another member editing your words, and another tenant
/// touching your row at all.
///
/// The tenancy half runs as `momo_app` under a foreign workspace's GUC, so the
/// message is invisible rather than merely forbidden — RLS FORCE, not an
/// application `if`. Drop the policy and this returns something other than
/// `NotFound`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_only_the_author_edits_and_rls_hides_another_tenants_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "mine").await;
    let (ws, other, message_id) = (fx.ws, fx.other, message.id);

    let (edit_refusal, delete_refusal) = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let edit = edit_message_in_tx(conn, ws, message_id, other, "yours now")
                .await?
                .expect_err("a channel member is not the author");
            let delete = delete_message_in_tx(conn, ws, message_id, other)
                .await?
                .expect_err("nor may they delete it");
            Ok::<_, DbError>((edit, delete))
        })
    })
    .await
    .expect("both refusals");
    assert_eq!(edit_refusal, InteractionRefused::NotAuthorForEdit);
    assert_eq!(delete_refusal, InteractionRefused::NotAuthorForDelete);

    let body: Option<String> = sqlx::query_scalar("SELECT body FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("read body");
    assert_eq!(
        body.as_deref(),
        Some("mine"),
        "a refused edit must not have touched the row"
    );

    // A second tenant, and the message simply does not exist for it.
    let foreign_ws = Uuid::new_v4();
    let foreign_member = Uuid::new_v4();
    seed_workspace(&su, foreign_ws).await;
    seed_member(&su, foreign_ws, foreign_member, "human").await;

    let refusal = with_tenant_tx(&app, foreign_ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                edit_message_in_tx(conn, foreign_ws, message_id, foreign_member, "cross tenant")
                    .await?
                    .expect_err("another tenant's message is not visible at all"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(
        refusal,
        InteractionRefused::NotFound,
        "RLS FORCE must hide the row — a 403 here would confirm it exists"
    );
}

// ---------------------------------------------------------------------------
// #6 — the history projection carries the edit/delete stamps
// ---------------------------------------------------------------------------

/// Without `edited_at`/`deleted_at` on the projection, an edit is invisible to
/// any client that reloads: the new body arrives with nothing marking it as
/// changed, and a tombstone is indistinguishable from a message with no text.
/// This is the read side of the same B11 contract.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn b11_history_projects_the_edit_and_delete_stamps() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let kept = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "untouched").await;
    let edited = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "before").await;
    let removed = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "doomed").await;
    let (ws, ch, author) = (fx.ws, fx.ch, fx.author);
    let (edited_id, removed_id) = (edited.id, removed.id);

    let page = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, edited_id, author, "after")
                .await?
                .expect("edit");
            delete_message_in_tx(conn, ws, removed_id, author)
                .await?
                .expect("delete");
            momo_messaging::list_channel_page(conn, ch, momo_messaging::HistoryCursor::Newest, 50)
                .await
        })
    })
    .await
    .expect("history page");

    let find = |id: Uuid| {
        page.iter()
            .find(|paged| paged.message.id == id)
            .unwrap_or_else(|| panic!("history must still contain {id}"))
            .message
            .clone()
    };

    let kept_row = find(kept.id);
    assert!(kept_row.edited_at.is_none() && kept_row.deleted_at.is_none());

    let edited_row = find(edited_id);
    assert_eq!(edited_row.state, "edited");
    assert_eq!(edited_row.body.as_deref(), Some("after"));
    assert!(
        edited_row.edited_at.is_some(),
        "history must carry the edit stamp or a reload shows the new text as if \
         it were the original"
    );

    let removed_row = find(removed_id);
    assert_eq!(
        removed_row.state, "deleted",
        "a tombstone stays in history — vanishing would look like a seq hole"
    );
    assert!(removed_row.body.is_none());
    assert!(removed_row.deleted_at.is_some());
}

// ---------------------------------------------------------------------------
// #7 — pin: membership, cap, live-list parity (이슈 #1112)
// ---------------------------------------------------------------------------

async fn pin_row_count(su: &PgPool, channel_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message_pin WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(su)
        .await
        .expect("count pins")
}

/// **Red proof #1 — a non-member cannot pin.**
///
/// The membership gate is not the route's; it is [`set_pin_in_tx`]'s, exactly
/// like the reaction path's. Remove `lock_and_authorize` from the pin body and
/// this goes red on the refusal *and* on the row count — a stranger would
/// otherwise be able to plant an entry in a channel header they cannot read.
///
/// The second half is the tenancy boundary: a foreign workspace does not get a
/// 403, it gets `NotFound`, because RLS FORCE hides the message entirely. A 403
/// here would confirm the message exists.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn pin_1112_a_non_member_cannot_pin_and_another_tenant_cannot_see_the_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;

    let message = seed_sent_message(&app, fx.ws, fx.ch, fx.author, "고정 대상").await;

    // A workspace member who is not in this channel.
    let outsider = Uuid::new_v4();
    seed_member(&su, fx.ws, outsider, "human").await;
    let (ws, ch, message_id) = (fx.ws, fx.ch, message.id);

    let refusal = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                set_pin_in_tx(conn, ws, message_id, outsider, PinAction::Pinned)
                    .await?
                    .expect_err("a non-member may not pin"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(refusal, InteractionRefused::NotAMember);
    assert_eq!(
        pin_row_count(&su, ch).await,
        0,
        "a refused pin must not have written a row"
    );

    // …and unpinning is gated identically: the refusal is not "pin only".
    let refusal = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                set_pin_in_tx(conn, ws, message_id, outsider, PinAction::Unpinned)
                    .await?
                    .expect_err("a non-member may not unpin either"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(refusal, InteractionRefused::NotAMember);

    let foreign_ws = Uuid::new_v4();
    let foreign_member = Uuid::new_v4();
    seed_workspace(&su, foreign_ws).await;
    seed_member(&su, foreign_ws, foreign_member, "human").await;
    let refusal = with_tenant_tx(&app, foreign_ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                set_pin_in_tx(
                    conn,
                    foreign_ws,
                    message_id,
                    foreign_member,
                    PinAction::Pinned,
                )
                .await?
                .expect_err("another tenant's message is not visible at all"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(
        refusal,
        InteractionRefused::NotFound,
        "RLS FORCE must hide the row — a 403 here would confirm it exists"
    );
}

/// **Red proof #2 — the channel cap refuses the pin over the line.**
///
/// Two assertions, and they are different claims. The first is that the domain
/// answers `PinLimit` (a friendly 409) rather than letting the write through.
/// The second is that migration 061's trigger is the *authority*: bypassing the
/// domain entirely — a raw `INSERT` as the runtime role, which is what a future
/// code path that forgot the guard would do — still fails, with the 23514 the
/// migration names. Delete the trigger and only the second half goes red, which
/// is precisely the regression worth catching separately.
///
/// The cap is exercised at its real value rather than a test-only one, because
/// a constant the test overrides is a constant the test is not checking.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn pin_1112_the_channel_cap_refuses_the_pin_over_the_line() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fx = seed_fixture(&su, "human").await;
    let (ws, ch, author) = (fx.ws, fx.ch, fx.author);

    let mut ids = Vec::new();
    for index in 0..=CHANNEL_PIN_LIMIT {
        ids.push(
            seed_sent_message(&app, ws, ch, author, &format!("고정 {index}"))
                .await
                .id,
        );
    }

    let over_the_line = ids.pop().expect("one message past the cap");
    let to_pin = ids.clone();
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            for id in &to_pin {
                set_pin_in_tx(conn, ws, *id, author, PinAction::Pinned)
                    .await?
                    .expect("a channel member may pin up to the cap");
            }
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("fill the channel to the cap");
    assert_eq!(pin_row_count(&su, ch).await, CHANNEL_PIN_LIMIT);

    let refusal = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                set_pin_in_tx(conn, ws, over_the_line, author, PinAction::Pinned)
                    .await?
                    .expect_err("the cap is reached"),
            )
        })
    })
    .await
    .expect("query ran");
    assert_eq!(refusal, InteractionRefused::PinLimit);
    assert_eq!(
        pin_row_count(&su, ch).await,
        CHANNEL_PIN_LIMIT,
        "a refused pin must not have written a row"
    );

    // The trigger is the authority: a write that skips the domain still fails.
    let raw: Result<(), DbError> = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO message_pin (workspace_id, channel_id, message_id, pinned_by) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(ws)
            .bind(ch)
            .bind(over_the_line)
            .bind(author)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })
    .await;
    let error = raw.expect_err("migration 061's trigger refuses the 101st pin");
    let sentence = error.to_string();
    assert!(
        sentence.contains("maximum 100 pinned"),
        "the schema must be the one refusing, and by name: {sentence}"
    );

    // Freeing a slot makes room again — the cap is a live count, not a
    // high-water mark.
    let freed = ids[0];
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            set_pin_in_tx(conn, ws, freed, author, PinAction::Unpinned)
                .await?
                .expect("any channel member may unpin");
            set_pin_in_tx(conn, ws, over_the_line, author, PinAction::Pinned)
                .await?
                .expect("the freed slot is usable");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("unpin then pin");
    assert_eq!(pin_row_count(&su, ch).await, CHANNEL_PIN_LIMIT);
}

/// **Red proof #3, server half — the broadcast carries the whole list entry.**
///
/// A client must be able to apply `message.pinned` and end up with the state a
/// re-read of `GET …/pins` would have given it. That only holds if the payload
/// carries the *projection*, not the id: strip `pinned` down to ids and this
/// goes red on the body/author/seq comparison, which is exactly the change that
/// would silently force every client back into a refetch.
///
/// The idempotence and tombstone-sweep claims ride along because they are the
/// other two ways the list and the broadcast can disagree: a duplicate PUT that
/// re-published would insert a second header row on every client, and a delete
/// that left the pin behind would strand an unopenable entry.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn pin_1112_the_broadcast_carries_what_the_list_would_have_returned() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    // The pinner is an **agent** member: there is no human/agent branch in the
    // pin path either (invariant #5).
    let fx = seed_fixture(&su, "agent").await;
    let (ws, ch, author, agent) = (fx.ws, fx.ch, fx.author, fx.other);

    let message = seed_sent_message(&app, ws, ch, author, "고정할 메시지").await;
    let message_id = message.id;

    let (first, second) = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let first = set_pin_in_tx(conn, ws, message_id, agent, PinAction::Pinned)
                .await?
                .expect("an agent member may pin");
            let second = set_pin_in_tx(conn, ws, message_id, agent, PinAction::Pinned)
                .await?
                .expect("a duplicate PUT is a success");
            Ok::<_, DbError>((first, second))
        })
    })
    .await
    .expect("two pin calls");

    assert!(first.changed);
    assert!(
        !second.changed,
        "a duplicate pin must report no change — and must not have raised \
         message_pin_message_uniq as a 500"
    );
    assert_eq!(pin_row_count(&su, ch).await, 1);
    assert_eq!(
        broadcast_types(&su, ch).await,
        vec!["message.new".to_string(), "message.pinned".to_string()],
        "only the call that changed something publishes"
    );

    // The published payload and the list projection are the same facts.
    let published: serde_json::Value = sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE partition_key = $1 AND payload->'data'->>'type' = 'message.pinned' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(ch)
    .fetch_one(&su)
    .await
    .expect("read the pinned payload");

    let listed = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { channel_pins(conn, ch).await })
    })
    .await
    .expect("pin list");
    assert_eq!(listed.len(), 1);
    let entry = &listed[0];

    assert_eq!(published["message_id"], serde_json::json!(entry.message_id));
    assert_eq!(published["channel_id"], serde_json::json!(entry.channel_id));
    assert_eq!(published["seq"], serde_json::json!(entry.seq));
    assert_eq!(
        published["author_member_id"],
        serde_json::json!(entry.author_member_id)
    );
    assert_eq!(published["body"], serde_json::json!(entry.body));
    assert_eq!(published["pinned_by"], serde_json::json!(entry.pinned_by));
    assert_eq!(
        published["pinned_at_ms"],
        serde_json::json!(entry.pinned_at.timestamp_millis()),
        "a client applying the frame must land on the list's own timestamp, or \
         its ordering diverges from everyone who cold-loaded"
    );
    assert_eq!(
        entry.seq, message.seq,
        "the entry names the message's own seq — pinning mints none"
    );

    // …and the broadcast reused that seq rather than minting one.
    assert_eq!(
        channel_last_seq(&su, ch).await,
        message.seq,
        "a pin must not advance the channel counter — every cursor in the \
         workspace would read it as an unread message"
    );

    // Deleting the message sweeps the pin, and does so without a second frame:
    // the client drops the entry on `message.deleted`.
    let before = broadcast_types(&su, ch).await.len();
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            delete_message_in_tx(conn, ws, message_id, author)
                .await?
                .expect("the author may delete");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("delete");
    assert_eq!(
        pin_row_count(&su, ch).await,
        0,
        "a tombstone must not hold a slot against the channel cap"
    );
    let after = broadcast_types(&su, ch).await;
    assert_eq!(
        after.len(),
        before + 1,
        "the delete publishes exactly one frame: {after:?}"
    );
    assert_eq!(after.last().map(String::as_str), Some("message.deleted"));

    let listed = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { channel_pins(conn, ch).await })
    })
    .await
    .expect("pin list after delete");
    assert!(
        listed.is_empty(),
        "the list must not draw a deleted message"
    );
}
