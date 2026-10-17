//! The `momo.push_candidate.v1` outbox payload.
//!
//! Written by two writers, each in the same transaction as the write that earns
//! the candidate — which is what makes a candidate impossible to lose and
//! impossible to observe before its source commits (ADR-0120 D3):
//! the `push_candidate_enqueue_trg` AFTER INSERT trigger on `message`
//! (`011_push_notifier.sql:47-69`), and the closing write of a streamed message
//! (`momo_outbox::emit_stream_closed_push_candidate`, ADR-0204 증보 1 D8-a). The
//! second writer's rows carry one more key, `source: "stream_closed"`, which this
//! decoder ignores like every key it does not need: judgment reads the *message*, so
//! the notifier handles both writers' rows identically.
//!
//! The payload is id-only *by construction* — both writers emit ids and enum
//! labels, never a body. This decoder therefore reads only the two ids the
//! notifier needs and ignores the rest; it cannot accidentally surface content
//! because there is none to surface.

use serde::Deserialize;
use uuid::Uuid;

/// The fields the notifier consumes from a candidate.
///
/// `author_member_id` and `message_type` are also present on the wire but are
/// re-read from committed state during judgment instead of trusted from the
/// payload, exactly as the Swift original does.
#[derive(Debug, Clone, Deserialize)]
pub struct PushCandidate {
    pub message_id: Uuid,
    pub channel_id: Uuid,
}

impl PushCandidate {
    /// Decode one claimed outbox payload.
    pub fn decode(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_trigger_payload() {
        let raw = r#"{"schema":"momo.push_candidate.v1",
                      "message_id":"0198f0a2-1234-7abc-8def-0123456789ab",
                      "channel_id":"0198f0a2-1234-7abc-8def-0123456789cd",
                      "author_member_id":"0198f0a2-1234-7abc-8def-0123456789ef",
                      "message_type":"text"}"#;
        let candidate = PushCandidate::decode(raw).expect("decode candidate");
        assert_eq!(
            candidate.message_id.hyphenated().to_string(),
            "0198f0a2-1234-7abc-8def-0123456789ab"
        );
        assert_eq!(
            candidate.channel_id.hyphenated().to_string(),
            "0198f0a2-1234-7abc-8def-0123456789cd"
        );
    }

    /// The stream-close writer adds `source`; the decoder must keep reading the same two
    /// ids (ADR-0204 증보 1 D8-a). The literal mirrors
    /// `momo_outbox::stream_closed_candidate_payload` — its key set is pinned there.
    #[test]
    fn decodes_the_stream_close_payload_too() {
        let raw = r#"{"schema":"momo.push_candidate.v1",
                      "message_id":"0198f0a2-1234-7abc-8def-0123456789ab",
                      "channel_id":"0198f0a2-1234-7abc-8def-0123456789cd",
                      "author_member_id":"0198f0a2-1234-7abc-8def-0123456789ef",
                      "message_type":"text",
                      "source":"stream_closed"}"#;
        let candidate = PushCandidate::decode(raw).expect("decode the close candidate");
        assert_eq!(
            candidate.message_id.hyphenated().to_string(),
            "0198f0a2-1234-7abc-8def-0123456789ab"
        );
    }

    #[test]
    fn a_malformed_candidate_is_an_error_not_a_silent_skip() {
        assert!(PushCandidate::decode(r#"{"schema":"momo.push_candidate.v1"}"#).is_err());
    }
}
