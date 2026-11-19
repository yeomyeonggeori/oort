//! #5822 / ADR-0177 증보 2026-11-14 D16 — the two human-only layers of `PUT …/dm-leave`, each on its
//! own (수용 6 「두 층 따로」), with no database.
//!
//! * Layer one: the agent route table has no row for the path, for any verb (the HTTP proof with a
//!   real agent bearer is `dm_leave_conformance_pg.rs` `leave_answers_by_scope`).
//! * Layer two: the handler refuses a non-human principal **before** the body is read or a
//!   connection is taken — mounted with no middleware in front and a pool that never dials.

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::put;
use axum::{Extension, Router};
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::Client;
use serde_json::{json, Value};
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x5822_0000_0000_4000_8000_0000_0000_0001);
const CHANNEL: Uuid = Uuid::from_u128(0x5822_0000_0000_4000_8000_0000_0000_0002);
const MEMBER: Uuid = Uuid::from_u128(0x5822_0000_0000_4000_8000_0000_0000_0003);

fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "dm-leave-gates-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
}

async fn handler_only(kind: PrincipalKind) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/dm-leave",
            put(routes::dm_leave::put),
        )
        .layer(Extension(Principal {
            kind,
            member_id: MEMBER,
            workspace_id: WORKSPACE,
            token_id: None,
            scopes: vec!["messages:write".to_string()],
        }))
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
    format!("http://{address}/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/dm-leave")
}

#[test]
fn layer_one_the_agent_table_has_no_row_for_the_leave_route() {
    let path = format!("/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/dm-leave");
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
        "control: an open route of the same shape still resolves"
    );
}

#[tokio::test]
async fn layer_two_the_handler_refuses_a_non_human_principal_before_anything_else() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let url = handler_only(kind).await;
        // A body the human path would refuse too (negative): the 403 must win.
        let response = http
            .put(&url)
            .json(&json!({ "seenSeq": -5 }))
            .send()
            .await
            .expect("PUT");
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        assert_eq!(status, 403, "{kind:?}: {body}");
        assert_eq!(
            body["error"]["message"],
            json!("dm leave requires a human bearer"),
            "{kind:?}"
        );
    }
    // Control: a human principal passes both gates and reaches the (dead) pool — a 500 here, not a
    // 403, proves the refusal above is the principal's and not the route's.
    let url = handler_only(PrincipalKind::Human).await;
    let response = http
        .put(&url)
        .json(&json!({ "seenSeq": 0 }))
        .send()
        .await
        .expect("PUT");
    assert_eq!(
        response.status().as_u16(),
        500,
        "the human request reaches the database"
    );
}
