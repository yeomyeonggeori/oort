//! #4234 / ADR-0208 D10 증보 — the per-member write budget's mechanics, over real HTTP and
//! **without Postgres**.
//!
//! `rate_limit::member_write` is mounted by `build_app` on four write routes. What it does to a
//! request does not depend on which route that is, so the mechanics are proved here once, on a
//! stand-in router that mounts the real middleware exactly the way `build_app` does
//! (`route_layer`, inside a layer that plays `auth::require_principal` by putting a `Principal`
//! into the request extensions). The wiring of the real routes — and the audit row, which needs a
//! database — is `member_write_rate_limit_pg.rs`.
//!
//! The `AppState` is built around a pool pointed at `127.0.0.1:1`, where nothing listens. That is
//! not decoration: the first refusal of a burst tries to write its audit row, so every test that
//! gets a 429 here also proves the refusal is a 429 on a server whose database is down — never a
//! 500 (Swift's rule: auditing must not change the answer).
//!
//! Runs under a plain `cargo test -p momo-server`; no `#[ignore]`, no container.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `the_budget_is_exact_and_a_refusal_never_reaches_the_handler` | N requests pass, the N+1st is a 429 with `Retry-After` and the standard envelope, and the handler never ran for it | the middleware is not mounted, the header is dropped, or the verdict is ignored |
//! | `an_agent_credential_has_its_own_larger_budget` | the limit follows `Principal::kind` | the kind branch is removed (everyone gets the human number, or everyone the agent one) |
//! | `a_work_host_is_held_to_the_agent_budget_not_the_human_one` | a machine credential is not held to a person's number | `WorkHost` falls into the human arm |
//! | `members_and_surfaces_have_separate_budgets` | one member cannot spend another's, one surface cannot spend another's | the key loses the member id or the surface prefix |
//! | `the_window_is_the_configured_one_and_retry_after_follows_it` | `Retry-After` is measured against `RATE_LIMIT_WINDOW_SECONDS`, not a constant | the window is hard-coded |
//! | `zero_means_no_budget` | the operator's off switch | the `limit == 0` early return is removed |
//! | `a_request_with_no_principal_is_passed_on_and_spends_nothing` | a caller the limiter cannot name is not limited and does not eat a member's budget | the missing principal is refused or counted under a shared key |
//! | `the_gate_covers_only_the_method_it_is_mounted_on` | the route wiring `build_app` relies on: a verb chained after `route_layer` is outside it | the layer is attached after the second verb is chained |

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use momo_auth::{Principal, PrincipalKind};
use momo_server::config::RateLimitConfig;
use momo_server::rate_limit::{member_write, MemberWrite};
use momo_server::AppState;
use serde_json::{json, Value};
use uuid::Uuid;

const JWT_SECRET: &str = "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa";

/// A pool that will never connect (see the module docs). `acquire_timeout` is shortened from
/// sqlx's 30 s so the one audit attempt per burst costs a third of a second, not half a minute.
fn dead_pool() -> momo_db::PgPool {
    momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(300))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials at construction")
}

/// The stand-in for `auth::require_principal`: the request names its principal in two headers
/// and this puts the `Principal` where the real middleware does. No `x-member` → no principal.
async fn stand_in_auth(mut request: Request, next: Next) -> Response {
    // Read the two headers inside a block: nothing borrowed from `request` (whose body is not
    // `Sync`) may be alive across the `.await` below, or the middleware future stops being `Send`.
    let (member, kind) = {
        let headers = request.headers();
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        let member = header("x-member").and_then(|value| Uuid::parse_str(&value).ok());
        let kind = match header("x-kind").as_deref() {
            Some("agent") => PrincipalKind::Agent,
            Some("work_host") => PrincipalKind::WorkHost,
            _ => PrincipalKind::Human,
        };
        (member, kind)
    };
    if let Some(member_id) = member {
        request.extensions_mut().insert(Principal {
            member_id,
            workspace_id: Uuid::from_u128(1),
            token_id: Some(Uuid::new_v4()),
            scopes: Vec::new(),
            kind,
        });
    }
    next.run(request).await
}

async fn handled(State(hits): State<Arc<AtomicUsize>>) -> StatusCode {
    hits.fetch_add(1, Ordering::SeqCst);
    StatusCode::CREATED
}

struct Edge {
    base: String,
    http: reqwest::Client,
    /// How many requests reached a handler.
    hits: Arc<AtomicUsize>,
}

impl Edge {
    async fn post(&self, path: &str, member: Option<Uuid>, kind: &str) -> reqwest::Response {
        let mut request = self
            .http
            .post(format!("{}{path}", self.base))
            .header("x-kind", kind);
        if let Some(member) = member {
            request = request.header("x-member", member.to_string());
        }
        request.send().await.expect("request")
    }

    async fn status(&self, path: &str, member: Uuid, kind: &str) -> u16 {
        self.post(path, Some(member), kind).await.status().as_u16()
    }
}

/// Three routes, one per surface, each mounted the way `build_app` mounts the real ones.
/// `/chain` is the real `PATCH`+`DELETE` shape of `…/scheduled-messages/{id}`: the gate on the
/// first verb, the second chained after it.
async fn serve(config: RateLimitConfig) -> Edge {
    let state = AppState::new(
        dead_pool(),
        JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(config);
    let gate = |surface: MemberWrite| {
        middleware::from_fn_with_state((state.clone(), surface), member_write)
    };
    let hits = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/send",
            post(handled).route_layer(gate(MemberWrite::MessageSend)),
        )
        .route(
            "/schedule",
            post(handled).route_layer(gate(MemberWrite::ScheduledWrite)),
        )
        .route(
            "/upload",
            post(handled).route_layer(gate(MemberWrite::UploadStart)),
        )
        .route(
            "/chain",
            post(handled)
                .route_layer(gate(MemberWrite::ScheduledWrite))
                .delete(handled),
        )
        .layer(middleware::from_fn(stand_in_auth))
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Edge {
        base: format!("http://{address}"),
        http: reqwest::Client::new(),
        hits,
    }
}

fn limits(send: u32, agent: u32, schedule: u32, upload: u32) -> RateLimitConfig {
    RateLimitConfig {
        message_send_per_member_limit: send,
        message_send_per_agent_limit: agent,
        scheduled_write_per_member_limit: schedule,
        upload_start_per_member_limit: upload,
        ..RateLimitConfig::default()
    }
}

#[tokio::test]
async fn the_budget_is_exact_and_a_refusal_never_reaches_the_handler() {
    let edge = serve(limits(3, 50, 50, 50)).await;
    let member = Uuid::new_v4();

    for attempt in 1..=3 {
        assert_eq!(
            edge.status("/send", member, "human").await,
            201,
            "request {attempt} is inside the budget"
        );
    }
    let refused = edge.post("/send", Some(member), "human").await;
    assert_eq!(refused.status().as_u16(), 429, "the 4th is the first over");
    let retry_after: u64 = refused
        .headers()
        .get("retry-after")
        .expect("a 429 carries Retry-After")
        .to_str()
        .expect("ascii")
        .parse()
        .expect("whole seconds");
    assert!(
        (1..=60).contains(&retry_after),
        "never 0 (a client told to retry now is refused again) and never past the window: {retry_after}"
    );
    let body: Value = refused.json().await.expect("the standard error envelope");
    assert_eq!(
        body,
        json!({"error": {"message": "rate limit exceeded"}}),
        "the same body every other limiter on this server answers"
    );
    // A second refusal: still a 429, and the audit attempt of the first refusal (which failed on
    // this database-less server) did not turn anything into a 500.
    assert_eq!(edge.status("/send", member, "human").await, 429);
    assert_eq!(
        edge.hits.load(Ordering::SeqCst),
        3,
        "the handler ran for the three admitted requests and for none of the refused ones"
    );
}

#[tokio::test]
async fn an_agent_credential_has_its_own_larger_budget() {
    let edge = serve(limits(2, 5, 50, 50)).await;
    let (human, agent) = (Uuid::new_v4(), Uuid::new_v4());

    for _ in 0..5 {
        assert_eq!(edge.status("/send", agent, "agent").await, 201);
    }
    assert_eq!(
        edge.status("/send", agent, "agent").await,
        429,
        "the agent budget is 5, not the human 2 and not unlimited"
    );
    for _ in 0..2 {
        assert_eq!(edge.status("/send", human, "human").await, 201);
    }
    assert_eq!(
        edge.status("/send", human, "human").await,
        429,
        "the human budget is 2, not the agent 5"
    );
}

#[tokio::test]
async fn a_work_host_is_held_to_the_agent_budget_not_the_human_one() {
    let edge = serve(limits(1, 3, 50, 50)).await;
    let host = Uuid::new_v4();
    for _ in 0..3 {
        assert_eq!(edge.status("/send", host, "work_host").await, 201);
    }
    assert_eq!(edge.status("/send", host, "work_host").await, 429);
}

#[tokio::test]
async fn members_and_surfaces_have_separate_budgets() {
    let edge = serve(limits(1, 1, 1, 1)).await;
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());

    assert_eq!(edge.status("/send", a, "human").await, 201);
    assert_eq!(
        edge.status("/send", a, "human").await,
        429,
        "a spent the send budget"
    );
    assert_eq!(
        edge.status("/send", b, "human").await,
        201,
        "…which is a's, not b's"
    );
    for path in ["/schedule", "/upload"] {
        assert_eq!(
            edge.status(path, a, "human").await,
            201,
            "a's send budget being spent does not touch {path}"
        );
        assert_eq!(edge.status(path, a, "human").await, 429);
    }
}

#[tokio::test]
async fn the_window_is_the_configured_one_and_retry_after_follows_it() {
    let edge = serve(RateLimitConfig {
        window_seconds: 7200,
        ..limits(1, 50, 50, 50)
    })
    .await;
    let member = Uuid::new_v4();
    assert_eq!(edge.status("/send", member, "human").await, 201);
    let refused = edge.post("/send", Some(member), "human").await;
    assert_eq!(refused.status().as_u16(), 429);
    let retry_after: u64 = refused
        .headers()
        .get("retry-after")
        .expect("Retry-After")
        .to_str()
        .expect("ascii")
        .parse()
        .expect("whole seconds");
    assert!(
        (3600..=7200).contains(&retry_after),
        "the one counted request leaves a 2-hour window in about two hours, not in a minute: {retry_after}"
    );
}

#[tokio::test]
async fn zero_means_no_budget() {
    let edge = serve(limits(0, 0, 0, 0)).await;
    let member = Uuid::new_v4();
    for path in ["/send", "/schedule", "/upload"] {
        for _ in 0..40 {
            assert_eq!(edge.status(path, member, "human").await, 201);
        }
    }
    assert_eq!(edge.hits.load(Ordering::SeqCst), 120);
}

#[tokio::test]
async fn a_request_with_no_principal_is_passed_on_and_spends_nothing() {
    let edge = serve(limits(1, 1, 1, 1)).await;
    for _ in 0..5 {
        assert_eq!(
            edge.post("/send", None, "human").await.status().as_u16(),
            201,
            "a caller the limiter cannot name is not limited (the handler's own extractor refuses it)"
        );
    }
    let member = Uuid::new_v4();
    assert_eq!(
        edge.status("/send", member, "human").await,
        201,
        "the anonymous requests spent nobody's budget"
    );
    assert_eq!(edge.status("/send", member, "human").await, 429);
}

#[tokio::test]
async fn the_gate_covers_only_the_method_it_is_mounted_on() {
    let edge = serve(limits(50, 50, 1, 50)).await;
    let member = Uuid::new_v4();
    assert_eq!(edge.status("/chain", member, "human").await, 201);
    assert_eq!(
        edge.status("/chain", member, "human").await,
        429,
        "the gated verb is over its budget"
    );
    for _ in 0..5 {
        let response = edge
            .http
            .delete(format!("{}/chain", edge.base))
            .header("x-member", member.to_string())
            .send()
            .await
            .expect("delete");
        assert_eq!(
            response.status().as_u16(),
            201,
            "the verb chained after the layer is outside it: cancelling is never budgeted"
        );
    }
}
