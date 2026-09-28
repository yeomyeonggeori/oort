//! Mock providers in the four shapes the preset catalog names (OpenAI, Anthropic,
//! xAI, OpenRouter), driven through the real guarded client. Every refusal mock
//! echoes the key it received — in the body and in a header — so "the key never
//! leaves" is tested against a provider that tries to leak it.

use super::*;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

const GOOD: &str = "sk-probe-good-0001";
const BAD: &str = "sk-probe-bad-9999";

/// Answers each lookup from a script; the last entry repeats.
struct ScriptedLookup {
    answers: Vec<Vec<IpAddr>>,
    calls: AtomicUsize,
}

impl ScriptedLookup {
    fn new(answers: &[&[&str]]) -> Arc<ScriptedLookup> {
        Arc::new(ScriptedLookup {
            answers: answers
                .iter()
                .map(|set| set.iter().map(|raw| raw.parse().unwrap()).collect())
                .collect(),
            calls: AtomicUsize::new(0),
        })
    }
}

impl HostLookup for ScriptedLookup {
    fn lookup(
        &self,
        _host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self.answers[call.min(self.answers.len() - 1)].clone();
        Box::pin(async move { Ok(answer) })
    }
}

fn echo_refusal(key: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [("x-echo-key", key.to_string())],
        format!(r#"{{"error":{{"message":"Incorrect API key provided: {key}"}}}}"#),
    )
        .into_response()
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string()
}

/// One loopback server with a path per provider shape. Returns (port, hits).
async fn mock() -> (u16, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let count = move || {
        h.fetch_add(1, Ordering::SeqCst);
    };
    let c1 = count.clone();
    let c2 = count.clone();
    let c3 = count.clone();
    let c4 = count.clone();
    let c5 = count.clone();
    let c6 = count.clone();
    let c7 = count.clone();
    let c8 = count.clone();
    let app = Router::new()
        // OpenAI / xAI shape.
        .route(
            "/openai/v1/models",
            get(move |headers: HeaderMap| async move {
                c1();
                let key = bearer(&headers);
                if key != GOOD {
                    return echo_refusal(&key);
                }
                (
                    [
                        ("x-ratelimit-limit-requests", "5000"),
                        ("x-ratelimit-remaining-requests", "4999"),
                        ("x-ratelimit-limit-tokens", "800000"),
                    ],
                    axum::Json(serde_json::json!({
                        "object": "list",
                        "data": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
                    })),
                )
                    .into_response()
            }),
        )
        // Anthropic shape: x-api-key + anthropic-version, never Authorization.
        .route(
            "/anthropic/v1/models",
            get(move |headers: HeaderMap| async move {
                c2();
                let key = headers
                    .get("x-api-key")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let versioned = headers
                    .get("anthropic-version")
                    .is_some_and(|v| v == ANTHROPIC_VERSION);
                if key != GOOD || !versioned || headers.contains_key("authorization") {
                    return echo_refusal(&key);
                }
                (
                    [
                        ("anthropic-ratelimit-requests-limit", "50"),
                        ("anthropic-ratelimit-requests-remaining", "49"),
                        ("anthropic-ratelimit-tokens-remaining", "39000"),
                    ],
                    axum::Json(serde_json::json!({
                        "data": [{"id": "claude-a"}, {"id": "claude-b"}],
                        "has_more": false,
                    })),
                )
                    .into_response()
            }),
        )
        .route(
            "/anthropic-paged/v1/models",
            get(move || async move {
                c3();
                axum::Json(serde_json::json!({"data": [{"id": "x"}], "has_more": true}))
            }),
        )
        // OpenRouter: /models is public (would call any key a success), /key is not.
        .route(
            "/api/v1/models",
            get(move || async move {
                c4();
                axum::Json(serde_json::json!({"data": [{"id": "public"}]}))
            }),
        )
        .route(
            "/api/v1/key",
            get(move |headers: HeaderMap| async move {
                c5();
                let key = bearer(&headers);
                if key != GOOD {
                    return echo_refusal(&key);
                }
                axum::Json(serde_json::json!({
                    "data": {"label": "k", "limit": 20.0, "limit_remaining": 12.5, "usage": 7.5}
                }))
                .into_response()
            }),
        )
        .route(
            "/limited/v1/models",
            get(move || async move {
                c6();
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [
                        ("retry-after", "7"),
                        ("x-ratelimit-remaining-requests", "0"),
                    ],
                    "slow down",
                )
            }),
        )
        .route(
            "/broken/v1/models",
            get(move || async move {
                c7();
                StatusCode::SERVICE_UNAVAILABLE
            }),
        )
        .route(
            "/html/v1/models",
            get(move || async move {
                c8();
                axum::response::Html("<html>welcome</html>")
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, hits)
}

/// A policy that lets the listed test hosts (and physical loopback) through —
/// the operator opt-in (ADR-0004 증보 5 D4) — resolved by a script to 127.0.0.1.
fn opted_in(hosts: &[&str]) -> GuardedProviderProbe {
    GuardedProviderProbe::with_lookup(
        EgressPolicy {
            allow_local: true,
            local_hosts: hosts.iter().map(|h| h.to_string()).collect(),
            operator_hosts: Vec::new(),
        },
        ScriptedLookup::new(&[&["127.0.0.1"]]),
        Duration::from_secs(5),
    )
}

fn target(base_url: String, credential: ProbeCredential) -> ProbeTarget {
    ProbeTarget {
        base_url,
        credential,
    }
}

fn assert_no_key(report: &ProbeReport) {
    let debug = format!("{report:?}");
    assert!(!debug.contains(GOOD) && !debug.contains(BAD), "{debug}");
}

#[tokio::test]
async fn openai_shape_success_reports_model_count_and_header_numbers() {
    let (port, hits) = mock().await;
    let report = opted_in(&[])
        .probe(&target(
            format!("http://127.0.0.1:{port}/openai/v1/"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok, "{report:?}");
    assert_eq!(report.reason, None);
    assert_eq!(report.http_status, Some(200));
    assert_eq!(report.method, ProbeMethod::Models);
    assert_eq!(report.model_count, Some(3));
    let limits = report.rate_limit.clone().expect("x-ratelimit headers");
    assert_eq!(limits.source, "x-ratelimit");
    assert_eq!(limits.requests_limit, Some(5000));
    assert_eq!(limits.requests_remaining, Some(4999));
    assert_eq!(limits.tokens_limit, Some(800000));
    assert_eq!(
        limits.tokens_remaining, None,
        "absent header is not invented"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_refused_key_is_rejected_and_the_echoed_key_goes_nowhere() {
    let (port, _) = mock().await;
    for path in ["openai", "anthropic"] {
        let credential = if path == "anthropic" {
            ProbeCredential::AnthropicKey(BAD.into())
        } else {
            ProbeCredential::Bearer(BAD.into())
        };
        let report = opted_in(&[])
            .probe(&target(
                format!("http://127.0.0.1:{port}/{path}/v1"),
                credential,
            ))
            .await;
        assert_eq!(report.outcome, ProbeOutcome::Rejected, "{path}: {report:?}");
        assert_eq!(report.reason.as_deref(), Some(AUTH_FAILED_REASON));
        assert_eq!(report.http_status, Some(401));
        assert_no_key(&report);
    }
}

#[tokio::test]
async fn anthropic_shape_uses_x_api_key_and_withholds_a_paginated_count() {
    let (port, _) = mock().await;
    let report = opted_in(&[])
        .probe(&target(
            format!("http://127.0.0.1:{port}/anthropic/v1"),
            ProbeCredential::AnthropicKey(GOOD.into()),
        ))
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok, "{report:?}");
    assert_eq!(report.model_count, Some(2));
    let limits = report.rate_limit.clone().expect("anthropic headers");
    assert_eq!(limits.source, "anthropic-ratelimit");
    assert_eq!(limits.requests_limit, Some(50));
    assert_eq!(limits.tokens_remaining, Some(39000));

    // The same key as a Bearer is refused by the Anthropic mock: the kind, not
    // the URL, chose the header.
    let as_bearer = opted_in(&[])
        .probe(&target(
            format!("http://127.0.0.1:{port}/anthropic/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(as_bearer.outcome, ProbeOutcome::Rejected);

    let paged = opted_in(&[])
        .probe(&target(
            format!("http://127.0.0.1:{port}/anthropic-paged/v1"),
            ProbeCredential::AnthropicKey(GOOD.into()),
        ))
        .await;
    assert_eq!(paged.outcome, ProbeOutcome::Ok);
    assert_eq!(
        paged.model_count, None,
        "a first page is not the number of models"
    );
}

#[tokio::test]
async fn xai_is_the_openai_shape_under_its_own_host() {
    let (port, _) = mock().await;
    let report = opted_in(&["api.x.ai"])
        .probe(&target(
            format!("http://api.x.ai:{port}/openai/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok, "{report:?}");
    assert_eq!(report.model_count, Some(3));
}

#[tokio::test]
async fn openrouter_is_checked_on_key_because_its_model_list_is_public() {
    let (port, hits) = mock().await;
    let base = format!("http://openrouter.ai:{port}/api/v1");
    let bad = opted_in(&["openrouter.ai"])
        .probe(&target(base.clone(), ProbeCredential::Bearer(BAD.into())))
        .await;
    assert_eq!(
        bad.outcome,
        ProbeOutcome::Rejected,
        "a wrong key must not pass via the public /models: {bad:?}"
    );
    assert_eq!(bad.method, ProbeMethod::Key);
    assert_no_key(&bad);

    let good = opted_in(&["openrouter.ai"])
        .probe(&target(base, ProbeCredential::Bearer(GOOD.into())))
        .await;
    assert_eq!(good.outcome, ProbeOutcome::Ok, "{good:?}");
    assert_eq!(
        good.credit,
        Some(KeyCredit {
            limit: Some(20.0),
            limit_remaining: Some(12.5),
            usage: Some(7.5),
        })
    );
    assert_eq!(good.model_count, None);
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn rate_limited_unknown_and_invalid_are_distinct() {
    let (port, _) = mock().await;
    let probe = opted_in(&[]);
    let at = |path: &str| {
        target(
            format!("http://127.0.0.1:{port}/{path}/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        )
    };

    let limited = probe.probe(&at("limited")).await;
    assert_eq!(limited.outcome, ProbeOutcome::RateLimited);
    assert_eq!(limited.reason.as_deref(), Some(RATE_LIMITED_REASON));
    assert_eq!(limited.retry_after_seconds, Some(7));
    assert_eq!(
        limited
            .rate_limit
            .as_ref()
            .and_then(|l| l.requests_remaining),
        Some(0)
    );

    let broken = probe.probe(&at("broken")).await;
    assert_eq!(broken.outcome, ProbeOutcome::Unknown);
    assert_eq!(broken.reason.as_deref(), Some("provider_status_503"));

    let html = probe.probe(&at("html")).await;
    assert_eq!(html.outcome, ProbeOutcome::Unknown);
    assert_eq!(html.reason.as_deref(), Some(INVALID_RESPONSE_REASON));

    let missing = probe.probe(&at("nothing-here")).await;
    assert_eq!(missing.reason.as_deref(), Some("provider_status_404"));
}

#[tokio::test]
async fn a_closed_port_is_unreachable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let report = opted_in(&[])
        .probe(&target(
            format!("http://127.0.0.1:{port}/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Unreachable);
    assert_eq!(report.reason.as_deref(), Some(UNREACHABLE_REASON));
    assert_eq!(report.http_status, None);
}

// ---------------------------------------------------------------------------
// egress (#2852) — the probe is a provider call and gets the provider's guard
// ---------------------------------------------------------------------------

fn default_policy(lookup: Arc<ScriptedLookup>) -> GuardedProviderProbe {
    GuardedProviderProbe::with_lookup(EgressPolicy::default(), lookup, Duration::from_secs(5))
}

#[tokio::test]
async fn a_name_resolving_to_a_private_address_is_never_dialled() {
    let (port, hits) = mock().await;
    let report = default_policy(ScriptedLookup::new(&[&["127.0.0.1"]]))
        .probe(&target(
            format!("http://llm.attacker.example:{port}/openai/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(
        report.reason.as_deref(),
        Some(EGRESS_DENIED_REASON),
        "{report:?}"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "the private service was dialled"
    );
}

/// Public on the precheck, private on the connect-time lookup: only the
/// resolver installed on the client can refuse this one.
#[tokio::test]
async fn rebinding_between_precheck_and_connect_is_refused_at_connect() {
    let (port, hits) = mock().await;
    let lookup = ScriptedLookup::new(&[&["93.184.216.34"], &["127.0.0.1"]]);
    let report = default_policy(lookup.clone())
        .probe(&target(
            format!("http://rebind.attacker.example:{port}/openai/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(
        lookup.calls.load(Ordering::SeqCst),
        2,
        "scenario needs two lookups"
    );
    assert_eq!(
        report.reason.as_deref(),
        Some(EGRESS_DENIED_REASON),
        "{report:?}"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "rebinding reached the service"
    );
}

#[tokio::test]
async fn private_literals_are_refused_without_a_lookup() {
    let (port, hits) = mock().await;
    for base in [
        format!("http://127.0.0.1:{port}/openai/v1"),
        format!("http://[::ffff:127.0.0.1]:{port}/openai/v1"),
        "https://169.254.169.254/v1".to_string(),
    ] {
        let report = default_policy(ScriptedLookup::new(&[&[]]))
            .probe(&target(base.clone(), ProbeCredential::Bearer(GOOD.into())))
            .await;
        assert_eq!(
            report.reason.as_deref(),
            Some(EGRESS_DENIED_REASON),
            "{base}"
        );
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

/// The review-2972 PoC's address-notation variants, pointed at a live
/// loopback service. The lookup answers a PUBLIC address, so a variant the
/// precheck mistook for a name (while the connector parsed it as a literal)
/// would pass the precheck and be dialled — a hit is the regression.
fn notation_variants(port: u16) -> Vec<String> {
    vec![
        format!("http://front.test@127.0.0.1:{port}/v1"),
        format!("http://front.test:x@0x7f000001:{port}/v1"),
        format!("http://2130706433:{port}/v1"),
        format!("HTTP://0177.0.0.1:{port}/v1"),
        format!("http://%31%32%37.0.0.1:{port}/v1"),
        format!("http://127.0.0.1.:{port}/v1"),
        format!("http:\\\\127.0.0.1:{port}/v1"),
        format!("http://\u{2460}\u{2461}\u{2466}.0.0.1:{port}/v1"),
        format!("http://[::ffff:0:7f00:1]:{port}/v1"),
        format!("http://[::ffff:7f00:1]:{port}/v1"),
        format!("http://0.0.0.0:{port}/v1"),
        format!("http://[::]:{port}/v1"),
    ]
}

#[tokio::test]
async fn address_notation_variants_are_refused_and_never_dialled() {
    let (port, hits) = mock().await;
    for base in notation_variants(port) {
        let report = default_policy(ScriptedLookup::new(&[&["93.184.216.34"]]))
            .probe(&target(base.clone(), ProbeCredential::Bearer(GOOD.into())))
            .await;
        assert_eq!(
            report.reason.as_deref(),
            Some(EGRESS_DENIED_REASON),
            "{base}: {report:?}"
        );
        assert_eq!(report.http_status, None, "{base}");
    }
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "a notation variant was dialled"
    );
}

#[tokio::test]
async fn a_redirect_to_an_internal_address_is_not_followed() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (internal_port, hits) = mock().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nlocation: http://127.0.0.1:{internal_port}/openai/v1/models\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    let report = opted_in(&["front.internal"])
        .probe(&target(
            format!("http://front.internal:{port}/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(report.reason.as_deref(), Some("provider_status_307"));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// throttle key + cache
// ---------------------------------------------------------------------------

#[test]
fn the_cache_key_changes_with_the_key_and_never_contains_it() {
    let a = target(
        "https://api.openai.com/v1".into(),
        ProbeCredential::Bearer(GOOD.into()),
    );
    let b = target(
        "https://api.openai.com/v1".into(),
        ProbeCredential::Bearer(BAD.into()),
    );
    let c = target(
        "https://api.openai.com/v1".into(),
        ProbeCredential::AnthropicKey(GOOD.into()),
    );
    assert_ne!(a.cache_key(0), b.cache_key(0));
    assert_ne!(a.cache_key(0), c.cache_key(0));
    assert_ne!(a.cache_key(0), a.cache_key(1));
    assert!(!a.cache_key(0).contains(GOOD));
    assert!(!format!("{a:?}").contains(GOOD));
}

#[test]
fn the_cache_serves_inside_its_ttl_only() {
    let report = ProbeReport::failed(ProbeMethod::Models, ProbeOutcome::Unreachable, "x");
    let fresh = ProbeCache::new(Duration::from_secs(60));
    fresh.put("k".into(), 42, report.clone());
    assert_eq!(fresh.get("k"), Some((42, report.clone())));
    assert_eq!(fresh.get("other"), None);

    let expired = ProbeCache::new(Duration::ZERO);
    expired.put("k".into(), 42, report);
    assert_eq!(expired.get("k"), None);
}

// ---------------------------------------------------------------------------
// review follow-ups (#2972): time bounds and the OpenRouter trailing dot
// ---------------------------------------------------------------------------

/// A resolver that takes `delay` to answer.
struct SlowLookup {
    delay: Duration,
}

impl HostLookup for SlowLookup {
    fn lookup(
        &self,
        _host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Ok(vec!["93.184.216.34".parse().unwrap()])
        })
    }
}

/// Review M1: the pre-request lookup is inside the hop's budget. Before the
/// fix this took the full 6 s of the lookup.
#[tokio::test]
async fn a_slow_dns_lookup_is_bounded_by_the_probe_timeout() {
    let probe = GuardedProviderProbe::with_lookup(
        EgressPolicy::default(),
        Arc::new(SlowLookup {
            delay: Duration::from_secs(6),
        }),
        Duration::from_millis(500),
    );
    let started = Instant::now();
    let report = probe
        .probe(&target(
            "https://slow-dns.example/v1".into(),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
    assert_eq!(report.outcome, ProbeOutcome::Unreachable);
    assert_eq!(report.reason.as_deref(), Some(UNREACHABLE_REASON));
}

/// Review nit 3: a body that stalls past the timeout is unreachable
/// (fall_over), not an invalid shape.
#[tokio::test]
async fn a_stalled_body_is_unreachable() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{\"data\":")
                .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    let probe = GuardedProviderProbe::with_lookup(
        EgressPolicy {
            allow_local: true,
            local_hosts: Vec::new(),
            operator_hosts: Vec::new(),
        },
        ScriptedLookup::new(&[&["127.0.0.1"]]),
        Duration::from_millis(500),
    );
    let report = probe
        .probe(&target(
            format!("http://127.0.0.1:{port}/v1"),
            ProbeCredential::Bearer(GOOD.into()),
        ))
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Unreachable, "{report:?}");
    assert_eq!(report.reason.as_deref(), Some(UNREACHABLE_REASON));
}

/// Review nit 1: `openrouter.ai.` is OpenRouter, so it is checked on `/key`.
#[tokio::test]
async fn openrouter_with_a_trailing_dot_is_still_checked_on_key() {
    let (port, _) = mock().await;
    let report = opted_in(&["openrouter.ai"])
        .probe(&target(
            format!("http://openrouter.ai.:{port}/api/v1"),
            ProbeCredential::Bearer(BAD.into()),
        ))
        .await;
    assert_eq!(report.method, ProbeMethod::Key, "{report:?}");
    assert_eq!(report.outcome, ProbeOutcome::Rejected, "{report:?}");
}
