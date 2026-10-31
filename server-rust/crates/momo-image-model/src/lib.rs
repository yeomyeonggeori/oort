//! `momo-image-model` — the one place this server asks a team-connected image model to draw
//! from a member's photo (ADR-0218 §8, #4941; the exception to ADR-0186 v8 X8-1 「서버/팀 AI
//! 생성 호출은 없다」).
//!
//! ## What the api can reach, and what it cannot
//!
//! A crate rather than a module in `momo-server` for the reason `momo-provider-probe` and
//! `momo-unfurl` are crates: `reqwest` lives HERE, never in the api's manifest, so a route
//! handler cannot build an arbitrary outbound request (invariant #2). The only operation is
//! [`ImageModelClient::generate`], and the only requests it can issue are
//!
//! | provider | request | auth |
//! |---|---|---|
//! | OpenAI (`api.openai.com`) | `POST {base}/images/edits`, `multipart/form-data` | `Authorization: Bearer` |
//! | Gemini (`generativelanguage.googleapis.com`) | `POST {base}/interactions`, JSON | `x-goog-api-key` |
//!
//! Both go through the #2852 egress guard ([`momo_egress::EgressGuard`]): every resolved
//! address vetted, no redirect, no proxy, a deadline on the lookup.
//!
//! * **The photo travels as bytes in the request body.** No public, signed or tokenised address
//!   exists for it; nothing here fetches anything.
//! * **The key goes in one header of one request** and nowhere else: not a URL, not a body, not
//!   a log line, not an error. [`ImageModelTarget`]'s `Debug` prints `<redacted>`.
//! * **Nothing the provider says leaves this crate** except the closed [`ImageModelError`]. An
//!   error body is read (capped) only to tell a refusal from a failure, then dropped; a key a
//!   provider echoes back has nowhere to go.
//! * **Every size is bounded**: the request photo ([`PHOTO_MAX_BYTES`]), the whole answer
//!   ([`RESPONSE_MAX_BYTES`], also checked against `Content-Length` before the body is read), the
//!   picture inside it ([`PICTURE_MAX_BYTES`], ADR-0218 D3's input limit) and the call
//!   ([`DEFAULT_DEADLINE`]).
//!
//! ## Which model, and whether it can make a transparent background
//!
//! The model ids and the transparency table below come from the providers' own documentation,
//! read on 2026-10-31 (quoted in ADR-0218 §8 H9). OpenAI says `gpt-image-2.5-sunburst` and
//! `gpt-image-2.5-flare` return a transparent background for `background: "transparent"` with
//! `output_format` `png` or `webp`, and `gpt-image-2` only "in preview"; the Gemini image guide
//! says nothing about transparency. So only the first two ([`OPENAI_TRANSPARENT_MODELS`]) are
//! asked for transparency; everything else is **not claimed** (`미확인`) and the caller falls back
//! to its own deterministic background removal.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use momo_egress::{denied_in_chain, EgressGuard, HostLookup, SystemLookup};
use momo_settings::EgressPolicy;
use serde_json::{json, Value};

/// Longest the whole call may take, DNS lookup and body included. The OpenAI guide says
/// 「Complex prompts may take up to 2 minutes to process」, so this is that plus a little.
pub const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);
/// What the caller may hand in as the photo (a re-encoded picture, never the member's file).
pub const PHOTO_MAX_BYTES: usize = 4 * 1024 * 1024;
/// The decoded picture inside an answer: ADR-0218 D3's 5 MiB input limit.
pub const PICTURE_MAX_BYTES: usize = 5 * 1024 * 1024;
/// base64 text of [`PICTURE_MAX_BYTES`] (checked before anything is decoded).
const PICTURE_MAX_B64: usize = PICTURE_MAX_BYTES.div_ceil(3) * 4;
/// The whole non-streamed answer. A 5 MiB picture is 6.7 MiB of base64; the rest is envelope.
pub const RESPONSE_MAX_BYTES: usize = 12 * 1024 * 1024;
/// How much of an error body is read to tell a refusal from a failure.
const ERROR_BODY_MAX: usize = 16 * 1024;

pub const DEFAULT_OPENAI_MODEL: &str = "gpt-image-2.5-sunburst";
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-nano-banana-2.1";
/// Model ids the OpenAI reference lists as supporting `background: transparent`.
pub const OPENAI_TRANSPARENT_MODELS: [&str; 4] = [
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare-2026-09-08",
];

pub const OPENAI_BASE: &str = "https://api.openai.com/v1";
pub const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Which company's image model a team key reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageProvider {
    OpenAi,
    Gemini,
}

impl ImageProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            ImageProvider::OpenAi => "openai",
            ImageProvider::Gemini => "gemini",
        }
    }
    pub fn from_label(label: &str) -> Option<ImageProvider> {
        match label {
            "openai" => Some(ImageProvider::OpenAi),
            "gemini" => Some(ImageProvider::Gemini),
            _ => None,
        }
    }
}

/// The two things a member can ask for (ADR-0218 §8 H9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Branch {
    /// 배경 지우기: the subject as it is, the background gone.
    Cutout,
    /// 캐리커처: a new caricature drawn from the photo.
    Caricature,
}

impl Branch {
    pub const fn as_str(self) -> &'static str {
        match self {
            Branch::Cutout => "cutout",
            Branch::Caricature => "caricature",
        }
    }
    pub fn from_label(label: &str) -> Option<Branch> {
        match label {
            "cutout" => Some(Branch::Cutout),
            "caricature" => Some(Branch::Caricature),
            _ => None,
        }
    }
}

/// Why no picture came back. Closed: nothing a provider wrote is in here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ImageModelError {
    /// 401/402/403/404 or an exhausted quota: the connected key cannot use this model (an
    /// invalid key, an organisation that is not verified, a model it has no access to).
    #[error("the connected key cannot use this image model")]
    Denied,
    /// The provider's safety system declined this photo.
    #[error("the image model declined this picture")]
    Refused,
    /// Any other provider-side failure, or an answer that is not the documented shape.
    #[error("the image model failed")]
    Failed,
    /// The call outlived its deadline. The provider may still have done (and billed) the work.
    #[error("the image model did not answer in time")]
    TimedOut,
    /// The answer, or the picture in it, is larger than the bound.
    #[error("the image model's answer is too large")]
    TooLarge,
    /// The egress guard refused the provider's address; nothing was sent.
    #[error("the image model host is not allowed")]
    Egress,
}

/// Where one request goes and what it presents. `Debug` is by hand: the key is a live
/// credential and a derived `Debug` would put it in the first `tracing::error!(?target)`.
#[derive(Clone, PartialEq, Eq)]
pub struct ImageModelTarget {
    pub provider: ImageProvider,
    /// The URL prefix without a trailing slash: [`OPENAI_BASE`] or [`GEMINI_BASE`] in production.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl std::fmt::Debug for ImageModelTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ImageModelTarget")
            .field("provider", &self.provider)
            .field(
                "base_url",
                &momo_settings::redacted_endpoint_label(&self.base_url),
            )
            .field("model", &self.model)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

impl ImageModelTarget {
    /// May this request ask for a transparent background? Only a model the provider's own
    /// documentation names for it ([`OPENAI_TRANSPARENT_MODELS`]). Gemini: not documented, so no.
    pub fn transparent_output(&self) -> bool {
        self.provider == ImageProvider::OpenAi
            && OPENAI_TRANSPARENT_MODELS.contains(&self.model.as_str())
    }
}

/// The member's photo as it is sent: a **re-encoded** picture (pixels only: no EXIF, GPS, ICC or
/// comment) of at most [`PHOTO_MAX_BYTES`]. The mime is closed to the two the decoder child emits.
#[derive(Debug, Clone, Copy)]
pub struct Photo<'a> {
    pub bytes: &'a [u8],
    pub mime: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct GenerateRequest<'a> {
    pub target: &'a ImageModelTarget,
    pub photo: Photo<'a>,
    pub branch: Branch,
    /// An opaque, stable, pseudonymous id for the member (OpenAI `safety_identifier`), so a
    /// provider can tell one member's misuse from the whole team's. Never a name or an email.
    pub safety_id: Option<&'a str>,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    /// The picture's bytes: whatever the provider returned (PNG in practice). The caller
    /// decodes it in the isolated child; the format is decided by the bytes, never claimed here.
    pub bytes: Vec<u8>,
    /// Did this request ask the provider for a transparent background? (The caller still checks
    /// that the picture really has one.)
    pub asked_transparent: bool,
}

/// The seam: production is [`GuardedImageModel`]; a test injects its own.
#[async_trait]
pub trait ImageModelClient: Send + Sync {
    async fn generate(&self, request: GenerateRequest<'_>) -> Result<Generated, ImageModelError>;
}

/// The instructions each request carries. Fixed text: no member-written word reaches a provider.
pub fn prompt(branch: Branch, transparent: bool) -> &'static str {
    match (branch, transparent) {
        (Branch::Cutout, true) => {
            "Edit this photo into a clean cut-out of its main subject, to be used as a small chat \
             emoji. Keep the subject exactly as it appears in the photo: same pose, colors and \
             details. Remove the whole background so that it is fully transparent. Center the \
             subject with a small margin. Do not add text, borders or shadows."
        }
        (Branch::Cutout, false) => {
            "Edit this photo into a clean cut-out of its main subject, to be used as a small chat \
             emoji. Keep the subject exactly as it appears in the photo: same pose, colors and \
             details. Put the unchanged subject on one perfectly flat, uniform solid background of \
             a single color that appears nowhere on the subject (for example a flat bright green). \
             Keep the subject clear of the image edges and add a thin white outline around it. The \
             background must have no gradient, shadow, texture or noise. Do not add text or borders."
        }
        (Branch::Caricature, _) => {
            "Redraw the main subject of this photo as a fun, friendly caricature-style illustration \
             to be used as a small chat emoji: playfully exaggerate the most distinctive features \
             while keeping the subject recognizable, with clean bold outlines and vivid flat \
             colors. One subject, centered, on a plain solid white background. Do not add text, \
             captions or borders."
        }
    }
}

// ---- configuration: which hosts, which models --------------------------------------------------

/// Which team-key base URLs are image providers, and which model each one asks for.
///
/// Production maps exactly two hosts and ignores whatever path the operator typed: the key is only
/// ever presented to `api.openai.com` or `generativelanguage.googleapis.com`, at the fixed prefixes
/// above. (A gateway that merely speaks OpenAI's chat wire is not an image provider.) A test adds
/// its loopback server with [`ImageModelConfig::with_test_host`]; no environment variable can.
#[derive(Debug, Clone)]
pub struct ImageModelConfig {
    pub openai_model: String,
    pub gemini_model: String,
    extra_hosts: Vec<(String, ImageProvider, String)>,
}

impl Default for ImageModelConfig {
    fn default() -> Self {
        ImageModelConfig {
            openai_model: DEFAULT_OPENAI_MODEL.to_string(),
            gemini_model: DEFAULT_GEMINI_MODEL.to_string(),
            extra_hosts: Vec::new(),
        }
    }
}

impl ImageModelConfig {
    /// `OORT_EXPRESSION_IMAGE_MODEL_OPENAI` / `OORT_EXPRESSION_IMAGE_MODEL_GEMINI` override the
    /// default model ids (a model id changes faster than a release). Each is checked with the same
    /// charset rule as every model id the server stores; an invalid value is ignored.
    pub fn from_env() -> ImageModelConfig {
        let read = |name: &str, default: &str| {
            std::env::var(name)
                .ok()
                .and_then(|raw| momo_settings::sanitized_model_id(&raw))
                .unwrap_or_else(|| default.to_string())
        };
        ImageModelConfig {
            openai_model: read("OORT_EXPRESSION_IMAGE_MODEL_OPENAI", DEFAULT_OPENAI_MODEL),
            gemini_model: read("OORT_EXPRESSION_IMAGE_MODEL_GEMINI", DEFAULT_GEMINI_MODEL),
            extra_hosts: Vec::new(),
        }
    }

    /// Tests only: treat `authority` (`127.0.0.1:PORT`) as `provider`, reached at `base`.
    pub fn with_test_host(
        mut self,
        authority: &str,
        provider: ImageProvider,
        base: &str,
    ) -> ImageModelConfig {
        self.extra_hosts.push((
            authority.to_ascii_lowercase(),
            provider,
            base.trim_end_matches('/').to_string(),
        ));
        self
    }

    /// The provider and fixed base for a team-key base URL, or `None` when it is not one of the
    /// two image providers. Strict: `https`, no userinfo, no query/fragment, default port.
    pub fn provider_for(&self, base_url: &str) -> Option<(ImageProvider, String)> {
        let parsed = reqwest::Url::parse(base_url.trim()).ok()?;
        let authority = match parsed.port() {
            Some(port) => format!("{}:{port}", parsed.host_str()?.to_ascii_lowercase()),
            None => parsed.host_str()?.to_ascii_lowercase(),
        };
        if let Some((_, provider, base)) = self
            .extra_hosts
            .iter()
            .find(|(candidate, _, _)| *candidate == authority)
        {
            return Some((*provider, base.clone()));
        }
        let plain = parsed.scheme() == "https"
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none()
            && parsed.port().is_none();
        if !plain {
            return None;
        }
        match authority.trim_end_matches('.') {
            "api.openai.com" => Some((ImageProvider::OpenAi, OPENAI_BASE.to_string())),
            "generativelanguage.googleapis.com" => {
                Some((ImageProvider::Gemini, GEMINI_BASE.to_string()))
            }
            _ => None,
        }
    }

    pub fn model_for(&self, provider: ImageProvider) -> &str {
        match provider {
            ImageProvider::OpenAi => &self.openai_model,
            ImageProvider::Gemini => &self.gemini_model,
        }
    }
}

// ---- the guarded client ------------------------------------------------------------------------

/// The production client: the guarded `reqwest` client and nothing else.
pub struct GuardedImageModel {
    /// `None` when the guarded client could not be built. There is no unguarded fallback.
    client: Option<reqwest::Client>,
    guard: EgressGuard,
    deadline: Duration,
}

impl GuardedImageModel {
    /// System DNS. `policy` is the api's egress policy, the same inputs the agent-worker reads.
    pub fn new(policy: EgressPolicy, deadline: Duration) -> GuardedImageModel {
        GuardedImageModel::with_lookup(policy, Arc::new(SystemLookup), deadline)
    }

    pub fn with_lookup(
        policy: EgressPolicy,
        lookup: Arc<dyn HostLookup>,
        deadline: Duration,
    ) -> GuardedImageModel {
        let guard = EgressGuard::new(policy, lookup, deadline);
        let client = guard
            .client(
                reqwest::Client::builder()
                    .timeout(deadline)
                    .connect_timeout(deadline.min(Duration::from_secs(10))),
            )
            .map_err(|_| {
                tracing::warn!("image model client build failed; every request will fail");
            })
            .ok();
        GuardedImageModel {
            client,
            guard,
            deadline,
        }
    }
}

#[async_trait]
impl ImageModelClient for GuardedImageModel {
    async fn generate(&self, request: GenerateRequest<'_>) -> Result<Generated, ImageModelError> {
        let Some(client) = self.client.as_ref() else {
            return Err(ImageModelError::Failed);
        };
        let provider = request.target.provider.as_str();
        // One bound around the lookup, the request, the body and the parse (the client's own
        // `timeout` covers the HTTP exchange; `getaddrinfo` has none).
        match tokio::time::timeout(self.deadline, self.exchange(client, request)).await {
            Ok(Ok(generated)) => Ok(generated),
            Ok(Err(error)) => {
                // The closed kind and the provider's name: never a key, a photo, a prompt or a body.
                tracing::warn!(provider, error = ?error, "image model request did not produce a picture");
                Err(error)
            }
            Err(_) => {
                tracing::warn!(provider, "image model request timed out");
                Err(ImageModelError::TimedOut)
            }
        }
    }
}

impl GuardedImageModel {
    async fn exchange(
        &self,
        client: &reqwest::Client,
        request: GenerateRequest<'_>,
    ) -> Result<Generated, ImageModelError> {
        let target = request.target;
        if request.photo.bytes.is_empty()
            || request.photo.bytes.len() > PHOTO_MAX_BYTES
            || !matches!(request.photo.mime, "image/png" | "image/jpeg")
            || target.api_key.trim().is_empty()
        {
            return Err(ImageModelError::Failed);
        }
        let asked_transparent = request.branch == Branch::Cutout && target.transparent_output();
        let text = prompt(request.branch, asked_transparent);
        let base = target.base_url.trim_end_matches('/');
        let (url, builder) = match target.provider {
            ImageProvider::OpenAi => {
                let url = format!("{base}/images/edits");
                let (content_type, body) = openai_form(&request, text, asked_transparent);
                let builder = client
                    .post(&url)
                    .bearer_auth(&target.api_key)
                    .header(reqwest::header::CONTENT_TYPE, content_type)
                    .body(body);
                (url, builder)
            }
            ImageProvider::Gemini => {
                let url = format!("{base}/interactions");
                let body = gemini_body(&request, text);
                let builder = client
                    .post(&url)
                    .header("x-goog-api-key", &target.api_key)
                    .json(&body);
                (url, builder)
            }
        };
        let parsed = reqwest::Url::parse(&url).map_err(|_| ImageModelError::Failed)?;
        let host = parsed.host_str().ok_or(ImageModelError::Failed)?;
        self.guard
            .precheck_host(host)
            .await
            .map_err(|_| ImageModelError::Egress)?;
        let mut response = builder.send().await.map_err(map_transport)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = read_capped(&mut response, ERROR_BODY_MAX)
                .await
                .unwrap_or_default();
            return Err(classify_error(status, &body));
        }
        if response
            .content_length()
            .is_some_and(|length| length > RESPONSE_MAX_BYTES as u64)
        {
            return Err(ImageModelError::TooLarge);
        }
        let body = read_capped(&mut response, RESPONSE_MAX_BYTES).await?;
        let value: Value = serde_json::from_slice(&body).map_err(|_| ImageModelError::Failed)?;
        let encoded = match target.provider {
            ImageProvider::OpenAi => openai_picture(&value)?,
            ImageProvider::Gemini => gemini_picture(&value)?,
        };
        if encoded.len() > PICTURE_MAX_B64 {
            return Err(ImageModelError::TooLarge);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| ImageModelError::Failed)?;
        if bytes.is_empty() {
            return Err(ImageModelError::Failed);
        }
        if bytes.len() > PICTURE_MAX_BYTES {
            return Err(ImageModelError::TooLarge);
        }
        Ok(Generated {
            bytes,
            asked_transparent,
        })
    }
}

fn map_transport(error: reqwest::Error) -> ImageModelError {
    if denied_in_chain(&error).is_some() {
        ImageModelError::Egress
    } else if error.is_timeout() {
        ImageModelError::TimedOut
    } else {
        ImageModelError::Failed
    }
}

/// Read at most `limit` bytes. Over the limit is [`ImageModelError::TooLarge`]; the rest of the
/// body is never pulled in.
async fn read_capped(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ImageModelError> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > limit {
                    return Err(ImageModelError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(error) => return Err(map_transport(error)),
        }
    }
}

/// Words that mean 「the provider's safety system said no」, in OpenAI's and Google's spelling.
const REFUSAL_WORDS: [&str; 6] = [
    "moderation_blocked",
    "content_policy_violation",
    "SAFETY",
    "PROHIBITED_CONTENT",
    "IMAGE_SAFETY",
    "BLOCKLIST",
];

fn says_refusal(text: &str) -> bool {
    REFUSAL_WORDS.iter().any(|word| text.contains(word))
}

fn classify_error(status: u16, body: &[u8]) -> ImageModelError {
    let text = String::from_utf8_lossy(body);
    if says_refusal(&text) {
        return ImageModelError::Refused;
    }
    match status {
        401..=404 => ImageModelError::Denied,
        // A spent quota is the key's state, not a passing rate limit.
        429 if text.contains("insufficient_quota") => ImageModelError::Denied,
        _ => ImageModelError::Failed,
    }
}

// ---- OpenAI ------------------------------------------------------------------------------------

static BOUNDARY_COUNTER: AtomicU64 = AtomicU64::new(0);

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// `(content-type, body)` of the `images/edits` form. The boundary is chosen so that it occurs
/// nowhere in the photo: a picture can never add a form field of its own.
fn openai_form(
    request: &GenerateRequest<'_>,
    text: &str,
    asked_transparent: bool,
) -> (String, Vec<u8>) {
    let target = request.target;
    let mut fields: Vec<(&str, String)> = vec![
        ("model", target.model.clone()),
        ("prompt", text.to_string()),
        ("n", "1".to_string()),
        ("size", "1024x1024".to_string()),
        ("quality", "medium".to_string()),
        ("output_format", "png".to_string()),
    ];
    // `background` is sent only where the documentation says the model takes it: the two
    // GPT Image 2.5 models. A cut-out asks for `transparent`, a caricature for `opaque`.
    if OPENAI_TRANSPARENT_MODELS.contains(&target.model.as_str()) {
        fields.push((
            "background",
            if asked_transparent {
                "transparent"
            } else {
                "opaque"
            }
            .to_string(),
        ));
    }
    if let Some(id) = request.safety_id.filter(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        fields.push(("safety_identifier", id.to_string()));
    }
    let filename = if request.photo.mime == "image/png" {
        "photo.png"
    } else {
        "photo.jpg"
    };
    let mut boundary;
    loop {
        boundary = format!(
            "oort-image-model-{:016x}",
            BOUNDARY_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        if !contains(request.photo.bytes, boundary.as_bytes()) {
            break;
        }
    }
    let mut body = Vec::with_capacity(request.photo.bytes.len() + 2048);
    for (name, value) in &fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{filename}\"\r\nContent-Type: {}\r\n\r\n",
            request.photo.mime
        )
        .as_bytes(),
    );
    body.extend_from_slice(request.photo.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// `data[0].b64_json` of an `ImagesResponse`.
fn openai_picture(value: &Value) -> Result<&str, ImageModelError> {
    value
        .get("data")
        .and_then(|data| data.get(0))
        .and_then(|first| first.get("b64_json"))
        .and_then(Value::as_str)
        .ok_or(ImageModelError::Failed)
}

// ---- Gemini ------------------------------------------------------------------------------------

/// The Interactions request of the Gemini image guide: a text block and an image block, an image
/// response, and `store: false` so the interaction is not kept for later turns.
fn gemini_body(request: &GenerateRequest<'_>, text: &str) -> Value {
    json!({
        "model": request.target.model,
        "input": [
            { "type": "text", "text": text },
            {
                "type": "image",
                "mime_type": request.photo.mime,
                "data": base64::engine::general_purpose::STANDARD.encode(request.photo.bytes),
            },
        ],
        "response_format": { "type": "image", "mime_type": "image/png", "aspect_ratio": "1:1" },
        "store": false,
    })
}

/// The first image block of a `model_output` step. An interaction that did not complete is a
/// refusal or a failure, never a picture.
fn gemini_picture(value: &Value) -> Result<&str, ImageModelError> {
    let refusal = || {
        let said = value
            .get("errors")
            .map(Value::to_string)
            .unwrap_or_default();
        if says_refusal(&said) {
            ImageModelError::Refused
        } else {
            ImageModelError::Failed
        }
    };
    if value
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status != "completed")
    {
        return Err(refusal());
    }
    let steps = value
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(refusal)?;
    steps
        .iter()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
        .filter_map(|step| step.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .find_map(|block| block.get("data").and_then(Value::as_str))
        .ok_or_else(refusal)
}

#[cfg(test)]
mod tests;
