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
//! | `b10_a_rename_adds_the_new_name_as_an_alias_in_one_transaction` | v3 B10-3, B15-A12 | drop the `sync_team_ai_aliases_in_tx` call from `rename_agent_display_name_in_tx` |
//! | `b10_a_fifth_alias_removes_the_oldest_one_at_a_time` | B10-3, B15-A12 | drop the eviction loop · flip the `CASE alias_norm` order of the same-instant fixed three |
//! | `b10_the_same_name_changes_nothing_and_a_spaced_name_is_not_derivable` | B10-3 | evict before looking whether the alias exists · record nothing for a spaced name |
//! | `b10_a_real_handle_wins_and_reserved_words_are_refused` | B10-5, B15-A12 | drop the `handle_is_taken_in_tx` branch of the sync · drop the reserved check in `rename_agent_display_name_in_tx` · drop the reserved check in the alias derivation |
//! | `b10_the_database_holds_the_line_without_the_app` | B10-4, B15-A12 | drop the helper check · drop the four-row check from `member_handle_alias_guard` |
//! | `b10_switching_on_again_does_not_resurrect_an_evicted_alias` | B10-3 | seed the fixed three on every switch-on (drop the `held == 0` guard) |
//! | `b10_a_member_who_takes_the_handle_later_releases_the_name_alias` | B10-5, H2-4 | drop the `member_handle_alias_release` trigger |
//! | `b10_two_writers_cannot_both_take_the_last_slot` | B10-4 | drop the advisory lock from `member_handle_alias_guard` |
//! | `b10_the_prompt_carries_the_current_display_name` | B10-7, B15-A16 | hard-code the default name in `system_prompt` |

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::name_guard::NameRejected;
use momo_messaging::team_ai_alias::NameAlias;
use momo_messaging::{
    create_channel, rename_agent_display_name_in_tx, ChannelKind, DisplayNameRename, NewChannel,
};
use momo_server::{build_app, AppState};
use momo_workspace_actions::team_ai::{self, WebSearch};
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
    /// The same role the server runs on (`momo_app`, NOBYPASSRLS) — for calling domain functions
    /// directly, in a tenant transaction, exactly as a route does.
    app: PgPool,
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
    let base = start_server(app.clone()).await;
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
        app,
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

    /// `PATCH …/agents/{agent}` — the shipped settings door for an agent's display name.
    async fn rename_helper(&self, helper: Uuid, name: &str) -> (u16, Value) {
        let response = self
            .http
            .patch(format!(
                "{}/v1/workspaces/{}/agents/{}",
                self.base, self.t.workspace, helper
            ))
            .bearer_auth(&self.token)
            .json(&json!({"displayName": name}))
            .send()
            .await
            .expect("rename agent");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// The workspace's alias names, oldest first — the order the server gives them up
    /// (`created_at`, then `claude` → `오르트` → `oort` for the one instant they share).
    async fn aliases_oldest_first(&self) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT alias_norm FROM member_handle_alias WHERE workspace_id = $1 \
              ORDER BY created_at ASC, \
                       CASE alias_norm WHEN 'claude' THEN 0 WHEN '오르트' THEN 1 WHEN 'oort' THEN 2 \
                            ELSE 3 END, \
                       alias_norm COLLATE \"C\"",
        )
        .bind(self.t.workspace)
        .fetch_all(&self.su)
        .await
        .expect("aliases")
    }

    async fn alias_set(&self) -> BTreeSet<String> {
        self.aliases_oldest_first().await.into_iter().collect()
    }

    async fn display_name(&self, member: Uuid) -> String {
        sqlx::query_scalar("SELECT display_name FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(self.t.workspace)
            .bind(member)
            .fetch_one(&self.su)
            .await
            .expect("display name")
    }

    /// `(alias, reason)` of every `team_ai.alias.released` audit row, oldest first.
    async fn released_audits(&self) -> Vec<(String, String)> {
        sqlx::query(
            "SELECT detail->>'alias' AS alias, detail->>'reason' AS reason FROM audit_log \
              WHERE workspace_id = $1 AND action = 'team_ai.alias.released' \
              ORDER BY created_at, id",
        )
        .bind(self.t.workspace)
        .fetch_all(&self.su)
        .await
        .expect("released audits")
        .into_iter()
        .map(|row| (row.get("alias"), row.get("reason")))
        .collect()
    }

    /// `detail` of the `member.renamed` audit rows about `member`, oldest first.
    async fn renamed_audits(&self, member: Uuid) -> Vec<Value> {
        sqlx::query_scalar(
            "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'member.renamed' \
                AND subject_member_id = $2 ORDER BY created_at, id",
        )
        .bind(self.t.workspace)
        .bind(member)
        .fetch_all(&self.su)
        .await
        .expect("renamed audits")
    }

    /// The domain write a route or an approved card makes, called on the app role in a tenant
    /// transaction — for the branches the route's own roster check (409) would shadow.
    async fn rename_direct(
        &self,
        member: Uuid,
        name: &str,
    ) -> Result<Option<DisplayNameRename>, NameRejected> {
        let workspace = self.t.workspace;
        let name = name.to_string();
        momo_db::with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                rename_agent_display_name_in_tx(conn, workspace, member, &name).await
            })
        })
        .await
        .expect("rename transaction")
    }

    /// A plain `INSERT … ON CONFLICT DO NOTHING` into the alias table by the app role, with no
    /// help from the server functions. `Err((sqlstate, message))` is the database's refusal.
    async fn app_insert_alias(
        &self,
        workspace: Uuid,
        member: Uuid,
        alias: &str,
    ) -> Result<(), (String, String)> {
        insert_alias_as_app(&self.app, workspace, member, alias).await
    }
}

async fn insert_alias_as_app(
    app: &PgPool,
    workspace: Uuid,
    member: Uuid,
    alias: &str,
) -> Result<(), (String, String)> {
    let alias = alias.to_string();
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO member_handle_alias (workspace_id, member_id, alias, alias_norm) \
                 VALUES ($1, $2, $3, $3) ON CONFLICT (workspace_id, alias_norm) DO NOTHING",
            )
            .bind(workspace)
            .bind(member)
            .bind(&alias)
            .execute(&mut *conn)
            .await?;
            Ok::<(), momo_db::DbError>(())
        })
    })
    .await
    .map_err(|error| match error {
        momo_db::DbError::Sqlx(sqlx::Error::Database(database)) => (
            database
                .code()
                .map(|code| code.to_string())
                .unwrap_or_default(),
            database.message().to_string(),
        ),
        other => panic!("not a database refusal: {other}"),
    })
}

fn set<const N: usize>(names: [&str; N]) -> BTreeSet<String> {
    names.into_iter().map(str::to_string).collect()
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

// ---------------------------------------------------------------------------
// ADR-0201 증보 2026-10-31 v3 B10 (#4966) — the aliases follow the helper's display name.
//
// The server runs on `momo_app` (NOBYPASSRLS) and so do the direct calls below (`Harness::app`).
// Two tenants are alive in the tests that say so; each has its own server, workspace and helper.
// ---------------------------------------------------------------------------

const DEFAULTS: [&str; 3] = ["oort", "오르트", "claude"];

impl Harness {
    /// The roster the helper's prompt is built from, loaded as a worker would for `owner`.
    async fn load_roster(&self) -> team_ai::Roster {
        let (workspace, owner, channel) = (self.t.workspace, self.t.owner, self.t.channel);
        momo_db::with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(
                async move { team_ai::load_roster_in_tx(conn, workspace, owner, channel).await },
            )
        })
        .await
        .expect("roster")
    }
}

/// **B15-A12 / B10-3 / B10-6** — renaming the helper adds the new name as an alias, in the same
/// transaction as the rename, and the `member.renamed` audit row says so. The fixed three stay.
/// If the alias cannot be written the rename is not written either (and neither is the eviction
/// that would have made room). A second tenant does not move.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_a_rename_adds_the_new_name_as_an_alias_in_one_transaction() {
    let a = harness().await;
    let b = harness().await;
    let helper_a = a.enable().await;
    let helper_b = b.enable().await;

    // The role these tests speak as is the one production does.
    let (is_super, bypass_rls): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&a.app)
            .await
            .expect("role flags");
    assert!(
        !is_super && !bypass_rls,
        "the app role is neither superuser nor BYPASSRLS"
    );

    let (status, body) = a.rename_helper(helper_a, "별무리").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(a.display_name(helper_a).await, "별무리");
    assert_eq!(
        a.alias_set().await,
        set(["oort", "오르트", "claude", "별무리"]),
        "the fixed three stay and the new name is added"
    );
    let status = a.alias_status().await;
    for alias in ["oort", "오르트", "claude", "별무리"] {
        assert_eq!(status[alias], json!("registered"), "{alias}: {status}");
    }
    let renamed = a.renamed_audits(helper_a).await;
    assert_eq!(renamed.len(), 1, "{renamed:?}");
    assert_eq!(
        renamed[0]["alias"],
        json!({"state": "registered", "alias": "별무리", "evicted": []}),
        "B10-6: the rename's audit row says what became of the alias: {}",
        renamed[0]
    );
    let message = a.send("@별무리 안녕").await;
    assert_eq!(
        a.runs_for_message(message).await,
        vec![helper_a],
        "the new alias calls the helper"
    );

    // The other tenant has not moved; it can rename at its own pace.
    assert_eq!(b.alias_set().await, set(DEFAULTS));
    assert_eq!(b.display_name(helper_b).await, "oort 도우미");
    let (status, body) = b.rename_helper(helper_b, "Bob").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        b.alias_set().await,
        set(["oort", "오르트", "claude", "bob"])
    );
    assert_eq!(
        a.alias_set().await,
        set(["oort", "오르트", "claude", "별무리"]),
        "a rename in one workspace never reaches the other"
    );

    // One transaction: an alias the database refuses takes the rename down with it — and the
    // eviction that would have made room (the workspace holds four).
    sqlx::query("DROP TRIGGER IF EXISTS s3_4966_boom_trg ON member_handle_alias")
        .execute(&a.su)
        .await
        .expect("clean start");
    sqlx::query(
        "CREATE OR REPLACE FUNCTION s3_4966_boom() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN \
           IF NEW.alias_norm = '실패' THEN RAISE EXCEPTION 's3 4966: alias insert fails on purpose'; END IF; \
           RETURN NEW; \
         END $$",
    )
    .execute(&a.su)
    .await
    .expect("throwaway function");
    sqlx::query(
        "CREATE TRIGGER s3_4966_boom_trg BEFORE INSERT ON member_handle_alias \
         FOR EACH ROW EXECUTE FUNCTION s3_4966_boom()",
    )
    .execute(&a.su)
    .await
    .expect("throwaway trigger");
    let (failed_status, _) = a.rename_helper(helper_a, "실패").await;
    // The DDL goes before any assertion can fail.
    sqlx::query("DROP TRIGGER IF EXISTS s3_4966_boom_trg ON member_handle_alias")
        .execute(&a.su)
        .await
        .expect("drop throwaway trigger");
    sqlx::query("DROP FUNCTION IF EXISTS s3_4966_boom()")
        .execute(&a.su)
        .await
        .expect("drop throwaway function");
    assert_eq!(
        failed_status, 500,
        "the failed alias write fails the request"
    );
    assert_eq!(
        a.display_name(helper_a).await,
        "별무리",
        "the name did not change without its alias"
    );
    assert_eq!(
        a.alias_set().await,
        set(["oort", "오르트", "claude", "별무리"]),
        "no alias row, and the oldest one was not evicted for a rename that did not happen"
    );
    assert!(
        a.released_audits().await.is_empty(),
        "the eviction's audit row rolled back too"
    );
    assert_eq!(
        a.renamed_audits(helper_a).await.len(),
        1,
        "no audit row for a rename that did not happen"
    );
}

/// **B15-A12 / B10-3** — a fifth alias removes the oldest, one at a time, audited as `evicted`:
/// the fixed three share one instant and go `claude` → `오르트` → `oort`; then by age. Four stay.
/// The mentions follow: a removed name calls nobody, the newest calls the helper.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_a_fifth_alias_removes_the_oldest_one_at_a_time() {
    let h = harness().await;
    let helper = h.enable().await;
    assert_eq!(
        h.aliases_oldest_first().await,
        vec!["claude", "오르트", "oort"],
        "the fixed three share one instant and are given up in this order"
    );

    // (name given to the helper, the aliases it then holds oldest first, aliases evicted so far)
    let steps: [(&str, [&str; 4], &[&str]); 5] = [
        ("비서봇", ["claude", "오르트", "oort", "비서봇"], &[]),
        (
            "별무리",
            ["오르트", "oort", "비서봇", "별무리"],
            &["claude"],
        ),
        (
            "코메토",
            ["oort", "비서봇", "별무리", "코메토"],
            &["claude", "오르트"],
        ),
        (
            "오무",
            ["비서봇", "별무리", "코메토", "오무"],
            &["claude", "오르트", "oort"],
        ),
        (
            "하늘이",
            ["별무리", "코메토", "오무", "하늘이"],
            &["claude", "오르트", "oort", "비서봇"],
        ),
    ];
    for (name, held, evicted) in steps {
        let (status, body) = h.rename_helper(helper, name).await;
        assert_eq!(status, 200, "{name}: {body}");
        assert_eq!(
            h.aliases_oldest_first().await,
            held.to_vec(),
            "after {name}"
        );
        assert_eq!(
            h.released_audits().await,
            evicted
                .iter()
                .map(|alias| (alias.to_string(), "evicted".to_string()))
                .collect::<Vec<_>>(),
            "after {name}: one audit row per removed alias, in the order they went"
        );
    }

    // The settings record names only what can be called now.
    let status = h.alias_status().await;
    let keys: BTreeSet<String> = status
        .as_object()
        .expect("status object")
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        keys,
        set(["별무리", "코메토", "오무", "하늘이"]),
        "{status}"
    );
    assert!(status
        .as_object()
        .unwrap()
        .values()
        .all(|state| state == "registered"));
    let last = h
        .renamed_audits(helper)
        .await
        .pop()
        .expect("last rename audit");
    assert_eq!(
        last["alias"],
        json!({"state": "registered", "alias": "하늘이", "evicted": ["비서봇"]}),
        "{last}"
    );

    // …and the mention parser agrees with the table.
    for gone in ["@claude 요약", "@오르트 요약", "@oort 요약", "@비서봇 요약"] {
        let message = h.send(gone).await;
        assert!(
            h.runs_for_message(message).await.is_empty(),
            "{gone}: an alias that was given up calls nobody"
        );
    }
    for held in ["@하늘이 요약", "@오무 요약", "@oort-helper 요약"] {
        let message = h.send(held).await;
        assert_eq!(h.runs_for_message(message).await, vec![helper], "{held}");
    }
}

/// **B10-3** — a name whose alias is already held changes nothing (not even an eviction, with four
/// held); a name with a space gives no alias and says `not_derivable`, and `@표시 이름` still calls.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_the_same_name_changes_nothing_and_a_spaced_name_is_not_derivable() {
    let h = harness().await;
    let helper = h.enable().await;
    assert_eq!(h.rename_helper(helper, "별무리").await.0, 200);
    let rows = |h: &Harness| {
        let workspace = h.t.workspace;
        let su = h.su.clone();
        async move {
            sqlx::query(
                "SELECT alias_norm, alias, created_at::text AS created FROM member_handle_alias \
                  WHERE workspace_id = $1 ORDER BY alias_norm COLLATE \"C\"",
            )
            .bind(workspace)
            .fetch_all(&su)
            .await
            .expect("rows")
            .into_iter()
            .map(|row| {
                (
                    row.get::<String, _>("alias_norm"),
                    row.get::<String, _>("alias"),
                    row.get::<String, _>("created"),
                )
            })
            .collect::<Vec<_>>()
        }
    };
    let rows_before = rows(&h).await;
    let status_before = h.alias_status().await;
    assert_eq!(rows_before.len(), 4);

    // The same name again.
    let (status, body) = h.rename_helper(helper, "별무리").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(rows(&h).await, rows_before, "same rows, same ages");
    assert_eq!(h.alias_status().await, status_before);
    assert!(h.released_audits().await.is_empty());
    assert_eq!(
        h.renamed_audits(helper).await[1]["alias"]["state"],
        json!("already_registered")
    );

    // A name whose alias exists already — here a fixed one, with four held: nothing is evicted.
    let (status, body) = h.rename_helper(helper, "OORT").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        rows(&h).await,
        rows_before,
        "`oort` was held: nothing added, nothing removed"
    );
    assert!(
        h.released_audits().await.is_empty(),
        "no eviction for an alias that is already there"
    );

    // A name with a space: no alias, and the record says why. The name itself is the administrator's.
    let (status, body) = h.rename_helper(helper, "두 단어").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(h.display_name(helper).await, "두 단어");
    assert_eq!(
        rows(&h).await,
        rows_before,
        "a spaced name adds no alias and removes none"
    );
    let status = h.alias_status().await;
    assert_eq!(status["@name"], json!("not_derivable"), "{status}");
    for alias in ["oort", "오르트", "claude", "별무리"] {
        assert_eq!(
            status[alias], status_before[alias],
            "{alias} is untouched: {status}"
        );
    }
    assert_eq!(
        h.renamed_audits(helper).await[3]["alias"],
        json!({"state": "not_derivable", "evicted": []})
    );
    let message = h.send("@두 단어 안녕").await;
    assert_eq!(
        h.runs_for_message(message).await,
        vec![helper],
        "`@표시 이름` calls the helper whether or not the name has an alias"
    );

    // The next name that has an alias takes the note away (and makes room, oldest first).
    let (status, body) = h.rename_helper(helper, "새이름").await;
    assert_eq!(status, 200, "{body}");
    let status = h.alias_status().await;
    assert!(status.get("@name").is_none(), "{status}");
    assert_eq!(status["새이름"], json!("registered"));
    assert_eq!(
        h.released_audits().await,
        vec![("claude".to_string(), "evicted".to_string())]
    );
}

/// **B15-A12 / B10-5** — a live member's handle that reads the same wins (not registered); a
/// display name that reads the same is a warning (registered). The route's own roster check would
/// answer 409 first, so these call the one write directly. The reserved words are refused before
/// anything is written, by the write and by the route, for the helper only.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_a_real_handle_wins_and_reserved_words_are_refused() {
    let h = harness().await;
    let helper = h.enable().await;
    h.seed_agent("bob", "진짜 bob").await; // a live member whose HANDLE is `bob`
    h.seed_agent("tom-agent", "도우미x").await; // a live member whose DISPLAY NAME is `도우미x`

    // The handle wins.
    let renamed = h
        .rename_direct(helper, "Bob")
        .await
        .expect("not a reserved word")
        .expect("a live agent");
    let sync = renamed.alias_sync.expect("the team AI's alias sync ran");
    assert_eq!(sync.name, NameAlias::Taken("bob".into()));
    assert!(sync.evicted.is_empty());
    assert_eq!(
        h.alias_set().await,
        set(DEFAULTS),
        "`bob` is not registered"
    );
    assert_eq!(h.alias_status().await["bob"], json!("taken"));
    assert_eq!(
        h.display_name(helper).await,
        "Bob",
        "the name is still the administrator's"
    );
    let message = h.send("@bob 안녕").await;
    assert!(
        !h.runs_for_message(message).await.contains(&helper),
        "`@bob` is the real member's, not the helper's"
    );

    // A display name that reads the same: registered, with the warning.
    let sync = h
        .rename_direct(helper, "도우미X")
        .await
        .expect("not a reserved word")
        .expect("a live agent")
        .alias_sync
        .expect("sync ran");
    assert_eq!(sync.name, NameAlias::DisplayNameMatch("도우미x".into()));
    assert!(h.alias_set().await.contains("도우미x"));
    let status = h.alias_status().await;
    assert_eq!(status["도우미x"], json!("display_name_match"), "{status}");
    assert!(
        status.get("bob").is_none(),
        "an earlier name's `taken` does not outlive it: {status}"
    );

    // Reserved words: refused before anything is written — by the write itself …
    let before = (
        h.display_name(helper).await,
        h.aliases_oldest_first().await,
        h.alias_status().await,
    );
    for word in [
        "all",
        "Admin",
        "SYSTEM",
        "here",
        "channel",
        "everyone",
        "모두",
        "전체",
        "oort-helper",
        "Oort Helper",
    ] {
        assert_eq!(
            h.rename_direct(helper, word).await.unwrap_err(),
            NameRejected::Reserved,
            "{word}"
        );
        // … and by the route the settings screen uses.
        let (status, body) = h.rename_helper(helper, word).await;
        assert_eq!(status, 400, "{word}: {body}");
    }
    assert_eq!(
        (
            h.display_name(helper).await,
            h.aliases_oldest_first().await,
            h.alias_status().await
        ),
        before,
        "a refused name leaves the name, the aliases and the record as they were"
    );
    assert!(
        h.renamed_audits(helper).await.is_empty(),
        "nothing was renamed through the route"
    );

    // Only the team AI is held to the list: any other agent keeps today's behaviour.
    let other = h.seed_agent("other-bot", "다른봇").await;
    let (status, body) = h.rename_helper(other, "all").await;
    assert_eq!(status, 200, "{body}");
    let renamed = h
        .rename_direct(other, "Admin")
        .await
        .unwrap()
        .expect("live agent");
    assert!(
        renamed.alias_sync.is_none(),
        "an ordinary agent gets no alias sync"
    );
    assert!(!h.alias_set().await.contains("all") && !h.alias_set().await.contains("admin"));

    // A name that was set before the list existed (here: by SQL) still gives no alias — the sync
    // looks at the alias itself, so a switch-on that reads the name back cannot register `all`.
    sqlx::query("UPDATE member SET display_name = 'all' WHERE id = $1")
        .bind(helper)
        .execute(&h.su)
        .await
        .expect("a legacy name");
    let workspace = h.t.workspace;
    let sync = momo_db::with_tenant_tx(&h.app, workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::team_ai_alias::sync_team_ai_aliases_in_tx(
                conn, workspace, helper, "all",
            )
            .await
        })
    })
    .await
    .expect("sync transaction")
    .expect("the helper, switched on");
    assert_eq!(sync.name, NameAlias::Reserved);
    assert!(!h.alias_set().await.contains("all"));
    assert_eq!(h.alias_status().await["@name"], json!("reserved"));
}

/// **B10-5 / H2-4** — the reverse collision still holds for the alias a *name* gave: a member who
/// takes that handle later gets it, in the same transaction, with an audit row and a `taken` note.
/// Only that alias goes; the others stay.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_a_member_who_takes_the_handle_later_releases_the_name_alias() {
    let h = harness().await;
    let helper = h.enable().await;
    let (status, body) = h.rename_helper(helper, "Bob").await;
    assert_eq!(status, 200, "{body}");
    assert!(h.alias_set().await.contains("bob"));

    let real = h.seed_agent("bob", "진짜 밥").await;
    assert_eq!(
        h.alias_set().await,
        set(DEFAULTS),
        "the real handle took `bob` back and nothing else moved"
    );
    assert_eq!(h.alias_status().await["bob"], json!("taken"));
    assert_eq!(
        h.released_audits().await,
        vec![("bob".to_string(), "handle_taken".to_string())]
    );
    let message = h.send("@bob 안녕").await;
    assert_eq!(h.runs_for_message(message).await, vec![real]);
}

/// **B15-A12 / B10-4** — the database holds the line without the app: an alias for anyone but the
/// workspace's team AI is refused, and so is a fifth. The old fixed-set CHECK is gone, the shape
/// CHECK is not, and putting back an alias the helper already holds is not a fifth.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_the_database_holds_the_line_without_the_app() {
    let a = harness().await;
    let b = harness().await;
    let helper_a = a.enable().await;
    let helper_b = b.enable().await;
    let (ws_a, ws_b) = (a.t.workspace, b.t.workspace);
    let grok = a.seed_agent("grokbot", "그록봇").await;

    // Anyone but the helper: a person, another agent, another tenant's helper.
    for (who, member) in [
        ("a person", a.t.owner),
        ("another agent", grok),
        ("B's helper", helper_b),
    ] {
        let (code, message) = a.app_insert_alias(ws_a, member, "zzz").await.unwrap_err();
        assert_eq!(code, "23514", "{who}: {message}");
        assert!(message.contains("team AI member"), "{who}: {message}");
    }
    assert_eq!(a.alias_set().await, set(DEFAULTS));

    // The fixed set is gone: any shaped alias of the helper is accepted — up to four.
    a.app_insert_alias(ws_a, helper_a, "ab")
        .await
        .expect("a fourth alias");
    assert_eq!(a.alias_set().await, set(["oort", "오르트", "claude", "ab"]));
    let (code, message) = a.app_insert_alias(ws_a, helper_a, "cd").await.unwrap_err();
    assert_eq!(code, "23514", "{message}");
    assert!(message.contains("at most 4"), "{message}");
    assert_eq!(a.alias_set().await.len(), 4, "the fifth was not written");

    // Putting back one it already holds is not a fifth (the BEFORE trigger runs before ON CONFLICT).
    a.app_insert_alias(ws_a, helper_a, "oort")
        .await
        .expect("a re-insert is not a fifth");
    assert_eq!(a.alias_set().await.len(), 4);

    // The limit is per workspace: B has its own room.
    b.app_insert_alias(ws_b, helper_b, "ab")
        .await
        .expect("B's fourth alias");
    assert_eq!(b.alias_set().await.len(), 4);
    assert_eq!(a.alias_set().await.len(), 4);

    // The shape rule is still a CHECK of its own.
    sqlx::query("DELETE FROM member_handle_alias WHERE workspace_id = $1 AND alias_norm = 'ab'")
        .bind(ws_a)
        .execute(&a.su)
        .await
        .expect("make room");
    let (code, message) = a
        .app_insert_alias(ws_a, helper_a, "two words")
        .await
        .unwrap_err();
    assert_eq!(code, "23514");
    assert!(
        message.contains("member_handle_alias_shape_ck"),
        "{message}"
    );
    let fixed_set_checks: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_constraint WHERE conname = 'member_handle_alias_v2_set_ck'",
    )
    .fetch_one(&a.su)
    .await
    .expect("constraint count");
    assert_eq!(
        fixed_set_checks, 0,
        "migration 166 dropped the fixed-set CHECK"
    );

    // Moving a row to someone else is refused too (the trigger is on UPDATE as well).
    let error = sqlx::query(
        "UPDATE member_handle_alias SET member_id = $1 WHERE workspace_id = $2 AND alias_norm = 'oort'",
    )
    .bind(a.t.owner)
    .bind(ws_a)
    .execute(&a.su)
    .await
    .expect_err("an alias cannot be handed to a person");
    match error {
        sqlx::Error::Database(database) => {
            assert_eq!(database.code().as_deref(), Some("23514"));
            assert!(
                database.message().contains("team AI member"),
                "{}",
                database.message()
            );
        }
        other => panic!("not a database refusal: {other}"),
    }
}

/// **B10-3** — switching on an already-on helper (the next-step card does) must not put back an
/// alias that was given up to make room, and must not fail because four are held. Off removes
/// every alias; a rename while off adds none; on again seeds the fixed three once and the name the
/// helper has now follows, strictly newer than the three.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_switching_on_again_does_not_resurrect_an_evicted_alias() {
    let h = harness().await;
    let helper = h.enable().await;
    for name in ["비서봇", "별무리"] {
        assert_eq!(h.rename_helper(helper, name).await.0, 200);
    }
    let before = h.aliases_oldest_first().await;
    assert_eq!(
        before,
        vec!["오르트", "oort", "비서봇", "별무리"],
        "`claude` was given up"
    );
    let status_before = h.alias_status().await;

    let (status, body) = h.patch_settings(json!({"team_ai_fast_path": true})).await;
    assert_eq!(status, 200, "four held is not a failure: {body}");
    assert_eq!(
        h.aliases_oldest_first().await,
        before,
        "same aliases, same order"
    );
    assert_eq!(h.alias_status().await, status_before);
    assert!(
        !h.alias_set().await.contains("claude"),
        "`claude` is not resurrected"
    );

    // Off: every alias goes. A rename while off writes the name and nothing else.
    let (status, body) = h.patch_settings(json!({"team_ai_fast_path": false})).await;
    assert_eq!(status, 200, "{body}");
    assert!(h.aliases_oldest_first().await.is_empty());
    let (status, body) = h.rename_helper(helper, "셋째봇").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(h.display_name(helper).await, "셋째봇");
    assert!(
        h.aliases_oldest_first().await.is_empty(),
        "off means no alias calls anybody"
    );
    assert_eq!(h.alias_status().await, Value::Null);
    assert_eq!(
        h.renamed_audits(helper).await.pop().unwrap().get("alias"),
        None,
        "no sync ran, so there is nothing to say"
    );

    // On again: the fixed three, once — and the name the helper has now.
    h.enable().await;
    assert_eq!(
        h.aliases_oldest_first().await,
        vec!["claude", "오르트", "oort", "셋째봇"],
        "the name's alias is strictly newer than the three seeded in the same transaction"
    );
    let status = h.alias_status().await;
    for alias in ["oort", "오르트", "claude", "셋째봇"] {
        assert_eq!(status[alias], json!("registered"), "{alias}: {status}");
    }
}

/// **B10-7 / B15-A16** — the helper's prompt carries the name it has now, in the data block, and
/// no fixed sentence names the default. (The wording itself is unit-tested beside `system_prompt`.)
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_the_prompt_carries_the_current_display_name() {
    let h = harness().await;
    let helper = h.enable().await;
    let roster = h.load_roster().await;
    assert_eq!(
        roster.helper_display_name, "oort 도우미",
        "the name it is created with"
    );
    assert!(team_ai::system_prompt(&roster, WebSearch::Available).contains("네 이름: oort 도우미"));

    let (status, body) = h.rename_helper(helper, "별무리").await;
    assert_eq!(status, 200, "{body}");
    let roster = h.load_roster().await;
    assert_eq!(roster.helper_display_name, "별무리");
    let prompt = team_ai::system_prompt(&roster, WebSearch::Available);
    assert!(prompt.contains("네 이름: 별무리"), "{prompt}");
    assert!(
        !prompt.contains("oort 도우미"),
        "the old name is not a fixed sentence of the prompt: {prompt}"
    );
}

/// **B10-4** — two writers cannot both take the last slot. The trigger takes a per-workspace
/// advisory lock before it counts: writer 1 holds an uncommitted fourth alias, writer 2's other
/// alias waits for it, and once writer 1 commits, writer 2 is refused as the fifth.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector pg18 superuser)"]
async fn b10_two_writers_cannot_both_take_the_last_slot() {
    let h = harness().await;
    let helper = h.enable().await;
    let workspace = h.t.workspace;
    assert_eq!(h.alias_set().await.len(), 3);

    let mut first = h.app.begin().await.expect("writer 1 begins");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(workspace.to_string())
        .execute(&mut *first)
        .await
        .expect("writer 1 binds the tenant");
    sqlx::query(
        "INSERT INTO member_handle_alias (workspace_id, member_id, alias, alias_norm) \
         VALUES ($1, $2, 'ab', 'ab')",
    )
    .bind(workspace)
    .bind(helper)
    .execute(&mut *first)
    .await
    .expect("writer 1's fourth alias");

    let pool = h.app.clone();
    let second =
        tokio::spawn(async move { insert_alias_as_app(&pool, workspace, helper, "cd").await });
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert!(
        !second.is_finished(),
        "writer 2 waits for writer 1's lock instead of counting three and taking the slot too"
    );
    first.commit().await.expect("writer 1 commits");
    let (code, message) = second.await.expect("writer 2 joins").unwrap_err();
    assert_eq!(code, "23514", "{message}");
    assert!(message.contains("at most 4"), "{message}");
    assert_eq!(h.alias_set().await, set(["oort", "오르트", "claude", "ab"]));
}
