//! #3154 (#3155 review Lows): what `momo-workd register --sign-stdin` does when
//! the server's answers are not the happy path. The real binary, a mock
//! server on a loopback port (no database), the test playing the desktop
//! shell on the child's stdio.
//!
//! | case | what it proves |
//! |---|---|
//! | `a_bare_503_is_an_error_not_an_unsigned_registration` | a 503 without the named `instance_id_unconfigured` code (an overloaded proxy, a crashed handler) stops the registration: no row is asked for, no key is left |
//! | `an_unconfigured_instance_registers_unsigned_and_says_so` | the named 503 (and only it) lets the registration go unsigned, the parent is told `signingContext:"unconfigured"`, and the run log says so |
//! | `a_row_the_owner_did_not_sign_for_is_withdrawn` | the server answers with another host id than the one signed: the child asks the server to delete that row, and leaves no key and no state |
//! | `a_row_with_another_key_is_withdrawn` | the server answers with a row for a different public key: same |
//! | `a_completed_registration_prints_the_fingerprint_the_dialog_showed` | the success line carries the same fingerprint as the request line |

use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use uuid::Uuid;

const WORKD: &str = env!("CARGO_BIN_EXE_momo-workd");
const TOKEN: &str = "owner-token-for-the-cleanup-test";

/// How the mock server answers.
#[derive(Clone)]
struct Script {
    /// `GET …/signing-context`: (status, body).
    context: (u16, Value),
    /// What the row `POST …/work-hosts` returns says, relative to the request.
    row: Row,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Row {
    /// The row the request asked for, under this id.
    Asked(Uuid),
    /// A row under this id but for a different public key.
    OtherKey(Uuid),
}

#[derive(Default)]
struct Seen {
    context_gets: u32,
    posts: u32,
    deletes: Vec<Uuid>,
    authorization: Vec<String>,
}

#[derive(Clone)]
struct Mock {
    script: Script,
    seen: Arc<Mutex<Seen>>,
    workspace: Uuid,
    owner: Uuid,
}

async fn context(
    State(mock): State<Mock>,
    headers: axum::http::HeaderMap,
) -> (StatusCode, Json<Value>) {
    let mut seen = mock.seen.lock().unwrap();
    seen.context_gets += 1;
    seen.authorization.push(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string(),
    );
    let (status, body) = mock.script.context.clone();
    (StatusCode::from_u16(status).unwrap(), Json(body))
}

async fn register_row(
    State(mock): State<Mock>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    mock.seen.lock().unwrap().posts += 1;
    let (id, key) = match mock.script.row {
        Row::Asked(id) => (id, request["publicKey"].as_str().unwrap().to_string()),
        Row::OtherKey(id) => (
            id,
            "b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktMTIzNDU=".into(),
        ),
    };
    (
        StatusCode::CREATED,
        Json(json!({ "workHost": {
            "id": id, "workspaceId": mock.workspace, "ownerMemberId": mock.owner,
            "scope": "member", "type": "workd", "publicKey": key,
        }})),
    )
}

async fn withdraw(
    State(mock): State<Mock>,
    Path((_workspace, host)): Path<(Uuid, Uuid)>,
) -> StatusCode {
    mock.seen.lock().unwrap().deletes.push(host);
    StatusCode::OK
}

struct Run {
    success: bool,
    stdout: String,
    stderr: String,
    ask: Option<Value>,
    dir: PathBuf,
    seen: Arc<Mutex<Seen>>,
}

impl Run {
    fn key_file(&self) -> PathBuf {
        self.dir.join("keys").join("host.key")
    }

    fn state_file(&self) -> PathBuf {
        self.dir.join("state").join("host.json")
    }
}

/// Run `register --sign-stdin` against a mock. `answer` builds the shell's
/// reply from the child's request line.
async fn run(script: Script, answer: impl FnOnce(&Value) -> Value) -> Run {
    let workspace = Uuid::new_v4();
    let mock = Mock {
        script,
        seen: Arc::default(),
        workspace,
        owner: Uuid::new_v4(),
    };
    let seen = mock.seen.clone();
    let app = Router::new()
        .route(
            "/v1/workspaces/{ws}/device-keys/signing-context",
            get(context),
        )
        .route("/v1/workspaces/{ws}/work-hosts", post(register_row))
        .route("/v1/workspaces/{ws}/work-hosts/{host}", delete(withdraw))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let dir = std::env::temp_dir().join(format!("momo-rc3154-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(dir.join("repo")).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = dir.join("workd.json");
    std::fs::write(
        &config,
        serde_json::to_vec_pretty(&json!({
            "server_url": base,
            "workspace_id": workspace,
            "display_name": "성재의 맥",
            "state_path": dir.join("state").join("host.json"),
            "working_directory": dir.join("repo"),
            "tools": { "claude": { "adapter": "claude", "executable": "/bin/echo", "args": [] } },
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();

    let mut child = tokio::process::Command::new(WORKD)
        .args(["register", "--token-stdin", "--sign-stdin", "--config"])
        .arg(&config)
        .arg("--dev-key-file")
        .arg(dir.join("keys").join("host.key"))
        .env_remove("MOMO_WORKD_REGISTER_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run momo-workd register");
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(format!("{TOKEN}\n").as_bytes())
        .await
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut ask = None;
    let mut stdout = String::new();
    // The child asks its parent at most once; when it fails before asking, the
    // first line never comes and stdout simply ends.
    if let Some(line) = lines.next_line().await.unwrap() {
        match serde_json::from_str::<Value>(&line) {
            Ok(request) if request["momoWorkd"] == "host_register_request" => {
                let reply = answer(&request);
                ask = Some(request);
                stdin
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
            _ => {
                stdout.push_str(&line);
                stdout.push('\n');
            }
        }
    }
    drop(stdin);
    while let Some(line) = lines.next_line().await.unwrap() {
        stdout.push_str(&line);
        stdout.push('\n');
    }
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await
        .unwrap();
    let status = child.wait().await.unwrap();
    assert!(
        !stderr.contains(TOKEN),
        "the token never reaches a log line"
    );
    Run {
        success: status.success(),
        stdout,
        stderr,
        ask,
        dir,
        seen,
    }
}

fn available_context() -> (u16, Value) {
    (
        200,
        json!({ "instanceId": "inst_3154", "serverTimeMs": 1_790_000_000_000_i64,
                "hostRegisterSignatureRequired": false }),
    )
}

/// A signed-looking registration naming `host_id`; the mock never verifies it.
fn signed_as(host_id: Uuid) -> impl FnOnce(&Value) -> Value {
    move |_| {
        json!({ "registration": {
            "deviceKeyId": Uuid::new_v4(), "hostId": host_id, "nonce": Uuid::new_v4(),
            "issuedAtMs": 1, "expiresAtMs": 2, "signature": "AAAA",
        }})
    }
}

#[tokio::test]
async fn a_bare_503_is_an_error_not_an_unsigned_registration() {
    let run = run(
        Script {
            context: (
                503,
                json!({ "error": { "message": "upstream connect error" } }),
            ),
            row: Row::Asked(Uuid::new_v4()),
        },
        |_| json!({ "unsigned": true }),
    )
    .await;
    assert!(!run.success, "{}", run.stderr);
    assert!(
        run.ask.is_none(),
        "the parent is never asked to go unsigned"
    );
    let seen = run.seen.lock().unwrap();
    assert_eq!(
        (seen.context_gets, seen.posts),
        (1, 0),
        "no row is asked for"
    );
    assert!(!run.key_file().exists(), "no key is left");
    assert!(!run.state_file().exists());
}

#[tokio::test]
async fn an_unconfigured_instance_registers_unsigned_and_says_so() {
    let id = Uuid::new_v4();
    let run = run(
        Script {
            context: (
                503,
                json!({ "error": { "message": "no id", "code": "instance_id_unconfigured" } }),
            ),
            row: Row::Asked(id),
        },
        |_| json!({ "unsigned": true }),
    )
    .await;
    assert!(run.success, "{}", run.stderr);
    let ask = run.ask.as_ref().expect("the parent is told");
    assert_eq!(ask["signingContext"], "unconfigured");
    assert!(ask["instanceId"].is_null());
    assert!(
        run.stderr
            .contains("registering without the owner's signature"),
        "the fallback is logged, not silent: {}",
        run.stderr
    );
    assert_eq!(run.seen.lock().unwrap().posts, 1);
    assert!(run.state_file().exists());
}

#[tokio::test]
async fn a_row_the_owner_did_not_sign_for_is_withdrawn() {
    let signed = Uuid::new_v4();
    let made = Uuid::new_v4();
    let run = run(
        Script {
            context: available_context(),
            row: Row::Asked(made),
        },
        signed_as(signed),
    )
    .await;
    assert!(!run.success);
    assert!(
        run.stderr.contains("another host id than the one signed"),
        "{}",
        run.stderr
    );
    assert_eq!(
        run.seen.lock().unwrap().deletes,
        [made],
        "the row the server made is withdrawn"
    );
    assert!(!run.key_file().exists());
    assert!(!run.state_file().exists());
}

#[tokio::test]
async fn a_row_with_another_key_is_withdrawn() {
    let id = Uuid::new_v4();
    let run = run(
        Script {
            context: available_context(),
            row: Row::OtherKey(id),
        },
        signed_as(id),
    )
    .await;
    assert!(!run.success);
    assert!(
        run.stderr
            .contains("a different host than the one requested"),
        "{}",
        run.stderr
    );
    assert_eq!(run.seen.lock().unwrap().deletes, [id]);
    assert!(!run.key_file().exists(), "the key does not outlive the row");
    assert!(!run.state_file().exists());
}

#[tokio::test]
async fn a_completed_registration_prints_the_fingerprint_the_dialog_showed() {
    let id = Uuid::new_v4();
    let run = run(
        Script {
            context: available_context(),
            row: Row::Asked(id),
        },
        signed_as(id),
    )
    .await;
    assert!(run.success, "{}", run.stderr);
    let shown = run.ask.as_ref().unwrap()["hostKeyFingerprint"]
        .as_str()
        .expect("the request line carries the fingerprint")
        .to_string();
    let done: Value =
        serde_json::from_str(run.stdout.lines().last().unwrap()).expect("the result line");
    assert_eq!(done["hostKeyFingerprint"], json!(shown));
    assert_eq!(done["hostId"], json!(id));
    assert!(run.seen.lock().unwrap().deletes.is_empty());
    // Five groups of four upper-case hex digits.
    assert_eq!(shown.split(' ').count(), 5, "{shown}");
    assert!(shown
        .split(' ')
        .all(|group| group.len() == 4 && group.chars().all(|c| c.is_ascii_hexdigit())));
    assert_eq!(
        run.seen.lock().unwrap().authorization,
        [format!("Bearer {TOKEN}")]
    );
}
