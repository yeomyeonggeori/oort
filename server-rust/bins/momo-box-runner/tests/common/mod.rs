//! Shared fixtures for the runner's integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use momo_box_runner::config::{DiskQuota, RunnerConfig, ShredConfig};
use momo_box_runner::docker::Docker;
use momo_box_runner::engine::Engine;
use momo_box_runner::executor::{Executor, Pacing};
use momo_box_runner::wire::Limits;
use uuid::Uuid;

pub const WORKSPACE: &str = "11111111-2222-4333-8444-555555555555";
pub const PREFIX: &str = "momo-m2-";
pub const IMAGE: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

pub fn config(state_dir: &Path) -> RunnerConfig {
    RunnerConfig::parse(
        &serde_json::json!({
            "serverUrl": "https://oort.example.test",
            "workspaceId": WORKSPACE,
            "credentialFile": "/nonexistent/credential",
            "image": IMAGE,
            "namePrefix": PREFIX,
            "network": "momo-m2-net",
            "diskQuota": "unenforced-dev",
            "stateDir": state_dir,
        })
        .to_string(),
    )
    .expect("valid test config")
}

pub fn config_with(state_dir: &Path, edit: impl FnOnce(&mut RunnerConfig)) -> RunnerConfig {
    let mut cfg = config(state_dir);
    edit(&mut cfg);
    cfg.validate().expect("edited config stays valid");
    cfg
}

pub fn fast_pacing() -> Pacing {
    Pacing {
        running_polls: 3,
        running_poll_delay: Duration::from_millis(1),
        create_attempts: 3,
        create_retry_delay: Duration::from_millis(1),
    }
}

pub fn engine(docker: Arc<dyn Docker>, cfg: RunnerConfig) -> (Engine, Arc<RunnerConfig>) {
    let cfg = Arc::new(cfg);
    (Engine::new(docker, cfg.clone()), cfg)
}

pub fn executor(
    docker: Arc<dyn Docker>,
    cfg: RunnerConfig,
) -> (Executor, Engine, Arc<RunnerConfig>) {
    let (engine, cfg) = engine(docker, cfg);
    (Executor::new(engine.clone(), fast_pacing()), engine, cfg)
}

pub fn adr_limits() -> Limits {
    Limits::ADR_CEILING
}

pub fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("momo-m2-{label}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

pub fn control_json(
    verb: &str,
    box_id: Uuid,
    limits: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": Uuid::new_v4(),
        "leaseId": Uuid::new_v4(),
        "attempts": 1,
        "seq": 7,
        "boxId": box_id,
        "verb": verb,
    });
    if let Some(limits) = limits {
        value["limits"] = limits;
    }
    value
}

pub fn limits_json() -> serde_json::Value {
    serde_json::json!({"cpuMillis": 1000, "memoryMb": 2048, "diskGb": 10, "pids": 512})
}

pub fn source_files() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("src dir") {
        let path = entry.expect("entry").path();
        if path.extension().is_some_and(|e| e == "rs") {
            files.push((
                path.file_name()
                    .expect("name")
                    .to_string_lossy()
                    .into_owned(),
                std::fs::read_to_string(&path).expect("source"),
            ));
        }
    }
    files.sort();
    files
}

/// Source with `//` comments blanked, so scans see code and string literals only.
pub fn strip_line_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| match line.find("//") {
            Some(at) if !line[..at].contains('"') => line[..at].to_string(),
            _ => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn unused_shred_config() -> ShredConfig {
    ShredConfig::default()
}

pub fn quota_enforced(cfg: &mut RunnerConfig) {
    cfg.disk_quota = DiskQuota::LocalDriverSize;
}
