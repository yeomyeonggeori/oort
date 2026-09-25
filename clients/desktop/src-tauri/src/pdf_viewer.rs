// Open a PDF attachment in the OS default PDF viewer (#2701).
//
// In a browser tab the web bundle opens a PDF attachment in a new window as an
// `application/pdf` blob. That path does not exist in this shell:
//   * wry leaves WKWebView's new-window request unimplemented, so
//     `window.open` is dropped (the same fact `opener.rs` is built on);
//   * the shell CSP is `frame-src 'none'; object-src 'none'`, so no embedded
//     viewer can render the bytes either;
//   * a `blob:` URL only lives inside this webview, so it cannot be handed to
//     the OS browser the way `open_external_url` hands over an https link.
//
// So the shell does the part the webview cannot, which is where OS behaviour
// belongs (ADR-0133 §2): it writes the bytes the web bundle already fetched
// through the authorised attachment proxy to a file in the app cache and asks
// the OS to open that file. The bytes never travel anywhere new — no URL, no
// credential, no Drive address reaches this side.
//
// The command is deliberately narrow, the same way `open_external_url` is. It
// can do exactly one thing, and a compromised webview cannot talk it into
// another:
//   * the payload must carry the `%PDF-` header (ISO 32000 allows up to 1 KiB
//     of leading junk, which is the window checked), so it cannot be used to
//     drop an arbitrary file for the OS to run;
//   * the file name is derived here, not taken verbatim: the extension is
//     always `.pdf`, path separators and control characters are stripped, and
//     the file lands in this app's own cache directory. The OS therefore picks
//     its PDF handler, never an executable one;
//   * the payload is capped at the attachment ceiling (100 MiB), matching
//     `MAX_ATTACHMENT_BYTES` in `packages/momo-core`.
//
// ## The plain-text copy (#2701 R1, security review M-3)
//
// The file on disk is a by-product of *viewing*, not a save the person chose
// (the download button is that). So it does not outlive its purpose:
//   * each copy is removed `REMOVE_AFTER_OPEN` after the viewer was launched.
//     The viewer already holds the file open, and on APFS/ext4 an unlinked
//     file stays readable through that descriptor, so the open document keeps
//     rendering; only re-opening it from the viewer's Recents fails, which is
//     what the download is for;
//   * copies older than `SWEEP_AFTER` are swept at app start and on every
//     open, which covers a copy whose timer died with the app;
//   * the directory is created exclusively with 0700 and the file with
//     `create_new` and 0600, so nothing planted at the path in advance is
//     followed (review L-1).
//
// Logging out does not clear the cache yet: the web bundle has no shell hook
// at logout. The one-hour ceiling bounds it (follow-up noted in #2710).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// Same ceiling as the attachment contract (`MAX_ATTACHMENT_BYTES`).
const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
/// ISO 32000 Annex H: readers accept the header anywhere in the first 1 KiB.
const HEADER_WINDOW: usize = 1024;
const PDF_HEADER: &[u8] = b"%PDF-";
/// Longest name stem kept, in BYTES: APFS/ext4 cap a name at 255 bytes, and
/// `.pdf` needs four of them. A character cap let 80 four-byte emoji through
/// as 324 bytes and the write failed (review L-2).
const MAX_STEM_BYTES: usize = 200;
/// Copies older than this are removed at app start and on every open.
const SWEEP_AFTER: Duration = Duration::from_secs(60 * 60);
/// A launched copy is removed this long after the viewer opened it.
const REMOVE_AFTER_OPEN: Duration = Duration::from_secs(10 * 60);
/// Header the web bundle sends the display name in (percent-encoded UTF-8).
const NAME_HEADER: &str = "x-oort-file-name";
const CACHE_SUBDIR: &str = "pdf-preview";

/// Device names Windows reserves regardless of extension (`CON.pdf` is CON).
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Does the payload start (within the header window) with `%PDF-`?
pub(crate) fn has_pdf_header(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(HEADER_WINDOW)];
    window
        .windows(PDF_HEADER.len())
        .any(|candidate| candidate == PDF_HEADER)
}

/// Everything the command refuses about a payload, in one place the tests can
/// reach without an `AppHandle` (review M-1/M-2).
pub(crate) fn validate(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_PDF_BYTES {
        return Err("refused: larger than the attachment ceiling");
    }
    if !has_pdf_header(bytes) {
        return Err("refused: not a pdf");
    }
    Ok(())
}

/// Bidirectional and zero-width format characters. They are not `is_control`,
/// and in a title they can make `x.pdf.command` read as something else.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// A file name that is always `<stem>.pdf`, with nothing in the stem that a
/// file system or a launcher could read as structure.
pub(crate) fn safe_pdf_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = match trimmed.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("pdf") => stem,
        _ => trimmed,
    };
    let mut cleaned = String::new();
    for c in stem.chars() {
        if c.is_control() || is_format_char(c) {
            continue;
        }
        let c = match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        };
        if cleaned.len() + c.len_utf8() > MAX_STEM_BYTES {
            break;
        }
        cleaned.push(c);
    }
    // A stem made only of dots and spaces would be `..pdf` or a hidden file.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem = if cleaned.is_empty() {
        "attachment".to_string()
    } else if WINDOWS_RESERVED
        .iter()
        .any(|reserved| cleaned.eq_ignore_ascii_case(reserved))
    {
        format!("_{cleaned}")
    } else {
        cleaned.to_string()
    };
    format!("{stem}.pdf")
}

/// Remove every entry under `root` whose mtime is older than `max_age` at
/// `now`. Returns how many went. Only `root`'s own entries are considered, and
/// `DirEntry::metadata` does not follow a symlink, nor does `remove_dir_all`
/// at its top level (Rust >= 1.58.1).
fn sweep(root: &Path, now: SystemTime, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if !stale {
            continue;
        }
        let path = entry.path();
        let gone = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if gone.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// App start: drop copies a previous run left behind (its removal timers died
/// with it). Errors are ignored — a missing cache is the normal case.
pub(crate) fn sweep_cache(cache: &Path) -> usize {
    sweep(&cache.join(CACHE_SUBDIR), SystemTime::now(), SWEEP_AFTER)
}

#[cfg(unix)]
fn restrict_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write the bytes under `<cache>/pdf-preview/<unique>/<name>.pdf` and return
/// `(unique dir, file)`.
///
/// A unique subdirectory per open, rather than a unique file name, keeps the
/// person's own file name as the title the viewer shows. The subdirectory is
/// created with `create_dir` (fails if anything is already there) and the file
/// with `create_new`, so a path planted in advance is never followed.
fn write_pdf(cache: &Path, name: &str, bytes: &[u8]) -> Result<(PathBuf, PathBuf), String> {
    let root = cache.join(CACHE_SUBDIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("cache dir: {e}"))?;
    restrict_dir(&root).map_err(|e| format!("cache dir: {e}"))?;
    sweep(&root, SystemTime::now(), SWEEP_AFTER);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let unique = format!("{stamp:x}-{:x}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let dir = root.join(unique);
    std::fs::create_dir(&dir).map_err(|e| format!("cache dir: {e}"))?;
    restrict_dir(&dir).map_err(|e| format!("cache dir: {e}"))?;
    let path = dir.join(safe_pdf_name(name));
    let mut file = create_private_file(&path).map_err(|e| format!("write: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("write: {e}"))?;
    Ok((dir, path))
}

/// The launcher, as a `Command` the tests can read back.
fn launcher(path: &Path) -> Command {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("/usr/bin/open");
        // `--` so a path can never be read as an option to `open`.
        c.arg("--");
        c
    };

    // Same launcher as `opener.rs`, for the same reason: CreateProcess with a
    // plain argument, no `cmd` parse in between.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(path);
    command
}

fn os_launch(path: &Path) -> Result<(), String> {
    match launcher(path).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("viewer launcher failed: {status}")),
        Err(error) => Err(format!("viewer launcher failed: {error}")),
    }
}

/// Remove one launched copy after `after` (see the M-3 note at the top).
fn schedule_removal(dir: PathBuf, after: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let _ = std::fs::remove_dir_all(&dir);
    });
}

/// The whole command minus the IPC plumbing: refuse, write, launch, schedule
/// the removal. Returns the file that was handed to the viewer.
///
/// The command body only unpacks the request and calls this, so every guard
/// the review sabotaged (ceiling, header, safe name) is on a path the tests
/// run (review M-1/M-2).
fn open_pdf_bytes(
    cache: &Path,
    name: &str,
    bytes: &[u8],
    launch: impl FnOnce(&Path) -> Result<(), String>,
    remove_after: Duration,
) -> Result<PathBuf, String> {
    validate(bytes)?;
    let (dir, path) = write_pdf(cache, name, bytes)?;
    if let Err(error) = launch(&path) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    schedule_removal(dir, remove_after);
    Ok(path)
}

/// Open one PDF (raw invoke body) in the OS default viewer.
///
/// The raw body only survives the custom-protocol IPC transport; the shell CSP
/// must keep `connect-src ipc: http://ipc.localhost` (`shell_contract.rs`).
///
/// Errors are returned rather than swallowed: the card shows an inline failure
/// and points at the download button, which is only possible if this side
/// admits the file did not open.
#[tauri::command]
pub async fn open_pdf_attachment(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("refused: expected raw bytes".to_string());
    };
    // Refuse before copying 100 MiB into the blocking task.
    validate(bytes)?;
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?;
    let bytes = bytes.clone();

    // File IO and the launcher both block; keep them off the async workers
    // (the same reasoning as `open_external_url`).
    tauri::async_runtime::spawn_blocking(move || {
        open_pdf_bytes(&cache, &name, &bytes, os_launch, REMOVE_AFTER_OPEN).map(|_| ())
    })
    .await
    .map_err(|error| format!("viewer launcher did not run: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        has_pdf_header, launcher, open_pdf_bytes, safe_pdf_name, sweep, sweep_cache, validate,
        write_pdf, MAX_PDF_BYTES, SWEEP_AFTER,
    };
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime};

    /// A scratch cache directory unique to one test.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oort-pdf-viewer-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pdf(len: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.4\n".to_vec();
        bytes.resize(len.max(bytes.len()), b' ');
        bytes
    }

    const LONG: Duration = Duration::from_secs(3600);

    #[test]
    fn accepts_a_pdf_header_within_the_first_kib() {
        assert!(has_pdf_header(b"%PDF-1.7\n1 0 obj"));
        let mut padded = vec![b' '; 10];
        padded.extend_from_slice(b"%PDF-1.4");
        assert!(has_pdf_header(&padded));
    }

    #[test]
    fn refuses_anything_else() {
        assert!(!has_pdf_header(b""));
        assert!(!has_pdf_header(b"<html><script>alert(1)</script>"));
        assert!(!has_pdf_header(b"#!/bin/sh\nrm -rf ~"));
        let mut late = vec![b' '; 1100];
        late.extend_from_slice(b"%PDF-1.4");
        assert!(!has_pdf_header(&late));
    }

    /// The ceiling is exactly the attachment contract's 100 MiB, measured at
    /// the boundary, so neither a disabled check nor a widened constant passes.
    #[test]
    fn the_ceiling_is_exactly_one_hundred_mib() {
        assert_eq!(MAX_PDF_BYTES, 100 * 1024 * 1024);
        assert_eq!(validate(&pdf(MAX_PDF_BYTES)), Ok(()));
        assert_eq!(
            validate(&pdf(MAX_PDF_BYTES + 1)),
            Err("refused: larger than the attachment ceiling")
        );
        assert_eq!(validate(b"#!/bin/sh\n"), Err("refused: not a pdf"));
    }

    #[test]
    fn names_are_always_a_plain_pdf_file() {
        assert_eq!(safe_pdf_name("Q3-온보딩-리뷰.pdf"), "Q3-온보딩-리뷰.pdf");
        assert_eq!(safe_pdf_name("spec.PDF"), "spec.pdf");
        assert_eq!(safe_pdf_name("run.command"), "run.command.pdf");
        assert_eq!(safe_pdf_name("../../etc/passwd"), "-..-etc-passwd.pdf");
        assert_eq!(safe_pdf_name("a\u{0}b\nc.pdf"), "abc.pdf");
        assert_eq!(safe_pdf_name(".."), "attachment.pdf");
        assert_eq!(safe_pdf_name(""), "attachment.pdf");
        // Bidi override would let `x\u{202E}fdp.command` render as `x…command.pdf`.
        assert_eq!(safe_pdf_name("x\u{202E}dnammoc.pdf"), "xdnammoc.pdf");
        assert_eq!(safe_pdf_name("CON"), "_CON.pdf");
        assert_eq!(safe_pdf_name("lpt1.pdf"), "_lpt1.pdf");
    }

    /// Bytes, not characters: 255 is the name limit on APFS and ext4.
    #[test]
    fn long_names_fit_a_file_system_name() {
        for unit in ["가", "😀", "a"] {
            let name = safe_pdf_name(&unit.repeat(400));
            assert!(name.len() <= 255, "{} bytes for {unit}", name.len());
            assert!(name.ends_with(".pdf"));
        }
    }

    /// The written file is a direct child of a fresh subdirectory of
    /// `<cache>/pdf-preview`, measured on the RESOLVED path. The lexical
    /// `starts_with` this replaces passed for `<…>/<u>/../escape.pdf` too
    /// (review M-2, sabotage S8).
    #[test]
    fn writes_inside_its_own_cache_subdirectory() {
        let cache = scratch("write");
        let root = cache.join("pdf-preview");
        for hostile in [
            "../escape.pdf",
            "../../escape.pdf",
            "/etc/escape.pdf",
            "a/../../b.pdf",
        ] {
            let (dir, path) = write_pdf(&cache, hostile, b"%PDF-1.4\n").unwrap();
            let resolved = path.canonicalize().unwrap();
            let root = root.canonicalize().unwrap();
            assert_eq!(
                resolved.parent(),
                Some(dir.canonicalize().unwrap().as_path())
            );
            assert_eq!(
                resolved.parent().and_then(Path::parent),
                Some(root.as_path())
            );
            assert_eq!(resolved.extension().and_then(|e| e.to_str()), Some("pdf"));
            assert_eq!(std::fs::read(&resolved).unwrap(), b"%PDF-1.4\n");
        }
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[cfg(unix)]
    #[test]
    fn the_copy_is_private_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let cache = scratch("mode");
        let (dir, path) = write_pdf(&cache, "spec.pdf", b"%PDF-1.4\n").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);
        let _ = std::fs::remove_dir_all(&cache);
    }

    /// The command's own path: header, ceiling and safe name are all applied
    /// before anything reaches the launcher (review S3/S4/S8).
    #[test]
    fn the_command_path_refuses_before_launching() {
        let cache = scratch("command");
        let launched: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
        let record = |p: &Path| {
            launched.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        assert_eq!(
            open_pdf_bytes(&cache, "x.pdf", b"#!/bin/sh\n", record, LONG),
            Err("refused: not a pdf".to_string())
        );
        assert_eq!(
            open_pdf_bytes(&cache, "x.pdf", &pdf(MAX_PDF_BYTES + 1), record, LONG),
            Err("refused: larger than the attachment ceiling".to_string())
        );
        assert!(launched.borrow().is_empty());
        // Nothing was written for a refused payload.
        let root = cache.join("pdf-preview");
        assert_eq!(std::fs::read_dir(&root).map(|d| d.count()).unwrap_or(0), 0);

        let opened = open_pdf_bytes(&cache, "../../run.command", &pdf(64), record, LONG).unwrap();
        assert_eq!(launched.borrow().as_slice(), std::slice::from_ref(&opened));
        assert_eq!(
            opened.file_name().and_then(|n| n.to_str()),
            Some("-..-run.command.pdf")
        );
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn a_failed_launch_leaves_no_copy_behind() {
        let cache = scratch("launch-fail");
        let result = open_pdf_bytes(
            &cache,
            "spec.pdf",
            &pdf(64),
            |_| Err("viewer launcher failed".to_string()),
            LONG,
        );
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_dir(cache.join("pdf-preview"))
                .unwrap()
                .count(),
            0
        );
        let _ = std::fs::remove_dir_all(&cache);
    }

    /// A launched copy does not wait for the next open to go (review M-3).
    #[test]
    fn a_launched_copy_is_removed_after_the_retention() {
        let cache = scratch("retention");
        let opened = open_pdf_bytes(
            &cache,
            "spec.pdf",
            &pdf(64),
            |_| Ok(()),
            Duration::from_millis(50),
        )
        .unwrap();
        let dir = opened.parent().unwrap().to_path_buf();
        let deadline = Instant::now() + Duration::from_secs(5);
        while dir.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!dir.exists(), "{} still exists", dir.display());
        let _ = std::fs::remove_dir_all(&cache);
    }

    /// App start sweeps what a previous run left, and only what is stale.
    #[test]
    fn the_startup_sweep_removes_only_stale_copies() {
        let cache = scratch("sweep");
        let (old_dir, _) = write_pdf(&cache, "old.pdf", b"%PDF-1.4\n").unwrap();
        let (new_dir, _) = write_pdf(&cache, "new.pdf", b"%PDF-1.4\n").unwrap();
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 3600);
        std::fs::File::open(&old_dir)
            .unwrap()
            .set_modified(two_hours_ago)
            .unwrap();
        assert_eq!(sweep_cache(&cache), 1);
        assert!(!old_dir.exists());
        assert!(new_dir.exists());
        // Boundary: the window is SWEEP_AFTER, not "anything older than now".
        assert_eq!(
            sweep(
                &cache.join("pdf-preview"),
                SystemTime::now() + SWEEP_AFTER - Duration::from_secs(60),
                SWEEP_AFTER
            ),
            0
        );
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_launcher_ends_options_before_the_path() {
        let command = launcher(Path::new("/tmp/x.pdf"));
        assert_eq!(command.get_program(), "/usr/bin/open");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["--", "/tmp/x.pdf"]);
    }
}
