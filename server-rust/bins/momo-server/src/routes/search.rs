//! Workspace message search (B1.2) — `GET /v1/workspaces/{ws}/search/messages`,
//! the Swift path verbatim (`SearchRoutes.swift:16`).
//!
//! Read-only by construction: no outbox row, no audit row, no write of any kind
//! (Swift says the same in its header). The tenant transaction exists purely to
//! carry the RLS GUC.
//!
//! Two guards, both Swift's, both before the query:
//!   * `q` must be at least 2 characters — a single-character trigram query is a
//!     table scan wearing an index's clothes;
//!   * a malformed `cursor` is a 400, not a silent restart from page 1, because
//!     silently restarting makes a paging bug look like duplicate results.
//!
//! Membership is enforced *inside* the query (a JOIN on `membership`), not by
//! filtering afterwards, so search can never become a read-side hole around a
//! private channel. See `momo_messaging::search` for the pg_trgm reasoning.
//!
//! ## The optional `channel=` scope (#1931 / BT-3)
//!
//! `channel=<uuid>` narrows the search to one channel. Three guards, in this
//! order, and the order is the existing route's:
//!   1. the workspace scope and the caller's active workspace role — unchanged,
//!      and still first, so a non-member never learns whether a channel id
//!      resolves;
//!   2. the caller's **channel** membership, checked explicitly with
//!      `is_channel_member`. RLS plus the membership JOIN already make an
//!      unauthorized channel return nothing, so this check does not decide what
//!      the caller may read — it decides what they are *told*. An empty 200
//!      would answer "this channel has no matches" for a channel they may not
//!      read at all, and that is a membership oracle. A **404** is the answer,
//!      and it is the same 404 a channel that does not exist gets: both come
//!      from `is_channel_member` returning false, so the two cases are
//!      indistinguishable by construction rather than by care (`reminder.rs`
//!      makes the same choice for the same reason);
//!   3. the cursor's sealed scope (`SearchScope::accept_cursor`).
//!
//! ## Agent bearers: unchanged, deliberately
//!
//! `GET …/search/messages` is **absent** from `momo_auth::required_agent_scope`,
//! so no agent credential reaches this route in either scope, and #1931 does not
//! change that. The allow-list is closed by default (`agent_scope.rs`): adding a
//! query parameter to a human route is not a reason to open it to agents, and
//! ADR-0173 opened exactly two reads (`messages`, `replies`) and named neither
//! search. Removing search from an agent's reach is equally out of scope — it is
//! already out of reach. So: no edit to the table, and this paragraph is why.
//!
//! ## Measured deviation: no per-member rate limit
//!
//! Swift wraps this route in the **shared** `SlidingWindowRateLimiter` instance
//! its middleware stack owns (30 requests / 60 s, keyed `search:member:<id>`).
//! momo-server has no rate-limit middleware yet, so there is no shared limiter to
//! reuse. A route-local one would be a *different* control — its own bucket,
//! reset independently of the global per-member budget — so this batch records
//! the gap instead of shipping a look-alike. Follow-up: port the middleware,
//! then re-key this route onto it.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, clamp_search_limit, decode_search_cursor, encode_search_cursor,
    is_channel_member, normalize_query, search_messages, SearchHit, SearchPage, SearchScope,
};

use crate::dto::{SearchQuery, WorkspaceMessageSearchHitDto, WorkspaceMessageSearchResponse};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

fn hit_dto(hit: &SearchHit) -> WorkspaceMessageSearchHitDto {
    WorkspaceMessageSearchHitDto {
        channel_id: hit.channel_id.to_string(),
        message_id: hit.message_id.to_string(),
        seq: hit.seq,
        author_member_id: hit.author_member_id.to_string(),
        // Microseconds are the cursor's precision; the wire has always been ms.
        created_at_ms: hit.created_at_micros / 1000,
        snippet: hit.snippet.clone(),
        match_offset: hit.match_offset,
    }
}

/// `GET /v1/workspaces/{ws}/search/messages?q=&limit=&cursor=&channel=`
pub async fn messages(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<WorkspaceMessageSearchResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let scope = query
        .scope()
        .map_err(|_| ApiError::bad_request("invalid channel id"))?;
    let needle = normalize_query(query.q.as_deref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let limit = clamp_search_limit(query.limit());
    let cursor = match query.cursor.as_deref() {
        None => None,
        Some(raw) => Some(
            decode_search_cursor(raw)
                .and_then(|cursor| scope.accept_cursor(cursor))
                .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?,
        ),
    };

    let outcome: DbRejectable<SearchPage> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not an active workspace member")));
                }
                // Layered over RLS and over the membership JOIN, not instead of
                // them: those two decide what comes back, this one decides that
                // an unreadable channel is a 404 rather than an empty page.
                if let SearchScope::Channel(channel_id) = scope {
                    if !is_channel_member(conn, channel_id, principal.member_id).await? {
                        return Ok(Err(ApiError::not_found("channel not found")));
                    }
                }
                Ok(Ok(search_messages(
                    conn,
                    workspace_id,
                    principal.member_id,
                    scope,
                    &needle,
                    cursor,
                    limit,
                )
                .await?))
            })
        })
        .await;

    let page = settle_db("search.messages", outcome)?;
    Ok(Json(WorkspaceMessageSearchResponse {
        hits: page.hits.iter().map(hit_dto).collect(),
        next_cursor: page.next_cursor.as_ref().map(encode_search_cursor),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use uuid::Uuid;

    fn hit() -> SearchHit {
        SearchHit {
            channel_id: Uuid::from_u128(1),
            message_id: Uuid::from_u128(2),
            seq: 12,
            author_member_id: Uuid::from_u128(3),
            created_at_micros: 1_764_547_200_123_456,
            snippet: "…found the needle here…".into(),
            match_offset: 10,
        }
    }

    #[test]
    fn the_hit_wire_shape_matches_swift() {
        let json = serde_json::to_value(hit_dto(&hit())).expect("serialize");
        assert_eq!(json["channelId"], Uuid::from_u128(1).to_string());
        assert_eq!(json["messageId"], Uuid::from_u128(2).to_string());
        assert_eq!(json["seq"], 12);
        assert_eq!(json["authorMemberId"], Uuid::from_u128(3).to_string());
        assert_eq!(json["matchOffset"], 10);
        assert_eq!(
            json["createdAtMs"], 1_764_547_200_123i64,
            "the wire is milliseconds even though the cursor keeps microseconds"
        );
    }

    /// A page with no next cursor must omit the key, not emit `null` — Swift's
    /// `encodeIfPresent` does, and clients branch on `undefined`.
    #[test]
    fn a_last_page_omits_the_cursor_key() {
        let json = serde_json::to_value(WorkspaceMessageSearchResponse {
            hits: vec![hit_dto(&hit())],
            next_cursor: None,
        })
        .expect("serialize");
        assert!(json.get("nextCursor").is_none(), "{json}");
    }

    #[test]
    fn short_queries_and_bad_cursors_are_400s() {
        let short = normalize_query(Some("a"))
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))
            .expect_err("one character");
        assert_eq!(short.status, StatusCode::BAD_REQUEST);
        assert!(short.message.contains("at least 2"), "{}", short.message);

        let bad = decode_search_cursor("%%%")
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))
            .expect_err("garbage cursor");
        assert_eq!(bad.status, StatusCode::BAD_REQUEST);
        assert_eq!(bad.message, "invalid cursor");
    }

    #[test]
    fn a_garbage_limit_falls_back_to_the_default() {
        let query = SearchQuery {
            q: Some("hi".into()),
            limit: Some("banana".into()),
            cursor: None,
            channel: None,
        };
        assert_eq!(clamp_search_limit(query.limit()), 20);
    }

    fn scoped(channel: Option<&str>) -> SearchQuery {
        SearchQuery {
            q: Some("hi".into()),
            limit: None,
            cursor: None,
            channel: channel.map(str::to_string),
        }
    }

    /// The three readings of `channel=` (#1931): absent and blank are the
    /// workspace scope the route has always had, a UUID narrows, and anything
    /// else is a 400 — never a 404, which would claim a channel was looked for.
    #[test]
    fn the_channel_parameter_has_exactly_three_readings() {
        let channel = Uuid::from_u128(0xc0ffee);
        assert_eq!(scoped(None).scope(), Ok(SearchScope::Workspace));
        assert_eq!(scoped(Some("")).scope(), Ok(SearchScope::Workspace));
        assert_eq!(scoped(Some("   ")).scope(), Ok(SearchScope::Workspace));
        assert_eq!(
            scoped(Some(&channel.to_string())).scope(),
            Ok(SearchScope::Channel(channel))
        );
        assert_eq!(
            scoped(Some(&channel.to_string().to_uppercase())).scope(),
            Ok(SearchScope::Channel(channel)),
            "Foundation renders UUIDs uppercase; the same channel is the same scope"
        );

        let rejected = scoped(Some("not-a-uuid"))
            .scope()
            .map_err(|_| ApiError::bad_request("invalid channel id"))
            .expect_err("a malformed channel id");
        assert_eq!(rejected.status, StatusCode::BAD_REQUEST);
        assert_eq!(rejected.message, "invalid channel id");
    }

    /// A cursor is bound to the walk it was minted in, and the route refuses the
    /// swap with a 400 that names the real problem.
    #[test]
    fn a_cursor_from_another_scope_is_a_400_not_a_different_page() {
        let channel = Uuid::from_u128(0xc0ffee);
        let page_one = hit().cursor(SearchScope::Channel(channel));
        let encoded = encode_search_cursor(&page_one);

        assert_eq!(
            decode_search_cursor(&encoded)
                .and_then(|cursor| SearchScope::Channel(channel).accept_cursor(cursor)),
            Ok(page_one),
            "its own scope resumes"
        );

        for swapped in [
            SearchScope::Workspace,
            SearchScope::Channel(Uuid::from_u128(1)),
        ] {
            let error = decode_search_cursor(&encoded)
                .and_then(|cursor| swapped.accept_cursor(cursor))
                .map_err(|invalid| ApiError::bad_request(invalid.to_string()))
                .expect_err("a cursor from another scope");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(
                error.message, "cursor was minted for a different search scope",
                "the client swapped scopes mid-page; \"invalid cursor\" would \
                 send them hunting for a corruption bug they do not have"
            );
        }
    }
}
