//! DB-backed conformance for **ADR-0204 D7** (#3928) — the people an approval push
//! wakes are the people the decision route lets through.
//!
//! A lock-screen 승인 button that answers 403 is worse than no button. The push
//! judgment (`momo_push::judge_targets`) therefore asks, for every person in the
//! room, the question the decision route asks before it takes their verdict — and
//! it asks it by calling the functions the route calls (`momo_agent::decider_gate`,
//! `active_workspace_role`, `agent_owner_in_tx`, `remote_host_owner_in_tx`), so the
//! two cannot grow different opinions in code. This suite measures that they do not
//! in **behaviour**: it puts the same approval in front of the same people, once to
//! the real router (on `momo_app`, NOBYPASSRLS, with a real login for every person)
//! and once to the real judgment (on `momo_notifier`), and compares.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test approval_push_audience_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! ## What is compared
//!
//! For each approval shape × each of five people, a **fresh** approval row (a
//! decision changes state, and a role refusal does not consume the card but a
//! success does) is shown to both readers:
//!
//! * the route — `POST …/approvals/{id}/decision` with `approve: true` (the approve
//!   half is the audience: the notification asks for an 승인). Refused by the role /
//!   owner condition means HTTP 403 with receipt status `role_required` or
//!   `remote_host_owner_required`. **Anything else that is a real answer counts as
//!   having passed those conditions**: what happens after them (the action executes,
//!   its stored arguments have gone stale, an agent's spawn is not taken onto a
//!   member's own machine) is not this suite's question. A 401, a 404 or a 5xx is
//!   not a real answer and fails the suite, so a route that is down cannot make
//!   everybody look allowed.
//! * the judgment — is the person among `judge_targets`' targets for the card's
//!   message.
//!
//! The table below says, by hand and without reading the code under test, who may
//! approve what. Both readers are held to it, so the suite is not satisfied by two
//! readers that drift **together** (the failure a shared function could otherwise
//! hide: make `decider_gate` always answer "any member", and the route and the push
//! both agree — on the wrong thing).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_people_an_approval_push_wakes_are_the_people_the_decision_route_lets_through` | `decider_gate` ignoring the registry role; `judge_targets` skipping `may_approve_in_tx`; `may_approve_in_tx` dropping its role arm, its agent-owner arm or its host-owner arm |
//! | `a_spawn_the_card_sits_on_a_team_box_wakes_the_whole_room` | `reference_execution_host` naming the requested host before the card's default |
//! | `an_approver_who_would_redirect_a_spawn_to_a_team_box_is_the_one_person_the_push_leaves_out` | (documents the one approximation: the route judges the decider's pick, the push the card's host) |

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "approval-audience-conformance-secret";
const TEST_PASSWORD: &str = "approval-audience-password";
const TOOL: &str = "codex";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn password_of(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
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
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

fn app_state(pool: PgPool) -> AppState {
    AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
}

async fn start_server(pool: PgPool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let router = build_app(app_state(pool));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// the room: one person for every answer the decision route's conditions can give
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Who {
    /// A workspace owner: passes every role condition.
    Owner,
    /// A workspace admin: passes every role condition.
    Admin,
    /// A plain member: decides a tool call and nothing gated.
    Member,
    /// A plain member who owns the agent an `agent_editor` card is about.
    AgentOwner,
    /// A plain member who owns the one member-scoped work host.
    HostOwner,
}

const EVERYONE: [Who; 5] = [
    Who::Owner,
    Who::Admin,
    Who::Member,
    Who::AgentOwner,
    Who::HostOwner,
];

struct Room {
    workspace: Uuid,
    channel: Uuid,
    /// The agent that asks for tool calls, workspace actions of its own and spawns.
    /// Its owner is [`Who::HostOwner`], so that person's laptop is what a spawn
    /// card defaults to (ADR-0125 D6-A, 로컬 온라인 우선).
    requester: Uuid,
    /// The agent an `agent_editor` card is about (it proposes the rename of
    /// itself); owned by [`Who::AgentOwner`].
    pet: Uuid,
    people: BTreeMap<Who, Uuid>,
    emails: BTreeMap<Who, String>,
    /// A member-scoped host owned by [`Who::HostOwner`].
    laptop: Uuid,
    /// A workspace-scoped host.
    team_box: Uuid,
}

impl Room {
    fn who_is(&self, member: Uuid) -> Option<Who> {
        self.people
            .iter()
            .find(|(_, id)| **id == member)
            .map(|(who, _)| *who)
    }
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, name: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@audience.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(name)
    .bind(human.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(human)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (human, email)
}

async fn seed_agent(su: &PgPool, workspace: Uuid, handle: &str, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    agent
}

async fn seed_host(su: &PgPool, workspace: Uuid, scope: &str, owner: Uuid, kind: &str) -> Uuid {
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, public_key, \
            capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(workspace)
    .bind(scope)
    .bind(owner)
    .bind(kind)
    .bind(format!("{scope}-host"))
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed work host");
    host
}

async fn seed_tool_profile(su: &PgPool, workspace: Uuid, by: Uuid, tool: &str) {
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, true, $4, $4) \
         ON CONFLICT (workspace_id, tool_key) \
         DO UPDATE SET enabled = true, launch_template = EXCLUDED.launch_template",
    )
    .bind(workspace)
    .bind(tool)
    .bind(json!({"command": tool, "arguments": []}))
    .bind(by)
    .execute(su)
    .await
    .expect("seed work tool profile");
}

async fn seed_room(su: &PgPool) -> Room {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let mut people = BTreeMap::new();
    let mut emails = BTreeMap::new();
    for (who, role) in [
        (Who::Owner, "owner"),
        (Who::Admin, "admin"),
        (Who::Member, "member"),
        (Who::AgentOwner, "member"),
        (Who::HostOwner, "member"),
    ] {
        let (id, email) = seed_human(su, workspace, role, &format!("{who:?}")).await;
        people.insert(who, id);
        emails.insert(who, email);
    }
    seed_tool_profile(su, workspace, people[&Who::Owner], TOOL).await;

    let requester = seed_agent(su, workspace, "requester", people[&Who::HostOwner]).await;
    let pet = seed_agent(su, workspace, "pet", people[&Who::AgentOwner]).await;

    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel)
        .bind(workspace)
        .bind(format!("room-{}", &channel.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in people.values().copied().chain([requester, pet]) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
        // Every human has a device, or `judge_targets` would drop them at its
        // `push_token` join and "not woken" would prove nothing.
        if people.values().any(|human| *human == member) {
            seed_device(su, workspace, member).await;
        }
    }

    let laptop = seed_host(su, workspace, "member", people[&Who::HostOwner], "app").await;
    let team_box = seed_host(su, workspace, "workspace", people[&Who::Owner], "workd").await;

    Room {
        workspace,
        channel,
        requester,
        pet,
        people,
        emails,
        laptop,
        team_box,
    }
}

async fn seed_device(su: &PgPool, workspace: Uuid, member: Uuid) {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed push token");
}

// ---------------------------------------------------------------------------
// cards: the approvals under test
// ---------------------------------------------------------------------------

/// Which host the decider names with the decision, if any.
#[derive(Clone, Copy)]
enum Pick {
    None,
    Laptop,
    TeamBox,
}

/// How a card comes to exist.
enum Kind {
    /// A tool call the requesting agent parked on.
    ToolCall,
    /// A workspace action the named agent proposed.
    Action {
        id: &'static str,
        args: Value,
        /// The agent that proposes — and, for an `agent_editor` action with no
        /// `targetHandle`, the agent the action is about.
        proposer: Proposer,
    },
    /// A spawn as the REST control ledger writes it (a real agent bearer asks;
    /// the server draws the card, defaulting to the owner's online laptop).
    SpawnFromTheLedger,
    /// A spawn card written by hand, to choose the default and requested hosts.
    SpawnByHand {
        default_host: Option<Host>,
        requested_host: Option<Host>,
    },
}

#[derive(Clone, Copy)]
enum Proposer {
    Requester,
    Pet,
}

#[derive(Clone, Copy)]
enum Host {
    Laptop,
    TeamBox,
}

struct Case {
    label: &'static str,
    kind: Kind,
    /// The host each decider names (a card with no default needs one to be decidable
    /// at all).
    pick: Pick,
    /// Who may approve it, by the ADR and the registry — written by hand.
    may_approve: Vec<Who>,
}

fn cases() -> Vec<Case> {
    let admins = vec![Who::Owner, Who::Admin];
    vec![
        Case {
            label: "a tool call: any member of the room",
            kind: Kind::ToolCall,
            pick: Pick::None,
            may_approve: EVERYONE.to_vec(),
        },
        Case {
            label: "channel.create: workspace admins",
            kind: Kind::Action {
                id: "channel.create",
                args: json!({"name": format!("aud-{}", &Uuid::new_v4().simple().to_string()[..8]), "kind": "public"}),
                proposer: Proposer::Requester,
            },
            pick: Pick::None,
            may_approve: admins.clone(),
        },
        Case {
            label: "workspace.settings.update: operator scope or admin (nobody here has the scope)",
            kind: Kind::Action {
                id: "workspace.settings.update",
                args: json!({"welcomePrompt": "hello"}),
                proposer: Proposer::Requester,
            },
            pick: Pick::None,
            may_approve: admins.clone(),
        },
        Case {
            label: "agent.rename: admins and the target agent's owner",
            kind: Kind::Action {
                id: "agent.rename",
                args: json!({"displayName": "Renamed Pet"}),
                proposer: Proposer::Pet,
            },
            pick: Pick::None,
            may_approve: vec![Who::Owner, Who::Admin, Who::AgentOwner],
        },
        Case {
            label: "invite.create: workspace admins",
            kind: Kind::Action {
                id: "invite.create",
                args: json!({}),
                proposer: Proposer::Requester,
            },
            pick: Pick::None,
            may_approve: admins.clone(),
        },
        Case {
            label: "agent.invite: workspace admins",
            kind: Kind::Action {
                id: "agent.invite",
                args: json!({
                    "platform": "other",
                    "displayName": "Newcomer",
                    "handle": format!("newcomer{}", &Uuid::new_v4().simple().to_string()[..8]),
                }),
                proposer: Proposer::Requester,
            },
            pick: Pick::None,
            may_approve: admins,
        },
        Case {
            label: "a spawn from the control ledger, defaulting to the owner's laptop: that owner",
            kind: Kind::SpawnFromTheLedger,
            pick: Pick::None,
            may_approve: vec![Who::HostOwner],
        },
        Case {
            label: "a spawn whose request named a laptop and whose card chose nothing: that owner",
            kind: Kind::SpawnByHand {
                default_host: None,
                requested_host: Some(Host::Laptop),
            },
            pick: Pick::Laptop,
            may_approve: vec![Who::HostOwner],
        },
    ]
}

/// A run of its own for every card: `approve_run` requeues a parked one, and a
/// spawn from the ledger needs a live one to hang its control on.
async fn seed_run(su: &PgPool, room: &Room, agent: Uuid, kind: &str, status: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7)",
    )
    .bind(run)
    .bind(room.workspace)
    .bind(agent)
    .bind(room.channel)
    .bind(status)
    .bind(json!({"type": kind, "title": "audience", "brief": "audience"}))
    .bind(format!("audience:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

fn host_id(room: &Room, host: Host) -> Uuid {
    match host {
        Host::Laptop => room.laptop,
        Host::TeamBox => room.team_box,
    }
}

fn spawn_execution(room: &Room, default_host: Option<Uuid>, requested: Option<Uuid>) -> Value {
    json!({
        "kind": "work_session_spawn",
        "tool": TOOL,
        "label": "audience",
        "requested_host_id": requested.map(|id| id.to_string()),
        "default_host_id": default_host.map(|id| id.to_string()),
        "host_candidates": [
            {"host_id": room.laptop.to_string(), "selectable": true},
            {"host_id": room.team_box.to_string(), "selectable": true},
        ],
    })
}

/// An `approval_request` card and the `approval` row it renders, as the producers
/// leave them (the message insert fires the 011 push-candidate trigger).
async fn insert_card(
    su: &PgPool,
    room: &Room,
    run: Uuid,
    requested_by: Uuid,
    action_type: &str,
    payload: &Value,
) -> (Uuid, Uuid) {
    let approval = Uuid::new_v4();
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 \
          WHERE channel_id = $1 AND workspace_id = $2 RETURNING last_seq",
    )
    .bind(room.channel)
    .bind(room.workspace)
    .fetch_one(su)
    .await
    .expect("take the next channel seq");
    let message: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'Approve it', \
                 jsonb_build_object('approval_id', $5::text, 'action_type', $6::text)) \
         RETURNING id",
    )
    .bind(room.workspace)
    .bind(room.channel)
    .bind(seq)
    .bind(requested_by)
    .bind(approval.to_string())
    .bind(action_type)
    .fetch_one(su)
    .await
    .expect("insert approval_request card");
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + interval '1 hour')",
    )
    .bind(approval)
    .bind(room.workspace)
    .bind(run)
    .bind(room.channel)
    .bind(message)
    .bind(requested_by)
    .bind(action_type)
    .bind(payload)
    .execute(su)
    .await
    .expect("insert approval");
    (approval, message)
}

struct Env {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    bearer: String,
}

/// The agent's bearer, carrying `work:control`.
async fn agent_bearer(su: &PgPool, room: &Room) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", room.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'audience-conformance')",
    )
    .bind(room.workspace)
    .bind(room.requester)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// Draw one card of `kind` and return `(approval id, request message id)`.
async fn make_card(env: &Env, room: &Room, kind: &Kind) -> (Uuid, Uuid) {
    match kind {
        Kind::ToolCall => {
            let run = seed_run(&env.su, room, room.requester, "chat", "awaiting_approval").await;
            insert_card(
                &env.su,
                room,
                run,
                room.requester,
                "tool_call",
                &json!({"tool_call": {"call_id": "c1", "name": "send_message", "arguments": {}}}),
            )
            .await
        }
        Kind::Action { id, args, proposer } => {
            let agent = match proposer {
                Proposer::Requester => room.requester,
                Proposer::Pet => room.pet,
            };
            let run = seed_run(&env.su, room, agent, "chat", "awaiting_approval").await;
            // The pins a card carries are what the action's resolver would derive
            // today; only the `agent_editor` action is judged against them before
            // the role gate has answered, so only its pin is written.
            let pins = match *id {
                "agent.rename" => json!({"target": room.pet.to_string()}),
                _ => json!({}),
            };
            insert_card(
                &env.su,
                room,
                run,
                agent,
                "workspace_action",
                &json!({"action": {"id": id, "args": args, "pins": pins}}),
            )
            .await
        }
        Kind::SpawnFromTheLedger => {
            let run = seed_run(&env.su, room, room.requester, "work", "running").await;
            let response = env
                .http
                .post(format!(
                    "{}/v1/workspaces/{}/work-controls",
                    env.base, room.workspace
                ))
                .bearer_auth(&env.bearer)
                .json(&json!({
                    "channelId": room.channel,
                    "runId": run,
                    "targetHostId": room.team_box,
                    "kind": "spawn",
                    "payload": {"tool": TOOL, "label": "audience"},
                }))
                .send()
                .await
                .expect("agent asks for a spawn");
            assert_eq!(response.status(), 201, "an agent may ask for a spawn");
            let body: Value = response.json().await.expect("control body");
            let control = body["workControl"]["id"]
                .as_str()
                .expect("control id")
                .to_string();
            let approval: Uuid = sqlx::query_scalar(
                "SELECT id FROM approval \
                  WHERE payload->>'work_control_id' = $1 AND status = 'pending'",
            )
            .bind(&control)
            .fetch_one(&env.su)
            .await
            .expect("the spawn raised one pending approval");
            let message: Uuid =
                sqlx::query_scalar("SELECT request_message_id FROM approval WHERE id = $1")
                    .bind(approval)
                    .fetch_one(&env.su)
                    .await
                    .expect("the approval's card");
            // The producer's own card, not a stand-in: it defaults to the laptop.
            let default: Option<String> = sqlx::query_scalar(
                "SELECT payload->'execution'->>'default_host_id' FROM approval WHERE id = $1",
            )
            .bind(approval)
            .fetch_one(&env.su)
            .await
            .expect("card default host");
            assert_eq!(
                default.as_deref(),
                Some(room.laptop.to_string().as_str()),
                "the ledger draws the card on the owner's online laptop"
            );
            (approval, message)
        }
        Kind::SpawnByHand {
            default_host,
            requested_host,
        } => {
            let run = seed_run(&env.su, room, room.requester, "work", "awaiting_approval").await;
            let payload = json!({
                "execution": spawn_execution(
                    room,
                    default_host.map(|host| host_id(room, host)),
                    requested_host.map(|host| host_id(room, host)),
                )
            });
            insert_card(&env.su, room, run, room.requester, "work.spawn", &payload).await
        }
    }
}

// ---------------------------------------------------------------------------
// the two readers
// ---------------------------------------------------------------------------

async fn login(env: &Env, room: &Room, who: Who) -> String {
    let response = env
        .http
        .post(format!("{}/v1/auth/login", env.base))
        .json(&json!({
            "email": room.emails[&who],
            "password": TEST_PASSWORD,
            "workspace": room.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "{who:?} logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

/// The decision route's answer: `(HTTP status, body)`.
async fn decide(env: &Env, room: &Room, token: &str, approval: Uuid, pick: Pick) -> (u16, Value) {
    let mut body = json!({
        "approval_id": approval,
        "approve": true,
        "client_decision_id": Uuid::new_v4(),
    });
    match pick {
        Pick::None => {}
        Pick::Laptop => body["hostId"] = json!(room.laptop),
        Pick::TeamBox => body["hostId"] = json!(room.team_box),
    }
    let response = env
        .http
        .post(format!(
            "{}/v1/workspaces/{}/approvals/{approval}/decision",
            env.base, room.workspace
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("decide approval");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// What a person who got **past** the role and owner conditions is seen to receive in
/// this fixture. A closed list on purpose: "anything that is not the gate refusal"
/// would read a route that fails for an unrelated reason (a 400, a 429, a different
/// 403) as "let through", and the suite would agree with a broken route. A new,
/// legitimate outcome fails loudly here and is added with its reason.
const PASSED: &[(u16, &str)] = &[
    // The decision was recorded (and, for a workspace action, executed).
    (200, "approved"),
    // The hand-written card's stored arguments or pins no longer prove against the
    // workspace — the route answers that only to a decider the gates let through.
    (409, "action_args_invalid"),
    // An agent's spawn is never approved onto a member's own machine, its owner
    // included (ADR-0188 R0.1 A'): the owner passed the owner condition and meets the
    // next rule.
    (403, "member_host_agent_control_refused"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Verdict {
    /// Refused by the role or owner condition — the two refusals the push audience
    /// mirrors.
    Gate(String),
    /// Got past both conditions, with an outcome in [`PASSED`]. What follows is not
    /// this suite's question.
    Passed(u16, String),
    /// Not a recognised answer: unauthenticated, missing, a server fault, or an
    /// outcome this suite has not been told about.
    Broken(u16, String),
}

fn classify(status: u16, receipt: &Value) -> Verdict {
    let code = receipt["status"].as_str().unwrap_or("").to_string();
    if status == 403 && (code == "role_required" || code == "remote_host_owner_required") {
        Verdict::Gate(code)
    } else if PASSED.contains(&(status, code.as_str())) {
        Verdict::Passed(status, code)
    } else {
        Verdict::Broken(status, receipt.to_string())
    }
}

/// Who `judge_targets` pushes for this card's message.
async fn woken(notifier: &PgPool, room: &Room, message: Uuid) -> BTreeSet<Who> {
    let mut conn = notifier.acquire().await.expect("acquire notifier");
    let targets = momo_push::judge_targets(&mut conn, room.workspace, message)
        .await
        .expect("judge_targets");
    targets
        .iter()
        .map(|target| {
            room.who_is(target.member_id)
                .unwrap_or_else(|| panic!("an unexpected target: {target:?}"))
        })
        .collect()
}

/// Everything this test enqueued (push candidates, agent jobs, broadcasts) is
/// settled, so a later suite's global claim never meets it.
async fn settle(su: &PgPool, room: &Room) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE workspace_id = $1 AND status IN ('pending', 'processing')",
    )
    .bind(room.workspace)
    .execute(su)
    .await
    .expect("settle this workspace's outbox rows");
}

#[derive(Clone)]
struct Row {
    case: &'static str,
    who: Who,
    may_approve: bool,
    woken: bool,
    verdict: Verdict,
}

fn render(rows: &[Row]) -> String {
    rows.iter()
        .map(|row| {
            let route = match &row.verdict {
                Verdict::Gate(code) => format!("refused({code})"),
                Verdict::Passed(status, code) => format!("passed({status} {code})"),
                Verdict::Broken(status, body) => format!("BROKEN({status} {body})"),
            };
            format!(
                "  {:<10} expected={:<5} woken={:<5} route={route}   [{}]",
                format!("{:?}", row.who),
                row.may_approve,
                row.woken,
                row.case
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// **The invariant (ADR-0204 D7).** For every approval shape and every person: the
/// person is woken exactly when the real decision route would let them through its
/// role and owner conditions — and both are held to the hand-written table.
///
/// Revert any of the following and a row turns red:
/// * `decider_gate` ignoring the registry role (everybody is allowed, on both
///   readers, and the table catches it);
/// * `judge_targets` skipping its narrowing (a plain member is woken for an admin
///   action while the route refuses them);
/// * `may_approve_in_tx` losing its role arm, its agent-owner arm or its host-owner
///   arm.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app and momo_notifier roles"]
async fn the_people_an_approval_push_wakes_are_the_people_the_decision_route_lets_through() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool(
        "momo_app",
        &password_of("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await;
    let notifier = role_pool(
        "momo_notifier",
        &password_of("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await;
    let room = seed_room(&su).await;
    let base = start_server(app).await;
    let env = Env {
        http: reqwest::Client::new(),
        bearer: agent_bearer(&su, &room).await,
        base,
        su,
    };
    let mut tokens = BTreeMap::new();
    for who in EVERYONE {
        tokens.insert(who, login(&env, &room, who).await);
    }

    let mut rows = Vec::new();
    for case in cases() {
        for who in EVERYONE {
            let (approval, message) = make_card(&env, &room, &case.kind).await;
            let woken = woken(&notifier, &room, message).await.contains(&who);
            let (status, receipt) = decide(&env, &room, &tokens[&who], approval, case.pick).await;
            rows.push(Row {
                case: case.label,
                who,
                may_approve: case.may_approve.contains(&who),
                woken,
                verdict: classify(status, &receipt),
            });
        }
    }
    settle(&env.su, &room).await;

    // Always printed (`--nocapture`): the matrix is the evidence, a pass included.
    println!(
        "approval audience matrix (approve half):\n{}",
        render(&rows)
    );

    let bad: Vec<Row> = rows
        .iter()
        .filter(|row| {
            let allowed_by_route = matches!(row.verdict, Verdict::Passed(..));
            let broken = matches!(row.verdict, Verdict::Broken(..));
            broken || row.woken != row.may_approve || allowed_by_route != row.may_approve
        })
        .cloned()
        .collect();
    assert!(
        bad.is_empty(),
        "the push audience and the decision route disagree with the table (or with each other).\n\
         Offending rows:\n{}\n\nFull matrix:\n{}",
        render(&bad),
        render(&rows)
    );
}

/// A spawn whose card sits on a **team box** is nobody's own machine: the decision
/// route lets any member of the room approve it (ADR-0188 D3 names only member-scoped
/// hosts), so the push wakes the whole room — even when the request itself named a
/// laptop. The card's pre-selected host outranks the requested one, in the route
/// (`resolve_host_choice` takes the default first) and in the push
/// (`reference_execution_host`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app and momo_notifier roles"]
async fn a_spawn_the_card_sits_on_a_team_box_wakes_the_whole_room() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool(
        "momo_app",
        &password_of("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await;
    let notifier = role_pool(
        "momo_notifier",
        &password_of("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await;
    let room = seed_room(&su).await;
    let base = start_server(app).await;
    let env = Env {
        http: reqwest::Client::new(),
        bearer: String::new(),
        base,
        su,
    };

    let kind = Kind::SpawnByHand {
        default_host: Some(Host::TeamBox),
        // The request asked for a laptop; the card chose a team box.
        requested_host: Some(Host::Laptop),
    };
    let mut rows = Vec::new();
    for who in EVERYONE {
        let token = login(&env, &room, who).await;
        let (approval, message) = make_card(&env, &room, &kind).await;
        let woken = woken(&notifier, &room, message).await.contains(&who);
        let (status, receipt) = decide(&env, &room, &token, approval, Pick::None).await;
        rows.push(Row {
            case: "a spawn whose card sits on the team box",
            who,
            may_approve: true,
            woken,
            verdict: classify(status, &receipt),
        });
    }
    settle(&env.su, &room).await;

    for row in &rows {
        assert!(
            row.woken && row.verdict == Verdict::Passed(200, "approved".to_string()),
            "{:?} may approve a spawn that sits on a team box — the decision is recorded \
             and they are woken for it:\n{}",
            row.who,
            render(&rows)
        );
    }
}

/// **The one approximation, measured.** The route judges the host the *decider*
/// picks; the push can only know the host the *card* chose. So a plain member who
/// would redirect a laptop-defaulted spawn to the team box is let through by the
/// route and **not** woken — the push errs toward waking the machine's owner only.
/// What it must never do is the opposite (wake somebody the route refuses), which
/// the main test above holds for every shape.
///
/// If this ever flips (the push starts waking them), the doc in
/// `momo_push::approvers` and the PR text are stale: update them with the code.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app and momo_notifier roles"]
async fn an_approver_who_would_redirect_a_spawn_to_a_team_box_is_the_one_person_the_push_leaves_out(
) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool(
        "momo_app",
        &password_of("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await;
    let notifier = role_pool(
        "momo_notifier",
        &password_of("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await;
    let room = seed_room(&su).await;
    let base = start_server(app).await;
    let env = Env {
        http: reqwest::Client::new(),
        bearer: agent_bearer(&su, &room).await,
        base,
        su,
    };

    let (approval, message) = make_card(&env, &room, &Kind::SpawnFromTheLedger).await;
    let member = login(&env, &room, Who::Member).await;

    // Not woken: the card sits on somebody's laptop.
    assert!(
        !woken(&notifier, &room, message)
            .await
            .contains(&Who::Member),
        "the card names the owner's laptop, so only that owner is woken"
    );
    // But the route would take their redirect to the team box.
    let (status, receipt) = decide(&env, &room, &member, approval, Pick::TeamBox).await;
    assert_eq!(
        classify(status, &receipt),
        Verdict::Passed(200, "approved".to_string()),
        "a member may send an agent's work to a team box: {receipt}"
    );
    settle(&env.su, &room).await;
}
