//! HTTP routes. Each module owns one Swift route file's parity surface.

pub mod agent_credentials;
pub mod agent_gateway;
pub mod agent_mentions;
/// ADR-0162 / HAP-E2 — stateless dual-era MCP Agent Port.
pub mod agent_port;
pub mod agent_port_oauth;
pub mod agent_port_tools;
pub mod agent_runs;
pub mod agents;
pub mod approvals;
/// ADR-0151 — the Drive attachment surface: upload session, completion, and the
/// content proxy, plus the stub archive's own upload endpoint.
pub mod attachments;
pub mod auth_routes;
pub mod channels;
/// ADR-0166 / T-1 — public first-owner claim (unauthenticated write).
pub mod claim;
pub mod cloud_hosts;
pub mod credits;
pub mod devices;
/// ADR-0165 / LIVE-1 — 관전 라이브 화면: the display half of the attach plane.
pub mod display_attach;
pub mod dms;
/// 휘발 신호 — the one route family with no Swift ancestor (ADR-0149).
pub mod ephemeral;
/// #1222 — 이벤트 구독: what leaves the workspace, and who said it could.
pub mod event_subscriptions;
pub mod health;
pub mod hosted_agent_connections;
pub mod hosted_agent_doorbell;
/// ADR-0122 / HD-1 — voice huddle lifecycle and LiveKit room grants.
pub mod huddles;
pub mod invites;
pub mod join;
pub mod messages;
pub mod notification_rules;
/// #1767 — operator-issued password reset + self password change.
pub mod password;
/// ADR-0160 — declared presence status ③ (durable). The availability ② half is
/// in [`ephemeral`]; the connection ① half never reaches the server.
pub mod presence;
pub mod provider_link;
pub mod provider_settings;
pub mod read_state;
pub mod realtime;
pub mod reattach;
pub mod roster;
pub mod search;
pub mod shared;
pub mod terminal_attach;
/// ADR-0170 — link unfurl settings, message-level remove, image proxy.
pub mod unfurl;
pub mod usage;
/// #1222 — 인바운드 웹훅 설치 관리 (ADR-0115). The public ingress half is not
/// ported yet; see the module header.
pub mod webhooks;
/// #1114 — the host-control ledger (ADR-0114 D4/D5) and its spawn approval.
pub mod work_controls;
pub mod work_hosts;
pub mod work_sessions;
pub mod work_tier_policy;
pub mod work_tool_profiles;
/// ADR-0161 D5 — the workspace avatar media surface (upload session, completion,
/// the content proxy), the attachment surface re-aimed at a workspace.
pub mod workspace_avatar;
pub mod workspaces;
