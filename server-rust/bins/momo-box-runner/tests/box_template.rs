//! ADR-0197 D1/D2/D9: what a box is created with is a fixed template; the box volume is the
//! only mount; the four limits come from the control and nothing else does.

mod common;

use std::collections::BTreeSet;

use momo_box_runner::config::DiskQuota;
use momo_box_runner::template::{create_args, shred_args, volume_create_args};
use momo_box_runner::wire::Limits;
use uuid::Uuid;

fn values_of<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    args.windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
        .collect()
}

fn args_for(limits: &Limits) -> (Vec<String>, Uuid) {
    let dir = common::temp_dir("template");
    let cfg = common::config(&dir);
    let id = Uuid::new_v4();
    let args = create_args(&cfg, id, limits);
    std::fs::remove_dir_all(&dir).ok();
    (args, id)
}

#[test]
fn the_box_volume_is_the_only_mount() {
    let (args, id) = args_for(&Limits::ADR_CEILING);
    let mounts = values_of(&args, "--mount");
    assert_eq!(
        mounts,
        [format!("type=volume,src=momo-m2-{id},dst=/home/box")],
        "exactly one --mount: the box's own named volume"
    );
    for flag in [
        "-v",
        "--volume",
        "--volumes-from",
        "--device",
        "--privileged",
        "--pid",
        "--ipc",
        "--uts",
        "--cgroupns",
    ] {
        assert!(!args.iter().any(|a| a == flag), "{flag} must not appear");
    }
    for arg in &args {
        assert!(!arg.contains("docker.sock"), "docker.sock in {arg}");
        assert!(!arg.starts_with("type=bind"), "a bind mount: {arg}");
        assert_ne!(arg, "host", "a host namespace: {arg}");
    }
    // Everything else the box writes is a tmpfs.
    let tmpfs: BTreeSet<String> = values_of(&args, "--tmpfs")
        .iter()
        .map(|t| t.split(':').next().expect("path").to_string())
        .collect();
    assert_eq!(
        tmpfs,
        [
            "/cred",
            "/tmp",
            "/opt/tools",
            "/work",
            "/var/lib/oort-box/key",
            "/var/lib/oort-box/state",
            "/run/oort-box-seal",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect::<BTreeSet<_>>()
    );
    for t in values_of(&args, "--tmpfs") {
        assert!(
            t.contains("nosuid") && t.contains("nodev"),
            "tmpfs without nosuid,nodev: {t}"
        );
    }
}

#[test]
fn the_s3_and_m3_hardening_is_all_there() {
    let (args, id) = args_for(&Limits::ADR_CEILING);
    let has = |flag: &str| args.iter().any(|a| a == flag);
    assert!(has("--read-only") && has("--init"));
    assert_eq!(values_of(&args, "--cap-drop"), ["ALL"]);
    assert_eq!(
        values_of(&args, "--cap-add")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["SETUID", "SETGID"]),
        "the only added capabilities are the two M3 documents"
    );
    assert_eq!(values_of(&args, "--security-opt"), ["no-new-privileges"]);
    assert_eq!(values_of(&args, "--log-driver"), ["none"]);
    assert_eq!(values_of(&args, "--ulimit"), ["core=0"]);
    assert_eq!(values_of(&args, "--pull"), ["never"]);
    assert_eq!(values_of(&args, "--restart"), ["no"]);
    assert_eq!(values_of(&args, "--network"), ["momo-m2-net"]);
    assert_eq!(values_of(&args, "--dns"), ["1.1.1.1", "9.9.9.9"]);
    assert_eq!(values_of(&args, "--name"), [format!("momo-m2-{id}")]);
    assert_eq!(
        args.last().map(String::as_str),
        Some(common::IMAGE),
        "the configured image, last"
    );
    assert_eq!(args.iter().filter(|a| *a == common::IMAGE).count(), 1);
    assert_eq!(
        values_of(&args, "--label")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "io.oort.box=1".to_string(),
            format!("io.oort.workspace={}", common::WORKSPACE),
            format!("io.oort.box-id={id}"),
        ])
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
    );
    // No credential or oort secret is ever an argument; the env is exactly the plumbing.
    let env: BTreeSet<&str> = values_of(&args, "--env")
        .iter()
        .map(|kv| kv.split('=').next().expect("key"))
        .collect();
    assert_eq!(
        env,
        BTreeSet::from([
            "OORT_BOX_ID",
            "OORT_BOX_KEY_DIR",
            "OORT_BOX_SEAL_KEY_FILE",
            "OORT_BOX_USER_UID"
        ])
    );
}

#[test]
fn the_limits_come_from_the_control_and_only_they_vary() {
    let (default, _) = args_for(&Limits::ADR_CEILING);
    assert_eq!(values_of(&default, "--pids-limit"), ["512"]);
    assert_eq!(values_of(&default, "--memory"), ["2048m"]);
    assert_eq!(
        values_of(&default, "--memory-swap"),
        ["2048m"],
        "no swap beyond the memory limit"
    );
    assert_eq!(values_of(&default, "--cpus"), ["1.000"]);
    let small = Limits {
        cpu_millis: 500,
        memory_mb: 1024,
        disk_gb: 5,
        pids: 64,
    };
    let dir = common::temp_dir("template-small");
    let cfg = common::config(&dir);
    let id = Uuid::new_v4();
    let a = create_args(&cfg, id, &small);
    assert_eq!(values_of(&a, "--pids-limit"), ["64"]);
    assert_eq!(values_of(&a, "--memory"), ["1024m"]);
    assert_eq!(values_of(&a, "--cpus"), ["0.500"]);
    // Changing only the limits changes only the limit arguments.
    let b = create_args(&cfg, id, &Limits::ADR_CEILING);
    let differing: Vec<usize> = (0..a.len()).filter(|i| a[*i] != b[*i]).collect();
    let allowed = ["64", "512", "1024m", "2048m", "0.500", "1.000"];
    for i in &differing {
        assert!(
            allowed.contains(&a[*i].as_str()),
            "unexpected template change at {}: {}",
            i,
            a[*i]
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_disk_limit_is_applied_to_the_volume_or_declared_unenforced() {
    let dir = common::temp_dir("template-disk");
    let id = Uuid::new_v4();
    let dev = common::config(&dir);
    assert_eq!(dev.disk_quota, DiskQuota::UnenforcedDev);
    assert!(!volume_create_args(&dev, id, &Limits::ADR_CEILING)
        .iter()
        .any(|a| a.starts_with("size=")));
    let mut enforced = common::config(&dir);
    common::quota_enforced(&mut enforced);
    let args = volume_create_args(&enforced, id, &Limits::ADR_CEILING);
    assert_eq!(values_of(&args, "--opt"), ["size=10g"]);
    assert_eq!(
        args.last().map(String::as_str),
        Some(format!("momo-m2-{id}").as_str())
    );
    let args = volume_create_args(
        &enforced,
        id,
        &Limits {
            disk_gb: 3,
            ..Limits::ADR_CEILING
        },
    );
    assert_eq!(values_of(&args, "--opt"), ["size=3g"]);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_overwrite_helper_has_no_network_and_one_mount() {
    let dir = common::temp_dir("template-shred");
    let cfg = common::config(&dir);
    let id = Uuid::new_v4();
    let args = shred_args(&cfg, id);
    assert_eq!(values_of(&args, "--network"), ["none"]);
    assert_eq!(
        values_of(&args, "--mount"),
        [format!("type=volume,src=momo-m2-{id},dst=/v")]
    );
    assert_eq!(
        values_of(&args, "--cap-add")
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["DAC_OVERRIDE", "FOWNER"])
    );
    assert_eq!(values_of(&args, "--cap-drop"), ["ALL"]);
    assert!(args.iter().any(|a| a == "--read-only") && args.iter().any(|a| a == "--rm"));
    assert_eq!(
        values_of(&args, "--entrypoint"),
        ["/usr/local/bin/momo-box-volume-shred"]
    );
    assert_eq!(args.last().map(String::as_str), Some(common::IMAGE));
    assert!(!args
        .iter()
        .any(|a| a == "--privileged" || a == "-v" || a == "--volume"));
    std::fs::remove_dir_all(&dir).ok();
}
