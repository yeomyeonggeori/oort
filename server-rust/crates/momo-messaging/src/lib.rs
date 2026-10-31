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
//! **HD-1** restores the huddle lifecycle in [`huddle`]. Huddle state remains
//! PostgreSQL-owned and every live update uses the same transactional outbox;
//! LiveKit receives only a short-lived room grant. The pgvector memory plane
//! remains outside this crate.

pub mod agent_avatar;
pub mod agent_card;
pub mod approval_card;
pub mod attachment;
pub mod attachment_reclaim;
pub mod avatar_reclaim;
pub mod channel;
/// ADR-0216 D4 (#4660) — a developer token's channel restriction, as a domain argument.
pub mod channel_restriction;
pub mod channel_viewing;
pub mod dm;
/// ADR-0177 증보 D6·D7 / #4227 — a member's own DM closure watermark (no outbox fan-out, D10).
pub mod dm_closure;
pub mod error;
pub mod hosted_inbox;
pub mod huddle;
pub mod huddle_sweep;
pub mod identity;
pub mod inbox;
pub mod interaction;
pub mod member_avatar;
pub mod member_rename;
/// ADR-0196 / #3164 — team-memory digest + receipt reads and `mem_settings` writes (RLS only).
pub mod memory;
pub mod message;
pub mod name_guard;
pub mod notification_rule;
/// ADR-0208 — the owner-scope GUC (`app.member_id`) binders, shared by reminders and scheduled messages.
pub mod owner_scope;
pub mod presence;
pub mod read_state;
pub mod refine;
/// ADR-0175 / #1888 — personal message reminders (no outbox fan-out).
pub mod reminder;
/// ADR-0208 / #4214 — scheduled messages: every `scheduled_message` statement (owner-scoped FORCE RLS).
pub mod scheduled;
pub mod search;
/// #4820 C2a — the short-lived, single-use address of the requester's own picture for the co-hosted
/// Hermes picture tool (ADR-0218 증보 G4·G8): token mint/redeem, the origin grammar, the log scrub.
pub mod self_media;
/// ADR-0177 / #1932 — member-owned sidebar sections (no outbox fan-out).
pub mod sidebar_prefs;
/// ADR-0206 증보 1 / #4889 — who follows which thread (`thread_follow`, migration 164).
pub mod thread_follow;
pub mod workspace_avatar;

pub use approval_card::settle_approval_card_in_tx;

pub use agent_avatar::{
    apply_avatar_image_in_tx, apply_human_avatar_image_in_tx, bind_staged_image_to_approval_in_tx,
    clear_avatar_image_in_tx, delete_staged_avatar_image_in_tx,
    find_requester_attachment_for_in_tx, find_requester_attachment_in_tx,
    find_visible_image_attachment_in_tx, image_attachments_for_messages_in_tx, is_avatar_preset,
    process_avatar_image, purge_stale_staged_avatar_images_in_tx, read_avatar_image_bytes_in_tx,
    read_avatar_image_in_tx, read_current_avatar_image_in_tx, requester_of_run_in_tx,
    stage_avatar_image_in_tx, staged_image_matches_pin_in_tx, AgentAvatarBytes, AgentAvatarImage,
    AvatarAttachmentSource, AvatarImageRejected, ProcessedAvatar, RequesterAttachmentUse,
    AGENT_AVATAR_DECODE_ALLOC_LIMIT, AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT,
    AGENT_AVATAR_IN_MAX_BYTES_GENERATED, AGENT_AVATAR_IN_MAX_DIM, AGENT_AVATAR_IN_MAX_PIXELS,
    AGENT_AVATAR_OUT_MAX_BYTES, AGENT_AVATAR_OUT_MAX_DIM, AGENT_AVATAR_PRESETS,
    AGENT_AVATAR_SOURCES, AGENT_AVATAR_STAGED_TTL_HOURS,
};
pub use agent_card::{
    apply_agent_card_in_tx, lock_agent_card_in_tx, read_agent_card_in_tx, AgentCard,
    AgentCardPatch, CardStatusPatch, FieldPatch,
};
pub use attachment::{
    create_pending_upload_in_tx, is_attachment_channel_member, link_attachments_in_tx,
    load_attachment_in_tx, load_readable_attachment_in_tx, message_attachments_in_tx,
    settle_upload_in_tx, validate_attachment_id_list, validate_attachment_mime,
    validate_attachment_name, Attachment, AttachmentLinkRejected, AttachmentSpecInvalid,
    MessageAttachment, ATTACHMENT_TEXT_MAX_CHARS, MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_ATTACHMENT_BYTES,
};
pub use channel::{
    add_channel_member_in_tx, clamp_channel_list_limit, create_channel,
    create_channel_detailed_in_tx, create_channel_in_tx, list_workspace_channels,
    list_workspace_channels_within, normalize_channel_kind, normalize_channel_name,
    normalize_channel_topic, normalize_membership_role, remove_channel_member_in_tx,
    set_notification_pref_in_tx, Channel, ChannelKind, ChannelMembership, ChannelSpecInvalid,
    ChannelSummary, CreatedChannel, NewChannel, CHANNEL_LIST_LIMIT_DEFAULT, CHANNEL_LIST_LIMIT_MAX,
    CHANNEL_NAME_MAX_CHARS, CHANNEL_TOPIC_MAX_CHARS,
};
pub use channel_restriction::ChannelRestriction;
pub use channel_viewing::{touch_channel_viewing_in_tx, ViewingOutcome, VIEWING_MIN_REFRESH_SECS};
pub use dm::{
    canonical_participants, dm_lock_key, dm_participant_key, list_direct_messages,
    lock_direct_message_seq_in_tx, open_direct_message_in_tx, validate_direct_message_target,
    DirectMessage, DirectMessageTargetInvalid, LockedDirectMessage, OpenedDirectMessage,
    DM_LIST_LIMIT,
};
pub use dm_closure::{close_dm_in_tx, reopen_dm_in_tx, DmClosureOutcome};
pub use error::{MessagingError, ProvenanceRejected};
pub use hosted_inbox::{
    append_job_reference_in_tx, append_message_reference_in_tx, append_run_reference_in_tx,
    decode_hosted_inbox_cursor, encode_hosted_inbox_cursor, fan_out_message_reference_in_tx,
    hosted_inbox_recipients_in_tx, list_hosted_inbox_in_tx, HostedInboxCursor,
    HostedInboxCursorError, HostedInboxEvent, HostedInboxPage, HostedInboxReadError,
    HOSTED_INBOX_LIMIT_DEFAULT, HOSTED_INBOX_LIMIT_MAX,
};
pub use huddle::{
    active_huddle, join_huddle, leave_huddle, start_huddle, Huddle, HuddleActor, HuddleError,
    HuddleParticipant, JoinHuddleOutcome, LeaveHuddleOutcome, StartHuddleOutcome,
};
pub use identity::{
    active_workspace_role, can_observe_agent, clamp_roster_limit, get_member, get_workspace,
    is_active_agent, is_active_human_member, is_channel_member, list_workspace_roster,
    parse_roster_kind_filter, read_workspace_for_active_member, resolve_member_signing_key,
    verify_password_login, Member, MemberKind, PasswordLogin, RosterKindFilterInvalid,
    RosterMember, Workspace, WorkspaceIdentity, WorkspaceRead, WorkspaceRole, ROSTER_LIMIT_DEFAULT,
    ROSTER_LIMIT_MAX,
};
pub use inbox::{
    clamp_inbox_limit, delete_read_inbox_items_in_tx, inbox_event_payload,
    inbox_unread_count_in_tx, inbox_unread_count_within_in_tx, list_inbox_in_tx,
    list_inbox_within_in_tx, make_preview, mark_inbox_item_read_in_tx, mark_inbox_read_all_in_tx,
    workspaces_with_expired_inbox_items, InboxChannel, InboxCursor, InboxFilter,
    InboxItemReadOutcome, InboxItemView, InboxMessage, InboxPage, InboxQuoted, InboxReadAllOutcome,
    INBOX_DEFAULT_LIMIT, INBOX_MAX_LIMIT, INBOX_PREVIEW_CHARS, INBOX_READ_RETENTION_DAYS,
    INBOX_UNREAD_COUNT_CAP,
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
pub use member_avatar::{
    activate_member_avatar_upload_in_tx, clear_own_member_avatar_in_tx, image_dimensions,
    load_own_member_avatar_media_in_tx, read_current_member_avatar_media_in_tx,
    reserve_member_avatar_upload_in_tx, settle_member_avatar_upload_in_tx, sniff_image_mime,
    validate_member_avatar_mime, MemberAvatarMedia, IMAGE_HEADER_PREFIX_BYTES,
    IMAGE_SNIFF_PREFIX_BYTES, MAX_MEMBER_AVATAR_DIMENSION, MAX_MEMBER_AVATAR_UPLOADS_PER_HOUR,
    MEMBER_AVATAR_MIMES,
};
pub use member_rename::{
    build_member_renamed_payload, change_own_handle_in_tx, load_roster_names_in_tx,
    lock_display_name_namespace_in_tx, rename_agent_display_name_in_tx,
    rename_own_display_name_in_tx, DisplayNameRename, HandleChangeRejected, HandleRename,
    MEMBER_RENAMED_BROADCAST_TYPE,
};
pub use memory::{
    accept_proposal_in_tx, bind_mem_reader_guc, clamp_mem_digest_limit, clamp_mem_item_limit,
    clamp_mem_proposal_limit, digests_by_ids_in_tx, edit_item_in_tx, event_target_in_tx,
    evidence_for_digests_in_tx, evidence_for_items_in_tx, forget_item_in_tx, get_digest_in_tx,
    get_item_in_tx, get_proposal_in_tx, get_serving_in_tx, items_by_ids_in_tx, last_read_seq_in_tx,
    list_digests_in_tx, list_item_events_in_tx, list_items_in_tx, list_proposals_in_tx,
    list_settings_in_tx, reject_proposal_in_tx, reset_workspace_in_tx, revert_consolidation_in_tx,
    search_item_rows_in_tx, search_items_in_tx, summarized_through_seq_in_tx,
    summary_provider_in_tx, upsert_channel_settings_in_tx, upsert_member_settings_in_tx,
    upsert_workspace_settings_in_tx, DigestListFilter, ItemListFilter, ItemStatus, MemDigest,
    MemEvidence, MemItem, MemItemBrief, MemItemEvent, MemItemEvidence, MemItemHit, MemProposal,
    MemResetCounts, MemResetOutcome, MemServing, MemSettingsRow, ProposalEvidence,
    ProposalListFilter, MEM_DIGEST_LIMIT_DEFAULT, MEM_DIGEST_LIMIT_MAX, MEM_ITEM_KINDS,
    MEM_ITEM_LIMIT_DEFAULT, MEM_ITEM_LIMIT_MAX, MEM_ITEM_SEARCH_LIMIT_DEFAULT,
    MEM_ITEM_SEARCH_LIMIT_MAX, MEM_PROPOSAL_LIMIT_DEFAULT, MEM_PROPOSAL_LIMIT_MAX,
};
pub use message::{
    agent_auto_reply_streak_in_tx, agent_context_window_for_member_in_tx,
    agent_context_window_in_tx, build_broadcast_payload, build_thread_updated_payload,
    cent_channel, clamp_history_limit, clamp_replies_limit, context_message_body,
    fetch_thread_rollup_in_tx, find_client_message_in_tx, find_message_in_tx, list_channel_page,
    list_messages, list_thread_replies, parse_replies_cursor, patch_and_prune_message_props_in_tx,
    patch_message_props_in_tx, send_message, send_message_in_tx, send_message_with_mentions_in_tx,
    send_message_with_mentions_via_in_tx, send_signed_message_in_tx, send_thread_notice_in_tx,
    thread_root_state_in_tx, validate_quote_target_in_tx, validate_replies_root_in_tx,
    validate_thread_root_in_tx, HistoryCursor, MessageSignature, MessageType, NewMessage,
    PagedMessage, QuoteTargetInvalid, QuotedMessage, RepliesCursorInvalid, SendExtras,
    SendRejected, SentMessage, SentVia, StoredMessage, ThreadReplyPage, ThreadRollup,
    ThreadRootInvalid, ThreadRootState, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX,
    REPLIES_LIMIT_DEFAULT, REPLIES_LIMIT_MAX,
};
pub use notification_rule::{
    get_notification_rule_in_tx, get_push_kinds_in_tx, patch_notification_rule_in_tx,
    patch_push_kinds_in_tx, pause_in_force, set_notification_rule_in_tx, NotificationRule,
    NotificationRulePatch, NotificationRuleUpdate, PushKinds, PushKindsPatch,
};
pub use owner_scope::{bind_owner_guc, clear_owner_guc, current_owner_guc};
pub use presence::{
    build_presence_payload, declared_presence_for, decode_optional_presence, effective_presence,
    normalize_status_emoji, normalize_status_text, presence_status_for,
    set_declared_presence_in_tx, set_presence_status_in_tx, status_expires_at_from_ms,
    CustomStatus, CustomStatusInvalid, CustomStatusPatch, DeclaredPresence, PresenceStatus,
    PresenceUpdate, StatusPatch, PRESENCE_BROADCAST_TYPE, STATUS_EMOJI_MAX_CHARS,
    STATUS_TEXT_MAX_CHARS,
};
pub use read_state::{
    build_read_state_payload, contains_mention, contains_mention_with_aliases, effective_cursor,
    list_read_state, list_read_state_projection, mention_id_token, read_state_channel,
    record_mentions_in_tx, unread_count, update_read_cursor_in_tx,
    update_read_cursor_with_intent_in_tx, MarkUnreadWrite, ReadCursorOutcome, ReadCursorUpdate,
    ReadIntent, ReadState, ReadStateProjection, MENTION_PROPS_KEY,
};
pub use refine::{
    harness_refine_client_msg_id, harness_refine_input_props, validate_harness_refine,
    HarnessRefine, HarnessRefineEdit, HarnessRefineInvalid, HarnessRefineTrigger,
    HARNESS_REFINE_EDITS_MAX, HARNESS_REFINE_ID_MAX_CHARS, HARNESS_REFINE_PROPS_KEY,
    HARNESS_REFINE_SCOPE, HARNESS_REFINE_SUMMARY_MAX_CHARS,
};
pub use reminder::{
    authorize_reminder_message_in_tx, clamp_reminder_list_limit, complete_reminder_in_tx,
    create_reminder_in_tx, delete_reminder_in_tx, get_own_reminder_in_tx, list_reminders_in_tx,
    normalize_reminder_note, parse_reminder_list_state, reminder_due_at_from_ms,
    snooze_reminder_in_tx, MessageReminder, ReminderDueInvalid, ReminderListState,
    ReminderNoteInvalid, ReminderStateInvalid, ReminderTarget, REMINDER_LIST_LIMIT_DEFAULT,
    REMINDER_LIST_LIMIT_MAX, REMINDER_NOTE_MAX_CHARS,
};
pub use scheduled::{
    backoff_seconds, begin_attempt_in_tx, cancel_member_schedules_in_tx, cancel_schedule_in_tx,
    clamp_schedule_list_limit, count_pending_in_tx, db_now_in_tx, due_schedules,
    edit_failed_body_in_tx, edit_pending_in_tx, expired_schedules, find_schedule_by_request_in_tx,
    get_own_schedule_in_tx, hold_lineage_schedules_in_tx, hold_member_schedules_in_tx,
    insert_schedule_in_tx, is_edit_locked, list_own_schedules_in_tx, lock_attempt_for_send_in_tx,
    lock_due_for_decision_in_tx, lock_member_schedules_in_tx, lock_own_schedule_in_tx,
    mark_failed_in_tx, mark_sent_in_tx, purge_expired_schedule_in_tx, rearm_failed_in_tx,
    record_created_in_tx, record_transition_in_tx, reserve_attachments_in_tx,
    reserved_attachment_ids_in_tx, schedule_attachments_in_tx, schedule_event_payload,
    validate_send_at, DueDecision, HeldSchedules, NewSchedule, ReserveRejected, RevocationCause,
    ScheduleActor, ScheduleAudit, ScheduleFailure, ScheduleFilterInvalid, ScheduleListFilter,
    ScheduleRef, ScheduledMessage, ScheduledStatus, SendAtInvalid, SCHEDULE_ATTACHMENT_LIMIT,
    SCHEDULE_DONE_RETENTION_DAYS, SCHEDULE_EDIT_LOCK_SECONDS, SCHEDULE_EVENT_TYPE,
    SCHEDULE_FAILED_RETENTION_DAYS, SCHEDULE_LIST_LIMIT_DEFAULT, SCHEDULE_LIST_LIMIT_MAX,
    SCHEDULE_MAX_LEAD_DAYS, SCHEDULE_MIN_LEAD_SECONDS, SCHEDULE_PENDING_LIMIT,
};
pub use search::{
    clamp_search_limit, decode_search_cursor, encode_search_cursor, literal_like_pattern,
    normalize_query, search_messages, SearchCursor, SearchHit, SearchPage, SearchRequestInvalid,
    SearchScope, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_QUERY_MIN_CHARS,
};
pub use self_media::{
    bytes_match_mime, canonical_origin, mint_for_run_in_tx, mint_with_ttl_in_tx,
    redact_self_media_urls, redeem_in_tx, self_media_url, token_hash, token_is_well_formed,
    trigger_photo_in_tx, SelfMediaGrant, SelfMediaSource, TriggerPhoto, SELF_MEDIA_MAX_BYTES,
    SELF_MEDIA_PATH_PREFIX, SELF_MEDIA_TOKEN_CHARS, SELF_MEDIA_TTL_SECS,
};
pub use sidebar_prefs::{
    get_sidebar_prefs_in_tx, set_sidebar_prefs_in_tx, validate_sidebar_prefs, SidebarPrefs,
    SidebarPrefsInvalid, SidebarSection, StoredSidebarPrefs, CHANNEL_REF_MAX, SECTION_ID_MAX_CHARS,
    SECTION_MAX, SECTION_NAME_MAX_CHARS, SECTION_SORT_MAX_CHARS, SIDEBAR_PREFS_VERSION,
};
pub use thread_follow::{
    is_following_thread_in_tx, set_thread_follow_in_tx, FollowRefused, STATE_AUTO, STATE_FOLLOWED,
    STATE_UNFOLLOWED,
};
pub use workspace_avatar::{
    create_pending_avatar_upload_in_tx, load_avatar_media_in_tx, read_current_avatar_media_in_tx,
    settle_avatar_upload_in_tx, validate_avatar_mime, validate_avatar_name, AvatarMedia,
    AvatarSpecInvalid, MAX_WORKSPACE_AVATAR_BYTES, WORKSPACE_AVATAR_TEXT_MAX_CHARS,
};
