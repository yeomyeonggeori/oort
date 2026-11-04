//! DB-backed conformance for **스레드 따라가기** — ADR-0206 증보 1 (#4889), migration 164.
//!
//! Every test proves one rule with a **named assertion that goes red if the rule is reverted**
//! (the sabotage that turns each one red is in the doc comment above it), and all are `#[ignore]`
//! because they need a `pgvector/pgvector:pg18` superuser DB plus the runtime `momo_app` role:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26914/postgres \
//!   cargo test -p momo-messaging --test thread_follow_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (identical to `quote_reply_conformance_pg.rs`): `DATABASE_URL` is a
//! **superuser** that applies the migrations and seeds fixtures past RLS; every call under test runs
//! as `momo_app` (`NOBYPASSRLS`), the only faithful way to exercise the policy. Two tenants are used
//! wherever isolation matters.
//!
//! ## What the three automatic paths are (F2)
//!
//! A reply counted by the thread (`ThreadPolicy::Maintain`) follows: the **replier**, the **root's
//! author**, and whoever the reply's or the root's **recorded mentions** name. Mentions are recorded
//! on the REST path only, so the paths are exercised through `send_message_with_mentions_in_tx` (the
//! REST spine) and — for the agent worker's spine — `send_thread_notice_in_tx`.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, delete_message_in_tx, is_following_thread_in_tx, send_message_in_tx,
    send_message_with_mentions_in_tx, send_thread_notice_in_tx, set_thread_follow_in_tx,
    ChannelKind, FollowRefused, NewChannel, NewMessage, SendExtras, SentMessage, ThreadRootInvalid,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on a pgvector/pg18 DB");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// seed helpers (superuser -> past RLS)
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

async fn seed_human(su: &PgPool, ws: Uuid, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
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
    .expect("seed human");
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

async fn seed_agent(su: &PgPool, ws: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, $3, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
            owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role) ON CONFLICT DO NOTHING",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    id
}

async fn join(su: &PgPool, ws: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(ws)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

/// A public channel through the production path, with every listed member joined.
async fn public_channel(
    app: &PgPool,
    su: &PgPool,
    ws: Uuid,
    owner: Uuid,
    members: &[Uuid],
) -> Uuid {
    let channel = create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("ch-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    for member in members {
        join(su, ws, channel, *member).await;
    }
    channel
}

/// A DM channel (kind `dm`, a unique `dm_key`) with its `channel_seq` row.
async fn dm_channel(su: &PgPool, ws: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, dm_key, created_by) \
         VALUES ($1, $2, 'dm', $3, $4)",
    )
    .bind(channel)
    .bind(ws)
    .bind(format!("t4889-{channel}"))
    .bind(members[0])
    .execute(su)
    .await
    .expect("seed dm channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed dm channel_seq");
    for member in members {
        join(su, ws, channel, *member).await;
    }
    channel
}

fn text(channel: Uuid, author: Uuid, body: &str) -> NewMessage {
    let mut input = NewMessage::text(channel, author, body);
    input.client_msg_id = Some(Uuid::new_v4());
    input
}

fn reply(channel: Uuid, author: Uuid, root: Uuid, body: &str) -> NewMessage {
    let mut input = text(channel, author, body);
    input.root_id = Some(root);
    input
}

/// The REST send path's spine: records mentions and maintains the thread rollup.
async fn rest_send(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let outcome =
                send_message_with_mentions_in_tx(conn, ws, input, SendExtras::default()).await?;
            Ok::<_, DbError>(outcome.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("rest send")
}

/// The agent worker's / gateway's spine: counts a reply in the thread, records no mention.
async fn thread_notice(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { send_thread_notice_in_tx(conn, ws, input).await })
    })
    .await
    .expect("thread notice send")
}

/// The raw spine the notifier writes its lines through: the thread rollup is NOT maintained.
async fn raw_send(app: &PgPool, ws: Uuid, input: NewMessage) -> SentMessage {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, ws, input).await })
    })
    .await
    .expect("raw send")
}

async fn set_follow(
    app: &PgPool,
    ws: Uuid,
    channel: Uuid,
    root: Uuid,
    member: Uuid,
    follow: bool,
) -> Result<bool, FollowRefused> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(
            async move { set_thread_follow_in_tx(conn, ws, channel, root, member, follow).await },
        )
    })
    .await
    .expect("set follow")
}

async fn following(app: &PgPool, ws: Uuid, root: Uuid, member: Uuid) -> bool {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { is_following_thread_in_tx(conn, ws, root, member).await })
    })
    .await
    .expect("read following")
}

/// `thread_follow.state` for one (root, member), read past RLS.
async fn state_of(su: &PgPool, root: Uuid, member: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT state FROM thread_follow WHERE root_id = $1 AND member_id = $2")
        .bind(root)
        .bind(member)
        .fetch_optional(su)
        .await
        .expect("read state")
}

async fn rows_of(su: &PgPool, root: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM thread_follow WHERE root_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .expect("count rows")
}

// ---------------------------------------------------------------------------
// T-1 — the three automatic paths, and who is NOT followed
// ---------------------------------------------------------------------------

/// The replier, the root's author, the people the reply names and the people the **root** names
/// follow as `auto`; a bystander does not.
///
/// Red if the one call in `finish_send_in_tx` is removed (every row below vanishes), if the root's
/// author is left out of the candidates (alice), if the reply's mentions are dropped (carol), or if
/// the root's recorded mentions are dropped (dave).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t1_a_reply_makes_the_replier_the_root_author_and_the_named_follow_the_thread() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice1").await; // root author
    let bob = seed_human(&su, ws, "bob1").await; // replier
    let carol = seed_human(&su, ws, "carol1").await; // named in bob's reply
    let dave = seed_human(&su, ws, "dave1").await; // named in alice's root
    let erin = seed_human(&su, ws, "erin1").await; // bystander in the channel
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob, carol, dave, erin]).await;

    let root = rest_send(&app, ws, text(channel, alice, "@dave1 배포 확인 부탁해요")).await;
    assert_eq!(
        rows_of(&su, root.message.id).await,
        0,
        "a root with no reply is not a thread yet: no row is made for it"
    );

    let first = rest_send(
        &app,
        ws,
        reply(channel, bob, root.message.id, "@carol1 이것 좀 봐 줘요"),
    )
    .await;
    assert!(!first.deduped);
    let root_id = root.message.id;

    for (who, name) in [
        (alice, "alice (the root's author)"),
        (bob, "bob (the replier)"),
        (carol, "carol (named in the reply)"),
        (dave, "dave (named in the root)"),
    ] {
        assert_eq!(
            state_of(&su, root_id, who).await.as_deref(),
            Some("auto"),
            "{name} follows the thread automatically"
        );
        assert!(
            following(&app, ws, root_id, who).await,
            "{name} reads as following"
        );
    }
    assert_eq!(
        state_of(&su, root_id, erin).await,
        None,
        "a bystander is not followed in"
    );
    assert_eq!(
        rows_of(&su, root_id).await,
        4,
        "exactly the four named above"
    );

    // Two more replies from the same people add nothing and change nothing.
    rest_send(&app, ws, reply(channel, alice, root_id, "확인했어요")).await;
    rest_send(&app, ws, reply(channel, bob, root_id, "고마워요")).await;
    assert_eq!(rows_of(&su, root_id).await, 4);
}

/// An agent's reply is not a follow of the agent — but it is a reply the thread counts, so the root's
/// author follows; and the `@` in a line the agent worker writes records no mention, so it follows
/// nobody. (The meaning a mention has today: recorded on the REST path only.)
///
/// Red if agents are admitted (`kind = 'human'` removed from the candidate join), or if the root's
/// author is only enrolled by a human reply.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t1b_an_agents_first_reply_follows_for_the_root_author_but_never_for_the_agent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice2").await;
    let bob = seed_human(&su, ws, "bob2").await;
    let agent = seed_agent(&su, ws, alice, "helper2").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob, agent]).await;

    let root = rest_send(&app, ws, text(channel, alice, "에이전트에게 물어볼게요")).await;
    thread_notice(
        &app,
        ws,
        reply(channel, agent, root.message.id, "@bob2 도 봐 주세요"),
    )
    .await;

    assert_eq!(
        state_of(&su, root.message.id, alice).await.as_deref(),
        Some("auto"),
        "the root's author follows the thread an agent answered in"
    );
    assert_eq!(
        state_of(&su, root.message.id, agent).await,
        None,
        "an agent never follows: the push audience is human members only"
    );
    assert_eq!(
        state_of(&su, root.message.id, bob).await,
        None,
        "the agent worker's spine records no mention, so its @ follows nobody"
    );
}

/// What writes **nothing**: the raw spine (`ThreadPolicy::Skip`, which is what the notifier's lines
/// use), a DM channel, a member who left the channel, and a top-level message.
///
/// Red if the call stops being gated on `ThreadPolicy::Maintain` (the raw spine would write — and
/// `momo_notifier`, which has no grant on this table, would die with `permission denied`), if the DM
/// predicate is dropped, or if `left_at IS NULL` is dropped from the membership join (the root's
/// author and the root-named person below are the candidates that predicate alone keeps out).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t1c_the_raw_spine_a_dm_a_left_member_and_a_top_level_message_write_no_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice3").await;
    let bob = seed_human(&su, ws, "bob3").await;
    let dave = seed_human(&su, ws, "dave3").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob, dave]).await;

    // the raw spine: a reply in a thread, but the rollup is not maintained → no follow
    let raw_root = rest_send(&app, ws, text(channel, alice, "원문 A")).await;
    raw_send(
        &app,
        ws,
        reply(channel, bob, raw_root.message.id, "raw 답글"),
    )
    .await;
    assert_eq!(
        rows_of(&su, raw_root.message.id).await,
        0,
        "ThreadPolicy::Skip lines (the notifier's) never follow"
    );

    // a DM: every message already notifies as `dm`
    let dm = dm_channel(&su, ws, &[alice, bob]).await;
    let dm_root = rest_send(&app, ws, text(dm, alice, "DM 원문")).await;
    rest_send(
        &app,
        ws,
        reply(dm, bob, dm_root.message.id, "DM 스레드 답글"),
    )
    .await;
    assert_eq!(
        rows_of(&su, dm_root.message.id).await,
        0,
        "a DM thread is not followed"
    );

    // members who left: the root's author and a person the root named are both candidates of
    // the next reply, but neither is in the channel any more — so neither is followed in. (A
    // mention in the *reply* cannot reach this predicate: the mention pass only names members who
    // are still in the channel. The root's author and the root's recorded mentions can.)
    let left_root = rest_send(&app, ws, text(channel, alice, "@dave3 원문 B")).await;
    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE channel_id = $1 AND member_id = ANY($2)",
    )
    .bind(channel)
    .bind([alice, dave].to_vec())
    .execute(&su)
    .await
    .expect("alice and dave leave");
    rest_send(
        &app,
        ws,
        reply(channel, bob, left_root.message.id, "나간 사람들 몫의 답글"),
    )
    .await;
    assert_eq!(
        state_of(&su, left_root.message.id, alice).await,
        None,
        "the root's author left the channel: not followed in"
    );
    assert_eq!(
        state_of(&su, left_root.message.id, dave).await,
        None,
        "a person the root named left the channel: not followed in"
    );
    assert_eq!(
        state_of(&su, left_root.message.id, bob).await.as_deref(),
        Some("auto"),
        "control: the replier of the same message does follow"
    );

    // a top-level message is not a reply: no thread, no row
    let top = rest_send(&app, ws, text(channel, bob, "@dave3 최상위 글")).await;
    assert_eq!(rows_of(&su, top.message.id).await, 0);
}

// ---------------------------------------------------------------------------
// T-2 — direct follow, stop following, and the merge table
// ---------------------------------------------------------------------------

/// The merge table of F1, cell by cell, plus idempotence (a write that changes nothing leaves the
/// row — and its `updated_at` — alone).
///
/// Red if the direct write is `DO NOTHING` (an `auto`/`unfollowed` row would never become
/// `followed`), or if the `IS DISTINCT FROM` guard is dropped (the no-op rewrites `updated_at`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t2_direct_follow_and_stop_follow_walk_the_merge_table() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice4").await;
    let bob = seed_human(&su, ws, "bob4").await;
    let carol = seed_human(&su, ws, "carol4").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob, carol]).await;
    let root = rest_send(&app, ws, text(channel, alice, "스레드 원문")).await;
    let root_id = root.message.id;

    // no row → follow → `followed`
    assert_eq!(
        set_follow(&app, ws, channel, root_id, carol, true).await,
        Ok(true)
    );
    assert_eq!(
        state_of(&su, root_id, carol).await.as_deref(),
        Some("followed")
    );
    assert!(following(&app, ws, root_id, carol).await);

    // idempotent: the second PUT leaves the row byte-for-byte alone
    let before: (String, String) = sqlx::query_as(
        "SELECT created_at::text, updated_at::text FROM thread_follow \
          WHERE root_id = $1 AND member_id = $2",
    )
    .bind(root_id)
    .bind(carol)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        set_follow(&app, ws, channel, root_id, carol, true).await,
        Ok(true)
    );
    let after: (String, String) = sqlx::query_as(
        "SELECT created_at::text, updated_at::text FROM thread_follow \
          WHERE root_id = $1 AND member_id = $2",
    )
    .bind(root_id)
    .bind(carol)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "a repeated follow changes nothing, `updated_at` included"
    );

    // `auto` (alice: root's author, made by bob's reply) → follow → `followed`
    rest_send(&app, ws, reply(channel, bob, root_id, "첫 답글")).await;
    assert_eq!(state_of(&su, root_id, alice).await.as_deref(), Some("auto"));
    assert_eq!(
        set_follow(&app, ws, channel, root_id, alice, true).await,
        Ok(true)
    );
    assert_eq!(
        state_of(&su, root_id, alice).await.as_deref(),
        Some("followed")
    );

    // stop following: from `followed`, from `auto`, and from no row at all
    assert_eq!(
        set_follow(&app, ws, channel, root_id, alice, false).await,
        Ok(false)
    );
    assert_eq!(
        state_of(&su, root_id, alice).await.as_deref(),
        Some("unfollowed")
    );
    assert!(!following(&app, ws, root_id, alice).await);
    assert_eq!(
        set_follow(&app, ws, channel, root_id, bob, false).await,
        Ok(false)
    );
    assert_eq!(
        state_of(&su, root_id, bob).await.as_deref(),
        Some("unfollowed"),
        "bob's `auto` row (from his reply) is overwritten by his explicit choice"
    );
    let fresh = seed_human(&su, ws, "fresh4").await;
    join(&su, ws, channel, fresh).await;
    assert_eq!(
        set_follow(&app, ws, channel, root_id, fresh, false).await,
        Ok(false)
    );
    assert_eq!(
        state_of(&su, root_id, fresh).await.as_deref(),
        Some("unfollowed"),
        "stopping with no row records the choice, so no later automatic path can follow"
    );
    // idempotent from `unfollowed`
    assert_eq!(
        set_follow(&app, ws, channel, root_id, fresh, false).await,
        Ok(false)
    );

    // `unfollowed` → follow → `followed`: the only way back
    assert_eq!(
        set_follow(&app, ws, channel, root_id, alice, true).await,
        Ok(true)
    );
    assert_eq!(
        state_of(&su, root_id, alice).await.as_deref(),
        Some("followed")
    );
}

// ---------------------------------------------------------------------------
// T-3 — what a person turned off stays off
// ---------------------------------------------------------------------------

/// After 「그만 따라가기」 none of the three automatic paths brings the person back: not their own new
/// reply, not a new mention, not the root's-author rule (somebody else replying to their root). And
/// once they follow directly, the automatic paths do not downgrade the row to `auto`.
///
/// Red if the automatic write is `DO UPDATE SET state = 'auto'` instead of `DO NOTHING` — the
/// 「그만 따라감 존중」 sabotage of #4889. Each of the three assertions then fails by itself.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t3_unfollowed_is_sticky_against_all_three_automatic_paths() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice5").await; // root author
    let bob = seed_human(&su, ws, "bob5").await;
    let carol = seed_human(&su, ws, "carol5").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob, carol]).await;
    let root = rest_send(&app, ws, text(channel, alice, "원문")).await;
    let root_id = root.message.id;
    rest_send(&app, ws, reply(channel, bob, root_id, "먼저 답글")).await;
    assert_eq!(state_of(&su, root_id, alice).await.as_deref(), Some("auto"));
    assert_eq!(state_of(&su, root_id, bob).await.as_deref(), Some("auto"));

    // alice (root author) and bob (replier) both stop following
    assert_eq!(
        set_follow(&app, ws, channel, root_id, alice, false).await,
        Ok(false)
    );
    assert_eq!(
        set_follow(&app, ws, channel, root_id, bob, false).await,
        Ok(false)
    );

    // path 1 — the replier: bob replies again
    rest_send(&app, ws, reply(channel, bob, root_id, "또 답글")).await;
    assert_eq!(
        state_of(&su, root_id, bob).await.as_deref(),
        Some("unfollowed"),
        "replying again does not re-follow"
    );
    // path 2 — the root's author: carol replies to alice's root
    rest_send(&app, ws, reply(channel, carol, root_id, "다른 사람의 답글")).await;
    assert_eq!(
        state_of(&su, root_id, alice).await.as_deref(),
        Some("unfollowed"),
        "being the root's author does not re-follow"
    );
    // path 3 — mentions, in a reply and by the author themself
    rest_send(
        &app,
        ws,
        reply(channel, carol, root_id, "@alice5 @bob5 둘 다 봐 주세요"),
    )
    .await;
    rest_send(
        &app,
        ws,
        reply(channel, alice, root_id, "내가 다시 말해요 @bob5"),
    )
    .await;
    for (who, name) in [(alice, "alice"), (bob, "bob")] {
        assert_eq!(
            state_of(&su, root_id, who).await.as_deref(),
            Some("unfollowed"),
            "{name}: a mention or a reply of their own does not re-follow"
        );
        assert!(!following(&app, ws, root_id, who).await);
    }

    // the explicit way back, and the automatic paths never downgrade it
    assert_eq!(
        set_follow(&app, ws, channel, root_id, alice, true).await,
        Ok(true)
    );
    rest_send(&app, ws, reply(channel, carol, root_id, "@alice5 한 번 더")).await;
    assert_eq!(
        state_of(&su, root_id, alice).await.as_deref(),
        Some("followed"),
        "a direct follow is not rewritten to `auto`"
    );
}

/// The merge table holds under a race: an automatic follow and an explicit unfollow of the same
/// person serialise on the unique key and end `unfollowed`, in **either** order (ADR 증보 1 F1).
///
/// Order 1: bob's reply (which follows him) is still uncommitted when his unfollow arrives — the
/// unfollow waits on the key, then overwrites `auto`. Order 2: his unfollow is uncommitted when his
/// reply arrives — the automatic write waits, then does nothing. Each leg first proves the second
/// writer really is blocked (it has not finished while the first holds its transaction open), so the
/// assertion is about a real interleaving and not about two sequential calls.
///
/// Red (order 2) if the automatic write is `DO UPDATE SET state = 'auto'`: it would flip the committed
/// `unfollowed` back as soon as the unfollow commits.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t3b_a_concurrent_automatic_follow_and_an_unfollow_end_unfollowed_in_either_order() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice5b").await;
    let bob = seed_human(&su, ws, "bob5b").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob]).await;
    let blocked_for = std::time::Duration::from_millis(600);

    // ---- order 1: the automatic follow is uncommitted when the unfollow arrives
    let root1 = rest_send(&app, ws, text(channel, alice, "원문 1"))
        .await
        .message
        .id;
    let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let holder = {
        let app = app.clone();
        tokio::spawn(async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    let input = reply(channel, bob, root1, "답글 (커밋 전)");
                    send_message_with_mentions_in_tx(conn, ws, input, SendExtras::default())
                        .await?
                        .expect("an unsigned send is never a provenance rejection");
                    let _ = held_tx.send(());
                    let _ = release_rx.await;
                    Ok::<_, DbError>(())
                })
            })
            .await
        })
    };
    held_rx
        .await
        .expect("the reply's follow row exists, uncommitted");
    let unfollow = {
        let app = app.clone();
        tokio::spawn(async move { set_follow(&app, ws, channel, root1, bob, false).await })
    };
    tokio::time::sleep(blocked_for).await;
    assert!(
        !unfollow.is_finished(),
        "the unfollow waits on the key the uncommitted automatic write holds"
    );
    assert_eq!(
        state_of(&su, root1, bob).await,
        None,
        "nothing of the held transaction is visible yet"
    );
    release_tx.send(()).expect("release the holder");
    holder
        .await
        .expect("holder task")
        .expect("the held reply commits");
    assert_eq!(unfollow.await.expect("unfollow task"), Ok(false));
    assert_eq!(
        state_of(&su, root1, bob).await.as_deref(),
        Some("unfollowed"),
        "order 1: the unfollow lands after the automatic follow and wins"
    );

    // ---- order 2: the unfollow is uncommitted when the automatic follow arrives
    let root2 = rest_send(&app, ws, text(channel, alice, "원문 2"))
        .await
        .message
        .id;
    let (held2_tx, held2_rx) = tokio::sync::oneshot::channel::<()>();
    let (release2_tx, release2_rx) = tokio::sync::oneshot::channel::<()>();
    let holder2 = {
        let app = app.clone();
        tokio::spawn(async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    set_thread_follow_in_tx(conn, ws, channel, root2, bob, false)
                        .await?
                        .expect("a member may stop following");
                    let _ = held2_tx.send(());
                    let _ = release2_rx.await;
                    Ok::<_, DbError>(())
                })
            })
            .await
        })
    };
    held2_rx
        .await
        .expect("the unfollow row exists, uncommitted");
    let replier = {
        let app = app.clone();
        tokio::spawn(async move {
            rest_send(
                &app,
                ws,
                reply(channel, bob, root2, "답글 (그만 따라가기 커밋 전)"),
            )
            .await
        })
    };
    tokio::time::sleep(blocked_for).await;
    assert!(
        !replier.is_finished(),
        "the automatic write waits on the key the uncommitted unfollow holds"
    );
    release2_tx.send(()).expect("release the second holder");
    holder2
        .await
        .expect("holder task")
        .expect("the held unfollow commits");
    replier.await.expect("replier task");
    assert_eq!(
        state_of(&su, root2, bob).await.as_deref(),
        Some("unfollowed"),
        "order 2: the automatic write arrived second and did not undo the unfollow"
    );
    assert!(
        !following(&app, ws, root2, bob).await,
        "and the read agrees"
    );
}

// ---------------------------------------------------------------------------
// T-4 — an idempotent retry makes no second row and undoes nothing
// ---------------------------------------------------------------------------

/// The same `client_msg_id` twice → one message, one row per member. And the retry of a send whose
/// author has since stopped following does not follow them again — the dedupe return happens before
/// the follow call, which is the whole reason the call sits after it.
///
/// Red if the call is moved above the `deduped` early return in `finish_send_in_tx` (the retry would
/// re-run the follow; with `DO NOTHING` it still could not flip `unfollowed`, so the sabotage is the
/// pair — move the call AND make the write `DO UPDATE` — which is what a careless "fix" would do).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t4_a_retried_send_follows_once_and_never_undoes_an_unfollow() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice6").await;
    let bob = seed_human(&su, ws, "bob6").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob]).await;
    let root = rest_send(&app, ws, text(channel, alice, "원문")).await;
    let root_id = root.message.id;

    let mut input = reply(channel, bob, root_id, "@alice6 재시도할 답글");
    let retry_id = Uuid::new_v4();
    input.client_msg_id = Some(retry_id);
    let first = rest_send(&app, ws, input.clone()).await;
    assert!(!first.deduped);
    assert_eq!(
        rows_of(&su, root_id).await,
        2,
        "bob (replier) and alice (root author + named)"
    );

    let second = rest_send(&app, ws, input.clone()).await;
    assert!(second.deduped, "the same client_msg_id is the same message");
    assert_eq!(second.message.id, first.message.id);
    assert_eq!(
        rows_of(&su, root_id).await,
        2,
        "a retry makes no second row"
    );

    // bob stops following; his client retries the very same send
    assert_eq!(
        set_follow(&app, ws, channel, root_id, bob, false).await,
        Ok(false)
    );
    let third = rest_send(&app, ws, input).await;
    assert!(third.deduped);
    assert_eq!(
        state_of(&su, root_id, bob).await.as_deref(),
        Some("unfollowed"),
        "a retried send must not follow its author again"
    );
}

// ---------------------------------------------------------------------------
// T-5 — who may follow what
// ---------------------------------------------------------------------------

/// Guard order and refusals of `set_thread_follow_in_tx`: a non-member, a root of another channel, a
/// reply used as a root, a DM, and the cross-tenant probe are refused **and write nothing**; a deleted
/// root is accepted (its replies stay readable).
///
/// Red if the membership check is removed (the non-member and cross-tenant cases would write), if the
/// root check is removed, or if the DM check is removed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t5_only_a_channel_member_may_follow_and_only_a_real_top_level_root() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = seed_workspace(&su).await;
    let other_ws = seed_workspace(&su).await;
    let alice = seed_human(&su, ws, "alice7").await;
    let bob = seed_human(&su, ws, "bob7").await;
    let outsider = seed_human(&su, ws, "outsider7").await; // in the workspace, not in the channel
    let stranger = seed_human(&su, other_ws, "stranger7").await;
    let channel = public_channel(&app, &su, ws, alice, &[alice, bob]).await;
    let sibling = public_channel(&app, &su, ws, alice, &[alice, bob]).await;
    let foreign = public_channel(&app, &su, other_ws, stranger, &[stranger]).await;

    let root = rest_send(&app, ws, text(channel, alice, "원문")).await;
    let root_id = root.message.id;
    let reply_msg = rest_send(&app, ws, reply(channel, bob, root_id, "답글")).await;
    let sibling_root = rest_send(&app, ws, text(sibling, alice, "옆 채널 원문")).await;
    let foreign_root = rest_send(&app, other_ws, text(foreign, stranger, "남의 원문")).await;

    assert_eq!(
        set_follow(&app, ws, channel, root_id, outsider, true).await,
        Err(FollowRefused::NotAMember),
        "a workspace member who is not in the channel cannot follow in it"
    );
    assert_eq!(
        state_of(&su, root_id, outsider).await,
        None,
        "and writes nothing"
    );

    assert_eq!(
        set_follow(&app, ws, channel, sibling_root.message.id, bob, true).await,
        Err(FollowRefused::Root(ThreadRootInvalid::NotFound)),
        "a root of another channel is 'not found', not a distinguishable answer"
    );
    assert_eq!(
        set_follow(&app, ws, channel, reply_msg.message.id, bob, true).await,
        Err(FollowRefused::Root(ThreadRootInvalid::NotTopLevel)),
        "a reply is not a thread root"
    );
    assert_eq!(
        set_follow(&app, ws, channel, Uuid::new_v4(), bob, true).await,
        Err(FollowRefused::Root(ThreadRootInvalid::NotFound))
    );

    let dm = dm_channel(&su, ws, &[alice, bob]).await;
    let dm_root = rest_send(&app, ws, text(dm, alice, "DM 원문")).await;
    assert_eq!(
        set_follow(&app, ws, dm, dm_root.message.id, bob, true).await,
        Err(FollowRefused::NotApplicable),
        "following a thread does not apply to a DM"
    );
    assert_eq!(state_of(&su, dm_root.message.id, bob).await, None);

    // cross-tenant probe: tenant B's transaction presenting tenant A's channel and root
    assert_eq!(
        set_follow(&app, other_ws, channel, root_id, stranger, true).await,
        Err(FollowRefused::NotAMember),
        "tenant A's channel is invisible from tenant B's transaction"
    );
    assert_eq!(
        set_follow(&app, ws, foreign, foreign_root.message.id, alice, true).await,
        Err(FollowRefused::NotAMember),
        "and the other way round"
    );
    assert_eq!(state_of(&su, root_id, stranger).await, None);
    assert_eq!(state_of(&su, foreign_root.message.id, alice).await, None);

    // a deleted root is still followable / unfollowable: its replies stay readable
    let doomed = rest_send(&app, ws, text(channel, alice, "곧 지울 원문")).await;
    rest_send(
        &app,
        ws,
        reply(channel, bob, doomed.message.id, "지우기 전 답글"),
    )
    .await;
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
    .expect("delete the root");
    assert_eq!(
        set_follow(&app, ws, channel, doomed_id, bob, false).await,
        Ok(false),
        "a tombstoned root can still be unfollowed"
    );
}

// ---------------------------------------------------------------------------
// T-6 — two tenants, a role that cannot bypass RLS
// ---------------------------------------------------------------------------

/// Tenant isolation of `thread_follow` as `momo_app` (`rolsuper = false`, `rolbypassrls = false`):
/// tenant B reads none of tenant A's rows, cannot INSERT a row for tenant A (WITH CHECK → 42501),
/// and cannot rewrite A's rows either.
///
/// Red if the policy is dropped or replaced by `USING (true)` (the read count under B's GUC turns
/// positive, or the forged INSERT succeeds) — the RLS sabotage of #4889, run live on the DB because
/// a migration re-run does not re-create a dropped policy in a database that already applied it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn t6_a_tenant_cannot_read_or_forge_another_tenants_follow_rows() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let (rolsuper, rolbypassrls): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'momo_app'")
            .fetch_one(&su)
            .await
            .expect("momo_app role");
    assert!(
        !rolsuper && !rolbypassrls,
        "this test means nothing unless momo_app is bound by RLS"
    );
    let (enabled, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'thread_follow'",
    )
    .fetch_one(&su)
    .await
    .expect("thread_follow rls flags");
    assert!(
        enabled && forced,
        "thread_follow is ENABLE + FORCE row level security"
    );

    let ws_a = seed_workspace(&su).await;
    let ws_b = seed_workspace(&su).await;
    let alice = seed_human(&su, ws_a, "alice8").await;
    let bob = seed_human(&su, ws_a, "bob8").await;
    let zed = seed_human(&su, ws_b, "zed8").await;
    let channel_a = public_channel(&app, &su, ws_a, alice, &[alice, bob]).await;
    let channel_b = public_channel(&app, &su, ws_b, zed, &[zed]).await;
    let root_a = rest_send(&app, ws_a, text(channel_a, alice, "A의 원문")).await;
    rest_send(
        &app,
        ws_a,
        reply(channel_a, bob, root_a.message.id, "A의 답글"),
    )
    .await;
    let root_b = rest_send(&app, ws_b, text(channel_b, zed, "B의 원문")).await;
    rest_send(
        &app,
        ws_b,
        reply(channel_b, zed, root_b.message.id, "B의 답글"),
    )
    .await;
    let root_a_id = root_a.message.id;
    let root_b_id = root_b.message.id;
    assert!(
        rows_of(&su, root_a_id).await >= 2,
        "fixture: tenant A has rows"
    );
    assert!(
        rows_of(&su, root_b_id).await >= 1,
        "fixture: tenant B has rows"
    );

    // reads: each tenant sees its own rows and none of the other's
    let seen_by_b: (i64, i64) = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let own: i64 =
                sqlx::query_scalar("SELECT count(*) FROM thread_follow WHERE root_id = $1")
                    .bind(root_b_id)
                    .fetch_one(&mut *conn)
                    .await?;
            let foreign: i64 =
                sqlx::query_scalar("SELECT count(*) FROM thread_follow WHERE root_id = $1")
                    .bind(root_a_id)
                    .fetch_one(&mut *conn)
                    .await?;
            Ok::<_, DbError>((own, foreign))
        })
    })
    .await
    .expect("read as tenant B");
    assert!(seen_by_b.0 >= 1, "tenant B reads its own rows (control)");
    assert_eq!(seen_by_b.1, 0, "tenant B reads none of tenant A's rows");
    assert!(
        !following(&app, ws_b, root_a_id, alice).await,
        "the follow read is tenant-scoped too"
    );

    // forged INSERT for tenant A from tenant B's transaction → RLS WITH CHECK
    let forged_code: Option<String> = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let outcome = sqlx::query(
                "INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
                 VALUES ($1, $2, $3, $4, 'auto')",
            )
            .bind(ws_a)
            .bind(channel_a)
            .bind(root_a_id)
            .bind(zed)
            .execute(&mut *conn)
            .await;
            Ok::<_, DbError>(match outcome {
                Ok(_) => None,
                Err(sqlx::Error::Database(db)) => db.code().map(|code| code.to_string()),
                Err(other) => Some(format!("not a database error: {other}")),
            })
        })
    })
    .await
    .expect("forge as tenant B");
    assert_eq!(
        forged_code.as_deref(),
        Some("42501"),
        "inserting a row for tenant A under tenant B's GUC must hit the RLS WITH CHECK"
    );
    assert_eq!(
        state_of(&su, root_a_id, zed).await,
        None,
        "and nothing was written"
    );

    // tenant B cannot rewrite tenant A's rows (the UPDATE finds no visible row)
    let touched: u64 = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            Ok::<_, DbError>(
                sqlx::query("UPDATE thread_follow SET state = 'unfollowed' WHERE root_id = $1")
                    .bind(root_a_id)
                    .execute(&mut *conn)
                    .await?
                    .rows_affected(),
            )
        })
    })
    .await
    .expect("update as tenant B");
    assert_eq!(touched, 0, "tenant B cannot rewrite tenant A's follow rows");
    assert_eq!(
        state_of(&su, root_a_id, bob).await.as_deref(),
        Some("auto"),
        "tenant A's rows are as they were"
    );
}
