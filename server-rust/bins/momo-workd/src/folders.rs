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
//! * **Does not spawn by id.** A session still opens `working_directory`
//!   (`session.rs`). Resolving a signed spawn's folder id to a path with
//!   `realpath` at every spawn is T5 (#3570); [`FolderBook::resolve`] is the
//!   lookup it will call.
//!
//! ## The two kinds
//!
//! * `project` — the folder the owner allowed (`working_directory`), named by
//!   `working_directory_name` or the folder's own last component.
//! * `question` — 「질문용 폴더」: an empty folder the host makes under its own
//!   state folder, for a question that needs no project (ADR-0198 증보 1 D7). It
//!   is the default when a request names no folder.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{read_owned_file, write_private_file, ConfigError};

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
}

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
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
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
            });
        }
        if ids != stored.ids {
            let body = serde_json::to_vec_pretty(&Stored { ids }).expect("map serialises");
            write_private_file(&file, &body)?;
        }
        Ok(Self { folders })
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

    /// The path an id was issued for (T5's lookup; the caller still resolves it
    /// with `realpath` at the spawn).
    pub fn resolve(&self, id: &str) -> Option<&Path> {
        self.folders
            .iter()
            .find(|folder| folder.id == id)
            .map(|folder| folder.path.as_path())
    }
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
