//! The send composition, once (ADR-0208 D4).
//!
//! `POST …/messages`, the scheduler's timed send and "send now" all put a message
//! into a channel. Before ADR-0208 the composition lived inside the REST handler's
//! transaction closure; a second caller would have had to copy it, and a copy is a
//! quiet second implementation of the write path (it drifts the day somebody adds
//! a step to one of the two). This module is the extraction, and it is a
//! **behavior-preserving refactor**: [`deliver_message_in_tx`] is the REST
//! closure's body with the HTTP conversions moved out to the caller.
//!
//! ## What one delivery is
//!
//! In order, inside the caller's tenant transaction:
//!
//! 1. the author must still be a member of the channel (`is_channel_member`);
//! 2. a thread reply's root must be a live top-level message of that channel;
//! 3. a quoted message must live in that channel (ADR-0148 규칙 2);
//! 4. an asserted agent run must exist and be the author's (ADR-0158 D5), and is
//!    then stamped onto the row;
//! 5. an asserted provenance signature gets the key this server resolves for the
//!    author (the request never supplies it, ADR-0146);
//! 6. `send_message_with_mentions_in_tx`: `channel_seq` + message INSERT + mention
//!    pass + attachment binding + thread rollup + outbox + hosted inbox fan-out,
//!    idempotent on `(channel, author, client_msg_id)`;
//! 7. on a real insert of a non-empty text message, the mention → agent run
//!    routing ([`route_agent_mentions_in_tx`]).
//!
//! ## Refusals are values, not HTTP
//!
//! A refusal is a [`DeliverRefusal`]. REST turns each one into the exact status and
//! sentence it always answered ([`crate::routes::messages`]); the scheduler turns
//! each one into a `failure_reason` ([`crate::scheduler`]). Both callers must
//! **roll back** (or roll back to a savepoint) on a refusal: the refusals of steps
//! 6 and 7 arrive after the message row was inserted, and a refusal that committed
//! would leave a message nobody was told about.
//!
//! The REST-only extras stay in the REST handler: the harness-refine audit row
//! (ADR-0158 D3) is written after this function returns, in the same transaction.

use axum::http::StatusCode;
use momo_agent::{authorize_run_binding_in_tx, RequestedRouting, RunBindingRejected};
use momo_db::{DbError, PgConnection};
use momo_messaging::{
    is_channel_member, resolve_member_signing_key, send_message_with_mentions_via_in_tx,
    validate_quote_target_in_tx, validate_thread_root_in_tx, MessageSignature, MessageType,
    NewMessage, QuoteTargetInvalid, SendExtras, SendRejected, SentMessage, SentVia,
    ThreadRootInvalid,
};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::routes::agent_mentions::{route_agent_mentions_in_tx, MentionSend};
use crate::AppState;

/// The props key that carries an agent run's id for readers (#1166).
///
/// Not in the server-owned key list, and the asymmetry is deliberate. A producer
/// that names its run in props without sending `runId` is the pre-ADR-0158 shape
/// and still works unchanged — stripping it would break every adapter written
/// against the wire as it stood. What ADR-0158 adds is that when a **validated**
/// `runId` *is* sent, the server writes this key from it, so the column and the
/// readable copy cannot disagree. See [`bind_run_props`].
const RUN_ID_PROPS_KEY: &str = "run_id";

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

/// The switches the mention pass reads, taken from [`AppState`] once per
/// delivery. Owned (not borrowed) so a request can be moved into a transaction
/// closure.
#[derive(Debug, Clone)]
pub(crate) struct DeliverGates {
    /// `AgentGatewaySettings::enabled` — the instance-global provider mode.
    pub gateway_enabled: bool,
    /// ADR-0162 HAP-E5's per-agent hosted selector production gate.
    pub hosted_delivery_enabled: bool,
    pub subscription_agents_enabled: bool,
    pub claude_subscription_agents_enabled: bool,
    /// #3948: the operator's attestation, an env value read once per delivery.
    pub connector_trial: momo_agent::ConnectorTrialAttest,
    pub context_max_messages: i64,
    pub inplace_grant_enabled: bool,
}

impl DeliverGates {
    /// The gates as the REST send has always read them: `AppState`, nothing else.
    pub(crate) fn from_state(state: &AppState) -> Self {
        DeliverGates {
            gateway_enabled: state.agent_gateway.enabled(),
            // ADR-0162 HAP-E5: the per-agent hosted selector's production gate,
            // read beside the instance-global provider mode precisely so the two
            // stay visibly independent knobs rather than one.
            hosted_delivery_enabled: state.agent_port.config.hosted_delivery_enabled,
            subscription_agents_enabled: state.agent_port.config.subscription_agents_enabled,
            claude_subscription_agents_enabled: state
                .agent_port
                .config
                .claude_subscription_agents_enabled,
            connector_trial: state.cohosted.config.attest(),
            context_max_messages: state.mentions.context_max_messages,
            inplace_grant_enabled: state.mentions.hosted_inplace_grant_enabled,
        }
    }
}

/// One delivery's inputs.
pub(crate) struct DeliverRequest {
    pub workspace_id: Uuid,
    /// The row to write. `author_member_id` is the sender, `props` has already had
    /// every server-owned key stripped, and `run_id` is `None` (it is stamped here,
    /// after the run binding has been authorized).
    pub message: NewMessage,
    /// ADR-0158 D5 — the run the sender asserts, if any.
    pub requested_run_id: Option<Uuid>,
    /// ADR-0146 — the base64 signature the sender asserts, if any. The signing key
    /// is resolved by [`deliver_message_in_tx`], never supplied.
    pub signature_b64: Option<String>,
    /// ADR-0151 — attachments to bind. Empty is the unchanged path.
    pub attachment_ids: Vec<Uuid>,
    pub via_token_id: Option<Uuid>,
    /// #1173 — this send opens a growing answer.
    pub opens_stream: bool,
    /// Derived from the sender: `true` when the send came in on an agent. The
    /// mention pass reads both, and **both are needed**: `author_is_human` is not
    /// `!author_is_agent` (a work host is neither), and the in-place channel-grant
    /// card (ADR-0162 증보 5 G1) is raised for a person's explicit call only.
    pub author_is_agent: bool,
    pub author_is_human: bool,
    /// ADR-0134 D1's per-request tier, already shape-validated before the
    /// transaction opened. `None` = the sender chose nothing.
    pub requested_routing: Option<RequestedRouting>,
    /// ADR-0113 증보 3 F5 (#4313): the distinct app ids the sender picked
    /// ([`crate::routes::requested_apps::normalize`]), **already stamped** into
    /// `message.props.requestedApps`. Judged here, after the insert and only when it
    /// was new; empty for every sender that picked none (and for the scheduler).
    pub requested_apps: Vec<String>,
    /// ADR-0148 증보 (#4887) — the sender chose 「대화에도 보내기」. Already shape-checked by the
    /// REST route (a 400 without `rootId`); passed on as [`SendExtras::also_in_channel`], where the
    /// table's CHECK is the second layer. `false` for the scheduler, whose timed send carries no
    /// such choice yet.
    pub also_in_channel: bool,
    /// ADR-0170 증보 2026-11-01 D21 (#4884) — 「미리보기 없이 보내기」: plant the message's unfurl
    /// tombstone in this transaction, on a real insert only (a `deduped` retry answers the stored
    /// message). `false` for the scheduler, whose timed send carries no such choice yet.
    pub suppress_unfurl: bool,
    pub gates: DeliverGates,
}

/// Why a delivery was refused. The variants are the REST handler's old refusal
/// branches, one for one; **no HTTP type appears here**.
#[derive(Debug)]
pub(crate) enum DeliverRefusal {
    /// The author is not (or no longer) a current member of the channel.
    NotMember,
    /// The thread root is missing, deleted or not a top-level message.
    ThreadRoot(ThreadRootInvalid),
    /// The quoted message is missing from this channel or deleted (ADR-0148).
    QuoteTarget(QuoteTargetInvalid),
    /// The asserted run is unknown or not the author's (ADR-0158 D5).
    RunBinding(RunBindingRejected),
    /// A signature was asserted but this server holds no signing key for the author.
    NoSigningKey,
    /// The send spine refused: a provenance assertion or an attachment binding.
    /// Arrives **after** the message insert.
    Send(SendRejected),
    /// The sender's own `routing` block was refused (ADR-0134 D1): the sentence the
    /// 400 carries. Arrives **after** the message insert.
    Routing(String),
    /// The sender's `apps` were refused (ADR-0113 증보 3 F5): one coded 400,
    /// `apps_unavailable`. Arrives **after** the message insert, and only for a new
    /// insert (a `deduped` retry is never judged).
    Apps(crate::routes::requested_apps::AppsRefusal),
}

/// Put one message into a channel, exactly as `POST …/messages` always did.
///
/// A refusal travels in the `Ok` half; see the module docs for what the caller must
/// do with it (roll back).
pub(crate) async fn deliver_message_in_tx(
    conn: &mut PgConnection,
    request: DeliverRequest,
) -> Result<Result<SentMessage, DeliverRefusal>, DbError> {
    deliver_message_via_in_tx(conn, request, None).await
}

/// [`deliver_message_in_tx`], stamping **how** the message was sent (`message.sent_via`,
/// ADR-0216 D8 · R12, #4660).
///
/// `sent_via` is a parameter beside the request rather than a field of
/// [`DeliverRequest`] so the scheduler — which builds that request too, and is never a
/// developer token — cannot be asked to have an opinion about it. The REST send passes
/// `Some(SentVia::Dev)` exactly when the request was authenticated by a developer token
/// (the [`crate::dev_credential::DevCredential`] marker only the auth middleware
/// inserts), and nothing in the request body can choose it.
pub(crate) async fn deliver_message_via_in_tx(
    conn: &mut PgConnection,
    request: DeliverRequest,
    sent_via: Option<SentVia>,
) -> Result<Result<SentMessage, DeliverRefusal>, DbError> {
    let DeliverRequest {
        workspace_id,
        mut message,
        requested_run_id,
        signature_b64,
        attachment_ids,
        via_token_id,
        opens_stream,
        author_is_agent,
        author_is_human,
        requested_routing,
        requested_apps,
        also_in_channel,
        suppress_unfurl,
        gates,
    } = request;
    let channel_id = message.channel_id;
    let author_member_id = message.author_member_id;
    let root_id = message.root_id;
    let reply_to_id = message.reply_to_id;
    let message_type = message.message_type;
    // The text the mention pass parses. Cloned because `message` is consumed by the
    // send below and the routing needs the same text after it.
    let mention_body = message.body.clone().unwrap_or_default();

    if !is_channel_member(conn, channel_id, author_member_id).await? {
        return Ok(Err(DeliverRefusal::NotMember));
    }
    // The reply target has to exist before the message can be written against it.
    if let Some(root_id) = root_id {
        if let Err(invalid) = validate_thread_root_in_tx(conn, channel_id, root_id).await? {
            return Ok(Err(DeliverRefusal::ThreadRoot(invalid)));
        }
    }
    // ADR-0148 규칙 2 — the quote target must live in THIS channel, and the check
    // runs inside the tenant transaction because that is what makes it a tenant
    // check too: a target in another workspace is invisible under RLS here, so it
    // resolves as missing rather than as a message someone can confirm the
    // existence of. Checked independently of `root_id` — 규칙 1 lets a message
    // carry both, so an `else` here would silently skip the check for every
    // threaded quote.
    if let Some(reply_to_id) = reply_to_id {
        if let Err(invalid) = validate_quote_target_in_tx(conn, channel_id, reply_to_id).await? {
            return Ok(Err(DeliverRefusal::QuoteTarget(invalid)));
        }
    }
    // ADR-0158 D5 — fail-closed, inside this transaction and not before it. The
    // check is a tenant read (`agent_run` under RLS), so hoisting it out of the
    // transaction that writes the message would both lose the GUC and open a
    // window in which a run could be created, cancelled or moved between the
    // check and the insert.
    if let Some(run_id) = requested_run_id {
        if let Err(rejected) =
            authorize_run_binding_in_tx(conn, workspace_id, run_id, author_member_id).await?
        {
            return Ok(Err(DeliverRefusal::RunBinding(rejected)));
        }
        bind_run_props(&mut message, run_id);
    }
    let signature = match signature_b64 {
        None => None,
        Some(signature_b64) => {
            // The key is the server's to resolve, never the request's to assert.
            let Some(signer_pubkey_b64) =
                resolve_member_signing_key(conn, author_member_id).await?
            else {
                return Ok(Err(DeliverRefusal::NoSigningKey));
            };
            Some(MessageSignature {
                signer_member_id: author_member_id,
                signer_pubkey_b64,
                signature_b64,
            })
        }
    };
    let sent = match send_message_with_mentions_via_in_tx(
        conn,
        workspace_id,
        message,
        SendExtras {
            signature: signature.as_ref(),
            attachment_ids: &attachment_ids,
            via_token_id,
            opens_stream,
            subscription_agents_disabled: !gates.subscription_agents_enabled,
            claude_subscription_agents_disabled: !gates.claude_subscription_agents_enabled,
            also_in_channel,
        },
        sent_via,
    )
    .await?
    {
        Ok(sent) => sent,
        Err(rejected) => return Ok(Err(DeliverRefusal::Send(rejected))),
    };

    // ADR-0170 증보 2026-11-01 D21 (#4884) — 「미리보기 없이 보내기」. The author's own choice,
    // written in the transaction that writes the message and **only for a real insert** (a retry
    // is not a second chance to decide). The tombstone is the row the unfurl worker already looks
    // for before it fetches anything, so the message simply never gets cards; the trigger still
    // queues its job and the worker ends it as `skipped`. Nothing else about the send changes.
    if !sent.deduped && suppress_unfurl {
        momo_unfurl::plant_tombstone_in_tx(conn, workspace_id, sent.message.id, author_member_id)
            .await?;
    }

    // ADR-0113 증보 3 F5 (#4313) — the sender's `apps`, judged in THIS transaction and **only on a
    // real insert**: a `deduped` retry answers the stored message (201) whatever `apps` says now,
    // so an app uninstalled after the first request cannot turn a harmless retry into a refusal
    // that invites a duplicate send. The refusal rolls the insert back with it, and it comes
    // before the mention pass so a refused chip queues no run. Nothing below reads the marker.
    if !sent.deduped && !requested_apps.is_empty() {
        if let Err(refusal) = crate::routes::requested_apps::judge_in_tx(
            conn,
            workspace_id,
            author_is_human,
            &requested_apps,
        )
        .await?
        {
            return Ok(Err(DeliverRefusal::Apps(refusal)));
        }
    }

    // B5.2 — mention → agent run, in THIS transaction and only on a real insert.
    // Swift's guard is the same three conditions (`MessageRoutes.swift:284`, `if
    // didInsert, type == "text", let body`) and each one earns its place: a deduped
    // retry must not queue a second turn, a non-text message has no `@handle` to
    // parse, and an empty body cannot mention anyone. The run is enqueued after the
    // broadcast so `props.mention_member_ids` — the human-facing half of the same
    // decision — is already on the row it describes.
    if !sent.deduped && message_type == MessageType::Text && !mention_body.is_empty() {
        // A refused `routing` block rolls the send back with it (Swift :1976-1981):
        // the caller chose a model this workspace does not permit, and delivering
        // the message under a different one would substitute the single decision
        // they made explicitly.
        if let Err(rejection) = route_agent_mentions_in_tx(
            conn,
            MentionSend {
                workspace_id,
                channel_id,
                message_id: sent.message.id,
                message_seq: sent.message.seq,
                root_id: sent.message.root_id,
                author_member_id,
                author_is_agent,
                author_is_human,
                body: &mention_body,
                hlc_ts: sent.message.hlc_ts,
                via_token_id,
                gateway_enabled: gates.gateway_enabled,
                hosted_delivery_enabled: gates.hosted_delivery_enabled,
                subscription_agents_enabled: gates.subscription_agents_enabled,
                claude_subscription_agents_enabled: gates.claude_subscription_agents_enabled,
                connector_trial: &gates.connector_trial,
                context_max_messages: gates.context_max_messages,
                inplace_grant_enabled: gates.inplace_grant_enabled,
                routing: requested_routing.as_ref(),
            },
        )
        .await?
        {
            // The mention pass has exactly one refusal: the sender's own `routing`
            // block, always a 400 (`agent_mentions.rs`, both `Ok(Err(..))` sites).
            debug_assert_eq!(rejection.status, StatusCode::BAD_REQUEST);
            return Ok(Err(DeliverRefusal::Routing(rejection.message)));
        }
    }
    Ok(Ok(sent))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
