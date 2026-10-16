//! ADR-0201 증보 2026-10-16 v2 H2 (#3894) — the team AI's aliases `@oort`·`@오르트`·`@claude`,
//! against a real Postgres and the real send path.
//!
//! `#[ignore]`d like its siblings; run against an isolated `pgvector/pgvector:pg18`:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:<port>/momo \
//!   cargo test -p momo-server --test team_ai_alias_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! The server runs on `momo_app` (NOBYPASSRLS), so every write here passes the
//! policies production uses; fixtures are seeded as the superuser.
//!
//! | test | acceptance | revert that makes it red |
//! |---|---|---|
//! | `a1_an_existing_claude_handle_keeps_its_mentions` | H13-A1 | drop the handle check in `register_aliases_in_tx` |
//! | `a2_a_real_member_takes_the_alias_back` | H13-A2 | drop the `member_handle_alias_release` trigger |
//! | `a2_read_time_a_real_handle_still_wins` | H2-4 | drop the `NOT EXISTS` handle filter from the candidate queries |
//! | `a3_only_the_called_colleague_answers` | H13-A3 | resolve aliases outside `contains_mention_with_aliases`, or match them without the boundary |
//! | `a4_off_means_no_alias` | H13-A4 | skip the alias delete in `disable_in_tx` |
//! | `the_alias_status_is_server_written` | H2-3 | add `team_ai_alias_status` to `ALLOWED_SETTINGS_KEYS` |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "team-ai-alias-3894-secret";
const TEST_PASSWORD: &str = "team-ai-alias-3894-password";

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

struct Tenant {
    workspace: Uuid,
    owner: Uuid,
    email: String,
    channel: Uuid,
}

struct Harness {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    token: String,
    t: Tenant,
}

async fn harness() -> Harness {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let workspace = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let email = format!("{owner}@alias3894.test");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(&su)
        .await
        .expect("workspace");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', '성재', $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(format!("h{}", &owner.simple().to_string()[..8]))
    .execute(&su)
    .await
    .expect("owner member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(&su)
    .await
    .expect("owner auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(&su)
    .await
    .expect("owner role");
    let channel = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("alias-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("channel")
    .id;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let t = Tenant {
        workspace,
        owner,
        email,
        channel,
    };
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": t.email,
            "password": TEST_PASSWORD,
            "workspace": t.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200);
    let token = response.json::<Value>().await.expect("login body")["accessToken"]
        .as_str()
        .expect("token")
        .to_string();
    Harness {
        su,
        http,
        base,
        token,
        t,
    }
}

impl Harness {
    async fn seed_agent(&self, handle: &str, display: &str) -> Uuid {
        let agent = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'agent', $3, $4)",
        )
        .bind(agent)
        .bind(self.t.workspace)
        .bind(display)
        .bind(handle)
        .execute(&self.su)
        .await
        .expect("agent member");
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                                max_concurrent_runs, max_run_steps, owner_human_id) \
             VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
        )
        .bind(agent)
        .bind(self.t.workspace)
        .bind(self.t.owner)
        .execute(&self.su)
        .await
        .expect("agent row");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
        )
        .bind(self.t.workspace)
        .bind(agent)
        .execute(&self.su)
        .await
        .expect("agent role");
        self.join(agent).await;
        agent
    }

    async fn join(&self, member: Uuid) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(self.t.workspace)
        .bind(self.t.channel)
        .bind(member)
        .execute(&self.su)
        .await
        .expect("channel membership");
    }

    async fn patch_settings(&self, body: Value) -> (u16, Value) {
        let response = self
            .http
            .patch(format!(
                "{}/v1/workspaces/{}/settings",
                self.base, self.t.workspace
            ))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .expect("patch settings");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Switch the team AI on through the shipped route and put it in the channel.
    async fn enable(&self) -> Uuid {
        let (status, body) = self
            .patch_settings(json!({"team_ai_fast_path": true}))
            .await;
        assert_eq!(status, 200, "enable: {body}");
        let helper: Uuid = sqlx::query_scalar(
            "SELECT (settings->>'team_ai_agent_member_id')::uuid FROM workspace WHERE id = $1",
        )
        .bind(self.t.workspace)
        .fetch_one(&self.su)
        .await
        .expect("helper id");
        self.join(helper).await;
        helper
    }

    async fn send(&self, body: &str) -> Uuid {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                self.base, self.t.workspace, self.t.channel
            ))
            .bearer_auth(&self.token)
            .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
            .send()
            .await
            .expect("send");
        assert_eq!(response.status(), 201, "send {body}");
        let sent: Value = response.json().await.expect("send body");
        let id = sent["id"]
            .as_str()
            .or_else(|| sent["message"]["id"].as_str())
            .expect("message id");
        Uuid::parse_str(id).expect("uuid")
    }

    /// Mention runs started by one message, as agent ids.
    async fn runs_for_message(&self, message: Uuid) -> Vec<Uuid> {
        sqlx::query_scalar(
            "SELECT agent_member_id FROM agent_run \
              WHERE workspace_id = $1 AND trigger_message_id = $2 ORDER BY agent_member_id",
        )
        .bind(self.t.workspace)
        .bind(message)
        .fetch_all(&self.su)
        .await
        .expect("runs")
    }

    async fn mention_tokens(&self, message: Uuid) -> Vec<String> {
        let props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
            .bind(message)
            .fetch_one(&self.su)
            .await
            .expect("props");
        props["mention_member_ids"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_lowercase))
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn aliases(&self) -> Vec<(String, Uuid)> {
        sqlx::query(
            "SELECT alias_norm, member_id FROM member_handle_alias \
              WHERE workspace_id = $1 ORDER BY alias_norm COLLATE \"C\"",
        )
        .bind(self.t.workspace)
        .fetch_all(&self.su)
        .await
        .expect("aliases")
        .into_iter()
        .map(|row| (row.get("alias_norm"), row.get("member_id")))
        .collect()
    }

    async fn alias_status(&self) -> Value {
        sqlx::query_scalar("SELECT settings->'team_ai_alias_status' FROM workspace WHERE id = $1")
            .bind(self.t.workspace)
            .fetch_one(&self.su)
            .await
            .unwrap_or(Value::Null)
    }
}

/// **H13-A1** — an agent that already owns the handle `claude` keeps every
/// `@claude`. The helper gets `oort` and `오르트`, not `claude`, and the settings
/// say why.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn a1_an_existing_claude_handle_keeps_its_mentions() {
    let h = harness().await;
    let claude = h.seed_agent("claude", "Claude 에이전트").await;
    let helper = h.enable().await;

    let aliases = h.aliases().await;
    assert_eq!(
        aliases,
        vec![("oort".to_string(), helper), ("오르트".to_string(), helper)],
        "`claude` is taken by a real agent's handle, so it is not registered"
    );
    let status = h.alias_status().await;
    assert_eq!(status["claude"], json!("taken"), "{status}");
    assert_eq!(status["oort"], json!("registered"), "{status}");
    assert_eq!(status["오르트"], json!("registered"), "{status}");

    let to_claude = h.send("@claude 이 스레드 요약해 줘").await;
    assert_eq!(
        h.runs_for_message(to_claude).await,
        vec![claude],
        "@claude reaches the agent that owns the handle, and only it"
    );
    let to_helper = h.send("@oort 안녕").await;
    assert_eq!(h.runs_for_message(to_helper).await, vec![helper]);
}

/// **H13-A2** — the real member wins later too: an agent created with the
/// handle `oort` after the alias was registered takes it back in the same
/// transaction, the creation is not refused, and an audit row says so. A
/// display name that merely reads 「oort」 changes nothing.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn a2_a_real_member_takes_the_alias_back() {
    let h = harness().await;
    let helper = h.enable().await;
    assert!(h.aliases().await.contains(&("oort".to_string(), helper)));

    // Display name only: the alias stays (a display name is free text).
    sqlx::query("UPDATE member SET display_name = 'oort' WHERE id = $1")
        .bind(h.t.owner)
        .execute(&h.su)
        .await
        .expect("rename display");
    assert!(
        h.aliases().await.contains(&("oort".to_string(), helper)),
        "a display name never releases an alias"
    );

    // A handle: the alias goes, in the same statement's transaction.
    let real = h.seed_agent("oort", "진짜 oort").await;
    let aliases = h.aliases().await;
    assert!(
        !aliases.iter().any(|(alias, _)| alias == "oort"),
        "a real member's handle releases the alias: {aliases:?}"
    );
    assert_eq!(h.alias_status().await["oort"], json!("taken"));
    let released: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 \
            AND action = 'team_ai.alias.released' AND detail->>'alias' = 'oort'",
    )
    .bind(h.t.workspace)
    .fetch_one(&h.su)
    .await
    .expect("audit");
    assert_eq!(released, 1, "the release is audited, alias name only");

    let message = h.send("@oort 너 누구야").await;
    assert_eq!(
        h.runs_for_message(message).await,
        vec![real],
        "@oort now reaches the member who owns the handle"
    );
}

/// H2-4, read-time half — even if an alias row is still there (a race with the
/// trigger, or a row restored by hand), a live member's handle wins at
/// resolution.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn a2_read_time_a_real_handle_still_wins() {
    let h = harness().await;
    let helper = h.enable().await;
    let real = h.seed_agent("claude", "다른 claude").await;
    // Put the alias back behind the trigger's back.
    sqlx::query(
        "INSERT INTO member_handle_alias (workspace_id, member_id, alias, alias_norm) \
         VALUES ($1, $2, 'claude', 'claude') ON CONFLICT DO NOTHING",
    )
    .bind(h.t.workspace)
    .bind(helper)
    .execute(&h.su)
    .await
    .expect("stale alias");
    let message = h.send("@claude 해 줘").await;
    assert_eq!(h.runs_for_message(message).await, vec![real]);
    assert!(
        !h.mention_tokens(message)
            .await
            .contains(&helper.to_string()),
        "the stale alias does not even badge the helper"
    );
}

/// **H13-A3** — 「부른 동료만」: a message for another agent never starts a helper
/// run; each alias starts exactly one; the stored mention token is the helper's
/// member id; two colleagues called together each answer for themselves.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn a3_only_the_called_colleague_answers() {
    let h = harness().await;
    let grok = h.seed_agent("grokbot", "그록봇").await;
    let helper = h.enable().await;

    let to_grok = h.send("@grokbot 프로필 바꿔 줘").await;
    assert_eq!(
        h.runs_for_message(to_grok).await,
        vec![grok],
        "the helper never takes another agent's mention"
    );

    for spelling in [
        "@oort 안녕",
        "@오르트 이거 봐줘",
        "@claude 요약해 줘",
        "@OORT 대문자",
    ] {
        let message = h.send(spelling).await;
        assert_eq!(
            h.runs_for_message(message).await,
            vec![helper],
            "{spelling} starts one helper run"
        );
        assert!(
            h.mention_tokens(message)
                .await
                .contains(&helper.to_string()),
            "{spelling}: the stored mention is the helper's member id"
        );
    }

    for not_a_call in [
        "@oort-helperx 아님",
        "@오르트야 이건 아님",
        "oort 그냥 단어",
    ] {
        let message = h.send(not_a_call).await;
        assert!(
            h.runs_for_message(message).await.is_empty(),
            "{not_a_call} calls nobody"
        );
    }

    let both = h.send("@오르트 @grokbot 둘 다 봐 줘").await;
    let mut expected = vec![grok, helper];
    expected.sort();
    assert_eq!(h.runs_for_message(both).await, expected);
}

/// **H13-A4** — off means no alias row and nobody answers to `@oort`.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn a4_off_means_no_alias() {
    let h = harness().await;
    let helper = h.enable().await;
    assert_eq!(h.aliases().await.len(), 3);
    let (status, body) = h.patch_settings(json!({"team_ai_fast_path": false})).await;
    assert_eq!(status, 200, "{body}");
    assert!(h.aliases().await.is_empty(), "off deletes every alias");
    assert_eq!(h.alias_status().await, Value::Null);
    let message = h.send("@oort 안녕").await;
    assert!(
        !h.runs_for_message(message).await.contains(&helper),
        "@oort calls nobody once the switch is off"
    );
    assert!(!h
        .mention_tokens(message)
        .await
        .contains(&helper.to_string()));

    // On again: the aliases come back (idempotent enable).
    h.enable().await;
    assert_eq!(h.aliases().await.len(), 3);
}

/// H2-3 — `team_ai_alias_status` is the server's record, not a setting.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn the_alias_status_is_server_written() {
    let h = harness().await;
    h.enable().await;
    let (status, _) = h
        .patch_settings(json!({"team_ai_alias_status": {"claude": "registered"}}))
        .await;
    assert_eq!(status, 400, "the status key is not PATCH-able");
    assert_eq!(h.alias_status().await["claude"], json!("registered"));
}

/// H8 calls the switch again on an already-on helper (the next-step card). That
/// must stay a 200 with the same three aliases — and it must not need UPDATE on
/// `member_handle_alias`, which migration 138 does not grant `momo_app` (a 42501
/// there would read as `team_ai_unavailable` and switch the helper OFF).
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn switching_on_twice_keeps_the_aliases_without_update_rights() {
    let h = harness().await;
    sqlx::query("REVOKE UPDATE ON member_handle_alias FROM momo_app")
        .execute(&h.su)
        .await
        .expect("revoke");
    let helper = h.enable().await;
    let before = h.aliases().await;
    let status_before = h.alias_status().await;
    let (status, body) = h.patch_settings(json!({"team_ai_fast_path": true})).await;
    assert_eq!(status, 200, "a second switch-on is not a conflict: {body}");
    assert_eq!(h.aliases().await, before);
    assert_eq!(before.len(), 3);
    assert!(before.iter().all(|(_, member)| *member == helper));
    assert_eq!(h.alias_status().await, status_before);
    let on: bool = sqlx::query_scalar(
        "SELECT (settings->>'team_ai_fast_path')::boolean FROM workspace WHERE id = $1",
    )
    .bind(h.t.workspace)
    .fetch_one(&h.su)
    .await
    .unwrap();
    assert!(on, "the helper stays on");
}
