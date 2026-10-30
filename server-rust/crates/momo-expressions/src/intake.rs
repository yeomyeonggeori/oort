//! What the two link-and-bytes entry points share (ADR-0218 D5, ADR-0186 v8 X8-1): the
//! outgoing-fetch slots and the verdict on what a received body is. The direct
//! `POST /expressions/import` and the agent action's `url` candidates both use these, so
//! the cap, the format rule and the closed reason codes cannot drift apart.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Semaphore;

use crate::media::{self, Processed, Rejected, Sniffed};

/// Link imports (and action `url` candidates) in flight at once. Each holds up to 5 MiB of
/// fetched bytes and then waits for one of the two decoder slots, and a member can start many
/// in parallel; at the cap the next request is refused before anything is fetched or written.
pub const IMPORTS_IN_FLIGHT: usize = 8;

pub fn import_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(IMPORTS_IN_FLIGHT)))
}

/// What a received body became.
#[derive(Debug)]
pub enum Picture {
    /// A stored-ready picture (three renditions).
    Ready(Box<Processed>),
    /// The one closed reason it did not (ADR-0218 appendix C). A card, never an error.
    Manual(&'static str),
}

/// The decoder had no free slot (and, with a wait, none came free in time). A state of the
/// server that is worth retrying: never a property of the picture and never `source_timeout`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecoderBusy;

/// What a fetched body becomes: a picture, or the one reason it did not. The format is
/// decided by the bytes, never by the `Content-Type` the server claimed. `wait` is how long a
/// busy decoder may be waited for (`None`: refuse at once, the direct import's behaviour).
pub async fn picture_or_reason(
    bytes: Vec<u8>,
    wait: Option<Duration>,
) -> Result<Picture, DecoderBusy> {
    if media::sniff(&bytes) == Sniffed::Unsupported {
        // A web page, SVG, HEIC/AVIF, a script, an empty body: nothing to decode.
        return Ok(Picture::Manual("source_unsupported"));
    }
    let processed = match wait {
        None => media::process(bytes).await,
        Some(wait) => media::process_waiting(bytes, wait).await,
    };
    match processed {
        Ok(processed) => Ok(Picture::Ready(Box::new(processed))),
        Err(Rejected::Video) => Ok(Picture::Manual("video_processing_unavailable")),
        Err(Rejected::TooLarge) => Ok(Picture::Manual("source_too_large")),
        // The decoder's own 10 s budget ran out on this picture: a time limit, which D5
        // answers with a card.
        Err(Rejected::Timeout) => Ok(Picture::Manual("source_timeout")),
        Err(Rejected::Invalid) => Ok(Picture::Manual("source_invalid_media")),
        Err(Rejected::Busy) => Err(DecoderBusy),
    }
}
