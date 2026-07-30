//! Error surface for the messaging domain crate.
//!
//! In-transaction functions (the composable `*_in_tx` seams) return
//! [`momo_db::DbError`] so they slot straight into the
//! [`momo_db::with_tenant_tx`] closure, whose error type is fixed. The
//! pool-level entry points widen that into [`MessagingError`], which adds the
//! domain outcomes a route layer maps onto HTTP status codes.

use momo_db::DbError;

/// Errors returned by the pool-level messaging API.
#[derive(Debug, thiserror::Error)]
pub enum MessagingError {
    /// A database / transaction error (RLS rejection, constraint violation,
    /// connection failure, …). Wraps the shared [`DbError`].
    #[error(transparent)]
    Db(#[from] DbError),

    /// `create_channel` hit the `channel_name_uniq` guard — a non-archived,
    /// non-dm channel with this name already exists in the workspace.
    #[error("channel name already exists in workspace")]
    ChannelNameConflict,
}

impl From<sqlx::Error> for MessagingError {
    fn from(err: sqlx::Error) -> Self {
        MessagingError::Db(DbError::from(err))
    }
}
