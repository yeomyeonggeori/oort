//! ADR-0197 D6 / M3: **no Claude ACP adapter in the box-agent** (and no ACP at
//! all: the box's Codex ACP lane belongs to the box's `momo-workd`, never to
//! this process). A source test: it reads `src/**` and `Cargo.toml`.
//!
//! What the box-agent may take from `momo-workd` is a closed list — the host
//! key store and the key fingerprint — so the ACP modules (`acp`, `policy`,
//! `session`, `projection`) cannot be reached by an `use` that creeps in.

use std::fs;
use std::path::{Path, PathBuf};

/// ACP in any form: the adapters, the JSON-RPC verbs of a session, the workd
/// modules that drive one, and the launch vocabulary.
const ACP_PATTERNS: &[&str] = &[
    "agentclientprotocol",
    "claude-agent-acp",
    "codex-acp",
    "session/new",
    "session/prompt",
    "session/update",
    "session/request_permission",
    "\"jsonrpc\"",
    "AdapterKind",
    "momo_workd::acp",
    "momo_workd::policy",
    "momo_workd::session",
    "momo_workd::projection",
    "momo_workd::controls",
    "momo_workd::config",
    "claude -p",
    "arg(\"-p\")",
    "\"--print\"",
    "\"--output-format\"",
];

/// The only `momo_workd::` paths allowed.
const ALLOWED_WORKD_USES: &[&str] = &[
    "momo_workd::keystore::",
    "momo_workd::cli::host_key_fingerprint",
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

fn violations_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let code = line.split("//").next().unwrap_or("");
        for pattern in ACP_PATTERNS {
            if code.contains(pattern) {
                found.push(format!("line {}: {pattern}", index + 1));
            }
        }
        let mut rest = code;
        while let Some(at) = rest.find("momo_workd::") {
            let tail = &rest[at..];
            if !ALLOWED_WORKD_USES.iter().any(|ok| tail.starts_with(ok)) {
                found.push(format!(
                    "line {}: {}",
                    index + 1,
                    tail.chars().take(40).collect::<String>()
                ));
            }
            rest = &tail["momo_workd::".len()..];
        }
    }
    found
}

#[test]
fn the_acp_scanner_catches_what_it_is_meant_to_catch() {
    for sample in [
        "let adapter = AdapterKind::Claude;",
        "use momo_workd::acp::AcpTransport;",
        "send(\"session/new\")",
        "Command::new(\"claude\").arg(\"-p\")",
        "let t = \"@agentclientprotocol/claude-agent-acp\";",
        "use momo_workd::policy::launch_spec;",
    ] {
        assert!(!violations_in(sample).is_empty(), "must catch: {sample}");
    }
    assert!(violations_in("use momo_workd::keystore::box_store::BoxKeyStore;").is_empty());
    assert!(violations_in("// the box never drives Claude over ACP").is_empty());
}

#[test]
fn the_box_agent_has_no_acp_adapter_and_reaches_no_acp_module() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    assert!(
        files.len() >= 8,
        "the scan must be live, found {}",
        files.len()
    );
    let mut all = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).unwrap();
        for v in violations_in(&text) {
            all.push(format!("{}: {v}", file.display()));
        }
    }
    let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    for (i, line) in manifest.lines().enumerate() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        for v in violations_in(line) {
            all.push(format!("Cargo.toml:{}: {v}", i + 1));
        }
    }
    assert!(
        all.is_empty(),
        "the box-agent must not carry an ACP adapter (ADR-0197 D6):\n{}",
        all.join("\n")
    );
}

#[test]
fn the_box_hosts_registration_advertises_no_acp() {
    // The capability the server sees: terminal only.
    let body = momo_box_agent::register::registration_request(
        "box",
        "name",
        "KEY",
        momo_box_agent::register::PairingCode::new("code").unwrap(),
    );
    assert_eq!(body["capabilities"]["acp"], false);
}
