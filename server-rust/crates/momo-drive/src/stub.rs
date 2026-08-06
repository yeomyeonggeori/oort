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
//! What it deliberately does NOT do is diverge from the session it was told
//! about: `file_metadata` reports the declared name/mime/size. A verifier that
//! could report something else would let the completion route's mismatch branch
//! be tested against the stub's imagination instead of against the route's
//! logic; a suite that wants that branch implements [`DriveArchive`] itself and
//! says so out loud.

use std::collections::HashMap;

use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};

#[derive(Debug, Clone)]
struct PendingUpload {
    file_id: String,
    name: String,
    mime: String,
    size_bytes: i64,
    bytes: Option<Vec<u8>>,
}

/// In-memory archive keyed by capability token.
#[derive(Debug, Default)]
pub struct StubDriveArchive {
    base_url: String,
    state: Mutex<StubState>,
}

#[derive(Debug, Default)]
struct StubState {
    sessions: HashMap<String, PendingUpload>,
    file_token: HashMap<String, String>,
}

impl StubDriveArchive {
    pub fn new(base_url: &str) -> StubDriveArchive {
        StubDriveArchive {
            base_url: base_url.trim_end_matches('/').to_string(),
            state: Mutex::new(StubState::default()),
        }
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
                bytes: None,
            },
        );
        state.file_token.insert(file_id.clone(), token.clone());
        Ok(DriveUploadSession {
            drive_file_id: file_id,
            upload_url: format!("{}/__momo_stub/drive/uploads/{token}", self.base_url),
        })
    }

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        let state = self.state.lock().await;
        let pending = state
            .file_token
            .get(file_id)
            .and_then(|token| state.sessions.get(token))
            .filter(|pending| pending.bytes.is_some())
            .ok_or(DriveError::FileNotFound)?;
        Ok(DriveFile {
            drive_file_id: pending.file_id.clone(),
            name: pending.name.clone(),
            mime: pending.mime.clone(),
            size_bytes: pending.size_bytes,
        })
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        let state = self.state.lock().await;
        let pending = state
            .file_token
            .get(file_id)
            .and_then(|token| state.sessions.get(token))
            .ok_or(DriveError::FileNotFound)?;
        let bytes = pending.bytes.clone().ok_or(DriveError::FileNotFound)?;
        if bytes.len() as i64 > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        let mime = pending.mime.clone();
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
        bytes: Vec<u8>,
    ) -> Result<(), DriveError> {
        let mut state = self.state.lock().await;
        let pending = state
            .sessions
            .get_mut(token)
            .ok_or(DriveError::FileNotFound)?;
        // The session declared a length; an upload of a different length is the
        // client contradicting itself, and Drive would reject it too.
        if bytes.len() as i64 != pending.size_bytes {
            return Err(DriveError::InvalidArguments(
                "uploaded size does not match the session".into(),
            ));
        }
        if let Some(mime) = mime {
            if !mime.is_empty() && mime != pending.mime {
                return Err(DriveError::InvalidArguments(
                    "uploaded mime does not match the session".into(),
                ));
            }
        }
        pending.bytes = Some(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

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
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
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
    async fn an_upload_that_contradicts_its_session_is_refused() {
        let archive = StubDriveArchive::new("http://127.0.0.1:9");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = session.upload_url.rsplit('/').next().expect("token");

        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("text/plain"), b"too long".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(token, Some("image/png"), b"hello".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            archive
                .accept_stub_upload("not-a-session", None, b"hello".to_vec())
                .await
                .expect_err("unknown token"),
            DriveError::FileNotFound
        );
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
            .accept_stub_upload(token, None, vec![0u8; 8])
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
}
