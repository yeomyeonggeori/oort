//! #4970 (ADR-0151 증보 4 D7) — the PDF text child, as a **real process**: the worker binary re-run with
//! `--attachment-text-child`. No database; these run in an ordinary `cargo test`.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_real_child_reads_a_pdf_and_says_what_it_could_not` | the child protocol (stdin → one JSON line), or reading the PDF anywhere but in the child |
//! | `the_child_starts_with_an_empty_environment` | `.env_clear()` on the child command |
//! | `a_child_that_never_answers_is_killed_at_the_deadline_and_reaped` | the kill/reap after the deadline |
//! | `a_child_that_answers_before_reading_everything_is_not_an_error_of_the_parent` | treating a closed stdin as a failure |
//! | `a_child_that_answers_with_too_much_or_with_nonsense_is_unreadable` | the output cap / the closed answer shape |
//! | `a_pdf_over_the_input_ceiling_never_starts_a_child` | the input ceiling |
//! | `a_child_that_could_not_confine_itself_is_the_servers_fault_not_the_files` | mapping the child's "could not confine myself" status to `Unavailable` |
//! | `a_well_formed_answer_over_the_output_cap_is_refused` | `take(CHILD_OUTPUT_MAX + 1)` and the `data.len() > CHILD_OUTPUT_MAX` refusal (the nonsense test above is not JSON, so it passes without them) |
//! | `both_slots_stay_taken_while_two_real_children_run` | giving the slot back before the child is reaped (`let _permit = permit;` → `drop(permit)`) |
//! | `a_stream_that_inflates_far_past_its_size_is_ended_by_the_memory_watch` | the supervisor's memory watch (`over_memory` in the race, or its comparison with the ceiling), the kill by pid, the reap before the slot returns |
//! | `the_shipped_ceiling_ends_a_child_that_inflates_past_it` | `CHILD_MEMORY_MAX` / `CHILD_MEMORY_POLL` as shipped (the guard the worker really uses, with only a sink added) |
//! | `a_child_ends_itself_at_its_own_deadline_when_nothing_ends_it` | the watchdog thread `child_main_with` starts |
//! | `the_child_confines_itself_before_any_thread_pool_exists_and_still_reads` | the child branch of `main` running after the async runtime was built (#4970 review R2-1): the child must be its main thread and its watchdog, whatever `TOKIO_WORKER_THREADS` says, and a plain PDF must still read |
//! | `a_child_confines_itself_before_it_reads_a_byte` (Linux) | `oom_score_adj` 1000, the address-space ceiling and the core-dump limit 0 `confine_self` sets |
//! | `the_core_row_of_proc_limits_is_a_zero_limit_only_when_both_limits_are_zero` | reading the Linux test's `Max core file size` row (the row is parsed on every platform, so the parse is measured here and not first on CI) |

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use momo_agent_worker::attachment_text::{
    child_main_with, extract_pdf_text, extract_pdf_text_guarded, ExtractError, MemoryGuard,
    CHILD_ARG, CHILD_MEMORY_MAX, WATCHDOG_EXIT_CODE,
};

const CEILING: usize = 5 * 1024 * 1024;

/// The child slots are **process-wide** (two, whoever asks — that is the contract), so tests that start
/// children take turns instead of racing each other into `Busy`.
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn worker_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_momo-agent-worker"))
}

/// A one-page PDF whose text is `lines`.
fn pdf_with(lines: &[&str]) -> Vec<u8> {
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
    });
    let resources_id = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font_id } });
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
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.compress();
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

/// A throwaway "child": a shell script the test writes, so the parent's supervision can be measured
/// against a program that misbehaves in exactly one way.
fn script(name: &str, body: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "oort-4970-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

async fn read_with(
    program: &Path,
    bytes: Vec<u8>,
    deadline: Duration,
) -> Result<String, ExtractError> {
    extract_pdf_text(bytes, Some(program), CEILING, deadline).await
}

#[tokio::test]
async fn the_real_child_reads_a_pdf_and_says_what_it_could_not() {
    let _serial = serial().await;
    let child = worker_binary();
    let deadline = Duration::from_secs(20);
    let letters = read_with(
        &child,
        pdf_with(&["Quarterly plan", "ORT-4970-LETTERS"]),
        deadline,
    )
    .await
    .expect("a text PDF has letters");
    assert!(
        letters.contains("Quarterly plan") && letters.contains("ORT-4970-LETTERS"),
        "{letters:?}"
    );
    assert_eq!(
        read_with(&child, pdf_with(&[]), deadline).await,
        Err(ExtractError::NoText),
        "a page with no letters"
    );
    for broken in [
        b"%PDF-1.7 this is not a document".to_vec(),
        b"<html>no</html>".to_vec(),
        vec![0u8; 8192],
        Vec::new(),
    ] {
        assert_eq!(
            read_with(&child, broken, deadline).await,
            Err(ExtractError::Unreadable)
        );
    }
    // the argument is the whole switch: the same binary with no argument is the worker, not the child
    assert_eq!(CHILD_ARG, "--attachment-text-child");
}

/// The child parses bytes an attacker wrote, so it inherits nothing. The "child" here prints what it was
/// given: `HOME` is in every test environment, and it is not in the child's.
#[tokio::test]
async fn the_child_starts_with_an_empty_environment() {
    let _serial = serial().await;
    assert!(
        std::env::var_os("HOME").is_some(),
        "the test process has a HOME, or this test proves nothing"
    );
    let probe = script(
        "env",
        r#"printf '{"ok":true,"text":"HOME=[%s] DB=[%s] KEY=[%s]"}\n' "${HOME-unset}" "${DATABASE_URL-unset}" "${PROVIDER_LINK_MASTER_KEY-unset}""#,
    );
    let text = read_with(&probe, pdf_with(&["x"]), Duration::from_secs(10))
        .await
        .expect("the probe answers");
    assert_eq!(text, "HOME=[unset] DB=[unset] KEY=[unset]");
    let _ = std::fs::remove_file(&probe);
}

#[tokio::test]
async fn a_child_that_never_answers_is_killed_at_the_deadline_and_reaped() {
    let _serial = serial().await;
    let pid_file =
        std::env::temp_dir().join(format!("oort-4970-pid-{}", uuid::Uuid::new_v4().simple()));
    let hang = script(
        "hang",
        &format!("echo $$ > '{}'\nexec sleep 30", pid_file.display()),
    );
    let started = Instant::now();
    let answer = read_with(&hang, pdf_with(&["x"]), Duration::from_millis(600)).await;
    assert_eq!(answer, Err(ExtractError::Unreadable));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the parent did not wait for the child: {:?}",
        started.elapsed()
    );
    // the child is gone — checked by its own pid, never by a name
    let pid = std::fs::read_to_string(&pid_file)
        .expect("the child wrote its pid")
        .trim()
        .to_string();
    assert!(pid.chars().all(|c| c.is_ascii_digit()) && !pid.is_empty());
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(!alive, "the child {pid} outlived its deadline");
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&hang);
}

#[tokio::test]
async fn a_child_that_answers_before_reading_everything_is_not_an_error_of_the_parent() {
    let _serial = serial().await;
    let eager = script("eager", r#"printf '{"ok":true,"text":"answered"}\n'"#);
    // a big input the child never reads: the closed pipe is its answer, not a failure
    let big = vec![b'x'; 3 * 1024 * 1024];
    assert_eq!(
        read_with(&eager, big, Duration::from_secs(10)).await,
        Ok("answered".to_string())
    );
    let _ = std::fs::remove_file(&eager);
}

#[tokio::test]
async fn a_child_that_answers_with_too_much_or_with_nonsense_is_unreadable() {
    let _serial = serial().await;
    let flood = script("flood", "head -c 2000000 /dev/zero | tr '\\0' 'a'");
    assert_eq!(
        read_with(&flood, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unreadable),
        "an answer beyond the cap"
    );
    let nonsense = script("nonsense", r#"printf 'not json at all\n'"#);
    assert_eq!(
        read_with(&nonsense, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unreadable)
    );
    let failing = script("failing", r#"printf '{"ok":true,"text":"fine"}\n'; exit 3"#);
    assert_eq!(
        read_with(&failing, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unreadable),
        "an answer from a child that then failed is not trusted"
    );
    let missing = PathBuf::from("/nonexistent/oort-4970-child");
    assert_eq!(
        read_with(&missing, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unavailable),
        "no child, no parse — the parent never falls back to reading the PDF itself, and it is the server's \
         fault, not the file's (#4970 review L1: the caller must not blame the file)"
    );
    for path in [flood, nonsense, failing] {
        let _ = std::fs::remove_file(path);
    }
}

/// #4970 review L1 (the same split as a child that cannot start): a child that ends with the status it
/// uses for 「I could not confine myself, so I read nothing」 says something about this machine and nothing
/// about the file, and the caller must not tell the person their file is broken.
#[tokio::test]
async fn a_child_that_could_not_confine_itself_is_the_servers_fault_not_the_files() {
    let _serial = serial().await;
    let unconfined = script("unconfined", "exit 2");
    assert_eq!(
        read_with(&unconfined, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unavailable)
    );
    // any other failing status is still the file's: the child ran and gave up on it
    let gave_up = script("gave-up", "exit 3");
    assert_eq!(
        read_with(&gave_up, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unreadable)
    );
    for path in [unconfined, gave_up] {
        let _ = std::fs::remove_file(path);
    }
}

#[tokio::test]
async fn a_pdf_over_the_input_ceiling_never_starts_a_child() {
    let _serial = serial().await;
    // a program that would write a marker file if it ever ran
    let marker =
        std::env::temp_dir().join(format!("oort-4970-ran-{}", uuid::Uuid::new_v4().simple()));
    let tripwire = script(
        "tripwire",
        &format!(
            "echo ran > '{}'\nprintf '{{\"ok\":true,\"text\":\"ran\"}}\\n'",
            marker.display()
        ),
    );
    let answer = extract_pdf_text(
        vec![b'%'; 2048],
        Some(&tripwire),
        1024,
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(answer, Err(ExtractError::Unreadable));
    assert!(!marker.exists(), "an over-long input started the child");
    let _ = std::fs::remove_file(&tripwire);
}

// --- the two guards a review found nothing was measuring (#4970 수리) -----------------------------------

/// 출력 상한: 넘치는 답이 **올바른 JSON 한 줄**이어도 거절해야 해요.
#[tokio::test]
async fn a_well_formed_answer_over_the_output_cap_is_refused() {
    let _serial = serial().await;
    let big = script(
        "bigjson",
        r#"printf '{"ok":true,"text":"'; head -c 2000000 /dev/zero | tr '\0' 'a'; printf '"}\n'"#,
    );
    assert_eq!(
        read_with(&big, pdf_with(&["x"]), Duration::from_secs(10)).await,
        Err(ExtractError::Unreadable),
        "a 2 MB answer was accepted"
    );
    let _ = std::fs::remove_file(&big);
}

/// 슬롯: 진짜로 도는 자식 둘이 있는 동안 셋째는 즉시 Busy, 둘이 회수된 뒤에는 슬롯이 돌아와요.
#[tokio::test]
async fn both_slots_stay_taken_while_two_real_children_run() {
    let _serial = serial().await;
    let hang = script("hang2", "exec sleep 20");
    let (p1, p2) = (hang.clone(), hang.clone());
    let h1 =
        tokio::spawn(
            async move { read_with(&p1, pdf_with(&["x"]), Duration::from_millis(1500)).await },
        );
    let h2 =
        tokio::spawn(
            async move { read_with(&p2, pdf_with(&["x"]), Duration::from_millis(1500)).await },
        );
    tokio::time::sleep(Duration::from_millis(400)).await;
    let started = Instant::now();
    assert_eq!(
        read_with(&hang, pdf_with(&["x"]), Duration::from_millis(1500)).await,
        Err(ExtractError::Busy)
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(h1.await.unwrap(), Err(ExtractError::Unreadable));
    assert_eq!(h2.await.unwrap(), Err(ExtractError::Unreadable));
    let fast = script("fast", r#"printf '{"ok":true,"text":"back"}\n'"#);
    assert_eq!(
        read_with(&fast, pdf_with(&["x"]), Duration::from_secs(5)).await,
        Ok("back".to_string())
    );
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

/// A page whose content stream is a few kilobytes on disk and `mebibytes` MiB once its three
/// `FlateDecode` layers are opened. Written with the crates the child reads it with.
fn inflating_pdf(mebibytes: usize) -> Vec<u8> {
    use lopdf::{dictionary, Dictionary, Document, Object, Stream};
    let zeros = vec![0u8; 1024 * 1024];
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    for _ in 0..mebibytes {
        encoder.write_all(&zeros).unwrap();
    }
    let innermost = encoder.finish().unwrap();
    let packed = deflate(&deflate(&innermost));
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut dict = Dictionary::new();
    dict.set(
        "Filter",
        Object::Array(vec![Object::Name(b"FlateDecode".to_vec()); 3]),
    );
    let content_id = doc.add_object(Stream::new(dict, packed));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

/// One gigabyte once opened, built once per test run: the same bytes serve every test that needs them.
fn shared_bomb() -> Vec<u8> {
    static BOMB: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BOMB.get_or_init(|| inflating_pdf(1024)).clone()
}

/// ADR-0151 증보 4 D7: the memory of a child is bounded by the supervisor, not by luck. The ceiling here
/// is small so a debug build reaches it fast; the **real** child reads the file. Three things are
/// measured: it ends `Unreadable`, the watch **saw** it cross the ceiling and was not far behind it
/// (`peak` is the highest size the watch sampled — a child that ended by itself, or was left to inflate
/// the whole stream, would not leave that trace), and the slot is back for the next file.
#[tokio::test]
async fn a_stream_that_inflates_far_past_its_size_is_ended_by_the_memory_watch() {
    let _serial = serial().await;
    const CEILING_BYTES: u64 = 64 * 1024 * 1024;
    const OVERSHOOT_BYTES: u64 = 512 * 1024 * 1024;
    let bomb = shared_bomb();
    assert!(
        bomb.len() < 256 * 1024,
        "the file stays small ({} bytes) while what it opens into is a gigabyte",
        bomb.len()
    );
    let bomb_len = bomb.len();
    let peak = Arc::new(AtomicU64::new(0));
    let guard = MemoryGuard {
        max_bytes: CEILING_BYTES,
        poll: Duration::from_millis(25),
        peak: Some(peak.clone()),
    };
    let child = worker_binary();
    let started = Instant::now();
    let answer =
        extract_pdf_text_guarded(bomb, Some(&child), CEILING, Duration::from_secs(60), guard).await;
    let took = started.elapsed();
    assert_eq!(answer, Err(ExtractError::Unreadable));
    let seen = peak.load(Ordering::SeqCst);
    eprintln!(
        "memory watch: file {} bytes, highest sample {} MiB, ended after {took:?}",
        bomb_len,
        seen / (1024 * 1024)
    );
    assert!(
        seen > CEILING_BYTES,
        "the watch never saw the child cross the ceiling (highest sample {seen} bytes)"
    );
    assert!(
        seen < CEILING_BYTES + OVERSHOOT_BYTES,
        "the child was ended after it had used {seen} bytes"
    );
    assert!(took < Duration::from_secs(40), "ended after {took:?}");
    // the slot is back and the next file is read
    let next = read_with(
        &child,
        pdf_with(&["after the stream"]),
        Duration::from_secs(20),
    )
    .await
    .expect("the next PDF reads");
    assert!(next.contains("after the stream"), "{next:?}");
}

/// The guard **as shipped** — `CHILD_MEMORY_MAX` and `CHILD_MEMORY_POLL`, the numbers the worker really
/// runs with — ends the same stream: the highest sample is above the shipped ceiling and well short of the
/// stream's size. (The test above proves the mechanism with a small ceiling; this one proves the shipped
/// numbers are not decorative. Needs the container, if any, to allow the child about a gigabyte.)
#[tokio::test]
async fn the_shipped_ceiling_ends_a_child_that_inflates_past_it() {
    let _serial = serial().await;
    let peak = Arc::new(AtomicU64::new(0));
    let guard = MemoryGuard {
        peak: Some(peak.clone()),
        ..MemoryGuard::PRODUCTION
    };
    let child = worker_binary();
    let answer = extract_pdf_text_guarded(
        shared_bomb(),
        Some(&child),
        CEILING,
        Duration::from_secs(60),
        guard,
    )
    .await;
    assert_eq!(answer, Err(ExtractError::Unreadable));
    let seen = peak.load(Ordering::SeqCst);
    eprintln!(
        "shipped ceiling: {} MiB, highest sample {} MiB",
        CHILD_MEMORY_MAX / (1024 * 1024),
        seen / (1024 * 1024)
    );
    assert!(
        seen > CHILD_MEMORY_MAX,
        "the shipped watch never saw the child cross the shipped ceiling (highest sample {seen} bytes)"
    );
    assert!(
        seen < CHILD_MEMORY_MAX + 512 * 1024 * 1024,
        "the child was ended after it had used {seen} bytes"
    );
}

// --- the child's own confinement, measured from outside ----------------------------------------------
//
// This test binary re-runs **itself** as the child: `OORT_4970_CHILD_PROBE=<ms>` makes the named test
// call `child_main_with` and exit with its code, the way the worker binary does with
// `--attachment-text-child`. The parent keeps the probe's stdin open and writes nothing, which is what a
// child looks like whose supervisor has stopped answering.

/// Call at the top of a probe test: becomes the child when asked to.
fn become_the_child_if_asked() {
    if let Some(ms) = std::env::var("OORT_4970_CHILD_PROBE")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        std::process::exit(child_main_with(CEILING, Duration::from_millis(ms)));
    }
}

fn spawn_probe(test: &str, self_deadline_ms: u64) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env("OORT_4970_CHILD_PROBE", self_deadline_ms.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn a_child_ends_itself_at_its_own_deadline_when_nothing_ends_it() {
    become_the_child_if_asked();
    let mut probe = spawn_probe(
        "a_child_ends_itself_at_its_own_deadline_when_nothing_ends_it",
        700,
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = probe.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = probe.kill();
            let _ = probe.wait();
            panic!("the child never ended itself");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(status.code(), Some(WATCHDOG_EXIT_CODE));
    assert!(
        started.elapsed() >= Duration::from_millis(600),
        "it ended before its own deadline: {:?}",
        started.elapsed()
    );
}

/// How many threads process `pid` has right now: the `Threads:` line of `/proc/<pid>/status` on Linux, the
/// rows `ps -M` prints under its header (one per thread) elsewhere. `None` when the process is gone or the
/// answer is not understood.
fn threads_of(pid: u32) -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        status
            .lines()
            .find_map(|line| line.strip_prefix("Threads:"))?
            .trim()
            .parse()
            .ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let listing = std::process::Command::new("/bin/ps")
            .args(["-M", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let rows = String::from_utf8_lossy(&listing.stdout)
            .lines()
            .count()
            .checked_sub(1)?;
        (rows > 0).then_some(rows)
    }
}

/// #4970 review R2-1: the child limits its own address space as its first act, and that ceiling counts every
/// thread's stack and allocator arena — so the child must be **one thread** (plus the watchdog it starts
/// itself) when it does, not one worker per visible core. The real worker binary is run as the child, since
/// only `main` decides whether a runtime exists before the child branch (this test binary re-running itself
/// cannot see that). `TOKIO_WORKER_THREADS` is what a multi-threaded tokio runtime reads when it is built:
/// the supervisor never sets it (the child has an empty environment), this test does so that a runtime
/// started first is unmistakable — sixty-four workers, on any machine. The thread count is read while the
/// child waits for its input (this test holds its stdin open), over a window that ends well after the
/// watchdog exists, and then the same child is given an ordinary PDF and must read it.
#[test]
fn the_child_confines_itself_before_any_thread_pool_exists_and_still_reads() {
    let mut child = std::process::Command::new(worker_binary())
        .arg(CHILD_ARG)
        .env_clear()
        .env("TOKIO_WORKER_THREADS", "64")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the worker binary starts as the child");
    let pid = child.id();
    let started = Instant::now();
    let mut highest = 0usize;
    let mut watchdog_seen_at: Option<Instant> = None;
    loop {
        if let Some(threads) = threads_of(pid) {
            highest = highest.max(threads);
            // the watchdog is the child's own second act: once a second thread exists it is waiting for input
            if threads >= 2 && watchdog_seen_at.is_none() {
                watchdog_seen_at = Some(Instant::now());
            }
        }
        let settled = watchdog_seen_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(500));
        if settled || started.elapsed() > Duration::from_secs(8) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut input = child.stdin.take().expect("stdin was piped");
    input
        .write_all(&pdf_with(&["ORT-4970-ONE-THREAD"]))
        .expect("the child is still reading");
    drop(input);
    let output = child.wait_with_output().expect("the child ends");
    eprintln!("child threads while it waited for input: highest {highest}");
    assert_eq!(
        highest, 2,
        "a child that confines itself before any thread pool exists is its main thread and its own \
         watchdog (2); more means a runtime was started first, fewer that it never got as far as the watchdog"
    );
    assert!(
        output.status.success(),
        "the child ended with {:?}",
        output.status
    );
    let answer: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("the child answers with one JSON line");
    assert_eq!(answer["ok"], true, "{answer}");
    assert!(
        answer["text"]
            .as_str()
            .is_some_and(|text| text.contains("ORT-4970-ONE-THREAD")),
        "{answer}"
    );
}

/// A row of `/proc/<pid>/limits` — `Max core file size        0        0        bytes` — is a zero limit
/// when the soft **and** the hard value are `0` (a soft 0 under a hard `unlimited` can be raised again).
fn core_limit_is_zero(row: &str) -> bool {
    let fields: Vec<&str> = row.split_whitespace().collect();
    fields.get(..4) == Some(&["Max", "core", "file", "size"][..])
        && fields.get(4) == Some(&"0")
        && fields.get(5) == Some(&"0")
}

#[test]
fn the_core_row_of_proc_limits_is_a_zero_limit_only_when_both_limits_are_zero() {
    let row = |soft: &str, hard: &str| {
        format!("Max core file size        {soft:<20} {hard:<20} bytes     ")
    };
    assert!(core_limit_is_zero(&row("0", "0")));
    // the shapes a container starts with: the child left alone would still be able to dump
    assert!(!core_limit_is_zero(&row("0", "unlimited")));
    assert!(!core_limit_is_zero(&row("unlimited", "unlimited")));
    assert!(!core_limit_is_zero(&row("1048576", "0")));
    // another row, or nothing at all, is never read as the core limit
    assert!(!core_limit_is_zero(
        "Max address space         0                    0                    bytes"
    ));
    assert!(!core_limit_is_zero(""));
}

/// `oom_score_adj`, the address-space ceiling and the core-dump limit are the kernel's to enforce, so they are
/// read back from the kernel: `/proc/<pid>/oom_score_adj` and `/proc/<pid>/limits` of a child blocked on its
/// stdin.
#[cfg(target_os = "linux")]
#[test]
fn a_child_confines_itself_before_it_reads_a_byte() {
    become_the_child_if_asked();
    let mut probe = spawn_probe("a_child_confines_itself_before_it_reads_a_byte", 60_000);
    let pid = probe.id();
    let ceiling = momo_agent_worker::attachment_text::CHILD_ADDRESS_SPACE_MAX.to_string();
    let started = Instant::now();
    let (adj, row, core) = loop {
        let adj = std::fs::read_to_string(format!("/proc/{pid}/oom_score_adj")).unwrap_or_default();
        let limits = std::fs::read_to_string(format!("/proc/{pid}/limits")).unwrap_or_default();
        let limit_row = |name: &str| {
            limits
                .lines()
                .find(|line| line.starts_with(name))
                .unwrap_or_default()
                .to_string()
        };
        let row = limit_row("Max address space");
        let core = limit_row("Max core file size");
        if (adj.trim() == "1000" && row.contains(&ceiling) && core_limit_is_zero(&core))
            || started.elapsed() > Duration::from_secs(10)
        {
            break (adj, row, core);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = probe.kill();
    let _ = probe.wait();
    assert_eq!(
        adj.trim(),
        "1000",
        "the kernel's out-of-memory killer must pick the child first"
    );
    assert!(
        row.contains(&ceiling),
        "the address-space ceiling is not in place: {row:?}"
    );
    assert!(
        core_limit_is_zero(&core),
        "the child must leave no core dump (soft and hard limit 0): {core:?}"
    );
}
