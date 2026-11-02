//! The letters of a file the team's helper was asked to read (ADR-0201 증보 v3 B6-1, #4970; ADR-0151
//! 증보 4).
//!
//! * **A text file** (`text/plain`, `text/markdown`, `text/csv`, `application/json`): UTF-8 (a byte-order
//!   mark is dropped), else EUC-KR — the legacy encoding Korean text files still come in, which
//!   `encoding_rs` reads as the CP949 superset — accepted only when it decodes without a single
//!   error. Anything else is "not text".
//! * **A PDF**: [`lopdf`] (MIT). PDF is an attacker-writable format and `lopdf` inflates a stream with
//!   no ceiling, so it is **never parsed in the worker's own address space**: [`extract_pdf_text`]
//!   re-executes this very binary as `momo-agent-worker --attachment-text-child` — the way
//!   `momo-expressions` runs its picture decoder — hands it the bytes on stdin and reads one bounded
//!   JSON line from stdout, under a deadline after which the child is killed and reaped. The child is
//!   started with an **empty environment** (it must not inherit the database URL, the master key or a
//!   provider key), and at most [`CHILD_SLOTS`] run at once, process-wide, whoever asks.
//!
//! What a hostile PDF can do is spend the child's CPU for [`CHILD_DEADLINE`] and its memory; a panic,
//! a hang and an endless loop end with the child, not with the worker. The memory is bounded three
//! ways, none of which needs `unsafe` (the workspace forbids it) and all of which hold in the child's
//! address space or beside it, never the worker's own:
//!
//! * **the child confines itself first** (`confine_self`, its first act, before it reads a byte): on
//!   Linux a ceiling on its address space ([`CHILD_ADDRESS_SPACE_MAX`], `RLIMIT_AS` through the safe
//!   `rlimit` wrapper `momo-expressions` already uses) and `oom_score_adj` 1000, so that when the
//!   container's memory limit is reached the kernel's out-of-memory killer is steered to the child and
//!   not the worker (which may hold a model — the killer takes the largest process, and the child is only
//!   the largest by chance; the write is best effort and is ignored where `/proc` refuses it); on every
//!   unix, no core dump (`RLIMIT_CORE` 0); and on Linux the process is marked **not dumpable**
//!   (`PR_SET_DUMPABLE` 0, through the safe `rustix` — #5072), which no core-dump handler can ignore the way a
//!   host that pipes cores can ignore a limit. It does so as a single thread — `main` starts no async
//!   runtime on this path, because the address-space ceiling counts every thread's stack and arena;
//! * **the supervisor watches** ([`MemoryGuard`]): every [`CHILD_MEMORY_POLL`] it reads the child's
//!   resident memory (`/proc/<pid>/status` on Linux, `ps` elsewhere) and, above [`CHILD_MEMORY_MAX`],
//!   kills that very pid and reaps it before the slot is given back;
//! * **the child has a deadline of its own** ([`CHILD_SELF_DEADLINE`]): a watchdog thread ends the
//!   process when the supervisor is no longer there to (the worker itself was killed).
//!
//! After the limits and the watchdog thread the child **locks itself down** (`attachment_lockdown`, #5072): a
//! system-call filter that, on every thread, refuses a file by name, a socket, another program and another
//! process for the rest of its life. A parser that were somehow talked into running code could then neither
//! read `/proc/<worker>/environ` nor reach the database, a shell or the worker's memory. Every step of the
//! confinement is required: a child that cannot take one reads nothing and tells its supervisor **which**
//! ([`ConfineStep`], a closed list), so a host that refuses a limit is one warning line away from a diagnosis
//! and not a PDF reader that is silently open.
//!
//! macOS enforces no address-space ceiling, so there only the supervisor's watch bounds the memory
//! (the image this ships in is Linux). The watch is a sample, not a fence: what a child allocates inside
//! one [`CHILD_MEMORY_POLL`] is bounded by the address-space ceiling and nothing else.
//!
//! No text from a file is ever logged or put in an error: every failure is one of the closed codes
//! of [`ExtractError`].

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::attachment_lockdown::lock_down;

/// The argument that turns this binary into the PDF text child (see `main.rs`).
pub const CHILD_ARG: &str = "--attachment-text-child";
/// How many PDF children may run at once, **process-wide**.
pub const CHILD_SLOTS: usize = 2;
/// The longest a child may take before it is killed.
pub const CHILD_DEADLINE: Duration = Duration::from_secs(8);
/// The most the parent reads from a child: far above what [`CHILD_TEXT_STOP_CHARS`] can produce.
const CHILD_OUTPUT_MAX: usize = 512 * 1024;
/// The child stops reading pages once it holds this many characters (the caller shows 20,000).
const CHILD_TEXT_STOP_CHARS: usize = 60_000;
/// The child reads at most this many pages.
const PDF_PAGES_MAX: usize = 60;
/// The most resident memory (RSS) a PDF child may hold. Above it the supervisor kills that pid. A real
/// document needs a small fraction of this (the bytes are at most 5 MiB and only the pages being read
/// are opened); the room is for a page of dense vector art, not for a stream that inflates on purpose.
pub const CHILD_MEMORY_MAX: u64 = 512 * 1024 * 1024;
/// How often the supervisor looks at the child's resident memory. A child grows by about a hundred
/// megabytes in this long at worst, which is what [`CHILD_MEMORY_MAX`] leaves room for before the
/// address-space ceiling.
pub const CHILD_MEMORY_POLL: Duration = Duration::from_millis(50);
/// The address space the child limits itself to at its first act (Linux, `RLIMIT_AS`). It is a **virtual**
/// ceiling — the loaded executable, thread stacks and allocator arenas count — so it is far above
/// [`CHILD_MEMORY_MAX`] and stands behind it, for what the supervisor's sample cannot see.
pub const CHILD_ADDRESS_SPACE_MAX: u64 = 4 * 1024 * 1024 * 1024;
/// The child's own deadline: two seconds after the supervisor's, so the supervisor's kill is the normal end
/// and this one is what is left when the supervisor is gone.
pub const CHILD_SELF_DEADLINE: Duration = Duration::from_secs(CHILD_DEADLINE.as_secs() + 2);
/// The exit status of a child that ended itself at its own deadline (`timeout(1)`'s).
pub const WATCHDOG_EXIT_CODE: i32 = 124;
/// The exit status of a child that could not confine itself and so read nothing.
const CONFINE_FAILED_EXIT_CODE: i32 = 2;

// The numbers stand in the order the module docs promise, or this does not compile: the child's own deadline is
// after the supervisor's (the supervisor's kill is the normal end, this one is for a supervisor that is gone),
// the sampled ceiling is below the address-space ceiling that stands behind it, and a look is more often than
// half a second.
const _: () = {
    assert!(CHILD_SELF_DEADLINE.as_secs() > CHILD_DEADLINE.as_secs());
    assert!(CHILD_MEMORY_MAX < CHILD_ADDRESS_SPACE_MAX);
    assert!(CHILD_MEMORY_POLL.as_millis() < 500);
};

/// What the supervisor holds a child's memory to (see the module docs). The worker always uses
/// [`MemoryGuard::PRODUCTION`]; a test passes a smaller ceiling and a sink for the highest size the watch
/// saw, so that "the watch ended it" can be told from "it ended by itself".
#[derive(Debug, Clone)]
pub struct MemoryGuard {
    /// Above this many resident bytes the child is killed.
    pub max_bytes: u64,
    /// How often the child is looked at.
    pub poll: Duration,
    /// Where the highest resident size seen is kept (tests only; `None` in production).
    pub peak: Option<Arc<AtomicU64>>,
}

impl MemoryGuard {
    /// The guard the worker uses.
    pub const PRODUCTION: MemoryGuard = MemoryGuard {
        max_bytes: CHILD_MEMORY_MAX,
        poll: CHILD_MEMORY_POLL,
        peak: None,
    };
}

/// Why no letters came out. Closed, so a caller can keep it in an audit row: it names no file, no
/// path and no text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractError {
    /// All [`CHILD_SLOTS`] are taken; asking again in a moment is the right answer.
    Busy,
    /// The file opened and no letters were in it (a scan, an encrypted file, a picture of a page).
    NoText,
    /// **This file** cannot be read: not the encoding or the format it claims, broken, too complex for
    /// the child's time or memory, or an answer from a child that failed. Asking again will not change it,
    /// and the caller says so (#4970 review L1).
    Unreadable,
    /// **The server** could not try: the child could not be started or its pipes opened. Nothing is known
    /// about the file; asking again in a moment is the right answer.
    Unavailable,
}

// ---------------------------------------------------------------------------
// text files
// ---------------------------------------------------------------------------

/// A text file's letters: UTF-8 (BOM dropped), else EUC-KR with **no** decoding error, else `Err`.
pub fn text_from_bytes(bytes: &[u8]) -> Result<String, ExtractError> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_string());
    }
    let (text, _, had_errors) = encoding_rs::EUC_KR.decode(bytes);
    if had_errors {
        return Err(ExtractError::Unreadable);
    }
    Ok(text.into_owned())
}

// ---------------------------------------------------------------------------
// PDF — the parser, which runs only in the child
// ---------------------------------------------------------------------------

/// A PDF's letters, page by page, stopping at [`PDF_PAGES_MAX`] pages or [`CHILD_TEXT_STOP_CHARS`]
/// characters. **Call this only in the child** (and in tests): it is the code that trusts an
/// attacker's bytes to be a PDF.
pub fn pdf_text(bytes: &[u8]) -> Result<String, ExtractError> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|_| ExtractError::Unreadable)?;
    // An encrypted file's streams are ciphertext: whatever `extract` returned would be noise.
    if doc.is_encrypted() {
        return Err(ExtractError::NoText);
    }
    let pages: Vec<u32> = doc
        .get_pages()
        .keys()
        .copied()
        .take(PDF_PAGES_MAX)
        .collect();
    let mut text = String::new();
    let mut chars = 0usize;
    for page in pages {
        // one page at a time, so a page that cannot be read costs that page and not the file
        for chunk in doc.extract_text_chunks(&[page]).into_iter().flatten() {
            chars += chunk.chars().count();
            text.push_str(&chunk);
        }
        text.push('\n');
        if chars >= CHILD_TEXT_STOP_CHARS {
            break;
        }
    }
    if text.trim().is_empty() {
        return Err(ExtractError::NoText);
    }
    Ok(text.chars().take(CHILD_TEXT_STOP_CHARS * 2).collect())
}

/// The steps of the child's confinement, as a closed list. The child tells its supervisor which one it could not
/// take as one of these words and nothing the operating system said: the supervisor logs the word (and only a
/// word it knows), so a host that refuses a step is one warning line from a diagnosis, and the child — which
/// parses bytes an attacker wrote — cannot put text of its own into that log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfineStep {
    /// `RLIMIT_CORE` to 0, soft and hard.
    CoreLimit,
    /// `RLIMIT_AS` (Linux).
    AddressSpace,
    /// `PR_SET_DUMPABLE` to 0 (Linux).
    Dumpable,
    /// The thread that ends the child at its own deadline.
    Watchdog,
    /// The system-call filter (Linux).
    Filter,
}

impl ConfineStep {
    /// Every step, in the order the child takes them.
    pub const ALL: [ConfineStep; 5] = [
        ConfineStep::CoreLimit,
        ConfineStep::AddressSpace,
        ConfineStep::Dumpable,
        ConfineStep::Watchdog,
        ConfineStep::Filter,
    ];

    /// The word for the log and for the child's answer.
    pub const fn word(self) -> &'static str {
        match self {
            ConfineStep::CoreLimit => "core_limit",
            ConfineStep::AddressSpace => "address_space",
            ConfineStep::Dumpable => "dumpable",
            ConfineStep::Watchdog => "watchdog",
            ConfineStep::Filter => "filter",
        }
    }
}

/// What the child does to itself before it reads a byte: the limits half of the confinement (module docs); the
/// filter that follows is [`lock_down`].
///
/// * **No core dump** (unix, #4970 review R2-5): `RLIMIT_CORE` goes to 0, soft and hard. A hostile file ends
///   a child with a crash every so often (a stack that is too deep, an allocation that fails), and a core
///   dump of it would hold the requester's document and the parser's state on the host's disk. Lowering a
///   limit is always allowed, and the hard limit goes down with the soft one so that nothing which runs in
///   the child can raise it again.
/// * **Not dumpable** (Linux, #5072 — the half of R2-5 a limit cannot do): `PR_SET_DUMPABLE` goes to 0. A host
///   that pipes cores to a handler of its own (`core_pattern` starting with `|`) does not ask the dumping
///   process's `RLIMIT_CORE` — the kernel ignores the limit for a pipe and leaves it to the handler — but it
///   does ask whether the process is dumpable first, for a file and for a pipe alike. The same flag also makes
///   `/proc/<pid>/` of this process belong to root, so a process of the same user (the worker) cannot read
///   its `environ`, `mem` or `fd` either. **It is the last of the three** on purpose: from then on the
///   child's own `/proc/self/*` files are root's and an unprivileged write to `oom_score_adj` would be refused.
/// * On Linux `oom_score_adj` goes to 1000 — raising it needs no privilege, and the write is best effort
///   because the ceiling below does not depend on it — and the address space is limited to
///   [`CHILD_ADDRESS_SPACE_MAX`], or to the hard limit the child was already given when that is lower
///   (lowering a limit is always allowed; raising a hard one is not).
///
/// Anything that cannot be set is an `Err` naming the step, and a child that cannot confine itself reads nothing.
fn confine_self() -> Result<(), ConfineStep> {
    // the one write that needs `/proc/self` to still be ours: before the process stops being dumpable
    #[cfg(target_os = "linux")]
    {
        let _ = std::fs::write("/proc/self/oom_score_adj", "1000");
    }
    #[cfg(unix)]
    {
        rlimit::Resource::CORE
            .set(0, 0)
            .map_err(|_| ConfineStep::CoreLimit)?;
    }
    #[cfg(target_os = "linux")]
    {
        let (_, hard) = rlimit::Resource::AS
            .get()
            .map_err(|_| ConfineStep::AddressSpace)?;
        let ceiling = CHILD_ADDRESS_SPACE_MAX.min(hard);
        rlimit::Resource::AS
            .set(ceiling, ceiling)
            .map_err(|_| ConfineStep::AddressSpace)?;
        rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable)
            .map_err(|_| ConfineStep::Dumpable)?;
    }
    Ok(())
}

/// A thread that calls `expire` once `deadline` has passed, whatever the rest of the process is doing.
/// The child's `expire` ends the process ([`WATCHDOG_EXIT_CODE`]); a test passes a flag.
fn spawn_watchdog<F>(deadline: Duration, expire: F) -> std::io::Result<()>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name("attachment-text-watchdog".to_string())
        .spawn(move || {
            std::thread::sleep(deadline);
            expire();
        })
        .map(drop)
}

/// The child's whole life: PDF bytes on stdin → one JSON line on stdout → exit status. Returns the
/// process exit code. Reads at most `max_input + 1` bytes; an over-long input is the same
/// "unreadable" as a broken one. Ends itself after [`CHILD_SELF_DEADLINE`].
pub fn child_main(max_input: usize) -> i32 {
    child_main_with(max_input, CHILD_SELF_DEADLINE)
}

/// [`child_main`] with the child's own deadline chosen by the caller (a test re-runs itself as the child
/// with a short one). The first acts are the confinement, in this order: the limits ([`confine_self`]), the
/// watchdog thread, and the system-call filter ([`lock_down`]) — last, and on every thread, so that the
/// watchdog is under it too. Nothing the file says has been read yet when they are in place, and a child that
/// cannot take one of them reads nothing and says which ([`ConfineStep`]).
pub fn child_main_with(max_input: usize, self_deadline: Duration) -> i32 {
    use std::io::{Read, Write};
    let confined = confine_self()
        .and_then(|()| {
            spawn_watchdog(self_deadline, || std::process::exit(WATCHDOG_EXIT_CODE))
                .map_err(|_| ConfineStep::Watchdog)
        })
        .and_then(|()| lock_down().map_err(|_| ConfineStep::Filter));
    if let Err(step) = confined {
        return confine_failed(step);
    }
    let mut bytes = Vec::new();
    let read = std::io::stdin()
        .lock()
        .take(max_input as u64 + 1)
        .read_to_end(&mut bytes);
    let answer = match read {
        Ok(_) if bytes.len() <= max_input => match pdf_text(&bytes) {
            Ok(text) => json!({"ok": true, "text": text}),
            Err(ExtractError::NoText) => json!({"ok": false, "code": "no_text"}),
            Err(_) => json!({"ok": false, "code": "unreadable"}),
        },
        _ => json!({"ok": false, "code": "unreadable"}),
    };
    let mut out = std::io::stdout().lock();
    if out
        .write_all(answer.to_string().as_bytes())
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush())
        .is_err()
    {
        return 1;
    }
    0
}

/// The child could not take `step`: it says so in one JSON line — the step's word, nothing the system said —
/// and ends with [`CONFINE_FAILED_EXIT_CODE`], having read nothing.
fn confine_failed(step: ConfineStep) -> i32 {
    use std::io::Write;
    let answer = json!({"ok": false, "code": "confine_failed", "step": step.word()});
    let mut out = std::io::stdout().lock();
    let _ = out
        .write_all(answer.to_string().as_bytes())
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush());
    CONFINE_FAILED_EXIT_CODE
}

/// The step a child that could not confine itself named, for the supervisor's log: one of [`ConfineStep`]'s
/// words or `"unknown"`. A child parses attacker bytes, so whatever else it printed is never logged.
fn confine_step_in(data: &[u8]) -> &'static str {
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        return "unknown";
    };
    let named = value.get("step").and_then(Value::as_str);
    ConfineStep::ALL
        .into_iter()
        .map(ConfineStep::word)
        .find(|word| Some(*word) == named)
        .unwrap_or("unknown")
}

// ---------------------------------------------------------------------------
// PDF — the supervisor, which runs in the worker
// ---------------------------------------------------------------------------

fn slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(CHILD_SLOTS)))
        .clone()
}

/// The path the child is started from: the configured one, else this very executable.
fn child_path(configured: Option<&Path>) -> Option<PathBuf> {
    match configured {
        Some(path) => Some(path.to_path_buf()),
        None => std::env::current_exe().ok(),
    }
}

/// A PDF's letters, read by a supervised child process (see the module docs).
///
/// `child` is where the worker binary is (`None`: this process's own executable, which is what a
/// deployment uses; a test that is not the worker passes the built binary's path). The supervisor is
/// spawned as its own task and holds its slot until the child has exited **and been reaped**, so
/// cancelling the caller's turn cannot leave a child running unaccounted for.
pub async fn extract_pdf_text(
    bytes: Vec<u8>,
    child: Option<&Path>,
    max_input: usize,
    deadline: Duration,
) -> Result<String, ExtractError> {
    extract_pdf_text_guarded(bytes, child, max_input, deadline, MemoryGuard::PRODUCTION).await
}

/// [`extract_pdf_text`] with the memory guard chosen by the caller: the worker always passes
/// [`MemoryGuard::PRODUCTION`] (through `extract_pdf_text`); a test passes a smaller ceiling.
pub async fn extract_pdf_text_guarded(
    bytes: Vec<u8>,
    child: Option<&Path>,
    max_input: usize,
    deadline: Duration,
    guard: MemoryGuard,
) -> Result<String, ExtractError> {
    let Some(path) = child_path(child) else {
        return Err(ExtractError::Unavailable);
    };
    let Ok(permit) = slots().try_acquire_owned() else {
        return Err(ExtractError::Busy);
    };
    tokio::spawn(async move {
        let _permit = permit;
        run_child(bytes, path, max_input, deadline, guard).await
    })
    .await
    .map_err(|_| ExtractError::Unavailable)?
}

/// The resident memory of process `pid` in bytes — `None` when it cannot be read (the process is gone) or
/// when this platform has no cheap way to ask.
async fn resident_bytes(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        resident_from_status(&status)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let answer = tokio::process::Command::new("/bin/ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .await
            .ok()?;
        resident_from_ps(&answer.stdout)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// `VmRSS` of a Linux `/proc/<pid>/status`, in bytes. The kernel prints it in kibibytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn resident_from_status(status: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib: u64 = line
        .trim_start_matches("VmRSS:")
        .trim()
        .strip_suffix("kB")?
        .trim()
        .parse()
        .ok()?;
    kib.checked_mul(1024)
}

/// `ps -o rss=` prints the resident size in kibibytes, alone on a line.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn resident_from_ps(output: &[u8]) -> Option<u64> {
    let kib: u64 = std::str::from_utf8(output).ok()?.trim().parse().ok()?;
    kib.checked_mul(1024)
}

/// Completes when `pid` holds more than the guard's ceiling; never completes for a child whose memory
/// cannot be read. The highest size seen goes to the guard's sink, if it has one.
async fn over_memory(pid: Option<u32>, guard: &MemoryGuard) {
    let Some(pid) = pid else {
        return std::future::pending().await;
    };
    loop {
        tokio::time::sleep(guard.poll).await;
        let Some(resident) = resident_bytes(pid).await else {
            continue;
        };
        if let Some(peak) = &guard.peak {
            peak.fetch_max(resident, Ordering::SeqCst);
        }
        if resident > guard.max_bytes {
            return;
        }
    }
}

async fn run_child(
    bytes: Vec<u8>,
    path: PathBuf,
    max_input: usize,
    deadline: Duration,
    guard: MemoryGuard,
) -> Result<String, ExtractError> {
    if bytes.len() > max_input {
        return Err(ExtractError::Unreadable);
    }
    let mut child = tokio::process::Command::new(path)
        .arg(CHILD_ARG)
        // The child parses bytes an attacker wrote: it inherits nothing — not the database URL, not
        // the master key, not a provider key.
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ExtractError::Unavailable)?;
    let (Some(mut input), Some(mut output)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(ExtractError::Unavailable);
    };
    // The pid the memory watch looks at (and, through `child`, the only process this supervisor ever kills).
    let pid = child.id();
    let work = async {
        let write = async {
            // A child that answers before reading everything closes the pipe: that is its answer.
            let _ = input.write_all(&bytes).await;
            let _ = input.shutdown().await;
            drop(input);
        };
        let read = async {
            let mut data = Vec::new();
            let result = (&mut output)
                .take(CHILD_OUTPUT_MAX as u64 + 1)
                .read_to_end(&mut data)
                .await;
            result.map(|_| data)
        };
        let ((), data) = tokio::join!(write, read);
        let data = data.map_err(|_| ExtractError::Unavailable)?;
        if data.len() > CHILD_OUTPUT_MAX {
            return Err(ExtractError::Unreadable);
        }
        let status = child.wait().await.map_err(|_| ExtractError::Unavailable)?;
        // A child that could not confine itself read nothing: that is this machine, not the file. Every PDF
        // fails this way until the host allows the step, so the line names it (a word from a closed list).
        if status.code() == Some(CONFINE_FAILED_EXIT_CODE) {
            tracing::warn!(
                step = confine_step_in(&data),
                "the PDF child could not confine itself and read nothing; this host refuses a step the child \
                 requires, so no PDF is read here until it allows it"
            );
            return Err(ExtractError::Unavailable);
        }
        if !status.success() {
            return Err(ExtractError::Unreadable);
        }
        parse_answer(&data)
    };
    // The work, the deadline and the memory watch race; whichever ends first wins, and the child is dealt
    // with below the same way for all three.
    let outcome = tokio::time::timeout(deadline, async {
        tokio::select! {
            result = work => result,
            () = over_memory(pid, &guard) => Err(ExtractError::Unreadable),
        }
    })
    .await;
    // Whatever happened, the child is gone and reaped before the slot is given back.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    outcome.unwrap_or(Err(ExtractError::Unreadable))
}

/// The child's one JSON line, or "unreadable".
fn parse_answer(data: &[u8]) -> Result<String, ExtractError> {
    let value: Value = serde_json::from_slice(data).map_err(|_| ExtractError::Unreadable)?;
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => value
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(ExtractError::Unreadable),
        Some(false) => match value.get("code").and_then(Value::as_str) {
            Some("no_text") => Err(ExtractError::NoText),
            _ => Err(ExtractError::Unreadable),
        },
        None => Err(ExtractError::Unreadable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};

    /// A one-page PDF whose text is `lines`, one `Tj` each. Built with the same crate the child
    /// reads it with, so the two cannot disagree about the format.
    pub(crate) fn tiny_pdf(lines: &[&str], compress: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let mut operations = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 14.into()]),
            Operation::new("TL", vec![16.into()]),
            Operation::new("Td", vec![50.into(), 700.into()]),
        ];
        for line in lines {
            operations.push(Operation::new("Tj", vec![Object::string_literal(*line)]));
            operations.push(Operation::new("T*", vec![]));
        }
        operations.push(Operation::new("ET", vec![]));
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            Content { operations }.encode().unwrap(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        if compress {
            doc.compress();
        }
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_text_file_is_utf8_or_euc_kr_and_nothing_else() {
        assert_eq!(
            text_from_bytes("안녕 hello\n".as_bytes()).unwrap(),
            "안녕 hello\n"
        );
        // a byte-order mark is not a letter
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("가나다".as_bytes());
        assert_eq!(text_from_bytes(&bom).unwrap(), "가나다");
        // the encoding a Korean Notepad still writes
        let (legacy, _, unmappable) = encoding_rs::EUC_KR.encode("회의록: 다음 주 월요일에 만나요");
        assert!(!unmappable);
        assert!(
            std::str::from_utf8(&legacy).is_err(),
            "the fixture must not be UTF-8"
        );
        assert_eq!(
            text_from_bytes(&legacy).unwrap(),
            "회의록: 다음 주 월요일에 만나요"
        );
        // bytes that are neither are refused, never guessed at
        assert_eq!(
            text_from_bytes(&[0xFF, 0xFE, 0xFD, 0xC0, 0xC1]),
            Err(ExtractError::Unreadable)
        );
    }

    #[test]
    fn a_pdfs_letters_come_out_page_by_page_compressed_or_not() {
        for compress in [false, true] {
            let pdf = tiny_pdf(&["Quarterly plan", "second line"], compress);
            assert!(pdf.starts_with(b"%PDF-"));
            let text = pdf_text(&pdf).expect("a text PDF has letters");
            assert!(text.contains("Quarterly plan"), "{compress}: {text:?}");
            assert!(text.contains("second line"), "{compress}: {text:?}");
        }
    }

    #[test]
    fn a_pdf_with_no_letters_or_no_pdf_at_all_is_a_closed_code() {
        assert_eq!(pdf_text(&tiny_pdf(&[], false)), Err(ExtractError::NoText));
        assert_eq!(
            pdf_text(b"%PDF-1.7 not really"),
            Err(ExtractError::Unreadable)
        );
        assert_eq!(pdf_text(&[]), Err(ExtractError::Unreadable));
        assert_eq!(pdf_text(&[0u8; 4096]), Err(ExtractError::Unreadable));
        // a PDF cut in half is damaged, and says so without panicking
        let pdf = tiny_pdf(&["half"], true);
        let _ = pdf_text(&pdf[..pdf.len() / 2]);
    }

    /// RUSTSEC-2026-0187: lopdf before 0.42 read nested arrays with unbounded recursion, so a ~21 KB
    /// file ended the process with a stack overflow (`SIGABRT`, which `catch_unwind` cannot stop). The
    /// child would have died and been answered as unreadable; the parser must now refuse the file
    /// itself. This calls `pdf_text` in the test process, where an abort takes the test binary down.
    #[test]
    fn a_pdf_nested_ten_thousand_deep_is_refused_and_does_not_crash() {
        let depth = 10_380;
        let mut pdf = b"%PDF-1.7\n".to_vec();
        let catalog_at = pdf.len();
        pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R /X ");
        pdf.extend(vec![b'['; depth]);
        pdf.extend(vec![b']'; depth]);
        pdf.extend_from_slice(b" >>\nendobj\n");
        let pages_at = pdf.len();
        pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n");
        let xref_at = pdf.len();
        pdf.extend_from_slice(
            format!(
                "xref\n0 3\n0000000000 65535 f \n{catalog_at:010} 00000 n \n{pages_at:010} 00000 n \n\
                 trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
            )
            .as_bytes(),
        );
        assert!(pdf_text(&pdf).is_err());
    }

    #[test]
    fn the_childs_answer_is_one_closed_json_line() {
        assert_eq!(
            parse_answer(br#"{"ok":true,"text":"abc"}"#),
            Ok("abc".to_string())
        );
        assert_eq!(
            parse_answer(br#"{"ok":false,"code":"no_text"}"#),
            Err(ExtractError::NoText)
        );
        for bad in [
            &br#"{"ok":false,"code":"anything else"}"#[..],
            br#"{"ok":true}"#,
            br#"{"text":"abc"}"#,
            b"not json",
            b"",
        ] {
            assert_eq!(parse_answer(bad), Err(ExtractError::Unreadable));
        }
    }

    #[test]
    fn the_resident_size_is_read_from_what_the_platform_prints() {
        // Linux: `VmRSS` in kibibytes, among other lines.
        let status =
            "Name:\tmomo-agent-worker\nVmPeak:\t  900000 kB\nVmRSS:\t  123456 kB\nThreads:\t4\n";
        assert_eq!(resident_from_status(status), Some(123_456 * 1024));
        // no such line (a zombie prints none), a unit that is not kB, a number that is not one
        assert_eq!(resident_from_status("Name:\tx\nState:\tZ (zombie)\n"), None);
        assert_eq!(resident_from_status("VmRSS:\t 12 MB\n"), None);
        assert_eq!(resident_from_status("VmRSS:\t lots kB\n"), None);
        // `VmHWM` (the peak) is not the size now
        assert_eq!(resident_from_status("VmHWM:\t 999 kB\n"), None);
        // macOS and the BSDs: `ps -o rss=` is one number in kibibytes
        assert_eq!(resident_from_ps(b"  2048\n"), Some(2048 * 1024));
        assert_eq!(resident_from_ps(b""), None);
        assert_eq!(resident_from_ps(b"RSS\n"), None);
    }

    /// The watch is only as good as its reading: a live process must read as a size, and one that is not
    /// there as nothing (the supervisor keeps looking until the work ends). Where the platform has no way
    /// to ask, `None` is the honest answer and the other guards stand alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_live_process_has_a_resident_size_and_a_gone_one_has_none() {
        let own = resident_bytes(std::process::id()).await;
        assert!(
            own.is_some_and(|bytes| bytes > 1024 * 1024),
            "this test process holds more than a megabyte: {own:?}"
        );
        let mut gone = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        assert_eq!(resident_bytes(pid).await, None);
    }

    #[test]
    fn the_watchdog_fires_at_its_deadline_and_not_before() {
        use std::sync::atomic::AtomicBool;
        let fired = Arc::new(AtomicBool::new(false));
        let flag = fired.clone();
        spawn_watchdog(Duration::from_millis(1000), move || {
            flag.store(true, Ordering::SeqCst)
        })
        .expect("a thread can start");
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !fired.load(Ordering::SeqCst),
            "it fired before its deadline"
        );
        let started = std::time::Instant::now();
        while !fired.load(Ordering::SeqCst) {
            assert!(started.elapsed() < Duration::from_secs(5), "it never fired");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// #4970 review R2-5: `confine_self` leaves the child no core dump. Limits belong to the process that
    /// sets them — lowering them in the test process would change every test that runs beside this one — so
    /// the test runs itself again as a probe (`OORT_4970_CONFINE_PROBE`), which confines itself and prints
    /// the core limit it was left with. Soft **and** hard: a soft 0 under a hard `unlimited` can be raised
    /// again by whatever runs in the child, and `unlimited` is also what a plain shell starts with.
    #[cfg(unix)]
    #[test]
    fn a_child_leaves_itself_no_core_dump() {
        const PROBE: &str = "OORT_4970_CONFINE_PROBE";
        if std::env::var_os(PROBE).is_some() {
            confine_self().expect("a child can confine itself");
            let (soft, hard) = rlimit::Resource::CORE.get().expect("a limit can be read");
            println!("OORT-4970-CORE {soft} {hard}");
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "attachment_text::tests::a_child_leaves_itself_no_core_dump",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(PROBE, "1")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("the test binary can run itself");
        // the harness prints `test <name> ... ` on the same line before the test's own output
        let printed = String::from_utf8_lossy(&output.stdout);
        let found: Vec<&str> = printed
            .split_whitespace()
            .skip_while(|word| *word != "OORT-4970-CORE")
            .take(3)
            .collect();
        assert_eq!(
            found,
            ["OORT-4970-CORE", "0", "0"],
            "the core-dump limit the confined child was left with (soft, hard); the probe printed {printed:?}"
        );
    }

    /// #5072: the step a child that could not confine itself names is one of the closed words or `unknown`.
    /// The child parses attacker bytes, so nothing else it prints reaches the supervisor's log.
    #[test]
    fn the_step_a_child_names_is_a_word_of_the_closed_list_and_nothing_else() {
        for step in ConfineStep::ALL {
            let answer = json!({"ok": false, "code": "confine_failed", "step": step.word()});
            assert_eq!(confine_step_in(answer.to_string().as_bytes()), step.word());
        }
        // the words are distinct, or two steps would read as one
        let mut words: Vec<&str> = ConfineStep::ALL
            .into_iter()
            .map(ConfineStep::word)
            .collect();
        words.sort_unstable();
        words.dedup();
        assert_eq!(words.len(), ConfineStep::ALL.len());
        // anything else — a word of its own, another type, text that is not JSON, nothing — is `unknown`
        for other in [
            br#"{"ok":false,"code":"confine_failed","step":"DATABASE_URL=postgres://x"}"#
                .as_slice(),
            br#"{"ok":false,"code":"confine_failed","step":7}"#.as_slice(),
            br#"{"ok":false,"code":"confine_failed"}"#.as_slice(),
            b"filter",
            b"",
        ] {
            assert_eq!(confine_step_in(other), "unknown");
        }
    }

    /// The probe's verdict for one attempt: `allowed`, or the errno that refused it. A socket that has nobody to
    /// accept yet answers "would block", which is the system call being allowed to run.
    #[cfg(target_os = "linux")]
    fn probe_verdict(result: std::io::Result<()>) -> String {
        match result {
            Ok(()) => "allowed".to_string(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => "allowed".to_string(),
            Err(error) => format!("errno {}", error.raw_os_error().unwrap_or(-1)),
        }
    }

    /// #5072 (ADR-0151 증보 6 B): what a locked-down child is refused, measured **in a real process that did it**.
    /// The filter is irreversible, so the test runs itself again as a probe (`OORT_5072_LOCKDOWN_PROBE=<address>`):
    /// the probe asks for the same eight things twice, before and after `confine_self` + the watchdog +
    /// `lock_down` — the order the child takes them in.
    ///
    /// Before, every one of them works. That is the control: a refusal that the machine's own sandbox already
    /// makes would show up here, and "after" would prove nothing. After, each is refused with `EPERM` itself —
    /// not "no such file" and not "access denied", which a missing path or a file mode would say — and what a PDF
    /// read still needs (memory, the clock, a thread's sleep, standard output) is untouched.
    ///
    /// Measured here: `openat`, `socket`, `connect`, `accept4`, `execve`, `pidfd_open`. The rest of the filter's list
    /// is held by `attachment_lockdown::tests`, which runs the compiled filter on every entry.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_locked_down_child_is_refused_every_file_socket_program_and_process_it_asks_for() {
        const PROBE: &str = "OORT_5072_LOCKDOWN_PROBE";
        const PARENT: &str = "OORT_5072_PARENT";
        const THIS_TEST: &str = "attachment_text::tests::a_locked_down_child_is_refused_every_file_socket_program_and_process_it_asks_for";
        if let Some(address) = std::env::var_os(PROBE) {
            let address = address.to_string_lossy().to_string();
            let parent: i32 = std::env::var(PARENT).unwrap().parse().unwrap();
            // sockets that exist before the lock-down, so that `connect` and `accept` are asked about on their own
            let udp =
                std::net::UdpSocket::bind("127.0.0.1:0").expect("a socket before the lock-down");
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("a listener before the lock-down");
            listener.set_nonblocking(true).unwrap();
            let scratch =
                std::env::temp_dir().join(format!("oort-5072-probe-{}", std::process::id()));
            let attempt = |when: &str| {
                let pid = rustix::process::Pid::from_raw(parent).expect("a pid");
                let attempts: Vec<(&str, std::io::Result<()>)> = vec![
                    ("open a file", std::fs::File::open("/etc/passwd").map(drop)),
                    (
                        "open the worker's environ",
                        std::fs::File::open(format!("/proc/{parent}/environ")).map(drop),
                    ),
                    ("create a file", std::fs::File::create(&scratch).map(drop)),
                    (
                        "make a socket",
                        std::net::UdpSocket::bind("127.0.0.1:0").map(drop),
                    ),
                    ("connect a socket it already had", udp.connect(&address)),
                    (
                        "accept on a listener it already had",
                        listener.accept().map(drop),
                    ),
                    (
                        "start a program",
                        std::process::Command::new("/bin/true").status().map(drop),
                    ),
                    (
                        "look at the worker as a process",
                        rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())
                            .map(drop)
                            .map_err(std::io::Error::from),
                    ),
                ];
                for (what, result) in attempts {
                    println!("OORT-5072 | {when} | {what} | {}", probe_verdict(result));
                }
            };
            attempt("before");
            confine_self().expect("the limits can be taken");
            // read back now: once the filter is on, the probe cannot open a file to read it
            let oom_score_adj = std::fs::read_to_string("/proc/self/oom_score_adj")
                .map(|text| text.trim().to_string())
                .unwrap_or_else(|error| format!("unreadable: {error}"));
            spawn_watchdog(Duration::from_secs(120), || {
                std::process::exit(WATCHDOG_EXIT_CODE)
            })
            .expect("the watchdog starts");
            lock_down().expect("the filter can be installed");
            attempt("after");
            // what the kernel says about the process itself (asked of the kernel, not of our own bookkeeping)
            println!(
                "OORT-5072 | after | dumpable | {:?}",
                rustix::process::dumpable_behavior().expect("the flag can be read")
            );
            println!("OORT-5072 | after | oom_score_adj | {oom_score_adj}");
            // what reading a PDF still needs: memory (and the calls the allocator makes for it), a thread's
            // sleep, the clock
            let mut big = vec![0u8; 64 * 1024 * 1024];
            for chunk in big.chunks_mut(4096) {
                chunk[0] = 1;
            }
            let started = std::time::Instant::now();
            std::thread::sleep(Duration::from_millis(20));
            let worked = big.iter().step_by(4096).all(|byte| *byte == 1)
                && started.elapsed() >= Duration::from_millis(20);
            println!(
                "OORT-5072 | after | allocate, touch and sleep | {}",
                if worked { "allowed" } else { "broken" }
            );
            // unlinking is not on the list: the probe clears up after itself
            let _ = std::fs::remove_file(&scratch);
            std::process::exit(0);
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", THIS_TEST, "--nocapture", "--test-threads=1"])
            .env(PROBE, listener.local_addr().unwrap().to_string())
            .env(PARENT, std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            .output()
            .expect("the test binary can run itself");
        // the harness prints `test <name> ... ` on the same line before the probe's first line
        let printed = String::from_utf8_lossy(&output.stdout).to_string();
        let verdicts: Vec<(String, String, String)> = printed
            .lines()
            .filter_map(|line| line.split_once("OORT-5072 | ").map(|(_, rest)| rest))
            .filter_map(|rest| {
                let mut parts = rest.split(" | ");
                Some((
                    parts.next()?.to_string(),
                    parts.next()?.to_string(),
                    parts.next()?.trim().to_string(),
                ))
            })
            .collect();
        let verdict_of = |when: &str, what: &str| {
            verdicts
                .iter()
                .find(|(w, t, _)| w == when && t == what)
                .map(|(_, _, verdict)| verdict.clone())
                .unwrap_or_else(|| format!("(no line) in {printed:?}"))
        };
        const EPERM: &str = "errno 1";
        for what in [
            "open a file",
            "open the worker's environ",
            "create a file",
            "make a socket",
            "connect a socket it already had",
            "accept on a listener it already had",
            "start a program",
        ] {
            assert_eq!(
                verdict_of("before", what),
                "allowed",
                "{what}: the control — without the lock-down the probe can do it"
            );
            assert_eq!(
                verdict_of("after", what),
                EPERM,
                "{what}: after the lock-down it is refused by the filter itself"
            );
        }
        // `pidfd_open` needs a kernel from 5.3 and a runtime that lets it through: where the control is not
        // "allowed" this line measures nothing, and says so instead of passing quietly
        let before = verdict_of("before", "look at the worker as a process");
        if before == "allowed" {
            assert_eq!(
                verdict_of("after", "look at the worker as a process"),
                EPERM,
                "looking at another process"
            );
        } else {
            eprintln!("pidfd_open was already refused before the lock-down ({before}): that line is not measured here");
        }
        assert_eq!(
            verdict_of("after", "allocate, touch and sleep"),
            "allowed",
            "a lock-down that breaks the allocator or the clock reads no PDF"
        );
        // not dumpable, whoever runs the test (asked of the kernel through `PR_GET_DUMPABLE`) …
        assert_eq!(
            verdict_of("after", "dumpable"),
            "NotDumpable",
            "the child must not be dumpable"
        );
        // … and `oom_score_adj` was written before that flag made `/proc/self` root's. Only an unprivileged user
        // is refused the write afterwards: where the test runs as root this line measures nothing, and says so.
        assert_eq!(
            verdict_of("after", "oom_score_adj"),
            "1000",
            "the out-of-memory killer must be steered to the child"
        );
        if rustix::process::geteuid().is_root() {
            eprintln!(
                "this run is root: the order of `oom_score_adj` and the not-dumpable flag is not measured here \
                 (root may write a root-owned file); an unprivileged run is"
            );
        }
        let _ = std::fs::remove_file(
            std::env::temp_dir().join(format!("oort-5072-probe-{}", std::process::id())),
        );
    }

    #[test]
    fn the_slots_are_two_and_a_third_asker_is_told_busy() {
        // Holding both permits is what two running children look like.
        let first = slots().try_acquire_owned().expect("first slot");
        let second = slots().try_acquire_owned().expect("second slot");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let busy = runtime.block_on(extract_pdf_text(
            tiny_pdf(&["x"], false),
            None,
            1024 * 1024,
            Duration::from_secs(1),
        ));
        assert_eq!(busy, Err(ExtractError::Busy));
        drop((first, second));
        assert_eq!(CHILD_SLOTS, 2);
    }
}
