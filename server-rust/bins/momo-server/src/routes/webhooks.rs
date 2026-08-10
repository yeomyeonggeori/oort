//! 인바운드 웹훅 설치 — the four management operations (#1222 / T13, ADR-0115).
//!
//! ```text
//! GET    /v1/workspaces/{ws}/webhooks                  list
//! POST   /v1/workspaces/{ws}/webhooks                  create   201 + one-time credential
//! POST   /v1/workspaces/{ws}/webhooks/{id}/rotate      rotate   200 + one-time credential
//! DELETE /v1/workspaces/{ws}/webhooks/{id}             revoke   200
//! ```
//!
//! Ports Swift `Routes/WebhookRoutes.swift:43-445`. The client contract is
//! already written and already deployed — `packages/momo-core/src/features/webhooks/api.ts`
//! (four calls) and `clients/web/src/features/settings/WebhookSection.tsx` — so
//! nothing here invents wire.
//!
//! ## What is NOT here
//!
//! The **public ingress** half (`POST /v1/webhooks/{ws}/{id}`,
//! `POST /hooks/{token}`) is out of #1222's stated scope (관리 REST 8연산 +
//! 송신 소비자) and is carried as an explicit deviation in the PR body. The
//! consequence is honest and bounded: an admin can install, rotate and revoke a
//! webhook, and the credential they are shown will not be accepted by this
//! server until the ingress routes land. `momo-webhook` already holds the
//! signing primitives that half needs.
//!
//! ## The secret discipline, restated where it is enforced
//!
//! Exactly two of these four responses can carry a credential. Both are answered
//! with `Cache-Control: no-store` + `Pragma: no-cache` by [`no_store`], because
//! the server refuses to persist the value and asking the browser's cache to
//! hold it would undo that. Nothing in this module logs a request, a body or a
//! failure — a `tracing::warn!(?body)` on a create error is enough to put a
//! one-time secret into a log aggregator that outlives the panel.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_webhook::{
    active_channel_exists, create_installation, list_installations, load_installation_for_update,
    normalized_label, receive_url, revoke_installation, rotate_installation_secret,
    validated_overlap_seconds, InstallationRow, NewInstallation, WebhookMode,
};
use uuid::Uuid;

use crate::dto::{
    CreateWebhookRequest, RotateWebhookRequest, WebhookInstallationDto,
    WebhookInstallationListResponse, WebhookRevokeResponse, WebhookSecretResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

const SIGNATURE_VERSION: &str = "v1";
const ALGORITHM: &str = "HMAC-SHA256";

fn installation_dto(row: InstallationRow) -> WebhookInstallationDto {
    WebhookInstallationDto {
        id: row.id.to_string(),
        channel_id: row.channel_id.to_string(),
        author_member_id: row.author_member_id.to_string(),
        mode: row.mode,
        label: row.label,
        status: row.status,
        created_at_ms: epoch_ms(row.created_at),
        updated_at_ms: epoch_ms(row.updated_at),
    }
}

/// The workspace owner/admin gate every operation in this file takes, run inside
/// the caller's transaction so a role change cannot land between the check and
/// the write.
async fn authorize(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(role) if role.is_admin() => Ok(()),
        _ => Err(ApiError::forbidden("human workspace admin required")),
    })
}

/// The two headers a one-time credential response must carry. The server keeps
/// no copy of the value; a cached response would be the copy it refused to keep.
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WebhookInstallationListResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<InstallationRow>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                Ok(Ok(list_installations(conn, workspace_id).await?))
            })
        })
        .await;

    let rows = settle_db("webhooks.list", outcome)?;
    Ok(Json(WebhookInstallationListResponse {
        installations: rows.into_iter().map(installation_dto).collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateWebhookRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    // Shape first, outside the transaction: a malformed channel id, an unknown
    // mode or an over-long label is a 400 and never reaches a lock.
    let channel_id = path_uuid(&request.channel_id, "invalid channelId")?;
    let mode = WebhookMode::parse(&request.mode)
        .ok_or_else(|| ApiError::bad_request("mode must be native or slack_compatible"))?;
    let label = normalized_label(request.label.as_deref())
        .ok_or_else(|| ApiError::bad_request("label must contain 1...80 printable characters"))?;

    // The credential is minted here, before the transaction, so the row and the
    // response are provably built from ONE value: a second `random_reference()`
    // inside the closure would be a second secret, and the one the caller was
    // shown would be the one that does not work.
    let (secret_ref, slack_token) = match mode {
        WebhookMode::Native => (Some(momo_webhook::random_reference()), None),
        WebhookMode::SlackCompatible => (None, Some(momo_webhook::slack_token(workspace_id))),
    };
    let token_hash = slack_token.as_deref().map(momo_webhook::token_hash);

    let created = {
        let secret_ref = secret_ref.clone();
        let token_hash = token_hash.clone();
        let label = label.clone();
        let outcome: DbRejectable<momo_webhook::CreatedInstallation> =
            agent_tenant_tx(&state.pool, workspace_id, move |conn| {
                Box::pin(async move {
                    if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                        return Ok(Err(rejection));
                    }
                    if !active_channel_exists(conn, workspace_id, channel_id).await? {
                        return Ok(Err(ApiError::not_found("active channel not found")));
                    }
                    let created = create_installation(
                        conn,
                        workspace_id,
                        NewInstallation {
                            channel_id,
                            mode,
                            label: &label,
                            secret_ref: secret_ref.as_deref(),
                            token_hash: token_hash.as_deref(),
                            actor_member_id: member_id,
                            via_token_id: via_token,
                        },
                    )
                    .await?;
                    Ok(Ok(created))
                })
            })
            .await;
        settle_db("webhooks.create", outcome)?
    };

    let body = secret_response(
        &state.jwt_secret,
        workspace_id,
        installation_dto(created.installation),
        created.key_id,
        mode,
        secret_ref.as_deref(),
        slack_token.as_deref(),
        None,
    );
    Ok(no_store((StatusCode::CREATED, Json(body)).into_response()))
}

pub async fn rotate(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, installation)): Path<(String, String)>,
    Json(request): Json<RotateWebhookRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let installation_id = path_uuid(&installation, "invalid installation id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let overlap_seconds = validated_overlap_seconds(request.overlap_seconds).ok_or_else(|| {
        ApiError::bad_request(format!(
            "overlapSeconds must be between 0 and {}",
            momo_webhook::MAX_ROTATION_OVERLAP_SECONDS
        ))
    })?;

    // Both credential shapes are minted up front for the same reason as create;
    // only the one matching the installation's mode is used or revealed.
    let new_secret_ref = momo_webhook::random_reference();
    let new_slack_token = momo_webhook::slack_token(workspace_id);

    let outcome: DbRejectable<(InstallationRow, Uuid, WebhookMode)> = {
        let new_secret_ref = new_secret_ref.clone();
        let new_slack_token = new_slack_token.clone();
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(row) =
                    load_installation_for_update(conn, workspace_id, installation_id).await?
                else {
                    return Ok(Err(ApiError::not_found("webhook installation not found")));
                };
                let Some(mode) = WebhookMode::parse(&row.mode).filter(|_| row.is_active()) else {
                    // A revoked installation is a 409, not a 404: it exists, and
                    // saying so is what tells the panel to stop offering rotate.
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "webhook installation is revoked",
                    )));
                };
                let (secret_ref, token_hash) = match mode {
                    WebhookMode::Native => (Some(new_secret_ref.as_str()), None),
                    WebhookMode::SlackCompatible => {
                        (None, Some(momo_webhook::token_hash(&new_slack_token)))
                    }
                };
                let key_id = rotate_installation_secret(
                    conn,
                    workspace_id,
                    installation_id,
                    mode,
                    secret_ref,
                    token_hash.as_deref(),
                    overlap_seconds,
                    member_id,
                    via_token,
                )
                .await?;
                Ok(Ok((row, key_id, mode)))
            })
        })
        .await
    };

    let (row, key_id, mode) = settle_db("webhooks.rotate", outcome)?;
    let body = secret_response(
        &state.jwt_secret,
        workspace_id,
        installation_dto(row),
        key_id,
        mode,
        matches!(mode, WebhookMode::Native).then_some(new_secret_ref.as_str()),
        matches!(mode, WebhookMode::SlackCompatible).then_some(new_slack_token.as_str()),
        Some(overlap_seconds),
    );
    Ok(no_store(Json(body).into_response()))
}

pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, installation)): Path<(String, String)>,
) -> Result<Json<WebhookRevokeResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let installation_id = path_uuid(&installation, "invalid installation id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<InstallationRow> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(row) =
                    load_installation_for_update(conn, workspace_id, installation_id).await?
                else {
                    return Ok(Err(ApiError::not_found("webhook installation not found")));
                };
                // Already revoked: answer the existing state rather than write a
                // second audit line for an action nobody performed. Swift does
                // the same, and it is what makes DELETE safely repeatable.
                if !row.is_active() {
                    return Ok(Ok(row));
                }
                Ok(Ok(revoke_installation(
                    conn,
                    workspace_id,
                    &row,
                    member_id,
                    via_token,
                )
                .await?))
            })
        })
        .await;

    let row = settle_db("webhooks.revoke", outcome)?;
    Ok(Json(WebhookRevokeResponse {
        installation: installation_dto(row),
        revoked: true,
    }))
}

/// Build the one-time reveal for whichever dialect this installation speaks.
///
/// Native mode derives the secret from `JWT_HMAC` + the stored reference — the
/// same pair Swift's `WebhookRoutes` uses (`App.swift:265`), so a credential
/// issued by either server verifies on the other. Slack-compatible mode has no
/// separate secret: the credential IS the URL, which is why `secret` is omitted
/// and `signatureVersion`/`algorithm` are too.
#[allow(clippy::too_many_arguments)]
fn secret_response(
    jwt_secret: &str,
    workspace_id: Uuid,
    installation: WebhookInstallationDto,
    key_id: Uuid,
    mode: WebhookMode,
    secret_ref: Option<&str>,
    slack_token: Option<&str>,
    overlap_seconds: Option<i64>,
) -> WebhookSecretResponse {
    let installation_id = installation
        .id
        .parse::<Uuid>()
        .unwrap_or(Uuid::from_u128(0));
    match mode {
        WebhookMode::Native => WebhookSecretResponse {
            installation,
            key_id: key_id.to_string(),
            secret: secret_ref.map(|reference| momo_webhook::native_secret(jwt_secret, reference)),
            url: receive_url(workspace_id, installation_id, None),
            signature_version: Some(SIGNATURE_VERSION.to_string()),
            algorithm: Some(ALGORITHM.to_string()),
            overlap_seconds,
        },
        WebhookMode::SlackCompatible => WebhookSecretResponse {
            installation,
            key_id: key_id.to_string(),
            secret: None,
            url: receive_url(workspace_id, installation_id, slack_token),
            signature_version: None,
            algorithm: None,
            overlap_seconds,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The inbound derivation's master key is the app JWT secret (Swift
    /// `App.swift:265`), so the projection test needs that string and nothing
    /// else — no state, no pool, no runtime.
    const JWT_SECRET: &str = "test-master-key";

    fn dto() -> WebhookInstallationDto {
        WebhookInstallationDto {
            id: Uuid::from_u128(2).to_string(),
            channel_id: Uuid::from_u128(3).to_string(),
            author_member_id: Uuid::from_u128(4).to_string(),
            mode: "native".into(),
            label: "CI".into(),
            status: "active".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    /// The list row is the shape a panel renders many of, and the one most
    /// likely to be spread into a log line. It must have no field a credential
    /// could occupy.
    #[test]
    fn a_list_row_has_nowhere_to_put_a_secret() {
        let json: Value = serde_json::to_value(WebhookInstallationListResponse {
            installations: vec![dto()],
        })
        .expect("serialize");
        let row = &json["installations"][0];
        for forbidden in ["secret", "url", "keyId", "secretRef", "tokenHash"] {
            assert!(
                row.get(forbidden).is_none(),
                "the list contract promises no credential material, found {forbidden}: {json}"
            );
        }
        assert_eq!(row["authorMemberId"], Uuid::from_u128(4).to_string());
        assert_eq!(row["createdAtMs"], 1);
    }

    /// Native reveals a secret and a signature contract; Slack-compatible
    /// reveals neither, because the credential is inside the URL. An emitted
    /// `"secret": null` would be a contract change, so the field is *absent*.
    #[test]
    fn the_two_dialects_reveal_different_things() {
        let native = serde_json::to_value(secret_response(
            JWT_SECRET,
            Uuid::from_u128(1),
            dto(),
            Uuid::from_u128(9),
            WebhookMode::Native,
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            None,
            None,
        ))
        .expect("serialize");
        assert_eq!(
            native["secret"],
            "momo_whsec_v1.ZkAKc81cBF2YwDtDQs9byd5Ohj_zUPOMIyEiKA_iyP0",
            "the inbound secret is derived from JWT_HMAC — a Swift-issued credential must still verify"
        );
        assert_eq!(native["signatureVersion"], "v1");
        assert_eq!(native["algorithm"], "HMAC-SHA256");
        assert_eq!(
            native["url"],
            "/v1/webhooks/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"
        );
        assert!(native.get("overlapSeconds").is_none());

        let mut slack_dto = dto();
        slack_dto.mode = "slack_compatible".into();
        let slack = serde_json::to_value(secret_response(
            JWT_SECRET,
            Uuid::from_u128(1),
            slack_dto,
            Uuid::from_u128(9),
            WebhookMode::SlackCompatible,
            None,
            Some("momo_hook_v1.ws.ref"),
            Some(86_400),
        ))
        .expect("serialize");
        assert!(
            slack.get("secret").is_none(),
            "an emitted null is a contract change; the field must be absent: {slack}"
        );
        assert!(slack.get("signatureVersion").is_none());
        assert_eq!(slack["url"], "/hooks/momo_hook_v1.ws.ref");
        assert_eq!(slack["overlapSeconds"], 86_400);
    }

    /// Every reveal must be uncacheable. A browser cache holding the one value
    /// the server refuses to hold is the whole failure this header prevents.
    #[test]
    fn a_reveal_is_never_cacheable() {
        let response = no_store((StatusCode::CREATED, "x").into_response());
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(response.headers().get(header::PRAGMA).unwrap(), "no-cache");
    }
}
