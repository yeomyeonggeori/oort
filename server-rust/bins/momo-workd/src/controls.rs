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
//! * `spawn` — the host owner's only (see below), then
//!   [`SessionManager::spawn`] (all D6 checks). The first prompt (the spawn
//!   label) is sent only after the ack landed: the server accepts a spawn ack
//!   only while the session is still `running`. A refused spawn that arrived
//!   with a session the server already allocated for it (a resume) ends that
//!   session, so the ledger is not left with a `running` session nothing runs.
//! * `input` — the host owner's instruction, queued as the next turn.
//!
//! A spawn label or an input that starts with `/` is refused
//! (`slash_command_refused`, #2602 L-7): it would run an adapter command, not a
//! prompt.
//!
//! **Owner only (ADR-0188 D3, #2602 M-4).** `momo-workd` serves member-scoped
//! hosts only (`cli::run` checks the registration), and on a member host a
//! spawn or an input comes from its owner or not at all. The server withholds
//! every other requester's non-kill control (#2582 R0.1); the host refuses them
//! again with `requester_not_owner`, so a server regression or a pre-R0 row
//! still cannot turn someone else's words into a prompt on the owner's Mac.
//! `kill` is accepted from anyone the server delivers it for.
//! * `kill` — stop the agent; the session reports `ended`.
//! * `permission` — the owner's decision on a bridged permission request
//!   (ADR-0188 D5, #3000), owner only like `input`; the session checks it
//!   against the request's nonce and the options the agent offered.
//! * `read` and anything else — `unsupported_control`.
//!
//! **Device signatures (ADR-0146 개정 D-10, #3024).** With R2 on
//! ([`ControlLoop::with_human_trust`], config `require_human_signatures`), a
//! spawn, an input and a non-rejecting permission must also carry the owner's
//! device signature, which [`HumanTrust::check_control`] verifies against the
//! root pinned on this Mac and whose nonce it spends before anything runs. A
//! server that inserts an unsigned or forged-key control is refused here.
//! `kill` and rejections pass unsigned (D-8). With R2 off nothing changes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use uuid::Uuid;

use crate::client::{ClientError, ControlAck, HostApi, SessionStatus, WorkControl};
use crate::human_trust::{requires_signature, HumanTrust};
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
    /// R2 on: the host's trust state. `None` keeps the pre-R2 behavior.
    human: Option<Arc<Mutex<HumanTrust>>>,
}

impl ControlLoop {
    pub fn new(api: Arc<dyn HostApi>, sessions: SessionManager, owner_member_id: Uuid) -> Self {
        Self {
            api,
            sessions,
            owner_member_id,
            verdicts: HashMap::new(),
            human: None,
        }
    }

    /// Turn R2 on: spawns, inputs and allows must carry a device signature
    /// that chains to the root pinned in `trust` (ADR-0146 개정 D-10).
    pub fn with_human_trust(mut self, trust: Arc<Mutex<HumanTrust>>) -> Self {
        self.human = Some(trust);
        self
    }

    /// Apply the revocations the server relayed with the last poll. A bad one
    /// is logged and dropped; the server can hide a revocation but not forge
    /// one (the local socket carries them too, D-7).
    fn apply_relayed_revocations(&self) {
        // Taken even with R2 off, so nothing accumulates (#3024 review M3).
        let relayed = self.api.take_device_revocations();
        let Some(trust) = &self.human else {
            return;
        };
        for revocation in relayed {
            // The server must name the revoked public key too: an endorsement
            // binds a key, a revocation names an id, and a key this host has
            // never seen has no id binding yet (#3024 review M1).
            let result = trust
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .apply_revocation(&revocation, true);
            if let Err(label) = result {
                tracing::warn!(error = label, "relayed device revocation refused");
            }
        }
    }

    /// R2 on the host: the owner's signature, fresh, unrevoked, once.
    fn check_signature(&self, control: &WorkControl) -> Result<(), Refusal> {
        let Some(trust) = &self.human else {
            return Ok(());
        };
        if !requires_signature(control) {
            return Ok(());
        }
        trust
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .check_control(control, now_ms())
    }

    pub fn sessions(&mut self) -> &mut SessionManager {
        &mut self.sessions
    }

    /// One poll. `Err(Unauthorized)` means the host was revoked (or its owner
    /// is gone): the caller stops everything (ADR-0188 D7).
    pub async fn poll_once(&mut self) -> Result<usize, ClientError> {
        let controls = self.api.pending_controls().await?;
        // Revocations first, so a control in the same answer meets them.
        self.apply_relayed_revocations();
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
        let authorized = |this: &Self| {
            this.require_owner(control)?;
            this.check_signature(control)
        };
        match control.kind.as_str() {
            "spawn" => {
                let spawned = match authorized(self) {
                    Ok(()) => self.sessions.spawn(control).await,
                    Err(refusal) => Err(refusal),
                };
                match spawned {
                    Ok(session_id) => Verdict {
                        ack: ControlAck::ok(Some(session_id)),
                        activate: Some(session_id),
                    },
                    Err(refusal) => {
                        // #2607 N-6: only the owner's own resume is closed, and
                        // never a session this host is running. An unsigned or
                        // forged spawn touches nothing either (#3024).
                        if !refusal.is_authorization() {
                            self.end_preallocated_session(control).await;
                        }
                        refused(refusal)
                    }
                }
            }
            "input" => match authorized(self) {
                Err(refusal) => refused(refusal),
                Ok(()) => match self.input(control).await {
                    Ok(()) => Verdict {
                        ack: ControlAck::ok(control.session_id),
                        activate: None,
                    },
                    Err(refusal) => refused(refusal),
                },
            },
            "permission" => match authorized(self) {
                Err(refusal) => refused(refusal),
                Ok(()) => match self.permission(control).await {
                    Ok(()) => Verdict {
                        ack: ControlAck::ok(control.session_id),
                        activate: None,
                    },
                    Err(refusal) => refused(refusal),
                },
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

    /// ADR-0188 D3 on the host: a spawn or an input is its owner's or nothing.
    fn require_owner(&self, control: &WorkControl) -> Result<(), Refusal> {
        if control.requester_member_id == self.owner_member_id {
            Ok(())
        } else {
            Err(Refusal::RequesterNotOwner)
        }
    }

    /// A resume arrives with its session already allocated and `running` on
    /// the server. If this host refuses to run it, it says so — best effort,
    /// the ack carries the reason either way.
    async fn end_preallocated_session(&mut self, control: &WorkControl) {
        let Some(session_id) = control.session_id else {
            return;
        };
        if self.sessions.runs(session_id) {
            return;
        }
        if let Err(error) = self
            .api
            .set_status(session_id, SessionStatus::Ended { exit_code: None })
            .await
        {
            tracing::warn!(%session_id, error = %error, "could not end a refused resume session");
        }
    }

    /// ADR-0188 D3·D5: the owner's decision, and nobody else's.
    async fn permission(&mut self, control: &WorkControl) -> Result<(), Refusal> {
        self.require_owner(control)?;
        let session_id = control.session_id.ok_or(Refusal::InvalidControl)?;
        let request_event_id = control
            .payload_str("request_event_id")
            .and_then(|raw| Uuid::parse_str(raw).ok())
            .ok_or(Refusal::InvalidControl)?;
        let (Some(option_id), Some(kind)) = (
            control.payload_str("option_id"),
            control.payload_str("kind"),
        ) else {
            return Err(Refusal::InvalidControl);
        };
        self.sessions
            .permission(
                session_id,
                request_event_id,
                option_id.to_string(),
                kind.to_string(),
            )
            .await
    }

    async fn input(&mut self, control: &WorkControl) -> Result<(), Refusal> {
        self.require_owner(control)?;
        let session_id = control.session_id.ok_or(Refusal::InvalidControl)?;
        let text = control
            .payload_str("text")
            .filter(|text| !text.is_empty())
            .ok_or(Refusal::InvalidControl)?;
        crate::policy::check_prompt(text)?;
        self.sessions.input(session_id, text.to_string()).await
    }
}

/// What the control socket shares with the running host (#2778, #3024).
#[derive(Clone)]
pub struct SocketShared {
    pub health: Arc<HostHealth>,
    pub stop: Arc<tokio::sync::Notify>,
    /// The R2 trust state `pin_root` and `revoke_device` write.
    pub trust: Arc<Mutex<HumanTrust>>,
    /// Reported by `status`: whether this host enforces device signatures.
    pub human_signatures_required: bool,
}

/// The heartbeat's last outcome, which the desktop app reads through the
/// control socket's `status` (#2778).
#[derive(Debug, Default)]
pub struct HostHealth {
    inner: Mutex<HealthSnapshot>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct HealthSnapshot {
    pub last_ok_ms: Option<i64>,
    pub last_attempt_ms: Option<i64>,
    pub failing: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

impl HostHealth {
    pub fn heartbeat_accepted(&self) {
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.last_ok_ms = Some(now);
        inner.last_attempt_ms = Some(now);
        inner.failing = false;
    }

    pub fn heartbeat_failed(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.last_attempt_ms = Some(now_ms());
        inner.failing = true;
    }

    pub fn snapshot(&self) -> HealthSnapshot {
        *self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Heartbeat until the server refuses the host. Returns only on 401.
///
/// Each outcome is recorded in `health`, which the control socket's `status`
/// reports to the desktop app (#2778).
pub async fn heartbeat_loop(
    api: Arc<dyn HostApi>,
    interval: Duration,
    health: Arc<HostHealth>,
) -> ClientError {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        match api.heartbeat().await {
            Ok(()) => {
                health.heartbeat_accepted();
                tracing::debug!("heartbeat accepted")
            }
            Err(ClientError::Unauthorized) => {
                health.heartbeat_failed();
                return ClientError::Unauthorized;
            }
            Err(error) => {
                health.heartbeat_failed();
                tracing::warn!(error = %error, "heartbeat failed")
            }
        }
    }
}
