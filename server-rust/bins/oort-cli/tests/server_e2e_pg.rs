//! `oort` against the **real server** on a **real PostgreSQL** (`momo_app`, NOBYPASSRLS): the
//! flows a person runs, start to finish, with the rows read back as the superuser.
//!
//! `#[ignore]` — needs a pgvector/pg18 superuser URL; run on an isolated database and one thread:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p oort-cli --test server_e2e_pg -- --ignored --test-threads=1
//! ```
//!
//! The server is bound **before** its state is built, so its OAuth issuer is the address the CLI
//! really dials (`http://127.0.0.1:<port>`): the CLI compares the metadata's issuer and the
//! callback's `iss` with the server it was told to use, byte for byte.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_card_token_logs_in_and_every_command_runs_against_the_real_routes` | login (stdin) → whoami → channels → post → read → inbox → logout, each over the closed table L1–L7; a retry with one `--client-msg-id` lands once; `sent_via='dev'`; the revoked card is a 401 | the CLI calls a route off the table, a field is dropped, the mark is lost |
//! | `the_stdio_bridge_works_against_the_real_door` | initialize/tools/list/tools/call over the real `/v1/mcp/me` in both eras, a send marked `dev`, the door's -32601 passed through | the era negotiation or a header is wrong for the real door |
//! | `a_browser_approval_logs_in_and_the_session_rotates_and_survives_nothing_it_should_not` | the whole loop: authorize → consent (password) → loopback callback → exchange; 「읽기만」 cannot post (exit 4); a full-scope login can; an expired access rotates on first use; the spent refresh ends the lineage and the CLI asks to log in again | PKCE/state/iss/redirect wiring, scopes, the rotation or the reuse handling is wrong |
//! | `a_callback_that_is_not_ours_ends_the_login_before_anything_is_exchanged` | a wrong `state`, a wrong `iss` and a denied consent each end the login with the right code and open no session | `state`/`iss` are not compared, or a denial is taken for an approval |

#[path = "../../momo-server/tests/common/apps_pg.rs"]
mod apps_pg;
mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use apps_pg::{
    ensure_schema_and_roles, momo_app_pool, seed_channel, seed_human, seed_workspace,
    superuser_pool, TEST_JWT_SECRET,
};
use common::{code, json_of, stderr, stdout, Home};
use momo_auth::{issue_dev_card_in_tx, DevTool, NewDevCard, DEV_FIXED_POLICY, DEV_SCOPES};
use momo_db::sqlx;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, AgentPortOauthConfig,
    CohostedAgentConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use oort_cli::store::{Backend, Store};
use reqwest::{redirect::Policy, Client, Url};
use serde_json::{json, Value};
use uuid::Uuid;

const PASSWORD: &str = "dalmuri-fixture-password-1";
const CONSENT_URL: &str = "https://app.oort.conformance.test/oauth/cli";
const LEGACY: &str = "2025-11-25";
const MODERN: &str = "2026-07-28";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

struct World {
    su: PgPool,
    app: PgPool,
    origin: String,
    ws: Uuid,
    /// 이도현 — the person who runs `oort` (an owner, so the default switch admits her).
    person: Uuid,
    jwt: String,
    /// 박서연 — writes what the CLI reads.
    peer: Uuid,
    general: Uuid,
    http: Client,
}

/// Bind first, then build the state around the address that was bound.
async fn start_server(app: PgPool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the server");
    let address: SocketAddr = listener.local_addr().expect("address");
    let origin = format!("http://{address}");
    let state = AppState::new(
        app,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig::default())
    .with_cohosted(
        CohostedAgentConfig::default(),
        Arc::new(momo_provider_probe::GuardedProviderProbe::new(
            momo_settings::EgressPolicy::default(),
            Duration::from_secs(5),
        )),
    )
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "oort-cli-e2e-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: false,
        subscription_agents_enabled: true,
        claude_subscription_agents_enabled: true,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        oauth: AgentPortOauthConfig::for_tests_dev_login(&origin, CONSENT_URL),
    });
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    origin
}

impl World {
    async fn boot() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let ws = seed_workspace(&su).await;
        let origin = start_server(app.clone()).await;
        let (person, jwt) = seed_human(&su, ws, "owner", "dohyeon").await;
        // The consent routes ask for a live *access* session, as a real sign-in records.
        sqlx::query(
            "UPDATE token SET label = 'access' \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'session'",
        )
        .bind(ws)
        .bind(person)
        .execute(&su)
        .await
        .expect("record the session as an access row");
        sqlx::query(
            "UPDATE human SET password_hash = momo_password_hash($1) \
              WHERE workspace_id = $2 AND member_id = $3",
        )
        .bind(PASSWORD)
        .bind(ws)
        .bind(person)
        .execute(&su)
        .await
        .expect("set the password");
        let (peer, _) = seed_human(&su, ws, "member", "seoyeon").await;
        let general = seed_channel(&su, ws, "public", &[person, peer]).await;
        sqlx::query("UPDATE channel SET name = 'general' WHERE id = $1")
            .bind(general)
            .execute(&su)
            .await
            .expect("name the channel");
        World {
            su,
            app,
            origin,
            ws,
            person,
            jwt,
            peer,
            general,
            http: Client::builder()
                .redirect(Policy::none())
                .build()
                .expect("client"),
        }
    }

    /// A developer card with every scope, issued through the domain function the route uses.
    async fn card(&self) -> String {
        let (ws, member) = (self.ws, self.person);
        let card = NewDevCard {
            label: "달무리 시험 CLI".to_string(),
            tool: DevTool::Cli,
            scopes: DEV_SCOPES
                .iter()
                .map(|scope| (*scope).to_string())
                .collect(),
            channel_ids: None,
            expires_in_days: 30,
        };
        with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                Ok::<_, DbError>(
                    issue_dev_card_in_tx(conn, ws, member, &card, DEV_FIXED_POLICY).await?,
                )
            })
        })
        .await
        .expect("the card transaction")
        .expect("an owner may hold a card")
        .secret
    }

    /// A message written by the peer (with a mention of the person, so the inbox has a row).
    async fn peer_says(&self, body: &str) {
        let seq: i64 = sqlx::query_scalar(
            "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
        )
        .bind(self.general)
        .fetch_one(&self.su)
        .await
        .expect("bump channel_seq");
        sqlx::query(
            "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                                  author_member_id, type, body, props, created_at) \
             VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6, $7, now())",
        )
        .bind(Uuid::new_v4())
        .bind(self.ws)
        .bind(self.general)
        .bind(seq)
        .bind(self.peer)
        .bind(body)
        .bind(json!({"mention_member_ids": [self.person.to_string()]}))
        .execute(&self.su)
        .await
        .expect("seed a message");
    }

    async fn rows(&self, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql)
            .bind(self.ws)
            .fetch_one(&self.su)
            .await
            .expect("count")
    }

    async fn messages_with(&self, body: &str) -> Vec<(Option<String>, Uuid)> {
        sqlx::query_as::<_, (Option<String>, Uuid)>(
            "SELECT sent_via::text, author_member_id FROM message \
              WHERE workspace_id = $1 AND body = $2 ORDER BY seq",
        )
        .bind(self.ws)
        .bind(body)
        .fetch_all(&self.su)
        .await
        .expect("messages")
    }

    fn dev_path(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}/dev-access{tail}", self.origin, self.ws)
    }
}

async fn oort(home: &Arc<Home>, args: &[&str], stdin: Option<&str>) -> std::process::Output {
    let home = home.clone();
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let stdin = stdin.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match stdin {
            Some(text) => home.run_with_stdin(&refs, &text),
            None => home.run(&refs),
        }
    })
    .await
    .expect("join")
}

/// The error document: the last line of standard error (earlier lines are the CLI talking to the
/// person — the approval address among them).
fn error_doc(output: &std::process::Output) -> Value {
    let text = stderr(output);
    let last = text.lines().last().unwrap_or("");
    json_of(last)
}

fn ok_json(label: &str, output: &std::process::Output) -> Value {
    assert_eq!(code(output), 0, "{label}: {}", stderr(output));
    json_of(&stdout(output))
}

// ---------------------------------------------------------------------------
// the card path
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn a_card_token_logs_in_and_every_command_runs_against_the_real_routes() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    w.peer_says("서연의 첫 글").await;
    let card = w.card().await;
    let home = Arc::new(Home::new());
    let origin = w.origin.clone();

    let login = ok_json(
        "login",
        &oort(
            &home,
            &[
                "login",
                "--with-token",
                "--storage",
                "file",
                "--server",
                &origin,
                "--json",
            ],
            Some(&format!("{card}\n")),
        )
        .await,
    );
    assert_eq!(login["schema"], "oort.cli.login.v1");
    assert_eq!(login["workspaceId"], w.ws.to_string());
    assert_eq!(login["method"], "token");

    let who = ok_json("whoami", &oort(&home, &["whoami", "--json"], None).await);
    assert_eq!(who["credential"]["kind"], "card");
    assert_eq!(who["memberId"], w.person.to_string());
    assert_eq!(who["channelRestricted"], false);
    assert_eq!(who["scopes"], json!(DEV_SCOPES));
    assert_eq!(
        (who["source"].as_str(), who["storage"].as_str()),
        (Some("stored"), Some("file"))
    );

    let channels = ok_json(
        "channels",
        &oort(&home, &["channels", "--json"], None).await,
    );
    let listed: Vec<&str> = channels["channels"]
        .as_array()
        .expect("channels")
        .iter()
        .filter_map(|channel| channel["id"].as_str())
        .collect();
    assert!(
        listed.contains(&w.general.to_string().as_str()),
        "{channels}"
    );

    // post by name; the same --client-msg-id again lands once
    let id = "12345678-1234-4234-8234-123456789abc";
    for _ in 0..2 {
        let posted = ok_json(
            "post",
            &oort(
                &home,
                &[
                    "post",
                    "#general",
                    "CLI에서 보낸 글",
                    "--client-msg-id",
                    id,
                    "--json",
                ],
                None,
            )
            .await,
        );
        assert_eq!(posted["message"]["body"], "CLI에서 보낸 글");
        assert_eq!(posted["message"]["sentVia"], "dev");
    }
    let rows = w.messages_with("CLI에서 보낸 글").await;
    assert_eq!(
        rows.len(),
        1,
        "a retry with one client-msg-id is one message"
    );
    assert_eq!(
        rows[0].0.as_deref(),
        Some("dev"),
        "the mark comes from the credential"
    );
    assert_eq!(rows[0].1, w.person, "sent as the person, not as an agent");

    // a thread reply by stdin text
    let root = ok_json(
        "read",
        &oort(&home, &["read", "#general", "--json"], None).await,
    );
    let messages = root["messages"].as_array().expect("messages");
    assert!(messages.len() >= 2, "{root}");
    let seqs: Vec<i64> = messages.iter().filter_map(|m| m["seq"].as_i64()).collect();
    assert!(
        seqs.windows(2).all(|pair| pair[0] < pair[1]),
        "oldest first: {seqs:?}"
    );
    let first_id = messages[0]["id"].as_str().expect("id").to_string();
    let reply = ok_json(
        "thread post",
        &oort(
            &home,
            &["post", "#general", "-", "--thread", &first_id, "--json"],
            Some("스레드 답글\n"),
        )
        .await,
    );
    assert_eq!(reply["message"]["rootId"], first_id);
    let thread = ok_json(
        "thread read",
        &oort(
            &home,
            &[
                "read",
                &w.general.to_string(),
                "--thread",
                &first_id,
                "--json",
            ],
            None,
        )
        .await,
    );
    assert_eq!(thread["messages"][0]["body"], "스레드 답글");

    let inbox = ok_json("inbox", &oort(&home, &["inbox", "--json"], None).await);
    assert_eq!(inbox["schema"], "oort.cli.inbox.v1");
    assert!(
        inbox["items"].is_array() && inbox["unreadCount"].is_number(),
        "{inbox}"
    );

    // text forms
    for args in [
        vec!["whoami"],
        vec!["channels"],
        vec!["read", "#general"],
        vec!["inbox"],
    ] {
        let out = oort(&home, &args, None).await;
        assert_eq!(code(&out), 0, "{args:?}: {}", stderr(&out));
        assert!(!stdout(&out).contains(&card), "{args:?}");
    }

    // a channel the person is not in is a refusal with exit 5, whatever the reason
    let hidden = seed_channel(&w.su, w.ws, "private", &[w.peer]).await;
    let out = oort(&home, &["read", &hidden.to_string(), "--json"], None).await;
    assert_eq!(code(&out), 5, "{}", stderr(&out));

    // logout revokes on the server: the card is a 401 for anyone afterwards
    let out = ok_json("logout", &oort(&home, &["logout", "--json"], None).await);
    assert_eq!(out["serverRevocation"], "revoked");
    let after = w
        .http
        .get(w.dev_path("/self"))
        .bearer_auth(&card)
        .send()
        .await
        .expect("request");
    assert_eq!(after.status().as_u16(), 401);
    let out = oort(&home, &["whoami", "--json"], None).await;
    assert_eq!(code(&out), 3);
}

// ---------------------------------------------------------------------------
// the stdio bridge
// ---------------------------------------------------------------------------

fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn the_stdio_bridge_works_against_the_real_door() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    w.peer_says("서연의 글").await;
    let card = w.card().await;
    let home = Arc::new(Home::new());
    let origin = w.origin.clone();
    ok_json(
        "login",
        &oort(
            &home,
            &[
                "login",
                "--with-token",
                "--storage",
                "file",
                "--server",
                &origin,
                "--json",
            ],
            Some(&format!("{card}\n")),
        )
        .await,
    );

    let channel = w.general.to_string();
    let lines = vec![
        rpc(
            1,
            "initialize",
            // the shape Claude Code 2.1.312 sends: the extras are more than the real door accepts
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {
                "name": "claude-code", "title": "Claude Code", "version": "2.1.312",
                "description": "Anthropic's agentic coding tool", "websiteUrl": "https://claude.com/claude-code",
            }}),
        ),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}).to_string(),
        rpc(2, "tools/list", json!({})),
        rpc(
            3,
            "tools/call",
            json!({"name": "oort_me_whoami", "arguments": {}}),
        ),
        rpc(
            4,
            "tools/call",
            json!({"name": "oort_me_post", "arguments": {"channelId": channel, "clientMsgId": "abcdef12-1234-4234-8234-123456789abc", "body": "MCP에서 보낸 글"}}),
        ),
        rpc(
            5,
            "tools/call",
            json!({"name": "oort_me_read", "arguments": {"channelId": channel}}),
        ),
        rpc(6, "resources/list", json!({})),
        rpc(
            7,
            "tools/list",
            json!({"_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
            }}),
        ),
    ];
    let output = {
        let home = home.clone();
        tokio::task::spawn_blocking(move || {
            let mut child = home
                .command()
                .arg("mcp")
                .stdin(Stdio::piped())
                .spawn()
                .expect("spawn oort mcp");
            {
                let mut stdin = child.stdin.take().expect("stdin");
                for line in &lines {
                    stdin.write_all(line.as_bytes()).expect("write");
                    stdin.write_all(b"\n").expect("write");
                }
            }
            child.wait_with_output().expect("wait")
        })
        .await
        .expect("join")
    };
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let answers: Vec<Value> = stdout(&output)
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("not JSON ({error}): {line:?}"))
        })
        .collect();
    assert_eq!(answers.len(), 7, "{answers:?}");
    assert_eq!(answers[0]["result"]["protocolVersion"], LEGACY);
    assert_eq!(answers[0]["result"]["serverInfo"]["name"], "oort-me");
    let tools: Vec<&str> = answers[1]["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(tools.len(), 5, "{tools:?}");
    assert!(
        tools.iter().all(|name| name.starts_with("oort_me_")),
        "{tools:?}"
    );
    assert_eq!(answers[2]["result"]["isError"], false);
    assert_eq!(answers[2]["result"]["structuredContent"]["kind"], "card");
    assert_eq!(answers[3]["result"]["isError"], false, "{}", answers[3]);
    assert_eq!(answers[3]["result"]["structuredContent"]["sentVia"], "dev");
    let read = answers[4]["result"]["structuredContent"]["messages"].to_string();
    assert!(
        read.contains("MCP에서 보낸 글") && read.contains("서연의 글"),
        "{read}"
    );
    assert_eq!(answers[5]["error"]["code"], -32601, "{}", answers[5]);
    assert!(
        answers[6]["result"]["tools"].is_array(),
        "the 2026 era is served: {}",
        answers[6]
    );
    assert!(!stdout(&output).contains(&card) && !stderr(&output).contains(&card));

    let rows = w.messages_with("MCP에서 보낸 글").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("dev"));
    assert_eq!(rows[0].1, w.person);
}

// ---------------------------------------------------------------------------
// the browser path
// ---------------------------------------------------------------------------

/// `oort login --no-browser` running, with the URL it printed.
struct PendingLogin {
    child: std::process::Child,
    url: Url,
    /// Everything it wrote to standard error so far (the address included) and the reader that
    /// keeps collecting the rest.
    seen: Vec<String>,
    receiver: std::sync::mpsc::Receiver<String>,
    reader: std::thread::JoinHandle<()>,
}

fn start_browser_login(home: &Arc<Home>, origin: &str, name: &str) -> PendingLogin {
    let mut child = home
        .command()
        .args([
            "login",
            "--no-browser",
            "--storage",
            "file",
            "--name",
            name,
            "--server",
            origin,
            "--json",
        ])
        .spawn()
        .expect("spawn oort login");
    let reader = BufReader::new(child.stderr.take().expect("stderr"));
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let mut seen = Vec::new();
    let url = loop {
        let line = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("the CLI prints the approval address");
        seen.push(line.clone());
        if line.starts_with("http://") || line.starts_with("https://") {
            break Url::parse(&line).expect("an address");
        }
    };
    PendingLogin {
        child,
        url,
        seen,
        receiver,
        reader,
    }
}

impl PendingLogin {
    fn param(&self, name: &str) -> String {
        self.url
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| panic!("no `{name}` in {}", self.url))
    }

    fn port(&self) -> u16 {
        Url::parse(&self.param("redirect_uri"))
            .expect("redirect")
            .port()
            .expect("port")
    }

    /// Wait for the CLI to end; its standard error is everything it wrote, in order.
    async fn finish(self) -> std::process::Output {
        tokio::task::spawn_blocking(move || {
            let mut output = self.child.wait_with_output().expect("wait");
            self.reader.join().expect("reader");
            let mut lines = self.seen;
            lines.extend(self.receiver.try_iter());
            output.stderr = lines.join("\n").into_bytes();
            output
        })
        .await
        .expect("join")
    }
}

impl World {
    /// The browser's half: follow the authorize address to the consent screen and return the signed
    /// request it carries.
    async fn consent_request(&self, login: &PendingLogin) -> String {
        let reply = self
            .http
            .get(login.url.clone())
            .send()
            .await
            .expect("authorize");
        assert_eq!(reply.status().as_u16(), 302, "authorize");
        let location = reply
            .headers()
            .get("location")
            .expect("Location")
            .to_str()
            .expect("text")
            .to_string();
        assert!(location.starts_with(CONSENT_URL), "{location}");
        Url::parse(&location)
            .expect("consent address")
            .query_pairs()
            .find(|(key, _)| key == "request")
            .map(|(_, value)| value.into_owned())
            .expect("a request envelope")
    }

    async fn decide(&self, verb: &str, body: Value) -> reqwest::Response {
        self.http
            .post(self.dev_path(&format!("/authorization-requests/{verb}")))
            .bearer_auth(&self.jwt)
            .json(&body)
            .send()
            .await
            .expect("decision")
    }

    /// Approve with the right password and the given scopes; the loopback address to visit.
    async fn approve(&self, request: &str, scopes: Option<&[&str]>) -> String {
        let mut body = json!({"request": request, "currentPassword": PASSWORD});
        if let Some(scopes) = scopes {
            body["approvedScopes"] = json!(scopes);
        }
        let reply = self.decide("approve", body).await;
        assert_eq!(reply.status().as_u16(), 200);
        reply.json::<Value>().await.expect("json")["redirectTo"]
            .as_str()
            .expect("redirectTo")
            .to_string()
    }

    async fn visit(&self, address: &str) {
        let reply = self
            .http
            .get(address)
            .send()
            .await
            .expect("loopback callback");
        assert_eq!(
            reply.status().as_u16(),
            200,
            "the receiver answers its one callback"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn a_browser_approval_logs_in_and_the_session_rotates_and_survives_nothing_it_should_not() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    w.peer_says("서연의 글").await;
    let home = Arc::new(Home::new());

    // 1. 「읽기만」: the person approves without choosing more
    let pending = start_browser_login(&home, &w.origin, "시험 노트북");
    assert_eq!(pending.param("client_id"), "oort-cli");
    assert_eq!(pending.param("code_challenge_method"), "S256");
    assert_eq!(pending.param("resource"), format!("{}/v1/mcp/me", w.origin));
    let request = w.consent_request(&pending).await;
    let callback = w.approve(&request, None).await;
    assert!(
        callback.starts_with(&format!("http://127.0.0.1:{}/callback?", pending.port())),
        "{callback}"
    );
    w.visit(&callback).await;
    let out = pending.finish().await;
    let login = ok_json("browser login", &out);
    assert_eq!(login["method"], "browser");
    assert_eq!(
        login["scopes"],
        json!([
            "dev:identity",
            "dev:channels:read",
            "dev:messages:read",
            "dev:inbox:read"
        ])
    );
    let leaked = format!("{}{}", stdout(&out), stderr(&out));
    assert!(
        !leaked.contains("momo_dev"),
        "no token in what the login printed"
    );

    let who = ok_json("whoami", &oort(&home, &["whoami", "--json"], None).await);
    assert_eq!(who["credential"]["kind"], "session");
    assert_eq!(who["credential"]["deviceName"], "시험 노트북");
    assert!(
        who["lineageExpiresAt"].is_string(),
        "a login has an absolute cap: {who}"
    );
    let post = oort(
        &home,
        &["post", "#general", "읽기만으로는 못 보내요", "--json"],
        None,
    )
    .await;
    assert_eq!(code(&post), 4, "{}", stderr(&post));
    assert_eq!(json_of(&stderr(&post))["code"], "dev_scope_denied");
    assert!(w.messages_with("읽기만으로는 못 보내요").await.is_empty());
    ok_json(
        "read works",
        &oort(&home, &["read", "#general", "--json"], None).await,
    );

    // 2. a second login with every scope chosen on the consent screen
    let pending = start_browser_login(&home, &w.origin, "시험 노트북");
    let request = w.consent_request(&pending).await;
    let callback = w.approve(&request, Some(&DEV_SCOPES)).await;
    w.visit(&callback).await;
    let login = ok_json("browser login (all)", &pending.finish().await);
    assert_eq!(login["scopes"], json!(DEV_SCOPES));
    let posted = ok_json(
        "post",
        &oort(
            &home,
            &["post", "#general", "세션으로 보낸 글", "--json"],
            None,
        )
        .await,
    );
    assert_eq!(posted["message"]["sentVia"], "dev");
    assert_eq!(w.messages_with("세션으로 보낸 글").await[0].1, w.person);

    // 3. the access half lapses: the next command rotates the pair, once, and keeps working
    let store = Store::locate(Some(&home.xdg()), None).expect("store");
    let current = store.current().expect("current").expect("a profile");
    let backend = store.file_backend();
    let mut saved = backend
        .load(&current.key())
        .expect("load")
        .expect("credential");
    let spent_refresh = saved.refresh.clone().expect("a refresh half");
    let spent_access = saved.access.clone();
    saved.access_expires_at_ms = Some(common::now_ms() - 60_000);
    backend
        .save(&current.key(), &saved)
        .expect("expire locally");
    let before = w
        .rows("SELECT count(*) FROM token WHERE workspace_id = $1 AND kind::text = 'dev'")
        .await;
    ok_json(
        "whoami after expiry",
        &oort(&home, &["whoami", "--json"], None).await,
    );
    let rotated = backend
        .load(&current.key())
        .expect("load")
        .expect("credential");
    assert_ne!(
        rotated.access.expose(),
        spent_access.expose(),
        "a new access half"
    );
    assert_ne!(
        rotated.refresh.expect("refresh").expose(),
        spent_refresh.expose(),
        "a new refresh half"
    );
    assert!(rotated.access_expires_at_ms.expect("expiry") > common::now_ms());
    let after = w
        .rows("SELECT count(*) FROM token WHERE workspace_id = $1 AND kind::text = 'dev'")
        .await;
    assert!(
        after > before,
        "rotation wrote a new pair ({before} → {after})"
    );

    // 4. the spent refresh half, presented by anyone, ends the whole login (reuse = theft)
    let reuse = w
        .http
        .post(format!("{}/v1/oauth/token", w.origin))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", spent_refresh.expose()),
            ("client_id", "oort-cli"),
        ])
        .send()
        .await
        .expect("token");
    assert_eq!(reuse.status().as_u16(), 400);
    let out = oort(&home, &["whoami", "--json"], None).await;
    assert_eq!(code(&out), 3, "{}", stderr(&out));
    assert!(matches!(
        json_of(&stderr(&out))["code"].as_str(),
        Some("login_required" | "login_expired")
    ));
    assert!(!stderr(&out).contains("momo_dev"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn a_callback_that_is_not_ours_ends_the_login_before_anything_is_exchanged() {
    let _guard = test_lock().await;
    let w = World::boot().await;
    let home = Arc::new(Home::new());

    // a wrong state, as a page that guessed the port would send
    let pending = start_browser_login(&home, &w.origin, "시험 노트북");
    let (port, origin) = (pending.port(), w.origin.clone());
    w.visit(&format!(
        "http://127.0.0.1:{port}/callback?code=guess&state=WRONG&iss={}",
        reqwest::Url::parse(&origin)
            .expect("url")
            .as_str()
            .trim_end_matches('/')
    ))
    .await;
    let out = pending.finish().await;
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert_eq!(error_doc(&out)["code"], "state_mismatch");

    // the right state from the wrong issuer
    let pending = start_browser_login(&home, &w.origin, "시험 노트북");
    let (port, state) = (pending.port(), pending.param("state"));
    w.visit(&format!(
        "http://127.0.0.1:{port}/callback?code=guess&state={state}&iss=https://evil.example"
    ))
    .await;
    let out = pending.finish().await;
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert_eq!(error_doc(&out)["code"], "iss_mismatch");

    // a denial on the consent screen
    let pending = start_browser_login(&home, &w.origin, "시험 노트북");
    let request = w.consent_request(&pending).await;
    let reply = w.decide("deny", json!({"request": request})).await;
    assert_eq!(reply.status().as_u16(), 200);
    let target = reply.json::<Value>().await.expect("json")["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    w.visit(&target).await;
    let out = pending.finish().await;
    assert_eq!(code(&out), 1, "{}", stderr(&out));
    assert_eq!(error_doc(&out)["code"], "consent_denied");

    // and none of it opened a session or left a credential behind
    assert_eq!(
        w.rows("SELECT count(*) FROM token WHERE workspace_id = $1 AND kind::text = 'dev'")
            .await,
        0
    );
    assert!(!home.oort_dir().join("current.json").exists());
    let out = oort(&home, &["whoami", "--json"], None).await;
    assert_eq!(code(&out), 3);
}
