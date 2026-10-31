//! ADR-0218 appendix A. Authentication/role checks precede multipart collection.
use axum::body::{to_bytes, Body};
use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{Principal, PrincipalKind};
use momo_expressions::{
    self as expressions, intake, media, Actor, Choice, Error, Metadata, Origin, Patch, Report,
};
use momo_unfurl::{fetch_source, parse_source_url, SOURCE_DEADLINE};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{error::ApiError, AppState};

pub(crate) fn failure(error: Error) -> ApiError {
    let (status, code) = match error {
        Error::Invalid => (StatusCode::BAD_REQUEST, "expression_invalid"),
        Error::Role => (StatusCode::FORBIDDEN, "expression_role_required"),
        Error::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        Error::NameReserved => (StatusCode::CONFLICT, "expression_name_reserved"),
        Error::Quota => (StatusCode::CONFLICT, "expression_quota"),
        Error::Stale => (StatusCode::CONFLICT, "expression_preview_stale"),
        Error::Expired => (StatusCode::GONE, "expression_draft_expired"),
        Error::Db(e) => return ApiError::internal("expressions", e),
    };
    ApiError::coded(status, code, code)
}
pub(crate) fn invalid() -> ApiError {
    failure(Error::Invalid)
}
pub(crate) fn actor(ws: &str, p: &Principal) -> Result<Actor, ApiError> {
    let workspace = Uuid::parse_str(ws).map_err(|_| invalid())?;
    if workspace != p.workspace_id {
        return Err(failure(Error::NotFound));
    }
    if p.kind == PrincipalKind::WorkHost {
        return Err(failure(Error::NotFound));
    }
    Ok(Actor {
        workspace,
        member: p.member_id,
    })
}
pub(crate) fn human(p: &Principal) -> Result<(), ApiError> {
    if p.kind != PrincipalKind::Human {
        return Err(failure(Error::Role));
    }
    Ok(())
}
fn id(s: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(s).map_err(|_| failure(Error::NotFound))
}
async fn json<T: DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    let bytes = to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

async fn multipart(
    state: &AppState,
    request: Request,
    with_metadata: bool,
) -> Result<(Option<Metadata>, Vec<u8>), ApiError> {
    let mut form = Multipart::from_request(request, state)
        .await
        .map_err(|_| invalid())?;
    let (mut meta, mut file) = (None, None);
    while let Some(mut field) = form
        .next_field()
        .await
        .map_err(|_| media_error(media::Rejected::TooLarge))?
    {
        match field.name() {
            Some("metadata") if with_metadata && meta.is_none() => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|_| invalid())? {
                    if bytes.len() + chunk.len() > 16 * 1024 {
                        return Err(invalid());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value: Metadata = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
                value.validate().map_err(failure)?;
                meta = Some(value);
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
    if with_metadata && meta.is_none() {
        return Err(invalid());
    }
    Ok((meta, file.ok_or_else(invalid)?))
}
pub(crate) fn media_error(e: media::Rejected) -> ApiError {
    ApiError::coded(
        if e == media::Rejected::TooLarge {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        },
        "expression_media_invalid",
        "expression media invalid",
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Since {
    since: Option<String>,
}
pub async fn list(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(ws): Path<String>,
    Query(q): Query<Since>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        expressions::list(&state.pool, actor(&ws, &p)?, q.since)
            .await
            .map_err(failure)?,
    ))
}
pub async fn upload(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(ws): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    human(&p)?;
    let actor = actor(&ws, &p)?;
    expressions::preflight_add(&state.pool, actor)
        .await
        .map_err(failure)?;
    let (meta, bytes) = multipart(&state, request, true).await?;
    prepare(
        &state,
        actor,
        meta.ok_or_else(invalid)?,
        Origin::upload(),
        bytes,
    )
    .await
}
async fn prepare(
    state: &AppState,
    actor: Actor,
    meta: Metadata,
    origin: Origin,
    bytes: Vec<u8>,
) -> Result<Response, ApiError> {
    let (media, code, status) = match media::process(bytes).await {
        Ok(media) => (Some(media), None, StatusCode::CREATED),
        Err(media::Rejected::Video) => (None, Some("video_processing_unavailable"), StatusCode::OK),
        Err(e) => return Err(media_error(e)),
    };
    let value = expressions::create_draft(&state.pool, actor, meta, origin, media, code)
        .await
        .map_err(failure)?;
    Ok((status, Json(value)).into_response())
}
pub async fn get_draft(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, draft)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        expressions::get_draft(&state.pool, actor(&ws, &p)?, id(&draft)?)
            .await
            .map_err(failure)?,
    ))
}
pub async fn replace(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, draft)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    human(&p)?;
    let actor = actor(&ws, &p)?;
    let id = id(&draft)?;
    expressions::preflight_add(&state.pool, actor)
        .await
        .map_err(failure)?;
    expressions::get_draft(&state.pool, actor, id)
        .await
        .map_err(failure)?;
    let (_, bytes) = multipart(&state, request, false).await?;
    let media = media::process(bytes).await.map_err(media_error)?;
    let replaced = match expressions::replace_draft(&state.pool, actor, id, media.clone()).await {
        // Not the caller's own direct draft: it may be a candidate of an open approval card.
        Err(Error::NotFound) => replace_candidate(&state, actor, id, media).await,
        other => other,
    };
    Ok(Json(replaced.map_err(failure)?))
}

/// ADR-0186 v8 X8-4: a candidate of an open `expression.create` card, replaced by a direct
/// upload. One transaction swaps the pixels (same draft id, origin, name, face and TTL;
/// revision + 1) and rewrites the card's `action.expression`, then announces the edit on the
/// request card so every open view shows the new picture and the old choice goes stale.
async fn replace_candidate(
    state: &AppState,
    actor: Actor,
    id: Uuid,
    media: media::Processed,
) -> Result<Value, Error> {
    expressions::transaction(&state.pool, actor, move |conn| {
        Box::pin(async move {
            let replaced =
                expressions::action::replace_candidate_in_tx(conn, actor, id, &media).await?;
            if let Some(message_id) = replaced.request_message_id {
                momo_db::sqlx::query(
                    "UPDATE message SET props = jsonb_set(COALESCE(props, '{}'::jsonb), '{action,expression}', $3, true) \
                      WHERE workspace_id = $1 AND id = $2 AND props #> '{action}' IS NOT NULL",
                )
                .bind(actor.workspace)
                .bind(message_id)
                .bind(&replaced.card)
                .execute(&mut *conn)
                .await?;
                momo_messaging::emit_message_edited_in_tx(conn, actor.workspace, message_id)
                    .await?;
            }
            Ok(replaced.draft)
        })
    })
    .await
}
pub async fn activate(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(ws): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    human(&p)?;
    let choice: Choice = json(request).await?;
    Ok((
        StatusCode::CREATED,
        Json(
            expressions::activate(&state.pool, actor(&ws, &p)?, choice)
                .await
                .map_err(failure)?,
        ),
    ))
}
pub async fn patch(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, expression)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    human(&p)?;
    let patch: Patch = json(request).await?;
    Ok(Json(
        expressions::mutate(
            &state.pool,
            actor(&ws, &p)?,
            id(&expression)?,
            Some(patch),
            None,
        )
        .await
        .map_err(failure)?,
    ))
}
pub async fn delete(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, expression)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    human(&p)?;
    Ok(Json(
        expressions::mutate(&state.pool, actor(&ws, &p)?, id(&expression)?, None, None)
            .await
            .map_err(failure)?,
    ))
}
pub async fn report(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, expression)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    human(&p)?;
    let report: Report = json(request).await?;
    Ok(Json(
        expressions::mutate(
            &state.pool,
            actor(&ws, &p)?,
            id(&expression)?,
            None,
            Some(report),
        )
        .await
        .map_err(failure)?,
    ))
}

#[derive(Deserialize)]
pub struct ImageQuery {
    size: Option<String>,
    v: Option<String>,
}
async fn image(
    state: &AppState,
    actor: Actor,
    id: Uuid,
    q: ImageQuery,
    draft: bool,
) -> Result<Response, ApiError> {
    let image = expressions::image(
        &state.pool,
        actor,
        id,
        q.size.unwrap_or_default(),
        q.v.unwrap_or_default(),
        draft,
    )
    .await
    .map_err(failure)?;
    let mut response = Body::from(image.data).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        image.info.mime.parse().map_err(|_| invalid())?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        "private, no-store".parse().map_err(|_| invalid())?,
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().map_err(|_| invalid())?,
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox"
            .parse()
            .map_err(|_| invalid())?,
    );
    Ok(response)
}
pub async fn expression_image(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, expression)): Path<(String, String)>,
    Query(q): Query<ImageQuery>,
) -> Result<Response, ApiError> {
    image(&state, actor(&ws, &p)?, id(&expression)?, q, false).await
}
pub async fn draft_image(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path((ws, draft)): Path<(String, String)>,
    Query(q): Query<ImageQuery>,
) -> Result<Response, ApiError> {
    image(&state, actor(&ws, &p)?, id(&draft)?, q, true).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentRequest {
    name: String,
    display_name: String,
    tags: Vec<String>,
    subject_member_id: Value,
    attachment_id: Uuid,
    channel_id: Uuid,
}
pub async fn from_attachment(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(ws): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    use futures::StreamExt;
    human(&p)?;
    let actor = actor(&ws, &p)?;
    expressions::preflight_add(&state.pool, actor)
        .await
        .map_err(failure)?;
    let r: AttachmentRequest = json(request).await?;
    let meta:Metadata=serde_json::from_value(serde_json::json!({"name":r.name,"displayName":r.display_name,"tags":r.tags,"subjectMemberId":r.subject_member_id})).map_err(|_|invalid())?;
    meta.validate().map_err(failure)?;
    let file = expressions::attachment_source(&state.pool, actor, r.channel_id, r.attachment_id)
        .await
        .map_err(failure)?;
    let content = state
        .drive
        .file_content(&file, expressions::INPUT_BYTES as i64)
        .await
        .map_err(|_| failure(Error::NotFound))?;
    let mut stream = content.body;
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(10), async move {
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
    // Recheck the attachment after I/O as well as before it; no tx spans Drive.
    expressions::attachment_source(&state.pool, actor, r.channel_id, r.attachment_id)
        .await
        .map_err(failure)?;
    prepare(&state, actor, meta, Origin::attachment(), bytes).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    name: String,
    display_name: String,
    tags: Vec<String>,
    subject_member_id: Value,
    url: String,
}

/// ADR-0218 appendix A `POST /expressions/import`. The server fetches a public HTTPS
/// image link a member typed in through the guarded transport (momo-unfurl) and
/// stages it exactly like an upload; everything the fetch cannot do ends as a manual
/// card (`200`, `manual_upload_required`) that keeps the safe source link and the
/// upload control, never as an error.
///
/// Nothing in here may put the link's query, the transport's error text or a body
/// in a log: every failure maps to a closed code or a coded 4xx, and no
/// `ApiError::internal` is reachable from the fetch.
pub async fn import(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(ws): Path<String>,
    request: Request,
) -> Result<Response, ApiError> {
    human(&p)?;
    let actor = actor(&ws, &p)?;
    // Role, add policy and the live-draft quota are proved before the server makes a
    // request for this person; `create_draft` proves them again afterwards.
    expressions::preflight_import(&state.pool, actor)
        .await
        .map_err(failure)?;
    let r: ImportRequest = json(request).await?;
    let meta: Metadata = serde_json::from_value(json!({
        "name": r.name, "displayName": r.display_name,
        "tags": r.tags, "subjectMemberId": r.subject_member_id
    }))
    .map_err(|_| invalid())?;
    meta.validate().map_err(failure)?;
    // D6: a face means its owner registers it. Re-proved in `create_draft`; stopping
    // here only saves a fetch that could never end in a draft.
    if meta.subject_member_id.is_some_and(|s| s != actor.member) {
        return Err(failure(Error::Role));
    }
    // A link that is malformed, carries credentials/fragment, or is private from the
    // start (any spelling of loopback, link-local, metadata, RFC 1918) is a 400:
    // nothing is resolved, connected to or stored.
    let source = parse_source_url(&r.url).map_err(|_| invalid())?;
    // The instance's outgoing-request switch (`MOMO_UNFURL_ENABLED`, default off, ADR-0170 D3):
    // off means this server makes no request on anyone's behalf. The link is kept as a manual
    // card with the safe source and the upload control, and the person finishes it by hand.
    let (media, code) = if !state.unfurl_enabled {
        (None, Some("source_unavailable"))
    } else {
        let permit = intake::import_slots()
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy(2))?;
        let outcome = match fetch_source(&*state.unfurl_http, &source, SOURCE_DEADLINE).await {
            // A busy decoder is the server's retryable state, not the picture's: a 503 with
            // `Retry-After` and no draft, never a `source_timeout` card.
            Ok(bytes) => match intake::picture_or_reason(bytes, None).await {
                Ok(intake::Picture::Ready(processed)) => (Some(*processed), None),
                Ok(intake::Picture::Manual(reason)) => (None, Some(reason)),
                Err(intake::DecoderBusy) => return Err(ApiError::busy(2)),
            },
            // The first hop is the address the caller named: private from the start is a
            // 400 with nothing stored, like a literal. (A refusal after a redirect is a card.)
            Err(refused) if refused.is_private_origin() => return Err(invalid()),
            Err(refused) => (None, Some(refused.code())),
        };
        drop(permit);
        outcome
    };
    let status = if media.is_some() {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let draft = expressions::create_draft(
        &state.pool,
        actor,
        meta,
        Origin::url(source.origin()),
        media,
        code,
    )
    .await
    .map_err(failure)?;
    Ok((status, Json(draft)).into_response())
}
