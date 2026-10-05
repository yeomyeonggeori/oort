//! The runner loop: poll → check → execute → report, and now and then reconcile.
//!
//! Outbound only. Controls are taken one claim at a time, each checked against the closed
//! schema ([`wire::intake`]) before anything runs; a refused control is never executed and
//! is reported failed so the server stops re-issuing it. A completion the server calls
//! stale (the lease moved on) is dropped: the runner has nothing to retry, the next poll
//! brings whatever is current.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use uuid::Uuid;

use crate::client::{ClientError, ServerApi};
use crate::config::RunnerConfig;
use crate::engine::{ContainerState, Engine, EngineError};
use crate::executor::Executor;
use crate::ledger::{Ledger, LedgerError};
use crate::reconcile::{plan, Action, Plan, ServerBox};
use crate::wire::{intake, CompleteBody, Control, Intake, Refused, Task};

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Engine(#[from] EngineError),
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// D2: one runner host serves one workspace. Boxes of another workspace are here.
    #[error("this host already runs boxes of another workspace; a runner host serves exactly one")]
    ForeignWorkspace,
}

/// What one poll did, for logs and tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PollSummary {
    pub executed: usize,
    pub refused: usize,
    pub unreportable: usize,
    pub stale: usize,
    pub poisoned: usize,
}

pub struct Runner {
    cfg: Arc<RunnerConfig>,
    engine: Engine,
    executor: Executor,
    server: Arc<dyn ServerApi>,
    state_dir: PathBuf,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Runner {
    pub fn new(
        cfg: Arc<RunnerConfig>,
        engine: Engine,
        executor: Executor,
        server: Arc<dyn ServerApi>,
    ) -> Self {
        let state_dir = cfg.state_dir.clone();
        Runner {
            cfg,
            engine,
            executor,
            server,
            state_dir,
        }
    }

    /// Refuse to start on a host that already carries another workspace's boxes (D2).
    pub async fn preflight(&self) -> Result<(), RunnerError> {
        let mine = self.cfg.workspace_id.as_hyphenated().to_string();
        let foreign_container = self
            .engine
            .containers()
            .await?
            .iter()
            .any(|row| row.workspace != mine);
        let foreign_volume = self
            .engine
            .volumes()
            .await?
            .iter()
            .any(|row| row.workspace != mine);
        if foreign_container || foreign_volume {
            return Err(RunnerError::ForeignWorkspace);
        }
        Ok(())
    }

    /// Before a `delete` destroys anything (#3509 review M5): the runner does not take the
    /// control's word alone. The server's own box list must show this box as `deleting`, and the
    /// runner's daily deletion cap must have room. Refusals are loud and reported failed (the box
    /// stays `delete_failed` for a person to look at). Residual risk — a compromised server that
    /// also lies in the list, up to the cap per day — ends with the owner/admin-signed delete of
    /// M4/M6 (ADR-0197 D10).
    async fn delete_guard(&self, control: &Control) -> Result<(), &'static str> {
        let boxes = self
            .server
            .boxes()
            .await
            .map_err(|_| "could not cross-check the server's box list")?;
        let listed_deleting = boxes
            .iter()
            .any(|b| b.box_id == control.box_id && b.state == "deleting");
        if !listed_deleting {
            return Err("the server's box list does not show this box as deleting");
        }
        let ledger = Ledger::load(&self.state_dir).map_err(|_| "ledger unreadable")?;
        if ledger.deleted_in_last_day(now_seconds()) >= self.cfg.shred.delete_daily_cap {
            return Err("the daily box deletion cap is reached");
        }
        Ok(())
    }

    async fn report(&self, control_id: Uuid, body: CompleteBody) -> bool {
        match self.server.complete(control_id, &body).await {
            Ok(()) => true,
            Err(ClientError::Stale) => {
                tracing::info!(%control_id, "completion fenced out: the lease is no longer ours");
                false
            }
            Err(error) => {
                tracing::warn!(%control_id, error = %error, "could not report a control");
                false
            }
        }
    }

    /// One poll: claim, then run and report each control in delivery order.
    pub async fn poll_once(&self) -> Result<PollSummary, RunnerError> {
        let claimed = self.server.claim(10).await?;
        let mut summary = PollSummary {
            poisoned: claimed.poisoned.len(),
            ..PollSummary::default()
        };
        for id in &claimed.poisoned {
            tracing::warn!(control_id = %id, "the server gave up on a control (attempts exhausted)");
        }
        for raw in &claimed.controls {
            match intake(raw, &self.cfg.caps) {
                Intake::Accepted(control) => {
                    let body = if control.task == Task::Delete {
                        match self.delete_guard(&control).await {
                            Ok(()) => {
                                tracing::warn!(box_id = %control.box_id, "DELETE: destroying a box's container and volume on the server's delete control");
                                let body = self.executor.execute(&control).await;
                                if body.ok {
                                    if let Ok(mut ledger) = Ledger::load(&self.state_dir) {
                                        ledger.record_delete(now_seconds());
                                        let _ = ledger.save(&self.state_dir);
                                    }
                                }
                                body
                            }
                            Err(reason) => {
                                tracing::error!(box_id = %control.box_id, reason, "DELETE REFUSED: nothing was destroyed");
                                CompleteBody {
                                    lease_id: control.lease_id,
                                    attempts: control.attempts,
                                    ok: false,
                                    observed: None,
                                    deletion: None,
                                }
                            }
                        }
                    } else {
                        self.executor.execute(&control).await
                    };
                    tracing::info!(
                        control_id = %control.id,
                        verb = control.task.verb().as_str(),
                        ok = body.ok,
                        "control executed"
                    );
                    summary.executed += 1;
                    if !self.report(control.id, body).await {
                        summary.stale += 1;
                    }
                }
                Intake::Refused(Refused { reason, reportable }) => {
                    tracing::warn!(reason = reason.as_str(), "control refused; not executed");
                    summary.refused += 1;
                    match reportable {
                        Some((id, lease_id, attempts)) => {
                            let body = CompleteBody {
                                lease_id,
                                attempts,
                                ok: false,
                                observed: None,
                                deletion: None,
                            };
                            self.report(id, body).await;
                        }
                        None => summary.unreportable += 1,
                    }
                }
            }
        }
        Ok(summary)
    }

    /// Compare local volumes with the server's list and carry out the plan.
    pub async fn reconcile_once(&self) -> Result<Plan, RunnerError> {
        let server: Vec<ServerBox> = self.server.boxes().await?;
        let local = self.engine.local_box_volumes().await?;
        let mut ledger = Ledger::load(&self.state_dir)?;
        let now = now_seconds();
        // A ledger entry whose volume is gone has nothing left to hold.
        ledger.entries.retain(|id, _| local.contains(id));
        let plan = plan(&local, &server, &ledger, now, &self.cfg.shred);
        if let Some(suspicion) = plan.suspicion {
            tracing::warn!(
                ?suspicion,
                "reconciliation distrusts the server's list; acting on none of it"
            );
        }
        for action in &plan.actions {
            match *action {
                Action::Release(id) => {
                    ledger.entries.remove(&id);
                }
                Action::Quarantine(id) => {
                    if self.engine.container_state(id).await? == ContainerState::Running {
                        let _ = self.engine.stop(id).await;
                    }
                    ledger.entries.insert(
                        id,
                        crate::ledger::Entry {
                            quarantined_at: now,
                            confirmed: false,
                        },
                    );
                    tracing::warn!(box_id = %id, "orphan volume quarantined (container stopped, volume kept)");
                }
                Action::Hold(id, reason) => {
                    tracing::info!(box_id = %id, ?reason, "orphan volume held");
                }
                Action::Shred(id) => {
                    let _ = self.engine.stop(id).await;
                    let _ = self.engine.remove_container(id).await;
                    if let Err(error) = self.engine.shred_volume(id).await {
                        tracing::warn!(box_id = %id, error = %error, "overwrite failed; removing anyway");
                    }
                    let _ = self.engine.remove_volume(id).await;
                    if matches!(self.engine.volume_present(id).await, Ok(false)) {
                        ledger.entries.remove(&id);
                        ledger.record_shred(now);
                        tracing::warn!(box_id = %id, "orphan volume destroyed (operator-confirmed, grace elapsed)");
                    }
                }
            }
            ledger.save(&self.state_dir)?;
        }
        ledger.save(&self.state_dir)?;
        Ok(plan)
    }

    /// Run until `shutdown` flips. Polls every `pollIntervalSeconds`; reconciles every
    /// `reconcileIntervalSeconds`. A refused credential stops the runner (nothing it could
    /// do would help); transport errors back off and retry.
    pub async fn run(&self, mut shutdown: watch::Receiver<bool>) -> Result<(), RunnerError> {
        self.preflight().await?;
        let poll = Duration::from_secs(self.cfg.poll_interval_seconds);
        let reconcile_every = Duration::from_secs(self.cfg.reconcile_interval_seconds);
        let mut last_reconcile: Option<std::time::Instant> = None;
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            match self.poll_once().await {
                Ok(summary) => {
                    if summary.executed + summary.refused > 0 {
                        tracing::info!(?summary, "poll");
                    }
                }
                Err(RunnerError::Client(ClientError::Unauthorized)) => {
                    return Err(ClientError::Unauthorized.into());
                }
                Err(RunnerError::Client(ClientError::NotEnabled)) => {
                    tracing::warn!("the cloud box API is not enabled on the server; waiting");
                }
                Err(error) => tracing::warn!(error = %error, "poll failed"),
            }
            if last_reconcile.is_none_or(|at| at.elapsed() >= reconcile_every) {
                match self.reconcile_once().await {
                    Ok(plan) => {
                        if !plan.actions.is_empty() {
                            tracing::info!(actions = plan.actions.len(), "reconciled");
                        }
                    }
                    Err(error) => tracing::warn!(error = %error, "reconcile failed"),
                }
                last_reconcile = Some(std::time::Instant::now());
            }
            tokio::select! {
                _ = tokio::time::sleep(poll) => {}
                _ = shutdown.changed() => {}
            }
        }
    }
}
