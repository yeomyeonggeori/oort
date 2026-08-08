//! HTTP routes. Each module owns one Swift route file's parity surface.

pub mod agent_gateway;
pub mod agent_mentions;
pub mod agent_runs;
pub mod agents;
pub mod approvals;
/// ADR-0151 — the Drive attachment surface: upload session, completion, and the
/// content proxy, plus the stub archive's own upload endpoint.
pub mod attachments;
pub mod auth_routes;
pub mod channels;
pub mod cloud_hosts;
pub mod credits;
pub mod devices;
pub mod dms;
/// 휘발 신호 — the one route family with no Swift ancestor (ADR-0149).
pub mod ephemeral;
pub mod health;
pub mod invites;
pub mod join;
pub mod messages;
pub mod provider_link;
pub mod provider_settings;
pub mod read_state;
pub mod realtime;
pub mod reattach;
pub mod roster;
pub mod search;
pub mod shared;
pub mod terminal_attach;
pub mod usage;
/// #1114 — the host-control ledger (ADR-0114 D4/D5) and its spawn approval.
pub mod work_controls;
pub mod work_hosts;
pub mod work_sessions;
pub mod work_tier_policy;
pub mod workspaces;
