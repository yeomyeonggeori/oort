//! The `momo.push_candidate.v1` outbox payload.
//!
//! Written transactionally by the message INSERT trigger, stream close, and
//! approval-card settlement (ADR-0204 addendum 6 D6-5). All are id-only.
//! Unlike the first two sources, `approval_settled` must be read by judgment:
//! it addresses the requester alone and must never re-enter the approval/DM arms.

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
    #[serde(default)]
    pub source: Option<String>,
}

impl PushCandidate {
    pub fn is_approval_settlement(&self) -> bool {
        self.source.as_deref() == Some("approval_settled")
    }

    /// A settlement is a different fact from the proposal, so it cannot use
    /// the proposal's dispatch-log key (ADR-0204 addendum 6 D6-5).
    pub fn collapse_id(&self) -> String {
        if self.is_approval_settlement() {
            format!("as:{}", self.message_id)
        } else {
            crate::collapse_id(self.message_id)
        }
    }

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
