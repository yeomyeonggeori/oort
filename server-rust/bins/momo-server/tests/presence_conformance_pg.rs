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

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    cent_channel, create_channel, list_workspace_roster, presence_status_for,
    set_presence_status_in_tx, ChannelKind, MemberKind, NewChannel, PresenceStatus,
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
        "/../../../infra/e2e/bootstrap_roles.sql"
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
    assert_eq!(stored_presence(&su, human).await, "dnd", "the write is durable");

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
    assert_eq!(broadcasts.len(), 2, "no broadcast leaks past the two channels");

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
        Box::pin(async move {
            list_workspace_roster(conn, workspace, viewer, false, None, 200).await
        })
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
