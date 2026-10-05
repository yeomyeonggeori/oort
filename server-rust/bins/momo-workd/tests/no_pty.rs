//! ADR-0190 D1 / ADR-0197 D5 (M3): **`momo-workd` never opens a PTY**, on any
//! platform and in any profile — including the Linux box profile. The only
//! process in a personal-cloud box that opens one is `momo-box-agent`, a
//! separate binary under a separate uid.
//!
//! This is a source test: it reads `src/**` and `Cargo.toml`, so a PTY call or
//! a PTY crate added to workd fails here before anything runs.

use std::fs;
use std::path::{Path, PathBuf};

/// Calls and crates that open or drive a pseudo-terminal.
const PTY_PATTERNS: &[&str] = &[
    "openpty",
    "forkpty",
    "posix_openpt",
    "grantpt",
    "unlockpt",
    "ptsname",
    "TIOCSCTTY",
    "/dev/ptmx",
    "portable-pty",
    "portable_pty",
    "pty-process",
    "momo-blind-pty",
    "momo_blind_pty",
    "momo-box-agent",
    "momo_box_agent",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read src dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Every pattern hit in `text`, as `(pattern, line number)`.
fn hits(text: &str) -> Vec<(&'static str, usize)> {
    let mut found = Vec::new();
    for (number, line) in text.lines().enumerate() {
        for pattern in PTY_PATTERNS {
            if line.contains(pattern) {
                found.push((*pattern, number + 1));
            }
        }
    }
    found
}

#[test]
fn the_pty_scanner_catches_what_it_is_meant_to_catch() {
    // The scan is only worth anything if it can fail.
    assert!(!hits("let r = libc::openpty(&mut m, &mut s, null_mut(), null(), null());").is_empty());
    assert!(!hits("portable-pty = \"0.8\"").is_empty());
    assert!(!hits("ioctl(fd, libc::TIOCSCTTY, 0)").is_empty());
    assert!(hits("let tty = false; // no terminal here").is_empty());
}

#[test]
fn workd_source_and_manifest_never_open_or_depend_on_a_pty() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    assert!(
        files.len() > 15,
        "the source scan must be live, found {} files",
        files.len()
    );
    let mut violations = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).expect("read source");
        for (pattern, line) in hits(&text) {
            violations.push(format!("{}:{line}: {pattern}", file.display()));
        }
    }
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("read manifest");
    // Comments in the manifest may name the crates; dependencies may not.
    for line in manifest
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
    {
        for (pattern, number) in hits(line) {
            violations.push(format!(
                "Cargo.toml (line text {number}): {pattern}: {line}"
            ));
        }
    }
    assert!(
        violations.is_empty(),
        "momo-workd must not open or depend on a PTY (ADR-0190 D1):\n{}",
        violations.join("\n")
    );
}
