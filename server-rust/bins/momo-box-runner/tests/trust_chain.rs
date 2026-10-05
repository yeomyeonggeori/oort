//! ADR-0197 M4 (증보 2): the runner's part of a box's trust chain.
//!
//! * the box template's mount set with and without the runner's mounts;
//! * what the runner hands a box (seal key, pairing code, owner list) and when it destroys it;
//! * the registration check: only a box that holds the pairing code is attested; **a registration the server made
//!   up** (it never sees the code) is rejected, not attested;
//! * the runner's identity file.

mod common;

use std::os::unix::fs::PermissionsExt as _;
use std::sync::Arc;

use momo_blind_pty::trust::{registration_mac, verify_attestation};
use momo_box_runner::client::PendingRegistration;
use momo_box_runner::config::{HostKeyRoot, PrepareKeyDirs};
use momo_box_runner::docker::DockerOp;
use momo_box_runner::engine::Engine;
use momo_box_runner::executor::Executor;
use momo_box_runner::identity::{IdentityError, RunnerIdentity};
use momo_box_runner::provision::{HostProvisioner, Provisioner};
use momo_box_runner::runner::{Runner, Trust};
use momo_box_runner::template::{create_args, create_args_with, BoxMounts};
use momo_box_runner::testing::{FakeDocker, FakeServer};
use momo_box_runner::wire::Limits;
use uuid::Uuid;

fn values_of<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    args.windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
        .collect()
}

fn mounts(key: bool) -> BoxMounts {
    BoxMounts {
        inject_dir: "/srv/runner/boxes/x/inject".into(),
        key_dir: key.then(|| "/mnt/oort-keys/x".into()),
    }
}

#[test]
fn without_the_runners_mounts_the_template_is_the_m2_one() {
    let dir = common::temp_dir("tc-m2");
    let cfg = common::config(&dir);
    let id = Uuid::new_v4();
    assert_eq!(
        create_args(&cfg, id, &Limits::ADR_CEILING),
        create_args_with(&cfg, id, &Limits::ADR_CEILING, None)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_mount_set_is_exactly_the_volume_the_read_only_inject_dir_and_the_key_dir() {
    let dir = common::temp_dir("tc-mounts");
    let cfg = common::config(&dir);
    let id = Uuid::new_v4();
    let args = create_args_with(&cfg, id, &Limits::ADR_CEILING, Some(&mounts(true)));
    let listed = values_of(&args, "--mount");
    assert_eq!(
        listed,
        [
            format!("type=volume,src=momo-m2-{id},dst=/home/box"),
            "type=bind,src=/srv/runner/boxes/x/inject,dst=/run/oort-runner,readonly".to_string(),
            "type=bind,src=/mnt/oort-keys/x,dst=/var/lib/oort-box".to_string(),
        ],
        "volume, read-only runner inject dir, persistent key dir — nothing else"
    );
    // The key and state tmpfs are replaced by the bind; the seal key stays on tmpfs.
    let tmpfs: Vec<&str> = values_of(&args, "--tmpfs")
        .into_iter()
        .map(|t| t.split(':').next().unwrap())
        .collect();
    assert!(!tmpfs.contains(&"/var/lib/oort-box/key"));
    assert!(!tmpfs.contains(&"/var/lib/oort-box/state"));
    assert!(tmpfs.contains(&"/run/oort-box-seal"), "the seal key never shares a device with the key");
    for arg in &args {
        assert!(!arg.contains("docker.sock"), "{arg}");
        assert!(!arg.contains("src=/ ") && !arg.contains("src=/,"), "{arg}");
    }
    // The only environment the runner adds: where to dial and where the inject dir is. No secret rides on it.
    let env = values_of(&args, "--env");
    assert!(env.contains(&"OORT_SERVER_URL=https://oort.example.test"));
    assert!(env.contains(&"OORT_BOX_INJECT_DIR=/run/oort-runner"));
    assert!(env.iter().any(|e| e.starts_with("OORT_WORKSPACE_ID=")));
    for item in &env {
        for forbidden in ["PAIRING", "SEAL_KEY=", "KEY=", "TOKEN", "SECRET", "PASSWORD"] {
            assert!(!item.contains(forbidden) || item.starts_with("OORT_BOX_SEAL_KEY_FILE="), "{item}");
        }
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn without_a_key_dir_the_key_and_state_stay_on_tmpfs() {
    let dir = common::temp_dir("tc-tmpfs");
    let cfg = common::config(&dir);
    let args = create_args_with(&cfg, Uuid::new_v4(), &Limits::ADR_CEILING, Some(&mounts(false)));
    assert_eq!(values_of(&args, "--mount").len(), 2);
    let tmpfs: Vec<&str> = values_of(&args, "--tmpfs")
        .into_iter()
        .map(|t| t.split(':').next().unwrap())
        .collect();
    assert!(tmpfs.contains(&"/var/lib/oort-box/key") && tmpfs.contains(&"/var/lib/oort-box/state"));
    std::fs::remove_dir_all(&dir).ok();
}

fn provisioner(
    dir: &std::path::Path,
    server: Arc<FakeServer>,
    key_root: Option<&std::path::Path>,
) -> (Arc<HostProvisioner>, Arc<momo_box_runner::config::RunnerConfig>) {
    let cfg = Arc::new(common::config_with(dir, |cfg| {
        cfg.host_key_root = key_root.map(|path| HostKeyRoot {
            path: path.to_path_buf(),
            prepare: PrepareKeyDirs::Runner,
        });
    }));
    (
        Arc::new(HostProvisioner::new(cfg.clone(), server).without_chown()),
        cfg,
    )
}

#[tokio::test]
async fn a_box_is_handed_a_seal_key_a_pairing_code_and_the_owner_list_and_they_survive_a_restart() {
    let dir = common::temp_dir("tc-prep");
    let keys = common::temp_dir("tc-prep-keys");
    let server = Arc::new(FakeServer::new());
    server.set_owner_list(Some(vec![1, 2, 3, 4]));
    let (prov, _) = provisioner(&dir, server, Some(&keys));
    let id = Uuid::new_v4();

    let mounts = prov.prepare(id).await.expect("prepare");
    assert_eq!(mounts.inject_dir, dir.join("boxes").join(id.to_string()).join("inject"));
    assert_eq!(mounts.key_dir, Some(keys.join(id.to_string())));
    let seal = std::fs::read_to_string(mounts.inject_dir.join("seal.key")).unwrap();
    let code = prov.pairing_code(id).expect("a pairing code was made");
    assert_eq!(code.len(), 32);
    assert_eq!(
        std::fs::read_to_string(mounts.inject_dir.join("owner-list.b64")).unwrap().trim(),
        "AQIDBA=="
    );
    // Not world- or group-writable, not readable by others: the agent's group reads, the person's uid cannot.
    for file in ["seal.key", "pairing.code", "owner-list.b64"] {
        let mode = std::fs::metadata(mounts.inject_dir.join(file)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o440, "{file}");
    }
    // The key directories exist, 0700.
    for sub in ["", "key", "state"] {
        let mode = std::fs::metadata(keys.join(id.to_string()).join(sub)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{sub:?}");
    }

    // A second `prepare` (a retried create, a restart) keeps the seal key and the pairing code.
    prov.prepare(id).await.expect("prepare again");
    assert_eq!(std::fs::read_to_string(mounts.inject_dir.join("seal.key")).unwrap(), seal);
    assert_eq!(prov.pairing_code(id), Some(code));

    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&keys).ok();
}

#[tokio::test]
async fn a_box_without_an_owner_list_is_not_created() {
    let dir = common::temp_dir("tc-nolist");
    let server = Arc::new(FakeServer::new());
    let (prov, cfg) = provisioner(&dir, server, None);
    let docker = Arc::new(FakeDocker::new());
    let (engine, _) = common::engine(docker.clone(), (*cfg).clone());
    let executor = Executor::new(engine, common::fast_pacing()).with_provisioner(prov.clone());
    let id = Uuid::new_v4();
    let control = momo_box_runner::wire::Control {
        id: Uuid::new_v4(),
        lease_id: Uuid::new_v4(),
        attempts: 1,
        box_id: id,
        task: momo_box_runner::wire::Task::Create(Limits::ADR_CEILING),
    };
    let body = executor.execute(&control).await;
    assert!(!body.ok, "no owner list, no box");
    assert!(
        !docker.calls().iter().any(|(op, _)| *op == DockerOp::ContainerCreate),
        "docker was never asked to create"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn delete_destroys_the_seal_key_and_the_boxs_directories() {
    let dir = common::temp_dir("tc-del");
    let keys = common::temp_dir("tc-del-keys");
    let server = Arc::new(FakeServer::new());
    server.set_owner_list(Some(vec![9]));
    let (prov, cfg) = provisioner(&dir, server, Some(&keys));
    let id = Uuid::new_v4();
    let mounts = prov.prepare(id).await.unwrap();
    let docker = Arc::new(FakeDocker::new());
    let (engine, _) = common::engine(docker, (*cfg).clone());
    let executor = Executor::new(engine, common::fast_pacing()).with_provisioner(prov.clone());
    let report = executor
        .execute(&momo_box_runner::wire::Control {
            id: Uuid::new_v4(),
            lease_id: Uuid::new_v4(),
            attempts: 1,
            box_id: id,
            task: momo_box_runner::wire::Task::Delete,
        })
        .await;
    assert!(report.ok);
    assert!(!mounts.inject_dir.join("seal.key").exists(), "the crypto-shred anchor is gone");
    assert!(!dir.join("boxes").join(id.to_string()).exists());
    assert!(!keys.join(id.to_string()).exists());
    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&keys).ok();
}

fn fresh_runner(
    dir: &std::path::Path,
    server: Arc<FakeServer>,
) -> (Runner, Arc<HostProvisioner>, [u8; 32]) {
    let cfg = Arc::new(common::config(dir));
    let (prov, _) = provisioner(dir, server.clone(), None);
    let identity_path = dir.join("runner.key");
    let identity = RunnerIdentity::create(&identity_path).expect("identity");
    let public = identity.public_key();
    let docker = Arc::new(FakeDocker::new());
    let engine = Engine::new(docker, cfg.clone());
    let executor = Executor::new(engine.clone(), common::fast_pacing());
    let runner = Runner::new(cfg, engine, executor, server).with_trust(Trust {
        identity,
        provisioner: prov.clone(),
    });
    (runner, prov, public)
}

#[tokio::test]
async fn only_a_box_that_holds_the_pairing_code_is_attested() {
    let dir = common::temp_dir("tc-att");
    let server = Arc::new(FakeServer::new());
    server.set_owner_list(Some(vec![1]));
    let (runner, prov, runner_public) = fresh_runner(&dir, server.clone());
    let id = Uuid::new_v4();
    prov.prepare(id).await.unwrap();
    let code = prov.pairing_code(id).unwrap();
    let host_key = [0x42u8; 32];

    // 1. The server (or anyone without the code) parks its own key with a MAC made with a guessed code: rejected.
    let forged = registration_mac(&[7u8; 32], id.as_bytes(), &host_key);
    server.park_registration(PendingRegistration {
        box_id: id,
        host_public_key: host_key,
        mac: forged.to_vec(),
    });
    let summary = runner.attest_registrations().await.unwrap();
    assert_eq!((summary.attested, summary.rejected), (0, 1));
    assert!(server.attested().is_empty());
    assert_eq!(server.rejected(), [(id, host_key)]);
    assert!(prov.pairing_code(id).is_some(), "a rejected registration does not spend the code");

    // 2. A MAC made for another key (replaying a real box's MAC with the server's own key): rejected.
    let real = registration_mac(&code, id.as_bytes(), &[0x11u8; 32]);
    server.park_registration(PendingRegistration {
        box_id: id,
        host_public_key: host_key,
        mac: real.to_vec(),
    });
    assert_eq!(runner.attest_registrations().await.unwrap().attested, 0);

    // 3. The box itself: attested, the attestation verifies under the runner's public key, the code is spent.
    let mac = registration_mac(&code, id.as_bytes(), &host_key);
    server.park_registration(PendingRegistration {
        box_id: id,
        host_public_key: host_key,
        mac: mac.to_vec(),
    });
    let summary = runner.attest_registrations().await.unwrap();
    assert_eq!((summary.attested, summary.rejected), (1, 0));
    let attested = server.attested();
    assert_eq!(attested.len(), 1);
    assert!(verify_attestation(&runner_public, id.as_bytes(), &host_key, &attested[0].2));
    assert!(prov.pairing_code(id).is_none(), "the one-time code is spent");

    // 4. The code is spent for good: the same MAC again (a replay) is rejected, and a restart does not bring it back.
    server.park_registration(PendingRegistration {
        box_id: id,
        host_public_key: host_key,
        mac: mac.to_vec(),
    });
    assert_eq!(runner.attest_registrations().await.unwrap().attested, 0);
    prov.prepare(id).await.unwrap();
    assert!(prov.pairing_code(id).is_none(), "a registered box never gets a new code");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_registration_for_a_box_this_runner_never_provisioned_is_rejected() {
    let dir = common::temp_dir("tc-unknown");
    let server = Arc::new(FakeServer::new());
    let (runner, _, _) = fresh_runner(&dir, server.clone());
    let id = Uuid::new_v4();
    server.park_registration(PendingRegistration {
        box_id: id,
        host_public_key: [5u8; 32],
        mac: vec![0u8; 32],
    });
    let summary = runner.attest_registrations().await.unwrap();
    assert_eq!((summary.attested, summary.rejected), (0, 1));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn the_runner_announces_its_public_key_and_nothing_else() {
    let dir = common::temp_dir("tc-announce");
    let server = Arc::new(FakeServer::new());
    let (runner, _, public) = fresh_runner(&dir, server.clone());
    runner.announce_identity().await.unwrap();
    assert_eq!(server.announced_identity(), Some(public));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_identity_is_created_once_loaded_strictly_and_its_fingerprint_is_the_key_hash() {
    let dir = common::temp_dir("tc-ident");
    let path = dir.join("runner.key");
    let created = RunnerIdentity::create(&path).unwrap();
    // `create_new`: a second create never replaces the key.
    assert!(matches!(RunnerIdentity::create(&path), Err(IdentityError::Exists(_))));
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let loaded = RunnerIdentity::load(&path).unwrap();
    assert_eq!(loaded.public_key(), created.public_key());
    // The fingerprint is SHA-256(public key), lowercase hex: what a member's device computes itself.
    let expected = {
        use sha2::{Digest as _, Sha256};
        hex::encode(Sha256::digest(created.public_key()))
    };
    assert_eq!(loaded.fingerprint_hex(), expected);
    assert_eq!(loaded.fingerprint_hex().len(), 64);
    // A key anyone else could read is refused.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
    assert!(matches!(RunnerIdentity::load(&path), Err(IdentityError::Permissions)));
    // Debug never prints the seed.
    let shown = format!("{created:?}");
    assert!(shown.contains("fingerprint") && !shown.contains("seed"));
    std::fs::remove_dir_all(&dir).ok();
}
