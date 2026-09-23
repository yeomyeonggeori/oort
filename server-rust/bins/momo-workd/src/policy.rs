//! ADR-0188 D6 — execution isolation, enforced by the host from the first
//! session. Every rule here is a small pure function so a test can remove it and
//! watch the guarded behaviour come back (the red proofs in `tests/`).
//!
//! | invariant (ADR-0188 §3) | where |
//! |---|---|
//! | executable and arguments come from the host allowlist, never from the server | [`launch_spec`] (config: `crate::config::ToolEntry`) |
//! | a configuration that asks for bypass/auto is refused | [`is_forbidden_launch_argument`] |
//! | the permission mode is fixed; bypass/auto at session start → no session | [`check_session_modes`] |
//! | leaving the fixed mode mid-session closes the remote path | [`check_mode_update`] |
//! | no remote `shell` | [`check_remote_tool`] |
//! | remote text never runs an adapter slash command | [`check_prompt`] |
//! | only ACP adapters with a permission bridge | [`AdapterKind`], [`check_adapter_admitted`] |
//! | every ACP permission request is denied until the R1 bridge lands | [`decide_permission`] |
//! | project hooks / MCP servers / allow rules are not applied | [`AdapterKind::isolation_env`], [`session_new_params`], [`check_project_config`] |
//! | no TCP port | nothing in this crate binds a socket; the conformance test checks the process |
//!
//! ## How each adapter is isolated (measured 2026-09-23 against the published sources)
//!
//! Neither adapter reads configuration flags from its own command line, so the
//! switches travel in `session/new` `_meta` (Claude) and the environment (Codex).
//!
//! * **Claude** — `@agentclientprotocol/claude-agent-acp` 0.81.0 spreads
//!   `_meta.claudeCode.options` over its Agent SDK defaults
//!   (`settingSources: ["user","project","local"]`), and Agent SDK 0.3.280
//!   documents `settingSources: []` as "SDK isolation mode" (no user, project or
//!   local settings: no hooks, no permission allow rules, no plugins; only the
//!   managed-policy tier) and `strictMcpConfig: true` as "only the MCP servers
//!   passed programmatically" (`.mcp.json`, user settings and plugins ignored).
//!   `allowDangerouslySkipPermissions: false` is the adapter's own host opt-out:
//!   `bypassPermissions` leaves the mode catalog and a settings demand for it is
//!   clamped to `default`. Login is not a setting and is unaffected; CLAUDE.md
//!   (loaded only with the `project` source) is not read either.
//!
//!   Reads are fenced too (#2602 M-1). The adapter hands
//!   `_meta.claudeCode.options.settings` to the CLI as its programmatic
//!   settings tier, which applies with `settingSources: []`: the SDK documents
//!   `permissions.blockReadsOutsideWorkingDirectories` as "Refuse file-tool
//!   reads (Read, Grep, Glob, LSP) outside the working directories in every
//!   permission mode", and [`CLAUDE_READ_DENY`] denies the usual credential
//!   files inside the folder. Measured with the real adapter and Claude Code
//!   2.1.280: with the fence, a `Read` of `/etc/hosts` failed without even a
//!   permission request, and `cat /etc/hosts` reached the permission bridge
//!   (and was denied).
//! * **Codex — not admitted (#2602 M-2).** `@agentclientprotocol/codex-acp`
//!   1.13.0 has three presets and sends the chosen preset's approval policy on
//!   every turn (`approvalPolicy: agentMode.approvalPolicy`, its only
//!   producer). Even the strictest, `read-only` ("Ask for approval"), is
//!   `on-request` with a `workspaceWrite` sandbox: sandboxed commands and writes
//!   in the folder run without a permission request. No preset asks before
//!   every command (`untrusted` occurs nowhere in the adapter). So the
//!   permission bridge that ADR-0188 D6 calls the real defence does not hold,
//!   and [`check_adapter_admitted`] refuses Codex — in the config and at spawn —
//!   until ADR-0188 decides otherwise.
//!
//!   The isolation below stays correct for that day. The adapter starts every
//!   session in `INITIAL_AGENT_MODE` (default `agent`, an auto-review mode) and
//!   merges the JSON object in `CODEX_CONFIG` into each thread's config
//!   overrides, next to its own `features` table. Measured with the real
//!   adapter and codex-cli 0.156.1: dotted keys (`features.hooks`) travel as
//!   separate overrides beside that table, and whichever codex applies last
//!   wins — the flag was lost in one order. One nested `features` table is
//!   merged by the adapter into its own and survives in every order (#2602
//!   M-3). The adapter also marks the session folder *trusted*, which loads the
//!   project's `.codex/config.toml`, and codex deep-merges config layers
//!   (`codex-rs/config/src/merge.rs`), so no override can remove a project MCP
//!   server or rule: a Codex session is refused wherever a project `.codex`
//!   exists ([`check_project_config`]).

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::acp::LaunchSpec;
use crate::config::ToolEntry;

/// The tool key ADR-0188 D6 forbids remotely, whatever the allowlist says.
pub const REMOTE_SHELL_TOOL: &str = "shell";

/// Why a control was refused. `label()` is the ack's `errorLabel`, which the
/// server relays to the room on `work.control.acked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// ADR-0188 D6: no remote `shell`.
    ShellRefused,
    /// The spawn names a tool this host does not allowlist.
    ToolNotAllowlisted,
    /// ADR-0188 D6: the agent is not in the host's fixed permission mode.
    PermissionModeRefused,
    /// ADR-0188 D6: the adapter's permission requests do not cover every
    /// command and write, so it is not launched remotely (#2602 M-2).
    AdapterRefused,
    /// ADR-0188 D6: the folder carries project agent configuration the adapter
    /// would apply and the host cannot switch off.
    ProjectConfigRefused,
    /// The allowed folder does not resolve to a directory.
    WorkdirUnavailable,
    /// The adapter could not be started or did not complete the ACP handshake.
    AgentStartFailed,
    /// The server refused the session create.
    SessionCreateFailed,
    /// ADR-0188 D3 (host side): only the host owner may steer a session.
    RequesterNotOwner,
    /// The control addresses a session this host is not running.
    SessionNotFound,
    /// The session's remote path was closed (mode escape) or it is ending.
    SessionClosed,
    /// A kind this host does not serve (`read`, anything new).
    UnsupportedControl,
    /// The control's payload is not the shape its kind requires.
    InvalidControl,
    /// Remote text that starts with `/` would run an adapter command, not a
    /// prompt (#2602 L-7).
    SlashCommandRefused,
    /// The host already runs as many sessions as its config allows (#2602 L-2).
    HostBusy,
    /// The session already has as many queued instructions as it keeps
    /// (#2602 L-2).
    InputQueueFull,
}

impl Refusal {
    pub fn label(self) -> &'static str {
        match self {
            Self::ShellRefused => "shell_refused",
            Self::ToolNotAllowlisted => "tool_not_allowlisted",
            Self::PermissionModeRefused => "permission_mode_refused",
            Self::AdapterRefused => "adapter_refused",
            Self::ProjectConfigRefused => "project_config_refused",
            Self::WorkdirUnavailable => "workdir_unavailable",
            Self::AgentStartFailed => "agent_start_failed",
            Self::SessionCreateFailed => "session_create_failed",
            Self::RequesterNotOwner => "requester_not_owner",
            Self::SessionNotFound => "session_not_found",
            Self::SessionClosed => "session_closed",
            Self::UnsupportedControl => "unsupported_control",
            Self::InvalidControl => "invalid_control",
            Self::SlashCommandRefused => "slash_command_refused",
            Self::HostBusy => "host_busy",
            Self::InputQueueFull => "input_queue_full",
        }
    }
}

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

/// The ACP adapters this host launches. A closed set: an adapter is admitted
/// only once its permission requests are known to reach the host (ADR-0188 D6
/// "원격 spawn은 ACP 권한 다리가 있는 도구만") and its isolation switches are
/// known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterKind {
    /// Claude Code through its ACP adapter.
    Claude,
    /// Codex through its ACP adapter.
    Codex,
}

/// Codex's session preset the host fixes (`codex-acp` `AgentMode.ReadOnly`,
/// "Ask for approval": approvals on request, reviewed by the user).
pub const CODEX_FIXED_MODE: &str = "read-only";

impl AdapterKind {
    /// The one permission mode a remote session may be in. Anything else —
    /// at start or later — is refused rather than corrected.
    pub fn fixed_mode(self) -> &'static str {
        match self {
            // Claude Code's `default` ("Manual"): edits and commands ask.
            Self::Claude => "default",
            // Not `agent` (auto-review) and not `agent-full-access` (never asks).
            Self::Codex => CODEX_FIXED_MODE,
        }
    }

    /// Environment the host sets on the adapter so project hooks, MCP servers
    /// and allow rules are not applied (ADR-0188 D6). Set after the owner's own
    /// environment, so an inherited value cannot win.
    pub fn isolation_env(self) -> Vec<(String, String)> {
        match self {
            Self::Claude => Vec::new(),
            Self::Codex => vec![
                // Otherwise every session opens in the auto-review mode.
                (
                    "INITIAL_AGENT_MODE".to_string(),
                    CODEX_FIXED_MODE.to_string(),
                ),
                // Per-thread config overrides, as ONE nested `features` table.
                // The adapter adds its own `features.cwd_relative_turn_diffs`
                // by spreading our table (`forceGitRootTurnDiffPaths`), so a
                // single `features` override reaches codex. Dotted keys would
                // travel beside that table, and codex applies the override map
                // in hash order with the last write winning: measured, the
                // flags were lost whenever the table came last (#2602 M-3).
                (
                    "CODEX_CONFIG".to_string(),
                    json!({
                        "features": {"hooks": false, "plugins": false, "apps": false},
                        "notify": [],
                    })
                    .to_string(),
                ),
            ],
        }
    }

    /// `session/new` `_meta` for the same purpose, when the adapter reads one.
    pub fn session_new_meta(self) -> Option<Value> {
        match self {
            Self::Claude => Some(json!({
                "claudeCode": {
                    "options": {
                        "settingSources": [],
                        "strictMcpConfig": true,
                        "allowDangerouslySkipPermissions": false,
                        "settings": {
                            "permissions": {
                                "blockReadsOutsideWorkingDirectories": true,
                                "disableBypassPermissionsMode": "disable",
                                "deny": CLAUDE_READ_DENY,
                            }
                        },
                    }
                }
            })),
            Self::Codex => None,
        }
    }
}

/// Credential files a remote Claude session may not read even inside the
/// allowed folder (the fence already covers everything outside it), plus the
/// owner's own credential directories for a folder that happens to contain
/// them. Claude Code permission-rule syntax: `~/` is the home directory, `**`
/// any depth.
pub const CLAUDE_READ_DENY: &[&str] = &[
    "Read(**/.env)",
    "Read(**/.env.*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/id_rsa*)",
    "Read(**/id_ecdsa*)",
    "Read(**/id_ed25519*)",
    "Read(**/.npmrc)",
    "Read(**/.pypirc)",
    "Read(**/.netrc)",
    "Read(**/.git-credentials)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.gnupg/**)",
    "Read(~/.config/gh/**)",
    "Read(~/.docker/config.json)",
    "Read(~/.kube/**)",
    "Read(~/.codex/**)",
    "Read(~/.claude/**)",
];

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/// Environment variables never handed to an agent: the host's own
/// configuration (including the one-shot registration token) is not the
/// agent's business.
fn is_withheld_env(key: &str) -> bool {
    key.starts_with("MOMO_") || key.starts_with("OORT_")
}

/// Build the launch for one allowlisted tool. The only inputs are the owner's
/// allowlist entry, the resolved folder, and the host's own environment — no
/// server-provided value reaches the command line.
pub fn launch_spec(
    entry: &ToolEntry,
    cwd: &Path,
    parent_env: impl IntoIterator<Item = (String, String)>,
) -> LaunchSpec {
    let mut env: Vec<(String, String)> = parent_env
        .into_iter()
        .filter(|(key, _)| !is_withheld_env(key))
        .collect();
    for (key, value) in entry.adapter.isolation_env() {
        env.retain(|(existing, _)| existing != &key);
        env.push((key, value));
    }
    LaunchSpec {
        program: entry.executable.clone(),
        args: entry.args.clone(),
        env,
        cwd: cwd.to_path_buf(),
    }
}

/// ADR-0188 D6 for Codex: refuse a folder with a project `.codex` anywhere from
/// `cwd` up to its git root. `codex-acp` trusts the session folder, codex then
/// loads `.codex/config.toml` from each of those directories, and its
/// deep-merged layers leave the host no override that removes a project MCP
/// server or rule. `codex_home` (the owner's own `~/.codex`) is the user layer,
/// not a project one, and is skipped. Claude's project settings are switched
/// off by `settingSources: []`, so nothing is refused for it here.
pub fn check_project_config(
    adapter: AdapterKind,
    cwd: &Path,
    codex_home: Option<&Path>,
) -> Result<(), Refusal> {
    if adapter != AdapterKind::Codex {
        return Ok(());
    }
    let codex_home = codex_home.and_then(|home| std::fs::canonicalize(home).ok());
    // The directories codex reads project layers from: `cwd` and its parents up
    // to the repository root (only `cwd` when there is no repository).
    let mut chain: Vec<PathBuf> = Vec::new();
    let mut repository_root = false;
    for directory in cwd.ancestors() {
        chain.push(directory.to_path_buf());
        if directory.join(".git").exists() {
            repository_root = true;
            break;
        }
    }
    if !repository_root {
        chain.truncate(1);
    }
    for directory in chain {
        let dot_codex = directory.join(".codex");
        if !dot_codex.exists() {
            continue;
        }
        let is_user_home = codex_home
            .as_deref()
            .is_some_and(|home| std::fs::canonicalize(&dot_codex).ok().as_deref() == Some(home));
        if !is_user_home {
            return Err(Refusal::ProjectConfigRefused);
        }
    }
    Ok(())
}

/// Where Codex keeps the owner's own configuration: `$CODEX_HOME`, else
/// `$HOME/.codex`.
pub fn codex_home(env: &[(String, String)]) -> Option<PathBuf> {
    let lookup = |name: &str| {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    lookup("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| lookup("HOME").map(|home| Path::new(&home).join(".codex")))
}

/// `session/new` params: the resolved folder, **no** MCP servers, and the
/// adapter's isolation `_meta` when it has one.
pub fn session_new_params(adapter: AdapterKind, cwd: &Path) -> Value {
    let mut params = json!({
        "cwd": cwd.display().to_string(),
        "mcpServers": [],
    });
    if let Some(meta) = adapter.session_new_meta() {
        params["_meta"] = meta;
    }
    params
}

/// Arguments that would relax the fixed permission mode, re-open a
/// configuration source, or hand the command line to the raw CLI. Needles are
/// matched case-insensitively as substrings, so
/// `--permission-mode=bypassPermissions` and `-c approval_policy="never"` are
/// both caught; the flags below are matched as whole arguments (`--cli`,
/// `--cli=…`) or, for single-letter ones, with their value glued on (`-snever`).
///
/// Still a deny list (#2602 L-5 is only partly closed): an owner-written
/// argument that relaxes the agent in a way not named here is not caught, and
/// the session mode check stays the backstop.
pub fn is_forbidden_launch_argument(argument: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "dangerously",
        "danger",
        "bypass",
        "yolo",
        "full-auto",
        "full_auto",
        "permission-mode",
        "permission_mode",
        "approval_policy",
        "approval-policy",
        "ask-for-approval",
        "sandbox",
        "network_access",
        "acceptedits",
        "dontask",
        "allowedtools",
        "allowed-tools",
        "mcp",
        "setting-sources",
        "settings",
        "hooks",
    ];
    // The raw CLI behind each adapter (`codex-acp cli …`,
    // `claude-agent-acp --cli`) and Codex's config/approval/sandbox flags.
    const FLAGS: &[&str] = &["cli", "--cli", "--config", "--profile"];
    const SHORT_FLAGS: &[&str] = &["-a", "-c", "-s", "-p"];
    let lowered = argument.to_ascii_lowercase();
    NEEDLES.iter().any(|needle| lowered.contains(needle))
        || FLAGS.iter().any(|flag| {
            lowered == *flag
                || lowered
                    .strip_prefix(flag)
                    .is_some_and(|rest| rest.starts_with('='))
        })
        || SHORT_FLAGS.iter().any(|flag| lowered.starts_with(flag))
}

/// `^[a-z0-9][a-z0-9._-]{1,63}$` — the server's work tool key.
pub fn is_valid_tool_key(raw: &str) -> bool {
    let mut characters = raw.chars();
    let first_ok = characters
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest: Vec<char> = characters.collect();
    first_ok
        && (1..=63).contains(&rest.len())
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(*c))
}

// ---------------------------------------------------------------------------
// the invariants
// ---------------------------------------------------------------------------

/// ADR-0188 D6 「원격 spawn은 ACP 권한 다리가 있는 도구만」: only an adapter
/// whose permission requests cover every command and write is launched. Claude
/// in `default` asks before every edit and command. Codex has no such mode (see
/// the module docs, #2602 M-2) and is refused until ADR-0188 is revised.
pub fn check_adapter_admitted(adapter: AdapterKind) -> Result<(), Refusal> {
    match adapter {
        AdapterKind::Claude => Ok(()),
        AdapterKind::Codex => Err(Refusal::AdapterRefused),
    }
}

/// Remote text is a prompt, never an adapter command (#2602 L-7). Both
/// adapters run a first line that starts with `/` as their own verb — Codex's
/// `/logout` signs the owner out without a permission request, and `/compact`
/// or `/rename` act on the session — so a spawn label or an input that starts
/// with `/` is refused rather than escaped: the owner rephrases.
pub fn check_prompt(text: &str) -> Result<(), Refusal> {
    if text.trim_start().starts_with('/') {
        return Err(Refusal::SlashCommandRefused);
    }
    Ok(())
}

/// ADR-0188 D6: a remote spawn of `shell` is refused, before the allowlist is
/// even consulted — an owner who allowlisted something called `shell` still
/// does not get a remote shell.
pub fn check_remote_tool(tool: &str) -> Result<(), Refusal> {
    if tool.trim().eq_ignore_ascii_case(REMOTE_SHELL_TOOL) {
        return Err(Refusal::ShellRefused);
    }
    Ok(())
}

/// ADR-0188 D6: the session must be in the adapter's fixed mode when it opens.
/// `modes` is the `session/new` result's `modes` object. An adapter that does
/// not report a mode cannot prove it is not in bypass/auto, so it is refused
/// too — the host does not guess.
pub fn check_session_modes(adapter: AdapterKind, modes: Option<&Value>) -> Result<(), Refusal> {
    let current = modes
        .and_then(|modes| modes.get("currentModeId"))
        .and_then(Value::as_str);
    match current {
        Some(mode) if mode == adapter.fixed_mode() => Ok(()),
        _ => Err(Refusal::PermissionModeRefused),
    }
}

/// ADR-0188 D6: a mid-session mode change away from the fixed mode closes the
/// remote path.
pub fn check_mode_update(adapter: AdapterKind, mode: &str) -> Result<(), Refusal> {
    if mode == adapter.fixed_mode() {
        Ok(())
    } else {
        Err(Refusal::PermissionModeRefused)
    }
}

/// One `session/request_permission` option.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: String,
}

/// The host's answer to a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Select the agent's own one-time rejection.
    Reject { option_id: String },
    /// No one-time rejection on offer: answer `cancelled`, which every ACP agent
    /// must treat as "not permitted".
    Cancelled,
}

impl PermissionDecision {
    /// The `session/request_permission` result.
    pub fn to_result(&self) -> Value {
        match self {
            Self::Reject { option_id } => {
                json!({"outcome": {"outcome": "selected", "optionId": option_id}})
            }
            Self::Cancelled => json!({"outcome": {"outcome": "cancelled"}}),
        }
    }
}

/// Parse the options of a `session/request_permission` request.
pub fn permission_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(PermissionOption {
                        option_id: option.get("optionId")?.as_str()?.to_string(),
                        kind: option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// ADR-0188 D5/D6 until the R1 permission bridge exists: **every** request is
/// denied. Never an `allow_*` option, and never `reject_always` either — a
/// persistent rule would be written into the agent's settings, and ADR-0188 D5
/// keeps the host from writing rule files.
pub fn decide_permission(options: &[PermissionOption]) -> PermissionDecision {
    options
        .iter()
        .find(|option| option.kind == "reject_once")
        .map(|option| PermissionDecision::Reject {
            option_id: option.option_id.clone(),
        })
        .unwrap_or(PermissionDecision::Cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(adapter: AdapterKind) -> ToolEntry {
        ToolEntry {
            adapter,
            executable: PathBuf::from("/opt/agents/bin/adapter"),
            args: vec!["--owner-flag".to_string()],
        }
    }

    #[test]
    fn shell_is_refused_in_any_case() {
        assert_eq!(check_remote_tool("shell"), Err(Refusal::ShellRefused));
        assert_eq!(check_remote_tool("SHELL"), Err(Refusal::ShellRefused));
        assert_eq!(check_remote_tool(" shell "), Err(Refusal::ShellRefused));
        assert_eq!(check_remote_tool("claude"), Ok(()));
    }

    #[test]
    fn only_the_fixed_mode_opens_a_session() {
        let modes = |current: &str| json!({"currentModeId": current, "availableModes": []});
        assert_eq!(
            check_session_modes(AdapterKind::Claude, Some(&modes("default"))),
            Ok(())
        );
        for mode in [
            "bypassPermissions",
            "acceptEdits",
            "plan",
            "dontAsk",
            "auto",
        ] {
            assert_eq!(
                check_session_modes(AdapterKind::Claude, Some(&modes(mode))),
                Err(Refusal::PermissionModeRefused),
                "{mode}"
            );
        }
        assert_eq!(
            check_session_modes(AdapterKind::Claude, None),
            Err(Refusal::PermissionModeRefused),
            "no reported mode is not proof of a safe mode"
        );
        assert_eq!(check_mode_update(AdapterKind::Claude, "default"), Ok(()));
        assert_eq!(
            check_mode_update(AdapterKind::Claude, "bypassPermissions"),
            Err(Refusal::PermissionModeRefused)
        );
    }

    #[test]
    fn permission_requests_are_never_allowed() {
        let options = |kinds: &[&str]| -> Vec<PermissionOption> {
            kinds
                .iter()
                .map(|kind| PermissionOption {
                    option_id: format!("id-{kind}"),
                    kind: kind.to_string(),
                })
                .collect()
        };
        assert_eq!(
            decide_permission(&options(&["allow_always", "allow_once", "reject_once"])),
            PermissionDecision::Reject {
                option_id: "id-reject_once".into()
            }
        );
        assert_eq!(
            decide_permission(&options(&["allow_always", "allow_once"])),
            PermissionDecision::Cancelled
        );
        assert_eq!(
            decide_permission(&options(&["allow_once", "reject_always"])),
            PermissionDecision::Cancelled,
            "reject_always would write a rule file"
        );
        assert_eq!(decide_permission(&[]), PermissionDecision::Cancelled);
        assert_eq!(
            PermissionDecision::Cancelled.to_result(),
            json!({"outcome": {"outcome": "cancelled"}})
        );
    }

    #[test]
    fn the_launch_comes_from_the_allowlist_and_withholds_host_env() {
        let spec = launch_spec(
            &entry(AdapterKind::Claude),
            Path::new("/work/repo"),
            vec![
                ("HOME".to_string(), "/Users/me".to_string()),
                (
                    "MOMO_WORKD_REGISTER_TOKEN".to_string(),
                    "secret".to_string(),
                ),
                ("PATH".to_string(), "/usr/bin".to_string()),
            ],
        );
        assert_eq!(spec.program, PathBuf::from("/opt/agents/bin/adapter"));
        assert_eq!(spec.args.first().map(String::as_str), Some("--owner-flag"));
        assert_eq!(spec.cwd, PathBuf::from("/work/repo"));
        assert!(spec.env.iter().any(|(key, _)| key == "HOME"));
        assert!(
            !spec.env.iter().any(|(key, _)| key.starts_with("MOMO_")),
            "the registration token must not reach an agent"
        );
        let params = session_new_params(AdapterKind::Claude, Path::new("/work/repo"));
        assert_eq!(params["mcpServers"], json!([]));
        assert_eq!(params["cwd"], "/work/repo");
    }

    #[test]
    fn claude_is_isolated_through_session_meta() {
        let params = session_new_params(AdapterKind::Claude, Path::new("/work/repo"));
        let options = &params["_meta"]["claudeCode"]["options"];
        assert_eq!(
            options["settingSources"],
            json!([]),
            "no user/project/local settings"
        );
        assert_eq!(
            options["strictMcpConfig"], true,
            "no .mcp.json, user or plugin MCP"
        );
        assert_eq!(
            options["allowDangerouslySkipPermissions"], false,
            "no bypass mode"
        );
        // #2602 M-1: reads are fenced to the folder, credential files denied.
        let permissions = &options["settings"]["permissions"];
        assert_eq!(permissions["blockReadsOutsideWorkingDirectories"], true);
        assert_eq!(permissions["disableBypassPermissionsMode"], "disable");
        let deny: Vec<&str> = permissions["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| rule.as_str().unwrap())
            .collect();
        for rule in ["Read(~/.ssh/**)", "Read(~/.codex/**)", "Read(**/.env)"] {
            assert!(deny.contains(&rule), "{rule} is denied");
        }
        assert!(AdapterKind::Claude.isolation_env().is_empty());
    }

    #[test]
    fn codex_is_isolated_through_its_environment_and_wins_over_inherited_values() {
        let spec = launch_spec(
            &entry(AdapterKind::Codex),
            Path::new("/work/repo"),
            vec![
                (
                    "INITIAL_AGENT_MODE".to_string(),
                    "agent-full-access".to_string(),
                ),
                ("CODEX_CONFIG".to_string(), "{}".to_string()),
            ],
        );
        let value = |name: &str| {
            let matches: Vec<&String> = spec
                .env
                .iter()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value)
                .collect();
            assert_eq!(matches.len(), 1, "{name} is set exactly once");
            matches[0].clone()
        };
        assert_eq!(value("INITIAL_AGENT_MODE"), "read-only");
        let config: Value = serde_json::from_str(&value("CODEX_CONFIG")).unwrap();
        // #2602 M-3: one nested table, no dotted keys beside it.
        assert_eq!(
            config,
            json!({"features": {"hooks": false, "plugins": false, "apps": false}, "notify": []})
        );
        assert!(config
            .as_object()
            .unwrap()
            .keys()
            .all(|key| !key.contains('.')));
        assert!(session_new_params(AdapterKind::Codex, Path::new("/w"))
            .get("_meta")
            .is_none());
    }

    /// The shape codex-acp 1.13.0 builds before `thread/start`
    /// (`forceGitRootTurnDiffPaths`: spread our `features`, add its own key).
    /// With the nested form a single `features` override carries all four
    /// flags; measured the same with the real adapter's `thread/start` log.
    #[test]
    fn the_adapter_merge_keeps_every_codex_flag_in_one_table() {
        let (_, raw) = AdapterKind::Codex
            .isolation_env()
            .into_iter()
            .find(|(key, _)| key == "CODEX_CONFIG")
            .unwrap();
        let mut config: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap();
        let mut features = config
            .get("features")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        features.insert("cwd_relative_turn_diffs".into(), json!(false));
        config.insert("features".into(), Value::Object(features));
        assert_eq!(
            Value::Object(config.clone()),
            json!({
                "features": {"hooks": false, "plugins": false, "apps": false,
                             "cwd_relative_turn_diffs": false},
                "notify": []
            })
        );
        assert_eq!(
            config
                .keys()
                .filter(|key| key.starts_with("features"))
                .count(),
            1,
            "one features override, so no application order can drop a flag"
        );
    }

    #[test]
    fn only_claude_is_admitted_remotely() {
        assert_eq!(check_adapter_admitted(AdapterKind::Claude), Ok(()));
        assert_eq!(
            check_adapter_admitted(AdapterKind::Codex),
            Err(Refusal::AdapterRefused)
        );
        assert_eq!(Refusal::AdapterRefused.label(), "adapter_refused");
    }

    #[test]
    fn a_codex_session_is_refused_where_a_project_codex_folder_exists() {
        let root = std::env::temp_dir().join(format!(
            "momo-workd-policy-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let repo = root.join("repo");
        let nested = repo.join("service");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let home = root.join("home").join(".codex");
        std::fs::create_dir_all(&home).unwrap();

        assert_eq!(
            check_project_config(AdapterKind::Codex, &nested, Some(&home)),
            Ok(())
        );
        // A project layer at the repository root is seen from a nested folder.
        std::fs::create_dir_all(repo.join(".codex")).unwrap();
        assert_eq!(
            check_project_config(AdapterKind::Codex, &nested, Some(&home)),
            Err(Refusal::ProjectConfigRefused)
        );
        // Claude's project settings are off by `settingSources: []` instead.
        assert_eq!(
            check_project_config(AdapterKind::Claude, &nested, Some(&home)),
            Ok(())
        );
        // The owner's own CODEX_HOME is the user layer, not a project one.
        std::fs::remove_dir_all(repo.join(".codex")).unwrap();
        std::os::unix::fs::symlink(&home, repo.join(".codex")).unwrap();
        assert_eq!(
            check_project_config(AdapterKind::Codex, &nested, Some(&home)),
            Ok(())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bypass_style_arguments_are_recognised() {
        for argument in [
            "--dangerously-skip-permissions",
            "--permission-mode",
            "bypassPermissions",
            "-c approval_policy=never",
            "--sandbox=danger-full-access",
            "--mcp-config=/tmp/x.json",
            "--settings",
            // #2602 L-5: Codex's short flags and the raw CLI passthroughs.
            "-s",
            "danger-full-access",
            "-a",
            "-anever",
            "-c",
            "sandbox_workspace_write.network_access=true",
            "--config=profile.toml",
            "cli",
            "--cli",
            "--CLI=/bin/sh",
        ] {
            assert!(is_forbidden_launch_argument(argument), "{argument}");
        }
        for argument in [
            "--model",
            "opus",
            "--verbose",
            "--record",
            "--permission",
            "--mode",
            "auto",
            "clinic",
            "--client-name",
        ] {
            assert!(!is_forbidden_launch_argument(argument), "{argument}");
        }
    }

    #[test]
    fn remote_text_never_starts_an_adapter_command() {
        for text in ["/logout", "  /compact", "\n/rename x", "/"] {
            assert_eq!(
                check_prompt(text),
                Err(Refusal::SlashCommandRefused),
                "{text:?}"
            );
        }
        for text in ["fix /etc/hosts parsing", "read src/lib.rs", "a/b"] {
            assert_eq!(check_prompt(text), Ok(()), "{text:?}");
        }
    }

    #[test]
    fn tool_keys_follow_the_server_vocabulary() {
        assert!(is_valid_tool_key("claude"));
        assert!(is_valid_tool_key("codex-acp"));
        assert!(!is_valid_tool_key("c"));
        assert!(!is_valid_tool_key("Claude"));
        assert!(!is_valid_tool_key("-x"));
    }
}
