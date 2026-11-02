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
//!   more than policy allows. It serves the small-file callers (avatars,
//!   expression pictures, the agent's tools) and keeps its 60-second total limit.
//! * **`file_range`** is the content route's read (ADR-0151 증보 5 D3, #4671): one
//!   `alt=media` call with a server-built `Range: bytes=<s>-<e>`, no metadata call
//!   first, an exact 206 or a 502, and no total time limit — only a connect limit
//!   and a silence-between-chunks limit.
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
    nonempty, slice_body, upload_content_length_header_value, valid_drive_id, ByteRange,
    DriveArchive, DriveContent, DriveError, DriveFile, DriveRangeContent, DriveUploadSession,
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
/// A whole-object read for the small-file callers of [`DriveArchive::file_content`]
/// (avatars, pictures for expressions, the agent's tools). **Not** the content
/// route's read: [`DriveArchive::file_range`] has no total time limit at all.
const CONTENT_TIMEOUT: Duration = Duration::from_secs(60);
const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a connection may take to open. Set on the client, so it covers every
/// call this archive makes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the upstream may stay silent — before its response headers and
/// between two chunks of its body (ADR-0151 증보 5 D3). The clock **restarts on
/// every read**, so a 300 MiB range that keeps flowing is never cut; a stalled
/// connection is, after this long. It replaces the content read's old 60-second
/// *total* limit, which cut a 300 MiB body off mid-stream for any reader slower
/// than about 42 Mbit/s after `Content-Length` had already gone out.
pub(crate) const CONTENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// How long this archive waits on Google. **One value of this type decides every
/// clock the archive's HTTP client has, and it has no field for a total**: a limit
/// on the whole request is what cut 300 MiB bodies off mid-stream, and nothing may
/// be able to bring it back by setting a field. The API calls keep their own
/// per-request totals (`API_TIMEOUT`, `TOKEN_TIMEOUT`, and `CONTENT_TIMEOUT` for
/// the small-file `file_content`); those are set on the request, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Limits {
    /// How long a connection may take to open.
    connect: Duration,
    /// How long the upstream may stay silent — before its response headers and
    /// between two chunks of its body. The clock restarts on every read.
    idle: Duration,
}

impl Limits {
    /// What every archive built from a real key runs with. This is the one place
    /// the two constants above meet; a test pins their values and another builds
    /// an archive the way [`GoogleDriveArchive::new`] does and reads them back.
    const PRODUCTION: Limits = Limits {
        connect: CONNECT_TIMEOUT,
        idle: CONTENT_IDLE_TIMEOUT,
    };
}

/// Everything a [`GoogleDriveArchive`] is assembled from. There is exactly one way
/// to make one — [`GoogleDriveArchive::from_parts`] — so the real archive and this
/// crate's tests' stand-in cannot disagree about how the HTTP client is built.
struct Parts {
    shared_drive_id: String,
    client_email: String,
    signing_key: EncodingKey,
    api_base: String,
    token: Option<CachedToken>,
    limits: Limits,
}

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
    /// What `http` was built with ([`Limits::PRODUCTION`] for a real archive).
    limits: Limits,
    /// The Drive v3 base every call is made against: [`DRIVE_API_BASE`] always,
    /// except in this crate's own tests, which point it at a recording stand-in
    /// on 127.0.0.1. There is no way to set it from outside the crate.
    api_base: String,
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
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl GoogleDriveArchive {
    /// Read the operator's service-account key and pin it to one shared drive.
    ///
    /// Every rejection is [`DriveError::Unavailable`], deliberately: a caller
    /// learns the archive is not usable and nothing about *why*, because the
    /// "why" is the shape of a credential file.
    ///
    /// This only names the strict RSA parser and forwards. Everything else — the
    /// file's shape, the pinned token endpoint, [`Limits::PRODUCTION`], the Drive
    /// base — lives in [`Self::open`], which tests run end to end.
    pub fn new(
        sa_key_path: Option<&str>,
        shared_drive_id: Option<&str>,
    ) -> Result<GoogleDriveArchive, DriveError> {
        Self::open(sa_key_path, shared_drive_id, |pem| {
            EncodingKey::from_rsa_pem(pem).ok()
        })
    }

    /// [`Self::new`] with the one step a test cannot do for real — turning the
    /// private key's PEM text into a signing key (no real RSA key is kept in this
    /// repository) — as a parameter. Everything a production archive is made of is
    /// chosen **here**, and an archive from here is what the production-limits test
    /// reads back.
    fn open(
        sa_key_path: Option<&str>,
        shared_drive_id: Option<&str>,
        parse_key: impl FnOnce(&[u8]) -> Option<EncodingKey>,
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
        let signing_key = parse_key(key.private_key.as_bytes()).ok_or(DriveError::Unavailable)?;
        Self::from_parts(Parts {
            shared_drive_id: shared_drive_id.to_string(),
            client_email: key.client_email,
            signing_key,
            api_base: DRIVE_API_BASE.to_string(),
            token: None,
            limits: Limits::PRODUCTION,
        })
    }

    /// The one constructor: the real archive ([`Self::open`]) and the tests'
    /// stand-in both end here, so the HTTP client is built in exactly one place.
    fn from_parts(parts: Parts) -> Result<GoogleDriveArchive, DriveError> {
        let http = http_client(parts.limits).map_err(|_| DriveError::Unavailable)?;
        Ok(GoogleDriveArchive {
            shared_drive_id: parts.shared_drive_id,
            client_email: parts.client_email,
            signing_key: parts.signing_key,
            http,
            limits: parts.limits,
            api_base: parts.api_base,
            token: Arc::new(Mutex::new(parts.token)),
            folders: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// An archive that talks to a stand-in on 127.0.0.1 with a bearer token it
    /// already holds — no key file, no token exchange, no network beyond the
    /// loopback. Compiled for this crate's tests only, so the pinned endpoints in
    /// [`GoogleDriveArchive::new`] cannot be bypassed by anything that ships. It is
    /// built by [`Self::from_parts`], like the real one; only the idle limit is the
    /// test's to choose (the connect limit is production's).
    #[cfg(test)]
    pub(crate) fn against_stand_in(api_base: &str, idle_timeout: Duration) -> GoogleDriveArchive {
        Self::from_parts(Parts {
            shared_drive_id: "0StandInDrive".to_string(),
            client_email: "stand-in@momo.test".to_string(),
            signing_key: EncodingKey::from_secret(b"stand-in"),
            api_base: api_base.trim_end_matches('/').to_string(),
            token: Some(CachedToken {
                token: "stand-in-token".to_string(),
                expires_at: i64::MAX,
            }),
            limits: Limits {
                connect: CONNECT_TIMEOUT,
                idle: idle_timeout,
            },
        })
        .expect("a client with only timeouts builds")
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
            &self.api_base,
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
            &self.api_base,
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
            &self.api_base,
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
            &self.api_base,
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

    async fn delete_file(&self, file_id: &str) -> Result<(), DriveError> {
        if !valid_drive_id(file_id) {
            return Err(DriveError::InvalidArguments(
                "Drive file id is invalid".into(),
            ));
        }
        // Never delete what is not on this archive's shared drive: the service
        // account may see other files, and a stored id is only a string.
        let probe = build_url(
            &self.api_base,
            &format!("/files/{file_id}"),
            &[("supportsAllDrives", "true"), ("fields", "id,driveId")],
        )?;
        match self.get_json(probe).await {
            Ok(object) => {
                if object.get("driveId").and_then(Value::as_str) != Some(&self.shared_drive_id) {
                    return Err(DriveError::AccessDenied);
                }
            }
            Err(error) => return delete_outcome_of_probe_error(error),
        }
        let url = build_url(
            &self.api_base,
            &format!("/files/{file_id}"),
            &[("supportsAllDrives", "true")],
        )?;
        let token = self.access_token().await?;
        let response = self
            .http
            .delete(url)
            .bearer_auth(token)
            .timeout(API_TIMEOUT)
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        delete_status_outcome(response.status().as_u16())
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
            &self.api_base,
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

    /// One range of one object, forwarded to Drive (ADR-0151 증보 5 D3, #4671).
    ///
    /// * **One call, no metadata first.** The caller already holds the row's size
    ///   and mime, so the preliminary `files.get` that [`Self::file_content`]
    ///   makes is gone; the total comes from the 206's `Content-Range`. (The
    ///   shared-drive predicate that call carried is still applied where it
    ///   matters most — [`Self::file_metadata`] runs it when an upload
    ///   `complete`s, and the id stored in PostgreSQL is one this archive minted.)
    /// * **Drive is sent `bytes=<start>-<end>` built from two integers** — never
    ///   the client's header text, a list of ranges, or anything of unbounded
    ///   length.
    /// * **An exact 206 is accepted, and one narrow 200.** Anything else is the
    ///   archive disagreeing with the caller, who resolved the range against its
    ///   own record of the object: a 200 for a partial range (Drive ignored
    ///   `Range`; passing its whole body on as a range would be wrong bytes under
    ///   a 206), a 416 (the object is shorter than the row says), a
    ///   `Content-Range` for other bytes or with a total of `*`. All of those are
    ///   [`DriveError::UpstreamFailure`] (502); the total of a good one is handed
    ///   back for the caller to compare with the row.
    /// * **The one 200 taken** is Drive answering a request for the *whole* object
    ///   with the whole object, which RFC 9110 allows a server to do (every
    ///   download without a `Range` header is such a request here: the route asks
    ///   `0..=size-1`). It is taken only when it can be proven to be exactly the
    ///   bytes asked for: the request began at 0 and the 200's `Content-Length` —
    ///   the length of the whole object it is sending — equals the length asked
    ///   for. A 200 of any other length, or with no `Content-Length` to check, is
    ///   refused like any other 200.
    /// * **No total time limit.** The client's connect limit and its idle limit
    ///   (the clock restarts on every read) are the only clocks, so a body that
    ///   keeps flowing is never cut.
    async fn file_range(
        &self,
        file_id: &str,
        range: ByteRange,
        max_bytes: i64,
    ) -> Result<DriveRangeContent, DriveError> {
        if !valid_drive_id(file_id) {
            return Err(DriveError::InvalidArguments(
                "Drive file id is invalid".into(),
            ));
        }
        // A range that reaches the ceiling cannot be inside an object the policy
        // allows.
        if u64::try_from(max_bytes).map_or(true, |ceiling| range.end() >= ceiling) {
            return Err(DriveError::ContentTooLarge);
        }
        let url = build_url(
            &self.api_base,
            &format!("/files/{file_id}"),
            &[("alt", "media"), ("supportsAllDrives", "true")],
        )?;
        let token = self.access_token().await?;
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .header(
                reqwest::header::RANGE,
                format!("bytes={}-{}", range.start(), range.end()),
            )
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        let status = response.status();
        let total_size_bytes = if status == reqwest::StatusCode::PARTIAL_CONTENT {
            let (first, last, total) = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range)
                .ok_or(DriveError::UpstreamFailure)?;
            if first != range.start() || last != range.end() {
                return Err(DriveError::UpstreamFailure);
            }
            i64::try_from(total).map_err(|_| DriveError::UpstreamFailure)?
        } else if answers_with_the_whole_object(&response, range) {
            // The object is exactly as long as the range asked for, so the range
            // was the whole object: its length is the object's total.
            i64::try_from(range.length()).map_err(|_| DriveError::UpstreamFailure)?
        } else {
            return Err(mapped_error(status.as_u16()));
        };
        if total_size_bytes > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        if response
            .content_length()
            .is_some_and(|announced| announced != range.length())
        {
            return Err(DriveError::UpstreamFailure);
        }
        let upstream = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|_| DriveError::UpstreamFailure))
            .boxed();
        // Exactly the bytes that were asked for: a body that ends early is an
        // error item, and one that runs on is cut where the range ends.
        let whole = ByteRange::new(0, range.length() - 1).ok_or(DriveError::UpstreamFailure)?;
        Ok(DriveRangeContent {
            total_size_bytes,
            body: slice_body(upstream, whole),
        })
    }
}

/// The HTTP client's builder for `limits`: a connect limit, and a limit on how
/// long the upstream may stay silent (before its headers and between two chunks of
/// its body) — **no limit on the whole request**, which is what lets a 300 MiB
/// range that keeps flowing finish. Kept apart from [`http_client`] so a test can
/// read the configured values back (a built client does not show its connect
/// limit).
fn http_client_builder(limits: Limits) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(limits.connect)
        .read_timeout(limits.idle)
}

/// The one HTTP client this archive uses, for the real archive and the tests'
/// stand-in alike. The API calls keep their own per-request totals.
fn http_client(limits: Limits) -> Result<reqwest::Client, reqwest::Error> {
    http_client_builder(limits).build()
}

/// Whether `response` is Drive answering a request for the **whole** object with
/// the whole object: a `200`, to a range that began at 0, whose `Content-Length`
/// (the length of the whole object it is sending) is exactly the length asked
/// for. Then the object is that long and the range covered all of it. Anything
/// else — a 200 of another length (Drive ignored a partial `Range`), a 200 with no
/// `Content-Length` — cannot be proven to be the bytes asked for.
fn answers_with_the_whole_object(response: &reqwest::Response, range: ByteRange) -> bool {
    response.status() == reqwest::StatusCode::OK
        && range.start() == 0
        && response.content_length() == Some(range.length())
}

/// `bytes <first>-<last>/<total>` — the one form a 206 for a single range
/// carries. Every number is digits only and at most twenty of them (and so fits
/// a `u64` or is refused), and `first <= last < total`. Anything else — a `*`
/// total, a sign, a space, an inverted span — is a header this archive does not
/// trust.
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (span, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (first, last) = span.split_once('-')?;
    let (first, last, total) = (decimal(first)?, decimal(last)?, decimal(total)?);
    (first <= last && last < total).then_some((first, last, total))
}

fn decimal(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Google's status codes → the archive's vocabulary (Swift `mappedError`).
/// The outcome of a Drive `DELETE`: gone (200/204) and already-gone (404/410)
/// are both success — that is what makes a re-run safe.
fn delete_status_outcome(status: u16) -> Result<(), DriveError> {
    match status {
        200..=299 | 404 | 410 => Ok(()),
        other => Err(mapped_error(other)),
    }
}

/// A failed pre-delete probe: not found is "already gone" (success); every
/// other failure stands, so an unreachable Drive is never read as a deletion.
fn delete_outcome_of_probe_error(error: DriveError) -> Result<(), DriveError> {
    match error {
        DriveError::FileNotFound => Ok(()),
        other => Err(other),
    }
}

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

    /// A service-account key file of the right shape whose private key is **not**
    /// a key: no real RSA key is kept in this repository (a committed private key is
    /// a secret to every scanner), so these tests replace only the one step that
    /// needs one — see [`GoogleDriveArchive::open`].
    struct KeyFile(std::path::PathBuf);

    impl KeyFile {
        fn new() -> KeyFile {
            let dir = std::env::temp_dir().join(format!("momo-drive-limits-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("tmp dir");
            let path = dir.join("sa.json");
            std::fs::write(
                &path,
                serde_json::to_vec(&serde_json::json!({
                    "type": "service_account",
                    "client_email": "archive@momo.iam.gserviceaccount.com",
                    "private_key": "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
                    "token_uri": GOOGLE_TOKEN_URI,
                }))
                .expect("json"),
            )
            .expect("write");
            KeyFile(path)
        }

        fn path(&self) -> Option<&str> {
            self.0.to_str()
        }
    }

    impl Drop for KeyFile {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                std::fs::remove_dir_all(dir).ok();
            }
        }
    }

    fn lenient_key(_pem: &[u8]) -> Option<EncodingKey> {
        Some(EncodingKey::from_secret(b"test"))
    }

    /// **Red proof (review M-1).** The two limits a real archive runs with are
    /// fixed by a test, so raising or dropping either is a decision somebody makes
    /// here, on purpose.
    #[test]
    fn the_production_limits_are_the_two_the_content_read_depends_on() {
        assert_eq!(
            Limits::PRODUCTION,
            Limits {
                connect: Duration::from_secs(10),
                idle: Duration::from_secs(30),
            }
        );
        // The idle limit replaced a 60-second total limit; one at or past it would
        // give the cut-off protection back for nothing.
        assert!(CONTENT_IDLE_TIMEOUT < CONTENT_TIMEOUT);
    }

    /// **Red proof (review M-1).** An archive built from a key file the way the
    /// real constructor builds it — through the one `from_parts` the tests' stand-in
    /// also ends in — carries the production limits and the pinned Drive endpoint,
    /// read back from the archive and from its HTTP client. `new` is the same call
    /// with the strict RSA parser: this file's "key" is not one, so it refuses it
    /// (put a lenient parser in `new` and this goes red).
    ///
    /// Make `open` choose another idle limit and the client reads another
    /// `read_timeout`; make `from_parts` ignore the limits it is given and the same.
    #[test]
    fn an_archive_built_from_a_key_file_has_the_production_limits_and_the_pinned_endpoint() {
        let key = KeyFile::new();
        let archive = GoogleDriveArchive::open(key.path(), Some("0ABCdef"), lenient_key)
            .expect("a key file of the right shape opens");
        assert_eq!(archive.limits, Limits::PRODUCTION);
        assert!(
            format!("{archive:?}").contains("connect: 10s, idle: 30s"),
            "{archive:?}"
        );
        let client = format!("{:?}", archive.http);
        assert!(client.contains("read_timeout: 30s"), "{client}");
        assert!(
            !client.contains("TotalTimeout"),
            "the client has no limit on the whole request: {client}"
        );
        assert_eq!(archive.api_base, DRIVE_API_BASE);
        assert_eq!(
            GoogleDriveArchive::new(key.path(), Some("0ABCdef"))
                .expect_err("the strict parser refuses a PEM that is not a key"),
            DriveError::Unavailable
        );
    }

    /// **Red proof (review M-1).** The client is built from the limits it is given,
    /// connect limit included (a built client does not show it, its builder does),
    /// and it has no limit on the whole request. The last lines show the probe can
    /// see a total limit when there is one — so "none" above is a measurement.
    #[test]
    fn the_client_is_built_from_its_limits_and_has_no_limit_on_the_whole_request() {
        let limits = Limits {
            connect: Duration::from_secs(3),
            idle: Duration::from_secs(7),
        };
        let builder = format!("{:?}", http_client_builder(limits));
        assert!(builder.contains("connect_timeout: 3s"), "{builder}");
        assert!(
            !builder
                .replace("connect_timeout: 3s", "")
                .contains("timeout:"),
            "no total on the builder: {builder}"
        );
        let client = format!("{:?}", http_client(limits).expect("a client"));
        assert!(client.contains("read_timeout: 7s"), "{client}");
        assert!(!client.contains("TotalTimeout"), "{client}");

        let with_total = reqwest::Client::builder().timeout(Duration::from_secs(60));
        assert!(format!("{with_total:?}").contains("timeout: 60s"));
        let with_total = with_total.build().expect("a client");
        assert!(format!("{with_total:?}").contains("TotalTimeout"));
    }

    /// **Red proof (review M-1).** No limit on the whole request is set in the
    /// content read, whatever its value: the behavioural tests only notice a total
    /// shorter than they run, and a total of ten minutes would still cut a slow
    /// 300 MiB read. The text of `file_range` is checked because that is where a
    /// `.timeout(` on the request would be written.
    #[test]
    fn the_content_read_sets_no_limit_on_the_whole_request() {
        let source = include_str!("google.rs");
        let start = source
            .find("    async fn file_range(")
            .expect("the content read");
        let end = start
            + source[start..]
                .find("\n}\n")
                .expect("the end of the impl that holds it");
        let content_read = &source[start..end];
        assert!(content_read.contains(".send()"), "found the wrong text");
        assert!(
            !content_read.contains(".timeout("),
            "the content read must not set a limit on the whole request"
        );
    }

    #[test]
    fn delete_treats_gone_and_already_gone_as_success_and_nothing_else() {
        for ok in [200u16, 204, 404, 410] {
            assert_eq!(delete_status_outcome(ok), Ok(()), "{ok}");
        }
        assert_eq!(delete_status_outcome(403), Err(DriveError::AccessDenied));
        for bad in [400u16, 401, 429, 500, 503] {
            assert_eq!(
                delete_status_outcome(bad),
                Err(DriveError::UpstreamFailure),
                "{bad}"
            );
        }
        assert_eq!(
            delete_outcome_of_probe_error(DriveError::FileNotFound),
            Ok(())
        );
        assert_eq!(
            delete_outcome_of_probe_error(DriveError::UpstreamFailure),
            Err(DriveError::UpstreamFailure)
        );
        assert_eq!(
            delete_outcome_of_probe_error(DriveError::AccessDenied),
            Err(DriveError::AccessDenied)
        );
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
