//! The spike must stay unreachable from production: no other workspace member
//! may depend on it (ADR-0197 S2 "not wired into production routes").

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

#[test]
fn no_other_workspace_member_depends_on_the_spike_crate() {
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
        assert!(
            !text.contains("momo-blind-pty"),
            "{} depends on the S2 spike crate",
            m.display()
        );
    }
}
