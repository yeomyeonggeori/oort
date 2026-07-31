//! `momo-messaging` — the messenger domain crate (ADR-0145 B안, batch B1).
//!
//! This crate is the **write-path spine**: the minimal identity + channel
//! surface the message write path requires, and the write path itself. It leans
//! entirely on the B0 shared infrastructure and never re-implements it:
//!
//! * RLS is wired only through [`momo_db::with_tenant_tx`] (invariant #6) — no
//!   query here sets `app.workspace_id` on its own.
//! * The outbox is written only through [`momo_outbox::emit_outbox`] (invariant
//!   #3) — this crate owns no `INSERT INTO outbox`.
//! * The broadcast payload uses the shared [`momo_wire::payload::BroadcastPayload`]
//!   DTO so server and relay/workd cannot drift.
//!
//! The invariant-bearing entry point is [`message::send_message`]; see that
//! module for the step-by-step mapping to Swift `MessageRoutes.swift:123-282`.
//!
//! * Action provenance is written only through [`momo_wire::record_provenance`]
//!   (ADR-0146, B2.5) — this crate owns no `INSERT INTO action_signature`, the
//!   same discipline it holds for the outbox. [`message::send_signed_message_in_tx`]
//!   is the signed twin of the spine; the unsigned path is untouched.
//!
//! **B1.2 adds the messenger's breadth** on top of that spine — [`dm`],
//! [`read_state`] (cursor + unread + the mention ledger) and [`search`] — under
//! the same rules. None of them opens a second write path: a DM is a `channel`
//! row the spine then serves unchanged, a read cursor is a `seq` on that spine's
//! counter, the mention pass runs inside the send transaction, and search is
//! read-only. The one outbox row B1.2 adds (the read-state broadcast) goes
//! through [`momo_outbox::emit_outbox`] like every other.
//!
//! Deliberately **still out of scope** (later batches): huddle, attachments, the
//! pgvector memory plane, and the agent-run half of mention routing
//! (`MessageRoutes.routeAgentMentions` — an `agent_run` surface, not a
//! read-state one).

pub mod channel;
pub mod dm;
pub mod error;
pub mod identity;
pub mod message;
pub mod read_state;
pub mod search;

pub use channel::{create_channel, create_channel_in_tx, Channel, ChannelKind, NewChannel};
pub use dm::{
    canonical_participants, dm_lock_key, dm_participant_key, list_direct_messages,
    open_direct_message_in_tx, validate_direct_message_target, DirectMessage,
    DirectMessageTargetInvalid, OpenedDirectMessage, DM_LIST_LIMIT,
};
pub use error::{MessagingError, ProvenanceRejected};
pub use identity::{
    active_workspace_role, get_member, get_workspace, is_channel_member,
    resolve_member_signing_key, verify_password_login, Member, MemberKind, PasswordLogin,
    Workspace, WorkspaceRole,
};
pub use message::{
    build_broadcast_payload, cent_channel, clamp_history_limit, find_client_message_in_tx,
    list_channel_page, list_messages, send_message, send_message_in_tx,
    send_message_with_mentions_in_tx, send_signed_message_in_tx, HistoryCursor, MessageSignature,
    MessageType, NewMessage, SentMessage, StoredMessage, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX,
};
pub use read_state::{
    build_read_state_payload, contains_mention, effective_cursor, list_read_state,
    mention_id_token, read_state_channel, record_mentions_in_tx, unread_count,
    update_read_cursor_in_tx, ReadCursorUpdate, ReadState, MENTION_PROPS_KEY,
};
pub use search::{
    clamp_search_limit, decode_search_cursor, encode_search_cursor, literal_like_pattern,
    normalize_query, search_messages, SearchCursor, SearchHit, SearchPage, SearchRequestInvalid,
    SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MIN_CHARS,
};
