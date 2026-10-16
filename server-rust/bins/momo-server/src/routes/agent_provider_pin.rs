//! 에이전트별 AI 연결 고정 (#3873, ADR-0147 증보 2026-10-16).
//!
//! ```text
//! GET /v1/workspaces/{ws}/agents/{agent}/provider-pin
//! PUT /v1/workspaces/{ws}/agents/{agent}/provider-pin
//! ```
//!
//! The team's default AI follows the instance head link, and a stored team key
//! beats the env `HERMES_BASE_URL`. A pin takes **one agent** off that road so a
//! team Anthropic key and a co-hosted Hermes can live in one instance: the agent
//! calls the link its pin names, and nothing else.
//!
//! ## Rules this module holds
//!
//! 1. **Instance operator only, both verbs.** Writes use the strict
//!    `require_instance_operator_write` (a `platform:read` scope is a read scope
//!    and is not enough); reads use `require_instance_operator`. A pin chooses
//!    among **instance-global** credentials, so a workspace admin (or an agent's
//!    owner) is not the right authority, and the position list is visible to
//!    operators only (`GET /v1/provider/default-ai`).
//! 2. **The gate comes before the GUC.** The pin table's write policies need
//!    `app.provider_link_admin = 'on'`, which only `with_provider_link_admin_tx`
//!    sets, after the gate above. A route that forgot the gate would still be
//!    refused by the database for any other transaction.
//! 3. **A pin is a reference, never a URL or a key.** The body is closed
//!    (`deny_unknown_fields`): `{kind, linkPosition?}`. The admin names a hop
//!    that already passed `validated_base_url`, or the operator's own env link,
//!    so no host is ever typed here and the egress rules are unchanged
//!    (ADR-0147 증보 2026-10-16 D5).
//! 4. **Position 0 is the stored `provider_link` itself**, not "the head": when
//!    no link is stored the head is the env fallback, and a pin to position 0
//!    would silently mean env. The env link has its own kind.
//! 5. **An `owner_only` agent cannot be pinned** (409): its brain is its owner's
//!    subscription or personal key (ADR-0193 D4, ADR-0147 증보 2026-10-03). The
//!    trigger in migration 136 refuses it again.
//! 6. **A team-link pin needs the agent's own model** (`modelSource = agent`).
//!    A pinned agent never applies the team's 「기본 AI」 row (its model id
//!    belongs to the team's link), so an agent on `instance_default` would call
//!    the pinned provider with the placeholder model name.
//!
//! The agent-worker reads the pin on every turn; a pin whose link is gone or has
//! changed refuses the turn honestly (`linkResolved: false` here, the
//! `pinned_link_unresolved` line there).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_settings::{
    delete_agent_pin, read_agent_pin, read_chain, read_link, redacted_endpoint_label,
    upsert_agent_pin, PinKind, StoredAgentPin, StoredChainEntry, StoredProviderLink,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, path_uuid, require_instance_operator, require_instance_operator_write,
    workspace_scope,
};
use crate::AppState;

const SCHEMA: &str = "momo.agent.provider_pin.v0";
const AUDIT_SCHEMA: &str = "momo.agent_provider_pin.audit.v0";

/// `PUT` body. Closed, so a URL, key, path or token cannot ride along.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutAgentProviderPinRequest {
    /// `default` (clear the pin), `operator_env` or `team_link`.
    pub kind: String,
    /// Required for `team_link`, refused for the others.
    #[serde(default)]
    pub link_position: Option<i32>,
}

/// What the body asks for, after validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinChange {
    Clear,
    OperatorEnv,
    TeamLink { position: i32 },
}

fn validated_change(request: &PutAgentProviderPinRequest) -> Result<PinChange, ApiError> {
    match (request.kind.as_str(), request.link_position) {
        ("default", None) => Ok(PinChange::Clear),
        ("operator_env", None) => Ok(PinChange::OperatorEnv),
        ("team_link", Some(position)) if position >= 0 => Ok(PinChange::TeamLink { position }),
        ("team_link", Some(_)) => Err(ApiError::bad_request("linkPosition must be >= 0")),
        ("team_link", None) => Err(ApiError::bad_request("team_link needs linkPosition")),
        ("default" | "operator_env", Some(_)) => Err(ApiError::bad_request(
            "linkPosition is only for kind team_link",
        )),
        _ => Err(ApiError::bad_request(
            "kind must be one of default, operator_env, team_link",
        )),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderPinResponse {
    pub schema: &'static str,
    pub agent_id: String,
    /// `null` = the agent follows the team default.
    pub pin: Option<AgentProviderPinDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderPinDto {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_position: Option<i32>,
    /// The redacted endpoint label: the one the pin was made on for
    /// `team_link`, the operator env link's for `operator_env`. Never a URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_label: Option<String>,
    /// `false` = the pinned link is gone or changed; the agent's turns are
    /// refused until an operator re-picks (nothing falls back).
    pub link_resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned_by: Option<String>,
    pub updated_at_ms: i64,
}

/// The redacted label the stored `provider_link` row has now, for position 0, or
/// the (enabled) chain hop's, for 1 and up. Position 0 never means the env fallback.
fn current_team_label(
    position: i32,
    link: Option<&StoredProviderLink>,
    chain: &[StoredChainEntry],
) -> Option<String> {
    if position == 0 {
        return link
            .filter(|row| !row.base_url.trim().is_empty())
            .map(|row| redacted_endpoint_label(&row.base_url));
    }
    // A disabled hop is not a link the worker will call (`team_link_disabled`), so it is
    // neither pinnable nor "resolved".
    chain
        .iter()
        .find(|entry| entry.position == position && entry.enabled)
        .map(|entry| redacted_endpoint_label(&entry.base_url))
}

fn env_label(env_base_url: &str) -> Option<String> {
    (!env_base_url.trim().is_empty()).then(|| redacted_endpoint_label(env_base_url))
}

fn pin_dto(
    pin: &StoredAgentPin,
    env_base_url: &str,
    link: Option<&StoredProviderLink>,
    chain: &[StoredChainEntry],
) -> AgentProviderPinDto {
    let (endpoint_label, link_resolved) = match pin.kind {
        PinKind::OperatorEnv => {
            let now = env_label(env_base_url);
            let resolved = now.is_some();
            (now, resolved)
        }
        PinKind::TeamLink => {
            let now = pin
                .link_position
                .and_then(|position| current_team_label(position, link, chain));
            let resolved = now.is_some() && now == pin.link_endpoint_label;
            (pin.link_endpoint_label.clone(), resolved)
        }
    };
    AgentProviderPinDto {
        kind: pin.kind.as_str(),
        link_position: pin.link_position,
        endpoint_label,
        link_resolved,
        pinned_by: pin.pinned_by_member_id.map(|id| id.to_string()),
        updated_at_ms: pin.updated_at_ms,
    }
}

type Snapshot = (
    Option<StoredAgentPin>,
    Option<StoredProviderLink>,
    Vec<StoredChainEntry>,
);

fn response(agent_id: Uuid, env_base_url: &str, snapshot: &Snapshot) -> AgentProviderPinResponse {
    let (pin, link, chain) = snapshot;
    AgentProviderPinResponse {
        schema: SCHEMA,
        agent_id: agent_id.to_string(),
        pin: pin
            .as_ref()
            .map(|pin| pin_dto(pin, env_base_url, link.as_ref(), chain)),
    }
}

/// What the agent row says about whether it may be pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentFacts {
    invocation_scope: String,
    model_source: String,
}

async fn read_agent_facts(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentFacts>, momo_db::DbError> {
    let row: Option<(String, String)> = momo_db::sqlx::query_as(
        "SELECT invocation_scope, model_source FROM agent \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(invocation_scope, model_source)| AgentFacts {
        invocation_scope,
        model_source,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<AgentProviderPinResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    require_instance_operator(&state, &principal).await?;
    let snapshot: Option<Snapshot> =
        with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if read_agent_facts(conn, workspace_id, agent_member_id)
                    .await?
                    .is_none()
                {
                    return Ok(None);
                }
                let pin = read_agent_pin(conn, workspace_id, agent_member_id)
                    .await
                    .map_err(pin_read_error)?;
                let link = read_link(conn).await?;
                let chain = read_chain(conn).await?;
                Ok(Some((pin, link, chain)))
            })
        })
        .await
        .map_err(|error| ApiError::internal("agent_provider_pin.get", error))?;
    let snapshot = snapshot.ok_or_else(|| ApiError::not_found("agent not found"))?;
    Ok(Json(response(
        agent_member_id,
        &state.settings.env_provider.base_url,
        &snapshot,
    )))
}

fn pin_read_error(error: momo_settings::PinReadError) -> momo_db::DbError {
    match error {
        momo_settings::PinReadError::Db(db) => db,
        // An unreadable stored kind is a server fault, not a client one.
        momo_settings::PinReadError::UnknownKind => momo_db::DbError::Sqlx(
            momo_db::sqlx::Error::Protocol("agent_provider_pin has an unknown kind".into()),
        ),
    }
}

/// The refusals a write can end in, decided inside the transaction.
enum Refusal {
    NotFound,
    OwnerOnly,
    OwnModelRequired,
    UnknownPosition(i32),
    EnvNotConfigured,
}

pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<PutAgentProviderPinRequest>,
) -> Result<Json<AgentProviderPinResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    // Authority first: a stranger learns nothing about the body's validity.
    require_instance_operator_write(&state, &principal).await?;
    let change = validated_change(&request)?;

    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let env_base_url = state.settings.env_provider.base_url.clone();

    let outcome: Result<Snapshot, Refusal> =
        with_provider_link_admin_tx(&state.pool, workspace_id, {
            let env_base_url = env_base_url.clone();
            move |conn| {
                Box::pin(async move {
                    let Some(facts) = read_agent_facts(conn, workspace_id, agent_member_id).await?
                    else {
                        return Ok(Err(Refusal::NotFound));
                    };
                    let link = read_link(conn).await?;
                    let chain = read_chain(conn).await?;
                    let before = read_agent_pin(conn, workspace_id, agent_member_id)
                        .await
                        .map_err(pin_read_error)?;
                    // Clearing a pin must work on any agent: it is the way back.
                    if change != PinChange::Clear && facts.invocation_scope == "owner_only" {
                        return Ok(Err(Refusal::OwnerOnly));
                    }
                    let (kind, position, label) = match change {
                        PinChange::Clear => {
                            let removed =
                                delete_agent_pin(conn, workspace_id, agent_member_id).await?;
                            if removed {
                                write_audit(
                                    conn,
                                    &AuditEntry::new(workspace_id, "agent.provider_pin.updated")
                                        .by(actor)
                                        .about(agent_member_id)
                                        .target("agent", agent_member_id)
                                        .via_token(via_token)
                                        .with_schema(
                                            AUDIT_SCHEMA,
                                            json!({
                                                "cleared": true,
                                                "previous_kind": before.as_ref().map(|p| p.kind.as_str()),
                                                "previous_link_position": before.as_ref().and_then(|p| p.link_position),
                                            }),
                                        ),
                                )
                                .await?;
                            }
                            return Ok(Ok((None, link, chain)));
                        }
                        PinChange::OperatorEnv => {
                            if env_label(&env_base_url).is_none() {
                                return Ok(Err(Refusal::EnvNotConfigured));
                            }
                            (PinKind::OperatorEnv, None, None)
                        }
                        PinChange::TeamLink { position } => {
                            if facts.model_source != "agent" {
                                return Ok(Err(Refusal::OwnModelRequired));
                            }
                            let Some(label) = current_team_label(position, link.as_ref(), &chain)
                            else {
                                return Ok(Err(Refusal::UnknownPosition(position)));
                            };
                            (PinKind::TeamLink, Some(position), Some(label))
                        }
                    };
                    let stored = upsert_agent_pin(
                        conn,
                        workspace_id,
                        agent_member_id,
                        kind,
                        position,
                        label.as_deref(),
                        actor,
                    )
                    .await?;
                    // Kind, position and the redacted label: the same non-secret
                    // facts the row holds (ADR-0004).
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "agent.provider_pin.updated")
                            .by(actor)
                            .about(agent_member_id)
                            .target("agent", agent_member_id)
                            .via_token(via_token)
                            .with_schema(
                                AUDIT_SCHEMA,
                                json!({
                                    "kind": kind.as_str(),
                                    "link_position": position,
                                    "endpoint_label": label,
                                    "previous_kind": before.as_ref().map(|p| p.kind.as_str()),
                                    "previous_link_position": before.as_ref().and_then(|p| p.link_position),
                                }),
                            ),
                    )
                    .await?;
                    Ok(Ok((Some(stored), link, chain)))
                })
            }
        })
        .await
        .map_err(|error| ApiError::internal("agent_provider_pin.put", error))?;

    match outcome {
        Ok(snapshot) => Ok(Json(response(agent_member_id, &env_base_url, &snapshot))),
        Err(Refusal::NotFound) => Err(ApiError::not_found("agent not found")),
        Err(Refusal::OwnerOnly) => Err(ApiError::coded(
            StatusCode::CONFLICT,
            "owner_only_agent_cannot_be_pinned",
            "this agent runs on its owner's own subscription or personal key and cannot be \
             pinned to a team link",
        )),
        Err(Refusal::OwnModelRequired) => Err(ApiError::coded(
            StatusCode::CONFLICT,
            "agent_own_model_required",
            "a pinned team link runs the agent's own model: set modelSource to agent and pick \
             a model first",
        )),
        Err(Refusal::UnknownPosition(position)) => Err(ApiError::bad_request(format!(
            "linkPosition {position} is not a configured team link"
        ))),
        Err(Refusal::EnvNotConfigured) => Err(ApiError::bad_request(
            "the operator env link (HERMES_BASE_URL) is not configured on this server",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: &str, position: Option<i32>) -> PutAgentProviderPinRequest {
        PutAgentProviderPinRequest {
            kind: kind.to_string(),
            link_position: position,
        }
    }

    #[test]
    fn each_kind_has_exactly_one_valid_shape() {
        assert_eq!(
            validated_change(&request("default", None)).unwrap(),
            PinChange::Clear
        );
        assert_eq!(
            validated_change(&request("operator_env", None)).unwrap(),
            PinChange::OperatorEnv
        );
        assert_eq!(
            validated_change(&request("team_link", Some(0))).unwrap(),
            PinChange::TeamLink { position: 0 }
        );
        for (kind, position) in [
            ("team_link", None),
            ("team_link", Some(-1)),
            ("operator_env", Some(0)),
            ("default", Some(1)),
            ("subscription", None),
            ("personal", Some(0)),
            ("TEAM_LINK", Some(0)),
            ("", None),
        ] {
            let error = validated_change(&request(kind, position)).expect_err(kind);
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{kind} {position:?}");
        }
    }

    #[test]
    fn the_body_is_closed_so_no_url_key_or_path_rides_along() {
        for body in [
            json!({"kind": "operator_env", "baseUrl": "https://evil.example/v1"}),
            json!({"kind": "operator_env", "bearer": "sk-live"}),
            json!({"kind": "team_link", "linkPosition": 1, "profileDir": "/Users/me/.claude"}),
            json!({"kind": "team_link", "linkPosition": 1, "apiKey": "sk"}),
        ] {
            assert!(
                serde_json::from_value::<PutAgentProviderPinRequest>(body.clone()).is_err(),
                "{body}"
            );
        }
        let parsed: PutAgentProviderPinRequest =
            serde_json::from_value(json!({"kind": "team_link", "linkPosition": 2})).unwrap();
        assert_eq!(parsed, request("team_link", Some(2)));
    }

    #[test]
    fn position_zero_is_the_stored_link_and_never_the_env_fallback() {
        // No stored link: position 0 has no label, whatever the env says.
        assert_eq!(current_team_label(0, None, &[]), None);
        let stored = StoredProviderLink {
            base_url: "https://team-gw.example/v1".into(),
            bearer_ciphertext: vec![1],
            mode: "external-hermes".into(),
            updated_by_member_id: None,
            updated_at_ms: 1,
        };
        assert_eq!(
            current_team_label(0, Some(&stored), &[]),
            Some(redacted_endpoint_label("https://team-gw.example/v1"))
        );
        assert_eq!(current_team_label(1, Some(&stored), &[]), None);
    }

    #[test]
    fn an_env_pin_resolves_only_while_the_env_link_exists() {
        let pin = StoredAgentPin {
            agent_member_id: Uuid::nil(),
            kind: PinKind::OperatorEnv,
            link_position: None,
            link_endpoint_label: None,
            pinned_by_member_id: None,
            updated_at_ms: 1,
        };
        assert!(pin_dto(&pin, "http://hermes.railway.internal:8642/v1", None, &[]).link_resolved);
        assert!(!pin_dto(&pin, "", None, &[]).link_resolved);
        assert!(!pin_dto(&pin, "  ", None, &[]).link_resolved);
    }
}
