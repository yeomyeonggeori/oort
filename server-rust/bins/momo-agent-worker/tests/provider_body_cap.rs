//! #4820 C2b review (High-1) — the real OpenAI-compatible wire never reads a provider answer past
//! [`RESPONSE_BODY_MAX_BYTES`].
//!
//! No database: a fake provider on `127.0.0.1` answers the one request each test sends to the shipped
//! `OpenAiCompatProvider` (the same `post_json` the production `WireRoutedProvider` calls for every
//! non-streamed turn, the hosted expression door's included). What it proves, and the number that
//! carries it:
//!
//! | test | what is measured | revert that makes it red |
//! |---|---|---|
//! | `a_body_exactly_at_the_limit_is_accepted_declared_or_chunked` | limit bytes pass, both framings | an off-by-one in the running total (`>` → `>=`) |
//! | `one_byte_over_the_limit_is_refused_declared_or_chunked` | limit + 1 bytes → `BodyTooLarge` | no check at all / a check that waits for the end |
//! | `a_declared_length_over_the_limit_is_refused_before_a_byte_of_the_body_is_read` | 1 GiB declared, 1 KiB sent, returns in < 5 s with the 60 s deadline untouched | no `Content-Length` pre-check |
//! | `an_endless_body_is_cut_at_the_limit_and_the_sender_with_it` | bytes the **sender** managed to write before the socket closed ≤ limit + 32 MiB, of 96 MiB it was willing to send | reading to the end (`.text()`) |
//! | `an_error_page_is_read_only_as_deep_as_its_snippet` | same for a 500 with an endless body; the snippet is still the first 300 characters | an unbounded error-body read |
//! | `a_deadline_is_told_apart_from_an_outage` | `TimedOut` vs `Unreachable`, headers-then-stall included | one variant for both |
//! | `an_ordinary_answer_is_unchanged` | a small completion parses as before | — (regression) |
//!
//! "Bytes the sender wrote" is the measure of *where the reader stopped*: the client holds what it read
//! and no more, so the sender being cut off near the limit is the same fact as the client's memory
//! staying near the limit. (Peak resident memory of the same call, measured by hand before and after,
//! is in the hand-off.)

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use momo_agent_worker::provider::{
    ChatMessage, ChatProvider, ChatRequest, OpenAiCompatProvider, ProviderEndpoint, ProviderError,
    ProviderWire, RESPONSE_BODY_MAX_BYTES,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

const LIMIT: usize = RESPONSE_BODY_MAX_BYTES;
/// What the endless sender is willing to write (8 × the limit).
const WILLING: usize = 96 * 1024 * 1024;
/// What the kernel's socket buffers on both ends may hold on top of the limit before the sender notices
/// the reader is gone (measured values are printed by the tests).
const BUFFERS_SLACK: usize = 32 * 1024 * 1024;

const HEAD: &str = r#"{"choices":[{"message":{"content":""#;
const TAIL: &str = r#""}}]}"#;

/// A valid completion of exactly `total` bytes.
fn completion_of_len(total: usize) -> String {
    let pad = total - HEAD.len() - TAIL.len();
    format!("{HEAD}{}{TAIL}", "a".repeat(pad))
}

/// What the fake provider does with the one request it gets.
#[derive(Clone, Copy)]
enum Reply {
    /// 200 with a `Content-Length` and a valid completion of exactly `total` bytes.
    Declared { total: usize },
    /// 200, `Transfer-Encoding: chunked` (no length declared), a valid completion of exactly `total` bytes.
    Chunked { total: usize },
    /// 200 declaring `declared` bytes, sends `sent` of them, then holds the connection open.
    DeclaredThenStall { declared: u64, sent: usize },
    /// 200, chunked, the start of a completion and then filler until `willing` bytes or the reader is gone.
    ChunkedEndless { willing: usize },
    /// `status`, chunked, filler until `willing` bytes or the reader is gone.
    ErrorEndless { status: u16, willing: usize },
    /// Accept, read the request, say nothing.
    Silence,
    /// 200 declaring 100 bytes, sends 10, then holds the connection open.
    StallInBody,
    /// 200 with a small, ordinary completion.
    Ordinary,
}

struct Fake {
    base_url: String,
    /// Body bytes the sender managed to write.
    written: Arc<AtomicUsize>,
    handle: JoinHandle<()>,
}

impl Fake {
    /// The sender has finished (or been cut off): how many body bytes it wrote.
    async fn written_after_it_stops(self) -> usize {
        tokio::time::timeout(Duration::from_secs(30), self.handle)
            .await
            .expect("the sender stopped once the reader was gone")
            .expect("the sender task");
        self.written.load(Ordering::SeqCst)
    }
}

async fn read_request(stream: &mut TcpStream) {
    let mut seen = Vec::new();
    let mut buf = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut buf).await.expect("read request");
        assert!(n > 0, "the client hung up before sending its request");
        seen.extend_from_slice(&buf[..n]);
        if let Some(at) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&seen[..header_end]).to_ascii_lowercase();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .map(|v| v.trim().parse().expect("content-length"))
        .unwrap_or(0);
    let mut have = seen.len() - header_end;
    while have < length {
        let n = stream.read(&mut buf).await.expect("read request body");
        assert!(n > 0, "the client hung up mid-request");
        have += n;
    }
}

async fn write_chunk(stream: &mut TcpStream, data: &[u8]) -> std::io::Result<()> {
    stream
        .write_all(format!("{:x}\r\n", data.len()).as_bytes())
        .await?;
    stream.write_all(data).await?;
    stream.write_all(b"\r\n").await
}

async fn serve(stream: &mut TcpStream, reply: Reply, written: &AtomicUsize) {
    const CHUNK: usize = 64 * 1024;
    let filler = vec![b'a'; CHUNK];
    match reply {
        Reply::Declared { total } => {
            let body = completion_of_len(total);
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            if stream.write_all(body.as_bytes()).await.is_ok() {
                written.fetch_add(body.len(), Ordering::SeqCst);
            }
        }
        Reply::Chunked { total } => {
            let body = completion_of_len(total);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n")
                .await;
            for piece in body.as_bytes().chunks(CHUNK) {
                if write_chunk(stream, piece).await.is_err() {
                    return;
                }
                written.fetch_add(piece.len(), Ordering::SeqCst);
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        }
        Reply::DeclaredThenStall { declared, sent } => {
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {declared}\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes()).await;
            if stream.write_all(&filler[..sent]).await.is_ok() {
                written.fetch_add(sent, Ordering::SeqCst);
            }
            // Hold the connection open: only the client's own refusal can end this call early.
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        Reply::ChunkedEndless { willing } => {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n")
                .await;
            if write_chunk(stream, HEAD.as_bytes()).await.is_err() {
                return;
            }
            written.fetch_add(HEAD.len(), Ordering::SeqCst);
            while written.load(Ordering::SeqCst) < willing {
                if write_chunk(stream, &filler).await.is_err() {
                    return;
                }
                written.fetch_add(CHUNK, Ordering::SeqCst);
            }
        }
        Reply::ErrorEndless { status, willing } => {
            let head = format!(
                "HTTP/1.1 {status} Internal Server Error\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes()).await;
            while written.load(Ordering::SeqCst) < willing {
                if write_chunk(stream, &filler).await.is_err() {
                    return;
                }
                written.fetch_add(CHUNK, Ordering::SeqCst);
            }
        }
        Reply::Silence => {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        Reply::StallInBody => {
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n0123456789")
                .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        Reply::Ordinary => {
            let body = r#"{"choices":[{"message":{"content":"안녕하세요"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
        }
    }
}

async fn fake(reply: Reply) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let written = Arc::new(AtomicUsize::new(0));
    let counter = written.clone();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept");
        read_request(&mut stream).await;
        serve(&mut stream, reply, &counter).await;
    });
    Fake {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        written,
        handle,
    }
}

fn endpoint(base_url: &str) -> ProviderEndpoint {
    ProviderEndpoint {
        base_url: base_url.to_string(),
        bearer: "sk-test-body-cap-0000".to_string(),
        source: "environment",
        wire: ProviderWire::ChatCompletions,
        account_id: None,
    }
}

fn request() -> ChatRequest {
    ChatRequest {
        provider: None,
        model: "hermes-agent".to_string(),
        messages: vec![ChatMessage::user("그려 줘")],
        max_tokens: Some(64),
        tools: Vec::new(),
        momo_tools: Vec::new(),
    }
}

/// One call of the shipped wire against `reply`, with a request deadline of `timeout`.
async fn call(
    reply: Reply,
    timeout: Duration,
) -> (
    Result<momo_agent_worker::provider::ChatCompletion, ProviderError>,
    Fake,
) {
    let fake = fake(reply).await;
    let provider = OpenAiCompatProvider::new(timeout).expect("client");
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        provider.complete(&endpoint(&fake.base_url), &request()),
    )
    .await
    .expect("the call returned (the limit, not the deadline, ended it)");
    (result, fake)
}

const LONG: Duration = Duration::from_secs(60);

#[tokio::test]
async fn a_body_exactly_at_the_limit_is_accepted_declared_or_chunked() {
    for reply in [
        Reply::Declared { total: LIMIT },
        Reply::Chunked { total: LIMIT },
    ] {
        let (result, _fake) = call(reply, LONG).await;
        let completion = result.expect("a body of exactly the limit is an answer");
        assert_eq!(
            completion.text.len(),
            LIMIT - HEAD.len() - TAIL.len(),
            "every byte of the answer arrived"
        );
    }
}

#[tokio::test]
async fn one_byte_over_the_limit_is_refused_declared_or_chunked() {
    for (what, reply) in [
        ("declared", Reply::Declared { total: LIMIT + 1 }),
        ("chunked", Reply::Chunked { total: LIMIT + 1 }),
    ] {
        let (result, _fake) = call(reply, LONG).await;
        assert_eq!(
            result.err(),
            Some(ProviderError::BodyTooLarge { limit: LIMIT }),
            "{what}"
        );
    }
}

#[tokio::test]
async fn a_declared_length_over_the_limit_is_refused_before_a_byte_of_the_body_is_read() {
    let started = std::time::Instant::now();
    let (result, fake) = call(
        Reply::DeclaredThenStall {
            declared: 1024 * 1024 * 1024,
            sent: 1024,
        },
        LONG,
    )
    .await;
    assert_eq!(
        result.err(),
        Some(ProviderError::BodyTooLarge { limit: LIMIT })
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "refused from the header alone, not after waiting for a body that never comes: {:?}",
        started.elapsed()
    );
    assert!(fake.written.load(Ordering::SeqCst) <= 1024);
}

#[tokio::test]
async fn an_endless_body_is_cut_at_the_limit_and_the_sender_with_it() {
    let (result, fake) = call(Reply::ChunkedEndless { willing: WILLING }, LONG).await;
    assert_eq!(
        result.err(),
        Some(ProviderError::BodyTooLarge { limit: LIMIT })
    );
    let written = fake.written_after_it_stops().await;
    eprintln!(
        "endless body: limit {LIMIT} B, sender willing {WILLING} B, sender wrote {written} B \
         ({:.1} MiB) before the socket closed",
        written as f64 / (1024.0 * 1024.0)
    );
    assert!(
        written >= LIMIT,
        "the reader took the whole limit before refusing: {written}"
    );
    assert!(
        written <= LIMIT + BUFFERS_SLACK,
        "the reader stopped at the limit instead of draining the sender: wrote {written} of {WILLING}"
    );
}

#[tokio::test]
async fn an_error_page_is_read_only_as_deep_as_its_snippet() {
    let (result, fake) = call(
        Reply::ErrorEndless {
            status: 500,
            willing: WILLING,
        },
        LONG,
    )
    .await;
    let Err(ProviderError::HttpStatus(500, snippet)) = result else {
        panic!("a 500 is a status: {result:?}");
    };
    assert_eq!(
        snippet.chars().count(),
        300,
        "the snippet is the first 300 characters"
    );
    assert!(snippet.chars().all(|c| c == 'a'));
    let written = fake.written_after_it_stops().await;
    eprintln!(
        "endless error page: sender willing {WILLING} B, wrote {written} B ({:.1} MiB) before the socket closed",
        written as f64 / (1024.0 * 1024.0)
    );
    assert!(
        written <= BUFFERS_SLACK,
        "the error body was not drained: wrote {written} of {WILLING}"
    );
}

#[tokio::test]
async fn a_deadline_is_told_apart_from_an_outage() {
    let short = Duration::from_millis(400);
    // Nothing comes back at all.
    let (result, _fake) = call(Reply::Silence, short).await;
    assert!(
        matches!(result, Err(ProviderError::TimedOut(_))),
        "silence past the deadline: {result:?}"
    );
    // The headers come and the body stalls: the deadline covers the body too.
    let (result, _fake) = call(Reply::StallInBody, short).await;
    assert!(
        matches!(result, Err(ProviderError::TimedOut(_))),
        "a body that stalls past the deadline: {result:?}"
    );
    // Nobody is listening: an outage, not a deadline.
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let provider = OpenAiCompatProvider::new(LONG).expect("client");
    let result = provider
        .complete(
            &endpoint(&format!("http://127.0.0.1:{port}/v1")),
            &request(),
        )
        .await;
    assert!(
        matches!(result, Err(ProviderError::Unreachable(_))),
        "connection refused: {result:?}"
    );
    // Both are worth another attempt; the door spends them differently.
    assert!(ProviderError::TimedOut(String::new()).is_retryable());
    assert!(ProviderError::Unreachable(String::new()).is_retryable());
}

#[tokio::test]
async fn an_ordinary_answer_is_unchanged() {
    let (result, _fake) = call(Reply::Ordinary, LONG).await;
    let completion = result.expect("an ordinary answer");
    assert_eq!(completion.text, "안녕하세요");
    let usage = completion.usage.expect("usage");
    assert_eq!((usage.prompt_tokens, usage.completion_tokens), (7, 3));
}
