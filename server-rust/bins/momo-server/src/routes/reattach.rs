//! Session reattach + replay (ADR-0139) — `GET /v1/workspaces/{ws}/work-sessions/{session}/reattach`.
//!
//! ## Why this route exists when the Swift server has no route by this name
//!
//! ADR-0139's 이행 step 1 is "엔진: 수명주기 REST/이벤트", and the Swift server
//! reached it by composition: a returning client calls `GET …/work-sessions?
//! active=1` to find its session, `GET …/work-hosts` to learn whether the host
//! is alive, `GET …/channels/{ch}/messages/{root}/replies?cursor=` to replay the
//! thread, and `POST …/terminal-attach` to get back on the PTY. Every one of
//! those is measured and ported; none of them is changed by this module.
//!
//! What the composition never produced is the **decision**. ADR-0139 D3 says
//! reattach ("이어서 보기/쓰기") and lineage resume ("새 호스트에서 재개") are
//! different acts that must not sit behind one button — and today each client
//! re-derives that branch itself from `status` plus host liveness. The web
//! client's `canReattachWorkSession` and the mac console already disagree about
//! one input (`workSessionModel.ts:630-655` documents why it excludes
//! `online` from trust while including it in the reattach gate). A rule that
//! decides what a user is offered belongs on the server, once.
//!
//! So this route is: **one round trip that returns the snapshot, the verdict and
//! the first replay page**, built entirely from the two measured surfaces above
//! and adding no storage, no migration, and no semantics of its own. A client
//! that prefers the four separate calls still has them.
//!
//! ## Parity of the two halves
//!
//! | half | Swift source |
//! |---|---|
//! | session projection | `WorkSessionRoutes.list` (:2038-2087) |
//! | attach eligibility | `TerminalAttachRoutes.issue` gate (:209-216) |
//! | replay page, cursor + limit + `nextCursor` | `MessageRoutes.replies` (:521-620) |
//! | cursor parsing (400 on garbage) | `repliesCursor` (:967-974) |
//! | membership refusals | `WorkSessionRoutes.requireChannelMember` (:2463-2464) |
//!
//! ## No SQL here
//!
//! Both statements are `momo_t3::reattach`. This module parses a query string,
//! decides an authorization ladder, and shapes a DTO.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal, ONLINE_WINDOW_SECONDS};
use momo_t3::{
    clamp_replay_limit, is_active_channel_member_in_tx, list_session_events_in_tx,
    load_session_reattach_state_in_tx, ReattachVerdict, SessionEvent, T3Error,
};
use uuid::Uuid;

use crate::dto::{MessageDto, ReattachQuery, WorkSessionDto, WorkSessionReattachResponse};
use crate::error::ApiError;
use crate::routes::shared::{path_uuid, settle, tenant_tx, workspace_scope, Rejectable};
use crate::AppState;

/// `repliesCursor` (:967-974): absent or blank is "from the start"; anything
/// else must be a non-negative `message.seq`.
///
/// Strict where the `limit` parser is lenient, and the asymmetry is Swift's for
/// a reason worth keeping: a bad page size has a safe default, a bad cursor does
/// not — silently restarting from 0 would re-deliver a whole session's events as
/// if they had just happened.
fn replay_cursor(raw: Option<&str>) -> Result<Option<i64>, ApiError> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match trimmed.parse::<i64>() {
        Ok(cursor) if cursor >= 0 => Ok(Some(cursor)),
        _ => Err(ApiError::bad_request(
            "cursor must be a non-negative message seq",
        )),
    }
}

fn verdict_label(verdict: ReattachVerdict) -> &'static str {
    match verdict {
        ReattachVerdict::Reattach => "reattach",
        ReattachVerdict::ResumeLineage => "resume_lineage",
        ReattachVerdict::ReplayOnly => "replay_only",
    }
}

/// A replayed thread row in the `MessageDto` shape `…/replies` already returns,
/// so a client can feed both into one renderer.
fn event_dto(event: SessionEvent, channel_id: Uuid, root_message_id: Uuid) -> MessageDto {
    MessageDto {
        id: event.id.to_string(),
        channel_id: channel_id.to_string(),
        root_id: Some(root_message_id.to_string()),
        // A session event card is a host's log line, not a member pointing at
        // another member's message — there is nothing here to quote (ADR-0148).
        reply_to_id: None,
        reply_to: None,
        seq: event.seq,
        hlc_ts: event.hlc_ts,
        hlc_count: event.hlc_count,
        author_member_id: event.author_member_id.to_string(),
        message_type: event.message_type,
        body: event.body,
        // Empty props are omitted, matching every other message projection.
        props: match event.props.as_object() {
            Some(object) if !object.is_empty() => Some(event.props),
            _ => None,
        },
        client_msg_id: None,
        created_at_ms: event.created_at_ms,
        state: Some(event.state),
        // A session event card is written by a host, not said by a member, so
        // there is no author who could edit or delete it. Both keys stay absent
        // rather than being reported as `null`.
        edited_at_ms: None,
        deleted_at_ms: None,
        // ADR-0151 — a host's log line carries no file. Attachments are bound by
        // the REST send, and a session event never travels that path.
        attachments: Vec::new(),
        // A replayed row is a reply inside the session thread, and a reply
        // carries no rollup of its own — momo threads are one level deep.
        thread: None,
        // #1166 — a session event never streamed and names no run, so there is
        // no half-written answer here for a run's ending to explain.
        run_ended: false,
    }
}

fn session_dto(detail: momo_t3::WorkSessionDetail) -> WorkSessionDto {
    WorkSessionDto {
        id: detail.id.to_string(),
        workspace_id: detail.workspace_id.to_string(),
        channel_id: detail.channel_id.to_string(),
        member_id: detail.member_id.to_string(),
        host_id: detail.host_id.to_string(),
        root_message_id: detail.root_message_id.to_string(),
        tool: detail.tool,
        label: detail.label,
        status: detail.status,
        observation: detail.observation,
        observer_grant_count: detail.observer_grant_count,
        remote_attach_available: detail.remote_attach_available,
        remote_display_available: detail.remote_display_available,
        started_at_ms: detail.started_at_ms,
        ended_at_ms: detail.ended_at_ms,
        exit_code: detail.exit_code,
        end_reason: detail.end_reason,
        resumed_from_session_id: detail.resumed_from_session_id.map(|id| id.to_string()),
    }
}

/// `GET /v1/workspaces/{ws}/work-sessions/{session}/reattach`.
pub async fn reattach(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Query(query): Query<ReattachQuery>,
) -> Result<Json<WorkSessionReattachResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let cursor = replay_cursor(query.cursor.as_deref())?;
    let limit = clamp_replay_limit(query.limit());
    let member_id = principal.member_id;

    settle(
        "work_sessions.reattach",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                reattach_in_tx(conn, workspace_id, member_id, session_id, cursor, limit).await
            })
        })
        .await,
    )
    .map(Json)
}

async fn reattach_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    cursor: Option<i64>,
    limit: i64,
) -> Rejectable<WorkSessionReattachResponse> {
    // The authorization ladder is `TerminalAttachRoutes.issue`'s, and the order
    // is the non-disclosure property: workspace membership is checked before the
    // session is looked up, so a stranger gets 403 and never learns whether this
    // session id exists.
    if active_workspace_role(conn, workspace_id, member_id)
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("not an active workspace member")));
    }
    let Some(state) =
        load_session_reattach_state_in_tx(conn, workspace_id, session_id, ONLINE_WINDOW_SECONDS)
            .await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    // A workspace member who is not in the session's channel may not replay its
    // thread: the thread is the channel's, and this route must not become a way
    // around channel membership.
    if !is_active_channel_member_in_tx(conn, workspace_id, state.session.channel_id, member_id)
        .await?
    {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }

    // `limit + 1` is the look-ahead: `hasMore` is decided here, in one place,
    // exactly like Swift `replies` (:617-619).
    let mut events =
        list_session_events_in_tx(conn, workspace_id, session_id, cursor, limit + 1).await?;
    let has_more = events.len() as i64 > limit;
    events.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| events.last().map(|event| event.seq))
        .flatten();

    let channel_id = state.session.channel_id;
    let root_message_id = state.session.root_message_id;
    let verdict = verdict_label(state.verdict());

    Ok(Ok(WorkSessionReattachResponse {
        work_session: session_dto(state.session),
        verdict,
        host_online: state.host_online,
        host_revoked: state.host_revoked,
        root_message_seq: state.root_message_seq,
        last_event_seq: state.last_event_seq,
        events: events
            .into_iter()
            .map(|event| event_dto(event, channel_id, root_message_id))
            .collect(),
        next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn cursor_is_strict_where_limit_is_lenient() {
        assert_eq!(replay_cursor(None).unwrap(), None);
        assert_eq!(replay_cursor(Some("")).unwrap(), None);
        assert_eq!(replay_cursor(Some("  ")).unwrap(), None);
        assert_eq!(replay_cursor(Some("0")).unwrap(), Some(0));
        assert_eq!(replay_cursor(Some(" 42 ")).unwrap(), Some(42));
        for bad in ["-1", "abc", "1.5", "9999999999999999999999"] {
            let error = replay_cursor(Some(bad)).expect_err("must be refused");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.message, "cursor must be a non-negative message seq");
        }

        // The limit parser degrades to the default rather than 400 (Swift).
        let query = ReattachQuery {
            cursor: None,
            limit: Some("garbage".into()),
        };
        assert_eq!(query.limit(), None);
        assert_eq!(clamp_replay_limit(query.limit()), 50);
    }

    #[test]
    fn verdict_labels_are_the_wire_vocabulary() {
        assert_eq!(verdict_label(ReattachVerdict::Reattach), "reattach");
        assert_eq!(
            verdict_label(ReattachVerdict::ResumeLineage),
            "resume_lineage",
            "ADR-0139 D3: a lineage resume must never be spelled like an attach"
        );
        assert_eq!(verdict_label(ReattachVerdict::ReplayOnly), "replay_only");
    }

    #[test]
    fn an_event_projects_into_the_replies_message_shape() {
        let channel = Uuid::from_u128(2);
        let root = Uuid::from_u128(6);
        let dto = event_dto(
            SessionEvent {
                id: Uuid::from_u128(11),
                seq: 12,
                hlc_ts: 1_700_000_000_000,
                hlc_count: 0,
                author_member_id: Uuid::from_u128(4),
                message_type: "system".into(),
                body: Some("작업 완료 — idle 대기".into()),
                props: serde_json::json!({"kind": "work_session_idle"}),
                state: "active".into(),
                created_at_ms: 1_700_000_000_123,
            },
            channel,
            root,
        );
        assert_eq!(dto.seq, 12);
        assert_eq!(dto.root_id.as_deref(), Some(root.to_string().as_str()));
        assert_eq!(dto.channel_id, channel.to_string());
        assert_eq!(
            dto.props.unwrap()["kind"],
            serde_json::json!("work_session_idle")
        );
        assert_eq!(dto.state.as_deref(), Some("active"));

        let empty = event_dto(
            SessionEvent {
                id: Uuid::from_u128(11),
                seq: 13,
                hlc_ts: 1,
                hlc_count: 0,
                author_member_id: Uuid::from_u128(4),
                message_type: "text".into(),
                body: None,
                props: serde_json::json!({}),
                state: "active".into(),
                created_at_ms: 1,
            },
            channel,
            root,
        );
        assert!(
            empty.props.is_none(),
            "empty props are omitted, matching every other message projection"
        );
    }
}
