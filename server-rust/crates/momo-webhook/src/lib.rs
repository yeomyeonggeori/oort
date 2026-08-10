//! `momo-webhook` — the two webhook families' domain layer (#1222 / T13).
//!
//! oort has two things called "webhook" and they point in opposite directions.
//! Keeping them in one crate is not a filing convenience: they share one master
//! key, one HMAC construction, one URL policy and one audit ledger, and the only
//! way to keep those four from drifting apart is to have one implementation of
//! each.
//!
//! ```text
//! INBOUND   webhook_installation + webhook_secret_key   (migration 014, ADR-0115)
//!           an external system pushes INTO a channel
//!           managed by GET/POST/POST rotate/DELETE  /v1/workspaces/{ws}/webhooks
//!
//! OUTBOUND  event_subscription                          (migration 033)
//!           oort pushes OUT to a subscriber's address
//!           managed by GET/POST/PUT/DELETE          /v1/workspaces/{ws}/event-subscriptions
//!           delivered by `bins/momo-webhook-sender` draining `webhook_delivery`
//! ```
//!
//! ## What this crate owns, and the one thing it deliberately does not
//!
//! * [`crypto`] — the ADR-0115 derivations, ported byte-for-byte from Swift
//!   `WebhookCrypto` + `SafeWebhookDeliveryClient`. A secret issued by the Swift
//!   server must still verify here, because #1222 replaces the *sender* while
//!   every already-installed subscriber keeps its existing credential.
//! * [`outbound`] — the SSRF guard (Swift `OutboundURLPolicy`). It runs twice on
//!   purpose: once when an admin saves a destination, and again in the sender at
//!   delivery time, because DNS can be re-pointed between the two.
//! * [`installations`] / [`subscriptions`] — every `webhook_installation`,
//!   `webhook_secret_key` and `event_subscription` statement in the workspace.
//!
//! **No HTTP client.** `momo-server` depends on this crate, and the property
//! that stops a route handler from building an arbitrary outbound request is
//! that nothing in the api's dependency graph can build one (see the NOTE in
//! `Cargo.toml`). The delivery transport lives in the sender binary.

pub mod crypto;
pub mod installations;
pub mod outbound;
pub mod subscriptions;

pub use crypto::{
    delivery_signature, native_secret, outbound_secret, random_reference, sha256_hex, slack_token,
    token_hash, workspace_id_from_slack_token, NATIVE_SECRET_PREFIX, OUTBOUND_SECRET_PREFIX,
    SLACK_TOKEN_PREFIX,
};
pub use installations::{
    active_channel_exists, create_installation, list_installations, load_installation_for_update,
    normalized_label, receive_url, revoke_installation, rotate_installation_secret,
    validated_overlap_seconds, CreatedInstallation, InstallationRow, NewInstallation, WebhookMode,
    DEFAULT_ROTATION_OVERLAP_SECONDS, LABEL_MAX_CHARS, MAX_ROTATION_OVERLAP_SECONDS, PLUGIN_ID,
};
pub use outbound::{
    is_denied_address, validated_resolved_addresses, validated_url, HostResolver, OutboundUrl,
    OutboundUrlError, SystemHostResolver, MAX_URL_BYTES,
};
pub use subscriptions::{
    create_subscription, delete_subscription, list_subscriptions, load_delivery_target,
    record_delivery_audit, register_delivery_failure, reset_delivery_failures, update_subscription,
    validated_kinds, DeliveryTarget, EventKind, RegisteredFailure, SubscriptionRow, EVENT_KINDS,
};
