//! DB-backed conformance for **ADR-0160 ③ 선언 상태** (사용자 프레즌스 6b) — the
//! half of presence a real Postgres has to answer.
//!
//! `tests/ephemeral_typing_touches_no_pg.rs` proves the availability(②) path
//! needs no database. This file proves the four things the durable(③) path needs
//! one for:
//!
//!   1. **DND survives a reconnect** (the red proof the packet names). A status
//!      is written, then re-read on a fresh connection — the value the second
//!      read returns is the whole point of D2: were presence 휘발, a reconnect
//!      would silently clear DND and un-suppress notifications.
//!   2. **the broadcast fans out to the member's `ch:` channels and no further**
//!      (verification contract #2). One `Broadcast` per channel the member is in,
//!      none to a channel they are not in.
//!   3. **the roster carries each human's declared status and no agent's** (D4).
//!   4. **an agent cannot hold a declared status** — the domain guard matches no
//!      row for `kind = 'agent'`, so even a bypassed route changes nothing.
//!   5. **declared DND is bundled with the notification pause** (ADR-0124 증보
//!      2, 성재 2026-09-27 「묶어」): choosing DND turns the pause on in the same
//!      transaction, ending DND restores the pause that was there before, a
//!      pause that was already on is kept, a timed DND gives the pause the same
//!      expiry, and an explicit rule edit breaks the link.
//!
//! | test (5) | sabotage that makes it red |
//! |---|---|
//! | `choosing_dnd_pauses_notifications_and_ending_it_restores_off` | skip `engage_…` / `release_…` in `set_declared_presence_in_tx` |
//! | `a_timed_dnd_pauses_until_the_same_moment` | engage with `None` instead of the DND expiry |
//! | `a_pause_that_was_already_on_is_kept_through_dnd` | drop the snapshot (release to `false`), or drop the union in `bundled_until` |
//! | `re_choosing_dnd_does_not_resnapshot_the_bundled_value` | re-snapshot on every engage |
//! | `an_explicit_pause_edit_breaks_the_bundle` | keep `presence_prev_*` on a pause-changing rule PUT, or engage on every DND write |
//! | `the_bundle_rolls_back_with_the_presence_write` | write the pause on a second connection/transaction |
//! | `an_expired_dnd_reads_as_auto_everywhere` | drop the lazy expiry from `effective_presence` or the roster `CASE` |
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test presence_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a **superuser**
//! (migrations + fixture seeding + BYPASSRLS reads of `outbox`), the domain runs
//! as **`momo_app`** (NOBYPASSRLS, so the RLS policies actually apply). The
//! schema/roles step is re-runnable and every fixture id is a fresh UUID, so this
//! binary may share one `pgvector/pgvector:pg18` container with the other suites.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    cent_channel, create_channel, declared_presence_for, get_notification_rule_in_tx,
    list_workspace_roster, presence_status_for, set_declared_presence_in_tx,
    set_notification_rule_in_tx, set_presence_status_in_tx, ChannelKind, CustomStatusPatch,
    MemberKind, NewChannel, NotificationRule, NotificationRuleUpdate, PresenceStatus,
    PresenceUpdate, StatusPatch,
};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors ephemeral_typing_conformance_pg.rs)
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
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
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
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_member(su: &PgPool, workspace: Uuid, kind: &str) -> Uuid {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(member)
    .bind(workspace)
    .bind(kind)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");
    member
}

async fn stored_presence(su: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT presence_status::text FROM member WHERE id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("read stored presence")
}

/// The presence broadcasts an `outbox` holds for a workspace: `(partition_key,
/// channel, member, status)`, filtered to the declared-status frame so
/// `create_channel`'s own rows do not count.
async fn presence_broadcasts(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, String, String, String)> {
    let rows: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT partition_key, \
                payload->>'channel', \
                payload->'data'->'payload'->>'member_id', \
                payload->'data'->'payload'->>'presence_status' \
           FROM outbox \
          WHERE workspace_id = $1 \
            AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'presence' \
          ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read presence broadcasts");
    rows
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// **The red proof: DND survives a reconnect.** Set dnd, then re-read on a fresh
/// tenant transaction (a reconnect reads durable state, not a live signal). If
/// presence were 휘발, this second read would come back `auto`.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn dnd_is_durable_and_survives_a_reconnect() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;

    // A fresh member defaults to auto (migration 066).
    assert_eq!(stored_presence(&su, human).await, "auto");

    // Set dnd through the single write path.
    let set = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_presence_status_in_tx(conn, workspace, human, PresenceStatus::Dnd).await
        })
    })
    .await
    .expect("set dnd");
    assert_eq!(
        set.expect("a live human member updated").status,
        PresenceStatus::Dnd
    );
    assert_eq!(
        stored_presence(&su, human).await,
        "dnd",
        "the write is durable"
    );

    // The reconnect: a brand-new tenant transaction re-reads the durable column
    // and still finds dnd. This is the whole of D2 — a reconnect must not clear
    // it and un-suppress notifications.
    let after_reconnect = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move { presence_status_for(conn, human).await })
    })
    .await
    .expect("re-read after reconnect");
    assert_eq!(
        after_reconnect,
        Some(PresenceStatus::Dnd),
        "DND must survive a reconnect (ADR-0160 D2, 기각 A)"
    );
}

/// The declared-status broadcast fans out to exactly the member's `ch:` channels
/// and never to a channel they are not in (verification contract #2).
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_status_change_broadcasts_only_to_the_members_channels() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;
    let other = seed_member(&su, workspace, "human").await;

    // The human is in two channels; a third belongs to someone else and the human
    // never joins it. `create_channel` seeds only the creator's membership.
    let ch_a = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("pres-a-{}", Uuid::new_v4()),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("channel a");
    let ch_b = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("pres-b-{}", Uuid::new_v4()),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("channel b");
    let ch_outsider = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("pres-out-{}", Uuid::new_v4()),
            topic: None,
            created_by: other,
        },
    )
    .await
    .expect("outsider channel");

    let set = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_presence_status_in_tx(conn, workspace, human, PresenceStatus::Away).await
        })
    })
    .await
    .expect("set away")
    .expect("a live human updated");
    assert_eq!(
        set.broadcast_outbox_ids.len(),
        2,
        "one broadcast per channel the member is in"
    );

    let broadcasts = presence_broadcasts(&su, workspace).await;
    let hit_channels: Vec<Uuid> = broadcasts.iter().map(|row| row.0).collect();
    assert!(hit_channels.contains(&ch_a.id), "channel a co-members told");
    assert!(hit_channels.contains(&ch_b.id), "channel b co-members told");
    assert!(
        !hit_channels.contains(&ch_outsider.id),
        "a channel the member is not in must never carry their presence (roster boundary)"
    );
    assert_eq!(
        broadcasts.len(),
        2,
        "no broadcast leaks past the two channels"
    );

    for (partition, channel_name, member_token, status) in &broadcasts {
        assert_eq!(channel_name, &cent_channel(workspace, *partition));
        assert_eq!(member_token, &human.to_string().to_uppercase());
        assert_eq!(status, "away");
    }
}

/// The roster carries each human's declared status and omits every agent's
/// (ADR-0160 D4). A booting client reads a co-member's status from here.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_roster_carries_human_presence_and_not_agent_presence() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let workspace = seed_workspace(&su).await;
    let viewer = seed_member(&su, workspace, "human").await;
    let agent = seed_member(&su, workspace, "agent").await;

    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_presence_status_in_tx(conn, workspace, viewer, PresenceStatus::Dnd).await
        })
    })
    .await
    .expect("set viewer dnd");

    let roster = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(
            async move { list_workspace_roster(conn, workspace, viewer, false, None, 200).await },
        )
    })
    .await
    .expect("roster");

    let viewer_row = roster
        .iter()
        .find(|member| member.id == viewer)
        .expect("viewer on roster");
    assert_eq!(
        viewer_row.presence_status,
        Some(PresenceStatus::Dnd),
        "a human row carries the declared status"
    );

    let agent_row = roster
        .iter()
        .find(|member| member.id == agent)
        .expect("agent on roster");
    assert_eq!(agent_row.kind, MemberKind::Agent);
    assert_eq!(
        agent_row.presence_status, None,
        "an agent has no declared presence, its liveness is agent_run (D4)"
    );
}

/// The domain guard is human-only: setting presence on an agent member matches
/// no row and changes nothing, so even a route that forgot `require_human` could
/// not give an agent a declared status.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn an_agent_cannot_be_given_a_declared_status() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let workspace = seed_workspace(&su).await;
    let agent = seed_member(&su, workspace, "agent").await;

    let outcome: Result<_, DbError> = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_presence_status_in_tx(conn, workspace, agent, PresenceStatus::Dnd).await
        })
    })
    .await;
    assert_eq!(
        outcome.expect("no db error"),
        None,
        "the human-only guard matches no agent row"
    );
    assert_eq!(
        stored_presence(&su, agent).await,
        "auto",
        "the agent's column is untouched"
    );
    assert!(
        presence_broadcasts(&su, workspace).await.is_empty(),
        "nothing was broadcast for a change that did not happen"
    );
}

// ---------------------------------------------------------------------------
// ADR-0124 증보 2 — declared DND ↔ notification pause bundle (#2850)
// ---------------------------------------------------------------------------

/// A whole-millisecond instant `offset` from now, so what PG stores (µs) and
/// what the wire carries (ms) compare equal.
fn at(offset: Duration) -> DateTime<Utc> {
    DateTime::from_timestamp_millis((Utc::now() + offset).timestamp_millis()).expect("ms")
}

async fn declare(
    app: &PgPool,
    workspace: Uuid,
    member: Uuid,
    status: PresenceStatus,
    until: StatusPatch<DateTime<Utc>>,
    custom: CustomStatusPatch,
) -> PresenceUpdate {
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            set_declared_presence_in_tx(conn, workspace, member, status, until, custom).await
        })
    })
    .await
    .expect("declare presence")
    .expect("a live human member")
}

async fn rule(app: &PgPool, workspace: Uuid, member: Uuid) -> NotificationRule {
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { get_notification_rule_in_tx(conn, workspace, member).await })
    })
    .await
    .expect("read rule")
}

async fn put_rule(app: &PgPool, workspace: Uuid, member: Uuid, update: NotificationRuleUpdate) {
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { set_notification_rule_in_tx(conn, workspace, member, update).await })
    })
    .await
    .expect("put rule");
}

/// The bundle memory, raw (superuser).
async fn bundle_memory(su: &PgPool, member: Uuid) -> Option<(Option<bool>, Option<DateTime<Utc>>)> {
    sqlx::query_as(
        "SELECT presence_prev_dnd, presence_prev_dnd_until FROM notification_rule WHERE member_id = $1",
    )
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read bundle memory")
}

fn text_patch(text: &str) -> CustomStatusPatch {
    CustomStatusPatch {
        text: StatusPatch::Set(Some(text.to_string())),
        ..CustomStatusPatch::default()
    }
}

const OFF: NotificationRule = NotificationRule {
    dnd: false,
    dnd_until: None,
    mention_overrides_mute: false,
};

/// 켜기·풀기: a member who never touched notification rules chooses DND — the
/// pause comes on with no second write; ending DND puts it back to off and
/// forgets the bundle.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn choosing_dnd_pauses_notifications_and_ending_it_restores_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;
    assert_eq!(rule(&app, workspace, human).await, OFF);

    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, human).await,
        NotificationRule { dnd: true, ..OFF },
        "choosing DND must pause notifications in the same write"
    );
    assert_eq!(bundle_memory(&su, human).await, Some((Some(false), None)));

    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, human).await,
        OFF,
        "ending DND must restore the pause that was there before (off)"
    );
    assert_eq!(bundle_memory(&su, human).await, Some((None, None)));
}

/// 만료: a timed DND gives the pause the same expiry, and both reads carry it.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_timed_dnd_pauses_until_the_same_moment() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;
    let until = at(Duration::hours(1));

    let update = declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(until)),
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(update.status, PresenceStatus::Dnd);
    assert_eq!(update.dnd_until, Some(until));
    assert_eq!(
        rule(&app, workspace, human).await,
        NotificationRule {
            dnd: true,
            dnd_until: Some(until),
            ..OFF
        },
        "the pause must lapse with DND — same expiry"
    );
    let declared = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move { declared_presence_for(conn, human).await })
    })
    .await
    .expect("read declared")
    .expect("human");
    assert_eq!(declared.dnd_until, Some(until));

    // Leaving DND clears the DND expiry column (CHECK) and the pause.
    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Away,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    let stored: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT presence_dnd_until FROM member WHERE id = $1")
            .bind(human)
            .fetch_one(&su)
            .await
            .expect("read presence_dnd_until");
    assert_eq!(stored, None);
    assert_eq!(rule(&app, workspace, human).await, OFF);
}

/// 원래 켜져 있던 경우 유지: a pause that was already on survives DND in both
/// directions — an open-ended one stays open-ended, a timed one is never
/// shortened by DND and is restored exactly when DND ends.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_pause_that_was_already_on_is_kept_through_dnd() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;

    // (a) open-ended pause, timed DND.
    let open = seed_member(&su, workspace, "human").await;
    put_rule(
        &app,
        workspace,
        open,
        NotificationRule { dnd: true, ..OFF }.into(),
    )
    .await;
    declare(
        &app,
        workspace,
        open,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(at(Duration::hours(1)))),
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, open).await,
        NotificationRule { dnd: true, ..OFF },
        "an open-ended pause must not be given DND's expiry"
    );
    declare(
        &app,
        workspace,
        open,
        PresenceStatus::Away,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, open).await,
        NotificationRule { dnd: true, ..OFF },
        "ending DND must leave a pause that was on before, on"
    );

    // (b) longer timed pause, shorter DND: the pause keeps its own expiry.
    let long = seed_member(&su, workspace, "human").await;
    let three_h = at(Duration::hours(3));
    put_rule(
        &app,
        workspace,
        long,
        NotificationRule {
            dnd: true,
            dnd_until: Some(three_h),
            ..OFF
        }
        .into(),
    )
    .await;
    declare(
        &app,
        workspace,
        long,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(at(Duration::hours(1)))),
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(rule(&app, workspace, long).await.dnd_until, Some(three_h));
    declare(
        &app,
        workspace,
        long,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, long).await,
        NotificationRule {
            dnd: true,
            dnd_until: Some(three_h),
            ..OFF
        }
    );

    // (c) shorter timed pause, longer DND: the pause covers DND, then the
    // original 30-minute pause is what comes back.
    let short = seed_member(&su, workspace, "human").await;
    let thirty = at(Duration::minutes(30));
    let two_h = at(Duration::hours(2));
    put_rule(
        &app,
        workspace,
        short,
        NotificationRule {
            dnd: true,
            dnd_until: Some(thirty),
            ..OFF
        }
        .into(),
    )
    .await;
    declare(
        &app,
        workspace,
        short,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(two_h)),
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(rule(&app, workspace, short).await.dnd_until, Some(two_h));
    declare(
        &app,
        workspace,
        short,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, short).await,
        NotificationRule {
            dnd: true,
            dnd_until: Some(thirty),
            ..OFF
        },
        "ending DND restores the member's own 30-minute pause"
    );
}

/// Re-choosing DND (a new expiry, or editing a custom status while in DND) must
/// not re-snapshot: the memory would then hold the bundled "on" and ending DND
/// would leave notifications paused forever.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn re_choosing_dnd_does_not_resnapshot_the_bundled_value() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;

    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(at(Duration::hours(1)))),
        CustomStatusPatch::default(),
    )
    .await;
    let two_h = at(Duration::hours(2));
    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(two_h)),
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, human).await,
        NotificationRule {
            dnd: true,
            dnd_until: Some(two_h),
            ..OFF
        },
        "a re-chosen expiry moves the pause with it"
    );
    // Custom-status edit while in DND: expiry kept.
    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Absent,
        text_patch("집중"),
    )
    .await;
    assert_eq!(rule(&app, workspace, human).await.dnd_until, Some(two_h));
    assert_eq!(bundle_memory(&su, human).await, Some((Some(false), None)));

    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, human).await,
        OFF,
        "the memory is the pre-DND off, not the bundled on"
    );
}

/// An explicit rule PUT that changes the pause breaks the bundle: ending DND
/// must not overwrite what the member chose by hand, and a later DND write that
/// is not a new choice (custom-status edit) must not re-arm it. A PUT that only
/// flips the mention exception keeps the bundle.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn an_explicit_pause_edit_breaks_the_bundle() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;

    let manual = seed_member(&su, workspace, "human").await;
    declare(
        &app,
        workspace,
        manual,
        PresenceStatus::Dnd,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    put_rule(&app, workspace, manual, OFF.into()).await;
    assert_eq!(
        bundle_memory(&su, manual).await,
        Some((None, None)),
        "the link is broken"
    );
    declare(
        &app,
        workspace,
        manual,
        PresenceStatus::Dnd,
        StatusPatch::Absent,
        text_patch("회의"),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, manual).await,
        OFF,
        "a custom-status edit while in DND must not re-arm a pause the member turned off"
    );

    // Manual "on" during DND, then DND ends: the manual choice stands.
    let manual_on = seed_member(&su, workspace, "human").await;
    declare(
        &app,
        workspace,
        manual_on,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(at(Duration::hours(1)))),
        CustomStatusPatch::default(),
    )
    .await;
    put_rule(
        &app,
        workspace,
        manual_on,
        NotificationRule { dnd: true, ..OFF }.into(),
    )
    .await;
    declare(
        &app,
        workspace,
        manual_on,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, manual_on).await,
        NotificationRule { dnd: true, ..OFF },
        "ending DND must not overwrite a pause chosen by hand"
    );

    // Mention-exception-only toggle (pause unchanged, expiry omitted): kept.
    let mention = seed_member(&su, workspace, "human").await;
    let until = at(Duration::hours(1));
    declare(
        &app,
        workspace,
        mention,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(until)),
        CustomStatusPatch::default(),
    )
    .await;
    put_rule(
        &app,
        workspace,
        mention,
        NotificationRuleUpdate {
            dnd: true,
            dnd_until: StatusPatch::Absent,
            mention_overrides_mute: true,
        },
    )
    .await;
    assert_eq!(
        rule(&app, workspace, mention).await,
        NotificationRule {
            dnd: true,
            dnd_until: Some(until),
            mention_overrides_mute: true
        }
    );
    declare(
        &app,
        workspace,
        mention,
        PresenceStatus::Auto,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(
        rule(&app, workspace, mention).await,
        NotificationRule {
            mention_overrides_mute: true,
            ..OFF
        },
        "a mention-only edit keeps the bundle, so ending DND still restores off"
    );
}

/// 단일 tx: the pause is written in the presence write's own transaction — a
/// rollback after it leaves neither the status nor the pause behind.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_bundle_rolls_back_with_the_presence_write() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;

    let outcome: Result<(), DbError> = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_declared_presence_in_tx(
                conn,
                workspace,
                human,
                PresenceStatus::Dnd,
                StatusPatch::Absent,
                CustomStatusPatch::default(),
            )
            .await?;
            Err(DbError::Sqlx(sqlx::Error::RowNotFound))
        })
    })
    .await;
    assert!(outcome.is_err());
    assert_eq!(stored_presence(&su, human).await, "auto");
    assert_eq!(
        bundle_memory(&su, human).await,
        None,
        "no rule row survived the rollback"
    );
    assert_eq!(rule(&app, workspace, human).await, OFF);
}

/// Lazy expiry, no sweeper: after the real DND expiry passes, the own read, the
/// roster and the pause all read "not DND" while the stored columns still say
/// dnd; the next write releases the bundle cleanly.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn an_expired_dnd_reads_as_auto_everywhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    let human = seed_member(&su, workspace, "human").await;

    let until = at(Duration::seconds(2));
    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Dnd,
        StatusPatch::Set(Some(until)),
        CustomStatusPatch::default(),
    )
    .await;
    let wait =
        (until - Utc::now()).to_std().unwrap_or_default() + std::time::Duration::from_millis(500);
    tokio::time::sleep(wait).await;

    assert_eq!(
        stored_presence(&su, human).await,
        "dnd",
        "nothing swept the column"
    );
    let status = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move { presence_status_for(conn, human).await })
    })
    .await
    .expect("read");
    assert_eq!(status, Some(PresenceStatus::Auto));
    let roster = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(
            async move { list_workspace_roster(conn, workspace, human, false, None, 200).await },
        )
    })
    .await
    .expect("roster");
    let row = roster.iter().find(|m| m.id == human).expect("on roster");
    assert_eq!(
        row.presence_status,
        Some(PresenceStatus::Auto),
        "the roster applies the same expiry"
    );
    assert_eq!(
        rule(&app, workspace, human).await,
        OFF,
        "the pause lapsed with DND"
    );

    declare(
        &app,
        workspace,
        human,
        PresenceStatus::Away,
        StatusPatch::Absent,
        CustomStatusPatch::default(),
    )
    .await;
    assert_eq!(bundle_memory(&su, human).await, Some((None, None)));
    assert_eq!(rule(&app, workspace, human).await, OFF);
}
