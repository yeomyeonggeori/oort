//! The closed control schema (ADR-0197 D2) — what the server may say to the runner.
//!
//! A `create` control carries `{box id, four limits}` and nothing else; `start`, `stop`,
//! `delete` and `status` carry only the box. **There is no field for an image, a command,
//! a mount, a network profile or an environment variable**, and a control that arrives
//! with one (or with any other unknown field) is *rejected*, not ignored: the whole
//! struct is `deny_unknown_fields`. A compromised server can therefore make the runner
//! start, stop or delete a box of the fixed template, and nothing else.
//!
//! Intake never executes a rejected control. It reports back what it can (the control id
//! and lease, so the server stops re-issuing it) as a failure; it never echoes a rejected
//! field's value anywhere.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::verbs::Verb;

/// The four limits of a `create` (ADR-0197 D3). Also the shape of the runner's local caps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub cpu_millis: u32,
    pub memory_mb: u32,
    pub disk_gb: u32,
    pub pids: u32,
}

impl Limits {
    /// ADR-0197 D3 defaults, which are also the ceiling no local cap may exceed.
    pub const ADR_CEILING: Limits = Limits {
        cpu_millis: 1000,
        memory_mb: 2048,
        disk_gb: 10,
        pids: 512,
    };

    pub fn all_positive(&self) -> bool {
        self.cpu_millis > 0 && self.memory_mb > 0 && self.disk_gb > 0 && self.pids > 0
    }

    /// Is every limit at or below `cap`'s?
    pub fn within(&self, cap: &Limits) -> bool {
        self.cpu_millis <= cap.cpu_millis
            && self.memory_mb <= cap.memory_mb
            && self.disk_gb <= cap.disk_gb
            && self.pids <= cap.pids
    }
}

/// One control exactly as it may appear on the wire. `deny_unknown_fields`: an `image`,
/// `command`, `mounts`, `env`, `network` (or anything else) makes parsing fail.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlWire {
    id: Uuid,
    lease_id: Uuid,
    attempts: u32,
    // Delivery order; the runner does not use it.
    #[allow(dead_code)]
    seq: i64,
    box_id: Uuid,
    verb: String,
    #[serde(default)]
    limits: Option<Limits>,
}

/// Just enough of a control to report it back when it was refused.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlStub {
    id: Uuid,
    lease_id: Uuid,
    attempts: u32,
}

/// What to do for a verb; `create` carries the limits it was given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    Create(Limits),
    Start,
    Stop,
    Delete,
    Status,
}

impl Task {
    pub fn verb(&self) -> Verb {
        match self {
            Task::Create(_) => Verb::Create,
            Task::Start => Verb::Start,
            Task::Stop => Verb::Stop,
            Task::Delete => Verb::Delete,
            Task::Status => Verb::Status,
        }
    }
}

/// A control the runner accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Control {
    pub id: Uuid,
    pub lease_id: Uuid,
    pub attempts: u32,
    pub box_id: Uuid,
    pub task: Task,
}

/// Why a control was refused. Static words: nothing of the refused content is carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not the closed shape: an unknown field (image, command, mount, env, network …),
    /// a missing field, or a wrong type.
    NotTheClosedSchema,
    /// A verb outside the five.
    UnknownVerb,
    /// `create` without its four limits.
    LimitsMissing,
    /// Limits on a verb that takes none.
    LimitsUnexpected,
    /// A limit of zero.
    LimitsZero,
    /// A limit above the runner's local cap.
    LimitsAboveCap,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NotTheClosedSchema => "control is not the closed schema",
            Refusal::UnknownVerb => "control verb is not one of the five",
            Refusal::LimitsMissing => "create without limits",
            Refusal::LimitsUnexpected => "limits on a verb that takes none",
            Refusal::LimitsZero => "a limit of zero",
            Refusal::LimitsAboveCap => "limits above the runner's local cap",
        }
    }
}

/// A refused control and what can be reported about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refused {
    pub reason: Refusal,
    /// `(id, lease id, attempts)` when the control was at least identifiable, so the
    /// runner can report it failed. `None`: nothing is reportable (it is only logged).
    pub reportable: Option<(Uuid, Uuid, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intake {
    Accepted(Control),
    Refused(Refused),
}

/// Parse one control value strictly and check it against the runner's local caps.
pub fn intake(raw: &Value, caps: &Limits) -> Intake {
    let refuse = |reason: Refusal| {
        let reportable = serde_json::from_value::<ControlStub>(raw.clone())
            .ok()
            .map(|stub| (stub.id, stub.lease_id, stub.attempts));
        Intake::Refused(Refused { reason, reportable })
    };
    let Ok(wire) = serde_json::from_value::<ControlWire>(raw.clone()) else {
        return refuse(Refusal::NotTheClosedSchema);
    };
    let Some(verb) = Verb::parse(&wire.verb) else {
        return refuse(Refusal::UnknownVerb);
    };
    let task = match (verb, wire.limits) {
        (Verb::Create, Some(limits)) => {
            if !limits.all_positive() {
                return refuse(Refusal::LimitsZero);
            }
            if !limits.within(caps) {
                return refuse(Refusal::LimitsAboveCap);
            }
            Task::Create(limits)
        }
        (Verb::Create, None) => return refuse(Refusal::LimitsMissing),
        (_, Some(_)) => return refuse(Refusal::LimitsUnexpected),
        (Verb::Start, None) => Task::Start,
        (Verb::Stop, None) => Task::Stop,
        (Verb::Delete, None) => Task::Delete,
        (Verb::Status, None) => Task::Status,
    };
    Intake::Accepted(Control {
        id: wire.id,
        lease_id: wire.lease_id,
        attempts: wire.attempts,
        box_id: wire.box_id,
        task,
    })
}

/// The claim answer. The envelope is tolerant on purpose; every control inside it is
/// strict ([`intake`]).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEnvelope {
    #[serde(default)]
    pub controls: Vec<Value>,
    #[serde(default)]
    pub poisoned: Vec<Uuid>,
}

/// The one word `status` reports. Never a docker `inspect` document, never env.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Observed {
    Running,
    Stopped,
    Absent,
}

/// The runner's own check after a `delete` (ADR-0197 D10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionReport {
    pub container_absent: bool,
    pub volume_absent: bool,
}

/// What the runner says about a finished control: a flag, one of three words for `status`,
/// two booleans for `delete`. This struct IS the whole upstream vocabulary; there is no
/// free-text field, so no docker output can ride on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteBody {
    pub lease_id: Uuid,
    pub attempts: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Observed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletion: Option<DeletionReport>,
}
