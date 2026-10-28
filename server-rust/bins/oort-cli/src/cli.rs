//! The command line (ADR-0216 D10 「1차 명령」). Nothing here takes a secret as an argument.

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::store::StoragePref;

/// Names of the operator script `scripts/oort` (ADR-0216 D10 rule 1): reserved, never used here.
pub const RESERVED_COMMAND_NAMES: [&str; 7] = [
    "doctor", "status", "logs", "upgrade", "backup", "restore", "member",
];

#[derive(Parser, Debug)]
#[command(
    name = "oort",
    about = "터미널에서 oort를 써요 (서버 운영 도구는 scripts/oort예요)",
    disable_version_flag = true,
    disable_help_subcommand = true
)]
pub struct Cli {
    /// 버전을 알려 줘요
    #[arg(short = 'V', long = "version")]
    pub version: bool,
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Args, Debug, Clone)]
pub struct Global {
    /// 결과를 JSON 문서 하나로 (오류는 표준에러에 JSON)
    #[arg(long, global = true)]
    pub json: bool,
    /// oort 서버 주소 (환경 변수 OORT_SERVER)
    #[arg(long, global = true, value_name = "URL")]
    pub server: Option<String>,
    /// 워크스페이스 id (환경 변수 OORT_WORKSPACE)
    #[arg(long, global = true, value_name = "ID")]
    pub workspace: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// 로그인해요 (기본은 브라우저 승인)
    Login(LoginArgs),
    /// 서버에서 이 로그인을 끝내고 저장된 자격을 지워요
    Logout,
    /// 지금 어느 서버·워크스페이스에 어떤 권한으로 붙어 있는지 보여 줘요
    Whoami,
    /// 볼 수 있는 채널을 보여 줘요
    Channels,
    /// 채널(또는 스레드)의 메시지를 오래된 것부터 읽어요
    Read(ReadArgs),
    /// 메시지를 보내요 (바로 전송돼요)
    Post(PostArgs),
    /// 내 inbox를 읽어요 (읽음 처리는 하지 않아요)
    Inbox(InboxArgs),
    /// 지금 쓸 토큰을 표준출력으로 내보내요
    Token(TokenArgs),
    /// Claude Code·Codex 같은 도구에 붙일 stdio MCP 서버
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum StorageArg {
    /// 키체인이 있으면 키체인, 없는 환경에서만 파일
    Auto,
    /// 파일(0600)에 저장
    File,
    /// 키체인에 저장 (없으면 오류)
    Keychain,
}

impl From<StorageArg> for StoragePref {
    fn from(value: StorageArg) -> StoragePref {
        match value {
            StorageArg::Auto => StoragePref::Auto,
            StorageArg::File => StoragePref::File,
            StorageArg::Keychain => StoragePref::Keychain,
        }
    }
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// 승인 화면에 보일 이 기기의 이름 (기본: 「oort CLI · macOS」)
    #[arg(long, value_name = "이름")]
    pub name: Option<String>,
    /// 브라우저를 열지 않고 주소만 보여 줘요 (같은 기기의 브라우저용이에요)
    #[arg(long)]
    pub no_browser: bool,
    /// 표준입력에서 카드 토큰 한 줄을 읽어 저장해요 (토큰을 인자로 받지 않아요)
    #[arg(long)]
    pub with_token: bool,
    /// 자격을 어디에 둘지
    #[arg(long, value_enum, default_value_t = StorageArg::Auto)]
    pub storage: StorageArg,
}

#[derive(Args, Debug)]
pub struct ReadArgs {
    /// `#이름` 또는 채널 id
    pub channel: String,
    /// 이 루트 메시지 id의 스레드를 읽어요
    #[arg(long, value_name = "루트 id")]
    pub thread: Option<String>,
    /// 이 seq보다 새 메시지만 (오래된 쪽에서 새 쪽으로)
    #[arg(long, value_name = "seq")]
    pub since: Option<i64>,
    /// 이 seq보다 오래된 메시지만
    #[arg(long, value_name = "seq")]
    pub before: Option<i64>,
    /// 한 번에 가져올 개수 (1~200)
    #[arg(long, value_name = "N")]
    pub limit: Option<u32>,
}

#[derive(Args, Debug)]
pub struct PostArgs {
    /// `#이름` 또는 채널 id
    pub channel: String,
    /// 이 루트 메시지 id의 스레드에 답해요
    #[arg(long, value_name = "루트 id")]
    pub thread: Option<String>,
    /// 이 메시지 id를 인용해 답해요
    #[arg(long, value_name = "id")]
    pub reply_to: Option<String>,
    /// 같은 값으로 다시 보내면 한 번만 반영돼요 (생략하면 새로 만들어요)
    #[arg(long, value_name = "uuid")]
    pub client_msg_id: Option<String>,
    /// 보낼 글 (`-`이면 표준입력)
    pub text: String,
}

#[derive(Args, Debug)]
pub struct InboxArgs {
    /// 한 번에 가져올 개수
    #[arg(long, value_name = "N")]
    pub limit: Option<u32>,
}

#[derive(Args, Debug)]
pub struct TokenArgs {
    /// 헤더 도우미용 JSON (`{"Authorization":"Bearer …"}`)
    #[arg(long)]
    pub headers: bool,
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn no_subcommand_borrows_a_name_of_the_operator_script() {
        let command = Cli::command();
        for subcommand in command.get_subcommands() {
            assert!(
                !RESERVED_COMMAND_NAMES.contains(&subcommand.get_name()),
                "`oort {}` collides with scripts/oort",
                subcommand.get_name()
            );
        }
        let names: Vec<_> = command
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .collect();
        for expected in [
            "login", "logout", "whoami", "channels", "read", "post", "inbox", "token", "mcp",
        ] {
            assert!(names.iter().any(|name| name == expected), "{expected}");
        }
    }

    #[test]
    fn no_argument_of_any_command_can_carry_a_token() {
        let command = Cli::command();
        for subcommand in command.get_subcommands() {
            for argument in subcommand.get_arguments() {
                let id = argument.get_id().as_str();
                assert!(
                    !id.contains("token") || id == "with_token",
                    "`oort {} --{id}`: a secret must not travel in argv",
                    subcommand.get_name()
                );
            }
        }
        // and `--with-token` is a switch, not an option that takes a value
        let login = command.find_subcommand("login").expect("login");
        let with_token = login
            .get_arguments()
            .find(|argument| argument.get_id() == "with_token")
            .expect("--with-token");
        assert!(!with_token.get_action().takes_values());
    }
}
