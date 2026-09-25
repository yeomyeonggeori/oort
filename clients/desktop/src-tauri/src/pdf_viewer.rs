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
// Old files are swept on every call (older than one hour), so the cache does
// not grow with every PDF someone opens.

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
/// Longest name stem kept. Real file names are far below it.
const MAX_STEM_CHARS: usize = 80;
/// Files older than this are removed on the next open.
const SWEEP_AFTER: Duration = Duration::from_secs(60 * 60);
/// Header the web bundle sends the display name in (percent-encoded UTF-8).
const NAME_HEADER: &str = "x-oort-file-name";
const CACHE_SUBDIR: &str = "pdf-preview";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Does the payload start (within the header window) with `%PDF-`?
pub(crate) fn has_pdf_header(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(HEADER_WINDOW)];
    window
        .windows(PDF_HEADER.len())
        .any(|candidate| candidate == PDF_HEADER)
}

/// A file name that is always `<stem>.pdf`, with nothing in the stem that a
/// file system or a launcher could read as structure.
pub(crate) fn safe_pdf_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let stem = match trimmed.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("pdf") => stem,
        _ => trimmed,
    };
    let cleaned: String = stem
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .take(MAX_STEM_CHARS)
        .collect();
    // A stem made only of dots and spaces would be `..pdf` or a hidden file.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem = if cleaned.is_empty() {
        "attachment"
    } else {
        cleaned
    };
    format!("{stem}.pdf")
}

fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > SWEEP_AFTER);
        if stale {
            let path = entry.path();
            // Each open gets its own subdirectory (see `write_pdf`).
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

/// Write the bytes under `<cache>/pdf-preview/<unique>/<name>.pdf`.
///
/// A unique subdirectory per open, rather than a unique file name, keeps the
/// person's own file name as the title the viewer shows.
fn write_pdf(cache: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let root = cache.join(CACHE_SUBDIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("cache dir: {e}"))?;
    sweep(&root);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let unique = format!("{stamp:x}-{:x}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let dir = root.join(unique);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache dir: {e}"))?;
    let path = dir.join(safe_pdf_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(path)
}

fn launch(path: &Path) -> Command {
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

/// Open one PDF (raw invoke body) in the OS default viewer.
///
/// Errors are returned rather than swallowed: the card shows an inline failure
/// and points at the download button, which is only possible if this side
/// admits the file did not open.
#[tauri::command]
pub async fn open_pdf_attachment(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("refused: expected raw bytes".to_string());
    };
    if bytes.len() > MAX_PDF_BYTES {
        return Err("refused: larger than the attachment ceiling".to_string());
    }
    if !has_pdf_header(bytes) {
        return Err("refused: not a pdf".to_string());
    }
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
        let path = write_pdf(&cache, &name, &bytes)?;
        match launch(&path).status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("viewer launcher failed: {status}")),
            Err(error) => Err(format!("viewer launcher failed: {error}")),
        }
    })
    .await
    .map_err(|error| format!("viewer launcher did not run: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{has_pdf_header, safe_pdf_name, write_pdf};

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

    #[test]
    fn names_are_always_a_plain_pdf_file() {
        assert_eq!(safe_pdf_name("Q3-온보딩-리뷰.pdf"), "Q3-온보딩-리뷰.pdf");
        assert_eq!(safe_pdf_name("spec.PDF"), "spec.pdf");
        assert_eq!(safe_pdf_name("run.command"), "run.command.pdf");
        assert_eq!(safe_pdf_name("../../etc/passwd"), "-..-etc-passwd.pdf");
        assert_eq!(safe_pdf_name("a\u{0}b\nc.pdf"), "abc.pdf");
        assert_eq!(safe_pdf_name(".."), "attachment.pdf");
        assert_eq!(safe_pdf_name(""), "attachment.pdf");
        let long = "가".repeat(200);
        assert_eq!(safe_pdf_name(&long).chars().count(), 80 + ".pdf".len());
    }

    #[test]
    fn writes_inside_its_own_cache_subdirectory() {
        let cache =
            std::env::temp_dir().join(format!("oort-pdf-viewer-test-{}", std::process::id()));
        let path = write_pdf(&cache, "../escape.pdf", b"%PDF-1.4\n").unwrap();
        assert!(path.starts_with(cache.join("pdf-preview")));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("pdf"));
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4\n");
        let _ = std::fs::remove_dir_all(&cache);
    }
}
