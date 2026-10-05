//! Contract test for #3322 (no database): `docs/api/openapi.yaml` and the board's
//! wire DTOs in `momo_server::dto` must name the same fields, the closed lists
//! must be the ones the server enforces, and the realtime contract the spec
//! documents (event -> refetch) must name the event the server really emits.

use momo_server::dto::{
    SharedDiffDto, SharedPrDto, SharedSessionChannelDto, SharedSessionOwnerDto,
    SharedWorkSessionDto, SharedWorkSessionListResponse,
};
use serde_json::{json, Value};

fn spec() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/openapi.yaml"
    ))
    .expect("read openapi.yaml")
}

/// The direct property names of a schema (`    Name:` under components/schemas),
/// optionally of a nested object property (`diff`).
fn property_names(spec: &str, schema: &str, nested: Option<&str>) -> Vec<String> {
    let header = format!("\n    {schema}:\n");
    let start = spec.find(&header).expect("schema present") + header.len();
    let body: Vec<&str> = spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || line.starts_with("     "))
        .collect();
    let nested_header = nested.map(|name| format!("{name}:"));
    let mut in_properties = false;
    let mut in_nested = nested.is_none();
    let mut depth_indent = if nested.is_some() { 12 } else { 8 };
    let mut names = Vec::new();
    for line in body {
        let indent = line.len() - line.trim_start().len();
        let text = line.trim();
        if text == "properties:" && indent == 6 && nested.is_none() {
            in_properties = true;
            continue;
        }
        if nested.is_some() {
            if indent == 6 && text == "properties:" {
                in_properties = true;
                continue;
            }
            if in_properties && indent == 8 && Some(text) == nested_header.as_deref() {
                in_nested = true;
                depth_indent = 12;
                continue;
            }
            if in_nested && indent == 10 && text == "properties:" {
                continue;
            }
            if in_nested && indent == 8 && Some(text) != nested_header.as_deref() {
                in_nested = false;
            }
        }
        if in_properties && in_nested && indent == depth_indent {
            if let Some((name, _)) = text.split_once(':') {
                names.push(name.to_string());
            }
        }
    }
    names
}

fn sample() -> SharedWorkSessionDto {
    SharedWorkSessionDto {
        source: "session",
        session_id: Some("s".into()),
        run_id: None,
        requested_by: None,
        step_count: None,
        commits: None,
        pr: None,
        origin: "host".into(),
        label: "l".into(),
        folder_label: None,
        status: "running".into(),
        owner: SharedSessionOwnerDto {
            member_id: "m".into(),
            display_name: "n".into(),
        },
        home_channel: SharedSessionChannelDto {
            id: "c".into(),
            name: None,
        },
        started_at_ms: 1,
        ended_at_ms: None,
        shared_at_ms: None,
        repo: None,
        branch: None,
        harness: "codex".into(),
        state: "running".into(),
        stages: vec![],
        diff: SharedDiffDto {
            added: None,
            deleted: None,
            files: None,
            ahead: None,
            behind: None,
            uncommitted: None,
        },
        pr_url: None,
        last_activity_at: 1,
    }
}

/// A run item with every optional key present: the union of its keys and a
/// session item's is the whole documented shape.
fn sample_run() -> SharedWorkSessionDto {
    SharedWorkSessionDto {
        source: "run",
        session_id: None,
        run_id: Some("r".into()),
        requested_by: Some(SharedSessionOwnerDto {
            member_id: "m".into(),
            display_name: "n".into(),
        }),
        step_count: Some(1),
        commits: Some(1),
        pr: Some(SharedPrDto {
            url: "https://github.com/a/b/pull/1".into(),
            number: Some(1),
        }),
        ..sample()
    }
}

fn sorted_keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    keys
}

fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

#[test]
fn the_spec_and_the_board_dto_name_the_same_fields() {
    let spec = spec();
    for path in [
        "/v1/workspaces/{workspaceId}/work-sessions/shared:",
        "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}/shared:",
    ] {
        assert!(spec.contains(path), "{path} is documented");
    }
    let wire = serde_json::to_value(sample()).unwrap();
    let run_wire = serde_json::to_value(sample_run()).unwrap();
    let mut all_keys = sorted_keys(&wire);
    all_keys.extend(sorted_keys(&run_wire));
    all_keys.sort();
    all_keys.dedup();
    assert_eq!(
        sorted(property_names(&spec, "SharedWorkSession", None)),
        all_keys,
        "SharedWorkSession fields (session ∪ run item)"
    );
    // A session item never carries a run-only key and a run item never carries
    // `sessionId` (D13: `run_id` instead of `session_id`).
    assert!(wire.get("runId").is_none() && wire.get("requestedBy").is_none());
    assert!(run_wire.get("sessionId").is_none() && run_wire["source"] == "run");
    assert_eq!(
        sorted(property_names(&spec, "SharedWorkSession", Some("pr"))),
        sorted_keys(&run_wire["pr"]),
        "pr fields"
    );
    assert_eq!(
        sorted(property_names(
            &spec,
            "SharedWorkSession",
            Some("requestedBy")
        )),
        sorted_keys(&run_wire["requestedBy"]),
        "requestedBy fields"
    );
    assert_eq!(
        sorted(property_names(&spec, "SharedWorkSession", Some("owner"))),
        sorted_keys(&wire["owner"]),
        "owner fields"
    );
    assert_eq!(
        sorted(property_names(
            &spec,
            "SharedWorkSession",
            Some("homeChannel")
        )),
        sorted_keys(&wire["homeChannel"]),
        "homeChannel fields"
    );
    assert_eq!(
        sorted(property_names(&spec, "SharedWorkSessionDiff", None)),
        sorted_keys(&wire["diff"]),
        "diff fields"
    );
    let list = serde_json::to_value(SharedWorkSessionListResponse {
        sessions: vec![],
        next_cursor: None,
    })
    .unwrap();
    assert_eq!(
        sorted(property_names(&spec, "SharedWorkSessionListResponse", None)),
        sorted_keys(&list),
        "list envelope"
    );
}

#[test]
fn the_board_shape_has_no_terminal_control_or_commit_vocabulary() {
    let spec = spec();
    let from = spec
        .find("\n    SharedWorkSession:\n")
        .expect("schema present");
    let to = spec[from..]
        .find("\n    SharedWorkSessionListResponse:")
        .unwrap()
        + from;
    let block = spec[from..to].to_lowercase();
    // Property names only: the description may say what is absent.
    let names: Vec<String> = property_names(&spec, "SharedWorkSession", None)
        .into_iter()
        .map(|name| name.to_lowercase())
        .collect();
    // `commits` is a count (D12); no other commit-shaped name may appear.
    assert!(
        names
            .iter()
            .all(|name| !name.contains("commit") || name == "commits"),
        "a commit title/message must not be a board field"
    );
    for forbidden in [
        "pty",
        "attach",
        "endpoint",
        "output",
        "input",
        "text",
        "cwd",
        "path",
        "body",
        "hostid",
        "props",
        "control",
        "keystroke",
        "stdin",
    ] {
        assert!(
            !names.iter().any(|name| name.contains(forbidden)),
            "{forbidden} must not be a board field"
        );
    }
    assert!(block.contains("additionalproperties: false"));
}

#[test]
fn the_closed_lists_and_the_realtime_contract_match_the_server() {
    let whole = spec();
    let from = whole.find("\n    SharedWorkSession:\n").unwrap();
    let block = &whole[from..];
    let header = "\n        state:\n";
    let at = block.find(header).unwrap() + header.len();
    let key = "enum: [";
    let at = at + block[at..].find(key).unwrap() + key.len();
    let end = block[at..].find(']').unwrap();
    let documented: Vec<&str> = block[at..at + end].split(',').map(str::trim).collect();
    assert_eq!(
        documented,
        momo_t3::work_share::DERIVED_STATES,
        "state enum"
    );

    // event -> refetch: the spec names the event the server emits.
    let event = momo_t3::work_share::share_changed_payload(
        "c",
        uuid::Uuid::nil(),
        uuid::Uuid::nil(),
        "enabled",
        0,
        uuid::Uuid::nil(),
    );
    let name = event["data"]["type"].as_str().unwrap();
    let list_op = &whole[whole
        .find("operationId: listSharedWorkSessions")
        .expect("list operation")..];
    let list_op = &list_op[..list_op.find("operationId: getSharedWorkSession").unwrap()];
    assert!(list_op.contains(name), "the spec names {name}");
    assert!(
        list_op.contains("re-reads this list"),
        "and says to refetch"
    );
    assert_eq!(
        json!(event["data"]["payload"].as_object().unwrap().len()),
        json!(3),
        "the event carries session_id, channel_id, kind and nothing else"
    );
}
