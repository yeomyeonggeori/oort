//! Contract test for #4621 / ADR-0200 증보 6 (no database): `docs/api/openapi.yaml` and the wire DTOs in
//! `momo_server::dto` name the same fields for the agent's check beat (`cadence`), and the closed
//! vocabulary the spec documents is the one the server derives.
//!
//! The live-server pass (`scripts/verify_openapi_contract_rust.sh`) samples one fresh agent, which is
//! always `unknown`; it cannot tell a `routine`'s three numbers from a typo. This test can: it builds every
//! kind of answer and holds its keys to the spec, in both directions.

use momo_agent::{Cadence, CadenceKind};
use momo_server::dto::{AgentCadenceDto, AgentLivenessDto, HostedLivenessDto};
use serde_json::Value;

fn spec() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/openapi.yaml"
    ))
    .expect("read openapi.yaml")
}

/// The text of one components schema (the lines indented deeper than its header).
fn block(spec: &str, schema: &str) -> String {
    let header = format!("\n    {schema}:\n");
    let start = spec.find(&header).expect("schema present") + header.len();
    spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || line.starts_with("     "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The direct property names of a components schema.
fn property_names(spec: &str, schema: &str) -> Vec<String> {
    let mut in_properties = false;
    let mut names = Vec::new();
    for line in block(spec, schema).lines() {
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
    sorted(names)
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

fn keys(value: &Value) -> Vec<String> {
    sorted(value.as_object().expect("object").keys().cloned().collect())
}

fn at() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z")
        .expect("time")
        .with_timezone(&chrono::Utc)
}

fn routine() -> Cadence {
    Cadence {
        kind: CadenceKind::Routine,
        typical_minutes: Some(15),
        expected_check_at: Some(at()),
        late: false,
        intervals: 5,
    }
}

fn wire(cadence: &Cadence) -> Value {
    serde_json::to_value(AgentCadenceDto::from(cadence)).expect("serialize")
}

#[test]
fn the_cadence_schema_names_exactly_the_keys_a_routine_answer_carries() {
    let spec = spec();
    // a `routine` is the widest answer: every key the DTO can ever emit is on it
    assert_eq!(
        property_names(&spec, "AgentCadence"),
        keys(&wire(&routine())),
        "openapi AgentCadence and AgentCadenceDto drifted apart"
    );
    // and `kind` is the one required key, closed to nothing else
    let block = block(&spec, "AgentCadence");
    assert!(block.contains("additionalProperties: false"), "{block}");
    assert!(block.contains("required: [kind]"), "{block}");
    // the others carry only `kind`, which the schema allows
    for kind in [CadenceKind::Realtime, CadenceKind::Unknown] {
        let answer = wire(&Cadence {
            kind,
            ..Cadence::unknown()
        });
        assert_eq!(keys(&answer), ["kind"], "{answer}");
    }
}

#[test]
fn the_kind_enum_in_the_spec_is_the_vocabulary_the_server_derives() {
    let spec = spec();
    let block = block(&spec, "AgentCadence");
    let line = block
        .lines()
        .find(|line| line.trim_start().starts_with("enum: ["))
        .expect("AgentCadence.kind declares an enum");
    let listed = sorted(
        line.split_once('[')
            .and_then(|(_, rest)| rest.split_once(']'))
            .expect("an inline list")
            .0
            .split(',')
            .map(|word| word.trim().to_string())
            .collect(),
    );
    let derived = sorted(
        [
            CadenceKind::Realtime,
            CadenceKind::Routine,
            CadenceKind::Unknown,
        ]
        .map(|kind| kind.as_wire().to_string())
        .to_vec(),
    );
    assert_eq!(
        listed, derived,
        "the spec's kind list and CadenceKind differ"
    );
    assert_eq!(derived, ["realtime", "routine", "unknown"]);
}

#[test]
fn both_liveness_schemas_carry_the_cadence_by_reference() {
    let spec = spec();
    for schema in ["AgentLiveness", "HostedAgentLiveness"] {
        assert!(
            property_names(&spec, schema).contains(&"cadence".to_string()),
            "{schema} lacks `cadence`"
        );
        assert!(
            block(&spec, schema)
                .contains("cadence:\n          $ref: \"#/components/schemas/AgentCadence\""),
            "{schema}.cadence must reference AgentCadence"
        );
    }
}

#[test]
fn the_liveness_dtos_emit_exactly_the_properties_their_schemas_declare() {
    let spec = spec();
    let member = serde_json::to_value(AgentLivenessDto {
        agent_member_id: "a".into(),
        state: "quiet".into(),
        last_signal_at_ms: Some(1),
        cadence: AgentCadenceDto::from(&routine()),
    })
    .expect("serialize");
    assert_eq!(
        property_names(&spec, "AgentLiveness"),
        keys(&member),
        "openapi AgentLiveness and AgentLivenessDto drifted apart"
    );
    assert_eq!(
        keys(&member["cadence"]),
        property_names(&spec, "AgentCadence")
    );

    let admin = serde_json::to_value(HostedLivenessDto {
        state: "quiet".into(),
        last_signal_at_ms: Some(1),
        last_work_signal_at_ms: Some(1),
        last_ping_at_ms: Some(1),
        last_ping_state: Some("idle".into()),
        last_tool_error_at_ms: Some(1),
        last_tool_error_code: Some("unavailable".into()),
        work_waiting: true,
        oldest_waiting_at_ms: Some(1),
        cadence: AgentCadenceDto::from(&routine()),
    })
    .expect("serialize");
    assert_eq!(
        property_names(&spec, "HostedAgentLiveness"),
        keys(&admin),
        "openapi HostedAgentLiveness and HostedLivenessDto drifted apart"
    );
    assert_eq!(
        keys(&admin["cadence"]),
        property_names(&spec, "AgentCadence")
    );
}
