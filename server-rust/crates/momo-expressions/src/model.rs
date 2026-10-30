use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Error;

pub const QUOTA: i64 = 1000;
pub const INPUT_BYTES: usize = 5 * 1024 * 1024;
pub const REQUEST_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub name: String,
    pub display_name: String,
    pub tags: Vec<String>,
    // deserialize_with deliberately requires the nullable field to be present.
    #[serde(deserialize_with = "nullable_id")]
    pub subject_member_id: Option<Uuid>,
}

fn nullable_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Uuid>, D::Error> {
    let value = Option::<String>::deserialize(d)?;
    value
        .map(|s| {
            let id = Uuid::parse_str(&s).map_err(serde::de::Error::custom)?;
            if s != id.to_string() {
                return Err(serde::de::Error::custom("canonical UUID required"));
            }
            Ok(id)
        })
        .transpose()
}

pub fn standard_names() -> &'static HashSet<String> {
    static NAMES: OnceLock<HashSet<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        // Same committed emojibase + iamcal canonical source as the picker (#4322).
        let catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/momo-core/src/features/emoji/emojiCatalog.json"
        ))
        .expect("committed emoji catalog");
        catalog["items"]
            .as_array()
            .expect("emoji catalog rows")
            .iter()
            .flat_map(|row| row[2].as_array().into_iter().flatten())
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    })
}

pub fn plain(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.chars().count() <= max
        && !s
            .chars()
            .any(|c| c <= '\u{1f}' || c == '\u{7f}' || "@<>[]`\\".contains(c))
}

pub fn valid_tags(tags: &[String]) -> bool {
    tags.len() <= 8
        && tags.iter().all(|tag| plain(tag, 16))
        && tags.iter().collect::<HashSet<_>>().len() == tags.len()
}

impl Metadata {
    pub fn validate(&self) -> Result<(), Error> {
        if !(2..=30).contains(&self.name.len())
            || !self
                .name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
            || !plain(&self.display_name, 40)
            || !valid_tags(&self.tags)
        {
            return Err(Error::Invalid);
        }
        if standard_names().contains(&self.name) {
            return Err(Error::NameReserved);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub draft_id: Uuid,
    pub revision: String,
    pub sha256: String,
}

pub fn version(s: &str) -> Result<i64, Error> {
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Invalid);
    }
    s.parse().map_err(|_| Error::Invalid)
}
pub fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    #[serde(default, deserialize_with = "present")]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub tags: Option<Vec<String>>,
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
impl Patch {
    pub fn validate(&self) -> Result<(), Error> {
        if (self.display_name.is_none() && self.tags.is_none())
            || self.display_name.as_ref().is_some_and(|s| !plain(s, 40))
            || self.tags.as_ref().is_some_and(|t| !valid_tags(t))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub reason: String,
    #[serde(default, deserialize_with = "present")]
    pub detail: Option<String>,
}
impl Report {
    pub fn validate(&self) -> Result<(), Error> {
        if !["copyright", "face", "other"].contains(&self.reason.as_str())
            || self
                .detail
                .as_ref()
                .is_some_and(|s| s.chars().count() > 500)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub mime: String,
    pub sha256: String,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub duration_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub kind: String,
    pub source_url: Option<String>,
    pub prompt: Option<String>,
}
impl Origin {
    pub fn upload() -> Self {
        Self {
            kind: "upload".into(),
            source_url: None,
            prompt: None,
        }
    }
    pub fn attachment() -> Self {
        Self {
            kind: "attachment".into(),
            ..Self::upload()
        }
    }
}
