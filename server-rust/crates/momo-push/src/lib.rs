//! `momo-push` — the push chain's domain layer (ADR-0120, batch P2).
//!
//! Two surfaces that share one subject (`device` / `push_token` /
//! `push_dispatch_log`) and therefore one crate:
//!
//! 1. **Registration** ([`device`]) — the `/v1/workspaces/{ws}/devices` REST
//!    lifecycle the server routes call into.
//! 2. **Delivery** ([`judgment`], [`dispatch_log`], [`dispatch`]) — who to
//!    notify for a committed message, the idempotency claim that stops a
//!    redelivered candidate sending twice, and the id-only wire payload.
//! 3. **Diagnostics and the test push** ([`diagnostics`], [`system`], ADR-0206
//!    D11·D15, #4341) — why a member's push might not arrive, as closed codes, and
//!    the delivery half of a push that names no message.
//!
//! ## The boundary this crate exists to hold
//!
//! ADR-0120 D2-A: **대화 내용이 우리 인프라를 지나지 않는다.** A self-hosted momo
//! server cannot hold Apple's APNs key, so pushes must traverse a relay run by
//! someone else. What makes that tolerable is that the relay learns *nothing*:
//! the payload carries ids, and the client wakes and fetches the content from
//! its own server. [`dispatch::PushDispatch`] is that contract as a type, and
//! its tests are the enforcement.
//!
//! ## What is deliberately *not* here
//!
//! * **No HTTP.** The transport is the [`dispatch::PushDispatcher`] trait; the
//!   notifier binary owns the signing HTTP client. Keeping `reqwest` out of this
//!   crate is what lets `momo-server` depend on it for the devices route without
//!   acquiring an outbound HTTP client (invariant #2).
//! * **No APNs.** Contacting Apple is the relay's job and its key. There is no
//!   `.p8` in this repo, this crate, or this server.
//! * **No `outbox` SQL.** The candidate claim lives in
//!   [`momo_outbox::push`](../momo_outbox/push/index.html), which owns that
//!   table (invariant #3).

pub mod approvers;
pub mod candidate;
pub mod device;
pub mod diagnostics;
pub mod dispatch;
pub mod dispatch_log;
pub mod error;
pub mod judgment;
pub mod system;

pub use approvers::{may_approve_in_tx, ApprovalCard, CardAudience};
pub use candidate::PushCandidate;
pub use device::{
    invalidate_member_push_tokens_in_tx, invalidate_session_push_tokens_in_tx, list_devices,
    register_device, revoke_device, DeviceRecord, DeviceRegistration, PushTokenRecord,
    RegisterOutcome, RevokeOutcome,
};
pub use diagnostics::{
    apns_reason_code, classify_last_test, compute_diagnostics, is_relay_vocabulary_refusal,
    reserve_test_push_in_tx, retry_after_secs, Blocker, BlockerCode, DeviceCounts, Diagnostics,
    LastTest, LastTestStatus, TestDispatchRow, TestPushSlot, LAST_TEST_ROWS_SQL,
    TEST_PUSH_PER_WINDOW, TEST_PUSH_WINDOW_SECS, TEST_STALLED_AFTER_SECS,
};
pub use dispatch::{
    category_for, collapse_id, DispatchOutcome, DispatchTarget, PushCategory, PushDispatch,
    PushDispatcher, PushReason, DISPATCH_SCHEMA, RELAY_RATE_LIMITED,
};
pub use dispatch_log::{
    claim_dispatch, claim_system_dispatch, dead_token_reason, is_dispatch_settled, settle_dispatch,
    settle_dispatch_and_invalidate, settle_relay_refusal, DeadTokenReason, DispatchClaim,
    RefusalOutcome, RelayRefusal, SettleOutcome, AUDIT_RELAY_REFUSED, AUDIT_RELAY_REFUSED_SCHEMA,
    RELAY_DROPPED_REASON,
};
pub use error::{DeviceInputError, DeviceRejection, PushError};
pub use judgment::{
    judge_candidate_targets, judge_targets, unread_badge, JudgedTarget,
    WORK_COMPLETE_FOREGROUND_WINDOW_SECS, WORK_COMPLETE_MIN_RAN_MS,
};
pub use system::{
    system_dispatch_target, system_targets, test_notification_collapse_id,
    test_notification_dispatch_target, SystemPush, SystemTarget, SYSTEM_PUSH_MAX_TARGETS,
};
