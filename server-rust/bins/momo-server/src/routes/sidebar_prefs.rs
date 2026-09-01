//! 사이드바 섹션 (ADR-0177 / #1932 BT-4) — the member's own sidebar organization.
//!
//! ```text
//! GET|PUT /v1/workspaces/{ws}/members/me/sidebar-prefs
//! ```
//!
//! Custom sections, which channels the member placed in each, and their starred
//! channels — one JSONB blob per (workspace, member), migration 084. ADR-0177 D1
//! makes this **personal**: there is no workspace-shared section in v1, and no
//! spelling of this API reaches another member's row. `/members/me` is the whole
//! path; the member id is the credential's, exactly like `notification-rules`
//! and `members/me/password`.
//!
//! Three decisions worth naming here, because a reader will look for them:
//!
//! * **Human-only, twice over (ADR-0177 D3).** An agent has no sidebar, so an
//!   agent bearer must never reach here. The *primary* gate is absence: this
//!   path is not in `momo_auth::required_agent_scope`, and a path that table
//!   does not name is a path no agent credential opens — the middleware answers
//!   403 before routing. `require_human` below is the second layer, and it is
//!   not redundant: it also refuses the non-agent, non-human principals (a
//!   signed work host) that the scope table has no opinion about. Mutation
//!   testing bears this out — removing `require_human` alone leaves the agent
//!   403 intact; it takes opening the scope table *as well* to turn it into a
//!   200 (see `sidebar_prefs_conformance_pg`).
//! * **Channel membership is not verified.** A `PUT` naming a channel the member
//!   has left, or one that was deleted, is stored as sent. ADR-0177 D3 calls this
//!   the tolerant contract: the alternative turns every archive/leave race into a
//!   400 on an unrelated save, and the client already filters dead ids at render
//!   time because it renders from the live channel list.
//! * **No outbox row (ADR-0177 D2).** This handler emits no event. The writing
//!   device already holds the new state; other devices converge on their next
//!   bootstrap `GET`. #1888's reminders set the same precedent.
//!
//! Client: `clients/web/src/features/sidebar/` via
//! `packages/momo-core/src/features/sidebar/sidebarSections.ts`.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_messaging::{
    get_sidebar_prefs_in_tx, set_sidebar_prefs_in_tx, validate_sidebar_prefs, StoredSidebarPrefs,
};

use crate::dto::{SidebarPrefsResponse, UpdateSidebarPrefsRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "sidebar prefs require a human bearer";
const MEMBERSHIP_REQUIRED: &str = "active human membership required";

fn prefs_response(stored: StoredSidebarPrefs) -> SidebarPrefsResponse {
    SidebarPrefsResponse {
        prefs: stored.prefs,
        updated_at_ms: stored.updated_at_ms,
    }
}

/// `GET /v1/workspaces/{ws}/members/me/sidebar-prefs` — the caller's own layout.
///
/// A member who has never saved reads the empty v1 default, not a 404: "no row
/// yet" and "every section deleted" are the same sidebar, and giving the client
/// one code path for both is what keeps the bootstrap from branching.
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<SidebarPrefsResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<StoredSidebarPrefs> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden(MEMBERSHIP_REQUIRED)));
                }
                Ok(Ok(
                    get_sidebar_prefs_in_tx(conn, workspace_id, member_id).await?
                ))
            })
        })
        .await;

    let stored = settle_db("sidebar_prefs.get", outcome)?;
    Ok(Json(prefs_response(stored)))
}

/// `PUT /v1/workspaces/{ws}/members/me/sidebar-prefs` — replace the layout.
///
/// The body is the whole structure, so this is a replace, not a patch: the
/// client holds the full arrangement in memory and a partial write would need a
/// merge rule the blob has no room to express. Validation is shape and size only
/// (ADR-0177 D3) and runs **before** the transaction opens — a 400 must not cost
/// a connection.
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<UpdateSidebarPrefsRequest>,
) -> Result<Json<SidebarPrefsResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let prefs = validate_sidebar_prefs(request.prefs)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    let outcome: DbRejectable<StoredSidebarPrefs> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden(MEMBERSHIP_REQUIRED)));
                }
                Ok(Ok(set_sidebar_prefs_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &prefs,
                )
                .await?))
            })
        })
        .await;

    // No audit row: unlike `notification_rule.updated`, rearranging one's own
    // sidebar changes nothing another member or an operator can observe. An audit
    // entry per drag would be noise in the ledger operators read for security.
    let stored = settle_db("sidebar_prefs.put", outcome)?;
    Ok(Json(prefs_response(stored)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::{SidebarPrefs, SidebarSection};

    #[test]
    fn a_never_saved_member_reads_an_empty_v1_payload_without_a_timestamp() {
        let json =
            serde_json::to_value(prefs_response(StoredSidebarPrefs::default())).expect("serialize");
        assert_eq!(json["prefs"]["version"], 1);
        assert_eq!(json["prefs"]["sections"].as_array().unwrap().len(), 0);
        assert_eq!(
            json["prefs"]["starredChannelIds"].as_array().unwrap().len(),
            0
        );
        assert!(
            json.get("updatedAtMs").is_none(),
            "an absent optional is omitted, never null (Swift encodeIfPresent parity)"
        );
    }

    #[test]
    fn a_stored_payload_answers_in_camel_case_with_its_timestamp() {
        let json = serde_json::to_value(prefs_response(StoredSidebarPrefs {
            prefs: SidebarPrefs {
                version: 1,
                sections: vec![SidebarSection {
                    id: "s1".into(),
                    name: "긴급 대응".into(),
                    order: 3,
                    channel_ids: vec!["11111111-1111-4111-8111-111111111111".into()],
                }],
                starred_channel_ids: vec!["22222222-2222-4222-8222-222222222222".into()],
                section_sort: Some("manual".into()),
            },
            updated_at_ms: Some(1_756_000_000_000),
        }))
        .expect("serialize");
        assert_eq!(json["prefs"]["sections"][0]["name"], "긴급 대응");
        assert_eq!(json["prefs"]["sections"][0]["order"], 3);
        assert_eq!(
            json["prefs"]["sections"][0]["channelIds"][0],
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(json["prefs"]["sectionSort"], "manual");
        assert_eq!(json["updatedAtMs"], 1_756_000_000_000i64);
    }

    /// The response is handed straight back on the next save, so the request DTO
    /// has to accept exactly what the response emits.
    #[test]
    fn a_response_body_parses_back_as_a_request() {
        let response = serde_json::to_value(prefs_response(StoredSidebarPrefs {
            prefs: SidebarPrefs {
                version: 1,
                sections: vec![SidebarSection {
                    id: "s1".into(),
                    name: "작업".into(),
                    order: 0,
                    channel_ids: vec![],
                }],
                starred_channel_ids: vec![],
                section_sort: None,
            },
            updated_at_ms: Some(42),
        }))
        .expect("serialize");
        let parsed: UpdateSidebarPrefsRequest =
            serde_json::from_value(serde_json::json!({"prefs": response["prefs"]}))
                .expect("the response payload is a legal request payload");
        assert_eq!(parsed.prefs.sections[0].id, "s1");
    }

    /// ADR-0177 D4 — collapse state stays on the device. A client that tried to
    /// roam it must be told, not silently ignored.
    #[test]
    fn the_request_refuses_fields_the_contract_does_not_own() {
        assert!(
            serde_json::from_value::<UpdateSidebarPrefsRequest>(serde_json::json!({
                "prefs": {"version": 1, "sections": [], "starredChannelIds": []},
                "collapsedSectionIds": ["channels"]
            }))
            .is_err()
        );
    }
}
