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
//! **B5.2** adds exactly one read to this crate and no writes:
//! [`message::agent_context_window_in_tx`], the same-channel history window a
//! mention-triggered agent turn is assembled from (MOMO-302). It lives here
//! because it is a `message` read and this crate owns every `message` statement;
//! the agent-run half of mention routing stays in `momo-agent`, which owns
//! `agent_run` and — deliberately — no message SQL at all.
//!
//! **ADR-0151** adds [`attachment`] — every `attachment` statement, and the
//! binding step that runs inside the send transaction. It lives here rather than
//! in a crate of its own because the binding is part of the *message's*
//! transaction: a refused attachment has to roll the message back with it, and
//! that is only expressible where the send path already is. The bytes, by
//! contrast, are `momo-drive`'s and are deliberately not reachable from here —
//! this crate owns the ledger, that one owns the archive.
//!
//! Deliberately **still out of scope** (later batches): huddle and the pgvector
//! memory plane.

pub mod attachment;
pub mod channel;
pub mod dm;
pub mod error;
pub mod hosted_inbox;
pub mod identity;
pub mod interaction;
pub mod message;
pub mod notification_rule;
pub mod presence;
pub mod read_state;
pub mod refine;
pub mod search;
pub mod workspace_avatar;

pub use attachment::{
    create_pending_upload_in_tx, is_attachment_channel_member, link_attachments_in_tx,
    load_attachment_in_tx, message_attachments_in_tx, settle_upload_in_tx,
    validate_attachment_id_list, validate_attachment_mime, validate_attachment_name, Attachment,
    AttachmentLinkRejected, AttachmentSpecInvalid, MessageAttachment, ATTACHMENT_TEXT_MAX_CHARS,
    MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES,
};
pub use channel::{
    add_channel_member_in_tx, clamp_channel_list_limit, create_channel,
    create_channel_detailed_in_tx, create_channel_in_tx, list_workspace_channels,
    normalize_channel_kind, normalize_channel_name, normalize_channel_topic,
    normalize_membership_role, remove_channel_member_in_tx, set_notification_pref_in_tx, Channel,
    ChannelKind, ChannelMembership, ChannelSpecInvalid, ChannelSummary, CreatedChannel, NewChannel,
    CHANNEL_LIST_LIMIT_DEFAULT, CHANNEL_LIST_LIMIT_MAX, CHANNEL_NAME_MAX_CHARS,
    CHANNEL_TOPIC_MAX_CHARS,
};
pub use dm::{
    canonical_participants, dm_lock_key, dm_participant_key, list_direct_messages,
    open_direct_message_in_tx, validate_direct_message_target, DirectMessage,
    DirectMessageTargetInvalid, OpenedDirectMessage, DM_LIST_LIMIT,
};
pub use error::{MessagingError, ProvenanceRejected};
pub use hosted_inbox::{
    append_job_reference_in_tx, append_message_reference_in_tx, append_run_reference_in_tx,
    decode_hosted_inbox_cursor, encode_hosted_inbox_cursor, fan_out_message_reference_in_tx,
    hosted_inbox_recipients_in_tx, list_hosted_inbox_in_tx, HostedInboxCursor,
    HostedInboxCursorError, HostedInboxEvent, HostedInboxPage, HostedInboxReadError,
    HOSTED_INBOX_LIMIT_DEFAULT, HOSTED_INBOX_LIMIT_MAX,
};
pub use identity::{
    active_workspace_role, can_observe_agent, clamp_roster_limit, get_member, get_workspace,
    is_active_agent, is_channel_member, list_workspace_roster, parse_roster_kind_filter,
    read_workspace_for_active_member, resolve_member_signing_key, verify_password_login, Member,
    MemberKind, PasswordLogin, RosterKindFilterInvalid, RosterMember, Workspace, WorkspaceIdentity,
    WorkspaceRead, WorkspaceRole, ROSTER_LIMIT_DEFAULT, ROSTER_LIMIT_MAX,
};
pub use interaction::{
    build_message_deleted_payload, build_message_edited_payload, build_pin_payload,
    build_reaction_payload, channel_pins, channel_reaction_snapshot, delete_message_in_tx,
    edit_message_in_tx, emit_message_edited_in_tx, lock_message_in_tx,
    open_stream_message_for_run_in_tx, open_stream_run_id, opening_stream_props, set_pin_in_tx,
    set_reaction_in_tx, stream_message_body_in_tx, validate_reaction_emoji, DeletedMessage,
    InteractionMessage, InteractionRefused, LockedMessage, OpenStreamMessage, PinAction, PinDelta,
    PinnedMessage, ReactionAction, ReactionDelta, ReactionEmojiInvalid, ReactionSnapshot,
    StreamCloseOutcome, StreamEdit, StreamOutcome, CHANNEL_PIN_LIMIT, MESSAGE_REACTION_LIMIT,
    OPENING_STREAM_REV, REACTION_EMOJI_MAX_CHARS, STREAM_PROPS_KEY,
};
pub use message::{
    agent_auto_reply_streak_in_tx, agent_context_window_in_tx, build_broadcast_payload,
    build_thread_updated_payload, cent_channel, clamp_history_limit, clamp_replies_limit,
    context_message_body, fetch_thread_rollup_in_tx, find_client_message_in_tx, list_channel_page,
    list_messages, list_thread_replies, parse_replies_cursor, patch_message_props_in_tx,
    send_message, send_message_in_tx, send_message_with_mentions_in_tx, send_signed_message_in_tx,
    thread_root_state_in_tx, validate_quote_target_in_tx, validate_replies_root_in_tx,
    validate_thread_root_in_tx, HistoryCursor, MessageSignature, MessageType, NewMessage,
    PagedMessage, QuoteTargetInvalid, QuotedMessage, RepliesCursorInvalid, SendExtras,
    SendRejected, SentMessage, StoredMessage, ThreadReplyPage, ThreadRollup, ThreadRootInvalid,
    ThreadRootState, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX, REPLIES_LIMIT_DEFAULT,
    REPLIES_LIMIT_MAX,
};
pub use notification_rule::{
    get_notification_rule_in_tx, set_notification_rule_in_tx, NotificationRule,
};
pub use presence::{
    build_presence_payload, decode_optional_presence, presence_status_for,
    set_presence_status_in_tx, PresenceStatus, PresenceUpdate, PRESENCE_BROADCAST_TYPE,
};
pub use read_state::{
    build_read_state_payload, contains_mention, effective_cursor, list_read_state,
    mention_id_token, read_state_channel, record_mentions_in_tx, unread_count,
    update_read_cursor_in_tx, ReadCursorUpdate, ReadState, MENTION_PROPS_KEY,
};
pub use refine::{
    harness_refine_client_msg_id, harness_refine_input_props, validate_harness_refine,
    HarnessRefine, HarnessRefineEdit, HarnessRefineInvalid, HarnessRefineTrigger,
    HARNESS_REFINE_EDITS_MAX, HARNESS_REFINE_ID_MAX_CHARS, HARNESS_REFINE_PROPS_KEY,
    HARNESS_REFINE_SCOPE, HARNESS_REFINE_SUMMARY_MAX_CHARS,
};
pub use search::{
    clamp_search_limit, decode_search_cursor, encode_search_cursor, literal_like_pattern,
    normalize_query, search_messages, SearchCursor, SearchHit, SearchPage, SearchRequestInvalid,
    SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MIN_CHARS,
};
pub use workspace_avatar::{
    create_pending_avatar_upload_in_tx, load_avatar_media_in_tx, read_current_avatar_media_in_tx,
    settle_avatar_upload_in_tx, validate_avatar_mime, validate_avatar_name, AvatarMedia,
    AvatarSpecInvalid, MAX_WORKSPACE_AVATAR_BYTES, WORKSPACE_AVATAR_TEXT_MAX_CHARS,
};
