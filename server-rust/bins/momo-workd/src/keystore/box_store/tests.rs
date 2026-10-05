use std::os::unix::fs::PermissionsExt as _;
use std::sync::Mutex;

use super::*;

fn scratch(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "momo-workd-box-{}-{}",
        name,
        uuid::Uuid::new_v4().simple()
    ))
}

struct Fixture {
    root: PathBuf,
    dir: PathBuf,
    seal: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = scratch(name);
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.join("keys");
        let seal = root.join("seal.key");
        create_seal_key(&seal).unwrap();
        Self { root, dir, seal }
    }

    fn config(&self, backup: BackupState, sealed: bool) -> BoxKeyConfig {
        BoxKeyConfig {
            dir: self.dir.clone(),
            box_id: "box-a".into(),
            seal_key_file: sealed.then(|| self.seal.clone()),
            backup,
            // A real box keeps the seal key on tmpfs; the gate tests flip this.
            seal_key_on_other_device: true,
        }
    }

    fn store(&self, backup: BackupState, sealed: bool) -> BoxKeyStore {
        BoxKeyStore::new(self.config(backup, sealed))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().mode() & 0o777
}

// ---- file safety ----------------------------------------------------------

#[test]
fn a_sealed_key_round_trips_in_a_0600_file_inside_a_0700_dir_with_no_plaintext() {
    let f = Fixture::new("roundtrip");
    let store = f.store(BackupState::Unknown, true);
    assert!(store.load().unwrap().is_none());
    let key = HostKey::generate().unwrap();
    store.store(&key, false).unwrap();
    let file = f.dir.join(HOST_KEY_FILE);
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&f.dir), 0o700);
    let raw = std::fs::read(&file).unwrap();
    let raw_text = String::from_utf8(raw.clone()).unwrap();
    assert!(raw_text.starts_with(SEALED_MAGIC));
    assert!(
        !raw_text.contains(&BASE64.encode(key.seed)),
        "seed in the clear"
    );
    assert!(
        !raw.windows(SEED_LEN).any(|w| w == key.seed),
        "raw seed bytes"
    );
    assert_eq!(
        store.load().unwrap().unwrap().public_key_b64(),
        key.public_key_b64()
    );
    assert!(matches!(
        store.store(&HostKey::generate().unwrap(), false),
        Err(KeyStoreError::AlreadyExists(_))
    ));
}

#[test]
fn a_group_or_world_readable_key_file_is_refused() {
    let f = Fixture::new("loose-file");
    let store = f.store(BackupState::Unknown, true);
    store.store(&HostKey::generate().unwrap(), false).unwrap();
    let file = f.dir.join(HOST_KEY_FILE);
    for loose in [0o644, 0o640, 0o604] {
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(loose)).unwrap();
        match store.load() {
            Err(KeyStoreError::UnsafeFile { detail, .. }) => {
                assert!(detail.contains(&format!("{loose:04o}")), "{detail}")
            }
            other => panic!("mode {loose:04o} must be refused, got {other:?}"),
        }
    }
}

#[test]
fn a_key_folder_others_can_enter_is_refused_for_read_and_write() {
    let f = Fixture::new("loose-dir");
    let store = f.store(BackupState::Unknown, true);
    store.store(&HostKey::generate().unwrap(), false).unwrap();
    std::fs::set_permissions(&f.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        store.load(),
        Err(KeyStoreError::UnsafeFile { .. })
    ));
    assert!(matches!(
        store.store(&HostKey::generate().unwrap(), true),
        Err(KeyStoreError::UnsafeFile { .. })
    ));
}

#[test]
fn a_symlinked_key_file_is_refused() {
    let f = Fixture::new("symlink");
    let store = f.store(BackupState::Unknown, true);
    store.store(&HostKey::generate().unwrap(), false).unwrap();
    let file = f.dir.join(HOST_KEY_FILE);
    let real = f.dir.join("real.key");
    std::fs::rename(&file, &real).unwrap();
    std::os::unix::fs::symlink(&real, &file).unwrap();
    assert!(matches!(
        store.load(),
        Err(KeyStoreError::UnsafeFile { .. })
    ));
}

#[test]
fn a_loose_seal_key_file_is_treated_as_unusable_and_nothing_is_written() {
    let f = Fixture::new("loose-seal");
    let store = f.store(BackupState::Unknown, true);
    std::fs::set_permissions(&f.seal, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.store(&HostKey::generate().unwrap(), false).is_err());
    assert!(!f.dir.join(HOST_KEY_FILE).exists());
}

// ---- crypto-shred ---------------------------------------------------------

#[test]
fn destroying_the_seal_key_makes_every_copy_of_the_volume_unrecoverable() {
    let f = Fixture::new("shred");
    let store = f.store(BackupState::Unknown, true);
    let key = HostKey::generate().unwrap();
    store.store(&key, false).unwrap();
    assert_eq!(
        store.load().unwrap().unwrap().public_key_b64(),
        key.public_key_b64()
    );

    // A provider snapshot / un-trimmed block: the ciphertext, byte for byte.
    let snapshot = std::fs::read(f.dir.join(HOST_KEY_FILE)).unwrap();

    // The runner's whole delete-time job on the key: destroy the seal key.
    // It does not touch (or need to open) host.key.
    destroy_seal_key(&f.seal).unwrap();
    assert!(!f.seal.exists());
    destroy_seal_key(&f.seal).unwrap(); // idempotent

    assert!(matches!(store.load(), Err(KeyStoreError::SealKeyGone(_))));

    // Restoring the snapshot onto a box with a *new* seal key does not help.
    create_seal_key(&f.seal).unwrap();
    assert!(matches!(store.load(), Err(KeyStoreError::Unseal(_))));
    std::fs::write(f.dir.join(HOST_KEY_FILE), &snapshot).unwrap();
    std::fs::set_permissions(
        f.dir.join(HOST_KEY_FILE),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(matches!(store.load(), Err(KeyStoreError::Unseal(_))));
    assert!(!String::from_utf8_lossy(&snapshot).contains(&BASE64.encode(key.seed)));
}

#[test]
fn a_sealed_file_does_not_open_in_another_box_or_after_tampering() {
    let f = Fixture::new("aad");
    let store = f.store(BackupState::Unknown, true);
    store.store(&HostKey::generate().unwrap(), false).unwrap();
    let mut other = f.config(BackupState::Unknown, true);
    other.box_id = "box-b".into();
    assert!(matches!(
        BoxKeyStore::new(other).load(),
        Err(KeyStoreError::Unseal(_))
    ));

    let file = f.dir.join(HOST_KEY_FILE);
    let text = std::fs::read_to_string(&file).unwrap();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let mut ct = BASE64.decode(&lines[2]).unwrap();
    ct[0] ^= 1;
    lines[2] = BASE64.encode(ct);
    std::fs::write(&file, lines.join("\n") + "\n").unwrap();
    assert!(matches!(store.load(), Err(KeyStoreError::Unseal(_))));
}

// ---- persistence gate -----------------------------------------------------

#[test]
fn a_plaintext_key_is_refused_unless_backups_are_proven_off_and_nothing_is_written() {
    for backup in [BackupState::Unknown, BackupState::Present] {
        let f = Fixture::new("plain-refused");
        let store = f.store(backup, false);
        match store.store(&HostKey::generate().unwrap(), false) {
            Err(KeyStoreError::Refused(_)) => {}
            other => panic!("{backup:?}: expected Refused, got {other:?}"),
        }
        assert!(!f.dir.join(HOST_KEY_FILE).exists());
        assert!(!f.dir.exists() || std::fs::read_dir(&f.dir).unwrap().next().is_none());
    }
    let f = Fixture::new("plain-ok");
    let store = f.store(BackupState::ProvenOff, false);
    let key = HostKey::generate().unwrap();
    store.store(&key, false).unwrap();
    assert_eq!(
        store.load().unwrap().unwrap().public_key_b64(),
        key.public_key_b64()
    );
}

#[test]
fn an_existing_plaintext_key_is_refused_once_the_volume_may_be_backed_up() {
    let f = Fixture::new("plain-flipped");
    let key = HostKey::generate().unwrap();
    f.store(BackupState::ProvenOff, false)
        .store(&key, false)
        .unwrap();
    // The attestation changes (a snapshot job appears): start must refuse.
    for backup in [BackupState::Present, BackupState::Unknown] {
        assert!(matches!(
            f.store(backup, false).load(),
            Err(KeyStoreError::Refused(_))
        ));
    }
}

#[test]
fn a_sealed_key_on_a_backed_up_volume_needs_the_seal_key_on_another_device() {
    let f = Fixture::new("sealed-backup");
    let mut config = f.config(BackupState::Present, true);
    config.seal_key_on_other_device = false;
    let same = BoxKeyStore::new(config.clone());
    assert!(matches!(
        same.store(&HostKey::generate().unwrap(), false),
        Err(KeyStoreError::Refused(_))
    ));
    config.seal_key_on_other_device = true;
    let apart = BoxKeyStore::new(config);
    let key = HostKey::generate().unwrap();
    apart.store(&key, false).unwrap();
    assert_eq!(
        apart.load().unwrap().unwrap().public_key_b64(),
        key.public_key_b64()
    );
}

#[test]
fn the_attestation_only_counts_from_a_trusted_read_only_file() {
    let root = scratch("attest");
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("attest");
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    assert_eq!(
        BackupState::read(&file, uid),
        BackupState::Unknown,
        "missing"
    );
    std::fs::write(&file, "backups=none\n").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(BackupState::read(&file, uid), BackupState::ProvenOff);
    assert_eq!(
        BackupState::read(&file, uid + 1),
        BackupState::Unknown,
        "written by someone who is not the trusted writer"
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o664)).unwrap();
    assert_eq!(
        BackupState::read(&file, uid),
        BackupState::Unknown,
        "group-writable"
    );
    for (text, want) in [
        ("backups=present", BackupState::Present),
        ("backups=none", BackupState::ProvenOff),
        ("backups = none", BackupState::Unknown),
        ("", BackupState::Unknown),
    ] {
        assert_eq!(BackupState::parse(text), want, "{text:?}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn credentials_persist_on_the_volume_only_when_backups_are_proven_off() {
    assert_eq!(
        credential_placement(BackupState::ProvenOff),
        CredentialPlacement::Volume
    );
    assert_eq!(
        credential_placement(BackupState::Present),
        CredentialPlacement::Tmpfs
    );
    assert_eq!(
        credential_placement(BackupState::Unknown),
        CredentialPlacement::Tmpfs
    );
}

const MOUNTINFO: &str = "\
24 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
31 24 8:16 / /var/lib/oort/box rw,nosuid,nodev,noexec shared:2 - ext4 /dev/sdb rw
32 24 8:32 / /srv/loose rw,relatime - ext4 /dev/sdc rw
33 24 0:40 / /run/oort rw,nosuid,nodev - tmpfs tmpfs rw
35 24 8:64 / /srv/suid-only rw,nosuid - ext4 /dev/sde rw
34 24 8:48 / /srv/with\\040space rw,nosuid,nodev - ext4 /dev/sdd rw
";

#[test]
fn the_key_mount_must_be_nosuid_nodev_and_a_login_tmpfs_must_be_tmpfs() {
    assert!(require_nosuid_nodev(MOUNTINFO, Path::new("/var/lib/oort/box/keys")).is_ok());
    assert!(require_nosuid_nodev(MOUNTINFO, Path::new("/srv/with space/keys")).is_ok());
    for bad in ["/srv/loose/keys", "/srv/suid-only/keys", "/home/box/keys"] {
        assert!(
            matches!(
                require_nosuid_nodev(MOUNTINFO, Path::new(bad)),
                Err(KeyStoreError::Refused(_))
            ),
            "{bad}"
        );
    }
    assert!(
        require_nosuid_nodev("", Path::new("/x")).is_err(),
        "fail closed"
    );
    assert!(is_tmpfs(MOUNTINFO, Path::new("/run/oort/login")));
    assert!(!is_tmpfs(MOUNTINFO, Path::new("/var/lib/oort/box/login")));
}

#[test]
fn from_env_demands_an_absolute_dir_a_box_id_and_a_nosuid_mount() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    };
    assert!(BoxKeyStore::from_env(&env(&[]), None).is_err());
    assert!(
        BoxKeyStore::from_env(&env(&[(ENV_KEY_DIR, "rel/keys"), (ENV_BOX_ID, "b")]), None).is_err()
    );
    assert!(BoxKeyStore::from_env(&env(&[(ENV_KEY_DIR, "/var/lib/oort/box/keys")]), None).is_err());
    static OK: [(&str, &str); 2] = [(ENV_KEY_DIR, "/var/lib/oort/box/keys"), (ENV_BOX_ID, "b")];
    assert!(BoxKeyStore::from_env(&env(&OK), Some(MOUNTINFO)).is_ok());
    static LOOSE: [(&str, &str); 2] = [(ENV_KEY_DIR, "/srv/loose/keys"), (ENV_BOX_ID, "b")];
    assert!(BoxKeyStore::from_env(&env(&LOOSE), Some(MOUNTINFO)).is_err());
    // No attestation given -> Unknown -> credentials on tmpfs.
    let store = BoxKeyStore::from_env(&env(&OK), Some(MOUNTINFO)).unwrap();
    assert_eq!(store.credential_placement(), CredentialPlacement::Tmpfs);
}

// ---- rotation -------------------------------------------------------------

#[derive(Default)]
struct FakeRegistry {
    calls: Mutex<Vec<String>>,
    fail_register: bool,
    fail_revoke_old: Option<uuid::Uuid>,
    next_id: Mutex<u128>,
}

#[async_trait]
impl HostRegistry for FakeRegistry {
    async fn register(&self, public_key_b64: &str) -> Result<uuid::Uuid, String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("register {public_key_b64}"));
        if self.fail_register {
            return Err("server said no".into());
        }
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        Ok(uuid::Uuid::from_u128(1000 + *n))
    }
    async fn revoke(&self, host_id: uuid::Uuid) -> Result<(), String> {
        self.calls.lock().unwrap().push(format!("revoke {host_id}"));
        if self.fail_revoke_old == Some(host_id) {
            return Err("server unreachable".into());
        }
        Ok(())
    }
}

/// A box with a current key, registered as host 1.
fn registered_box(name: &str) -> (Fixture, BoxKeyStore, Registered) {
    let f = Fixture::new(name);
    let store = f.store(BackupState::Unknown, true);
    let key = HostKey::generate().unwrap();
    store.store(&key, false).unwrap();
    let old = Registered {
        host_id: uuid::Uuid::from_u128(1),
        public_key: key.public_key_b64(),
    };
    (f, store, old)
}

fn current_public(store: &BoxKeyStore) -> String {
    store.load().unwrap().unwrap().public_key_b64()
}

#[tokio::test]
async fn rotation_swaps_the_key_records_the_new_row_and_revokes_the_old_one() {
    let (_f, store, old) = registered_box("rot-ok");
    let registry = FakeRegistry::default();
    let mut recorded = None;
    let outcome = rotate(&store, &registry, &old, &mut |new| {
        recorded = Some(new.clone());
        Ok(())
    })
    .await
    .unwrap();
    let RotationOutcome::Rotated(new) = outcome else {
        panic!("expected Rotated");
    };
    assert_ne!(new.public_key, old.public_key);
    assert_eq!(
        current_public(&store),
        new.public_key,
        "key == registered key"
    );
    assert_eq!(recorded, Some(new.clone()));
    assert!(!store.staged_path().exists());
    let calls = registry.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].starts_with("register "));
    assert_eq!(calls[1], format!("revoke {}", old.host_id));
    assert_eq!(store.recover(&new.public_key).unwrap(), Recovery::Clean);
}

#[tokio::test]
async fn a_refused_registration_leaves_the_old_key_current_and_nothing_staged() {
    let (_f, store, old) = registered_box("rot-register-fails");
    let registry = FakeRegistry {
        fail_register: true,
        ..Default::default()
    };
    let result = rotate(&store, &registry, &old, &mut |_| panic!("not reached")).await;
    assert!(matches!(result, Err(RotationError::Register(_))));
    assert_eq!(current_public(&store), old.public_key);
    assert!(!store.staged_path().exists());
    assert_eq!(
        registry.calls.lock().unwrap().len(),
        1,
        "old row not revoked"
    );
}

#[tokio::test]
async fn a_failed_state_write_withdraws_the_new_row_and_keeps_the_old_key() {
    let (_f, store, old) = registered_box("rot-persist-fails");
    let registry = FakeRegistry::default();
    let result = rotate(&store, &registry, &old, &mut |_| Err("disk full".into())).await;
    assert!(matches!(result, Err(RotationError::Persist(_))));
    assert_eq!(current_public(&store), old.public_key);
    assert!(!store.staged_path().exists());
    let calls = registry.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1], format!("revoke {}", uuid::Uuid::from_u128(1001)));
    assert!(!calls.contains(&format!("revoke {}", old.host_id)));
}

#[tokio::test]
async fn a_failed_revoke_of_the_old_row_is_reported_and_the_state_stays_consistent() {
    let (_f, store, old) = registered_box("rot-revoke-fails");
    let registry = FakeRegistry {
        fail_revoke_old: Some(old.host_id),
        ..Default::default()
    };
    let outcome = rotate(&store, &registry, &old, &mut |_| Ok(()))
        .await
        .unwrap();
    let RotationOutcome::RevokePending {
        new, old_host_id, ..
    } = outcome
    else {
        panic!("expected RevokePending");
    };
    assert_eq!(old_host_id, old.host_id);
    assert_eq!(current_public(&store), new.public_key);
}

#[test]
fn recovery_resolves_every_crash_point_from_the_registered_public_key() {
    // Crash after staging / after register but before the state write: the
    // state still names the old key -> the staged key is discarded.
    let (_f, store, old) = registered_box("rec-discard");
    let staged = store.stage_next().unwrap();
    assert_eq!(
        store.recover(&old.public_key).unwrap(),
        Recovery::DiscardedStaged
    );
    assert_eq!(current_public(&store), old.public_key);
    assert!(!store.staged_path().exists());
    assert_ne!(staged, old.public_key);

    // Crash after the state write but before the rename: the state names the
    // staged key -> it is promoted. The server and the box agree again.
    let (_f2, store2, old2) = registered_box("rec-promote");
    let staged2 = store2.stage_next().unwrap();
    assert_eq!(store2.recover(&staged2).unwrap(), Recovery::PromotedStaged);
    assert_eq!(current_public(&store2), staged2);
    assert_ne!(staged2, old2.public_key);

    // The state names a key the box does not hold at all: refuse to guess.
    let (_f3, store3, _old3) = registered_box("rec-neither");
    store3.stage_next().unwrap();
    assert!(matches!(
        store3.recover("AAAA"),
        Err(KeyStoreError::Refused(_))
    ));
}

#[test]
fn the_dev_key_file_flag_is_rejected_inside_a_box() {
    let get = |name: &str| (name == ENV_BOX_MARKER).then(|| "1".to_string());
    assert!(crate::cli::dev_key_file_allowed(&get).is_err());
    assert!(crate::cli::dev_key_file_allowed(&|_: &str| None).is_ok());
}

#[test]
fn from_env_on_first_start_sees_the_volume_device_before_the_key_folder_exists() {
    let f = Fixture::new("first-boot");
    assert!(!f.dir.exists());
    // The seal key sits next to the volume here, so both resolve to the same
    // device, but the point is that the missing folder resolves at all.
    assert_eq!(
        device_of(&f.dir.join("not").join("there")),
        device_of(&f.root)
    );
    assert!(device_of(&f.dir).is_some());
}

#[test]
fn a_racing_first_start_cannot_overwrite_the_key_another_start_registered() {
    let f = Fixture::new("race");
    let store = f.store(BackupState::Unknown, true);
    let first = HostKey::generate().unwrap();
    store.store(&first, false).unwrap();
    // The existence check passed for the loser before the winner wrote: go
    // straight to the writer, as the interleaving would.
    let loser = HostKey::generate().unwrap();
    assert!(matches!(
        store.write_atomic(&store.current_path(), &loser, false),
        Err(KeyStoreError::AlreadyExists(_))
    ));
    assert_eq!(current_public(&store), first.public_key_b64());
    let leftovers: Vec<_> = std::fs::read_dir(&f.dir)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, vec![std::ffi::OsString::from(HOST_KEY_FILE)]);
}

#[tokio::test]
async fn a_new_rotation_refuses_to_clobber_a_staged_key_left_by_a_crash() {
    let (_f, store, old) = registered_box("rot-stale-stage");
    let staged = store.stage_next().unwrap(); // crash after persist, before promote
    let registry = FakeRegistry::default();
    let result = rotate(&store, &registry, &old, &mut |_| Ok(())).await;
    assert!(matches!(
        result,
        Err(RotationError::Store(KeyStoreError::Refused(_)))
    ));
    assert!(registry.calls.lock().unwrap().is_empty(), "no server call");
    assert_eq!(store.recover(&staged).unwrap(), Recovery::PromotedStaged);
}

#[test]
fn shredding_never_follows_a_symlink_and_always_removes_the_name() {
    let f = Fixture::new("shred-link");
    let victim = f.root.join("victim");
    std::fs::write(&victim, b"precious").unwrap();
    let link = f.root.join("seal-link");
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    destroy_seal_key(&link).unwrap();
    assert!(std::fs::symlink_metadata(&link).is_err(), "name removed");
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    // A read-only file whose overwrite fails is still unlinked.
    std::fs::set_permissions(&f.seal, std::fs::Permissions::from_mode(0o400)).unwrap();
    destroy_seal_key(&f.seal).unwrap();
    assert!(!f.seal.exists());
}

#[test]
fn a_plaintext_file_is_refused_when_a_seal_key_is_configured() {
    let f = Fixture::new("downgrade");
    let key = HostKey::generate().unwrap();
    f.store(BackupState::ProvenOff, false)
        .store(&key, false)
        .unwrap();
    assert!(matches!(
        f.store(BackupState::ProvenOff, true).load(),
        Err(KeyStoreError::Refused(_))
    ));
}

#[test]
fn from_env_rejects_dot_dot_and_wants_the_seal_key_on_tmpfs() {
    let env = |pairs: Vec<(&'static str, &'static str)>| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    };
    let dotted = env(vec![
        (ENV_KEY_DIR, "/var/lib/oort/box/../../../tmp/k"),
        (ENV_BOX_ID, "b"),
    ]);
    assert!(BoxKeyStore::from_env(&dotted, Some(MOUNTINFO)).is_err());

    let on_tmpfs = env(vec![
        (ENV_KEY_DIR, "/var/lib/oort/box/keys"),
        (ENV_BOX_ID, "b"),
        (ENV_SEAL_KEY_FILE, "/run/oort/seal.key"),
    ]);
    let on_volume = env(vec![
        (ENV_KEY_DIR, "/var/lib/oort/box/keys"),
        (ENV_BOX_ID, "b"),
        (ENV_SEAL_KEY_FILE, "/srv/with space/seal.key"),
    ]);
    let tmpfs_store = BoxKeyStore::from_env(&on_tmpfs, Some(MOUNTINFO)).unwrap();
    let volume_store = BoxKeyStore::from_env(&on_volume, Some(MOUNTINFO)).unwrap();
    assert!(tmpfs_store.config.seal_key_on_other_device);
    assert!(
        !volume_store.config.seal_key_on_other_device,
        "another persistent volume is not a separate failure domain"
    );
}

#[test]
fn the_dev_key_file_is_also_refused_when_the_box_key_dir_is_set() {
    let get = |name: &str| (name == ENV_KEY_DIR).then(|| "/v/keys".to_string());
    assert!(crate::cli::dev_key_file_allowed(&get).is_err());
}

/// H1 (#3503 review): the box marker is a root-owned regular file; a link, a
/// group/world-writable file, a file of another owner or a missing file is not.
#[test]
fn the_box_marker_file_must_be_a_trusted_regular_file() {
    use std::os::unix::fs::{symlink, PermissionsExt as _};
    let dir = std::env::temp_dir().join(format!("momo-marker-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: geteuid cannot fail.
    let me = unsafe { libc::geteuid() };
    let marker = dir.join("oort-box");
    assert!(!marker_file_present(&marker, me), "missing");
    std::fs::write(&marker, b"oort-box\n").unwrap();
    std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        marker_file_present(&marker, me),
        "the trusted owner's 0644 file"
    );
    assert!(
        !marker_file_present(&marker, me.wrapping_add(1)),
        "another owner"
    );
    std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o664)).unwrap();
    assert!(!marker_file_present(&marker, me), "group-writable");
    std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o646)).unwrap();
    assert!(!marker_file_present(&marker, me), "world-writable");
    std::fs::set_permissions(&marker, std::fs::Permissions::from_mode(0o644)).unwrap();
    let link = dir.join("link");
    symlink(&marker, &link).unwrap();
    assert!(!marker_file_present(&link, me), "a symlink is not a marker");
    assert!(
        !marker_file_present(&dir, me),
        "a directory is not a marker"
    );
    let _ = std::fs::remove_dir_all(dir);
}
