//! 「기본 AI」 운영자 행 (#3009, ADR-0147 증보 2026-09-28 · ADR-0190 증보
//! 2026-09-28).
//!
//! ```text
//! GET /v1/provider/default-ai     PUT /v1/provider/default-ai
//! ```
//!
//! The team rows of the 「기본 AI」 table: which **team link** (cascade
//! position) and which **model id** a team agent's answer and the channel
//! summary / welcome opener default to. The guardrail row is reported as `off`
//! and cannot be changed until the decision-model ADR is Accepted (AI 계정 Q6).
//!
//! ## Rules this module holds
//!
//! 1. **Operator only, both verbs.** The same MOMO-583 gate as
//!    `/v1/provider/link` (`require_instance_operator`), because the web table's
//!    "운영자 설정" verdict is exactly that route's 200/403: a member who is
//!    shown no values is also served none.
//! 2. **No secret on the wire or in the row.** A row is a position, the
//!    redacted endpoint label that position had, and a sanitized model id. The
//!    bearer is never read here, so this surface does not need the master key.
//! 3. **A team row never names a personal credential.** `source` must be
//!    `team_link`; anything else is a 400 here and a CHECK violation in the
//!    table (brief §4.5 invariant 2).
//! 4. **Rows are patches.** `PUT` changes only the rows its body names, so two
//!    operators editing different rows do not overwrite each other (the race
//!    #3012 removes from notification rules is not reintroduced here).
//!
//! What this surface does **not** do yet: the agent-worker does not read these
//! rows. The precedence it will apply is `agent.model` > `team_agent.modelId` >
//! `AGENT_MODEL` (brief §4.2: the team row is a default, never an override of an
//! agent's own model). That wiring is a follow-up (see the PR's 이탈표).

use axum::extract::State;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_settings::{
    delete_default_ai, read_chain, read_default_ai, read_link, redacted_endpoint_label,
    sanitized_model_id, upsert_default_ai, DefaultAiRole, StoredChainEntry, StoredDefaultAi,
    StoredProviderLink, GUARDRAIL_OFF, MAX_MODEL_ID_BYTES, TEAM_LINK_SOURCE,
};

use crate::dto::{
    OptionalPatch, ProviderDefaultAiGuardrailDto, ProviderDefaultAiResponse,
    ProviderDefaultAiRowDto, ProviderDefaultAiRowInput, PutProviderDefaultAiRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{audit_via_token_id, require_instance_operator};
use crate::AppState;

const SCHEMA: &str = "momo.provider.default_ai.v0";
const AUDIT_SCHEMA: &str = "momo.provider_default_ai.audit.v0";

/// A validated row change.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RowChange {
    Keep,
    Clear,
    Set {
        position: i32,
        model_id: Option<String>,
    },
}

/// Validate one row of the body. Pure, so the refusals are unit-tested.
fn validated_row(
    field: &str,
    patch: &OptionalPatch<ProviderDefaultAiRowInput>,
) -> Result<RowChange, ApiError> {
    let input = match patch {
        OptionalPatch::Absent => return Ok(RowChange::Keep),
        OptionalPatch::Set(None) => return Ok(RowChange::Clear),
        OptionalPatch::Set(Some(input)) => input,
    };
    if input.source != TEAM_LINK_SOURCE {
        return Err(ApiError::bad_request(format!(
            "{field}.source must be {TEAM_LINK_SOURCE}: a team row runs on the team's API key \
             and never on a personal subscription (ADR-0190 증보 2026-09-28)"
        )));
    }
    if input.link_position < 0 {
        return Err(ApiError::bad_request(format!(
            "{field}.linkPosition must be >= 0"
        )));
    }
    let model_id = match input.model_id.as_deref() {
        None => None,
        Some(raw) => Some(sanitized_model_id(raw).ok_or_else(|| {
            ApiError::bad_request(format!(
                "{field}.modelId must be 1-{MAX_MODEL_ID_BYTES} characters of \
                 [A-Za-z0-9._:/@+-] starting with a letter or digit"
            ))
        })?),
    };
    Ok(RowChange::Set {
        position: input.link_position,
        model_id,
    })
}

/// The guardrail patch: only `off`, and only as a no-op, until the decision
/// model ADR is Accepted.
fn validated_guardrail(request: &PutProviderDefaultAiRequest) -> Result<(), ApiError> {
    match request.guardrail.as_ref() {
        None => Ok(()),
        Some(input) if input.mode == GUARDRAIL_OFF => Ok(()),
        Some(_) => Err(ApiError::bad_request(
            "guardrail.mode can only be off until the decision-model ADR is Accepted \
             (AI 계정 Q6)",
        )),
    }
}

/// The redacted endpoint label each configured position has *now*. Position 0
/// is the stored link, or the env tier when no link is stored.
fn current_label(
    env_base_url: &str,
    position: i32,
    link: Option<&StoredProviderLink>,
    chain: &[StoredChainEntry],
) -> Option<String> {
    if position == 0 {
        let base_url = match link {
            Some(row) => row.base_url.as_str(),
            None => env_base_url,
        };
        return (!base_url.trim().is_empty()).then(|| redacted_endpoint_label(base_url));
    }
    chain
        .iter()
        .find(|entry| entry.position == position)
        .map(|entry| redacted_endpoint_label(&entry.base_url))
}

fn row_dto(
    state: &AppState,
    row: &StoredDefaultAi,
    link: Option<&StoredProviderLink>,
    chain: &[StoredChainEntry],
) -> ProviderDefaultAiRowDto {
    let now = current_label(
        &state.settings.env_provider.base_url,
        row.link_position,
        link,
        chain,
    );
    ProviderDefaultAiRowDto {
        source: TEAM_LINK_SOURCE,
        link_position: row.link_position,
        endpoint_label: row.link_endpoint_label.clone(),
        link_resolved: now.as_deref() == Some(row.link_endpoint_label.as_str()),
        model_id: row.model_id.clone(),
        updated_by: row.updated_by_member_id.map(|id| id.to_string()),
        updated_at_ms: row.updated_at_ms,
    }
}

fn response(
    state: &AppState,
    rows: &[StoredDefaultAi],
    link: Option<&StoredProviderLink>,
    chain: &[StoredChainEntry],
) -> ProviderDefaultAiResponse {
    let find = |role: DefaultAiRole| {
        rows.iter()
            .find(|row| row.role == role)
            .map(|row| row_dto(state, row, link, chain))
    };
    ProviderDefaultAiResponse {
        schema: SCHEMA,
        team_agent: find(DefaultAiRole::TeamAgent),
        summary: find(DefaultAiRole::Summary),
        guardrail: ProviderDefaultAiGuardrailDto {
            mode: GUARDRAIL_OFF,
            available: false,
        },
    }
}

type Snapshot = (
    Vec<StoredDefaultAi>,
    Option<StoredProviderLink>,
    Vec<StoredChainEntry>,
);

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderDefaultAiResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let (rows, link, chain): Snapshot =
        with_provider_link_admin_tx(&state.pool, principal.workspace_id, move |conn| {
            Box::pin(async move {
                let rows = read_default_ai(conn).await?;
                let link = read_link(conn).await?;
                let chain = read_chain(conn).await?;
                Ok((rows, link, chain))
            })
        })
        .await
        .map_err(|error| ApiError::internal("provider_default_ai.get", error))?;
    Ok(Json(response(&state, &rows, link.as_ref(), &chain)))
}

pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PutProviderDefaultAiRequest>,
) -> Result<Json<ProviderDefaultAiResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    validated_guardrail(&request)?;
    let changes = [
        (
            DefaultAiRole::TeamAgent,
            validated_row("teamAgent", &request.team_agent)?,
        ),
        (
            DefaultAiRole::Summary,
            validated_row("summary", &request.summary)?,
        ),
    ];

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let env_base_url = state.settings.env_provider.base_url.clone();

    // `Err(position)` = the body referenced a position that is not configured;
    // the transaction rolls back nothing because nothing was written yet.
    let outcome: Result<Snapshot, (String, i32)> =
        with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let link = read_link(conn).await?;
                let chain = read_chain(conn).await?;
                // Resolve every referenced position before the first write.
                let mut writes = Vec::new();
                for (role, change) in changes {
                    match change {
                        RowChange::Keep => {}
                        RowChange::Clear => writes.push((role, None)),
                        RowChange::Set { position, model_id } => {
                            let label =
                                current_label(&env_base_url, position, link.as_ref(), &chain);
                            match label {
                                Some(label) => {
                                    writes.push((role, Some((position, label, model_id))))
                                }
                                None => {
                                    return Ok(Err((role.as_str().to_string(), position)));
                                }
                            }
                        }
                    }
                }
                for (role, write) in writes {
                    let audit = match write {
                        Some((position, label, model_id)) => {
                            upsert_default_ai(
                                conn,
                                role,
                                position,
                                &label,
                                model_id.as_deref(),
                                member_id,
                            )
                            .await?;
                            // Position, label and model id only — the same
                            // non-secret facts the row holds (ADR-0004).
                            serde_json::json!({
                                "role": role.as_str(),
                                "source": TEAM_LINK_SOURCE,
                                "link_position": position,
                                "endpoint_label": label,
                                "model_id": model_id,
                            })
                        }
                        None => {
                            if !delete_default_ai(conn, role).await? {
                                continue;
                            }
                            serde_json::json!({"role": role.as_str(), "cleared": true})
                        }
                    };
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "provider_default_ai.updated")
                            .by(member_id)
                            .via_token(via_token)
                            .with_schema(AUDIT_SCHEMA, audit),
                    )
                    .await?;
                }
                let rows = read_default_ai(conn).await?;
                Ok(Ok((rows, link, chain)))
            })
        })
        .await
        .map_err(|error| ApiError::internal("provider_default_ai.put", error))?;

    match outcome {
        Ok((rows, link, chain)) => Ok(Json(response(&state, &rows, link.as_ref(), &chain))),
        Err((role, position)) => Err(ApiError::bad_request(format!(
            "{role}: linkPosition {position} is not a configured team link"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::ProviderDefaultAiGuardrailInput;
    use axum::http::StatusCode;

    fn row(source: &str, position: i32, model: Option<&str>) -> ProviderDefaultAiRowInput {
        ProviderDefaultAiRowInput {
            source: source.to_string(),
            link_position: position,
            model_id: model.map(str::to_string),
        }
    }

    #[test]
    fn absent_keeps_null_clears_object_sets() {
        assert_eq!(
            validated_row("teamAgent", &OptionalPatch::Absent).unwrap(),
            RowChange::Keep
        );
        assert_eq!(
            validated_row("teamAgent", &OptionalPatch::Set(None)).unwrap(),
            RowChange::Clear
        );
        assert_eq!(
            validated_row(
                "teamAgent",
                &OptionalPatch::Set(Some(row("team_link", 1, Some(" gpt-5.4-codex "))))
            )
            .unwrap(),
            RowChange::Set {
                position: 1,
                model_id: Some("gpt-5.4-codex".to_string())
            }
        );
    }

    #[test]
    fn a_team_row_refuses_every_personal_source() {
        for source in [
            "profile",
            "subscription",
            "personal",
            "claude-profile",
            "codex-profile",
            "TEAM_LINK",
            "",
        ] {
            let error = validated_row("teamAgent", &OptionalPatch::Set(Some(row(source, 0, None))))
                .expect_err(source);
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{source}");
            assert!(error.message.contains("team_link"), "{}", error.message);
        }
    }

    #[test]
    fn a_bad_model_id_or_position_is_a_400() {
        for model in ["gpt 5", "<b>", "sk-a\nb", &"m".repeat(65)] {
            let error = validated_row(
                "summary",
                &OptionalPatch::Set(Some(row("team_link", 0, Some(model)))),
            )
            .expect_err(model);
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
        let error = validated_row(
            "summary",
            &OptionalPatch::Set(Some(row("team_link", -1, None))),
        )
        .expect_err("negative");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_body_is_closed_so_no_path_or_token_rides_along() {
        for body in [
            serde_json::json!({"teamAgent": {"source": "team_link", "linkPosition": 0,
                                             "profileDir": "/Users/me/.oort/profiles/a"}}),
            serde_json::json!({"teamAgent": {"source": "team_link", "linkPosition": 0,
                                             "bearer": "sk-live"}}),
            serde_json::json!({"appCommand": {"source": "profile", "linkPosition": 0}}),
        ] {
            assert!(
                serde_json::from_value::<PutProviderDefaultAiRequest>(body.clone()).is_err(),
                "{body}"
            );
        }
        let parsed: PutProviderDefaultAiRequest = serde_json::from_value(
            serde_json::json!({"summary": null, "guardrail": {"mode": "off"}}),
        )
        .unwrap();
        assert!(matches!(parsed.team_agent, OptionalPatch::Absent));
        assert!(matches!(parsed.summary, OptionalPatch::Set(None)));
    }

    #[test]
    fn the_guardrail_only_accepts_off() {
        let with = |mode: &str| PutProviderDefaultAiRequest {
            team_agent: OptionalPatch::Absent,
            summary: OptionalPatch::Absent,
            guardrail: Some(ProviderDefaultAiGuardrailInput {
                mode: mode.to_string(),
            }),
        };
        assert!(validated_guardrail(&with("off")).is_ok());
        for mode in ["observe", "on", "OFF"] {
            assert_eq!(
                validated_guardrail(&with(mode)).unwrap_err().status,
                StatusCode::BAD_REQUEST
            );
        }
    }
}
