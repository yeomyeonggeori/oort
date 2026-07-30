//! `momo-auth` — authentication foundation.
//!
//! Ports the two credential surfaces the server authenticates:
//!   * App JWT (HS256, `sub=member_id`, `ws`, `scopes`, `typ`) → [`jwt`]
//!     (Swift `Auth/JWT.swift`, `Auth/AuthMiddleware.swift`).
//!   * WorkHost Ed25519 request signature → [`workhost`], which verifies via the
//!     shared `momo-wire` format (no duplicated format string).
//!
//! B0 scope: JWT verify skeleton + [`Principal`] + WorkHost verify wrapper. The
//! DB-backed revocation check (MOMO-300 `token` table) and the full middleware
//! wiring are B1 — noted at the call sites.

pub mod jwt;
pub mod workhost;

pub use jwt::{verify_app_access, AppClaims, AuthError, Principal, PrincipalKind};
pub use workhost::verify_work_host_request;
