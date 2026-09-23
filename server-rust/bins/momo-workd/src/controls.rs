//! The control loop: poll `pending-controls`, apply each control **once**,
//! acknowledge it, and retry only the acknowledgement.
//!
//! A dispatched control stays in the host's queue until it is acked, so a lost
//! ack response would otherwise re-run a spawn. The loop therefore remembers the
//! verdict of every control it applied and, on the next poll, re-sends that
//! verdict instead of acting again (Swift `SpawnedSessionCache` /
//! `AppliedControlCache`, same reason).
//!
//! Kinds:
//! * `spawn` — [`SessionManager::spawn`] (all D6 checks). The first prompt (the
//!   spawn label) is sent only after the ack landed: the server accepts a spawn
//!   ack only while the session is still `running`.
//! * `input` — the host owner's instruction, queued as the next turn. A
//!   requester other than the owner is refused (ADR-0188 D3: on a member-scope
//!   host an agent's controls are `kill` only; the server enforces that too).
//! * `kill` — stop the agent; the session reports `ended`.
//! * `read` and anything else — `unsupported_control`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use crate::client::{ClientError, ControlAck, HostApi, WorkControl};
use crate::policy::Refusal;
use crate::session::SessionManager;

const STATUS_DISPATCHED: &str = "dispatched";

/// A verdict waiting for its ack to land.
#[derive(Debug, Clone)]
struct Verdict {
    ack: ControlAck,
    /// A spawn whose first prompt waits for this ack.
    activate: Option<Uuid>,
}

pub struct ControlLoop {
    api: Arc<dyn HostApi>,
    sessions: SessionManager,
    owner_member_id: Uuid,
    verdicts: HashMap<Uuid, Verdict>,
}

impl ControlLoop {
    pub fn new(api: Arc<dyn HostApi>, sessions: SessionManager, owner_member_id: Uuid) -> Self {
        Self {
            api,
            sessions,
            owner_member_id,
            verdicts: HashMap::new(),
        }
    }

    pub fn sessions(&mut self) -> &mut SessionManager {
        &mut self.sessions
    }

    /// One poll. `Err(Unauthorized)` means the host was revoked (or its owner
    /// is gone): the caller stops everything (ADR-0188 D7).
    pub async fn poll_once(&mut self) -> Result<usize, ClientError> {
        let controls = self.api.pending_controls().await?;
        let host_id = self.api.host_id();
        let mut handled = 0;
        let mut listed = HashSet::new();
        for control in controls {
            // The server only returns this host's dispatched controls; a row
            // that says otherwise is not one to act on.
            if control.target_host_id != host_id || control.status != STATUS_DISPATCHED {
                continue;
            }
            handled += 1;
            listed.insert(control.id);
            let verdict = match self.verdicts.get(&control.id) {
                Some(verdict) => verdict.clone(),
                None => {
                    let verdict = self.apply(&control).await;
                    self.verdicts.insert(control.id, verdict.clone());
                    verdict
                }
            };
            match self.api.ack(control.id, &verdict.ack).await {
                Ok(()) => {
                    self.verdicts.remove(&control.id);
                    if let Some(session_id) = verdict.activate {
                        self.sessions.activate(session_id).await;
                    }
                }
                Err(ClientError::Unauthorized) => return Err(ClientError::Unauthorized),
                Err(error) if error.is_transient() => {
                    tracing::warn!(control_id = %control.id, error = %error, "ack deferred to the next poll");
                }
                Err(error) => {
                    // The control moved on without us (expired, already acked,
                    // or the session it names is no longer running). A spawned
                    // session nobody can bind is closed rather than left idle.
                    tracing::warn!(control_id = %control.id, error = %error, "ack refused");
                    self.verdicts.remove(&control.id);
                    if let Some(session_id) = verdict.activate {
                        let _ = self.sessions.kill(session_id).await;
                    }
                }
            }
        }
        // A remembered verdict whose control the server no longer lists: the
        // ack committed and only its response was lost (a failed ack keeps the
        // control dispatched, so it would still be listed). Nothing is left to
        // acknowledge, and a spawned session still waiting for its first prompt
        // gets it now instead of sitting `running` with nothing to do.
        let settled: Vec<Uuid> = self
            .verdicts
            .keys()
            .filter(|id| !listed.contains(*id))
            .copied()
            .collect();
        for control_id in settled {
            if let Some(Verdict {
                activate: Some(session_id),
                ..
            }) = self.verdicts.remove(&control_id)
            {
                self.sessions.activate(session_id).await;
            }
        }
        self.sessions.reap();
        Ok(handled)
    }

    async fn apply(&mut self, control: &WorkControl) -> Verdict {
        let refused = |refusal: Refusal| {
            tracing::info!(control_id = %control.id, kind = %control.kind, label = refusal.label(), "control refused");
            Verdict {
                ack: ControlAck::refused(refusal.label()),
                activate: None,
            }
        };
        match control.kind.as_str() {
            "spawn" => match self.sessions.spawn(control).await {
                Ok(session_id) => Verdict {
                    ack: ControlAck::ok(Some(session_id)),
                    activate: Some(session_id),
                },
                Err(refusal) => refused(refusal),
            },
            "input" => match self.input(control).await {
                Ok(()) => Verdict {
                    ack: ControlAck::ok(control.session_id),
                    activate: None,
                },
                Err(refusal) => refused(refusal),
            },
            "kill" => {
                let Some(session_id) = control.session_id else {
                    return refused(Refusal::InvalidControl);
                };
                match self.sessions.kill(session_id).await {
                    Ok(_) => Verdict {
                        ack: ControlAck::ok(Some(session_id)),
                        activate: None,
                    },
                    Err(refusal) => refused(refusal),
                }
            }
            _ => refused(Refusal::UnsupportedControl),
        }
    }

    async fn input(&mut self, control: &WorkControl) -> Result<(), Refusal> {
        if control.requester_member_id != self.owner_member_id {
            return Err(Refusal::RequesterNotOwner);
        }
        let session_id = control.session_id.ok_or(Refusal::InvalidControl)?;
        let text = control
            .payload_str("text")
            .filter(|text| !text.is_empty())
            .ok_or(Refusal::InvalidControl)?;
        self.sessions.input(session_id, text.to_string()).await
    }
}

/// Heartbeat until the server refuses the host. Returns only on 401.
pub async fn heartbeat_loop(api: Arc<dyn HostApi>, interval: Duration) -> ClientError {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        match api.heartbeat().await {
            Ok(()) => tracing::debug!("heartbeat accepted"),
            Err(ClientError::Unauthorized) => return ClientError::Unauthorized,
            Err(error) => tracing::warn!(error = %error, "heartbeat failed"),
        }
    }
}
