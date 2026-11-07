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
    nonempty, received_size_within_ceiling, slice_body, upload_content_length_header_value,
    valid_drive_id, ByteRange, DriveArchive, DriveContent, DriveError, DriveFile,
    DriveRangeContent, DriveUploadSession,
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
    /// Where resumable sessions are requested and which session address the bytes may go to.
    upload: UploadEndpoint,
    token: Option<CachedToken>,
    limits: Limits,
}

/// Where Google's resumable upload lives, and which session address this process will send bytes to
/// (ADR-0151 증보 8 W7, review L6; implementation review round 2, L-3). A real archive always has
/// [`UploadEndpoint::google`]. This crate's own tests build one that points at a stand-in on
/// 127.0.0.1, so the **same** assembly — session request, the `Location` check, the pin, the `PUT`,
/// the read-back and the take-back — runs against a recording server instead of Google. The judgement
/// is the same code with other data; there is no way to set the data from outside the crate.
#[derive(Debug, Clone, PartialEq, Eq)]
struct UploadEndpoint {
    /// The upload base a resumable session is requested from.
    base: String,
    /// The scheme a session address must have.
    scheme: String,
    /// The host a session address must have.
    host: String,
    /// The explicit port a session address must carry (`None`: none at all).
    port: Option<u16>,
}

impl UploadEndpoint {
    /// Google's own: `https://www.googleapis.com/upload/drive/v3`, no explicit port. A test pins these
    /// values and reads them back from an archive built the way the real constructor builds one.
    fn google() -> UploadEndpoint {
        UploadEndpoint {
            base: UPLOAD_API_BASE.to_string(),
            scheme: "https".to_string(),
            host: "www.googleapis.com".to_string(),
            port: None,
        }
    }

    /// What the address a session request answers with must start with — the textual check
    /// [`GoogleDriveArchive::create_resumable_upload`] makes before it hands the address on (to a
    /// browser, or to [`pinned_session_url`]). For Google: `https://www.googleapis.com/`.
    fn session_prefix(&self) -> String {
        match self.port {
            Some(port) => format!("{}://{}:{port}/", self.scheme, self.host),
            None => format!("{}://{}/", self.scheme, self.host),
        }
    }
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
    /// Where sessions are requested and which session address bytes may go to:
    /// [`UploadEndpoint::google`] always, except in this crate's own tests.
    upload: UploadEndpoint,
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
            upload: UploadEndpoint::google(),
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
            upload: parts.upload,
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
            upload: UploadEndpoint::google(),
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

    /// [`Self::against_stand_in`] for a stand-in that plays Google's **upload** endpoint as well, at
    /// `origin` (`http://127.0.0.1:<port>`): the Drive API is `<origin>/drive/v3`, a session is requested
    /// from `<origin>/upload/drive/v3`, and a session address must be on that scheme, host and port and
    /// under `/upload/` — the judgement a real archive makes, with the data pointed at the loopback.
    /// Compiled for this crate's tests only, like [`Self::against_stand_in`].
    #[cfg(test)]
    pub(crate) fn against_upload_stand_in(
        origin: &str,
        idle_timeout: Duration,
    ) -> GoogleDriveArchive {
        let origin = origin.trim_end_matches('/');
        let parsed = reqwest::Url::parse(origin).expect("a stand-in origin is an address");
        let mut archive = Self::against_stand_in(&format!("{origin}/drive/v3"), idle_timeout);
        archive.upload = UploadEndpoint {
            base: format!("{origin}/upload/drive/v3"),
            scheme: parsed.scheme().to_string(),
            host: parsed
                .host_str()
                .expect("a stand-in has a host")
                .to_string(),
            port: parsed.port(),
        };
        archive
    }

    /// Send `bytes` to an already-pinned resumable session with one `PUT` (ADR-0151 증보 8 W7, L6).
    /// A client of its own so that **no redirect is followed** (a 3xx is an answer, not a place to
    /// send the bytes) and no bearer is attached. `200` and `201` are the only successes: `308`
    /// (resume incomplete) means the object is not whole, and everything else maps to the archive's
    /// closed words.
    async fn put_to_session(
        &self,
        url: reqwest::Url,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<(), DriveError> {
        let client = http_client_builder(self.limits)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| DriveError::UpstreamFailure)?;
        let response = client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, mime)
            .timeout(CONTENT_TIMEOUT)
            .body(bytes)
            .send()
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
        match response.status().as_u16() {
            200 | 201 => Ok(()),
            status => Err(mapped_error(status)),
        }
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
    fn backend_kind(&self) -> &'static str {
        "google"
    }

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
            &self.upload.base,
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
        if !location.starts_with(&self.upload.session_prefix()) {
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

    /// ADR-0151 증보 8 W7 (#5371): the server writes one object it holds. A resumable session is created
    /// the ordinary way, then **this process** sends the bytes to it with one `PUT`.
    ///
    /// Review L6: the session address is the first address this process ever sends bytes to that
    /// Google chose, so it is **pinned** ([`pinned_session_url`]: https, `www.googleapis.com`, an
    /// `/upload/` path, no userinfo and no port) and the `PUT` follows no redirect and carries no
    /// bearer (the address is its own capability). Whatever the archive then holds is read back and
    /// must be what was sent; otherwise the object is removed and the write fails. Errors are the
    /// archive's closed words only — nothing Google said, nothing of the address.
    async fn put_object(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<DriveFile, DriveError> {
        let size = i64::try_from(bytes.len()).map_err(|_| DriveError::ContentTooLarge)?;
        if !received_size_within_ceiling(size) {
            return Err(DriveError::ContentTooLarge);
        }
        let session = self
            .create_resumable_upload(channel_id, name, mime, size)
            .await?;
        let url = pinned_session_url(&session.upload_url, &self.upload)?;
        self.put_to_session(url, mime, bytes).await?;
        let file = self.file_metadata(&session.drive_file_id).await?;
        if file.drive_file_id != session.drive_file_id
            || file.size_bytes != size
            || file.mime != mime
        {
            // The archive holds something other than what was sent: take it back, fail closed.
            let _ = self.delete_file(&session.drive_file_id).await;
            return Err(DriveError::UpstreamFailure);
        }
        Ok(file)
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

/// The one place a resumable **session address** is judged before bytes go to it (ADR-0151 증보 8 W7,
/// review L6): for Google (`endpoint` = [`UploadEndpoint::google`]) `https`, host exactly
/// `www.googleapis.com`, no userinfo, no explicit port, a path under `/upload/`. Anything else — another
/// host, `http`, a look-alike such as `www.googleapis.com.evil.test` or `www.googleapis.com@evil.test`, a
/// port, another path — is the archive failing, and no byte is sent.
fn pinned_session_url(raw: &str, endpoint: &UploadEndpoint) -> Result<reqwest::Url, DriveError> {
    let url = reqwest::Url::parse(raw).map_err(|_| DriveError::UpstreamFailure)?;
    let pinned = url.scheme() == endpoint.scheme
        && url.host_str() == Some(endpoint.host.as_str())
        && url.username().is_empty()
        && url.password().is_none()
        && url.port() == endpoint.port
        && url.path().starts_with("/upload/");
    if pinned {
        Ok(url)
    } else {
        Err(DriveError::UpstreamFailure)
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

    /// ADR-0151 증보 8 L6 (WA10): only Google's own upload endpoint is a place the server's picture
    /// bytes may go. Every look-alike is refused before a byte is sent.
    #[test]
    fn a_session_address_is_pinned_to_googles_upload_endpoint() {
        for good in [
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=AbC",
            "https://www.googleapis.com/upload/drive/v3/files",
        ] {
            assert!(
                pinned_session_url(good, &UploadEndpoint::google()).is_ok(),
                "{good}"
            );
        }
        for bad in [
            "http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
            "https://www.googleapis.com.evil.test/upload/drive/v3/files",
            "https://www.googleapis.com@evil.test/upload/drive/v3/files",
            "https://user:pw@www.googleapis.com/upload/drive/v3/files",
            "https://www.googleapis.com:8443/upload/drive/v3/files",
            "https://www.googleapis.com/drive/v3/files",
            "https://www.googleapis.com/UPLOAD/drive/v3/files",
            "https://evil.test/upload/drive/v3/files",
            "https://upload.googleapis.com/upload/drive/v3/files",
            "https://127.0.0.1/upload/drive/v3/files",
            "file:///upload/x",
            "not a url",
            "",
        ] {
            assert_eq!(
                pinned_session_url(bad, &UploadEndpoint::google()).expect_err(bad),
                DriveError::UpstreamFailure,
                "{bad}"
            );
        }
    }

    /// A one-request-at-a-time loopback server that records what a `PUT` looked like and answers a
    /// scripted status (with an optional `Location`). Hand-rolled over `tokio::net`: this crate has no
    /// HTTP-server dependency by contract.
    struct PutStandIn {
        address: std::net::SocketAddr,
        seen: Arc<std::sync::Mutex<Vec<SeenPut>>>,
    }

    #[derive(Debug, Clone)]
    struct SeenPut {
        method: String,
        path: String,
        content_type: Option<String>,
        authorization: bool,
        body_len: usize,
    }

    async fn put_stand_in(status: u16, location: Option<String>) -> PutStandIn {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let log = log.clone();
                let location = location.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(1) => head.push(byte[0]),
                            _ => return,
                        }
                    }
                    let text = String::from_utf8_lossy(&head).into_owned();
                    let mut lines = text.split("\r\n");
                    let request_line = lines.next().unwrap_or_default().to_string();
                    let mut parts = request_line.split(' ');
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or_default().to_string();
                    let mut content_type = None;
                    let mut authorization = false;
                    let mut length = 0usize;
                    for line in lines {
                        if let Some((name, value)) = line.split_once(':') {
                            match name.trim().to_ascii_lowercase().as_str() {
                                "content-type" => content_type = Some(value.trim().to_string()),
                                "authorization" => authorization = true,
                                "content-length" => length = value.trim().parse().unwrap_or(0),
                                _ => {}
                            }
                        }
                    }
                    let mut body = vec![0u8; length];
                    if socket.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    log.lock().expect("log").push(SeenPut {
                        method,
                        path,
                        content_type,
                        authorization,
                        body_len: body.len(),
                    });
                    let mut reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n"
                    );
                    if let Some(location) = location {
                        reply.push_str(&format!("Location: {location}\r\n"));
                    }
                    reply.push_str("\r\n");
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        PutStandIn { address, seen }
    }

    fn archive_for_put() -> GoogleDriveArchive {
        GoogleDriveArchive::against_stand_in("http://127.0.0.1:9/drive/v3", Duration::from_secs(5))
    }

    /// WA10 (Google gate): the bytes go to the session in one `PUT` with the picture's own type and
    /// length, and **no bearer**; only 200 and 201 are a stored object; 308 (not whole), a refusal and
    /// a failure are the archive's closed words; a redirect is an answer, not a place to send the bytes.
    #[tokio::test]
    async fn the_bytes_go_to_the_session_in_one_put_without_a_bearer_and_follow_nothing() {
        let bytes = vec![7u8; 1234];
        for (status, expected) in [
            (200u16, Ok(())),
            (201, Ok(())),
            (308, Err(DriveError::UpstreamFailure)),
            (403, Err(DriveError::AccessDenied)),
            (404, Err(DriveError::FileNotFound)),
            (500, Err(DriveError::UpstreamFailure)),
        ] {
            let server = put_stand_in(status, None).await;
            let url: reqwest::Url = format!(
                "http://{}/upload/drive/v3/files?upload_id=z",
                server.address
            )
            .parse()
            .expect("url");
            let got = archive_for_put()
                .put_to_session(url, "image/png", bytes.clone())
                .await;
            assert_eq!(got, expected, "status {status}");
            let seen = server.seen.lock().expect("log").clone();
            assert_eq!(seen.len(), 1, "status {status}: one PUT and no more");
            assert_eq!(seen[0].method, "PUT");
            assert_eq!(seen[0].path, "/upload/drive/v3/files?upload_id=z");
            assert_eq!(seen[0].content_type.as_deref(), Some("image/png"));
            assert_eq!(seen[0].body_len, bytes.len());
            assert!(
                !seen[0].authorization,
                "the session address is its own capability"
            );
        }
        // a redirect: the second server must see nothing
        let second = put_stand_in(200, None).await;
        let first = put_stand_in(302, Some(format!("http://{}/elsewhere", second.address))).await;
        let url: reqwest::Url = format!("http://{}/upload/x", first.address)
            .parse()
            .expect("url");
        let got = archive_for_put()
            .put_to_session(url, "image/png", bytes.clone())
            .await;
        assert_eq!(got, Err(DriveError::UpstreamFailure));
        assert_eq!(first.seen.lock().expect("log").len(), 1);
        assert!(
            second.seen.lock().expect("log").is_empty(),
            "the bytes were sent to wherever a redirect pointed"
        );
    }

    /// One request the whole-Google stand-in understood.
    #[derive(Debug, Clone)]
    struct SeenCall {
        method: String,
        /// The path without its query.
        path: String,
        authorization: bool,
        content_type: Option<String>,
        /// `X-Upload-Content-Length`: the size a session request declares.
        declared_length: Option<String>,
        body_len: usize,
    }

    /// What Drive reports for the object once the bytes were sent.
    #[derive(Debug, Clone)]
    struct Stored {
        id: &'static str,
        size: i64,
        mime: &'static str,
    }

    /// A loopback server that plays **all** of Google for one `put_object` — the two folder lookups, the
    /// file id, the resumable session, the `PUT`, the metadata read-back and the delete — and records every
    /// request it understood, in order. Hand-rolled over `tokio::net` like [`put_stand_in`], one request per
    /// connection. `session_address` is what the session request answers as `Location`; `{origin}`,
    /// `{authority}` and `{port}` in it stand for this server's own `http://127.0.0.1:<port>`,
    /// `127.0.0.1:<port>` and `<port>`.
    struct GoogleStandIn {
        origin: String,
        seen: Arc<std::sync::Mutex<Vec<SeenCall>>>,
    }

    impl GoogleStandIn {
        fn calls(&self) -> Vec<SeenCall> {
            self.seen.lock().expect("log").clone()
        }
    }

    const STAND_IN_FILE: &str = "1StandInFile";
    const STAND_IN_FILE_PATH: &str = "/drive/v3/files/1StandInFile";

    async fn google_stand_in(session_address: &str, stored: Stored) -> GoogleStandIn {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let origin = format!("http://{address}");
        let location = session_address
            .replace("{origin}", &origin)
            .replace("{authority}", &address.to_string())
            .replace("{port}", &address.port().to_string());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (log, stored, location) = (log.clone(), stored.clone(), location.clone());
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(1) => head.push(byte[0]),
                            _ => return,
                        }
                    }
                    let text = String::from_utf8_lossy(&head).into_owned();
                    let mut lines = text.split("\r\n");
                    let request_line = lines.next().unwrap_or_default().to_string();
                    let mut parts = request_line.split(' ');
                    let method = parts.next().unwrap_or_default().to_string();
                    let target = parts.next().unwrap_or_default();
                    let path = target.split('?').next().unwrap_or_default().to_string();
                    let mut call = SeenCall {
                        method,
                        path,
                        authorization: false,
                        content_type: None,
                        declared_length: None,
                        body_len: 0,
                    };
                    for line in lines {
                        if let Some((name, value)) = line.split_once(':') {
                            let value = value.trim().to_string();
                            match name.trim().to_ascii_lowercase().as_str() {
                                "authorization" => call.authorization = true,
                                "content-type" => call.content_type = Some(value),
                                "x-upload-content-length" => call.declared_length = Some(value),
                                "content-length" => call.body_len = value.parse().unwrap_or(0),
                                _ => {}
                            }
                        }
                    }
                    let mut body = vec![0u8; call.body_len];
                    if socket.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let (status, headers, reply_body) =
                        match (call.method.as_str(), call.path.as_str()) {
                            ("GET", "/drive/v3/files") => {
                                (200, vec![], r#"{"files":[{"id":"1Folder"}]}"#.to_string())
                            }
                            ("GET", "/drive/v3/files/generateIds") => {
                                (200, vec![], format!(r#"{{"ids":["{STAND_IN_FILE}"]}}"#))
                            }
                            ("POST", "/upload/drive/v3/files") => {
                                (200, vec![("Location", location)], String::new())
                            }
                            ("PUT", _) => (200, vec![], String::new()),
                            ("GET", STAND_IN_FILE_PATH) => (
                                200,
                                vec![],
                                serde_json::json!({
                                    "id": stored.id,
                                    "name": "p.png",
                                    "mimeType": stored.mime,
                                    "size": stored.size.to_string(),
                                    "driveId": "0StandInDrive",
                                    "trashed": false,
                                })
                                .to_string(),
                            ),
                            ("DELETE", STAND_IN_FILE_PATH) => (204, vec![], String::new()),
                            _ => (404, vec![], String::new()),
                        };
                    log.lock().expect("log").push(call);
                    let mut reply = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
                    if status != 204 {
                        reply.push_str(&format!("Content-Length: {}\r\n", reply_body.len()));
                    }
                    if !reply_body.is_empty() {
                        reply.push_str("Content-Type: application/json\r\n");
                    }
                    for (name, value) in headers {
                        reply.push_str(&format!("{name}: {value}\r\n"));
                    }
                    reply.push_str("\r\n");
                    reply.push_str(&reply_body);
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        GoogleStandIn { origin, seen }
    }

    fn calls_of<'a>(calls: &'a [SeenCall], method: &str) -> Vec<&'a SeenCall> {
        calls.iter().filter(|call| call.method == method).collect()
    }

    /// Implementation review round 2, L-3 (W7): `put_object` reads back what Drive holds and takes the
    /// object back when it is not what was sent. Run end to end — session, pin, `PUT`, read-back, delete —
    /// against a stand-in that plays all of Google, so deleting the comparison (or any one of its terms)
    /// turns this red. The pieces tested alone cannot: they never meet the comparison.
    #[tokio::test]
    async fn what_drive_holds_after_the_put_must_be_what_was_sent_or_the_object_is_taken_back_once()
    {
        let channel = Uuid::new_v4();
        let bytes = vec![7u8; 1234];
        let size = i64::try_from(bytes.len()).expect("a small length");
        let honest = Stored {
            id: STAND_IN_FILE,
            size,
            mime: "image/png",
        };

        // The control: Drive holds exactly what was sent. The object is kept and nothing is deleted, so
        // the refusals below are the comparison's doing and not the harness's.
        let server = google_stand_in(
            "{origin}/upload/drive/v3/files?upload_id=ok",
            honest.clone(),
        )
        .await;
        let archive =
            GoogleDriveArchive::against_upload_stand_in(&server.origin, Duration::from_secs(5));
        let stored = archive
            .put_object(channel, "p.png", "image/png", bytes.clone())
            .await
            .expect("what was sent is what Drive holds");
        assert_eq!(stored.drive_file_id, STAND_IN_FILE);
        assert_eq!(stored.size_bytes, size);
        assert_eq!(stored.mime, "image/png");
        let calls = server.calls();
        let session = calls_of(&calls, "POST");
        assert_eq!(session.len(), 1, "one session request");
        assert_eq!(
            session[0].declared_length.as_deref(),
            Some("1234"),
            "the session declares the size it will be sent"
        );
        assert!(
            session[0].authorization,
            "the session is asked for with the bearer"
        );
        let puts = calls_of(&calls, "PUT");
        assert_eq!(puts.len(), 1, "one PUT");
        assert_eq!(puts[0].path, "/upload/drive/v3/files");
        assert_eq!(puts[0].body_len, bytes.len());
        assert_eq!(puts[0].content_type.as_deref(), Some("image/png"));
        assert!(
            !puts[0].authorization,
            "the session address is its own capability"
        );
        assert!(
            calls_of(&calls, "DELETE").is_empty(),
            "nothing is taken back when Drive holds what was sent"
        );

        for (what, wrong) in [
            (
                "a size one byte too big",
                Stored {
                    size: size + 1,
                    ..honest.clone()
                },
            ),
            (
                "a size one byte too small",
                Stored {
                    size: size - 1,
                    ..honest.clone()
                },
            ),
            (
                "another type",
                Stored {
                    mime: "image/jpeg",
                    ..honest.clone()
                },
            ),
            (
                "another file id",
                Stored {
                    id: "1SomebodyElsesFile",
                    ..honest.clone()
                },
            ),
        ] {
            let server =
                google_stand_in("{origin}/upload/drive/v3/files?upload_id=ok", wrong).await;
            let archive =
                GoogleDriveArchive::against_upload_stand_in(&server.origin, Duration::from_secs(5));
            let got = archive
                .put_object(channel, "p.png", "image/png", bytes.clone())
                .await;
            assert_eq!(got, Err(DriveError::UpstreamFailure), "{what}: fail closed");
            let calls = server.calls();
            assert_eq!(
                calls_of(&calls, "PUT").len(),
                1,
                "{what}: the bytes were sent once"
            );
            let deletes = calls_of(&calls, "DELETE");
            assert_eq!(
                deletes.len(),
                1,
                "{what}: the object is taken back exactly once"
            );
            assert_eq!(
                deletes[0].path, STAND_IN_FILE_PATH,
                "{what}: the object that was written"
            );
            let put_at = calls.iter().position(|call| call.method == "PUT");
            let read_at = calls
                .iter()
                .position(|call| call.method == "GET" && call.path == STAND_IN_FILE_PATH);
            let delete_at = calls.iter().position(|call| call.method == "DELETE");
            assert!(
                put_at < read_at && read_at < delete_at,
                "{what}: the read-back came between the PUT and the delete: {calls:?}"
            );
        }
    }

    /// Implementation review round 2, L-3 (WA10, review L6): a session address outside the pin is given
    /// no byte, and the write fails. Run through `put_object` against a stand-in that plays all of Google,
    /// so deleting the call to the pin turns this red. The first three addresses are on the right host and
    /// port, so only the pin's path rule refuses them (the textual `Location` check lets them through); the
    /// others are somewhere else, which the `Location` check and the pin both refuse — one address judged
    /// twice, on purpose.
    #[tokio::test]
    async fn a_session_address_outside_the_pin_is_given_no_byte_and_the_write_fails() {
        let channel = Uuid::new_v4();
        let bytes = vec![7u8; 1234];
        let honest = Stored {
            id: STAND_IN_FILE,
            size: 1234,
            mime: "image/png",
        };

        // The control: an address inside the pin is sent the bytes once, so "no PUT" below is a refusal.
        let server = google_stand_in(
            "{origin}/upload/drive/v3/files?upload_id=ok",
            honest.clone(),
        )
        .await;
        let archive =
            GoogleDriveArchive::against_upload_stand_in(&server.origin, Duration::from_secs(5));
        archive
            .put_object(channel, "p.png", "image/png", bytes.clone())
            .await
            .expect("an address inside the pin is sent the bytes");
        assert_eq!(calls_of(&server.calls(), "PUT").len(), 1);

        // Another place on the same machine: if anything reaches it, the address was followed.
        let elsewhere = put_stand_in(200, None).await;
        let elsewhere_address = elsewhere.address;
        for (what, session) in [
            (
                "a path outside /upload/",
                "{origin}/drive/v3/files?upload_id=x".to_string(),
            ),
            (
                "the upload path in capitals",
                "{origin}/UPLOAD/drive/v3/files?upload_id=x".to_string(),
            ),
            (
                "the upload path without its slash",
                "{origin}/upload?upload_id=x".to_string(),
            ),
            (
                "the same host on another port",
                format!("http://{elsewhere_address}/upload/drive/v3/files?upload_id=x"),
            ),
            (
                "another name for the same host",
                "http://localhost:{port}/upload/drive/v3/files?upload_id=x".to_string(),
            ),
            (
                "the right place as userinfo and somewhere else as the host",
                format!("http://{{authority}}@{elsewhere_address}/upload/drive/v3/files"),
            ),
            (
                "userinfo in front of the right host",
                "http://user:pw@{authority}/upload/drive/v3/files".to_string(),
            ),
            (
                "another scheme",
                "https://{authority}/upload/drive/v3/files".to_string(),
            ),
        ] {
            let server = google_stand_in(&session, honest.clone()).await;
            let archive =
                GoogleDriveArchive::against_upload_stand_in(&server.origin, Duration::from_secs(5));
            let got = archive
                .put_object(channel, "p.png", "image/png", bytes.clone())
                .await;
            assert_eq!(got, Err(DriveError::UpstreamFailure), "{what}");
            assert!(
                calls_of(&server.calls(), "PUT").is_empty(),
                "{what}: a byte was sent to an address outside the pin"
            );
        }
        assert!(
            elsewhere.seen.lock().expect("log").is_empty(),
            "a request reached the other place"
        );
    }

    /// The data the session request and the pin are made from, for a real archive: Google's own, read back
    /// from an archive built the way the real constructor builds one. A stand-in's data is the tests' to
    /// choose; this is the one that ships.
    #[test]
    fn a_real_archive_requests_sessions_from_and_pins_them_to_googles_own_upload_endpoint() {
        let key = KeyFile::new();
        let archive = GoogleDriveArchive::open(key.path(), Some("0ABCdef"), lenient_key)
            .expect("a key file of the right shape opens");
        assert_eq!(archive.upload, UploadEndpoint::google());
        assert_eq!(archive.upload.base, UPLOAD_API_BASE);
        assert_eq!(
            archive.upload.base,
            "https://www.googleapis.com/upload/drive/v3"
        );
        assert_eq!(archive.upload.scheme, "https");
        assert_eq!(archive.upload.host, "www.googleapis.com");
        assert_eq!(archive.upload.port, None);
        assert_eq!(
            archive.upload.session_prefix(),
            "https://www.googleapis.com/",
            "the textual check on the address a session request answers with"
        );
    }

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
