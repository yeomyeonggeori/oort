//! MOMO-605 / ADR-0133 P2 — CORS origin allowlist, over a real socket.
//!
//! **No database and no container.** The whole CORS decision happens in a
//! middleware mounted ahead of routing, so the pool is a `connect_lazy` handle
//! that never dials: `/healthz` answers 503 (it pings the DB), and that is
//! deliberate — a 503 is exactly the *error* path the contract says must still
//! carry `Access-Control-Allow-Origin`, because a browser that cannot read the
//! real status reports an opaque `NetworkError` instead (which is precisely the
//! symptom that opened this ticket).
//!
//! These are the red tests. Reverting `build_app`'s CORS branch turns the whole
//! file red; loosening the allowlist to a wildcard or echoing unknown origins
//! turns [`unknown_origin_gets_no_cors_headers_at_all`] and
//! [`a_wildcard_entry_is_refused_and_the_surface_stays_closed`] red on their own.

use std::net::SocketAddr;

use momo_server::config::CorsConfig;
use momo_server::{build_app, AppState};

const ALLOWED_ORIGIN: &str = "tauri://localhost";
/// An origin an attacker controls. Never allowlisted, in any test here.
const HOSTILE_ORIGIN: &str = "https://evil.example";

/// Boot the real router on an ephemeral port with the given allowlist value,
/// exactly as `main.rs` would for that environment. Returns the base URL.
async fn serve(cors_env: Option<&str>) -> String {
    // A lazy pool builds a handle without touching the network. Nothing in this
    // file reads or writes Postgres. The short acquire timeout is what keeps
    // this a fast test: `/healthz` is *supposed* to fail here, and the default
    // 30s acquire would make each of those deliberate 503s a 30-second wait.
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    let state = AppState::new(
        pool,
        "cors-test-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_cors(CorsConfig::parse(cors_env));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral port");
    let address: SocketAddr = listener.local_addr().expect("local addr");
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

/// Every `Access-Control-*` header on a response, lowercased. The contract is
/// stated in terms of "not a single one", so the assertions count rather than
/// probe one name at a time.
fn cors_headers(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .keys()
        .map(|name| name.as_str().to_ascii_lowercase())
        .filter(|name| name.starts_with("access-control-"))
        .collect()
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------
// A. knob unset — the shipped default must be byte-for-byte the old server
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unconfigured_server_emits_no_cors_headers_and_still_405s_options() {
    let base = serve(None).await;
    let client = reqwest::Client::new();

    // Even *with* a desktop Origin present, an unconfigured deploy says nothing.
    let response = client
        .get(format!("{base}/healthz"))
        .header("Origin", ALLOWED_ORIGIN)
        .send()
        .await
        .expect("healthz responds");
    assert_eq!(
        cors_headers(&response),
        Vec::<String>::new(),
        "an unconfigured server must not grow a single Access-Control-* header"
    );
    assert_eq!(
        header(&response, "vary"),
        None,
        "an unconfigured server must not grow a Vary header either"
    );

    // And preflight keeps its pre-MOMO-605 behaviour: no OPTIONS route exists.
    let preflight = client
        .request(reqwest::Method::OPTIONS, format!("{base}/v1/auth/login"))
        .header("Origin", ALLOWED_ORIGIN)
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .expect("options responds");
    assert_eq!(
        preflight.status(),
        405,
        "unconfigured, OPTIONS must stay the 405 it is today"
    );
}

// ---------------------------------------------------------------------------
// B. knob set — the allowlisted desktop origin, and nothing else
// ---------------------------------------------------------------------------

#[tokio::test]
async fn allowlisted_preflight_succeeds_and_advertises_the_documented_surface() {
    let base = serve(Some(ALLOWED_ORIGIN)).await;
    let response = reqwest::Client::new()
        .request(reqwest::Method::OPTIONS, format!("{base}/v1/auth/login"))
        .header("Origin", ALLOWED_ORIGIN)
        .header("Access-Control-Request-Method", "POST")
        .header(
            "Access-Control-Request-Headers",
            "authorization,content-type",
        )
        .send()
        .await
        .expect("preflight responds");

    // The bug this ticket fixes: this was a 405, so the browser never even sent
    // the login POST.
    assert_eq!(response.status(), 204, "preflight must succeed, not 405");

    let allow_origin = header(&response, "access-control-allow-origin");
    assert_eq!(
        allow_origin.as_deref(),
        Some(ALLOWED_ORIGIN),
        "the allowed origin must be echoed exactly"
    );
    assert_ne!(
        allow_origin.as_deref(),
        Some("*"),
        "a wildcard must never be produced"
    );

    let methods = header(&response, "access-control-allow-methods").expect("methods advertised");
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
        assert!(
            methods.contains(method),
            "preflight must advertise {method}; got {methods}"
        );
    }

    let headers = header(&response, "access-control-allow-headers").expect("headers advertised");
    for name in ["authorization", "content-type"] {
        assert!(
            headers.to_ascii_lowercase().contains(name),
            "preflight must advertise {name} — the client sends it on every \
             request, GET included; got {headers}"
        );
    }

    assert_eq!(
        header(&response, "access-control-max-age").as_deref(),
        Some("600")
    );
    assert_eq!(
        header(&response, "vary")
            .as_deref()
            .map(str::to_ascii_lowercase),
        Some("origin".to_string()),
        "the answer depends on Origin, so a shared cache must key on it"
    );
    // momo is bearer-only and issues no cookies: turning this on would widen the
    // blast radius of an operator's allowlist typo for nothing.
    assert_eq!(
        header(&response, "access-control-allow-credentials"),
        None,
        "Allow-Credentials must never be sent"
    );
}

#[tokio::test]
async fn allowlisted_origin_gets_the_header_even_on_an_error_response() {
    let base = serve(Some(ALLOWED_ORIGIN)).await;
    let response = reqwest::Client::new()
        .get(format!("{base}/healthz"))
        .header("Origin", ALLOWED_ORIGIN)
        .send()
        .await
        .expect("healthz responds");

    // 503: the lazy pool cannot reach Postgres. That is the point — the browser
    // must be able to READ this status instead of seeing an opaque NetworkError.
    assert_eq!(response.status(), 503);
    assert_eq!(
        header(&response, "access-control-allow-origin").as_deref(),
        Some(ALLOWED_ORIGIN)
    );
    assert_eq!(
        header(&response, "access-control-expose-headers")
            .as_deref()
            .map(str::to_ascii_lowercase),
        Some("retry-after".to_string()),
        "Retry-After rides the MOMO-300 429 and is unreadable unless exposed"
    );
}

/// THE red test. If an unknown origin ever receives a CORS header, any web page
/// on the internet can read a momo response with the user's bearer attached by a
/// compromised extension — and the wildcard ban above becomes cosmetic.
#[tokio::test]
async fn unknown_origin_gets_no_cors_headers_at_all() {
    let base = serve(Some(ALLOWED_ORIGIN)).await;
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{base}/healthz"))
        .header("Origin", HOSTILE_ORIGIN)
        .send()
        .await
        .expect("healthz responds");
    assert_eq!(
        cors_headers(&response),
        Vec::<String>::new(),
        "a non-allowlisted origin must receive no Access-Control-* header"
    );

    // ...and its preflight is not answered either: unknown origins pass through
    // exactly as if the middleware were absent (not a 403 — native clients and
    // curl must keep working).
    let preflight = client
        .request(reqwest::Method::OPTIONS, format!("{base}/v1/auth/login"))
        .header("Origin", HOSTILE_ORIGIN)
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .expect("options responds");
    assert_eq!(preflight.status(), 405);
    assert_eq!(cors_headers(&preflight), Vec::<String>::new());
}

/// A near-miss must miss. These are the shapes an operator typo actually takes.
#[tokio::test]
async fn near_miss_origins_are_not_allowlisted() {
    let base = serve(Some(ALLOWED_ORIGIN)).await;
    let client = reqwest::Client::new();
    for origin in [
        "tauri://localhost.evil.example", // suffix attack
        "http://tauri.localhost",         // the Windows origin, NOT configured here
        "tauri://localhost:1",            // a port the allowlist never named
        "https://localhost",              // same host, different scheme
        "null",                           // sandboxed iframe / file://
    ] {
        let response = client
            .get(format!("{base}/healthz"))
            .header("Origin", origin)
            .send()
            .await
            .expect("healthz responds");
        assert_eq!(
            cors_headers(&response),
            Vec::<String>::new(),
            "{origin} must not be treated as {ALLOWED_ORIGIN}"
        );
    }
}

/// Every native momo client (macOS, iOS, the work-host daemon, curl, and the
/// Centrifugo subscribe proxy) sends no `Origin`. None of them may change shape.
#[tokio::test]
async fn a_request_without_an_origin_is_untouched() {
    let base = serve(Some(ALLOWED_ORIGIN)).await;
    let response = reqwest::Client::new()
        .get(format!("{base}/healthz"))
        .send()
        .await
        .expect("healthz responds");
    assert_eq!(cors_headers(&response), Vec::<String>::new());
    assert_eq!(header(&response, "vary"), None);
}

// ---------------------------------------------------------------------------
// C. fail-closed — a wildcard must not open anything
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_wildcard_entry_is_refused_and_the_surface_stays_closed() {
    for value in ["*", "https://*.oor7.com", "null"] {
        let base = serve(Some(value)).await;
        let response = reqwest::Client::new()
            .get(format!("{base}/healthz"))
            .header("Origin", HOSTILE_ORIGIN)
            .send()
            .await
            .expect("healthz responds");
        assert_eq!(
            cors_headers(&response),
            Vec::<String>::new(),
            "MOMO_CORS_ALLOWED_ORIGINS={value} must fail CLOSED, not open"
        );
    }
}

/// A good entry beside a bad one keeps working — the bad one is dropped, not
/// promoted, and it does not take the good one down with it.
#[tokio::test]
async fn a_bad_entry_narrows_the_allowlist_without_disabling_it() {
    let base = serve(Some("https://*.evil.example, tauri://localhost")).await;
    let client = reqwest::Client::new();

    let good = client
        .get(format!("{base}/healthz"))
        .header("Origin", ALLOWED_ORIGIN)
        .send()
        .await
        .expect("healthz responds");
    assert_eq!(
        header(&good, "access-control-allow-origin").as_deref(),
        Some(ALLOWED_ORIGIN)
    );

    let bad = client
        .get(format!("{base}/healthz"))
        .header("Origin", "https://anything.evil.example")
        .send()
        .await
        .expect("healthz responds");
    assert_eq!(cors_headers(&bad), Vec::<String>::new());
}

/// Both desktop origins at once — the macOS/Linux one and the Windows/Android
/// one — because that is what the deploy will actually be configured with.
#[tokio::test]
async fn both_documented_desktop_origins_can_be_allowed_together() {
    let base = serve(Some("tauri://localhost,http://tauri.localhost")).await;
    let client = reqwest::Client::new();
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
        let response = client
            .request(reqwest::Method::OPTIONS, format!("{base}/v1/auth/login"))
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "POST")
            .send()
            .await
            .expect("preflight responds");
        assert_eq!(response.status(), 204);
        assert_eq!(
            header(&response, "access-control-allow-origin").as_deref(),
            Some(origin)
        );
    }
}
