//! Message send + history.
//!
//! Paths are the Swift paths verbatim (`MessageRoutes.swift:25-26`) so no client
//! is rewired:
//!   * `POST /v1/workspaces/{ws}/channels/{ch}/messages`
//!   * `GET  /v1/workspaces/{ws}/channels/{ch}/messages`
//!
//! Wiring invariants this module exists to satisfy:
//!   * **no SQL here.** Every statement comes from `momo-messaging`
//!     (`is_channel_member`, `send_message_with_mentions_in_tx`,
//!     `list_channel_page`); the outbox row is emitted inside that send through
//!     `momo_outbox::emit_outbox`, the workspace's only egress (invariant #3).
//!   * **mentions are the server's decision, in the send transaction** (B1.2,
//!     Swift `MessageRoutes.swift:184-201`). `mention_member_ids` is stripped
//!     from client props below and re-derived from the body by the domain crate,
//!     so a client cannot mint its own badge on someone else — and because the
//!     parse shares the send's commit boundary, a message and the mention it
//!     raised can never disagree.
//!   * **every tenant access goes through `momo_db::with_tenant_tx`** — the sole
//!     RLS GUC seam (invariant #6). The membership check and the write share one
//!     transaction, exactly like Swift's `withTenantTransaction` block.
//!   * **no Centrifugo call.** Publishing is `momo-relay`'s alone (invariant #2);
//!     this crate has no HTTP client at all.
//!   * the workspace scope comes from the *credential*, and the `{ws}` path
//!     parameter must match it (Swift `scopeIDs`, 403 on mismatch).
//!   * **ADR-0146 provenance is optional and never authority.** A send with no
//!     `signature` takes the unchanged path. A send *with* one goes through
//!     `send_signed_message_in_tx`, whose signing key this server resolves —
//!     the request never supplies it. No signature grants any capability; it
//!     only records who asserted the content.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{
    clamp_history_limit, clamp_replies_limit, is_channel_member, list_channel_page,
    list_thread_replies, parse_replies_cursor, resolve_member_signing_key,
    send_message_with_mentions_in_tx, validate_replies_root_in_tx, validate_thread_root_in_tx,
    HistoryCursor, MessageSignature, MessageType, NewMessage, PagedMessage, ProvenanceRejected,
    StoredMessage, ThreadRollup, ThreadRootInvalid,
};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::dto::{
    HistoryQuery, MessageDto, MessagePage, RepliesQuery, SendMessageRequest, ThreadRepliesPage,
    ThreadRollupDto,
};
use crate::error::{db_error, ApiError};
use crate::routes::agent_mentions::{route_agent_mentions_in_tx, MentionSend};
use crate::routes::shared::audit_via_token_id;
use crate::AppState;

/// Server-owned props key: a save-time parsing result that a client may never
/// supply (Swift `encodeProps` strips it before persisting).
const SERVER_OWNED_PROPS_KEY: &str = "mention_member_ids";

/// Resolve `{ws}`/`{ch}` and enforce that the path workspace matches the token's
/// (Swift `MessageRoutes.scopeIDs`, :2824-2839).
fn scope_ids(
    workspace: &str,
    channel: &str,
    principal: &Principal,
) -> Result<(Uuid, Uuid), ApiError> {
    let workspace_id =
        Uuid::parse_str(workspace).map_err(|_| ApiError::bad_request("invalid workspace id"))?;
    let channel_id =
        Uuid::parse_str(channel).map_err(|_| ApiError::bad_request("invalid channel id"))?;
    if workspace_id != principal.workspace_id {
        return Err(ApiError::forbidden("workspace scope mismatch"));
    }
    Ok((workspace_id, channel_id))
}

/// Client props → the stored `props` object, minus the server-owned key.
fn props_value(props: Option<&std::collections::BTreeMap<String, String>>) -> Value {
    let mut object = Map::new();
    if let Some(props) = props {
        for (key, value) in props {
            if key == SERVER_OWNED_PROPS_KEY {
                continue;
            }
            object.insert(key.clone(), Value::String(value.clone()));
        }
    }
    Value::Object(object)
}

/// Omit `props` from a response when it is empty, matching Swift.
fn response_props(props: &Value) -> Option<Value> {
    match props.as_object() {
        Some(object) if !object.is_empty() => Some(Value::Object(object.clone())),
        _ => None,
    }
}

fn thread_dto(rollup: &ThreadRollup) -> ThreadRollupDto {
    ThreadRollupDto {
        reply_count: rollup.reply_count,
        last_reply_seq: rollup.last_reply_seq,
        last_reply_at: rollup.last_reply_at_ms,
    }
}

fn message_dto(
    message: &StoredMessage,
    client_msg_id: Option<Uuid>,
    include_state: bool,
    thread: Option<&ThreadRollup>,
) -> MessageDto {
    MessageDto {
        id: message.id.to_string(),
        channel_id: message.channel_id.to_string(),
        root_id: message.root_id.map(|id| id.to_string()),
        seq: message.seq,
        hlc_ts: message.hlc_ts,
        hlc_count: message.hlc_count,
        author_member_id: message.author_member_id.to_string(),
        message_type: message.message_type.as_db_label().to_string(),
        body: message.body.clone(),
        props: response_props(&message.props),
        client_msg_id: client_msg_id.map(|id| id.to_string()),
        created_at_ms: message.created_at.timestamp_millis(),
        state: include_state.then(|| message.state.clone()),
        thread: thread.map(thread_dto),
    }
}

fn paged_dto(paged: &PagedMessage, include_state: bool) -> MessageDto {
    message_dto(&paged.message, None, include_state, paged.thread.as_ref())
}

/// Reject the request keys this server does not serve. Visible failure beats a
/// silently dropped attachment/run intent (ADR-0134 D1 reasoning).
///
/// The list keeps shrinking, and each departure is a batch: `rootId` left in
/// B4.1 (threads are served), `routing` left in B5.3a (the model/effort tier is
/// served — see [`thread_root_rejection`] for what that did to the probe).
fn reject_unsupported(request: &SendMessageRequest) -> Result<(), ApiError> {
    let unsupported = if request.run_id.is_some() {
        Some("runId (agent-run binding)")
    } else if request
        .attachment_ids
        .as_ref()
        .is_some_and(|ids| !ids.is_empty())
    {
        Some("attachmentIds")
    } else {
        None
    };
    match unsupported {
        Some(field) => Err(ApiError::bad_request(format!(
            "{field} is not served by momo-server yet"
        ))),
        None => Ok(()),
    }
}

/// A bad thread root → its refusal. **`routing` is no longer part of this
/// decision, and that is the point.**
///
/// B4.1 wrote a `thread_root_then_routing` ordering function here and explained
/// that when a batch actually implemented `routing`, "this function is the one
/// place that has to change, and the change will be deleting it". B5.3a is that
/// batch, and this is that deletion.
///
/// ## What the ordering was protecting
///
/// `probeSendRouting` (`clients/web/src/lib/api.ts:2383`) asks whether this
/// server supports per-request model/effort routing by sending a request that
/// **must** fail: a `rootId` that cannot exist *plus* an impossible
/// `routing.effort`. It reads which refusal comes back
/// (`features/routing/capability.ts`, `verdictFromSendProbe`):
///
/// | refusal | verdict | what the composer does |
/// |---|---|---|
/// | 400 naming `routing` | `ready` | opens the model/effort selector |
/// | 404 `thread root not found` | `absent` | no selector, silently |
/// | anything else | `unknown` | selector locked + 「다시 확인」 |
///
/// While this server refused `routing` outright, answering the root first was
/// the only honest ordering: a 400 naming `routing` would have opened a selector
/// whose every send then 400-ed.
///
/// ## Why the answer is now `ready`, without anyone choosing it
///
/// Routing is validated where every shape error belongs — **before the
/// transaction opens** (MOMO-362, and Swift `MessageRoutes.send:42-46` does the
/// same). So the probe's impossible effort token is refused by
/// [`momo_agent::validate_request_routing`] with a sentence naming
/// `routing.effort`, and the root lookup below never runs. The probe reads
/// `ready`, the selector opens, and a send made through it works — which is why
/// there is no ordering left to encode here: the verdict is now a consequence of
/// where validation runs, not of a hand-written sequence.
fn thread_root_rejection(invalid: ThreadRootInvalid) -> ApiError {
    match invalid {
        ThreadRootInvalid::NotFound => ApiError::not_found(invalid.to_string()),
        ThreadRootInvalid::Deleted | ThreadRootInvalid::NotTopLevel => {
            ApiError::bad_request(invalid.to_string())
        }
    }
}

/// Why a send failed *inside* the transaction.
///
/// `with_tenant_tx` commits on `Ok` and rolls back on `Err`, so a caller-fault
/// rejection has to be an `Err` — otherwise refusing a signature would still
/// commit the message it refused. `momo_db::with_tenant_tx_prelude` is generic
/// over the error type for exactly this reason.
#[derive(Debug)]
enum SendFailure {
    Db(DbError),
    /// A rejection with its final client response already decided.
    Rejected(ApiError),
}

impl From<DbError> for SendFailure {
    fn from(error: DbError) -> Self {
        SendFailure::Db(error)
    }
}

/// `with_tenant_tx` with [`SendFailure`] as the error type — the same no-op
/// prelude shape `routes::shared::tenant_tx` uses for T3, spelled for this
/// domain instead of borrowing T3's error type.
async fn tenant_tx_or_reject<T, F>(
    pool: &momo_db::PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, SendFailure>
where
    T: Send,
    F: for<'c> FnOnce(
            &'c mut momo_db::PgConnection,
        )
            -> crate::routes::shared::futures_box::BoxFuture<'c, Result<T, SendFailure>>
        + Send,
{
    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        |_conn| Box::pin(async move { Ok(()) }),
        body,
    )
    .await
}

/// The refusal when a member sent a signature but has no registered signing key.
///
/// 501, not 400: the request is well-formed and the caller did nothing wrong —
/// this server simply has no member key registry yet (see
/// `momo_messaging::resolve_member_signing_key`, and the ADR-0146 fast-follow).
/// Answering 400 would blame the client for a gap that is ours.
fn no_signing_key() -> ApiError {
    ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "message signing requires a registered member signing key, which momo-server \
         does not serve yet",
    )
}

/// A refused provenance assertion → the client-facing sentence.
///
/// All three are 400: the signature, the missing `clientMsgId` and the wrong
/// signer are each something the caller can fix. The message is the rejection's
/// own `Display`, so the vocabulary lives in one place
/// (`momo_messaging::ProvenanceRejected`).
fn rejected_signature(rejected: ProvenanceRejected) -> ApiError {
    ApiError::bad_request(rejected.to_string())
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/messages` — the single write path.
pub async fn send(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;
    reject_unsupported(&request)?;

    let message_type = match request.message_type.as_deref() {
        None => MessageType::Text,
        Some(label) => MessageType::from_db_label(label)
            .ok_or_else(|| ApiError::bad_request("unsupported message type"))?,
    };

    let client_msg_id = request.client_msg_id;
    let root_id = request.root_id;
    // B5.3a / ADR-0134 D1 — shape only, and deliberately here: a malformed
    // `routing` block becomes a 4xx before any connection is taken (MOMO-362),
    // which is also what makes the web capability probe read `ready` (see
    // `thread_root_rejection`). The gates that need tenant rows — the workspace
    // allow-list and the model×effort table — run per mentioned agent inside the
    // transaction, because only there is it known which agent is being routed.
    let requested_routing = momo_agent::validate_request_routing(request.routing.as_ref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    // B5.2 — the mention routing's inputs, resolved before the closure takes
    // ownership of the request. `body` is cloned rather than borrowed because
    // `new_message` consumes the original and the routing needs the same text.
    let mention_body = request.body.clone().unwrap_or_default();
    let author_is_agent = principal.kind == momo_auth::PrincipalKind::Agent;
    let via_token_id = audit_via_token_id(&principal);
    let gateway_enabled = state.agent_gateway.enabled();
    let context_max_messages = state.mentions.context_max_messages;
    let new_message = NewMessage {
        channel_id,
        author_member_id: principal.member_id,
        message_type,
        body: request.body.clone(),
        props: props_value(request.props.as_ref()),
        root_id,
        reply_to_id: None,
        client_msg_id: Some(client_msg_id),
        run_id: None,
        hlc_ts: None,
        hlc_count: None,
    };

    let provenance_signature = request.signature.clone();

    // Membership check + write in ONE tenant transaction (Swift parity): a
    // caller who leaves the channel mid-flight cannot slip a message in. A
    // provenance rejection leaves through the transaction's ERROR channel
    // ([`SendFailure`]) precisely so the message rolls back with it — returned as
    // a value it would commit, and a signed send would silently degrade into an
    // unsigned one.
    let sent = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_channel_member(conn, channel_id, principal.member_id).await? {
                return Ok(None);
            }
            // The reply target has to exist before the message can be written
            // against it. The refusal leaves through the ERROR channel so the
            // read-only transaction rolls back with it.
            if let Some(root_id) = root_id {
                if let Err(invalid) = validate_thread_root_in_tx(conn, channel_id, root_id).await? {
                    return Err(SendFailure::Rejected(thread_root_rejection(invalid)));
                }
            }
            let signature = match provenance_signature {
                None => None,
                Some(signature_b64) => {
                    // The key is the server's to resolve, never the request's to
                    // assert.
                    let Some(signer_pubkey_b64) =
                        resolve_member_signing_key(conn, principal.member_id).await?
                    else {
                        return Err(SendFailure::Rejected(no_signing_key()));
                    };
                    Some(MessageSignature {
                        signer_member_id: principal.member_id,
                        signer_pubkey_b64,
                        signature_b64,
                    })
                }
            };
            let sent = match send_message_with_mentions_in_tx(
                conn,
                workspace_id,
                new_message,
                signature.as_ref(),
            )
            .await?
            {
                Ok(sent) => sent,
                Err(rejected) => return Err(SendFailure::Rejected(rejected_signature(rejected))),
            };

            // B5.2 — mention → agent run, in THIS transaction and only on a real
            // insert. Swift's guard is the same three conditions
            // (`MessageRoutes.swift:284`, `if didInsert, type == "text", let body`)
            // and each one earns its place: a deduped retry must not queue a
            // second turn, a non-text message has no `@handle` to parse, and an
            // empty body cannot mention anyone. The run is enqueued after the
            // broadcast so `props.mention_member_ids` — the human-facing half of
            // the same decision — is already on the row it describes.
            if !sent.deduped && message_type == MessageType::Text && !mention_body.is_empty() {
                // A refused `routing` block rolls the send back with it (Swift
                // :1976-1981): the caller chose a model this workspace does not
                // permit, and delivering the message under a different one would
                // substitute the single decision they made explicitly.
                if let Err(rejection) = route_agent_mentions_in_tx(
                    conn,
                    MentionSend {
                        workspace_id,
                        channel_id,
                        message_id: sent.message.id,
                        message_seq: sent.message.seq,
                        author_member_id: principal.member_id,
                        author_is_agent,
                        body: &mention_body,
                        hlc_ts: sent.message.hlc_ts,
                        via_token_id,
                        gateway_enabled,
                        context_max_messages,
                        routing: requested_routing.as_ref(),
                    },
                )
                .await?
                {
                    return Err(SendFailure::Rejected(rejection));
                }
            }
            Ok(Some(sent))
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.send", error),
    })?;

    let sent = sent.ok_or_else(|| ApiError::forbidden("not a member of this channel"))?;

    // 201 in both the insert and the idempotent-retry case (openapi sendMessage).
    Ok((
        StatusCode::CREATED,
        Json(message_dto(
            &sent.message,
            Some(client_msg_id),
            false,
            sent.thread.as_ref(),
        )),
    ))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies` — one
/// oldest-first page of a thread (Swift `MessageRoutes.replies`, :520-624).
///
/// Ascending, unlike history: a thread is read from its start, because its first
/// reply is what gives the rest their context. The membership gate is the same
/// one the channel's history uses — a thread is not a second access boundary,
/// and treating it as one would eventually let the two disagree.
pub async fn replies(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, root)): Path<(String, String, String)>,
    Query(query): Query<RepliesQuery>,
) -> Result<Json<ThreadRepliesPage>, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;
    let root_id =
        Uuid::parse_str(&root).map_err(|_| ApiError::bad_request("invalid thread root id"))?;
    let limit = clamp_replies_limit(query.limit.as_deref().and_then(|raw| raw.parse().ok()));
    let cursor = parse_replies_cursor(query.cursor.as_deref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;

    // Guard and read share one transaction, so a caller removed from the
    // channel mid-flight cannot still receive the page their check passed for.
    let page = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_channel_member(conn, channel_id, principal.member_id).await? {
                return Err(SendFailure::Rejected(ApiError::forbidden(
                    "not a member of this channel",
                )));
            }
            if let Err(invalid) = validate_replies_root_in_tx(conn, channel_id, root_id).await? {
                return Err(SendFailure::Rejected(match invalid {
                    ThreadRootInvalid::NotFound => ApiError::not_found(invalid.to_string()),
                    other => ApiError::bad_request(other.to_string()),
                }));
            }
            Ok(list_thread_replies(conn, channel_id, root_id, cursor, limit).await?)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.replies", error),
    })?;

    Ok(Json(ThreadRepliesPage {
        messages: page
            .messages
            .iter()
            .map(|paged| paged_dto(paged, true))
            .collect(),
        next_cursor: page.next_cursor,
    }))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/messages` — seq-cursor history.
pub async fn history(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<MessagePage>, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;
    let limit = clamp_history_limit(query.limit());
    let cursor = HistoryCursor::from_query(query.before(), query.after());

    let page = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !is_channel_member(conn, channel_id, principal.member_id).await? {
                return Ok(None);
            }
            let messages = list_channel_page(conn, channel_id, cursor, limit).await?;
            Ok::<_, DbError>(Some(messages))
        })
    })
    .await
    .map_err(|error| db_error("messages.history", error))?;

    let messages = page.ok_or_else(|| ApiError::forbidden("not a member of this channel"))?;
    // nextBefore = the smallest seq on this page (Swift `dtos.map(\.seq).min()`).
    let next_before = messages.iter().map(|paged| paged.message.seq).min();

    Ok(Json(MessagePage {
        messages: messages
            .iter()
            .map(|paged| paged_dto(paged, true))
            .collect(),
        next_before,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_auth::PrincipalKind;
    use std::collections::BTreeMap;

    fn principal(workspace_id: Uuid) -> Principal {
        Principal {
            member_id: Uuid::from_u128(7),
            workspace_id,
            token_id: None,
            scopes: vec![],
            kind: PrincipalKind::Human,
        }
    }

    /// A signature is never accepted alongside a caller-supplied key, and the
    /// absence of a registry is *our* gap, so it answers 501 rather than
    /// blaming the caller with a 400.
    #[test]
    fn a_signature_without_a_registered_key_is_501_not_400() {
        let error = no_signing_key();
        assert_eq!(error.status, StatusCode::NOT_IMPLEMENTED);
        assert!(
            error.message.contains("registered member signing key"),
            "the sentence must name the missing surface: {}",
            error.message
        );
    }

    /// Each rejection keeps its own sentence — a caller must be able to tell
    /// "your signature is wrong" from "you signed for someone else".
    #[test]
    fn every_provenance_rejection_is_a_400_with_its_own_sentence() {
        let sentences: Vec<String> = [
            ProvenanceRejected::SignatureRejected,
            ProvenanceRejected::MissingClientMsgId,
            ProvenanceRejected::SignerIsNotAuthor,
        ]
        .into_iter()
        .map(|rejected| {
            let error = rejected_signature(rejected);
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            error.message
        })
        .collect();
        let mut unique = sentences.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            sentences.len(),
            "{sentences:?} must all differ"
        );
    }

    #[test]
    fn scope_ids_rejects_a_foreign_workspace_path() {
        let token_workspace = Uuid::from_u128(1);
        let other_workspace = Uuid::from_u128(2);
        let channel = Uuid::from_u128(3);
        let error = scope_ids(
            &other_workspace.to_string(),
            &channel.to_string(),
            &principal(token_workspace),
        )
        .expect_err("path workspace must match the credential");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, "workspace scope mismatch");
    }

    #[test]
    fn scope_ids_accepts_the_credential_workspace() {
        let workspace = Uuid::from_u128(1);
        let channel = Uuid::from_u128(3);
        let (resolved_workspace, resolved_channel) = scope_ids(
            &workspace.to_string(),
            &channel.to_string(),
            &principal(workspace),
        )
        .expect("matching scope");
        assert_eq!(resolved_workspace, workspace);
        assert_eq!(resolved_channel, channel);
    }

    #[test]
    fn scope_ids_rejects_malformed_ids() {
        let workspace = Uuid::from_u128(1);
        assert_eq!(
            scope_ids(
                "not-a-uuid",
                &Uuid::nil().to_string(),
                &principal(workspace)
            )
            .expect_err("bad workspace")
            .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            scope_ids(&workspace.to_string(), "not-a-uuid", &principal(workspace))
                .expect_err("bad channel")
                .status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn client_props_cannot_forge_the_server_owned_key() {
        let mut props = BTreeMap::new();
        props.insert("k".to_string(), "v".to_string());
        props.insert(SERVER_OWNED_PROPS_KEY.to_string(), "spoofed".to_string());
        let value = props_value(Some(&props));
        assert_eq!(value["k"], Value::String("v".into()));
        assert!(
            value.get(SERVER_OWNED_PROPS_KEY).is_none(),
            "mention_member_ids is server-owned and must be stripped"
        );
    }

    #[test]
    fn empty_props_are_omitted_from_responses() {
        assert!(response_props(&Value::Object(Map::new())).is_none());
        assert!(response_props(&serde_json::json!({"k": "v"})).is_some());
    }

    #[test]
    fn unsupported_send_fields_fail_visibly() {
        let base = || SendMessageRequest {
            client_msg_id: Uuid::nil(),
            root_id: None,
            message_type: None,
            body: None,
            props: None,
            run_id: None,
            attachment_ids: None,
            routing: None,
            signature: None,
        };
        assert!(reject_unsupported(&base()).is_ok());

        // B4.1: threads are served, so a rootId is no longer refused here.
        let mut threaded = base();
        threaded.root_id = Some(Uuid::nil());
        assert!(
            reject_unsupported(&threaded).is_ok(),
            "rootId is served now; its validation happens against the DB"
        );

        let mut with_run = base();
        with_run.run_id = Some(Uuid::nil());
        assert_eq!(
            reject_unsupported(&with_run).expect_err("runId").status,
            StatusCode::BAD_REQUEST
        );

        let mut with_attachments = base();
        with_attachments.attachment_ids = Some(vec![Uuid::nil()]);
        assert!(reject_unsupported(&with_attachments).is_err());

        // An empty array carries no intent → not an error.
        let mut empty_attachments = base();
        empty_attachments.attachment_ids = Some(vec![]);
        assert!(reject_unsupported(&empty_attachments).is_ok());

        // B5.3a: routing is served, so it is not on this list either. Its
        // validation is the shape check below, not a refusal.
        let mut with_routing = base();
        with_routing.routing = Some(serde_json::json!({"model": "x"}));
        assert!(reject_unsupported(&with_routing).is_ok());
    }

    /// **The probe contract, now answered the other way — truthfully.**
    ///
    /// `probeSendRouting` sends an impossible `rootId` AND an impossible
    /// `routing.effort` at once and reads which refusal comes back. While
    /// `routing` was unserved, B4.1 had to answer the root first so the probe
    /// read `absent`; a 400 naming `routing` would have opened a selector whose
    /// every send then failed.
    ///
    /// B5.3a serves routing, so the honest verdict is `ready` — and it arrives
    /// without an ordering rule, because the shape check runs before the
    /// transaction the root lookup lives in. This test pins the two halves that
    /// make that true: the routing refusal is a 400 that **names** routing, and
    /// the root refusal is a 404 that does **not**.
    #[test]
    fn the_probe_now_reads_ready_because_routing_is_validated_first() {
        let probe = momo_agent::validate_request_routing(Some(&serde_json::json!({
            "effort": "__momo-capability-probe__"
        })))
        .expect_err("the probe token is not a level this server accepts");
        let rejection = ApiError::bad_request(probe.to_string());
        assert_eq!(
            rejection.status,
            StatusCode::BAD_REQUEST,
            "verdictFromSendProbe reads 400 + /routing/i as `ready`"
        );
        assert!(
            rejection.message.to_lowercase().contains("routing"),
            "a 400 that stopped naming routing would read as `unknown` and lock \
             the selector: {}",
            rejection.message
        );

        // …and the root's own refusal still must not match /routing/i, or a
        // genuinely absent thread root would be read as a routing verdict.
        let root = thread_root_rejection(ThreadRootInvalid::NotFound);
        assert_eq!(root.status, StatusCode::NOT_FOUND);
        assert_eq!(root.message, "thread root not found");
        assert!(!root.message.to_lowercase().contains("routing"));
    }

    /// A well-shaped routing block is not refused at all — the composer's normal
    /// send has to survive the same path the probe exercises.
    #[test]
    fn a_well_shaped_routing_block_passes_the_pre_transaction_gate() {
        let requested = momo_agent::validate_request_routing(Some(&serde_json::json!({
            "model": "hermes-fast", "effort": "low"
        })))
        .expect("a valid block")
        .expect("present");
        assert_eq!(requested.model.as_deref(), Some("hermes-fast"));
        assert_eq!(requested.effort.as_deref(), Some("low"));
        assert_eq!(
            momo_agent::validate_request_routing(None).expect("absent"),
            None,
            "an ordinary send carries no routing and is unaffected"
        );
    }

    #[test]
    fn a_bad_root_that_is_not_missing_is_a_400_with_its_own_sentence() {
        for (invalid, expected) in [
            (ThreadRootInvalid::Deleted, "thread root is deleted"),
            (
                ThreadRootInvalid::NotTopLevel,
                "thread root must be a top-level message",
            ),
        ] {
            let rejection = thread_root_rejection(invalid);
            assert_eq!(rejection.status, StatusCode::BAD_REQUEST);
            assert_eq!(rejection.message, expected);
        }
    }

    /// The rollup crosses the wire in snake_case inside an otherwise camelCase
    /// body. `threadRollup()` (`lib/api.ts:188-196`) reads `reply_count`
    /// literally and returns `null` when it is missing — a camelCase rename here
    /// would silently unrender every thread badge.
    #[test]
    fn the_thread_rollup_keeps_its_snake_case_keys() {
        let message = StoredMessage {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            seq: 4,
            hlc_ts: 1_700_000_000_000,
            hlc_count: 0,
            author_member_id: Uuid::from_u128(5),
            message_type: MessageType::Text,
            state: "sent".into(),
            body: Some("root".into()),
            props: Value::Object(Map::new()),
            root_id: None,
            created_at: chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
                .expect("timestamp"),
        };
        let rollup = ThreadRollup {
            reply_count: 3,
            last_reply_seq: 9,
            last_reply_at_ms: 1_700_000_000_500,
        };
        let json = serde_json::to_value(message_dto(&message, None, true, Some(&rollup)))
            .expect("serialize");
        assert_eq!(json["thread"]["reply_count"], serde_json::json!(3));
        assert_eq!(json["thread"]["last_reply_seq"], serde_json::json!(9));
        assert_eq!(
            json["thread"]["last_reply_at"],
            serde_json::json!(1_700_000_000_500_i64),
            "Swift names the millisecond value `last_reply_at`, not `…AtMs`"
        );
        assert!(json.get("rootId").is_none(), "a root has no rootId: {json}");

        // A message with no replies carries no rollup at all — the badge's
        // absence is what "no thread here" looks like.
        let bare =
            serde_json::to_value(message_dto(&message, None, true, None)).expect("serialize");
        assert!(bare.get("thread").is_none(), "{bare}");
    }
}
