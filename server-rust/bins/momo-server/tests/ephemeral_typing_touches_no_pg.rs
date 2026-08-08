//! **ADR-0149 guard 3, proved at runtime without docker and without Postgres.**
//!
//! > 가드 3: **PG 접근 금지를 테스트로 못박는다.** 휘발 경로 처리 중 **쿼리 0건**을
//! > 단언한다. "실수로 한 줄 썼다"가 조용히 통과하면 안 된다.
//!
//! The method: build the real `AppState` around a pool pointed at
//! `127.0.0.1:1`, where **nothing is listening**, then drive the real handlers.
//! Any statement — a `SELECT EXISTS`, an audit row, a "just one lookup" someone
//! adds next quarter — fails to acquire a connection and turns the 202 into a
//! 500. There is no mocking involved and nothing to keep in sync: the assertion
//! is simply that the ephemeral publish path answers on a server that has no
//! database.
//!
//! [`the_dead_pool_really_is_dead`] is the control that makes that meaningful.
//! It drives `issue_grant`, which deliberately DOES read
//! (`is_channel_member`), against the same pool and requires it to fail. Without
//! that control, "the publish route returned 202" could mean the pool works.
//!
//! The handlers are called directly rather than over HTTP for one reason: every
//! protected route on this server pays **one** Postgres read in
//! `auth::require_principal` (the MOMO-300 revocation check), so a request that
//! travelled the router could never reach zero queries no matter what the
//! handler did. Guard 3 is about the 휘발 path, not about the credential check
//! every route on the instance shares — so the test targets the 휘발 path.
//!
//! Runs under a plain `cargo test -p momo-server`. No `#[ignore]`, no DB, no
//! container: this is the red test that must never need one.

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json, Router};
use momo_auth::{
    ephemeral_grant_key, sign_ephemeral_grant, EphemeralGrantScope, Principal, PrincipalKind,
    EPHEMERAL_GRANT_TTL_SECONDS,
};
use momo_server::config::EphemeralSettings;
use momo_server::dto::TypingSignalRequest;
use momo_server::routes::ephemeral;
use momo_server::AppState;
use serde_json::{json, Value};
use uuid::Uuid;

const JWT_SECRET: &str = "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa";

/// One captured `POST /publish`.
#[derive(Debug, Clone)]
struct CapturedPublish {
    api_key: Option<String>,
    body: Value,
}

type Captured = Arc<Mutex<Vec<CapturedPublish>>>;

/// A stand-in Centrifugo server API. It answers `{"result":{}}` like the real
/// one and records what it was asked to publish.
async fn spawn_mock_centrifugo() -> (String, Captured) {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/publish", post(capture))
        .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock centrifugo");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), captured)
}

async fn capture(
    State(sink): State<Captured>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let api_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    sink.lock()
        .expect("sink")
        .push(CapturedPublish { api_key, body });
    Json(json!({"result": {}}))
}

/// A pool that will never connect. `connect_lazy` dials on first use, and
/// nothing listens on port 1, so the first statement is also the last.
///
/// `acquire_timeout` is shortened from sqlx's 30s default purely so the control
/// test fails in a second rather than half a minute.
fn dead_pool() -> momo_db::PgPool {
    momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(500))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials at construction")
}

fn state_with(url: Option<&str>, per_channel_limit: u32) -> AppState {
    let settings = EphemeralSettings {
        cent_api_url: url.map(str::to_string),
        cent_api_key: url.map(|_| "test-centrifugo-api-key".to_string()),
        window_seconds: 60,
        per_channel_limit,
        per_member_limit: 0,
        grant_limit: 0,
    };
    AppState::new(
        dead_pool(),
        JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_ephemeral(settings)
}

fn human(workspace: Uuid, member: Uuid) -> Principal {
    Principal {
        member_id: member,
        workspace_id: workspace,
        token_id: Some(Uuid::new_v4()),
        scopes: vec!["messages:read".to_string()],
        kind: PrincipalKind::Human,
    }
}

fn grant_for(scope: EphemeralGrantScope) -> String {
    sign_ephemeral_grant(
        scope,
        EPHEMERAL_GRANT_TTL_SECONDS,
        &ephemeral_grant_key(JWT_SECRET),
    )
    .expect("sign")
    .token
}

async fn publish(
    state: &AppState,
    principal: &Principal,
    workspace: Uuid,
    channel: Uuid,
    grant: String,
) -> Result<StatusCode, StatusCode> {
    ephemeral::typing(
        State(state.clone()),
        Extension(principal.clone()),
        Path((workspace.to_string(), channel.to_string())),
        Json(TypingSignalRequest { grant }),
    )
    .await
    .map(|(status, _)| status)
    .map_err(|response| response.status())
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

/// Without this, every other assertion in this file is worthless: a 202 from a
/// route that never queries proves nothing unless a route that *does* query
/// fails on the same pool.
#[tokio::test]
async fn the_dead_pool_really_is_dead() {
    let (url, _captured) = spawn_mock_centrifugo().await;
    let state = state_with(Some(&url), 0);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let principal = human(workspace, Uuid::new_v4());

    let status = ephemeral::issue_grant(
        State(state),
        Extension(principal),
        Path((workspace.to_string(), channel.to_string())),
    )
    .await
    .map(|_| StatusCode::OK)
    .unwrap_or_else(|response| response.status());

    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "the grant route reads `is_channel_member`, so an unreachable database \
         must stop it — if this ever passes, the pool is not dead and the guard-3 \
         assertions below prove nothing"
    );
}

// ---------------------------------------------------------------------------
// Guard 3
// ---------------------------------------------------------------------------

/// **The red test.** Add a query — any query — to the publish path and this
/// turns 202 into 500.
#[tokio::test]
async fn the_publish_path_answers_with_no_database_at_all() {
    let (url, captured) = spawn_mock_centrifugo().await;
    let state = state_with(Some(&url), 0);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let member = Uuid::new_v4();
    let principal = human(workspace, member);
    let grant = grant_for(EphemeralGrantScope {
        member_id: member,
        workspace_id: workspace,
        channel_id: channel,
    });

    assert_eq!(
        publish(&state, &principal, workspace, channel, grant).await,
        Ok(StatusCode::ACCEPTED),
        "the 휘발 path must complete with Postgres unreachable (ADR-0149 guard 3)"
    );

    let publishes = captured.lock().expect("sink").clone();
    assert_eq!(publishes.len(), 1);
    let published = &publishes[0];
    assert_eq!(
        published.api_key.as_deref(),
        Some("test-centrifugo-api-key"),
        "the server API key authenticates the publish"
    );
    assert_eq!(
        published.body["channel"],
        json!(momo_ephemeral::ephemeral_channel(workspace, channel)),
        "guard 1: its own namespace, never `ch:`"
    );
    assert_eq!(published.body["data"]["type"], json!("ephemeral.typing"));
    assert_eq!(
        published.body["data"]["payload"]["member_id"],
        json!(member.to_string().to_uppercase())
    );
    // Invariant #4 and the no-history rule, asserted on the wire.
    assert!(
        published.body["data"].get("seq").is_none(),
        "a 휘발 signal must not consume a message.seq: {}",
        published.body
    );
    assert!(
        published.body.get("version").is_none(),
        "{}",
        published.body
    );
    assert!(
        published.body.get("idempotency_key").is_none(),
        "{}",
        published.body
    );
    // Nothing durable is described anywhere in the envelope.
    let rendered = published.body.to_string();
    assert!(!rendered.contains("outbox"), "{rendered}");
    assert!(!rendered.contains("message.new"), "{rendered}");
}

// ---------------------------------------------------------------------------
// The permission check — the heart of the batch
// ---------------------------------------------------------------------------

/// The three ways a grant can be pointed at something it was not minted for.
/// Each is a real leak: another channel exposes who is in it, another workspace
/// is cross-tenant, another member is impersonation.
#[tokio::test]
async fn a_grant_authorizes_exactly_one_member_in_exactly_one_channel() {
    let (url, captured) = spawn_mock_centrifugo().await;
    let state = state_with(Some(&url), 0);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let member = Uuid::new_v4();
    let mine = EphemeralGrantScope {
        member_id: member,
        workspace_id: workspace,
        channel_id: channel,
    };

    // (a) a grant for a channel I *am* in, aimed at one I am not.
    let other_channel = Uuid::new_v4();
    assert_eq!(
        publish(
            &state,
            &human(workspace, member),
            workspace,
            other_channel,
            grant_for(mine)
        )
        .await,
        Err(StatusCode::FORBIDDEN),
        "a grant must not travel to another channel"
    );

    // (b) another tenant's channel, with a grant minted under that tenant. The
    // path/credential workspace check refuses before the grant is even read —
    // there is no ordering in which this becomes an allow.
    let other_workspace = Uuid::new_v4();
    assert_eq!(
        publish(
            &state,
            &human(workspace, member),
            other_workspace,
            channel,
            grant_for(EphemeralGrantScope {
                workspace_id: other_workspace,
                ..mine
            })
        )
        .await,
        Err(StatusCode::FORBIDDEN),
        "cross-tenant publish must be refused (RLS does not cover this path)"
    );

    // (c) someone else's grant, replayed by a caller who authenticated as
    // themselves. This is why the grant is bound to a member and why the route
    // stays behind the bearer middleware.
    let impostor = Uuid::new_v4();
    assert_eq!(
        publish(
            &state,
            &human(workspace, impostor),
            workspace,
            channel,
            grant_for(mine)
        )
        .await,
        Err(StatusCode::FORBIDDEN),
        "a grant is bound to the member it was minted for"
    );

    // (d) no grant at all.
    assert_eq!(
        publish(
            &state,
            &human(workspace, member),
            workspace,
            channel,
            String::new()
        )
        .await,
        Err(StatusCode::FORBIDDEN)
    );

    assert!(
        captured.lock().expect("sink").is_empty(),
        "not one of those may reach Centrifugo"
    );
}

/// ADR-0149 scope: 사람은 작성 중, 에이전트는 작업 중. An agent holding a
/// perfectly valid grant is still refused.
#[tokio::test]
async fn an_agent_cannot_signal_that_it_is_typing() {
    let (url, captured) = spawn_mock_centrifugo().await;
    let state = state_with(Some(&url), 0);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let agent_member = Uuid::new_v4();
    let mut agent = human(workspace, agent_member);
    agent.kind = PrincipalKind::Agent;

    assert_eq!(
        publish(
            &state,
            &agent,
            workspace,
            channel,
            grant_for(EphemeralGrantScope {
                member_id: agent_member,
                workspace_id: workspace,
                channel_id: channel,
            })
        )
        .await,
        Err(StatusCode::FORBIDDEN)
    );
    assert!(captured.lock().expect("sink").is_empty());
}

// ---------------------------------------------------------------------------
// Guard 5
// ---------------------------------------------------------------------------

/// 「속도 제한이 실제로 건다」 — the limiter admits exactly the budget and then
/// stops, whatever the client does.
#[tokio::test]
async fn the_rate_limit_stops_a_client_that_ignores_the_cadence() {
    let (url, captured) = spawn_mock_centrifugo().await;
    let state = state_with(Some(&url), 3);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let member = Uuid::new_v4();
    let principal = human(workspace, member);
    let scope = EphemeralGrantScope {
        member_id: member,
        workspace_id: workspace,
        channel_id: channel,
    };

    for attempt in 0..3 {
        assert_eq!(
            publish(&state, &principal, workspace, channel, grant_for(scope)).await,
            Ok(StatusCode::ACCEPTED),
            "publish {attempt} is inside the budget"
        );
    }
    assert_eq!(
        publish(&state, &principal, workspace, channel, grant_for(scope)).await,
        Err(StatusCode::TOO_MANY_REQUESTS),
        "the fourth exceeds it"
    );
    assert_eq!(
        captured.lock().expect("sink").len(),
        3,
        "a throttled publish must never reach Centrifugo"
    );

    // A different channel has its own budget — one runaway conversation must
    // not silence the others.
    let quiet_channel = Uuid::new_v4();
    assert_eq!(
        publish(
            &state,
            &principal,
            workspace,
            quiet_channel,
            grant_for(EphemeralGrantScope {
                channel_id: quiet_channel,
                ..scope
            })
        )
        .await,
        Ok(StatusCode::ACCEPTED)
    );
}

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

/// An instance that was never handed the Centrifugo publish credential must
/// refuse **both** routes — including the grant route, so no client is ever
/// given a capability against a transport that does not exist.
#[tokio::test]
async fn an_unconfigured_instance_refuses_the_whole_surface() {
    let state = state_with(None, 0);
    let workspace = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let member = Uuid::new_v4();
    let principal = human(workspace, member);

    assert_eq!(
        publish(
            &state,
            &principal,
            workspace,
            channel,
            grant_for(EphemeralGrantScope {
                member_id: member,
                workspace_id: workspace,
                channel_id: channel,
            })
        )
        .await,
        Err(StatusCode::SERVICE_UNAVAILABLE)
    );

    let grant_status = ephemeral::issue_grant(
        State(state),
        Extension(principal),
        Path((workspace.to_string(), channel.to_string())),
    )
    .await
    .map(|_| StatusCode::OK)
    .unwrap_or_else(|response| response.status());
    assert_eq!(
        grant_status,
        StatusCode::SERVICE_UNAVAILABLE,
        "refused before the database is touched, so this is not the dead pool talking"
    );
}

// ---------------------------------------------------------------------------
// Guard 1, in every environment's config
// ---------------------------------------------------------------------------

/// 「휘발 네임스페이스가 **모든 환경 설정**에서 `history_size: 0`이다」.
///
/// Reads the shipped Centrifugo configs off disk rather than trusting that a
/// reviewer noticed both. Adding a third environment file without the namespace
/// turns this red; setting a history on one of them turns it red too.
///
/// `clients/mobile-spike/tools/centrifugo-spike/centrifugo.json` is deliberately
/// out of scope: it is a client-side spike harness with no momo server behind
/// it, and `clients/**` is not this batch's to touch.
#[test]
fn the_ephemeral_namespace_keeps_no_history_in_every_environment() {
    let infra = repo_root().join("infra");
    let mut configs = Vec::new();
    collect_centrifugo_configs(&infra, &mut configs);
    configs.sort();
    assert!(
        configs.len() >= 2,
        "expected at least the dev and prod Centrifugo configs under {}, found {configs:?}",
        infra.display()
    );

    for path in &configs {
        let raw = std::fs::read_to_string(path).expect("read config");
        let parsed: Value = serde_json::from_str(&raw).expect("parse config");
        let namespaces = parsed["channel"]["namespaces"]
            .as_array()
            .unwrap_or_else(|| panic!("{} has no channel.namespaces", path.display()));
        let ephemeral = namespaces
            .iter()
            .find(|entry| entry["name"] == json!(momo_ephemeral::EPHEMERAL_NAMESPACE))
            .unwrap_or_else(|| {
                panic!(
                    "{} is missing the `{}` namespace — a 휘발 신호 feature that only \
                     works in one environment is worse than none",
                    path.display(),
                    momo_ephemeral::EPHEMERAL_NAMESPACE
                )
            });

        assert_eq!(
            ephemeral["history_size"],
            json!(0),
            "{}: a replayed 「작성 중」 on reconnect is a ghost",
            path.display()
        );
        assert_ne!(
            ephemeral["force_recovery"],
            json!(true),
            "{}: there is nothing to recover",
            path.display()
        );
        assert_eq!(
            ephemeral["subscribe_proxy_enabled"],
            json!(true),
            "{}: without the proxy anyone could watch any channel's typists",
            path.display()
        );

        // The property this batch must not break, in EVERY namespace of EVERY
        // config: clients still cannot publish. The whole ADR-0149 design rests
        // on the server being the only author.
        for namespace in namespaces {
            let object = namespace.as_object().expect("namespace object");
            for key in object.keys() {
                assert!(
                    !key.starts_with("allow_publish"),
                    "{}: namespace `{}` opened `{key}` — client publish must stay shut \
                     (ADR-0149 기각 B)",
                    path.display(),
                    namespace["name"]
                );
            }
        }
    }
}

fn repo_root() -> PathBuf {
    // …/server-rust/bins/momo-server → repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

fn collect_centrifugo_configs(directory: &FsPath, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_centrifugo_configs(&path, found);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("centrifugo") && name.ends_with(".json"))
        {
            found.push(path);
        }
    }
}
