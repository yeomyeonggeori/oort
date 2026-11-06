//! #4497 / ADR-0206 D4 — the activity heartbeat's gates that need **no database**.
//!
//! `PUT /v1/workspaces/{ws}/presence/activity`. Everything asserted here is decided *before* the
//! first statement, so the pool is a `connect_lazy` handle that never dials (the precedent is
//! `dm_closure_gates.rs`). That is also why this file runs in plain `cargo test --workspace`, where
//! the `#[ignore]`d PG suite (`presence_activity_conformance_pg.rs`) does not.
//!
//! The control that keeps these honest is [`a_valid_human_request_reaches_the_database`]: the same
//! handler with a human principal must go on to the (dead) pool and fail there with a 500. Without it
//! a refusal here could be the pool refusing, not the gate.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `layer_one_*` | the agent table has no row for the path (the HTTP proof with a real bearer is the PG suite's) | add `…/presence/activity` to the agent table |
//! | `layer_two_*` | the handler's own `require_human`, with **no middleware in front** | delete `require_human(..)` from `touch` |
//! | `a_foreign_workspace_path_is_refused_before_the_database` | the path's workspace must be the credential's | delete `workspace_scope(..)` |
//! | the control | the dead pool really is hit by a valid request | (it fails if the 403s above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::put;
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x4497_0000_0000_4000_8000_0000_0000_0001);
const OTHER_WORKSPACE: Uuid = Uuid::from_u128(0x4497_0000_0000_4000_8000_0000_0000_0002);
const MEMBER: Uuid = Uuid::from_u128(0x4497_0000_0000_4000_8000_0000_0000_0003);

/// A pool that never connects. `acquire_timeout` is shortened from sqlx's 30 s default so the
/// control test (which *does* reach the pool) fails in a fraction of a second.
fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "presence-activity-gates-signing-secret".to_string(),
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

async fn serve(app: Router) -> String {
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

/// The handler mounted exactly as `build_app` mounts it, but with **no auth middleware**: the
/// principal is injected, so what answers is the handler and nothing in front of it.
async fn handler_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/presence/activity",
            put(routes::presence_activity::touch),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    serve(app).await
}

fn activity_url(base: &str, workspace: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/presence/activity")
}

async fn message_of(response: reqwest::Response) -> (StatusCode, String) {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (status, message)
}

/// The middleware classifies an agent bearer before it consults `required_agent_scope`, so the
/// HTTP-level proof with a real agent bearer needs a database and lives in the PG suite. What needs
/// none is the table itself: the path as this binary mounts it has no row, for any verb, and a
/// sibling with the same shape does, so the `None` is the table's answer and not a matcher that
/// stopped reading paths.
#[test]
fn layer_one_the_agent_table_has_no_row_for_the_activity_route() {
    let path = format!("/v1/workspaces/{WORKSPACE}/presence/activity");
    for method in ["PUT", "DELETE", "POST", "GET", "PATCH"] {
        assert_eq!(
            momo_auth::required_agent_scope(method, &path),
            None,
            "{method} {path} must stay out of the agent allowlist"
        );
    }
    assert_eq!(
        momo_auth::required_agent_scope(
            "POST",
            &format!("/v1/workspaces/{WORKSPACE}/channels/{MEMBER}/messages")
        ),
        Some(momo_auth::SCOPE_MESSAGES_WRITE),
        "control: an open sibling route still resolves"
    );
}

/// The handler's own second layer, with nothing in front of it: an agent and a signed work host are
/// refused before the first statement (a dead pool would answer 500, so a 403 is the gate's).
#[tokio::test]
async fn layer_two_the_handler_refuses_a_non_human_principal_before_anything_else() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let base = handler_only(principal(kind)).await;
        let (status, message) = message_of(
            http.put(activity_url(&base, &WORKSPACE.to_string()))
                .send()
                .await
                .expect("PUT"),
        )
        .await;
        assert_eq!(status, 403, "{kind:?}: {message}");
        assert!(
            message.contains("human bearer"),
            "{kind:?} is refused for not being a person: {message}"
        );
    }
}

/// The path's `{ws}` must be the credential's workspace, and the refusal comes before any database
/// work (the dead pool would say 500).
#[tokio::test]
async fn a_foreign_workspace_path_is_refused_before_the_database() {
    let http = Client::new();
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let (status, message) = message_of(
        http.put(activity_url(&base, &OTHER_WORKSPACE.to_string()))
            .send()
            .await
            .expect("PUT"),
    )
    .await;
    assert_eq!(status, 403, "{message}");
    assert!(message.contains("workspace"), "{message}");

    let (status, message) = message_of(
        http.put(activity_url(&base, "not-a-uuid"))
            .send()
            .await
            .expect("PUT"),
    )
    .await;
    assert_eq!(status, 400, "{message}");
}

/// The control: a person asking for their own workspace gets past every gate and reaches the pool,
/// which is dead, so the answer is a 500. Without this the 403s above could be the pool refusing.
#[tokio::test]
async fn a_valid_human_request_reaches_the_database() {
    let http = Client::new();
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let (status, message) = message_of(
        http.put(activity_url(&base, &WORKSPACE.to_string()))
            .send()
            .await
            .expect("PUT"),
    )
    .await;
    assert_eq!(
        status, 500,
        "a valid request goes on to the (dead) pool and fails there ({message})"
    );
}
