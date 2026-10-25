//! 「내 앱 실행 장소」 투영 — which of **my** agents can run my apps, and whether a
//! message to it would be delivered right now (ADR-0113 증보 3 F8, #4313).
//!
//! ```text
//! GET /v1/workspaces/{ws}/members/me/app-runtimes        (require_human)
//!   → { "runtimes": [ { "agentId": "<uuid>",
//!                       "path": "hermes_trial" | "hosted_vendor",
//!                       "apps": ["<pluginId>", …],
//!                       "enforced": true | false,
//!                       "blocked": null | "hosted_off" | "connection" | "attest" | "members" | "apps" | "paused" } ] }
//! ```
//!
//! The answer is an **object** like every other read of this API (a bare array cannot grow a
//! field later, and the core `request()` funnel refuses anything that is not an object). The key
//! is `runtimes`, not `apps`, because each entry already carries its own `apps`.
//!
//! The composer's 「앱」 chip (#4315) needs two facts before it may send to an agent: that
//! agent is a *place where my apps run* (ADR-0113 증보 2 E1/E3), and a message to it would
//! not be thrown away at the door. This is the one read that says both, so the client never
//! has to guess from the roster (which deliberately does not carry `connector_owner`).
//!
//! ## Who sees what — and who never does
//!
//! * **Only the caller's own agents.** The predicate is the caller's id against
//!   `agent.connector_owner_human_id`: another member's agent, and the apps granted to
//!   anyone else, are never in the answer — not blocked, not filtered later, **absent**
//!   ([`project`] applies the predicate first). A stopped trial stays in the list with its
//!   `blocked` reason (that is what makes dropping the predicate visible in a test).
//! * **`apps` is always a subset of the caller's own active grants.** For the co-hosted
//!   Hermes it is the operator's switched-on list (`OORT_COHOSTED_AGENT_CONNECTOR_APPS`)
//!   *intersected with* the caller's grants, so the operator's whole configuration is never
//!   exposed; for a hosted vendor agent it is the caller's grants themselves. Plugin ids
//!   are the public catalogue's, not secrets.
//! * **Human only, twice.** The path is absent from `momo_auth::required_agent_scope`, so
//!   the middleware answers an agent bearer 403 before routing; `require_human` below is the
//!   second layer (and refuses the signed work host the table has no opinion about). Each
//!   layer has its own test (`tests/app_runtimes_gates.rs`).
//! * **Not on the roster.** Putting this on the agent DTO would let every member see whose
//!   agent has which personal app attached.
//!
//! ## `blocked` — 「지금 배달되나」, not 「할 수 있나」
//!
//! [`blocked`] is a pure function over the facts `agent_mentions::delivery_gate` reads, in
//! the order it reads them: for the co-hosted Hermes the trial's own stop
//! (`attest` → `members` → `apps`, [`momo_agent::connector_trial_stop`]) and then `paused`;
//! for a hosted vendor agent `hosted_off` → `connection` → `paused`. Only the **first**
//! blocker is reported. The candidate comes from [`momo_agent::load_mention_candidates_in_tx`]
//! — the loader the delivery path itself uses — so the definitions of 「활성 연결」 and
//! 「한 사람」 are not copied. A test in `agent_mentions.rs` drives the real `delivery_gate`
//! over a grid of facts and requires the two to agree, and maps every `DeliveryGate`
//! variant with an exhaustive `match`, so a new gate stage cannot be added without
//! deciding what F8 says about it.
//!
//! What it deliberately does **not** carry is everything that differs per conversation:
//! channel membership (`NotChannelMember` — the client judges it from the roster) and the
//! hosted connection's per-channel approval (`HostedChannelUnapproved` — the existing gate
//! answers after the send, with the 「이 채널에서 쓰기」 card or its plain sentence).
//!
//! Agents that are not app runtimes in v1 are absent: a marked **personal agent** (the
//! owner's Mac harness — the server never starts it from a message), a subscription
//! harness or owner-key agent (`owner_only`, judged by `owner_only_gate`), and a marked
//! agent that is neither the co-hosted Hermes nor a hosted vendor agent.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_agent::{
    connector_trial_stop, ConnectorTrialAttest, ConnectorTrialStop, MentionCandidate,
};
use momo_auth::{active_workspace_role, Principal};
use serde::Serialize;
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::plugins::OFFICIAL_PLUGIN_IDS;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "app runtimes require a human bearer";
const MEMBERSHIP_REQUIRED: &str = "active human membership required";

/// Which face an app runtime has (F8 `path`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePath {
    /// The operator's co-hosted Hermes on a 「커넥터 시험」 (ADR-0203 증보 K2·K4): the
    /// server re-measures the trial at every delivery and the app list is **enforced**.
    HermesTrial,
    /// A hosted vendor agent (Agent Port connection, E1 path): oort records the grant
    /// but cannot enforce it on the vendor's side.
    HostedVendor,
}

/// Why a message to this agent would not be delivered right now (F8 `blocked`) — the
/// first stage of the delivery gate that stops it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    /// The instance's hosted-delivery switch (`MOMO_HOSTED_DELIVERY_ENABLED`) is off.
    HostedOff,
    /// No active, proved hosted connection.
    Connection,
    /// An operator attestation (or the app list) is missing from the server environment.
    Attest,
    /// The workspace does not have exactly one active person.
    Members,
    /// An app the operator switched on in Hermes lost the owner's grant.
    Apps,
    /// `agent_profile.paused`.
    Paused,
}

impl From<ConnectorTrialStop> for Blocked {
    /// Exhaustive on purpose: a new trial stop is a compile error here, not a silent `null`.
    fn from(stop: ConnectorTrialStop) -> Self {
        match stop {
            ConnectorTrialStop::Attest => Blocked::Attest,
            ConnectorTrialStop::Members => Blocked::Members,
            ConnectorTrialStop::Apps => Blocked::Apps,
        }
    }
}

/// One entry of the answer. `blocked` is always present (`null` = deliverable).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppRuntimeDto {
    pub agent_id: String,
    pub path: RuntimePath,
    pub apps: Vec<String>,
    pub enforced: bool,
    pub blocked: Option<Blocked>,
}

/// The whole answer: `{ "runtimes": [ … ] }` (an empty array when the caller has none).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppRuntimesDto {
    pub runtimes: Vec<AppRuntimeDto>,
}

/// The face `candidate` has **for `requester`**, or `None` when it is not one of the
/// requester's app runtimes (v1). The common predicate first — the requester must be the
/// agent's connector owner — so nothing about another member's agent leaves this function.
pub(crate) fn runtime_path(candidate: &MentionCandidate, requester: Uuid) -> Option<RuntimePath> {
    let connector = candidate.connector_owner.as_ref()?;
    if connector.owner_member_id != requester {
        return None;
    }
    // A personal agent (the owner's Mac), a subscription harness and an owner-key agent are all
    // `owner_only`: the server starts none of them from a message the way F8's two paths are.
    if candidate.owner_only.is_some() {
        return None;
    }
    // `trial` is `Some` exactly when the agent is marked AND pinned to the operator's env link.
    // It wins over a hosted connection row: the delivery gate judges the trial first.
    if connector.trial.is_some() {
        return Some(RuntimePath::HermesTrial);
    }
    // Not owner-only, so `hosted_delivery_disabled` is exactly "has a hosted connection row of
    // any status" (`load_mention_candidates_in_tx`).
    if candidate.hosted_delivery_disabled {
        return Some(RuntimePath::HostedVendor);
    }
    None
}

/// The first stage of the delivery gate's **agent-level** chain that would refuse a message
/// from the agent's owner, or `None` when nothing does. Same order as `delivery_gate`
/// (trial stop → hosted switch → active connection → paused), minus the stages that depend on
/// the conversation or on who is calling (see the module docs).
pub(crate) fn blocked(
    path: RuntimePath,
    candidate: &MentionCandidate,
    hosted_delivery_enabled: bool,
    attest: &ConnectorTrialAttest,
) -> Option<Blocked> {
    match path {
        RuntimePath::HermesTrial => {
            let trial = candidate
                .connector_owner
                .as_ref()
                .and_then(|connector| connector.trial.as_ref());
            if let Some(stop) = connector_trial_stop(trial, attest) {
                return Some(stop.into());
            }
        }
        RuntimePath::HostedVendor => {
            if !hosted_delivery_enabled {
                return Some(Blocked::HostedOff);
            }
            if candidate.hosted_active_connection_id.is_none() {
                return Some(Blocked::Connection);
            }
        }
    }
    candidate.paused.then_some(Blocked::Paused)
}

/// The answer for `requester`: their own app runtimes in the loader's order, with `apps`
/// always a subset of `granted` (the requester's own active grants).
pub(crate) fn project(
    candidates: &[MentionCandidate],
    requester: Uuid,
    granted: &[String],
    hosted_delivery_enabled: bool,
    attest: &ConnectorTrialAttest,
) -> Vec<AppRuntimeDto> {
    let granted: Vec<&String> = granted
        .iter()
        .filter(|id| OFFICIAL_PLUGIN_IDS.contains(&id.as_str()))
        .collect();
    candidates
        .iter()
        .filter_map(|candidate| {
            let path = runtime_path(candidate, requester)?;
            let apps: Vec<String> = match path {
                // The operator's switched-on apps ∩ my grants, in the operator's order.
                RuntimePath::HermesTrial => attest
                    .apps
                    .iter()
                    .filter(|app| granted.contains(app))
                    .cloned()
                    .collect(),
                RuntimePath::HostedVendor => granted.iter().map(|app| (*app).clone()).collect(),
            };
            Some(AppRuntimeDto {
                agent_id: candidate.member_id.to_string(),
                path,
                apps,
                enforced: path == RuntimePath::HermesTrial,
                blocked: blocked(path, candidate, hosted_delivery_enabled, attest),
            })
        })
        .collect()
}

/// `GET /v1/workspaces/{ws}/members/me/app-runtimes`.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<AppRuntimesDto>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    // The two instance facts the gate reads, taken from `AppState` exactly as the send does.
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let attest = state.cohosted.config.attest();

    let outcome: DbRejectable<(Vec<MentionCandidate>, Vec<String>)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden(MEMBERSHIP_REQUIRED)));
                }
                // No channel: membership and per-channel approval read as false and are never
                // consulted ([`blocked`] does not carry per-conversation stages).
                let candidates =
                    momo_agent::load_mention_candidates_in_tx(conn, workspace_id, Uuid::nil())
                        .await?;
                // The caller's own active grants: `plugin_grant` ⋈ an enabled, unrevoked install —
                // the join `TRIAL_FACTS_SQL` uses, taken from the same function the trial's enable
                // route uses so the two cannot define 「활성 grant」 differently.
                let granted =
                    momo_agent::trial_candidate_facts_in_tx(conn, workspace_id, member_id)
                        .await?
                        .granted_apps;
                Ok(Ok((candidates, granted)))
            })
        })
        .await;

    let (candidates, granted) = settle_db("app_runtimes.list", outcome)?;
    Ok(Json(AppRuntimesDto {
        runtimes: project(
            &candidates,
            member_id,
            &granted,
            hosted_delivery_enabled,
            &attest,
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_agent::{ConnectorOwner, ConnectorTrialFacts, ModelSource, OwnerOnlyScope};
    use serde_json::json;

    const ME: Uuid = Uuid::from_u128(0xA1);
    const OTHER: Uuid = Uuid::from_u128(0xB2);
    const GMAIL: &str = "com.momo.plugins.gmail";
    const GCAL: &str = "com.momo.plugins.google-calendar";
    const GITHUB: &str = "com.momo.plugins.github";

    fn candidate(id: u128) -> MentionCandidate {
        MentionCandidate {
            member_id: Uuid::from_u128(id),
            handle: format!("agent{id}"),
            display_name: format!("agent{id}"),
            base_model: "hermes-agent".into(),
            base_model_source: ModelSource::Agent,
            model_pref: None,
            effort_pref: None,
            system_prompt: None,
            tool_schema: json!([]),
            enabled_tools: Vec::new(),
            config: json!({}),
            max_run_steps: 50,
            workspace_settings: json!({}),
            paused: false,
            hosted_delivery_disabled: false,
            hosted_active_connection_id: None,
            hosted_channel_approved: false,
            is_channel_member: false,
            owner_only: None,
            connector_owner: None,
            owner_member_id: None,
            owner_display_name: None,
            hosted_confirmed_by_owner: false,
            thread_reply_wake: true,
            aliases: Vec::new(),
        }
    }

    fn marked(mut candidate: MentionCandidate, owner: Uuid) -> MentionCandidate {
        candidate.connector_owner = Some(ConnectorOwner {
            owner_member_id: owner,
            owner_display_name: "owner".into(),
            trial: None,
        });
        candidate
    }

    fn hosted(id: u128, owner: Uuid, connected: bool) -> MentionCandidate {
        let mut agent = marked(candidate(id), owner);
        agent.hosted_delivery_disabled = true;
        agent.hosted_active_connection_id = connected.then(|| Uuid::from_u128(900 + id));
        agent
    }

    fn hermes(id: u128, owner: Uuid, humans: i64, granted: &[&str]) -> MentionCandidate {
        let mut agent = marked(candidate(id), owner);
        agent.connector_owner.as_mut().expect("marked").trial = Some(ConnectorTrialFacts {
            active_humans: humans,
            granted_apps: granted.iter().map(|app| app.to_string()).collect(),
        });
        agent
    }

    fn attest(apps: &[&str]) -> ConnectorTrialAttest {
        ConnectorTrialAttest {
            tools_locked: true,
            connectors_locked: true,
            apps: apps.iter().map(|app| app.to_string()).collect(),
        }
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    /// 수용 7: **another member's agent and another member's grants are not in the answer.** A
    /// connector agent and an `owner_only` harness agent of someone else, and an unmarked agent, sit
    /// next to mine; only mine is projected, and `apps` is built from *my* grants. The sabotage is
    /// deleting the owner predicate from [`runtime_path`]: every other member's marked agent then shows
    /// up (stopped ones too — a paused or stopped trial stays in the list with a `blocked`, so this
    /// test sees them).
    #[test]
    fn only_my_own_app_runtimes_are_projected() {
        let mine = hosted(1, ME, true);
        let theirs = hosted(2, OTHER, true);
        let theirs_paused = {
            let mut agent = hosted(3, OTHER, true);
            agent.paused = true;
            agent
        };
        let their_trial = hermes(4, OTHER, 1, &[GMAIL]);
        let mut their_harness = marked(candidate(5), OTHER);
        their_harness.owner_only = Some(owner_only(OTHER, false, false));
        let unmarked = candidate(6);
        let answer = project(
            &[
                theirs,
                mine,
                theirs_paused,
                their_trial,
                their_harness,
                unmarked,
            ],
            ME,
            &ids(&[GMAIL]),
            true,
            &attest(&[GMAIL]),
        );
        assert_eq!(answer.len(), 1, "{answer:?}");
        assert_eq!(answer[0].agent_id, Uuid::from_u128(1).to_string());
        assert_eq!(answer[0].apps, ids(&[GMAIL]));

        // Nothing of the other member's agents leaks through any field of the wire.
        let wire = serde_json::to_string(&answer).expect("serialise");
        for other in [2u128, 3, 4, 5, 6] {
            assert!(
                !wire.contains(&Uuid::from_u128(other).to_string()),
                "{other}"
            );
        }
        assert!(!wire.contains(&OTHER.to_string()));
    }

    fn owner_only(owner: Uuid, personal: bool, uses_owner_key: bool) -> OwnerOnlyScope {
        OwnerOnlyScope {
            owner_member_id: owner,
            owner_display_name: "owner".into(),
            harness: momo_agent::SubscriptionHarness::ClaudeCode,
            recently_seen: true,
            reconnectable: false,
            uses_owner_key,
            personal_agent: personal,
        }
    }

    /// 수용 7: a marked **personal agent** (the owner's Mac harness) and a subscription harness or
    /// owner-key agent are not app runtimes in v1 — even when they are mine and carry the mark.
    #[test]
    fn a_personal_agent_and_an_owner_only_agent_are_not_app_runtimes() {
        let mut personal = hosted(1, ME, true);
        personal.owner_only = Some(owner_only(ME, true, false));
        let mut harness = hosted(2, ME, true);
        harness.owner_only = Some(owner_only(ME, false, false));
        let mut owner_key = hosted(3, ME, true);
        owner_key.owner_only = Some(owner_only(ME, false, true));
        let control = hosted(4, ME, true);
        let answer = project(
            &[personal, harness, owner_key, control],
            ME,
            &ids(&[GMAIL]),
            true,
            &attest(&[]),
        );
        let found: Vec<String> = answer.iter().map(|entry| entry.agent_id.clone()).collect();
        assert_eq!(
            found,
            [Uuid::from_u128(4).to_string()],
            "only the control agent is an app runtime"
        );
    }

    /// 수용 7: a marked agent that is neither the co-hosted Hermes nor a hosted vendor agent (a
    /// managed agent: no hosted connection row, not pinned to the operator's link) is absent in v1.
    #[test]
    fn a_marked_managed_agent_is_absent() {
        let managed = marked(candidate(1), ME);
        assert_eq!(runtime_path(&managed, ME), None);
        assert!(project(&[managed], ME, &ids(&[GMAIL]), true, &attest(&[GMAIL])).is_empty());
    }

    /// 수용 7: `hermes_trial.apps` is the operator's switched-on list **intersected with my active
    /// grants** — the operator's list never leaks whole, a grant of mine the operator did not switch
    /// on is not offered through Hermes, and the order is the operator's. `enforced` is true.
    #[test]
    fn hermes_trial_apps_are_the_operators_list_intersected_with_my_grants() {
        let agent = hermes(1, ME, 1, &[GMAIL, GCAL]);
        // The operator switched on gmail, github and calendar; I hold gmail and calendar (+ drive).
        let operator = attest(&[GCAL, GITHUB, GMAIL]);
        let answer = project(
            &[agent],
            ME,
            &ids(&[GMAIL, GCAL, "com.momo.plugins.drive"]),
            true,
            &operator,
        );
        assert_eq!(answer.len(), 1);
        assert_eq!(answer[0].path, RuntimePath::HermesTrial);
        assert!(answer[0].enforced);
        assert_eq!(
            answer[0].apps,
            ids(&[GCAL, GMAIL]),
            "operator order, my grants only"
        );
        assert!(
            !answer[0].apps.contains(&GITHUB.to_string()),
            "github is not mine"
        );
        assert!(
            answer[0]
                .apps
                .iter()
                .all(|app| ids(&[GMAIL, GCAL, "com.momo.plugins.drive"]).contains(app)),
            "always a subset of my grants"
        );
        // With none of my grants the operator's list reveals nothing.
        let none = project(&[hermes(1, ME, 1, &[])], ME, &[], true, &operator);
        assert!(none[0].apps.is_empty());
        // A grant for a non-catalogue id is never offered.
        let odd = project(
            &[hosted(1, ME, true)],
            ME,
            &ids(&["com.evil.plugins.x", GMAIL]),
            true,
            &operator,
        );
        assert_eq!(odd[0].apps, ids(&[GMAIL]));
    }

    /// 수용 7: a hosted vendor agent's `apps` are my active grants, and it is **not** enforced (oort
    /// records the grant; the vendor runtime enforces nothing).
    #[test]
    fn a_hosted_vendor_agent_lists_my_grants_and_is_not_enforced() {
        let answer = project(
            &[hosted(1, ME, true)],
            ME,
            &ids(&[GMAIL, GCAL]),
            true,
            &attest(&[]),
        );
        assert_eq!(answer[0].path, RuntimePath::HostedVendor);
        assert!(!answer[0].enforced);
        assert_eq!(answer[0].apps, ids(&[GMAIL, GCAL]));
        assert_eq!(answer[0].blocked, None);
    }

    /// 수용 7: each `blocked` value, one at a time, with the controls that make each of them mean
    /// something. The sabotage for `hosted_off`: delete that stage from [`blocked`] and the default-server
    /// fixture (hosted switch closed) answers `connection`/`null` instead.
    #[test]
    fn blocked_is_the_first_stage_of_the_delivery_gate_that_refuses() {
        let on = true;
        let off = false;
        let quiet = attest(&[]);
        let with_switch_on = |agent: &MentionCandidate, path| blocked(path, agent, on, &quiet);

        // hosted_vendor: hosted_off → connection → paused, in that order.
        let mut agent = hosted(1, ME, false);
        agent.paused = true;
        assert_eq!(
            blocked(RuntimePath::HostedVendor, &agent, off, &quiet),
            Some(Blocked::HostedOff),
            "the switch outranks the missing connection and the pause"
        );
        assert_eq!(
            with_switch_on(&agent, RuntimePath::HostedVendor),
            Some(Blocked::Connection),
            "no connection outranks the pause"
        );
        agent.hosted_active_connection_id = Some(Uuid::from_u128(9));
        assert_eq!(
            with_switch_on(&agent, RuntimePath::HostedVendor),
            Some(Blocked::Paused)
        );
        agent.paused = false;
        assert_eq!(
            with_switch_on(&agent, RuntimePath::HostedVendor),
            None,
            "deliverable"
        );
        // The default-config server (switch off) blocks even a fully connected agent: without the
        // `hosted_off` stage F8 would call every hosted agent on such a server deliverable.
        assert_eq!(
            blocked(RuntimePath::HostedVendor, &agent, off, &quiet),
            Some(Blocked::HostedOff)
        );

        // hermes_trial: the trial's own stop first (attest → members → apps), then paused.
        let complete = attest(&[GMAIL]);
        let mut trial = hermes(2, ME, 1, &[GMAIL]);
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &complete),
            None
        );
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &quiet),
            Some(Blocked::Attest),
            "an attestation missing from the environment"
        );
        let mut half = attest(&[GMAIL]);
        half.connectors_locked = false;
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &half),
            Some(Blocked::Attest)
        );
        trial.connector_owner.as_mut().expect("marked").trial = Some(ConnectorTrialFacts {
            active_humans: 2,
            granted_apps: ids(&[GMAIL]),
        });
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &complete),
            Some(Blocked::Members),
            "a second person in the workspace"
        );
        trial.connector_owner.as_mut().expect("marked").trial = Some(ConnectorTrialFacts {
            active_humans: 1,
            granted_apps: Vec::new(),
        });
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &complete),
            Some(Blocked::Apps),
            "an app the operator switched on lost my grant"
        );
        // …and each outranks `paused`.
        trial.paused = true;
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &complete),
            Some(Blocked::Apps)
        );
        trial.connector_owner.as_mut().expect("marked").trial = Some(ConnectorTrialFacts {
            active_humans: 1,
            granted_apps: ids(&[GMAIL]),
        });
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, on, &complete),
            Some(Blocked::Paused),
            "paused is the last stage, and it applies to the trial too"
        );
        // The hosted switch is a hosted-path fact: it never blocks the trial.
        trial.paused = false;
        assert_eq!(
            blocked(RuntimePath::HermesTrial, &trial, off, &complete),
            None
        );
    }

    /// The wire: camelCase keys, snake_case values, `blocked` always present (`null` when the agent
    /// is deliverable), the top level an **object** with the one key `runtimes` (ADR-0113 증보 3 F8
    /// 「모양」; planner 결정 1 — not a bare array, and not `apps`, which every entry already has).
    #[test]
    fn the_wire_shape_is_the_adr_shape() {
        let answer = project(
            &[hosted(1, ME, true), hermes(2, ME, 2, &[GMAIL])],
            ME,
            &ids(&[GMAIL]),
            true,
            &attest(&[GMAIL]),
        );
        let wire = serde_json::to_value(AppRuntimesDto { runtimes: answer }).expect("serialise");
        assert_eq!(
            wire,
            json!({
                "runtimes": [
                    {
                        "agentId": Uuid::from_u128(1).to_string(),
                        "path": "hosted_vendor",
                        "apps": [GMAIL],
                        "enforced": false,
                        "blocked": null
                    },
                    {
                        "agentId": Uuid::from_u128(2).to_string(),
                        "path": "hermes_trial",
                        "apps": [GMAIL],
                        "enforced": true,
                        "blocked": "members"
                    }
                ]
            })
        );
        // Nothing to list is still an object: `{"runtimes": []}`.
        assert_eq!(
            serde_json::to_value(AppRuntimesDto {
                runtimes: Vec::new()
            })
            .expect("serialise"),
            json!({ "runtimes": [] })
        );
        for blocked in [
            Blocked::HostedOff,
            Blocked::Connection,
            Blocked::Attest,
            Blocked::Members,
            Blocked::Apps,
            Blocked::Paused,
        ] {
            let value = serde_json::to_value(blocked).expect("serialise");
            assert!(
                [
                    "hosted_off",
                    "connection",
                    "attest",
                    "members",
                    "apps",
                    "paused"
                ]
                .contains(&value.as_str().expect("string")),
                "{value}"
            );
        }
    }
}
