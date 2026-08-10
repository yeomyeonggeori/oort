//! The ephemeral signal vocabulary — ADR-0149 guard 2 (「봉인된 페이로드 타입」)
//! and the v0 scope (「작성 중」 and nothing else).
//!
//! Everything a subscriber needs to forget the signal is in the signal: the
//! payload carries its own `expires_at`, so no server anywhere holds a map of
//! "who is currently typing" (guard 4). A server that held that map would be
//! holding state that does not survive a restart, which is the definition of a
//! bug rather than a feature.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use uuid::Uuid;

/// The Centrifugo namespace ephemeral signals live in.
///
/// Guard 1: a subscriber must be able to tell an ephemeral publication from a
/// durable one **by channel name alone**, so this never shares `ch`/`dm`. The
/// namespace is configured with `history_size: 0` in every environment — a
/// reconnect that replayed yesterday's 「작성 중」 would render a ghost.
pub const EPHEMERAL_NAMESPACE: &str = "typing";

/// The `data.type` of the one signal v0 opens.
pub const TYPING_EVENT_TYPE: &str = "ephemeral.typing";

/// Envelope version, incremented only by a wire change.
pub const TYPING_EVENT_VERSION: i64 = 1;

/// The Centrifugo namespace availability(②) signals live in (ADR-0160).
///
/// A **second** ephemeral namespace, separate from `typing`, for the same reason
/// `typing` is separate from `ch`: a subscriber must be able to tell an
/// availability heartbeat from a 「작성 중」 (and from a durable message) **by
/// channel name alone**, and a client that wants presence need not also take on
/// every channel's typing traffic. Like `typing` it is `history_size: 0` in
/// every environment — a replayed "online" on reconnect would render a ghost who
/// left an hour ago.
pub const PRESENCE_NAMESPACE: &str = "presence";

/// The `data.type` of the availability(②) signal (ADR-0160 D1).
pub const PRESENCE_EVENT_TYPE: &str = "ephemeral.presence";

/// Envelope version, incremented only by a wire change.
pub const PRESENCE_EVENT_VERSION: i64 = 1;

/// How long a received availability signal stays live before the client drops
/// the member to offline, in milliseconds.
///
/// Sized against [`PRESENCE_REPUBLISH_INTERVAL_MS`] the same way the typing pair
/// is: two republish periods, so a single dropped heartbeat cannot blink someone
/// offline while they are still connected. Availability is a far lower-frequency
/// axis than keystrokes — a client republishes only while its own connection is
/// up (ADR-0160 미결 #1: the availability source is the connection edge, not a
/// server idle timer) — so the whole band is an order of magnitude slower than
/// typing.
pub const PRESENCE_SIGNAL_TTL_MS: i64 = 90_000;

/// How often a still-connected client re-posts its availability, in
/// milliseconds. Well above typing's 3s: this is "I am still here", not "I am
/// still typing", and at connection scale (multi-device, network flaps) it is
/// the axis P14 warns is the most expensive ambient traffic, so it is published
/// as sparsely as the TTL allows.
pub const PRESENCE_REPUBLISH_INTERVAL_MS: i64 = 40_000;

/// The two presence numbers are a **pair**, checked by the compiler like the
/// typing pair: a TTL shorter than two republish periods makes one dropped
/// heartbeat blink a live member offline.
const _: () = assert!(
    PRESENCE_SIGNAL_TTL_MS >= PRESENCE_REPUBLISH_INTERVAL_MS * 2,
    "the availability TTL must cover two republish periods, or one dropped heartbeat blinks a live member offline"
);

/// How long a received 「작성 중」 stays live on the client, in milliseconds.
///
/// 6s is chosen against [`TYPING_REPUBLISH_INTERVAL_MS`], not in isolation: it
/// is **two republish periods**, so a single dropped publish (a lost packet, a
/// GC pause, one 429) cannot blank an indicator for someone who is still
/// typing. One period would make every hiccup visible as a flicker; much more
/// would leave the indicator lit long after the person walked away, which is
/// the failure mode people describe as "it lies".
pub const TYPING_SIGNAL_TTL_MS: i64 = 6_000;

/// How often a client that is still typing re-posts, in milliseconds.
///
/// 3s is the floor at which a person does not feel the indicator "cut out"
/// (Slack, iMessage and WhatsApp all sit in the 3–5s band), and it is also the
/// ceiling on how much traffic one typist can generate: 20 publishes a minute,
/// which is what [`crate::publisher`]'s rate limit is sized against. Below ~2s
/// this becomes keystroke telemetry, which is a different feature with a
/// different privacy story.
pub const TYPING_REPUBLISH_INTERVAL_MS: i64 = 3_000;

/// The two numbers above are a **pair**, not independent knobs, and the pairing
/// is checked by the compiler rather than by a test: an expiry shorter than two
/// republish periods makes one dropped publish visible as a flicker, and a
/// cadence under ~2s stops being a presence hint and becomes keystroke
/// telemetry — a different feature with a different privacy story. Retune one
/// of them alone and this file no longer builds.
const _: () = assert!(
    TYPING_SIGNAL_TTL_MS >= TYPING_REPUBLISH_INTERVAL_MS * 2,
    "the signal TTL must cover two republish periods, or one dropped publish blanks the indicator"
);
const _: () = assert!(
    TYPING_REPUBLISH_INTERVAL_MS >= 2_000,
    "a republish cadence under 2s is keystroke telemetry, not a presence hint"
);

/// From how many simultaneous typists a client collapses names into a count.
///
/// The **server never aggregates** — it holds no state, so it does not know how
/// many people are typing (guard 4). It publishes one signal per person and the
/// client counts the live ones: 1 → "김성재 님이 작성 중", 2 → both names,
/// 3+ → "3명이 작성 중". Three is where the two-name form stops fitting a
/// composer-width line in Korean, and where individual names stop being the
/// information anyone actually wants.
pub const TYPING_AGGREGATE_THRESHOLD: u32 = 3;

/// Milliseconds since the unix epoch.
pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// The Centrifugo channel an ephemeral signal is published to.
///
/// Same shape and same UPPERCASE casing as `momo_messaging::cent_channel`
/// (Foundation `UUID.uuidString`), so `routes::realtime::parse_channel` can
/// authorize a `typing:` subscribe with the very same predicate it uses for the
/// `ch:` it shadows. A different casing here would make the two disagree and
/// the rail would be silent with no error anywhere.
pub fn ephemeral_channel(workspace_id: Uuid, channel_id: Uuid) -> String {
    format!(
        "{EPHEMERAL_NAMESPACE}:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        channel_id.to_string().to_uppercase()
    )
}

/// The Centrifugo channel an availability(②) signal is published to (ADR-0160).
///
/// Same `ws<WS>.<CHANNEL>` shape and same UPPERCASE casing as
/// [`ephemeral_channel`] and `momo_messaging::cent_channel`, so
/// `routes::realtime::parse_channel` authorizes a `presence:` subscribe with the
/// **same predicate** it uses for the `ch:`/`typing:` it shadows (ADR-0160 D5:
/// 가용성 구독은 채널 멤버십 검사를 재사용한다). A different casing here would
/// make the two disagree and the rail would be silent with no error anywhere.
pub fn ephemeral_presence_channel(workspace_id: Uuid, channel_id: Uuid) -> String {
    format!(
        "{PRESENCE_NAMESPACE}:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        channel_id.to_string().to_uppercase()
    )
}

/// One person is composing in one channel, until `expires_at_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypingSignal {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    /// The **human** member composing. ADR-0149 keeps agents out of this
    /// vocabulary on purpose: an agent that is working says so through its
    /// `agent_run` row, which is durable. 사람은 작성 중, 에이전트는 작업 중.
    pub member_id: Uuid,
    pub sent_at_ms: i64,
    pub expires_at_ms: i64,
}

impl TypingSignal {
    /// Build the signal a publish at `now_ms` carries.
    pub fn starting_at(
        workspace_id: Uuid,
        channel_id: Uuid,
        member_id: Uuid,
        now_ms: i64,
        ttl_ms: i64,
    ) -> TypingSignal {
        TypingSignal {
            workspace_id,
            channel_id,
            member_id,
            sent_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(ttl_ms.max(1)),
        }
    }
}

/// One person is available (their client is connected) in one channel, until
/// `expires_at_ms` (ADR-0160 ② 가용성).
///
/// The signal carries no `available: bool`: **presence of a live signal is the
/// availability**, and its expiry is the offline transition, exactly like a
/// [`TypingSignal`] whose absence means "stopped typing". A client publishes
/// this while its own connection is up and stops when it drops, so the server
/// holds no idle timer and no map of who is online (ADR-0149 guard 4, inherited).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceSignal {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    /// The **human** member who is available. ADR-0160 D4 keeps agents out of
    /// this vocabulary on purpose: an agent's liveness is its `agent_run`, which
    /// is durable. 사람은 온라인, 에이전트는 작업 중.
    pub member_id: Uuid,
    pub sent_at_ms: i64,
    pub expires_at_ms: i64,
}

impl PresenceSignal {
    /// Build the availability signal a publish at `now_ms` carries.
    pub fn starting_at(
        workspace_id: Uuid,
        channel_id: Uuid,
        member_id: Uuid,
        now_ms: i64,
        ttl_ms: i64,
    ) -> PresenceSignal {
        PresenceSignal {
            workspace_id,
            channel_id,
            member_id,
            sent_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(ttl_ms.max(1)),
        }
    }
}

/// **The complete vocabulary of things this server may publish outside the
/// outbox** (ADR-0149 guard 2).
///
/// There is no `Custom(Value)`, no `raw`, and no `impl From<Value>`: widening
/// what can travel the ephemeral rail means adding a variant here, and a new
/// variant is a diff a reviewer sees. That is the entire point — the guard is
/// worth nothing if the publisher accepts arbitrary JSON. ADR-0160 ② adds the
/// second variant, `Presence`, and inherits every guard the first one proved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EphemeralSignal {
    Typing(TypingSignal),
    Presence(PresenceSignal),
}

impl EphemeralSignal {
    pub fn channel(&self) -> String {
        match self {
            EphemeralSignal::Typing(signal) => {
                ephemeral_channel(signal.workspace_id, signal.channel_id)
            }
            EphemeralSignal::Presence(signal) => {
                ephemeral_presence_channel(signal.workspace_id, signal.channel_id)
            }
        }
    }

    /// The `data` object Centrifugo forwards verbatim to subscribers.
    ///
    /// Shaped like every other momo broadcast (`{type, v, ts, payload}`) so a
    /// client's existing envelope reader handles it, with two deliberate
    /// absences:
    ///
    /// * **no `seq`** — an ephemeral signal does not consume a `message.seq`
    ///   (invariant #4). The key is missing rather than null so a client that
    ///   orders by seq cannot accidentally treat this as a gap;
    /// * **no `idempotency_key` / `version`** — the namespace keeps no history,
    ///   so there is nothing to deduplicate against and nothing to recover.
    pub fn data(&self) -> Value {
        match self {
            EphemeralSignal::Typing(signal) => json!({
                "type": TYPING_EVENT_TYPE,
                "v": TYPING_EVENT_VERSION,
                "ts": signal.sent_at_ms,
                "payload": {
                    "workspace_id": signal.workspace_id.to_string().to_uppercase(),
                    "channel_id": signal.channel_id.to_string().to_uppercase(),
                    "member_id": signal.member_id.to_string().to_uppercase(),
                    // Milliseconds, like `thread.updated`'s `last_reply_at`.
                    // This is the whole of guard 4's client contract: the
                    // subscriber forgets the signal at this instant without
                    // being told to.
                    "expires_at": signal.expires_at_ms,
                },
            }),
            // Same envelope shape and the same two deliberate absences (no `seq`,
            // no `version`/`idempotency_key`) as `Typing` — availability is as
            // ephemeral as 「작성 중」 and consumes no `message.seq` (invariant #4).
            // The one different field is the `type`, which is how a subscriber
            // tells an availability heartbeat apart from a typing one.
            EphemeralSignal::Presence(signal) => json!({
                "type": PRESENCE_EVENT_TYPE,
                "v": PRESENCE_EVENT_VERSION,
                "ts": signal.sent_at_ms,
                "payload": {
                    "workspace_id": signal.workspace_id.to_string().to_uppercase(),
                    "channel_id": signal.channel_id.to_string().to_uppercase(),
                    "member_id": signal.member_id.to_string().to_uppercase(),
                    "expires_at": signal.expires_at_ms,
                },
            }),
        }
    }

    pub fn expires_at_ms(&self) -> i64 {
        match self {
            EphemeralSignal::Typing(signal) => signal.expires_at_ms,
            EphemeralSignal::Presence(signal) => signal.expires_at_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The name is the guard: a subscriber separates ephemeral from durable by
    /// namespace, and the ids keep the casing every other momo channel uses.
    #[test]
    fn the_ephemeral_channel_is_its_own_namespace_in_the_shared_casing() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let name = ephemeral_channel(workspace, channel);
        assert_eq!(
            name,
            format!(
                "typing:ws{}.{}",
                workspace.to_string().to_uppercase(),
                channel.to_string().to_uppercase()
            )
        );
        assert!(!name.starts_with("ch:"), "never inside the durable rail");
        assert!(!name.starts_with("dm:"));
    }

    /// Invariant #4, asserted on the wire rather than argued in a comment.
    #[test]
    fn a_typing_signal_carries_no_seq_and_no_recovery_metadata() {
        let signal = EphemeralSignal::Typing(TypingSignal::starting_at(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            1_700_000_000_000,
            TYPING_SIGNAL_TTL_MS,
        ));
        let data = signal.data();
        assert_eq!(data["type"], json!(TYPING_EVENT_TYPE));
        assert!(
            data.get("seq").is_none(),
            "an ephemeral signal must not consume message.seq: {data}"
        );
        assert!(data["payload"].get("seq").is_none(), "{data}");
        assert!(data.get("version").is_none(), "{data}");
        assert!(data.get("idempotency_key").is_none(), "{data}");
    }

    /// Guard 4: the client is told when to forget, so the server never has to
    /// remember.
    #[test]
    fn the_payload_carries_its_own_expiry() {
        let now = 1_700_000_000_000;
        let signal = EphemeralSignal::Typing(TypingSignal::starting_at(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            now,
            TYPING_SIGNAL_TTL_MS,
        ));
        assert_eq!(signal.expires_at_ms(), now + TYPING_SIGNAL_TTL_MS);
        assert_eq!(
            signal.data()["payload"]["expires_at"],
            json!(now + TYPING_SIGNAL_TTL_MS)
        );
    }

    #[test]
    fn a_zero_or_negative_ttl_cannot_produce_an_already_expired_signal() {
        let signal = TypingSignal::starting_at(Uuid::nil(), Uuid::nil(), Uuid::nil(), 100, 0);
        assert!(signal.expires_at_ms > signal.sent_at_ms);
    }

    /// ADR-0160 ②: availability rides its own namespace, distinct from `typing`
    /// and never inside the durable rail. Same casing as every other channel.
    #[test]
    fn the_presence_channel_is_its_own_namespace_in_the_shared_casing() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let name = ephemeral_presence_channel(workspace, channel);
        assert_eq!(
            name,
            format!(
                "presence:ws{}.{}",
                workspace.to_string().to_uppercase(),
                channel.to_string().to_uppercase()
            )
        );
        assert!(!name.starts_with("ch:"), "never inside the durable rail");
        assert!(!name.starts_with("typing:"), "not the typing rail either");
        // The two ephemeral rails must not collide, or one subscription would
        // carry the other's traffic.
        assert_ne!(name, ephemeral_channel(workspace, channel));
    }

    /// Availability is as ephemeral as 「작성 중」: no `seq`, no recovery
    /// metadata, and a `type` that names it apart from typing.
    #[test]
    fn a_presence_signal_carries_no_seq_and_names_itself_apart_from_typing() {
        let signal = EphemeralSignal::Presence(PresenceSignal::starting_at(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            1_700_000_000_000,
            PRESENCE_SIGNAL_TTL_MS,
        ));
        let data = signal.data();
        assert_eq!(data["type"], json!(PRESENCE_EVENT_TYPE));
        assert_ne!(
            data["type"],
            json!(TYPING_EVENT_TYPE),
            "a subscriber must tell availability from 작성 중 by the type"
        );
        assert!(data.get("seq").is_none(), "{data}");
        assert!(data["payload"].get("seq").is_none(), "{data}");
        assert!(data.get("version").is_none(), "{data}");
        assert!(data.get("idempotency_key").is_none(), "{data}");
        assert_eq!(
            data["payload"]["expires_at"],
            json!(1_700_000_000_000_i64 + PRESENCE_SIGNAL_TTL_MS)
        );
    }
}
