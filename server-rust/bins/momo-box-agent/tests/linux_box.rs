//! The real uid/capability path, as a cargo test (review of #3503, M4).
//!
//! Dropping to another uid needs `CAP_SETUID/SETGID`, so this test only runs
//! where those exist: as root in a Linux container started with
//! `--cap-drop ALL --cap-add SETUID --cap-add SETGID` (the box's own shape).
//! Anywhere else it **skips loudly** — a skip is not evidence. The evidence is
//! `infra/personal-box/verify-m3.sh` (the full box, including the long-lived
//! agent and `ptrace`), and this test when a privileged Linux runner is used:
//!
//! ```text
//! docker run --rm --cap-drop ALL --cap-add SETUID --cap-add SETGID \
//!   -v …/server-rust:/src:ro --tmpfs /target:rw,exec,size=3g -e CARGO_TARGET_DIR=/target \
//!   -w /src rust:1-bookworm cargo test -p momo-box-agent --test linux_box
//! ```
//!
//! It plays the box-agent exactly as `main.rs` does — `setpriv` to the agent
//! uid with the two ambient capabilities, start the spawn helper, drop the
//! agent's capabilities, ask for a PTY — and reads what the person's shell sees.

#![cfg(target_os = "linux")]

use std::process::Command;

fn status_field(name: &str) -> Option<String> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|l| {
        l.strip_prefix(&format!("{name}:"))
            .map(|r| r.trim().to_string())
    })
}

/// Root holding CAP_SETGID (6) and CAP_SETUID (7) and a `setpriv` to use.
fn privileged() -> bool {
    // SAFETY: getter.
    let root = unsafe { libc::geteuid() } == 0;
    let caps = status_field("CapEff")
        .and_then(|h| u64::from_str_radix(&h, 16).ok())
        .is_some_and(|c| c & 0xc0 == 0xc0);
    root && caps && Command::new("setpriv").arg("--version").output().is_ok()
}

#[test]
fn the_pty_child_has_no_capability_and_the_agent_cannot_get_them_back() {
    if !privileged() {
        eprintln!(
            "SKIPPED (not evidence): needs root with CAP_SETUID/SETGID and setpriv; \
             run it in the container shape documented at the top of this file"
        );
        return;
    }
    let dir = std::env::temp_dir().join(format!("momo-linux-box-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // The agent (10002), helper (10003) and person (10001) all need to traverse it.
    std::process::Command::new("chmod")
        .args(["0755"])
        .arg(&dir)
        .status()
        .unwrap();
    let probe = env!("CARGO_BIN_EXE_momo-box-probe");
    let agent_exe = env!("CARGO_BIN_EXE_momo-box-agent");
    let out = Command::new("setpriv")
        .args([
            "--reuid",
            "10002",
            "--regid",
            "10002",
            "--clear-groups",
            "--inh-caps",
            "+setuid,+setgid",
            "--ambient-caps",
            "+setuid,+setgid",
            "--",
            probe,
            "spawn-report",
            "--agent-exe",
            agent_exe,
            "--cwd",
        ])
        .arg(&dir)
        .env("ANTHROPIC_API_KEY", "NOT-FOR-THE-SHELL")
        .env("OORT_BOX_KEY_DIR", "/nope")
        .output()
        .expect("setpriv");
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let _ = std::fs::remove_dir_all(&dir);
    let has = |line: &str| text.lines().any(|l| l.trim() == line);
    assert!(
        has("uid=10001") && has("euid=10001") && has("gid=10001"),
        "{text}"
    );
    assert!(has("groups="), "{text}");
    for cap in ["CapInh", "CapPrm", "CapEff", "CapAmb"] {
        assert!(has(&format!("{cap}=0000000000000000")), "{cap}: {text}");
    }
    assert!(has("NoNewPrivs=1"), "{text}");
    assert!(has("agent_drop_capabilities=OK"), "{text}");
    assert!(has("agent_CapEff_after_drop=0000000000000000"), "{text}");
    assert!(
        has("agent_can_setuid_after_drop=false"),
        "agent kept the power to become the person: {text}"
    );
    assert!(
        has("ppid_uid=10003"),
        "the shell's parent is the helper: {text}"
    );
    assert!(has("kill_parent=EPERM"), "{text}");
    assert!(
        has("open_fds=0,1,2"),
        "descriptors leaked into the shell: {text}"
    );
    assert!(
        !text
            .lines()
            .any(|l| l.starts_with("envname=") && (l.contains("ANTHROPIC") || l.contains("OORT_"))),
        "{text}"
    );
}
