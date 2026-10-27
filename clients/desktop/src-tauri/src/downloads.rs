// Save a downloaded attachment into the Downloads folder, and show / open / probe
// what is there (#4587, owner 2026-10-26: "다운로드 관련한 버튼을 제일 상단 우측에").
//
// Why this exists. The web bundle's old download was a blob + `<a download>`. In this
// shell that path does write a file: wry's `WebViewAttributes` default is a
// `download_started_handler` that accepts every download (wry 0.55.1 `lib.rs`), so
// WKWebView saves the page's suggested name into `dirs::download_dir()`, numbered
// ` (n)` on a clash and marked `com.apple.quarantine` `0083` (measured on a real build,
// #4587, 2026-10-27; the app registers no handler of its own). What it cannot do is
// answer the person afterwards: how far along is it, what did the file end up being
// called, where did it go, is it still there, show me, open it. The app never sees
// the result of a download WebKit made on its own. So the shell does the part the
// webview cannot, which is where OS behaviour belongs (ADR-0133 §2): it writes the
// bytes the web bundle already fetched through the authorised attachment proxy
// (ADR-0151 D2, no direct link) to the Downloads folder, and it can reveal, open and
// probe the files it saved. Both paths end in the same folder with the same
// quarantine mark; this one returns the name it used.
//
// What this module is NOT: a general file API. It is the same "narrow app command"
// shape as `opener.rs` / `pdf_viewer.rs`, and for the same reason: the plugin
// surfaces (`fs`, `opener`) are "any path, any handler", and a compromised webview
// must not be able to talk a command into more than the product needs. So:
//
//   * **The webview never names a path.** `download_save` takes bytes and a display
//     name; the other commands take a bare FILE NAME that this side resolves under
//     the Downloads folder. A path outside that folder cannot even be spelled:
//     separators, `..`, NUL, control and bidi characters, a leading dot are refused
//     before anything touches the disk (`is_plain_name`).
//   * **Resolved, not trusted.** The Downloads folder and the file are both
//     canonicalised and the file must be a direct child of the folder
//     (`resolve_in`). The lexical `starts_with` check is not enough (pdf_viewer's
//     review caught `<root>/<u>/../escape.pdf` passing it), and a symlink that
//     lives INSIDE Downloads and points out is refused outright: the file must be a
//     regular file by `symlink_metadata`, which does not follow links.
//   * **Never overwrites.** `create_new` (O_CREAT|O_EXCL): an existing file, and a
//     symlink planted at the target name, are never written through. A collision
//     gets ` (1)`, ` (2)` ... like a browser.
//   * **The name is derived here** (`safe_file_name`): extension kept, separators,
//     control and bidi characters stripped, a leading dot (a hidden file) removed,
//     Windows device names defused, at most `MAX_NAME_BYTES`. Whoever sent the
//     attachment chose the name, so it is hostile input. The invariant the tests
//     pin: every name this module saves passes the same `is_plain_name` the other
//     commands demand.
//   * **Opening is not running.** `download_open` hands the file to the OS default
//     handler, and the sender of a chat attachment is not necessarily trusted. A
//     file saved here has no execute bit, but several handlers run or install what
//     they are given (`.terminal`, `.command`, `.pkg`, `.mobileconfig`, `.jar`,
//     scripts, a local HTML page). Those extensions are refused for "open"
//     (`is_openable`); "reveal in Finder" stays available for them. On macOS the
//     saved file also gets the `com.apple.quarantine` attribute, which is what a
//     browser does with a download, so Gatekeeper still judges an executable the
//     person double-clicks in Finder. Measured (#4587): `xattr -l` on a saved file
//     shows `0081;<time>;oort;`, a saved `.command` has no execute bit and
//     `spctl --assess --type open` rejects it (no usable signature). The Gatekeeper
//     dialog on a Finder double-click itself was not exercised.
//   * **Ceiling** `MAX_DOWNLOAD_BYTES` (100 MiB), the attachment contract
//     (`MAX_ATTACHMENT_BYTES`). Raising the contract (ADR-0151 follow-up #4585)
//     means raising this and moving to chunked transfer: the raw body today is one
//     IPC message held in memory on both sides.
//
// Errors are strings whose first word is a code the web bundle maps to copy:
// `refused: ...`, `missing`, `denied`, `disk_full`, `failed`. They are returned,
// never swallowed: the panel row shows the failure and offers the next step.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// Same ceiling as the attachment contract (`MAX_ATTACHMENT_BYTES`).
const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024;
/// Header the web bundle sends the display name in (percent-encoded UTF-8).
const NAME_HEADER: &str = "x-oort-file-name";
/// Longest file name this module writes, in BYTES. APFS/ext4 cap a name at 255
/// bytes; the collision suffix (` (1000)`, 7 bytes) must still fit.
const MAX_NAME_BYTES: usize = 200;
/// An extension longer than this (without its dot) is not an extension.
const MAX_EXTENSION_BYTES: usize = 16;
/// How many ` (n)` suffixes are tried before giving up.
const MAX_COLLISIONS: u32 = 1000;
/// Names one probe may carry (the panel keeps far fewer than this).
const MAX_PROBE_NAMES: usize = 200;

const ERR_NOT_RAW: &str = "refused: expected raw bytes";
const ERR_TOO_LARGE: &str = "refused: larger than the download ceiling";
const ERR_NO_FOLDER: &str = "refused: no downloads folder";
const ERR_NOT_PLAIN: &str = "refused: not a plain file name";
const ERR_NOT_FILE: &str = "refused: not a regular file";
const ERR_OUTSIDE: &str = "refused: outside the downloads folder";
const ERR_NOT_OPENABLE: &str = "refused: this kind of file is not opened from here";
const ERR_TOO_MANY: &str = "refused: too many names";
const ERR_MISSING: &str = "missing";
const ERR_DENIED: &str = "denied";
const ERR_DISK_FULL: &str = "disk_full";
const ERR_FAILED: &str = "failed";

/// Device names Windows reserves regardless of extension (`CON.pdf` is CON).
const WINDOWS_RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Extensions whose default handler runs, installs or interprets what it is given
/// (see "Opening is not running" above). Lower case, no dot. A closed list on
/// purpose: an unknown extension is still opened, and a person can always
/// "reveal" one of these and decide in Finder.
const NOT_OPENED_EXTENSIONS: &[&str] = &[
    // macOS bundles, installers, profiles and handlers that run on open.
    "app",
    "command",
    "tool",
    "terminal",
    "workflow",
    "action",
    "scpt",
    "scptd",
    "applescript",
    "osax",
    "pkg",
    "mpkg",
    "dmg",
    "iso",
    "xip",
    "mobileconfig",
    "prefpane",
    "saver",
    "plugin",
    "kext",
    "service",
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "ipa",
    // Shells and interpreters.
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "py",
    "pyc",
    "pyw",
    "pl",
    "rb",
    "php",
    "js",
    "mjs",
    "cjs",
    "jar",
    "class",
    // Windows.
    "exe",
    "msi",
    "bat",
    "cmd",
    "com",
    "scr",
    "pif",
    "vbs",
    "vbe",
    "jse",
    "wsf",
    "wsh",
    "ps1",
    "psm1",
    "reg",
    "hta",
    "cpl",
    "dll",
    "lnk",
    "msc",
    // Linux.
    "desktop",
    "appimage",
    "run",
    "deb",
    "rpm",
    // A local page runs its own script with a `file:` origin.
    "html",
    "htm",
    "xhtml",
    "svg",
    "webarchive",
    "mht",
    "mhtml",
];

/// Bidirectional and zero-width format characters. They are not `is_control`,
/// and in a name they can make `x.pdf.command` read as something else.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// Characters a file name here never contains: the ones `safe_file_name` replaces.
fn is_reserved_char(c: char) -> bool {
    matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

/// Split `name.ext` at the last dot. An extension is what a file system and a
/// launcher call one: 1 to `MAX_EXTENSION_BYTES` ASCII letters or digits. Anything
/// else after the last dot (`-etc-passwd`, `pdf (1)`) is part of the stem, so the
/// open check below reads the same extension the OS will.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => {
            let ext = &name[i + 1..];
            let is_extension = !ext.is_empty()
                && ext.len() <= MAX_EXTENSION_BYTES
                && ext.bytes().all(|b| b.is_ascii_alphanumeric());
            if is_extension {
                (&name[..i], &name[i..])
            } else {
                (name, "")
            }
        }
        _ => (name, ""),
    }
}

/// A file name that is one plain path element, with nothing a file system or a
/// launcher could read as structure. Always non-empty, at most `MAX_NAME_BYTES`.
pub(crate) fn safe_file_name(raw: &str) -> String {
    let mut cleaned = String::new();
    for c in raw.trim().chars() {
        if c.is_control() || is_format_char(c) {
            continue;
        }
        cleaned.push(if is_reserved_char(c) { '-' } else { c });
    }
    // Leading dots would make a hidden file (or `..`); trailing dots and spaces
    // are not kept by Windows. Interior ones are the person's own.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    let (stem, ext) = split_extension(cleaned);
    // Truncate the STEM, in bytes, at a character boundary: the extension is what
    // tells the OS (and the person) what the file is.
    let room = MAX_NAME_BYTES.saturating_sub(ext.len());
    let mut kept = String::new();
    for c in stem.chars() {
        if kept.len() + c.len_utf8() > room {
            break;
        }
        kept.push(c);
    }
    let kept = kept.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem = if kept.is_empty() {
        "attachment".to_string()
    } else if WINDOWS_RESERVED
        .iter()
        .any(|reserved| kept.eq_ignore_ascii_case(reserved))
    {
        format!("_{kept}")
    } else {
        kept.to_string()
    };
    format!("{stem}{ext}")
}

/// Is `name` something this module could have saved: one plain path element.
/// This is the single gate every by-name command passes first.
pub(crate) fn is_plain_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    // A leading dot is a hidden file; a trailing dot or space is not kept by
    // Windows (`evil.exe.` is `evil.exe` there). `safe_file_name` trims both.
    if name != name.trim_matches(|c: char| c == '.' || c.is_whitespace()) {
        return false;
    }
    if name
        .chars()
        .any(|c| c.is_control() || is_format_char(c) || is_reserved_char(c))
    {
        return false;
    }
    // Structural check as well: exactly one normal component.
    let mut parts = Path::new(name).components();
    matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    )
}

/// `foo.pdf` with `n = 0`, `foo (n).pdf` otherwise.
fn numbered(stem: &str, ext: &str, n: u32) -> String {
    if n == 0 {
        format!("{stem}{ext}")
    } else {
        format!("{stem} ({n}){ext}")
    }
}

/// The ceiling, on its own so a test can measure the boundary without
/// allocating 100 MiB.
pub(crate) fn check_size(len: usize) -> Result<(), &'static str> {
    if len > MAX_DOWNLOAD_BYTES {
        Err(ERR_TOO_LARGE)
    } else {
        Ok(())
    }
}

fn io_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        ErrorKind::PermissionDenied => ERR_DENIED,
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => ERR_DISK_FULL,
        _ => ERR_FAILED,
    }
}

/// Create the next free `<name> (n)` under `root` and let `write` fill it.
/// A failed write removes the partial file: a half-written download must not sit
/// under its final name.
fn save_with(
    root: &Path,
    raw_name: &str,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<String, String> {
    if !root.is_dir() {
        return Err(ERR_NO_FOLDER.to_string());
    }
    let name = safe_file_name(raw_name);
    let (stem, ext) = split_extension(&name);
    for n in 0..=MAX_COLLISIONS {
        let candidate = numbered(stem, ext, n);
        let path = root.join(&candidate);
        // `create_new` is O_CREAT|O_EXCL: it fails on an existing file and on a
        // symlink at the name (dangling or not) instead of writing through it.
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_code(&error).to_string()),
        };
        if let Err(error) = write(&mut file).and_then(|()| file.flush()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(io_code(&error).to_string());
        }
        return Ok(candidate);
    }
    Err(ERR_FAILED.to_string())
}

/// Write `bytes` under `root` and return the file name it got.
pub(crate) fn save_into(root: &Path, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
    check_size(bytes.len()).map_err(str::to_string)?;
    save_with(root, raw_name, |file| file.write_all(bytes))
}

/// Why a by-name command could not find its file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unresolved {
    /// The name or the file is outside what this module touches.
    Refused(&'static str),
    /// A plain name, but nothing (any more) at it.
    Missing,
}

impl Unresolved {
    fn code(self) -> &'static str {
        match self {
            Unresolved::Refused(code) => code,
            Unresolved::Missing => ERR_MISSING,
        }
    }
}

/// THE path restriction. `file_name` is a bare name; the result is a regular file
/// that is a direct child of `root` once both are resolved. Everything else is
/// refused: a name with structure, a directory, a symlink (wherever it points),
/// a file whose resolved parent is not `root`.
pub(crate) fn resolve_in(root: &Path, file_name: &str) -> Result<PathBuf, Unresolved> {
    if !is_plain_name(file_name) {
        return Err(Unresolved::Refused(ERR_NOT_PLAIN));
    }
    let root = root
        .canonicalize()
        .map_err(|_| Unresolved::Refused(ERR_NO_FOLDER))?;
    let path = root.join(file_name);
    // `symlink_metadata` does not follow a link: a symlink is not a regular file.
    let meta = std::fs::symlink_metadata(&path).map_err(|_| Unresolved::Missing)?;
    if !meta.file_type().is_file() {
        return Err(Unresolved::Refused(ERR_NOT_FILE));
    }
    let resolved = path.canonicalize().map_err(|_| Unresolved::Missing)?;
    // The checks above already leave no way to land elsewhere; this is the
    // belt to their braces, so a later change to them cannot open an escape.
    if !is_direct_child(&root, &resolved) {
        return Err(Unresolved::Refused(ERR_OUTSIDE));
    }
    Ok(path)
}

/// `path` sits directly in `root`, compared as paths. `starts_with` would also
/// accept `<root>/sub/x` and the lexical `<root>/sub/../x`, which is the check
/// `pdf_viewer.rs`'s review found too weak.
fn is_direct_child(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
}

/// For each name: is that file still in the Downloads folder. A name that is not
/// plain, or resolves to anything but a regular file there, reads as absent, so a
/// compromised page learns nothing about the rest of the disk from this call.
pub(crate) fn probe_in(root: &Path, names: &[String]) -> Result<Vec<bool>, &'static str> {
    if names.len() > MAX_PROBE_NAMES {
        return Err(ERR_TOO_MANY);
    }
    Ok(names
        .iter()
        .map(|name| resolve_in(root, name).is_ok())
        .collect())
}

/// May this file be handed to the OS default handler. See "Opening is not
/// running" in the header. The last extension decides (`a.pdf.command` is
/// `command`), case-insensitively.
pub(crate) fn is_openable(file_name: &str) -> bool {
    // `evil.exe.` and `evil.exe ` are `evil.exe` on Windows.
    let file_name = file_name.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let (_, ext) = split_extension(file_name);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    !NOT_OPENED_EXTENSIONS.contains(&ext.as_str())
}

/// What the OS is asked to do with a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Launch {
    /// The default application for the file.
    Open,
    /// Show the file in the file manager (macOS selects it; elsewhere the folder opens).
    Reveal,
    /// Open the folder itself.
    Folder,
}

/// The launcher, as a `Command` the tests can read back. `path` is the file (for
/// `Open`, `Reveal`) or the folder (for `Folder`), always an absolute path this
/// module built, never the webview's text.
fn launcher(launch: Launch, path: &Path) -> Command {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("/usr/bin/open");
        if launch == Launch::Reveal {
            c.arg("-R");
        }
        // `--` so a path can never be read as an option to `open`.
        c.arg("--");
        c
    };

    // Same launcher as `opener.rs`: CreateProcess with a plain argument, no `cmd`
    // parse in between. Windows and Linux have no portable "select this file", so
    // a reveal opens the folder that holds it.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    #[cfg(target_os = "macos")]
    command.arg(path);
    #[cfg(not(target_os = "macos"))]
    command.arg(match launch {
        Launch::Reveal => path.parent().unwrap_or(path),
        Launch::Open | Launch::Folder => path,
    });
    command
}

fn os_launch(mut command: Command) -> Result<(), String> {
    match command.status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(ERR_FAILED.to_string()),
    }
}

/// What `download_reveal` and `download_open` do after the IPC plumbing: refuse a
/// kind that must not be opened, resolve the name inside `root`, and only then hand
/// the launcher to `run`. The commands call this with the real launcher; the tests
/// call it with one that records, so every guard sits on a path the tests run (the
/// lesson of `pdf_viewer.rs`'s review).
pub(crate) fn act_on(
    root: &Path,
    file_name: &str,
    launch: Launch,
    run: impl FnOnce(Command) -> Result<(), String>,
) -> Result<(), String> {
    if launch == Launch::Open && !is_openable(file_name) {
        return Err(ERR_NOT_OPENABLE.to_string());
    }
    let path = resolve_in(root, file_name).map_err(|e| e.code().to_string())?;
    run(launcher(launch, &path))
}

/// `download_folder_open` after the plumbing: the folder itself, resolved.
pub(crate) fn open_folder_in(
    root: &Path,
    run: impl FnOnce(Command) -> Result<(), String>,
) -> Result<(), String> {
    let root = root.canonicalize().map_err(|_| ERR_NO_FOLDER.to_string())?;
    run(launcher(Launch::Folder, &root))
}

/// `com.apple.quarantine` as a browser writes it: flags `0081` (a download, not
/// yet approved), the time in hex seconds, the agent name, no event id.
#[cfg(target_os = "macos")]
fn quarantine_value(now: std::time::SystemTime) -> String {
    let seconds = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    format!("0081;{seconds:x};oort;")
}

#[cfg(target_os = "macos")]
fn quarantine_command(path: &Path, value: &str) -> Command {
    // The path is the absolute file this module just created, so it cannot be
    // read as an option; `xattr` takes no `--`.
    let mut c = Command::new("/usr/bin/xattr");
    c.arg("-w").arg("com.apple.quarantine").arg(value).arg(path);
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    c
}

/// Best effort: a file that could not be marked is still a saved download, and
/// failing the save here would throw away bytes the person asked for.
#[cfg(target_os = "macos")]
pub(crate) fn quarantine(path: &Path) -> bool {
    let value = quarantine_value(std::time::SystemTime::now());
    quarantine_command(path, &value)
        .status()
        .is_ok_and(|status| status.success())
}

/// Windows would need the Zone.Identifier stream and the shell does not ship
/// there yet; Linux has no equivalent attribute.
#[cfg(not(target_os = "macos"))]
pub(crate) fn quarantine(_path: &Path) -> bool {
    false
}

/// Everything `download_save` does after the IPC plumbing: write, then mark.
pub(crate) fn save_downloaded(root: &Path, raw_name: &str, bytes: &[u8]) -> Result<String, String> {
    let name = save_into(root, raw_name, bytes)?;
    quarantine(&root.join(&name));
    Ok(name)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// The name the file got in the Downloads folder (after sanitising and any
    /// ` (n)` suffix). The page keeps this and sends it back by name.
    pub file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NameRequest {
    pub file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeRequest {
    pub file_names: Vec<String>,
}

fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .download_dir()
        .map_err(|_| ERR_NO_FOLDER.to_string())
}

/// Save one downloaded attachment (raw invoke body) into the Downloads folder.
///
/// The raw body only survives the custom-protocol IPC transport; the shell CSP
/// must keep `connect-src ipc: http://ipc.localhost` (`shell_contract.rs`).
#[tauri::command]
pub async fn download_save(app: AppHandle, request: Request<'_>) -> Result<Saved, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ERR_NOT_RAW.to_string());
    };
    // Refuse before copying 100 MiB into the blocking task.
    check_size(bytes.len()).map_err(str::to_string)?;
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let root = downloads_dir(&app)?;
    let bytes = bytes.clone();
    // File IO and the xattr tool both block; keep them off the async workers
    // (the same reasoning as `open_pdf_attachment`).
    tauri::async_runtime::spawn_blocking(move || {
        save_downloaded(&root, &name, &bytes).map(|file_name| Saved { file_name })
    })
    .await
    .map_err(|_| ERR_FAILED.to_string())?
}

/// Which of these files are still in the Downloads folder (same order).
#[tauri::command]
pub async fn download_probe(app: AppHandle, request: ProbeRequest) -> Result<Vec<bool>, String> {
    let root = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        probe_in(&root, &request.file_names).map_err(str::to_string)
    })
    .await
    .map_err(|_| ERR_FAILED.to_string())?
}

/// Show one saved file in the file manager.
#[tauri::command]
pub async fn download_reveal(app: AppHandle, request: NameRequest) -> Result<(), String> {
    let root = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        act_on(&root, &request.file_name, Launch::Reveal, os_launch)
    })
    .await
    .map_err(|_| ERR_FAILED.to_string())?
}

/// Open one saved file with its default application, unless it is a kind that
/// runs or installs what it is given (`is_openable`).
#[tauri::command]
pub async fn download_open(app: AppHandle, request: NameRequest) -> Result<(), String> {
    let root = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        act_on(&root, &request.file_name, Launch::Open, os_launch)
    })
    .await
    .map_err(|_| ERR_FAILED.to_string())?
}

/// Open the Downloads folder itself. No argument: nothing of the webview's
/// reaches the launcher.
#[tauri::command]
pub async fn download_folder_open(app: AppHandle) -> Result<(), String> {
    let root = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || open_folder_in(&root, os_launch))
        .await
        .map_err(|_| ERR_FAILED.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        check_size, is_direct_child, is_openable, is_plain_name, numbered, probe_in, resolve_in,
        safe_file_name, save_into, save_with, split_extension, NameRequest, ProbeRequest,
        Unresolved, ERR_NOT_FILE, ERR_NOT_PLAIN, ERR_TOO_LARGE, MAX_DOWNLOAD_BYTES, MAX_NAME_BYTES,
        MAX_PROBE_NAMES,
    };
    use std::path::{Path, PathBuf};

    /// A scratch Downloads folder unique to one test. Never the user's.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oort-downloads-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Names a hostile sender could pick, and a few honest ones.
    fn corpus() -> Vec<String> {
        let mut names: Vec<String> = [
            "",
            " ",
            ".",
            "..",
            "...",
            ".hidden",
            "../../etc/passwd",
            "a/b/c.txt",
            "C:\\Windows\\System32\\x.exe",
            "CON",
            "nul.txt",
            "x\u{0}y.txt",
            "line\nbreak.txt",
            "\u{202E}fdp.exe",
            "trailing dot.",
            "  spaced  .pdf",
            "report (1).pdf",
            "Q3-온보딩-리뷰.pdf",
            "archive.tar.gz",
            "no-extension",
            "ends.with.dot.",
            "a:b*c?d\"e<f>g|h.txt",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        for unit in ["가", "😀", "a"] {
            names.push(unit.repeat(400));
            names.push(format!("{}.pdf", unit.repeat(400)));
        }
        names.push(format!("x.{}", "e".repeat(80)));
        names
    }

    #[test]
    fn names_keep_their_extension_and_lose_their_structure() {
        assert_eq!(safe_file_name("Q3-온보딩-리뷰.pdf"), "Q3-온보딩-리뷰.pdf");
        assert_eq!(safe_file_name("report (1).pdf"), "report (1).pdf");
        assert_eq!(safe_file_name("archive.tar.gz"), "archive.tar.gz");
        assert_eq!(safe_file_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(safe_file_name("a/b.txt"), "a-b.txt");
        assert_eq!(safe_file_name("x\u{0}y\nz.txt"), "xyz.txt");
        assert_eq!(safe_file_name(".bashrc"), "bashrc");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name(""), "attachment");
        assert_eq!(safe_file_name("   "), "attachment");
        // Bidi override would let `x\u{202E}fdp.command` render as `x…command.pdf`.
        assert_eq!(safe_file_name("x\u{202E}dnammoc.pdf"), "xdnammoc.pdf");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("lpt1.txt"), "_lpt1.txt");
        assert_eq!(safe_file_name("trailing dot."), "trailing dot");
    }

    /// The invariant the by-name commands rest on: whatever a sender picks, the
    /// name this module saves is one `is_plain_name` accepts, within the byte
    /// limit, and sanitising twice changes nothing.
    #[test]
    fn every_name_it_saves_passes_the_gate_the_other_commands_demand() {
        for raw in corpus() {
            let name = safe_file_name(&raw);
            assert!(is_plain_name(&name), "{raw:?} -> {name:?}");
            assert!(
                name.len() <= MAX_NAME_BYTES,
                "{} bytes for {raw:?}",
                name.len()
            );
            assert_eq!(safe_file_name(&name), name, "{raw:?} is not stable");
            // Room is left for the ` (1000)` suffix inside a 255-byte file name.
            let (stem, ext) = split_extension(&name);
            assert!(numbered(stem, ext, 1000).len() <= 255);
        }
    }

    /// Bytes, not characters, and the extension survives truncation.
    #[test]
    fn a_long_name_is_cut_in_the_stem_not_the_extension() {
        for unit in ["가", "😀", "a"] {
            let name = safe_file_name(&format!("{}.pdf", unit.repeat(400)));
            assert!(
                name.len() <= MAX_NAME_BYTES,
                "{} bytes for {unit}",
                name.len()
            );
            assert!(name.ends_with(".pdf"), "{name}");
        }
        // An absurd "extension" is part of the stem, not kept whole.
        let name = safe_file_name(&format!("x.{}", "e".repeat(80)));
        assert!(name.len() <= MAX_NAME_BYTES);
    }

    #[test]
    fn the_plain_name_gate_refuses_structure() {
        for name in [
            "",
            ".",
            "..",
            ".hidden",
            "../x",
            "a/b",
            "/etc/passwd",
            "a\\b",
            "c:x",
            "x\u{0}y",
            "x\ny",
            "x\u{202E}y",
            "star*.txt",
            "evil.exe.",
            "evil.exe ",
            " lead.txt",
        ] {
            assert!(!is_plain_name(name), "{name:?} must be refused");
        }
        assert!(!is_plain_name(&"a".repeat(256)));
        for name in ["a.pdf", "report (1).pdf", "한글 파일.docx", "no-extension"] {
            assert!(is_plain_name(name), "{name:?} must pass");
        }
    }

    /// Never overwrites: the second and third save of one name get ` (1)` and
    /// ` (2)`, and the first file still holds its first bytes.
    #[test]
    fn a_second_save_never_overwrites_the_first() {
        let root = scratch("collide");
        assert_eq!(save_into(&root, "plan.pdf", b"one").unwrap(), "plan.pdf");
        assert_eq!(
            save_into(&root, "plan.pdf", b"two").unwrap(),
            "plan (1).pdf"
        );
        assert_eq!(
            save_into(&root, "plan.pdf", b"three").unwrap(),
            "plan (2).pdf"
        );
        assert_eq!(std::fs::read(root.join("plan.pdf")).unwrap(), b"one");
        assert_eq!(std::fs::read(root.join("plan (1).pdf")).unwrap(), b"two");
        assert_eq!(std::fs::read(root.join("plan (2).pdf")).unwrap(), b"three");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlink planted at the target name is not written through.
    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_target_name_is_not_written_through() {
        let root = scratch("plant");
        let outside = scratch("plant-outside");
        let victim = outside.join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        std::os::unix::fs::symlink(&victim, root.join("plan.pdf")).unwrap();
        let name = save_into(&root, "plan.pdf", b"payload").unwrap();
        assert_eq!(name, "plan (1).pdf");
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        assert_eq!(std::fs::read(root.join(&name)).unwrap(), b"payload");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Hostile names land as direct children of the folder, and nothing is
    /// created beside it.
    #[test]
    fn hostile_names_land_inside_the_folder() {
        let parent = scratch("hostile");
        let root = parent.join("Downloads");
        std::fs::create_dir_all(&root).unwrap();
        for hostile in [
            "../escape.pdf",
            "../../escape.pdf",
            "/etc/escape.pdf",
            "a/../../b.pdf",
        ] {
            let name = save_into(&root, hostile, b"x").unwrap();
            let resolved = root.join(&name).canonicalize().unwrap();
            assert_eq!(
                resolved.parent(),
                Some(root.canonicalize().unwrap().as_path())
            );
        }
        assert_eq!(listing(&parent), ["Downloads"], "nothing beside the folder");
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_missing_folder_is_refused_not_created() {
        let root = scratch("nofolder").join("not-there");
        assert_eq!(
            save_into(&root, "a.pdf", b"x"),
            Err("refused: no downloads folder".to_string())
        );
        assert!(!root.exists());
    }

    /// A half-written download does not stay under its final name, and the next
    /// attempt gets the plain name back.
    #[test]
    fn a_failed_write_leaves_no_partial_file() {
        let root = scratch("partial");
        let result = save_with(&root, "plan.pdf", |file| {
            use std::io::Write;
            file.write_all(b"half")?;
            Err(std::io::Error::other("disk went away"))
        });
        assert_eq!(result, Err("failed".to_string()));
        assert!(listing(&root).is_empty(), "{:?}", listing(&root));
        assert_eq!(save_into(&root, "plan.pdf", b"whole").unwrap(), "plan.pdf");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Measured at the boundary, so neither a disabled check nor a widened
    /// constant passes.
    #[test]
    fn the_ceiling_is_exactly_one_hundred_mib() {
        assert_eq!(MAX_DOWNLOAD_BYTES, 100 * 1024 * 1024);
        assert_eq!(check_size(MAX_DOWNLOAD_BYTES), Ok(()));
        assert_eq!(check_size(MAX_DOWNLOAD_BYTES + 1), Err(ERR_TOO_LARGE));
        assert_eq!(check_size(0), Ok(()));
    }

    #[test]
    fn resolving_finds_a_saved_file_and_only_that() {
        let root = scratch("resolve");
        let name = save_into(&root, "plan.pdf", b"x").unwrap();
        let path = resolve_in(&root, &name).unwrap();
        assert_eq!(path, root.join("plan.pdf"));
        assert_eq!(resolve_in(&root, "other.pdf"), Err(Unresolved::Missing));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The path restriction: nothing outside the Downloads folder is reachable
    /// by name, however it is spelled.
    #[test]
    fn a_name_that_points_outside_the_folder_is_refused() {
        let parent = scratch("outside");
        let root = parent.join("Downloads");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(parent.join("secret.txt"), b"s").unwrap();
        std::fs::write(root.join("ok.txt"), b"ok").unwrap();
        let absolute = parent.join("secret.txt").to_string_lossy().into_owned();
        for hostile in [
            "../secret.txt",
            "./ok.txt",
            "sub/../ok.txt",
            absolute.as_str(),
            "/etc/passwd",
            "..",
            ".",
            "",
            ".ok.txt",
            "x\u{0}y",
        ] {
            assert_eq!(
                resolve_in(&root, hostile),
                Err(Unresolved::Refused(ERR_NOT_PLAIN)),
                "{hostile:?}"
            );
        }
        assert_eq!(resolve_in(&root, "ok.txt"), Ok(root.join("ok.txt")));
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// A symlink INSIDE the folder is judged by what it is, not where it points:
    /// out of the folder, into it, or to a directory, all refused.
    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_folder_is_refused_wherever_it_points() {
        let parent = scratch("symlink");
        let root = parent.join("Downloads");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(parent.join("secret.txt"), b"s").unwrap();
        std::fs::write(root.join("real.txt"), b"r").unwrap();
        std::os::unix::fs::symlink(parent.join("secret.txt"), root.join("out.txt")).unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("in.txt")).unwrap();
        std::os::unix::fs::symlink(&parent, root.join("up")).unwrap();
        std::os::unix::fs::symlink(root.join("gone"), root.join("dangling")).unwrap();
        for link in ["out.txt", "in.txt", "up", "dangling"] {
            assert_eq!(
                resolve_in(&root, link),
                Err(Unresolved::Refused(ERR_NOT_FILE)),
                "{link}"
            );
        }
        // A real directory is not a file either.
        assert_eq!(
            resolve_in(&root, "sub"),
            Err(Unresolved::Refused(ERR_NOT_FILE))
        );
        assert_eq!(resolve_in(&root, "real.txt"), Ok(root.join("real.txt")));
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// The Downloads folder itself may be a symlink (a moved folder): that is
    /// the folder, resolved, not an escape.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_itself_a_symlink_still_works() {
        let parent = scratch("rootlink");
        let real = parent.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = parent.join("Downloads");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let name = save_into(&link, "plan.pdf", b"x").unwrap();
        assert_eq!(
            resolve_in(&link, &name).unwrap().file_name(),
            Some("plan.pdf".as_ref())
        );
        assert!(real.join("plan.pdf").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn a_missing_folder_resolves_to_nothing() {
        let root = scratch("noroot").join("gone");
        assert_eq!(
            resolve_in(&root, "a.pdf"),
            Err(Unresolved::Refused("refused: no downloads folder"))
        );
    }

    #[test]
    fn probing_reports_presence_and_reads_everything_else_as_absent() {
        let root = scratch("probe");
        let kept = save_into(&root, "kept.pdf", b"x").unwrap();
        let gone = save_into(&root, "gone.pdf", b"x").unwrap();
        std::fs::remove_file(root.join(&gone)).unwrap();
        let names = vec![
            kept.clone(),
            gone,
            "../kept.pdf".to_string(),
            "/etc/passwd".to_string(),
            String::new(),
        ];
        assert_eq!(
            probe_in(&root, &names).unwrap(),
            [true, false, false, false, false]
        );
        let many = vec![kept; MAX_PROBE_NAMES + 1];
        assert_eq!(probe_in(&root, &many), Err("refused: too many names"));
        assert_eq!(
            probe_in(&root, &many[..MAX_PROBE_NAMES]).unwrap().len(),
            MAX_PROBE_NAMES
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn what_runs_or_installs_is_never_opened_from_here() {
        for name in [
            "run.command",
            "RUN.COMMAND",
            "x.terminal",
            "setup.pkg",
            "profile.mobileconfig",
            "tool.jar",
            "do.sh",
            "do.py",
            "evil.exe",
            "page.html",
            "image.svg",
            "invoice.pdf.exe",
            "a.pdf.command",
            "Some.App",
            "x.url",
            "link.webloc",
            "evil.exe.",
            "evil.exe ",
        ] {
            assert!(!is_openable(name), "{name} must not be opened");
        }
        for name in [
            "report.pdf",
            "photo.JPG",
            "clip.mp4",
            "notes.txt",
            "sheet.xlsx",
            "archive.zip",
            "no-extension",
            "한글.hwp",
            "report (1).pdf",
            "command",
        ] {
            assert!(is_openable(name), "{name} must open");
        }
    }

    #[test]
    fn requests_refuse_a_field_they_do_not_know() {
        assert!(serde_json::from_str::<NameRequest>(r#"{"fileName":"a.pdf"}"#).is_ok());
        assert!(
            serde_json::from_str::<NameRequest>(r#"{"fileName":"a.pdf","path":"/etc"}"#).is_err()
        );
        assert!(serde_json::from_str::<NameRequest>(r#"{"path":"/etc/passwd"}"#).is_err());
        assert!(serde_json::from_str::<ProbeRequest>(r#"{"fileNames":["a.pdf"]}"#).is_ok());
        assert!(serde_json::from_str::<ProbeRequest>(r#"{"fileNames":[],"root":"/"}"#).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_launchers_end_options_before_the_path() {
        use super::{launcher, Launch};
        let file = Path::new("/Users/x/Downloads/a.pdf");
        let folder = Path::new("/Users/x/Downloads");
        for (launch, path, args) in [
            (Launch::Open, file, vec!["--", "/Users/x/Downloads/a.pdf"]),
            (
                Launch::Reveal,
                file,
                vec!["-R", "--", "/Users/x/Downloads/a.pdf"],
            ),
            (Launch::Folder, folder, vec!["--", "/Users/x/Downloads"]),
        ] {
            let command = launcher(launch, path);
            assert_eq!(command.get_program(), "/usr/bin/open");
            let got: Vec<_> = command.get_args().collect();
            assert_eq!(got, args, "{launch:?}");
        }
    }

    /// The attribute a browser writes, read back from a real file by the same
    /// system tool: a saved download is marked, and a name that could not be
    /// marked is still saved.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_file_carries_the_quarantine_attribute() {
        use super::{quarantine_command, quarantine_value, save_downloaded};
        use std::process::Command;
        let root = scratch("quarantine");
        let name = save_downloaded(&root, "plan.pdf", b"x").unwrap();
        let out = Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(root.join(&name))
            .output()
            .unwrap();
        let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(out.status.success(), "no quarantine attribute: {value:?}");
        assert!(value.starts_with("0081;"), "{value}");
        assert!(value.ends_with(";oort;"), "{value}");
        let command = quarantine_command(
            Path::new("/tmp/x"),
            &quarantine_value(std::time::UNIX_EPOCH),
        );
        assert_eq!(command.get_program(), "/usr/bin/xattr");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            ["-w", "com.apple.quarantine", "0081;0;oort;", "/tmp/x"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What the launcher was asked to run, as plain strings.
    fn recorded(command: &std::process::Command) -> (String, Vec<String>) {
        (
            command.get_program().to_string_lossy().into_owned(),
            command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
        )
    }

    /// The command-level guards, on the path the commands themselves run: a file
    /// outside the folder, a symlink, a name with structure and a kind that runs or
    /// installs are refused BEFORE anything is launched.
    #[test]
    fn nothing_is_launched_for_a_refused_name() {
        use super::{act_on, Launch};
        use std::cell::RefCell;
        let parent = scratch("act-refused");
        let root = parent.join("Downloads");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(parent.join("secret.txt"), b"s").unwrap();
        std::fs::write(root.join("setup.command"), b"#!/bin/sh\n").unwrap();
        std::fs::write(root.join("page.html"), b"<html>").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(parent.join("secret.txt"), root.join("link.txt")).unwrap();
        let launched: RefCell<Vec<(String, Vec<String>)>> = RefCell::new(Vec::new());
        let run = |c: std::process::Command| {
            launched.borrow_mut().push(recorded(&c));
            Ok(())
        };
        let outside = parent.join("secret.txt").to_string_lossy().into_owned();
        for launch in [Launch::Open, Launch::Reveal] {
            for hostile in [
                "../secret.txt",
                outside.as_str(),
                "/etc/passwd",
                "..",
                "",
                "sub/x",
            ] {
                assert_eq!(
                    act_on(&root, hostile, launch, run),
                    Err("refused: not a plain file name".to_string()),
                    "{launch:?} {hostile:?}"
                );
            }
            assert_eq!(
                act_on(&root, "missing.pdf", launch, run),
                Err("missing".to_string())
            );
            #[cfg(unix)]
            assert_eq!(
                act_on(&root, "link.txt", launch, run),
                Err("refused: not a regular file".to_string())
            );
        }
        // Kinds that run or install: not opened, but they can still be revealed.
        for name in ["setup.command", "page.html"] {
            assert_eq!(
                act_on(&root, name, Launch::Open, run),
                Err("refused: this kind of file is not opened from here".to_string()),
                "{name}"
            );
        }
        assert!(
            launched.borrow().is_empty(),
            "launched: {:?}",
            launched.borrow()
        );
        assert!(act_on(&root, "setup.command", Launch::Reveal, run).is_ok());
        assert_eq!(launched.borrow().len(), 1);
        let _ = std::fs::remove_dir_all(&parent);
    }

    /// The happy path launches exactly the resolved file, with the right verb.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_file_is_opened_or_revealed_by_its_resolved_path() {
        use super::{act_on, open_folder_in, Launch};
        use std::cell::RefCell;
        let root = scratch("act-ok");
        let name = save_into(&root, "plan.pdf", b"x").unwrap();
        let file = root.join(&name).to_string_lossy().into_owned();
        let launched: RefCell<Vec<(String, Vec<String>)>> = RefCell::new(Vec::new());
        let run = |c: std::process::Command| {
            launched.borrow_mut().push(recorded(&c));
            Ok(())
        };
        act_on(&root, &name, Launch::Open, run).unwrap();
        act_on(&root, &name, Launch::Reveal, run).unwrap();
        open_folder_in(&root, run).unwrap();
        let open = "/usr/bin/open".to_string();
        assert_eq!(
            launched.borrow().as_slice(),
            [
                (open.clone(), vec!["--".to_string(), file.clone()]),
                (open.clone(), vec!["-R".to_string(), "--".to_string(), file]),
                (
                    open,
                    vec!["--".to_string(), root.to_string_lossy().into_owned()]
                ),
            ]
        );
        // A launcher failure is the caller's answer, not swallowed.
        assert_eq!(
            act_on(&root, &name, Launch::Open, |_| Err("failed".to_string())),
            Err("failed".to_string())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A refusal names the rule that fired, so a test cannot pass on the wrong
    /// reason and a failed click is diagnosable.
    #[test]
    fn a_refusal_says_which_rule_refused() {
        let root = scratch("reasons");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let code = |name: &str| resolve_in(&root, name).map_err(Unresolved::code);
        assert_eq!(code("../x"), Err("refused: not a plain file name"));
        assert_eq!(code("sub"), Err("refused: not a regular file"));
        assert_eq!(code("nothing.pdf"), Err("missing"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The resolved file must be a DIRECT child. `starts_with` would also
    /// accept a nested file and the lexical `sub/../x` form.
    #[test]
    fn only_a_direct_child_of_the_folder_counts() {
        let root = Path::new("/home/me/Downloads");
        assert!(is_direct_child(root, Path::new("/home/me/Downloads/a.pdf")));
        assert!(!is_direct_child(
            root,
            Path::new("/home/me/Downloads/sub/a.pdf")
        ));
        assert!(!is_direct_child(
            root,
            Path::new("/home/me/Downloads/sub/../a.pdf")
        ));
        assert!(!is_direct_child(
            root,
            Path::new("/home/me/Downloads/../a.pdf")
        ));
        assert!(!is_direct_child(root, Path::new("/home/me/a.pdf")));
        assert!(!is_direct_child(root, Path::new("/home/me/Downloads")));
    }
}
