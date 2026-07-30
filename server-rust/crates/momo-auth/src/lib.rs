//! `momo-auth` — authentication foundation.
//!
//! Ports the two credential surfaces the server authenticates:
//!   * App JWT (HS256, `sub=member_id`, `ws`, `scopes`, `typ`) → [`jwt`]
//!     (Swift `Auth/JWT.swift`, `Auth/AuthMiddleware.swift`).
//!   * WorkHost Ed25519 request signature → [`workhost`], which verifies via the
//!     shared `momo-wire` format (no duplicated format string).
//!
//! B0 scope: JWT verify skeleton + [`Principal`] + WorkHost verify wrapper.
//! B1.5 adds the other half of the App-JWT story: issuance ([`issue`]) and the
//! MOMO-300 **revocation check** ([`token_store`]) — the `token` table row that
//! turns "this was signed once" into "this session is still alive". Signature
//! and row are checked together by the server's middleware, exactly as Swift
//! `AuthMiddleware` does (verify → `requireActive`).
//!
//! This crate owns `token` SQL and nothing else DB-shaped: [`token_store`] takes
//! a caller-supplied `&mut PgConnection`, so the RLS GUC seam stays solely in
//! `momo_db::with_tenant_tx` (invariant #6).

pub mod issue;
pub mod jwt;
pub mod token_store;
pub mod workhost;

pub use issue::{
    sign_access, sign_app_token, sign_refresh, IssuedToken, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS,
};
pub use jwt::{verify_app_access, AppClaims, AuthError, Principal, PrincipalKind};
pub use token_store::{
    record_session_token, token_state, TokenRejection, TokenState, SESSION_LABEL_ACCESS,
    SESSION_LABEL_REFRESH,
};
pub use workhost::verify_work_host_request;
