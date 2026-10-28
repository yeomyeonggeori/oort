//! The inbox — what is "to me" (ADR-0199 D6, #3681 E2).
//!
//! ```text
//! GET  /v1/workspaces/{ws}/inbox?filter=&cursor=&limit=&muted=   keyset page
//! PUT  /v1/workspaces/{ws}/inbox/{item}/read                     one item read (idempotent)
//! POST /v1/workspaces/{ws}/inbox/read-all?filter=                every visible unread item read
//! ```
//!
//! **The client never names whose inbox it is.** Every statement binds the
//! authenticated principal's member id; no path, query or body field carries a
//! member. A foreign item id is therefore `404 inbox item not found` — the same
//! answer as an id that never existed — so the route is no existence oracle.
//! The tenant boundary is RLS (`agent_tenant_tx`), the member boundary is that
//! predicate, and `inbox_projection_conformance_pg` / `inbox_api_conformance_pg`
//! prove both separately.
//!
//! Reading an item moves **no channel cursor** (ADR-0199 D3). Humans only
//! (`require_human`, and the agent bearer allow-list does not list these paths):
//! an agent's inbox is the hosted inbox (ADR-0162).
//!
//! Wire keys are camelCase (ADR-0199 D6), unlike the snake_case read-state
//! envelope; the realtime payload (`inbox_item.*`) keeps the read-state
//! broadcast's snake_case so one subscriber decodes both.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use chrono::{DateTime, SecondsFormat, Utc};
use momo_agent::approval::{is_active_human_member_in_tx, list_approvals_in_tx};
use momo_auth::Principal;
use momo_messaging::{
    clamp_inbox_limit, inbox_unread_count_in_tx, list_inbox_within_in_tx,
    mark_inbox_item_read_in_tx, mark_inbox_read_all_in_tx, ChannelRestriction, InboxCursor,
    InboxFilter, InboxItemView,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::dev_credential::DevCredential;
use crate::dto::ApprovalDto;
use crate::error::ApiError;
use crate::routes::approvals::approval_dto;
use crate::routes::shared::{
    agent_tenant_tx, path_uuid, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Pending approvals shown on the first page (ADR-0199 D2: merged at read time,
/// never stored). One screenful; the approvals route has the full list.
const APPROVALS_PENDING_LIMIT: i64 = 20;

#[derive(Debug, Default, Deserialize)]
pub struct InboxQuery {
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    /// Lenient like the other pagers: a bad page size has a safe default.
    #[serde(default)]
    pub limit: Option<String>,
    /// `hide` (default) | `show` — muted channels (ADR-0124).
    #[serde(default)]
    pub muted: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ReadAllQuery {
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub muted: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxChannelDto {
    pub id: String,
    pub name: Option<String>,
    pub kind: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessageDto {
    pub id: String,
    pub seq: i64,
    pub author_member_id: String,
    pub preview: String,
    pub deleted: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxQuotedDto {
    pub id: String,
    pub author_member_id: String,
    pub preview: String,
    pub deleted: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InboxItemDto {
    pub id: String,
    pub kind: String,
    pub reasons: Vec<String>,
    pub channel: InboxChannelDto,
    pub message: InboxMessageDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quoted_message: Option<InboxQuotedDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    pub actor_member_id: String,
    pub created_at: String,
    pub read_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPageDto {
    pub items: Vec<InboxItemDto>,
    /// `null` on the last page.
    pub next_cursor: Option<String>,
    pub unread_count: i64,
    /// First page only (ADR-0199 D2); empty on a continuation page.
    pub approvals_pending: Vec<ApprovalDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItemReadDto {
    pub id: String,
    pub read_at: String,
    pub unread_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxReadAllDto {
    pub marked: i64,
    pub unread_count: i64,
}

fn item_dto(item: &InboxItemView) -> InboxItemDto {
    InboxItemDto {
        id: item.id.to_string(),
        kind: item.kind.clone(),
        reasons: item.reasons.clone(),
        channel: InboxChannelDto {
            id: item.channel.id.to_string(),
            name: item.channel.name.clone(),
            kind: item.channel.kind.clone(),
        },
        message: InboxMessageDto {
            id: item.message.id.to_string(),
            seq: item.message.seq,
            author_member_id: item.message.author_member_id.to_string(),
            preview: item.message.preview.clone(),
            deleted: item.message.deleted,
        },
        quoted_message: item.quoted.as_ref().map(|quoted| InboxQuotedDto {
            id: quoted.id.to_string(),
            author_member_id: quoted.author_member_id.to_string(),
            preview: quoted.preview.clone(),
            deleted: quoted.deleted,
        }),
        root_id: item.root_id.map(|id| id.to_string()),
        actor_member_id: item.actor_member_id.to_string(),
        created_at: iso(item.created_at),
        read_at: item.read_at.map(iso),
    }
}

/// RFC 3339, microseconds, `Z` — the precision the keyset cursor orders by.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Micros, true)
}

fn parse_filter(raw: Option<&str>) -> Result<InboxFilter, ApiError> {
    match raw {
        None => Ok(InboxFilter::All),
        Some(raw) => InboxFilter::parse(raw).ok_or_else(|| {
            ApiError::bad_request("filter must be all, unread, mention, reply, dm or thread")
        }),
    }
}

fn parse_muted(raw: Option<&str>) -> Result<bool, ApiError> {
    match raw {
        None | Some("hide") => Ok(false),
        Some("show") => Ok(true),
        Some(_) => Err(ApiError::bad_request("muted must be hide or show")),
    }
}

/// `GET /v1/workspaces/{ws}/inbox`
///
/// **A developer token (ADR-0216 D4 · F17 · R11, #4660)** reads this page as its person,
/// with every field of the answer decided for it:
/// - `approvalsPending` is always `[]` — approval cards never reach the developer door,
///   so the approval list is not even read;
/// - `items` and `unreadCount` cover only the token's restricted channels (∩ today's
///   memberships) when it has a restriction, as an argument of the domain read so the
///   page size, the cursor and the count agree with each other;
/// - nothing is marked read (this is a `GET`; the read routes are not on the token's
///   table at all).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<InboxQuery>,
    // ADR-0216 (#4660): present only for a developer token, and only able to narrow.
    dev_credential: Option<Extension<DevCredential>>,
) -> Result<Json<InboxPageDto>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the inbox is for human members")?;
    let filter = parse_filter(query.filter.as_deref())?;
    let show_muted = parse_muted(query.muted.as_deref())?;
    // Strict, like the replies cursor: a bad cursor must not silently restart
    // the list from the top.
    let cursor = match query.cursor.as_deref() {
        None | Some("") => None,
        Some(token) => Some(
            InboxCursor::decode(token)
                .ok_or_else(|| ApiError::bad_request("invalid inbox cursor"))?,
        ),
    };
    let limit = clamp_inbox_limit(query.limit.as_deref().and_then(|raw| raw.parse().ok()));
    let member_id = principal.member_id;
    let first_page = cursor.is_none();
    let dev_credential = dev_credential.map(|Extension(credential)| credential);
    // ADR-0216 F17 — decided before the transaction and from the marker alone: a
    // developer token's page never carries approval cards, on any page.
    let with_approvals = first_page && dev_credential.is_none();
    // ADR-0216 D4 — the token's channel restriction, owned so the transaction carries it.
    let restricted_to: Option<Vec<Uuid>> =
        dev_credential.and_then(|credential| credential.channel_ids);

    let outcome: DbRejectable<(momo_messaging::InboxPage, Vec<ApprovalDto>)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                let page = list_inbox_within_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    filter,
                    cursor,
                    limit,
                    show_muted,
                    ChannelRestriction::from_channel_ids(restricted_to.as_deref()),
                )
                .await?;
                let approvals = if with_approvals {
                    list_approvals_in_tx(
                        conn,
                        workspace_id,
                        member_id,
                        "pending",
                        APPROVALS_PENDING_LIMIT,
                    )
                    .await?
                    .iter()
                    .map(approval_dto)
                    .collect()
                } else {
                    Vec::new()
                };
                Ok(Ok((page, approvals)))
            })
        })
        .await;

    let (page, approvals_pending) = settle_db("inbox.list", outcome)?;
    Ok(Json(InboxPageDto {
        items: page.items.iter().map(item_dto).collect(),
        next_cursor: page.next_cursor.map(|cursor| cursor.encode()),
        unread_count: page.unread_count,
        approvals_pending,
    }))
}

/// `PUT /v1/workspaces/{ws}/inbox/{item}/read`
pub async fn read_item(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
) -> Result<Json<InboxItemReadDto>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the inbox is for human members")?;
    let item_id = path_uuid(&item, "invalid inbox item id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<InboxItemReadDto> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                let Some(read) =
                    mark_inbox_item_read_in_tx(conn, workspace_id, member_id, item_id).await?
                else {
                    return Ok(Err(ApiError::not_found("inbox item not found")));
                };
                let unread_count =
                    inbox_unread_count_in_tx(conn, workspace_id, member_id, false).await?;
                Ok(Ok(InboxItemReadDto {
                    id: item_id.to_string(),
                    read_at: iso(read.read_at),
                    unread_count,
                }))
            })
        })
        .await;
    Ok(Json(settle_db("inbox.read_item", outcome)?))
}

/// `POST /v1/workspaces/{ws}/inbox/read-all`
pub async fn read_all(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ReadAllQuery>,
) -> Result<Json<InboxReadAllDto>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the inbox is for human members")?;
    let filter = parse_filter(query.filter.as_deref())?;
    let show_muted = parse_muted(query.muted.as_deref())?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<InboxReadAllDto> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                let done =
                    mark_inbox_read_all_in_tx(conn, workspace_id, member_id, filter, show_muted)
                        .await?;
                let unread_count =
                    inbox_unread_count_in_tx(conn, workspace_id, member_id, show_muted).await?;
                Ok(Ok(InboxReadAllDto {
                    marked: done.marked,
                    unread_count,
                }))
            })
        })
        .await;
    Ok(Json(settle_db("inbox.read_all", outcome)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::{InboxChannel, InboxMessage};
    use uuid::Uuid;

    #[test]
    fn the_wire_is_camel_case_and_names_no_member_of_the_inbox() {
        let item = InboxItemView {
            id: Uuid::from_u128(1),
            kind: "reply_to_me".into(),
            reasons: vec!["reply_to_me".into()],
            channel: InboxChannel {
                id: Uuid::from_u128(2),
                name: Some("agent-lab".into()),
                kind: "public".into(),
            },
            message: InboxMessage {
                id: Uuid::from_u128(3),
                seq: 9,
                author_member_id: Uuid::from_u128(4),
                preview: "hi".into(),
                deleted: false,
            },
            quoted: None,
            root_id: None,
            actor_member_id: Uuid::from_u128(4),
            created_at: Utc::now(),
            read_at: None,
        };
        let json = serde_json::to_value(item_dto(&item)).unwrap();
        for key in [
            "id",
            "kind",
            "reasons",
            "channel",
            "message",
            "actorMemberId",
            "createdAt",
            "readAt",
        ] {
            assert!(json.get(key).is_some(), "missing {key}: {json}");
        }
        assert_eq!(
            json["message"]["authorMemberId"],
            Uuid::from_u128(4).to_string()
        );
        assert!(json.get("quotedMessage").is_none(), "absent, not null");
        assert!(
            json.get("memberId").is_none(),
            "an item never names its owner on the wire"
        );
        assert!(json["readAt"].is_null());
    }

    #[test]
    fn query_values_are_closed() {
        assert_eq!(parse_filter(None).unwrap(), InboxFilter::All);
        assert!(parse_filter(Some("task")).is_err());
        assert!(!parse_muted(None).unwrap());
        assert!(parse_muted(Some("show")).unwrap());
        assert!(parse_muted(Some("maybe")).is_err());
    }
}
