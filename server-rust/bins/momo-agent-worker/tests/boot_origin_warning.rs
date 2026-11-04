//! #4974 — what the worker says **at boot** about `OORT_API_INTERNAL_ORIGIN`, read from the real binary's
//! own output (ADR-0151 증보 3, 검수 L2).
//!
//! ```text
//! cargo test -p momo-agent-worker --test boot_origin_warning
//! ```
//!
//! No database is involved: the process is started with a connection string that is not one, so it prints
//! its boot lines and stops at the first thing that needs a database. The unit tests in `self_media.rs`
//! judge the *shape* and read the warning function's own output; this test is what proves `main` calls it —
//! the one line an operator would otherwise never see.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_booting_worker_warns_once_by_name_for_an_origin_that_is_not_private_and_never_prints_it` | dropping the call from `main.rs`; printing the value; warning for a private origin |

use std::process::Command;

/// Everything the real worker binary prints (both streams) when it boots with `OORT_API_INTERNAL_ORIGIN` set
/// to `origin` and a database URL that cannot connect.
fn boot_output(origin: &str) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_momo-agent-worker"))
        .env_clear()
        .env("NO_COLOR", "1")
        .env("WORKER_DATABASE_URL", "not-a-database-url")
        .env("OORT_API_INTERNAL_ORIGIN", origin)
        .output()
        .expect("the worker binary starts");
    assert!(
        !output.status.success(),
        "the process stops at the connection string, which is not one"
    );
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

const WARNING: &str = "OORT_API_INTERNAL_ORIGIN does not look like a private-network address";

#[test]
fn the_booting_worker_warns_once_by_name_for_an_origin_that_is_not_private_and_never_prints_it() {
    for public in [
        "http://example.com:8080",
        "https://203.0.113.9",
        "http://169.254.169.254",
    ] {
        let out = boot_output(public);
        let lines: Vec<&str> = out.lines().filter(|line| line.contains(WARNING)).collect();
        assert_eq!(lines.len(), 1, "{public}: one warning line: {out}");
        assert!(lines[0].contains("WARN"), "{public}: {}", lines[0]);
        let host = public
            .split("//")
            .nth(1)
            .and_then(|rest| rest.split(':').next())
            .unwrap();
        assert!(
            !out.contains(host),
            "{public}: the value is nowhere in the boot output: {out}"
        );
        // a warning, not a gate: the worker still takes the value as the api's address
        assert!(out.contains("attachment_source=\"api\""), "{public}: {out}");
    }

    for quiet in [
        "http://api:8080",
        "http://api.railway.internal:8080",
        "http://127.0.0.1:8080",
        "",
    ] {
        let out = boot_output(quiet);
        assert!(
            out.contains("attachment_source="),
            "{quiet:?}: the boot output is live: {out}"
        );
        assert!(
            !out.contains(WARNING),
            "{quiet:?}: a private-shaped origin gets no warning: {out}"
        );
    }
}
