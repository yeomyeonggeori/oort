//! `momo-workd` — the oort desktop work host (ADR-0188 D2, R1 first slice).
//!
//! The host dials out to the team server and nothing dials in: registration
//! (the owner's token, once), a v2-signed heartbeat, the `pending-controls`
//! poll and its acks, and session create/PATCH. Sessions are ACP agents
//! (`claude`, `codex`) on stdio (ADR-0130 D1), run under the ADR-0188 D6
//! isolation rules from this first slice.
//!
//! | module | role |
//! |---|---|
//! | [`config`] | the owner's allowlist and settings; the registration state |
//! | [`keystore`] | the Ed25519 host key: keychain (ThisDeviceOnly) or the dev file |
//! | [`client`] | v2-signed server calls, and the [`client::HostApi`] seam |
//! | [`controls`] | poll → apply once → ack; the heartbeat loop |
//! | [`human_trust`] | R2 (ADR-0146 개정): pinned root, endorsement chain, device-signature check, nonce ledger, revocations |
//! | [`signature_requirement`] | whether R2 is enforced: the owner's config, or the server's word latched with a pinned root (#3117) |
//! | [`session`] | the session manager and the per-session ACP task |
//! | [`session_grant`] | 「이 세션 동안」 허락의 범위 규칙과 기억 (#3095) |
//! | [`acp`] | the JSON-RPC stdio transport |
//! | [`projection`] | `session/update` → curated server events |
//! | [`policy`] | the D6 invariants |
//! | [`control_socket`] | the app ↔ workd Unix socket: `status`, `shutdown`, `pin_root`, `revoke_device`, `reset_signature_requirement`, peer signature check |
//! | [`cli`] | `register` / `run` |

pub mod acp;
pub mod cli;
pub mod client;
pub mod config;
#[cfg(target_os = "macos")]
pub mod control_socket;
pub mod controls;
pub mod human_trust;
pub mod keystore;
pub mod policy;
pub mod proctree;
pub mod projection;
pub mod redact;
pub mod session;
pub mod session_grant;
pub mod signature_requirement;
