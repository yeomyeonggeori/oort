//! Shared local session payload S1 (#2862 — ADR-0190 증보 D4-b, ADR-0194 D4·D7·D8·D9).
//!
//! A `local_pty` session (113) that its owner chose to share carries, besides its
//! name and folder label, the **S1 payload**: repository label, branch, harness,
//! derived state, stage markers, diff numbers, PR URL and last-activity time. It
//! lives in `work_session_share` (114), one row per session, RLS FORCE.
//!
//! ## What is not here, on purpose
//!
//! There is no field for a commit title, a file name, a path, a remote URL or any
//! terminal output, and there is no function in this module that could take one.
//! The wire type rejects unknown fields (`deny_unknown_fields` in the route's
//! DTO), every string field has a length cap and a character rule, and the table
//! has no column to put such a thing in. The three layers are redundant by
//! design: a future field has to be added to all three, in a reviewed diff.
//!
//! ## The server never calls GitHub
//!
//! [`validated_pr_url`] only checks the *shape* of a URL the owner's machine
//! reported. Nothing in this crate resolves, fetches or unfurls it (ADR-0192 D7:
//! the server holds no GitHub token and opens no GitHub connection). Parsing is
//! by hand against an exact grammar — there is no URL library to disagree with a
//! browser about what the host of `https://github.com\@evil/…` is, because
//! anything outside `[A-Za-z0-9._-]` in owner/repo and anything but an exact
//! allow-listed host is refused before it is stored.

use momo_db::{DbError, PgConnection};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// ADR-0190 D4-b: the closed harness list.
pub const HARNESSES: &[&str] = &["claude", "codex", "grok", "opencode", "shell", "other"];
/// ADR-0190 D4-b: the closed derived-state list, spelled as `momo-core`'s
/// `SessionStatus` (the desktop collector's `ShareSummaryS1.state`, #2861):
/// 나를 기다림 = `waiting`, 실행 중 = `running`, 검토 대기 = `review`, 대기 = `idle`,
/// 끝남 = `done`, 멈춤 = `stopped`. ADR 표의 「조용함」은 현재 판정에 없어 넣지 않았다.
pub const DERIVED_STATES: &[&str] = &["waiting", "running", "review", "idle", "done", "stopped"];

pub const MAX_REPO_LABEL_CHARS: usize = 100;
pub const MAX_BRANCH_CHARS: usize = 200;
pub const MAX_STAGE_MARKERS: usize = 12;
pub const MAX_STAGE_MARKER_CHARS: usize = 80;
/// Counters are non-negative integers that fit the column (`integer`). A real
/// diff that is large must not 400 the whole update, so there is no tighter cap;
/// beyond the column it is a 400, not a clamp.
pub const MAX_COUNT: i64 = i32::MAX as i64;
const MAX_REPO_SEGMENT_CHARS: usize = 100;

/// ADR-0190 D4-b: "마지막 활동 시각 — 초 단위로 버림". The wire carries epoch
/// **seconds** (`ShareSummaryS1.lastActivityAt`), and a clock that is nowhere near
/// now is a bug on the host, not a value to store.
pub const MIN_ACTIVITY_SECS: i64 = 1_577_836_800; // 2020-01-01
pub const MAX_ACTIVITY_FUTURE_SKEW_SECS: i64 = 5 * 60;

/// Retention (ADR-0190 D4-b): the S1 extension is deleted this long after the
/// session ended. The name/state fields of `work_session` follow ledger rules.
pub const SHARE_RETENTION_DAYS: i32 = 30;

/// A validated S1 payload, ready to store. Construct only through
/// [`ShareFields::validate`] (the route does) — the fields are public so tests
/// can build one, but nothing else in the crate re-checks them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareFields {
    /// `None` = unknown (a shell pane outside a git repository).
    pub repo_label: Option<String>,
    pub branch: Option<String>,
    pub harness: String,
    pub derived_state: String,
    pub stage_markers: Vec<String>,
    pub diff_added: Option<i64>,
    pub diff_deleted: Option<i64>,
    pub diff_files: Option<i64>,
    pub commits_ahead: Option<i64>,
    pub commits_behind: Option<i64>,
    pub uncommitted: Option<i64>,
    pub pr_url: Option<String>,
    /// Epoch seconds.
    pub last_activity_secs: Option<i64>,
}

/// Why a payload was refused. The message is safe to return to the caller: it
/// names the field and the rule, never the rejected value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareRejection(pub String);

impl ShareRejection {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

fn is_unsafe_char(c: char) -> bool {
    // Control characters include ESC (ANSI) and NUL; the rest is the invisible /
    // direction-changing class (Unicode Cf, Zl, Zp and the default-ignorable
    // fillers) that makes one string read as another or breaks a line in a card.
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'..='\u{1160}'
                | '\u{17B4}'..='\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF0}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

fn bounded_text(raw: &str, field: &str, max: usize) -> Result<String, ShareRejection> {
    let value = raw.trim();
    let length = value.chars().count();
    if !(1..=max).contains(&length) {
        return Err(ShareRejection::new(format!(
            "{field} must contain 1...{max} characters"
        )));
    }
    if value.chars().any(is_unsafe_char) {
        return Err(ShareRejection::new(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(value.to_string())
}

/// Repository display name: the last path element. A separator is refused, not
/// stripped — a host that sends a path is a host that has the wrong idea.
pub fn validated_repo_label(raw: &str) -> Result<String, ShareRejection> {
    let value = bounded_text(raw, "repo", MAX_REPO_LABEL_CHARS)?;
    if value.contains('/') || value.contains('\\') {
        return Err(ShareRejection::new(
            "repo must be a single name without a path separator",
        ));
    }
    Ok(value)
}

/// Branch name. Git refuses most of what is refused here, so a legitimate branch
/// never trips it; what it catches is an absolute path or a drive letter sent in
/// the branch slot.
pub fn validated_branch(raw: &str) -> Result<String, ShareRejection> {
    let value = bounded_text(raw, "branch", MAX_BRANCH_CHARS)?;
    // A git ref has no whitespace and none of `~ ^ : ? * [` — so a commit title
    // ("fix: rotate the key") cannot be sent in the branch slot.
    if value
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '['))
    {
        return Err(ShareRejection::new(
            "branch must be a git branch name (no whitespace or ~ ^ : ? * [)",
        ));
    }
    let starts_like_path = value.starts_with('/') || value.starts_with('~');
    let mut chars = value.chars();
    let drive_letter = matches!(
        (chars.next(), chars.next()),
        (Some(a), Some(':')) if a.is_ascii_alphabetic()
    );
    if starts_like_path || drive_letter || value.contains('\\') {
        return Err(ShareRejection::new(
            "branch must be a branch name, not a path",
        ));
    }
    Ok(value)
}

pub fn validated_harness(raw: &str) -> Result<String, ShareRejection> {
    if HARNESSES.contains(&raw) {
        Ok(raw.to_string())
    } else {
        Err(ShareRejection::new(format!(
            "harness must be one of {}",
            HARNESSES.join(", ")
        )))
    }
}

pub fn validated_state(raw: &str) -> Result<String, ShareRejection> {
    if DERIVED_STATES.contains(&raw) {
        Ok(raw.to_string())
    } else {
        Err(ShareRejection::new(format!(
            "state must be one of {}",
            DERIVED_STATES.join(", ")
        )))
    }
}

pub fn validated_stage_markers(raw: &[String]) -> Result<Vec<String>, ShareRejection> {
    if raw.len() > MAX_STAGE_MARKERS {
        return Err(ShareRejection::new(format!(
            "stages must contain at most {MAX_STAGE_MARKERS} markers"
        )));
    }
    raw.iter()
        .map(|marker| {
            let text = bounded_text(marker, "stage marker", MAX_STAGE_MARKER_CHARS)?;
            // Stage labels are short words; a path separator means a path.
            if text.contains('/') || text.contains('\\') {
                return Err(ShareRejection::new(
                    "stage marker must not contain a path separator",
                ));
            }
            Ok(text)
        })
        .collect()
}

pub fn validated_count(
    raw: Option<i64>,
    field: &str,
    max: i64,
) -> Result<Option<i64>, ShareRejection> {
    match raw {
        None => Ok(None),
        Some(value) if (0..=max).contains(&value) => Ok(Some(value)),
        Some(_) => Err(ShareRejection::new(format!(
            "{field} must be an integer between 0 and {max}"
        ))),
    }
}

/// Epoch seconds, bounded to a believable clock.
pub fn validated_activity_secs(raw: i64, now_secs: i64) -> Result<i64, ShareRejection> {
    if raw < MIN_ACTIVITY_SECS || raw > now_secs.saturating_add(MAX_ACTIVITY_FUTURE_SKEW_SECS) {
        return Err(ShareRejection::new(
            "lastActivityAt is outside the believable clock range",
        ));
    }
    Ok(raw)
}

fn is_dns_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// The hosts a PR URL may name: `github.com` plus the operator's GitHub
/// Enterprise hosts (`MOMO_GITHUB_ENTERPRISE_HOSTS`, comma separated). Read once.
/// An entry that is not a plain lowercase DNS name is **dropped**, never
/// interpreted — a host list is the one place an operator typo must fail closed.
pub fn allowed_pr_hosts() -> &'static [String] {
    static HOSTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    HOSTS.get_or_init(|| {
        let mut hosts = vec!["github.com".to_string()];
        if let Ok(raw) = std::env::var("MOMO_GITHUB_ENTERPRISE_HOSTS") {
            for entry in raw.split(',') {
                let host = entry.trim().to_ascii_lowercase();
                if is_dns_host(&host) && host.contains('.') && !hosts.contains(&host) {
                    hosts.push(host);
                }
            }
        }
        hosts
    })
}

fn is_repo_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_REPO_SEGMENT_CHARS
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// ADR-0194 D7: `https`, an allowed host, and exactly `/<owner>/<repo>/pull/<n>`.
/// A query or fragment is **discarded** (ADR text), everything else outside the
/// grammar is refused: userinfo, a port, percent-escapes, a trailing path such as
/// `/files`, an IP literal. Returns the canonical `https://host/owner/repo/pull/n`.
pub fn validated_pr_url(raw: &str, allowed_hosts: &[String]) -> Result<String, ShareRejection> {
    let bad = || ShareRejection::new("prUrl must be an https pull request URL on an allowed host");
    if raw.len() > 300 || raw.chars().any(|c| c.is_whitespace() || is_unsafe_char(c)) {
        return Err(bad());
    }
    let without_fragment = raw.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();
    let rest = without_query.strip_prefix("https://").ok_or_else(bad)?;
    let mut parts = rest.split('/');
    let host = parts.next().ok_or_else(bad)?;
    let owner = parts.next().ok_or_else(bad)?;
    let repo = parts.next().ok_or_else(bad)?;
    let pull = parts.next().ok_or_else(bad)?;
    let number = parts.next().ok_or_else(bad)?;
    if parts.next().is_some() || pull != "pull" {
        return Err(bad());
    }
    // Host: exact, case-insensitive match against the allow-list. No userinfo, no
    // port, no IP literal can equal a DNS name on that list.
    let host = host.to_ascii_lowercase();
    if !is_dns_host(&host) || !allowed_hosts.contains(&host) {
        return Err(bad());
    }
    if !is_repo_segment(owner) || !is_repo_segment(repo) {
        return Err(bad());
    }
    let digits_ok = !number.is_empty()
        && number.len() <= 9
        && !number.starts_with('0')
        && number.bytes().all(|b| b.is_ascii_digit());
    if !digits_ok {
        return Err(bad());
    }
    Ok(format!("https://{host}/{owner}/{repo}/pull/{number}"))
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

/// What an upsert changed, for the one realtime event (ADR-0194 D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareTransition {
    /// No row before → shared now.
    Enabled,
    /// Shared before and now, and the derived state differs.
    StateChanged,
    /// Shared before and now with the same derived state: nothing to announce.
    Unchanged,
}

/// Replace the session's S1 payload (a full snapshot, not a merge — an omitted
/// optional field is cleared, so a host that stops knowing a PR URL stops
/// publishing it). One statement; the previous derived state comes back from the
/// same statement so two racing PATCHes agree on who announced what.
pub async fn upsert_share_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    fields: &ShareFields,
) -> Result<ShareTransition, T3Error> {
    let markers = Value::Array(
        fields
            .stage_markers
            .iter()
            .map(|marker| Value::String(marker.clone()))
            .collect(),
    );
    let activity_secs: Option<f64> = fields.last_activity_secs.map(|secs| secs as f64);
    // `old` is read before the write in the same statement; FOR UPDATE keeps a
    // concurrent PATCH from reading the same "before".
    let row = sqlx::query(
        "WITH old AS ( \
           SELECT derived_state FROM work_session_share \
            WHERE workspace_id = $1 AND session_id = $2 FOR UPDATE \
         ), up AS ( \
           INSERT INTO work_session_share \
             (workspace_id, session_id, repo_label, branch, harness, derived_state, \
              stage_markers, diff_added, diff_deleted, diff_files, commits_ahead, \
              commits_behind, uncommitted, pr_url, last_activity_at) \
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, \
                   CASE WHEN $15::float8 IS NULL THEN NULL ELSE to_timestamp($15::float8) END) \
           ON CONFLICT (workspace_id, session_id) DO UPDATE SET \
             repo_label = EXCLUDED.repo_label, branch = EXCLUDED.branch, \
             harness = EXCLUDED.harness, derived_state = EXCLUDED.derived_state, \
             stage_markers = EXCLUDED.stage_markers, \
             diff_added = EXCLUDED.diff_added, diff_deleted = EXCLUDED.diff_deleted, \
             diff_files = EXCLUDED.diff_files, commits_ahead = EXCLUDED.commits_ahead, \
             commits_behind = EXCLUDED.commits_behind, uncommitted = EXCLUDED.uncommitted, \
             pr_url = EXCLUDED.pr_url, last_activity_at = EXCLUDED.last_activity_at, \
             updated_at = now() \
           RETURNING 1 \
         ) \
         SELECT (SELECT derived_state FROM old) AS previous_state, \
                EXISTS (SELECT 1 FROM old) AS existed",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(&fields.repo_label)
    .bind(&fields.branch)
    .bind(&fields.harness)
    .bind(&fields.derived_state)
    .bind(&markers)
    .bind(fields.diff_added.map(|v| v as i32))
    .bind(fields.diff_deleted.map(|v| v as i32))
    .bind(fields.diff_files.map(|v| v as i32))
    .bind(fields.commits_ahead.map(|v| v as i32))
    .bind(fields.commits_behind.map(|v| v as i32))
    .bind(fields.uncommitted.map(|v| v as i32))
    .bind(&fields.pr_url)
    .bind(activity_secs)
    .fetch_one(&mut *conn)
    .await?;
    let existed: bool = row.try_get("existed")?;
    let previous: Option<String> = row.try_get("previous_state")?;
    Ok(match (existed, previous) {
        (false, _) => ShareTransition::Enabled,
        (true, Some(previous)) if previous != fields.derived_state => ShareTransition::StateChanged,
        (true, _) => ShareTransition::Unchanged,
    })
}

/// Unshare: delete the payload. Answers whether a row existed (so an unshare of
/// something not shared is a quiet no-op, not an event).
pub async fn delete_share_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<bool, T3Error> {
    let deleted =
        sqlx::query("DELETE FROM work_session_share WHERE workspace_id = $1 AND session_id = $2")
            .bind(workspace_id)
            .bind(session_id)
            .execute(&mut *conn)
            .await?
            .rows_affected();
    Ok(deleted > 0)
}

/// Workspaces with at least one payload past retention. Cross-tenant by
/// necessity (the notifier's BYPASSRLS read, same as every other sweep); the
/// deletes happen under each tenant's GUC.
pub async fn workspaces_with_expired_shares(
    conn: &mut PgConnection,
    limit: i64,
) -> Result<Vec<Uuid>, DbError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT s.workspace_id \
           FROM work_session_share s \
           JOIN work_session ws ON ws.workspace_id = s.workspace_id AND ws.id = s.session_id \
          WHERE ws.ended_at IS NOT NULL \
            AND ws.ended_at < clock_timestamp() - make_interval(days => $1) \
          LIMIT $2",
    )
    .bind(SHARE_RETENTION_DAYS)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// A session whose payload retention just deleted: the event needs its home
/// channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpiredShare {
    pub session_id: Uuid,
    pub channel_id: Uuid,
}

/// Delete this workspace's payloads whose session ended more than
/// [`SHARE_RETENTION_DAYS`] ago. One statement: the delete is the claim.
pub async fn delete_expired_shares_for_workspace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    limit: i64,
) -> Result<Vec<ExpiredShare>, DbError> {
    let rows = sqlx::query(
        "WITH doomed AS ( \
           SELECT s.session_id, ws.channel_id \
             FROM work_session_share s \
             JOIN work_session ws ON ws.workspace_id = s.workspace_id AND ws.id = s.session_id \
            WHERE s.workspace_id = $1 \
              AND ws.ended_at IS NOT NULL \
              AND ws.ended_at < clock_timestamp() - make_interval(days => $2) \
            LIMIT $3 FOR UPDATE OF s SKIP LOCKED \
         ) \
         DELETE FROM work_session_share s USING doomed \
          WHERE s.workspace_id = $1 AND s.session_id = doomed.session_id \
          RETURNING doomed.session_id, doomed.channel_id",
    )
    .bind(workspace_id)
    .bind(SHARE_RETENTION_DAYS)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(ExpiredShare {
                session_id: row.try_get("session_id")?,
                channel_id: row.try_get("channel_id")?,
            })
        })
        .collect()
}

/// The realtime envelope (ADR-0194 D8): the session id and the *kind* of
/// transition, nothing else — no name, branch, number or URL. A client that gets
/// it re-reads the card, so visibility is enforced again on the read. Sent only
/// when sharing turns on or off or the derived state changes.
///
/// `discriminator` makes two transitions of one session two outbox rows and a
/// retried one a single row.
pub fn share_changed_payload(
    cent_channel: &str,
    channel_id: Uuid,
    session_id: Uuid,
    kind: &str,
    ts_ms: i64,
    discriminator: Uuid,
) -> Value {
    json!({
        "channel": cent_channel,
        "data": {
            "type": "work.session.share_changed",
            "v": 1,
            "ts": ts_ms,
            "payload": {
                "session_id": session_id.to_string(),
                "channel_id": channel_id.to_string(),
                "kind": kind,
            },
        },
        "idempotency_key": format!(
            "{cent_channel}:work.session.share_changed:{session_id}:{discriminator}"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["github.com".into(), "ghe.example.com".into()]
    }

    #[test]
    fn a_canonical_pull_request_url_is_accepted_and_query_is_dropped() {
        assert_eq!(
            validated_pr_url("https://github.com/acme/oort/pull/2851", &hosts()).unwrap(),
            "https://github.com/acme/oort/pull/2851"
        );
        assert_eq!(
            validated_pr_url("https://GitHub.com/acme/oort/pull/7?x=1#frag", &hosts()).unwrap(),
            "https://github.com/acme/oort/pull/7"
        );
        assert_eq!(
            validated_pr_url("https://ghe.example.com/a.b/c_d/pull/1", &hosts()).unwrap(),
            "https://ghe.example.com/a.b/c_d/pull/1"
        );
    }

    #[test]
    fn everything_outside_the_grammar_is_refused() {
        for bad in [
            "http://github.com/acme/oort/pull/1",
            "ftp://github.com/acme/oort/pull/1",
            "//github.com/acme/oort/pull/1",
            "https://evil.example/acme/oort/pull/1",
            "https://github.com.evil.example/acme/oort/pull/1",
            "https://evilgithub.com/acme/oort/pull/1",
            "https://user@github.com/acme/oort/pull/1",
            "https://github.com@evil.example/acme/oort/pull/1",
            "https://github.com:8443/acme/oort/pull/1",
            "https://github.com\\@evil.example/acme/oort/pull/1",
            "https://127.0.0.1/acme/oort/pull/1",
            "https://[::1]/acme/oort/pull/1",
            "https://github.com/acme/oort/issues/1",
            "https://github.com/acme/oort/pull/1/files",
            "https://github.com/acme/oort/pull/",
            "https://github.com/acme/oort/pull/0",
            "https://github.com/acme/oort/pull/01",
            "https://github.com/acme/oort/pull/1234567890",
            "https://github.com/acme/oort/pull/1a",
            "https://github.com/acme/%2e%2e/pull/1",
            "https://github.com/../oort/pull/1",
            "https://github.com/acme/oort/pull/1\n",
            "https://github.com/acme/oort /pull/1",
            "https://github.com/acme//pull/1",
            "",
        ] {
            assert!(
                validated_pr_url(bad, &hosts()).is_err(),
                "must refuse {bad:?}"
            );
        }
    }

    #[test]
    fn text_fields_refuse_paths_and_control_characters() {
        assert!(validated_repo_label("momo").is_ok());
        assert!(validated_repo_label("/Users/me/momo").is_err());
        assert!(validated_repo_label("a\\b").is_err());
        assert!(validated_repo_label("a\u{1b}[31m").is_err());
        assert!(validated_repo_label("").is_err());
        assert!(validated_repo_label(&"x".repeat(101)).is_err());
        assert!(validated_branch("feat/2774-xterm").is_ok());
        assert!(validated_branch("/etc/passwd").is_err());
        assert!(validated_branch("~/work").is_err());
        assert!(validated_branch("C:\\work").is_err());
        assert!(validated_branch("c:/work").is_err());
        assert!(
            validated_branch("fix: rotate prod key").is_err(),
            "a commit title is not a branch"
        );
        assert!(validated_branch("fix rotate").is_err());
        assert!(validated_branch("feat/한글-브랜치").is_ok());
        assert!(validated_branch(&"x".repeat(201)).is_err());
        assert!(validated_stage_markers(&["원인 찾음".into(), "수정 커밋".into()]).is_ok());
        assert!(validated_stage_markers(&vec!["a".to_string(); 13]).is_err());
        assert!(validated_stage_markers(&["x".repeat(81)]).is_err());
        assert!(validated_stage_markers(&["bad\u{7}".into()]).is_err());
        assert!(validated_stage_markers(&["\u{202E}rtl".into()]).is_err());
        assert!(validated_stage_markers(&["/Users/me/secret/auth.rs".into()]).is_err());
        for hidden in [
            "\u{2028}",
            "\u{2029}",
            "\u{061C}",
            "\u{2060}",
            "\u{00AD}",
            "\u{3164}",
            "\u{E0041}",
        ] {
            assert!(
                validated_repo_label(&format!("oort{hidden}x")).is_err(),
                "{hidden:?}"
            );
        }
    }

    #[test]
    fn closed_lists_and_counters_are_enforced() {
        assert!(validated_harness("claude").is_ok());
        assert!(validated_harness("cursor").is_err());
        assert!(validated_state("waiting").is_ok());
        assert!(
            validated_state("quiet").is_err(),
            "조용함 is not in the vocabulary"
        );
        assert!(validated_state("ended").is_err());
        assert!(validated_state("나를 기다림").is_err());
        assert_eq!(validated_count(Some(5), "x", 10).unwrap(), Some(5));
        assert!(validated_count(Some(-1), "x", 10).is_err());
        assert!(validated_count(Some(11), "x", 10).is_err());
        let now = 1_900_000_000;
        assert_eq!(
            validated_activity_secs(1_800_000_123, now).unwrap(),
            1_800_000_123
        );
        assert!(validated_activity_secs(0, now).is_err());
        assert!(validated_activity_secs(now + 10 * 60, now).is_err());
        assert!(
            validated_activity_secs(1_800_000_123_456, now).is_err(),
            "milliseconds are not seconds"
        );
    }
}
