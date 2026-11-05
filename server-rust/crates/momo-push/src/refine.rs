//! The judgment's Rust tail — ADR-0206 D16 step 6 「지연·취소」 (D4, #4497).
//!
//! [`crate::judgment::judge_targets`] (one SQL statement) picks **who** gets a push and **why**, and
//! never reads a body (I2). The facts that depend on the clock — is this person's desktop in use
//! right now, have they read the message — are not that statement's business: they live in this tail
//! (D16), on the target list the statement already produced (a few dozen rows at most), so that the
//! diagnostics and any preview can call the same function (P9: no per-platform re-implementation).
//!
//! # The phone delay (D4)
//!
//! A web or desktop client that is in front and was used in the last five minutes beats
//! `PUT …/presence/activity` (≤ 20 s apart); the server reads a stamp younger than **30 s** as "this
//! person's desktop is active" ([`ACTIVITY_WINDOW_SECS`]). For such a person, the *phone* targets of
//! a general-message reason ([`is_delayable_reason`]) are split three ways, per member, from facts
//! the database answers on **its own clock** (`T` is the candidate row's `created_at`, the same
//! clock the outbox's `available_at` runs on):
//!
//! | outcome | when | what happens |
//! |---|---|---|
//! | **cancel** | active at `T − 30 s` **and** read (below) | no push, **no dispatch row** (they read it) — first judgment or re-judgment alike |
//! | **hold** | active within the last 30 s, not read, and `now() < T + phoneDelaySecs` | not sent this pass, no dispatch row; the caller defers the candidate to the earliest expiry |
//! | **send** | anything else | sent now, exactly as before |
//!
//! There is **no "already delayed once" flag**: after the expiry the hold predicate is simply false,
//! so a person who is still active and still has not read it gets the push (one delay only), and a
//! re-judged target that was already sent is skipped by `claim_dispatch`, not here.
//!
//! # What "read" means (D4, and ADR-0204 증보 1 D8-a for a streamed line)
//!
//! For an ordinary message: the member's cursor in the channel covers the message's `seq`.
//!
//! A **streamed** line (`props` carries the `momo.stream` block — the same test the judgment's
//! answer arm makes) spends its `seq` when its *first words* arrive, so a cursor that covers it says
//! "they saw it begin", not "they are still there": the judgment deliberately gives such a line no
//! `last_read_seq >= seq` shortcut (D8-a, `judgment.rs`). The cancel follows that exception: for a
//! streamed line the cursor covering the `seq` is necessary but **not sufficient** — the person must
//! also have been reading the channel in the 30 s window before `T` (the cursor moved
//! in it, or the channel-viewing beat is inside it: a stream spends no further `seq`, so the beat
//! is the only thing that says someone watched it to its end). `T` of a stream-closed candidate is the
//! closed time, so this is "reading when the answer closed", and — like the rest of the cancel — it
//! is anchored on `T`, not on `now()`, so a person who read it inside the delay is still cancelled at
//! the expiry. Without the window a person who walked away mid-stream would be cancelled on a cursor
//! that only ever saw the first words, and the closed answer's push would never go out (#5353).
//!
//! # The delay is capped at five minutes
//!
//! The settings API only accepts 0, 60 and 300, but `notification_rule.phone_delay_secs` is a bare
//! `smallint` with no CHECK, so "a delay can never lock a push out for good" must not rest on the
//! writer: the tail reads every stored value through [`PHONE_DELAY_MAX_SECS`] (and a negative one as 0).
//!
//! `phoneDelaySecs = 0` is "no delay and no read-cancel" — today's behavior. No row in
//! `member_activity` (an old client, a phone-only person) is "not active" — also today's behavior.
//! Urgent reasons (an approval, the work reasons, `resume_offer`, the test notification, anything a
//! later slice adds) are **not on the allow-list** and so are never delayed: the safe default of a
//! new reason is "now". `macos` tokens are never delayed.
//!
//! The tail only **reads** (`member_activity`, `notification_rule`, `read_state`, `channel_viewing`, `message`). Nothing
//! in the dispatch log, nothing in the outbox: the outbox is [`momo_outbox`]'s, and the caller turns
//! [`Refined::hold_until`] into `defer_push_candidate`.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use momo_messaging::STREAM_PROPS_KEY;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::candidate::PushCandidate;
use crate::dispatch::PushReason;
use crate::judgment::{JudgedTarget, WORK_COMPLETE_FOREGROUND_WINDOW_SECS};

/// A `member_activity.seen_at` younger than this is "my desktop is active" (ADR-0206 D4). The writer
/// refreshes at least every 5 s while a client beats every ≤ 20 s, so a present user never reads as
/// absent.
pub const ACTIVITY_WINDOW_SECS: f64 = 30.0;

/// What a NULL `notification_rule.phone_delay_secs` reads as (ADR-0206 D4 「기본 60」, D13). A person
/// with no `notification_rule` row at all reads the same way.
pub const PHONE_DELAY_DEFAULT_SECS: i32 = 60;

/// The longest a phone push is held back (ADR-0206 D4 「최대 300초」, the top of the settings API's
/// {0, 60, 300}). Every stored `phone_delay_secs` is read through it: the column is a bare
/// `smallint`, so a value written any way but the API (a later writer, a direct write) would
/// otherwise hold a push for up to nine hours (#5353).
pub const PHONE_DELAY_MAX_SECS: i32 = 300;

/// The window a *streamed* line's read is measured in, before `T`: the judgment's answer-arm reading
/// window itself (ADR-0204 D8, 「30초 안에 움직였으면」), bound from the same constant so the two cannot
/// drift apart by accident. It is deliberately not [`ACTIVITY_WINDOW_SECS`]: the desktop-activity
/// window and the reading window are different questions that happen to share a number today.
const STREAM_READ_WINDOW_SECS: f64 = WORK_COMPLETE_FOREGROUND_WINDOW_SECS;

/// The only device platform the delay applies to: the phone (`device.platform = 'ios'`). A `macos`
/// token is the desktop's own and is left as it is.
const PHONE_PLATFORM: &str = "ios";

/// Whether a wire reason may be delayed (ADR-0206 D4 「지연 대상」). An **allow-list on purpose**:
/// `approval_request`, `work_*`, `resume_offer`, `test_notification` and every reason a later slice
/// adds stay immediate until someone decides otherwise here. `channel_message` and `keyword` join
/// when N1·N5 add them to [`PushReason`].
pub fn is_delayable_reason(reason: PushReason) -> bool {
    matches!(
        reason,
        PushReason::Mention | PushReason::Dm | PushReason::ThreadReply
    )
}

/// Whether the delay looks at this target at all: a phone token with a general-message reason.
fn is_subject(target: &JudgedTarget) -> bool {
    target.device_platform == PHONE_PLATFORM && is_delayable_reason(target.reason)
}

/// What the database said about one member, on its own clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemberFacts {
    /// The member's `phoneDelaySecs` (0, 60 or 300; NULL read as [`PHONE_DELAY_DEFAULT_SECS`], any
    /// other stored value cut into `0..=`[`PHONE_DELAY_MAX_SECS`]).
    pub delay_secs: i32,
    /// `member_activity.seen_at >= T − 30 s`.
    pub active_at_t: bool,
    /// `member_activity.seen_at >= now() − 30 s`.
    pub active_now: bool,
    /// The member's cursor in the message's channel covers the message's `seq` — and, for a
    /// streamed line, they were also reading the channel in the window before `T` (module docs).
    pub read: bool,
    /// `now() < T + phoneDelaySecs`.
    pub before_expiry: bool,
}

/// The tail's verdict on one member's delayable phone targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayVerdict {
    Send,
    Cancel,
    Hold,
}

/// The rule of the table above, as a pure function of the facts. Cancel is checked first (a read
/// message needs no push however late the notifier is), hold needs the person to be active **now**.
pub fn decide(facts: MemberFacts) -> DelayVerdict {
    if facts.delay_secs <= 0 {
        return DelayVerdict::Send;
    }
    if facts.active_at_t && facts.read {
        return DelayVerdict::Cancel;
    }
    if facts.active_now && !facts.read && facts.before_expiry {
        return DelayVerdict::Hold;
    }
    DelayVerdict::Send
}

/// The tail's result for one candidate.
#[derive(Debug, Clone)]
pub struct Refined {
    /// Targets to dispatch now, in the order the judgment handed them over (the bulk layer reads
    /// that order as its work order).
    pub send: Vec<JudgedTarget>,
    /// Targets dropped because the person already read the message. No push, no dispatch row.
    pub cancelled: usize,
    /// Targets held for the person's desktop activity. Not dispatched, no dispatch row.
    pub held: usize,
    /// The earliest `T + phoneDelaySecs` among the held targets: when the candidate must be judged
    /// again. `None` when nothing is held.
    pub hold_until: Option<DateTime<Utc>>,
}

impl Refined {
    /// Every target goes out now: the answer when nothing is delayable, and the caller's fallback
    /// when the tail's read fails (a push must not be lost to a failed look at the clock).
    pub fn untouched(targets: Vec<JudgedTarget>) -> Refined {
        Refined {
            send: targets,
            cancelled: 0,
            held: 0,
            hold_until: None,
        }
    }
}

/// Whether the tail has anything to look at: a phone target with a delayable reason. The caller opens
/// no transaction for the tail when this is false.
pub fn has_delayable_targets(targets: &[JudgedTarget]) -> bool {
    targets.iter().any(is_subject)
}

/// Whether the delay looks at this candidate at all: it is **not** an approval settlement (the notice
/// that a card was decided is a new fact about a message the person may long since have read, not a
/// message to read, so the read-cancel would silence it and the hold would only make it late), and it
/// has a phone target of a delayable reason.
pub fn delay_applies(candidate: &PushCandidate, targets: &[JudgedTarget]) -> bool {
    !candidate.is_approval_settlement() && has_delayable_targets(targets)
}

/// Apply the phone delay to one candidate's judged targets.
///
/// `candidate_created_at` is the claimed outbox row's `created_at` (`T`, see
/// `momo_outbox::ClaimedPushCandidate::created_at`). One auxiliary query over the distinct members
/// of the **subject** targets (phone, delayable reason); when there are none the function does no
/// query at all. Every read names `workspace_id` explicitly — the notifier is a BYPASSRLS consumer,
/// so the tenant GUC is not the protection here.
pub async fn refine_targets(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    candidate: &PushCandidate,
    candidate_created_at: DateTime<Utc>,
    targets: &[JudgedTarget],
) -> Result<Refined, DbError> {
    if candidate.is_approval_settlement() {
        return Ok(Refined::untouched(targets.to_vec()));
    }
    let mut members: Vec<Uuid> = targets
        .iter()
        .filter(|target| is_subject(target))
        .map(|target| target.member_id)
        .collect();
    if members.is_empty() {
        return Ok(Refined::untouched(targets.to_vec()));
    }
    members.sort_unstable();
    members.dedup();

    // `d.secs` is the member's delay after the cap: the default for a NULL, 0 at the bottom (a
    // negative stored value is "no delay"), `PHONE_DELAY_MAX_SECS` at the top. Every use below
    // reads it, so the hold, the expiry and the `defer` the caller derives from it agree.
    //
    // `is_read`: the cursor covering `m.seq` is D4's rule. A streamed line (the `momo.stream` key,
    // the judgment's own test) needs more — the cursor covered it when its first words arrived — so
    // it must also have been reading in the window before `T` (cursor moved, or a viewing beat).
    let rows = sqlx::query(
        "SELECT mem.member_id, \
                d.secs AS delay_secs, \
                COALESCE(ma.seen_at >= $5 - make_interval(secs => $6::double precision), false) \
                    AS active_at_t, \
                COALESCE(ma.seen_at >= now() - make_interval(secs => $6::double precision), false) \
                    AS active_now, \
                CASE WHEN jsonb_exists(m.props, $8::text) \
                     THEN COALESCE(rs.last_read_seq >= m.seq, false) \
                          AND (COALESCE(rs.last_read_at \
                                        >= $5 - make_interval(secs => $9::double precision), \
                                        false) \
                               OR EXISTS ( \
                                 SELECT 1 FROM channel_viewing cv \
                                  WHERE cv.workspace_id = $1 \
                                    AND cv.channel_id = $3 \
                                    AND cv.member_id = mem.member_id \
                                    AND cv.seen_at \
                                        >= $5 - make_interval(secs => $9::double precision))) \
                     ELSE COALESCE(rs.last_read_seq >= m.seq, false) \
                END AS is_read, \
                now() < $5 + make_interval(secs => d.secs::double precision) AS before_expiry, \
                $5 + make_interval(secs => d.secs::double precision) AS expires_at \
           FROM unnest($2::uuid[]) AS mem(member_id) \
           JOIN message m \
             ON m.workspace_id = $1 \
            AND m.id = $4 \
           LEFT JOIN member_activity ma \
             ON ma.workspace_id = $1 \
            AND ma.member_id = mem.member_id \
           LEFT JOIN notification_rule nr \
             ON nr.workspace_id = $1 \
            AND nr.member_id = mem.member_id \
           CROSS JOIN LATERAL ( \
             SELECT LEAST(GREATEST(COALESCE(nr.phone_delay_secs::int, $7::int), 0), $10::int) \
                    AS secs) d \
           LEFT JOIN read_state rs \
             ON rs.workspace_id = $1 \
            AND rs.channel_id = $3 \
            AND rs.member_id = mem.member_id",
    )
    .bind(workspace_id)
    .bind(&members)
    .bind(candidate.channel_id)
    .bind(candidate.message_id)
    .bind(candidate_created_at)
    .bind(ACTIVITY_WINDOW_SECS)
    .bind(PHONE_DELAY_DEFAULT_SECS)
    .bind(STREAM_PROPS_KEY)
    .bind(STREAM_READ_WINDOW_SECS)
    .bind(PHONE_DELAY_MAX_SECS)
    .fetch_all(&mut *conn)
    .await?;

    let mut verdicts: std::collections::HashMap<Uuid, (DelayVerdict, DateTime<Utc>)> =
        std::collections::HashMap::with_capacity(rows.len());
    for row in &rows {
        let member_id: Uuid = row.try_get("member_id")?;
        let facts = MemberFacts {
            delay_secs: row.try_get("delay_secs")?,
            active_at_t: row.try_get("active_at_t")?,
            active_now: row.try_get("active_now")?,
            read: row.try_get("is_read")?,
            before_expiry: row.try_get("before_expiry")?,
        };
        let expires_at: DateTime<Utc> = row.try_get("expires_at")?;
        verdicts.insert(member_id, (decide(facts), expires_at));
    }

    let mut refined = Refined {
        send: Vec::with_capacity(targets.len()),
        cancelled: 0,
        held: 0,
        hold_until: None,
    };
    for target in targets {
        // A member the query did not return (the message row is gone) is not judged by this tail:
        // the target goes out as it did before the delay existed.
        let verdict = if is_subject(target) {
            verdicts.get(&target.member_id).copied()
        } else {
            None
        };
        match verdict {
            Some((DelayVerdict::Cancel, _)) => refined.cancelled += 1,
            Some((DelayVerdict::Hold, expires_at)) => {
                refined.held += 1;
                refined.hold_until = Some(match refined.hold_until {
                    Some(earliest) => earliest.min(expires_at),
                    None => expires_at,
                });
            }
            Some((DelayVerdict::Send, _)) | None => refined.send.push(target.clone()),
        }
    }
    Ok(refined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(
        delay_secs: i32,
        active_at_t: bool,
        active_now: bool,
        read: bool,
        before_expiry: bool,
    ) -> MemberFacts {
        MemberFacts {
            delay_secs,
            active_at_t,
            active_now,
            read,
            before_expiry,
        }
    }

    #[test]
    fn an_active_person_who_has_not_read_it_is_held_until_the_expiry() {
        assert_eq!(
            decide(facts(60, true, true, false, true)),
            DelayVerdict::Hold
        );
    }

    #[test]
    fn reading_it_inside_the_delay_cancels_the_push() {
        assert_eq!(
            decide(facts(60, true, true, true, true)),
            DelayVerdict::Cancel
        );
        // Even a notifier that is late past the expiry cancels what was read.
        assert_eq!(
            decide(facts(60, true, false, true, false)),
            DelayVerdict::Cancel
        );
    }

    #[test]
    fn after_the_expiry_an_unread_message_is_sent_even_if_they_are_still_active() {
        // One delay only: the hold predicate is false once `now() >= T + delay`, with no flag.
        assert_eq!(
            decide(facts(60, true, true, false, false)),
            DelayVerdict::Send
        );
    }

    #[test]
    fn nobody_active_means_today_s_behavior() {
        assert_eq!(
            decide(facts(60, false, false, false, true)),
            DelayVerdict::Send
        );
        // A read message of someone who was not at the desktop is sent as before: reading on the
        // phone is the phone's business, not a cancel.
        assert_eq!(
            decide(facts(60, false, false, true, true)),
            DelayVerdict::Send
        );
    }

    #[test]
    fn a_delay_of_zero_is_no_delay_and_no_cancel() {
        assert_eq!(
            decide(facts(0, true, true, false, true)),
            DelayVerdict::Send
        );
        assert_eq!(decide(facts(0, true, true, true, true)), DelayVerdict::Send);
    }

    fn target(platform: &str, reason: PushReason) -> JudgedTarget {
        JudgedTarget {
            member_id: Uuid::new_v4(),
            token_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            device_platform: platform.to_string(),
            apns_token: "t".repeat(64),
            apns_env: "sandbox".to_string(),
            apns_topic: "kim.dawn.momo.e2e".to_string(),
            reason,
            kind: None,
            thread_id: Uuid::new_v4(),
            category: crate::dispatch::PushCategory::Mention,
            approval_id: None,
        }
    }

    fn candidate(source: Option<&str>) -> PushCandidate {
        let source = source
            .map(|s| format!(r#","source":"{s}""#))
            .unwrap_or_default();
        PushCandidate::decode(&format!(
            r#"{{"message_id":"{}","channel_id":"{}"{source}}}"#,
            Uuid::new_v4(),
            Uuid::new_v4()
        ))
        .expect("decode a candidate")
    }

    #[test]
    fn the_delay_looks_only_at_a_phone_target_of_a_general_reason() {
        let plain = candidate(None);
        assert!(delay_applies(&plain, &[target("ios", PushReason::Mention)]));
        assert!(delay_applies(&plain, &[target("ios", PushReason::Dm)]));
        // The desktop's own token and the urgent reasons are not subjects.
        assert!(!delay_applies(
            &plain,
            &[target("macos", PushReason::Mention)]
        ));
        assert!(!delay_applies(
            &plain,
            &[target("ios", PushReason::ApprovalRequest)]
        ));
        assert!(!delay_applies(&plain, &[]));
        // One delayable target among others is enough to look.
        assert!(delay_applies(
            &plain,
            &[
                target("ios", PushReason::ApprovalRequest),
                target("ios", PushReason::ThreadReply)
            ]
        ));
    }

    #[test]
    fn an_approval_settlement_is_never_delayed() {
        let settled = candidate(Some("approval_settled"));
        assert!(
            !delay_applies(&settled, &[target("ios", PushReason::Mention)]),
            "the notice that a card was decided is not a message to hold or to cancel as read"
        );
        // A stream-closed candidate is an ordinary message and is judged as one.
        assert!(delay_applies(
            &candidate(Some("stream_closed")),
            &[target("ios", PushReason::Mention)]
        ));
    }

    #[test]
    fn only_general_message_reasons_may_be_delayed() {
        for delayed in [PushReason::Mention, PushReason::Dm, PushReason::ThreadReply] {
            assert!(is_delayable_reason(delayed), "{delayed:?}");
        }
        for urgent in [
            PushReason::ApprovalRequest,
            PushReason::ResumeOffer,
            PushReason::WorkSessionIdle,
            PushReason::WorkRunDone,
            PushReason::TestNotification,
        ] {
            assert!(!is_delayable_reason(urgent), "{urgent:?}");
        }
    }
}
