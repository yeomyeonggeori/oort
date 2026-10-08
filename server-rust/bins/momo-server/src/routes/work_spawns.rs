//! The owner's signed **new work** spawn — T5 (#3570), ADR-0198 D4 · 증보 1
//! D7, ADR-0146 (the E8 gap: "서버에서 새 작업 spawn을 서명과 함께 만드는
//! 경로는 아직 없다"), ADR-0188 D3 · D6.
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-spawns        (human bearer)
//! ```
//!
//! The owner asks for a task on **their own Mac**: a harness (「내 도구」), or
//! a personal agent (ADR-0198 D7) calling the same harness by an alias. It is
//! **not** a chat message and not an agent run. The message send path
//! (`momo-messaging`: `channel_seq` + message + outbox) is not touched: this
//! route writes one `work_control` row, the nonce, the `action_signature` row
//! and an audit row, and emits no outbox event (the host reads its ledger by
//! polling `pending-controls`; there is no card for anyone to hear yet). A
//! mention that should also start work is a message (the existing path) **and**
//! this call, made by the owner's client; the server never turns a mention
//! into a spawn by itself (ADR-0198 D7).
//!
//! ## Rules
//!
//! * **Closed unless R2 is on.** Without `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`
//!   the route answers 403 `signed_spawn_disabled` before it reads anything
//!   (ADR-0146 D-11; turning the flag on is #3593, after the T5 security
//!   review).
//! * **Human bearer only, and only the requester's own Mac.** An agent bearer,
//!   a signed host, a webhook or a door bell never reaches it (absent from
//!   `momo_auth::required_agent_scope` and the `work_host_auth` allow-list; the
//!   handler refuses anything but a human, too). The host is **derived**, not
//!   named: the requester's own `scope='member'` host that issued the signed
//!   folder id, `owner == requester`, not revoked, online (the one expression
//!   `momo_wire::work_host_online_sql`). `targetHostId` can only narrow it.
//!   Somebody else's host, or somebody else's folder id, is one non-disclosing
//!   404 — there is no path to a teammate's Mac.
//! * **Signed, last.** A `momo.human.control.v4` statement over the host, the
//!   room, the thread and message it was called from, the harness, the folder
//!   id, the agent (or none) and the whole prompt ([`crate::human_control`]).
//!   Changing any of them breaks the signature, so the server cannot change
//!   what the owner asked. The signature check is the last refusal: it spends
//!   the nonce.
//! * **Honest about delivery.** An offline or revoked Mac, a full pool, a
//!   missing channel membership are refused by name **before** the nonce is
//!   spent, so the owner can resend the same signed statement.
//! * **A retry is not a replay.** The same nonce on the same spawn answers 200
//!   with the same control (`replayed: true`); on anything else, 409.
//! * **The folder is an opaque id.** It must be one this host announced
//!   (`work_host_folder`, #3590). The server never knows a path; `momo-workd`
//!   resolves the id on the Mac at every spawn.
//! * **A personal agent is the owner's.** When the statement names an agent
//!   member it must be a live `owner_only` agent owned by the requester whose
//!   harness matches the tool (ADR-0193 D4 / ADR-0198 D7).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::human_control::{ControlSubject, ControlTarget};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{sqlx, PgConnection};
use momo_t3::work_control::{
    insert_work_control_in_tx, lock_work_control_in_tx, remote_host_refuses_tool_in_tx,
    target_work_host_in_tx, tool_is_claude_in_tx, validated_label, validated_tool_key,
    NewWorkControl, WorkControlRow, HOST_SCOPE_MEMBER, KIND_SPAWN, REFUSAL_REMOTE_HOST_SHELL,
    STATUS_DISPATCHED,
};
use momo_t3::{
    acquire_slot_in_tx, is_active_channel_member_in_tx, work_tool_is_enabled_in_tx, T3Error,
};
use momo_wire::human_control::{ControlContent, InputMode};
use serde_json::json;
use uuid::Uuid;

use crate::config::DeviceKeySettings;
use crate::dto::{WorkSpawnRequest, WorkSpawnResponse};
use crate::error::ApiError;
use crate::human_control::{
    authorize_human_control_in_tx, record_control_provenance_in_tx, signature_columns,
};
use crate::routes::shared::{audit_via_token_id, settle, tenant_tx, workspace_scope, Rejectable};
use crate::routes::work_controls::control_dto;
use crate::AppState;

/// Stable machine codes.
pub const CODE_DISABLED: &str = "signed_spawn_disabled";
pub const CODE_NOT_HUMAN: &str = "spawn_not_human";
pub const CODE_PROMPT_INVALID: &str = "spawn_prompt_invalid";
pub const CODE_SLASH_COMMAND: &str = "spawn_slash_command";
pub const CODE_LABEL_INVALID: &str = "spawn_label_invalid";
pub const CODE_TOOL_INVALID: &str = "spawn_tool_invalid";
pub const CODE_FOLDER_REQUIRED: &str = "spawn_folder_required";
pub const CODE_CHANNEL_MEMBER_ONLY: &str = "spawn_channel_member_only";
pub const CODE_HOST_NOT_FOUND: &str = "spawn_host_not_found";
pub const CODE_FOLDER_NOT_FOUND: &str = "spawn_folder_not_found";
pub const CODE_HOST_AMBIGUOUS: &str = "spawn_host_ambiguous";
pub const CODE_HOST_OFFLINE: &str = "work_host_offline";
pub const CODE_AGENT_NOT_ALLOWED: &str = "spawn_agent_not_allowed";
pub const CODE_ORIGIN_INVALID: &str = "spawn_origin_invalid";
pub const CODE_NONCE_REUSED: &str = "spawn_nonce_reused";

const AUDIT_SPAWN_REQUESTED: &str = "work.spawn.requested";
const SCHEMA_SPAWN_REQUESTED: &str = "momo.work_spawn.requested.v1";
/// `validated_payload`'s `input` bound, the same one `payload.prompt` has.
const PROMPT_MAX_CHARS: usize = 32_768;

/// Everything judged before a transaction opens.
#[derive(Debug, Clone)]
struct Spawn {
    tool: String,
    label: String,
    request: WorkSpawnRequest,
}

fn validated_spawn(
    principal: &Principal,
    settings: &DeviceKeySettings,
    request: WorkSpawnRequest,
) -> Result<Spawn, ApiError> {
    if !settings.human_control_signature_required {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_DISABLED,
            "signed spawns are not enabled on this instance",
        ));
    }
    if principal.kind != PrincipalKind::Human {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_NOT_HUMAN,
            "a new work spawn requires its owner's human bearer",
        ));
    }
    let tool = validated_tool_key(&request.tool)
        .map_err(|error| ApiError::coded(StatusCode::BAD_REQUEST, CODE_TOOL_INVALID, error.0))?;
    // The signed bytes carry the tool as the server stores it.
    if tool != request.tool {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_TOOL_INVALID,
            "tool must be the lower-case key the host allowlists",
        ));
    }
    let label = validated_label(&request.label)
        .map_err(|error| ApiError::coded(StatusCode::BAD_REQUEST, CODE_LABEL_INVALID, error.0))?;
    // The title is signed as the server stores it: one line of NFC text, no
    // control character, and already trimmed (T5 review M-2, L-2).
    let label_nfc = ControlContent::Input {
        mode: InputMode::Queue,
        text: &label,
    }
    .canonical_bytes()
    .is_ok_and(|bytes| bytes == label.as_bytes());
    if label != request.label || !label_nfc || label.chars().any(char::is_control) {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_LABEL_INVALID,
            "title must be one trimmed NFC line with no control character",
        ));
    }
    let prompt = &request.prompt;
    let chars = prompt.chars().count();
    if chars == 0 || chars > PROMPT_MAX_CHARS || prompt.trim().is_empty() {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_PROMPT_INVALID,
            "prompt must contain 1...32768 characters",
        ));
    }
    // The signature covers NFC text and the host refuses any other spelling:
    // say so before a nonce could be spent on it.
    let is_nfc = ControlContent::Input {
        mode: InputMode::Queue,
        text: prompt,
    }
    .canonical_bytes()
    .is_ok_and(|bytes| bytes == prompt.as_bytes());
    if !is_nfc {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_PROMPT_INVALID,
            "prompt must be NFC-normalized (the form the signature covers)",
        ));
    }
    // A prompt is text: line breaks and tabs, no other control character
    // (U+0000 would be a 500 from the database, T5 review L-2).
    if prompt
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_PROMPT_INVALID,
            "prompt may not contain control characters other than line breaks and tabs",
        ));
    }
    // The host refuses an adapter command as a prompt (#2602 L-7).
    if prompt.trim_start().starts_with('/') {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_SLASH_COMMAND,
            "a prompt cannot start with / (it would run an adapter command)",
        ));
    }
    if request
        .human_signature
        .folder_id
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_FOLDER_REQUIRED,
            "humanSignature.folderId names the allowed folder the task opens",
        ));
    }
    Ok(Spawn {
        tool,
        label,
        request,
    })
}

/// `POST /v1/workspaces/{ws}/work-spawns` → 201, or 200 for a retry of an
/// accepted spawn.
pub async fn spawn(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<WorkSpawnRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let settings = state.device_keys.clone();
    let task = validated_spawn(&principal, &settings, request)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let (control, replayed) = settle(
        "work_spawns.spawn",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                spawn_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    via_token_id,
                    &settings,
                    &task,
                )
                .await
            })
        })
        .await,
    )?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(WorkSpawnResponse {
            work_control: control_dto(control),
            replayed,
        }),
    ))
}

/// One host the requester owns that issued the signed folder id.
#[derive(Debug, Clone, Copy)]
struct DerivedHost {
    id: Uuid,
}

/// The requester's own member hosts that issued `folder_id` — never anyone
/// else's. Revoked hosts are not candidates (revoking drops their folders, and
/// this filters them anyway). `hint` can only narrow.
async fn derive_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    folder_id: &str,
    hint: Option<Uuid>,
) -> Rejectable<DerivedHost> {
    // First the requester's own live member hosts, so "you have no Mac" and
    // "that folder is not on your Mac" are told apart for the owner — and
    // only the owner's rows are ever read.
    let own: Vec<Uuid> = sqlx::query_scalar(
        "SELECT h.id FROM work_host h \
          WHERE h.workspace_id = $1 AND h.scope = $2 AND h.owner_member_id = $3 \
            AND h.revoked_at IS NULL \
            AND ($4::uuid IS NULL OR h.id = $4) \
          ORDER BY h.id",
    )
    .bind(workspace_id)
    .bind(HOST_SCOPE_MEMBER)
    .bind(member_id)
    .bind(hint)
    .fetch_all(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    if own.is_empty() {
        return Ok(Err(ApiError::coded(
            StatusCode::NOT_FOUND,
            CODE_HOST_NOT_FOUND,
            "no work host of yours can take this task",
        )));
    }
    let with_folder: Vec<Uuid> = sqlx::query_scalar(
        "SELECT f.host_id FROM work_host_folder f \
          WHERE f.workspace_id = $1 AND f.host_id = ANY($2) AND f.folder_id = $3 \
          ORDER BY f.host_id",
    )
    .bind(workspace_id)
    .bind(&own)
    .bind(folder_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    match with_folder.as_slice() {
        [] => Ok(Err(ApiError::coded(
            StatusCode::NOT_FOUND,
            CODE_FOLDER_NOT_FOUND,
            "that folder is not one your work host allows",
        ))),
        [id] => Ok(Ok(DerivedHost { id: *id })),
        _ => Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_HOST_AMBIGUOUS,
            "more than one of your work hosts issued that folder id; name the host",
        ))),
    }
}

/// The thread and message the owner called from must be real, in this room,
/// and the message must be the owner's own plain message (ADR-0188 D3: an
/// instruction comes from the owner's own message, never someone else's).
async fn origin_is_valid_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    thread_root_id: Option<Uuid>,
    origin_message_id: Option<Uuid>,
) -> Result<bool, T3Error> {
    if let Some(origin) = origin_message_id {
        let found: Option<Option<Uuid>> = sqlx::query_scalar(
            "SELECT root_id FROM message \
              WHERE workspace_id = $1 AND id = $2 AND channel_id = $3 \
                AND author_member_id = $4 AND type = 'text' AND deleted_at IS NULL",
        )
        .bind(workspace_id)
        .bind(origin)
        .bind(channel_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(momo_db::DbError::from)?;
        // The thread the statement names is the thread the message is in:
        // none for a top-level message, its root for a reply.
        return Ok(found.is_some_and(|root| root == thread_root_id));
    }
    let Some(thread) = thread_root_id else {
        return Ok(true);
    };
    let root: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM message \
          WHERE workspace_id = $1 AND id = $2 AND channel_id = $3 \
            AND root_id IS NULL AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(thread)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    Ok(root.is_some())
}

/// A personal agent the owner named: a live `owner_only` agent owned by the
/// requester, whose harness matches the tool.
async fn personal_agent_ok_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    agent_member_id: Uuid,
    tool: &str,
) -> Result<bool, T3Error> {
    let harness: Option<String> = sqlx::query_scalar(
        "SELECT a.subscription_harness FROM agent a \
           JOIN member m ON m.id = a.member_id AND m.workspace_id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 AND a.owner_human_id = $3 \
            AND a.invocation_scope = 'owner_only' \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    let Some(harness) = harness else {
        return Ok(false);
    };
    let claude = tool_is_claude_in_tx(conn, workspace_id, tool).await?;
    Ok(match harness.as_str() {
        "claude_code" => claude,
        "codex" => !claude,
        _ => false,
    })
}

/// The accepted spawn a retry names, or `Err` when the nonce is on something
/// else. `Ok(None)`: the nonce is unused.
async fn replay_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    task: &Spawn,
) -> Rejectable<Option<WorkControlRow>> {
    let nonce = task.request.human_signature.nonce;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_control WHERE workspace_id = $1 AND human_nonce = $2",
    )
    .bind(workspace_id)
    .bind(nonce)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    let reused = || {
        Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_NONCE_REUSED,
            "this signed nonce was already used for another instruction",
        )))
    };
    let Some(control_id) = existing else {
        return Ok(Ok(None));
    };
    let Some(control) = lock_work_control_in_tx(conn, workspace_id, control_id).await? else {
        return reused();
    };
    let signature = &task.request.human_signature;
    let same = control.kind == KIND_SPAWN
        && control.requester_member_id == member_id
        && control.channel_id == task.request.channel_id
        && control.payload.get("tool").and_then(|v| v.as_str()) == Some(task.tool.as_str())
        && control.payload.get("prompt").and_then(|v| v.as_str())
            == Some(task.request.prompt.as_str())
        && control.human.as_ref().is_some_and(|columns| {
            columns.spawn_agent_member_id == signature.agent_member_id
                && columns.spawn_folder_id.as_deref() == signature.folder_id.as_deref()
                && columns.spawn_thread_root_id == task.request.thread_root_id
                && columns.spawn_origin_message_id == task.request.origin_message_id
        });
    if !same {
        return reused();
    }
    Ok(Ok(Some(control)))
}

async fn spawn_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    settings: &DeviceKeySettings,
    task: &Spawn,
) -> Rejectable<(WorkControlRow, bool)> {
    let request = &task.request;
    let signature = &request.human_signature;
    let folder_id = signature
        .folder_id
        .as_deref()
        .expect("validated_spawn requires a folder id");

    // ---- rejections first (nothing is written above the signature) ---------
    // The room: the same active membership a session needs.
    if !is_active_channel_member_in_tx(conn, workspace_id, request.channel_id, member_id).await? {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_CHANNEL_MEMBER_ONLY,
            "a task needs an active membership of the room it is called from",
        )));
    }
    // A retry of an accepted spawn answers before anything that could have
    // changed since (the Mac may be asleep now).
    match replay_in_tx(conn, workspace_id, member_id, task).await? {
        Err(refusal) => return Ok(Err(refusal)),
        Ok(Some(control)) => return Ok(Ok((control, true))),
        Ok(None) => {}
    }
    if !work_tool_is_enabled_in_tx(conn, workspace_id, &task.tool).await? {
        return Ok(Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_TOOL_INVALID,
            "work tool is not registered or enabled",
        )));
    }
    // The host: derived from the requester's own Macs and the signed folder.
    let derived = match derive_host_in_tx(
        conn,
        workspace_id,
        member_id,
        folder_id,
        request.target_host_id,
    )
    .await?
    {
        Ok(derived) => derived,
        Err(refusal) => return Ok(Err(refusal)),
    };
    // Re-read the chosen host under a share lock (a revoke lands first or
    // waits for this commit): member scope, owner == requester, not revoked,
    // online — `online` is `momo_wire::work_host_online_sql`.
    let Some(host) = target_work_host_in_tx(conn, workspace_id, derived.id).await? else {
        return Ok(Err(ApiError::coded(
            StatusCode::NOT_FOUND,
            CODE_HOST_NOT_FOUND,
            "no work host of yours can take this task",
        )));
    };
    if host.scope != HOST_SCOPE_MEMBER || host.owner_member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::NOT_FOUND,
            CODE_HOST_NOT_FOUND,
            "no work host of yours can take this task",
        )));
    }
    if !host.online {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_HOST_OFFLINE,
            "your work host is offline; the task was not started",
        )));
    }
    // ADR-0188 D6 (R0): a remote host never takes a shell.
    if remote_host_refuses_tool_in_tx(conn, workspace_id, derived.id, &task.tool).await? {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            REFUSAL_REMOTE_HOST_SHELL,
            "a shell cannot be started on a member-scoped work host",
        )));
    }
    if let Some(agent) = signature.agent_member_id {
        if !personal_agent_ok_in_tx(conn, workspace_id, member_id, agent, &task.tool).await? {
            return Ok(Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_AGENT_NOT_ALLOWED,
                "only the owner's own personal agent can be named here",
            )));
        }
    }
    if !origin_is_valid_in_tx(
        conn,
        workspace_id,
        request.channel_id,
        member_id,
        request.thread_root_id,
        request.origin_message_id,
    )
    .await?
    {
        return Ok(Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_ORIGIN_INVALID,
            "the thread and message must be the owner's own, in this room",
        )));
    }
    // Slot admission (ADR-0188 D4: a remote spawn takes one too).
    if let Err(error) = acquire_slot_in_tx(conn, workspace_id, member_id, derived.id).await {
        return Ok(Err(match error {
            T3Error::SlotsExhausted { .. } => ApiError::new(StatusCode::CONFLICT, "pool_exhausted"),
            T3Error::MemberSlotLimit { .. } => ApiError::new(StatusCode::CONFLICT, "member_limit"),
            other => return Err(other),
        }));
    }

    // The signature — the last refusal: it spends the nonce.
    let verified = match authorize_human_control_in_tx(
        conn,
        settings,
        &ControlTarget {
            workspace_id,
            member_id,
            host_id: derived.id,
            session_id: None,
            subject: ControlSubject::SpawnTask {
                label: &task.label,
                prompt: &request.prompt,
                tool: &task.tool,
                channel_id: request.channel_id,
                thread_root_id: request.thread_root_id,
                origin_message_id: request.origin_message_id,
            },
        },
        Some(signature),
        true,
    )
    .await?
    {
        Ok(Some(verified)) => verified,
        Ok(None) => {
            return Err(T3Error::IllegalTransition(
                "a sent signature produced no verification".to_string(),
            ))
        }
        Err(refusal) => return Ok(Err(refusal)),
    };

    // ---- writes ------------------------------------------------------------
    // Dispatched directly, as a signed resume is: the owner asking IS the
    // authority this ledger asks for (no approval card for their own click).
    // No message, no `channel_seq` bump, no outbox event.
    let control = insert_work_control_in_tx(
        conn,
        workspace_id,
        NewWorkControl {
            channel_id: request.channel_id,
            requester_member_id: member_id,
            target_host_id: derived.id,
            session_id: None,
            kind: KIND_SPAWN.to_string(),
            payload: json!({
                "tool": task.tool,
                "label": task.label,
                "prompt": request.prompt,
            }),
            status: STATUS_DISPATCHED.to_string(),
            human: Some(signature_columns(&verified)),
        },
    )
    .await?;
    record_control_provenance_in_tx(conn, workspace_id, control.id, &verified).await?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_SPAWN_REQUESTED)
            .by(member_id)
            .about(member_id)
            .target("work_control", control.id)
            .via_token(via_token_id)
            .with_schema(
                SCHEMA_SPAWN_REQUESTED,
                // The audit row says what was asked, never the prompt itself.
                json!({
                    "control_id": control.id.to_string(),
                    "host_id": derived.id.to_string(),
                    "channel_id": request.channel_id.to_string(),
                    "tool": task.tool,
                    "folder_id": folder_id,
                    "agent_member_id": signature.agent_member_id.map(|id| id.to_string()),
                    "thread_root_id": request.thread_root_id.map(|id| id.to_string()),
                    "origin_message_id": request.origin_message_id.map(|id| id.to_string()),
                    "prompt_chars": request.prompt.chars().count(),
                    "device_key_id": verified.key.id.to_string(),
                    "schema": verified.schema.as_str(),
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok((control, false)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(kind: PrincipalKind) -> Principal {
        Principal {
            kind,
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: None,
            scopes: Vec::new(),
        }
    }

    fn on() -> DeviceKeySettings {
        DeviceKeySettings {
            instance_id: Some("inst".into()),
            human_control_signature_required: true,
            ..DeviceKeySettings::default()
        }
    }

    fn request(prompt: &str) -> WorkSpawnRequest {
        serde_json::from_value(json!({
            "tool": "claude", "label": "제목", "prompt": prompt,
            "channelId": Uuid::from_u128(3),
            "humanSignature": {
                "deviceKeyId": Uuid::from_u128(4), "nonce": Uuid::from_u128(5),
                "issuedAtMs": 1, "expiresAtMs": 2, "signature": "x",
                "folderId": "fld_abc"
            }
        }))
        .expect("request")
    }

    fn code_of(error: ApiError) -> Option<&'static str> {
        error.code
    }

    #[test]
    fn only_a_human_bearer_with_the_flag_on_gets_past_the_door() {
        // The handler's own refusal of every non-human principal, whatever the
        // router layer says (defence in depth): an agent bearer, a signed host.
        for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
            let error = validated_spawn(&principal(kind), &on(), request("질문")).unwrap_err();
            assert_eq!(code_of(error), Some(CODE_NOT_HUMAN));
        }
        let error = validated_spawn(
            &principal(PrincipalKind::Human),
            &DeviceKeySettings::default(),
            request("질문"),
        )
        .unwrap_err();
        assert_eq!(code_of(error), Some(CODE_DISABLED));
        assert!(validated_spawn(&principal(PrincipalKind::Human), &on(), request("질문")).is_ok());
    }

    #[test]
    fn a_prompt_is_judged_before_any_nonce_could_be_spent() {
        let human = principal(PrincipalKind::Human);
        for (prompt, expected) in [
            ("", CODE_PROMPT_INVALID),
            ("  \n", CODE_PROMPT_INVALID),
            ("/logout", CODE_SLASH_COMMAND),
            ("  /compact", CODE_SLASH_COMMAND),
            ("cafe\u{0301}", CODE_PROMPT_INVALID),
        ] {
            let error = validated_spawn(&human, &on(), request(prompt)).unwrap_err();
            assert_eq!(code_of(error), Some(expected), "{prompt:?}");
        }
        let long = "가".repeat(PROMPT_MAX_CHARS + 1);
        assert_eq!(
            code_of(validated_spawn(&human, &on(), request(&long)).unwrap_err()),
            Some(CODE_PROMPT_INVALID)
        );
        assert!(validated_spawn(&human, &on(), request(&"가".repeat(PROMPT_MAX_CHARS))).is_ok());
    }

    #[test]
    fn the_folder_is_required_and_the_tool_is_the_signed_spelling() {
        let human = principal(PrincipalKind::Human);
        let mut no_folder = request("질문");
        no_folder.human_signature.folder_id = None;
        assert_eq!(
            code_of(validated_spawn(&human, &on(), no_folder).unwrap_err()),
            Some(CODE_FOLDER_REQUIRED)
        );
        let mut shouting = request("질문");
        shouting.tool = "Claude".into();
        assert_eq!(
            code_of(validated_spawn(&human, &on(), shouting).unwrap_err()),
            Some(CODE_TOOL_INVALID)
        );
    }
}
