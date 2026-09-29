//! Team memory v2 M2 — the SQL half of item extraction (#3168, ADR-0196 D3/D4/D6).
//!
//! The summary worker asks the model for `{summary, items[]}` in one call (see
//! `momo-agent-worker`'s `extract` module). This module is what happens after the model
//! answered and the items were validated: each survivor is added, **add-only**, through the
//! worker-only SQL function `mem_add_item` inside the same memory tx as `mem_apply_digest`.
//!
//! `mem_add_item` re-validates everything the worker checked (evidence is a subset of the
//! digest's evidence, live, unedited since the read, human-authored; switches; secret-shaped
//! text) — the worker's checks decide what to *send*, the database decides what to *keep*.
//!
//! Errors are classified by SQLSTATE like [`crate::memory::ApplyFailure`]: `40001` (an
//! evidence message was edited after the read) and `23503` (one is gone) abort the whole tx so
//! the worker re-reads; `55000` (a switch flipped) aborts too; `23514` (this item's content
//! was refused) rolls back to a savepoint and only that item is dropped.

use momo_db::{DbError, PgConnection};
use uuid::Uuid;

use crate::memory::sqlstate;

/// Bumped whenever the extraction prompt, the item shape or the validation changes; stored on
/// every item (`mem_item.extractor_version`) so a regression can be traced to a prompt.
pub const EXTRACTOR_VERSION: &str = "items-v1";

/// One validated candidate, ready to be written.
#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    /// `decision` | `fact` | `commitment`.
    pub kind: &'static str,
    pub body: String,
    pub subject_key: Option<String>,
    /// The messages the item rests on (a subset of the digest's evidence).
    pub evidence: Vec<Uuid>,
    pub confidence: f32,
    /// "Today / this week" state and single-shot inference: `forget_after` = 14 days.
    pub ephemeral: bool,
}

/// What became of one candidate at the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemOutcome {
    Added(Uuid),
    /// The same content is already remembered for this channel.
    Duplicate,
    /// The database refused this item's content (SQLSTATE `23514`); the digest is unaffected.
    Refused,
}

/// Add one item. Runs inside a savepoint, so a refused item (`23514`) leaves the surrounding
/// memory tx — the digest, the other items, the cursor — intact. Every other failure is
/// returned as an error and aborts the tx (the worker's classifier handles it).
pub async fn add_item(
    conn: &mut PgConnection,
    digest_id: Uuid,
    item: &NewItem,
    model: &str,
) -> Result<ItemOutcome, DbError> {
    sqlx::query("SAVEPOINT mem_add_item")
        .execute(&mut *conn)
        .await?;
    let result = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT mem_add_item($1, $2, $3, $4, $5, $6::real, $7, $8, $9)",
    )
    .bind(digest_id)
    .bind(item.kind)
    .bind(&item.body)
    .bind(item.subject_key.as_deref())
    .bind(&item.evidence)
    .bind(item.confidence)
    .bind(item.ephemeral)
    .bind(EXTRACTOR_VERSION)
    .bind(model)
    .fetch_one(&mut *conn)
    .await;
    match result {
        Ok(id) => {
            sqlx::query("RELEASE SAVEPOINT mem_add_item")
                .execute(&mut *conn)
                .await?;
            Ok(id.map_or(ItemOutcome::Duplicate, ItemOutcome::Added))
        }
        Err(error) => {
            let error = DbError::from(error);
            if sqlstate(&error).as_deref() == Some("23514") {
                sqlx::query("ROLLBACK TO SAVEPOINT mem_add_item")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT mem_add_item")
                    .execute(&mut *conn)
                    .await?;
                Ok(ItemOutcome::Refused)
            } else {
                Err(error)
            }
        }
    }
}
