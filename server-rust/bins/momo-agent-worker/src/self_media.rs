//! #4820 C2a — the worker's half of the photo address (ADR-0218 증보 G4·G8; owner 10-30 결정 ①).
//!
//! The co-hosted Hermes' picture tool takes its source as `image_url`, and the tool guard
//! (`infra/hermes/plugins/oort-image-guard`) lets exactly one kind of address through: this
//! instance's own `{origin}/v1/self-media/{workspace}/{token}`. This module mints that address for
//! one turn and words the one `system` line that carries it. The token and the rules behind it
//! are `momo_messaging::self_media`'s; this module owns no SQL.
//!
//! * **Per turn, never stored.** The token is minted right before the request is assembled and is
//!   only ever in the request. It is not in the `agent_job` payload, so it is not in the outbox.
//! * **Only a canonical origin.** `OORT_SELF_MEDIA_ORIGIN` is the same value the Hermes service's
//!   guard allows, in the one canonical shape both sides accept; anything else is "off".
//! * **One line, one use.** The sentence says what the address is for and when it dies. It is the
//!   only instruction C2a adds; the rest of the picture guidance is C2b's.
//!
//! ## The worker's own read of a requester's attachment (#4934, ADR-0151 증보 3)
//!
//! Railway puts the api and this worker on different services, and the `local` archive is a volume
//! only the api can mount. So the avatar proposal's source picture is read **through the api**: the
//! worker mints the same single-use token ([`momo_messaging::mint_for_attachment_in_tx`], the same
//! ownership rule, 60 seconds of life), spends it itself at `{OORT_API_INTERNAL_ORIGIN}/v1/self-media/…`
//! and gets the bytes the route proves are the declared image. The origin is deployment configuration
//! on the private network, never anything a request or a model supplies; the path is fixed, the
//! workspace is the run's, the token is the one just minted.
//!
//! * **One refusal in, one reason out.** A refused mint, a 404 and every wrong shape of answer end as a
//!   fixed reason code (`attachment_not_available`, `drive_unavailable`); no transport message is ever
//!   returned. Those messages carry the request URL, and this URL carries a credential.
//! * **Nothing about the address in a log line.** The two lines this module writes name the run and a cause
//!   (a database error, or an `Unread`, the private failure type); an `Unread` is built **already scrubbed**
//!   ([`redact_self_media_urls`]), so it cannot be logged unscrubbed by a later edit, and a source guard
//!   (`no_log_line_names_the_address_the_token_or_the_drive_id`) keeps the address, the token and the Drive
//!   id out of every `tracing` call.
//! * **Nothing followed, nothing proxied.** A redirect is an answer, not a place to go; the client
//!   ignores `HTTP(S)_PROXY`.
//! * **Exactly the declared bytes.** A body longer or shorter than the row says, or not the declared
//!   image, is refused; the read stops at the declared length plus nothing.

use std::time::Duration;

use async_trait::async_trait;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    bytes_match_mime, mint_for_attachment_in_tx, mint_for_read_in_tx, mint_for_run_in_tx,
    redact_self_media_urls, self_media_url, RequesterAttachmentUse, SELF_MEDIA_TTL_SECS,
};
use momo_workspace_actions::profile_avatar::{
    AttachmentBytes, DriveAttachmentBytes, RequesterAttachment,
};
use uuid::Uuid;

use crate::AgentWorker;

/// How long the whole read through the api may take — connect, headers and body. The proposal is one
/// step of a turn with its own deadline; a read that outlives this is "unavailable", not a long wait.
const READ_DEADLINE: Duration = Duration::from_secs(10);
/// The private network answers at once or not at all.
const CONNECT_DEADLINE: Duration = Duration::from_secs(3);

/// The line the model reads. `minutes` is the real lifetime, never a literal that could drift.
pub fn self_media_line_text(url: &str) -> String {
    format!(
        "첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, {}분 뒤 만료: {url}",
        SELF_MEDIA_TTL_SECS / 60
    )
}

impl AgentWorker {
    /// Mint the requester's photo address for this run and word the line, or `None` when there is
    /// nothing to hand over (no origin configured, no picture on the trigger message, or any rule of
    /// the mint not met). An `Err` is a database failure the caller retries.
    pub(crate) async fn self_media_line(
        &self,
        workspace_id: Uuid,
        agent_member_id: Uuid,
        run_id: Uuid,
    ) -> Result<Option<String>, DbError> {
        let Some(origin) = self.config.self_media_origin.as_deref() else {
            return Ok(None);
        };
        let grant = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                mint_for_run_in_tx(conn, workspace_id, run_id, agent_member_id).await
            })
        })
        .await?;
        Ok(grant
            .map(|grant| self_media_line_text(&self_media_url(origin, workspace_id, &grant.token))))
    }
}

/// The api's own address as the worker may dial it (`OORT_API_INTERNAL_ORIGIN`): `http://` or `https://`,
/// a lowercase DNS host (letters, digits, inner hyphens; a single label such as compose's `api` is fine, so
/// is a dotted-quad like `127.0.0.1`), an optional port of 1..=65535 without a leading zero, and **nothing
/// after it** — no userinfo, path, slash, query, fragment, whitespace, uppercase or non-ASCII. The text is
/// compared as written, so whatever merely normalizes to such an origin is not one. Anything else is "off":
/// the worker then reads attachments from its own archive configuration, as before.
///
/// The public origin the Hermes guard accepts ([`momo_messaging::canonical_origin`]) is a different value
/// with a different grammar (https only, two labels at least); this one is the private door of one process.
pub fn internal_origin(raw: &str) -> Option<&str> {
    let rest = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))?;
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if let Some(port) = port {
        if port.is_empty()
            || port.len() > 5
            || port.starts_with('0')
            || !port.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let number: u32 = port.parse().ok()?;
        if number == 0 || number > 65_535 {
            return None;
        }
    }
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    for label in host.split('.') {
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > 63 {
            return None;
        }
        if !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        {
            return None;
        }
        if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
            return None;
        }
    }
    Some(raw)
}

/// The one client attachments are read with: it follows **no redirect** (a 3xx is an answer, not a place
/// to go) and ignores `HTTP(S)_PROXY` (a proxy would resolve the private name out of our sight). `None`
/// only if the TLS backend cannot start; every read then answers "unavailable" rather than falling back
/// to a client with default redirects.
pub(crate) fn attachment_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_DEADLINE)
        .timeout(READ_DEADLINE)
        .build()
        .ok()
}

/// Why a read through the api gave nothing. Every variant is built so that **nothing it holds can carry
/// the token**: a transport message is stored only after [`redact_self_media_urls`] (so deriving `Debug`
/// is as safe as `Display`).
#[derive(Debug)]
enum Unread {
    /// The request did not complete. The transport's own message, **already scrubbed**.
    Transport(String),
    /// The api answered, but not with the picture. Its one refusal is a 404.
    Status(u16),
    /// A 200 whose body is not exactly the declared picture.
    Shape(&'static str),
}

impl Unread {
    /// The audit-grade reason (the existing proposal vocabulary): the api's one refusal is "not available",
    /// anything that is the api or the network failing is "unavailable".
    fn reason(&self) -> &'static str {
        match self {
            Unread::Status(404) => "attachment_not_available",
            Unread::Transport(_) | Unread::Status(_) | Unread::Shape(_) => "drive_unavailable",
        }
    }
}

impl std::fmt::Display for Unread {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unread::Transport(message) => write!(formatter, "transport: {message}"),
            Unread::Status(status) => write!(formatter, "status {status}"),
            Unread::Shape(what) => write!(formatter, "shape: {what}"),
        }
    }
}

fn transport(error: &reqwest::Error) -> Unread {
    Unread::Transport(redact_self_media_urls(&error.to_string()))
}

/// `GET url` and return **exactly** `declared` bytes of the declared **picture**, or why not — the
/// avatar flow's read (#4934): the answer's `Content-Type` must be one of the avatar's three picture types
/// and the bytes must start like it. `url` carries the token: it is never formatted here.
///
/// Only the tests call this spelling now (the reader always passes its use's own types to [`fetch_as`]);
/// it stays because the avatar's image-only rule is what the existing suite pins.
#[cfg(test)]
async fn fetch(client: &reqwest::Client, url: &str, declared: usize) -> Result<Vec<u8>, Unread> {
    fetch_as(
        client,
        url,
        declared,
        RequesterAttachmentUse::Avatar.mimes(),
    )
    .await
}

/// [`fetch`] for any use: the answer's `Content-Type` must be one of `allowed` **and** the bytes must be
/// what that type says ([`bytes_match_mime`]: a picture's magic, `%PDF-`, text without a NUL). The helper's
/// `read_attachment` passes [`RequesterAttachmentUse::Read`]'s types (#4970, ADR-0151 증보 4).
async fn fetch_as(
    client: &reqwest::Client,
    url: &str,
    declared: usize,
    allowed: &[&str],
) -> Result<Vec<u8>, Unread> {
    let mut response = client.get(url).send().await.map_err(|e| transport(&e))?;
    let status = response.status();
    if status != reqwest::StatusCode::OK {
        return Err(Unread::Status(status.as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if response
        .content_length()
        .is_some_and(|length| length != declared as u64)
    {
        return Err(Unread::Shape("length"));
    }
    let mut body: Vec<u8> = Vec::with_capacity(declared);
    while let Some(chunk) = response.chunk().await.map_err(|e| transport(&e))? {
        if chunk.len() > declared - body.len() {
            return Err(Unread::Shape("too_long"));
        }
        body.extend_from_slice(&chunk);
    }
    if body.len() != declared {
        return Err(Unread::Shape("too_short"));
    }
    if !content_type
        .as_deref()
        .is_some_and(|mime| allowed.contains(&mime) && bytes_match_mime(mime, &body))
    {
        return Err(Unread::Shape("not_the_declared_image"));
    }
    Ok(body)
}

/// The requester's attachment read through the api's private address (#4934).
pub struct ApiAttachmentBytes<'a> {
    pool: &'a PgPool,
    origin: &'a str,
    client: Option<&'a reqwest::Client>,
}

#[async_trait]
impl AttachmentBytes for ApiAttachmentBytes<'_> {
    async fn read(&self, attachment: &RequesterAttachment<'_>) -> Result<Vec<u8>, &'static str> {
        let Some(client) = self.client else {
            return Err("drive_unavailable");
        };
        // The row's own declared size, held to the ceiling again here: the read never asks for more.
        let Some(declared) = usize::try_from(attachment.size_bytes)
            .ok()
            .filter(|size| (1..=attachment.max_bytes).contains(size))
        else {
            return Err("attachment_not_available");
        };
        let (workspace_id, run_id, agent_id, attachment_id, usage) = (
            attachment.workspace_id,
            attachment.run_id,
            attachment.agent_id,
            attachment.attachment_id,
            attachment.usage,
        );
        let grant = with_tenant_tx(self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The mint judges the id by the **use**: the avatar flow's three pictures, or the
                // helper's `read_attachment` (also text and PDF). Both prove the requester's
                // ownership before a row is written.
                match usage {
                    RequesterAttachmentUse::Read => {
                        mint_for_read_in_tx(conn, workspace_id, run_id, agent_id, attachment_id)
                            .await
                    }
                    _ => {
                        mint_for_attachment_in_tx(
                            conn,
                            workspace_id,
                            run_id,
                            agent_id,
                            attachment_id,
                        )
                        .await
                    }
                }
            })
        })
        .await
        .map_err(|error| {
            tracing::warn!(run_id = %run_id, %error, "attachment read: the address could not be minted");
            "drive_unavailable"
        })?;
        // Not the requester's complete image in this conversation (any more): the same refusal the
        // lookup before this gave, and nothing was written.
        let Some(grant) = grant else {
            return Err("attachment_not_available");
        };
        let url = self_media_url(self.origin, workspace_id, &grant.token);
        match fetch_as(client, &url, declared, usage.mimes()).await {
            Ok(bytes) => Ok(bytes),
            Err(unread) => {
                // The cause is the scrubbed text; the url and the token are not in scope of this line.
                tracing::warn!(run_id = %run_id, cause = %unread, "attachment read through the api failed");
                Err(unread.reason())
            }
        }
    }
}

/// Where this worker's attachment reads go: the api when its private address is configured, otherwise the
/// archive the worker itself was configured with (`MOMO_DRIVE_*`), exactly as before #4934.
pub enum AttachmentReader<'a> {
    Api(ApiAttachmentBytes<'a>),
    Archive(DriveAttachmentBytes<'a>),
}

#[async_trait]
impl AttachmentBytes for AttachmentReader<'_> {
    async fn read(&self, attachment: &RequesterAttachment<'_>) -> Result<Vec<u8>, &'static str> {
        match self {
            AttachmentReader::Api(reader) => reader.read(attachment).await,
            AttachmentReader::Archive(reader) => reader.read(attachment).await,
        }
    }
}

impl AgentWorker {
    /// The reader the team AI's picture proposal uses for a requester's attachment: **one** source per
    /// deployment, chosen by configuration and never by a request.
    pub fn attachment_reader(&self) -> AttachmentReader<'_> {
        match self.config.api_internal_origin.as_deref() {
            Some(origin) => AttachmentReader::Api(ApiAttachmentBytes {
                pool: &self.pool,
                origin,
                client: self.attachment_client.as_ref(),
            }),
            None => AttachmentReader::Archive(DriveAttachmentBytes(self.drive.as_ref())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- #4934: the worker's own read through the api ---------------------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TOKEN: &str = "T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenT0k";

    fn png(len: usize) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(len, 0x42);
        bytes
    }

    /// `HTTP/1.1` answer with a Content-Length and the given content type.
    fn answer(status: &str, content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// A loopback server that answers every connection with `response` verbatim and counts them.
    async fn stub(response: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let response = response.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8192];
                    let _ = socket.read(&mut buffer).await;
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (origin, hits)
    }

    /// A loopback server that answers `200 image/png` with a chunked body that **never ends**, and counts
    /// the body bytes it managed to write.
    async fn endless_stub() -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let written = Arc::new(AtomicUsize::new(0));
        let counter = written.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let counter = counter.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8192];
                    let _ = socket.read(&mut buffer).await;
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
                    if socket.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let chunk = png(4096);
                    let frame =
                        [format!("{:x}\r\n", chunk.len()).as_bytes(), &chunk, b"\r\n"].concat();
                    while socket.write_all(&frame).await.is_ok() {
                        counter.fetch_add(chunk.len(), Ordering::SeqCst);
                        tokio::task::yield_now().await;
                    }
                });
            }
        });
        (origin, written)
    }

    fn url(origin: &str) -> String {
        self_media_url(origin, Uuid::from_u128(0x1234), TOKEN)
    }

    fn client() -> reqwest::Client {
        attachment_client().expect("the client builds")
    }

    #[test]
    fn the_internal_origin_is_a_bare_http_origin_and_nothing_else() {
        for good in [
            "http://api.railway.internal:8080",
            "http://api:8080",
            "http://127.0.0.1:8080",
            "http://api",
            "https://api.internal.example",
            "https://api.internal.example:8443",
            "http://a-b.c-d.internal:1",
            "http://api:65535",
        ] {
            assert_eq!(internal_origin(good), Some(good), "{good:?}");
        }
        for bad in [
            "",
            "api:8080",
            "ftp://api",
            "HTTP://api",
            "http://",
            "http:///api",
            "https:/api",
            "http://:8080",
            "http://api:",
            "http://api:0",
            "http://api:08080",
            "http://api:65536",
            "http://api:80a",
            "http://api:+8080",
            "http://api:8080:9",
            "http://api:8080/",
            "http://api:8080/x",
            "http://api/x",
            "http://api:8080?x=1",
            "http://api:8080#f",
            "http://user@api:8080",
            "http://user:pw@api:8080",
            "http://api@evil:8080",
            "http://API:8080",
            "http://api .internal",
            "http://api\n",
            "http://api:8080 ",
            " http://api",
            "http://api.",
            "http://.api",
            "http://a..b",
            "http://-api",
            "http://api-",
            "http://[::1]:8080",
            "http://api_x:8080",
            "http://\u{e9}.example",
            "http://api\\\\evil",
        ] {
            assert_eq!(internal_origin(bad), None, "{bad:?}");
        }
        assert_eq!(internal_origin(&format!("http://{}", "a".repeat(64))), None);
        assert_eq!(
            internal_origin(&format!("http://{}", ["a"; 130].join("."))),
            None,
            "a host over 253 bytes"
        );
    }

    #[tokio::test]
    async fn the_declared_picture_comes_back_and_nothing_else_is_taken_for_it() {
        let body = png(4096);
        let (origin, hits) = stub(answer("200 OK", "image/png", &body)).await;
        assert_eq!(fetch(&client(), &url(&origin), 4096).await.unwrap(), body);
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // every way the answer is not exactly the declared image is a refusal — and the refusal names the
        // rule that made it, so each line of `fetch` is held by a case of its own
        let chunked = |body: Vec<u8>| {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:x}\r\n",
                body.len()
            )
            .into_bytes();
            out.extend_from_slice(&body);
            out.extend_from_slice(b"\r\n0\r\n\r\n");
            out
        };
        for (what, response, reason) in [
            (
                "shorter than the row says",
                answer("200 OK", "image/png", &png(100)),
                "length",
            ),
            (
                "longer than the row says",
                answer("200 OK", "image/png", &png(5000)),
                "length",
            ),
            ("chunked and short", chunked(png(100)), "too_short"),
            ("chunked and long", chunked(png(5000)), "too_long"),
            (
                "html under a png header",
                answer("200 OK", "image/png", &vec![b'<'; 4096]),
                "not_the_declared_image",
            ),
            (
                "a png under a type that is not an image",
                answer("200 OK", "text/html", &png(4096)),
                "not_the_declared_image",
            ),
            (
                "no content type",
                answer("200 OK", "", &png(4096)),
                "not_the_declared_image",
            ),
        ] {
            let (origin, _) = stub(response).await;
            let result = fetch(&client(), &url(&origin), 4096).await;
            assert!(
                matches!(&result, Err(Unread::Shape(got)) if *got == reason),
                "{what}: {result:?}"
            );
        }
    }

    /// #4970: the same answer is a PDF for the helper's read and **not an answer at all** for the avatar's
    /// — the type the worker accepts is the use's own, not whatever the route says.
    #[tokio::test]
    async fn the_avatar_read_takes_pictures_only_and_the_helpers_read_takes_its_own_types() {
        let pdf = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".to_vec();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: {}\r\n\r\n",
            pdf.len()
        )
        .into_bytes();
        response.extend_from_slice(&pdf);
        let (origin, _) = stub(response.clone()).await;
        let unread = fetch(&client(), &url(&origin), pdf.len())
            .await
            .unwrap_err();
        assert_eq!(unread.to_string(), "shape: not_the_declared_image");
        let read = fetch_as(
            &client(),
            &url(&origin),
            pdf.len(),
            RequesterAttachmentUse::Read.mimes(),
        )
        .await;
        assert_eq!(read.unwrap(), pdf);
        // …and the read's types are still checked against the bytes: a `text/plain` answer that holds a NUL
        let body = b"binary\0inside".to_vec();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(&body);
        let (origin, _) = stub(response).await;
        assert!(fetch_as(
            &client(),
            &url(&origin),
            body.len(),
            RequesterAttachmentUse::Read.mimes()
        )
        .await
        .is_err());
        // a type outside the use's list is refused whatever the bytes say
        let png_body = png(64);
        let mut response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: image/gif\r\ncontent-length: {}\r\n\r\n",
            png_body.len()
        )
        .into_bytes();
        response.extend_from_slice(&png_body);
        let (origin, _) = stub(response).await;
        assert!(fetch_as(
            &client(),
            &url(&origin),
            png_body.len(),
            RequesterAttachmentUse::Read.mimes()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn only_a_404_is_the_apis_refusal_and_any_other_status_is_unavailable() {
        for (status, reason) in [
            ("404 Not Found", "attachment_not_available"),
            ("429 Too Many Requests", "drive_unavailable"),
            ("500 Internal Server Error", "drive_unavailable"),
            ("403 Forbidden", "drive_unavailable"),
        ] {
            let (origin, _) = stub(answer(status, "application/json", b"{}")).await;
            let unread = fetch(&client(), &url(&origin), 4096).await.unwrap_err();
            assert!(matches!(unread, Unread::Status(_)), "{status}");
            assert_eq!(unread.reason(), reason, "{status}");
        }
    }

    /// RED proof (#4934): the client follows no redirect. The second server is where a followed 302 would
    /// land; it must never be reached, and the 302 itself is just a status that is not the picture.
    #[tokio::test]
    async fn a_redirect_is_an_answer_not_a_place_to_go() {
        let (elsewhere, elsewhere_hits) = stub(answer("200 OK", "image/png", &png(4096))).await;
        for code in [
            "301 Moved Permanently",
            "302 Found",
            "307 Temporary Redirect",
            "308 Permanent Redirect",
        ] {
            let redirect = format!(
                "HTTP/1.1 {code}\r\nlocation: {elsewhere}/stolen\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let (origin, hits) = stub(redirect.into_bytes()).await;
            let unread = fetch(&client(), &url(&origin), 4096).await.unwrap_err();
            assert!(matches!(unread, Unread::Status(_)), "{code}");
            assert_eq!(hits.load(Ordering::SeqCst), 1, "{code}");
        }
        assert_eq!(
            elsewhere_hits.load(Ordering::SeqCst),
            0,
            "a redirect was followed to another server"
        );
    }

    /// RED proof (#4934): a body that does not stop is cut at the declared length — the worker does not
    /// read until the deadline, and what the server managed to send stays small.
    #[tokio::test]
    async fn a_body_that_never_ends_is_cut_at_the_declared_length() {
        let (origin, written) = endless_stub().await;
        let started = std::time::Instant::now();
        let unread = fetch(&client(), &url(&origin), 4096).await.unwrap_err();
        assert!(
            matches!(unread, Unread::Shape("too_long")),
            "{unread} (it must be refused for its length, not time out)"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            written.load(Ordering::SeqCst) < 4 * 1024 * 1024,
            "the server wrote {} bytes into a read that was already refused",
            written.load(Ordering::SeqCst)
        );
    }

    /// RED proof (#4934): the transport's own message carries the request URL, token included. What the
    /// failure holds is the scrubbed text — and the assertion is not vacuous: the URL **was** in the message.
    #[tokio::test]
    async fn a_transport_failure_holds_no_token() {
        let closed = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let target = url(&closed);
        let raw = client().get(&target).send().await.unwrap_err().to_string();
        assert!(
            raw.contains(TOKEN),
            "the premise: reqwest's own message carries the token ({raw})"
        );
        let unread = fetch(&client(), &target, 4096).await.unwrap_err();
        let text = unread.to_string();
        assert!(matches!(unread, Unread::Transport(_)));
        assert!(!text.contains(TOKEN), "{text}");
        assert!(text.contains("<redacted>"), "{text}");
        assert_eq!(unread.reason(), "drive_unavailable");
    }

    /// The code above this test, as text, with the comment lines gone. A guard on the **source**: it cannot
    /// prove no log line leaks (the loop tests in `momo-server` measure that), but it turns red the moment
    /// someone writes the address, the token or the Drive id into a `tracing` call, or stringifies a
    /// transport error anywhere but the one function that scrubs it.
    fn production_source() -> String {
        let whole = include_str!("self_media.rs");
        let cut = whole
            .find("#[cfg(test)]\nmod tests {")
            .expect("the test module marker");
        whole[..cut]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every `tracing::<level>!( … );` call in `source`, as the text between the parentheses.
    fn tracing_calls(source: &str) -> Vec<String> {
        let mut calls = Vec::new();
        let mut rest = source;
        while let Some(at) = rest.find("tracing::") {
            let after = &rest[at..];
            let Some(open) = after.find('(') else { break };
            let mut depth = 0usize;
            let mut end = None;
            for (offset, byte) in after[open..].bytes().enumerate() {
                match byte {
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(open + offset);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(end) = end else { break };
            calls.push(after[open + 1..end].to_string());
            rest = &after[end..];
        }
        calls
    }

    #[test]
    fn no_log_line_names_the_address_the_token_or_the_drive_id() {
        let source = production_source();
        let calls = tracing_calls(&source);
        assert!(
            calls.len() >= 2,
            "the guard found the module's own log lines ({} of them)",
            calls.len()
        );
        for call in &calls {
            for word in call.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
                assert!(
                    !matches!(
                        word,
                        "url" | "token" | "grant" | "drive_file_id" | "origin" | "bytes" | "client"
                    ),
                    "a tracing call names `{word}`: {call}"
                );
            }
        }
        // the transport message is turned into text in exactly one place, and that place scrubs it
        assert_eq!(
            source.matches("error.to_string()").count(),
            1,
            "a transport error is stringified only by `transport`"
        );
        let transport_fn = source
            .split("fn transport(")
            .nth(1)
            .expect("fn transport")
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(
            transport_fn.contains("redact_self_media_urls(&error.to_string())"),
            "and `transport` scrubs it: {transport_fn}"
        );
    }

    #[test]
    fn the_line_says_what_the_address_is_for_and_how_long_it_lives() {
        let url = "https://oort.example.com/v1/self-media/00000000-0000-0000-0000-000000000000/tok";
        assert_eq!(
            self_media_line_text(url),
            format!("첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, 5분 뒤 만료: {url}")
        );
    }
}
