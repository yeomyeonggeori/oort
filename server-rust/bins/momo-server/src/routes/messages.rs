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
use momo_agent::{terminal_run_ids_in_tx, RunBindingRejected};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{
    channel_pins, channel_reaction_snapshot, clamp_history_limit, clamp_replies_limit,
    delete_message_in_tx, edit_message_in_tx, is_channel_member, list_channel_page,
    list_thread_replies, open_stream_run_id, parse_replies_cursor, resolve_member_signing_key,
    send_message_with_mentions_in_tx, set_pin_in_tx, set_reaction_in_tx, stream_message_body_in_tx,
    validate_harness_refine, validate_quote_target_in_tx, validate_reaction_emoji,
    validate_replies_root_in_tx, validate_thread_root_in_tx, AttachmentLinkRejected, HarnessRefine,
    HarnessRefineInvalid, HistoryCursor, InteractionMessage, InteractionRefused, MessageAttachment,
    MessageSignature, MessageType, NewMessage, PagedMessage, PinAction, PinnedMessage,
    ProvenanceRejected, QuoteTargetInvalid, QuotedMessage, ReactionAction, ReactionSnapshot,
    SendExtras, SendRejected, StoredMessage, StreamCloseOutcome, StreamEdit, ThreadRollup,
    ThreadRootInvalid, HARNESS_REFINE_PROPS_KEY, OPENING_STREAM_REV, STREAM_PROPS_KEY,
};
use serde_json::{Map, Value};
use std::collections::HashSet;
use uuid::Uuid;

use crate::dto::{
    EditMessageRequest, HistoryQuery, MessageDto, MessagePage, PinDeltaDto, PinListDto,
    PinnedMessageDto, QuotedMessageDto, ReactionDeltaDto, RepliesQuery, SendMessageRequest,
    StreamEditRequest, ThreadRepliesPage, ThreadRollupDto,
};
use crate::error::{db_error, ApiError};
use crate::routes::agent_mentions::{route_agent_mentions_in_tx, MentionSend};
use crate::routes::shared::audit_via_token_id;
use crate::AppState;

/// Server-owned props key: a save-time parsing result that a client may never
/// supply (Swift `encodeProps` strips it before persisting).
const SERVER_OWNED_PROPS_KEY: &str = "mention_member_ids";

/// Every props key the server authors and therefore trusts.
///
/// [`STREAM_PROPS_KEY`] joins the list with #1130 전제①: the streaming
/// staleness guard reads `momo.stream.rev` back and compares against it, so a
/// client that could write that key could park a huge revision on someone's
/// message and freeze every later slice of it as "stale". A trusted key that a
/// client can write is not a trusted key.
///
/// [`HARNESS_REFINE_PROPS_KEY`] joins it with ADR-0158 D2, for a different
/// danger with the same answer. Nothing reads this key back to make a decision,
/// so the risk is not a poisoned guard but a **forged claim**: the block is what
/// a client will eventually key "이 에이전트가 스스로를 갱신했습니다" off, and a
/// props map any member can write is not somewhere that sentence can be sourced
/// from. The validated block arrives as `harnessRefine` instead, and
/// `momo_messaging::refine` is what turns it into this key.
const SERVER_OWNED_PROPS_KEYS: [&str; 3] = [
    SERVER_OWNED_PROPS_KEY,
    STREAM_PROPS_KEY,
    HARNESS_REFINE_PROPS_KEY,
];

/// The props key that carries an agent run's id for readers (#1166).
///
/// Not in [`SERVER_OWNED_PROPS_KEYS`], and the asymmetry is deliberate. A
/// producer that names its run in props without sending `runId` is the
/// pre-ADR-0158 shape and still works unchanged — stripping it would break every
/// adapter written against the wire as it stood. What ADR-0158 adds is that when
/// a **validated** `runId` *is* sent, the server writes this key from it, so the
/// column and the readable copy cannot disagree. See [`bind_run_props`].
const RUN_ID_PROPS_KEY: &str = "run_id";

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

/// Client props → the stored `props` object, minus every server-owned key.
fn props_value(props: Option<&std::collections::BTreeMap<String, String>>) -> Value {
    let mut object = Map::new();
    if let Some(props) = props {
        for (key, value) in props {
            if SERVER_OWNED_PROPS_KEYS.contains(&key.as_str()) {
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

#[allow(clippy::too_many_arguments)]
fn message_dto(
    message: &StoredMessage,
    client_msg_id: Option<Uuid>,
    include_state: bool,
    thread: Option<&ThreadRollup>,
    reply_to: Option<&QuotedMessage>,
    attachments: &[MessageAttachment],
    run_ended: bool,
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
        run_ended,
    }
}

/// The run ids a page has to ask about — the still-open streams on it (#1166).
///
/// Empty for essentially every page, which is the point: the extra read below
/// costs nothing until a closing PATCH has actually gone missing.
fn open_stream_runs(page: &[PagedMessage]) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> = page
        .iter()
        .filter_map(|paged| open_stream_run_id(&paged.message.props))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// One page row → its DTO, with #1166's verdict already taken.
///
/// `ended_runs` is the set the page's own transaction resolved. A row whose
/// stream is closed, or which never streamed, cannot be in it — [`open_stream_run_id`]
/// is the only thing that put ids there.
fn paged_dto(paged: &PagedMessage, include_state: bool, ended_runs: &HashSet<Uuid>) -> MessageDto {
    let run_ended =
        open_stream_run_id(&paged.message.props).is_some_and(|run_id| ended_runs.contains(&run_id));
    message_dto(
        &paged.message,
        None,
        include_state,
        paged.thread.as_ref(),
        paged.reply_to.as_ref(),
        &paged.attachments,
        run_ended,
    )
}

/// A refused `runId` → its HTTP answer (ADR-0158 D5).
///
/// **404 for an unknown run and 403 for someone else's**, which is the same
/// disclosure split [`attachment_link_rejection`] makes and for the same reason.
/// A run in another workspace is invisible under RLS and lands in the `Unknown`
/// branch, so answering anything more specific than "not found" would confirm
/// the existence of rows the caller may not see. A run in *this* workspace, by
/// contrast, is one the caller can already read through `GET …/agent-runs`, so
/// hiding it would protect nothing while making "that run is not yours"
/// indistinguishable from a typo.
fn run_binding_rejection(rejected: RunBindingRejected) -> ApiError {
    match rejected {
        RunBindingRejected::Unknown => ApiError::not_found(rejected.to_string()),
        RunBindingRejected::NotRunAgent => ApiError::forbidden(rejected.to_string()),
    }
}

/// The validated refinement block a send carries, if any (ADR-0158 D1~D4).
///
/// Runs **before the transaction opens**, exactly where `routing` and the
/// `stream` marker are checked and for the same reason: every failure here is a
/// malformed request the caller can fix, and answering it costs no connection.
///
/// Three checks live here rather than in the domain crate because all three are
/// about *this request as a whole* rather than about the block's own values:
///
/// 1. **`type` must be `system`** (D2). The announcement reuses an existing type
///    on purpose — no client learns a new frame — and a refinement posted as
///    `text` would be a machine notice sitting in the conversation as if someone
///    had said it.
/// 2. **a body is required.** §2.2's rule is "본문은 사람 문장, 근거는 props",
///    the same discipline the approval card follows. A bodyless announcement
///    renders as a blank line whose meaning is only in a props object no human
///    reads.
/// 3. **`clientMsgId` must be the derived key** (D4). The server could compute
///    it and overwrite the caller's silently; it refuses instead, because a
///    silently rewritten idempotency key is one the caller cannot use to retry.
///    The sentence names the expected uuid, so a producer is never stuck.
fn harness_refine(
    request: &SendMessageRequest,
    message_type: MessageType,
) -> Result<Option<HarnessRefine>, ApiError> {
    let Some(block) = request.harness_refine.as_ref() else {
        return Ok(None);
    };
    let refuse = |invalid: HarnessRefineInvalid| ApiError::bad_request(invalid.to_string());
    if message_type != MessageType::System {
        return Err(refuse(HarnessRefineInvalid::NotSystemMessage));
    }
    if request
        .body
        .as_deref()
        .map(str::trim)
        .is_none_or(|body| body.is_empty())
    {
        return Err(refuse(HarnessRefineInvalid::MissingBody));
    }
    let edits: Vec<(String, String, String)> = block
        .edits
        .iter()
        .map(|edit| (edit.action.clone(), edit.kind.clone(), edit.id.clone()))
        .collect();
    let refine = validate_harness_refine(
        &block.refinement_id,
        &block.trigger,
        &block.scope,
        &edits,
        block.summary.as_deref(),
        block.rollback_id.as_deref(),
    )
    .map_err(refuse)?;

    let expected = refine.client_msg_id();
    if request.client_msg_id != expected {
        return Err(refuse(HarnessRefineInvalid::ClientMsgId { expected }));
    }
    Ok(Some(refine))
}

/// Stamp a validated run binding onto the message about to be written.
///
/// Both halves, always together, which is the whole point of doing it in one
/// function: the **column** is what `open_stream_message_for_run_in_tx` looks a
/// half-written answer up by (so a server-side close can reach an adapter's
/// message at all), and the **props copy** is what `open_stream_run_id` reads
/// when a page decides whether to draw #1166's "run ended" tail. The in-process
/// producer writes both (`momo-agent-worker`'s `opening_props`); a REST producer
/// that wrote only one would be findable by exactly one of the two readers.
///
/// The props value is the server's, not the caller's — a `run_id` prop sent
/// alongside a validated `runId` is overwritten rather than merged with, for the
/// same reason `opening_props` overwrites it in-process: "the run id is not the
/// caller's to omit or to override".
fn bind_run_props(message: &mut NewMessage, run_id: Uuid) {
    message.run_id = Some(run_id);
    let mut object = match std::mem::take(&mut message.props) {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    object.insert(
        RUN_ID_PROPS_KEY.to_string(),
        Value::String(run_id.to_string()),
    );
    message.props = Value::Object(object);
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

/// Whether this send opens a growing answer, after checking what it claims
/// (#1173).
///
/// The block carries no value the server stores — the marker it produces is
/// always [`momo_messaging::opening_stream_props`] — so both checks exist to keep
/// the producer's arithmetic and the row's the same. Dropping them would not
/// change a single byte in Postgres, and that is exactly the danger: a producer
/// that declared `rev: 9` would number its first slice 10 against a row that
/// says 0, and one that declared `streaming: false` would believe it had posted
/// a finished answer while the channel shows one that nothing will ever close.
/// A refusal is the only answer that tells it so.
fn opens_stream(request: &SendMessageRequest) -> Result<bool, ApiError> {
    let Some(stream) = request.stream.as_ref() else {
        return Ok(false);
    };
    if stream.rev != OPENING_STREAM_REV {
        return Err(ApiError::bad_request(format!(
            "a stream's opening marker must be rev {OPENING_STREAM_REV} — the first slice is \
             rev {}",
            OPENING_STREAM_REV + 1
        )));
    }
    if !stream.streaming {
        return Err(ApiError::bad_request(
            "a stream's opening marker must be streaming: true — a stream is closed by its \
             final PATCH slice, not by the send that opens it",
        ));
    }
    Ok(true)
}

/// `POST /v1/workspaces/{ws}/channels/{ch}/messages` — the single write path.
///
/// **An optional `stream` block makes this the opening write of a growing
/// answer** (#1173). It changes nothing about the send except one server-owned
/// props key, written on the same insert as the text — which is the whole point:
/// the in-process producer has carried that marker since #1161, and until now an
/// out-of-process one (prime, hermes) had no way to. A turn that died between
/// its opening write and its first slice left, over REST only, a half sentence
/// that claimed to be a finished answer and that
/// `open_stream_message_for_run_in_tx` could not even find in order to mark.
///
/// The two paths now open the same shape, so `PATCH …/messages/{id}` with a
/// `stream` block continues an adapter's message exactly as it continues the
/// worker's, and no reader has to know which one wrote it.
///
/// **An optional `runId` binds the write to an agent run** (ADR-0158 D5), and
/// that is what finishes the sentence #1173 started. The opening marker made an
/// adapter's half-answer *look* like the in-process one; the run binding is what
/// makes it *findable* — `open_stream_message_for_run_in_tx` is keyed on the
/// `run_id` column, so before this the closing PATCH ADR-0155 promises simply
/// had nothing to close on the REST path. The field was decoded and refused for
/// exactly as long as it could not be validated; see [`run_binding_rejection`]
/// for the three checks that replaced the refusal.
///
/// **An optional `harnessRefine` block announces a self-modification**
/// (ADR-0158 D1~D4) as one `system` line the room can scroll back to.
pub async fn send(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<SendMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (workspace_id, channel_id) = scope_ids(&workspace, &channel, &principal)?;
    // #1173 — shape only, and before any connection is taken, for the same
    // reason `routing` is validated here: a malformed declaration is the
    // caller's mistake and costs nothing to answer.
    let opens_stream = opens_stream(&request)?;

    let message_type = match request.message_type.as_deref() {
        None => MessageType::Text,
        Some(label) => MessageType::from_db_label(label)
            .ok_or_else(|| ApiError::bad_request("unsupported message type"))?,
    };
    // ADR-0158 D1~D4 — shape and vocabulary, on the same "before any connection"
    // rule. The run binding below cannot join it there: it is a tenant read.
    let refine = harness_refine(&request, message_type)?;

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
    // ADR-0162 HAP-E5: the per-agent hosted selector's production gate, read
    // beside the instance-global provider mode precisely so the two stay
    // visibly independent knobs rather than one.
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let context_max_messages = state.mentions.context_max_messages;
    // ADR-0158 D2 — the refinement block becomes props here, *before* the
    // transaction, because it is a pure rewrite of an already-validated value.
    // The key it writes into is server-owned (`SERVER_OWNED_PROPS_KEYS`), so
    // `props_value` has already stripped any client attempt at it and this is
    // its only writer.
    let props = match refine.as_ref() {
        None => props_value(request.props.as_ref()),
        Some(refine) => {
            momo_messaging::harness_refine_input_props(props_value(request.props.as_ref()), refine)
        }
    };
    let requested_run_id = request.run_id;
    let mut new_message = NewMessage {
        channel_id,
        author_member_id: principal.member_id,
        message_type,
        body: request.body.clone(),
        props,
        root_id,
        reply_to_id,
        client_msg_id: Some(client_msg_id),
        // ADR-0158 D5 — filled in inside the transaction, and only after
        // `authorize_run_binding_in_tx` has agreed. `None` here is not a default
        // to be tidied away: it is what an unauthorized binding stays.
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
            // ADR-0158 D5 — fail-closed, inside this transaction and not before
            // it. The check is a tenant read (`agent_run` under RLS), so hoisting
            // it out of the transaction that writes the message would both lose
            // the GUC and open a window in which a run could be created,
            // cancelled or moved between the check and the insert.
            if let Some(run_id) = requested_run_id {
                if let Err(rejected) = momo_agent::authorize_run_binding_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    principal.member_id,
                )
                .await?
                {
                    return Err(SendFailure::Rejected(run_binding_rejection(rejected)));
                }
                bind_run_props(&mut new_message, run_id);
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
                    opens_stream,
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
                        hosted_delivery_enabled,
                        context_max_messages,
                        routing: requested_routing.as_ref(),
                    },
                )
                .await?
                {
                    return Err(SendFailure::Rejected(rejection));
                }
            }
            // ADR-0158 D3 — the ledger half. `!deduped` for the same reason the
            // mention pass carries it: a retried announcement is the same
            // refinement, and a second audit row would claim a second
            // self-modification that never happened.
            if !sent.deduped {
                if let Some(refine) = refine.as_ref() {
                    record_refine_audit(
                        conn,
                        workspace_id,
                        channel_id,
                        sent.message.id,
                        principal.member_id,
                        via_token_id,
                        refine,
                    )
                    .await?;
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
            // #1166 — a write path answers about the write. The run behind a
            // message that was just opened is by construction not over, and
            // asking would put a read inside the send transaction for an answer
            // that is always `false` (the same trade `replyTo` above declines).
            false,
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
    let (page, ended_runs) = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
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
            let page = list_thread_replies(conn, channel_id, root_id, cursor, limit).await?;
            // #1166 — same transaction as the page it annotates. A thread is
            // read after a reload exactly as a channel is, and a reader who
            // gets the defensive tail on the main timeline but not inside a
            // thread would be told two different things about one message.
            let ended =
                terminal_run_ids_in_tx(conn, workspace_id, &open_stream_runs(&page.messages))
                    .await?;
            Ok((page, ended))
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
            .map(|paged| paged_dto(paged, true, &ended_runs))
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
            // #1166 — the reload closure. `endedRuns` in a client only knows
            // the runs whose terminal frame it *watched arrive*, which is the
            // right rule for a live session and no rule at all for a tab that
            // was opened afterwards. So the page that rebuilds that tab carries
            // the answer with it, resolved in the same transaction that read
            // the rows, against the durable job status ADR-0155 calls the truth.
            let ended =
                terminal_run_ids_in_tx(conn, workspace_id, &open_stream_runs(&messages)).await?;
            Ok::<_, DbError>(Some((messages, ended)))
        })
    })
    .await
    .map_err(|error| db_error("messages.history", error))?;

    let (messages, ended_runs) =
        page.ok_or_else(|| ApiError::forbidden("not a member of this channel"))?;
    // nextBefore = the smallest seq on this page (Swift `dtos.map(\.seq).min()`).
    let next_before = messages.iter().map(|paged| paged.message.seq).min();

    Ok(Json(MessagePage {
        messages: messages
            .iter()
            .map(|paged| paged_dto(paged, true, &ended_runs))
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
        | InteractionRefused::EmptyBody
        // #1130 전제① — a malformed revision is the caller's mistake, not a
        // conflict: nothing on the server disagreed with it, it was never a
        // usable number. 409 would tell a retry loop to back off and try the
        // same broken value again.
        | InteractionRefused::StreamRevInvalid
        // ADR-0155 — same reasoning: an outcome on a non-final slice is a
        // self-contradictory request, not a race with another writer.
        | InteractionRefused::StreamOutcomeNotFinal => StatusCode::BAD_REQUEST,
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
///
/// **Two writes share this door** (#1130 전제①). Without a `stream` block it is
/// the human revision it has always been. With one it is a slice of a growing
/// answer, and [`stream_edit`] takes it — same route, same 200, same
/// `message.edited` broadcast, so no client learns a new frame to render a
/// streaming agent. The fork is here rather than on a second route because
/// everything that guards an edit — authorship, membership, the tombstone rule,
/// RLS, "no interaction consumes a seq" — must guard both, and a second route is
/// a second place for one of those to be forgotten.
pub async fn edit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, message)): Path<(String, String)>,
    Json(request): Json<EditMessageRequest>,
) -> Result<Json<MessageDto>, ApiError> {
    let (workspace_id, message_id) = message_scope_ids(&workspace, &message, &principal)?;
    let via_token_id = audit_via_token_id(&principal);

    if let Some(stream) = request.stream {
        return stream_edit(
            &state,
            &principal,
            workspace_id,
            message_id,
            via_token_id,
            request.body,
            stream,
        )
        .await;
    }

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
        // #1166 — an edit answers about the edit; the run verdict rides page
        // reads only.
        false,
    )))
}

/// The `PATCH …/messages/{id}` arm that carries a `stream` block (#1130 전제①).
///
/// One turn of a streaming provider is one message that **grows**. 실측 (#1120
/// prime 스파이크 §2): a 3,661-character answer coalesced 30.8× still needs 17
/// writes; through `send` that is 17 messages in the channel for one sentence.
///
/// Two things differ from the arm above, and both are deliberate:
///
/// 1. **A not-newer `rev` is a 200, not a 409.** The domain answers
///    [`StreamOutcome::Stale`] and the caller gets the message as it stands. A
///    replayed slice and a slice overtaken by its own successor are the same
///    event, and "this is already true" is the honest answer to both — a 409
///    would make a correct retry look like a failure to every adapter.
/// 2. **One audit row per assembled message, not one per slice.** The row is
///    written on the *final* applied slice and names the revision count it
///    settled at. Seventeen `message.edited` audit rows would be seventeen
///    claims that a member revised their words, which is false, and the volume
///    would drown the real edits an auditor is reading for.
///
/// A slice may also carry `outcome` (ADR-0155) — the closing slice of an answer
/// that was **stopped** rather than completed. It rides the same final write, so
/// it leaves the same single audit row: a cancelled answer was still assembled,
/// and hiding it from the audit trail would make "the agent said nothing here"
/// and "the agent was cut off here" the same absence.
async fn stream_edit(
    state: &AppState,
    principal: &Principal,
    workspace_id: Uuid,
    message_id: Uuid,
    via_token_id: Option<Uuid>,
    body: String,
    stream: StreamEditRequest,
) -> Result<Json<MessageDto>, ApiError> {
    let actor_member_id = principal.member_id;
    // ADR-0155 — an unrecognised outcome is refused here rather than dropped.
    // Dropping it would let a producer believe it had marked a message as
    // stopped while the channel shows a half-answer that looks complete, and the
    // producer would have no way to find out.
    let outcome = match stream.outcome.as_deref() {
        None => None,
        Some(value) => Some(StreamCloseOutcome::from_wire(value).ok_or_else(|| {
            ApiError::bad_request("stream outcome must be \"cancelled\" or \"failed\"")
        })?),
    };
    let edit = StreamEdit {
        rev: stream.rev,
        is_final: stream.is_final,
        outcome,
    };

    let outcome = tenant_tx_or_reject(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let outcome = match stream_message_body_in_tx(
                conn,
                workspace_id,
                message_id,
                actor_member_id,
                &body,
                edit,
            )
            .await?
            {
                Ok(outcome) => outcome,
                // Through the ERROR channel for the same reason the plain edit
                // does it: `with_tenant_tx` commits on `Ok`, and a refusal
                // returned as a value would still commit the locks it took.
                Err(refused) => return Err(SendFailure::Rejected(interaction_refusal(refused))),
            };
            if edit.is_final && outcome.applied() {
                record_stream_audit(
                    conn,
                    workspace_id,
                    outcome.message().message.channel_id,
                    message_id,
                    actor_member_id,
                    via_token_id,
                    edit.rev,
                )
                .await?;
            }
            Ok(outcome)
        })
    })
    .await
    .map_err(|failure| match failure {
        SendFailure::Rejected(rejection) => rejection,
        SendFailure::Db(error) => db_error("messages.stream_edit", error),
    })?;

    Ok(Json(stream_message_dto(outcome.message())))
}

/// The 200 body a streaming slice answers with — identical in shape to the plain
/// edit's, so an adapter parses one `Message` either way.
fn stream_message_dto(projection: &InteractionMessage) -> MessageDto {
    message_dto(
        &projection.message,
        projection.client_msg_id,
        true,
        None,
        None,
        &[],
        // #1166 — the producer of this slice *is* the run; it does not need to
        // be told whether it has ended.
        false,
    )
}

/// The single audit row an assembled message leaves (#1130 전제①).
///
/// `message.streamed` rather than `message.edited`: an auditor reading for "who
/// changed what they said" must not have to filter seventeen machine slices out
/// of the answer, and the two facts genuinely are different. `revisions` records
/// how many slices it took, which is the only number a reader of this row would
/// otherwise have to reconstruct from the outbox.
async fn record_stream_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    final_rev: i64,
) -> Result<(), DbError> {
    let entry = AuditEntry::new(workspace_id, "message.streamed")
        .by(actor_member_id)
        .about_optional(None)
        .target("message", message_id)
        .via_token(via_token_id)
        .with_schema(
            "momo.message_stream.v1",
            serde_json::json!({
                "channel_id": channel_id,
                "event_type": "message.streamed",
                "final_rev": final_rev,
            }),
        );
    write_audit(conn, &entry).await?;
    Ok(())
}

/// The audit row a refinement announcement leaves (ADR-0158 D3).
///
/// D3 says `rollbackId` is "원장/감사에만" — the ledger and the audit trail, and
/// no channel affordance — so this row is half of what that sentence promises;
/// the message's own props are the other half. Written here rather than left to
/// the message row alone because the two answer different questions: the channel
/// answers "when did this colleague change", and this answers "by whom, under
/// which credential, and can it be undone" — the question an operator asks after
/// the fact, against a table that keeps `via_token_id`.
///
/// `agent.harness_refined` rather than a `message.*` action, deliberately: the
/// subject is the agent's behaviour, not the message that reported it, and an
/// auditor reading `message.*` for "who changed what they said" must not have to
/// filter machine notices out of the answer (the same argument
/// [`record_stream_audit`] makes for `message.streamed`).
async fn record_refine_audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
    refine: &HarnessRefine,
) -> Result<(), DbError> {
    let entry = AuditEntry::new(workspace_id, "agent.harness_refined")
        .by(actor_member_id)
        // The agent is the actor *and* the subject, and naming it twice would
        // read as two members. `target` names the message the room can scroll to.
        .about_optional(None)
        .target("message", message_id)
        .via_token(via_token_id)
        .with_schema(
            "momo.harness_refine.v1",
            serde_json::json!({
                "channel_id": channel_id,
                "event_type": "agent.harness_refined",
                "refinement_id": refine.refinement_id,
                "trigger": refine.trigger.wire(),
                "scope": momo_messaging::HARNESS_REFINE_SCOPE,
                // The count, not the list: the audit row is bound by the same
                // disclosure rule as the props block (§2.2), and an auditor who
                // needs the entry ids reads them off the message it names.
                "edit_count": refine.edits.len(),
                "rollback_id": refine.rollback_id,
            }),
        );
    write_audit(conn, &entry).await?;
    Ok(())
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
        // #1166 — a tombstone draws no tail at all (`MessageRow` short-circuits
        // on `deleted`), so the verdict has nowhere to land.
        false,
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
    use momo_messaging::StreamOutcome;
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
        // #1130 전제① — the streaming revision is read back by the staleness
        // guard, so a client that could write it could park a huge number on
        // someone else's message and freeze every later slice as "stale".
        props.insert(STREAM_PROPS_KEY.to_string(), r#"{"rev":9999}"#.to_string());
        let value = props_value(Some(&props));
        assert_eq!(value["k"], Value::String("v".into()));
        assert!(
            value.get(SERVER_OWNED_PROPS_KEY).is_none(),
            "mention_member_ids is server-owned and must be stripped"
        );
        assert!(
            value.get(STREAM_PROPS_KEY).is_none(),
            "momo.stream is server-owned and must be stripped"
        );
    }

    /// #1130 전제① — a `stream` block is optional and its absence is the plain
    /// edit. A request shaped like yesterday's must still parse, or every
    /// deployed client breaks the day this ships.
    #[test]
    fn the_stream_block_is_optional_and_its_absence_is_a_plain_edit() {
        let plain: EditMessageRequest =
            serde_json::from_str(r#"{"body":"고쳤다"}"#).expect("a body-only edit still parses");
        assert!(plain.stream.is_none());

        let sliced: EditMessageRequest =
            serde_json::from_str(r#"{"body":"답이 자","stream":{"rev":3,"final":false}}"#)
                .expect("a slice parses");
        let stream = sliced.stream.expect("stream block");
        assert_eq!(stream.rev, 3);
        assert!(!stream.is_final, "`final` is the wire name, not `isFinal`");
    }

    /// #1173 — the same promise on the send: a POST shaped like yesterday's
    /// carries no `stream` block, parses, and opens nothing.
    ///
    /// The decoder is closed-world (`deny_unknown_fields`), so before this
    /// ticket a producer that tried to say it got a 400 naming an unknown key.
    /// That is exactly why the field has to be added rather than tolerated: a
    /// server that ignored it would leave the adapter believing it had marked
    /// the message.
    #[test]
    fn an_absent_stream_block_is_the_send_that_was_always_there() {
        let plain: SendMessageRequest = serde_json::from_str(
            r#"{"clientMsgId":"00000000-0000-0000-0000-000000000001","body":"안녕"}"#,
        )
        .expect("a send shaped like yesterday's still parses");
        assert!(plain.stream.is_none());
        assert!(!opens_stream(&plain).expect("nothing to check"));
    }

    /// The opening declaration the server accepts, and the two it refuses.
    ///
    /// **RED proof.** Delete either guard in [`opens_stream`] and this goes
    /// green — with a 201 whose row says exactly what it said before, because
    /// the marker is the server's to write. That is the trap: the producer's
    /// arithmetic and the row's would part company silently. A producer that
    /// declared `rev: 9` numbers its first slice `10` against a row holding
    /// `0`, and one that declared `streaming: false` believes it posted a
    /// finished answer while the channel shows one that nothing will ever
    /// close.
    #[test]
    fn an_opening_marker_must_declare_rev_zero_and_streaming_true() {
        let opening: SendMessageRequest = serde_json::from_str(
            r#"{"clientMsgId":"00000000-0000-0000-0000-000000000001",
                "body":"답이 자","stream":{"rev":0,"streaming":true}}"#,
        )
        .expect("an opening send parses");
        assert!(opens_stream(&opening).expect("rev 0 + streaming is the marker"));

        let numbered: SendMessageRequest = serde_json::from_str(
            r#"{"clientMsgId":"00000000-0000-0000-0000-000000000001",
                "body":"답이 자","stream":{"rev":9,"streaming":true}}"#,
        )
        .expect("parses; the refusal is the route's, not serde's");
        let error = opens_stream(&numbered).expect_err("only rev 0 opens");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(
            error.message.contains("rev 0") && error.message.contains("rev 1"),
            "the sentence must name both floors: {}",
            error.message
        );

        let closed: SendMessageRequest = serde_json::from_str(
            r#"{"clientMsgId":"00000000-0000-0000-0000-000000000001",
                "body":"답이 자","stream":{"rev":0,"streaming":false}}"#,
        )
        .expect("parses");
        let error = opens_stream(&closed).expect_err("a send cannot open a closed stream");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(
            error.message.contains("streaming: true"),
            "the sentence must name the field: {}",
            error.message
        );
    }

    /// A closing verb on the opening block is refused by the decoder itself.
    ///
    /// `final`/`outcome` belong to the PATCH. Accepting them here silently would
    /// let a producer believe it had opened and closed a stream in one write,
    /// and what it would actually leave behind is a message stuck at
    /// `streaming: true` with nothing left to close it.
    #[test]
    fn the_opening_block_refuses_the_closing_verbs() {
        let error = serde_json::from_str::<SendMessageRequest>(
            r#"{"clientMsgId":"00000000-0000-0000-0000-000000000001",
                "body":"답","stream":{"rev":0,"streaming":true,"final":true}}"#,
        )
        .expect_err("`final` is not a key of the opening block");
        assert!(
            error.to_string().contains("final"),
            "the decoder must name the key: {error}"
        );
    }

    /// A signed send that also opens a stream is refused **by name**, in the
    /// domain crate, before anything is written.
    ///
    /// The digest is taken over the props as inserted, and the marker lands on
    /// that same insert — so the pair could only ever come back as "your
    /// signature does not verify", blaming the caller for a key it was never
    /// shown.
    #[test]
    fn a_signed_send_cannot_also_open_a_stream() {
        let error = rejected_signature(ProvenanceRejected::SignedStreamOpen);
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "a signed send cannot also open a stream");
    }

    /// A malformed revision is the caller's mistake, not a conflict. 409 would
    /// tell a retry loop to back off and re-send the same unusable number.
    #[test]
    fn a_bad_stream_revision_is_a_400_with_its_own_sentence() {
        let error = interaction_refusal(InteractionRefused::StreamRevInvalid);
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "stream revision must be a positive integer");
    }

    /// The slice's 200 is the same `Message` an edit answers with — an adapter
    /// parses one shape either way — and it must **not** claim `editedAt`.
    /// "수정됨" is a claim that a human revised what they said; an answer
    /// arriving is not a revision of itself.
    #[test]
    fn a_stream_slice_answers_with_a_message_that_was_never_edited() {
        let mut message = stored_message();
        message.props = serde_json::json!({ STREAM_PROPS_KEY: { "rev": 4, "streaming": true } });
        let projection = InteractionMessage {
            message,
            run_id: None,
            client_msg_id: None,
        };
        let dto = stream_message_dto(&projection);
        assert!(
            dto.edited_at_ms.is_none(),
            "a growing body has not been edited"
        );
        assert_eq!(dto.state.as_deref(), Some("sent"));
        let props = dto.props.expect("the stream marker rides the response");
        assert_eq!(props[STREAM_PROPS_KEY]["rev"], serde_json::json!(4));
        assert_eq!(
            props[STREAM_PROPS_KEY]["streaming"],
            serde_json::json!(true)
        );
    }

    /// `StreamOutcome::Stale` answers 200 with the row as it stands — the same
    /// projection an applied slice would have produced, so a retrying adapter
    /// cannot tell "I already did this" from "I just did this" and does not have
    /// to.
    #[test]
    fn a_stale_slice_still_answers_with_the_current_message() {
        let projection = InteractionMessage {
            message: stored_message(),
            run_id: None,
            client_msg_id: None,
        };
        let stale = StreamOutcome::Stale(projection.clone());
        assert!(!stale.applied(), "a stale slice wrote nothing");
        assert_eq!(
            stream_message_dto(stale.message()).id,
            stream_message_dto(&projection).id
        );
    }

    #[test]
    fn empty_props_are_omitted_from_responses() {
        assert!(response_props(&Value::Object(Map::new())).is_none());
        assert!(response_props(&serde_json::json!({"k": "v"})).is_some());
    }

    fn send_request() -> SendMessageRequest {
        SendMessageRequest {
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
            stream: None,
            harness_refine: None,
        }
    }

    fn refine_request() -> SendMessageRequest {
        let mut request = send_request();
        request.message_type = Some("system".to_string());
        request.body = Some("김인턴이 자기 작업 방식을 갱신했습니다 — 기억 1건 추가".to_string());
        request.harness_refine = Some(crate::dto::HarnessRefineRequest {
            refinement_id: "refine_20260807041452415".to_string(),
            trigger: "command".to_string(),
            scope: "workspace".to_string(),
            edits: vec![crate::dto::HarnessRefineEditRequest {
                action: "create".to_string(),
                kind: "memory".to_string(),
                id: "oort-refine-probe".to_string(),
            }],
            summary: None,
            rollback_id: None,
        });
        request.client_msg_id =
            momo_messaging::harness_refine_client_msg_id("refine_20260807041452415");
        request
    }

    /// **The list of decoded-but-unserved keys is empty, and `runId` is why.**
    ///
    /// This test used to assert the opposite for `runId` — a 400 saying "not
    /// served by momo-server yet". ADR-0158 D5 serves it, so what replaces the
    /// assertion is the shape of the new refusal: nothing is refused *here* at
    /// all, because a run binding can only be judged against tenant rows and is
    /// therefore judged inside the send transaction.
    #[test]
    fn a_run_binding_is_no_longer_refused_by_shape() {
        let mut with_run = send_request();
        with_run.run_id = Some(Uuid::nil());
        assert!(
            harness_refine(&with_run, MessageType::Text)
                .expect("no refine block, no shape refusal")
                .is_none(),
            "runId is not a pre-transaction concern; `authorize_run_binding_in_tx` owns it"
        );
    }

    /// Both halves of the binding land, because two different readers need
    /// different ones (see [`bind_run_props`]).
    #[test]
    fn a_bound_run_is_written_to_the_column_and_the_readable_copy() {
        let run = Uuid::from_u128(0x5150);
        let mut message = NewMessage::text(Uuid::from_u128(1), Uuid::from_u128(2), "답이 자");
        message.props = serde_json::json!({ "harness": "prime-agent" });
        bind_run_props(&mut message, run);

        assert_eq!(message.run_id, Some(run), "the close path reads the column");
        assert_eq!(
            message.props["run_id"],
            serde_json::json!(run.to_string()),
            "#1166's page annotation reads props"
        );
        assert_eq!(
            message.props["harness"],
            serde_json::json!("prime-agent"),
            "the producer's own props survive the stamp"
        );

        // The run id is not the caller's to override — the same rule
        // `opening_props` holds in-process.
        let mut hijacked = NewMessage::text(Uuid::from_u128(1), Uuid::from_u128(2), "답");
        hijacked.props = serde_json::json!({ "run_id": Uuid::from_u128(99).to_string() });
        bind_run_props(&mut hijacked, run);
        assert_eq!(hijacked.props["run_id"], serde_json::json!(run.to_string()));
    }

    /// ADR-0158 D2 — a refinement is a `system` line or it is nothing.
    ///
    /// Posted as `text` it would sit in the conversation as if a member had said
    /// it, which is precisely the "봇 래핑" shape the product refuses.
    #[test]
    fn a_refinement_announced_as_text_is_refused() {
        let request = refine_request();
        let refused = harness_refine(&request, MessageType::Text).expect_err("not a system line");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert!(harness_refine(&request, MessageType::System)
            .expect("system is the type D2 chose")
            .is_some());
    }

    /// §2.2 — "본문은 사람 문장, 근거는 props". A blank body would render as an
    /// empty line whose meaning lives only in an object no human reads.
    #[test]
    fn a_refinement_without_a_human_sentence_is_refused() {
        let mut request = refine_request();
        request.body = Some("   ".to_string());
        assert_eq!(
            harness_refine(&request, MessageType::System)
                .expect_err("blank body")
                .status,
            StatusCode::BAD_REQUEST
        );
        request.body = None;
        assert!(harness_refine(&request, MessageType::System).is_err());
    }

    /// **D4, at the door.** The derived key is not a suggestion: a caller that
    /// sends its own uuid is refused, and told which one this refinement has.
    ///
    /// The alternative — overwriting silently — would leave a producer holding a
    /// key that names nothing, so its retry would open a second announcement of
    /// one refinement. That is the exact duplicate D4 exists to prevent.
    #[test]
    fn a_refinement_must_be_sent_under_its_derived_key() {
        let mut request = refine_request();
        request.client_msg_id = Uuid::from_u128(0xbad);
        let refused = harness_refine(&request, MessageType::System).expect_err("wrong key");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        let expected =
            momo_messaging::harness_refine_client_msg_id("refine_20260807041452415").to_string();
        assert!(
            refused.message.contains(&expected),
            "the refusal names the key so a producer is never stuck: {}",
            refused.message
        );
    }

    /// The domain's vocabulary refusals reach the wire as 400s rather than being
    /// swallowed into a generic one — `scope: "global"` is the one that matters,
    /// because passing it through would publish a claim about other workspaces.
    #[test]
    fn a_scope_the_server_cannot_vouch_for_is_a_400() {
        let mut request = refine_request();
        if let Some(block) = request.harness_refine.as_mut() {
            block.scope = "global".to_string();
        }
        let refused = harness_refine(&request, MessageType::System).expect_err("global scope");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert!(refused.message.contains("workspace"), "{}", refused.message);
    }

    /// The server-owned key cannot be smuggled in as a flat client prop —
    /// `props_value` strips it, so `momo_messaging::refine` stays its only writer.
    #[test]
    fn a_hand_written_refine_prop_never_reaches_the_row() {
        let props = std::collections::BTreeMap::from([
            (
                HARNESS_REFINE_PROPS_KEY.to_string(),
                "{\"refinementId\":\"forged\"}".to_string(),
            ),
            ("harness".to_string(), "prime-agent".to_string()),
        ]);
        let stored = props_value(Some(&props));
        assert!(stored.get(HARNESS_REFINE_PROPS_KEY).is_none());
        assert_eq!(stored["harness"], serde_json::json!("prime-agent"));
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
        let json = serde_json::to_value(message_dto(
            &message,
            None,
            true,
            Some(&rollup),
            None,
            &[],
            false,
        ))
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
        let bare = serde_json::to_value(message_dto(&message, None, true, None, None, &[], false))
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

    fn paged(props: Value) -> PagedMessage {
        let mut message = stored_message();
        message.props = props;
        PagedMessage {
            message,
            thread: None,
            reply_to: None,
            attachments: Vec::new(),
        }
    }

    /// #1166 — the page asks about the rows whose answer can change what a
    /// reader sees, and about nothing else.
    #[test]
    fn a_page_asks_only_about_its_still_open_streams() {
        let run = Uuid::from_u128(0xa11);
        let open = serde_json::json!({
            STREAM_PROPS_KEY: { "rev": 9, "streaming": true },
            "run_id": run.to_string(),
        });
        let page = vec![
            paged(open.clone()),
            // The same run wrote more than one row; one question is asked.
            paged(open.clone()),
            paged(serde_json::json!({
                STREAM_PROPS_KEY: { "rev": 12, "streaming": false, "outcome": "cancelled" },
                "run_id": Uuid::from_u128(0xb22).to_string(),
            })),
            paged(serde_json::json!({ "source": "human" })),
        ];
        assert_eq!(open_stream_runs(&page), vec![run]);
        assert!(
            open_stream_runs(&[paged(serde_json::json!({}))]).is_empty(),
            "an ordinary page costs no second read at all"
        );
    }

    /// #1166 — the verdict is the intersection of "still open" and "the run
    /// ended", and `false` never crosses the wire.
    #[test]
    fn only_an_ended_run_marks_its_half_written_answer() {
        let ended_run = Uuid::from_u128(0xa11);
        let live_run = Uuid::from_u128(0xb22);
        let ended: HashSet<Uuid> = [ended_run].into_iter().collect();
        let open = |run: Uuid| {
            serde_json::json!({
                STREAM_PROPS_KEY: { "rev": 9, "streaming": true },
                "run_id": run.to_string(),
            })
        };

        let marked =
            serde_json::to_value(paged_dto(&paged(open(ended_run)), true, &ended)).expect("json");
        assert_eq!(marked["runEnded"], serde_json::json!(true));

        // RED proof — a run this server did not find terminal cannot be
        // announced as one. If this key ever appears here, every answer still
        // arriving in the channel gets "응답이 끊김" stapled to it.
        let live =
            serde_json::to_value(paged_dto(&paged(open(live_run)), true, &ended)).expect("json");
        assert!(live.get("runEnded").is_none(), "{live}");

        // A closed stream is self-describing; its run's state is not this
        // route's business even when the run *is* over.
        let closed = serde_json::to_value(paged_dto(
            &paged(serde_json::json!({
                STREAM_PROPS_KEY: { "rev": 12, "streaming": false, "outcome": "cancelled" },
                "run_id": ended_run.to_string(),
            })),
            true,
            &ended,
        ))
        .expect("json");
        assert!(closed.get("runEnded").is_none(), "{closed}");

        let human = serde_json::to_value(paged_dto(&paged(serde_json::json!({})), true, &ended))
            .expect("json");
        assert!(human.get("runEnded").is_none(), "{human}");
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
        let json = serde_json::to_value(message_dto(
            &message,
            None,
            true,
            None,
            Some(&quote),
            &[],
            false,
        ))
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
        let bare = serde_json::to_value(message_dto(
            &stored_message(),
            None,
            true,
            None,
            None,
            &[],
            false,
        ))
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
            false,
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
            false,
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
