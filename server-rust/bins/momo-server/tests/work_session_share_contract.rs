//! Contract test for #2862 (no database): `docs/api/openapi.yaml` and the wire
//! DTO in `momo_server::dto` must name the same S1 fields. The spec says
//! `additionalProperties: false`, the DTO says `deny_unknown_fields`; if one of
//! them gains or loses a field the other has to move in the same diff, or this
//! fails — which is how a commit-title field would have to be added in the open.

use momo_server::dto::{ShareDiffRequest, ShareWorkSessionRequest};
use serde_json::{json, Map, Value};

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

fn full_body(names: &[String]) -> Value {
    let mut body = Map::new();
    for name in names {
        let value = match name.as_str() {
            "shared" => json!(true),
            "stages" => json!(["a"]),
            "diff" => json!({}),
            "lastActivityAt" => json!(1),
            _ => json!("x"),
        };
        body.insert(name.clone(), value);
    }
    Value::Object(body)
}

#[test]
fn the_spec_and_the_dto_name_the_same_s1_fields() {
    let spec = spec();
    assert!(
        spec.contains("/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}/share:"),
        "the route is documented"
    );
    let top = property_names(&spec, "ShareWorkSessionPayloadRequest", None);
    assert_eq!(
        top,
        [
            "shared",
            "repo",
            "branch",
            "harness",
            "state",
            "stages",
            "diff",
            "prUrl",
            "lastActivityAt"
        ],
        "spec top-level fields"
    );
    // Every documented field is accepted by the DTO...
    serde_json::from_value::<ShareWorkSessionRequest>(full_body(&top))
        .expect("every spec field is a DTO field");
    // ...and a field the spec does not name is not.
    for extra in [
        "commitTitle",
        "commitTitles",
        "fileNames",
        "output",
        "cwd",
        "remoteUrl",
    ] {
        let mut body = full_body(&top);
        body[extra] = json!("x");
        assert!(
            serde_json::from_value::<ShareWorkSessionRequest>(body).is_err(),
            "the DTO must not accept {extra}"
        );
    }
    let diff = property_names(&spec, "ShareWorkSessionPayloadRequest", Some("diff"));
    assert_eq!(
        diff,
        [
            "added",
            "deleted",
            "files",
            "ahead",
            "behind",
            "uncommitted"
        ],
        "spec diff fields"
    );
    let mut diff_body = Map::new();
    for name in &diff {
        diff_body.insert(name.clone(), json!(1));
    }
    serde_json::from_value::<ShareDiffRequest>(Value::Object(diff_body.clone()))
        .expect("every spec diff field is a DTO field");
    diff_body.insert("fileNames".into(), json!(["a.rs"]));
    assert!(serde_json::from_value::<ShareDiffRequest>(Value::Object(diff_body)).is_err());
}

#[test]
fn the_closed_lists_in_the_spec_are_the_ones_the_server_enforces() {
    let whole = spec();
    let from = whole
        .find("\n    ShareWorkSessionPayloadRequest:\n")
        .expect("schema present");
    let spec = &whole[from..];
    for (list, values) in [
        ("harness", momo_t3::work_share::HARNESSES),
        ("state", momo_t3::work_share::DERIVED_STATES),
    ] {
        let header = format!("\n        {list}:\n");
        let block = spec
            .find(&header)
            .unwrap_or_else(|| panic!("{list} documented"))
            + header.len();
        let key = "enum: [";
        let at = block
            + spec[block..]
                .find(key)
                .unwrap_or_else(|| panic!("{list} enum documented"))
            + key.len();
        let end = spec[at..].find(']').expect("enum end");
        let documented: Vec<&str> = spec[at..at + end].split(',').map(str::trim).collect();
        assert_eq!(documented, values, "{list} enum");
    }
}
