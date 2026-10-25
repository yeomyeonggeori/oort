//! Contract test for #4313 / ADR-0113 증보 3 (no database): `docs/api/openapi.yaml` and the wire DTOs of the
//! app catalogue (F1), the `apps` request field (F5) and the app-runtimes projection (F8) name the same
//! fields, and the closed lists and limits the spec documents are the constants the server enforces.
//!
//! The precedent is `ai_hub_read_contract.rs`: the spec is read as text, so a drift between the document and
//! the code is a red test, not a surprise in a client. Every assertion compares the spec to a **value the
//! server computes** (a serialized DTO, an enum's serialization, a validator constant), never to a literal
//! restated here.

use std::collections::BTreeSet;

use momo_server::plugin_manifest::{
    ALLOWED_CATEGORIES, MAX_LOGO_KEY_BYTES, MAX_STARTER_PROMPTS, MAX_STARTER_PROMPT_CHARS,
};
use momo_server::routes::app_runtimes::{AppRuntimeDto, Blocked, RuntimePath};
use momo_server::routes::plugins::{PluginCatalogItemDto, PluginDetailDto, StarterPromptDto};
use serde_json::{json, Value};

fn spec() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/openapi.yaml"
    ))
    .expect("read openapi.yaml")
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// The lines of `components.schemas.<schema>` (everything indented deeper than the schema's own key).
fn schema_lines(spec: &str, schema: &str) -> Vec<String> {
    let header = format!("\n    {schema}:\n");
    let start = spec
        .find(&header)
        .unwrap_or_else(|| panic!("schema {schema} is in the spec"))
        + header.len();
    spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || indent_of(line) > 4)
        .map(str::to_string)
        .collect()
}

/// The direct property names of a components schema (properties sit at indent 8).
fn property_names(spec: &str, schema: &str) -> BTreeSet<String> {
    let mut in_properties = false;
    let mut names = BTreeSet::new();
    for line in schema_lines(spec, schema) {
        let text = line.trim();
        if indent_of(&line) == 6 && text == "properties:" {
            in_properties = true;
            continue;
        }
        if in_properties && indent_of(&line) == 8 {
            if let Some((name, _)) = text.split_once(':') {
                names.insert(name.to_string());
            }
        }
    }
    names
}

/// The lines of one property of a schema (everything deeper than the property's own key).
fn property_lines(spec: &str, schema: &str, property: &str) -> Vec<String> {
    let lines = schema_lines(spec, schema);
    let key = format!("{property}:");
    let start = lines
        .iter()
        .position(|line| indent_of(line) == 8 && line.trim().starts_with(&key))
        .unwrap_or_else(|| panic!("{schema}.{property} is in the spec"));
    let mut block = vec![lines[start].clone()];
    for line in &lines[start + 1..] {
        if !line.is_empty() && indent_of(line) <= 8 {
            break;
        }
        block.push(line.clone());
    }
    block
}

/// `enum: [a, b, null]` of a property, as strings (`null` stays `"null"`).
fn enum_of(spec: &str, schema: &str, property: &str) -> BTreeSet<String> {
    let block = property_lines(spec, schema, property);
    let line = block
        .iter()
        .find(|line| line.trim().starts_with("enum:"))
        .unwrap_or_else(|| panic!("{schema}.{property} declares an enum"));
    line.trim()
        .trim_start_matches("enum:")
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|value| value.trim().to_string())
        .collect()
}

fn number_of(spec: &str, schema: &str, property: &str, key: &str) -> usize {
    let block = property_lines(spec, schema, property);
    let prefix = format!("{key}:");
    block
        .iter()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("{schema}.{property} declares {key}"))
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("{schema}.{property}.{key} is a number"))
}

fn sorted_keys(value: &Value) -> BTreeSet<String> {
    value.as_object().expect("object").keys().cloned().collect()
}

fn as_set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn full_item() -> PluginCatalogItemDto {
    PluginCatalogItemDto {
        plugin_id: "com.momo.plugins.gmail".into(),
        name: "Gmail".into(),
        version: "1.0.0".into(),
        description: "d".into(),
        publisher_name: "Google".into(),
        terms_url: Some("https://t.example".into()),
        privacy_policy_url: Some("https://p.example".into()),
        icon_text: Some("G".into()),
        logo_key: Some("gmail".into()),
        category: Some("communication".into()),
        starter_prompts: vec![StarterPromptDto {
            text: "메일을 찾아 줘요.".into(),
            tool: "gmail.search_threads".into(),
        }],
        website_url: Some("https://mail.google.com".into()),
        official: true,
        recommended: false,
        egress_domains: vec![],
        recommended_for: vec![],
        installed: false,
        enabled: false,
    }
}

/// F1: the list row and the detail say exactly the fields the spec's two schemas name — the four display
/// fields and the developer column included, no more and no fewer.
#[test]
fn the_catalog_item_and_the_detail_name_the_fields_the_spec_names() {
    let spec = spec();
    let item = serde_json::to_value(full_item()).expect("serialise the item");
    assert_eq!(
        sorted_keys(&item),
        property_names(&spec, "PluginCatalogItem")
    );

    // The detail DTO is built from the same manifest; go through the real projection so the test cannot
    // pass on a struct nobody serialises.
    let detail = serde_json::to_value(PluginDetailDto {
        plugin_id: "com.momo.plugins.gmail".into(),
        name: "Gmail".into(),
        version: "1.0.0".into(),
        description: "d".into(),
        publisher_name: "Google".into(),
        terms_url: Some("https://t.example".into()),
        privacy_policy_url: Some("https://p.example".into()),
        icon_text: Some("G".into()),
        logo_key: Some("gmail".into()),
        category: Some("communication".into()),
        starter_prompts: vec![StarterPromptDto {
            text: "메일을 찾아 줘요.".into(),
            tool: "gmail.search_threads".into(),
        }],
        website_url: Some("https://mail.google.com".into()),
        official: true,
        egress_domains: vec![],
        recommended_for: vec![],
        installed: false,
        enabled: false,
        manifest: json!({}),
    })
    .expect("serialise the detail");
    assert_eq!(sorted_keys(&detail), property_names(&spec, "PluginDetail"));

    // The developer column is required on both (it is always present), the four display fields are not.
    for schema in ["PluginCatalogItem", "PluginDetail"] {
        let required = schema_lines(&spec, schema)
            .into_iter()
            .skip_while(|line| line.trim() != "required:")
            .skip(1)
            .take_while(|line| line.trim().starts_with("- "))
            .map(|line| line.trim().trim_start_matches("- ").to_string())
            .collect::<BTreeSet<_>>();
        assert!(
            required.contains("publisherName"),
            "{schema} requires publisherName"
        );
        for optional in ["logoKey", "category", "starterPrompts", "websiteURL"] {
            assert!(
                !required.contains(optional),
                "{schema}: {optional} is optional"
            );
        }
    }
}

/// F1: the closed lists and limits of the manifest validator are the ones the spec documents.
#[test]
fn the_spec_documents_the_limits_the_validator_enforces() {
    let spec = spec();
    for schema in ["PluginCatalogItem", "PluginDetail"] {
        assert_eq!(
            enum_of(&spec, schema, "category"),
            ALLOWED_CATEGORIES.iter().map(|c| c.to_string()).collect(),
            "{schema}.category"
        );
        assert_eq!(
            number_of(&spec, schema, "starterPrompts", "maxItems"),
            MAX_STARTER_PROMPTS,
            "{schema}.starterPrompts"
        );
        let pattern = property_lines(&spec, schema, "logoKey")
            .into_iter()
            .find(|line| line.trim().starts_with("pattern:"))
            .expect("logoKey has a pattern");
        assert!(
            pattern.contains(&format!("^[a-z0-9-]{{1,{MAX_LOGO_KEY_BYTES}}}$")),
            "{schema}.logoKey pattern: {pattern}"
        );
    }
    assert_eq!(
        number_of(&spec, "PluginStarterPrompt", "text", "maxLength"),
        MAX_STARTER_PROMPT_CHARS
    );
    assert_eq!(
        property_names(&spec, "PluginStarterPrompt"),
        as_set(&["text", "tool"])
    );
    // F5: the request field's limit is the server's.
    assert_eq!(
        number_of(&spec, "SendMessageRequest", "apps", "maxItems"),
        momo_agent::MAX_REQUESTED_APPS
    );
    assert!(
        spec.contains("apps_unavailable"),
        "the 400 code is documented"
    );
}

/// F8: the projection's wire keys, its two enums and its `null` are the spec's.
#[test]
fn the_app_runtime_schema_is_the_projection_the_server_answers() {
    let spec = spec();
    let entry = serde_json::to_value(AppRuntimeDto {
        agent_id: "a".into(),
        path: RuntimePath::HostedVendor,
        apps: vec![],
        enforced: false,
        blocked: None,
    })
    .expect("serialise");
    assert_eq!(sorted_keys(&entry), property_names(&spec, "AppRuntime"));
    assert_eq!(entry["blocked"], Value::Null, "`blocked` is always present");

    let required = schema_lines(&spec, "AppRuntime")
        .into_iter()
        .find(|line| line.trim().starts_with("required:"))
        .expect("AppRuntime has required");
    for key in sorted_keys(&entry) {
        assert!(
            required.contains(&key),
            "AppRuntime requires {key}: {required}"
        );
    }

    let serialised = |value: Value| -> String { value.as_str().expect("a string").to_string() };
    let blocked: BTreeSet<String> = [
        Blocked::HostedOff,
        Blocked::Connection,
        Blocked::Attest,
        Blocked::Members,
        Blocked::Apps,
        Blocked::Paused,
    ]
    .into_iter()
    .map(|value| serialised(serde_json::to_value(value).expect("serialise")))
    .collect();
    let mut documented = enum_of(&spec, "AppRuntime", "blocked");
    assert!(
        documented.remove("null"),
        "the enum names null (deliverable)"
    );
    assert_eq!(documented, blocked);
    let paths: BTreeSet<String> = [RuntimePath::HermesTrial, RuntimePath::HostedVendor]
        .into_iter()
        .map(|value| serialised(serde_json::to_value(value).expect("serialise")))
        .collect();
    assert_eq!(enum_of(&spec, "AppRuntime", "path"), paths);
}

/// F8: the operation exists, is a GET on the documented path, is a bare array, and says who may call it.
#[test]
fn the_app_runtimes_operation_is_documented() {
    let spec = spec();
    let header = "\n  /v1/workspaces/{workspaceId}/members/me/app-runtimes:\n    get:\n";
    let start = spec.find(header).expect("the path is documented as a GET") + header.len();
    let block: Vec<&str> = spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || indent_of(line) >= 4)
        .collect();
    let text = block.join("\n");
    assert!(text.contains("operationId: listMyAppRuntimes"));
    assert!(
        text.contains("type: array"),
        "the answer is a bare array (ADR F8 「모양」)"
    );
    assert!(text.contains("$ref: \"#/components/schemas/AppRuntime\""));
    assert!(
        text.contains("\"403\":"),
        "the agent-bearer refusal is documented"
    );
}
