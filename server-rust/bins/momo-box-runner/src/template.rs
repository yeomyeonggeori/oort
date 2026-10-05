//! The fixed box template (ADR-0197 D1/D2/D8/D9). Every argument a box is created with is
//! built here from the runner's own configuration plus the box id and four limits; no
//! server-supplied string reaches an argument (the only variable inputs are a parsed UUID
//! and four integers).
//!
//! The shape is the S3 hardening (`infra/personal-box/momo-s3-box.sh`) with the two
//! differences M3 documented (`verify-m3.sh`): the container starts as root and keeps
//! exactly `CAP_SETUID` + `CAP_SETGID` so the box-agent can start the person's PTY under
//! another uid, and the agent is started by the image's entry script. **The box volume is
//! the only mount**: one named volume, at the person's home. Everything else is a tmpfs.

use uuid::Uuid;

use crate::config::{DiskQuota, RunnerConfig};
use crate::wire::Limits;

pub const LABEL_BOX: &str = "io.oort.box";
pub const LABEL_WORKSPACE: &str = "io.oort.workspace";
pub const LABEL_BOX_ID: &str = "io.oort.box-id";
/// Where the box volume is mounted: the person's home.
pub const VOLUME_MOUNT: &str = "/home/box";

const PERSON_UID: u32 = 10001;
/// The box-agent's uid and gid (the image's `box-agent` account).
pub const AGENT_UID: u32 = 10002;
/// Where the runner's read-only inject directory appears inside a box.
pub const INJECT_MOUNT: &str = "/run/oort-runner";
/// Where the persistent host key and agent state live inside a box when the runner has a `hostKeyRoot`.
pub const KEY_MOUNT: &str = "/var/lib/oort-box";

/// What a box gets beyond its volume (ADR-0197 M4 증보 2). Both are runner-created host directories:
/// the **inject** directory is read-only (seal key, pairing code, first owner device list — the runner's, root-owned,
/// readable by the agent's group alone), the **key** directory is the persistent, box-agent-owned home of the host key
/// and the agent's state, on a host filesystem mounted `nosuid,nodev`.
#[derive(Debug, Clone)]
pub struct BoxMounts {
    pub inject_dir: std::path::PathBuf,
    pub key_dir: Option<std::path::PathBuf>,
}

fn labels(cfg: &RunnerConfig, box_id: Uuid) -> Vec<String> {
    vec![
        "--label".into(),
        format!("{LABEL_BOX}=1"),
        "--label".into(),
        format!("{LABEL_WORKSPACE}={}", cfg.workspace_id.as_hyphenated()),
        "--label".into(),
        format!("{LABEL_BOX_ID}={}", box_id.as_hyphenated()),
    ]
}

/// `docker volume create` arguments for a box.
pub fn volume_create_args(cfg: &RunnerConfig, box_id: Uuid, limits: &Limits) -> Vec<String> {
    let mut args = labels(cfg, box_id);
    if cfg.disk_quota == DiskQuota::LocalDriverSize {
        args.push("--opt".into());
        args.push(format!("size={}g", limits.disk_gb));
    }
    args.push(cfg.resource_name(box_id));
    args
}

/// `--cpus` value from millicores: 1000 → `1.000`.
fn cpus(cpu_millis: u32) -> String {
    format!("{}.{:03}", cpu_millis / 1000, cpu_millis % 1000)
}

fn tmpfs(path: &str, options: &str) -> [String; 2] {
    ["--tmpfs".to_string(), format!("{path}:{options}")]
}

/// `docker create` arguments for a box with nothing but its volume (the M2 shape; every host-key and agent
/// state path is tmpfs). The image is the last argument.
pub fn create_args(cfg: &RunnerConfig, box_id: Uuid, limits: &Limits) -> Vec<String> {
    create_args_with(cfg, box_id, limits, None)
}

/// `docker create` arguments for a box, with the M4 mounts when the runner has them. The mount set is then
/// exactly: the box volume, the runner's read-only inject directory, and (with a `hostKeyRoot`) the persistent
/// key directory. The image is the last argument.
pub fn create_args_with(
    cfg: &RunnerConfig,
    box_id: Uuid,
    limits: &Limits,
    mounts: Option<&BoxMounts>,
) -> Vec<String> {
    let name = cfg.resource_name(box_id);
    let memory = format!("{}m", limits.memory_mb);
    let mut args: Vec<String> = vec![
        "--name".into(),
        name.clone(),
        "--pull".into(),
        "never".into(),
    ];
    args.extend(labels(cfg, box_id));
    args.extend(
        [
            // PID 1 reaps; the box never restarts by itself (a stopped box stays stopped).
            "--init",
            "--restart",
            "no",
            // S3 hardening: read-only rootfs, no capabilities but the two M3 documents,
            // no-new-privileges, core dumps off, no docker log (a login URL on a TTY must
            // never be persisted by docker, D8).
            "--read-only",
            "--user",
            "0:0",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "SETUID",
            "--cap-add",
            "SETGID",
            "--security-opt",
            "no-new-privileges",
            "--ulimit",
            "core=0",
            "--log-driver",
            "none",
        ]
        .map(String::from),
    );
    // Limits (D3): the control's four numbers, already checked against the local caps.
    args.extend([
        "--pids-limit".into(),
        limits.pids.to_string(),
        "--memory".into(),
        memory.clone(),
        "--memory-swap".into(),
        memory,
        "--cpus".into(),
        cpus(limits.cpu_millis),
    ]);
    // Network (D9): the pre-created icc=false bridge the egress rules apply to; public
    // resolvers only.
    args.extend(["--network".into(), cfg.network.clone()]);
    for server in &cfg.dns {
        args.extend(["--dns".into(), server.clone()]);
    }
    // The ONE mount: this box's own volume, at the person's home.
    args.extend([
        "--mount".into(),
        format!("type=volume,src={name},dst={VOLUME_MOUNT}"),
    ]);
    // Everything else the box writes is a tmpfs.
    let person = format!("uid={PERSON_UID},gid={PERSON_UID}");
    let agent = format!("uid={AGENT_UID},gid={AGENT_UID}");
    args.extend(tmpfs(
        "/cred",
        &format!("rw,noexec,nosuid,nodev,size=16m,mode=0700,{person}"),
    ));
    args.extend(tmpfs("/tmp", "rw,noexec,nosuid,nodev,size=128m,mode=1777"));
    args.extend(tmpfs(
        "/opt/tools",
        &format!("rw,exec,nosuid,nodev,size=768m,mode=0755,{person}"),
    ));
    args.extend(tmpfs(
        "/work",
        &format!("rw,noexec,nosuid,nodev,size=256m,mode=0755,{person}"),
    ));
    // The seal key is always on tmpfs (it must not share a device with the key it seals, D8). The host key and
    // the agent's state stay on tmpfs too unless the runner has a `hostKeyRoot`: Docker volumes cannot be mounted
    // nosuid,nodev, which the host-key store requires (ADR-0197 D1), so persistence needs the host's own mount.
    let persistent_key_dir = mounts.and_then(|m| m.key_dir.as_ref());
    let mut tmpfs_paths = vec!["/run/oort-box-seal"];
    if persistent_key_dir.is_none() {
        tmpfs_paths.extend(["/var/lib/oort-box/key", "/var/lib/oort-box/state"]);
    }
    for path in tmpfs_paths {
        args.extend(tmpfs(
            path,
            &format!("rw,nosuid,nodev,noexec,size=1m,mode=0700,{agent}"),
        ));
    }
    if let Some(mounts) = mounts {
        args.extend([
            "--mount".into(),
            format!(
                "type=bind,src={},dst={INJECT_MOUNT},readonly",
                mounts.inject_dir.display()
            ),
        ]);
        if let Some(key_dir) = &mounts.key_dir {
            args.extend([
                "--mount".into(),
                format!("type=bind,src={},dst={KEY_MOUNT}", key_dir.display()),
            ]);
        }
    }
    // The only environment: plumbing the agent needs, no secrets, nothing the server chose. (The pairing code, the
    // seal key and the owner list are files in the read-only inject directory, not environment.)
    let mut environment = vec![
        ("OORT_BOX_ID", box_id.as_hyphenated().to_string()),
        ("OORT_BOX_KEY_DIR", "/var/lib/oort-box/key".to_string()),
        (
            "OORT_BOX_SEAL_KEY_FILE",
            "/run/oort-box-seal/seal.key".to_string(),
        ),
        ("OORT_BOX_USER_UID", PERSON_UID.to_string()),
    ];
    if mounts.is_some() {
        environment.extend([
            ("OORT_SERVER_URL", cfg.box_server().to_string()),
            (
                "OORT_WORKSPACE_ID",
                cfg.workspace_id.as_hyphenated().to_string(),
            ),
            ("OORT_BOX_INJECT_DIR", INJECT_MOUNT.to_string()),
        ]);
    }
    for (key, value) in environment {
        args.extend(["--env".into(), format!("{key}={value}")]);
    }
    args.push(cfg.image.clone());
    args
}

/// `docker run` arguments for the volume-overwrite helper: no network, read-only root, no
/// capability but the two that let root write files it does not own, ONE mount (that box's
/// volume), a fixed entrypoint. It overwrites files and removes them; it reads nothing back.
pub fn shred_args(cfg: &RunnerConfig, box_id: Uuid) -> Vec<String> {
    let name = cfg.resource_name(box_id);
    [
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "256m",
        "--log-driver",
        "none",
        "--entrypoint",
        "/usr/local/bin/momo-box-volume-shred",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        "--mount".to_string(),
        format!("type=volume,src={name},dst=/v"),
        cfg.image.clone(),
    ])
    .collect()
}
