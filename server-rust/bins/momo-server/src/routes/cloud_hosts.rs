//! T3 cloud-host acquisition — Swift `CloudProvisionerRoutes.swift` parity, the
//! BYOC subset (ADR-0142 D1).
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-hosts/byoc/enrollments  (bearer, workspace admin)
//! POST /v1/workspaces/{ws}/work-hosts/cloud/register    (PUBLIC, MomoBootstrap token)
//! GET  /v1/workspaces/{ws}/work-hosts/cloud/{provision} (bearer, human)
//! ```
//!
//! ## Why BYOC and not a managed provider
//!
//! The packet named `mock-a`. Measured, `mock-a` is a **managed** adapter: the
//! managed path (`POST .../work-hosts/cloud`, Swift `create` :80-283) calls the
//! provider's HTTP API to boot an instance, which needs (a) a live substrate at
//! `MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL` and (b) an outbound HTTP client inside
//! momo-server — and this crate deliberately has none (invariant #2: only
//! momo-relay makes outbound HTTP). BYOC is the path that closes the T3 curve
//! without either: momo registers, schedules, observes and bills a host it never
//! boots, so `enroll` makes no provider call at all (:284-286) and the whole
//! lifecycle from `provisioning` to settlement is exercised by the same
//! statements a managed host would use. `mock-a`'s managed create belongs with
//! the batch that gives momo-server a provider client.
//!
//! ## The bootstrap token
//!
//! `enroll` mints a one-shot token, stores **only its SHA-256 digest**
//! (045:87-88) and returns the token exactly once. `register` is public because
//! the workd holding that token has no bearer credential yet; the token is its
//! authorization, spent under `FOR UPDATE` with unconsumed/unexpired/`provisioning`
//! all in the WHERE clause, so a replay finds nothing. A replayed
//! `idempotencyRef` on `enroll` is a 409 rather than a re-issue: momo cannot
//! re-reveal a token it never kept.
//!
//! ## Not served by this batch
//!
//! `POST .../work-hosts/cloud` (managed create), `.../cloud/pause`,
//! `.../cloud/resume`, `DELETE .../cloud` (destroy) — every one of them drives a
//! provider adapter over HTTP. They land with the provider-client batch; ADR-0140
//! D4 reconciliation lands with it too.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, insert_work_host, load_work_host, NewWorkHost, Principal};
use momo_t3::{
    bind_cloud_host_in_tx, bootstrap_token_digest, claim_bootstrap_in_tx,
    cloud_host_id_for_bootstrap_digest, enroll_byoc_cloud_host_in_tx,
    find_enrollment_by_idempotency_key_in_tx, load_cloud_host_in_tx, lock_enrollment_key_in_tx,
    mint_bootstrap_token, reserve_provisioning_slot_in_tx, with_t3_lifecycle_tx, NewByocEnrollment,
    T3LockLadder,
};
use uuid::Uuid;

use crate::dto::{
    ByocEnrollmentDto, ByocEnrollmentResponse, CloudHostDto, CloudHostResponse,
    EnrollByocHostRequest, RegisterWorkHostRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    path_uuid, ready_t3, require_human, settle, t3_disabled, tenant_tx, workspace_scope,
};
use crate::routes::work_hosts::{
    validated_capabilities, validated_display_name, validated_public_key, validated_scope,
    validated_type, work_host_dto,
};
use crate::AppState;

/// `Authorization: MomoBootstrap <token>`, 40…128 characters
/// (Swift `bootstrapToken`, :1272-1283).
fn bootstrap_token(headers: &HeaderMap) -> Result<String, ApiError> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("MomoBootstrap "))
        .ok_or_else(|| ApiError::unauthorized("cloud bootstrap authorization required"))?;
    if !(40..=128).contains(&header.len()) {
        return Err(ApiError::unauthorized(
            "invalid cloud bootstrap authorization",
        ));
    }
    Ok(header.to_string())
}

/// `POST /v1/workspaces/{ws}/work-hosts/byoc/enrollments` → 201
/// (Swift `enroll`, :287-423).
pub async fn enroll(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<EnrollByocHostRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, "momo Cloud management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let public_base_url = ready_t3(&state.t3)?;

    // ADR-0142 D1 is workspace-shared only. The schema does not block a personal
    // host; this REST does, BY NAME, so a personal request is refused instead of
    // quietly becoming a workspace-wide one.
    if let Some(scope) = request.scope.as_deref() {
        if scope != "workspace" {
            return Err(ApiError::bad_request(
                "BYOC 등록은 워크스페이스 공용만 지원합니다. 개인 호스트는 아직 열려 있지 않습니다.",
            ));
        }
    }
    let display_name = validated_display_name(&request.display_name)?;
    let idempotency_key = Uuid::parse_str(request.idempotency_ref.trim())
        .map_err(|_| ApiError::bad_request("idempotencyRef must be a UUID"))?;

    // Minted before the transaction and never stored: only `digest` is bound to
    // a statement, and `raw` leaves this process exactly once, in the response.
    let token = mint_bootstrap_token();
    let digest = token.digest().to_string();
    let member_id = principal.member_id;
    let unit_rate = state.t3.unit_rate_micro_usd_second;
    // BYOC is always recorded as the `byoc` adapter even when the instance's
    // default provider is a managed one (Swift `byocCapabilities` :1166-1177):
    // `work_cloud_host.provider` names the adapter that will be asked to act on
    // this host, and for an owner-operated machine that adapter is the
    // degenerate one, by construction.
    let provider = momo_t3::provider::BYOC_PROVIDER_ID.to_string();

    let enrollment = settle(
        "cloud_hosts.enroll",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
                    return Ok(Err(ApiError::forbidden("not an active workspace member")));
                };
                if !role.is_admin() {
                    return Ok(Err(ApiError::forbidden(
                        "BYOC 호스트 등록은 워크스페이스 관리자만 할 수 있습니다.",
                    )));
                }
                // Same serialization the managed create uses: a row lock cannot
                // order a key which does not exist yet (Swift :327-339).
                lock_enrollment_key_in_tx(conn, workspace_id, idempotency_key).await?;

                // Replay first, admission second (Swift :340-359): a repeated
                // idempotencyRef must not consume a slot.
                if let Some(existing) =
                    find_enrollment_by_idempotency_key_in_tx(conn, workspace_id, idempotency_key)
                        .await?
                {
                    return Ok(Ok(existing));
                }

                // Admission BEFORE the durable row: slots and a positive credit
                // balance are what make a paid host startable at all
                // (`CloudUsageLedger.reserveProvisioningSlot`). This is the ONLY
                // credit check in the T3 curve — session start deliberately has
                // none (see `momo_t3::acquire_slot_in_tx`).
                reserve_provisioning_slot_in_tx(conn, workspace_id, member_id).await?;

                let provision_id = momo_t3::allocate_uuid_v7(conn).await?;
                let enrollment = enroll_byoc_cloud_host_in_tx(
                    conn,
                    workspace_id,
                    &NewByocEnrollment {
                        provision_id,
                        requester_member_id: member_id,
                        provider: provider.clone(),
                        bootstrap_token_digest: digest.clone(),
                        unit_rate_micro_usd_second: unit_rate,
                        idempotency_key,
                        requested_display_name: display_name.clone(),
                    },
                )
                .await?;
                Ok(Ok(enrollment))
            })
        })
        .await,
    )?;

    // A replayed idempotencyRef cannot re-reveal a token momo never kept.
    if enrollment.replayed {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "이 idempotencyRef의 등록 토큰은 이미 발급됐습니다. 새 ref로 다시 요청하세요.",
        ));
    }

    Ok((
        StatusCode::CREATED,
        Json(ByocEnrollmentResponse {
            enrollment: ByocEnrollmentDto {
                provision_id: enrollment.provision_id.to_string(),
                provider: enrollment.provider,
                state: enrollment.state,
                bootstrap_token: token.raw().to_string(),
                bootstrap_expires_at_ms: enrollment.bootstrap_expires_at_ms,
                register_url: format!(
                    "{public_base_url}/v1/workspaces/{workspace_id}/work-hosts/cloud/register"
                ),
            },
        }),
    ))
}

/// `POST /v1/workspaces/{ws}/work-hosts/cloud/register` → 201 — PUBLIC
/// (Swift `register`, :425-524).
///
/// The workd creates its own Ed25519 key and spends the one-shot token; momo
/// never held the private half, and the token's digest is consumed in the same
/// transaction that inserts the host and binds it
/// ([`momo_t3::bind_cloud_host_in_tx`], the port of :488-498).
pub async fn register_cloud_host(
    State(state): State<AppState>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RegisterWorkHostRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if !state.t3.enabled {
        return Err(t3_disabled());
    }
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;
    let raw_token = bootstrap_token(&headers)?;
    let digest = bootstrap_token_digest(&raw_token);

    if validated_scope(&request.scope)? != "workspace"
        || validated_type(&request.host_type)? != "cloud"
    {
        return Err(ApiError::bad_request(
            "cloud workd must register workspace-scoped type=cloud",
        ));
    }
    let display_name = validated_display_name(&request.display_name)?;
    let public_key = validated_public_key(&request.public_key)?;
    let capabilities_json = validated_capabilities(request.capabilities.as_ref())?;

    // Pre-resolve the provision so the lifecycle transaction can take ITS
    // advisory first; the claim below re-reads under FOR UPDATE and the two are
    // compared, so a row that changed in between is a 409, never a write under
    // the wrong lock.
    let expected = cloud_host_id_for_bootstrap_digest(&state.pool, workspace_id, &digest)
        .await
        .map_err(|error| crate::routes::shared::t3_error("cloud_hosts.register", error))?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired cloud bootstrap token"))?;

    let record = settle(
        "cloud_hosts.register",
        with_t3_lifecycle_tx(
            &state.pool,
            workspace_id,
            T3LockLadder::host(expected),
            move |conn| {
                Box::pin(async move {
                    let Some(claim) = claim_bootstrap_in_tx(conn, workspace_id, &digest).await?
                    else {
                        return Ok(Err(ApiError::unauthorized(
                            "invalid or expired cloud bootstrap token",
                        )));
                    };
                    if claim.provision_id != expected {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "momo Cloud registration lifecycle changed; retry",
                        )));
                    }
                    let host_id = insert_work_host(
                        conn,
                        workspace_id,
                        &NewWorkHost {
                            scope: "workspace".to_string(),
                            // Attributed to the member who enrolled it, never to
                            // identity the registering host supplied.
                            owner_member_id: claim.requester_member_id,
                            host_type: "cloud".to_string(),
                            display_name,
                            public_key,
                            capabilities_json,
                            seen_now: true,
                        },
                    )
                    .await?;
                    bind_cloud_host_in_tx(conn, workspace_id, claim.provision_id, host_id).await?;
                    Ok(Ok(load_work_host(conn, host_id).await?))
                })
            },
        )
        .await,
    )?;

    let record = record.ok_or_else(|| {
        ApiError::internal("cloud_hosts.register", "cloud work host reload failed")
    })?;
    Ok((
        StatusCode::CREATED,
        Json(crate::dto::WorkHostResponse {
            work_host: work_host_dto(record)?,
        }),
    ))
}

/// `GET /v1/workspaces/{ws}/work-hosts/cloud/{provision}` (Swift `get`, :526-554).
pub async fn get_cloud_host(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, provision)): Path<(String, String)>,
) -> Result<Json<CloudHostResponse>, ApiError> {
    require_human(&principal, "momo Cloud management requires a human member")?;
    if !state.t3.enabled {
        return Err(t3_disabled());
    }
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let provision_id = path_uuid(&provision, "invalid provision id")?;

    let record = settle(
        "cloud_hosts.get",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(
                    load_cloud_host_in_tx(conn, workspace_id, provision_id).await?
                ))
            })
        })
        .await,
    )?
    .ok_or_else(|| ApiError::not_found("momo Cloud host not found"))?;

    Ok(Json(CloudHostResponse {
        cloud_host: CloudHostDto {
            provision_id: record.provision_id.to_string(),
            host_id: record.host_id.map(|id| id.to_string()),
            state: record.state,
            provider: record.provider,
            created_at_ms: record.created_at_ms,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::AUTHORIZATION;

    fn headers_with(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, value.parse().expect("header value"));
        headers
    }

    #[test]
    fn bootstrap_scheme_is_distinct_from_bearer() {
        let token = "a".repeat(64);
        assert_eq!(
            bootstrap_token(&headers_with(&format!("MomoBootstrap {token}"))).unwrap(),
            token
        );
        // A bearer token must never be accepted as a bootstrap credential: they
        // authorize different things and only one is single-use.
        assert_eq!(
            bootstrap_token(&headers_with(&format!("Bearer {token}")))
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert!(bootstrap_token(&HeaderMap::new()).is_err());
    }

    #[test]
    fn bootstrap_length_bounds_match_swift() {
        assert!(
            bootstrap_token(&headers_with(&format!("MomoBootstrap {}", "a".repeat(39)))).is_err()
        );
        assert!(
            bootstrap_token(&headers_with(&format!("MomoBootstrap {}", "a".repeat(40)))).is_ok()
        );
        assert!(
            bootstrap_token(&headers_with(&format!("MomoBootstrap {}", "a".repeat(128)))).is_ok()
        );
        assert!(
            bootstrap_token(&headers_with(&format!("MomoBootstrap {}", "a".repeat(129)))).is_err()
        );
    }
}
