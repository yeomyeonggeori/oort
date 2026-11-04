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
//! | `s2_a_card_that_turns_files_or_memory_on_leaves_one_notice_record` | B3 고지 | drop `card_notice_audit` from the executor, or the notice row from `roles_set_rows` |
//! | `s3_a_card_does_not_outlive_its_bundle` | B13-I5 | return `Ok(None)` for the role-off branch of `team_ai_card_gate_in_tx` |
//! | `s4_a_roles_card_that_read_something_is_refused_at_the_decision` | B4-3 | drop the `is_sensitive_action` branch of `team_ai_card_gate_in_tx`, or let a missing `tools` read as nothing |
//! | `s5_the_settings_card_cannot_reach_a_team_ai_key` | B13-I9 | add a `team_ai_*` key to `workspace.settings.update`'s keys |
//! | `s6_the_settings_patch_is_the_admins_door_and_moves_one_switch_at_a_time` | B3 저장 | merge `team_ai_roles` whole, drop the validator, or write the audit with values |
//! | `s7_turning_memory_on_is_409_while_team_memory_is_off` | issue acceptance | drop `memory_prerequisite_in_tx` from the PATCH or from `set_role_in_tx` |
//! | `s8_another_workspaces_switches_are_not_touched` | 두 테넌트 | write the settings without the workspace id |
//! | `s9_what_a_settings_patch_commits_is_audited_when_it_answers_409` | B13-I5 감사 (고지 기록 #5040) | write the audit rows and the consent record after the provisioning block instead of right after the write |
//! | `s10_a_helper_only_card_runs_only_with_the_helpers_mark` | B13-I5 출처 | drop the unmarked-card arm of `card_provenance` |
//! | `s11_a_decision_waits_for_a_settings_write_in_flight` | B13-I5 경쟁 | read the settings row in the gate without holding it |
//! | `s12_the_decisions_read_holds_the_settings_row_in_the_mode_it_names` | B13-I5 경쟁 | swap the lock clauses of `read_roles_locked_in_tx`, or let an unreadable row read as all on |
//! | `s13_a_platform_reader_who_is_not_an_admin_cannot_approve_the_roles_card` | B3-T | lower the roles card's `required_role` from `Admin` to `WorkspaceOperator` |
//! | `s14_a_screen_that_shows_the_notice_leaves_one_record_with_the_wording_it_named` | B3 고지 (#5040) | drop `record_notice_in_tx` from the PATCH, or stop lifting `team_ai_roles_notice` out of the body (the allowlist 400s it) |
//! | `s15_a_record_the_server_cannot_read_is_a_400_and_a_switch_that_did_not_move_leaves_none` | B3 고지 (#5040) | accept any wording or `via`, or write the record before the `team_memory_off` refusal |
//! | `s16_another_workspace_neither_gets_nor_sees_the_record` | 두 테넌트 (#5040) | write the record under another workspace's id, or let a token reach another workspace's PATCH |

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
    member: Uuid,
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
        member,
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
    // The same function a screen's PATCH reaches (#5040) writes the same shape. (A bundle with no
    // notice never gets this far: the claim refuses it — see the unit tests and `s14`.)
    let claim = momo_workspace_actions::team_ai_roles::parse_screen_notice(&json!({
        "bundles": ["files"],
        "noticeVersion": roles::NOTICE_VERSION,
        "via": "onboarding",
    }))
    .expect("a judged claim");
    let mut conn = h.su.acquire().await.unwrap();
    let written = momo_workspace_actions::team_ai_roles::record_notice_in_tx(
        &mut conn,
        h.workspace,
        h.owner,
        None,
        &claim,
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
    // #4944 (B9-1, B13-I9): the limit that bounds the helper — with a value the settings door
    // WOULD accept, not just a stand-in — is no more reachable than the role switches.
    for (key, limits) in [
        ("team_ai_limits", json!({"dailyTokens": 100})),
        ("teamAiLimits", json!({"monthlyUsd": 1})),
    ] {
        assert_eq!(
            h.raise(
                h.owner,
                "workspace.settings.update",
                json!({"welcomePrompt": "안녕하세요", key: limits}),
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
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,team_ai_limits}', '{\"dailyTokens\": 1}') WHERE id = $1",
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,teamAiLimits}', '{\"monthlyUsd\": 1}') WHERE id = $1",
    ] {
        sqlx::query(tampered).bind(card.approval_id).execute(&h.su).await.unwrap();
        let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
        assert_eq!(status, 409, "{refused}");
        assert_eq!(refused["status"], "action_args_invalid");
        assert_eq!(h.settings().await, before, "no team_ai_* key moved");
        assert_eq!(h.approval_status(card.approval_id).await, "pending");
        sqlx::query("UPDATE approval SET payload = payload #- '{action,args,team_ai_roles}' #- '{action,args,teamAiRoles}' #- '{action,args,team_ai_fast_path}' #- '{action,args,team_ai_limits}' #- '{action,args,teamAiLimits}' WHERE id = $1")
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
    assert!(after.get("team_ai_limits").is_none());
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

    // The onboarding shape (#5040): files off, so the line the admin read was memory's. The claim
    // rides on the same request.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({
                "team_ai_fast_path": true,
                "team_ai_roles": {"files": false},
                "team_ai_roles_notice": notice_claim(json!(["memory"]), "onboarding"),
            }),
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
    // So is the consent record: the admin did read the line and pressed the button, whatever the
    // provisioning answered next (#5040). It is written right after the write, before that block.
    let records = h.notice_records().await;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].0["via"], "onboarding");
    assert_eq!(records[0].0["bundles"], json!(["memory"]));

    // The success path writes the same rows once the handle is free.
    sqlx::query("UPDATE member SET handle = 'renamed-agent' WHERE id = $1")
        .bind(holder)
        .execute(&su)
        .await
        .expect("the other agent is renamed");
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({
                "team_ai_fast_path": true,
                "team_ai_roles": {"files": true},
                "team_ai_roles_notice": notice_claim(json!(["files", "memory"]), "onboarding"),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        h.audit_rows("team_ai.roles.changed").await.len(),
        roles_rows + 2
    );
    // The retry is a second event, not a replacement: the record is a log.
    let records = h.notice_records().await;
    assert_eq!(records.len(), 2, "{records:?}");
    assert_eq!(records[1].0["bundles"], json!(["files", "memory"]));
    assert_eq!(
        h.audit_rows("workspace_setting.updated").await.len(),
        updated_rows + 2
    );
}

/// Provenance at the decision (B13-I5): a card of an action only the helper may raise runs only when
/// its stored `via_ai` says the helper raised it. A card whose mark is missing, dropped or another
/// source is refused — 409, nothing moves, the card stays pending (and can still be rejected), an
/// `action.refused` row names the reason — for the roles card and for another helper-only action.
/// The marked card of the same request runs.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s10_a_helper_only_card_runs_only_with_the_helpers_mark() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    for (label, tamper) in [
        (
            "no via_ai",
            "UPDATE approval SET payload = payload - 'via_ai' WHERE id = $1",
        ),
        (
            "no source",
            "UPDATE approval SET payload = payload #- '{via_ai,source}' WHERE id = $1",
        ),
        (
            "another source",
            "UPDATE approval SET payload = jsonb_set(payload, '{via_ai,source}', '\"agent\"') WHERE id = $1",
        ),
    ] {
        let card = h
            .raise(
                h.owner,
                ROLES_CARD,
                json!({"bundle": "code", "enabled": false}),
                &[],
                0,
            )
            .await
            .expect("a direct request is a card");
        sqlx::query(tamper)
            .bind(card.approval_id)
            .execute(&h.su)
            .await
            .unwrap();
        let (status, refused) = h.decide(&h.owner_token, card.approval_id, true).await;
        assert_eq!(status, 409, "{label}: {refused}");
        assert_eq!(refused["status"], "action_args_invalid", "{label}");
        assert!(h.roles().await.is_on(roles::CODE), "{label}: nothing moved");
        assert_eq!(h.approval_status(card.approval_id).await, "pending", "{label}");
        assert_eq!(
            h.decide(&h.owner_token, card.approval_id, false).await.0,
            200,
            "{label}: saying no still works"
        );
    }
    // Another action only the helper may raise.
    let unfurl = h
        .raise(
            h.owner,
            "workspace.unfurl.update",
            json!({"enabled": false}),
            &[],
            0,
        )
        .await
        .expect("an unfurl card");
    sqlx::query("UPDATE approval SET payload = payload - 'via_ai' WHERE id = $1")
        .bind(unfurl.approval_id)
        .execute(&h.su)
        .await
        .unwrap();
    let (status, refused) = h.decide(&h.owner_token, unfurl.approval_id, true).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(h.approval_status(unfurl.approval_id).await, "pending");

    let refused_rows = h.audit_rows("action.refused").await;
    assert_eq!(refused_rows.len(), 4, "{refused_rows:?}");
    assert!(
        refused_rows
            .iter()
            .all(|row| row["reason"] == "team_ai_provenance"),
        "{refused_rows:?}"
    );

    // A control: the marked card of a direct request runs.
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

/// How many backends are waiting on a lock that `holder_pid` holds.
async fn waiting_on(su: &PgPool, holder_pid: i32) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity \
          WHERE datname = current_database() AND wait_event_type = 'Lock' \
            AND $1 = ANY(pg_blocking_pids(pid))",
    )
    .bind(holder_pid)
    .fetch_one(su)
    .await
    .expect("pg_stat_activity")
}

/// B13-I5, the decision against a switch being turned off: while a settings write holds the row,
/// the decision of a helper card WAITS for it, then judges the bundle as the write left it — the
/// card does not run. (If the decision read the row without waiting, it would judge the old switch
/// and run the card a moment after the bundle went off.) One card of each lock mode: a card whose
/// executor only reads the row, and the settings card whose executor takes it `FOR UPDATE`.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s11_a_decision_waits_for_a_settings_write_in_flight() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let name = format!("wait-{}", &Uuid::new_v4().simple().to_string()[..6]);

    for (label, action_id, args) in [
        (
            "channel card",
            "channel.create",
            json!({"name": name, "kind": "public"}),
        ),
        (
            "settings card",
            "workspace.settings.update",
            json!({"welcomePrompt": "안녕하세요"}),
        ),
    ] {
        let card = h
            .raise(h.owner, action_id, args, &[], 0)
            .await
            .expect(label);
        // A settings write in flight: it holds the row (`NO KEY UPDATE`, the weakest write lock,
        // which blocks nothing but another settings reader/writer) and has not committed.
        let mut writer = h.su.begin().await.unwrap();
        sqlx::query("SELECT 1 FROM workspace WHERE id = $1 FOR NO KEY UPDATE")
            .bind(h.workspace)
            .execute(&mut *writer)
            .await
            .unwrap();
        let writer_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *writer)
            .await
            .unwrap();
        let workspace = h.workspace;
        let (decided, waited) =
            tokio::join!(h.decide(&h.owner_token, card.approval_id, true), async {
                let mut waited = false;
                for _ in 0..200 {
                    if waiting_on(&h.su, writer_pid).await > 0 {
                        waited = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                // The write turns the bundle off and commits, whether or not anything waited.
                sqlx::query(
                    "UPDATE workspace SET settings = jsonb_set(settings, '{team_ai_roles}', \
                       '{\"workspace_admin\": false}'::jsonb) WHERE id = $1",
                )
                .bind(workspace)
                .execute(&mut *writer)
                .await
                .unwrap();
                writer.commit().await.unwrap();
                waited
            });
        assert!(
            waited,
            "{label}: the decision did not wait for the settings write in flight"
        );
        assert_eq!(decided.0, 409, "{label}: {}", decided.1);
        assert_eq!(decided.1["status"], "action_args_invalid", "{label}");
        assert_eq!(
            h.channel_named(&name).await,
            0,
            "{label}: the card did not run"
        );
        assert!(
            h.settings().await.get("welcome_prompt").is_none(),
            "{label}: the card did not run"
        );
        assert_eq!(
            h.approval_status(card.approval_id).await,
            "pending",
            "{label}"
        );
        // Back on for the next card; the refused card can still be rejected.
        sqlx::query("UPDATE workspace SET settings = settings - 'team_ai_roles' WHERE id = $1")
            .bind(h.workspace)
            .execute(&h.su)
            .await
            .unwrap();
        assert_eq!(
            h.decide(&h.owner_token, card.approval_id, false).await.0,
            200,
            "{label}"
        );
    }
}

/// Whether a second connection can take the row in `clause` mode without waiting.
async fn row_lock_free(su: &PgPool, workspace: Uuid, clause: &str) -> bool {
    let mut tx = su.begin().await.unwrap();
    let outcome = sqlx::query(&format!(
        "SELECT 1 FROM workspace WHERE id = $1 {clause} NOWAIT"
    ))
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await;
    let free = match outcome {
        Ok(_) => true,
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("55P03") => false,
        Err(other) => panic!("unexpected error taking the row: {other}"),
    };
    let _ = tx.rollback().await;
    free
}

/// The decision's read holds the settings row in the mode it names: `Share` lets another reader in
/// and keeps every writer out; `Update` keeps both out. A row that cannot be read answers with every
/// bundle off, the refusing side.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s12_the_decisions_read_holds_the_settings_row_in_the_mode_it_names() {
    use momo_workspace_actions::team_ai::{read_roles_locked_in_tx, SettingsRowLock};
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    for (lock, label, other_reader_free, writer_free) in [
        (SettingsRowLock::Share, "share", true, false),
        (SettingsRowLock::Update, "update", false, false),
    ] {
        let mut holder = h.su.begin().await.unwrap();
        let read = read_roles_locked_in_tx(&mut holder, h.workspace, lock)
            .await
            .unwrap();
        assert_eq!(
            read,
            TeamAiRoles::default(),
            "{label}: the switches as stored"
        );
        assert_eq!(
            row_lock_free(&h.su, h.workspace, "FOR SHARE").await,
            other_reader_free,
            "{label}: another share lock"
        );
        assert_eq!(
            row_lock_free(&h.su, h.workspace, "FOR UPDATE").await,
            writer_free,
            "{label}: an update lock"
        );
        holder.rollback().await.unwrap();
        assert!(
            row_lock_free(&h.su, h.workspace, "FOR UPDATE").await,
            "{label}: released with the transaction"
        );
    }

    let mut conn = h.su.acquire().await.unwrap();
    let nowhere = read_roles_locked_in_tx(&mut conn, Uuid::new_v4(), SettingsRowLock::Share)
        .await
        .unwrap();
    assert_eq!(
        nowhere,
        TeamAiRoles::none_on(),
        "an unreadable row refuses every bundle"
    );
    assert_eq!(nowhere.off_bundles().len(), roles::SWITCHABLE_BUNDLES.len());
}

/// The roles card is the workspace's own admins' to approve: a member who carries the
/// `platform:read` scope but is not an owner or admin gets 403 `role_required` — nothing moves and
/// the card stays pending — while the workspace's admin approves the same card.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s13_a_platform_reader_who_is_not_an_admin_cannot_approve_the_roles_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let reader_token = momo_auth::sign_access(
        h.member,
        h.workspace,
        &["platform:read".to_string()],
        TEST_JWT_SECRET,
    )
    .expect("sign a platform reader JWT")
    .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY['platform:read']::text[],'roles-reader')",
    )
    .bind(h.workspace)
    .bind(h.member)
    .bind(&reader_token)
    .execute(&h.su)
    .await
    .expect("record the platform reader's session token");

    let card = h
        .raise(
            h.owner,
            ROLES_CARD,
            json!({"bundle": "files", "enabled": false}),
            &[],
            0,
        )
        .await
        .expect("a direct request is a card");
    let (status, refused) = h.decide(&reader_token, card.approval_id, true).await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(h.roles().await, TeamAiRoles::default(), "nothing moved");
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    assert!(h.audit_rows("team_ai.roles.changed").await.is_empty());

    let (status, decided) = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(status, 200, "{decided}");
    assert!(!h.roles().await.is_on(roles::FILES));
}

// --- the screens' consent record (#5040) ---------------------------------------------------------

/// The consent record a screen carries on the settings PATCH it already sends.
fn notice_claim(bundles: Value, via: &str) -> Value {
    json!({"bundles": bundles, "noticeVersion": roles::NOTICE_VERSION, "via": via})
}

impl Harness {
    /// Every `team_ai.roles.notice_shown` row of this workspace, oldest first: its detail, who
    /// (the actor) and whether `created_at` — the row's own clock — is from the last minute.
    async fn notice_records(&self) -> Vec<(Value, Option<Uuid>, bool)> {
        sqlx::query_as(
            "SELECT detail, actor_member_id, (now() - created_at) < interval '1 minute' \
               FROM audit_log \
              WHERE workspace_id = $1 AND action = 'team_ai.roles.notice_shown' \
              ORDER BY created_at, id",
        )
        .bind(self.workspace)
        .fetch_all(&self.su)
        .await
        .expect("notice records")
    }
}

/// How many consent rows `workspace` shows to the NOBYPASSRLS app role under its own tenant scope.
async fn notice_rows_seen_by_the_app_role(app: &PgPool, scope: Uuid) -> i64 {
    with_tenant_tx(app, scope, move |conn| {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_log WHERE action = 'team_ai.roles.notice_shown'",
            )
            .fetch_one(&mut *conn)
            .await?;
            Ok(count)
        })
    })
    .await
    .expect("count under the tenant scope")
}

/// B3 고지 (#5040): turning `files` on from the settings screen, with the claim that the screen
/// showed the line, leaves ONE consent row — who (the admin), when (the row's clock), which bundle,
/// which wording, through which screen — in the same transaction as the switch. The claim is not a
/// setting: it is not stored, not echoed, and not a "key patched" in the settings audit row. The
/// same PATCH from an older client (no claim) turns the switch on all the same and records nothing,
/// and the onboarding screen's carrier — the PATCH that switches the helper on — records too.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s14_a_screen_that_shows_the_notice_leaves_one_record_with_the_wording_it_named() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    // Off needs no record: nothing goes to the provider by turning a bundle off.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"files": false, "memory": false}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(h.notice_records().await.is_empty());
    let updated_before = h.audit_rows("workspace_setting.updated").await.len();

    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({
                "team_ai_roles": {"files": true},
                "team_ai_roles_notice": notice_claim(json!(["files"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(h.roles().await.is_on(roles::FILES), "the switch moved");
    let records = h.notice_records().await;
    assert_eq!(records.len(), 1, "{records:?}");
    let (detail, actor, recent) = &records[0];
    assert_eq!(detail["bundles"], json!(["files"]), "which bundle");
    assert_eq!(
        detail["notice_version"],
        roles::NOTICE_VERSION,
        "which wording"
    );
    assert_eq!(detail["via"], "settings", "through which screen");
    assert_eq!(
        detail["approval_id"],
        Value::Null,
        "a screen's record carries no approval"
    );
    assert_eq!(*actor, Some(h.owner), "who");
    assert!(*recent, "when: the row's own clock");
    // Not a setting: neither stored nor echoed, and not a key the settings audit row names.
    assert!(body.get("team_ai_roles_notice").is_none(), "{body}");
    assert!(h.settings().await.get("team_ai_roles_notice").is_none());
    let updated = h.audit_rows("workspace_setting.updated").await;
    assert_eq!(updated.len(), updated_before + 1);
    assert_eq!(updated.last().unwrap()["keys"], json!(["team_ai_roles"]));
    // The switch's own audit row is still the one it always was.
    let changed = h.audit_rows("team_ai.roles.changed").await;
    assert_eq!(changed.last().unwrap()["keys"], json!(["files"]));
    assert_eq!(changed.last().unwrap()["source"], "settings");

    // An older client: the same switch without the claim moves and records nothing.
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": {"memory": true}}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(h.roles().await.is_on(roles::MEMORY));
    assert_eq!(
        h.notice_records().await.len(),
        1,
        "no claim, no record, nothing blocked"
    );

    // The onboarding screen: its claim rides on the PATCH that switches the helper on.
    let other = harness_with(Some(h.base.clone()), &app, &su, false).await;
    let (status, body) = other
        .patch(
            &other.owner_token,
            json!({
                "team_ai_fast_path": true,
                "team_ai_roles_notice": notice_claim(json!(["memory", "files"]), "onboarding"),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body["team_ai_agent_member_id"].is_string(),
        "the helper is on: {body}"
    );
    let records = other.notice_records().await;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].0["via"], "onboarding");
    assert_eq!(
        records[0].0["bundles"],
        json!(["files", "memory"]),
        "table order"
    );
    assert_eq!(records[0].1, Some(other.owner));

    // The wording a claim names is the wording that is recorded, not the server's newest. The
    // route's list holds one version, so a second is listed here to let the two differ.
    let older = momo_workspace_actions::team_ai_roles::parse_screen_notice_against(
        &json!({"bundles": ["memory"], "noticeVersion": "2026-01-01.v0", "via": "settings"}),
        &["2026-01-01.v0", roles::NOTICE_VERSION],
    )
    .expect("an older wording the (test) list holds");
    let mut conn = h.su.acquire().await.unwrap();
    let written = momo_workspace_actions::team_ai_roles::record_notice_in_tx(
        &mut conn,
        h.workspace,
        h.owner,
        None,
        &older,
    )
    .await
    .unwrap();
    assert!(written);
    drop(conn);
    let records = h.notice_records().await;
    assert_eq!(records.len(), 2, "{records:?}");
    assert_eq!(
        records[1].0["notice_version"], "2026-01-01.v0",
        "the screen's wording, not NOTICE_VERSION"
    );
    assert_eq!(records[1].0["bundles"], json!(["memory"]));
}

/// B3 고지 (#5040): a claim the server cannot make sense of is a 400 and NOTHING is written — not
/// the switch it rode on, not a record, not the settings audit row — whichever field is wrong. A
/// PATCH that is refused before it writes (a bad settings value, a missing admin, the 409
/// `team_memory_off`) leaves no record of a switch that did not move.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s15_a_record_the_server_cannot_read_is_a_400_and_a_switch_that_did_not_move_leaves_none() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let settings_before = h.settings().await;
    let updated_before = h.audit_rows("workspace_setting.updated").await.len();

    let wording = json!(roles::NOTICE_VERSION);
    let bad_claims = [
        (
            "a wording the server never listed",
            json!({"bundles": ["files"], "noticeVersion": "2099-01-01.v9", "via": "settings"}),
        ),
        (
            "via is a card: that consent needs its approval",
            json!({"bundles": ["files"], "noticeVersion": wording, "via": "card"}),
        ),
        (
            "a bundle that carries no notice",
            json!({"bundles": ["code"], "noticeVersion": wording, "via": "settings"}),
        ),
        (
            "an approval id a screen has no business sending",
            json!({"bundles": ["files"], "noticeVersion": wording, "via": "settings",
                   "approvalId": "00000000-0000-0000-0000-000000000001"}),
        ),
        (
            "no bundle at all",
            json!({"bundles": [], "noticeVersion": wording, "via": "settings"}),
        ),
        ("not an object", json!("files")),
    ];
    for (what, claim) in bad_claims {
        let (status, body) = h
            .patch(
                &h.owner_token,
                json!({"team_ai_roles": {"files": false}, "team_ai_roles_notice": claim}),
            )
            .await;
        assert_eq!(status, 400, "{what}: {body}");
    }
    assert_eq!(
        h.settings().await,
        settings_before,
        "the switch it rode on did not move"
    );
    assert!(h.roles().await.is_on(roles::FILES));
    assert!(h.notice_records().await.is_empty());
    assert!(h.audit_rows("team_ai.roles.changed").await.is_empty());
    assert_eq!(
        h.audit_rows("workspace_setting.updated").await.len(),
        updated_before,
        "a refused request writes no settings audit row either"
    );

    // A valid claim on a PATCH the settings logic itself refuses (chat_read is no switch): no row.
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({
                "team_ai_roles": {"chat_read": false},
                "team_ai_roles_notice": notice_claim(json!(["files"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(h.notice_records().await.is_empty());

    // A member who is not an admin: 403, and the claim is not read, let alone recorded.
    let (status, body) = h
        .patch(
            &h.member_token,
            json!({
                "team_ai_roles": {"files": false},
                "team_ai_roles_notice": notice_claim(json!(["files"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    assert!(h.notice_records().await.is_empty());

    // Turning `memory` on while team memory is off is 409 and writes nothing — and a refusal
    // that COMMITS must not carry the record of a switch that did not move.
    sqlx::query(
        "INSERT INTO mem_settings (workspace_id, scope, enabled, paused) \
         VALUES ($1, 'workspace', false, false)",
    )
    .bind(h.workspace)
    .execute(&h.su)
    .await
    .expect("team memory off");
    let (status, body) = h
        .patch(&h.owner_token, json!({"team_ai_roles": {"memory": false}}))
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({
                "team_ai_roles": {"memory": true},
                "team_ai_roles_notice": notice_claim(json!(["memory"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "team_memory_off");
    assert!(!h.roles().await.is_on(roles::MEMORY), "nothing written");
    assert!(
        h.notice_records().await.is_empty(),
        "no switch moved, no record"
    );
}

/// 두 테넌트 (#5040): A's record is A's. B has none; the NOBYPASSRLS app role sees A's row only
/// under A's scope; and an admin of A cannot leave a record in B by naming B's settings path.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn s16_another_workspace_neither_gets_nor_sees_the_record() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let a = harness(None, &app, &su).await;
    let b = harness(Some(a.base.clone()), &app, &su).await;
    let b_before = b.settings().await;

    let (status, body) = a
        .patch(
            &a.owner_token,
            json!({
                "team_ai_roles": {"files": true},
                "team_ai_roles_notice": notice_claim(json!(["files"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(a.notice_records().await.len(), 1);
    assert!(b.notice_records().await.is_empty(), "B has no record");
    assert_eq!(b.settings().await, b_before, "B's bag did not move");
    assert_eq!(
        notice_rows_seen_by_the_app_role(&app, a.workspace).await,
        1,
        "A sees its own"
    );
    assert_eq!(
        notice_rows_seen_by_the_app_role(&app, b.workspace).await,
        0,
        "B's scope cannot read A's record"
    );

    // A's admin names B's path: refused, and no record lands in B (or in A).
    let response = a
        .http
        .patch(format!("{}/v1/workspaces/{}/settings", a.base, b.workspace))
        .bearer_auth(&a.owner_token)
        .json(&json!({
            "team_ai_roles": {"files": true},
            "team_ai_roles_notice": notice_claim(json!(["files"]), "settings"),
        }))
        .send()
        .await
        .expect("cross-workspace patch");
    assert_ne!(
        response.status().as_u16(),
        200,
        "A's token does not reach B's settings"
    );
    assert!(b.notice_records().await.is_empty());
    assert_eq!(a.notice_records().await.len(), 1);

    // B's own admin leaves B's own record, which A cannot see either.
    let (status, body) = b
        .patch(
            &b.owner_token,
            json!({
                "team_ai_roles": {"memory": true},
                "team_ai_roles_notice": notice_claim(json!(["memory"]), "settings"),
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(b.notice_records().await.len(), 1);
    assert_eq!(
        a.notice_records().await.len(),
        1,
        "A still has only its own"
    );
    assert_eq!(notice_rows_seen_by_the_app_role(&app, b.workspace).await, 1);
    assert_eq!(notice_rows_seen_by_the_app_role(&app, a.workspace).await, 1);
}
