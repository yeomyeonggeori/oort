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
//!     that can be shown and never changed. It also takes an optional end
//!     (`mutedUntilMs`, ADR-0206 D12), which the same rows report back — only
//!     while that timed mute is in progress.
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
    active_workspace_role, add_channel_member_in_tx, channel_summary_in_tx,
    check_channel_default_change_in_tx, clamp_browse_limit, clamp_channel_list_limit,
    create_channel_detailed_in_tx, db_now_in_tx, is_channel_name_conflict, judge_browse_person,
    list_browsable_channels_in_tx, list_workspace_channels_within, lock_channel_edit_target_in_tx,
    normalize_channel_kind, normalize_channel_name, normalize_channel_topic,
    normalize_membership_role, remove_channel_member_in_tx, rename_channel_in_tx,
    self_join_channel_in_tx, set_channel_browse_listed_in_tx, set_channel_default_in_tx,
    set_notification_pref_in_tx, validate_channel_mute, BrowsableChannel, BrowseAfter,
    BrowseListedChange, BrowsePersonRefusal, ChannelMembership, ChannelMute, ChannelRenameOutcome,
    ChannelRestriction, ChannelSummary, CreatedChannel, DefaultChannelCheck, MutedUntilInvalid,
    NewChannel, SelfJoin,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::dev_credential::DevCredential;
use crate::dto::{
    AddChannelMemberRequest, BrowseChannelDto, BrowseChannelsQuery, BrowseChannelsResponse,
    ChannelDto, ChannelJoinResponse, ChannelMembershipDto, ChannelMembershipResponse,
    CreateChannelRequest, CreateChannelResponse, NotificationPrefResponse, UpdateChannelResponse,
    UpdateNotificationPrefRequest, WorkspaceChannelsResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
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
        browse_listed: channel.browse_listed,
        is_default: channel.is_default,
        muted: channel.muted,
        muted_until_ms: channel.muted_until_ms,
    }
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ChannelListQuery>,
    // ADR-0216 (#4660): present only for a developer token, and only able to narrow.
    dev_credential: Option<Extension<DevCredential>>,
) -> Result<Json<WorkspaceChannelsResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let limit = query.limit();
    let include_archived = query.include_archived();
    // ADR-0216 D4 · R11 — a developer token's channel restriction, owned so the
    // transaction can carry it. `None` (a person's session, or a token with no
    // restriction) is the unchanged list.
    let restricted_to: Option<Vec<Uuid>> =
        dev_credential.and_then(|Extension(credential)| credential.channel_ids);

    let outcome: DbRejectable<Vec<ChannelSummary>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                // The restriction rides the statement beside its membership join, so the
                // list is the token's channels ∩ today's memberships and `limit` counts
                // only what the caller may see (a channel outside it is simply absent —
                // the list never says it exists).
                let channels = list_workspace_channels_within(
                    conn,
                    workspace_id,
                    principal.member_id,
                    include_archived,
                    limit,
                    ChannelRestriction::from_channel_ids(restricted_to.as_deref()),
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

/// The fields `PATCH …/channels/{ch}` knows. A body is a partial update: only
/// the keys present change, an unknown key is a 400 (never silently ignored),
/// and a body with no known key is a 400. A later piece adds its key to
/// [`KNOWN_CHANNEL_PATCH_FIELDS`], to [`ChannelPatch`] and to the transaction in
/// [`update`] — judged before the first write, applied after.
const KNOWN_CHANNEL_PATCH_FIELDS: &[&str] = &["name", "browseListed", "isDefault"];

struct ChannelPatch {
    /// Already folded and judged by the same function the create route uses.
    name: Option<String>,
    /// ADR-0224 D2 — shown in channel browse or not.
    browse_listed: Option<bool>,
    /// ADR-0224 D6 — a person joining by invite lands in this channel.
    is_default: Option<bool>,
}

fn parse_channel_patch(body: &serde_json::Value) -> Result<ChannelPatch, ApiError> {
    let Some(object) = body.as_object() else {
        return Err(ApiError::bad_request("request body must be a JSON object"));
    };
    // The key is the caller's own text: it is not sent back (the repo's other
    // unknown-field refusals name no key either).
    if object
        .keys()
        .any(|key| !KNOWN_CHANNEL_PATCH_FIELDS.contains(&key.as_str()))
    {
        return Err(ApiError::bad_request("unknown channel field"));
    }
    let mut patch = ChannelPatch {
        name: None,
        browse_listed: None,
        is_default: None,
    };
    if let Some(raw) = object.get("name") {
        let raw = raw
            .as_str()
            .ok_or_else(|| ApiError::bad_request("channel name must be a string"))?;
        patch.name = Some(
            normalize_channel_name(raw)
                .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?,
        );
    }
    if let Some(raw) = object.get("browseListed") {
        patch.browse_listed = Some(
            raw.as_bool()
                .ok_or_else(|| ApiError::bad_request("browseListed must be a boolean"))?,
        );
    }
    if let Some(raw) = object.get("isDefault") {
        patch.is_default = Some(
            raw.as_bool()
                .ok_or_else(|| ApiError::bad_request("isDefault must be a boolean"))?,
        );
    }
    if patch.name.is_none() && patch.browse_listed.is_none() && patch.is_default.is_none() {
        return Err(ApiError::bad_request("no channel field to update"));
    }
    Ok(patch)
}

/// The one 404 of the channel PATCH: unknown id, another workspace's, outside the
/// target condition, and a DM or archived channel for `name` — byte for byte.
const CHANNEL_EDIT_NOT_FOUND: &str = "channel not found";

/// `PATCH /v1/workspaces/{ws}/channels/{ch}` — rename a public or private
/// channel (ADR-0225 D10) and/or switch whether a public channel is shown in
/// channel browse (ADR-0224 D2, `browseListed`). Human only (`require_human`,
/// and the route is on no agent / developer-token / narrow-token table),
/// workspace owner or admin only (ADR-0128).
///
/// **One target condition** ([`lock_channel_edit_target_in_tx`]): a channel the
/// caller is a live member of, or one open to people (public, not archived,
/// listed in browse). Every other id — a private channel or a browse-off public
/// channel the caller does not sit in included — is the same 404 as an unknown
/// id, for every field.
///
/// Refusals, in order: 400 (body shape, name rule — before any DB access), 403
/// (not admin), 404 (outside the target condition; a DM or archived channel for
/// `name`), 409 `channel_not_listable` (`browseListed` on a private, DM or
/// archived channel inside the target condition), 409 `general_channel_locked`,
/// 409 `channel name already exists`. Every piece is judged before the first
/// write, so a refused request changes nothing; `name` and `browseListed`
/// together are one transaction. A value the channel already has is a 200 with
/// no write and no audit row. Audit `channel.renamed` / `channel.browse_listed`;
/// no message, no realtime event. The answer is the channel in the channel
/// list's shape.
///
/// `isDefault` (ADR-0224 D6): 409 `channel_not_defaultable` on a private, DM or
/// archived channel, 409 `last_default_channel` when it would turn off the
/// workspace's last live default channel; audit `channel.default`.
pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<UpdateChannelResponse>, ApiError> {
    require_human(&principal, "only a human member can edit a channel")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let patch = parse_channel_patch(&body)?;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<ChannelSummary> =
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
                let Some(target) = lock_channel_edit_target_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    principal.member_id,
                )
                .await?
                else {
                    return Ok(Err(ApiError::not_found(CHANNEL_EDIT_NOT_FOUND)));
                };
                // Judge every piece before the first write: a rejection commits.
                if patch.name.is_some() && !target.renamable() {
                    return Ok(Err(ApiError::not_found(CHANNEL_EDIT_NOT_FOUND)));
                }
                if patch.browse_listed.is_some() && !target.listable() {
                    return Ok(Err(channel_not_listable()));
                }
                // The `isDefault` piece is judged here, before any write; its write
                // comes last. It takes a per-workspace lock after the row lock above.
                let default_change = match patch.is_default {
                    None => None,
                    Some(wanted) => {
                        match check_channel_default_change_in_tx(conn, &target, wanted).await? {
                            DefaultChannelCheck::NotDefaultable => {
                                return Ok(Err(channel_not_defaultable()))
                            }
                            DefaultChannelCheck::LastDefault => {
                                return Ok(Err(last_default_channel()))
                            }
                            DefaultChannelCheck::Unchanged => None,
                            DefaultChannelCheck::Change { previous } => Some((wanted, previous)),
                        }
                    }
                };
                // The `name` piece. Its own refusals come before its only write.
                if let Some(new_name) = patch.name.as_deref() {
                    match rename_channel_in_tx(conn, &target, new_name).await? {
                        ChannelRenameOutcome::NotFound => {
                            return Ok(Err(ApiError::not_found(CHANNEL_EDIT_NOT_FOUND)))
                        }
                        ChannelRenameOutcome::GeneralLocked => {
                            return Ok(Err(ApiError::coded(
                                StatusCode::CONFLICT,
                                "general_channel_locked",
                                "the general channel cannot be renamed or taken as a name",
                            )))
                        }
                        ChannelRenameOutcome::NameTaken => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                "channel name already exists",
                            )))
                        }
                        ChannelRenameOutcome::Unchanged(_) => {}
                        ChannelRenameOutcome::Renamed {
                            previous_name,
                            channel,
                        } => {
                            momo_db::audit::write_audit(
                                conn,
                                &momo_db::audit::AuditEntry::new(workspace_id, "channel.renamed")
                                    .by(principal.member_id)
                                    .target("channel", channel_id)
                                    .via_token(via_token_id)
                                    .with_schema(
                                        "momo.channel.renamed.v1",
                                        serde_json::json!({
                                            "old": previous_name,
                                            "new": channel.name,
                                        }),
                                    ),
                            )
                            .await?;
                        }
                    }
                }
                // The `browseListed` piece (ADR-0224 D2). Memberships stay as they are.
                if let Some(listed) = patch.browse_listed {
                    match set_channel_browse_listed_in_tx(conn, &target, listed).await? {
                        BrowseListedChange::NotListable => return Ok(Err(channel_not_listable())),
                        BrowseListedChange::Unchanged => {}
                        BrowseListedChange::Changed { previous } => {
                            momo_db::audit::write_audit(
                                conn,
                                &momo_db::audit::AuditEntry::new(
                                    workspace_id,
                                    "channel.browse_listed",
                                )
                                .by(principal.member_id)
                                .target("channel", channel_id)
                                .via_token(via_token_id)
                                .with_schema(
                                    "momo.channel.browse_listed.v1",
                                    serde_json::json!({
                                        "old": previous,
                                        "new": listed,
                                    }),
                                ),
                            )
                            .await?;
                        }
                    }
                }
                // The `isDefault` piece (ADR-0224 D6). Memberships stay as they are:
                // only people who join later land in a default channel.
                if let Some((wanted, previous)) = default_change {
                    set_channel_default_in_tx(conn, &target, wanted).await?;
                    momo_db::audit::write_audit(
                        conn,
                        &momo_db::audit::AuditEntry::new(workspace_id, "channel.default")
                            .by(principal.member_id)
                            .target("channel", channel_id)
                            .via_token(via_token_id)
                            .with_schema(
                                "momo.channel.default.v1",
                                serde_json::json!({
                                    "old": previous,
                                    "new": wanted,
                                }),
                            ),
                    )
                    .await?;
                }
                // The row the channel list shows, read without the list's membership
                // join: an admin may edit a channel open to people without sitting in it.
                match channel_summary_in_tx(conn, workspace_id, principal.member_id, channel_id)
                    .await?
                {
                    Some(summary) => Ok(Ok(summary)),
                    None => Ok(Err(ApiError::internal(
                        "channels.update",
                        "edited channel is missing",
                    ))),
                }
            })
        })
        .await;

    // Two requests racing for one name: the loser fails at the unique index.
    let outcome = match outcome {
        Err(error) if is_channel_name_conflict(&error) => Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "channel name already exists",
        ))),
        other => other,
    };
    let summary = settle_db("channels.update", outcome)?;
    Ok(Json(UpdateChannelResponse {
        channel: channel_dto(&summary),
    }))
}

/// `browseListed` on a channel inside the target condition that is not a live
/// public channel (ADR-0224 D2): the caller already sees it, so a 409 tells them
/// nothing new.
fn channel_not_listable() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "channel_not_listable",
        "only a live public channel can be shown in channel browse",
    )
}

/// `isDefault` on a channel inside the target condition that is not a live
/// public channel (ADR-0224 D6).
fn channel_not_defaultable() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "channel_not_defaultable",
        "only a live public channel can be a default channel",
    )
}

/// Turning off the workspace's last live default channel (ADR-0224 D6).
fn last_default_channel() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "last_default_channel",
        "the last default channel cannot be turned off",
    )
}

// ---------------------------------------------------------------------------
// ADR-0224 D3·D4 — browse the public channels and join one yourself
// ---------------------------------------------------------------------------

/// Refusal of a non-human bearer on the two browse routes (same 403 as every
/// human-only route; the agent and developer-token doors refuse earlier still).
const BROWSE_HUMAN_ONLY: &str = "only a human member can browse or join channels";
/// The one 404 of the join: private, DM, browse off, archived, unknown, another
/// workspace's — all of them, byte for byte.
const BROWSE_CHANNEL_NOT_FOUND: &str = "channel not found";
/// Longest `q` the browse list takes, in characters.
const BROWSE_FILTER_MAX_CHARS: usize = 100;
/// Longest `cursor` the browse list takes, in bytes (a uuid, a dot and the hex of a
/// lower-cased channel name).
const BROWSE_CURSOR_MAX_BYTES: usize = 1024;

fn browse_person_http(refusal: BrowsePersonRefusal) -> ApiError {
    match refusal {
        BrowsePersonRefusal::NotActive => ApiError::forbidden("not a workspace member"),
        BrowsePersonRefusal::Guest => {
            ApiError::forbidden("guests cannot browse or join public channels")
        }
    }
}

/// `q` → the text to look for, or `None` for "no filter". Trimmed; empty is no filter.
fn browse_filter(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(text) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(None);
    };
    if text.chars().count() > BROWSE_FILTER_MAX_CHARS || text.contains('\0') {
        return Err(ApiError::bad_request("invalid browse filter"));
    }
    Ok(Some(text.to_string()))
}

/// The cursor is the last row's sort key itself (`{id}.{hex(lower(name))}`), not an id
/// the server looks up: a lookup would answer differently for a channel that exists
/// but is hidden, and a channel turned off between two pages would break the walk.
fn encode_browse_cursor(row: &BrowsableChannel) -> String {
    let mut cursor = String::with_capacity(37 + row.sort_name.len() * 2);
    cursor.push_str(&row.id.to_string());
    cursor.push('.');
    for byte in row.sort_name.as_bytes() {
        cursor.push_str(&format!("{byte:02x}"));
    }
    cursor
}

fn decode_browse_cursor(raw: &str) -> Option<BrowseAfter> {
    if raw.len() > BROWSE_CURSOR_MAX_BYTES {
        return None;
    }
    let (id, hex) = raw.split_once('.')?;
    let id = Uuid::parse_str(id).ok()?;
    if hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    let sort_name = String::from_utf8(bytes).ok()?;
    if sort_name.contains('\0') {
        return None;
    }
    Some(BrowseAfter { sort_name, id })
}

fn browse_dto(row: &BrowsableChannel) -> BrowseChannelDto {
    BrowseChannelDto {
        id: row.id.to_string(),
        name: row.name.clone(),
        topic: row.topic.clone(),
        member_count: row.member_count,
        is_member: row.is_member,
        is_default: row.is_default,
    }
}

/// `GET /v1/workspaces/{ws}/channels/browse?q=&cursor=&limit=` — the public channels a
/// person may find and join (ADR-0224 D3): not archived, `browse_listed` on. Ordered by
/// `lower(name)` then id; `isMember` says whether the caller is in it already, so a
/// screen groups the rows itself. Owners and admins get the same list as everyone else.
///
/// Refusals, in order, all before a channel is read: 403 non-human bearer, 403
/// workspace scope, 400 bad `q`/`cursor`, 403 not an active member (suspended
/// included), 403 guest.
pub async fn browse(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<BrowseChannelsQuery>,
) -> Result<Json<BrowseChannelsResponse>, ApiError> {
    require_human(&principal, BROWSE_HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let limit = clamp_browse_limit(
        query
            .limit
            .as_deref()
            .and_then(|raw| raw.trim().parse().ok()),
    );
    let filter = browse_filter(query.q.as_deref())?;
    let after = match query.cursor.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(
            decode_browse_cursor(raw)
                .ok_or_else(|| ApiError::bad_request("invalid browse cursor"))?,
        ),
    };
    let member_id = principal.member_id;

    let outcome: DbRejectable<(Vec<BrowsableChannel>, bool)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                if let Err(refusal) = judge_browse_person(role) {
                    return Ok(Err(browse_person_http(refusal)));
                }
                let mut rows = list_browsable_channels_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    filter.as_deref(),
                    after.as_ref(),
                    limit + 1,
                )
                .await?;
                let more = rows.len() as i64 > limit;
                rows.truncate(usize::try_from(limit).unwrap_or(0));
                Ok(Ok((rows, more)))
            })
        })
        .await;

    let (rows, more) = settle_db("channels.browse", outcome)?;
    let next_cursor = if more {
        rows.last().map(encode_browse_cursor)
    } else {
        None
    };
    Ok(Json(BrowseChannelsResponse {
        channels: rows.iter().map(browse_dto).collect(),
        next_cursor,
    }))
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/members/me` — join a public channel from the
/// browse list (ADR-0224 D4·D9). The pair of `DELETE …/members/me`.
///
/// Refusals, in order: 403 non-human bearer, 403 workspace scope, 400 malformed id, 403
/// not an active member, 403 guest — all before the channel is read — then one 404 for
/// every id that is not a channel open to people (private, DM, browse off, archived,
/// unknown, another workspace's), even for a caller already seated there.
///
/// A new or left membership becomes a live `member` (a former channel owner comes back
/// as `member`), the read position moves to the channel's end so it starts with nothing
/// unread, and `channel.joined` is audited. A caller who is already a member gets 200
/// with `newlyJoined: false` and nothing written: role, read position and audit stay.
pub async fn join_channel(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<ChannelJoinResponse>, ApiError> {
    require_human(&principal, BROWSE_HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<(ChannelSummary, bool)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                if let Err(refusal) = judge_browse_person(role) {
                    return Ok(Err(browse_person_http(refusal)));
                }
                let (membership_id, admitted, rejoined) =
                    match self_join_channel_in_tx(conn, workspace_id, channel_id, member_id).await?
                    {
                        SelfJoin::NotFound => {
                            return Ok(Err(ApiError::not_found(BROWSE_CHANNEL_NOT_FOUND)))
                        }
                        SelfJoin::Member {
                            membership_id,
                            admitted,
                            rejoined,
                        } => (membership_id, admitted, rejoined),
                    };
                if admitted {
                    momo_db::audit::write_audit(
                        conn,
                        &momo_db::audit::AuditEntry::new(workspace_id, "channel.joined")
                            .by(member_id)
                            .target("channel", channel_id)
                            .via_token(via_token)
                            .with_schema(
                                "momo.membership.channel_joined.v1",
                                serde_json::json!({
                                    "kind": "public",
                                    "membership_id": membership_id.to_string(),
                                    "rejoined": rejoined.to_string(),
                                }),
                            ),
                    )
                    .await?;
                }
                // The row the channel list would show for it now, so the shapes cannot drift.
                let ids = [channel_id];
                let mut rows = list_workspace_channels_within(
                    conn,
                    workspace_id,
                    member_id,
                    false,
                    1,
                    ChannelRestriction::from_channel_ids(Some(&ids)),
                )
                .await?;
                match rows.pop() {
                    Some(summary) => Ok(Ok((summary, admitted))),
                    None => Ok(Err(ApiError::internal(
                        "channels.join",
                        "joined channel is missing from the channel list",
                    ))),
                }
            })
        })
        .await;

    let (summary, newly_joined) = settle_db("channels.join", outcome)?;
    Ok(Json(ChannelJoinResponse {
        channel: channel_dto(&summary),
        newly_joined,
    }))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/preview` — read a public channel before joining it
/// (ADR-0224 D5): the channel's name, topic and member count and its newest top-level
/// messages, each with only body, author name and kind, time, edited/deleted marks, reply
/// count and attachment names. Read-only: no read position, membership, audit or outbox
/// row is written, and no realtime subscription is granted.
///
/// The gate is the join's, in the join's order: 403 non-human bearer, 403 workspace scope,
/// 400 malformed id, 403 not an active member, 403 guest — all before the channel is read —
/// then the join's one 404 for every id that is not a channel open to people (private, DM,
/// browse off, archived, unknown, another workspace's), even for a caller seated there. A
/// caller who is already a member gets the same narrow shape, with `isMember: true`.
pub async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<crate::dto::ChannelPreviewResponse>, ApiError> {
    require_human(&principal, BROWSE_HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<(
        momo_messaging::PreviewChannel,
        Vec<momo_messaging::PreviewMessage>,
    )> = momo_db::with_tenant_tx_prelude(
        &state.pool,
        workspace_id,
        |conn| Box::pin(momo_messaging::begin_preview_snapshot(conn)),
        |_conn| Box::pin(async move { Ok(()) }),
        move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                if let Err(refusal) = judge_browse_person(role) {
                    return Ok(Err(browse_person_http(refusal)));
                }
                match momo_messaging::preview_channel_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    member_id,
                )
                .await?
                {
                    None => Ok(Err(ApiError::not_found(BROWSE_CHANNEL_NOT_FOUND))),
                    Some(preview) => Ok(Ok(preview)),
                }
            })
        },
    )
    .await;

    let (channel, messages) = settle_db("channels.preview", outcome)?;
    Ok(Json(crate::dto::ChannelPreviewResponse {
        channel: crate::dto::PreviewChannelDto {
            id: channel.id.to_string(),
            name: channel.name,
            topic: channel.topic,
            member_count: channel.member_count,
            is_member: channel.is_member,
        },
        messages: messages
            .into_iter()
            .map(|message| crate::dto::PreviewMessageDto {
                id: message.id.to_string(),
                body: message.body,
                author: crate::dto::PreviewAuthorDto {
                    display_name: message.author_display_name,
                    kind: message.author_kind,
                },
                created_at_ms: message.created_at_ms,
                edited: message.edited,
                deleted: message.deleted,
                reply_count: message.reply_count,
                attachment_names: message.attachment_names,
            })
            .collect(),
    }))
}

/// A refused mute window as the wire says it: 400, with the machine code a client branches on
/// when the refusal has one (`muted_until_in_past`, `muted_until_too_far`; ADR-0206 D12).
fn muted_until_error(invalid: MutedUntilInvalid) -> ApiError {
    match invalid.code() {
        Some(code) => ApiError::coded(StatusCode::BAD_REQUEST, code, invalid.to_string()),
        None => ApiError::bad_request(invalid.to_string()),
    }
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/notification-pref` — mute or unmute
/// this channel **for the calling member** (Swift `updateNotificationPref`,
/// :238-316; ADR-0124), optionally until a moment (`mutedUntilMs`, ADR-0206 D12).
///
/// There is deliberately no actor field in the body: the preference's owner is
/// the authenticated principal and nothing else. A `memberId` parameter here
/// would let one member silence another.
///
/// The answer is the mute **as it now reads**, not an echo: `mutedUntilMs` is present only
/// while a timed mute is in progress. The deadline is judged on the database clock, before the
/// first write, so a refused window leaves no row and no audit behind.
pub async fn notification_pref(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<UpdateNotificationPrefRequest>,
) -> Result<Json<NotificationPrefResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let muted = request.muted;
    let muted_until_ms = request.muted_until_ms;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<ChannelMute> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The window is the database's call: `muted_until > now()` is what every reader
                // evaluates, so a deadline this accepts is one they will all see as in progress.
                let now = db_now_in_tx(conn).await?;
                let write = match validate_channel_mute(muted, muted_until_ms, now) {
                    Ok(write) => write,
                    Err(invalid) => return Ok(Err(muted_until_error(invalid))),
                };
                let Some(mute) = set_notification_pref_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    principal.member_id,
                    write,
                )
                .await?
                else {
                    return Ok(Err(ApiError::forbidden(
                        "active channel membership required",
                    )));
                };
                // The audit row shares the preference's transaction, so it can never
                // record a mute that rolled back (`momo_db::audit` module docs). It records the
                // mute as stored: `mutedUntilMs` is `null` for an open-ended mute or an un-mute.
                momo_db::audit::write_audit(
                    conn,
                    &momo_db::audit::AuditEntry::new(workspace_id, "notification_pref.updated")
                        .by(principal.member_id)
                        .target("channel", channel_id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.notification_pref.updated.v1",
                            serde_json::json!({
                                "muted": mute.muted,
                                "mutedUntilMs": mute.muted_until_ms,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(mute))
            })
        })
        .await;

    let mute = settle_db("channels.notification_pref", outcome)?;
    Ok(Json(NotificationPrefResponse {
        muted: mute.muted,
        muted_until_ms: mute.muted_until_ms,
    }))
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
            browse_listed: true,
            is_default: true,
            muted: false,
            muted_until_ms: None,
        };
        let json = serde_json::to_value(channel_dto(&summary)).expect("serialize");
        assert_eq!(json["kind"], "public");
        assert_eq!(json["name"], "general");
        assert_eq!(json["memberIds"].as_array().expect("array").len(), 0);
        assert_eq!(json["muted"], false);
        // ADR-0224 D2·D6: both marks travel on every row, by these names.
        assert_eq!(json["browseListed"], true);
        assert_eq!(json["isDefault"], true);
        assert!(json.get("topic").is_none(), "null optionals are omitted");
        assert!(json.get("dmKey").is_none());
        assert!(
            json.get("archivedAtMs").is_none(),
            "the web sidebar filters on `archivedAtMs === undefined`: {json}"
        );
        assert!(
            json.get("mutedUntilMs").is_none(),
            "no timed mute in progress, no end — the key is omitted, never `null`: {json}"
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
            browse_listed: false,
            is_default: false,
            muted: false,
            muted_until_ms: None,
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
        assert_eq!(parsed.muted_until_ms, None, "the old body has no end");
        assert!(
            serde_json::from_value::<UpdateNotificationPrefRequest>(
                serde_json::json!({"muted": true, "memberId": Uuid::from_u128(9)})
            )
            .is_err(),
            "a caller must not be able to mute someone else"
        );
        assert_eq!(
            serde_json::to_value(NotificationPrefResponse {
                muted: false,
                muted_until_ms: None,
            })
            .expect("serialize"),
            serde_json::json!({"muted": false})
        );
    }

    /// ADR-0206 D12 (#4343): the end is one optional int64 beside `muted`. Absent and `null` are
    /// both open-ended, so every body an older client sends parses as it always did; `level` is
    /// the channel-level slice's and stays an unknown field here.
    #[test]
    fn the_mute_request_takes_an_optional_end_and_not_a_level_yet() {
        let parse =
            |body: serde_json::Value| serde_json::from_value::<UpdateNotificationPrefRequest>(body);
        assert_eq!(
            parse(serde_json::json!({"muted": true, "mutedUntilMs": 1_800_000_000_000_i64}))
                .expect("timed")
                .muted_until_ms,
            Some(1_800_000_000_000)
        );
        assert_eq!(
            parse(serde_json::json!({"muted": true, "mutedUntilMs": null}))
                .expect("null end")
                .muted_until_ms,
            None
        );
        assert!(
            parse(serde_json::json!({"muted": true, "level": "none"})).is_err(),
            "`level` is not opened by this slice"
        );
        assert!(
            parse(serde_json::json!({"muted": true, "muted_until_ms": 5})).is_err(),
            "the wire spelling is camelCase only"
        );
        for not_an_int in [
            serde_json::json!("soon"),
            serde_json::json!(1.5),
            serde_json::json!(true),
        ] {
            assert!(
                parse(serde_json::json!({"muted": true, "mutedUntilMs": not_an_int})).is_err(),
                "the end is an integer or nothing"
            );
        }
    }

    /// The answer names its end only while a timed mute runs: an open-ended mute and an un-mute
    /// answer exactly what they always did, with no `mutedUntilMs` key (never `null`).
    #[test]
    fn the_mute_response_names_its_end_only_when_there_is_one() {
        assert_eq!(
            serde_json::to_value(NotificationPrefResponse {
                muted: true,
                muted_until_ms: None,
            })
            .expect("serialize"),
            serde_json::json!({"muted": true})
        );
        assert_eq!(
            serde_json::to_value(NotificationPrefResponse {
                muted: true,
                muted_until_ms: Some(1_800_000_000_000),
            })
            .expect("serialize"),
            serde_json::json!({"muted": true, "mutedUntilMs": 1_800_000_000_000_i64})
        );
    }

    /// A refused window is a 400; the two a client branches on carry their machine code, the
    /// deadline-on-an-un-mute does not.
    #[test]
    fn a_refused_mute_window_is_a_400_with_the_code_a_client_branches_on() {
        let past = muted_until_error(MutedUntilInvalid::InPast);
        assert_eq!(past.status, StatusCode::BAD_REQUEST);
        assert_eq!(past.code, Some("muted_until_in_past"));
        let far = muted_until_error(MutedUntilInvalid::TooFar);
        assert_eq!(far.status, StatusCode::BAD_REQUEST);
        assert_eq!(far.code, Some("muted_until_too_far"));
        let not_muted = muted_until_error(MutedUntilInvalid::NotMuted);
        assert_eq!(not_muted.status, StatusCode::BAD_REQUEST);
        assert_eq!(not_muted.code, None);
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
            browse_listed: false,
            is_default: false,
            muted: true,
            muted_until_ms: Some(1_800_000_000_000),
        };
        let json = serde_json::to_value(channel_dto(&summary)).expect("serialize");
        assert_eq!(json["kind"], "dm");
        assert_eq!(json["dmKey"], "deadbeef");
        assert_eq!(json["memberIds"].as_array().expect("array").len(), 2);
        assert_eq!(json["muted"], true);
        assert_eq!(
            json["browseListed"], false,
            "present and false, never omitted: {json}"
        );
        assert_eq!(json["isDefault"], false, "present and false: {json}");
        assert_eq!(
            json["mutedUntilMs"],
            serde_json::json!(1_800_000_000_000_i64),
            "a timed mute in progress travels with its row"
        );
    }
}
