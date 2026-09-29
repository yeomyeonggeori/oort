//! The preview of a permission request — what the person reads before an
//! allow (#3118, ADR-0146 증보 H1 · ADR-0188 D5).
//!
//! **The host is the source.** `momo-workd` reads the tool kind, title,
//! locations and input from the agent's ACP `session/request_permission`,
//! sanitises each (D5: invisible and direction characters removed, credential
//! shapes masked, 3,500 characters per field with head and tail kept) and
//! relays the object below with the SHA-256 of its canonical bytes. The server
//! stores it for the session owner and relays it unchanged. The app hashes the
//! preview it renders, signs that hash on the `permission` line of a
//! `momo.human.control.v3` statement ([`crate::human_control`]), and the host
//! compares the line with the hash it computed itself. So a server can change
//! what the app shows, but not what an allow means.
//!
//! The object is closed — exactly these keys, strings except `truncated`:
//!
//! ```json
//! {"input":"…","kind":"execute","locations":"…","schema":"momo.work_permission.preview.v1","title":"…","truncated":false}
//! ```
//!
//! * `kind` — the ACP tool kind, one of [`PREVIEW_KINDS`] (anything else is
//!   `other`).
//! * `title`, `locations` (the request's paths, one per line) and `input`
//!   (the tool's raw input as compact JSON) — each at most
//!   [`PREVIEW_FIELD_MAX_CHARS`] characters, possibly empty.
//! * `truncated` — some field was cut. The person saw a cut preview, so the
//!   flag is signed too; an app does not allow over it (D5 「잘린 미리보기는
//!   펼치기 전에는 허용할 수 없다」).
//!
//! The canonical bytes are [`crate::human_control::canonical_json`] of the
//! object (sorted keys, `JSON.stringify` escaping) — the same function the
//! phone and the desktop already implement for a bundle manifest, so no new
//! byte rule exists. The hash is its lowercase hex SHA-256.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::human_control::{canonical_json, HumanSigningError};

/// The `schema` value of a v1 preview.
pub const PREVIEW_SCHEMA_V1: &str = "momo.work_permission.preview.v1";
/// Most characters one text field carries (ADR-0188 D5: 필드당 3,500자).
pub const PREVIEW_FIELD_MAX_CHARS: usize = 3_500;
/// The ACP `ToolKind` vocabulary, closed; `other` for anything else.
pub const PREVIEW_KINDS: &[&str] = &[
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];
/// The text fields, in no particular order (the canonical form sorts keys).
pub const PREVIEW_TEXT_FIELDS: [&str; 3] = ["title", "locations", "input"];

/// Why a relayed preview is not one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PreviewError {
    #[error("permission preview is not the closed v1 object: {0}")]
    Shape(&'static str),
    #[error("permission preview hash does not match its preview")]
    HashMismatch,
    #[error(transparent)]
    Canonical(#[from] HumanSigningError),
}

/// A preview's fields, before they become the closed object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPreview {
    pub kind: String,
    pub title: String,
    pub locations: String,
    pub input: String,
    pub truncated: bool,
}

impl PermissionPreview {
    /// The closed object. Does not sanitise — the host has.
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("schema".into(), Value::from(PREVIEW_SCHEMA_V1));
        object.insert("kind".into(), Value::from(self.kind.as_str()));
        object.insert("title".into(), Value::from(self.title.as_str()));
        object.insert("locations".into(), Value::from(self.locations.as_str()));
        object.insert("input".into(), Value::from(self.input.as_str()));
        object.insert("truncated".into(), Value::from(self.truncated));
        Value::Object(object)
    }
}

/// Check that `preview` is the closed v1 object.
pub fn validate_preview(preview: &Value) -> Result<(), PreviewError> {
    let object = preview
        .as_object()
        .ok_or(PreviewError::Shape("not an object"))?;
    if object.len() != 6 {
        return Err(PreviewError::Shape("wrong key set"));
    }
    if object.get("schema").and_then(Value::as_str) != Some(PREVIEW_SCHEMA_V1) {
        return Err(PreviewError::Shape("schema"));
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(PreviewError::Shape("kind"))?;
    if !PREVIEW_KINDS.contains(&kind) {
        return Err(PreviewError::Shape("kind"));
    }
    for field in PREVIEW_TEXT_FIELDS {
        let text = object
            .get(field)
            .and_then(Value::as_str)
            .ok_or(PreviewError::Shape("text field"))?;
        if text.chars().count() > PREVIEW_FIELD_MAX_CHARS {
            return Err(PreviewError::Shape("text field too long"));
        }
    }
    if !object.get("truncated").is_some_and(Value::is_boolean) {
        return Err(PreviewError::Shape("truncated"));
    }
    Ok(())
}

/// The canonical bytes of a valid preview.
pub fn preview_canonical_bytes(preview: &Value) -> Result<Vec<u8>, PreviewError> {
    validate_preview(preview)?;
    Ok(canonical_json(preview)?.into_bytes())
}

/// Lowercase hex SHA-256 of [`preview_canonical_bytes`] — the `permission`
/// line of a v3 statement.
pub fn preview_sha256(preview: &Value) -> Result<String, PreviewError> {
    Ok(hex::encode(Sha256::digest(preview_canonical_bytes(
        preview,
    )?)))
}

/// A relayed `(preview, preview_sha256)` pair is well formed and agrees.
/// (The server checks this so an honest row never disagrees with itself; it
/// proves nothing about a dishonest server, which the host's comparison
/// covers.)
pub fn check_relayed_preview(preview: &Value, claimed_sha256: &str) -> Result<(), PreviewError> {
    if preview_sha256(preview)? != claimed_sha256 {
        return Err(PreviewError::HashMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PermissionPreview {
        PermissionPreview {
            kind: "execute".into(),
            title: "Run `git push`".into(),
            locations: String::new(),
            input: r#"{"command":"git push"}"#.into(),
            truncated: false,
        }
    }

    #[test]
    fn the_canonical_bytes_are_sorted_compact_json() {
        let bytes = preview_canonical_bytes(&sample().to_value()).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"input":"{\"command\":\"git push\"}","kind":"execute","locations":"","schema":"momo.work_permission.preview.v1","title":"Run `git push`","truncated":false}"#
        );
    }

    #[test]
    fn every_field_moves_the_hash() {
        let base = preview_sha256(&sample().to_value()).unwrap();
        assert_eq!(base.len(), 64);
        let variants = [
            PermissionPreview {
                kind: "read".into(),
                ..sample()
            },
            PermissionPreview {
                title: "Read README.md".into(),
                ..sample()
            },
            PermissionPreview {
                locations: "/tmp".into(),
                ..sample()
            },
            PermissionPreview {
                input: "{}".into(),
                ..sample()
            },
            PermissionPreview {
                truncated: true,
                ..sample()
            },
        ];
        for variant in variants {
            assert_ne!(
                preview_sha256(&variant.to_value()).unwrap(),
                base,
                "{variant:?}"
            );
        }
    }

    #[test]
    fn only_the_closed_object_is_a_preview() {
        let mut extra = sample().to_value();
        extra["note"] = Value::from("x");
        assert!(validate_preview(&extra).is_err());
        let mut kind = sample().to_value();
        kind["kind"] = Value::from("sudo");
        assert!(validate_preview(&kind).is_err());
        let mut long = sample().to_value();
        long["title"] = Value::from("x".repeat(PREVIEW_FIELD_MAX_CHARS + 1));
        assert!(validate_preview(&long).is_err());
        let mut flag = sample().to_value();
        flag["truncated"] = Value::from(0);
        assert!(validate_preview(&flag).is_err());
        let mut schema = sample().to_value();
        schema["schema"] = Value::from("momo.work_permission.preview.v2");
        assert!(validate_preview(&schema).is_err());
        let value = sample().to_value();
        let hash = preview_sha256(&value).unwrap();
        assert_eq!(check_relayed_preview(&value, &hash), Ok(()));
        assert_eq!(
            check_relayed_preview(&value, &"0".repeat(64)),
            Err(PreviewError::HashMismatch)
        );
    }
}
