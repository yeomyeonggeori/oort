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
//!   fixed reason code (`attachment_not_available`, `attachment_not_readable` — the helper's read only —
//!   `drive_unavailable`); no transport message is ever
//!   returned. Those messages carry the request URL, and this URL carries a credential.
//! * **Nothing about the address in a log line.** The two lines this module writes name the run and a cause:
//!   a database error, or an `Unread` — the private failure type, which holds **a fixed word and nothing the
//!   transport said** (`timeout`, `connect`, `body` or `request` for a request that failed; a status number;
//!   the name of the rule a 200 broke). reqwest's own message for a failed request carries the request URL —
//!   the api's private origin, the workspace id and the token — so it is never turned into text here, scrubbed
//!   or not: nothing of it is kept to leak. A source guard
//!   (`no_log_line_names_the_address_the_token_or_the_drive_id`) keeps the address, the token and the Drive
//!   id out of every `tracing` call, and a loop test in `momo-server` reads the line a real failed read
//!   writes.
//! * **Nothing followed, nothing proxied.** A redirect is an answer, not a place to go; the client
//!   ignores `HTTP(S)_PROXY`.
//! * **A private-shaped origin, said once at boot.** The origin is operator configuration and the single-use
//!   token goes to wherever it points. The grammar ([`internal_origin`]) says what a well-formed origin looks
//!   like, not where it may point, so [`internal_origin_looks_private`] judges the *shape* of the host, and
//!   [`warn_if_internal_origin_is_not_private`] puts one line in the boot log when a well-formed origin does
//!   not look like a place on a private network — naming the variable, never printing its value.
//! * **Exactly the declared bytes.** A body longer or shorter than the row says, or not the declared
//!   image, is refused; the read stops at the declared length plus nothing.

use std::time::Duration;

use async_trait::async_trait;
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    bytes_match_mime, mint_for_attachment_in_tx, mint_for_read_in_tx, mint_for_run_in_tx,
    self_media_url, RequesterAttachmentUse, SELF_MEDIA_TTL_SECS,
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

/// Whether `origin` — one [`internal_origin`] accepts — is **shaped** like a place on a private network, which
/// is where the api's private address always is (Railway's `api.railway.internal`, compose's `api`, the
/// loopback of host networking). Private-shaped is one of:
///
/// * a loopback or private IPv4 literal (`127/8`, `10/8`, `172.16/12`, `192.168/16`, plus `100.64/10`, the
///   shared address space Tailscale and carrier-grade NAT use — not publicly routable either). Link-local
///   (`169.254/16`, the cloud metadata address) is **not**: nothing legitimate points a worker there;
/// * a bare single-label name (`api`, `localhost`);
/// * a name under a suffix reserved for private use: `.internal`, `.local`, `.localhost`, `.home.arpa`.
///
/// Anything else — a public name (`example.com`), a public address (`203.0.113.9`) — is not, and neither is a
/// host a resolver could read as an address in a form this check does not judge (`2130706433`, `0x7f.1`,
/// `127.1`: a numeric last label). The scheme does not matter: `https://` to a public host is still a
/// public host. A text the grammar refuses is not private-shaped either.
///
/// This is a *shape* check for a boot-time warning ([`warn_if_internal_origin_is_not_private`]), not a gate:
/// a name can resolve anywhere, and the value is operator configuration that neither a request nor a model
/// can touch.
pub fn internal_origin_looks_private(origin: &str) -> bool {
    let Some(origin) = internal_origin(origin) else {
        return false;
    };
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin);
    let host = rest.split_once(':').map_or(rest, |(host, _port)| host);
    if let Ok(address) = host.parse::<std::net::Ipv4Addr>() {
        let [first, second, _, _] = address.octets();
        return address.is_loopback()
            || address.is_private()
            || (first == 100 && (64..=127).contains(&second));
    }
    let last_label = host.rsplit('.').next().unwrap_or(host);
    if last_label.bytes().all(|byte| byte.is_ascii_digit()) || last_label.starts_with("0x") {
        return false;
    }
    !host.contains('.')
        || ["internal", "local", "localhost", "home.arpa"]
            .iter()
            .any(|suffix| host.ends_with(&format!(".{suffix}")))
}

/// The boot-log line for an origin that is well-formed but does not look private
/// ([`internal_origin_looks_private`]): the variable's **name only**, never its value (a mistyped value may
/// hold what must not be logged). Silent for a private-shaped origin.
pub fn warn_if_internal_origin_is_not_private(origin: &str) {
    if !internal_origin_looks_private(origin) {
        tracing::warn!(
            "OORT_API_INTERNAL_ORIGIN does not look like a private-network address (a single-label service \
             name, *.internal or *.local, a loopback or private IP); the worker's one-time attachment address \
             goes to wherever it points. Use the api's private address, never a public one"
        );
    }
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

/// Why a read through the api gave nothing. Every variant holds **a fixed word or a number, never anything
/// the transport said**, so nothing it holds can carry the token, the workspace or the api's private origin
/// (and deriving `Debug` is as safe as `Display`).
#[derive(Debug)]
enum Unread {
    /// The request did not complete: only the kind of failure ([`transport`]).
    Transport(&'static str),
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

/// The reason a read through the api ends with, for the use it was made for. The helper's read
/// ([`RequesterAttachmentUse::Read`]) tells one more thing than the avatar flow does: the mint has just proved
/// the file is the requester's, so when the api then refuses the bytes (a 404 — it sniffs them before it sends
/// them) or sends bytes that are not what the type says, **the file is not what its type says**. That is a
/// permanent property of the file, not a vanished one (a vanished file is the mint's own refusal,
/// `attachment_not_available`) and not the server failing — and the caller says so (#4970 review L1). A wrong
/// header, a wrong length, any other status and the network failing stay `drive_unavailable`.
fn failure_reason(usage: RequesterAttachmentUse, unread: &Unread) -> &'static str {
    match (usage, unread) {
        (RequesterAttachmentUse::Read, Unread::Status(404))
        | (RequesterAttachmentUse::Read, Unread::Shape("not_the_declared_image")) => {
            "attachment_not_readable"
        }
        _ => unread.reason(),
    }
}

impl std::fmt::Display for Unread {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unread::Transport(kind) => write!(formatter, "transport: {kind}"),
            Unread::Status(status) => write!(formatter, "status {status}"),
            Unread::Shape(what) => write!(formatter, "shape: {what}"),
        }
    }
}

/// The **kind** of a failed request, as a fixed word. reqwest's own text for the failure carries the request
/// URL — the api's private origin, the workspace id and the token — so no part of that text is kept: not
/// scrubbed, not shortened, not at all (this is the only place a `reqwest::Error` is looked at, and it is
/// only asked yes/no questions). The kind is what an operator needs: a network that is not there
/// (`connect`) against one that is slow (`timeout`), a body that broke off (`body`) and a server that took
/// the request and hung up or spoke nonsense (`request`).
fn transport(error: &reqwest::Error) -> Unread {
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        "request"
    };
    Unread::Transport(kind)
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
    // The answer's type must be one of the use's own — a header problem is the api's, not the file's —
    let Some(mime) = content_type
        .as_deref()
        .filter(|mime| allowed.contains(mime))
    else {
        return Err(Unread::Shape("content_type"));
    };
    // — and the bytes must be what that type says: the file is not, when they are not.
    if !bytes_match_mime(mime, &body) {
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
                // The cause is a fixed word or a number (`Unread`); the url and the token are not in scope of
                // this line, and nothing the transport said was kept to put on it.
                tracing::warn!(run_id = %run_id, cause = %unread, "attachment read through the api failed");
                Err(failure_reason(usage, &unread))
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
                "content_type",
            ),
            (
                "no content type",
                answer("200 OK", "", &png(4096)),
                "content_type",
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

    /// #4970 review L1: for the helper's read the api refusing the bytes of a file the mint just accepted is the
    /// file's own permanent problem; for the avatar flow, and for everything that is the server or the network
    /// failing, the reasons are what they always were.
    #[test]
    fn the_helpers_read_names_a_file_that_is_not_what_it_says_and_nothing_else_does() {
        use RequesterAttachmentUse::{Avatar, Read};
        for unread in [Unread::Status(404), Unread::Shape("not_the_declared_image")] {
            assert_eq!(failure_reason(Read, &unread), "attachment_not_readable");
        }
        assert_eq!(
            failure_reason(Avatar, &Unread::Status(404)),
            "attachment_not_available"
        );
        assert_eq!(
            failure_reason(Avatar, &Unread::Shape("not_the_declared_image")),
            "drive_unavailable"
        );
        for unread in [
            Unread::Status(500),
            Unread::Status(429),
            Unread::Shape("content_type"),
            Unread::Shape("length"),
            Unread::Shape("too_short"),
            Unread::Transport("connect"),
        ] {
            assert_eq!(
                failure_reason(Read, &unread),
                "drive_unavailable",
                "{unread}"
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
        assert_eq!(unread.to_string(), "shape: content_type");
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

    /// A loopback server that takes the request and then says nothing — and keeps the connection open.
    async fn silent_stub() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8192];
                    let _ = socket.read(&mut buffer).await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                });
            }
        });
        origin
    }

    /// RED proof (#4934, #4974): what a failed request leaves behind is the **kind** of failure and nothing
    /// the transport said. reqwest's own message carries the request URL — the premise, checked first so the
    /// assertions after it are not vacuous — and `Unread` keeps none of it: not the token, not the api's
    /// origin or port, not the workspace in the path, not even `self-media`.
    #[tokio::test]
    async fn a_transport_failure_holds_a_kind_and_nothing_the_transport_said() {
        let closed = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let target = url(&closed);
        let raw = client().get(&target).send().await.unwrap_err().to_string();
        for part in [
            TOKEN,
            closed.as_str(),
            "/v1/self-media/",
            "00000000-0000-0000-0000-000000001234",
        ] {
            assert!(
                raw.contains(part),
                "the premise: reqwest's own message carries `{part}` ({raw})"
            );
        }

        let (hangs_up, _) = stub(Vec::new()).await;
        // the head promises the declared 4096 bytes and the connection ends after 100 of them
        let mut breaks_off = b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4096\r\nconnection: close\r\n\r\n"
            .to_vec();
        breaks_off.extend_from_slice(&png(100));
        let (breaks_off, _) = stub(breaks_off).await;
        let silent = silent_stub().await;
        let quick = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_millis(150))
            .build()
            .expect("the quick client builds");
        let cases = [
            (
                "nothing listens",
                fetch(&client(), &target, 4096).await,
                "connect",
            ),
            (
                "the server takes the request and hangs up",
                fetch(&client(), &url(&hangs_up), 4096).await,
                "request",
            ),
            (
                "the body breaks off before the declared length",
                fetch(&client(), &url(&breaks_off), 4096).await,
                "body",
            ),
            (
                "the server never answers",
                fetch(&quick, &url(&silent), 4096).await,
                "timeout",
            ),
        ];
        for (what, result, kind) in cases {
            let unread = result.unwrap_err();
            assert!(
                matches!(unread, Unread::Transport(got) if got == kind),
                "{what}: {unread}"
            );
            assert_eq!(unread.reason(), "drive_unavailable", "{what}");
            let shown = format!("{unread} | {unread:?}");
            assert_eq!(unread.to_string(), format!("transport: {kind}"), "{what}");
            for part in [
                TOKEN,
                "http",
                "127.0.0.1",
                "self-media",
                "0000-0000",
                "/v1/",
                "redacted",
            ] {
                assert!(!shown.contains(part), "{what}: `{part}` in {shown}");
            }
        }
    }

    /// What `tracing` says while `run` runs, as text: level, target and message, no time and no colour.
    fn logged_while(run: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Sink(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Sink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let sink = Sink::default();
        let writer = sink.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .without_time()
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        let bytes = sink.0.lock().unwrap().clone();
        String::from_utf8(bytes).expect("log output is text")
    }

    #[test]
    fn an_origin_is_private_shaped_only_when_it_names_a_place_on_a_private_network() {
        for private in [
            // compose's service name, the loopback of host networking, Railway's private name
            "http://api:8080",
            "http://api",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://127.1.2.3",
            "http://api.railway.internal:8080",
            "https://api.railway.internal",
            // the reserved private suffixes
            "http://db.internal",
            "http://api.default.svc.cluster.local:8080",
            "http://printer.local",
            "http://app.localhost",
            "http://nas.home.arpa",
            // private IPv4 ranges, and the shared address space (Tailscale)
            "http://10.0.0.5",
            "http://10.255.255.255:1",
            "http://172.16.0.1",
            "http://172.31.255.254",
            "http://192.168.1.2:8080",
            "http://100.64.0.1",
            "http://100.127.255.254:8080",
        ] {
            assert!(internal_origin_looks_private(private), "{private}");
        }
        for not_private in [
            // public names and addresses, either scheme
            "http://example.com",
            "https://example.org",
            "https://example.org:8443",
            "http://203.0.113.9:8080",
            "http://8.8.8.8",
            // a dotted name is not private because of a word inside it
            "https://api.internal.example",
            "http://localhost.example.com",
            "http://a.internal.com",
            // one step outside each private range
            "http://169.254.169.254",
            "http://172.15.255.255",
            "http://172.32.0.1",
            "http://11.0.0.1",
            "http://192.169.0.1",
            "http://100.63.255.255",
            "http://100.128.0.1",
            "http://0.0.0.0:8080",
            // a resolver may read these as an address nobody judged
            "http://0x7f.1",
            "http://0x7f000001",
            "http://127.1",
            "http://2130706433",
            "http://16909060",
            "http://01.2.3.4",
            // not an origin at all
            "",
            "http://API:8080",
            "http://api:8080/x",
            "http://user@api:8080",
            "api:8080",
        ] {
            assert!(!internal_origin_looks_private(not_private), "{not_private}");
        }
    }

    /// RED proof (#4974): the boot line is **read from the log output**, not from the code that writes it — one
    /// line, the variable's name, and none of the value; and nothing at all for an origin that looks private.
    #[test]
    fn the_boot_line_for_an_origin_that_is_not_private_names_the_variable_and_never_the_value() {
        for private in [
            "http://api:8080",
            "http://api.railway.internal:8080",
            "http://127.0.0.1:8080",
        ] {
            let logged = logged_while(|| warn_if_internal_origin_is_not_private(private));
            assert_eq!(logged, "", "{private}");
        }
        for public in [
            "http://example.com:8080",
            "https://203.0.113.9",
            "http://169.254.169.254",
        ] {
            let logged = logged_while(|| warn_if_internal_origin_is_not_private(public));
            assert_eq!(logged.lines().count(), 1, "one line for {public}: {logged}");
            assert!(
                logged.contains("WARN") && logged.contains("OORT_API_INTERNAL_ORIGIN"),
                "{logged}"
            );
            let host = public
                .split("//")
                .nth(1)
                .and_then(|rest| rest.split(':').next())
                .unwrap();
            assert!(
                !logged.contains(host) && !logged.contains(public),
                "the value is not printed: {logged}"
            );
        }
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
        // a transport error is never turned into text: `transport` asks it yes/no questions and keeps one of
        // four fixed words, because reqwest's own message carries the request URL and the URL the token
        for text_of_an_error in [
            "error.to_string()",
            "e.to_string()",
            "redact_self_media_urls",
            "Box::leak",
            ".leak(",
        ] {
            assert!(
                !source.contains(text_of_an_error),
                "`{text_of_an_error}` in the production source"
            );
        }
        assert!(
            source.contains("Transport(&'static str)"),
            "what a failed request keeps is a fixed word, by type"
        );
        let transport_fn = source
            .split("fn transport(")
            .nth(1)
            .expect("fn transport")
            .split("\n}\n")
            .next()
            .unwrap();
        for forbidden in ["to_string", "format!", "{error", "{e}", "Display"] {
            assert!(
                !transport_fn.contains(forbidden),
                "`transport` writes `{forbidden}`: {transport_fn}"
            );
        }
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
