//! Where credentials live (ADR-0216 D10 「자격 보관」) and the lock that serialises a refresh.
//!
//! * **macOS**: the login keychain, through Security.framework's safe `passwords` API. A write
//!   that fails is an error, never a quiet fall back to a file.
//! * **elsewhere** (headless Linux, CI): `$XDG_CONFIG_HOME/oort/` — a directory made 0700 and
//!   files made 0600 *as they are created* (never `chmod`ed afterwards), refused on read when
//!   anyone else could read them, when they are not the effective user's, or when they are links.
//!
//! The same module owns the advisory file lock every refresh runs under, so the keychain and the
//! file store are rotated by one rule.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CliError, Kind};
use crate::output::now_ms;
use crate::secret::Secret;

pub const KEYCHAIN_SERVICE: &str = "oort-cli";
const MAX_FILE_BYTES: u64 = 64 * 1024;
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageKind {
    Keychain,
    File,
}

impl StorageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StorageKind::Keychain => "keychain",
            StorageKind::File => "file",
        }
    }
}

/// What the person asked of `oort login --storage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoragePref {
    Auto,
    File,
    Keychain,
}

/// The profile key: (server origin, workspace id) — the same person on two servers, or in two
/// workspaces, never shares a credential (ADR-0216 D10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileKey {
    pub server: String,
    pub workspace_id: String,
}

impl ProfileKey {
    pub fn account(&self) -> String {
        format!("{}|{}", self.server, self.workspace_id)
    }

    fn file_stem(&self) -> String {
        let digest = Sha256::digest(self.account().as_bytes());
        digest
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Form {
    /// A card token from settings (`oort login --with-token`): no refresh half.
    Card,
    /// A browser-approved login session: an access half that lives minutes and a refresh half.
    Session,
}

/// Everything saved for one profile. `Debug` is safe: [`Secret`] is redacted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub v: u32,
    pub server: String,
    pub workspace_id: String,
    pub form: Form,
    pub access: Secret,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_expires_at_ms: Option<i64>,
    /// Learned at login so a refresh never rediscovers (and so never trusts a second look at) the
    /// server's metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    pub saved_at_ms: i64,
}

impl Credential {
    pub const VERSION: u32 = 1;

    pub fn key(&self) -> ProfileKey {
        ProfileKey {
            server: self.server.clone(),
            workspace_id: self.workspace_id.clone(),
        }
    }

    pub fn card(server: &str, workspace_id: &str, token: Secret) -> Credential {
        Credential {
            v: Credential::VERSION,
            server: server.to_string(),
            workspace_id: workspace_id.to_string(),
            form: Form::Card,
            access: token,
            refresh: None,
            access_expires_at_ms: None,
            token_endpoint: None,
            saved_at_ms: now_ms(),
        }
    }

    /// A login session's access half is judged by the expiry the token response promised, with a
    /// minute of slack so a request is never sent with a token about to lapse.
    pub fn access_is_stale(&self, now_ms: i64) -> bool {
        self.form == Form::Session
            && self
                .access_expires_at_ms
                .is_none_or(|expires| expires <= now_ms + 60_000)
    }
}

/// The non-secret pointer to the profile the commands act on, and where its credential lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub server: String,
    pub workspace_id: String,
    pub storage: StorageKind,
}

impl Current {
    pub fn key(&self) -> ProfileKey {
        ProfileKey {
            server: self.server.clone(),
            workspace_id: self.workspace_id.clone(),
        }
    }
}

pub trait Backend {
    fn kind(&self) -> StorageKind;
    fn load(&self, key: &ProfileKey) -> Result<Option<Credential>, CliError>;
    fn save(&self, key: &ProfileKey, credential: &Credential) -> Result<(), CliError>;
    /// `true` when something was there to delete.
    fn delete(&self, key: &ProfileKey) -> Result<bool, CliError>;
}

/// Where a login is saved. The one place the keychain-or-file decision is made.
///
/// **No quiet downgrade**: with a keychain on the platform, a failing keychain write is the
/// caller's error and the file backend is not touched; the file is used only when the person
/// said `--storage file`, or when the platform has no keychain at all (and then it says so).
pub fn persist(
    preference: StoragePref,
    platform_has_keychain: bool,
    keychain: &dyn Backend,
    file: &dyn Backend,
    credential: &Credential,
    notice: &mut dyn FnMut(&str),
) -> Result<StorageKind, CliError> {
    let key = credential.key();
    match (preference, platform_has_keychain) {
        (StoragePref::File, _) => {
            file.save(&key, credential)?;
            Ok(StorageKind::File)
        }
        (StoragePref::Keychain, false) => Err(CliError::failure(
            "keychain_unavailable",
            "이 환경에는 키체인이 없어요. `--storage file`로 파일에 저장할 수 있어요.",
        )),
        (StoragePref::Keychain | StoragePref::Auto, true) => {
            keychain.save(&key, credential)?;
            Ok(StorageKind::Keychain)
        }
        (StoragePref::Auto, false) => {
            notice("키체인이 없는 환경이라 자격을 파일에 저장해요(권한 0600).");
            file.save(&key, credential)?;
            Ok(StorageKind::File)
        }
    }
}

// ---------------------------------------------------------------------------
// private files and directories
// ---------------------------------------------------------------------------

fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

fn io_error(what: &str, path: &Path, error: &std::io::Error) -> CliError {
    CliError::failure(
        "storage_io",
        format!("{what}: {} ({})", path.display(), error.kind()),
    )
}

fn permission_error(path: &Path, mode: u32) -> CliError {
    CliError::failure(
        "credential_permissions",
        format!(
            "{}의 권한이 넓어요(0{:o}). 자격을 읽지 않았어요. 소유자만 읽을 수 있게 고쳐 주세요.",
            path.display(),
            mode & 0o777
        ),
    )
}

fn ownership_error(path: &Path) -> CliError {
    CliError::failure(
        "credential_permissions",
        format!(
            "{}의 소유자가 지금 사용자가 아니에요. 자격을 읽지 않았어요.",
            path.display()
        ),
    )
}

/// A directory that only this user can enter, made that way when it is made.
pub fn ensure_private_dir(path: &Path) -> Result<(), CliError> {
    for _ in 0..2 {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if !metadata.is_dir() {
                    return Err(CliError::failure(
                        "storage_io",
                        format!("{}가 디렉터리가 아니에요.", path.display()),
                    ));
                }
                if metadata.mode() & 0o077 != 0 {
                    return Err(permission_error(path, metadata.mode()));
                }
                if metadata.uid() != effective_uid() {
                    return Err(ownership_error(path));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Only the directory that holds credentials is private; the places above it
                // (`~/.config`) are the user's own and are created the ordinary way if absent.
                if let Some(parent) = path.parent() {
                    if !parent.exists() {
                        fs::create_dir_all(parent).map_err(|error| {
                            io_error("상위 디렉터리를 만들지 못했어요", parent, &error)
                        })?;
                    }
                }
                match DirBuilder::new().mode(0o700).create(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io_error("디렉터리를 만들지 못했어요", path, &error)),
                }
            }
            Err(error) => return Err(io_error("디렉터리를 읽지 못했어요", path, &error)),
        }
    }
    Err(CliError::failure(
        "storage_io",
        format!("{}를 준비하지 못했어요.", path.display()),
    ))
}

fn no_follow() -> i32 {
    rustix::fs::OFlags::NOFOLLOW.bits() as i32
}

/// Read a file only if it is a regular file of this user's that nobody else can read. The checks
/// are on the opened handle, so the file cannot be swapped between the check and the read.
pub fn read_private_file(path: &Path) -> Result<Option<Vec<u8>>, CliError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(no_follow())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(io_error(
                "파일을 열지 못했어요(링크일 수 있어요)",
                path,
                &error,
            ))
        }
    };
    let metadata = file
        .metadata()
        .map_err(|error| io_error("파일을 읽지 못했어요", path, &error))?;
    if !metadata.is_file() {
        return Err(CliError::failure(
            "storage_io",
            format!("{}가 일반 파일이 아니에요.", path.display()),
        ));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(permission_error(path, metadata.mode()));
    }
    if metadata.uid() != effective_uid() {
        return Err(ownership_error(path));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(CliError::failure(
            "storage_io",
            format!("{}가 너무 커요.", path.display()),
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error("파일을 읽지 못했어요", path, &error))?;
    Ok(Some(bytes))
}

/// Write a file that is 0600 from its first byte: a temp file made `create_new` with that mode,
/// then renamed over the target. Nothing ever `chmod`s.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::failure("storage_io", "저장 위치가 잘못됐어요."))?;
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|_| CliError::failure("storage_io", "난수를 얻지 못했어요."))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(".tmp-{suffix}"));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(no_follow())
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(io_error("파일을 쓰지 못했어요", path, &error));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// the file backend
// ---------------------------------------------------------------------------

pub struct FileBackend {
    root: PathBuf,
}

impl FileBackend {
    pub fn new(root: &Path) -> FileBackend {
        FileBackend {
            root: root.to_path_buf(),
        }
    }

    fn directory(&self) -> PathBuf {
        self.root.join("credentials")
    }

    fn path(&self, key: &ProfileKey) -> PathBuf {
        self.directory().join(format!("{}.json", key.file_stem()))
    }
}

impl Backend for FileBackend {
    fn kind(&self) -> StorageKind {
        StorageKind::File
    }

    fn load(&self, key: &ProfileKey) -> Result<Option<Credential>, CliError> {
        let path = self.path(key);
        // The directory is judged first, so a world-readable `credentials/` is refused even when
        // the file in it is 0600 (anyone could swap the file).
        if self.directory().exists() {
            ensure_private_dir(&self.root)?;
            ensure_private_dir(&self.directory())?;
        }
        let Some(bytes) = read_private_file(&path)? else {
            return Ok(None);
        };
        let credential: Credential = serde_json::from_slice(&bytes).map_err(|_| {
            CliError::failure(
                "credential_corrupt",
                format!(
                    "{}를 읽을 수 없어요. `oort login`으로 다시 로그인해 주세요.",
                    path.display()
                ),
            )
        })?;
        if credential.v != Credential::VERSION
            || credential.server != key.server
            || credential.workspace_id != key.workspace_id
        {
            return Err(CliError::failure(
                "credential_corrupt",
                format!("{}가 이 프로필의 것이 아니에요.", path.display()),
            ));
        }
        Ok(Some(credential))
    }

    fn save(&self, key: &ProfileKey, credential: &Credential) -> Result<(), CliError> {
        ensure_private_dir(&self.root)?;
        ensure_private_dir(&self.directory())?;
        let bytes = serde_json::to_vec(credential)
            .map_err(|_| CliError::failure("storage_io", "자격을 직렬화하지 못했어요."))?;
        write_private_file(&self.path(key), &bytes)
    }

    fn delete(&self, key: &ProfileKey) -> Result<bool, CliError> {
        let path = self.path(key);
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_error("파일을 지우지 못했어요", &path, &error)),
        }
    }
}

// ---------------------------------------------------------------------------
// the macOS keychain backend
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub struct KeychainBackend;

#[cfg(target_os = "macos")]
mod keychain_impl {
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };

    use super::{Backend, CliError, Credential, KeychainBackend, ProfileKey, StorageKind};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
    const ERR_SEC_USER_CANCELED: i32 = -128;

    /// The same attributes for read, write and delete. `synchronizable = false`: a login is
    /// this device's and is never copied to iCloud Keychain.
    fn options(key: &ProfileKey) -> PasswordOptions {
        let mut options =
            PasswordOptions::new_generic_password(super::KEYCHAIN_SERVICE, &key.account());
        options.set_access_synchronized(Some(false));
        options
    }

    fn failure(action: &str, error: &security_framework::base::Error) -> CliError {
        let hint = match error.code() {
            ERR_SEC_INTERACTION_NOT_ALLOWED => {
                " 키체인이 잠겨 있고 화면에서 풀 수 없는 환경이에요."
            }
            ERR_SEC_USER_CANCELED => " 접근을 허용하지 않으셨어요.",
            _ => "",
        };
        CliError::failure(
            "keychain_unavailable",
            format!(
                "키체인에 {action}하지 못했어요(OSStatus {}).{hint} 파일에 저장하려면 `oort login --storage file`로 다시 해 주세요.",
                error.code()
            ),
        )
    }

    impl Backend for KeychainBackend {
        fn kind(&self) -> StorageKind {
            StorageKind::Keychain
        }

        fn load(&self, key: &ProfileKey) -> Result<Option<Credential>, CliError> {
            match generic_password(options(key)) {
                Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
                    CliError::failure(
                        "credential_corrupt",
                        "키체인의 자격을 읽을 수 없어요. `oort login`으로 다시 로그인해 주세요.",
                    )
                }),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(failure("접근", &error)),
            }
        }

        fn save(&self, key: &ProfileKey, credential: &Credential) -> Result<(), CliError> {
            let bytes = serde_json::to_vec(credential)
                .map_err(|_| CliError::failure("storage_io", "자격을 직렬화하지 못했어요."))?;
            set_generic_password_options(&bytes, options(key))
                .map_err(|error| failure("쓰기", &error))
        }

        fn delete(&self, key: &ProfileKey) -> Result<bool, CliError> {
            match delete_generic_password_options(options(key)) {
                Ok(()) => Ok(true),
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
                Err(error) => Err(failure("지우기", &error)),
            }
        }
    }
}

/// The platform's keychain, or — where there is none — a backend that refuses everything, so
/// the keychain-or-file decision in [`persist`] needs no `cfg` of its own.
pub fn keychain_backend() -> Box<dyn Backend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(KeychainBackend)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(NoKeychain)
    }
}

#[cfg(not(target_os = "macos"))]
pub struct NoKeychain;

#[cfg(not(target_os = "macos"))]
impl Backend for NoKeychain {
    fn kind(&self) -> StorageKind {
        StorageKind::Keychain
    }
    fn load(&self, _: &ProfileKey) -> Result<Option<Credential>, CliError> {
        Err(no_keychain())
    }
    fn save(&self, _: &ProfileKey, _: &Credential) -> Result<(), CliError> {
        Err(no_keychain())
    }
    fn delete(&self, _: &ProfileKey) -> Result<bool, CliError> {
        Err(no_keychain())
    }
}

#[cfg(not(target_os = "macos"))]
fn no_keychain() -> CliError {
    CliError::failure("keychain_unavailable", "이 환경에는 키체인이 없어요.")
}

// ---------------------------------------------------------------------------
// the store: config directory, current pointer, lock
// ---------------------------------------------------------------------------

pub struct Store {
    root: PathBuf,
}

impl Store {
    /// `$XDG_CONFIG_HOME/oort`, else `$HOME/.config/oort`. Nothing is created here.
    pub fn locate(xdg_config_home: Option<&Path>, home: Option<&Path>) -> Result<Store, CliError> {
        let base = match xdg_config_home.filter(|path| path.is_absolute()) {
            Some(path) => path.to_path_buf(),
            None => home
                .filter(|path| path.is_absolute())
                .map(|path| path.join(".config"))
                .ok_or_else(|| {
                    CliError::failure(
                        "storage_io",
                        "설정 위치를 찾지 못했어요(HOME 또는 XDG_CONFIG_HOME이 필요해요).",
                    )
                })?,
        };
        Ok(Store {
            root: base.join("oort"),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn ensure_root(&self) -> Result<(), CliError> {
        ensure_private_dir(&self.root)
    }

    fn current_path(&self) -> PathBuf {
        self.root.join("current.json")
    }

    pub fn current(&self) -> Result<Option<Current>, CliError> {
        if !self.root.exists() {
            return Ok(None);
        }
        ensure_private_dir(&self.root)?;
        let Some(bytes) = read_private_file(&self.current_path())? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            CliError::failure(
                "credential_corrupt",
                "현재 프로필 기록을 읽을 수 없어요. `oort login`으로 다시 로그인해 주세요.",
            )
        })
    }

    pub fn set_current(&self, current: &Current) -> Result<(), CliError> {
        self.ensure_root()?;
        let bytes = serde_json::to_vec(current)
            .map_err(|_| CliError::failure("storage_io", "기록을 직렬화하지 못했어요."))?;
        write_private_file(&self.current_path(), &bytes)
    }

    pub fn clear_current(&self) -> Result<(), CliError> {
        match fs::remove_file(self.current_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(
                "기록을 지우지 못했어요",
                &self.current_path(),
                &error,
            )),
        }
    }

    pub fn file_backend(&self) -> FileBackend {
        FileBackend::new(&self.root)
    }

    pub fn backend(&self, kind: StorageKind) -> Result<Box<dyn Backend>, CliError> {
        match kind {
            StorageKind::File => Ok(Box::new(self.file_backend())),
            StorageKind::Keychain => Ok(keychain_backend()),
        }
    }

    /// The lock every credential rewrite and refresh runs under. Kept in the config directory
    /// whichever backend holds the secrets.
    pub fn lock(&self) -> Result<FileLock, CliError> {
        self.ensure_root()?;
        FileLock::acquire(&self.root.join("lock"), LOCK_TIMEOUT)
    }
}

/// An exclusive advisory lock, released when dropped (closing the descriptor releases it, so a
/// crashed process never leaves it held).
pub struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    pub fn acquire(path: &Path, timeout: Duration) -> Result<FileLock, CliError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(no_follow())
            .open(path)
            .map_err(|error| io_error("잠금 파일을 열지 못했어요", path, &error))?;
        let started = Instant::now();
        loop {
            match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
                Ok(()) => return Ok(FileLock { _file: file }),
                Err(error) if error == rustix::io::Errno::WOULDBLOCK => {
                    if started.elapsed() >= timeout {
                        return Err(CliError::new(
                            Kind::Failure,
                            "lock_timeout",
                            "다른 oort 명령이 자격을 갱신하는 중이에요. 잠시 뒤에 다시 해 주세요.",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    return Err(CliError::failure(
                        "storage_io",
                        format!("잠금을 잡지 못했어요({error})."),
                    ))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    const SERVER: &str = "https://oort.example";
    const WORKSPACE: &str = "6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
    const MARKER: &str =
        "momo_dev_v1.6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b.MARKERMARKERMARKERMARKERMARKERMARKERMARK";

    fn credential() -> Credential {
        Credential::card(SERVER, WORKSPACE, Secret::new(MARKER))
    }

    fn key() -> ProfileKey {
        credential().key()
    }

    /// A backend that counts what it is asked to do and can be told to fail its writes.
    struct Fake {
        kind: StorageKind,
        fail_save: bool,
        saves: Cell<u32>,
        stored: RefCell<Option<Credential>>,
    }

    impl Fake {
        fn new(kind: StorageKind, fail_save: bool) -> Fake {
            Fake {
                kind,
                fail_save,
                saves: Cell::new(0),
                stored: RefCell::new(None),
            }
        }
    }

    impl Backend for Fake {
        fn kind(&self) -> StorageKind {
            self.kind
        }
        fn load(&self, _: &ProfileKey) -> Result<Option<Credential>, CliError> {
            Ok(self.stored.borrow().clone())
        }
        fn save(&self, _: &ProfileKey, credential: &Credential) -> Result<(), CliError> {
            self.saves.set(self.saves.get() + 1);
            if self.fail_save {
                return Err(CliError::failure("keychain_unavailable", "locked"));
            }
            *self.stored.borrow_mut() = Some(credential.clone());
            Ok(())
        }
        fn delete(&self, _: &ProfileKey) -> Result<bool, CliError> {
            Ok(self.stored.borrow_mut().take().is_some())
        }
    }

    fn persisted(
        preference: StoragePref,
        has_keychain: bool,
        keychain: &Fake,
        file: &Fake,
    ) -> (Result<StorageKind, CliError>, Vec<String>) {
        let mut notices = Vec::new();
        let result = persist(
            preference,
            has_keychain,
            keychain,
            file,
            &credential(),
            &mut |message| notices.push(message.to_string()),
        );
        (result, notices)
    }

    #[test]
    fn a_keychain_that_fails_a_write_is_an_error_and_the_file_is_never_touched() {
        let keychain = Fake::new(StorageKind::Keychain, true);
        let file = Fake::new(StorageKind::File, false);
        let (result, notices) = persisted(StoragePref::Auto, true, &keychain, &file);
        let error = result.expect_err("a failed keychain write must be an error");
        assert_eq!(error.code, "keychain_unavailable");
        assert_eq!(keychain.saves.get(), 1);
        assert_eq!(file.saves.get(), 0, "no quiet downgrade to a file");
        assert!(file.stored.borrow().is_none());
        assert!(notices.is_empty());
    }

    #[test]
    fn the_file_is_used_only_when_asked_or_when_the_platform_has_no_keychain() {
        // asked for explicitly: the keychain is never touched
        let keychain = Fake::new(StorageKind::Keychain, false);
        let file = Fake::new(StorageKind::File, false);
        let (result, _) = persisted(StoragePref::File, true, &keychain, &file);
        assert_eq!(result.expect("file"), StorageKind::File);
        assert_eq!((keychain.saves.get(), file.saves.get()), (0, 1));

        // no keychain on the platform: the file, with a notice
        let keychain = Fake::new(StorageKind::Keychain, false);
        let file = Fake::new(StorageKind::File, false);
        let (result, notices) = persisted(StoragePref::Auto, false, &keychain, &file);
        assert_eq!(result.expect("file"), StorageKind::File);
        assert_eq!((keychain.saves.get(), file.saves.get()), (0, 1));
        assert_eq!(notices.len(), 1, "the person is told it is a file");

        // a keychain that exists is used, with no notice
        let keychain = Fake::new(StorageKind::Keychain, false);
        let file = Fake::new(StorageKind::File, false);
        let (result, notices) = persisted(StoragePref::Auto, true, &keychain, &file);
        assert_eq!(result.expect("keychain"), StorageKind::Keychain);
        assert_eq!((keychain.saves.get(), file.saves.get()), (1, 0));
        assert!(notices.is_empty());

        // asking for a keychain where there is none is an error, not a file
        let keychain = Fake::new(StorageKind::Keychain, false);
        let file = Fake::new(StorageKind::File, false);
        let (result, _) = persisted(StoragePref::Keychain, false, &keychain, &file);
        assert!(result.is_err());
        assert_eq!(file.saves.get(), 0);
    }

    #[test]
    fn a_saved_file_is_0600_in_a_0700_directory_whatever_the_umask_was() {
        // The mode is given when the file is created, so the process umask can only narrow it.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("oort");
        let backend = FileBackend::new(&root);
        backend.save(&key(), &credential()).expect("save");
        let mode = |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&root.join("credentials")), 0o700);
        let file = backend.path(&key());
        assert_eq!(mode(&file), 0o600);
        // and what was saved is what comes back
        let loaded = backend.load(&key()).expect("load").expect("present");
        assert_eq!(loaded.access.expose(), MARKER);
    }

    #[test]
    fn a_file_that_others_can_read_is_refused_and_so_is_a_wide_directory_or_a_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("oort");
        let backend = FileBackend::new(&root);
        backend.save(&key(), &credential()).expect("save");
        let file = backend.path(&key());

        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).expect("chmod");
        let error = backend.load(&key()).expect_err("0644 must be refused");
        assert_eq!(error.code, "credential_permissions");
        assert!(!error.message.contains(MARKER));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("chmod");
        assert!(backend.load(&key()).expect("load").is_some());

        fs::set_permissions(root.join("credentials"), fs::Permissions::from_mode(0o755))
            .expect("chmod");
        assert_eq!(
            backend.load(&key()).expect_err("wide dir").code,
            "credential_permissions"
        );
        fs::set_permissions(root.join("credentials"), fs::Permissions::from_mode(0o700))
            .expect("chmod");

        let target = dir.path().join("elsewhere.json");
        fs::copy(&file, &target).expect("copy");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("chmod");
        fs::remove_file(&file).expect("rm");
        std::os::unix::fs::symlink(&target, &file).expect("symlink");
        assert!(backend.load(&key()).is_err(), "a link is never followed");
    }

    #[test]
    fn the_lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("lock");
        let first = FileLock::acquire(&path, Duration::from_secs(1)).expect("first");
        let started = Instant::now();
        let second = FileLock::acquire(&path, Duration::from_millis(150));
        assert!(second.is_err(), "a held lock must not be granted twice");
        assert!(started.elapsed() >= Duration::from_millis(100));
        drop(first);
        FileLock::acquire(&path, Duration::from_secs(1)).expect("free again after drop");
    }
}
