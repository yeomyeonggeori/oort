//! `momo-drive` — the workspace Drive archive (ADR-0151 D1/D3).
//!
//! Ported from Swift `server/Sources/MomoServer/Drive/DriveArchiveClient.swift`
//! with the contract frozen: the wire this crate participates in is the one
//! `docs/api/openapi.yaml` already specifies, and nothing here invents a shape.
//!
//! ## The asymmetry this crate exists to hold
//!
//! **Bytes bypass momo-server on the way up, and are proxied on the way down.**
//! [`DriveArchive::create_resumable_upload`] mints a Google resumable session
//! whose URL the client uploads to directly — the server never sees the body —
//! while [`DriveArchive::file_content`] streams the bytes back through the
//! authenticated content route. Upload bandwidth goes to Drive; read
//! authorization stays with PostgreSQL and RLS (ADR-0151 D3). A Drive URL is
//! never handed to a client for reading.
//!
//! ## What is NOT here, and why
//!
//! * **No `momo-db`, no `sqlx`.** The archive owns bytes; PostgreSQL owns the
//!   tenant/channel/uploader binding and the pending→complete lifecycle
//!   (`momo_messaging::attachment`). The split is asserted mechanically by
//!   [`tests::the_archive_has_no_database_dependency`].
//! * **No `axum`.** [`DriveContent`] hands back a byte stream, not a response.
//! * **No delete.** Swift's `deleteFile` has no caller among the three v0 routes
//!   (`AttachmentRoutes.swift` never calls it), and a capability nothing invokes
//!   is one more thing that can be invoked by mistake. Attachment reaping is the
//!   janitor's, and it is not part of v0.
//! * **No S3.** ADR-0151 rejected option 2 for v0, so `S3ArchiveClient.swift`
//!   is deliberately not ported — and with it the `redirectURL` branch of
//!   Swift's content route, which only that client ever set. The Drive backend
//!   always answers with bytes, which is exactly what the spec's
//!   `getAttachmentContent` 200 describes.
//!
//! ## Provider credentials never enter the request path (ADR-0004)
//!
//! The service-account key is read once from a path the **operator** supplied
//! (`MOMO_DRIVE_SA_KEY_PATH`), and the access token it mints lives only in this
//! crate's token cache. No route parameter, request body, or header can name a
//! credential, choose a Drive, or influence which identity a call is made under
//! — [`DriveBackendConfig`] is built from the environment at boot and is not
//! reachable from a handler.

pub mod google;
pub mod local;
pub mod stub;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use uuid::Uuid;

pub use google::GoogleDriveArchive;
pub use local::{prepare_local_dir, resolve_local_id, LocalDriveArchive};
pub use stub::StubDriveArchive;

/// The 100 MB ceiling, verbatim from Swift `AttachmentRoutes.maximumSizeBytes`
/// and the `attachment_size_ck` constraint in migration 017. Three places agree
/// on the number; this constant is the one the Rust side reads.
pub const MAX_ATTACHMENT_BYTES: i64 = 100 * 1024 * 1024;

/// How long an in-process upload capability — the stub's and the local
/// archive's `…/__momo_stub/drive/uploads/{token}` — stays usable after
/// [`DriveArchive::create_resumable_upload`] minted it (#2615).
///
/// The clock runs until the archive has the PUT's **whole body**: the
/// capability is checked before the first byte is read and again when the last
/// one has arrived (#2628), so this must cover one complete transfer, not only
/// its first byte.
///
/// * Every client creates the session immediately before its PUT (web and
///   desktop `draftStore.uploadOne`, phone `draftStore.uploadOne`, workspace
///   avatar), so creation → first byte is one round trip.
/// * No client cuts a transfer shorter: web XHR sets no timeout, the phone's
///   upload task runs on `URLSessionConfiguration.default` (60 s idle, 7-day
///   resource) or OkHttp (60 s idle).
/// * The edges do: Railway ends a request body that has not finished within
///   5 minutes (15-minute request ceiling); T1's Caddy leaves `read_body` at
///   its default, no timeout. One hour is 12× Railway's body window and
///   carries the 100 MB ceiling at ~233 kbit/s sustained where no edge limit
///   applies.
///
/// Google's resumable sessions live a week, and they can be *resumed*
/// (`308 Resume Incomplete`). This route has no resume protocol — one PUT
/// carries the whole body, and every client restarts a failed transfer with a
/// new session — so a longer lifetime would only widen the window in which an
/// unused URL that leaked is still worth something.
pub const UPLOAD_SESSION_TTL: Duration = Duration::from_secs(60 * 60);

/// A create-time declaration of `0` means the client does not know the length
/// (`sizeKnown=false`). It is a hint, not a promise: complete records the
/// measured archive size, and the ceiling is enforced on received bytes.
pub fn declared_size_is_unknown(declared_size_bytes: i64) -> bool {
    declared_size_bytes == 0
}

/// Whether a received length may be stored: empty files are legal, over-ceiling
/// files are not. Negative lengths never come from a `Vec`, but a lying archive
/// can report them.
pub fn received_size_within_ceiling(actual_size_bytes: i64) -> bool {
    (0..=MAX_ATTACHMENT_BYTES).contains(&actual_size_bytes)
}

/// Known declarations must equal the received length. Unknown (`0`) skips the
/// equality check so a `sizeKnown=false` client can still complete.
pub fn received_size_agrees_with_declaration(declared: i64, actual: i64) -> bool {
    declared_size_is_unknown(declared) || declared == actual
}

/// PUT-time refusal: the 100 MB ceiling is on the bytes that arrived, not on
/// the declaration. A shrunk declaration cannot smuggle an over-ceiling body.
pub fn uploaded_size_refusal(declared: i64, actual: i64) -> Option<DriveError> {
    if actual > MAX_ATTACHMENT_BYTES {
        return Some(DriveError::ContentTooLarge);
    }
    if !received_size_agrees_with_declaration(declared, actual) {
        return Some(DriveError::InvalidArguments(
            "uploaded size does not match the session".into(),
        ));
    }
    None
}

/// A PUT body as an archive receives it: the chunks as the transport delivers
/// them, or the transport's failure (#2628).
///
/// The route hands it over **unread** — not a byte buffered — so an archive
/// that refuses the capability, or refuses what the headers already say, never
/// pulls a byte, and one that accepts it stores the chunks as they arrive. The
/// 100 MB ceiling is therefore the archive's to enforce while it reads; no
/// extractor limit stands in front of this stream.
pub type UploadBody = BoxStream<'static, Result<Bytes, std::io::Error>>;

/// Wrap any byte stream (the route's request body) as an [`UploadBody`]. Here
/// rather than in the route so the server needs no stream combinators of its
/// own.
pub fn upload_body<S, E>(stream: S) -> UploadBody
where
    S: futures::Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    use futures::{StreamExt, TryStreamExt};
    stream.map_err(std::io::Error::other).boxed()
}

/// What the request line and headers already decide about an upload, checked
/// **before** a byte of the body is read (#2628): a body whose announced length
/// is over the ceiling, or contradicts a known declaration, or whose mime
/// contradicts the session's, is refused without being received.
///
/// Refusals here leave the capability usable, like every refusal before
/// storage.
pub(crate) fn refuse_before_body(
    declared_size: i64,
    declared_mime: &str,
    mime: Option<&str>,
    content_length: Option<u64>,
) -> Result<(), DriveError> {
    if let Some(announced) = content_length {
        let announced = i64::try_from(announced).unwrap_or(i64::MAX);
        if let Some(error) = uploaded_size_refusal(declared_size, announced) {
            return Err(error);
        }
    }
    if let Some(mime) = mime {
        if !mime.is_empty() && mime != declared_mime {
            return Err(DriveError::InvalidArguments(
                "uploaded mime does not match the session".into(),
            ));
        }
    }
    Ok(())
}

/// The refusal for a body the transport did not deliver in full — the client
/// went away mid-transfer. Nothing was stored, so the capability stays usable.
pub(crate) fn interrupted_upload() -> DriveError {
    DriveError::InvalidArguments("upload body was interrupted".into())
}

/// Counts a body as it streams in and refuses at the **first byte too many**:
/// over the 100 MB ceiling, or past a known declaration. A body is never read
/// further than it could still be accepted (#2628).
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReceivedLength {
    declared: i64,
    received: i64,
}

impl ReceivedLength {
    pub(crate) fn new(declared: i64) -> ReceivedLength {
        ReceivedLength {
            declared,
            received: 0,
        }
    }

    pub(crate) fn add(&mut self, chunk: usize) -> Result<(), DriveError> {
        self.received = self
            .received
            .saturating_add(i64::try_from(chunk).unwrap_or(i64::MAX));
        if self.received > MAX_ATTACHMENT_BYTES {
            return Err(DriveError::ContentTooLarge);
        }
        if !declared_size_is_unknown(self.declared) && self.received > self.declared {
            return Err(DriveError::InvalidArguments(
                "uploaded size does not match the session".into(),
            ));
        }
        Ok(())
    }

    /// The measured length, once the body has ended — refused if it fell short
    /// of a known declaration.
    pub(crate) fn finish(&self) -> Result<i64, DriveError> {
        match uploaded_size_refusal(self.declared, self.received) {
            Some(error) => Err(error),
            None => Ok(self.received),
        }
    }
}

/// `X-Upload-Content-Length` for a Google resumable session. Unknown
/// declarations omit the header so Drive will not cap the session at 0 bytes.
pub fn upload_content_length_header_value(declared_size_bytes: i64) -> Option<String> {
    if declared_size_is_unknown(declared_size_bytes) {
        None
    } else {
        Some(declared_size_bytes.to_string())
    }
}

/// A created resumable upload session: the id PostgreSQL will store, and the
/// capability URL the **client** uploads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveUploadSession {
    pub drive_file_id: String,
    /// Uncredentialed by design — Google's resumable session URLs carry their
    /// own capability token, which is why handing one to a client does not hand
    /// over the service account.
    pub upload_url: String,
}

/// Archive-side metadata, read back to verify what was actually uploaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFile {
    pub drive_file_id: String,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
}

/// A content read in progress: the archive's own idea of the mime and size, and
/// the bytes as a stream.
///
/// A stream rather than a `Vec<u8>` because the ceiling is 100 MB: buffering a
/// whole attachment per in-flight download would make the content proxy the
/// process's memory bound. The stream enforces `max_bytes` as it goes, so an
/// archive that lies about `size_bytes` cannot make the server read more than
/// the policy allows.
pub struct DriveContent {
    pub mime: String,
    pub size_bytes: i64,
    pub body: BoxStream<'static, Result<Bytes, DriveError>>,
}

impl std::fmt::Debug for DriveContent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DriveContent")
            .field("mime", &self.mime)
            .field("size_bytes", &self.size_bytes)
            .finish_non_exhaustive()
    }
}

/// Why an archive call failed. One variant per Swift `DriveArchiveError` case,
/// because the route's status table is keyed on them
/// (`AttachmentRoutes.httpError`, :470-479) and a merged variant would merge two
/// statuses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DriveError {
    #[error("Drive archive is not configured")]
    Unavailable,
    #[error("{0}")]
    InvalidArguments(String),
    #[error("Drive denied access to the workspace archive")]
    AccessDenied,
    #[error("Drive attachment was not found")]
    FileNotFound,
    #[error("Drive attachment exceeds the allowed size")]
    ContentTooLarge,
    #[error("Google Drive request failed")]
    UpstreamFailure,
}

impl DriveError {
    /// The sentence a client may see. Swift `DriveArchiveError.safeMessage`
    /// verbatim — and "safe" is load-bearing: an upstream failure never carries
    /// Google's own body, a file id, or a Drive id into the response.
    pub fn safe_message(&self) -> String {
        self.to_string()
    }
}

/// The workspace's byte archive.
///
/// Five methods, and that is the whole outbound surface a route can reach. The
/// trait is what makes the stub and Google backends substitutable **without a
/// test-only branch in a handler**: the attachment routes are written once and
/// the operator's environment decides which archive they run against.
#[async_trait]
pub trait DriveArchive: Send + Sync + std::fmt::Debug {
    /// Whether this backend serves the in-process upload endpoint. The stub and
    /// the local-volume archive do; the route is mounted only when this is true
    /// (Swift `App.swift:115`, ADR-0169).
    fn accepts_stub_uploads(&self) -> bool {
        false
    }

    async fn create_resumable_upload(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError>;

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError>;

    async fn file_content(&self, file_id: &str, max_bytes: i64)
        -> Result<DriveContent, DriveError>;

    /// Accept bytes for a stub session. Non-stub backends refuse: an upload that
    /// reached the server at all means the client used the wrong URL.
    ///
    /// **Order (#2628) — nothing is read that could not be accepted:**
    /// 1. the capability is checked before the first byte of `body` is pulled;
    /// 2. what the headers already say (`content_length`, `mime`) is checked
    ///    before the first byte too;
    /// 3. the body is read chunk by chunk and refused at the first byte over the
    ///    ceiling or past a known declaration;
    /// 4. the capability is checked again, then spent, then the bytes land.
    ///
    /// **A session accepts one upload (#2615).** The upload that passes every
    /// check spends it, before its bytes become readable — Google's resumable
    /// session is likewise done once its upload completes. A spent, expired
    /// ([`UPLOAD_SESSION_TTL`]) or never-issued token is the same
    /// [`DriveError::FileNotFound`], so the route answers no question about
    /// which capabilities once existed. A refusal before storage (wrong length,
    /// wrong mime, over the ceiling, a body the client broke off) leaves the
    /// session usable until it expires, like a Google session that has not
    /// received its bytes yet. An object that has landed is never overwritten
    /// through a capability.
    async fn accept_stub_upload(
        &self,
        _token: &str,
        _mime: Option<&str>,
        _content_length: Option<u64>,
        _body: UploadBody,
    ) -> Result<(), DriveError> {
        Err(DriveError::FileNotFound)
    }
}

/// The archive an instance gets when it configured none.
///
/// Swift's `UnavailableDriveArchiveClient`, and the reason the three attachment
/// routes are always mounted: an instance with no Drive answers **503 "Drive
/// archive is not configured"** rather than 404, so a client can tell "this
/// server has no archive" from "this server has no such route".
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableDriveArchive;

#[async_trait]
impl DriveArchive for UnavailableDriveArchive {
    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        _name: &str,
        _mime: &str,
        _size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        Err(DriveError::Unavailable)
    }

    async fn file_metadata(&self, _file_id: &str) -> Result<DriveFile, DriveError> {
        Err(DriveError::Unavailable)
    }

    async fn file_content(
        &self,
        _file_id: &str,
        _max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        Err(DriveError::Unavailable)
    }
}

/// Which backend an operator selected, and what it needs.
///
/// Built from the environment at boot and never from a request — see the module
/// docs on ADR-0004.
#[derive(Debug, Clone, Default)]
pub struct DriveBackendConfig {
    /// `MOMO_DRIVE_ARCHIVE_BACKEND` (or the legacy `MOMO_DRIVE_BACKEND`),
    /// lowercased and trimmed. `""` means "infer from whether a key/drive was
    /// named", matching Swift `resolvedMode` + its `case ""` branch.
    pub mode: String,
    /// `MOMO_DRIVE_SA_KEY_PATH` — a path on the server's own filesystem.
    pub sa_key_path: Option<String>,
    /// `MOMO_DRIVE_SHARED_DRIVE_ID`.
    pub shared_drive_id: Option<String>,
    /// The base URL the stub's upload capability URLs are built against.
    pub stub_base_url: String,
    /// `MOMO_DRIVE_LOCAL_DIR` — the directory `local` writes into.
    pub local_dir: Option<String>,
    /// The base URL local upload capability URLs are built against. Falls back
    /// to [`Self::stub_base_url`] when empty so a verifier can point both at the
    /// same in-process PUT route.
    pub local_base_url: String,
}

/// The backend name that must never be selected in a deployed environment.
///
/// The refusal itself lives in `momo_server::config::DriveSettings::boot_error`,
/// where the environment name is — one rule in one place, rather than a
/// half-check here that a caller could satisfy and still boot. This constant is
/// what the two sides agree on. (Swift keeps its equivalent inside
/// `DriveArchiveClientFactory.validateForBoot`, which had the environment name
/// passed in.)
pub const STUB_BACKEND: &str = "stub";

/// The self-host default archive (ADR-0169). Allowed in a deployed environment
/// — unlike [`STUB_BACKEND`] — because the bytes survive a restart.
pub const LOCAL_BACKEND: &str = "local";

/// Build the archive an operator configured.
///
/// **Never fails.** Every misconfiguration degrades to
/// [`UnavailableDriveArchive`], exactly like Swift's factory `catch` — an
/// unreadable key file must close the attachment surface, not stop the messenger
/// from booting. The failure is logged; the routes answer 503.
pub async fn build_archive(config: &DriveBackendConfig) -> Arc<dyn DriveArchive> {
    match config.mode.as_str() {
        STUB_BACKEND => Arc::new(StubDriveArchive::new(&config.stub_base_url)),
        LOCAL_BACKEND => local_or_unavailable(config),
        "google" | "sa" => google_or_unavailable(config).await,
        // Swift's `case ""`: infer. Naming either knob is the operator saying
        // "there is a Drive"; naming neither is the operator saying there is not.
        "" => {
            if config.sa_key_path.is_none() && config.shared_drive_id.is_none() {
                Arc::new(UnavailableDriveArchive)
            } else {
                google_or_unavailable(config).await
            }
        }
        other => {
            tracing::error!(
                backend = other,
                "unknown MOMO_DRIVE_ARCHIVE_BACKEND; the attachment surface stays closed"
            );
            Arc::new(UnavailableDriveArchive)
        }
    }
}

fn local_or_unavailable(config: &DriveBackendConfig) -> Arc<dyn DriveArchive> {
    let base = if config.local_base_url.trim().is_empty() {
        config.stub_base_url.as_str()
    } else {
        config.local_base_url.as_str()
    };
    match LocalDriveArchive::open(config.local_dir.as_deref(), base) {
        Ok(archive) => Arc::new(archive),
        Err(error) => {
            tracing::error!(
                %error,
                "local Drive archive unavailable; the attachment surface stays closed"
            );
            Arc::new(UnavailableDriveArchive)
        }
    }
}

async fn google_or_unavailable(config: &DriveBackendConfig) -> Arc<dyn DriveArchive> {
    match GoogleDriveArchive::new(
        config.sa_key_path.as_deref(),
        config.shared_drive_id.as_deref(),
    ) {
        Ok(archive) => Arc::new(archive),
        Err(error) => {
            // The path and the drive id are operator configuration, not secrets,
            // but the *contents* of the key file never reach a log line — the
            // error type carries no credential material at all.
            tracing::error!(%error, "Drive archive unavailable; the attachment surface stays closed");
            Arc::new(UnavailableDriveArchive)
        }
    }
}

/// Trim to `None` when empty — Swift `nonempty`.
pub(crate) fn nonempty(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Drive ids and file ids share one alphabet. Validated before interpolation
/// into a URL path or a Drive query, so neither can be used to reach a different
/// endpoint (Swift `requireFileID` / `validDriveID`).
pub(crate) fn valid_drive_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0151 D3 — the archive owns bytes, PostgreSQL owns authorization.
    ///
    /// Asserted against the manifest rather than trusted to review: the moment
    /// this crate can open a transaction, "Drive never decides who may read" is
    /// a comment instead of a fact.
    #[test]
    fn the_archive_has_no_database_dependency() {
        let manifest = include_str!("../Cargo.toml");
        for forbidden in ["momo-db", "sqlx", "axum"] {
            assert!(
                !manifest.contains(&format!("\n{forbidden}")),
                "momo-drive must not depend on {forbidden}: the archive owns bytes, \
                 not authorization and not the HTTP response"
            );
        }
    }

    #[tokio::test]
    async fn a_local_dir_without_the_local_backend_does_not_open_the_surface() {
        let archive = build_archive(&DriveBackendConfig {
            mode: String::new(),
            sa_key_path: None,
            shared_drive_id: None,
            stub_base_url: "http://127.0.0.1:1".into(),
            local_dir: Some("/var/lib/oort/drive".into()),
            local_base_url: "http://127.0.0.1:1".into(),
        })
        .await;
        assert!(!archive.accepts_stub_uploads());
        assert_eq!(
            archive
                .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 1)
                .await
                .expect_err("mode is still empty"),
            DriveError::Unavailable
        );
    }

    #[tokio::test]
    async fn an_unconfigured_instance_answers_unavailable_rather_than_failing_to_boot() {
        let archive = build_archive(&DriveBackendConfig {
            mode: String::new(),
            sa_key_path: None,
            shared_drive_id: None,
            stub_base_url: "http://127.0.0.1:1".into(),
            local_dir: None,
            local_base_url: String::new(),
        })
        .await;
        assert!(!archive.accepts_stub_uploads());
        assert_eq!(
            archive
                .file_metadata("anything")
                .await
                .expect_err("no archive"),
            DriveError::Unavailable
        );
    }

    /// A key path that does not exist is a misconfiguration, not a crash: the
    /// messenger boots and the attachment surface answers 503.
    #[tokio::test]
    async fn an_unreadable_service_account_key_closes_the_surface_without_panicking() {
        let archive = build_archive(&DriveBackendConfig {
            mode: "google".into(),
            sa_key_path: Some("/nonexistent/momo-drive-sa.json".into()),
            shared_drive_id: Some("0ABCdef1234567890".into()),
            stub_base_url: "http://127.0.0.1:1".into(),
            local_dir: None,
            local_base_url: String::new(),
        })
        .await;
        assert_eq!(
            archive
                .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 1)
                .await
                .expect_err("no credentials"),
            DriveError::Unavailable
        );
    }

    /// The name the boot refusal in `momo-server` keys on. Spelled once and
    /// asserted here, because a rename on this side with no rename on that one
    /// would silently re-open a stub archive in production.
    #[test]
    fn the_stub_backend_keeps_the_name_the_boot_refusal_looks_for() {
        assert_eq!(STUB_BACKEND, "stub");
    }

    #[test]
    fn the_local_backend_keeps_the_name_self_host_selects() {
        assert_eq!(LOCAL_BACKEND, "local");
    }

    #[tokio::test]
    async fn a_local_backend_opens_without_touching_google_or_the_stub() {
        let dir = std::env::temp_dir().join(format!(
            "oort-drive-local-factory-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp");
        let archive = build_archive(&DriveBackendConfig {
            mode: LOCAL_BACKEND.into(),
            sa_key_path: Some("/nonexistent/momo-drive-sa.json".into()),
            shared_drive_id: Some("0ABCdef1234567890".into()),
            stub_base_url: "http://127.0.0.1:1".into(),
            local_dir: Some(dir.to_string_lossy().into_owned()),
            local_base_url: "http://127.0.0.1:9".into(),
        })
        .await;
        assert!(archive.accepts_stub_uploads());
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 1)
            .await
            .expect("local session");
        assert!(
            session.drive_file_id.starts_with("local-"),
            "{}",
            session.drive_file_id
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_drive_id_is_restricted_to_the_alphabet_google_actually_issues() {
        assert!(valid_drive_id("0ABCdef-_1234567890"));
        assert!(!valid_drive_id(""));
        assert!(!valid_drive_id("../../etc/passwd"));
        assert!(!valid_drive_id("id with space"));
        assert!(!valid_drive_id("id?alt=media"));
        assert!(!valid_drive_id(&"a".repeat(201)));
    }

    #[test]
    fn a_zero_declaration_is_unknown_and_does_not_cap_google_at_zero_bytes() {
        assert!(declared_size_is_unknown(0));
        assert!(!declared_size_is_unknown(1));
        assert!(received_size_agrees_with_declaration(0, 5));
        assert!(received_size_agrees_with_declaration(5, 5));
        assert!(!received_size_agrees_with_declaration(5, 8));
        assert!(received_size_within_ceiling(0));
        assert!(received_size_within_ceiling(MAX_ATTACHMENT_BYTES));
        assert!(!received_size_within_ceiling(MAX_ATTACHMENT_BYTES + 1));
        assert!(!received_size_within_ceiling(-1));
        assert_eq!(upload_content_length_header_value(0), None);
        assert_eq!(
            upload_content_length_header_value(12),
            Some("12".to_string())
        );
    }

    /// #2628 (review of #2624, S11): the lifetime is pinned from both sides. It
    /// is a security bound — how long a leaked, unused URL is worth anything —
    /// and a functional one — it must outlast one whole transfer through the
    /// slowest edge we ship behind (Railway closes a request at 15 minutes).
    #[test]
    fn the_upload_session_lifetime_is_bounded_from_both_sides() {
        assert!(
            UPLOAD_SESSION_TTL <= Duration::from_secs(60 * 60),
            "an unused upload URL must not stay usable for more than an hour: {UPLOAD_SESSION_TTL:?}"
        );
        assert!(
            UPLOAD_SESSION_TTL >= Duration::from_secs(15 * 60),
            "an upload URL must outlast Railway's 15-minute request ceiling: {UPLOAD_SESSION_TTL:?}"
        );
    }

    /// The first byte too many is refused — over a known declaration, or over
    /// the ceiling for an unknown one — and a short body is refused at the end.
    #[test]
    fn a_streamed_length_is_refused_at_the_first_byte_too_many() {
        let mut known = ReceivedLength::new(5);
        assert_eq!(known.add(5), Ok(()));
        assert!(matches!(known.add(1), Err(DriveError::InvalidArguments(_))));

        let mut short = ReceivedLength::new(5);
        assert_eq!(short.add(4), Ok(()));
        assert!(matches!(
            short.finish(),
            Err(DriveError::InvalidArguments(_))
        ));

        let mut unknown = ReceivedLength::new(0);
        assert_eq!(unknown.add(MAX_ATTACHMENT_BYTES as usize), Ok(()));
        assert_eq!(unknown.finish(), Ok(MAX_ATTACHMENT_BYTES));
        assert_eq!(unknown.add(1), Err(DriveError::ContentTooLarge));

        let mut exact = ReceivedLength::new(3);
        assert_eq!(exact.add(1), Ok(()));
        assert_eq!(exact.add(2), Ok(()));
        assert_eq!(exact.finish(), Ok(3));
    }

    /// What the headers announce is judged before the body: the ceiling first,
    /// then a known declaration, then the mime.
    #[test]
    fn what_the_headers_announce_is_refused_before_the_body() {
        assert_eq!(
            refuse_before_body(5, "text/plain", None, Some(MAX_ATTACHMENT_BYTES as u64 + 1)),
            Err(DriveError::ContentTooLarge)
        );
        assert_eq!(
            refuse_before_body(0, "text/plain", None, Some(u64::MAX)),
            Err(DriveError::ContentTooLarge)
        );
        assert!(matches!(
            refuse_before_body(5, "text/plain", None, Some(6)),
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            refuse_before_body(5, "text/plain", Some("image/png"), Some(5)),
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            refuse_before_body(0, "text/plain", Some("text/plain"), Some(9)),
            Ok(())
        );
        assert_eq!(refuse_before_body(5, "text/plain", Some(""), None), Ok(()));
    }

    #[test]
    fn a_shrunk_declaration_cannot_smuggle_an_over_ceiling_upload() {
        assert_eq!(
            uploaded_size_refusal(0, MAX_ATTACHMENT_BYTES + 1),
            Some(DriveError::ContentTooLarge)
        );
        assert_eq!(
            uploaded_size_refusal(1, MAX_ATTACHMENT_BYTES + 1),
            Some(DriveError::ContentTooLarge)
        );
        assert_eq!(uploaded_size_refusal(0, 5), None);
        assert_eq!(uploaded_size_refusal(5, 5), None);
        assert!(matches!(
            uploaded_size_refusal(5, 8),
            Some(DriveError::InvalidArguments(_))
        ));
    }

    #[test]
    fn every_error_message_is_free_of_upstream_detail() {
        for error in [
            DriveError::Unavailable,
            DriveError::AccessDenied,
            DriveError::FileNotFound,
            DriveError::ContentTooLarge,
            DriveError::UpstreamFailure,
        ] {
            let message = error.safe_message();
            assert!(!message.contains("googleapis"), "{message}");
            assert!(!message.is_empty());
        }
    }
}
