//! Paid-credit mutation — Swift `CloudCreditRoutes.swift:30` parity.
//!
//! ```text
//! POST /v1/admin/workspaces/{ws}/credits/topups
//! ```
//!
//! ## Why this route is in the T3 batch at all
//!
//! Measured: BYOC enrollment runs `CloudUsageLedger.reserveProvisioningSlot`,
//! which **fails closed** when the workspace has no `workspace_credit` row or a
//! balance of zero — and a workspace is created with `balance_micro_usd = 0`
//! (`WorkspaceRoutes.swift:158-163`). So without a top-up there is no way to
//! enroll a T3 host, and therefore no T3 curve to smoke. (Session *start* does
//! not check the balance; see `momo_t3::acquire_slot_in_tx`.)
//!
//! ## Authorization: `platform:read` is deliberately not sufficient
//!
//! Two paths, ported verbatim from `requireCreditWriter` (:152-196):
//!   1. a token carrying the `platform:credits:write` scope, or
//!   2. a **workspace admin whose verified email is on the instance-operator
//!      allow-list** (`PLATFORM_ADMIN_EMAILS`).
//!
//! Path 2 is not a bypass: a self-hosted instance can never mint a platform
//! token, so without it that instance's T3 balance would be unreachable except
//! by touching the database. What the ADR-0882 adversarial review removed — and
//! what stays removed here — is `platform:read` SUFFICIENCY: a cross-tenant READ
//! credential must never move money.
//!
//! Note the scope path is currently unreachable through this server's own login
//! (`auth_routes::base_scopes` issues `messages:*` only, and no platform-admin
//! elevation is ported), so on a Rust-only deployment path 2 is the operative
//! one. The scope check is kept because a token minted elsewhere must behave the
//! same here as it does on the Swift server.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, verified_operator_email, Principal};
use momo_t3::{topup_credit_in_tx, TopupOutcome};
use uuid::Uuid;

use crate::dto::{CloudCreditTopupRequest, CloudCreditTopupResponse};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, settle, t3_disabled, tenant_tx};
use crate::AppState;

/// Swift `CloudCreditRoutes.writeScope`.
const WRITE_SCOPE: &str = "platform:credits:write";

/// Upper bound from Swift (:46-51): 1 … 1e12 micro-USD (= 1 000 000 USD).
const MAX_TOPUP_MICRO_USD: i64 = 1_000_000_000_000;

/// `POST /v1/admin/workspaces/{ws}/credits/topups`.
///
/// Note the workspace comes from the **path**, not the credential: this is an
/// admin surface that operates on another workspace's ledger. The tenant
/// transaction is opened on that path workspace, and the audit trail (deferred,
/// see the PR body) is what records which operator did it.
pub async fn topup(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CloudCreditTopupRequest>,
) -> Result<Json<CloudCreditTopupResponse>, ApiError> {
    if !state.t3.enabled {
        return Err(t3_disabled());
    }
    require_human(&principal, "human operator required")?;
    let workspace_id = path_uuid(&workspace, "invalid workspace id")?;

    if request.amount_micro_usd <= 0 || request.amount_micro_usd > MAX_TOPUP_MICRO_USD {
        return Err(ApiError::bad_request(
            "amountMicroUsd must be between 1 and 1000000000000",
        ));
    }
    let idempotency_ref = Uuid::parse_str(request.idempotency_ref.trim())
        .map_err(|_| ApiError::bad_request("idempotencyRef must be a UUID"))?;

    authorize_credit_writer(&state, &principal).await?;

    let amount = request.amount_micro_usd;
    let outcome = settle(
        "credits.topup",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(topup_credit_in_tx(
                    conn,
                    workspace_id,
                    amount,
                    idempotency_ref,
                )
                .await?))
            })
        })
        .await,
    )?;

    let balance = match outcome {
        None => return Err(ApiError::not_found("workspace not found")),
        Some(TopupOutcome::RefConflict) => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "idempotencyRef was already used with a different amount",
            ))
        }
        Some(TopupOutcome::Applied { balance_micro_usd })
        | Some(TopupOutcome::Replayed { balance_micro_usd }) => balance_micro_usd,
    };

    Ok(Json(CloudCreditTopupResponse {
        workspace_id: workspace_id.to_string(),
        amount_micro_usd: amount,
        idempotency_ref: idempotency_ref.to_string(),
        balance_micro_usd: balance,
    }))
}

/// The two authorized paths, checked in the **operator's own** workspace.
async fn authorize_credit_writer(state: &AppState, principal: &Principal) -> Result<(), ApiError> {
    if principal.scopes.iter().any(|scope| scope == WRITE_SCOPE) {
        return Ok(());
    }

    let operator_workspace = principal.workspace_id;
    let member_id = principal.member_id;
    let checked = settle(
        "credits.authorize",
        tenant_tx(&state.pool, operator_workspace, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, operator_workspace, member_id).await?;
                let email = verified_operator_email(conn, operator_workspace, member_id).await?;
                Ok(Ok((role, email)))
            })
        })
        .await,
    )?;

    let is_listed_operator = checked.0.is_some_and(|role| role.is_admin())
        && checked
            .1
            .is_some_and(|email| state.t3.platform_admin_emails.contains(&email));
    if is_listed_operator {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "{WRITE_SCOPE} scope or listed instance operator required"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_amount_bounds_are_the_swift_bounds() {
        assert_eq!(MAX_TOPUP_MICRO_USD, 1_000_000_000_000);
        assert_eq!(WRITE_SCOPE, "platform:credits:write");
    }
}
