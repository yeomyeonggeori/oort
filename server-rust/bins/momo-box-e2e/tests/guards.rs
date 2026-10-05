//! ADR-0197 M4 — guards that need no database and no docker: what the relay's SOURCE may not do, and the constants
//! the ADR fixes. They read `momo-server`'s sources (and say so).

use std::path::Path;

fn server_src(rel: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../momo-server/src").join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Source with `//` comments blanked; and with each `#[cfg(sabotage_*)]` attribute together with the statement it
/// guards removed (the sabotage block is the one place that logs frames, and it is never compiled in a real build).
fn code(source: &str) -> String {
    let mut out = Vec::new();
    let mut skip_next = false;
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#[cfg(sabotage_") {
            skip_next = true;
            continue;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        out.push(match line.find("//") {
            Some(at) if !line[..at].contains('"') => &line[..at],
            _ => line,
        });
    }
    out.join("\n")
}

const RELAY_FILES: [&str; 3] = [
    "cloud_box_relay.rs",
    "routes/cloud_box_pty.rs",
    "routes/cloud_box_agent.rs",
];

#[test]
fn the_relay_never_touches_the_protocol_or_any_cipher() {
    for file in RELAY_FILES {
        let text = code(&server_src(file));
        for forbidden in [
            "momo_blind_pty",
            "momo-blind-pty",
            "aes_gcm",
            "hkdf",
            "p256::ecdh",
            "Session::",
            "derive_keys",
            ".seal(",
            ".open(",
        ] {
            assert!(!text.contains(forbidden), "{file} reaches for `{forbidden}`: the relay carries bytes, it does not read them");
        }
    }
    // The dependency itself is forbidden by momo-blind-pty's own isolation test; assert the manifest too.
    let manifest = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../momo-server/Cargo.toml")).unwrap();
    assert!(!manifest.lines().filter(|l| !l.trim_start().starts_with('#')).any(|l| l.contains("blind-pty")));
}

#[test]
fn no_log_line_in_the_relay_names_a_message_a_key_a_ticket_or_a_proof() {
    const NAMES: &[&str] = &[
        "bytes", "frame", "payload", "message", "msg", "hello", "ticket", "mac", "pin", "list", "data", "signature",
        "challenge", "secret",
    ];
    for file in RELAY_FILES {
        let text = code(&server_src(file));
        for (n, line) in text.lines().enumerate() {
            let logs = ["tracing::", "warn!(", "info!(", "debug!(", "error!(", "trace!(", "println!", "eprintln!", "dbg!"]
                .iter()
                .any(|m| line.contains(m));
            if !logs {
                continue;
            }
            let lower = line.to_lowercase();
            for name in NAMES {
                // whole-word match on an identifier-ish token
                let hit = lower
                    .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .any(|token| token == *name);
                assert!(!hit, "{file}:{} logs `{name}`: {line}", n + 1);
            }
        }
    }
}

#[test]
fn the_sabotage_switch_is_a_rustc_cfg_in_exactly_one_place() {
    let relay = server_src("cloud_box_relay.rs");
    assert_eq!(relay.matches("cfg(sabotage_log_frames)").count(), 1);
    // Not a cargo feature: no `sabotage` feature in the server's manifest.
    let manifest = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../momo-server/Cargo.toml")).unwrap();
    assert!(!manifest.contains("sabotage = ") && !manifest.contains("features = [\"sabotage"));
    assert!(manifest.contains("cfg(sabotage_log_frames)"));
}

#[test]
fn the_socket_loops_hold_no_database_transaction() {
    // ADR-0197 D5: 「장기 WebSocket 동안 DB 트랜잭션·RLS 컨텍스트를 잡지 않는다」. The two socket loops are pure
    // channel code; only the supervisor and the audit writer open (short) transactions.
    let relay = code(&server_src("cloud_box_relay.rs"));
    for function in ["pub async fn run_end", "pub async fn run_listener"] {
        let start = relay.find(function).unwrap_or_else(|| panic!("{function}"));
        let rest = &relay[start + function.len()..];
        let end = rest.find("\npub ").or_else(|| rest.find("\nasync fn ")).unwrap_or(rest.len());
        let body = &rest[..end];
        for forbidden in ["with_tenant_tx", "agent_tenant_tx", "pool", "sqlx", "PgConnection", "begin("] {
            assert!(!body.contains(forbidden), "{function} touches the database ({forbidden})");
        }
    }
}

#[test]
fn the_signature_is_required_by_construction_not_by_a_flag() {
    let pty = code(&server_src("routes/cloud_box_pty.rs"));
    assert!(!pty.contains("human_control_signature_required"), "the attach path must not read the R2 flag");
    // Both signed controls (the first owner list, the attach) call the verifier with `required = true` — a literal.
    let calls: Vec<&str> = pty.split("authorize_human_control_in_tx(").skip(1).collect();
    assert_eq!(calls.len(), 2, "exactly the two signed controls");
    for call in calls {
        let args = call.split(".await").next().unwrap();
        assert!(
            args.lines().any(|line| line.trim() == "true,"),
            "a signed control that does not pass `required = true`:\n{args}"
        );
    }
}

#[test]
fn the_relay_constants_are_the_adrs() {
    use momo_server::cloud_box_relay::{RelayLimits, MAX_HELLO_BYTES, MAX_RELAY_MESSAGE};
    assert_eq!(MAX_RELAY_MESSAGE, momo_blind_pty::MAX_PAYLOAD + 8 + 1 + 16, "counter + kind + tag around the payload");
    assert!(MAX_HELLO_BYTES >= 115, "the S2 Hello is 115 bytes");
    let limits = RelayLimits::default();
    assert_eq!(limits.max_message, MAX_RELAY_MESSAGE);
    assert_eq!(limits.max_sessions_per_box, 2, "D5: 박스당 동시 붙기 수 상한(기본 2)");
    assert_eq!(limits.max_session, std::time::Duration::from_secs(8 * 3600), "D5: 최대 세션 길이 8시간");
    assert_eq!(limits.idle, std::time::Duration::from_secs(30 * 60));
    assert_eq!(limits.pending_per_member, 3);
    assert_eq!(limits.pending_global, 64);
    assert_eq!(limits.ticket_ttl, std::time::Duration::from_secs(30));
    assert_eq!(limits.handshake_deadline, std::time::Duration::from_secs(20));
    assert!(limits.queue_messages >= 1 && limits.stall_timeout > std::time::Duration::ZERO);
}

#[test]
fn the_box_agents_own_bounds_match_the_adr_too() {
    let limits = momo_box_agent::serve::BoxLimits::default();
    assert_eq!(limits.max_session, std::time::Duration::from_secs(8 * 3600));
    assert_eq!(momo_box_agent::serve::MAX_MESSAGE, momo_server::cloud_box_relay::MAX_RELAY_MESSAGE);
    assert_eq!(momo_box_agent::host::MAX_ATTACHED, 2);
}
