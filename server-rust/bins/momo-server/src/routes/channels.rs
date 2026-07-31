//! The workspace channel list (B4).
//!
//!   `GET /v1/workspaces/{ws}/channels[?limit=&include_archived=]`
//!
//! Ports Swift `ChannelRoutes.list` (`ChannelRoutes.swift:41-73`). This is the
//! **first call a signed-in client makes after login** — `useChannels`
//! (`clients/web/src/features/workspace/useWorkspace.ts:85-98`) feeds the whole
//! sidebar from it, and without it the web client lands in a workspace with no
//! way into a conversation. That is why it is in this batch and channel
//! *creation* is not: the read is on the dogfooding path, the write is not.
//!
//! Two boundaries this module keeps:
//!   * **membership is the query, not a filter applied afterwards.** The SQL
//!     (`momo_messaging::list_workspace_channels`) inner-joins the caller's live
//!     `membership`, so there is no branch here that could return a channel the
//!     caller has left. The workspace-role check in front of it is Swift's 403
//!     for someone who is not in the workspace at all.
//!   * **`muted` is the caller's own preference** (`notification_pref`,
//!     ADR-0124), not a channel attribute. It travels per row because the
//!     sidebar draws it per row; it must never be read as "this channel is
//!     muted for everyone".
//!
//! Deliberately absent: `POST /v1/workspaces/{ws}/channels`. It is a real client
//! surface (`api.ts createChannel`) and it is recorded as an open gap in
//! `docs/planning/2026-08-01-b4-contract-diff.md` — creating a channel is not on
//! the boot → channel → message path this batch had to unblock.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, clamp_channel_list_limit, list_workspace_channels, ChannelSummary,
};
use serde::Deserialize;

use crate::dto::{ChannelDto, WorkspaceChannelsResponse};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

/// `GET …/channels` query string. Parsed leniently like `HistoryQuery`: a
/// garbage `limit` falls back to the default rather than 400-ing, matching
/// Swift's `Int($0) ?? 200`.
#[derive(Debug, Deserialize)]
pub struct ChannelListQuery {
    #[serde(default)]
    pub limit: Option<String>,
    /// Swift accepts both spellings (`ChannelRoutes.swift:45-46`).
    #[serde(default)]
    pub include_archived: Option<String>,
    #[serde(default, rename = "includeArchived")]
    pub include_archived_camel: Option<String>,
}

impl ChannelListQuery {
    fn limit(&self) -> i64 {
        clamp_channel_list_limit(self.limit.as_deref().and_then(|raw| raw.parse().ok()))
    }

    /// Swift compares against the literal `"true"` and nothing else, so `1`/`yes`
    /// are NOT archived-inclusive here either — a client that means it says so.
    fn include_archived(&self) -> bool {
        self.include_archived.as_deref() == Some("true")
            || self.include_archived_camel.as_deref() == Some("true")
    }
}

fn channel_dto(channel: &ChannelSummary) -> ChannelDto {
    ChannelDto {
        id: channel.id.to_string(),
        workspace_id: channel.workspace_id.to_string(),
        kind: channel.kind.as_db_label().to_string(),
        name: channel.name.clone(),
        topic: channel.topic.clone(),
        dm_key: channel.dm_key.clone(),
        // Swift emits `[]` for a non-DM rather than omitting the key; the client
        // reads `memberIds ?? []` either way, and an empty array is the honest
        // rendering of "this projection does not carry a roster".
        member_ids: Some(
            channel
                .member_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>(),
        ),
        created_by: channel.created_by.map(|id| id.to_string()),
        archived_at_ms: channel.archived_at_ms,
        muted: channel.muted,
    }
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ChannelListQuery>,
) -> Result<Json<WorkspaceChannelsResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let limit = query.limit();
    let include_archived = query.include_archived();

    let outcome: DbRejectable<Vec<ChannelSummary>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                let channels = list_workspace_channels(
                    conn,
                    workspace_id,
                    principal.member_id,
                    include_archived,
                    limit,
                )
                .await?;
                Ok(Ok(channels))
            })
        })
        .await;

    let channels = settle_db("channels.list", outcome)?;
    Ok(Json(WorkspaceChannelsResponse {
        channels: channels.iter().map(channel_dto).collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::{ChannelKind, CHANNEL_LIST_LIMIT_DEFAULT, CHANNEL_LIST_LIMIT_MAX};
    use uuid::Uuid;

    fn query(limit: Option<&str>, archived: Option<&str>) -> ChannelListQuery {
        ChannelListQuery {
            limit: limit.map(str::to_string),
            include_archived: archived.map(str::to_string),
            include_archived_camel: None,
        }
    }

    #[test]
    fn the_limit_falls_back_rather_than_rejecting() {
        assert_eq!(query(None, None).limit(), CHANNEL_LIST_LIMIT_DEFAULT);
        assert_eq!(
            query(Some("nope"), None).limit(),
            CHANNEL_LIST_LIMIT_DEFAULT
        );
        assert_eq!(query(Some("25"), None).limit(), 25);
        assert_eq!(query(Some("9999"), None).limit(), CHANNEL_LIST_LIMIT_MAX);
    }

    #[test]
    fn archived_channels_stay_out_unless_asked_for_by_name() {
        assert!(!query(None, None).include_archived());
        assert!(!query(None, Some("1")).include_archived());
        assert!(query(None, Some("true")).include_archived());
        let camel = ChannelListQuery {
            limit: None,
            include_archived: None,
            include_archived_camel: Some("true".to_string()),
        };
        assert!(camel.include_archived(), "Swift accepts both spellings");
    }

    /// A public channel must not grow a roster it did not fetch, and a live
    /// channel must not carry an `archivedAtMs`. Both are fields the sidebar
    /// branches on.
    #[test]
    fn a_public_channel_carries_no_roster_and_no_archive_stamp() {
        let summary = ChannelSummary {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            kind: ChannelKind::Public,
            name: Some("general".into()),
            topic: None,
            dm_key: None,
            member_ids: vec![],
            created_by: Some(Uuid::from_u128(3)),
            archived_at_ms: None,
            muted: false,
        };
        let json = serde_json::to_value(channel_dto(&summary)).expect("serialize");
        assert_eq!(json["kind"], "public");
        assert_eq!(json["name"], "general");
        assert_eq!(json["memberIds"].as_array().expect("array").len(), 0);
        assert_eq!(json["muted"], false);
        assert!(json.get("topic").is_none(), "null optionals are omitted");
        assert!(json.get("dmKey").is_none());
        assert!(
            json.get("archivedAtMs").is_none(),
            "the web sidebar filters on `archivedAtMs === undefined`: {json}"
        );
    }

    #[test]
    fn a_dm_row_carries_its_pair_and_key() {
        let summary = ChannelSummary {
            id: Uuid::from_u128(4),
            workspace_id: Uuid::from_u128(2),
            kind: ChannelKind::Dm,
            name: None,
            topic: None,
            dm_key: Some("deadbeef".into()),
            member_ids: vec![Uuid::from_u128(5), Uuid::from_u128(6)],
            created_by: None,
            archived_at_ms: None,
            muted: true,
        };
        let json = serde_json::to_value(channel_dto(&summary)).expect("serialize");
        assert_eq!(json["kind"], "dm");
        assert_eq!(json["dmKey"], "deadbeef");
        assert_eq!(json["memberIds"].as_array().expect("array").len(), 2);
        assert_eq!(json["muted"], true);
    }
}
