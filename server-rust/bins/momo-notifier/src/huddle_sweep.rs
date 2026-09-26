//! The huddle ghost-participant sweep (#2758 / ADR-0122 증보 D-H4).
//!
//! ## Why
//!
//! A client that dies without calling leave — an app crash, a phone losing the
//! network, a laptop lid — leaves its `huddle_participant` row open. The huddle
//! then never ends, and `huddle_channel_active_uniq` blocks a new huddle in that
//! channel: people can only "join" a room with nobody in it.
//!
//! ## Shape
//!
//! D-H4 makes **LiveKit's room state the source of truth for presence** and a
//! server-side sweep the only reader of it: server → LiveKit HTTPS, no new
//! public route. Each tick:
//!
//! 1. one cross-tenant read lists active huddles and their open participant rows
//!    ([`momo_messaging::huddle_sweep::active_huddles_for_sweep`]);
//! 2. for each huddle, LiveKit RoomService `ListParticipants` (room =
//!    `huddle_id`, identity = `member_id`, both uppercase — the grant the API
//!    issues in `momo-server/src/livekit.rs`);
//! 3. a participant missing from **two consecutive** successful observations is
//!    closed, and a huddle whose last participant goes ends — through
//!    [`momo_messaging::huddle_sweep::settle_swept_departures`], one tenant
//!    transaction per huddle, the same end path a person's leave takes.
//!
//! ## What must never happen
//!
//! * **An unreachable LiveKit is not an empty room.** A transport error, a
//!   timeout, a non-2xx or an unparseable body changes nothing — not the rows
//!   and not the miss counts — and logs a warning. Only a successful
//!   `ListParticipants` answer is evidence.
//! * **A participant who has not connected yet is not a ghost.** `join_huddle`
//!   commits the row before the client reaches LiveKit, so rows younger than
//!   [`JOIN_GRACE`] are not counted; a huddle nobody has joined gets the same
//!   grace from `started_at`.
//!
//! LiveKit v1.13.3 answers `ListParticipants` for a room that does not exist
//! with `200 {"participants":[]}` (measured against the pinned
//! `livekit/livekit-server:v1.13.3` image), so "the room is gone" and "the room
//! is empty" are the same observation here. Both end the huddle through the
//! two-miss rule — one tick later than an immediate end, which D-H4 accepts.
//!
//! The miss counts live in this task's memory. A restart forgets them, which
//! only delays a settlement by one tick; it can never cause one.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::Utc;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use momo_db::PgPool;
use momo_messaging::huddle_sweep::{
    active_huddles_for_sweep, settle_swept_departures, SweepHuddle, SweptParticipant,
};
use momo_messaging::HuddleError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Rows (and never-joined huddles) younger than this are not judged: the client
/// may still be connecting to LiveKit.
pub const JOIN_GRACE: Duration = Duration::from_secs(60);
/// Consecutive absent observations before a participant is closed.
pub const MISSES_TO_SETTLE: u8 = 2;
/// Active huddles examined per tick.
const HUDDLE_BATCH: i64 = 500;
/// One `ListParticipants` call may not hold the tick longer than this.
const LIVEKIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Lifetime of the per-call RoomService token.
const ADMIN_TOKEN_TTL_SECONDS: i64 = 60;

/// LiveKit RoomService settings for the sweep.
///
/// Read from the **same three variables** the API uses
/// (`MOMO_LIVEKIT_API_KEY`, `MOMO_LIVEKIT_API_SECRET`, `MOMO_LIVEKIT_URL`) and
/// with the same rule: all three or nothing. `None` means huddles are not
/// configured on this server, and the sweep does not run.
#[derive(Clone)]
pub struct HuddleSweepConfig {
    pub api_key: String,
    api_secret: String,
    /// `http(s)://host[:port]` — the RoomService base derived from the ws URL.
    pub api_base: String,
    pub interval: Duration,
}

impl std::fmt::Debug for HuddleSweepConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HuddleSweepConfig")
            .field("api_key", &"<redacted>")
            .field("api_secret", &"<redacted>")
            .field("api_base", &self.api_base)
            .field("interval", &self.interval)
            .finish()
    }
}

impl HuddleSweepConfig {
    /// All three values present and a `ws(s)://` or `http(s)://` URL, or `None`.
    pub fn parse(
        api_key: Option<&str>,
        api_secret: Option<&str>,
        url: Option<&str>,
        interval: Duration,
    ) -> Option<HuddleSweepConfig> {
        let api_key = api_key.map(str::trim).filter(|v| !v.is_empty())?;
        let api_secret = api_secret.map(str::trim).filter(|v| !v.is_empty())?;
        let url = url.map(str::trim).filter(|v| !v.is_empty())?;
        let lower = url.to_ascii_lowercase();
        let (scheme, rest) = if let Some(rest) = lower.strip_prefix("wss://") {
            ("https://", &url[url.len() - rest.len()..])
        } else if let Some(rest) = lower.strip_prefix("ws://") {
            ("http://", &url[url.len() - rest.len()..])
        } else if let Some(rest) = lower.strip_prefix("https://") {
            ("https://", &url[url.len() - rest.len()..])
        } else if let Some(rest) = lower.strip_prefix("http://") {
            ("http://", &url[url.len() - rest.len()..])
        } else {
            return None;
        };
        let rest = rest.trim_end_matches('/');
        if rest.is_empty() {
            return None;
        }
        Some(HuddleSweepConfig {
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
            api_base: format!("{scheme}{rest}"),
            interval,
        })
    }
}

/// Why an observation could not be made. Every variant means "change nothing".
#[derive(Debug, thiserror::Error)]
pub enum LiveKitError {
    #[error("LiveKit request failed: {0}")]
    Transport(String),
    #[error("LiveKit answered HTTP {0}")]
    Status(u16),
    #[error("LiveKit answer was not a ListParticipants response")]
    Body,
    #[error("RoomService token could not be signed")]
    Token,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminGrant {
    room_admin: bool,
    room: String,
}

#[derive(Serialize)]
struct AdminClaims {
    iss: String,
    sub: String,
    nbf: i64,
    exp: i64,
    video: AdminGrant,
}

#[derive(Deserialize)]
struct ListParticipantsResponse {
    // protojson may omit an empty repeated field.
    #[serde(default)]
    participants: Vec<ParticipantInfo>,
}

#[derive(Deserialize)]
struct ParticipantInfo {
    #[serde(default)]
    identity: String,
}

/// A minimal LiveKit RoomService client: `ListParticipants` only.
#[derive(Clone)]
pub struct LiveKitRoomClient {
    http: reqwest::Client,
    config: HuddleSweepConfig,
}

impl LiveKitRoomClient {
    pub fn new(config: HuddleSweepConfig) -> LiveKitRoomClient {
        let http = reqwest::Client::builder()
            .timeout(LIVEKIT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        LiveKitRoomClient { http, config }
    }

    fn admin_token(&self, room: &str) -> Result<String, LiveKitError> {
        let now = Utc::now().timestamp();
        let claims = AdminClaims {
            iss: self.config.api_key.clone(),
            sub: "momo-notifier".to_string(),
            nbf: now,
            exp: now + ADMIN_TOKEN_TTL_SECONDS,
            video: AdminGrant {
                room_admin: true,
                room: room.to_string(),
            },
        };
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.config.api_secret.as_bytes()),
        )
        .map_err(|_| LiveKitError::Token)
    }

    /// The member ids LiveKit currently has in the huddle's room. Identities
    /// that are not member uuids (egress, a foreign client) are ignored.
    pub async fn list_participants(&self, huddle_id: Uuid) -> Result<HashSet<Uuid>, LiveKitError> {
        let room = huddle_id.to_string().to_uppercase();
        let token = self.admin_token(&room)?;
        let response = self
            .http
            .post(format!(
                "{}/twirp/livekit.RoomService/ListParticipants",
                self.config.api_base
            ))
            .bearer_auth(token)
            .json(&serde_json::json!({ "room": room }))
            .send()
            .await
            .map_err(|error| LiveKitError::Transport(error.without_url().to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(LiveKitError::Status(status.as_u16()));
        }
        let body: ListParticipantsResponse =
            response.json().await.map_err(|_| LiveKitError::Body)?;
        Ok(body
            .participants
            .iter()
            .filter_map(|p| Uuid::parse_str(p.identity.trim()).ok())
            .collect())
    }
}

/// What one sweep tick did — the unit the conformance tests assert on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct HuddleSweepStats {
    /// Active huddles LiveKit was asked about.
    pub huddles_checked: usize,
    /// Huddles skipped because LiveKit could not be observed.
    pub livekit_unreachable: usize,
    /// Absent participants seen once, waiting for a second observation.
    pub first_misses: usize,
    /// Participant rows closed by this tick.
    pub participants_marked_left: usize,
    /// Huddles ended by this tick.
    pub huddles_ended: usize,
    /// Settlements a person's leave or re-join won.
    pub raced: usize,
    /// Settlements whose tenant transaction failed (retried next tick).
    pub failed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum MissKey {
    Participant(Uuid, SweptParticipant),
    EmptyHuddle(Uuid),
}

impl MissKey {
    fn huddle_id(&self) -> Uuid {
        match self {
            MissKey::Participant(huddle_id, _) | MissKey::EmptyHuddle(huddle_id) => *huddle_id,
        }
    }
}

/// The sweep and the miss counts it carries from tick to tick.
pub struct HuddleSweeper {
    client: LiveKitRoomClient,
    misses: HashMap<MissKey, u8>,
}

impl HuddleSweeper {
    pub fn new(config: HuddleSweepConfig) -> HuddleSweeper {
        HuddleSweeper {
            client: LiveKitRoomClient::new(config),
            misses: HashMap::new(),
        }
    }

    /// Bump a miss count and say whether it has reached the settlement bar.
    fn miss(&mut self, key: MissKey, seen: &mut HashSet<MissKey>) -> bool {
        seen.insert(key);
        let count = self.misses.entry(key).or_insert(0);
        *count = count.saturating_add(1);
        *count >= MISSES_TO_SETTLE
    }

    /// One tick. Errors only when the cross-tenant read itself fails.
    pub async fn sweep_once(&mut self, pool: &PgPool) -> Result<HuddleSweepStats, HuddleError> {
        let huddles = active_huddles_for_sweep(pool, HUDDLE_BATCH).await?;
        let mut stats = HuddleSweepStats::default();
        let mut seen: HashSet<MissKey> = HashSet::new();
        let mut unobserved: HashSet<Uuid> = HashSet::new();

        for huddle in huddles {
            stats.huddles_checked += 1;
            let present = match self.client.list_participants(huddle.huddle_id).await {
                Ok(present) => present,
                Err(error) => {
                    // Never read "could not ask" as "nobody is there".
                    stats.livekit_unreachable += 1;
                    unobserved.insert(huddle.huddle_id);
                    tracing::warn!(
                        huddle_id = %huddle.huddle_id,
                        workspace_id = %huddle.workspace_id,
                        error = %error,
                        "huddle sweep could not observe LiveKit; nothing changed"
                    );
                    continue;
                }
            };
            self.judge_and_settle(pool, &huddle, &present, &mut seen, &mut stats)
                .await;
        }

        // Forget counts for rows that are gone (left, settled, huddle ended) —
        // but keep them for huddles this tick could not observe.
        self.misses
            .retain(|key, _| seen.contains(key) || unobserved.contains(&key.huddle_id()));

        if stats.participants_marked_left > 0 || stats.huddles_ended > 0 {
            tracing::info!(
                huddles_checked = stats.huddles_checked,
                participants_marked_left = stats.participants_marked_left,
                huddles_ended = stats.huddles_ended,
                raced = stats.raced,
                "huddle sweep settled ghost participants"
            );
        }
        Ok(stats)
    }

    async fn judge_and_settle(
        &mut self,
        pool: &PgPool,
        huddle: &SweepHuddle,
        present: &HashSet<Uuid>,
        seen: &mut HashSet<MissKey>,
        stats: &mut HuddleSweepStats,
    ) {
        let now = Utc::now();
        let grace = chrono::Duration::from_std(JOIN_GRACE).unwrap_or(chrono::Duration::zero());
        let mut departures = Vec::new();
        let mut end_if_empty = false;

        if huddle.participants.is_empty() {
            if huddle.started_at <= now - grace {
                let key = MissKey::EmptyHuddle(huddle.huddle_id);
                if self.miss(key, seen) {
                    end_if_empty = true;
                } else {
                    stats.first_misses += 1;
                }
            }
        } else {
            for participant in &huddle.participants {
                let key = MissKey::Participant(huddle.huddle_id, *participant);
                if present.contains(&participant.member_id) {
                    // Present: the count resets by not being carried forward.
                    continue;
                }
                if participant.joined_at > now - grace {
                    continue;
                }
                if self.miss(key, seen) {
                    departures.push(*participant);
                } else {
                    stats.first_misses += 1;
                }
            }
        }

        if departures.is_empty() && !end_if_empty {
            return;
        }

        match settle_swept_departures(
            pool,
            huddle.workspace_id,
            huddle.huddle_id,
            departures.clone(),
            end_if_empty,
        )
        .await
        {
            Ok(settlement) => {
                stats.participants_marked_left += settlement.marked_left.len();
                if settlement.ended {
                    stats.huddles_ended += 1;
                }
                if settlement.raced {
                    stats.raced += 1;
                }
                for departure in &departures {
                    self.misses
                        .remove(&MissKey::Participant(huddle.huddle_id, *departure));
                }
                self.misses.remove(&MissKey::EmptyHuddle(huddle.huddle_id));
            }
            Err(error) => {
                // Keep the counts: the next tick retries the same settlement.
                stats.failed += 1;
                tracing::warn!(
                    huddle_id = %huddle.huddle_id,
                    workspace_id = %huddle.workspace_id,
                    error = %error,
                    "huddle sweep settlement failed for a huddle"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_secs(30);

    #[test]
    fn livekit_is_configured_only_as_a_complete_unit() {
        assert!(HuddleSweepConfig::parse(None, None, None, TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some("k"), Some("s"), None, TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some("k"), None, Some("wss://lk"), TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some(" "), Some("s"), Some("wss://lk"), TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some("k"), Some("s"), Some("lk:7880"), TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some("k"), Some("s"), Some("ftp://lk"), TICK).is_none());
        assert!(HuddleSweepConfig::parse(Some("k"), Some("s"), Some("wss://"), TICK).is_none());
    }

    #[test]
    fn the_client_url_maps_to_the_room_service_base() {
        let base = |url: &str| {
            HuddleSweepConfig::parse(Some("k"), Some("s"), Some(url), TICK)
                .expect("complete config")
                .api_base
        };
        assert_eq!(base("wss://LiveKit.example/"), "https://LiveKit.example");
        assert_eq!(base("ws://127.0.0.1:7880"), "http://127.0.0.1:7880");
        assert_eq!(base("WSS://livekit.example"), "https://livekit.example");
        assert_eq!(base("https://livekit.example"), "https://livekit.example");
    }

    #[test]
    fn debug_never_prints_credentials() {
        let config = HuddleSweepConfig::parse(
            Some("key-visible-nowhere"),
            Some("super-secret-livekit-value"),
            Some("wss://livekit.example"),
            TICK,
        )
        .unwrap();
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("super-secret-livekit-value"));
        assert!(!rendered.contains("key-visible-nowhere"));
    }

    #[test]
    fn the_room_service_token_is_a_room_admin_grant_for_that_room_only() {
        use jsonwebtoken::{decode, DecodingKey, Validation};
        #[derive(Deserialize)]
        struct Claims {
            iss: String,
            video: serde_json::Value,
        }
        let config =
            HuddleSweepConfig::parse(Some("key"), Some("secret"), Some("ws://lk"), TICK).unwrap();
        let client = LiveKitRoomClient::new(config);
        let token = client.admin_token("ROOM-A").unwrap();
        let claims = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(b"secret"),
            &Validation::new(Algorithm::HS256),
        )
        .expect("verify token")
        .claims;
        assert_eq!(claims.iss, "key");
        assert_eq!(
            claims.video,
            serde_json::json!({"roomAdmin": true, "room": "ROOM-A"})
        );
    }
}
