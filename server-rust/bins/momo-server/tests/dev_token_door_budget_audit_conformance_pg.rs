//! ADR-0216 — what the developer-token **door** counts and what it writes: its three
//! budgets (D9), the audit row of every admitted request, the bounded rows of a refusal,
//! and the rule that no row, log line or answer ever carries the token (R6, door side).
//! The rows of the red-proof table covered here: R13, R15 and the door half of R6, on a
//! real PostgreSQL and the real Axum router (`momo_app`, NOBYPASSRLS).
//!
//! Every "nothing happened" claim is paired, in the same test, with a request that must
//! have happened — from the same token over the same wiring — so a refusal cannot be an
//! artifact of a dead token, a dead route or a mistyped path.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_token_over_its_budget_is_told_to_wait_and_a_token_inside_it_is_served` | R13: three requests inside a budget of three → 200 with no `Retry-After`; the next ones → 429 with a `Retry-After` that is whole seconds inside the window (the rest of it, not a made-up number); only the admitted ones are recorded as use; the 429 row names the `token` axis | the token budget is dropped, the 429 has no (or a made-up) `Retry-After`, a 429 is recorded as use |
//! | `two_tokens_of_one_member_share_the_members_budget_and_another_member_is_not_touched` | R13: two tokens, each inside its own budget, whose sum passes the member's → 429 on the `member` axis (with a `Retry-After`, touching nothing); a flood refused on the token axis spends none of the member's budget; another member's token is served and limited by its own budget | the member axis is dropped or keyed on the token, a denied request still counts against the member, the member key is shared by everyone |
//! | `the_send_row_has_a_budget_of_its_own_that_reads_neither_spend_nor_feel` | R13: sends (`dev:messages:write`) are refused on the `write` axis alone, before the handler (no message stored, nothing touched), reads before and after are served, another token of the same member sends | the write axis is dropped, covers reads, or is keyed on the member |
//! | `a_send_is_counted_on_top_of_the_read_budgets_and_a_request_over_two_budgets_names_both` | R13: with two sends a token and two calls a token, the third send is one 429 whose row names both the `token` and the `write` axis, and a read right after is refused as well (a send spends the token's budget too) | the send row is counted instead of the read budgets, the row names only the first full axis |
//! | `the_budget_is_keyed_on_who_holds_the_token_not_on_the_address` | R13: one member's token is refused although every request names a different address; another member's token from the very same address is served and then has a budget of its own; the member's other token is not the spent one | the key is an address (peer or forwarded), one global bucket, or the member for a per-token budget |
//! | `a_429_writes_nothing_and_leaves_one_refusal_row_per_token` | R13/R15: a 429 leaves the token row, `last_used_at` and the use rows as they were (an admitted request moves them — the control), the whole 429 flood adds exactly one `rate_limited` row to the workspace's audit, per token, with the closed detail | a 429 reaches `finalize`/the use row, the refusal row is unbounded or global |
//! | `a_zero_or_unparsable_budget_keeps_the_default_and_never_switches_the_door_off` | R13: a zero (injected three ways: through the builder, through an env-style lookup of 0/garbage/negative/blank, straight into the state) leaves the send budget at the default 30 — the 31st is a 429 | a zero is read as "off", the config is not normalized on the way in or at use |
//! | `the_default_read_budgets_are_240_a_token_and_480_a_member` | R13: with nothing configured but the window, a token's 241st request and a member's 481st are 429s (the refused 241st cost the member nothing) | a default moves |
//! | `the_default_budgets_are_the_adrs_numbers_and_the_builder_never_stores_a_zero` | R13: `DevAccessConfig::default()` is 60 s / 240 / 480 / 30 and `with_dev_access` stores a normalized config (no database) | a default moves, the builder stores a zero |
//! | `every_admitted_request_leaves_exactly_one_used_row_that_names_the_route_template_and_nothing_else` | R15: six admitted requests of five routes → one `used` row each, `detail` is exactly `{schema, method, route, required_scope, granted}` (the `schema` tag belongs to the closed vocabulary) with the route **template**; no query, id or body text reaches any of the token's rows | a request leaves no / two rows, the raw path, query, channel id or body enters the detail |
//! | `a_request_whose_used_row_cannot_be_written_is_not_admitted_and_touches_nothing` | R15: with the use-row write failing (a trigger on this workspace only, removed even on a panic) a read and a send are refused, nothing is stored or touched and `last_used_at` stays NULL; a refusal row is unaffected; without the trigger the same requests are admitted and recorded | the use row is written outside the authentication transaction, its failure is swallowed, the touch commits without it |
//! | `a_token_revoked_while_its_request_waits_to_be_touched_leaves_no_used_row` | R15: a revoke that commits while the request waits on the token row → the unknown-token 401, no use row, no touch; the same wait ended without a revoke → 200 and both | the touch's verdict is ignored, the use row is written before or regardless of it |
//! | `scope_and_policy_refusals_leave_one_row_per_token_per_window_and_touch_nothing` | R15: five scope refusals → one `scope_denied` row (closed detail, `reason: scope`), five policy refusals after a demotion → one row (`reason: policy`), per token; neither touches `last_used_at` or the use rows (the controls are admitted before) | the slot is dropped or global, a refusal is recorded as use or touches the token |
//! | `the_two_kinds_of_refusal_row_are_bounded_separately` | R15: a token with a scope refusal on record and then over its budget has one row of each kind, and six of ten reads served (a 403 spends no budget) | the two kinds share one slot, a 403 spends budget |
//! | `a_refusal_row_is_written_again_in_a_later_window` | R15: the bound is per window — a refusal in a later window is recorded again | the bound is once per process |
//! | `a_refusal_whose_row_cannot_be_written_is_the_same_refusal_and_is_recorded_when_it_can` | D9: a failing write of a `scope_denied` row changes no byte of the 403, and the failed attempts do not use up the window's one row — the next refusal is recorded | the audit failure turns the refusal into an error, the slot is not handed back |
//! | `a_429_whose_row_cannot_be_written_is_still_a_429_and_is_recorded_when_it_can` | D9: the same for the `rate_limited` row of a 429 | as above |
//! | `a_valid_token_anywhere_but_the_bearer_header_is_not_a_credential` | R6: the same valid token in a query (`access_token`, `token`), a cookie, a JSON body, `X-Api-Key`, `X-Access-Token`, `Authorization: Token`/`Basic` → 401 the same bytes as no credential, nothing recorded or stored; as `Authorization: Bearer` it is served | the door reads a token from another place |
//! | `no_audit_row_and_no_log_line_holds_any_piece_of_a_presented_token` | R6: after 200s (one with the token in the URL as well), 401s, 403s and a 429, no row of the workspace's audit, no captured log line and no answer the client received (status line, headers, body) holds the envelope, any 8 characters of its secret, the SHA-256 of the envelope or of the secret; the same log does hold the 429 warning with the token's id, and the recorded answers hold the refusals' own words | a log line, an answer, an error or a detail carries the bearer, the request URI or a hash |
//! | `the_leak_scanner_sees_the_envelope_its_windows_and_its_hash` | the scanner above flags each form of a planted token and nothing harmless (no database) | the scanner cannot fail |
//!
//! `#[ignore]` — needs a real PostgreSQL 18 + pgvector (superuser URL); run on an isolated
//! database:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_token_door_budget_audit_conformance_pg \
//!   -- --ignored --test-threads=1
//! ```
//!
//! The log capture of the R6 test is a `tracing` default of the **test thread**: it sees the
//! server only because `#[tokio::test]` runs the server's tasks on that one thread (a
//! multi-thread flavor would capture nothing). That is not taken on trust — the test asserts
//! that the capture holds the door's 429 warning and that it names the token's id, so a
//! capture that cannot see the server fails there instead of passing an empty scan.
//!
//! The server under test is `AppState::new` plus `with_dev_access` (no agent gateway, no
//! Agent Port origin, the default rate limits): the door under test needs nothing else, and
//! every other limiter stays at its default so none of them can be the thing that answers.

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::io;
use std::net::SocketAddr;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use apps_pg::{
    ensure_schema_and_roles, momo_app_pool, seed_channel, seed_human, seed_workspace,
    superuser_pool, TEST_JWT_SECRET,
};
use base64::Engine as _;
use futures::FutureExt as _;
use momo_auth::dev_token::{
    issue_dev_card_in_tx, issue_dev_login_in_tx, DevTool, IssuedDevCard, IssuedDevLogin,
    NewDevCard, NewDevLogin, DEV_READ_ONLY_SCOPES, DEV_SCOPES, FIXED_POLICY,
};
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::sqlx::{self, Row};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::config::DevAccessConfig;
use momo_server::{build_app, AppState};
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// the oracles — written here, independently of the code under test
// ---------------------------------------------------------------------------

/// One window for every budget of this file. Long on purpose: a test that takes a minute
/// under load must not see its window turn over (the one test that wants a window to end
/// asks for a window of a second).
const WINDOW: u64 = 3600;

/// `audit_log.action` of the three rows the door writes, and the closed `schema` of each
/// (D9). Spelled out here, not imported, so a renamed action is a red test.
const USED: &str = "auth.dev_token.used";
const SCOPE_DENIED: &str = "auth.dev_token.scope_denied";
const RATE_LIMITED: &str = "auth.dev_token.rate_limited";
const USE_SCHEMA: &str = "momo.dev_token.use.v1";
const RATE_SCHEMA: &str = "momo.dev_token.rate_limit.v1";

/// The route **templates** the audit rows must name (ADR-0216 D4, L1–L7).
const T_CHANNELS: &str = "/v1/workspaces/{ws}/channels";
const T_MESSAGES: &str = "/v1/workspaces/{ws}/channels/{ch}/messages";
const T_REPLIES: &str = "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies";
const T_INBOX: &str = "/v1/workspaces/{ws}/inbox";
const T_SELF: &str = "/v1/workspaces/{ws}/dev-access/self";

/// The budgets of ADR-0216 D9 — the numbers the ADR promises when nothing is configured.
const ADR_DEFAULTS: DevAccessConfig = DevAccessConfig {
    window_seconds: 60,
    per_token_limit: 240,
    per_member_limit: 480,
    write_per_token_limit: 30,
};

/// Small budgets over a long window: `(per token, per member, sends per token)`.
fn budgets(per_token: u32, per_member: u32, write: u32) -> DevAccessConfig {
    DevAccessConfig {
        window_seconds: WINDOW,
        per_token_limit: per_token,
        per_member_limit: per_member,
        write_per_token_limit: write,
    }
}

/// What the server ships with, over the long window: the limits are the code's own
/// `DevAccessConfig::default()` (not a copy kept here), so a default that moves is felt by
/// every test that runs on it; `ADR_DEFAULTS` is the independent oracle those numbers are
/// compared to.
fn default_budgets() -> DevAccessConfig {
    DevAccessConfig {
        window_seconds: WINDOW,
        ..DevAccessConfig::default()
    }
}

/// The `detail` of a `used` row exactly as D9 closes it: five keys, the route a template.
fn used_detail(method: &str, route: &str, scope: &str) -> Value {
    json!({
        "schema": USE_SCHEMA,
        "method": method,
        "route": route,
        "required_scope": scope,
        "granted": true,
    })
}

/// The `detail` of a `scope_denied` row: the same five keys with `granted: false` and the
/// closed `reason`.
fn refused_detail(method: &str, route: &str, scope: &str, reason: &str) -> Value {
    json!({
        "schema": USE_SCHEMA,
        "method": method,
        "route": route,
        "required_scope": scope,
        "granted": false,
        "reason": reason,
    })
}

/// The `detail` of a `rate_limited` row.
fn limited_detail(method: &str, route: &str, scope: &str, axes: &[&str]) -> Value {
    json!({
        "schema": RATE_SCHEMA,
        "method": method,
        "route": route,
        "required_scope": scope,
        "axes": axes,
        "window_seconds": WINDOW,
    })
}

// ---------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------

/// What a client could tell two answers apart by: the status, the body bytes and the
/// headers that describe it.
type Fingerprint = (u16, Vec<u8>, Vec<(&'static str, Option<String>)>);

/// One answer, kept whole.
struct Reply {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn error_code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_owned)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    }

    /// `Retry-After` as whole seconds, when it is exactly that.
    fn retry_after(&self) -> Option<u64> {
        self.header("retry-after")?.trim().parse().ok()
    }

    /// The answer as one text — status, every header, the body — which is what a leak scan
    /// reads.
    fn transcript(&self) -> String {
        let mut text = format!("HTTP {}\n", self.status);
        for (name, value) in &self.headers {
            text.push_str(&format!(
                "{name}: {}\n",
                String::from_utf8_lossy(value.as_bytes())
            ));
        }
        text.push('\n');
        text.push_str(&self.text());
        text.push('\n');
        text
    }

    /// Everything a client could tell two refusals apart by (`date` and the like are left
    /// out — they differ between any two answers).
    fn fingerprint(&self) -> Fingerprint {
        let headers = [
            "content-type",
            "content-length",
            "cache-control",
            "pragma",
            "www-authenticate",
            "retry-after",
            "vary",
            "set-cookie",
        ]
        .into_iter()
        .map(|name| (name, self.header(name)))
        .collect();
        (self.status, self.body.clone(), headers)
    }
}

async fn finish(request: RequestBuilder) -> Reply {
    let response = request.send().await.expect("the server answers");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("the body is read").to_vec();
    let reply = Reply {
        status,
        headers,
        body,
    };
    if let Some(record) = ANSWERS
        .lock()
        .expect("the answer record is healthy")
        .as_mut()
    {
        record.push_str(&reply.transcript());
    }
    reply
}

/// Every answer `finish` returns while an [`AnswerRecord`] lives, as [`Reply::transcript`]s.
static ANSWERS: Mutex<Option<String>> = Mutex::new(None);

/// Records the answers of the requests made while it lives: the third haystack of the leak
/// scan (the audit and the captured log are the other two). The tests run one at a time under
/// `test_lock`, so a recording holds the requests of the test that started it and no other.
struct AnswerRecord;

impl AnswerRecord {
    fn start() -> Self {
        *ANSWERS.lock().expect("the answer record is healthy") = Some(String::new());
        AnswerRecord
    }

    fn text(&self) -> String {
        ANSWERS
            .lock()
            .expect("the answer record is healthy")
            .clone()
            .unwrap_or_default()
    }
}

impl Drop for AnswerRecord {
    fn drop(&mut self) {
        if let Ok(mut record) = ANSWERS.lock() {
            *record = None;
        }
    }
}

fn expect_status(reply: &Reply, status: u16, what: &str) {
    assert_eq!(
        reply.status,
        status,
        "{what}: expected {status}, got {} {}",
        reply.status,
        reply.text()
    );
}

fn expect_code(reply: &Reply, status: u16, code: &str, what: &str) {
    expect_status(reply, status, what);
    assert_eq!(
        reply.error_code().as_deref(),
        Some(code),
        "{what}: expected error code {code}, got {}",
        reply.text()
    );
}

// ---------------------------------------------------------------------------
// the world: a workspace, a server, people, tokens
// ---------------------------------------------------------------------------

struct World {
    /// Superuser: seeds, and reads rows RLS would hide. Asserts nothing by itself.
    su: PgPool,
    /// `momo_app` (NOBYPASSRLS): what the server under test runs on, and what the domain
    /// functions are called with.
    app: PgPool,
    base: String,
    http: Client,
    workspace: Uuid,
}

/// A developer token the test holds: its row id and its envelope.
#[derive(Clone)]
struct Card {
    id: Uuid,
    secret: String,
}

/// One audit row, as read back with the superuser.
struct AuditRow {
    actor: Option<Uuid>,
    via_token: Option<Uuid>,
    target_type: Option<String>,
    detail: Value,
}

impl World {
    /// A fresh workspace behind a server whose door has `config` for its budgets.
    async fn boot(config: DevAccessConfig) -> World {
        World::boot_with(|state| state.with_dev_access(config)).await
    }

    /// A fresh workspace behind a server whose state `shape` builds from the plain one.
    async fn boot_with(shape: impl FnOnce(AppState) -> AppState) -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let workspace = seed_workspace(&su).await;
        let state = shape(AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the server under test");
        let address: SocketAddr = listener.local_addr().expect("the server's address");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        World {
            su,
            app,
            base: format!("http://{address}"),
            http: Client::new(),
            workspace,
        }
    }

    // ---- paths ----

    fn channels_path(&self) -> String {
        format!("/v1/workspaces/{}/channels", self.workspace)
    }

    fn messages_path(&self, channel: Uuid) -> String {
        format!(
            "/v1/workspaces/{}/channels/{channel}/messages",
            self.workspace
        )
    }

    fn self_path(&self) -> String {
        format!("/v1/workspaces/{}/dev-access/self", self.workspace)
    }

    fn inbox_path(&self) -> String {
        format!("/v1/workspaces/{}/inbox", self.workspace)
    }

    // ---- people and tokens ----

    /// A person of `role` in the workspace (their app session is not used here).
    async fn person(&self, role: &str, handle: &str) -> Uuid {
        let (id, _session) = seed_human(&self.su, self.workspace, role, handle).await;
        id
    }

    async fn admin(&self, handle: &str) -> Uuid {
        self.person("admin", handle).await
    }

    async fn channel(&self, members: &[Uuid]) -> Uuid {
        seed_channel(&self.su, self.workspace, "public", members).await
    }

    /// A card of `member` with exactly `scopes` (plus `dev:identity`, which the domain adds).
    async fn card(&self, member: Uuid, scopes: &[&str]) -> Card {
        let issued = issue_card_by_function(&self.app, self.workspace, member, scopes).await;
        Card {
            id: issued.id,
            secret: issued.secret,
        }
    }

    /// A login lineage (access + refresh) of `member`.
    async fn login(&self, member: Uuid) -> IssuedDevLogin {
        let login = NewDevLogin {
            label: "달무리 터미널".to_string(),
            tool: DevTool::Cli,
            client: "oort-cli".to_string(),
            device_name: Some("달무리 노트북".to_string()),
            scopes: DEV_READ_ONLY_SCOPES
                .iter()
                .map(|scope| (*scope).to_string())
                .collect(),
            channel_ids: None,
        };
        let workspace = self.workspace;
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                Ok(issue_dev_login_in_tx(conn, workspace, member, &login, FIXED_POLICY).await?)
            })
        })
        .await
        .expect("the lineage's transaction commits")
        .expect("the domain opens a login lineage for an admin")
    }

    // ---- HTTP ----

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.http.get(self.url(path))
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.http.post(self.url(path))
    }

    async fn get_as(&self, path: &str, secret: &str) -> Reply {
        finish(self.get(path).bearer_auth(secret)).await
    }

    /// `POST …/channels/{ch}/messages` with the allowed body shape.
    async fn send_as(&self, channel: Uuid, secret: &str, text: &str) -> Reply {
        finish(
            self.post(&self.messages_path(channel))
                .bearer_auth(secret)
                .json(&json!({"clientMsgId": Uuid::new_v4(), "body": text})),
        )
        .await
    }

    // ---- the database, read back with the superuser ----

    async fn audit(&self, action: &str, token: Option<Uuid>) -> Vec<AuditRow> {
        sqlx::query(
            "SELECT actor_member_id, via_token_id, target_type, detail::text AS detail \
               FROM audit_log \
              WHERE workspace_id = $1 AND action = $2 \
                AND ($3::uuid IS NULL OR via_token_id = $3) \
              ORDER BY id",
        )
        .bind(self.workspace)
        .bind(action)
        .bind(token)
        .fetch_all(&self.su)
        .await
        .expect("read the audit rows")
        .into_iter()
        .map(|row| AuditRow {
            actor: row.try_get("actor_member_id").expect("actor"),
            via_token: row.try_get("via_token_id").expect("via token"),
            target_type: row.try_get("target_type").expect("target type"),
            detail: serde_json::from_str(&row.try_get::<String, _>("detail").expect("detail"))
                .expect("a detail is JSON"),
        })
        .collect()
    }

    async fn count_audit(&self, action: &str, token: Option<Uuid>) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_log \
              WHERE workspace_id = $1 AND action = $2 \
                AND ($3::uuid IS NULL OR via_token_id = $3)",
        )
        .bind(self.workspace)
        .bind(action)
        .bind(token)
        .fetch_one(&self.su)
        .await
        .expect("count audit rows")
    }

    async fn used_rows(&self, token: Uuid) -> i64 {
        self.count_audit(USED, Some(token)).await
    }

    /// Every row of the workspace's audit, of any action.
    async fn all_audit_rows(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1")
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect("count every audit row")
    }

    /// Every audit row of the workspace as one JSON text — what a leak scan reads.
    async fn audit_text(&self) -> String {
        sqlx::query_scalar(
            "SELECT coalesce(string_agg(to_jsonb(a)::text, E'\\n' ORDER BY a.id), '') \
               FROM audit_log a WHERE a.workspace_id = $1",
        )
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("read the audit as text")
    }

    /// The `detail` text of the door's own rows (`auth.dev_token.*`).
    async fn door_detail_text(&self, token: Uuid) -> String {
        sqlx::query_scalar(
            "SELECT coalesce(string_agg(detail::text, E'\\n'), '') \
               FROM audit_log \
              WHERE workspace_id = $1 AND via_token_id = $2 AND action LIKE 'auth.dev_token.%'",
        )
        .bind(self.workspace)
        .bind(token)
        .fetch_one(&self.su)
        .await
        .expect("read the door's detail text")
    }

    /// `last_used_at` in microseconds since the epoch (`None`: never used).
    async fn last_used(&self, token: Uuid) -> Option<i64> {
        sqlx::query_scalar(
            "SELECT (extract(epoch FROM last_used_at) * 1000000)::bigint \
               FROM token WHERE id = $1",
        )
        .bind(token)
        .fetch_one(&self.su)
        .await
        .expect("read last_used_at")
    }

    /// Make `last_used_at` two hours old, so that an admitted request is *due* to touch it
    /// (the door touches at most once a minute) — and a request that touches nothing leaves
    /// the marker standing. Returns the marker.
    async fn age_last_used(&self, token: Uuid) -> i64 {
        sqlx::query_scalar(
            "UPDATE token SET last_used_at = now() - interval '2 hours' WHERE id = $1 \
             RETURNING (extract(epoch FROM last_used_at) * 1000000)::bigint",
        )
        .bind(token)
        .fetch_one(&self.su)
        .await
        .expect("age last_used_at")
    }

    /// The whole token row as JSON text: equal before and after means nothing was written.
    async fn token_row(&self, token: Uuid) -> String {
        sqlx::query_scalar("SELECT to_jsonb(t)::text FROM token t WHERE t.id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("read the token row")
    }

    async fn revoke(&self, token: Uuid) {
        sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
            .bind(token)
            .execute(&self.su)
            .await
            .expect("revoke the token row");
    }

    async fn message_count(&self, channel: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM message WHERE workspace_id = $1 AND channel_id = $2",
        )
        .bind(self.workspace)
        .bind(channel)
        .fetch_one(&self.su)
        .await
        .expect("count messages")
    }
}

/// `issue_dev_card_in_tx` as the issuing route calls it, in a tenant transaction on `momo_app`.
async fn issue_card_by_function(
    app: &PgPool,
    workspace: Uuid,
    member: Uuid,
    scopes: &[&str],
) -> IssuedDevCard {
    let card = NewDevCard {
        label: format!("달무리 노트북 {}", Uuid::new_v4().simple()),
        tool: DevTool::ClaudeCode,
        scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
        channel_ids: None,
        expires_in_days: 30,
    };
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            Ok(issue_dev_card_in_tx(conn, workspace, member, &card, FIXED_POLICY).await?)
        })
    })
    .await
    .expect("the card's transaction commits")
    .expect("the domain issues a card for an owner or admin")
}

/// Poll `condition` until it holds. A condition wait, never a blind sleep: the deadline is
/// only the point at which a test that can never be satisfied fails instead of hanging.
async fn wait_until<F, Fut>(what: &str, mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if condition().await {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

// ---------------------------------------------------------------------------
// R13 — the budgets
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_token_over_its_budget_is_told_to_wait_and_a_token_inside_it_is_served() {
    let _serial = test_lock().await;
    let world = World::boot(budgets(3, 100, 50)).await;
    let member = world.admin("lee-dohyeon").await;
    let token = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();

    // Inside the budget: served, and nothing asks the client to wait.
    for call in 1..=3 {
        let reply = world.get_as(&channels, &token.secret).await;
        expect_status(&reply, 200, &format!("call {call} is inside a budget of 3"));
        assert_eq!(
            reply.header("retry-after"),
            None,
            "an admitted request carries no Retry-After"
        );
    }

    // Over it: 429, and the wait is whole seconds inside the window — the oldest counted
    // request left to age out, not a made-up number.
    for call in 4..=6 {
        let reply = world.get_as(&channels, &token.secret).await;
        expect_status(&reply, 429, &format!("call {call} is over a budget of 3"));
        let wait = reply.retry_after().unwrap_or_else(|| {
            panic!("a 429 names its wait in whole seconds: {:?}", reply.headers)
        });
        assert!(
            (WINDOW - 120..=WINDOW).contains(&wait),
            "Retry-After {wait} is not the rest of a {WINDOW} s window opened a moment ago"
        );
    }

    // Only what the door admitted is use.
    assert_eq!(world.used_rows(token.id).await, 3);
    // The 429 is the door's own: it left its row, naming the one axis that was full.
    let refusals = world.audit(RATE_LIMITED, Some(token.id)).await;
    assert_eq!(refusals.len(), 1, "one refusal row for the whole flood");
    assert_eq!(
        refusals[0].detail,
        limited_detail("GET", T_CHANNELS, "dev:channels:read", &["token"])
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_tokens_of_one_member_share_the_members_budget_and_another_member_is_not_touched() {
    let _serial = test_lock().await;
    // Three a token, five a member: two tokens can each be inside their own budget and
    // still, together, pass the member's.
    let world = World::boot(budgets(3, 5, 50)).await;
    let dohyeon = world.admin("lee-dohyeon").await;
    let seoyeon = world.admin("park-seoyeon").await;
    let first = world.card(dohyeon, &DEV_READ_ONLY_SCOPES).await;
    let second = world.card(dohyeon, &DEV_READ_ONLY_SCOPES).await;
    let other = world.card(seoyeon, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();

    for call in 1..=3 {
        let reply = world.get_as(&channels, &first.secret).await;
        expect_status(&reply, 200, &format!("first token, call {call} of 3"));
    }
    // The first token's own budget is spent. Its refusals are a token-axis matter and
    // must cost the member nothing: a request is admitted on every axis or counted on none.
    for call in 4..=5 {
        let reply = world.get_as(&channels, &first.secret).await;
        expect_status(&reply, 429, &format!("first token, call {call}"));
    }
    let first_refusals = world.audit(RATE_LIMITED, Some(first.id)).await;
    assert_eq!(first_refusals.len(), 1);
    assert_eq!(first_refusals[0].detail["axes"], json!(["token"]));

    // The member has used 3 of 5. The second token is inside its own budget (it has used
    // nothing) for two requests — which is the member's two that are left — and refused for
    // the third although its token budget has one more call in it.
    for call in 1..=2 {
        let reply = world.get_as(&channels, &second.secret).await;
        expect_status(
            &reply,
            200,
            &format!("second token, call {call}: the member's budget still has room (the first token's refusals cost it nothing)"),
        );
    }
    // Due for a touch, so that a refusal that reached it would show.
    let marker = world.age_last_used(second.id).await;
    let row_before = world.token_row(second.id).await;
    let audit_before = world.all_audit_rows().await;
    let over = world.get_as(&channels, &second.secret).await;
    expect_status(
        &over,
        429,
        "second token, call 3: the member's budget of 5 is spent",
    );
    assert!(
        over.retry_after()
            .is_some_and(|wait| (1..=WINDOW).contains(&wait)),
        "the member axis answers with a Retry-After too: {:?}",
        over.headers
    );
    assert_eq!(
        world.last_used(second.id).await,
        Some(marker),
        "a refusal on the member axis touches nothing either"
    );
    assert_eq!(world.token_row(second.id).await, row_before);
    assert_eq!(
        world.all_audit_rows().await,
        audit_before + 1,
        "the refusal's own row and nothing else"
    );
    let second_refusals = world.audit(RATE_LIMITED, Some(second.id)).await;
    assert_eq!(second_refusals.len(), 1);
    assert_eq!(
        second_refusals[0].detail["axes"],
        json!(["member"]),
        "only the member axis was full for the second token"
    );
    assert_eq!(world.used_rows(second.id).await, 2);

    // Another member is another budget: served now, while the first member's is spent, and
    // then limited by a budget of its own.
    for call in 1..=3 {
        let reply = world.get_as(&channels, &other.secret).await;
        expect_status(&reply, 200, &format!("another member's token, call {call}"));
    }
    let other_over = world.get_as(&channels, &other.secret).await;
    expect_status(
        &other_over,
        429,
        "another member's token has a budget of its own",
    );
    assert_eq!(world.used_rows(first.id).await, 3);
    assert_eq!(world.used_rows(other.id).await, 3);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_send_row_has_a_budget_of_its_own_that_reads_neither_spend_nor_feel() {
    let _serial = test_lock().await;
    // Two sends a token inside a large read budget.
    let world = World::boot(budgets(50, 100, 2)).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let writer = world.card(member, &DEV_SCOPES).await;
    let other_writer = world.card(member, &DEV_SCOPES).await;
    let channels = world.channels_path();

    // Reads do not spend the send budget: five of them, then the two sends it allows.
    for call in 1..=5 {
        let reply = world.get_as(&channels, &writer.secret).await;
        expect_status(&reply, 200, &format!("read {call}"));
    }
    for call in 1..=2 {
        let reply = world
            .send_as(channel, &writer.secret, "첫 보고서 초안")
            .await;
        expect_status(&reply, 201, &format!("send {call} of 2"));
    }
    assert_eq!(world.message_count(channel).await, 2);

    // The third send is refused on the send axis alone, before the handler: nothing stored,
    // nothing touched (the token is made due for a touch first, so a refusal that reached
    // it would show).
    let marker = world.age_last_used(writer.id).await;
    let row_before = world.token_row(writer.id).await;
    let audit_before = world.all_audit_rows().await;
    let refused = world.send_as(channel, &writer.secret, "세 번째 글").await;
    expect_status(&refused, 429, "the third send is over the send budget");
    assert!(
        refused
            .retry_after()
            .is_some_and(|wait| (1..=WINDOW).contains(&wait)),
        "a refused send names its wait: {:?}",
        refused.headers
    );
    assert_eq!(
        world.message_count(channel).await,
        2,
        "a refused send never reached the handler"
    );
    assert_eq!(
        world.last_used(writer.id).await,
        Some(marker),
        "a refusal on the send axis touches nothing either"
    );
    assert_eq!(world.token_row(writer.id).await, row_before);
    assert_eq!(
        world.all_audit_rows().await,
        audit_before + 1,
        "the refusal's own row and nothing else"
    );
    let rows = world.audit(RATE_LIMITED, Some(writer.id)).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].detail,
        limited_detail("POST", T_MESSAGES, "dev:messages:write", &["write"]),
        "the send budget alone was full"
    );

    // The send budget does not reach the reads of the same token ...
    for call in 1..=3 {
        let reply = world.get_as(&channels, &writer.secret).await;
        expect_status(
            &reply,
            200,
            &format!("read {call} after the send budget ran out"),
        );
    }
    // ... and it is the token's, not the member's: another token of the same member sends.
    let reply = world
        .send_as(channel, &other_writer.secret, "다른 카드로 쓴 글")
        .await;
    expect_status(&reply, 201, "another token's send budget is its own");
    assert_eq!(world.message_count(channel).await, 3);
    // Reads count as use (8 reads, 2 sends) and the refused send does not.
    assert_eq!(world.used_rows(writer.id).await, 10);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_send_is_counted_on_top_of_the_read_budgets_and_a_request_over_two_budgets_names_both() {
    let _serial = test_lock().await;
    // Two sends a token and two calls a token: the two sends are the token's whole budget
    // and the send row's whole budget at once.
    let world = World::boot(budgets(2, 100, 2)).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let writer = world.card(member, &DEV_SCOPES).await;

    for call in 1..=2 {
        let reply = world.send_as(channel, &writer.secret, "점검 기록").await;
        expect_status(&reply, 201, &format!("send {call} of 2"));
    }
    // The third send is over both budgets: one 429, one row, and the row names both axes.
    // (Were the send row counted instead of the read budgets, only `write` would be full.)
    let refused = world.send_as(channel, &writer.secret, "세 번째 글").await;
    expect_status(&refused, 429, "the third send is over both its budgets");
    assert_eq!(world.message_count(channel).await, 2);
    let rows = world.audit(RATE_LIMITED, Some(writer.id)).await;
    assert_eq!(rows.len(), 1, "one refusal row");
    assert_eq!(
        rows[0].detail,
        limited_detail(
            "POST",
            T_MESSAGES,
            "dev:messages:write",
            &["token", "write"]
        ),
        "every full axis is named"
    );
    // The sends spent the token's budget for reads as well: the next read is refused too.
    expect_status(
        &world.get_as(&world.channels_path(), &writer.secret).await,
        429,
        "a read after two sends: the token's budget of two is spent",
    );
    assert_eq!(world.used_rows(writer.id).await, 2);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_budget_is_keyed_on_who_holds_the_token_not_on_the_address() {
    let _serial = test_lock().await;
    let world = World::boot(budgets(3, 100, 50)).await;
    let dohyeon = world.admin("lee-dohyeon").await;
    let seoyeon = world.admin("park-seoyeon").await;
    let spent = world.card(dohyeon, &DEV_READ_ONLY_SCOPES).await;
    let spent_too = world.card(dohyeon, &DEV_READ_ONLY_SCOPES).await;
    let neighbour = world.card(seoyeon, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();

    // One token, a different claimed address on every request: the budget is still its own.
    for call in 1..=5 {
        let reply = finish(
            world
                .get(&channels)
                .bearer_auth(&spent.secret)
                .header("x-forwarded-for", format!("203.0.113.{call}"))
                .header("x-real-ip", format!("198.51.100.{call}")),
        )
        .await;
        let expected = if call <= 3 { 200 } else { 429 };
        expect_status(
            &reply,
            expected,
            &format!("call {call} of a budget of 3, from a new address each time"),
        );
    }

    // The very same peer address, another member: served, and then limited by its own
    // budget — so the 200s are not the work of a door that stopped counting.
    for call in 1..=3 {
        let reply = world.get_as(&channels, &neighbour.secret).await;
        expect_status(
            &reply,
            200,
            &format!("another member's token, call {call}, while the first member's is spent"),
        );
    }
    let over = world.get_as(&channels, &neighbour.secret).await;
    expect_status(&over, 429, "another member's token has a budget of its own");

    // A second token of the first member is not the spent token either.
    for call in 1..=3 {
        let reply = world.get_as(&channels, &spent_too.secret).await;
        expect_status(
            &reply,
            200,
            &format!("the member's other token, call {call}"),
        );
    }
    assert_eq!(world.used_rows(spent.id).await, 3);
    assert_eq!(world.used_rows(spent_too.id).await, 3);
    assert_eq!(world.used_rows(neighbour.id).await, 3);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_429_writes_nothing_and_leaves_one_refusal_row_per_token() {
    let _serial = test_lock().await;
    let world = World::boot(budgets(2, 100, 50)).await;
    let member = world.admin("lee-dohyeon").await;
    let token = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let other = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();

    // The control: an admitted request writes a use row and moves `last_used_at` (never
    // used → used; then, once it is due, forward).
    assert_eq!(
        world.last_used(token.id).await,
        None,
        "a fresh token was never used"
    );
    expect_status(
        &world.get_as(&channels, &token.secret).await,
        200,
        "first call",
    );
    assert_eq!(world.used_rows(token.id).await, 1);
    assert!(
        world.last_used(token.id).await.is_some(),
        "an admitted request touches last_used_at"
    );
    let aged = world.age_last_used(token.id).await;
    expect_status(
        &world.get_as(&channels, &token.secret).await,
        200,
        "second call",
    );
    assert_eq!(world.used_rows(token.id).await, 2);
    let touched = world
        .last_used(token.id)
        .await
        .expect("an admitted request touches last_used_at");
    assert!(
        touched > aged + 3_600_000_000,
        "an admitted request that is due moves last_used_at forward ({aged} -> {touched})"
    );

    // Now the budget of 2 is spent. Age the marker again: a 429 that reached the touch
    // would move it.
    let marker = world.age_last_used(token.id).await;
    let row_before = world.token_row(token.id).await;
    let audit_before = world.all_audit_rows().await;
    for call in 3..=7 {
        let reply = world.get_as(&channels, &token.secret).await;
        expect_status(&reply, 429, &format!("call {call} is over a budget of 2"));
        assert_eq!(
            world.used_rows(token.id).await,
            2,
            "a 429 is not use (after call {call})"
        );
        assert_eq!(
            world.last_used(token.id).await,
            Some(marker),
            "a 429 does not touch last_used_at (after call {call})"
        );
        assert_eq!(
            world.token_row(token.id).await,
            row_before,
            "a 429 changes no column of the token row (after call {call})"
        );
    }
    // The whole flood left exactly one row in the workspace's audit: the bounded refusal.
    assert_eq!(world.all_audit_rows().await, audit_before + 1);
    let rows = world.audit(RATE_LIMITED, Some(token.id)).await;
    assert_eq!(rows.len(), 1, "one refusal row per token per window");
    assert_eq!(
        rows[0].detail,
        limited_detail("GET", T_CHANNELS, "dev:channels:read", &["token"])
    );
    assert_eq!(rows[0].actor, Some(member));
    assert_eq!(rows[0].via_token, Some(token.id));
    assert_eq!(rows[0].target_type.as_deref(), Some("route"));
    assert_eq!(world.count_audit(SCOPE_DENIED, None).await, 0);

    // The bound is per token: another token's flood leaves its own single row.
    for call in 1..=2 {
        expect_status(
            &world.get_as(&channels, &other.secret).await,
            200,
            &format!("the other token, call {call}"),
        );
    }
    for call in 3..=5 {
        expect_status(
            &world.get_as(&channels, &other.secret).await,
            429,
            &format!("the other token, call {call}"),
        );
    }
    assert_eq!(world.audit(RATE_LIMITED, Some(other.id)).await.len(), 1);
    assert_eq!(world.count_audit(RATE_LIMITED, None).await, 2);
}

/// Thirty sends are served and the thirty-first is a 429 — the ADR's default, found by
/// behavior, on whatever `world`'s door was handed.
async fn thirty_sends_are_served_and_the_next_is_refused(world: &World, what: &str) {
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let token = world.card(member, &DEV_SCOPES).await;
    for call in 1..=30 {
        let reply = world.send_as(channel, &token.secret, "점검 기록").await;
        expect_status(
            &reply,
            201,
            &format!("{what}: send {call} of the default 30"),
        );
    }
    let refused = world.send_as(channel, &token.secret, "서른한 번째").await;
    expect_status(&refused, 429, &format!("{what}: the 31st send"));
    assert!(
        refused.retry_after().is_some(),
        "{what}: a 429 names its wait"
    );
    assert_eq!(world.message_count(channel).await, 30, "{what}");
    let rows = world.audit(RATE_LIMITED, Some(token.id)).await;
    assert_eq!(rows.len(), 1, "{what}: the door's own refusal row");
    assert_eq!(
        rows[0].detail["axes"],
        json!(["write"]),
        "{what}: the send axis refused it"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_zero_or_unparsable_budget_keeps_the_default_and_never_switches_the_door_off() {
    let _serial = test_lock().await;

    // (1) A zero handed to the builder, on every knob but the window.
    let zeros = DevAccessConfig {
        window_seconds: WINDOW,
        per_token_limit: 0,
        per_member_limit: 0,
        write_per_token_limit: 0,
    };
    thirty_sends_are_served_and_the_next_is_refused(
        &World::boot(zeros).await,
        "zeros through the builder",
    )
    .await;

    // (2) What an environment can hand it: every value that is not a positive number.
    for raw in ["0", "abc", "-5", ""] {
        let config = DevAccessConfig::from_lookup(|key| {
            Some(if key.ends_with("WINDOW_SECONDS") {
                WINDOW.to_string()
            } else {
                raw.to_string()
            })
        });
        assert_eq!(
            config,
            DevAccessConfig {
                window_seconds: WINDOW,
                ..ADR_DEFAULTS
            },
            "{raw:?} keeps every default"
        );
        thirty_sends_are_served_and_the_next_is_refused(
            &World::boot(config).await,
            &format!("env value {raw:?}"),
        )
        .await;
    }

    // (3) A state built by hand that skips the builder: the door normalizes at use as well.
    let world = World::boot_with(|mut state| {
        state.dev_access = Arc::new(zeros);
        state
    })
    .await;
    thirty_sends_are_served_and_the_next_is_refused(
        &world,
        "zeros written straight into the state",
    )
    .await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_default_read_budgets_are_240_a_token_and_480_a_member() {
    let _serial = test_lock().await;
    // Nothing configured but the window: the limits are the code's own defaults, and the
    // calls below are the ADR's numbers.
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let first = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let second = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let third = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let whoami = world.self_path();

    for call in 1..=240 {
        let reply = world.get_as(&whoami, &first.secret).await;
        assert_eq!(reply.status, 200, "token call {call} of the default 240");
    }
    let over = world.get_as(&whoami, &first.secret).await;
    expect_status(&over, 429, "the 241st call of one token");
    assert_eq!(
        world.audit(RATE_LIMITED, Some(first.id)).await[0].detail["axes"],
        json!(["token"])
    );

    // 240 more from a second token make the member's 480; the refused 241st above cost
    // the member nothing.
    for call in 1..=240 {
        let reply = world.get_as(&whoami, &second.secret).await;
        assert_eq!(
            reply.status,
            200,
            "second token, call {call}: the member is at {}",
            240 + call
        );
    }
    let over = world.get_as(&whoami, &third.secret).await;
    expect_status(
        &over,
        429,
        "a third token of the member whose 480 are spent",
    );
    assert_eq!(
        world.audit(RATE_LIMITED, Some(third.id)).await[0].detail["axes"],
        json!(["member"])
    );
    assert_eq!(world.used_rows(third.id).await, 0);
}

#[tokio::test]
async fn the_default_budgets_are_the_adrs_numbers_and_the_builder_never_stores_a_zero() {
    assert_eq!(
        DevAccessConfig::default(),
        ADR_DEFAULTS,
        "ADR-0216 D9: 240 a token, 480 a member, 30 sends a token, a window of 60 s"
    );
    // The builder stores a normalized config: zeros become the default, a real number stays.
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_dev_access(DevAccessConfig {
        window_seconds: 0,
        per_token_limit: 0,
        per_member_limit: 7,
        write_per_token_limit: 0,
    });
    assert_eq!(
        *state.dev_access,
        DevAccessConfig {
            window_seconds: 60,
            per_token_limit: 240,
            per_member_limit: 7,
            write_per_token_limit: 30,
        }
    );
    // And what nobody configured at all is the default.
    let untouched = AppState::new(
        PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials"),
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    assert_eq!(*untouched.dev_access, ADR_DEFAULTS);
}

// ---------------------------------------------------------------------------
// R15 — the audit
// ---------------------------------------------------------------------------

/// A message body that must never be found in an audit row.
const BODY_CANARY: &str = "분기 보고서 초안 — 비공개 메모 7f3a";

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn every_admitted_request_leaves_exactly_one_used_row_that_names_the_route_template_and_nothing_else(
) {
    let _serial = test_lock().await;
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let token = world.card(member, &DEV_SCOPES).await;
    let ws = world.workspace;

    // (method, template, scope) of every request below, in order.
    let mut expected: Vec<(&str, &str, &str)> = Vec::new();
    let mut admitted = 0_i64;
    macro_rules! admit {
        ($reply:expr, $status:expr, $method:expr, $template:expr, $scope:expr) => {{
            let reply: Reply = $reply;
            expect_status(&reply, $status, &format!("{} {}", $method, $template));
            admitted += 1;
            expected.push(($method, $template, $scope));
            assert_eq!(
                world.used_rows(token.id).await,
                admitted,
                "exactly one use row per admitted request (after {} {})",
                $method,
                $template
            );
            reply
        }};
    }

    admit!(
        world.get_as(&world.channels_path(), &token.secret).await,
        200,
        "GET",
        T_CHANNELS,
        "dev:channels:read"
    );
    // A query string and a channel id in the path: neither may reach the row.
    admit!(
        world
            .get_as(
                &format!("{}?limit=3", world.messages_path(channel)),
                &token.secret
            )
            .await,
        200,
        "GET",
        T_MESSAGES,
        "dev:messages:read"
    );
    admit!(
        world.get_as(&world.inbox_path(), &token.secret).await,
        200,
        "GET",
        T_INBOX,
        "dev:inbox:read"
    );
    admit!(
        world.get_as(&world.self_path(), &token.secret).await,
        200,
        "GET",
        T_SELF,
        "dev:identity"
    );
    let sent = admit!(
        world.send_as(channel, &token.secret, BODY_CANARY).await,
        201,
        "POST",
        T_MESSAGES,
        "dev:messages:write"
    );
    let root: Uuid = sent.json()["id"]
        .as_str()
        .and_then(|id| id.parse().ok())
        .expect("the 201 names the message");
    admit!(
        world
            .get_as(
                &format!("{}/{root}/replies?limit=2", world.messages_path(channel)),
                &token.secret
            )
            .await,
        200,
        "GET",
        T_REPLIES,
        "dev:messages:read"
    );

    // The rows: one per request, each exactly the closed vocabulary.
    let mut rows = world.audit(USED, Some(token.id)).await;
    assert_eq!(rows.len(), expected.len());
    rows.sort_by_key(|row| {
        (
            row.detail["method"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            row.detail["route"].as_str().unwrap_or_default().to_string(),
        )
    });
    expected.sort_unstable();
    for (row, (method, route, scope)) in rows.iter().zip(&expected) {
        assert_eq!(
            row.detail,
            used_detail(method, route, scope),
            "the row of {method} {route}: five keys, a template, granted"
        );
        assert_eq!(row.actor, Some(member), "{method} {route}");
        assert_eq!(row.via_token, Some(token.id), "{method} {route}");
        assert_eq!(
            row.target_type.as_deref(),
            Some("route"),
            "{method} {route}"
        );
    }

    // Nothing of the request survived into the door's rows: not the query, not an id of
    // the path (the workspace's, the channel's, the thread root's), not the body.
    let text = world.door_detail_text(token.id).await;
    for (what, needle) in [
        ("the query", "limit".to_string()),
        ("the channel id", channel.to_string()),
        ("the workspace id", ws.to_string()),
        ("the thread root id", root.to_string()),
        ("the message body", BODY_CANARY.to_string()),
        ("the message body (head)", "분기 보고서".to_string()),
    ] {
        assert!(
            !text.contains(&needle),
            "the door's rows hold {what}: {text}"
        );
    }
    // The control for the scan above: the rows do hold what they are meant to.
    assert!(text.contains("{ws}") && text.contains("{ch}") && text.contains("{root}"));
}

/// A `BEFORE INSERT` trigger on `audit_log` that fails every row of one `action` **of one
/// workspace** — the injected failure of a single audit write. Named after the workspace, so
/// a trigger left behind by a run that was killed can only ever touch a workspace nobody
/// uses again.
struct AuditWriteFailure {
    su: PgPool,
    name: String,
    workspace: Uuid,
    action: &'static str,
}

impl AuditWriteFailure {
    /// `tag` is a short word that keeps the object names of different failures apart.
    fn of(world: &World, tag: &str, action: &'static str) -> Self {
        AuditWriteFailure {
            su: world.su.clone(),
            name: format!("dev_audit_failure_{tag}_{}", world.workspace.simple()),
            workspace: world.workspace,
            action,
        }
    }

    async fn install(&self) {
        let (name, workspace, action) = (&self.name, self.workspace, self.action);
        sqlx::query(&format!(
            "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $body$ \
             BEGIN RAISE EXCEPTION 'injected failure of an audit write'; END $body$"
        ))
        .execute(&self.su)
        .await
        .expect("create the failing function");
        sqlx::query(&format!(
            "CREATE TRIGGER {name} BEFORE INSERT ON audit_log FOR EACH ROW \
             WHEN (NEW.action = '{action}' AND NEW.workspace_id = '{workspace}') \
             EXECUTE FUNCTION {name}()"
        ))
        .execute(&self.su)
        .await
        .expect("create the failing trigger");
    }

    /// Idempotent: the trigger first, then the function.
    async fn remove(&self) {
        let name = &self.name;
        sqlx::query(&format!("DROP TRIGGER IF EXISTS {name} ON audit_log"))
            .execute(&self.su)
            .await
            .expect("drop the failing trigger");
        sqlx::query(&format!("DROP FUNCTION IF EXISTS {name}()"))
            .execute(&self.su)
            .await
            .expect("drop the failing function");
    }

    /// Run `body` with the failure installed, and take it out again whether `body` finished
    /// or a claim in it panicked (the panic is then re-raised).
    async fn around<T>(&self, body: impl std::future::Future<Output = T>) -> T {
        let outcome = AssertUnwindSafe(async {
            self.install().await;
            body.await
        })
        .catch_unwind()
        .await;
        self.remove().await;
        match outcome {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_request_whose_used_row_cannot_be_written_is_not_admitted_and_touches_nothing() {
    let _serial = test_lock().await;
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    // Never used: its `last_used_at` is NULL, so "stays NULL" is a fact a touch would break.
    let fresh = world.card(member, &DEV_SCOPES).await;
    let reader = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    assert_eq!(world.last_used(fresh.id).await, None);
    let row_before = world.token_row(fresh.id).await;

    AuditWriteFailure::of(&world, "used", USED)
        .around(async {
            // A read and a send, both with a use row that cannot be written: neither is admitted.
            let read = world.get_as(&world.channels_path(), &fresh.secret).await;
            assert!(
                read.status >= 400,
                "a request whose use row fails must not be served: {} {}",
                read.status,
                read.text()
            );
            assert!(
                !read.text().contains("injected"),
                "the database's words do not reach the client: {}",
                read.text()
            );
            let send = world.send_as(channel, &fresh.secret, BODY_CANARY).await;
            assert!(
                send.status >= 400,
                "a send whose use row fails must not be served: {} {}",
                send.status,
                send.text()
            );
            // Nothing the request would have done, and nothing of the door's touch, stands:
            // the use row and `last_used_at` are both absent.
            assert_eq!(
                world.message_count(channel).await,
                0,
                "the handler was never reached"
            );
            assert_eq!(world.used_rows(fresh.id).await, 0);
            assert_eq!(
                world.last_used(fresh.id).await,
                None,
                "the touch rolled back with the row that could not be written"
            );
            assert_eq!(world.token_row(fresh.id).await, row_before);

            // The failure is the use row's alone: a refusal of the same workspace is still
            // answered and still recorded (a refusal row is not part of authentication).
            let refused = world.send_as(channel, &reader.secret, BODY_CANARY).await;
            expect_code(
                &refused,
                403,
                "dev_scope_denied",
                "a refusal under the injected failure",
            );
            assert_eq!(world.count_audit(SCOPE_DENIED, Some(reader.id)).await, 1);
        })
        .await;

    // The control: with the failure gone, the same requests are admitted — and each leaves
    // its row and its touch together.
    expect_status(
        &world.get_as(&world.channels_path(), &fresh.secret).await,
        200,
        "the same read without the failure",
    );
    assert_eq!(world.used_rows(fresh.id).await, 1);
    assert!(
        world.last_used(fresh.id).await.is_some(),
        "the admitted request touched last_used_at"
    );
    expect_status(
        &world.send_as(channel, &fresh.secret, BODY_CANARY).await,
        201,
        "the same send without the failure",
    );
    assert_eq!(world.used_rows(fresh.id).await, 2);
    assert_eq!(world.message_count(channel).await, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refusal_whose_row_cannot_be_written_is_the_same_refusal_and_is_recorded_when_it_can() {
    let _serial = test_lock().await;
    // Wide enough that the budget is not what refuses; the window is one hour, so a refusal
    // slot handed out once stays handed out unless the failed write gives it back.
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let reader = world.card(member, &DEV_READ_ONLY_SCOPES).await;

    // A scope refusal, then a policy refusal, each with its own row failing to be written.
    let during = AuditWriteFailure::of(&world, "scope", SCOPE_DENIED)
        .around(async {
            let mut answers = Vec::new();
            for call in 1..=3 {
                let reply = world.send_as(channel, &reader.secret, BODY_CANARY).await;
                expect_code(
                    &reply,
                    403,
                    "dev_scope_denied",
                    &format!("refusal {call}: a failing audit write changes no answer"),
                );
                assert_eq!(
                    world.count_audit(SCOPE_DENIED, Some(reader.id)).await,
                    0,
                    "nothing could be written (refusal {call})"
                );
                answers.push(reply.fingerprint());
            }
            answers
        })
        .await;
    assert!(
        during.windows(2).all(|pair| pair[0] == pair[1]),
        "the three refusals are one answer"
    );
    // The database allows it again: the very next refusal is the same answer, and it is
    // recorded — the failed attempts did not use up the window's one row.
    let after = world.send_as(channel, &reader.secret, BODY_CANARY).await;
    assert_eq!(
        after.fingerprint(),
        during[0],
        "the refusal is the same bytes whether or not its row could be written"
    );
    assert_eq!(
        world.count_audit(SCOPE_DENIED, Some(reader.id)).await,
        1,
        "the first refusal after the failure leaves the window's row"
    );
    for _ in 0..2 {
        expect_code(
            &world.send_as(channel, &reader.secret, BODY_CANARY).await,
            403,
            "dev_scope_denied",
            "a later refusal",
        );
    }
    assert_eq!(
        world.count_audit(SCOPE_DENIED, Some(reader.id)).await,
        1,
        "and it stays the window's one row"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_429_whose_row_cannot_be_written_is_still_a_429_and_is_recorded_when_it_can() {
    let _serial = test_lock().await;
    let world = World::boot(budgets(1, 100, 50)).await;
    let member = world.admin("lee-dohyeon").await;
    let token = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();
    expect_status(
        &world.get_as(&channels, &token.secret).await,
        200,
        "the one call the budget allows",
    );

    let body_during = AuditWriteFailure::of(&world, "rate", RATE_LIMITED)
        .around(async {
            let mut bodies = Vec::new();
            for call in 1..=3 {
                let reply = world.get_as(&channels, &token.secret).await;
                expect_status(
                    &reply,
                    429,
                    &format!("refusal {call}: a failing audit write changes no answer"),
                );
                assert!(reply.retry_after().is_some(), "the wait is still named");
                assert_eq!(
                    world.count_audit(RATE_LIMITED, Some(token.id)).await,
                    0,
                    "nothing could be written (refusal {call})"
                );
                bodies.push(reply.body.clone());
            }
            bodies
        })
        .await;
    assert!(body_during.windows(2).all(|pair| pair[0] == pair[1]));

    let after = world.get_as(&channels, &token.secret).await;
    expect_status(&after, 429, "the first refusal once the database allows it");
    assert_eq!(after.body, body_during[0], "the same body");
    assert_eq!(
        world.count_audit(RATE_LIMITED, Some(token.id)).await,
        1,
        "the failed attempts did not use up the window's one row"
    );
    expect_status(
        &world.get_as(&channels, &token.secret).await,
        429,
        "a later refusal",
    );
    assert_eq!(world.count_audit(RATE_LIMITED, Some(token.id)).await, 1);
    // Throughout, the token was admitted exactly once.
    assert_eq!(world.used_rows(token.id).await, 1);
}

/// Hold a row lock on `token` from a superuser transaction: whoever wants to write the row
/// (the door's touch) waits until the transaction ends.
async fn hold_token_row(world: &World, token: Uuid) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut held = world
        .su
        .begin()
        .await
        .expect("begin the holding transaction");
    sqlx::query("SELECT id FROM token WHERE id = $1 FOR NO KEY UPDATE")
        .bind(token)
        .fetch_one(&mut *held)
        .await
        .expect("lock the token row");
    held
}

/// Whether some `momo_app` session is waiting on a lock — the server's request, blocked on
/// the row `hold_token_row` holds.
async fn a_request_is_waiting_on_a_lock(world: &World) -> bool {
    let waiting: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity \
          WHERE datname = current_database() AND usename = 'momo_app' \
            AND wait_event_type = 'Lock'",
    )
    .fetch_one(&world.su)
    .await
    .expect("read pg_stat_activity");
    waiting > 0
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_token_revoked_while_its_request_waits_to_be_touched_leaves_no_used_row() {
    let _serial = test_lock().await;
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let released = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let revoked = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let unknown = format!("momo_dev_v1.{}.{}", world.workspace, "z".repeat(43));
    let channels = world.channels_path();
    let unknown_answer = world.get_as(&channels, &unknown).await;
    expect_status(&unknown_answer, 401, "a token the server does not know");

    for (token, ends_in_a_revoke) in [(&released, false), (&revoked, true)] {
        let which = if ends_in_a_revoke {
            "revoked"
        } else {
            "released"
        };
        // Warm up: the token works, and its touch is then due again.
        expect_status(&world.get_as(&channels, &token.secret).await, 200, which);
        assert_eq!(world.used_rows(token.id).await, 1, "{which}");
        let marker = world.age_last_used(token.id).await;

        // A request that resolves the token and then waits for the row the touch must write.
        let mut held = hold_token_row(&world, token.id).await;
        let request = tokio::spawn({
            let http = world.http.clone();
            let url = world.url(&channels);
            let secret = token.secret.clone();
            async move { finish(http.get(url).bearer_auth(secret)).await }
        });
        wait_until(
            &format!("the {which} token's request to wait on its row"),
            || a_request_is_waiting_on_a_lock(&world),
        )
        .await;
        if ends_in_a_revoke {
            sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
                .bind(token.id)
                .execute(&mut *held)
                .await
                .expect("revoke while the request waits");
        }
        held.commit().await.expect("release the row");
        let reply = request.await.expect("the request finishes");

        if ends_in_a_revoke {
            // Authenticated a moment ago, revoked before the touch: not admitted, and the
            // answer is the one an unknown token gets.
            assert_eq!(
                reply.fingerprint(),
                unknown_answer.fingerprint(),
                "a token revoked mid-request is answered as an unknown one"
            );
            assert_eq!(
                world.used_rows(token.id).await,
                1,
                "no use row for the lost race"
            );
            assert_eq!(
                world.last_used(token.id).await,
                Some(marker),
                "no touch for the lost race"
            );
        } else {
            expect_status(&reply, 200, "the same wait, ended without a revoke");
            assert_eq!(world.used_rows(token.id).await, 2, "the row and ...");
            let touched = world.last_used(token.id).await.expect("last_used_at");
            assert!(
                touched > marker + 3_600_000_000,
                "... the touch come together"
            );
        }
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn scope_and_policy_refusals_leave_one_row_per_token_per_window_and_touch_nothing() {
    let _serial = test_lock().await;
    let world = World::boot(default_budgets()).await;
    let dohyeon = world.admin("lee-dohyeon").await;
    let seoyeon = world.admin("park-seoyeon").await;
    let minsu = world.admin("choi-minsu").await;
    let hayoon = world.admin("jung-hayoon").await;
    let channel = world.channel(&[dohyeon, seoyeon, minsu, hayoon]).await;
    let channels = world.channels_path();

    // ---- scope: a read-only token asked to send ----
    let reader = world.card(dohyeon, &DEV_READ_ONLY_SCOPES).await;
    let reader_too = world.card(hayoon, &DEV_READ_ONLY_SCOPES).await;
    expect_status(
        &world.get_as(&channels, &reader.secret).await,
        200,
        "the control read",
    );
    assert_eq!(world.used_rows(reader.id).await, 1);
    let marker = world.age_last_used(reader.id).await;
    let row_before = world.token_row(reader.id).await;
    for call in 1..=5 {
        let reply = world.send_as(channel, &reader.secret, BODY_CANARY).await;
        expect_code(
            &reply,
            403,
            "dev_scope_denied",
            &format!("scope refusal {call}"),
        );
        assert_eq!(
            world.used_rows(reader.id).await,
            1,
            "a refusal is not use (call {call})"
        );
        assert_eq!(
            world.last_used(reader.id).await,
            Some(marker),
            "a refusal does not touch last_used_at (call {call})"
        );
    }
    assert_eq!(world.token_row(reader.id).await, row_before);
    assert_eq!(world.message_count(channel).await, 0);
    let rows = world.audit(SCOPE_DENIED, Some(reader.id)).await;
    assert_eq!(rows.len(), 1, "five refusals, one row per window");
    assert_eq!(
        rows[0].detail,
        refused_detail("POST", T_MESSAGES, "dev:messages:write", "scope")
    );
    assert_eq!(rows[0].actor, Some(dohyeon));
    assert_eq!(rows[0].via_token, Some(reader.id));
    assert_eq!(rows[0].target_type.as_deref(), Some("route"));

    // The bound is per token: another token's refusals are recorded on their own.
    for call in 1..=3 {
        let reply = world
            .send_as(channel, &reader_too.secret, BODY_CANARY)
            .await;
        expect_code(
            &reply,
            403,
            "dev_scope_denied",
            &format!("other token, refusal {call}"),
        );
    }
    assert_eq!(
        world.audit(SCOPE_DENIED, Some(reader_too.id)).await.len(),
        1
    );
    assert_eq!(world.count_audit(SCOPE_DENIED, None).await, 2);

    // ---- policy: an admin demoted to member is refused on the next request ----
    let holder = world.card(seoyeon, &DEV_SCOPES).await;
    let steady = world.card(minsu, &DEV_SCOPES).await;
    expect_status(
        &world.get_as(&channels, &holder.secret).await,
        200,
        "before the demotion",
    );
    assert_eq!(world.used_rows(holder.id).await, 1);
    let held_marker = world.age_last_used(holder.id).await;
    let held_row = world.token_row(holder.id).await;
    sqlx::query(
        "UPDATE workspace_membership SET role = 'member' WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(world.workspace)
    .bind(seoyeon)
    .execute(&world.su)
    .await
    .expect("demote the member");
    for call in 1..=5 {
        let reply = world.get_as(&channels, &holder.secret).await;
        expect_code(
            &reply,
            403,
            "dev_access_denied",
            &format!("policy refusal {call}"),
        );
        assert_eq!(
            world.used_rows(holder.id).await,
            1,
            "a refusal is not use (call {call})"
        );
        assert_eq!(
            world.last_used(holder.id).await,
            Some(held_marker),
            "a refusal does not touch last_used_at (call {call})"
        );
    }
    assert_eq!(
        world.token_row(holder.id).await,
        held_row,
        "nothing of the token row moved"
    );
    let rows = world.audit(SCOPE_DENIED, Some(holder.id)).await;
    assert_eq!(rows.len(), 1, "five policy refusals, one row per window");
    assert_eq!(
        rows[0].detail,
        refused_detail("GET", T_CHANNELS, "dev:channels:read", "policy")
    );
    // The control: another admin's token of the same workspace is admitted, and recorded.
    expect_status(
        &world.get_as(&channels, &steady.secret).await,
        200,
        "an admin's token",
    );
    assert_eq!(world.used_rows(steady.id).await, 1);
    assert_eq!(world.count_audit(SCOPE_DENIED, None).await, 3);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_two_kinds_of_refusal_row_are_bounded_separately() {
    let _serial = test_lock().await;
    let world = World::boot(budgets(6, 100, 50)).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let token = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let channels = world.channels_path();

    // A scope refusal first, repeatedly ...
    for call in 1..=3 {
        let reply = world.send_as(channel, &token.secret, BODY_CANARY).await;
        expect_code(
            &reply,
            403,
            "dev_scope_denied",
            &format!("scope refusal {call}"),
        );
    }
    // ... then ten reads against a budget of six. A refusal decided before the budget costs
    // the token nothing, so all six are still there: six served, four told to wait.
    let mut admitted = 0_i64;
    let mut refused = 0;
    for _ in 0..10 {
        let reply = world.get_as(&channels, &token.secret).await;
        match reply.status {
            200 => admitted += 1,
            429 => refused += 1,
            other => panic!("a read answered {other}: {}", reply.text()),
        }
    }
    assert_eq!(
        (admitted, refused),
        (6, 4),
        "a budget of six serves six of ten reads, however many 403s came first"
    );
    // One row of each kind: neither kind used up the other's window.
    assert_eq!(
        world.audit(SCOPE_DENIED, Some(token.id)).await.len(),
        1,
        "many scope refusals, one row"
    );
    assert_eq!(
        world.audit(RATE_LIMITED, Some(token.id)).await.len(),
        1,
        "many 429s, one row — although a scope row of this token already exists"
    );
    assert_eq!(world.used_rows(token.id).await, admitted);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refusal_row_is_written_again_in_a_later_window() {
    let _serial = test_lock().await;
    // A window of one second, so that the next one comes while the test is still running;
    // budgets too large to be the thing that refuses.
    let world = World::boot(DevAccessConfig {
        window_seconds: 1,
        per_token_limit: 100_000,
        per_member_limit: 100_000,
        write_per_token_limit: 100_000,
    })
    .await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let reader = world.card(member, &DEV_READ_ONLY_SCOPES).await;

    let first = world.send_as(channel, &reader.secret, BODY_CANARY).await;
    expect_code(&first, 403, "dev_scope_denied", "the first refusal");
    assert_eq!(world.count_audit(SCOPE_DENIED, Some(reader.id)).await, 1);
    // Keep refusing until a later window records another row. Only "it comes back" is
    // asserted — a slow machine may fit several windows in, none of which is wrong.
    wait_until("a refusal row of a later window", || async {
        let reply = world.send_as(channel, &reader.secret, BODY_CANARY).await;
        assert_eq!(reply.status, 403);
        world.count_audit(SCOPE_DENIED, Some(reader.id)).await >= 2
    })
    .await;
}

// ---------------------------------------------------------------------------
// R6 (door side) — the token is read from the Authorization header alone, and it
// leaves no trace
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_valid_token_anywhere_but_the_bearer_header_is_not_a_credential() {
    let _serial = test_lock().await;
    let world = World::boot(default_budgets()).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let token = world.card(member, &DEV_SCOPES).await;
    let secret = token.secret.clone();
    let channels = world.channels_path();
    let basic = |user_pass: String| {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(user_pass)
        )
    };

    // What a request with no credential at all is told.
    let nothing = finish(world.get(&channels)).await;
    expect_status(&nothing, 401, "no credential at all");
    let no_credential = nothing.fingerprint();

    let carriers: Vec<(&str, RequestBuilder)> = vec![
        (
            "a query parameter named access_token",
            world.get(&format!("{channels}?access_token={secret}")),
        ),
        (
            "a query parameter named token",
            world.get(&format!("{channels}?token={secret}")),
        ),
        (
            "a cookie",
            world.get(&channels).header(
                "cookie",
                format!("access_token={secret}; token={secret}; session={secret}"),
            ),
        ),
        (
            "a JSON body",
            world
                .get(&channels)
                .json(&json!({"access_token": secret, "token": secret})),
        ),
        (
            "an X-Api-Key header",
            world.get(&channels).header("x-api-key", &secret),
        ),
        (
            "an X-Access-Token header",
            world.get(&channels).header("x-access-token", &secret),
        ),
        (
            "the Token authorization scheme",
            world
                .get(&channels)
                .header("authorization", format!("Token {secret}")),
        ),
        (
            "Basic, as the password",
            world
                .get(&channels)
                .header("authorization", basic(format!("oort:{secret}"))),
        ),
        (
            "Basic, as the user name",
            world
                .get(&channels)
                .header("authorization", basic(format!("{secret}:"))),
        ),
        (
            "a send whose query, cookie and body all carry it",
            world
                .post(&format!(
                    "{}?access_token={secret}",
                    world.messages_path(channel)
                ))
                .header("cookie", format!("access_token={secret}"))
                .json(&json!({
                    "clientMsgId": Uuid::new_v4(),
                    "body": BODY_CANARY,
                    "token": secret,
                })),
        ),
    ];
    for (place, request) in carriers {
        let reply = finish(request).await;
        expect_status(&reply, 401, &format!("a valid token in {place}"));
        assert_eq!(
            reply.fingerprint(),
            no_credential,
            "a valid token in {place} is answered exactly as no credential at all"
        );
    }
    // None of it was read: nothing was recorded, touched or stored.
    assert_eq!(
        world.all_audit_rows().await,
        0,
        "no row of any kind for these requests"
    );
    assert_eq!(
        world.last_used(token.id).await,
        None,
        "the token was never touched"
    );
    assert_eq!(
        world.message_count(channel).await,
        0,
        "the send never reached its handler"
    );

    // The control: the same token, in the one place it is read, is served and recorded.
    expect_status(
        &world.get_as(&channels, &secret).await,
        200,
        "the same token as a Bearer",
    );
    expect_status(
        &world.send_as(channel, &secret, BODY_CANARY).await,
        201,
        "the same token sends as a Bearer",
    );
    assert_eq!(world.used_rows(token.id).await, 2);
    assert!(world.last_used(token.id).await.is_some());
    assert_eq!(world.message_count(channel).await, 1);
}

/// What the test thread's `tracing` events are written into.
#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl LogBuffer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("the log buffer is healthy")).into_owned()
    }
}

impl io::Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("the log buffer is healthy")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogBuffer;

    fn make_writer(&'a self) -> LogBuffer {
        self.clone()
    }
}

/// SHA-256 of `text`, lowercase hex.
fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// The first piece of `envelope` found in `haystack`: the whole envelope, any eight
/// consecutive characters of its secret field (the first eight and the last eight among
/// them), the SHA-256 of the whole envelope, of its secret field alone, or the first
/// sixteen characters of either hash. A window of eight random base64url characters is met
/// by chance at one haystack position in 64^8 ≈ 3e14 (a megabyte of log: ~3e-9 per window),
/// so a hit is the token.
fn leaked_piece(haystack: &str, envelope: &str) -> Option<String> {
    let mut pieces = vec![envelope.to_string()];
    let fields: Vec<&str> = envelope.split('.').collect();
    // `momo_dev_v1.<workspace>.<secret>`: only a real third field has windows worth
    // scanning (a bare workspace id is in every log by design).
    if let [_, _, secret] = fields[..] {
        if secret.len() >= 16 {
            pieces.extend(
                secret
                    .as_bytes()
                    .windows(8)
                    .map(|window| String::from_utf8_lossy(window).into_owned()),
            );
            let secret_hash = sha256_hex(secret);
            pieces.push(secret_hash[..16].to_string());
            pieces.push(secret_hash);
        }
    }
    let hash = sha256_hex(envelope);
    pieces.push(hash[..16].to_string());
    pieces.push(hash);
    pieces
        .into_iter()
        .find(|piece| haystack.contains(piece.as_str()))
}

/// A 43-character base64url secret (32 random bytes, as the server mints them) that is not
/// the one of any token the server issued. Real alphabet on purpose: a hex-only secret would
/// meet the hex of every UUID in a log by chance far too often (16^8 ≈ 4e9).
fn made_up_secret() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[test]
fn the_leak_scanner_sees_the_envelope_its_windows_and_its_hash() {
    let workspace = Uuid::new_v4();
    let secret = made_up_secret();
    assert_eq!(secret.len(), 43);
    let envelope = format!("momo_dev_v1.{workspace}.{secret}");
    let plant =
        |piece: &str| format!("2026-10-28T02:00:00Z INFO somewhere: noise {piece} more noise");

    // Every form of the token is found ...
    for (what, piece) in [
        ("the whole envelope", envelope.clone()),
        ("the first eight characters", secret[..8].to_string()),
        ("the middle", secret[17..25].to_string()),
        ("the last eight characters", secret[35..].to_string()),
        ("the hash", sha256_hex(&envelope)),
        (
            "the head of the hash",
            sha256_hex(&envelope)[..16].to_string(),
        ),
        ("the hash of the secret alone", sha256_hex(&secret)),
    ] {
        assert!(
            leaked_piece(&plant(&piece), &envelope).is_some(),
            "the scanner misses {what}"
        );
    }
    // The secret is the base64url of 32 bytes the server could have minted.
    assert!(secret
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    // ... and the things a log legitimately holds are not.
    for harmless in [
        "no token here at all",
        &format!("workspace_id={workspace}"),
        "momo_dev_v1 is the prefix of every developer token",
        &format!("token_id={}", Uuid::new_v4()),
        &sha256_hex("another envelope"),
    ] {
        assert_eq!(
            leaked_piece(harmless, &envelope),
            None,
            "the scanner flags {harmless:?}"
        );
    }
    // A malformed envelope is scanned whole (its short tail has no window of its own), and
    // never by the workspace id it names.
    let malformed = format!("momo_dev_v1.{workspace}.short");
    assert!(leaked_piece(&plant(&malformed), &malformed).is_some());
    assert_eq!(
        leaked_piece(&format!("workspace_id={workspace}"), &malformed),
        None
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn no_audit_row_and_no_log_line_holds_any_piece_of_a_presented_token() {
    let _serial = test_lock().await;
    // The capture is a default of this thread (see the file's notes): installed before
    // anything runs, so that issuing the tokens is captured too. The answers the client
    // receives are recorded from the same moment.
    let answers_record = AnswerRecord::start();
    let logs = LogBuffer::default();
    let _capture = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .set_default();

    let world = World::boot(budgets(4, 100, 50)).await;
    let member = world.admin("lee-dohyeon").await;
    let channel = world.channel(&[member]).await;
    let writer = world.card(member, &DEV_SCOPES).await;
    let reader = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    let sender = world.card(member, &DEV_SCOPES).await;
    let gone = world.card(member, &DEV_READ_ONLY_SCOPES).await;
    world.revoke(gone.id).await;
    let login = world.login(member).await;
    let unknown = format!("momo_dev_v1.{}.{}", world.workspace, made_up_secret());
    let malformed = format!("momo_dev_v1.{}.short", world.workspace);
    let channels = world.channels_path();

    // 200s: the writer's whole budget of four, a login's access half, a send.
    for call in 1..=4 {
        expect_status(
            &world.get_as(&channels, &writer.secret).await,
            200,
            &format!("writer, call {call}"),
        );
    }
    expect_status(
        &world.get_as(&channels, &login.access).await,
        200,
        "the login's access half",
    );
    expect_status(
        &world.send_as(channel, &sender.secret, BODY_CANARY).await,
        201,
        "a send",
    );
    // 429: the writer's fifth.
    let limited = world.get_as(&channels, &writer.secret).await;
    expect_status(&limited, 429, "writer, call 5");
    // 403s: a scope the token lacks, and a route off the table.
    for call in 1..=2 {
        let reply = world.send_as(channel, &reader.secret, BODY_CANARY).await;
        expect_code(
            &reply,
            403,
            "dev_scope_denied",
            &format!("reader's send {call}"),
        );
    }
    let off_table = finish(
        world
            .http
            .delete(world.url(&channels))
            .bearer_auth(&sender.secret),
    )
    .await;
    expect_code(
        &off_table,
        403,
        "dev_route_not_allowed",
        "a route off the table",
    );
    // 401s: strings the server does not know, a revoked token, a refresh half at a data
    // route.
    for (what, presented) in [
        ("an unknown token", &unknown),
        ("a malformed token", &malformed),
        ("a revoked token", &gone.secret),
        ("a refresh token", &login.refresh),
    ] {
        expect_status(&world.get_as(&channels, presented).await, 401, what);
    }
    // A valid token in the header *and* in the URL: admitted by the header, and the URL — the
    // thing a request logger prints — must not carry the token into a log line or a row.
    for (who, secret) in [("sender", &sender.secret), ("login access", &login.access)] {
        let request = world
            .get(&format!("{channels}?access_token={secret}"))
            .bearer_auth(secret);
        expect_status(
            &finish(request).await,
            200,
            &format!("{who}: the header is read, the query is noise"),
        );
    }
    // And a valid token where it is not read — the place a request logger would print.
    for request in [
        world.get(&format!("{channels}?access_token={}", writer.secret)),
        world.get(&format!("{channels}?token={}", sender.secret)),
        world
            .get(&channels)
            .header("cookie", format!("access_token={}", reader.secret)),
    ] {
        expect_status(
            &finish(request).await,
            401,
            "a valid token outside the header",
        );
    }

    let presented: Vec<(&str, &str)> = vec![
        ("writer", &writer.secret),
        ("reader", &reader.secret),
        ("sender", &sender.secret),
        ("revoked", &gone.secret),
        ("login access", &login.access),
        ("login refresh", &login.refresh),
        ("unknown", &unknown),
        ("malformed", &malformed),
    ];
    let audit = world.audit_text().await;
    let log = logs.text();
    let answers = answers_record.text();

    // The controls first: the three texts below are the real ones, so "no piece" is a
    // finding and not an empty haystack.
    for needle in [
        USED,
        SCOPE_DENIED,
        RATE_LIMITED,
        T_CHANNELS,
        &writer.id.to_string(),
        &reader.id.to_string(),
    ] {
        assert!(audit.contains(needle), "the audit text lacks {needle}");
    }
    let warning = log
        .lines()
        .find(|line| line.contains("developer-token rate limit exceeded"))
        .unwrap_or_else(|| {
            panic!(
                "the capture does not hold the door's 429 warning — it cannot see the server ({} bytes captured)",
                log.len()
            )
        });
    assert!(
        warning.contains(&writer.id.to_string()),
        "the 429 warning names the token by its id: {warning}"
    );
    // The recorded answers are the refusals' own words (the 403s, the 429 and its
    // `Retry-After`, the 401) — the answers most likely to echo what was presented.
    for needle in [
        "dev_scope_denied",
        "dev_route_not_allowed",
        "rate limit exceeded",
        "retry-after: ",
        "invalid or expired token",
    ] {
        assert!(
            answers.contains(needle),
            "the recorded answers lack {needle} ({} bytes recorded)",
            answers.len()
        );
    }
    // The scanner can fail on these very tokens.
    for (name, envelope) in &presented {
        let planted = format!(
            "noise {} noise",
            &envelope[envelope.len().saturating_sub(12)..]
        );
        if envelope.matches('.').count() == 2 && envelope.len() > 60 {
            assert!(
                leaked_piece(&planted, envelope).is_some(),
                "the scanner cannot see the tail of the {name} token"
            );
        }
    }

    // The claim: no piece of any presented token — valid, spent, made up or malformed — is
    // in the audit of the workspace, in anything the server logged or in any answer it gave.
    for (name, envelope) in &presented {
        for (where_, haystack) in [
            ("the audit", &audit),
            ("the captured log", &log),
            ("the recorded answers", &answers),
        ] {
            if let Some(piece) = leaked_piece(haystack, envelope) {
                panic!("{where_} holds a piece of the {name} token: {piece}");
            }
        }
    }
}
