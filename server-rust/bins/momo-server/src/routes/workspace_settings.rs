//! Workspace shared-settings bag (#1800).
//!
//! ```text
//! GET|PATCH  /v1/workspaces/{ws}/settings          owner/admin
//! ```
//!
//! The bag is operator-only. Members who need one key get a derived projection
//! (`allowed-models`, and `WorkspaceDto.roleLabels` on `GET /v1/workspaces/{ws}`).
//! That identity GET still must not grow a `settings` field.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::is_active_agent_in_tx;
use momo_agent::team_ai_roles::TeamAiRoles;
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    merge_workspace_settings, read_workspace_settings, read_workspace_settings_for_update,
    write_workspace_settings, WorkspaceSettingsInvalid, TEAM_AI_LIMITS_SETTING,
    TEAM_AI_LIMIT_MONTHLY_USD, TEAM_AI_ROLES_SETTING,
};
use momo_workspace_actions::team_ai::TeamAiWorkspace;
use momo_workspace_actions::team_ai_limits::{
    limits_status_in_tx, monthly_usd_availability_in_tx, OperatorCaps, UsdAvailability,
};
use momo_workspace_actions::team_ai_roles::{
    changed_keys, memory_prerequisite_in_tx, roles_changed_audit,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, require_workspace_operator, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

fn rejection(error: WorkspaceSettingsInvalid) -> ApiError {
    if error.is_payload_too_large() {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, error.to_string())
    } else {
        ApiError::bad_request(error.to_string())
    }
}

fn as_object(settings: Option<Value>) -> Value {
    match settings {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    }
}

/// `?include=` on the settings GET and PATCH. The bag stays exactly what is stored unless the
/// caller asks for a computed addition by name — a workspace that never wrote a key still reads
/// `{}`, and no client that round-trips the bag meets a field it did not ask for.
#[derive(Debug, Default, serde::Deserialize)]
pub struct SettingsQuery {
    include: Option<String>,
}

/// The one computed addition: the team AI's limits as the settings screen reads them
/// (ADR-0201 증보 v3 B9-4, #4944).
const INCLUDE_LIMITS_STATUS: &str = "team_ai_limits_status";

fn wants_limits_status(query: &SettingsQuery) -> Result<bool, ApiError> {
    match query.include.as_deref() {
        None => Ok(false),
        Some(INCLUDE_LIMITS_STATUS) => Ok(true),
        Some(other) => Err(ApiError::bad_request(format!(
            "unknown include: {other} (the only one is {INCLUDE_LIMITS_STATUS})"
        ))),
    }
}

/// Add the computed `team_ai_limits_status` to a bag that is about to be returned. Computed in the
/// request's own transaction, from the ledger and the operator's ceilings; never stored, and not a
/// PATCH-able key.
async fn with_limits_status(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    caps: &OperatorCaps,
    mut bag: Value,
) -> Result<Value, momo_db::DbError> {
    let status = limits_status_in_tx(conn, workspace_id, caps).await?;
    if let Value::Object(map) = &mut bag {
        map.insert(INCLUDE_LIMITS_STATUS.to_string(), status);
    }
    Ok(bag)
}

/// ADR-0201 증보 v3 B9-2: a monthly dollar limit is a promise the server can only keep if it can
/// price what the helper spends. Refused (400, nothing written) while the helper's last request ran
/// on a model with no public price on file, or before it has answered anything — a token limit is
/// always available. The messages are for a developer; the screen words its own.
fn usd_limit_unavailable(availability: UsdAvailability) -> Option<ApiError> {
    let message = match availability {
        UsdAvailability::Available => return None,
        UsdAvailability::ModelUnpriced => {
            "the team AI's model has no public price on file, so a monthly dollar limit cannot be \
             measured; set a token limit instead"
        }
        UsdAvailability::NoUsageYet => {
            "the team AI has not answered anything yet, so the price of its model is not known; \
             set the monthly dollar limit after its first answer, or set a token limit now"
        }
    };
    Some(ApiError::coded(
        StatusCode::BAD_REQUEST,
        "team_ai_usd_limit_unavailable",
        message,
    ))
}

/// `GET /v1/workspaces/{ws}/settings`
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<SettingsQuery>,
) -> Result<Json<Value>, ApiError> {
    require_human(&principal, "workspace settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let include_status = wants_limits_status(&query)?;
    let caps = state.team_ai_caps;
    let outcome: DbRejectable<Value> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match read_workspace_settings(conn, workspace_id).await? {
                Some(settings) => {
                    let bag = as_object(Some(settings));
                    if include_status {
                        Ok(Ok(with_limits_status(conn, workspace_id, &caps, bag).await?))
                    } else {
                        Ok(Ok(bag))
                    }
                }
                None => Ok(Err(ApiError::not_found("workspace not found"))),
            }
        })
    })
    .await;
    Ok(Json(settle_db("workspace.settings.get", outcome)?))
}

/// `PATCH /v1/workspaces/{ws}/settings`
pub async fn patch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<SettingsQuery>,
    Json(request): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_human(&principal, "workspace settings require a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_workspace_operator(&state, &principal, workspace_id).await?;
    let include_status = wants_limits_status(&query)?;
    let caps = state.team_ai_caps;
    let member_id = principal.member_id;
    let via = audit_via_token_id(&principal);
    let patch_keys: Vec<String> = request
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    let outcome: DbRejectable<Value> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let existing = match read_workspace_settings_for_update(conn, workspace_id).await? {
                Some(settings) => as_object(Some(settings)),
                None => return Ok(Err(ApiError::not_found("workspace not found"))),
            };
            let merged = match merge_workspace_settings(&existing, &request) {
                Ok(merged) => merged,
                Err(error) => return Ok(Err(rejection(error))),
            };
            // ADR-0201 증보 v3 B9-2 (#4944): a monthly dollar limit named by this patch needs a
            // price the server can measure by. Judged before anything is written.
            let names_usd_limit = request
                .get(TEAM_AI_LIMITS_SETTING)
                .and_then(Value::as_object)
                .and_then(|limits| limits.get(TEAM_AI_LIMIT_MONTHLY_USD))
                .is_some_and(|usd| !usd.is_null());
            if names_usd_limit {
                let helper = TeamAiWorkspace::from_settings(&existing).member_id;
                let availability =
                    monthly_usd_availability_in_tx(conn, workspace_id, helper).await?;
                if let Some(refusal) = usd_limit_unavailable(availability) {
                    return Ok(Err(refusal));
                }
            }
            // ADR-0201 증보 v3 B3: the helper's role switches. Turning `memory` on while team
            // memory is switched off is a 409 — judged on the *effective* change, so a screen
            // that sends all six fields on every save is not stopped by one it did not change.
            let roles_before = TeamAiRoles::from_settings(&existing);
            let roles_after = TeamAiRoles::from_settings(&merged);
            let roles_touched = request.get(TEAM_AI_ROLES_SETTING).is_some();
            if roles_touched
                && !memory_prerequisite_in_tx(conn, member_id, &roles_before, &roles_after).await?
            {
                return Ok(Err(ApiError::coded(
                    StatusCode::CONFLICT,
                    "team_memory_off",
                    "team memory is switched off; turn it on before turning the memory role on",
                )));
            }
            if let Some(Value::String(raw_id)) = request.get("welcome_agent_member_id") {
                let parsed = match Uuid::parse_str(raw_id) {
                    Ok(id) => id,
                    Err(_) => {
                        return Ok(Err(ApiError::bad_request(
                            "welcome_agent_member_id must be a uuid",
                        )))
                    }
                };
                if !is_active_agent_in_tx(conn, workspace_id, parsed).await? {
                    return Ok(Err(ApiError::bad_request(
                        "welcome_agent_member_id is not an active agent",
                    )));
                }
            }
            let Some(mut stored) = write_workspace_settings(conn, workspace_id, &merged).await?
            else {
                return Ok(Err(ApiError::not_found("workspace not found")));
            };
            // What was just written is audited NOW, before anything below can answer with a
            // refusal: a handled refusal COMMITS (the provisioning block says so), so an audit
            // that waited for the success path would be missing from exactly the commits that
            // need one. Every commit this handler can make carries these rows.
            //
            // The switches that actually moved, by name (never a value): one row per write.
            if roles_touched {
                let moved = changed_keys(&roles_before, &roles_after);
                if !moved.is_empty() {
                    write_audit(
                        conn,
                        &roles_changed_audit(workspace_id, member_id, via, &moved, None),
                    )
                    .await?;
                }
            }
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "workspace_setting.updated")
                    .by(member_id)
                    .via_token(via)
                    .with_schema(
                        "momo.workspace_setting.updated.v1",
                        json!({ "keys": patch_keys }),
                    ),
            )
            .await?;
            // ADR-0201 D8: the switch also provisions (or pauses) the team AI member.
            // Same transaction: a switch that says "on" with no member behind it
            // cannot commit.
            if let Some(switch) = request.get("team_ai_fast_path") {
                // `null` deletes the key, which means off; only `true` provisions.
                if switch.as_bool() == Some(true) {
                    match momo_workspace_actions::team_ai::enable_in_tx(
                        conn,
                        workspace_id,
                        member_id,
                    )
                    .await
                    {
                        Ok(_) => {}
                        Err(error) => {
                            tracing::warn!(error = %error, "team ai could not be enabled");
                            // A handled refusal COMMITS; take the switch back out so
                            // "on" never stands without a member behind it.
                            momo_workspace_actions::team_ai::disable_in_tx(
                                conn,
                                workspace_id,
                                member_id,
                            )
                            .await?;
                            return Ok(Err(ApiError::coded(
                                axum::http::StatusCode::CONFLICT,
                                "team_ai_unavailable",
                                "the 'oort-helper' handle is taken; rename that agent first",
                            )));
                        }
                    }
                } else {
                    momo_workspace_actions::team_ai::disable_in_tx(conn, workspace_id, member_id)
                        .await?;
                }
                stored = read_workspace_settings(conn, workspace_id)
                    .await?
                    .unwrap_or(stored);
            }
            let bag = as_object(Some(stored));
            if include_status {
                Ok(Ok(with_limits_status(conn, workspace_id, &caps, bag).await?))
            } else {
                Ok(Ok(bag))
            }
        })
    })
    .await;
    Ok(Json(settle_db("workspace.settings.patch", outcome)?))
}
