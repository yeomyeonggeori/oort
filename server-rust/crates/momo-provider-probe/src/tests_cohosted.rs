//! #3883 / ADR-0203 — the co-hosted agent probe, driven through the real guarded
//! client against loopback mocks that count every request they receive.

use super::*;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;

const KEY: &str = "sk-cohost-3883-0001";

struct FixedLookup(Vec<IpAddr>);

impl HostLookup for FixedLookup {
    fn lookup(
        &self,
        _host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        let answer = self.0.clone();
        Box::pin(async move { Ok(answer) })
    }
}

#[derive(Clone, Default)]
struct Seen {
    paths: Arc<Mutex<Vec<String>>>,
    bearers: Arc<Mutex<Vec<String>>>,
}

impl Seen {
    fn record(&self, path: &str, headers: &HeaderMap) {
        self.paths.lock().unwrap().push(path.to_string());
        self.bearers.lock().unwrap().push(
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
        );
    }
    fn paths(&self) -> Vec<String> {
        self.paths.lock().unwrap().clone()
    }
}

fn echo_refusal() -> Response {
    // A hostile agent that tries to hand the key back in every channel.
    (
        StatusCode::UNAUTHORIZED,
        [("x-echo-key", KEY.to_string())],
        format!(r#"{{"error":"bad key {KEY}"}}"#),
    )
        .into_response()
}

/// A healthy co-hosted agent. `models_ok` toggles the key check outcome.
async fn agent(toolsets: Option<serde_json::Value>, key_ok: bool) -> (u16, Seen) {
    let seen = Seen::default();
    let s1 = seen.clone();
    let s2 = seen.clone();
    let s3 = seen.clone();
    let s4 = seen.clone();
    let toolsets = Arc::new(toolsets);
    let app = Router::new()
        .route(
            "/health",
            get(move |headers: HeaderMap| async move {
                s1.record("/health", &headers);
                axum::Json(serde_json::json!({"status": "ok", "secret": KEY}))
            }),
        )
        .route(
            "/v1/models",
            get(move |headers: HeaderMap| async move {
                s2.record("/v1/models", &headers);
                if !key_ok {
                    return echo_refusal();
                }
                axum::Json(serde_json::json!({
                    "object": "list",
                    "data": [{"id": "hermes-agent"}, {"id": KEY}],
                }))
                .into_response()
            }),
        )
        .route(
            "/v1/toolsets",
            get(move |headers: HeaderMap| {
                let toolsets = toolsets.clone();
                async move {
                    s3.record("/v1/toolsets", &headers);
                    match toolsets.as_ref() {
                        Some(body) => axum::Json(body.clone()).into_response(),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
            }),
        )
        // Anything else the probe might be tricked into asking for.
        .fallback(move |uri: axum::http::Uri, headers: HeaderMap| async move {
            s4.record(uri.path(), &headers);
            StatusCode::NOT_FOUND
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, seen)
}

fn opted_in() -> GuardedProviderProbe {
    GuardedProviderProbe::with_lookup(
        EgressPolicy {
            allow_local: true,
            local_hosts: Vec::new(),
            operator_hosts: Vec::new(),
        },
        Arc::new(FixedLookup(vec!["127.0.0.1".parse().unwrap()])),
        Duration::from_secs(5),
    )
}

fn target(base_url: String) -> CohostedTarget {
    CohostedTarget {
        base_url,
        bearer: KEY.to_string(),
    }
}

fn assert_no_secret(report: &CohostedReport) {
    let debug = format!("{report:?}");
    assert!(!debug.contains(KEY), "{debug}");
    assert!(!debug.contains("\"status\""), "a response body leaked");
}

#[tokio::test]
async fn it_sends_exactly_health_and_models_with_the_bearer_and_nothing_else() {
    let (port, seen) = agent(Some(serde_json::json!({"data": []})), true).await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), false)
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok, "{report:?}");
    assert_eq!(report.requests_sent, 2);
    assert_eq!(seen.paths(), vec!["/health", "/v1/models"]);
    assert_eq!(
        seen.bearers.lock().unwrap().clone(),
        vec![format!("Bearer {KEY}"); 2]
    );
    assert_eq!(report.model_count, Some(2));
    // The id that is the key is dropped; the real one is kept.
    assert_eq!(report.model_ids, vec!["hermes-agent".to_string()]);
    assert_eq!(report.toolsets, ToolsetsSignal::NotChecked);
    assert_no_secret(&report);
}

#[tokio::test]
async fn an_empty_base_path_and_a_trailing_slash_dial_the_same_two_paths() {
    for base in ["", "/", "/v1/"] {
        let (port, seen) = agent(None, true).await;
        let report = opted_in()
            .probe_cohosted(&target(format!("http://127.0.0.1:{port}{base}")), false)
            .await;
        assert_eq!(report.outcome, ProbeOutcome::Ok, "{base}: {report:?}");
        assert_eq!(seen.paths(), vec!["/health", "/v1/models"], "{base}");
    }
}

#[tokio::test]
async fn a_declared_path_other_than_v1_sends_nothing() {
    for base in ["/admin", "/v1/extra", "/v2", "/v1?x=1", "/v1#frag"] {
        let (port, seen) = agent(None, true).await;
        let report = opted_in()
            .probe_cohosted(&target(format!("http://127.0.0.1:{port}{base}")), true)
            .await;
        assert_eq!(report.requests_sent, 0, "{base}");
        assert_eq!(
            report.reason.as_deref(),
            Some(COHOSTED_BASE_PATH_UNSUPPORTED),
            "{base}"
        );
        assert!(
            seen.paths().is_empty(),
            "{base}: dialled {:?}",
            seen.paths()
        );
    }
    // Userinfo can smuggle a different host past a naive reader.
    let report = opted_in()
        .probe_cohosted(&target("http://user:pw@127.0.0.1:1/v1".into()), false)
        .await;
    assert_eq!(report.requests_sent, 0);
}

#[tokio::test]
async fn a_redirect_is_not_followed_to_another_host() {
    // The "other host": counts anything that reaches it.
    let other_hits = Arc::new(AtomicUsize::new(0));
    let oh = other_hits.clone();
    let other = Router::new().fallback(move || {
        let oh = oh.clone();
        async move {
            oh.fetch_add(1, Ordering::SeqCst);
            StatusCode::OK
        }
    });
    let other_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other_port = other_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(other_listener, other).await;
    });

    let declared_hits = Arc::new(AtomicUsize::new(0));
    let dh = declared_hits.clone();
    let location = format!("http://127.0.0.1:{other_port}/stolen");
    let app = Router::new()
        .route(
            "/health",
            get(move |State(location): State<String>| {
                let dh = dh.clone();
                async move {
                    dh.fetch_add(1, Ordering::SeqCst);
                    Redirect::temporary(&location)
                }
            }),
        )
        .with_state(location);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), true)
        .await;
    assert_eq!(
        other_hits.load(Ordering::SeqCst),
        0,
        "the redirect was followed"
    );
    assert_eq!(declared_hits.load(Ordering::SeqCst), 1);
    assert_ne!(report.outcome, ProbeOutcome::Ok, "{report:?}");
    assert_eq!(report.health_status, Some(307));
    assert_no_secret(&report);
}

#[tokio::test]
async fn a_private_address_without_an_opt_in_is_refused_before_any_request() {
    let (port, seen) = agent(None, true).await;
    // The name resolves to a private address and the policy has no opt-in.
    let probe = GuardedProviderProbe::with_lookup(
        EgressPolicy::default(),
        Arc::new(FixedLookup(vec!["10.1.2.3".parse().unwrap()])),
        Duration::from_secs(5),
    );
    let report = probe
        .probe_cohosted(
            &target(format!("http://hermes.example.test:{port}/v1")),
            true,
        )
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Unreachable);
    assert_eq!(report.reason.as_deref(), Some(EGRESS_DENIED_REASON));
    assert_eq!(report.requests_sent, 0);
    assert!(seen.paths().is_empty());
}

#[tokio::test]
async fn a_wrong_key_is_rejected_and_the_echoed_key_goes_nowhere() {
    let (port, seen) = agent(None, false).await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), false)
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Rejected, "{report:?}");
    assert_eq!(report.reason.as_deref(), Some(AUTH_FAILED_REASON));
    assert_eq!(report.models_status, Some(401));
    assert_eq!(seen.paths(), vec!["/health", "/v1/models"]);
    assert_no_secret(&report);
}

#[tokio::test]
async fn nothing_listening_is_unreachable_with_one_attempt() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), true)
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Unreachable);
    assert_eq!(
        report.requests_sent, 1,
        "no second request after a dead /health"
    );
    assert_no_secret(&report);
}

#[tokio::test]
async fn toolsets_is_a_third_request_only_when_asked_and_only_a_caution() {
    // Lists a dangerous toolset: a caution, with the fixed name only.
    let (port, seen) = agent(
        Some(serde_json::json!({"toolsets": {"terminal": {"enabled": true}, "web": {}}})),
        true,
    )
    .await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), true)
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok);
    assert_eq!(report.requests_sent, 3);
    assert_eq!(seen.paths(), vec!["/health", "/v1/models", "/v1/toolsets"]);
    assert_eq!(report.toolsets, ToolsetsSignal::Listed(vec!["terminal"]));

    // Names none of the three: still "not proof" — the type says so by name.
    let (port, _) = agent(Some(serde_json::json!(["web", "file"])), true).await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}")), true)
        .await;
    assert_eq!(report.toolsets, ToolsetsSignal::NoneListed);

    // Absent endpoint: no signal either way.
    let (port, _) = agent(None, true).await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), true)
        .await;
    assert_eq!(report.outcome, ProbeOutcome::Ok);
    assert_eq!(report.toolsets, ToolsetsSignal::Unavailable);

    // Not asked: never dialled.
    let (port, seen) = agent(Some(serde_json::json!({"terminal": 1})), true).await;
    let report = opted_in()
        .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), false)
        .await;
    assert_eq!(report.toolsets, ToolsetsSignal::NotChecked);
    assert!(!seen.paths().contains(&"/v1/toolsets".to_string()));
}

#[tokio::test]
async fn toolsets_enabled_false_is_off_and_anything_else_stays_conservative() {
    // Hermes v0.22.2 shape: a bare array, every toolset with `enabled`.
    let locked = |t: bool, b: bool, c: bool| {
        serde_json::json!([
            {"name": "browser", "enabled": b},
            {"name": "terminal", "enabled": t},
            {"name": "code_execution", "enabled": c},
            {"name": "web", "enabled": true},
            {"name": "file", "enabled": true}
        ])
    };
    let wrapped = |v: serde_json::Value| serde_json::json!({ "data": v });
    let cases = [
        (locked(false, false, false), ToolsetsSignal::NoneListed),
        (
            locked(true, false, false),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        (
            locked(false, true, true),
            ToolsetsSignal::Listed(vec!["browser", "code_execution"]),
        ),
        (
            wrapped(locked(false, false, false)),
            ToolsetsSignal::NoneListed,
        ),
        (
            wrapped(locked(false, true, false)),
            ToolsetsSignal::Listed(vec!["browser"]),
        ),
        // Missing field, string "false", null: not exactly `false` -> reported.
        (
            serde_json::json!([{"name": "terminal"}]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        (
            serde_json::json!([{"name": "terminal", "enabled": "false"}]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        (
            serde_json::json!([{"name": "terminal", "enabled": null}]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        // Bare names (no object) stay reported.
        (
            serde_json::json!(["terminal"]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        // A non-string `name` under an off object is still walked.
        (
            serde_json::json!([{"enabled": false, "name": {"terminal": {"enabled": true}}}]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        (
            serde_json::json!([{"enabled": false, "name": ["terminal"]}]),
            ToolsetsSignal::Listed(vec!["terminal"]),
        ),
        // Keyed-by-name map with an explicit off.
        (
            serde_json::json!({"toolsets": {"terminal": {"enabled": false}}}),
            ToolsetsSignal::NoneListed,
        ),
    ];
    for (body, want) in cases {
        let (port, _) = agent(Some(body.clone()), true).await;
        let report = opted_in()
            .probe_cohosted(&target(format!("http://127.0.0.1:{port}/v1")), true)
            .await;
        let mut got = report.toolsets.clone();
        if let ToolsetsSignal::Listed(v) = &mut got {
            v.sort();
        }
        assert_eq!(got, want, "{body}");
    }
}

#[test]
fn the_declared_url_is_read_the_same_way_by_the_gate_and_the_socket() {
    use super::cohosted::origin_of;
    // Plain, with a port, trailing slash, IPv6 literal and a trailing dot all
    // name one host and keep the scheme/port.
    assert_eq!(
        origin_of("http://hermes.railway.internal:8642/v1").unwrap(),
        (
            "http://hermes.railway.internal:8642".to_string(),
            "hermes.railway.internal".to_string()
        )
    );
    assert_eq!(
        origin_of("https://Hermes.Example.com/v1/").unwrap().0,
        "https://hermes.example.com"
    );
    assert_eq!(
        origin_of("http://[::1]:8642/v1").unwrap().0,
        "http://[::1]:8642"
    );
    // Userinfo, query, fragment and a foreign path are refused, not stripped.
    for bad in [
        "http://user:pw@hermes.internal:8642/v1",
        "http://user@hermes.internal:8642/v1",
        "http://hermes.internal:8642/v1?x=1",
        "http://hermes.internal:8642/v1#frag",
        "http://hermes.internal:8642/other",
        "ftp://hermes.internal/v1",
        "http://hermes.internal:8642\\@evil.example/v1",
        "http://evil.example#@hermes.internal:8642/v1",
        "",
    ] {
        assert_eq!(origin_of(bad), None, "{bad}");
    }
}
