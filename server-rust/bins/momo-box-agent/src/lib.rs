//! `momo-box-agent` — the host inside an oort personal-cloud box
//! (ADR-0197 D1/D2/D5/D6, milestone M3).
//!
//! | module | role |
//! |---|---|
//! | [`host`] | registration state, **inactive until the owner confirms**, attach, PTY |
//! | [`register`] | the member-scope registration request and its answer checks |
//! | [`pty`] | `openpty`, the child at the person's uid, no capabilities |
//! | [`env`] | the child's environment, built from an allowlist |
//! | [`fsgate`] | the only door to the filesystem; credential paths are refused |
//! | [`preflight`] | separate-uid check, non-dumpable process, no core files |
//!
//! Not here, on purpose: any ACP code (the box never drives Claude over ACP,
//! D6), the relay route (M4), the runner (M2).

pub mod env;
pub mod fsgate;
pub mod host;
pub mod preflight;
pub mod pty;
pub mod register;
