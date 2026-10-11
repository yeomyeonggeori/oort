//! DB-backed conformance for **인박스 투영 `inbox_item`** — ADR-0199, #3680 (E1).
//!
//! Every test names the revert that turns it red. `#[ignore]`: needs a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime `momo_app` role.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:23802/momo \
//!   cargo test -p momo-messaging --test inbox_projection_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `e1_1_an_agent_quote_reply_on_the_skip_path_reaches_the_quoted_human` | drop `inbox_item_project_insert_trg` (the baseline half proves the mention ledger alone leaves nothing) |
//! | `e1_2_a_read_mention_stays_and_is_marked_read` | drop the update trigger on `props`, or `inbox_item_read_*_trg`, or delete the row on read |
//! | `e1_3_one_message_one_row_per_recipient_with_priority_and_reasons` | drop `UNIQUE (member_id, message_id)`/the merge, or the priority order |
//! | `e1_4_thread_replies_reach_thread_participants_only` | widen the thread scan or drop the author exclusion |
//! | `e1_5_a_dm_message_reaches_the_other_participant` | drop the `dm` arm |
//! | `e1_6_nobody_who_should_not_be_told_is_told` | drop the self / agent / left-member / membership / cross-channel checks |
//! | `e1_7_cursor_reads_one_way_and_never_unreads` | read items from the item side, make the trigger un-read, or ignore `seq <= cursor` |
//! | `e1_8_a_late_mention_below_the_cursor_is_born_read` | drop the `read_state` born-read check |
//! | `e1_9_rls_force_isolates_workspaces` | drop FORCE or the `ws_isolation` policy (the WITH CHECK half is e1_12) |
//! | `e1_10_machinery_rows_make_no_items` | drop the message-type filter |
//! | `e1_11_the_integrity_guards_hold_what_the_fks_cannot` | drop `inbox_item_guard_insert_trg` / `inbox_item_guard_update_trg` |
//! | `e1_12_the_policy_itself_refuses_a_cross_tenant_write` | loosen the policy to `WITH CHECK (true)` (the guard trigger is switched off inside the test so only the policy can refuse) |
//! | `e1_14_a_lower_case_mention_token_still_sends_and_projects` | make the guard's mention check case-sensitive again (the send then fails) |
//! | `e1_13_inactive_and_cross_channel_recipients_are_not_told` | drop `m.status = 'active'` / `m.deleted_at IS NULL` / the thread scans' `channel_id` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, mention_id_token, open_direct_message_in_tx, send_message_in_tx,
    send_message_with_mentions_in_tx, update_read_cursor_in_tx,
    update_read_cursor_with_intent_in_tx, ChannelKind, MarkUnreadWrite, MessageType, NewChannel,
    NewMessage, OpenedDirectMessage, ReadIntent, SendExtras, SentMessage,
};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors quote_reply_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts.username("momo_app").password(&password))
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
        ])
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// seed helpers (superuser)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool) -> Uuid {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    ws
}

async fn seed_member(su: &PgPool, ws: Uuid, handle: &str, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(format!("{handle}{}", &id.to_string()[..4]))
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
         VALUES ($1, $2, 'member'::membership_role) ON CONFLICT DO NOTHING",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    id
}

async fn join(su: &PgPool, ws: Uuid, ch: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) ON CONFLICT DO NOTHING",
    )
    .bind(ws)
    .bind(ch)
    .bind(member)
    .execute(su)
    .await
    .expect("seed membership");
}

async fn channel(app: &PgPool, su: &PgPool, ws: Uuid, name: &str, members: &[Uuid]) -> Uuid {
    let ch = create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("{name}-{}", &Uuid::new_v4().to_string()[..6]),
            topic: None,
            created_by: members[0],
        },
    )
    .await
    .expect("create channel")
    .id;
    for m in members {
        join(su, ws, ch, *m).await;
    }
    ch
}

/// The REST send spine (mentions Recorded).
async fn send(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let outcome =
                send_message_with_mentions_in_tx(conn, ws, input, SendExtras::default()).await?;
            Ok::<_, DbError>(outcome.expect("unsigned send"))
        })
    })
    .await
    .expect("send")
}

/// The Skip spine: agent final replies, cards, gateway completions.
async fn send_skip(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, ws, input).await })
    })
    .await
    .expect("send (skip)")
}

fn quote(ch: Uuid, author: Uuid, body: &str, target: Uuid) -> NewMessage {
    let mut m = NewMessage::text(ch, author, body);
    m.reply_to_id = Some(target);
    m
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct Item {
    member: Uuid,
    kind: String,
    reasons: Vec<String>,
    read: bool,
}

async fn items(su: &PgPool, message_id: Uuid) -> Vec<Item> {
    sqlx::query(
        "SELECT member_id, kind, reasons, read_at IS NOT NULL AS read \
           FROM inbox_item WHERE message_id = $1 ORDER BY member_id",
    )
    .bind(message_id)
    .fetch_all(su)
    .await
    .expect("items")
    .iter()
    .map(|r| Item {
        member: r.get("member_id"),
        kind: r.get("kind"),
        reasons: r.get("reasons"),
        read: r.get("read"),
    })
    .collect()
}

async fn item_for(su: &PgPool, message_id: Uuid, member: Uuid) -> Option<Item> {
    items(su, message_id)
        .await
        .into_iter()
        .find(|i| i.member == member)
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

// ---------------------------------------------------------------------------
// E1-1 — the red proof: Skip-path quote reply
// ---------------------------------------------------------------------------

/// An agent answers a human's message with `reply_to_id` through
/// `send_message_in_tx` (`MentionPolicy::Skip` — agent final reply, cards,
/// gateway completion). The mention ledger records nothing for that send; the
/// projection must still hand the quoted human a `reply_to_me` item.
///
/// The first half is the baseline that makes the second half mean something:
/// with the trigger disabled (one superuser tx, rolled back) the identical send
/// leaves the ledger empty AND no inbox row — the old behavior, #3664's bug.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_1_an_agent_quote_reply_on_the_skip_path_reaches_the_quoted_human() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bot = seed_member(&su, ws, "grokbot", "agent").await;
    let ch = channel(&app, &su, ws, "agent-lab", &[alice, bot]).await;

    let ask = send(&app, ws, NewMessage::text(ch, alice, "이거 봐줘")).await;

    // --- baseline: trigger off, same send, nothing anywhere -----------------
    let mut tx = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE message DISABLE TRIGGER inbox_item_project_insert_trg")
        .execute(&mut *tx)
        .await
        .unwrap();
    let ask_id = ask.message.id;
    let baseline = send_message_in_tx(&mut tx, ws, quote(ch, bot, "baseline", ask_id))
        .await
        .expect("baseline send");
    let ledger: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT props -> 'mention_member_ids' FROM message WHERE id = $1")
            .bind(baseline.message.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE message_id = $1")
        .bind(baseline.message.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(ledger.is_none(), "the Skip path writes no mention ledger");
    assert_eq!(
        rows, 0,
        "without the trigger the quoted human is told nothing"
    );

    // --- the real thing ------------------------------------------------------
    let reply = send_skip(&app, ws, quote(ch, bot, "봤어요, 이렇게 해요", ask_id)).await;
    let ledger: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT props -> 'mention_member_ids' FROM message WHERE id = $1")
            .bind(reply.message.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(ledger.is_none(), "still the Skip path: no mention ledger");
    assert_eq!(
        items(&su, reply.message.id).await,
        vec![Item {
            member: alice,
            kind: "reply_to_me".into(),
            reasons: s(&["reply_to_me"]),
            read: false
        }],
        "the agent's quote reply, written WITHOUT a mention ledger, lands in the quoted human's inbox"
    );
}

// ---------------------------------------------------------------------------
// E1-2 — a read mention stays
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_2_a_read_mention_stays_and_is_marked_read() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob]).await;

    let handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id = $1")
        .bind(alice)
        .fetch_one(&su)
        .await
        .unwrap();
    let m = send(
        &app,
        ws,
        NewMessage::text(ch, bob, format!("@{handle} 확인 부탁해요")),
    )
    .await;

    let item = item_for(&su, m.message.id, alice)
        .await
        .expect("mention item");
    assert_eq!((item.kind.as_str(), item.read), ("mention", false));
    assert_eq!(item.reasons, s(&["mention"]));

    let seq = m.message.seq;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            update_read_cursor_in_tx(conn, ws, ch, alice, seq).await?;
            Ok::<_, DbError>(())
        })
    })
    .await
    .unwrap();

    let item = item_for(&su, m.message.id, alice)
        .await
        .expect("the item survives the cursor passing it (성재 요구 2)");
    assert!(
        item.read,
        "read_at is filled by the cursor, the row is kept"
    );
    let count: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(ch)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "the counter forgets the mention; the inbox does not"
    );
}

// ---------------------------------------------------------------------------
// E1-3 — one row per (message, recipient); priority; reasons
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_3_one_message_one_row_per_recipient_with_priority_and_reasons() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let carol = seed_member(&su, ws, "carol", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob, carol]).await;
    let handle = |id: Uuid| {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT handle FROM member WHERE id = $1")
                .bind(id)
                .fetch_one(&su)
                .await
                .unwrap()
        }
    };

    let root = send(&app, ws, NewMessage::text(ch, alice, "원글")).await;
    let carol_h = handle(carol).await;
    // bob quotes alice's message (quote-only) AND @s alice's handle AND mentions carol,
    // inside alice's thread: alice qualifies as reply_to_me + thread_reply (+ mention is
    // excluded for the quoted author); carol as mention + thread? (carol has not written
    // in the thread -> mention only)
    let alice_h = handle(alice).await;
    let mut input = quote(
        ch,
        bob,
        &format!("@{alice_h} @{carol_h} 같이 봐요"),
        root.message.id,
    );
    input.root_id = Some(root.message.id);
    let m = send(&app, ws, input).await;

    let rows = items(&su, m.message.id).await;
    assert_eq!(
        rows.len(),
        2,
        "exactly one row per recipient, none for the author: {rows:?}"
    );
    let a = rows.iter().find(|i| i.member == alice).unwrap();
    assert_eq!(
        (a.kind.as_str(), a.reasons.clone()),
        ("reply_to_me", s(&["reply_to_me", "thread_reply"])),
        "priority reply_to_me > mention > thread_reply; the quoted author's rule-5 mention is not a second reason"
    );
    let c = rows.iter().find(|i| i.member == carol).unwrap();
    assert_eq!(
        (c.kind.as_str(), c.reasons.clone()),
        ("mention", s(&["mention"]))
    );

    // Re-projecting the same message (a props rewrite with the same ids) must not
    // duplicate or reset anything.
    let before = items(&su, m.message.id).await;
    let mid = m.message.id;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("UPDATE message SET props = jsonb_set(props, '{mention_member_ids}', props->'mention_member_ids' || to_jsonb($2::text)) WHERE id = $1")
                .bind(mid)
                .bind(mention_id_token(carol))
                .execute(&mut *conn)
                .await?;
            Ok::<_, DbError>(())
        })
    })
    .await
    .unwrap();
    assert_eq!(
        items(&su, m.message.id).await,
        before,
        "upsert merge is idempotent"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE message_id = $1")
        .bind(m.message.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

// ---------------------------------------------------------------------------
// E1-4 — threads
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_4_thread_replies_reach_thread_participants_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let carol = seed_member(&su, ws, "carol", "human").await;
    let dave = seed_member(&su, ws, "dave", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob, carol, dave]).await;

    let root = send(&app, ws, NewMessage::text(ch, alice, "루트")).await;
    let mut r1 = NewMessage::text(ch, bob, "bob 답");
    r1.root_id = Some(root.message.id);
    let r1 = send(&app, ws, r1).await;
    assert_eq!(
        items(&su, r1.message.id).await,
        vec![Item {
            member: alice,
            kind: "thread_reply".into(),
            reasons: s(&["thread_reply"]),
            read: false
        }],
        "the root's author is told; the replier is not"
    );

    let mut r2 = NewMessage::text(ch, carol, "carol 답");
    r2.root_id = Some(root.message.id);
    let r2 = send(&app, ws, r2).await;
    let got: Vec<Uuid> = items(&su, r2.message.id)
        .await
        .iter()
        .map(|i| i.member)
        .collect();
    let mut want = vec![alice, bob];
    want.sort();
    assert_eq!(
        got, want,
        "root author + earlier repliers; carol herself and bystander dave are not"
    );
    assert!(item_for(&su, r2.message.id, dave).await.is_none());
}

// ---------------------------------------------------------------------------
// E1-5 — DM
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_5_a_dm_message_reaches_the_other_participant() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;

    let dm = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { open_direct_message_in_tx(conn, ws, alice, bob).await })
    })
    .await
    .unwrap();
    let OpenedDirectMessage::Opened { channel, .. } = dm else {
        panic!("dm opens")
    };
    let m = send(&app, ws, NewMessage::text(channel.id, alice, "안녕")).await;
    assert_eq!(
        items(&su, m.message.id).await,
        vec![Item {
            member: bob,
            kind: "dm".into(),
            reasons: s(&["dm"]),
            read: false
        }]
    );
}

// ---------------------------------------------------------------------------
// E1-6 — exclusions
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_6_nobody_who_should_not_be_told_is_told() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let bot = seed_member(&su, ws, "bot", "agent").await;
    let gone = seed_member(&su, ws, "gone", "human").await;
    let outsider = seed_member(&su, ws, "outsider", "human").await; // not in channel
    let ch = channel(&app, &su, ws, "general", &[alice, bob, bot, gone]).await;
    let other = channel(&app, &su, ws, "other", &[alice, bob]).await;

    // self quote
    let own = send(&app, ws, NewMessage::text(ch, alice, "내 글")).await;
    let own_quote = send_skip(
        &app,
        ws,
        quote(ch, alice, "내가 내 글 인용", own.message.id),
    )
    .await;
    assert!(
        items(&su, own_quote.message.id).await.is_empty(),
        "자기 글 인용은 제외"
    );

    // quoting an agent's message / mentioning an agent: agents have no human inbox
    let bot_msg = send_skip(&app, ws, NewMessage::text(ch, bot, "봇 글")).await;
    let to_bot = send(&app, ws, quote(ch, alice, "봇에게", bot_msg.message.id)).await;
    assert!(
        items(&su, to_bot.message.id).await.is_empty(),
        "에이전트 수신자 제외"
    );

    // a member who left the channel is not told
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(ch)
        .bind(gone)
        .execute(&su)
        .await
        .unwrap();
    let gone_msg = {
        // gone wrote this before leaving: insert directly as superuser seq-safe via send then flip
        sqlx::query(
            "UPDATE membership SET left_at = NULL WHERE channel_id = $1 AND member_id = $2",
        )
        .bind(ch)
        .bind(gone)
        .execute(&su)
        .await
        .unwrap();
        let m = send(&app, ws, NewMessage::text(ch, gone, "나가기 전 글")).await;
        sqlx::query(
            "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
        )
        .bind(ch)
        .bind(gone)
        .execute(&su)
        .await
        .unwrap();
        m
    };
    let to_gone = send(
        &app,
        ws,
        quote(ch, alice, "나간 사람 글 인용", gone_msg.message.id),
    )
    .await;
    assert!(
        items(&su, to_gone.message.id).await.is_empty(),
        "채널을 떠난 사람 제외"
    );

    // a mention token for a non-member of the channel (forged props at INSERT) is not told
    let mut forged = NewMessage::text(ch, alice, "위조 멘션");
    forged.props = json!({ "mention_member_ids": [mention_id_token(outsider), "not-a-uuid", 7] });
    let forged = send_skip(&app, ws, forged).await;
    assert!(
        items(&su, forged.message.id).await.is_empty(),
        "채널 밖 멤버·깨진 토큰은 항목 없음"
    );

    // a quote target in ANOTHER channel names nobody (ADR-0148 rule 2)
    let elsewhere = send(&app, ws, NewMessage::text(other, bob, "다른 채널 글")).await;
    let cross = send_skip(
        &app,
        ws,
        quote(ch, alice, "채널 넘어 인용", elsewhere.message.id),
    )
    .await;
    assert!(
        items(&su, cross.message.id).await.is_empty(),
        "다른 채널 글 인용은 이름을 부르지 않는다"
    );
}

// ---------------------------------------------------------------------------
// E1-7 — cursor reads one way, never un-reads
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_7_cursor_reads_one_way_and_never_unreads() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob]).await;

    let mine = send(&app, ws, NewMessage::text(ch, alice, "내 글")).await;
    let q1 = send(&app, ws, quote(ch, bob, "답 1", mine.message.id)).await;
    let q2 = send(&app, ws, quote(ch, bob, "답 2", mine.message.id)).await;
    assert!(!item_for(&su, q1.message.id, alice).await.unwrap().read);
    assert!(!item_for(&su, q2.message.id, alice).await.unwrap().read);

    let (s1, s2) = (q1.message.seq, q2.message.seq);
    let advance = |seq: i64| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move { update_read_cursor_in_tx(conn, ws, ch, alice, seq).await })
            })
            .await
            .unwrap()
        }
    };
    advance(s1).await;
    assert!(
        item_for(&su, q1.message.id, alice).await.unwrap().read,
        "seq <= cursor is read"
    );
    assert!(
        !item_for(&su, q2.message.id, alice).await.unwrap().read,
        "seq > cursor stays unread"
    );

    let read_at_1: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT read_at FROM inbox_item WHERE message_id = $1 AND member_id = $2",
    )
    .bind(q1.message.id)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    advance(s2).await;
    let read_at_1_after: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT read_at FROM inbox_item WHERE message_id = $1 AND member_id = $2",
    )
    .bind(q1.message.id)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        read_at_1, read_at_1_after,
        "read_at is set once, never rewritten"
    );
    assert!(item_for(&su, q2.message.id, alice).await.unwrap().read);

    // a message committed with a created_at later than this transaction's now()
    // (another transaction started after ours) must not make the cursor trigger fail
    let skewed = send(&app, ws, quote(ch, bob, "시계가 앞선 답", mine.message.id)).await;
    let skewed_seq = skewed.message.seq;
    let skewed_id = skewed.message.id;
    {
        let mut tx = su.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("UPDATE message SET created_at = now() + interval '2 seconds' WHERE id = $1")
            .bind(skewed_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE inbox_item SET created_at = now() + interval '2 seconds' WHERE message_id = $1",
        )
        .bind(skewed_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    advance(skewed_seq).await;
    assert!(
        item_for(&su, skewed_id, alice).await.unwrap().read,
        "read_at = GREATEST(now(), created_at) satisfies the floor"
    );

    // mark-unread (ADR-0178) lowers nothing: items stay read
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            update_read_cursor_with_intent_in_tx(
                conn,
                ws,
                ch,
                alice,
                s2,
                MarkUnreadWrite::Set(s1),
                ReadIntent::Background,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(
        item_for(&su, q1.message.id, alice).await.unwrap().read,
        "mark-unread never flips an item back"
    );

    // the other direction does not exist: reading an item leaves the cursor alone
    let before: i64 = sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(ch)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    let later = send(&app, ws, quote(ch, bob, "답 3", mine.message.id)).await;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE inbox_item SET read_at = now() WHERE message_id = $1 AND member_id = $2",
            )
            .bind(later.message.id)
            .bind(alice)
            .execute(&mut *conn)
            .await?;
            Ok::<_, DbError>(())
        })
    })
    .await
    .unwrap();
    let after: i64 = sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id=$1 AND member_id=$2",
    )
    .bind(ch)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(before, after, "item -> cursor: no such direction");
}

// ---------------------------------------------------------------------------
// E1-8 — a late mention on an already-read message is born read
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_8_a_late_mention_below_the_cursor_is_born_read() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob]).await;

    let m = send(&app, ws, NewMessage::text(ch, bob, "멘션 없음")).await;
    let seq = m.message.seq;
    let mid = m.message.id;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            update_read_cursor_in_tx(conn, ws, ch, alice, seq).await?;
            sqlx::query("UPDATE message SET props = jsonb_set(props, '{mention_member_ids}', to_jsonb($2::text[])) WHERE id = $1")
                .bind(mid)
                .bind(vec![mention_id_token(alice)])
                .execute(&mut *conn)
                .await?;
            Ok::<_, DbError>(())
        })
    })
    .await
    .unwrap();
    let item = item_for(&su, m.message.id, alice)
        .await
        .expect("late mention projects");
    assert!(
        item.read,
        "the cursor is already past it: born read, not stuck unread"
    );
}

// ---------------------------------------------------------------------------
// E1-9 — RLS
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_9_rls_force_isolates_workspaces() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let force: (bool, bool) = {
        let r = sqlx::query(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'inbox_item'",
        )
        .fetch_one(&su)
        .await
        .unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!(force, (true, true), "ENABLE + FORCE");
    let policies: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'inbox_item' AND policyname = 'ws_isolation'")
        .fetch_one(&su).await.unwrap();
    assert_eq!(policies, 1);

    let ws_a = seed_workspace(&su).await;
    let ws_b = seed_workspace(&su).await;
    let alice = seed_member(&su, ws_a, "alice", "human").await;
    let bob = seed_member(&su, ws_a, "bob", "human").await;
    let zed = seed_member(&su, ws_b, "zed", "human").await;
    let ch = channel(&app, &su, ws_a, "general", &[alice, bob]).await;
    let m = send(
        &app,
        ws_a,
        quote(
            ch,
            bob,
            "x",
            send(&app, ws_a, NewMessage::text(ch, alice, "원문"))
                .await
                .message
                .id,
        ),
    )
    .await;
    assert!(item_for(&su, m.message.id, alice).await.is_some());

    // workspace B's tenant context sees nothing of A's rows
    let seen: i64 = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let n: i64 =
                sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE message_id = $1")
                    .bind(m.message.id)
                    .fetch_one(&mut *conn)
                    .await?;
            Ok::<_, DbError>(n)
        })
    })
    .await
    .unwrap();
    assert_eq!(seen, 0, "RLS hides another tenant's items");

    // A's own context sees it
    let seen_a: i64 = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            let n: i64 =
                sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE message_id = $1")
                    .bind(m.message.id)
                    .fetch_one(&mut *conn)
                    .await?;
            Ok::<_, DbError>(n)
        })
    })
    .await
    .unwrap();
    assert_eq!(seen_a, 1);

    // B's context cannot flip A's read_at (UPDATE matches no visible row)
    let flipped = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let r = sqlx::query("UPDATE inbox_item SET read_at = now() WHERE message_id = $1")
                .bind(m.message.id)
                .execute(&mut *conn)
                .await?;
            Ok::<_, DbError>(r.rows_affected())
        })
    })
    .await
    .unwrap();
    assert_eq!(flipped, 0);
    let _ = zed;

    // No tenant context at all: the policy refuses (or hides) every row.
    let bare = sqlx::query("SELECT count(*) FROM inbox_item")
        .fetch_one(&app)
        .await;
    assert!(
        bare.is_err() || bare.unwrap().get::<i64, _>(0) == 0,
        "no app.workspace_id -> no rows"
    );
}

// ---------------------------------------------------------------------------
// E1-10 — machinery rows
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_10_machinery_rows_make_no_items() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bot = seed_member(&su, ws, "bot", "agent").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bot]).await;
    let ask = send(&app, ws, NewMessage::text(ch, alice, "원문")).await;

    for ty in [
        MessageType::ToolCall,
        MessageType::ToolResult,
        MessageType::System,
    ] {
        let mut m = quote(ch, bot, "기계 행", ask.message.id);
        m.message_type = ty;
        let sent = send_skip(&app, ws, m).await;
        assert!(
            items(&su, sent.message.id).await.is_empty(),
            "{ty:?} is machinery"
        );
    }
}

// ---------------------------------------------------------------------------
// E1-11 — integrity guards (security review M1)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_11_the_integrity_guards_hold_what_the_fks_cannot() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws_a = seed_workspace(&su).await;
    let ws_b = seed_workspace(&su).await;
    let alice = seed_member(&su, ws_a, "alice", "human").await;
    let bob = seed_member(&su, ws_a, "bob", "human").await;
    let zed = seed_member(&su, ws_b, "zed", "human").await;
    let ch_a = channel(&app, &su, ws_a, "general", &[alice, bob]).await;
    let ch_b = channel(&app, &su, ws_b, "general", &[zed]).await;
    let theirs = send(&app, ws_b, NewMessage::text(ch_b, zed, "남의 글")).await;
    let ours = send(&app, ws_a, NewMessage::text(ch_a, alice, "내 글")).await;
    let reply = send(&app, ws_a, quote(ch_a, bob, "답", ours.message.id)).await;
    let own_item = item_for(&su, reply.message.id, alice).await.expect("item");
    assert_eq!(own_item.kind, "reply_to_me");

    // (a) a row in workspace A that points at workspace B's channel/message is refused,
    // and a made-up message id is refused with the SAME error (no existence oracle).
    let attempt = |msg: Uuid, ch: Uuid| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, ws_a, move |conn| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO inbox_item (workspace_id, member_id, kind, reasons, channel_id, \
                         message_id, seq, actor_member_id, created_at) \
                         VALUES ($1, $2, 'dm', ARRAY['dm'], $3, $4, 1, $5, now())",
                    )
                    .bind(ws_a).bind(alice).bind(ch).bind(msg).bind(bob)
                    .execute(&mut *conn).await?;
                    Ok::<_, DbError>(())
                })
            })
            .await
        }
    };
    let foreign = attempt(theirs.message.id, ch_b)
        .await
        .expect_err("foreign refused");
    let made_up = attempt(Uuid::new_v4(), ch_a)
        .await
        .expect_err("made-up refused");
    let code = |e: &DbError| match e {
        DbError::Sqlx(sqlx::Error::Database(d)) => d.code().map(|c| c.to_string()),
        _ => None,
    };
    assert_eq!(code(&foreign), Some("23514".into()), "{foreign:?}");
    assert_eq!(
        code(&foreign),
        code(&made_up),
        "foreign and made-up ids look the same"
    );

    // (b) a direct UPDATE may only fill read_at; it cannot retarget or rewrite a row.
    for set in [
        "member_id = actor_member_id",
        "channel_id = (SELECT id FROM channel WHERE id <> inbox_item.channel_id LIMIT 1)",
        "actor_member_id = member_id",
        "created_at = created_at - interval '1 day'",
        "reasons = ARRAY['dm']",
        "message_id = (SELECT id FROM message WHERE id <> inbox_item.message_id LIMIT 1)",
        "seq = seq + 1",
    ] {
        let item_id = {
            let r = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM inbox_item WHERE message_id = $1 AND member_id = $2",
            )
            .bind(reply.message.id)
            .bind(alice)
            .fetch_one(&su)
            .await
            .unwrap();
            r
        };
        let res = with_tenant_tx(&app, ws_a, move |conn| {
            let sql = format!("UPDATE inbox_item SET {set} WHERE id = $1");
            Box::pin(async move {
                sqlx::query(&sql).bind(item_id).execute(&mut *conn).await?;
                Ok::<_, DbError>(())
            })
        })
        .await;
        assert!(res.is_err(), "direct UPDATE of `{set}` must be refused");
    }
    // read_at: NULL -> ts is fine, ts -> NULL / another ts is not.
    let item_id: Uuid =
        sqlx::query_scalar("SELECT id FROM inbox_item WHERE message_id = $1 AND member_id = $2")
            .bind(reply.message.id)
            .bind(alice)
            .fetch_one(&su)
            .await
            .unwrap();
    with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            sqlx::query("UPDATE inbox_item SET read_at = now() WHERE id = $1")
                .bind(item_id)
                .execute(&mut *conn)
                .await?;
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("NULL -> timestamp is the one legal direct update");
    for sql in [
        "UPDATE inbox_item SET read_at = NULL WHERE id = $1",
        "UPDATE inbox_item SET read_at = now() + interval '1 day' WHERE id = $1",
    ] {
        let res = with_tenant_tx(&app, ws_a, move |conn| {
            Box::pin(async move {
                sqlx::query(sql).bind(item_id).execute(&mut *conn).await?;
                Ok::<_, DbError>(())
            })
        })
        .await;
        assert!(res.is_err(), "read_at is monotone: `{sql}`");
    }

    // (c) the guard decides on the row, not on how deep the trigger stack is: a
    // caller-made TEMP trigger that rewrites a row from inside must fail too.
    let other_msg = theirs.message.id;
    let item_id2: Uuid =
        sqlx::query_scalar("SELECT id FROM inbox_item WHERE message_id = $1 AND member_id = $2")
            .bind(reply.message.id)
            .bind(alice)
            .fetch_one(&su)
            .await
            .unwrap();
    let evil = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            sqlx::query("CREATE TEMP TABLE kick (x int) ON COMMIT DROP").execute(&mut *conn).await?;
            sqlx::query(&format!(
                "CREATE FUNCTION pg_temp.evil() RETURNS trigger AS $f$ BEGIN \
                   UPDATE inbox_item SET message_id = '{other_msg}', channel_id = '{ch_b}' WHERE id = '{item_id2}'; \
                   RETURN NEW; END $f$ LANGUAGE plpgsql"
            ))
            .execute(&mut *conn).await?;
            sqlx::query("CREATE TRIGGER evil AFTER INSERT ON kick FOR EACH ROW EXECUTE FUNCTION pg_temp.evil()")
                .execute(&mut *conn).await?;
            sqlx::query("INSERT INTO kick VALUES (1)").execute(&mut *conn).await?;
            Ok::<_, DbError>(())
        })
    })
    .await;
    assert!(
        evil.is_err(),
        "a TEMP-trigger UPDATE must not retarget a row across tenants"
    );

    // (d) a direct INSERT cannot invent the content of a row either.
    let carol = seed_member(&su, ws_a, "carol", "human").await; // not in the channel
    let forged = |member: Uuid, actor: Uuid, seq: i64| {
        let app = app.clone();
        let mid = reply.message.id;
        async move {
            with_tenant_tx(&app, ws_a, move |conn| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO inbox_item (workspace_id, member_id, kind, reasons, channel_id, \
                         message_id, seq, actor_member_id, created_at) \
                         SELECT $1, $2, 'dm', ARRAY['dm'], channel_id, id, $4, $3, created_at \
                           FROM message WHERE id = $5",
                    )
                    .bind(ws_a).bind(member).bind(actor).bind(seq).bind(mid)
                    .execute(&mut *conn).await?;
                    Ok::<_, DbError>(())
                })
            })
            .await
        }
    };
    assert!(
        forged(carol, bob, reply.message.seq).await.is_err(),
        "a non-member recipient"
    );
    assert!(
        forged(alice, alice, reply.message.seq).await.is_err(),
        "a made-up actor"
    );
    assert!(forged(alice, bob, 999).await.is_err(), "a made-up seq");
    // The legit shape except for its claims, on a message alice has no row for yet:
    // 'dm' in a public channel, a kind that is not the best reason, a 1970 stamp.
    let fresh = send(&app, ws_a, NewMessage::text(ch_a, bob, "아무 관련 없는 글")).await;
    let claim_fresh = |reasons: &'static str, kind: &'static str, read_at: &'static str| {
        let app = app.clone();
        let mid = fresh.message.id;
        async move {
            with_tenant_tx(&app, ws_a, move |conn| {
                Box::pin(async move {
                    sqlx::query(&format!(
                        "INSERT INTO inbox_item (workspace_id, member_id, kind, reasons, channel_id, \\
                         message_id, seq, actor_member_id, created_at, read_at) \\
                         SELECT $1, $2, '{kind}', {reasons}, channel_id, id, seq, author_member_id, created_at, {read_at} \\
                           FROM message WHERE id = $3"
                    ))
                    .bind(ws_a).bind(alice).bind(mid)
                    .execute(&mut *conn).await?;
                    Ok::<_, DbError>(())
                })
            })
            .await
        }
    };
    for (reasons, kind, read_at, why) in [
        ("ARRAY['dm']", "dm", "NULL", "'dm' in a public channel"),
        (
            "ARRAY['mention']",
            "mention",
            "NULL",
            "a mention the message never recorded",
        ),
        (
            "ARRAY['reply_to_me']",
            "reply_to_me",
            "NULL",
            "a quote that quotes nobody of hers",
        ),
        (
            "ARRAY['thread_reply']",
            "thread_reply",
            "NULL",
            "a thread reply that is not in a thread",
        ),
        (
            "ARRAY['thread_reply','dm']",
            "dm",
            "NULL",
            "a kind that is not the best reason",
        ),
        (
            "ARRAY['dm']",
            "dm",
            "'1970-01-01'::timestamptz",
            "a pre-read stamp from 1970",
        ),
    ] {
        assert!(claim_fresh(reasons, kind, read_at).await.is_err(), "{why}");
    }
}

// ---------------------------------------------------------------------------
// E1-12 — the policy's WITH CHECK, on its own
// ---------------------------------------------------------------------------

/// e1_9 cannot prove WITH CHECK because the guard trigger refuses first. Here the
/// guard is switched off for one superuser transaction (rolled back) and the
/// insert is made as `momo_app` with another tenant's GUC: only the policy is left.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_12_the_policy_itself_refuses_a_cross_tenant_write() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws_a = seed_workspace(&su).await;
    let ws_b = seed_workspace(&su).await;
    let alice = seed_member(&su, ws_a, "alice", "human").await;
    let bob = seed_member(&su, ws_a, "bob", "human").await;
    let ch = channel(&app, &su, ws_a, "general", &[alice, bob]).await;
    let m = send(&app, ws_a, NewMessage::text(ch, bob, "x")).await;

    let mut tx = su.begin().await.unwrap();
    sqlx::query("ALTER TABLE inbox_item DISABLE TRIGGER inbox_item_guard_insert_trg")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE momo_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(ws_b.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // stamped with A while the session says B: WITH CHECK is the only thing left
    let res = sqlx::query(
        "INSERT INTO inbox_item (workspace_id, member_id, kind, reasons, channel_id, message_id, seq, actor_member_id, created_at) \
         VALUES ($1, $2, 'dm', ARRAY['dm'], $3, $4, 1, $5, now())",
    )
    .bind(ws_a).bind(alice).bind(ch).bind(m.message.id).bind(bob)
    .execute(&mut *tx).await;
    let err = res.expect_err("WITH CHECK refuses");
    let state = match &err {
        sqlx::Error::Database(d) => d.code().map(|c| c.to_string()),
        _ => None,
    };
    assert_eq!(
        state.as_deref(),
        Some("42501"),
        "RLS violation, not a constraint: {err:?}"
    );
    tx.rollback().await.unwrap();
}

// ---------------------------------------------------------------------------
// E1-13 — recipients that must not be told (security review L1/L2)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_13_inactive_and_cross_channel_recipients_are_not_told() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let sleepy = seed_member(&su, ws, "sleepy", "human").await;
    let removed = seed_member(&su, ws, "removed", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob, sleepy, removed]).await;
    let other = channel(&app, &su, ws, "other", &[alice, bob]).await;

    // quoted authors who are suspended / soft-deleted are not told
    let s_msg = send(&app, ws, NewMessage::text(ch, sleepy, "자는 사람 글")).await;
    let r_msg = send(&app, ws, NewMessage::text(ch, removed, "지워질 사람 글")).await;
    sqlx::query("UPDATE member SET status = 'suspended'::member_status WHERE id = $1")
        .bind(sleepy)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(removed)
        .execute(&su)
        .await
        .unwrap();
    let q1 = send(
        &app,
        ws,
        quote(ch, alice, "정지된 사람에게", s_msg.message.id),
    )
    .await;
    let q2 = send(
        &app,
        ws,
        quote(ch, alice, "삭제된 사람에게", r_msg.message.id),
    )
    .await;
    assert!(
        items(&su, q1.message.id).await.is_empty(),
        "suspended member is not told"
    );
    assert!(
        items(&su, q2.message.id).await.is_empty(),
        "soft-deleted member is not told"
    );

    // a thread root in ANOTHER channel pulls nobody in (root_id stays in the channel)
    let foreign_root = send(&app, ws, NewMessage::text(other, bob, "다른 채널 루트")).await;
    let mut crossing = NewMessage::text(ch, alice, "채널 넘는 스레드 답");
    crossing.root_id = Some(foreign_root.message.id);
    let crossing = send_skip(&app, ws, crossing).await;
    assert!(
        items(&su, crossing.message.id).await.is_empty(),
        "root_id from another channel names nobody"
    );
}

// ---------------------------------------------------------------------------
// E1-14 — the guard is no stricter than the projection (security review, 4th pass)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn e1_14_a_lower_case_mention_token_still_sends_and_projects() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let ws = seed_workspace(&su).await;
    let alice = seed_member(&su, ws, "alice", "human").await;
    let bob = seed_member(&su, ws, "bob", "human").await;
    let ch = channel(&app, &su, ws, "general", &[alice, bob]).await;
    // the projection accepts any-case uuid tokens; the guard must agree, or a
    // producer that writes lower case would lose the whole message send
    let mut m = NewMessage::text(ch, bob, "소문자 토큰");
    m.props = json!({ "mention_member_ids": [alice.to_string().to_lowercase()] });
    let sent = send_skip(&app, ws, m).await;
    assert_eq!(
        items(&su, sent.message.id).await,
        vec![Item {
            member: alice,
            kind: "mention".into(),
            reasons: s(&["mention"]),
            read: false
        }]
    );
}
