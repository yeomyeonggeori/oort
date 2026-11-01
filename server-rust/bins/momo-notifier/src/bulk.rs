//! The bulk layer of the push drain — ADR-0206 증보 1 F6 (#4889 2단계), in the shape D7 gives the
//! "one message can mean one push each" reasons.
//!
//! Most reasons are rare by nature (a DM, a mention, an approval). A **thread reply** is not: one busy
//! thread can produce a push per message for every follower. The drain holds those reasons to a
//! handful of pushes without delaying the first one (a messenger's first reply must arrive at once,
//! so there is **no time-based merging** — ADR F6):
//!
//! 1. **A window per (member, thread root).** Within one fixed minute (the epoch minute) the first
//!    [`INDIVIDUAL_PER_WINDOW`] messages that would push the member go out as usual, each under its
//!    own collapse id `m:<message_id>`. The next ones are **folded**: one representative push for the
//!    whole rest of the window under `o:<root_id>:<window number>`. The dispatch log's unique key
//!    `(member, token, collapse_id)` makes every later message of the window find the representative
//!    already settled and send nothing. 20 replies in a minute are 7 pushes. The key is the thread, not
//!    the channel, so one thread's burst never eats the budget of another thread's first replies, and
//!    the representative's tap goes to the thread it is about. Counted per message and member: a member
//!    with two phones gets the verdict twice on the same message, not two slots.
//! 2. **A server-wide budget.** This layer may send at most `budget_per_minute` dispatches (one per
//!    token) per minute across all tenants, so a flood of replies cannot starve the relay's per-server
//!    limit that approvals, mentions and DMs also spend. A push past the budget is not sent and its
//!    candidate completes (it is still in the app).
//! 3. **A relay 429 is not retried** for this layer (see [`crate::push`]): it is best-effort, so it
//!    must not eat the retry budget and the backoff queue that approvals and DMs rely on.
//!
//! Every window and counter lives in this process's memory — no table, no index. The notifier is one
//! instance; with several the cap loosens by the instance count (the relay's own limit is the last
//! wall). A restart forgets the minute in flight, which can only let a few more pushes through.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use momo_push::PushReason;
use uuid::Uuid;

/// Individual pushes per (member, thread root) and window before the rest are folded. One constant,
/// pinned by the tests: raise it to 7 and the "20 replies are 7 pushes" test goes red.
pub const INDIVIDUAL_PER_WINDOW: u32 = 6;

/// The window is one fixed minute of the epoch clock. At a boundary 6 + 6 can go out (accepted).
pub const WINDOW_SECONDS: i64 = 60;

/// `NOTIFIER_BULK_PUSH_PER_MINUTE` default: half of the relay's default per-server limit (60), so the
/// other half is always there for approvals, mentions and DMs.
pub const DEFAULT_BUDGET_PER_MINUTE: u32 = 30;

/// How a relay-429'd push of this layer is settled in the dispatch log (status 429): the same shape as
/// the other relay refusals (`relay_http:` prefix, so a token-health pass can never read it as an
/// APNs answer), and a row that `AlreadySettled` stops from being sent again.
pub const DROPPED_REASON: &str = "relay_http: dropped";

/// Whether `reason` is one of the layer's. Today only `thread_reply`; `channel_message` and `keyword`
/// (ADR-0206 D7) join when they ship.
pub fn is_bulk_reason(reason: PushReason) -> bool {
    matches!(reason, PushReason::ThreadReply)
}

/// The representative's collapse id: `o:<root_id>:<window number>`. At most 2 + 36 + 1 + 20 bytes, well
/// under the 64 the APNs header and the relay allow.
pub fn folded_collapse_id(root: Uuid, window: i64) -> String {
    format!("o:{}:{window}", root.hyphenated())
}

/// What the window says about one (member, message).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// One of the first [`INDIVIDUAL_PER_WINDOW`]: send under the message's own collapse id.
    Individual,
    /// The seventh and later: send nothing of its own; the window's one representative (under
    /// [`folded_collapse_id`]) is what the member gets.
    Folded { window: i64 },
}

/// Why a bulk push was not sent, for the counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cause {
    /// Folded into the window's representative.
    Window,
    /// Past the server-wide budget.
    Budget,
    /// The relay answered 429; dropped without a retry.
    Relay429,
}

impl Cause {
    pub fn as_str(self) -> &'static str {
        match self {
            Cause::Window => "window",
            Cause::Budget => "budget",
            Cause::Relay429 => "relay_429",
        }
    }
}

/// Seconds since the epoch. Replaceable so a test can hold or move the minute.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs() as i64)
            .unwrap_or(0)
    })
}

struct Window {
    minute: i64,
    individual: u32,
    /// Verdicts already given in this window, by message: a candidate that is redelivered (a sibling
    /// target failed transiently) must get the same verdict and must not spend a second slot.
    decided: HashMap<Uuid, Verdict>,
}

struct State {
    windows: HashMap<(Uuid, Uuid), Window>,
    pruned_minute: i64,
    budget_minute: i64,
    budget_used: u32,
    counters: BTreeMap<(&'static str, &'static str), u64>,
}

/// The layer's memory. One per [`crate::push::PushDrain`].
pub struct BulkLayer {
    clock: Clock,
    budget_per_minute: u32,
    state: Mutex<State>,
}

impl BulkLayer {
    pub fn new(budget_per_minute: u32) -> BulkLayer {
        BulkLayer {
            clock: system_clock(),
            budget_per_minute,
            state: Mutex::new(State {
                windows: HashMap::new(),
                pruned_minute: i64::MIN,
                budget_minute: i64::MIN,
                budget_used: 0,
                counters: BTreeMap::new(),
            }),
        }
    }

    /// Replace the clock (tests).
    pub fn with_clock(mut self, clock: Clock) -> BulkLayer {
        self.clock = clock;
        self
    }

    fn minute(&self) -> i64 {
        (self.clock)().div_euclid(WINDOW_SECONDS)
    }

    /// The window's verdict for this message and member in this thread. Asking again about the same
    /// message in the same window gives the same answer and costs nothing.
    pub fn decide(&self, member: Uuid, root: Uuid, message: Uuid) -> Verdict {
        let minute = self.minute();
        let mut state = self.state.lock().expect("bulk layer state");
        if state.pruned_minute != minute {
            // First look of a new minute: drop every window that belongs to an older one.
            state.windows.retain(|_, window| window.minute == minute);
            state.pruned_minute = minute;
        }
        let window = state
            .windows
            .entry((member, root))
            .or_insert_with(|| Window {
                minute,
                individual: 0,
                decided: HashMap::new(),
            });
        if let Some(verdict) = window.decided.get(&message) {
            return *verdict;
        }
        let verdict = if window.individual < INDIVIDUAL_PER_WINDOW {
            window.individual += 1;
            Verdict::Individual
        } else {
            Verdict::Folded { window: minute }
        };
        window.decided.insert(message, verdict);
        if matches!(verdict, Verdict::Folded { .. }) {
            Self::count_in(&mut state, Cause::Window);
        }
        verdict
    }

    /// Take one dispatch from this minute's server-wide budget. `false` = the budget is spent.
    pub fn try_spend(&self) -> bool {
        let minute = self.minute();
        let mut state = self.state.lock().expect("bulk layer state");
        if state.budget_minute != minute {
            state.budget_minute = minute;
            state.budget_used = 0;
        }
        if state.budget_used >= self.budget_per_minute {
            Self::count_in(&mut state, Cause::Budget);
            return false;
        }
        state.budget_used += 1;
        true
    }

    /// Count a push of the layer that did not go out, for the log line and the tests.
    pub fn count(&self, cause: Cause) {
        let mut state = self.state.lock().expect("bulk layer state");
        Self::count_in(&mut state, cause);
    }

    fn count_in(state: &mut State, cause: Cause) {
        *state
            .counters
            .entry(("thread_reply", cause.as_str()))
            .or_insert(0) += 1;
    }

    /// `(reason, cause) -> pushes not sent since boot`. The reason label is the wire reason.
    pub fn counters(&self) -> BTreeMap<(&'static str, &'static str), u64> {
        self.state
            .lock()
            .expect("bulk layer state")
            .counters
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn layer_at(now: Arc<AtomicI64>, budget: u32) -> BulkLayer {
        BulkLayer::new(budget).with_clock(Arc::new(move || now.load(Ordering::SeqCst)))
    }

    fn ids() -> (Uuid, Uuid) {
        (Uuid::from_u128(1), Uuid::from_u128(2))
    }

    /// The first six messages of a window are individual and everything after is folded — the
    /// "20 replies are 7 pushes" arithmetic, stated once at the unit level.
    #[test]
    fn the_seventh_message_of_a_window_is_the_first_one_folded() {
        let now = Arc::new(AtomicI64::new(1_800_000_000));
        let layer = layer_at(now, 100);
        let (member, root) = ids();
        let verdicts: Vec<Verdict> = (0..20u128)
            .map(|n| layer.decide(member, root, Uuid::from_u128(100 + n)))
            .collect();
        assert!(verdicts[..6].iter().all(|v| *v == Verdict::Individual));
        let window = 1_800_000_000 / 60;
        assert!(verdicts[6..]
            .iter()
            .all(|v| *v == Verdict::Folded { window }));
        assert_eq!(layer.counters()[&("thread_reply", "window")], 14);
    }

    /// A redelivered candidate asks again about a message the window already judged: same answer, no
    /// second slot. (Without the memo the seventh message would be re-judged as the eighth.)
    #[test]
    fn asking_again_about_the_same_message_changes_nothing() {
        let now = Arc::new(AtomicI64::new(1_800_000_000));
        let layer = layer_at(now, 100);
        let (member, root) = ids();
        for n in 0..6u128 {
            layer.decide(member, root, Uuid::from_u128(n));
        }
        let seventh = Uuid::from_u128(6);
        let first = layer.decide(member, root, seventh);
        assert!(matches!(first, Verdict::Folded { .. }));
        assert_eq!(layer.decide(member, root, seventh), first);
        // …and an old individual message is still individual when it is asked about again.
        assert_eq!(
            layer.decide(member, root, Uuid::from_u128(0)),
            Verdict::Individual
        );
        assert_eq!(
            layer.counters()[&("thread_reply", "window")],
            1,
            "counted once"
        );
    }

    /// The key is (member, thread): another thread, and another member, each get their own six.
    #[test]
    fn every_member_and_every_thread_has_its_own_window() {
        let now = Arc::new(AtomicI64::new(1_800_000_000));
        let layer = layer_at(now, 100);
        let (member, root) = ids();
        for n in 0..6u128 {
            layer.decide(member, root, Uuid::from_u128(n));
        }
        let other_root = Uuid::from_u128(77);
        let other_member = Uuid::from_u128(78);
        assert_eq!(
            layer.decide(member, other_root, Uuid::from_u128(500)),
            Verdict::Individual
        );
        assert_eq!(
            layer.decide(other_member, root, Uuid::from_u128(501)),
            Verdict::Individual
        );
        assert!(matches!(
            layer.decide(member, root, Uuid::from_u128(502)),
            Verdict::Folded { .. }
        ));
    }

    /// A new minute is a new window: the count starts over, and the old windows are dropped.
    #[test]
    fn the_window_starts_over_with_the_next_minute() {
        let now = Arc::new(AtomicI64::new(1_800_000_000));
        let layer = layer_at(now.clone(), 100);
        let (member, root) = ids();
        for n in 0..8u128 {
            layer.decide(member, root, Uuid::from_u128(n));
        }
        now.fetch_add(60, Ordering::SeqCst);
        assert_eq!(
            layer.decide(member, root, Uuid::from_u128(900)),
            Verdict::Individual
        );
        assert_eq!(
            layer.state.lock().unwrap().windows.len(),
            1,
            "the old minute's windows were dropped"
        );
    }

    /// The budget is per minute and across everyone; the next minute refills it.
    #[test]
    fn the_budget_is_spent_per_minute_and_refilled_by_the_next_one() {
        let now = Arc::new(AtomicI64::new(1_800_000_000));
        let layer = layer_at(now.clone(), 3);
        assert_eq!((0..5).filter(|_| layer.try_spend()).count(), 3);
        assert_eq!(layer.counters()[&("thread_reply", "budget")], 2);
        now.fetch_add(60, Ordering::SeqCst);
        assert!(layer.try_spend(), "a new minute, a full budget");
        assert!(
            !BulkLayer::new(0).try_spend(),
            "a budget of 0 sends no bulk push at all"
        );
    }

    #[test]
    fn the_representatives_collapse_id_fits_the_apns_header() {
        let id = folded_collapse_id(Uuid::from_u128(u128::MAX), i64::MAX / 60);
        assert!(id.starts_with("o:"));
        assert!(id.len() <= 64, "{} bytes: {id}", id.len());
        assert_eq!(
            folded_collapse_id(Uuid::from_u128(1), 30_000_000),
            "o:00000000-0000-0000-0000-000000000001:30000000"
        );
    }
}
