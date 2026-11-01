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

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use momo_agent_worker::attachment_text::{extract_pdf_text, ExtractError, CHILD_ARG};

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
        Err(ExtractError::Unreadable),
        "no child, no parse — the parent never falls back to reading the PDF itself"
    );
    for path in [flood, nonsense, failing] {
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
