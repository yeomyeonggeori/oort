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
pub mod stub;

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use uuid::Uuid;

pub use google::GoogleDriveArchive;
pub use stub::StubDriveArchive;

/// The 100 MB ceiling, verbatim from Swift `AttachmentRoutes.maximumSizeBytes`
/// and the `attachment_size_ck` constraint in migration 017. Three places agree
/// on the number; this constant is the one the Rust side reads.
pub const MAX_ATTACHMENT_BYTES: i64 = 100 * 1024 * 1024;

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
    /// Whether this backend serves the in-process upload endpoint. Only the stub
    /// does; the route is mounted only when this is true (Swift `App.swift:115`).
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
    async fn accept_stub_upload(
        &self,
        _token: &str,
        _mime: Option<&str>,
        _bytes: Vec<u8>,
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

/// Build the archive an operator configured.
///
/// **Never fails.** Every misconfiguration degrades to
/// [`UnavailableDriveArchive`], exactly like Swift's factory `catch` — an
/// unreadable key file must close the attachment surface, not stop the messenger
/// from booting. The failure is logged; the routes answer 503.
pub async fn build_archive(config: &DriveBackendConfig) -> Arc<dyn DriveArchive> {
    match config.mode.as_str() {
        STUB_BACKEND => Arc::new(StubDriveArchive::new(&config.stub_base_url)),
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
    async fn an_unconfigured_instance_answers_unavailable_rather_than_failing_to_boot() {
        let archive = build_archive(&DriveBackendConfig {
            mode: String::new(),
            sa_key_path: None,
            shared_drive_id: None,
            stub_base_url: "http://127.0.0.1:1".into(),
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
    fn a_drive_id_is_restricted_to_the_alphabet_google_actually_issues() {
        assert!(valid_drive_id("0ABCdef-_1234567890"));
        assert!(!valid_drive_id(""));
        assert!(!valid_drive_id("../../etc/passwd"));
        assert!(!valid_drive_id("id with space"));
        assert!(!valid_drive_id("id?alt=media"));
        assert!(!valid_drive_id(&"a".repeat(201)));
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
