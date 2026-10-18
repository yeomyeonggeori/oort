//! 「앱 실행 장소」 표시 켜기·끄기 (#3938 C-S2, ADR-0113 증보 2 E3).
//!
//! ```text
//! PUT /v1/workspaces/{ws}/agents/{agent}/connector-owner   {"enabled": true|false}
//! ```
//!
//! An agent that runs its owner's connected apps (Gmail, Drive, ...) must be
//! called by that owner only, or the owner's grants are spent on someone else's
//! request. The mark `agent.connector_owner_human_id` is what the delivery paths
//! read (mention, DM, work request, inbox fan-out, A2A); this route is the only
//! writer.
//!
//! ## Rules this module holds
//!
//! 1. **The agent's owner, in both directions.** The caller must be a person and
//!    `agent.owner_human_id`. A workspace admin, another member, an agent or a
//!    work host is refused (`403`) when turning the mark on **or off**; an agent
//!    with no owner can never be marked. The database holds the same line
//!    (`agent_connector_owner_is_owner`, migration 139).
//! 2. **The stored value is the owner, never the body.** The body is a boolean
//!    only (`deny_unknown_fields`): there is no way to name some other human.
//! 3. **Off is immediate.** The next trigger reads the cleared column. Nothing
//!    queued is rewritten here: a job already written was delivered to the owner.
//! 4. **Idempotent.** Repeating the same value is a `200` with no second audit
//!    row.
//! 5. **Not for the co-hosted Hermes (#3948).** An agent pinned to the operator's
//!    own env link runs one person's apps on a runtime with no per-person token
//!    isolation, so it is marked only through the 「커넥터 시험」 route
//!    (`PUT …/connector-trial`: operator, one person, attestations, grants).
//!    Turning the mark **on** here is a `409 connector_trial_route_required`;
//!    turning it off stays open to the owner.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::{set_connector_owner_in_tx, ConnectorOwnerChange};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

const SCHEMA: &str = "momo.agent.connector_owner.v0";
const AUDIT_SCHEMA: &str = "momo.agent_connector_owner.audit.v0";
const AUDIT_ACTION: &str = "agent.connector_owner.updated";

/// `PUT` body. Closed: the only thing a caller chooses is on or off.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutConnectorOwnerRequest {
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorOwnerResponse {
    pub schema: &'static str,
    pub agent_id: String,
    pub enabled: bool,
}

/// `PUT /v1/workspaces/{ws}/agents/{agent}/connector-owner`.
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<PutConnectorOwnerRequest>,
) -> Result<Json<ConnectorOwnerResponse>, ApiError> {
    require_human(&principal, "only the agent's owner can change this")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let enabled = request.enabled;

    settle_db(
        "agent_connector_owner.put",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if enabled
                    && momo_agent::agent_is_operator_env_pinned_in_tx(
                        conn,
                        workspace_id,
                        agent_member_id,
                    )
                    .await?
                {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "connector_trial_route_required",
                        "the co-hosted agent is marked through the connector trial route only",
                    )));
                }
                let before =
                    momo_agent::agent_connector_owner_in_tx(conn, workspace_id, agent_member_id)
                        .await?
                        .is_some();
                match set_connector_owner_in_tx(conn, workspace_id, agent_member_id, actor, enabled)
                    .await?
                {
                    ConnectorOwnerChange::NoSuchAgent => {
                        Ok(Err(ApiError::not_found("active agent not found")))
                    }
                    ConnectorOwnerChange::NotOwner => Ok(Err(ApiError::forbidden(
                        "only the agent's owner can change this",
                    ))),
                    ConnectorOwnerChange::Applied { enabled } => {
                        if before != enabled {
                            write_audit(
                                conn,
                                &AuditEntry::new(workspace_id, AUDIT_ACTION)
                                    .by(actor)
                                    .about(agent_member_id)
                                    .target("agent", agent_member_id)
                                    .via_token(via_token)
                                    .with_schema(AUDIT_SCHEMA, json!({ "enabled": enabled })),
                            )
                            .await?;
                        }
                        Ok(Ok(()))
                    }
                }
            })
        })
        .await,
    )?;

    Ok(Json(ConnectorOwnerResponse {
        schema: SCHEMA,
        agent_id: agent_member_id.to_string(),
        enabled,
    }))
}
