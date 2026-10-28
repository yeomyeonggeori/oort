//! ADR-0216 D5 (#4661) — the **human MCP**, `POST /v1/mcp/me`, proved over the real router on a
//! real PostgreSQL (`momo_app`, NOBYPASSRLS). Rows of the red-proof table covered here: R13 (the
//! two send budgets a developer-token send spends beside the door's), R14 (a)–(e) and R15 for
//! this route; R1(b) lives beside R1(a) in `dev_token_door_conformance_pg`. `#[ignore]`: it needs
//! a pgvector/pg18 superuser URL, so run it on an isolated database and one test thread:
//!
//! ```text
//! DATABASE_URL=postgres://momo:<pw>@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test human_mcp_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Every test builds its own workspace (달무리 스튜디오), its own people (이도현 holds the tokens;
//! 박서연 and 최민수 write what the tools read) and its own server. Every "refused / empty /
//! nothing stored" assertion sits beside the same request that must have worked, and every claim
//! that a tool answers "as the REST row" is made by calling **the REST row** with the same token
//! and comparing the two bodies — the oracle is the route the tool wraps, not a copy of its
//! output.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `tools_list_shows_exactly_the_tools_of_the_tokens_scopes_in_both_eras_and_annotates_them` | R14 (a)(b): the 「읽기만」 token lists four tools and `oort_me_post` answers like an unknown name; every entry carries the four hints and only the send is not read-only; both eras; `serverInfo` is `oort-me`; no structure/decide/propose/search tool exists | the view stops filtering by scope, an annotation flips, a structure tool appears |
//! | `each_tool_answers_with_the_body_of_the_rest_row_it_wraps` | R14 (d): whoami, channels, read (history + thread, with paging arguments), inbox (with filter and cursor) and post equal the REST row's body for the same token; the inbox carries no approval card though one is pending | a tool computes its own answer, drops the marker (the card appears), or maps an argument differently |
//! | `a_restricted_token_reaches_the_same_channels_through_every_tool_as_through_the_rest_rows` | R14 (d) · R11: outside the token's list (unlisted, not a member, no such channel) read, thread and post are the REST row's one refusal and a send stores nothing; the list and the inbox count only the listed channel; a channel the person left is refused | a tool skips the channel restriction or the membership check |
//! | `a_post_is_sent_as_the_person_marked_dev_stored_once_and_carries_nothing_else` | R12 via MCP: `sent_via = 'dev'`, `sentVia` in the echo, a retry lands once, a thread reply works, the session's copy is unmarked, and every key outside the five (`props`, `runId`, … `sentVia`) is refused with nothing stored | the mark is read from the call, a field leaks into the send, a retry doubles |
//! | `the_send_budgets_are_the_rest_rows_budgets_not_a_second_set` | R13 via MCP: the token's send budget and the member's send budget are the counters REST spends — a send over either is a 429 with `Retry-After` on both doors, a read is still served, the door's per-token budget counts MCP POSTs and a 429 writes nothing | the post tool stops spending a budget, or spends one of its own |
//! | `only_a_post_is_answered_and_a_foreign_origin_is_refused_before_anything_is_spent` | R14 (e): every other method is the door's 403 (a session's is 401), never 200; an `Origin` the operator did not name is a 403 with no body, no `used` row and no spent budget | another method answers, the Origin check moves behind the door |
//! | `the_transport_is_bounded_stateless_and_private` | the wire discipline: no query, one `Content-Type`, 64 KiB, an object (no batch), JSON `Accept`; `Cache-Control: private, no-store`; no `Mcp-Session-Id` echoed; a token outside `Authorization` is no credential | the route drifts from the Agent Port's transport rules |
//! | `an_admitted_call_leaves_one_used_row_for_the_template_and_no_tool_content` | R15 via MCP: one `auth.dev_token.used` row per admitted POST, `detail` the closed vocabulary with the template `/v1/mcp/me`; no row of the workspace's audit holds the message text, a channel id or the token | a tool writes its arguments or results into an audit row |
//! | `the_door_judges_revocation_and_the_role_policy_on_every_mcp_call` | D3 · D7 through the MCP route: a revoked card is the unknown-token 401, a demoted holder gets 403 `dev_access_denied` on the next call | the route caches an admission |

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::OnceLock;

use apps_pg::{
    ensure_schema_and_roles, momo_app_pool, seed_human, seed_managed_agent, seed_workspace,
    superuser_pool, TEST_JWT_SECRET,
};
use momo_auth::{
    issue_dev_card_in_tx, DevTool, NewDevCard, DEV_FIXED_POLICY, DEV_READ_ONLY_SCOPES, DEV_SCOPES,
};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::config::{DevAccessConfig, RateLimitConfig};
use momo_server::{build_app, AppState};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

/// What the app has always answered for a channel the caller cannot reach (403, not 404).
const NOT_A_MEMBER: &str = "not a member of this channel";
const MODERN: &str = "2026-07-28";
const LEGACY: &str = "2025-11-25";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// what a request answered
// ---------------------------------------------------------------------------

/// Status, headers (but the clock) and the body bytes of one answer — everything a client could
/// tell two answers apart by.
#[derive(Clone, PartialEq, Eq)]
struct Reply {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} {:?} {}",
            self.status,
            self.headers,
            self.text()
        )
    }
}

impl Reply {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("the body is not JSON ({error}): {self:?}"))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    /// The status, with the whole answer in the failure message.
    fn expect(&self, status: u16) -> &Reply {
        assert_eq!(self.status, status, "{self:?}");
        self
    }

    /// `Retry-After` as whole seconds.
    fn retry_after(&self) -> u64 {
        self.header("retry-after")
            .unwrap_or_else(|| panic!("no Retry-After: {self:?}"))
            .parse()
            .unwrap_or_else(|_| panic!("Retry-After is not whole seconds: {self:?}"))
    }
}

/// What a `tools/call` answered once the JSON-RPC envelope is peeled: whether the tool refused,
/// and the `structuredContent`. The two halves of the result are held to be one object.
#[derive(Debug)]
struct ToolOutcome {
    is_error: bool,
    structured: Value,
}

fn outcome(reply: &Reply) -> ToolOutcome {
    reply.expect(200);
    let body = reply.json();
    let result = &body["result"];
    assert!(result.is_object(), "no result: {reply:?}");
    let structured = result["structuredContent"].clone();
    let text = result["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text content: {reply:?}"));
    assert_eq!(
        serde_json::from_str::<Value>(text).expect("the text half is JSON"),
        structured,
        "the text half and the structured half describe one object"
    );
    ToolOutcome {
        is_error: result["isError"]
            .as_bool()
            .unwrap_or_else(|| panic!("isError is not a boolean: {reply:?}")),
        structured,
    }
}

/// The REST row's own refusal, in the shape a tool carries it: its status beside its error body.
fn refusal_of(rest: &Reply) -> Value {
    assert!(
        rest.status >= 400 && rest.status < 500,
        "not a refusal: {rest:?}"
    );
    json!({"status": rest.status, "error": rest.json()["error"].clone()})
}

fn tool_names(listing: &Value) -> BTreeSet<String> {
    listing["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("no tool array: {listing}"))
        .iter()
        .map(|tool| tool["name"].as_str().expect("a tool name").to_string())
        .collect()
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|name| (*name).to_string()).collect()
}

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

struct World {
    http: reqwest::Client,
    base: String,
    su: PgPool,
    app: PgPool,
    ws: Uuid,
}

struct Person {
    id: Uuid,
    /// A real session access token (the `token` row exists), for the REST rows a person calls.
    jwt: String,
}

#[derive(Clone, Copy)]
enum Era {
    Legacy,
    Modern,
}

/// How a seeded message relates to the others. All off = a plain message, now.
#[derive(Default, Clone, Copy)]
struct Say {
    reply_to: Option<Uuid>,
    root: Option<Uuid>,
    mention: Option<Uuid>,
    minutes_ago: i64,
}

/// What the tables hold for one channel (and the outbox for its workspace) — what a refused send
/// must leave exactly as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ledger {
    messages: i64,
    last_seq: i64,
    outbox: i64,
}

impl World {
    /// A fresh workspace behind a server whose state `shape` builds from the plain one.
    async fn with_state(shape: impl FnOnce(AppState) -> AppState) -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let ws = seed_workspace(&su).await;
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
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("an HTTP client"),
            base: format!("http://{address}"),
            su,
            app,
            ws,
        }
    }

    async fn person(&self, role: &str, name: &str) -> Person {
        let (id, jwt) = seed_human(&self.su, self.ws, role, name).await;
        Person { id, jwt }
    }

    /// A public channel with `members` in it, named so that a list sorts predictably.
    async fn room(&self, name: &str, members: &[Uuid]) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
             VALUES ($1, $2, 'public'::channel_kind, $3, $4)",
        )
        .bind(id)
        .bind(self.ws)
        .bind(name)
        .bind(members[0])
        .execute(&self.su)
        .await
        .expect("seed channel");
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(id)
        .bind(self.ws)
        .execute(&self.su)
        .await
        .expect("seed channel_seq");
        for member in members {
            sqlx::query(
                "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
                 VALUES ($1, $2, $3, 'member')",
            )
            .bind(self.ws)
            .bind(id)
            .bind(member)
            .execute(&self.su)
            .await
            .expect("seed membership");
        }
        id
    }

    /// One text message, inserted with plain SQL so the projection triggers fire exactly as they
    /// do for the real writers (an inbox item per quote, mention and thread reply).
    async fn say(&self, channel: Uuid, author: Uuid, body: &str, how: Say) -> Uuid {
        let seq: i64 = sqlx::query_scalar(
            "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 \
             RETURNING last_seq",
        )
        .bind(channel)
        .fetch_one(&self.su)
        .await
        .expect("bump channel_seq");
        let id = Uuid::new_v4();
        let props = match how.mention {
            Some(member) => json!({"mention_member_ids": [member.to_string()]}),
            None => json!({}),
        };
        sqlx::query(
            "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                                  author_member_id, type, body, props, reply_to_id, root_id, \
                                  created_at) \
             VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6, $7, $8, $9, \
                     now() - ($10::bigint * interval '1 minute'))",
        )
        .bind(id)
        .bind(self.ws)
        .bind(channel)
        .bind(seq)
        .bind(author)
        .bind(body)
        .bind(props)
        .bind(how.reply_to)
        .bind(how.root)
        .bind(how.minutes_ago)
        .execute(&self.su)
        .await
        .expect("seed message");
        id
    }

    /// A pending approval card in `channel`, requested by `agent`.
    async fn pending_approval(&self, channel: Uuid, agent: Uuid, note: &str) {
        let run = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(run)
        .bind(self.ws)
        .bind(agent)
        .bind(channel)
        .execute(&self.su)
        .await
        .expect("seed agent_run");
        sqlx::query(
            "INSERT INTO approval (workspace_id, run_id, channel_id, requested_by, action_type, \
                                   payload) \
             VALUES ($1, $2, $3, $4, 'tool_call', $5)",
        )
        .bind(self.ws)
        .bind(run)
        .bind(channel)
        .bind(agent)
        .bind(json!({"note": note}))
        .execute(&self.su)
        .await
        .expect("seed approval");
    }

    /// A developer card, issued through the domain function exactly as the route does.
    async fn card(&self, member: Uuid, scopes: &[&str], channels: Option<&[Uuid]>) -> String {
        self.card_row(member, scopes, channels).await.1
    }

    /// The same, with the `token` row's id (for the rows a test reads back).
    async fn card_row(
        &self,
        member: Uuid,
        scopes: &[&str],
        channels: Option<&[Uuid]>,
    ) -> (Uuid, String) {
        let ws = self.ws;
        let card = NewDevCard {
            label: "달무리 시험 도구".to_string(),
            tool: DevTool::Cli,
            scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            channel_ids: channels.map(<[Uuid]>::to_vec),
            expires_in_days: 30,
        };
        let issued = with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                Ok::<_, DbError>(
                    issue_dev_card_in_tx(conn, ws, member, &card, DEV_FIXED_POLICY).await?,
                )
            })
        })
        .await
        .expect("the card transaction")
        .expect("an admin may hold a card");
        (issued.id, issued.secret)
    }

    // ---- requests -------------------------------------------------------

    fn ws_url(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}/{tail}", self.base, self.ws)
    }

    async fn send_request(&self, request: reqwest::RequestBuilder) -> Reply {
        let response = request.send().await.expect("send the request");
        let status = response.status().as_u16();
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        for (name, value) in response.headers() {
            // The clock differs between any two answers and says nothing.
            if name.as_str() == "date" {
                continue;
            }
            let value = value.to_str().unwrap_or("<binary>").to_string();
            headers
                .entry(name.as_str().to_string())
                .and_modify(|joined| {
                    joined.push_str(", ");
                    joined.push_str(&value);
                })
                .or_insert(value);
        }
        let body = response.bytes().await.expect("read the body").to_vec();
        Reply {
            status,
            headers,
            body,
        }
    }

    /// A REST row with a bearer.
    async fn rest(&self, method: Method, tail: &str, bearer: &str, body: Option<&Value>) -> Reply {
        let mut request = self
            .http
            .request(method, self.ws_url(tail))
            .bearer_auth(bearer);
        if let Some(body) = body {
            request = request.json(body);
        }
        self.send_request(request).await
    }

    async fn get(&self, bearer: &str, tail: &str) -> Reply {
        self.rest(Method::GET, tail, bearer, None).await
    }

    async fn rest_send(&self, bearer: &str, channel: Uuid, body: &Value) -> Reply {
        self.rest(
            Method::POST,
            &format!("channels/{channel}/messages"),
            bearer,
            Some(body),
        )
        .await
    }

    /// One JSON-RPC POST to the human MCP.
    async fn rpc(&self, bearer: Option<&str>, era: Era, method: &str, params: Value) -> Reply {
        let (version, params) = match era {
            Era::Legacy => (LEGACY, params),
            Era::Modern => {
                let mut params = params;
                params["_meta"] = json!({
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientCapabilities": {},
                });
                (MODERN, params)
            }
        };
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut request = self
            .http
            .post(format!("{}/v1/mcp/me", self.base))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", version)
            .header("mcp-method", method)
            .json(&body);
        if method == "tools/call" {
            request = request.header("mcp-name", params["name"].as_str().expect("a tool name"));
        }
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        self.send_request(request).await
    }

    async fn list(&self, bearer: &str, era: Era) -> Reply {
        self.rpc(Some(bearer), era, "tools/list", json!({})).await
    }

    /// `tools/call` in the legacy era (stateless, so no `initialize` first).
    async fn call(&self, bearer: &str, tool: &str, arguments: Value) -> Reply {
        self.call_in(bearer, Era::Legacy, tool, arguments).await
    }

    async fn call_in(&self, bearer: &str, era: Era, tool: &str, arguments: Value) -> Reply {
        self.rpc(
            Some(bearer),
            era,
            "tools/call",
            json!({"name": tool, "arguments": arguments}),
        )
        .await
    }

    /// A tool call that must have run, whatever it answered.
    async fn tool(&self, bearer: &str, tool: &str, arguments: Value) -> ToolOutcome {
        outcome(&self.call(bearer, tool, arguments).await)
    }

    // ---- what the database holds ------------------------------------------

    async fn ledger(&self, channel: Uuid) -> Ledger {
        let messages: i64 =
            sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                .bind(channel)
                .fetch_one(&self.su)
                .await
                .expect("count messages");
        let last_seq: i64 =
            sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
                .bind(channel)
                .fetch_one(&self.su)
                .await
                .expect("read last_seq");
        let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
            .bind(self.ws)
            .fetch_one(&self.su)
            .await
            .expect("count outbox rows");
        Ledger {
            messages,
            last_seq,
            outbox,
        }
    }

    async fn messages_with_client_id(&self, client_msg_id: Uuid) -> Vec<Uuid> {
        sqlx::query_scalar("SELECT id FROM message WHERE workspace_id = $1 AND client_msg_id = $2")
            .bind(self.ws)
            .bind(client_msg_id)
            .fetch_all(&self.su)
            .await
            .expect("find messages by client id")
    }

    async fn sent_via(&self, message: Uuid) -> Option<String> {
        sqlx::query_scalar("SELECT sent_via FROM message WHERE id = $1")
            .bind(message)
            .fetch_one(&self.su)
            .await
            .expect("read sent_via")
    }

    async fn marked_messages(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM message WHERE workspace_id = $1 AND sent_via IS NOT NULL",
        )
        .bind(self.ws)
        .fetch_one(&self.su)
        .await
        .expect("count marked messages")
    }

    /// The `auth.dev_token.used` rows of one token, newest last.
    async fn used_rows(&self, token: Uuid) -> Vec<Value> {
        sqlx::query_scalar(
            "SELECT detail FROM audit_log \
              WHERE workspace_id = $1 AND via_token_id = $2 AND action = 'auth.dev_token.used' \
              ORDER BY created_at, id",
        )
        .bind(self.ws)
        .bind(token)
        .fetch_all(&self.su)
        .await
        .expect("read the used rows")
    }

    async fn last_used(&self, token: Uuid) -> bool {
        sqlx::query_scalar("SELECT last_used_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&self.su)
            .await
            .expect("last_used_at")
    }
}

/// 달무리 스튜디오 at work: the token holder, two colleagues and three channels.
struct Studio {
    w: World,
    /// 이도현 — a workspace **admin** (the fixed switch admits owner and admin only).
    holder: Person,
    colleague: Person,
    third: Person,
    /// The channel a restricted token lists (the holder, 박서연).
    a: Uuid,
    /// A channel the holder is in but a restricted token does not list (+ 최민수).
    b: Uuid,
    /// A channel the holder is **not** in (박서연, 최민수).
    c: Uuid,
}

async fn studio_with(shape: impl FnOnce(AppState) -> AppState) -> Studio {
    let w = World::with_state(shape).await;
    let holder = w.person("admin", "이도현").await;
    let colleague = w.person("member", "박서연").await;
    let third = w.person("member", "최민수").await;
    let a = w.room("omega-allowed", &[holder.id, colleague.id]).await;
    let b = w
        .room("alpha-other", &[holder.id, colleague.id, third.id])
        .await;
    let c = w.room("stranger-only", &[colleague.id, third.id]).await;
    Studio {
        w,
        holder,
        colleague,
        third,
        a,
        b,
        c,
    }
}

async fn studio() -> Studio {
    studio_with(|state| state).await
}

impl Studio {
    /// Two unread inbox items for the holder in `channel`: a quote of the holder's own message
    /// and an @mention, both from 박서연.
    async fn plant_unread(&self, channel: Uuid, tag: &str, minutes_ago: i64) {
        let own = self
            .w
            .say(
                channel,
                self.holder.id,
                &format!("{tag}-OWN"),
                Say {
                    minutes_ago: minutes_ago + 2,
                    ..Say::default()
                },
            )
            .await;
        self.w
            .say(
                channel,
                self.colleague.id,
                &format!("{tag}-QUOTE-REPLY"),
                Say {
                    reply_to: Some(own),
                    minutes_ago: minutes_ago + 1,
                    ..Say::default()
                },
            )
            .await;
        self.w
            .say(
                channel,
                self.colleague.id,
                &format!("@이도현 {tag}-MENTION"),
                Say {
                    mention: Some(self.holder.id),
                    minutes_ago,
                    ..Say::default()
                },
            )
            .await;
    }

    /// A card for the holder with every scope.
    async fn full_card(&self) -> String {
        self.w.card(self.holder.id, &DEV_SCOPES, None).await
    }
}

fn message_body(client_msg_id: Uuid, body: &str) -> Value {
    json!({"clientMsgId": client_msg_id, "body": body})
}

// ---------------------------------------------------------------------------
// R14 (a)(b) — the catalog a token sees
// ---------------------------------------------------------------------------

/// R14 (a)(b), over the wire in both eras: a token lists exactly the tools whose scope it carries;
/// every entry has the four hints and only `oort_me_post` is not read-only; a tool the token lacks
/// is answered like a name that does not exist; the server is `oort-me`; and no tool exists that
/// structures the workspace, decides an approval, proposes an action or searches.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R14)"]
async fn tools_list_shows_exactly_the_tools_of_the_tokens_scopes_in_both_eras_and_annotates_them() {
    let _guard = test_lock().await;
    let s = studio().await;
    let all = [
        "oort_me_whoami",
        "oort_me_channels",
        "oort_me_read",
        "oort_me_post",
        "oort_me_inbox",
    ];
    let read_only_tools = [
        "oort_me_whoami",
        "oort_me_channels",
        "oort_me_read",
        "oort_me_inbox",
    ];
    let full = s.w.card(s.holder.id, &DEV_SCOPES, None).await;
    let read_only = s.w.card(s.holder.id, &DEV_READ_ONLY_SCOPES, None).await;
    let identity_inbox =
        s.w.card(s.holder.id, &["dev:identity", "dev:inbox:read"], None)
            .await;

    for era in [Era::Legacy, Era::Modern] {
        for (token, expected) in [
            (&full, names(&all)),
            (&read_only, names(&read_only_tools)),
            (&identity_inbox, names(&["oort_me_whoami", "oort_me_inbox"])),
        ] {
            let listing = s.w.list(token, era).await;
            listing.expect(200);
            let listing = listing.json();
            assert_eq!(tool_names(&listing), expected);
            for tool in listing["result"]["tools"].as_array().expect("tools") {
                let name = tool["name"].as_str().expect("name");
                let hints = &tool["annotations"];
                for key in [
                    "readOnlyHint",
                    "destructiveHint",
                    "idempotentHint",
                    "openWorldHint",
                ] {
                    assert!(hints[key].is_boolean(), "{name}.{key}: {hints}");
                }
                assert_eq!(
                    hints["readOnlyHint"],
                    json!(name != "oort_me_post"),
                    "{name}"
                );
                assert_eq!(hints["destructiveHint"], json!(false), "{name}");
                assert_eq!(hints["openWorldHint"], json!(false), "{name}");
                assert_eq!(tool["inputSchema"]["additionalProperties"], json!(false));
            }
        }
    }

    // `serverInfo` names the human server in both eras.
    let discover =
        s.w.rpc(Some(&full), Era::Modern, "server/discover", json!({}))
            .await;
    assert_eq!(
        discover.expect(200).json()["result"]["serverInfo"]["name"],
        "oort-me"
    );
    let initialize =
        s.w.rpc(
            Some(&full),
            Era::Legacy,
            "initialize",
            json!({
                "protocolVersion": LEGACY,
                "capabilities": {},
                "clientInfo": {"name": "conformance", "version": "1"}
            }),
        )
        .await;
    assert_eq!(
        initialize.expect(200).json()["result"]["serverInfo"]["name"],
        "oort-me"
    );

    // A tool outside the token's scopes is an unknown tool — byte for byte — and runs nothing.
    let before = s.w.ledger(s.a).await;
    let send = json!({
        "channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "읽기만 토큰의 전송"
    });
    for era in [Era::Legacy, Era::Modern] {
        let denied =
            s.w.call_in(&read_only, era, "oort_me_post", send.clone())
                .await;
        let unknown =
            s.w.call_in(&read_only, era, "oort_me_nothing", send.clone())
                .await;
        assert_eq!(denied.status, 400, "{denied:?}");
        assert_eq!(denied.json()["error"]["code"], -32602);
        assert_eq!(
            denied, unknown,
            "an outside tool answers like an unknown tool"
        );
    }
    assert_eq!(
        s.w.ledger(s.a).await,
        before,
        "the refused send stored nothing"
    );
    // The control: the token that carries the scope reaches the very same tool.
    let sent = s.w.tool(&full, "oort_me_post", send).await;
    assert!(!sent.is_error, "{sent:?}");
    assert_eq!(s.w.ledger(s.a).await.messages, before.messages + 1);
}

// ---------------------------------------------------------------------------
// R14 (d) — a tool is its REST row
// ---------------------------------------------------------------------------

fn without(mut value: Value, key: &str) -> Value {
    value.as_object_mut().expect("an object").remove(key);
    value
}

/// R14 (d): for the same token, each tool's `structuredContent` equals the body of the REST row it
/// wraps — `whoami` (but the use clock), the channel list, history with `limit`/`before`/`after`,
/// a thread with `limit`/`cursor`, the inbox with `filter`/`limit`/`cursor` — and the inbox carries
/// no approval card although the workspace has one pending (the session's own inbox shows it).
/// `post` equals the REST send's echo of the same `clientMsgId`.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R14)"]
async fn each_tool_answers_with_the_body_of_the_rest_row_it_wraps() {
    let _guard = test_lock().await;
    let s = studio().await;
    let bot = seed_managed_agent(&s.w.su, s.w.ws, s.holder.id, "reviewbot")
        .await
        .id;
    // History in A, a thread in A (a root and three replies), unread items and a pending card.
    s.w.say(
        s.a,
        s.colleague.id,
        "첫 메시지",
        Say {
            minutes_ago: 60,
            ..Say::default()
        },
    )
    .await;
    for index in 0..4 {
        s.w.say(
            s.a,
            s.colleague.id,
            &format!("이어지는 메시지 {index}"),
            Say {
                minutes_ago: 50 - index,
                ..Say::default()
            },
        )
        .await;
    }
    let root =
        s.w.say(
            s.a,
            s.colleague.id,
            "스레드 뿌리",
            Say {
                minutes_ago: 40,
                ..Say::default()
            },
        )
        .await;
    for index in 0..3 {
        s.w.say(
            s.a,
            s.third.id,
            &format!("스레드 답글 {index}"),
            Say {
                root: Some(root),
                minutes_ago: 30 - index,
                ..Say::default()
            },
        )
        .await;
    }
    s.plant_unread(s.a, "ALPHA", 10).await;
    s.plant_unread(s.b, "BRAVO", 5).await;
    s.w.pending_approval(s.a, bot, "NOTE-IN-A").await;
    let token = s.full_card().await;

    // The control for the inbox claim: the holder's own session sees the pending card.
    let session_inbox = s.w.get(&s.holder.jwt, "inbox").await.expect(200).json();
    assert_eq!(
        session_inbox["approvalsPending"].as_array().map(Vec::len),
        Some(1),
        "the card is pending and a session sees it: {session_inbox}"
    );

    // whoami — but the use clock, which differs between any two calls.
    let rest_self = s.w.get(&token, "dev-access/self").await.expect(200).json();
    let tool_self = s.w.tool(&token, "oort_me_whoami", json!({})).await;
    assert!(!tool_self.is_error);
    assert_eq!(
        without(tool_self.structured, "lastUsedAtMs"),
        without(rest_self, "lastUsedAtMs")
    );

    // the channel list, with and without `limit`
    for (arguments, query) in [(json!({}), ""), (json!({"limit": 1}), "?limit=1")] {
        let rest =
            s.w.get(&token, &format!("channels{query}"))
                .await
                .expect(200)
                .json();
        let tool = s.w.tool(&token, "oort_me_channels", arguments).await;
        assert!(!tool.is_error);
        assert_eq!(tool.structured, rest, "channels{query}");
    }

    // history
    let page =
        s.w.get(&token, &format!("channels/{}/messages?limit=3", s.a))
            .await
            .expect(200)
            .json();
    let next_before = page["nextBefore"].as_i64().expect("a page boundary");
    let history = [
        (json!({"channelId": s.a}), String::new()),
        (
            json!({"channelId": s.a, "limit": 3}),
            "?limit=3".to_string(),
        ),
        (
            json!({"channelId": s.a, "limit": 3, "before": next_before}),
            format!("?limit=3&before={next_before}"),
        ),
        (
            json!({"channelId": s.a, "after": 2, "limit": 2}),
            "?after=2&limit=2".to_string(),
        ),
        (
            json!({"channelId": s.a, "before": null, "after": null, "cursor": null}),
            String::new(),
        ),
    ];
    for (arguments, query) in history {
        let rest =
            s.w.get(&token, &format!("channels/{}/messages{query}", s.a))
                .await
                .expect(200)
                .json();
        let tool = s.w.tool(&token, "oort_me_read", arguments).await;
        assert!(!tool.is_error, "{tool:?}");
        assert_eq!(tool.structured, rest, "history{query}");
    }
    assert!(
        page["messages"].as_array().is_some_and(|m| !m.is_empty()),
        "the history is not empty: {page}"
    );

    // a thread
    let page =
        s.w.get(
            &token,
            &format!("channels/{}/messages/{root}/replies?limit=2", s.a),
        )
        .await
        .expect(200)
        .json();
    let next_cursor = page["nextCursor"]
        .as_i64()
        .expect("a thread has a second page");
    let threads = [
        (
            json!({"channelId": s.a, "threadRootId": root}),
            String::new(),
        ),
        (
            json!({"channelId": s.a, "threadRootId": root, "limit": 2}),
            "?limit=2".to_string(),
        ),
        (
            json!({"channelId": s.a, "threadRootId": root, "limit": 2, "cursor": next_cursor}),
            format!("?limit=2&cursor={next_cursor}"),
        ),
    ];
    for (arguments, query) in threads {
        let rest =
            s.w.get(
                &token,
                &format!("channels/{}/messages/{root}/replies{query}", s.a),
            )
            .await
            .expect(200)
            .json();
        let tool = s.w.tool(&token, "oort_me_read", arguments).await;
        assert!(!tool.is_error, "{tool:?}");
        assert_eq!(tool.structured, rest, "replies{query}");
    }
    // arguments that belong to the other mode are refused, not guessed at
    for arguments in [
        json!({"channelId": s.a, "cursor": 1}),
        json!({"channelId": s.a, "threadRootId": root, "before": 5}),
        json!({"channelId": s.a, "threadRootId": root, "after": 1}),
    ] {
        let refused = s.w.call(&token, "oort_me_read", arguments).await;
        assert_eq!(refused.status, 400, "{refused:?}");
        assert_eq!(refused.json()["error"]["code"], -32602);
    }

    // the inbox: filter, limit, cursor — and never an approval card
    let first_page = s.w.get(&token, "inbox?limit=2").await.expect(200).json();
    assert_eq!(first_page["approvalsPending"], json!([]));
    let cursor = first_page["nextCursor"]
        .as_str()
        .expect("an inbox cursor")
        .to_string();
    let inboxes = [
        (json!({}), String::new()),
        (json!({"limit": 2}), "?limit=2".to_string()),
        (
            json!({"limit": 2, "cursor": cursor}),
            format!("?limit=2&cursor={cursor}"),
        ),
        (json!({"filter": "mention"}), "?filter=mention".to_string()),
        (
            json!({"filter": "all", "limit": 1}),
            "?filter=all&limit=1".to_string(),
        ),
    ];
    for (arguments, query) in inboxes {
        let rest =
            s.w.get(&token, &format!("inbox{query}"))
                .await
                .expect(200)
                .json();
        let tool = s.w.tool(&token, "oort_me_inbox", arguments).await;
        assert!(!tool.is_error, "{tool:?}");
        assert_eq!(tool.structured, rest, "inbox{query}");
        assert_eq!(tool.structured["approvalsPending"], json!([]));
    }
    assert!(
        s.w.tool(&token, "oort_me_inbox", json!({}))
            .await
            .structured["items"]
            .as_array()
            .is_some_and(|items| items.len() >= 4),
        "the inbox has items to compare"
    );

    // post: the REST send, then the tool with the same clientMsgId and body, is one message and
    // the same echo; a fresh id is a new message the REST history then shows as sent from the
    // command line.
    let client = Uuid::new_v4();
    let rest_echo =
        s.w.rest_send(&token, s.a, &message_body(client, "같은 전송"))
            .await
            .expect(201)
            .json();
    let tool_echo =
        s.w.tool(
            &token,
            "oort_me_post",
            json!({"channelId": s.a, "clientMsgId": client, "body": "같은 전송"}),
        )
        .await;
    assert!(!tool_echo.is_error, "{tool_echo:?}");
    assert_eq!(
        tool_echo.structured, rest_echo,
        "a retried send is the same message"
    );
    assert_eq!(s.w.messages_with_client_id(client).await.len(), 1);
    assert_eq!(rest_echo["sentVia"], "dev");
}

// ---------------------------------------------------------------------------
// R14 (d) · R11 — the channel restriction through every tool
// ---------------------------------------------------------------------------

/// R14 (d) · R11: a token restricted to channel A. Through the tools, B (the holder's channel the
/// token does not list), C (a channel the holder is not in) and a channel that does not exist are
/// refused with the REST row's one answer — read, thread and post — and a refused send leaves the
/// ledger as it was. The list shows A alone; the inbox counts and lists A's items alone and carries
/// no card; and a channel the person has left is refused even though it is listed.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R11)"]
async fn a_restricted_token_reaches_the_same_channels_through_every_tool_as_through_the_rest_rows()
{
    let _guard = test_lock().await;
    let s = studio().await;
    let bot = seed_managed_agent(&s.w.su, s.w.ws, s.holder.id, "reviewbot")
        .await
        .id;
    let root_in_b =
        s.w.say(s.b, s.colleague.id, "B의 스레드 뿌리", Say::default())
            .await;
    s.plant_unread(s.a, "ALPHA", 10).await;
    s.plant_unread(s.b, "BRAVO", 5).await;
    s.w.pending_approval(s.b, bot, "NOTE-IN-B").await;
    let token = s.w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let unrestricted = s.full_card().await;
    let nowhere = Uuid::new_v4();

    // the control: the listed channel works, through every tool
    for (tool, arguments) in [
        ("oort_me_read", json!({"channelId": s.a})),
        (
            "oort_me_post",
            json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "허용된 채널"}),
        ),
    ] {
        let ok = s.w.tool(&token, tool, arguments).await;
        assert!(!ok.is_error, "{tool}: {ok:?}");
    }

    // read, thread and post outside the list: the REST row's refusal, whatever the reason
    let before_b = s.w.ledger(s.b).await;
    let before_c = s.w.ledger(s.c).await;
    for outside in [s.b, s.c, nowhere] {
        let rest_history =
            s.w.get(&token, &format!("channels/{outside}/messages"))
                .await;
        assert_eq!(rest_history.status, 403, "{rest_history:?}");
        assert_eq!(
            rest_history.json(),
            json!({"error": {"message": NOT_A_MEMBER}})
        );
        let expected = refusal_of(&rest_history);

        let read =
            s.w.tool(&token, "oort_me_read", json!({"channelId": outside}))
                .await;
        assert!(read.is_error, "{read:?}");
        assert_eq!(read.structured, expected, "history of {outside}");

        let rest_thread =
            s.w.get(
                &token,
                &format!("channels/{outside}/messages/{root_in_b}/replies"),
            )
            .await;
        let thread =
            s.w.tool(
                &token,
                "oort_me_read",
                json!({"channelId": outside, "threadRootId": root_in_b}),
            )
            .await;
        assert!(thread.is_error, "{thread:?}");
        assert_eq!(
            thread.structured,
            refusal_of(&rest_thread),
            "thread in {outside}"
        );
        assert_eq!(
            thread.structured, expected,
            "a thread says no more than a history"
        );

        let client = Uuid::new_v4();
        let rest_send =
            s.w.rest_send(&token, outside, &message_body(client, "밖으로"))
                .await;
        let send =
            s.w.tool(
                &token,
                "oort_me_post",
                json!({"channelId": outside, "clientMsgId": client, "body": "밖으로"}),
            )
            .await;
        assert!(send.is_error, "{send:?}");
        assert_eq!(send.structured, refusal_of(&rest_send), "send to {outside}");
        assert_eq!(send.structured, expected, "a send says no more than a read");
        assert!(
            s.w.messages_with_client_id(client).await.is_empty(),
            "nothing stored for {outside}"
        );
    }
    assert_eq!(s.w.ledger(s.b).await, before_b, "B is as it was");
    assert_eq!(s.w.ledger(s.c).await, before_c, "C is as it was");

    // the list and the inbox: A alone, as the REST rows give them, and no card
    let channels = s.w.tool(&token, "oort_me_channels", json!({})).await;
    let listed: Vec<String> = channels.structured["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .map(|channel| channel["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(listed, vec![s.a.to_string()]);
    let all_channels = s.w.tool(&unrestricted, "oort_me_channels", json!({})).await;
    assert_eq!(
        all_channels.structured["channels"].as_array().map(Vec::len),
        Some(2),
        "the unrestricted token lists A and B (not C): the control"
    );

    let inbox = s.w.tool(&token, "oort_me_inbox", json!({})).await;
    let wide = s.w.tool(&unrestricted, "oort_me_inbox", json!({})).await;
    assert_eq!(inbox.structured["approvalsPending"], json!([]));
    assert_eq!(wide.structured["approvalsPending"], json!([]));
    let text = inbox.structured.to_string();
    assert!(text.contains("ALPHA"), "A's items are there: {text}");
    assert!(!text.contains("BRAVO"), "B's items are not: {text}");
    assert!(!text.contains("NOTE-IN-B"));
    assert!(
        wide.structured.to_string().contains("BRAVO"),
        "the unrestricted token sees B's items: the control"
    );
    assert!(
        inbox.structured["unreadCount"].as_i64() < wide.structured["unreadCount"].as_i64(),
        "the count covers only A: {} vs {}",
        inbox.structured["unreadCount"],
        wide.structured["unreadCount"]
    );
    // …and it is the REST row's own answer for the same token
    let rest_inbox = s.w.get(&token, "inbox").await.expect(200).json();
    assert_eq!(inbox.structured, rest_inbox);

    // today's membership: leaving the listed channel closes it through the tools too
    sqlx::query("DELETE FROM membership WHERE channel_id = $1 AND member_id = $2")
        .bind(s.a)
        .bind(s.holder.id)
        .execute(&s.w.su)
        .await
        .expect("the holder leaves A");
    let rest_left = s.w.get(&token, &format!("channels/{}/messages", s.a)).await;
    assert_eq!(rest_left.status, 403);
    let left =
        s.w.tool(&token, "oort_me_read", json!({"channelId": s.a}))
            .await;
    assert!(left.is_error);
    assert_eq!(left.structured, refusal_of(&rest_left));
}

// ---------------------------------------------------------------------------
// R12 via MCP — the send
// ---------------------------------------------------------------------------

/// R12 through the tool: a post is sent as the person, `sent_via = 'dev'` in the row and `sentVia`
/// in the echo; a retry lands once; a thread reply works; the same text from the holder's session is
/// unmarked (so the mark follows the credential); and every key outside the five — each of the REST
/// body gate's refusals and the mark's own names — is refused as invalid arguments with nothing
/// stored.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R12)"]
async fn a_post_is_sent_as_the_person_marked_dev_stored_once_and_carries_nothing_else() {
    let _guard = test_lock().await;
    let s = studio().await;
    let token = s.full_card().await;
    let root =
        s.w.say(s.a, s.colleague.id, "스레드 뿌리", Say::default())
            .await;

    let client = Uuid::new_v4();
    let arguments =
        json!({"channelId": s.a, "clientMsgId": client, "body": "명령줄에서 보낸 안녕하세요"});
    let sent = s.w.tool(&token, "oort_me_post", arguments.clone()).await;
    assert!(!sent.is_error, "{sent:?}");
    assert_eq!(sent.structured["authorMemberId"], json!(s.holder.id));
    assert_eq!(sent.structured["body"], "명령줄에서 보낸 안녕하세요");
    assert_eq!(sent.structured["sentVia"], "dev");
    let message: Uuid = sent.structured["id"]
        .as_str()
        .expect("an id")
        .parse()
        .expect("a uuid");
    assert_eq!(s.w.sent_via(message).await.as_deref(), Some("dev"));

    // a retry is the same message, stored once
    let retry = s.w.tool(&token, "oort_me_post", arguments).await;
    assert_eq!(retry.structured, sent.structured);
    assert_eq!(s.w.messages_with_client_id(client).await, vec![message]);

    // a thread reply
    let reply_client = Uuid::new_v4();
    let reply = s.w.tool(&token, "oort_me_post", json!({
        "channelId": s.a, "clientMsgId": reply_client, "body": "스레드 답글", "rootId": root, "replyToId": null
    })).await;
    assert!(!reply.is_error, "{reply:?}");
    assert_eq!(reply.structured["rootId"], json!(root));
    assert_eq!(reply.structured["sentVia"], "dev");

    // the same text from the holder's own session: not marked
    let session_client = Uuid::new_v4();
    let echo =
        s.w.rest_send(
            &s.holder.jwt,
            s.a,
            &message_body(session_client, "세션에서 보낸 안녕하세요"),
        )
        .await
        .expect(201)
        .json();
    assert!(echo.get("sentVia").is_none(), "{echo}");
    let session_message = s.w.messages_with_client_id(session_client).await;
    assert_eq!(session_message.len(), 1);
    assert_eq!(s.w.sent_via(session_message[0]).await, None);

    // nothing but the five keys: each REST-body-gate key and the mark's own names are refused
    let ledger = s.w.ledger(s.a).await;
    let marked = s.w.marked_messages().await;
    let valid = json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "허용 밖 키"});
    for (key, value) in [
        ("props", json!({"momo.sent_via": "dev"})),
        ("runId", json!(Uuid::new_v4())),
        ("attachmentIds", json!([Uuid::new_v4()])),
        ("routing", json!({"model": "x"})),
        ("signature", json!("c2ln")),
        ("stream", json!({"rev": 0, "streaming": true})),
        (
            "harnessRefine",
            json!({"refinementId": "r", "trigger": "command", "scope": "workspace"}),
        ),
        ("apps", json!(["com.momo.plugins.gmail"])),
        ("type", json!("text")),
        ("sentVia", json!("dev")),
        ("sent_via", json!("dev")),
        ("authorMemberId", json!(s.third.id)),
    ] {
        let mut arguments = valid.clone();
        arguments[key] = value;
        let refused = s.w.call(&token, "oort_me_post", arguments).await;
        assert_eq!(refused.status, 400, "{key}: {refused:?}");
        assert_eq!(refused.json()["error"]["code"], -32602, "{key}");
    }
    for (what, arguments) in [
        (
            "an empty body",
            json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": ""}),
        ),
        (
            "no body",
            json!({"channelId": s.a, "clientMsgId": Uuid::new_v4()}),
        ),
        ("no clientMsgId", json!({"channelId": s.a, "body": "x"})),
        (
            "a body of 8001 bytes",
            json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "a".repeat(8001)}),
        ),
        (
            "a channel that is not a uuid",
            json!({"channelId": "general", "clientMsgId": Uuid::new_v4(), "body": "x"}),
        ),
    ] {
        let refused = s.w.call(&token, "oort_me_post", arguments).await;
        assert_eq!(refused.status, 400, "{what}: {refused:?}");
    }
    assert_eq!(
        s.w.ledger(s.a).await,
        ledger,
        "no refused call stored or counted anything"
    );
    assert_eq!(s.w.marked_messages().await, marked);

    // a thread root that does not exist is the REST row's own coded refusal
    let ghost = Uuid::new_v4();
    let rest =
        s.w.rest_send(
            &token,
            s.a,
            &json!({"clientMsgId": Uuid::new_v4(), "body": "x", "rootId": ghost}),
        )
        .await;
    let tool =
        s.w.tool(
            &token,
            "oort_me_post",
            json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "x", "rootId": ghost}),
        )
        .await;
    assert!(tool.is_error, "{tool:?}");
    assert_eq!(tool.structured, refusal_of(&rest));
}

// ---------------------------------------------------------------------------
// R13 via MCP — the budgets
// ---------------------------------------------------------------------------

fn budgets(per_token: u32, per_member: u32, write: u32) -> DevAccessConfig {
    DevAccessConfig {
        window_seconds: 60,
        per_token_limit: per_token,
        per_member_limit: per_member,
        write_per_token_limit: write,
    }
}

async fn audit_rows_of(w: &World, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(w.ws)
        .bind(action)
        .fetch_one(&w.su)
        .await
        .expect("count audit rows")
}

/// R13 through the tool. (1) The token's **send budget** is the counter the REST row spends: two
/// REST sends and one post exhaust a budget of three, and then a post and a REST send are both 429s
/// with a whole-second `Retry-After` — the post's body is the JSON-RPC rate-limit error — while a
/// read tool is still served and exactly three messages are stored. (2) The member's **send
/// budget** (the one `POST …/messages` wears as a route layer) is shared the same way between the
/// holder's session and the tool, and its first denial leaves one audit row. (3) The door's
/// per-token budget counts MCP POSTs: the fifth call of a budget of four is a 429 that writes no
/// `used` row.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R13)"]
async fn the_send_budgets_are_the_rest_rows_budgets_not_a_second_set() {
    let _guard = test_lock().await;

    // (1) the token's send budget
    {
        let s = studio_with(|state| state.with_dev_access(budgets(1000, 1000, 3))).await;
        let token = s.full_card().await;
        let mut sent = Vec::new();
        for index in 0..2 {
            let client = Uuid::new_v4();
            s.w.rest_send(&token, s.a, &message_body(client, &format!("REST {index}")))
                .await
                .expect(201);
            sent.push(client);
        }
        let third = Uuid::new_v4();
        let ok =
            s.w.tool(
                &token,
                "oort_me_post",
                json!({"channelId": s.a, "clientMsgId": third, "body": "MCP 3"}),
            )
            .await;
        assert!(!ok.is_error, "{ok:?}");
        sent.push(third);

        let over =
            s.w.call(
                &token,
                "oort_me_post",
                json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "MCP 4"}),
            )
            .await;
        over.expect(429);
        assert!((1..=60).contains(&over.retry_after()), "{over:?}");
        assert_eq!(
            over.json(),
            json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32029, "message": "rate limit exceeded"}})
        );
        let rest_over =
            s.w.rest_send(&token, s.a, &message_body(Uuid::new_v4(), "REST 5"))
                .await;
        rest_over.expect(429);
        assert!((1..=60).contains(&rest_over.retry_after()));
        // reads are not sends: the same token is still served
        let read = s.w.tool(&token, "oort_me_channels", json!({})).await;
        assert!(!read.is_error);
        assert_eq!(
            s.w.ledger(s.a).await.messages,
            3,
            "exactly the three admitted sends are stored"
        );
        for client in sent {
            assert_eq!(s.w.messages_with_client_id(client).await.len(), 1);
        }
    }

    // (2) the member's send budget, shared with the holder's own session
    {
        let s = studio_with(|state| {
            state.with_rate_limit(RateLimitConfig {
                message_send_per_member_limit: 2,
                ..RateLimitConfig::default()
            })
        })
        .await;
        let token = s.full_card().await;
        s.w.rest_send(&s.holder.jwt, s.a, &message_body(Uuid::new_v4(), "세션 1"))
            .await
            .expect(201);
        let ok =
            s.w.tool(
                &token,
                "oort_me_post",
                json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "MCP 2"}),
            )
            .await;
        assert!(!ok.is_error, "{ok:?}");
        assert_eq!(audit_rows_of(&s.w, "rate_limit.exceeded").await, 0);

        let over =
            s.w.call(
                &token,
                "oort_me_post",
                json!({"channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "MCP 3"}),
            )
            .await;
        over.expect(429);
        assert!((1..=60).contains(&over.retry_after()), "{over:?}");
        assert_eq!(over.json()["error"]["code"], -32029);
        let session_over =
            s.w.rest_send(&s.holder.jwt, s.a, &message_body(Uuid::new_v4(), "세션 3"))
                .await;
        session_over.expect(429);
        assert_eq!(s.w.ledger(s.a).await.messages, 2, "two sends, shared");
        assert_eq!(
            audit_rows_of(&s.w, "rate_limit.exceeded").await,
            1,
            "the first denial of the burst is audited once, as the REST row audits it"
        );
        let read =
            s.w.tool(&token, "oort_me_read", json!({"channelId": s.a}))
                .await;
        assert!(!read.is_error, "a read spends no send budget");
    }

    // (3) the door's per-token budget counts MCP POSTs, and a 429 writes nothing
    {
        let s = studio_with(|state| state.with_dev_access(budgets(4, 1000, 30))).await;
        let (id, token) = s.w.card_row(s.holder.id, &DEV_SCOPES, None).await;
        for _ in 0..4 {
            s.w.list(&token, Era::Legacy).await.expect(200);
        }
        let over = s.w.list(&token, Era::Legacy).await;
        over.expect(429);
        assert!((1..=60).contains(&over.retry_after()), "{over:?}");
        assert_eq!(
            over.json(),
            json!({"error": {"message": "rate limit exceeded"}})
        );
        assert_eq!(s.w.used_rows(id).await.len(), 4, "the 429 is not a use");
        assert!(s.w.last_used(id).await);
    }
}

// ---------------------------------------------------------------------------
// R14 (e) — only a POST; the Origin
// ---------------------------------------------------------------------------

/// R14 (e): every other method on the route is not a 200 — a developer token gets the closed
/// table's 403 `dev_route_not_allowed` (HEAD with no body), a session JWT and no credential a 401 —
/// while the POST of the same token works. An `Origin` the operator did not name is a 403 with no
/// body before anything is spent: no `used` row, no `last_used_at`, and the budget of one call is
/// still there for the next request.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R14)"]
async fn only_a_post_is_answered_and_a_foreign_origin_is_refused_before_anything_is_spent() {
    let _guard = test_lock().await;

    let s = studio().await;
    let token = s.full_card().await;
    let url = format!("{}/v1/mcp/me", s.w.base);
    for method in [
        Method::GET,
        Method::DELETE,
        Method::PUT,
        Method::PATCH,
        Method::HEAD,
        Method::OPTIONS,
    ] {
        let with_token =
            s.w.send_request(s.w.http.request(method.clone(), &url).bearer_auth(&token))
                .await;
        assert_eq!(with_token.status, 403, "{method}: {with_token:?}");
        if method != Method::HEAD {
            assert_eq!(
                with_token.json(),
                json!({"error": {"message": "developer token is not allowed for this route", "code": "dev_route_not_allowed"}}),
                "{method}"
            );
        }
        let with_session =
            s.w.send_request(
                s.w.http
                    .request(method.clone(), &url)
                    .bearer_auth(&s.holder.jwt),
            )
            .await;
        assert_eq!(with_session.status, 401, "{method}: {with_session:?}");
        let without =
            s.w.send_request(s.w.http.request(method.clone(), &url))
                .await;
        assert_eq!(without.status, 401, "{method}: {without:?}");
    }
    // the control: the POST of the same token on the same route
    s.w.list(&token, Era::Modern).await.expect(200);

    // a foreign Origin: refused first, spending nothing
    let s = studio_with(|state| state.with_dev_access(budgets(1, 1000, 30))).await;
    let (id, token) = s.w.card_row(s.holder.id, &DEV_SCOPES, None).await;
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}});
    let post = |origin: Option<&'static str>| {
        let mut request =
            s.w.http
                .post(format!("{}/v1/mcp/me", s.w.base))
                .bearer_auth(&token)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", LEGACY)
                .header("mcp-method", "tools/list")
                .json(&body);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        s.w.send_request(request)
    };
    for origin in ["https://evil.example", "null", "http://localhost:3000"] {
        let refused = post(Some(origin)).await;
        assert_eq!(refused.status, 403, "{origin}: {refused:?}");
        assert!(refused.body.is_empty(), "{origin}: no body to learn from");
        assert_eq!(refused.header("cache-control"), Some("private, no-store"));
    }
    assert!(
        s.w.used_rows(id).await.is_empty(),
        "a refused Origin is not a use"
    );
    assert!(!s.w.last_used(id).await, "…and touches nothing");
    // the budget of one call is untouched: the next call is served, the one after is a 429
    post(None).await.expect(200);
    post(None).await.expect(429);
}

// ---------------------------------------------------------------------------
// the transport
// ---------------------------------------------------------------------------

/// The route's wire discipline is the Agent Port's: no query string, one `Content-Type`, a 64 KiB
/// body, one JSON object (no batch), an `Accept` that names JSON; answers are `private, no-store`
/// and never echo an `Mcp-Session-Id`; and a valid token anywhere but `Authorization` is no
/// credential.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D5)"]
async fn the_transport_is_bounded_stateless_and_private() {
    let _guard = test_lock().await;
    let s = studio().await;
    let token = s.full_card().await;
    let url = format!("{}/v1/mcp/me", s.w.base);
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}});
    let base = |bearer: bool| {
        let mut request =
            s.w.http
                .post(&url)
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", LEGACY)
                .header("mcp-method", "tools/list");
        if bearer {
            request = request.bearer_auth(&token);
        }
        request
    };

    // the control, and what an answer carries
    let ok =
        s.w.send_request(
            base(true)
                .header("content-type", "application/json")
                .header("mcp-session-id", "attacker-chosen")
                .body(list.to_string()),
        )
        .await;
    ok.expect(200);
    assert_eq!(ok.header("cache-control"), Some("private, no-store"));
    assert!(ok.header("mcp-session-id").is_none(), "{ok:?}");

    // a query string is refused (a token never travels there)
    let query =
        s.w.send_request(
            s.w.http
                .post(format!("{url}?x=1"))
                .bearer_auth(&token)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("mcp-protocol-version", LEGACY)
                .header("mcp-method", "tools/list")
                .body(list.to_string()),
        )
        .await;
    query.expect(400);
    assert_eq!(query.json()["error"]["code"], -32600);

    // …and a token that is only in the query is no credential at all
    let only_query =
        s.w.send_request(
            s.w.http
                .post(format!("{url}?access_token={token}"))
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(list.to_string()),
        )
        .await;
    assert_eq!(only_query.status, 401, "{only_query:?}");

    // two Content-Type headers
    let two_types =
        s.w.send_request(
            base(true)
                .header("content-type", "application/json")
                .header("content-type", "application/json; charset=utf-8")
                .body(list.to_string()),
        )
        .await;
    two_types.expect(400);

    // a body over the 64 KiB bound
    let huge =
        s.w.send_request(
            base(true)
                .header("content-type", "application/json")
                .body(vec![b' '; 64 * 1024 + 1]),
        )
        .await;
    huge.expect(413);
    assert_eq!(huge.json()["error"]["code"], -32600);

    // a batch is not an object
    let batch =
        s.w.send_request(
            base(true)
                .header("content-type", "application/json")
                .body(format!("[{list}]")),
        )
        .await;
    batch.expect(400);
    assert_eq!(batch.json()["error"]["code"], -32600);

    // content types the contract does not take
    let text =
        s.w.send_request(
            base(true)
                .header("content-type", "text/plain")
                .body(list.to_string()),
        )
        .await;
    text.expect(415);
    let no_sse =
        s.w.send_request(
            s.w.http
                .post(&url)
                .bearer_auth(&token)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .header("mcp-protocol-version", LEGACY)
                .header("mcp-method", "tools/list")
                .body(list.to_string()),
        )
        .await;
    no_sse.expect(415);
}

// ---------------------------------------------------------------------------
// R15 via MCP — what the door writes
// ---------------------------------------------------------------------------

/// R15 through the route: each admitted POST leaves exactly one `auth.dev_token.used` row whose
/// `detail` is the closed vocabulary with the route **template** `/v1/mcp/me`; and nothing the tools
/// carried — the text of a sent message, a channel id, the token — is in any audit row of the
/// workspace.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 R15)"]
async fn an_admitted_call_leaves_one_used_row_for_the_template_and_no_tool_content() {
    let _guard = test_lock().await;
    let s = studio().await;
    let (id, token) = s.w.card_row(s.holder.id, &DEV_SCOPES, None).await;
    let secret_text = "MARKER-달무리-7c1e-본문";

    s.w.list(&token, Era::Legacy).await.expect(200);
    let read =
        s.w.tool(&token, "oort_me_read", json!({"channelId": s.a}))
            .await;
    assert!(!read.is_error);
    let sent =
        s.w.tool(
            &token,
            "oort_me_post",
            json!({
                "channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": secret_text
            }),
        )
        .await;
    assert!(!sent.is_error, "{sent:?}");

    let rows = s.w.used_rows(id).await;
    assert_eq!(rows.len(), 3, "one row per admitted POST: {rows:?}");
    for row in &rows {
        assert_eq!(
            row,
            &json!({
                "schema": "momo.dev_token.use.v1",
                "method": "POST",
                "route": "/v1/mcp/me",
                "required_scope": "dev:identity",
                "granted": true,
            })
        );
    }
    // nothing the tools carried reached any audit row of the workspace
    let everything: String = sqlx::query_scalar(
        "SELECT coalesce(string_agg(action || ' ' || coalesce(detail::text, '') || ' ' || \
                                    coalesce(target_type, ''), E'\\n'), '') \
           FROM audit_log WHERE workspace_id = $1",
    )
    .bind(s.w.ws)
    .fetch_one(&s.w.su)
    .await
    .expect("the audit text");
    for forbidden in [
        secret_text.to_string(),
        s.a.to_string(),
        token.clone(),
        token.rsplit('.').next().expect("a secret").to_string(),
    ] {
        assert!(
            !everything.contains(&forbidden),
            "the audit holds {forbidden:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// the door's per-request judgement, through the route
// ---------------------------------------------------------------------------

/// D3 · D7 through the MCP route: a card that was revoked is the unknown-token 401 (the same bytes
/// as a string nobody knows) on the next call, and a holder whose role the fixed switch no longer
/// admits gets 403 `dev_access_denied` on the next call — the route caches no admission.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (ADR-0216 D3)"]
async fn the_door_judges_revocation_and_the_role_policy_on_every_mcp_call() {
    let _guard = test_lock().await;
    let s = studio().await;
    let (id, token) = s.w.card_row(s.holder.id, &DEV_SCOPES, None).await;
    let unknown = s.w.list("not-a-token", Era::Legacy).await;
    assert_eq!(unknown.status, 401);

    s.w.tool(&token, "oort_me_whoami", json!({})).await;
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
        .bind(id)
        .execute(&s.w.su)
        .await
        .expect("revoke the card");
    let revoked = s.w.list(&token, Era::Legacy).await;
    assert_eq!(revoked, unknown, "a revoked card is an unknown string");
    assert_eq!(s.w.call(&token, "oort_me_whoami", json!({})).await, unknown);

    // a live card, then the holder is demoted to a member (the shipped switch admits owner and admin)
    let live = s.w.card(s.holder.id, &DEV_SCOPES, None).await;
    s.w.list(&live, Era::Legacy).await.expect(200);
    sqlx::query(
        "UPDATE workspace_membership SET role = 'member'::membership_role \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(s.w.ws)
    .bind(s.holder.id)
    .execute(&s.w.su)
    .await
    .expect("demote the holder");
    let denied = s.w.list(&live, Era::Legacy).await;
    assert_eq!(denied.status, 403, "{denied:?}");
    assert_eq!(denied.json()["error"]["code"], "dev_access_denied");
    let denied_call =
        s.w.call(
            &live,
            "oort_me_post",
            json!({
                "channelId": s.a, "clientMsgId": Uuid::new_v4(), "body": "강등 뒤의 전송"
            }),
        )
        .await;
    assert_eq!(denied_call.status, 403);
    assert_eq!(
        s.w.ledger(s.a).await.messages,
        0,
        "a demoted holder's tool sends nothing"
    );
}
