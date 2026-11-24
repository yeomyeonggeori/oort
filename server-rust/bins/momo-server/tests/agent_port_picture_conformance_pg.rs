//! #6013 — an Agent Port agent's picture for its own message, end to end (ADR-0151 증보 10, ADR-0162
//! 증보 7): the tool `oort_picture_upload_begin`, the public `PUT /v1/agent-uploads/{ws}/{token}` and
//! `oort_message_post.attachmentIds`, over real TCP, a real PG18, the real isolated decoder child and a
//! real local archive.
//!
//! ```text
//! cargo build -p momo-expressions --bins            # the decoder child sits next to the test exe
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:PORT/DB \
//!   cargo test -p momo-server --test agent_port_picture_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! The server runs as `momo_app` (no BYPASSRLS); fixtures are seeded as the superuser. The decoder slots
//! and counters are process-wide, so every test holds one global async mutex and reads counter deltas.
//! Each test measures real values (rows, archive objects, decoder child starts, bytes read back), not
//! only the answer.
//!
//! | test | acceptance (증보 10) | revert that makes it red |
//! |---|---|---|
//! | `a_picture_is_uploaded_and_bound_to_the_agents_own_message` | #6013 AC1, PA5, PA7, PA8, PA16 | build `uploadUrl` from `Host`; store `bytes` not `prepared.data`; send `attachment_ids: &[]` |
//! | `one_token_is_one_picture_and_every_token_refusal_is_one_404` | PA1 | drop `used_at IS NULL` / `expires_at > now` / the path workspace bind in `redeem_in_tx` |
//! | `the_standing_is_asked_again_when_the_token_is_spent_and_when_the_row_is_written` | PA2 | drop a clause of `standing_in_tx` or one of its three calls |
//! | `length_and_slot_refusals_come_before_the_token` | PA3, PA4 (slot) | move the spend above steps 3–4 of `agent_uploads::upload` |
//! | `the_refusal_budget_keys_on_the_edge_setting` | PA4 (budget) | read `X-Forwarded-For` without a trusted edge; drop the second layer |
//! | `only_three_still_formats_reach_the_decoder_and_storage` | PA6 | drop the `SNIFFED` match in `land` |
//! | `every_unbindable_id_is_one_refusal_and_writes_nothing` | PA9, PA10 | drop the token-row `EXISTS` or a predicate of `pictures_linkable_in_tx`; answer the bind refusal with `Ok(Err(..))` (commits the message) |
//! | `the_ceilings_are_judged_at_issue_and_counted_again_at_write` | PA11 | drop a count in `issue_with_ttl_in_tx` / `picture_ceiling_reached_in_tx` or its call in `write_upload_picture_in_tx` |
//! | `the_switch_closes_the_tool_the_argument_and_the_address` | PA12 | serve `ToolCapability::FULL` regardless; drop `served_origin` in the route |
//! | `only_the_api_holds_the_token_table` | PA13 | a grant to any other role in `agent-upload-token-lockdown` |
//! | `the_token_and_the_address_reach_no_record` | PA14 | log or audit the token / path |

#[path = "common/expression_children.rs"]
mod expression_children;

use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::StreamExt;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::{
    DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession, LocalDriveArchive,
    UploadBody, MAX_ATTACHMENT_BYTES,
};
use momo_expressions::media;
use momo_server::config::{AgentPortConfig, AgentUploadsConfig, RateLimitConfig, T3Settings};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-port-picture-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const MCP_PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
/// The operator's public base address: the only origin an upload address may carry (PA5).
const ORIGIN: &str = "https://oort.example.test";
const FIVE_MIB: usize = 5 * 1024 * 1024;
const MARKER: &str = "OORT-MARKER-TRAILER-6013";

static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a disposable PG18 superuser DB")
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
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

fn require_decoder() {
    if std::env::var_os("OORT_EXPRESSION_DECODER").is_some() {
        return;
    }
    let path = expression_children::ready("momo-expression-decoder");
    assert!(
        path.is_ok(),
        "build the decoder first: cargo build -p momo-expressions --bins ({path:?})"
    );
}

async fn pool_as(role: &str, password_env: &str, fallback: &str, max: u32) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var(password_env).unwrap_or_else(|_| fallback.to_string());
    PgPoolOptions::new()
        .max_connections(max)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> CaptureWriter {
        CaptureWriter(self.0.clone())
    }
}
impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

fn capture_logs() -> Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let capture = Capture::default();
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(capture.clone())
                .try_init()
                .expect("one global subscriber per test binary");
            capture
        })
        .clone()
}

// --- the archive --------------------------------------------------------------

type Hook = Arc<dyn Fn(String) -> BoxFuture<'static, ()> + Send + Sync>;

struct ArchiveDir(PathBuf);
impl ArchiveDir {
    fn new() -> ArchiveDir {
        let dir = std::env::temp_dir().join(format!("oort-agent-upload-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp archive");
        ArchiveDir(dir)
    }
}
impl Drop for ArchiveDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A real [`LocalDriveArchive`] that counts `put_object` and can run a hook once the object exists.
struct Files {
    inner: LocalDriveArchive,
    root: PathBuf,
    after_put: Mutex<Option<Hook>>,
    puts: AtomicUsize,
}
impl std::fmt::Debug for Files {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Files").finish_non_exhaustive()
    }
}
impl Files {
    fn open(dir: &ArchiveDir) -> Files {
        Files {
            inner: LocalDriveArchive::open(dir.0.to_str(), "http://127.0.0.1:9")
                .expect("a local archive"),
            root: dir.0.clone(),
            after_put: Mutex::new(None),
            puts: AtomicUsize::new(0),
        }
    }
    fn set_after_put(&self, hook: Option<Hook>) {
        *self.after_put.lock().unwrap() = hook;
    }
    fn objects(&self) -> usize {
        std::fs::read_dir(self.root.join("objects"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        !name.ends_with(".meta") && !name.ends_with(".tmp")
                    })
                    .count()
            })
            .unwrap_or(0)
    }
    fn puts(&self) -> usize {
        self.puts.load(Ordering::SeqCst)
    }
    async fn read(&self, id: &str) -> Vec<u8> {
        let mut content = self
            .inner
            .file_content(id, MAX_ATTACHMENT_BYTES)
            .await
            .expect("the stored object");
        let mut bytes = Vec::new();
        while let Some(chunk) = content.body.next().await {
            bytes.extend_from_slice(&chunk.expect("a chunk"));
        }
        bytes
    }
}

#[async_trait]
impl DriveArchive for Files {
    fn backend_kind(&self) -> &'static str {
        self.inner.backend_kind()
    }
    fn accepts_stub_uploads(&self) -> bool {
        self.inner.accepts_stub_uploads()
    }
    async fn create_resumable_upload(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        self.inner
            .create_resumable_upload(channel_id, name, mime, size_bytes)
            .await
    }
    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        self.inner.file_metadata(file_id).await
    }
    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.inner.file_content(file_id, max_bytes).await
    }
    async fn delete_file(&self, file_id: &str) -> Result<(), DriveError> {
        self.inner.delete_file(file_id).await
    }
    async fn accept_stub_upload(
        &self,
        token: &str,
        mime: Option<&str>,
        content_length: Option<u64>,
        body: UploadBody,
    ) -> Result<(), DriveError> {
        self.inner
            .accept_stub_upload(token, mime, content_length, body)
            .await
    }
    async fn put_object(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<DriveFile, DriveError> {
        self.puts.fetch_add(1, Ordering::SeqCst);
        let file = self.inner.put_object(channel_id, name, mime, bytes).await?;
        let hook = self.after_put.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(file.drive_file_id.clone()).await;
        }
        Ok(file)
    }
}

// --- the server ---------------------------------------------------------------

struct World {
    base: String,
    su: PgPool,
    app: PgPool,
    files: Arc<Files>,
    slots: Arc<tokio::sync::Semaphore>,
    _dir: ArchiveDir,
}

fn hosted_port() -> AgentPortConfig {
    AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        ..AgentPortConfig::default()
    }
}

fn public_origin() -> T3Settings {
    T3Settings {
        public_base_url: Some(ORIGIN.to_string()),
        ..T3Settings::default()
    }
}

async fn boot() -> World {
    boot_with(|state| state).await
}

async fn boot_with(tune: impl FnOnce(AppState) -> AppState) -> World {
    require_decoder();
    ensure_schema_and_roles();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("superuser pool");
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw", 8).await;
    let dir = ArchiveDir::new();
    let files = Arc::new(Files::open(&dir));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr: SocketAddr = listener.local_addr().unwrap();
    let state = tune(
        AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_drive(files.clone())
        .with_agent_port(hosted_port())
        .with_t3(public_origin()),
    );
    let slots = state.agent_uploads.slots.clone();
    let router = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    World {
        base: format!("http://{addr}"),
        su,
        app,
        files,
        slots,
        _dir: dir,
    }
}

// --- the fixture --------------------------------------------------------------

#[derive(Debug, Clone)]
struct Agent {
    member: Uuid,
    connection: Uuid,
    token_id: Uuid,
    bearer: String,
}

#[derive(Debug, Clone)]
struct Tenant {
    ws: Uuid,
    human: Uuid,
    human_jwt: String,
    a: Agent,
    b: Agent,
    channel: Uuid,
    other_channel: Uuid,
}

async fn exec(su: &PgPool, sql: &str, ids: &[Uuid]) {
    let mut query = sqlx::query(sql);
    for id in ids {
        query = query.bind(*id);
    }
    query
        .execute(su)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
}

async fn seed_agent(su: &PgPool, ws: Uuid, human: Uuid, channels: &[Uuid], name: &str) -> Agent {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'agent',$3,$4)",
    )
    .bind(member)
    .bind(ws)
    .bind(name)
    .bind(format!("{name}-{}", member.simple()))
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(member)
    .bind(ws)
    .bind(human)
    .execute(su)
    .await
    .expect("agent row");
    exec(
        su,
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
        &[ws, member],
    )
    .await;
    exec(
        su,
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) VALUES($1,$2,$3,false)",
        &[member, ws, human],
    )
    .await;
    for channel in channels {
        exec(
            su,
            "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            &[ws, *channel, member],
        )
        .await;
    }
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write']::text[],$4)",
    )
    .bind(connection)
    .bind(ws)
    .bind(member)
    .bind(human)
    .bind(channels.to_vec())
    .execute(su)
    .await
    .expect("hosted connection");
    let bearer = format!(
        "momo_agent_v1.{ws}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let token_id: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write']::text[], \
                'hosted agent port','hosted_active',$4,$5,$6) RETURNING id",
    )
    .bind(ws)
    .bind(member)
    .bind(&bearer)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(human)
    .fetch_one(su)
    .await
    .expect("hosted bearer");
    exec(
        su,
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, proved_at=now(), \
           proved_by=$4 WHERE workspace_id=$1 AND id=$2",
        &[ws, connection, token_id, member],
    )
    .await;
    Agent {
        member,
        connection,
        token_id,
        bearer,
    }
}

async fn seed(su: &PgPool) -> Tenant {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(format!("pic-{}", ws.simple()))
        .execute(su)
        .await
        .expect("workspace");
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'human','김도현',$3)",
    )
    .bind(human)
    .bind(ws)
    .bind(format!("human-{}", human.simple()))
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(ws)
    .bind(format!("{human}@picture.test"))
    .execute(su)
    .await
    .expect("human identity");
    exec(
        su,
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'owner')",
        &[ws, human],
    )
    .await;
    let channel = Uuid::new_v4();
    let other_channel = Uuid::new_v4();
    for (id, name) in [(channel, "qa"), (other_channel, "design")] {
        sqlx::query(
            "INSERT INTO channel(id, workspace_id, kind, name, browse_listed) VALUES($1,$2,'public',$3,true)",
        )
        .bind(id)
        .bind(ws)
        .bind(format!("{name}-{}", id.simple()))
        .execute(su)
        .await
        .expect("channel");
        exec(
            su,
            "INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)",
            &[id, ws],
        )
        .await;
        exec(
            su,
            "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            &[ws, id, human],
        )
        .await;
    }
    let a = seed_agent(su, ws, human, &[channel, other_channel], "agent-a").await;
    let b = seed_agent(su, ws, human, &[channel, other_channel], "agent-b").await;
    let human_jwt = momo_auth::sign_access(human, ws, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'picture-conformance')",
    )
    .bind(ws)
    .bind(human)
    .bind(&human_jwt)
    .execute(su)
    .await
    .expect("human session");
    Tenant {
        ws,
        human,
        human_jwt,
        a,
        b,
        channel,
        other_channel,
    }
}

// --- the wire -----------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

fn modern_body(method: &str, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().expect("an object") {
        params[key] = value.clone();
    }
    json!({"jsonrpc": "2.0", "id": Uuid::new_v4().to_string(), "method": method, "params": params})
}

async fn call_with(
    w: &World,
    bearer: &str,
    tool: &str,
    arguments: Value,
    headers: &[(&str, &str)],
) -> (u16, Value) {
    let mut request = client()
        .post(format!("{}{MCP_PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", tool)
        .bearer_auth(bearer);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request
        .json(&modern_body(
            "tools/call",
            json!({"name": tool, "arguments": arguments}),
        ))
        .send()
        .await
        .expect("tools/call");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn call(w: &World, bearer: &str, tool: &str, arguments: Value) -> (u16, Value) {
    call_with(w, bearer, tool, arguments, &[]).await
}

async fn list(w: &World, bearer: &str) -> Vec<Value> {
    let response = client()
        .post(format!("{}{MCP_PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(bearer)
        .json(&modern_body("tools/list", json!({})))
        .send()
        .await
        .expect("tools/list");
    assert_eq!(response.status().as_u16(), 200);
    let value: Value = response.json().await.expect("body");
    value["result"]["tools"].as_array().expect("tools").clone()
}

/// `oort_picture_upload_begin` → the upload address (asserts success).
async fn begin(w: &World, agent: &Agent, channel: Uuid) -> String {
    let (status, value) = call(
        w,
        &agent.bearer,
        "oort_picture_upload_begin",
        json!({"channelId": channel}),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let result = &value["result"]["structuredContent"];
    assert_eq!(result["expiresInSeconds"], json!(120));
    assert_eq!(result["maxBytes"], json!(FIVE_MIB));
    result["uploadUrl"].as_str().expect("uploadUrl").to_string()
}

/// The `/v1/agent-uploads/…` path of an upload address (the test server is not at the public origin).
fn path_of(url: &str) -> String {
    url.strip_prefix(ORIGIN)
        .expect("the configured origin")
        .to_string()
}

fn token_of(url: &str) -> String {
    url.rsplit('/').next().expect("a token").to_string()
}

struct Seen {
    status: u16,
    body: Value,
}

async fn put_path(w: &World, path: &str, bytes: Vec<u8>, headers: &[(&str, &str)]) -> Seen {
    let mut request = client().put(format!("{}{path}", w.base)).body(bytes);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("PUT");
    let status = response.status().as_u16();
    Seen {
        status,
        body: response.json().await.unwrap_or(Value::Null),
    }
}

async fn put(w: &World, url: &str, bytes: Vec<u8>) -> Seen {
    put_path(w, &path_of(url), bytes, &[]).await
}

fn code(seen: &Seen) -> Option<String> {
    seen.body["error"]["code"].as_str().map(str::to_string)
}

fn attachment_id(seen: &Seen) -> Uuid {
    assert_eq!(seen.status, 201, "{}", seen.body);
    seen.body["attachmentId"]
        .as_str()
        .expect("attachmentId")
        .parse()
        .expect("uuid")
}

async fn post(w: &World, agent: &Agent, channel: Uuid, ids: Option<Vec<Uuid>>) -> (u16, Value) {
    let mut arguments = json!({
        "channelId": channel,
        "clientMsgId": Uuid::new_v4(),
        "body": "바뀐 화면 전 · 후예요",
    });
    if let Some(ids) = ids {
        arguments["attachmentIds"] = json!(ids);
    }
    call(w, &agent.bearer, "oort_message_post", arguments).await
}

async fn count(w: &World, sql: &str, ids: &[Uuid]) -> i64 {
    let mut query = sqlx::query_scalar::<_, i64>(sql);
    for id in ids {
        query = query.bind(*id);
    }
    query
        .fetch_one(&w.su)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

async fn messages(w: &World, t: &Tenant) -> i64 {
    count(
        w,
        "SELECT count(*) FROM message WHERE workspace_id = $1",
        &[t.ws],
    )
    .await
}

async fn attachments(w: &World, t: &Tenant) -> i64 {
    count(
        w,
        "SELECT count(*) FROM attachment WHERE workspace_id = $1",
        &[t.ws],
    )
    .await
}

async fn token_spent(w: &World, t: &Tenant, token: &str) -> bool {
    let hash = momo_messaging::token_hash(token).to_vec();
    sqlx::query_scalar::<_, bool>(
        "SELECT used_at IS NOT NULL FROM agent_upload_token WHERE workspace_id = $1 AND token_hash = $2",
    )
    .bind(t.ws)
    .bind(hash)
    .fetch_one(&w.su)
    .await
    .expect("the token row")
}

// --- the pictures -------------------------------------------------------------

fn encode(image: image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
    });
    let mut bytes = encode(
        image::DynamicImage::ImageRgb8(image),
        image::ImageFormat::Jpeg,
    );
    // bytes after the end-of-image marker: a decoder ignores them, a copy would keep them
    bytes.extend_from_slice(MARKER.as_bytes());
    bytes
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([x as u8, y as u8, 90, 255]));
    encode(
        image::DynamicImage::ImageRgba8(image),
        image::ImageFormat::Png,
    )
}

fn gif_one_frame() -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
    gif.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00]);
    gif.extend_from_slice(&[0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]);
    gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]);
    gif.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
    gif.push(0x3B);
    gif
}

// --- tests --------------------------------------------------------------------

/// #6013 AC1 · PA5 · PA7 · PA8 · PA16: the agent gets an address on the operator's origin whatever
/// `Host` and `X-Forwarded-Host` say, uploads a picture bigger than the stored ceiling, nothing shows in
/// the conversation until it posts, and then its own message carries the re-encoded picture.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_picture_is_uploaded_and_bound_to_the_agents_own_message() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let t = seed(&w.su).await;

    let (status, value) = call_with(
        &w,
        &t.a.bearer,
        "oort_picture_upload_begin",
        json!({"channelId": t.channel}),
        &[
            ("host", "attacker.example"),
            ("x-forwarded-host", "attacker.example"),
        ],
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let url = value["result"]["structuredContent"]["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();
    assert!(
        url.starts_with(&format!("{ORIGIN}/v1/agent-uploads/{}/", t.ws)),
        "PA5: the origin is the operator's, never the request's: {url}"
    );

    let messages_before = messages(&w, &t).await;
    let outbox_before = count(
        &w,
        "SELECT count(*) FROM outbox WHERE workspace_id = $1",
        &[t.ws],
    )
    .await;
    let input = jpeg(1600, 900);
    let seen = put(&w, &url, input.clone()).await;
    let id = attachment_id(&seen);
    assert_eq!(seen.body["mime"], json!("image/jpeg"));

    // PA8: an upload alone shows nothing to anybody
    assert_eq!(messages(&w, &t).await, messages_before);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM outbox WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        outbox_before
    );

    // PA7: what is stored is the decoder's output — long side 1024, no byte of the input's tail
    let (drive_file_id, uploader, channel, name, message): (
        String,
        Uuid,
        Uuid,
        String,
        Option<Uuid>,
    ) = sqlx::query_as(
        "SELECT drive_file_id, uploader_member_id, channel_id, name, message_id \
               FROM attachment WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&w.su)
    .await
    .expect("the row");
    assert_eq!(
        (uploader, channel, name.as_str(), message),
        (t.a.member, t.channel, "picture.jpg", None)
    );
    let stored = w.files.read(&drive_file_id).await;
    assert_ne!(stored, input);
    assert!(stored
        .windows(MARKER.len())
        .all(|window| window != MARKER.as_bytes()));
    let decoded = image::load_from_memory(&stored).expect("a picture");
    assert_eq!((decoded.width(), decoded.height()), (1024, 576));
    // the mark that counts it has no run (this road), the token row records it once
    assert_eq!(
        count(&w, "SELECT count(*) FROM agent_picture_mark WHERE attachment_id = $1 AND run_id IS NULL AND agent_member_id = $2", &[id, t.a.member]).await,
        1
    );

    // the message: the agent's own, with the picture, through the one send path
    let (status, value) = post(&w, &t.a, t.channel, Some(vec![id])).await;
    assert_eq!(status, 200, "{value}");
    let message_id: Uuid = value["result"]["structuredContent"]["messageId"]
        .as_str()
        .expect("messageId")
        .parse()
        .unwrap();
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment WHERE id = $1 AND message_id = $2",
            &[id, message_id]
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message WHERE id = $1 AND author_member_id = $2",
            &[message_id, t.a.member]
        )
        .await,
        1
    );
    // the written audit line names the attachment, never the token
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'attachment.agent_port_picture_written' AND target_id = $2",
    )
    .bind(t.ws)
    .bind(id)
    .fetch_one(&w.su)
    .await
    .expect("the audit line");
    assert_eq!(detail["channel_id"], json!(t.channel.to_string()));
    assert_eq!(detail["connection_id"], json!(t.a.connection.to_string()));
    assert!(!detail.to_string().contains(&token_of(&url)));
}

/// PA1: a token is one picture — a second PUT, an expired token and the same token under another
/// workspace's path are all the one 404, and none writes a row, an object or starts the decoder.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn one_token_is_one_picture_and_every_token_refusal_is_one_404() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let t = seed(&w.su).await;
    let other = seed(&w.su).await;

    let url = begin(&w, &t.a, t.channel).await;
    attachment_id(&put(&w, &url, png(64, 64)).await);
    let (rows, objects, children) = (
        attachments(&w, &t).await,
        w.files.objects(),
        media::decoder_children_started(),
    );

    // the same token again
    let again = put(&w, &url, png(64, 64)).await;
    assert_eq!(again.status, 404, "{}", again.body);

    // a live token under another workspace's path
    let live = begin(&w, &t.a, t.channel).await;
    let elsewhere = path_of(&live).replace(&t.ws.to_string(), &other.ws.to_string());
    assert_eq!(put_path(&w, &elsewhere, png(64, 64), &[]).await.status, 404);
    assert!(
        !token_spent(&w, &t, &token_of(&live)).await,
        "the other path does not spend it"
    );

    // an expired token (issued with a one-second life, as the api would)
    let expired = with_tenant_tx(&w.app, t.ws, |conn| {
        let (ws, connection, agent, channel) = (t.ws, t.a.connection, t.a.member, t.channel);
        Box::pin(async move {
            momo_messaging::issue_agent_upload_with_ttl_in_tx(
                conn, ws, connection, agent, channel, 1, 200,
            )
            .await
        })
    })
    .await
    .expect("issue")
    .expect("issued");
    tokio::time::sleep(Duration::from_millis(1_300)).await;
    let path = format!("/v1/agent-uploads/{}/{}", t.ws, expired.token);
    assert_eq!(put_path(&w, &path, png(64, 64), &[]).await.status, 404);

    assert_eq!(attachments(&w, &t).await, rows);
    assert_eq!(w.files.objects(), objects);
    assert_eq!(media::decoder_children_started(), children);
}

/// PA2: after the address is issued, any one of five changes stops the picture — checked when the token is
/// spent (no row, no object) and, for a change that lands while the picture is decoded, when the row is
/// written (no row, the object removed).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_standing_is_asked_again_when_the_token_is_spent_and_when_the_row_is_written() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let cases: [(&str, &str); 5] = [
        ("the credential is revoked", "UPDATE token SET revoked_at = now() WHERE workspace_id = $1 AND id = $2"),
        ("messages:write is taken back", "UPDATE hosted_agent_connection SET approved_scopes = array_remove(approved_scopes, 'messages:write') WHERE workspace_id = $1 AND active_token_id = $2"),
        ("the channel is no longer approved", "UPDATE hosted_agent_connection SET approved_channel_ids = array_remove(approved_channel_ids, $3) WHERE workspace_id = $1 AND active_token_id = $2"),
        ("the agent left the channel", "UPDATE membership SET left_at = now() WHERE workspace_id = $1 AND channel_id = $3 AND member_id = (SELECT actor_member_id FROM token WHERE id = $2)"),
        ("the channel is archived", "UPDATE channel SET archived_at = now() WHERE workspace_id = $1 AND id = $3 AND $2 IS NOT NULL"),
    ];
    for (what, sql) in cases {
        // at the spend
        let t = seed(&w.su).await;
        let url = begin(&w, &t.a, t.channel).await;
        exec(&w.su, sql, &[t.ws, t.a.token_id, t.channel]).await;
        let puts = w.files.puts();
        let seen = put(&w, &url, png(64, 64)).await;
        assert_eq!(seen.status, 404, "{what}: {}", seen.body);
        assert_eq!(attachments(&w, &t).await, 0, "{what}");
        assert_eq!(w.files.puts(), puts, "{what}: nothing was stored");

        // between the spend and the row: the object exists, then the change lands
        let t = seed(&w.su).await;
        let url = begin(&w, &t.a, t.channel).await;
        let su = w.su.clone();
        let (ws, token_id, channel) = (t.ws, t.a.token_id, t.channel);
        let sql: &'static str = sql;
        w.files.set_after_put(Some(Arc::new(move |_| {
            let su = su.clone();
            Box::pin(async move { exec(&su, sql, &[ws, token_id, channel]).await })
        })));
        let objects = w.files.objects();
        let seen = put(&w, &url, png(64, 64)).await;
        w.files.set_after_put(None);
        assert_eq!(seen.status, 409, "{what}: {}", seen.body);
        assert_eq!(code(&seen).as_deref(), Some("not_allowed_now"), "{what}");
        assert_eq!(attachments(&w, &t).await, 0, "{what}");
        assert_eq!(
            w.files.objects(),
            objects,
            "{what}: the stored object is removed"
        );
    }
}

/// PA3 · PA4 (slot): no length, too long and a busy slot are refused before the token, which stays
/// unspent and still works afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn length_and_slot_refusals_come_before_the_token() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let t = seed(&w.su).await;
    let url = begin(&w, &t.a, t.channel).await;
    let token = token_of(&url);

    // no Content-Length: a streamed body is sent chunked
    let stream = futures::stream::iter(vec![Ok::<_, std::io::Error>(png(32, 32))]);
    let response = client()
        .put(format!("{}{}", w.base, path_of(&url)))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .expect("PUT");
    assert_eq!(response.status().as_u16(), 411);
    // more than 5 MiB
    let seen = put(&w, &url, vec![0u8; FIVE_MIB + 1]).await;
    assert_eq!(seen.status, 413, "{}", seen.body);
    // the slot is held: busy, before the token
    let held = w.slots.clone().acquire_owned().await.expect("the one slot");
    let seen = put(&w, &url, png(32, 32)).await;
    assert_eq!(seen.status, 503, "{}", seen.body);
    assert_eq!(code(&seen).as_deref(), Some("busy"));
    drop(held);
    assert!(
        !token_spent(&w, &t, &token).await,
        "411, 413 and 503 spend nothing"
    );
    attachment_id(&put(&w, &url, png(32, 32)).await);
}

/// PA4 (budget): without a trusted edge, a caller's own `X-Forwarded-For` chooses no bucket and the
/// second layer is one ceiling for the prefix; with a trusted edge, the header's first hop is the key.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_refusal_budget_keys_on_the_edge_setting() {
    let _gate = GATE.lock().await;
    let limit = RateLimitConfig {
        self_media_per_workspace_limit: 2,
        ..RateLimitConfig::default()
    };
    let bogus = |ws: Uuid| format!("/v1/agent-uploads/{ws}/{}", "A".repeat(43));

    // untrusted (the default): rotating the header does not reset the first layer
    let w = boot_with(|state| state.with_rate_limit(limit.clone())).await;
    let ws = Uuid::new_v4();
    let mut statuses = Vec::new();
    for hop in ["198.51.100.1", "198.51.100.2", "198.51.100.3"] {
        statuses.push(
            put_path(&w, &bogus(ws), vec![1], &[("x-forwarded-for", hop)])
                .await
                .status,
        );
    }
    assert_eq!(statuses, [404, 404, 429], "the header is not the key");
    // rotating the workspace walks into the second layer: one ceiling for the prefix (2 × 10)
    let mut last = 0;
    for _ in 0..30 {
        last = put_path(&w, &bogus(Uuid::new_v4()), vec![1], &[])
            .await
            .status;
        if last == 429 {
            break;
        }
    }
    assert_eq!(
        last, 429,
        "the prefix-wide ceiling stops a caller rotating workspace ids"
    );

    // trusted: each first hop is its own caller
    let w = boot_with(|state| {
        state
            .with_rate_limit(limit.clone())
            .with_agent_uploads(AgentUploadsConfig {
                pictures_enabled: true,
                trusted_edge: true,
            })
    })
    .await;
    let ws = Uuid::new_v4();
    let mut statuses = Vec::new();
    for hop in [
        "198.51.100.1",
        "198.51.100.1",
        "198.51.100.1",
        "198.51.100.2",
    ] {
        statuses.push(
            put_path(&w, &bogus(ws), vec![1], &[("x-forwarded-for", hop)])
                .await
                .status,
        );
    }
    assert_eq!(
        statuses,
        [404, 404, 429, 404],
        "the edge's first hop is the key"
    );
}

/// PA6: GIF (one frame), SVG, PDF, HEIC, HTML and an empty body are refused at the sniff — the decoder
/// child never starts and nothing is stored; a PNG magic in front of garbage reaches the child and is
/// refused there, and is not stored either.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_three_still_formats_reach_the_decoder_and_storage() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let t = seed(&w.su).await;
    let heic = {
        let mut bytes = vec![0x00, 0x00, 0x00, 0x18];
        bytes.extend_from_slice(b"ftypheic\x00\x00\x00\x00mif1heic");
        bytes.extend_from_slice(&[0u8; 64]);
        bytes
    };
    let refused_at_sniff: Vec<(&str, Vec<u8>)> = vec![
        ("gif", gif_one_frame()),
        (
            "svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"/>".to_vec(),
        ),
        ("pdf", b"%PDF-1.7\n%%EOF\n".to_vec()),
        ("heic", heic),
        ("html", b"<!doctype html><script>alert(1)</script>".to_vec()),
        ("empty", Vec::new()),
    ];
    for (what, bytes) in refused_at_sniff {
        let url = begin(&w, &t.a, t.channel).await;
        let children = media::decoder_children_started();
        let puts = w.files.puts();
        let declared = bytes.len().to_string();
        let seen = put_path(&w, &path_of(&url), bytes, &[("content-length", &declared)]).await;
        assert_eq!(seen.status, 422, "{what}: {}", seen.body);
        assert_eq!(code(&seen).as_deref(), Some("unsupported_format"), "{what}");
        assert_eq!(
            media::decoder_children_started(),
            children,
            "{what}: no child"
        );
        assert_eq!(w.files.puts(), puts, "{what}: nothing stored");
    }
    let url = begin(&w, &t.a, t.channel).await;
    let mut disguised = b"\x89PNG\r\n\x1a\n".to_vec();
    disguised.extend_from_slice(&[7u8; 256]);
    let children = media::decoder_children_started();
    let seen = put(&w, &url, disguised).await;
    assert_eq!(seen.status, 422, "{}", seen.body);
    assert_eq!(code(&seen).as_deref(), Some("invalid_picture"));
    assert!(
        media::decoder_children_started() > children,
        "the child judged it"
    );
    assert_eq!(attachments(&w, &t).await, 0);
}

/// PA9 · PA10: seven ids the caller may not bind — another agent's, its own in another channel, the
/// worker road's, a person's, already bound, unknown, the same id twice — are one refusal each with the
/// same answer, and no message is left behind; a person's REST send naming this road's picture is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn every_unbindable_id_is_one_refusal_and_writes_nothing() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let t = seed(&w.su).await;
    let upload = |agent: Agent, channel: Uuid| {
        let w = &w;
        async move {
            let url = begin(w, &agent, channel).await;
            attachment_id(&put(w, &url, png(48, 48)).await)
        }
    };
    let others = upload(t.b.clone(), t.channel).await;
    let own_elsewhere = upload(t.a.clone(), t.other_channel).await;
    let bound = upload(t.a.clone(), t.channel).await;
    let (status, value) = post(&w, &t.a, t.channel, Some(vec![bound])).await;
    assert_eq!(status, 200, "{value}");
    // a worker-road picture of the same agent (an attachment row this road never recorded) and a person's
    let mut extra = Vec::new();
    for uploader in [t.a.member, t.human] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, drive_file_id, \
                                     name, mime, size_bytes, status) \
             VALUES ($1, $2, $3, NULL, $4, 'picture-1.png', 'image/png', 10, 'complete') RETURNING id",
        )
        .bind(t.ws)
        .bind(t.channel)
        .bind(uploader)
        .bind(format!("local:{}", Uuid::new_v4()))
        .fetch_one(&w.su)
        .await
        .expect("a foreign attachment");
        extra.push(id);
    }
    let mine = upload(t.a.clone(), t.channel).await;
    let cases: Vec<(&str, Vec<Uuid>)> = vec![
        ("another agent's", vec![others]),
        ("its own in another channel", vec![own_elsewhere]),
        ("the worker road's", vec![extra[0]]),
        ("a person's", vec![extra[1]]),
        ("already bound", vec![bound]),
        ("unknown", vec![Uuid::new_v4()]),
        ("the same id twice", vec![mine, mine]),
    ];
    let before = messages(&w, &t).await;
    let mut shapes = Vec::new();
    for (what, ids) in cases {
        let (status, value) = post(&w, &t.a, t.channel, Some(ids)).await;
        assert_eq!(status, 400, "{what}: {value}");
        assert_eq!(value["error"]["code"], json!(-32602), "{what}");
        assert_eq!(
            value["error"]["data"],
            json!({"code": "attachment_not_linkable"}),
            "{what}"
        );
        shapes.push((
            status,
            value["error"]["message"].clone(),
            value["error"]["data"].clone(),
        ));
        assert_eq!(messages(&w, &t).await, before, "{what}: no message");
    }
    assert!(
        shapes.windows(2).all(|pair| pair[0] == pair[1]),
        "one answer for all seven"
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment WHERE workspace_id = $1 AND message_id IS NOT NULL",
            &[t.ws]
        )
        .await,
        1,
        "only the one bound on purpose"
    );
    // the picture the refusals named is still the agent's to bind
    let (status, value) = post(&w, &t.a, t.channel, Some(vec![mine])).await;
    assert_eq!(status, 200, "{value}");

    // PA10: a person's REST send naming this road's picture
    let fresh = upload(t.a.clone(), t.channel).await;
    let before = messages(&w, &t).await;
    let response = client()
        .post(format!("{}/v1/workspaces/{}/channels/{}/messages", w.base, t.ws, t.channel))
        .bearer_auth(&t.human_jwt)
        .json(&json!({"body": "내가 붙일게요", "clientMsgId": Uuid::new_v4(), "attachmentIds": [fresh]}))
        .send()
        .await
        .expect("REST send");
    assert!(response.status().is_client_error(), "{}", response.status());
    assert_eq!(messages(&w, &t).await, before);
}

async fn seed_marks(w: &World, ws: Uuid, agent: Uuid, n: usize) {
    for _ in 0..n {
        exec(
            &w.su,
            "INSERT INTO agent_picture_mark (workspace_id, attachment_id, run_id, agent_member_id) VALUES ($1, $2, NULL, $3)",
            &[ws, Uuid::new_v4(), agent],
        )
        .await;
    }
}

/// Unbound pictures of this road, made directly: an attachment row and a spent token row that recorded it.
async fn seed_unbound(w: &World, t: &Tenant, agent: &Agent, n: usize) {
    for _ in 0..n {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, drive_file_id, \
                                     name, mime, size_bytes, status) \
             VALUES ($1, $2, $3, NULL, $4, 'picture.png', 'image/png', 10, 'complete') RETURNING id",
        )
        .bind(t.ws)
        .bind(t.channel)
        .bind(agent.member)
        .bind(format!("local:{}", Uuid::new_v4()))
        .fetch_one(&w.su)
        .await
        .expect("an unbound picture");
        sqlx::query(
            "INSERT INTO agent_upload_token (workspace_id, token_hash, connection_id, agent_member_id, channel_id, \
                                             created_at, expires_at, used_at, attachment_id) \
             VALUES ($1, $2, $3, $4, $5, now() - interval '10 minutes', now() - interval '8 minutes', \
                     now() - interval '9 minutes', $6)",
        )
        .bind(t.ws)
        .bind(Uuid::new_v4().as_bytes().repeat(2))
        .bind(agent.connection)
        .bind(agent.member)
        .bind(t.channel)
        .bind(id)
        .execute(&w.su)
        .await
        .expect("its token row");
    }
}

async fn begin_refused(w: &World, agent: &Agent, channel: Uuid, what: &str) {
    let (status, value) = call(
        w,
        &agent.bearer,
        "oort_picture_upload_begin",
        json!({"channelId": channel}),
    )
    .await;
    assert_eq!(status, 409, "{what}: {value}");
    assert_eq!(
        value["error"]["data"],
        json!({"code": "picture_limit_reached"}),
        "{what}"
    );
}

async fn tokens(w: &World, t: &Tenant) -> i64 {
    count(
        w,
        "SELECT count(*) FROM agent_upload_token WHERE workspace_id = $1",
        &[t.ws],
    )
    .await
}

/// PA11: every ceiling is judged when the address is issued (no token row is added) and the picture
/// ceilings are counted again when the row is written (no row, no object).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_ceilings_are_judged_at_issue_and_counted_again_at_write() {
    let _gate = GATE.lock().await;
    let w = boot_with(|state| state.with_agent_uploads_limits(1, 6, Duration::from_secs(10))).await;

    // a fifth picture in one message: the published schema refuses it
    let t = seed(&w.su).await;
    let (status, value) = post(
        &w,
        &t.a,
        t.channel,
        Some((0..5).map(|_| Uuid::new_v4()).collect()),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].clone()),
        (400, json!(-32602)),
        "{value}"
    );

    // the agent's 31st picture of the day
    let t = seed(&w.su).await;
    seed_marks(&w, t.ws, t.a.member, 30).await;
    let n = tokens(&w, &t).await;
    begin_refused(&w, &t.a, t.channel, "agent daily").await;
    assert_eq!(tokens(&w, &t).await, n);

    // the workspace's ceiling (6 here, 200 in production), both roads counted
    let t = seed(&w.su).await;
    seed_marks(&w, t.ws, t.b.member, 6).await;
    begin_refused(&w, &t.a, t.channel, "workspace daily").await;

    // a fifth live address
    let t = seed(&w.su).await;
    for _ in 0..4 {
        begin(&w, &t.a, t.channel).await;
    }
    begin_refused(&w, &t.a, t.channel, "live addresses").await;
    assert_eq!(tokens(&w, &t).await, 4);

    // the 61st issue of the day
    let t = seed(&w.su).await;
    for _ in 0..60 {
        sqlx::query(
            "INSERT INTO agent_upload_token (workspace_id, token_hash, connection_id, agent_member_id, channel_id, \
                                             created_at, expires_at, used_at) \
             VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - interval '58 minutes', now() - interval '59 minutes')",
        )
        .bind(t.ws)
        .bind(Uuid::new_v4().as_bytes().repeat(2))
        .bind(t.a.connection)
        .bind(t.a.member)
        .bind(t.channel)
        .execute(&w.su)
        .await
        .expect("an old issue");
    }
    begin_refused(&w, &t.a, t.channel, "daily issues").await;
    assert_eq!(tokens(&w, &t).await, 60);

    // eight unbound pictures: refused; bind one, and the next issue passes
    let t = seed(&w.su).await;
    let url = begin(&w, &t.a, t.channel).await;
    let first = attachment_id(&put(&w, &url, png(40, 40)).await);
    seed_unbound(&w, &t, &t.a, 7).await;
    begin_refused(&w, &t.a, t.channel, "unbound pictures").await;
    let (status, value) = post(&w, &t.a, t.channel, Some(vec![first])).await;
    assert_eq!(status, 200, "{value}");
    begin(&w, &t.a, t.channel).await;

    // judged at issue with 7 unbound, counted again at write: two live addresses, the second write refused
    let t = seed(&w.su).await;
    seed_unbound(&w, &t, &t.a, 7).await;
    let one = begin(&w, &t.a, t.channel).await;
    let two = begin(&w, &t.a, t.channel).await;
    attachment_id(&put(&w, &one, png(40, 40)).await);
    let rows = attachments(&w, &t).await;
    let objects = w.files.objects();
    let seen = put(&w, &two, png(40, 40)).await;
    assert_eq!(seen.status, 429, "{}", seen.body);
    assert_eq!(code(&seen).as_deref(), Some("cap_reached"));
    assert_eq!(attachments(&w, &t).await, rows, "no row");
    assert_eq!(w.files.objects(), objects, "no object");

    // and the workspace ceiling reached between issue and write
    let t = seed(&w.su).await;
    seed_marks(&w, t.ws, t.b.member, 5).await;
    let url = begin(&w, &t.a, t.channel).await;
    seed_marks(&w, t.ws, t.b.member, 1).await;
    let seen = put(&w, &url, png(40, 40)).await;
    assert_eq!(seen.status, 429, "{}", seen.body);
    assert_eq!(attachments(&w, &t).await, 0);
}

/// PA12: with the operator's switch off (or no public base address), the listing is exactly one tool
/// shorter, `oort_message_post` has no `attachmentIds` and refuses one (no message), and a live address
/// is the one 404 without being spent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_switch_closes_the_tool_the_argument_and_the_address() {
    let _gate = GATE.lock().await;
    let on = boot().await;
    let t = seed(&on.su).await;
    let url = begin(&on, &t.a, t.channel).await;
    let listed_on = list(&on, &t.a.bearer).await;

    for (what, off) in [
        (
            "switch off",
            boot_with(|state| {
                state.with_agent_uploads(AgentUploadsConfig {
                    pictures_enabled: false,
                    trusted_edge: false,
                })
            })
            .await,
        ),
        (
            "no public base address",
            boot_with(|state| state.with_t3(T3Settings::default())).await,
        ),
    ] {
        let listed_off = list(&off, &t.a.bearer).await;
        assert_eq!(listed_on.len(), listed_off.len() + 1, "{what}");
        assert!(
            listed_off
                .iter()
                .all(|tool| tool["name"] != json!("oort_picture_upload_begin")),
            "{what}"
        );
        let post_tool = listed_off
            .iter()
            .find(|tool| tool["name"] == json!("oort_message_post"))
            .expect("listed");
        assert!(
            post_tool["inputSchema"]["properties"]
                .get("attachmentIds")
                .is_none(),
            "{what}"
        );
        let before = messages(&off, &t).await;
        let (status, value) = post(&off, &t.a, t.channel, Some(vec![Uuid::new_v4()])).await;
        assert_eq!(status, 400, "{what}: {value}");
        assert_eq!(messages(&off, &t).await, before, "{what}");
        let (status, _) = call(
            &off,
            &t.a.bearer,
            "oort_picture_upload_begin",
            json!({"channelId": t.channel}),
        )
        .await;
        assert_ne!(status, 200, "{what}");
        let seen = put_path(&off, &path_of(&url), png(32, 32), &[]).await;
        assert_eq!(seen.status, 404, "{what}");
        assert!(
            !token_spent(&on, &t, &token_of(&url)).await,
            "{what}: not spent"
        );
    }
}

/// PA13: only `momo_app` holds anything on the token table; the mark table's privileges are 179's and
/// its `run_id` now admits this road's rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_the_api_holds_the_token_table() {
    let _gate = GATE.lock().await;
    let w = boot().await;
    let verbs = [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
    ];
    for (table, role, allowed) in [
        (
            "agent_upload_token",
            "momo_app",
            &["SELECT", "INSERT", "UPDATE", "DELETE"][..],
        ),
        ("agent_upload_token", "momo_worker", &[][..]),
        ("agent_upload_token", "momo_relay", &[][..]),
        ("agent_upload_token", "momo_notifier", &[][..]),
        (
            "agent_picture_mark",
            "momo_app",
            &["SELECT", "INSERT", "DELETE"][..],
        ),
        ("agent_picture_mark", "momo_worker", &[][..]),
        ("agent_picture_mark", "momo_notifier", &[][..]),
    ] {
        for verb in verbs {
            let held: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
                .bind(role)
                .bind(format!("public.{table}"))
                .bind(verb)
                .fetch_one(&w.su)
                .await
                .expect("privilege");
            assert_eq!(held, allowed.contains(&verb), "{role} {verb} on {table}");
        }
    }
    for role in ["momo_platform_admin", "momo_helper_read", "momo_memory"] {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)")
                .bind(role)
                .fetch_one(&w.su)
                .await
                .unwrap();
        if exists {
            let any: bool = sqlx::query_scalar(
                "SELECT has_table_privilege($1, 'public.agent_upload_token', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')",
            )
            .bind(role)
            .fetch_one(&w.su)
            .await
            .unwrap();
            assert!(!any, "{role} holds something on agent_upload_token");
        }
    }
    let nullable: String = sqlx::query_scalar(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'agent_picture_mark' AND column_name = 'run_id'",
    )
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(nullable, "YES");
}

/// PA14: after a success and a refusal after the spend, the token and the upload path are in no audit
/// line, no Agent Port call record, no log line and no error body.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_token_and_the_address_reach_no_record() {
    let _gate = GATE.lock().await;
    let logs = capture_logs();
    let w = boot().await;
    let t = seed(&w.su).await;
    let good = begin(&w, &t.a, t.channel).await;
    let bad = begin(&w, &t.a, t.channel).await;
    attachment_id(&put(&w, &good, png(40, 40)).await);
    let refused = put(&w, &bad, gif_one_frame()).await;
    assert_eq!(refused.status, 422);
    let audits: Vec<String> =
        sqlx::query_scalar("SELECT row_to_json(a)::text FROM audit_log a WHERE workspace_id = $1")
            .bind(t.ws)
            .fetch_all(&w.su)
            .await
            .unwrap();
    assert!(audits
        .iter()
        .any(|row| row.contains("agent_port_picture_refused")));
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT row_to_json(e)::text FROM agent_run_event e WHERE workspace_id = $1",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .unwrap_or_default();
    let log_text = logs.text();
    for url in [&good, &bad] {
        let token = token_of(url);
        let path = path_of(url);
        for (place, text) in [
            ("audit", audits.join("\n")),
            ("call records", events.join("\n")),
            ("logs", log_text.clone()),
            ("error body", refused.body.to_string()),
        ] {
            assert!(!text.contains(&token), "the token is in the {place}");
            assert!(!text.contains(&path), "the path is in the {place}");
        }
    }
}
