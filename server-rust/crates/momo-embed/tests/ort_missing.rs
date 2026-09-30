//! A missing / unloadable / wrong ONNX Runtime library is an error the worker can degrade on —
//! never a panic inside ort's global lock (which poisons it and aborts the process at exit).
//!
//! Each case runs in a **child process** (this test binary re-executed), and the parent asserts on
//! the child's exit status: a regression to the old behaviour would abort the child at exit, and
//! the parent reports it instead of the harness dying with SIGABRT.

use std::process::Command;

use momo_embed::{EmbedError, OnnxEmbedder, ONNX_FILE, TOKENIZER_FILES};

fn model_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(ONNX_FILE), b"not a model").unwrap();
    for name in TOKENIZER_FILES {
        std::fs::write(dir.path().join(name), b"{}").unwrap();
    }
    dir
}

/// Runs in the child: `MOMO_ORT_CASE` names the scenario, `MOMO_ORT_DIR` the model dir.
#[test]
fn child_case() {
    let Ok(case) = std::env::var("MOMO_ORT_CASE") else {
        return; // the parent test below drives this one
    };
    let dir = std::path::PathBuf::from(std::env::var("MOMO_ORT_DIR").unwrap());
    let err = OnnxEmbedder::load(&dir, None).err().expect("must fail");
    let EmbedError::Load(message) = &err else {
        panic!("{case}: {err}")
    };
    let want = std::env::var("MOMO_ORT_WANT").unwrap();
    assert!(message.contains(&want), "{case}: {message}");
    // A second attempt behaves the same (nothing was left poisoned) ...
    assert!(OnnxEmbedder::load(&dir, None).is_err());
}

fn run_case(case: &str, ort_path: Option<&str>, want: &str) {
    let dir = model_dir();
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["child_case", "--exact", "--nocapture", "--test-threads=1"])
        .env("MOMO_ORT_CASE", case)
        .env("MOMO_ORT_DIR", dir.path())
        .env("MOMO_ORT_WANT", want)
        .env_remove("ORT_DYLIB_PATH");
    if let Some(p) = ort_path {
        cmd.env("ORT_DYLIB_PATH", p);
    }
    let out = cmd.output().unwrap();
    // ... and the process EXITS cleanly (the old bug aborted here, at exit, with SIGABRT).
    assert!(
        out.status.success(),
        "{case}: child status {:?}\n{}\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn an_unusable_ort_library_is_a_load_error_and_the_process_exits_cleanly() {
    let scratch = tempfile::tempdir().unwrap();
    let bogus = scratch.path().join("libonnxruntime.so");
    std::fs::write(&bogus, b"not an ELF").unwrap();

    run_case("unset", None, "not set");
    run_case("relative", Some("libonnxruntime.so"), "absolute");
    run_case(
        "missing file",
        Some(scratch.path().join("nope.so").to_str().unwrap()),
        "does not point at a file",
    );
    run_case(
        "not a library",
        Some(bogus.to_str().unwrap()),
        "cannot load",
    );

    // A real shared library that is not ONNX Runtime (present on any Linux/macOS host).
    for candidate in [
        "/lib/x86_64-linux-gnu/libm.so.6",
        "/lib/aarch64-linux-gnu/libm.so.6",
        "/usr/lib/libSystem.B.dylib",
    ] {
        if std::path::Path::new(candidate).is_file() {
            run_case("wrong library", Some(candidate), "not ONNX Runtime");
            return;
        }
    }
}
