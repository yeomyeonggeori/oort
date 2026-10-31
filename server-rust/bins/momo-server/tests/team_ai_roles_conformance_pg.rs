//! ADR-0201 증보 v3 B3 / B3-T (#4964 S1) — the team AI's **role bundles**, server half: the card
//! `team_ai.roles.set`, the settings PATCH, and the decision route that re-judges a helper's card.
//! Real Postgres, the real HTTP router on `momo_app` (NOBYPASSRLS), two tenants where it matters.
//!
//! `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:pg18`:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-server --test team_ai_roles_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Cards are raised through `momo_workspace_actions::team_ai::propose_in_tx` (the function the
//! worker calls — the worker half is `momo-agent-worker`'s `team_ai_roles_conformance_pg`); every
//! decision is the real route.
//!
//! | test | acceptance | revert that makes it red |
//! |---|---|---|
//! | `s1_an_admin_approves_the_roles_card_and_nobody_else_can` | B3-T, B15-A18 | drop the Admin gate (`GatePlan::Admin` → no `require_admin`), or the executor's write |
//! | `s2_a_card_that_turns_files_or_memory_on_leaves_one_notice_record` | B3 고지 | drop `notice_audit` from the executor, or the notice row from `roles_set_rows` |
//! | `s3_a_card_does_not_outlive_its_bundle` | B13-I5 | return `Ok(None)` for the role-off branch of `team_ai_card_gate_in_tx` |
//! | `s4_a_roles_card_that_read_something_is_refused_at_the_decision` | B4-3 | drop the `is_sensitive_action` branch of `team_ai_card_gate_in_tx`, or let a missing `tools` read as nothing |
//! | `s5_the_settings_card_cannot_reach_a_team_ai_key` | B13-I9 | add a `team_ai_*` key to `workspace.settings.update`'s keys |
//! | `s6_the_settings_patch_is_the_admins_door_and_moves_one_switch_at_a_time` | B3 저장 | merge `team_ai_roles` whole, drop the validator, or write the audit with values |
//! | `s7_turning_memory_on_is_409_while_team_memory_is_off` | issue acceptance | drop `memory_prerequisite_in_tx` from the PATCH or from `set_role_in_tx` |
//! | `s8_another_workspaces_switches_are_not_touched` | 두 테넌트 | write the settings without the workspace id |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_agent::team_ai_roles::{self as roles, TeamAiRoles};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{create_channel, send_message_in_tx, ChannelKind, NewChannel, NewMessage};
use momo_server::{build_app, AppState};
use momo_workspace_actions::team_ai::{self, ProposalContext, ProposalOk, ProposalRefusal, ViaAi};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "team-ai-roles-4964-secret";
const TEST_PASSWORD: &str = "team-ai-roles-4964-password";
const ROLES_CARD: &str = "team_ai.roles.set";

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

async fn app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string()),
        ))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql)")
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
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// One workspace: an owner (admin) who logs in, a plain member with a session token, a public
/// channel, and the team AI switched on through the shipped PATCH.
struct Harness {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    owner: Uuid,
    owner_token: String,
    member_token: String,
    channel: Uuid,
    helper: Uuid,
}

async fn harness(base: Option<String>, app: &PgPool, su: &PgPool) -> Harness {
    harness_with(base, app, su, true).await
}

/// [`harness`] with the team AI left off when `enable_helper` is `false`, so a test can set up
/// what the switch will find (`h.helper` is nil until it is on).
async fn harness_with(
    base: Option<String>,
    app: &PgPool,
    su: &PgPool,
    enable_helper: bool,
) -> Harness {
    let workspace = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{owner}@roles4964.test");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, display, role) in [(owner, "성재", "owner"), (member, "민수", "member")] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'human', $3, $4)",
        )
        .bind(id)
        .bind(workspace)
        .bind(display)
        .bind(format!("h{}", &id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, $3::membership_role)",
        )
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .expect("role");
    }
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("owner auth");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified) \
         VALUES ($1, $2, $3, true)",
    )
    .bind(member)
    .bind(workspace)
    .bind(format!("{member}@roles4964.test"))
    .execute(su)
    .await
    .expect("member auth");
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("roles-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("channel")
    .id;
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("member joins the channel");

    let base = match base {
        Some(base) => base,
        None => start_server(app.clone()).await,
    };
    let http = reqwest::Client::new();
    let login = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(login.status(), 200);
    let owner_token = login.json::<Value>().await.expect("login body")["accessToken"]
        .as_str()
        .expect("token")
        .to_string();
    let member_token = momo_auth::sign_access(member, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a plain member App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'roles-conformance')",
    )
    .bind(workspace)
    .bind(member)
    .bind(&member_token)
    .execute(su)
    .await
    .expect("record the plain member session token");

    let mut h = Harness {
        su: su.clone(),
        http,
        base,
        workspace,
        owner,
        owner_token,
        member_token,
        channel,
        helper: Uuid::nil(),
    };
    if !enable_helper {
        return h;
    }
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_fast_path": true}))
        .await;
    assert_eq!(status, 200, "enable the team AI: {body}");
    h.helper = sqlx::query_scalar(
        "SELECT (settings->>'team_ai_agent_member_id')::uuid FROM workspace WHERE id = $1",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("helper id");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(h.helper)
        .execute(su)
        .await
        .expect("the helper joins the channel");
    h
}

impl Harness {
    async fn patch(&self, token: &str, body: Value) -> (u16, Value) {
        let response = self
            .http
            .patch(format!(
                "{}/v1/workspaces/{}/settings",
                self.base, self.workspace
            ))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .expect("patch settings");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn settings(&self) -> Value {
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect("settings")
    }

    async fn roles(&self) -> TeamAiRoles {
        TeamAiRoles::from_settings(&self.settings().await)
    }

    /// The real decision route, as `token`'s holder.
    async fn decide(&self, token: &str, approval: Uuid, approve: bool) -> (u16, Value) {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/approvals/{approval}/decision",
                self.base, self.workspace
            ))
            .bearer_auth(token)
            .json(&json!({
                "approvalId": approval,
                "approve": approve,
                "clientDecisionId": Uuid::new_v4()
            }))
            .send()
            .await
            .expect("decision responds");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// The helper raises one card for `requester`, through the very function the worker calls.
    /// `via_tools` / `web_searches` say what the request read before it proposed.
    async fn raise(
        &self,
        requester: Uuid,
        action_id: &str,
        args: Value,
        via_tools: &[&str],
        web_searches: i32,
    ) -> Result<ProposalOk, ProposalRefusal> {
        let (workspace, channel, helper) = (self.workspace, self.channel, self.helper);
        let text = format!("@oort-helper {action_id}");
        let run_id = with_tenant_tx(&self.su, workspace, move |conn| {
            let text = text.clone();
            Box::pin(async move {
                let sent =
                    send_message_in_tx(conn, workspace, NewMessage::text(channel, requester, text))
                        .await?;
                let created = momo_agent::create_agent_run_in_tx(
                    conn,
                    workspace,
                    momo_agent::NewAgentRun {
                        channel_id: channel,
                        trigger: momo_agent::RunTrigger::Mention {
                            message_id: sent.message.id,
                            agent_member_id: helper,
                        },
                        parent_run_id: None,
                        max_steps: 50,
                        depth: 0,
                        input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                      "prompt": "x", "depth": 0}),
                    },
                )
                .await?;
                Ok(created.id)
            })
        })
        .await
        .expect("a run for the helper");
        let action_id = action_id.to_string();
        let via_tools: Vec<String> = via_tools.iter().map(|tool| tool.to_string()).collect();
        with_tenant_tx(&self.su, workspace, move |conn| {
            let (action_id, args, via_tools) = (action_id.clone(), args.clone(), via_tools.clone());
            Box::pin(async move {
                let context = ProposalContext {
                    workspace_id: workspace,
                    run_id,
                    channel_id: channel,
                    agent_member_id: helper,
                    trigger_message_id: None,
                    now_ms: chrono::Utc::now().timestamp_millis(),
                    expires_at: chrono::Utc::now() + chrono::Duration::minutes(30),
                    via: ViaAi {
                        model: "m".into(),
                        latency_ms: 1,
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        tools: via_tools,
                        model_calls: 1,
                        web_searches,
                    },
                };
                team_ai::propose_in_tx(conn, &context, &action_id, &args, None).await
            })
        })
        .await
        .expect("the proposal transaction")
    }

    async fn audit_rows(&self, action: &str) -> Vec<Value> {
        sqlx::query_scalar(
            "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = $2 \
              ORDER BY created_at, id",
        )
        .bind(self.workspace)
        .bind(action)
        .fetch_all(&self.su)
        .await
        .expect("audit rows")
    }

    async fn approval_status(&self, approval: Uuid) -> String {
        sqlx::query_scalar("SELECT status::text FROM approval WHERE id = $1")
            .bind(approval)
            .fetch_one(&self.su)
            .await
            .expect("approval status")
    }

    async fn channel_named(&self, name: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM channel WHERE workspace_id = $1 AND name = $2")
            .bind(self.workspace)
            .bind(name)
            .fetch_one(&self.su)
            .await
            .expect("channel count")
    }
}

// --- the roles card --------------------------------------------------------------------------

/// B3-T / B15-A18: 「파일 역할 꺼 줘」 is one card; a plain member cannot approve it (403, nothing
/// moves, the card stays pending); the admin's approval turns the switch and writes ONE
/// `team_ai.roles.changed` row naming the key and nothing else.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s1_an_admin_approves_the_roles_card_and_nobody_else_can() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    assert_eq!(
        h.roles().await,
        TeamAiRoles::default(),
        "nothing stored: every bundle on"
    );

    let card = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "files", "enabled": false}),
            &[],
            0,
        )
        .await
        .expect("an admin's direct request is a card");
    assert_eq!(
        h.roles().await,
        TeamAiRoles::default(),
        "a proposal changes nothing"
    );

    let (status, refused) = h.decide(&h.member_token, card.approval_id, true).await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(
        h.roles().await,
        TeamAiRoles::default(),
        "a plain member moved nothing"
    );
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    assert!(h.audit_rows("team_ai.roles.changed").await.is_empty());

    let (status, decided) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    let roles_now = h.roles().await;
    assert!(
        !roles_now.is_on(roles::FILES),
        "the admin's approval turned it off"
    );
    assert_eq!(roles_now.off_bundles(), [roles::FILES], "and only that one");
    assert_eq!(h.settings().await["team_ai_roles"], json!({"files": false}));
    let changed = h.audit_rows("team_ai.roles.changed").await;
    assert_eq!(changed.len(), 1, "one audit row: {changed:?}");
    assert_eq!(changed[0]["keys"], json!(["files"]));
    assert_eq!(changed[0]["source"], "card");
    assert_eq!(changed[0]["approval_id"], card.approval_id.to_string());
    assert!(
        !changed[0].to_string().contains("false"),
        "key names, never values: {}",
        changed[0]
    );
    assert!(
        h.audit_rows("team_ai.roles.notice_shown").await.is_empty(),
        "turning off asks for no consent"
    );
    // The card said what it did, and the proposal carried the one bundle.
    let ran: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
        .bind(card.approval_id)
        .fetch_one(&h.su)
        .await
        .unwrap();
    assert_eq!(
        ran["action"]["args"],
        json!({"bundle": "files", "enabled": false})
    );
}

/// B3 고지: the card that turns `files` or `memory` ON shows the 「공급자로 가는 내용」 row, and its
/// approval is the consent record — who, when (the row's time), which wording — ONE row per card.
/// A bundle with no notice (`code`) and a switch going OFF leave none.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s2_a_card_that_turns_files_or_memory_on_leaves_one_notice_record() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"files": false, "memory": false, "code": false}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let files = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "files", "enabled": true}),
            &[],
            0,
        )
        .await
        .expect("files card");
    let rows: Value =
        sqlx::query_scalar("SELECT props->'action'->'rows' FROM message WHERE id = $1")
            .bind(files.card_message_id)
            .fetch_one(&h.su)
            .await
            .unwrap();
    let rows = rows.to_string();
    assert!(
        rows.contains("공급자로 가는 내용"),
        "the card shows the notice row: {rows}"
    );
    assert!(rows.contains("팀 AI 공급자"), "{rows}");
    assert!(
        h.audit_rows("team_ai.roles.notice_shown").await.is_empty(),
        "shown is not yet consented"
    );

    let (status, decided) = h.decide(&h.owner_token, files.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    let notices = h.audit_rows("team_ai.roles.notice_shown").await;
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0]["bundles"], json!(["files"]));
    assert_eq!(notices[0]["notice_version"], roles::NOTICE_VERSION);
    assert_eq!(notices[0]["via"], "card");
    assert_eq!(notices[0]["approval_id"], files.approval_id.to_string());
    let actor: Option<Uuid> = sqlx::query_scalar(
        "SELECT actor_member_id FROM audit_log \
          WHERE workspace_id = $1 AND action = 'team_ai.roles.notice_shown'",
    )
    .bind(h.workspace)
    .fetch_one(&h.su)
    .await
    .unwrap();
    assert_eq!(actor, Some(h.owner), "who: the approver");

    let memory = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "memory", "enabled": true}),
            &[],
            0,
        )
        .await
        .expect("memory card");
    let (status, decided) = h.decide(&h.owner_token, memory.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(h.audit_rows("team_ai.roles.notice_shown").await.len(), 2);

    // A bundle with no notice, and a switch going off, add no record.
    let code = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "code", "enabled": true}),
            &[],
            0,
        )
        .await
        .expect("code card");
    let code_rows: Value =
        sqlx::query_scalar("SELECT props->'action'->'rows' FROM message WHERE id = $1")
            .bind(code.card_message_id)
            .fetch_one(&h.su)
            .await
            .unwrap();
    assert!(
        !code_rows.to_string().contains("공급자로 가는 내용"),
        "{code_rows}"
    );
    assert_eq!(
        h.decide(&h.owner_token, code.approval_id, true).await.0,
        200
    );
    let off = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "files", "enabled": false}),
            &[],
            0,
        )
        .await
        .expect("files off card");
    assert_eq!(h.decide(&h.owner_token, off.approval_id, true).await.0, 200);
    assert_eq!(
        h.audit_rows("team_ai.roles.notice_shown").await.len(),
        2,
        "only the two cards that turned a noticed bundle on"
    );
    // The same function the onboarding step calls writes the same shape.
    let mut conn = h.su.acquire().await.unwrap();
    let written = momo_workspace_actions::team_ai_roles::record_notice_in_tx(
        &mut conn,
        h.workspace,
        h.owner,
        None,
        &[roles::FILES, roles::CODE],
        momo_workspace_actions::team_ai_roles::NoticeVia::Onboarding,
    )
    .await
    .unwrap();
    assert!(written);
    drop(conn);
    let notices = h.audit_rows("team_ai.roles.notice_shown").await;
    assert_eq!(notices.len(), 3);
    assert_eq!(notices[2]["via"], "onboarding");
    assert_eq!(notices[2]["bundles"], json!(["files"]));
}

/// B13-I5, the decision fence: a card the helper raised while its bundle was on does NOT run once
/// the bundle is off — 409 `action_args_invalid`, nothing created, an `action.refused` row says why —
/// and because the refusal does not consume the approval, the same card runs after the bundle is
/// back on.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s3_a_card_does_not_outlive_its_bundle() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let name = format!("ideas-{}", &Uuid::new_v4().simple().to_string()[..6]);
    let card = h
        .raise(
            h.owner,
            "channel.create",
            json!({"name": name, "kind": "public"}),
            &[],
            0,
        )
        .await
        .expect("a channel card while the bundle is on");

    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"workspace_admin": false}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["status"], "action_args_invalid");
    assert_eq!(h.channel_named(&name).await, 0, "the card did not run");
    assert_eq!(
        h.approval_status(card.approval_id).await,
        "pending",
        "not consumed"
    );
    let refused_rows = h.audit_rows("action.refused").await;
    assert_eq!(refused_rows.len(), 1, "{refused_rows:?}");
    assert_eq!(refused_rows[0]["reason"], "team_ai_role_off");
    assert_eq!(refused_rows[0]["action_id"], "channel.create");

    // The way back on: the switch, then the very same card.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"workspace_admin": true}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, decided) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(h.channel_named(&name).await, 1);

    // And a card that is not the helper's is not touched by the helper's switches.
    let (status, _) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"workspace_admin": false}}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        h.raise(
            h.owner,
            "channel.create",
            json!({"name": "x1", "kind": "public"}),
            &[],
            0
        )
        .await
        .is_err(),
        "and a proposal of an off bundle's card is refused inside the transaction"
    );
}

/// B4-3, the decision fence: a roles card whose request had READ something is refused at the
/// approval too — and so is a card that does not say it read nothing (`via_ai.tools` missing).
/// (The proposal fence refuses it first; here the stored card is made to say otherwise, as a card
/// that came in sideways would.)
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s4_a_roles_card_that_read_something_is_refused_at_the_decision() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    // The proposal fence, directly: a request that read a channel / searched cannot raise it.
    assert_eq!(
        h.raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "code", "enabled": false}),
            &["read_channel"],
            0
        )
        .await,
        Err(ProposalRefusal::AfterRead)
    );
    assert_eq!(
        h.raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "code", "enabled": false}),
            &[],
            1
        )
        .await,
        Err(ProposalRefusal::AfterRead)
    );

    for (label, tamper) in [
        (
            "read a channel",
            "UPDATE approval SET payload = jsonb_set(payload, '{via_ai,tools}', '[\"read_channel\"]') WHERE id = $1",
        ),
        (
            "searched the web",
            "UPDATE approval SET payload = jsonb_set(payload, '{via_ai,web_searches}', '2') WHERE id = $1",
        ),
        (
            "does not say",
            "UPDATE approval SET payload = payload #- '{via_ai,tools}' WHERE id = $1",
        ),
    ] {
        let card = h
            .raise(h.owner, ROLES_CARD, json!({"bundle": "code", "enabled": false}), &[], 0)
            .await
            .expect("a direct request is a card");
        sqlx::query(tamper).bind(card.approval_id).execute(&h.su).await.unwrap();
        let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
        assert_eq!(status, 409, "{label}: {refused}");
        assert_eq!(refused["status"], "action_args_invalid", "{label}");
        assert!(h.roles().await.is_on(roles::CODE), "{label}: nothing moved");
        assert_eq!(h.approval_status(card.approval_id).await, "pending", "{label}");
        // Saying no still works.
        assert_eq!(h.decide(&h.owner_token, card.approval_id, false).await.0, 200, "{label}");
    }
    let refused = h.audit_rows("action.refused").await;
    assert_eq!(refused.len(), 3);
    assert!(
        refused
            .iter()
            .all(|row| row["reason"] == "team_ai_read_context"),
        "{refused:?}"
    );

    // A control: the untampered card of a direct request runs.
    let card = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "code", "enabled": false}),
            &[],
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        h.decide(&h.owner_token, card.approval_id, true).await.0,
        200
    );
    assert!(!h.roles().await.is_on(roles::CODE));
}

/// B13-I9: the helper's settings card names two keys and no `team_ai_*` one — not at the proposal,
/// and not if the STORED card is made to carry one: the decision re-proves the stored arguments and
/// the settings stay as they were.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s5_the_settings_card_cannot_reach_a_team_ai_key() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    for key in [
        "team_ai_roles",
        "teamAiRoles",
        "team_ai_fast_path",
        "team_ai_limits",
    ] {
        assert_eq!(
            h.raise(
                h.owner,
                "workspace.settings.update",
                json!({"welcomePrompt": "안녕하세요", key: {"files": false}}),
                &[],
                0,
            )
            .await,
            Err(ProposalRefusal::InvalidArguments),
            "{key}"
        );
    }
    let before = h.settings().await;
    let card = h
        .raise(
            h.owner,
            "workspace.settings.update",
            json!({"welcomePrompt": "안녕하세요"}),
            &[],
            0,
        )
        .await
        .expect("a plain welcome-text card");
    for tampered in [
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,team_ai_roles}', '{\"files\": false}') WHERE id = $1",
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,teamAiRoles}', '{\"files\": false}') WHERE id = $1",
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,team_ai_fast_path}', 'false') WHERE id = $1",
    ] {
        sqlx::query(tampered).bind(card.approval_id).execute(&h.su).await.unwrap();
        let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
        assert_eq!(status, 409, "{refused}");
        assert_eq!(refused["status"], "action_args_invalid");
        assert_eq!(h.settings().await, before, "no team_ai_* key moved");
        assert_eq!(h.approval_status(card.approval_id).await, "pending");
        sqlx::query("UPDATE approval SET payload = payload #- '{action,args,team_ai_roles}' #- '{action,args,teamAiRoles}' #- '{action,args,team_ai_fast_path}' WHERE id = $1")
            .bind(card.approval_id)
            .execute(&h.su)
            .await
            .unwrap();
    }
    // And the clean card still runs, changing the welcome text and nothing else.
    let (status, decided) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    let after = h.settings().await;
    assert_eq!(after["welcome_prompt"], "안녕하세요");
    assert_eq!(after["team_ai_fast_path"], before["team_ai_fast_path"]);
    assert!(after.get("team_ai_roles").is_none());
}

// --- the settings door ---------------------------------------------------------------------------

/// B3 저장: `PATCH …/settings` is the admin's door (a plain member is 403), takes only the six
/// switchable bundles as booleans (`chat_read` and unknown names are 400), merges ONE LEVEL DOWN so
/// naming one switch never moves another, drops a field on `null`, and writes ONE audit row that
/// names the keys that moved — none when nothing moved.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s6_the_settings_patch_is_the_admins_door_and_moves_one_switch_at_a_time() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let (status, body) = h
        .patch(&h.member_token, json!({"team_ai_roles": {"files": false}}))
        .await;
    assert_eq!(status, 403, "{body}");
    assert!(h.settings().await.get("team_ai_roles").is_none());

    for bad in [
        json!({"team_ai_roles": {"chat_read": false}}),
        json!({"team_ai_roles": {"chat_read": true}}),
        json!({"team_ai_roles": {"filez": false}}),
        json!({"team_ai_roles": {"files": "no"}}),
        json!({"team_ai_roles": {"files": 0}}),
        json!({"team_ai_roles": ["files"]}),
        json!({"team_ai_roles": true}),
    ] {
        let (status, body) = h.patch(&h.owner_token, bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {body}");
        assert!(h.settings().await.get("team_ai_roles").is_none(), "{bad}");
    }
    assert!(h.audit_rows("team_ai.roles.changed").await.is_empty());

    // One switch.
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": {"files": false}}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["team_ai_roles"], json!({"files": false}));
    // A second switch: the first stays (a whole-object replace would have turned `files` back on).
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"invite_access": false}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["team_ai_roles"],
        json!({"files": false, "invite_access": false})
    );
    assert_eq!(
        h.roles().await.off_bundles(),
        [roles::INVITE_ACCESS, roles::FILES]
    );
    // `null` drops a field (back to on); a write that changes nothing writes no roles audit row.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"invite_access": null, "memory": true}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["team_ai_roles"],
        json!({"files": false, "memory": true})
    );
    let changed = h.audit_rows("team_ai.roles.changed").await;
    assert_eq!(
        changed
            .iter()
            .map(|row| row["keys"].clone())
            .collect::<Vec<_>>(),
        [
            json!(["files"]),
            json!(["invite_access"]),
            json!(["invite_access"])
        ],
        "memory: true over an absent field moved nothing a reader can see: {changed:?}"
    );
    assert!(changed.iter().all(|row| row["source"] == "settings"));
    assert!(
        changed
            .iter()
            .all(|row| !row.to_string().contains("true") && !row.to_string().contains("false")),
        "key names only: {changed:?}"
    );
    // The key dropped whole: everything on again, and the audit names what came back.
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": null}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("team_ai_roles").is_none());
    assert_eq!(h.roles().await, TeamAiRoles::default());
    assert_eq!(h.audit_rows("team_ai.roles.changed").await.len(), 4);
    assert_eq!(
        h.audit_rows("team_ai.roles.changed").await[3]["keys"],
        json!(["files"])
    );
    // A patch of another key leaves the roles alone and writes no roles row.
    let (status, _) = h
        .patch(&h.owner_token, json!({"welcome_prompt": "안녕"}))
        .await;
    assert_eq!(status, 200);
    assert_eq!(h.audit_rows("team_ai.roles.changed").await.len(), 4);
}

/// The issue's 「팀 기억이 꺼져 있으면 기억 켜기 409」, judged on the EFFECTIVE change: with team
/// memory switched off, taking `memory` from off to on is refused (PATCH and card; nothing written,
/// the card stays pending); a save that only repeats `memory: true` over a bundle that already reads
/// as on is not stopped; and once team memory is on, the same card runs.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s7_turning_memory_on_is_409_while_team_memory_is_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, enabled, paused) \
         VALUES ($1, 'workspace', false, false)",
    )
    .bind(h.workspace)
    .execute(&h.su)
    .await
    .expect("team memory off");

    // `memory` reads as on (nothing stored), so repeating `true` changes nothing: not a 409.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"memory": true, "files": true}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    // Turn it off (allowed), then try to turn it on again.
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": {"memory": false}}))
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": {"memory": true}}))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "team_memory_off");
    assert_eq!(
        h.settings().await["team_ai_roles"]["memory"],
        false,
        "nothing written"
    );

    let card = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "memory", "enabled": true}),
            &[],
            0,
        )
        .await
        .expect("the card can be drawn: it is the approval that is refused");
    let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    assert!(!h.roles().await.is_on(roles::MEMORY));
    assert!(h.audit_rows("team_ai.roles.notice_shown").await.is_empty());

    sqlx::query(
        "UPDATE mem_settings SET enabled = true WHERE workspace_id = $1 AND scope = 'workspace'",
    )
    .bind(h.workspace)
    .execute(&h.su)
    .await
    .expect("team memory on");
    let (status, decided) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    assert!(h.roles().await.is_on(roles::MEMORY));
    assert_eq!(h.audit_rows("team_ai.roles.notice_shown").await.len(), 1);
}

/// 「다른 테넌트 설정이 섞이지 않음」: workspace A's approvals and PATCHes move A's bag and leave B's
/// byte for byte as it was, and B still reads every bundle on.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s8_another_workspaces_switches_are_not_touched() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let a = harness(None, &app, &su).await;
    let b = harness(Some(a.base.clone()), &app, &su).await;
    let b_before = b.settings().await;

    let card = a
        .raise(
            a.owner,
            ROLES_CARD,
            json!({"bundle": "workspace_admin", "enabled": false}),
            &[],
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        a.decide(&a.owner_token, card.approval_id, true).await.0,
        200
    );
    let (status, _) = a
        .patch(&a.owner_token, json!({"team_ai_roles": {"files": false}}))
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        a.roles().await.off_bundles(),
        [roles::WORKSPACE_ADMIN, roles::FILES]
    );

    assert_eq!(b.settings().await, b_before, "B's bag did not move");
    assert_eq!(b.roles().await, TeamAiRoles::default());
    assert!(b.audit_rows("team_ai.roles.changed").await.is_empty());
    // B's helper still proposes the card A's helper may not — and A's own card of that kind is refused.
    let name = format!("b-{}", &Uuid::new_v4().simple().to_string()[..6]);
    assert!(b
        .raise(
            b.owner,
            "channel.create",
            json!({"name": name, "kind": "public"}),
            &[],
            0
        )
        .await
        .is_ok());
    assert_eq!(
        a.raise(
            a.owner,
            "channel.create",
            json!({"name": "a-x", "kind": "public"}),
            &[],
            0
        )
        .await,
        Err(ProposalRefusal::RoleOff)
    );
    // A's owner cannot decide B's card, and B's settings are still untouched after the attempt.
    let card_b = b
        .raise(
            b.owner,
            ROLES_CARD,
            json!({"bundle": "code", "enabled": false}),
            &[],
            0,
        )
        .await
        .unwrap();
    let (status, _) = a.decide(&a.owner_token, card_b.approval_id, true).await;
    assert_ne!(
        status, 200,
        "another workspace's admin cannot approve this card"
    );
    assert!(b.roles().await.is_on(roles::CODE));
}

// --- repairs from the independent security review (#4964, round 1) -------------------------------

/// What a settings PATCH commits is on the audit record, also when the handler then answers with a
/// refusal. In a workspace where another agent already holds the helper's handle, a PATCH that
/// carries role switches AND the helper's own switch answers 409 `team_ai_unavailable`. The settings
/// API's rule for that refusal is that the rest of the request stays committed — so the roles audit
/// row (key names only) and the settings audit row must exist for it, exactly as on the success path.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s9_what_a_settings_patch_commits_is_audited_when_it_answers_409() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness_with(None, &app, &su, false).await;
    let holder = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent', 'active', '다른 에이전트', $3)",
    )
    .bind(holder)
    .bind(h.workspace)
    .bind(team_ai::TEAM_AI_HANDLE)
    .execute(&su)
    .await
    .expect("another agent holds the helper's handle");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'grok', 'https://x.invalid/v1', $3)",
    )
    .bind(holder)
    .bind(h.workspace)
    .bind(h.owner)
    .execute(&su)
    .await
    .expect("its agent row");
    let roles_rows = h.audit_rows("team_ai.roles.changed").await.len();
    let updated_rows = h.audit_rows("workspace_setting.updated").await.len();

    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_fast_path": true, "team_ai_roles": {"files": false}}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "team_ai_unavailable");
    let settings = h.settings().await;
    assert_eq!(
        settings["team_ai_roles"],
        json!({"files": false}),
        "the refusal commits the rest of the request"
    );
    assert_eq!(
        settings["team_ai_fast_path"],
        json!(false),
        "and the helper's own switch is back out"
    );
    let changed = h.audit_rows("team_ai.roles.changed").await;
    assert_eq!(
        changed.len(),
        roles_rows + 1,
        "the committed role switch is audited: {changed:?}"
    );
    let row = changed.last().expect("the new row");
    assert_eq!(row["keys"], json!(["files"]));
    assert_eq!(row["source"], "settings");
    assert!(
        !row.to_string().contains("false"),
        "key names, never values: {row}"
    );
    assert_eq!(
        h.audit_rows("workspace_setting.updated").await.len(),
        updated_rows + 1,
        "so is the write itself"
    );

    // The success path writes the same two rows once the handle is free.
    sqlx::query("UPDATE member SET handle = 'renamed-agent' WHERE id = $1")
        .bind(holder)
        .execute(&su)
        .await
        .expect("the other agent is renamed");
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_fast_path": true, "team_ai_roles": {"files": true}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        h.audit_rows("team_ai.roles.changed").await.len(),
        roles_rows + 2
    );
    assert_eq!(
        h.audit_rows("workspace_setting.updated").await.len(),
        updated_rows + 2
    );
}
