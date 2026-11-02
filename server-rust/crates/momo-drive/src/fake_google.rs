//! A recording stand-in for Google Drive's `files.get?alt=media`, on 127.0.0.1.
//! Compiled for this crate's tests only.
//!
//! It exists so [`crate::google::GoogleDriveArchive::file_range`] is proved
//! against **bytes that really cross a socket** — what the upstream was sent
//! (`Range` exactly as it arrived), what it answered (206, 416, a total that
//! disagrees, a body that stalls) and what the archive made of it — without a
//! credential and without leaving the loopback. Hand-rolled over `tokio::net`
//! rather than a framework: `momo-drive` has no HTTP-server dependency by
//! contract (`the_archive_has_no_database_dependency` reads the manifest).
//!
//! One request per connection (`Connection: close`), so the client's pool never
//! reuses a socket the script has already finished with.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// What one request looked like when it reached the stand-in.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub path_and_query: String,
    /// Every `Range` header, verbatim and in order. Empty when there was none.
    pub ranges: Vec<String>,
    pub authorization: Option<String>,
}

/// How the stand-in misbehaves. `Behavior::default()` is an honest Drive.
#[derive(Debug, Clone, Default)]
pub(crate) struct Behavior {
    /// The total a 206's `Content-Range` claims instead of the object's length.
    pub claimed_total: Option<u64>,
    /// Answer 200 with the whole object whatever `Range` says.
    pub ignore_range: bool,
    /// Answer this status with an empty body instead of the object.
    pub status: Option<u16>,
    /// Send the body `.0` bytes at a time with `.1` of silence between the pieces.
    pub pace: Option<(usize, Duration)>,
    /// Send this many body bytes and then go silent with the connection open.
    pub stall_after: Option<usize>,
    /// A 206 whose `Content-Range` names other bytes than the ones asked for.
    pub wrong_span: bool,
    /// A 206 whose `Content-Range` total is `*`.
    pub unknown_total: bool,
    /// Accept the request and stay silent this long before sending any header.
    pub delay_headers: Option<Duration>,
    /// Answer a request for the whole object (`bytes=0-<last byte or more>`) with
    /// a plain `200` and the whole body, as RFC 9110 lets a server do. Every other
    /// range still gets an honest `206`.
    pub full_range_as_200: bool,
    /// Leave `Content-Length` off a `200` (the body then ends when the connection
    /// closes), so a client has nothing to check the body's length against.
    pub omit_content_length: bool,
}

pub(crate) struct FakeGoogle {
    /// `http://127.0.0.1:<port>/drive/v3` — what `GoogleDriveArchive` is pointed at.
    pub api_base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeGoogle {
    pub(crate) fn requests(&self) -> Vec<Seen> {
        self.seen.lock().expect("the log is never poisoned").clone()
    }
}

/// Serve `object` (every file id answers with it) until the runtime ends.
pub(crate) async fn serve(object: Vec<u8>, behavior: Behavior) -> FakeGoogle {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the stand-in");
    let address: SocketAddr = listener.local_addr().expect("stand-in address");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let object = Arc::new(object);
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(handle(
                socket,
                object.clone(),
                behavior.clone(),
                log.clone(),
            ));
        }
    });
    FakeGoogle {
        api_base: format!("http://{address}/drive/v3"),
        seen,
    }
}

async fn handle(
    mut socket: TcpStream,
    object: Arc<Vec<u8>>,
    behavior: Behavior,
    log: Arc<Mutex<Vec<Seen>>>,
) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // The request has no body (a GET), so the head is everything. One byte at a
    // time is slow and exactly right for a test double.
    while !head.ends_with(b"\r\n\r\n") {
        match socket.read(&mut byte).await {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
        if head.len() > 16 * 1024 {
            return;
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let path_and_query = request_line
        .split(' ')
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let mut ranges = Vec::new();
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "range" => ranges.push(value.trim().to_string()),
            "authorization" => authorization = Some(value.trim().to_string()),
            _ => {}
        }
    }
    log.lock().expect("the log is never poisoned").push(Seen {
        path_and_query,
        ranges: ranges.clone(),
        authorization,
    });

    if let Some(delay) = behavior.delay_headers {
        // Silent, and not closed: the client has to notice on its own.
        tokio::time::sleep(delay).await;
    }
    let len = object.len() as u64;
    if let Some(status) = behavior.status {
        let _ = socket
            .write_all(
                format!(
                    "HTTP/1.1 {status} Stand-in\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
        return;
    }
    let asked = (!behavior.ignore_range && ranges.len() == 1)
        .then(|| single_range(&ranges[0]))
        .flatten();
    // A request for the whole object is answered like a request with no range.
    let asked = asked.filter(|&(first, last)| {
        !(behavior.full_range_as_200 && first == 0 && last >= len.saturating_sub(1))
    });
    let (head, body): (String, &[u8]) = match asked {
        None => {
            let length = if behavior.omit_content_length {
                String::new()
            } else {
                format!("Content-Length: {len}\r\n")
            };
            (
                format!("HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n"),
                &object[..],
            )
        }
        Some((first, _)) if first >= len => (
            format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            &[],
        ),
        Some((first, last)) => {
            let last = last.min(len - 1);
            let total = if behavior.unknown_total {
                "*".to_string()
            } else {
                behavior.claimed_total.unwrap_or(len).to_string()
            };
            let (shown_first, shown_last) = if behavior.wrong_span {
                (first + 1, last + 1)
            } else {
                (first, last)
            };
            (
                format!(
                    "HTTP/1.1 206 Partial Content\r\n\
                     Content-Range: bytes {shown_first}-{shown_last}/{total}\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    last - first + 1
                ),
                &object[first as usize..=last as usize],
            )
        }
    };
    if socket.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let mut sent = 0usize;
    while sent < body.len() {
        let mut piece = behavior.pace.map_or(body.len() - sent, |(size, _)| size);
        if let Some(limit) = behavior.stall_after {
            if sent >= limit {
                // Silent, and not closed: the client has to notice on its own.
                tokio::time::sleep(Duration::from_secs(3600)).await;
                return;
            }
            piece = piece.min(limit - sent);
        }
        let end = (sent + piece).min(body.len());
        if socket.write_all(&body[sent..end]).await.is_err() {
            return;
        }
        let _ = socket.flush().await;
        sent = end;
        if let Some((_, gap)) = behavior.pace {
            if sent < body.len() {
                tokio::time::sleep(gap).await;
            }
        }
    }
    if behavior
        .stall_after
        .is_some_and(|limit| limit >= body.len())
    {
        return;
    }
    let _ = socket.shutdown().await;
}

/// `bytes=<first>-<last>` and nothing else — the only shape the archive may send.
fn single_range(value: &str) -> Option<(u64, u64)> {
    let (first, last) = value.strip_prefix("bytes=")?.split_once('-')?;
    Some((first.parse().ok()?, last.parse().ok()?))
}
