//! Device-link QR tokens (ADR-0180 / #1959).
//!
//! ```text
//! POST /v1/auth/device-link              (human bearer, require_human)
//!   → 201 { id, token, expiresAt, sas?, deepLink }
//! POST /v1/auth/device-link/redeem       (public, per-IP rate limited)
//!   → 200 LoginResponse + pendingSas
//! GET  /v1/auth/device-link/{id}         (issuer session)
//!   → { status: pending|consumed|expired, device? }
//! POST /v1/auth/device-link/{id}/confirm-sas  (issuer session)
//!   → 200 { status: "confirmed" }
//! ```
//!
//! Redeem is public for the same construction reason `/v1/join` and `/v1/claim`
//! are: the phone holds a one-time voucher and no bearer. The tenant is resolved
//! by `momo_join_private.device_link_workspace_id`. The voucher itself is not a
//! credential — presenting it as `Authorization` is 401.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::{Extension, Json};
use momo_auth::{
    confirm_device_link_sas_in_tx, consume_device_link_in_tx, device_link_status_in_tx,
    issue_device_link_in_tx, mint_device_link_token, normalized_device_link_token,
    normalized_device_name, normalized_device_platform, resolve_device_link_workspace,
    DeviceLinkConfirm, DeviceLinkMutation, DeviceLinkSpecInvalid, DeviceLinkStatusKind, Principal,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};

use crate::dto::{
    DeviceLinkConfirmResponse, DeviceLinkDevice, DeviceLinkIssueResponse, DeviceLinkRedeemRequest,
    DeviceLinkRedeemResponse, DeviceLinkStatusResponse, MemberDto,
};
use crate::error::{db_error, ApiError};
use crate::realtime_advert::{derive_same_origin_http_base, requires_device_link_sas};
use crate::routes::auth_routes::base_scopes;
use crate::routes::shared::{path_uuid, require_human};
use crate::AppState;

const HUMAN_ONLY: &str = "device link requires a human bearer";

fn spec_error(error: DeviceLinkSpecInvalid) -> ApiError {
    ApiError::bad_request(error.to_string())
}

fn mutation_error(mutation: DeviceLinkMutation) -> ApiError {
    match mutation {
        DeviceLinkMutation::Applied(_) => {
            ApiError::internal("device_link.unexpected_applied", "applied mapped as error")
        }
        DeviceLinkMutation::NotFound
        | DeviceLinkMutation::Expired
        | DeviceLinkMutation::IssuerSessionRevoked => {
            ApiError::unauthorized("device link token is invalid")
        }
        DeviceLinkMutation::AlreadyUsed => ApiError::new(
            StatusCode::CONFLICT,
            "device link token has already been used",
        ),
    }
}

/// RFC 3986 percent-encoding of the API base. Unreserved set stays literal.
fn percent_encode_unreserved(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn request_host(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
}

fn request_public_origin(
    headers: &HeaderMap,
    connection_scheme: Option<&str>,
) -> Result<String, ApiError> {
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok());
    derive_same_origin_http_base(forwarded_proto, request_host(headers), connection_scheme)
        .map_err(|error| ApiError::internal("device_link.origin", error))
}

fn issuer_token_id(principal: &Principal) -> Result<uuid::Uuid, ApiError> {
    principal
        .token_id
        .ok_or_else(|| ApiError::unauthorized("unknown token"))
}

pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<DeviceLinkIssueResponse>), ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let issued_session_token_id = issuer_token_id(&principal)?;
    let origin = request_public_origin(&headers, uri.scheme_str())?;
    let require_sas =
        requires_device_link_sas(state.realtime_ws_url.as_ref(), request_host(&headers));
    let token = mint_device_link_token()
        .map_err(|error| ApiError::internal("device_link.entropy", error))?;
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;

    let issued = with_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        move |conn| {
            Box::pin(async move {
                issue_device_link_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    issued_session_token_id,
                    &token,
                    require_sas,
                )
                .await
                .map_err(DbError::from)
            })
        }
    })
    .await
    .map_err(|error| db_error("device_link.issue", error))?;

    let deep_link = format!(
        "oort://link?server={}&token={}",
        percent_encode_unreserved(&origin),
        token
    );
    Ok((
        StatusCode::CREATED,
        Json(DeviceLinkIssueResponse {
            id: issued.id.to_string(),
            token,
            expires_at: issued.expires_at_ms,
            sas: issued.sas,
            deep_link,
        }),
    ))
}

pub async fn redeem(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<DeviceLinkRedeemRequest>,
) -> Result<Json<DeviceLinkRedeemResponse>, ApiError> {
    let token = normalized_device_link_token(&request.token).map_err(spec_error)?;
    let device_name = normalized_device_name(&request.device.name).map_err(spec_error)?;
    let device_platform =
        normalized_device_platform(&request.device.platform).map_err(spec_error)?;

    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|error| ApiError::internal("device_link.acquire", error))?;
    let resolved = resolve_device_link_workspace(&mut conn, &token)
        .await
        .map_err(|error| ApiError::internal("device_link.resolve_workspace", error))?;
    drop(conn);

    let Some(workspace_id) = resolved else {
        return Err(mutation_error(DeviceLinkMutation::NotFound));
    };

    let mutation = with_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        let device_name = device_name.clone();
        let device_platform = device_platform.clone();
        let jwt_secret = state.jwt_secret.clone();
        let scopes = base_scopes();
        move |conn| {
            Box::pin(async move {
                let mutation = consume_device_link_in_tx(
                    conn,
                    workspace_id,
                    &token,
                    &device_name,
                    &device_platform,
                    jwt_secret.as_str(),
                    &scopes,
                )
                .await
                .map_err(DbError::from)?;
                if let DeviceLinkMutation::Applied(ref session) = mutation {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "device.linked")
                            .by(session.outcome.member_id)
                            .target("device_link_token", session.outcome.link_id)
                            .via_token(None)
                            .with_schema(
                                "momo.device.linked.v1",
                                serde_json::json!({
                                    "device": {
                                        "name": device_name,
                                        "platform": device_platform,
                                    },
                                    "via": "qr",
                                }),
                            ),
                    )
                    .await?;
                }
                Ok::<_, DbError>(mutation)
            })
        }
    })
    .await
    .map_err(|error| db_error("device_link.redeem", error))?;

    let DeviceLinkMutation::Applied(session) = mutation else {
        return Err(mutation_error(mutation));
    };
    let outcome = session.outcome;

    Ok(Json(DeviceLinkRedeemResponse {
        access_token: session.access.token,
        refresh_token: session.refresh.token,
        member: MemberDto {
            id: outcome.member_id.to_string(),
            workspace_id: outcome.workspace_id.to_string(),
            kind: outcome.kind,
            display_name: outcome.display_name,
            handle: outcome.handle,
        },
        realtime_web_socket_url: state.advertised_realtime_ws_url(&headers, uri.scheme_str())?,
        pending_sas: outcome.pending_sas,
    }))
}

pub async fn status(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<DeviceLinkStatusResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let issued_session_token_id = issuer_token_id(&principal)?;
    let link_id = path_uuid(&id, "invalid device link id")?;
    let workspace_id = principal.workspace_id;

    let status = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            device_link_status_in_tx(conn, workspace_id, issued_session_token_id, link_id)
                .await
                .map_err(DbError::from)
        })
    })
    .await
    .map_err(|error| db_error("device_link.status", error))?;

    let Some(status) = status else {
        return Err(ApiError::not_found("device link not found"));
    };
    let label = match status.status {
        DeviceLinkStatusKind::Pending => "pending",
        DeviceLinkStatusKind::Consumed => "consumed",
        DeviceLinkStatusKind::Expired => "expired",
    };
    let device = match (status.device_label, status.device_platform) {
        (Some(name), Some(platform)) => Some(DeviceLinkDevice { name, platform }),
        _ => None,
    };
    Ok(Json(DeviceLinkStatusResponse {
        status: label,
        device,
    }))
}

pub async fn confirm_sas(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<DeviceLinkConfirmResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let issued_session_token_id = issuer_token_id(&principal)?;
    let link_id = path_uuid(&id, "invalid device link id")?;
    let workspace_id = principal.workspace_id;

    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            confirm_device_link_sas_in_tx(conn, workspace_id, issued_session_token_id, link_id)
                .await
                .map_err(DbError::from)
        })
    })
    .await
    .map_err(|error| db_error("device_link.confirm_sas", error))?;

    match outcome {
        DeviceLinkConfirm::Confirmed | DeviceLinkConfirm::AlreadyConfirmed => {
            Ok(Json(DeviceLinkConfirmResponse {
                status: "confirmed",
            }))
        }
        DeviceLinkConfirm::NotRequired => Err(ApiError::new(
            StatusCode::CONFLICT,
            "sas confirmation is not required",
        )),
        DeviceLinkConfirm::NotRedeemed => Err(ApiError::new(
            StatusCode::CONFLICT,
            "device link has not been redeemed",
        )),
        DeviceLinkConfirm::NotFound => Err(ApiError::not_found("device link not found")),
    }
}

#[cfg(test)]
mod tests {
    use super::percent_encode_unreserved;

    #[test]
    fn percent_encodes_the_join_grammar_server_value() {
        assert_eq!(
            percent_encode_unreserved("https://app.example.com"),
            "https%3A%2F%2Fapp.example.com"
        );
        assert_eq!(
            percent_encode_unreserved("http://127.0.0.1:8088"),
            "http%3A%2F%2F127.0.0.1%3A8088"
        );
    }
}
