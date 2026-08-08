//! T3 cloud-host acquisition — Swift `CloudProvisionerRoutes.swift` parity
//! (ADR-0142 D1 BYOC + ADR-0136 D1-A managed).
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-hosts/byoc/enrollments  (bearer, workspace admin)
//! POST /v1/workspaces/{ws}/work-hosts/cloud             (bearer, active member + tier policy)
//! POST /v1/workspaces/{ws}/work-hosts/cloud/register    (PUBLIC, MomoBootstrap token)
//! GET  /v1/workspaces/{ws}/work-hosts/cloud/{provision} (bearer, human)
//! ```
//!
//! ## The two acquisitions, and the one line between them
//!
//! Both end at the same `work_cloud_host` row and the same `register` route.
//! They differ in exactly one step: who boots the machine.
//!
//! * **BYOC** ([`enroll`], ADR-0142 D1) — the owner does. momo never gained the
//!   right to boot or kill their machine, so the enrollment *is* the instance:
//!   `provider_sandbox_id` is derived at insert time and no provider is called.
//! * **Managed** ([`provision`], ADR-0136 D1-A / ADR-0156 D4-④) — momo does,
//!   through the [`momo_t3::CloudProvisioner`] the operator configured. The row
//!   is committed *before* the provider call and the instance handle is recorded
//!   *after* it, because an instance with no row is money nobody can name while a
//!   row with no instance is a retry.
//!
//! B2.2 could only serve the first: the managed create needs an outbound HTTP
//! client, and this crate deliberately has no `reqwest` (invariant #2). It still
//! does not — the client lives inside `momo-t3`'s adapter and the whole surface
//! reachable from here is the provisioner's two methods, exactly the shape
//! ADR-0149 gave `momo-ephemeral`.
//!
//! ## The bootstrap token, and why the two paths mint it differently
//!
//! `enroll` mints a **random** token, stores only its SHA-256 digest
//! (045:87-88) and returns it exactly once — a replayed `idempotencyRef` is a
//! 409, because momo cannot re-reveal a token it never kept.
//!
//! `provision` **derives** its token from the provision id (ADR-0136 D2), and a
//! replayed `idempotencyRef` is therefore *success*, not a conflict: the retry
//! re-derives the same credential the row already stores the digest of, hands it
//! to the same instance the adapter's metadata reconstruction converges on, and
//! nothing is created twice. The token is never returned to anybody — it travels
//! in the instance's environment.
//!
//! `register` is public for both because the workd holding a token has no bearer
//! credential yet; the token is its authorization, spent under `FOR UPDATE` with
//! unconsumed/unexpired/`provisioning` all in the WHERE clause.
//!
//! ## Not served here
//!
//! `.../cloud/pause`, `.../cloud/resume`, `DELETE .../cloud` — the durable-intent
//! verbs. They are ADR-0140 D4's, and the process that performs them is
//! `momo-notifier`'s reconciler, which resolves the same adapter through
//! `momo_t3::managed_adapters_from_process_env`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, insert_work_host, load_work_host, NewWorkHost, Principal};
use momo_settings::{
    cloud_acquisition_rejection, load_tier_policy, CloudAcquisitionRejected, TierScope,
};
use momo_t3::{
    bind_cloud_host_in_tx, bootstrap_token_digest, claim_bootstrap_in_tx,
    cloud_host_id_for_bootstrap_digest, enroll_byoc_cloud_host_in_tx,
    enroll_managed_cloud_host_in_tx, find_enrollment_by_idempotency_key_in_tx,
    find_managed_provision_by_idempotency_key_in_tx, load_cloud_host_in_tx,
    load_managed_provision_in_tx, lock_enrollment_key_in_tx, mint_bootstrap_token,
    record_provider_instance_in_tx, reserve_provisioning_slot_in_tx, with_t3_lifecycle_tx,
    CloudProviderError, CloudProvisioner, ManagedProvision, NewByocEnrollment, NewManagedProvision,
    ProvisionRequest, T3LockLadder,
};
use uuid::Uuid;

use crate::dto::{
    ByocEnrollmentDto, ByocEnrollmentResponse, CloudHostDto, CloudHostResponse, CloudProvisionDto,
    CloudProvisionResponse, EnrollByocHostRequest, ProvisionCloudHostRequest,
    RegisterWorkHostRequest,
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
    require_human(&principal, "oort Cloud management requires a human member")?;
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

// ---------------------------------------------------------------------------
// managed acquisition (ADR-0136 D1-A, ADR-0156 D4-④)
// ---------------------------------------------------------------------------

/// Only a workspace-shared managed host is served, exactly as for BYOC.
fn validated_shared_scope(scope: Option<&str>) -> Result<(), ApiError> {
    match scope {
        None | Some("workspace") => Ok(()),
        Some(_) => Err(ApiError::bad_request(
            "oort Cloud 호스트는 워크스페이스 공용만 지원합니다. 개인 호스트는 아직 열려 있지 않습니다.",
        )),
    }
}

/// The 503 an instance answers when momo Cloud is configured *in intent* but not
/// *in capability* — the operator named a managed provider and supplied no
/// endpoint, or named the degenerate one.
///
/// A 503 rather than a 500: nothing is wrong with the request, and nothing is
/// wrong with the code. The instance simply cannot acquire a paid host right
/// now, and saying so is what stops a durable billable row being written against
/// a substrate nobody can reach (ADR-0142 D4).
fn provisioner_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "이 인스턴스에는 oort Cloud 호스트를 생성할 수 있는 provider가 설정돼 있지 않습니다. \
         인스턴스 운영자에게 문의하세요.",
    )
}

/// The provisioner for this request, or a refusal — resolved **before** any
/// durable write.
///
/// Three conditions, and each one is a way a half-configured instance could
/// otherwise create something billable it can never finish:
///
/// 1. the operator configured a provisioner at all;
/// 2. it is the provider new rows will be stamped with
///    (`work_cloud_host.provider` must name the adapter that will later be asked
///    to pause/destroy this host — a mismatch here is a host the reconciler
///    resolves to the wrong substrate);
/// 3. it declares `Create`. Read through
///    [`momo_provider::CloudProviderCapabilities`], never by comparing a provider
///    id, so this stays the ADR-0142 D2 shape: policy asks what a substrate can
///    do, never who it is.
fn require_provisioner(state: &AppState) -> Result<Arc<CloudProvisioner>, ApiError> {
    let provisioner = state
        .t3_provisioner
        .clone()
        .ok_or_else(provisioner_unavailable)?;
    if provisioner.provider_id() != state.t3.default_provider_id {
        tracing::error!(
            configured_provider = %state.t3.default_provider_id,
            provisioner_provider = %provisioner.provider_id(),
            "the configured T3 provider and the built provisioner disagree; refusing to \
             provision rather than stamping rows with a provider nobody will reconcile"
        );
        return Err(provisioner_unavailable());
    }
    if !provisioner.can_create() {
        // The degenerate adapter reaching here means the operator asked for a
        // managed acquisition against a BYOC-shaped provider. `enroll` is the
        // route for that, and saying so beats booting nothing.
        return Err(provisioner_unavailable());
    }
    Ok(provisioner)
}

/// ADR-0136's flow begins at a *cloud session request*, so the policy that
/// decides whether this member's work may go to the cloud at all is the gate.
fn tier_rejection(rejection: CloudAcquisitionRejected) -> ApiError {
    match rejection {
        CloudAcquisitionRejected::TierPolicyExcludesCloud => ApiError::new(
            StatusCode::CONFLICT,
            "현재 작업 티어 정책이 oort Cloud 호스트를 허용하지 않습니다. 정책을 먼저 바꾸세요.",
        ),
        CloudAcquisitionRejected::PolicyPinsAnotherHost => ApiError::new(
            StatusCode::CONFLICT,
            "작업 티어 정책이 특정 호스트를 지정하고 있습니다. 새 클라우드 호스트를 만들 수 없습니다.",
        ),
    }
}

/// A provider call that did not produce an instance, as the client sees it.
///
/// Always a 503 and always the same sentence: the substrate refused, timed out,
/// or answered something momo could not read, and none of those is the caller's
/// to fix or to distinguish. What *is* load bearing is the log line beside it —
/// the failure is named for the operator, and the durable row stays
/// `provisioning` so the very next retry with the same `idempotencyRef`
/// re-derives the same bootstrap token and converges on the same instance.
fn provider_call_failed(context: &str, error: CloudProviderError) -> ApiError {
    tracing::warn!(
        context,
        error = %error,
        "oort Cloud instance creation did not complete; the provisioning row stays claimable"
    );
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "oort Cloud 호스트를 준비하지 못했습니다. 잠시 후 같은 idempotencyRef로 다시 시도하세요.",
    )
}

/// `POST /v1/workspaces/{ws}/work-hosts/cloud` → 201 (Swift `create`, :80-283;
/// ADR-0136 D1-A, ADR-0156 D4-④).
///
/// ## The shape of the transaction, and why it is two of them
///
/// ```text
///   tx1 (tenant)  membership → tier policy → key advisory → replay
///                 → admission → durable row            [COMMIT]
///   ── no transaction ──  adapter.create (HTTP)
///   tx2 (ladder)  record the instance handle           [COMMIT]
/// ```
///
/// ADR-0136 D2 requires the durable intent to be committed before the external
/// call, and ADR-0140 D4 requires provider calls to happen outside a
/// transaction — a DB transaction held open across an HTTP round trip is a lock
/// held for as long as somebody else's outage. The gap between the two is
/// exactly the "row exists, instance may or may not" state, and it is
/// recoverable *because* the token is derived rather than minted: the retry is
/// the replay branch, and it walks the same second half.
///
/// ## What closes the double-create window
///
/// Two halves, and neither is sufficient alone (the managed adapter's own module
/// header states the same pairing from the substrate's side):
///
/// * **exclusion** — `lock_enrollment_key_in_tx` serializes concurrent requests
///   carrying the same `idempotencyRef`, and `work_cloud_host_create_idempotency_idx`
///   (049:38) makes a second row for one ref impossible. Distinct refs get
///   distinct provision ids, hence distinct instance stamps, and cannot collide.
/// * **recovery** — the adapter's metadata reconstruction adopts an instance a
///   lost response left behind, and [`momo_t3::record_provider_instance_in_tx`]
///   keeps the handle the row already published if two ever raced past both.
pub async fn provision(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<ProvisionCloudHostRequest>,
) -> Result<impl IntoResponse, ApiError> {
    require_human(&principal, "oort Cloud management requires a human member")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // The gate first, and before every write: T3 on, the configured provider in
    // the registry, an https callback URL. A disabled instance never reaches the
    // provisioner below, so no request leaves this process and no row is made.
    let public_base_url = ready_t3(&state.t3)?;
    let provisioner = require_provisioner(&state)?;

    validated_shared_scope(request.scope.as_deref())?;
    let display_name = validated_display_name(&request.display_name)?;
    let idempotency_key = Uuid::parse_str(request.idempotency_ref.trim())
        .map_err(|_| ApiError::bad_request("idempotencyRef must be a UUID"))?;

    let member_id = principal.member_id;
    let unit_rate = state.t3.unit_rate_micro_usd_second;
    let provider = provisioner.provider_id().to_string();

    // ---- tx1: the durable intent ------------------------------------------
    let provisioner_for_tx = Arc::clone(&provisioner);
    let enrolled_display_name = display_name.clone();
    let enrolled = settle(
        "cloud_hosts.provision",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not an active workspace member")));
                }
                // ADR-0136 D1-A: the trigger is a cloud session request, so the
                // policy in force for this member is what says whether a paid
                // host may be acquired for them at all.
                let policy = load_tier_policy(conn, workspace_id, TierScope::Member(member_id))
                    .await
                    .map_err(momo_t3::T3Error::from)?;
                if let Some(rejection) =
                    cloud_acquisition_rejection(&policy.mode, policy.auto_target.as_deref())
                {
                    return Ok(Err(tier_rejection(rejection)));
                }

                // The same serialization the BYOC enrollment uses: a row lock
                // cannot order a key which does not exist yet.
                lock_enrollment_key_in_tx(conn, workspace_id, idempotency_key).await?;

                // Replay first, admission second: a repeated idempotencyRef must
                // not consume a second slot.
                if let Some(existing) = find_managed_provision_by_idempotency_key_in_tx(
                    conn,
                    workspace_id,
                    idempotency_key,
                )
                .await?
                {
                    return Ok(Ok(existing));
                }

                reserve_provisioning_slot_in_tx(conn, workspace_id, member_id).await?;

                let provision_id = momo_t3::allocate_uuid_v7(conn).await?;
                // Derived, not minted (ADR-0136 D2). The digest is all that is
                // stored, and the retry above re-derives the raw token from the
                // provision id alone.
                let token = provisioner_for_tx.bootstrap_token(provision_id);
                let enrollment = enroll_managed_cloud_host_in_tx(
                    conn,
                    workspace_id,
                    &NewManagedProvision {
                        provision_id,
                        requester_member_id: member_id,
                        provider: provider.clone(),
                        bootstrap_token_digest: token.digest().to_string(),
                        unit_rate_micro_usd_second: unit_rate,
                        idempotency_key,
                        requested_display_name: enrolled_display_name.clone(),
                    },
                )
                .await?;
                Ok(Ok(enrollment))
            })
        })
        .await,
    )?;

    let provision_id = enrolled.provision_id;
    let register_url =
        format!("{public_base_url}/v1/workspaces/{workspace_id}/work-hosts/cloud/register");

    // A replay whose instance is already recorded asks the substrate nothing:
    // the work is done and re-calling would only widen the window this branch
    // exists to close.
    if enrolled.instance_known {
        return Ok((
            StatusCode::CREATED,
            Json(CloudProvisionResponse {
                provision: provision_dto(enrolled, register_url),
            }),
        ));
    }

    // ---- the provider call, outside every transaction ----------------------
    //
    // The one-shot credential the workd will spend is assembled inside the
    // provisioner (it derives the same string a retry would), so no bootstrap
    // token value ever exists in this crate.
    let instance = provisioner
        .provision_instance(&ProvisionRequest {
            provision_id,
            workspace_id,
            display_name: &display_name,
            server_url: &public_base_url,
        })
        .await
        .map_err(|error| provider_call_failed("cloud_hosts.provision", error))?;

    // ---- tx2: publish the handle under the ADR-0140 D2 ladder --------------
    let instance_id = instance.instance_id.clone();
    let recorded = settle(
        "cloud_hosts.provision.record",
        with_t3_lifecycle_tx(
            &state.pool,
            workspace_id,
            T3LockLadder::host(provision_id),
            move |conn| {
                Box::pin(async move {
                    record_provider_instance_in_tx(conn, workspace_id, provision_id, &instance_id)
                        .await?;
                    Ok(Ok(load_managed_provision_in_tx(
                        conn,
                        workspace_id,
                        provision_id,
                    )
                    .await?))
                })
            },
        )
        .await,
    )?
    .ok_or_else(|| ApiError::internal("cloud_hosts.provision", "cloud provision reload failed"))?;

    Ok((
        StatusCode::CREATED,
        Json(CloudProvisionResponse {
            provision: provision_dto(
                ManagedProvision {
                    replayed: enrolled.replayed,
                    ..recorded
                },
                register_url,
            ),
        }),
    ))
}

fn provision_dto(provision: ManagedProvision, register_url: String) -> CloudProvisionDto {
    CloudProvisionDto {
        provision_id: provision.provision_id.to_string(),
        provider: provision.provider,
        state: provision.state,
        instance_known: provision.instance_known,
        bootstrap_expires_at_ms: provision.bootstrap_expires_at_ms,
        register_url,
        replayed: provision.replayed,
    }
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
                            "oort Cloud registration lifecycle changed; retry",
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
    require_human(&principal, "oort Cloud management requires a human member")?;
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
    .ok_or_else(|| ApiError::not_found("oort Cloud host not found"))?;

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
