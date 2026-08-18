//! The workspace roster (B4.1).
//!
//!   `GET /v1/workspaces/{ws}/roster[?kind=&limit=]`
//!   `GET /v1/workspaces/{ws}/members`   (compat alias, same handler)
//!
//! Ports Swift `RosterRoutes` (`RosterRoutes.swift:17-70`). This is the
//! projection that turns an `author_member_id` into a name: without it the web
//! client's `useDirectory` falls back to an empty directory and every message,
//! mention and sidebar row is labelled with a uuid prefix
//! (`docs/planning/2026-08-01-b4-contract-diff.md` D-1). Nothing 404s — the
//! product simply stops saying who is talking, which is why this is the first
//! item in this batch rather than a nice-to-have.
//!
//! Two boundaries this module keeps:
//!   * **The guest narrowing is the query's, not a filter here.** `viewer_is_guest`
//!     is handed to `momo_messaging::list_workspace_roster`, which narrows the
//!     rows *and* the per-member channel counts/ids together. Post-filtering in
//!     Rust would leave the counts describing a workspace the guest cannot see.
//!   * **No BYPASSRLS, ever.** Cross-tenant inspection is a platform-admin
//!     surface; this one reads through the ordinary tenant transaction, which is
//!     also why the workspace-role check runs inside it.
//!
//! ## goal SRV-R2 — `paused` on the row
//!
//! An agent list could not draw pause state. The only reader of
//! `agent_profile.paused` was `GET …/agents/{agent}/profile`, which is an
//! owner/agent-owner gate — so a plain member's agent tab got a 403 per agent,
//! and even an owner's tab needed **one request per agent** to render a column.
//! The roster is the list that already exists, so the field goes on the row.
//!
//! It is not a new disclosure, which is why it needs no ADR: mentioning a
//! sleeping agent already posts a **public system line** in the channel saying it
//! is paused (`momo_agent::paused_mention_body`), so every channel member can
//! learn this today by typing an `@`. What stays behind the profile gate is the
//! rest — `instructions`, `enabled_tools`, `triggers` — which is why exactly one
//! boolean crossed the line and not an embedded profile object.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, clamp_roster_limit, list_workspace_roster, parse_roster_kind_filter,
    MemberKind, RosterMember, WorkspaceRole,
};

use crate::dto::{RosterMemberDto, RosterQuery, WorkspaceRosterResponse};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

impl RosterQuery {
    /// Swift reads `kind` first and `member_kind` as the alias.
    fn kind_raw(&self) -> Option<&str> {
        self.kind.as_deref().or(self.member_kind.as_deref())
    }

    fn limit(&self) -> i64 {
        clamp_roster_limit(self.limit.as_deref().and_then(|raw| raw.parse().ok()))
    }
}

fn roster_dto(member: &RosterMember) -> RosterMemberDto {
    RosterMemberDto {
        id: member.id.to_string(),
        workspace_id: member.workspace_id.to_string(),
        kind: member.kind.as_db_label().to_string(),
        status: member.status.clone(),
        display_name: member.display_name.clone(),
        handle: member.handle.clone(),
        avatar_url: member.avatar_url.clone(),
        role: member.role.map(|role| role.as_db_label().to_string()),
        channel_count: member.channel_count,
        channel_ids: member
            .channel_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>(),
        capabilities: member.capabilities.clone(),
        origin: member.origin.clone(),
        email: member.email.clone(),
        time_zone: member.time_zone.clone(),
        agent_model: member.agent_model.clone(),
        owner_human_id: member.owner_human_id.map(|id| id.to_string()),
        max_concurrent_runs: member.max_concurrent_runs,
        max_run_steps: member.max_run_steps,
        paused: member.paused,
        presence_status: member
            .presence_status
            .map(|status| status.as_db_label().to_string()),
        created_at_ms: member.created_at_ms,
        updated_at_ms: member.updated_at_ms,
    }
}

pub async fn roster(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<RosterQuery>,
) -> Result<Json<WorkspaceRosterResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // Refused before the transaction opens: an unparseable filter is a client
    // fault, and answering it with the full roster would silently widen the
    // question that was asked.
    let kind_filter = parse_roster_kind_filter(query.kind_raw())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let limit = query.limit();

    let outcome: DbRejectable<Vec<RosterMember>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) =
                    active_workspace_role(conn, workspace_id, principal.member_id).await?
                else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                let members = list_workspace_roster(
                    conn,
                    workspace_id,
                    principal.member_id,
                    role == WorkspaceRole::Guest,
                    kind_filter,
                    limit,
                )
                .await?;
                Ok(Ok(members))
            })
        })
        .await;

    let members = settle_db("roster.list", outcome)?;
    let human_count = members
        .iter()
        .filter(|member| member.kind == MemberKind::Human)
        .count();
    let agent_count = members
        .iter()
        .filter(|member| member.kind == MemberKind::Agent)
        .count();
    Ok(Json(WorkspaceRosterResponse {
        members: members.iter().map(roster_dto).collect(),
        human_count,
        agent_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::{PresenceStatus, ROSTER_LIMIT_DEFAULT, ROSTER_LIMIT_MAX};
    use uuid::Uuid;

    fn query(kind: Option<&str>, member_kind: Option<&str>, limit: Option<&str>) -> RosterQuery {
        RosterQuery {
            kind: kind.map(str::to_string),
            member_kind: member_kind.map(str::to_string),
            limit: limit.map(str::to_string),
        }
    }

    #[test]
    fn the_roster_limit_falls_back_rather_than_rejecting() {
        assert_eq!(query(None, None, None).limit(), ROSTER_LIMIT_DEFAULT);
        assert_eq!(
            query(None, None, Some("nope")).limit(),
            ROSTER_LIMIT_DEFAULT,
            "Swift's `Int($0) ?? 200` never 400s on a bad limit"
        );
        assert_eq!(query(None, None, Some("40")).limit(), 40);
        assert_eq!(query(None, None, Some("99999")).limit(), ROSTER_LIMIT_MAX);
    }

    #[test]
    fn both_kind_spellings_are_accepted_and_kind_wins() {
        assert_eq!(query(Some("agent"), None, None).kind_raw(), Some("agent"));
        assert_eq!(query(None, Some("human"), None).kind_raw(), Some("human"));
        assert_eq!(
            query(Some("agent"), Some("human"), None).kind_raw(),
            Some("agent"),
            "Swift reads `kind` first"
        );
    }

    fn member(kind: MemberKind) -> RosterMember {
        RosterMember {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            kind,
            status: "active".into(),
            display_name: "김인턴".into(),
            handle: "intern".into(),
            avatar_url: None,
            role: Some(WorkspaceRole::Member),
            channel_count: 2,
            channel_ids: vec![Uuid::from_u128(3), Uuid::from_u128(4)],
            capabilities: vec![],
            origin: (kind == MemberKind::Agent).then(|| "local".to_string()),
            email: None,
            time_zone: None,
            agent_model: None,
            owner_human_id: None,
            max_concurrent_runs: None,
            max_run_steps: None,
            // The query projects NULL for a human and a boolean for an agent
            // (`CASE WHEN m.kind = 'agent' …`), so the fixture mirrors that
            // rather than defaulting both kinds to the same thing.
            paused: (kind == MemberKind::Agent).then_some(false),
            // Presence is the mirror image: a human carries a declared status,
            // an agent carries NULL here (프레즌스 사람 전용, ADR-0160 D4).
            presence_status: (kind == MemberKind::Human).then_some(PresenceStatus::Auto),
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_001,
        }
    }

    /// The web client drops any roster row that fails `isRosterMember`
    /// (`lib/api.ts:91-108`). Every key that validator requires must therefore
    /// be present even when it is empty — an omitted `capabilities: []` deletes
    /// the member from the timeline's name table instead of showing them with no
    /// capabilities.
    #[test]
    fn an_empty_agent_row_still_carries_every_key_the_client_validates() {
        let json = serde_json::to_value(roster_dto(&member(MemberKind::Agent))).expect("serialize");
        for required in [
            "id",
            "workspaceId",
            "kind",
            "status",
            "displayName",
            "handle",
            "channelCount",
            "channelIds",
            "capabilities",
            "createdAtMs",
            "updatedAtMs",
        ] {
            assert!(
                json.get(required).is_some(),
                "`{required}` is required by isRosterMember: {json}"
            );
        }
        assert_eq!(json["kind"], "agent");
        assert_eq!(json["origin"], "local");
        assert_eq!(json["capabilities"].as_array().expect("array").len(), 0);
        assert_eq!(json["channelIds"].as_array().expect("array").len(), 2);
        // Null optionals are omitted, matching Swift's `encodeIfPresent`.
        assert!(json.get("avatarUrl").is_none(), "{json}");
        assert!(json.get("email").is_none(), "{json}");
        assert!(json.get("ownerHumanId").is_none(), "{json}");
    }

    /// A human row must never grow an agent's origin label: the sidebar splits
    /// people from agents on `kind`, and `origin` is what the agent hub reads to
    /// say where an agent came from.
    #[test]
    fn a_human_row_carries_no_agent_origin() {
        let json = serde_json::to_value(roster_dto(&member(MemberKind::Human))).expect("serialize");
        assert_eq!(json["kind"], "human");
        assert!(json.get("origin").is_none(), "{json}");
        assert_eq!(json["role"], "member");
    }

    /// ADR-0160 D4: 프레즌스 is 사람 전용. A human row carries `presenceStatus`,
    /// an agent row omits it entirely — the exact mirror of how `paused` is
    /// agent-only. A booting client reads a co-member's declared status from this
    /// field without a second request.
    #[test]
    fn only_a_human_row_reports_presence_status() {
        let human =
            serde_json::to_value(roster_dto(&member(MemberKind::Human))).expect("serialize");
        assert_eq!(
            human["presenceStatus"],
            serde_json::json!("auto"),
            "a person carries their declared status: {human}"
        );

        let mut away = member(MemberKind::Human);
        away.presence_status = Some(PresenceStatus::Away);
        let away = serde_json::to_value(roster_dto(&away)).expect("serialize");
        assert_eq!(away["presenceStatus"], serde_json::json!("away"));

        let agent =
            serde_json::to_value(roster_dto(&member(MemberKind::Agent))).expect("serialize");
        assert!(
            agent.get("presenceStatus").is_none(),
            "an agent has no declared presence, its liveness is agent_run: {agent}"
        );
    }

    /// goal SRV-R2: an agent row always carries `paused`, **including when it is
    /// `false`**, and a human row never does.
    ///
    /// The `false` case is the load-bearing one. A list that draws a sleep badge
    /// has to tell "this agent is awake" apart from "this server does not report
    /// pause state", and `skip_serializing_if` on a plain `bool` would have
    /// collapsed the two — leaving a paused agent looking awake on any row whose
    /// profile happened to be default.
    #[test]
    fn only_an_agent_row_reports_paused_and_it_reports_false_too() {
        let awake =
            serde_json::to_value(roster_dto(&member(MemberKind::Agent))).expect("serialize");
        assert_eq!(
            awake["paused"],
            serde_json::json!(false),
            "an awake agent says so explicitly, rather than omitting the key: {awake}"
        );

        let mut asleep = member(MemberKind::Agent);
        asleep.paused = Some(true);
        let asleep = serde_json::to_value(roster_dto(&asleep)).expect("serialize");
        assert_eq!(asleep["paused"], serde_json::json!(true));

        let human =
            serde_json::to_value(roster_dto(&member(MemberKind::Human))).expect("serialize");
        assert!(
            human.get("paused").is_none(),
            "a person is not a thing that can be paused: {human}"
        );
    }
}
