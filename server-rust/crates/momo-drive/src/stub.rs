//! The deterministic verifier-only archive (Swift `StubDriveArchiveClient`).
//!
//! It exists so the three attachment routes can be round-tripped — session →
//! upload → complete → content — **without a Google credential and without a
//! network call**, which is what makes the conformance suite a real proof of the
//! contract rather than of a mock's manners.
//!
//! Two properties are deliberately kept from Swift:
//!
//! 1. **The upload URL is uncredentialed**, like Google's resumable session URL.
//!    It carries a random capability token and nothing else, so the shape a
//!    client is handed in test is the shape it is handed in production.
//! 2. **Metadata only exists after bytes arrived.** `file_metadata` fails with
//!    [`DriveError::FileNotFound`] until an upload lands, which is what makes
//!    "complete before uploading" a 404 in tests exactly as it is against Drive.
//!
//! And one is added (#2615): **the upload URL is spent by its first accepted
//! upload and expires after [`UPLOAD_SESSION_TTL`]**, the contract
//! [`DriveArchive::accept_stub_upload`] states. Sessions and landed objects are
//! therefore two maps — a session can leave without taking the bytes with it.
//!
//! The body is checked in the contract's order (#2628): capability and headers
//! before a byte is pulled, the ceiling at the first byte too many. The bytes
//! then live in memory, because this archive *is* memory — it is a boot error
//! in every deployed environment, so its footprint is a verifier's, bounded by
//! the ceiling per upload.
//!
//! `file_metadata` reports the declared name/mime and the **measured** byte
//! count once bytes have landed (a `size: 0` session is unknown, not a promise
//! of an empty file). A verifier that needs the completion route's mismatch
//! branch implements [`DriveArchive`] itself and says so out loud — the stub
//! will not invent a size that contradicts the bytes it accepted.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    interrupted_upload, refuse_before_body, DriveArchive, DriveContent, DriveError, DriveFile,
    DriveUploadSession, ReceivedLength, UploadBody, MAX_ATTACHMENT_BYTES, UPLOAD_SESSION_TTL,
};

/// A capability that has not been spent yet.
#[derive(Debug, Clone)]
struct PendingUpload {
    file_id: String,
    name: String,
    mime: String,
    size_bytes: i64,
    created_at: Instant,
}

/// Bytes that landed, with the declaration they landed against.
#[derive(Debug, Clone)]
struct StoredObject {
    name: String,
    mime: String,
    bytes: Vec<u8>,
}

/// In-memory archive keyed by capability token.
#[derive(Debug)]
pub struct StubDriveArchive {
    base_url: String,
    session_ttl: Duration,
    state: Mutex<StubState>,
}

impl Default for StubDriveArchive {
    /// Written out rather than derived: a derived `Duration` would be zero and
    /// every session would be born expired.
    fn default() -> StubDriveArchive {
        StubDriveArchive::new("")
    }
}

#[derive(Debug, Default)]
struct StubState {
    /// Live capabilities by token. One leaves on its first accepted upload,
    /// or when it is presented after expiring.
    sessions: HashMap<String, PendingUpload>,
    /// Landed bytes by file id. Written once; no token reaches them again.
    objects: HashMap<String, StoredObject>,
}

impl StubDriveArchive {
    pub fn new(base_url: &str) -> StubDriveArchive {
        StubDriveArchive {
            base_url: base_url.trim_end_matches('/').to_string(),
            session_ttl: UPLOAD_SESSION_TTL,
            state: Mutex::new(StubState::default()),
        }
    }

    /// Replace [`UPLOAD_SESSION_TTL`]. Verifiers pass `Duration::ZERO` to prove
    /// an expired capability is refused without waiting out the real lifetime.
    pub fn with_upload_session_ttl(mut self, ttl: Duration) -> StubDriveArchive {
        self.session_ttl = ttl;
        self
    }
}

#[async_trait]
impl DriveArchive for StubDriveArchive {
    fn accepts_stub_uploads(&self) -> bool {
        true
    }

    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        if !(0..=MAX_ATTACHMENT_BYTES).contains(&size_bytes) {
            return Err(DriveError::ContentTooLarge);
        }
        // Lowercase because the stub-upload route matches `[a-f0-9-]{36}`, the
        // same regex Swift's route used.
        let token = Uuid::new_v4().to_string().to_lowercase();
        let file_id = format!("stub-{}", Uuid::new_v4().to_string().to_lowercase());
        let mut state = self.state.lock().await;
        state.sessions.insert(
            token.clone(),
            PendingUpload {
                file_id: file_id.clone(),
                name: name.to_string(),
                mime: mime.to_string(),
                size_bytes,
                created_at: Instant::now(),
            },
        );
        Ok(DriveUploadSession {
            drive_file_id: file_id,
            upload_url: format!("{}/__momo_stub/drive/uploads/{token}", self.base_url),
        })
    }

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        let state = self.state.lock().await;
        let object = state.objects.get(file_id).ok_or(DriveError::FileNotFound)?;
        Ok(DriveFile {
            drive_file_id: file_id.to_string(),
            name: object.name.clone(),
            mime: object.mime.clone(),
            size_bytes: object.bytes.len() as i64,
        })
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        let state = self.state.lock().await;
        let object = state.objects.get(file_id).ok_or(DriveError::FileNotFound)?;
        if object.bytes.len() as i64 > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        let bytes = object.bytes.clone();
        let mime = object.mime.clone();
        let size_bytes = bytes.len() as i64;
        Ok(DriveContent {
            mime,
            size_bytes,
            body: Box::pin(futures::stream::once(async move { Ok(Bytes::from(bytes)) })),
        })
    }

    async fn accept_stub_upload(
        &self,
        token: &str,
        mime: Option<&str>,
        content_length: Option<u64>,
        mut body: UploadBody,
    ) -> Result<(), DriveError> {
        // 1–2. The capability and the headers, before a byte is pulled.
        let pending = {
            let mut state = self.state.lock().await;
            self.live(&mut state, token)?
        };
        refuse_before_body(pending.size_bytes, &pending.mime, mime, content_length)?;

        // 3. The body, refused at the first byte too many.
        let mut length = ReceivedLength::new(pending.size_bytes);
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|_| interrupted_upload())?;
            length.add(chunk.len())?;
            bytes.extend_from_slice(&chunk);
        }
        length.finish()?;

        // 4. Checked again — a concurrent PUT may have spent it, or it may have
        // expired while the body arrived — then spent in the same critical
        // section that stores the bytes, so no second PUT can ever find it.
        let mut state = self.state.lock().await;
        self.live(&mut state, token)?;
        let pending = state
            .sessions
            .remove(token)
            .expect("the session was read under this lock");
        state.objects.insert(
            pending.file_id,
            StoredObject {
                name: pending.name,
                mime: pending.mime,
                bytes,
            },
        );
        Ok(())
    }
}

impl StubDriveArchive {
    /// The session behind `token`, if it can still accept an upload. One that
    /// cannot — expired, or its object already landed — is forgotten with its
    /// refusal, and the refusal is the unknown-token one.
    fn live(&self, state: &mut StubState, token: &str) -> Result<PendingUpload, DriveError> {
        let (expired, landed) = match state.sessions.get(token) {
            None => return Err(DriveError::FileNotFound),
            Some(pending) => (
                pending.created_at.elapsed() >= self.session_ttl,
                state.objects.contains_key(&pending.file_id),
            ),
        };
        if expired || landed {
            state.sessions.remove(token);
            return Err(DriveError::FileNotFound);
        }
        Ok(state.sessions[token].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body delivered in one chunk — what the route hands over for a small
    /// upload once the transport has it.
    fn body(bytes: &[u8]) -> UploadBody {
        let chunk = Bytes::copy_from_slice(bytes);
        futures::stream::once(async move { Ok(chunk) }).boxed()
    }

    async fn collect(content: DriveContent) -> Vec<u8> {
        let mut body = content.body;
        let mut out = Vec::new();
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.expect("chunk"));
        }
        out
    }

    #[tokio::test]
    async fn a_session_round_trips_from_upload_to_content() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9/");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        assert!(
            session
                .upload_url
                .starts_with("http://127.0.0.1:9/__momo_stub/drive/uploads/"),
            "{}",
            session.upload_url
        );
        let token = session
            .upload_url
            .rsplit('/')
            .next()
            .expect("token")
            .to_string();

        // Before the bytes land there is nothing to describe.
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("no bytes yet"),
            DriveError::FileNotFound
        );

        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("upload");
        let metadata = archive
            .file_metadata(&session.drive_file_id)
            .await
            .expect("metadata");
        assert_eq!(metadata.size_bytes, 5);
        assert_eq!(metadata.mime, "text/plain");
        let content = archive
            .file_content(&session.drive_file_id, 1024)
            .await
            .expect("content");
        assert_eq!(collect(content).await, b"hello");
    }

    #[tokio::test]
    async fn a_zero_declaration_records_the_received_length() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 0)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("unknown declaration accepts measured bytes");
        let metadata = archive
            .file_metadata(&session.drive_file_id)
            .await
            .expect("metadata");
        assert_eq!(metadata.size_bytes, 5);
    }

    #[tokio::test]
    async fn an_upload_that_contradicts_its_session_is_refused() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");

        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, body(b"too long"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("image/png"), None, body(b"hello"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            archive
                .accept_stub_upload("not-a-session", None, None, body(b"hello"))
                .await
                .expect_err("unknown token"),
            DriveError::FileNotFound
        );
    }

    #[tokio::test]
    async fn a_session_over_the_ceiling_is_refused_before_bytes() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        assert_eq!(
            archive
                .create_resumable_upload(
                    Uuid::nil(),
                    "huge.bin",
                    "application/octet-stream",
                    MAX_ATTACHMENT_BYTES + 1
                )
                .await
                .expect_err("over the ceiling"),
            DriveError::ContentTooLarge
        );
    }

    /// **Red proof (#2615).** The first upload spends the capability; a replay
    /// of the same URL — same mime, same length — cannot swap the bytes.
    #[tokio::test]
    async fn an_upload_capability_is_spent_by_its_first_upload() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "contract.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");
        assert!(
            !archive.state.lock().await.sessions.contains_key(token),
            "the upload that landed spent the session"
        );

        let replay = archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"HACKD"))
            .await;
        let now_stored = collect(
            archive
                .file_content(&session.drive_file_id, 1024)
                .await
                .expect("content"),
        )
        .await;
        assert_eq!(
            (replay, String::from_utf8_lossy(&now_stored).into_owned()),
            (Err(DriveError::FileNotFound), "hello".to_string()),
            "a spent capability must answer not-found and leave the landed bytes alone"
        );
    }

    /// A session that reappears for an object that already landed — the
    /// local archive's restored-backup case, reproduced here by hand — still
    /// cannot overwrite it.
    #[tokio::test]
    async fn a_resurrected_session_cannot_overwrite_an_object_that_landed() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "contract.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        let saved = archive.state.lock().await.sessions[token].clone();
        archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");
        archive
            .state
            .lock()
            .await
            .sessions
            .insert(token.to_string(), saved);
        assert_eq!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, body(b"HACKD"))
                .await
                .expect_err("an object that landed is never replaced"),
            DriveError::FileNotFound
        );
        let content = archive
            .file_content(&session.drive_file_id, 1024)
            .await
            .expect("content");
        assert_eq!(collect(content).await, b"hello");
    }

    #[tokio::test]
    async fn an_expired_capability_is_refused_and_forgotten() {
        let archive =
            StubDriveArchive::new("http://127.0.0.1:9").with_upload_session_ttl(Duration::ZERO);
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        assert_eq!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
                .await
                .expect_err("expired"),
            DriveError::FileNotFound
        );
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("no bytes landed"),
            DriveError::FileNotFound
        );
        assert!(archive.state.lock().await.sessions.is_empty());
    }

    #[test]
    fn the_default_lifetime_is_the_shared_one() {
        assert_eq!(StubDriveArchive::default().session_ttl, UPLOAD_SESSION_TTL);
        assert_eq!(StubDriveArchive::new("x").session_ttl, UPLOAD_SESSION_TTL);
    }

    /// The retry policy: a PUT refused before storage leaves the capability
    /// usable, like a Google resumable session that has not received its bytes.
    #[tokio::test]
    async fn a_refused_upload_does_not_spend_the_capability() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, body(b"too long"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("image/png"), None, body(b"hello"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the corrected upload lands");
        let content = archive
            .file_content(&session.drive_file_id, 1024)
            .await
            .expect("content");
        assert_eq!(collect(content).await, b"hello");
    }

    #[tokio::test]
    async fn a_read_over_the_ceiling_is_refused_rather_than_buffered() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "big.bin", "application/octet-stream", 8)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        archive
            .accept_stub_upload(token, None, None, body(&[0u8; 8]))
            .await
            .expect("upload");
        assert_eq!(
            archive
                .file_content(&session.drive_file_id, 4)
                .await
                .expect_err("over the ceiling"),
            DriveError::ContentTooLarge
        );
    }

    // ---- #2628: nothing is read that could not be accepted -----------------

    /// A body that records whether anything ever asked it for a byte.
    fn tripwire() -> (UploadBody, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let pulled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = pulled.clone();
        let stream = futures::stream::poll_fn(move |_| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            std::task::Poll::Ready(None)
        })
        .boxed();
        (stream, pulled)
    }

    fn pulled(flag: &std::sync::atomic::AtomicBool) -> bool {
        flag.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Unknown, spent and expired capabilities are refused before the body is
    /// touched — the route's 404 costs the server no body at all.
    #[tokio::test]
    async fn an_unusable_capability_never_pulls_a_byte() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let spent = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let spent_token = spent.upload_url.rsplit('/').next().expect("token");
        archive
            .accept_stub_upload(spent_token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");
        let expired_archive =
            StubDriveArchive::new("http://127.0.0.1:9").with_upload_session_ttl(Duration::ZERO);
        let expired = expired_archive
            .create_resumable_upload(Uuid::nil(), "b.txt", "text/plain", 5)
            .await
            .expect("session");
        let expired_token = expired.upload_url.rsplit('/').next().expect("token");

        for (label, target, token) in [
            ("unknown", &archive, "00000000-0000-4000-8000-000000000000"),
            ("spent", &archive, spent_token),
            ("expired", &expired_archive, expired_token),
        ] {
            let (stream, flag) = tripwire();
            assert_eq!(
                target
                    .accept_stub_upload(token, Some("text/plain"), Some(5), stream)
                    .await,
                Err(DriveError::FileNotFound),
                "{label}"
            );
            assert!(
                !pulled(&flag),
                "{label}: the body was pulled before the refusal"
            );
        }
    }

    /// What the headers announce is refused before the body, and such a
    /// refusal leaves the capability usable.
    #[tokio::test]
    async fn a_header_refusal_never_pulls_a_byte_and_keeps_the_capability() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        for (label, mime, length, expected) in [
            (
                "over the ceiling",
                Some("text/plain"),
                Some(MAX_ATTACHMENT_BYTES as u64 + 1),
                "413",
            ),
            (
                "not the declared length",
                Some("text/plain"),
                Some(6),
                "400",
            ),
            ("not the declared mime", Some("image/png"), Some(5), "400"),
        ] {
            let (stream, flag) = tripwire();
            let refused = archive
                .accept_stub_upload(token, mime, length, stream)
                .await
                .expect_err(label);
            let status = match refused {
                DriveError::ContentTooLarge => "413",
                DriveError::InvalidArguments(_) => "400",
                _ => "other",
            };
            assert_eq!(status, expected, "{label}: {refused:?}");
            assert!(
                !pulled(&flag),
                "{label}: the body was pulled before the refusal"
            );
        }
        archive
            .accept_stub_upload(token, Some("text/plain"), Some(5), body(b"hello"))
            .await
            .expect("the capability survived every header refusal");
    }

    /// A body is not read past the byte that makes it unacceptable.
    #[tokio::test]
    async fn a_body_past_its_declaration_is_refused_at_the_first_extra_byte() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        let (rest, flag) = tripwire();
        let stream = futures::stream::once(async { Ok(Bytes::from_static(b"hello!")) })
            .chain(rest)
            .boxed();
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, stream)
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(
            !pulled(&flag),
            "the body was read past the first extra byte"
        );
    }

    /// A body the client broke off stores nothing and spends nothing.
    #[tokio::test]
    async fn an_interrupted_body_keeps_the_capability() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");
        let broken = futures::stream::iter([
            Ok(Bytes::from_static(b"he")),
            Err(std::io::Error::other("connection reset")),
        ])
        .boxed();
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("text/plain"), None, broken)
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("nothing landed"),
            DriveError::FileNotFound
        );
        archive
            .accept_stub_upload(token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the capability is still live");
    }

    /// Two PUTs racing one capability: the body that finishes first spends it;
    /// the other is refused at its commit and stores nothing.
    #[tokio::test]
    async fn a_second_upload_racing_the_first_loses_at_commit() {
        let archive = std::sync::Arc::new(StubDriveArchive::new("http://127.0.0.1:9"));
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session
            .upload_url
            .rsplit('/')
            .next()
            .expect("token")
            .to_string();
        let (sender, receiver) =
            futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let started = std::sync::Arc::new(tokio::sync::Notify::new());
        let seen = started.clone();
        let slow_body = receiver.inspect(move |_| seen.notify_one()).boxed();
        let slow = {
            let archive = archive.clone();
            let token = token.clone();
            tokio::spawn(async move {
                archive
                    .accept_stub_upload(&token, Some("text/plain"), None, slow_body)
                    .await
            })
        };
        sender
            .unbounded_send(Ok(Bytes::from_static(b"slow!")))
            .expect("send");
        started.notified().await;

        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"fast!"))
            .await
            .expect("the body that finishes first lands");
        drop(sender);
        assert_eq!(
            slow.await.expect("task"),
            Err(DriveError::FileNotFound),
            "the capability was spent while this body was still arriving"
        );
        let content = archive
            .file_content(&session.drive_file_id, 1024)
            .await
            .expect("content");
        assert_eq!(collect(content).await, b"fast!");
    }
}
