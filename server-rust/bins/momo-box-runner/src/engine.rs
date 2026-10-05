//! Typed access to the runner's docker resources: a box's container and volume, found by
//! label and by the exact name `<prefix><box uuid>`. Anything that is not exactly that is
//! not the runner's and is never touched (another project's containers on a shared dev
//! machine, a hand-made volume).
//!
//! **No docker `inspect` exists in this crate.** Presence and run-state come from list
//! calls with a fixed `--format`, parsed into the closed types below; the text itself never
//! leaves this module, so nothing a `status` control reports can contain docker's view of a
//! container's configuration or environment.

use std::sync::Arc;

use uuid::Uuid;

use crate::config::RunnerConfig;
use crate::docker::{Docker, DockerError, DockerOp, DockerOutput};
use crate::template::{self, BoxMounts, LABEL_BOX, LABEL_WORKSPACE};
use crate::wire::Limits;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Docker(#[from] DockerError),
    #[error("docker refused `{0}`")]
    Refused(&'static str),
    #[error("docker answered in a shape this runner does not understand")]
    Unreadable,
}

/// Where a box's container stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerState {
    Absent,
    Stopped,
    Running,
}

/// A labelled container as listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerRow {
    pub name: String,
    pub running: bool,
    pub workspace: String,
}

/// A labelled volume as listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeRow {
    pub name: String,
    pub workspace: String,
}

#[derive(Clone)]
pub struct Engine {
    docker: Arc<dyn Docker>,
    cfg: Arc<RunnerConfig>,
}

fn ensure(output: DockerOutput, what: &'static str) -> Result<DockerOutput, EngineError> {
    if output.success {
        Ok(output)
    } else {
        // Docker's own words stay out of the error: callers log `what` and move on.
        Err(EngineError::Refused(what))
    }
}

impl Engine {
    pub fn new(docker: Arc<dyn Docker>, cfg: Arc<RunnerConfig>) -> Self {
        Engine { docker, cfg }
    }

    pub fn config(&self) -> &RunnerConfig {
        &self.cfg
    }

    /// Every container carrying the box label, whoever made it.
    pub async fn containers(&self) -> Result<Vec<ContainerRow>, EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::ContainerList,
                vec![
                    "--all".into(),
                    "--no-trunc".into(),
                    "--filter".into(),
                    format!("label={LABEL_BOX}"),
                    "--format".into(),
                    format!("{{{{.Names}}}}\t{{{{.State}}}}\t{{{{.Label \"{LABEL_WORKSPACE}\"}}}}"),
                ],
            )
            .await?;
        let output = ensure(output, "ps")?;
        output
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut fields = line.split('\t');
                let (name, state, workspace) = (
                    fields.next().ok_or(EngineError::Unreadable)?,
                    fields.next().ok_or(EngineError::Unreadable)?,
                    fields.next().ok_or(EngineError::Unreadable)?,
                );
                Ok(ContainerRow {
                    name: name.to_string(),
                    running: state == "running",
                    workspace: workspace.to_string(),
                })
            })
            .collect()
    }

    /// Every volume carrying the box label.
    pub async fn volumes(&self) -> Result<Vec<VolumeRow>, EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::VolumeList,
                vec![
                    "--filter".into(),
                    format!("label={LABEL_BOX}"),
                    "--format".into(),
                    format!("{{{{.Name}}}}\t{{{{.Label \"{LABEL_WORKSPACE}\"}}}}"),
                ],
            )
            .await?;
        let output = ensure(output, "volume ls")?;
        output
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut fields = line.split('\t');
                Ok(VolumeRow {
                    name: fields.next().ok_or(EngineError::Unreadable)?.to_string(),
                    workspace: fields.next().ok_or(EngineError::Unreadable)?.to_string(),
                })
            })
            .collect()
    }

    /// The box ids of this runner's volumes: exact `<prefix><uuid>` names only.
    pub async fn local_box_volumes(&self) -> Result<Vec<Uuid>, EngineError> {
        Ok(self
            .volumes()
            .await?
            .iter()
            .filter_map(|row| self.cfg.box_id_of_name(&row.name))
            .collect())
    }

    pub async fn container_state(&self, box_id: Uuid) -> Result<ContainerState, EngineError> {
        let name = self.cfg.resource_name(box_id);
        Ok(
            match self.containers().await?.iter().find(|row| row.name == name) {
                None => ContainerState::Absent,
                Some(row) if row.running => ContainerState::Running,
                Some(_) => ContainerState::Stopped,
            },
        )
    }

    pub async fn volume_present(&self, box_id: Uuid) -> Result<bool, EngineError> {
        let name = self.cfg.resource_name(box_id);
        Ok(self.volumes().await?.iter().any(|row| row.name == name))
    }

    pub async fn create_volume(&self, box_id: Uuid, limits: &Limits) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::VolumeCreate,
                template::volume_create_args(&self.cfg, box_id, limits),
            )
            .await?;
        ensure(output, "volume create").map(|_| ())
    }

    pub async fn create_container(
        &self,
        box_id: Uuid,
        limits: &Limits,
        mounts: Option<&BoxMounts>,
    ) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::ContainerCreate,
                template::create_args_with(&self.cfg, box_id, limits, mounts),
            )
            .await?;
        ensure(output, "create").map(|_| ())
    }

    pub async fn start(&self, box_id: Uuid) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::ContainerStart,
                vec![self.cfg.resource_name(box_id)],
            )
            .await?;
        ensure(output, "start").map(|_| ())
    }

    pub async fn stop(&self, box_id: Uuid) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::ContainerStop,
                vec!["--time".into(), "10".into(), self.cfg.resource_name(box_id)],
            )
            .await?;
        ensure(output, "stop").map(|_| ())
    }

    pub async fn remove_container(&self, box_id: Uuid) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::ContainerRemove,
                vec!["--force".into(), self.cfg.resource_name(box_id)],
            )
            .await?;
        ensure(output, "rm").map(|_| ())
    }

    pub async fn remove_volume(&self, box_id: Uuid) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(DockerOp::VolumeRemove, vec![self.cfg.resource_name(box_id)])
            .await?;
        ensure(output, "volume rm").map(|_| ())
    }

    /// Overwrite the files of one box volume (the one-shot helper). Writes only.
    pub async fn shred_volume(&self, box_id: Uuid) -> Result<(), EngineError> {
        let output = self
            .docker
            .run(
                DockerOp::OneShotRun,
                template::shred_args(&self.cfg, box_id),
            )
            .await?;
        ensure(output, "run").map(|_| ())
    }
}
