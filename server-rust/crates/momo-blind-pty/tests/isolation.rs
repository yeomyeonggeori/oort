//! The blind-relay protocol crate stays unreachable from every production
//! route. Exactly three workspace members may depend on it:
//!
//! * `momo-box-agent` — the box-side endpoint (ADR-0197 M3);
//! * `momo-box-runner` (M4) — it holds the runner's Ed25519 key, attests a box's host key and verifies the
//!   box-agent's registration MAC (`trust::Runner`, `registration_mac`). The runner is the trust anchor the owner
//!   pins by fingerprint; it is not a relay;
//! * `momo-box-e2e` (M4) — the test-only crate that plays the owner's device against the real server routes.
//!
//! `momo-server`, `momo-relay`, `momo-workd` and every other member must not (S2 "not wired into production
//! routes"; the server relays opaque frames and never holds protocol state, and workd opens no PTY, ADR-0190 D1).
//! The relay route (M4) carries bytes, not this crate.

use std::fs;
use std::path::Path;

fn manifests(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            let m = p.join("Cargo.toml");
            if m.exists() {
                out.push(m);
            }
        }
    }
}

/// The only members allowed to depend on the protocol crate (directory names).
const ALLOWED_DEPENDENTS: &[&str] = &["momo-box-agent", "momo-box-runner", "momo-box-e2e"];

fn member_name(manifest: &Path) -> String {
    manifest
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[test]
fn only_the_box_side_and_its_trust_anchor_depend_on_the_protocol_crate() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut ms = vec![];
    manifests(&root.join("crates"), &mut ms);
    manifests(&root.join("bins"), &mut ms);
    assert!(
        ms.len() > 10,
        "workspace scan must be live, found {}",
        ms.len()
    );
    let own = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    for m in ms
        .into_iter()
        .filter(|m| m.canonicalize().ok() != own.canonicalize().ok())
    {
        let text = fs::read_to_string(&m).unwrap();
        let depends = text
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .any(|l| l.contains("momo-blind-pty"));
        if ALLOWED_DEPENDENTS.contains(&member_name(&m).as_str()) {
            continue;
        }
        assert!(
            !depends,
            "{} depends on the blind-relay protocol crate; only {ALLOWED_DEPENDENTS:?} may",
            m.display()
        );
    }
}

#[test]
fn the_box_agent_is_the_dependent_this_test_expects() {
    // Positive control: the allowlisted member really depends on the crate,
    // so the allowlist cannot silently go stale (a renamed member would
    // otherwise leave the test checking nothing about the one allowed edge).
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest = root.join("bins/momo-box-agent/Cargo.toml");
    let text = fs::read_to_string(&manifest).expect("momo-box-agent manifest");
    assert!(
        text.lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .any(|l| l.contains("momo-blind-pty")),
        "momo-box-agent must depend on momo-blind-pty"
    );
}
