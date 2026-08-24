//! Link unfurl REST (ADR-0170 / #1698 server half).
//!
//! ```text
//! GET|PUT  /v1/workspaces/{ws}/unfurl-settings          owner/admin
//! GET      /v1/workspaces/{ws}/messages/{id}/unfurls    channel member
//! DELETE   /v1/workspaces/{ws}/messages/{id}/unfurls    author
//! GET      /v1/workspaces/{ws}/unfurls/{id}/image       channel member (proxy)
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
    fetch_record_image, list_unfurls_in_tx, load_setting_in_tx, load_unfurl_in_tx,
    remove_unfurls_in_tx, upsert_setting_in_tx, RemoveOutcome, UnfurlRecord, UnfurlSetting,
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
            .map(|_| format!("/v1/workspaces/{workspace_id}/unfurls/{}/image", record.id)),
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
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, unfurl)): Path<(String, String)>,
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
    let image = match fetch_record_image(
        &record,
        state.unfurl_http.as_ref(),
        state.unfurl_cache.as_ref(),
    )
    .await
    {
        Ok(image) => image,
        Err(momo_unfurl::ProxyError::NotFound | momo_unfurl::ProxyError::Unavailable) => {
            return Err(ApiError::not_found("unfurl image not found"));
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, image.content_type)
        .header(header::CONTENT_LENGTH, image.bytes.len().to_string())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(image.bytes))
        .map_err(|error| ApiError::internal("unfurl.image.response", error))
}
