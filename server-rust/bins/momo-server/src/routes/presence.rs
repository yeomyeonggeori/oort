//! Declared presence status — the durable ③ surface of ADR-0160 (프레즌스 6b)
//! plus the ADR-0176 custom-status fields that ride the same PUT.
//!
//!   `GET /v1/workspaces/{ws}/presence`  — read the caller's own declared status
//!   `PUT /v1/workspaces/{ws}/presence`  — set it, single write path
//!
//! The availability(②) half is on the ephemeral rail
//! (`routes::ephemeral::availability`), and the connection(①) half is a
//! client-local fact that never reaches the server. This module owns only the
//! durable intent, changed **only** through REST→PG→`emit_outbox(Broadcast)`
//! →relay (invariant: single write path).
//!
//! **The client never names the status's owner.** Both routes bind it to the
//! authenticated principal — a request shape with a `memberId` in it is one
//! review slip from letting anyone set anyone else's status. `SetPresenceRequest`
//! has no owner field, and `set_declared_presence_in_tx` binds the actor.
//!
//! **Human only.** `require_human` guards both routes (프레즌스 사람 전용,
//! ADR-0160 D4); an agent bearer is refused a 403 before any read, exactly like
//! the typing surface. The read returns 404 for a member with no declared status
//! (an agent, or a soft-deleted row) rather than inventing `auto`.
//!
//! **Audit: none.** The original presence PUT wrote no `audit_log` row. Custom
//! status is the same personal intent, so ADR-0176 follows that convention.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    declared_presence_for, normalize_status_emoji, normalize_status_text,
    set_declared_presence_in_tx, status_expires_at_from_ms, CustomStatusPatch, DeclaredPresence,
    PresenceStatus, StatusPatch,
};

use crate::dto::{OptionalPatch, PresenceStatusResponse, SetPresenceRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Human-only, stated once. An agent's liveness is its `agent_run` (ADR-0160 D4).
const AGENTS_HAVE_NO_PRESENCE: &str =
    "presence is a human signal; an agent's liveness is its agent_run (ADR-0160)";

/// Parse the wire `status` into the sealed enum. A value the enum does not name
/// is a 400 with a sentence — the enum is the guard (ADR-0160 가드 4), and a
/// client learns which field was wrong rather than getting a serde reject.
fn parse_status(raw: &str) -> Result<PresenceStatus, ApiError> {
    PresenceStatus::from_db_label(raw)
        .ok_or_else(|| ApiError::bad_request("status must be one of: auto, away, dnd"))
}

fn presence_response(declared: DeclaredPresence) -> PresenceStatusResponse {
    PresenceStatusResponse {
        status: declared.status.as_db_label().to_string(),
        status_emoji: declared.custom.emoji,
        status_text: declared.custom.text,
        status_expires_at_ms: declared.custom.expires_at.map(|at| at.timestamp_millis()),
    }
}

fn parse_custom_patch(request: &SetPresenceRequest) -> Result<CustomStatusPatch, ApiError> {
    let mut patch = CustomStatusPatch::default();
    match &request.status_emoji {
        OptionalPatch::Absent => {}
        OptionalPatch::Set(value) => {
            patch.emoji = StatusPatch::Set(
                normalize_status_emoji(value.as_deref())
                    .map_err(|error| ApiError::bad_request(error.to_string()))?,
            );
        }
    }
    match &request.status_text {
        OptionalPatch::Absent => {}
        OptionalPatch::Set(value) => {
            patch.text = StatusPatch::Set(
                normalize_status_text(value.as_deref())
                    .map_err(|error| ApiError::bad_request(error.to_string()))?,
            );
        }
    }
    match &request.status_expires_at_ms {
        OptionalPatch::Absent => {}
        OptionalPatch::Set(None) => {
            patch.expires_at = StatusPatch::Set(None);
        }
        OptionalPatch::Set(Some(ms)) => {
            patch.expires_at = StatusPatch::Set(Some(
                status_expires_at_from_ms(*ms)
                    .map_err(|error| ApiError::bad_request(error.to_string()))?,
            ));
        }
    }
    Ok(patch)
}

/// `GET /v1/workspaces/{ws}/presence` — the caller's own durable declared status.
///
/// Availability and the effective dot are deliberately absent: the server does
/// not know whether the caller is connected, and the effective value is computed
/// at the render edge and never stored (ADR-0160 D3).
pub async fn get_presence(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<PresenceStatusResponse>, ApiError> {
    require_human(&principal, AGENTS_HAVE_NO_PRESENCE)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<DeclaredPresence> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match declared_presence_for(conn, member_id).await? {
                    Some(declared) => Ok(Ok(declared)),
                    // No declared status = not a live human member here. A 404
                    // (not a fabricated `auto`) so the client can tell "the
                    // server has no presence for me" from "I am set to auto".
                    None => Ok(Err(ApiError::not_found("no presence for this member"))),
                }
            })
        })
        .await;

    let declared = settle_db("presence.get", outcome)?;
    Ok(Json(presence_response(declared)))
}

/// `PUT /v1/workspaces/{ws}/presence` — set the caller's own declared status
/// (and optional custom status) and broadcast it to their co-members, in one
/// transaction (single write path, same `type: presence` rail).
pub async fn set_presence(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<SetPresenceRequest>,
) -> Result<Json<PresenceStatusResponse>, ApiError> {
    require_human(&principal, AGENTS_HAVE_NO_PRESENCE)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let status = parse_status(&request.status)?;
    let custom = parse_custom_patch(&request)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<DeclaredPresence> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match set_declared_presence_in_tx(conn, workspace_id, member_id, status, custom)
                    .await?
                {
                    Some(update) => Ok(Ok(DeclaredPresence {
                        status: update.status,
                        custom: update.custom,
                    })),
                    // Matched no live human member row — returned before any
                    // broadcast, so committing is indistinguishable from a
                    // rollback.
                    None => Ok(Err(ApiError::forbidden(
                        "not a live member of this workspace",
                    ))),
                }
            })
        })
        .await;

    let declared = settle_db("presence.set", outcome)?;
    Ok(Json(presence_response(declared)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use momo_messaging::CustomStatus;
    use serde_json::json;

    #[test]
    fn only_the_three_enum_labels_parse_and_the_rest_are_400() {
        assert_eq!(parse_status("auto").expect("auto"), PresenceStatus::Auto);
        assert_eq!(parse_status("away").expect("away"), PresenceStatus::Away);
        assert_eq!(parse_status("dnd").expect("dnd"), PresenceStatus::Dnd);
        // `active` is a lifecycle label, `online` is an effective value neither
        // of which this durable field stores.
        for bad in ["active", "online", "offline", "busy", ""] {
            assert_eq!(
                parse_status(bad).expect_err("rejected").status,
                StatusCode::BAD_REQUEST,
                "{bad} must not parse as a declared status"
            );
        }
    }

    #[test]
    fn a_status_only_body_does_not_touch_custom_fields() {
        let request: SetPresenceRequest =
            serde_json::from_value(json!({"status": "away"})).expect("legacy body");
        let patch = parse_custom_patch(&request).expect("ok");
        assert!(patch.is_absent(), "omitted keys must not patch");
    }

    #[test]
    fn explicit_nulls_clear_custom_status() {
        let request: SetPresenceRequest = serde_json::from_value(json!({
            "status": "auto",
            "statusEmoji": null,
            "statusText": null,
            "statusExpiresAtMs": null
        }))
        .expect("clear");
        let patch = parse_custom_patch(&request).expect("ok");
        assert_eq!(patch.emoji, StatusPatch::Set(None));
        assert_eq!(patch.text, StatusPatch::Set(None));
        assert_eq!(patch.expires_at, StatusPatch::Set(None));
    }

    #[test]
    fn text_over_80_is_400() {
        let request: SetPresenceRequest = serde_json::from_value(json!({
            "status": "auto",
            "statusText": "한".repeat(81)
        }))
        .expect("body");
        let error = parse_custom_patch(&request).expect_err("cap");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "statusText must be at most 80 characters");
    }

    #[test]
    fn response_omits_empty_custom_fields() {
        let json = serde_json::to_value(presence_response(DeclaredPresence {
            status: PresenceStatus::Auto,
            custom: CustomStatus::empty(),
        }))
        .expect("ser");
        assert_eq!(json["status"], "auto");
        assert!(json.get("statusEmoji").is_none(), "{json}");
        assert!(json.get("statusText").is_none(), "{json}");
        assert!(json.get("statusExpiresAtMs").is_none(), "{json}");
    }
}
