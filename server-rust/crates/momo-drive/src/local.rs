//! Local-volume archive (ADR-0169).
//!
//! Bytes live under an operator-supplied directory (`MOMO_DRIVE_LOCAL_DIR`).
//! Disk paths are **opaque ids this process minted** — a user-supplied file
//! name is metadata only and never interpolates into a path. Upload sessions
//! reuse the stub's in-process PUT route (`accepts_stub_uploads`); the
//! capability URL is uncredentialed for the same reason Google's is.
//!
//! Objects survive a restart (unlike the stub's), so a deployed environment
//! may select this backend. A missing directory is created at open; an
//! unwritable one is a boot error, not a silent 503.
//!
//! A session file is a **single-use capability with a deadline** (#2615): the
//! upload that passes every check deletes it before its bytes become readable,
//! and it carries its own `expires_at_ms`. A session file with no deadline was
//! written before #2615 and is refused, never treated as immortal.
//!
//! **Pending sessions do not survive a restart (#2628).**
//! [`LocalDriveArchive::open`] clears `sessions/` and `incoming/`; an upload a
//! restart cut off is sent again with a new session, which is how every client
//! retries. That is also what keeps a restored volume from reopening a URL: a
//! crash-consistent snapshot taken between a session's creation and its upload
//! holds the session but not the object, so for up to an hour neither the
//! deadline nor the landed-object check would stop a replay from filling a
//! file id PostgreSQL already calls complete. An object that has landed is
//! still never overwritten through a session — the check that covers files a
//! restore brings back in the other order, or into a running process.
//!
//! **Bodies stream to disk (#2628).** The capability and the announced length
//! are checked before a byte is read; the body is then written chunk by chunk
//! into a private file under `incoming/`, outside the lock, and refused at the
//! first byte too many. Only a complete, accepted body is renamed into
//! `objects/`, and only after its session is spent.
//!
//! **One process per archive directory.** Spending a session is serialized by
//! this process's lock, not by the filesystem. A second process on the same
//! directory is unsupported — and its `open` would clear the first's pending
//! sessions.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    interrupted_upload, nonempty, refuse_before_body, uploaded_size_refusal, valid_drive_id,
    DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession, ReceivedLength,
    UploadBody, MAX_ATTACHMENT_BYTES, UPLOAD_SESSION_TTL,
};

const OBJECTS_DIR: &str = "objects";
const SESSIONS_DIR: &str = "sessions";
/// Bodies being received. Nothing here is reachable by a reader, and nothing
/// here outlives the process that wrote it (see [`clear_pending`]).
const INCOMING_DIR: &str = "incoming";
const WRITE_PROBE: &str = ".oort-write-ok";
const META_SUFFIX: &str = ".meta";
const PART_SUFFIX: &str = "part";
/// What an interrupted [`atomic_write`] leaves behind (and what the pre-#2628
/// object writer left in `objects/`). No id can contain a `.`, so a name with
/// this suffix is never a live object or metadata file.
const TMP_SUFFIX: &str = ".tmp";

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
    /// Create (if missing) and pin a writable archive directory, and clear
    /// what the previous process left pending (#2628): upload sessions, bodies
    /// it was receiving, and interrupted writes. Landed objects are untouched.
    pub fn open(dir: Option<&str>, base_url: &str) -> Result<LocalDriveArchive, DriveError> {
        let dir = nonempty(dir).ok_or(DriveError::Unavailable)?;
        let root = prepare_local_dir(dir).map_err(|_| DriveError::Unavailable)?;
        let cleared = clear_pending(&root);
        if cleared.sessions + cleared.partials > 0 {
            tracing::info!(
                sessions = cleared.sessions,
                partial_writes = cleared.partials,
                "local archive: cleared the upload sessions and partial writes a previous process left"
            );
        }
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
    // #2631 review R11: opening the archive clears every file in these two
    // directories. Through a symlink that would be some other directory's
    // files, so a linked one is a boot error rather than something to follow.
    // They only ever hold this archive's own short-lived files, so there is no
    // reason to put them anywhere else.
    for dir in [SESSIONS_DIR, INCOMING_DIR] {
        if fs::symlink_metadata(root.join(dir)).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(
                "MOMO_DRIVE_LOCAL_DIR has a symlinked sessions/ or incoming/ directory; \
                 the archive clears those at start and will not do it through a link",
            );
        }
    }
    fs::create_dir_all(root.join(OBJECTS_DIR))
        .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
    fs::create_dir_all(root.join(SESSIONS_DIR))
        .map_err(|_| "MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")?;
    fs::create_dir_all(root.join(INCOMING_DIR))
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
    // A write that fails part-way (a full disk) still created the file: it is
    // removed on that path too, not only when the rename fails.
    if fs::write(&tmp, bytes).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(DriveError::UpstreamFailure);
    }
    fs::rename(&tmp, path).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        DriveError::UpstreamFailure
    })
}

/// What [`clear_pending`] removed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Cleared {
    sessions: usize,
    partials: usize,
}

/// Remove every pending upload session, every body that was being received,
/// and every interrupted write under `root`. Best effort: a file that cannot
/// be removed is still refused by the deadline and landed-object checks.
fn clear_pending(root: &Path) -> Cleared {
    fn remove_files(dir: &Path, keep: impl Fn(&str) -> bool) -> usize {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            let name = entry.file_name();
            if is_dir || keep(&name.to_string_lossy()) {
                continue;
            }
            if fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }
    Cleared {
        sessions: remove_files(&root.join(SESSIONS_DIR), |_| false),
        partials: remove_files(&root.join(INCOMING_DIR), |_| false)
            + remove_files(&root.join(OBJECTS_DIR), |name| !name.ends_with(TMP_SUFFIX)),
    }
}

/// Create `path` (which must not exist) holding `bytes`; nothing is left
/// behind when that fails.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), DriveError> {
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(bytes));
    if written.is_err() {
        let _ = fs::remove_file(path);
        return Err(DriveError::UpstreamFailure);
    }
    Ok(())
}

/// Move a finished file from `incoming/` to its place in `objects/`.
fn publish(from: &Path, to: &Path) -> Result<(), DriveError> {
    refuse_symlink(to)?;
    fs::rename(from, to).map_err(|_| DriveError::UpstreamFailure)
}

/// Removes a body file under `incoming/` when dropped, however the upload
/// ended: published (the file was renamed away and this is a no-op), refused,
/// or cut off because the future was dropped mid-stream — a cancelled request
/// (#2631 review R10). The next start clears `incoming/` as well; this keeps a
/// running process from collecting them in between.
struct PartFile(PathBuf);

impl Drop for PartFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Write `body` into `part` as it arrives, refusing at the first byte over the
/// ceiling or past a known declaration. Returns the measured length.
///
/// The file is created synchronously: a create still in flight on the blocking
/// pool when the future is dropped would land after [`PartFile`] had already
/// cleaned up. Every write after it goes to that file descriptor, so a dropped
/// future can only ever leave an unlinked inode behind.
async fn stream_into(part: &Path, mut body: UploadBody, declared: i64) -> Result<i64, DriveError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .map_err(|_| DriveError::UpstreamFailure)?;
    let mut file = tokio::fs::File::from_std(file);
    let mut length = ReceivedLength::new(declared);
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| interrupted_upload())?;
        length.add(chunk.len())?;
        file.write_all(&chunk)
            .await
            .map_err(|_| DriveError::UpstreamFailure)?;
    }
    file.flush()
        .await
        .map_err(|_| DriveError::UpstreamFailure)?;
    length.finish()
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
        content_length: Option<u64>,
        body: UploadBody,
    ) -> Result<(), DriveError> {
        // 1–2. The capability and the headers, before a byte is pulled.
        let first = {
            let _guard = self.lock.lock().await;
            self.live_session(token)?.1
        };
        refuse_before_body(first.size_bytes, &first.mime, mime, content_length)?;

        // 3. The body, into a private file — outside the lock, so one slow
        // upload never holds up another — and refused at the first byte too
        // many. A refusal here stores nothing and spends nothing.
        let part = PartFile(
            self.root
                .join(INCOMING_DIR)
                .join(format!("{}.{PART_SUFFIX}", Uuid::new_v4())),
        );
        let measured = stream_into(&part.0, body, first.size_bytes).await?;

        // 4. Checked again, spent, published — one critical section. `part`
        // removes the body file on the way out unless the publish moved it.
        let _guard = self.lock.lock().await;
        self.spend_and_publish(token, &first, &part.0, measured)
    }
}

impl LocalDriveArchive {
    /// The session file behind `token`, if it can still accept an upload. One
    /// that cannot — expired, written before #2615, or its object (or either
    /// half of it) already landed — is forgotten with its refusal, and the
    /// refusal is the unknown-token one. Called under the lock.
    fn live_session(&self, token: &str) -> Result<(PathBuf, PendingSession), DriveError> {
        let session = session_path(&self.root, token)?;
        let raw = fs::read(&session).map_err(|_| DriveError::FileNotFound)?;
        let pending: PendingSession =
            serde_json::from_slice(&raw).map_err(|_| DriveError::FileNotFound)?;
        let object = object_path(&self.root, &pending.file_id)?;
        let meta = meta_path(&self.root, &pending.file_id)?;
        let landed = object.exists() || meta.exists();
        if pending.expired(epoch_ms_now()) || landed {
            let _ = fs::remove_file(&session);
            return Err(DriveError::FileNotFound);
        }
        Ok((session, pending))
    }

    /// Step 4, under the lock. The capability is read again — a concurrent PUT
    /// may have spent it, or it may have expired while the body arrived — and
    /// spent **before** the bytes become readable. The other order leaves a
    /// window (a failed delete, a crash) in which the bytes have landed and the
    /// URL still opens; this one fails closed: a storage failure costs the
    /// client a new session, which is how every client retries.
    fn spend_and_publish(
        &self,
        token: &str,
        first: &PendingSession,
        part: &Path,
        measured: i64,
    ) -> Result<(), DriveError> {
        let (session, pending) = self.live_session(token)?;
        if pending.file_id != first.file_id {
            // The session file changed under the body: not the capability the
            // body was checked against.
            return Err(DriveError::FileNotFound);
        }
        if let Some(error) = uploaded_size_refusal(pending.size_bytes, measured) {
            return Err(error);
        }
        let object = object_path(&self.root, &pending.file_id)?;
        let meta = meta_path(&self.root, &pending.file_id)?;
        let stored = StoredMeta {
            name: pending.name,
            mime: pending.mime,
            size_bytes: measured,
        };
        let meta_bytes = serde_json::to_vec(&stored).map_err(|_| DriveError::UpstreamFailure)?;
        let meta_part = part.with_extension("meta");
        write_new(&meta_part, &meta_bytes)?;
        if fs::remove_file(&session).is_err() {
            let _ = fs::remove_file(&meta_part);
            return Err(DriveError::UpstreamFailure);
        }
        // Metadata first, then the object. A reader needs both, so neither half
        // is readable alone; a failure takes back only what this call placed —
        // the landed check proved both paths empty a moment ago, under the lock.
        if let Err(error) = publish(&meta_part, &meta) {
            let _ = fs::remove_file(&meta_part);
            return Err(error);
        }
        if let Err(error) = publish(part, &object) {
            let _ = fs::remove_file(&meta);
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body delivered in one chunk — what the route hands over for a small
    /// upload once the transport has it.
    fn body(bytes: &[u8]) -> UploadBody {
        let chunk = Bytes::copy_from_slice(bytes);
        futures::stream::once(async move { Ok(chunk) }).boxed()
    }
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
            .accept_stub_upload(
                &token_from(&session),
                Some("text/plain"),
                None,
                body(b"hello"),
            )
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
            .accept_stub_upload(&token_from(&session), None, None, body(&[0u8; 8]))
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
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
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
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"too long"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("image/png"), None, body(b"hello"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(
            archive
                .accept_stub_upload(
                    "00000000-0000-4000-8000-000000000000",
                    None,
                    None,
                    body(b"hello")
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
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");
        assert!(
            !session_file(&archive, &token).exists(),
            "the upload that landed spent the session: its file is gone"
        );

        // Same mime, same length: the only shape the old checks let through.
        let replay = archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"HACKD"))
            .await;
        let now_stored = stored_bytes(&archive, &session.drive_file_id).await;
        assert_eq!(
            (replay, String::from_utf8_lossy(&now_stored).into_owned()),
            (Err(DriveError::FileNotFound), "hello".to_string()),
            "a spent capability must answer not-found and leave the landed bytes alone"
        );
        // A fresh process over the same volume must not find it either.
        let reopened = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("reopen");
        assert_eq!(
            reopened
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"HACKD"))
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
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");
        archive
            .delete(&session.drive_file_id)
            .await
            .expect("janitor delete");
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"HACKD"))
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
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("first upload");

        fs::write(session_file(&archive, &token), &saved).expect("restore session file");
        edit_session(&archive, &token, |value| {
            value["expires_at_ms"] = serde_json::json!(epoch_ms_now() + 3_600_000);
        });
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"HACKD"))
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
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
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
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
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
                .accept_stub_upload(
                    &token_from(&session),
                    Some("text/plain"),
                    None,
                    body(b"hello")
                )
                .await
                .expect_err("expired on arrival"),
            DriveError::FileNotFound
        );
    }

    fn incoming(archive: &LocalDriveArchive) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(archive.root.join(INCOMING_DIR))
            .expect("incoming dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Fail closed, first half: the capability is spent before the bytes are
    /// readable, so a publish that fails outright leaves neither a live URL
    /// nor anything readable. Forced by making `objects/` unwritable after the
    /// session exists.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_publish_spends_the_capability_and_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let objects = archive.root.join(OBJECTS_DIR);
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o555)).expect("read-only");
        if fs::write(objects.join("probe"), b"x").is_ok() {
            // Running as root: permissions do not bind, so this proof cannot
            // be made here. Say so rather than pass vacuously.
            let _ = fs::remove_file(objects.join("probe"));
            fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).expect("restore");
            eprintln!("skipped: permissions do not bind for this user (root)");
            return;
        }
        let refused = archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await;
        fs::set_permissions(&objects, fs::Permissions::from_mode(0o755)).expect("restore");

        assert_eq!(refused, Err(DriveError::UpstreamFailure));
        assert!(
            !session_file(&archive, &token).exists(),
            "the session was spent before the bytes were published"
        );
        assert_eq!(
            fs::read_dir(&objects).expect("objects").count(),
            0,
            "nothing half-landed stays behind"
        );
        assert_eq!(
            incoming(&archive),
            Vec::<String>::new(),
            "no partial file stays behind"
        );
        assert_eq!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
                .await
                .expect_err("the client starts a new session"),
            DriveError::FileNotFound
        );
    }

    /// Fail closed, second half: metadata was published and the object then
    /// failed, so the metadata is taken back. Forced by unlinking the body's
    /// file while it is still being written, so the final rename finds nothing.
    #[tokio::test]
    async fn a_publish_that_fails_halfway_takes_back_the_first_half() {
        let (dir, _guard) = temp_root();
        let archive = std::sync::Arc::new(
            LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open"),
        );
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let (sender, receiver) =
            futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let upload = {
            let archive = archive.clone();
            let token = token.clone();
            tokio::spawn(async move {
                archive
                    .accept_stub_upload(&token, Some("text/plain"), None, receiver.boxed())
                    .await
            })
        };
        sender
            .unbounded_send(Ok(Bytes::from_static(b"hel")))
            .expect("send");
        let part = wait_for_part(&archive, 3).await;
        fs::remove_file(&part).expect("unlink the body mid-write");
        sender
            .unbounded_send(Ok(Bytes::from_static(b"lo")))
            .expect("send");
        drop(sender);

        assert_eq!(
            upload.await.expect("task"),
            Err(DriveError::UpstreamFailure)
        );
        let objects = archive.root.join(OBJECTS_DIR);
        assert!(
            !objects
                .join(format!("{}{META_SUFFIX}", session.drive_file_id))
                .exists(),
            "the metadata published before the failure was taken back"
        );
        assert!(!objects.join(&session.drive_file_id).exists());
        assert!(!session_file(&archive, &token).exists(), "spent");
        assert_eq!(incoming(&archive), Vec::<String>::new());
    }

    /// Wait until exactly one body file under `incoming/` holds `len` bytes.
    async fn wait_for_part(archive: &LocalDriveArchive, len: u64) -> PathBuf {
        for _ in 0..500 {
            if let Some(entry) = fs::read_dir(archive.root.join(INCOMING_DIR))
                .expect("incoming dir")
                .flatten()
                .find(|entry| entry.file_name().to_string_lossy().ends_with(PART_SUFFIX))
            {
                if entry.metadata().is_ok_and(|meta| meta.len() == len) {
                    return entry.path();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!(
            "no body file under incoming/ reached {len} bytes while the body was still open: {:?}",
            incoming(archive)
        );
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
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"too long"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("image/png"), None, body(b"hello"))
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the corrected upload lands");
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"hello"
        );
    }

    // ---- #2628: nothing is read that could not be accepted -----------------

    /// A body that records whether anything ever asked it for a byte.
    fn tripwire() -> (UploadBody, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let pulled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = pulled.clone();
        let stream = futures::stream::poll_fn(move |_| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            std::task::Poll::Ready(None)
        })
        .boxed();
        (stream, pulled)
    }

    fn pulled(flag: &std::sync::atomic::AtomicBool) -> bool {
        flag.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Every capability the archive refuses is refused before the body is
    /// touched: unknown, spent, expired, written before #2615, and one whose
    /// object — or either half of it — already landed. The last two also pin
    /// the landed check to "either half", not "both" (#2624 review S2).
    #[tokio::test]
    async fn an_unusable_capability_never_pulls_a_byte() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let mut cases: Vec<(&str, String, Option<PathBuf>)> = vec![(
            "unknown",
            "00000000-0000-4000-8000-000000000000".into(),
            None,
        )];

        let spent = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        archive
            .accept_stub_upload(
                &token_from(&spent),
                Some("text/plain"),
                None,
                body(b"hello"),
            )
            .await
            .expect("first upload");
        cases.push(("spent", token_from(&spent), None));

        let expired = archive
            .create_resumable_upload(Uuid::nil(), "b.txt", "text/plain", 5)
            .await
            .expect("session");
        edit_session(&archive, &token_from(&expired), |value| {
            value["expires_at_ms"] = serde_json::json!(epoch_ms_now() - 1);
        });
        cases.push(("expired", token_from(&expired), None));

        let legacy = archive
            .create_resumable_upload(Uuid::nil(), "c.txt", "text/plain", 5)
            .await
            .expect("session");
        edit_session(&archive, &token_from(&legacy), |value| {
            value
                .as_object_mut()
                .expect("object")
                .remove("expires_at_ms");
        });
        cases.push(("written before #2615", token_from(&legacy), None));

        let objects = archive.root.join(OBJECTS_DIR);
        let object_only = archive
            .create_resumable_upload(Uuid::nil(), "d.txt", "text/plain", 5)
            .await
            .expect("session");
        let half = objects.join(&object_only.drive_file_id);
        fs::write(&half, b"first").expect("object without metadata");
        cases.push((
            "object landed without metadata",
            token_from(&object_only),
            Some(half),
        ));

        let meta_only = archive
            .create_resumable_upload(Uuid::nil(), "e.txt", "text/plain", 5)
            .await
            .expect("session");
        let half = objects.join(format!("{}{META_SUFFIX}", meta_only.drive_file_id));
        fs::write(&half, b"first").expect("metadata without object");
        cases.push((
            "metadata landed without object",
            token_from(&meta_only),
            Some(half),
        ));

        for (label, token, landed_half) in cases {
            let (stream, flag) = tripwire();
            assert_eq!(
                archive
                    .accept_stub_upload(&token, Some("text/plain"), Some(5), stream)
                    .await,
                Err(DriveError::FileNotFound),
                "{label}"
            );
            assert!(
                !pulled(&flag),
                "{label}: the body was pulled before the refusal"
            );
            assert!(
                !session_file(&archive, &token).exists(),
                "{label}: a refused capability is forgotten"
            );
            if let Some(half) = landed_half {
                assert_eq!(
                    fs::read(&half).expect("half"),
                    b"first",
                    "{label}: untouched"
                );
            }
        }
        assert_eq!(incoming(&archive), Vec::<String>::new());
    }

    /// What the headers announce is refused before the body, and such a
    /// refusal leaves the capability usable.
    #[tokio::test]
    async fn a_header_refusal_never_pulls_a_byte_and_keeps_the_capability() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        for (label, mime, length, expected) in [
            (
                "over the ceiling",
                Some("text/plain"),
                Some(MAX_ATTACHMENT_BYTES as u64 + 1),
                "413",
            ),
            (
                "not the declared length",
                Some("text/plain"),
                Some(6),
                "400",
            ),
            ("not the declared mime", Some("image/png"), Some(5), "400"),
        ] {
            let (stream, flag) = tripwire();
            let refused = archive
                .accept_stub_upload(&token, mime, length, stream)
                .await
                .expect_err(label);
            let status = match refused {
                DriveError::ContentTooLarge => "413",
                DriveError::InvalidArguments(_) => "400",
                _ => "other",
            };
            assert_eq!(status, expected, "{label}: {refused:?}");
            assert!(
                !pulled(&flag),
                "{label}: the body was pulled before the refusal"
            );
            assert!(
                session_file(&archive, &token).exists(),
                "{label}: not spent"
            );
        }
        archive
            .accept_stub_upload(&token, Some("text/plain"), Some(5), body(b"hello"))
            .await
            .expect("the capability survived every header refusal");
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"hello"
        );
    }

    /// The body reaches the disk while it is still arriving: the first chunk is
    /// in `incoming/` before the second is sent. An archive that gathered the
    /// body in memory first would never show it there and this would time out.
    #[tokio::test]
    async fn the_body_is_written_to_disk_as_it_arrives() {
        let (dir, _guard) = temp_root();
        let archive = std::sync::Arc::new(
            LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open"),
        );
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.bin", "application/octet-stream", 0)
            .await
            .expect("session");
        let token = token_from(&session);
        let (sender, receiver) =
            futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let upload = {
            let archive = archive.clone();
            let token = token.clone();
            tokio::spawn(async move {
                archive
                    .accept_stub_upload(&token, None, None, receiver.boxed())
                    .await
            })
        };
        let first = Bytes::from(vec![7u8; 64 * 1024]);
        sender.unbounded_send(Ok(first.clone())).expect("send");
        wait_for_part(&archive, first.len() as u64).await;
        sender
            .unbounded_send(Ok(Bytes::from_static(b"tail")))
            .expect("send");
        drop(sender);

        upload
            .await
            .expect("task")
            .expect("the streamed body lands");
        let mut expected = first.to_vec();
        expected.extend_from_slice(b"tail");
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            expected
        );
        assert_eq!(incoming(&archive), Vec::<String>::new());
    }

    /// A body is not read past the byte that makes it unacceptable, and what
    /// was read is not kept.
    #[tokio::test]
    async fn a_body_past_its_declaration_is_refused_at_the_first_extra_byte() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let (rest, flag) = tripwire();
        let stream = futures::stream::once(async { Ok(Bytes::from_static(b"hello!")) })
            .chain(rest)
            .boxed();
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), None, stream)
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert!(
            !pulled(&flag),
            "the body was read past the first extra byte"
        );
        assert_eq!(incoming(&archive), Vec::<String>::new());
        assert!(session_file(&archive, &token).exists(), "not spent");
    }

    /// An undeclared body is cut at the ceiling: the byte after 100 MB is the
    /// last one read, and none of it is kept. Chunked transfers carry no
    /// Content-Length, so this is the only ceiling they meet.
    #[tokio::test]
    async fn a_body_over_the_ceiling_is_refused_without_reading_further() {
        static MIB: [u8; 1024 * 1024] = [0u8; 1024 * 1024];
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "big.bin", "application/octet-stream", 0)
            .await
            .expect("session");
        let token = token_from(&session);
        let chunks = (MAX_ATTACHMENT_BYTES as usize) / MIB.len();
        let (rest, flag) = tripwire();
        let stream = futures::stream::iter(
            std::iter::repeat_n(Bytes::from_static(&MIB), chunks)
                .chain(std::iter::once(Bytes::from_static(b"!")))
                .map(Ok),
        )
        .chain(rest)
        .boxed();
        assert_eq!(
            archive.accept_stub_upload(&token, None, None, stream).await,
            Err(DriveError::ContentTooLarge)
        );
        assert!(!pulled(&flag), "the body was read past the ceiling");
        assert_eq!(incoming(&archive), Vec::<String>::new());
        assert!(session_file(&archive, &token).exists(), "not spent");
    }

    /// A body the client broke off stores nothing and spends nothing.
    #[tokio::test]
    async fn an_interrupted_body_leaves_nothing_and_keeps_the_capability() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let broken = futures::stream::iter([
            Ok(Bytes::from_static(b"he")),
            Err(std::io::Error::other("connection reset")),
        ])
        .boxed();
        assert!(matches!(
            archive
                .accept_stub_upload(&token, Some("text/plain"), None, broken)
                .await,
            Err(DriveError::InvalidArguments(_))
        ));
        assert_eq!(incoming(&archive), Vec::<String>::new());
        assert_eq!(
            archive
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("nothing landed"),
            DriveError::FileNotFound
        );
        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the capability is still live");
    }

    /// Two PUTs racing one capability: the body that finishes first spends it;
    /// the other is refused at its commit and keeps nothing.
    #[tokio::test]
    async fn a_second_upload_racing_the_first_loses_at_commit() {
        let (dir, _guard) = temp_root();
        let archive = std::sync::Arc::new(
            LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open"),
        );
        let session = archive
            .create_resumable_upload(Uuid::nil(), "a.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let (sender, receiver) =
            futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let slow = {
            let archive = archive.clone();
            let token = token.clone();
            tokio::spawn(async move {
                archive
                    .accept_stub_upload(&token, Some("text/plain"), None, receiver.boxed())
                    .await
            })
        };
        sender
            .unbounded_send(Ok(Bytes::from_static(b"slow!")))
            .expect("send");
        wait_for_part(&archive, 5).await;

        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"fast!"))
            .await
            .expect("the body that finishes first lands");
        drop(sender);
        assert_eq!(
            slow.await.expect("task"),
            Err(DriveError::FileNotFound),
            "the capability was spent while this body was still arriving"
        );
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"fast!"
        );
        assert_eq!(incoming(&archive), Vec::<String>::new());
    }

    /// Opening the archive clears what a previous process left pending —
    /// sessions, bodies being received, interrupted writes — and nothing that
    /// landed.
    #[tokio::test]
    async fn open_clears_pending_sessions_and_partial_writes_but_keeps_objects() {
        let (dir, _guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let landed = archive
            .create_resumable_upload(Uuid::nil(), "kept.txt", "text/plain", 5)
            .await
            .expect("session");
        archive
            .accept_stub_upload(
                &token_from(&landed),
                Some("text/plain"),
                None,
                body(b"hello"),
            )
            .await
            .expect("upload");
        let pending = archive
            .create_resumable_upload(Uuid::nil(), "pending.txt", "text/plain", 5)
            .await
            .expect("session");
        let root = archive.root.clone();
        let debris = [
            root.join(SESSIONS_DIR)
                .join(format!("{}{TMP_SUFFIX}", token_from(&pending))),
            root.join(INCOMING_DIR)
                .join(format!("{}.{PART_SUFFIX}", Uuid::new_v4())),
            root.join(INCOMING_DIR)
                .join(format!("{}.meta", Uuid::new_v4())),
            root.join(OBJECTS_DIR)
                .join(format!("{}{TMP_SUFFIX}", pending.drive_file_id)),
            root.join(OBJECTS_DIR).join(format!(
                "{}{META_SUFFIX}{TMP_SUFFIX}",
                pending.drive_file_id
            )),
        ];
        for path in &debris {
            fs::write(path, b"debris").expect("debris");
        }
        drop(archive);

        let reopened = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("reopen");
        assert_eq!(
            fs::read_dir(root.join(SESSIONS_DIR))
                .expect("sessions")
                .count(),
            0,
            "no pending session survives the restart"
        );
        for path in &debris {
            assert!(!path.exists(), "{} survived", path.display());
        }
        assert_eq!(
            stored_bytes(&reopened, &landed.drive_file_id).await,
            b"hello"
        );
        assert_eq!(
            reopened
                .accept_stub_upload(
                    &token_from(&pending),
                    Some("text/plain"),
                    None,
                    body(b"hello")
                )
                .await,
            Err(DriveError::FileNotFound),
            "the client restarts with a new session"
        );
    }

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).expect("mkdir");
        for entry in fs::read_dir(from).expect("read_dir").flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().expect("type").is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), &target).expect("copy");
            }
        }
    }

    /// **Red proof (#2628, review of #2624 R11).** A crash-consistent snapshot
    /// of the volume taken between a session's creation and its upload holds
    /// the session and no object. Restored within the hour — PostgreSQL left
    /// as it was, the attachment `complete` — the URL used to accept a second
    /// body for that file id: nothing had landed, and the deadline had not
    /// passed. Opening the restored volume clears it.
    #[tokio::test]
    async fn a_volume_restored_with_a_live_session_does_not_reopen_it() {
        let (dir, _guard) = temp_root();
        let (snapshot, _snapshot_guard) = temp_root();
        let archive = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open");
        let session = archive
            .create_resumable_upload(Uuid::nil(), "contract.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let root = archive.root.clone();
        copy_tree(&root, &snapshot);
        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the upload the room saw");
        drop(archive);

        fs::remove_dir_all(&root).expect("lose the volume");
        copy_tree(&snapshot, &root);
        let restored = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("reopen");
        assert_eq!(
            restored
                .accept_stub_upload(&token, Some("text/plain"), None, body(b"EVIL!"))
                .await,
            Err(DriveError::FileNotFound),
            "a restored session must not accept a second body for a completed file id"
        );
        assert_eq!(
            restored
                .file_metadata(&session.drive_file_id)
                .await
                .expect_err("nothing landed after the restore"),
            DriveError::FileNotFound
        );
    }

    // ---- #2631 review: R10 (cancelled uploads) and R11 (linked directories) --

    /// **Red proof (#2631 review R10).** A request cancelled mid-body — its
    /// future dropped, not an error the archive sees — leaves no body file in
    /// `incoming/` and spends nothing: the same URL still takes the upload.
    #[tokio::test]
    async fn a_dropped_upload_leaves_no_part_behind_and_spends_nothing() {
        let (dir, _guard) = temp_root();
        let archive = std::sync::Arc::new(
            LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("open"),
        );
        let session = archive
            .create_resumable_upload(Uuid::nil(), "note.txt", "text/plain", 5)
            .await
            .expect("session");
        let token = token_from(&session);
        let (sender, receiver) =
            futures::channel::mpsc::unbounded::<Result<Bytes, std::io::Error>>();
        let upload = {
            let archive = archive.clone();
            let token = token.clone();
            tokio::spawn(async move {
                archive
                    .accept_stub_upload(&token, Some("text/plain"), None, receiver.boxed())
                    .await
            })
        };
        sender
            .unbounded_send(Ok(Bytes::from_static(b"hel")))
            .expect("send");
        wait_for_part(&archive, 3).await;

        upload.abort();
        assert!(
            upload.await.expect_err("cancelled").is_cancelled(),
            "the upload future was dropped, not finished"
        );
        drop(sender);
        let mut left = incoming(&archive);
        for _ in 0..100 {
            if left.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            left = incoming(&archive);
        }
        assert_eq!(
            left,
            Vec::<String>::new(),
            "#2631: a cancelled upload left its body file behind"
        );
        archive
            .accept_stub_upload(&token, Some("text/plain"), None, body(b"hello"))
            .await
            .expect("the cancelled upload spent nothing");
        assert_eq!(
            stored_bytes(&archive, &session.drive_file_id).await,
            b"hello"
        );
    }

    /// **Red proof (#2631 review R11).** Opening the archive clears every file
    /// in `sessions/` and `incoming/`. Either one being a symlink would clear
    /// another directory's files through it, so it is a boot error instead —
    /// and the files behind the link are untouched.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_sessions_or_incoming_directory_is_refused_at_boot() {
        for linked in [SESSIONS_DIR, INCOMING_DIR] {
            let (dir, _guard) = temp_root();
            let root = dir.join("archive");
            let elsewhere = dir.join("elsewhere");
            fs::create_dir_all(&root).expect("root");
            fs::create_dir_all(&elsewhere).expect("elsewhere");
            let precious = elsewhere.join("precious");
            fs::write(&precious, b"not the archive's").expect("precious");
            std::os::unix::fs::symlink(&elsewhere, root.join(linked)).expect("symlink");

            assert!(
                prepare_local_dir(root.to_str().expect("utf8")).is_err(),
                "{linked}: a linked directory must be a boot error"
            );
            assert_eq!(
                LocalDriveArchive::open(root.to_str(), "http://127.0.0.1:9").expect_err("refused"),
                DriveError::Unavailable,
                "{linked}"
            );
            assert_eq!(
                fs::read(&precious).expect("still there"),
                b"not the archive's",
                "#2631: {linked}: the start-up clearing reached through the link"
            );
        }
    }
}
