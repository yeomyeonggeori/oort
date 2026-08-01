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
//! **B4.1** adds the two writes beside the read:
//!   * `POST /v1/workspaces/{ws}/channels` — the D-7 gap. Until it existed a
//!     dogfooding workspace could never grow past its seeded channels, which is
//!     the point at which internal use stops being use.
//!   * `PUT …/channels/{ch}/notification-pref` — the write half of the `muted`
//!     flag every row above already reports. A read-only `muted` is a setting
//!     that can be shown and never changed.
//!
//! **B5.3a** adds the membership pair, and it is the hinge of agent onboarding
//! rather than a CRUD convenience:
//!   * `POST …/channels/{ch}/members` — an agent created by `POST …/agents` is a
//!     workspace member with no room to speak in; this is what makes an
//!     `@handle` resolve to a run instead of an audited
//!     `agent_not_channel_member` no-op.
//!   * `DELETE …/channels/{ch}/members/{member}` — the local, silent counterpart
//!     to the workspace-wide `pause` switch.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, add_channel_member_in_tx, clamp_channel_list_limit,
    create_channel_detailed_in_tx, list_workspace_channels, normalize_channel_kind,
    normalize_channel_name, normalize_channel_topic, normalize_membership_role,
    remove_channel_member_in_tx, set_notification_pref_in_tx, ChannelMembership, ChannelSummary,
    CreatedChannel, NewChannel,
};
use serde::Deserialize;

use crate::dto::{
    AddChannelMemberRequest, ChannelDto, ChannelMembershipDto, ChannelMembershipResponse,
    CreateChannelRequest, CreateChannelResponse, NotificationPrefResponse,
    UpdateNotificationPrefRequest, WorkspaceChannelsResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, settle_db, workspace_scope, DbRejectable,
};
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

fn membership_dto(membership: &ChannelMembership) -> ChannelMembershipDto {
    ChannelMembershipDto {
        id: membership.id.to_string(),
        workspace_id: membership.workspace_id.to_string(),
        channel_id: membership.channel_id.to_string(),
        member_id: membership.member_id.to_string(),
        role: membership.role.clone(),
        joined_at_ms: membership.joined_at_ms,
        left_at_ms: membership.left_at_ms,
    }
}

/// `POST /v1/workspaces/{ws}/channels` — create a public/private channel
/// (Swift `ChannelRoutes.create`, :76-166).
///
/// Three refusals, in this order, and the order is the contract:
///   1. **400** on a malformed spec, *before* any DB access. The name rules are
///      the client's own (`CreateChannelInput` normalises first,
///      `lib/api.ts:736-742`), so a 400 here means the two disagreed.
///   2. **403** unless the caller is a workspace owner/admin. Channel creation is
///      workspace authority (ADR-0128), not channel authority — a member who can
///      post everywhere still cannot mint a room.
///   3. **409** when a live non-DM channel already carries the name
///      case-insensitively. The guard is inside the INSERT's `WHERE NOT EXISTS`,
///      so two concurrent creates cannot both win.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateChannelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let spec = NewChannel {
        kind: normalize_channel_kind(&request.kind)
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?,
        name: normalize_channel_name(&request.name)
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?,
        topic: normalize_channel_topic(request.topic.as_deref())
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?,
        created_by: principal.member_id,
    };

    // Authorization and the write share one transaction (Swift parity in effect
    // even though Swift takes two): an admin demoted mid-flight cannot still
    // create the channel their check passed for.
    let outcome: DbRejectable<CreatedChannel> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) =
                    active_workspace_role(conn, workspace_id, principal.member_id).await?
                else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                if !role.is_admin() {
                    return Ok(Err(ApiError::forbidden(
                        "workspace owner or admin role required",
                    )));
                }
                match create_channel_detailed_in_tx(conn, workspace_id, &spec).await? {
                    Some(created) => Ok(Ok(created)),
                    None => Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "channel name already exists",
                    ))),
                }
            })
        })
        .await;

    let created = settle_db("channels.create", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateChannelResponse {
            channel: channel_dto(&created.channel),
            creator_membership: membership_dto(&created.creator_membership),
        }),
    ))
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/notification-pref` — mute or unmute
/// this channel **for the calling member** (Swift `updateNotificationPref`,
/// :238-316; ADR-0124).
///
/// There is deliberately no actor field in the body: the preference's owner is
/// the authenticated principal and nothing else. A `memberId` parameter here
/// would let one member silence another.
pub async fn notification_pref(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<UpdateNotificationPrefRequest>,
) -> Result<Json<NotificationPrefResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let muted = request.muted;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !set_notification_pref_in_tx(
                conn,
                workspace_id,
                channel_id,
                principal.member_id,
                muted,
            )
            .await?
            {
                return Ok(Err(ApiError::forbidden(
                    "active channel membership required",
                )));
            }
            // The audit row shares the preference's transaction, so it can never
            // record a mute that rolled back (`momo_db::audit` module docs).
            momo_db::audit::write_audit(
                conn,
                &momo_db::audit::AuditEntry::new(workspace_id, "notification_pref.updated")
                    .by(principal.member_id)
                    .target("channel", channel_id)
                    .via_token(via_token_id)
                    .with_schema(
                        "momo.notification_pref.updated.v1",
                        serde_json::json!({ "muted": muted }),
                    ),
            )
            .await?;
            Ok(Ok(()))
        })
    })
    .await;

    settle_db("channels.notification_pref", outcome)?;
    Ok(Json(NotificationPrefResponse { muted }))
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/members` — put a member (human **or**
/// agent) into a channel (Swift `ChannelRoutes.addMember`, :168-236).
///
/// **This is the endpoint that makes an agent mentionable.** `POST …/agents`
/// stops at the workspace identity boundary on purpose, so until a `membership`
/// row exists an `@handle` resolves to an audited `agent_not_channel_member`
/// no-op rather than a run (`momo_agent::mention`). B5.2 had to seed that row by
/// hand in its own conformance test and recorded the gap; this closes it.
///
/// There is **no agent branch here** (invariant #5): the statement joins `member`
/// without looking at `kind`, so a human and an agent are added by the same row
/// through the same authority. Any branch would be the first crack in "an agent
/// is a member".
///
/// Authorization is workspace owner/admin — the same authority that creates
/// channels (ADR-0128), because adding a member changes who can read a room's
/// history, which is not a per-message decision.
pub async fn add_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<AddChannelMemberRequest>,
) -> Result<Json<ChannelMembershipResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    // Shape before connection (MOMO-362): a bad role costs no transaction.
    let role = normalize_membership_role(request.role.as_deref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let member_id = request.member_id;

    let outcome: DbRejectable<ChannelMembership> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Authorization and the write share one transaction, so an admin
                // demoted mid-flight cannot still add the member their check
                // passed for.
                let Some(role_of_actor) =
                    active_workspace_role(conn, workspace_id, principal.member_id).await?
                else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                if !role_of_actor.is_admin() {
                    return Ok(Err(ApiError::forbidden(
                        "workspace owner or admin role required",
                    )));
                }
                match add_channel_member_in_tx(conn, workspace_id, channel_id, member_id, role)
                    .await?
                {
                    Some(membership) => Ok(Ok(membership)),
                    None => Ok(Err(ApiError::not_found("channel or member not found"))),
                }
            })
        })
        .await;

    let membership = settle_db("channels.add_member", outcome)?;
    Ok(Json(ChannelMembershipResponse {
        membership: membership_dto(&membership),
    }))
}

/// `DELETE /v1/workspaces/{ws}/channels/{ch}/members/{member}` — the other half
/// (Swift `ChannelRoutes.removeMember`, :318-373).
///
/// Removing an agent is how an operator says "not in this room" without pausing
/// it everywhere: `pause` is workspace-wide and answers every mention with a
/// visible system line, while leaving a channel is silent and local. Both exist
/// because they are different statements to the team.
///
/// 404 — not 204 — when there is no live membership: "already gone" and "you
/// named the wrong channel" must not look identical to the caller.
pub async fn remove_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, member)): Path<(String, String, String)>,
) -> Result<Json<ChannelMembershipResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = path_uuid(&member, "invalid member id")?;

    let outcome: DbRejectable<ChannelMembership> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role_of_actor) =
                    active_workspace_role(conn, workspace_id, principal.member_id).await?
                else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                if !role_of_actor.is_admin() {
                    return Ok(Err(ApiError::forbidden(
                        "workspace owner or admin role required",
                    )));
                }
                match remove_channel_member_in_tx(conn, workspace_id, channel_id, member_id).await?
                {
                    Some(membership) => Ok(Ok(membership)),
                    None => Ok(Err(ApiError::not_found(
                        "active channel membership not found",
                    ))),
                }
            })
        })
        .await;

    let membership = settle_db("channels.remove_member", outcome)?;
    Ok(Json(ChannelMembershipResponse {
        membership: membership_dto(&membership),
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

    /// A freshly created channel is described exactly like a listed one, plus
    /// the creator's membership — the client reads `CreatedChannel` as
    /// `{channel, creatorMembership}` and renders the channel from the first
    /// half without re-listing.
    #[test]
    fn a_created_channel_answers_with_the_creators_membership() {
        let channel = ChannelSummary {
            id: Uuid::from_u128(11),
            workspace_id: Uuid::from_u128(2),
            kind: ChannelKind::Private,
            name: Some("dogfood".into()),
            topic: Some("도그푸딩 1차".into()),
            dm_key: None,
            member_ids: vec![],
            created_by: Some(Uuid::from_u128(7)),
            archived_at_ms: None,
            muted: false,
        };
        let membership = ChannelMembership {
            id: Uuid::from_u128(12),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(11),
            member_id: Uuid::from_u128(7),
            role: "owner".into(),
            joined_at_ms: 1_700_000_000_000,
            left_at_ms: None,
        };
        let json = serde_json::to_value(CreateChannelResponse {
            channel: channel_dto(&channel),
            creator_membership: membership_dto(&membership),
        })
        .expect("serialize");

        assert_eq!(json["channel"]["kind"], "private");
        assert_eq!(json["channel"]["name"], "dogfood");
        assert_eq!(
            json["channel"]["muted"], false,
            "nobody can have muted a channel that did not exist"
        );
        assert!(
            json["channel"].get("archivedAtMs").is_none(),
            "a new channel is not archived: {json}"
        );
        assert_eq!(
            json["creatorMembership"]["role"], "owner",
            "the creator owns the channel it just made"
        );
        assert_eq!(
            json["creatorMembership"]["memberId"],
            Uuid::from_u128(7).to_string()
        );
        assert!(
            json["creatorMembership"].get("leftAtMs").is_none(),
            "{json}"
        );
    }

    /// The mute body is closed-world and carries no actor: a `memberId` here
    /// would let one member silence another.
    #[test]
    fn the_mute_request_names_only_the_flag() {
        let parsed: UpdateNotificationPrefRequest =
            serde_json::from_value(serde_json::json!({"muted": true})).expect("muted");
        assert!(parsed.muted);
        assert!(
            serde_json::from_value::<UpdateNotificationPrefRequest>(
                serde_json::json!({"muted": true, "memberId": Uuid::from_u128(9)})
            )
            .is_err(),
            "a caller must not be able to mute someone else"
        );
        assert_eq!(
            serde_json::to_value(NotificationPrefResponse { muted: false }).expect("serialize"),
            serde_json::json!({"muted": false})
        );
    }

    /// The create body is closed-world too: a dropped `kind` would create a
    /// public channel someone asked to be private.
    #[test]
    fn the_create_request_refuses_keys_it_would_have_to_drop() {
        let parsed: CreateChannelRequest =
            serde_json::from_value(serde_json::json!({"kind": "public", "name": "general"}))
                .expect("minimal body");
        assert_eq!(parsed.kind, "public");
        assert!(parsed.topic.is_none());
        assert!(
            serde_json::from_value::<CreateChannelRequest>(
                serde_json::json!({"kind": "public", "name": "g", "memberIds": ["x"]})
            )
            .is_err(),
            "an unknown key is a 400, never a silently dropped intent"
        );
    }

    /// Swift's decoder accepts both spellings of the id and defaults the role,
    /// and the body stays closed-world otherwise.
    #[test]
    fn the_add_member_request_takes_either_spelling_of_the_id() {
        let member = Uuid::from_u128(42);
        let camel: AddChannelMemberRequest =
            serde_json::from_value(serde_json::json!({"memberId": member})).expect("camelCase");
        assert_eq!(camel.member_id, member);
        assert!(camel.role.is_none(), "an absent role means `member`");
        assert_eq!(
            normalize_membership_role(camel.role.as_deref()),
            Ok("member")
        );

        let snake: AddChannelMemberRequest =
            serde_json::from_value(serde_json::json!({"member_id": member, "role": "guest"}))
                .expect("Swift decodes member_id too");
        assert_eq!(snake.member_id, member);
        assert_eq!(
            normalize_membership_role(snake.role.as_deref()),
            Ok("guest")
        );

        assert!(
            serde_json::from_value::<AddChannelMemberRequest>(
                serde_json::json!({"memberId": member, "notify": false})
            )
            .is_err(),
            "an unknown key is a 400, never a silently dropped intent"
        );
        assert!(
            serde_json::from_value::<AddChannelMemberRequest>(serde_json::json!({"role": "admin"}))
                .is_err(),
            "there is no default member to add"
        );
    }

    /// The removal answers with the closed row, so a client can render the
    /// departure without a re-read — and `leftAtMs` is what distinguishes it
    /// from an add.
    #[test]
    fn a_removed_membership_answers_with_its_departure_stamp() {
        let membership = ChannelMembership {
            id: Uuid::from_u128(21),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(11),
            member_id: Uuid::from_u128(7),
            role: "member".into(),
            joined_at_ms: 1_700_000_000_000,
            left_at_ms: Some(1_700_000_100_000),
        };
        let json = serde_json::to_value(ChannelMembershipResponse {
            membership: membership_dto(&membership),
        })
        .expect("serialize");
        assert_eq!(
            json["membership"]["memberId"],
            Uuid::from_u128(7).to_string()
        );
        assert_eq!(
            json["membership"]["leftAtMs"],
            serde_json::json!(1_700_000_100_000_i64)
        );
        assert_eq!(json["membership"]["role"], "member");
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
