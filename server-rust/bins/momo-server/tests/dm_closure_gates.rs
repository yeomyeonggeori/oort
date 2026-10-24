//! #4227 / ADR-0177 증보 D7 — the DM-closure route's gates that need **no database**.
//!
//! `PUT|DELETE /v1/workspaces/{ws}/channels/{ch}/closure`. Everything asserted here is decided
//! *before* the first statement, so the pool is a `connect_lazy` handle that never dials (the
//! precedent is `cors_allowlist.rs`). That is also why this file runs in plain `cargo test
//! --workspace`, where the `#[ignore]`d PG suite (`dm_closure_conformance_pg.rs`) does not: the two
//! agent layers and the 400 contract cannot be skipped by a missing database.
//!
//! The control that keeps these honest is [`a_valid_human_request_reaches_the_database`]: the same
//! handlers, a human principal and a valid body, must go on to the (dead) pool and fail there with a
//! 500. Without it a refusal here could be the pool refusing, not the gate.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `layer_one_*` | the agent table has no row for the path (HTTP proof with a real bearer: the PG suite) | add `…/closure` to the agent table |
//! | `layer_two_*` | the handler's own `require_human`, with **no middleware in front** | delete `require_human(..)` from `put` or `delete` |
//! | `a_bad_body_is_a_400_*` | every refusal of the body is 400 and costs no connection | map a `JsonRejection` to its own status, or drop the `seen_seq < 0` check |
//! | the control | the dead pool really is hit by a valid request | (it fails if the 400s above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::put;
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x4227_0000_0000_4000_8000_0000_0000_0001);
const CHANNEL: Uuid = Uuid::from_u128(0x4227_0000_0000_4000_8000_0000_0000_0002);
const MEMBER: Uuid = Uuid::from_u128(0x4227_0000_0000_4000_8000_0000_0000_0003);

/// A pool that never connects. `acquire_timeout` is shortened from sqlx's 30 s default so the
/// control test (which *does* reach the pool) fails in a fraction of a second.
fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "dm-closure-gates-signing-secret".to_string(),
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

/// The two handlers mounted exactly as `build_app` mounts them, but with **no auth middleware**: the
/// principal is injected, so what answers is the handler and nothing in front of it.
async fn handlers_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/closure",
            put(routes::dm_closure::put).delete(routes::dm_closure::delete),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    serve(app).await
}

fn closure_url(base: &str, workspace: &str, channel: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/closure")
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
/// gets the generic 403) needs a database and lives in `dm_closure_conformance_pg.rs`. What needs
/// none is the table itself: the path as this binary mounts it has no row, for any verb, and a
/// sibling route with the same shape does — so the `None` is the table's answer and not a matcher
/// that stopped reading paths.
#[test]
fn layer_one_the_agent_table_has_no_row_for_the_closure_route() {
    let path = format!("/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/closure");
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
            &format!("/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/messages")
        ),
        Some(momo_auth::SCOPE_MESSAGES_WRITE),
        "control: an open route of the same six-segment shape still resolves"
    );
}

// ---------------------------------------------------------------------------
// layer two — `require_human` inside the handler, no middleware in front
// ---------------------------------------------------------------------------

#[tokio::test]
async fn layer_two_the_handlers_refuse_a_non_human_principal_before_anything_else() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let base = handlers_only(principal(kind)).await;
        let url = closure_url(&base, &WORKSPACE.to_string(), &CHANNEL.to_string());

        // A body the human path would also refuse (negative) — the 403 must win, so `require_human`
        // runs before the body is read, not after.
        let (status, message) = message_of(
            http.put(&url)
                .json(&json!({"seenSeq": -5}))
                .send()
                .await
                .expect("PUT"),
        )
        .await;
        assert_eq!(status, 403, "{kind:?} PUT: {message}");
        assert_eq!(
            message, "dm closure requires a human bearer",
            "{kind:?} PUT"
        );

        let (status, message) = message_of(http.delete(&url).send().await.expect("DELETE")).await;
        assert_eq!(status, 403, "{kind:?} DELETE: {message}");
        assert_eq!(
            message, "dm closure requires a human bearer",
            "{kind:?} DELETE"
        );
    }
}

// ---------------------------------------------------------------------------
// the body is a 400 — before the transaction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_bad_body_is_a_400_and_costs_no_connection() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let http = Client::new();
    let url = closure_url(&base, &WORKSPACE.to_string(), &CHANNEL.to_string());

    // (label, content-type, raw body)
    let cases: [(&str, Option<&str>, &str); 14] = [
        ("missing seenSeq", Some("application/json"), "{}"),
        ("negative", Some("application/json"), r#"{"seenSeq": -1}"#),
        ("string", Some("application/json"), r#"{"seenSeq": "7"}"#),
        ("fraction", Some("application/json"), r#"{"seenSeq": 1.5}"#),
        ("null", Some("application/json"), r#"{"seenSeq": null}"#),
        (
            "snake_case spelling",
            Some("application/json"),
            r#"{"seen_seq": 7}"#,
        ),
        (
            "unknown key",
            Some("application/json"),
            r#"{"seenSeq": 3, "channelId": "x"}"#,
        ),
        (
            "past i64",
            Some("application/json"),
            r#"{"seenSeq": 9223372036854775808}"#,
        ),
        ("not json", Some("application/json"), "seenSeq=3"),
        (
            "top-level array read positionally",
            Some("application/json"),
            "[1]",
        ),
        ("empty array", Some("application/json"), "[]"),
        ("bare number", Some("application/json"), "7"),
        (
            "wrong content type",
            Some("text/plain"),
            r#"{"seenSeq": 3}"#,
        ),
        ("no body, no content type", None, ""),
    ];
    for (label, content_type, raw) in cases {
        let mut request = http.put(&url).body(raw.to_string());
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let (status, message) = message_of(request.send().await.expect("PUT")).await;
        assert_eq!(
            status, 400,
            "{label}: expected 400, got {status} ({message})"
        );
        assert_eq!(
            message, "seenSeq must be a non-negative integer",
            "{label}: one message for every refusal of the body"
        );
    }

    // The path is validated the same way: an id that is not a uuid is a 400 too.
    let bad_channel = closure_url(&base, &WORKSPACE.to_string(), "not-a-uuid");
    let (status, message) = message_of(
        http.put(&bad_channel)
            .json(&json!({"seenSeq": 1}))
            .send()
            .await
            .expect("PUT bad channel"),
    )
    .await;
    assert_eq!(status, 400, "{message}");
    assert_eq!(message, "invalid channel id");

    // And the workspace in the path must be the credential's: a human of another workspace is a 403.
    let other = closure_url(&base, &Uuid::from_u128(9).to_string(), &CHANNEL.to_string());
    let (status, _) = message_of(
        http.put(&other)
            .json(&json!({"seenSeq": 1}))
            .send()
            .await
            .expect("PUT other workspace"),
    )
    .await;
    assert_eq!(status, 403);
}

/// The control for everything above: with a valid body the handler goes on to the pool, which is
/// dead, so it answers 500. If this returned 400 the cases above would prove nothing about the
/// validation (it would mean the 400s came from somewhere else); a 204 would mean the dead pool is
/// not dead.
#[tokio::test]
async fn a_valid_human_request_reaches_the_database() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let http = Client::new();
    let url = closure_url(&base, &WORKSPACE.to_string(), &CHANNEL.to_string());

    for seen_seq in [0_i64, 7] {
        let (status, message) = message_of(
            http.put(&url)
                .json(&json!({"seenSeq": seen_seq}))
                .send()
                .await
                .expect("PUT"),
        )
        .await;
        assert_eq!(
            status, 500,
            "seenSeq={seen_seq}: a valid body must get as far as the pool ({message})"
        );
    }
    let (status, message) = message_of(http.delete(&url).send().await.expect("DELETE")).await;
    assert_eq!(status, 500, "DELETE reaches the pool too ({message})");
}
