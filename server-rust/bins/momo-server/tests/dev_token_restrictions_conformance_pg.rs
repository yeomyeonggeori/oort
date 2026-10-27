//! ADR-0216 R11 · R12 — what a **developer token** may reach (the channel restriction) and what
//! it may send (the body allow-list and the `sent_via = 'dev'` mark), on a real PostgreSQL and
//! the real Axum router (`momo_app`, NOBYPASSRLS). `#[ignore]`: it needs a pgvector/pg18
//! superuser URL, so run it on an isolated database and one test thread:
//!
//! ```text
//! DATABASE_URL=postgres://momo:<pw>@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dev_token_restrictions_conformance_pg \
//!   -- --ignored --test-threads=1
//! ```
//!
//! Every test builds its own workspace (달무리 스튜디오), its own people (이도현 holds the
//! tokens; 박서연 and 최민수 write what the tools read) and its own server, so a test never
//! sees another's rows. The refusals are compared with **the answer the app already gave** for
//! a channel that does not exist or that the caller is not in (ADR-0216 D4: no existence
//! oracle), and every "nothing / empty / absent" assertion sits beside the same request that
//! must show the thing.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_restricted_token_cannot_read_a_channel_outside_its_list_and_is_told_what_a_missing_channel_is_told` | `history` stops asking the restriction (`.admits(..)` → `true`) |
//! | `a_restricted_token_cannot_read_a_thread_outside_its_list_and_is_told_what_a_missing_channel_is_told` | `replies` stops asking the restriction |
//! | `a_restricted_token_cannot_send_outside_its_list_and_is_told_what_a_missing_channel_is_told` | `send` stops asking the restriction (nothing may be stored either) |
//! | `the_channel_list_of_a_restricted_token_omits_every_other_channel_and_the_limit_counts_only_what_it_may_see` | the channel list drops its restriction, or applies it after `LIMIT` |
//! | `the_inbox_of_a_restricted_token_lists_and_counts_only_its_channels_and_never_carries_an_approval_card` | the approval list is read for a developer token; `unreadCount` or `items` ignore the restriction |
//! | `an_inbox_page_of_a_restricted_token_is_full_and_ends_where_its_channels_end` | the restriction becomes a filter over the page instead of an argument of the read |
//! | `a_member_who_left_a_listed_channel_is_refused_there_and_gets_it_back_when_added_again` | today's membership stops being asked (history guard, channel list or inbox join): the token's stored list alone is trusted |
//! | `a_card_for_a_channel_the_person_is_not_in_is_refused_at_issuance_and_a_route_issued_card_keeps_its_restriction` | the issue route stops checking channel membership |
//! | `a_developer_send_with_any_field_outside_the_allow_list_is_a_coded_400_and_stores_nothing` | `dev_send_body_gate` is removed or lets one of the keys through |
//! | `a_developer_send_that_is_not_one_plain_json_object_is_refused_and_stores_nothing` | the gate stops judging the raw bytes |
//! | `a_message_sent_with_a_developer_token_is_marked_dev_and_the_same_body_from_a_session_is_not` | the mark is derived from the request, dropped, or put on a session's message |
//! | `a_session_cannot_imitate_the_dev_mark_through_sent_via_or_props` | the mark is read from a request field |
//! | `an_authors_edit_keeps_the_dev_mark` | the edit statement rewrites `sent_via` |
//! | `a_retried_developer_send_lands_once` | the send statement loses its `ON CONFLICT … DO NOTHING` (a retry stops landing once) |
//! | `a_read_only_token_reads_channels_history_threads_and_inbox_and_a_write_scope_is_what_lets_it_send` | the closed table or the scope check stops letting L3–L7 through |

#[path = "common/apps_pg.rs"]
mod apps_pg;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use apps_pg::{
    ensure_schema_and_roles, momo_app_pool, seed_managed_agent, start_server, superuser_pool,
    ServerOptions,
};
use momo_auth::{
    issue_dev_card_in_tx, DevTool, NewDevCard, DEV_FIXED_POLICY, DEV_READ_ONLY_SCOPES, DEV_SCOPES,
};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

/// A made-up password for the made-up people; the issue route asks for it again.
const PASSWORD: &str = "dalmuri-fixture-passphrase";
/// What the app has always answered for a channel the caller cannot reach (403, not 404).
const NOT_A_MEMBER: &str = "not a member of this channel";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// what a request answered
// ---------------------------------------------------------------------------

/// Status, headers (but the clock) and the body bytes of one answer — everything a client
/// could tell two answers apart by.
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

    fn error_code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_string)
    }

    /// The status, with the whole answer in the failure message.
    fn expect(&self, status: u16) -> &Reply {
        assert_eq!(self.status, status, "{self:?}");
        self
    }
}

/// Two answers a client must not be able to tell apart.
fn assert_same_answer(left: &Reply, right: &Reply, what: &str) {
    assert_eq!(left, right, "{what}: the two answers differ");
}

/// The app's own refusal of a channel the caller cannot reach.
fn assert_not_a_member(reply: &Reply, what: &str) {
    assert_eq!(reply.status, 403, "{what}: {reply:?}");
    assert_eq!(
        reply.json(),
        json!({"error": {"message": NOT_A_MEMBER}}),
        "{what}: {reply:?}"
    );
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
    /// A real session access token, from the login route.
    jwt: String,
}

/// How a seeded message relates to the others. All off = a plain message, now.
#[derive(Default, Clone, Copy)]
struct Say {
    reply_to: Option<Uuid>,
    root: Option<Uuid>,
    mention: Option<Uuid>,
    minutes_ago: i64,
}

/// What the three tables hold for one channel (and the outbox for its workspace) — what a
/// refused send must leave exactly as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ledger {
    messages: i64,
    last_seq: i64,
    outbox: i64,
}

impl World {
    async fn new() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let ws = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, '달무리 스튜디오')")
            .bind(ws)
            .bind(format!("dalmuri-{}", ws.simple()))
            .execute(&su)
            .await
            .expect("seed workspace");
        let base = start_server(app.clone(), ServerOptions::default()).await;
        World {
            http: reqwest::Client::new(),
            base,
            su,
            app,
            ws,
        }
    }

    /// A person with a password, a workspace role and a **real login** (so the session row is
    /// the one the issue route checks for liveness).
    async fn person(&self, role: &str, name: &str) -> Person {
        let id = Uuid::new_v4();
        let email = format!("{id}@dalmuri.test");
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'human', $3, $3)",
        )
        .bind(id)
        .bind(self.ws)
        .bind(name)
        .execute(&self.su)
        .await
        .expect("seed member");
        sqlx::query(
            "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
             VALUES ($1, $2, $3, true, momo_password_hash($4))",
        )
        .bind(id)
        .bind(self.ws)
        .bind(&email)
        .bind(PASSWORD)
        .execute(&self.su)
        .await
        .expect("seed human");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, $3::membership_role)",
        )
        .bind(self.ws)
        .bind(id)
        .bind(role)
        .execute(&self.su)
        .await
        .expect("seed workspace membership");
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({"email": email, "password": PASSWORD, "workspace": self.ws.to_string()}))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200, "login of {name}");
        let body: Value = response.json().await.expect("login body");
        Person {
            id,
            jwt: body["accessToken"]
                .as_str()
                .expect("accessToken")
                .to_string(),
        }
    }

    /// A public channel with `members` in it (the first one created it).
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

    /// A pending approval card in `channel`, requested by `agent` (the rows the existing inbox
    /// suite plants; the card's `payload` carries `note` so a leak is findable by text).
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

    /// A developer card, issued through the domain function exactly as the route does (the
    /// route's own checks are the subject of one test below). Returns the bearer envelope.
    async fn card(&self, member: Uuid, scopes: &[&str], channels: Option<&[Uuid]>) -> String {
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
        issued.secret
    }

    // ---- requests -------------------------------------------------------

    fn ws_url(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}/{tail}", self.base, self.ws)
    }

    async fn call(
        &self,
        method: Method,
        url: String,
        bearer: &str,
        body: Option<Vec<u8>>,
    ) -> Reply {
        let mut request = self.http.request(method, url).bearer_auth(bearer);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
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

    async fn get(&self, bearer: &str, tail: &str) -> Reply {
        self.call(Method::GET, self.ws_url(tail), bearer, None)
            .await
    }

    async fn post(&self, bearer: &str, tail: &str, body: &Value) -> Reply {
        let bytes = serde_json::to_vec(body).expect("encode the body");
        self.call(Method::POST, self.ws_url(tail), bearer, Some(bytes))
            .await
    }

    async fn history(&self, bearer: &str, channel: Uuid) -> Reply {
        self.get(bearer, &format!("channels/{channel}/messages"))
            .await
    }

    async fn replies(&self, bearer: &str, channel: Uuid, root: Uuid) -> Reply {
        self.get(
            bearer,
            &format!("channels/{channel}/messages/{root}/replies"),
        )
        .await
    }

    async fn send(&self, bearer: &str, channel: Uuid, body: &Value) -> Reply {
        self.post(bearer, &format!("channels/{channel}/messages"), body)
            .await
    }

    async fn send_raw(&self, bearer: &str, channel: Uuid, body: Vec<u8>) -> Reply {
        self.call(
            Method::POST,
            self.ws_url(&format!("channels/{channel}/messages")),
            bearer,
            Some(body),
        )
        .await
    }

    async fn channel_list(&self, bearer: &str, query: &str) -> Reply {
        self.get(bearer, &format!("channels{query}")).await
    }

    async fn inbox(&self, bearer: &str, query: &str) -> Reply {
        self.get(bearer, &format!("inbox{query}")).await
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

    /// The ids of the messages stored under one `clientMsgId` (any author, any channel).
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

    /// The realtime frame (`message.new`, `message.edited`) the outbox holds for `message`, as the
    /// relay would publish it. Panics when there is not exactly one.
    async fn frame(&self, event: &str, message: Uuid) -> Value {
        let mut frames: Vec<Value> = sqlx::query_scalar(
            "SELECT payload FROM outbox \
              WHERE workspace_id = $1 AND kind = 'broadcast' \
                AND payload #>> '{data,type}' = $2 \
                AND payload #>> '{data,payload,id}' = $3",
        )
        .bind(self.ws)
        .bind(event)
        .bind(message.to_string())
        .fetch_all(&self.su)
        .await
        .expect("read outbox frames");
        assert_eq!(frames.len(), 1, "expected one {event} frame for {message}");
        frames.remove(0)["data"]["payload"].take()
    }

    /// How many messages of the workspace carry any `sent_via` mark.
    async fn marked_messages(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM message WHERE workspace_id = $1 AND sent_via IS NOT NULL",
        )
        .bind(self.ws)
        .fetch_one(&self.su)
        .await
        .expect("count marked messages")
    }
}

/// 달무리 스튜디오 at work: the token holder, two colleagues and three channels.
struct Studio {
    w: World,
    /// 이도현 — a workspace **admin** (the fixed switch admits owner and admin only), the
    /// person whose tools the tests give developer tokens to.
    holder: Person,
    /// 박서연 and 최민수 — they write what the holder's tools read.
    colleague: Person,
    third: Person,
    /// The channel a restricted token lists (the holder, 박서연).
    a: Uuid,
    /// A channel the holder is in but a restricted token does not list (+ 최민수). Its name
    /// sorts before A's, so an unrestricted list puts it first.
    b: Uuid,
    /// A channel the holder is **not** in (박서연, 최민수).
    c: Uuid,
}

async fn studio() -> Studio {
    let w = World::new().await;
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

impl Studio {
    /// Two unread inbox items for the holder in `channel`: a quote of the holder's own message
    /// and an @mention, both from 박서연. Ages: the holder's own message `minutes_ago + 2`, the
    /// quote `minutes_ago + 1`, the mention `minutes_ago` (so the mention is the newest item).
    /// Returns the ids of the two **inbox messages** `(quote, mention)`.
    async fn plant_unread(&self, channel: Uuid, tag: &str, minutes_ago: i64) -> (Uuid, Uuid) {
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
        let quote = self
            .w
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
        let mention = self
            .w
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
        (quote, mention)
    }
}

/// `POST …/dev-access/credentials` as the holder's own session, with the right password.
async fn issue_card_for(s: &Studio, channel_ids: Value) -> Reply {
    let body = json!({
        "name": "달무리 명령줄",
        "tool": "cli",
        "channelIds": channel_ids,
        "currentPassword": PASSWORD,
    });
    s.w.post(&s.holder.jwt, "dev-access/credentials", &body)
        .await
}

/// How many developer-token rows a member has (any form, any state).
async fn dev_cards_of(w: &World, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE actor_member_id = $1 AND kind::text = 'dev'",
    )
    .bind(member)
    .fetch_one(&w.su)
    .await
    .expect("count developer tokens")
}

fn text_body(text: &str) -> Value {
    json!({"clientMsgId": Uuid::new_v4(), "body": text})
}

fn channel_ids(list: &Reply) -> BTreeSet<String> {
    list.json()["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .map(|channel| channel["id"].as_str().expect("channel id").to_string())
        .collect()
}

fn inbox_message_ids(page: &Value) -> BTreeSet<String> {
    page["items"]
        .as_array()
        .expect("items array")
        .iter()
        .map(|item| {
            item["message"]["id"]
                .as_str()
                .expect("item message id")
                .to_string()
        })
        .collect()
}

/// The message with `id` on a history or thread page (its `messages` array).
fn message_in(page: &Value, id: Uuid) -> &Value {
    page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|message| message["id"] == id.to_string())
        .unwrap_or_else(|| panic!("message {id} is not on the page: {page}"))
}

// ---------------------------------------------------------------------------
// R11 — the channel restriction
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_restricted_token_cannot_read_a_channel_outside_its_list_and_is_told_what_a_missing_channel_is_told(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    w.say(s.a, s.colleague.id, "A-ROOM-HISTORY", Say::default())
        .await;
    w.say(s.b, s.colleague.id, "B-ROOM-HISTORY", Say::default())
        .await;
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let nowhere = Uuid::new_v4();

    // Positive controls: the restricted token reads its own channel, and without the
    // restriction the very same member reads B. So the refusal below is the restriction's.
    let inside = w.history(&restricted, s.a).await;
    assert!(
        inside.expect(200).text().contains("A-ROOM-HISTORY"),
        "{inside:?}"
    );
    let without_restriction = w.history(&open, s.b).await;
    assert!(
        without_restriction
            .expect(200)
            .text()
            .contains("B-ROOM-HISTORY"),
        "{without_restriction:?}"
    );

    // R11: B is refused, with the answer a channel that does not exist gets — and the answer
    // a real channel the caller is not in gets, from a developer token and from a session.
    let outside = w.history(&restricted, s.b).await;
    assert_not_a_member(&outside, "restricted token, a channel outside its list");
    assert!(!outside.text().contains("B-ROOM-HISTORY"), "{outside:?}");
    assert_same_answer(
        &outside,
        &w.history(&restricted, nowhere).await,
        "outside the list vs. a channel that does not exist",
    );
    assert_same_answer(
        &outside,
        &w.history(&open, s.c).await,
        "outside the list vs. a real channel the member is not in",
    );
    assert_same_answer(
        &outside,
        &w.history(&s.holder.jwt, nowhere).await,
        "outside the list vs. what a person's session was always told for a missing channel",
    );
    assert_same_answer(
        &outside,
        &w.history(&s.holder.jwt, s.c).await,
        "outside the list vs. what a person's session was always told for a channel it is not in",
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_restricted_token_cannot_read_a_thread_outside_its_list_and_is_told_what_a_missing_channel_is_told(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let a_root = w
        .say(s.a, s.colleague.id, "A-ROOM-THREAD-ROOT", Say::default())
        .await;
    w.say(
        s.a,
        s.holder.id,
        "A-ROOM-THREAD-REPLY",
        Say {
            root: Some(a_root),
            ..Say::default()
        },
    )
    .await;
    let b_root = w
        .say(s.b, s.colleague.id, "B-ROOM-THREAD-ROOT", Say::default())
        .await;
    w.say(
        s.b,
        s.third.id,
        "B-ROOM-THREAD-REPLY",
        Say {
            root: Some(b_root),
            ..Say::default()
        },
    )
    .await;
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let nowhere = Uuid::new_v4();

    // Positive controls (same two as for the history).
    let inside = w.replies(&restricted, s.a, a_root).await;
    assert!(
        inside.expect(200).text().contains("A-ROOM-THREAD-REPLY"),
        "{inside:?}"
    );
    let without_restriction = w.replies(&open, s.b, b_root).await;
    assert!(
        without_restriction
            .expect(200)
            .text()
            .contains("B-ROOM-THREAD-REPLY"),
        "{without_restriction:?}"
    );

    // The refusal does not look at the root, so the same root id is used everywhere.
    let outside = w.replies(&restricted, s.b, b_root).await;
    assert_not_a_member(&outside, "restricted token, a thread outside its list");
    assert!(!outside.text().contains("B-ROOM-THREAD"), "{outside:?}");
    assert_same_answer(
        &outside,
        &w.replies(&restricted, nowhere, b_root).await,
        "outside the list vs. a channel that does not exist",
    );
    assert_same_answer(
        &outside,
        &w.replies(&open, s.c, b_root).await,
        "outside the list vs. a real channel the member is not in",
    );
    assert_same_answer(
        &outside,
        &w.replies(&s.holder.jwt, nowhere, b_root).await,
        "outside the list vs. what a person's session was always told for a missing channel",
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_restricted_token_cannot_send_outside_its_list_and_is_told_what_a_missing_channel_is_told(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let nowhere = Uuid::new_v4();
    let secret_text = "B-ROOM-WRITE-ATTEMPT";

    // The four refusals first, with nothing stored anywhere while they happen.
    let (b_before, c_before) = (w.ledger(s.b).await, w.ledger(s.c).await);
    let outside = w.send(&restricted, s.b, &text_body(secret_text)).await;
    assert_not_a_member(&outside, "restricted token, a channel outside its list");
    assert_same_answer(
        &outside,
        &w.send(&restricted, nowhere, &text_body(secret_text)).await,
        "outside the list vs. a channel that does not exist",
    );
    assert_same_answer(
        &outside,
        &w.send(&open, s.c, &text_body(secret_text)).await,
        "outside the list vs. a real channel the member is not in",
    );
    assert_same_answer(
        &outside,
        &w.send(&s.holder.jwt, nowhere, &text_body(secret_text))
            .await,
        "outside the list vs. what a person's session was always told for a missing channel",
    );
    assert_eq!(
        w.ledger(s.b).await,
        b_before,
        "a refused send changed B's messages, last_seq or the outbox"
    );
    assert_eq!(w.ledger(s.c).await, c_before);
    // This workspace only: the database is shared with every other run, and a sabotaged run
    // that stored the text would otherwise poison this assertion for all the runs after it.
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1 AND body = $2")
            .bind(w.ws)
            .bind(secret_text)
            .fetch_one(&w.su)
            .await
            .expect("count");
    assert_eq!(stored, 0, "the refused text was stored somewhere");

    // Positive controls: the same token sends to its own channel (a stored row, a bumped
    // last_seq, an outbox row), and the unrestricted token sends to B. So what stopped the
    // sends above was the restriction.
    let a_before = w.ledger(s.a).await;
    w.send(&restricted, s.a, &text_body("A-ROOM-WRITE-OK"))
        .await
        .expect(201);
    let a_after = w.ledger(s.a).await;
    assert_eq!(a_after.messages, a_before.messages + 1);
    assert_eq!(a_after.last_seq, a_before.last_seq + 1);
    assert!(
        a_after.outbox > a_before.outbox,
        "no outbox row for the send"
    );
    w.send(&open, s.b, &text_body("B-ROOM-WRITE-OK"))
        .await
        .expect(201);
    assert_eq!(w.ledger(s.b).await.messages, b_before.messages + 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_channel_list_of_a_restricted_token_omits_every_other_channel_and_the_limit_counts_only_what_it_may_see(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let (a, b) = (s.a.to_string(), s.b.to_string());

    // Positive controls: the unrestricted token and the person's own session list both A and
    // B (and not C, which the holder is not in).
    let everything: BTreeSet<String> = [a.clone(), b.clone()].into();
    let open_list = w.channel_list(&open, "").await;
    assert_eq!(
        channel_ids(open_list.expect(200)),
        everything,
        "{open_list:?}"
    );
    let person_list = w.channel_list(&s.holder.jwt, "").await;
    assert_eq!(channel_ids(person_list.expect(200)), everything);

    // R11: the restricted token's list is A and nothing else, and says nothing of B.
    let restricted_list = w.channel_list(&restricted, "").await;
    assert_eq!(
        channel_ids(restricted_list.expect(200)),
        BTreeSet::from([a.clone()]),
        "{restricted_list:?}"
    );
    assert!(!restricted_list.text().contains(&b), "{restricted_list:?}");

    // The restriction rides the statement, not the rows: B sorts first, so a `limit=1` list
    // that was filtered afterwards would come back empty. Unrestricted it is B; restricted it
    // is still A.
    let first_open = w.channel_list(&open, "?limit=1").await;
    assert_eq!(
        channel_ids(first_open.expect(200)),
        BTreeSet::from([b.clone()]),
        "B must be first without the restriction: {first_open:?}"
    );
    let first_restricted = w.channel_list(&restricted, "?limit=1").await;
    assert_eq!(
        channel_ids(first_restricted.expect(200)),
        BTreeSet::from([a]),
        "{first_restricted:?}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_inbox_of_a_restricted_token_lists_and_counts_only_its_channels_and_never_carries_an_approval_card(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    // Planted before anything is read: in each of A and B two unread items for the holder (a
    // quote of the holder's own message and an @mention) and one pending approval card.
    let (a_quote, a_mention) = s.plant_unread(s.a, "A-ROOM", 10).await;
    let (b_quote, b_mention) = s.plant_unread(s.b, "B-ROOM", 5).await;
    let bot = seed_managed_agent(&w.su, w.ws, s.holder.id, "deploybot").await;
    w.pending_approval(s.a, bot.id, "A-ROOM-APPROVAL").await;
    w.pending_approval(s.b, bot.id, "B-ROOM-APPROVAL").await;
    let planted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inbox_item WHERE member_id = $1 AND read_at IS NULL",
    )
    .bind(s.holder.id)
    .fetch_one(&w.su)
    .await
    .expect("count planted items");
    assert_eq!(planted, 4, "the fixture must hold four unread items");
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let (a, b) = (s.a.to_string(), s.b.to_string());
    let all_four: BTreeSet<String> = [a_quote, a_mention, b_quote, b_mention]
        .iter()
        .map(Uuid::to_string)
        .collect();
    let only_a: BTreeSet<String> = [a_quote, a_mention].iter().map(Uuid::to_string).collect();

    // The contrast that makes the rest able to fail: the person's own session sees both
    // approval cards (so they were really planted), all four items, B's text and B's channel.
    let person = w.inbox(&s.holder.jwt, "").await;
    person.expect(200);
    let person_page = person.json();
    let cards: BTreeSet<String> = person_page["approvalsPending"]
        .as_array()
        .expect("approvalsPending array")
        .iter()
        .map(|card| {
            card["channelId"]
                .as_str()
                .expect("card channel")
                .to_string()
        })
        .collect();
    assert_eq!(
        cards,
        BTreeSet::from([a.clone(), b.clone()]),
        "the session must see both planted approval cards: {person:?}"
    );
    assert_eq!(person_page["unreadCount"], 4, "{person:?}");
    assert_eq!(inbox_message_ids(&person_page), all_four, "{person:?}");
    for marker in [
        "B-ROOM-APPROVAL",
        "B-ROOM-QUOTE-REPLY",
        "B-ROOM-MENTION",
        "B-ROOM-OWN",
    ] {
        assert!(
            person.text().contains(marker),
            "the session must see {marker}"
        );
    }

    // An unrestricted developer token: every item, but never an approval card (F17) — and
    // that is not the restriction's doing.
    let open_reply = w.inbox(&open, "").await;
    open_reply.expect(200);
    let open_page = open_reply.json();
    assert_eq!(open_page["approvalsPending"], json!([]), "{open_reply:?}");
    assert_eq!(open_page["unreadCount"], 4, "{open_reply:?}");
    assert_eq!(inbox_message_ids(&open_page), all_four, "{open_reply:?}");
    assert!(!open_reply.text().contains("-APPROVAL"), "{open_reply:?}");

    // R11: restricted to A — only A's two items, counted as two, no card, and nothing of B.
    let reply = w.inbox(&restricted, "").await;
    reply.expect(200);
    let page = reply.json();
    assert_eq!(page["approvalsPending"], json!([]), "{reply:?}");
    assert_eq!(inbox_message_ids(&page), only_a, "{reply:?}");
    assert_eq!(page["unreadCount"], 2, "{reply:?}");
    for marker in ["B-ROOM", b.as_str(), "-APPROVAL"] {
        assert!(!reply.text().contains(marker), "{marker} leaked: {reply:?}");
    }
    assert!(reply.text().contains("A-ROOM-MENTION"), "{reply:?}");
    assert!(reply.text().contains("A-ROOM-QUOTE-REPLY"), "{reply:?}");

    // Reading the inbox with a developer token marks nothing read.
    let read: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inbox_item WHERE member_id = $1 AND read_at IS NOT NULL",
    )
    .bind(s.holder.id)
    .fetch_one(&w.su)
    .await
    .expect("count read items");
    assert_eq!(read, 0, "a developer token's inbox read marked items read");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_inbox_page_of_a_restricted_token_is_full_and_ends_where_its_channels_end() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    // B's items are newer than A's, so without the restriction B's fill the first pages.
    let (a_quote, a_mention) = s.plant_unread(s.a, "A-ROOM", 60).await;
    let (_, b_mention) = s.plant_unread(s.b, "B-ROOM", 5).await;
    let restricted = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a])).await;
    let open = w.card(s.holder.id, &DEV_SCOPES, None).await;

    // Positive control: unrestricted, the newest single item is B's.
    let open_first = w.inbox(&open, "?limit=1").await;
    open_first.expect(200);
    assert_eq!(
        inbox_message_ids(&open_first.json()),
        BTreeSet::from([b_mention.to_string()]),
        "B's mention must be newest without the restriction: {open_first:?}"
    );

    // Restricted: page one is a full page of A's newest item (a page filtered afterwards
    // would be empty), page two its second and last, and `unreadCount` is A's two on both.
    let first = w.inbox(&restricted, "?limit=1").await;
    first.expect(200);
    let first_page = first.json();
    assert_eq!(
        inbox_message_ids(&first_page),
        BTreeSet::from([a_mention.to_string()]),
        "{first:?}"
    );
    assert_eq!(first_page["unreadCount"], 2, "{first:?}");
    let cursor = first_page["nextCursor"]
        .as_str()
        .unwrap_or_else(|| panic!("a second page must exist: {first:?}"))
        .to_string();
    let second = w
        .inbox(&restricted, &format!("?limit=1&cursor={cursor}"))
        .await;
    second.expect(200);
    let second_page = second.json();
    assert_eq!(
        inbox_message_ids(&second_page),
        BTreeSet::from([a_quote.to_string()]),
        "{second:?}"
    );
    assert_eq!(second_page["unreadCount"], 2, "{second:?}");
    assert!(second_page["nextCursor"].is_null(), "{second:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_member_who_left_a_listed_channel_is_refused_there_and_gets_it_back_when_added_again() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let a_root = w
        .say(s.a, s.colleague.id, "A-ROOM-THREAD-ROOT", Say::default())
        .await;
    w.say(s.b, s.colleague.id, "B-ROOM-HISTORY", Say::default())
        .await;
    let (a_quote, a_mention) = s.plant_unread(s.a, "A-ROOM", 10).await;
    let (b_quote, b_mention) = s.plant_unread(s.b, "B-ROOM", 5).await;
    // The token lists A and B; the person is in both.
    let token = w.card(s.holder.id, &DEV_SCOPES, Some(&[s.a, s.b])).await;
    let nowhere = Uuid::new_v4();
    let (a, b) = (s.a.to_string(), s.b.to_string());

    // Before: everything works, and the list, the inbox and the sends show both channels.
    w.history(&token, s.a).await.expect(200);
    w.replies(&token, s.a, a_root).await.expect(200);
    w.send(&token, s.a, &text_body("A-ROOM-BEFORE-LEAVING"))
        .await
        .expect(201);
    assert_eq!(
        channel_ids(w.channel_list(&token, "").await.expect(200)),
        BTreeSet::from([a.clone(), b.clone()])
    );
    let before = w.inbox(&token, "").await;
    assert_eq!(
        inbox_message_ids(&before.expect(200).json()),
        [a_quote, a_mention, b_quote, b_mention]
            .iter()
            .map(Uuid::to_string)
            .collect::<BTreeSet<_>>()
    );

    // The person leaves A through the real route (B has other members, so A is not archived).
    let left = w
        .call(
            Method::DELETE,
            w.ws_url(&format!("channels/{}/members/me", s.a)),
            &s.holder.jwt,
            None,
        )
        .await;
    assert_eq!(left.expect(200).json()["archived"], false, "{left:?}");

    // After: the token still lists A, but A answers as a channel that does not exist.
    let refused = w.history(&token, s.a).await;
    assert_not_a_member(&refused, "history of a channel the person left");
    assert_same_answer(
        &refused,
        &w.history(&token, nowhere).await,
        "left channel vs. a channel that does not exist",
    );
    assert_same_answer(
        &w.replies(&token, s.a, a_root).await,
        &w.replies(&token, nowhere, a_root).await,
        "thread of a left channel vs. a channel that does not exist",
    );
    let a_ledger = w.ledger(s.a).await;
    assert_same_answer(
        &w.send(&token, s.a, &text_body("A-ROOM-AFTER-LEAVING"))
            .await,
        &w.send(&token, nowhere, &text_body("A-ROOM-AFTER-LEAVING"))
            .await,
        "send to a left channel vs. a channel that does not exist",
    );
    assert_eq!(
        w.ledger(s.a).await,
        a_ledger,
        "a send to a left channel was stored"
    );
    let list = w.channel_list(&token, "").await;
    assert_eq!(
        channel_ids(list.expect(200)),
        BTreeSet::from([b.clone()]),
        "{list:?}"
    );
    let after = w.inbox(&token, "").await;
    let after_page = after.expect(200).json();
    assert_eq!(
        inbox_message_ids(&after_page),
        [b_quote, b_mention]
            .iter()
            .map(Uuid::to_string)
            .collect::<BTreeSet<_>>(),
        "{after:?}"
    );
    assert_eq!(after_page["unreadCount"], 2, "{after:?}");
    // Positive control: B, which the person is still in, works for the same token.
    w.history(&token, s.b).await.expect(200);
    w.send(&token, s.b, &text_body("B-ROOM-AFTER-LEAVING-A"))
        .await
        .expect(201);

    // Added again (by the admin, the same person), A answers again — the list on the token
    // never changed, only today's membership did.
    let added = w
        .post(
            &s.holder.jwt,
            &format!("channels/{}/members", s.a),
            &json!({"memberId": s.holder.id}),
        )
        .await;
    added.expect(200);
    w.history(&token, s.a).await.expect(200);
    w.send(&token, s.a, &text_body("A-ROOM-AFTER-RETURNING"))
        .await
        .expect(201);
    assert_eq!(
        channel_ids(w.channel_list(&token, "").await.expect(200)),
        BTreeSet::from([a, b])
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_card_for_a_channel_the_person_is_not_in_is_refused_at_issuance_and_a_route_issued_card_keeps_its_restriction(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    w.say(s.a, s.colleague.id, "A-ROOM-HISTORY", Say::default())
        .await;
    w.say(s.b, s.colleague.id, "B-ROOM-HISTORY", Say::default())
        .await;
    // R11: a channel the person is not in (C), a mix with one (A and C), one that does not
    // exist, and (further down) one the person left — each a 400 that creates no token.
    assert_eq!(dev_cards_of(w, s.holder.id).await, 0);
    for (what, ids) in [
        ("a channel the person is not in", json!([s.c])),
        ("a list with one such channel", json!([s.a, s.c])),
        ("a channel that does not exist", json!([Uuid::new_v4()])),
    ] {
        let refused = issue_card_for(&s, ids).await;
        assert_eq!(refused.status, 400, "{what}: {refused:?}");
        assert_eq!(
            dev_cards_of(w, s.holder.id).await,
            0,
            "{what}: a token row was stored"
        );
    }

    // Positive control: with only channels the person is in, the same request is a 201 with
    // the secret, and the issued card works end to end — A reads, B is the missing-channel answer.
    let created = issue_card_for(&s, json!([s.a])).await;
    created.expect(201);
    assert_eq!(dev_cards_of(w, s.holder.id).await, 1);
    let secret = created.json()["token"]
        .as_str()
        .expect("the secret is in the issue answer")
        .to_string();
    assert!(w
        .history(&secret, s.a)
        .await
        .expect(200)
        .text()
        .contains("A-ROOM-HISTORY"));
    let outside = w.history(&secret, s.b).await;
    assert_not_a_member(&outside, "a route-issued card, a channel outside its list");
    assert_same_answer(
        &outside,
        &w.history(&secret, Uuid::new_v4()).await,
        "route-issued card: outside the list vs. a channel that does not exist",
    );

    // A channel the person has left is no longer one the person is in.
    w.call(
        Method::DELETE,
        w.ws_url(&format!("channels/{}/members/me", s.b)),
        &s.holder.jwt,
        None,
    )
    .await
    .expect(200);
    let after_leaving = issue_card_for(&s, json!([s.b])).await;
    assert_eq!(after_leaving.status, 400, "{after_leaving:?}");
    assert_eq!(dev_cards_of(w, s.holder.id).await, 1);
}

// ---------------------------------------------------------------------------
// R12 — the body allow-list and the mark
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_developer_send_with_any_field_outside_the_allow_list_is_a_coded_400_and_stores_nothing()
{
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let refused: Vec<(&str, Value)> = vec![
        ("props", json!({"sentVia": "dev", "note": "x"})),
        ("type", json!("system")),
        ("type", Value::Null),
        ("type", json!("TEXT")),
        ("runId", json!(Uuid::new_v4())),
        ("attachmentIds", json!([Uuid::new_v4()])),
        ("routing", json!({"model": "any"})),
        ("signature", json!("c2lnbmF0dXJl")),
        ("stream", json!({"streaming": true})),
        ("harnessRefine", json!({"kind": "any"})),
        ("apps", json!(["com.momo.plugins.gmail"])),
        // The mark's own names, and a field that does not exist yet: the list is an
        // allow-list, so anything not named is closed.
        ("sentVia", json!("dev")),
        ("sent_via", json!("dev")),
        ("someFieldAddedNextYear", json!(1)),
    ];

    let before = w.ledger(s.a).await;
    for (key, value) in refused {
        let client_msg_id = Uuid::new_v4();
        let mut body = json!({"clientMsgId": client_msg_id, "body": "금지된 필드가 붙은 글"});
        body[key] = value.clone();
        let reply = w.send(&token, s.a, &body).await;
        assert_eq!(reply.status, 400, "{key}={value}: {reply:?}");
        assert_eq!(
            reply.error_code().as_deref(),
            Some("dev_field_not_allowed"),
            "{key}={value}: {reply:?}"
        );
        assert!(
            w.messages_with_client_id(client_msg_id).await.is_empty(),
            "{key}={value}: a row was stored"
        );
    }
    assert_eq!(
        w.ledger(s.a).await,
        before,
        "refused sends changed the messages, last_seq or the outbox"
    );

    // Positive controls: the body without the extra key is a 201 (so the refusals were about
    // the key), and a person's session may still send `props` (the allow-list is the
    // developer door's, not the route's).
    w.send(&token, s.a, &text_body("허용된 본문"))
        .await
        .expect(201);
    w.send(
        &s.holder.jwt,
        s.a,
        &json!({"clientMsgId": Uuid::new_v4(), "body": "세션의 props", "props": {"note": "x"}}),
    )
    .await
    .expect(201);
    let after = w.ledger(s.a).await;
    assert_eq!(after.messages, before.messages + 2);
    assert_eq!(after.last_seq, before.last_seq + 2);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_developer_send_that_is_not_one_plain_json_object_is_refused_and_stores_nothing() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let id = Uuid::new_v4();
    // Every one of these must come back as the app's own JSON error envelope with status 400 and
    // **no `code`**. That is what tells the gate's answer from the handler's: left to its own
    // extractor, a body that is not an object or repeats a key is a 422 and a syntax error is a
    // 400 with a plain-text body, so removing the gate turns each case red (the failure message
    // prints the answer).
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("not JSON at all", b"this is not json".to_vec()),
        ("an empty body", Vec::new()),
        ("truncated JSON", br#"{"clientMsgId":"#.to_vec()),
        (
            "bytes after the object",
            format!(r#"{{"clientMsgId":"{id}","body":"a"}} {{"x":1}}"#).into_bytes(),
        ),
        ("a JSON array", b"[]".to_vec()),
        ("a JSON string", br#""body""#.to_vec()),
        ("JSON null", b"null".to_vec()),
        (
            "an allowed key given twice",
            format!(r#"{{"clientMsgId":"{id}","body":"a","body":"b"}}"#).into_bytes(),
        ),
    ];

    let before = w.ledger(s.a).await;
    for (what, bytes) in &cases {
        let reply = w.send_raw(&token, s.a, bytes.clone()).await;
        assert_eq!(reply.status, 400, "{what}: {reply:?}");
        assert_eq!(
            reply.error_code(),
            None,
            "{what}: a plain 400 has no code: {reply:?}"
        );
    }
    assert!(
        w.messages_with_client_id(id).await.is_empty(),
        "a refused body was stored"
    );

    // Past the 2 MiB ceiling the answer is a 413 — whichever layer reads that far first.
    let oversized = format!(
        r#"{{"clientMsgId":"{id}","body":"{}"}}"#,
        "x".repeat(2 * 1024 * 1024 + 1024)
    );
    let too_big = w.send_raw(&token, s.a, oversized.into_bytes()).await;
    assert_eq!(too_big.status, 413, "{too_big:?}");
    assert_eq!(
        w.ledger(s.a).await,
        before,
        "refused bodies changed the messages, last_seq or the outbox"
    );

    // Positive control: a well-formed body from the same token is a 201.
    w.send(&token, s.a, &text_body("한 줄짜리 JSON"))
        .await
        .expect(201);
    assert_eq!(w.ledger(s.a).await.messages, before.messages + 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_message_sent_with_a_developer_token_is_marked_dev_and_the_same_body_from_a_session_is_not(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let thread_root = w
        .say(s.a, s.colleague.id, "스레드의 시작", Say::default())
        .await;

    // The allowed body in all its shapes: a plain text, an explicit `type: "text"`, a reply
    // into a thread (`rootId`), a quote in the main flow (`replyToId`), and a thread reply that
    // also quotes its root.
    let mut sent: Vec<(&str, Reply)> = Vec::new();
    for (shape, body) in [
        (
            "plain",
            json!({"clientMsgId": Uuid::new_v4(), "body": "도구가 쓴 글"}),
        ),
        (
            "typed",
            json!({"clientMsgId": Uuid::new_v4(), "body": "도구가 쓴 글", "type": "text"}),
        ),
        (
            "thread reply",
            json!({"clientMsgId": Uuid::new_v4(), "body": "도구가 스레드에 쓴 글", "rootId": thread_root}),
        ),
        (
            "quote",
            json!({"clientMsgId": Uuid::new_v4(), "body": "도구가 인용해서 쓴 글", "replyToId": thread_root}),
        ),
        (
            "thread reply that quotes",
            json!({
                "clientMsgId": Uuid::new_v4(),
                "body": "도구가 스레드에서 인용해 쓴 글",
                "rootId": thread_root,
                "replyToId": thread_root,
                "type": "text",
            }),
        ),
    ] {
        let reply = w.send(&token, s.a, &body).await;
        assert_eq!(reply.status, 201, "{shape}: {reply:?}");
        sent.push((shape, reply));
    }
    let root = thread_root.to_string();
    for (shape, reply) in &sent {
        let (has_root, has_quote) = match *shape {
            "thread reply" => (true, false),
            "quote" => (false, true),
            "thread reply that quotes" => (true, true),
            _ => (false, false),
        };
        let echoed = reply.json();
        assert_eq!(
            echoed.get("rootId").is_some(),
            has_root,
            "{shape}: {reply:?}"
        );
        assert_eq!(
            echoed.get("replyToId").is_some(),
            has_quote,
            "{shape}: {reply:?}"
        );
        if has_root {
            assert_eq!(echoed["rootId"], root.as_str(), "{shape}: {reply:?}");
        }
        if has_quote {
            assert_eq!(echoed["replyToId"], root.as_str(), "{shape}: {reply:?}");
        }
    }
    let dev_ids: Vec<Uuid> = sent
        .iter()
        .map(|(_, reply)| {
            reply.json()["id"]
                .as_str()
                .expect("message id")
                .parse()
                .expect("uuid")
        })
        .collect();
    for ((shape, reply), id) in sent.iter().zip(&dev_ids) {
        assert_eq!(reply.json()["sentVia"], "dev", "{shape}: {reply:?}");
        assert_eq!(
            w.sent_via(*id).await.as_deref(),
            Some("dev"),
            "{shape}: not marked in the row"
        );
    }

    // The same body from the same person's session: stored, but unmarked and without the key.
    let session = w.send(&s.holder.jwt, s.a, &text_body("도구가 쓴 글")).await;
    session.expect(201);
    assert!(session.json().get("sentVia").is_none(), "{session:?}");
    let session_id: Uuid = session.json()["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(w.sent_via(session_id).await, None);

    // History and the thread page carry the mark from the row: on the developer's messages
    // and not on the session's — read by the developer token and by the session alike.
    for (who, bearer) in [("developer token", &token), ("session", &s.holder.jwt)] {
        let page = w.history(bearer, s.a).await;
        let page = page.expect(200).json();
        for id in &dev_ids {
            assert_eq!(message_in(&page, *id)["sentVia"], "dev", "{who}: {page}");
        }
        assert!(
            message_in(&page, session_id).get("sentVia").is_none(),
            "{who}: {page}"
        );
        assert!(
            message_in(&page, thread_root).get("sentVia").is_none(),
            "{who}: {page}"
        );
        let thread = w.replies(bearer, s.a, thread_root).await;
        let thread = thread.expect(200).json();
        for thread_reply in [dev_ids[2], dev_ids[4]] {
            assert_eq!(
                message_in(&thread, thread_reply)["sentVia"],
                "dev",
                "{who}: {thread}"
            );
        }
    }
    assert_eq!(
        w.marked_messages().await,
        5,
        "exactly the five developer sends are marked"
    );

    // The realtime frame the relay publishes says the same, under its own (snake_case) key:
    // on the developer's messages, and no key at all on the session's.
    for id in &dev_ids {
        assert_eq!(w.frame("message.new", *id).await["sent_via"], "dev");
    }
    assert!(w
        .frame("message.new", session_id)
        .await
        .get("sent_via")
        .is_none());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_session_cannot_imitate_the_dev_mark_through_sent_via_or_props() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;

    // Positive control first: a developer send is what the mark is for.
    w.send(&token, s.a, &text_body("진짜 표식"))
        .await
        .expect(201);
    assert_eq!(w.marked_messages().await, 1);

    // A session that names the mark as a field is refused (the request type is closed-world)
    // and stores nothing; one that hides it in `props` is stored, unmarked.
    for field in ["sentVia", "sent_via"] {
        let client_msg_id = Uuid::new_v4();
        let reply = w
            .send(
                &s.holder.jwt,
                s.a,
                &json!({"clientMsgId": client_msg_id, "body": "흉내", field: "dev"}),
            )
            .await;
        assert!(!(200..300).contains(&reply.status), "{field}: {reply:?}");
        assert!(
            w.messages_with_client_id(client_msg_id).await.is_empty(),
            "{field}: the refused session send was stored"
        );
    }
    let client_msg_id = Uuid::new_v4();
    let hidden = w
        .send(
            &s.holder.jwt,
            s.a,
            &json!({
                "clientMsgId": client_msg_id,
                "body": "props로 흉내",
                "props": {"sentVia": "dev", "sent_via": "dev", "momo.sentVia": "dev"},
            }),
        )
        .await;
    hidden.expect(201);
    assert!(hidden.json().get("sentVia").is_none(), "{hidden:?}");
    let stored = w.messages_with_client_id(client_msg_id).await;
    assert_eq!(stored.len(), 1);
    assert_eq!(w.sent_via(stored[0]).await, None);
    assert_eq!(
        w.marked_messages().await,
        1,
        "only the developer send may carry the mark"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_authors_edit_keeps_the_dev_mark() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let sent = w.send(&token, s.a, &text_body("고치기 전")).await;
    sent.expect(201);
    let id: Uuid = sent.json()["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(w.sent_via(id).await.as_deref(), Some("dev"));

    // The author (the same person, in a session) edits the message: the edit took effect …
    let edited = w
        .call(
            Method::PATCH,
            w.ws_url(&format!("messages/{id}")),
            &s.holder.jwt,
            Some(serde_json::to_vec(&json!({"body": "고친 뒤"})).unwrap()),
        )
        .await;
    edited.expect(200);
    assert_eq!(edited.json()["body"], "고친 뒤", "{edited:?}");
    let (body, edited_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT body, edited_at FROM message WHERE id = $1")
            .bind(id)
            .fetch_one(&w.su)
            .await
            .expect("read the edited row");
    assert_eq!(body, "고친 뒤");
    assert!(edited_at.is_some(), "the edit left no edited_at");

    // … and the mark is still there, in the row, in the edit's answer and on the history page.
    assert_eq!(w.sent_via(id).await.as_deref(), Some("dev"));
    assert_eq!(edited.json()["sentVia"], "dev", "{edited:?}");
    let page = w.history(&s.holder.jwt, s.a).await;
    assert_eq!(message_in(&page.expect(200).json(), id)["sentVia"], "dev");
    // The `message.edited` frame carries it too, so a client that only hears about the edit
    // does not lose the mark.
    assert_eq!(w.frame("message.edited", id).await["sent_via"], "dev");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_retried_developer_send_lands_once() {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let token = w.card(s.holder.id, &DEV_SCOPES, None).await;
    let client_msg_id = Uuid::new_v4();
    let body = json!({"clientMsgId": client_msg_id, "body": "다시 보내도 한 번"});

    let before = w.ledger(s.a).await;
    let first = w.send(&token, s.a, &body).await;
    first.expect(201);
    let after_first = w.ledger(s.a).await;
    assert_eq!(after_first.messages, before.messages + 1);
    assert!(
        after_first.outbox > before.outbox,
        "the send published nothing"
    );
    let retry = w.send(&token, s.a, &body).await;
    retry.expect(201);

    // The retry answers the message the first send stored — same id, same seq, still marked —
    // stores no second row and publishes nothing again. (A deduplicated insert still advances
    // the channel's `last_seq` counter: that is the send statement's own behaviour for every
    // sender, so the counter is not asserted here.)
    assert_eq!(
        first.json()["id"],
        retry.json()["id"],
        "the retry answers the message the first send stored"
    );
    assert_eq!(first.json()["seq"], retry.json()["seq"]);
    assert_eq!(retry.json()["sentVia"], "dev", "{retry:?}");
    let stored = w.messages_with_client_id(client_msg_id).await;
    assert_eq!(stored.len(), 1, "the retry stored a second row");
    assert_eq!(w.sent_via(stored[0]).await.as_deref(), Some("dev"));
    let after_retry = w.ledger(s.a).await;
    assert_eq!(after_retry.messages, after_first.messages);
    assert_eq!(
        after_retry.outbox, after_first.outbox,
        "the retry published the message a second time"
    );

    // Positive control: a different `clientMsgId` is a different message.
    w.send(&token, s.a, &text_body("다른 글")).await.expect(201);
    assert_eq!(w.ledger(s.a).await.messages, before.messages + 2);
}

// ---------------------------------------------------------------------------
// L3–L7 work for a developer token
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_read_only_token_reads_channels_history_threads_and_inbox_and_a_write_scope_is_what_lets_it_send(
) {
    let _guard = test_lock().await;
    let s = studio().await;
    let w = &s.w;
    let a_root = w
        .say(s.a, s.colleague.id, "A-ROOM-THREAD-ROOT", Say::default())
        .await;
    w.say(
        s.a,
        s.holder.id,
        "A-ROOM-THREAD-REPLY",
        Say {
            root: Some(a_root),
            ..Say::default()
        },
    )
    .await;
    let (_, mention) = s.plant_unread(s.a, "A-ROOM", 10).await;
    let read_only = w.card(s.holder.id, &DEV_READ_ONLY_SCOPES, None).await;
    let with_write = w
        .card(
            s.holder.id,
            &[
                momo_auth::SCOPE_DEV_CHANNELS_READ,
                momo_auth::SCOPE_DEV_MESSAGES_READ,
                momo_auth::SCOPE_DEV_INBOX_READ,
                momo_auth::SCOPE_DEV_MESSAGES_WRITE,
            ],
            None,
        )
        .await;

    // L3 channels, L4 history, L5 thread, L7 inbox — all 200 with the content, for the preset.
    let channels = w.channel_list(&read_only, "").await;
    assert!(
        channel_ids(channels.expect(200)).contains(&s.a.to_string()),
        "{channels:?}"
    );
    let history = w.history(&read_only, s.a).await;
    assert!(
        history.expect(200).text().contains("A-ROOM-MENTION"),
        "{history:?}"
    );
    let thread = w.replies(&read_only, s.a, a_root).await;
    assert!(
        thread.expect(200).text().contains("A-ROOM-THREAD-REPLY"),
        "{thread:?}"
    );
    let inbox = w.inbox(&read_only, "").await;
    assert!(
        inbox_message_ids(&inbox.expect(200).json()).contains(&mention.to_string()),
        "{inbox:?}"
    );

    // L6 send needs `dev:messages:write`: without it a 403 `dev_scope_denied` that stores
    // nothing; with it a 201.
    let before = w.ledger(s.a).await;
    let denied = w
        .send(&read_only, s.a, &text_body("읽기 전용 토큰의 글"))
        .await;
    assert_eq!(denied.status, 403, "{denied:?}");
    assert_eq!(
        denied.error_code().as_deref(),
        Some("dev_scope_denied"),
        "{denied:?}"
    );
    assert_eq!(w.ledger(s.a).await, before, "a denied send was stored");
    w.send(&with_write, s.a, &text_body("쓰기 범위가 있는 토큰의 글"))
        .await
        .expect(201);
    assert_eq!(w.ledger(s.a).await.messages, before.messages + 1);
}
