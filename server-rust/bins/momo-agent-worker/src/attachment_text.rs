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
//! What a hostile PDF can still do is spend the child's CPU for [`CHILD_DEADLINE`] and its memory until
//! the kernel or the container's limit ends it; a panic, a hang and an endless loop end with the
//! child, not with the worker. Nothing here caps the child's memory (that needs a resource limit, which
//! is `unsafe` territory this workspace forbids): the container's memory limit is the backstop, and
//! ADR-0151 증보 4 lists it under the risks that remain.
//!
//! No text from a file is ever logged or put in an error: every failure is one of the closed codes
//! of [`ExtractError`].

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

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

/// Why no letters came out. Closed, so a caller can keep it in an audit row: it names no file, no
/// path and no text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractError {
    /// All [`CHILD_SLOTS`] are taken; asking again in a moment is the right answer.
    Busy,
    /// The file opened and no letters were in it (a scan, an encrypted file, a picture of a page).
    NoText,
    /// The file could not be opened, the child failed or ran out of time.
    Unreadable,
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

/// The child's whole life: PDF bytes on stdin → one JSON line on stdout → exit status. Returns the
/// process exit code. Reads at most `max_input + 1` bytes; an over-long input is the same
/// "unreadable" as a broken one.
pub fn child_main(max_input: usize) -> i32 {
    use std::io::{Read, Write};
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
    let Some(path) = child_path(child) else {
        return Err(ExtractError::Unreadable);
    };
    let Ok(permit) = slots().try_acquire_owned() else {
        return Err(ExtractError::Busy);
    };
    tokio::spawn(async move {
        let _permit = permit;
        run_child(bytes, path, max_input, deadline).await
    })
    .await
    .map_err(|_| ExtractError::Unreadable)?
}

async fn run_child(
    bytes: Vec<u8>,
    path: PathBuf,
    max_input: usize,
    deadline: Duration,
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
        .map_err(|_| ExtractError::Unreadable)?;
    let (Some(mut input), Some(mut output)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(ExtractError::Unreadable);
    };
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
        let data = data.map_err(|_| ExtractError::Unreadable)?;
        if data.len() > CHILD_OUTPUT_MAX {
            return Err(ExtractError::Unreadable);
        }
        let status = child.wait().await.map_err(|_| ExtractError::Unreadable)?;
        if !status.success() {
            return Err(ExtractError::Unreadable);
        }
        parse_answer(&data)
    };
    let outcome = tokio::time::timeout(deadline, work).await;
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
