//! DB-backed conformance for **인용 답글** — ADR-0148, goal SRV-T3.
//!
//! Same discipline as `conformance_pg.rs` / `breadth_conformance_pg.rs`: every
//! test proves one rule of the ADR with a **named assertion that goes red if the
//! rule is reverted**, and all are `#[ignore]` because they need a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime `momo_app` role. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-messaging --test quote_reply_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is identical to its siblings: `DATABASE_URL` points at a
//! **superuser** which applies the migrations and seeds fixtures past RLS, while
//! every assertion that matters runs as `momo_app` (`NOBYPASSRLS`) — the only
//! faithful way to exercise the policies. `MOMO_APP_PASSWORD` defaults to the
//! value `infra/e2e/bootstrap_roles.sql` sets. The migration runner is
//! idempotent, so this binary may share a container with the others.
//!
//! ## The outbox-counting rule these tests obey (B1 gate lesson)
//!
//! A `message` INSERT fires `push_candidate_enqueue_trg`
//! (`011_push_notifier.sql:67`), which enqueues a **second** outbox row with the
//! same `partition_key`. Every count below therefore filters on `kind` — an
//! unfiltered count double-counts and reports a bug that is not there.
//!
//! ## What is NOT here
//!
//! "One page is one query" is proved without a database, in
//! `message.rs::one_page_is_one_statement_however_many_quotes_it_holds`: the
//! quote is resolved by the page statement's own `LEFT JOIN`, so the round-trip
//! count is a property of the SQL rather than of the data. What this file adds
//! is the other half — that a page full of quotes actually resolves all of them
//! (`srv_t3_7_...`), which is what a join silently getting dropped would break.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, delete_message_in_tx, edit_message_in_tx, list_channel_page,
    list_thread_replies, send_message_with_mentions_in_tx, validate_quote_target_in_tx,
    ChannelKind, HistoryCursor, NewChannel, NewMessage, PagedMessage, QuoteTargetInvalid,
    SentMessage,
};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors breadth_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

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
        .expect("apply every migration on a pgvector/pg18 DB");
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

async fn seed_member(su: &PgPool, ws: Uuid, id: Uuid, handle: &str) {
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human'::member_kind, $3, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(format!("{handle} display"))
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");

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

async fn new_channel(app: &PgPool, ws: Uuid, name: &str, owner: Uuid) -> Uuid {
    create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: name.into(),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id
}

/// The REST send path's spine — the one every quote is written through.
async fn send(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let outcome = send_message_with_mentions_in_tx(conn, ws, input, None).await?;
            Ok::<_, DbError>(outcome.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("send")
}

async fn history(app: &PgPool, ws: Uuid, channel_id: Uuid) -> Vec<PagedMessage> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(
            async move { list_channel_page(conn, channel_id, HistoryCursor::Newest, 200).await },
        )
    })
    .await
    .expect("history")
}

fn row_for(page: &[PagedMessage], id: Uuid) -> &PagedMessage {
    page.iter()
        .find(|paged| paged.message.id == id)
        .expect("the message is on the page")
}

async fn outbox_count(su: &PgPool, partition_key: Uuid, kind: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM outbox WHERE partition_key = $1 AND kind::text = $2")
        .bind(partition_key)
        .bind(kind)
        .fetch_one(su)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// SRV-T3 #1 — 규칙 2: a quote target lives in THIS channel, and this tenant
// ---------------------------------------------------------------------------

/// The same-channel rule, from both directions that can break it.
///
/// Goes red if the channel predicate leaves `validate_quote_target_in_tx` (the
/// sibling channel's message would become quotable), and — the more important
/// half — if the validation ever runs outside `with_tenant_tx`, because then the
/// *other workspace's* message stops being invisible and starts being findable.
/// Both refusals are `NotFound`, deliberately: a distinguishable answer would
/// turn the send endpoint into an existence oracle for messages the caller
/// cannot read.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_1_a_quote_target_must_live_in_this_channel_and_this_tenant() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let other_ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_workspace(&su, other_ws).await;
    seed_member(&su, ws, alice, "alice").await;
    seed_member(&su, other_ws, outsider, "outsider").await;

    let here = new_channel(&app, ws, "here", alice).await;
    let there = new_channel(&app, ws, "there", alice).await;
    let foreign = new_channel(&app, other_ws, "foreign", outsider).await;

    let mine = send(&app, ws, NewMessage::text(here, alice, "여기 원문")).await;
    let sibling = send(&app, ws, NewMessage::text(there, alice, "옆 채널 원문")).await;
    let theirs = send(
        &app,
        other_ws,
        NewMessage::text(foreign, outsider, "남의 워크스페이스 원문"),
    )
    .await;

    let (same, cross_channel, cross_tenant) = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let same = validate_quote_target_in_tx(conn, here, mine.message.id).await?;
            let cross_channel = validate_quote_target_in_tx(conn, here, sibling.message.id).await?;
            let cross_tenant = validate_quote_target_in_tx(conn, here, theirs.message.id).await?;
            Ok::<_, DbError>((same, cross_channel, cross_tenant))
        })
    })
    .await
    .expect("validate");

    assert_eq!(same, Ok(()), "a message in this channel is quotable");
    assert_eq!(
        cross_channel,
        Err(QuoteTargetInvalid::NotFound),
        "규칙 2 — a message in another channel is not quotable"
    );
    assert_eq!(
        cross_tenant,
        Err(QuoteTargetInvalid::NotFound),
        "RLS FORCE is what makes another tenant's message unquotable, and its \
         refusal must be indistinguishable from 'no such message'"
    );

    // A tombstone is refused too — with its OWN sentence, because "gone" and
    // "never here" have different fixes.
    let doomed = send(&app, ws, NewMessage::text(here, alice, "곧 지울 글")).await;
    let doomed_id = doomed.message.id;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            delete_message_in_tx(conn, ws, doomed_id, alice)
                .await?
                .expect("the author may delete their own message");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("delete");

    let deleted = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { validate_quote_target_in_tx(conn, here, doomed_id).await })
    })
    .await
    .expect("validate deleted");
    assert_eq!(deleted, Err(QuoteTargetInvalid::Deleted));
}

// ---------------------------------------------------------------------------
// SRV-T3 #2 — 규칙 1: the two devices are independent
// ---------------------------------------------------------------------------

/// A message carries `root_id` and `reply_to_id` at once, stores both, and
/// projects both — on the channel page and inside the thread alike.
///
/// Goes red the moment anyone makes them exclusive (an `else` branch in the
/// route, a `CHECK` constraint, a projection that drops one when the other is
/// present). Quoting one particular reply from inside its own thread is the
/// case ADR-0148 was written for; it is unrepresentable if these two ever
/// become a choice.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_2_a_message_can_carry_a_thread_and_a_quote_at_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    let channel = new_channel(&app, ws, "both", alice).await;

    let root = send(&app, ws, NewMessage::text(channel, alice, "루트")).await;

    let mut first_reply = NewMessage::text(channel, alice, "첫 답글");
    first_reply.root_id = Some(root.message.id);
    let first_reply = send(&app, ws, first_reply).await;

    // The ADR's own example: inside the thread, quoting one particular reply.
    let mut both = NewMessage::text(channel, alice, "그 답글 말인데");
    both.root_id = Some(root.message.id);
    both.reply_to_id = Some(first_reply.message.id);
    let both = send(&app, ws, both).await;

    assert_eq!(both.message.root_id, Some(root.message.id));
    assert_eq!(both.message.reply_to_id, Some(first_reply.message.id));

    let stored: (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT root_id, reply_to_id FROM message WHERE id = $1")
            .bind(both.message.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        stored,
        (Some(root.message.id), Some(first_reply.message.id)),
        "both columns are written — neither overwrites the other"
    );

    // Channel history projects the pair AND resolves the quote.
    let page = history(&app, ws, channel).await;
    let projected = row_for(&page, both.message.id);
    assert_eq!(projected.message.root_id, Some(root.message.id));
    assert_eq!(projected.message.reply_to_id, Some(first_reply.message.id));
    let quote = projected.reply_to.as_ref().expect("the quote resolves");
    assert_eq!(quote.id, first_reply.message.id);
    assert_eq!(quote.body.as_deref(), Some("첫 답글"));
    assert!(
        !quote.quotes_another,
        "the first reply quotes nothing, so the 규칙 4 marker is false"
    );

    // …and so does the thread page, which is the surface a client actually
    // opens to read this conversation.
    let replies = with_tenant_tx(&app, ws, move |conn| {
        let root_id = root.message.id;
        Box::pin(async move { list_thread_replies(conn, channel, root_id, None, 50).await })
    })
    .await
    .expect("replies");
    let in_thread = replies
        .messages
        .iter()
        .find(|paged| paged.message.id == both.message.id)
        .expect("the quoting reply is in the thread");
    assert_eq!(
        in_thread
            .reply_to
            .as_ref()
            .expect("the thread page resolves quotes too")
            .id,
        first_reply.message.id
    );
}

// ---------------------------------------------------------------------------
// SRV-T3 #3 — 규칙 3: deleting the original leaves no copy behind
// ---------------------------------------------------------------------------

/// Quote a message, then delete it: the quote becomes a tombstone, and the
/// quoted text exists **nowhere** — not on the quoting row, not in its props,
/// not in the projection.
///
/// This is the rule with teeth. Goes red the moment anyone "optimises" the
/// quote into a stored snapshot, because a snapshot is by definition a copy that
/// survives the author's decision to delete.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_3_a_deleted_quote_target_leaves_no_copy_of_itself() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    seed_member(&su, ws, bob, "bob").await;
    let channel = new_channel(&app, ws, "tombstone", alice).await;
    seed_membership(&su, ws, channel, bob).await;

    const SECRET: &str = "지우고 싶은 말";
    let original = send(&app, ws, NewMessage::text(channel, alice, SECRET)).await;

    let mut quoting = NewMessage::text(channel, bob, "그건 아니지");
    quoting.reply_to_id = Some(original.message.id);
    let quoting = send(&app, ws, quoting).await;

    // Alive: the quote renders.
    let before = history(&app, ws, channel).await;
    assert_eq!(
        row_for(&before, quoting.message.id)
            .reply_to
            .as_ref()
            .expect("quote resolves")
            .body
            .as_deref(),
        Some(SECRET)
    );

    let original_id = original.message.id;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            delete_message_in_tx(conn, ws, original_id, alice)
                .await?
                .expect("the author deletes their own message");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("delete");

    let after = history(&app, ws, channel).await;
    let projected = row_for(&after, quoting.message.id);
    let quote = projected
        .reply_to
        .as_ref()
        .expect("the reference survives the deletion — the TEXT does not");
    assert_eq!(quote.id, original_id, "the quote still points somewhere");
    assert_eq!(
        quote.body, None,
        "a deleted target must render as 삭제된 메시지, with no text to render"
    );
    assert_eq!(quote.state, "deleted");
    assert!(
        quote.deleted_at.is_some(),
        "the tombstone carries its stamp"
    );

    // The decisive assertion: the deleted text is gone from the whole row of the
    // message that quoted it, body and props alike. A snapshot implementation
    // fails here even if the projection above were patched to hide it.
    let (body, props): (Option<String>, Value) =
        sqlx::query_as("SELECT body, props FROM message WHERE id = $1")
            .bind(quoting.message.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(!body.unwrap_or_default().contains(SECRET));
    assert!(
        !props.to_string().contains(SECRET),
        "no copy of the deleted message may survive on the quoting row: {props}"
    );

    // …and not in the realtime payload the quote was published with either.
    let payload: Value = sqlx::query_scalar("SELECT payload FROM outbox WHERE id = $1")
        .bind(quoting.outbox_id.expect("a first send publishes"))
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(
        !payload.to_string().contains(SECRET),
        "an outbox row is replayed forever; a quoted body in it is a permanent \
         copy: {payload}"
    );
    assert_eq!(
        payload["data"]["payload"]["reply_to_id"],
        serde_json::json!(original_id),
        "the wire carries the address instead"
    );
}

// ---------------------------------------------------------------------------
// SRV-T3 #4 — 규칙 3, the other half: an edit shows through
// ---------------------------------------------------------------------------

/// Editing the original changes what every quote of it says, with no write to
/// the quoting message at all. Goes red under any snapshot implementation.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_4_an_edited_quote_target_shows_through() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    seed_member(&su, ws, bob, "bob").await;
    let channel = new_channel(&app, ws, "edited", alice).await;
    seed_membership(&su, ws, channel, bob).await;

    let original = send(&app, ws, NewMessage::text(channel, alice, "처음 쓴 말")).await;
    let mut quoting = NewMessage::text(channel, bob, "인용함");
    quoting.reply_to_id = Some(original.message.id);
    let quoting = send(&app, ws, quoting).await;

    let quoting_updated_before: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT edited_at FROM message WHERE id = $1")
            .bind(quoting.message.id)
            .fetch_one(&su)
            .await
            .unwrap();

    let original_id = original.message.id;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, original_id, alice, "고쳐 쓴 말")
                .await?
                .expect("the author edits their own message");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("edit");

    let page = history(&app, ws, channel).await;
    let quote = row_for(&page, quoting.message.id)
        .reply_to
        .as_ref()
        .expect("quote resolves");
    assert_eq!(
        quote.body.as_deref(),
        Some("고쳐 쓴 말"),
        "the quote follows the original because it IS the original, read again"
    );
    assert!(
        quote.edited_at.is_some(),
        "the quote block can say 수정됨 without a second fetch"
    );

    // Nothing was written to the quoting message to make that happen — which is
    // the point: an edit costs O(1), not O(quotes of it).
    let quoting_updated_after: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT edited_at FROM message WHERE id = $1")
            .bind(quoting.message.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(quoting_updated_before, quoting_updated_after);
}

// ---------------------------------------------------------------------------
// SRV-T3 #5 — 불변식: a quote is just a message
// ---------------------------------------------------------------------------

/// A quoting send consumes exactly one `seq`, publishes exactly one broadcast,
/// and stays idempotent under the same `client_msg_id`.
///
/// Goes red if quoting ever grows a second write path — a pre-read that skips
/// the counter, an extra publication for the quote block, or a retry that posts
/// a second message.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_5_a_quote_consumes_one_seq_and_publishes_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    let channel = new_channel(&app, ws, "seq", alice).await;

    let original = send(&app, ws, NewMessage::text(channel, alice, "원문")).await;
    let broadcasts_before = outbox_count(&su, channel, "broadcast").await;

    let idempotency_key = Uuid::new_v4();
    let quoting_input = || {
        let mut input =
            NewMessage::text(channel, alice, "인용").with_client_msg_id(idempotency_key);
        input.reply_to_id = Some(original.message.id);
        input
    };

    let first = send(&app, ws, quoting_input()).await;
    assert!(!first.deduped);
    assert_eq!(
        first.message.seq,
        original.message.seq + 1,
        "gapless — a quote consumes the next seq like any other message"
    );
    assert_eq!(
        outbox_count(&su, channel, "broadcast").await,
        broadcasts_before + 1,
        "one message, one broadcast — the quote is not a second event"
    );

    let retry = send(&app, ws, quoting_input()).await;
    assert!(
        retry.deduped,
        "the idempotency guard is untouched by quoting"
    );
    assert_eq!(retry.message.id, first.message.id);
    assert_eq!(retry.message.seq, first.message.seq);
    assert_eq!(retry.message.reply_to_id, Some(original.message.id));
    assert!(retry.outbox_id.is_none(), "a retry publishes nothing");
    assert_eq!(
        outbox_count(&su, channel, "broadcast").await,
        broadcasts_before + 1
    );
}

// ---------------------------------------------------------------------------
// SRV-T3 #6 — 규칙 5: being quoted rides the mention path
// ---------------------------------------------------------------------------

/// Quoting someone raises **their existing mention badge** — same props key,
/// same `read_state` column, same push reason. No new notification kind appears
/// anywhere.
///
/// Goes red if the quote notification is ever split into its own ledger, and
/// also if quoting yourself starts raising your own badge (the author exclusion
/// is shared with `@mentions` precisely so it cannot be forgotten on one side).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_6_a_quote_notifies_through_the_mention_path() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    seed_member(&su, ws, bob, "bob").await;
    let channel = new_channel(&app, ws, "quoted-badge", alice).await;
    seed_membership(&su, ws, channel, bob).await;

    let alices = send(&app, ws, NewMessage::text(channel, alice, "내 원문")).await;

    // Bob quotes Alice, and never types her name.
    let mut quoting = NewMessage::text(channel, bob, "여기에 답함");
    quoting.reply_to_id = Some(alices.message.id);
    let quoting = send(&app, ws, quoting).await;

    let alice_token = alice.to_string().to_uppercase();
    let props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(quoting.message.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        props["mention_member_ids"],
        Value::from(vec![alice_token.clone()]),
        "the quoted author lands in the SAME server-owned key an @handle uses — \
         a second key here would be a notification kind nobody taught the \
         notifier about"
    );

    let alice_mentions: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(alice_mentions, 1, "being quoted is being named");

    // The realtime payload carries the same decision, so a connected client
    // highlights it without a second fetch — again through the mention key.
    let payload: Value = sqlx::query_scalar("SELECT payload FROM outbox WHERE id = $1")
        .bind(quoting.outbox_id.expect("a first send publishes"))
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        payload["data"]["payload"]["props"]["mention_member_ids"],
        Value::from(vec![alice_token])
    );

    // No new outbox kind was invented for this.
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT kind::text FROM outbox WHERE partition_key = $1")
            .bind(channel)
            .fetch_all(&su)
            .await
            .unwrap();
    for kind in &kinds {
        assert!(
            matches!(kind.as_str(), "broadcast" | "push_candidate"),
            "quoting must not mint a new outbox kind, found {kind}"
        );
    }

    // Quoting yourself notifies nobody: the author exclusion is the mention
    // path's, shared rather than re-implemented.
    let mut self_quote = NewMessage::text(channel, alice, "내 말에 덧붙임");
    self_quote.reply_to_id = Some(alices.message.id);
    let self_quote = send(&app, ws, self_quote).await;
    let self_props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(self_quote.message.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(
        self_props.get("mention_member_ids").is_none(),
        "nobody can raise their own badge by quoting themselves: {self_props}"
    );
    let alice_after: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(alice_after, 1);
}

// ---------------------------------------------------------------------------
// SRV-T3 #7 — 규칙 4 + the scale half of the N+1 claim
// ---------------------------------------------------------------------------

/// A page whose every row quotes something resolves **every** quote, and the
/// second layer of a quote-of-a-quote is a marker rather than an expansion.
///
/// The round-trip count is pinned without a DB (see the module header); what
/// this adds is that the single join actually covers a full page — the failure
/// mode a `LIMIT`-shaped or lateral rewrite would introduce.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn srv_t3_7_a_full_page_of_quotes_resolves_and_stops_at_one_layer() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "alice").await;
    let channel = new_channel(&app, ws, "chain", alice).await;

    // A chain: each message quotes the one before it, so every row on the page
    // both has a quote and IS one.
    const CHAIN: usize = 40;
    let mut ids = Vec::with_capacity(CHAIN);
    let first = send(&app, ws, NewMessage::text(channel, alice, "0")).await;
    ids.push(first.message.id);
    for index in 1..CHAIN {
        let mut input = NewMessage::text(channel, alice, index.to_string());
        input.reply_to_id = Some(ids[index - 1]);
        ids.push(send(&app, ws, input).await.message.id);
    }

    let page = history(&app, ws, channel).await;
    assert_eq!(page.len(), CHAIN, "the whole chain is on one page");

    for (index, id) in ids.iter().enumerate() {
        let projected = row_for(&page, *id);
        match index {
            0 => assert!(
                projected.reply_to.is_none(),
                "the head of the chain quotes nothing"
            ),
            _ => {
                let quote = projected
                    .reply_to
                    .as_ref()
                    .unwrap_or_else(|| panic!("row {index} must resolve its quote"));
                assert_eq!(quote.id, ids[index - 1]);
                assert_eq!(
                    quote.body.as_deref(),
                    Some((index - 1).to_string().as_str())
                );
                // 규칙 4 — the quoted message's own quote is a flag and nothing
                // more. There is no id to follow, so no client can draw a third
                // layer even by trying.
                assert_eq!(
                    quote.quotes_another,
                    index >= 2,
                    "row {index}: the second layer is a marker, set exactly when \
                     the quoted message quotes something"
                );
            }
        }
    }
}
