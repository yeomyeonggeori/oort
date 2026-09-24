//! #2628 — the public upload PUT answers **before it reads a body** it would
//! refuse, and one address is held to a budget.
//!
//! **No database and no container.** The upload PUT never touches Postgres —
//! its authorization is the capability in the path, checked by the archive —
//! so the pool is a `connect_lazy` handle that never dials, sessions are minted
//! straight on the archive, and this file runs in every `cargo test`.
//!
//! The client is a raw HTTP/1.1 socket, because what is measured is *when* the
//! server answers: each probe sends the request head and only the first bytes
//! of a body whose `Content-Length` announces far more, then waits for a status
//! line without sending another byte. A server that reads the body before
//! deciding never answers that probe. Before #2628 the route's `Bytes`
//! extractor did exactly that — up to 100 MB held in memory per request, for
//! any token, from anyone.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `an_unknown_capability_is_refused_before_its_body_is_read` | take the body as `Bytes` again, or pull it before the session check |
//! | `an_uppercase_alias_of_a_live_capability_is_refused_and_leaves_it_live` | let the route accept uppercase hex |
//! | `what_the_headers_announce_is_refused_before_the_body` | drop `refuse_before_body` |
//! | `one_address_is_held_to_its_budget_and_answered_before_the_body` | unmount `per_ip_drive_upload` |

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use momo_drive::{DriveArchive, LocalDriveArchive, MAX_ATTACHMENT_BYTES};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

/// How long a refusal may take. Generous for a loaded CI host; a server that
/// waits for the announced body never answers at all.
const PROMPT: Duration = Duration::from_secs(5);
/// What each probe announces, and what it actually sends of it.
const ANNOUNCED: u64 = MAX_ATTACHMENT_BYTES as u64;
const SENT: usize = 64 * 1024;

struct ArchiveDir(PathBuf);

impl ArchiveDir {
    fn new() -> ArchiveDir {
        let dir = std::env::temp_dir().join(format!("oort-drive-edge-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp archive");
        ArchiveDir(dir)
    }
}

impl Drop for ArchiveDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Edge {
    address: SocketAddr,
    archive: Arc<LocalDriveArchive>,
    _dir: ArchiveDir,
}

/// Boot the real router with a local archive and the given limits, served the
/// way `main.rs` serves it (with the socket peer, which the per-IP gate falls
/// back on when there is no `X-Forwarded-For`).
async fn serve(rate_limit: RateLimitConfig) -> Edge {
    let dir = ArchiveDir::new();
    let archive = Arc::new(
        LocalDriveArchive::open(dir.0.to_str(), "http://127.0.0.1:9").expect("local archive"),
    );
    let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(250))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .expect("a lazy pool never dials");
    let state = AppState::new(
        pool,
        "drive-upload-edge-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone() as Arc<dyn DriveArchive>)
    .with_rate_limit(rate_limit);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    Edge {
        address,
        archive,
        _dir: dir,
    }
}

fn unlimited() -> RateLimitConfig {
    RateLimitConfig {
        drive_upload_per_ip_limit: 0,
        ..RateLimitConfig::default()
    }
}

async fn mint(archive: &LocalDriveArchive, mime: &str, size: i64) -> (String, String) {
    let session = archive
        .create_resumable_upload(Uuid::nil(), "edge.bin", mime, size)
        .await
        .expect("session");
    let token = session
        .upload_url
        .rsplit('/')
        .next()
        .expect("token")
        .to_string();
    (token, session.drive_file_id)
}

/// What the server said, and how long it took to say it.
#[derive(Debug)]
struct Answer {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    after: Duration,
}

/// Send a PUT head and the first `first.len()` bytes of the body, then wait
/// for the answer **without sending the rest**. `None`: nothing within
/// [`PROMPT`] — the server is waiting for the body it was promised.
async fn probe(
    address: SocketAddr,
    path: &str,
    headers: &[(&str, String)],
    first: &[u8],
) -> Option<Answer> {
    let started = Instant::now();
    let mut socket = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect");
    let mut head = format!("PUT {path} HTTP/1.1\r\nHost: {address}\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).await.expect("head");
    socket.write_all(first).await.expect("first bytes");

    let mut received = Vec::new();
    let read = tokio::time::timeout(PROMPT, async {
        let mut buffer = [0u8; 4096];
        loop {
            let n = socket.read(&mut buffer).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..n]);
            if let Some(end) = find(&received, b"\r\n\r\n") {
                let length = content_length(&received[..end]);
                if received.len() >= end + 4 + length {
                    break;
                }
            }
        }
    })
    .await;
    let after = started.elapsed();
    if read.is_err() && find(&received, b"\r\n\r\n").is_none() {
        return None;
    }
    let text = String::from_utf8_lossy(&received).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.lines();
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Some(Answer {
        status,
        headers,
        body: body.to_string(),
        after,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn content_length(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse().ok())
        .unwrap_or(0)
}

fn upload_path(token: &str) -> String {
    format!("/__momo_stub/drive/uploads/{token}")
}

fn announced(length: u64, mime: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Content-Type", mime.to_string()),
        ("Content-Length", length.to_string()),
    ]
}

async fn full_put(address: SocketAddr, token: &str, mime: &str, bytes: &[u8]) -> u16 {
    reqwest::Client::new()
        .put(format!("http://{address}{}", upload_path(token)))
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("put")
        .status()
        .as_u16()
}

/// **Red proof (#2628).** A capability the archive does not hold is refused on
/// the strength of the request head: 64 KiB of an announced 100 MB, and the
/// 404 is already back. Before the fix this probe got no answer at all — the
/// route was still collecting the other 99.9 MB.
#[tokio::test]
async fn an_unknown_capability_is_refused_before_its_body_is_read() {
    let edge = serve(unlimited()).await;
    let unknown = Uuid::new_v4().to_string();
    let answer = probe(
        edge.address,
        &upload_path(&unknown),
        &announced(ANNOUNCED, "application/octet-stream"),
        &[0u8; SENT],
    )
    .await;
    let answer = answer.unwrap_or_else(|| {
        panic!(
            "#2628: no answer within {PROMPT:?} to an unknown capability after {SENT} of an \
             announced {ANNOUNCED} bytes — the server is reading the body before it checks \
             the capability"
        )
    });
    assert_eq!(answer.status, 404, "{answer:?}");
    assert!(answer.after < PROMPT, "{answer:?}");
}

/// The route takes only the lowercase token it mints. On a case-insensitive
/// filesystem an uppercase alias would name the same session file, so it is
/// refused before the archive is asked — and the real capability stays live.
#[tokio::test]
async fn an_uppercase_alias_of_a_live_capability_is_refused_and_leaves_it_live() {
    let edge = serve(unlimited()).await;
    let (token, file_id) = mint(&edge.archive, "text/plain", 5).await;
    let alias = token.to_ascii_uppercase();
    assert_ne!(alias, token);
    let answer = probe(
        edge.address,
        &upload_path(&alias),
        &announced(5, "text/plain"),
        b"EVIL!",
    )
    .await
    .expect("an answer");
    assert_eq!(answer.status, 404, "{answer:?}");
    assert!(
        answer.body.contains("stub upload session not found"),
        "{answer:?}"
    );

    assert_eq!(
        full_put(edge.address, &token, "text/plain", b"hello").await,
        200
    );
    let metadata = edge.archive.file_metadata(&file_id).await.expect("landed");
    assert_eq!(metadata.size_bytes, 5);
}

/// What the request head announces is judged before the body: over the
/// ceiling (413), not the declared length (400), not the declared mime (400).
/// None of those refusals spends the capability.
#[tokio::test]
async fn what_the_headers_announce_is_refused_before_the_body() {
    let edge = serve(unlimited()).await;
    let (token, file_id) = mint(&edge.archive, "text/plain", 5).await;
    for (label, length, mime, expected) in [
        ("over the ceiling", ANNOUNCED + 1, "text/plain", 413),
        ("not the declared length", 6, "text/plain", 400),
        ("not the declared mime", 5, "image/png", 400),
    ] {
        let answer = probe(
            edge.address,
            &upload_path(&token),
            &announced(length, mime),
            b"h",
        )
        .await
        .unwrap_or_else(|| panic!("{label}: no answer before the body"));
        assert_eq!(answer.status, expected, "{label}: {answer:?}");
    }
    assert_eq!(
        full_put(edge.address, &token, "text/plain", b"hello").await,
        200,
        "the capability survived every refusal"
    );
    let content = edge
        .archive
        .file_content(&file_id, MAX_ATTACHMENT_BYTES)
        .await
        .expect("content");
    assert_eq!(content.size_bytes, 5);
}

/// **Red proof (#2628).** One address gets its budget and then a 429 — with
/// `Retry-After`, the standard error body, and before the body is read. Other
/// addresses keep theirs.
#[tokio::test]
async fn one_address_is_held_to_its_budget_and_answered_before_the_body() {
    let edge = serve(RateLimitConfig {
        drive_upload_per_ip_limit: 3,
        ..RateLimitConfig::default()
    })
    .await;
    let from = |ip: &str| {
        let mut headers = announced(ANNOUNCED, "application/octet-stream");
        headers.push(("X-Forwarded-For", ip.to_string()));
        headers
    };
    for attempt in 0..3 {
        let answer = probe(
            edge.address,
            &upload_path(&Uuid::new_v4().to_string()),
            &from("203.0.113.7"),
            &[0u8; SENT],
        )
        .await
        .expect("an answer");
        assert_eq!(
            answer.status, 404,
            "attempt {attempt} is within the budget: {answer:?}"
        );
    }
    let refused = probe(
        edge.address,
        &upload_path(&Uuid::new_v4().to_string()),
        &from("203.0.113.7"),
        &[0u8; SENT],
    )
    .await
    .unwrap_or_else(|| panic!("#2628: no answer to the fourth PUT from one address"));
    assert_eq!(
        refused.status, 429,
        "#2628: the fourth PUT from one address in a window must be 429: {refused:?}"
    );
    assert!(
        refused
            .headers
            .get("retry-after")
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|seconds| seconds >= 1),
        "{refused:?}"
    );
    assert!(refused.body.contains("rate limit exceeded"), "{refused:?}");

    let elsewhere = probe(
        edge.address,
        &upload_path(&Uuid::new_v4().to_string()),
        &from("203.0.113.8"),
        &[0u8; SENT],
    )
    .await
    .expect("an answer");
    assert_eq!(
        elsewhere.status, 404,
        "another address keeps its budget: {elsewhere:?}"
    );
}

/// A complete PUT from `ip` (as the edge would name it in `X-Forwarded-For`).
async fn full_put_from(address: SocketAddr, token: &str, bytes: &[u8], ip: &str) -> u16 {
    reqwest::Client::new()
        .put(format!("http://{address}{}", upload_path(token)))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .header("X-Forwarded-For", ip)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("put")
        .status()
        .as_u16()
}

async fn fake_put_from(address: SocketAddr, ip: &str) -> Answer {
    let mut headers = announced(ANNOUNCED, "application/octet-stream");
    headers.push(("X-Forwarded-For", ip.to_string()));
    probe(
        address,
        &upload_path(&Uuid::new_v4().to_string()),
        &headers,
        &[0u8; SENT],
    )
    .await
    .expect("an answer")
}

/// **Red proof (#2631 review R12).** Where every client reaches the api from
/// the edge's own address — Fly T1's TCP passthrough, a Cloudflare tunnel,
/// Railway without `X-Real-IP` — one address is the whole instance. The budget
/// is therefore spent only by capabilities the route refuses: a fake-token
/// flood turns further fakes into 429s, and a live capability from the same
/// address still lands, before and after the budget is gone, without spending
/// any of it.
#[tokio::test]
async fn a_live_capability_is_never_refused_by_the_address_budget() {
    let edge = serve(RateLimitConfig {
        drive_upload_per_ip_limit: 3,
        ..RateLimitConfig::default()
    })
    .await;
    const EDGE: &str = "203.0.113.50";

    for upload in 0..5 {
        let (token, _) = mint(&edge.archive, "application/octet-stream", 5).await;
        assert_eq!(
            full_put_from(edge.address, &token, b"hello", EDGE).await,
            200,
            "#2631: live upload {upload} from the shared address must land, and spends no budget"
        );
    }
    for attempt in 0..3 {
        let answer = fake_put_from(edge.address, EDGE).await;
        assert_eq!(
            answer.status, 404,
            "fake {attempt} spends the budget: {answer:?}"
        );
    }
    let refused = fake_put_from(edge.address, EDGE).await;
    assert_eq!(
        refused.status, 429,
        "the budget is gone for refusals: {refused:?}"
    );

    let (token, file_id) = mint(&edge.archive, "application/octet-stream", 5).await;
    assert_eq!(
        full_put_from(edge.address, &token, b"hello", EDGE).await,
        200,
        "#2631: a live capability from an address whose budget is spent must still land"
    );
    assert_eq!(
        edge.archive
            .file_metadata(&file_id)
            .await
            .expect("landed")
            .size_bytes,
        5
    );
    let still = fake_put_from(edge.address, EDGE).await;
    assert_eq!(
        still.status, 429,
        "and the next fake is still refused: {still:?}"
    );
}

/// Each public surface keeps its own budget per address (#2631 review S10):
/// spending the join budget does not refuse an upload, and spending the upload
/// budget does not refuse a join.
#[tokio::test]
async fn the_upload_budget_and_the_join_budget_are_independent() {
    let edge = serve(RateLimitConfig {
        per_ip_limit: 1,
        drive_upload_per_ip_limit: 1,
        ..RateLimitConfig::default()
    })
    .await;
    let join = |ip: &'static str| async move {
        reqwest::Client::new()
            .post(format!("http://{}/v1/join", edge.address))
            .header("X-Forwarded-For", ip)
            .json(&serde_json::json!({"code": "not-a-code"}))
            .send()
            .await
            .expect("join")
            .status()
            .as_u16()
    };

    // Address A spends its join budget; its uploads are untouched.
    assert_ne!(
        join("198.51.100.1").await,
        429,
        "the first join is within budget"
    );
    assert_eq!(join("198.51.100.1").await, 429, "the join budget is spent");
    let upload = fake_put_from(edge.address, "198.51.100.1").await;
    assert_eq!(
        upload.status, 404,
        "a spent join budget must not refuse an upload: {upload:?}"
    );

    // Address B spends its upload budget; its joins are untouched.
    let b = "198.51.100.2";
    assert_eq!(fake_put_from(edge.address, b).await.status, 404);
    assert_eq!(
        fake_put_from(edge.address, b).await.status,
        429,
        "the upload budget is spent"
    );
    assert_ne!(
        join(b).await,
        429,
        "a spent upload budget must not refuse a join"
    );
}

/// The shipped default is on. `0` is how an operator turns it off, and the
/// boot says so when they do.
#[test]
fn the_upload_budget_is_on_by_default() {
    assert_eq!(RateLimitConfig::default().drive_upload_per_ip_limit, 120);
}
