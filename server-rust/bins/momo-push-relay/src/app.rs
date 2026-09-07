//! `GET /health` and `POST /v1/push`.
//!
//! Status codes are the set `momo-notifier` `classify_relay_status` branches
//! on: 200 (receipt), 429/5xx (transient), everything else (permanent).
//! A rejected signature is **401** so a flipped byte is a permanent failure
//! and never retried.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::config::RelayConfig;
use crate::dispatch::PushDispatch;
use crate::rate_limit::ServerRateLimiter;
use crate::replay::ReplayCache;
use crate::sender::{ApnsSender, PushReceipt, SenderError, StubApnsSender};

pub const SERVER_ID_HEADER: &str = "x-momo-server-id";
pub const SIGNATURE_HEADER: &str = "x-momo-push-signature";
const MAX_BODY: usize = 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    servers: Arc<HashMap<String, [u8; 32]>>,
    limiter: Arc<Mutex<ServerRateLimiter>>,
    replay: Arc<Mutex<ReplayCache>>,
    sender: Arc<ApnsSender>,
    apns_environment: Option<String>,
}

impl AppState {
    pub fn from_config(config: &RelayConfig, sender: ApnsSender) -> Self {
        AppState {
            servers: Arc::new(config.servers.clone()),
            limiter: Arc::new(Mutex::new(ServerRateLimiter::new(
                config.rate_limit_per_minute,
            ))),
            replay: Arc::new(Mutex::new(ReplayCache::new())),
            sender: Arc::new(sender),
            apns_environment: config
                .apns_environment
                .map(|environment| environment.as_str().to_string()),
        }
    }

    pub fn stub_from_config(config: &RelayConfig) -> Self {
        let sender = ApnsSender::Stub(StubApnsSender::new(
            config.stub_status,
            config.stub_reason.clone(),
            config.stub_capture_path.clone(),
        ));
        Self::from_config(config, sender)
    }
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/push", post(push))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "PushRelay",
    })
}

async fn push(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<PushReceipt>, (StatusCode, &'static str)> {
    let server_id = headers
        .get(SERVER_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "unregistered or invalid server signature",
        ))?;
    let signature_text = headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "unregistered or invalid server signature",
        ))?;
    let public_key = state.servers.get(server_id).ok_or((
        StatusCode::UNAUTHORIZED,
        "unregistered or invalid server signature",
    ))?;
    let signature = BASE64.decode(signature_text.as_bytes()).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            "unregistered or invalid server signature",
        )
    })?;
    if signature.len() != 64 || !momo_wire::verify(public_key, &body, &signature) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "unregistered or invalid server signature",
        ));
    }

    let now = Instant::now();
    {
        let mut replay = state.replay.lock().await;
        if let Some(receipt) = replay.lookup(server_id, &body, now) {
            return Ok(Json(receipt));
        }
    }

    let dispatch = PushDispatch::decode_closed(&body).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "invalid momo.push.dispatch.v2 payload",
        )
    })?;
    if dispatch.server_id != server_id {
        return Err((
            StatusCode::UNAUTHORIZED,
            "signed server_id does not match request header",
        ));
    }
    if let Some(configured) = &state.apns_environment {
        if dispatch.apns_env != *configured {
            return Err((
                StatusCode::BAD_REQUEST,
                "dispatch APNs environment does not match relay",
            ));
        }
    }

    {
        let mut limiter = state.limiter.lock().await;
        if !limiter.allow(server_id, now) {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "server push rate limit exceeded",
            ));
        }
    }

    let result = state
        .sender
        .send(&dispatch)
        .await
        .map_err(|error| match error {
            SenderError::EnvironmentMismatch => (
                StatusCode::BAD_REQUEST,
                "dispatch APNs environment does not match relay",
            ),
            _ => (StatusCode::BAD_GATEWAY, "APNs transport failed"),
        })?;
    let receipt = PushReceipt::from(result);
    {
        let mut replay = state.replay.lock().await;
        replay.remember(server_id, &body, receipt.clone(), now);
    }
    Ok(Json(receipt))
}

impl IntoResponse for PushReceipt {
    fn into_response(self) -> axum::response::Response {
        Json(self).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::TEST_DISPATCH_JSON;
    use ed25519_dalek::SigningKey;

    const SERVER_ID: &str = "server-a";

    fn sign(seed: &[u8; 32], body: &[u8]) -> String {
        momo_wire::sign_base64(seed, body).expect("sign")
    }

    fn stub_state(rate_limit: u32, capture: Option<String>) -> (AppState, [u8; 32]) {
        let seed = [9u8; 32];
        let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let mut servers = HashMap::new();
        servers.insert(SERVER_ID.to_string(), public);
        let config = RelayConfig {
            host: "127.0.0.1".into(),
            port: 28195,
            servers,
            rate_limit_per_minute: rate_limit,
            sender_mode: crate::config::SenderMode::Stub,
            stub_capture_path: capture,
            stub_status: 200,
            stub_reason: None,
            apns_environment: None,
            apns_key_path: None,
            apns_key_id: None,
            apns_team_id: None,
        };
        (AppState::stub_from_config(&config), seed)
    }

    async fn serve(state: AppState) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn post_push(
        base: &str,
        server_id: &str,
        signature: &str,
        body: &[u8],
    ) -> (u16, Vec<u8>) {
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{base}/v1/push"))
            .header("Content-Type", "application/json")
            .header("X-Momo-Server-Id", server_id)
            .header("X-Momo-Push-Signature", signature)
            .body(body.to_vec())
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = response.bytes().await.unwrap().to_vec();
        (status, bytes)
    }

    #[tokio::test]
    async fn health_reports_the_service_name() {
        let (state, _) = stub_state(60, None);
        let base = serve(state).await;
        let body: serde_json::Value = reqwest::get(format!("{base}/health"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["service"], "PushRelay");
    }

    #[tokio::test]
    async fn a_signed_stub_dispatch_returns_the_receipt_fields_the_notifier_decodes() {
        let dir = std::env::temp_dir();
        let capture = dir.join(format!("relay-http-capture-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&capture);
        let (state, seed) = stub_state(60, Some(capture.to_string_lossy().into()));
        let base = serve(state).await;
        let body = TEST_DISPATCH_JSON.as_bytes();
        let signature = sign(&seed, body);
        let (status, bytes) = post_push(&base, SERVER_ID, &signature, body).await;
        assert_eq!(status, 200);
        let receipt: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(receipt["apns_status"], 200);
        assert_eq!(receipt["apns_id"], "stub-apns-id");
        assert!(receipt.get("apns_reason").is_none() || receipt["apns_reason"].is_null());

        let captured = std::fs::read_to_string(&capture).unwrap();
        let object: serde_json::Value = serde_json::from_str(captured.trim()).unwrap();
        let keys: Vec<String> = object.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["aps".to_string(), "momo".to_string()]);
        assert!(!captured.contains("secret"));
        assert!(!captured.contains("apns_token"));
        let _ = std::fs::remove_file(&capture);
    }

    #[tokio::test]
    async fn flipping_one_signature_byte_is_401() {
        let (state, seed) = stub_state(60, None);
        let base = serve(state).await;
        let body = TEST_DISPATCH_JSON.as_bytes();
        let signature = sign(&seed, body);
        let mut raw = BASE64.decode(signature.as_bytes()).unwrap();
        raw[0] ^= 0x01;
        let flipped = BASE64.encode(&raw);
        let (status, _) = post_push(&base, SERVER_ID, &flipped, body).await;
        assert_eq!(status, 401);
    }

    #[tokio::test]
    async fn an_unregistered_server_id_is_401() {
        let (state, seed) = stub_state(60, None);
        let base = serve(state).await;
        let body = TEST_DISPATCH_JSON.as_bytes();
        let signature = sign(&seed, body);
        let (status, _) = post_push(&base, "unknown", &signature, body).await;
        assert_eq!(status, 401);
    }

    #[tokio::test]
    async fn replay_of_the_same_signed_body_does_not_double_send() {
        let dir = std::env::temp_dir();
        let capture = dir.join(format!("relay-replay-capture-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&capture);
        let (state, seed) = stub_state(60, Some(capture.to_string_lossy().into()));
        let base = serve(state).await;
        let body = TEST_DISPATCH_JSON.as_bytes();
        let signature = sign(&seed, body);
        let (first, bytes) = post_push(&base, SERVER_ID, &signature, body).await;
        let (second, again) = post_push(&base, SERVER_ID, &signature, body).await;
        assert_eq!(first, 200);
        assert_eq!(second, 200);
        assert_eq!(bytes, again);
        let captured = std::fs::read_to_string(&capture).unwrap();
        let lines = captured.lines().filter(|line| !line.is_empty()).count();
        assert_eq!(lines, 1, "replay must not write a second APNs payload");
        let _ = std::fs::remove_file(&capture);
    }

    #[tokio::test]
    async fn rate_limit_returns_429_on_distinct_signed_bodies() {
        let (state, seed) = stub_state(2, None);
        let base = serve(state).await;
        for index in 0..2 {
            let body = TEST_DISPATCH_JSON.replace(
                "44444444-4444-4444-4444-444444444444",
                &format!("44444444-4444-4444-4444-44444444444{index}"),
            );
            let signature = sign(&seed, body.as_bytes());
            let (status, _) = post_push(&base, SERVER_ID, &signature, body.as_bytes()).await;
            assert_eq!(status, 200, "dispatch {index}");
        }
        let body = TEST_DISPATCH_JSON.replace(
            "44444444-4444-4444-4444-444444444444",
            "44444444-4444-4444-4444-444444444449",
        );
        let signature = sign(&seed, body.as_bytes());
        let (status, _) = post_push(&base, SERVER_ID, &signature, body.as_bytes()).await;
        assert_eq!(status, 429);
    }

    #[tokio::test]
    async fn an_extra_body_field_is_400() {
        let (state, seed) = stub_state(60, None);
        let base = serve(state).await;
        let widened = format!(
            "{},\"body\":\"secret conversation\"}}",
            TEST_DISPATCH_JSON.trim_end_matches('}')
        );
        let signature = sign(&seed, widened.as_bytes());
        let (status, _) = post_push(&base, SERVER_ID, &signature, widened.as_bytes()).await;
        assert_eq!(status, 400);
    }

    /// The status set `classify_relay_status` in the notifier branches on.
    #[test]
    fn emitted_statuses_match_the_notifier_classifier() {
        fn classify(status: u16) -> &'static str {
            if status == 200 {
                "ok"
            } else if status == 429 || status >= 500 {
                "transient"
            } else {
                "permanent"
            }
        }
        assert_eq!(classify(200), "ok");
        assert_eq!(classify(400), "permanent");
        assert_eq!(classify(401), "permanent");
        assert_eq!(classify(429), "transient");
        assert_eq!(classify(502), "transient");
    }
}
