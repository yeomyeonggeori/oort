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
//! | [`session`] | the session manager and the per-session ACP task |
//! | [`acp`] | the JSON-RPC stdio transport |
//! | [`projection`] | `session/update` → curated server events |
//! | [`policy`] | the D6 invariants |
//! | [`cli`] | `register` / `run` |

pub mod acp;
pub mod cli;
pub mod client;
pub mod config;
pub mod controls;
pub mod keystore;
pub mod policy;
pub mod proctree;
pub mod projection;
pub mod session;
