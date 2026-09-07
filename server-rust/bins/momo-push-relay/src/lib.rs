//! `momo-push-relay` — the APNs hop (ADR-0120 D1-A).
//!
//! A self-hosted momo server cannot hold Apple's `.p8`, so the notifier posts
//! an id-only dispatch here and this process is the only one that talks to
//! `api.push.apple.com`. The wire contract is byte-parity with the notifier
//! client (`momo-notifier` `push_relay.rs`) and the retired Swift relay
//! (`f399e417:relay/PushRelay`).
//!
//! There is no APNs credential in this repository. Live mode reads a `.p8`
//! from a path the operator mounts; stub mode never contacts Apple and
//! refuses to boot without `MOMO_APNS_ALLOW_STUB=1`.

pub mod app;
pub mod config;
pub mod dispatch;
pub mod rate_limit;
pub mod replay;
pub mod sender;

pub use app::{build_router, AppState};
pub use config::{ConfigError, RelayConfig, SenderMode, EX_CONFIG};
pub use dispatch::{ApnsPayload, PushDispatch, DISPATCH_SCHEMA};
pub use sender::{ApnsResult, ApnsSender};

/// sysexits(3) EX_CONFIG. A configuration refusal is an operator message,
/// not a crash trace — compose restart-loops, so the one line that names
/// the missing variable has to survive `docker logs`.
pub const fn config_exit_code() -> i32 {
    EX_CONFIG
}
