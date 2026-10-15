//! Team board reads (#3322, serves #2863): `GET …/work-sessions/shared` (list)
//! and `GET …/work-sessions/{session}/shared` (one).
//!
//! ADR-0190 D4 / Q4 and ADR-0194. The write side is `PATCH …/share` (#2862,
//! host-signed); this is its read side, for people.
//!
//! * **Human bearer only.** A host signature or agent token is 403 here (a host
//!   can write its own share, never read the board).
//! * **Membership is decided in SQL** (`momo_t3::work_board`): only sessions
//!   whose home channel the viewer is an active member of. There is no
//!   workspace-wide view. A single read that the viewer may not see — not a
//!   member, never shared, unshared, ended past retention, nonexistent, or
//!   another tenant's id under RLS — is **the same 404 with the same body**,
//!   produced by the same code path (no 403 that says "it exists").
//! * **No totals.** A page reports `nextCursor` only when more rows follow; the
//!   count of rows the viewer cannot see is never observable.
//! * **ADR-0202 D4 (#3853): `include=jobs` and `who=mine|team`.** `include` is a
//!   comma-separated closed set (`runs`, `jobs`); any other token is a 400.
//!   `jobs` widens the run rows to every agent's delegated work (`momo_t3::
//!   work_board` decides which mention runs count) and adds the job fields
//!   (`trigger`, `phase`, `durationMs`, `resultMessageId`, `agentReported`).
//!   `who` defaults to `team`, the set shipped clients already get; `mine`
//!   narrows to what the viewer asked for or owns. With neither parameter the
//!   response is byte-for-byte the shipped one: every new key is optional and
//!   absent, and the page echoes `who` only to a caller that used the new
//!   parameters.
//! * **Realtime is event → refetch.** `work.session.share_changed` carries only
//!   the session id and the kind; a client that receives one re-reads this
//!   endpoint. Nothing in the event is trusted as board content.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_t3::work_board::{
    get_board_item_in_tx, list_board_scoped_in_tx, BoardCursor, BoardItem, BoardScope, BoardSource,
    DEFAULT_PAGE, MAX_PAGE,
};
use serde_json::Value;
use uuid::Uuid;

use crate::dto::{
    AgentReportedDto, AgentReportedTestsDto, SharedDiffDto, SharedPrDto, SharedSessionChannelDto,
    SharedSessionOwnerDto, SharedWorkSessionDto, SharedWorkSessionListQuery,
    SharedWorkSessionListResponse, SharedWorkSessionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, require_human, settle, tenant_tx, workspace_scope};
use crate::AppState;

/// One message for every reason the viewer cannot see a single session.
pub const NOT_FOUND: &str = "shared work session not found";

pub fn encode_cursor(cursor: BoardCursor) -> String {
    format!("{}_{}", cursor.activity_us, cursor.session_id)
}

/// Strict: `<non-negative µs>_<hyphenated uuid>` or 400.
pub fn decode_cursor(raw: &str) -> Result<BoardCursor, ApiError> {
    let invalid = || ApiError::bad_request("invalid cursor");
    let (us, id) = raw.split_once('_').ok_or_else(invalid)?;
    if us.is_empty() || us.len() > 19 || !us.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let activity_us: i64 = us.parse().map_err(|_| invalid())?;
    let session_id = Uuid::parse_str(id).map_err(|_| invalid())?;
    if id.len() != 36 {
        return Err(invalid());
    }
    Ok(BoardCursor {
        activity_us,
        session_id,
    })
}

pub const INVALID_INCLUDE: &str = "invalid include";
pub const INVALID_WHO: &str = "invalid who";

/// What the list query asked for (ADR-0202 D4). Strict: unknown is a 400.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListScope {
    pub board: BoardScope,
    /// The `who` to echo on the page, when the caller used the new parameters.
    pub echo_who: Option<&'static str>,
}

pub fn parse_scope(include: Option<&str>, who: Option<&str>) -> Result<ListScope, ApiError> {
    let mut board = BoardScope::default();
    if let Some(raw) = include {
        for token in raw.split(',') {
            match token {
                "runs" => board.include_runs = true,
                "jobs" => board.include_jobs = true,
                _ => return Err(ApiError::bad_request(INVALID_INCLUDE)),
            }
        }
    }
    // `jobs` is a superset of `runs` (every hosted work run is a job).
    if board.include_jobs {
        board.include_runs = true;
    }
    let who_word = match who {
        None => None,
        Some("team") => Some("team"),
        Some("mine") => Some("mine"),
        Some(_) => return Err(ApiError::bad_request(INVALID_WHO)),
    };
    board.who_mine = who_word == Some("mine");
    let echo_who = if who_word.is_some() || board.include_jobs {
        Some(who_word.unwrap_or("team"))
    } else {
        None
    };
    Ok(ListScope { board, echo_who })
}

/// ADR-0162 증보 5 C1·C2's closed vocabularies. The write side (the gateway)
/// validates before storing; this read re-checks so that a row written before
/// the contract, or by hand, can only ever surface a closed value.
const RESULT_KINDS: [&str; 4] = ["pr_opened", "branch_only", "vm_only", "no_change"];
const NEXT_ACTIONS: [&str; 4] = ["merge_ok", "please_test", "blocked", "none"];
const TOOL_COUNT_KEYS: [&str; 6] = ["run", "edit", "read", "search", "web", "other"];
const MAX_REPORTED_COUNT: i64 = 100_000;

fn closed(value: Option<&Value>, set: &[&'static str]) -> Option<&'static str> {
    let text = value?.as_str()?;
    set.iter().copied().find(|word| *word == text)
}

fn count(value: Option<&Value>) -> Option<i64> {
    value?
        .as_i64()
        .filter(|number| (0..=MAX_REPORTED_COUNT).contains(number))
}

/// `output.artifacts` → only the closed result fields. `None` when the agent
/// reported none of them (a PR link or diff alone is the server-side `pr`/`diff`).
pub fn agent_reported(artifacts: Option<&Value>) -> Option<AgentReportedDto> {
    let artifacts = artifacts?.as_object()?;
    let result_kind = closed(artifacts.get("resultKind"), &RESULT_KINDS);
    let next_action = closed(artifacts.get("nextAction"), &NEXT_ACTIONS);
    let tests = artifacts
        .get("tests")
        .and_then(Value::as_object)
        .and_then(|tests| {
            Some(AgentReportedTestsDto {
                passed: count(tests.get("passed"))?,
                failed: count(tests.get("failed"))?,
                not_run: count(tests.get("notRun"))?,
            })
        });
    let commit_sha = artifacts
        .get("commitSha")
        .and_then(Value::as_str)
        .filter(|sha| (7..=40).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase);
    let tool_counts = artifacts
        .get("toolCounts")
        .and_then(Value::as_object)
        .map(|counts| {
            TOOL_COUNT_KEYS
                .iter()
                .filter_map(|key| {
                    count(counts.get(*key)).map(|n| ((*key).to_string(), Value::from(n)))
                })
                .collect::<serde_json::Map<String, Value>>()
        })
        .filter(|counts| !counts.is_empty());
    if result_kind.is_none()
        && tests.is_none()
        && next_action.is_none()
        && commit_sha.is_none()
        && tool_counts.is_none()
    {
        return None;
    }
    Some(AgentReportedDto {
        result_kind,
        tests,
        next_action,
        commit_sha,
        tool_counts,
    })
}

/// The ADR-0200 phase word of a run row (`claimed` = queued with a leased job).
fn phase_of(run_status: &str, leased: bool) -> Option<&'static str> {
    Some(match run_status {
        "queued" if leased => "claimed",
        "queued" => "queued",
        "running" => "running",
        "awaiting_approval" => "awaiting_approval",
        "paused" => "paused",
        "succeeded" => "succeeded",
        "failed" => "failed",
        "timed_out" => "timed_out",
        "cancelled" => "cancelled",
        _ => return None,
    })
}

fn trigger_word(trigger: Option<&str>) -> Option<&'static str> {
    match trigger? {
        "work" => Some("work"),
        "mention" => Some("mention"),
        "thread_reply" => Some("thread_reply"),
        _ => None,
    }
}

/// Lenient like the message-history page size: a bad size has a safe default.
fn page_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|text| text.parse::<i64>().ok())
        .map(|value| value.clamp(1, MAX_PAGE))
        .unwrap_or(DEFAULT_PAGE)
}

/// `jobs`: add the ADR-0202 job fields to run rows; `leased` = run ids whose
/// pending delivery job is leased (only consulted for `queued`).
fn dto(
    item: BoardItem,
    jobs: bool,
    leased: &std::collections::HashSet<Uuid>,
) -> SharedWorkSessionDto {
    let is_run = item.source == BoardSource::Run;
    let run = item.run;
    let job = run.as_ref().filter(|_| jobs);
    let trigger = job.and_then(|run| trigger_word(run.trigger.as_deref()));
    let phase = job.and_then(|run| phase_of(&run.run_status, leased.contains(&run.run_id)));
    let duration_ms = job
        .and(item.ended_at_ms)
        .map(|ended| (ended - item.started_at_ms).max(0));
    let result_message_id = job
        .and_then(|run| run.result_message_id)
        .map(|id| id.to_string());
    let agent_reported = job.and_then(|run| agent_reported(run.agent_report.as_ref()));
    let pr = match (is_run, item.pr_url.as_ref()) {
        (true, Some(url)) => Some(SharedPrDto {
            url: url.clone(),
            number: run.as_ref().and_then(|run| run.pr_number),
        }),
        _ => None,
    };
    SharedWorkSessionDto {
        source: item.source.as_str(),
        session_id: (!is_run).then(|| item.session_id.to_string()),
        run_id: run.as_ref().map(|run| run.run_id.to_string()),
        requested_by: run.as_ref().and_then(|run| {
            run.requested_by
                .as_ref()
                .map(|(member_id, display_name)| SharedSessionOwnerDto {
                    member_id: member_id.to_string(),
                    display_name: display_name.clone(),
                })
        }),
        step_count: run.as_ref().map(|run| run.step_count),
        commits: run.as_ref().and_then(|run| run.commits),
        pr,
        origin: item.origin,
        label: item.label,
        folder_label: item.folder_label,
        status: item.status,
        owner: SharedSessionOwnerDto {
            member_id: item.owner_member_id.to_string(),
            display_name: item.owner_display_name,
        },
        home_channel: SharedSessionChannelDto {
            id: item.channel_id.to_string(),
            name: item.channel_name,
        },
        started_at_ms: item.started_at_ms,
        ended_at_ms: item.ended_at_ms,
        shared_at_ms: item.shared_at_ms,
        repo: item.repo,
        branch: item.branch,
        harness: item.harness,
        state: item.state,
        stages: item.stages,
        diff: SharedDiffDto {
            added: item.diff.added,
            deleted: item.diff.deleted,
            files: item.diff.files,
            ahead: item.diff.ahead,
            behind: item.diff.behind,
            uncommitted: item.diff.uncommitted,
        },
        pr_url: item.pr_url,
        last_activity_at: item.last_activity_at,
        trigger,
        phase,
        duration_ms,
        result_message_id,
        agent_reported,
    }
}

/// `GET /v1/workspaces/{ws}/work-sessions/shared?limit=&cursor=&include=&who=`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<SharedWorkSessionListQuery>,
) -> Result<Json<SharedWorkSessionListResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the team board requires a signed-in member")?;
    let after = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let limit = page_limit(query.limit.as_deref());
    let scope = parse_scope(query.include.as_deref(), query.who.as_deref())?;
    let viewer = principal.member_id;
    let jobs = scope.board.include_jobs;

    let (page, leased) = settle(
        "work_board.list",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let page =
                    list_board_scoped_in_tx(conn, workspace_id, viewer, scope.board, after, limit)
                        .await?;
                // ADR-0200 `claimed`: a queued run whose delivery job is leased.
                // The claim's own predicate (momo-outbox), as the run reads use.
                let mut leased = std::collections::HashSet::new();
                if jobs {
                    let queued: Vec<(Uuid, Uuid)> = page
                        .items
                        .iter()
                        .filter_map(|item| {
                            item.run
                                .as_ref()
                                .filter(|run| run.run_status == "queued")
                                .map(|run| (run.run_id, item.owner_member_id))
                        })
                        .collect();
                    for fact in
                        momo_outbox::pending_job_facts_for_runs_in_tx(conn, workspace_id, &queued)
                            .await?
                    {
                        if fact.leased {
                            leased.insert(fact.run_id);
                        }
                    }
                }
                Ok(Ok((page, leased)))
            })
        })
        .await,
    )?;
    Ok(Json(SharedWorkSessionListResponse {
        next_cursor: page.next.map(encode_cursor),
        sessions: page
            .items
            .into_iter()
            .map(|item| dto(item, jobs, &leased))
            .collect(),
        who: scope.echo_who,
    }))
}

/// `GET /v1/workspaces/{ws}/work-sessions/{session}/shared`
pub async fn get_one(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
) -> Result<Json<SharedWorkSessionResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    require_human(&principal, "the team board requires a signed-in member")?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let viewer = principal.member_id;

    let item = settle(
        "work_board.get",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(get_board_item_in_tx(
                    conn,
                    workspace_id,
                    viewer,
                    session_id,
                )
                .await?))
            })
        })
        .await,
    )?;
    match item {
        Some(item) => Ok(Json(SharedWorkSessionResponse {
            session: dto(item, false, &std::collections::HashSet::new()),
        })),
        None => Err(ApiError::not_found(NOT_FOUND)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_garbage_is_a_400() {
        let cursor = BoardCursor {
            activity_us: 1_790_000_000_123_456,
            session_id: Uuid::from_u128(7),
        };
        assert_eq!(decode_cursor(&encode_cursor(cursor)).unwrap(), cursor);
        for bad in [
            "",
            "x",
            "1_",
            "_1",
            "-1_00000000-0000-0000-0000-000000000007",
            "1_0000000000000000000000000000000007",
            "99999999999999999999_00000000-0000-0000-0000-000000000007",
            "1_00000000-0000-0000-0000-000000000007_",
        ] {
            let error = decode_cursor(bad).expect_err(bad);
            assert_eq!(error.message, "invalid cursor", "{bad}");
        }
    }

    #[test]
    fn include_and_who_are_closed_sets_and_jobs_implies_runs() {
        let scope = parse_scope(None, None).unwrap();
        assert_eq!(scope.board, BoardScope::default());
        assert_eq!(
            scope.echo_who, None,
            "the shipped request shape echoes nothing"
        );

        let runs = parse_scope(Some("runs"), None).unwrap();
        assert!(runs.board.include_runs && !runs.board.include_jobs);
        assert_eq!(runs.echo_who, None);

        for raw in ["jobs", "runs,jobs", "jobs,runs"] {
            let jobs = parse_scope(Some(raw), None).unwrap();
            assert!(jobs.board.include_runs && jobs.board.include_jobs, "{raw}");
            assert!(!jobs.board.who_mine, "{raw}: who defaults to team");
            assert_eq!(jobs.echo_who, Some("team"), "{raw}");
        }
        let mine = parse_scope(Some("runs,jobs"), Some("mine")).unwrap();
        assert!(mine.board.who_mine);
        assert_eq!(mine.echo_who, Some("mine"));
        let team = parse_scope(None, Some("team")).unwrap();
        assert!(!team.board.who_mine);
        assert_eq!(team.echo_who, Some("team"));

        for bad in [
            "",
            "x",
            "runs,",
            ",runs",
            "RUNS",
            "runs, jobs",
            "runs,sessions",
            "tools",
        ] {
            let error = parse_scope(Some(bad), None).expect_err(bad);
            assert_eq!(error.message, INVALID_INCLUDE, "{bad}");
        }
        for bad in ["", "all", "MINE", "me"] {
            let error = parse_scope(None, Some(bad)).expect_err(bad);
            assert_eq!(error.message, INVALID_WHO, "{bad}");
        }
    }

    #[test]
    fn agent_reported_keeps_only_closed_fields() {
        use serde_json::json;
        assert!(agent_reported(None).is_none());
        assert!(agent_reported(Some(&json!("x"))).is_none());
        // PR link / diff / branch alone are not an agent report.
        assert!(agent_reported(Some(&json!({
            "prUrl": "https://github.com/a/b/pull/1", "branch": "b", "added": 3
        })))
        .is_none());
        let report = agent_reported(Some(&json!({
            "resultKind": "pr_opened",
            "tests": {"passed": 12, "failed": 1, "notRun": 3},
            "nextAction": "please_test",
            "commitSha": "ABCDEF1234",
            "toolCounts": {"run": 4, "edit": 2, "bogus": 9, "web": -1},
            "prUrl": "https://github.com/a/b/pull/1",
            "secret": "SECRET"
        })))
        .unwrap();
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(
            wire,
            json!({
                "resultKind": "pr_opened",
                "tests": {"passed": 12, "failed": 1, "notRun": 3},
                "nextAction": "please_test",
                "commitSha": "abcdef1234",
                "toolCounts": {"run": 4, "edit": 2}
            })
        );
        // Unknown words and out-of-range numbers are dropped field by field.
        let partial = agent_reported(Some(&json!({
            "resultKind": "merged",
            "tests": {"passed": 1, "failed": 100001, "notRun": 0},
            "nextAction": "ship_it",
            "commitSha": "xyz1234",
            "toolCounts": {"read": 7}
        })))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&partial).unwrap(),
            json!({"resultKind": null, "tests": null, "nextAction": null,
                   "commitSha": null, "toolCounts": {"read": 7}})
        );
    }

    #[test]
    fn phase_is_the_adr_0200_word() {
        assert_eq!(phase_of("queued", false), Some("queued"));
        assert_eq!(phase_of("queued", true), Some("claimed"));
        assert_eq!(phase_of("running", true), Some("running"));
        assert_eq!(
            phase_of("awaiting_approval", false),
            Some("awaiting_approval")
        );
        assert_eq!(phase_of("timed_out", false), Some("timed_out"));
        assert_eq!(phase_of("weird", false), None);
        assert_eq!(trigger_word(Some("thread_reply")), Some("thread_reply"));
        assert_eq!(trigger_word(Some("dm_implicit")), None);
    }

    #[test]
    fn page_size_clamps_and_defaults() {
        assert_eq!(page_limit(None), DEFAULT_PAGE);
        assert_eq!(page_limit(Some("abc")), DEFAULT_PAGE);
        assert_eq!(page_limit(Some("0")), 1);
        assert_eq!(page_limit(Some("100000")), MAX_PAGE);
        assert_eq!(page_limit(Some("7")), 7);
    }
}
