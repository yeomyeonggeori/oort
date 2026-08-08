//! Push domain errors and rejections.
//!
//! Two channels, following the workspace rule stated in
//! `bins/momo-server/src/routes/shared.rs:199-208`: **a rejection is returned
//! before the first write and travels in the `Ok` half; a failure rolls the
//! transaction back.**
//!
//! The one deliberate exception is [`PushError::RegistrationConflict`]. A
//! `23505` from the 010 partial unique index arrives *at* a write, which
//! poisons the PostgreSQL transaction — an aborted transaction cannot be
//! committed, so that outcome cannot ride the `Ok` channel. It is therefore a
//! failure that rolls back, and the route maps it to `409` rather than `500`.

use momo_db::DbError;

/// Failures. Every variant rolls the transaction back.
#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error(transparent)]
    Db(#[from] DbError),

    /// A concurrent registration committed an active token for the same
    /// `(device, env)` (010 `push_token_device_env_active_uniq`) or the same
    /// `(apns_token, env)` (schema_v0 `push_token_uniq`). Retryable: `409`,
    /// never `500` (review #422 L1).
    #[error("concurrent registration for this device — retry")]
    RegistrationConflict,
}

impl From<sqlx::Error> for PushError {
    fn from(error: sqlx::Error) -> Self {
        PushError::Db(DbError::from(error))
    }
}

/// The `23505` unique-violation SQLSTATE.
const SQLSTATE_UNIQUE_VIOLATION: &str = "23505";

/// Classify a write failure: a unique violation on the push-token uniqueness
/// contract is a retryable conflict, anything else is a genuine DB failure.
pub(crate) fn classify_registration_write(error: sqlx::Error) -> PushError {
    if let Some(db_error) = error.as_database_error() {
        if db_error.code().as_deref() == Some(SQLSTATE_UNIQUE_VIOLATION) {
            return PushError::RegistrationConflict;
        }
    }
    PushError::from(error)
}

/// Caller-fault outcomes. These are decided **before** any write, so they
/// travel in the `Ok` half and the transaction commits cleanly (having changed
/// nothing).
///
/// Messages are byte-identical to the Swift originals in
/// `server/Sources/MomoServer/Routes/DeviceRoutes.swift`, because clients
/// surface them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRejection {
    /// The principal has no active membership in this workspace. 403.
    NotActiveMember,
    /// The `device` row exists and belongs to someone else. 403.
    DeviceOwnedByAnotherMember,
    /// An **active** `push_token` with this `(apns_token, env)` belongs to
    /// someone else. 403. An *invalidated* row is reclaimable — that is the
    /// account-switch-on-the-same-phone path.
    TokenOwnedByAnotherMember,
    /// A device's platform is immutable once registered. 409.
    PlatformImmutable,
    /// No such device in this tenant. 404.
    DeviceNotFound,
}

impl DeviceRejection {
    /// The exact Swift message for this rejection.
    pub fn message(self) -> &'static str {
        match self {
            DeviceRejection::NotActiveMember => "member is not active in this workspace",
            DeviceRejection::DeviceOwnedByAnotherMember => "device belongs to another member",
            DeviceRejection::TokenOwnedByAnotherMember => {
                "push token is registered to another member"
            }
            DeviceRejection::PlatformImmutable => "device platform cannot change",
            DeviceRejection::DeviceNotFound => "device not found",
        }
    }
}

/// Request-body validation failures. All 400, all with the Swift message.
///
/// Parity: `DeviceRoutes.swift:384-439`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeviceInputError {
    #[error("deviceId must be a UUID")]
    DeviceId,
    #[error("platform must be ios or macos")]
    Platform,
    #[error("env must be sandbox or production")]
    Env,
    #[error("apnsToken must be a hex device token")]
    ApnsToken,
    #[error("topic must be a bundle id (1-256 chars, no whitespace)")]
    Topic,
    #[error("appBuild must be at most 64 chars")]
    AppBuild,
}
