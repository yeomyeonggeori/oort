//! ADR-0224 D13 (#5870) — the agent side's one judgment of 「a channel open to people」 and
//! 「a channel open to the requester」, against a real Postgres.
//!
//! DB-backed and `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:pg18`:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:<port>/momo \
//!   cargo test -p momo-workspace-actions --test agent_channel_open_pg \
//!     -- --ignored --test-threads=1
//! ```
//!
//! The team AI's reads run as `momo_worker` (BYPASSRLS), as deployed, so the other-workspace
//! checks prove the statements' own `workspace_id` filters. The agent proposal and the hosted
//! approval paths run as the non-bypass `momo_app` inside a tenant transaction.
//!
//! Every fixture has two public channels that differ only in 「listed in channel browse」: an
//! open one (`listed`) and a closed one (`closed`). The closed one is the subject of every
//! 「0」 below; the open one and the member cases are the 「still reached」 half.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_auth::{
    approve_hosted_oauth_request_in_tx, channel_is_open_to_member_in_tx,
    confirm_hosted_connection_in_tx, grant_hosted_channels_in_tx, HostedConnectionApproval,
    HostedMutation, HostedOauthRefusal, HostedOauthRequestClaims, HOSTED_AGENT_PORT_AUDIENCE,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_workspace_actions::action_resolve::{
    resolve_action_with_origin_in_tx, resolve_visible_channel_in_tx, ArgsOrigin, CardAudience,
    CHANNEL_NAME_LOOKALIKE, OWNER_CANNOT_SEE,
};
use momo_workspace_actions::team_ai;
use momo_workspace_actions::team_ai_tools::{
    enter_helper_read_role, execute_read_tool_in_tx, load_scope_in_tx, Audience, ToolOutcome,
};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

const CLOSED_MARKER: &str = "closed-5870-marker";
const LISTED_MARKER: &str = "listed-5870-marker";

// --- harness -----------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated pgvector/pg18 DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn role_pool(role: &str, env: &str, default_password: &str) -> PgPool {
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(
            opts.username(role)
                .password(&std::env::var(env).unwrap_or_else(|_| default_password.to_string())),
        )
        .await
        .expect("connect as a bootstrap role")
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
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

struct Pools {
    su: PgPool,
    app: PgPool,
    worker: PgPool,
}

async fn pools() -> Pools {
    ensure_schema_and_roles();
    Pools {
        su: superuser_pool().await,
        app: role_pool("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await,
        worker: role_pool("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await,
    }
}

/// A tenant transaction for the non-bypass role: the RLS variable is set for this transaction only.
async fn tenant(pool: &PgPool, workspace: Uuid) -> Transaction<'static, Postgres> {
    let mut tx = pool.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind the tenant");
    tx
}

// --- fixture -----------------------------------------------------------------

async fn workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(id)
        .bind(format!("w5870-{}", id.simple()))
        .execute(su)
        .await
        .expect("workspace");
    id
}

async fn human(su: &PgPool, workspace: Uuid, display: &str, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'human', 'active', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(display)
    .bind(format!("h{}", &id.simple().to_string()[..10]))
    .execute(su)
    .await
    .expect("human member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("workspace membership");
    id
}

/// A live agent with an agent row and an unpaused profile, owned by `owner`.
async fn agent(su: &PgPool, workspace: Uuid, owner: Uuid, display: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent', 'active', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(display)
    .bind(format!("a{}", &id.simple().to_string()[..10]))
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES ($1, $2, 'hosted-agent', 'https://hosted-agent.invalid/disabled', $3, \
                 '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(id)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("agent workspace membership");
    sqlx::query(
        "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused) \
         VALUES ($1, $2, $3, false)",
    )
    .bind(id)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("agent profile");
    id
}

#[derive(Clone, Copy)]
enum Kind {
    /// Public, listed in channel browse.
    Listed,
    /// Public, not listed.
    Closed,
    Private,
    /// Public and listed, but archived.
    ArchivedListed,
    Dm,
}

async fn channel(su: &PgPool, workspace: Uuid, name: &str, kind: Kind, members: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    let (sql_kind, listed, archived) = match kind {
        Kind::Listed => ("public", true, false),
        Kind::Closed => ("public", false, false),
        Kind::Private => ("private", false, false),
        Kind::ArchivedListed => ("public", true, true),
        Kind::Dm => ("dm", false, false),
    };
    let dm_key = matches!(kind, Kind::Dm).then(|| {
        let mut ids: Vec<String> = members.iter().map(Uuid::to_string).collect();
        ids.sort();
        ids.join(":")
    });
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key, browse_listed, archived_at) \
         VALUES ($1, $2, $3::channel_kind, $4, $5, $6, CASE WHEN $7 THEN now() END)",
    )
    .bind(id)
    .bind(workspace)
    .bind(sql_kind)
    .bind(name)
    .bind(dm_key)
    .bind(listed)
    .bind(archived)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(workspace)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(id)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    id
}

async fn post(app: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid, text: &str) {
    let text = text.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            send_message_in_tx(conn, workspace, NewMessage::text(channel, author, text)).await?;
            Ok(())
        })
    })
    .await
    .expect("post");
}

async fn is_member(su: &PgPool, channel: Uuid, member: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM membership \
                         WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
    )
    .bind(channel)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("membership read")
}

async fn handle_of(su: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT handle FROM member WHERE id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("handle")
}

/// One workspace as the table in ADR-0224 D13 needs it.
///
/// * `insider` is in `closed`; `outsider` is not. Both are in `room`.
/// * `seated` (an agent) is in `closed` and `private`; `stray` (an agent) is in neither.
/// * `lobby` is listed and nobody but the owner is in it.
struct Fixture {
    ws: Uuid,
    owner: Uuid,
    insider: Uuid,
    outsider: Uuid,
    guest: Uuid,
    helper: Uuid,
    seated: Uuid,
    stray: Uuid,
    room: Uuid,
    listed: Uuid,
    lobby: Uuid,
    closed: Uuid,
    private: Uuid,
    archived: Uuid,
    guest_room: Uuid,
    helper_dm: Uuid,
    names: Names,
    /// A listed public channel of another workspace.
    elsewhere: Uuid,
}

struct Names {
    listed: String,
    lobby: String,
    closed: String,
    private: String,
    archived: String,
    room: String,
    elsewhere: String,
}

async fn seed(p: &Pools) -> Fixture {
    let ws = workspace(&p.su).await;
    let tag = &ws.simple().to_string()[..8];
    let owner = human(&p.su, ws, "김도현", "owner").await;
    let insider = human(&p.su, ws, "이서연", "member").await;
    let outsider = human(&p.su, ws, "박지훈", "member").await;
    let guest = human(&p.su, ws, "최하늘", "guest").await;
    let helper = with_tenant_tx(&p.app, ws, move |conn| {
        Box::pin(async move { team_ai::enable_in_tx(conn, ws, owner).await })
    })
    .await
    .expect("enable the team AI");
    let seated = agent(&p.su, ws, owner, "앉은 봇").await;
    let stray = agent(&p.su, ws, owner, "떠도는 봇").await;

    let names = Names {
        listed: format!("listed-{tag}"),
        lobby: format!("lobby-{tag}"),
        closed: format!("closed-{tag}"),
        private: format!("private-{tag}"),
        archived: format!("archived-{tag}"),
        room: format!("room-{tag}"),
        elsewhere: format!("elsewhere-{tag}"),
    };
    let room = channel(
        &p.su,
        ws,
        &names.room,
        Kind::Listed,
        &[owner, insider, outsider, helper],
    )
    .await;
    let listed = channel(
        &p.su,
        ws,
        &names.listed,
        Kind::Listed,
        &[owner, insider, outsider],
    )
    .await;
    let lobby = channel(&p.su, ws, &names.lobby, Kind::Listed, &[owner]).await;
    let closed = channel(&p.su, ws, &names.closed, Kind::Closed, &[insider, seated]).await;
    let private = channel(&p.su, ws, &names.private, Kind::Private, &[insider, seated]).await;
    let archived = channel(
        &p.su,
        ws,
        &names.archived,
        Kind::ArchivedListed,
        &[insider, seated],
    )
    .await;
    let guest_room = channel(
        &p.su,
        ws,
        &format!("guests-{tag}"),
        Kind::Listed,
        &[insider, guest, helper],
    )
    .await;
    let helper_dm = channel(
        &p.su,
        ws,
        &format!("dm-{tag}"),
        Kind::Dm,
        &[insider, helper],
    )
    .await;
    post(
        &p.app,
        ws,
        closed,
        insider,
        &format!("closed {CLOSED_MARKER}"),
    )
    .await;
    post(
        &p.app,
        ws,
        listed,
        insider,
        &format!("listed {LISTED_MARKER}"),
    )
    .await;

    let other = workspace(&p.su).await;
    let other_owner = human(&p.su, other, "정민준", "owner").await;
    let elsewhere = channel(&p.su, other, &names.elsewhere, Kind::Listed, &[other_owner]).await;

    Fixture {
        ws,
        owner,
        insider,
        outsider,
        guest,
        helper,
        seated,
        stray,
        room,
        listed,
        lobby,
        closed,
        private,
        archived,
        guest_room,
        helper_dm,
        names,
        elsewhere,
    }
}

async fn read_channel(
    p: &Pools,
    f: &Fixture,
    requester: Uuid,
    reply: Uuid,
    name: &str,
) -> ToolOutcome {
    let mut tx = tenant(&p.worker, f.ws).await;
    let scope = load_scope_in_tx(&mut tx, f.ws, f.helper, requester, reply)
        .await
        .expect("scope");
    enter_helper_read_role(&mut tx).await.expect("read role");
    let outcome = execute_read_tool_in_tx(
        &mut tx,
        &scope,
        "read_channel",
        &json!({"channel": format!("#{name}")}),
    )
    .await
    .expect("read");
    tx.rollback().await.expect("rollback");
    outcome
}

fn carries(outcome: &ToolOutcome, marker: &str) -> bool {
    match outcome {
        ToolOutcome::Data(text) => text.contains(marker),
        ToolOutcome::Document { text, .. } => text.contains(marker),
        _ => false,
    }
}

// --- ① the room the answer goes to -----------------------------------------------

/// D13 row 1: in a room with people, what may be said is the room plus the channels open to
/// people. A closed public channel is not among them, not even for a requester who is in it.
#[tokio::test]
#[ignore]
async fn a_room_hears_only_itself_and_channels_open_to_people() {
    let p = pools().await;
    let f = seed(&p).await;
    // What reaches the answer: the closed channel's text, 0; the listed one's, still there.
    let closed = read_channel(&p, &f, f.insider, f.room, &f.names.closed).await;
    assert_eq!(closed, ToolOutcome::NotVisibleHere);
    assert!(!carries(&closed, CLOSED_MARKER));
    let listed = read_channel(&p, &f, f.insider, f.room, &f.names.listed).await;
    assert!(
        carries(&listed, LISTED_MARKER),
        "a listed channel is still read here"
    );

    // Which channels the room may hear about.
    let mut tx = p.worker.begin().await.expect("begin");
    let scope = load_scope_in_tx(&mut tx, f.ws, f.helper, f.insider, f.room)
        .await
        .expect("scope");
    tx.rollback().await.expect("rollback");
    let Audience::Channels(allowed) = &scope.audience else {
        panic!("a room is a channel list");
    };
    assert!(allowed.contains(&f.room), "the room itself");
    assert!(allowed.contains(&f.listed), "a listed public channel");
    assert!(
        allowed.contains(&f.lobby),
        "a listed one the requester is not in"
    );
    assert!(
        !allowed.contains(&f.closed),
        "a closed public channel is not said in the room"
    );
    assert!(!allowed.contains(&f.private), "a private channel");
    assert!(
        !allowed.contains(&f.archived),
        "an archived channel, listed or not"
    );
    assert!(!allowed.contains(&f.elsewhere), "another workspace");
}

/// The requester's own 1:1 DM with the team AI is their whole view, and a room with a guest is
/// the room alone — both as before.
#[tokio::test]
#[ignore]
async fn the_helper_dm_and_a_guest_room_keep_their_rules() {
    let p = pools().await;
    let f = seed(&p).await;
    let in_dm = read_channel(&p, &f, f.insider, f.helper_dm, &f.names.closed).await;
    assert!(
        carries(&in_dm, CLOSED_MARKER),
        "the requester's own DM sees what they see"
    );
    let private = read_channel(&p, &f, f.insider, f.helper_dm, &f.names.private).await;
    assert!(
        matches!(private, ToolOutcome::Data(_)),
        "a member's private channel in their DM"
    );

    let mut tx = p.worker.begin().await.expect("begin");
    let guests = load_scope_in_tx(&mut tx, f.ws, f.helper, f.insider, f.guest_room)
        .await
        .expect("scope");
    tx.rollback().await.expect("rollback");
    assert!(guests.audience.is_reply_channel_only(f.guest_room));
    let _ = f.guest;
}

/// The read tool is unchanged: it reads only channels the requester is a member of. A channel
/// open to people that the requester is not in is not read, even in their own DM.
#[tokio::test]
#[ignore]
async fn the_team_ai_reads_only_channels_the_requester_is_in() {
    let p = pools().await;
    let f = seed(&p).await;
    let lobby = read_channel(&p, &f, f.insider, f.helper_dm, &f.names.lobby).await;
    assert_eq!(
        lobby,
        ToolOutcome::NotFound,
        "listed but not a member: not read"
    );
    let closed = read_channel(&p, &f, f.outsider, f.room, &f.names.closed).await;
    assert_eq!(closed, ToolOutcome::NotFound, "not a member: not read");
    assert!(!carries(&closed, CLOSED_MARKER));
}

// --- ② the names in the team AI's context ------------------------------------------

/// D13 row 2: the channel names given to the team AI are the ones open to the requester (and the
/// room itself). A requester who is not in the closed channel does not get its name.
#[tokio::test]
#[ignore]
async fn the_team_ai_is_told_only_names_open_to_the_requester() {
    let p = pools().await;
    let f = seed(&p).await;
    let names_for = |requester: Uuid| {
        let worker = p.worker.clone();
        let (ws, room) = (f.ws, f.room);
        async move {
            let mut tx = worker.begin().await.expect("begin");
            let roster = team_ai::load_roster_in_tx(&mut tx, ws, requester, room)
                .await
                .expect("roster");
            tx.rollback().await.expect("rollback");
            roster.channels
        }
    };
    let outsider = names_for(f.outsider).await;
    assert!(!outsider.contains(&f.names.closed), "not a member: no name");
    assert!(outsider.contains(&f.names.listed));
    assert!(outsider.contains(&f.names.lobby), "listed: named to anyone");
    assert!(outsider.contains(&f.names.room), "the room itself");
    for absent in [&f.names.private, &f.names.archived, &f.names.elsewhere] {
        assert!(!outsider.contains(absent), "{absent} is never named");
    }

    let insider = names_for(f.insider).await;
    assert!(insider.contains(&f.names.closed), "a member keeps the name");
    assert!(
        !insider.contains(&f.names.private),
        "a private name is not added"
    );
    assert!(!insider.contains(&f.names.archived));
}

// --- ③ an agent's name lookup --------------------------------------------------------

/// D13 row 3: an agent finds by name a channel open to people or one it sits in.
#[tokio::test]
#[ignore]
async fn an_agent_finds_by_name_only_channels_open_to_people_or_its_own() {
    let p = pools().await;
    let f = seed(&p).await;
    let cases = [
        (f.stray, &f.names.closed, None, "closed, not seated"),
        (f.seated, &f.names.closed, Some(f.closed), "its own"),
        (f.stray, &f.names.listed, Some(f.listed), "listed"),
        (f.stray, &f.names.private, None, "private, not seated"),
        (
            f.seated,
            &f.names.private,
            Some(f.private),
            "its own private",
        ),
        (f.seated, &f.names.archived, None, "archived"),
        (f.stray, &f.names.elsewhere, None, "another workspace"),
    ];
    let mut tx = tenant(&p.app, f.ws).await;
    for (agent, name, expected, why) in cases {
        let found = resolve_visible_channel_in_tx(&mut tx, f.ws, agent, name)
            .await
            .expect("resolve")
            .map(|channel| channel.id);
        assert_eq!(found, expected, "{why}");
    }
    tx.rollback().await.expect("rollback");
}

/// A look-alike check on a proposal compares only names the agent can find, so a refusal never
/// names a closed channel to an agent that is not in it.
#[tokio::test]
#[ignore]
async fn a_proposals_lookalike_check_sees_only_channels_open_to_the_agent() {
    let p = pools().await;
    let f = seed(&p).await;
    let action = momo_agent::actions::action_by_id(momo_agent::actions::ACTION_CHANNEL_CREATE)
        .expect("channel.create");
    // The same letters with a Cyrillic small ie (U+0435) for the first Latin e.
    let lookalike = |name: &str| name.replacen('e', "\u{435}", 1);
    let refused = |agent: Uuid, name: String| {
        let app = p.app.clone();
        let ws = f.ws;
        async move {
            let mut tx = tenant(&app, ws).await;
            let outcome = resolve_action_with_origin_in_tx(
                &mut tx,
                ws,
                agent,
                None,
                action,
                &json!({"name": name, "kind": "private"}),
                0,
                ArgsOrigin::Proposal,
                None,
                CardAudience::RunChannel,
                None,
            )
            .await
            .expect("resolve");
            tx.rollback().await.expect("rollback");
            matches!(outcome, Err(ref rejection) if rejection.message == CHANNEL_NAME_LOOKALIKE)
        }
    };
    assert!(
        !refused(f.stray, lookalike(&f.names.closed)).await,
        "closed, not seated"
    );
    assert!(
        refused(f.seated, lookalike(&f.names.closed)).await,
        "its own channel"
    );
    assert!(
        refused(f.stray, lookalike(&f.names.listed)).await,
        "a listed channel"
    );
}

/// A card nobody asked for stands in the owner's DM: it may name only a channel open to the
/// owner.
#[tokio::test]
#[ignore]
async fn an_unasked_card_names_only_channels_open_to_its_reader() {
    let p = pools().await;
    let f = seed(&p).await;
    let action = momo_agent::actions::action_by_id(momo_agent::actions::ACTION_CHANNEL_MEMBER_ADD)
        .expect("channel.member.add");
    let target = handle_of(&p.su, f.outsider).await;
    let owner_cannot_see = |reader: Uuid, channel: String| {
        let app = p.app.clone();
        let (ws, seated, target) = (f.ws, f.seated, target.clone());
        async move {
            let mut tx = tenant(&app, ws).await;
            let outcome = resolve_action_with_origin_in_tx(
                &mut tx,
                ws,
                seated,
                None,
                action,
                &json!({"channel": channel, "memberHandles": [target]}),
                0,
                ArgsOrigin::Proposal,
                None,
                CardAudience::Owner(reader),
                None,
            )
            .await
            .expect("resolve");
            tx.rollback().await.expect("rollback");
            matches!(outcome, Err(ref rejection) if rejection.message == OWNER_CANNOT_SEE)
        }
    };
    assert!(
        owner_cannot_see(f.owner, f.names.closed.clone()).await,
        "closed, owner not in it"
    );
    assert!(
        !owner_cannot_see(f.insider, f.names.closed.clone()).await,
        "the reader is in it"
    );
    assert!(
        owner_cannot_see(f.owner, f.names.private.clone()).await,
        "private, as before"
    );
    assert!(
        !owner_cannot_see(f.outsider, f.names.lobby.clone()).await,
        "listed, the reader is not in it"
    );
}

// --- ④ the two approval doors ---------------------------------------------------------

/// Ends every live connection of `agent` (a workspace keeps one live connection per agent), so
/// each call below starts from a fresh one.
async fn retire_connections(su: &PgPool, ws: Uuid, agent: Uuid) {
    sqlx::query(
        "UPDATE token SET revoked_at = now() \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND hosted_connection_id IS NOT NULL",
    )
    .bind(ws)
    .bind(agent)
    .execute(su)
    .await
    .expect("revoke bearers");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'expired', active_token_id = NULL \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND status <> 'expired'",
    )
    .bind(ws)
    .bind(agent)
    .execute(su)
    .await
    .expect("end live connections");
}

/// An `active`, proved connection for `agent` with nothing approved yet.
async fn live_connection(su: &PgPool, ws: Uuid, owner: Uuid, agent: Uuid) -> Uuid {
    retire_connections(su, ws, agent).await;
    let connection = Uuid::new_v4();
    let scopes = vec!["agent:port:connect".to_string()];
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id, workspace_id, agent_member_id, status, pairing_consumed_at, detected_at, \
           detected_by, confirmed_by, confirmed_at, approved_scopes, created_by) \
         VALUES ($1, $2, $3, 'detected', now(), now(), $3, $4, now(), $5, $4)",
    )
    .bind(connection)
    .bind(ws)
    .bind(agent)
    .bind(owner)
    .bind(&scopes)
    .execute(su)
    .await
    .expect("connection");
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                            credential_class, hosted_connection_id, audience, created_by) \
         VALUES ($1, 'agent_bearer', $2, digest($3::text, 'sha256'), $4, 'hosted agent port', \
                 'hosted_active', $5, $6, $7) RETURNING id",
    )
    .bind(ws)
    .bind(agent)
    .bind(format!("fixture-{}", Uuid::new_v4()))
    .bind(&scopes)
    .bind(connection)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .bind(owner)
    .fetch_one(su)
    .await
    .expect("bearer row");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'active', active_token_id = $3, \
           proved_at = now(), proved_by = $4 WHERE workspace_id = $1 AND id = $2",
    )
    .bind(ws)
    .bind(connection)
    .bind(token)
    .bind(agent)
    .execute(su)
    .await
    .expect("activate");
    connection
}

async fn grant(p: &Pools, f: &Fixture, agent: Uuid, channels: &[Uuid]) -> bool {
    let connection = live_connection(&p.su, f.ws, f.owner, agent).await;
    let mut tx = tenant(&p.app, f.ws).await;
    let granted = grant_hosted_channels_in_tx(&mut tx, f.ws, connection, agent, channels)
        .await
        .expect("grant");
    tx.commit().await.expect("commit");
    granted.is_some()
}

/// D13 row 4: the hosted connection's channel grant takes a channel open to people or one the
/// agent already sits in — nothing else, and nothing is written on a refusal.
#[tokio::test]
#[ignore]
async fn the_hosted_grant_takes_only_channels_open_to_people_or_already_seated() {
    let p = pools().await;
    let f = seed(&p).await;
    assert!(
        !grant(&p, &f, f.stray, &[f.closed]).await,
        "closed, not seated"
    );
    assert!(
        !is_member(&p.su, f.closed, f.stray).await,
        "and not seated by the refusal"
    );
    assert!(
        !grant(&p, &f, f.stray, &[f.listed, f.closed]).await,
        "all or nothing"
    );
    assert!(!is_member(&p.su, f.listed, f.stray).await);
    assert!(
        !grant(&p, &f, f.stray, &[f.private]).await,
        "private, not seated"
    );
    assert!(
        !grant(&p, &f, f.stray, &[f.elsewhere]).await,
        "another workspace"
    );
    assert!(
        grant(&p, &f, f.stray, &[f.listed]).await,
        "a listed channel"
    );
    assert!(is_member(&p.su, f.listed, f.stray).await);
}

#[tokio::test]
#[ignore]
async fn the_hosted_grant_keeps_a_channel_the_agent_already_sits_in() {
    let p = pools().await;
    let f = seed(&p).await;
    assert!(grant(&p, &f, f.seated, &[f.closed, f.private]).await);
}

fn oauth_claims() -> HostedOauthRequestClaims {
    HostedOauthRequestClaims {
        jti: Uuid::new_v4().to_string(),
        cid: "fixture-client".into(),
        ru: "https://client.invalid/callback".into(),
        res: "https://oort.invalid/v1/mcp/agent-port".into(),
        scp: vec!["agent:port:connect".into()],
        cc: "c".repeat(43),
        ccm: "S256".into(),
        st: None,
        exp: 0,
        iat: 0,
        typ: "fixture".into(),
    }
}

async fn oauth_approve(p: &Pools, f: &Fixture, agent: Uuid, channels: &[Uuid]) -> bool {
    retire_connections(&p.su, f.ws, agent).await;
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection (id, workspace_id, agent_member_id, status, \
                                              auth_mode, created_by) \
         VALUES ($1, $2, $3, 'pairing_pending', 'oauth', $4)",
    )
    .bind(connection)
    .bind(f.ws)
    .bind(agent)
    .bind(f.owner)
    .execute(&p.su)
    .await
    .expect("oauth connection");
    let mut tx = tenant(&p.app, f.ws).await;
    let outcome = approve_hosted_oauth_request_in_tx(
        &mut tx,
        f.ws,
        connection,
        f.owner,
        &oauth_claims(),
        &["agent:port:connect".to_string()],
        channels,
    )
    .await
    .expect("approve");
    tx.commit().await.expect("commit");
    match outcome {
        Ok(_) => true,
        Err(HostedOauthRefusal::InvalidApproval) => false,
        Err(other) => panic!("unexpected refusal {other:?}"),
    }
}

/// D13 row 5: the OAuth consent takes the same channels as the grant.
#[tokio::test]
#[ignore]
async fn the_oauth_consent_takes_only_channels_open_to_people_or_already_seated() {
    let p = pools().await;
    let f = seed(&p).await;
    assert!(
        !oauth_approve(&p, &f, f.stray, &[f.closed]).await,
        "closed, not seated"
    );
    assert!(!is_member(&p.su, f.closed, f.stray).await);
    assert!(
        !oauth_approve(&p, &f, f.stray, &[f.private]).await,
        "private, not seated"
    );
    assert!(
        !oauth_approve(&p, &f, f.stray, &[f.elsewhere]).await,
        "another workspace"
    );
    assert!(
        oauth_approve(&p, &f, f.stray, &[f.listed]).await,
        "a listed channel"
    );
    assert!(is_member(&p.su, f.listed, f.stray).await);
    assert!(
        oauth_approve(&p, &f, f.seated, &[f.closed, f.private]).await,
        "already seated"
    );
}

async fn static_confirm(p: &Pools, f: &Fixture, agent: Uuid, channels: &[Uuid]) -> bool {
    retire_connections(&p.su, f.ws, agent).await;
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection (id, workspace_id, agent_member_id, status, \
           pairing_consumed_at, detected_at, detected_by, created_by) \
         VALUES ($1, $2, $3, 'detected', now(), now(), $3, $4)",
    )
    .bind(connection)
    .bind(f.ws)
    .bind(agent)
    .bind(f.owner)
    .execute(&p.su)
    .await
    .expect("detected connection");
    let approval = HostedConnectionApproval {
        agent_member_id: agent,
        auth_mode: "static_bearer".into(),
        audience: HOSTED_AGENT_PORT_AUDIENCE.into(),
        channel_ids: channels.to_vec(),
        scopes: vec!["agent:port:connect".into()],
    };
    let mut tx = tenant(&p.app, f.ws).await;
    let outcome = confirm_hosted_connection_in_tx(&mut tx, f.ws, connection, f.owner, &approval)
        .await
        .expect("confirm");
    tx.commit().await.expect("commit");
    match outcome {
        HostedMutation::Applied(_) => true,
        HostedMutation::InvalidApproval => false,
        _ => panic!("unexpected confirm outcome"),
    }
}

/// The static connection's confirm is the third writer of the approved channels and takes the
/// same channels.
#[tokio::test]
#[ignore]
async fn the_static_confirm_takes_only_channels_open_to_people_or_already_seated() {
    let p = pools().await;
    let f = seed(&p).await;
    assert!(
        !static_confirm(&p, &f, f.stray, &[f.closed]).await,
        "closed, not seated"
    );
    assert!(!is_member(&p.su, f.closed, f.stray).await);
    assert!(
        !static_confirm(&p, &f, f.stray, &[f.private]).await,
        "private, not seated"
    );
    assert!(
        !static_confirm(&p, &f, f.stray, &[f.elsewhere]).await,
        "another workspace"
    );
    assert!(
        static_confirm(&p, &f, f.stray, &[f.listed]).await,
        "a listed channel"
    );
    assert!(
        static_confirm(&p, &f, f.seated, &[f.closed, f.private]).await,
        "already seated"
    );
}

// --- the judgment itself ------------------------------------------------------------------

/// The judgment against the D13 table, one cell per (channel, member).
#[tokio::test]
#[ignore]
async fn the_judgment_is_open_to_people_or_a_member() {
    let p = pools().await;
    let f = seed(&p).await;
    let cases = [
        (f.listed, f.outsider, true, "listed, not in it"),
        (f.lobby, f.stray, true, "listed, an agent not in it"),
        (f.closed, f.outsider, false, "closed, not in it"),
        (f.closed, f.stray, false, "closed, an agent not in it"),
        (f.closed, f.insider, true, "closed, in it"),
        (f.closed, f.seated, true, "closed, an agent in it"),
        (f.private, f.outsider, false, "private, not in it"),
        (f.private, f.insider, true, "private, in it"),
        (
            f.archived,
            f.outsider,
            false,
            "archived and listed, not in it",
        ),
        (f.elsewhere, f.outsider, false, "another workspace"),
    ];
    let mut tx = tenant(&p.app, f.ws).await;
    for (channel, member, expected, why) in cases {
        let open = channel_is_open_to_member_in_tx(&mut tx, f.ws, channel, member)
            .await
            .expect("judge");
        assert_eq!(open, expected, "{why}");
    }
    tx.rollback().await.expect("rollback");
}
