//! HTTP routes. Each module owns one Swift route file's parity surface.

/// ADR-0186 D1 — the workspace action catalog and its argument normaliser.
pub mod actions;
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
pub mod cloud_box_runner;
pub mod cloud_boxes;
pub mod cloud_hosts;
pub mod credits;
pub mod device_keys;
pub mod device_link;
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
pub mod hosted_dm_approvals;
/// ADR-0122 / HD-1 — voice huddle lifecycle and LiveKit room grants.
pub mod huddles;
pub mod invites;
pub mod join;
/// ADR-0161 증보 (#3277) — the member avatar media surface (self-only write,
/// workspace-wide read).
pub mod member_avatar;
/// #1768 — ADR-0128 D2/D3 member lifecycle (role/suspend/remove/bans/channel leave).
pub mod member_lifecycle;
/// ADR-0196 / #3164 — team-memory digest + receipt reads and settings (RLS-filtered).
pub mod memory;
pub mod messages;
pub mod notification_rules;
/// #1767 — operator-issued password reset + self password change.
pub mod password;
pub mod personal_links;
/// ADR-0160 — declared presence status ③ (durable). The availability ② half is
/// in [`ephemeral`]; the connection ① half never reaches the server.
pub mod presence;
pub mod provider_default_ai;
pub mod provider_link;
pub mod provider_settings;
pub mod push_fetch;
pub mod read_state;
pub mod realtime;
pub mod reattach;
/// ADR-0175 / #1888 — personal message reminders (human-only, no outbox).
pub mod reminders;
pub mod roster;
pub mod search;
/// #1873 — BZ-4e self display-name rename (`PATCH …/members/me`).
pub mod self_profile;
pub mod shared;
/// ADR-0177 / #1932 — member-owned sidebar sections (human-only, no outbox).
pub mod sidebar_prefs;
pub mod subscription_agents;
pub mod terminal_attach;
/// ADR-0170 — link unfurl settings, message-level remove, image proxy.
pub mod unfurl;
pub mod usage;
/// #1265 — public signed + Slack-compatible ingress (ADR-0115).
pub mod webhook_ingress;
/// #1222 — 인바운드 웹훅 설치 관리 (ADR-0115).
/// Public ingress: [`webhook_ingress`].
pub mod webhooks;
pub mod welcome;
pub mod work_board;
/// #1114 — the host-control ledger (ADR-0114 D4/D5) and its spawn approval.
pub mod work_controls;
pub mod work_hosts;
pub mod work_instructions;
pub mod work_permissions;
pub mod work_session_share;
pub mod work_sessions;
pub mod work_tier_policy;
pub mod work_tool_profiles;
/// ADR-0161 D5 — the workspace avatar media surface (upload session, completion,
/// the content proxy), the attachment surface re-aimed at a workspace.
pub mod workspace_avatar;
/// #1800 — operator-only `workspace.settings` bag.
pub mod workspace_settings;
pub mod workspaces;
