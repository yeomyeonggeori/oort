//! `POST /v1/workspaces/{ws}/messages/{message}/push-reply` — the lock screen's
//! reply to the notification it was woken by (#6072, ADR-0204 증보 7).
//!
//! A locked phone shows a 「답장」 field on a message notification. The native
//! handler keeps the typed text first (#6091's 「못 보낸 답장 보관함」), then sends
//! it here with the `push_action` token, so the reply arrives without the app
//! being opened. Anything but a 2xx leaves the kept reply for the app, which sends
//! it through the ordinary send with the same key.
//!
//! What makes this door narrow, in the order a request meets it:
//!
//! 1. **One credential.** The middleware lets a `push_action` token reach this path
//!    only while the operator's switch is on (A7-4), judged with the route list
//!    before any query. This handler then refuses every OTHER credential — a
//!    person's session has the ordinary send, an agent, a developer token and the
//!    extension's token have no use for it (A7-2).
//! 2. **A closed body of two keys** (`clientMsgId`, `body`), at most 16 KiB on the
//!    wire (the route's own limit, `lib.rs`) and 2,000 characters of text. Any
//!    other key is a 400 and nothing is written: no props, attachments, quote,
//!    routing, apps, thread choice or channel choice.
//! 3. **The server picks the conversation.** The channel is the notified message's;
//!    a thread reply's notification is answered in that thread, any other in the
//!    channel itself — the same rule that picked the payload's `thread_id`.
//! 4. **A notification on record.** A `push_dispatch_log` row for this member and
//!    this message that APNs accepted (status 200) within the last 24 hours, on a
//!    message that is not deleted. A message with no such row — never notified,
//!    notified only to someone else, notified too long ago, deleted, unknown, or in
//!    another workspace (invisible under RLS) — gets ONE status and ONE sentence,
//!    so the answer says nothing about whether the message exists (A7-3 2).
//! 5. **The ordinary send's one write function** ([`deliver_message_via_in_tx`]):
//!    the membership check, `channel_seq` + message + outbox in this transaction,
//!    mentions, runs and pushes exactly as from the app (A7-3 1 · 3 · 5).
//! 6. **One reply per notification**, counted on this door's audit rows under a
//!    per-(member, notification) transaction lock. A retry with the same key is
//!    answered with the stored message and never counted (A7-3 4).
//!
//! The answer carries the written message's id and `seq` only — this token reads
//! nothing, and that holds for its own answers too. Neither the text nor the token
//! is ever logged.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{Principal, PrincipalKind, AUDIT_VIA_PUSH_ACTION};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{sqlx, DbError};
use momo_messaging::{MessageType, NewMessage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::auth::PushActionCredential;
use crate::error::{db_error, ApiError};
use crate::routes::deliver::{
    deliver_message_via_in_tx, DeliverGates, DeliverRefusal, DeliverRequest,
};
use crate::routes::messages::delivery_refusal;
use crate::routes::shared::audit_via_token_id;
use crate::AppState;

/// The request body's byte ceiling, applied on this route alone (A7-4). The
/// router's default layer is far larger, and leaning on it would read a large
/// body before refusing it.
pub const PUSH_REPLY_MAX_BODY_BYTES: usize = 16 * 1024;

/// The reply's length ceiling in characters (Unicode scalar values, `str::chars`).
/// The server has no message-length limit of its own, so this door keeps one.
pub const PUSH_REPLY_MAX_CHARS: usize = 2_000;

/// How long after a notification its reply is still taken here (A7-4).
pub const PUSH_REPLY_WINDOW_HOURS: i32 = 24;

/// How many messages one notification may carry here (A7-4).
pub const PUSH_REPLY_PER_NOTIFICATION: i64 = 1;

/// The APNs status of a dispatch the gateway accepted — what "notified" means.
/// The notifier settles an accepted push with the relay receipt's `apns_status`,
/// which is APNs' own 200 (and 200 again when the relay said yes with a body it
/// could not parse — `momo-notifier` `push_relay::decode_receipt`); the
/// notification diagnostics read the same literal as "sent"
/// (`momo_push::diagnostics`). No shared constant exists for it.
const APNS_ACCEPTED: i32 = 200;

/// The audit action of a message written through this door.
pub const AUDIT_ACTION_PUSH_REPLY: &str = "message.push_reply";

/// The single answer for every message this member has no live notification of.
pub const NOT_NOTIFIED_CODE: &str = "push_reply_unavailable";
const NOT_NOTIFIED_SENTENCE: &str = "there is no notification to reply to";

/// The answer when this notification has already carried its reply.
pub const LIMIT_CODE: &str = "push_reply_limit";

/// The answer when the text is empty or longer than [`PUSH_REPLY_MAX_CHARS`].
pub const TEXT_CODE: &str = "push_reply_text";

/// The closed body. Any other key — `channelId`, `rootId`, `props`,
/// `attachmentIds`, `type`, … — fails the parse and is a 400.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushReplyRequest {
    client_msg_id: Uuid,
    body: String,
}

/// The closed answer: the written message's id and its `seq`, nothing else.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReplyResponse {
    pub id: String,
    pub seq: i64,
}

/// Why the transaction ended without a commit. The refusals must leave through
/// the error channel so that a message already inserted rolls back with them.
enum ReplyFailure {
    Db(DbError),
    Rejected(ApiError),
}

impl From<DbError> for ReplyFailure {
    fn from(error: DbError) -> Self {
        ReplyFailure::Db(error)
    }
}

fn not_notified() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        NOT_NOTIFIED_CODE,
        NOT_NOTIFIED_SENTENCE,
    )
}

/// Shape and length, before any connection is taken.
fn parse_body(bytes: &[u8]) -> Result<PushReplyRequest, ApiError> {
    let request: PushReplyRequest = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("a push reply carries exactly clientMsgId and body"))?;
    if request.body.trim().is_empty() {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            TEXT_CODE,
            "a push reply needs text",
        ));
    }
    if request.body.chars().count() > PUSH_REPLY_MAX_CHARS {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            TEXT_CODE,
            "a push reply is at most 2000 characters",
        ));
    }
    Ok(request)
}

fn parse_canonical(segment: &str) -> Option<Uuid> {
    (segment.len() == 36)
        .then(|| Uuid::parse_str(segment).ok())
        .flatten()
}

pub async fn reply(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    credential: Option<Extension<PushActionCredential>>,
    Path((workspace, message)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    // A7-2 — this door takes the lock screen's token and nothing else.
    if credential.is_none() || principal.kind != PrincipalKind::Human {
        return Err(ApiError::forbidden(
            "this route takes the lock-screen token only",
        ));
    }
    let workspace_id = parse_canonical(&workspace)
        .filter(|id| *id == principal.workspace_id)
        .ok_or_else(|| ApiError::forbidden("workspace scope mismatch"))?;
    let notified_message_id = parse_canonical(&message).ok_or_else(not_notified)?;
    let request = parse_body(&body)?;

    let member_id = principal.member_id;
    let client_msg_id = request.client_msg_id;
    let text = request.body;
    let via_token_id = audit_via_token_id(&principal);
    let gates = DeliverGates::from_state(&state);

    let outcome = momo_db::with_tenant_tx_prelude(
        &state.pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        |_conn| Box::pin(async move { Ok(()) }),
        move |conn| {
            Box::pin(async move {
                // A7-4 — replies to one notification queue here, so the count below
                // and the insert before it are one step per (member, notification).
                // Today the send's `channel_seq` row lock already serializes two
                // writes into one channel; this lock keeps the cap from resting on
                // that detail of the write function. Taken first, and nothing on this
                // path waits for it while holding another lock, so it adds no edge to
                // any lock order.
                sqlx::query(
                    "SELECT pg_advisory_xact_lock(hashtextextended(\
                       'momo.push_reply.cap:' || $1::text || ':' || $2::text, 0))",
                )
                .bind(member_id.to_string())
                .bind(notified_message_id.to_string())
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?;

                // A7-3 2 — one lookup decides all six refusals alike.
                let target: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
                    "SELECT m.channel_id, m.root_id FROM message m \
                      WHERE m.id = $1 AND m.workspace_id = $2 AND m.deleted_at IS NULL \
                        AND EXISTS (SELECT 1 FROM push_dispatch_log l \
                                     WHERE l.workspace_id = $2 AND l.message_id = m.id \
                                       AND l.member_id = $3 AND l.apns_status = $4 \
                                       AND l.created_at > now() - make_interval(hours => $5))",
                )
                .bind(notified_message_id)
                .bind(workspace_id)
                .bind(member_id)
                .bind(APNS_ACCEPTED)
                .bind(PUSH_REPLY_WINDOW_HOURS)
                .fetch_optional(&mut *conn)
                .await
                .map_err(DbError::from)?;
                let Some((channel_id, root_id)) = target else {
                    return Err(ReplyFailure::Rejected(not_notified()));
                };

                let delivery = DeliverRequest {
                    workspace_id,
                    message: NewMessage {
                        channel_id,
                        author_member_id: member_id,
                        message_type: MessageType::Text,
                        body: Some(text),
                        props: Value::Object(Map::new()),
                        root_id,
                        reply_to_id: None,
                        client_msg_id: Some(client_msg_id),
                        run_id: None,
                        hlc_ts: None,
                        hlc_count: None,
                    },
                    requested_run_id: None,
                    signature_b64: None,
                    attachment_ids: Vec::new(),
                    via_token_id,
                    opens_stream: false,
                    author_is_agent: false,
                    author_is_human: true,
                    requested_routing: None,
                    requested_apps: Vec::new(),
                    also_in_channel: false,
                    suppress_unfurl: false,
                    gates,
                };
                // A7-2 — no `sentVia`: the message reads like any other.
                let sent = match deliver_message_via_in_tx(conn, delivery, None).await? {
                    Ok(sent) => sent,
                    Err(DeliverRefusal::NotMember) => {
                        return Err(ReplyFailure::Rejected(ApiError::forbidden(
                            "not a member of this channel",
                        )))
                    }
                    Err(refusal) => return Err(ReplyFailure::Rejected(delivery_refusal(refusal))),
                };
                // A7-3 4 — the same key is the same message, never counted again.
                if sent.deduped {
                    return Ok((sent.message.id, sent.message.seq));
                }
                let used: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM audit_log \
                      WHERE workspace_id = $1 AND actor_member_id = $2 AND action = $3 \
                        AND detail->>'notified_message_id' = $4",
                )
                .bind(workspace_id)
                .bind(member_id)
                .bind(AUDIT_ACTION_PUSH_REPLY)
                .bind(notified_message_id.to_string())
                .fetch_one(&mut *conn)
                .await
                .map_err(DbError::from)?;
                if used >= PUSH_REPLY_PER_NOTIFICATION {
                    return Err(ReplyFailure::Rejected(ApiError::coded(
                        StatusCode::CONFLICT,
                        LIMIT_CODE,
                        "this notification has already been answered",
                    )));
                }
                // A7-2 — ids and the door, never the text.
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_ACTION_PUSH_REPLY)
                        .by(member_id)
                        .about(member_id)
                        .target("message", sent.message.id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.message.push_reply.v1",
                            json!({
                                "via": AUDIT_VIA_PUSH_ACTION,
                                "notified_message_id": notified_message_id.to_string(),
                                "channel_id": channel_id.to_string(),
                            }),
                        ),
                )
                .await?;
                Ok((sent.message.id, sent.message.seq))
            })
        },
    )
    .await;

    match outcome {
        Ok((id, seq)) => Ok((
            StatusCode::CREATED,
            Json(PushReplyResponse {
                id: id.to_string(),
                seq,
            }),
        )
            .into_response()),
        Err(ReplyFailure::Rejected(error)) => Err(error),
        Err(ReplyFailure::Db(error)) => Err(db_error("messages.push_reply", error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_closed_to_two_keys() {
        let key = Uuid::from_u128(7);
        assert!(parse_body(
            json!({"clientMsgId": key, "body": "네"})
                .to_string()
                .as_bytes()
        )
        .is_ok());
        for extra in [
            "channelId",
            "rootId",
            "props",
            "attachmentIds",
            "type",
            "replyToId",
        ] {
            let mut body = json!({"clientMsgId": key, "body": "네"});
            body[extra] = json!("x");
            let error = parse_body(body.to_string().as_bytes()).expect_err(extra);
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{extra}");
        }
        for missing in [json!({"body": "네"}), json!({"clientMsgId": key})] {
            let error = parse_body(missing.to_string().as_bytes()).expect_err("missing key");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn the_text_is_bounded_in_characters_not_bytes() {
        let key = Uuid::from_u128(7);
        // 2,000 three-byte characters pass (6,000 bytes); one more is refused.
        let at_limit = "가".repeat(PUSH_REPLY_MAX_CHARS);
        assert!(parse_body(
            json!({"clientMsgId": key, "body": at_limit})
                .to_string()
                .as_bytes()
        )
        .is_ok());
        let over = "가".repeat(PUSH_REPLY_MAX_CHARS + 1);
        let error = parse_body(
            json!({"clientMsgId": key, "body": over})
                .to_string()
                .as_bytes(),
        )
        .expect_err("over the limit");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        for blank in ["", "   ", "\n"] {
            let error = parse_body(
                json!({"clientMsgId": key, "body": blank})
                    .to_string()
                    .as_bytes(),
            )
            .expect_err("blank");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
        // The byte ceiling holds the longest legal text with room to spare.
        let longest = json!({"clientMsgId": key, "body": "가".repeat(PUSH_REPLY_MAX_CHARS)});
        assert!(longest.to_string().len() < PUSH_REPLY_MAX_BODY_BYTES);
    }
}
