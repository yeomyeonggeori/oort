//! #4941 — `GET …/expressions/photo-model` and `POST …/expressions/photo-drafts`
//! (ADR-0218 §8 H9): the team's image model draws from a member's own photo.
//!
//! Real axum app, real PG18, the NOBYPASSRLS runtime role, two tenants. The image model is a fake
//! OpenAI on 127.0.0.1 driven through the **production** guarded client (`GuardedImageModel`), so
//! what is proved here is the whole path: the team key opened from `provider_link`, the photo
//! prepared in the isolated decoder, the one outbound request, and the picture decoded again in
//! the isolated decoder before it is a draft. No real provider, key or person's photo is used.
//!
//! DATABASE_URL=<dedicated DB> cargo test -p momo-server --test expressions_photo_pg \
//!   -- --ignored --test-threads=1
//!
//! Needs the isolated decoder child beside the test binary: `cargo build -p momo-expressions
//! --bins` first (#4947); `require_decoder_4947` fails first and names the command.
use futures::future::BoxFuture;
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::PgPool;
use momo_expressions::{self as e, Actor, PHOTO_PROMPTS};
use momo_image_model::{GuardedImageModel, ImageModelConfig, ImageProvider};
use momo_server::{build_app, config::RealtimeSettings, config::SettingsConfig, AppState};
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Semaphore;
use uuid::Uuid;

const SECRET: &str = "expression-photo-conformance-only";
const MASTER: &str = "photo-test-master-key-0001";
const KEY: &str = "sk-photo-team-key-0123456789";
const ECHO: &str = "provider-said-something-private";
const LOCATION: &[u8] = b"GPS-37.5665N-126.9780E-MEMBER-HOME";

// ── the fake provider ───────────────────────────────────────────────────────

#[derive(Clone)]
enum Reply {
    Picture(Vec<u8>),
    /// A status, with the provider echoing the key and `ECHO` into its body and a header.
    Status(u16, &'static str),
    Raw(Vec<u8>),
    After(Duration, Box<Reply>),
    Hold(Arc<Semaphore>, Box<Reply>),
}

struct Seen {
    path: String,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

type Script = Arc<Mutex<Reply>>;

struct Fake {
    seen: Arc<Mutex<Vec<Seen>>>,
    script: Script,
    authority: String,
    _task: tokio::task::JoinHandle<()>,
}

fn respond(reply: Reply) -> BoxFuture<'static, axum::response::Response> {
    use axum::response::IntoResponse;
    Box::pin(async move {
        match reply {
            Reply::Picture(bytes) => {
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    json!({"created": 1, "data": [{"b64_json": b64}]}).to_string(),
                )
                    .into_response()
            }
            Reply::Status(status, extra) => (
                axum::http::StatusCode::from_u16(status).unwrap(),
                [("x-echo-key", KEY.to_string())],
                format!(r#"{{"error":{{"message":"bad key {KEY} {ECHO} {extra}"}}}}"#),
            )
                .into_response(),
            Reply::Raw(bytes) => (axum::http::StatusCode::OK, bytes).into_response(),
            Reply::After(delay, inner) => {
                tokio::time::sleep(delay).await;
                respond(*inner).await
            }
            Reply::Hold(gate, inner) => {
                let _permit = gate.acquire().await.unwrap();
                respond(*inner).await
            }
        }
    })
}

impl Fake {
    async fn start() -> Fake {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let script: Script = Arc::new(Mutex::new(Reply::Status(500, "unscripted")));
        let app = axum::Router::new()
            .fallback(
                |axum::extract::State((seen, script)): axum::extract::State<(
                    Arc<Mutex<Vec<Seen>>>,
                    Script,
                )>,
                 request: axum::extract::Request| async move {
                    let (parts, body) = request.into_parts();
                    let body = axum::body::to_bytes(body, 64 * 1024 * 1024)
                        .await
                        .unwrap_or_default()
                        .to_vec();
                    seen.lock().unwrap().push(Seen {
                        path: parts.uri.path().to_string(),
                        headers: parts.headers,
                        body,
                    });
                    let reply = script.lock().unwrap().clone();
                    respond(reply).await
                },
            )
            .with_state((seen.clone(), script.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Fake {
            seen,
            script,
            authority,
            _task: task,
        }
    }
    fn say(&self, reply: Reply) {
        *self.script.lock().unwrap() = reply;
    }
    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
    fn last(&self) -> Seen {
        let mut seen = self.seen.lock().unwrap();
        let last = seen.pop().expect("the provider was called");
        seen.clear();
        last
    }
    fn forget(&self) {
        self.seen.lock().unwrap().clear();
    }
}

// ── pictures ────────────────────────────────────────────────────────────────

fn png_of(image: &image::RgbaImage) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn disc(image: &mut image::RgbaImage, r: i64, colour: [u8; 4]) {
    let (cx, cy) = (i64::from(image.width()) / 2, i64::from(image.height()) / 2);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (dx, dy) = (i64::from(x) - cx, i64::from(y) - cy);
        if dx * dx + dy * dy <= r * r {
            *pixel = image::Rgba(colour);
        }
    }
}

/// What a model that was asked for a transparent background draws.
fn drawn_transparent() -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(600, 600, image::Rgba([0, 0, 0, 0]));
    disc(&mut image, 180, [220, 30, 30, 255]);
    png_of(&image)
}
/// What a model that was asked for one flat colour draws.
fn drawn_on_green() -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(600, 600, image::Rgba([0, 200, 0, 255]));
    disc(&mut image, 180, [220, 30, 30, 255]);
    png_of(&image)
}
fn drawn_caricature() -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(600, 600, image::Rgba([255, 255, 255, 255]));
    disc(&mut image, 200, [250, 200, 40, 255]);
    disc(&mut image, 60, [40, 40, 200, 255]);
    png_of(&image)
}

/// A phone photo: sideways by its EXIF, with a comment naming where it was taken and bytes after
/// its end — everything the route must keep from leaving.
fn photo_from_home() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(1600, 1200, image::Rgb([40, 120, 200]));
    let mut jpeg = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut jpeg, image::ImageFormat::Jpeg)
        .unwrap();
    let jpeg = jpeg.into_inner();
    let mut tiff = b"MM\0*".to_vec();
    tiff.extend_from_slice(&8u32.to_be_bytes());
    tiff.extend_from_slice(&1u16.to_be_bytes());
    tiff.extend_from_slice(&0x0112u16.to_be_bytes());
    tiff.extend_from_slice(&3u16.to_be_bytes());
    tiff.extend_from_slice(&1u32.to_be_bytes());
    tiff.extend_from_slice(&6u16.to_be_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_be_bytes());
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&[0xFF, 0xFE]);
    out.extend_from_slice(&((LOCATION.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(LOCATION);
    out.extend_from_slice(&jpeg[2..]);
    out.extend_from_slice(b"TRAILING-BYTES-OF-THE-ORIGINAL");
    out
}

fn has(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The bytes of the `image[]` part of the OpenAI form the fake received.
fn sent_photo(seen: &Seen) -> Vec<u8> {
    let content_type = seen.headers["content-type"].to_str().unwrap();
    let boundary = format!("--{}", content_type.split("boundary=").nth(1).unwrap());
    let start = seen
        .body
        .windows(b"name=\"image[]\"".len())
        .position(|w| w == b"name=\"image[]\"")
        .expect("an image[] part");
    let from = start
        + seen.body[start..]
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap()
        + 4;
    let to = from
        + seen.body[from..]
            .windows(boundary.len())
            .position(|w| w == boundary.as_bytes())
            .unwrap()
        - 2;
    seen.body[from..to].to_vec()
}

fn form_text(seen: &Seen) -> String {
    String::from_utf8_lossy(&seen.body).into_owned()
}

// ── the world ───────────────────────────────────────────────────────────────

struct Person {
    actor: Actor,
    token: String,
}

struct World {
    su: PgPool,
    api: PgPool,
    ws: Uuid,
    channel: Uuid,
    owner: Person,
    member: Person,
    other_member: Person,
    guest: Person,
    foreign: Person,
    agent_token: String,
    http: reqwest::Client,
    base: String,
    prefix: String,
    fake: Fake,
    _server: tokio::task::JoinHandle<()>,
}

async fn seed(su: &PgPool, ws: Uuid, role: &str, http: &reqwest::Client, base: &str) -> Person {
    let id = Uuid::new_v4();
    let email = format!("{id}@expressions-photo.test");
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'human',$3,$3)",
    )
    .bind(id)
    .bind(ws)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,$3::membership_role)")
        .bind(ws)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO human(member_id,workspace_id,email,password_hash) VALUES($1,$2,$3,momo_password_hash('expression-test-pass'))")
        .bind(id)
        .bind(ws)
        .bind(&email)
        .execute(su)
        .await
        .unwrap();
    let r = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({"email":email,"password":"expression-test-pass","workspace":ws}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "login as {role}");
    let body: Value = r.json().await.unwrap();
    Person {
        actor: Actor {
            workspace: ws,
            member: id,
        },
        token: body["accessToken"].as_str().unwrap().into(),
    }
}

async fn workspace(su: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
    id
}

fn require_decoder_4947() {
    if std::env::var_os("OORT_EXPRESSION_DECODER").is_some() {
        return;
    }
    let exe = std::env::current_exe().expect("test executable");
    let mut dir = exe.parent().expect("target dir").to_path_buf();
    if dir.file_name() == Some(std::ffi::OsStr::new("deps")) {
        dir.pop();
    }
    let path = dir.join("momo-expression-decoder");
    assert!(
        path.is_file(),
        "build the decoder first: cargo build -p momo-expressions --bins ({path:?}); without it \
         every picture is invalid media and every photo draft fails"
    );
}

/// The kinds of model a test can ask the route to be configured with.
fn quick_client(deadline: Duration) -> Arc<GuardedImageModel> {
    Arc::new(GuardedImageModel::new(
        momo_settings::EgressPolicy {
            allow_local: true,
            local_hosts: Vec::new(),
            operator_hosts: Vec::new(),
        },
        deadline,
    ))
}

async fn boot() -> World {
    boot_with(Duration::from_secs(20), |config| config).await
}

async fn boot_with(
    deadline: Duration,
    tune: impl FnOnce(ImageModelConfig) -> ImageModelConfig,
) -> World {
    require_decoder_4947();
    let url = std::env::var("DATABASE_URL").expect("dedicated DATABASE_URL");
    momo_db::migrate::run_migrations(
        &url,
        &momo_db::migrate::default_migrations_dir(),
        momo_db::migrate::SeedMode::None,
    )
    .unwrap();
    let psql = if std::path::Path::new("/opt/homebrew/opt/libpq/bin/psql").is_file() {
        "/opt/homebrew/opt/libpq/bin/psql"
    } else {
        "psql"
    };
    assert!(std::process::Command::new(psql)
        .arg(&url)
        .args(["--quiet", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-f"])
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .output()
        .unwrap()
        .status
        .success());
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let options: PgConnectOptions = url.parse().unwrap();
    let api = PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password("momo_app_dev_pw"))
        .await
        .unwrap();
    let (superuser, bypass): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&api)
            .await
            .unwrap();
    assert!(!superuser && !bypass, "momo_app must be a plain role");
    let fake = Fake::start().await;
    let config = tune(ImageModelConfig::default().with_test_host(
        &fake.authority,
        ImageProvider::OpenAi,
        &format!("http://{}/v1", fake.authority),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let archive = Arc::new(momo_drive::StubDriveArchive::new(&base));
    let state = AppState::new(
        api.clone(),
        SECRET.into(),
        "ws://localhost:8000/connection/websocket".to_string(),
    )
    .with_drive(archive)
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(MASTER.into()),
        ..SettingsConfig::default()
    })
    .with_image_model(quick_client(deadline), config)
    .with_realtime(RealtimeSettings {
        cent_token_hmac: Some(SECRET.into()),
        cent_proxy_secret: Some(SECRET.into()),
        connection_token_ttl_seconds: 300,
    });
    let server = tokio::spawn(async move {
        axum::serve(listener, build_app(state)).await.unwrap();
    });
    // A request that should have been refused but was let in would wait on the fake provider for
    // ever: the client gives up, and the test fails instead of hanging.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let ws = workspace(&su).await;
    let foreign_ws = workspace(&su).await;
    let owner = seed(&su, ws, "owner", &http, &base).await;
    let member = seed(&su, ws, "member", &http, &base).await;
    let other_member = seed(&su, ws, "member", &http, &base).await;
    let guest = seed(&su, ws, "guest", &http, &base).await;
    let foreign = seed(&su, foreign_ws, "owner", &http, &base).await;
    let agent_token = agent_bearer(&su, ws).await;
    // A public channel the owner and the member are in.
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id,workspace_id,kind,name) VALUES($1,$2,'public','photo test')",
    )
    .bind(channel)
    .bind(ws)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq(channel_id,workspace_id) VALUES($1,$2)")
        .bind(channel)
        .bind(ws)
        .execute(&su)
        .await
        .unwrap();
    for p in [&owner, &member] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(p.actor.member)
            .execute(&su)
            .await
            .unwrap();
    }
    let world = World {
        prefix: format!("{base}/v1/workspaces/{ws}"),
        su,
        api,
        ws,
        channel,
        owner,
        member,
        other_member,
        guest,
        foreign,
        agent_token,
        http,
        base,
        fake,
        _server: server,
    };
    // `provider_link` is instance-global and this DB outlives the test: start from none.
    world.disconnect().await;
    world
}

/// A real agent member with a real `agent_bearer` token (same shape the Agent Port issues).
async fn agent_bearer(su: &PgPool, ws: Uuid) -> String {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'agent',$3,$3)",
    )
    .bind(id)
    .bind(ws)
    .bind(format!("agent-{id}"))
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member')",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .unwrap();
    let token = format!(
        "momo_agent_v1.{ws}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label) VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), ARRAY['messages:write','messages:read']::text[], 'photo-pg')")
        .bind(ws)
        .bind(id)
        .bind(&token)
        .execute(su)
        .await
        .unwrap();
    token
}

impl World {
    /// Connect the team key. `base` is the fake provider's address unless a test says otherwise.
    async fn connect(&self, base_url: &str, credential: momo_settings::LinkCredential, mode: &str) {
        let sealed = momo_settings::seal_bearer(&credential.to_sealed_plaintext(), MASTER).unwrap();
        let (base_url, mode, member) = (
            base_url.to_string(),
            mode.to_string(),
            self.owner.actor.member,
        );
        momo_db::with_provider_link_admin_tx(&self.api, self.ws, move |conn| {
            Box::pin(async move {
                momo_settings::upsert_link(conn, &base_url, &sealed, &mode, member).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    }
    async fn connect_fake(&self) {
        self.connect(
            &format!("http://{}/v1", self.fake.authority),
            momo_settings::LinkCredential::Bearer(KEY.into()),
            "external-hermes",
        )
        .await;
    }
    async fn disconnect(&self) {
        momo_db::with_provider_link_admin_tx(&self.api, self.ws, move |conn| {
            Box::pin(async move {
                momo_settings::delete_link(conn).await?;
                momo_settings::delete_all_chain_entries(conn).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    }
    fn meta(&self, branch: &str, name: &str) -> Value {
        json!({"branch":branch,"acknowledgedProvider":"openai","name":name,"displayName":"내 사진","tags":["사진"],"subjectMemberId":null})
    }
    async fn model(&self, who: &Person) -> reqwest::Response {
        self.http
            .get(format!("{}/expressions/photo-model", self.prefix))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap()
    }
    /// The multipart request: `metadata` and `file`.
    async fn photo(&self, who: &Person, meta: &Value, file: &[u8]) -> reqwest::Response {
        let mut body = Vec::new();
        body.extend_from_slice(b"--oort-photo-test\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n");
        body.extend_from_slice(meta.to_string().as_bytes());
        body.extend_from_slice(b"\r\n--oort-photo-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: application/octet-stream\r\n\r\n");
        body.extend_from_slice(file);
        body.extend_from_slice(b"\r\n--oort-photo-test--\r\n");
        self.http
            .post(format!("{}/expressions/photo-drafts", self.prefix))
            .bearer_auth(&who.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-photo-test",
            )
            .body(body)
            .send()
            .await
            .unwrap()
    }
    async fn photo_of_attachment(
        &self,
        who: &Person,
        meta: &Value,
        attachment: Uuid,
        channel: Uuid,
    ) -> reqwest::Response {
        let mut body = meta.clone();
        body["attachmentId"] = json!(attachment);
        body["channelId"] = json!(channel);
        self.http
            .post(format!("{}/expressions/photo-drafts", self.prefix))
            .bearer_auth(&who.token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn json(&self, response: reqwest::Response, status: u16) -> Value {
        let got = response.status().as_u16();
        let text = response.text().await.unwrap();
        assert!(
            !text.contains(KEY) && !text.contains(ECHO),
            "a response carried a secret: {text}"
        );
        assert_eq!(got, status, "body: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }
    async fn code(&self, response: reqwest::Response, status: u16) -> String {
        self.json(response, status).await["error"]["code"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }
    async fn drafts_of(&self, who: &Person) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM expression_draft WHERE workspace_id=$1 AND creator=$2",
        )
        .bind(who.actor.workspace)
        .bind(who.actor.member)
        .fetch_one(&self.su)
        .await
        .unwrap()
    }
    async fn clear_drafts(&self) {
        sqlx::query("DELETE FROM expression_draft WHERE workspace_id=$1")
            .bind(self.ws)
            .execute(&self.su)
            .await
            .unwrap();
    }
    async fn activate(&self, who: &Person, draft: &Value) -> reqwest::Response {
        self.http
            .post(format!("{}/expressions", self.prefix))
            .bearer_auth(&who.token)
            .json(&json!({"draftId":draft["draftId"],"revision":draft["revision"],"sha256":draft["media"]["large"]["sha256"]}))
            .send()
            .await
            .unwrap()
    }
    /// An attachment `who` uploaded to the channel and sent in a message of their own.
    async fn attach(&self, who: &Person, channel: Uuid, bytes: &[u8]) -> Uuid {
        let created: Value = self
            .http
            .post(format!(
                "{}/channels/{channel}/attachments/uploads",
                self.prefix
            ))
            .bearer_auth(&who.token)
            .json(&json!({"name":"photo.jpg","mime":"image/jpeg","size":bytes.len()}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let put = self
            .http
            .put(created["uploadUrl"].as_str().unwrap())
            .header("content-type", "image/jpeg")
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert!(put.status().is_success(), "stub upload: {}", put.status());
        let done: Value = self
            .http
            .post(format!(
                "{}/channels/{channel}/attachments/{}/complete",
                self.prefix,
                created["id"].as_str().unwrap()
            ))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id: Uuid = done["id"].as_str().unwrap().parse().unwrap();
        let sent = self
            .http
            .post(format!("{}/channels/{channel}/messages", self.prefix))
            .bearer_auth(&who.token)
            .json(&json!({"clientMsgId":Uuid::new_v4(),"body":"my photo","attachmentIds":[id]}))
            .send()
            .await
            .unwrap();
        assert_eq!(sent.status().as_u16(), 201, "send with attachment");
        id
    }
}

fn unique(prefix: &str) -> String {
    format!("{prefix}_{}", &Uuid::new_v4().simple().to_string()[..12])
}

// A scripted log sink: what the process wrote to its logs while a request ran.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl Logs {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

// ── the tests ───────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn both_branches_draw_a_draft_the_member_can_activate_and_the_model_sees_only_a_clean_photo()
{
    let w = boot().await;
    w.connect_fake().await;
    let logs = Logs::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer({
                let logs = logs.clone();
                move || logs.clone()
            })
            .finish(),
    );

    // The form asks first: which company would a photo go to?
    let model = w.json(w.model(&w.member).await, 200).await;
    assert_eq!(model["available"], true);
    assert_eq!(model["provider"], "openai");
    assert_eq!(model["branches"], json!(["cutout", "caricature"]));
    assert_eq!(
        model["canManage"], false,
        "a plain member cannot connect a model"
    );

    // 1. 배경 지우기 with a model that can draw a transparent background: kept as drawn.
    w.fake.say(Reply::Picture(drawn_transparent()));
    let name = unique("cutout");
    let made = w
        .json(
            w.photo(&w.member, &w.meta("cutout", &name), &photo_from_home())
                .await,
            201,
        )
        .await;
    assert_eq!(made["cutout"], "model");
    let draft = &made["draft"];
    assert_eq!(draft["state"], "ready");
    assert_eq!(draft["name"], name);
    assert_eq!(draft["origin"]["kind"], "generated");
    assert_eq!(draft["origin"]["prompt"], PHOTO_PROMPTS[0].1);
    assert_eq!(draft["origin"]["sourceUrl"], Value::Null);
    assert_eq!(draft["origin"]["sourceAttachmentId"], Value::Null);
    // What the provider received: one request, the key in the header only, a transparent-background
    // ask, and a photo that is upright, small and has nothing the original had.
    let seen = w.fake.last();
    assert_eq!(seen.path, "/v1/images/edits");
    assert_eq!(seen.headers["authorization"], format!("Bearer {KEY}"));
    let form = form_text(&seen);
    assert!(
        form.contains("name=\"background\"\r\n\r\ntransparent"),
        "{form:.600}"
    );
    assert!(form.contains("name=\"model\"\r\n\r\ngpt-image-2.5-sunburst"));
    assert!(form.contains("name=\"safety_identifier\"\r\n\r\noort-"));
    assert!(
        !has(&seen.body, KEY.as_bytes()),
        "the key is only in the header"
    );
    let photo = sent_photo(&seen);
    for gone in [LOCATION, b"Exif".as_slice(), b"TRAILING-BYTES".as_slice()] {
        assert!(
            !has(&photo, gone),
            "{:?} left with the photo",
            String::from_utf8_lossy(gone)
        );
    }
    let leaving = image::load_from_memory(&photo).unwrap();
    assert!(
        leaving.height() == 1024 && leaving.width() == 768,
        "1600x1200, turned a quarter, shrunk: {}x{}",
        leaving.width(),
        leaving.height()
    );
    assert!(
        !has(&seen.body, w.member.actor.member.to_string().as_bytes()),
        "no member id"
    );
    // The draft is the picture the model drew: a corner of its large rendition is background, the
    // middle of it is the subject.
    let large = w
        .http
        .get(format!(
            "{}/expression-drafts/{}/image?size=large&v={}",
            w.prefix,
            draft["draftId"].as_str().unwrap(),
            draft["media"]["large"]["sha256"].as_str().unwrap()
        ))
        .bearer_auth(&w.member.token)
        .send()
        .await
        .unwrap();
    assert_eq!(large.status().as_u16(), 200);
    let large = image::load_from_memory(&large.bytes().await.unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!(large.get_pixel(0, 0).0[3], 0, "the corner is background");
    assert_eq!(
        large.get_pixel(large.width() / 2, large.height() / 2).0,
        [220, 30, 30, 255]
    );
    // It activates like any other draft.
    let active = w.json(w.activate(&w.member, draft).await, 201).await;
    assert_eq!(active["expression"]["origin"]["kind"], "generated");
    assert_eq!(active["expression"]["name"], name);

    // 3. 캐리커처: an opaque picture, no cut-out.
    w.fake.say(Reply::Picture(drawn_caricature()));
    let made = w
        .json(
            w.photo(
                &w.member,
                &w.meta("caricature", &unique("caricature")),
                &photo_from_home(),
            )
            .await,
            201,
        )
        .await;
    assert_eq!(made["cutout"], Value::Null);
    assert_eq!(made["draft"]["origin"]["prompt"], PHOTO_PROMPTS[1].1);
    let form = form_text(&w.fake.last());
    assert!(form.contains("name=\"background\"\r\n\r\nopaque") && form.contains("caricature"));

    // What was recorded: names and numbers, never a key, a prompt, a photo or a place.
    let audit: Vec<String> = sqlx::query_scalar("SELECT detail::text FROM audit_log WHERE workspace_id=$1 AND action='expression.staged' AND detail->>'provider' IS NOT NULL")
        .bind(w.ws)
        .fetch_all(&w.su)
        .await
        .unwrap();
    assert_eq!(audit.len(), 2, "one staged row per photo draft: {audit:?}");
    for row in &audit {
        assert!(
            row.contains("\"provider\": \"openai\"") && row.contains("\"model\""),
            "{row}"
        );
        for never in [KEY, "caricature-style", "GPS", "cut-out", "chat emoji"] {
            assert!(!row.contains(never), "audit row holds {never:?}: {row}");
        }
    }
    // 2. 배경 지우기 with a model that cannot be asked for transparency: it is asked for one flat
    //    colour, and the server erases it from the edges in.
    let w2 = boot_with(Duration::from_secs(20), |mut config| {
        config.openai_model = "gpt-image-2".into();
        config
    })
    .await;
    w2.connect_fake().await;
    w2.fake.say(Reply::Picture(drawn_on_green()));
    let made = w2
        .json(
            w2.photo(
                &w2.member,
                &w2.meta("cutout", &unique("erased")),
                &photo_from_home(),
            )
            .await,
            201,
        )
        .await;
    assert_eq!(made["cutout"], "erased");
    let form = form_text(&w2.fake.last());
    assert!(
        !form.contains("name=\"background\""),
        "no transparency is claimed for gpt-image-2"
    );
    assert!(
        form.contains("flat bright green"),
        "so it is asked for a flat colour"
    );

    // And what the process logged while all of it ran: nothing secret.
    let logged = logs.text();
    assert!(
        !logged.is_empty(),
        "the capture works (the guard logged something)"
    );
    for never in [
        KEY,
        "GPS-37",
        "TRAILING-BYTES",
        "chat emoji",
        "caricature-style",
    ] {
        assert!(!logged.contains(never), "the logs hold {never:?}");
    }
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn no_image_model_connected_says_so_and_sends_nothing() {
    let w = boot().await;
    w.fake.say(Reply::Picture(drawn_caricature()));
    let asked = |w: &World| (w.meta("caricature", &unique("none")), photo_from_home());
    // No link at all, and an environment trio that is a placeholder.
    let nothing = w.json(w.model(&w.member).await, 200).await;
    assert_eq!(
        (nothing["available"].clone(), nothing["provider"].clone()),
        (json!(false), Value::Null)
    );
    assert_eq!(
        nothing["branches"],
        json!(["cutout", "caricature"]),
        "the form still shows the two ways"
    );
    let (meta, photo) = asked(&w);
    assert_eq!(
        w.code(w.photo(&w.member, &meta, &photo).await, 409).await,
        "image_model_unavailable"
    );
    // A key that is not an image provider's: an Anthropic key, a gateway on another host, a mock mode.
    for (base, credential, mode) in [
        (
            "http://api.anthropic.invalid/v1",
            momo_settings::LinkCredential::AnthropicKey(KEY.into()),
            "external-hermes",
        ),
        (
            "https://openrouter.ai/api/v1",
            momo_settings::LinkCredential::Bearer(KEY.into()),
            "external-hermes",
        ),
        (
            "http://127.0.0.1:1/v1",
            momo_settings::LinkCredential::Bearer(KEY.into()),
            "external-hermes",
        ),
    ] {
        w.connect(base, credential, mode).await;
        let said = w.json(w.model(&w.member).await, 200).await;
        assert_eq!(said["available"], false, "{base}");
        let (meta, photo) = asked(&w);
        assert_eq!(
            w.code(w.photo(&w.member, &meta, &photo).await, 409).await,
            "image_model_unavailable",
            "{base}"
        );
    }
    w.connect(
        &format!("http://{}/v1", w.fake.authority),
        momo_settings::LinkCredential::Bearer(KEY.into()),
        "internal-host-mock",
    )
    .await;
    assert_eq!(
        w.json(w.model(&w.member).await, 200).await["available"],
        false,
        "a mock mode is not a provider"
    );
    // A key the provider itself refuses is the same guidance: connect a model that works.
    w.connect_fake().await;
    w.fake.say(Reply::Status(401, ""));
    let (meta, photo) = asked(&w);
    assert_eq!(
        w.code(w.photo(&w.member, &meta, &photo).await, 409).await,
        "image_model_unavailable"
    );
    assert_eq!(w.drafts_of(&w.member).await, 0, "nothing was stored");
    // Only the one refused request reached the provider; the unconnected ones sent nothing.
    assert_eq!(w.fake.count(), 1);
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn authority_comes_before_the_body_and_before_the_call() {
    let w = boot().await;
    w.connect_fake().await;
    w.fake.say(Reply::Picture(drawn_caricature()));
    let meta = w.meta("caricature", &unique("auth"));
    let photo = photo_from_home();
    // A guest and an agent are refused before a byte of the body is read: even a body that is not
    // a form at all gets 403, not 400.
    let junk = w
        .http
        .post(format!("{}/expressions/photo-drafts", w.prefix))
        .bearer_auth(&w.guest.token)
        .header("content-type", "multipart/form-data; boundary=x")
        .body(vec![0u8; 5_500_000])
        .send()
        .await
        .unwrap();
    assert_eq!(w.code(junk, 403).await, "expression_role_required");
    assert_eq!(
        w.code(w.photo(&w.guest, &meta, &photo).await, 403).await,
        "expression_role_required"
    );
    let agent = w
        .http
        .post(format!("{}/expressions/photo-drafts", w.prefix))
        .bearer_auth(&w.agent_token)
        .json(&meta)
        .send()
        .await
        .unwrap();
    assert!(
        agent.status().as_u16() == 403 || agent.status().as_u16() == 404,
        "{}",
        agent.status()
    );
    // No token, and another workspace's token on this workspace's path.
    let anonymous = w
        .http
        .post(format!("{}/expressions/photo-drafts", w.prefix))
        .json(&meta)
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status().as_u16(), 401);
    assert_eq!(
        w.code(w.photo(&w.foreign, &meta, &photo).await, 404).await,
        "not_found"
    );
    // The availability read is authorised the same way.
    assert_eq!(
        w.model(&w.guest).await.status().as_u16(),
        200,
        "a guest may ask whether a model exists"
    );
    let foreign_read = w
        .http
        .get(format!("{}/expressions/photo-model", w.prefix))
        .bearer_auth(&w.foreign.token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_read.status().as_u16(), 404);
    // Admins-only: a member is refused, the owner is not.
    e::set_policy(&w.api, w.owner.actor, "admins".into())
        .await
        .unwrap();
    assert_eq!(
        w.code(w.photo(&w.member, &meta, &photo).await, 403).await,
        "expression_role_required"
    );
    // The live-draft limit is proved before the team pays: four drafts, the fifth is refused.
    e::set_policy(&w.api, w.owner.actor, "members".into())
        .await
        .unwrap();
    for _ in 0..4 {
        let made = w
            .photo(&w.member, &w.meta("caricature", &unique("fill")), &photo)
            .await;
        w.json(made, 201).await;
    }
    w.fake.forget();
    assert_eq!(
        w.code(
            w.photo(&w.member, &w.meta("caricature", &unique("over")), &photo)
                .await,
            409
        )
        .await,
        "expression_quota"
    );
    assert_eq!(
        w.fake.count(),
        0,
        "nothing was sent for a person who has no room for the result"
    );
    w.clear_drafts().await;
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn consent_is_to_the_company_the_key_reaches_now_and_the_request_is_closed() {
    let w = boot().await;
    w.connect_fake().await;
    w.fake.say(Reply::Picture(drawn_caricature()));
    let photo = photo_from_home();
    let base = w.meta("caricature", &unique("consent"));
    // The member agreed to Gemini; the key reaches OpenAI: nothing is sent.
    let mut meta = base.clone();
    meta["acknowledgedProvider"] = json!("gemini");
    assert_eq!(
        w.code(w.photo(&w.member, &meta, &photo).await, 409).await,
        "image_model_changed"
    );
    // No such company, no such branch, a missing consent, an unknown field, a bad name.
    for (field, value) in [
        ("acknowledgedProvider", json!("anthropic")),
        ("branch", json!("watercolour")),
        ("name", json!("A")),
        ("name", json!("grinning")),
    ] {
        let mut meta = base.clone();
        meta[field] = value;
        let status = w.photo(&w.member, &meta, &photo).await.status().as_u16();
        assert!(status == 400 || status == 409, "{field}: {status}");
    }
    let mut missing = base.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("acknowledgedProvider");
    assert_eq!(
        w.code(w.photo(&w.member, &missing, &photo).await, 400)
            .await,
        "expression_invalid"
    );
    let mut unknown = base.clone();
    unknown["prompt"] = json!("draw anything I say");
    assert_eq!(
        w.code(w.photo(&w.member, &unknown, &photo).await, 400)
            .await,
        "expression_invalid"
    );
    // Not a picture: refused before the provider hears of it.
    let html = b"<html><script>alert(1)</script></html>".to_vec();
    assert_eq!(
        w.code(w.photo(&w.member, &base, &html).await, 415).await,
        "expression_media_invalid"
    );
    assert_eq!(w.fake.count(), 0, "none of these cost the team a call");
    assert_eq!(w.drafts_of(&w.member).await, 0);
    // The photo over 5 MiB is refused as media, not as a server error.
    let big = vec![0u8; 5 * 1024 * 1024 + 1];
    assert_eq!(w.photo(&w.member, &base, &big).await.status().as_u16(), 413);
    assert_eq!(w.fake.count(), 0);
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn only_the_callers_own_photo_is_used_across_members_and_tenants() {
    let w = boot().await;
    w.connect_fake().await;
    w.fake.say(Reply::Picture(drawn_caricature()));
    let photo = photo_from_home();
    let attachment = w.attach(&w.owner, w.channel, &photo).await;
    let meta = |name: &str| w.meta("caricature", &unique(name));
    // The owner's own photo, in a conversation the owner is in: drawn, and what leaves is clean.
    let made = w
        .json(
            w.photo_of_attachment(&w.owner, &meta("own"), attachment, w.channel)
                .await,
            201,
        )
        .await;
    assert_eq!(made["draft"]["state"], "ready");
    let seen = w.fake.last();
    assert!(!has(&sent_photo(&seen), LOCATION));
    // Someone else's photo is a 404, whoever asks and wherever they are: another member of the same
    // channel, a member who is not in the channel, an owner of another workspace.
    let refused = [
        (
            "a member of the same channel",
            w.photo_of_attachment(&w.member, &meta("m"), attachment, w.channel)
                .await,
        ),
        (
            "a member who is not in it",
            w.photo_of_attachment(&w.other_member, &meta("o"), attachment, w.channel)
                .await,
        ),
        (
            "another workspace's owner",
            w.photo_of_attachment(&w.foreign, &meta("f"), attachment, w.channel)
                .await,
        ),
        (
            "an attachment that does not exist",
            w.photo_of_attachment(&w.owner, &meta("x"), Uuid::new_v4(), w.channel)
                .await,
        ),
        (
            "a channel that does not exist",
            w.photo_of_attachment(&w.owner, &meta("y"), attachment, Uuid::new_v4())
                .await,
        ),
    ];
    for (who, response) in refused {
        assert_eq!(w.code(response, 404).await, "not_found", "{who}");
    }
    assert_eq!(w.fake.count(), 0, "none of them reached the provider");
    // The same rule through the database: the photo's own row says whose it is and where.
    let (uploader, message): (Uuid, Option<Uuid>) =
        sqlx::query_as("SELECT uploader_member_id, message_id FROM attachment WHERE id=$1")
            .bind(attachment)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(uploader, w.owner.actor.member);
    // A deleted message takes its photo out of reach.
    sqlx::query(
        "UPDATE message SET state='deleted', deleted_at=now() WHERE workspace_id=$1 AND id=$2",
    )
    .bind(w.ws)
    .bind(message.unwrap())
    .execute(&w.su)
    .await
    .unwrap();
    assert_eq!(
        w.code(
            w.photo_of_attachment(&w.owner, &meta("gone"), attachment, w.channel)
                .await,
            404
        )
        .await,
        "not_found"
    );
    // A face means its owner registers it: someone else's member id is refused, the caller's own is not.
    let mut face = w.meta("caricature", &unique("face"));
    face["subjectMemberId"] = json!(w.other_member.actor.member);
    assert_eq!(
        w.code(w.photo(&w.member, &face, &photo).await, 403).await,
        "expression_role_required"
    );
    assert_eq!(w.fake.count(), 0);
    face["subjectMemberId"] = json!(w.member.actor.member);
    w.json(w.photo(&w.member, &face, &photo).await, 201).await;
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_busy_decoder_is_a_503_before_anything_is_sent() {
    let w = boot().await;
    w.connect_fake().await;
    w.fake.say(Reply::Picture(drawn_caricature()));
    // The server runs in this process, so its two decoder slots are these two: hold both.
    let slots = momo_expressions::media::decoder_slots();
    let first = slots.clone().acquire_owned().await.unwrap();
    let second = slots.clone().acquire_owned().await.unwrap();
    let busy = w
        .photo(
            &w.member,
            &w.meta("caricature", &unique("busy")),
            &photo_from_home(),
        )
        .await;
    assert_eq!(
        busy.status().as_u16(),
        503,
        "a busy decoder is the server's state, not the photo's"
    );
    assert!(busy.headers().contains_key("retry-after"));
    assert_eq!(w.fake.count(), 0, "nothing was sent, nothing was spent");
    assert_eq!(w.drafts_of(&w.member).await, 0);
    drop((first, second));
    // The slot the refused request held is back: the same request now goes through.
    w.json(
        w.photo(
            &w.member,
            &w.meta("caricature", &unique("free")),
            &photo_from_home(),
        )
        .await,
        201,
    )
    .await;
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn every_failure_of_the_outside_world_is_one_closed_code_and_stores_nothing() {
    let w = boot_with(Duration::from_millis(600), |config| config).await;
    w.connect_fake().await;
    let logs = Logs::default();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer({
                let logs = logs.clone();
                move || logs.clone()
            })
            .finish(),
    );
    let photo = photo_from_home();
    let huge = vec![b'a'; 13 * 1024 * 1024];
    let not_a_picture = {
        use base64::Engine as _;
        json!({"data":[{"b64_json": base64::engine::general_purpose::STANDARD.encode(b"hello, I am not a picture")}]})
            .to_string()
            .into_bytes()
    };
    let table: Vec<(&str, Reply, u16, &str)> = vec![
        (
            "a server error",
            Reply::Status(500, ""),
            502,
            "image_model_failed",
        ),
        (
            "a rate limit",
            Reply::Status(429, "slow down"),
            502,
            "image_model_failed",
        ),
        (
            "a refused key",
            Reply::Status(401, ""),
            409,
            "image_model_unavailable",
        ),
        (
            "an unverified organisation",
            Reply::Status(403, "must be verified"),
            409,
            "image_model_unavailable",
        ),
        (
            "a declined picture",
            Reply::Status(400, "moderation_blocked"),
            422,
            "image_model_refused",
        ),
        (
            "a slow provider",
            Reply::After(
                Duration::from_millis(1500),
                Box::new(Reply::Picture(drawn_caricature())),
            ),
            504,
            "image_model_timeout",
        ),
        (
            "an answer over the bound",
            Reply::Raw(huge),
            502,
            "image_model_failed",
        ),
        (
            "an answer that is not JSON",
            Reply::Raw(b"<html>bad gateway</html>".to_vec()),
            502,
            "image_model_failed",
        ),
        (
            "a 'picture' that is not one",
            Reply::Raw(not_a_picture),
            502,
            "image_model_failed",
        ),
    ];
    for (what, reply, status, code) in table {
        w.fake.say(reply);
        let response = w
            .photo(&w.member, &w.meta("caricature", &unique("fail")), &photo)
            .await;
        assert_eq!(w.code(response, status).await, code, "{what}");
        assert_eq!(w.drafts_of(&w.member).await, 0, "{what}: nothing stored");
    }
    // The slot came back every time: a good answer now works.
    w.fake.say(Reply::Picture(drawn_caricature()));
    w.json(
        w.photo(&w.member, &w.meta("caricature", &unique("after")), &photo)
            .await,
        201,
    )
    .await;
    // The provider echoed the key into its bodies and headers all along; none of it is in the logs.
    let logged = logs.text();
    for never in [KEY, ECHO, "bad key", "GPS-37", "chat emoji"] {
        assert!(!logged.contains(never), "the logs hold {never:?}");
    }
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_member_has_one_photo_in_flight_and_the_instance_four() {
    let w = boot().await;
    w.connect_fake().await;
    let gate = Arc::new(Semaphore::new(0));
    w.fake.say(Reply::Hold(
        gate.clone(),
        Box::new(Reply::Picture(drawn_caricature())),
    ));
    let photo = photo_from_home();
    let third = seed(&w.su, w.ws, "member", &w.http, &w.base).await;
    let fourth = seed(&w.su, w.ws, "member", &w.http, &w.base).await;
    let fifth = seed(&w.su, w.ws, "member", &w.http, &w.base).await;
    let url = format!("{}/expressions/photo-drafts", w.prefix);
    let mut held = Vec::new();
    let spawn = |person: &Person| {
        let (http, url, token, meta, photo) = (
            w.http.clone(),
            url.clone(),
            person.token.clone(),
            w.meta("caricature", &unique("held")),
            photo.clone(),
        );
        tokio::spawn(async move { send(&http, &url, &token, &meta, &photo).await })
    };
    // One member's photo is out. The instance has three free places, so what refuses the same
    // member's second photo is the member's own limit: busy, with a Retry-After, and the provider
    // hears nothing more.
    held.push(spawn(&w.member));
    wait_for(&w.fake, 1).await;
    let again = w
        .photo(&w.member, &w.meta("caricature", &unique("again")), &photo)
        .await;
    assert_eq!(
        again.status().as_u16(),
        503,
        "one photo in flight per member"
    );
    assert!(again.headers().contains_key("retry-after"));
    assert_eq!(w.fake.count(), 1);
    // Three more people fill the instance's four; a fifth person is busy too.
    for (i, person) in [&w.owner, &third, &fourth].into_iter().enumerate() {
        held.push(spawn(person));
        wait_for(&w.fake, i + 2).await;
    }
    let over = w
        .photo(&fifth, &w.meta("caricature", &unique("over")), &photo)
        .await;
    assert_eq!(
        over.status().as_u16(),
        503,
        "four in flight on the instance"
    );
    assert_eq!(
        w.fake.count(),
        4,
        "neither busy answer reached the provider"
    );
    // Release them: every admitted request ends in a draft, and the slots are back.
    gate.add_permits(10);
    for task in held {
        assert_eq!(task.await.unwrap(), 201);
    }
    w.fake.say(Reply::Picture(drawn_caricature()));
    w.json(
        w.photo(&fifth, &w.meta("caricature", &unique("free")), &photo)
            .await,
        201,
    )
    .await;
}

async fn wait_for(fake: &Fake, n: usize) {
    for _ in 0..200 {
        if fake.count() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the provider was not called {n} times");
}

async fn send(http: &reqwest::Client, url: &str, token: &str, meta: &Value, file: &[u8]) -> u16 {
    let mut body = Vec::new();
    body.extend_from_slice(b"--oort-photo-test\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n");
    body.extend_from_slice(meta.to_string().as_bytes());
    body.extend_from_slice(b"\r\n--oort-photo-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(file);
    body.extend_from_slice(b"\r\n--oort-photo-test--\r\n");
    http.post(url)
        .bearer_auth(token)
        .header(
            "content-type",
            "multipart/form-data; boundary=oort-photo-test",
        )
        .body(body)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}
