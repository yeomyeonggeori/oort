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

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    nonempty, uploaded_size_refusal, valid_drive_id, DriveArchive, DriveContent, DriveError,
    DriveFile, DriveUploadSession, MAX_ATTACHMENT_BYTES,
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

/// Filesystem archive keyed by opaque ids.
#[derive(Debug)]
pub struct LocalDriveArchive {
    root: PathBuf,
    base_url: String,
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
            lock: Mutex::new(()),
        })
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
        let pending = StoredMeta {
            name: name.to_string(),
            mime: mime.to_string(),
            size_bytes,
        };
        let session = session_path(&self.root, &token)?;
        let body = serde_json::to_vec(&serde_json::json!({
            "file_id": file_id,
            "name": pending.name,
            "mime": pending.mime,
            "size_bytes": pending.size_bytes,
        }))
        .map_err(|_| DriveError::UpstreamFailure)?;
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
        let pending: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| DriveError::FileNotFound)?;
        let file_id = pending
            .get("file_id")
            .and_then(|v| v.as_str())
            .ok_or(DriveError::FileNotFound)?;
        let declared_mime = pending
            .get("mime")
            .and_then(|v| v.as_str())
            .ok_or(DriveError::FileNotFound)?;
        let declared_size = pending
            .get("size_bytes")
            .and_then(|v| v.as_i64())
            .ok_or(DriveError::FileNotFound)?;
        let name = pending
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or(DriveError::FileNotFound)?;
        let measured = bytes.len() as i64;
        if let Some(error) = uploaded_size_refusal(declared_size, measured) {
            return Err(error);
        }
        if let Some(mime) = mime {
            if !mime.is_empty() && mime != declared_mime {
                return Err(DriveError::InvalidArguments(
                    "uploaded mime does not match the session".into(),
                ));
            }
        }
        let object = object_path(&self.root, file_id)?;
        let meta = meta_path(&self.root, file_id)?;
        atomic_write(&object, &bytes)?;
        let stored = StoredMeta {
            name: name.to_string(),
            mime: declared_mime.to_string(),
            size_bytes: measured,
        };
        let meta_bytes = serde_json::to_vec(&stored).map_err(|_| DriveError::UpstreamFailure)?;
        atomic_write(&meta, &meta_bytes)?;
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
}
