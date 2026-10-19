//! #4079 / ADR-0203 증보 L4 — the login relay client, driven through the real guarded client against a
//! loopback stub that records every request it receives.

use super::*;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Mutex;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

const KEY: &str = "relay-key-4079-0123456789abcdef0123456789";
const OPERATOR: &str = "5b0c9c1e-0d62-4a6e-9a43-2f4c1c1d6a11";
const LOGIN_ID: &str = "Zk3tq8PzL1mVx0aB7cD9eF2gH4iJ6kLm";
const CODE_MARKER: &str = "MARKER-CODE-4079-aaaa";

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

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    authorization: String,
    operator: Option<String>,
    body: String,
}

type Script = Arc<dyn Fn(&str, &str) -> (u16, String) + Send + Sync>;

#[derive(Clone)]
struct Stub {
    seen: Arc<Mutex<Vec<Seen>>>,
    script: Script,
}

impl Stub {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

async fn handle(
    State(stub): State<Stub>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    stub.seen.lock().unwrap().push(Seen {
        method: method.to_string(),
        path: uri.path().to_string(),
        authorization: header("authorization").unwrap_or_default(),
        operator: header("x-operator"),
        body: String::from_utf8_lossy(&body).to_string(),
    });
    let (status, text) = (stub.script)(method.as_str(), uri.path());
    (
        StatusCode::from_u16(status).unwrap(),
        [("content-type", "application/json")],
        text,
    )
        .into_response()
}

async fn stub(script: impl Fn(&str, &str) -> (u16, String) + Send + Sync + 'static) -> (u16, Stub) {
    let stub = Stub {
        seen: Arc::default(),
        script: Arc::new(script),
    };
    let app = Router::new().fallback(handle).with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, stub)
}

fn loopback_client() -> GuardedLoginRelay {
    GuardedLoginRelay::new(
        EgressPolicy {
            allow_local: true,
            local_hosts: Vec::new(),
            operator_hosts: Vec::new(),
        },
        Duration::from_secs(5),
    )
}

fn target(port: u16) -> RelayTarget {
    RelayTarget {
        base_url: format!("http://127.0.0.1:{port}"),
        key: KEY.to_string(),
    }
}

fn start_ok() -> String {
    serde_json::json!({
        "login_id": LOGIN_ID,
        "mode": "device",
        "url": "https://auth.openai.com/codex/device",
        "user_code": "ABCD-12345",
        "expires_at": 1_900_000_000_i64,
    })
    .to_string()
}

#[tokio::test]
async fn start_sends_exactly_one_post_with_the_key_and_a_fixed_body() {
    let (port, seen) = stub(|_, _| (200, start_ok())).await;
    let reply = loopback_client()
        .start(&target(port), RelayKind::Provider, "openai-codex", OPERATOR)
        .await
        .unwrap();
    assert_eq!(
        (
            reply.login_id.as_str(),
            reply.mode,
            reply.user_code.as_deref()
        ),
        (LOGIN_ID, RelayMode::Device, Some("ABCD-12345"))
    );
    let seen = seen.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/v1/login")
    );
    assert_eq!(seen[0].authorization, format!("Bearer {KEY}"));
    assert_eq!(
        seen[0].operator, None,
        "the start body carries the operator, not the header"
    );
    let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"kind": "provider", "target": "openai-codex", "operator": OPERATOR})
    );
    // The reply never prints the screen-only values.
    let printed = format!("{reply:?}");
    assert!(
        !printed.contains("ABCD-12345") && !printed.contains("auth.openai.com"),
        "{printed}"
    );
}

#[tokio::test]
async fn complete_forwards_the_pasted_value_once_and_it_prints_nowhere_else() {
    let (port, seen) = stub(|_, _| (200, r#"{"status":"submitted"}"#.to_string())).await;
    let pasted = Pasted::new(format!("{CODE_MARKER}#STATE123"));
    assert!(!format!("{pasted:?}").contains(CODE_MARKER));
    assert!(!serde_json::to_string(&pasted)
        .unwrap()
        .contains(CODE_MARKER));
    let reply = loopback_client()
        .complete(&target(port), LOGIN_ID, OPERATOR, &pasted)
        .await
        .unwrap();
    assert_eq!(
        reply,
        StatusReply {
            status: "submitted",
            reason: None
        }
    );
    let seen = seen.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", format!("/v1/login/{LOGIN_ID}/complete").as_str())
    );
    assert_eq!(seen[0].operator.as_deref(), Some(OPERATOR));
    let body: serde_json::Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"pasted": format!("{CODE_MARKER}#STATE123")})
    );
}

#[test]
fn pasted_shape_check_keeps_the_sidecar_stdin_one_line() {
    for ok in [
        "code#state",
        "http://127.0.0.1:27890/cb?code=c&state=s",
        &"a".repeat(2048),
    ] {
        assert!(Pasted::new(ok).is_well_formed(), "{ok}");
    }
    for bad in [
        "",
        "a\nb",
        "a\rb",
        "a\0b",
        "a\tb",
        "한글",
        &"a".repeat(2049),
        "trailing\n",
    ] {
        assert!(!Pasted::new(bad).is_well_formed(), "{bad:?}");
    }
}

#[tokio::test]
async fn poll_cancel_and_status_use_their_fixed_routes_and_the_operator_header() {
    let (port, seen) = stub(|method, path| match (method, path) {
        ("GET", "/v1/status") => (
            200,
            serde_json::json!({"targets": [
                {"kind": "provider", "target": "openai-codex", "connected": true},
                {"kind": "mcp", "target": "gmail", "connected": false},
            ]})
            .to_string(),
        ),
        ("DELETE", _) => (200, r#"{"status":"cancelled"}"#.to_string()),
        _ => (
            200,
            r#"{"status":"failed","reason":"vendor_denied"}"#.to_string(),
        ),
    })
    .await;
    let client = loopback_client();
    let t = target(port);
    assert_eq!(
        client.poll(&t, LOGIN_ID, OPERATOR).await.unwrap(),
        StatusReply {
            status: "failed",
            reason: Some("vendor_denied")
        }
    );
    assert_eq!(
        client.cancel(&t, LOGIN_ID, OPERATOR).await.unwrap().status,
        "cancelled"
    );
    let list = client.status(&t).await.unwrap();
    assert_eq!(
        list,
        vec![
            TargetStatus {
                kind: RelayKind::Provider,
                target: "openai-codex".into(),
                connected: true,
                estimate: None,
            },
            TargetStatus {
                kind: RelayKind::Mcp,
                target: "gmail".into(),
                connected: false,
                estimate: None,
            },
        ]
    );
    let seen = seen.seen();
    let routes: Vec<_> = seen
        .iter()
        .map(|s| (s.method.as_str(), s.path.as_str(), s.operator.is_some()))
        .collect();
    assert_eq!(
        routes,
        vec![
            ("GET", format!("/v1/login/{LOGIN_ID}").as_str(), true),
            ("DELETE", format!("/v1/login/{LOGIN_ID}").as_str(), true),
            ("GET", "/v1/status", false),
        ]
    );
    assert!(seen
        .iter()
        .all(|s| s.authorization == format!("Bearer {KEY}")));
}

#[tokio::test]
async fn a_refusal_keeps_the_sidecar_code_inside_its_vocabulary_and_drops_the_text() {
    let (port, _seen) = stub(|_, path| {
        if path == "/v1/login" {
            (409, r#"{"error":"login_in_progress"}"#.to_string())
        } else {
            (400, format!(r#"{{"error":"echo {CODE_MARKER} {KEY}"}}"#))
        }
    })
    .await;
    let client = loopback_client();
    let t = target(port);
    assert_eq!(
        client
            .start(&t, RelayKind::Mcp, "gmail", OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::Refused {
            status: 409,
            code: "login_in_progress"
        }
    );
    let err = client
        .complete(&t, LOGIN_ID, OPERATOR, &Pasted::new("c#s"))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        RelayFailure::Refused {
            status: 400,
            code: "relay_error"
        }
    );
    let printed = format!("{err:?} {}", err.code());
    assert!(
        !printed.contains(CODE_MARKER) && !printed.contains(KEY),
        "{printed}"
    );
}

#[tokio::test]
async fn shapes_the_sidecar_does_not_document_are_a_bad_response() {
    for (name, reply) in [
        (
            "javascript url",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "javascript:alert(1)", "expires_at": 1}),
        ),
        (
            "provider url on another host",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "https://evil.example/oauth/authorize", "expires_at": 1}),
        ),
        (
            "provider url with a port",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "https://claude.ai:8443/x", "expires_at": 1}),
        ),
        (
            "tab smuggled into the host",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "https://claude.ai/x\t.evil.example", "expires_at": 1}),
        ),
        (
            "loopback http without the harness flag",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "http://127.0.0.1:9300/authorize", "expires_at": 1}),
        ),
        (
            "http remote url",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "http://evil.example/x", "expires_at": 1}),
        ),
        (
            "userinfo url",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "https://claude.ai@evil.example/x", "expires_at": 1}),
        ),
        (
            "device without a code",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "device", "url": "https://auth.openai.com/codex/device", "expires_at": 1}),
        ),
        (
            "paste with a code",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": "https://claude.ai/x", "user_code": "AB-12", "expires_at": 1}),
        ),
        (
            "newline in the code",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "device", "url": "https://auth.openai.com/x", "user_code": "AB\n12", "expires_at": 1}),
        ),
        (
            "path-like login id",
            serde_json::json!({"login_id": "../../v1/status0000", "mode": "paste", "url": "https://claude.ai/x", "expires_at": 1}),
        ),
        (
            "unknown mode",
            serde_json::json!({"login_id": LOGIN_ID, "mode": "weird", "url": "https://claude.ai/x", "expires_at": 1}),
        ),
    ] {
        let text = reply.to_string();
        let (port, _seen) = stub(move |_, _| (200, text.clone())).await;
        let err = loopback_client()
            .start(&target(port), RelayKind::Provider, "anthropic", OPERATOR)
            .await
            .unwrap_err();
        assert_eq!(err, RelayFailure::BadResponse, "{name}");
    }
    let (port, _seen) = stub(|_, _| (200, "not json".to_string())).await;
    assert_eq!(
        loopback_client()
            .poll(&target(port), LOGIN_ID, OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::BadResponse
    );
    let (port, _seen) = stub(|_, _| (200, r#"{"status":"mystery"}"#.to_string())).await;
    assert_eq!(
        loopback_client()
            .poll(&target(port), LOGIN_ID, OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::BadResponse
    );
}

#[tokio::test]
async fn an_app_login_may_use_any_https_host_and_a_loopback_mock_only_with_the_harness_flag() {
    let reply = |url: &str| {
        serde_json::json!({"login_id": LOGIN_ID, "mode": "paste", "url": url, "expires_at": 1})
            .to_string()
    };
    let (port, _seen) = stub({
        let body = reply("https://accounts.google.com/o/oauth2/v2/auth?state=S");
        move |_, _| (200, body.clone())
    })
    .await;
    let got = loopback_client()
        .start(&target(port), RelayKind::Mcp, "gmail", OPERATOR)
        .await
        .unwrap();
    assert_eq!(
        got.url,
        "https://accounts.google.com/o/oauth2/v2/auth?state=S"
    );
    let (port, _seen) = stub({
        let body = reply("http://127.0.0.1:9300/authorize?state=S");
        move |_, _| (200, body.clone())
    })
    .await;
    let refused = loopback_client()
        .start(&target(port), RelayKind::Mcp, "mock", OPERATOR)
        .await
        .unwrap_err();
    assert_eq!(refused, RelayFailure::BadResponse);
    let harness = loopback_client().with_loopback_http_urls(true);
    assert!(harness
        .start(&target(port), RelayKind::Mcp, "mock", OPERATOR)
        .await
        .is_ok());
    // …but never for a provider login.
    assert_eq!(
        harness
            .start(&target(port), RelayKind::Provider, "anthropic", OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::BadResponse
    );
}

#[tokio::test]
async fn nothing_the_caller_controls_can_reshape_the_request_path() {
    let (port, seen) = stub(|_, _| (200, start_ok())).await;
    let client = loopback_client();
    let t = target(port);
    for id in [
        "../x",
        "a/b",
        "short",
        &"x".repeat(65),
        "has space 0123456789",
        "id\n0123456789abcdef",
    ] {
        assert_eq!(
            client.poll(&t, id, OPERATOR).await.unwrap_err(),
            RelayFailure::Invalid,
            "{id:?}"
        );
        assert_eq!(
            client.cancel(&t, id, OPERATOR).await.unwrap_err(),
            RelayFailure::Invalid,
            "{id:?}"
        );
    }
    for name in ["../x", "-rf", "A", "a b", "", &"a".repeat(65)] {
        assert_eq!(
            client
                .start(&t, RelayKind::Mcp, name, OPERATOR)
                .await
                .unwrap_err(),
            RelayFailure::Invalid,
            "{name:?}"
        );
    }
    for operator in ["", "a b", "x\ny", &"o".repeat(129)] {
        assert_eq!(
            client.poll(&t, LOGIN_ID, operator).await.unwrap_err(),
            RelayFailure::Invalid,
            "{operator:?}"
        );
    }
    assert_eq!(
        client
            .complete(&t, LOGIN_ID, OPERATOR, &Pasted::new("a\nb"))
            .await
            .unwrap_err(),
        RelayFailure::Invalid
    );
    assert!(seen.seen().is_empty(), "nothing was sent for any of them");
}

#[tokio::test]
async fn only_a_bare_origin_is_dialled_and_the_public_policy_refuses_loopback() {
    let (port, seen) = stub(|_, _| (200, start_ok())).await;
    let client = loopback_client();
    for base in [
        format!("http://127.0.0.1:{port}/v1"),
        format!("http://user:pw@127.0.0.1:{port}"),
        format!("http://127.0.0.1:{port}?x=1"),
        format!("http://127.0.0.1:{port}#f"),
        format!("ftp://127.0.0.1:{port}"),
        "not a url".to_string(),
    ] {
        let t = RelayTarget {
            base_url: base.clone(),
            key: KEY.to_string(),
        };
        assert_eq!(
            client.poll(&t, LOGIN_ID, OPERATOR).await.unwrap_err(),
            RelayFailure::Invalid,
            "{base}"
        );
    }
    assert!(seen.seen().is_empty());
    // The default policy (public addresses only) refuses a loopback relay before connecting.
    let strict = GuardedLoginRelay::new(EgressPolicy::default(), Duration::from_secs(5));
    assert_eq!(
        strict
            .poll(&target(port), LOGIN_ID, OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::EgressDenied
    );
    // An exact-match operator host opts the relay host in, and only that host.
    let operator_host = GuardedLoginRelay::new(
        EgressPolicy::default().with_operator_base_url(&format!("http://127.0.0.1:{port}")),
        Duration::from_secs(5),
    );
    // dialled (the stub answers with a start body, which is not a status: BadResponse, not EgressDenied)
    assert_eq!(
        operator_host
            .poll(&target(port), LOGIN_ID, OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::BadResponse
    );
    let dns_to_private = GuardedLoginRelay::with_lookup(
        EgressPolicy::default(),
        Arc::new(FixedLookup(vec!["10.0.0.5".parse().unwrap()])),
        Duration::from_secs(5),
    );
    let t = RelayTarget {
        base_url: "http://relay.example:8643".into(),
        key: KEY.into(),
    };
    assert_eq!(
        dns_to_private
            .poll(&t, LOGIN_ID, OPERATOR)
            .await
            .unwrap_err(),
        RelayFailure::EgressDenied
    );
}

#[tokio::test]
async fn a_redirect_is_not_followed_and_a_dead_port_is_unreachable() {
    let (port, seen) = stub(|_, path| {
        if path == "/v1/status" {
            (302, String::new())
        } else {
            (200, "{}".to_string())
        }
    })
    .await;
    let err = loopback_client().status(&target(port)).await.unwrap_err();
    assert_eq!(err, RelayFailure::BadResponse);
    assert_eq!(seen.seen().len(), 1);
    let closed = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    assert_eq!(
        loopback_client().status(&target(closed)).await.unwrap_err(),
        RelayFailure::Unreachable
    );
}

#[test]
fn the_key_never_prints() {
    let t = RelayTarget {
        base_url: "http://x".into(),
        key: KEY.into(),
    };
    assert!(!format!("{t:?}").contains(KEY));
}

#[test]
fn an_estimate_is_read_defensively_and_never_fails_the_answer() {
    use crate::{parse_estimate, EstimateBasis, LoginEstimate};
    use serde_json::json;
    let ok = json!({"basis": "relay_observed_login", "issuedAt": 1_760_000_000});
    assert_eq!(
        parse_estimate(Some(&ok)),
        Some(LoginEstimate {
            basis: EstimateBasis::RelayObservedLogin,
            issued_at: Some(1_760_000_000)
        })
    );
    assert_eq!(
        parse_estimate(Some(&json!({"basis": "none"}))),
        Some(LoginEstimate {
            basis: EstimateBasis::None,
            issued_at: None
        })
    );
    // absent, wrong type, unknown basis, missing/negative/future/float/string reading: all degrade to None
    for bad in [
        json!("x"),
        json!(null),
        json!([1]),
        json!({"basis": "token_leak", "issuedAt": 1_760_000_000}),
        json!({"basis": "token_file_mtime"}),
        json!({"basis": "token_file_mtime", "issuedAt": -5}),
        json!({"basis": "token_file_mtime", "issuedAt": 9_999_999_999_999_i64}),
        json!({"basis": "token_file_mtime", "issuedAt": "1760000000"}),
        json!({"basis": "token_file_mtime", "issuedAt": 1.5}),
        json!({"basis": 7, "issuedAt": 1_760_000_000}),
    ] {
        assert_eq!(parse_estimate(Some(&bad)), None, "{bad}");
    }
    assert_eq!(parse_estimate(None), None);
}

#[tokio::test]
async fn a_garbled_estimate_on_a_connected_app_leaves_the_connected_fact_alone() {
    let (port, _seen) = stub(|_, _| {
        (
            200,
            r#"{"targets":[
                {"kind":"mcp","target":"gmail","connected":true,"estimated":{"basis":"relay_observed_login","issuedAt":1760000000}},
                {"kind":"mcp","target":"google_drive","connected":true,"estimated":{"basis":"<script>","issuedAt":1}},
                {"kind":"mcp","target":"google_calendar","connected":false,"estimated":{"basis":"none"}},
                {"kind":"provider","target":"anthropic","connected":true,"estimated":{"basis":"none"}}
            ]}"#
            .to_string(),
        )
    })
    .await;
    let client = loopback_client();
    let t = target(port);
    let list = client.status(&t).await.unwrap();
    let by = |name: &str| list.iter().find(|s| s.target == name).unwrap();
    assert!(by("gmail").connected && by("gmail").estimate.is_some());
    assert!(by("google_drive").connected && by("google_drive").estimate.is_none());
    assert!(!by("google_calendar").connected && by("google_calendar").estimate.is_none());
    assert!(by("anthropic").connected && by("anthropic").estimate.is_none());
}
