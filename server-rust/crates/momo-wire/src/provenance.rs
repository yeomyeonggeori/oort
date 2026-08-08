//! Action provenance — ADR-0146 (**Accepted** 2026-07-31), migration 060.
//!
//! momo takes exactly one thing from buzz(Nostr): **an action can carry an
//! Ed25519 signature that proves who asserted it**. It takes none of the rest —
//! a signature here is *metadata*, never authority. The actor signs; the server
//! verifies; the server is still the sole author of every row; the signature
//! lands in the `action_signature` sidecar in the same transaction as the domain
//! write. D2 cross-check in `060_action_signature.sql`.
//!
//! ## The chokepoint rule
//!
//! [`record_provenance`] is the **only** function in the workspace that names
//! `action_signature` in SQL — the provenance twin of `momo_outbox::emit_outbox`.
//! Verification lives inside it, so there is no call shape that writes a
//! signature without checking it first: a bad signature is a rejected write, not
//! a stored lie.
//!
//! ## Two-stage signing (ADR-0146 decision ①), and why stage 2 is not a signature
//!
//! An actor cannot sign `message.id` or `message.seq` — the server assigns them
//! after the actor is done. So:
//!
//! * **Stage 1 (actor).** The actor signs *content*: the bytes defined by
//!   [`SignedAction::signed_bytes`], all of which the actor knows before the
//!   write. Those exact bytes are what `signature` covers and what
//!   `signed_payload_digest` hashes, so an auditor can re-derive and re-verify
//!   them later.
//! * **Stage 2 (server).** The server does **not** counter-sign. It has no key,
//!   and minting one would create the key-management surface ADR-0146 explicitly
//!   did not authorize. The binding between the stage-1 signature and the
//!   server-assigned identifiers *is the `action_signature` row*:
//!   `(entity_type, entity_id)` names what the server assigned, and append-only
//!   + RLS FORCE is what defends that binding afterwards.
//!
//! ## Replay and forgery boundary (what a signature does and does not prove)
//!
//! Proved: the holder of `signer_pubkey`'s private half asserted **these bytes**,
//! and those bytes name the workspace, the actor, and the target the action
//! belongs to — so a signature cannot be lifted into another workspace, another
//! channel, or another author.
//!
//! Not proved: *when*. `created_at` is the server's clock, not the actor's.
//! Freshness is each surface's own affair and is unchanged by this module — the
//! work-host surfaces already carry `sentAtMs` inside the signed bytes plus the
//! ±5-minute skew window (and, for v2, one-time `requestID` consumption); the
//! message surface binds the actor's own `client_msg_id`, which the write path's
//! `(channel_id, author_member_id, client_msg_id)` uniqueness already collapses,
//! so a replayed message signature can only ever re-attach to the one message it
//! was made for.
//!
//! Not granted: anything. A valid signature opens no write path (D2).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::signing::{heartbeat_payload, request_payload, sha256_hex, verify_base64};

/// Schema tag for the one signing payload this ADR had to invent
/// (`momo.provenance.<surface>.v1`, following the workd `momo.<area>.<event>.vN`
/// convention). The two work-host surfaces reuse the formats workd **already**
/// signs — inventing a parallel format for them would mean changing the daemon,
/// and a second format over the same act is a drift surface, not a feature.
pub const MESSAGE_SCHEMA_V1: &str = "momo.provenance.message.v1";

/// `entity_type` for a signed work-host heartbeat; `entity_id` = the host id.
pub const ENTITY_WORK_HOST_HEARTBEAT: &str = "work_host.heartbeat";
/// `entity_type` for a signed terminal-attach validation; `entity_id` = the work
/// session whose attach was validated.
pub const ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE: &str = "work_host.terminal_attach_validate";
/// `entity_type` for a signed message; `entity_id` = the `message.id`.
pub const ENTITY_MESSAGE: &str = "message";

/// What a provenance signature is bound to: the server-assigned identity of the
/// thing that was done (stage 2 — see the module docs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRef {
    /// One of the `ENTITY_*` constants. Migration 060 constrains the grammar
    /// (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, ≤64) but not the vocabulary, so
    /// a new surface needs no migration.
    pub kind: String,
    /// The id of the row the action produced or acted on.
    pub id: Uuid,
}

impl EntityRef {
    pub fn new(kind: impl Into<String>, id: Uuid) -> Self {
        EntityRef {
            kind: kind.into(),
            id,
        }
    }
}

/// The signer, as the **server** resolved it — never as the caller asserted it.
///
/// `pubkey_b64` must come from a server-side registry (`work_host.public_key`
/// today), because a client-supplied key verifies its own signature and proves
/// nothing. [`record_provenance`] cannot enforce that by type, so it is stated
/// here and held at every call site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signer {
    /// Base64 32-byte Ed25519 public key.
    pub pubkey_b64: String,
    /// The member behind the key, when the signer *is* a member. `None` for a
    /// work host: a host is not a member, and writing its owner here would
    /// record that the owner signed — the same false attribution that
    /// `audit_log.via_token_id` refuses (see 060's header).
    pub member_id: Option<Uuid>,
}

impl Signer {
    /// A work host: identified by its stored key, attributed to no member.
    pub fn work_host(pubkey_b64: impl Into<String>) -> Self {
        Signer {
            pubkey_b64: pubkey_b64.into(),
            member_id: None,
        }
    }

    /// A member (agent today, human once device keys land).
    pub fn member(pubkey_b64: impl Into<String>, member_id: Uuid) -> Self {
        Signer {
            pubkey_b64: pubkey_b64.into(),
            member_id: Some(member_id),
        }
    }
}

/// The message content an actor signs, before the server assigns `id`/`seq`.
///
/// Every field is something the sender chose. `props` is the **stored** props
/// object serialized canonically (sorted keys — `serde_json::Map` is a `BTreeMap`
/// in this build), i.e. after the server strips its own keys: a client that signs
/// over a `mention_member_ids` it tried to supply will fail verification, which
/// is the correct visible outcome rather than a silently divergent digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageContent<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    /// The sender's own idempotency key — the message surface's replay binding.
    pub client_msg_id: Uuid,
    /// `message_type` DB label (`text`, `tool_call`, …).
    pub message_type: &'a str,
    /// The body exactly as it will be stored. `None` (absent) and `Some("")`
    /// (present but empty) are different rows and are different bytes here.
    pub body: Option<&'a str>,
    /// Canonical JSON of the stored `props` object (`{}` when empty).
    pub props_json: &'a str,
}

/// One signable action, and — decisively — *which bytes* its signature covers.
///
/// Keeping the three surfaces in one enum is the point: "what does a momo
/// signature sign?" has exactly one answer per surface and it is readable here,
/// not scattered across three route files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignedAction<'a> {
    /// The heartbeat workd already signs: `momo.work_host.heartbeat.v1`.
    WorkHostHeartbeat {
        workspace_id: Uuid,
        host_id: Uuid,
        sent_at_ms: i64,
    },
    /// The signed request workd already makes: `momo.work_host.request.v2`
    /// (binds method, path, workspace, host, clock, **raw body digest**, and the
    /// one-time request id).
    WorkHostRequest {
        method: &'a str,
        path: &'a str,
        workspace_id: Uuid,
        host_id: Uuid,
        sent_at_ms: i64,
        /// Lowercase hex SHA-256 of the raw body (see [`sha256_hex`]).
        body_digest: &'a str,
        request_id: Uuid,
    },
    /// A message, over the format this ADR introduces.
    Message(MessageContent<'a>),
}

impl SignedAction<'_> {
    /// The exact bytes the signature covers (stage 1).
    ///
    /// `momo.provenance.message.v1`, UTF-8, `\n`-joined, in this order:
    ///
    /// ```text
    /// momo.provenance.message.v1
    /// {workspace_id}
    /// {channel_id}
    /// {author_member_id}
    /// {client_msg_id}
    /// {message_type}
    /// {body_digest}
    /// {props_digest}
    /// ```
    ///
    /// UUIDs render lowercase-hyphenated (Rust `Uuid` `Display` == Swift
    /// `uuidString.lowercased()`, the convention `signing.rs` already ports).
    /// `body_digest` is the lowercase hex SHA-256 of the body's UTF-8 bytes, or
    /// the single character `-` when the body is absent — unambiguous, because a
    /// digest is always 64 hex characters. `props_digest` is the lowercase hex
    /// SHA-256 of the canonical props JSON.
    pub fn signed_bytes(&self) -> Vec<u8> {
        match self {
            SignedAction::WorkHostHeartbeat {
                workspace_id,
                host_id,
                sent_at_ms,
            } => heartbeat_payload(*workspace_id, *host_id, *sent_at_ms),
            SignedAction::WorkHostRequest {
                method,
                path,
                workspace_id,
                host_id,
                sent_at_ms,
                body_digest,
                request_id,
            } => request_payload(
                method,
                path,
                *workspace_id,
                *host_id,
                *sent_at_ms,
                body_digest,
                *request_id,
            ),
            SignedAction::Message(content) => {
                let body_digest = match content.body {
                    Some(body) => sha256_hex(body.as_bytes()),
                    None => "-".to_string(),
                };
                let props_digest = sha256_hex(content.props_json.as_bytes());
                format!(
                    "{MESSAGE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{body_digest}\n{props_digest}",
                    content.workspace_id,
                    content.channel_id,
                    content.author_member_id,
                    content.client_msg_id,
                    content.message_type,
                )
                .into_bytes()
            }
        }
    }

    /// The `entity_type` this surface records under.
    pub fn entity_type(&self) -> &'static str {
        match self {
            SignedAction::WorkHostHeartbeat { .. } => ENTITY_WORK_HOST_HEARTBEAT,
            SignedAction::WorkHostRequest { .. } => ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE,
            SignedAction::Message(_) => ENTITY_MESSAGE,
        }
    }

    /// Lowercase hex SHA-256 of [`Self::signed_bytes`] — the value stored in
    /// `action_signature.signed_payload_digest`.
    pub fn signed_payload_digest(&self) -> String {
        sha256_hex(&self.signed_bytes())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProvenanceError {
    /// The signature did not verify over the action's bytes under the resolved
    /// key. The caller must refuse the whole write: a rejected signature is not
    /// a recordable event, it is a failed request.
    #[error("provenance signature does not verify for {entity_type} {entity_id}")]
    SignatureRejected {
        entity_type: String,
        entity_id: Uuid,
    },
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// The result of recording — explicit, because "already there" is a normal
/// outcome (a retried heartbeat, a re-presented request) and not a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// A new `action_signature` row, with its id.
    Recorded(Uuid),
    /// This exact signature was already recorded in this tenant; the id is the
    /// standing row's. `action_signature_signature_uniq` is what makes this
    /// idempotent instead of duplicative.
    AlreadyRecorded(Uuid),
}

impl Provenance {
    pub fn id(self) -> Uuid {
        match self {
            Provenance::Recorded(id) | Provenance::AlreadyRecorded(id) => id,
        }
    }
}

/// Verify a provenance signature and record it — the **only** `action_signature`
/// SQL in the workspace (the provenance twin of `emit_outbox`).
///
/// Call it on the caller's tenant connection, inside the same transaction as the
/// domain write it describes (`momo_db::with_tenant_tx`), so the action and the
/// proof of who asserted it commit or roll back together. RLS FORCE rejects a
/// `workspace_id` other than the transaction's GUC, which is the backstop that
/// keeps a signature inside the tenant it belongs to.
///
/// `signer.pubkey_b64` must be the **server-resolved** key (see [`Signer`]).
/// Verification happens before the insert, so a forged or tampered signature
/// never reaches the table — that is conformance red ①.
pub async fn record_provenance(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    entity: &EntityRef,
    signer: &Signer,
    signature_b64: &str,
    action: &SignedAction<'_>,
) -> Result<Provenance, ProvenanceError> {
    let signed_bytes = action.signed_bytes();
    if !verify_base64(&signer.pubkey_b64, signature_b64, &signed_bytes) {
        return Err(ProvenanceError::SignatureRejected {
            entity_type: entity.kind.clone(),
            entity_id: entity.id,
        });
    }
    let digest = sha256_hex(&signed_bytes);

    // ON CONFLICT DO NOTHING, never DO UPDATE: the append-only trigger refuses
    // every UPDATE, so an upsert would turn a duplicate presentation into a
    // raised exception instead of a no-op.
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO action_signature \
           (workspace_id, entity_type, entity_id, signer_member_id, \
            signer_pubkey, signature, signed_payload_digest) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (workspace_id, signature) DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(&entity.kind)
    .bind(entity.id)
    .bind(signer.member_id)
    .bind(&signer.pubkey_b64)
    .bind(signature_b64)
    .bind(&digest)
    .fetch_optional(&mut *conn)
    .await?;

    if let Some(id) = inserted {
        return Ok(Provenance::Recorded(id));
    }

    let existing: Uuid =
        sqlx::query("SELECT id FROM action_signature WHERE workspace_id = $1 AND signature = $2")
            .bind(workspace_id)
            .bind(signature_b64)
            .fetch_one(&mut *conn)
            .await?
            .try_get("id")?;
    Ok(Provenance::AlreadyRecorded(existing))
}

/// Base64 of a raw 64-byte signature, in the exact spelling migration 060's
/// `action_signature_signature_ck` accepts. Callers that already hold a base64
/// signature from the wire pass it straight through; this exists for signers.
pub fn signature_base64(signature: &[u8; 64]) -> String {
    BASE64.encode(signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::{sign, verify};
    use ed25519_dalek::SigningKey;

    const SEED: [u8; 32] = [11u8; 32];

    fn content<'a>(body: Option<&'a str>, props: &'a str) -> MessageContent<'a> {
        MessageContent {
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            author_member_id: Uuid::from_u128(3),
            client_msg_id: Uuid::from_u128(4),
            message_type: "text",
            body,
            props_json: props,
        }
    }

    #[test]
    fn message_bytes_are_the_documented_eight_lines() {
        let action = SignedAction::Message(content(Some("hi"), "{}"));
        let bytes = action.signed_bytes();
        let text = String::from_utf8(bytes).expect("UTF-8");
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines.len(), 8, "schema + 5 ids + 2 digests");
        assert_eq!(lines[0], MESSAGE_SCHEMA_V1);
        assert_eq!(lines[1], Uuid::from_u128(1).to_string());
        assert_eq!(lines[2], Uuid::from_u128(2).to_string());
        assert_eq!(lines[3], Uuid::from_u128(3).to_string());
        assert_eq!(lines[4], Uuid::from_u128(4).to_string());
        assert_eq!(lines[5], "text");
        assert_eq!(lines[6], sha256_hex(b"hi"));
        assert_eq!(lines[7], sha256_hex(b"{}"));
        // Lowercase-hyphenated, matching Swift `uuidString.lowercased()`.
        assert!(lines[1].chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn an_absent_body_is_not_an_empty_body() {
        let absent = SignedAction::Message(content(None, "{}")).signed_bytes();
        let empty = SignedAction::Message(content(Some(""), "{}")).signed_bytes();
        assert_ne!(
            absent, empty,
            "NULL body and '' are different rows, so they must be different bytes"
        );
        let text = String::from_utf8(absent).unwrap();
        assert_eq!(text.split('\n').nth(6).unwrap(), "-");
    }

    /// Every field on the line is inside the signature: flipping any one of them
    /// must invalidate it. This is the forgery boundary, asserted rather than
    /// asserted-in-prose.
    #[test]
    fn every_signed_field_is_load_bearing() {
        let base = content(Some("hi"), "{}");
        let bytes = SignedAction::Message(base.clone()).signed_bytes();
        let signature = sign(&SEED, &bytes).expect("sign");
        let public = SigningKey::from_bytes(&SEED).verifying_key().to_bytes();
        assert!(verify(&public, &bytes, &signature));

        let mutations: Vec<MessageContent<'_>> = vec![
            MessageContent {
                workspace_id: Uuid::from_u128(99),
                ..base.clone()
            },
            MessageContent {
                channel_id: Uuid::from_u128(99),
                ..base.clone()
            },
            MessageContent {
                author_member_id: Uuid::from_u128(99),
                ..base.clone()
            },
            MessageContent {
                client_msg_id: Uuid::from_u128(99),
                ..base.clone()
            },
            MessageContent {
                message_type: "system",
                ..base.clone()
            },
            MessageContent {
                body: Some("hi!"),
                ..base.clone()
            },
            MessageContent {
                props_json: r#"{"k":"v"}"#,
                ..base.clone()
            },
        ];
        for mutated in mutations {
            let other = SignedAction::Message(mutated).signed_bytes();
            assert!(
                !verify(&public, &other, &signature),
                "a signature must not survive a changed field"
            );
        }
    }

    /// The two work-host surfaces must be byte-identical to what workd already
    /// signs — a divergence here would silently reject every real daemon.
    #[test]
    fn work_host_surfaces_reuse_the_existing_workd_formats() {
        let ws = Uuid::from_u128(1);
        let host = Uuid::from_u128(2);
        let heartbeat = SignedAction::WorkHostHeartbeat {
            workspace_id: ws,
            host_id: host,
            sent_at_ms: 1_730_000_000_000,
        };
        assert_eq!(
            heartbeat.signed_bytes(),
            heartbeat_payload(ws, host, 1_730_000_000_000)
        );

        let request_id = Uuid::from_u128(5);
        let digest = sha256_hex(b"{}");
        let request = SignedAction::WorkHostRequest {
            method: "POST",
            path: "/v1/x",
            workspace_id: ws,
            host_id: host,
            sent_at_ms: 1_730_000_000_000,
            body_digest: &digest,
            request_id,
        };
        assert_eq!(
            request.signed_bytes(),
            request_payload(
                "POST",
                "/v1/x",
                ws,
                host,
                1_730_000_000_000,
                &digest,
                request_id
            )
        );
    }

    #[test]
    fn entity_types_match_the_060_grammar() {
        let grammar = |value: &str| {
            value.len() <= 64
                && value.split('.').all(|part| {
                    !part.is_empty()
                        && part.starts_with(|c: char| c.is_ascii_lowercase())
                        && part
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                })
        };
        for entity_type in [
            ENTITY_WORK_HOST_HEARTBEAT,
            ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE,
            ENTITY_MESSAGE,
        ] {
            assert!(
                grammar(entity_type),
                "{entity_type} must satisfy action_signature_entity_type_ck"
            );
        }
    }

    #[test]
    fn a_signature_renders_in_the_spelling_the_check_constraint_accepts() {
        let bytes = SignedAction::Message(content(Some("hi"), "{}")).signed_bytes();
        let signature = signature_base64(&sign(&SEED, &bytes).expect("sign"));
        assert_eq!(signature.len(), 88, "64 raw bytes → 86 chars + '=='");
        assert!(signature.ends_with("=="));
        assert!(signature[..86]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/'));
    }

    #[test]
    fn the_recorded_digest_is_of_the_signed_bytes_not_the_envelope() {
        let action = SignedAction::Message(content(Some("hi"), "{}"));
        assert_eq!(
            action.signed_payload_digest(),
            sha256_hex(&action.signed_bytes()),
            "an auditor rebuilds the bytes and re-hashes; anything else is unverifiable"
        );
    }
}
