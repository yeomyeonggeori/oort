//! ADR-0201 증보 v3 B4 (#4965 S2) — the team AI's **invite cards**: `invite.create` and
//! `agent.invite` raised by the helper ("oort 도우미"), and where the one-time value goes by
//! DOOR. Server half, against a real Postgres and the real HTTP router on `momo_app`
//! (NOBYPASSRLS), two tenants where it matters. The worker half (what the model is offered, the
//! requester pre-check, the injection case) is `momo-agent-worker`'s `team_ai_invite_conformance_pg`.
//!
//! `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:pg18`:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-server --test team_ai_invite_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Cards are raised through `momo_workspace_actions::team_ai::propose_in_tx` (the function the
//! worker calls); every decision is the real route. The "string search" tests scan **every table of
//! the database** for the minted code, so a new place the link could be written cannot hide.
//!
//! | test | acceptance | revert that makes it red |
//! |---|---|---|
//! | `i1_the_helpers_invite_link_is_one_message_in_the_same_transaction` | B4-2, B15-A2 | drop `post_invite_link_message_in_tx`, or hand the link to `secret_once` again |
//! | `i2_the_pairing_code_is_the_approvers_alone_and_the_flag_is_refused` | B4-2, B16-D ⑧ | make `payload_offers_opt_in_delivery` ignore the door, or route the helper's `agent.invite` to a claim |
//! | `i3_the_door_is_read_from_the_stored_payload_only` | B4-2 문 판정 | read the door from anything but `raised_by_team_ai(&approval.payload)` (e.g. the request's flag) |
//! | `i4_only_an_admin_decides_and_a_demoted_approver_is_refused` | B4-1, B15-A4 | drop the `GatePlan::Admin` re-proof |
//! | `i5_a_card_that_read_something_is_refused_at_the_decision_and_at_the_proposal` | B4-3, B13-I4 | take the invite ids out of `SENSITIVE_ACTION_IDS` |
//! | `i6_a_bundle_switched_off_stops_both_the_proposal_and_a_card_already_drawn` | B13-I5 | drop the bundle check from `team_ai_card_gate_in_tx` or the proposal |
//! | `i7_a_requester_who_cannot_approve_gets_no_card` | B4-1, B15-A4 | drop `requester_could_approve_in_tx` |
//! | `i8_a_failed_post_takes_the_invite_with_it` | B4-2 같은 tx | swallow the error of `send_message_in_tx`, or post outside the transaction |
//! | `i9_a_helper_that_left_the_conversation_makes_the_card_stale_before_any_mint` | B4-2 | drop the membership check before the mint |
//! | `i10_another_workspace_cannot_decide_or_receive_it` | 두 테넌트 | decide without the workspace id |
//! | `i11_the_link_message_never_reaches_a_later_model_context` | B13-I2 | drop the marker arm of `context_message_body` |
//! | `i12_the_link_message_in_a_dm_wakes_nobody_while_an_ordinary_line_wakes_the_admin` | r1 Medium-1 | drop `announce: true` from `invite_link::props()` |
//! | `i13_a_members_forged_link_marker_is_stripped_by_the_route` | r1 Low-1 | drop `is_server_owned_props_entry` from `props_value` |
//! | `i14_the_helper_raises_no_admin_link_and_a_card_that_says_admin_is_refused_at_the_decision` | r1 Low-4 | drop the role check from the proposal, or from `team_ai_card_gate_in_tx` |
//! | `i15_a_link_the_helper_makes_without_numbers_is_one_use_for_one_day` | r1 Low-7 | drop `team_ai_door_args` from the proposal |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{create_channel, send_message_in_tx, ChannelKind, NewChannel, NewMessage};
use momo_server::{build_app, AppState};
use momo_workspace_actions::team_ai::{self, ProposalContext, ProposalOk, ProposalRefusal, ViaAi};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "team-ai-invite-4965-secret";
const TEST_PASSWORD: &str = "team-ai-invite-4965-password";
const INVITE: &str = "invite.create";
const PAIRING: &str = "agent.invite";

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

/// The role the push judgment runs as in production (`momo_notifier`, bootstrap_roles.sql): the
/// judgment polls every tenant, which is its one standing exception to the row-level fence.
async fn notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(
            options.username("momo_notifier").password(
                &std::env::var("MOMO_NOTIFIER_PASSWORD")
                    .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string()),
            ),
        )
        .await
        .expect("connect as momo_notifier (bootstrap_roles.sql)")
}

/// A DM of `members` — the DM's own key, the sequence row a channel has, one membership each.
async fn seed_dm(su: &PgPool, workspace: Uuid, created_by: Uuid, members: &[Uuid]) -> Uuid {
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, dm_key, created_by) \
         VALUES($1,$2,'dm',NULL,$3,$4)",
    )
    .bind(dm)
    .bind(workspace)
    .bind(format!("dm-{}", dm.simple()))
    .bind(created_by)
    .execute(su)
    .await
    .expect("seed a DM channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(dm)
        .bind(workspace)
        .execute(su)
        .await
        .expect("the DM's sequence row");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(dm)
        .bind(member)
        .execute(su)
        .await
        .expect("seed a DM membership");
    }
    dm
}

/// A phone for `member` — without an active token the judgment drops a person at its
/// `push_token` join, and "nobody is woken" would prove nothing.
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

/// Who the push judgment would wake for one committed message, and for what: `(member, reason)`.
async fn judged(
    notifier: &PgPool,
    workspace: Uuid,
    message: Uuid,
) -> Vec<(Uuid, momo_push::PushReason)> {
    let mut conn = notifier.acquire().await.expect("acquire notifier");
    momo_push::judge_targets(&mut conn, workspace, message)
        .await
        .expect("judge_targets")
        .into_iter()
        .map(|target| (target.member_id, target.reason))
        .collect()
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

// --- a global log capture (the server's own worker threads emit; a thread-local one sees nothing) -----

fn log_capture() -> Arc<Mutex<Vec<u8>>> {
    static CAPTURE: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let buffer = Arc::new(Mutex::new(Vec::new()));
            let _ = tracing_subscriber::fmt()
                .with_writer(CaptureWriter(buffer.clone()))
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .try_init();
            buffer
        })
        .clone()
}

#[derive(Clone)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut sink) = self.0.lock() {
            if sink.len() < 64 * 1024 * 1024 {
                sink.extend_from_slice(buf);
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn captured_since(buffer: &Arc<Mutex<Vec<u8>>>, offset: usize) -> String {
    let sink = buffer.lock().expect("the capture buffer is healthy");
    String::from_utf8_lossy(&sink[offset.min(sink.len())..]).into_owned()
}

fn capture_offset(buffer: &Arc<Mutex<Vec<u8>>>) -> usize {
    buffer.lock().expect("the capture buffer is healthy").len()
}

// --- the world ------------------------------------------------------------------------------------

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
    let workspace = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{owner}@invite4965.test");
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
    .bind(format!("{member}@invite4965.test"))
    .execute(su)
    .await
    .expect("member auth");
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("inv-{}", &Uuid::new_v4().simple().to_string()[..8]),
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
        .json(
            &json!({"email": email, "password": TEST_PASSWORD, "workspace": workspace.to_string()}),
        )
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
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'invite-conformance')",
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

/// One decision, in full: the status, whether the answer says `no-store`, and the body.
struct Decided {
    status: u16,
    no_store: bool,
    body: Value,
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

    async fn decide_with(
        &self,
        token: &str,
        approval: Uuid,
        approve: bool,
        deliver_to_agent: Option<bool>,
    ) -> Decided {
        let mut request = json!({
            "approvalId": approval,
            "approve": approve,
            "clientDecisionId": Uuid::new_v4()
        });
        if let Some(deliver) = deliver_to_agent {
            request["deliverSecretToAgent"] = json!(deliver);
        }
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/approvals/{approval}/decision",
                self.base, self.workspace
            ))
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .expect("decision responds");
        let status = response.status().as_u16();
        let no_store = response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("no-store"));
        Decided {
            status,
            no_store,
            body: response.json().await.unwrap_or(Value::Null),
        }
    }

    async fn decide(&self, token: &str, approval: Uuid, approve: bool) -> Decided {
        self.decide_with(token, approval, approve, None).await
    }

    /// The helper raises one card for `requester`, through the very function the worker calls.
    async fn raise(
        &self,
        requester: Uuid,
        action_id: &str,
        args: Value,
        via_tools: &[&str],
        web_searches: i32,
    ) -> Result<ProposalOk, ProposalRefusal> {
        self.raise_in(
            self.channel,
            requester,
            action_id,
            args,
            via_tools,
            web_searches,
        )
        .await
    }

    /// [`Self::raise`] in a conversation of the caller's choosing (a DM, where the push judgment
    /// has a recipient for a line the helper writes).
    async fn raise_in(
        &self,
        channel: Uuid,
        requester: Uuid,
        action_id: &str,
        args: Value,
        via_tools: &[&str],
        web_searches: i32,
    ) -> Result<ProposalOk, ProposalRefusal> {
        let (workspace, helper) = (self.workspace, self.helper);
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
                        latency_ms: 812,
                        prompt_tokens: 120,
                        completion_tokens: 40,
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

    async fn raise_invite(&self) -> ProposalOk {
        self.raise(
            self.owner,
            INVITE,
            json!({"role": "member", "maxUses": 5, "expiresInDays": 7}),
            &[],
            0,
        )
        .await
        .expect("an admin's direct request is a card")
    }

    async fn raise_pairing(&self) -> ProposalOk {
        let handle = format!("gb{}", &Uuid::new_v4().simple().to_string()[..8]);
        self.raise(
            self.owner,
            PAIRING,
            json!({"platform": "grok_bot", "displayName": "그록봇 둘", "handle": handle}),
            &[],
            0,
        )
        .await
        .expect("an admin's direct request is a card")
    }

    async fn approval_status(&self, approval: Uuid) -> String {
        sqlx::query_scalar("SELECT status::text FROM approval WHERE id = $1")
            .bind(approval)
            .fetch_one(&self.su)
            .await
            .expect("approval status")
    }

    async fn approval_payload(&self, approval: Uuid) -> Value {
        sqlx::query_scalar("SELECT payload FROM approval WHERE id = $1")
            .bind(approval)
            .fetch_one(&self.su)
            .await
            .expect("approval payload")
    }

    async fn invites(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM invite_code WHERE workspace_id = $1")
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect("invite count")
    }

    async fn agents_named(&self, name: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM member WHERE workspace_id = $1 AND kind = 'agent' \
                AND display_name = $2",
        )
        .bind(self.workspace)
        .bind(name)
        .fetch_one(&self.su)
        .await
        .expect("agent count")
    }

    async fn last_seq(&self) -> i64 {
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(self.channel)
            .fetch_one(&self.su)
            .await
            .expect("channel_seq")
    }

    /// Text messages the helper wrote in the channel: `(id, seq, body, props)`.
    async fn helper_texts(&self) -> Vec<(Uuid, i64, String, Value)> {
        self.helper_texts_in(self.channel).await
    }

    /// [`Self::helper_texts`] for any conversation of the workspace.
    async fn helper_texts_in(&self, channel: Uuid) -> Vec<(Uuid, i64, String, Value)> {
        sqlx::query_as::<_, (Uuid, i64, Option<String>, Value)>(
            "SELECT id, seq, body, props FROM message \
              WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
                AND type::text = 'text' ORDER BY seq",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(self.helper)
        .fetch_all(&self.su)
        .await
        .expect("helper messages")
        .into_iter()
        .map(|(id, seq, body, props)| (id, seq, body.unwrap_or_default(), props))
        .collect()
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

    /// Every base table of the database — all of them are in `public`, the only non-system schema
    /// (153 at this head, the `mem_*` tables included) — with the number of rows whose text holds `needle`
    /// (case-insensitive: a full-text index lower-cases what it keeps). The needle is a random code,
    /// so rows of other tests cannot match it; the answer is "where does this string live".
    async fn where_it_lives(&self, needle: &str) -> Vec<(String, i64)> {
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
        )
        .fetch_all(&self.su)
        .await
        .expect("tables");
        let pattern = format!("%{needle}%");
        let mut found = Vec::new();
        for table in tables {
            let count: i64 = sqlx::query_scalar(&format!(
                "SELECT count(*) FROM \"{table}\" x WHERE x::text ILIKE $1"
            ))
            .bind(&pattern)
            .fetch_one(&self.su)
            .await
            .unwrap_or(0);
            if count > 0 {
                found.push((table, count));
            }
        }
        found
    }

    async fn post(&self, token: &str, body: &str) -> Value {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                self.base, self.workspace, self.channel
            ))
            .bearer_auth(token)
            .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
            .send()
            .await
            .expect("send");
        assert_eq!(response.status(), 201, "send {body}");
        response.json().await.expect("send body")
    }
}

/// The code inside `…/join?code=<code>` on the link line of the helper's message.
fn code_of(body: &str) -> String {
    let link = body.lines().nth(1).expect("the link is line 2");
    link.split("join?code=")
        .nth(1)
        .expect("a join link")
        .to_string()
}

// --- invite.create, the helper's door ---------------------------------------------------------------

/// B4-2 / B15-A2: approving the helper's `invite.create` writes ONE message by the helper in the
/// conversation the request came from — `channel_seq`, `message` and the outbox event in the
/// decision's transaction — whose body is the server's sentence and the link and whose props carry a
/// marker and no link. The decision answers no `secretOnce` and the payload grows no `secretClaim`.
/// And the code is **nowhere else** in the database, and in no captured log line.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i1_the_helpers_invite_link_is_one_message_in_the_same_transaction() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let logs = log_capture();

    let card = h.raise_invite().await;
    // The request card says where the link goes, in the helper's words (B4-2), and not the Agent
    // Port's.
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id = $1 AND id = $2")
            .bind(h.workspace)
            .bind(card.card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    let rows = card_props["action"]["rows"].to_string();
    assert!(rows.contains("링크 받는 곳"), "{rows}");
    assert!(
        rows.contains(
            "승인하면 도우미가 이 대화에 링크를 올려요. 대화에 있는 사람은 모두 볼 수 있어요"
        ),
        "{rows}"
    );
    assert!(
        !rows.contains("에이전트가 이 링크를 받아 전달해요"),
        "{rows}"
    );
    let stored = h.approval_payload(card.approval_id).await;
    assert_eq!(stored["via_ai"]["source"], "team_ai");
    assert_eq!(h.invites().await, 0, "a proposal mints nothing");

    let (seq_before, helper_before) = (h.last_seq().await, h.helper_texts().await.len());
    let mark = capture_offset(&logs);
    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert!(decided.no_store, "no-store on the decision");

    // The answer carries no value; the payload carries no claim.
    assert!(
        decided.body["result"]["secretOnce"].is_null(),
        "{}",
        decided.body
    );
    assert!(
        !decided.body.to_string().contains("join?code"),
        "{}",
        decided.body
    );
    let payload = h.approval_payload(card.approval_id).await;
    assert!(payload.get("secretClaim").is_none(), "{payload}");
    assert_eq!(h.approval_status(card.approval_id).await, "approved");
    assert_eq!(h.invites().await, 1);

    // ONE helper message, after the card, in the reply channel: sentence, then the link.
    let texts = h.helper_texts().await;
    assert_eq!(texts.len(), helper_before + 1, "{texts:?}");
    let (message_id, seq, body, props) = texts.last().cloned().unwrap();
    assert!(
        seq > seq_before && seq <= h.last_seq().await,
        "seq {seq} vs {seq_before}"
    );
    assert_eq!(body.lines().next(), Some("초대 링크를 올렸어요"));
    assert!(
        body.lines().nth(1).unwrap().contains("/join?code="),
        "{body}"
    );
    assert_eq!(body.lines().count(), 2);
    // The marker, the sentence a notification shows, and the quiet-line key (r1 Medium-1: a JSON
    // boolean `true`, so the push judgment sends this line to nobody — i12 measures that).
    assert_eq!(
        props,
        json!({"kind": "team_ai_invite_link", "preview": "초대 링크를 올렸어요", "announce": true})
    );
    let code = code_of(&body);
    assert!(code.len() >= 16, "a real code: {code}");

    // The outbox event of THAT message is the other place the link is (B4-2's exception).
    let event_rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT kind::text, payload FROM outbox WHERE workspace_id = $1 \
           AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(h.workspace)
    .bind(message_id.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    assert!(
        !event_rows.is_empty(),
        "the send spine's outbox event exists"
    );
    assert!(
        event_rows
            .iter()
            .any(|(_, payload)| payload.to_string().contains(&code)),
        "the event carries the message, link and all"
    );

    // The string search: the code lives in the message row and in outbox rows about that very
    // message — nowhere else in the database.
    let lives = h.where_it_lives(&code).await;
    for (table, _) in &lives {
        assert!(
            table == "message" || table == "outbox",
            "the invite code is also in `{table}`: {lives:?}"
        );
    }
    assert!(
        lives
            .iter()
            .any(|(table, count)| table == "message" && *count == 1),
        "{lives:?}"
    );
    let strays: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 \
           AND payload::text ILIKE '%' || $2 || '%' AND payload::text NOT LIKE '%' || $3 || '%'",
    )
    .bind(h.workspace)
    .bind(&code)
    .bind(message_id.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        strays, 0,
        "an outbox row that holds the code and is not about the message"
    );
    // The push path is id-only (ADR-0120 D2): the candidate the message INSERT trigger queued
    // names the message and the channel, and the preview a banner shows is the body's FIRST line —
    // the fixed sentence — or `props.preview`, which is the same sentence. Neither is the link.
    let candidates: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id = $1 AND kind::text = 'push_candidate' \
           AND payload::text LIKE '%' || $2 || '%'",
    )
    .bind(h.workspace)
    .bind(message_id.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    assert!(
        !candidates.is_empty(),
        "the message queued a push candidate"
    );
    for candidate in &candidates {
        assert!(
            !candidate
                .to_string()
                .to_lowercase()
                .contains(&code.to_lowercase()),
            "{candidate}"
        );
        assert!(
            candidate.get("body").is_none() && candidate.get("preview").is_none(),
            "{candidate}"
        );
    }
    assert_eq!(
        body.lines().next(),
        props["preview"].as_str(),
        "the preview is the first line"
    );
    assert!(!body.lines().next().unwrap().contains(&code));
    // The captured log of the decision holds no code and no link.
    let log = captured_since(&logs, mark);
    assert!(!log.is_empty(), "the capture saw the decision");
    assert!(!log.contains(&code), "the invite code is in the log");

    // No link preview will ever be made of it (a tombstone, so the worker skips the job).
    let tombstones: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message_unfurl_tombstone WHERE message_id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(tombstones, 1);

    // The result card says where the link went, and that it is a flag, not a value.
    let result: Value = sqlx::query_scalar(
        "SELECT props->'result' FROM message WHERE workspace_id = $1 AND id = $2",
    )
    .bind(h.workspace)
    .bind(card.card_message_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(result["secret_shown_once"], false, "{result}");
    assert!(
        result["rows"]
            .to_string()
            .contains("도우미가 이 대화에 링크를 올렸어요"),
        "{result}"
    );

    // B4-7: provenance on the domain row and on `action.approved`, with no text.
    for action in ["invite.created", "action.approved"] {
        let rows = h.audit_rows(action).await;
        assert_eq!(rows.len(), 1, "{action}: {rows:?}");
        let via = &rows[0]["via_ai"];
        assert_eq!(via["source"], "team_ai", "{action}: {}", rows[0]);
        assert_eq!(via["tools"], json!([]));
        assert_eq!(via["model_calls"], 1);
        assert_eq!(via["prompt_tokens"], 120);
        assert_eq!(via["latency_ms"], 812);
        assert!(!rows[0].to_string().contains(&code), "{action}");
    }
}

// --- agent.invite, the helper's door ---------------------------------------------------------------

/// B4-2 / B16-D ⑧: the helper's `agent.invite` has no box to tick. The flag is a 400 and consumes
/// nothing; the plain approval shows the pairing code to the approver ONLY — in the answer, with
/// `no-store` — and writes nothing into the conversation, no claim, no table and no log line.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i2_the_pairing_code_is_the_approvers_alone_and_the_flag_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;
    let logs = log_capture();

    let card = h.raise_pairing().await;
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id = $1 AND id = $2")
            .bind(h.workspace)
            .bind(card.card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    let rows = card_props["action"]["rows"].to_string();
    assert!(rows.contains("연결 코드 받는 사람"), "{rows}");
    assert!(rows.contains("승인한 분만 한 번 볼 수 있어요"), "{rows}");
    assert!(!rows.contains("승인할 때 고르세요"), "{rows}");

    let texts_before = h.helper_texts().await.len();
    let mark = capture_offset(&logs);
    // The flag: refused before anything runs, and the card is still there.
    let refused = h
        .decide_with(&h.owner_token, card.approval_id, true, Some(true))
        .await;
    assert_eq!(refused.status, 400, "{}", refused.body);
    assert_eq!(refused.body["status"], "deliver_secret_not_supported");
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    assert_eq!(h.agents_named("그록봇 둘").await, 0);

    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert!(decided.no_store);
    let secret = &decided.body["result"]["secretOnce"];
    assert_eq!(secret["kind"], "pairing_credential", "{}", decided.body);
    let code = secret["value"]
        .as_str()
        .expect("the code, once")
        .to_string();
    assert!(code.len() >= 16);
    assert_eq!(h.agents_named("그록봇 둘").await, 1);
    let payload = h.approval_payload(card.approval_id).await;
    assert!(payload.get("secretClaim").is_none(), "{payload}");
    assert_eq!(
        h.helper_texts().await.len(),
        texts_before,
        "the code never becomes a message"
    );

    // Nowhere in the database, nowhere in the log.
    let lives = h.where_it_lives(&code).await;
    assert!(lives.is_empty(), "the pairing code is stored in {lives:?}");
    assert!(
        !captured_since(&logs, mark).contains(&code),
        "the pairing code is in the log"
    );
    // The result row says who saw it; B4-7's provenance is on both audit rows.
    let result: Value = sqlx::query_scalar(
        "SELECT props->'result' FROM message WHERE workspace_id = $1 AND id = $2",
    )
    .bind(h.workspace)
    .bind(card.card_message_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        result["rows"].to_string().contains("승인한 분만 봐요"),
        "{result}"
    );
    assert_eq!(result["secret_shown_once"], true);
    for action in ["agent.invited", "action.approved"] {
        let rows = h.audit_rows(action).await;
        assert_eq!(rows.len(), 1, "{action}");
        assert_eq!(
            rows[0]["via_ai"]["source"], "team_ai",
            "{action}: {}",
            rows[0]
        );
        assert!(!rows[0].to_string().contains(&code));
    }
}

/// B4-2 (the door): it is read from the STORED payload only. The same card with its `via_ai` taken
/// out is the other door's — no message, a claim grant, no `secretOnce` — and a decision request
/// that sends `deliverSecretToAgent` cannot move a helper card to a claim.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i3_the_door_is_read_from_the_stored_payload_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    // The helper's door with the flag set: still the conversation, still no claim.
    let helper_card = h.raise_invite().await;
    let texts_before = h.helper_texts().await.len();
    let decided = h
        .decide_with(&h.owner_token, helper_card.approval_id, true, Some(false))
        .await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert_eq!(h.helper_texts().await.len(), texts_before + 1);
    assert!(h
        .approval_payload(helper_card.approval_id)
        .await
        .get("secretClaim")
        .is_none());

    // The same kind of card with no `via_ai` is the Agent Port's: one claim, no message.
    let other = h.raise_invite().await;
    sqlx::query("UPDATE approval SET payload = payload - 'via_ai' WHERE id = $1")
        .bind(other.approval_id)
        .execute(&su)
        .await
        .unwrap();
    let texts_before = h.helper_texts().await.len();
    let decided = h.decide(&h.owner_token, other.approval_id, true).await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert!(
        decided.body["result"]["secretOnce"].is_null(),
        "{}",
        decided.body
    );
    let payload = h.approval_payload(other.approval_id).await;
    assert_eq!(payload["secretClaim"]["kind"], "invite", "{payload}");
    assert_eq!(
        h.helper_texts().await.len(),
        texts_before,
        "the other door posts nothing"
    );
    let result: Value = sqlx::query_scalar(
        "SELECT props->'result' FROM message WHERE workspace_id = $1 AND id = $2",
    )
    .bind(h.workspace)
    .bind(other.card_message_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        result["rows"]
            .to_string()
            .contains("에이전트가 이 링크를 받아 전달해요"),
        "{result}"
    );
    // And the other door's audit rows carry no helper provenance (B4-7 is the helper's).
    let created = h.audit_rows("invite.created").await;
    assert_eq!(created.len(), 2);
    assert_eq!(
        created
            .iter()
            .filter(|row| row.get("via_ai").is_some())
            .count(),
        1
    );

    // An `agent.invite` of the other door still offers its box: the flag is honoured there.
    let pairing = h.raise_pairing().await;
    sqlx::query("UPDATE approval SET payload = payload - 'via_ai' WHERE id = $1")
        .bind(pairing.approval_id)
        .execute(&su)
        .await
        .unwrap();
    let decided = h
        .decide_with(&h.owner_token, pairing.approval_id, true, Some(true))
        .await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert!(decided.body["result"]["secretOnce"].is_null());
    assert_eq!(
        h.approval_payload(pairing.approval_id).await["secretClaim"]["kind"],
        "pairing"
    );
}

// --- who may ask and who may decide ----------------------------------------------------------------

/// B4-1 / B15-A4: a plain member cannot approve the helper's card (403, nothing minted, nothing
/// posted); and an approver who was an admin when the card was drawn and is not when he decides is
/// refused the same way (the re-proof at the decision).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i4_only_an_admin_decides_and_a_demoted_approver_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let card = h.raise_invite().await;
    let texts_before = h.helper_texts().await.len();
    let refused = h.decide(&h.member_token, card.approval_id, true).await;
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(refused.body["status"], "role_required");

    // Promote, then demote before deciding.
    sqlx::query(
        "UPDATE workspace_membership SET role = 'admin' WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(h.workspace)
    .bind(h.member)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("UPDATE workspace_membership SET role = 'member' WHERE workspace_id = $1 AND member_id = $2")
        .bind(h.workspace)
        .bind(h.member)
        .execute(&su)
        .await
        .unwrap();
    let demoted = h.decide(&h.member_token, card.approval_id, true).await;
    assert_eq!(demoted.status, 403, "{}", demoted.body);
    assert_eq!(demoted.body["status"], "role_required");
    assert_eq!(h.invites().await, 0, "nothing minted");
    assert_eq!(h.helper_texts().await.len(), texts_before, "nothing posted");
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    assert!(h.audit_rows("invite.created").await.is_empty());

    // The admin still can.
    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    assert_eq!(h.invites().await, 1);
}

/// B4-3 / B13-I4 at BOTH fences: the proposal of a request that read (a tool, or a web search) is
/// refused for each of the two invite ids; and a card that was drawn clean but whose stored
/// `via_ai` does not say it read nothing (or that read something) is refused at the decision —
/// 409, an `action.refused` row naming the reason, nothing minted, nothing posted.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i5_a_card_that_read_something_is_refused_at_the_decision_and_at_the_proposal() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    for (id, args) in [
        (INVITE, json!({"role": "member"})),
        (
            PAIRING,
            json!({"platform": "grok_bot", "displayName": "읽은 뒤", "handle": "afterread1"}),
        ),
    ] {
        for (tools, searches) in [(&["read_channel"][..], 0), (&[][..], 1)] {
            let refused = h.raise(h.owner, id, args.clone(), tools, searches).await;
            assert_eq!(
                refused,
                Err(ProposalRefusal::AfterRead),
                "{id} {tools:?} {searches}"
            );
        }
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(h.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(pending, 0, "a refused proposal draws no card");

    // A card drawn clean, then its stored provenance says the request read something.
    for tampered in [
        json!({"tools": ["read_channel"], "web_searches": 0}),
        json!({"tools": [], "web_searches": 2}),
    ] {
        let card = h.raise_invite().await;
        sqlx::query(
            "UPDATE approval SET payload = jsonb_set(jsonb_set(payload, '{via_ai,tools}', $2::jsonb), \
             '{via_ai,web_searches}', $3::jsonb) WHERE id = $1",
        )
        .bind(card.approval_id)
        .bind(&tampered["tools"])
        .bind(&tampered["web_searches"])
        .execute(&su)
        .await
        .unwrap();
        let texts_before = h.helper_texts().await.len();
        let decided = h.decide(&h.owner_token, card.approval_id, true).await;
        assert_eq!(decided.status, 409, "{tampered}: {}", decided.body);
        assert_eq!(decided.body["status"], "action_args_invalid");
        assert_eq!(h.approval_status(card.approval_id).await, "pending");
        assert_eq!(h.helper_texts().await.len(), texts_before);
    }
    // A card that says nothing about what it read is judged as one that read.
    let silent = h.raise_invite().await;
    sqlx::query("UPDATE approval SET payload = payload #- '{via_ai,tools}' WHERE id = $1")
        .bind(silent.approval_id)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        h.decide(&h.owner_token, silent.approval_id, true)
            .await
            .status,
        409
    );
    assert_eq!(h.invites().await, 0);
    let refused = h.audit_rows("action.refused").await;
    assert_eq!(refused.len(), 3, "{refused:?}");
    assert!(
        refused
            .iter()
            .all(|row| row["reason"] == "team_ai_read_context"),
        "{refused:?}"
    );
}

/// B13-I5: with `invite_access` off the helper cannot raise either card, and a card that was drawn
/// while it was on does not run once it is off.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i6_a_bundle_switched_off_stops_both_the_proposal_and_a_card_already_drawn() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let drawn = h.raise_invite().await;
    let (status, body) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"invite_access": false}}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        h.raise(h.owner, INVITE, json!({"role": "member"}), &[], 0)
            .await,
        Err(ProposalRefusal::RoleOff)
    );
    assert_eq!(
        h.raise(
            h.owner,
            PAIRING,
            json!({"platform": "grok_bot", "displayName": "꺼짐", "handle": "off1"}),
            &[],
            0
        )
        .await,
        Err(ProposalRefusal::RoleOff)
    );
    let texts_before = h.helper_texts().await.len();
    let decided = h.decide(&h.owner_token, drawn.approval_id, true).await;
    assert_eq!(decided.status, 409, "{}", decided.body);
    assert_eq!(h.invites().await, 0);
    assert_eq!(h.helper_texts().await.len(), texts_before);
    let refused = h.audit_rows("action.refused").await;
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0]["reason"], "team_ai_role_off");
    // Switched back on, the same card runs.
    let (status, _) = h
        .patch(
            &h.owner_token,
            json!({"team_ai_roles": {"invite_access": true}}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        h.decide(&h.owner_token, drawn.approval_id, true)
            .await
            .status,
        200
    );
    assert_eq!(h.invites().await, 1);
}

/// B4-1 / B15-A4: a requester who could not approve the card themselves gets no card — a plain member
/// for both ids — and the admin's own request is one.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i7_a_requester_who_cannot_approve_gets_no_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    assert_eq!(
        h.raise(h.member, INVITE, json!({"role": "member"}), &[], 0)
            .await,
        Err(ProposalRefusal::RequesterLacksRole)
    );
    assert_eq!(
        h.raise(
            h.member,
            PAIRING,
            json!({"platform": "grok_bot", "displayName": "못 만듦", "handle": "nope1"}),
            &[],
            0
        )
        .await,
        Err(ProposalRefusal::RequesterLacksRole)
    );
    let cards: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id = $1")
        .bind(h.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(cards, 0);
    assert!(h.raise(h.owner, INVITE, json!({}), &[], 0).await.is_ok());
}

// --- atomicity and tenancy ---------------------------------------------------------------------------

/// B4-2 「같은 tx」: when the message cannot be written the invite is not made. The channel's
/// sequence row is taken away, so the send spine fails AFTER the mint; the decision rolls back whole
/// — no invite row, no audit row, the approval still pending.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i8_a_failed_post_takes_the_invite_with_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let card = h.raise_invite().await;
    sqlx::query("DELETE FROM channel_seq WHERE channel_id = $1")
        .bind(h.channel)
        .execute(&su)
        .await
        .unwrap();
    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert!(
        decided.status >= 500,
        "{}: {}",
        decided.status,
        decided.body
    );
    assert_eq!(
        h.invites().await,
        0,
        "the invite was rolled back with the message"
    );
    assert!(h.audit_rows("invite.created").await.is_empty());
    assert!(h.audit_rows("action.approved").await.is_empty());
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
}

/// B4-2: a helper that has left the conversation cannot post the link, so the card is stale BEFORE
/// the mint (409, nothing made, the approval stays pending and can still be rejected).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i9_a_helper_that_left_the_conversation_makes_the_card_stale_before_any_mint() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let card = h.raise_invite().await;
    sqlx::query(
        "UPDATE membership SET left_at = now() WHERE workspace_id = $1 AND channel_id = $2 \
            AND member_id = $3",
    )
    .bind(h.workspace)
    .bind(h.channel)
    .bind(h.helper)
    .execute(&su)
    .await
    .unwrap();
    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(decided.status, 409, "{}", decided.body);
    assert_eq!(decided.body["status"], "action_args_invalid");
    assert_eq!(h.invites().await, 0);
    assert_eq!(h.approval_status(card.approval_id).await, "pending");
    // It can still be said no to.
    assert_eq!(
        h.decide(&h.owner_token, card.approval_id, false)
            .await
            .status,
        200
    );
}

/// Two tenants: another workspace's admin cannot decide this card (404, as a missing one), and the
/// approval in A leaves B with no invite and no link message.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i10_another_workspace_cannot_decide_or_receive_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let a = harness(None, &app, &su).await;
    let b = harness(Some(a.base.clone()), &app, &su).await;

    let card = a.raise_invite().await;
    let foreign = b.http
        .post(format!(
            "{}/v1/workspaces/{}/approvals/{}/decision",
            b.base, b.workspace, card.approval_id
        ))
        .bearer_auth(&b.owner_token)
        .json(&json!({"approvalId": card.approval_id, "approve": true, "clientDecisionId": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 404);
    assert_eq!(a.invites().await, 0);
    assert_eq!(
        a.decide(&a.owner_token, card.approval_id, true)
            .await
            .status,
        200
    );
    assert_eq!(a.invites().await, 1);
    assert_eq!(b.invites().await, 0, "B has no invite");
    let marked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND props->>'kind' = 'team_ai_invite_link'",
    )
    .bind(b.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(marked, 0);
}

// --- later model contexts ----------------------------------------------------------------------------

/// B13-I2: the link message is text in a channel, and a channel is what agents read. After it is
/// posted, the NEXT mention of the helper builds a job whose `recent_messages` holds the message
/// as a placeholder — the code is in no `agent_job` payload — while a person reading the channel
/// still sees the link.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i11_the_link_message_never_reaches_a_later_model_context() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let card = h.raise_invite().await;
    assert_eq!(
        h.decide(&h.owner_token, card.approval_id, true)
            .await
            .status,
        200
    );
    let (_, _, body, _) = h.helper_texts().await.last().cloned().unwrap();
    let code = code_of(&body);

    // A later mention of the helper (the REST path every person's message takes).
    h.post(&h.member_token, "@oort-helper 방금 올라온 거 설명해 줘")
        .await;
    let jobs: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job' \
          ORDER BY id DESC",
    )
    .bind(h.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    let job = jobs.first().expect("the mention made a job for the helper");
    let window = job["recent_messages"].to_string();
    assert!(
        window.contains("[초대 링크]"),
        "the window says a link was posted: {window}"
    );
    assert!(
        !window.contains(&code),
        "the window holds the code: {window}"
    );
    for payload in &jobs {
        assert!(
            !payload.to_string().contains(&code),
            "an agent_job holds the code"
        );
    }
    // A person reading the conversation still gets the link.
    let page: Value = h
        .http
        .get(format!(
            "{}/v1/workspaces/{}/channels/{}/messages?limit=50",
            h.base, h.workspace, h.channel
        ))
        .bearer_auth(&h.member_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        page.to_string().contains(&code),
        "people still see the link"
    );
}

// --- r1 review fixes (#4965): quiet line, forged marker, admin links, defaults ----------------------

/// r1 Medium-1: the link message pushes **nobody**. In a DM the push judgment makes every other
/// human a `Dm` candidate, and an app installed before the notification text became `props.preview`
/// prints the whole body — the link — on a lock screen. The server's answer is the quiet-line key
/// on that one message (`announce: true`, which the judgment reads first); this measures it with the
/// real judgment (`momo_notifier`) on the real message the real decision wrote. The control is the
/// same person in the same DM with an ordinary line by the same helper, who IS woken: without it
/// "nobody" could be a property of the fixture (no phone, no seat), not of the marker.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i12_the_link_message_in_a_dm_wakes_nobody_while_an_ordinary_line_wakes_the_admin() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let notifier = notifier_pool().await;
    let h = harness(None, &app, &su).await;

    let dm = seed_dm(&su, h.workspace, h.owner, &[h.owner, h.helper]).await;
    seed_device(&su, h.workspace, h.owner).await;

    // The control: an ordinary helper line in the DM wakes the admin, as a DM line.
    let (workspace, helper) = (h.workspace, h.helper);
    let ordinary = with_tenant_tx(&su, workspace, move |conn| {
        Box::pin(async move {
            let sent =
                send_message_in_tx(conn, workspace, NewMessage::text(dm, helper, "안녕하세요"))
                    .await?;
            Ok(sent.message.id)
        })
    })
    .await
    .expect("an ordinary helper line in the DM");
    assert_eq!(
        judged(&notifier, h.workspace, ordinary).await,
        vec![(h.owner, momo_push::PushReason::Dm)],
        "the control: the admin has a phone and a seat, so an ordinary line wakes them"
    );

    // The link: the real card in the DM, the real decision, the real message.
    let card = h
        .raise_in(
            dm,
            h.owner,
            INVITE,
            json!({"role": "member", "maxUses": 5, "expiresInDays": 7}),
            &[],
            0,
        )
        .await
        .expect("an admin's direct request in the DM is a card");
    let decided = h.decide(&h.owner_token, card.approval_id, true).await;
    assert_eq!(decided.status, 200, "{}", decided.body);
    let link = h
        .helper_texts_in(dm)
        .await
        .into_iter()
        .find(|(_, _, _, props)| props["kind"] == "team_ai_invite_link")
        .expect("the helper's link message is in the DM");
    let (link_id, _, body, props) = link;
    assert!(body.contains("/join?code="), "a real link: {body}");
    assert_eq!(props["announce"], json!(true), "{props}");
    assert_eq!(
        judged(&notifier, h.workspace, link_id).await,
        vec![],
        "the link message is a quiet line: no lock screen shows it ({props})"
    );
}

/// r1 Low-1: a person cannot write the helper's marker. The route strips `kind:
/// "team_ai_invite_link"` (and the quiet-line key that travels with it) from a member's props, so
/// what is stored does not read as a link message, and an agent's later context still carries the
/// member's words — the forged marker would have swapped them for `[초대 링크]` and kept them out of
/// the team memory.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i13_a_members_forged_link_marker_is_stripped_by_the_route() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let response = h
        .http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/messages",
            h.base, h.workspace, h.channel
        ))
        .bearer_auth(&h.member_token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": "내가 쓴 평범한 글이에요",
            "props": {
                "kind": "team_ai_invite_link",
                "preview": "초대 링크를 올렸어요",
                "announce": "true",
                "note": "kept"
            }
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(response.status(), 201, "{:?}", response.text().await);
    let stored: Value = sqlx::query_scalar(
        "SELECT props FROM message WHERE workspace_id = $1 AND channel_id = $2 \
           AND author_member_id = $3 ORDER BY seq DESC LIMIT 1",
    )
    .bind(h.workspace)
    .bind(h.channel)
    .bind(h.member)
    .fetch_one(&su)
    .await
    .expect("the member's message");
    assert!(
        !momo_messaging::invite_link::is_marked(&stored),
        "a member's line must not read as the helper's link message: {stored}"
    );
    assert!(stored.get("kind").is_none(), "{stored}");
    assert!(stored.get("announce").is_none(), "{stored}");
    assert_eq!(
        stored["note"],
        json!("kept"),
        "the route kept the ordinary key"
    );
    // What a model reads next: the member's own words, not the placeholder.
    assert_eq!(
        momo_messaging::context_message_body("text", Some("내가 쓴 평범한 글이에요"), &stored),
        "내가 쓴 평범한 글이에요"
    );
}

/// r1 Low-4 (planner default, the owner can flip it): the helper's door raises no **admin** invite
/// link — an admin link is made by a person on the screen. Both fences: the proposal says no (no
/// card, no pending approval), and a card that came in sideways with the role already `admin` is
/// refused at the decision (409 `action_args_invalid`, an `action.refused` row naming the reason,
/// nothing minted, nothing posted, the approval still pending). The controls are what must keep
/// working: a link for the default role (member) is a card and runs, and its invite is a member's;
/// `guest` stays refused as the shared schema had it (the Agent Port's schema did not move).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i14_the_helper_raises_no_admin_link_and_a_card_that_says_admin_is_refused_at_the_decision()
{
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    // The proposal: an admin link is refused even to the admin who asks.
    assert_eq!(
        h.raise(h.owner, INVITE, json!({"role": "admin"}), &[], 0)
            .await,
        Err(ProposalRefusal::InviteRoleNotOffered)
    );
    assert_eq!(
        h.raise(
            h.owner,
            INVITE,
            json!({"role": "admin", "maxUses": 1, "expiresInDays": 1}),
            &[],
            0
        )
        .await,
        Err(ProposalRefusal::InviteRoleNotOffered)
    );
    // The schema's own refusal still comes first for what it never allowed.
    assert_eq!(
        h.raise(h.owner, INVITE, json!({"role": "guest"}), &[], 0)
            .await,
        Err(ProposalRefusal::InvalidArguments)
    );
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval WHERE workspace_id = $1 AND status = 'pending'",
    )
    .bind(h.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(pending, 0, "a refused proposal draws no card");

    // The control: no role named is the member default, and that is a card.
    let control = h
        .raise(h.owner, INVITE, json!({}), &[], 0)
        .await
        .expect("the default role is a card");

    // The decision: a card drawn as member whose stored role now says admin (a way in other than
    // the proposal) is refused, and stays pending.
    let sideways = h.raise_invite().await;
    sqlx::query(
        "UPDATE approval SET payload = jsonb_set(payload, '{action,args,role}', '\"admin\"') \
          WHERE id = $1",
    )
    .bind(sideways.approval_id)
    .execute(&su)
    .await
    .unwrap();
    let texts_before = h.helper_texts().await.len();
    let decided = h.decide(&h.owner_token, sideways.approval_id, true).await;
    assert_eq!(decided.status, 409, "{}", decided.body);
    assert_eq!(decided.body["status"], "action_args_invalid");
    assert_eq!(h.approval_status(sideways.approval_id).await, "pending");
    assert_eq!(h.invites().await, 0, "nothing minted");
    assert_eq!(h.helper_texts().await.len(), texts_before, "nothing posted");
    let refused = h.audit_rows("action.refused").await;
    assert_eq!(refused.len(), 1, "{refused:?}");
    assert_eq!(refused[0]["reason"], "team_ai_invite_role");

    // The control runs, and mints a member's link.
    assert_eq!(
        h.decide(&h.owner_token, control.approval_id, true)
            .await
            .status,
        200
    );
    let roles: Vec<String> =
        sqlx::query_scalar("SELECT role::text FROM invite_code WHERE workspace_id = $1")
            .bind(h.workspace)
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(roles, vec!["member".to_string()]);
}

/// r1 Low-7 (planner default; owner 「기본값을 짧게」, the owner can flip it): a link the helper
/// makes without numbers is **1 use for 1 day**. The default is written into the card — the rows the
/// approver reads, the stored arguments and the invite row all say the same numbers — and a number
/// the model did name is never changed (the controls: 5 uses and 7 days stay 5 and 7).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn i15_a_link_the_helper_makes_without_numbers_is_one_use_for_one_day() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let h = harness(None, &app, &su).await;

    let omitted = h
        .raise(h.owner, INVITE, json!({"role": "member"}), &[], 0)
        .await
        .expect("a card");
    let args = h.approval_payload(omitted.approval_id).await["action"]["args"].clone();
    assert_eq!(args["maxUses"], json!(1), "{args}");
    assert_eq!(args["expiresInDays"], json!(1), "{args}");
    let card_props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(omitted.card_message_id)
        .fetch_one(&su)
        .await
        .unwrap();
    let rows = card_props["action"]["rows"].to_string();
    assert!(rows.contains("1회"), "the card shows one use: {rows}");
    assert!(rows.contains("1일"), "the card shows one day: {rows}");
    assert!(
        !rows.contains("7일"),
        "the card does not show a week: {rows}"
    );

    let named = h.raise_invite().await; // {"role":"member","maxUses":5,"expiresInDays":7}
    assert_eq!(
        h.decide(&h.owner_token, omitted.approval_id, true)
            .await
            .status,
        200
    );
    assert_eq!(
        h.decide(&h.owner_token, named.approval_id, true)
            .await
            .status,
        200
    );
    // Each invite's own numbers: (max_uses, seconds from creation to expiry), oldest first.
    let made: Vec<(i32, f64)> = sqlx::query_as(
        "SELECT max_uses, extract(epoch FROM (expires_at - created_at))::float8 \
           FROM invite_code WHERE workspace_id = $1 ORDER BY created_at",
    )
    .bind(h.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(made.len(), 2, "{made:?}");
    let (uses, seconds) = made[0];
    assert_eq!(uses, 1, "{made:?}");
    assert!(
        (seconds - 86_400.0).abs() < 120.0,
        "the default expiry is 24 hours: {seconds}s"
    );
    let (uses, seconds) = made[1];
    assert_eq!(uses, 5, "{made:?}");
    assert!(
        (seconds - 7.0 * 86_400.0).abs() < 120.0,
        "a named expiry is kept: {seconds}s"
    );
}
