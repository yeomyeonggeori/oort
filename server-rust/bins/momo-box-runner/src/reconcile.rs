//! Orphan-volume reconciliation (ADR-0197 D10 「고아 볼륨 대조 파기」, T13).
//!
//! The runner compares the box volumes on its host with the server's list of boxes. It does
//! **not** trust that list to destroy anything:
//!
//! * a volume whose box the server reports live (`creating`, `running`, `idle`, `stopped`,
//!   `deleting`, `delete_failed`) is kept;
//! * a volume the server has no live box for (a `deleted` tombstone, or no row at all) is
//!   **quarantined**: its container is stopped and the volume is recorded in the ledger;
//! * a quarantined volume is destroyed only after the grace period (14 days), **and** only
//!   after an operator confirmed it on this host (`momo-box-runner confirm-shred`), **and**
//!   within the daily cap on the orphan path. Until then it is held;
//! * a server that answers with nothing while volumes exist, or that would orphan more than
//!   half of the host's volumes at once, makes the runner act on none of it (a database
//!   restore, an outage or a compromised server must not stop or destroy everyone's box).
//!
//! The owner/admin-signed tombstone D10 describes (verified by the runner itself) needs
//! the device signatures M4/M6 bring; until then **no volume is destroyed on the server's
//! word alone** — the only unattended destruction is the `delete` control's own,
//! requested by the owner or an admin through the box API.
//!
//! [`plan`] is pure: a list in, actions out. `runner::reconcile_once` carries them out.

use uuid::Uuid;

use crate::config::ShredConfig;
use crate::ledger::Ledger;

/// A box as the server lists it for reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerBox {
    pub box_id: Uuid,
    pub state: String,
}

fn is_live(state: &str) -> bool {
    matches!(
        state,
        "creating" | "running" | "idle" | "stopped" | "deleting" | "delete_failed"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldReason {
    GracePeriod,
    AwaitingOperatorConfirmation,
    DailyCapReached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Stop its container and record the volume as quarantined.
    Quarantine(Uuid),
    /// The server knows the box again: drop it from the ledger.
    Release(Uuid),
    /// Overwrite and remove the volume (and its container).
    Shred(Uuid),
    /// Eligible for nothing yet.
    Hold(Uuid, HoldReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suspicion {
    /// The server listed no boxes at all while volumes exist here.
    EmptyServerList,
    /// More than half of this host's volumes would be orphaned at once.
    TooManyOrphans,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    pub actions: Vec<Action>,
    pub suspicion: Option<Suspicion>,
}

/// What to do about each local box volume.
pub fn plan(
    local: &[Uuid],
    server: &[ServerBox],
    ledger: &Ledger,
    now: u64,
    shred: &ShredConfig,
) -> Plan {
    let live = |id: &Uuid| server.iter().any(|b| b.box_id == *id && is_live(&b.state));
    let orphans: Vec<&Uuid> = local.iter().filter(|id| !live(id)).collect();
    let new_orphans = orphans
        .iter()
        .filter(|id| !ledger.entries.contains_key(**id))
        .count();

    let suspicion = if !local.is_empty() && server.is_empty() {
        Some(Suspicion::EmptyServerList)
    } else if local.len() >= 2 && new_orphans * 2 > local.len() {
        Some(Suspicion::TooManyOrphans)
    } else {
        None
    };

    let mut actions = Vec::new();
    let mut budget = shred
        .daily_cap
        .saturating_sub(ledger.shredded_in_last_day(now));
    for id in local {
        if live(id) {
            if ledger.entries.contains_key(id) {
                actions.push(Action::Release(*id));
            }
            continue;
        }
        if suspicion.is_some() {
            // Acting on a list we have reason to doubt is how a bad answer becomes data loss.
            continue;
        }
        match ledger.entries.get(id) {
            None => actions.push(Action::Quarantine(*id)),
            Some(entry) => {
                let waited = now.saturating_sub(entry.quarantined_at);
                if waited < u64::from(shred.grace_days) * 86_400 {
                    actions.push(Action::Hold(*id, HoldReason::GracePeriod));
                } else if !entry.confirmed {
                    actions.push(Action::Hold(*id, HoldReason::AwaitingOperatorConfirmation));
                } else if budget == 0 {
                    actions.push(Action::Hold(*id, HoldReason::DailyCapReached));
                } else {
                    budget -= 1;
                    actions.push(Action::Shred(*id));
                }
            }
        }
    }
    Plan { actions, suspicion }
}
