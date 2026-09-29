//! #3120 — the root key's `host_register` signature, end to end (ADR-0146 개정
//! 2026-09-28 D-8, R2-E10 M1): the real `momo-workd register --sign-stdin`
//! binary against the real server router on an isolated PG, with this test
//! playing the desktop shell on the child's stdio (read the request line,
//! sign with a software P-256 root key, answer one line).
//!
//! | case | what it proves |
//! |---|---|
//! | `a_signed_registration_succeeds_and_an_unsigned_one_is_refused_when_required` | flag ON: the shell's signature makes the host row under the signed id; the same child with no signature (`--sign-stdin` answered `unsigned`, or no `--sign-stdin` at all) is refused and leaves no key, no state, no row |
//! | `a_bad_signature_declined_dialog_or_other_label_registers_nothing` | flag ON: a non-root signer, a statement for another label, and a declined dialog each register nothing and leave no key |
//! | `flag_off_keeps_todays_unsigned_registration` | flag OFF: `unsigned` and plain registrations still succeed; a signature that IS sent is still verified |
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the runtime
//! roles (the same as `human_signature_roundtrip_pg`):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26773/momo \
//!   cargo test -p momo-workd --test host_register_signature_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState};
use momo_wire::human_control::{ControlContent, HumanControl};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use uuid::Uuid;

const WORKD: &str = env!("CARGO_BIN_EXE_momo-workd");
const JWT_SECRET: &str = "hostreg-3120-conformance-secret";
const PASSWORD: &str = "hostreg-3120-password";
const INSTANCE_ID: &str = "inst_3120_hostreg";
const LABEL: &str = "성재의 맥";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn ensure_schema_and_roles() {
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet", "-f"])
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .output()
        .expect("spawn psql");
    assert!(
        roles.status.success(),
        "bootstrap_roles.sql failed to apply"
    );
}

struct Device {
    signing: SigningKey,
    public_b64: String,
}

impl Device {
    fn new(scalar: u8) -> Device {
        let signing = SigningKey::from_slice(&[scalar; 32]).expect("scalar");
        let point = signing.verifying_key().to_sec1_point(true);
        Device {
            public_b64: BASE64.encode(point.as_bytes()),
            signing,
        }
    }

    fn sign(&self, bytes: &[u8]) -> String {
        let signature: Signature = self.signing.sign(bytes);
        BASE64.encode(signature.to_bytes())
    }
}

struct World {
    su: PgPool,
    base: String,
    workspace: Uuid,
    person: Uuid,
    access: String,
    root_id: Uuid,
}

/// A server (`required` = `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED`), one
/// person, and that person's Mac root key.
async fn world(required: bool, root_scalar: u8) -> World {
    ensure_schema_and_roles();
    let su = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("superuser");
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    let app = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("momo_app");
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("hr-{workspace}"))
        .execute(&su)
        .await
        .unwrap();
    let person = Uuid::new_v4();
    let email = format!("{person}@hr3120.test");
    for sql in [
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'human', $3, $3)",
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($2, $1, 'member')",
    ] {
        let query = sqlx::query(sql).bind(person).bind(workspace);
        let query = if sql.contains("INTO member ") {
            query.bind(format!("hr-{}", &person.simple().to_string()[..10]))
        } else if sql.contains("INTO human ") {
            query.bind(&email).bind(PASSWORD)
        } else {
            query
        };
        query.execute(&su).await.expect(sql);
    }
    let router = build_app(
        AppState::new(
            app,
            JWT_SECRET.to_string(),
            momo_server::RealtimeAdvert::SameOrigin,
        )
        .with_device_keys(DeviceKeySettings {
            instance_id: Some(INSTANCE_ID.to_string()),
            host_register_signature_required: required,
            ..DeviceKeySettings::default()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let base = format!("http://{address}");
    let http = reqwest::Client::new();
    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": PASSWORD, "workspace": workspace.to_string() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let access = login["accessToken"].as_str().expect("access").to_string();
    let root = Device::new(root_scalar);
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/device-keys"))
        .bearer_auth(&access)
        .json(
            &json!({ "alg": "p256", "publicKey": root.public_b64, "platform": "macos",
                       "label": "맥", "currentPassword": PASSWORD }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 201);
    let body: Value = response.json().await.unwrap();
    let root_id = Uuid::parse_str(body["deviceKey"]["id"].as_str().unwrap()).unwrap();
    World {
        su,
        base,
        workspace,
        person,
        access,
        root_id,
    }
}

impl World {
    async fn hosts_of_the_person(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM work_host WHERE workspace_id = $1 AND owner_member_id = $2",
        )
        .bind(self.workspace)
        .bind(self.person)
        .fetch_one(&self.su)
        .await
        .unwrap()
    }
}

/// What the test plays as the desktop shell.
#[derive(Clone, Copy, PartialEq)]
enum Shell {
    /// No `--sign-stdin` at all: today's `momo-workd register`.
    NoSigning,
    /// Signs with the root, for `label`.
    Signs(&'static str),
    /// Signs with a key the server never registered as the root.
    SignsWithAnotherKey,
    /// The dialog was declined.
    Declines,
    /// This Mac has no root bound.
    NoRoot,
}

struct Outcome {
    success: bool,
    stdout: String,
    stderr: String,
    request: Option<Value>,
    signed_host_id: Option<Uuid>,
    dir: PathBuf,
}

impl Outcome {
    fn last_stderr_line(&self) -> String {
        self.stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default()
            .to_string()
    }

    fn key_file(&self) -> PathBuf {
        self.dir.join("keys").join("host.key")
    }

    fn state_file(&self) -> PathBuf {
        self.dir.join("state").join("host.json")
    }
}

async fn register(w: &World, shell: Shell) -> Outcome {
    let dir = std::env::temp_dir().join(format!("momo-hr3120-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(dir.join("repo")).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = dir.join("workd.json");
    std::fs::write(
        &config,
        serde_json::to_vec_pretty(&json!({
            "server_url": w.base,
            "workspace_id": w.workspace,
            "display_name": LABEL,
            "state_path": dir.join("state").join("host.json"),
            "working_directory": dir.join("repo"),
            // Registration never starts the tool; the config only has to
            // name one (it is never launched here).
            "tools": { "claude": { "adapter": "claude", "executable": "/bin/echo", "args": [] } },
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut args = vec!["register", "--token-stdin"];
    if shell != Shell::NoSigning {
        args.push("--sign-stdin");
    }
    let mut child = tokio::process::Command::new(WORKD)
        .args(&args)
        .arg("--config")
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
        .write_all(format!("{}\n", w.access).as_bytes())
        .await
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut request = None;
    let mut signed_host_id = None;
    if shell == Shell::NoSigning {
        drop(stdin);
    } else {
        let Some(line) = lines.next_line().await.unwrap() else {
            let mut stderr = String::new();
            if let Some(mut err) = child.stderr.take() {
                tokio::io::AsyncReadExt::read_to_string(&mut err, &mut stderr)
                    .await
                    .unwrap();
            }
            panic!("the child must ask before it registers; it said: {stderr}");
        };
        let ask: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ask["momoWorkd"], "host_register_request");
        let host_key = ask["hostPublicKey"].as_str().unwrap().to_string();
        let answer = match shell {
            Shell::Declines => json!({ "declined": "device_key_declined" }),
            Shell::NoRoot => json!({ "unsigned": true }),
            Shell::Signs(_) | Shell::SignsWithAnotherKey => {
                let signer = match shell {
                    Shell::SignsWithAnotherKey => Device::new(99),
                    _ => Device::new(ROOT_SCALAR),
                };
                let host_id = Uuid::new_v4();
                let nonce = Uuid::new_v4();
                let issued = ask["serverTimeMs"].as_i64().expect("server clock");
                let expires = issued + 5 * 60 * 1000;
                let label = match shell {
                    Shell::Signs(label) => label,
                    _ => LABEL,
                };
                let bytes = HumanControl {
                    instance_id: ask["instanceId"].as_str().expect("instance id"),
                    workspace_id: w.workspace,
                    member_id: w.person,
                    device_key_id: w.root_id,
                    host_id,
                    session_id: None,
                    nonce,
                    issued_at_ms: issued,
                    expires_at_ms: expires,
                    content: ControlContent::HostRegister {
                        host_public_key_b64: &host_key,
                        host_id,
                        label,
                    },
                }
                .signed_bytes()
                .expect("host_register bytes");
                signed_host_id = Some(host_id);
                json!({ "registration": {
                    "deviceKeyId": w.root_id,
                    "hostId": host_id,
                    "nonce": nonce,
                    "issuedAtMs": issued,
                    "expiresAtMs": expires,
                    "signature": signer.sign(&bytes),
                }})
            }
            _ => unreachable!(),
        };
        request = Some(ask);
        stdin
            .write_all(format!("{answer}\n").as_bytes())
            .await
            .unwrap();
        drop(stdin);
    }
    let mut stdout = String::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        stdout.push_str(&line);
        stdout.push('\n');
    }
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        tokio::io::AsyncReadExt::read_to_string(&mut err, &mut stderr)
            .await
            .unwrap();
    }
    let status = child.wait().await.unwrap();
    assert!(
        !stderr.contains(&w.access),
        "the owner's token never reaches a log line"
    );
    Outcome {
        success: status.success(),
        stdout,
        stderr,
        request,
        signed_host_id,
        dir,
    }
}

const ROOT_SCALAR: u8 = 31;

#[tokio::test]
#[ignore = "needs a live pgvector/pg18 DATABASE_URL"]
async fn a_signed_registration_succeeds_and_an_unsigned_one_is_refused_when_required() {
    let w = world(true, ROOT_SCALAR).await;

    // The shell signs: the row exists under the signed id, the child's state
    // names it, and the request line carried the server's own context.
    let signed = register(&w, Shell::Signs(LABEL)).await;
    assert!(signed.success, "{}", signed.stderr);
    let ask = signed.request.as_ref().unwrap();
    assert_eq!(ask["instanceId"], INSTANCE_ID);
    assert_eq!(ask["hostRegisterSignatureRequired"], true);
    let printed: Value = serde_json::from_str(signed.stdout.trim()).unwrap();
    let host_id = signed.signed_host_id.unwrap();
    assert_eq!(printed["hostId"], host_id.to_string());
    let state: Value =
        serde_json::from_slice(&std::fs::read(signed.state_file()).unwrap()).unwrap();
    assert_eq!(state["host_id"], host_id.to_string());
    assert_eq!(w.hosts_of_the_person().await, 1);
    let provenance: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_host WHERE id = $1 AND workspace_id = $2 AND public_key = $3",
    )
    .bind(host_id)
    .bind(w.workspace)
    .bind(state["public_key"].as_str().unwrap())
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(provenance, 1);

    // Required, and the shell has no root bound: refused BEFORE the POST.
    let no_root = register(&w, Shell::NoRoot).await;
    assert!(!no_root.success);
    assert!(
        no_root
            .last_stderr_line()
            .contains("device_signature_required"),
        "{}",
        no_root.stderr
    );
    // Required, and an old workd with no signing at all: the SERVER refuses.
    let plain = register(&w, Shell::NoSigning).await;
    assert!(!plain.success);
    assert!(
        plain.last_stderr_line().contains("host_register signature"),
        "{}",
        plain.stderr
    );
    for refused in [&no_root, &plain] {
        assert!(!refused.key_file().exists(), "no key for a refused host");
        assert!(!refused.state_file().exists());
    }
    assert_eq!(w.hosts_of_the_person().await, 1, "only the signed one");
}

#[tokio::test]
#[ignore = "needs a live pgvector/pg18 DATABASE_URL"]
async fn a_bad_signature_declined_dialog_or_other_label_registers_nothing() {
    let w = world(true, ROOT_SCALAR).await;
    let other_key = register(&w, Shell::SignsWithAnotherKey).await;
    let other_label = register(&w, Shell::Signs("다른 이름")).await;
    let declined = register(&w, Shell::Declines).await;
    for (name, outcome) in [
        ("a key that is not the root", &other_key),
        ("a statement for another label", &other_label),
        ("a declined dialog", &declined),
    ] {
        assert!(!outcome.success, "{name} must not register");
        assert!(!outcome.key_file().exists(), "{name}: no key left");
        assert!(!outcome.state_file().exists(), "{name}: no state");
    }
    assert!(
        other_key.last_stderr_line().contains("403"),
        "{}",
        other_key.stderr
    );
    assert!(
        declined.last_stderr_line().contains("device_key_declined"),
        "{}",
        declined.stderr
    );
    assert_eq!(w.hosts_of_the_person().await, 0);
}

#[tokio::test]
#[ignore = "needs a live pgvector/pg18 DATABASE_URL"]
async fn flag_off_keeps_todays_unsigned_registration() {
    let w = world(false, ROOT_SCALAR).await;
    let unsigned = register(&w, Shell::NoRoot).await;
    assert!(unsigned.success, "{}", unsigned.stderr);
    assert_eq!(
        unsigned.request.as_ref().unwrap()["hostRegisterSignatureRequired"],
        false
    );
    let plain = register(&w, Shell::NoSigning).await;
    assert!(plain.success, "{}", plain.stderr);
    // Off is not "unchecked": a signature that is sent must still verify.
    let forged = register(&w, Shell::SignsWithAnotherKey).await;
    assert!(
        !forged.success,
        "a bad signature is refused with the flag off"
    );
    let signed = register(&w, Shell::Signs(LABEL)).await;
    assert!(signed.success, "{}", signed.stderr);
    assert_eq!(w.hosts_of_the_person().await, 3);
}
