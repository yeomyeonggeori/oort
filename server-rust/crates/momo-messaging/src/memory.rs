//! Team-memory v2 read + settings surface (#3164 / ADR-0196 D6, D7, D9).
//!
//! Every statement here runs as `momo_app` (NOBYPASSRLS) inside a tenant
//! transaction, and **the database decides what a caller may see**: the read
//! policies on `mem_digest` / `mem_evidence` / `mem_serving` / `mem_settings`
//! (migration 100) filter on `app.workspace_id` *and* `app.member_id`. This module
//! therefore
//!
//! * binds `app.member_id` (LOCAL scope) as the first statement of each
//!   transaction — [`bind_mem_reader_guc`]; the memory read functions fail closed
//!   (return no rows) without it — and
//! * adds **no permission predicate of its own**. The only `WHERE` clauses below
//!   select *which* rows the caller asked for (channel, level, page); none of them
//!   re-derives "may this member read it". A second filter could mask a policy
//!   bug, and ADR-0196 D5/D6 forbid app-layer post-filtering.
//!
//! It calls none of the worker-only SQL functions (`mem_apply_digest`,
//! `mem_advance_cursor`, `mem_record_serving`, `mem_digest_rollup_inputs`,
//! `mem_digest_live`, `mem_channel_switch`, `mem_digest_audience_ok`): the grants
//! in migration 100 forbid `momo_app` from executing them. Digests are written by
//! the summary worker (#3162); the only rows `momo_app` writes are `mem_settings`,
//! whose RLS enforces workspace/channel admin and owner-only member rows.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Default / max digest page size.
pub const MEM_DIGEST_LIMIT_DEFAULT: i64 = 20;
pub const MEM_DIGEST_LIMIT_MAX: i64 = 100;

pub fn clamp_mem_digest_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(MEM_DIGEST_LIMIT_MAX),
        _ => MEM_DIGEST_LIMIT_DEFAULT,
    }
}

/// Bind the reader's identity for the memory RLS policies. `SET LOCAL` semantics
/// (`set_config(..., is_local => true)`): the value unwinds with the tenant
/// transaction, so a pooled connection never carries a previous caller's id into
/// the next request. `app.workspace_id` stays in `momo_db::tenant`.
///
/// Must be the first statement of the transaction body, before any `mem_*` read
/// or write.
pub async fn bind_mem_reader_guc(conn: &mut PgConnection, member_id: Uuid) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.member_id', $1, true)")
        .bind(member_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

/// One `mem_digest` row the caller can read. `stale` rows never appear (the read
/// policy hides them until the worker regenerates).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemDigest {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub thread_root_id: Option<Uuid>,
    pub level: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub body: String,
    pub source_count: i32,
    pub model: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// One evidence link: the source message a digest line rests on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemEvidence {
    pub digest_id: Uuid,
    pub message_id: Uuid,
    pub channel_id: Uuid,
    pub seq: i64,
}

const DIGEST_COLS: &str = "d.id, d.channel_id, d.thread_root_id, d.level, d.from_seq, d.to_seq, \
     d.body, d.source_count, d.model, d.created_at";

fn digest_from_row(row: &sqlx::postgres::PgRow) -> Result<MemDigest, sqlx::Error> {
    Ok(MemDigest {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        thread_root_id: row.try_get("thread_root_id")?,
        level: row.try_get("level")?,
        from_seq: row.try_get("from_seq")?,
        to_seq: row.try_get("to_seq")?,
        body: row.try_get("body")?,
        source_count: row.try_get("source_count")?,
        model: row.try_get("model")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Selector for the digests of one channel (or one thread inside it).
#[derive(Debug, Clone, Copy)]
pub struct DigestListFilter<'a> {
    pub channel_id: Uuid,
    /// `Some` = that thread's digests; `None` = the channel-level digests.
    pub thread_root_id: Option<Uuid>,
    pub level: Option<&'a str>,
    /// Only digests that reach past this channel seq (`to_seq > after_seq`).
    pub after_seq: i64,
    /// Keyset: strictly older than `(to_seq, id)` in `to_seq DESC, id DESC` order.
    pub before: Option<(i64, Uuid)>,
    pub limit: i64,
}

/// Digests of one channel/thread, newest first. Which of them the caller may see
/// is entirely the read policy's decision.
pub async fn list_digests_in_tx(
    conn: &mut PgConnection,
    filter: &DigestListFilter<'_>,
) -> Result<Vec<MemDigest>, DbError> {
    let sql = format!(
        "SELECT {DIGEST_COLS} FROM mem_digest d \
          WHERE d.channel_id = $1 \
            AND d.thread_root_id IS NOT DISTINCT FROM $2 \
            AND ($3::text IS NULL OR d.level = $3) \
            AND d.to_seq > $4 \
            AND ($5::bigint IS NULL OR (d.to_seq, d.id) < ($5, $6)) \
          ORDER BY d.to_seq DESC, d.id DESC \
          LIMIT $7"
    );
    let rows = sqlx::query(&sql)
        .bind(filter.channel_id)
        .bind(filter.thread_root_id)
        .bind(filter.level)
        .bind(filter.after_seq)
        .bind(filter.before.map(|(seq, _)| seq))
        .bind(filter.before.map(|(_, id)| id).unwrap_or_else(Uuid::nil))
        .bind(filter.limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(digest_from_row)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// One digest by id; `None` when it does not exist **or** the policy hides it
/// (the caller cannot tell which — a 404 either way).
pub async fn get_digest_in_tx(
    conn: &mut PgConnection,
    digest_id: Uuid,
) -> Result<Option<MemDigest>, DbError> {
    let sql = format!("SELECT {DIGEST_COLS} FROM mem_digest d WHERE d.id = $1");
    let row = sqlx::query(&sql)
        .bind(digest_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(digest_from_row)
        .transpose()
        .map_err(DbError::from)
}

/// Several digests by id (the ones a receipt names). Policy-hidden ids are
/// absent from the result.
pub async fn digests_by_ids_in_tx(
    conn: &mut PgConnection,
    digest_ids: &[Uuid],
) -> Result<Vec<MemDigest>, DbError> {
    if digest_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {DIGEST_COLS} FROM mem_digest d WHERE d.id = ANY($1) \
          ORDER BY d.to_seq DESC, d.id DESC"
    );
    let rows = sqlx::query(&sql)
        .bind(digest_ids)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(digest_from_row)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Evidence links for the given digests, in message order. `mem_evidence` has its
/// own read policy; a digest the caller can read has all its evidence readable.
pub async fn evidence_for_digests_in_tx(
    conn: &mut PgConnection,
    digest_ids: &[Uuid],
) -> Result<Vec<MemEvidence>, DbError> {
    if digest_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT e.digest_id, e.message_id, e.channel_id, m.seq \
           FROM mem_evidence e \
           JOIN message m ON m.id = e.message_id AND m.workspace_id = e.workspace_id \
          WHERE e.digest_id = ANY($1) \
          ORDER BY e.digest_id, m.seq, e.message_id",
    )
    .bind(digest_ids)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(MemEvidence {
                digest_id: row.try_get("digest_id")?,
                message_id: row.try_get("message_id")?,
                channel_id: row.try_get("channel_id")?,
                seq: row.try_get("seq")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// The caller's own read cursor in a channel (`read_state.last_read_seq`), the
/// "since my last read" anchor. `0` when they have never opened it.
pub async fn last_read_seq_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<i64, DbError> {
    let seq: Option<i64> = sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(seq.unwrap_or(0))
}

/// How far the summary worker has processed a channel (`mem_cursor.last_seq`).
/// `None` when it has not started or the caller cannot read the channel. Lets a
/// client tell "nothing to summarize" from "not summarized yet".
pub async fn summarized_through_seq_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<Option<i64>, DbError> {
    let seq: Option<i64> =
        sqlx::query_scalar("SELECT last_seq FROM mem_cursor WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(seq)
}

// ---------------------------------------------------------------------------
// receipts
// ---------------------------------------------------------------------------

/// The receipt of one agent run (`mem_serving`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemServing {
    pub run_id: Uuid,
    pub channel_id: Uuid,
    /// Digest ids the run was served, as recorded (some may no longer be
    /// readable by the caller).
    pub digest_ids: Vec<Uuid>,
    pub item_ids: Vec<Uuid>,
    /// `Some` only for the run's requester (the trigger message's author) —
    /// ADR-0196 D7: the withheld count is shown to the requester, count only.
    pub withheld_count: Option<i32>,
    pub budget_chars: i32,
    pub used_chars: i32,
    pub created_at: DateTime<Utc>,
}

/// The receipt for `run_id`; `None` when there is none or the caller cannot read
/// the channel the answer went to. `withheld_count` is gated in the same query.
pub async fn get_serving_in_tx(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<Option<MemServing>, DbError> {
    let row = sqlx::query(
        "SELECT s.run_id, s.channel_id, s.digest_ids, s.item_ids, s.budget_chars, s.used_chars, \
                s.created_at, \
                CASE WHEN tm.author_member_id IS NOT NULL \
                      AND tm.author_member_id = \
                          nullif(pg_catalog.current_setting('app.member_id', true), '')::uuid \
                     THEN s.withheld_count END AS withheld_count \
           FROM mem_serving s \
           JOIN agent_run r ON r.id = s.run_id AND r.workspace_id = s.workspace_id \
           LEFT JOIN message tm \
             ON tm.id = r.trigger_message_id AND tm.workspace_id = r.workspace_id \
          WHERE s.run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    // #3163 F1: a receipt that lists nothing exists only to carry the requester's withheld
    // count. To anyone else its very existence would leak one bit ("something was withheld"),
    // so a non-requester gets the same 404 as "no receipt".
    let row = row.filter(|row| {
        let withheld: Option<i32> = row.try_get("withheld_count").ok().flatten();
        let digests: Vec<Uuid> = row.try_get("digest_ids").unwrap_or_default();
        let items: Vec<Uuid> = row.try_get("item_ids").unwrap_or_default();
        withheld.is_some() || !digests.is_empty() || !items.is_empty()
    });
    row.map(|row| {
        Ok(MemServing {
            run_id: row.try_get("run_id")?,
            channel_id: row.try_get("channel_id")?,
            digest_ids: row.try_get("digest_ids")?,
            item_ids: row.try_get("item_ids")?,
            withheld_count: row.try_get("withheld_count")?,
            budget_chars: row.try_get("budget_chars")?,
            used_chars: row.try_get("used_chars")?,
            created_at: row.try_get("created_at")?,
        })
    })
    .transpose()
    .map_err(|e: sqlx::Error| DbError::from(e))
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/// One `mem_settings` row the caller may read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemSettingsRow {
    pub scope: String,
    pub channel_id: Option<Uuid>,
    pub member_id: Option<Uuid>,
    pub enabled: bool,
    pub paused: bool,
    pub excluded: bool,
    pub daily_token_cap: Option<i32>,
    pub reset_epoch: i64,
    pub updated_at: DateTime<Utc>,
}

const SETTINGS_COLS: &str = "scope, channel_id, member_id, enabled, paused, excluded, \
     daily_token_cap, reset_epoch, updated_at";

fn settings_from_row(row: &sqlx::postgres::PgRow) -> Result<MemSettingsRow, sqlx::Error> {
    Ok(MemSettingsRow {
        scope: row.try_get("scope")?,
        channel_id: row.try_get("channel_id")?,
        member_id: row.try_get("member_id")?,
        enabled: row.try_get("enabled")?,
        paused: row.try_get("paused")?,
        excluded: row.try_get("excluded")?,
        daily_token_cap: row.try_get("daily_token_cap")?,
        reset_epoch: row.try_get("reset_epoch")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Every settings row the read policy lets the caller see: the workspace row,
/// the channel rows of channels they can read, and their own member row.
pub async fn list_settings_in_tx(conn: &mut PgConnection) -> Result<Vec<MemSettingsRow>, DbError> {
    let sql = format!("SELECT {SETTINGS_COLS} FROM mem_settings ORDER BY scope, channel_id");
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await?;
    rows.iter()
        .map(settings_from_row)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Upsert the workspace-scope row. `None` leaves that column as it is (or the
/// default on first write). **Always an upsert, never a bare `UPDATE`**: a bare
/// `UPDATE` whose row the policy hides affects 0 rows silently, whereas the
/// upsert makes Postgres raise `42501` when the INSERT `WITH CHECK` or the
/// conflicting row's `USING` fails — the route maps that to 403.
pub async fn upsert_workspace_settings_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    enabled: Option<bool>,
    paused: Option<bool>,
) -> Result<MemSettingsRow, DbError> {
    let sql = format!(
        "INSERT INTO mem_settings (workspace_id, scope, enabled, paused) \
         VALUES ($1, 'workspace', COALESCE($2, true), COALESCE($3, false)) \
         ON CONFLICT (workspace_id) WHERE scope = 'workspace' DO UPDATE SET \
           enabled = COALESCE($2, mem_settings.enabled), \
           paused = COALESCE($3, mem_settings.paused), \
           updated_at = now() \
         RETURNING {SETTINGS_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(enabled)
        .bind(paused)
        .fetch_one(&mut *conn)
        .await?;
    settings_from_row(&row).map_err(DbError::from)
}

/// Upsert one channel's row (`excluded`, `paused`). See
/// [`upsert_workspace_settings_in_tx`] for why this is an upsert.
pub async fn upsert_channel_settings_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    excluded: Option<bool>,
    paused: Option<bool>,
) -> Result<MemSettingsRow, DbError> {
    let sql = format!(
        "INSERT INTO mem_settings (workspace_id, scope, channel_id, excluded, paused) \
         VALUES ($1, 'channel', $2, COALESCE($3, false), COALESCE($4, false)) \
         ON CONFLICT (workspace_id, channel_id) WHERE scope = 'channel' DO UPDATE SET \
           excluded = COALESCE($3, mem_settings.excluded), \
           paused = COALESCE($4, mem_settings.paused), \
           updated_at = now() \
         RETURNING {SETTINGS_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(excluded)
        .bind(paused)
        .fetch_one(&mut *conn)
        .await?;
    settings_from_row(&row).map_err(DbError::from)
}

/// Upsert the caller's personal pause. The member id is the credential's — the
/// route never takes one from the request; the policy additionally pins member
/// rows to `app.member_id`.
pub async fn upsert_member_settings_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    paused: bool,
) -> Result<MemSettingsRow, DbError> {
    let sql = format!(
        "INSERT INTO mem_settings (workspace_id, scope, member_id, paused) \
         VALUES ($1, 'member', $2, $3) \
         ON CONFLICT (workspace_id, member_id) WHERE scope = 'member' DO UPDATE SET \
           paused = $3, updated_at = now() \
         RETURNING {SETTINGS_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(member_id)
        .bind(paused)
        .fetch_one(&mut *conn)
        .await?;
    settings_from_row(&row).map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// items (#3168, ADR-0196 D3/D5/D6) — keyword search
// ---------------------------------------------------------------------------

/// Default / max hits of one item search.
pub const MEM_ITEM_SEARCH_LIMIT_DEFAULT: i64 = 10;
pub const MEM_ITEM_SEARCH_LIMIT_MAX: i64 = 50;

/// One `mem_item` the caller can read, as `mem_search_items` returns it.
#[derive(Debug, Clone, PartialEq)]
pub struct MemItemHit {
    pub id: Uuid,
    pub channel_id: Uuid,
    /// `channel` | `personal`.
    pub space_kind: String,
    /// `decision` | `fact` | `commitment` | `preference` | `procedure`.
    pub kind: String,
    pub body: String,
    pub valid_from: DateTime<Utc>,
    /// `None` = still valid.
    pub valid_to: Option<DateTime<Utc>>,
    pub recorded_at: DateTime<Utc>,
    pub score: f32,
    /// The source messages (ids only; never their text).
    pub evidence_message_ids: Vec<Uuid>,
}

/// Keyword search over the items the caller may read (`mem_search_items`, migration 104): the
/// memory browser's search. **Browsing only**: it takes no audience narrowing. An agent answer that
/// will be posted to a channel must be served through the worker-only `mem_search_items_for`
/// (viewer = the requester, answer channel required), never through this function.
///
/// `mem_search_items` is a `SECURITY DEFINER` function that refuses any session which is not
/// `momo_app` (or a superuser) and reads the viewer from `app.member_id` — [`bind_mem_reader_guc`]
/// must have run first (without it the result is empty). It narrows candidates to the viewer's
/// channels, scores them by trigram word similarity and then applies the *same* readability rule the
/// RLS policy uses (`mem_item_readable_by`); this module adds no permission predicate of its own.
/// The query is cut to 200 characters inside the function.
pub async fn search_items_in_tx(
    conn: &mut PgConnection,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<MemItemHit>, DbError> {
    let limit = match limit {
        Some(value) if value > 0 => value.min(MEM_ITEM_SEARCH_LIMIT_MAX),
        _ => MEM_ITEM_SEARCH_LIMIT_DEFAULT,
    };
    let rows = sqlx::query(
        "SELECT id, channel_id, space_kind, kind, body, valid_from, valid_to, recorded_at, score, \
                evidence_message_ids \
           FROM mem_search_items($1, $2::integer)",
    )
    .bind(query)
    .bind(limit as i32)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| MemItemHit {
            id: row.get("id"),
            channel_id: row.get("channel_id"),
            space_kind: row.get("space_kind"),
            kind: row.get("kind"),
            body: row.get("body"),
            valid_from: row.get("valid_from"),
            valid_to: row.get("valid_to"),
            recorded_at: row.get("recorded_at"),
            score: row.get("score"),
            evidence_message_ids: row
                .get::<Option<Vec<Uuid>>, _>("evidence_message_ids")
                .unwrap_or_default(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// served items (a receipt's item list) and 「기억해 둘게요」 proposals (#3169)
// ---------------------------------------------------------------------------

/// One item a receipt names, as the caller may read it today. Items the caller cannot read (the
/// evidence was deleted, they left the channel) are absent — the read policy hides them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemItemBrief {
    pub id: Uuid,
    pub channel_id: Uuid,
    /// `decision` | `fact` | `commitment` | `preference` | `procedure`.
    pub kind: String,
    /// `extracted` | `confirmed` | `curated` | `synthesized`.
    pub origin: String,
    pub body: String,
    pub valid_from: DateTime<Utc>,
    pub source_count: i32,
}

/// Items by id (the ones a receipt names) in the order given. **No permission predicate here**:
/// `mem_item`'s own read policy (`mem_item_evidence_ok`, viewer = `app.member_id`) hides what the
/// caller may not read, exactly as [`digests_by_ids_in_tx`] relies on `mem_digest`'s.
pub async fn items_by_ids_in_tx(
    conn: &mut PgConnection,
    item_ids: &[Uuid],
) -> Result<Vec<MemItemBrief>, DbError> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT i.id, i.channel_id, i.kind, i.origin, i.body, i.valid_from, i.source_count \
           FROM mem_item i WHERE i.id = ANY($1) \
          ORDER BY array_position($1, i.id)",
    )
    .bind(item_ids)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(MemItemBrief {
                id: row.try_get("id")?,
                channel_id: row.try_get("channel_id")?,
                kind: row.try_get("kind")?,
                origin: row.try_get("origin")?,
                body: row.try_get("body")?,
                valid_from: row.try_get("valid_from")?,
                source_count: row.try_get("source_count")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Default / max proposal page size.
pub const MEM_PROPOSAL_LIMIT_DEFAULT: i64 = 20;
pub const MEM_PROPOSAL_LIMIT_MAX: i64 = 50;

pub fn clamp_mem_proposal_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(MEM_PROPOSAL_LIMIT_MAX),
        _ => MEM_PROPOSAL_LIMIT_DEFAULT,
    }
}

/// One `mem_proposal` the caller can read. A **pending** proposal carries its text; a decided one
/// is a shell (`body` and `evidence_message_ids` are gone — the accepted item holds the text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemProposal {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub run_id: Option<Uuid>,
    pub agent_member_id: Uuid,
    pub requester_member_id: Uuid,
    pub kind: String,
    pub body: Option<String>,
    pub subject_key: Option<String>,
    pub evidence_message_ids: Vec<Uuid>,
    /// `pending` | `accepted` | `rejected`.
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub decided_by: Option<Uuid>,
    pub decided_at: Option<DateTime<Utc>>,
    pub item_id: Option<Uuid>,
}

const PROPOSAL_COLS: &str = "p.id, p.channel_id, p.run_id, p.agent_member_id, \
     p.requester_member_id, p.kind, p.body, p.subject_key, p.evidence_message_ids, p.status, \
     p.created_at, p.expires_at, p.decided_by, p.decided_at, p.item_id";

fn proposal_from_row(row: &sqlx::postgres::PgRow) -> Result<MemProposal, sqlx::Error> {
    Ok(MemProposal {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        run_id: row.try_get("run_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        requester_member_id: row.try_get("requester_member_id")?,
        kind: row.try_get("kind")?,
        body: row.try_get("body")?,
        subject_key: row.try_get("subject_key")?,
        evidence_message_ids: row.try_get("evidence_message_ids")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        expires_at: row.try_get("expires_at")?,
        decided_by: row.try_get("decided_by")?,
        decided_at: row.try_get("decided_at")?,
        item_id: row.try_get("item_id")?,
    })
}

/// Which proposals of a channel the caller asks for. These select *rows*, never permission: the
/// read policy on `mem_proposal` (channel readable, a pending one unexpired and its evidence
/// alive) has already decided what the caller may see.
#[derive(Debug, Clone)]
pub struct ProposalListFilter<'a> {
    pub channel_id: Uuid,
    /// `pending` | `accepted` | `rejected`.
    pub status: &'a str,
    /// Only the proposals one agent run made (the reply's card).
    pub run_id: Option<Uuid>,
    pub limit: i64,
}

pub async fn list_proposals_in_tx(
    conn: &mut PgConnection,
    filter: &ProposalListFilter<'_>,
) -> Result<Vec<MemProposal>, DbError> {
    let sql = format!(
        "SELECT {PROPOSAL_COLS} FROM mem_proposal p \
          WHERE p.channel_id = $1 AND p.status = $2 \
            AND ($3::uuid IS NULL OR p.run_id = $3) \
          ORDER BY p.created_at DESC, p.id DESC LIMIT $4"
    );
    let rows = sqlx::query(&sql)
        .bind(filter.channel_id)
        .bind(filter.status)
        .bind(filter.run_id)
        .bind(filter.limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(proposal_from_row)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// One proposal by id; `None` when it does not exist or the policy hides it.
pub async fn get_proposal_in_tx(
    conn: &mut PgConnection,
    proposal_id: Uuid,
) -> Result<Option<MemProposal>, DbError> {
    let sql = format!("SELECT {PROPOSAL_COLS} FROM mem_proposal p WHERE p.id = $1");
    let row = sqlx::query(&sql)
        .bind(proposal_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(proposal_from_row)
        .transpose()
        .map_err(DbError::from)
}

/// Accept a proposal (`mem_accept_proposal`, migration 105): the new (or already remembered)
/// item's id. The function is `SECURITY DEFINER`, refuses any session that is not `momo_app`, and
/// takes the deciding member from `app.member_id` ([`bind_mem_reader_guc`] must have run) — there is
/// no member argument to forge. SQLSTATEs: `42501` not allowed (also: unknown id), `55000` already
/// decided / expired / memory off here, `23503` an evidence message is gone or unreadable to the
/// accepter, `40001` evidence edited since the proposal, `23514` content refused.
pub async fn accept_proposal_in_tx(
    conn: &mut PgConnection,
    proposal_id: Uuid,
) -> Result<Uuid, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_accept_proposal($1)")
        .bind(proposal_id)
        .fetch_one(&mut *conn)
        .await?)
}

/// Reject a proposal (`mem_reject_proposal`): same authority as accepting; logs a `mem_event`.
pub async fn reject_proposal_in_tx(
    conn: &mut PgConnection,
    proposal_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query_scalar::<_, bool>("SELECT mem_reject_proposal($1)")
        .bind(proposal_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_limit_clamps_to_default_and_max() {
        assert_eq!(clamp_mem_digest_limit(None), MEM_DIGEST_LIMIT_DEFAULT);
        assert_eq!(clamp_mem_digest_limit(Some(0)), MEM_DIGEST_LIMIT_DEFAULT);
        assert_eq!(clamp_mem_digest_limit(Some(-3)), MEM_DIGEST_LIMIT_DEFAULT);
        assert_eq!(clamp_mem_digest_limit(Some(7)), 7);
        assert_eq!(clamp_mem_digest_limit(Some(10_000)), MEM_DIGEST_LIMIT_MAX);
    }
}
