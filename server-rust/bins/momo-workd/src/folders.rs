//! The folders this host issues (ADR-0188 D6, #3590): an opaque id and a name
//! to show for each folder a remote session may open, and nothing else leaves
//! the Mac.
//!
//! ## What this slice does and does not do
//!
//! * **Issues and announces.** Each folder gets a random id the first time it
//!   is seen and keeps it across restarts (`folders.json` beside the host
//!   state, `0600`, the one place the id → path map lives). The id + display
//!   name + kind are sent in the signed heartbeat body; the **path is never
//!   sent**, logged, or put in an error.
//! * **Resolves a signed spawn's folder id here, and only here** (T5, #3570).
//!   The server never knows a path: a new-work spawn carries the opaque id the
//!   owner signed, and [`FolderBook::resolve_for_spawn`] turns it into a
//!   directory on this Mac at **every** spawn — unknown id, a folder that now
//!   resolves somewhere else, or a 「질문용 폴더」 that is no longer a real
//!   0700 directory of this user, is a refusal, never a quiet fallback to
//!   `working_directory`.
//! * **A damaged record is an error, not an empty one** (N5 L5).
//!   `folders.json` that does not parse, or that holds an id which could not
//!   have been issued, stops the host from starting with a sentence that
//!   names no path; the owner moves the file aside to have the ids reissued,
//!   and an old id a client still holds is then refused (it is unknown).
//!
//! ## The two kinds
//!
//! * `project` — the folder the owner allowed (`working_directory`), named by
//!   `working_directory_name` or the folder's own last component.
//! * `question` — 「질문용 폴더」: an empty folder the host makes under its own
//!   state folder, for a question that needs no project (ADR-0198 증보 1 D7). It
//!   is the default when a request names no folder.

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{read_owned_file, write_private_file, ConfigError};
use crate::policy::Refusal;

/// Where the id → path map is kept, in the host state folder.
pub const FOLDERS_FILE: &str = "folders.json";
/// The 「질문용 폴더」 itself, in the host state folder.
pub const QUESTION_FOLDER_DIR: &str = "question-folder";
/// Shown for the 「질문용 폴더」.
pub const QUESTION_FOLDER_NAME: &str = "질문용 폴더";
/// Shown for a project folder whose own name cannot be shown.
pub const FALLBACK_PROJECT_NAME: &str = "프로젝트 폴더";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderKind {
    Project,
    Question,
}

impl FolderKind {
    fn wire(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Question => "question",
        }
    }
}

/// One issued folder. `path` stays on this Mac.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedFolder {
    pub id: String,
    pub display_name: String,
    pub kind: FolderKind,
    path: PathBuf,
    /// `realpath` of the folder when it was issued (this run). A spawn resolves
    /// it again and the two must agree (ADR-0188 D6: 「매 spawn마다 `realpath`로
    /// 대조」); `None` when it did not resolve then.
    canonical: Option<PathBuf>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    /// Canonical-or-configured path → id. A path that is no longer a folder of
    /// this host drops out on the next [`FolderBook::open`].
    #[serde(default)]
    ids: BTreeMap<String, String>,
}

/// The folders this host issues, in announcement order (project, then question).
#[derive(Debug, Clone)]
pub struct FolderBook {
    folders: Vec<IssuedFolder>,
    /// The host state folder the 「질문용 폴더」 lives under.
    state_folder: PathBuf,
}

/// An id this host could have issued (`fld_` + 20 hex, or the server's closed
/// alphabet at its widest): anything else in the record is damage.
fn id_is_plausible(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What the owner is told when the record cannot be trusted. No path in it.
const DAMAGED_RECORD: &str = "the host's folder record is damaged or inconsistent; move it aside \
    (remove folders.json from the host state folder) and restart to have folder ids reissued";

/// A name the server will accept (1…80 characters, no path separator or control
/// character), made from `raw`; `None` when nothing presentable is left.
pub fn presentable_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if momo_wire::folder_name::is_forbidden_name_char(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(80).collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn new_id() -> String {
    format!("fld_{}", &uuid::Uuid::new_v4().simple().to_string()[..20])
}

impl FolderBook {
    /// Issue (or recall) the host's folders. Creates the question folder `0700`
    /// when it is missing and rewrites `folders.json` when the set changed.
    pub fn open(
        state_folder: &Path,
        working_directory: &Path,
        working_directory_name: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let file = state_folder.join(FOLDERS_FILE);
        let stored: Stored = match read_owned_file(&file) {
            // N5 L5: damage is an error. It used to read as an empty map and
            // quietly issue new ids; a signed spawn that resolves ids to paths
            // must not run on a record nobody can vouch for.
            Ok(raw) => {
                let stored: Stored = serde_json::from_str(&raw)
                    .map_err(|_| ConfigError::Invalid(DAMAGED_RECORD.to_string()))?;
                let mut seen = BTreeSet::new();
                for id in stored.ids.values() {
                    if !id_is_plausible(id) || !seen.insert(id.as_str()) {
                        return Err(ConfigError::Invalid(DAMAGED_RECORD.to_string()));
                    }
                }
                stored
            }
            Err(ConfigError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                Stored::default()
            }
            Err(error) => return Err(error),
        };

        let question_path = state_folder.join(QUESTION_FOLDER_DIR);
        make_private_dir(&question_path).map_err(|source| ConfigError::Io {
            path: question_path.display().to_string(),
            source,
        })?;
        // N5 L3: whatever stood there already must be this user's own real
        // 0700 directory (reset to 0700 when only the mode drifted).
        check_question_folder(&question_path, state_folder).map_err(|_| {
            ConfigError::Invalid(
                "the host's question folder is not a private directory of this user".to_string(),
            )
        })?;

        let project_name = working_directory_name
            .and_then(presentable_name)
            .or_else(|| {
                working_directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(presentable_name)
            })
            .unwrap_or_else(|| FALLBACK_PROJECT_NAME.to_string());

        let mut ids = BTreeMap::new();
        let mut folders = Vec::new();
        for (path, name, kind) in [
            (working_directory, project_name, FolderKind::Project),
            (
                question_path.as_path(),
                QUESTION_FOLDER_NAME.to_string(),
                FolderKind::Question,
            ),
        ] {
            let key = path.to_string_lossy().into_owned();
            let id = stored.ids.get(&key).cloned().unwrap_or_else(new_id);
            ids.insert(key, id.clone());
            folders.push(IssuedFolder {
                id,
                display_name: name,
                kind,
                path: path.to_path_buf(),
                canonical: std::fs::canonicalize(path).ok(),
            });
        }
        if ids != stored.ids {
            let body = serde_json::to_vec_pretty(&Stored { ids }).expect("map serialises");
            write_private_file(&file, &body)?;
        }
        Ok(Self {
            folders,
            state_folder: state_folder.to_path_buf(),
        })
    }

    pub fn folders(&self) -> &[IssuedFolder] {
        &self.folders
    }

    /// The heartbeat body: ids, names and kinds only.
    pub fn announcement(&self) -> Value {
        json!({
            "folders": self.folders.iter().map(|folder| json!({
                "id": folder.id,
                "displayName": folder.display_name,
                "kind": folder.kind.wire(),
            })).collect::<Vec<_>>()
        })
    }

    /// The path an id was issued for. A lookup only: a spawn goes through
    /// [`Self::resolve_for_spawn`].
    pub fn resolve(&self, id: &str) -> Option<&Path> {
        self.folders
            .iter()
            .find(|folder| folder.id == id)
            .map(|folder| folder.path.as_path())
    }

    /// T5 (#3570): the directory a signed new-work spawn runs in, resolved on
    /// this Mac at this spawn and nowhere else.
    ///
    /// * an id this host never issued → [`Refusal::FolderUnknown`] (also an old
    ///   id after a reissue);
    /// * `project`: `realpath` now must be a directory **and** the one the
    ///   folder resolved to when it was issued — a link retargeted since is
    ///   [`Refusal::FolderUnsafe`], not followed;
    /// * `question`: the folder must still be a real 0700 directory of this
    ///   user under the state folder (N5 L3), and the task gets a **fresh
    ///   0700 subfolder of its own** (named by the control), so one question's
    ///   files are not the next one's.
    pub fn resolve_for_spawn(&self, id: &str, control_id: uuid::Uuid) -> Result<PathBuf, Refusal> {
        let folder = self
            .folders
            .iter()
            .find(|folder| folder.id == id)
            .ok_or(Refusal::FolderUnknown)?;
        match folder.kind {
            FolderKind::Project => {
                let now = std::fs::canonicalize(&folder.path)
                    .ok()
                    .filter(|path| path.is_dir())
                    .ok_or(Refusal::WorkdirUnavailable)?;
                if folder.canonical.as_deref() != Some(now.as_path()) {
                    return Err(Refusal::FolderUnsafe);
                }
                Ok(now)
            }
            FolderKind::Question => {
                let base = check_question_folder(&folder.path, &self.state_folder)?;
                let task = base.join(format!("t-{}", control_id.simple()));
                match std::fs::DirBuilder::new().mode_0700().create(&task) {
                    Ok(()) => {}
                    // T5 review L-3: a task's folder is made for it and never
                    // reused — one that is already there (planted, or left by
                    // an earlier run) is not a fresh private folder.
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        return Err(Refusal::FolderUnsafe)
                    }
                    Err(_) => return Err(Refusal::WorkdirUnavailable),
                }
                let meta = std::fs::symlink_metadata(&task).map_err(|_| Refusal::FolderUnsafe)?;
                let canonical = std::fs::canonicalize(&task).map_err(|_| Refusal::FolderUnsafe)?;
                if meta.file_type().is_symlink()
                    || !meta.is_dir()
                    || meta.uid() != euid()
                    || !canonical.starts_with(&base)
                {
                    return Err(Refusal::FolderUnsafe);
                }
                Ok(canonical)
            }
        }
    }
}

fn euid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

trait DirBuilderExt0700 {
    fn mode_0700(&mut self) -> &mut Self;
}

impl DirBuilderExt0700 for std::fs::DirBuilder {
    fn mode_0700(&mut self) -> &mut Self {
        use std::os::unix::fs::DirBuilderExt;
        self.mode(0o700)
    }
}

/// N5 L3: the 「질문용 폴더」 is this user's own real directory, mode 0700, at
/// the place the state folder says. Never followed through a link (checked with
/// `symlink_metadata`), re-made when it is missing, put back to 0700 when only
/// its mode drifted, and refused for anything else. Returns its canonical path.
fn check_question_folder(path: &Path, state_folder: &Path) -> Result<PathBuf, Refusal> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            make_private_dir(path).map_err(|_| Refusal::WorkdirUnavailable)?;
            std::fs::symlink_metadata(path).map_err(|_| Refusal::WorkdirUnavailable)?
        }
        Err(_) => return Err(Refusal::WorkdirUnavailable),
    };
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != euid() {
        return Err(Refusal::FolderUnsafe);
    }
    if meta.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| Refusal::FolderUnsafe)?;
        let again = std::fs::symlink_metadata(path).map_err(|_| Refusal::FolderUnsafe)?;
        if again.mode() & 0o777 != 0o700 || again.file_type().is_symlink() {
            return Err(Refusal::FolderUnsafe);
        }
    }
    // The place itself: the state folder's own `question-folder`, however the
    // path to it was spelled.
    let canonical = std::fs::canonicalize(path).map_err(|_| Refusal::FolderUnsafe)?;
    let expected = std::fs::canonicalize(state_folder)
        .map_err(|_| Refusal::FolderUnsafe)?
        .join(QUESTION_FOLDER_DIR);
    if canonical != expected {
        return Err(Refusal::FolderUnsafe);
    }
    Ok(canonical)
}

fn make_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn state() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("momo-folders-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn ids_are_issued_once_and_survive_a_restart() {
        let dir = state();
        let project = Path::new("/Users/someone/projects/momo");
        let first = FolderBook::open(&dir, project, None).unwrap();
        let again = FolderBook::open(&dir, project, None).unwrap();
        assert_eq!(first.announcement(), again.announcement());
        assert_eq!(first.folders().len(), 2);
        assert!(dir.join(QUESTION_FOLDER_DIR).is_dir());
        let mode = std::fs::metadata(dir.join(QUESTION_FOLDER_DIR))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "the question folder is the owner's alone");
        // A different folder gets a different id; the old one is forgotten.
        let other =
            FolderBook::open(&dir, Path::new("/Users/someone/projects/other"), None).unwrap();
        assert_ne!(other.folders()[0].id, first.folders()[0].id);
        assert_eq!(
            other.folders()[1].id,
            first.folders()[1].id,
            "the question folder keeps its id"
        );
    }

    /// The announcement is the whole of what leaves the Mac: no path, however
    /// deep the folder is, and the id is not derived from one.
    #[test]
    fn the_announcement_carries_no_path() {
        let dir = state();
        let project = Path::new("/Users/someone/secret-client/momo");
        let book = FolderBook::open(&dir, project, None).unwrap();
        let wire = book.announcement().to_string();
        assert!(!wire.contains("/Users"), "{wire}");
        assert!(!wire.contains("secret-client"), "{wire}");
        assert!(!wire.contains(dir.to_str().unwrap()), "{wire}");
        assert!(wire.contains("\"momo\""));
        for folder in book.folders() {
            assert!(!folder.id.contains('/') && folder.id.len() <= 64);
        }
        // T5's lookup is local.
        let id = book.folders()[0].id.clone();
        assert_eq!(book.resolve(&id), Some(project));
        assert_eq!(book.resolve("fld_unknown"), None);
    }

    fn real_project(dir: &Path) -> PathBuf {
        let project = dir.join("project-real");
        std::fs::create_dir_all(&project).unwrap();
        project
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    /// T5: an id this host never issued opens nothing — not the configured
    /// folder either.
    #[test]
    fn an_unknown_id_resolves_to_nothing() {
        let dir = state();
        let project = real_project(&dir);
        let book = FolderBook::open(&dir, &project, None).unwrap();
        assert_eq!(
            book.resolve_for_spawn("fld_neverissued00000000", uuid::Uuid::new_v4()),
            Err(Refusal::FolderUnknown)
        );
        assert_eq!(
            book.resolve_for_spawn("", uuid::Uuid::new_v4()),
            Err(Refusal::FolderUnknown)
        );
        let id = book.folders()[0].id.clone();
        let resolved = book.resolve_for_spawn(&id, uuid::Uuid::new_v4()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&project).unwrap());
    }

    /// N5 L3: the 「질문용 폴더」 replaced by a link is never followed.
    #[test]
    fn a_question_folder_that_became_a_symlink_is_refused() {
        let dir = state();
        let project = real_project(&dir);
        let book = FolderBook::open(&dir, &project, None).unwrap();
        let question_id = book.folders()[1].id.clone();
        let elsewhere = dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let question = dir.join(QUESTION_FOLDER_DIR);
        std::fs::remove_dir_all(&question).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &question).unwrap();
        assert_eq!(
            book.resolve_for_spawn(&question_id, uuid::Uuid::new_v4()),
            Err(Refusal::FolderUnsafe)
        );
        assert!(
            std::fs::read_dir(&elsewhere).unwrap().next().is_none(),
            "nothing was made behind the link"
        );
        // And a host cannot start on a link either.
        let error = FolderBook::open(&dir, &project, None)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(dir.to_str().unwrap()), "{error}");
    }

    /// N5 L3: a mode that drifted is put back to 0700; the folder is the same.
    #[test]
    fn a_question_folder_whose_mode_drifted_is_put_back_to_0700() {
        let dir = state();
        let project = real_project(&dir);
        let book = FolderBook::open(&dir, &project, None).unwrap();
        let question_id = book.folders()[1].id.clone();
        let question = dir.join(QUESTION_FOLDER_DIR);
        std::fs::set_permissions(&question, std::fs::Permissions::from_mode(0o755)).unwrap();
        let task = book
            .resolve_for_spawn(&question_id, uuid::Uuid::new_v4())
            .unwrap();
        assert_eq!(mode(&question), 0o700);
        assert_eq!(mode(&task), 0o700);
        assert!(task.starts_with(std::fs::canonicalize(&question).unwrap()));
    }

    /// Each question gets a folder of its own: one question's files are not
    /// the next one's.
    #[test]
    fn each_question_runs_in_a_fresh_private_subfolder() {
        let dir = state();
        let project = real_project(&dir);
        let book = FolderBook::open(&dir, &project, None).unwrap();
        let question_id = book.folders()[1].id.clone();
        let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let first = book.resolve_for_spawn(&question_id, a).unwrap();
        std::fs::write(first.join("left-behind.txt"), b"x").unwrap();
        let second = book.resolve_for_spawn(&question_id, b).unwrap();
        assert_ne!(first, second);
        assert!(std::fs::read_dir(&second).unwrap().next().is_none());
        // L-3: a folder that already exists is never reused — not by a retry,
        // not one somebody planted ahead of the control.
        assert_eq!(
            book.resolve_for_spawn(&question_id, a),
            Err(Refusal::FolderUnsafe)
        );
        let planted = uuid::Uuid::new_v4();
        let base = std::fs::canonicalize(dir.join(QUESTION_FOLDER_DIR)).unwrap();
        std::fs::create_dir(base.join(format!("t-{}", planted.simple()))).unwrap();
        assert_eq!(
            book.resolve_for_spawn(&question_id, planted),
            Err(Refusal::FolderUnsafe)
        );
    }

    /// ADR-0188 D6 「매 spawn마다 realpath로 대조」: a project folder whose
    /// path now resolves elsewhere is not the folder that was issued.
    #[test]
    fn a_project_folder_that_resolves_elsewhere_now_is_refused() {
        let dir = state();
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&a, &link).unwrap();
        let book = FolderBook::open(&dir, &link, None).unwrap();
        let id = book.folders()[0].id.clone();
        assert_eq!(
            book.resolve_for_spawn(&id, uuid::Uuid::new_v4()).unwrap(),
            std::fs::canonicalize(&a).unwrap()
        );
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&b, &link).unwrap();
        assert_eq!(
            book.resolve_for_spawn(&id, uuid::Uuid::new_v4()),
            Err(Refusal::FolderUnsafe)
        );
        std::fs::remove_file(&link).unwrap();
        assert_eq!(
            book.resolve_for_spawn(&id, uuid::Uuid::new_v4()),
            Err(Refusal::WorkdirUnavailable)
        );
    }

    /// N5 L5: a record that does not parse, or holds an id nobody could have
    /// issued, is an error that names no path — not an empty map.
    #[test]
    fn a_damaged_record_is_an_error_and_names_no_path() {
        let project_path = "/Users/someone/secret-client/momo";
        for (what, body) in [
            ("truncated", "{\"ids\": {\"/Users/someone/secret"),
            ("not an object", "[1, 2, 3]"),
            (
                "an id with a separator",
                "{\"ids\": {\"/x\": \"fld_a/../b\"}}",
            ),
            ("an empty id", "{\"ids\": {\"/x\": \"\"}}"),
            (
                "one id for two folders",
                "{\"ids\": {\"/x\": \"fld_same\", \"/y\": \"fld_same\"}}",
            ),
        ] {
            let dir = state();
            write_private_file(&dir.join(FOLDERS_FILE), body.as_bytes()).unwrap();
            let error = FolderBook::open(&dir, Path::new(project_path), None)
                .expect_err(what)
                .to_string();
            assert!(!error.contains("secret-client"), "{what}: {error}");
            assert!(!error.contains(dir.to_str().unwrap()), "{what}: {error}");
            assert!(
                error.contains("folders.json"),
                "{what}: tells the owner what to do"
            );
        }
    }

    #[test]
    fn names_are_made_presentable_or_replaced() {
        assert_eq!(presentable_name("a/b\\c\nd").as_deref(), Some("a b c d"));
        assert_eq!(presentable_name("   "), None);
        // Look-alike separators and invisible/reordering characters (L1).
        assert_eq!(
            presentable_name("a\u{2215}b\u{FF0F}c\u{2044}d\u{202E}e\u{200B}f").as_deref(),
            Some("a b c d e f")
        );
        assert_eq!(presentable_name("\u{202E}\u{200B}"), None);
        assert_eq!(
            presentable_name(&"가".repeat(200)).unwrap().chars().count(),
            80
        );
        let dir = state();
        let named = FolderBook::open(&dir, Path::new("/x/y"), Some("고객 A / 앱")).unwrap();
        assert_eq!(named.folders()[0].display_name, "고객 A 앱");
        let root = FolderBook::open(&dir, Path::new("/"), None).unwrap();
        assert_eq!(root.folders()[0].display_name, FALLBACK_PROJECT_NAME);
    }
}
