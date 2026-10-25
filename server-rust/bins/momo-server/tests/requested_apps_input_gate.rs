//! #4313 / ADR-0113 증보 3 F5 (review r1 H1, r2 L-r2-2) — the bound on the `apps` list **as received**,
//! at the REST send handler, with **no database**.
//!
//! The guard (`within_input_limit`) runs before the list is normalised and before any connection is
//! taken, so its answer needs no database: the pool here is a `connect_lazy` handle that never dials
//! (the precedent is `app_runtimes_gates.rs`). That is also why this file runs in plain
//! `cargo test --workspace` - the PR's non-ignored lane - where the `#[ignore]`d PG suite
//! (`requested_apps_conformance_pg.rs`) does not: deleting the *call* of the guard from the handler
//! (the unit test pins only the function) turns this file red instead of passing silently.
//!
//! The control that keeps these honest is [`a_list_within_the_bound_goes_on_to_the_database`]: the same
//! handler with a list at the bound must go on to the (dead) pool and fail there with a 500. Without it a
//! 400 here could be anything but the guard.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `a_list_over_the_bound_is_refused_before_the_database` | 17 entries (all one app), 50,000 distinct entries, an agent author: the one coded 400 `apps_unavailable`, no pool needed | delete the `within_input_limit(..)` call from `send`; compare the distinct count instead of the raw length |
//! | `the_refusal_names_nothing` | the 400 body is the same sentence whatever was sent, with no id in it | a refusal that echoes what it saw |
//! | `a_list_within_the_bound_goes_on_to_the_database` | 16 entries over three apps, and no `apps` at all, reach the dead pool (500) | (the control: it fails if the 400s above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::post;
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0011);
const CHANNEL: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0012);
const MEMBER: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0013);
const GMAIL: &str = "com.momo.plugins.gmail";
const GITHUB: &str = "com.momo.plugins.github";
const LINEAR: &str = "com.momo.plugins.linear";

/// A pool that never connects. `acquire_timeout` is shortened from sqlx's 30 s default so the control
/// test (which *does* reach the pool) fails in a fraction of a second.
fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "requested-apps-input-gate-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
}

fn principal(kind: PrincipalKind) -> Principal {
    Principal {
        kind,
        member_id: MEMBER,
        workspace_id: WORKSPACE,
        token_id: None,
        scopes: vec!["messages:write".to_string()],
    }
}

/// The send handler mounted at the path `build_app` mounts it on, with **no auth middleware**: the
/// principal is injected, so what answers is the handler and nothing in front of it.
async fn handler_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/messages",
            post(routes::messages::send),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral port");
    let address: SocketAddr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

async fn send(base: &str, apps: Option<Value>) -> (StatusCode, Value) {
    let mut body = json!({
        "clientMsgId": Uuid::new_v4(),
        "type": "text",
        "body": "메일 확인해 줘요",
    });
    if let Some(apps) = apps {
        body["apps"] = apps;
    }
    let response = Client::new()
        .post(format!(
            "{base}/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/messages"
        ))
        .json(&body)
        .send()
        .await
        .expect("POST the message");
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn is_the_apps_refusal(status: StatusCode, body: &Value) -> bool {
    status == StatusCode::BAD_REQUEST && body["error"]["code"] == "apps_unavailable"
}

#[tokio::test]
async fn a_list_over_the_bound_is_refused_before_the_database() {
    let over = momo_agent::MAX_REQUESTED_APPS_INPUT + 1;
    for (label, kind, apps) in [
        (
            "one past the bound, all one app",
            PrincipalKind::Human,
            json!(vec![GMAIL; over]),
        ),
        (
            "tens of thousands of distinct ids",
            PrincipalKind::Human,
            json!((0..50_000)
                .map(|index| format!("com.momo.plugins.p{index}"))
                .collect::<Vec<_>>()),
        ),
        (
            "an agent author gets the same answer",
            PrincipalKind::Agent,
            json!(vec![GMAIL; over]),
        ),
    ] {
        let base = handler_only(principal(kind)).await;
        let (status, body) = send(&base, Some(apps)).await;
        assert!(
            is_the_apps_refusal(status, &body),
            "{label}: expected the coded 400, got {status} {body}"
        );
    }
}

#[tokio::test]
async fn the_refusal_names_nothing() {
    let over = momo_agent::MAX_REQUESTED_APPS_INPUT + 1;
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let mut messages: Vec<String> = Vec::new();
    for apps in [
        json!(vec![GMAIL; over]),
        json!(vec![GITHUB; over + 100]),
        json!((0..over)
            .map(|index| format!("com.momo.plugins.p{index}"))
            .collect::<Vec<_>>()),
    ] {
        let (status, body) = send(&base, Some(apps)).await;
        assert!(is_the_apps_refusal(status, &body), "{status} {body}");
        let message = body["error"]["message"]
            .as_str()
            .expect("a message")
            .to_string();
        assert!(!message.contains("com.momo"), "{message}");
        assert!(!message.contains("routing"), "{message}");
        messages.push(message);
    }
    assert!(
        messages.windows(2).all(|pair| pair[0] == pair[1]),
        "one sentence whatever was sent: {messages:?}"
    );
}

/// The control: at the bound (and with no `apps`) the very same handler goes on to the database, which
/// here is a dead pool, so the answer is a 500 - not the apps refusal.
#[tokio::test]
async fn a_list_within_the_bound_goes_on_to_the_database() {
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let at_the_bound: Vec<&str> = (0..momo_agent::MAX_REQUESTED_APPS_INPUT)
        .map(|index| [GMAIL, GITHUB, LINEAR][index % 3])
        .collect();
    for (label, apps) in [
        ("sixteen entries over three apps", Some(json!(at_the_bound))),
        ("a single app", Some(json!([GMAIL]))),
        ("no apps at all", None),
    ] {
        let (status, body) = send(&base, apps).await;
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{label}: it must reach the (dead) pool, not be refused at the door: {body}"
        );
        assert!(!is_the_apps_refusal(status, &body), "{label}: {body}");
    }
}
