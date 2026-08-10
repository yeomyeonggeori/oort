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
/// #1222 — 이벤트 구독: what leaves the workspace, and who said it could.
pub mod event_subscriptions;
pub mod health;
pub mod invites;
pub mod join;
pub mod messages;
pub mod notification_rules;
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
/// #1222 — 인바운드 웹훅 설치 관리 (ADR-0115). The public ingress half is not
/// ported yet; see the module header.
pub mod webhooks;
/// #1114 — the host-control ledger (ADR-0114 D4/D5) and its spawn approval.
pub mod work_controls;
pub mod work_hosts;
pub mod work_sessions;
pub mod work_tier_policy;
/// ADR-0161 D5 — the workspace avatar media surface (upload session, completion,
/// the content proxy), the attachment surface re-aimed at a workspace.
pub mod workspace_avatar;
pub mod workspaces;
