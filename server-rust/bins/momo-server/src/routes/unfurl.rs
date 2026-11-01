//! Link unfurl REST (ADR-0170 / #1698 server half).
//!
//! ```text
//! GET|PUT  /v1/workspaces/{ws}/unfurl-settings          owner/admin
//! GET      /v1/workspaces/{ws}/messages/{id}/unfurls    channel member
//! DELETE   /v1/workspaces/{ws}/messages/{id}/unfurls    author
//! GET      /v1/workspaces/{ws}/unfurls/{id}/image       channel member (proxy)
//! GET      /v1/workspaces/{ws}/unfurls/{id}/icon        channel member (proxy, 443 only)
//! POST     /v1/workspaces/{ws}/channels/{ch}/unfurl-previews        channel member (#4884)
//! GET      /v1/workspaces/{ws}/unfurl-previews/{id}/image           the member it was made for
//! GET      /v1/workspaces/{ws}/unfurl-previews/{id}/icon            the member it was made for
//! ```
//!
//! The two proxy routes can make this server GET a site the card names. A request the cache can
//! answer, or whose address failed lately, costs the site nothing and is free. One that would
//! fetch spends the member's fetch budget (`MemberWrite::UnfurlProxy`) and a place among the
//! fetches in flight; either is refused with 429 + `Retry-After` (#4881 security review M-2).
//!
//! The preview routes (ADR-0170 증보 2026-11-01, #4884) answer for a link a member is still typing:
//! the page comes from the same transport (`FetchKind::Preview`: the guard plus port 443), the
//! answer lives in this process only (`momo_unfurl::PreviewCache`), and the picture and icon are
//! served by the very same code as a stored card's ([`serve_remote_image`]).
//!
//! No SQL here. No reqwest here. Personal render-fold is the client half.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::is_channel_member;
use momo_unfurl::{
    fetch_preview, fetch_record_icon, fetch_record_image, icon_path, image_path,
    list_unfurls_in_tx, load_setting_in_tx, load_unfurl_in_tx, normalize_url, preview_icon_path,
    preview_image_path, proxy_goes_outbound, record_measured_size, remove_unfurls_in_tx,
    upsert_setting_in_tx, PreviewEntry, PreviewKey, PreviewOutcome, Previewed, ProxyError,
    ProxySlot, RemoveOutcome, UnfurlRecord, UnfurlSetting,
};
use uuid::Uuid;

use crate::dto::{
    MessageUnfurlDto, MessageUnfurlListResponse, PutUnfurlSettingsRequest, RemoveUnfurlsResponse,
    UnfurlPreviewDto, UnfurlPreviewRequest, UnfurlSettingsResponse,
};
use crate::error::ApiError;
use crate::rate_limit::{
    refund_member_write, spend_member_write_unit, too_many_requests, MemberWrite,
};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, require_workspace_operator,
    settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

fn settings_response(setting: UnfurlSetting) -> UnfurlSettingsResponse {
    UnfurlSettingsResponse {
        enabled: setting.enabled,
        updated_at_ms: setting.updated_at.map(|at| at.timestamp_millis()),
    }
}

fn card_dto(workspace_id: Uuid, record: UnfurlRecord) -> MessageUnfurlDto {
    MessageUnfurlDto {
        id: record.id.to_string(),
        message_id: record.message_id.to_string(),
        url: record.source_url,
        status: record.status,
        title: record.title,
        description: record.description,
        domain: record.domain,
        image_url: record
            .image_proxy_key
            .map(|_| image_path(workspace_id, record.id)),
        site_name: record.site_name,
        // The remote icon address (`icon_source_url`) stays in the database. A client is only
        // ever given the proxy path.
        icon_url: record
            .icon_proxy_key
            .map(|_| icon_path(workspace_id, record.id)),
        image_width: record.image_width,
        image_height: record.image_height,
        is_video: record.is_video,
    }
}

/// `GET /v1/workspaces/{ws}/unfurl-settings`
pub async fn get_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<UnfurlSettingsResponse>, ApiError> {
    require_human(&principal, "unfurl settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let outcome: DbRejectable<UnfurlSetting> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { Ok(Ok(load_setting_in_tx(conn, workspace_id).await?)) })
        })
        .await;
    let setting = settle_db("unfurl.settings.get", outcome)?;
    Ok(Json(settings_response(setting)))
}

/// `PUT /v1/workspaces/{ws}/unfurl-settings`
pub async fn put_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PutUnfurlSettingsRequest>,
) -> Result<Json<UnfurlSettingsResponse>, ApiError> {
    require_human(&principal, "unfurl settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let member_id = principal.member_id;
    let via = audit_via_token_id(&principal);
    let enabled = request.enabled;
    let outcome: DbRejectable<UnfurlSetting> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let setting = upsert_setting_in_tx(conn, workspace_id, enabled, member_id).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "unfurl_setting.updated")
                        .by(member_id)
                        .via_token(via)
                        .with_schema(
                            "momo.unfurl_setting.updated.v1",
                            serde_json::json!({ "enabled": enabled }),
                        ),
                )
                .await?;
                Ok(Ok(setting))
            })
        })
        .await;
    let setting = settle_db("unfurl.settings.put", outcome)?;
    Ok(Json(settings_response(setting)))
}

/// `GET /v1/workspaces/{ws}/messages/{id}/unfurls`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
) -> Result<Json<MessageUnfurlListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let message_id = path_uuid(&message, "invalid message id")?;
    let member_id = principal.member_id;
    let outcome: DbRejectable<Vec<UnfurlRecord>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some((channel_id, _)) =
                    momo_unfurl::remove::message_channel(conn, message_id).await?
                else {
                    return Ok(Err(ApiError::not_found("message not found")));
                };
                if !is_channel_member(conn, channel_id, member_id).await? {
                    return Ok(Err(ApiError::forbidden("not a channel member")));
                }
                Ok(Ok(list_unfurls_in_tx(conn, message_id).await?))
            })
        })
        .await;
    let records = settle_db("unfurl.list", outcome)?;
    Ok(Json(MessageUnfurlListResponse {
        unfurls: records
            .into_iter()
            .map(|record| card_dto(workspace_id, record))
            .collect(),
    }))
}

/// `DELETE /v1/workspaces/{ws}/messages/{id}/unfurls`
pub async fn remove(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
) -> Result<Json<RemoveUnfurlsResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let message_id = path_uuid(&message, "invalid message id")?;
    let member_id = principal.member_id;
    let outcome: DbRejectable<RemoveOutcome> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match remove_unfurls_in_tx(conn, workspace_id, message_id, member_id).await? {
                    Ok(outcome) => Ok(Ok(outcome)),
                    Err(momo_unfurl::remove::RemoveRefused::NotFound) => {
                        Ok(Err(ApiError::not_found("message not found")))
                    }
                    Err(momo_unfurl::remove::RemoveRefused::NotAuthor) => Ok(Err(
                        ApiError::forbidden("only the author may remove unfurls"),
                    )),
                }
            })
        })
        .await;
    let outcome = settle_db("unfurl.remove", outcome)?;
    Ok(Json(RemoveUnfurlsResponse {
        removed: outcome.changed,
    }))
}

/// `GET /v1/workspaces/{ws}/unfurls/{id}/image`
pub async fn image(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Response, ApiError> {
    proxy_remote_image(state, principal, path, ProxySlot::Image).await
}

/// `GET /v1/workspaces/{ws}/unfurls/{id}/icon` (ADR-0170 amendment D9)
pub async fn icon(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Response, ApiError> {
    proxy_remote_image(state, principal, path, ProxySlot::Icon).await
}

/// One authorization and one proxy for both of a card's remote images. The remote address is
/// read from the row inside [`fetch_record_image`] / [`fetch_record_icon`] and goes no further.
async fn proxy_remote_image(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, unfurl)): Path<(String, String)>,
    slot: ProxySlot,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let unfurl_id = path_uuid(&unfurl, "invalid unfurl id")?;
    let member_id = principal.member_id;
    let outcome: DbRejectable<UnfurlRecord> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(record) = load_unfurl_in_tx(conn, unfurl_id).await? else {
                    return Ok(Err(ApiError::not_found("unfurl not found")));
                };
                if !is_channel_member(conn, record.channel_id, member_id).await? {
                    return Ok(Err(ApiError::forbidden("not a channel member")));
                }
                Ok(Ok(record))
            })
        })
        .await;
    let record = settle_db("unfurl.image.authorize", outcome)?;
    serve_remote_image(&state, &principal, workspace_id, &record, slot, true).await
}

/// The bytes of one of a card's two remote images, for a member who is already authorized, from
/// the card row (or, for a preview, from [`PreviewEntry::as_record`]). Everything that makes this
/// server go to a remote site is here and is the same for both: the member's fetch budget, a
/// place among the fetches in flight, the guard, the type allow-list and the cache.
///
/// `remember_size` is whether the size the proxy measures from a picture may be written back
/// (D12): a stored card has a row for it, a preview has none.
async fn serve_remote_image(
    state: &AppState,
    principal: &Principal,
    workspace_id: Uuid,
    record: &UnfurlRecord,
    slot: ProxySlot,
    remember_size: bool,
) -> Result<Response, ApiError> {
    let member_id = principal.member_id;
    // Only a request that would make this server fetch from the remote site spends the member's
    // budget: a picture already in memory and an address that failed lately are free, so a
    // timeline of cached cards never meets the limit. A route layer cannot tell the two apart,
    // which is why this is asked here, after authorization and before the fetch.
    let spent = if proxy_goes_outbound(record, state.unfurl_cache.as_ref(), slot) {
        match spend_member_write_unit(state, MemberWrite::UnfurlProxy, principal).await {
            Ok(unit) => unit,
            Err(retry_after_seconds) => return Ok(too_many_requests(retry_after_seconds)),
        }
    } else {
        None
    };
    let fetched = match slot {
        ProxySlot::Image => {
            fetch_record_image(
                record,
                state.unfurl_http.as_ref(),
                state.unfurl_cache.as_ref(),
                member_id,
            )
            .await
        }
        ProxySlot::Icon => {
            fetch_record_icon(
                record,
                state.unfurl_http.as_ref(),
                state.unfurl_cache.as_ref(),
                member_id,
            )
            .await
        }
    };
    let image = match fetched {
        Ok(image) => image,
        Err(ProxyError::NotFound | ProxyError::Unavailable) => {
            return Err(ApiError::not_found("unfurl image not found"));
        }
        // This server had no place for the fetch (the process's, the member's own, or a name
        // lookup's). Nothing is wrong with this card, and nothing left the building, so the unit
        // of budget this request spent is given back; ask again in a second.
        Err(ProxyError::Busy) => {
            if let Some(unit) = spent {
                refund_member_write(state, unit);
            }
            return Ok(too_many_requests(1));
        }
    };

    // ADR-0170 amendment D12: a picture whose size the page did not declare gets the size read
    // from the bytes just received, once. Best effort: the picture is served either way.
    if remember_size && slot == ProxySlot::Image && record.image_width.is_none() {
        if let Some((width, height)) = image.size {
            remember_measured_size(state, workspace_id, record, width, height).await;
        }
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, image.content_type)
        .header(header::CONTENT_LENGTH, image.bytes.len().to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(image.bytes))
        .map_err(|error| ApiError::internal("unfurl.image.response", error))
}

/// Write the measured size back through a short tenant transaction. A failure is logged and
/// ignored; it never changes what the client receives.
async fn remember_measured_size(
    state: &AppState,
    workspace_id: Uuid,
    record: &UnfurlRecord,
    width: u32,
    height: u32,
) {
    let (Ok(width), Ok(height)) = (i32::try_from(width), i32::try_from(height)) else {
        return;
    };
    let record = record.clone();
    let outcome: Result<bool, momo_db::DbError> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { record_measured_size(conn, &record, width, height).await })
        })
        .await;
    if let Err(error) = outcome {
        tracing::warn!(error = %error, "unfurl measured size was not recorded");
    }
}

// ---------------------------------------------------------------------------
// ADR-0170 증보 2026-11-01 (#4884) — the card of a link that is still in the composer.
// ---------------------------------------------------------------------------

/// The longest address a preview request may carry: the column bound a stored card's address has
/// (`message_unfurl_source_ck`), checked on the raw body value so a megabyte of fragment is a 400
/// before anything reads it.
const PREVIEW_URL_MAX_BYTES: usize = 2048;

/// `failed` is the whole answer for every way of having no preview (D15): the keys of an `ok` card
/// are all absent and so is `id`.
fn failed_preview(url: String) -> UnfurlPreviewDto {
    UnfurlPreviewDto {
        url,
        status: "failed",
        id: None,
        title: None,
        description: None,
        domain: None,
        image_url: None,
        site_name: None,
        icon_url: None,
        image_width: None,
        image_height: None,
        is_video: false,
    }
}

/// An `ok` preview. As for a stored card, the remote picture and icon addresses stop at the
/// database row's twin (the cache entry): a client is only ever given the two preview paths.
fn ok_preview(workspace_id: Uuid, entry: &PreviewEntry) -> UnfurlPreviewDto {
    let card = &entry.card;
    UnfurlPreviewDto {
        url: entry.url.clone(),
        status: "ok",
        id: Some(entry.id.to_string()),
        title: card.title.clone(),
        description: card.description.clone(),
        domain: card.domain.clone(),
        image_url: card
            .image_url
            .as_ref()
            .map(|_| preview_image_path(workspace_id, entry.id)),
        site_name: card.site_name.clone(),
        icon_url: card
            .icon_url
            .as_ref()
            .map(|_| preview_icon_path(workspace_id, entry.id)),
        image_width: card.image_width,
        image_height: card.image_height,
        is_video: card.is_video,
    }
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/unfurl-previews`
///
/// In the order that keeps every refusal ahead of the work it would have caused:
///
/// 1. the caller is a person, the address is an http(s) address of a sane size — shape only, the
///    same answer for everyone, before a connection is taken. A caller that is not a person does
///    not get this far: an agent bearer or a developer token is a 403 and a work host's
///    signature a 401, all three at the door (none has this route on its table);
///    [`require_human`] is this handler's own second layer;
/// 2. one short tenant transaction: an **active workspace member** — a `workspace_membership`
///    row, `member.status = 'active'` and `member.deleted_at` unset, whatever the role
///    (`momo_auth::active_workspace_role`) — who is a **current member of that channel** (the
///    guest rule is the send's), and the workspace's switch (D4);
/// 3. both switches (the instance's and the workspace's) have to be on, or nothing is fetched and
///    the answer is `failed`;
/// 4. an answer this server already holds for this member and address is returned, for free;
/// 5. otherwise one unit of the member's preview budget, then a place among the fetches in flight
///    and the trip itself ([`fetch_preview`]), outside any transaction. A place that is not there
///    gives the unit back; a trip that ends in `failed` does not (the site was asked, and the next
///    ask for that address is answered from memory, free).
///
/// No part of a preview is written to the database (the address, the card and the id live in this
/// process only), and nothing here logs the address, a query or a body. The one row this route can
/// cause is the budget's own audit row for a first refusal (`rate_limit.exceeded`, D20).
pub async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<UnfurlPreviewRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "link previews require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = principal.member_id;
    if request.url.len() > PREVIEW_URL_MAX_BYTES {
        return Err(ApiError::bad_request("url is too long"));
    }
    // The same normalization the worker's cards go through, so a preview and the card it becomes
    // are about the same address. No DNS and no connection: it only reads the shape (http or
    // https, a host, no credentials).
    let url_key = normalize_url(&request.url)
        .map_err(|_| ApiError::bad_request("url must be an absolute http(s) address"))?;

    let outcome: DbRejectable<bool> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let active = momo_auth::active_workspace_role(conn, workspace_id, member_id)
                .await?
                .is_some();
            // One refusal for "not an active member of the workspace", "not in the channel" and
            // "no such channel": the answer does not say which channels exist.
            if !active || !is_channel_member(conn, channel_id, member_id).await? {
                return Ok(Err(ApiError::forbidden("not a channel member")));
            }
            Ok(Ok(load_setting_in_tx(conn, workspace_id).await?.enabled))
        })
    })
    .await;
    let workspace_enabled = settle_db("unfurl.preview.authorize", outcome)?;

    // Off means off (D4, D16): nothing is fetched, nothing is spent, nothing is kept.
    if !state.unfurl_enabled || !workspace_enabled {
        return Ok(Json(failed_preview(url_key)).into_response());
    }

    let key = PreviewKey::new(workspace_id, member_id, url_key.clone());
    match state.unfurl_previews.get(&key) {
        Some(PreviewOutcome::Entry(entry)) => {
            return Ok(Json(ok_preview(workspace_id, &entry)).into_response());
        }
        Some(PreviewOutcome::Failed) => {
            return Ok(Json(failed_preview(url_key)).into_response());
        }
        None => {}
    }

    let spent = match spend_member_write_unit(&state, MemberWrite::UnfurlPreview, &principal).await
    {
        Ok(unit) => unit,
        Err(retry_after_seconds) => return Ok(too_many_requests(retry_after_seconds)),
    };
    // `false`: this server's transport is `SafeUnfurlTransport::production(false)`, which never
    // takes plain http, so the card builder must not take an http picture address either.
    let previewed = fetch_preview(
        state.unfurl_http.as_ref(),
        state.unfurl_cache.as_ref(),
        state.unfurl_previews.as_ref(),
        key,
        false,
    )
    .await;
    match previewed {
        Previewed::Entry(entry) => Ok(Json(ok_preview(workspace_id, &entry)).into_response()),
        // The site was asked, so the unit stays spent: only a missing place gives it back
        // (`a_failed_preview_spends_the_budget_like_a_good_one`).
        Previewed::Failed => Ok(Json(failed_preview(url_key)).into_response()),
        // No place for the fetch (the member's share, the process's, or a name lookup's). Nothing
        // left the building, so the unit this request spent is given back.
        Previewed::Busy => {
            if let Some(unit) = spent {
                refund_member_write(&state, unit);
            }
            Ok(too_many_requests(1))
        }
    }
}

/// `GET /v1/workspaces/{ws}/unfurl-previews/{id}/image`
pub async fn preview_image(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Response, ApiError> {
    serve_preview_image(state, principal, path, ProxySlot::Image).await
}

/// `GET /v1/workspaces/{ws}/unfurl-previews/{id}/icon`
pub async fn preview_icon(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Response, ApiError> {
    serve_preview_image(state, principal, path, ProxySlot::Icon).await
}

/// A preview's picture or icon, for the member the preview was made for and nobody else: an id
/// that is unknown, run out, another member's or another workspace's is the same 404 (a `{ws}`
/// that is not the caller's workspace is the usual 403 first). From there it is the stored card's
/// proxy, unchanged ([`serve_remote_image`]).
///
/// Nothing here asks the database whether the member is still active: suspension, removal and
/// leaving the workspace each revoke every token the member holds (`revoke_member_tokens_in_tx`),
/// so such a member is a 401 at the door and never gets this far. What this route itself checks is
/// the entry — its workspace, its owner and its age.
async fn serve_preview_image(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, preview)): Path<(String, String)>,
    slot: ProxySlot,
) -> Result<Response, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let preview_id = path_uuid(&preview, "invalid preview id")?;
    let Some(entry) = state
        .unfurl_previews
        .entry(workspace_id, principal.member_id, preview_id)
    else {
        return Err(ApiError::not_found("unfurl preview not found"));
    };
    serve_remote_image(
        &state,
        &principal,
        workspace_id,
        &entry.as_record(),
        slot,
        false,
    )
    .await
}
