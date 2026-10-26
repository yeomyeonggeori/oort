//! Which kind of host this `api` process runs on, as a closed enum (#4337, ADR-0203 증보 2026-10-25 F2·F3).
//!
//! The operator-only status read (`GET /v1/workspaces/{ws}/cohosted-agent`) tells the screen which
//! platform's wording to pick (a Railway terminal command versus a `docker compose` one). That is a
//! **fact about the environment the process was started in**, so it comes from exactly two variables of
//! the process's own env, read **once at boot** and folded into [`HostPlatform`] right there:
//!
//! 1. `RAILWAY_ENVIRONMENT_ID` — a system variable Railway injects into every deployment. It wins over
//!    the stamp, because it is written by the platform while the stamp is written by an operator (an env
//!    carried over from another host keeps its old stamp and must not hide where the process really runs).
//! 2. `MOMO_SELF_HOST_PLATFORM` — the stamp `scripts/self_host_env.sh` writes for a named platform row.
//!
//! Rules this module holds:
//!
//! * **Only the enum is kept.** Neither the stamp nor the Railway id is stored, serialized, logged or
//!   returned (F2); `Config` and `CohostedAgentConfig` derive `Debug`, so a raw string held there would be
//!   one `{:?}` away from a log line. Anything outside the table folds to [`HostPlatform::Unknown`].
//! * **Nothing is probed.** No filesystem, cgroup, `/proc`, DNS or Railway API (D1: nothing is guessed).
//! * **The value only picks wording.** It is never read by a permission, egress or connectability decision
//!   (F2), so lying in the env changes a sentence on the operator's own screen and nothing else.
//! * **The stamp is compared as written**: no trim, exact match, case-sensitive. `" railway"` is not
//!   `railway`. (A stamp that is only whitespace is "not set", the same way `config::env` treats any
//!   variable.)

use serde::Serialize;

/// The system variable a Railway deployment always carries (F3 row 1).
const RAILWAY_SYSTEM_VARIABLE: &str = "RAILWAY_ENVIRONMENT_ID";
/// The stamp `scripts/self_host_env.sh` writes for a platform row (F3 row 2-5).
const STAMP_VARIABLE: &str = "MOMO_SELF_HOST_PLATFORM";
/// The one T2 stamp: `platform_profiles()` has exactly one T2 row, `railway`.
const RAILWAY_STAMP: &str = "railway";

/// The generator's T1 stamps (`scripts/self_host_env.sh` `platform_profiles()` rows whose tier is T1) — the
/// hosts that run the compose stack. **One name per line, each with the anchor comment**:
/// `scripts/tests/test_self_host_env_modes.sh` extracts the anchored lines and compares them with the
/// table's T1 rows, so a new row or a rename on either side is a red local gate, not a silent `unknown`.
/// Keep the anchor on the same line as the name (`cargo fmt` keeps one item per line when each carries a
/// comment).
pub const COMPOSE_STAMPS: [&str; 4] = [
    "fly",           // oort:t1-platform-stamp
    "aws-lightsail", // oort:t1-platform-stamp
    "gcp-vm",        // oort:t1-platform-stamp
    "host-network",  // oort:t1-platform-stamp
];

/// Where the process runs, as far as its own env says (F3). Serialized as the lowercase word.
///
/// `Default` is [`HostPlatform::Compose`] on purpose: it is what an env with neither variable classifies
/// as (F3 row 2), so a config built with `..Default::default()` agrees with one parsed from an empty env.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostPlatform {
    /// Railway system variable present, or the stamp names the T2 row.
    Railway,
    /// No Railway signal and no stamp, or the stamp names a T1 row. This is "no sign of anything else",
    /// not "docker compose was observed" (F3's limit), so the screen words it conditionally.
    #[default]
    Compose,
    /// A stamp that is in neither table.
    Unknown,
}

impl HostPlatform {
    /// Classify from any lookup (the process env at boot, a test double elsewhere). The first matching row wins:
    ///
    /// | # | condition | result |
    /// |---|---|---|
    /// | 1 | `RAILWAY_ENVIRONMENT_ID` is set | `Railway` (whatever the stamp says) |
    /// | 2 | `MOMO_SELF_HOST_PLATFORM` is not set | `Compose` |
    /// | 3 | the stamp is exactly `railway` | `Railway` |
    /// | 4 | the stamp is exactly a [`COMPOSE_STAMPS`] name | `Compose` |
    /// | 5 | anything else | `Unknown` |
    ///
    /// "Set" means non-empty and not only whitespace, whatever the lookup hands back; the value itself is
    /// never trimmed.
    pub fn classify(lookup: impl Fn(&str) -> Option<String>) -> HostPlatform {
        let present = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        if present(RAILWAY_SYSTEM_VARIABLE).is_some() {
            return HostPlatform::Railway;
        }
        match present(STAMP_VARIABLE).as_deref() {
            None => HostPlatform::Compose,
            Some(RAILWAY_STAMP) => HostPlatform::Railway,
            Some(stamp) if COMPOSE_STAMPS.contains(&stamp) => HostPlatform::Compose,
            Some(_) => HostPlatform::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CohostedAgentConfig;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    /// A lookup that answers only the two variables the classifier may read; anything else it is asked
    /// for is a failure (the classifier reads exactly these two names).
    fn env(railway: Option<&str>, stamp: Option<&str>) -> impl Fn(&str) -> Option<String> {
        let (railway, stamp) = (railway.map(str::to_string), stamp.map(str::to_string));
        move |name| match name {
            "RAILWAY_ENVIRONMENT_ID" => railway.clone(),
            "MOMO_SELF_HOST_PLATFORM" => stamp.clone(),
            other => panic!("the classifier read {other}"),
        }
    }

    /// ADR-0203 증보 2026-10-25 수용 기준 1 (판정표): one input differs per row.
    ///
    /// Sabotage (each turns exactly the named rows red): swap rows 1 and 3 -> the two conflict rows;
    /// drop the blank filter -> the whitespace-only rows; trim the stamp -> `" railway"`; delete a T1
    /// name -> that name's row; make row 5 `Compose` -> the `bogus` rows; lowercase the stamp ->
    /// `Railway`.
    #[test]
    fn the_decision_table() {
        let rows: &[(&str, Option<&str>, Option<&str>, HostPlatform)] = &[
            (
                "system variable only",
                Some("env-id"),
                None,
                HostPlatform::Railway,
            ),
            (
                "stamp railway only",
                None,
                Some("railway"),
                HostPlatform::Railway,
            ),
            ("neither", None, None, HostPlatform::Compose),
            ("stamp fly", None, Some("fly"), HostPlatform::Compose),
            (
                "stamp aws-lightsail",
                None,
                Some("aws-lightsail"),
                HostPlatform::Compose,
            ),
            ("stamp gcp-vm", None, Some("gcp-vm"), HostPlatform::Compose),
            (
                "stamp host-network",
                None,
                Some("host-network"),
                HostPlatform::Compose,
            ),
            ("stamp bogus", None, Some("bogus"), HostPlatform::Unknown),
            (
                "conflict: system variable + T1 stamp",
                Some("env-id"),
                Some("fly"),
                HostPlatform::Railway,
            ),
            (
                "system variable + bogus stamp",
                Some("env-id"),
                Some("bogus"),
                HostPlatform::Railway,
            ),
            (
                "system variable + railway stamp",
                Some("env-id"),
                Some("railway"),
                HostPlatform::Railway,
            ),
            (
                "whitespace-only system variable",
                Some("   "),
                None,
                HostPlatform::Compose,
            ),
            (
                "empty system variable",
                Some(""),
                None,
                HostPlatform::Compose,
            ),
            (
                "whitespace-only system variable + bogus stamp",
                Some(" \t "),
                Some("bogus"),
                HostPlatform::Unknown,
            ),
            (
                "whitespace-only stamp",
                None,
                Some("   "),
                HostPlatform::Compose,
            ),
            ("empty stamp", None, Some(""), HostPlatform::Compose),
            (
                "stamp with surrounding spaces",
                None,
                Some(" railway "),
                HostPlatform::Unknown,
            ),
            (
                "stamp with a leading space",
                None,
                Some(" railway"),
                HostPlatform::Unknown,
            ),
            (
                "stamp with a trailing newline",
                None,
                Some("railway\n"),
                HostPlatform::Unknown,
            ),
            (
                "stamp in upper case",
                None,
                Some("Railway"),
                HostPlatform::Unknown,
            ),
            (
                "T1 stamp in upper case",
                None,
                Some("FLY"),
                HostPlatform::Unknown,
            ),
        ];
        // Every row is judged before the test fails, so the failure names all the rows a change breaks.
        let wrong: Vec<String> = rows
            .iter()
            .filter_map(|(name, railway, stamp, expected)| {
                let got = HostPlatform::classify(env(*railway, *stamp));
                (got != *expected).then(|| format!("{name}: expected {expected:?}, got {got:?}"))
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "rows that disagree:\n{}",
            wrong.join("\n")
        );
    }

    /// The table above names the four T1 stamps once more; pin the constant to the literal list too
    /// (the shell guard compares the anchored lines with the generator's table, this pins them with the
    /// test's own copy, which carries no anchor).
    #[test]
    fn the_t1_stamps_are_the_generators_four() {
        assert_eq!(
            COMPOSE_STAMPS,
            ["fly", "aws-lightsail", "gcp-vm", "host-network"]
        );
        for stamp in COMPOSE_STAMPS {
            assert_eq!(
                HostPlatform::classify(env(None, Some(stamp))),
                HostPlatform::Compose,
                "{stamp}"
            );
        }
    }

    /// Sabotage: make a closed-enum variant impossible to forget (a new variant breaks this `match`).
    #[test]
    fn the_wire_words_are_the_lowercase_variants() {
        for (platform, word) in [
            (HostPlatform::Railway, "railway"),
            (HostPlatform::Compose, "compose"),
            (HostPlatform::Unknown, "unknown"),
        ] {
            match platform {
                HostPlatform::Railway | HostPlatform::Compose | HostPlatform::Unknown => {}
            }
            assert_eq!(serde_json::to_value(platform).unwrap(), word);
        }
    }

    /// ADR-0203 증보 2026-10-25 수용 기준 9: a config built with `..Default::default()` classifies like one
    /// parsed from an empty env, so a test double cannot silently be `Unknown`.
    ///
    /// Sabotage: put `#[default]` on `Unknown` (or `Railway`) -> red.
    #[test]
    fn the_default_is_what_an_empty_env_classifies_as() {
        let empty = CohostedAgentConfig::from_lookup(|_| None);
        assert_eq!(HostPlatform::default(), HostPlatform::classify(|_| None));
        assert_eq!(CohostedAgentConfig::default().platform, empty.platform);
        let spread = CohostedAgentConfig {
            declared: true,
            ..Default::default()
        };
        assert_eq!(spread.platform, empty.platform);
    }

    /// The parse folds the two variables into the enum at boot; the raw strings are not kept anywhere
    /// `Debug` can reach (ADR-0203 증보 2026-10-25 F1, review R3-M2).
    ///
    /// Sabotage: store the stamp (or the Railway id) as a `String` field of `CohostedAgentConfig` -> the
    /// marker shows up in `{:?}` and this goes red.
    #[test]
    fn debug_of_the_parsed_config_never_prints_the_env_strings() {
        const STAMP: &str = "MARKER-PLATFORM-4337-debug";
        const RAILWAY_ID: &str = "MARKER-RWENV-4337-debug";
        for (railway, stamp) in [
            (Some(RAILWAY_ID), None),
            (None, Some(STAMP)),
            (Some(RAILWAY_ID), Some(STAMP)),
        ] {
            let parsed = CohostedAgentConfig::from_lookup(|name| match name {
                "RAILWAY_ENVIRONMENT_ID" => railway.map(str::to_string),
                "MOMO_SELF_HOST_PLATFORM" => stamp.map(str::to_string),
                _ => None,
            });
            for rendering in [format!("{parsed:?}"), format!("{parsed:#?}")] {
                let lowered = rendering.to_ascii_lowercase();
                assert!(!lowered.contains("marker-platform"), "{rendering}");
                assert!(!lowered.contains("marker-rwenv"), "{rendering}");
            }
        }
    }

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// Classification is silent: nothing about the two variables reaches a log line, whichever row
    /// decides. The stamp case matters most (row 5 is the one that "does not recognise" a value and is where
    /// a `warn!` of the offending string would be written), and the case with both variables ends at row 1
    /// without ever reaching the stamp, so a logger placed after it would not show there.
    ///
    /// Sabotage: `tracing::warn!("unknown stamp {stamp}")` in row 5 -> the stamp-only configuration goes red.
    #[test]
    fn classification_logs_nothing() {
        let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Capture(logs.clone()))
            .with_max_level(tracing::Level::TRACE)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            for (railway, stamp) in [
                (Some("MARKER-RWENV-4337-log"), None),
                (None, Some("MARKER-PLATFORM-4337-log")),
                (
                    Some("MARKER-RWENV-4337-log"),
                    Some("MARKER-PLATFORM-4337-log"),
                ),
            ] {
                HostPlatform::classify(env(railway, stamp));
                CohostedAgentConfig::from_lookup(|name| match name {
                    "RAILWAY_ENVIRONMENT_ID" => railway.map(str::to_string),
                    "MOMO_SELF_HOST_PLATFORM" => stamp.map(str::to_string),
                    _ => None,
                });
            }
            // Positive control: the capture really sees this thread's events.
            tracing::warn!("capture-control-4337");
        });
        let text = String::from_utf8_lossy(&logs.lock().unwrap()).to_ascii_lowercase();
        assert!(
            text.contains("capture-control-4337"),
            "capture is deaf: {text}"
        );
        assert!(!text.contains("marker-"), "{text}");
    }
}
