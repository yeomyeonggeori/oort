//! #4234 / ADR-0208 D10 증보 — the per-member write budget on the **real routes**, against real
//! Postgres.
//!
//! `member_write_rate_limit_edge.rs` proves the middleware's mechanics without a database. This
//! file proves what needs one: that `build_app` mounts it on exactly the routes the ADR names (and
//! not on the ones it must not touch), that a refusal leaves exactly one well-formed
//! `rate_limit.exceeded` audit row, and that the **shipped defaults** let ordinary use through.
//! Everything goes through the same seams production uses: REST on an ephemeral port as
//! `momo_app` (NOBYPASSRLS), real logins for people, a real `agent_bearer` token row for the agent,
//! fixtures and reads as the superuser.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `a_human_is_refused_after_the_send_budget_and_nothing_is_stored` | N sends pass, the N+1st is 429 + `Retry-After` + the standard envelope, the refused message is not in the table, reads are untouched | `route_layer(member_write(MessageSend))` removed from `POST …/messages`; the `Retry-After` header dropped |
//! | `a_refusal_is_answered_before_the_body_is_read` | the gate runs ahead of the JSON extractor: a refused request with a malformed body is a 429, not a 4xx parse error | the check moved into the handler (after the extractors) |
//! | `an_agent_has_its_own_send_budget` | the limit follows `Principal::kind` on the real route (a real `agent_bearer`) | the kind branch removed |
//! | `a_burst_leaves_one_audit_row_of_the_documented_shape` | one `rate_limit.exceeded` row per burst with exactly the documented detail, attributed to the member and the credential, inside the member's workspace | the audit write removed; `should_log` ignored (a row per refusal); the detail gains a field |
//! | `a_flood_of_parallel_refusals_writes_one_audit_row` | forty refusals at the same instant are one writer, not forty: only the first denial of a burst owns the marker | the marker ignored (`verdict.log_reservation` not consulted) |
//! | `budgets_are_per_member_and_per_surface` | spending one member's / one surface's budget refuses nobody else | the key loses the member id or the surface prefix |
//! | `a_schedule_create_and_edit_spend_the_schedule_budget_and_cancel_never_does` | create + edit are budgeted, cancel and list are not, and a spent schedule budget does not touch sending | `DELETE` gets the layer (the layer attached after the second verb); `update` loses its layer |
//! | `send_now_spends_the_send_budget` | the canonical send has one budget however it is reached | `send-now` mounted with `ScheduledWrite`, or not at all |
//! | `upload_starts_are_refused_before_the_drive_is_called` | a refused start costs no Drive session and no `pending` row | the gate moved after `create_resumable_upload` |
//! | `streaming_edits_and_reads_are_outside_the_budget` | `PATCH …/messages/{id}` (the stream slices) and history are never budgeted | the layer attached to the whole message path |
//! | `zero_turns_each_axis_off_and_no_row_is_written` | the operator's off switch, per axis | the `limit == 0` early return removed |
//! | `the_shipped_defaults_pass_ordinary_use_and_stop_at_the_documented_numbers` | **the measurement**: 100 human sends and 300 tool_call/tool_result sends from one agent all pass at the defaults; the 121st / 601st in a window is the first refusal | a default changed |
//!
//! `#[ignore]` — needs a real PG18 superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:24234/momo \
//!   PGHOST=127.0.0.1 PGPORT=24234 PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test member_write_rate_limit_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Assertion messages never interpolate a body or a token. Fixture people are made up
//! (달무리 스튜디오); nothing here is a real person's name, address or sentence.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "member-write-rate-limit-signing-secret";
const TEST_PASSWORD: &str = "member-write-rate-limit-password";
const WORKSPACE_NAME: &str = "달무리 스튜디오";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(10)
        .connect_with(options.username("momo_app").password(&password))
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
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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

/// A Drive that counts the sessions it was asked to open and refuses everything else: the
/// upload tests need to know whether the Drive API was **called**, not whether a row exists.
#[derive(Debug, Default)]
struct CountingDrive {
    sessions: AtomicUsize,
}

#[async_trait]
impl DriveArchive for CountingDrive {
    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        _name: &str,
        _mime: &str,
        _size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        let n = self.sessions.fetch_add(1, Ordering::SeqCst);
        Ok(DriveUploadSession {
            drive_file_id: format!("counted-{n}-{}", Uuid::new_v4().simple()),
            upload_url: "https://drive.invalid/resumable/counted".to_string(),
        })
    }

    async fn file_metadata(&self, _file_id: &str) -> Result<DriveFile, DriveError> {
        Err(DriveError::Unavailable)
    }

    async fn file_content(
        &self,
        _file_id: &str,
        _max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        Err(DriveError::Unavailable)
    }
}

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Human {
    id: Uuid,
    email: String,
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(format!("mwrl-{workspace}"))
        .bind(WORKSPACE_NAME)
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str, role: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@mwrl.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(format!("{handle}-{}", &id.simple().to_string()[..6]))
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
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
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .bind(format!("{handle}-{}", agent.simple()))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES ($1, $2, 'prime-agent', 'https://gateway.invalid/v1', $3, '{}'::jsonb)",
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
    sqlx::query(
        "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused) \
         VALUES ($1, $2, $3, false)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent profile");
    agent
}

/// A generic agent bearer, the credential an adapter holds. Returns the raw credential and the
/// `token.id` an audit row's `via_token_id` must name.
async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> (String, Uuid) {
    let raw = format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write','messages:read'], 'mwrl') \
         RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&raw)
    .fetch_one(su)
    .await
    .expect("seed agent bearer");
    (raw, id)
}

async fn seed_channel(su: &PgPool, workspace: Uuid, created_by: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(created_by)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
    }
    channel
}

struct Fixture {
    workspace: Uuid,
    /// Two ordinary members of one channel (이도현·박서연: made up).
    dohyun: Human,
    seoyeon: Human,
    channel: Uuid,
}

async fn fixture(su: &PgPool) -> Fixture {
    let workspace = seed_workspace(su).await;
    let owner = seed_human(su, workspace, "owner", "owner").await;
    let dohyun = seed_human(su, workspace, "dohyun", "member").await;
    let seoyeon = seed_human(su, workspace, "seoyeon", "member").await;
    let channel = seed_channel(su, workspace, owner.id, &[owner.id, dohyun.id, seoyeon.id]).await;
    Fixture {
        workspace,
        dohyun,
        seoyeon,
        channel,
    }
}

// ---------------------------------------------------------------------------
// the rig
// ---------------------------------------------------------------------------

struct Rig {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    drive: Arc<CountingDrive>,
}

/// What a request answered with, minus anything that could carry a token.
struct Reply {
    status: u16,
    retry_after: Option<String>,
    body: Value,
}

impl Rig {
    async fn new(config: RateLimitConfig) -> Rig {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let drive = Arc::new(CountingDrive::default());
        let state = AppState::new(
            app,
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_rate_limit(config)
        .with_drive(drive.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind momo-server");
        let address: SocketAddr = listener.local_addr().expect("server address");
        let served = build_app(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, served).await;
        });
        Rig {
            su,
            base: format!("http://{address}"),
            http: reqwest::Client::new(),
            drive,
        }
    }

    fn url(&self, workspace: Uuid, path: &str) -> String {
        format!("{}/v1/workspaces/{workspace}{path}", self.base)
    }

    async fn login(&self, workspace: Uuid, human: &Human) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": human.email,
                "password": TEST_PASSWORD,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status().as_u16(), 200, "a seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        body["accessToken"].as_str().expect("access").to_string()
    }

    async fn call(
        &self,
        method: reqwest::Method,
        url: String,
        token: &str,
        body: Option<Value>,
    ) -> Reply {
        let mut request = self.http.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.unwrap_or_default();
        Reply {
            status,
            retry_after,
            body: serde_json::from_str(&text).unwrap_or(Value::Null),
        }
    }

    async fn send(&self, token: &str, workspace: Uuid, channel: Uuid, body: &str) -> Reply {
        self.send_typed(token, workspace, channel, "text", body)
            .await
    }

    async fn send_typed(
        &self,
        token: &str,
        workspace: Uuid,
        channel: Uuid,
        message_type: &str,
        body: &str,
    ) -> Reply {
        self.call(
            reqwest::Method::POST,
            self.url(workspace, &format!("/channels/{channel}/messages")),
            token,
            Some(json!({
                "clientMsgId": Uuid::new_v4(),
                "type": message_type,
                "body": body,
            })),
        )
        .await
    }

    async fn history(&self, token: &str, workspace: Uuid, channel: Uuid) -> Reply {
        self.call(
            reqwest::Method::GET,
            self.url(workspace, &format!("/channels/{channel}/messages")),
            token,
            None,
        )
        .await
    }

    async fn schedule(&self, token: &str, workspace: Uuid, channel: Uuid, text: &str) -> Reply {
        self.call(
            reqwest::Method::POST,
            self.url(
                workspace,
                &format!("/channels/{channel}/scheduled-messages"),
            ),
            token,
            Some(json!({
                "body": text,
                "sendAtMs": chrono::Utc::now().timestamp_millis() + 3_600_000,
                "clientRequestId": Uuid::new_v4(),
            })),
        )
        .await
    }

    async fn upload_start(&self, token: &str, workspace: Uuid, channel: Uuid) -> Reply {
        self.call(
            reqwest::Method::POST,
            self.url(
                workspace,
                &format!("/channels/{channel}/attachments/uploads"),
            ),
            token,
            Some(json!({"name": "회의록.txt", "mime": "text/plain", "size": 12})),
        )
        .await
    }

    async fn audit_rows(&self, workspace: Uuid, member: Uuid) -> Vec<Value> {
        sqlx::query_scalar::<_, Value>(
            "SELECT jsonb_build_object(\
                'target_type', target_type, 'via_token_id', via_token_id, \
                'subject', subject_member_id, 'detail', detail) \
               FROM audit_log \
              WHERE workspace_id = $1 AND actor_member_id = $2 \
                AND action = 'rate_limit.exceeded' ORDER BY created_at",
        )
        .bind(workspace)
        .bind(member)
        .fetch_all(&self.su)
        .await
        .expect("read audit rows")
    }

    async fn stored_messages(&self, author: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM message WHERE author_member_id = $1")
            .bind(author)
            .fetch_one(&self.su)
            .await
            .expect("count messages")
    }
}

fn limits(send: u32, agent: u32, schedule: u32, upload: u32) -> RateLimitConfig {
    RateLimitConfig {
        message_send_per_member_limit: send,
        message_send_per_agent_limit: agent,
        scheduled_write_per_member_limit: schedule,
        upload_start_per_member_limit: upload,
        ..RateLimitConfig::default()
    }
}

fn assert_refused(reply: &Reply, what: &str) {
    assert_eq!(reply.status, 429, "{what}: the budget is spent");
    let retry_after: u64 = reply
        .retry_after
        .as_deref()
        .unwrap_or_else(|| panic!("{what}: a 429 carries Retry-After"))
        .parse()
        .unwrap_or_else(|_| panic!("{what}: Retry-After is whole seconds"));
    assert!(
        (1..=60).contains(&retry_after),
        "{what}: Retry-After {retry_after} is within 1..=60"
    );
    assert_eq!(
        reply.body,
        json!({"error": {"message": "rate limit exceeded"}}),
        "{what}: the standard envelope, the same as every other limiter here"
    );
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_human_is_refused_after_the_send_budget_and_nothing_is_stored() {
    let rig = Rig::new(limits(5, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    for index in 0..5 {
        let reply = rig
            .send(
                &token,
                fx.workspace,
                fx.channel,
                &format!("회의 자료 {index}"),
            )
            .await;
        assert_eq!(reply.status, 201, "send {index} is inside the budget");
    }
    let refused = rig
        .send(&token, fx.workspace, fx.channel, "여섯 번째 메시지")
        .await;
    assert_refused(&refused, "the 6th send");
    assert_refused(
        &rig.send(&token, fx.workspace, fx.channel, "일곱 번째 메시지")
            .await,
        "the 7th send",
    );
    assert_eq!(
        rig.stored_messages(fx.dohyun.id).await,
        5,
        "a refused send is not stored: the gate is ahead of the transaction"
    );
    assert_eq!(
        rig.history(&token, fx.workspace, fx.channel).await.status,
        200,
        "reading is not budgeted"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refusal_is_answered_before_the_body_is_read() {
    let rig = Rig::new(limits(1, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;
    let url = rig.url(fx.workspace, &format!("/channels/{}/messages", fx.channel));
    let malformed = |http: &reqwest::Client, token: &str, url: &str| {
        http.post(url.to_string())
            .bearer_auth(token.to_string())
            .header("content-type", "application/json")
            .body("{ this is not json")
            .send()
    };

    // Inside the budget a malformed body is the extractor's 4xx — the control that makes the
    // second half mean something: this route *does* parse the body when it gets that far.
    let parsed = malformed(&rig.http, &token, &url).await.expect("request");
    assert!(
        parsed.status().is_client_error() && parsed.status().as_u16() != 429,
        "the control: an admitted malformed body is a parse error, not a 429 (got {})",
        parsed.status()
    );
    // That request spent the one send in the budget, so now the same bytes meet the gate first.
    let gated = malformed(&rig.http, &token, &url).await.expect("request");
    assert_eq!(
        gated.status().as_u16(),
        429,
        "a refused request is not parsed: the gate is ahead of the extractors"
    );
    assert!(gated.headers().contains_key("retry-after"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_has_its_own_send_budget() {
    let rig = Rig::new(limits(2, 6, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let agent = seed_agent(&rig.su, fx.workspace, fx.dohyun.id, "prime").await;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(agent)
    .execute(&rig.su)
    .await
    .expect("agent joins the channel");
    let (bearer, _) = agent_bearer(&rig.su, fx.workspace, agent).await;
    let human = rig.login(fx.workspace, &fx.dohyun).await;

    for index in 0..6 {
        let reply = rig
            .send_typed(
                &bearer,
                fx.workspace,
                fx.channel,
                if index % 2 == 0 {
                    "tool_call"
                } else {
                    "tool_result"
                },
                &format!("도구 실행 {index}"),
            )
            .await;
        assert_eq!(
            reply.status, 201,
            "agent send {index} is inside its budget of 6"
        );
    }
    assert_refused(
        &rig.send_typed(
            &bearer,
            fx.workspace,
            fx.channel,
            "tool_result",
            "일곱 번째",
        )
        .await,
        "the agent's 7th send",
    );
    for index in 0..2 {
        assert_eq!(
            rig.send(&human, fx.workspace, fx.channel, &format!("확인 {index}"))
                .await
                .status,
            201
        );
    }
    assert_refused(
        &rig.send(&human, fx.workspace, fx.channel, "세 번째").await,
        "the human's 3rd send (budget 2, not the agent's 6)",
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_burst_leaves_one_audit_row_of_the_documented_shape() {
    let rig = Rig::new(limits(3, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    for index in 0..3 {
        assert_eq!(
            rig.send(&token, fx.workspace, fx.channel, &format!("정상 {index}"))
                .await
                .status,
            201
        );
    }
    for index in 0..10 {
        assert_eq!(
            rig.send(&token, fx.workspace, fx.channel, &format!("초과 {index}"))
                .await
                .status,
            429,
            "refusal {index}"
        );
    }
    let rows = rig.audit_rows(fx.workspace, fx.dohyun.id).await;
    assert_eq!(
        rows.len(),
        1,
        "ten refusals in one burst are one audit row, not ten"
    );
    let row = &rows[0];
    assert_eq!(row["target_type"], "route");
    assert_eq!(
        row["subject"],
        json!(fx.dohyun.id),
        "attributed to the member, as actor and subject"
    );
    assert!(
        row["via_token_id"].is_string(),
        "…and to the credential that made the request"
    );
    assert_eq!(
        row["detail"],
        json!({
            "schema": "oort.rate_limit.exceeded.v1",
            "scope": "member",
            "surface": "message_send",
            "kind": "human",
            "limit": 3,
            "window_seconds": 60,
        }),
        "exactly the documented fields: no path, no body, no ids from the request"
    );
    // The row lives in the member's own workspace and nowhere else.
    let elsewhere: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE action = 'rate_limit.exceeded' AND workspace_id <> $1 AND actor_member_id = $2",
    )
    .bind(fx.workspace)
    .bind(fx.dohyun.id)
    .fetch_one(&rig.su)
    .await
    .expect("count");
    assert_eq!(elsewhere, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_flood_of_parallel_refusals_writes_one_audit_row() {
    let rig = Rig::new(limits(2, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;
    for index in 0..2 {
        assert_eq!(
            rig.send(&token, fx.workspace, fx.channel, &format!("정상 {index}"))
                .await
                .status,
            201
        );
    }

    // Forty refused requests in flight at once: none of them has seen another's audit row commit.
    let bodies: Vec<String> = (0..40).map(|index| format!("동시 {index}")).collect();
    let flood = futures::future::join_all(
        bodies
            .iter()
            .map(|body| rig.send(&token, fx.workspace, fx.channel, body)),
    )
    .await;
    assert!(
        flood.iter().all(|reply| reply.status == 429),
        "every one of the forty is refused"
    );
    assert_eq!(
        rig.audit_rows(fx.workspace, fx.dohyun.id).await.len(),
        1,
        "the burst's marker belongs to one request, so forty parallel refusals are one database write"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn budgets_are_per_member_and_per_surface() {
    let rig = Rig::new(limits(2, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let dohyun = rig.login(fx.workspace, &fx.dohyun).await;
    let seoyeon = rig.login(fx.workspace, &fx.seoyeon).await;

    for index in 0..2 {
        assert_eq!(
            rig.send(&dohyun, fx.workspace, fx.channel, &format!("도현 {index}"))
                .await
                .status,
            201
        );
    }
    assert_eq!(
        rig.send(&dohyun, fx.workspace, fx.channel, "도현 초과")
            .await
            .status,
        429
    );
    assert_eq!(
        rig.send(&seoyeon, fx.workspace, fx.channel, "서연")
            .await
            .status,
        201,
        "another member's budget is untouched"
    );
    assert_eq!(
        rig.schedule(&dohyun, fx.workspace, fx.channel, "예약")
            .await
            .status,
        201,
        "a spent send budget does not touch the schedule surface"
    );
    assert_eq!(
        rig.upload_start(&dohyun, fx.workspace, fx.channel)
            .await
            .status,
        201,
        "…nor the upload surface"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_schedule_create_and_edit_spend_the_schedule_budget_and_cancel_never_does() {
    let rig = Rig::new(limits(50, 50, 3, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    let first = rig
        .schedule(&token, fx.workspace, fx.channel, "첫 예약")
        .await;
    assert_eq!(first.status, 201);
    let second = rig
        .schedule(&token, fx.workspace, fx.channel, "둘째 예약")
        .await;
    assert_eq!(second.status, 201);
    let first_id = first.body["scheduledMessage"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let second_id = second.body["scheduledMessage"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let edit = rig
        .call(
            reqwest::Method::PATCH,
            rig.url(fx.workspace, &format!("/scheduled-messages/{first_id}")),
            &token,
            Some(json!({"body": "고친 예약"})),
        )
        .await;
    assert_eq!(
        edit.status, 200,
        "the edit is the 3rd write in the budget of 3"
    );

    // The budget is spent: both verbs of the write are refused …
    assert_refused(
        &rig.schedule(&token, fx.workspace, fx.channel, "넷째 예약")
            .await,
        "a 4th create",
    );
    assert_refused(
        &rig.call(
            reqwest::Method::PATCH,
            rig.url(fx.workspace, &format!("/scheduled-messages/{first_id}")),
            &token,
            Some(json!({"body": "또 고침"})),
        )
        .await,
        "a 4th write, an edit",
    );
    // … and the things that are not writes of this kind are not.
    let list = rig
        .call(
            reqwest::Method::GET,
            rig.url(fx.workspace, "/scheduled-messages"),
            &token,
            None,
        )
        .await;
    assert_eq!(list.status, 200, "listing is not budgeted");
    for id in [&first_id, &second_id] {
        let cancelled = rig
            .call(
                reqwest::Method::DELETE,
                rig.url(fx.workspace, &format!("/scheduled-messages/{id}")),
                &token,
                None,
            )
            .await;
        assert!(
            cancelled.status == 200 || cancelled.status == 204,
            "cancelling is the safety action and is never budgeted (got {})",
            cancelled.status
        );
    }
    assert_eq!(
        rig.send(&token, fx.workspace, fx.channel, "예약과 별개로 보내기")
            .await
            .status,
        201,
        "a spent schedule budget does not touch sending"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn send_now_spends_the_send_budget() {
    let rig = Rig::new(limits(2, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;
    let ids: Vec<String> = {
        let mut ids = Vec::new();
        for index in 0..3 {
            let created = rig
                .schedule(&token, fx.workspace, fx.channel, &format!("예약 {index}"))
                .await;
            assert_eq!(created.status, 201);
            ids.push(
                created.body["scheduledMessage"]["id"]
                    .as_str()
                    .expect("id")
                    .to_string(),
            );
        }
        ids
    };
    let send_now = |id: String| {
        let (rig, token, workspace) = (&rig, token.clone(), fx.workspace);
        async move {
            rig.call(
                reqwest::Method::POST,
                rig.url(workspace, &format!("/scheduled-messages/{id}/send-now")),
                &token,
                None,
            )
            .await
        }
    };

    assert_eq!(
        rig.send(&token, fx.workspace, fx.channel, "직접 보냄")
            .await
            .status,
        201
    );
    assert_eq!(
        send_now(ids[0].clone()).await.status,
        200,
        "the 2nd send of the budget, reached through send-now"
    );
    assert_refused(
        &send_now(ids[1].clone()).await,
        "a send-now past the budget",
    );
    assert_refused(
        &rig.send(&token, fx.workspace, fx.channel, "또 직접 보냄")
            .await,
        "a REST send after send-now spent the shared budget",
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn upload_starts_are_refused_before_the_drive_is_called() {
    let rig = Rig::new(limits(50, 50, 50, 3)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    for index in 0..3 {
        assert_eq!(
            rig.upload_start(&token, fx.workspace, fx.channel)
                .await
                .status,
            201,
            "start {index} is inside the budget"
        );
    }
    for index in 0..4 {
        assert_refused(
            &rig.upload_start(&token, fx.workspace, fx.channel).await,
            &format!("refused start {index}"),
        );
    }
    assert_eq!(
        rig.drive.sessions.load(Ordering::SeqCst),
        3,
        "the Drive API was called for the three admitted starts and for none of the refused ones"
    );
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attachment WHERE uploader_member_id = $1 AND status = 'pending'",
    )
    .bind(fx.dohyun.id)
    .fetch_one(&rig.su)
    .await
    .expect("count pending attachments");
    assert_eq!(pending, 3, "…and a refused start leaves no pending row");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn streaming_edits_and_reads_are_outside_the_budget() {
    let rig = Rig::new(limits(1, 50, 50, 50)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    let sent = rig.send(&token, fx.workspace, fx.channel, "처음 글").await;
    assert_eq!(sent.status, 201);
    assert_eq!(
        rig.send(&token, fx.workspace, fx.channel, "두 번째 글")
            .await
            .status,
        429,
        "the send budget of 1 is spent"
    );
    let id = sent.body["id"].as_str().expect("message id").to_string();
    for revision in 0..15 {
        let edited = rig
            .call(
                reqwest::Method::PATCH,
                rig.url(fx.workspace, &format!("/messages/{id}")),
                &token,
                Some(json!({"body": format!("고친 글 {revision}")})),
            )
            .await;
        assert_eq!(
            edited.status, 200,
            "edit {revision}: PATCH …/messages/{{id}} is the stream-slice path and is never budgeted"
        );
    }
    for _ in 0..5 {
        assert_eq!(
            rig.history(&token, fx.workspace, fx.channel).await.status,
            200
        );
    }
}

/// The gate sits inside `require_principal`: whatever the auth layer refuses is its 401 or 403,
/// however often it is asked, and it costs no budget and leaves no audit row. Only a caller
/// the server can name is ever counted — which is also why the key can never be anything the
/// request chose.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn what_the_auth_layer_refuses_is_never_a_429_and_spends_no_budget() {
    let rig = Rig::new(limits(2, 2, 2, 2)).await;
    let fx = fixture(&rig.su).await;
    let agent = seed_agent(&rig.su, fx.workspace, fx.dohyun.id, "prime").await;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(agent)
    .execute(&rig.su)
    .await
    .expect("agent joins the channel");
    let (bearer, _) = agent_bearer(&rig.su, fx.workspace, agent).await;
    let human = rig.login(fx.workspace, &fx.dohyun).await;

    // The five budgeted endpoints. The ids in the paths need not exist: the auth layer answers
    // before any handler looks at them.
    let ghost = Uuid::new_v4();
    let channel = fx.channel;
    let message = json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": "x"});
    let schedule = json!({
        "body": "x",
        "sendAtMs": chrono::Utc::now().timestamp_millis() + 3_600_000,
        "clientRequestId": Uuid::new_v4(),
    });
    let routes: Vec<(&str, reqwest::Method, String, Value)> = vec![
        (
            "send",
            reqwest::Method::POST,
            rig.url(fx.workspace, &format!("/channels/{channel}/messages")),
            message,
        ),
        (
            "upload start",
            reqwest::Method::POST,
            rig.url(
                fx.workspace,
                &format!("/channels/{channel}/attachments/uploads"),
            ),
            json!({"name": "x.txt", "mime": "text/plain", "size": 1}),
        ),
        (
            "schedule create",
            reqwest::Method::POST,
            rig.url(
                fx.workspace,
                &format!("/channels/{channel}/scheduled-messages"),
            ),
            schedule,
        ),
        (
            "schedule edit",
            reqwest::Method::PATCH,
            rig.url(fx.workspace, &format!("/scheduled-messages/{ghost}")),
            json!({"body": "y"}),
        ),
        (
            "send-now",
            reqwest::Method::POST,
            rig.url(
                fx.workspace,
                &format!("/scheduled-messages/{ghost}/send-now"),
            ),
            json!({}),
        ),
    ];

    // Four rounds against budgets of two: if any of these were counted, round three would
    // already be a 429.
    for round in 0..4 {
        for (name, method, url, body) in &routes {
            let anonymous = rig
                .http
                .request(method.clone(), url.clone())
                .json(body)
                .send()
                .await
                .expect("request");
            assert_eq!(
                anonymous.status().as_u16(),
                401,
                "{name}, round {round}: no credential at all is the auth layer's 401"
            );
            let not_a_token = rig
                .call(
                    method.clone(),
                    url.clone(),
                    "not.a.token",
                    Some(body.clone()),
                )
                .await;
            assert_eq!(
                not_a_token.status, 401,
                "{name}, round {round}: a bearer that is not a token is a 401"
            );
            if *name != "send" {
                let agent_reply = rig
                    .call(method.clone(), url.clone(), &bearer, Some(body.clone()))
                    .await;
                assert_eq!(
                    agent_reply.status, 403,
                    "{name}, round {round}: an agent bearer off its allow-list is the auth \
                     layer's 403, not a budget refusal"
                );
            }
        }
    }

    // Nothing above was counted or recorded: both credentials still have their whole budget.
    for index in 0..2 {
        assert_eq!(
            rig.send(&human, fx.workspace, fx.channel, &format!("확인 {index}"))
                .await
                .status,
            201,
            "the person's send {index} is inside a budget that was never touched"
        );
    }
    assert_refused(
        &rig.send(&human, fx.workspace, fx.channel, "세 번째").await,
        "the person's 3rd send: the budget of 2 is exact, so nothing above was counted",
    );
    for index in 0..2 {
        assert_eq!(
            rig.send_typed(&bearer, fx.workspace, fx.channel, "tool_call", "도구")
                .await
                .status,
            201,
            "the agent's send {index} is inside a budget that was never touched"
        );
    }
    assert_refused(
        &rig.send_typed(&bearer, fx.workspace, fx.channel, "tool_call", "도구")
            .await,
        "the agent's 3rd send",
    );
    assert!(
        rig.audit_rows(fx.workspace, agent).await.len() <= 1,
        "the agent's one audit row is for its own spent send budget, not for the 403s"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn zero_turns_each_axis_off_and_no_row_is_written() {
    let rig = Rig::new(limits(0, 0, 0, 0)).await;
    let fx = fixture(&rig.su).await;
    let token = rig.login(fx.workspace, &fx.dohyun).await;

    for index in 0..30 {
        assert_eq!(
            rig.send(
                &token,
                fx.workspace,
                fx.channel,
                &format!("제한 없음 {index}")
            )
            .await
            .status,
            201
        );
    }
    for _ in 0..10 {
        assert_eq!(
            rig.schedule(&token, fx.workspace, fx.channel, "예약")
                .await
                .status,
            201
        );
        assert_eq!(
            rig.upload_start(&token, fx.workspace, fx.channel)
                .await
                .status,
            201
        );
    }
    assert!(rig.audit_rows(fx.workspace, fx.dohyun.id).await.is_empty());
}

/// **The measurement** (acceptance 2): at the shipped defaults, ordinary use is never refused and
/// the documented numbers are where the first refusal is.
///
/// * a person sending 100 messages back to back (a client flushing its queue after a reconnect)
///   is 100 × 201 — the human budget is 120;
/// * one agent identity posting 150 tool executions as one `tool_call` and one `tool_result`
///   each (the Prime adapter's pattern; 300 sends at line rate, which no model-paced run
///   reaches) is 300 × 201 — the agent budget is 600;
/// * the 121st human send and the 601st agent send inside one window are the first 429s.
///
/// The window is widened to an hour so a slow machine cannot let the first requests age out
/// before the last one arrives; the numbers under test are the defaults' *limits*.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_shipped_defaults_pass_ordinary_use_and_stop_at_the_documented_numbers() {
    // The numbers the docs quote (ADR-0208 증보 1, openapi `RateLimited`, `.env.example`) are
    // pinned here **by value**. Reading them back from the config would make the boundary below
    // follow whatever the default is, and a changed default would pass (sabotage E22).
    const DOCUMENTED_HUMAN: u32 = 120;
    const DOCUMENTED_AGENT: u32 = 600;
    let defaults = RateLimitConfig::default();
    assert_eq!(defaults.message_send_per_member_limit, DOCUMENTED_HUMAN);
    assert_eq!(defaults.message_send_per_agent_limit, DOCUMENTED_AGENT);
    let rig = Rig::new(RateLimitConfig {
        window_seconds: 3600,
        ..defaults
    })
    .await;
    let fx = fixture(&rig.su).await;
    let agent = seed_agent(&rig.su, fx.workspace, fx.dohyun.id, "prime").await;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(agent)
    .execute(&rig.su)
    .await
    .expect("agent joins the channel");
    let (bearer, _) = agent_bearer(&rig.su, fx.workspace, agent).await;
    let human = rig.login(fx.workspace, &fx.dohyun).await;

    // ordinary human use: 100 back to back
    let started = Instant::now();
    for index in 0..100 {
        let reply = rig
            .send(
                &human,
                fx.workspace,
                fx.channel,
                &format!("밀린 메시지 {index}"),
            )
            .await;
        assert_eq!(
            reply.status, 201,
            "human send {index} of 100 at the defaults"
        );
    }
    let human_secs = started.elapsed().as_secs_f64();

    // a bulk tool-result run: 150 tool executions = 300 sends from one agent identity
    let started = Instant::now();
    for index in 0..150 {
        for (message_type, label) in [("tool_call", "호출"), ("tool_result", "결과")] {
            let reply = rig
                .send_typed(
                    &bearer,
                    fx.workspace,
                    fx.channel,
                    message_type,
                    &format!("도구 {index} {label}"),
                )
                .await;
            assert_eq!(
                reply.status, 201,
                "agent {message_type} {index} of 150 pairs at the defaults"
            );
        }
    }
    let agent_secs = started.elapsed().as_secs_f64();
    println!(
        "MEASURED at defaults (human {}/window, agent {}/window): \
         100 human sends in {human_secs:.2}s ({:.0}/s), \
         300 agent tool_call+tool_result sends in {agent_secs:.2}s ({:.0}/s), zero refusals",
        defaults.message_send_per_member_limit,
        defaults.message_send_per_agent_limit,
        100.0 / human_secs,
        300.0 / agent_secs,
    );

    // the first refusal is exactly where the documented numbers say
    for index in 100..i64::from(DOCUMENTED_HUMAN) {
        assert_eq!(
            rig.send(&human, fx.workspace, fx.channel, &format!("계속 {index}"))
                .await
                .status,
            201,
            "human send {index}"
        );
    }
    assert_eq!(
        rig.send(&human, fx.workspace, fx.channel, "초과")
            .await
            .status,
        429,
        "the human budget is {DOCUMENTED_HUMAN} per window"
    );
    for index in 300..i64::from(DOCUMENTED_AGENT) {
        assert_eq!(
            rig.send_typed(
                &bearer,
                fx.workspace,
                fx.channel,
                "tool_result",
                &format!("도구 {index}")
            )
            .await
            .status,
            201,
            "agent send {index}"
        );
    }
    assert_eq!(
        rig.send_typed(&bearer, fx.workspace, fx.channel, "tool_result", "초과")
            .await
            .status,
        429,
        "the agent budget is {DOCUMENTED_AGENT} per window"
    );
}
