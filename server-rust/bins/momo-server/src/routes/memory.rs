//! Team memory v2 — digest / receipt reads and settings (#3164 / ADR-0196).
//!
//! ```text
//! GET   /v1/workspaces/{ws}/channels/{ch}/memory/digests   missed-conversation list
//! GET   /v1/workspaces/{ws}/memory/digests/{id}            one digest (+ evidence)
//! GET   /v1/workspaces/{ws}/agent-runs/{run}/memory-receipt  「기억 n개 참고」 chip
//! GET   /v1/workspaces/{ws}/memory/settings                switches the caller may see
//! PATCH /v1/workspaces/{ws}/memory/settings                workspace switch (admin)
//! PATCH /v1/workspaces/{ws}/channels/{ch}/memory/settings  channel exclude / pause (admin)
//! PATCH /v1/workspaces/{ws}/memory/settings/me             personal pause (self)
//!
//! GET    /v1/workspaces/{ws}/memory/items                  memory browser list / search   (#3208)
//! GET    /v1/workspaces/{ws}/memory/items/{id}             one item (+ evidence back-links)
//! GET    /v1/workspaces/{ws}/memory/items/{id}/evidence    source messages of an item
//! GET    /v1/workspaces/{ws}/memory/items/{id}/events      lifecycle ledger of an item
//! PATCH  /v1/workspaces/{ws}/memory/items/{id}             edit  (new item supersedes the old)
//! DELETE /v1/workspaces/{ws}/memory/items/{id}             forget (permanent delete)
//! ```
//!
//! Human only. **The database decides visibility**: each transaction sets
//! `app.workspace_id` (tenant guard) and `app.member_id` ([`memory_tenant_tx`]) and
//! the `mem_*` row-level-security policies of migration 100 filter every read and
//! authorize every settings write. This module adds no permission filter of its
//! own (ADR-0196 D5/D6) — a row the policy hides is simply absent, which is why a
//! non-member of a channel sees an empty list and a hidden digest is a 404
//! indistinguishable from a missing one. The one check here is the liveness of
//! the caller's own membership (a suspended member is refused with 403, exactly as
//! the reminder routes do), because RLS alone would answer such a caller an empty
//! 200.
//!
//! Settings writes are upserts so that a policy denial surfaces as SQLSTATE
//! `42501`, which [`settle_mem`] maps to 403 (23514 → 422, 23505 → 409, 23503 →
//! 404). Every write is audited in the same transaction.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection, PgPool};
use momo_messaging::{
    bind_mem_reader_guc, clamp_mem_digest_limit, clamp_mem_item_limit, digests_by_ids_in_tx,
    edit_item_in_tx, evidence_for_digests_in_tx, evidence_for_items_in_tx, forget_item_in_tx,
    get_digest_in_tx, get_item_in_tx, get_serving_in_tx, last_read_seq_in_tx, list_digests_in_tx,
    list_item_events_in_tx, list_items_in_tx, list_settings_in_tx, search_item_rows_in_tx,
    summarized_through_seq_in_tx, upsert_channel_settings_in_tx, upsert_member_settings_in_tx,
    upsert_workspace_settings_in_tx, DigestListFilter, ItemListFilter, ItemStatus, MemDigest,
    MemEvidence, MemItem, MemItemEvent, MemItemEvidence, MemServing, MemSettingsRow,
    MEM_ITEM_KINDS,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, epoch_ms, futures_box, path_uuid, require_human, workspace_scope,
    DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "team memory requires a human bearer";
const DIGEST_NOT_FOUND: &str = "digest not found";
const RECEIPT_NOT_FOUND: &str = "receipt not found";

// ---------------------------------------------------------------------------
// transaction + error mapping
// ---------------------------------------------------------------------------

/// A tenant transaction that has also bound `app.member_id` (LOCAL scope, unwound
/// with the transaction — a pooled connection never keeps it). The binding is the
/// first statement of the body; the tenant guard already set `app.workspace_id`.
async fn memory_tenant_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    member_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> futures_box::BoxFuture<'c, Result<T, DbError>>
        + Send,
{
    // `after_guc` runs right after `app.workspace_id` is bound and before the body,
    // so no `mem_*` statement can precede the member binding.
    momo_db::with_tenant_tx_prelude::<T, DbError, _, _, _>(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        move |conn| Box::pin(async move { bind_mem_reader_guc(conn, member_id).await }),
        body,
    )
    .await
}

/// SQLSTATE → HTTP for the memory surface. Kept local: the global `db_error` is
/// shared by every route and must not learn memory's policy codes.
fn mem_db_error(context: &str, error: DbError) -> ApiError {
    if let DbError::Sqlx(momo_db::sqlx::Error::Database(db)) = &error {
        match db.code().as_deref() {
            // insufficient_privilege — an RLS USING / WITH CHECK denial.
            Some("42501") => {
                return ApiError::forbidden("not allowed to change this memory setting")
            }
            // check_violation — a value the schema rejects.
            Some("23514") => {
                return ApiError::new(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    "memory setting value is not allowed",
                )
            }
            // unique_violation — a concurrent first write of the same row.
            Some("23505") => {
                return ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "memory setting was changed concurrently",
                )
            }
            // foreign_key_violation — the target (channel/member) does not exist.
            Some("23503") => return ApiError::not_found("memory target not found"),
            _ => {}
        }
    }
    ApiError::internal(context, error)
}

fn settle_mem<T>(context: &str, outcome: DbRejectable<T>) -> Result<T, ApiError> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(rejection)) => Err(rejection),
        Err(error) => Err(mem_db_error(context, error)),
    }
}

/// The caller must still be an active workspace member. RLS alone would answer a
/// suspended caller an empty 200 (the read functions require an active viewer).
async fn require_live_human(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, DbError> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("active human membership required")));
    }
    Ok(Ok(()))
}

// ---------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceDto {
    pub message_id: String,
    pub channel_id: String,
    pub seq: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestDto {
    pub id: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_root_id: Option<String>,
    pub level: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub body: String,
    pub source_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at_ms: i64,
    pub evidence: Vec<EvidenceDto>,
}

fn digest_dto(digest: &MemDigest, evidence: &[MemEvidence]) -> DigestDto {
    DigestDto {
        id: digest.id.to_string(),
        channel_id: digest.channel_id.to_string(),
        thread_root_id: digest.thread_root_id.map(|id| id.to_string()),
        level: digest.level.clone(),
        from_seq: digest.from_seq,
        to_seq: digest.to_seq,
        body: digest.body.clone(),
        source_count: digest.source_count,
        model: digest.model.clone(),
        created_at_ms: epoch_ms(digest.created_at),
        evidence: evidence
            .iter()
            .filter(|link| link.digest_id == digest.id)
            .map(|link| EvidenceDto {
                message_id: link.message_id.to_string(),
                channel_id: link.channel_id.to_string(),
                seq: link.seq,
            })
            .collect(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDigestsQuery {
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub thread_root_id: Option<String>,
    #[serde(default)]
    pub since_seq: Option<String>,
    #[serde(default)]
    pub since_last_read: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestListResponse {
    pub digests: Vec<DigestDto>,
    /// Digests returned reach past this channel seq (`toSeq > afterSeq`): the
    /// larger of `sinceSeq` and, with `sinceLastRead`, the caller's read cursor.
    pub after_seq: i64,
    /// How far the summary worker has processed the channel; absent when it has
    /// not started (or the channel is unreadable). Lets a client tell "nothing
    /// to summarize" from "not summarized yet".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summarized_through_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestResponse {
    pub digest: DigestDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptDto {
    pub run_id: String,
    pub channel_id: String,
    /// Everything the run was served (digests + items) — the chip's `n`.
    pub served_count: i32,
    /// Ids of the served digests the caller can read today.
    pub digest_ids: Vec<String>,
    /// Those digests, with evidence, for the popover.
    pub digests: Vec<DigestDto>,
    /// Requester only, count only (ADR-0196 D7); absent for everyone else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub withheld_count: Option<i32>,
    pub budget_chars: i32,
    pub used_chars: i32,
    pub created_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptResponse {
    pub receipt: ReceiptDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemorySettingsDto {
    pub enabled: bool,
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_token_cap: Option<i32>,
    /// Read only. Bumped by a memory reset; the reset itself is not exposed here.
    pub reset_epoch: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMemorySettingsDto {
    pub channel_id: String,
    pub excluded: bool,
    pub paused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberMemorySettingsDto {
    pub paused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySettingsResponse {
    pub workspace: WorkspaceMemorySettingsDto,
    /// Channels with an explicit row that the caller can read.
    pub channels: Vec<ChannelMemorySettingsDto>,
    pub me: MemberMemorySettingsDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchWorkspaceSettingsRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchChannelSettingsRequest {
    #[serde(default)]
    pub excluded: Option<bool>,
    #[serde(default)]
    pub paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchMemberSettingsRequest {
    pub paused: bool,
}

fn workspace_settings_dto(row: Option<&MemSettingsRow>) -> WorkspaceMemorySettingsDto {
    match row {
        Some(row) => WorkspaceMemorySettingsDto {
            enabled: row.enabled,
            paused: row.paused,
            daily_token_cap: row.daily_token_cap,
            reset_epoch: row.reset_epoch,
        },
        // ADR-0196 D9: no row = the defaults (on, not paused, epoch 0).
        None => WorkspaceMemorySettingsDto {
            enabled: true,
            paused: false,
            daily_token_cap: None,
            reset_epoch: 0,
        },
    }
}

fn channel_settings_dto(row: &MemSettingsRow) -> Option<ChannelMemorySettingsDto> {
    Some(ChannelMemorySettingsDto {
        channel_id: row.channel_id?.to_string(),
        excluded: row.excluded,
        paused: row.paused,
    })
}

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

/// `"<toSeq>.<digestId>"` — the last digest of the previous page.
fn parse_cursor(raw: &str) -> Result<(i64, Uuid), ApiError> {
    let invalid = || ApiError::bad_request("invalid memory cursor");
    let (seq, id) = raw.split_once('.').ok_or_else(invalid)?;
    Ok((
        seq.parse::<i64>().map_err(|_| invalid())?,
        Uuid::parse_str(id).map_err(|_| invalid())?,
    ))
}

fn parse_bool(raw: Option<&str>, name: &'static str) -> Result<bool, ApiError> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(false),
        Some("true") | Some("1") => Ok(true),
        Some("false") | Some("0") => Ok(false),
        Some(_) => Err(ApiError::bad_request(format!(
            "{name} must be true or false"
        ))),
    }
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/memory/digests`
///
/// Digests of one channel (or, with `threadRootId`, one thread), newest first.
/// `sinceLastRead=true` anchors at the caller's own read cursor — the
/// missed-conversation shape. A channel the caller cannot read is an empty list,
/// not an error (the read policy hides the rows; existence is not confirmed).
pub async fn list_digests(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Query(query): Query<ListDigestsQuery>,
) -> Result<Json<DigestListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let level = match query
        .level
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        None => None,
        Some(level @ ("window" | "day" | "week")) => Some(level.to_string()),
        Some(_) => return Err(ApiError::bad_request("level must be window, day or week")),
    };
    let thread_root_id = match query
        .thread_root_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(raw) => Some(path_uuid(raw, "invalid thread root id")?),
        None => None,
    };
    let since_seq = match query
        .since_seq
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|seq| *seq >= 0)
            .ok_or_else(|| ApiError::bad_request("sinceSeq must be a non-negative integer"))?,
        None => 0,
    };
    let since_last_read = parse_bool(query.since_last_read.as_deref(), "sinceLastRead")?;
    let before = match query
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(raw) => Some(parse_cursor(raw)?),
        None => None,
    };
    let limit = clamp_mem_digest_limit(query.limit.as_deref().and_then(|raw| raw.parse().ok()));
    let member_id = principal.member_id;

    let outcome: DbRejectable<DigestListResponse> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let after_seq = if since_last_read {
                    since_seq.max(last_read_seq_in_tx(conn, channel_id, member_id).await?)
                } else {
                    since_seq
                };
                let mut rows = list_digests_in_tx(
                    conn,
                    &DigestListFilter {
                        channel_id,
                        thread_root_id,
                        level: level.as_deref(),
                        after_seq,
                        before,
                        limit: limit + 1,
                    },
                )
                .await?;
                let next_cursor = if rows.len() as i64 > limit {
                    rows.pop();
                    rows.last().map(|row| format!("{}.{}", row.to_seq, row.id))
                } else {
                    None
                };
                let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
                let evidence = evidence_for_digests_in_tx(conn, &ids).await?;
                let summarized_through_seq = summarized_through_seq_in_tx(conn, channel_id).await?;
                Ok(Ok(DigestListResponse {
                    digests: rows.iter().map(|row| digest_dto(row, &evidence)).collect(),
                    after_seq,
                    summarized_through_seq,
                    next_cursor,
                }))
            })
        })
        .await;

    Ok(Json(settle_mem("memory.list_digests", outcome)?))
}

/// `GET /v1/workspaces/{ws}/memory/digests/{id}`
pub async fn get_digest(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, digest)): Path<(String, String)>,
) -> Result<Json<DigestResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let digest_id = path_uuid(&digest, "invalid digest id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<DigestDto> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(found) = get_digest_in_tx(conn, digest_id).await? else {
                    return Ok(Err(ApiError::not_found(DIGEST_NOT_FOUND)));
                };
                let evidence = evidence_for_digests_in_tx(conn, &[found.id]).await?;
                Ok(Ok(digest_dto(&found, &evidence)))
            })
        })
        .await;

    Ok(Json(DigestResponse {
        digest: settle_mem("memory.get_digest", outcome)?,
    }))
}

/// `GET /v1/workspaces/{ws}/agent-runs/{run}/memory-receipt`
pub async fn get_receipt(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, run)): Path<(String, String)>,
) -> Result<Json<ReceiptResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let run_id = path_uuid(&run, "invalid run id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<(MemServing, Vec<MemDigest>, Vec<MemEvidence>)> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(serving) = get_serving_in_tx(conn, run_id).await? else {
                    return Ok(Err(ApiError::not_found(RECEIPT_NOT_FOUND)));
                };
                let digests = digests_by_ids_in_tx(conn, &serving.digest_ids).await?;
                let ids: Vec<Uuid> = digests.iter().map(|digest| digest.id).collect();
                let evidence = evidence_for_digests_in_tx(conn, &ids).await?;
                Ok(Ok((serving, digests, evidence)))
            })
        })
        .await;

    let (serving, digests, evidence) = settle_mem("memory.get_receipt", outcome)?;
    Ok(Json(ReceiptResponse {
        receipt: ReceiptDto {
            run_id: serving.run_id.to_string(),
            channel_id: serving.channel_id.to_string(),
            served_count: (serving.digest_ids.len() + serving.item_ids.len()) as i32,
            digest_ids: digests.iter().map(|digest| digest.id.to_string()).collect(),
            digests: digests
                .iter()
                .map(|digest| digest_dto(digest, &evidence))
                .collect(),
            withheld_count: serving.withheld_count,
            budget_chars: serving.budget_chars,
            used_chars: serving.used_chars,
            created_at_ms: epoch_ms(serving.created_at),
        },
    }))
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

fn settings_response(rows: &[MemSettingsRow]) -> MemorySettingsResponse {
    MemorySettingsResponse {
        workspace: workspace_settings_dto(rows.iter().find(|row| row.scope == "workspace")),
        channels: rows
            .iter()
            .filter(|row| row.scope == "channel")
            .filter_map(channel_settings_dto)
            .collect(),
        me: MemberMemorySettingsDto {
            paused: rows
                .iter()
                .find(|row| row.scope == "member")
                .is_some_and(|row| row.paused),
        },
    }
}

/// `GET /v1/workspaces/{ws}/memory/settings`
pub async fn get_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<MemorySettingsResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<MemSettingsRow>> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                Ok(Ok(list_settings_in_tx(conn).await?))
            })
        })
        .await;

    Ok(Json(settings_response(&settle_mem(
        "memory.get_settings",
        outcome,
    )?)))
}

/// `PATCH /v1/workspaces/{ws}/memory/settings` — workspace switch. Admin only
/// (the write policy: `mem_is_workspace_admin()`), otherwise 403.
pub async fn patch_workspace_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PatchWorkspaceSettingsRequest>,
) -> Result<Json<WorkspaceMemorySettingsDto>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    if request.enabled.is_none() && request.paused.is_none() {
        return Err(ApiError::bad_request("enabled or paused is required"));
    }
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MemSettingsRow> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let saved = upsert_workspace_settings_in_tx(
                    conn,
                    workspace_id,
                    request.enabled,
                    request.paused,
                )
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "memory.settings.updated")
                        .by(member_id)
                        .target("workspace", workspace_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.memory.settings.updated.v1",
                            serde_json::json!({
                                "scope": "workspace",
                                "enabled": saved.enabled,
                                "paused": saved.paused,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    Ok(Json(workspace_settings_dto(Some(&settle_mem(
        "memory.patch_workspace_settings",
        outcome,
    )?))))
}

/// `PATCH /v1/workspaces/{ws}/channels/{ch}/memory/settings` — exclude / pause a
/// channel. Workspace or channel admin who can read the channel; otherwise 403
/// (also for an unreadable or nonexistent channel — the two are not told apart).
pub async fn patch_channel_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<PatchChannelSettingsRequest>,
) -> Result<Json<ChannelMemorySettingsDto>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    if request.excluded.is_none() && request.paused.is_none() {
        return Err(ApiError::bad_request("excluded or paused is required"));
    }
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MemSettingsRow> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let saved = upsert_channel_settings_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    request.excluded,
                    request.paused,
                )
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "memory.settings.updated")
                        .by(member_id)
                        .target("channel", channel_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.memory.settings.updated.v1",
                            serde_json::json!({
                                "scope": "channel",
                                "excluded": saved.excluded,
                                "paused": saved.paused,
                            }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let saved = settle_mem("memory.patch_channel_settings", outcome)?;
    Ok(Json(ChannelMemorySettingsDto {
        channel_id: channel_id.to_string(),
        excluded: saved.excluded,
        paused: saved.paused,
    }))
}

/// `PATCH /v1/workspaces/{ws}/memory/settings/me` — the caller's own pause. The
/// member is the credential's; the body has no member field (and rejects
/// unknown ones), and the write policy pins the row to `app.member_id`.
pub async fn patch_member_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<PatchMemberSettingsRequest>,
) -> Result<Json<MemberMemorySettingsDto>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MemSettingsRow> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let saved =
                    upsert_member_settings_in_tx(conn, workspace_id, member_id, request.paused)
                        .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "memory.settings.updated")
                        .by(member_id)
                        .target("member", member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.memory.settings.updated.v1",
                            serde_json::json!({ "scope": "member", "paused": saved.paused }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let saved = settle_mem("memory.patch_member_settings", outcome)?;
    Ok(Json(MemberMemorySettingsDto {
        paused: saved.paused,
    }))
}

// ---------------------------------------------------------------------------
// memory browser: items (#3208, ADR-0196 D9 / D12 V4)
// ---------------------------------------------------------------------------
//
// Reads are RLS only and answer **no existence oracle**: an item the caller may not read is absent
// from a list and a 404 on a detail / evidence / events / edit / forget call — byte-identical to a
// nonexistent id (#3199 F1). Read and audit errors are 500s: the SQLSTATE → HTTP table of
// [`mem_db_error`] is for the settings writes only (#3189 M-2), and the two item writes map their
// own definer function's codes at the call site ([`map_item_write_error`]) and nowhere else.

const ITEM_NOT_FOUND: &str = "memory item not found";
const ITEM_BODY_MAX_CHARS: usize = 600;

/// Reads (and audits): any database error is an internal error, never a policy answer.
fn settle_mem_read<T>(context: &str, outcome: DbRejectable<T>) -> Result<T, ApiError> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(rejection)) => Err(rejection),
        Err(error) => Err(ApiError::internal(context, error)),
    }
}

/// SQLSTATE → HTTP for `mem_edit_item` / `mem_forget_item` **only**, applied to that one call.
/// `None` = not one of theirs → the caller propagates the error (500).
fn map_item_write_error(error: &DbError) -> Option<ApiError> {
    let DbError::Sqlx(momo_db::sqlx::Error::Database(db)) = error else {
        return None;
    };
    Some(match db.code().as_deref()? {
        // Not an active human of this workspace / not the API session.
        "42501" => ApiError::forbidden("not allowed to change memory items"),
        // Missing **or unreadable** — one answer, so existence never leaks.
        "P0002" => ApiError::not_found(ITEM_NOT_FOUND),
        // Readable but not changeable in its current state (already retired / a newer version).
        "55000" => ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "memory item is no longer current; reload it",
        ),
        // Same live item already exists.
        "23505" => ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "an identical memory item already exists",
        ),
        // Nothing changed / a value the schema rejects (length, kind, credential-shaped text).
        "22023" | "23514" => ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "memory item text or kind is not allowed",
        ),
        _ => return None,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    pub id: String,
    pub channel_id: String,
    /// `channel` | `personal`.
    pub space_kind: String,
    pub kind: String,
    pub origin: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_key: Option<String>,
    pub valid_from_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_to_ms: Option<i64>,
    pub recorded_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by_id: Option<String>,
    pub confidence: f32,
    pub source_count: i32,
    /// Search results only: the keyword score, best first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

fn item_dto(item: &MemItem, score: Option<f32>) -> ItemDto {
    ItemDto {
        id: item.id.to_string(),
        channel_id: item.channel_id.to_string(),
        space_kind: item.space_kind.clone(),
        kind: item.kind.clone(),
        origin: item.origin.clone(),
        body: item.body.clone(),
        subject_key: item.subject_key.clone(),
        valid_from_ms: epoch_ms(item.valid_from),
        valid_to_ms: item.valid_to.map(epoch_ms),
        recorded_at_ms: epoch_ms(item.recorded_at),
        retired_at_ms: item.retired_at.map(epoch_ms),
        retired_reason: item.retired_reason.clone(),
        supersedes_id: item.supersedes_id.map(|id| id.to_string()),
        superseded_by_id: item.superseded_by_id.map(|id| id.to_string()),
        confidence: item.confidence,
        source_count: item.source_count,
        score,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEvidenceDto {
    pub message_id: String,
    pub channel_id: String,
    pub seq: i64,
}

fn item_evidence_dtos(evidence: &[MemItemEvidence], item_id: Uuid) -> Vec<ItemEvidenceDto> {
    evidence
        .iter()
        .filter(|link| link.item_id == item_id)
        .map(|link| ItemEvidenceDto {
            message_id: link.message_id.to_string(),
            channel_id: link.channel_id.to_string(),
            seq: link.seq,
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEventDto {
    pub id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_member_id: Option<String>,
    /// Ids, kinds and counts only — the ledger never holds memory text.
    pub detail: serde_json::Value,
    pub created_at_ms: i64,
}

fn item_event_dto(event: &MemItemEvent) -> ItemEventDto {
    ItemEventDto {
        id: event.id.to_string(),
        action: event.action.clone(),
        actor_member_id: event.actor_member_id.map(|id| id.to_string()),
        detail: event.detail.clone(),
        created_at_ms: epoch_ms(event.created_at),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItemsQuery {
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    /// `active` (default) | `history` | `all`.
    #[serde(default)]
    pub status: Option<String>,
    /// Keyword search. Ranked by score, at most 50 hits, no cursor; live items only.
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemListResponse {
    pub items: Vec<ItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetailResponse {
    pub item: ItemDto,
    pub evidence: Vec<ItemEvidenceDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEvidenceResponse {
    pub evidence: Vec<ItemEvidenceDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEventsResponse {
    pub events: Vec<ItemEventDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditItemRequest {
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditItemResponse {
    /// The new (curated) item.
    pub item: ItemDto,
    pub evidence: Vec<ItemEvidenceDto>,
    /// The item it replaced (now retired as `edited`, kept as history).
    pub superseded_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetItemResponse {
    /// Item rows permanently removed: the item plus its older versions.
    pub forgotten_count: i32,
}

/// `"<recordedAtMicros>.<itemId>"` — the last item of the previous page.
fn parse_item_cursor(raw: &str) -> Result<(chrono::DateTime<chrono::Utc>, Uuid), ApiError> {
    let invalid = || ApiError::bad_request("invalid memory cursor");
    let (micros, id) = raw.split_once('.').ok_or_else(invalid)?;
    let at = micros
        .parse::<i64>()
        .ok()
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_micros)
        .ok_or_else(invalid)?;
    Ok((at, Uuid::parse_str(id).map_err(|_| invalid())?))
}

fn item_cursor(item: &MemItem) -> String {
    format!("{}.{}", item.recorded_at.timestamp_micros(), item.id)
}

fn trimmed(raw: &Option<String>) -> Option<&str> {
    raw.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// `GET /v1/workspaces/{ws}/memory/items`
///
/// The memory browser's list: newest first with a keyset cursor, filtered by `channelId`, `kind`
/// and `status`; or, with `q`, the keyword search (`mem_search_items`, ranked, no cursor). A
/// channel the caller cannot read, or one with nothing readable, is an empty list — never an
/// error and never a hint that hidden items exist.
pub async fn list_items(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ListItemsQuery>,
) -> Result<Json<ItemListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = match trimmed(&query.channel_id) {
        Some(raw) => Some(path_uuid(raw, "invalid channel id")?),
        None => None,
    };
    let kind = match trimmed(&query.kind) {
        None => None,
        Some(kind) if MEM_ITEM_KINDS.contains(&kind) => Some(kind.to_string()),
        Some(_) => {
            return Err(ApiError::bad_request(
                "kind must be decision, fact, commitment, preference or procedure",
            ))
        }
    };
    let status = match trimmed(&query.status) {
        None => ItemStatus::Active,
        Some(raw) => ItemStatus::parse(raw)
            .ok_or_else(|| ApiError::bad_request("status must be active, history or all"))?,
    };
    let search = trimmed(&query.q).map(str::to_string);
    if search.is_some() && !matches!(status, ItemStatus::Active) {
        return Err(ApiError::bad_request(
            "search covers current items only; drop status or use active",
        ));
    }
    if search.is_some() && trimmed(&query.cursor).is_some() {
        return Err(ApiError::bad_request("a search has no cursor"));
    }
    let before = match trimmed(&query.cursor) {
        Some(raw) => Some(parse_item_cursor(raw)?),
        None => None,
    };
    let requested = query.limit.as_deref().and_then(|raw| raw.parse().ok());
    let limit = clamp_mem_item_limit(requested);
    let member_id = principal.member_id;

    let outcome: DbRejectable<ItemListResponse> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                if let Some(text) = search {
                    let hits = search_item_rows_in_tx(
                        conn,
                        &text,
                        channel_id,
                        kind.as_deref(),
                        Some(limit),
                    )
                    .await?;
                    return Ok(Ok(ItemListResponse {
                        items: hits
                            .iter()
                            .map(|(item, score)| item_dto(item, Some(*score)))
                            .collect(),
                        next_cursor: None,
                    }));
                }
                let mut rows = list_items_in_tx(
                    conn,
                    &ItemListFilter {
                        channel_id,
                        kind: kind.as_deref(),
                        status,
                        before,
                        limit: limit + 1,
                    },
                )
                .await?;
                let next_cursor = if rows.len() as i64 > limit {
                    rows.pop();
                    rows.last().map(item_cursor)
                } else {
                    None
                };
                Ok(Ok(ItemListResponse {
                    items: rows.iter().map(|item| item_dto(item, None)).collect(),
                    next_cursor,
                }))
            })
        })
        .await;

    Ok(Json(settle_mem_read("memory.list_items", outcome)?))
}

/// `GET /v1/workspaces/{ws}/memory/items/{id}`
pub async fn get_item(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
) -> Result<Json<ItemDetailResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let item_id = path_uuid(&item, "invalid item id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<ItemDetailResponse> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(found) = get_item_in_tx(conn, item_id).await? else {
                    return Ok(Err(ApiError::not_found(ITEM_NOT_FOUND)));
                };
                let evidence = evidence_for_items_in_tx(conn, &[found.id]).await?;
                Ok(Ok(ItemDetailResponse {
                    item: item_dto(&found, None),
                    evidence: item_evidence_dtos(&evidence, found.id),
                }))
            })
        })
        .await;

    Ok(Json(settle_mem_read("memory.get_item", outcome)?))
}

/// `GET /v1/workspaces/{ws}/memory/items/{id}/evidence` — the source messages (ids, channel, seq)
/// a reader can jump back to. Never message text.
pub async fn get_item_evidence(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
) -> Result<Json<ItemEvidenceResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let item_id = path_uuid(&item, "invalid item id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<ItemEvidenceResponse> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let Some(found) = get_item_in_tx(conn, item_id).await? else {
                    return Ok(Err(ApiError::not_found(ITEM_NOT_FOUND)));
                };
                let evidence = evidence_for_items_in_tx(conn, &[found.id]).await?;
                Ok(Ok(ItemEvidenceResponse {
                    evidence: item_evidence_dtos(&evidence, found.id),
                }))
            })
        })
        .await;

    Ok(Json(settle_mem_read("memory.get_item_evidence", outcome)?))
}

/// `GET /v1/workspaces/{ws}/memory/items/{id}/events` — the lifecycle ledger of one item, oldest
/// first (`created`, `edited`, `superseded`, ...). The `mem_event` policy shows an item's events
/// only to someone who can read the item; a hidden item is a 404 like everywhere else.
pub async fn get_item_events(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
) -> Result<Json<ItemEventsResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let item_id = path_uuid(&item, "invalid item id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<ItemEventsResponse> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                if get_item_in_tx(conn, item_id).await?.is_none() {
                    return Ok(Err(ApiError::not_found(ITEM_NOT_FOUND)));
                }
                let events = list_item_events_in_tx(conn, item_id).await?;
                Ok(Ok(ItemEventsResponse {
                    events: events.iter().map(item_event_dto).collect(),
                }))
            })
        })
        .await;

    Ok(Json(settle_mem_read("memory.get_item_events", outcome)?))
}

/// `PATCH /v1/workspaces/{ws}/memory/items/{id}` — edit (ADR-0196 D4/D9): a new `curated` item
/// with the old one's evidence supersedes the old one, which is retired as `edited` and stays as
/// history. Who may: a member who can read the item and all its evidence channels (D9 「근거 채널
/// 멤버」; the personal space's owner). Anyone else — and a nonexistent id — gets the same 404.
pub async fn edit_item(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
    Json(request): Json<EditItemRequest>,
) -> Result<Json<EditItemResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let item_id = path_uuid(&item, "invalid item id")?;
    let body = request.body.trim().to_string();
    if body.is_empty() || body.chars().count() > ITEM_BODY_MAX_CHARS {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "memory item text must be 1 to 600 characters",
        ));
    }
    let kind = match request.kind.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(kind) if MEM_ITEM_KINDS.contains(&kind) => Some(kind.to_string()),
        Some(_) => {
            return Err(ApiError::bad_request(
                "kind must be decision, fact, commitment, preference or procedure",
            ))
        }
    };
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<(MemItem, Vec<MemItemEvidence>)> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let new_id = match edit_item_in_tx(conn, item_id, &body, kind.as_deref()).await {
                    Ok(id) => id,
                    Err(error) => {
                        return match map_item_write_error(&error) {
                            Some(rejection) => Ok(Err(rejection)),
                            None => Err(error),
                        }
                    }
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "memory.item.edited")
                        .by(member_id)
                        .target("memory_item", new_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.memory.item.edited.v1",
                            serde_json::json!({ "supersedes": item_id }),
                        ),
                )
                .await?;
                let Some(created) = get_item_in_tx(conn, new_id).await? else {
                    // The editor can read what they just wrote; anything else is a bug.
                    return Err(DbError::from(momo_db::sqlx::Error::RowNotFound));
                };
                let evidence = evidence_for_items_in_tx(conn, &[created.id]).await?;
                Ok(Ok((created, evidence)))
            })
        })
        .await;

    let (created, evidence) = settle_mem_read("memory.edit_item", outcome)?;
    Ok(Json(EditItemResponse {
        evidence: item_evidence_dtos(&evidence, created.id),
        item: item_dto(&created, None),
        superseded_id: item_id.to_string(),
    }))
}

/// `DELETE /v1/workspaces/{ws}/memory/items/{id}` — forget (ADR-0196 D9/D10): the item and its
/// older versions are permanently deleted with their evidence links; only ids stay in the ledger.
/// Same permission and the same 404 as [`edit_item`]. An older version that a newer one replaced
/// is a 409 ("forget the newest version").
pub async fn forget_item(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, item)): Path<(String, String)>,
) -> Result<Json<ForgetItemResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let item_id = path_uuid(&item, "invalid item id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<i32> =
        memory_tenant_tx(&state.pool, workspace_id, member_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let removed = match forget_item_in_tx(conn, item_id).await {
                    Ok(count) => count,
                    Err(error) => {
                        return match map_item_write_error(&error) {
                            Some(rejection) => Ok(Err(rejection)),
                            None => Err(error),
                        }
                    }
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "memory.item.forgotten")
                        .by(member_id)
                        .target("memory_item", item_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.memory.item.forgotten.v1",
                            serde_json::json!({ "versions": removed }),
                        ),
                )
                .await?;
                Ok(Ok(removed))
            })
        })
        .await;

    Ok(Json(ForgetItemResponse {
        forgotten_count: settle_mem_read("memory.forget_item", outcome)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let id = Uuid::new_v4();
        assert_eq!(parse_cursor(&format!("42.{id}")).unwrap(), (42, id));
        for bad in ["", "42", "x.y", "42.not-a-uuid", ".."] {
            assert!(parse_cursor(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn bool_query_accepts_true_false_and_rejects_the_rest() {
        assert!(!parse_bool(None, "x").unwrap());
        assert!(parse_bool(Some("true"), "x").unwrap());
        assert!(parse_bool(Some("1"), "x").unwrap());
        assert!(!parse_bool(Some("false"), "x").unwrap());
        assert!(parse_bool(Some("yes"), "x").is_err());
    }

    #[test]
    fn item_cursor_round_trips_and_rejects_garbage() {
        let id = Uuid::new_v4();
        let (at, parsed) = parse_item_cursor(&format!("1700000000123456.{id}")).unwrap();
        assert_eq!(parsed, id);
        assert_eq!(at.timestamp_micros(), 1_700_000_000_123_456);
        for bad in ["", "1", "x.y", "1700000000123456.not-a-uuid", "..", ".x"] {
            assert!(parse_item_cursor(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn absent_workspace_row_means_defaults() {
        let dto = workspace_settings_dto(None);
        assert!(dto.enabled && !dto.paused && dto.reset_epoch == 0);
    }
}
