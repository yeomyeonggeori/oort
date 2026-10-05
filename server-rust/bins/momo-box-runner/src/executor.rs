//! Executing one accepted control (ADR-0197 D2/D3/D10). One function per verb; each ends in
//! a [`CompleteBody`] whose whole vocabulary is a flag, one of three words, two booleans.
//!
//! Every operation is idempotent so a lease that is re-issued after a crash can simply run
//! again: `create` on a half-created box finishes it, `start` on a running one is a no-op,
//! `delete` of what is already gone reports the absence it verified.

use std::time::Duration;

use uuid::Uuid;

use crate::engine::{ContainerState, Engine, EngineError};
use crate::wire::{CompleteBody, Control, DeletionReport, Limits, Observed, Task};

/// How the runner waits for a started container to be seen running.
#[derive(Debug, Clone, Copy)]
pub struct Pacing {
    pub running_polls: u32,
    pub running_poll_delay: Duration,
    pub create_attempts: u32,
    pub create_retry_delay: Duration,
}

impl Default for Pacing {
    fn default() -> Self {
        Pacing {
            running_polls: 20,
            running_poll_delay: Duration::from_millis(500),
            create_attempts: 3,
            create_retry_delay: Duration::from_secs(2),
        }
    }
}

#[derive(Clone)]
pub struct Executor {
    engine: Engine,
    pacing: Pacing,
}

impl Executor {
    pub fn new(engine: Engine, pacing: Pacing) -> Self {
        Executor { engine, pacing }
    }

    /// Run a control and build what is reported back for it.
    pub async fn execute(&self, control: &Control) -> CompleteBody {
        let mut body = CompleteBody {
            lease_id: control.lease_id,
            attempts: control.attempts,
            ok: false,
            observed: None,
            deletion: None,
        };
        match control.task {
            Task::Create(limits) => {
                body.ok = self.create(control.box_id, &limits).await;
            }
            Task::Start => {
                body.ok = self.start(control.box_id).await.is_ok();
            }
            Task::Stop => {
                body.ok = self.stop(control.box_id).await.is_ok();
            }
            Task::Delete => {
                let report = self.delete(control.box_id).await;
                body.ok = report.container_absent && report.volume_absent;
                body.deletion = Some(report);
            }
            Task::Status => {
                if let Ok(observed) = self.status(control.box_id).await {
                    body.ok = true;
                    body.observed = Some(observed);
                }
            }
        }
        body
    }

    async fn wait_running(&self, box_id: Uuid) -> Result<(), EngineError> {
        for poll in 0..self.pacing.running_polls {
            if self.engine.container_state(box_id).await? == ContainerState::Running {
                return Ok(());
            }
            if poll + 1 < self.pacing.running_polls {
                tokio::time::sleep(self.pacing.running_poll_delay).await;
            }
        }
        Err(EngineError::Refused("container did not reach running"))
    }

    async fn create_once(&self, box_id: Uuid, limits: &Limits) -> Result<(), EngineError> {
        if !self.engine.volume_present(box_id).await? {
            self.engine.create_volume(box_id, limits).await?;
        }
        match self.engine.container_state(box_id).await? {
            ContainerState::Absent => {
                self.engine.create_container(box_id, limits).await?;
                self.engine.start(box_id).await?;
            }
            ContainerState::Stopped => self.engine.start(box_id).await?,
            ContainerState::Running => {}
        }
        self.wait_running(box_id).await
    }

    /// `create`: the box's volume, then its container from the fixed template, started and
    /// seen running. A failure removes what this box has (the server closes a failed
    /// create as `deleted`, so nothing of it may stay behind).
    async fn create(&self, box_id: Uuid, limits: &Limits) -> bool {
        for attempt in 1..=self.pacing.create_attempts.max(1) {
            match self.create_once(box_id, limits).await {
                Ok(()) => return true,
                Err(error) => {
                    tracing::warn!(%box_id, attempt, error = %error, "create failed");
                    if attempt < self.pacing.create_attempts {
                        tokio::time::sleep(self.pacing.create_retry_delay).await;
                    }
                }
            }
        }
        let _ = self.engine.remove_container(box_id).await;
        let _ = self.engine.remove_volume(box_id).await;
        false
    }

    async fn start(&self, box_id: Uuid) -> Result<(), EngineError> {
        match self.engine.container_state(box_id).await? {
            ContainerState::Absent => Err(EngineError::Refused("no such box")),
            ContainerState::Running => Ok(()),
            ContainerState::Stopped => {
                self.engine.start(box_id).await?;
                self.wait_running(box_id).await
            }
        }
    }

    async fn stop(&self, box_id: Uuid) -> Result<(), EngineError> {
        match self.engine.container_state(box_id).await? {
            ContainerState::Absent => Err(EngineError::Refused("no such box")),
            ContainerState::Stopped => Ok(()),
            ContainerState::Running => {
                self.engine.stop(box_id).await?;
                if self.engine.container_state(box_id).await? == ContainerState::Running {
                    Err(EngineError::Refused("container still running"))
                } else {
                    Ok(())
                }
            }
        }
    }

    /// `delete` (D10): stop and remove the container, overwrite and remove the volume, then
    /// **check both are gone** and report what was seen. The server closes the box only if
    /// both checks say absent.
    async fn delete(&self, box_id: Uuid) -> DeletionReport {
        let _ = self.engine.stop(box_id).await;
        let _ = self.engine.remove_container(box_id).await;
        if self.engine.config().shred.on_delete
            && matches!(self.engine.volume_present(box_id).await, Ok(true))
        {
            if let Err(error) = self.engine.shred_volume(box_id).await {
                tracing::warn!(%box_id, error = %error, "overwrite before removal failed; removing anyway");
            }
        }
        let _ = self.engine.remove_volume(box_id).await;
        DeletionReport {
            // A check that cannot be made is not an absence.
            container_absent: matches!(
                self.engine.container_state(box_id).await,
                Ok(ContainerState::Absent)
            ),
            volume_absent: matches!(self.engine.volume_present(box_id).await, Ok(false)),
        }
    }

    /// `status`: one of three words, from a list call. No `inspect`, no env.
    async fn status(&self, box_id: Uuid) -> Result<Observed, EngineError> {
        Ok(match self.engine.container_state(box_id).await? {
            ContainerState::Absent => Observed::Absent,
            ContainerState::Stopped => Observed::Stopped,
            ContainerState::Running => Observed::Running,
        })
    }
}
