//! `logout` · `whoami` · `channels` · `read` · `post` · `inbox` · `token`.
//!
//! Every command prints **one** document in `--json` mode (`schema` first, unknown fields only
//! ever added) and short readable lines otherwise. No command but `token` can print a secret:
//! the documents are built from response types that have no token field at all.

use std::io::{IsTerminal, Read};

use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::api::{
    parse_json, Channel, ChannelsPage, InboxItem, InboxPage, Message, MessagePage, Reply, SelfInfo,
};
use crate::cli::{InboxArgs, PostArgs, ReadArgs, TokenArgs};
use crate::error::{CliError, Kind};
use crate::output::{note, print_json, rfc3339, sanitize, short_id};
use crate::session::{Active, Ctx, Source};

const MAX_POST_BYTES: u64 = 1024 * 1024;
const CHANNEL_LIST_LIMIT: &str = "500";

fn stdout_failed() -> CliError {
    CliError::failure("stdout", "결과를 쓰지 못했어요.")
}

fn emit<T: Serialize>(doc: &T) -> Result<(), CliError> {
    print_json(doc).map_err(|_| stdout_failed())
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WhoamiDoc<'a> {
    schema: &'static str,
    server: &'a str,
    workspace_id: &'a str,
    member_id: &'a str,
    credential: CredentialDoc<'a>,
    scopes: &'a [String],
    channel_restricted: bool,
    created_at: String,
    expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lineage_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
    source: &'static str,
    storage: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialDoc<'a> {
    id: &'a str,
    kind: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<&'a str>,
}

pub fn whoami(ctx: &Ctx) -> Result<(), CliError> {
    let mut active = Active::resolve(ctx)?;
    let path = active.workspace_path("/dev-access/self");
    let reply = active.get(ctx, &path, &[])?;
    let info: SelfInfo = parse_json(&reply)?;
    let storage = active.source.storage().map(|kind| kind.as_str());
    if ctx.json {
        return emit(&WhoamiDoc {
            schema: "oort.cli.whoami.v1",
            server: &active.server,
            workspace_id: &info.workspace_id,
            member_id: &info.member_id,
            credential: CredentialDoc {
                id: &info.id,
                kind: &info.kind,
                name: &info.name,
                tool: info.tool.as_deref(),
                device_name: info.device_name.as_deref(),
            },
            scopes: &info.scopes,
            channel_restricted: info.channel_restricted,
            created_at: rfc3339(info.created_at_ms),
            expires_at: rfc3339(info.expires_at_ms),
            lineage_expires_at: info.lineage_expires_at_ms.map(rfc3339),
            last_used_at: info.last_used_at_ms.map(rfc3339),
            source: active.source.label(),
            storage,
        });
    }
    let kind = if info.kind == "card" {
        "카드 토큰"
    } else {
        "로그인 세션"
    };
    println!("서버: {}", active.server);
    println!("워크스페이스: {}", info.workspace_id);
    println!("나(멤버 id): {}", info.member_id);
    println!("자격: {kind} · {}", sanitize(&info.name));
    println!("범위: {}", info.scopes.join(", "));
    println!(
        "채널 제한: {}",
        if info.channel_restricted {
            "있어요"
        } else {
            "없어요"
        }
    );
    println!("만든 때: {}", rfc3339(info.created_at_ms));
    println!("만료: {}", rfc3339(info.expires_at_ms));
    if let Some(cap) = info.lineage_expires_at_ms {
        println!("로그인 최대 기한: {}", rfc3339(cap));
    }
    if let Some(used) = info.last_used_at_ms {
        println!("직전 사용: {}", rfc3339(used));
    }
    let place = match (active.source, storage) {
        (Source::Env, _) => "환경 변수 OORT_TOKEN".to_string(),
        (_, Some("keychain")) => "키체인".to_string(),
        (_, Some(other)) => format!("{other}(권한 0600)"),
        _ => "-".to_string(),
    };
    println!("저장 위치: {place}");
    Ok(())
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutDoc<'a> {
    schema: &'static str,
    server: Option<&'a str>,
    workspace_id: Option<&'a str>,
    local_removed: bool,
    /// `revoked` · `already_ended` · `unreachable` · `skipped`
    server_revocation: &'static str,
}

/// Ends the **stored** login on the server and removes it here. `OORT_TOKEN` is never used for
/// this and never touched: it is somebody's deployment, not a login this command made.
pub fn logout(ctx: &Ctx) -> Result<(), CliError> {
    let store = ctx.store()?;
    let Some(current) = store.current()? else {
        let doc = LogoutDoc {
            schema: "oort.cli.logout.v1",
            server: None,
            workspace_id: None,
            local_removed: false,
            server_revocation: "skipped",
        };
        if ctx.json {
            return emit(&doc);
        }
        println!("저장된 로그인이 없어요.");
        if ctx.env.token.is_some() {
            note("OORT_TOKEN은 환경 변수라 이 명령이 지우지 않아요. 서버의 카드는 설정 › 연결 › 명령줄·AI 도구에서 폐기해 주세요.");
        }
        return Ok(());
    };

    // Ask the server to end it. A login that cannot be loaded or presented is simply removed.
    let mut stored_ctx = Ctx {
        env: crate::Env {
            token: None,
            ..ctx.env.clone()
        },
        json: ctx.json,
        server: Some(current.server.clone()),
        workspace: Some(current.workspace_id.clone()),
    };
    stored_ctx.env.server = None;
    stored_ctx.env.workspace = None;
    let revocation = match Active::resolve(&stored_ctx) {
        Ok(mut active) => {
            let path = active.workspace_path("/dev-access/self");
            match active.delete(&stored_ctx, &path) {
                Ok(reply) if (200..300).contains(&reply.status) => "revoked",
                // Already ended by someone else: nothing is left to revoke.
                Ok(Reply { status: 401, .. }) => "already_ended",
                Ok(reply) => return_partial(&reply)?,
                Err(error) if error.kind == Kind::LoginRequired => "already_ended",
                Err(_) => "unreachable",
            }
        }
        Err(_) => "unreachable",
    };

    // The local copy goes whatever the server said: a logout that kept the secret because the
    // network was down would be worse than useless. The store lock keeps a concurrent refresh
    // from writing it back.
    let removed = {
        let _lock = store.lock()?;
        let removed = store
            .backend(current.storage)
            .and_then(|backend| backend.delete(&current.key()))?;
        store.clear_current()?;
        removed
    };
    let doc = LogoutDoc {
        schema: "oort.cli.logout.v1",
        server: Some(&current.server),
        workspace_id: Some(&current.workspace_id),
        local_removed: removed,
        server_revocation: revocation,
    };
    if ctx.json {
        emit(&doc)?;
    } else {
        println!("이 컴퓨터에서 로그아웃했어요.");
    }
    if revocation == "unreachable" {
        let mut error = CliError::new(
            Kind::Server,
            "server_revocation_failed",
            "서버에서 폐기하지 못했어요. 설정 › 연결 › 명령줄·AI 도구에서 지워 주세요.",
        );
        error.status = None;
        return Err(error);
    }
    Ok(())
}

/// A reply that is neither success nor "already ended" (a 403 because the workspace switched
/// developer access off, say): the token is not usable, so it is as good as ended.
fn return_partial(reply: &Reply) -> Result<&'static str, CliError> {
    if reply.status == 403 || reply.status == 404 {
        Ok("already_ended")
    } else {
        Ok("unreachable")
    }
}

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ChannelsDoc<'a> {
    schema: &'static str,
    channels: &'a [Channel],
}

fn fetch_channels(active: &mut Active, ctx: &Ctx) -> Result<Vec<Channel>, CliError> {
    let path = active.workspace_path("/channels");
    let reply = active.get(ctx, &path, &[("limit", CHANNEL_LIST_LIMIT.to_string())])?;
    Ok(parse_json::<ChannelsPage>(&reply)?.channels)
}

pub fn channels(ctx: &Ctx) -> Result<(), CliError> {
    let mut active = Active::resolve(ctx)?;
    let channels = fetch_channels(&mut active, ctx)?;
    if ctx.json {
        return emit(&ChannelsDoc {
            schema: "oort.cli.channels.v1",
            channels: &channels,
        });
    }
    if channels.is_empty() {
        println!("볼 수 있는 채널이 없어요.");
    }
    for channel in &channels {
        let name = match &channel.name {
            Some(name) => format!("#{}", sanitize(name)),
            None => "(DM)".to_string(),
        };
        let mark = if channel.archived_at_ms.is_some() {
            " [보관됨]"
        } else {
            ""
        };
        println!("{name}\t{}\t{}{mark}", channel.kind, channel.id);
    }
    Ok(())
}

/// `#이름` or an id → the channel id. A name needs the channel list; a token without it is told
/// to use the id instead of being refused with a bare 403.
fn resolve_channel(active: &mut Active, ctx: &Ctx, raw: &str) -> Result<String, CliError> {
    if let Ok(id) = Uuid::parse_str(raw.trim()) {
        return Ok(id.hyphenated().to_string());
    }
    let Some(name) = raw.trim().strip_prefix('#') else {
        return Err(CliError::usage(
            "invalid_channel",
            "채널은 `#이름` 또는 채널 id로 적어 주세요(쉘에서는 '#이름'처럼 따옴표로 감싸 주세요).",
        ));
    };
    if name.is_empty() {
        return Err(CliError::usage(
            "invalid_channel",
            "채널 이름이 비어 있어요.",
        ));
    }
    let channels = fetch_channels(active, ctx).map_err(|error| {
        if error.kind == Kind::Forbidden {
            CliError::new(
                Kind::Forbidden,
                &error.code,
                "채널 이름을 찾으려면 채널 목록 권한이 필요해요. 채널 id로 지정해 주세요.",
            )
        } else {
            error
        }
    })?;
    let mut matches = channels
        .iter()
        .filter(|channel| channel.archived_at_ms.is_none())
        .filter(|channel| channel.name.as_deref() == Some(name));
    let first = matches.next();
    match (first, matches.next()) {
        (Some(channel), None) => Ok(channel.id.clone()),
        (Some(_), Some(_)) => Err(CliError::usage(
            "ambiguous_channel",
            "같은 이름의 채널이 둘 이상이에요. 채널 id로 지정해 주세요.",
        )),
        (None, _) => Err(CliError::new(
            Kind::NotFound,
            "channel_not_found",
            format!("`#{}` 채널을 찾을 수 없어요.", sanitize(name)),
        )),
    }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDoc<'a> {
    schema: &'static str,
    channel_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_root_id: Option<&'a str>,
    /// Always oldest first.
    messages: &'a [Message],
    /// Pass as `--before` for the page of older messages (history reads only).
    #[serde(skip_serializing_if = "Option::is_none")]
    next_before: Option<i64>,
    /// Pass as `--since` for the next page of newer messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_since: Option<i64>,
}

fn parse_uuid_arg(value: &str, what: &str) -> Result<String, CliError> {
    Uuid::parse_str(value.trim())
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| CliError::usage("invalid_id", format!("{what}가 올바른 id가 아니에요.")))
}

pub fn read(ctx: &Ctx, args: &ReadArgs) -> Result<(), CliError> {
    if let Some(limit) = args.limit {
        if !(1..=200).contains(&limit) {
            return Err(CliError::usage(
                "invalid_limit",
                "--limit은 1에서 200 사이여야 해요.",
            ));
        }
    }
    if args.since.is_some() && args.before.is_some() {
        return Err(CliError::usage(
            "conflicting_cursors",
            "--since와 --before는 함께 쓸 수 없어요.",
        ));
    }
    if args.thread.is_some() && args.before.is_some() {
        return Err(CliError::usage(
            "conflicting_cursors",
            "스레드는 오래된 쪽에서 새 쪽으로만 읽을 수 있어요(--before는 쓸 수 없어요).",
        ));
    }
    let root = args
        .thread
        .as_deref()
        .map(|value| parse_uuid_arg(value, "스레드 루트"))
        .transpose()?;

    let mut active = Active::resolve(ctx)?;
    let channel_id = resolve_channel(&mut active, ctx, &args.channel)?;
    let mut query: Vec<(&str, String)> = Vec::new();
    if let Some(limit) = args.limit {
        query.push(("limit", limit.to_string()));
    }
    let (path, mut page) = match &root {
        Some(root) => {
            if let Some(since) = args.since {
                query.push(("cursor", since.to_string()));
            }
            let path =
                active.workspace_path(&format!("/channels/{channel_id}/messages/{root}/replies"));
            let reply = active.get(ctx, &path, &query)?;
            (path, parse_json::<MessagePage>(&reply)?)
        }
        None => {
            if let Some(since) = args.since {
                query.push(("after", since.to_string()));
            }
            if let Some(before) = args.before {
                query.push(("before", before.to_string()));
            }
            let path = active.workspace_path(&format!("/channels/{channel_id}/messages"));
            let reply = active.get(ctx, &path, &query)?;
            (path, parse_json::<MessagePage>(&reply)?)
        }
    };
    let _ = path;

    // The server pages the newest-first history in descending order and everything else
    // ascending; the output is always oldest first.
    let descending = root.is_none() && args.since.is_none();
    if descending {
        page.messages.reverse();
    }
    let next_before = descending.then_some(page.next_before).flatten();
    let next_since = match (&root, args.since) {
        (Some(_), _) => page.next_cursor,
        (None, Some(_)) => page.messages.last().map(|message| message.seq),
        (None, None) => None,
    };

    if ctx.json {
        return emit(&ReadDoc {
            schema: "oort.cli.read.v1",
            channel_id: &channel_id,
            thread_root_id: root.as_deref(),
            messages: &page.messages,
            next_before,
            next_since,
        });
    }
    if page.messages.is_empty() {
        println!("(메시지가 없어요)");
    }
    for message in &page.messages {
        print_message(message);
    }
    if let Some(before) = next_before {
        note(&format!("더 오래된 글: --before {before}"));
    }
    if let Some(since) = next_since {
        note(&format!("더 새로운 글: --since {since}"));
    }
    Ok(())
}

fn print_message(message: &Message) {
    let when = rfc3339(message.created_at_ms);
    let who = short_id(&message.author_member_id);
    let via = if message.sent_via.as_deref() == Some("dev") {
        " (명령줄에서)"
    } else {
        ""
    };
    let deleted = message.state.as_deref() == Some("deleted");
    let body = if deleted {
        "(삭제된 메시지)".to_string()
    } else {
        sanitize(message.body.as_deref().unwrap_or(""))
    };
    let mut lines = body.lines();
    println!(
        "[{}] {when} {who}{via}  {}",
        message.seq,
        lines.next().unwrap_or("")
    );
    for line in lines {
        println!("    {line}");
    }
}

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct PostDoc<'a> {
    schema: &'static str,
    message: &'a Message,
}

fn read_post_text(argument: &str) -> Result<String, CliError> {
    let text = if argument == "-" {
        let mut text = String::new();
        std::io::stdin()
            .lock()
            .take(MAX_POST_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| CliError::usage("invalid_text", "표준입력을 UTF-8 글로 읽지 못했어요."))?;
        if text.len() as u64 > MAX_POST_BYTES {
            return Err(CliError::usage(
                "text_too_large",
                "보낼 글이 너무 길어요(1 MiB 이하).",
            ));
        }
        text.trim_end_matches(['\n', '\r']).to_string()
    } else {
        argument.to_string()
    };
    if text.trim().is_empty() {
        return Err(CliError::usage("empty_text", "보낼 글이 비어 있어요."));
    }
    Ok(text)
}

pub fn post(ctx: &Ctx, args: &PostArgs) -> Result<(), CliError> {
    let text = read_post_text(&args.text)?;
    let client_msg_id = match args.client_msg_id.as_deref() {
        Some(given) => parse_uuid_arg(given, "--client-msg-id")?,
        None => Uuid::new_v4().to_string(),
    };
    let mut body = json!({ "clientMsgId": client_msg_id, "body": text });
    if let Some(root) = args.thread.as_deref() {
        body["rootId"] = Value::String(parse_uuid_arg(root, "스레드 루트")?);
    }
    if let Some(reply_to) = args.reply_to.as_deref() {
        body["replyToId"] = Value::String(parse_uuid_arg(reply_to, "--reply-to")?);
    }

    let mut active = Active::resolve(ctx)?;
    let channel_id = resolve_channel(&mut active, ctx, &args.channel)?;
    let path = active.workspace_path(&format!("/channels/{channel_id}/messages"));
    let message: Message = match active
        .post_json(ctx, &path, &body)
        .and_then(|reply| parse_json(&reply))
    {
        Ok(message) => message,
        Err(mut error) => {
            // A send that may or may not have landed is retried with the same id.
            if matches!(error.kind, Kind::Server | Kind::RateLimited) {
                error.message = format!(
                    "{} 같은 글을 다시 보내려면 `--client-msg-id {client_msg_id}`를 붙여 주세요(한 번만 반영돼요).",
                    error.message
                );
            }
            return Err(error);
        }
    };
    if ctx.json {
        return emit(&PostDoc {
            schema: "oort.cli.post.v1",
            message: &message,
        });
    }
    println!("보냈어요: [{}] {}", message.seq, message.id);
    Ok(())
}

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxDoc<'a> {
    schema: &'static str,
    unread_count: i64,
    items: &'a [InboxItem],
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<&'a str>,
}

pub fn inbox(ctx: &Ctx, args: &InboxArgs) -> Result<(), CliError> {
    if let Some(limit) = args.limit {
        if limit == 0 {
            return Err(CliError::usage(
                "invalid_limit",
                "--limit은 1 이상이어야 해요.",
            ));
        }
    }
    let mut active = Active::resolve(ctx)?;
    let path = active.workspace_path("/inbox");
    let query: Vec<(&str, String)> = args
        .limit
        .map(|limit| vec![("limit", limit.to_string())])
        .unwrap_or_default();
    let reply = active.get(ctx, &path, &query)?;
    let page: InboxPage = parse_json(&reply)?;
    if ctx.json {
        return emit(&InboxDoc {
            schema: "oort.cli.inbox.v1",
            unread_count: page.unread_count,
            items: &page.items,
            next_cursor: page.next_cursor.as_deref(),
        });
    }
    println!("읽지 않은 항목: {}", page.unread_count);
    for item in &page.items {
        let channel = match &item.channel.name {
            Some(name) => format!("#{}", sanitize(name)),
            None => "(DM)".to_string(),
        };
        let unread = if item.read_at.is_none() { "●" } else { " " };
        let first_line = sanitize(&item.message.preview);
        println!(
            "{unread} {channel} [{}] {}  {}",
            item.message.seq,
            short_id(&item.actor_member_id),
            first_line.lines().next().unwrap_or("")
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenDoc<'a> {
    schema: &'static str,
    token: &'a str,
    token_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    source: &'static str,
}

/// The one command that prints a secret — on purpose, to standard output, for a pipe or a header
/// helper. On a terminal it says so on standard error first.
pub fn token(ctx: &Ctx, args: &TokenArgs) -> Result<(), CliError> {
    let mut active = Active::resolve(ctx)?;
    let token = active.fresh_token(ctx)?;
    if std::io::stdout().is_terminal() {
        note(
            "주의: 토큰이 화면에 그대로 보여요. 파이프로 넘기거나 헤더 도우미로 쓰세요(--headers).",
        );
    }
    if args.headers {
        let headers = json!({ "Authorization": format!("Bearer {}", token.expose()) });
        return emit(&headers);
    }
    if ctx.json {
        let expires_at = active.stored_expiry_ms().map(rfc3339);
        return emit(&TokenDoc {
            schema: "oort.cli.token.v1",
            token: token.expose(),
            token_type: "Bearer",
            expires_at,
            source: active.source.label(),
        });
    }
    println!("{}", token.expose());
    Ok(())
}
