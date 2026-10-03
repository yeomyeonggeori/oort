//! Linux box host-key custody (ADR-0197 D8/D10, spike S4 / #3411).
//!
//! A personal-cloud box (ADR-0197) is a hardened Linux container with one
//! volume. There is no keychain, so the host key (ADR-0188 D2) lives on that
//! volume, under four rules the macOS path gets from the OS:
//!
//! 1. **Born in the box.** [`HostKey::generate`] runs inside the container; the
//!    runner, the server and the image never see the seed.
//! 2. **Strict file.** `<dir>/host.key` is a regular file, `0600`, owned by the
//!    box-agent uid, inside a `0700` directory on a `nosuid,nodev` mount, opened
//!    `O_NOFOLLOW` and judged on the descriptor (same checks as the dev file).
//! 3. **Sealed, shreddable.** When the runner hands the box a per-box seal key
//!    (a file on tmpfs, never on the volume), the seed is stored only as an
//!    AES-256-GCM envelope bound to the box id. The runner deletes the seal key
//!    on box delete: every copy of the volume (snapshot, provider backup,
//!    un-trimmed block) is then ciphertext with no key anywhere — crypto-shred.
//!    The runner never reads `host.key`; it only creates and destroys the seal
//!    key.
//! 4. **Persistence gate.** The runner attests, in a root-owned read-only file,
//!    whether the volume has backups (`backups=none|present`). Anything else —
//!    missing, unreadable, writable by the box, any other text — is `Unknown`
//!    and treated as backed up. A *plaintext* seed is refused unless backups
//!    are proven off. A *sealed* seed on a backed-up volume is allowed (ADR-0197
//!    D8: the host key is not a harness credential) only when the seal key
//!    lives on another device, so no single snapshot holds both halves.
//!
//! Rotation ([`rotate`]) is a stage / register / persist / promote / revoke
//! sequence whose every crash point is resolved by [`BoxKeyStore::recover`]
//! against the one fact the server also holds: the registered public key.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead as _, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use super::{check_private_dir, check_private_file, HostKey, KeyStoreError, SEED_LEN};

pub const HOST_KEY_FILE: &str = "host.key";
pub const STAGED_KEY_FILE: &str = "host.key.next";
const SEALED_MAGIC: &str = "oort-hostkey-sealed-v1";
const AAD_PREFIX: &[u8] = b"oort-box-host-key-v1\0";
const NONCE_LEN: usize = 12;

pub const ENV_BOX_ID: &str = "OORT_BOX_ID";
pub const ENV_KEY_DIR: &str = "OORT_BOX_KEY_DIR";
pub const ENV_SEAL_KEY_FILE: &str = "OORT_BOX_SEAL_KEY_FILE";
pub const ENV_BACKUP_ATTESTATION: &str = "OORT_BOX_BACKUP_ATTESTATION";
/// Set by the box image. While it is set `--dev-key-file` is refused.
pub const ENV_BOX_MARKER: &str = "OORT_BOX";

/// What the runner attests about backups of the box volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    /// Attested `backups=none` by a trusted writer.
    ProvenOff,
    /// Attested `backups=present`.
    Present,
    /// No trustworthy attestation. Treated like `Present`.
    Unknown,
}

impl BackupState {
    pub fn parse(text: &str) -> Self {
        match text.trim() {
            "backups=none" => Self::ProvenOff,
            "backups=present" => Self::Present,
            _ => Self::Unknown,
        }
    }

    /// Read the runner's attestation. It only counts when it is a regular file
    /// owned by `trusted_uid` (root in a box) that neither group nor others can
    /// write: a file the box user could edit proves nothing. Every failure is
    /// `Unknown`, never `ProvenOff`.
    pub fn read(path: &Path, trusted_uid: u32) -> Self {
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
        else {
            return Self::Unknown;
        };
        let Ok(metadata) = file.metadata() else {
            return Self::Unknown;
        };
        if !metadata.file_type().is_file()
            || metadata.uid() != trusted_uid
            || metadata.mode() & 0o022 != 0
        {
            return Self::Unknown;
        }
        let mut text = String::new();
        if file.take(256).read_to_string(&mut text).is_err() {
            return Self::Unknown;
        }
        Self::parse(&text)
    }
}

/// Where the harness login directory may live (ADR-0197 D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialPlacement {
    /// Backups proven off: the login may persist on the volume.
    Volume,
    /// Otherwise: tmpfs only, gone when the box stops.
    Tmpfs,
}

pub fn credential_placement(backup: BackupState) -> CredentialPlacement {
    if backup == BackupState::ProvenOff {
        CredentialPlacement::Volume
    } else {
        CredentialPlacement::Tmpfs
    }
}

/// One line of `/proc/self/mountinfo`, reduced to what the gate needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountEntry {
    pub mount_point: PathBuf,
    pub options: Vec<String>,
    pub fs_type: String,
}

fn unescape_mount_field(field: &str) -> String {
    // mountinfo escapes space, tab, newline and backslash as \040 \011 \012 \134.
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..i + 4].iter().all(u8::is_ascii_digit)
        {
            let value = u32::from(bytes[i + 1] - b'0') * 64
                + u32::from(bytes[i + 2] - b'0') * 8
                + u32::from(bytes[i + 3] - b'0');
            out.push(value as u8);
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The mount `path` lives on: the entry with the longest mount point that is a
/// prefix of `path`. Later entries win ties (a mount stacked on another).
pub fn mount_for(mountinfo: &str, path: &Path) -> Option<MountEntry> {
    let mut best: Option<MountEntry> = None;
    for line in mountinfo.lines() {
        let Some((head, tail)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<&str> = head.split(' ').collect();
        let (Some(point), Some(options)) = (fields.get(4), fields.get(5)) else {
            continue;
        };
        let Some(fs_type) = tail.split(' ').next() else {
            continue;
        };
        let mount_point = PathBuf::from(unescape_mount_field(point));
        if !path.starts_with(&mount_point) {
            continue;
        }
        let longer = best
            .as_ref()
            .is_none_or(|b| mount_point.as_os_str().len() >= b.mount_point.as_os_str().len());
        if longer {
            best = Some(MountEntry {
                mount_point,
                options: options.split(',').map(str::to_string).collect(),
                fs_type: fs_type.to_string(),
            });
        }
    }
    best
}

/// ADR-0197 D1: the key mount is `nosuid,nodev`. Fail closed when the mount
/// cannot be found at all.
pub fn require_nosuid_nodev(mountinfo: &str, dir: &Path) -> Result<(), KeyStoreError> {
    let entry = mount_for(mountinfo, dir)
        .ok_or_else(|| KeyStoreError::Refused(format!("no mount found for {}", dir.display())))?;
    for needed in ["nosuid", "nodev"] {
        if !entry.options.iter().any(|o| o == needed) {
            return Err(KeyStoreError::Refused(format!(
                "{} is on a mount without {needed}",
                dir.display()
            )));
        }
    }
    Ok(())
}

/// True when `dir` is on tmpfs — the only place a non-persistent login may sit.
pub fn is_tmpfs(mountinfo: &str, dir: &Path) -> bool {
    mount_for(mountinfo, dir).is_some_and(|m| m.fs_type == "tmpfs")
}

/// Everything the box store needs; built from the environment by
/// [`BoxKeyStore::from_env`] and directly by tests.
#[derive(Debug, Clone)]
pub struct BoxKeyConfig {
    pub dir: PathBuf,
    /// Bound into every envelope as AAD: a sealed file copied to another box
    /// does not open.
    pub box_id: String,
    /// The per-box seal key file on tmpfs. `None` stores the seed in plaintext,
    /// which the gate allows only when backups are proven off.
    pub seal_key_file: Option<PathBuf>,
    pub backup: BackupState,
    /// The seal key and the key directory sit on different devices, so one
    /// snapshot of the volume cannot hold both.
    pub seal_key_on_other_device: bool,
}

pub struct BoxKeyStore {
    config: BoxKeyConfig,
}

impl BoxKeyStore {
    pub fn new(config: BoxKeyConfig) -> Self {
        Self { config }
    }

    /// Build from the box image's environment. `mountinfo` is the text of
    /// `/proc/self/mountinfo` (`None` skips the mount check — non-Linux tests).
    /// `get` is `std::env::var` in production.
    pub fn from_env(
        get: &dyn Fn(&str) -> Option<String>,
        mountinfo: Option<&str>,
    ) -> Result<Self, KeyStoreError> {
        let need = |name: &str| {
            get(name)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| KeyStoreError::Refused(format!("{name} is not set")))
        };
        let dir = PathBuf::from(need(ENV_KEY_DIR)?);
        if !dir.is_absolute() {
            return Err(KeyStoreError::Refused(format!(
                "{ENV_KEY_DIR} must be an absolute path"
            )));
        }
        let box_id = need(ENV_BOX_ID)?;
        let seal_key_file = get(ENV_SEAL_KEY_FILE)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        if let Some(path) = &seal_key_file {
            if !path.is_absolute() {
                return Err(KeyStoreError::Refused(format!(
                    "{ENV_SEAL_KEY_FILE} must be an absolute path"
                )));
            }
        }
        let backup = get(ENV_BACKUP_ATTESTATION)
            .filter(|v| !v.is_empty())
            // The runner is root and the box agent is not (ADR-0197 D1).
            .map_or(BackupState::Unknown, |path| {
                BackupState::read(Path::new(&path), 0)
            });
        if let Some(mountinfo) = mountinfo {
            require_nosuid_nodev(mountinfo, &dir)?;
        }
        let seal_key_on_other_device = seal_key_file
            .as_deref()
            .and_then(Path::parent)
            .and_then(|seal_dir| Some((device_of(seal_dir)?, device_of(&dir)?)))
            .is_some_and(|(a, b)| a != b);
        Ok(Self::new(BoxKeyConfig {
            dir,
            box_id,
            seal_key_file,
            backup,
            seal_key_on_other_device,
        }))
    }

    pub fn describe(&self) -> String {
        format!(
            "box volume {} ({}, backups {:?})",
            self.config.dir.join(HOST_KEY_FILE).display(),
            if self.config.seal_key_file.is_some() {
                "sealed"
            } else {
                "plaintext"
            },
            self.config.backup
        )
    }

    pub fn credential_placement(&self) -> CredentialPlacement {
        credential_placement(self.config.backup)
    }

    fn current_path(&self) -> PathBuf {
        self.config.dir.join(HOST_KEY_FILE)
    }

    fn staged_path(&self) -> PathBuf {
        self.config.dir.join(STAGED_KEY_FILE)
    }

    fn io(path: &Path, source: std::io::Error) -> KeyStoreError {
        KeyStoreError::Io {
            path: path.display().to_string(),
            source,
        }
    }

    /// The persistence gate for a file that is (`sealed`) or is not sealed.
    fn admit(&self, sealed: bool) -> Result<(), KeyStoreError> {
        let backup = self.config.backup;
        if !sealed {
            if backup != BackupState::ProvenOff {
                return Err(KeyStoreError::Refused(format!(
                    "a plaintext host key needs backups proven off (attestation: {backup:?}); \
                     provide {ENV_SEAL_KEY_FILE}"
                )));
            }
        } else if backup != BackupState::ProvenOff && !self.config.seal_key_on_other_device {
            return Err(KeyStoreError::Refused(
                "the volume may be backed up and the seal key is not on another device".into(),
            ));
        }
        Ok(())
    }

    /// The seal key, read fresh each time so a runner that shreds it takes
    /// effect immediately. A missing or loose file is `SealKeyGone`.
    fn seal_key(&self) -> Result<[u8; 32], KeyStoreError> {
        let path = self
            .config
            .seal_key_file
            .as_deref()
            .ok_or_else(|| KeyStoreError::SealKeyGone("no seal key configured".into()))?;
        let gone =
            |detail: &str| KeyStoreError::SealKeyGone(format!("{}: {detail}", path.display()));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|e| gone(&e.kind().to_string()))?;
        let metadata = file.metadata().map_err(|e| gone(&e.kind().to_string()))?;
        check_private_file(path, &metadata)?;
        let mut raw = String::new();
        file.take(256)
            .read_to_string(&mut raw)
            .map_err(|e| gone(&e.kind().to_string()))?;
        let bytes = BASE64.decode(raw.trim()).map_err(|_| gone("malformed"))?;
        bytes.try_into().map_err(|_| gone("wrong length"))
    }

    fn aad(&self) -> Vec<u8> {
        [AAD_PREFIX, self.config.box_id.as_bytes()].concat()
    }

    fn encode(&self, key: &HostKey) -> Result<String, KeyStoreError> {
        if self.config.seal_key_file.is_none() {
            return Ok(format!("{}\n", BASE64.encode(key.seed)));
        }
        let kek = self.seal_key()?;
        let cipher = Aes256Gcm::new_from_slice(&kek)
            .map_err(|_| KeyStoreError::SealKeyGone("bad seal key".into()))?;
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce).map_err(|e| KeyStoreError::Random(e.to_string()))?;
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &key.seed,
                    aad: &self.aad(),
                },
            )
            .map_err(|_| KeyStoreError::Unseal("encrypt".into()))?;
        Ok(format!(
            "{SEALED_MAGIC}\n{}\n{}\n",
            BASE64.encode(nonce),
            BASE64.encode(sealed)
        ))
    }

    fn decode(&self, text: &str, origin: &Path) -> Result<HostKey, KeyStoreError> {
        let origin_name = origin.display().to_string();
        let mut lines = text.lines();
        if lines.next() != Some(SEALED_MAGIC) {
            // Plaintext form.
            self.admit(false)?;
            let bytes = BASE64
                .decode(text.trim())
                .map_err(|_| KeyStoreError::Malformed(origin_name.clone()))?;
            return HostKey::from_seed_slice(&bytes, &origin_name);
        }
        self.admit(true)?;
        let (Some(nonce), Some(sealed)) = (lines.next(), lines.next()) else {
            return Err(KeyStoreError::Malformed(origin_name));
        };
        let nonce = BASE64
            .decode(nonce)
            .ok()
            .filter(|n| n.len() == NONCE_LEN)
            .ok_or_else(|| KeyStoreError::Malformed(origin_name.clone()))?;
        let sealed = BASE64
            .decode(sealed)
            .map_err(|_| KeyStoreError::Malformed(origin_name.clone()))?;
        let kek = self.seal_key()?;
        let cipher = Aes256Gcm::new_from_slice(&kek)
            .map_err(|_| KeyStoreError::SealKeyGone("bad seal key".into()))?;
        let seed = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &sealed,
                    aad: &self.aad(),
                },
            )
            .map_err(|_| KeyStoreError::Unseal(origin_name.clone()))?;
        if seed.len() != SEED_LEN {
            return Err(KeyStoreError::Malformed(origin_name));
        }
        HostKey::from_seed_slice(&seed, &origin_name)
    }

    fn read_file(&self, path: &Path) -> Result<Option<HostKey>, KeyStoreError> {
        let mut file = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
                return Err(KeyStoreError::UnsafeFile {
                    path: path.display().to_string(),
                    detail: "a symbolic link".to_string(),
                })
            }
            Err(e) => return Err(Self::io(path, e)),
        };
        // Folder first: a loose folder lets another account swap the file.
        if let Some(parent) = path.parent() {
            let folder = std::fs::metadata(parent).map_err(|e| Self::io(parent, e))?;
            check_private_dir(parent, &folder)?;
        }
        let metadata = file.metadata().map_err(|e| Self::io(path, e))?;
        check_private_file(path, &metadata)?;
        let mut text = String::new();
        (&mut file)
            .take(4096)
            .read_to_string(&mut text)
            .map_err(|e| Self::io(path, e))?;
        self.decode(&text, path).map(Some)
    }

    pub fn load(&self) -> Result<Option<HostKey>, KeyStoreError> {
        self.read_file(&self.current_path())
    }

    pub fn store(&self, key: &HostKey, replace: bool) -> Result<(), KeyStoreError> {
        let path = self.current_path();
        if !replace && std::fs::symlink_metadata(&path).is_ok() {
            return Err(KeyStoreError::AlreadyExists(path.display().to_string()));
        }
        self.write_atomic(&path, key)
    }

    fn write_atomic(&self, path: &Path, key: &HostKey) -> Result<(), KeyStoreError> {
        // Gate and seal key are checked BEFORE a byte is written.
        self.admit(self.config.seal_key_file.is_some())?;
        let encoded = self.encode(key)?;
        let parent = &self.config.dir;
        if !parent.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(|e| Self::io(parent, e))?;
        }
        let folder = std::fs::metadata(parent).map_err(|e| Self::io(parent, e))?;
        check_private_dir(parent, &folder)?;
        let temporary = parent.join(format!(
            ".{}.tmp-{}",
            path.file_name().map_or_else(
                || "host-key".to_string(),
                |n| n.to_string_lossy().into_owned()
            ),
            std::process::id()
        ));
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|e| Self::io(&temporary, e))?;
        let written = file
            .write_all(encoded.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if let Err(e) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(Self::io(&temporary, e));
        }
        std::fs::rename(&temporary, path).map_err(|e| {
            let _ = std::fs::remove_file(&temporary);
            Self::io(path, e)
        })?;
        // Persist the rename itself.
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|e| Self::io(path, e))?;
        check_private_file(path, &metadata)
    }

    /// Remove the key files. This is the *local* forget; the delete that
    /// matters is the runner destroying the seal key ([`destroy_seal_key`]).
    pub fn delete(&self) -> Result<(), KeyStoreError> {
        for path in [self.current_path(), self.staged_path()] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Self::io(&path, e)),
            }
        }
        Ok(())
    }

    // ---- rotation ---------------------------------------------------------

    /// Generate the next key and keep it beside the current one. Returns its
    /// public half for registration. A stale staged key is replaced.
    pub fn stage_next(&self) -> Result<String, KeyStoreError> {
        let key = HostKey::generate()?;
        self.write_atomic(&self.staged_path(), &key)?;
        Ok(key.public_key_b64())
    }

    /// Make the staged key the host key (atomic rename).
    pub fn promote_staged(&self) -> Result<(), KeyStoreError> {
        let (staged, current) = (self.staged_path(), self.current_path());
        // Refuse to promote what cannot be read back with the same gate.
        self.read_file(&staged)?
            .ok_or_else(|| KeyStoreError::Refused("no staged key to promote".into()))?;
        std::fs::rename(&staged, &current).map_err(|e| Self::io(&current, e))?;
        if let Ok(dir) = std::fs::File::open(&self.config.dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    pub fn discard_staged(&self) -> Result<(), KeyStoreError> {
        match std::fs::remove_file(self.staged_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Self::io(&self.staged_path(), e)),
        }
    }

    /// Resolve an interrupted rotation from the registered public key (the
    /// value in the host state file, which the server also holds). Call it at
    /// every start, before `load`.
    pub fn recover(&self, registered_public_key: &str) -> Result<Recovery, KeyStoreError> {
        let current = self.load()?.map(|k| k.public_key_b64());
        let staged = self
            .read_file(&self.staged_path())?
            .map(|k| k.public_key_b64());
        match (current, staged) {
            (_, None) => Ok(Recovery::Clean),
            (Some(current), Some(_)) if current == registered_public_key => {
                self.discard_staged()?;
                Ok(Recovery::DiscardedStaged)
            }
            (_, Some(staged)) if staged == registered_public_key => {
                self.promote_staged()?;
                Ok(Recovery::PromotedStaged)
            }
            _ => Err(KeyStoreError::Refused(
                "neither the host key nor the staged key is the registered one".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    Clean,
    DiscardedStaged,
    PromotedStaged,
}

/// Runner-side crypto-shred: overwrite and unlink the per-box seal key. The
/// runner needs nothing else, and never opens `host.key`. Idempotent.
pub fn destroy_seal_key(path: &Path) -> std::io::Result<()> {
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(mut file) => {
            let len = file.metadata()?.len() as usize;
            file.write_all(&vec![0u8; len])?;
            file.sync_all()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    std::fs::remove_file(path)
}

/// Runner-side: create a fresh per-box seal key file (`0600`).
pub fn create_seal_key(path: &Path) -> Result<(), KeyStoreError> {
    let mut kek = [0u8; 32];
    getrandom::getrandom(&mut kek).map_err(|e| KeyStoreError::Random(e.to_string()))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| BoxKeyStore::io(path, e))?;
    file.write_all(format!("{}\n", BASE64.encode(kek)).as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| BoxKeyStore::io(path, e))
}

/// The device `path` lives on — or, when it does not exist yet (the key folder
/// on first start), the device of its nearest existing ancestor, which is the
/// volume mount the folder will be created in.
fn device_of(path: &Path) -> Option<u64> {
    path.ancestors()
        .find_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.dev())
}

// ---------------------------------------------------------------------------
// rotation and revoke (ADR-0188 host registration)
// ---------------------------------------------------------------------------

/// The two server calls rotation needs. `register` is `POST work-hosts` with the
/// new public key (owner-signed under R2 — the caller supplies that); `revoke`
/// is the owner's host revoke.
#[async_trait]
pub trait HostRegistry: Send + Sync {
    async fn register(&self, public_key_b64: &str) -> Result<uuid::Uuid, String>;
    async fn revoke(&self, host_id: uuid::Uuid) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    pub host_id: uuid::Uuid,
    pub public_key: String,
}

#[derive(Debug)]
pub enum RotationOutcome {
    /// New key current, new row recorded, old row revoked.
    Rotated(Registered),
    /// Everything consistent, but the old host row could not be revoked yet:
    /// retry `revoke(old_host_id)`. The old private key is already gone, so
    /// the leftover row can no longer sign anything.
    RevokePending {
        new: Registered,
        old_host_id: uuid::Uuid,
        reason: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum RotationError {
    #[error(transparent)]
    Store(#[from] KeyStoreError),
    #[error("register the new host key: {0}")]
    Register(String),
    #[error("record the new registration: {0}")]
    Persist(String),
}

/// Rotate the box host key. Order (each arrow is a crash point `recover`
/// resolves):
///
/// stage `host.key.next` → register its public key (new row) → `persist` the
/// new `(host_id, public_key)` in the state file → promote → revoke the old row.
///
/// A new row is a new host id, and the owner's pinned trust and the R2 latch
/// are bound to the host id (`TrustIdentity`, `remove_trust_files`): `persist`
/// must do what `register` does with them (state write plus trust reset), so
/// the owner re-pins through the owner-signed registration.
///
/// * failure before `persist` succeeds: the staged key is discarded, the new
///   row (if made) is withdrawn, the old key and row are untouched;
/// * crash after `persist` but before promote: the state names the staged key,
///   `recover(state.public_key)` promotes it;
/// * crash after register but before `persist`: `recover` discards the staged
///   key and the server keeps one orphan row the owner can revoke from the host
///   list (the unavoidable window of any register-then-record protocol).
pub async fn rotate(
    store: &BoxKeyStore,
    registry: &dyn HostRegistry,
    old: &Registered,
    persist: &mut dyn FnMut(&Registered) -> Result<(), String>,
) -> Result<RotationOutcome, RotationError> {
    let next_public = store.stage_next()?;
    let new_id = match registry.register(&next_public).await {
        Ok(id) => id,
        Err(reason) => {
            let _ = store.discard_staged();
            return Err(RotationError::Register(reason));
        }
    };
    let new = Registered {
        host_id: new_id,
        public_key: next_public,
    };
    if let Err(reason) = persist(&new) {
        let _ = store.discard_staged();
        let _ = registry.revoke(new_id).await;
        return Err(RotationError::Persist(reason));
    }
    store.promote_staged()?;
    match registry.revoke(old.host_id).await {
        Ok(()) => Ok(RotationOutcome::Rotated(new)),
        Err(reason) => Ok(RotationOutcome::RevokePending {
            new,
            old_host_id: old.host_id,
            reason,
        }),
    }
}

#[cfg(test)]
mod tests;
