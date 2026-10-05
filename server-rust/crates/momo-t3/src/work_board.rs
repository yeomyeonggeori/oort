//! Team board read model (#3322 — ADR-0190 D4·Q4, ADR-0194; serves #2863).
//!
//! One SQL statement decides what a viewer may see, and it decides it **before**
//! any column is read: the viewer must be an active member of the session's home
//! channel (unarchived, not left), and the session must be either
//!
//! * a **shared local** session (`origin = 'local_pty'`) that still has its
//!   `work_session_share` row — unsharing deletes that row, so the session
//!   disappears from the very next read; or
//! * an **agent-lane** session (`origin = 'host'`, #2779).
//!
//! Either kind drops off the board [`SHARE_RETENTION_DAYS`] after it ended. The
//! read enforces that itself rather than waiting for the notifier's sweep to
//! delete the share row, so a late sweep cannot extend what is visible.
//!
//! ## The second source: hosted agents' work runs (ADR-0162 증보 3 D13, #3517)
//!
//! When the caller opts in (`include_runs`), the same statement also reads
//! `agent_run` rows with `input.type = 'work'` whose agent has a hosted
//! connection, behind the **same** membership predicate on the run's channel.
//! A run linked to a work session (`audit_log.run_id` → `work_control`) is not
//! listed — the session item represents it. Mention runs and managed/BYOA work
//! runs are not read at all. A run item carries only what D15 allows: status,
//! the validated stage markers, the validated artifacts and counters; never
//! `detail`, `textDelta`, the reply body or the error. The requester is the
//! actor of the run's `agent.work.queued` audit row (the run has no requester
//! column); a run without one still lists, with no requester.
//!
//! There is no workspace-wide view (Q4): a member of a different channel gets
//! nothing, not a 403. The list and the single read share this one query, so
//! "not a member", "not shared", "no such session" and "another tenant's id" are
//! the same empty result and the handler turns each of them into the same 404.
//!
//! ## What is not selected, on purpose
//!
//! No terminal text, input, control or attach column, no commit title, no file
//! name, no path, no host id, no PTY/display endpoint. A host session has no S1
//! payload, so its repo / branch / diff / PR fields are `None` and its stage list
//! is empty; the field names are `momo-core`'s `ShareSummaryS1`.
//!
//! ## Paging
//!
//! Ordered by last activity, newest first, ties by session id. The cursor is the
//! last returned `(activity µs, id)` pair — opaque to clients, strictly parsed,
//! and meaningless outside the viewer's own filtered set (a forged cursor only
//! moves the position inside rows the viewer may already see). A page never
//! reports a total.

use momo_db::PgConnection;
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;
use crate::work_share::SHARE_RETENTION_DAYS;

/// Shown when a work run was queued without a title.
pub const RUN_FALLBACK_LABEL: &str = "작업";

pub const DEFAULT_PAGE: i64 = 50;
pub const MAX_PAGE: i64 = 100;

/// Where the next page starts: strictly after this `(activity µs, session id)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoardCursor {
    pub activity_us: i64,
    pub session_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardDiff {
    pub added: Option<i32>,
    pub deleted: Option<i32>,
    pub files: Option<i32>,
    pub ahead: Option<i32>,
    pub behind: Option<i32>,
    pub uncommitted: Option<i32>,
}

/// Which ledger a board item came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardSource {
    Session,
    Run,
}

impl BoardSource {
    pub fn as_str(self) -> &'static str {
        match self {
            BoardSource::Session => "session",
            BoardSource::Run => "run",
        }
    }
}

/// What only a run item has (D13). The numbers are the agent's own report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRun {
    pub run_id: Uuid,
    pub requested_by: Option<(Uuid, String)>,
    pub step_count: i32,
    pub commits: Option<i32>,
    pub pr_number: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardItem {
    /// The row's own id: the session id for a session item, the run id for a run
    /// item. It is also the cursor's tie-breaker, so the two never collide.
    pub session_id: Uuid,
    pub source: BoardSource,
    pub run: Option<BoardRun>,
    pub origin: String,
    pub label: String,
    pub folder_label: Option<String>,
    /// Ledger status: running | idle | orphaned | ended.
    pub status: String,
    pub owner_member_id: Uuid,
    pub owner_display_name: String,
    pub channel_id: Uuid,
    pub channel_name: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub shared_at_ms: Option<i64>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub harness: String,
    pub state: String,
    pub stages: Vec<String>,
    pub diff: BoardDiff,
    pub pr_url: Option<String>,
    /// Epoch **seconds** (`ShareSummaryS1.lastActivityAt`).
    pub last_activity_at: i64,
    pub activity_us: i64,
}

/// A page and, when more rows follow, where to resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardPage {
    pub items: Vec<BoardItem>,
    pub next: Option<BoardCursor>,
}

const SELECT: &str = "\
WITH sess AS ( \
  SELECT ws.id, ws.channel_id, ws.member_id, ws.origin::text AS origin, ws.label, ws.folder_label, \
         ws.tool::text AS tool, ws.status::text AS status, ws.exit_code, ws.started_at, ws.ended_at, \
         c.name AS channel_name, o.display_name AS owner_name, \
         s.repo_label, s.branch, s.harness, s.derived_state, s.stage_markers, \
         s.diff_added, s.diff_deleted, s.diff_files, s.commits_ahead, s.commits_behind, \
         s.uncommitted, s.pr_url, s.shared_at, \
         (extract(epoch FROM CASE ws.origin \
             WHEN 'local_pty' THEN COALESCE(s.last_activity_at, s.updated_at) \
             ELSE GREATEST(ws.started_at, ws.ended_at, t.last_at) END) * 1000000)::bigint \
           AS activity_us, \
         'session'::text AS source, NULL::text AS run_status, NULL::uuid AS requester_id, \
         NULL::text AS requester_name, NULL::int AS step_count, NULL::int AS run_commits \
    FROM work_session ws \
    JOIN channel c \
      ON c.workspace_id = ws.workspace_id AND c.id = ws.channel_id AND c.archived_at IS NULL \
    JOIN membership ms \
      ON ms.workspace_id = ws.workspace_id AND ms.channel_id = ws.channel_id \
     AND ms.member_id = $2 AND ms.left_at IS NULL \
    JOIN member v \
      ON v.workspace_id = ws.workspace_id AND v.id = ms.member_id \
     AND v.status = 'active' AND v.deleted_at IS NULL \
    JOIN member o ON o.workspace_id = ws.workspace_id AND o.id = ws.member_id \
    LEFT JOIN work_session_share s \
      ON s.workspace_id = ws.workspace_id AND s.session_id = ws.id \
    LEFT JOIN LATERAL ( \
         SELECT m.created_at AS last_at FROM message m \
          WHERE ws.origin = 'host' AND m.workspace_id = ws.workspace_id \
            AND m.root_id = ws.root_message_id AND m.deleted_at IS NULL \
          ORDER BY m.seq DESC LIMIT 1 \
        ) t ON true \
   WHERE ws.workspace_id = $1 \
     AND ($3::uuid IS NULL OR ws.id = $3) \
     AND (ws.ended_at IS NULL \
          OR ws.ended_at > clock_timestamp() - make_interval(days => $4)) \
     AND ((ws.origin = 'local_pty' AND s.session_id IS NOT NULL) OR ws.origin = 'host') \
), \
runs AS ( \
  SELECT r.id, r.channel_id, r.agent_member_id AS member_id, 'agent_run'::text AS origin, \
         COALESCE(left(btrim(r.input->>'title'), 200), '') AS label, NULL::text AS folder_label, \
         'hosted'::text AS tool, r.status::text AS status, NULL::int AS exit_code, \
         COALESCE(r.started_at, r.created_at) AS started_at, r.finished_at AS ended_at, \
         c.name AS channel_name, ag.display_name AS owner_name, \
         NULL::text AS repo_label, \
         CASE WHEN jsonb_typeof(r.output->'artifacts'->'branch') = 'string' \
              THEN r.output->'artifacts'->>'branch' END AS branch, \
         'hosted'::text AS harness, NULL::text AS derived_state, \
         CASE WHEN jsonb_typeof(r.output->'stages') = 'array' \
              THEN r.output->'stages' END AS stage_markers, \
         CASE WHEN jsonb_typeof(r.output->'artifacts'->'added') = 'number' \
              THEN (r.output->'artifacts'->>'added')::numeric::int END AS diff_added, \
         CASE WHEN jsonb_typeof(r.output->'artifacts'->'deleted') = 'number' \
              THEN (r.output->'artifacts'->>'deleted')::numeric::int END AS diff_deleted, \
         NULL::int AS diff_files, NULL::int AS commits_ahead, NULL::int AS commits_behind, \
         NULL::int AS uncommitted, \
         CASE WHEN jsonb_typeof(r.output->'artifacts'->'prUrl') = 'string' \
              THEN r.output->'artifacts'->>'prUrl' END AS pr_url, \
         NULL::timestamptz AS shared_at, \
         (extract(epoch FROM GREATEST(r.created_at, r.updated_at, r.finished_at)) * 1000000)::bigint \
           AS activity_us, \
         'run'::text AS source, r.status::text AS run_status, rq.id AS requester_id, \
         rq.display_name AS requester_name, r.step_count, \
         CASE WHEN jsonb_typeof(r.output->'artifacts'->'commits') = 'number' \
              THEN (r.output->'artifacts'->>'commits')::numeric::int END AS run_commits \
    FROM agent_run r \
    JOIN channel c \
      ON c.workspace_id = r.workspace_id AND c.id = r.channel_id AND c.archived_at IS NULL \
    JOIN membership ms \
      ON ms.workspace_id = r.workspace_id AND ms.channel_id = r.channel_id \
     AND ms.member_id = $2 AND ms.left_at IS NULL \
    JOIN member v \
      ON v.workspace_id = r.workspace_id AND v.id = ms.member_id \
     AND v.status = 'active' AND v.deleted_at IS NULL \
    JOIN member ag ON ag.workspace_id = r.workspace_id AND ag.id = r.agent_member_id \
    LEFT JOIN LATERAL ( \
         SELECT a.actor_member_id FROM audit_log a \
          WHERE a.workspace_id = r.workspace_id AND a.run_id = r.id \
            AND a.action = 'agent.work.queued' \
          ORDER BY a.created_at, a.id LIMIT 1 \
        ) q ON true \
    LEFT JOIN member rq \
      ON rq.workspace_id = r.workspace_id AND rq.id = q.actor_member_id \
     AND rq.kind = 'human' \
   WHERE $8::boolean AND $3::uuid IS NULL \
     AND r.workspace_id = $1 \
     AND r.input->>'type' = 'work' \
     AND EXISTS (SELECT 1 FROM hosted_agent_connection hc \
                  WHERE hc.workspace_id = r.workspace_id AND hc.agent_member_id = r.agent_member_id) \
     AND NOT EXISTS (SELECT 1 FROM audit_log al \
                       JOIN work_control wc \
                         ON wc.workspace_id = al.workspace_id AND wc.id = al.target_id \
                      WHERE al.workspace_id = r.workspace_id AND al.run_id = r.id \
                        AND al.target_type = 'work_control' AND wc.session_id IS NOT NULL) \
     AND (r.finished_at IS NULL \
          OR r.finished_at > clock_timestamp() - make_interval(days => $4)) \
), \
board AS ( \
  SELECT * FROM sess UNION ALL SELECT * FROM runs \
) \
SELECT * FROM board \
 WHERE ($5::bigint IS NULL OR (activity_us, id) < ($5, $6::uuid)) \
 ORDER BY activity_us DESC, id DESC \
 LIMIT $7";

/// ADR-0162 증보 3 D13: the board's status words for a run. Migration 120's
/// `work_run_board_state` is the same table in SQL (the realtime trigger); a unit
/// test and the PG suite keep the two from drifting.
pub fn board_status_of_run(run_status: &str) -> &'static str {
    match run_status {
        "queued" => "waiting",
        "running" | "awaiting_approval" | "paused" => "running",
        "succeeded" => "done",
        "failed" | "timed_out" => "failed",
        _ => "stopped",
    }
}

/// `number` of `https://host/owner/repo/pull/<n>` (the validated shape).
fn pr_number_of(url: &str) -> Option<i64> {
    let path = url.split(['?', '#']).next()?;
    let (_, tail) = path.rsplit_once("/pull/")?;
    if tail.is_empty() || tail.len() > 18 || !tail.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    tail.parse().ok()
}

fn state_of_host_session(status: &str, exit_code: Option<i32>) -> &'static str {
    match status {
        "running" => "running",
        "idle" => "idle",
        "ended" if exit_code == Some(0) => "done",
        _ => "stopped",
    }
}

fn decode(row: &sqlx::postgres::PgRow) -> Result<BoardItem, T3Error> {
    let origin: String = row.try_get("origin")?;
    let status: String = row.try_get("status")?;
    let exit_code: Option<i32> = row.try_get("exit_code")?;
    let source: String = row.try_get("source")?;
    let is_run = source == "run";
    let local = origin == "local_pty";
    let started: chrono::DateTime<chrono::Utc> = row.try_get("started_at")?;
    let ended: Option<chrono::DateTime<chrono::Utc>> = row.try_get("ended_at")?;
    let shared_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("shared_at")?;
    let activity_us: i64 = row.try_get("activity_us")?;
    let stages: Option<serde_json::Value> = row.try_get("stage_markers")?;
    let stages = stages
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let id: Uuid = row.try_get("id")?;
    let (harness, state) = if is_run {
        let board = board_status_of_run(&status).to_string();
        (row.try_get::<String, _>("harness")?, board)
    } else if local {
        (
            row.try_get::<Option<String>, _>("harness")?
                .unwrap_or_default(),
            row.try_get::<Option<String>, _>("derived_state")?
                .unwrap_or_default(),
        )
    } else {
        let tool: String = row.try_get("tool")?;
        (tool, state_of_host_session(&status, exit_code).to_string())
    };
    let pr_url: Option<String> = row.try_get("pr_url")?;
    let run = if is_run {
        let requester_id: Option<Uuid> = row.try_get("requester_id")?;
        let requester_name: Option<String> = row.try_get("requester_name")?;
        Some(BoardRun {
            run_id: id,
            requested_by: requester_id.zip(requester_name),
            step_count: row.try_get("step_count")?,
            commits: row.try_get("run_commits")?,
            pr_number: pr_url.as_deref().and_then(pr_number_of),
        })
    } else {
        None
    };
    // A run's board status is the D13 word (`waiting|running|done|failed|stopped`);
    // a session keeps its ledger status.
    let (status, label) = if is_run {
        let label: String = row.try_get("label")?;
        (
            board_status_of_run(&status).to_string(),
            if label.is_empty() {
                RUN_FALLBACK_LABEL.to_string()
            } else {
                label
            },
        )
    } else {
        (status, row.try_get("label")?)
    };
    Ok(BoardItem {
        session_id: id,
        source: if is_run {
            BoardSource::Run
        } else {
            BoardSource::Session
        },
        run,
        origin,
        label,
        folder_label: row.try_get("folder_label")?,
        status,
        owner_member_id: row.try_get("member_id")?,
        owner_display_name: row.try_get("owner_name")?,
        channel_id: row.try_get("channel_id")?,
        channel_name: row.try_get("channel_name")?,
        started_at_ms: started.timestamp_millis(),
        ended_at_ms: ended.map(|value| value.timestamp_millis()),
        shared_at_ms: shared_at.map(|value| value.timestamp_millis()),
        repo: row.try_get("repo_label")?,
        branch: row.try_get("branch")?,
        harness,
        state,
        stages,
        diff: BoardDiff {
            added: row.try_get("diff_added")?,
            deleted: row.try_get("diff_deleted")?,
            files: row.try_get("diff_files")?,
            ahead: row.try_get("commits_ahead")?,
            behind: row.try_get("commits_behind")?,
            uncommitted: row.try_get("uncommitted")?,
        },
        pr_url,
        last_activity_at: activity_us.div_euclid(1_000_000),
        activity_us,
    })
}

async fn query(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    only_session: Option<Uuid>,
    include_runs: bool,
    after: Option<BoardCursor>,
    limit: i64,
) -> Result<Vec<BoardItem>, T3Error> {
    let rows = sqlx::query(SELECT)
        .bind(workspace_id)
        .bind(viewer_member_id)
        .bind(only_session)
        .bind(SHARE_RETENTION_DAYS)
        .bind(after.map(|cursor| cursor.activity_us))
        .bind(after.map(|cursor| cursor.session_id))
        .bind(limit)
        .bind(include_runs)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter().map(decode).collect()
}

/// One page of what `viewer_member_id` may see, newest activity first.
/// `include_runs` adds the hosted agents' work runs (D13) to the same list.
pub async fn list_board_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    include_runs: bool,
    after: Option<BoardCursor>,
    limit: i64,
) -> Result<BoardPage, T3Error> {
    let limit = limit.clamp(1, MAX_PAGE);
    let mut items = query(
        conn,
        workspace_id,
        viewer_member_id,
        None,
        include_runs,
        after,
        limit + 1,
    )
    .await?;
    let next = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items.last().map(|item| BoardCursor {
            activity_us: item.activity_us,
            session_id: item.session_id,
        })
    } else {
        None
    };
    Ok(BoardPage { items, next })
}

/// One session, only if the viewer may see it. `None` is every refusal alike.
pub async fn get_board_item_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    session_id: Uuid,
) -> Result<Option<BoardItem>, T3Error> {
    Ok(query(
        conn,
        workspace_id,
        viewer_member_id,
        Some(session_id),
        false,
        None,
        1,
    )
    .await?
    .into_iter()
    .next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_session_state_comes_from_the_ledger() {
        assert_eq!(state_of_host_session("running", None), "running");
        assert_eq!(state_of_host_session("idle", None), "idle");
        assert_eq!(state_of_host_session("ended", Some(0)), "done");
        assert_eq!(state_of_host_session("ended", Some(2)), "stopped");
        assert_eq!(state_of_host_session("orphaned", None), "stopped");
    }

    #[test]
    fn a_run_board_status_follows_d13() {
        for (run, board) in [
            ("queued", "waiting"),
            ("running", "running"),
            ("awaiting_approval", "running"),
            ("paused", "running"),
            ("succeeded", "done"),
            ("failed", "failed"),
            ("timed_out", "failed"),
            ("cancelled", "stopped"),
        ] {
            assert_eq!(board_status_of_run(run), board, "{run}");
        }
    }

    #[test]
    fn a_pr_number_comes_from_the_validated_url_only() {
        assert_eq!(
            pr_number_of("https://github.com/acme/app/pull/42"),
            Some(42)
        );
        assert_eq!(
            pr_number_of("https://github.com/acme/app/pull/42?x=1"),
            Some(42)
        );
        assert_eq!(pr_number_of("https://github.com/acme/app/pull/"), None);
        assert_eq!(pr_number_of("https://github.com/acme/app/pull/4x"), None);
        assert_eq!(pr_number_of("https://github.com/acme/app"), None);
    }

    #[test]
    fn the_query_selects_no_terminal_control_or_commit_column() {
        let lowered = SELECT.to_lowercase();
        for forbidden in [
            "pty_id",
            "attach_endpoint",
            "display_id",
            "display_endpoint",
            "host_id",
            "commit_title",
            "commit_message",
            "subject",
            "body",
            "props",
            "cwd",
            // D15: a run item never reads these.
            "error",
            "detail",
            "text_delta",
            "textdelta",
            "trigger_message",
        ] {
            assert!(!lowered.contains(forbidden), "{forbidden}");
        }
    }
}
