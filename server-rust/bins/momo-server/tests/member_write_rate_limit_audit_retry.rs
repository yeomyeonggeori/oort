//! #4234 / ADR-0208 D10 증보 — a refusal whose audit row could not be written is still a 429, and
//! the **next** refusal tries the row again. Over real HTTP, without Postgres.
//!
//! The audit row of a burst is written once, so a row that did not commit must not count as
//! written: the limiter's first-denial marker goes back and the next refusal carries the retry.
//! Here the database is down for every attempt (a pool pointed at `127.0.0.1:1`), so every
//! refusal must attempt the write and log that it failed — one attempt in total would mean the
//! first failure silenced the burst for good — and every refusal must still be the 429, never a
//! 500 (Swift's rule: auditing must not change the answer).
//!
//! **Why this is a test binary of its own.** The only way to see an attempt without a database is
//! the `tracing::error!` each failed attempt emits, so the test installs a subscriber that counts
//! it. A subscriber installed for one test of a binary whose other tests run on parallel threads
//! misses events some of the time (tracing caches a callsite's interest globally, and a thread
//! that has no subscriber can cache "never" first — seen here: three runs of the same code, three
//! different counts). One test, and a global subscriber installed before anything is logged,
//! leaves nothing to race.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `a_failed_audit_row_is_retried_by_the_next_refusal_and_never_changes_the_answer` | every refusal after a failed audit write tries the row again, and every refusal is a 429; and a flood of parallel refusals is one first denial — one log line, one trip to the database — not one per request | `release_log_reservation` removed from the failure path of `audit_denial_once` (first half); the middleware ignoring the burst marker, so every refusal logs and enters the audit path (second half: the audit slot alone would still hold the rows to one, so only the log lines show it) |

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use momo_auth::{Principal, PrincipalKind};
use momo_server::config::RateLimitConfig;
use momo_server::rate_limit::{member_write, MemberWrite};
use momo_server::AppState;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;
use uuid::Uuid;

/// Counts the tracing events whose message contains `needle`.
struct CountMessages {
    needle: &'static str,
    hits: Arc<AtomicUsize>,
}

struct MessageOf(String);

impl Visit for MessageOf {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for CountMessages {
    fn on_event(&self, event: &tracing::Event<'_>, _context: Context<'_, S>) {
        let mut message = MessageOf(String::new());
        event.record(&mut message);
        if message.0.contains(self.needle) {
            self.hits.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// A pool that will never connect. `acquire_timeout` is shortened from sqlx's 30 s so one failed
/// audit attempt costs a third of a second.
fn dead_pool() -> momo_db::PgPool {
    momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(300))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials at construction")
}

/// The stand-in for `auth::require_principal`: every request is the same human.
async fn stand_in_auth(mut request: Request, next: Next) -> Response {
    request.extensions_mut().insert(Principal {
        member_id: Uuid::from_u128(7),
        workspace_id: Uuid::from_u128(1),
        token_id: Some(Uuid::new_v4()),
        scopes: Vec::new(),
        kind: PrincipalKind::Human,
    });
    next.run(request).await
}

#[tokio::test]
async fn a_failed_audit_row_is_retried_by_the_next_refusal_and_never_changes_the_answer() {
    let failures = Arc::new(AtomicUsize::new(0));
    let warnings = Arc::new(AtomicUsize::new(0));
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry()
            .with(CountMessages {
                needle: "rate limit audit row failed",
                hits: failures.clone(),
            })
            .with(CountMessages {
                needle: "rate limit exceeded (per-member write)",
                hits: warnings.clone(),
            }),
    )
    .expect("this binary installs the only subscriber, before anything is logged");

    let state = AppState::new(
        dead_pool(),
        "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig {
        message_send_per_member_limit: 1,
        ..RateLimitConfig::default()
    });
    let app = Router::new()
        .route(
            "/send",
            post(|| async { StatusCode::CREATED }).route_layer(middleware::from_fn_with_state(
                (state, MemberWrite::MessageSend),
                member_write,
            )),
        )
        .layer(middleware::from_fn(stand_in_auth));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let http = reqwest::Client::new();
    let send = || async {
        http.post(format!("{base}/send"))
            .send()
            .await
            .expect("request")
    };

    assert_eq!(send().await.status().as_u16(), 201);
    assert_eq!(
        failures.load(Ordering::SeqCst),
        0,
        "nothing was refused yet"
    );
    for refusal in 1..=3 {
        let refused = send().await;
        assert_eq!(
            refused.status().as_u16(),
            429,
            "refusal {refusal}: the database is down and the answer is still the 429"
        );
        assert!(
            refused.headers().contains_key("retry-after"),
            "refusal {refusal}: …with its Retry-After"
        );
        assert_eq!(
            failures.load(Ordering::SeqCst),
            refusal,
            "refusal {refusal} tried to write its audit row: the failure before it handed the marker back"
        );
    }

    // A flood of refusals that arrive together is one first denial. Only the request that owns the
    // burst's marker logs and goes on to the database; the other eleven are plain 429s. (Allowing
    // two or three covers a slow machine spreading the burst over one failed attempt; ignoring the
    // marker would make it twelve.)
    let (warnings_before, failures_before) = (
        warnings.load(Ordering::SeqCst),
        failures.load(Ordering::SeqCst),
    );
    let flood = join_all((0..12).map(|_| send())).await;
    for refused in &flood {
        assert_eq!(refused.status().as_u16(), 429, "every refusal of the flood");
        assert!(refused.headers().contains_key("retry-after"));
    }
    let warned = warnings.load(Ordering::SeqCst) - warnings_before;
    let tried = failures.load(Ordering::SeqCst) - failures_before;
    assert!(
        (1..=3).contains(&warned),
        "twelve refusals at once are one first denial and log once, not {warned} times"
    );
    assert!(
        (1..=3).contains(&tried),
        "…and go to the database once, not {tried} times"
    );
}
