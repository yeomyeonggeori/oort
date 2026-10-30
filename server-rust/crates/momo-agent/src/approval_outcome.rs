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
    // Old card renderers already show summary, and code-aware clients translate
    // the code. No raw tool-approval English remains in the terminal card.
    patch["summary"] = json!(body);
    if approval.action_type == "tool_call" {
        patch["title"] = json!(approval
            .payload
            .pointer("/tool_call/name")
            .and_then(Value::as_str)
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
