//! 사진으로 팀 이모티콘 (ADR-0218 §8 H9, #4941): the team's image model draws from a member's own
//! photo, and the picture becomes the same direct draft every other way of adding one ends in.
//!
//! ```text
//! GET  /v1/workspaces/{ws}/expressions/photo-model    which company a photo would go to, if any
//! POST /v1/workspaces/{ws}/expressions/photo-drafts   photo + branch + name  ->  { draft, cutout }
//! GET  /v1/workspaces/{ws}/expressions/photo-drafts   the caller's own live photo drafts -> { items }
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
//!    deadline, a 12 MiB answer, a 5 MiB picture. The places are held by the task that does the
//!    work, until the call has ended ([`hold_until_done`]); the request only waits for its answer.
//!    The call is made once: a decoder that is busy when the picture comes back is waited for
//!    ([`DECODE_PATIENCE`]), never answered with a second call.
//!    A start is also counted by the per-member write budget (`rate_limit::MemberWrite::PhotoDraft`).
//!    The key, the photo and the answer are never logged and never come back in a response; the
//!    failure the member sees is one closed code.
//! 6. **What comes back is decoded in the isolated child too** (`process_cutout` for a cut-out,
//!    the ordinary picture path for a caricature) and stored as a draft whose origin is the one
//!    fixed sentence for the branch. The member sees exactly the picture that would be saved.
//!
//! ## The one boundary this route widens
//!
//! `provider_link` is readable only inside the operator transaction (`app.provider_link_admin`,
//! migration 039), and the doc of that transaction says it is bound only after the route's
//! instance-operator gate. This route binds it for a *member's* request, in one function
//! ([`read_team_key`]), after rule 1 — for `photo-model` as well as for the photo request, so only
//! someone who may send a photo is told which company it would go to — to hand the opened key to
//! the image client and to nobody else: the key is never a field of a response, a log line, an
//! audit row or an error. The order is a tested property: the key is opened through
//! [`TeamKeySource`], which a test wraps to count the openings. ADR-0218 §8 H9 records this as the
//! decision and as the first thing the security review looks at.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::to_bytes;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures::future::BoxFuture;
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
/// How long a picture the team has already paid for keeps asking for a decoder slot when both are
/// taken, before it is given up (ADR-0218 §9 I2, #4992). The one place the number lives: it is the
/// patience of [`media::process_cutout_patiently`] and [`media::process_waiting_patiently`], each ask
/// of which stands in line for at most [`media::WAIT_MAX`]. The provider is never asked again.
const DECODE_PATIENCE: Duration = Duration::from_secs(15);

fn instance_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(IN_FLIGHT)))
}

fn members_in_flight() -> &'static Mutex<HashSet<Uuid>> {
    static MEMBERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    MEMBERS.get_or_init(Mutex::default)
}

/// The two places a photo request holds from the moment it is admitted until the work it was
/// admitted for has ended. [`hold_until_done`] puts the guard on the task that does that work, so
/// the places come back when the call is over, whether or not anyone is still waiting for it.
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

/// Run `work` — everything after admission — to its end on a task of its own, holding `admitted`
/// until then. The request only waits for the answer: if nobody is waiting any more the work still
/// finishes, the draft it makes is kept, and the two places are given back when it ends. A panic in
/// the work is an internal error and gives them back too.
async fn hold_until_done<T, F>(admitted: Admitted, work: F) -> Result<T, ApiError>
where
    F: Future<Output = Result<T, ApiError>> + Send + 'static,
    T: Send + 'static,
{
    tokio::spawn(async move {
        let _admitted = admitted;
        work.await
    })
    .await
    .map_err(|error| ApiError::internal("expression_photo.work", error))?
}

// ---- the team key ----------------------------------------------------------------------------

/// One opened team key that might reach an image model. `Debug` is by hand, like the target's: the
/// key is a live credential.
#[derive(Clone, PartialEq, Eq)]
struct KeyCandidate {
    base_url: String,
    key: String,
    mode: ProviderMode,
}

impl std::fmt::Debug for KeyCandidate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeyCandidate")
            .field(
                "base_url",
                &momo_settings::redacted_endpoint_label(&self.base_url),
            )
            .field("key", &"<redacted>")
            .field("mode", &self.mode)
            .finish()
    }
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

/// Where the route opens the team's image key from. The only production source is
/// [`SealedLink`]; a test wraps it to count how often, and after which refusals, the key is opened.
pub trait TeamKeySource: Send + Sync {
    /// `Ok(None)` is 「no image model is connected」.
    fn open<'a>(
        &'a self,
        state: &'a AppState,
        workspace: Uuid,
    ) -> BoxFuture<'a, Result<Option<ImageModelTarget>, ApiError>>;
}

/// The team key as the operator stored it: `provider_link` and its fallback hops opened with the
/// master key, or the environment trio when there is no link.
pub struct SealedLink;

impl TeamKeySource for SealedLink {
    fn open<'a>(
        &'a self,
        state: &'a AppState,
        workspace: Uuid,
    ) -> BoxFuture<'a, Result<Option<ImageModelTarget>, ApiError>> {
        Box::pin(read_sealed_link(state, workspace))
    }
}

/// Open the team key, and choose the one the image model is asked with. This is the one door the
/// route reaches the sealed credential through (module docs, 「the one boundary this route
/// widens」).
async fn read_team_key(
    state: &AppState,
    workspace: Uuid,
) -> Result<Option<ImageModelTarget>, ApiError> {
    state.team_keys.open(state, workspace).await
}

/// Read and open the team keys, and choose the one the image model is asked with. `Ok(None)` is
/// 「no image model is connected」: no master key to open anything with, no key, or no key that
/// reaches OpenAI or Gemini.
async fn read_sealed_link(
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
/// Only someone who may add a picture is told (`preflight_add`, the proof every other way of
/// adding makes first): a guest, an agent and a member the add policy leaves out are refused
/// before the team key is opened. `canManage` says whether the caller may connect a model (the
/// instance operator), which decides whether the guidance links to the settings or tells them to
/// ask.
pub async fn availability(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(ws): Path<String>,
) -> Result<Json<Value>, ApiError> {
    human(&principal)?;
    let actor = actor(&ws, &principal)?;
    expressions::preflight_add(&state.pool, actor)
        .await
        .map_err(failure)?;
    let target = read_team_key(&state, actor.workspace).await?;
    let can_manage = require_instance_operator(&state, &principal).await.is_ok();
    Ok(Json(json!({
        "available": target.is_some(),
        "provider": target.as_ref().map(|target| target.provider.as_str()),
        "branches": [Branch::Cutout.as_str(), Branch::Caricature.as_str()],
        "canManage": can_manage,
    })))
}

// ---- GET photo-drafts ------------------------------------------------------------------------

/// The caller's own photo drafts that are still alive (ADR-0218 §9 I1): the way back to a picture
/// the work finished after the screen that was waiting for it was gone. A plain read of the
/// caller's own rows ([`expressions::list_photo_drafts`]): it opens no team key, calls no provider,
/// takes no catalog lock, spends no photo-start budget and says nothing about the team's image
/// model. Each item is exactly what `GET …/expression-drafts/{draftId}` answers for it, so a draft
/// found here is opened, replaced and registered through the routes that already do that.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(ws): Path<String>,
) -> Result<Json<Value>, ApiError> {
    human(&principal)?;
    let actor = actor(&ws, &principal)?;
    let items = expressions::list_photo_drafts(&state.pool, actor)
        .await
        .map_err(failure)?;
    Ok(Json(json!({ "items": items })))
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
    channel_id: Uuid,
    attachment_id: Uuid,
) -> Result<Vec<u8>, ApiError> {
    let file = expressions::attachment_source(&state.pool, actor, channel_id, attachment_id)
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
    expressions::attachment_source(&state.pool, actor, channel_id, attachment_id)
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
    // 2. Whose photo it is. A request this route cannot act on is refused before the attachment
    //    it names is looked up or read.
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
        let PhotoAttachmentRequest {
            metadata,
            attachment_id,
            channel_id,
        } = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let asked = check_request(actor, metadata)?;
        let photo = read_attachment(&state, actor, channel_id, attachment_id).await?;
        (asked, photo)
    } else {
        return Err(invalid());
    };
    // 5. Admitted: from here the team's money is at stake. What follows runs to its end on a task
    //    that holds the places, and this request only waits for the answer.
    let admitted = Admitted::take(actor.member)?;
    hold_until_done(admitted, finish(state, actor, asked, photo)).await
}

/// Rules 3 to 6 of the module docs for a request that has been admitted: prepare the photo, open
/// the team key, ask once, decode what came back and keep it as a draft. It runs through
/// [`hold_until_done`], so it is not cut short when the request that started it is gone.
async fn finish(
    state: AppState,
    actor: Actor,
    asked: Asked,
    photo: Vec<u8>,
) -> Result<Response, ApiError> {
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
    // 6. What came back, decoded in the isolated child, and the draft it becomes. The picture is
    //    paid for: if both decoder slots are taken it waits for one, asking again for
    //    `DECODE_PATIENCE` and holding the bytes it has, and only then is it given up. The provider
    //    is asked once, whatever happens here.
    let picture_failure = |rejected: media::Rejected| match rejected {
        media::Rejected::Busy => {
            // Numbers only: the one place an operator can see that a paid-for picture was dropped.
            tracing::warn!(
                patience_secs = DECODE_PATIENCE.as_secs(),
                model_ms,
                "expression photo: the decoder stayed busy and a picture the team paid for was dropped"
            );
            ApiError::busy(2)
        }
        _ => model_failure(ImageModelError::Failed),
    };
    let (processed, outcome) = match asked.branch {
        Branch::Cutout => {
            let cut = media::process_cutout_patiently(generated.bytes, DECODE_PATIENCE)
                .await
                .map_err(picture_failure)?;
            (cut.processed, Some(cut.outcome))
        }
        Branch::Caricature => (
            media::process_waiting_patiently(generated.bytes, DECODE_PATIENCE)
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
    use std::sync::atomic::{AtomicBool, Ordering};

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
    fn a_member_has_one_place_and_it_comes_back_with_its_holder() {
        let member = Uuid::new_v4();
        let first = Admitted::take(member).expect("admitted");
        assert!(Admitted::take(member).is_err(), "one in flight per member");
        let other = Admitted::take(Uuid::new_v4()).expect("another member is not blocked");
        drop(first);
        assert!(
            Admitted::take(member).is_ok(),
            "the place came back with its holder"
        );
        drop(other);
    }

    /// A place of its own, registered for `member` the way [`Admitted::take`] registers one but
    /// not one of the instance's four: the unit tests of this file share this process's statics,
    /// and tests that each took from the four could refuse one another.
    fn own_place(member: Uuid) -> Admitted {
        assert!(
            members_in_flight().lock().expect("members").insert(member),
            "a new member has no place yet"
        );
        Admitted {
            member,
            _instance: Arc::new(Semaphore::new(1))
                .try_acquire_owned()
                .expect("a place of its own"),
        }
    }

    fn holds_a_place(member: Uuid) -> bool {
        members_in_flight()
            .lock()
            .expect("members")
            .contains(&member)
    }

    #[tokio::test]
    async fn the_places_are_held_until_the_work_ends_whether_or_not_anyone_waits_for_it() {
        let member = Uuid::new_v4();
        let (entered, gate) = (Arc::new(Semaphore::new(0)), Arc::new(Semaphore::new(0)));
        let finished = Arc::new(AtomicBool::new(false));
        let work = {
            let (entered, gate, finished) = (entered.clone(), gate.clone(), finished.clone());
            async move {
                entered.add_permits(1);
                gate.acquire().await.expect("gate").forget();
                finished.store(true, Ordering::SeqCst);
                Ok::<u32, ApiError>(7)
            }
        };
        let waiting = tokio::spawn(hold_until_done(own_place(member), work));
        entered.acquire().await.expect("entered").forget();
        // The one waiting for the answer stops waiting.
        waiting.abort();
        assert!(waiting.await.expect_err("it was aborted").is_cancelled());
        assert!(
            holds_a_place(member),
            "the place is still the work's while the work runs"
        );
        // The work ends: it ran to its end, and only then is the place back.
        gate.add_permits(1);
        let mut back = false;
        for _ in 0..200 {
            if !holds_a_place(member) {
                back = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(back, "the place came back when the work ended");
        assert!(
            finished.load(Ordering::SeqCst),
            "and the work had run to its end"
        );
    }

    #[tokio::test]
    async fn the_answer_of_the_work_reaches_the_request_that_waits_and_a_panic_is_a_500() {
        let member = Uuid::new_v4();
        let answered =
            hold_until_done(own_place(member), async { Ok::<_, ApiError>("drawn") }).await;
        assert_eq!(answered.expect("the work's answer"), "drawn");
        assert!(!holds_a_place(member), "the place is back after an answer");

        let panicked =
            hold_until_done::<(), _>(own_place(member), async { panic!("the work failed") }).await;
        assert_eq!(
            panicked.expect_err("a panic is an error").status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(
            !holds_a_place(member),
            "the place is back after a panic too"
        );
    }

    #[test]
    fn a_candidate_prints_without_its_key() {
        let candidate = KeyCandidate {
            base_url: "https://user:hunter2@api.openai.com/v1?token=abc".into(),
            key: REAL.into(),
            mode: ProviderMode::ExternalHermes,
        };
        let shown = format!("{candidate:?} {candidate:#?} {:?}", vec![candidate.clone()]);
        assert!(!shown.contains(REAL), "the key is printed: {shown}");
        assert!(
            !shown.contains("hunter2") && !shown.contains("token=abc"),
            "the address keeps no secret: {shown}"
        );
        assert!(shown.contains("<redacted>"));
        assert!(shown.contains("api.openai.com"), "it still says where");
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

    #[test]
    fn a_paid_for_picture_waits_fifteen_seconds_for_a_decoder_and_each_ask_stays_within_the_line() {
        // ADR-0218 §9 I2 says fifteen seconds, and says them once: this constant. A longer patience
        // would hold a member's place and one of the instance's four for longer, so it is a decision.
        assert_eq!(DECODE_PATIENCE, Duration::from_secs(15));
        // Each ask is still the line's own three seconds at most: the patience is many asks, not one
        // long stand in line in front of a person's upload.
        assert!(media::WAIT_MAX < DECODE_PATIENCE);
        assert_eq!(media::WAIT_MAX, Duration::from_secs(3));
    }

    /// The team key has one door (ADR-0218 §8 H11 (a)): the route opens it through [`TeamKeySource`],
    /// and the production source reads the sealed link in one function. The PG test counts the
    /// openings that go through the trait (`CountingKeys`); it cannot see a second way in that does
    /// not — a call to the sealed-link reader, or a new binding of the operator transaction, from
    /// another function of this file (#4992, L5). So this reads the file's own code and counts.
    #[test]
    fn the_team_key_has_one_door_in_this_file() {
        let source = include_str!("expression_photo.rs");
        let (code, _tests) = source
            .split_once("\n#[cfg(test)]\nmod tests")
            .expect("the test module follows the code");
        let code = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let count = |needle: &str| code.matches(needle).count();
        let rule = "a new way to open the team key needs the review of ADR-0218 §8 H11 (a): \
                    change the one door, `read_sealed_link`, and not beside it";
        assert_eq!(
            count("with_provider_link_admin_tx("),
            1,
            "the operator transaction is bound in one place; {rule}"
        );
        assert_eq!(
            count("read_sealed_link("),
            2,
            "the sealed link is read by its definition and by `SealedLink::open` and nobody else; {rule}"
        );
        assert_eq!(
            count("team_keys.open("),
            1,
            "the route opens the key through the trait in one function, `read_team_key`; {rule}"
        );
        assert_eq!(
            count("read_team_key("),
            3,
            "`read_team_key` is its definition and the two requests that may open the key \
             (`availability` and `finish`); {rule}"
        );
    }
}
