//! Native JSON and Slack-compatible payload rendering (Swift `WebhookPayload`).
//!
//! Parsing lives here so the HTTP layer can verify a signature (or URL token)
//! and short-circuit a replay **before** this module runs. A handler that
//! deserializes first is the sabotage the inbound conformance suite measures.

use std::collections::BTreeMap;

use serde_json::Value;

/// ADR-0115 D4 / OpenAPI: 256 KiB.
pub const MAXIMUM_BODY_BYTES: usize = 256 * 1024;
/// OpenAPI `NativeWebhookPayload.text` / Swift `maximumMessageCharacters`.
pub const MAXIMUM_MESSAGE_CHARACTERS: usize = 40_000;
const MAXIMUM_ATTACHMENTS: usize = 20;
const MAXIMUM_FIELDS_PER_ATTACHMENT: usize = 20;

/// Rendered channel text plus the client-owned props the receipt write merges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedMessage {
    pub body: String,
    pub client_props: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadError {
    pub message: String,
}

impl PayloadError {
    fn new(message: impl Into<String>) -> Self {
        PayloadError {
            message: message.into(),
        }
    }
}

/// Native payload v1: `{ "text": "...", "event_type"?: "...", "metadata"?: {} }`.
/// Unknown keys fail closed.
pub fn parse_native(data: &[u8]) -> Result<RenderedMessage, PayloadError> {
    let object = json_object(data)?;
    let allowed = ["text", "event_type", "metadata"];
    let unsupported: Vec<&str> = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unsupported.is_empty() {
        return Err(PayloadError::new(format!(
            "unsupported native field(s): {}",
            unsupported.join(", ")
        )));
    }
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| PayloadError::new("native webhook payload requires text"))?;
    let body = bounded_text(text, "native webhook text")?;
    let mut props = BTreeMap::new();
    if let Some(event_type) = object.get("event_type") {
        let event_type = event_type
            .as_str()
            .filter(|value| !value.is_empty() && value.chars().count() <= 120);
        let Some(event_type) = event_type else {
            return Err(PayloadError::new(
                "native event_type must contain 1...120 characters",
            ));
        };
        props.insert("event_type".to_string(), event_type.to_string());
    }
    if let Some(raw_metadata) = object.get("metadata") {
        let metadata = raw_metadata.as_object().filter(|map| map.len() <= 32);
        let Some(metadata) = metadata else {
            return Err(PayloadError::new(
                "native metadata must be an object with at most 32 entries",
            ));
        };
        for (key, raw_value) in metadata {
            let value = raw_value
                .as_str()
                .filter(|value| value.chars().count() <= 1_000);
            if !valid_metadata_key(key) || value.is_none() {
                return Err(PayloadError::new(
                    "native metadata must contain bounded string keys and values",
                ));
            }
            props.insert(
                format!("metadata.{key}"),
                value.expect("checked").to_string(),
            );
        }
    }
    Ok(RenderedMessage {
        body,
        client_props: props,
    })
}

/// Slack-compatible v0: `text` + legacy `attachments`. `blocks` is a hard 400.
pub fn parse_slack_compatible(data: &[u8]) -> Result<RenderedMessage, PayloadError> {
    let root = json_object(data)?;
    if root.contains_key("blocks") {
        return Err(PayloadError::new(
            "Slack-compatible blocks are not supported in v0; use text and legacy attachments",
        ));
    }

    let mut sections: Vec<String> = Vec::new();
    if let Some(raw_text) = root.get("text") {
        let text = raw_text
            .as_str()
            .ok_or_else(|| PayloadError::new("Slack-compatible text must be a string"))?;
        let translated = translate_slack_markup(text).trim().to_string();
        if !translated.is_empty() {
            sections.push(translated);
        }
    }

    if let Some(raw_attachments) = root.get("attachments") {
        let attachments = raw_attachments
            .as_array()
            .filter(|items| items.len() <= MAXIMUM_ATTACHMENTS)
            .ok_or_else(|| {
                PayloadError::new("Slack-compatible attachments must contain at most 20 items")
            })?;
        for raw_attachment in attachments {
            let attachment = raw_attachment.as_object().ok_or_else(|| {
                PayloadError::new("Slack-compatible attachment must be an object")
            })?;
            if let Some(rendered) = render_attachment(attachment)? {
                sections.push(rendered);
            }
        }
    }

    let body = sections.join("\n\n");
    if body.is_empty() {
        return Err(PayloadError::new(
            "Slack-compatible payload requires non-empty text or attachments",
        ));
    }
    let mut props = BTreeMap::new();
    props.insert("slack_compatible".to_string(), "true".to_string());
    Ok(RenderedMessage {
        body: bounded_text(&body, "Slack-compatible rendered message")?,
        client_props: props,
    })
}

pub fn translate_slack_markup(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find('<') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('>') {
            Some(end) if !after[..end].contains('<') => {
                output.push_str(&replace_angle_token(&after[..end]));
                rest = &after[end + 1..];
            }
            _ => {
                output.push('<');
                rest = after;
            }
        }
    }
    output.push_str(rest);
    output
}

fn replace_angle_token(token: &str) -> String {
    if token == "!channel" {
        return "@channel".to_string();
    }
    if token == "!everyone" || token == "!here" {
        return format!("@{}", &token[1..]);
    }
    if token.starts_with("!subteam^") {
        return "@team".to_string();
    }
    if let Some(rest) = token.strip_prefix('#') {
        let mut parts = rest.splitn(2, '|');
        let _id = parts.next();
        return parts
            .next()
            .map(|label| format!("#{label}"))
            .unwrap_or_default();
    }
    if let Some(inner) = token.strip_prefix('@') {
        let mut parts = inner.splitn(2, '|');
        let id = parts.next().unwrap_or("");
        if let Some(label) = parts.next().filter(|label| !label.is_empty()) {
            return format!("@{label}");
        }
        return format!("@{id}");
    }
    let mut parts = token.splitn(2, '|');
    let target = parts.next().unwrap_or("");
    let label = parts.next().filter(|label| !label.is_empty());
    if is_link_url(target) {
        return match label {
            Some(label) => format!("[{label}]({target})"),
            None => target.to_string(),
        };
    }
    label.unwrap_or(target).to_string()
}

fn render_attachment(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<String>, PayloadError> {
    let mut lines: Vec<String> = Vec::new();

    let translated = |key: &str| -> Result<Option<String>, PayloadError> {
        match object.get(key) {
            None => Ok(None),
            Some(raw) => {
                let raw_value = raw.as_str().ok_or_else(|| {
                    PayloadError::new(format!("Slack attachment {key} must be a string"))
                })?;
                let value = translate_slack_markup(raw_value).trim().to_string();
                Ok((!value.is_empty()).then_some(value))
            }
        }
    };

    if let Some(pretext) = translated("pretext")? {
        lines.push(pretext);
    }
    if let Some(author) = translated("author_name")? {
        if let Some(link) = validated_url_string(object.get("author_link"), "author_link")? {
            lines.push(format!("[{author}]({link})"));
        } else {
            lines.push(author);
        }
    }
    if let Some(title) = translated("title")? {
        if let Some(link) = validated_url_string(object.get("title_link"), "title_link")? {
            lines.push(format!("[{title}]({link})"));
        } else {
            lines.push(title);
        }
    }
    if let Some(text) = translated("text")? {
        lines.push(text);
    }

    if let Some(raw_fields) = object.get("fields") {
        let fields = raw_fields
            .as_array()
            .filter(|items| items.len() <= MAXIMUM_FIELDS_PER_ATTACHMENT)
            .ok_or_else(|| {
                PayloadError::new("Slack attachment fields must contain at most 20 items")
            })?;
        for raw_field in fields {
            let field = raw_field
                .as_object()
                .ok_or_else(|| PayloadError::new("Slack attachment field must be an object"))?;
            if let Some(short) = field.get("short") {
                if !short.is_boolean() {
                    return Err(PayloadError::new(
                        "Slack attachment field short must be boolean",
                    ));
                }
            }
            let raw_value = field.get("value").and_then(Value::as_str).ok_or_else(|| {
                PayloadError::new("Slack attachment field requires a string value")
            })?;
            let value = translate_slack_markup(raw_value);
            if let Some(raw_title) = field.get("title") {
                let title = raw_title.as_str().ok_or_else(|| {
                    PayloadError::new("Slack attachment field title must be a string")
                })?;
                lines.push(format!("{}: {value}", translate_slack_markup(title)));
            } else {
                lines.push(value);
            }
        }
    }

    if let Some(image) = validated_url_string(object.get("image_url"), "image_url")? {
        lines.push(image);
    }
    if let Some(thumb) = validated_url_string(object.get("thumb_url"), "thumb_url")? {
        lines.push(thumb);
    }
    if let Some(footer) = translated("footer")? {
        lines.push(footer);
    }

    validated_optional_string(object.get("fallback"), "fallback")?;
    validated_optional_string(object.get("color"), "color")?;
    validated_url_string(object.get("author_icon"), "author_icon")?;
    validated_url_string(object.get("footer_icon"), "footer_icon")?;

    if lines.is_empty() {
        if let Some(fallback) = translated("fallback")? {
            lines.push(fallback);
        }
    }
    let rendered = lines.join("\n").trim().to_string();
    Ok((!rendered.is_empty()).then_some(rendered))
}

fn json_object(data: &[u8]) -> Result<serde_json::Map<String, Value>, PayloadError> {
    if data.is_empty() || data.len() > MAXIMUM_BODY_BYTES {
        return Err(PayloadError::new(
            "webhook body must contain 1...262144 bytes",
        ));
    }
    let json: Value = serde_json::from_slice(data)
        .map_err(|_| PayloadError::new("webhook body must be valid JSON"))?;
    json.as_object()
        .cloned()
        .ok_or_else(|| PayloadError::new("webhook body must be a JSON object"))
}

fn bounded_text(text: &str, label: &str) -> Result<String, PayloadError> {
    let value = text.trim();
    if value.is_empty() || value.chars().count() > MAXIMUM_MESSAGE_CHARACTERS {
        return Err(PayloadError::new(format!(
            "{label} must contain 1...40000 characters"
        )));
    }
    Ok(value.to_string())
}

fn valid_metadata_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'.' | b'-'))
}

fn validated_optional_string(
    raw: Option<&Value>,
    label: &str,
) -> Result<Option<String>, PayloadError> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let value = value
                .as_str()
                .filter(|value| value.chars().count() <= 2_000);
            value
                .map(|value| Ok(Some(value.to_string())))
                .unwrap_or_else(|| {
                    Err(PayloadError::new(format!(
                        "Slack attachment {label} must be a bounded string"
                    )))
                })
        }
    }
}

fn validated_url_string(raw: Option<&Value>, label: &str) -> Result<Option<String>, PayloadError> {
    match validated_optional_string(raw, label)? {
        None => Ok(None),
        Some(value) if is_http_url(&value) => Ok(Some(value)),
        Some(_) => Err(PayloadError::new(format!(
            "Slack attachment {label} must be an HTTP(S) URL"
        ))),
    }
}

fn is_link_url(value: &str) -> bool {
    scheme_of(value).is_some_and(|scheme| matches!(scheme.as_str(), "http" | "https" | "mailto"))
}

fn is_http_url(value: &str) -> bool {
    if value.chars().any(char::is_whitespace) {
        return false;
    }
    scheme_of(value).is_some_and(|scheme| matches!(scheme.as_str(), "http" | "https"))
}

fn scheme_of(value: &str) -> Option<String> {
    let scheme = value.split(':').next()?.to_ascii_lowercase();
    if scheme.is_empty() {
        return None;
    }
    match scheme.as_str() {
        "http" | "https" => value
            .get(scheme.len()..)
            .filter(|rest| rest.starts_with("://"))
            .map(|_| scheme),
        "mailto" => value
            .get("mailto:".len()..)
            .filter(|rest| !rest.is_empty())
            .map(|_| scheme),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_unknown_keys_fail_closed() {
        let err = parse_native(br#"{"text":"hi","channel":"x"}"#).unwrap_err();
        assert!(err.message.contains("unsupported native field"));
    }

    #[test]
    fn slack_blocks_are_an_explicit_400() {
        let err = parse_slack_compatible(br#"{"text":"hi","blocks":[]}"#).unwrap_err();
        assert!(err.message.contains("blocks"));
    }

    #[test]
    fn slack_markup_matches_the_swift_subset() {
        assert_eq!(translate_slack_markup("<!channel>"), "@channel");
        assert_eq!(
            translate_slack_markup("<https://example.com|docs>"),
            "[docs](https://example.com)"
        );
        assert_eq!(translate_slack_markup("<@U123|kim>"), "@kim");
        assert_eq!(translate_slack_markup("*Alerting*"), "*Alerting*");
    }

    #[test]
    fn slack_text_renders_and_ignores_identity_overrides() {
        let rendered = parse_slack_compatible(
            br#"{"text":"deployed","username":"github","icon_emoji":":ship:"}"#,
        )
        .expect("ignored extras");
        assert_eq!(rendered.body, "deployed");
        assert_eq!(
            rendered
                .client_props
                .get("slack_compatible")
                .map(String::as_str),
            Some("true")
        );
    }
}
