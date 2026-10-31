//! 사진으로 팀 이모티콘 (ADR-0218 §8 H9, #4941): the team's image model draws from a member's own
//! photo, and the picture becomes the same direct draft every other way of adding one ends in.
//!
//! ```text
//! GET  /v1/workspaces/{ws}/expressions/photo-model    which company a photo would go to, if any
//! POST /v1/workspaces/{ws}/expressions/photo-drafts   photo + branch + name  ->  { draft, cutout }
//! ```
//!
//! The order of `create` is the whole safety argument, and it is the order of the lines below:
//!
//! 1. **Authority first, before a byte of the body is read**: a human, allowed to add, with room
//!    for another draft (`preflight_import`, the same proof the link import makes before it
//!    fetches). A guest, an agent and a person at their draft limit never cost the team a call.
//! 2. **The photo is the caller's own**: either the bytes of this very request, or an attachment
//!    that [`expressions::attachment_source`] — the rule `from-attachment` already uses — proves
//!    the caller uploaded to a conversation they are in, in a message they wrote. Someone else's
//!    photo, another workspace's, a missing one: the same 404.
//! 3. **The photo that leaves is not the photo that arrived**: it goes through the isolated decoder
//!    (`prepare_photo`) and comes out upright, at most 1024 px, and encoded again from its pixels,
//!    so where it was taken, any comment and any trailing byte stay behind.
//! 4. **Consent is to a named company**: the request carries the provider the member agreed to
//!    (`acknowledgedProvider`), and it must be the one the team key reaches *now*; if the
//!    operator changed the key in between, nothing is sent (`image_model_changed`).
//! 5. **One call, bounded**: at most [`IN_FLIGHT`] on the instance and one per member, a 120 s
//!    deadline, a 12 MiB answer, a 5 MiB picture. The key, the photo and the answer are never
//!    logged and never come back in a response; the failure the member sees is one closed code.
//! 6. **What comes back is decoded in the isolated child too** (`process_cutout` for a cut-out,
//!    the ordinary picture path for a caricature) and stored as a draft whose origin is the one
//!    fixed sentence for the branch. The member sees exactly the picture that would be saved.
//!
//! ## The one boundary this route widens
//!
//! `provider_link` is readable only inside the operator transaction (`app.provider_link_admin`,
//! migration 039), and the doc of that transaction says it is bound only after the route's
//! instance-operator gate. This route binds it for a *member's* request, in one function
//! ([`read_team_key`]), after rule 1, to hand the opened key to the image client and to nobody
//! else: the key is never a field of a response, a log line, an audit row or an error. ADR-0218
//! §8 H9 records this as the decision and as the first thing the security review looks at.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::to_bytes;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures::StreamExt;
use momo_auth::Principal;
use momo_db::with_provider_link_admin_tx;
use momo_expressions::{self as expressions, cutout, media, Actor, Error, Metadata, Origin};
use momo_image_model::{
    Branch, GenerateRequest, ImageModelConfig, ImageModelError, ImageModelTarget, ImageProvider,
    Photo,
};
use momo_settings::{
    decrypt_chain_entry, decrypt_link, is_unsafe_secret, read_chain, read_link, resolve_link,
    DecryptedProviderLink, LinkCredential, ProviderConfig, ProviderMode, ProviderSource,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::expressions::{actor, failure, human, invalid, media_error};
use super::shared::require_instance_operator;
use crate::{error::ApiError, AppState};

/// Photo requests in flight on this instance. Each one spends the team's money, holds a photo and
/// waits for a decoder slot; at the cap the next is refused before anything is read or sent.
pub const IN_FLIGHT: usize = 4;
/// How long a paid-for picture waits for a decoder slot ([`media::WAIT_MAX`] is the longest it may).
const DECODE_WAIT: Duration = Duration::from_secs(3);

fn instance_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(IN_FLIGHT)))
}

fn members_in_flight() -> &'static Mutex<HashSet<Uuid>> {
    static MEMBERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    MEMBERS.get_or_init(Mutex::default)
}

/// The two slots a request holds from the moment it is admitted to the moment it is answered —
/// also when the client goes away first, because dropping the future drops this.
struct Admitted {
    member: Uuid,
    _instance: tokio::sync::OwnedSemaphorePermit,
}

impl Admitted {
    fn take(member: Uuid) -> Result<Admitted, ApiError> {
        let instance = instance_slots()
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy(5))?;
        if !members_in_flight()
            .lock()
            .map_err(|_| ApiError::busy(5))?
            .insert(member)
        {
            return Err(ApiError::busy(5));
        }
        Ok(Admitted {
            member,
            _instance: instance,
        })
    }
}

impl Drop for Admitted {
    fn drop(&mut self) {
        if let Ok(mut members) = members_in_flight().lock() {
            members.remove(&self.member);
        }
    }
}

// ---- the team key ----------------------------------------------------------------------------

/// One opened team key that might reach an image model.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyCandidate {
    base_url: String,
    key: String,
    mode: ProviderMode,
}

/// The team's keys in cascade order — the head (the operator's database link, or the environment
/// trio when there is none) and then every enabled fallback — keeping only what is a plain API key:
/// an OAuth grant or an Anthropic key never draws pictures, and a placeholder is not a key.
fn key_candidates(
    env: &ProviderConfig,
    link: Option<&DecryptedProviderLink>,
    chain: &[momo_settings::chain::DecryptedChainEntry],
) -> Vec<KeyCandidate> {
    let mut out = Vec::new();
    let mut push = |base_url: &str, key: &str, mode: ProviderMode| {
        if !key.trim().is_empty() && !is_unsafe_secret(key) {
            out.push(KeyCandidate {
                base_url: base_url.to_string(),
                key: key.to_string(),
                mode,
            });
        }
    };
    let head = resolve_link(env, link);
    match (head.source, link) {
        (ProviderSource::Database, Some(link)) => {
            if let LinkCredential::Bearer(key) = &link.credential {
                push(&link.base_url, key, link.mode);
            }
        }
        _ => push(&head.config.base_url, &head.config.bearer, head.config.mode),
    }
    for entry in chain.iter().filter(|entry| entry.enabled) {
        if let LinkCredential::Bearer(key) = LinkCredential::parse(&entry.bearer) {
            push(&entry.base_url, &key, entry.mode);
        }
    }
    out
}

/// The first key that reaches a real provider this crate can draw with. A hop in a mock mode is
/// not a provider.
fn pick_target(config: &ImageModelConfig, keys: Vec<KeyCandidate>) -> Option<ImageModelTarget> {
    keys.into_iter()
        .filter(|candidate| candidate.mode == ProviderMode::ExternalHermes)
        .find_map(|candidate| {
            let (provider, base) = config.provider_for(&candidate.base_url)?;
            Some(ImageModelTarget {
                provider,
                base_url: base,
                api_key: candidate.key,
                model: config.model_for(provider).to_string(),
            })
        })
}

/// Read and open the team keys, and choose the one the image model is asked with. This is the one
/// place the route reaches the sealed credential (module docs, 「the one boundary this route
/// widens」). `Ok(None)` is 「no image model is connected」: no master key to open anything with, no
/// key, or no key that reaches OpenAI or Gemini.
async fn read_team_key(
    state: &AppState,
    workspace: Uuid,
) -> Result<Option<ImageModelTarget>, ApiError> {
    let master = state.settings.provider_link_master_key.clone();
    let (stored, chain) = with_provider_link_admin_tx(&state.pool, workspace, move |conn| {
        Box::pin(async move {
            let stored = read_link(conn).await?;
            let chain = read_chain(conn).await?;
            Ok((stored, chain))
        })
    })
    .await
    .map_err(|error| ApiError::internal("expression_photo.read_key", error))?;
    // Without the master key nothing sealed can be opened; only the environment trio is left.
    let link = match (&master, &stored) {
        (Some(master), Some(stored)) => decrypt_link(stored, master).ok(),
        _ => None,
    };
    let chain: Vec<_> = match &master {
        Some(master) => chain
            .iter()
            .filter_map(|entry| decrypt_chain_entry(entry, master))
            .collect(),
        None => Vec::new(),
    };
    Ok(pick_target(
        &state.image_models,
        key_candidates(&state.settings.env_provider, link.as_ref(), &chain),
    ))
}

// ---- GET photo-model -------------------------------------------------------------------------

/// Which company a photo would go to, if the team has connected one. The form asks before it
/// shows the photo field, so a member never picks a photo for a feature the team has not got.
/// `canManage` says whether the caller may connect a model (the instance operator), which decides
/// whether the guidance links to the settings or tells them to ask.
pub async fn availability(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(ws): Path<String>,
) -> Result<Json<Value>, ApiError> {
    human(&principal)?;
    let actor = actor(&ws, &principal)?;
    let target = read_team_key(&state, actor.workspace).await?;
    let can_manage = require_instance_operator(&state, &principal).await.is_ok();
    Ok(Json(json!({
        "available": target.is_some(),
        "provider": target.as_ref().map(|target| target.provider.as_str()),
        "branches": [Branch::Cutout.as_str(), Branch::Caricature.as_str()],
        "canManage": can_manage,
    })))
}

// ---- POST photo-drafts -----------------------------------------------------------------------

/// What a member asks for. `acknowledgedProvider` is the consent: the company the member was told
/// the photo goes to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoMetadata {
    branch: String,
    acknowledged_provider: String,
    name: String,
    display_name: String,
    tags: Vec<String>,
    subject_member_id: Value,
}

/// The same request, with the photo named instead of attached.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoAttachmentRequest {
    #[serde(flatten)]
    metadata: PhotoMetadata,
    attachment_id: Uuid,
    channel_id: Uuid,
}

struct Asked {
    branch: Branch,
    provider: ImageProvider,
    meta: Metadata,
}

fn check_request(actor: Actor, metadata: PhotoMetadata) -> Result<Asked, ApiError> {
    let branch = Branch::from_label(&metadata.branch).ok_or_else(invalid)?;
    let provider =
        ImageProvider::from_label(&metadata.acknowledged_provider).ok_or_else(invalid)?;
    let meta: Metadata = serde_json::from_value(json!({
        "name": metadata.name,
        "displayName": metadata.display_name,
        "tags": metadata.tags,
        "subjectMemberId": metadata.subject_member_id,
    }))
    .map_err(|_| invalid())?;
    meta.validate().map_err(failure)?;
    // D6: a face means its owner registers it. Re-proved in `create_draft`; stopping here only
    // saves a call that could never end in a draft.
    if meta
        .subject_member_id
        .is_some_and(|subject| subject != actor.member)
    {
        return Err(failure(Error::Role));
    }
    Ok(Asked {
        branch,
        provider,
        meta,
    })
}

async fn read_form(
    state: &AppState,
    request: Request,
) -> Result<(PhotoMetadata, Vec<u8>), ApiError> {
    let mut form = Multipart::from_request(request, state)
        .await
        .map_err(|_| invalid())?;
    let (mut metadata, mut file) = (None, None);
    while let Some(mut field) = form
        .next_field()
        .await
        .map_err(|_| media_error(media::Rejected::TooLarge))?
    {
        match field.name() {
            Some("metadata") if metadata.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|_| invalid())? {
                    if bytes.len() + chunk.len() > 16 * 1024 {
                        return Err(invalid());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                metadata = Some(serde_json::from_slice(&bytes).map_err(|_| invalid())?);
            }
            Some("file") if file.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|_| media_error(media::Rejected::TooLarge))?
                {
                    if bytes.len() + chunk.len() > expressions::INPUT_BYTES {
                        return Err(media_error(media::Rejected::TooLarge));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                file = Some(bytes);
            }
            _ => return Err(invalid()),
        }
    }
    Ok((metadata.ok_or_else(invalid)?, file.ok_or_else(invalid)?))
}

/// The attachment's bytes, after the same ownership proof `from-attachment` makes — before the
/// Drive read and again after it (no transaction spans Drive).
async fn read_attachment(
    state: &AppState,
    actor: Actor,
    request: &PhotoAttachmentRequest,
) -> Result<Vec<u8>, ApiError> {
    let file = expressions::attachment_source(
        &state.pool,
        actor,
        request.channel_id,
        request.attachment_id,
    )
    .await
    .map_err(failure)?;
    let content = state
        .drive
        .file_content(&file, expressions::INPUT_BYTES as i64)
        .await
        .map_err(|_| failure(Error::NotFound))?;
    let mut stream = content.body;
    let bytes = tokio::time::timeout(Duration::from_secs(10), async move {
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| failure(Error::NotFound))?;
            if bytes.len() + chunk.len() > expressions::INPUT_BYTES {
                return Err(media_error(media::Rejected::TooLarge));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok::<_, ApiError>(bytes)
    })
    .await
    .map_err(|_| media_error(media::Rejected::Timeout))??;
    expressions::attachment_source(
        &state.pool,
        actor,
        request.channel_id,
        request.attachment_id,
    )
    .await
    .map_err(failure)?;
    Ok(bytes)
}

/// The closed codes a member can meet (ADR-0218 §8 H9). Not one carries a word a provider wrote.
fn model_failure(error: ImageModelError) -> ApiError {
    match error {
        // The team has no model this key can use: the same guidance as no model at all.
        ImageModelError::Denied => ApiError::coded(
            StatusCode::CONFLICT,
            "image_model_unavailable",
            "the connected key cannot use an image model",
        ),
        ImageModelError::Refused => ApiError::coded(
            StatusCode::UNPROCESSABLE_ENTITY,
            "image_model_refused",
            "the image model declined this picture",
        ),
        ImageModelError::TimedOut => ApiError::coded(
            StatusCode::GATEWAY_TIMEOUT,
            "image_model_timeout",
            "the image model did not answer in time",
        ),
        ImageModelError::Failed | ImageModelError::TooLarge | ImageModelError::Egress => {
            ApiError::coded(
                StatusCode::BAD_GATEWAY,
                "image_model_failed",
                "the image model could not draw this picture",
            )
        }
    }
}

fn unavailable() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "image_model_unavailable",
        "no image model is connected",
    )
}

/// A stable, pseudonymous id of the member for the provider's abuse monitoring: not a name, not an
/// email, not an id this server uses anywhere else.
fn safety_id(actor: Actor) -> String {
    let id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("oort-safety:{}:{}", actor.workspace, actor.member).as_bytes(),
    );
    format!("oort-{}", id.simple())
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(ws): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    // 1. Authority, before any of the body is read.
    human(&principal)?;
    let actor = actor(&ws, &principal)?;
    expressions::preflight_import(&state.pool, actor)
        .await
        .map_err(failure)?;
    // 2. Whose photo it is.
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (asked, photo) = if content_type.starts_with("multipart/form-data") {
        let (metadata, photo) = read_form(&state, request).await?;
        (check_request(actor, metadata)?, photo)
    } else if content_type.starts_with("application/json") {
        let bytes = to_bytes(request.into_body(), 64 * 1024)
            .await
            .map_err(|_| invalid())?;
        let body: PhotoAttachmentRequest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let photo = read_attachment(&state, actor, &body).await?;
        (check_request(actor, body.metadata)?, photo)
    } else {
        return Err(invalid());
    };
    // 5. Admitted: from here the team's money is at stake.
    let _admitted = Admitted::take(actor.member)?;
    // 3. The photo that leaves is a new picture made from the pixels of the one that arrived.
    let prepared = media::prepare_photo(photo)
        .await
        .map_err(|rejected| match rejected {
            // Both decoder slots taken is the server's state, not a property of the photo: nothing has
            // been sent and nothing has been spent, so the member simply tries again.
            media::Rejected::Busy => ApiError::busy(2),
            other => media_error(other),
        })?;
    // 4. Consent is to the company the key reaches right now.
    let target = read_team_key(&state, actor.workspace)
        .await?
        .ok_or_else(unavailable)?;
    if target.provider != asked.provider {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "image_model_changed",
            "the connected image model changed; ask again",
        ));
    }
    let mime: &'static str = if prepared.mime == "image/png" {
        "image/png"
    } else {
        "image/jpeg"
    };
    let safety = safety_id(actor);
    let started = Instant::now();
    let generated = state
        .image_model
        .generate(GenerateRequest {
            target: &target,
            photo: Photo {
                bytes: &prepared.data,
                mime,
            },
            branch: asked.branch,
            safety_id: Some(&safety),
        })
        .await
        .map_err(model_failure)?;
    let model_ms = started.elapsed().as_millis() as u64;
    // 6. What came back, decoded in the isolated child, and the draft it becomes.
    let picture_failure = |rejected: media::Rejected| match rejected {
        media::Rejected::Busy => ApiError::busy(2),
        _ => model_failure(ImageModelError::Failed),
    };
    let (processed, outcome) = match asked.branch {
        Branch::Cutout => {
            let cut = media::process_cutout(generated.bytes, DECODE_WAIT)
                .await
                .map_err(picture_failure)?;
            (cut.processed, Some(cut.outcome))
        }
        Branch::Caricature => (
            media::process_waiting(generated.bytes, DECODE_WAIT)
                .await
                .map_err(picture_failure)?,
            None,
        ),
    };
    let origin = Origin::photo(asked.branch.as_str()).ok_or_else(invalid)?;
    let draft = expressions::create_draft_with(
        &state.pool,
        actor,
        asked.meta,
        origin,
        Some(processed),
        None,
        json!({
            "provider": target.provider.as_str(),
            "model": target.model,
            "branch": asked.branch.as_str(),
            "cutout": outcome.map(cutout::Outcome::as_str),
            "model_ms": model_ms,
            "photo_bytes": prepared.data.len(),
        }),
    )
    .await
    .map_err(failure)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "draft": draft,
            "cutout": outcome.map(cutout::Outcome::as_str),
        })),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_settings::chain::DecryptedChainEntry;

    fn env(base: &str, bearer: &str, mode: ProviderMode) -> ProviderConfig {
        ProviderConfig {
            mode,
            base_url: base.into(),
            bearer: bearer.into(),
            allow_local_loopback: false,
        }
    }

    fn link(base: &str, credential: LinkCredential, mode: ProviderMode) -> DecryptedProviderLink {
        DecryptedProviderLink {
            base_url: base.into(),
            bearer: credential.presentable_bearer().to_string(),
            credential,
            mode,
            updated_by_member_id: None,
            updated_at_ms: 0,
        }
    }

    fn hop(base: &str, bearer: &str, mode: ProviderMode, enabled: bool) -> DecryptedChainEntry {
        DecryptedChainEntry {
            id: Uuid::new_v4(),
            position: 1,
            base_url: base.into(),
            bearer: bearer.into(),
            mode,
            enabled,
        }
    }

    const REAL: &str = "sk-live-real-looking-key-0001";

    fn picked(
        env: &ProviderConfig,
        link: Option<&DecryptedProviderLink>,
        chain: &[DecryptedChainEntry],
    ) -> Option<ImageModelTarget> {
        pick_target(
            &ImageModelConfig::default(),
            key_candidates(env, link, chain),
        )
    }

    #[test]
    fn the_database_link_is_the_head_and_the_environment_is_only_what_there_is_without_one() {
        let nothing = env(
            "http://localhost:8088/v1",
            "dev-insecure-hermes-bearer",
            ProviderMode::LocalMock,
        );
        // No link, a placeholder in the environment: no model.
        assert!(picked(&nothing, None, &[]).is_none());
        // The environment trio is a real OpenAI key: that is the team key.
        let from_env = env(
            "https://api.openai.com/v1",
            REAL,
            ProviderMode::ExternalHermes,
        );
        let target = picked(&from_env, None, &[]).expect("an environment key counts");
        assert_eq!(target.provider, ImageProvider::OpenAi);
        assert_eq!(target.api_key, REAL);
        assert_eq!(target.base_url, momo_image_model::OPENAI_BASE);
        assert_eq!(target.model, momo_image_model::DEFAULT_OPENAI_MODEL);
        // A usable database link beats it: Gemini now, and the environment key is not used.
        let gemini = link(
            "https://generativelanguage.googleapis.com/v1beta/openai",
            LinkCredential::Bearer("AIza-team-gemini-key-0002".into()),
            ProviderMode::ExternalHermes,
        );
        let target = picked(&from_env, Some(&gemini), &[]).unwrap();
        assert_eq!(target.provider, ImageProvider::Gemini);
        assert_eq!(target.api_key, "AIza-team-gemini-key-0002");
        assert_eq!(target.base_url, momo_image_model::GEMINI_BASE);
    }

    #[test]
    fn only_a_plain_api_key_for_one_of_the_two_providers_in_a_real_mode_draws() {
        let none = env(
            "http://localhost:8088/v1",
            "dev-insecure-hermes-bearer",
            ProviderMode::LocalMock,
        );
        let openai = "https://api.openai.com/v1";
        // An OAuth subscription and an Anthropic key never draw, even on OpenAI's own host.
        let anthropic = link(
            openai,
            LinkCredential::AnthropicKey(REAL.into()),
            ProviderMode::ExternalHermes,
        );
        assert!(picked(&none, Some(&anthropic), &[]).is_none());
        // A mock mode is not a provider.
        let mock = link(
            openai,
            LinkCredential::Bearer(REAL.into()),
            ProviderMode::InternalHostMock,
        );
        assert!(picked(&none, Some(&mock), &[]).is_none());
        // A host that merely speaks the same chat wire is not an image provider.
        let gateway = link(
            "https://openrouter.ai/api/v1",
            LinkCredential::Bearer(REAL.into()),
            ProviderMode::ExternalHermes,
        );
        assert!(picked(&none, Some(&gateway), &[]).is_none());
        // A placeholder secret is not a key.
        let placeholder = link(
            openai,
            LinkCredential::Bearer("dev-insecure-hermes-bearer".into()),
            ProviderMode::ExternalHermes,
        );
        assert!(picked(&none, Some(&placeholder), &[]).is_none());
    }

    #[test]
    fn a_fallback_hop_is_used_when_the_head_is_not_an_image_provider_and_a_disabled_one_never() {
        let none = env(
            "http://localhost:8088/v1",
            "dev-insecure-hermes-bearer",
            ProviderMode::LocalMock,
        );
        let head = link(
            "https://api.anthropic.com/v1",
            LinkCredential::AnthropicKey(REAL.into()),
            ProviderMode::ExternalHermes,
        );
        let on = hop(
            "https://api.openai.com/v1",
            REAL,
            ProviderMode::ExternalHermes,
            true,
        );
        let off = hop(
            "https://api.openai.com/v1",
            REAL,
            ProviderMode::ExternalHermes,
            false,
        );
        let target = picked(&none, Some(&head), std::slice::from_ref(&on)).expect("hop 1 draws");
        assert_eq!(target.provider, ImageProvider::OpenAi);
        assert!(picked(&none, Some(&head), std::slice::from_ref(&off)).is_none());
        // An Anthropic envelope sitting in a hop is not a plain key either.
        let sealed = hop(
            "https://api.openai.com/v1",
            r#"{"kind":"anthropic-key","api_key":"sk-ant-0003"}"#,
            ProviderMode::ExternalHermes,
            true,
        );
        assert!(picked(&none, Some(&head), &[sealed]).is_none());
    }

    #[test]
    fn a_member_slot_is_returned_when_the_request_is_dropped_and_two_never_overlap() {
        let member = Uuid::new_v4();
        let first = Admitted::take(member).expect("admitted");
        assert!(Admitted::take(member).is_err(), "one in flight per member");
        let other = Admitted::take(Uuid::new_v4()).expect("another member is not blocked");
        drop(first);
        assert!(
            Admitted::take(member).is_ok(),
            "the slot came back with the request"
        );
        drop(other);
    }

    #[test]
    fn the_safety_id_is_stable_pseudonymous_and_safe_to_send() {
        let a = Actor {
            workspace: Uuid::new_v4(),
            member: Uuid::new_v4(),
        };
        let id = safety_id(a);
        assert_eq!(id, safety_id(a));
        assert!(id.starts_with("oort-") && id.len() == 37 && id.len() <= 128);
        assert!(!id.contains(&a.member.to_string()) && !id.contains(&a.workspace.to_string()));
        assert_ne!(
            id,
            safety_id(Actor {
                member: Uuid::new_v4(),
                ..a
            })
        );
    }
}
