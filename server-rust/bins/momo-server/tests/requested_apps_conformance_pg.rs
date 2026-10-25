//! #4313 / ADR-0113 증보 3 F5 — the send request's `apps` field and the server-owned
//! `props.requestedApps` marker, on a real PostgreSQL and a real Axum router (`momo_app`, NOBYPASSRLS).
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_valid_apps_list_is_stored_once_per_app_and_read_back` | 3 distinct installed apps (repeats collapsed) → 201, `props.requestedApps` is the de-duplicated array on the echo, in the row and on the history page | the stamp is dropped, or de-duplication is |
//! | `every_refusal_is_one_coded_400_and_leaves_nothing_behind` | not installed, installed-but-off, uninstalled, unknown id, one bad id among good ones, four distinct apps, an **agent** author → 400 `apps_unavailable`; no message row, no outbox row | any rule is dropped from `judge_in_tx`; the check runs after commit instead of before |
//! | `a_props_map_requested_apps_is_dropped_whatever_apps_says` | a forged `props.requestedApps` is stripped with and without `apps`, and with `apps` the stored value is the validated array, not the forged string | `requestedApps` leaves `SERVER_OWNED_APP_PROPS_KEYS` |
//! | `an_idempotent_retry_after_uninstall_is_201_with_the_first_saved_marker` | first send with an installed app → 201; the app is uninstalled through the real route; the **same `clientMsgId`** answers 201, the same message id and the first marker (even when the retry names other apps); a **new** `clientMsgId` with the same app is now 400 | validation runs before the dedupe check (the retry turns into a 400) |
//! | `requested_apps_change_neither_delivery_nor_grants` | a non-owner who attaches `apps` to a mention of someone's connector agent is refused exactly like one who does not (0 jobs, 1 skipped-mention audit row each); the owner's job carries the same `tool_grants` with and without `apps` | the owner/connector guard consults `requestedApps` (the sabotage: skip the owner check when the marker is present) |
//!
//! `#[ignore]` — needs a real PostgreSQL 18 + pgvector (superuser URL); run on an isolated database:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test requested_apps_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;

use apps_pg::*;
use momo_db::sqlx;
use momo_db::PgPool;
use serde_json::{json, Value};
use std::sync::OnceLock;
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct Fixture {
    workspace: Uuid,
    admin_jwt: String,
    author: Uuid,
    author_jwt: String,
    stranger_jwt: String,
    channel: Uuid,
    /// A hosted vendor agent (live connection, approved for `channel`), a member of `channel`.
    agent: SeededAgent,
    /// A plain agent that posts over REST with a generic `messages:write` bearer, a member of `channel`.
    bot_bearer: String,
}

/// Installed and enabled: gmail, github, linear, notion. Installed but switched off: calendar.
/// Installed and then uninstalled: google-drive. Not installed at all: the team drive.
async fn seed(su: &PgPool) -> Fixture {
    let workspace = seed_workspace(su).await;
    let (admin, admin_jwt) = seed_human(su, workspace, "admin", "관리자").await;
    let (author, author_jwt) = seed_human(su, workspace, "member", "이도현").await;
    let (stranger, stranger_jwt) = seed_human(su, workspace, "member", "박서연").await;
    let channel = seed_channel(su, workspace, "public", &[author, stranger]).await;
    let agent = seed_hosted_agent(su, workspace, author, "appagent", &[channel], true, false).await;
    join_channel(su, workspace, channel, agent.id).await;
    let bot = seed_managed_agent(su, workspace, author, "botagent").await;
    join_channel(su, workspace, channel, bot.id).await;
    let bot_bearer = seed_generic_agent_bearer(su, workspace, bot.id).await;
    for plugin in [GMAIL, GITHUB, LINEAR, NOTION] {
        install_app(su, workspace, plugin, admin, true).await;
    }
    install_app(su, workspace, CALENDAR, admin, false).await;
    install_app(su, workspace, GDRIVE, admin, true).await;
    revoke_install(su, workspace, GDRIVE, admin).await;
    Fixture {
        workspace,
        admin_jwt,
        author,
        author_jwt,
        stranger_jwt,
        channel,
        agent,
        bot_bearer,
    }
}

async fn setup(options: ServerOptions) -> (PgPool, Fixture, String, reqwest::Client) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await, options).await;
    (su, fixture, base, reqwest::Client::new())
}

fn messages_url(base: &str, f: &Fixture) -> String {
    format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        f.workspace, f.channel
    )
}

/// `(status, body)` of one send.
async fn post(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    bearer: &str,
    body: Value,
) -> (u16, Value) {
    let response = client
        .post(messages_url(base, f))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("send");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn send_body(client_msg_id: Uuid, apps: Option<Value>) -> Value {
    let mut body =
        json!({"clientMsgId": client_msg_id, "type": "text", "body": "메일 확인해 줘요"});
    if let Some(apps) = apps {
        body["apps"] = apps;
    }
    body
}

async fn message_rows(su: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
        .bind(f.workspace)
        .bind(f.channel)
        .fetch_one(su)
        .await
        .expect("count messages")
}

async fn outbox_rows(su: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(su)
        .await
        .expect("count outbox")
}

async fn stored_props(su: &PgPool, message: &str) -> Value {
    sqlx::query_scalar("SELECT props FROM message WHERE id = $1::uuid")
        .bind(message)
        .fetch_one(su)
        .await
        .expect("stored props")
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn a_valid_apps_list_is_stored_once_per_app_and_read_back() {
    let _guard = test_lock().await;
    let (su, f, base, client) = setup(ServerOptions::hosted_open()).await;

    let (status, echo) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(Uuid::new_v4(), Some(json!([GMAIL, GITHUB, GMAIL, GITHUB]))),
    )
    .await;
    assert_eq!(status, 201, "{echo}");
    assert_eq!(
        echo["props"]["requestedApps"],
        json!([GMAIL, GITHUB]),
        "the echo"
    );
    let id = echo["id"].as_str().expect("message id");
    assert_eq!(
        stored_props(&su, id).await["requestedApps"],
        json!([GMAIL, GITHUB]),
        "the row: an array of distinct ids, first-seen order"
    );

    // The history page carries it too (the key is read back by every client from the same place).
    let page: Value = client
        .get(messages_url(&base, &f))
        .bearer_auth(&f.author_jwt)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("history body");
    let row = page["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message["id"] == echo["id"])
        .expect("the sent message is on the page");
    assert_eq!(row["props"]["requestedApps"], json!([GMAIL, GITHUB]));

    // No `apps` and an empty `apps` are the same request: no key, never `[]`.
    for apps in [None, Some(json!([]))] {
        let (status, echo) = post(
            &client,
            &base,
            &f,
            &f.author_jwt,
            send_body(Uuid::new_v4(), apps),
        )
        .await;
        assert_eq!(status, 201, "{echo}");
        let id = echo["id"].as_str().expect("message id");
        assert!(
            stored_props(&su, id).await.get("requestedApps").is_none(),
            "nothing requested, nothing stored"
        );
    }
    // Control: three distinct apps with repeats is the limit, not over it.
    let (status, echo) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(
            Uuid::new_v4(),
            Some(json!([GMAIL, GITHUB, LINEAR, GMAIL, LINEAR])),
        ),
    )
    .await;
    assert_eq!(status, 201, "{echo}");
    assert_eq!(
        echo["props"]["requestedApps"],
        json!([GMAIL, GITHUB, LINEAR])
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn every_refusal_is_one_coded_400_and_leaves_nothing_behind() {
    let _guard = test_lock().await;
    let (su, f, base, client) = setup(ServerOptions::hosted_open()).await;
    let agent_bearer = f.bot_bearer.clone();

    let cases: Vec<(&str, &str, Value)> = vec![
        ("not installed", f.author_jwt.as_str(), json!([TEAM_DRIVE])),
        (
            "installed but switched off",
            f.author_jwt.as_str(),
            json!([CALENDAR]),
        ),
        ("uninstalled", f.author_jwt.as_str(), json!([GDRIVE])),
        (
            "an id that is not an app",
            f.author_jwt.as_str(),
            json!(["com.momo.plugins.nonexistent"]),
        ),
        (
            "a case variant",
            f.author_jwt.as_str(),
            json!(["Com.Momo.Plugins.Gmail"]),
        ),
        (
            "one bad id among good ones",
            f.author_jwt.as_str(),
            json!([GMAIL, TEAM_DRIVE]),
        ),
        (
            "four distinct installed apps",
            f.author_jwt.as_str(),
            json!([GMAIL, GITHUB, LINEAR, NOTION]),
        ),
        (
            "an agent author, even with a valid app",
            agent_bearer.as_str(),
            json!([GMAIL]),
        ),
    ];
    for (label, bearer, apps) in cases {
        let messages_before = message_rows(&su, &f).await;
        let outbox_before = outbox_rows(&su, &f).await;
        let (status, body) = post(
            &client,
            &base,
            &f,
            bearer,
            send_body(Uuid::new_v4(), Some(apps)),
        )
        .await;
        assert_eq!(status, 400, "{label}: {body}");
        assert_eq!(body["error"]["code"], "apps_unavailable", "{label}: {body}");
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(!message.contains("routing"), "{label}: {message}");
        assert_eq!(
            message_rows(&su, &f).await,
            messages_before,
            "{label}: the refused message must not be stored"
        );
        assert_eq!(
            outbox_rows(&su, &f).await,
            outbox_before,
            "{label}: and must leave no outbox row behind"
        );
    }
    // Controls: the same two senders with no `apps` are delivered, so the 400s above are the marker's.
    for bearer in [f.author_jwt.as_str(), agent_bearer.as_str()] {
        let (status, body) =
            post(&client, &base, &f, bearer, send_body(Uuid::new_v4(), None)).await;
        assert_eq!(status, 201, "{body}");
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn a_props_map_requested_apps_is_dropped_whatever_apps_says() {
    let _guard = test_lock().await;
    let (su, f, base, client) = setup(ServerOptions::hosted_open()).await;

    // A forged marker in the flat props map, no `apps`: stripped, nothing replaces it.
    let mut body = send_body(Uuid::new_v4(), None);
    body["props"] = json!({"requestedApps": "forged", "keep": "me"});
    let (status, echo) = post(&client, &base, &f, &f.author_jwt, body).await;
    assert_eq!(status, 201, "{echo}");
    let id = echo["id"].as_str().expect("message id");
    let stored = stored_props(&su, id).await;
    assert!(stored.get("requestedApps").is_none(), "{stored}");
    assert_eq!(stored["keep"], "me", "ordinary props survive");

    // The same forgery next to a valid `apps`: the stored value is the validated array.
    let mut body = send_body(Uuid::new_v4(), Some(json!([GMAIL])));
    body["props"] = json!({"requestedApps": "forged"});
    let (status, echo) = post(&client, &base, &f, &f.author_jwt, body).await;
    assert_eq!(status, 201, "{echo}");
    let stored = stored_props(&su, echo["id"].as_str().expect("message id")).await;
    assert_eq!(stored["requestedApps"], json!([GMAIL]));
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn an_idempotent_retry_after_uninstall_is_201_with_the_first_saved_marker() {
    let _guard = test_lock().await;
    let (su, f, base, client) = setup(ServerOptions::hosted_open()).await;
    let client_msg_id = Uuid::new_v4();

    let (status, first) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(client_msg_id, Some(json!([GMAIL]))),
    )
    .await;
    assert_eq!(status, 201, "{first}");
    assert_eq!(first["props"]["requestedApps"], json!([GMAIL]));
    assert_eq!(message_rows(&su, &f).await, 1);

    // The admin uninstalls gmail through the real route.
    let uninstall = client
        .delete(format!(
            "{base}/v1/workspaces/{}/plugins/{GMAIL}/install",
            f.workspace
        ))
        .bearer_auth(&f.admin_jwt)
        .send()
        .await
        .expect("uninstall");
    assert_eq!(
        uninstall.status().as_u16(),
        200,
        "the uninstall took effect"
    );

    // The very same request again: 201, the same message, the first saved marker, no second row.
    let (status, retry) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(client_msg_id, Some(json!([GMAIL]))),
    )
    .await;
    assert_eq!(
        status, 201,
        "a retry is never turned into a refusal: {retry}"
    );
    assert_eq!(retry["id"], first["id"], "the same message");
    assert_eq!(
        retry["props"]["requestedApps"],
        json!([GMAIL]),
        "the first saved marker"
    );
    assert_eq!(message_rows(&su, &f).await, 1, "no duplicate send");

    // …even if the retry names something else entirely: the stored message answers, `apps` is not read.
    let (status, odd) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(client_msg_id, Some(json!(["com.momo.plugins.nonexistent"]))),
    )
    .await;
    assert_eq!(status, 201, "{odd}");
    assert_eq!(odd["props"]["requestedApps"], json!([GMAIL]));
    assert_eq!(message_rows(&su, &f).await, 1);

    // Control: a NEW send naming the now-uninstalled app is refused, so the retry above skipped a check
    // that is alive, not one that was never there.
    let (status, fresh) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        send_body(Uuid::new_v4(), Some(json!([GMAIL]))),
    )
    .await;
    assert_eq!(status, 400, "{fresh}");
    assert_eq!(fresh["error"]["code"], "apps_unavailable");
    assert_eq!(message_rows(&su, &f).await, 1);
}

/// Everything in the delivery decision for one mention, as numbers.
async fn skipped_connector_mentions(su: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='agent.mention.skipped' \
            AND subject_member_id=$2 AND detail->>'reason'='connector_owner_non_owner'",
    )
    .bind(f.workspace)
    .bind(f.agent.id)
    .fetch_one(su)
    .await
    .expect("count skipped mentions")
}

async fn latest_job_tool_grants(su: &PgPool, f: &Fixture) -> Value {
    sqlx::query_scalar(
        "SELECT COALESCE(payload->'tool_grants', 'null'::jsonb) FROM outbox \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2 ORDER BY id DESC LIMIT 1",
    )
    .bind(f.workspace)
    .bind(f.agent.id)
    .fetch_one(su)
    .await
    .expect("latest job payload")
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn requested_apps_change_neither_delivery_nor_grants() {
    let _guard = test_lock().await;
    let (su, f, base, client) = setup(ServerOptions::hosted_open()).await;
    // The agent runs its owner's (author's) apps: only the owner's calls are delivered (E3).
    mark_connector_owner(&su, f.workspace, f.agent.id, f.author).await;
    // The owner's grant through the real route, so the capability projection the `tool_grants`
    // producer reads exists too (a bare `plugin_grant` row would leave the list empty and the
    // comparison below vacuous).
    let grant = client
        .post(format!(
            "{base}/v1/workspaces/{}/plugins/{GMAIL}/grants",
            f.workspace
        ))
        .bearer_auth(&f.author_jwt)
        .json(&json!({"scope": "gmail:read"}))
        .send()
        .await
        .expect("grant gmail:read");
    assert_eq!(grant.status().as_u16(), 201, "the owner grants gmail:read");
    let mention = |apps: Option<Value>| {
        let mut body = send_body(Uuid::new_v4(), apps);
        body["body"] = json!(format!("@{} 메일 확인해 줘요", f.agent.handle));
        body
    };

    // The stranger is refused without the marker …
    let skipped_before = skipped_connector_mentions(&su, &f).await;
    let jobs_before = jobs_for(&su, f.workspace, f.agent.id).await;
    let (status, plain) = post(&client, &base, &f, &f.stranger_jwt, mention(None)).await;
    assert_eq!(status, 201, "{plain}");
    assert_eq!(
        jobs_for(&su, f.workspace, f.agent.id).await,
        jobs_before,
        "no job"
    );
    assert_eq!(
        skipped_connector_mentions(&su, &f).await,
        skipped_before + 1
    );

    // … and exactly the same with it: attaching `apps` buys the stranger nothing.
    let (status, marked) = post(
        &client,
        &base,
        &f,
        &f.stranger_jwt,
        mention(Some(json!([GMAIL]))),
    )
    .await;
    assert_eq!(status, 201, "{marked}");
    assert_eq!(marked["props"]["requestedApps"], json!([GMAIL]));
    assert_eq!(
        jobs_for(&su, f.workspace, f.agent.id).await,
        jobs_before,
        "the marker did not open the owner-only guard"
    );
    assert_eq!(
        skipped_connector_mentions(&su, &f).await,
        skipped_before + 2,
        "refused and audited exactly like the mention without the marker"
    );

    // The owner is delivered either way, and the job's `tool_grants` do not depend on the marker.
    let (status, _) = post(&client, &base, &f, &f.author_jwt, mention(None)).await;
    assert_eq!(status, 201);
    assert_eq!(
        jobs_for(&su, f.workspace, f.agent.id).await,
        jobs_before + 1
    );
    let without = latest_job_tool_grants(&su, &f).await;
    let (status, _) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        mention(Some(json!([GMAIL]))),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(
        jobs_for(&su, f.workspace, f.agent.id).await,
        jobs_before + 2
    );
    let with = latest_job_tool_grants(&su, &f).await;
    assert_eq!(
        with, without,
        "tool_grants are the grant rows', not the marker's"
    );
    assert!(
        with.as_array().is_some_and(|grants| !grants.is_empty()),
        "the control is not vacuous: the owner's gmail grant is on the job: {with}"
    );

    // And a marker for an app the owner never granted adds no grant to the job.
    let (status, _) = post(
        &client,
        &base,
        &f,
        &f.author_jwt,
        mention(Some(json!([GITHUB]))),
    )
    .await;
    assert_eq!(status, 201);
    let other = latest_job_tool_grants(&su, &f).await;
    assert_eq!(other, without, "requesting github grants nothing");
}
