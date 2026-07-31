//! Workspace message search — read-only, tenant-scoped, membership-filtered
//! (B1.2). Ports Swift `SearchRoutes.swift` (:19-214).
//!
//! ## Why `ILIKE` and not a tsvector
//!
//! `message_body_trgm_idx` (`001_init.sql:196`) is a `gin (body gin_trgm_ops)`
//! index over live, non-null bodies. `pg_trgm` answers **`ILIKE '%needle%'`** —
//! substring containment — from that index, which is the parity target: the
//! query matches inside words and across languages that do not tokenize on
//! spaces, and it needs no stemming configuration per language. A tsvector would
//! be a different product decision (and a migration), so it is deliberately not
//! made here.
//!
//! Three things keep the surface honest, all of them Swift's:
//!   * **`%`, `_`, `\` in the query are literal text** ([`literal_like_pattern`])
//!     — a user searching for `50%` is not writing a wildcard.
//!   * **Membership is a JOIN, not a filter applied afterwards** — a hit can only
//!     come from a channel the caller has not left, so search cannot become a
//!     read-side hole around private channels.
//!   * **The cursor is the full `(created_at, seq, id)` tuple**, matching the
//!     `ORDER BY`, so paging is total: no row is skipped or repeated when two
//!     messages share a timestamp.
//!
//! The pgvector *memory plane* (migrations 027/028) is a separate surface and is
//! deliberately out of scope.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_db::DbError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Default page size (Swift `?? 20`).
pub const SEARCH_LIMIT_DEFAULT: i64 = 20;
/// Maximum page size (Swift `min(max(…, 1), 50)`).
pub const SEARCH_LIMIT_MAX: i64 = 50;
/// Minimum query length (Swift `query.count >= 2`).
pub const SEARCH_QUERY_MIN_CHARS: usize = 2;

/// One search hit (Swift `WorkspaceMessageSearchHitDTO`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub seq: i64,
    pub author_member_id: Uuid,
    /// Microseconds since the epoch. The wire DTO divides by 1000; the cursor
    /// keeps the full precision so paging cannot collapse two messages written
    /// in the same millisecond.
    pub created_at_micros: i64,
    /// Body window around the first match, bounded by the server.
    pub snippet: String,
    /// Zero-based offset of the match inside `snippet`.
    pub match_offset: i32,
}

impl SearchHit {
    /// The cursor that resumes paging *after* this hit.
    pub fn cursor(&self) -> SearchCursor {
        SearchCursor {
            created_at_micros: self.created_at_micros,
            seq: self.seq,
            message_id: self.message_id,
        }
    }
}

/// The opaque page cursor.
///
/// Field order and names are the Swift `SearchRoutes.Cursor` property order and
/// names, and `messageID` serializes as Foundation's **uppercase** UUID string,
/// because a cursor minted by one server must be accepted by the other. Decoding
/// stays case-insensitive (`Uuid::parse_str`), so a lowercase cursor from an
/// older client still works.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchCursor {
    #[serde(rename = "createdAtMicros")]
    pub created_at_micros: i64,
    pub seq: i64,
    #[serde(
        rename = "messageID",
        serialize_with = "serialize_uuid_uppercase",
        deserialize_with = "deserialize_uuid_any_case"
    )]
    pub message_id: Uuid,
}

fn serialize_uuid_uppercase<S: Serializer>(id: &Uuid, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&id.to_string().to_uppercase())
}

fn deserialize_uuid_any_case<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
    let raw = String::deserialize(deserializer)?;
    Uuid::parse_str(&raw).map_err(serde::de::Error::custom)
}

/// Why a search request was refused before touching the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SearchRequestInvalid {
    /// Swift: 400 `q must contain at least 2 characters`. A one-character
    /// trigram query would scan the table, so this is a cost guard as much as a
    /// usability one.
    #[error("q must contain at least 2 characters")]
    QueryTooShort,
    /// Swift: 400 `invalid cursor` — unparseable, or carrying a negative
    /// position that no row can have.
    #[error("invalid cursor")]
    InvalidCursor,
}

/// Trim and length-check the query (Swift `normalizedQuery`).
pub fn normalize_query(raw: Option<&str>) -> Result<String, SearchRequestInvalid> {
    let query = raw.unwrap_or("").trim().to_string();
    if query.chars().count() < SEARCH_QUERY_MIN_CHARS {
        return Err(SearchRequestInvalid::QueryTooShort);
    }
    Ok(query)
}

/// Clamp the page size to `1..=50`, defaulting to 20 (Swift's clamp).
pub fn clamp_search_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(SEARCH_LIMIT_DEFAULT)
        .clamp(1, SEARCH_LIMIT_MAX)
}

/// Escape `\`, `%` and `_` so the query is matched as literal text, then wrap it
/// in `%…%` (Swift `literalLikePattern`).
pub fn literal_like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Encode a cursor for the wire: base64url, unpadded (Swift replaces `+`/`/`
/// and strips `=`, which is exactly base64url-no-pad).
pub fn encode_search_cursor(cursor: &SearchCursor) -> String {
    let json = serde_json::to_vec(cursor).expect("cursor serializes");
    URL_SAFE_NO_PAD.encode(json)
}

/// Decode a wire cursor, rejecting anything unparseable or negative.
pub fn decode_search_cursor(encoded: &str) -> Result<SearchCursor, SearchRequestInvalid> {
    // Swift re-pads before decoding, so a padded cursor from an older client is
    // still valid input; accept both spellings.
    let normalized = encoded.trim_end_matches('=');
    let bytes = URL_SAFE_NO_PAD
        .decode(normalized)
        .map_err(|_| SearchRequestInvalid::InvalidCursor)?;
    let cursor: SearchCursor =
        serde_json::from_slice(&bytes).map_err(|_| SearchRequestInvalid::InvalidCursor)?;
    if cursor.created_at_micros < 0 || cursor.seq < 0 {
        return Err(SearchRequestInvalid::InvalidCursor);
    }
    Ok(cursor)
}

/// A page of hits plus the cursor for the next one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub next_cursor: Option<SearchCursor>,
}

/// The `SELECT` list shared by the cursored and un-cursored queries. `$3` is the
/// raw query text (used for the snippet window), never the LIKE pattern.
const SEARCH_COLS: &str = "m.channel_id AS channel_id, \
     m.id AS message_id, \
     m.seq AS seq, \
     m.author_member_id AS author_member_id, \
     round(extract(epoch FROM m.created_at) * 1000000)::bigint AS created_at_micros, \
     substring(m.body FROM greatest(strpos(lower(m.body), lower($3)) - 80, 1) \
                       FOR char_length($3) + 160) AS snippet, \
     (strpos(lower(m.body), lower($3)) \
        - greatest(strpos(lower(m.body), lower($3)) - 80, 1))::int AS match_offset";

/// The membership-scoped FROM/WHERE both variants share.
const SEARCH_FROM: &str = "FROM message m \
     JOIN membership ms \
       ON ms.workspace_id = m.workspace_id \
      AND ms.channel_id = m.channel_id \
      AND ms.member_id = $2 \
      AND ms.left_at IS NULL \
     JOIN member caller \
       ON caller.id = ms.member_id \
      AND caller.workspace_id = m.workspace_id \
      AND caller.status = 'active' \
      AND caller.deleted_at IS NULL \
    WHERE m.workspace_id = $1 \
      AND m.deleted_at IS NULL \
      AND m.body IS NOT NULL \
      AND m.body ILIKE $4";

fn decode_hit(row: &sqlx::postgres::PgRow) -> Result<SearchHit, sqlx::Error> {
    Ok(SearchHit {
        channel_id: row.try_get("channel_id")?,
        message_id: row.try_get("message_id")?,
        seq: row.try_get("seq")?,
        author_member_id: row.try_get("author_member_id")?,
        created_at_micros: row.try_get("created_at_micros")?,
        snippet: row.try_get("snippet")?,
        match_offset: row.try_get("match_offset")?,
    })
}

/// Search the caller's readable messages, newest first.
///
/// `limit` is the page size; one extra row is fetched to decide whether a next
/// cursor exists, and is not returned.
pub async fn search_messages(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    query: &str,
    cursor: Option<SearchCursor>,
    limit: i64,
) -> Result<SearchPage, DbError> {
    let pattern = literal_like_pattern(query);
    let order = "ORDER BY m.created_at DESC, m.seq DESC, m.id DESC LIMIT $5";

    let rows = match cursor {
        None => {
            let sql = format!("SELECT {SEARCH_COLS} {SEARCH_FROM} {order}");
            sqlx::query(&sql)
                .bind(workspace_id)
                .bind(member_id)
                .bind(query)
                .bind(&pattern)
                .bind(limit + 1)
                .fetch_all(&mut *conn)
                .await?
        }
        Some(cursor) => {
            let sql = format!(
                "SELECT {SEARCH_COLS} {SEARCH_FROM} \
                   AND (m.created_at, m.seq, m.id) < ( \
                         to_timestamp($6::double precision / 1000000.0), $7, $8) \
                 {order}"
            );
            sqlx::query(&sql)
                .bind(workspace_id)
                .bind(member_id)
                .bind(query)
                .bind(&pattern)
                .bind(limit + 1)
                .bind(cursor.created_at_micros)
                .bind(cursor.seq)
                .bind(cursor.message_id)
                .fetch_all(&mut *conn)
                .await?
        }
    };

    let decoded: Vec<SearchHit> = rows
        .iter()
        .map(decode_hit)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)?;
    let has_more = decoded.len() as i64 > limit;
    let hits: Vec<SearchHit> = decoded.into_iter().take(limit as usize).collect();
    let next_cursor = if has_more {
        hits.last().map(SearchHit::cursor)
    } else {
        None
    };
    Ok(SearchPage { hits, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_one_character_query_is_refused() {
        assert_eq!(
            normalize_query(Some(" a ")),
            Err(SearchRequestInvalid::QueryTooShort)
        );
        assert_eq!(
            normalize_query(None),
            Err(SearchRequestInvalid::QueryTooShort)
        );
        assert_eq!(normalize_query(Some("  ab  ")), Ok("ab".to_string()));
    }

    #[test]
    fn limits_clamp_to_the_swift_bounds() {
        assert_eq!(clamp_search_limit(None), 20);
        assert_eq!(clamp_search_limit(Some(0)), 1);
        assert_eq!(clamp_search_limit(Some(-3)), 1);
        assert_eq!(clamp_search_limit(Some(30)), 30);
        assert_eq!(clamp_search_limit(Some(9_000)), 50);
    }

    /// A user searching for `100%` or `foo_bar` is searching for text, not
    /// writing a pattern. Drop the escaping and both become wildcards.
    #[test]
    fn like_metacharacters_are_matched_literally() {
        assert_eq!(literal_like_pattern("100%"), "%100\\%%");
        assert_eq!(literal_like_pattern("foo_bar"), "%foo\\_bar%");
        assert_eq!(literal_like_pattern("a\\b"), "%a\\\\b%");
        assert_eq!(literal_like_pattern("plain"), "%plain%");
    }

    #[test]
    fn cursors_round_trip_and_carry_swift_key_names() {
        let cursor = SearchCursor {
            created_at_micros: 1_764_547_200_123_456,
            seq: 42,
            message_id: Uuid::from_u128(0xfeed),
        };
        let encoded = encode_search_cursor(&cursor);
        assert_eq!(decode_search_cursor(&encoded), Ok(cursor));

        // base64url, unpadded — the exact alphabet Swift produces.
        assert!(!encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='));

        let json = String::from_utf8(URL_SAFE_NO_PAD.decode(&encoded).unwrap()).unwrap();
        assert!(json.contains("\"createdAtMicros\""), "{json}");
        assert!(json.contains("\"messageID\""), "{json}");
        assert!(
            json.contains(&cursor.message_id.to_string().to_uppercase()),
            "Foundation renders UUIDs uppercase; a lowercase cursor would not \
             round-trip through the Swift server: {json}"
        );
    }

    #[test]
    fn a_padded_or_lowercase_cursor_still_decodes() {
        let cursor = SearchCursor {
            created_at_micros: 1,
            seq: 2,
            message_id: Uuid::from_u128(3),
        };
        let padded = format!("{}==", encode_search_cursor(&cursor));
        assert_eq!(decode_search_cursor(&padded), Ok(cursor));

        let lowercase = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "createdAtMicros": 1,
                "seq": 2,
                "messageID": cursor.message_id.to_string(),
            })
            .to_string(),
        );
        assert_eq!(decode_search_cursor(&lowercase), Ok(cursor));
    }

    #[test]
    fn a_garbage_or_negative_cursor_is_a_rejection_not_a_scan() {
        assert_eq!(
            decode_search_cursor("!!!not-base64!!!"),
            Err(SearchRequestInvalid::InvalidCursor)
        );
        let negative = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "createdAtMicros": -1,
                "seq": 0,
                "messageID": Uuid::nil().to_string().to_uppercase(),
            })
            .to_string(),
        );
        assert_eq!(
            decode_search_cursor(&negative),
            Err(SearchRequestInvalid::InvalidCursor)
        );
    }
}
