//! The Agent Port tool catalog (ADR-0162 D3/D6, HAP-E5) — protocol only.
//!
//! Eight thin-binding tools, each one name plus one required scope plus one
//! bounded input schema. **No product logic and no database lives here**: the
//! server adapter injects a typed domain port and this module decides only what
//! a given credential may see and call, and what a result or a failure looks
//! like on the wire.
//!
//! ## One mapping, two questions
//!
//! `tools/list` and `tools/call` must never disagree about what a credential may
//! reach — a tool that is invisible but callable is a privilege escalation, and
//! a tool that is visible but uncallable is a support ticket. Both questions are
//! therefore answered by the same [`ToolView`], built once per request from the
//! same three inputs:
//!
//! 1. the **connection's** approved scopes (what a human confirmed),
//! 2. the **token's** current scopes (what the credential still carries), and
//! 3. the server's own [`ToolCapability`] (what this build actually serves).
//!
//! The intersection is fail-closed at every axis: a scope that a human approved
//! but the token no longer carries opens nothing, and neither does the reverse.
//!
//! ## `agent:port:connect` opens zero product tools
//!
//! Reachability and capability are different grants. The connect scope is what
//! makes `POST /v1/mcp/agent-port` answer at all; it appears in no tool's
//! `required_scope`, so a connect-only credential lists an empty catalog and
//! calls nothing.

use serde_json::{json, Value};

/// One tool's complete protocol identity.
#[derive(Debug, Clone, Copy)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// The single non-default scope that opens this tool. Never
    /// `agent:port:connect` — see the module docs.
    pub required_scope: &'static str,
    schema: fn() -> Value,
}

/// Identity is the **name**, not the struct's bytes: a descriptor holds a
/// function pointer whose address is not a meaningful value to compare, and the
/// catalog's names are unique by construction (pinned below).
impl PartialEq for ToolDescriptor {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl Eq for ToolDescriptor {}

impl ToolDescriptor {
    /// The tool's published input schema — the same object `tools/list`
    /// advertises and the same object [`validate_arguments`] enforces.
    pub fn input_schema(&self) -> Value {
        (self.schema)()
    }

    /// The MCP `tools/list` entry for this tool.
    pub fn listing(&self) -> Value {
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": (self.schema)(),
        })
    }
}

pub const TOOL_INBOX_READ: &str = "oort_inbox_read";
pub const TOOL_CONVERSATION_READ: &str = "oort_conversation_read";
pub const TOOL_MESSAGE_POST: &str = "oort_message_post";
pub const TOOL_JOBS_CLAIM: &str = "oort_jobs_claim";
pub const TOOL_JOB_RENEW: &str = "oort_job_renew";
pub const TOOL_JOB_RELEASE: &str = "oort_job_release";
pub const TOOL_RUN_EVENT: &str = "oort_run_event";
pub const TOOL_RUN_COMPLETE: &str = "oort_run_complete";

pub const SCOPE_PORT_CONNECT: &str = "agent:port:connect";
pub const SCOPE_INBOX_READ: &str = "agent:inbox:read";
pub const SCOPE_MESSAGES_READ: &str = "messages:read";
pub const SCOPE_MESSAGES_WRITE: &str = "messages:write";
pub const SCOPE_JOBS_READ: &str = "agent:jobs:read";
pub const SCOPE_RUNS_CALLBACK: &str = "agent:runs:callback";

/// The note every length-bounded string carries.
///
/// The bound is **bytes**, not characters, because the domain ceilings it
/// mirrors are byte ceilings. Saying so in the schema is the difference between
/// a client that can predict a refusal and one that discovers it: 3,000 emoji
/// are 3,000 characters and 12,000 bytes.
const BYTE_BOUND_NOTE: &str = "Length bounds count UTF-8 bytes, not characters.";

/// The **nullability contract**, in one function.
///
/// Every optional property is declared `["<type>", "null"]` and every required
/// one is not. That is not decoration: the adapter's readers treat a `null` as
/// an omitted value for every optional field, uniformly, so the schema has to
/// say that or it is describing a different program. A required field is never
/// nullable, and `null` there is refused exactly like an absent key.
///
/// [`the_nullability_contract_holds_for_every_tool`] checks the correspondence
/// mechanically, so a future property cannot be added on one side only.
fn nullable(schema: Value) -> Value {
    let mut schema = schema;
    let declared = schema
        .get("type")
        .and_then(Value::as_str)
        .expect("a nullable property starts from a single declared type")
        .to_owned();
    schema
        .as_object_mut()
        .expect("property schemas are objects")
        .insert("type".into(), json!([declared, "null"]));
    schema
}

fn uuid_property() -> Value {
    json!({"type": "string", "format": "uuid"})
}

/// A length-bounded string, with the byte semantics spelled out.
fn text(max_bytes: u64) -> Value {
    json!({"type": "string", "maxLength": max_bytes, "description": BYTE_BOUND_NOTE})
}

/// A non-empty length-bounded string.
fn required_text(max_bytes: u64) -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": max_bytes,
        "description": BYTE_BOUND_NOTE
    })
}

fn integer(minimum: i64, maximum: i64) -> Value {
    json!({"type": "integer", "minimum": minimum, "maximum": maximum})
}

/// The ledger column a reported token count is narrowed to. Declaring it means
/// the schema refuses exactly what the narrowing would have refused.
const MAX_TOKEN_COUNT: i64 = i32::MAX as i64;

fn token_count() -> Value {
    nullable(integer(0, MAX_TOKEN_COUNT))
}

fn inbox_read_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "cursor": nullable(text(256)),
            "limit": nullable(integer(1, 100))
        }
    })
}

fn conversation_read_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["channelId"],
        "properties": {
            "channelId": uuid_property(),
            "before": nullable(integer(1, i64::MAX)),
            "after": nullable(integer(0, i64::MAX)),
            "limit": nullable(integer(1, 200))
        }
    })
}

fn message_post_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["channelId", "clientMsgId", "body"],
        "properties": {
            "channelId": uuid_property(),
            "clientMsgId": uuid_property(),
            "body": required_text(8_000),
            "rootId": nullable(uuid_property()),
            "replyToId": nullable(uuid_property())
        }
    })
}

fn jobs_claim_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "limit": nullable(integer(1, 100))
        }
    })
}

fn lease_only_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["leaseHandle"],
        "properties": {
            "leaseHandle": required_text(512)
        }
    })
}

fn run_event_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["leaseHandle"],
        "properties": {
            "leaseHandle": required_text(512),
            "status": nullable(json!({
                "type": "string",
                "enum": ["running", "thinking", "streaming", "cancelled"]
            })),
            "detail": nullable(text(2_048)),
            "textDelta": nullable(text(8_192)),
            "eventId": nullable(uuid_property())
        }
    })
}

fn run_complete_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["leaseHandle", "status"],
        "properties": {
            "leaseHandle": required_text(512),
            "status": {"type": "string", "enum": ["succeeded", "failed"]},
            "body": nullable(text(8_000)),
            "error": nullable(text(4_000)),
            "usage": nullable(json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "model": nullable(text(128)),
                    "effort": nullable(text(32)),
                    "promptTokens": token_count(),
                    "completionTokens": token_count(),
                    "cachedTokens": token_count(),
                    "reasoningTokens": token_count()
                }
            }))
        }
    })
}

/// The complete catalog. Order is the `tools/list` order and is stable so a
/// client diffing two listings sees only real capability changes.
pub const TOOL_CATALOG: [ToolDescriptor; 8] = [
    ToolDescriptor {
        name: TOOL_INBOX_READ,
        title: "Read the hosted inbox",
        description:
            "Read the next page of this connection's durable inbox using its opaque cursor.",
        required_scope: SCOPE_INBOX_READ,
        schema: inbox_read_schema,
    },
    ToolDescriptor {
        name: TOOL_CONVERSATION_READ,
        title: "Read a conversation",
        description: "Read one page of an approved channel's message history.",
        required_scope: SCOPE_MESSAGES_READ,
        schema: conversation_read_schema,
    },
    ToolDescriptor {
        name: TOOL_MESSAGE_POST,
        title: "Post a message",
        description: "Post one message into an approved channel through the canonical send path.",
        required_scope: SCOPE_MESSAGES_WRITE,
        schema: message_post_schema,
    },
    ToolDescriptor {
        name: TOOL_JOBS_CLAIM,
        title: "Claim pending jobs",
        description: "Claim pending work for this agent, each with an opaque lease handle.",
        required_scope: SCOPE_JOBS_READ,
        schema: jobs_claim_schema,
    },
    ToolDescriptor {
        name: TOOL_JOB_RENEW,
        title: "Renew a job lease",
        description: "Extend a lease this connection already holds.",
        required_scope: SCOPE_JOBS_READ,
        schema: lease_only_schema,
    },
    ToolDescriptor {
        name: TOOL_JOB_RELEASE,
        title: "Release a job lease",
        description: "Hand a claimed job back immediately instead of waiting out its expiry.",
        required_scope: SCOPE_JOBS_READ,
        schema: lease_only_schema,
    },
    ToolDescriptor {
        name: TOOL_RUN_EVENT,
        title: "Report run progress",
        description: "Record a progress event for the run this lease owns.",
        required_scope: SCOPE_RUNS_CALLBACK,
        schema: run_event_schema,
    },
    ToolDescriptor {
        name: TOOL_RUN_COMPLETE,
        title: "Complete a run",
        description: "Deliver the final answer and settle the run this lease owns.",
        required_scope: SCOPE_RUNS_CALLBACK,
        schema: run_complete_schema,
    },
];

/// What this server build is able to serve, independent of any credential.
///
/// A separate axis from the credential's scopes so a deployment can withdraw a
/// tool without re-minting anyone's grant, and so an operator's answer to "is
/// this tool served here" is one value rather than a scan of the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolCapability {
    served: &'static [&'static str],
}

impl ToolCapability {
    /// Every tool in [`TOOL_CATALOG`].
    pub const FULL: ToolCapability = ToolCapability {
        served: &[
            TOOL_INBOX_READ,
            TOOL_CONVERSATION_READ,
            TOOL_MESSAGE_POST,
            TOOL_JOBS_CLAIM,
            TOOL_JOB_RENEW,
            TOOL_JOB_RELEASE,
            TOOL_RUN_EVENT,
            TOOL_RUN_COMPLETE,
        ],
    };

    /// No tool at all — what an inactive or unproven connection sees.
    pub const NONE: ToolCapability = ToolCapability { served: &[] };

    pub fn serves(&self, name: &str) -> bool {
        self.served.contains(&name)
    }
}

/// The tools one authenticated request may see **and** call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolView {
    visible: Vec<&'static ToolDescriptor>,
}

impl ToolView {
    /// The empty view: no product tool is listed and none is callable.
    pub fn empty() -> ToolView {
        ToolView {
            visible: Vec::new(),
        }
    }

    /// Intersect the connection's approved scopes, the token's current scopes
    /// and the server capability.
    ///
    /// Both scope lists are required to carry a tool's scope. A human's approval
    /// that the credential no longer carries is stale authority; a credential
    /// scope no human approved is unapproved authority. Neither opens a tool.
    pub fn intersect(
        approved_scopes: &[String],
        token_scopes: &[String],
        capability: ToolCapability,
    ) -> ToolView {
        let visible = TOOL_CATALOG
            .iter()
            .filter(|tool| {
                capability.serves(tool.name)
                    && has_scope(approved_scopes, tool.required_scope)
                    && has_scope(token_scopes, tool.required_scope)
            })
            .collect();
        ToolView { visible }
    }

    /// The descriptor for `name`, but only when this view may call it. An
    /// unknown name and a name outside the view are the same answer, so the
    /// catalog cannot be enumerated by trying calls.
    pub fn callable(&self, name: &str) -> Option<&'static ToolDescriptor> {
        self.visible.iter().copied().find(|tool| tool.name == name)
    }

    pub fn is_empty(&self) -> bool {
        self.visible.is_empty()
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.visible.iter().map(|tool| tool.name).collect()
    }

    /// The `tools` array of a `tools/list` result.
    pub fn listing(&self) -> Value {
        Value::Array(self.visible.iter().map(|tool| tool.listing()).collect())
    }
}

fn has_scope(scopes: &[String], required: &str) -> bool {
    scopes.iter().any(|scope| scope == required)
}

/// Enforce a tool's **published** schema against the arguments it was called
/// with, so what the catalog advertises and what execution accepts are one
/// thing rather than two that agree today.
///
/// The motivating bug is quiet rather than loud: `oort_message_post` declares
/// `rootId`, a client sends `rootID`, and a lenient reader posts an unthreaded
/// message while the caller believes it opened a thread. `additionalProperties:
/// false` was already published; this is what makes it true.
///
/// Deliberately a small subset of JSON Schema — exactly the keywords
/// [`TOOL_CATALOG`] uses (`type`, `required`, `properties`,
/// `additionalProperties: false`, `enum`, `minimum`/`maximum`,
/// `minLength`/`maxLength`, `format: uuid`) — because a general validator would
/// be a second implementation of a standard, and every keyword it supported but
/// the catalog never used would be untested surface.
///
/// Every violation is the one [`ToolFailure::InvalidArguments`], never a
/// per-cause code: which rule a call broke is not something an unauthorized
/// caller should be able to enumerate.
pub fn validate_arguments(tool: &ToolDescriptor, arguments: &Value) -> Result<(), ToolFailure> {
    validate_against(&tool.input_schema(), arguments)
}

/// The declared types of one property: `"string"` or `["string", "null"]`.
///
/// A missing or malformed `type` yields an empty set, which every value then
/// fails — an unvalidatable schema must not become an unvalidated one.
fn declared_types(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(single)) => vec![single.as_str()],
        Some(Value::Array(many)) => many.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn validate_against(schema: &Value, value: &Value) -> Result<(), ToolFailure> {
    let invalid = ToolFailure::InvalidArguments;
    let types = declared_types(schema);
    // `null` is accepted only where the schema says so — which, by the
    // nullability contract above, is exactly the optional properties whose
    // readers treat it as absent.
    if value.is_null() {
        return if types.contains(&"null") {
            Ok(())
        } else {
            Err(invalid)
        };
    }
    // Exactly one non-null type per property in this catalog; pick it rather
    // than trying every branch, so an unexpected union fails closed.
    let concrete: Vec<&str> = types
        .iter()
        .copied()
        .filter(|kind| *kind != "null")
        .collect();
    match concrete.first().filter(|_| concrete.len() == 1).copied() {
        Some("object") => {
            let object = value.as_object().ok_or(invalid)?;
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .ok_or(invalid)?;
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                for key in object.keys() {
                    if !properties.contains_key(key) {
                        return Err(invalid);
                    }
                }
            }
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for name in required {
                    let name = name.as_str().ok_or(invalid)?;
                    // A required key present as `null` is absent: the catalog
                    // never declares a nullable required field.
                    if !matches!(object.get(name), Some(present) if !present.is_null()) {
                        return Err(invalid);
                    }
                }
            }
            for (key, property) in properties {
                // An absent optional key is fine; a present one — including a
                // present `null` — is validated against its own schema, which
                // is where the nullability contract is actually applied.
                if let Some(present) = object.get(key) {
                    validate_against(property, present)?;
                }
            }
            Ok(())
        }
        Some("string") => {
            let text = value.as_str().ok_or(invalid)?;
            // **Bytes, not characters** — the ceilings these mirror are byte
            // ceilings in the domain, so counting characters here would admit
            // a 3,000-emoji body that the adapter then refuses at 12,000 bytes.
            // Both layers now refuse at the same boundary. `BYTE_BOUND_NOTE`
            // is what tells a client which unit it is being measured in.
            let length = text.len() as u64;
            if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
                if length < min {
                    return Err(invalid);
                }
            }
            if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
                if length > max {
                    return Err(invalid);
                }
            }
            if schema.get("format").and_then(Value::as_str) == Some("uuid") && !is_uuid_shaped(text)
            {
                return Err(invalid);
            }
            if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
                if !allowed.iter().any(|candidate| candidate == value) {
                    return Err(invalid);
                }
            }
            Ok(())
        }
        Some("integer") => {
            // `as_i64` also rejects a fractional or float-shaped number, which
            // `integer` forbids and a lenient reader would have truncated.
            let number = value.as_i64().filter(|_| value.is_i64()).ok_or(invalid)?;
            if let Some(min) = schema.get("minimum").and_then(Value::as_i64) {
                if number < min {
                    return Err(invalid);
                }
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_i64) {
                if number > max {
                    return Err(invalid);
                }
            }
            Ok(())
        }
        // No catalog schema uses another type; refusing rather than passing
        // keeps an unvalidated shape from ever reaching a domain port.
        _ => Err(invalid),
    }
}

/// The canonical hyphenated uuid shape, case-insensitive. Purely lexical — the
/// adapter still parses the value, and this only stops a wrong shape from
/// reaching it.
fn is_uuid_shaped(value: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let mut parts = value.split('-');
    for expected in groups {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected || !part.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

/// The closed set of tool failures that may cross the wire.
///
/// Deliberately coarse. A hosted adapter must be able to tell "retry later" from
/// "you may not do this" from "your input was wrong", and nothing finer: a
/// per-cause message would let a caller distinguish "that channel does not
/// exist" from "you are not a member of it", which is exactly the enumeration
/// the fail-closed reads refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolFailure {
    /// The arguments did not satisfy the tool's schema.
    InvalidArguments,
    /// The connection, scope, membership or actor binding refused the call.
    NotAuthorized,
    /// The target is not reachable right now — paused, inactive, missing, or
    /// invisible. One answer for all four, on purpose.
    Unavailable,
    /// The target exists and refused the requested transition (a settled run, a
    /// lost lease, an already-terminal state).
    Conflict,
    /// The server failed. Never carries a cause.
    Internal,
}

impl ToolFailure {
    /// `(http status, json-rpc code, wire message)`.
    pub fn wire(self) -> (u16, i64, &'static str) {
        match self {
            ToolFailure::InvalidArguments => (400, -32602, "invalid tool arguments"),
            ToolFailure::NotAuthorized => {
                (403, -32003, "tool is not authorized for this connection")
            }
            ToolFailure::Unavailable => (409, -32004, "tool target is unavailable"),
            ToolFailure::Conflict => (409, -32005, "tool target refused the transition"),
            ToolFailure::Internal => (500, -32603, "internal error"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scopes(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_catalog_is_exactly_the_eight_named_tools() {
        assert_eq!(
            TOOL_CATALOG.iter().map(|t| t.name).collect::<Vec<_>>(),
            vec![
                "oort_inbox_read",
                "oort_conversation_read",
                "oort_message_post",
                "oort_jobs_claim",
                "oort_job_renew",
                "oort_job_release",
                "oort_run_event",
                "oort_run_complete",
            ]
        );
    }

    /// The whole point of the connect scope: it is reachability, not capability.
    #[test]
    fn connect_alone_opens_no_product_tool() {
        let connect = scopes(&[SCOPE_PORT_CONNECT]);
        let view = ToolView::intersect(&connect, &connect, ToolCapability::FULL);
        assert!(view.is_empty());
        assert_eq!(view.listing(), json!([]));
        for tool in TOOL_CATALOG.iter() {
            assert_ne!(tool.required_scope, SCOPE_PORT_CONNECT, "{}", tool.name);
            assert!(view.callable(tool.name).is_none(), "{}", tool.name);
        }
    }

    #[test]
    fn the_scope_mapping_is_the_issue_table() {
        let all = scopes(&[
            SCOPE_PORT_CONNECT,
            SCOPE_INBOX_READ,
            SCOPE_MESSAGES_READ,
            SCOPE_MESSAGES_WRITE,
            SCOPE_JOBS_READ,
            SCOPE_RUNS_CALLBACK,
        ]);
        let view = ToolView::intersect(&all, &all, ToolCapability::FULL);
        assert_eq!(view.names().len(), 8);
        for (name, scope) in [
            (TOOL_INBOX_READ, SCOPE_INBOX_READ),
            (TOOL_CONVERSATION_READ, SCOPE_MESSAGES_READ),
            (TOOL_MESSAGE_POST, SCOPE_MESSAGES_WRITE),
            (TOOL_JOBS_CLAIM, SCOPE_JOBS_READ),
            (TOOL_JOB_RENEW, SCOPE_JOBS_READ),
            (TOOL_JOB_RELEASE, SCOPE_JOBS_READ),
            (TOOL_RUN_EVENT, SCOPE_RUNS_CALLBACK),
            (TOOL_RUN_COMPLETE, SCOPE_RUNS_CALLBACK),
        ] {
            assert_eq!(view.callable(name).expect(name).required_scope, scope);
        }
    }

    /// Both scope lists are required, and the failure is symmetric: a stale
    /// approval and an unapproved credential scope each open nothing.
    #[test]
    fn either_half_of_the_intersection_can_close_a_tool() {
        let approved = scopes(&[SCOPE_PORT_CONNECT, SCOPE_MESSAGES_WRITE]);
        let token = scopes(&[SCOPE_PORT_CONNECT]);
        assert!(ToolView::intersect(&approved, &token, ToolCapability::FULL).is_empty());
        assert!(ToolView::intersect(&token, &approved, ToolCapability::FULL).is_empty());
        assert_eq!(
            ToolView::intersect(&approved, &approved, ToolCapability::FULL).names(),
            vec![TOOL_MESSAGE_POST]
        );
    }

    #[test]
    fn a_withdrawn_server_capability_closes_a_fully_scoped_tool() {
        let approved = scopes(&[SCOPE_PORT_CONNECT, SCOPE_MESSAGES_WRITE]);
        let view = ToolView::intersect(&approved, &approved, ToolCapability::NONE);
        assert!(view.is_empty());
        assert!(view.callable(TOOL_MESSAGE_POST).is_none());
    }

    /// A tool outside the view and a tool that does not exist must be the same
    /// answer — otherwise `tools/call` enumerates the catalog.
    #[test]
    fn an_invisible_tool_and_an_unknown_tool_answer_alike() {
        let connect = scopes(&[SCOPE_PORT_CONNECT]);
        let view = ToolView::intersect(&connect, &connect, ToolCapability::FULL);
        assert_eq!(view.callable(TOOL_MESSAGE_POST), view.callable("oort_nope"));
    }

    #[test]
    fn every_catalog_name_is_unique() {
        let mut names = TOOL_CATALOG.iter().map(|t| t.name).collect::<Vec<_>>();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "descriptor identity is the name");
    }

    #[test]
    fn every_schema_is_a_closed_object() {
        for tool in TOOL_CATALOG.iter() {
            let schema = tool.input_schema();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert_eq!(schema["additionalProperties"], false, "{}", tool.name);
        }
    }

    /// **The nullability contract, checked mechanically for all eight tools.**
    ///
    /// Optional property ⇔ declared nullable. The adapter's readers treat a
    /// `null` as an omitted value for every optional field, so a schema that
    /// disagreed on any one of them would be describing a different program —
    /// and a future property added on one side only fails here rather than in
    /// production.
    #[test]
    fn the_nullability_contract_holds_for_every_tool() {
        fn walk(name: &str, schema: &Value) {
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let properties = schema["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{name} declares properties"));
            for (key, property) in properties {
                let nullable = declared_types(property).contains(&"null");
                assert_eq!(
                    nullable,
                    !required.contains(&key.as_str()),
                    "{name}.{key}: optional ⇔ nullable"
                );
                if declared_types(property).contains(&"object") {
                    walk(&format!("{name}.{key}"), property);
                }
            }
        }
        for tool in TOOL_CATALOG.iter() {
            walk(tool.name, &tool.input_schema());
        }
    }

    /// Every length bound says which unit it counts, because the answer is not
    /// the one a JSON Schema reader would assume.
    #[test]
    fn every_length_bound_declares_its_unit() {
        fn walk(name: &str, schema: &Value) {
            let Some(properties) = schema["properties"].as_object() else {
                return;
            };
            for (key, property) in properties {
                if property.get("maxLength").is_some() || property.get("minLength").is_some() {
                    assert_eq!(
                        property.get("description").and_then(Value::as_str),
                        Some(BYTE_BOUND_NOTE),
                        "{name}.{key} bounds a string without saying it counts bytes"
                    );
                }
                if declared_types(property).contains(&"object") {
                    walk(&format!("{name}.{key}"), property);
                }
            }
        }
        for tool in TOOL_CATALOG.iter() {
            walk(tool.name, &tool.input_schema());
        }
    }

    /// A `null` is accepted exactly where the schema declares it and nowhere
    /// else — including inside the nested usage object.
    #[test]
    fn null_is_accepted_only_where_it_is_declared() {
        let post = TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == TOOL_MESSAGE_POST)
            .expect("catalog");
        let mut arguments = json!({
            "channelId": "5b1f4a2e-0000-4000-8000-000000000001",
            "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
            "body": "hello"
        });
        arguments["rootId"] = Value::Null;
        assert!(
            validate_arguments(post, &arguments).is_ok(),
            "an optional field is declared nullable, so null means absent"
        );
        arguments["body"] = Value::Null;
        assert_eq!(
            validate_arguments(post, &arguments),
            Err(ToolFailure::InvalidArguments),
            "a required field is not nullable"
        );

        let complete = TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == TOOL_RUN_COMPLETE)
            .expect("catalog");
        assert!(validate_arguments(
            complete,
            &json!({"leaseHandle": "x", "status": "succeeded", "usage": Value::Null})
        )
        .is_ok());
        assert!(validate_arguments(
            complete,
            &json!({"leaseHandle": "x", "status": "succeeded",
                    "usage": {"promptTokens": Value::Null}})
        )
        .is_ok());
        assert_eq!(
            validate_arguments(
                complete,
                &json!({"leaseHandle": "x", "status": Value::Null})
            ),
            Err(ToolFailure::InvalidArguments)
        );
    }

    /// **A string is measured in bytes at the validator, like the domain.**
    ///
    /// The regression: 3,000 emoji are 3,000 characters and 12,000 bytes, so a
    /// character count let a body through the schema that the adapter then
    /// refused — two layers disagreeing about the same published number.
    #[test]
    fn string_bounds_are_counted_in_bytes() {
        let post = TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == TOOL_MESSAGE_POST)
            .expect("catalog");
        let arguments = |body: String| {
            json!({
                "channelId": "5b1f4a2e-0000-4000-8000-000000000001",
                "clientMsgId": "5b1f4a2e-0000-4000-8000-000000000002",
                "body": body
            })
        };
        // 3,000 emoji: well under the 8,000 *character* reading, well over the
        // 8,000 *byte* one this schema means.
        let emoji = "\u{1F600}".repeat(3_000);
        assert_eq!(emoji.chars().count(), 3_000);
        assert_eq!(emoji.len(), 12_000);
        assert_eq!(
            validate_arguments(post, &arguments(emoji)),
            Err(ToolFailure::InvalidArguments)
        );
        // Exactly at the ceiling in bytes is still accepted.
        assert!(validate_arguments(post, &arguments("a".repeat(8_000))).is_ok());
        assert_eq!(
            validate_arguments(post, &arguments("a".repeat(8_001))),
            Err(ToolFailure::InvalidArguments)
        );
    }

    /// The token ceiling the ledger's `i32` column implies is declared, so the
    /// schema refuses exactly what the narrowing would have refused.
    #[test]
    fn token_counts_declare_the_ledger_column_ceiling() {
        let complete = TOOL_CATALOG
            .iter()
            .find(|tool| tool.name == TOOL_RUN_COMPLETE)
            .expect("catalog");
        let usage = |value: i64| {
            json!({"leaseHandle": "x", "status": "succeeded",
                   "usage": {"promptTokens": value}})
        };
        assert!(validate_arguments(complete, &usage(MAX_TOKEN_COUNT)).is_ok());
        for out_of_range in [MAX_TOKEN_COUNT + 1, -1] {
            assert_eq!(
                validate_arguments(complete, &usage(out_of_range)),
                Err(ToolFailure::InvalidArguments),
                "{out_of_range}"
            );
        }
        for field in [
            "promptTokens",
            "completionTokens",
            "cachedTokens",
            "reasoningTokens",
        ] {
            let schema = complete.input_schema();
            let property = &schema["properties"]["usage"]["properties"][field];
            assert_eq!(property["minimum"], json!(0), "{field}");
            assert_eq!(property["maximum"], json!(MAX_TOKEN_COUNT), "{field}");
        }
    }

    #[test]
    fn no_failure_message_carries_a_cause() {
        for failure in [
            ToolFailure::InvalidArguments,
            ToolFailure::NotAuthorized,
            ToolFailure::Unavailable,
            ToolFailure::Conflict,
            ToolFailure::Internal,
        ] {
            let (status, code, message) = failure.wire();
            assert!((400..=599).contains(&status));
            assert!(code < 0);
            assert!(!message.is_empty());
            assert!(message.is_ascii());
        }
    }
}
