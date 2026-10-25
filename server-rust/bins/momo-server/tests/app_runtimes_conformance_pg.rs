//! #4313 / ADR-0113 증보 3 F8 — `GET /v1/workspaces/{ws}/members/me/app-runtimes`, on a real PostgreSQL and a
//! real Axum router (`momo_app`, NOBYPASSRLS). The no-database gates (both agent layers, the workspace
//! scope) are `app_runtimes_gates.rs`; the pure projection and its parity with `delivery_gate` are unit
//! tests in `routes/app_runtimes.rs` and `routes/agent_mentions.rs`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `only_my_app_runtimes_are_listed_and_never_anyone_elses` | next to mine sit another member's connector agent, co-hosted trial and `owner_only` harness (all marked) and my own personal agent, harness and managed agent: the answer is exactly my hosted vendor agent and my trial (a stopped trial **stays**, with `blocked: "members"`), `apps` ⊆ my grants, and nothing of the other member (ids, grants) is on the wire; the other member sees exactly theirs | the owner predicate is deleted from `runtime_path`; `apps` reads another member's grants |
//! | `blocked_is_the_reason_a_message_would_not_be_delivered` | every `blocked` value (`hosted_off` on the default server, `connection`, `paused`, `attest`, `members`, `apps`) and `null`, one at a time, and **for each, an owner mention in a shared channel is delivered exactly when `blocked` is `null`** | a stage is dropped or reordered in `blocked`; the candidate loader and the route drift apart |
//! | `an_agent_bearer_is_refused_by_the_middleware` | hosted-class and generic agent bearers get 403 on the route (layer one with a real credential); no credential is 401 | the path enters `required_agent_scope` |
//!
//! `#[ignore]` — needs a real PostgreSQL 18 + pgvector (superuser URL); run on an isolated database:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test app_runtimes_conformance_pg -- --ignored --test-threads=1
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

fn runtimes_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/me/app-runtimes")
}

async fn runtimes(
    client: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    jwt: &str,
) -> (u16, Value) {
    let response = client
        .get(runtimes_url(base, workspace))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("GET app-runtimes");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn entry(answer: &Value, agent: Uuid) -> Option<&Value> {
    answer
        .as_array()
        .expect("the answer is a bare array")
        .iter()
        .find(|entry| entry["agentId"] == json!(agent.to_string()))
}

// ---------------------------------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn only_my_app_runtimes_are_listed_and_never_anyone_elses() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = seed_workspace(&su).await;
    let (me, me_jwt) = seed_human(&su, workspace, "member", "이도현").await;
    let (other, other_jwt) = seed_human(&su, workspace, "member", "박서연").await;
    let room = seed_channel(&su, workspace, "public", &[me, other]).await;

    // Mine: a hosted vendor agent, the co-hosted trial, and three that are not app runtimes in v1.
    let my_hosted = seed_hosted_agent(&su, workspace, me, "mine", &[room], true, false).await;
    let my_trial = seed_cohosted_agent(&su, workspace, me, "trial").await;
    let my_personal = seed_subscription_agent(&su, workspace, me, "personal", true).await;
    let my_harness = seed_subscription_agent(&su, workspace, me, "harness", false).await;
    let my_managed = seed_managed_agent(&su, workspace, me, "managed").await;
    // Theirs, **all marked**, so that only the owner predicate keeps them out of my answer.
    let their_hosted =
        seed_hosted_agent(&su, workspace, other, "theirs", &[room], true, false).await;
    let their_paused =
        seed_hosted_agent(&su, workspace, other, "stopped", &[room], true, true).await;
    let their_harness = seed_subscription_agent(&su, workspace, other, "theirsub", false).await;
    for (agent, owner) in [
        (my_hosted.id, me),
        (my_trial.id, me),
        (my_personal.id, me),
        (my_harness.id, me),
        (my_managed.id, me),
        (their_hosted.id, other),
        (their_paused.id, other),
        (their_harness.id, other),
    ] {
        mark_connector_owner(&su, workspace, agent, owner).await;
    }
    // Installs and grants: gmail is mine, calendar and github are theirs.
    for app in [GMAIL, CALENDAR, GITHUB] {
        install_app(&su, workspace, app, me, true).await;
    }
    grant_app(&su, workspace, me, GMAIL).await;
    grant_app(&su, workspace, other, CALENDAR).await;
    grant_app(&su, workspace, other, GITHUB).await;

    // The operator switched on gmail, calendar and github in Hermes.
    let base = start_server(
        momo_app_pool().await,
        ServerOptions::hosted_open().attested(&[GMAIL, CALENDAR, GITHUB]),
    )
    .await;
    let client = reqwest::Client::new();

    let (status, answer) = runtimes(&client, &base, workspace, &me_jwt).await;
    assert_eq!(status, 200, "{answer}");
    let found: Vec<String> = answer
        .as_array()
        .expect("bare array")
        .iter()
        .map(|entry| entry["agentId"].as_str().expect("agentId").to_string())
        .collect();
    assert_eq!(
        found.len(),
        2,
        "only my hosted vendor agent and my trial: {answer}"
    );
    assert_eq!(
        entry(&answer, my_hosted.id).expect("my hosted agent"),
        &json!({
            "agentId": my_hosted.id.to_string(),
            "path": "hosted_vendor",
            "apps": [GMAIL],
            "enforced": false,
            "blocked": null
        })
    );
    // The trial is stopped (two people in the workspace) — and still listed, with its reason. The
    // operator's list (gmail, calendar, github) is cut down to my grants: gmail.
    assert_eq!(
        entry(&answer, my_trial.id).expect("my trial"),
        &json!({
            "agentId": my_trial.id.to_string(),
            "path": "hermes_trial",
            "apps": [GMAIL],
            "enforced": true,
            "blocked": "members"
        })
    );
    for absent in [&my_personal, &my_harness, &my_managed] {
        assert!(entry(&answer, absent.id).is_none(), "{}", absent.handle);
    }

    // Nothing of the other member is on my wire: not their agents, not their member id, not their grants.
    let wire = answer.to_string();
    for secret in [
        their_hosted.id.to_string(),
        their_paused.id.to_string(),
        their_harness.id.to_string(),
        other.to_string(),
        their_hosted.handle.clone(),
        CALENDAR.to_string(),
        GITHUB.to_string(),
    ] {
        assert!(!wire.contains(&secret), "{secret} leaked into: {wire}");
    }

    // The other member's own answer is exactly theirs, and mine is not in it.
    let (status, theirs) = runtimes(&client, &base, workspace, &other_jwt).await;
    assert_eq!(status, 200, "{theirs}");
    let theirs_ids: Vec<&str> = theirs
        .as_array()
        .expect("bare array")
        .iter()
        .map(|entry| entry["agentId"].as_str().expect("agentId"))
        .collect();
    assert_eq!(theirs_ids.len(), 2, "{theirs}");
    assert_eq!(
        entry(&theirs, their_hosted.id).expect("their hosted agent")["apps"],
        json!([GITHUB, CALENDAR]),
        "their own grants, in plugin-id order"
    );
    assert_eq!(
        entry(&theirs, their_paused.id).expect("their paused agent")["blocked"],
        json!("paused"),
        "a stopped agent stays in its owner's list with the reason"
    );
    assert!(!theirs.to_string().contains(&my_hosted.id.to_string()));
    assert!(!theirs.to_string().contains(&me.to_string()));
}

// ---------------------------------------------------------------------------------------------------
// blocked — and the real delivery it predicts
// ---------------------------------------------------------------------------------------------------

/// One row of the table: the world, the server, and what F8 must say.
struct Scenario {
    label: &'static str,
    options: ServerOptions,
    expect: Option<&'static str>,
}

/// The shape of the agent in a scenario.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    HostedConnected,
    HostedNotConnected,
    HostedConnectedPaused,
    HostedNotConnectedPaused,
    Trial,
    TrialPaused,
    TrialTwoPeople,
    TrialGrantRevoked,
}

/// Seed the scenario's workspace (one person, `me`), run F8 and a real owner mention, and compare.
async fn run(su: &PgPool, scenario: &Scenario, shape: Shape, grant_gmail: bool) {
    let workspace = seed_workspace(su).await;
    let (me, me_jwt) = seed_human(su, workspace, "member", "이도현").await;
    let room = seed_channel(su, workspace, "public", &[me]).await;
    let (agent, path) = match shape {
        Shape::HostedConnected | Shape::HostedConnectedPaused => (
            seed_hosted_agent(
                su,
                workspace,
                me,
                "hosted",
                &[room],
                true,
                shape == Shape::HostedConnectedPaused,
            )
            .await,
            "hosted_vendor",
        ),
        Shape::HostedNotConnected | Shape::HostedNotConnectedPaused => (
            seed_hosted_agent(
                su,
                workspace,
                me,
                "hosted",
                &[room],
                false,
                shape == Shape::HostedNotConnectedPaused,
            )
            .await,
            "hosted_vendor",
        ),
        Shape::Trial | Shape::TrialPaused | Shape::TrialTwoPeople | Shape::TrialGrantRevoked => (
            seed_cohosted_agent(su, workspace, me, "trial").await,
            "hermes_trial",
        ),
    };
    if matches!(shape, Shape::TrialPaused) {
        sqlx::query(
            "UPDATE agent_profile SET paused = true WHERE workspace_id=$1 AND agent_member_id=$2",
        )
        .bind(workspace)
        .bind(agent.id)
        .execute(su)
        .await
        .expect("pause");
    }
    join_channel(su, workspace, room, agent.id).await;
    mark_connector_owner(su, workspace, agent.id, me).await;
    install_app(su, workspace, GMAIL, me, true).await;
    if grant_gmail {
        grant_app(su, workspace, me, GMAIL).await;
    }
    if shape == Shape::TrialTwoPeople {
        let _ = seed_human(su, workspace, "member", "박서연").await;
    }
    if shape == Shape::TrialGrantRevoked {
        revoke_grant(su, workspace, me, GMAIL).await;
    }

    let base = start_server(momo_app_pool().await, scenario.options.clone()).await;
    let client = reqwest::Client::new();
    let (status, answer) = runtimes(&client, &base, workspace, &me_jwt).await;
    assert_eq!(status, 200, "{}: {answer}", scenario.label);
    let mine = entry(&answer, agent.id)
        .unwrap_or_else(|| panic!("{}: the agent is an app runtime: {answer}", scenario.label));
    assert_eq!(mine["path"], json!(path), "{}", scenario.label);
    assert_eq!(
        mine["blocked"],
        scenario.expect.map_or(Value::Null, |reason| json!(reason)),
        "{}: {answer}",
        scenario.label
    );

    // The prediction is true: an owner mention in the shared channel becomes a job exactly when F8
    // said `null`. (The hosted agent's connection is approved for the room, so the per-channel stage
    // F8 leaves out cannot be what refuses it.)
    let jobs_before = jobs_for(su, workspace, agent.id).await;
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{room}/messages"
        ))
        .bearer_auth(&me_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{} 메일 확인해 줘요", agent.handle)
        }))
        .send()
        .await
        .expect("mention");
    assert_eq!(response.status().as_u16(), 201, "{}", scenario.label);
    let delivered = jobs_for(su, workspace, agent.id).await - jobs_before;
    assert_eq!(
        delivered,
        i64::from(scenario.expect.is_none()),
        "{}: F8 said blocked={:?}; the real delivery queued {delivered} job(s)",
        scenario.label,
        scenario.expect
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn blocked_is_the_reason_a_message_would_not_be_delivered() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let open = || ServerOptions::hosted_open();
    let attested = || ServerOptions::hosted_open().attested(&[GMAIL]);
    let default_server = || ServerOptions::default();

    let table: Vec<(Scenario, Shape, bool)> = vec![
        // hosted vendor: hosted_off → connection → paused.
        (
            Scenario {
                label: "hosted, connected, switch on",
                options: open(),
                expect: None,
            },
            Shape::HostedConnected,
            true,
        ),
        (
            Scenario {
                label: "hosted, connected, DEFAULT server (switch off)",
                options: default_server(),
                expect: Some("hosted_off"),
            },
            Shape::HostedConnected,
            true,
        ),
        (
            Scenario {
                label: "hosted, no active connection",
                options: open(),
                expect: Some("connection"),
            },
            Shape::HostedNotConnected,
            true,
        ),
        (
            Scenario {
                label: "hosted, paused",
                options: open(),
                expect: Some("paused"),
            },
            Shape::HostedConnectedPaused,
            true,
        ),
        (
            Scenario {
                label: "hosted, switch off outranks no connection and pause",
                options: default_server(),
                expect: Some("hosted_off"),
            },
            Shape::HostedNotConnectedPaused,
            true,
        ),
        (
            Scenario {
                label: "hosted, no connection outranks pause",
                options: open(),
                expect: Some("connection"),
            },
            Shape::HostedNotConnectedPaused,
            true,
        ),
        // the co-hosted trial: attest → members → apps, then paused. The hosted switch is not its business.
        (
            Scenario {
                label: "trial, attested, one person, granted",
                options: attested(),
                expect: None,
            },
            Shape::Trial,
            true,
        ),
        (
            Scenario {
                label: "trial on the DEFAULT server (switch off) is not hosted_off",
                options: ServerOptions::default().attested(&[GMAIL]),
                expect: None,
            },
            Shape::Trial,
            true,
        ),
        (
            Scenario {
                label: "trial, nothing attested",
                options: open(),
                expect: Some("attest"),
            },
            Shape::Trial,
            true,
        ),
        (
            Scenario {
                label: "trial, two people",
                options: attested(),
                expect: Some("members"),
            },
            Shape::TrialTwoPeople,
            true,
        ),
        (
            Scenario {
                label: "trial, the grant is gone",
                options: attested(),
                expect: Some("apps"),
            },
            Shape::TrialGrantRevoked,
            true,
        ),
        (
            Scenario {
                label: "trial, paused",
                options: attested(),
                expect: Some("paused"),
            },
            Shape::TrialPaused,
            true,
        ),
        (
            Scenario {
                label: "trial, never granted",
                options: attested(),
                expect: Some("apps"),
            },
            Shape::Trial,
            false,
        ),
    ];
    for (scenario, shape, grant) in &table {
        run(&su, scenario, *shape, *grant).await;
    }
}

// ---------------------------------------------------------------------------------------------------
// the middleware
// ---------------------------------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4313)"]
async fn an_agent_bearer_is_refused_by_the_middleware() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = seed_workspace(&su).await;
    let (me, me_jwt) = seed_human(&su, workspace, "member", "이도현").await;
    let room = seed_channel(&su, workspace, "public", &[me]).await;
    let hosted = seed_hosted_agent(&su, workspace, me, "hosted", &[room], true, false).await;
    let generic = seed_managed_agent(&su, workspace, me, "bot").await;
    let generic_bearer = seed_generic_agent_bearer(&su, workspace, generic.id).await;
    let base = start_server(momo_app_pool().await, ServerOptions::hosted_open()).await;
    let client = reqwest::Client::new();

    // Control: the person is served.
    let (status, _) = runtimes(&client, &base, workspace, &me_jwt).await;
    assert_eq!(status, 200);
    // Layer one with a real credential: an agent bearer of either class never reaches the handler.
    for (label, bearer) in [
        (
            "hosted-class agent bearer",
            hosted.bearer.clone().expect("hosted bearer"),
        ),
        ("generic agent bearer", generic_bearer),
    ] {
        let (status, body) = runtimes(&client, &base, workspace, &bearer).await;
        assert_eq!(status, 403, "{label}: {body}");
    }
    // No credential at all.
    let response = client
        .get(runtimes_url(&base, workspace))
        .send()
        .await
        .expect("GET without a credential");
    assert_eq!(response.status().as_u16(), 401);
}
