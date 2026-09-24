//! Local-volume archive (ADR-0169).
//!
//! Bytes live under an operator-supplied directory (`MOMO_DRIVE_LOCAL_DIR`).
//! Disk paths are **opaque ids this process minted** — a user-supplied file
//! name is metadata only and never interpolates into a path. Upload sessions
//! reuse the stub's in-process PUT route (`accepts_stub_uploads`); the
//! capability URL is uncredentialed for the same reason Google's is.
//!
//! Restart-surviving (unlike the stub): sessions and objects are files, so a
//! deployed environment may select this backend. A missing directory is
//! created at open; an unwritable one is a boot error, not a silent 503.
//!
//! A session file is a **single-use capability with a deadline** (#2615): the
//! first accepted upload deletes it before a byte is written, and it carries
//! its own `expires_at_ms` so the deadline survives a restart. A session file
//! with no deadline was written before #2615 — every completed upload left one
//! behind — and is refused, never treated as immortal. An object that has
//! landed is never overwritten through a session, whatever brought that
//! session back (a volume restored from a backup taken mid-upload).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    nonempty, uploaded_size_refusal, valid_drive_id, DriveArchive, DriveContent, DriveError,
    DriveFile, DriveUploadSession, MAX_ATTACHMENT_BYTES, UPLOAD_SESSION_TTL,
};

const OBJECTS_DIR: &str = "objects";
const SESSIONS_DIR: &str = "sessions";
const WRITE_PROBE: &str = ".oort-write-ok";
const META_SUFFIX: &str = ".meta";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredMeta {
    name: String,
    mime: String,
    size_bytes: i64,
}

/// One `sessions/{token}` file: what the upload must look like, and until when
/// the token may deliver it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingSession {
    file_id: String,
    name: String,
    mime: String,
    size_bytes: i64,
    /// Wall-clock deadline, Unix epoch milliseconds. `None` only in a file an
    /// older binary wrote, which is refused as expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<i64>,
}

impl PendingSession {
    fn expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms.is_none_or(|deadline| now_ms >= deadline)
    }
}

/// Filesystem archive keyed by opaque ids.
#[derive(Debug)]
pub struct LocalDriveArchive {
    root: PathBuf,
    base_url: String,
    session_ttl: Duration,
    lock: Mutex<()>,
}

impl LocalDriveArchive {
    /// Create (if missing) and pin a writable archive directory.
    pub fn open(dir: Option<&str>, base_url: &str) -> Result<LocalDriveArchive, DriveError> {
        let dir = nonempty(dir).ok_or(DriveError::Unavailable)?;
        let root = prepare_local_dir(dir).map_err(|_| DriveError::Unavailable)?;
        Ok(LocalDriveArchive {
            root,
            base_url: base_url.trim_end_matches('/').to_string(),
            session_ttl: UPLOAD_SESSION_TTL,
            lock: Mutex::new(()),
        })
    }

    /// Replace [`UPLOAD_SESSION_TTL`] for sessions this instance mints.
    /// Verifiers pass `Duration::ZERO` to prove an expired capability is
    /// refused without waiting out the real lifetime.
    pub fn with_upload_session_ttl(mut self, ttl: Duration) -> LocalDriveArchive {
        self.session_ttl = ttl;
        self
    }

    /// Remove a stored object. Not on [`DriveArchive`]: v0 routes never delete.
    /// Tests (and a future janitor) call this directly.
    pub async fn delete(&self, file_id: &str) -> Result<(), DriveError> {
        let _guard = self.lock.lock().await;
        let object = object_path(&self.root, file_id)?;
        let meta = meta_path(&self.root, file_id)?;
        let mut missing = true;
        if object.exists() {
            fs::remove_file(&object).map_err(|_| DriveError::UpstreamFailure)?;
            missing = false;
        }
        if meta.exists() {
            fs::remove_file(&meta).map_err(|_| DriveError::UpstreamFailure)?;
            missing = false;
        }
        if missing {
            return Err(DriveError::FileNotFound);
        }
        Ok(())
    }
}

/// Create `path` (and the objects/sessions children) and prove it is writable.
///
/// Returns the canonical directory. Messages name no host path — the caller
/// (`DriveSettings::boot_error`) maps the `&'static str` onto a boot refusal.
pub fn prepare_local_dir(path: &str) -> Result<PathBuf, &'static str> {
    let path = path.trim();
    if path.is_empty() {
        return Err("MOMO_DRIVE_LOCAL_DIR is required when MOMO_DRIVE_ARCHIVE_BACKEND=local");
    }
    let root = PathBuf::from(path);
    if root.exists() && !root.is_dir() {
        return Err("MOMO_DRIVE_LOCAL_DIR could not be created or is not writable");
    }
    fs::create_dir_all(root.join(OBJECTS_DIR))
        .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
    fs::create_dir_all(root.join(SESSIONS_DIR))
        .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
    let probe = root.join(WRITE_PROBE);
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&probe)
            .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
        file.write_all(b"ok")
            .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
    }
    let _ = fs::remove_file(&probe);
    root.canonicalize()
        .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")
}

/// Reject the three escape families the packet names: `../`, absolute paths,
/// and a symlink that would leave the archive root.
pub fn resolve_local_id(root: &Path, id: &str) -> Result<PathBuf, DriveError> {
    if !valid_local_id(id) {
        return Err(DriveError::InvalidArguments(
            "archive object id is not an opaque local id".into(),
        ));
    }
    let root_canon = root
        .canonicalize()
        .map_err(|_| DriveError::InvalidArguments("archive root is not a directory".into()))?;
    let candidate = root_canon.join(id);
    if candidate
        .parent()
        .is_none_or(|parent| parent != root_canon.as_path())
    {
        return Err(DriveError::InvalidArguments(
            "archive object id escaped the archive root".into(),
        ));
    }
    refuse_symlink(&candidate)?;
    if candidate.exists() {
        let canon = candidate
            .canonicalize()
            .map_err(|_| DriveError::AccessDenied)?;
        if !canon.starts_with(&root_canon) {
            return Err(DriveError::AccessDenied);
        }
    }
    Ok(candidate)
}

fn valid_local_id(id: &str) -> bool {
    valid_drive_id(id)
}

fn refuse_symlink(path: &Path) -> Result<(), DriveError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(DriveError::AccessDenied),
        Ok(_) | Err(_) => Ok(()),
    }
}

fn object_path(root: &Path, file_id: &str) -> Result<PathBuf, DriveError> {
    resolve_local_id(&root.join(OBJECTS_DIR), file_id)
}

fn meta_path(root: &Path, file_id: &str) -> Result<PathBuf, DriveError> {
    let object = object_path(root, file_id)?;
    Ok(object.with_file_name(format!("{file_id}{META_SUFFIX}")))
}

fn session_path(root: &Path, token: &str) -> Result<PathBuf, DriveError> {
    resolve_local_id(&root.join(SESSIONS_DIR), token)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), DriveError> {
    refuse_symlink(path)?;
    let tmp_name = format!(
        "{}.tmp",
        path.file_name()
            .ok_or(DriveError::UpstreamFailure)?
            .to_string_lossy()
    );
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, bytes).map_err(|_| DriveError::UpstreamFailure)?;
    fs::rename(&tmp, path).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        DriveError::UpstreamFailure
    })
}

/// Wall clock in Unix epoch milliseconds — the unit a session file stores, so
/// a deadline outlives the process that set it.
fn epoch_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis().min(i64::MAX as u128) as i64)
}

fn duration_ms(duration: Duration) -> i64 {
    duration.as_millis().min(i64::MAX as u128) as i64
}

fn read_meta(root: &Path, file_id: &str) -> Result<StoredMeta, DriveError> {
    let path = meta_path(root, file_id)?;
    refuse_symlink(&path)?;
    let raw = fs::read(&path).map_err(|_| DriveError::FileNotFound)?;
    serde_json::from_slice(&raw).map_err(|_| DriveError::FileNotFound)
}

#[async_trait]
impl DriveArchive for LocalDriveArchive {
    fn accepts_stub_uploads(&self) -> bool {
        true
    }

    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        if !(0..=MAX_ATTACHMENT_BYTES).contains(&size_bytes) {
            return Err(DriveError::ContentTooLarge);
        }
        let _guard = self.lock.lock().await;
        let token = Uuid::new_v4().to_string().to_lowercase();
        let file_id = format!("local-{}", Uuid::new_v4().to_string().to_lowercase());
        let pending = PendingSession {
            file_id: file_id.clone(),
            name: name.to_string(),
            mime: mime.to_string(),
            size_bytes,
            expires_at_ms: Some(epoch_ms_now().saturating_add(duration_ms(self.session_ttl))),
        };
        let session = session_path(&self.root, &token)?;
        let body = serde_json::to_vec(&pending).map_err(|_| DriveError::UpstreamFailure)?;
        atomic_write(&session, &body)?;
        // Boot-time assembly only. When `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL` is
        // `same-origin`, momo-server rewrites this URL from the request's
        // Caddy-normalized Host / X-Forwarded-Proto (ADR-0167 reused by
        // ADR-0169 증보 1). An absolute env value stays verbatim here.
        Ok(DriveUploadSession {
            drive_file_id: file_id,
            upload_url: format!("{}/__momo_stub/drive/uploads/{token}", self.base_url),
        })
    }

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        let _guard = self.lock.lock().await;
        let meta = read_meta(&self.root, file_id)?;
        let object = object_path(&self.root, file_id)?;
        if !object.is_file() {
            return Err(DriveError::FileNotFound);
        }
        let measured = fs::metadata(&object)
            .map_err(|_| DriveError::FileNotFound)?
            .len();
        if measured > i64::MAX as u64 {
            return Err(DriveError::ContentTooLarge);
        }
        Ok(DriveFile {
            drive_file_id: file_id.to_string(),
            name: meta.name,
            mime: meta.mime,
            size_bytes: measured as i64,
        })
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        let _guard = self.lock.lock().await;
        let meta = read_meta(&self.root, file_id)?;
        let object = object_path(&self.root, file_id)?;
        refuse_symlink(&object)?;
        let bytes = fs::read(&object).map_err(|_| DriveError::FileNotFound)?;
        if bytes.len() as i64 > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        Ok(DriveContent {
            mime: meta.mime,
            size_bytes: bytes.len() as i64,
            body: Box::pin(futures::stream::once(async move { Ok(Bytes::from(bytes)) })),
        })
    }

    async fn accept_stub_upload(
        &self,
        token: &str,
        mime: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<(), DriveError> {
        let _guard = self.lock.lock().await;
        let session = session_path(&self.root, token)?;
        let raw = fs::read(&session).map_err(|_| DriveError::FileNotFound)?;
        let pending: PendingSession =
            serde_json::from_slice(&raw).map_err(|_| DriveError::FileNotFound)?;
        let object = object_path(&self.root, &pending.file_id)?;
        let meta = meta_path(&self.root, &pending.file_id)?;
        let landed = object.exists() || meta.exists();
        if pending.expired(epoch_ms_now()) || landed {
            // A capability that can no longer be used is forgotten with its
            // refusal, and the refusal is the unknown-token one.
            let _ = fs::remove_file(&session);
            return Err(DriveError::FileNotFound);
        }
        let measured = bytes.len() as i64;
        if let Some(error) = uploaded_size_refusal(pending.size_bytes, measured) {
            return Err(error);
        }
        if let Some(mime) = mime {
            if !mime.is_empty() && mime != pending.mime {
                return Err(DriveError::InvalidArguments(
                    "uploaded mime does not match the session".into(),
                ));
            }
        }
        let stored = StoredMeta {
            name: pending.name,
            mime: pending.mime,
            size_bytes: measured,
        };
        let meta_bytes = serde_json::to_vec(&stored).map_err(|_| DriveError::UpstreamFailure)?;
        // Spend the capability BEFORE a byte is stored. The other order leaves
        // a window — a failed delete, a crash — in which the bytes have landed
        // and the URL still opens; this order fails closed: a storage failure
        // costs the client a new session, which is how every client retries.
        fs::remove_file(&session).map_err(|_| DriveError::UpstreamFailure)?;
        if let Err(error) =
            atomic_write(&object, &bytes).and_then(|()| atomic_write(&meta, &meta_bytes))
        {
            // Nothing half-landed stays behind a spent session.
            let _ = fs::remove_file(&object);
            let _ = fs::remove_file(&meta);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    struct DirGuard(PathBuf);
    impl Drop for DirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_root() -> (PathBuf, DirGuard) {
        let dir = std::env::temp_dir().join(format!(
            "oort-drive-local-{}-{}",
            std::process::id(),
            TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("temp root");
        (dir.clone(), DirGuard(dir))
    }

    async fn collect(content: DriveContent) -> Vec<u8> {
        let mut body = content.body;
        let mut out = Vec::new();
        while let Some(chunk) = body.next().await {
            out.extend_from_slice(&chunk.expect("chunk"));
        }
        out
    }

    fn token_from(session: &DriveUploadSession) -> String {
        session
            .upload_url
            .rsplit('/')
            .next()
            .expect("token")
            .to_string()
    }

    #[test]
    fn prepare_creates_a_missing_directory() {
        let (dir, _guard) = temp_root();
        let nested = dir.join("archive");
        assert!(!nested.exists());
        let created = prepare_local_dir(nested.to_str().expect("utf8")).expect("create");
        assert!(created.join(OBJECTS_DIR).is_dir());
        assert!(created.join(SESSIONS_DIR).is_dir());
    }

    #[test]
    fn prepare_refuses_a_path_that_is_not_a_directory() {
        let (dir, _guard) = temp_root();
        let file = dir.join("not-a-dir");
        fs::write(&file, b"nope").expect("file");
        assert!(prepare_local_dir(file.to_str().expect("utf8")).is_err());
    }

    #[test]
    fn path_escape_rejects_dotdot_absolute_and_symlink() {
        let (dir, _guard) = temp_root();
        let root = prepare_local_dir(dir.to_str().expect("utf8")).expect("root");
        let objects = root.join(OBJECTS_DIR);

        assert!(
            matches!(
                resolve_local_id(&objects, "../passwd"),
                Err(DriveError::InvalidArguments(_))
            ),
            "dot-dot traversal"
        );
        assert!(
            matches!(
                resolve_local_id(&objects, "/etc/passwd"),
                Err(DriveError::InvalidArguments(_))
            ),
            "absolute path"
        );

        let target = dir.join("outside.txt");
        fs::write(&target, b"secret").expect("outside");
        let link = objects.join("escaped");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        #[cfg(not(unix))]
        {
            let _ = (target, link);
            return;
        }
        assert_eq!(
            resolve_local_id(&objects, "escaped").expect_err("symlink"),
            DriveError::AccessDenied
        );
    }

    #[tokio::test]
    async fn store_read_delete_round_trips_and_keeps_the_filename_off_disk() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let nasty_name = "../../etc/passwd.txt";
        let session = archive
            .create_resumable_upload(Uuid::nil(), nasty_name, "text/plain", 5)
            .await
            .expect("session");
        assert!(
            session.drive_file_id.starts_with("local-"),
            "{}",
            session.drive_file_id
        );
        assert!(
            session
                .upload_url
                .starts_with("http://127.0.0.1:9/__momo_stub/drive/uploads/"),
            "{}",
            session.upload_url
        );
        archive
            .accept_stub_upload(&token_from(&session), Some("text/plain"), b"hello".to_vec())
            .await
            .expect("upload");

        let metadata = archive
            .file_metadata(&session.drive_file_id)
            .await
            .expect("metadata");
        assert_eq!(metadata.name, nasty_name);
        assert_eq!(metadata.size_bytes, 5);
        let content = archive
            .file_content(&session.drive_file_id, MAX_ATTACHMENT_BYTES)
            .await
            .expect("content");
        assert_eq!(collect(content).await, b"hello");

        let mut found_user_name = false;
        let walker = walkdir_names(&archive.root);
        for name in &walker {
            if name.contains("passwd") || name.contains("etc") {
                found_user_name = true;
            }
        }
        assert!(
            !found_user_name,
            "user filename leaked onto disk: {walker:?}"
        );

        archive
            .delete(&session.drive_file_id)
            .await
            .expect("delete");
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("gone"),
            DriveError::FileNotFound
        );
    }

    fn walkdir_names(root: &Path) -> Vec<String> {
        let mut names = Vec::new();
        fn rec(path: &Path, names: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(path) else {
                return;
            };
            for entry in entries.flatten() {
                names.push(entry.file_name().to_string_lossy().into_owned());
                let child = entry.path();
                if child.is_dir() {
                    rec(&child, names);
                }
            }
        }
        rec(root, &mut names);
        names
    }

    #[tokio::test]
    async fn metadata_is_absent_until_bytes_land() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("no bytes yet"),
            DriveError::FileNotFound
        );
    }

    #[tokio::test]
    async fn a_read_over_the_ceiling_is_refused() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "big.bin", "application/octet-stream", 8)
            .await
            .expect("session");
        archive
            .accept_stub_upload(&token_from(&session), None, vec![0u8; 8])
            .await
            .expect("upload");
        assert_eq!(
            archive
                .file_content(&session.drive_file_id, 4)
                .await
                .expect_err("over the ceiling"),
            DriveError::ContentTooLarge
        );
    }

    #[tokio::test]
    async fn a_session_over_the_ceiling_is_refused_before_bytes() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        assert_eq!(
            archive
                .create_resumable_upload(
                    Uuid::nil(),
                    "huge.bin",
                    "application/octet-stream",
                    MAX_ATTACHMENT_BYTES + 1
                )
                .await
                .expect_err("over the ceiling"),
            DriveError::ContentTooLarge
        );
    }

    #[tokio::test]
    async fn a_zero_declaration_records_the_received_length() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 0)
            .await
            .expect("session");
        let token = token_from(&session);
        archive
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
            .await
            .expect("unknown declaration accepts measured bytes");
        let metadata = archive
            .file_metadata(&session.drive_file_id)
            .await
            .expect("metadata");
        assert_eq!(metadata.size_bytes, 5);
    }

    #[tokio::test]
    async fn an_upload_that_contradicts_its_session_is_refused() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"too long".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("image/png"), b"hello".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            archive
                .accept_stub_upload(
                    "00000000-0000-4000-8000-000000000000",
                    None,
                    b"hello".to_vec()
                )
                .await
                .expect_err("unknown token"),
            DriveError::FileNotFound
        );
    }

    // ---- #2615: the capability is single-use and expires ------------------

    fn session_file(archive: &LocalDriveArchive, token: &str) -> PathBuf {
        archive.root.join(SESSIONS_DIR).join(token)
    }

    /// Rewrite one field of a session file the way an old binary, a restored
    /// backup or the passage of time would have left it.
    fn edit_session(
        archive: &LocalDriveArchive,
        token: &str,
        edit: impl FnOnce(&mut serde_json::Value),
    ) {
        let path = session_file(archive, token);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("session file")).expect("session json");
        edit(&mut value);
        fs::write(&path, serde_json::to_vec(&value).expect("json")).expect("rewrite session");
    }

    async fn stored_bytes(archive: &LocalDriveArchive, file_id: &str) -> Vec<u8> {
        collect(
            archive
                .file_content(file_id, MAX_ATTACHMENT_BYTES)
                .await
                .expect("content"),
        )
        .await
    }

    /// **Red proof (#2615).** The first upload spends the capability. Before
    /// the fix the session file outlived the PUT, so the same URL could swap
    /// the bytes of an attachment that had already been completed and posted
    /// — same mime and same length were the only conditions.
    #[tokio::test]
    async fn an_upload_capability_is_spent_by_its_first_upload() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "contract.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        archive
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
            .await
            .expect("first upload");
        assert!(
            !session_file(&archive, &token).exists(),
            "the upload that landed spent the session: its file is gone"
        );

        // Same mime, same length: the only shape the old checks let through.
        let replay = archive
            .accept_stub_upload(&token, Some("text/plain"), b"HACKD".to_vec())
            .await;
        let now_stored = stored_bytes(&archive, &session.drive_file_id).await;
        assert_eq!(
            (replay, String::from_utf8_lossy(&now_stored).into_owned()),
            (Err(DriveError::FileNotFound), "hello".to_string()),
            "a spent capability must answer not-found and leave the landed bytes alone"
        );
        // Restart-surviving backend: a fresh process over the same volume
        // must not find the capability either.
        let reopened = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("reopen");
        assert_eq!(
            reopened
                .accept_stub_upload(&token, Some("text/plain"), b"HACKD".to_vec())
                .await
                .expect_err("still spent after a restart"),
            DriveError::FileNotFound
        );
        assert_eq!(
            stored_bytes(&reopened, &session.drive_file_id).await,
            b"hello"
        );
    }

    /// An object a janitor removed must not come back through the URL that
    /// first wrote it. Separates "the session is spent" from "an existing
    /// object is never overwritten": here there is no object left to protect.
    #[tokio::test]
    async fn a_deleted_object_cannot_be_resurrected_through_its_old_capability() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        archive
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
            .await
            .expect("first upload");
        archive
            .delete(&session.drive_file_id)
            .await
            .expect("janitor delete");
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"HACKD".to_vec())
                .await
                .expect_err("spent capability"),
            DriveError::FileNotFound
        );
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("nothing was resurrected"),
            DriveError::FileNotFound
        );
    }

    /// A session file that comes back after its upload landed — a volume
    /// restored from a backup taken mid-upload — must not be able to
    /// overwrite the object that landed. Its expiry is still in the future.
    #[tokio::test]
    async fn a_resurrected_session_cannot_overwrite_an_object_that_landed() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "contract.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let saved = fs::read(session_file(&archive, &token)).expect("session file");
        archive
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
            .await
            .expect("first upload");

        fs::write(session_file(&archive, &token), &saved).expect("restore session file");
        edit_session(&archive, &token, |value| {
            value["expires_at_ms"] = serde_json::json!(epoch_ms_now() + 3_600_000);
        });
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"HACKD".to_vec())
                .await
                .expect_err("an object that landed is never replaced"),
            DriveError::FileNotFound
        );
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"hello"
        );
    }

    /// An expired capability is refused before its bytes are looked at, and
    /// forgotten: the session file goes with the refusal.
    #[tokio::test]
    async fn an_expired_capability_is_refused_and_forgotten() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        edit_session(&archive, &token, |value| {
            value["expires_at_ms"] = serde_json::json!(epoch_ms_now() - 1);
        });
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
                .await
                .expect_err("expired"),
            DriveError::FileNotFound
        );
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("no bytes landed"),
            DriveError::FileNotFound
        );
        assert!(
            !session_file(&archive, &token).exists(),
            "an expired session is removed when it is refused"
        );
    }

    /// Session files written before #2615 carry no expiry — and every
    /// completed upload left one behind. They are refused, never treated as
    /// immortal, or every URL ever handed out would stay live after the fix.
    #[tokio::test]
    async fn a_session_file_without_an_expiry_is_refused() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        edit_session(&archive, &token, |value| {
            value
                .as_object_mut()
                .expect("session object")
                .remove("expires_at_ms");
        });
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
                .await
                .expect_err("a legacy session has no lifetime left"),
            DriveError::FileNotFound
        );
        assert!(!session_file(&archive, &token).exists());
    }

    /// Every session this binary mints carries the shared deadline — without
    /// it the legacy refusal above would turn away every upload.
    #[tokio::test]
    async fn a_minted_session_carries_the_shared_deadline() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        assert_eq!(archive.session_ttl, UPLOAD_SESSION_TTL);
        let before = epoch_ms_now();
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let after = epoch_ms_now();
        let stored: PendingSession = serde_json::from_slice(
            &fs::read(session_file(&archive, &token_from(&session))).expect("session file"),
        )
        .expect("session json");
        let ttl = duration_ms(UPLOAD_SESSION_TTL);
        let deadline = stored.expires_at_ms.expect("a deadline is written");
        assert!(
            (before + ttl..=after + ttl).contains(&deadline),
            "deadline {deadline} is not mint time + {ttl} ms ({before}..={after})"
        );
    }

    #[tokio::test]
    async fn a_zero_lifetime_session_is_born_expired() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9")
            .expect("open")
            .with_upload_session_ttl(Duration::ZERO);
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        assert_eq!(
            archive
                .accept_stub_upload(&token_from(&session), Some("text/plain"), b"hello".to_vec())
                .await
                .expect_err("expired on arrival"),
            DriveError::FileNotFound
        );
    }

    /// Fail closed: the capability is spent before a byte is stored, so a
    /// storage failure can never leave landed bytes behind a live URL. The
    /// failure is forced by squatting a directory on the temp name
    /// `atomic_write` needs — first for the object, then for its metadata.
    #[tokio::test]
    async fn a_storage_failure_spends_the_capability_and_leaves_nothing_behind() {
        for blocked_suffix in [".tmp", ".meta.tmp"] {
            let (dir, _guard) = temp_root();
            let archive =
                LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
            let session = archive
                .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
                .await
                .expect("session");
            let token = token_from(&session);
            let objects = archive.root.join(OBJECTS_DIR);
            fs::create_dir(objects.join(format!("{}{blocked_suffix}", session.drive_file_id)))
                .expect("squat the temp name");

            assert_eq!(
                archive
                    .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
                    .await
                    .expect_err("storage fails"),
                DriveError::UpstreamFailure,
                "blocked {blocked_suffix}"
            );
            assert!(
                !session_file(&archive, &token).exists(),
                "blocked {blocked_suffix}: the session was spent before storage was attempted"
            );
            assert!(
                !objects.join(&session.drive_file_id).exists(),
                "blocked {blocked_suffix}: no half-landed object stays behind"
            );
            assert_eq!(
                archive
                    .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
                    .await
                    .expect_err("the client starts a new session"),
                DriveError::FileNotFound,
                "blocked {blocked_suffix}"
            );
        }
    }

    /// The retry policy: a PUT the archive refuses before storing anything
    /// (wrong length, wrong mime) leaves the capability usable, like a Google
    /// resumable session that has not received its bytes yet.
    #[tokio::test]
    async fn a_refused_upload_does_not_spend_the_capability() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), b"too long".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("image/png"), b"hello".to_vec())
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        archive
            .accept_stub_upload(&token, Some("text/plain"), b"hello".to_vec())
            .await
            .expect("the corrected upload lands");
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"hello"
        );
    }
}
