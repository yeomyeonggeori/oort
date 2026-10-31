//! DB-backed conformance for ADR-0148 증보 2026-10-31 — **스레드 요약의 참여자**(#4877) and
//! **대화에도 보내기**(#4887).
//!
//! Same discipline as `quote_reply_conformance_pg.rs`: every test proves one rule with a **named
//! assertion that goes red if the rule is reverted**, and all are `#[ignore]` because they need a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime `momo_app` role. Run (isolated DB only):
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres \
//!   cargo test -p momo-messaging --test thread_reply_home_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Every assertion that matters runs as `momo_app` (`NOBYPASSRLS`) in a tenant transaction; the
//! superuser only seeds fixtures and reads the raw rows back. Two workspaces are in play wherever
//! isolation is the point.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_first_reply_makes_a_one_face_summary_on_every_surface` | 첫 답글: 기록 페이지·`thread.updated`·저장 행이 같은 한 사람 | the summary keys leave one of the three producers |
//! | `a_repeat_replier_is_counted_once_and_moves_to_the_front` | 같은 사람 반복(A·B·A): 수 2, 순서 `[A, B]`, 저장은 마지막이 끝 | `array_remove` leaves the upsert (the order stays `[B, A]`, or the repeat is counted twice) |
//! | `four_or_more_repliers_show_the_newest_three_and_count_everyone` | 4명 이상: 최근 3명만, 수는 전체, 옛 사람이 돌아오면 순서가 바뀜 | the cap of three leaves `thread_rollup`, or the order is not reversed |
//! | `another_workspace_never_sees_or_moves_a_thread` | 다른 워크스페이스 격리 | the thread row is read outside the tenant transaction, or one workspace's reply writes another's row |
//! | `a_member_who_left_or_was_removed_keeps_their_face` | 나간 멤버·지운 멤버: id와 수가 그대로 | the summary filters its ids against membership or `member.deleted_at` |
//! | `the_database_refuses_also_in_channel_on_a_top_level_message` | DB 제약: 최상위 글에 켠 행은 INSERT·UPDATE 모두 거절 | `message_also_in_channel_reply_ck` is dropped |
//! | `the_choice_rides_history_thread_replies_and_the_realtime_frames` | 기록 페이지·스레드 답글 페이지·`message.new`·`message.edited`에 값이 실리고, 켜지 않은 행에는 키가 없음, 답글 수는 한 번만 | a read statement stops projecting the column, or a frame stops carrying it |
//! | `an_idempotent_retry_answers_the_stored_choice_and_changes_nothing` | 같은 `client_msg_id`로 다른 값을 보내도 저장된 값, 재시도는 요약을 다시 움직이지 않음 | the retry re-bumps the rollup, publishes again, or overwrites the choice |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, edit_message_in_tx, fetch_thread_rollup_in_tx, list_channel_page,
    list_thread_replies, send_message_with_mentions_in_tx, ChannelKind, HistoryCursor, NewChannel,
    NewMessage, PagedMessage, SendExtras, SentMessage, THREAD_SUMMARY_PARTICIPANTS,
};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors quote_reply_conformance_pg.rs)
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

fn apply_bootstrap_roles() {
    let roles = PathBuf::from(concat!(
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
        .arg(roles)
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

/// One workspace, one channel, an owner and `n` more members — all in the channel.
struct World {
    ws: Uuid,
    ch: Uuid,
    owner: Uuid,
    members: Vec<Uuid>,
}

async fn world(su: &PgPool, app: &PgPool, members: usize) -> World {
    let ws = Uuid::new_v4();
    seed_workspace(su, ws).await;
    let owner = Uuid::new_v4();
    seed_member(su, ws, owner, "owner").await;
    let ch = create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: "general".into(),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    let mut ids = Vec::new();
    for n in 0..members {
        let id = Uuid::new_v4();
        seed_member(su, ws, id, &format!("member{n}")).await;
        seed_membership(su, ws, ch, id).await;
        ids.push(id);
    }
    World {
        ws,
        ch,
        owner,
        members: ids,
    }
}

/// The REST send path's spine — the one every reply is written through — with the sender's
/// 「대화에도 보내기」 choice.
async fn send_with(
    app: &PgPool,
    ws: Uuid,
    input: NewMessage,
    also_in_channel: bool,
) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let outcome = send_message_with_mentions_in_tx(
                conn,
                ws,
                input,
                SendExtras {
                    also_in_channel,
                    ..SendExtras::default()
                },
            )
            .await?;
            Ok::<_, DbError>(outcome.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("send")
}

fn reply_input(ch: Uuid, author: Uuid, root: Uuid, body: &str) -> NewMessage {
    let mut input = NewMessage::text(ch, author, body);
    input.root_id = Some(root);
    input.client_msg_id = Some(Uuid::new_v4());
    input
}

async fn reply(app: &PgPool, w: &World, author: Uuid, root: Uuid, body: &str) -> SentMessage {
    send_with(app, w.ws, reply_input(w.ch, author, root, body), false).await
}

async fn root_message(app: &PgPool, w: &World, body: &str) -> Uuid {
    send_with(app, w.ws, NewMessage::text(w.ch, w.owner, body), false)
        .await
        .message
        .id
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

/// The summary a client would draw under `root`, read the way the history page reads it.
async fn summary(app: &PgPool, w: &World, root: Uuid) -> (Vec<Uuid>, i32, i32) {
    let page = history(app, w.ws, w.ch).await;
    let rollup = row_for(&page, root)
        .thread
        .clone()
        .expect("a root with replies carries a rollup");
    (
        rollup.participant_ids,
        rollup.participant_count,
        rollup.reply_count,
    )
}

/// Every broadcast payload (`data.payload`) of one event type in a channel, oldest first.
async fn frames(su: &PgPool, w: &World, event: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 AND partition_key = $2 AND kind::text = 'broadcast' \
            AND payload->'data'->>'type' = $3 \
          ORDER BY id",
    )
    .bind(w.ws)
    .bind(w.ch)
    .bind(event)
    .fetch_all(su)
    .await
    .expect("read broadcast frames")
}

/// The newest `thread.updated` payload for `root` — what every open client is told.
async fn last_thread_updated(su: &PgPool, w: &World, root: Uuid) -> Value {
    frames(su, w, "thread.updated")
        .await
        .into_iter()
        .rev()
        .find(|payload| {
            payload["root_id"]
                .as_str()
                .is_some_and(|id| id.eq_ignore_ascii_case(&root.to_string()))
        })
        .expect("a reply publishes thread.updated for its root")
}

/// `thread.participant_ids` exactly as stored (superuser read): oldest replier → newest.
async fn stored_participants(su: &PgPool, root: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar("SELECT participant_ids FROM thread WHERE root_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .expect("thread row")
}

fn ids_json(ids: &[Uuid]) -> Value {
    json!(ids.iter().map(Uuid::to_string).collect::<Vec<_>>())
}

// ---------------------------------------------------------------------------
// #4877 — 스레드 요약의 참여자
// ---------------------------------------------------------------------------

/// 첫 답글. The three producers of the summary — the history page, the realtime frame and the
/// stored row — name the same one person, and the count says one.
///
/// Goes red if any producer stops carrying the two keys (the page reads `participant_ids` through
/// `thread_rollup`, the frame through `build_thread_updated_payload`, the row through the upsert).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_first_reply_makes_a_one_face_summary_on_every_surface() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 2).await;
    let bob = w.members[0];

    let root = root_message(&app, &w, "배포 계획 어때요?").await;
    reply(&app, &w, bob, root, "좋아요").await;

    let (faces, count, replies) = summary(&app, &w, root).await;
    assert_eq!(faces, vec![bob], "the page names the one replier");
    assert_eq!(count, 1);
    assert_eq!(replies, 1);

    let frame = last_thread_updated(&su, &w, root).await;
    assert_eq!(
        frame["participant_ids"],
        ids_json(&[bob]),
        "the frame says the same: {frame}"
    );
    assert_eq!(frame["participant_count"], json!(1));
    assert_eq!(frame["reply_count"], json!(1));

    assert_eq!(stored_participants(&su, root).await, vec![bob]);

    // The send path and the history page read the same row the same way.
    let direct = with_tenant_tx(&app, w.ws, move |conn| {
        Box::pin(async move { fetch_thread_rollup_in_tx(conn, root).await })
    })
    .await
    .expect("fetch rollup")
    .expect("the root has a rollup");
    assert_eq!(direct.participant_ids, vec![bob]);
    assert_eq!(direct.participant_count, 1);
}

/// 같은 사람 반복 + 순서 바뀜. A·B·A leaves two people, **A in front** — the one who replied last —
/// and the stored array ends with A.
///
/// Goes red if the upsert stops moving a repeat replier to the end: with the old set-without-move
/// `CASE` the page reads `[B, A]`, and with a plain `array_append` the count is 3 and A appears
/// twice.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_repeat_replier_is_counted_once_and_moves_to_the_front() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 2).await;
    let (a, b) = (w.members[0], w.members[1]);

    let root = root_message(&app, &w, "의견 주세요").await;
    reply(&app, &w, a, root, "A 하나").await;
    reply(&app, &w, b, root, "B 하나").await;
    let (faces, count, _) = summary(&app, &w, root).await;
    assert_eq!(faces, vec![b, a], "B replied last, so B is first");
    assert_eq!(count, 2);

    reply(&app, &w, a, root, "A 둘").await;
    let (faces, count, replies) = summary(&app, &w, root).await;
    assert_eq!(
        faces,
        vec![a, b],
        "A replied again, so A moves to the front"
    );
    assert_eq!(count, 2, "the same person is counted once");
    assert_eq!(replies, 3, "…but all three replies are counted");

    assert_eq!(
        stored_participants(&su, root).await,
        vec![b, a],
        "the stored array runs oldest replier → newest, so the newest is last"
    );
    let frame = last_thread_updated(&su, &w, root).await;
    assert_eq!(frame["participant_ids"], ids_json(&[a, b]), "{frame}");
    assert_eq!(frame["participant_count"], json!(2));
}

/// 4명 이상. Five distinct repliers show only the newest three, newest first, and still count five.
/// Then the **oldest** replier comes back: they move to the front and push the third face out.
///
/// Goes red if the cap leaves `thread_rollup` (a fourth face appears), if the list is not reversed
/// (the oldest repliers are shown), or if the count is taken from the capped list.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn four_or_more_repliers_show_the_newest_three_and_count_everyone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 5).await;
    let u = w.members.clone();

    let root = root_message(&app, &w, "다들 어때요?").await;
    for (n, member) in u.iter().enumerate() {
        reply(&app, &w, *member, root, &format!("답 {n}")).await;
    }

    let (faces, count, _) = summary(&app, &w, root).await;
    assert_eq!(THREAD_SUMMARY_PARTICIPANTS, 3);
    assert_eq!(
        faces,
        vec![u[4], u[3], u[2]],
        "the newest three, newest first"
    );
    assert_eq!(
        count, 5,
        "everyone who replied is counted, not only the faces"
    );
    let frame = last_thread_updated(&su, &w, root).await;
    assert_eq!(
        frame["participant_ids"],
        ids_json(&[u[4], u[3], u[2]]),
        "{frame}"
    );
    assert_eq!(frame["participant_count"], json!(5));

    // The first replier returns: moves to the front, and the third face drops out.
    reply(&app, &w, u[0], root, "다시 왔어요").await;
    let (faces, count, replies) = summary(&app, &w, root).await;
    assert_eq!(faces, vec![u[0], u[4], u[3]], "the returning replier leads");
    assert_eq!(count, 5, "returning adds nobody");
    assert_eq!(replies, 6);
    assert_eq!(
        stored_participants(&su, root).await,
        vec![u[1], u[2], u[3], u[4], u[0]],
        "nobody is dropped from the stored set — only the wire is capped"
    );
}

/// 다른 워크스페이스 격리. Replies in one workspace never write another's thread row, and a
/// tenant transaction cannot even read another workspace's summary.
///
/// Goes red if the thread row is read outside the tenant transaction (RLS stops hiding it) or if
/// an upsert in one workspace reaches a row of another.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn another_workspace_never_sees_or_moves_a_thread() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = world(&su, &app, 2).await;
    let b = world(&su, &app, 2).await;

    let root_a = root_message(&app, &a, "A 워크스페이스 글").await;
    let root_b = root_message(&app, &b, "B 워크스페이스 글").await;
    reply(&app, &b, b.members[0], root_b, "B 첫 답").await;
    reply(&app, &b, b.owner, root_b, "B 둘째 답").await;
    let b_before = stored_participants(&su, root_b).await;
    assert_eq!(b_before, vec![b.members[0], b.owner]);

    // Heavy traffic in workspace A, including a reply by a member id that exists only there.
    for member in a.members.clone() {
        reply(&app, &a, member, root_a, "A 답").await;
    }
    reply(&app, &a, a.owner, root_a, "A 주인 답").await;

    let (faces_a, count_a, _) = summary(&app, &a, root_a).await;
    assert_eq!(faces_a, vec![a.owner, a.members[1], a.members[0]]);
    assert_eq!(count_a, 3);
    assert_eq!(
        stored_participants(&su, root_b).await,
        b_before,
        "A's replies did not touch B's thread"
    );

    // RLS: under A's tenant transaction, B's root has no rollup at all.
    let foreign = with_tenant_tx(&app, a.ws, move |conn| {
        Box::pin(async move { fetch_thread_rollup_in_tx(conn, root_b).await })
    })
    .await
    .expect("fetch foreign rollup");
    assert!(
        foreign.is_none(),
        "RLS hides another workspace's thread summary: {foreign:?}"
    );
    // …and B still sees its own, unchanged by any of that.
    let (faces_b, count_b, replies_b) = summary(&app, &b, root_b).await;
    assert_eq!(faces_b, vec![b.owner, b.members[0]]);
    assert_eq!((count_b, replies_b), (2, 2));
}

/// 나간 멤버·지운 멤버. A member who left the channel, and one whose account was removed, keep
/// their face and their place in the count: the summary is the thread's record of who replied,
/// not today's roster. The client draws an id it cannot resolve as 「알 수 없는 사람」.
///
/// Goes red if the summary starts filtering its ids against the channel's membership or
/// `member.deleted_at` (the departed would vanish from the faces and from the count).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_member_who_left_or_was_removed_keeps_their_face() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 3).await;
    let (stays, left, removed) = (w.members[0], w.members[1], w.members[2]);

    let root = root_message(&app, &w, "남는 사람과 떠난 사람").await;
    reply(&app, &w, removed, root, "곧 계정이 지워져요").await;
    reply(&app, &w, left, root, "곧 나가요").await;
    reply(&app, &w, stays, root, "저는 남아요").await;

    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(w.ch)
        .bind(left)
        .execute(&su)
        .await
        .expect("the member leaves the channel");
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(removed)
        .execute(&su)
        .await
        .expect("the member's account is removed");

    let (faces, count, _) = summary(&app, &w, root).await;
    assert_eq!(
        faces,
        vec![stays, left, removed],
        "the departed keep their ids, in reply order"
    );
    assert_eq!(count, 3, "and are still counted");

    // A later reply moves the remaining member to the front without dropping anybody.
    reply(&app, &w, stays, root, "혼자 남아도 그대로예요").await;
    let (faces, count, _) = summary(&app, &w, root).await;
    assert_eq!(faces, vec![stays, left, removed]);
    assert_eq!(count, 3);
}

// ---------------------------------------------------------------------------
// #4887 — 대화에도 보내기
// ---------------------------------------------------------------------------

/// DB 제약. A top-level message cannot carry the flag: the INSERT is refused, and the refusal rolls
/// the whole send back (no row, no `seq`, no outbox). An UPDATE cannot turn it on for a top-level
/// row either. The control — the same send as a reply — is stored with the flag.
///
/// Goes red if `message_also_in_channel_reply_ck` is dropped from migration 162: the first send
/// would then be stored as a top-level message that claims to be in the channel twice. (The API's
/// 400 sits in front of this and is tested over REST; this test is the layer behind it.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_database_refuses_also_in_channel_on_a_top_level_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 1).await;
    let (ws, ch, owner) = (w.ws, w.ch, w.owner);

    let seq_before: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(ch)
            .fetch_one(&su)
            .await
            .unwrap();

    let refused = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            send_message_with_mentions_in_tx(
                conn,
                ws,
                NewMessage::text(ch, owner, "답글이 아닌데 켰어요")
                    .with_client_msg_id(Uuid::new_v4()),
                SendExtras {
                    also_in_channel: true,
                    ..SendExtras::default()
                },
            )
            .await
        })
    })
    .await;
    let error = refused.expect_err("a top-level message cannot be also-in-channel");
    assert!(
        format!("{error} {error:?}").contains("message_also_in_channel_reply_ck"),
        "the database names the rule that refused it: {error}"
    );

    let seq_after: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(ch)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        seq_after, seq_before,
        "the refusal rolled the seq bump back"
    );
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(ch)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(stored, 0, "nothing was stored");
    assert!(
        frames(&su, &w, "message.new").await.is_empty(),
        "nothing was published"
    );

    // Control: the same choice on a reply is accepted and stored.
    let root = root_message(&app, &w, "원글").await;
    let chosen = send_with(
        &app,
        ws,
        reply_input(ch, w.members[0], root, "함께 보내요"),
        true,
    )
    .await;
    assert!(chosen.message.also_in_channel, "a reply may turn it on");

    // And no later UPDATE can set it on a top-level row (the CHECK holds for every statement).
    let update = sqlx::query("UPDATE message SET also_in_channel = true WHERE id = $1")
        .bind(root)
        .execute(&su)
        .await;
    let update_error = update.expect_err("the CHECK refuses an UPDATE on a top-level row too");
    assert!(
        update_error
            .to_string()
            .contains("message_also_in_channel_reply_ck"),
        "{update_error}"
    );
}

/// 기록·스레드·실시간에 값이 실린다. One reply chose 「대화에도 보내기」 and one did not.
/// Every projection says so for the first and says **nothing** for the second (the key is absent,
/// not `false`), the flag survives an edit, and the flagged reply is still **one** reply in the
/// thread's count.
///
/// Goes red if a read statement stops projecting the column (`try_get` fails or answers `false`), if
/// `message.new`/`message.edited` stop carrying it, or if a frame starts writing `false` into
/// every message ever sent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_choice_rides_history_thread_replies_and_the_realtime_frames() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 2).await;
    let (author, other) = (w.members[0], w.members[1]);

    let root = root_message(&app, &w, "공지 하나").await;
    let chosen = send_with(
        &app,
        w.ws,
        reply_input(w.ch, author, root, "채널에도 알려요"),
        true,
    )
    .await;
    let plain = reply(&app, &w, other, root, "스레드에만 둘게요").await;
    assert!(chosen.message.also_in_channel && !plain.message.also_in_channel);

    // 기록 페이지
    let page = history(&app, w.ws, w.ch).await;
    assert!(row_for(&page, chosen.message.id).message.also_in_channel);
    assert!(!row_for(&page, plain.message.id).message.also_in_channel);
    assert!(!row_for(&page, root).message.also_in_channel);

    // 스레드 답글 페이지
    let (ch, ws) = (w.ch, w.ws);
    let thread_page = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { list_thread_replies(conn, ch, root, None, 50).await })
    })
    .await
    .expect("thread replies");
    assert_eq!(thread_page.messages.len(), 2);
    for paged in &thread_page.messages {
        let expected = paged.message.id == chosen.message.id;
        assert_eq!(
            paged.message.also_in_channel, expected,
            "the thread page carries the same choice as the main page"
        );
    }

    // 실시간 message.new: the key only where the choice was made
    let new_frames = frames(&su, &w, "message.new").await;
    let frame_of = |id: Uuid| {
        new_frames
            .iter()
            .find(|frame| frame["id"] == json!(id))
            .expect("every message published a message.new")
    };
    assert_eq!(frame_of(chosen.message.id)["also_in_channel"], json!(true));
    assert!(
        frame_of(chosen.message.id)["root_id"].is_string(),
        "the flag rides beside the root that makes it legal"
    );
    for quiet in [plain.message.id, root] {
        assert!(
            frame_of(quiet).get("also_in_channel").is_none(),
            "a message that did not choose it publishes the bytes it always did: {}",
            frame_of(quiet)
        );
    }

    // 편집: the stored choice survives, and the edit frame says it again.
    let chosen_id = chosen.message.id;
    with_tenant_tx(&app, w.ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, chosen_id, author, "고쳐 쓴 알림")
                .await?
                .expect("the author edits their own reply");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("edit");
    let after = history(&app, w.ws, w.ch).await;
    assert!(
        row_for(&after, chosen_id).message.also_in_channel,
        "an edit does not change the choice"
    );
    let edited = frames(&su, &w, "message.edited").await;
    let edited_frame = edited
        .iter()
        .find(|frame| frame["id"] == json!(chosen_id))
        .expect("the edit published message.edited");
    assert_eq!(
        edited_frame["also_in_channel"],
        json!(true),
        "an edit re-publishes the whole message, so silence would read as 'off'"
    );

    // 한 번만 센다: two replies, two thread.updated frames, the flag adds neither.
    let (_, _, replies) = summary(&app, &w, root).await;
    assert_eq!(replies, 2, "the flagged reply is one reply, not two");
    assert_eq!(frames(&su, &w, "thread.updated").await.len(), 2);
}

/// 멱등 재시도. The same `client_msg_id` sent again — even with the other choice — answers the
/// **stored** message: nothing is published, the count does not move, the sender does not jump to the
/// front of the faces, and the stored flag is the first one in both directions.
///
/// Goes red if the retry re-bumps the rollup (the faces reorder, the count grows), publishes a
/// second frame, or writes the new choice over the stored one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_idempotent_retry_answers_the_stored_choice_and_changes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app, 3).await;
    let (a, b, c) = (w.members[0], w.members[1], w.members[2]);

    let root = root_message(&app, &w, "재시도 시험").await;

    // First send: choice OFF. Then another replier, so a re-bump of A would be visible as a reorder.
    let off = reply_input(w.ch, a, root, "끈 채로");
    let first = send_with(&app, w.ws, off.clone(), false).await;
    assert!(!first.deduped && !first.message.also_in_channel);
    reply(&app, &w, b, root, "B 답").await;

    let frames_before = (
        frames(&su, &w, "message.new").await.len(),
        frames(&su, &w, "thread.updated").await.len(),
    );
    let (faces_before, count_before, replies_before) = summary(&app, &w, root).await;
    assert_eq!(faces_before, vec![b, a]);

    // Retry with the choice ON: the stored (OFF) message comes back.
    let retry = send_with(&app, w.ws, off, true).await;
    assert!(
        retry.deduped,
        "same (channel, author, client_msg_id) is the same message"
    );
    assert_eq!(retry.message.id, first.message.id);
    assert!(
        !retry.message.also_in_channel,
        "the first choice wins over a later one"
    );
    assert!(retry.outbox_id.is_none(), "a retry publishes nothing");

    let (faces, count, replies) = summary(&app, &w, root).await;
    assert_eq!(
        (faces, count, replies),
        (faces_before, count_before, replies_before),
        "a retry does not bump the thread (no reorder, no extra count)"
    );
    assert_eq!(
        (
            frames(&su, &w, "message.new").await.len(),
            frames(&su, &w, "thread.updated").await.len()
        ),
        frames_before,
        "…and publishes no second frame"
    );
    let stored_flag: bool = sqlx::query_scalar("SELECT also_in_channel FROM message WHERE id = $1")
        .bind(first.message.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(!stored_flag, "the stored row is untouched");

    // The other direction: first ON, retried OFF — still ON.
    let on = reply_input(w.ch, c, root, "켠 채로");
    let chosen = send_with(&app, w.ws, on.clone(), true).await;
    assert!(chosen.message.also_in_channel);
    let retry = send_with(&app, w.ws, on, false).await;
    assert!(retry.deduped);
    assert!(
        retry.message.also_in_channel,
        "a retry cannot turn a chosen reply off either"
    );
}
