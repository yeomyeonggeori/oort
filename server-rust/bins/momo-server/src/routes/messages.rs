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
    clamp_history_limit, is_channel_member, list_channel_page, resolve_member_signing_key,
    send_message_with_mentions_in_tx, HistoryCursor, MessageSignature, MessageType, NewMessage,
    ProvenanceRejected, StoredMessage,
};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::dto::{HistoryQuery, MessageDto, MessagePage, SendMessageRequest};
use crate::error::{db_error, ApiError};
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

fn message_dto(
    message: &StoredMessage,
    client_msg_id: Option<Uuid>,
    include_state: bool,
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
    }
}

/// Reject the request keys this batch does not serve. Visible failure beats a
/// silently dropped attachment/thread/routing intent (ADR-0134 D1 reasoning).
fn reject_unsupported(request: &SendMessageRequest) -> Result<(), ApiError> {
    let unsupported = if request.root_id.is_some() {
        Some("rootId (thread replies)")
    } else if request.run_id.is_some() {
        Some("runId (agent-run binding)")
    } else if request
        .attachment_ids
        .as_ref()
        .is_some_and(|ids| !ids.is_empty())
    {
        Some("attachmentIds")
    } else if request.routing.is_some() {
        Some("routing")
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
    let new_message = NewMessage {
        channel_id,
        author_member_id: principal.member_id,
        message_type,
        body: request.body.clone(),
        props: props_value(request.props.as_ref()),
        root_id: None,
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
            match send_message_with_mentions_in_tx(
                conn,
                workspace_id,
                new_message,
                signature.as_ref(),
            )
            .await?
            {
                Ok(sent) => Ok(Some(sent)),
                Err(rejected) => Err(SendFailure::Rejected(rejected_signature(rejected))),
            }
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
        Json(message_dto(&sent.message, Some(client_msg_id), false)),
    ))
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
    let next_before = messages.iter().map(|message| message.seq).min();

    Ok(Json(MessagePage {
        messages: messages
            .iter()
            .map(|message| message_dto(message, None, true))
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

        let mut threaded = base();
        threaded.root_id = Some(Uuid::nil());
        assert_eq!(
            reject_unsupported(&threaded).expect_err("threads").status,
            StatusCode::BAD_REQUEST
        );

        let mut with_run = base();
        with_run.run_id = Some(Uuid::nil());
        assert!(reject_unsupported(&with_run).is_err());

        let mut with_attachments = base();
        with_attachments.attachment_ids = Some(vec![Uuid::nil()]);
        assert!(reject_unsupported(&with_attachments).is_err());

        // An empty array carries no intent → not an error.
        let mut empty_attachments = base();
        empty_attachments.attachment_ids = Some(vec![]);
        assert!(reject_unsupported(&empty_attachments).is_ok());

        let mut with_routing = base();
        with_routing.routing = Some(serde_json::json!({"model": "x"}));
        assert!(reject_unsupported(&with_routing).is_err());
    }
}
