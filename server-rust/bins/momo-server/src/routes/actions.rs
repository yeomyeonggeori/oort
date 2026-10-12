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
//! ## Two stages: shape, then the database
//!
//! [`validated_action_args`] is the **pure** half — it proves the arguments are
//! well-formed and inside the ceilings, and needs no connection. Actions whose
//! arguments name things in the workspace (a channel by name, a member by
//! handle) cannot be judged by shape alone: ADR-0186 증보 V1-a/b/d say the server
//! resolves them *inside a transaction*, at propose time and again at decision
//! time, and builds the card rows from what it found. That second half is
//! [`resolve_action_in_tx`], and it is the only function either caller invokes.
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
use momo_db::PgConnection;
use momo_settings::{normalized_invite_role, validated_expires_at_ms, validated_max_uses};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

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
    /// The same values, typed, for the **executor** (ADR-0186 D2, AX-3b).
    ///
    /// The decision route re-runs this whole function over the stored
    /// `payload.action.args` rather than trusting what was written months — or
    /// one compromised propose call — ago. Handing it a typed variant instead of
    /// making it dig `normalized["maxUses"].as_i64()` back out is what keeps the
    /// executor from re-deriving, and re-deciding, anything: the parse happened
    /// here, once, and its result is the only thing the executor can act on.
    pub args: ActionArgs,
}

/// One action's arguments, after the domain has agreed to them.
///
/// An enum rather than three fields on [`ValidatedActionArgs`] because the next
/// action's arguments are not an invite's; a struct with `role`/`max_uses` would
/// make every future executor read fields that mean nothing to it, and the
/// compiler would not notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionArgs {
    InviteCreate {
        /// `momo_settings::normalized_invite_role`'s canonical spelling.
        role: &'static str,
        max_uses: i32,
        /// `None` means "the statement's own 7-day default"
        /// (`momo_agent::DEFAULT_INVITE_EXPIRES_IN_DAYS`), which is what the
        /// card's 만료 row already showed.
        expires_in_days: Option<i64>,
    },
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
        args: ActionArgs::InviteCreate {
            role,
            max_uses,
            expires_in_days,
        },
    })
}

/// What the role gate of a [`actions::RequiredRole`] is judged against.
///
/// Most roles are about the workspace as a whole and need no subject. The
/// agent-scoped one (`AgentEditor`) is about **one agent**, which is only known
/// after the arguments are resolved — so the subject travels with the resolved
/// action, and the decision route judges the role against it rather than against
/// anything the card or the proposer asserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateSubject {
    Workspace,
    /// The target agent's `member.id` (ADR-0186 증보 V4-M: the target, never the
    /// proposer).
    Agent(Uuid),
}

/// A proposal after the database has agreed to it (ADR-0186 증보 V1-a/d).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAction {
    /// `normalized` is stored in the payload, `rows` is drawn on the card and
    /// `args` is what the executor acts on — all three built from the values the
    /// resolution found, not from the strings the agent typed.
    pub validated: ValidatedActionArgs,
    pub subject: GateSubject,
}

/// Shape-validate `args`, then resolve whatever they name against the workspace,
/// inside the caller's tenant transaction.
///
/// `proposer_member_id` is the agent that raised the proposal: it is whose view
/// "visible channel" is measured from, and the actor a resolution rule such as
/// "same owner" starts from. The outer `Result` is the database; the inner one
/// is the verdict, and every inner `Err` is a 400 that
/// `agent_port_tools::failure_of` turns into the one `InvalidArguments` — a
/// resolution failure never says *which* name did not resolve.
///
/// Called with the stored payload at decision time too, so a card is re-proved
/// against the workspace as it is now (D2: 「저장값을 신뢰하지 않는다」).
pub async fn resolve_action_in_tx(
    _conn: &mut PgConnection,
    _workspace_id: Uuid,
    _proposer_member_id: Uuid,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> DbRejectable<ResolvedAction> {
    let validated = match validated_action_args(action, args, now_ms) {
        Ok(validated) => validated,
        Err(error) => return Ok(Err(error)),
    };
    // Exhaustive on purpose: a new `ActionArgs` variant must say here whether it
    // resolves anything and whom its role gate is about.
    let subject = match &validated.args {
        ActionArgs::InviteCreate { .. } => GateSubject::Workspace,
    };
    Ok(Ok(ResolvedAction { validated, subject }))
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

    /// **ADR-0186 증보 — the approver roles are one list in two places.**
    ///
    /// `RequiredRole` is the definition (the decision route's `match` is
    /// exhaustive over it); `WorkspaceActionRequiredRole` is what `GET …/actions`
    /// publishes and what a client branches its 「…가 승인해야 합니다」 copy on.
    /// A role added to the enum alone would be a card that names a role the
    /// published contract never mentioned.
    #[test]
    fn the_required_roles_are_one_list_in_two_places() {
        let registry: Vec<String> = actions::RequiredRole::ALL
            .iter()
            .map(|role| role.as_wire().to_string())
            .collect();
        assert_eq!(
            openapi_enum("WorkspaceActionRequiredRole"),
            registry,
            "openapi WorkspaceActionRequiredRole vs RequiredRole"
        );
    }

    /// **ADR-0186 증보 G2 — the suggestable ids are one list in four places.**
    ///
    /// `momo_agent::card_suggest::SUGGESTABLE_COMMANDS` is the definition. The
    /// hosted tool's `commandId` enum is the protocol crate's copy; the worker's
    /// `card_suggest` definition is built from the registry but read back here
    /// as its own list, so a hand edit to it cannot pass; `SuggestableCommandId`
    /// is the published one, and the TS registry's `agentSuggestable: true` set
    /// is measured against that same spec enum by
    /// `clients/web/src/app/commandRegistry.test.ts` (OpenAPI is where Rust and
    /// TS meet). Adding a command to one list only is a red test.
    #[test]
    fn the_suggestable_ids_are_one_list_in_four_places() {
        let registry = momo_agent::suggestable_command_ids();
        let enum_of = |schema: &Value, context: &str| -> Vec<String> {
            schema["properties"]["commandId"]["enum"]
                .as_array()
                .unwrap_or_else(|| panic!("{context} publishes a commandId enum"))
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .expect("an enum member is a string")
                        .to_string()
                })
                .collect()
        };

        let hosted = momo_mcp::TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == momo_mcp::TOOL_CARD_SUGGEST)
            .expect("oort_card_suggest is in the catalog");
        assert_eq!(
            enum_of(&hosted.input_schema(), "oort_card_suggest"),
            registry,
            "oort_card_suggest enum vs SUGGESTABLE_COMMANDS"
        );

        let worker = momo_agent::tools::catalog_definitions()
            .into_iter()
            .find(|definition| definition.name == momo_agent::tools::CARD_SUGGEST)
            .expect("card_suggest is in the worker catalog");
        assert_eq!(
            enum_of(&worker.parameters, "card_suggest"),
            registry,
            "worker card_suggest enum vs SUGGESTABLE_COMMANDS"
        );

        assert_eq!(
            openapi_enum("SuggestableCommandId"),
            registry,
            "openapi SuggestableCommandId vs SUGGESTABLE_COMMANDS"
        );
        // G5's line, as data: a suggestable command is never a workspace action.
        for id in &registry {
            assert!(actions::action_by_id(id).is_none(), "{id} is a D2 action");
        }
    }

    /// The hosted tool bounds `args` exactly as the registry's schema does — the
    /// protocol crate's copy of the `ai.connect` vocabulary (`grok`-free) is
    /// measured key by key, so a harness added on one side only fails here.
    #[test]
    fn the_card_suggest_tool_bounds_what_the_registry_normalises() {
        let hosted = momo_mcp::TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == momo_mcp::TOOL_CARD_SUGGEST)
            .expect("oort_card_suggest is in the catalog");
        let published = hosted.input_schema();
        let tool_args = &published["properties"]["args"];
        assert_eq!(tool_args["type"], json!(["object", "null"]));
        assert_eq!(tool_args["additionalProperties"], json!(false));
        assert_eq!(
            momo_agent::SUGGESTABLE_COMMANDS.len(),
            1,
            "v1 is one command; widen this test with the second"
        );
        let registry_args = momo_agent::SUGGESTABLE_COMMANDS[0].args_schema();
        let tool_properties = tool_args["properties"].as_object().expect("tool args");
        let registry_properties = registry_args["properties"]
            .as_object()
            .expect("registry args");
        assert_eq!(
            tool_properties.keys().collect::<Vec<_>>(),
            registry_properties.keys().collect::<Vec<_>>()
        );
        for (name, registry_property) in registry_properties {
            assert_eq!(
                tool_properties[name].get("enum"),
                registry_property.get("enum"),
                "args.{name}.enum disagrees between oort_card_suggest and SUGGESTABLE_COMMANDS"
            );
        }
        assert!(!published.to_string().contains("grok"));
    }

    /// **The propose tool must accept exactly what the catalog advertises —
    /// action by action.**
    ///
    /// `momo-mcp` cannot depend on `momo-agent`
    /// (`the_protocol_crate_cannot_reach_transport_database_or_product_crates`
    /// enforces it), so the tool's `args` bounds are a copy of the registry's:
    /// one closed `oneOf` branch per action, titled with the action id. This
    /// compares **every registry action against its own branch**, key by key —
    /// the property names, which of them are required, each bound, and the
    /// array shape — so a property added, removed or renamed on one side only is
    /// caught, as is an action with no branch or a branch with no action.
    ///
    /// Drift here is fail-closed (the narrower of the two wins) but it is still
    /// a lie: `GET …/actions` would advertise a value the tool then refuses,
    /// and the client has no way to discover which.
    #[test]
    fn the_propose_tool_accepts_exactly_what_the_catalog_advertises() {
        let propose = momo_mcp::TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == momo_mcp::TOOL_ACTION_PROPOSE)
            .expect("the propose tool is in the catalog");
        let published = propose.input_schema();
        let tool_args = &published["properties"]["args"];
        assert_eq!(tool_args["type"], json!("object"));
        let branches = tool_args["oneOf"]
            .as_array()
            .expect("args is a oneOf of per-action branches");

        let titles: Vec<&str> = branches
            .iter()
            .map(|branch| branch["title"].as_str().expect("a branch is titled"))
            .collect();
        assert_eq!(
            titles,
            actions::action_ids(),
            "one branch per registry action, in registry order"
        );

        for action in actions::ACTIONS {
            let branch = branches
                .iter()
                .find(|branch| branch["title"] == json!(action.id))
                .unwrap_or_else(|| panic!("{} has no args branch in the tool", action.id));
            let registry_args = action.args_schema();
            assert_eq!(branch["type"], json!("object"), "{}", action.id);
            assert_eq!(
                branch["additionalProperties"],
                json!(false),
                "{}",
                action.id
            );

            let tool_properties = branch["properties"].as_object().expect("branch properties");
            let registry_properties = registry_args["properties"]
                .as_object()
                .expect("registry args properties");
            assert_eq!(
                tool_properties
                    .keys()
                    .collect::<std::collections::BTreeSet<_>>(),
                registry_properties
                    .keys()
                    .collect::<std::collections::BTreeSet<_>>(),
                "{}: the tool and the catalog must bound the same argument names",
                action.id
            );
            let required_of = |schema: &Value| -> std::collections::BTreeSet<String> {
                schema
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|names| {
                        names
                            .iter()
                            .map(|name| name.as_str().expect("a name").to_string())
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let required = required_of(&registry_args);
            assert_eq!(
                required_of(branch),
                required,
                "{}: required keys differ between the tool and the catalog",
                action.id
            );

            for (name, registry_property) in registry_properties {
                let tool_property = &tool_properties[name];
                for key in [
                    "enum",
                    "minimum",
                    "maximum",
                    "minLength",
                    "maxLength",
                    "minItems",
                    "maxItems",
                    "items",
                ] {
                    assert_eq!(
                        tool_property.get(key),
                        registry_property.get(key),
                        "{}: args.{name}.{key} disagrees between oort_action_propose and GET /actions",
                        action.id
                    );
                }
                // The tool wraps every OPTIONAL property in the nullability
                // contract (`["integer","null"]`) and leaves a required one
                // bare; the catalog publishes the bare type for both.
                let declared = registry_property["type"].as_str().expect("a declared type");
                let expected = if required.contains(name) {
                    json!(declared)
                } else {
                    json!([declared, "null"])
                };
                assert_eq!(
                    tool_property["type"], expected,
                    "{}: args.{name} must keep the catalog's type under the nullability contract",
                    action.id
                );
            }
        }
    }

    /// **ADR-0186 D2 — the hosted scope vocabulary, in all four places.**
    ///
    /// A scope is only real when the human can approve it, the credential can
    /// carry it, the DB admits it, the spec publishes it and the tool requires
    /// it. Four of those five copies are measured here: `momo_auth`, the spec,
    /// migration 087's three CHECK constraints, and the tool catalog.
    ///
    /// The fifth is `momo-core`'s `HOSTED_AGENT_SCOPES`, which this test cannot
    /// reach. Its own suite (`hostedAgents/approval.test.ts`) pins the list
    /// against **literals**, not against the spec — `node:fs` and `import.meta`
    /// are banned in that package, so a vitest cannot read `openapi.yaml`. That
    /// catches a count change and a renamed last entry; a rename or a reorder in
    /// the middle would pass on the TS side and is caught only by review.
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

        // **The DB copies.** Migration 087 rewrote three CHECK constraints that
        // each enumerate this vocabulary, and nothing else in the build reads
        // them. Without this, an eighth scope added to Rust, the spec and TS but
        // not to the SQL leaves every gate green and produces the one failure
        // 087's own header calls 「진단 불가능한 증상」: the human approves it, and
        // the credential cannot carry it.
        //
        // Read as a **set** because the three constraints do not agree on order
        // or line-wrapping, and order is not what they enforce.
        let expected: std::collections::BTreeSet<&str> =
            momo_auth::HOSTED_AGENT_SCOPES.iter().copied().collect();
        let constraints = migration_087_scope_arrays();
        assert_eq!(
            constraints.len(),
            3,
            "087 must rewrite exactly three scope CHECK constraints, found {}",
            constraints.len()
        );
        for (constraint, values) in &constraints {
            let found: std::collections::BTreeSet<&str> =
                values.iter().map(String::as_str).collect();
            assert_eq!(
                found, expected,
                "{constraint} in 087 does not enumerate the same scope set as \
                 momo_auth::HOSTED_AGENT_SCOPES"
            );
        }
    }

    /// The scope arrays of migration 087, as `(constraint name, values)`.
    ///
    /// A text scan for the same reason `openapi_enum` is one: the workspace
    /// carries no SQL parser and would not gain one for three literals. What it
    /// depends on is pinned by the caller — exactly three constraints, each
    /// naming a scope-shaped set — so a rewrite that moved these somewhere this
    /// scan cannot see fails loudly instead of quietly measuring nothing.
    fn migration_087_scope_arrays() -> Vec<(String, Vec<String>)> {
        let sql = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../server/Migrations/087_hosted_scope_workspace_propose.sql"
        ))
        .expect("migration 087 is readable from the server crate");
        let mut found = Vec::new();
        let mut current: Option<String> = None;
        let mut buffer = String::new();
        let mut collecting = false;
        for line in sql.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("--") {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("ADD CONSTRAINT ") {
                current = rest.split_whitespace().next().map(str::to_string);
            }
            if trimmed.contains("ARRAY[") {
                collecting = true;
                buffer.clear();
            }
            if collecting {
                buffer.push_str(trimmed);
                if buffer.contains("]::text[]") {
                    collecting = false;
                    let inner = buffer
                        .split_once("ARRAY[")
                        .expect("the buffer began at ARRAY[")
                        .1
                        .split_once("]::text[]")
                        .expect("the buffer ended at ]::text[]")
                        .0;
                    let values: Vec<String> = inner
                        .split(',')
                        .map(|item| item.trim().trim_matches('\'').to_string())
                        .filter(|item| !item.is_empty())
                        .collect();
                    // Only the scope arrays: 087 touches no other ARRAY literal
                    // today, and a future one that is not a scope set would show
                    // up as a set mismatch rather than be silently folded in.
                    if values.iter().any(|value| value.contains(':')) {
                        found.push((
                            current.clone().unwrap_or_else(|| "<unnamed>".to_string()),
                            values,
                        ));
                    }
                }
            }
        }
        found
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
    ///
    /// The verdict is **"not the unknown-action arm"**, not "empty args are
    /// accepted". An action with a required argument is a perfectly good action
    /// and must be able to refuse `{}` — measuring acceptance would turn the
    /// first such action into a red test for no reason, which is how a guard
    /// stops being trusted.
    #[test]
    fn every_action_has_a_normaliser() {
        for action in actions::ACTIONS {
            if let Err(error) = validated_action_args(action, &json!({}), NOW_MS) {
                assert_ne!(
                    error.message, "unknown workspace action",
                    "{} has no argument normaliser in validated_action_args",
                    action.id
                );
            }
        }
        // The fallback arm cannot be reached from here on purpose:
        // `WorkspaceAction`'s fields are private to `momo-agent`, so the only
        // values that exist are the registry's own. That is a stronger property
        // than the arm being tested — it means an unnormalised action cannot be
        // constructed at all — and the arm stays as the answer for the day a
        // registry entry is added without a match arm, which is exactly what the
        // loop above measures.
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
