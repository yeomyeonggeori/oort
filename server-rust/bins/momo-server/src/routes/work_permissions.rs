//! ADR-0188 D5 — the permission bridge's decision route (#3000, §8.6 증보).
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-sessions/{session}/permission-decisions   (human bearer)
//! ```
//!
//! A member host relays an ACP `session/request_permission` as an
//! `approval.requested` session event, and ingestion records it in
//! `work_permission_request` keyed by that event's id
//! (`work_sessions::record_acp_event_in_tx`). This route is the only way such a
//! request is answered by a person, and it keeps four rules:
//!
//! * **Who decides — the session's owner, who is the host's owner (D3).** A
//!   human bearer only: an agent bearer never reaches this handler (the route
//!   is absent from `momo_auth::required_agent_scope`), a signed host never
//!   does either (it is not on `work_host_auth`'s allow-list), and the handler
//!   refuses any other principal again. Channel membership or an admin role
//!   is not a substitute. So an agent cannot approve its own request.
//! * **What — `allow_once` or `reject_once`, and only an option the host
//!   offered with that kind.** The client's `kind` is checked against the
//!   *stored* option: an `allow_always` option id labelled `allow_once` is
//!   refused, and so is every other kind (D5: 「항상 허용」 is never chosen
//!   here).
//! * **Once.** The first `pending → approved | rejected` UPDATE wins. The same
//!   decision again answers 200 with the same row; a different one answers
//!   409. A request whose deadline passed, whose turn or session is over, or
//!   whose host was revoked answers 409 as well, and is recorded as closed.
//! * **Delivered and recorded.** In the same transaction the decision becomes
//!   a `permission` control addressed to the session's host (the host answers
//!   the agent's ACP request from it), an `approval.decided` session event
//!   that closes every owner device's card, and an audit row.
//!
//! 「거부하고 지시」's instruction is refused while R1 lasts: the next turn it
//! would start is an owner `input`, which ADR-0188 D3 opens only with R2's
//! device-key signature.
//!
//! ## R2 — the owner's device signature (ADR-0146 개정 D-8 · D-10, #3023)
//!
//! A decision may carry `humanSignature`: the owner's `momo.human.control.v1`
//! statement (`kind=permission`) over the stored request event id, the stored
//! option id and kind, and the scope. It is verified whenever it is sent
//! ([`crate::human_control`]), against the session's host and session — never
//! the request's — and, once verified, rides on the `permission` control
//! (`WorkControl.humanSignature` for workd) with an `action_signature` row in
//! the same transaction.
//!
//! * An **allow** needs it when the instance set
//!   `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` (403 `device_signature_required`).
//! * A **reject** never needs it (D-8: the switch-off side is unsigned).
//! * Scope `session` (「이 세션 동안」) is refused until E8 (#3028) opens it —
//!   400 `permission_scope_unsupported`; the host refuses it too.
//! * The idempotent retry of a decided request answers before the signature
//!   is looked at, so resending the same signed decision is not a replay.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::human_control::{ControlSubject, ControlTarget};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_t3::work_control::{
    active_host_owner_in_tx, insert_work_control_in_tx, target_work_host_in_tx, NewWorkControl,
    HOST_SCOPE_MEMBER, KIND_PERMISSION, STATUS_APPROVED as CONTROL_STATUS_APPROVED,
};
use momo_t3::work_permission::{
    attach_permission_control_in_tx, close_permission_request_in_tx,
    decide_permission_request_in_tx, is_bridgeable_kind, lock_permission_request_in_tx,
    permission_control_payload, PermissionOption, PermissionRequestRow, KIND_ALLOW_ONCE,
    STATUS_APPROVED, STATUS_CANCELLED, STATUS_EXPIRED, STATUS_PENDING, STATUS_REJECTED,
};
use momo_t3::{lock_work_session_detail_in_tx, T3Error};
use serde_json::json;
use uuid::Uuid;

use crate::config::DeviceKeySettings;
use crate::dto::{
    HumanSignatureRequest, WorkPermissionDecisionRequest, WorkPermissionDecisionResponse,
    WorkPermissionRequestDto, WorkSessionAcpEvent,
};
use crate::error::ApiError;
use crate::human_control::{
    authorize_human_control_in_tx, record_control_provenance_in_tx, signature_columns,
};
use crate::routes::shared::{
    audit_via_token_id, path_uuid, settle, tenant_tx, workspace_scope, Rejectable,
};
use crate::routes::work_controls::dispatch_control_in_tx;
use crate::routes::work_sessions::{publish_session_event_in_tx, validated_acp_event};
use crate::AppState;

/// Stable machine codes (the golden file `docs/api/work-permission-decision.golden.json`
/// pins them for the web port).
pub const CODE_NOT_HUMAN: &str = "permission_decider_not_human";
pub const CODE_OWNER_ONLY: &str = "permission_owner_only";
pub const CODE_KIND_REFUSED: &str = "permission_kind_refused";
pub const CODE_OPTION_INVALID: &str = "permission_option_invalid";
pub const CODE_INSTRUCTION_UNSUPPORTED: &str = "permission_instruction_unsupported";
pub const CODE_ALREADY_DECIDED: &str = "permission_already_decided";
pub const CODE_REQUEST_CLOSED: &str = "permission_request_closed";
/// #3023: a signed decision for 「이 세션 동안」 before E8 (#3028) opens it.
pub const CODE_SCOPE_UNSUPPORTED: &str = "permission_scope_unsupported";

const AUDIT_PERMISSION_DECIDED: &str = "work.permission.decided";
const SCHEMA_PERMISSION_DECIDED: &str = "momo.work_permission.decided.v1";
const OPTION_ID_MAX: usize = 128;

fn dto(row: &PermissionRequestRow) -> WorkPermissionRequestDto {
    WorkPermissionRequestDto {
        id: row.id.to_string(),
        session_id: row.work_session_id.to_string(),
        request_event_id: row.request_event_id.to_string(),
        status: row.status.clone(),
        decided_option_id: row.decided_option_id.clone(),
        decided_kind: row.decided_kind.clone(),
        decided_by: row.decided_by.map(|id| id.to_string()),
        decided_at_ms: row.decided_at_ms,
        control_id: row.control_id.map(|id| id.to_string()),
        expires_at_ms: row.expires_at_ms,
    }
}

fn closed() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        CODE_REQUEST_CLOSED,
        "permission request is no longer open",
    )
}

/// Everything judged before a transaction opens.
#[derive(Debug, Clone)]
struct Decision {
    request_event_id: Uuid,
    option_id: String,
    kind: String,
    /// The owner's device signature, verified inside the transaction.
    human_signature: Option<HumanSignatureRequest>,
}

fn validated_decision(
    principal: &Principal,
    request: WorkPermissionDecisionRequest,
) -> Result<Decision, ApiError> {
    // D3: 결정 라우트는 사람 principal만. Middleware already keeps agents and
    // signed hosts out; this is the handler's own statement of it.
    if principal.kind != PrincipalKind::Human {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_NOT_HUMAN,
            "permission decisions require the session owner's human bearer",
        ));
    }
    let kind = request.kind.trim();
    if !is_bridgeable_kind(kind) {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_KIND_REFUSED,
            "kind must be allow_once or reject_once",
        ));
    }
    let option_id = request.option_id;
    if option_id.is_empty() || option_id.chars().count() > OPTION_ID_MAX {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_OPTION_INVALID,
            "optionId must contain 1...128 characters",
        ));
    }
    if request
        .instruction
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_INSTRUCTION_UNSUPPORTED,
            "an instruction with a rejection is not accepted yet (owner input is R2)",
        ));
    }
    if request
        .human_signature
        .as_ref()
        .is_some_and(|signature| signature.scope.as_deref() == Some("session"))
    {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_SCOPE_UNSUPPORTED,
            "「이 세션 동안」 is not accepted yet; sign scope once",
        ));
    }
    Ok(Decision {
        request_event_id: request.request_event_id,
        option_id,
        kind: kind.to_string(),
        human_signature: request.human_signature,
    })
}

/// The stored option a decision names — only when its stored kind is the kind
/// the decision states and one the bridge may choose.
fn chosen_option(options: &[PermissionOption], decision: &Decision) -> Option<PermissionOption> {
    options
        .iter()
        .find(|option| option.option_id == decision.option_id)
        .filter(|option| option.kind == decision.kind && is_bridgeable_kind(&option.kind))
        .cloned()
}

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/permission-decisions`.
pub async fn decide(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<WorkPermissionDecisionRequest>,
) -> Result<Json<WorkPermissionDecisionResponse>, ApiError> {
    let decision = validated_decision(&principal, request)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let settings = state.device_keys.clone();

    let row = settle(
        "work_permissions.decide",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                decide_in_tx(
                    conn,
                    DecideInput {
                        workspace_id,
                        session_id,
                        member_id,
                        via_token_id,
                        settings: &settings,
                    },
                    &decision,
                )
                .await
            })
        })
        .await,
    )?;
    Ok(Json(WorkPermissionDecisionResponse {
        permission_request: dto(&row),
    }))
}

struct DecideInput<'a> {
    workspace_id: Uuid,
    session_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    settings: &'a DeviceKeySettings,
}

async fn decide_in_tx(
    conn: &mut PgConnection,
    input: DecideInput<'_>,
    decision: &Decision,
) -> Rejectable<PermissionRequestRow> {
    let DecideInput {
        workspace_id,
        session_id,
        member_id,
        via_token_id,
        settings,
    } = input;
    // Lock order: session → host (share) → request, the order ingestion
    // (session → request) and revoke (host → request) agree with.
    let Some((session, _)) = lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    // D3: 결정자 = 세션 소유자 = host 소유자. Both, so neither a session
    // handed to someone else nor a host registered by someone else can move
    // the decision off the machine's owner.
    if session.member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_OWNER_ONLY,
            "only the session owner can decide its permission requests",
        )));
    }
    let host_owner = active_host_owner_in_tx(conn, workspace_id, session.host_id).await?;
    if host_owner.is_some_and(|owner| owner != member_id) {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_OWNER_ONLY,
            "only the host owner can decide its permission requests",
        )));
    }

    let Some(request) =
        lock_permission_request_in_tx(conn, workspace_id, session_id, decision.request_event_id)
            .await?
    else {
        return Ok(Err(ApiError::not_found("permission request not found")));
    };

    match request.status.as_str() {
        STATUS_APPROVED | STATUS_REJECTED => {
            // Once: the same decision again is the same answer, anything
            // else is refused.
            return Ok(
                if request.decided_option_id.as_deref() == Some(decision.option_id.as_str())
                    && request.decided_kind.as_deref() == Some(decision.kind.as_str())
                {
                    Ok(request)
                } else {
                    Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        CODE_ALREADY_DECIDED,
                        "permission request was already decided",
                    ))
                },
            );
        }
        STATUS_EXPIRED | STATUS_CANCELLED => return Ok(Err(closed())),
        STATUS_PENDING => {}
        other => {
            return Err(T3Error::IllegalTransition(format!(
                "unknown permission request status {other}"
            )))
        }
    }

    // Close what can no longer be answered, and say so (the close commits:
    // a rejection after this point is not "before the first write", on
    // purpose — the row should tell the truth either way).
    let close_as = if request.lapsed {
        Some(STATUS_EXPIRED)
    } else if host_owner.is_none() || session.status != "running" {
        // Revoked host, or the turn / session is over: nobody is waiting.
        Some(STATUS_CANCELLED)
    } else {
        None
    };
    if let Some(status) = close_as {
        close_permission_request_in_tx(conn, workspace_id, request.id, status).await?;
        return Ok(Err(closed()));
    }

    // The client's kind is checked against the STORED option, never trusted.
    let Some(option) = chosen_option(&request.options, decision) else {
        return Ok(Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            CODE_OPTION_INVALID,
            "optionId is not an offered option of that kind",
        )));
    };

    // R2 (#3023): the owner's device signature over exactly this decision —
    // the STORED event id and option, this session, the session's host. The
    // last check before the writes: it spends the nonce.
    let host_is_member = target_work_host_in_tx(conn, workspace_id, session.host_id)
        .await?
        .is_some_and(|host| host.scope == HOST_SCOPE_MEMBER);
    let required = settings.human_control_signature_required
        && host_is_member
        && option.kind == KIND_ALLOW_ONCE;
    let verified = match authorize_human_control_in_tx(
        conn,
        settings,
        &ControlTarget {
            workspace_id,
            member_id,
            host_id: session.host_id,
            session_id: Some(session_id),
            subject: ControlSubject::Permission {
                request_event_id: request.request_event_id,
                option_id: &option.option_id,
                option_kind: &option.kind,
            },
        },
        decision.human_signature.as_ref(),
        required,
    )
    .await?
    {
        Ok(verified) => verified,
        Err(refusal) => return Ok(Err(refusal)),
    };

    // ---- writes ------------------------------------------------------------
    let Some(decided) =
        decide_permission_request_in_tx(conn, workspace_id, request.id, member_id, &option).await?
    else {
        // The row is locked, so only the clock can get here first.
        close_permission_request_in_tx(conn, workspace_id, request.id, STATUS_EXPIRED).await?;
        return Ok(Err(closed()));
    };

    // D3: the `permission` control is made here and nowhere else. The target
    // host comes from the session row, never from the request.
    let control = insert_work_control_in_tx(
        conn,
        workspace_id,
        NewWorkControl {
            channel_id: session.channel_id,
            requester_member_id: member_id,
            target_host_id: session.host_id,
            session_id: Some(session_id),
            kind: KIND_PERMISSION.to_string(),
            payload: permission_control_payload(
                decided.request_event_id,
                &option.option_id,
                &option.kind,
            ),
            status: CONTROL_STATUS_APPROVED.to_string(),
            human: verified.as_ref().map(signature_columns),
        },
    )
    .await?;
    if let Some(verified) = &verified {
        record_control_provenance_in_tx(conn, workspace_id, control.id, verified).await?;
    }
    let control = dispatch_control_in_tx(conn, workspace_id, &control).await?;
    let decided = attach_permission_control_in_tx(conn, workspace_id, decided.id, control.id)
        .await?
        .unwrap_or(decided);

    // D5: 「결과는 … 모든 소유자 기기의 카드를 닫는다」 — now, not after the
    // host's round trip. Same shape and validation as a relayed event.
    let approved = option.kind == KIND_ALLOW_ONCE;
    let event = WorkSessionAcpEvent {
        event_id: Uuid::new_v4(),
        event_type: "approval.decided".to_string(),
        v: 1,
        ts: chrono::Utc::now().timestamp_millis(),
        payload: json!({
            "run_id": session_id.to_string(),
            "work_session_id": session_id.to_string(),
            "channel_id": session.channel_id.to_string(),
            "action": "decided",
            "status": if approved { "approved" } else { "rejected" },
            "option_id": option.option_id,
            "request_event_id": decided.request_event_id.to_string(),
        }),
    };
    let normalized = validated_acp_event(&event, session_id).map_err(|error| {
        T3Error::IllegalTransition(format!("server decision event invalid: {error:?}"))
    })?;
    publish_session_event_in_tx(conn, workspace_id, &session, &event, &normalized).await?;

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_PERMISSION_DECIDED)
            .by(member_id)
            .about(member_id)
            .target("work_permission_request", decided.id)
            .via_token(via_token_id)
            .with_schema(
                SCHEMA_PERMISSION_DECIDED,
                json!({
                    "request_event_id": decided.request_event_id.to_string(),
                    "work_session_id": session_id.to_string(),
                    "host_id": session.host_id.to_string(),
                    "option_id": option.option_id,
                    "kind": option.kind,
                    "control_id": control.id.to_string(),
                    "control_status": control.status,
                    "device_key_id": verified.as_ref().map(|v| v.key.id.to_string()),
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok(decided))
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

    fn request(kind: &str) -> WorkPermissionDecisionRequest {
        WorkPermissionDecisionRequest {
            request_event_id: Uuid::from_u128(3),
            option_id: "allow-once".into(),
            kind: kind.into(),
            instruction: None,
            human_signature: None,
        }
    }

    #[test]
    fn only_a_human_decides() {
        for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
            let refused = validated_decision(&principal(kind), request("allow_once")).unwrap_err();
            assert_eq!(refused.status, StatusCode::FORBIDDEN);
            assert_eq!(refused.code, Some(CODE_NOT_HUMAN));
        }
        assert!(
            validated_decision(&principal(PrincipalKind::Human), request("allow_once")).is_ok()
        );
    }

    #[test]
    fn only_the_two_once_kinds_are_accepted() {
        let human = principal(PrincipalKind::Human);
        for kind in ["allow_always", "reject_always", "Allow_Once", "", "bypass"] {
            let refused = validated_decision(&human, request(kind)).unwrap_err();
            assert_eq!(refused.status, StatusCode::BAD_REQUEST, "{kind}");
            assert_eq!(refused.code, Some(CODE_KIND_REFUSED), "{kind}");
        }
        for kind in ["allow_once", "reject_once"] {
            assert_eq!(
                validated_decision(&human, request(kind)).unwrap().kind,
                kind
            );
        }
    }

    #[test]
    fn an_instruction_is_refused_until_r2_but_an_empty_one_is_nothing() {
        let human = principal(PrincipalKind::Human);
        let mut with_text = request("reject_once");
        with_text.instruction = Some("do it differently".into());
        assert_eq!(
            validated_decision(&human, with_text).unwrap_err().code,
            Some(CODE_INSTRUCTION_UNSUPPORTED)
        );
        let mut blank = request("reject_once");
        blank.instruction = Some("   ".into());
        assert!(validated_decision(&human, blank).is_ok());
    }

    /// The golden contract the web port binds to
    /// (`docs/api/work-permission-decision.golden.json`): its error codes are
    /// these constants, its request cases answer as it says wherever the
    /// answer is decided before the database, and the stored-option check
    /// answers its option cases.
    #[test]
    fn the_golden_contract_holds() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../docs/api/work-permission-decision.golden.json"
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
                CODE_NOT_HUMAN,
                CODE_OWNER_ONLY,
                CODE_KIND_REFUSED,
                CODE_OPTION_INVALID,
                CODE_INSTRUCTION_UNSUPPORTED,
                CODE_ALREADY_DECIDED,
                CODE_REQUEST_CLOSED,
                CODE_SCOPE_UNSUPPORTED,
            ]
        );
        assert_eq!(
            golden["ttl_seconds"],
            momo_t3::work_permission::PERMISSION_REQUEST_TTL_SECONDS
        );
        let stored = momo_t3::work_permission::bridgeable_options(
            &golden["approval_requested_event"]["payload"]["options"],
        );
        assert_eq!(stored.len(), 2);
        let human = principal(PrincipalKind::Human);
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            if case.get("principal").is_some() {
                continue; // decided by the database (PG conformance, wdc_6)
            }
            let request: WorkPermissionDecisionRequest =
                serde_json::from_value(case["body"].clone()).expect("case body");
            let name = case["name"].as_str().unwrap();
            let status = case["status"].as_u64().unwrap();
            let code = case["code"].as_str();
            match validated_decision(&human, request) {
                Err(error) => {
                    assert_eq!(u64::from(error.status.as_u16()), status, "{name}");
                    assert_eq!(error.code, code, "{name}");
                    checked += 1;
                }
                Ok(decision) => match chosen_option(&stored, &decision) {
                    None => {
                        assert_eq!((status, code), (400, Some(CODE_OPTION_INVALID)), "{name}");
                        checked += 1;
                    }
                    Some(option) => {
                        assert!(
                            status == 200 || status == 404 || status == 409,
                            "{name}: a valid choice is decided by the row's state"
                        );
                        assert_eq!(option.kind, decision.kind, "{name}");
                    }
                },
            }
        }
        assert_eq!(
            checked, 7,
            "the golden's seven pre-database refusals were exercised"
        );
    }

    #[test]
    fn the_decision_route_is_not_an_agent_route() {
        let path = format!(
            "/v1/workspaces/{}/work-sessions/{}/permission-decisions",
            Uuid::from_u128(2),
            Uuid::from_u128(4)
        );
        assert_eq!(momo_auth::required_agent_scope("POST", &path), None);
    }
}
