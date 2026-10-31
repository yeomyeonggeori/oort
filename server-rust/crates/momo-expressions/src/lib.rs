//! ADR-0218 D1–D3/D6: tenant expression storage. No downloader or agent action.
pub mod action;
pub mod assemble;
pub mod assembly;
pub mod intake;
pub mod media;
pub mod model;
pub mod store;

pub use model::*;
pub use store::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid expression request")]
    Invalid,
    #[error("expression role required")]
    Role,
    #[error("not found")]
    NotFound,
    #[error("expression name reserved")]
    NameReserved,
    #[error("expression quota exceeded")]
    Quota,
    #[error("expression preview stale")]
    Stale,
    #[error("expression draft expired")]
    Expired,
    #[error(transparent)]
    Db(#[from] momo_db::DbError),
}
impl From<sqlx::Error> for Error {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(value.into())
    }
}
