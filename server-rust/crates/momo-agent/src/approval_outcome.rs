//! The terminal card's public, value-free projection (ADR-0186 v6 R-b/R-d).
//! SQL composition belongs to the caller and momo-messaging, never this crate.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::approval::{decided_props_patch, LockedApproval};

/// A code is the contract; this Korean sentence is the legacy/body/push fallback.
pub fn outcome_code_and_line(status: &str) -> (&'static str, &'static str) {
    match status {
        "approved" => ("approval_approved", "승인됐어요"),
        "rejected" => ("approval_rejected", "거부됐어요"),
        "expired" => ("approval_expired", "승인을 기다리다 만료됐어요"),
        "cancelled" => ("human_cancelled", "요청을 멈췄어요"),
        _ => unreachable!("only a terminal approval status has an outcome"),
    }
}

/// Ready for the single messaging writer. `executed` is the closed public
/// action-result object, never approval.payload or the one-time receipt.
pub struct ApprovalCardOutcome {
    pub patch: Value,
    pub body: String,
    pub notify_requester: bool,
}

pub fn approval_card_outcome(
    approval: &LockedApproval,
    status: &str,
    decided_by: Option<uuid::Uuid>,
    decided_at: DateTime<Utc>,
    executed: Option<(Value, String)>,
) -> ApprovalCardOutcome {
    let (code, fallback) = outcome_code_and_line(status);
    let has_execution = executed.is_some();
    let (mut result, body) = match executed {
        Some((result, line)) => (Some(result), line),
        None if status == "approved" => (None, fallback.to_string()),
        None => (
            Some(json!({
                "v": 1,
                "action_id": approval.payload.pointer("/action/id").and_then(Value::as_str)
                    .unwrap_or("tool_call"),
                "status": status,
                "approval_id": approval.id,
                "decided_by": decided_by,
                "rows": [],
                "secret_shown_once": false,
            })),
            fallback.to_string(),
        ),
    };
    if let Some(result) = result.as_mut() {
        result["line"] = json!(body);
    }
    let mut patch = decided_props_patch(status, decided_by, decided_at, None);
    patch["code"] = json!(code);
    if let Some(result) = result {
        patch["result"] = result;
    }
    let tool_name = approval
        .payload
        .pointer("/tool_call/name")
        .and_then(Value::as_str);
    let is_login_handoff = approval.action_type == "tool_call"
        && tool_name.is_some_and(|name| {
            crate::tools::normalize(name)
                == crate::tools::normalize(crate::tools::WORK_SESSION_LOGIN_HANDOFF)
        });
    // Login handoffs keep the client's title and the agent's reason. The
    // terminal status/code changes, but neither presentation field is patched.
    if !is_login_handoff {
        patch["summary"] = json!(body);
    }
    if approval.action_type == "tool_call" && !is_login_handoff {
        patch["title"] = json!(tool_name
            .map(|name| format!("도구 「{name}」 실행"))
            .unwrap_or_else(|| "도구 실행 승인".to_string()));
    }
    ApprovalCardOutcome {
        patch,
        body,
        notify_requester: matches!(status, "rejected" | "expired") || has_execution,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_login_handoff_preserves_its_title_and_reason() {
        use crate::approval::approval_request_props;
        use crate::provisioning::ModelSource;
        use crate::tools::{ToolCall, WORK_SESSION_LOGIN_HANDOFF};
        use uuid::Uuid;

        let now = Utc::now();
        for name in [WORK_SESSION_LOGIN_HANDOFF, " WORK.SESSION.LOGIN_HANDOFF "] {
            for reason in [Some("로그인이 필요해요."), None] {
                let call = ToolCall {
                    call_id: "login-call".into(),
                    name: name.into(),
                    arguments: json!({"reason": reason, "session_id": Uuid::nil()}),
                };
                let approval = LockedApproval {
                    id: Uuid::from_u128(1),
                    workspace_id: Uuid::from_u128(2),
                    run_id: Uuid::from_u128(3),
                    channel_id: Uuid::from_u128(4),
                    requested_by: Uuid::from_u128(5),
                    request_message_id: Some(Uuid::from_u128(6)),
                    action_type: "tool_call".into(),
                    payload: json!({"tool_call": {
                        "call_id": call.call_id, "name": call.name, "arguments": call.arguments,
                    }}),
                    status: "pending".into(),
                    expires_at: Some(now),
                    agent_model: "test-model".into(),
                    agent_model_source: ModelSource::Agent,
                    run_input: json!({}),
                    step_count: 1,
                    max_steps: 12,
                    depth: 0,
                };
                let props = approval_request_props(
                    approval.id,
                    approval.run_id,
                    approval.channel_id,
                    "tool_call",
                    &call,
                    "{}",
                    now,
                    None,
                );
                assert!(props.get("title").is_none());
                assert_eq!(props.get("summary"), reason.map(|r| json!(r)).as_ref());
                for status in ["approved", "rejected", "expired", "cancelled"] {
                    let outcome = approval_card_outcome(&approval, status, None, now, None);
                    let mut settled = props.clone();
                    settled
                        .as_object_mut()
                        .unwrap()
                        .extend(outcome.patch.as_object().unwrap().clone());
                    assert!(settled.get("title").is_none(), "{status}: client title");
                    assert_eq!(
                        settled.get("summary"),
                        props.get("summary"),
                        "{status}: reason"
                    );
                    assert_eq!(settled["kind"], props["kind"]);
                    assert_eq!(settled["session_id"], props["session_id"]);
                    assert_eq!(settled["status"], status);
                    assert_eq!(settled["code"], outcome_code_and_line(status).0);
                }
            }
        }
    }

    #[test]
    fn outcome_copy_matches_the_client_golden_data() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../../packages/momo-core/src/features/approvals/settlement-copy.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let (code, line) = outcome_code_and_line(case["status"].as_str().unwrap());
            assert_eq!(case["code"], code);
            assert_eq!(case["line"], line);
        }
    }
}
