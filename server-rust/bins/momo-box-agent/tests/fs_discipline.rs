//! ADR-0197 D4.5: the box-agent opens files **only** through
//! `fsgate::FsGate`, which refuses credential paths. A source test: any other
//! module in `src/` that reaches the filesystem by itself fails here.
//!
//! `src/fsgate.rs` is the door; `src/bin/` holds the test-only probe, which is
//! not shipped and exists to attempt forbidden access.

use std::fs;
use std::path::{Path, PathBuf};

const RAW_FS: &[&str] = &[
    "std::fs",
    "fs::File",
    "fs::read",
    "fs::write",
    "fs::OpenOptions",
    "File::open",
    "File::create",
    "OpenOptions",
    "read_to_string",
    "read_dir",
    "tokio::fs",
    "libc::open(",
    "libc::creat",
    "libc::open64",
    "os::unix::fs",
    "fs::",
    "libc::openat",
    "libc::fopen",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Source lines with comments cut and the bodies of `#[cfg(test)] mod … { }`
/// blocks removed — and only those: code after a test module, or a lone
/// `#[cfg(test)]` on an item, is still scanned (L6 of the #3503 review).
fn scanned_lines(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut lines = text.lines().enumerate().peekable();
    while let Some((i, line)) = lines.next() {
        let code = line.split("//").next().unwrap_or("").to_string();
        if code.trim() == "#[cfg(test)]" {
            let is_mod = lines
                .peek()
                .is_some_and(|(_, next)| next.trim_start().starts_with("mod "));
            if is_mod {
                let mut depth = 0i32;
                let mut opened = false;
                for (_, body) in lines.by_ref() {
                    let body = body.split("//").next().unwrap_or("");
                    depth += body.matches('{').count() as i32 - body.matches('}').count() as i32;
                    opened |= body.contains('{');
                    if opened && depth <= 0 {
                        break;
                    }
                }
                continue;
            }
        }
        out.push((i + 1, code));
    }
    out
}

fn raw_fs_uses(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (number, line) in scanned_lines(text) {
        for pattern in RAW_FS {
            if line.contains(pattern) {
                found.push(format!("line {number}: {pattern}"));
            }
        }
    }
    found
}

#[test]
fn the_fs_scanner_catches_raw_access() {
    for sample in [
        "let s = std::fs::read_to_string(p)?;",
        "let f = File::open(path)?;",
        "OpenOptions::new().read(true)",
        "for e in read_dir(d)",
        "use std::os::unix::fs::OpenOptionsExt;",
        "let fd = libc::creat(p, 0o600);",
        // after a test module, and after a lone cfg(test) item, code is still scanned
        "#[cfg(test)]\nmod tests {\n    fn a() {}\n}\nfn b() { std::fs::read(p); }",
        "#[cfg(test)]\nuse x;\nfn b() { File::open(p); }",
    ] {
        assert!(!raw_fs_uses(sample).is_empty(), "must catch: {sample}");
    }
    assert!(raw_fs_uses("gate.read(path)?").is_empty());
    // ... while a use inside a test module is not counted.
    assert!(
        raw_fs_uses("#[cfg(test)]\nmod tests {\n    fn a() { std::fs::read(p); }\n}\n").is_empty()
    );
}

#[test]
fn only_the_fs_gate_touches_the_filesystem() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut checked = 0;
    let mut all = Vec::new();
    for file in &files {
        let rel = file
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        if rel == "fsgate.rs" || rel.starts_with("bin/") {
            continue;
        }
        checked += 1;
        for v in raw_fs_uses(&fs::read_to_string(file).unwrap()) {
            all.push(format!("src/{rel}: {v}"));
        }
    }
    assert!(
        checked >= 7,
        "the scan must be live, checked {checked} files"
    );
    assert!(
        all.is_empty(),
        "only FsGate may open files (ADR-0197 D4.5):\n{}",
        all.join("\n")
    );
}
