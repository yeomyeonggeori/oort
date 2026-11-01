use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Error;

pub const QUOTA: i64 = 1000;
/// Live direct drafts one person may hold (ADR-0218 D2).
pub const LIVE_DRAFTS: i64 = 4;
/// Why a link import ended without a picture (ADR-0218 appendix C). The closed set a
/// `url`-origin draft may carry; `video_processing_unavailable` is shared with uploads
/// and `video_conversion_failed` stays unused while D4 is on hold.
pub const SOURCE_CODES: [&str; 6] = [
    "source_blocked",
    "source_unavailable",
    "source_too_large",
    "source_unsupported",
    "source_timeout",
    "source_invalid_media",
];

/// ADR-0218 G3.8: why a **generated or assembled** picture is missing, in the table's order. The
/// `expression_draft.code` CHECK (migration 161), `Draft.code` of the contract and the neutral
/// sentences of the failure card (`packages/momo-core/.../expression-failure-copy.json`) are
/// the same six words; a test pins each against this list. `assembly_params_invalid` is a call
/// error with no card, so it is not here.
pub const FAILURE_CODES: [&str; 6] = [
    "generation_failed",
    "assembly_source_invalid",
    "assembly_source_too_large",
    "assembly_output_too_large",
    "assembly_timeout",
    "assembly_busy",
];
pub const INPUT_BYTES: usize = 5 * 1024 * 1024;
pub const REQUEST_BYTES: usize = 6 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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
    /// A link import. `source_url` is the storable form (host/path only), never the
    /// URL that was fetched; [`valid_source_url`] is re-proved where it is stored.
    pub fn url(source_url: impl Into<String>) -> Self {
        Self {
            kind: "url".into(),
            source_url: Some(source_url.into()),
            prompt: None,
        }
    }
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
    /// A picture the team's image model drew from a member's photo (ADR-0218 §8 H9): `generated`,
    /// with the one sentence this server wrote for the branch. `None` for a branch that is not one.
    pub fn photo(branch: &str) -> Option<Self> {
        let (_, sentence) = PHOTO_PROMPTS.iter().find(|(name, _)| *name == branch)?;
        Some(Self {
            kind: "generated".into(),
            source_url: None,
            prompt: Some((*sentence).into()),
        })
    }
}

/// The two sentences a picture drawn by the team's image model carries as its `prompt` (ADR-0218
/// §8 H9). They are written here: no member, agent or provider writes a word of them, which is why
/// the direct API may accept a `generated` origin that carries exactly one of them and no other.
pub const PHOTO_PROMPTS: [(&str, &str); 2] = [
    ("cutout", "사진에서 피사체만 남기고 배경을 지운 그림"),
    ("caricature", "사진을 바탕으로 새로 그린 캐리커처"),
];

/// `Origin.sourceUrl` (contracts.schema.json) with the schema's slack removed:
/// `https://host[:port][/path]`, ASCII only, host in lowercase `[a-z0-9.-]` or a
/// bracketed lowercase-hex IPv6 literal, port 1..=65535, no userinfo, query,
/// fragment, whitespace, control character or backslash (ADR-0218 D5: a link's
/// credentials and query never reach storage, a card or a log).
pub fn valid_source_url(link: &str) -> bool {
    if !(8..=2048).contains(&link.len()) || !link.is_ascii() {
        return false;
    }
    let Some(rest) = link.strip_prefix("https://") else {
        return false;
    };
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    if !path
        .bytes()
        .all(|b| b > b' ' && b != 0x7f && !matches!(b, b'?' | b'#' | b'\\'))
    {
        return false;
    }
    let (host_ok, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let Some((inside, tail)) = bracketed.split_once(']') else {
            return false;
        };
        let port = match tail {
            "" => None,
            _ => match tail.strip_prefix(':') {
                Some(port) => Some(port),
                None => return false,
            },
        };
        (
            !inside.is_empty()
                && inside
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b':'),
            port,
        )
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        };
        (
            !host.is_empty()
                && host.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'
                }),
            port,
        )
    };
    host_ok
        && port.is_none_or(|port| {
            (1..=5).contains(&port.len())
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|port| port > 0)
        })
}

/// Which `(origin, picture, reason)` combinations a direct draft may be created with.
/// No caller-supplied prompts or cards: a `generated` origin belongs to the agent
/// action, except the photo route's own (two fixed sentences, [`PHOTO_PROMPTS`]); the rest of this
/// sentence is the old rule, unchanged: a `generated` origin belongs to the agent
/// action, never to this API. A picture and a reason are mutually exclusive, and the
/// `source_*` reasons exist only for a link import.
pub fn draft_origin_ok(origin: &Origin, has_media: bool, code: Option<&str>) -> bool {
    // The one `generated` origin this API takes: the photo route's (ADR-0218 §8 H9). A picture, no
    // reason code, no link, and one of the server's own two sentences, verbatim.
    if origin.kind == "generated" {
        return has_media
            && code.is_none()
            && origin.source_url.is_none()
            && PHOTO_PROMPTS
                .iter()
                .any(|(_, sentence)| origin.prompt.as_deref() == Some(*sentence));
    }
    if origin.prompt.is_some() {
        return false;
    }
    let from_link = match (origin.kind.as_str(), origin.source_url.as_deref()) {
        ("upload" | "attachment", None) => false,
        ("url", Some(link)) if valid_source_url(link) => true,
        _ => return false,
    };
    match (has_media, code) {
        (true, None) => true,
        (false, Some("video_processing_unavailable")) => true,
        (false, Some(code)) => from_link && SOURCE_CODES.contains(&code),
        (false, None) | (true, Some(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_storable_source_link_is_host_and_path_only() {
        for good in [
            "https://giphy.com/gifs/example",
            "https://media.giphy.com/media/abc/giphy.gif",
            "https://example.com/",
            "https://example.com",
            "https://example.com:8443/x.png",
            "https://xn--r8jz45g.jp/%E7%8C%AB.gif",
            "https://[2606:4700::1111]/x.gif",
            "https://[2606:4700::1111]:8443/x.gif",
            "https://93.184.216.34/x.gif",
            "https://example.com/a@b.png",
        ] {
            assert!(valid_source_url(good), "{good}");
        }
        let long = format!("https://example.com/{}", "a".repeat(2048));
        for (bad, why) in [
            ("", "empty"),
            ("http://example.com/x.gif", "plain http"),
            ("ftp://example.com/x.gif", "ftp"),
            ("https://", "no host"),
            ("https:///x.gif", "empty host"),
            ("https://example.com/x.gif?token=SECRET", "query"),
            ("https://example.com?x=1", "query without a path"),
            ("https://example.com/x.gif#frag", "fragment"),
            ("https://user:pw@example.com/x.gif", "credentials"),
            ("https://user@example.com/x.gif", "userinfo"),
            ("https://example.com/a b.gif", "space"),
            ("https://example.com/a\tb.gif", "tab"),
            ("https://example.com/a\u{1}b.gif", "control"),
            ("https://example.com/a\u{7f}b.gif", "DEL"),
            ("https://example.com/a\\b.gif", "backslash"),
            ("https://Example.com/x.gif", "uppercase host"),
            ("https://exa_mple.com/x.gif", "underscore host"),
            ("https://例え.jp/x.gif", "non-ASCII host"),
            ("https://example.com/猫.gif", "non-ASCII path"),
            ("https://example.com:0/x.gif", "port 0"),
            ("https://example.com:65536/x.gif", "port out of range"),
            ("https://example.com:123456/x.gif", "six-digit port"),
            ("https://example.com:/x.gif", "empty port"),
            ("https://example.com:abc/x.gif", "port not a number"),
            ("https://[::1/x.gif", "unterminated bracket"),
            ("https://[::1]x/x.gif", "garbage after the bracket"),
            ("https://[]/x.gif", "empty bracket"),
            ("https://[::G]/x.gif", "bad hex in bracket"),
            ("https://[::1]:/x.gif", "empty port after bracket"),
            (long.as_str(), "over 2048"),
        ] {
            assert!(!valid_source_url(bad), "{why}: {bad:?}");
        }
    }

    fn origin(kind: &str, source_url: Option<&str>, prompt: Option<&str>) -> Origin {
        Origin {
            kind: kind.into(),
            source_url: source_url.map(str::to_owned),
            prompt: prompt.map(str::to_owned),
        }
    }

    /// The fixture server of the shared TypeScript core answers the photo route with these two
    /// sentences (`PHOTO_FIXTURE_PROMPTS`); a screen built on it must say what the real server says.
    /// Read from the file, not compiled in: the release image carries no client sources.
    #[test]
    fn the_clients_fixture_server_speaks_the_same_two_sentences() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/momo-core/src/features/expressions/fixtureServer.ts"
        );
        let source = std::fs::read_to_string(path).expect("the core fixture server");
        for (branch, sentence) in PHOTO_PROMPTS {
            assert!(
                source.contains(&format!("{branch}: \"{sentence}\"")),
                "fixtureServer.ts PHOTO_FIXTURE_PROMPTS must carry {branch}: {sentence}"
            );
        }
    }

    #[test]
    fn only_these_origin_picture_reason_triples_may_become_a_draft() {
        let link = Some("https://example.com/x.gif");
        // Each row: (origin, has picture, reason, allowed, why)
        let rows = [
            (
                origin("upload", None, None),
                true,
                None,
                true,
                "upload with a picture",
            ),
            (
                origin("attachment", None, None),
                true,
                None,
                true,
                "attachment with a picture",
            ),
            (
                origin("url", link, None),
                true,
                None,
                true,
                "link with a picture",
            ),
            (
                origin("upload", None, None),
                false,
                Some("video_processing_unavailable"),
                true,
                "upload video",
            ),
            (
                origin("attachment", None, None),
                false,
                Some("video_processing_unavailable"),
                true,
                "attachment video",
            ),
            (
                origin("url", link, None),
                false,
                Some("video_processing_unavailable"),
                true,
                "link video",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_blocked"),
                true,
                "blocked",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_unavailable"),
                true,
                "unavailable",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_too_large"),
                true,
                "too large",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_unsupported"),
                true,
                "unsupported",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_timeout"),
                true,
                "timeout",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_invalid_media"),
                true,
                "invalid media",
            ),
            (
                origin("url", link, None),
                false,
                Some("video_conversion_failed"),
                false,
                "converter code is unused while D4 is on hold",
            ),
            (
                origin("url", link, None),
                false,
                Some("source_made_up"),
                false,
                "unknown code",
            ),
            (
                origin("upload", None, None),
                false,
                Some("source_blocked"),
                false,
                "a source reason on an upload",
            ),
            (
                origin("attachment", None, None),
                false,
                Some("source_timeout"),
                false,
                "a source reason on an attachment",
            ),
            (
                origin("url", link, None),
                true,
                Some("source_blocked"),
                false,
                "picture and reason together",
            ),
            (
                origin("url", link, None),
                false,
                None,
                false,
                "neither picture nor reason",
            ),
            (
                origin("upload", None, None),
                false,
                None,
                false,
                "upload with neither",
            ),
            (
                origin("url", None, None),
                true,
                None,
                false,
                "url origin without a link",
            ),
            (
                origin("url", Some("https://example.com/x.gif?token=SECRET"), None),
                true,
                None,
                false,
                "url origin with a query",
            ),
            (
                origin("url", Some("http://example.com/x.gif"), None),
                true,
                None,
                false,
                "url origin over plain http",
            ),
            (
                origin("upload", link, None),
                true,
                None,
                false,
                "upload that names a link",
            ),
            (
                origin("attachment", link, None),
                true,
                None,
                false,
                "attachment that names a link",
            ),
            (
                origin("url", link, Some("a prompt")),
                true,
                None,
                false,
                "a prompt on a link",
            ),
            (
                origin("upload", None, Some("a prompt")),
                true,
                None,
                false,
                "a prompt on an upload",
            ),
            (
                origin("generated", link, Some("a prompt")),
                true,
                None,
                false,
                "generated belongs to the agent action",
            ),
            (
                origin("generated", None, Some("a prompt")),
                true,
                None,
                false,
                "generated without a link",
            ),
            (
                origin("anything-else", None, None),
                true,
                None,
                false,
                "unknown kind",
            ),
            (
                Origin::photo("cutout").unwrap(),
                true,
                None,
                true,
                "the photo route's cut-out sentence",
            ),
            (
                Origin::photo("caricature").unwrap(),
                true,
                None,
                true,
                "the photo route's caricature sentence",
            ),
            (
                Origin::photo("cutout").unwrap(),
                false,
                Some("generation_failed"),
                false,
                "a photo origin without a picture",
            ),
            (
                Origin::photo("cutout").unwrap(),
                true,
                Some("generation_failed"),
                false,
                "a photo origin with a reason code",
            ),
            (
                origin("generated", link, Some(PHOTO_PROMPTS[0].1)),
                true,
                None,
                false,
                "the server's sentence with a link",
            ),
            (
                origin(
                    "generated",
                    None,
                    Some("사진에서 피사체만 남기고 배경을 지운 그림!"),
                ),
                true,
                None,
                false,
                "a sentence that is not exactly the server's",
            ),
            (
                origin("upload", None, Some(PHOTO_PROMPTS[1].1)),
                true,
                None,
                false,
                "the server's sentence on a kind that takes no prompt",
            ),
            (
                origin("generated", None, None),
                true,
                None,
                false,
                "generated with no prompt at all",
            ),
        ];
        assert!(Origin::photo("anything-else").is_none());
        for (origin, has_media, code, allowed, why) in rows {
            assert_eq!(
                draft_origin_ok(&origin, has_media, code),
                allowed,
                "{why}: {origin:?} media={has_media} code={code:?}"
            );
        }
    }
}
