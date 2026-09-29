//! Team memory v2 — the SQL half of the summary worker (#3162, ADR-0196 D4/D6/D10).
//!
//! `momo-agent-worker` orchestrates (when to summarise, what to ask the model);
//! everything that touches the database lives here, so the worker binary keeps its
//! "owns no SQL" rule.
//!
//! ## Two kinds of transaction, on purpose
//!
//! * **memory tx** — [`with_memory_tx`]: `BEGIN; SET LOCAL app.workspace_id = …;
//!   SET LOCAL ROLE momo_memory;`. `momo_memory` is `NOLOGIN NOBYPASSRLS` with no table
//!   grants; it may only run the `mem_*` worker functions (100/102 migrations), which
//!   write as `mem_definer`. Every `mem_*` read and write below goes through this. The
//!   connection is `momo_worker` (BYPASSRLS, kept for cross-tenant polling), but inside
//!   this tx it has taken the BYPASSRLS bit off. **No `mem_*` table is ever read by the
//!   plain `momo_worker` session** — after `SET LOCAL ROLE` even `SELECT * FROM message`
//!   fails with 42501, so this tx cannot leak content it does not need.
//! * **read tx** — a plain [`momo_db::with_tenant_tx`] as `momo_worker`: `message`
//!   / `member` / `channel_seq` reads. `momo_worker` bypasses RLS, so tenant scoping here
//!   is *explicit* (`workspace_id = $1 AND channel_id = $2` in every statement) on top of
//!   the GUC. This is the split the #3185 contract prescribes ("원문 메시지는
//!   momo_worker 본래 권한으로 읽되").
//!
//! The two are never one tx: content read, then (outside any tx) the model call, then a
//! memory tx that re-validates the evidence snapshot inside `mem_apply_digest`.

use std::future::Future;
use std::pin::Pin;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use momo_db::{with_tenant_tx_prelude, DbError, PgConnection, PgPool};
use sqlx::Row;
use uuid::Uuid;

/// Bumped whenever the prompt or the digest shape changes; stored on every digest. `digest-v2`
/// (#3168): a window prompt that also returns item candidates (`{summary, items[]}`).
pub const PROMPT_VERSION: &str = "digest-v2";

/// `mem_digest.model_source` for a digest made with the team 「기본 AI」 summary row —
/// ADR-0147's vocabulary (`agent` | `instance_default`), not a new string.
pub const MODEL_SOURCE_INSTANCE_DEFAULT: &str = "instance_default";

/// The audit actions the summary worker writes (`audit_log.action`).
pub const AUDIT_SUMMARY_UNCONFIGURED: &str = "mem.summary.unconfigured";
pub const AUDIT_SUMMARY_TOKEN_CAP: &str = "mem.summary.token_cap_reached";

type Fut<'c, T> = Pin<Box<dyn Future<Output = Result<T, DbError>> + Send + 'c>>;

/// Run `body` in a memory tx (see the module header).
pub async fn with_memory_tx<T, F>(pool: &PgPool, workspace_id: Uuid, body: F) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> Fut<'c, T> + Send,
{
    with_memory_tx_bounded(pool, workspace_id, 5_000, 60_000, body).await
}

/// [`with_memory_tx`] with explicit `lock_timeout` / `statement_timeout` (milliseconds).
///
/// A stuck apply must not hold `FOR KEY SHARE` locks on message rows (which block a member's
/// edit) for long: bounded waits, bounded statements. A lock timeout is 55P03 and is handled
/// like "held by another worker": skip, next sweep. The serving path (#3163) uses a much
/// tighter bound because a reply waits on it.
pub async fn with_memory_tx_bounded<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    lock_timeout_ms: u32,
    statement_timeout_ms: u32,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> Fut<'c, T> + Send,
{
    with_tenant_tx_prelude::<T, DbError, _, _, F>(
        pool,
        workspace_id,
        |_conn| Box::pin(async { Ok(()) }),
        move |conn| {
            Box::pin(async move {
                sqlx::query("SET LOCAL ROLE momo_memory")
                    .execute(&mut *conn)
                    .await?;
                // `SET LOCAL` takes no bind parameters; the values are integers.
                sqlx::query(&format!("SET LOCAL lock_timeout = '{lock_timeout_ms}ms'"))
                    .execute(&mut *conn)
                    .await?;
                sqlx::query(&format!(
                    "SET LOCAL statement_timeout = '{statement_timeout_ms}ms'"
                ))
                .execute(&mut *conn)
                .await?;
                Ok(())
            })
        },
        body,
    )
    .await
}

/// The SQLSTATE of a database error, if it is one.
pub fn sqlstate(error: &DbError) -> Option<String> {
    match error {
        DbError::Sqlx(sqlx::Error::Database(db)) => db.code().map(|c| c.to_string()),
        _ => None,
    }
}

/// Why `mem_apply_digest` / `mem_advance_cursor` said no, in the worker's terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyFailure {
    /// 40001 — a piece of evidence was edited after the worker read it.
    EditedAfterRead,
    /// 23503 — a piece of evidence was deleted after the worker read it (or left the range).
    EvidenceGone,
    /// 55000 — workspace off/paused, channel excluded/paused/archived, human↔human DM.
    Switched,
    /// 55P03 — another worker holds this channel's lease.
    LeaseHeld,
    Other,
}

impl ApplyFailure {
    pub fn classify(error: &DbError) -> ApplyFailure {
        match sqlstate(error).as_deref() {
            Some("40001") => ApplyFailure::EditedAfterRead,
            Some("23503") => ApplyFailure::EvidenceGone,
            Some("55000") => ApplyFailure::Switched,
            Some("55P03") => ApplyFailure::LeaseHeld,
            _ => ApplyFailure::Other,
        }
    }

    /// Worth re-reading the range and trying again (bounded by the caller).
    pub fn retryable(self) -> bool {
        matches!(
            self,
            ApplyFailure::EditedAfterRead | ApplyFailure::EvidenceGone
        )
    }
}

// ---------------------------------------------------------------------------
// memory-tx calls (each is one worker-only SQL function)
// ---------------------------------------------------------------------------

pub async fn channel_eligible(conn: &mut PgConnection, channel_id: Uuid) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_channel_eligible($1)")
        .bind(channel_id)
        .fetch_one(&mut *conn)
        .await?)
}

#[derive(Debug, Clone)]
pub struct CursorState {
    pub last_seq: i64,
    pub lease_token: Option<Uuid>,
    pub leased_until: Option<DateTime<Utc>>,
    pub head_seq: i64,
}

/// `None` when the channel has no `channel_seq` row in this workspace.
pub async fn cursor_state(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<Option<CursorState>, DbError> {
    let row = sqlx::query(
        "SELECT last_seq, lease_token, leased_until, head_seq FROM mem_cursor_state($1)",
    )
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| CursorState {
        last_seq: row.get("last_seq"),
        lease_token: row.get("lease_token"),
        leased_until: row.get("leased_until"),
        head_seq: row.get("head_seq"),
    }))
}

/// Move the watermark to `last_seq` (or leave it where it is) and take/renew the lease
/// for `lease_secs`. `lease_secs = 0` releases it. Raises 55P03 when another token holds
/// a live lease.
pub async fn advance_cursor(
    conn: &mut PgConnection,
    channel_id: Uuid,
    last_seq: i64,
    lease_token: Uuid,
    lease_secs: f64,
) -> Result<i64, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT mem_advance_cursor($1, $2, $3, now() + make_interval(secs => $4))",
    )
    .bind(channel_id)
    .bind(last_seq)
    .bind(lease_token)
    .bind(lease_secs)
    .fetch_one(&mut *conn)
    .await?)
}

#[derive(Debug, Clone)]
pub struct DigestIndexRow {
    pub id: Uuid,
    pub thread_root_id: Option<Uuid>,
    pub from_seq: i64,
    pub to_seq: i64,
    pub stale: bool,
}

pub async fn digest_index(
    conn: &mut PgConnection,
    channel_id: Uuid,
    level: &str,
    from_seq: i64,
) -> Result<Vec<DigestIndexRow>, DbError> {
    let rows = sqlx::query(
        "SELECT id, thread_root_id, from_seq, to_seq, stale FROM mem_digest_index($1, $2, $3)",
    )
    .bind(channel_id)
    .bind(level)
    .bind(from_seq)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DigestIndexRow {
            id: row.get("id"),
            thread_root_id: row.get("thread_root_id"),
            from_seq: row.get("from_seq"),
            to_seq: row.get("to_seq"),
            stale: row.get("stale"),
        })
        .collect())
}

#[derive(Debug, Clone)]
pub struct StaleDigest {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub thread_root_id: Option<Uuid>,
    pub level: String,
    pub from_seq: i64,
    pub to_seq: i64,
}

/// Stale digests that are at least `min_age_seconds` old (M-1: a member editing over and over
/// cannot make the worker regenerate the same digest — and spend tokens — more than once per
/// interval; a regeneration resets the digest's `created_at`).
pub async fn stale_digests(
    conn: &mut PgConnection,
    limit: i32,
    min_age_seconds: i32,
) -> Result<Vec<StaleDigest>, DbError> {
    let rows = sqlx::query(
        "SELECT id, channel_id, thread_root_id, level, from_seq, to_seq FROM mem_stale_digests($1, $2)",
    )
    .bind(limit)
    .bind(min_age_seconds)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| StaleDigest {
            id: row.get("id"),
            channel_id: row.get("channel_id"),
            thread_root_id: row.get("thread_root_id"),
            level: row.get("level"),
            from_seq: row.get("from_seq"),
            to_seq: row.get("to_seq"),
        })
        .collect())
}

/// Delete a *stale* digest (the SQL refuses a live one).
pub async fn drop_digest(conn: &mut PgConnection, digest_id: Uuid) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_drop_digest($1)")
        .bind(digest_id)
        .fetch_one(&mut *conn)
        .await?)
}

#[derive(Debug, Clone)]
pub struct RollupInput {
    pub id: Uuid,
    pub level: String,
    pub from_seq: i64,
    pub to_seq: i64,
    pub body: String,
}

/// Lower-level digests to roll up into `target_level` ('day' ← window, 'week' ← day) inside
/// `[from_seq, to_seq]`. Stale, edited, deleted or partly-lost sources are not returned.
pub async fn rollup_inputs(
    conn: &mut PgConnection,
    channel_id: Uuid,
    thread_root_id: Option<Uuid>,
    target_level: &str,
    from_seq: i64,
    to_seq: i64,
) -> Result<Vec<RollupInput>, DbError> {
    let rows = sqlx::query(
        "SELECT id, level, from_seq, to_seq, body FROM mem_digest_rollup_inputs($1, $2, $3, $4, $5)",
    )
    .bind(channel_id)
    .bind(thread_root_id)
    .bind(target_level)
    .bind(from_seq)
    .bind(to_seq)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| RollupInput {
            id: row.get("id"),
            level: row.get("level"),
            from_seq: row.get("from_seq"),
            to_seq: row.get("to_seq"),
            body: row.get("body"),
        })
        .collect())
}

/// `(cap, used_today)` in tokens; `default_cap` applies when the workspace set none.
pub async fn token_budget(
    conn: &mut PgConnection,
    default_cap: i64,
) -> Result<(i64, i64), DbError> {
    let row = sqlx::query("SELECT cap, used FROM mem_token_budget($1)")
        .bind(default_cap)
        .fetch_one(&mut *conn)
        .await?;
    Ok((row.get("cap"), row.get("used")))
}

/// Reserve `tokens` against today's cap. `false` = the cap would be exceeded (nothing added).
pub async fn reserve_tokens(
    conn: &mut PgConnection,
    tokens: i64,
    default_cap: i64,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_reserve_tokens($1, $2)")
        .bind(tokens)
        .bind(default_cap)
        .fetch_one(&mut *conn)
        .await?)
}

/// Settle a reservation against the real usage (negative refunds).
pub async fn adjust_tokens(conn: &mut PgConnection, delta: i64) -> Result<i64, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_adjust_tokens($1)")
        .bind(delta)
        .fetch_one(&mut *conn)
        .await?)
}

// ---------------------------------------------------------------------------
// serving (#3163): summaries into an agent turn's context, and the receipt
// ---------------------------------------------------------------------------

/// One summary `mem_serve_candidates` says may ride this answer.
#[derive(Debug, Clone)]
pub struct ServeDigest {
    pub id: Uuid,
    /// The channel the summary is stored in (may differ from the answer's channel only in the
    /// 1:1 agent DM, where the requester's own permission union applies).
    pub channel_id: Uuid,
    pub thread_root_id: Option<Uuid>,
    pub level: String,
    pub from_seq: i64,
    pub to_seq: i64,
    /// Oldest / newest source message time — the span the summary covers.
    pub covered_from: Option<DateTime<Utc>>,
    pub covered_to: Option<DateTime<Utc>>,
    /// Clipped in SQL to the `body_max` the caller asked for.
    pub body: String,
}

/// The database's answer to "what may this run's answer carry, for whom".
#[derive(Debug, Clone)]
pub struct ServeCandidates {
    /// The channel the answer goes to — read from the run row by the database, never taken from
    /// the job payload (#3163 F6).
    pub answer_channel: Uuid,
    /// Who asked — derived in SQL from the run row (never from the job payload).
    pub requester: Uuid,
    /// In serving order (thread first, then this channel, then most recent).
    pub digests: Vec<ServeDigest>,
    /// Readable by the requester but not servable to this answer's audience — a count only.
    pub withheld: i32,
}

/// `None` when nothing is to be served *and* nothing is to be recorded: the run has no human
/// requester, or a switch is off (workspace / channel / the requester's own pause).
pub async fn serve_candidates(
    conn: &mut PgConnection,
    run_id: Uuid,
    before_seq: Option<i64>,
    limit: i32,
    body_max: i32,
) -> Result<Option<ServeCandidates>, DbError> {
    let rows = sqlx::query(
        "SELECT requester_member_id, answer_channel_id, digest_id, digest_channel_id, thread_root_id, level, \
                from_seq, to_seq, covered_from, covered_to, body, withheld_count \
           FROM mem_serve_candidates($1, $2, $3, $4)",
    )
    .bind(run_id)
    .bind(before_seq)
    .bind(limit)
    .bind(body_max)
    .fetch_all(&mut *conn)
    .await?;
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let requester: Uuid = first.get("requester_member_id");
    let answer_channel: Uuid = first.get("answer_channel_id");
    let withheld: i32 = first.get("withheld_count");
    let digests = rows
        .iter()
        .filter_map(|row| {
            let id: Option<Uuid> = row.get("digest_id");
            id.map(|id| ServeDigest {
                id,
                channel_id: row.get("digest_channel_id"),
                thread_root_id: row.get("thread_root_id"),
                level: row.get("level"),
                from_seq: row.get("from_seq"),
                to_seq: row.get("to_seq"),
                covered_from: row.get("covered_from"),
                covered_to: row.get("covered_to"),
                body: row.get("body"),
            })
        })
        .collect();
    Ok(Some(ServeCandidates {
        answer_channel,
        requester,
        digests,
        withheld,
    }))
}

/// The digest ids already recorded on `run_id`'s receipt, `None` when there is no receipt.
pub async fn serving_of(
    conn: &mut PgConnection,
    run_id: Uuid,
) -> Result<Option<Vec<Uuid>>, DbError> {
    Ok(sqlx::query_scalar("SELECT mem_serving_of($1)")
        .bind(run_id)
        .fetch_one(&mut *conn)
        .await?)
}

/// Write the run's receipt (`mem_serving`). Re-checks the audience rule for every digest, so a
/// digest that went stale or unreadable between the read and now fails with 23514 and nothing
/// is recorded. A second call for the same run is 23505.
pub async fn record_serving(
    conn: &mut PgConnection,
    run_id: Uuid,
    requester: Uuid,
    digest_ids: &[Uuid],
    withheld: i32,
    budget_chars: i32,
    used_chars: i32,
) -> Result<Uuid, DbError> {
    let none: [Uuid; 0] = [];
    Ok(
        sqlx::query_scalar("SELECT mem_record_serving($1, $2, $3, $4, $5, $6, $7)")
            .bind(run_id)
            .bind(requester)
            .bind(digest_ids)
            .bind(&none[..])
            .bind(withheld)
            .bind(budget_chars)
            .bind(used_chars)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// One piece of evidence with the `edited_at` the worker saw when it read the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvidenceRef {
    pub message_id: Uuid,
    pub seq: i64,
    pub edited_at: Option<DateTime<Utc>>,
}

pub struct NewDigest<'a> {
    pub channel_id: Uuid,
    pub thread_root_id: Option<Uuid>,
    pub level: &'a str,
    pub from_seq: i64,
    pub to_seq: i64,
    pub body: &'a str,
    pub source_digest_ids: &'a [Uuid],
    pub model: &'a str,
    pub model_source: &'a str,
    pub evidence: &'a [EvidenceRef],
    /// When the worker read the evidence (PG's clock, taken *after* the read statement).
    pub read_at: DateTime<Utc>,
}

/// Write one digest + its evidence through `mem_apply_digest` (idempotent per
/// `(channel, thread, level, to_seq)`; clears `stale`).
pub async fn apply_digest(
    conn: &mut PgConnection,
    digest: &NewDigest<'_>,
) -> Result<Uuid, DbError> {
    let ids: Vec<Uuid> = digest.evidence.iter().map(|e| e.message_id).collect();
    let edited: Vec<Option<DateTime<Utc>>> = digest.evidence.iter().map(|e| e.edited_at).collect();
    Ok(sqlx::query_scalar(
        "SELECT mem_apply_digest($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz[], $13)",
    )
    .bind(digest.channel_id)
    .bind(digest.thread_root_id)
    .bind(digest.level)
    .bind(digest.from_seq)
    .bind(digest.to_seq)
    .bind(digest.body)
    .bind(digest.source_digest_ids)
    .bind(digest.model)
    .bind(digest.model_source)
    .bind(PROMPT_VERSION)
    .bind(&ids)
    .bind(&edited)
    .bind(digest.read_at)
    .fetch_one(&mut *conn)
    .await?)
}

// ---------------------------------------------------------------------------
// read-tx calls (message / member / channel_seq; explicit tenant predicates)
// ---------------------------------------------------------------------------

/// One message as the summariser sees it. Bodies of deleted messages are never returned.
#[derive(Debug, Clone)]
pub struct SourceMessage {
    pub id: Uuid,
    pub seq: i64,
    pub root_id: Option<Uuid>,
    pub author_name: String,
    pub author_is_agent: bool,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    /// The body is still growing (an agent answer mid-stream) — never summarised yet.
    pub streaming: bool,
}

impl SourceMessage {
    pub fn evidence(&self) -> EvidenceRef {
        EvidenceRef {
            message_id: self.id,
            seq: self.seq,
            edited_at: self.edited_at,
        }
    }
}

const SOURCE_COLS: &str = "m.id, m.seq, m.root_id, a.display_name AS author_name, \
     (a.kind = 'agent') AS author_is_agent, COALESCE(m.body, '') AS body, m.created_at, \
     m.edited_at, COALESCE((m.props -> 'momo.stream' ->> 'streaming') = 'true', false) \
     AND m.created_at > now() - interval '30 minutes' AS streaming";

/// The same liveness rule everywhere: a text message with a body, not deleted.
///
/// A DM (M-3, ADR-0196 D9) only counts from the moment its latest current member joined: what the two humans
/// said to each other before is never read (`mem_apply_digest` refuses it as evidence too).
/// A `streaming` marker older than 30 minutes is a crashed writer, not a live stream (M-5).
const LIVE: &str = "m.type = 'text' AND m.deleted_at IS NULL AND m.state <> 'deleted' \
     AND m.body IS NOT NULL AND btrim(m.body) <> '' \
     AND (NOT EXISTS (SELECT 1 FROM channel dc WHERE dc.id = m.channel_id AND dc.kind = 'dm') \
          OR m.created_at >= (SELECT max(dx.joined_at) FROM membership dx \
                               WHERE dx.channel_id = m.channel_id AND dx.workspace_id = m.workspace_id \
                                 AND dx.left_at IS NULL))";

fn source_message(row: &sqlx::postgres::PgRow) -> SourceMessage {
    SourceMessage {
        id: row.get("id"),
        seq: row.get("seq"),
        root_id: row.get("root_id"),
        author_name: row.get("author_name"),
        author_is_agent: row.get("author_is_agent"),
        body: row.get("body"),
        created_at: row.get("created_at"),
        edited_at: row.get("edited_at"),
        streaming: row.get("streaming"),
    }
}

/// PG's wall clock. Taken *after* the statement that read the evidence: every edit that
/// statement could see committed before it, so its `edited_at` is `<=` this value.
pub async fn read_clock(conn: &mut PgConnection) -> Result<DateTime<Utc>, DbError> {
    Ok(sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *conn)
        .await?)
}

/// The channel's head `seq`; `None` if the channel is not in this workspace.
pub async fn channel_head(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
) -> Result<Option<i64>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT last_seq FROM channel_seq WHERE workspace_id = $1 AND channel_id = $2",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Highest `seq` of a message older than `days` — where a never-summarised channel starts
/// (so turning the feature on does not summarise years of history).
pub async fn backfill_floor_seq(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    days: i32,
) -> Result<i64, DbError> {
    let seq: Option<i64> = sqlx::query_scalar(
        "SELECT max(seq) FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 \
            AND created_at < now() - make_interval(days => $3)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(days)
    .fetch_one(&mut *conn)
    .await?;
    Ok(seq.unwrap_or(0))
}

#[derive(Debug, Clone)]
pub struct PendingStats {
    pub count: i64,
    pub first_created_at: DateTime<Utc>,
    pub newest_created_at: DateTime<Utc>,
}

/// Counts of the top-level text messages in `(after_seq, upto_seq]` — no bodies.
pub async fn pending_stats(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    after_seq: i64,
    upto_seq: i64,
) -> Result<Option<PendingStats>, DbError> {
    let sql = format!(
        "SELECT count(*) AS n, min(m.created_at) AS first_at, max(m.created_at) AS newest_at \
           FROM message m \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NULL \
            AND m.seq > $3 AND m.seq <= $4 AND {LIVE}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(after_seq)
        .bind(upto_seq)
        .fetch_one(&mut *conn)
        .await?;
    let count: i64 = row.get("n");
    if count == 0 {
        return Ok(None);
    }
    Ok(Some(PendingStats {
        count,
        first_created_at: row.get("first_at"),
        newest_created_at: row.get("newest_at"),
    }))
}

/// Top-level text messages in `(after_seq, upto_seq]` (oldest first), optionally only those
/// created before `before` (a local-midnight cut so a window never spans two days).
pub async fn read_channel_window(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    after_seq: i64,
    upto_seq: i64,
    before: Option<DateTime<Utc>>,
    limit: i64,
) -> Result<Vec<SourceMessage>, DbError> {
    let sql = format!(
        "SELECT {SOURCE_COLS} FROM message m JOIN member a ON a.id = m.author_member_id AND a.workspace_id = m.workspace_id \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NULL \
            AND m.seq > $3 AND m.seq <= $4 AND {LIVE} \
            AND ($5::timestamptz IS NULL OR m.created_at < $5) \
          ORDER BY m.seq LIMIT $6"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(after_seq)
        .bind(upto_seq)
        .bind(before)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.iter().map(source_message).collect())
}

/// The messages of one digest range: for the channel (`thread_root_id = None`) the top-level
/// ones, for a thread the root plus its replies. `seq` in `[from_seq, to_seq]`.
pub async fn read_range(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    thread_root_id: Option<Uuid>,
    from_seq: i64,
    to_seq: i64,
    limit: i64,
) -> Result<Vec<SourceMessage>, DbError> {
    let sql = format!(
        "SELECT {SOURCE_COLS} FROM message m JOIN member a ON a.id = m.author_member_id AND a.workspace_id = m.workspace_id \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 \
            AND m.seq >= $3 AND m.seq <= $4 AND {LIVE} \
            AND (($5::uuid IS NULL AND m.root_id IS NULL) \
                 OR ($5::uuid IS NOT NULL AND (m.id = $5 OR m.root_id = $5))) \
          ORDER BY m.seq LIMIT $6"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(from_seq)
        .bind(to_seq)
        .bind(thread_root_id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.iter().map(source_message).collect())
}

/// Ids + `edited_at` of the live messages of a range (no bodies) — the evidence of a rollup.
/// A rollup's evidence is **every** live message in its range, which is a superset of the
/// surviving evidence of its sources (`mem_apply_digest` requires exactly that).
pub async fn read_evidence_refs(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    from_seq: i64,
    to_seq: i64,
) -> Result<Vec<EvidenceRef>, DbError> {
    let sql = format!(
        "SELECT m.id, m.seq, m.edited_at FROM message m \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NULL \
            AND m.seq >= $3 AND m.seq <= $4 AND {LIVE} \
          ORDER BY m.seq"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(from_seq)
        .bind(to_seq)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .iter()
        .map(|row| EvidenceRef {
            message_id: row.get("id"),
            seq: row.get("seq"),
            edited_at: row.get("edited_at"),
        })
        .collect())
}

#[derive(Debug, Clone)]
pub struct ThreadStat {
    pub root_id: Uuid,
    pub replies: i64,
    pub newest_created_at: DateTime<Utc>,
    pub max_seq: i64,
}

/// Threads with replies past their frontier (`frontier[i]` = the last `seq` already covered
/// for `roots[i]`; threads not listed start at `floor_seq`). Most recently active first.
#[allow(clippy::too_many_arguments)]
pub async fn thread_candidates(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    floor_seq: i64,
    upto_seq: i64,
    roots: &[Uuid],
    frontier: &[i64],
    limit: i64,
) -> Result<Vec<ThreadStat>, DbError> {
    let sql = format!(
        "SELECT m.root_id, count(*) AS replies, max(m.created_at) AS newest_at, max(m.seq) AS max_seq \
           FROM message m \
           LEFT JOIN unnest($4::uuid[], $5::bigint[]) AS f(root, seq) ON f.root = m.root_id \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NOT NULL \
            AND m.seq > GREATEST($3, COALESCE(f.seq, 0)) AND m.seq <= $6 AND {LIVE} \
          GROUP BY m.root_id ORDER BY max(m.seq) DESC LIMIT $7"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(floor_seq)
        .bind(roots)
        .bind(frontier)
        .bind(upto_seq)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .iter()
        .map(|row| ThreadStat {
            root_id: row.get("root_id"),
            replies: row.get("replies"),
            newest_created_at: row.get("newest_at"),
            max_seq: row.get("max_seq"),
        })
        .collect())
}

/// A thread's root plus its replies in `(after_seq, upto_seq]`, oldest first. The root rides
/// along (when alive) so the digest keeps its context and the root is part of the evidence.
pub async fn read_thread_window(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    root_id: Uuid,
    after_seq: i64,
    upto_seq: i64,
    limit: i64,
) -> Result<Vec<SourceMessage>, DbError> {
    let sql = format!(
        "SELECT {SOURCE_COLS} FROM message m JOIN member a ON a.id = m.author_member_id AND a.workspace_id = m.workspace_id \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND {LIVE} \
            AND (m.id = $3 OR (m.root_id = $3 AND m.seq > $4 AND m.seq <= $5)) \
          ORDER BY m.seq LIMIT $6"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(root_id)
        .bind(after_seq)
        .bind(upto_seq)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.iter().map(source_message).collect())
}

#[derive(Debug, Clone)]
pub struct DayBounds {
    /// The workspace-local calendar day.
    pub day: NaiveDate,
    pub min_seq: i64,
    pub max_seq: i64,
}

/// Per local day: the `seq` span of the top-level live text messages since `since` — no bodies.
pub async fn day_bounds(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    utc_offset_minutes: i32,
    since: DateTime<Utc>,
) -> Result<Vec<DayBounds>, DbError> {
    let sql = format!(
        "SELECT ((m.created_at AT TIME ZONE 'UTC') + make_interval(mins => $3))::date AS day, \
                min(m.seq) AS min_seq, max(m.seq) AS max_seq \
           FROM message m \
          WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.root_id IS NULL \
            AND m.created_at >= $4 AND {LIVE} \
          GROUP BY 1 ORDER BY 1"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(utc_offset_minutes)
        .bind(since)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .iter()
        .map(|row| DayBounds {
            day: row.get("day"),
            min_seq: row.get("min_seq"),
            max_seq: row.get("max_seq"),
        })
        .collect())
}

/// Was `action` already audited for this workspace in the last `hours`? (Keeps an honest
/// "not configured" row from being written on every sweep and every restart.)
pub async fn audit_recent(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    action: &str,
    hours: i32,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = $2 \
                         AND created_at > now() - make_interval(hours => $3))",
    )
    .bind(workspace_id)
    .bind(action)
    .bind(hours)
    .fetch_one(&mut *conn)
    .await?)
}

/// Active channels the worker may look at (metadata only — no bodies, no `mem_*`):
/// `(workspace_id, channel_id, head_seq)` across every tenant. This is the one cross-tenant
/// statement, the same polling exception the relay and the agent worker already hold.
pub async fn active_channels(
    pool: &PgPool,
    since: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<(Uuid, Uuid, i64)>, DbError> {
    let rows = sqlx::query(
        "SELECT cs.workspace_id, cs.channel_id, cs.last_seq \
           FROM channel_seq cs JOIN channel c ON c.id = cs.channel_id \
          WHERE cs.last_seq > 0 AND c.archived_at IS NULL \
            AND EXISTS (SELECT 1 FROM message m \
                         WHERE m.channel_id = cs.channel_id AND m.created_at >= $1) \
          ORDER BY cs.workspace_id, cs.channel_id LIMIT $2",
    )
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get("workspace_id"),
                row.get("channel_id"),
                row.get("last_seq"),
            )
        })
        .collect())
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/// The `[start, end)` UTC instants of the workspace-local day containing `at`.
pub fn local_day_bounds(
    at: DateTime<Utc>,
    utc_offset_minutes: i32,
) -> (DateTime<Utc>, DateTime<Utc>) {
    let offset = Duration::minutes(i64::from(utc_offset_minutes));
    let local = at + offset;
    let midnight = local
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("midnight exists")
        .and_utc();
    let start = midnight - offset;
    (start, start + Duration::days(1))
}

/// Does the text look like it carries a credential? Checked *before* a body is sent to a
/// model; a hit replaces the body with a placeholder (the message still counts as evidence,
/// so deleting it still hides the digest). A conservative token-shape scan, not a guarantee.
pub fn looks_like_secret(text: &str) -> bool {
    const PREFIXES: [&str; 15] = [
        "sk-",
        "sk_live_",
        "sk_test_",
        "ghp_",
        "gho_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xapp-",
        "glpat-",
        "AIza",
        "AKIA",
        "ya29.",
        "SG.",
        "whsec_",
    ];
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return true;
    }
    text.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '<' | '>' | '=' | ':'
            )
    })
    .any(|token| {
        let token = token
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '.');
        if token.len() < 16 {
            return false;
        }
        if PREFIXES.iter().any(|p| token.starts_with(p)) && token.len() >= 20 {
            return true;
        }
        // JWT: three base64url parts, the first starting `eyJ`.
        token.starts_with("eyJ") && token.matches('.').count() == 2
    }) || has_bearer_credential(text)
        || has_url_credential(text)
        || has_prose_password(text)
}

/// `scheme://user:pass@host` — a password inside a URL.
fn has_url_credential(text: &str) -> bool {
    text.match_indices("://").any(|(at, _)| {
        let scheme_ok = text[..at]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
            .last()
            .is_some_and(|c| c.is_ascii_alphabetic());
        let rest = &text[at + 3..];
        let authority: &str = rest
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        scheme_ok
            && authority.split_once('@').is_some_and(|(userinfo, _)| {
                userinfo
                    .split_once(':')
                    .is_some_and(|(user, pass)| !user.is_empty() && !pass.is_empty())
            })
    })
}

/// Prose such as 「비밀번호는 abc12345」 / "password is hunter22": a password keyword, an optional
/// connector, then a value whose first six characters are printable ASCII and which holds a digit
/// or a symbol (so 「비밀번호는 짧게」 and "password is required" are prose, not secrets).
fn has_prose_password(text: &str) -> bool {
    const KEYWORDS: [&str; 6] = ["비밀번호", "패스워드", "암호", "password", "passwd", "pwd"];
    let lower = text.to_lowercase();
    KEYWORDS.iter().any(|keyword| {
        lower.match_indices(keyword).any(|(at, _)| {
            let mut rest = lower[at + keyword.len()..].trim_start();
            if let Some(stripped) = rest
                .strip_prefix(['는', '은', '이', '가', ':', '='])
                .or_else(|| {
                    let after = rest.strip_prefix("is")?;
                    after.starts_with(char::is_whitespace).then_some(after)
                })
            {
                rest = stripped.trim_start();
            }
            let token = rest.split_whitespace().next().unwrap_or("");
            let head_ok = token.chars().take(6).count() == 6
                && token.chars().take(6).all(|c| c.is_ascii_graphic());
            head_ok
                && token
                    .chars()
                    .any(|c| c.is_ascii_digit() || "!@#$%^&*".contains(c))
        })
    })
}

fn has_bearer_credential(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("bearer ").any(|(at, _)| {
        text[at + 7..].split_whitespace().next().is_some_and(|t| {
            t.len() >= 20
                && t.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-._~+/=".contains(c))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_day_is_cut_at_local_midnight() {
        let at = "2026-09-29T20:30:00Z".parse::<DateTime<Utc>>().unwrap();
        // KST (+9): 05:30 on the 30th, so the day is [29th 15:00Z, 30th 15:00Z).
        let (start, end) = local_day_bounds(at, 540);
        assert_eq!(start.to_rfc3339(), "2026-09-29T15:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-09-30T15:00:00+00:00");
        let (start, end) = local_day_bounds(at, 0);
        assert_eq!(start.to_rfc3339(), "2026-09-29T00:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-09-30T00:00:00+00:00");
        assert!(start <= at && at < end);
    }

    #[test]
    fn credentials_are_recognised_and_prose_is_not() {
        // Built at run time: a JWT-shaped literal in the source trips the repo's secret scan.
        let jwt = format!(
            "token={}",
            ["eyJ0eXAiOiJKV1QifQ", "eyJzdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl"].join(".")
        );
        for secret in [
            "키는 sk-proj-abcdefghijklmnopqrstuvwx 입니다",
            "export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "AKIAIOSFODNN7EXAMPLE 로 접속",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
            jwt.as_str(),
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
        ] {
            assert!(looks_like_secret(secret), "{secret}");
        }
        for prose in [
            "내일 오전 10시에 배포합니다",
            "the sk- prefix is documented in the runbook",
            "Bearer 토큰은 짧게",
            "https://example.com/a/b/c?x=1",
            "PR #123 머지했어요 https://github.com/o/r/pull/123",
        ] {
            assert!(!looks_like_secret(prose), "{prose}");
        }
    }

    #[test]
    fn the_shared_secret_shape_list_agrees_with_the_rust_check() {
        // The same JSON drives the SQL `mem_looks_like_secret` test (momo-server, PG).
        let shapes: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/memory_secret_shapes.json"))
                .expect("fixture json");
        for parts in shapes["positives"].as_array().unwrap() {
            let text: String = parts
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap())
                .collect();
            assert!(looks_like_secret(&text), "should be a secret shape: {text}");
        }
        for text in shapes["negatives"].as_array().unwrap() {
            let text = text.as_str().unwrap();
            assert!(!looks_like_secret(text), "should be prose: {text}");
        }
    }

    #[test]
    fn only_lost_or_edited_evidence_is_retryable() {
        assert!(ApplyFailure::EditedAfterRead.retryable());
        assert!(ApplyFailure::EvidenceGone.retryable());
        assert!(!ApplyFailure::Switched.retryable());
        assert!(!ApplyFailure::LeaseHeld.retryable());
        assert!(!ApplyFailure::Other.retryable());
    }
}
