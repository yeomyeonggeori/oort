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

/// Why a *signed* send was refused (ADR-0146).
///
/// Separate from [`MessagingError`] because every variant is a caller fault with
/// a distinct client-visible meaning, and because
/// [`crate::message::send_signed_message_in_tx`] must still return [`DbError`]
/// to the `with_tenant_tx` closure — the rejection travels in the `Ok` half, the
/// same split `momo-server`'s route layer already uses for its rejections.
///
/// Refusing is deliberate: a message whose signature does not verify must not be
/// stored *unsigned* either. Silently dropping the assertion would let a sender
/// believe an action was attributed when it was not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProvenanceRejected {
    /// The signature does not verify over the message's canonical bytes under
    /// the signer's registered key.
    #[error("message provenance signature does not verify")]
    SignatureRejected,
    /// The signed bytes bind `client_msg_id`; without one there is nothing to
    /// bind the signature to, and the message surface's replay boundary
    /// (`(channel_id, author_member_id, client_msg_id)` uniqueness) does not
    /// exist for this row.
    #[error("a signed message must carry a clientMsgId")]
    MissingClientMsgId,
    /// A member may sign only its own message: the author is inside the signed
    /// bytes, so a mismatch is either a bug or an attempt to attribute someone
    /// else's speech.
    #[error("a member may only sign its own message")]
    SignerIsNotAuthor,
    /// #1173 — a signed send may not also open a stream.
    ///
    /// The digest is derived from the props **as inserted**
    /// (`crate::message::send_message_with_mentions_in_tx` step 2), and the
    /// opening marker is authored by the server on that same insert — after the
    /// sender signed. So the combination can only ever end in
    /// [`Self::SignatureRejected`], which blames the signature for a key the
    /// signer was never shown. Refusing it by name is the difference between
    /// "these two do not go together" and "your signature is wrong".
    #[error("a signed send cannot also open a stream")]
    SignedStreamOpen,
}

impl From<sqlx::Error> for MessagingError {
    fn from(err: sqlx::Error) -> Self {
        MessagingError::Db(DbError::from(err))
    }
}
