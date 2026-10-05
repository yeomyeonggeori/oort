//! `momo-box-agent` — the host inside an oort personal-cloud box
//! (ADR-0197 D1/D2/D5/D6, milestones M3 and M4).
//!
//! | module | role |
//! |---|---|
//! | [`host`] | registration state, **inactive until the owner confirms**, attach, PTY |
//! | [`register`] | the member-scope registration request and its answer checks |
//! | [`pty`] | the PTY, non-blocking writes, the child at the person's uid with no capabilities |
//! | [`spawn_helper`] | the only process that holds `CAP_SETUID/SETGID`; starts the person's shell, never sees the host key |
//! | [`env`] | the child's environment, built from an allowlist |
//! | [`fsgate`] | the only door to the filesystem; credential paths are refused |
//! | [`preflight`] | separate-uid check, non-dumpable process, no core files |
//! | [`serve`] | outbound only: listen for attach notices, serve one blind-relay session per attach (M4) |
//! | [`boot`] | registration (or the remembered one) and the owner's first device list: from a host key to an active box host (M4) |
//! | [`enroll`] | registration with the server: prove the pairing code by MAC, wait for the runner's attestation (M4) |
//!
//! Not here, on purpose: any ACP code (the box never drives Claude over ACP,
//! D6), the runner (M2).

pub mod boot;
pub mod enroll;
pub mod env;
pub mod fsgate;
pub mod host;
pub mod preflight;
pub mod pty;
pub mod register;
pub mod serve;
pub mod spawn_helper;
