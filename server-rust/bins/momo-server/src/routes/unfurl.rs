//! Link unfurl REST (ADR-0170 / #1698 server half).
//!
//! ```text
//! GET|PUT  /v1/workspaces/{ws}/unfurl-settings          owner/admin
//! GET      /v1/workspaces/{ws}/messages/{id}/unfurls    channel member
//! DELETE   /v1/workspaces/{ws}/messages/{id}/unfurls    author
//! GET      /v1/workspaces/{ws}/unfurls/{id}/image       channel member (proxy)
//! GET      /v1/workspaces/{ws}/unfurls/{id}/icon        channel member (proxy, 443 only)
//! ```
//!
//! No SQL here. No reqwest here. Personal render-fold is the client half.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::is_channel_member;
use momo_unfurl::{
    fetch_record_icon, fetch_record_image, icon_path, image_path, list_unfurls_in_tx,
    load_setting_in_tx, load_unfurl_in_tx, record_measured_size, remove_unfurls_in_tx,
    upsert_setting_in_tx, ProxySlot, RemoveOutcome, UnfurlRecord, UnfurlSetting,
};
use uuid::Uuid;

use crate::dto::{
    MessageUnfurlDto, MessageUnfurlListResponse, PutUnfurlSettingsRequest, RemoveUnfurlsResponse,
    UnfurlSettingsResponse,
};
use crate::error::ApiError;
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
    let fetched = match slot {
        ProxySlot::Image => {
            fetch_record_image(
                &record,
                state.unfurl_http.as_ref(),
                state.unfurl_cache.as_ref(),
            )
            .await
        }
        ProxySlot::Icon => {
            fetch_record_icon(
                &record,
                state.unfurl_http.as_ref(),
                state.unfurl_cache.as_ref(),
            )
            .await
        }
    };
    let image = match fetched {
        Ok(image) => image,
        Err(momo_unfurl::ProxyError::NotFound | momo_unfurl::ProxyError::Unavailable) => {
            return Err(ApiError::not_found("unfurl image not found"));
        }
    };

    // ADR-0170 amendment D12: a picture whose size the page did not declare gets the size read
    // from the bytes just received, once. Best effort: the picture is served either way.
    if slot == ProxySlot::Image && record.image_width.is_none() {
        if let Some((width, height)) = image.size {
            remember_measured_size(&state, workspace_id, &record, width, height).await;
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
