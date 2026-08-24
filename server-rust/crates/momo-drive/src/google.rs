//! Google Drive shared-drive archive (Swift `GoogleDriveArchiveClient`).
//!
//! The service account is a **member of the shared drive**, which is the 2026-07
//! storage decision this port keeps: momo never holds a user's Google
//! credentials, and every file it writes is owned by the workspace's drive
//! rather than by a person (ADR-0004 — provider credentials never flow in from a
//! request).
//!
//! ## Layout
//!
//! `<shared drive>/channels/<channel uuid>/<file>`. The two folder levels are
//! found-or-created on demand and memoised per channel, so a busy channel costs
//! one lookup for the life of the process rather than one per upload.
//!
//! ## The three calls the routes make, and why each is shaped this way
//!
//! * **`create_resumable_upload`** pre-allocates the file id (`files/generateIds`)
//!   *before* opening the session, so the id PostgreSQL stores is known even if
//!   the client never uploads a byte. Without it a pending row could not name the
//!   file it is waiting for, and an abandoned session would be unreapable.
//! * **`file_metadata`** asks for `driveId` and `trashed` and refuses anything
//!   that is not a live file **on the configured shared drive**. That predicate
//!   is the tenant boundary on the archive side: a `drive_file_id` that somehow
//!   pointed elsewhere resolves as access-denied rather than as content.
//! * **`file_content`** reads metadata first and enforces the ceiling twice —
//!   once against the declared size, then again against the bytes as they
//!   arrive. An archive that under-reports its size cannot make the proxy stream
//!   more than policy allows.
//!
//! Every failure collapses to a [`DriveError`] whose message names no upstream
//! detail. Google's own error bodies are never forwarded.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use futures::StreamExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    nonempty, upload_content_length_header_value, valid_drive_id, DriveArchive, DriveContent,
    DriveError, DriveFile, DriveUploadSession,
};

const DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD_API_BASE: &str = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
/// The only token endpoint a credential file may name. A service-account JSON is
/// operator-supplied, but pinning this means a swapped file cannot redirect the
/// signed assertion to a host of someone else's choosing.
const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

const API_TIMEOUT: Duration = Duration::from_secs(15);
const CONTENT_TIMEOUT: Duration = Duration::from_secs(60);
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);

/// The service-account fields this crate uses. `private_key` is never logged,
/// never returned, and never leaves this struct except as an [`EncodingKey`].
#[derive(Deserialize)]
struct ServiceAccountKey {
    #[serde(rename = "type")]
    key_type: String,
    client_email: String,
    private_key: String,
    token_uri: String,
}

/// The JWT-bearer assertion (RFC 7523) exchanged for an access token.
#[derive(Serialize)]
struct Assertion<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: String,
    token_type: String,
    expires_in: i64,
}

#[derive(Debug)]
struct CachedToken {
    token: String,
    /// Epoch seconds.
    expires_at: i64,
}

pub struct GoogleDriveArchive {
    shared_drive_id: String,
    client_email: String,
    signing_key: EncodingKey,
    http: reqwest::Client,
    token: Arc<Mutex<Option<CachedToken>>>,
    folders: Arc<Mutex<HashMap<Uuid, String>>>,
}

impl std::fmt::Debug for GoogleDriveArchive {
    /// Hand-written so a `{:?}` can never print the signing key.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GoogleDriveArchive")
            .field("shared_drive_id", &self.shared_drive_id)
            .field("client_email", &self.client_email)
            .finish_non_exhaustive()
    }
}

impl GoogleDriveArchive {
    /// Read the operator's service-account key and pin it to one shared drive.
    ///
    /// Every rejection is [`DriveError::Unavailable`], deliberately: a caller
    /// learns the archive is not usable and nothing about *why*, because the
    /// "why" is the shape of a credential file.
    pub fn new(
        sa_key_path: Option<&str>,
        shared_drive_id: Option<&str>,
    ) -> Result<GoogleDriveArchive, DriveError> {
        let key_path = nonempty(sa_key_path).ok_or(DriveError::Unavailable)?;
        let shared_drive_id = nonempty(shared_drive_id).ok_or(DriveError::Unavailable)?;
        if !valid_drive_id(shared_drive_id) {
            return Err(DriveError::Unavailable);
        }
        let raw = std::fs::read(key_path).map_err(|_| DriveError::Unavailable)?;
        let key: ServiceAccountKey =
            serde_json::from_slice(&raw).map_err(|_| DriveError::Unavailable)?;
        if key.key_type != "service_account"
            || key.token_uri != GOOGLE_TOKEN_URI
            || !key.client_email.contains('@')
            || key.private_key.is_empty()
        {
            return Err(DriveError::Unavailable);
        }
        let signing_key = EncodingKey::from_rsa_pem(key.private_key.as_bytes())
            .map_err(|_| DriveError::Unavailable)?;
        let http = reqwest::Client::builder()
            .build()
            .map_err(|_| DriveError::Unavailable)?;
        Ok(GoogleDriveArchive {
            shared_drive_id: shared_drive_id.to_string(),
            client_email: key.client_email,
            signing_key,
            http,
            token: Arc::new(Mutex::new(None)),
            folders: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// A live access token, minted on demand and reused until a minute before it
    /// expires (Swift's `> 60` guard).
    async fn access_token(&self) -> Result<String, DriveError> {
        let now = Utc::now().timestamp();
        let mut cached = self.token.lock().await;
        if let Some(current) = cached.as_ref() {
            if current.expires_at - now > 60 {
                return Ok(current.token.clone());
            }
        }
        let assertion = Assertion {
            iss: &self.client_email,
            scope: DRIVE_SCOPE,
            aud: GOOGLE_TOKEN_URI,
            iat: now,
            exp: now + 3600,
        };
        let signed = jsonwebtoken::encode(
            &Header::new(Algorithm::RS256),
            &assertion,
            &self.signing_key,
        )
        .map_err(|_| DriveError::UpstreamFailure)?;
        let response = self
            .http
            .post(GOOGLE_TOKEN_URI)
            .timeout(TOKEN_TIMEOUT)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", signed.as_str()),
            ])
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        if !response.status().is_success() {
            return Err(DriveError::UpstreamFailure);
        }
        let token: AccessTokenResponse = response
            .json()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        if !token.token_type.eq_ignore_ascii_case("bearer") || token.access_token.is_empty() {
            return Err(DriveError::UpstreamFailure);
        }
        *cached = Some(CachedToken {
            token: token.access_token.clone(),
            expires_at: now + token.expires_in.max(60),
        });
        Ok(token.access_token)
    }

    async fn get_json(&self, url: reqwest::Url) -> Result<Value, DriveError> {
        let token = self.access_token().await?;
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .timeout(API_TIMEOUT)
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        Self::decode_json(response).await
    }

    async fn post_json(&self, url: reqwest::Url, body: Value) -> Result<Value, DriveError> {
        let token = self.access_token().await?;
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .timeout(API_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        Self::decode_json(response).await
    }

    async fn decode_json(response: reqwest::Response) -> Result<Value, DriveError> {
        let status = response.status();
        if !status.is_success() {
            return Err(mapped_error(status.as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| DriveError::UpstreamFailure)
    }

    /// `<drive>/channels/<channel>` — memoised per channel.
    async fn channel_folder_id(&self, channel_id: Uuid) -> Result<String, DriveError> {
        if let Some(cached) = self.folders.lock().await.get(&channel_id) {
            return Ok(cached.clone());
        }
        let channels = self
            .find_or_create_folder("channels", &self.shared_drive_id.clone())
            .await?;
        let folder = self
            .find_or_create_folder(&channel_id.to_string().to_lowercase(), &channels)
            .await?;
        self.folders.lock().await.insert(channel_id, folder.clone());
        Ok(folder)
    }

    async fn find_or_create_folder(
        &self,
        name: &str,
        parent_id: &str,
    ) -> Result<String, DriveError> {
        let query = format!(
            "name = '{}' and '{}' in parents and mimeType = '{FOLDER_MIME}' and trashed = false",
            escape_query(name),
            escape_query(parent_id),
        );
        let search = build_url(
            DRIVE_API_BASE,
            "/files",
            &[
                ("corpora", "drive"),
                ("driveId", &self.shared_drive_id),
                ("includeItemsFromAllDrives", "true"),
                ("supportsAllDrives", "true"),
                ("q", &query),
                ("pageSize", "1"),
                ("fields", "files(id)"),
            ],
        )?;
        let found = self.get_json(search).await?;
        if let Some(id) = found
            .get("files")
            .and_then(Value::as_array)
            .and_then(|files| files.first())
            .and_then(|file| file.get("id"))
            .and_then(Value::as_str)
        {
            return Ok(id.to_string());
        }
        let create = build_url(
            DRIVE_API_BASE,
            "/files",
            &[("supportsAllDrives", "true"), ("fields", "id")],
        )?;
        let created = self
            .post_json(
                create,
                serde_json::json!({
                    "name": name,
                    "parents": [parent_id],
                    "mimeType": FOLDER_MIME,
                }),
            )
            .await?;
        created
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(DriveError::UpstreamFailure)
    }

    async fn generate_file_id(&self) -> Result<String, DriveError> {
        let url = build_url(
            DRIVE_API_BASE,
            "/files/generateIds",
            &[("count", "1"), ("space", "drive")],
        )?;
        let object = self.get_json(url).await?;
        object
            .get("ids")
            .and_then(Value::as_array)
            .and_then(|ids| ids.first())
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(DriveError::UpstreamFailure)
    }
}

#[async_trait]
impl DriveArchive for GoogleDriveArchive {
    async fn create_resumable_upload(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        let parent_id = self.channel_folder_id(channel_id).await?;
        let file_id = self.generate_file_id().await?;
        let url = build_url(
            UPLOAD_API_BASE,
            "/files",
            &[("uploadType", "resumable"), ("supportsAllDrives", "true")],
        )?;
        let token = self.access_token().await?;
        let mut request = self
            .http
            .post(url)
            .bearer_auth(token)
            .timeout(API_TIMEOUT)
            .header("X-Upload-Content-Type", mime);
        if let Some(length) = upload_content_length_header_value(size_bytes) {
            request = request.header("X-Upload-Content-Length", length);
        }
        let response = request
            .json(&serde_json::json!({
                "id": file_id,
                "name": name,
                "parents": [parent_id],
                "mimeType": mime,
            }))
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        if !response.status().is_success() {
            return Err(mapped_error(response.status().as_u16()));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or(DriveError::UpstreamFailure)?;
        // The session URL is handed to a browser. Refusing anything that is not
        // Google's own host is what keeps a compromised or confused upstream
        // from turning this route into an open redirect for file uploads.
        if !location.starts_with("https://www.googleapis.com/") {
            return Err(DriveError::UpstreamFailure);
        }
        Ok(DriveUploadSession {
            drive_file_id: file_id,
            upload_url: location,
        })
    }

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        if !valid_drive_id(file_id) {
            return Err(DriveError::InvalidArguments(
                "Drive file id is invalid".into(),
            ));
        }
        let url = build_url(
            DRIVE_API_BASE,
            &format!("/files/{file_id}"),
            &[
                ("supportsAllDrives", "true"),
                ("fields", "id,name,mimeType,size,driveId,trashed"),
            ],
        )?;
        let object = self.get_json(url).await?;
        let on_this_drive =
            object.get("driveId").and_then(Value::as_str) == Some(&self.shared_drive_id);
        let trashed = object.get("trashed").and_then(Value::as_bool) == Some(true);
        let id = object.get("id").and_then(Value::as_str);
        let name = object.get("name").and_then(Value::as_str);
        let mime = object.get("mimeType").and_then(Value::as_str);
        // Drive reports `size` as a *string* (it is an int64 over JSON's safe
        // range), so it is parsed rather than read as a number.
        let size = object
            .get("size")
            .and_then(Value::as_str)
            .and_then(|raw| raw.parse::<i64>().ok());
        match (on_this_drive, trashed, id, name, mime, size) {
            (true, false, Some(id), Some(name), Some(mime), Some(size_bytes)) => Ok(DriveFile {
                drive_file_id: id.to_string(),
                name: name.to_string(),
                mime: mime.to_string(),
                size_bytes,
            }),
            // A file on another drive, in the trash, or missing a field is not a
            // file this workspace may read. One answer for all of them so the
            // route cannot leak which.
            _ => Err(DriveError::AccessDenied),
        }
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        let metadata = self.file_metadata(file_id).await?;
        if metadata.size_bytes > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        let url = build_url(
            DRIVE_API_BASE,
            &format!("/files/{file_id}"),
            &[("alt", "media"), ("supportsAllDrives", "true")],
        )?;
        let token = self.access_token().await?;
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .timeout(CONTENT_TIMEOUT)
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        if !response.status().is_success() {
            return Err(mapped_error(response.status().as_u16()));
        }
        let upstream = Box::pin(response.bytes_stream());
        // The ceiling is re-checked against the bytes themselves: `size` came
        // from the same upstream that is now sending the body, so trusting it
        // alone would be trusting a claim to bound its own proof.
        let body = futures::stream::try_unfold(
            (upstream, 0i64),
            move |(mut upstream, mut received)| async move {
                match upstream.next().await {
                    None => Ok(None),
                    Some(Err(_)) => Err(DriveError::UpstreamFailure),
                    Some(Ok(chunk)) => {
                        received += chunk.len() as i64;
                        if received > max_bytes {
                            return Err(DriveError::ContentTooLarge);
                        }
                        Ok(Some((chunk, (upstream, received))))
                    }
                }
            },
        );
        Ok(DriveContent {
            mime: metadata.mime,
            size_bytes: metadata.size_bytes,
            body: Box::pin(body) as futures::stream::BoxStream<'static, Result<Bytes, DriveError>>,
        })
    }
}

/// Google's status codes → the archive's vocabulary (Swift `mappedError`).
fn mapped_error(status: u16) -> DriveError {
    match status {
        403 => DriveError::AccessDenied,
        404 => DriveError::FileNotFound,
        _ => DriveError::UpstreamFailure,
    }
}

fn build_url(base: &str, path: &str, query: &[(&str, &str)]) -> Result<reqwest::Url, DriveError> {
    let mut url =
        reqwest::Url::parse(&format!("{base}{path}")).map_err(|_| DriveError::UpstreamFailure)?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

/// Escape a value for interpolation into a Drive `q=` expression (Swift
/// `escapeQuery`). Backslash first, then the quote — the other order would
/// double-escape the backslash this function just inserted.
fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_malformed_configuration_never_yields_a_client() {
        assert_eq!(
            GoogleDriveArchive::new(None, Some("0ABC")).expect_err("no key path"),
            DriveError::Unavailable
        );
        assert_eq!(
            GoogleDriveArchive::new(Some("  "), Some("0ABC")).expect_err("blank key path"),
            DriveError::Unavailable
        );
        assert_eq!(
            GoogleDriveArchive::new(Some("/tmp/x.json"), None).expect_err("no drive id"),
            DriveError::Unavailable
        );
        assert_eq!(
            GoogleDriveArchive::new(Some("/tmp/x.json"), Some("../evil"))
                .expect_err("drive id alphabet"),
            DriveError::Unavailable
        );
    }

    /// A credential file that names a different token endpoint is refused —
    /// otherwise a swapped file could redirect the signed assertion.
    #[test]
    fn a_credential_that_redirects_the_token_exchange_is_refused() {
        let dir = std::env::temp_dir().join(format!("momo-drive-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let path = dir.join("sa.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "type": "service_account",
                "client_email": "archive@momo.iam.gserviceaccount.com",
                "private_key": "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
                "token_uri": "https://evil.example.com/token",
            }))
            .expect("json"),
        )
        .expect("write");
        assert_eq!(
            GoogleDriveArchive::new(path.to_str(), Some("0ABCdef")).expect_err("pinned token uri"),
            DriveError::Unavailable
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_drive_query_cannot_be_broken_out_of_with_a_quote() {
        assert_eq!(escape_query("o'brien"), "o\\'brien");
        assert_eq!(escape_query("a\\b"), "a\\\\b");
        // The pathological case: a name that tries to close the literal and
        // append its own predicate.
        assert_eq!(
            escape_query("' or '1'='1"),
            "\\' or \\'1\\'=\\'1",
            "every quote in a caller-supplied name stays inside the literal"
        );
    }

    #[test]
    fn a_url_carries_its_query_through_percent_encoding() {
        let url = build_url(
            DRIVE_API_BASE,
            "/files",
            &[("q", "name = 'a b'"), ("pageSize", "1")],
        )
        .expect("url");
        assert_eq!(url.path(), "/drive/v3/files");
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(pairs[0].0, "q");
        assert_eq!(pairs[0].1, "name = 'a b'");
        assert_eq!(pairs[1], ("pageSize".to_string(), "1".to_string()));
    }

    #[test]
    fn upstream_statuses_keep_their_distinct_meanings() {
        assert_eq!(mapped_error(403), DriveError::AccessDenied);
        assert_eq!(mapped_error(404), DriveError::FileNotFound);
        assert_eq!(mapped_error(500), DriveError::UpstreamFailure);
        assert_eq!(mapped_error(429), DriveError::UpstreamFailure);
    }
}
