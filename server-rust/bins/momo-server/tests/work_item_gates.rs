//! #6066 (ADR-0222 원장-1) — the work-item routes' gates that need **no database**.
//!
//! Everything asserted here is decided before the first statement, so the pool is a
//! `connect_lazy` handle that never dials (the precedent is `dm_closure_gates.rs`). The control
//! [`control_a_valid_human_create_reaches_the_database`] keeps the refusals honest: the same handler
//! with a human principal and a valid body goes on to the dead pool and fails there with a 500.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `layer_two_*` | each handler's own `require_human`, with no middleware in front, before the body is read | delete `require_human(..)` from any handler |
//! | `a_create_body_that_names_a_person_*` | the closed create body: naming requester, on-behalf-of, assignee or an actor is 400 before any connection | drop `deny_unknown_fields` from `CreateWorkItemRequest` |
//! | the control | the dead pool really is reached by a valid request | (fails if the refusals above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::{get, post, put};
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x6066_0000_0000_4000_8000_0000_0000_0001);
const CHANNEL: Uuid = Uuid::from_u128(0x6066_0000_0000_4000_8000_0000_0000_0002);
const MEMBER: Uuid = Uuid::from_u128(0x6066_0000_0000_4000_8000_0000_0000_0003);

fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "work-item-gates-signing-secret".to_string(),
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

/// The handlers mounted as `build_app` mounts them, with **no auth middleware**.
async fn handlers_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/work-items",
            post(routes::work_items::create).get(routes::work_items::list),
        )
        .route(
            "/v1/workspaces/{ws}/work-items/{number}",
            get(routes::work_items::get_one),
        )
        .route(
            "/v1/workspaces/{ws}/work-items/{number}/close",
            post(routes::work_items::close),
        )
        .route(
            "/v1/workspaces/{ws}/work-items/{number}/assignee",
            put(routes::work_items::set_assignee),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral port");
    let address: SocketAddr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}/v1/workspaces/{WORKSPACE}/work-items")
}

async fn answer(request: reqwest::RequestBuilder) -> (StatusCode, String) {
    let response = request.send().await.expect("request");
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (
        status,
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

#[tokio::test]
async fn layer_two_every_handler_refuses_a_non_human_principal_first() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let base = handlers_only(principal(kind)).await;
        // Bodies the human path would also refuse — the 403 must win, so require_human runs
        // before the body is read.
        let cases = [
            (
                Method::POST,
                base.clone(),
                json!({"requestedByMemberId": MEMBER}),
            ),
            (Method::GET, base.clone(), json!(null)),
            (Method::GET, format!("{base}/1"), json!(null)),
            (
                Method::POST,
                format!("{base}/1/close"),
                json!({"state": "reopen"}),
            ),
            (
                Method::PUT,
                format!("{base}/1/assignee"),
                json!({"memberId": "x"}),
            ),
        ];
        for (method, url, body) in cases {
            let mut request = http.request(method.clone(), &url);
            if !body.is_null() {
                request = request.json(&body);
            }
            let (status, message) = answer(request).await;
            assert_eq!(status, 403, "{kind:?} {method} {url}: {message}");
            assert_eq!(
                message, "work items require a signed-in person",
                "{kind:?} {method} {url}"
            );
        }
    }
}

#[tokio::test]
async fn a_create_body_that_names_a_person_is_a_400_before_any_connection() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let http = Client::new();
    for field in [
        "requestedByMemberId",
        "onBehalfOfMemberId",
        "assigneeMemberId",
        "createdByMemberId",
        "actorMemberId",
        "requested_by_member_id",
    ] {
        let mut body = json!({"title": "릴리스 노트", "homeChannelId": CHANNEL});
        body[field] = json!(Uuid::from_u128(9));
        let (status, message) = answer(http.post(&base).json(&body)).await;
        assert_eq!(status, 400, "{field}: {message}");
        assert_eq!(
            message, "body must be {title, homeChannelId} and nothing else",
            "{field}"
        );
    }
}

#[tokio::test]
async fn control_a_valid_human_create_reaches_the_database() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let (status, message) = answer(
        Client::new()
            .post(&base)
            .json(&json!({"title": "릴리스 노트", "homeChannelId": CHANNEL})),
    )
    .await;
    assert_eq!(status, 500, "the dead pool answers: {message}");
}
