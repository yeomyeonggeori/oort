//! Team board reads (#3322, serves #2863): `GET …/work-sessions/shared` (list)
//! and `GET …/work-sessions/{session}/shared` (one).
//!
//! ADR-0190 D4 / Q4 and ADR-0194. The write side is `PATCH …/share` (#2862,
//! host-signed); this is its read side, for people.
//!
//! * **Human bearer only.** A host signature or agent token is 403 here (a host
//!   can write its own share, never read the board).
//! * **Membership is decided in SQL** (`momo_t3::work_board`): only sessions
//!   whose home channel the viewer is an active member of. There is no
//!   workspace-wide view. A single read that the viewer may not see — not a
//!   member, never shared, unshared, ended past retention, nonexistent, or
//!   another tenant's id under RLS — is **the same 404 with the same body**,
//!   produced by the same code path (no 403 that says "it exists").
//! * **No totals.** A page reports `nextCursor` only when more rows follow; the
//!   count of rows the viewer cannot see is never observable.
//! * **Realtime is event → refetch.** `work.session.share_changed` carries only
//!   the session id and the kind; a client that receives one re-reads this
//!   endpoint. Nothing in the event is trusted as board content.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_t3::work_board::{
    get_board_item_in_tx, list_board_in_tx, BoardCursor, BoardItem, BoardSource, DEFAULT_PAGE,
    MAX_PAGE,
};
use uuid::Uuid;

use crate::dto::{
    SharedDiffDto, SharedPrDto, SharedSessionChannelDto, SharedSessionOwnerDto,
    SharedWorkSessionDto, SharedWorkSessionListQuery, SharedWorkSessionListResponse,
    SharedWorkSessionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, settle, tenant_tx, workspace_scope};
use crate::AppState;

/// One message for every reason the viewer cannot see a single session.
pub const NOT_FOUND: &str = "shared work session not found";

pub fn encode_cursor(cursor: BoardCursor) -> String {
    format!("{}_{}", cursor.activity_us, cursor.session_id)
}

/// Strict: `<non-negative µs>_<hyphenated uuid>` or 400.
pub fn decode_cursor(raw: &str) -> Result<BoardCursor, ApiError> {
    let invalid = || ApiError::bad_request("invalid cursor");
    let (us, id) = raw.split_once('_').ok_or_else(invalid)?;
    if us.is_empty() || us.len() > 19 || !us.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let activity_us: i64 = us.parse().map_err(|_| invalid())?;
    let session_id = Uuid::parse_str(id).map_err(|_| invalid())?;
    if id.len() != 36 {
        return Err(invalid());
    }
    Ok(BoardCursor {
        activity_us,
        session_id,
    })
}

/// Lenient like the message-history page size: a bad size has a safe default.
fn page_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|text| text.parse::<i64>().ok())
        .map(|value| value.clamp(1, MAX_PAGE))
        .unwrap_or(DEFAULT_PAGE)
}

fn dto(item: BoardItem) -> SharedWorkSessionDto {
    let is_run = item.source == BoardSource::Run;
    let run = item.run;
    let pr = match (is_run, item.pr_url.as_ref()) {
        (true, Some(url)) => Some(SharedPrDto {
            url: url.clone(),
            number: run.as_ref().and_then(|run| run.pr_number),
        }),
        _ => None,
    };
    SharedWorkSessionDto {
        source: item.source.as_str(),
        session_id: (!is_run).then(|| item.session_id.to_string()),
        run_id: run.as_ref().map(|run| run.run_id.to_string()),
        requested_by: run.as_ref().and_then(|run| {
            run.requested_by
                .as_ref()
                .map(|(member_id, display_name)| SharedSessionOwnerDto {
                    member_id: member_id.to_string(),
                    display_name: display_name.clone(),
                })
        }),
        step_count: run.as_ref().map(|run| run.step_count),
        commits: run.as_ref().and_then(|run| run.commits),
        pr,
        origin: item.origin,
        label: item.label,
        folder_label: item.folder_label,
        status: item.status,
        owner: SharedSessionOwnerDto {
            member_id: item.owner_member_id.to_string(),
            display_name: item.owner_display_name,
        },
        home_channel: SharedSessionChannelDto {
            id: item.channel_id.to_string(),
            name: item.channel_name,
        },
        started_at_ms: item.started_at_ms,
        ended_at_ms: item.ended_at_ms,
        shared_at_ms: item.shared_at_ms,
        repo: item.repo,
        branch: item.branch,
        harness: item.harness,
        state: item.state,
        stages: item.stages,
        diff: SharedDiffDto {
            added: item.diff.added,
            deleted: item.diff.deleted,
            files: item.diff.files,
            ahead: item.diff.ahead,
            behind: item.diff.behind,
            uncommitted: item.diff.uncommitted,
        },
        pr_url: item.pr_url,
        last_activity_at: item.last_activity_at,
    }
}

/// `GET /v1/workspaces/{ws}/work-sessions/shared?limit=&cursor=`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<SharedWorkSessionListQuery>,
) -> Result<Json<SharedWorkSessionListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the team board requires a signed-in member")?;
    let after = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = page_limit(query.limit.as_deref());
    let include_runs = query.include.as_deref() == Some("runs");
    let viewer = principal.member_id;

    let page = settle(
        "work_board.list",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(list_board_in_tx(
                    conn,
                    workspace_id,
                    viewer,
                    include_runs,
                    after,
                    limit,
                )
                .await?))
            })
        })
        .await,
    )?;
    Ok(Json(SharedWorkSessionListResponse {
        next_cursor: page.next.map(encode_cursor),
        sessions: page.items.into_iter().map(dto).collect(),
    }))
}

/// `GET /v1/workspaces/{ws}/work-sessions/{session}/shared`
pub async fn get_one(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
) -> Result<Json<SharedWorkSessionResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the team board requires a signed-in member")?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let viewer = principal.member_id;

    let item = settle(
        "work_board.get",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(get_board_item_in_tx(
                    conn,
                    workspace_id,
                    viewer,
                    session_id,
                )
                .await?))
            })
        })
        .await,
    )?;
    match item {
        Some(item) => Ok(Json(SharedWorkSessionResponse { session: dto(item) })),
        None => Err(ApiError::not_found(NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_garbage_is_a_400() {
        let cursor = BoardCursor {
            activity_us: 1_790_000_000_123_456,
            session_id: Uuid::from_u128(7),
        };
        assert_eq!(decode_cursor(&encode_cursor(cursor)).unwrap(), cursor);
        for bad in [
            "",
            "x",
            "1_",
            "_1",
            "-1_00000000-0000-0000-0000-000000000007",
            "1_0000000000000000000000000000000007",
            "99999999999999999999_00000000-0000-0000-0000-000000000007",
            "1_00000000-0000-0000-0000-000000000007_",
        ] {
            let error = decode_cursor(bad).expect_err(bad);
            assert_eq!(error.message, "invalid cursor", "{bad}");
        }
    }

    #[test]
    fn page_size_clamps_and_defaults() {
        assert_eq!(page_limit(None), DEFAULT_PAGE);
        assert_eq!(page_limit(Some("abc")), DEFAULT_PAGE);
        assert_eq!(page_limit(Some("0")), 1);
        assert_eq!(page_limit(Some("100000")), MAX_PAGE);
        assert_eq!(page_limit(Some("7")), 7);
    }
}
