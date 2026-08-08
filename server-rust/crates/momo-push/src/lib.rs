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

pub mod candidate;
pub mod device;
pub mod dispatch;
pub mod dispatch_log;
pub mod error;
pub mod judgment;

pub use candidate::PushCandidate;
pub use device::{
    list_devices, register_device, revoke_device, DeviceRecord, DeviceRegistration,
    PushTokenRecord, RegisterOutcome, RevokeOutcome,
};
pub use dispatch::{
    category_for, collapse_id, DispatchOutcome, DispatchTarget, PushCategory, PushDispatch,
    PushDispatcher, PushReason, DISPATCH_SCHEMA,
};
pub use dispatch_log::{claim_dispatch, settle_dispatch, DispatchClaim};
pub use error::{DeviceInputError, DeviceRejection, PushError};
pub use judgment::{judge_targets, unread_badge, JudgedTarget};
