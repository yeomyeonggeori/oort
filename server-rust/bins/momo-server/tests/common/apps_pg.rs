#![allow(dead_code)]
//! Shared fixtures of the two #4313 PostgreSQL suites (`requested_apps_conformance_pg.rs`,
//! `app_runtimes_conformance_pg.rs`): a real Axum router on a `momo_app` (NOBYPASSRLS) pool, humans with
//! a recorded session token, hosted vendor agents with a live Agent Port connection, a co-hosted Hermes
//! pinned to the operator's link, plugin installs and grants.
//!
//! Each suite is `#[ignore]`d (it needs a real PostgreSQL 18 + pgvector as superuser) and holds one
//! binary-wide lock, so run with `--test-threads=1` against an isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test requested_apps_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Every helper seeds with the superuser pool (rows RLS would otherwise hide) and asserts nothing; the
//! suites assert through the HTTP surface and read the result back with the superuser.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, CohostedAgentConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use uuid::Uuid;

pub const TEST_JWT_SECRET: &str = "apps-pg-conformance-signing-secret";
pub const AUDIENCE: &str = "/v1/mcp/agent-port";

pub const GMAIL: &str = "com.momo.plugins.gmail";
pub const GITHUB: &str = "com.momo.plugins.github";
pub const NOTION: &str = "com.momo.plugins.notion";
pub const LINEAR: &str = "com.momo.plugins.linear";
pub const CALENDAR: &str = "com.momo.plugins.google-calendar";
pub const GDRIVE: &str = "com.momo.plugins.google-drive";
pub const TEAM_DRIVE: &str = "com.momo.plugins.drive";

pub fn database_url() -> String {
    std::env::var("DATABASE_URL")
        .expect("set DATABASE_URL to an isolated pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

pub async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

pub async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql applies in ensure_schema_and_roles)")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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

/// Apply every migration and `bootstrap_roles.sql` once per test binary.
pub fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema setup mutex is healthy");
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
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// What the server under test is configured with. The default is the **default server**: the hosted
/// delivery switch off and no operator attestation.
#[derive(Clone, Default)]
pub struct ServerOptions {
    /// `MOMO_HOSTED_DELIVERY_ENABLED`.
    pub hosted_delivery_enabled: bool,
    /// What the operator declared for the co-hosted Hermes (#3948).
    pub cohosted: CohostedAgentConfig,
    /// The Agent Port admission limits as `(per token, per agent)` calls per window. `None` leaves
    /// both axes off (`0`), which is what every suite but the ones that test refusal wants (#4618).
    pub agent_port_limits: Option<(u32, u32)>,
}

impl ServerOptions {
    pub fn hosted_open() -> Self {
        ServerOptions {
            hosted_delivery_enabled: true,
            ..ServerOptions::default()
        }
    }

    /// Turn the Agent Port admission limiter on (calls per 60 s window, `0` = that axis stays off).
    pub fn with_agent_port_limits(mut self, per_token: u32, per_agent: u32) -> Self {
        self.agent_port_limits = Some((per_token, per_agent));
        self
    }

    pub fn attested(mut self, apps: &[&str]) -> Self {
        self.cohosted = CohostedAgentConfig {
            declared: false,
            tools_locked: true,
            connectors_locked: true,
            connector_apps: apps.iter().map(|app| (*app).to_string()).collect(),
            // #4337: the platform is wording only; this suite never reads it.
            ..Default::default()
        };
        self
    }
}

pub async fn start_server(pool: PgPool, options: ServerOptions) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig::default())
    .with_cohosted(
        options.cohosted,
        std::sync::Arc::new(momo_provider_probe::GuardedProviderProbe::new(
            momo_settings::EgressPolicy::default(),
            std::time::Duration::from_secs(5),
        )),
    )
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "apps-pg-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: options
            .agent_port_limits
            .map_or(0, |(per_token, _)| per_token),
        per_agent_limit: options
            .agent_port_limits
            .map_or(0, |(_, per_agent)| per_agent),
        per_ip_limit: 0,
        hosted_delivery_enabled: options.hosted_delivery_enabled,
        subscription_agents_enabled: true,
        claude_subscription_agents_enabled: true,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        oauth: Default::default(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind conformance server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

pub async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("apps-{}", workspace.simple()))
        .execute(su)
        .await
        .expect("workspace");
    workspace
}

pub async fn insert_member(su: &PgPool, workspace: Uuid, id: Uuid, kind: &str, handle: &str) {
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,$3::member_kind,$4,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
}

/// A person with a recorded session token. Display names are made up (이도현 …).
pub async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, handle: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    insert_member(su, workspace, human, "human", handle).await;
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@apps.test"))
    .execute(su)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed human membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'apps-pg')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record the human session token");
    (human, jwt)
}

/// A channel (`public` or `dm`) with `members` joined.
pub async fn seed_channel(su: &PgPool, workspace: Uuid, kind: &str, members: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, dm_key) VALUES($1,$2,$3::channel_kind,$4,$5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind((kind != "dm").then(|| format!("apps-{}", id.simple())))
    .bind((kind == "dm").then(|| format!("dm-{}", id.simple())))
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(id)
        .bind(workspace)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in members {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(id)
            .bind(member)
            .execute(su)
            .await
            .expect("membership");
    }
    id
}

/// What a seeded agent looks like to a test.
pub struct SeededAgent {
    pub id: Uuid,
    pub handle: String,
    /// The Agent Port bearer, when the agent was seeded with a live connection.
    pub bearer: Option<String>,
}

/// The columns that differ between the agents the suites seed.
struct AgentSpec<'a> {
    handle: &'a str,
    owner: Option<Uuid>,
    model: &'a str,
    base_url: &'a str,
    paused: bool,
}

async fn insert_agent_rows(su: &PgPool, workspace: Uuid, id: Uuid, spec: AgentSpec<'_>) {
    insert_member(su, workspace, id, "agent", spec.handle).await;
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(spec.model)
    .bind(spec.base_url)
    .bind(spec.owner)
    .execute(su)
    .await
    .expect("agent");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("agent membership");
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) VALUES($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(spec.owner.unwrap_or(id))
    .bind(spec.paused)
    .execute(su)
    .await
    .expect("agent profile");
}

/// A hosted vendor agent (an Agent Port connection of its own), **not yet marked** as an app runtime.
///
/// `connect = true` activates the connection with a proved `agent_bearer` token (the same rows
/// `load_mention_candidates_in_tx` reads as 「활성 연결」); `false` leaves it `detected`, so the agent has
/// a hosted connection row but no active one. `approved_channels` is the exact-channel grant of the
/// connection (HAP-E3).
pub async fn seed_hosted_agent(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    label: &str,
    approved_channels: &[Uuid],
    connect: bool,
    paused: bool,
) -> SeededAgent {
    let id = Uuid::new_v4();
    let handle = format!("{label}{}", &id.simple().to_string()[..8]);
    insert_agent_rows(
        su,
        workspace,
        id,
        AgentSpec {
            handle: &handle,
            owner: Some(owner),
            model: "hosted-agent",
            base_url: "https://hosted-agent.invalid/disabled",
            paused,
        },
    )
    .await;
    sqlx::query("UPDATE agent SET config = '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb WHERE workspace_id=$1 AND member_id=$2")
        .bind(workspace)
        .bind(id)
        .execute(su)
        .await
        .expect("hosted execution mode");
    let connection = Uuid::new_v4();
    let scopes: Vec<String> = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ]
    .iter()
    .map(|scope| (*scope).to_string())
    .collect();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5,$6,$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(id)
    .bind(owner)
    .bind(approved_channels)
    .bind(&scopes)
    .execute(su)
    .await
    .expect("connection");
    let mut bearer = None;
    if connect {
        let secret = format!(
            "momo_agent_v1.{workspace}.{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        );
        let token: Uuid = sqlx::query_scalar(
            "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                               credential_class, hosted_connection_id, audience, created_by) \
             VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'apps-pg', \
                    'hosted_active',$5,$6,$7) RETURNING id",
        )
        .bind(workspace)
        .bind(id)
        .bind(&secret)
        .bind(&scopes)
        .bind(connection)
        .bind(AUDIENCE)
        .bind(owner)
        .fetch_one(su)
        .await
        .expect("token");
        sqlx::query(
            "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
               proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
        )
        .bind(workspace)
        .bind(connection)
        .bind(token)
        .bind(id)
        .execute(su)
        .await
        .expect("activate");
        bearer = Some(secret);
    }
    SeededAgent { id, handle, bearer }
}

/// A plain workspace agent that is **not hosted** (no connection row), owned by `owner`.
pub async fn seed_managed_agent(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    label: &str,
) -> SeededAgent {
    let id = Uuid::new_v4();
    let handle = format!("{label}{}", &id.simple().to_string()[..8]);
    insert_agent_rows(
        su,
        workspace,
        id,
        AgentSpec {
            handle: &handle,
            owner: Some(owner),
            model: "hermes-agent",
            base_url: "https://managed-agent.invalid/v1",
            paused: false,
        },
    )
    .await;
    SeededAgent {
        id,
        handle,
        bearer: None,
    }
}

/// The co-hosted Hermes: pinned to the operator's own link (`agent_provider_pin.kind='operator_env'`).
pub async fn seed_cohosted_agent(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    label: &str,
) -> SeededAgent {
    let agent = seed_managed_agent(su, workspace, owner, label).await;
    sqlx::query(
        "INSERT INTO agent_provider_pin(agent_member_id, workspace_id, kind, pinned_by) \
         VALUES($1,$2,'operator_env',$3)",
    )
    .bind(agent.id)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("pin");
    agent
}

/// A subscription harness (`owner_only`, `claude_code`), optionally the owner's **personal agent** (the
/// owner's own Mac under an alias). Neither is an app runtime in F8's v1.
pub async fn seed_subscription_agent(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    label: &str,
    personal: bool,
) -> SeededAgent {
    let id = Uuid::new_v4();
    let handle = format!("{label}{}", &id.simple().to_string()[..8]);
    insert_agent_rows(
        su,
        workspace,
        id,
        AgentSpec {
            handle: &handle,
            owner: Some(owner),
            model: "claude-code",
            base_url: "https://subscription-agent.invalid/disabled",
            paused: false,
        },
    )
    .await;
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='claude_code', \
                personal_agent=$3 WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(workspace)
    .bind(id)
    .bind(personal)
    .execute(su)
    .await
    .expect("subscription agent");
    SeededAgent {
        id,
        handle,
        bearer: None,
    }
}

/// Put `member` into `channel` (a row, like the seed of the channel itself).
pub async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
}

/// A **generic** agent bearer (`messages:write`, no hosted credential class): the credential an
/// out-of-process producer posts with over REST. A hosted connection's token never reaches the REST
/// message routes, so a test that needs an agent *author* mints this one.
pub async fn seed_generic_agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'apps-pg')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed generic agent bearer");
    token
}

/// `agent.connector_owner_human_id := owner` — the 「앱 실행 장소」 mark, written as the route would.
pub async fn mark_connector_owner(su: &PgPool, workspace: Uuid, agent: Uuid, owner: Uuid) {
    let changed = sqlx::query(
        "UPDATE agent SET connector_owner_human_id=$3 WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .bind(owner)
    .execute(su)
    .await
    .expect("mark connector owner")
    .rows_affected();
    assert_eq!(changed, 1);
}

async fn audit_id(su: &PgPool, workspace: Uuid, member: Uuid, action: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, $3) RETURNING id",
    )
    .bind(workspace)
    .bind(member)
    .bind(action)
    .fetch_one(su)
    .await
    .expect("audit row")
}

/// An install row of `plugin` for the workspace (`enabled`, never revoked).
pub async fn install_app(su: &PgPool, workspace: Uuid, plugin: &str, by: Uuid, enabled: bool) {
    let audit = audit_id(su, workspace, by, "plugin.install").await;
    sqlx::query(
        "INSERT INTO workspace_plugin_install (workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (workspace_id, plugin_id) DO UPDATE \
           SET enabled = EXCLUDED.enabled, revoked_at = NULL, revoked_by = NULL, revoked_audit_id = NULL",
    )
    .bind(workspace)
    .bind(plugin)
    .bind(enabled)
    .bind(by)
    .bind(audit)
    .execute(su)
    .await
    .expect("install");
}

/// Uninstall the way the write route does at the row level: the install row is revoked.
pub async fn revoke_install(su: &PgPool, workspace: Uuid, plugin: &str, by: Uuid) {
    let audit = audit_id(su, workspace, by, "plugin.uninstall").await;
    let changed = sqlx::query(
        "UPDATE workspace_plugin_install \
            SET revoked_at = now(), revoked_by = $4, enabled = false, revoked_audit_id = $3 \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace)
    .bind(plugin)
    .bind(audit)
    .bind(by)
    .execute(su)
    .await
    .expect("revoke install")
    .rows_affected();
    assert_eq!(changed, 1, "{plugin} was not installed");
}

/// An active grant of `plugin` (scope `read`) for `member`; the install row must already exist.
pub async fn grant_app(su: &PgPool, workspace: Uuid, member: Uuid, plugin: &str) {
    let audit = audit_id(su, workspace, member, "plugin.grant").await;
    sqlx::query(
        "INSERT INTO plugin_grant (workspace_id, member_id, plugin_id, scope, granted_by, granted_audit_id) \
         VALUES ($1, $2, $3, 'read', $2, $4)",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .bind(audit)
    .execute(su)
    .await
    .expect("grant");
}

pub async fn revoke_grant(su: &PgPool, workspace: Uuid, member: Uuid, plugin: &str) {
    let audit = audit_id(su, workspace, member, "plugin.revoke").await;
    let changed = sqlx::query(
        "UPDATE plugin_grant SET status='revoked', revoked_at=now(), revoked_audit_id=$4 \
          WHERE workspace_id=$1 AND member_id=$2 AND plugin_id=$3",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .bind(audit)
    .execute(su)
    .await
    .expect("revoke grant")
    .rows_affected();
    assert_eq!(changed, 1, "{plugin} had no grant to revoke");
}

pub async fn jobs_for(su: &PgPool, workspace: Uuid, agent: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(su)
    .await
    .expect("count agent jobs")
}
