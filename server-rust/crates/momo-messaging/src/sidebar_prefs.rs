//! Member-owned sidebar organization (ADR-0177 / #1932 BT-4) — the read/write
//! half of the `member_sidebar_prefs` row (migration 084).
//!
//! One row per (workspace, member) holding **one JSONB blob**: the member's
//! custom sections, which channels they placed in each, their starred channels
//! and (reserved for BT-5) how sections are sorted. ADR-0177 D1 makes this
//! purely personal — there is no workspace-shared section in v1 — and D2 makes
//! it *roaming*, which is why it lives in Postgres rather than localStorage.
//!
//! Three rules shape the validation below, all from ADR-0177 D3:
//!
//!   1. **Shape and size only.** The server checks `version`, the caps
//!      ([`SECTION_MAX`], [`SECTION_NAME_MAX_CHARS`], [`CHANNEL_REF_MAX`]) and
//!      that ids are well formed. Nothing else.
//!   2. **Channel membership is NOT verified.** A section may name a channel
//!      the member has since left, or one that was deleted outright. That is a
//!      deliberate *tolerant* contract: verifying membership here would make
//!      every leave/archive race a 400 on an unrelated save, and the client has
//!      to filter dead ids at render time anyway (it renders from a live
//!      channel list, not from this payload). [`crate::sidebar_prefs`] therefore
//!      never touches `channel` or `membership`.
//!   3. **No outbox.** ADR-0177 D2 — this module emits no event of any kind.
//!      The writing device already has the new state; other devices converge on
//!      the next bootstrap `GET`. Adding a fan-out later is an additive change;
//!      shipping one now would put a second consumer on a blob whose shape is
//!      still moving (BT-5 owns stars/sort/DnD).
//!
//! Collapse state (which sections are folded) is deliberately absent: ADR-0177
//! D4 keeps it in the client's `localStorage` because folding is a property of
//! the device, while the structure is a property of the person.

use momo_db::DbError;
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Only payload version this server understands. A future shape bumps this and
/// the server refuses the ones it cannot read rather than storing a blob whose
/// meaning it is guessing at.
pub const SIDEBAR_PREFS_VERSION: i64 = 1;

/// ADR-0177 D3 — at most 50 custom sections.
pub const SECTION_MAX: usize = 50;

/// ADR-0177 D3 — a section name is at most 80 **characters** (not bytes: a
/// Korean section name is 3 bytes per character and must not be shorter for it).
pub const SECTION_NAME_MAX_CHARS: usize = 80;

/// ADR-0177 D3 — at most 500 channel references in one payload.
///
/// Counted across the whole blob (every section's `channelIds` plus
/// `starredChannelIds`), not per list: the cap exists to bound the size of the
/// row, and a payload is one row.
pub const CHANNEL_REF_MAX: usize = 500;

/// A section id is client-minted (buzz mints a random string), so the server
/// bounds it rather than prescribing a format.
pub const SECTION_ID_MAX_CHARS: usize = 64;

/// `sectionSort` is BT-5's field. BT-4 accepts and round-trips it — ADR-0177 D5
/// says the schema takes stars and sort from the start — but does not enumerate
/// its values, so the sort BT-5 lands does not need a server change to ship.
pub const SECTION_SORT_MAX_CHARS: usize = 32;

/// One custom section as the member arranged it.
///
/// `order` is a plain integer the client assigns; the server neither
/// renumbers nor requires it to be dense. `channel_ids` is a placement list,
/// **not** a membership list (rule 2 above).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarSection {
    pub id: String,
    pub name: String,
    pub order: i32,
    pub channel_ids: Vec<String>,
}

/// ADR-0177 D3 payload v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidebarPrefs {
    pub version: i64,
    #[serde(default)]
    pub sections: Vec<SidebarSection>,
    /// BT-5 owns the star UI; BT-4 owns the field it will write into.
    #[serde(default)]
    pub starred_channel_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_sort: Option<String>,
}

impl Default for SidebarPrefs {
    /// What a member who has never saved reads back: a valid v1 payload with
    /// nothing in it. `GET` answers this instead of 404 so the client has one
    /// code path — "no row yet" and "everything deleted" are the same sidebar.
    fn default() -> Self {
        Self {
            version: SIDEBAR_PREFS_VERSION,
            sections: Vec::new(),
            starred_channel_ids: Vec::new(),
            section_sort: None,
        }
    }
}

/// A stored payload plus when it was last written. `updated_at_ms` is `None`
/// for the never-saved default.
///
/// `Default` is derived and lands on [`SidebarPrefs::default`] + `None`: the
/// never-saved answer `GET` returns.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoredSidebarPrefs {
    pub prefs: SidebarPrefs,
    pub updated_at_ms: Option<i64>,
}

/// Why a `PUT` body was refused. Every variant is a caller fault carrying the
/// number it violated, so a client can tell "too many sections" from "name too
/// long" without parsing prose.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SidebarPrefsInvalid {
    #[error("version must be {SIDEBAR_PREFS_VERSION}")]
    UnsupportedVersion,
    #[error("at most {SECTION_MAX} sections are allowed")]
    TooManySections,
    #[error("a section name is required")]
    EmptySectionName,
    #[error("a section name must be at most {SECTION_NAME_MAX_CHARS} characters")]
    SectionNameTooLong,
    #[error("a section id is required")]
    EmptySectionId,
    #[error("a section id must be at most {SECTION_ID_MAX_CHARS} characters")]
    SectionIdTooLong,
    #[error("section ids must be unique")]
    DuplicateSectionId,
    #[error("at most {CHANNEL_REF_MAX} channel references are allowed")]
    TooManyChannelRefs,
    #[error("channel ids must be uuids")]
    ChannelIdNotUuid,
    #[error("sectionSort must be at most {SECTION_SORT_MAX_CHARS} characters")]
    SectionSortTooLong,
}

/// Validate and canonicalize a `PUT` body.
///
/// Canonicalization is limited to what the caller cannot reasonably be asked to
/// do: names are trimmed (a trailing space is invisible in the sidebar but
/// changes equality), and channel ids are lower-cased through `Uuid` so the
/// client's dead-id filter can compare strings. Ordering is *not* touched —
/// `order` is the member's arrangement, and a server that renumbered it would
/// silently fight BT-5's drag-and-drop.
///
/// Channel ids are required to parse as UUIDs. That is a *format* check, not the
/// membership check rule 2 forbids: it says nothing about whether the channel
/// exists, only that the id is spelled like one. Without it a caller could store
/// 500 arbitrarily long strings and the [`CHANNEL_REF_MAX`] cap would bound the
/// count while leaving the row unbounded.
pub fn validate_sidebar_prefs(prefs: SidebarPrefs) -> Result<SidebarPrefs, SidebarPrefsInvalid> {
    if prefs.version != SIDEBAR_PREFS_VERSION {
        return Err(SidebarPrefsInvalid::UnsupportedVersion);
    }
    if prefs.sections.len() > SECTION_MAX {
        return Err(SidebarPrefsInvalid::TooManySections);
    }

    let mut seen_ids: Vec<String> = Vec::with_capacity(prefs.sections.len());
    let mut channel_refs = prefs.starred_channel_ids.len();
    let mut sections = Vec::with_capacity(prefs.sections.len());

    for section in prefs.sections {
        let id = section.id.trim().to_string();
        if id.is_empty() {
            return Err(SidebarPrefsInvalid::EmptySectionId);
        }
        if id.chars().count() > SECTION_ID_MAX_CHARS {
            return Err(SidebarPrefsInvalid::SectionIdTooLong);
        }
        if seen_ids.contains(&id) {
            return Err(SidebarPrefsInvalid::DuplicateSectionId);
        }

        let name = section.name.trim().to_string();
        if name.is_empty() {
            return Err(SidebarPrefsInvalid::EmptySectionName);
        }
        if name.chars().count() > SECTION_NAME_MAX_CHARS {
            return Err(SidebarPrefsInvalid::SectionNameTooLong);
        }

        channel_refs += section.channel_ids.len();
        if channel_refs > CHANNEL_REF_MAX {
            return Err(SidebarPrefsInvalid::TooManyChannelRefs);
        }
        let channel_ids = normalize_channel_ids(&section.channel_ids)?;

        seen_ids.push(id.clone());
        sections.push(SidebarSection {
            id,
            name,
            order: section.order,
            channel_ids,
        });
    }

    if channel_refs > CHANNEL_REF_MAX {
        return Err(SidebarPrefsInvalid::TooManyChannelRefs);
    }
    let starred_channel_ids = normalize_channel_ids(&prefs.starred_channel_ids)?;

    let section_sort = match prefs.section_sort {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.chars().count() > SECTION_SORT_MAX_CHARS {
                return Err(SidebarPrefsInvalid::SectionSortTooLong);
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };

    Ok(SidebarPrefs {
        version: SIDEBAR_PREFS_VERSION,
        sections,
        starred_channel_ids,
        section_sort,
    })
}

fn normalize_channel_ids(raw: &[String]) -> Result<Vec<String>, SidebarPrefsInvalid> {
    raw.iter()
        .map(|id| {
            id.trim()
                .parse::<Uuid>()
                .map(|uuid| uuid.to_string())
                .map_err(|_| SidebarPrefsInvalid::ChannelIdNotUuid)
        })
        .collect()
}

/// Read the calling member's stored prefs, or the empty default when the row
/// does not exist.
///
/// A stored blob that no longer parses (a future `version`, or a shape this
/// binary predates) reads back as the default rather than erroring: a member
/// who used a newer client must still be able to open an older one, and the
/// next `PUT` from this client replaces the blob wholesale.
pub async fn get_sidebar_prefs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<StoredSidebarPrefs, DbError> {
    let row = sqlx::query(
        "SELECT payload, (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms \
           FROM member_sidebar_prefs \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(StoredSidebarPrefs::default());
    };
    let payload: serde_json::Value = row.get("payload");
    let updated_at_ms: Option<i64> = row.get("updated_at_ms");
    match serde_json::from_value::<SidebarPrefs>(payload) {
        Ok(prefs) => Ok(StoredSidebarPrefs {
            prefs,
            updated_at_ms,
        }),
        Err(_) => Ok(StoredSidebarPrefs::default()),
    }
}

/// Replace the calling member's prefs and return what was stored.
///
/// `PUT` semantics: the blob is the whole structure, so an upsert that replaces
/// `payload` outright is the write. No outbox row is emitted — see rule 3 in the
/// module header and ADR-0177 D2.
pub async fn set_sidebar_prefs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    prefs: &SidebarPrefs,
) -> Result<StoredSidebarPrefs, DbError> {
    // Infallible for this shape (only strings, integers and vectors of them) —
    // the house `expect` for outbox envelopes, for the same reason.
    let payload = serde_json::to_value(prefs).expect("sidebar prefs payload serializes");
    let updated_at_ms: i64 = sqlx::query_scalar(
        "INSERT INTO member_sidebar_prefs (workspace_id, member_id, payload) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = now() \
         RETURNING (extract(epoch FROM updated_at) * 1000)::bigint",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(payload)
    .fetch_one(&mut *conn)
    .await?;

    Ok(StoredSidebarPrefs {
        prefs: prefs.clone(),
        updated_at_ms: Some(updated_at_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel_id(n: u8) -> String {
        Uuid::from_bytes([n; 16]).to_string()
    }

    fn section(id: &str, name: &str, channels: usize) -> SidebarSection {
        SidebarSection {
            id: id.to_string(),
            name: name.to_string(),
            order: 0,
            channel_ids: (0..channels).map(|i| channel_id(i as u8)).collect(),
        }
    }

    #[test]
    fn the_never_saved_default_is_an_empty_v1_payload() {
        let default = SidebarPrefs::default();
        assert_eq!(default.version, SIDEBAR_PREFS_VERSION);
        assert!(default.sections.is_empty());
        assert!(default.starred_channel_ids.is_empty());
        assert_eq!(default.section_sort, None);
        assert_eq!(StoredSidebarPrefs::default().updated_at_ms, None);
    }

    #[test]
    fn a_version_other_than_one_is_refused() {
        for version in [0, 2, -1, 99] {
            let prefs = SidebarPrefs {
                version,
                ..SidebarPrefs::default()
            };
            assert_eq!(
                validate_sidebar_prefs(prefs),
                Err(SidebarPrefsInvalid::UnsupportedVersion),
                "version {version} is not v1"
            );
        }
    }

    #[test]
    fn fifty_sections_pass_and_fifty_one_do_not() {
        let fifty = SidebarPrefs {
            sections: (0..SECTION_MAX)
                .map(|i| section(&format!("s{i}"), &format!("섹션 {i}"), 0))
                .collect(),
            ..SidebarPrefs::default()
        };
        assert!(
            validate_sidebar_prefs(fifty).is_ok(),
            "50 is the cap, not 49"
        );

        let fifty_one = SidebarPrefs {
            sections: (0..=SECTION_MAX)
                .map(|i| section(&format!("s{i}"), &format!("섹션 {i}"), 0))
                .collect(),
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(fifty_one),
            Err(SidebarPrefsInvalid::TooManySections)
        );
    }

    /// The cap counts *characters*. A Korean name is 3 bytes per character, so a
    /// byte-counting implementation would refuse a legal 80-character name at 27.
    #[test]
    fn a_long_korean_section_name_is_measured_in_characters() {
        let eighty: String = "가".repeat(SECTION_NAME_MAX_CHARS);
        assert_eq!(eighty.len(), SECTION_NAME_MAX_CHARS * 3, "bytes ≠ chars");
        let ok = SidebarPrefs {
            sections: vec![section("s1", &eighty, 0)],
            ..SidebarPrefs::default()
        };
        assert!(
            validate_sidebar_prefs(ok).is_ok(),
            "80 Korean characters is exactly the cap"
        );

        let over: String = "가".repeat(SECTION_NAME_MAX_CHARS + 1);
        let too_long = SidebarPrefs {
            sections: vec![section("s1", &over, 0)],
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(too_long),
            Err(SidebarPrefsInvalid::SectionNameTooLong)
        );
    }

    #[test]
    fn a_blank_section_name_is_refused_after_trimming() {
        let blank = SidebarPrefs {
            sections: vec![section("s1", "   ", 0)],
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(blank),
            Err(SidebarPrefsInvalid::EmptySectionName)
        );
    }

    #[test]
    fn a_name_is_trimmed_but_its_inner_spacing_survives() {
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            sections: vec![section("  s1  ", "  긴급 대응 채널  ", 0)],
            ..SidebarPrefs::default()
        })
        .expect("valid");
        assert_eq!(prefs.sections[0].name, "긴급 대응 채널");
        assert_eq!(prefs.sections[0].id, "s1");
    }

    #[test]
    fn duplicate_section_ids_are_refused() {
        let prefs = SidebarPrefs {
            sections: vec![section("dup", "가", 0), section("dup", "나", 0)],
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(prefs),
            Err(SidebarPrefsInvalid::DuplicateSectionId)
        );
    }

    /// The cap is on the payload, not on any one list: 300 placed + 300 starred
    /// is 600 references and must be refused even though neither list alone is
    /// over 500.
    #[test]
    fn the_channel_reference_cap_counts_the_whole_payload() {
        let mut placed: Vec<String> = Vec::new();
        let mut starred: Vec<String> = Vec::new();
        for i in 0..300u32 {
            placed.push(Uuid::from_u128(i as u128 + 1).to_string());
            starred.push(Uuid::from_u128(i as u128 + 1_000).to_string());
        }
        let prefs = SidebarPrefs {
            sections: vec![SidebarSection {
                id: "s1".into(),
                name: "많음".into(),
                order: 0,
                channel_ids: placed,
            }],
            starred_channel_ids: starred,
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(prefs),
            Err(SidebarPrefsInvalid::TooManyChannelRefs)
        );
    }

    #[test]
    fn exactly_five_hundred_references_are_allowed() {
        let placed: Vec<String> = (0..CHANNEL_REF_MAX as u128)
            .map(|i| Uuid::from_u128(i + 1).to_string())
            .collect();
        let prefs = SidebarPrefs {
            sections: vec![SidebarSection {
                id: "s1".into(),
                name: "정확히".into(),
                order: 0,
                channel_ids: placed,
            }],
            ..SidebarPrefs::default()
        };
        assert!(validate_sidebar_prefs(prefs).is_ok(), "500 is the cap");
    }

    /// Rule 2: a dead channel id is *stored*, not refused. The client filters it
    /// at render time; the server has no opinion about whether the channel lives.
    #[test]
    fn a_channel_id_that_names_nothing_is_still_stored() {
        let dead = Uuid::from_u128(0xdead_beef).to_string();
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            sections: vec![SidebarSection {
                id: "s1".into(),
                name: "죽은 채널".into(),
                order: 0,
                channel_ids: vec![dead.clone()],
            }],
            ..SidebarPrefs::default()
        })
        .expect("a dead id is a valid id");
        assert_eq!(prefs.sections[0].channel_ids, vec![dead]);
    }

    #[test]
    fn a_channel_id_that_is_not_a_uuid_is_refused() {
        let prefs = SidebarPrefs {
            sections: vec![SidebarSection {
                id: "s1".into(),
                name: "잘못".into(),
                order: 0,
                channel_ids: vec!["not-a-uuid".into()],
            }],
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(prefs),
            Err(SidebarPrefsInvalid::ChannelIdNotUuid)
        );
    }

    #[test]
    fn a_channel_id_is_canonicalized_to_lower_case() {
        let upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            starred_channel_ids: vec![upper.to_string()],
            ..SidebarPrefs::default()
        })
        .expect("valid");
        assert_eq!(prefs.starred_channel_ids[0], upper.to_lowercase());
    }

    /// `order` is the member's arrangement. A server that sorted or renumbered
    /// would fight BT-5's drag-and-drop on the very next save.
    #[test]
    fn the_member_ordering_survives_validation_untouched() {
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            sections: vec![
                SidebarSection {
                    id: "b".into(),
                    name: "나중".into(),
                    order: 7,
                    channel_ids: vec![],
                },
                SidebarSection {
                    id: "a".into(),
                    name: "먼저".into(),
                    order: 2,
                    channel_ids: vec![],
                },
            ],
            ..SidebarPrefs::default()
        })
        .expect("valid");
        assert_eq!(prefs.sections[0].id, "b");
        assert_eq!(prefs.sections[0].order, 7);
        assert_eq!(prefs.sections[1].order, 2);
    }

    /// BT-5 owns the star UI and the sort control; BT-4 owns the fields, so a
    /// payload carrying both round-trips through validation unchanged.
    #[test]
    fn stars_and_section_sort_are_accepted_before_bt5_uses_them() {
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            starred_channel_ids: vec![channel_id(9)],
            section_sort: Some("  alpha  ".into()),
            ..SidebarPrefs::default()
        })
        .expect("valid");
        assert_eq!(prefs.starred_channel_ids, vec![channel_id(9)]);
        assert_eq!(prefs.section_sort.as_deref(), Some("alpha"));
    }

    #[test]
    fn a_blank_section_sort_becomes_absent_rather_than_empty() {
        let prefs = validate_sidebar_prefs(SidebarPrefs {
            section_sort: Some("   ".into()),
            ..SidebarPrefs::default()
        })
        .expect("valid");
        assert_eq!(prefs.section_sort, None);
        let json = serde_json::to_value(&prefs).expect("serialize");
        assert!(
            json.get("sectionSort").is_none(),
            "an absent optional is omitted, never null"
        );
    }

    #[test]
    fn an_over_long_section_sort_is_refused() {
        let prefs = SidebarPrefs {
            section_sort: Some("x".repeat(SECTION_SORT_MAX_CHARS + 1)),
            ..SidebarPrefs::default()
        };
        assert_eq!(
            validate_sidebar_prefs(prefs),
            Err(SidebarPrefsInvalid::SectionSortTooLong)
        );
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_refuses_unknown_keys() {
        let parsed: SidebarPrefs = serde_json::from_value(serde_json::json!({
            "version": 1,
            "sections": [{"id": "s1", "name": "작업", "order": 0, "channelIds": []}],
            "starredChannelIds": [],
        }))
        .expect("camelCase parses");
        assert_eq!(parsed.sections[0].name, "작업");

        assert!(
            serde_json::from_value::<SidebarPrefs>(serde_json::json!({
                "version": 1,
                "sections": [{"id": "s1", "name": "작업", "order": 0, "channel_ids": []}],
            }))
            .is_err(),
            "snake_case is not a second spelling of the contract"
        );

        assert!(
            serde_json::from_value::<SidebarPrefs>(serde_json::json!({
                "version": 1,
                "collapsed": ["channels"],
            }))
            .is_err(),
            "ADR-0177 D4 keeps collapse state on the device — it must not be smuggled in here"
        );
    }
}
