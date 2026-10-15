//! ADR-0113 D6 plugin manifest admission — the Rust port of the retired Swift
//! `PluginManifestValidator` (deleted in #2165, `8f4a23cac^:server/Sources/
//! MomoServer/Plugins/PluginManifestValidator.swift`).
//!
//! ADR-0113 증보 2026-10-15 (#3838) P2: the read routes (`routes::plugins`) only
//! ever show a manifest that passes this gate. Every policy vocabulary is an
//! explicit allowlist and every object has an exact key set, so a newer
//! manifest cannot silently widen an older server's authority, and a manifest
//! that grew a credential-shaped key is refused before it can be echoed.
//!
//! Pure: no SQL, no HTTP, no clock. The digest is computed **in SQL** by the
//! caller (`'sha256:' || encode(sha256(convert_to(manifest::text,'UTF8')),'hex')`,
//! the same expression migrations 013/015/031/059 used to seed it) because only
//! Postgres can reproduce its own canonical jsonb text; re-serialising with
//! serde_json would never match.

use std::collections::{BTreeSet, HashSet};

use serde_json::{Map, Value};

pub const SCHEMA_VERSION: &str = "momo.plugin.v1";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 1] = ["2025-06-18"];
pub const SUPPORTED_TRANSPORTS: [&str; 1] = ["streamable_http"];
pub const ALLOWED_SPDX: [&str; 5] = [
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "LicenseRef-Linear-Hosted-Service",
];
pub const ALLOWED_PLUGIN_RISKS: [&str; 4] = ["low", "medium", "high", "critical"];
pub const ALLOWED_TOOL_RISKS: [&str; 3] = ["read", "write", "admin"];
pub const ALLOWED_APPROVAL_POLICIES: [&str; 4] = ["none", "require_approval", "always", "deny"];
pub const ALLOWED_APPROVAL_TIERS: [&str; 3] = ["read_only", "workspace_write", "network_write"];
pub const ALLOWED_INSTALL_ROLES: [&str; 2] = ["owner", "admin"];

/// A key whose lower-cased name contains any of these is refused anywhere in
/// the manifest (ADR-0113 D1 custody A: the server never holds a provider
/// credential, so a manifest has no business naming one).
pub const FORBIDDEN_KEY_FRAGMENTS: [&str; 10] = [
    "credential",
    "access_token",
    "refresh_token",
    "oauth_token",
    "authorization",
    "client_secret",
    "private_key",
    "password",
    "bearer_token",
    "api_key",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPluginTool {
    pub name: String,
    pub scopes: Vec<String>,
    pub risk: String,
    pub approval_policy: String,
    pub approval_tier: String,
    pub schema_digest: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedPluginManifest {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub terms_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    pub icon_text: Option<String>,
    pub mcp_url: String,
    pub mcp_transport: String,
    pub hosted: bool,
    pub egress_domains: Vec<String>,
    pub recommended_for: Vec<String>,
    pub install_allowed: bool,
    pub enabled_by_default: bool,
    pub allowed_roles: Vec<String>,
    pub tools: Vec<ValidatedPluginTool>,
    /// The parsed manifest, echoed verbatim by the detail route.
    pub json: Value,
}

/// Why a manifest was refused. The reason strings are the Swift ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestRejected(pub String);

impl std::fmt::Display for ManifestRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

type Object = Map<String, Value>;
type Checked<T> = Result<T, ManifestRejected>;

fn rejected<T>(reason: impl Into<String>) -> Checked<T> {
    Err(ManifestRejected(reason.into()))
}

/// The one entry point: digest gate, then the full structural admission, then
/// the registry-row identity gate.
///
/// * `registry_plugin_id` — `plugin_registry.plugin_id` of the row.
/// * `expected_digest` — `plugin_registry.manifest_digest` (what was declared).
/// * `computed_digest` — the SQL-computed digest of `manifest::text` now.
pub fn validate_registry_manifest(
    registry_plugin_id: &str,
    manifest_text: &str,
    expected_digest: &str,
    computed_digest: &str,
) -> Checked<ValidatedPluginManifest> {
    if !is_sha256_digest(expected_digest) || expected_digest != computed_digest {
        return rejected("manifest digest mismatch");
    }
    let manifest = validate_manifest(manifest_text)?;
    if manifest.plugin_id != registry_plugin_id {
        return rejected("registry id does not match manifest");
    }
    Ok(manifest)
}

/// Structural admission of one manifest document (Swift `validate`, minus the
/// digest and revocation inputs: the digest is [`validate_registry_manifest`]'s
/// job and revocation is the caller's SQL predicate).
pub fn validate_manifest(manifest_text: &str) -> Checked<ValidatedPluginManifest> {
    let json: Value = match serde_json::from_str(manifest_text) {
        Ok(value) => value,
        Err(_) => return rejected("manifest is malformed"),
    };
    let Some(root) = json.as_object() else {
        return rejected("manifest root must be an object");
    };
    require_keys(
        root,
        &["schemaVersion", "plugin", "mcp", "skill", "momo"],
        "manifest",
    )?;
    if string(root, "schemaVersion", "manifest")? != SCHEMA_VERSION {
        return rejected("unknown manifest schema");
    }
    reject_secret_like_keys(&json, "manifest")?;

    // -- plugin ------------------------------------------------------------
    let plugin = object(root, "plugin", "manifest")?;
    let required_plugin_keys = [
        "id",
        "name",
        "version",
        "description",
        "publisher",
        "license",
        "provenance",
    ];
    let optional_plugin_keys = ["termsURL", "privacyPolicyURL", "iconText"];
    let has_all_required = required_plugin_keys
        .iter()
        .all(|key| plugin.contains_key(*key));
    let has_only_known = plugin.keys().all(|key| {
        required_plugin_keys.contains(&key.as_str()) || optional_plugin_keys.contains(&key.as_str())
    });
    if !has_all_required || !has_only_known {
        return rejected("unknown or missing field at plugin");
    }
    let plugin_id = string(plugin, "id", "plugin")?;
    if !is_plugin_id(plugin_id) {
        return rejected("invalid plugin id");
    }
    let name = nonempty(string(plugin, "name", "plugin")?, "plugin name")?;
    let version = nonempty(string(plugin, "version", "plugin")?, "plugin version")?;
    let description = nonempty(
        string(plugin, "description", "plugin")?,
        "plugin description",
    )?;
    let terms_url = optional_https_url(plugin, "termsURL", "plugin")?;
    let privacy_policy_url = optional_https_url(plugin, "privacyPolicyURL", "plugin")?;
    let icon_text = optional_icon_text(plugin, "iconText", "plugin")?;

    let publisher = object(plugin, "publisher", "plugin")?;
    require_keys(publisher, &["id", "name", "verified"], "plugin.publisher")?;
    nonempty(string(publisher, "id", "plugin.publisher")?, "publisher id")?;
    nonempty(
        string(publisher, "name", "plugin.publisher")?,
        "publisher name",
    )?;
    if !boolean(publisher, "verified", "plugin.publisher")? {
        return rejected("publisher is not verified");
    }

    let license = object(plugin, "license", "plugin")?;
    require_keys(license, &["spdx", "kind"], "plugin.license")?;
    let spdx = string(license, "spdx", "plugin.license")?;
    let lower_spdx = spdx.to_lowercase();
    if lower_spdx.contains("gpl") || lower_spdx.contains("agpl") || !ALLOWED_SPDX.contains(&spdx) {
        return rejected("license is not admitted");
    }
    let license_kind = string(license, "kind", "plugin.license")?;
    if !["open_source", "hosted_only"].contains(&license_kind) {
        return rejected("unknown license kind");
    }

    let provenance = object(plugin, "provenance", "plugin")?;
    require_keys(
        provenance,
        &["sourceURL", "releaseRef", "verified"],
        "plugin.provenance",
    )?;
    let source_url = string(provenance, "sourceURL", "plugin.provenance")?;
    if https_host(source_url).is_none() || !boolean(provenance, "verified", "plugin.provenance")? {
        return rejected("publisher provenance is not verified HTTPS");
    }
    nonempty(
        string(provenance, "releaseRef", "plugin.provenance")?,
        "release ref",
    )?;

    // -- momo (read first: `hosted` decides how the MCP url is judged) -----
    let momo = object(root, "momo", "manifest")?;
    let base_momo_keys: BTreeSet<&str> = [
        "approvalTier",
        "risk",
        "egressDomains",
        "recommendedFor",
        "serverPolicy",
    ]
    .into_iter()
    .collect();
    let momo_keys: BTreeSet<&str> = momo.keys().map(String::as_str).collect();
    let mut hosted_keys = base_momo_keys.clone();
    hosted_keys.insert("hosted");
    if momo_keys != base_momo_keys && momo_keys != hosted_keys {
        return rejected("unknown or missing field at momo");
    }
    let hosted = match momo.get("hosted") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return rejected("momo.hosted must be a boolean"),
    };

    // -- mcp ---------------------------------------------------------------
    let mcp = object(root, "mcp", "manifest")?;
    require_keys(
        mcp,
        &["protocolVersion", "transport", "url", "server", "tools"],
        "mcp",
    )?;
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&string(mcp, "protocolVersion", "mcp")?) {
        return rejected("unknown MCP protocol");
    }
    let mcp_transport = string(mcp, "transport", "mcp")?;
    if !SUPPORTED_TRANSPORTS.contains(&mcp_transport) {
        return rejected("unknown MCP transport");
    }
    let mcp_url = string(mcp, "url", "mcp")?;
    let endpoint_host = if hosted {
        if !is_hosted_endpoint_path(mcp_url) {
            return rejected("hosted MCP endpoint must be an absolute path");
        }
        None
    } else {
        match https_host(mcp_url) {
            Some(host) => Some(host.to_lowercase()),
            None => return rejected("MCP endpoint must be HTTPS"),
        }
    };
    let server = object(mcp, "server", "mcp")?;
    require_keys(server, &["name", "version"], "mcp.server")?;
    nonempty(string(server, "name", "mcp.server")?, "server name")?;
    nonempty(string(server, "version", "mcp.server")?, "server version")?;

    // -- skill -------------------------------------------------------------
    let skill = object(root, "skill", "manifest")?;
    require_keys(skill, &["reference", "optional"], "skill")?;
    if !boolean(skill, "optional", "skill")? {
        return rejected("SKILL reference must remain optional in v1");
    }
    match skill.get("reference") {
        None | Some(Value::Null) => {}
        Some(Value::String(value)) if value.starts_with("https://") => {}
        Some(_) => return rejected("SKILL reference must be null or HTTPS"),
    }

    // -- momo policy -------------------------------------------------------
    let plugin_risk = string(momo, "risk", "momo")?;
    if !ALLOWED_PLUGIN_RISKS.contains(&plugin_risk) {
        return rejected("unknown plugin risk");
    }
    let approval_tier = object(momo, "approvalTier", "momo")?;

    let egress_domains = strings(momo, "egressDomains", "momo")?;
    let unique_egress: HashSet<&String> = egress_domains.iter().collect();
    let egress_ok = !egress_domains.is_empty()
        && unique_egress.len() == egress_domains.len()
        && egress_domains.iter().all(|domain| is_egress_domain(domain))
        && (hosted
            || endpoint_host
                .as_ref()
                .is_some_and(|host| egress_domains.contains(host)));
    if !egress_ok {
        return rejected("egressDomains must be unique domain names and include the MCP endpoint");
    }
    let recommended_for = strings(momo, "recommendedFor", "momo")?;
    if recommended_for.is_empty() || recommended_for.iter().any(String::is_empty) {
        return rejected("recommendedFor must not be empty");
    }

    let policy = object(momo, "serverPolicy", "momo")?;
    require_keys(
        policy,
        &["installAllowed", "enabledByDefault", "allowedRoles"],
        "momo.serverPolicy",
    )?;
    let install_allowed = boolean(policy, "installAllowed", "momo.serverPolicy")?;
    let enabled_by_default = boolean(policy, "enabledByDefault", "momo.serverPolicy")?;
    let allowed_roles = strings(policy, "allowedRoles", "momo.serverPolicy")?;
    let unique_roles: HashSet<&String> = allowed_roles.iter().collect();
    if allowed_roles.is_empty()
        || unique_roles.len() != allowed_roles.len()
        || !allowed_roles
            .iter()
            .all(|role| ALLOWED_INSTALL_ROLES.contains(&role.as_str()))
    {
        return rejected("unknown serverPolicy role");
    }

    // -- tools -------------------------------------------------------------
    let raw_tools = array(mcp, "tools", "mcp")?;
    if raw_tools.is_empty() {
        return rejected("manifest must declare at least one tool");
    }
    let mut tools = Vec::with_capacity(raw_tools.len());
    let mut tool_names: BTreeSet<String> = BTreeSet::new();
    for (index, raw_tool) in raw_tools.iter().enumerate() {
        let Some(tool) = raw_tool.as_object() else {
            return rejected(format!("mcp.tools[{index}] must be an object"));
        };
        let path = format!("mcp.tools[{index}]");
        require_keys(
            tool,
            &[
                "name",
                "description",
                "inputSchema",
                "schemaDigest",
                "scopes",
                "risk",
                "approvalPolicy",
            ],
            &path,
        )?;
        let tool_name = nonempty(string(tool, "name", &path)?, "tool name")?;
        if !tool_names.insert(tool_name.to_string()) {
            return rejected("duplicate tool name");
        }
        nonempty(string(tool, "description", &path)?, "tool description")?;
        let input_schema = object(tool, "inputSchema", &path)?;
        validate_input_schema(input_schema, &format!("{path}.inputSchema"))?;
        let schema_digest = string(tool, "schemaDigest", &path)?;
        if !is_sha256_digest(schema_digest) {
            return rejected("invalid tool schema digest");
        }
        let scopes = strings(tool, "scopes", &path)?;
        let unique_scopes: HashSet<&String> = scopes.iter().collect();
        if scopes.is_empty()
            || unique_scopes.len() != scopes.len()
            || !scopes.iter().all(|scope| is_scope(scope))
        {
            return rejected("invalid tool scope");
        }
        let risk = string(tool, "risk", &path)?;
        if !ALLOWED_TOOL_RISKS.contains(&risk) {
            return rejected("unknown tool risk");
        }
        let approval_policy = string(tool, "approvalPolicy", &path)?;
        if !ALLOWED_APPROVAL_POLICIES.contains(&approval_policy) {
            return rejected("unknown approval policy");
        }
        let tier = match approval_tier.get(tool_name).and_then(Value::as_str) {
            Some(tier) if ALLOWED_APPROVAL_TIERS.contains(&tier) => tier,
            _ => return rejected("unknown or missing approval tier"),
        };
        validate_policy_combination(risk, approval_policy, tier)?;
        tools.push(ValidatedPluginTool {
            name: tool_name.to_string(),
            scopes,
            risk: risk.to_string(),
            approval_policy: approval_policy.to_string(),
            approval_tier: tier.to_string(),
            schema_digest: schema_digest.to_string(),
        });
    }
    let tier_keys: BTreeSet<String> = approval_tier.keys().cloned().collect();
    if tier_keys != tool_names {
        return rejected("approvalTier must map exactly the declared tools");
    }

    Ok(ValidatedPluginManifest {
        plugin_id: plugin_id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        description: description.to_string(),
        terms_url,
        privacy_policy_url,
        icon_text,
        mcp_url: mcp_url.to_string(),
        mcp_transport: mcp_transport.to_string(),
        hosted,
        egress_domains,
        recommended_for,
        install_allowed,
        enabled_by_default,
        allowed_roles,
        tools,
        json,
    })
}

fn validate_policy_combination(
    risk: &str,
    approval_policy: &str,
    approval_tier: &str,
) -> Checked<()> {
    match risk {
        "read" => {
            if approval_policy != "none" || approval_tier != "read_only" {
                return rejected("read tools must use none/read_only");
            }
        }
        "write" => {
            if !["require_approval", "always"].contains(&approval_policy)
                || !["workspace_write", "network_write"].contains(&approval_tier)
            {
                return rejected("write tools require approval and a write tier");
            }
        }
        "admin" => {
            if !["always", "deny"].contains(&approval_policy) || approval_tier != "network_write" {
                return rejected("admin tools must use always-or-deny/network_write");
            }
        }
        _ => return rejected("unknown tool risk"),
    }
    Ok(())
}

fn validate_input_schema(schema: &Object, path: &str) -> Checked<()> {
    let allowed_root = ["type", "properties", "required", "additionalProperties"];
    let properties = schema.get("properties").and_then(Value::as_object);
    let closed = schema
        .keys()
        .all(|key| allowed_root.contains(&key.as_str()))
        && schema.get("type").and_then(Value::as_str) == Some("object")
        && properties.is_some()
        && schema.get("additionalProperties") == Some(&Value::Bool(false));
    let Some(properties) = properties.filter(|_| closed) else {
        return rejected(format!("unknown or open tool schema at {path}"));
    };
    if let Some(required) = schema.get("required") {
        let valid = required.as_array().is_some_and(|values| {
            let names: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
            let unique: HashSet<&str> = names.iter().copied().collect();
            names.len() == values.len()
                && unique.len() == names.len()
                && names.iter().all(|name| properties.contains_key(*name))
        });
        if !valid {
            return rejected(format!("invalid required fields at {path}"));
        }
    }
    for (name, value) in properties {
        let Some(child) = value.as_object().filter(|_| !name.is_empty()) else {
            return rejected(format!("invalid tool property at {path}.properties"));
        };
        validate_property_schema(child, &format!("{path}.properties.{name}"))?;
    }
    Ok(())
}

fn validate_property_schema(schema: &Object, path: &str) -> Checked<()> {
    let allowed = [
        "type",
        "description",
        "enum",
        "items",
        "properties",
        "required",
        "additionalProperties",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
    ];
    let kind = schema.get("type").and_then(Value::as_str);
    let known_kind = kind.is_some_and(|kind| {
        ["string", "integer", "number", "boolean", "array", "object"].contains(&kind)
    });
    if !schema.keys().all(|key| allowed.contains(&key.as_str())) || !known_kind {
        return rejected(format!("unknown property schema at {path}"));
    }
    if let Some(description) = schema.get("description") {
        if !description.is_string() {
            return rejected(format!("invalid schema description at {path}"));
        }
    }
    if let Some(enumeration) = schema.get("enum") {
        let valid = enumeration.as_array().is_some_and(|values| {
            !values.is_empty()
                && values
                    .iter()
                    .all(|value| !value.is_object() && !value.is_array())
        });
        if !valid {
            return rejected(format!("invalid schema enum at {path}"));
        }
    }
    match kind {
        Some("object") => validate_input_schema(schema, path),
        Some("array") => match schema.get("items").and_then(Value::as_object) {
            Some(items) => validate_property_schema(items, &format!("{path}.items")),
            None => rejected(format!("array schema requires items at {path}")),
        },
        _ => {
            let container = ["items", "properties", "required", "additionalProperties"];
            if container.iter().any(|key| schema.contains_key(*key)) {
                return rejected(format!("scalar schema has container fields at {path}"));
            }
            Ok(())
        }
    }
}

fn reject_secret_like_keys(value: &Value, path: &str) -> Checked<()> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if is_secret_like_key(key) {
                    return rejected(format!(
                        "secret-like manifest field is forbidden at {path}.{key}"
                    ));
                }
                reject_secret_like_keys(child, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                reject_secret_like_keys(child, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Whether a JSON key names a credential-shaped field. Exposed so the route's
/// response tests apply the very same list to what leaves the server.
pub fn is_secret_like_key(key: &str) -> bool {
    let normalized = key.to_lowercase();
    FORBIDDEN_KEY_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
}

fn require_keys(object: &Object, expected: &[&str], path: &str) -> Checked<()> {
    let actual: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    let wanted: BTreeSet<&str> = expected.iter().copied().collect();
    if actual != wanted {
        return rejected(format!("unknown or missing field at {path}"));
    }
    Ok(())
}

fn object<'a>(object: &'a Object, key: &str, path: &str) -> Checked<&'a Object> {
    match object.get(key).and_then(Value::as_object) {
        Some(value) => Ok(value),
        None => rejected(format!("{path}.{key} must be an object")),
    }
}

fn array<'a>(object: &'a Object, key: &str, path: &str) -> Checked<&'a Vec<Value>> {
    match object.get(key).and_then(Value::as_array) {
        Some(value) => Ok(value),
        None => rejected(format!("{path}.{key} must be an array")),
    }
}

fn strings(object: &Object, key: &str, path: &str) -> Checked<Vec<String>> {
    array(object, key, path)?
        .iter()
        .map(|value| match value.as_str() {
            Some(text) => Ok(text.to_string()),
            None => rejected(format!("{path}.{key} must contain strings")),
        })
        .collect()
}

fn string<'a>(object: &'a Object, key: &str, path: &str) -> Checked<&'a str> {
    match object.get(key).and_then(Value::as_str) {
        Some(value) => Ok(value),
        None => rejected(format!("{path}.{key} must be a string")),
    }
}

fn boolean(object: &Object, key: &str, path: &str) -> Checked<bool> {
    match object.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        _ => rejected(format!("{path}.{key} must be a boolean")),
    }
}

fn nonempty<'a>(value: &'a str, label: &str) -> Checked<&'a str> {
    if value.trim().is_empty() {
        return rejected(format!("{label} must not be empty"));
    }
    Ok(value)
}

fn optional_https_url(object: &Object, key: &str, path: &str) -> Checked<Option<String>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if https_host(value).is_some() => Ok(Some(value.clone())),
        Some(_) => rejected(format!("{path}.{key} must be an HTTPS URL")),
    }
}

fn optional_icon_text(object: &Object, key: &str, path: &str) -> Checked<Option<String>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value))
            if value.trim() == value.as_str()
                && !value.is_empty()
                && value.chars().count() <= 8 =>
        {
            Ok(Some(value.clone()))
        }
        Some(_) => rejected(format!("{path}.{key} must be 1...8 display characters")),
    }
}

/// `^sha256:[0-9a-f]{64}$`
pub fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// `^[a-z0-9][a-z0-9._-]{2,127}$` — the registry `plugin_id` check constraint.
pub fn is_plugin_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=128).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(byte))
}

/// `^[a-z0-9][a-z0-9:._/-]{0,127}$` — the `plugin_grant.scope` check constraint.
pub fn is_scope(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b":._/-".contains(byte)
        })
}

/// `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`
pub fn is_egress_domain(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    let Some((tld, rest)) = labels.split_last() else {
        return false;
    };
    if rest.is_empty()
        || !(2..=63).contains(&tld.len())
        || !tld.bytes().all(|byte| byte.is_ascii_lowercase())
    {
        return false;
    }
    rest.iter().all(|label| {
        let bytes = label.as_bytes();
        (1..=63).contains(&bytes.len())
            && bytes
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
            && bytes[0] != b'-'
            && bytes[bytes.len() - 1] != b'-'
    })
}

/// The host of an absolute `https://` URL, or `None`. Stricter than a general
/// URL parser on purpose: no userinfo, no whitespace or control characters,
/// and a non-empty host made of DNS/IP characters.
pub fn https_host(value: &str) -> Option<&str> {
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return None;
    }
    let rest = value.strip_prefix("https://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        return None;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port))
            if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            host
        }
        Some(_) => return None,
        None => authority,
    };
    let valid = !host.is_empty()
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-');
    valid.then_some(host)
}

/// A hosted MCP endpoint is a same-origin absolute path:
/// `^/[A-Za-z0-9._~/-]+$`, not protocol-relative, no `..` segment.
pub fn is_hosted_endpoint_path(value: &str) -> bool {
    value.len() > 1
        && value.starts_with('/')
        && !value.starts_with("//")
        && value[1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~/-".contains(&byte))
        && !value.split('/').any(|segment| segment == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURES: [(&str, &str); 4] = [
        (
            "com.momo.plugins.github",
            include_str!("../../../../server/Fixtures/plugin-manifests/github.json"),
        ),
        (
            "com.momo.plugins.notion",
            include_str!("../../../../server/Fixtures/plugin-manifests/notion.json"),
        ),
        (
            "com.momo.plugins.linear",
            include_str!("../../../../server/Fixtures/plugin-manifests/linear.json"),
        ),
        (
            "com.momo.plugins.drive",
            include_str!("../../../../server/Fixtures/plugin-manifests/drive.json"),
        ),
    ];

    fn github() -> Value {
        serde_json::from_str(FIXTURES[0].1).expect("github fixture parses")
    }

    fn drive() -> Value {
        serde_json::from_str(FIXTURES[3].1).expect("drive fixture parses")
    }

    fn reason(value: &Value) -> String {
        validate_manifest(&value.to_string())
            .expect_err("manifest must be rejected")
            .0
    }

    fn digest_ok() -> &'static str {
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }

    /// The four official manifests are the canon (migrations 013/015/031/059
    /// seeded exactly these). If one fails, the port is wrong, not the fixture.
    #[test]
    fn every_official_fixture_is_admitted() {
        for (id, text) in FIXTURES {
            let manifest = validate_registry_manifest(id, text, digest_ok(), digest_ok())
                .unwrap_or_else(|error| panic!("{id} rejected: {error}"));
            assert_eq!(manifest.plugin_id, id);
            assert!(!manifest.tools.is_empty());
            assert!(manifest
                .tools
                .iter()
                .all(|tool| tool.risk == "read" && tool.approval_tier == "read_only"));
        }
        let drive = validate_manifest(FIXTURES[3].1).expect("drive admitted");
        assert!(drive.hosted, "drive is the momo-hosted path-C MCP");
        assert_eq!(drive.mcp_url, "/v1/mcp/drive");
    }

    // ---- the mismatch checks (each one is the only thing that refuses) ----

    #[test]
    fn a_digest_mismatch_is_refused() {
        let other = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let error = validate_registry_manifest(
            "com.momo.plugins.github",
            FIXTURES[0].1,
            digest_ok(),
            other,
        )
        .expect_err("expected ≠ computed");
        assert_eq!(error.0, "manifest digest mismatch");
        // A malformed declared digest is refused even when both sides agree.
        let error = validate_registry_manifest(
            "com.momo.plugins.github",
            FIXTURES[0].1,
            "sha256:XYZ",
            "sha256:XYZ",
        )
        .expect_err("malformed digest");
        assert_eq!(error.0, "manifest digest mismatch");
    }

    #[test]
    fn a_registry_id_that_differs_from_the_manifest_id_is_refused() {
        let error = validate_registry_manifest(
            "com.momo.plugins.notion",
            FIXTURES[0].1,
            digest_ok(),
            digest_ok(),
        )
        .expect_err("github manifest under the notion row");
        assert_eq!(error.0, "registry id does not match manifest");
    }

    #[test]
    fn approval_tier_must_map_exactly_the_declared_tools() {
        let mut extra = github();
        extra["momo"]["approvalTier"]["github.delete_everything"] = json!("read_only");
        assert_eq!(
            reason(&extra),
            "approvalTier must map exactly the declared tools"
        );
        let mut missing = github();
        missing["momo"]["approvalTier"]
            .as_object_mut()
            .expect("tier map")
            .remove("github.search_issues");
        assert_eq!(reason(&missing), "unknown or missing approval tier");
    }

    #[test]
    fn egress_must_include_the_mcp_endpoint_host() {
        let mut moved = github();
        moved["mcp"]["url"] = json!("https://evil.example.com/mcp/");
        assert_eq!(
            reason(&moved),
            "egressDomains must be unique domain names and include the MCP endpoint"
        );
        let mut duplicated = github();
        duplicated["momo"]["egressDomains"] =
            json!(["api.githubcopilot.com", "api.githubcopilot.com"]);
        assert_eq!(
            reason(&duplicated),
            "egressDomains must be unique domain names and include the MCP endpoint"
        );
    }

    #[test]
    fn a_tool_whose_risk_and_policy_disagree_is_refused() {
        let mut widened = github();
        widened["mcp"]["tools"][0]["approvalPolicy"] = json!("require_approval");
        assert_eq!(reason(&widened), "read tools must use none/read_only");
        let mut tier = github();
        tier["momo"]["approvalTier"]["github.list_repositories"] = json!("network_write");
        assert_eq!(reason(&tier), "read tools must use none/read_only");
    }

    // ---- custody A: no credential-shaped key anywhere ---------------------

    #[test]
    fn a_secret_like_key_anywhere_is_refused() {
        for (path, key) in [
            ("/plugin/publisher", "access_token"),
            ("/mcp/server", "clientSecret"),
            ("/mcp/server", "client_secret"),
            ("/momo/serverPolicy", "API_KEY"),
        ] {
            let mut manifest = github();
            manifest
                .pointer_mut(path)
                .and_then(Value::as_object_mut)
                .expect("object at path")
                .insert(key.to_string(), json!("x"));
            let error = reason(&manifest);
            if key == "clientSecret" {
                // Not in the fragment list — refused by the exact-key rule instead.
                assert!(error.starts_with("unknown or missing field"), "{error}");
            } else {
                assert!(
                    error.starts_with("secret-like manifest field is forbidden"),
                    "{key}: {error}"
                );
            }
        }
        // Inside an inputSchema the property names are free-form, so only the
        // fragment list stands between a schema and a credential parameter.
        let mut schema = github();
        schema["mcp"]["tools"][0]["inputSchema"]["properties"]["refresh_token"] =
            json!({"type": "string"});
        assert!(reason(&schema).starts_with("secret-like manifest field is forbidden"));
    }

    // ---- the rest of the admission table ----------------------------------

    #[test]
    fn exact_key_sets_refuse_unknown_and_missing_fields() {
        let mut unknown = github();
        unknown["plugin"]["homepage"] = json!("https://github.com");
        assert_eq!(reason(&unknown), "unknown or missing field at plugin");
        let mut missing = github();
        missing.as_object_mut().expect("root").remove("skill");
        assert_eq!(reason(&missing), "unknown or missing field at manifest");
        let mut momo = github();
        momo["momo"]["marketplace"] = json!(true);
        assert_eq!(reason(&momo), "unknown or missing field at momo");
    }

    #[test]
    fn vocabularies_are_allowlists() {
        let cases: Vec<(&str, Value, &str)> = vec![
            (
                "/schemaVersion",
                json!("momo.plugin.v2"),
                "unknown manifest schema",
            ),
            (
                "/mcp/protocolVersion",
                json!("2099-01-01"),
                "unknown MCP protocol",
            ),
            ("/mcp/transport", json!("stdio"), "unknown MCP transport"),
            (
                "/plugin/license/spdx",
                json!("AGPL-3.0"),
                "license is not admitted",
            ),
            (
                "/plugin/license/spdx",
                json!("GPL-2.0"),
                "license is not admitted",
            ),
            (
                "/plugin/license/kind",
                json!("proprietary"),
                "unknown license kind",
            ),
            ("/momo/risk", json!("extreme"), "unknown plugin risk"),
            ("/mcp/tools/0/risk", json!("root"), "unknown tool risk"),
            (
                "/mcp/tools/0/approvalPolicy",
                json!("maybe"),
                "unknown approval policy",
            ),
            (
                "/plugin/publisher/verified",
                json!(false),
                "publisher is not verified",
            ),
            (
                "/plugin/provenance/sourceURL",
                json!("http://github.com/github/github-mcp-server"),
                "publisher provenance is not verified HTTPS",
            ),
            ("/plugin/id", json!("Bad Id"), "invalid plugin id"),
            (
                "/mcp/url",
                json!("http://api.githubcopilot.com/mcp/"),
                "MCP endpoint must be HTTPS",
            ),
            (
                "/skill/optional",
                json!(false),
                "SKILL reference must remain optional in v1",
            ),
            (
                "/skill/reference",
                json!("http://x.example.com"),
                "SKILL reference must be null or HTTPS",
            ),
            (
                "/momo/serverPolicy/allowedRoles",
                json!(["member"]),
                "unknown serverPolicy role",
            ),
            (
                "/momo/recommendedFor",
                json!([]),
                "recommendedFor must not be empty",
            ),
            (
                "/mcp/tools/0/scopes",
                json!(["GitHub Read"]),
                "invalid tool scope",
            ),
            (
                "/mcp/tools/0/schemaDigest",
                json!("sha256:1"),
                "invalid tool schema digest",
            ),
        ];
        for (path, value, expected) in cases {
            let mut manifest = github();
            *manifest.pointer_mut(path).expect(path) = value;
            assert_eq!(reason(&manifest), expected, "{path}");
        }
    }

    #[test]
    fn tool_input_schemas_must_be_closed() {
        let mut open = github();
        open["mcp"]["tools"][0]["inputSchema"]["additionalProperties"] = json!(true);
        assert!(reason(&open).starts_with("unknown or open tool schema"));
        let mut required = github();
        required["mcp"]["tools"][0]["inputSchema"]["required"] = json!(["ghost"]);
        assert!(reason(&required).starts_with("invalid required fields"));
        let mut array = github();
        array["mcp"]["tools"][1]["inputSchema"]["properties"]["labels"] = json!({"type": "array"});
        assert!(reason(&array).starts_with("array schema requires items"));
        let mut scalar = github();
        scalar["mcp"]["tools"][1]["inputSchema"]["properties"]["query"]["items"] =
            json!({"type": "string"});
        assert!(reason(&scalar).starts_with("scalar schema has container fields"));
        let mut duplicate = github();
        let first = duplicate["mcp"]["tools"][0].clone();
        duplicate["mcp"]["tools"][1] = first;
        assert_eq!(reason(&duplicate), "duplicate tool name");
    }

    #[test]
    fn a_hosted_endpoint_must_stay_a_same_origin_path() {
        for bad in [
            "https://evil.example.com/mcp",
            "//evil.example.com/mcp",
            "/v1/../admin",
            "/v1/mcp?x=1",
        ] {
            let mut manifest = drive();
            manifest["mcp"]["url"] = json!(bad);
            assert_eq!(
                reason(&manifest),
                "hosted MCP endpoint must be an absolute path",
                "{bad}"
            );
        }
        let mut flag = drive();
        flag["momo"]["hosted"] = json!("yes");
        assert_eq!(reason(&flag), "momo.hosted must be a boolean");
    }

    #[test]
    fn optional_display_metadata_is_https_and_short() {
        let mut display = github();
        display["plugin"]["termsURL"] = json!("https://publisher.example/terms");
        display["plugin"]["privacyPolicyURL"] = json!("https://publisher.example/privacy");
        display["plugin"]["iconText"] = json!("GH");
        let manifest = validate_manifest(&display.to_string()).expect("display metadata");
        assert_eq!(
            manifest.terms_url.as_deref(),
            Some("https://publisher.example/terms")
        );
        assert_eq!(manifest.icon_text.as_deref(), Some("GH"));
        let mut script = github();
        script["plugin"]["termsURL"] = json!("javascript:alert(1)");
        assert_eq!(reason(&script), "plugin.termsURL must be an HTTPS URL");
        let mut long = github();
        long["plugin"]["iconText"] = json!("ABCDEFGHI");
        assert_eq!(
            reason(&long),
            "plugin.iconText must be 1...8 display characters"
        );
    }

    #[test]
    fn character_class_helpers_match_their_regexes() {
        assert!(is_plugin_id("com.momo.plugins.github"));
        assert!(!is_plugin_id("ab"));
        assert!(!is_plugin_id("-abc"));
        assert!(!is_plugin_id("com.momo.Plugins"));
        assert!(is_scope("github:read"));
        assert!(!is_scope(":read"));
        assert!(is_egress_domain("api.githubcopilot.com"));
        assert!(!is_egress_domain("localhost"));
        assert!(!is_egress_domain("-bad.example.com"));
        assert!(!is_egress_domain("API.example.com"));
        assert_eq!(
            https_host("https://mcp.notion.com/mcp"),
            Some("mcp.notion.com")
        );
        assert_eq!(
            https_host("https://host.example:8443/x"),
            Some("host.example")
        );
        assert_eq!(https_host("https://user@host.example/"), None);
        assert_eq!(https_host("https:///path"), None);
        assert_eq!(https_host("https://host .example/"), None);
        assert!(is_sha256_digest(digest_ok()));
        assert!(!is_sha256_digest("sha256:AAAA"));
        assert!(is_secret_like_key("X_Access_Token"));
        assert!(!is_secret_like_key("query"));
    }
}
