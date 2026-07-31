//! DB-backed conformance for the messenger **breadth** surfaces (B1.2): DM,
//! read state, mentions, search — plus the cross-tenant isolation that must hold
//! across all of them.
//!
//! Same discipline as `conformance_pg.rs`: every test proves one hard property
//! with a **named assertion that goes red if the property is reverted**, and all
//! are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB plus
//! the runtime `momo_app` role. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-messaging --test breadth_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is identical to `conformance_pg.rs` (superuser applies the
//! migrations and seeds fixtures past RLS; the assertions run as `momo_app`,
//! `NOBYPASSRLS`, which is the only faithful way to exercise the policies). The
//! migration runner is idempotent, so this binary may share a container with the
//! others.
//!
//! ## The outbox-counting rule these tests obey (B1 gate lesson)
//!
//! A `message` INSERT fires `push_candidate_enqueue_trg`
//! (`011_push_notifier.sql:67`), which enqueues a **second** outbox row with the
//! same `partition_key`. Every count below therefore filters on `kind` — an
//! unfiltered `count(*) FROM outbox WHERE partition_key = …` double-counts and
//! reports a bug that is not there. That is a fact about the trigger layer, not
//! about the app's egress.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    active_workspace_role, canonical_participants, create_channel, dm_participant_key,
    list_direct_messages, list_read_state, open_direct_message_in_tx, search_messages,
    send_message, send_message_with_mentions_in_tx, update_read_cursor_in_tx, ChannelKind,
    NewChannel, NewMessage, OpenedDirectMessage, SearchCursor,
};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors conformance_pg.rs)
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

/// Seed a member **and** its `workspace_membership` row (migration 026): the
/// two together are what `active_workspace_role` calls an active member, and
/// every B1.2 route gates on that.
async fn seed_member(su: &PgPool, ws: Uuid, id: Uuid, kind: &str, handle: &str) {
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $5)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(format!("{handle} display"))
    .bind(handle)
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

/// `count(*)` of one outbox kind for a partition — always kind-filtered, see the
/// module header.
async fn outbox_count(su: &PgPool, partition_key: Uuid, kind: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM outbox WHERE partition_key = $1 AND kind::text = $2")
        .bind(partition_key)
        .bind(kind)
        .fetch_one(su)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// B1.2 #1 — DM creation is idempotent per participant pair
// ---------------------------------------------------------------------------

/// Opening a DM twice — in either argument order, and concurrently — yields one
/// channel.
///
/// Goes red if the pair key stops being canonicalized (reversed arguments would
/// mint a second channel), if the partial unique index is dropped (the race
/// would), or if the `channel_seq` seed leaves the CTE (the returned channel
/// could not accept a message).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn d2_b12_1_dm_open_is_idempotent_per_pair() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "human", "alice").await;
    seed_member(&su, ws, bob, "human", "bob").await;

    // The workspace gate the routes call: a member is Some, a non-member None.
    let (member_role, outsider_role) = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let member = active_workspace_role(conn, ws, alice).await?;
            let outsider = active_workspace_role(conn, ws, stranger).await?;
            Ok::<_, DbError>((member, outsider))
        })
    })
    .await
    .expect("role lookup");
    assert!(member_role.is_some(), "a seeded member is an active member");
    assert!(
        outsider_role.is_none(),
        "an unknown id must not resolve to a workspace role"
    );

    let first = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { open_direct_message_in_tx(conn, ws, alice, bob).await })
    })
    .await
    .expect("first open");
    let OpenedDirectMessage::Opened {
        channel: first_channel,
        created,
    } = first
    else {
        panic!("the target is an active member; open must succeed");
    };
    assert!(created, "the first open creates the channel");

    // Reversed arguments, from the other participant.
    let second = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { open_direct_message_in_tx(conn, ws, bob, alice).await })
    })
    .await
    .expect("second open");
    let OpenedDirectMessage::Opened {
        channel: second_channel,
        created: created_again,
    } = second
    else {
        panic!("reopening must succeed");
    };
    assert!(
        !created_again,
        "the second open must report created=false (200, not 201)"
    );
    assert_eq!(
        second_channel.id, first_channel.id,
        "(A,B) and (B,A) must be the SAME channel — the canonical pair key"
    );

    // Concurrency: the advisory lock + partial unique index must collapse a
    // burst to one channel, and every caller must get that channel back.
    let mut set = tokio::task::JoinSet::new();
    for index in 0..6 {
        let app = app.clone();
        let (actor, target) = if index % 2 == 0 {
            (alice, bob)
        } else {
            (bob, alice)
        };
        set.spawn(async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move { open_direct_message_in_tx(conn, ws, actor, target).await })
            })
            .await
        });
    }
    while let Some(joined) = set.join_next().await {
        let opened = joined.expect("task join").expect("concurrent open");
        let OpenedDirectMessage::Opened { channel, .. } = opened else {
            panic!("concurrent open must resolve to a channel");
        };
        assert_eq!(
            channel.id, first_channel.id,
            "every concurrent open must return the one channel"
        );
    }

    let dm_channels: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channel WHERE workspace_id = $1 AND kind = 'dm'")
            .bind(ws)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        dm_channels, 1,
        "one DM channel per participant pair, no matter how many opens raced"
    );

    // The key really is the canonical hash — not an insertion-order artifact.
    let expected_key: String =
        sqlx::query_scalar("SELECT encode(digest($1::text, 'sha256'), 'hex')")
            .bind(dm_participant_key(canonical_participants(alice, bob)))
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(first_channel.dm_key, expected_key);

    // The channel is usable: seq row seeded at 0, both memberships live.
    let last_seq: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(first_channel.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        last_seq, 0,
        "a DM without a channel_seq row could not accept a message"
    );
    let live_members: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM membership WHERE channel_id = $1 AND left_at IS NULL",
    )
    .bind(first_channel.id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(live_members, 2, "both participants are members");

    // The spine serves a DM unchanged — there is no second write path.
    let sent = send_message(
        &app,
        ws,
        NewMessage::text(first_channel.id, alice, "hi bob"),
    )
    .await
    .expect("send into the DM");
    assert_eq!(sent.message.seq, 1);

    // Both participants discover it; a non-participant does not.
    for viewer in [alice, bob] {
        let listed = with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move { list_direct_messages(conn, ws, viewer).await })
        })
        .await
        .expect("list DMs");
        assert_eq!(listed.len(), 1, "each participant sees the DM");
        assert_eq!(listed[0].id, first_channel.id);
        assert_eq!(listed[0].member_ids.len(), 2);
    }

    // A target that is not an active member is a 404-shaped outcome, distinct
    // from "you may not" — the caller must be able to tell them apart.
    let missing = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { open_direct_message_in_tx(conn, ws, alice, stranger).await })
    })
    .await
    .expect("open with unknown target");
    assert_eq!(missing, OpenedDirectMessage::TargetNotFound);
}

// ---------------------------------------------------------------------------
// B1.2 #2 — the read cursor is a seq, and unread is seq arithmetic
// ---------------------------------------------------------------------------

/// Advancing the cursor is monotone, clamped to the channel head, and unread is
/// exactly `latest_seq - last_read_seq`.
///
/// **This is the "cursor is not a clock" red.** The decisive assertion feeds a
/// millisecond epoch timestamp as `last_read_seq`: a seq cursor clamps it to the
/// head (5) and reports 0 unread; a clock cursor would store the timestamp and
/// then compute unread by time, so the stored value would not be 5. Re-implement
/// the cursor as a timestamp and this test fails on that line.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn d2_b12_2_read_cursor_is_seq_based_and_unread_is_exact() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let reader = Uuid::new_v4();
    let author = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, reader, "human", "reader").await;
    seed_member(&su, ws, author, "human", "author").await;

    let channel = create_channel(
        &app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: "cursor".into(),
            topic: None,
            created_by: author,
        },
    )
    .await
    .expect("create channel");
    seed_membership(&su, ws, channel.id, reader).await;

    for index in 1..=5 {
        send_message(
            &app,
            ws,
            NewMessage::text(channel.id, author, format!("m{index}")),
        )
        .await
        .expect("send");
    }

    // Never opened: cursor 0, everything unread — the channel is listed, not
    // omitted, so a first sync is complete.
    let initial = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { list_read_state(conn, ws, reader).await })
    })
    .await
    .expect("list read state");
    let initial = initial
        .iter()
        .find(|state| state.channel_id == channel.id)
        .expect("the channel appears before it is ever read");
    assert_eq!(initial.last_read_seq, 0);
    assert_eq!(initial.latest_seq, 5);
    assert_eq!(initial.unread_count, 5, "unread = latest - cursor");
    assert_eq!(initial.mention_count, 0);

    // Advance to 3 → 2 unread, and exactly one broadcast.
    let advanced = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { update_read_cursor_in_tx(conn, ws, channel.id, reader, 3).await })
    })
    .await
    .expect("advance cursor")
    .expect("reader is a channel member");
    assert!(advanced.advanced);
    assert_eq!(advanced.state.last_read_seq, 3);
    assert_eq!(advanced.state.unread_count, 2);
    assert!(advanced.outbox_id.is_some(), "an advance publishes");

    // A stale device replaying an older cursor must NOT rewind it, and must not
    // publish a second time.
    let stale = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { update_read_cursor_in_tx(conn, ws, channel.id, reader, 1).await })
    })
    .await
    .expect("stale cursor")
    .expect("member");
    assert!(!stale.advanced, "a lower cursor is not an advance");
    assert_eq!(
        stale.state.last_read_seq, 3,
        "GREATEST() keeps the furthest cursor any device reached"
    );
    assert!(stale.outbox_id.is_none(), "no advance, no broadcast");

    // THE RED: a millisecond epoch stamp where a seq belongs.
    let clocklike: i64 = 1_764_547_200_000;
    let clamped = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(
            async move { update_read_cursor_in_tx(conn, ws, channel.id, reader, clocklike).await },
        )
    })
    .await
    .expect("clock-shaped cursor")
    .expect("member");
    assert_eq!(
        clamped.state.last_read_seq, 5,
        "the cursor is a message.seq: a wall-clock value must clamp to the channel \
         head (5), never be stored as-is ({clocklike})"
    );
    assert_eq!(clamped.state.unread_count, 0);
    assert_eq!(clamped.state.latest_seq, 5);

    let stored_cursor: i64 = sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel.id)
    .bind(reader)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        stored_cursor, 5,
        "the persisted cursor is a seq in 0..=latest, not a timestamp"
    );

    // Exactly two advances (3 and 5) ⇒ two read-state broadcasts, keyed to the
    // member (their personal channel), not to the channel.
    let published = outbox_count(&su, reader, "broadcast").await;
    assert_eq!(
        published, 2,
        "one broadcast per advance; a no-op PUT must not publish"
    );

    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE partition_key = $1 AND kind = 'broadcast' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(reader)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(payload["data"]["type"], Value::from("read_state"));
    assert_eq!(payload["data"]["payload"]["last_read_seq"], Value::from(5));
    assert_eq!(payload["data"]["payload"]["unread_count"], Value::from(0));
    assert_eq!(
        payload["channel"],
        Value::from(format!(
            "user:read-state#{}",
            reader.to_string().to_uppercase()
        )),
        "the personal channel string must match Foundation's uppercase UUID"
    );

    // A non-member gets the authorization outcome, not a cursor.
    let outsider = Uuid::new_v4();
    seed_member(&su, ws, outsider, "human", "outsider").await;
    let refused = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { update_read_cursor_in_tx(conn, ws, channel.id, outsider, 1).await })
    })
    .await
    .expect("non-member update");
    assert!(
        refused.is_none(),
        "a member of the workspace but not the channel cannot move a cursor in it"
    );
}

// ---------------------------------------------------------------------------
// B1.2 #3 — a mention lands in the recipient's count, and only theirs
// ---------------------------------------------------------------------------

/// The send path parses `@handle`, writes the server-owned
/// `props.mention_member_ids`, and bumps only the mentioned member's
/// `mention_count` — in the same transaction as the message.
///
/// Goes red if mention parsing leaves the send transaction (the count would lag
/// the message), if the author could mention themselves, if a client-supplied
/// `mention_member_ids` were trusted, or if the id casing drifted from
/// Foundation's uppercase (the recount would find nothing).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn d2_b12_3_mention_lands_in_the_recipient_count() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, alice, "human", "alice").await;
    seed_member(&su, ws, bob, "human", "bob").await;

    let channel = create_channel(
        &app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: "mentions".into(),
            topic: None,
            created_by: alice,
        },
    )
    .await
    .expect("create channel");
    seed_membership(&su, ws, channel.id, bob).await;

    // A client trying to mint its own badge: the server-owned key is supplied in
    // props and must be overwritten by the server's own decision.
    let mut input = NewMessage::text(channel.id, alice, "hey @bob please look")
        .with_client_msg_id(Uuid::new_v4());
    input.props = serde_json::json!({"mention_member_ids": ["forged"], "k": "v"});

    let sent = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let outcome = send_message_with_mentions_in_tx(conn, ws, input, None).await?;
            Ok::<_, DbError>(outcome.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("send with a mention");
    assert!(!sent.deduped);

    let expected_token = bob.to_string().to_uppercase();
    let stored_props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(sent.message.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        stored_props["mention_member_ids"],
        Value::from(vec![expected_token.clone()]),
        "the server's parse replaces whatever the client sent"
    );
    assert_eq!(
        stored_props["k"],
        Value::from("v"),
        "the client's other props survive"
    );

    // The broadcast carries the same decision, so a realtime client can
    // highlight the mention without a second fetch.
    let payload: Value = sqlx::query_scalar("SELECT payload FROM outbox WHERE id = $1")
        .bind(sent.outbox_id.expect("a first send publishes"))
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        payload["data"]["payload"]["props"]["mention_member_ids"],
        Value::from(vec![expected_token.clone()])
    );

    // Bob is mentioned once; Alice — the author — is not, and has no row.
    let bob_mentions: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel.id)
    .bind(bob)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(bob_mentions, 1);

    let alice_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel.id)
    .bind(alice)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        alice_rows, 0,
        "an author cannot raise their own mention badge"
    );

    // A message that mentions nobody changes nothing.
    let plain = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            let outcome = send_message_with_mentions_in_tx(
                conn,
                ws,
                NewMessage::text(channel.id, alice, "no mention here")
                    .with_client_msg_id(Uuid::new_v4()),
                None,
            )
            .await?;
            Ok::<_, DbError>(outcome.expect("unsigned"))
        })
    })
    .await
    .expect("plain send");
    let bob_after_plain: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel.id)
    .bind(bob)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(bob_after_plain, 1, "an unrelated message is not a mention");

    // The mention badge and the read cursor are one ledger: reading past the
    // mention clears it.
    let cleared = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            update_read_cursor_in_tx(conn, ws, channel.id, bob, plain.message.seq).await
        })
    })
    .await
    .expect("bob reads")
    .expect("bob is a channel member");
    assert_eq!(
        cleared.state.mention_count, 0,
        "a mention behind the cursor is read, so the badge clears"
    );
    assert_eq!(cleared.state.unread_count, 0);

    // The B1 gate lesson, asserted rather than remembered: two sends produce two
    // app broadcasts AND two trigger-authored push candidates on the same
    // partition. An unfiltered count would read 4 and look like a double-write.
    assert_eq!(outbox_count(&su, channel.id, "broadcast").await, 2);
    assert_eq!(
        outbox_count(&su, channel.id, "push_candidate").await,
        2,
        "011's AFTER INSERT trigger enqueues one candidate per message — kind \
         filtering is mandatory when counting the app's egress"
    );
}

// ---------------------------------------------------------------------------
// B1.2 #4 — search returns body hits, scoped to the caller's channels
// ---------------------------------------------------------------------------

/// Search finds the needle in a body the caller may read, never in one they may
/// not, treats LIKE metacharacters as literal text, hides tombstones, and pages
/// without repeating a row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn d2_b12_4_search_returns_body_hits() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let seeker = Uuid::new_v4();
    let other = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, seeker, "human", "seeker").await;
    seed_member(&su, ws, other, "human", "other").await;

    let mine = create_channel(
        &app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: "mine".into(),
            topic: None,
            created_by: seeker,
        },
    )
    .await
    .expect("create own channel");
    let theirs = create_channel(
        &app,
        ws,
        NewChannel {
            kind: ChannelKind::Private,
            name: "theirs".into(),
            topic: None,
            created_by: other,
        },
    )
    .await
    .expect("create foreign channel");

    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "the quick brown fox jumps"),
    )
    .await
    .expect("own message");
    send_message(
        &app,
        ws,
        NewMessage::text(theirs.id, other, "quick secret nobody may read"),
    )
    .await
    .expect("foreign message");

    let page = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { search_messages(conn, ws, seeker, "quick", None, 20).await })
    })
    .await
    .expect("search");
    assert_eq!(
        page.hits.len(),
        1,
        "membership is a JOIN: a private channel the caller never joined must \
         not surface through search"
    );
    let hit = &page.hits[0];
    assert_eq!(hit.channel_id, mine.id);
    assert_eq!(hit.seq, 1);
    assert_eq!(hit.author_member_id, seeker);
    assert!(
        hit.snippet.to_lowercase().contains("quick"),
        "snippet must contain the match: {:?}",
        hit.snippet
    );
    let offset = hit.match_offset as usize;
    assert!(
        hit.snippet[offset..].to_lowercase().starts_with("quick"),
        "matchOffset must point AT the match inside the snippet: {:?} @ {}",
        hit.snippet,
        offset
    );
    assert!(page.next_cursor.is_none(), "a single hit is the last page");

    // LIKE metacharacters are literal text.
    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "discount 50% today"),
    )
    .await
    .expect("percent message");
    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "discount 501 today"),
    )
    .await
    .expect("decoy message");
    let literal = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { search_messages(conn, ws, seeker, "50%", None, 20).await })
    })
    .await
    .expect("literal search");
    assert_eq!(
        literal.hits.len(),
        1,
        "`%` is text, not a wildcard — an unescaped pattern would also match \
         \"discount 501 today\""
    );
    assert!(literal.hits[0].snippet.contains("50%"));

    // Tombstones stay out of search.
    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "ephemeral needle"),
    )
    .await
    .expect("to be deleted");
    sqlx::query("UPDATE message SET deleted_at = now() WHERE body = 'ephemeral needle'")
        .execute(&su)
        .await
        .expect("tombstone");
    let after_delete = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { search_messages(conn, ws, seeker, "ephemeral", None, 20).await })
    })
    .await
    .expect("search after delete");
    assert!(
        after_delete.hits.is_empty(),
        "a deleted message must not be searchable"
    );

    // Paging is total: two matches at limit 1 yield each exactly once.
    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "paging alpha token"),
    )
    .await
    .expect("page 1 row");
    send_message(
        &app,
        ws,
        NewMessage::text(mine.id, seeker, "paging beta token"),
    )
    .await
    .expect("page 2 row");
    let first_page = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { search_messages(conn, ws, seeker, "paging", None, 1).await })
    })
    .await
    .expect("first page");
    assert_eq!(first_page.hits.len(), 1);
    let cursor: SearchCursor = first_page.next_cursor.expect("more rows remain");
    let second_page = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { search_messages(conn, ws, seeker, "paging", Some(cursor), 1).await })
    })
    .await
    .expect("second page");
    assert_eq!(second_page.hits.len(), 1);
    assert_ne!(
        second_page.hits[0].message_id, first_page.hits[0].message_id,
        "the cursor must not replay the row it was minted from"
    );
    assert!(
        second_page.next_cursor.is_none(),
        "two matches, page size one: the second page is the last"
    );
}

// ---------------------------------------------------------------------------
// B1.2 #5 — RLS isolation across every breadth surface
// ---------------------------------------------------------------------------

/// Scoped to workspace A as `momo_app` (NOBYPASSRLS), each B1.2 read returns its
/// own rows and **zero** of workspace B's — DMs, read state and search alike.
///
/// Drop the GUC seam and A's own rows vanish too; run as a BYPASSRLS role and
/// B's rows leak. Either revert makes an assertion below red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn d2_b12_5_rls_blocks_cross_tenant_breadth_reads() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws_a = Uuid::new_v4();
    let ws_b = Uuid::new_v4();
    let a1 = Uuid::new_v4();
    let a2 = Uuid::new_v4();
    let b1 = Uuid::new_v4();
    let b2 = Uuid::new_v4();
    seed_workspace(&su, ws_a).await;
    seed_workspace(&su, ws_b).await;
    seed_member(&su, ws_a, a1, "human", "a-one").await;
    seed_member(&su, ws_a, a2, "human", "a-two").await;
    seed_member(&su, ws_b, b1, "human", "b-one").await;
    seed_member(&su, ws_b, b2, "human", "b-two").await;

    // Each tenant gets a DM and a message carrying a tenant-unique needle.
    for (ws, actor, target, needle) in [
        (ws_a, a1, a2, "alpha-needle-a"),
        (ws_b, b1, b2, "bravo-needle-b"),
    ] {
        let opened = with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move { open_direct_message_in_tx(conn, ws, actor, target).await })
        })
        .await
        .expect("open DM");
        let OpenedDirectMessage::Opened { channel, .. } = opened else {
            panic!("both targets are active members");
        };
        send_message(&app, ws, NewMessage::text(channel.id, actor, needle))
            .await
            .expect("send tenant message");
    }

    // Scoped to A: A's own rows are visible, B's are not — even when the query
    // names B's ids explicitly, which is the strongest form of the attempt.
    let (own_dms, foreign_dms, own_states, foreign_states, own_hits, foreign_hits) =
        with_tenant_tx(&app, ws_a, move |conn| {
            Box::pin(async move {
                let own_dms = list_direct_messages(conn, ws_a, a1).await?.len();
                let foreign_dms = list_direct_messages(conn, ws_b, b1).await?.len();
                let own_states = list_read_state(conn, ws_a, a1).await?.len();
                let foreign_states = list_read_state(conn, ws_b, b1).await?.len();
                let own_hits = search_messages(conn, ws_a, a1, "alpha-needle-a", None, 20)
                    .await?
                    .hits
                    .len();
                let foreign_hits = search_messages(conn, ws_a, a1, "bravo-needle-b", None, 20)
                    .await?
                    .hits
                    .len();
                Ok::<_, DbError>((
                    own_dms,
                    foreign_dms,
                    own_states,
                    foreign_states,
                    own_hits,
                    foreign_hits,
                ))
            })
        })
        .await
        .expect("scoped reads as momo_app");

    assert_eq!(own_dms, 1, "A must see its own DM");
    assert_eq!(
        foreign_dms, 0,
        "A must see ZERO of B's DMs (RLS isolation on channel/membership)"
    );
    assert_eq!(own_states, 1, "A must see its own read state");
    assert_eq!(
        foreign_states, 0,
        "A must see ZERO of B's read state (RLS isolation on read_state)"
    );
    assert_eq!(own_hits, 1, "A must find its own message");
    assert_eq!(
        foreign_hits, 0,
        "A must find ZERO of B's messages (RLS isolation on message)"
    );

    // Symmetric: B scoped to itself sees exactly one of each, so the zeros above
    // are isolation, not an empty database.
    let (b_dms, b_hits) = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let dms = list_direct_messages(conn, ws_b, b1).await?.len();
            let hits = search_messages(conn, ws_b, b1, "bravo-needle-b", None, 20)
                .await?
                .hits
                .len();
            Ok::<_, DbError>((dms, hits))
        })
    })
    .await
    .expect("scoped reads as B");
    assert_eq!(b_dms, 1, "B sees its own DM — the fixtures really exist");
    assert_eq!(b_hits, 1, "B finds its own message");

    // A cursor write into a foreign channel is refused too (write-side check,
    // not only reads).
    let foreign_channel: Uuid = sqlx::query_scalar(
        "SELECT id FROM channel WHERE workspace_id = $1 AND kind = 'dm' LIMIT 1",
    )
    .bind(ws_b)
    .fetch_one(&su)
    .await
    .unwrap();
    let refused = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move { update_read_cursor_in_tx(conn, ws_a, foreign_channel, a1, 1).await })
    })
    .await
    .expect("cross-tenant cursor write");
    assert!(
        refused.is_none(),
        "a member of A must not be able to move a cursor in B's channel"
    );
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(foreign_channel)
    .bind(a1)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(leaked, 0, "no read_state row may be created across tenants");
}
