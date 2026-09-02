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
//!
//! ## Scope (#1931 / BT-3)
//!
//! A search runs against one [`SearchScope`]: every channel the caller still
//! belongs to, or exactly one of them. Narrowing is a **predicate added to the
//! same membership JOIN**, never a filter over a workspace-wide result set, so a
//! channel-scoped page costs what it looks like it costs and the private-channel
//! guarantee above holds unchanged in both scopes.
//!
//! The scope is also **sealed into the cursor**. Paging keys on
//! `(created_at, seq, id)`, which says nothing about *which* rows were being
//! walked; replaying a channel-scoped cursor against the workspace scope (or
//! against a different channel) would silently resume a different result set at
//! a position that means nothing in it — pages would overlap or skip, and the
//! client would read it as a paging bug rather than as its own mistake. So the
//! cursor carries its channel and a mismatch is refused ([`SearchScope::accept_cursor`]).

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

/// What a search request is scoped to (#1931 / BT-3).
///
/// [`SearchScope::Channel`] carries a channel the **route has already
/// authorized** — this type is a query shape, not a permission. Membership is
/// still the JOIN in [`SEARCH_FROM`], so an unauthorized id narrows the result
/// set to nothing rather than widening it to something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
    /// Every channel the caller has not left — the B1.2 default, and what a
    /// request without `channel=` still means.
    Workspace,
    /// One channel of the caller's.
    Channel(Uuid),
}

impl SearchScope {
    /// The channel this scope narrows to, or `None` for the workspace scope.
    pub fn channel_id(self) -> Option<Uuid> {
        match self {
            SearchScope::Workspace => None,
            SearchScope::Channel(channel_id) => Some(channel_id),
        }
    }

    /// Accept `cursor` only if it was minted under this same scope.
    ///
    /// A cursor from an older client carries no channel; under the workspace
    /// scope that is the same request it always was, so it is accepted. Under a
    /// channel scope it is not — an un-sealed position cannot be proven to
    /// belong to this narrower walk, and guessing is how pages start skipping
    /// rows.
    pub fn accept_cursor(self, cursor: SearchCursor) -> Result<SearchCursor, SearchRequestInvalid> {
        if cursor.scope_channel_id == self.channel_id() {
            Ok(cursor)
        } else {
            Err(SearchRequestInvalid::CursorScopeMismatch)
        }
    }
}

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
    /// The cursor that resumes paging *after* this hit, under `scope`.
    ///
    /// The scope is an argument rather than a field of the hit because it is a
    /// property of the *request*, not of the row: the same message is a legal
    /// hit under both scopes, and only the request knows which walk this page
    /// belongs to.
    pub fn cursor(&self, scope: SearchScope) -> SearchCursor {
        SearchCursor {
            created_at_micros: self.created_at_micros,
            seq: self.seq,
            message_id: self.message_id,
            scope_channel_id: scope.channel_id(),
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
///
/// `scopeChannelID` (#1931) is the one addition, and it is written **only when a
/// channel scope minted the cursor**: a workspace-scoped cursor is byte-identical
/// to the one this server has always emitted, so no client and no Swift decoder
/// sees a new key on the page it already knew. Decoding defaults it to `None`,
/// so a cursor minted before this field existed still decodes — as the
/// workspace-scoped cursor it in fact was.
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
    /// The channel this cursor was minted under, or `None` for the workspace
    /// scope. Uppercase like `messageID`, for the same Foundation reason.
    #[serde(
        rename = "scopeChannelID",
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_optional_uuid_uppercase",
        deserialize_with = "deserialize_optional_uuid_any_case"
    )]
    pub scope_channel_id: Option<Uuid>,
}

fn serialize_uuid_uppercase<S: Serializer>(id: &Uuid, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&id.to_string().to_uppercase())
}

fn deserialize_uuid_any_case<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
    let raw = String::deserialize(deserializer)?;
    Uuid::parse_str(&raw).map_err(serde::de::Error::custom)
}

fn serialize_optional_uuid_uppercase<S: Serializer>(
    id: &Option<Uuid>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match id {
        // `skip_serializing_if` means this arm is unreachable through the
        // struct; it exists so the helper stays total.
        None => serializer.serialize_none(),
        Some(id) => serializer.serialize_str(&id.to_string().to_uppercase()),
    }
}

fn deserialize_optional_uuid_any_case<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    let raw = Option::<String>::deserialize(deserializer)?;
    match raw {
        None => Ok(None),
        Some(raw) => Uuid::parse_str(&raw)
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
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
    /// 400 (#1931): the cursor decoded, but it was minted under a different
    /// scope. Its own 400 rather than `InvalidCursor` because the cursor is not
    /// malformed — it is being replayed against the wrong result set, and a
    /// client that reads "invalid cursor" will look for a corruption bug it does
    /// not have. Nothing is leaked: the caller already holds both scopes.
    #[error("cursor was minted for a different search scope")]
    CursorScopeMismatch,
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

/// Search the caller's readable messages under `scope`, newest first.
///
/// `limit` is the page size; one extra row is fetched to decide whether a next
/// cursor exists, and is not returned.
///
/// `scope` must already be authorized by the caller (see
/// `routes::search::messages`): this function narrows, it does not admit.
pub async fn search_messages(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    scope: SearchScope,
    query: &str,
    cursor: Option<SearchCursor>,
    limit: i64,
) -> Result<SearchPage, DbError> {
    let pattern = literal_like_pattern(query);
    let order = "ORDER BY m.created_at DESC, m.seq DESC, m.id DESC LIMIT $5";
    // The channel predicate is *appended* to whichever WHERE the variant already
    // built, so the cursor keeps the parameter slots ($6-$8) it has always had
    // and both variants bind in one straight $1..$n order. An
    // `($n IS NULL OR m.channel_id = $n)` predicate bound in every request would
    // read tidier and plan worse — the workspace scope would carry a channel
    // comparison it never needs.
    let scope_clause = match (scope, cursor.is_some()) {
        (SearchScope::Workspace, _) => "",
        (SearchScope::Channel(_), false) => " AND m.channel_id = $6",
        (SearchScope::Channel(_), true) => " AND m.channel_id = $9",
    };

    let rows = match cursor {
        None => {
            let sql = format!("SELECT {SEARCH_COLS} {SEARCH_FROM}{scope_clause} {order}");
            let mut statement = sqlx::query(&sql)
                .bind(workspace_id)
                .bind(member_id)
                .bind(query)
                .bind(&pattern)
                .bind(limit + 1);
            if let Some(channel_id) = scope.channel_id() {
                statement = statement.bind(channel_id);
            }
            statement.fetch_all(&mut *conn).await?
        }
        Some(cursor) => {
            let sql = format!(
                "SELECT {SEARCH_COLS} {SEARCH_FROM} \
                   AND (m.created_at, m.seq, m.id) < ( \
                         to_timestamp($6::double precision / 1000000.0), $7, $8)\
                 {scope_clause} {order}"
            );
            let mut statement = sqlx::query(&sql)
                .bind(workspace_id)
                .bind(member_id)
                .bind(query)
                .bind(&pattern)
                .bind(limit + 1)
                .bind(cursor.created_at_micros)
                .bind(cursor.seq)
                .bind(cursor.message_id);
            if let Some(channel_id) = scope.channel_id() {
                statement = statement.bind(channel_id);
            }
            statement.fetch_all(&mut *conn).await?
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
        hits.last().map(|hit| hit.cursor(scope))
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
            scope_channel_id: None,
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
        assert!(
            !json.contains("scopeChannelID"),
            "a workspace-scoped cursor must stay byte-identical to the pre-#1931 \
             wire — a new key here is a decoder surprise for every older \
             client: {json}"
        );
    }

    #[test]
    fn a_padded_or_lowercase_cursor_still_decodes() {
        let cursor = SearchCursor {
            created_at_micros: 1,
            seq: 2,
            message_id: Uuid::from_u128(3),
            scope_channel_id: None,
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
    /// The sealed half of the scope contract (#1931): the channel rides in the
    /// cursor, and a cursor from the other scope is refused rather than walked.
    #[test]
    fn a_channel_scoped_cursor_carries_its_channel_and_refuses_the_other_scope() {
        let channel = Uuid::from_u128(0xc0ffee);
        let other = Uuid::from_u128(0xbeef);
        let hit = SearchHit {
            channel_id: channel,
            message_id: Uuid::from_u128(7),
            seq: 3,
            author_member_id: Uuid::from_u128(9),
            created_at_micros: 1_764_547_200_000_000,
            snippet: "…".into(),
            match_offset: 0,
        };

        let scoped = hit.cursor(SearchScope::Channel(channel));
        assert_eq!(scoped.scope_channel_id, Some(channel));
        let encoded = encode_search_cursor(&scoped);
        let decoded = decode_search_cursor(&encoded).expect("round-trips");
        assert_eq!(decoded, scoped);
        let json = String::from_utf8(URL_SAFE_NO_PAD.decode(&encoded).unwrap()).unwrap();
        assert!(
            json.contains(&channel.to_string().to_uppercase()),
            "the sealed channel is uppercase like messageID: {json}"
        );

        // Same position, three different walks: only its own is resumed.
        assert_eq!(
            SearchScope::Channel(channel).accept_cursor(decoded),
            Ok(decoded)
        );
        assert_eq!(
            SearchScope::Workspace.accept_cursor(decoded),
            Err(SearchRequestInvalid::CursorScopeMismatch),
            "widening the scope mid-page would resume a bigger result set at a \
             position that means nothing in it"
        );
        assert_eq!(
            SearchScope::Channel(other).accept_cursor(decoded),
            Err(SearchRequestInvalid::CursorScopeMismatch)
        );

        // And the mirror: a workspace cursor may not be narrowed mid-page.
        let unscoped = hit.cursor(SearchScope::Workspace);
        assert_eq!(unscoped.scope_channel_id, None);
        assert_eq!(SearchScope::Workspace.accept_cursor(unscoped), Ok(unscoped));
        assert_eq!(
            SearchScope::Channel(channel).accept_cursor(unscoped),
            Err(SearchRequestInvalid::CursorScopeMismatch)
        );
    }

    /// A cursor minted before #1931 has no `scopeChannelID` at all. It is still
    /// a workspace-scoped cursor, so the workspace scope must keep accepting it
    /// — this is the compatibility half of the seal.
    #[test]
    fn a_pre_scope_cursor_still_pages_the_workspace() {
        let legacy = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "createdAtMicros": 1_764_547_200_123_456i64,
                "seq": 5,
                "messageID": Uuid::from_u128(11).to_string().to_uppercase(),
            })
            .to_string(),
        );
        let decoded = decode_search_cursor(&legacy).expect("an older cursor still decodes");
        assert_eq!(decoded.scope_channel_id, None);
        assert!(SearchScope::Workspace.accept_cursor(decoded).is_ok());
    }

    #[test]
    fn the_scope_reports_its_channel() {
        let channel = Uuid::from_u128(42);
        assert_eq!(SearchScope::Workspace.channel_id(), None);
        assert_eq!(SearchScope::Channel(channel).channel_id(), Some(channel));
    }
}
