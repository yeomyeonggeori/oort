//! Host key custody (ADR-0188 D2).
//!
//! The host signs every request with an Ed25519 key whose **public** half is
//! the only thing the server ever sees. Where the private half lives decides who
//! else can act as this host, so there are exactly two places and the choice is
//! never implicit:
//!
//! * [`KeyStore::Keychain`] (macOS, the default) — a data-protection keychain
//!   item, `AfterFirstUnlockThisDeviceOnly`, never synchronised. `ThisDeviceOnly`
//!   keeps it out of iCloud Keychain and out of backups restored onto another
//!   Mac. `AfterFirstUnlock` rather than `WhenUnlocked` because the point of the
//!   host is to keep serving the owner's phone while the Mac sits locked at home.
//!   The data-protection keychain refuses a binary without the
//!   `keychain-access-groups` entitlement, which is what makes "only the signed
//!   app and its sidecar can read it" a property of the OS rather than of this
//!   file. An unsigned dev build therefore fails here — loudly, with no fallback.
//! * [`KeyStore::File`] — development and tests only, reachable solely through
//!   the explicit `--dev-key-file` flag. Written `0600` in a `0700` directory,
//!   and refused on read when the mode or owner is anything else.
//!
//! The seed never reaches a log line: [`HostKey`]'s `Debug` prints the public key
//! only, and the seed is overwritten when the value drops.

use std::fmt;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::SigningKey;

/// Ed25519 seed length (CryptoKit `rawRepresentation`, `momo_wire::sign`).
pub const SEED_LEN: usize = 32;

/// macOS keychain service for the host key. Prefixed by the desktop bundle id
/// (`app.momo.desktop`) because the sidecar ships inside that bundle.
pub const KEYCHAIN_SERVICE: &str = "app.momo.desktop.workd";

#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("the OS random source failed: {0}")]
    Random(String),
    #[error("a host key already exists in {0}; pass --force to replace it")]
    AlreadyExists(String),
    #[error("key file {path} is not safe to use: {detail}")]
    UnsafeFile { path: String, detail: String },
    #[error("key material in {0} is malformed")]
    Malformed(String),
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("this platform has no keychain backend; use --dev-key-file for development only")]
    Unsupported,
}

/// The host's Ed25519 signing key.
pub struct HostKey {
    seed: [u8; SEED_LEN],
}

impl HostKey {
    /// A fresh key from the OS CSPRNG.
    pub fn generate() -> Result<Self, KeyStoreError> {
        let mut seed = [0u8; SEED_LEN];
        getrandom::getrandom(&mut seed)
            .map_err(|error| KeyStoreError::Random(error.to_string()))?;
        Ok(Self { seed })
    }

    fn from_seed_slice(bytes: &[u8], origin: &str) -> Result<Self, KeyStoreError> {
        let seed: [u8; SEED_LEN] = bytes
            .try_into()
            .map_err(|_| KeyStoreError::Malformed(origin.to_string()))?;
        Ok(Self { seed })
    }

    /// Canonical base64 of the raw 32-byte public key — the registration value.
    pub fn public_key_b64(&self) -> String {
        BASE64.encode(
            SigningKey::from_bytes(&self.seed)
                .verifying_key()
                .to_bytes(),
        )
    }

    /// Base64 Ed25519 signature over `payload`, through the shared `momo-wire`
    /// signer so the bytes are the ones the server verifies.
    pub fn sign_b64(&self, payload: &[u8]) -> String {
        momo_wire::sign_base64(&self.seed, payload)
            .expect("a HostKey always holds exactly 32 seed bytes")
    }
}

impl fmt::Debug for HostKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostKey")
            .field("public_key", &self.public_key_b64())
            .field("seed", &"[redacted]")
            .finish()
    }
}

impl Drop for HostKey {
    fn drop(&mut self) {
        for byte in self.seed.iter_mut() {
            // Volatile so the store is not optimised away as a dead write.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

/// Where the host key lives. Chosen once at startup and printed by
/// [`KeyStore::describe`] — never the key itself.
pub enum KeyStore {
    File(FileKeyStore),
    #[cfg(target_os = "macos")]
    Keychain(KeychainKeyStore),
}

impl KeyStore {
    /// The platform default: the data-protection keychain on macOS, nothing
    /// anywhere else (the host is a macOS sidecar in ADR-0188).
    pub fn platform_default(
        workspace_id: uuid::Uuid,
        access_group: Option<String>,
    ) -> Result<Self, KeyStoreError> {
        #[cfg(target_os = "macos")]
        {
            Ok(Self::Keychain(KeychainKeyStore {
                service: KEYCHAIN_SERVICE.to_string(),
                account: format!("host-key.{workspace_id}"),
                access_group,
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace_id, access_group);
            Err(KeyStoreError::Unsupported)
        }
    }

    /// The explicit development store (`--dev-key-file`).
    pub fn dev_file(path: PathBuf) -> Self {
        Self::File(FileKeyStore { path })
    }

    pub fn describe(&self) -> String {
        match self {
            Self::File(store) => format!("dev key file {}", store.path.display()),
            #[cfg(target_os = "macos")]
            Self::Keychain(store) => format!(
                "keychain {}/{} (data-protection, ThisDeviceOnly)",
                store.service, store.account
            ),
        }
    }

    pub fn is_dev_file(&self) -> bool {
        matches!(self, Self::File(_))
    }

    pub fn load(&self) -> Result<Option<HostKey>, KeyStoreError> {
        match self {
            Self::File(store) => store.load(),
            #[cfg(target_os = "macos")]
            Self::Keychain(store) => store.load(),
        }
    }

    /// Persist `key`. An existing key is only ever replaced on request: silently
    /// overwriting it would orphan the host row that key is registered under.
    pub fn store(&self, key: &HostKey, replace: bool) -> Result<(), KeyStoreError> {
        match self {
            Self::File(store) => store.store(key, replace),
            #[cfg(target_os = "macos")]
            Self::Keychain(store) => store.store(key, replace),
        }
    }

    pub fn delete(&self) -> Result<(), KeyStoreError> {
        match self {
            Self::File(store) => store.delete(),
            #[cfg(target_os = "macos")]
            Self::Keychain(store) => store.delete(),
        }
    }
}

// ---------------------------------------------------------------------------
// file (development only)
// ---------------------------------------------------------------------------

pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    fn io(&self, source: std::io::Error) -> KeyStoreError {
        KeyStoreError::Io {
            path: self.path.display().to_string(),
            source,
        }
    }

    fn load(&self) -> Result<Option<HostKey>, KeyStoreError> {
        // `symlink_metadata`: a symlink is refused rather than followed, so the
        // key cannot be redirected to a file someone else controls.
        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(self.io(error)),
        };
        check_private_file(&self.path, &metadata)?;
        let raw = std::fs::read_to_string(&self.path).map_err(|error| self.io(error))?;
        let bytes = BASE64
            .decode(raw.trim())
            .map_err(|_| KeyStoreError::Malformed(self.path.display().to_string()))?;
        HostKey::from_seed_slice(&bytes, &self.path.display().to_string()).map(Some)
    }

    fn store(&self, key: &HostKey, replace: bool) -> Result<(), KeyStoreError> {
        if !replace && std::fs::symlink_metadata(&self.path).is_ok() {
            return Err(KeyStoreError::AlreadyExists(
                self.path.display().to_string(),
            ));
        }
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if !parent.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(|error| self.io(error))?;
        }
        // Write a sibling with O_EXCL + 0600 and rename it into place, so the
        // key is never readable at a wider mode, not even for an instant.
        let temporary = parent.join(format!(
            ".{}.tmp-{}",
            self.path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "host-key".to_string()),
            std::process::id()
        ));
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|error| self.io(error))?;
        let encoded = format!("{}\n", BASE64.encode(key.seed));
        let written = file
            .write_all(encoded.as_bytes())
            .and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(self.io(error));
        }
        std::fs::rename(&temporary, &self.path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            self.io(error)
        })?;
        let metadata = std::fs::symlink_metadata(&self.path).map_err(|error| self.io(error))?;
        check_private_file(&self.path, &metadata)
    }

    fn delete(&self) -> Result<(), KeyStoreError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(self.io(error)),
        }
    }
}

/// A key file must be a regular file, owned by this user, with no group or
/// other permission bits (`0600` or stricter).
fn check_private_file(path: &Path, metadata: &std::fs::Metadata) -> Result<(), KeyStoreError> {
    let unsafe_file = |detail: String| KeyStoreError::UnsafeFile {
        path: path.display().to_string(),
        detail,
    };
    if !metadata.file_type().is_file() {
        return Err(unsafe_file("not a regular file".to_string()));
    }
    let mode = metadata.mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(unsafe_file(format!("mode {mode:04o}, expected 0600")));
    }
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    if metadata.uid() != uid {
        return Err(unsafe_file(format!(
            "owned by uid {}, not {uid}",
            metadata.uid()
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS data-protection keychain
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub struct KeychainKeyStore {
    service: String,
    account: String,
    /// `<TEAMID>.app.momo.desktop` in a signed bundle, shared by the app and the
    /// sidecar. `None` uses the binary's default access group.
    access_group: Option<String>,
}

#[cfg(target_os = "macos")]
mod keychain_impl {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };

    use super::{HostKey, KeyStoreError, KeychainKeyStore};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;

    fn keychain_error(error: security_framework::base::Error) -> KeyStoreError {
        if error.code() == ERR_SEC_MISSING_ENTITLEMENT {
            return KeyStoreError::Keychain(
                "the data-protection keychain needs a signed build with the \
                 keychain-access-groups entitlement (errSecMissingEntitlement); \
                 an unsigned development build must use --dev-key-file"
                    .to_string(),
            );
        }
        KeyStoreError::Keychain(format!("OSStatus {}", error.code()))
    }

    impl KeychainKeyStore {
        /// The lookup attributes shared by read, write and delete.
        fn query(&self) -> PasswordOptions {
            let mut options = PasswordOptions::new_generic_password(&self.service, &self.account);
            options.use_protected_keychain();
            options.set_access_synchronized(Some(false));
            if let Some(group) = &self.access_group {
                options.set_access_group(group);
            }
            options
        }

        pub(super) fn load(&self) -> Result<Option<HostKey>, KeyStoreError> {
            match generic_password(self.query()) {
                Ok(bytes) => {
                    HostKey::from_seed_slice(&bytes, &format!("keychain {}", self.account))
                        .map(Some)
                }
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(keychain_error(error)),
            }
        }

        pub(super) fn store(&self, key: &HostKey, replace: bool) -> Result<(), KeyStoreError> {
            if self.load()?.is_some() {
                if !replace {
                    return Err(KeyStoreError::AlreadyExists(format!(
                        "keychain {}/{}",
                        self.service, self.account
                    )));
                }
                self.delete()?;
            }
            let mut options = self.query();
            let access = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(keychain_error)?;
            options.set_access_control(access);
            options.set_label("oort work host key");
            set_generic_password_options(&key.seed, options).map_err(keychain_error)
        }

        pub(super) fn delete(&self) -> Result<(), KeyStoreError> {
            match delete_generic_password_options(self.query()) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(error) => Err(keychain_error(error)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "momo-workd-keystore-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        dir.join("keys").join("host.key")
    }

    #[test]
    fn debug_never_prints_the_seed() {
        let key = HostKey::from_seed_slice(&[7u8; 32], "test").unwrap();
        let printed = format!("{key:?}");
        assert!(printed.contains("[redacted]"));
        assert!(printed.contains(&key.public_key_b64()));
        assert!(!printed.contains(&BASE64.encode([7u8; 32])));
        assert!(!printed.contains("7, 7, 7"));
    }

    #[test]
    fn a_generated_key_signs_what_momo_wire_verifies() {
        let key = HostKey::generate().unwrap();
        let payload = momo_wire::request_payload(
            "GET",
            "/v1/workspaces/x/work-hosts/y/pending-controls",
            uuid::Uuid::from_u128(1),
            uuid::Uuid::from_u128(2),
            1_700_000_000_000,
            &momo_wire::sha256_hex(b""),
            uuid::Uuid::from_u128(3),
        );
        assert!(momo_wire::verify_base64(
            &key.public_key_b64(),
            &key.sign_b64(&payload),
            &payload
        ));
    }

    #[test]
    fn the_dev_file_is_0600_in_a_0700_dir_and_round_trips() {
        let path = scratch("roundtrip");
        let store = KeyStore::dev_file(path.clone());
        assert!(
            store.load().unwrap().is_none(),
            "absent is None, not an error"
        );

        let key = HostKey::generate().unwrap();
        store.store(&key, false).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        let dir = std::fs::metadata(path.parent().unwrap()).unwrap();
        assert_eq!(dir.mode() & 0o777, 0o700);

        let loaded = store.load().unwrap().expect("stored key");
        assert_eq!(loaded.public_key_b64(), key.public_key_b64());

        let again = HostKey::generate().unwrap();
        assert!(matches!(
            store.store(&again, false),
            Err(KeyStoreError::AlreadyExists(_))
        ));
        store.store(&again, true).unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().public_key_b64(),
            again.public_key_b64()
        );
        store.delete().unwrap();
        assert!(store.load().unwrap().is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_group_or_world_readable_key_file_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let path = scratch("loose");
        let store = KeyStore::dev_file(path.clone());
        store.store(&HostKey::generate().unwrap(), false).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        match store.load() {
            Err(KeyStoreError::UnsafeFile { detail, .. }) => assert!(detail.contains("0644")),
            other => panic!("a 0644 key file must be refused, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_symlinked_key_file_is_refused() {
        let path = scratch("link");
        let real = path.with_file_name("real.key");
        let store = KeyStore::dev_file(real.clone());
        store.store(&HostKey::generate().unwrap(), false).unwrap();
        std::os::unix::fs::symlink(&real, &path).unwrap();
        let linked = KeyStore::dev_file(path.clone());
        assert!(matches!(
            linked.load(),
            Err(KeyStoreError::UnsafeFile { .. })
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}
