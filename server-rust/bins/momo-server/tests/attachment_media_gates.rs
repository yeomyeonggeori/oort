//! #4673 C5 (ADR-0151 증보 5 D5) — the media write's gates that need **no database**.
//!
//! `PUT …/channels/{ch}/attachments/{id}/media`. Everything asserted here is decided *before* the
//! first statement, so the pool is a `connect_lazy` handle that never dials (the precedent is
//! `dm_closure_gates.rs`). That is also why this file runs in plain `cargo test --workspace`, where
//! the `#[ignore]`d PG suite (`attachment_media_conformance_pg.rs`) does not.
//!
//! The control that keeps these honest is [`a_valid_human_request_reaches_the_database`]: the same
//! handler, a human principal and a valid body, must go on to the (dead) pool and fail there with a
//! 500. Without it a refusal here could be the pool refusing, not the gate.
//!
//! | test | what it pins | what turns it red |
//! |---|---|---|
//! | `the_handler_refuses_a_non_human_principal_before_anything_else` | the handler's own `require_human`, with **no middleware in front** (the door's closed table stops an agent bearer first, so no HTTP test through the real router can reach this line) | delete `require_human(..)` from `set_media` |
//! | `a_request_that_is_wrong_in_itself_is_a_400_and_costs_no_connection` | the shape of the body (ranges, poster label, bytes, size, base64) is judged before any connection is taken, for whoever sent it | move a shape check after the first transaction, or drop one |
//! | `the_poster_route_asks_for_no_credential_kind_the_door_does_not` | the poster route has no `require_human` of its own: it is the content route for everyone else, and the door (not this handler) is what keeps an agent bearer out | add a `require_human` to `poster` (the two reads would then differ) |
//! | the control | the dead pool really is hit by a valid request | (it fails if the refusals above were the pool's doing) |

use std::net::SocketAddr;
use std::time::Duration;

use axum::routing::{get, put};
use axum::{Extension, Router};
use base64::Engine as _;
use momo_auth::{Principal, PrincipalKind};
use momo_server::{routes, AppState};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

const WORKSPACE: Uuid = Uuid::from_u128(0x4673_0000_0000_4000_8000_0000_0000_0001);
const CHANNEL: Uuid = Uuid::from_u128(0x4673_0000_0000_4000_8000_0000_0000_0002);
const MEMBER: Uuid = Uuid::from_u128(0x4673_0000_0000_4000_8000_0000_0000_0003);
const ATTACHMENT: Uuid = Uuid::from_u128(0x4673_0000_0000_4000_8000_0000_0000_0004);

/// A pool that never connects. `acquire_timeout` is shortened from sqlx's 30 s default so the
/// control test (which *does* reach the pool) fails in a fraction of a second.
fn dead_state() -> AppState {
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    AppState::new(
        pool,
        "attachment-media-gates-signing-secret".to_string(),
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

/// The two handlers mounted exactly as `build_app` mounts them (path, verb, body limit), but with
/// **no auth middleware and no budget layer**: the principal is injected, so what answers is the
/// handler and nothing in front of it.
async fn handlers_only(principal: Principal) -> String {
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/attachments/{attachment}/media",
            put(routes::attachment_media::set_media).layer(axum::extract::DefaultBodyLimit::max(
                routes::attachment_media::MAX_MEDIA_BODY_BYTES,
            )),
        )
        .route(
            "/v1/workspaces/{ws}/channels/{ch}/attachments/{attachment}/poster",
            get(routes::attachment_media::poster),
        )
        .layer(Extension(principal))
        .with_state(dead_state());
    serve(app).await
}

fn url(base: &str, leaf: &str) -> String {
    format!("{base}/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/attachments/{ATTACHMENT}/{leaf}")
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

fn valid_body() -> Value {
    json!({"durationMs": 4200, "width": 1280, "height": 720})
}

/// A real, small JPEG (a header with a frame size), base64.
fn jpeg_b64(width: u32, height: u32) -> String {
    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
    let buffer = ImageBuffer::from_pixel(width, height, Rgb([10u8, 100, 200]));
    let mut out = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(buffer)
        .write_to(&mut out, ImageFormat::Jpeg)
        .expect("encode");
    base64::engine::general_purpose::STANDARD.encode(out.into_inner())
}

// ---------------------------------------------------------------------------
// the handler's own gate — no middleware in front
// ---------------------------------------------------------------------------

/// The door's closed tables already stop an agent bearer before the handler runs (a unit test in
/// `routes::attachment_media` reads them), so no request through the real router can ever reach
/// `require_human`, and deleting it would leave every HTTP test green. This is the test that goes
/// red: the handler, called as an agent (and as a work host) with a body the human path accepts,
/// answers 403 and never touches the pool.
#[tokio::test]
async fn the_handler_refuses_a_non_human_principal_before_anything_else() {
    let http = Client::new();
    for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
        let base = handlers_only(principal(kind)).await;
        let (status, message) = message_of(
            http.put(url(&base, "media"))
                .json(&valid_body())
                .send()
                .await
                .expect("PUT"),
        )
        .await;
        assert_eq!(status, 403, "{kind:?}: {message}");
        assert_eq!(message, "human member required", "{kind:?}");

        // and the 403 wins over a body the human path would also refuse: it is decided before the
        // body is looked at, not after
        let (status, message) = message_of(
            http.put(url(&base, "media"))
                .json(&json!({"durationMs": 0, "width": 0, "height": 0}))
                .send()
                .await
                .expect("PUT bad body"),
        )
        .await;
        assert_eq!(status, 403, "{kind:?} with a bad body: {message}");
        assert_eq!(message, "human member required", "{kind:?} with a bad body");
    }
}

// ---------------------------------------------------------------------------
// the shape of the request is a 400 — before the transaction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_request_that_is_wrong_in_itself_is_a_400_and_costs_no_connection() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let http = Client::new();
    let good_jpeg = jpeg_b64(64, 64);
    let label_png = json!({"mime": "image/png", "dataBase64": good_jpeg});

    let cases: Vec<(&str, Value)> = vec![
        (
            "a length of 0",
            json!({"durationMs": 0, "width": 640, "height": 360}),
        ),
        (
            "a length of 24 h + 1 ms",
            json!({"durationMs": 86_400_001_i64, "width": 640, "height": 360}),
        ),
        (
            "a width of 0",
            json!({"durationMs": 1000, "width": 0, "height": 360}),
        ),
        (
            "a height of 16,385",
            json!({"durationMs": 1000, "width": 640, "height": 16_385}),
        ),
        (
            "a poster whose label is not a poster type",
            json!({"durationMs": 1000, "width": 640, "height": 360, "poster": label_png}),
        ),
        (
            "a poster that is not base64",
            json!({"durationMs": 1000, "width": 640, "height": 360,
                   "poster": {"mime": "image/jpeg", "dataBase64": "***"}}),
        ),
        (
            "a poster whose bytes are not a jpeg",
            json!({"durationMs": 1000, "width": 640, "height": 360,
                   "poster": {"mime": "image/jpeg", "dataBase64": base64::engine::general_purpose::STANDARD.encode(b"<html>")}}),
        ),
        (
            "a poster 1,281 pixels wide",
            json!({"durationMs": 1000, "width": 640, "height": 360,
                   "poster": {"mime": "image/jpeg", "dataBase64": jpeg_b64(1_281, 16)}}),
        ),
    ];
    for (what, body) in cases {
        let (status, message) = message_of(
            http.put(url(&base, "media"))
                .json(&body)
                .send()
                .await
                .expect("PUT"),
        )
        .await;
        assert_eq!(
            status, 400,
            "{what}: a shape refusal is a 400 decided before the pool is asked for a connection: {message}"
        );
        assert!(!message.is_empty(), "{what}: the refusal names the reason");
    }

    // a path that is not a uuid is a 400 too, and the workspace in the path must be the credential's
    let (status, message) = message_of(
        http.put(format!(
            "{base}/v1/workspaces/{WORKSPACE}/channels/{CHANNEL}/attachments/not-a-uuid/media"
        ))
        .json(&valid_body())
        .send()
        .await
        .expect("PUT bad id"),
    )
    .await;
    assert_eq!(
        (status, message.as_str()),
        (StatusCode::BAD_REQUEST, "invalid attachment id")
    );
    let (status, _) = message_of(
        http.put(format!(
            "{base}/v1/workspaces/{}/channels/{CHANNEL}/attachments/{ATTACHMENT}/media",
            Uuid::from_u128(9)
        ))
        .json(&valid_body())
        .send()
        .await
        .expect("PUT other workspace"),
    )
    .await;
    assert_eq!(status, 403, "the workspace in the path is the credential's");
}

// ---------------------------------------------------------------------------
// the poster read has no credential gate of its own
// ---------------------------------------------------------------------------

/// The poster is the content route for everyone else, and the content route has no `require_human`:
/// the door's closed tables are what keep an agent bearer out of both. A handler-level gate here
/// would make the two reads differ on the day those tables are widened for the content route alone,
/// so this pins the absence — the principal below is an agent and the request still goes on to the
/// pool (500), exactly as the content route's would.
#[tokio::test]
async fn the_poster_route_asks_for_no_credential_kind_the_door_does_not() {
    let base = handlers_only(principal(PrincipalKind::Agent)).await;
    let response = Client::new()
        .get(url(&base, "poster"))
        .send()
        .await
        .expect("GET");
    assert_eq!(
        response.status(),
        500,
        "the read goes on to the (dead) pool for any principal the door let in"
    );
}

// ---------------------------------------------------------------------------
// the control
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_valid_human_request_reaches_the_database() {
    let base = handlers_only(principal(PrincipalKind::Human)).await;
    let (status, _) = message_of(
        Client::new()
            .put(url(&base, "media"))
            .json(&valid_body())
            .send()
            .await
            .expect("PUT"),
    )
    .await;
    assert_eq!(
        status, 500,
        "the same handler, a human and a valid body: it must go on to the dead pool and fail there \
         (if this were a 4xx the refusals above could be the pool's doing, not the gates')"
    );
}
