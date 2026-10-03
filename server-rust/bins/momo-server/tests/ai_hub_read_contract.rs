//! Contract test for #3392 AIH-2 (no database): `docs/api/openapi.yaml` and the
//! wire DTOs in `momo_server::dto` name the same fields, and the closed lists
//! the spec documents are the ones the server derives.

use momo_agent::{
    AgentBrain, AgentReadFacts, SubscriptionHarness, CALLABLE_BY_EVERYONE, CALLABLE_BY_OWNER_ONLY,
    CLAUDE_SUBSCRIPTION_AGENT_PAUSED,
};
use momo_server::dto::{
    AgentMemberDto, HostedAgentConnectionDto, RegisterSubscriptionAgentRequest,
    RegisterSubscriptionAgentResponse,
};
use serde_json::{json, Value};
use uuid::Uuid;

fn spec() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/openapi.yaml"
    ))
    .expect("read openapi.yaml")
}

/// The direct property names of a components schema.
fn property_names(spec: &str, schema: &str) -> Vec<String> {
    let header = format!("\n    {schema}:\n");
    let start = spec.find(&header).expect("schema present") + header.len();
    let mut in_properties = false;
    let mut names = Vec::new();
    for line in spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || line.starts_with("     "))
    {
        let indent = line.len() - line.trim_start().len();
        let text = line.trim();
        if indent == 6 && text == "properties:" {
            in_properties = true;
            continue;
        }
        if in_properties && indent == 8 {
            if let Some((name, _)) = text.split_once(':') {
                names.push(name.to_string());
            }
        }
    }
    names
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

fn keys(value: &Value) -> Vec<String> {
    sorted(value.as_object().expect("object").keys().cloned().collect())
}

fn facts(brain: AgentBrain) -> AgentReadFacts {
    AgentReadFacts {
        agent_member_id: Uuid::nil(),
        brain,
        callable_by: if brain == AgentBrain::Subscription {
            CALLABLE_BY_OWNER_ONLY
        } else {
            CALLABLE_BY_EVERYONE
        },
        owner: (brain == AgentBrain::Subscription).then(|| (Uuid::nil(), "성재".to_string())),
        host_online: Some(true),
        subscription_harness: (brain == AgentBrain::Subscription)
            .then_some(SubscriptionHarness::ClaudeCode),
    }
}

fn connection() -> HostedAgentConnectionDto {
    HostedAgentConnectionDto {
        id: "c".into(),
        agent_member_id: "a".into(),
        status: "pairing_pending".into(),
        auth_mode: "static_bearer".into(),
        audience: "/v1/mcp/agent-port".into(),
        approved_channel_ids: vec![],
        approved_scopes: vec![],
        active_credential_id: None,
        created_at_ms: 1,
        updated_at_ms: 1,
        doorbell_url: None,
        doorbell_secret_masked: None,
        doorbell_last_fired_at_ms: None,
        doorbell_last_status: None,
        invocation_scope: Some("owner_only".into()),
        subscription_harness: Some("claude_code".into()),
        brain: None,
        callable_by: None,
        owner: None,
        host_online: None,
        brain_unavailable_reason: None,
    }
}

#[test]
fn the_four_read_fields_are_in_both_schemas_and_on_the_wire() {
    let spec = spec();
    for schema in ["RosterMember", "HostedAgentConnection"] {
        let names = property_names(&spec, schema);
        for field in [
            "brain",
            "callableBy",
            "owner",
            "hostOnline",
            "brainUnavailableReason",
        ] {
            assert!(names.contains(&field.to_string()), "{schema} lacks {field}");
        }
    }
    let mut dto = connection();
    dto.apply_read_facts(&facts(AgentBrain::Subscription), false);
    let wire = serde_json::to_value(&dto).unwrap();
    for field in ["brain", "callableBy", "owner", "hostOnline"] {
        assert!(wire.get(field).is_some(), "wire lacks {field}: {wire}");
    }
    assert_eq!(keys(&wire["owner"]), ["displayName", "id"]);
    // #3397: a Claude subscription agent on an instance that has not opted in says why.
    assert_eq!(
        wire["brainUnavailableReason"],
        CLAUDE_SUBSCRIPTION_AGENT_PAUSED
    );
    assert_eq!(
        CLAUDE_SUBSCRIPTION_AGENT_PAUSED,
        "claude_subscription_agent_paused"
    );
    let mut opted_in = connection();
    opted_in.apply_read_facts(&facts(AgentBrain::Subscription), true);
    assert!(serde_json::to_value(&opted_in)
        .unwrap()
        .get("brainUnavailableReason")
        .is_none());
    // A row with no facts (human, or an older code path) carries none of them.
    let bare = serde_json::to_value(connection()).unwrap();
    for field in ["brain", "callableBy", "owner", "hostOnline"] {
        assert!(bare.get(field).is_none(), "{field} leaked onto a bare row");
    }
    // A team agent has no owner and no liveness unless it dials in.
    let mut team = connection();
    let mut team_facts = facts(AgentBrain::TeamKey);
    team_facts.host_online = None;
    team.apply_read_facts(&team_facts, false);
    let wire = serde_json::to_value(&team).unwrap();
    assert!(
        wire.get("owner").is_none() && wire.get("hostOnline").is_none(),
        "{wire}"
    );
}

#[test]
fn the_brain_and_callable_by_lists_in_the_spec_are_the_ones_the_server_derives() {
    let spec = spec();
    let derived = [
        AgentBrain::Subscription,
        AgentBrain::TeamKey,
        AgentBrain::External,
        AgentBrain::InstanceDefault,
        AgentBrain::PersonalKey,
    ]
    .map(|brain| brain.as_str());
    assert!(
        spec.contains("enum: [subscription, team_key, external, instance_default, personal_key]"),
        "brain enum"
    );
    for value in derived {
        assert!(
            spec.contains(&format!("{value},")) || spec.contains(&format!(" {value}]")),
            "{value}"
        );
    }
    assert!(
        spec.contains("enum: [owner_only, everyone]"),
        "callableBy enum"
    );
    assert_eq!(
        (CALLABLE_BY_OWNER_ONLY, CALLABLE_BY_EVERYONE),
        ("owner_only", "everyone")
    );
}

#[test]
fn the_register_request_and_response_match_the_spec() {
    let spec = spec();
    assert!(spec.contains("/v1/workspaces/{workspaceId}/subscription-agents/register:"));
    let request = json!({
        "harness": "codex", "deviceId": "dev-12345678", "deviceLabel": "mac",
        "displayName": "x", "handle": "x-1"
    });
    serde_json::from_value::<RegisterSubscriptionAgentRequest>(request.clone())
        .expect("every documented field decodes");
    assert_eq!(
        sorted(property_names(&spec, "RegisterSubscriptionAgentRequest")),
        keys(&request)
    );
    let mut extra = request.clone();
    extra["invocationScope"] = json!("workspace");
    assert!(
        serde_json::from_value::<RegisterSubscriptionAgentRequest>(extra).is_err(),
        "an undocumented field must be refused"
    );
    let response = RegisterSubscriptionAgentResponse {
        agent: AgentMemberDto {
            id: "a".into(),
            handle: "h".into(),
            display_name: "d".into(),
        },
        connection: connection(),
        reused: false,
        pairing_credential: Some("v".into()),
        pairing_expires_at_ms: Some(1),
    };
    assert_eq!(
        sorted(property_names(&spec, "RegisterSubscriptionAgentResponse")),
        keys(&serde_json::to_value(&response).unwrap())
    );
    // Reused + active: no value on the wire at all.
    let reused = RegisterSubscriptionAgentResponse {
        pairing_credential: None,
        pairing_expires_at_ms: None,
        reused: true,
        ..response
    };
    let wire = serde_json::to_value(&reused).unwrap();
    assert!(wire.get("pairingCredential").is_none() && wire.get("pairingExpiresAtMs").is_none());
}
