//! HTTP routes. Each module owns one Swift route file's parity surface.

/// ADR-0186 D1 — the workspace action catalog and its argument normaliser.
pub mod actions;
pub mod agent_connector_owner;
pub mod agent_credentials;
pub mod agent_gateway;
/// ADR-0186 증보 v5 U-a~U-d / #4704 — `oort_action_initiate`: an approval card nobody asked for.
pub mod agent_initiative;
pub mod agent_mentions;
/// ADR-0162 / HAP-E2 — stateless dual-era MCP Agent Port.
pub mod agent_port;
pub mod agent_port_oauth;
pub mod agent_port_tools;
pub mod agent_provider_pin;
pub mod agent_runs;
pub mod agents;
pub mod app_notice;
/// ADR-0113 증보 3 F8 / #4313 — `GET …/members/me/app-runtimes`: which of my agents run my
/// apps, and whether a message to each would be delivered right now (owner-only read).
pub mod app_runtimes;
pub mod approvals;
pub mod apps_used;
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
pub mod cohosted_agent;
pub mod credits;
/// ADR-0208 D4 — the send composition `POST …/messages` and the scheduler share.
pub(crate) mod deliver;
/// ADR-0216 (#4660): developer tokens — issue, list, revoke, whoami, self-revoke.
pub mod dev_access;
/// ADR-0216 D6 (나) / #4700: `oort login` — the human-subject arm of the OAuth authorization
/// server (browser consent, code exchange, refresh, revoke).
pub mod dev_login_oauth;
pub mod device_keys;
pub mod device_link;
pub mod devices;
/// ADR-0165 / LIVE-1 — 관전 라이브 화면: the display half of the attach plane.
pub mod display_attach;
pub mod dm_agents;
/// ADR-0177 증보 D7 / #4227 — `PUT|DELETE …/channels/{ch}/closure`: the member's own DM closure watermark.
pub mod dm_closure;
pub mod dms;
/// 휘발 신호 — the one route family with no Swift ancestor (ADR-0149).
pub mod ephemeral;
/// #1222 — 이벤트 구독: what leaves the workspace, and who said it could.
pub mod event_subscriptions;
pub mod expression_photo;
pub mod expressions;
pub mod github_app;
pub mod github_ingress;
pub mod health;
pub mod hosted_agent_connections;
pub mod hosted_agent_doorbell;
pub mod hosted_dm_approvals;
/// ADR-0122 / HD-1 — voice huddle lifecycle and LiveKit room grants.
pub mod huddles;
/// ADR-0216 D5 / #4661 — the human MCP, `POST /v1/mcp/me` (a developer token's MCP door).
pub mod human_mcp;
pub mod inbox;
pub mod invites;
pub mod join;
pub mod login_relay;
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
pub mod personal_agents;
pub mod personal_links;
/// ADR-0113 증보 2026-10-15 P-S1 (#3859) — official plugin catalog + manifest reads.
pub mod plugins;
/// ADR-0160 — declared presence status ③ (durable). The availability ② half is
/// in [`ephemeral`]; the connection ① half never reaches the server.
pub mod presence;
pub mod provider_default_ai;
pub mod provider_limits;
pub mod provider_link;
pub mod provider_settings;
pub mod push_action;
pub mod push_fetch;
pub mod read_state;
pub mod realtime;
pub mod reattach;
/// ADR-0175 / #1888 — personal message reminders (human-only, no outbox).
pub mod reminders;
/// ADR-0113 증보 3 F5 / #4313 — the send request's `apps` field and the server-owned
/// `props.requestedApps` marker (a marker, never a grant).
pub(crate) mod requested_apps;
pub mod roster;
/// ADR-0208 / #4214 — scheduled messages (human-only, owner-scoped, outbox event on every change).
pub mod scheduled_messages;
pub mod search;
/// #4820 C2a — the single-use address of the requester's own picture for the co-hosted Hermes picture tool.
pub mod self_media;
/// #1873 — BZ-4e self display-name rename (`PATCH …/members/me`).
pub mod self_profile;
pub mod shared;
/// ADR-0177 / #1932 — member-owned sidebar sections (human-only, no outbox).
pub mod sidebar_prefs;
pub mod subscription_agents;
pub mod terminal_attach;
/// ADR-0206 증보 1 / #4889 — `PUT`/`DELETE …/messages/{root}/follow`: follow a thread, or stop.
pub mod thread_follow;
/// ADR-0170 — link unfurl settings, message-level remove, image proxy.
pub mod unfurl;
pub mod usage;
pub mod viewing;
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
pub mod work_kill;
pub mod work_permissions;
pub mod work_session_share;
pub mod work_sessions;
pub mod work_spawns;
pub mod work_tier_policy;
pub mod work_tool_profiles;
/// ADR-0161 D5 — the workspace avatar media surface (upload session, completion,
/// the content proxy), the attachment surface re-aimed at a workspace.
pub mod workspace_avatar;
/// #1800 — operator-only `workspace.settings` bag.
pub mod workspace_settings;
pub mod workspaces;
