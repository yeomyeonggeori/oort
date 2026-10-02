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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardItem {
    pub session_id: Uuid,
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
WITH board AS ( \
  SELECT ws.id, ws.channel_id, ws.member_id, ws.origin, ws.label, ws.folder_label, \
         ws.tool, ws.status, ws.exit_code, ws.started_at, ws.ended_at, \
         c.name AS channel_name, o.display_name AS owner_name, \
         s.repo_label, s.branch, s.harness, s.derived_state, s.stage_markers, \
         s.diff_added, s.diff_deleted, s.diff_files, s.commits_ahead, s.commits_behind, \
         s.uncommitted, s.pr_url, s.shared_at, \
         (extract(epoch FROM CASE ws.origin \
             WHEN 'local_pty' THEN COALESCE(s.last_activity_at, s.updated_at) \
             ELSE GREATEST(ws.started_at, ws.ended_at, t.last_at) END) * 1000000)::bigint \
           AS activity_us \
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
) \
SELECT * FROM board \
 WHERE ($5::bigint IS NULL OR (activity_us, id) < ($5, $6::uuid)) \
 ORDER BY activity_us DESC, id DESC \
 LIMIT $7";

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
    let (harness, state) = if local {
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
    Ok(BoardItem {
        session_id: row.try_get("id")?,
        origin,
        label: row.try_get("label")?,
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
        pr_url: row.try_get("pr_url")?,
        last_activity_at: activity_us.div_euclid(1_000_000),
        activity_us,
    })
}

async fn query(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    only_session: Option<Uuid>,
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
        .fetch_all(&mut *conn)
        .await?;
    rows.iter().map(decode).collect()
}

/// One page of what `viewer_member_id` may see, newest activity first.
pub async fn list_board_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    after: Option<BoardCursor>,
    limit: i64,
) -> Result<BoardPage, T3Error> {
    let limit = limit.clamp(1, MAX_PAGE);
    let mut items = query(conn, workspace_id, viewer_member_id, None, after, limit + 1).await?;
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
        ] {
            assert!(!lowered.contains(forbidden), "{forbidden}");
        }
    }
}
