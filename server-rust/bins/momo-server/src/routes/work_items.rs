//! 작업 원장 1 (#6066, ADR-0222 D2·데이터 계약) — 번호로 부르는 작업.
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-items                      {title, homeChannelId}  → 201 {workItem}
//! GET  /v1/workspaces/{ws}/work-items?cursor=&limit=                               → 200 {workItems, nextCursor}
//! GET  /v1/workspaces/{ws}/work-items/{number}                                     → 200 {workItem}
//! POST /v1/workspaces/{ws}/work-items/{number}/close        {state: done|cancelled} → 200 {workItem}
//! PUT  /v1/workspaces/{ws}/work-items/{number}/assignee     {memberId}             → 200 {workItem}
//! ```
//!
//! Decisions a reader will look for:
//!
//! * **People only, twice over.** No path here is on the agent table
//!   (`momo_auth::required_agent_scope`), the developer-token table or the signed work-host list,
//!   so the middleware refuses those credentials before routing. `require_human` runs first in
//!   every handler as the second layer (`tests/work_item_gates.rs` drives the handlers with no
//!   middleware in front). Agents creating work is a later piece (ADR-0222 증보 E4, 결정-1).
//! * **The server names the requester.** The create body is closed (`deny_unknown_fields`):
//!   `requestedBy`, `onBehalfOf`, `assignee` or an actor field is a 400 before any
//!   connection. Requester, on-behalf-of, creator and assignee are all the authenticated caller
//!   (ADR-0222 D2 「만들 때의 기본값은 만드는 사람」, 데이터 계약 「요청 본문에서 받지 않는다」).
//! * **The number comes from the database.** `work_item_assign_number` (migration 187) bumps the
//!   per-workspace counter row inside the insert, so no request can choose a number, and a refused
//!   or failed insert rolls the counter back with it: every refusal below is returned before the
//!   insert, so a refusal never burns a number.
//! * **One visibility predicate, one 404.** A work item is visible to an active member of its
//!   home channel (not archived) — ADR-0222 D2, the same rule as the team board. Every read and
//!   every write starts from [`VISIBLE_ITEM`]; a number the caller cannot see, a number that
//!   does not exist and another workspace's number (RLS) are the same 404 with the same body.
//!   Authority (close, reassign) is judged only after visibility: the assignee or a workspace
//!   owner/admin (ADR-0222 미결 7 의 지금 값), anyone else who can see the item gets 403. An
//!   admin who is not in the home channel cannot see the item and gets the 404.
//! * **The new assignee is a person who can see the item.** An active human member of the home
//!   channel who is not a workspace guest; an agent, a guest, an unknown id and another
//!   workspace's id are one 400. A guest cannot create a work item either (403, nothing written) —
//!   a guest neither creates nor owns work (planner decision on #6066's security review r1 M3);
//!   reading what their channels hold is unchanged. The database
//!   trigger (`work_item_people_guard`) refuses an agent assignee even without this check.
//! * **No realtime frame yet.** The progress log and its thin frame are 원장-2 (ADR-0222 D3); no
//!   outbox row is written here.

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx;
use momo_db::PgConnection;
use serde_json::json;
use uuid::Uuid;

use crate::dto::{
    CloseWorkItemRequest, CreateWorkItemRequest, SetWorkItemAssigneeRequest, WorkItemDto,
    WorkItemListQuery, WorkItemListResponse, WorkItemResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, epoch_ms, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "work items require a signed-in person";
const NOT_FOUND: &str = "work item not found";
const CHANNEL_NOT_FOUND: &str = "channel not found";
const NOT_ALLOWED: &str = "only the assignee or a workspace admin can do this";
const BAD_ASSIGNEE: &str = "assignee must be a person in the work item's channel";
const GUEST_NOT_ALLOWED: &str = "workspace guests cannot create work items";

/// Title limit (ADR-0222 데이터 계약 「제목(1~200자, 제어·서식 문자 금지)」).
pub const TITLE_MAX_CHARS: usize = 200;
pub const DEFAULT_PAGE: i64 = 50;
pub const MAX_PAGE: i64 = 100;

/// The visibility predicate every route here starts from. `$1` is the workspace, `$2` the
/// viewer. Same shape as the team board's (`momo_t3::work_board`): the home channel is not
/// archived, the viewer sits in it, and the viewer is an active member.
const VISIBLE_ITEM: &str = "FROM work_item w \
    JOIN channel c \
      ON c.workspace_id = w.workspace_id AND c.id = w.home_channel_id AND c.archived_at IS NULL \
    JOIN membership ms \
      ON ms.workspace_id = w.workspace_id AND ms.channel_id = w.home_channel_id \
     AND ms.member_id = $2 AND ms.left_at IS NULL \
    JOIN member v \
      ON v.workspace_id = w.workspace_id AND v.id = ms.member_id \
     AND v.status = 'active' AND v.deleted_at IS NULL \
   WHERE w.workspace_id = $1";

const ITEM_COLUMNS: &str = "w.id, w.number, w.title, w.home_channel_id, w.state, \
    w.assignee_member_id, w.doer_member_id, w.requested_by_member_id, \
    w.on_behalf_of_member_id, w.created_by_member_id, w.created_at, w.closed_at, \
    w.closed_by_member_id";

type ItemRow = (
    Uuid,
    i64,
    String,
    Uuid,
    String,
    Uuid,
    Option<Uuid>,
    Uuid,
    Uuid,
    Uuid,
    chrono::DateTime<chrono::Utc>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<Uuid>,
);

fn dto(row: ItemRow) -> WorkItemDto {
    let (
        id,
        number,
        title,
        home_channel_id,
        state,
        assignee,
        doer,
        requested_by,
        on_behalf_of,
        created_by,
        created_at,
        closed_at,
        closed_by,
    ) = row;
    WorkItemDto {
        id: id.to_string(),
        number,
        title,
        home_channel_id: home_channel_id.to_string(),
        state,
        assignee_member_id: assignee.to_string(),
        doer_member_id: doer.map(|id| id.to_string()),
        requested_by_member_id: requested_by.to_string(),
        on_behalf_of_member_id: on_behalf_of.to_string(),
        created_by_member_id: created_by.to_string(),
        created_at_ms: epoch_ms(created_at),
        closed_at_ms: closed_at.map(epoch_ms),
        closed_by_member_id: closed_by.map(|id| id.to_string()),
    }
}

/// `{number}` is a positive decimal without sign or leading zero that fits an i64. Anything else
/// is a 400 that says nothing about which numbers exist.
fn parse_number(raw: &str) -> Result<i64, ApiError> {
    let well_formed = !raw.is_empty()
        && raw.len() <= 19
        && raw.bytes().all(|b| b.is_ascii_digit())
        && !raw.starts_with('0');
    well_formed
        .then(|| raw.parse::<i64>().ok())
        .flatten()
        .ok_or_else(|| ApiError::bad_request("invalid work item number"))
}

fn body_error(message: &'static str) -> impl FnOnce(JsonRejection) -> ApiError {
    move |_rejection| ApiError::bad_request(message)
}

/// The visible item, locked for an update when `for_update`. `None` is every case the caller may
/// not tell apart: no such number, not visible, another workspace (RLS).
async fn visible_item_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer: Uuid,
    number: i64,
    for_update: bool,
) -> Result<Option<ItemRow>, sqlx::Error> {
    let lock = if for_update { " FOR UPDATE OF w" } else { "" };
    let sql = format!("SELECT {ITEM_COLUMNS} {VISIBLE_ITEM} AND w.number = $3{lock}");
    sqlx::query_as::<_, ItemRow>(&sql)
        .bind(workspace_id)
        .bind(viewer)
        .bind(number)
        .fetch_optional(&mut *conn)
        .await
}

/// Close and reassign: the assignee or a workspace owner/admin (ADR-0222 데이터 계약, 미결 7).
async fn may_steer_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    caller: Uuid,
    assignee: Uuid,
) -> Result<bool, sqlx::Error> {
    if caller == assignee {
        return Ok(true);
    }
    Ok(momo_auth::active_workspace_role(conn, workspace_id, caller)
        .await?
        .is_some_and(|role| role.is_admin()))
}

/// `POST /v1/workspaces/{ws}/work-items` → 201.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    body: Result<Json<CreateWorkItemRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<WorkItemResponse>), ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let Json(request) = body.map_err(body_error(
        "body must be {title, homeChannelId} and nothing else",
    ))?;
    let title =
        momo_wire::report_text::checked_text(&request.title, TITLE_MAX_CHARS).map_err(|_| {
            ApiError::bad_request(
                "title must be 1...200 characters without control or invisible characters",
            )
        })?;
    let home_channel_id = Uuid::parse_str(&request.home_channel_id)
        .map_err(|_| ApiError::bad_request("invalid homeChannelId"))?;
    let caller = principal.member_id;
    let via_token = principal.token_id;

    let row = settle_db(
        "work_items.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                create_in_tx(
                    conn,
                    workspace_id,
                    caller,
                    via_token,
                    home_channel_id,
                    title,
                )
                .await
            })
        })
        .await,
    )?;
    Ok((
        StatusCode::CREATED,
        Json(WorkItemResponse {
            work_item: dto(row),
        }),
    ))
}

async fn create_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    caller: Uuid,
    via_token: Option<Uuid>,
    home_channel_id: Uuid,
    title: String,
) -> DbRejectable<ItemRow> {
    // ---- refusals first: nothing (not even the counter) is written above this line ----
    // A workspace guest neither creates nor owns work items (planner decision on #6066 r1 M3). The
    // caller's own role, judged before any channel is read, so the answer says nothing about it.
    if momo_auth::active_workspace_role(conn, workspace_id, caller).await?
        == Some(momo_auth::WorkspaceRole::Guest)
    {
        return Ok(Err(ApiError::forbidden(GUEST_NOT_ALLOWED)));
    }
    let channel_visible: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM channel c \
             JOIN membership ms \
               ON ms.workspace_id = c.workspace_id AND ms.channel_id = c.id \
              AND ms.member_id = $3 AND ms.left_at IS NULL \
             JOIN member v \
               ON v.workspace_id = c.workspace_id AND v.id = ms.member_id \
              AND v.status = 'active' AND v.deleted_at IS NULL \
            WHERE c.workspace_id = $1 AND c.id = $2 AND c.archived_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(home_channel_id)
    .bind(caller)
    .fetch_one(&mut *conn)
    .await?;
    if !channel_visible {
        return Ok(Err(ApiError::not_found(CHANNEL_NOT_FOUND)));
    }

    // ---- write: the number is the trigger's, every person column is the caller ----
    let sql = format!(
        "WITH w AS ( \
           INSERT INTO work_item (workspace_id, number, home_channel_id, title, \
                                  assignee_member_id, requested_by_member_id, \
                                  on_behalf_of_member_id, created_by_member_id) \
           VALUES ($1, 0, $2, $3, $4, $4, $4, $4) \
           RETURNING * ) \
         SELECT {ITEM_COLUMNS} FROM w"
    );
    let row = sqlx::query_as::<_, ItemRow>(&sql)
        .bind(workspace_id)
        .bind(home_channel_id)
        .bind(&title)
        .bind(caller)
        .fetch_one(&mut *conn)
        .await?;
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, "work_item.created")
            .by(caller)
            .via_token(via_token)
            .target("work_item", row.0)
            .with_schema(
                "momo.work_item.created.v1",
                json!({ "number": row.1, "home_channel_id": home_channel_id.to_string() }),
            ),
    )
    .await?;
    Ok(Ok(row))
}

/// `GET /v1/workspaces/{ws}/work-items/{number}`.
pub async fn get_one(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, number)): Path<(String, String)>,
) -> Result<Json<WorkItemResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let number = parse_number(&number)?;
    let viewer = principal.member_id;
    let row = settle_db(
        "work_items.get",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(visible_item_in_tx(
                    conn,
                    workspace_id,
                    viewer,
                    number,
                    false,
                )
                .await?))
            })
        })
        .await,
    )?;
    row.map(|row| {
        Json(WorkItemResponse {
            work_item: dto(row),
        })
    })
    .ok_or_else(|| ApiError::not_found(NOT_FOUND))
}

/// `GET /v1/workspaces/{ws}/work-items?cursor=&limit=` — the items the caller can see, highest
/// number first. `cursor` is the last number of the previous page; there is no total.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    query: Result<Query<WorkItemListQuery>, QueryRejection>,
) -> Result<Json<WorkItemListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let Query(query) = query.map_err(|_| ApiError::bad_request("invalid query"))?;
    let before = query.cursor.as_deref().map(parse_number).transpose()?;
    let limit = match query.limit.as_deref() {
        None => DEFAULT_PAGE,
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|n| (1..=MAX_PAGE).contains(n))
            .ok_or_else(|| ApiError::bad_request("limit must be 1...100"))?,
    };
    let viewer = principal.member_id;
    let rows = settle_db(
        "work_items.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let sql = format!(
                    "SELECT {ITEM_COLUMNS} {VISIBLE_ITEM} \
                       AND ($3::bigint IS NULL OR w.number < $3) \
                     ORDER BY w.number DESC LIMIT $4"
                );
                let rows = sqlx::query_as::<_, ItemRow>(&sql)
                    .bind(workspace_id)
                    .bind(viewer)
                    .bind(before)
                    .bind(limit + 1)
                    .fetch_all(&mut *conn)
                    .await?;
                Ok(Ok(rows))
            })
        })
        .await,
    )?;
    let more = rows.len() as i64 > limit;
    let items: Vec<WorkItemDto> = rows.into_iter().take(limit as usize).map(dto).collect();
    let next_cursor = more
        .then(|| items.last().map(|item| item.number.to_string()))
        .flatten();
    Ok(Json(WorkItemListResponse {
        work_items: items,
        next_cursor,
    }))
}

/// `POST /v1/workspaces/{ws}/work-items/{number}/close` — 완료 or 취소, by the assignee or an admin.
pub async fn close(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, number)): Path<(String, String)>,
    body: Result<Json<CloseWorkItemRequest>, JsonRejection>,
) -> Result<Json<WorkItemResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let number = parse_number(&number)?;
    let Json(request) = body.map_err(body_error("body must be {state: done|cancelled}"))?;
    let target_state: &'static str = match request.state.as_str() {
        "done" => "done",
        "cancelled" => "cancelled",
        _ => {
            return Err(ApiError::bad_request(
                "body must be {state: done|cancelled}",
            ))
        }
    };
    let caller = principal.member_id;
    let via_token = principal.token_id;
    let row = settle_db(
        "work_items.close",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(item) =
                    visible_item_in_tx(conn, workspace_id, caller, number, true).await?
                else {
                    return Ok(Err(ApiError::not_found(NOT_FOUND)));
                };
                if !may_steer_in_tx(conn, workspace_id, caller, item.5).await? {
                    return Ok(Err(ApiError::forbidden(NOT_ALLOWED)));
                }
                if item.4 != "open" {
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "work item is already closed",
                    )));
                }
                let sql = format!(
                    "WITH w AS ( \
                       UPDATE work_item SET state = $3, closed_at = now(), \
                              closed_by_member_id = $4, updated_at = now() \
                        WHERE workspace_id = $1 AND id = $2 \
                       RETURNING * ) \
                     SELECT {ITEM_COLUMNS} FROM w"
                );
                let row = sqlx::query_as::<_, ItemRow>(&sql)
                    .bind(workspace_id)
                    .bind(item.0)
                    .bind(target_state)
                    .bind(caller)
                    .fetch_one(&mut *conn)
                    .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "work_item.closed")
                        .by(caller)
                        .via_token(via_token)
                        .target("work_item", item.0)
                        .with_schema(
                            "momo.work_item.closed.v1",
                            json!({ "number": item.1, "state": target_state }),
                        ),
                )
                .await?;
                Ok(Ok(row))
            })
        })
        .await,
    )?;
    Ok(Json(WorkItemResponse {
        work_item: dto(row),
    }))
}

/// `PUT /v1/workspaces/{ws}/work-items/{number}/assignee` — hand the item to another person.
pub async fn set_assignee(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, number)): Path<(String, String)>,
    body: Result<Json<SetWorkItemAssigneeRequest>, JsonRejection>,
) -> Result<Json<WorkItemResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let number = parse_number(&number)?;
    let Json(request) = body.map_err(body_error("body must be {memberId}"))?;
    let new_assignee =
        Uuid::parse_str(&request.member_id).map_err(|_| ApiError::bad_request(BAD_ASSIGNEE))?;
    let caller = principal.member_id;
    let via_token = principal.token_id;
    let row = settle_db(
        "work_items.set_assignee",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(item) =
                    visible_item_in_tx(conn, workspace_id, caller, number, true).await?
                else {
                    return Ok(Err(ApiError::not_found(NOT_FOUND)));
                };
                if !may_steer_in_tx(conn, workspace_id, caller, item.5).await? {
                    return Ok(Err(ApiError::forbidden(NOT_ALLOWED)));
                }
                let eligible: bool = sqlx::query_scalar(
                    "SELECT EXISTS ( \
                       SELECT 1 FROM member m \
                         JOIN membership ms \
                           ON ms.workspace_id = m.workspace_id AND ms.member_id = m.id \
                          AND ms.channel_id = $3 AND ms.left_at IS NULL \
                         JOIN workspace_membership wm \
                           ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
                          AND wm.role <> 'guest' \
                        WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'human' \
                          AND m.status = 'active' AND m.deleted_at IS NULL)",
                )
                .bind(workspace_id)
                .bind(new_assignee)
                .bind(item.3)
                .fetch_one(&mut *conn)
                .await?;
                if !eligible {
                    return Ok(Err(ApiError::bad_request(BAD_ASSIGNEE)));
                }
                let sql = format!(
                    "WITH w AS ( \
                       UPDATE work_item SET assignee_member_id = $3, updated_at = now() \
                        WHERE workspace_id = $1 AND id = $2 \
                       RETURNING * ) \
                     SELECT {ITEM_COLUMNS} FROM w"
                );
                let row = sqlx::query_as::<_, ItemRow>(&sql)
                    .bind(workspace_id)
                    .bind(item.0)
                    .bind(new_assignee)
                    .fetch_one(&mut *conn)
                    .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "work_item.assignee_changed")
                        .by(caller)
                        .via_token(via_token)
                        .about(new_assignee)
                        .target("work_item", item.0)
                        .with_schema(
                            "momo.work_item.assignee_changed.v1",
                            json!({ "number": item.1, "from": item.5.to_string() }),
                        ),
                )
                .await?;
                Ok(Ok(row))
            })
        })
        .await,
    )?;
    Ok(Json(WorkItemResponse {
        work_item: dto(row),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_number_is_a_plain_positive_decimal() {
        assert_eq!(parse_number("1").unwrap(), 1);
        assert_eq!(parse_number("142").unwrap(), 142);
        assert_eq!(parse_number("9223372036854775807").unwrap(), i64::MAX);
        for bad in [
            "",
            "0",
            "01",
            "-1",
            "+1",
            "1.0",
            "1e3",
            " 1",
            "abc",
            "9223372036854775808",
            "99999999999999999999",
        ] {
            assert!(parse_number(bad).is_err(), "{bad:?}");
        }
    }
}
