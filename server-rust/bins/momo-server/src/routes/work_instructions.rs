//! The owner's signed instruction to a work session — R2-E7 (#3027), ADR-0146
//! 개정 2026-09-28 D-5b · D-8 · D-10, ADR-0188 D3 · D4 and #3001's contract.
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-sessions/{session}/instructions   (human bearer)
//! ```
//!
//! An instruction is the owner's next turn for the agent running on their own
//! machine. It is **not** a chat message with a flag on it: the message send
//! path (`momo-messaging`) is unchanged and knows nothing about work. This
//! route makes the `input` control and, in the same transaction, leaves the
//! instruction in the session thread through the existing send helper
//! (`send_thread_notice_in_tx`: `channel_seq` + message + outbox, one tx).
//!
//! ## Rules
//!
//! * **Closed unless R2 is on.** With `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED`
//!   off the route answers 403 `signed_instructions_disabled` before it reads
//!   anything (ADR-0146 D-11: opened only after the R1 re-review and the R2
//!   review PASS).
//! * **Who — the session's owner, who is the host's owner** (ADR-0188 D3), on
//!   a member-scoped host. A human bearer only: agents never reach it (absent
//!   from `momo_auth::required_agent_scope`), a signed host never does (not on
//!   `work_host_auth`'s allow-list), and the handler refuses anything else.
//! * **Signed, always.** `humanSignature` is a `kind=input` statement over this
//!   session, its host, the text and the mode ([`crate::human_control`]). The
//!   mode is inside the signature, so the server cannot turn a queued
//!   instruction into an interrupt. `clientMsgId` must equal the nonce.
//! * **Once, and a retry is not a replay.** Before the signature is looked at,
//!   the control carrying this nonce is looked up (E3 hand-off ①): the same
//!   instruction again answers 200 with the same control and message
//!   (`replayed: true`); the nonce on anything else is 409
//!   `instruction_nonce_reused`. The session row lock serializes two retries.
//! * **Honest about delivery.** A session that is not `running`/`idle`, or a
//!   host that is revoked or has not heartbeated in 90 s, is refused by name
//!   (409) **before** the nonce is spent, so the owner can resend the same
//!   signed instruction once the Mac is back.
//! * **Order.** `queue` is the next turn after the running one and anything
//!   already queued; `interrupt` cancels the running turn (ACP
//!   `session/cancel`) and goes next — both executed by the host (`momo-workd`
//!   `session`), which re-verifies the signature against its pinned root.
//! * **Recorded.** The control (with its signature columns), the
//!   `action_signature` row, the dispatch event, the thread message (props
//!   `momo.instruction` = control id + mode) and the audit row
//!   `work.instruction.sent` commit together.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::human_control::{ControlSubject, ControlTarget};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{sqlx, PgConnection};
use momo_messaging::{send_thread_notice_in_tx, MessageType, NewMessage};
use momo_t3::work_control::{
    insert_work_control_in_tx, lock_work_control_in_tx, target_work_host_in_tx, NewWorkControl,
    WorkControlRow, HOST_SCOPE_MEMBER, KIND_INPUT, STATUS_APPROVED,
};
use momo_t3::{lock_work_session_detail_in_tx, T3Error, WorkSessionDetail};
use momo_wire::human_control::{ControlContent, InputMode};
use serde_json::json;
use uuid::Uuid;

use crate::config::DeviceKeySettings;
use crate::dto::{WorkInstructionMessageDto, WorkInstructionRequest, WorkInstructionResponse};
use crate::error::ApiError;
use crate::human_control::{
    authorize_human_control_in_tx, record_control_provenance_in_tx, signature_columns,
};
use crate::routes::shared::{
    audit_via_token_id, path_uuid, settle, tenant_tx, workspace_scope, Rejectable,
};
use crate::routes::work_controls::{control_dto, dispatch_control_in_tx};
use crate::AppState;

/// Stable machine codes (pinned by `docs/api/work-instruction.golden.json`).
pub const CODE_DISABLED: &str = "signed_instructions_disabled";
pub const CODE_NOT_HUMAN: &str = "instruction_not_human";
pub const CODE_OWNER_ONLY: &str = "instruction_owner_only";
pub const CODE_MEMBER_HOST_ONLY: &str = "instruction_member_host_only";
pub const CODE_MODE_INVALID: &str = "instruction_mode_invalid";
pub const CODE_TEXT_INVALID: &str = "instruction_text_invalid";
pub const CODE_SLASH_COMMAND: &str = "instruction_slash_command";
pub const CODE_SIGNATURE_MISMATCH: &str = "instruction_signature_mismatch";
pub const CODE_NONCE_REUSED: &str = "instruction_nonce_reused";
pub const CODE_SESSION_NOT_ACCEPTING: &str = "work_session_not_accepting";
pub const CODE_HOST_OFFLINE: &str = "work_host_offline";
pub const CODE_HOST_REVOKED: &str = "work_host_revoked";

/// The server-owned props key the thread message carries (like `momo.stream`).
pub const PROPS_KEY: &str = "momo.instruction";

const AUDIT_INSTRUCTION_SENT: &str = "work.instruction.sent";
const SCHEMA_INSTRUCTION_SENT: &str = "momo.work_instruction.sent.v1";
/// `validated_payload`'s `input` bound (`momo_t3::work_control`).
const TEXT_MAX_CHARS: usize = 32_768;

/// Everything judged before a transaction opens.
#[derive(Debug, Clone)]
struct Instruction {
    text: String,
    mode: &'static str,
    request: WorkInstructionRequest,
}

fn validated_instruction(
    principal: &Principal,
    settings: &DeviceKeySettings,
    request: WorkInstructionRequest,
) -> Result<Instruction, ApiError> {
    if !settings.human_control_signature_required {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_DISABLED,
            "signed instructions are not enabled on this instance",
        ));
    }
    if principal.kind != PrincipalKind::Human {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_NOT_HUMAN,
            "instructions require the session owner's human bearer",
        ));
    }
    let mode = match request.mode.as_str() {
        "queue" => "queue",
        "interrupt" => "interrupt",
        _ => {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                CODE_MODE_INVALID,
                "mode must be queue or interrupt",
            ))
        }
    };
    let text = request.text.clone();
    let chars = text.chars().count();
    if chars == 0 || chars > TEXT_MAX_CHARS || text.trim().is_empty() {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_TEXT_INVALID,
            "text must contain 1...32768 characters",
        ));
    }
    // The signature covers NFC text and the host refuses any other spelling
    // (#3024 L4): say so here, before a nonce could be spent on it.
    let is_nfc = ControlContent::Input {
        mode: InputMode::Queue,
        text: &text,
    }
    .canonical_bytes()
    .is_ok_and(|bytes| bytes == text.as_bytes());
    if !is_nfc {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_TEXT_INVALID,
            "text must be NFC-normalized (the form the signature covers)",
        ));
    }
    // The host refuses an adapter command as a prompt (#2602 L-7).
    if text.trim_start().starts_with('/') {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_SLASH_COMMAND,
            "an instruction cannot start with / (it would run an adapter command)",
        ));
    }
    let signature = &request.human_signature;
    if signature.nonce != request.client_msg_id || signature.mode.as_deref() != Some(mode) {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_SIGNATURE_MISMATCH,
            "clientMsgId must equal humanSignature.nonce and mode humanSignature.mode",
        ));
    }
    Ok(Instruction {
        text,
        mode,
        request,
    })
}

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/instructions` → 201, or
/// 200 for a retry of an accepted instruction.
pub async fn send(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<WorkInstructionRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let settings = state.device_keys.clone();
    let instruction = validated_instruction(&principal, &settings, request)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let (control, message, replayed) = settle(
        "work_instructions.send",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                send_in_tx(
                    conn,
                    SendInput {
                        workspace_id,
                        session_id,
                        member_id,
                        via_token_id,
                        settings: &settings,
                    },
                    &instruction,
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
        Json(WorkInstructionResponse {
            work_control: control_dto(control),
            message,
            replayed,
        }),
    ))
}

struct SendInput<'a> {
    workspace_id: Uuid,
    session_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    settings: &'a DeviceKeySettings,
}

fn message_dto(
    id: Uuid,
    session: &WorkSessionDetail,
    seq: i64,
    client_msg_id: Uuid,
) -> WorkInstructionMessageDto {
    WorkInstructionMessageDto {
        id: id.to_string(),
        channel_id: session.channel_id.to_string(),
        root_id: session.root_message_id.to_string(),
        seq,
        client_msg_id: client_msg_id.to_string(),
    }
}

/// The accepted instruction a retry names, or `Err` when the nonce is on
/// something else. `Ok(None)`: the nonce is unused.
async fn replay_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session: &WorkSessionDetail,
    instruction: &Instruction,
) -> Rejectable<Option<(WorkControlRow, WorkInstructionMessageDto)>> {
    let nonce = instruction.request.client_msg_id;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_control WHERE workspace_id = $1 AND human_nonce = $2",
    )
    .bind(workspace_id)
    .bind(nonce)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    let Some(control_id) = existing else {
        return Ok(Ok(None));
    };
    let reused = || {
        Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_NONCE_REUSED,
            "this signed nonce was already used for another instruction",
        )))
    };
    let Some(control) = lock_work_control_in_tx(conn, workspace_id, control_id).await? else {
        return reused();
    };
    let same = control.kind == KIND_INPUT
        && control.session_id == Some(session.id)
        && control.requester_member_id == member_id
        && control.payload.get("text").and_then(|text| text.as_str())
            == Some(instruction.text.as_str())
        && control
            .human
            .as_ref()
            .and_then(|columns| columns.mode.as_deref())
            == Some(instruction.mode);
    if !same {
        return reused();
    }
    let message: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT id, seq FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
            AND client_msg_id = $4",
    )
    .bind(workspace_id)
    .bind(session.channel_id)
    .bind(member_id)
    .bind(nonce)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    let Some((message_id, seq)) = message else {
        // Written in the same transaction as the control; a control without
        // it is not something this route made.
        return reused();
    };
    Ok(Ok(Some((
        control,
        message_dto(message_id, session, seq, nonce),
    ))))
}

async fn send_in_tx(
    conn: &mut PgConnection,
    input: SendInput<'_>,
    instruction: &Instruction,
) -> Rejectable<(WorkControlRow, WorkInstructionMessageDto, bool)> {
    let SendInput {
        workspace_id,
        session_id,
        member_id,
        via_token_id,
        settings,
    } = input;
    // Lock order: session → host (share), as the permission decision route.
    // The session lock also serializes two retries of one nonce.
    let Some((session, _)) = lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    // ADR-0188 D3: 지시자 = 세션 소유자 = host 소유자.
    if session.member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_OWNER_ONLY,
            "only the session owner can instruct its agent",
        )));
    }
    let Some(host) = target_work_host_in_tx(conn, workspace_id, session.host_id).await? else {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_HOST_REVOKED,
            "the session's work host is revoked",
        )));
    };
    if host.scope != HOST_SCOPE_MEMBER {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_MEMBER_HOST_ONLY,
            "signed instructions reach a member-scoped work host only",
        )));
    }
    if host.owner_member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_OWNER_ONLY,
            "only the host owner can instruct its agent",
        )));
    }

    // A retry of an accepted instruction answers before anything that could
    // have changed since (the session may be idle now, the Mac asleep).
    match replay_in_tx(conn, workspace_id, member_id, &session, instruction).await? {
        Err(refusal) => return Ok(Err(refusal)),
        Ok(Some((control, message))) => return Ok(Ok((control, message, true))),
        Ok(None) => {}
    }

    // Honest refusals, before the nonce is spent: the owner can resend the
    // same statement when they clear.
    if !matches!(session.status.as_str(), "running" | "idle") {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_SESSION_NOT_ACCEPTING,
            "the work session is not running",
        )));
    }
    if !host.online {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_HOST_OFFLINE,
            "the work host is offline; the instruction was not delivered",
        )));
    }

    // The signature — the last check: it spends the nonce.
    let verified = match authorize_human_control_in_tx(
        conn,
        settings,
        &ControlTarget {
            workspace_id,
            member_id,
            host_id: session.host_id,
            session_id: Some(session_id),
            subject: ControlSubject::Input {
                text: &instruction.text,
            },
        },
        Some(&instruction.request.human_signature),
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
    let control = insert_work_control_in_tx(
        conn,
        workspace_id,
        NewWorkControl {
            channel_id: session.channel_id,
            requester_member_id: member_id,
            target_host_id: session.host_id,
            session_id: Some(session_id),
            kind: KIND_INPUT.to_string(),
            payload: json!({ "text": instruction.text }),
            status: STATUS_APPROVED.to_string(),
            human: Some(signature_columns(&verified)),
        },
    )
    .await?;
    record_control_provenance_in_tx(conn, workspace_id, control.id, &verified).await?;
    let control = dispatch_control_in_tx(conn, workspace_id, &control).await?;

    // D-5b: the instruction in the session thread, through the existing send
    // helper, in this transaction (channel_seq + message + outbox).
    let mut message = NewMessage::text(session.channel_id, member_id, instruction.text.clone())
        .with_client_msg_id(instruction.request.client_msg_id);
    message.message_type = MessageType::Text;
    message.root_id = Some(session.root_message_id);
    message.props = json!({
        PROPS_KEY: {
            "control_id": control.id.to_string(),
            "work_session_id": session_id.to_string(),
            "mode": instruction.mode,
        }
    });
    let sent = send_thread_notice_in_tx(conn, workspace_id, message).await?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_INSTRUCTION_SENT)
            .by(member_id)
            .about(member_id)
            .target("work_control", control.id)
            .via_token(via_token_id)
            .with_schema(
                SCHEMA_INSTRUCTION_SENT,
                json!({
                    "work_session_id": session_id.to_string(),
                    "host_id": session.host_id.to_string(),
                    "mode": instruction.mode,
                    "control_id": control.id.to_string(),
                    "control_status": control.status,
                    "message_id": sent.message.id.to_string(),
                    "device_key_id": verified.key.id.to_string(),
                    "schema": verified.schema.as_str(),
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    let message = message_dto(
        sent.message.id,
        &session,
        sent.message.seq,
        instruction.request.client_msg_id,
    );
    Ok(Ok((control, message, false)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::HumanSignatureRequest;

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

    fn request(body: serde_json::Value) -> WorkInstructionRequest {
        serde_json::from_value(body).expect("request")
    }

    #[test]
    fn the_golden_contract_holds() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../docs/api/work-instruction.golden.json"
        ))
        .expect("golden parses");
        let codes: Vec<&str> = golden["error_codes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap())
            .collect();
        assert_eq!(
            codes,
            [
                CODE_DISABLED,
                CODE_NOT_HUMAN,
                CODE_OWNER_ONLY,
                CODE_MEMBER_HOST_ONLY,
                CODE_MODE_INVALID,
                CODE_TEXT_INVALID,
                CODE_SLASH_COMMAND,
                CODE_SIGNATURE_MISMATCH,
                CODE_NONCE_REUSED,
                CODE_SESSION_NOT_ACCEPTING,
                CODE_HOST_OFFLINE,
                CODE_HOST_REVOKED,
            ]
        );
        assert_eq!(golden["props_key"], PROPS_KEY);
        assert_eq!(
            golden["signature"]["schema"],
            momo_wire::human_control::HUMAN_CONTROL_SCHEMA_V2
        );
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            if case.get("database").is_some() {
                continue; // decided in the transaction (PG conformance)
            }
            let name = case["name"].as_str().unwrap();
            let settings = if case["flag"] == false {
                DeviceKeySettings::default()
            } else {
                on()
            };
            let kind = match case["principal"].as_str() {
                Some("agent") => PrincipalKind::Agent,
                _ => PrincipalKind::Human,
            };
            let outcome =
                validated_instruction(&principal(kind), &settings, request(case["body"].clone()));
            match (outcome, case["status"].as_u64().unwrap()) {
                (Err(error), status) => {
                    assert_eq!(u64::from(error.status.as_u16()), status, "{name}");
                    assert_eq!(error.code, case["code"].as_str(), "{name}");
                }
                (Ok(_), status) => assert!(status == 201 || status == 200, "{name}"),
            }
            checked += 1;
        }
        assert_eq!(
            checked, 10,
            "the golden's pre-database cases were exercised"
        );
    }

    #[test]
    fn the_route_is_neither_an_agent_route_nor_signable_by_a_host() {
        let path = format!(
            "/v1/workspaces/{}/work-sessions/{}/instructions",
            Uuid::from_u128(2),
            Uuid::from_u128(4)
        );
        assert_eq!(momo_auth::required_agent_scope("POST", &path), None);
    }

    #[test]
    fn the_signature_request_shape_is_the_e3_one() {
        // `humanSignature` is exactly E3's envelope — no second shape.
        let signature: HumanSignatureRequest = serde_json::from_value(json!({
            "deviceKeyId": Uuid::from_u128(5), "nonce": Uuid::from_u128(6),
            "issuedAtMs": 1, "expiresAtMs": 2, "signature": "x", "mode": "queue"
        }))
        .unwrap();
        assert_eq!(signature.mode.as_deref(), Some("queue"));
    }
}
