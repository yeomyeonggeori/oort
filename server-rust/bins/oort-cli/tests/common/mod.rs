//! Shared fixtures of the `oort` binary's process tests: a tiny HTTP server that records what it
//! was asked, a private HOME/XDG per test, and the token envelopes the server's grammar allows.
//!
//! Nothing here touches the user's real configuration or keychain: every spawned `oort` gets a
//! cleared environment with only the paths of its own temporary directory, and tests always
//! store with `--storage file`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use oort_cli::store::{Backend, Credential, Current, Form, StorageKind, Store};
use serde_json::{json, Value};

pub const WS: &str = "6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
pub const MEMBER: &str = "22222222-2222-4222-8222-222222222222";
pub const OTHER_MEMBER: &str = "55555555-5555-4555-8555-555555555555";
pub const CRED_ID: &str = "11111111-1111-4111-8111-111111111111";
pub const CHANNEL: &str = "33333333-3333-4333-8333-333333333333";
pub const ROOT: &str = "44444444-4444-4444-8444-444444444444";

/// 43 characters from the envelope alphabet, distinctive enough to grep for.
pub const CARD_SECRET: &str = "CARDsecretCARDsecretCARDsecretCARDsecret123";
pub const OTHER_CARD_SECRET: &str = "OTHERcardOTHERcardOTHERcardOTHERcard1234567";
pub const NEW_ACCESS_SECRET: &str = "NEWaccessNEWaccessNEWaccessNEWaccess1234567";
pub const OLD_ACCESS_SECRET: &str = "OLDaccessOLDaccessOLDaccessOLDaccess1234567";
pub const OLD_REFRESH_SECRET: &str = "OLDrefreshOLDrefreshOLDrefreshOLDrefresh123";
pub const NEW_REFRESH_SECRET: &str = "NEWrefreshNEWrefreshNEWrefreshNEWrefresh123";

pub fn access(secret: &str) -> String {
    assert_eq!(secret.len(), 43, "an envelope secret is 43 characters");
    format!("momo_dev_v1.{WS}.{secret}")
}

pub fn refresh(secret: &str) -> String {
    assert_eq!(secret.len(), 43, "an envelope secret is 43 characters");
    format!("momo_devr_v1.{WS}.{secret}")
}

pub fn card() -> String {
    access(CARD_SECRET)
}

/// Every substring of a token a leak could take the shape of: the whole envelope, its secret
/// part, and a 16-character slice of the secret.
pub fn leak_needles(token: &str) -> Vec<String> {
    let secret = token.rsplit('.').next().expect("a secret part").to_string();
    vec![token.to_string(), secret.clone(), secret[..16].to_string()]
}

pub fn assert_no_leak(label: &str, text: &str, needles: &[String]) {
    for needle in needles {
        assert!(
            !text.contains(needle.as_str()),
            "{label} contains a secret ({} characters): {text}",
            needle.len()
        );
    }
}

// ---------------------------------------------------------------------------
// a recording HTTP server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// `application/x-www-form-urlencoded` body as a map.
    pub fn form(&self) -> HashMap<String, String> {
        decode_pairs(&String::from_utf8_lossy(&self.body))
    }

    pub fn query_map(&self) -> HashMap<String, String> {
        decode_pairs(&self.query)
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    index += 2;
                } else {
                    out.push(b'%');
                }
            }
            other => out.push(other),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_pairs(text: &str) -> HashMap<String, String> {
    text.split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

pub struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    delay: Duration,
}

impl Response {
    pub fn json(status: u16, value: &Value) -> Response {
        Response {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(value).expect("json"),
            delay: Duration::ZERO,
        }
    }

    pub fn empty(status: u16) -> Response {
        Response {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn redirect(location: &str) -> Response {
        Response::empty(302).header("Location", location)
    }

    pub fn header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn delayed(mut self, delay: Duration) -> Response {
        self.delay = delay;
        self
    }
}

pub struct Mock {
    pub port: u16,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Mock {
    pub fn start<F>(handler: F) -> Mock
    where
        F: Fn(&Request) -> Response + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a mock server");
        let port = listener.local_addr().expect("address").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler = Arc::new(handler);
        let handle = thread::spawn({
            let requests = requests.clone();
            let stop = stop.clone();
            move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    let handler = handler.clone();
                    let requests = requests.clone();
                    thread::spawn(move || serve(stream, &*handler, &requests));
                }
            }
        });
        Mock {
            port,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().expect("requests").clone()
    }

    pub fn count(&self) -> usize {
        self.requests().len()
    }

    pub fn count_of(&self, method: &str, path: &str) -> usize {
        self.requests()
            .iter()
            .filter(|request| request.method == method && request.path == path)
            .count()
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve(
    mut stream: TcpStream,
    handler: &(dyn Fn(&Request) -> Response + Send + Sync),
    log: &Mutex<Vec<Request>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < length {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.clone(), String::new()),
    };
    let request = Request {
        method,
        path,
        query,
        headers,
        body,
    };
    log.lock().expect("log").push(request.clone());
    let response = handler(&request);
    if !response.delay.is_zero() {
        thread::sleep(response.delay);
    }
    let reason = match response.status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Status",
    };
    let mut out = format!("HTTP/1.1 {} {reason}\r\n", response.status);
    for (name, value) in &response.headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        response.body.len()
    ));
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

// ---------------------------------------------------------------------------
// a private HOME and the binary
// ---------------------------------------------------------------------------

pub struct Home {
    pub dir: tempfile::TempDir,
}

impl Home {
    pub fn new() -> Home {
        Home {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    pub fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    pub fn xdg(&self) -> PathBuf {
        self.dir.path().join("xdg")
    }

    pub fn oort_dir(&self) -> PathBuf {
        self.xdg().join("oort")
    }

    /// `oort` with a cleared environment: only the paths of this directory.
    pub fn command(&self) -> Command {
        std::fs::create_dir_all(self.home()).expect("home");
        let mut command = Command::new(env!("CARGO_BIN_EXE_oort"));
        command
            .env_clear()
            .env("HOME", self.home())
            .env("XDG_CONFIG_HOME", self.xdg())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    pub fn run(&self, args: &[&str]) -> Output {
        self.command().args(args).output().expect("run oort")
    }

    pub fn run_with_stdin(&self, args: &[&str], stdin: &str) -> Output {
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .spawn()
            .expect("spawn oort");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(stdin.as_bytes())
            .expect("write stdin");
        child.wait_with_output().expect("wait")
    }

    pub fn spawn(&self, args: &[&str]) -> Child {
        self.command().args(args).spawn().expect("spawn oort")
    }

    /// A card profile in the file store, the way `oort login --with-token --storage file` leaves it.
    pub fn seed_card(&self, server: &str, token: &str) {
        let store = Store::locate(Some(&self.xdg()), None).expect("store");
        let credential = Credential::card(server, WS, oort_cli::secret::Secret::new(token));
        store
            .file_backend()
            .save(&credential.key(), &credential)
            .expect("save card");
        store
            .set_current(&Current {
                server: server.to_string(),
                workspace_id: WS.to_string(),
                storage: StorageKind::File,
            })
            .expect("current");
    }

    /// A login session in the file store.
    pub fn seed_session(
        &self,
        server: &str,
        access_token: &str,
        refresh_token: &str,
        access_expires_at_ms: i64,
        token_endpoint: &str,
    ) {
        let store = Store::locate(Some(&self.xdg()), None).expect("store");
        let mut credential =
            Credential::card(server, WS, oort_cli::secret::Secret::new(access_token));
        credential.form = Form::Session;
        credential.refresh = Some(oort_cli::secret::Secret::new(refresh_token));
        credential.access_expires_at_ms = Some(access_expires_at_ms);
        credential.token_endpoint = Some(token_endpoint.to_string());
        store
            .file_backend()
            .save(&credential.key(), &credential)
            .expect("save session");
        store
            .set_current(&Current {
                server: server.to_string(),
                workspace_id: WS.to_string(),
                storage: StorageKind::File,
            })
            .expect("current");
    }
}

pub fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

pub fn code(output: &Output) -> i32 {
    output.status.code().unwrap_or(-1)
}

pub fn json_of(text: &str) -> Value {
    serde_json::from_str(text.trim())
        .unwrap_or_else(|error| panic!("not one JSON document ({error}): {text:?}"))
}

pub fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
        .permissions()
        .mode()
        & 0o777
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// a developer-token API that answers like the server's closed routes
// ---------------------------------------------------------------------------

pub fn self_info(kind: &str) -> Value {
    json!({
        "id": CRED_ID,
        "kind": kind,
        "name": "노트북 Claude Code",
        "tool": "claude_code",
        "workspaceId": WS,
        "memberId": MEMBER,
        "scopes": ["dev:identity", "dev:channels:read", "dev:messages:read", "dev:messages:write", "dev:inbox:read"],
        "channelRestricted": false,
        "createdAtMs": 1_793_179_800_000_i64,
        "expiresAtMs": 1_795_771_800_000_i64,
        "lastUsedAtMs": 1_793_179_900_000_i64,
    })
}

pub fn server_message(
    seq: i64,
    author: &str,
    body: &str,
    created: i64,
    via: Option<&str>,
) -> Value {
    let mut message = json!({
        "id": format!("aaaaaaaa-0000-4000-8000-{seq:012}"),
        "channelId": CHANNEL,
        "seq": seq,
        "hlcTs": 1,
        "hlcCount": 0,
        "authorMemberId": author,
        "type": "text",
        "body": body,
        "state": "sent",
        "props": {"server": "only"},
        "createdAtMs": created,
    });
    if let Some(via) = via {
        message["sentVia"] = json!(via);
    }
    message
}

/// What the CLI is expected to print for such a message: the stable projection.
pub fn printed_message(
    seq: i64,
    author: &str,
    body: &str,
    created: i64,
    via: Option<&str>,
) -> Value {
    let mut message = json!({
        "id": format!("aaaaaaaa-0000-4000-8000-{seq:012}"),
        "channelId": CHANNEL,
        "seq": seq,
        "authorMemberId": author,
        "type": "text",
        "body": body,
        "state": "sent",
        "createdAtMs": created,
    });
    if let Some(via) = via {
        message["sentVia"] = json!(via);
    }
    message
}

/// The routes of ADR-0216 D4 L1–L7 for the token `expected`, with fixed answers.
pub fn dev_api(expected: String) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    move |request: &Request| {
        let base = format!("/v1/workspaces/{WS}");
        let authorised =
            request.header("authorization") == Some(format!("Bearer {expected}").as_str());
        if !authorised {
            return Response::json(401, &json!({"error": {"message": "invalid token"}}));
        }
        let path = request.path.as_str();
        match (request.method.as_str(), path) {
            ("GET", p) if p == format!("{base}/dev-access/self") => {
                Response::json(200, &self_info("card"))
            }
            ("DELETE", p) if p == format!("{base}/dev-access/self") => {
                Response::json(200, &json!({"revokedNow": true}))
            }
            ("GET", p) if p == format!("{base}/channels") => Response::json(
                200,
                &json!({"channels": [
                    {"id": CHANNEL, "workspaceId": WS, "kind": "public", "name": "general", "topic": "공지", "muted": false, "memberIds": []},
                    {"id": "66666666-6666-4666-8666-666666666666", "workspaceId": WS, "kind": "dm", "muted": true, "memberIds": [MEMBER, OTHER_MEMBER]},
                ]}),
            ),
            ("GET", p) if p == format!("{base}/channels/{CHANNEL}/messages") => {
                let query = request.query_map();
                if query.contains_key("after") {
                    Response::json(
                        200,
                        &json!({"messages": [
                            server_message(12, OTHER_MEMBER, "두 번째", 1_793_179_860_000, Some("dev")),
                            server_message(13, MEMBER, "세 번째", 1_793_179_920_000, None),
                        ]}),
                    )
                } else {
                    Response::json(
                        200,
                        &json!({"messages": [
                            server_message(12, OTHER_MEMBER, "두 번째", 1_793_179_860_000, Some("dev")),
                            server_message(11, MEMBER, "첫 번째\n둘째 줄", 1_793_179_800_000, None),
                        ], "nextBefore": 11}),
                    )
                }
            }
            ("GET", p) if p == format!("{base}/channels/{CHANNEL}/messages/{ROOT}/replies") => {
                Response::json(
                    200,
                    &json!({"messages": [
                    server_message(21, OTHER_MEMBER, "답글 하나", 1_793_179_870_000, None),
                    server_message(22, MEMBER, "답글 둘", 1_793_179_880_000, Some("dev")),
                ], "nextCursor": 22}),
                )
            }
            ("POST", p) if p == format!("{base}/channels/{CHANNEL}/messages") => {
                let body = request.json();
                let mut message = server_message(
                    14,
                    MEMBER,
                    body["body"].as_str().unwrap_or(""),
                    1_793_179_990_000,
                    Some("dev"),
                );
                message["clientMsgId"] = body["clientMsgId"].clone();
                if let Some(root) = body.get("rootId") {
                    message["rootId"] = root.clone();
                }
                if let Some(reply_to) = body.get("replyToId") {
                    message["replyToId"] = reply_to.clone();
                }
                Response::json(201, &message)
            }
            ("GET", p) if p == format!("{base}/inbox") => Response::json(
                200,
                &json!({
                    "items": [{
                        "id": "77777777-7777-4777-8777-777777777777",
                        "kind": "mention",
                        "reasons": ["mention"],
                        "channel": {"id": CHANNEL, "name": "general", "kind": "public"},
                        "message": {"id": "aaaaaaaa-0000-4000-8000-000000000012", "seq": 12, "authorMemberId": OTHER_MEMBER, "preview": "안녕하세요\n두 번째 줄", "deleted": false},
                        "actorMemberId": OTHER_MEMBER,
                        "createdAt": "2026-10-28T09:31:00Z",
                        "readAt": null,
                    }],
                    "nextCursor": null,
                    "unreadCount": 1,
                    "approvalsPending": [],
                }),
            ),
            _ => Response::json(404, &json!({"error": {"message": "not found"}})),
        }
    }
}
