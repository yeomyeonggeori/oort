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
//! Deliberately **out of scope for B1** (later batches): agent-action provenance
//! signing (ADR-0146), HTTP/Axum routes and the `momo-server` binary (this is a
//! domain crate — the API is shaped so a route layer can mount it), and the
//! huddle / search-memory / DM / read-state / mention-semantics surfaces.

pub mod channel;
pub mod error;
pub mod identity;
pub mod message;

pub use channel::{create_channel, create_channel_in_tx, Channel, ChannelKind, NewChannel};
pub use error::MessagingError;
pub use identity::{
    get_member, get_workspace, is_channel_member, verify_password_login, Member, MemberKind,
    PasswordLogin, Workspace,
};
pub use message::{
    build_broadcast_payload, cent_channel, clamp_history_limit, list_channel_page, list_messages,
    send_message, send_message_in_tx, HistoryCursor, MessageType, NewMessage, SentMessage,
    StoredMessage, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX,
};
