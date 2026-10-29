//! `oort login`: browser approval (OAuth authorization code + PKCE `S256` over a one-shot
//! loopback receiver), or a card token read from standard input.
//!
//! The receiver is the part of this CLI an outsider can reach, so it is narrow: it binds
//! `127.0.0.1` only, on one of the five fixed ports the server's built-in client registers; it
//! answers exactly one request to `/callback` with the right `Host`, then closes; its page never
//! repeats the code. `state` and `iss` are compared byte for byte and a mismatch ends the login
//! **before** anything is sent to the token endpoint.

use std::io::{BufRead, IsTerminal, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::api::{
    network_error, parse_json, parse_server, read_reply, Api, Route, SelfInfo, TokenResponse,
};
use crate::cli::LoginArgs;
use crate::error::{CliError, Kind};
use crate::output::{note, print_json, sanitize};
use crate::secret::{parse_envelope, EnvelopeKind, Secret};
use crate::session::{credential_from_response, Ctx, CLIENT_ID};
use crate::store::{persist, Credential, Current, StorageKind, StoragePref};

/// The fixed loopback ports the server's built-in `oort-cli` client registers (ADR-0216 D6).
/// Retyped here so this binary links no server crate; `tests/wire_constants.rs` ties these to
/// `momo_mcp::oauth` so the two cannot drift.
pub const LOOPBACK_PORTS: [u16; 5] = [24681, 24682, 24683, 24684, 24685];
pub const CALLBACK_PATH: &str = "/callback";
/// The protected resource of the human MCP, appended to the server's issuer.
pub const RESOURCE_PATH: &str = "/v1/mcp/me";
/// Asked for in full: the person narrows it on the consent screen (「읽기만」 is pre-selected).
pub const REQUESTED_SCOPES: [&str; 5] = [
    "dev:identity",
    "dev:channels:read",
    "dev:messages:read",
    "dev:messages:write",
    "dev:inbox:read",
];
const WELL_KNOWN: &str = "/.well-known/oauth-authorization-server";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_NAME_CHARS: usize = 80;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginDoc<'a> {
    schema: &'static str,
    server: &'a str,
    workspace_id: &'a str,
    scopes: &'a [String],
    storage: &'static str,
    method: &'static str,
}

struct Outcome {
    server: String,
    workspace_id: String,
    scopes: Vec<String>,
    storage: StorageKind,
    method: &'static str,
}

pub fn login(ctx: &Ctx, args: &LoginArgs) -> Result<(), CliError> {
    let outcome = if args.with_token {
        with_token(ctx, args)?
    } else {
        browser(ctx, args)?
    };
    if ctx.json {
        print_json(&LoginDoc {
            schema: "oort.cli.login.v1",
            server: &outcome.server,
            workspace_id: &outcome.workspace_id,
            scopes: &outcome.scopes,
            storage: outcome.storage.as_str(),
            method: outcome.method,
        })
        .map_err(|_| CliError::failure("stdout", "결과를 쓰지 못했어요."))?;
    } else {
        let place = match outcome.storage {
            StorageKind::Keychain => "키체인",
            StorageKind::File => "파일(권한 0600)",
        };
        crate::outln!("로그인했어요.");
        crate::outln!("서버: {}", outcome.server);
        crate::outln!("워크스페이스: {}", outcome.workspace_id);
        crate::outln!("범위: {}", outcome.scopes.join(", "));
        crate::outln!("저장 위치: {place}");
    }
    Ok(())
}

fn server_required() -> CliError {
    CliError::usage(
        "server_required",
        "서버 주소가 필요해요(`--server https://…` 또는 환경 변수 OORT_SERVER).",
    )
}

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

/// Save the login and make it the current profile — under the store lock, so a refresh in another
/// process cannot interleave.
fn save(
    ctx: &Ctx,
    preference: StoragePref,
    credential: &Credential,
) -> Result<StorageKind, CliError> {
    let store = ctx.store()?;
    let _lock = store.lock()?;
    let previous = store.current().ok().flatten();
    let keychain = crate::store::keychain_backend();
    let storage = persist(
        preference,
        cfg!(target_os = "macos"),
        &*keychain,
        &store.file_backend(),
        credential,
        &mut |message| note(message),
    )?;
    // A login that moved from one place to the other must not leave the old copy behind.
    if let Some(previous) = previous {
        if previous.key() == credential.key() && previous.storage != storage {
            if let Ok(backend) = store.backend(previous.storage) {
                let _ = backend.delete(&previous.key());
            }
        }
    }
    store.set_current(&Current {
        server: credential.server.clone(),
        workspace_id: credential.workspace_id.clone(),
        storage,
    })?;
    Ok(storage)
}

// ---------------------------------------------------------------------------
// --with-token
// ---------------------------------------------------------------------------

fn read_token_line() -> Result<String, CliError> {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        note("설정 › 연결 › 명령줄·AI 도구에서 만든 카드 토큰을 붙여넣고 Enter를 눌러 주세요(화면에 보일 수 있어요):");
    }
    let mut line = String::new();
    stdin
        .lock()
        .take(4096)
        .read_line(&mut line)
        .map_err(|_| CliError::usage("token_stdin", "표준입력을 읽지 못했어요."))?;
    let token = line.trim().to_string();
    if token.is_empty() {
        return Err(CliError::usage(
            "token_stdin",
            "표준입력에서 토큰 한 줄을 읽지 못했어요. 예: `pbpaste | oort login --with-token --server https://…`",
        ));
    }
    Ok(token)
}

fn with_token(ctx: &Ctx, args: &LoginArgs) -> Result<Outcome, CliError> {
    let origin = parse_server(ctx.requested_server().ok_or_else(server_required)?)?;
    let line = read_token_line()?;
    let envelope = parse_envelope(&line)
        .filter(|envelope| envelope.kind == EnvelopeKind::Access)
        .ok_or_else(|| {
            CliError::usage(
                "invalid_token",
                "올바른 oort 카드 토큰(momo_dev_v1…)이 아니에요.",
            )
        })?;
    let workspace_id = envelope.workspace_id.to_string();
    let token = Secret::new(line);
    let api = Api::new(&origin)?;
    // Prove the token before keeping it: a typo or a revoked card is told now, not at first use.
    let response = api
        .client()
        .get(api.url(&Route::SelfInfo.fill(&workspace_id, None, None)))
        .bearer_auth(token.expose())
        .send()
        .map_err(|error| network_error(&error))?;
    let info: SelfInfo = parse_json(&read_reply(response)?)?;
    if info.workspace_id != workspace_id {
        return Err(CliError::new(
            Kind::Server,
            "bad_response",
            "서버가 다른 워크스페이스의 토큰이라고 답했어요.",
        ));
    }
    if info.kind != "card" {
        return Err(CliError::usage(
            "invalid_token",
            "이건 로그인 세션 토큰이에요. 설정에서 만든 카드 토큰을 넣어 주세요.",
        ));
    }
    let storage = save(
        ctx,
        args.storage.into(),
        &Credential::card(&origin, &workspace_id, token),
    )?;
    Ok(Outcome {
        server: origin,
        workspace_id,
        scopes: info.scopes,
        storage,
        method: "token",
    })
}

// ---------------------------------------------------------------------------
// browser approval
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Metadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    revocation_endpoint: Option<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

/// The server's OAuth metadata — accepted only if every address in it is the server the person
/// named. A document that points the authorization code (and the verifier that redeems it) at
/// another origin is refused, not followed.
fn discover(api: &Api) -> Result<Metadata, CliError> {
    let response = api
        .client()
        .get(api.url(WELL_KNOWN))
        .send()
        .map_err(|error| network_error(&error))?;
    let reply = read_reply(response)?;
    if reply.status == 404 {
        return Err(CliError::failure(
            "browser_login_unavailable",
            "이 서버는 브라우저 로그인을 아직 열지 않았어요. 설정 › 연결 › 명령줄·AI 도구에서 토큰을 만들어 `oort login --with-token`으로 넣어 주세요.",
        ));
    }
    let metadata: Metadata = parse_json(&reply)?;
    let on_server = |endpoint: &str| api.same_origin(endpoint);
    let consistent = metadata.issuer.trim_end_matches('/') == api.origin()
        && on_server(&metadata.authorization_endpoint)
        && on_server(&metadata.token_endpoint)
        && metadata
            .revocation_endpoint
            .as_deref()
            .is_none_or(on_server);
    if !consistent {
        return Err(CliError::failure(
            "metadata_origin",
            "서버의 로그인 정보가 다른 주소를 가리켜요. 자격을 보내지 않고 멈췄어요.",
        ));
    }
    if !metadata.code_challenge_methods_supported.is_empty()
        && !metadata
            .code_challenge_methods_supported
            .iter()
            .any(|method| method == "S256")
    {
        return Err(CliError::failure(
            "pkce_unsupported",
            "서버가 PKCE S256을 지원한다고 말하지 않아서 멈췄어요.",
        ));
    }
    Ok(metadata)
}

fn random_b64url(bytes: usize) -> Result<String, CliError> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::getrandom(&mut buffer)
        .map_err(|_| CliError::failure("random", "안전한 난수를 얻지 못했어요."))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// RFC 7636 §4.2: `BASE64URL(SHA256(verifier))`.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn default_device_name() -> String {
    let system = match std::env::consts::OS {
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    format!("oort CLI · {system}")
}

fn device_name(args: &LoginArgs) -> Result<String, CliError> {
    match args.name.as_deref().map(str::trim) {
        None => Ok(default_device_name()),
        Some(name)
            if !name.is_empty()
                && name.chars().count() <= MAX_NAME_CHARS
                && !name.chars().any(char::is_control) =>
        {
            Ok(name.to_string())
        }
        Some(_) => Err(CliError::usage(
            "invalid_name",
            "기기 이름은 80자 이하의 한 줄이어야 해요.",
        )),
    }
}

pub fn authorize_url(
    metadata_authorization_endpoint: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    resource: &str,
    device_name: &str,
) -> Result<String, CliError> {
    let mut url = Url::parse(metadata_authorization_endpoint)
        .map_err(|_| CliError::failure("metadata_origin", "서버의 승인 주소가 올바르지 않아요."))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &REQUESTED_SCOPES.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", resource)
        .append_pair("device_name", device_name);
    Ok(url.to_string())
}

/// The first free loopback candidate, bound to `127.0.0.1` and nothing else.
pub fn bind_receiver() -> Result<(TcpListener, u16), CliError> {
    for port in LOOPBACK_PORTS {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            Ok(listener) => return Ok((listener, port)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(_) => {
                return Err(CliError::failure(
                    "login_port",
                    "로그인을 받을 로컬 포트를 열지 못했어요.",
                ))
            }
        }
    }
    Err(CliError::failure(
        "login_port_busy",
        "로그인에 쓰는 로컬 포트(24681~24685)가 모두 사용 중이에요. 다른 `oort login`이 끝난 뒤에 다시 해 주세요.",
    ))
}

fn open_browser(url: &str) -> bool {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(program)
        .arg(url)
        // The browser is somebody else's process: a card token a deployment left in this
        // process's environment is not handed to it.
        .env_remove("OORT_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// What came back on the loopback.
#[derive(Debug, Default)]
pub struct Callback {
    pub code: Option<Secret>,
    pub state: Option<String>,
    pub iss: Option<String>,
    pub error: Option<String>,
    /// A parameter that must appear once appeared twice.
    pub ambiguous: bool,
}

/// The browser's connection, kept open until the exchange is settled so the page it shows is true.
pub struct Pending {
    stream: TcpStream,
}

impl Pending {
    pub fn finish(mut self, succeeded: bool) {
        let body = if succeeded {
            "<!doctype html><meta charset=\"utf-8\"><title>oort</title><p>oort CLI로 돌아가 주세요. 이 창은 닫아도 돼요.</p>"
        } else {
            "<!doctype html><meta charset=\"utf-8\"><title>oort</title><p>승인을 마치지 못했어요. 터미널의 안내를 확인해 주세요.</p>"
        };
        respond(&mut self.stream, 200, "OK", body);
    }
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// One connection: a callback if it is a well-formed `GET /callback` for this port, otherwise a
/// refusal that does not count (a favicon probe or a stray scanner must not end the login).
fn handle_connection(mut stream: TcpStream, port: u16) -> Option<(Callback, Pending)> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.len() > MAX_REQUEST_BYTES {
                    respond(&mut stream, 431, "Request Header Fields Too Large", "");
                    return None;
                }
                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    let text = String::from_utf8(buffer).ok()?;
    let head = text.split("\r\n\r\n").next()?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let (method, target) = (parts.next()?, parts.next()?);
    let host = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("host")
            .then(|| value.trim().to_string())
    });
    // A page on another origin that was talked into pointing at 127.0.0.1 (DNS rebinding) sends
    // its own `Host`; only ours is answered.
    if host.as_deref() != Some(format!("127.0.0.1:{port}").as_str()) {
        respond(&mut stream, 400, "Bad Request", "");
        return None;
    }
    if method != "GET" {
        respond(&mut stream, 405, "Method Not Allowed", "");
        return None;
    }
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(&mut stream, 400, "Bad Request", "");
        return None;
    };
    if url.path() != CALLBACK_PATH || !target.starts_with('/') {
        respond(&mut stream, 404, "Not Found", "");
        return None;
    }
    let mut callback = Callback::default();
    let mut set_once = |slot: &mut Option<String>, value: String| {
        if slot.is_some() {
            callback.ambiguous = true;
        } else {
            *slot = Some(value);
        }
    };
    let (mut code, mut state, mut iss, mut error) = (None, None, None, None);
    for (key, value) in url.query_pairs() {
        let value = value.into_owned();
        match key.as_ref() {
            "code" => set_once(&mut code, value),
            "state" => set_once(&mut state, value),
            "iss" => set_once(&mut iss, value),
            "error" => set_once(&mut error, value),
            _ => {}
        }
    }
    callback.code = code.map(Secret::new);
    callback.state = state;
    callback.iss = iss;
    callback.error = error;
    Some((callback, Pending { stream }))
}

/// Wait for the one callback, then close the receiver (it is dropped on return).
pub fn wait_for_callback(
    listener: TcpListener,
    port: u16,
    timeout: Duration,
) -> Result<(Callback, Pending), CliError> {
    listener
        .set_nonblocking(true)
        .map_err(|_| CliError::failure("login_port", "로그인 수신기를 준비하지 못했어요."))?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(found) = handle_connection(stream, port) {
                    return Ok(found);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(CliError::failure(
                        "login_timeout",
                        "승인을 기다리다 시간이 지났어요. 다시 `oort login`을 해 주세요.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(_) => {
                return Err(CliError::failure(
                    "login_port",
                    "로그인 수신기에 문제가 생겼어요.",
                ))
            }
        }
    }
}

/// What the callback says, judged before any request leaves for the token endpoint.
fn accepted_code(
    callback: &Callback,
    expected_state: &str,
    issuer: &str,
) -> Result<Secret, CliError> {
    if callback.ambiguous {
        return Err(CliError::failure(
            "callback_malformed",
            "승인 응답이 올바르지 않아서 멈췄어요.",
        ));
    }
    let state_ok = callback
        .state
        .as_deref()
        .is_some_and(|state| constant_time_eq(state, expected_state));
    if !state_ok {
        return Err(CliError::failure(
            "state_mismatch",
            "승인 응답의 state가 달라서 멈췄어요(다른 곳에서 온 응답일 수 있어요). 아무것도 저장하지 않았어요.",
        ));
    }
    let issuer_ok = callback
        .iss
        .as_deref()
        .is_some_and(|iss| constant_time_eq(iss, issuer));
    if !issuer_ok {
        return Err(CliError::failure(
            "iss_mismatch",
            "승인 응답이 이 서버에서 온 것이 아니라서 멈췄어요. 아무것도 저장하지 않았어요.",
        ));
    }
    if let Some(error) = &callback.error {
        return Err(if error == "access_denied" {
            CliError::failure("consent_denied", "승인을 거절했어요. 로그인하지 않았어요.")
        } else {
            CliError::failure(
                "authorization_failed",
                format!("승인에 실패했어요({}).", sanitize(error)),
            )
        });
    }
    callback
        .code
        .clone()
        .ok_or_else(|| CliError::failure("callback_malformed", "승인 응답에 코드가 없어요."))
}

fn browser(ctx: &Ctx, args: &LoginArgs) -> Result<Outcome, CliError> {
    let origin = parse_server(ctx.requested_server().ok_or_else(server_required)?)?;
    let name = device_name(args)?;
    let api = Api::new(&origin)?;
    let metadata = discover(&api)?;

    let verifier = random_b64url(32)?;
    let challenge = pkce_challenge(&verifier);
    let state = random_b64url(32)?;
    let (listener, port) = bind_receiver()?;
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let resource = format!("{}{RESOURCE_PATH}", metadata.issuer);
    let url = authorize_url(
        &metadata.authorization_endpoint,
        &redirect_uri,
        &state,
        &challenge,
        &resource,
        &name,
    )?;

    let opened = !args.no_browser && open_browser(&url);
    if opened {
        note("브라우저에서 승인해 주세요. 열리지 않으면 아래 주소를 이 컴퓨터의 브라우저에서 열어 주세요:");
    } else {
        note("아래 주소를 이 컴퓨터의 브라우저에서 열어 승인해 주세요(SSH 같은 원격 터미널용이 아니에요):");
    }
    note(&url);

    let (callback, pending) = wait_for_callback(listener, port, CALLBACK_TIMEOUT)?;
    let code = match accepted_code(&callback, &state, &metadata.issuer) {
        Ok(code) => code,
        Err(error) => {
            pending.finish(false);
            return Err(error);
        }
    };

    let outcome = exchange_and_save(
        ctx,
        args,
        &api,
        &metadata,
        &code,
        &verifier,
        &redirect_uri,
        &resource,
        &origin,
    );
    pending.finish(outcome.is_ok());
    outcome
}

#[allow(clippy::too_many_arguments)]
fn exchange_and_save(
    ctx: &Ctx,
    args: &LoginArgs,
    api: &Api,
    metadata: &Metadata,
    code: &Secret,
    verifier: &str,
    redirect_uri: &str,
    resource: &str,
    origin: &str,
) -> Result<Outcome, CliError> {
    let response = api
        .client()
        .post(&metadata.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.expose()),
            ("redirect_uri", redirect_uri),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
            ("resource", resource),
        ])
        .send()
        .map_err(|error| network_error(&error))?;
    let reply = read_reply(response)?;
    if reply.status == 400 || reply.status == 401 {
        return Err(CliError::failure(
            "exchange_refused",
            "서버가 승인 코드를 받아 주지 않았어요(60초가 지났거나 이미 쓴 코드예요). 다시 `oort login`을 해 주세요.",
        )
        .with_status(reply.status));
    }
    let token: TokenResponse = parse_json(&reply)?;
    let scopes: Vec<String> = token
        .scope
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let credential = credential_from_response(origin, &metadata.token_endpoint, token, None)?;
    match save(ctx, args.storage.into(), &credential) {
        Ok(storage) => Ok(Outcome {
            server: origin.to_string(),
            workspace_id: credential.workspace_id.clone(),
            scopes,
            storage,
            method: "browser",
        }),
        Err(error) => {
            // The server already opened a session we could not keep: end it rather than leave a
            // 90-day session that no terminal holds.
            if let Some(endpoint) = metadata.revocation_endpoint.as_deref() {
                let _ = api
                    .client()
                    .post(endpoint)
                    .form(&[
                        ("token", credential.access.expose()),
                        ("client_id", CLIENT_ID),
                    ])
                    .send();
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_rfc_7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_verifier_and_a_state_are_43_unreserved_characters_and_never_repeat() {
        let first = random_b64url(32).expect("random");
        let second = random_b64url(32).expect("random");
        assert_eq!(first.len(), 43);
        assert!(first
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(first, second);
    }

    #[test]
    fn the_receiver_binds_127_0_0_1_and_one_of_the_registered_ports() {
        let (listener, port) = bind_receiver().expect("a free candidate port");
        let address = listener.local_addr().expect("address");
        assert_eq!(
            address.ip(),
            std::net::IpAddr::V4(Ipv4Addr::LOCALHOST),
            "loopback only"
        );
        assert!(LOOPBACK_PORTS.contains(&port));
        assert_eq!(address.port(), port);
    }

    /// One raw request to the receiver and everything it answered (the receiver closes the
    /// connection after answering, so reading to the end terminates). Write and read errors end
    /// the exchange rather than panic: a receiver that answers an oversized request and closes
    /// while the client is still sending is allowed to reset the connection.
    fn raw_exchange(port: u16, request: &[u8]) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let _ = stream.write_all(request);
        let mut answer = Vec::new();
        let _ = stream.read_to_end(&mut answer);
        String::from_utf8_lossy(&answer).into_owned()
    }

    fn status_line(answer: &str) -> &str {
        answer.lines().next().unwrap_or("")
    }

    #[test]
    fn the_receiver_counts_one_callback_of_its_own_host_and_path_and_then_closes() {
        let (listener, port) = bind_receiver().expect("a free candidate port");
        let waiter =
            std::thread::spawn(move || wait_for_callback(listener, port, Duration::from_secs(30)));
        let host = format!("127.0.0.1:{port}");
        let callback_path = "/callback?code=CODE&state=S&iss=I";

        // None of these is a callback, and none of them ends the wait: a page on another origin
        // that was pointed at this port (DNS rebinding sends its own Host), a browser's favicon
        // probe, a POST, a header that never ends.
        for (label, request, wanted) in [
            (
                "another origin's Host",
                format!("GET {callback_path} HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
                " 400 ",
            ),
            (
                "no Host at all",
                format!("GET {callback_path} HTTP/1.1\r\n\r\n"),
                " 400 ",
            ),
            (
                "another path",
                format!("GET /favicon.ico HTTP/1.1\r\nHost: {host}\r\n\r\n"),
                " 404 ",
            ),
            (
                "the path with a longer name",
                format!("GET /callback/x?code=C&state=S&iss=I HTTP/1.1\r\nHost: {host}\r\n\r\n"),
                " 404 ",
            ),
            (
                "another method",
                format!("POST /callback HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"),
                " 405 ",
            ),
            (
                "an oversized head",
                format!(
                    "GET /callback?{} HTTP/1.1\r\nHost: {host}\r\n",
                    "a".repeat(9000)
                ),
                " 431 ",
            ),
        ] {
            let answer = raw_exchange(port, request.as_bytes());
            // An oversized head is refused as soon as the bound is crossed, which can reset the
            // connection under the client's still-unsent bytes: what is required of it is that it
            // is not counted and that nothing but a 431 ever comes back.
            let reset_is_fine = wanted == " 431 " && answer.is_empty();
            assert!(
                reset_is_fine || status_line(&answer).contains(wanted),
                "{label}: {answer:?}"
            );
            assert!(
                !answer.contains("CODE"),
                "{label}: the answer repeats the code"
            );
            assert!(
                !waiter.is_finished(),
                "{label} must not count as the callback"
            );
        }

        // the one callback: held open (the page is written once the exchange is settled)
        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        browser
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        browser
            .write_all(format!("GET {callback_path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes())
            .expect("write");
        let (callback, pending) = waiter.join().expect("join").expect("a callback");
        assert_eq!(callback.code.as_ref().map(Secret::expose), Some("CODE"));
        assert_eq!(callback.state.as_deref(), Some("S"));
        assert_eq!(callback.iss.as_deref(), Some("I"));
        assert!(!callback.ambiguous && callback.error.is_none());

        // and the receiver is closed from then on: nothing is listening on the port any more
        assert!(
            TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err(),
            "the receiver must close after its one callback"
        );

        // the page that finally answers the browser holds no code and forbids caching and referrers
        pending.finish(true);
        let mut page = Vec::new();
        let _ = browser.read_to_end(&mut page);
        let page = String::from_utf8_lossy(&page).into_owned();
        assert!(status_line(&page).contains(" 200 "), "{page:?}");
        for header in ["Cache-Control: no-store", "Referrer-Policy: no-referrer"] {
            assert!(page.contains(header), "{header} missing: {page:?}");
        }
        assert!(
            !page.contains("CODE") && !page.contains("code="),
            "{page:?}"
        );
    }

    #[test]
    fn a_parameter_that_must_appear_once_and_appears_twice_is_flagged() {
        let (listener, port) = bind_receiver().expect("a free candidate port");
        let waiter =
            std::thread::spawn(move || wait_for_callback(listener, port, Duration::from_secs(30)));
        let mut browser = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        browser
            .write_all(
                format!(
                    "GET /callback?code=A&code=B&state=S&iss=I HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .expect("write");
        let (callback, pending) = waiter.join().expect("join").expect("a callback");
        assert!(callback.ambiguous, "two `code` values must not pick one");
        assert!(accepted_code(&callback, "S", "I").is_err());
        pending.finish(false);
    }

    fn callback(state: Option<&str>, iss: Option<&str>) -> Callback {
        Callback {
            code: Some(Secret::new("the-code")),
            state: state.map(str::to_string),
            iss: iss.map(str::to_string),
            error: None,
            ambiguous: false,
        }
    }

    #[test]
    fn a_callback_is_accepted_only_with_the_same_state_and_issuer_and_a_code() {
        let issuer = "https://oort.example";
        assert!(accepted_code(&callback(Some("s"), Some(issuer)), "s", issuer).is_ok());
        for (state, iss, wanted) in [
            (None, Some(issuer), "state_mismatch"),
            (Some("other"), Some(issuer), "state_mismatch"),
            (Some("s"), None, "iss_mismatch"),
            (Some("s"), Some("https://evil.example"), "iss_mismatch"),
            (Some("s"), Some("https://oort.example/"), "iss_mismatch"),
        ] {
            let error = accepted_code(&callback(state, iss), "s", issuer).expect_err(wanted);
            assert_eq!(error.code, wanted);
        }
        let mut denied = callback(Some("s"), Some(issuer));
        denied.error = Some("access_denied".into());
        assert_eq!(
            accepted_code(&denied, "s", issuer)
                .expect_err("denied")
                .code,
            "consent_denied"
        );
        let mut ambiguous = callback(Some("s"), Some(issuer));
        ambiguous.ambiguous = true;
        assert!(accepted_code(&ambiguous, "s", issuer).is_err());
    }

    #[test]
    fn the_authorize_url_asks_for_what_the_server_registered_and_nothing_secret() {
        let url = authorize_url(
            "https://oort.example/v1/oauth/authorize",
            "http://127.0.0.1:24681/callback",
            "STATE",
            "CHALLENGE",
            "https://oort.example/v1/mcp/me",
            "oort CLI · macOS",
        )
        .expect("url");
        let parsed = Url::parse(&url).expect("parse");
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], "oort-cli");
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:24681/callback");
        assert_eq!(pairs["resource"], "https://oort.example/v1/mcp/me");
        assert_eq!(pairs["scope"], REQUESTED_SCOPES.join(" "));
        assert!(!pairs.contains_key("code_verifier"));
    }
}
