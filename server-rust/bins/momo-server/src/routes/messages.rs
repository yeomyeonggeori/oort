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
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{
    channel_pins, channel_reaction_snapshot, clamp_history_limit, clamp_replies_limit,
    delete_message_in_tx, edit_message_in_tx, is_channel_member, list_channel_page,
    list_thread_replies, parse_replies_cursor, resolve_member_signing_key,
    send_message_with_mentions_in_tx, set_pin_in_tx, set_reaction_in_tx,
    validate_quote_target_in_tx, validate_reaction_emoji, validate_replies_root_in_tx,
    validate_thread_root_in_tx, AttachmentLinkRejected, HistoryCursor, InteractionRefused,
    MessageAttachment, MessageSignature, MessageType, NewMessage, PagedMessage, PinAction,
    PinnedMessage, ProvenanceRejected, QuoteTargetInvalid, QuotedMessage, ReactionAction,
    ReactionSnapshot, SendExtras, SendRejected, StoredMessage, ThreadRollup, ThreadRootInvalid,
};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::dto::{
    EditMessageRequest, HistoryQuery, MessageDto, MessagePage, PinDeltaDto, PinListDto,
    PinnedMessageDto, QuotedMessageDto, ReactionDeltaDto, RepliesQuery, SendMessageRequest,
    ThreadRepliesPage, ThreadRollupDto,
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

fn quoted_dto(quoted: &QuotedMessage) -> QuotedMessageDto {
    QuotedMessageDto {
        id: quoted.id.to_string(),
        seq: quoted.seq,
        author_member_id: quoted.author_member_id.to_string(),
        message_type: quoted.message_type.as_db_label().to_string(),
        // Deliberately no "삭제됨" substitution here: a tombstone's body is
        // already NULL in the row, and inventing placeholder text server-side
        // would be a copy of nothing that clients then have to distinguish from
        // a real message reading "삭제됨".
        body: quoted.body.clone(),
        state: quoted.state.clone(),
        edited_at_ms: quoted.edited_at.map(|at| at.timestamp_millis()),
        deleted_at_ms: quoted.deleted_at.map(|at| at.timestamp_millis()),
        quotes_another: quoted.quotes_another,
    }
}

fn message_dto(
    message: &StoredMessage,
    client_msg_id: Option<Uuid>,
    include_state: bool,
    thread: Option<&ThreadRollup>,
    reply_to: Option<&QuotedMessage>,
    attachments: &[MessageAttachment],
) -> MessageDto {
    MessageDto {
        id: message.id.to_string(),
        channel_id: message.channel_id.to_string(),
        root_id: message.root_id.map(|id| id.to_string()),
        reply_to_id: message.reply_to_id.map(|id| id.to_string()),
        reply_to: reply_to.map(quoted_dto),
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
        // B11 — always projected, on send and history alike. Swift carries both
        // on every row it returns (`MessageRoutes.swift:391-393`), and a client
        // that only learns about an edit from the realtime event has no way to
        // draw "수정됨" after a reload.
        edited_at_ms: message.edited_at.map(|at| at.timestamp_millis()),
        deleted_at_ms: message.deleted_at.map(|at| at.timestamp_millis()),
        // ADR-0151 — carried on every projection, send echo included, exactly
        // like Swift. A client that only learned about attachments from the
        // realtime frame would draw a file-less message after any reload.
        attachments: attachments.to_vec(),
        thread: thread.map(thread_dto),
    }
}

fn paged_dto(paged: &PagedMessage, include_state: bool) -> MessageDto {
    message_dto(
        &paged.message,
        None,
        include_state,
        paged.thread.as_ref(),
        paged.reply_to.as_ref(),
        &paged.attachments,
    )
}

/// Reject the request keys this server does not serve. Visible failure beats a
/// silently dropped attachment/run intent (ADR-0134 D1 reasoning).
///
/// The list keeps shrinking, and each departure is a batch: `rootId` left in
/// B4.1 (threads are served), `routing` left in B5.3a (the model/effort tier is
/// served — see [`thread_root_rejection`] for what that did to the probe), and
/// `attachmentIds` left in ADR-0151 (the three Drive routes are served, and the
/// binding runs inside this send's own transaction).
///
/// `runId` is the last one standing.
fn reject_unsupported(request: &SendMessageRequest) -> Result<(), ApiError> {
    let unsupported = if request.run_id.is_some() {
        Some("runId (agent-run binding)")
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

/// A refused attachment binding → its status (Swift `linkAttachments`' throws,
/// `MessageRoutes.swift:1326-1364`).
///
/// The two 403s stay apart on purpose: "another uploader" and "another channel"
/// are different mistakes, and collapsing them would leave a client unable to
/// tell a permissions problem from a stale composer.
///
/// **404 for an unknown id, not 403**, and that is a disclosure choice: an
/// attachment in another tenant is invisible under RLS and lands in the same
/// branch, so a more specific answer would confirm the existence of rows the
/// caller may not see.
fn attachment_link_rejection(rejected: AttachmentLinkRejected) -> ApiError {
    let message = rejected.to_string();
    match rejected {
        AttachmentLinkRejected::Duplicate | AttachmentLinkRejected::TooMany => {
            ApiError::bad_request(message)
        }
        AttachmentLinkRejected::NotFound => ApiError::not_found(message),
        AttachmentLinkRejected::NotComplete | AttachmentLinkRejected::AlreadyLinked => {
            ApiError::new(StatusCode::CONFLICT, message)
        }
        AttachmentLinkRejected::ForeignUploader | AttachmentLinkRejected::ForeignChannel => {
            ApiError::forbidden(message)
        }
    }
}

/// A refused send → its response, whichever half refused it. One function so a
/// new rejection variant cannot be added without a status being chosen for it.
fn send_rejection(rejected: SendRejected) -> ApiError {
    match rejected {
        SendRejected::Provenance(provenance) => rejected_signature(provenance),
        SendRejected::Attachment(attachment) => attachment_link_rejection(attachment),
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

/// A bad quote target → its refusal (ADR-0148 규칙 2).
///
/// Same status split as [`thread_root_rejection`], for the same two reasons: a
/// target that is not in this channel is 404 because saying anything else would
/// answer "does message X exist somewhere in this workspace" to anyone who can
/// post, and a tombstone is 400 because the caller can see it and just needs to
/// be told no.
///
/// Neither sentence contains the substring `routing`, which is not a
/// coincidence — see [`thread_root_rejection`] for the send probe that reads
/// refusals by shape.
fn quote_target_rejection(invalid: QuoteTargetInvalid) -> ApiError {
    match invalid {
        QuoteTargetInvalid::NotFound => ApiError::not_found(invalid.to_string()),
        QuoteTargetInvalid::Deleted => ApiError::bad_request(invalid.to_string()),
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
    let reply_to_id = request.reply_to_id;
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
        reply_to_id,
        client_msg_id: Some(client_msg_id),
        run_id: None,
        hlc_ts: None,
        hlc_count: None,
    };

    let provenance_signature = request.signature.clone();
    // ADR-0151: an absent key and an empty array are the same request — no
    // binding, no lock, no query. Only a non-empty list changes what the send
    // does.
    let attachment_ids = request.attachment_ids.clone().unwrap_or_default();

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
            // ADR-0148 규칙 2 — the quote target must live in THIS channel, and
            // the check runs inside the tenant transaction because that is what
            // makes it a tenant check too: a target in another workspace is
            // invisible under RLS here, so it resolves as missing rather than as
            // a message someone can confirm the existence of. Checked
            // independently of `root_id` — 규칙 1 lets a message carry both, so
            // an `else` here would silently skip the check for every threaded
            // quote.
            if let Some(reply_to_id) = reply_to_id {
                if let Err(invalid) =
                    validate_quote_target_in_tx(conn, channel_id, reply_to_id).await?
                {
                    return Err(SendFailure::Rejected(quote_target_rejection(invalid)));
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
                SendExtras {
                    signature: signature.as_ref(),
                    attachment_ids: &attachment_ids,
                    via_token_id,
                },
            )
            .await?
            {
                Ok(sent) => sent,
                Err(rejected) => return Err(SendFailure::Rejected(send_rejection(rejected))),
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
            // The echo carries `replyToId` and no rendered quote: the sender
            // picked the target and still has it on screen. See `MessageDto`.
            None,
            // Attachments, unlike the quote, ARE echoed: the composer holds
            // ids, and the names/sizes it needs to draw a file card come from
            // the rows this transaction just bound.
            &sent.attachments,
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

// ---------------------------------------------------------------------------
// B11 — message interactions (edit / delete / react), Swift `MessageRoutes`
// :626-936. The SQL and the guard order live in `momo_messaging::interaction`;
// what is left here is exactly three things: parameter parsing, the
// refusal → status-code mapping, and the audit row.
// ---------------------------------------------------------------------------

/// Resolve `{ws}`/`{id}` for a message-scoped route (Swift `messageScopeIDs`,
/// :1277-1293). Same credential-over-path rule as [`scope_ids`]: the workspace in
/// the URL is only ever a cross-check against the token's.
fn message_scope_ids(
    workspace: &str,
    message: &str,
    principal: &Principal,
) -> Result<(Uuid, Uuid), ApiError> {
    let workspace_id =
        Uuid::parse_str(workspace).map_err(|_| ApiError::bad_request("invalid workspace id"))?;
    if workspace_id != principal.workspace_id {
        return Err(ApiError::forbidden("workspace scope mismatch"));
    }
    let message_id =
        Uuid::parse_str(message).map_err(|_| ApiError::bad_request("invalid message id"))?;
    Ok((workspace_id, message_id))
}

/// A domain refusal → its HTTP answer, with Swift's status for each.
///
/// **404 outranks 403 only for a message that does not exist**; every other
/// refusal is 403/400/409 in Swift's own order. Note the two authorship
/// refusals are 403 and not 404: the caller can already read the message (the
/// membership gate passed), so hiding its existence would protect nothing while
/// making "you may not edit this" indistinguishable from a typo'd id.
fn interaction_refusal(refused: InteractionRefused) -> ApiError {
    let status = match refused {
        InteractionRefused::NotFound => StatusCode::NOT_FOUND,
        InteractionRefused::NotAMember
        | InteractionRefused::NotAuthorForEdit
        | InteractionRefused::NotAuthorForDelete => StatusCode::FORBIDDEN,
        InteractionRefused::EditDeleted
        | InteractionRefused::ReactDeleted
        | InteractionRefused::PinDeleted
        | InteractionRefused::EmptyBody => StatusCode::BAD_REQUEST,
        InteractionRefused::ReactionLimit | InteractionRefused::PinLimit => StatusCode::CONFLICT,
    };
    ApiError::new(status, refused.to_string())
}

/// The audit row every *effective* interaction writes, in the interaction's own
/// transaction (Swift `recordInteraction`, :1241-1275).
///
/// `by(...).about_optional(None)` because Swift sets `actor_member_id` and
/// leaves `subject_member_id` NULL: the subject of "I edited my message" is the
/// message, already named by `target`, not a second member.
async fn record_interaction_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    action: &str,
) -> Result<(), DbError> {
    let entry = AuditEntry::new(workspace_id, action)
        .by(actor_member_id)
        .about_optional(None)
        .target("message", message_id)
        .via_token(via_token_id)
        .with_schema(
            "momo.message_interaction.v1",
            serde_json::json!({
                "channel_id": channel_id,
                "event_type": action,
            }),
        );
    write_audit(conn, &entry).await?;
    Ok(())
}

/// `PATCH /v1/workspaces/{ws}/messages/{id}` — rewrite one's own message.
///
/// 200 with the updated message (Swift returns the `MessageDTO` through
/// `response(from:context:)`, whose default status is `.ok` — unlike `send`,
/// which is a 201 because it creates).
pub async fn edit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
    Json(request): Json<EditMessageRequest>,
) -> Result<Json<MessageDto>, ApiError> {
    let (workspace_id, message_id) = message_scope_ids(&workspace, &message, &principal)?;
    let via_token_id = audit_via_token_id(&principal);

    let edited = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let projection = match edit_message_in_tx(
                conn,
                workspace_id,
                message_id,
                principal.member_id,
                &request.body,
            )
            .await?
            {
                Ok(projection) => projection,
                // A refusal has to leave through the ERROR channel or the
                // transaction commits: `with_tenant_tx` commits on `Ok`, and an
                // edit refused as a value would still have taken its locks.
                Err(refused) => return Err(SendFailure::Rejected(interaction_refusal(refused))),
            };
            record_interaction_audit(
                conn,
                workspace_id,
                projection.message.channel_id,
                message_id,
                principal.member_id,
                via_token_id,
                "message.edited",
            )
            .await?;
            Ok(projection)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.edit", error),
    })?;

    Ok(Json(message_dto(
        &edited.message,
        edited.client_msg_id,
        true,
        None,
        // An edit re-projects the row, not the conversation around it: the
        // quote id rides along, the rendered quote comes from the next read.
        None,
        // Neither does it re-project the attachments — Swift's edit response
        // omits them too. Editing a body cannot change what is bound to the
        // message, so the client keeps the file cards it already drew.
        &[],
    )))
}

/// `DELETE /v1/workspaces/{ws}/messages/{id}` — soft delete one's own message.
///
/// 200 with the **tombstone**, not 204: the client needs the row back so it can
/// replace the message in place rather than remove it and leave what looks like
/// a gap in `seq`.
pub async fn delete_message(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
) -> Result<Json<MessageDto>, ApiError> {
    let (workspace_id, message_id) = message_scope_ids(&workspace, &message, &principal)?;
    let via_token_id = audit_via_token_id(&principal);

    let deleted = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let deleted =
                match delete_message_in_tx(conn, workspace_id, message_id, principal.member_id)
                    .await?
                {
                    Ok(deleted) => deleted,
                    Err(refused) => {
                        return Err(SendFailure::Rejected(interaction_refusal(refused)))
                    }
                };
            // Deleting an already-deleted message is a success that records
            // nothing (Swift :730-734): a second audit row would claim a
            // deletion that did not happen, and a second broadcast would tell
            // every client something it already applied.
            if !deleted.already_deleted {
                record_interaction_audit(
                    conn,
                    workspace_id,
                    deleted.message.message.channel_id,
                    message_id,
                    principal.member_id,
                    via_token_id,
                    "message.deleted",
                )
                .await?;
            }
            Ok(deleted)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.delete", error),
    })?;

    Ok(Json(message_dto(
        &deleted.message.message,
        deleted.message.client_msg_id,
        true,
        None,
        None,
        // A tombstone names no files. The rows survive with their `message_id`
        // intact — the deletion is of the message, and reaping the archive is
        // the janitor's decision, not this route's — but nothing that describes
        // a deleted message should hand a client something to draw.
        &[],
    )))
}

/// `PUT …/messages/{id}/reactions/{emoji}`.
pub async fn add_reaction(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String, String)>,
) -> Result<Json<ReactionDeltaDto>, ApiError> {
    mutate_reaction(state, principal, path, ReactionAction::Added).await
}

/// `DELETE …/messages/{id}/reactions/{emoji}`.
pub async fn remove_reaction(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String, String)>,
) -> Result<Json<ReactionDeltaDto>, ApiError> {
    mutate_reaction(state, principal, path, ReactionAction::Removed).await
}

/// The body both reaction verbs share (Swift `mutateReaction`, :800-899).
///
/// One function because the two differ in a single boolean, and splitting them
/// would double the guard order — the thing most worth keeping identical.
async fn mutate_reaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message, emoji)): Path<(String, String, String)>,
    action: ReactionAction,
) -> Result<Json<ReactionDeltaDto>, ApiError> {
    let (workspace_id, message_id) = message_scope_ids(&workspace, &message, &principal)?;
    // Axum has already percent-decoded the segment, which is Swift's
    // `removingPercentEncoding`. Validation is the domain's so the bound and the
    // wording cannot drift between here and a future non-HTTP caller.
    let emoji = validate_reaction_emoji(&emoji)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?
        .to_string();
    let via_token_id = audit_via_token_id(&principal);

    let delta = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let delta = match set_reaction_in_tx(
                conn,
                workspace_id,
                message_id,
                principal.member_id,
                &emoji,
                action,
            )
            .await?
            {
                Ok(delta) => delta,
                Err(refused) => return Err(SendFailure::Rejected(interaction_refusal(refused))),
            };
            // A no-op toggle answers 200 and writes nothing — the reaction is
            // already in the state the caller asked for, so there is nothing to
            // record and nothing to publish. That is what makes a
            // double-tapped emoji harmless instead of a 500.
            if delta.changed {
                record_interaction_audit(
                    conn,
                    workspace_id,
                    delta.channel_id,
                    message_id,
                    principal.member_id,
                    via_token_id,
                    &format!("reaction.{}", delta.action.as_wire_label()),
                )
                .await?;
            }
            Ok(delta)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.reaction", error),
    })?;

    Ok(Json(ReactionDeltaDto {
        action: delta.action.as_wire_label().to_string(),
        message_id: delta.message_id_wire(),
        member_id: delta.member_id_wire(),
        emoji: delta.emoji,
    }))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/reactions` — the channel's whole
/// reaction map, for a cold load.
///
/// Encoded as the mapping **itself**, with no wrapper key, because that is what
/// Swift's `ReactionSnapshotDTO` does (`DTOs.swift:243-250`, a
/// `singleValueContainer`). Wrapping it here would break the shipped macOS
/// client's decode.
pub async fn reaction_snapshot(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<ReactionSnapshot>, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;

    let snapshot = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // Guard and read in one transaction, like every other channel read
            // here: a caller removed mid-flight must not still receive the page
            // their check passed for.
            if !is_channel_member(conn, channel_id, principal.member_id).await? {
                return Err(SendFailure::Rejected(ApiError::forbidden(
                    "not a member of this channel",
                )));
            }
            Ok(channel_reaction_snapshot(conn, channel_id).await?)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.reactions", error),
    })?;

    Ok(Json(snapshot))
}

// ---------------------------------------------------------------------------
// 이슈 #1112 — pin. The reaction shape verbatim: two verbs on one path plus a
// channel-scoped cold load, all three delegating every statement and every
// guard to `momo_messaging::interaction`.
// ---------------------------------------------------------------------------

fn pinned_dto(pinned: &PinnedMessage) -> PinnedMessageDto {
    PinnedMessageDto {
        message_id: pinned.message_id,
        channel_id: pinned.channel_id,
        seq: pinned.seq,
        author_member_id: pinned.author_member_id,
        message_type: pinned.message_type.clone(),
        state: pinned.state.clone(),
        body: pinned.body.clone(),
        created_at_ms: pinned.created_at.timestamp_millis(),
        pinned_by: pinned.pinned_by,
        pinned_at_ms: pinned.pinned_at.timestamp_millis(),
    }
}

/// `PUT …/messages/{id}/pin`.
pub async fn pin_message(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Json<PinDeltaDto>, ApiError> {
    mutate_pin(state, principal, path, PinAction::Pinned).await
}

/// `DELETE …/messages/{id}/pin`.
pub async fn unpin_message(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String)>,
) -> Result<Json<PinDeltaDto>, ApiError> {
    mutate_pin(state, principal, path, PinAction::Unpinned).await
}

/// The body both pin verbs share — one function for the same reason
/// [`mutate_reaction`] is one: they differ in a single enum and the guard order
/// is the thing most worth keeping identical.
async fn mutate_pin(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
    action: PinAction,
) -> Result<Json<PinDeltaDto>, ApiError> {
    let (workspace_id, message_id) = message_scope_ids(&workspace, &message, &principal)?;
    let via_token_id = audit_via_token_id(&principal);

    let delta = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let delta =
                match set_pin_in_tx(conn, workspace_id, message_id, principal.member_id, action)
                    .await?
                {
                    Ok(delta) => delta,
                    Err(refused) => {
                        return Err(SendFailure::Rejected(interaction_refusal(refused)))
                    }
                };
            // Same rule as the reaction toggle: a no-op answers 200 and records
            // nothing, because nothing happened.
            if delta.changed {
                record_interaction_audit(
                    conn,
                    workspace_id,
                    delta.channel_id,
                    message_id,
                    principal.member_id,
                    via_token_id,
                    &format!("message.{}", delta.action.as_wire_label()),
                )
                .await?;
            }
            Ok(delta)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.pin", error),
    })?;

    Ok(Json(PinDeltaDto {
        action: delta.action.as_wire_label().to_string(),
        message_id: delta.message_id,
        channel_id: delta.channel_id,
        changed: delta.changed,
        pinned: delta.pinned.as_ref().map(pinned_dto),
    }))
}

/// `GET /v1/workspaces/{ws}/channels/{ch}/pins` — the channel's pin list, for a
/// cold load.
///
/// Channel-scoped like the reaction snapshot and for the same reason: the header
/// list is loaded once per channel and then kept live by `message.pinned` /
/// `message.unpinned`, so folding it into the history projection would make
/// every page re-read it.
pub async fn pin_list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<PinListDto>, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;

    let pins = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // Guard and read in one transaction, like every other channel read
            // here.
            if !is_channel_member(conn, channel_id, principal.member_id).await? {
                return Err(SendFailure::Rejected(ApiError::forbidden(
                    "not a member of this channel",
                )));
            }
            Ok(channel_pins(conn, channel_id).await?)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.pins", error),
    })?;

    Ok(Json(PinListDto {
        pins: pins.iter().map(pinned_dto).collect(),
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
            reply_to_id: None,
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

        // ADR-0151: attachments are served, so `attachmentIds` left this list
        // too. Its refusals are now about the *rows* — the uploader, the
        // channel, the lifecycle state — and every one of them is made inside
        // the send transaction, not by a shape check here.
        let mut with_attachments = base();
        with_attachments.attachment_ids = Some(vec![Uuid::nil()]);
        assert!(
            reject_unsupported(&with_attachments).is_ok(),
            "attachmentIds is served now; a bad id is refused by the binding"
        );

        // An empty array carries no intent, and neither does an absent key.
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
        let message = stored_message();
        let rollup = ThreadRollup {
            reply_count: 3,
            last_reply_seq: 9,
            last_reply_at_ms: 1_700_000_000_500,
        };
        let json =
            serde_json::to_value(message_dto(&message, None, true, Some(&rollup), None, &[]))
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
        let bare = serde_json::to_value(message_dto(&message, None, true, None, None, &[]))
            .expect("serialize");
        assert!(bare.get("thread").is_none(), "{bare}");
    }

    fn stored_message() -> StoredMessage {
        StoredMessage {
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
            reply_to_id: None,
            created_at: chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
                .expect("timestamp"),
            edited_at: None,
            deleted_at: None,
        }
    }

    fn quoted(body: Option<&str>, deleted: bool, quotes_another: bool) -> QuotedMessage {
        QuotedMessage {
            id: Uuid::from_u128(0x11),
            seq: 2,
            author_member_id: Uuid::from_u128(0x22),
            message_type: MessageType::Text,
            body: body.map(str::to_string),
            state: if deleted { "deleted" } else { "sent" }.into(),
            edited_at: None,
            deleted_at: deleted.then(|| {
                chrono::DateTime::from_timestamp_millis(1_700_000_009_000).expect("timestamp")
            }),
            quotes_another,
        }
    }

    /// **The two halves of the quote contract, on the wire** (ADR-0148 §3-2).
    ///
    /// `replyToId` is the durable reference; `replyTo` is the read-time
    /// rendering. A client that only reads the id can still resolve the target
    /// itself, and a client that reads the object needs no second request.
    #[test]
    fn a_quote_travels_as_an_id_plus_a_resolved_block() {
        let mut message = stored_message();
        message.reply_to_id = Some(Uuid::from_u128(0x11));
        let quote = quoted(Some("원문"), false, false);
        let json = serde_json::to_value(message_dto(&message, None, true, None, Some(&quote), &[]))
            .expect("serialize");

        assert_eq!(json["replyToId"], serde_json::json!(Uuid::from_u128(0x11)));
        assert_eq!(
            json["replyTo"]["id"],
            serde_json::json!(Uuid::from_u128(0x11))
        );
        assert_eq!(json["replyTo"]["seq"], serde_json::json!(2));
        assert_eq!(
            json["replyTo"]["authorMemberId"],
            serde_json::json!(Uuid::from_u128(0x22))
        );
        assert_eq!(json["replyTo"]["type"], serde_json::json!("text"));
        assert_eq!(json["replyTo"]["body"], serde_json::json!("원문"));
        assert_eq!(json["replyTo"]["state"], serde_json::json!("sent"));
        // 규칙 4 — the marker is absent, not false, when there is no second
        // layer, so its presence is the whole signal.
        assert!(json["replyTo"].get("quotesAnother").is_none(), "{json}");

        // A message that quotes nothing carries neither key. Their absence is
        // what "no quote here" looks like, exactly like the thread rollup's.
        let bare =
            serde_json::to_value(message_dto(&stored_message(), None, true, None, None, &[]))
                .expect("serialize");
        assert!(bare.get("replyToId").is_none(), "{bare}");
        assert!(bare.get("replyTo").is_none(), "{bare}");
    }

    /// **규칙 3, at the wire boundary.** A deleted target must reach the client
    /// as a tombstone with no text — if a body ever survives here, the server
    /// has minted the copy that outlives the author's deletion.
    #[test]
    fn a_deleted_quote_target_carries_a_tombstone_and_no_text() {
        let mut message = stored_message();
        message.reply_to_id = Some(Uuid::from_u128(0x11));
        let json = serde_json::to_value(message_dto(
            &message,
            None,
            true,
            None,
            Some(&quoted(None, true, false)),
            &[],
        ))
        .expect("serialize");

        assert!(
            json["replyTo"].get("body").is_none(),
            "a tombstone must carry no body: {json}"
        );
        assert_eq!(json["replyTo"]["state"], serde_json::json!("deleted"));
        assert_eq!(
            json["replyTo"]["deletedAtMs"],
            serde_json::json!(1_700_000_009_000_i64)
        );
        // Still addressable: the reference survives the deletion, so a client
        // knows *that* something was quoted even though the text is gone.
        assert_eq!(json["replyToId"], serde_json::json!(Uuid::from_u128(0x11)));
    }

    /// **규칙 4 — one layer, and the second is a flag.** The inner target's id
    /// is deliberately absent: give a client the id and someone will render the
    /// staircase the rule exists to prevent.
    #[test]
    fn a_quote_of_a_quote_is_a_marker_and_never_a_second_layer() {
        let mut message = stored_message();
        message.reply_to_id = Some(Uuid::from_u128(0x11));
        let json = serde_json::to_value(message_dto(
            &message,
            None,
            true,
            None,
            Some(&quoted(Some("나도 인용함"), false, true)),
            &[],
        ))
        .expect("serialize");

        assert_eq!(json["replyTo"]["quotesAnother"], serde_json::json!(true));
        for forbidden in ["replyTo", "replyToId"] {
            assert!(
                json["replyTo"].get(forbidden).is_none(),
                "the second layer must be a marker only: {json}"
            );
        }
    }

    /// Both rejections are sentences a client can show, both keep their own
    /// wording, and neither may match `/routing/i` — see
    /// [`the_probe_now_reads_ready_because_routing_is_validated_first`].
    #[test]
    fn every_quote_target_rejection_keeps_its_own_sentence() {
        let missing = quote_target_rejection(QuoteTargetInvalid::NotFound);
        assert_eq!(missing.status, StatusCode::NOT_FOUND);
        assert_eq!(missing.message, "quoted message not found in this channel");

        let deleted = quote_target_rejection(QuoteTargetInvalid::Deleted);
        assert_eq!(deleted.status, StatusCode::BAD_REQUEST);
        assert_eq!(deleted.message, "a deleted message cannot be quoted");

        assert_ne!(missing.message, deleted.message);
        for rejection in [&missing, &deleted] {
            assert!(
                !rejection.message.to_lowercase().contains("routing"),
                "a quote refusal that named routing would be read as a routing \
                 capability verdict: {}",
                rejection.message
            );
        }
    }

    /// 규칙 1 — a send may carry both, and the request decoder must not have
    /// quietly made them exclusive.
    #[test]
    fn a_send_can_ask_for_a_thread_and_a_quote_at_once() {
        let root = Uuid::from_u128(0xaa);
        let quote = Uuid::from_u128(0xbb);
        let request: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "clientMsgId": Uuid::nil(),
            "rootId": root,
            "replyToId": quote,
            "body": "이 답글 말이야",
        }))
        .expect("both keys decode together");
        assert_eq!(request.root_id, Some(root));
        assert_eq!(request.reply_to_id, Some(quote));

        // …and a quote alone is the ordinary case: no thread is created.
        let quote_only: SendMessageRequest = serde_json::from_value(serde_json::json!({
            "clientMsgId": Uuid::nil(),
            "replyToId": quote,
        }))
        .expect("a quote needs no root");
        assert_eq!(quote_only.root_id, None);
        assert_eq!(quote_only.reply_to_id, Some(quote));
    }

    // -----------------------------------------------------------------------
    // 이슈 #1112 — pin
    // -----------------------------------------------------------------------

    /// **Red proof #1, route half.** A non-member's pin is a 403 and not a
    /// silent success or a 500. The domain refuses with `NotAMember` (proven
    /// against Postgres in `interaction_conformance_pg`); this pins the status
    /// that refusal becomes — drop `NotAMember` out of the FORBIDDEN arm and a
    /// stranger's pin starts answering 400.
    ///
    /// The two pin refusals ride along because they are what a reviewer would
    /// most plausibly get wrong: the cap is a *conflict* (409, retry never
    /// helps until someone unpins), the tombstone is a *bad request* (400).
    #[test]
    fn pin_refusals_keep_the_reaction_paths_status_shape() {
        assert_eq!(
            interaction_refusal(InteractionRefused::NotAMember).status,
            StatusCode::FORBIDDEN,
            "a non-member pinning must be refused, not tolerated"
        );
        assert_eq!(
            interaction_refusal(InteractionRefused::PinLimit).status,
            StatusCode::CONFLICT,
            "the channel cap is a conflict — a retry cannot fix it"
        );
        assert_eq!(
            interaction_refusal(InteractionRefused::PinDeleted).status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            interaction_refusal(InteractionRefused::NotFound).status,
            StatusCode::NOT_FOUND,
            "404 still outranks 403 for a message that does not exist"
        );
    }

    /// The wire keys are the contract two clients decode. `type` in particular
    /// is a serde rename that a refactor of the struct field would silently
    /// drop, leaving the header list unable to tell a text message from a
    /// system one.
    #[test]
    fn the_pin_delta_names_its_keys_in_camel_case_with_lowercase_ids() {
        let message_id = Uuid::from_u128(0x1112);
        let channel_id = Uuid::from_u128(0x1113);
        let dto = PinDeltaDto {
            action: "pinned".into(),
            message_id,
            channel_id,
            changed: true,
            pinned: Some(PinnedMessageDto {
                message_id,
                channel_id,
                seq: 42,
                author_member_id: Uuid::from_u128(0x1114),
                message_type: "text".into(),
                state: "sent".into(),
                body: Some("고정할 메시지".into()),
                created_at_ms: 1_700_000_000_000,
                pinned_by: Uuid::from_u128(0x1115),
                pinned_at_ms: 1_700_000_001_000,
            }),
        };
        let wire = serde_json::to_value(&dto).expect("serializes");
        assert_eq!(wire["messageId"], serde_json::json!(message_id));
        assert_eq!(wire["changed"], serde_json::json!(true));
        assert_eq!(wire["pinned"]["seq"], serde_json::json!(42));
        assert_eq!(wire["pinned"]["type"], serde_json::json!("text"));
        assert_eq!(
            wire["pinned"]["pinnedAtMs"],
            serde_json::json!(1_700_000_001_000i64)
        );
        assert_eq!(
            wire["messageId"].as_str().expect("a string"),
            message_id.to_string(),
            "pin ids are lowercase — the reaction wire's uppercase is a Swift \
             legacy this surface has no reason to inherit"
        );

        // An unpin names no projection at all.
        let unpin = PinDeltaDto {
            action: "unpinned".into(),
            message_id,
            channel_id,
            changed: true,
            pinned: None,
        };
        let wire = serde_json::to_value(&unpin).expect("serializes");
        assert!(
            wire.get("pinned").is_none(),
            "an unpin must not carry a body back out: {wire}"
        );
    }
}
