//! One error type, one exit-code table (ADR-0216 D10).

use std::fmt;

use serde::Serialize;

use crate::output::sanitize;

/// What kind of failure this is. The exit code follows the kind, never the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 1 — anything else.
    Failure,
    /// 2 — the command line is wrong.
    Usage,
    /// 3 — a login is needed (401, or no stored credential).
    LoginRequired,
    /// 4 — not allowed (403: scope, policy, the closed list).
    Forbidden,
    /// 5 — not found (404, and the refusal a channel outside the token's reach gets).
    NotFound,
    /// 6 — over a budget (429).
    RateLimited,
    /// 7 — the server or the network.
    Server,
}

impl Kind {
    pub fn exit_code(self) -> i32 {
        match self {
            Kind::Failure => 1,
            Kind::Usage => 2,
            Kind::LoginRequired => 3,
            Kind::Forbidden => 4,
            Kind::NotFound => 5,
            Kind::RateLimited => 6,
            Kind::Server => 7,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CliError {
    pub kind: Kind,
    /// Stable machine code (`oort.cli.error.v1` `code`): the server's own `error.code` when it
    /// sent one, otherwise one of ours.
    pub code: String,
    /// Already safe to print: no secret, control characters stripped.
    pub message: String,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<u64>,
}

impl CliError {
    pub fn new(kind: Kind, code: &str, message: impl AsRef<str>) -> CliError {
        CliError {
            kind,
            code: code.to_string(),
            message: sanitize(message.as_ref()),
            status: None,
            retry_after_seconds: None,
        }
    }

    pub fn usage(code: &str, message: impl AsRef<str>) -> CliError {
        CliError::new(Kind::Usage, code, message)
    }

    pub fn failure(code: &str, message: impl AsRef<str>) -> CliError {
        CliError::new(Kind::Failure, code, message)
    }

    pub fn login_required() -> CliError {
        CliError::new(
            Kind::LoginRequired,
            "login_required",
            "로그인이 필요해요. `oort login`으로 로그인해 주세요.",
        )
    }

    pub fn with_status(mut self, status: u16) -> CliError {
        self.status = Some(status);
        self
    }

    pub fn exit_code(&self) -> i32 {
        self.kind.exit_code()
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

/// `oort.cli.error.v1`, written to standard error in `--json` mode.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDoc<'a> {
    pub schema: &'static str,
    pub code: &'a str,
    pub status: Option<u16>,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

pub const ERROR_SCHEMA: &str = "oort.cli.error.v1";

impl CliError {
    pub fn doc(&self) -> ErrorDoc<'_> {
        ErrorDoc {
            schema: ERROR_SCHEMA,
            code: &self.code,
            status: self.status,
            message: &self.message,
            retry_after_seconds: self.retry_after_seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_code_table_is_the_adrs() {
        let table = [
            (Kind::Failure, 1),
            (Kind::Usage, 2),
            (Kind::LoginRequired, 3),
            (Kind::Forbidden, 4),
            (Kind::NotFound, 5),
            (Kind::RateLimited, 6),
            (Kind::Server, 7),
        ];
        for (kind, code) in table {
            assert_eq!(kind.exit_code(), code, "{kind:?}");
        }
    }

    #[test]
    fn a_message_is_stripped_of_control_characters_when_the_error_is_made() {
        let error = CliError::failure("x", "a\u{1b}[31mred\u{7}");
        assert!(!error.message.contains('\u{1b}'));
        assert!(!error.message.contains('\u{7}'));
    }
}
