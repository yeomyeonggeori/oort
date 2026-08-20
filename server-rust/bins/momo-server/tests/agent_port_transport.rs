//! ADR-0162 / HAP-E2 transport guards that need neither Postgres nor Docker.
//!
//! These tests exercise the real Axum router over a socket. A lazy pool points
//! at an unreachable address on purpose: every case must fail before database
//! authentication, which makes an accidental DB touch visible as a timeout or
//! 500 rather than a false green.

use std::net::SocketAddr;
use std::time::Duration;

use momo_server::config::AgentPortConfig;
use momo_server::{build_app, AppState};

const ALLOWED_ORIGIN: &str = "https://app.oor7.com";

async fn serve() -> String {
    serve_with_ip_limit(0).await
}

async fn serve_with_ip_limit(per_ip_limit: u32) -> String {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(100))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool does not connect");
    let state = AppState::new(
        pool,
        "agent-port-transport-test-signing-key".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        external_origin: Some(ALLOWED_ORIGIN.to_string()),
        per_ip_limit,
        ..AgentPortConfig::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind Agent Port test server");
    let address: SocketAddr = listener.local_addr().expect("test server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

#[tokio::test]
async fn only_post_exists_and_no_session_transport_is_opened() {
    let base = serve().await;
    let client = reqwest::Client::new();
    for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
        let response = client
            .request(method.clone(), format!("{base}/v1/mcp/agent-port"))
            .send()
            .await
            .expect("method receives a response");
        assert_eq!(response.status(), 405, "{method} must remain closed");
        assert_eq!(header(&response, "mcp-session-id"), None);
    }
}

#[tokio::test]
async fn missing_or_wrong_credential_class_gets_a_bounded_bearer_challenge() {
    let base = serve().await;
    let client = reqwest::Client::new();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}"#;

    let missing = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(body)
        .send()
        .await
        .expect("missing-auth request responds");
    assert_eq!(missing.status(), 401);
    assert_eq!(
        header(&missing, "www-authenticate").as_deref(),
        Some("Bearer scope=\"agent:port:connect\"")
    );
    assert_eq!(missing.bytes().await.expect("empty body").len(), 0);

    // A syntactically plausible App JWT must never be tried as a fallback.
    let human = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .bearer_auth("eyJhbGciOiJIUzI1NiJ9.e30.signature")
        .body(body)
        .send()
        .await
        .expect("wrong credential class responds");
    assert_eq!(human.status(), 401);
    assert_eq!(
        header(&human, "www-authenticate").as_deref(),
        Some("Bearer error=\"invalid_token\", scope=\"agent:port:connect\"")
    );

    // Even an oversized body is not an unauthenticated protocol oracle. It is
    // bounded in memory first, then the missing credential wins with the same
    // empty challenge; an authenticated fixture covers the eventual 413.
    let oversized = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(vec![b'x'; momo_mcp::MAX_BODY_BYTES + 1])
        .send()
        .await
        .expect("oversized unauthenticated request responds");
    assert_eq!(oversized.status(), 401);
    assert_eq!(
        header(&oversized, "www-authenticate").as_deref(),
        Some("Bearer scope=\"agent:port:connect\"")
    );
}

#[tokio::test]
async fn hostile_or_ambiguous_origin_fails_before_auth_without_a_challenge() {
    let base = serve().await;
    let client = reqwest::Client::new();
    for origin in ["https://evil.example", "null", "http://app.oor7.com"] {
        let response = client
            .post(format!("{base}/v1/mcp/agent-port"))
            .header("origin", origin)
            .send()
            .await
            .expect("origin denial responds");
        assert_eq!(response.status(), 403, "{origin}");
        assert_eq!(header(&response, "www-authenticate"), None);
    }

    // Forwarding headers never become the trusted comparison value.
    let spoofed = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("origin", "https://evil.example")
        .header("host", "app.oor7.com")
        .header("forwarded", "host=app.oor7.com;proto=https")
        .header("x-forwarded-host", "app.oor7.com")
        .send()
        .await
        .expect("spoofed origin responds");
    assert_eq!(spoofed.status(), 403);

    let hostile_with_bad_auth = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("origin", "https://evil.example")
        .header("authorization", "x".repeat(5000))
        .send()
        .await
        .expect("hostile origin with invalid auth responds");
    assert_eq!(hostile_with_bad_auth.status(), 403);
    assert_eq!(header(&hostile_with_bad_auth, "www-authenticate"), None);
}

#[tokio::test]
async fn relevant_header_bounds_return_small_fixed_failures_without_echo() {
    let base = serve().await;
    let client = reqwest::Client::new();
    let oversized = "attacker-marker-".to_string() + &"x".repeat(9000);

    let auth = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("authorization", &oversized)
        .send()
        .await
        .expect("overlong authorization responds");
    assert_eq!(auth.status(), 401);
    assert!(auth.bytes().await.expect("auth body").is_empty());

    let origin = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("origin", &oversized)
        .send()
        .await
        .expect("overlong Origin responds");
    assert_eq!(origin.status(), 403);
    assert!(origin.bytes().await.expect("origin body").is_empty());

    for name in ["accept", "mcp-protocol-version", "mcp-method", "mcp-name"] {
        let response = client
            .post(format!("{base}/v1/mcp/agent-port"))
            .header(name, &oversized)
            .send()
            .await
            .expect("overlong protocol header responds");
        assert_eq!(response.status(), 401, "{name}");
        let body = response.bytes().await.expect("bounded response body");
        assert!(body.is_empty());
        assert!(!String::from_utf8_lossy(&body).contains("attacker-marker"));
    }
}

#[tokio::test]
async fn invalid_origin_traffic_cannot_bypass_the_socket_peer_axis() {
    let base = serve_with_ip_limit(1).await;
    let client = reqwest::Client::new();
    let first = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("origin", "https://evil.example")
        .send()
        .await
        .expect("first invalid origin responds");
    assert_eq!(first.status(), 403);

    let second = client
        .post(format!("{base}/v1/mcp/agent-port"))
        .header("origin", "https://evil.example")
        .send()
        .await
        .expect("second invalid origin responds");
    assert_eq!(second.status(), 429);
    assert!(header(&second, "retry-after").is_some());
}
