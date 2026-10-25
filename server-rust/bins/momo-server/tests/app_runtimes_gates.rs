//! #4313 / ADR-0113 증보 3 F8 — `GET /v1/workspaces/{ws}/members/me/app-runtimes`: the gates that
//! need **no database**.
//!
//! Everything asserted here is decided before the first statement, so the pool is a `connect_lazy`
//! handle that never dials (the precedent is `dm_closure_gates.rs`). That is also why this file runs in
//! plain `cargo test --workspace`, where the `#[ignore]`d PG suite (`app_runtimes_conformance_pg.rs`)
//! does not: the two agent layers cannot be skipped by a missing database.
//!
//! The control that keeps these honest is [`a_valid_human_request_reaches_the_database`]: the same
//! handler, a human principal and the right workspace must go on to the (dead) pool and fail there with
//! a 500. Without it a refusal here could be the pool refusing, not the gate.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `layer_one_*` | the agent table has no row for the path (HTTP proof with a real bearer: the PG suite) | add `…/members/me/app-runtimes` to `required_agent_scope` |
//! | `layer_two_*` | the handler's own `require_human`, with **no middleware in front** | delete `require_human(..)` from `list` |
//! | `the_path_is_scoped_to_the_credentials_workspace` | `workspace_scope`, before any read | read the `{ws}` path parameter instead of the credential's |
//! | the control | the dead pool really is hit by a valid request | (it fails if the 403s above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::get;
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0001);
const OTHER_WORKSPACE: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0009);
const MEMBER: Uuid = Uuid::from_u128(0x4313_0000_0000_4000_8000_0000_0000_0003);

/// A pool that never connects. `acquire_timeout` is shortened from sqlx's 30 s default so the control
/// test (which *does* reach the pool) fails in a fraction of a second.
fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "app-runtimes-gates-signing-secret".to_string(),
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

/// The handler mounted at the path `build_app` mounts it on, but with **no auth middleware**: the
/// principal is injected, so what answers is the handler and nothing in front of it.
async fn handler_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/members/me/app-runtimes",
            get(routes::app_runtimes::list),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    serve(app).await
}

fn runtimes_url(base: &str, workspace: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/me/app-runtimes")
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

// ---------------------------------------------------------------------------
// layer one — the route-shape gate: the agent table has no row for this path
// ---------------------------------------------------------------------------

/// The middleware classifies an agent bearer with a SELECT *before* it consults
/// `required_agent_scope`, so the HTTP-level proof (a real agent bearer carrying every scope still
/// gets the generic 403) needs a database and lives in `app_runtimes_conformance_pg.rs`. What needs
/// none is the table itself: the path as this binary mounts it has no row, for any verb, and a sibling
/// route with a `members/me`-shaped path does not either — so the `None` is the table's answer and not a
/// matcher that stopped reading paths (the control is an open route of the same family).
#[test]
fn layer_one_the_agent_table_has_no_row_for_the_app_runtimes_route() {
    let path = format!("/v1/workspaces/{WORKSPACE}/members/me/app-runtimes");
    for method in ["GET", "PUT", "POST", "DELETE", "PATCH"] {
        assert_eq!(
            momo_auth::required_agent_scope(method, &path),
            None,
            "{method} {path} must stay out of the agent allowlist"
        );
    }
    assert_eq!(
        momo_auth::required_agent_scope(
            "POST",
            &format!(
                "/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/messages",
                CHANNEL = Uuid::nil()
            )
        ),
        Some(momo_auth::SCOPE_MESSAGES_WRITE),
        "control: an open route still resolves, so the None above is the table's answer"
    );
}

// ---------------------------------------------------------------------------
// layer two — `require_human` inside the handler, no middleware in front
// ---------------------------------------------------------------------------

#[tokio::test]
async fn layer_two_the_handler_refuses_a_non_human_principal_before_anything_else() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let base = handler_only(principal(kind)).await;
        let (status, message) = message_of(
            http.get(runtimes_url(&base, &WORKSPACE.to_string()))
                .send()
                .await
                .expect("GET"),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind:?}");
        assert_eq!(message, "app runtimes require a human bearer", "{kind:?}");
    }
}

#[tokio::test]
async fn the_path_is_scoped_to_the_credentials_workspace() {
    let http = Client::new();
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let (status, message) = message_of(
        http.get(runtimes_url(&base, &OTHER_WORKSPACE.to_string()))
            .send()
            .await
            .expect("GET"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(message, "workspace scope mismatch");
    let (status, _) = message_of(
        http.get(runtimes_url(&base, "not-a-uuid"))
            .send()
            .await
            .expect("GET"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// The control: a human, in their own workspace, passes both gates and goes on to the database — which
/// is dead — so the answer is the opaque 500. If this were a 403 the two tests above would prove nothing.
#[tokio::test]
async fn a_valid_human_request_reaches_the_database() {
    let http = Client::new();
    let base = handler_only(principal(PrincipalKind::Human)).await;
    let (status, _) = message_of(
        http.get(runtimes_url(&base, &WORKSPACE.to_string()))
            .send()
            .await
            .expect("GET"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "a valid request must get past the gates and fail at the dead pool"
    );
}
