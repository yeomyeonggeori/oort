//! A missing ONNX Runtime library is an error the worker can degrade on — never a panic that
//! takes the process (or the blocking-pool task) down. Its own test binary because it sets a
//! process-wide environment variable.

use momo_embed::{EmbedError, OnnxEmbedder, ONNX_FILE, TOKENIZER_FILES};

#[test]
fn an_unloadable_ort_library_is_a_load_error_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    // The files exist (their contents are never reached: the runtime cannot be loaded first).
    std::fs::write(dir.path().join(ONNX_FILE), b"not a model").unwrap();
    for name in TOKENIZER_FILES {
        std::fs::write(dir.path().join(name), b"{}").unwrap();
    }

    // 1) ORT_DYLIB_PATH names a file that is not there: refused up front, with the reason.
    std::env::set_var(
        "ORT_DYLIB_PATH",
        dir.path().join("no-such-libonnxruntime.so"),
    );
    let err = OnnxEmbedder::load(dir.path(), None)
        .err()
        .expect("must fail");
    assert!(
        matches!(&err, EmbedError::Load(m) if m.contains("ORT_DYLIB_PATH")),
        "{err}"
    );

    // 2) ORT_DYLIB_PATH names a file that is not a shared library: the dlopen failure (a panic
    // inside the dynamic loader) comes back as an error.
    let bogus = dir.path().join("libonnxruntime.so");
    std::fs::write(&bogus, b"not an ELF").unwrap();
    std::env::set_var("ORT_DYLIB_PATH", &bogus);
    let err = OnnxEmbedder::load(dir.path(), None)
        .err()
        .expect("must fail");
    assert!(matches!(err, EmbedError::Load(_)), "{err}");
}
