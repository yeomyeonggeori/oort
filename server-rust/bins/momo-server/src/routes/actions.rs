//! `GET /v1/workspaces/{ws}/actions` — the workspace action catalog
//! (ADR-0186 D1, 부록 E) and the **one place** a proposal's arguments are
//! normalised.
//!
//! ```text
//! GET /v1/workspaces/{ws}/actions    human bearer, any active membership
//! ```
//!
//! The rows are derived from `momo_agent::actions::ACTIONS`; nothing here holds
//! a second list. `executable: false` rows come from `DECLARED_NOT_EXECUTABLE`
//! and always carry an `unavailableReason`, which is the same contract the tool
//! catalog (#2016) keeps: an absence always says why.
//!
//! ## Why the argument normaliser lives here and not in the registry
//!
//! `momo-agent` deliberately does not depend on `momo-settings`, and the invite
//! spec's validators are the settings crate's
//! (`normalized_invite_role`/`validated_max_uses`/`validated_expires_at_ms` —
//! the very functions `routes::invites::create` calls). Writing a second set
//! inside the registry would be a second answer to "is this a legal invite", and
//! two answers drift. So the registry publishes the **schema** and this module
//! re-proves it with the domain's own validators, exactly once, for both callers
//! that need it: the Agent Port's `oort_action_propose` today, and AX-3b's
//! executor at decision time.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_agent::actions::{
    self, WorkspaceAction, INVITE_EXPIRES_IN_DAYS_CEILING, INVITE_MAX_USES_CEILING,
    INVITE_PROPOSABLE_ROLES,
};
use momo_auth::{active_workspace_role, Principal};
use momo_settings::{normalized_invite_role, validated_expires_at_ms, validated_max_uses};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// One catalog row (ADR-0186 부록 E).
///
/// `requiredRole` and `argsSchema` are absent for a declared-but-not-executable
/// row: the batch that opens it decides its gate and its arguments, and
/// publishing a guess now would be a contract nobody promised to keep.
#[derive(Debug, Serialize)]
pub struct WorkspaceActionDto {
    pub id: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub risk: &'static str,
    #[serde(rename = "requiredRole", skip_serializing_if = "Option::is_none")]
    pub required_role: Option<&'static str>,
    #[serde(rename = "argsSchema", skip_serializing_if = "Option::is_none")]
    pub args_schema: Option<Value>,
    pub executable: bool,
    /// `null` when executable, a sentence when not. Never absent — a client
    /// reading `executable: false` must always find the reason in the same key.
    #[serde(rename = "unavailableReason")]
    pub unavailable_reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct ListWorkspaceActionsResponse {
    pub actions: Vec<WorkspaceActionDto>,
}

/// The catalog as every consumer sees it: executable rows first, in registry
/// order, then the declared ones in their own order.
pub fn catalog() -> Vec<WorkspaceActionDto> {
    let mut rows: Vec<WorkspaceActionDto> = actions::ACTIONS
        .iter()
        .map(|action| WorkspaceActionDto {
            id: action.id,
            title: action.title,
            summary: action.summary,
            risk: action.risk.as_wire(),
            required_role: Some(action.required_role.as_wire()),
            args_schema: Some(action.args_schema()),
            executable: true,
            unavailable_reason: None,
        })
        .collect();
    rows.extend(actions::DECLARED_NOT_EXECUTABLE.iter().map(|declared| {
        WorkspaceActionDto {
            id: declared.id,
            title: declared.title,
            summary: declared.summary,
            // Everything in *this* catalog changes the workspace; `risk: none`
            // belongs to the client command registry (ADR-0186 D3/D6), which is
            // a different list served by a different consumer.
            risk: actions::Risk::Approval.as_wire(),
            required_role: None,
            args_schema: None,
            executable: false,
            unavailable_reason: Some(declared.unavailable_reason),
        }
    }));
    rows
}

/// The catalog is workspace knowledge, not admin knowledge: any active member
/// may read what can be asked for, and `required_role` tells them who would have
/// to approve it. The agent bearer path is closed at the middleware — this route
/// is absent from `momo_auth::agent_scope`'s table (see
/// `the_propose_scope_names_no_route_at_all`).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<ListWorkspaceActionsResponse>, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let role = active_workspace_role(conn, workspace_id, member_id).await?;
            Ok(match role {
                Some(_) => Ok(()),
                None => Err(ApiError::forbidden("not a workspace member")),
            })
        })
    })
    .await;
    settle_db("actions.list", outcome)?;

    Ok(Json(ListWorkspaceActionsResponse { actions: catalog() }))
}

// ---------------------------------------------------------------------------
// argument normalisation — the registry's schema, proved by the domain
// ---------------------------------------------------------------------------

/// A proposal's arguments after the domain has agreed to them.
///
/// `normalized` is what goes into `approval.payload.action.args` and `rows` is
/// what goes onto the card. They are built together, from the same values, for
/// one reason: the person approving must be looking at the numbers the executor
/// will use, not at what the agent typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedActionArgs {
    pub normalized: Value,
    pub rows: Vec<Value>,
}

/// Normalise `args` for `action`, refusing anything the registry's published
/// schema or the domain's own validators refuse.
///
/// The `ApiError` statuses are the ones `agent_port_tools::failure_of` already
/// maps: a bad argument is a 400 and becomes `ToolFailure::InvalidArguments`,
/// so the hosted caller learns *that* its arguments were wrong and never
/// *which* rule it broke.
pub fn validated_action_args(
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> Result<ValidatedActionArgs, ApiError> {
    match action.id {
        actions::ACTION_INVITE_CREATE => invite_create_args(args, now_ms),
        // Fail closed. A registry entry with no normaliser must be an error and
        // not an unvalidated passthrough — `every_action_has_a_normaliser` is
        // what makes this arm unreachable rather than merely unlikely.
        _ => Err(ApiError::bad_request("unknown workspace action")),
    }
}

fn invite_create_args(args: &Value, now_ms: i64) -> Result<ValidatedActionArgs, ApiError> {
    let object = args
        .as_object()
        .ok_or_else(|| ApiError::bad_request("action args must be an object"))?;
    for key in object.keys() {
        if !["role", "maxUses", "expiresInDays"].contains(&key.as_str()) {
            return Err(ApiError::bad_request("unknown action argument"));
        }
    }

    // `role` — the registry's narrowing first, then the domain's canonical
    // spelling. Doing it in this order is what keeps `guest` out: the domain
    // validator would happily accept it.
    let role = match object.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            if !INVITE_PROPOSABLE_ROLES.contains(&raw.as_str()) {
                return Err(ApiError::bad_request("role is not proposable"));
            }
            Some(raw.clone())
        }
        Some(_) => return Err(ApiError::bad_request("role must be a string")),
    };
    let role = normalized_invite_role(role.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    let max_uses = match bounded_integer(object, "maxUses", 1, INVITE_MAX_USES_CEILING)? {
        Some(value) => Some(
            i32::try_from(value).map_err(|_| ApiError::bad_request("maxUses is out of range"))?,
        ),
        None => None,
    };
    let max_uses =
        validated_max_uses(max_uses).map_err(|error| ApiError::bad_request(error.to_string()))?;

    // `expiresInDays` is stored **relative**, because the executor runs at
    // decision time and not now: an absolute instant computed here would start
    // expiring while the card waits for someone to read it.
    let expires_in_days =
        bounded_integer(object, "expiresInDays", 1, INVITE_EXPIRES_IN_DAYS_CEILING)?;
    // Prove the relative value resolves to a legal absolute one with the very
    // validator `routes::invites::create` uses, so a proposal cannot carry an
    // expiry the invite route would refuse.
    let expires_at_ms = expires_in_days.map(|days| now_ms + days * 86_400_000);
    validated_expires_at_ms(expires_at_ms, now_ms)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    Ok(ValidatedActionArgs {
        normalized: json!({
            "role": role,
            "maxUses": max_uses,
            "expiresInDays": expires_in_days,
        }),
        rows: actions::invite_create_rows(role, max_uses, expires_in_days),
    })
}

/// One optional integer argument, inside the ceilings the registry publishes.
///
/// `as_i64` also refuses a fractional or float-shaped number, which `integer`
/// forbids and a lenient reader would have truncated.
fn bounded_integer(
    object: &serde_json::Map<String, Value>,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> Result<Option<i64>, ApiError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let value = number
                .as_i64()
                .filter(|_| number.is_i64())
                .ok_or_else(|| ApiError::bad_request("argument must be an integer"))?;
            if !(minimum..=maximum).contains(&value) {
                return Err(ApiError::bad_request("argument is out of range"));
            }
            Ok(Some(value))
        }
        Some(_) => Err(ApiError::bad_request("argument must be an integer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    const NOW_MS: i64 = 1_700_000_000_000;

    fn invite() -> &'static WorkspaceAction {
        actions::action_by_id(actions::ACTION_INVITE_CREATE).expect("v1 registry")
    }

    /// **ADR-0186 D1 — one list in three places.**
    ///
    /// `ACTIONS` is the definition; the Agent Port tool's `actionId` enum is a
    /// protocol-layer copy (`momo-mcp` may not depend on `momo-agent`); the
    /// OpenAPI `WorkspaceActionId` is the published one. Adding an action means
    /// editing three lines, and this is the test that fails when only two of
    /// them were edited.
    #[test]
    fn the_action_ids_are_one_list_in_three_places() {
        let registry = actions::action_ids();

        let propose = momo_mcp::TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == momo_mcp::TOOL_ACTION_PROPOSE)
            .expect("the propose tool is in the catalog");
        let schema_enum: Vec<String> = propose.input_schema()["properties"]["actionId"]["enum"]
            .as_array()
            .expect("the propose schema publishes an actionId enum")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("an enum member is a string")
                    .to_string()
            })
            .collect();
        assert_eq!(schema_enum, registry, "oort_action_propose enum vs ACTIONS");

        let spec_enum = openapi_enum("WorkspaceActionId");
        assert_eq!(spec_enum, registry, "openapi WorkspaceActionId vs ACTIONS");
    }

    /// **ADR-0186 D2 — the hosted scope vocabulary, in all four places.**
    ///
    /// A scope is only real when the human can approve it, the credential can
    /// carry it, the spec publishes it and the tool requires it. `momo-core`'s
    /// `HOSTED_AGENT_SCOPES` is the fifth copy and cannot be read from Rust, so
    /// it is pinned against this same published enum from its own suite
    /// (`hostedAgents/approval.test.ts`) — the spec is the shared fixed point.
    ///
    /// The DB is the sixth: three CHECK constraints enumerate this vocabulary
    /// (migration 087), which is why AX-3a needed a migration at all.
    #[test]
    fn the_hosted_scope_vocabulary_is_one_list_everywhere() {
        assert_eq!(
            openapi_enum("HostedAgentScope"),
            momo_auth::HOSTED_AGENT_SCOPES.to_vec(),
            "openapi HostedAgentScope vs momo_auth::HOSTED_AGENT_SCOPES"
        );
        assert!(
            momo_auth::HOSTED_AGENT_SCOPES.contains(&momo_auth::SCOPE_WORKSPACE_PROPOSE),
            "a scope a human cannot approve opens nothing"
        );
        // Every tool's required scope is approvable; the reverse is not required
        // (`agent:port:connect` is reachability and opens no tool at all).
        for tool in momo_mcp::TOOL_CATALOG.iter() {
            assert!(
                momo_auth::HOSTED_AGENT_SCOPES.contains(&tool.required_scope),
                "{} requires {}, which no human can approve",
                tool.name,
                tool.required_scope
            );
        }
    }

    /// One published enum, read out of the spec file itself.
    ///
    /// A text scan rather than a YAML parse because the workspace carries no
    /// YAML dependency and adding one for two lines would land in NOTICE. The
    /// shape it depends on is pinned by the assertions: the schema is named, its
    /// `enum` is one line inside its own block, and a change to either shows up
    /// here as a failure rather than as a silently skipped check.
    fn openapi_enum(schema: &str) -> Vec<String> {
        let spec = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/openapi.yaml"
        ))
        .expect("docs/api/openapi.yaml is readable from the server crate");
        let header = format!("    {schema}:");
        let mut lines = spec.lines().skip_while(|line| line.trim_end() != header);
        assert!(
            lines.next().is_some(),
            "openapi.yaml must declare a {schema} schema"
        );
        let enum_line = lines
            // Stop at the next schema key (four spaces, then a name) so an
            // `enum:` belonging to a *different* schema can never be read as
            // this one's — the scan fails loudly instead of silently passing.
            .take_while(|line| line.trim().is_empty() || line.starts_with("      "))
            .find(|line| line.trim_start().starts_with("enum:"))
            .unwrap_or_else(|| panic!("{schema} declares its enum inside its own block"));
        let inside = enum_line
            .trim()
            .trim_start_matches("enum:")
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let values: Vec<String> = inside
            .split(',')
            .map(|item| item.trim().trim_matches('"').to_string())
            .filter(|item| !item.is_empty())
            .collect();
        assert!(!values.is_empty(), "{schema}'s enum must not read as empty");
        values
    }

    /// Fail-closed by construction: a registry entry whose arguments nothing
    /// normalises would otherwise reach the domain unvalidated.
    #[test]
    fn every_action_has_a_normaliser() {
        for action in actions::ACTIONS {
            let refused = validated_action_args(action, &json!({}), NOW_MS);
            assert!(
                refused.is_ok(),
                "{} has no argument normaliser in validated_action_args",
                action.id
            );
        }
    }

    #[test]
    fn the_defaults_are_the_invite_routes_own_defaults() {
        let validated = validated_action_args(invite(), &json!({}), NOW_MS).expect("defaults");
        assert_eq!(
            validated.normalized,
            json!({"role": "member", "maxUses": 1, "expiresInDays": Value::Null})
        );
        assert_eq!(validated.rows[2], json!({"label": "만료", "value": "7일"}));
    }

    #[test]
    fn the_normalised_args_are_what_the_card_shows() {
        let validated = validated_action_args(
            invite(),
            &json!({"role": "admin", "maxUses": 5, "expiresInDays": 14}),
            NOW_MS,
        )
        .expect("a legal proposal");
        assert_eq!(
            validated.normalized,
            json!({"role": "admin", "maxUses": 5, "expiresInDays": 14})
        );
        assert_eq!(
            validated.rows,
            vec![
                json!({"label": "역할", "value": "admin"}),
                json!({"label": "사용 횟수", "value": "5회"}),
                json!({"label": "만료", "value": "14일"}),
            ]
        );
    }

    /// The narrowing is enforced here too, not only in the published schema: a
    /// decision-time re-read (AX-3b) goes through this same function and must
    /// not be able to widen what the card was drawn from.
    #[test]
    fn the_registry_ceilings_are_enforced_by_the_domain_as_well() {
        for refused in [
            json!({"role": "guest"}),
            json!({"role": "owner"}),
            json!({"role": 7}),
            json!({"maxUses": 0}),
            json!({"maxUses": 101}),
            json!({"maxUses": 1.5}),
            json!({"maxUses": "3"}),
            json!({"expiresInDays": 0}),
            json!({"expiresInDays": 31}),
            json!({"maxUse": 1}),
            json!([]),
        ] {
            let error = validated_action_args(invite(), &refused, NOW_MS)
                .expect_err(&format!("{refused} must be refused"));
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{refused}");
        }
        // **The narrowing is real, not decorative**: each of these is a value the
        // invite REST surface's own validator accepts and the proposal refuses.
        // Without this the "narrower than REST" claim would be a comment.
        assert_eq!(normalized_invite_role(Some("guest")), Ok("guest"));
        assert_eq!(validated_max_uses(Some(10_000)), Ok(10_000));
        assert!(validated_expires_at_ms(Some(NOW_MS + 365 * 86_400_000), NOW_MS).is_ok());
        for wider in [
            json!({"role": "guest"}),
            json!({"maxUses": 10_000}),
            json!({"expiresInDays": 365}),
        ] {
            assert!(
                validated_action_args(invite(), &wider, NOW_MS).is_err(),
                "{wider} is legal over REST and must still be refused as a proposal"
            );
        }

        // The boundaries themselves are legal.
        for allowed in [
            json!({"maxUses": 1}),
            json!({"maxUses": 100}),
            json!({"expiresInDays": 1}),
            json!({"expiresInDays": 30}),
            json!({"role": "member", "maxUses": 100, "expiresInDays": 30}),
        ] {
            assert!(
                validated_action_args(invite(), &allowed, NOW_MS).is_ok(),
                "{allowed}"
            );
        }
    }

    /// 부록 E, row by row. The `unavailableReason` key is what a client reads
    /// when `executable` is false, and it is never blank.
    #[test]
    fn the_catalog_publishes_appendix_e() {
        let rows = catalog();
        let executable: Vec<&WorkspaceActionDto> =
            rows.iter().filter(|row| row.executable).collect();
        assert_eq!(
            executable.iter().map(|row| row.id).collect::<Vec<_>>(),
            actions::action_ids()
        );
        let invite = executable[0];
        assert_eq!(invite.risk, "approval");
        assert_eq!(invite.required_role, Some("admin"));
        assert_eq!(invite.unavailable_reason, None);
        assert_eq!(
            invite.args_schema.as_ref().expect("schema")["properties"]["role"]["enum"],
            json!(["member", "admin"])
        );

        for row in rows.iter().filter(|row| !row.executable) {
            assert!(
                row.unavailable_reason
                    .is_some_and(|reason| !reason.trim().is_empty()),
                "{} is unavailable without saying why",
                row.id
            );
            assert_eq!(row.required_role, None, "{}", row.id);
            assert!(row.args_schema.is_none(), "{}", row.id);
        }

        // The serialised shape: `unavailableReason` is present-and-null on an
        // executable row, so a client reads one key in both cases.
        let rendered = serde_json::to_value(ListWorkspaceActionsResponse { actions: catalog() })
            .expect("the catalog serialises");
        assert_eq!(rendered["actions"][0]["unavailableReason"], Value::Null);
        assert!(rendered["actions"][0]
            .as_object()
            .expect("row")
            .contains_key("unavailableReason"));
        assert!(!rendered["actions"][1]
            .as_object()
            .expect("row")
            .contains_key("argsSchema"));
        // No executor, no secret, no credential ever rides in the catalog.
        let text = rendered.to_string();
        for absent in ["code", "secret", "token", "credential"] {
            assert!(
                !text.contains(absent),
                "{absent} must not appear in the catalog"
            );
        }
    }
}
