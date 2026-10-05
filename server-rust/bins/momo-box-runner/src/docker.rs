//! The only door to Docker (ADR-0197 D2: 「Docker API를 고정 템플릿으로만 호출」).
//!
//! The runner calls the `docker` CLI with an **argv vector** (never a shell string)
//! through [`DockerOp`], a closed list of nine operations. There is no way to express an
//! operation outside it: a caller names an op and supplies the arguments the fixed
//! templates in `template.rs` built. In particular this list has nothing that runs a
//! command inside a box, copies files in or out of one, commits or exports one, snapshots
//! a volume, or reads what a container or volume holds; `tests/verbs_are_closed.rs` pins
//! the list and scans the crate's source for the subcommands that would.
//!
//! What comes back is a success flag and text. The text is parsed into small closed
//! types by `engine.rs` (a running/stopped flag, a name); it is never forwarded.

use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;

/// The nine docker operations the runner can perform. Nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DockerOp {
    VolumeCreate,
    VolumeRemove,
    VolumeList,
    ContainerCreate,
    ContainerStart,
    ContainerStop,
    ContainerRemove,
    ContainerList,
    /// The one-shot, network-less, capability-minimal helper that overwrites the files of
    /// ONE box volume before it is removed (`template::shred_args`). It writes; it reads
    /// nothing back.
    OneShotRun,
}

impl DockerOp {
    pub const ALL: [DockerOp; 9] = [
        DockerOp::VolumeCreate,
        DockerOp::VolumeRemove,
        DockerOp::VolumeList,
        DockerOp::ContainerCreate,
        DockerOp::ContainerStart,
        DockerOp::ContainerStop,
        DockerOp::ContainerRemove,
        DockerOp::ContainerList,
        DockerOp::OneShotRun,
    ];

    /// The docker subcommand words this op starts with.
    pub fn subcommand(self) -> &'static [&'static str] {
        match self {
            DockerOp::VolumeCreate => &["volume", "create"],
            DockerOp::VolumeRemove => &["volume", "rm"],
            DockerOp::VolumeList => &["volume", "ls"],
            DockerOp::ContainerCreate => &["create"],
            DockerOp::ContainerStart => &["start"],
            DockerOp::ContainerStop => &["stop"],
            DockerOp::ContainerRemove => &["rm"],
            DockerOp::ContainerList => &["ps"],
            DockerOp::OneShotRun => &["run"],
        }
    }

    fn timeout(self) -> Duration {
        match self {
            DockerOp::OneShotRun => Duration::from_secs(600),
            DockerOp::ContainerCreate | DockerOp::ContainerRemove | DockerOp::VolumeRemove => {
                Duration::from_secs(180)
            }
            _ => Duration::from_secs(60),
        }
    }
}

/// A finished docker call.
#[derive(Clone, PartialEq, Eq)]
pub struct DockerOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

// A manual Debug: a log line must never carry docker's output by accident.
impl std::fmt::Debug for DockerOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DockerOutput")
            .field("success", &self.success)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DockerError {
    #[error("cannot run docker: {0}")]
    Spawn(String),
    #[error("docker did not answer in time")]
    Timeout,
}

#[async_trait]
pub trait Docker: Send + Sync {
    async fn run(&self, op: DockerOp, args: Vec<String>) -> Result<DockerOutput, DockerError>;
}

/// The real thing: `docker <subcommand> <args…>`, no shell, stdin closed.
pub struct CliDocker {
    bin: String,
}

impl CliDocker {
    pub fn new(bin: impl Into<String>) -> Self {
        CliDocker { bin: bin.into() }
    }
}

#[async_trait]
impl Docker for CliDocker {
    async fn run(&self, op: DockerOp, args: Vec<String>) -> Result<DockerOutput, DockerError> {
        let mut command = tokio::process::Command::new(&self.bin);
        command
            .args(op.subcommand())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(op.timeout(), command.output())
            .await
            .map_err(|_| DockerError::Timeout)?
            .map_err(|error| DockerError::Spawn(error.to_string()))?;
        Ok(DockerOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
