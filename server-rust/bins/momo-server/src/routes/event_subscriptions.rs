//! 이벤트 구독 — the four outbound management operations (#1222 / T13).
//!
//! ```text
//! GET    /v1/workspaces/{ws}/event-subscriptions        list
//! POST   /v1/workspaces/{ws}/event-subscriptions        create  201 + the one-time signing secret
//! PUT    /v1/workspaces/{ws}/event-subscriptions/{id}   update
//! DELETE /v1/workspaces/{ws}/event-subscriptions/{id}   delete
//! ```
//!
//! Ports Swift `Routes/EventSubscriptionRoutes.swift`. The client contract is
//! already deployed: `packages/momo-core/src/features/settings/eventSubscriptions.ts`
//! and `clients/web/src/features/settings/EventSubscriptionSection.tsx`.
//!
//! ## This surface is the only place a person controls what leaves the workspace
//!
//! Migration 033's mention and approval projections carry `body` — the message
//! text itself — to a third-party address. That makes this panel a privacy
//! control, and it is why two things here are not negotiable:
//!
//! * **the destination is checked before the row exists** ([`validate_url`]),
//!   because a subscription that can never deliver is a promise the panel would
//!   render as working;
//! * **the secret is answered once**. `secret_ref` is derivation material and
//!   the secret is computed, never stored. Nothing in this module logs a body,
//!   a URL or a failure.
//!
//! The delivery *audit* that completes the story (#1204) is the sender's, not
//! this file's: `momo_webhook::record_delivery_audit`, called by
//! `bins/momo-webhook-sender`.
//!
//! ## Authorization runs twice, on purpose
//!
//! Create and update do caller-controlled **DNS** work (the SSRF guard resolves
//! the operator's host). That must not happen for a caller who is not an admin,
//! so the role is checked before validation *and* again inside the write
//! transaction under `active_workspace_role` — a concurrent demotion then fails
//! closed rather than landing a row.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_webhook::{
    create_subscription, delete_subscription, list_subscriptions, update_subscription,
    validated_kinds, OutboundUrl, OutboundUrlError, SubscriptionRow, SystemHostResolver,
};
use uuid::Uuid;

use crate::dto::{
    CreateEventSubscriptionRequest, CreatedEventSubscriptionResponse, EventSubscriptionDto,
    EventSubscriptionResponse, EventSubscriptionsResponse, UpdateEventSubscriptionRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

const SIGNATURE_VERSION: &str = "v1";
const ALGORITHM: &str = "HMAC-SHA256";

fn subscription_dto(row: SubscriptionRow) -> EventSubscriptionDto {
    EventSubscriptionDto {
        id: row.id.to_string(),
        workspace_id: row.workspace_id.to_string(),
        url: row.url,
        event_kinds: row.event_kinds,
        enabled: row.enabled,
        delivery_failure_count: row.delivery_failure_count,
        disabled_at_ms: row.disabled_at.map(epoch_ms),
        disabled_reason: row.disabled_reason,
        created_by: row.created_by.to_string(),
        updated_by: row.updated_by.to_string(),
        created_at_ms: epoch_ms(row.created_at),
        updated_at_ms: epoch_ms(row.updated_at),
    }
}

async fn authorize(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(role) if role.is_admin() => Ok(()),
        _ => Err(ApiError::forbidden(
            "event subscriptions require a human admin",
        )),
    })
}

/// The pre-transaction role check, so caller-controlled DNS work is never done
/// for a caller who could not have used the result.
async fn preauthorize(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), ApiError> {
    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { authorize(conn, workspace_id, member_id).await })
    })
    .await;
    settle_db("event_subscriptions.authorize", outcome)
}

/// Run the SSRF guard and turn each refusal into the sentence an admin can act
/// on. Swift maps the same four cases (`EventSubscriptionRoutes.validatedURL`).
async fn validate_url(state: &AppState, raw: &str) -> Result<OutboundUrl, ApiError> {
    let allow_http = state.webhook.allow_development_http;
    let url = momo_webhook::validated_url(raw, allow_http).map_err(url_error)?;
    momo_webhook::validated_resolved_addresses(&url, &SystemHostResolver)
        .await
        .map_err(url_error)?;
    Ok(url)
}

fn url_error(error: OutboundUrlError) -> ApiError {
    ApiError::bad_request(error.to_string())
}

/// The audit line every mutation writes. `url` is deliberately absent: the row
/// itself holds the destination and an admin can read it, while `audit_log` is
/// the ledger a *host* can be named in — the same reasoning that keeps the
/// message body out of the delivery audit (063, #1204).
fn audit_entry(
    workspace_id: Uuid,
    action: &str,
    subscription_id: Uuid,
    member_id: Uuid,
    via_token: Option<Uuid>,
    event_kinds: &[String],
    enabled: bool,
) -> AuditEntry {
    AuditEntry::new(workspace_id, action)
        .by(member_id)
        .target("event_subscription", subscription_id)
        .via_token(via_token)
        .with_schema(
            "momo.event_subscription.audit.v1",
            serde_json::json!({
                "event_kinds": event_kinds,
                "enabled": enabled,
            }),
        )
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<EventSubscriptionsResponse>, ApiError> {
    require_human(&principal, "event subscriptions require a human admin")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<SubscriptionRow>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                Ok(Ok(list_subscriptions(conn, workspace_id).await?))
            })
        })
        .await;

    let rows = settle_db("event_subscriptions.list", outcome)?;
    Ok(Json(EventSubscriptionsResponse {
        event_subscriptions: rows.into_iter().map(subscription_dto).collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateEventSubscriptionRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "event subscriptions require a human admin")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    preauthorize(&state, workspace_id, member_id).await?;
    let url = validate_url(&state, &request.url).await?;
    let event_kinds = validated_kinds(&request.event_kinds).ok_or_else(|| {
        ApiError::bad_request(
            "eventKinds must contain mention, approval_request, or work.status_changed",
        )
    })?;
    let enabled = request.enabled.unwrap_or(true);

    // Minted before the transaction so the stored reference and the secret in
    // the response are provably derived from ONE value.
    let secret_ref = momo_webhook::random_reference();

    let outcome: DbRejectable<SubscriptionRow> = {
        let secret_ref = secret_ref.clone();
        let absolute = url.absolute.clone();
        let event_kinds = event_kinds.clone();
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let row = create_subscription(
                    conn,
                    workspace_id,
                    &absolute,
                    &secret_ref,
                    &event_kinds,
                    enabled,
                    member_id,
                )
                .await?;
                write_audit(
                    conn,
                    &audit_entry(
                        workspace_id,
                        "event_subscription.created",
                        row.id,
                        member_id,
                        via_token,
                        &row.event_kinds,
                        row.enabled,
                    ),
                )
                .await?;
                Ok(Ok(row))
            })
        })
        .await
    };

    let row = settle_db("event_subscriptions.create", outcome)?;
    let secret = momo_webhook::outbound_secret(
        state.webhook.outbound_master_key_or(&state.jwt_secret),
        &secret_ref,
    );
    Ok((
        StatusCode::CREATED,
        Json(CreatedEventSubscriptionResponse {
            event_subscription: subscription_dto(row),
            secret,
            signature_version: SIGNATURE_VERSION,
            algorithm: ALGORITHM,
        }),
    )
        .into_response())
}

pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, subscription)): Path<(String, String)>,
    Json(request): Json<UpdateEventSubscriptionRequest>,
) -> Result<Json<EventSubscriptionResponse>, ApiError> {
    require_human(&principal, "event subscriptions require a human admin")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let subscription_id = path_uuid(&subscription, "invalid event subscription id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    // An empty body is a 400 rather than a 200 that changed nothing: the panel
    // would render success for a save that did not happen.
    if request.is_empty() {
        return Err(ApiError::bad_request("event subscription update is empty"));
    }
    preauthorize(&state, workspace_id, member_id).await?;

    let url = match request.url.as_deref() {
        // A NEW destination gets the same guard as create — and the sender
        // checks it again at delivery time, because DNS can move in between.
        Some(raw) => Some(validate_url(&state, raw).await?.absolute),
        None => None,
    };
    let event_kinds = match request.event_kinds.as_deref() {
        Some(raw) => Some(validated_kinds(raw).ok_or_else(|| {
            ApiError::bad_request(
                "eventKinds must contain mention, approval_request, or work.status_changed",
            )
        })?),
        None => None,
    };
    let enabled = request.enabled;

    let outcome: DbRejectable<SubscriptionRow> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(row) = update_subscription(
                    conn,
                    workspace_id,
                    subscription_id,
                    url.as_deref(),
                    event_kinds.as_deref(),
                    enabled,
                    member_id,
                )
                .await?
                else {
                    return Ok(Err(ApiError::not_found("event subscription not found")));
                };
                write_audit(
                    conn,
                    &audit_entry(
                        workspace_id,
                        "event_subscription.updated",
                        subscription_id,
                        member_id,
                        via_token,
                        &row.event_kinds,
                        row.enabled,
                    ),
                )
                .await?;
                Ok(Ok(row))
            })
        })
        .await;

    let row = settle_db("event_subscriptions.update", outcome)?;
    Ok(Json(EventSubscriptionResponse {
        event_subscription: subscription_dto(row),
    }))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, subscription)): Path<(String, String)>,
) -> Result<Json<EventSubscriptionResponse>, ApiError> {
    require_human(&principal, "event subscriptions require a human admin")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let subscription_id = path_uuid(&subscription, "invalid event subscription id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<SubscriptionRow> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = authorize(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(row) = delete_subscription(conn, workspace_id, subscription_id).await?
                else {
                    return Ok(Err(ApiError::not_found("event subscription not found")));
                };
                // Written AFTER the delete and in the same transaction: the row
                // is gone, and this line is the only remaining record that it
                // ever existed or what it was sending.
                write_audit(
                    conn,
                    &audit_entry(
                        workspace_id,
                        "event_subscription.deleted",
                        subscription_id,
                        member_id,
                        via_token,
                        &row.event_kinds,
                        row.enabled,
                    ),
                )
                .await?;
                Ok(Ok(row))
            })
        })
        .await;

    let row = settle_db("event_subscriptions.delete", outcome)?;
    Ok(Json(EventSubscriptionResponse {
        event_subscription: subscription_dto(row),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use serde_json::Value;

    fn row() -> SubscriptionRow {
        SubscriptionRow {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            url: "https://example.com/hook".into(),
            event_kinds: vec!["mention".into()],
            enabled: true,
            delivery_failure_count: 0,
            disabled_at: None,
            disabled_reason: None,
            created_by: Uuid::from_u128(3),
            updated_by: Uuid::from_u128(3),
            created_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            updated_at: Utc.timestamp_opt(1_700_000_001, 0).unwrap(),
        }
    }

    #[test]
    fn a_read_row_carries_no_signing_material() {
        let json: Value = serde_json::to_value(EventSubscriptionResponse {
            event_subscription: subscription_dto(row()),
        })
        .expect("serialize");
        let row = &json["eventSubscription"];
        for forbidden in ["secret", "secretRef", "signingSecret"] {
            assert!(
                row.get(forbidden).is_none(),
                "the signing secret is answered once, by create: {json}"
            );
        }
        assert_eq!(row["createdAtMs"], 1_700_000_000_000_i64);
        assert!(
            row.get("disabledAtMs").is_none(),
            "an omitted null is the Swift contract; an emitted one is a change"
        );
    }

    /// Create is the only response on this surface with a `secret`, and it
    /// carries the version/algorithm a subscriber needs to verify with.
    ///
    /// The placeholder is deliberately NOT spelled like a real credential
    /// (`momo_evtsec_v1.<base64url>`): a key-shaped literal in a source file is
    /// what a secret scanner is built to flag, and a test that has to be
    /// allow-listed to stay green teaches everyone to allow-list. The assertion
    /// does not care what the string is — only that it round-trips.
    #[test]
    fn only_create_reveals_and_it_names_the_scheme() {
        const PLACEHOLDER: &str = "not-a-secret";
        let json: Value = serde_json::to_value(CreatedEventSubscriptionResponse {
            event_subscription: subscription_dto(row()),
            secret: PLACEHOLDER.into(),
            signature_version: SIGNATURE_VERSION,
            algorithm: ALGORITHM,
        })
        .expect("serialize");
        assert_eq!(json["secret"], PLACEHOLDER);
        assert_eq!(json["signatureVersion"], "v1");
        assert_eq!(json["algorithm"], "HMAC-SHA256");
    }

    /// A typo'd field must be a rejection. Silently ignoring `eventkinds` would
    /// leave a subscription sending something the admin believes they changed.
    #[test]
    fn an_unknown_field_is_refused_rather_than_ignored() {
        let error =
            serde_json::from_str::<UpdateEventSubscriptionRequest>(r#"{"eventkinds":["mention"]}"#)
                .expect_err("unknown field must not decode");
        assert!(error.to_string().contains("unknown field"), "{error}");

        assert!(serde_json::from_str::<CreateEventSubscriptionRequest>(
            r#"{"url":"https://x/y","eventKinds":["mention"],"channelId":"c"}"#
        )
        .is_err());
    }

    #[test]
    fn an_all_null_update_is_empty() {
        let empty: UpdateEventSubscriptionRequest = serde_json::from_str("{}").expect("decode");
        assert!(empty.is_empty());
        let one: UpdateEventSubscriptionRequest =
            serde_json::from_str(r#"{"enabled":false}"#).expect("decode");
        assert!(!one.is_empty());
    }

    /// Every refusal must reach the admin as a 400 they can act on — never a
    /// 500, and never the opaque "internal server error" an unmapped domain
    /// error would produce.
    #[test]
    fn every_destination_refusal_is_an_actionable_400() {
        for error in [
            OutboundUrlError::InvalidUrl,
            OutboundUrlError::InsecureHttp,
            OutboundUrlError::PrivateAddress,
            OutboundUrlError::ResolutionFailed,
        ] {
            let api = url_error(error);
            assert_eq!(api.status, StatusCode::BAD_REQUEST);
            assert!(!api.message.is_empty());
            assert_ne!(api.message, "internal server error");
        }
    }
}
