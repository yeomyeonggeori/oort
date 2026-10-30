//! #4820 C2a — the worker's half of the photo address (ADR-0218 증보 G4·G8; owner 10-30 결정 ①).
//!
//! The co-hosted Hermes' picture tool takes its source as `image_url`, and the tool guard
//! (`infra/hermes/plugins/oort-image-guard`) lets exactly one kind of address through: this
//! instance's own `{origin}/v1/self-media/{workspace}/{token}`. This module mints that address for
//! one turn and words the one `system` line that carries it. The token and the rules behind it
//! are `momo_messaging::self_media`'s; this module owns no SQL.
//!
//! * **Per turn, never stored.** The token is minted right before the request is assembled and is
//!   only ever in the request. It is not in the `agent_job` payload, so it is not in the outbox.
//! * **Only a canonical origin.** `OORT_SELF_MEDIA_ORIGIN` is the same value the Hermes service's
//!   guard allows, in the one canonical shape both sides accept; anything else is "off".
//! * **One line, one use.** The sentence says what the address is for and when it dies. It is the
//!   only instruction C2a adds; the rest of the picture guidance is C2b's.

use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{mint_for_run_in_tx, self_media_url, SELF_MEDIA_TTL_SECS};
use uuid::Uuid;

use crate::AgentWorker;

/// The line the model reads. `minutes` is the real lifetime, never a literal that could drift.
pub fn self_media_line_text(url: &str) -> String {
    format!(
        "첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, {}분 뒤 만료: {url}",
        SELF_MEDIA_TTL_SECS / 60
    )
}

impl AgentWorker {
    /// Mint the requester's photo address for this run and word the line, or `None` when there is
    /// nothing to hand over (no origin configured, no picture on the trigger message, or any rule of
    /// the mint not met). An `Err` is a database failure the caller retries.
    pub(crate) async fn self_media_line(
        &self,
        workspace_id: Uuid,
        agent_member_id: Uuid,
        run_id: Uuid,
    ) -> Result<Option<String>, DbError> {
        let Some(origin) = self.config.self_media_origin.as_deref() else {
            return Ok(None);
        };
        let grant = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                mint_for_run_in_tx(conn, workspace_id, run_id, agent_member_id).await
            })
        })
        .await?;
        Ok(grant
            .map(|grant| self_media_line_text(&self_media_url(origin, workspace_id, &grant.token))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_says_what_the_address_is_for_and_how_long_it_lives() {
        let url = "https://oort.example.com/v1/self-media/00000000-0000-0000-0000-000000000000/tok";
        assert_eq!(
            self_media_line_text(url),
            format!("첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, 5분 뒤 만료: {url}")
        );
    }
}
