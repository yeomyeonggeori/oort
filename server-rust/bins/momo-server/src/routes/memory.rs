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
    bind_mem_reader_guc, clamp_mem_digest_limit, digests_by_ids_in_tx, evidence_for_digests_in_tx,
    get_digest_in_tx, get_serving_in_tx, last_read_seq_in_tx, list_digests_in_tx,
    list_settings_in_tx, summarized_through_seq_in_tx, upsert_channel_settings_in_tx,
    upsert_member_settings_in_tx, upsert_workspace_settings_in_tx, DigestListFilter, MemDigest,
    MemEvidence, MemServing, MemSettingsRow,
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
    fn absent_workspace_row_means_defaults() {
        let dto = workspace_settings_dto(None);
        assert!(dto.enabled && !dto.paused && dto.reset_epoch == 0);
    }
}
