//! The HTTP side: which servers may be called, what a status means, and the response shapes.
//!
//! **What this client will not do** (ADR-0216 D10 「전송 규칙」):
//! * call a server that is not `https` — plain `http` only for a loopback address;
//! * follow a redirect (a redirect to another host would carry the credential there; the
//!   redirect policy is `none` and a 3xx is an error);
//! * skip certificate verification (there is no flag, and the TLS stack's defaults are untouched);
//! * call anything but the server the person named (no telemetry, no update check).

use std::net::IpAddr;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CliError, Kind};
use crate::output::sanitize;
use crate::secret::Secret;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The routes this CLI calls: ADR-0216 D4 L1–L8, the only REST a developer token reaches. The
/// templates are the router's own, character for character, so `tests/wire_constants.rs` can hold
/// them against `momo_auth::DEV_ROUTE_TABLE` and a route the server renames or closes fails there
/// instead of at a person's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// L1 `whoami`
    SelfInfo,
    /// L2 `logout`
    SelfEnd,
    /// L3 `channels`
    Channels,
    /// L4 `read`
    History,
    /// L5 `read --thread`
    Replies,
    /// L6 `post`
    Send,
    /// L7 `inbox`
    Inbox,
    /// L8 `mcp`
    Mcp,
}

impl Route {
    pub const ALL: [Route; 8] = [
        Route::SelfInfo,
        Route::SelfEnd,
        Route::Channels,
        Route::History,
        Route::Replies,
        Route::Send,
        Route::Inbox,
        Route::Mcp,
    ];

    pub fn method(self) -> &'static str {
        match self {
            Route::SelfEnd => "DELETE",
            Route::Send | Route::Mcp => "POST",
            _ => "GET",
        }
    }

    pub fn template(self) -> &'static str {
        match self {
            Route::SelfInfo | Route::SelfEnd => "/v1/workspaces/{ws}/dev-access/self",
            Route::Channels => "/v1/workspaces/{ws}/channels",
            Route::History | Route::Send => "/v1/workspaces/{ws}/channels/{ch}/messages",
            Route::Replies => "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies",
            Route::Inbox => "/v1/workspaces/{ws}/inbox",
            Route::Mcp => "/v1/mcp/me",
        }
    }

    /// The path with ids filled in. Every id that reaches here has been parsed as a UUID
    /// (hyphenated, lower case) first, so nothing can add a segment or a query to the path.
    pub fn fill(self, workspace: &str, channel: Option<&str>, root: Option<&str>) -> String {
        let mut path = self.template().replace("{ws}", workspace);
        if let Some(channel) = channel {
            path = path.replace("{ch}", channel);
        }
        if let Some(root) = root {
            path = path.replace("{root}", root);
        }
        path
    }
}

/// A server the CLI may talk to, reduced to its origin (`https://oort.example`, no trailing slash).
pub fn parse_server(raw: &str) -> Result<String, CliError> {
    let url = Url::parse(raw.trim()).map_err(|_| {
        CliError::usage(
            "invalid_server",
            "서버 주소가 올바르지 않아요. 예: https://oort.example",
        )
    })?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CliError::usage(
            "invalid_server",
            "서버 주소에 사용자 이름이나 비밀번호를 넣지 마세요.",
        ));
    }
    if !(url.path() == "" || url.path() == "/") || url.query().is_some() || url.fragment().is_some()
    {
        return Err(CliError::usage(
            "invalid_server",
            "서버 주소는 주소(origin)만 적어 주세요. 예: https://oort.example",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CliError::usage("invalid_server", "서버 주소에 호스트가 없어요."))?;
    match url.scheme() {
        "https" => {}
        "http" => {
            if !is_loopback_host(host) {
                return Err(CliError::usage(
                    "insecure_server",
                    "https가 아닌 서버에는 자격을 보내지 않아요(http는 이 컴퓨터의 루프백 주소만 돼요).",
                ));
            }
        }
        _ => {
            return Err(CliError::usage(
                "invalid_server",
                "서버 주소는 https://로 시작해야 해요.",
            ))
        }
    }
    Ok(url.origin().ascii_serialization())
}

/// `localhost`, or an IP literal that is a loopback address (after the URL parser has
/// normalised shorthand spellings such as `127.1`).
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn is_loopback_origin(origin: &str) -> bool {
    Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(is_loopback_host))
        .unwrap_or(false)
}

pub struct Api {
    client: Client,
    origin: String,
}

impl Api {
    pub fn new(origin: &str) -> Result<Api, CliError> {
        let mut builder = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(format!("oort-cli/{}", env!("CARGO_PKG_VERSION")));
        if is_loopback_origin(origin) {
            // A local server is never behind the environment's proxy.
            builder = builder.no_proxy();
        }
        let client = builder
            .build()
            .map_err(|_| CliError::failure("client", "HTTP 클라이언트를 만들지 못했어요."))?;
        Ok(Api {
            client,
            origin: origin.to_string(),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// `true` when `endpoint` is on this server's origin — the only place a credential or a code
    /// may be sent.
    pub fn same_origin(&self, endpoint: &str) -> bool {
        Url::parse(endpoint)
            .map(|url| url.origin().ascii_serialization() == self.origin)
            .unwrap_or(false)
    }
}

/// A transport failure, said without echoing anything that came from the wire.
pub fn network_error(error: &reqwest::Error) -> CliError {
    let reason = if error.is_timeout() {
        "응답이 너무 오래 걸려요"
    } else if error.is_connect() {
        "연결하지 못했어요"
    } else {
        "통신에 실패했어요"
    };
    CliError::new(
        Kind::Server,
        "network",
        format!("서버와 {reason}. 주소와 네트워크를 확인해 주세요."),
    )
}

/// What the server said, once, with the body read under a ceiling.
pub struct Reply {
    pub status: u16,
    pub retry_after_seconds: Option<u64>,
    pub body: Vec<u8>,
}

pub fn read_reply(response: Response) -> Result<Reply, CliError> {
    let status = response.status().as_u16();
    let retry_after_seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok());
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Err(CliError::new(
            Kind::Server,
            "response_too_large",
            "서버 응답이 너무 커요.",
        ));
    }
    let body = response.bytes().map_err(|error| network_error(&error))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(CliError::new(
            Kind::Server,
            "response_too_large",
            "서버 응답이 너무 커요.",
        ));
    }
    Ok(Reply {
        status,
        retry_after_seconds,
        body: body.to_vec(),
    })
}

/// The server's own refusal text: `{"error":{"message","code"?}}` (the app's envelope) or an OAuth
/// error (`{"error":"invalid_grant"}`).
fn refusal_text(body: &[u8]) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return (None, None);
    };
    match value.get("error") {
        Some(Value::Object(error)) => (
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string),
            error
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        Some(Value::String(code)) => (None, Some(code.clone())),
        _ => (None, None),
    }
}

fn shortened(text: &str) -> String {
    let clean = sanitize(text);
    if clean.chars().count() > 200 {
        let head: String = clean.chars().take(200).collect();
        format!("{head}…")
    } else {
        clean
    }
}

/// A reply that is not a success, as the error the exit code follows.
pub fn refusal(reply: &Reply) -> CliError {
    let (message, code) = refusal_text(&reply.body);
    let server_says = message.as_deref().map(shortened);
    let with_server = |base: &str| match &server_says {
        Some(text) if !text.is_empty() => format!("{base} (서버: {text})"),
        _ => base.to_string(),
    };
    let error = match reply.status {
        401 => CliError::new(
            Kind::LoginRequired,
            "login_required",
            "로그인이 필요하거나 토큰이 끝났어요. `oort login`으로 다시 로그인해 주세요.",
        ),
        // A developer token's refusals carry an `error.code` (`dev_scope_denied`, …). The one 403
        // with no code is the app's old answer for a channel the caller cannot reach — absent,
        // not a member, or outside the token's channel list, all the same bytes — so it is
        // "not found" (ADR-0216 R11 and the #4660 implementation memo).
        403 => match code.as_deref() {
            Some(code) => CliError::new(Kind::Forbidden, code, with_server("허용되지 않아요.")),
            None => CliError::new(
                Kind::NotFound,
                "not_found",
                with_server("찾을 수 없거나 볼 수 없어요."),
            ),
        },
        404 => CliError::new(
            Kind::NotFound,
            code.as_deref().unwrap_or("not_found"),
            with_server("찾을 수 없어요."),
        ),
        429 => CliError::new(
            Kind::RateLimited,
            code.as_deref().unwrap_or("rate_limited"),
            with_server("요청이 너무 많아요. 잠시 뒤에 다시 해 주세요."),
        ),
        300..=399 => CliError::new(
            Kind::Server,
            "unexpected_redirect",
            "서버가 다른 곳으로 보내려 해요. 따라가지 않아요. 서버 주소를 확인해 주세요.",
        ),
        500..=599 => CliError::new(
            Kind::Server,
            code.as_deref().unwrap_or("server_error"),
            with_server("서버에 문제가 있어요."),
        ),
        _ => CliError::new(
            Kind::Failure,
            code.as_deref().unwrap_or("request_failed"),
            with_server("요청을 처리하지 못했어요."),
        ),
    };
    let mut error = error.with_status(reply.status);
    error.retry_after_seconds = reply.retry_after_seconds;
    error
}

/// Parse a success body, or turn a refusal into its error.
pub fn parse_json<T: for<'de> Deserialize<'de>>(reply: &Reply) -> Result<T, CliError> {
    if !(200..300).contains(&reply.status) {
        return Err(refusal(reply));
    }
    serde_json::from_slice(&reply.body).map_err(|_| {
        CliError::new(Kind::Server, "bad_response", "서버 응답을 읽을 수 없어요.")
            .with_status(reply.status)
    })
}

// ---------------------------------------------------------------------------
// the shapes of the answers (and, serialised, of `--json`'s fields)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub workspace_id: String,
    pub member_id: String,
    pub scopes: Vec<String>,
    pub channel_restricted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage_expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at_ms: Option<i64>,
    #[serde(default)]
    pub muted: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChannelsPage {
    pub channels: Vec<Channel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
    pub seq: i64,
    pub author_member_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_msg_id: Option<String>,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_via: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<Message>,
    #[serde(default)]
    pub next_before: Option<i64>,
    #[serde(default)]
    pub next_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxChannel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub id: String,
    pub seq: i64,
    pub author_member_id: String,
    pub preview: String,
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub channel: InboxChannel,
    pub message: InboxMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    pub actor_member_id: String,
    pub created_at: String,
    #[serde(default)]
    pub read_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub unread_count: i64,
}

/// `POST /v1/oauth/token` (code exchange and refresh).
#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: Secret,
    #[serde(default)]
    pub refresh_token: Option<Secret>,
    pub expires_in: i64,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_a_loopback_http_server_is_accepted_and_it_is_reduced_to_its_origin() {
        assert_eq!(
            parse_server("https://oort.example").unwrap(),
            "https://oort.example"
        );
        assert_eq!(
            parse_server("https://oort.example/").unwrap(),
            "https://oort.example"
        );
        assert_eq!(
            parse_server("https://oort.example:8443").unwrap(),
            "https://oort.example:8443"
        );
        assert_eq!(
            parse_server("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            parse_server("http://localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            parse_server("http://[::1]:3000").unwrap(),
            "http://[::1]:3000"
        );
        for (raw, code) in [
            ("http://oort.example", "insecure_server"),
            ("http://10.0.0.5:8080", "insecure_server"),
            ("http://127.0.0.1.evil.example", "insecure_server"),
            ("ftp://oort.example", "invalid_server"),
            ("https://u:p@oort.example", "invalid_server"),
            ("https://oort.example/api", "invalid_server"),
            ("https://oort.example/?x=1", "invalid_server"),
            ("oort.example", "invalid_server"),
            ("", "invalid_server"),
        ] {
            let error = parse_server(raw).expect_err(raw);
            assert_eq!(error.code, code, "{raw}");
            assert_eq!(error.exit_code(), 2, "{raw}");
        }
    }

    fn reply(status: u16, body: &str) -> Reply {
        Reply {
            status,
            retry_after_seconds: None,
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_filled_route_has_no_placeholder_left_and_the_ids_are_only_where_the_template_says() {
        let ws = "6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
        let ch = "11111111-1111-4111-8111-111111111111";
        let root = "22222222-2222-4222-8222-222222222222";
        assert_eq!(
            Route::Replies.fill(ws, Some(ch), Some(root)),
            format!("/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies")
        );
        assert_eq!(Route::Mcp.fill(ws, None, None), "/v1/mcp/me");
        for route in Route::ALL {
            let path = route.fill(ws, Some(ch), Some(root));
            assert!(
                !path.contains('{') && !path.contains('}'),
                "{route:?}: {path}"
            );
        }
    }

    #[test]
    fn statuses_become_the_exit_codes_of_the_table() {
        let cases = [
            (401, r#"{"error":{"message":"invalid token"}}"#, 3),
            (
                403,
                r#"{"error":{"message":"x","code":"dev_scope_denied"}}"#,
                4,
            ),
            (
                403,
                r#"{"error":{"message":"not a member of this channel"}}"#,
                5,
            ),
            (404, "", 5),
            (429, "", 6),
            (500, "", 7),
            (502, "<html>", 7),
            (302, "", 7),
            (400, r#"{"error":{"message":"bad"}}"#, 1),
            (409, "", 1),
        ];
        for (status, body, exit) in cases {
            assert_eq!(
                refusal(&reply(status, body)).exit_code(),
                exit,
                "{status} {body}"
            );
        }
        let limited = refusal(&Reply {
            status: 429,
            retry_after_seconds: Some(17),
            body: Vec::new(),
        });
        assert_eq!(limited.retry_after_seconds, Some(17));
        assert_eq!(
            refusal(&reply(
                403,
                r#"{"error":{"message":"m","code":"dev_scope_denied"}}"#
            ))
            .code,
            "dev_scope_denied"
        );
    }

    #[test]
    fn a_server_message_is_quoted_without_control_characters() {
        let error = refusal(&reply(400, "{\"error\":{\"message\":\"bad\\u001b[31m\"}}"));
        assert!(!error.message.contains('\u{1b}'), "{}", error.message);
    }
}
