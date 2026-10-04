//! The environment the person's shell gets (ADR-0197 D4.6, ADR-0191 D2,
//! ADR-0188 §8.1 condition 8): **built from an allowlist, never inherited**.
//!
//! The agent's own environment carries box plumbing (`OORT_BOX_*`, the key
//! directory, the seal-key path). None of it, and no credential-shaped
//! variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`
//! …), may reach a PTY: the person logs in inside the terminal with the
//! official flow, and nothing injects a token for them.

use std::ffi::OsString;

/// Variables copied from the agent's environment when present.
pub const PASSTHROUGH: &[&str] = &[
    "PATH",
    "LANG",
    "LANGUAGE",
    "TZ",
    "COLORTERM",
    "NO_COLOR",
    // Where the harness CLIs keep their own login (D4.5). A path, not a secret;
    // the box image sets them to the credential directory.
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "DISABLE_AUTOUPDATER",
];

/// Passthrough by prefix (`LC_ALL`, `LC_CTYPE` …).
pub const PASSTHROUGH_PREFIXES: &[&str] = &["LC_"];

/// A name containing any of these never passes, even if someone adds it to
/// [`PASSTHROUGH`] later (the unit test pins the two lists against each other).
pub const FORBIDDEN_FRAGMENTS: &[&str] = &[
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "OAUTH",
    "ANTHROPIC",
    "OPENAI",
    "CLAUDE_CODE",
    "CODEX_API",
    "OORT_",
    "MOMO_",
];

/// What the box fixes about the person's account. These are set by the agent,
/// never copied from anywhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserProfile {
    pub uid: u32,
    pub gid: u32,
    pub name: String,
    pub home: String,
    pub shell: String,
    pub cwd: String,
}

impl UserProfile {
    /// The box image's person (`infra/personal-box/Dockerfile`).
    pub fn box_default() -> Self {
        Self {
            uid: 10001,
            gid: 10001,
            name: "box".into(),
            home: "/home/box".into(),
            shell: "/bin/bash".into(),
            cwd: "/work".into(),
        }
    }
}

pub const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
pub const DEFAULT_TERM: &str = "xterm-256color";

pub fn is_forbidden(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    FORBIDDEN_FRAGMENTS.iter().any(|f| upper.contains(f))
}

pub fn is_allowed(name: &str) -> bool {
    !is_forbidden(name)
        && (PASSTHROUGH.contains(&name) || PASSTHROUGH_PREFIXES.iter().any(|p| name.starts_with(p)))
}

fn clean_value(value: &str) -> bool {
    !value.contains('\0') && value.len() <= 4096
}

/// A `TERM` name: a terminfo-style token, nothing else.
pub fn valid_term(term: &str) -> bool {
    !term.is_empty()
        && term.len() <= 32
        && term
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// The child's environment: the profile's fixed names, `TERM`, then whatever
/// of `parent` the allowlist admits. Anything else in `parent` is dropped.
pub fn child_env(
    profile: &UserProfile,
    term: Option<&str>,
    parent: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![
        ("HOME".into(), profile.home.clone()),
        ("USER".into(), profile.name.clone()),
        ("LOGNAME".into(), profile.name.clone()),
        ("SHELL".into(), profile.shell.clone()),
        (
            "TERM".into(),
            term.filter(|t| valid_term(t))
                .unwrap_or(DEFAULT_TERM)
                .to_string(),
        ),
    ];
    let mut have_path = false;
    for (name, value) in parent {
        let (Some(name), Some(value)) = (name.to_str(), value.to_str()) else {
            continue;
        };
        if !is_allowed(name) || !clean_value(value) || out.iter().any(|(n, _)| n == name) {
            continue;
        }
        have_path |= name == "PATH";
        out.push((name.to_string(), value.to_string()));
    }
    if !have_path {
        out.push(("PATH".into(), DEFAULT_PATH.into()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(n, v)| (OsString::from(n), OsString::from(v)))
            .collect()
    }

    #[test]
    fn the_allowlist_and_the_forbidden_list_never_overlap() {
        for name in PASSTHROUGH {
            assert!(!is_forbidden(name), "{name} is both allowed and forbidden");
        }
        // A prefix family must not be able to smuggle a forbidden name either.
        for prefix in PASSTHROUGH_PREFIXES {
            assert!(!is_forbidden(&format!("{prefix}ALL")));
        }
    }

    #[test]
    fn credentials_and_box_plumbing_do_not_reach_the_child() {
        let polluted = os(&[
            ("PATH", "/usr/bin"),
            ("ANTHROPIC_API_KEY", "sk-ant-marker"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "marker"),
            ("OPENAI_API_KEY", "sk-marker"),
            ("OORT_BOX_KEY_DIR", "/var/lib/oort-box/key"),
            ("OORT_BOX_SEAL_KEY_FILE", "/run/oort-box-seal/seal.key"),
            ("OORT_BOX_ID", "x"),
            ("MOMO_WORKD_REGISTER_TOKEN", "owner-token"),
            ("AWS_SECRET_ACCESS_KEY", "marker"),
            ("GITHUB_TOKEN", "marker"),
            ("HTTPS_PROXY", "http://evil"),
            ("LD_PRELOAD", "/tmp/x.so"),
            ("CLAUDE_CONFIG_DIR", "/cred/claude"),
            ("CODEX_HOME", "/cred/codex"),
            ("LC_ALL", "C.UTF-8"),
        ]);
        let env = child_env(&UserProfile::box_default(), None, polluted);
        let names: Vec<&str> = env.iter().map(|(n, _)| n.as_str()).collect();
        for banned in [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
            "OORT_BOX_KEY_DIR",
            "OORT_BOX_SEAL_KEY_FILE",
            "OORT_BOX_ID",
            "MOMO_WORKD_REGISTER_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "HTTPS_PROXY",
            "LD_PRELOAD",
        ] {
            assert!(!names.contains(&banned), "{banned} leaked into the child");
        }
        for wanted in [
            "HOME",
            "USER",
            "SHELL",
            "TERM",
            "PATH",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "LC_ALL",
        ] {
            assert!(names.contains(&wanted), "{wanted} should be set");
        }
        assert!(
            !env.iter().any(|(_, v)| v.contains("marker")),
            "no marker value in the child's environment"
        );
    }

    #[test]
    fn the_profile_wins_over_the_parent_and_term_is_validated() {
        let env = child_env(
            &UserProfile::box_default(),
            Some("xterm; rm -rf /"),
            os(&[("HOME", "/root"), ("USER", "root"), ("PATH", "/a:/b")]),
        );
        let get = |n: &str| env.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
        assert_eq!(get("HOME"), Some("/home/box"));
        assert_eq!(get("USER"), Some("box"));
        assert_eq!(get("TERM"), Some(DEFAULT_TERM));
        assert_eq!(get("PATH"), Some("/a:/b"));
        let none = child_env(&UserProfile::box_default(), Some("tmux-256color"), []);
        let get = |n: &str| none.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some(DEFAULT_PATH));
        assert_eq!(get("TERM"), Some("tmux-256color"));
    }

    #[test]
    fn nul_and_oversized_values_are_dropped() {
        let long = "x".repeat(5000);
        let env = child_env(
            &UserProfile::box_default(),
            None,
            os(&[("LANG", "a\0b"), ("TZ", &long), ("LC_ALL", "C")]),
        );
        let names: Vec<&str> = env.iter().map(|(n, _)| n.as_str()).collect();
        assert!(!names.contains(&"LANG") && !names.contains(&"TZ"));
        assert!(names.contains(&"LC_ALL"));
    }
}
