//! Personal cloud box — lifecycle API (#3500, ADR-0197 M1, 성재 결재 2026-10-03).
//!
//! ```text
//! POST /v1/workspaces/{ws}/cloud-boxes                    create my box        (owner = caller)
//! GET  /v1/workspaces/{ws}/cloud-boxes                    every live box       (workspace admin)
//! GET  /v1/workspaces/{ws}/cloud-boxes/mine               my live box or null  (any active member)
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/start        start                (box owner only)
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/stop         stop                 (box owner or admin)
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/delete       delete / retry delete (box owner or admin)
//! POST /v1/workspaces/{ws}/cloud-boxes/{box}/keep-awake   「계속 켜 둠」        (box owner only)
//! ```
//!
//! ## Rules this module is the door for
//!
//! 1. **Closed by default.** Every route answers 404 before any database read
//!    unless the operator set `MOMO_CLOUD_BOX_ENABLED=true`.
//! 2. **The box is its owner's (D6).** Create, start and keep-awake are the owner's
//!    alone. A workspace admin gets 403 `cloud_box_owner_only`; any other member
//!    gets 404 and learns nothing about whether the box exists. What the admin may
//!    do is exactly the resource-management list of D3/D6: list, stop, delete. There
//!    is no route by which an admin attaches, reads or starts a box.
//! 3. **Agents hold no boxes.** Human principals only; the owner is a human
//!    (`cloud_box_owner_human` trigger as the floor).
//! 4. **Asking twice is fine.** Starting a running box, stopping a stopped one or
//!    deleting one already being deleted answers 200 with the current box and writes
//!    nothing (no second control, no second audit row).
//! 5. **The lifecycle table is `momo_settings::cloud_box::next_state`.** A request the
//!    table refuses is 409 `cloud_box_state_conflict`.
//!
//! The runner's side (polling and reporting) is M2's door; the queue it will read
//! is filled by these routes in the same transaction as the state change.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{active_workspace_role, WorkspaceRole};
use momo_settings::cloud_box::{
    apply_event_in_tx, create_box_in_tx, find_box_in_tx, find_live_box_for_member_in_tx,
    list_live_boxes_in_tx, set_keep_awake_in_tx, ApplyOutcome, BoxEvent, BoxInfo, BoxLimits,
    BoxState, CreateOutcome, KeepAwakeOutcome,
};
use uuid::Uuid;

use crate::dto::{
    CloudBoxDto, CloudBoxKeepAwakeRequest, CloudBoxLimitsDto, CloudBoxListResponse,
    CloudBoxMineResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

pub(crate) fn gate(state: &AppState) -> Result<(), ApiError> {
    if state.cloud_box.enabled {
        Ok(())
    } else {
        Err(ApiError::not_found("not found"))
    }
}

fn dto(info: &BoxInfo) -> CloudBoxDto {
    CloudBoxDto {
        id: info.id.to_string(),
        member_id: info.member_id.to_string(),
        state: info.state.as_str(),
        closed_reason: info.closed_reason.clone(),
        limits: CloudBoxLimitsDto {
            cpu_millis: info.cpu_millis,
            memory_mb: info.memory_mb,
            disk_gb: info.disk_gb,
            pids: info.pids,
            idle_minutes: info.idle_minutes,
            stopped_delete_days: info.stopped_delete_days,
            keep_awake_max_hours: info.keep_awake_max_hours,
        },
        created_at_ms: info.created_at_ms,
        state_changed_at_ms: info.state_changed_at_ms,
        idle_since_ms: info.idle_since_ms,
        stopped_at_ms: info.stopped_at_ms,
        keep_awake_until_ms: info.keep_awake_until_ms,
        last_attached_at_ms: info.last_attached_at_ms,
    }
}

fn not_found() -> ApiError {
    ApiError::not_found("cloud box not found")
}

fn conflict(from: BoxState) -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "cloud_box_state_conflict",
        format!("지금 상태({})에서는 할 수 없는 요청이에요.", from.as_str()),
    )
}

fn in_flight() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "cloud_box_control_in_flight",
        "앞선 요청을 처리하는 중이에요. 잠시 뒤에 다시 시도해 주세요.",
    )
}

fn no_capacity() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "cloud_box_no_capacity",
        "자리가 없어요. 이 워크스페이스에서 동시에 켤 수 있는 박스를 모두 쓰고 있어요.",
    )
}

/// Who is asking about a box and what they may do with it.
#[derive(Clone, Copy)]
enum Standing {
    Owner,
    Admin,
}

/// The caller's standing on `existing`, or the refusal for it. `owner_only`
/// controls refuse an admin with 403; resource controls let one through.
fn standing(
    role: Option<WorkspaceRole>,
    existing: &BoxInfo,
    actor: Uuid,
    owner_only: bool,
) -> Result<Standing, ApiError> {
    let Some(role) = role else {
        return Err(not_found());
    };
    if existing.member_id == actor {
        // A member demoted to guest no longer controls their box (workspace roles are live);
        // an admin can still stop or delete it for them.
        if role == WorkspaceRole::Guest {
            return Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                "cloud_box_guest",
                "게스트는 박스를 조작할 수 없어요.",
            ));
        }
        return Ok(Standing::Owner);
    }
    match (role.is_admin(), owner_only) {
        (true, true) => Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "cloud_box_owner_only",
            "박스의 주인만 할 수 있어요. 관리자는 목록·정지·삭제만 할 수 있어요.",
        )),
        (true, false) => Ok(Standing::Admin),
        (false, _) => Err(not_found()),
    }
}

/// `POST /v1/workspaces/{ws}/cloud-boxes`.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<(StatusCode, Json<CloudBoxDto>), ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let created = settle_db(
        "cloud_box.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match active_workspace_role(conn, workspace_id, actor).await? {
                    Some(WorkspaceRole::Guest) | None => {
                        return Ok(Err(ApiError::forbidden(
                            "a workspace member (not a guest) is required",
                        )))
                    }
                    Some(_) => {}
                }
                match create_box_in_tx(conn, workspace_id, actor, BoxLimits::default(), via_token)
                    .await?
                {
                    CreateOutcome::Created(info) => Ok(Ok(info)),
                    CreateOutcome::OwnerNotHuman => Ok(Err(ApiError::forbidden(
                        "only an active human member can own a box",
                    ))),
                    CreateOutcome::AlreadyHasBox => Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "cloud_box_already_exists",
                        "이미 박스가 있어요. 멤버마다 박스는 하나예요.",
                    ))),
                    CreateOutcome::NoCapacity => Ok(Err(no_capacity())),
                }
            })
        })
        .await,
    )?;
    Ok((StatusCode::CREATED, Json(dto(&created))))
}

/// `GET /v1/workspaces/{ws}/cloud-boxes` — resource list for admins.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<CloudBoxListResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let boxes = settle_db(
        "cloud_box.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                Ok(Ok(list_live_boxes_in_tx(conn, workspace_id).await?))
            })
        })
        .await,
    )?;
    Ok(Json(CloudBoxListResponse {
        boxes: boxes.iter().map(dto).collect(),
    }))
}

/// `GET /v1/workspaces/{ws}/cloud-boxes/mine` — the caller's own box. The owner
/// filter is the caller's member id, never a parameter.
pub async fn mine(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<CloudBoxMineResponse>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let found = settle_db(
        "cloud_box.mine",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match active_workspace_role(conn, workspace_id, actor).await? {
                    None | Some(WorkspaceRole::Guest) => {
                        return Ok(Err(ApiError::forbidden(
                            "a workspace member (not a guest) is required",
                        )))
                    }
                    Some(_) => {}
                }
                Ok(Ok(find_live_box_for_member_in_tx(
                    conn,
                    workspace_id,
                    actor,
                )
                .await?))
            })
        })
        .await,
    )?;
    Ok(Json(CloudBoxMineResponse {
        cloud_box: found.as_ref().map(dto),
    }))
}

/// Which lifecycle verb a route asks for.
#[derive(Clone, Copy)]
enum Verb {
    Start,
    Stop,
    Delete,
}

impl Verb {
    fn owner_only(self) -> bool {
        matches!(self, Verb::Start)
    }

    fn context(self) -> &'static str {
        match self {
            Verb::Start => "cloud_box.start",
            Verb::Stop => "cloud_box.stop",
            Verb::Delete => "cloud_box.delete",
        }
    }

    fn event(self, who: Standing, from: BoxState) -> BoxEvent {
        match (self, who) {
            (Verb::Start, _) => BoxEvent::OwnerStart,
            (Verb::Stop, Standing::Owner) => BoxEvent::OwnerStop,
            (Verb::Stop, Standing::Admin) => BoxEvent::AdminStop,
            (Verb::Delete, Standing::Owner) if from == BoxState::DeleteFailed => {
                BoxEvent::OwnerRetryDelete
            }
            (Verb::Delete, Standing::Admin) if from == BoxState::DeleteFailed => {
                BoxEvent::AdminRetryDelete
            }
            (Verb::Delete, Standing::Owner) => BoxEvent::OwnerDelete,
            (Verb::Delete, Standing::Admin) => BoxEvent::AdminDelete,
        }
    }
}

async fn lifecycle(
    state: AppState,
    principal: Principal,
    workspace: String,
    box_raw: String,
    verb: Verb,
) -> Result<Json<CloudBoxDto>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&box_raw, "invalid cloud box id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let info = settle_db(
        verb.context(),
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(existing) = find_box_in_tx(conn, workspace_id, box_id).await? else {
                    return Ok(Err(not_found()));
                };
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                let who = match standing(role, &existing, actor, verb.owner_only()) {
                    Ok(who) => who,
                    Err(refusal) => return Ok(Err(refusal)),
                };
                let event = verb.event(who, existing.state);
                match apply_event_in_tx(conn, workspace_id, box_id, event, Some(actor), via_token)
                    .await?
                {
                    ApplyOutcome::Applied { info, .. } => Ok(Ok(info)),
                    ApplyOutcome::NotFound => Ok(Err(not_found())),
                    ApplyOutcome::NoCapacity => Ok(Err(no_capacity())),
                    ApplyOutcome::ControlInFlight => Ok(Err(in_flight())),
                    ApplyOutcome::Illegal { from, info } => {
                        if event.is_already_done(from) {
                            Ok(Ok(info))
                        } else if from == BoxState::Deleted {
                            // A tombstone: the box is gone as far as the caller is concerned.
                            Ok(Err(not_found()))
                        } else {
                            Ok(Err(conflict(from)))
                        }
                    }
                }
            })
        })
        .await,
    )?;
    Ok(Json(dto(&info)))
}

/// `POST /v1/workspaces/{ws}/cloud-boxes/{box}/start` — owner only.
pub async fn start(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
) -> Result<Json<CloudBoxDto>, ApiError> {
    lifecycle(state, principal, workspace, cloud_box, Verb::Start).await
}

/// `POST /v1/workspaces/{ws}/cloud-boxes/{box}/stop` — owner or workspace admin.
pub async fn stop(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
) -> Result<Json<CloudBoxDto>, ApiError> {
    lifecycle(state, principal, workspace, cloud_box, Verb::Stop).await
}

/// `POST /v1/workspaces/{ws}/cloud-boxes/{box}/delete` — owner or workspace admin.
/// On a `delete_failed` box it retries the deletion.
pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
) -> Result<Json<CloudBoxDto>, ApiError> {
    lifecycle(state, principal, workspace, cloud_box, Verb::Delete).await
}

/// `POST /v1/workspaces/{ws}/cloud-boxes/{box}/keep-awake` — owner only.
pub async fn keep_awake(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, cloud_box)): Path<(String, String)>,
    Json(request): Json<CloudBoxKeepAwakeRequest>,
) -> Result<Json<CloudBoxDto>, ApiError> {
    gate(&state)?;
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let box_id = path_uuid(&cloud_box, "invalid cloud box id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let info = settle_db(
        "cloud_box.keep_awake",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(existing) = find_box_in_tx(conn, workspace_id, box_id).await? else {
                    return Ok(Err(not_found()));
                };
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                if let Err(refusal) = standing(role, &existing, actor, true) {
                    return Ok(Err(refusal));
                }
                let hours = request
                    .enabled
                    .then(|| request.hours.unwrap_or(existing.keep_awake_max_hours));
                match set_keep_awake_in_tx(conn, workspace_id, box_id, hours, actor, via_token)
                    .await?
                {
                    KeepAwakeOutcome::Set(info) => Ok(Ok(info)),
                    KeepAwakeOutcome::NotFound => Ok(Err(not_found())),
                    KeepAwakeOutcome::NotRunning(from) => Ok(Err(conflict(from))),
                    KeepAwakeOutcome::TooLong { max_hours } => Ok(Err(ApiError::bad_request(
                        format!("hours must be 1...{max_hours}"),
                    ))),
                }
            })
        })
        .await,
    )?;
    Ok(Json(dto(&info)))
}
