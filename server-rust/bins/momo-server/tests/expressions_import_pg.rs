//! #4829 stage 1 — `POST /v1/workspaces/{ws}/expressions/import` (ADR-0218 D5, appendix A/C).
//!
//! Real axum app, real PG18, the NOBYPASSRLS runtime role, two tenants. The outbound
//! transport is a scripted `UnfurlHttp`: the guard's own behaviour (hops, pin, caps,
//! deadlines) is proved against real sockets in `momo-unfurl`; what is proved HERE is
//! everything the route does with what the transport hands back.
//!
//! DATABASE_URL=<dedicated DB> cargo test -p momo-server --test expressions_import_pg \
//!   -- --ignored --test-threads=1
//!
//! Needs the isolated decoder child beside the test binary: `cargo build -p momo-expressions
//! --bins` first (`cargo test -p momo-server` builds no other package's bins). Without it every
//! import ends as a `source_invalid_media` card and six of these tests go red without saying why
//! (#4947); `require_decoder_4947` fails first and names the command.
use async_trait::async_trait;
use momo_db::sqlx::{
    self,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use momo_db::PgPool;
use momo_expressions::{self as e, Actor};
use momo_server::{build_app, config::RealtimeSettings, AppState};
use momo_unfurl::{FetchError, FetchKind, Fetched, UnfurlHttp};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use uuid::Uuid;

const SECRET: &str = "expression-import-conformance-only";
const GRINNING: &str = "grinning"; // a standard short name: reserved for ever
const OPENAPI_PATH: &str = "/v1/workspaces/{ws}/expressions/import";

// ── the scripted outbound transport ─────────────────────────────────────────

enum Reply {
    Body {
        content_type: &'static str,
        bytes: Vec<u8>,
    },
    Err(FetchError),
    /// Answers after a delay (longer than the route's deadline, to prove the outer one).
    After(Duration, Box<Reply>),
    /// Waits for a permit before answering (to hold imports in flight).
    Hold(Arc<Semaphore>, Box<Reply>),
}

type Script = Arc<dyn Fn(&str) -> Reply + Send + Sync>;

struct Mock {
    calls: Mutex<Vec<(String, FetchKind)>>,
    reply: Mutex<Script>,
}

impl Mock {
    fn new() -> Arc<Mock> {
        Arc::new(Mock {
            calls: Mutex::new(Vec::new()),
            reply: Mutex::new(Arc::new(|_| {
                Reply::Err(FetchError::Failed("unscripted".into()))
            })),
        })
    }
    fn set(&self, script: impl Fn(&str) -> Reply + Send + Sync + 'static) {
        *self.reply.lock().unwrap() = Arc::new(script);
    }
    fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.0.clone())
            .collect()
    }
    fn kinds(&self) -> Vec<FetchKind> {
        self.calls.lock().unwrap().iter().map(|c| c.1).collect()
    }
}

fn play(
    url: &str,
    reply: Reply,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Fetched, FetchError>> + Send + '_>> {
    Box::pin(async move {
        match reply {
            Reply::Body {
                content_type,
                bytes,
            } => Ok(Fetched {
                final_url: url.to_string(),
                content_type: content_type.into(),
                body: bytes,
            }),
            Reply::Err(error) => Err(error),
            Reply::After(delay, then) => {
                tokio::time::sleep(delay).await;
                play(url, *then).await
            }
            Reply::Hold(gate, then) => {
                let _permit = gate.acquire().await.expect("gate");
                play(url, *then).await
            }
        }
    })
}

#[async_trait]
impl UnfurlHttp for Mock {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        self.calls.lock().unwrap().push((url.to_string(), kind));
        let script = self.reply.lock().unwrap().clone();
        play(url, script(url)).await
    }
}

// ── fixtures ────────────────────────────────────────────────────────────────

fn png_of(width: u32, height: u32) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(width, height)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    cursor.into_inner()
}
fn png() -> Vec<u8> {
    png_of(8, 6)
}
const TAIL: &[u8] = b"ORIGINAL-TRAILING-BYTES-MUST-NOT-SURVIVE";
/// A PNG with bytes after IEND: a decoder ignores them, a pass-through would serve them.
fn png_with_tail() -> Vec<u8> {
    let mut bytes = png();
    bytes.extend_from_slice(TAIL);
    bytes
}
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
fn gif(frames: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for n in 0..frames {
            encoder
                .encode_frame(image::Frame::from_parts(
                    image::RgbaImage::from_pixel(
                        8,
                        8,
                        image::Rgba([20 + n as u8 * 60, 200, 50, 255]),
                    ),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(80, 1),
                ))
                .unwrap();
        }
    }
    bytes
}
fn mp4() -> Vec<u8> {
    let mut b = vec![0, 0, 0, 0x18];
    b.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2mp41");
    b.extend_from_slice(&[0; 64]);
    b
}
fn webm() -> Vec<u8> {
    let mut b = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f];
    b.extend_from_slice(&[0; 64]);
    b
}
fn heic() -> Vec<u8> {
    let mut b = vec![0, 0, 0, 0x18];
    b.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
    b.extend_from_slice(&[0; 64]);
    b
}
/// A PNG whose header claims 60,000 x 60,000 px.
fn png_bomb() -> Vec<u8> {
    let mut b = png_of(1, 1);
    b[16..20].copy_from_slice(&60_000u32.to_be_bytes());
    b[20..24].copy_from_slice(&60_000u32.to_be_bytes());
    b
}
fn multipart(file: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"--oort-import-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    b.extend_from_slice(file);
    b.extend_from_slice(b"\r\n--oort-import-test--\r\n");
    b
}
/// The direct upload's own body: the metadata part, then the file.
fn multipart_with_metadata(metadata: &Value, file: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(
        format!("--oort-import-test\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{metadata}\r\n").as_bytes(),
    );
    b.extend_from_slice(b"--oort-import-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\nContent-Type: application/octet-stream\r\n\r\n");
    b.extend_from_slice(file);
    b.extend_from_slice(b"\r\n--oort-import-test--\r\n");
    b
}
fn html(body: &str) -> Vec<u8> {
    format!("<!doctype html><html><head><title>{body}</title></head><body></body></html>")
        .into_bytes()
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
    foreign_ws: Uuid,
    owner: Person,
    member: Person,
    other_member: Person,
    guest: Person,
    foreign: Person,
    agent_token: String,
    http: reqwest::Client,
    base: String,
    prefix: String,
    mock: Arc<Mock>,
    _server: tokio::task::JoinHandle<()>,
}

async fn seed(su: &PgPool, ws: Uuid, role: &str, http: &reqwest::Client, base: &str) -> Person {
    let id = Uuid::new_v4();
    let email = format!("{id}@expressions-import.test");
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
    sqlx::query("INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label) VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), ARRAY['messages:write','messages:read']::text[], 'import-pg')")
        .bind(ws)
        .bind(id)
        .bind(&token)
        .execute(su)
        .await
        .unwrap();
    token
}

/// The decoder child (`momo-expression-decoder`) must sit beside this test's target directory,
/// found the way `momo_expressions::media` finds it: the `OORT_EXPRESSION_DECODER` override, else
/// next to the test executable (one level above a `deps` directory). It belongs to
/// `momo-expressions`, so building this test does not build it (#4947, header above). Fail here,
/// first, and name the command: left to the server, a missing decoder is "every picture is
/// invalid media". An explicit override is trusted.
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
         every picture is invalid media and an import ends as a source_invalid_media card"
    );
}

async fn boot() -> World {
    boot_with(true).await
}

/// Which attachment archive the server under test is given.
enum Drive {
    /// The in-memory stub every other test in this file uses.
    Stub,
    /// Nothing configured: every attachment route answers 503 (the gate stack before #4900).
    Unset,
    /// The ADR-0169 local-volume archive in `dir`, with the capability-URL base the operator named
    /// (`same-origin` or an absolute URL), built the way `main` builds it from `DriveSettings`.
    Local {
        dir: std::path::PathBuf,
        base: String,
    },
}

async fn boot_with(unfurl_enabled: bool) -> World {
    boot_on(unfurl_enabled, Drive::Stub).await
}

async fn boot_on(unfurl_enabled: bool, drive: Drive) -> World {
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
    // The runtime role under test is the real one: not a superuser, no BYPASSRLS.
    let (superuser, bypass): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&api)
            .await
            .unwrap();
    assert!(!superuser && !bypass, "momo_app must be a plain role");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock = Mock::new();
    let state = AppState::new(
        api.clone(),
        SECRET.into(),
        "ws://localhost:8000/connection/websocket".to_string(),
    );
    let state = match drive {
        Drive::Stub => state.with_drive(Arc::new(momo_drive::StubDriveArchive::new(&base))),
        Drive::Unset => state,
        Drive::Local {
            dir,
            base: advertised,
        } => {
            let port = listener.local_addr().unwrap().port();
            let local_dir = dir.display().to_string();
            let settings = momo_server::config::DriveSettings {
                backend: "local".into(),
                sa_key_path: None,
                shared_drive_id: None,
                local_dir: Some(local_dir.clone()),
            };
            assert_eq!(settings.boot_error("local"), None, "the archive boots");
            // What `DriveSettings::backend_config` and `local_base` make of
            // `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL`, with the value handed in here instead of read
            // from the process environment (a test does not change that for its neighbours).
            let stub_base_url = format!("http://127.0.0.1:{port}");
            let advert =
                momo_server::DriveLocalBase::from_env_value(Some(&advertised), &stub_base_url);
            let local_base_url = match &advert {
                momo_server::DriveLocalBase::SameOrigin => stub_base_url.clone(),
                momo_server::DriveLocalBase::Fixed(url) => url.clone(),
            };
            let archive = momo_drive::build_archive(&momo_drive::DriveBackendConfig {
                mode: "local".into(),
                sa_key_path: None,
                shared_drive_id: None,
                stub_base_url,
                local_dir: Some(local_dir),
                local_base_url,
            })
            .await;
            state.with_drive(archive).with_drive_local_base(advert)
        }
    };
    let state = state
        .with_unfurl_http(mock.clone())
        // The instance's outgoing-request switch is on for this suite (default off, ADR-0170 D3).
        .with_unfurl_enabled(unfurl_enabled)
        .with_realtime(RealtimeSettings {
            cent_token_hmac: Some(SECRET.into()),
            cent_proxy_secret: Some(SECRET.into()),
            connection_token_ttl_seconds: 300,
        });
    let server = tokio::spawn(async move {
        axum::serve(listener, build_app(state)).await.unwrap();
    });
    let http = reqwest::Client::new();
    let ws = workspace(&su).await;
    let foreign_ws = workspace(&su).await;
    let owner = seed(&su, ws, "owner", &http, &base).await;
    let member = seed(&su, ws, "member", &http, &base).await;
    let other_member = seed(&su, ws, "member", &http, &base).await;
    let guest = seed(&su, ws, "guest", &http, &base).await;
    let foreign = seed(&su, foreign_ws, "owner", &http, &base).await;
    let agent_token = agent_bearer(&su, ws).await;
    World {
        prefix: format!("{base}/v1/workspaces/{ws}"),
        su,
        api,
        ws,
        foreign_ws,
        owner,
        member,
        other_member,
        guest,
        foreign,
        agent_token,
        http,
        base,
        mock,
        _server: server,
    }
}

fn request(name: &str, url: &str) -> Value {
    json!({"name":name,"displayName":"신나는 춤","tags":["춤"],"subjectMemberId":null,"url":url})
}
fn unique(prefix: &str) -> String {
    format!("{prefix}_{}", &Uuid::new_v4().simple().to_string()[..12])
}

impl World {
    async fn import(&self, who: &Person, body: &Value) -> reqwest::Response {
        self.http
            .post(format!("{}/expressions/import", self.prefix))
            .bearer_auth(&who.token)
            .json(body)
            .send()
            .await
            .unwrap()
    }
    async fn json(&self, response: reqwest::Response, status: u16) -> Value {
        let got = response.status().as_u16();
        let text = response.text().await.unwrap();
        assert_eq!(got, status, "body: {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }
    async fn code_of(&self, response: reqwest::Response, status: u16) -> String {
        let body = self.json(response, status).await;
        body["error"]["code"].as_str().unwrap_or("").to_string()
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
    async fn clear_drafts(&self, who: &Person) {
        sqlx::query("DELETE FROM expression_draft WHERE workspace_id=$1 AND creator=$2")
            .bind(who.actor.workspace)
            .bind(who.actor.member)
            .execute(&self.su)
            .await
            .unwrap();
    }
    async fn get_draft(&self, who: &Person, id: &str) -> reqwest::Response {
        self.http
            .get(format!("{}/expression-drafts/{id}", self.prefix))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap()
    }
    async fn activate(&self, who: &Person, choice: &Value) -> reqwest::Response {
        self.http
            .post(format!("{}/expressions", self.prefix))
            .bearer_auth(&who.token)
            .json(choice)
            .send()
            .await
            .unwrap()
    }
    /// `POST …/expressions/uploads`: a picture of the person's own, no link involved.
    async fn upload_new(&self, who: &Person, name: &str, file: &[u8]) -> reqwest::Response {
        let metadata =
            json!({"name":name,"displayName":"신나는 춤","tags":["춤"],"subjectMemberId":null});
        self.http
            .post(format!("{}/expressions/uploads", self.prefix))
            .bearer_auth(&who.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-import-test",
            )
            .body(multipart_with_metadata(&metadata, file))
            .send()
            .await
            .unwrap()
    }
    async fn upload_over(&self, who: &Person, draft: &str, file: &[u8]) -> reqwest::Response {
        self.http
            .put(format!("{}/expression-drafts/{draft}/file", self.prefix))
            .bearer_auth(&who.token)
            .header(
                "content-type",
                "multipart/form-data; boundary=oort-import-test",
            )
            .body(multipart(file))
            .send()
            .await
            .unwrap()
    }
}

fn choice(draft: &Value) -> Value {
    json!({"draftId":draft["draftId"],"revision":draft["revision"],"sha256":draft["media"]["large"]["sha256"]})
}

/// `OORT_EXPRESSION_IMPORT_SAMPLES=<dir>` leaves the live responses next to a manifest
/// `scripts/openapi_shape_check.py` can validate against docs/api/openapi.yaml.
fn export_sample(name: &str, status: u16, body: &Value) {
    let Some(dir) =
        std::env::var_os("OORT_EXPRESSION_IMPORT_SAMPLES").map(std::path::PathBuf::from)
    else {
        return;
    };
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{name}.json"));
    std::fs::write(&file, serde_json::to_vec_pretty(body).unwrap()).unwrap();
    let manifest_path = dir.join("manifest.json");
    let mut manifest: Value = std::fs::read(&manifest_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({"samples": []}));
    let samples = manifest["samples"].as_array_mut().unwrap();
    samples.retain(|s| s["name"] != name);
    samples.push(json!({"name":name,"method":"post","path":OPENAPI_PATH,"status":status.to_string(),"body_file":file}));
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

async fn text_of(su: &PgPool, sql: &str, ws: Uuid) -> String {
    sqlx::query_scalar::<_, Option<String>>(sql)
        .bind(ws)
        .fetch_one(su)
        .await
        .unwrap()
        .unwrap_or_default()
}

// ── tests ───────────────────────────────────────────────────────────────────

/// A link that gives a picture: staged, previewable, activatable, and the link's query
/// never reaches the database, a card, the audit trail or the outbox.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_public_picture_link_becomes_a_ready_draft_and_activates_without_its_query() {
    let w = boot().await;
    w.mock.set(|_| Reply::Body {
        content_type: "image/png",
        bytes: png_with_tail(),
    });
    let name = unique("link_png");
    let link = "https://CDN.Example.test/media/party.png?token=SECRET-QUERY-1&sig=SECRET-QUERY-2";
    let draft = w
        .json(w.import(&w.member, &request(&name, link)).await, 201)
        .await;
    export_sample("import-ready", 201, &draft);
    assert_eq!(draft["state"], "ready");
    assert_eq!(draft["code"], Value::Null);
    assert_eq!(draft["revision"], "1");
    assert_eq!(draft["name"], name.as_str());
    assert_eq!(
        draft["origin"],
        json!({"kind":"url","sourceUrl":"https://cdn.example.test/media/party.png","prompt":null}),
        "host lowercased, query gone"
    );
    for variant in ["small", "large", "thumb"] {
        assert_eq!(draft["media"][variant]["mime"], "image/png", "{variant}");
    }
    assert!(
        !draft.to_string().contains("SECRET-QUERY"),
        "the card never shows the query"
    );
    // The transport got the query it needs to fetch, as an image fetch.
    assert_eq!(
        w.mock.calls(),
        ["https://cdn.example.test/media/party.png?token=SECRET-QUERY-1&sig=SECRET-QUERY-2"]
    );
    assert_eq!(w.mock.kinds(), [FetchKind::Source]);

    // The draft is the submitter's alone.
    let id = draft["draftId"].as_str().unwrap();
    assert_eq!(w.get_draft(&w.other_member, id).await.status(), 404);
    assert_eq!(w.get_draft(&w.owner, id).await.status(), 404);
    let again = w.json(w.get_draft(&w.member, id).await, 200).await;
    assert_eq!(again["origin"], draft["origin"]);

    // The stored picture is the re-encoded one, served pinned and uncached.
    let large = draft["media"]["large"]["sha256"].as_str().unwrap();
    let image = w
        .http
        .get(format!(
            "{}/expression-drafts/{id}/image?size=large&v={large}",
            w.prefix
        ))
        .bearer_auth(&w.member.token)
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(image.headers()["cache-control"], "private, no-store");
    assert_eq!(image.headers()["x-content-type-options"], "nosniff");
    let bytes = image.bytes().await.unwrap();
    assert!(
        contains(&png_with_tail(), TAIL),
        "the fixture does carry the marker"
    );
    assert!(
        !contains(&bytes, TAIL),
        "the stored picture is re-encoded from pixels: the original's trailing bytes never reach a viewer"
    );

    // Activation is the existing path, and the origin survives into the registry.
    let registered = w
        .json(w.activate(&w.member, &choice(&draft)).await, 201)
        .await;
    assert_eq!(
        registered["expression"]["origin"],
        json!({"kind":"url","sourceUrl":"https://cdn.example.test/media/party.png","prompt":null})
    );
    let list = w
        .json(
            w.http
                .get(format!("{}/expressions", w.prefix))
                .bearer_auth(&w.other_member.token)
                .send()
                .await
                .unwrap(),
            200,
        )
        .await;
    assert!(list["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == name.as_str() && item["origin"]["kind"] == "url"));

    // No query anywhere it could be remembered: draft, expression, audit, outbox.
    for (what, sql) in [
        ("expression_draft", "SELECT string_agg(to_jsonb(t)::text, ' ') FROM expression_draft t WHERE workspace_id=$1"),
        ("expression", "SELECT string_agg(to_jsonb(t)::text, ' ') FROM expression t WHERE workspace_id=$1"),
        ("audit_log", "SELECT string_agg(to_jsonb(t)::text, ' ') FROM audit_log t WHERE workspace_id=$1"),
        ("outbox", "SELECT string_agg(to_jsonb(t)::text, ' ') FROM outbox t WHERE workspace_id=$1"),
    ] {
        let dump = text_of(&w.su, sql, w.ws).await;
        // A scan of an empty table proves nothing: each one must hold this flow's rows.
        assert!(
            dump.len() > 50,
            "{what} must have rows for the scan below to mean anything"
        );
        assert!(
            !dump.contains("SECRET-QUERY") && !dump.contains("token=") && !dump.contains("sig="),
            "{what} must not remember the link's query"
        );
    }
}

/// The format is decided by the bytes: a PNG that the server calls `text/html` is
/// still a picture, an HTML page that calls itself `image/png` is not.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn the_bytes_decide_the_format_not_the_content_type() {
    let w = boot().await;
    w.mock.set(|_| Reply::Body {
        content_type: "text/html; charset=utf-8",
        bytes: png(),
    });
    let ready = w
        .json(
            w.import(
                &w.member,
                &request(&unique("png_as_html"), "https://files.example.test/a"),
            )
            .await,
            201,
        )
        .await;
    assert_eq!(
        ready["state"], "ready",
        "a real PNG is a picture whatever it was called"
    );

    w.mock.set(|_| Reply::Body {
        content_type: "image/png",
        bytes: html("not a picture"),
    });
    let page = w
        .json(
            w.import(
                &w.member,
                &request(&unique("html_as_png"), "https://files.example.test/b.png"),
            )
            .await,
            200,
        )
        .await;
    assert_eq!(page["state"], "manual_upload_required");
    assert_eq!(
        page["code"], "source_unsupported",
        "an HTML page labelled image/png"
    );
}

#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn an_animated_gif_link_keeps_its_frames() {
    let w = boot().await;
    w.mock.set(|_| Reply::Body {
        content_type: "image/gif",
        bytes: gif(3),
    });
    let draft = w
        .json(
            w.import(
                &w.member,
                &request(
                    &unique("link_gif"),
                    "https://media.giphy.example.test/dance.gif",
                ),
            )
            .await,
            201,
        )
        .await;
    assert_eq!(draft["media"]["large"]["mime"], "image/gif");
    assert_eq!(draft["media"]["large"]["frameCount"], 3);
    assert_eq!(draft["media"]["small"]["mime"], "image/gif");
    assert_eq!(
        draft["media"]["thumb"]["mime"], "image/png",
        "the thumb is the first composed scene"
    );
}

/// Every way a fetch can end without a picture is a 200 manual card with a fixed code
/// that keeps the safe source link, cannot be approved, and is finished by uploading.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn every_failure_is_a_manual_card_with_a_fixed_code_that_an_upload_can_finish() {
    let w = boot().await;
    type Case = (
        &'static str,
        Box<dyn Fn() -> Reply + Send + Sync>,
        &'static str,
    );
    let cases: Vec<Case> = vec![
        (
            "guard refused (private answer / hop)",
            Box::new(|| Reply::Err(FetchError::Blocked)),
            "source_blocked",
        ),
        (
            "too many redirects",
            Box::new(|| Reply::Err(FetchError::TooManyRedirects)),
            "source_blocked",
        ),
        (
            "HTTP 404",
            Box::new(|| Reply::Err(FetchError::Failed("HTTP 404".into()))),
            "source_unavailable",
        ),
        (
            "HTTP 429",
            Box::new(|| Reply::Err(FetchError::Failed("HTTP 429".into()))),
            "source_unavailable",
        ),
        (
            "dns failure",
            Box::new(|| Reply::Err(FetchError::Failed("dns".into()))),
            "source_unavailable",
        ),
        (
            "transport text that names the link",
            Box::new(|| {
                Reply::Err(FetchError::Failed("error sending request for url (https://files.example.test/a.png?token=SECRET-QUERY-9)".into()))
            }),
            "source_unavailable",
        ),
        (
            "transport says too large",
            Box::new(|| Reply::Err(FetchError::TooLarge)),
            "source_too_large",
        ),
        (
            "careless transport hands back 5 MiB + 1",
            Box::new(|| Reply::Body {
                content_type: "image/png",
                bytes: vec![0; 5 * 1024 * 1024 + 1],
            }),
            "source_too_large",
        ),
        (
            "transport hop timeout",
            Box::new(|| Reply::Err(FetchError::Timeout)),
            "source_timeout",
        ),
        (
            "html page",
            Box::new(|| Reply::Body {
                content_type: "text/html",
                bytes: html("giphy"),
            }),
            "source_unsupported",
        ),
        (
            "svg",
            Box::new(|| Reply::Body {
                content_type: "image/svg+xml",
                bytes: b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"
                    .to_vec(),
            }),
            "source_unsupported",
        ),
        (
            "empty body",
            Box::new(|| Reply::Body {
                content_type: "image/png",
                bytes: Vec::new(),
            }),
            "source_unsupported",
        ),
        (
            "javascript",
            Box::new(|| Reply::Body {
                content_type: "image/gif",
                bytes: b"alert(document.cookie)".to_vec(),
            }),
            "source_unsupported",
        ),
        (
            "heic",
            Box::new(|| Reply::Body {
                content_type: "image/heic",
                bytes: heic(),
            }),
            "source_unsupported",
        ),
        (
            "png magic then garbage",
            Box::new(|| Reply::Body {
                content_type: "image/png",
                bytes: [b"\x89PNG\r\n\x1a\n".as_slice(), &[7; 200]].concat(),
            }),
            "source_invalid_media",
        ),
        (
            "truncated png",
            Box::new(|| {
                let mut b = png_of(64, 64);
                b.truncate(b.len() / 2);
                Reply::Body {
                    content_type: "image/png",
                    bytes: b,
                }
            }),
            "source_invalid_media",
        ),
        (
            "60000 x 60000 px header",
            Box::new(|| Reply::Body {
                content_type: "image/png",
                bytes: png_bomb(),
            }),
            "source_invalid_media",
        ),
        (
            "mp4",
            Box::new(|| Reply::Body {
                content_type: "video/mp4",
                bytes: mp4(),
            }),
            "video_processing_unavailable",
        ),
        (
            "webm",
            Box::new(|| Reply::Body {
                content_type: "video/webm",
                bytes: webm(),
            }),
            "video_processing_unavailable",
        ),
    ];
    let mut seen_codes = std::collections::BTreeSet::new();
    let mut sampled = false;
    for (label, reply, code) in cases {
        w.clear_drafts(&w.member).await;
        w.mock.set(move |_| reply());
        let link = "https://files.example.test/path/a.png?token=SECRET-QUERY-9";
        let draft = w
            .json(
                w.import(&w.member, &request(&unique("fail"), link)).await,
                200,
            )
            .await;
        assert_eq!(draft["state"], "manual_upload_required", "{label}");
        assert_eq!(draft["code"], code, "{label}");
        assert_eq!(
            draft["media"],
            Value::Null,
            "{label}: no picture, so nothing to approve"
        );
        assert_eq!(
            draft["origin"],
            json!({"kind":"url","sourceUrl":"https://files.example.test/path/a.png","prompt":null}),
            "{label}: the safe source link is kept"
        );
        assert!(
            !draft.to_string().contains("SECRET-QUERY"),
            "{label}: nothing the transport said leaks"
        );
        seen_codes.insert(code);
        if !sampled {
            export_sample("import-manual", 200, &draft);
            sampled = true;
        }
        // The reason is recorded on the row, in the column the database constrains.
        let id = Uuid::parse_str(draft["draftId"].as_str().unwrap()).unwrap();
        let (state, stored): (String, Option<String>) = sqlx::query_as(
            "SELECT state, code FROM expression_draft WHERE workspace_id=$1 AND id=$2",
        )
        .bind(w.ws)
        .bind(id)
        .fetch_one(&w.su)
        .await
        .unwrap();
        assert_eq!(
            (state.as_str(), stored.as_deref()),
            ("manual_upload_required", Some(code)),
            "{label}"
        );
        // It cannot be approved: there is no picture to pin.
        let fake = json!({"draftId":draft["draftId"],"revision":"1","sha256":"0".repeat(64)});
        let refused = w.activate(&w.member, &fake).await;
        assert_eq!(
            w.code_of(refused, 409).await,
            "expression_preview_stale",
            "{label}"
        );
        let g = w
            .get_draft(&w.member, draft["draftId"].as_str().unwrap())
            .await;
        assert_eq!(
            w.json(g, 200).await["code"],
            code,
            "{label}: still the same card"
        );
    }
    for code in [
        "source_blocked",
        "source_unavailable",
        "source_too_large",
        "source_unsupported",
        "source_timeout",
        "source_invalid_media",
        "video_processing_unavailable",
    ] {
        assert!(
            seen_codes.contains(code),
            "{code} was never produced through the route"
        );
    }

    // Finish one by uploading: same draft, same source, new revision, a NEW preview to approve.
    w.clear_drafts(&w.member).await;
    w.mock.set(|_| Reply::Err(FetchError::Blocked));
    let manual = w
        .json(
            w.import(
                &w.member,
                &request(&unique("finish"), "https://files.example.test/finish.png"),
            )
            .await,
            200,
        )
        .await;
    let id = manual["draftId"].as_str().unwrap();
    let ready = w
        .json(w.upload_over(&w.member, id, &png()).await, 200)
        .await;
    assert_eq!(ready["draftId"], manual["draftId"]);
    assert_eq!(ready["state"], "ready");
    assert_eq!(ready["revision"], "2");
    assert_eq!(
        ready["origin"], manual["origin"],
        "an upload never launders the source into `upload`"
    );
    let stale = json!({"draftId":ready["draftId"],"revision":"1","sha256":ready["media"]["large"]["sha256"]});
    assert_eq!(
        w.code_of(w.activate(&w.member, &stale).await, 409).await,
        "expression_preview_stale"
    );
    let registered = w
        .json(w.activate(&w.member, &choice(&ready)).await, 201)
        .await;
    assert_eq!(registered["expression"]["origin"], manual["origin"]);
}

/// ADR-0218: private from the start is a 400 with no fetch and no row; so is everything
/// the contract cannot describe.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn private_or_malformed_links_are_a_400_and_nothing_is_fetched_or_stored() {
    let w = boot().await;
    w.mock.set(|_| Reply::Body {
        content_type: "image/png",
        bytes: png(),
    });
    let long = format!("https://example.com/{}", "a".repeat(2100));
    for url in [
        "https://127.0.0.1/x.gif",
        "https://localhost/x.gif",
        "https://[::1]/x.gif",
        "https://169.254.169.254/latest/meta-data/",
        "https://10.0.0.1/x.gif",
        "https://192.168.0.1/x.gif",
        "https://2130706433/x.gif",
        "https://0x7f.1/x.gif",
        "https://[::ffff:127.0.0.1]/x.gif",
        "https://[64:ff9b::a9fe:a9fe]/x.gif",
        "https://[fd00:ec2::254]/x.gif",
        "http://example.com/x.gif",
        "ftp://example.com/x.gif",
        "https://user:pw@example.com/x.gif",
        "https://example.com/x.gif#frag",
        "https://example.com/a b.gif",
        "https://example.com\\@evil.example/x.gif",
        "not a url",
        "",
        long.as_str(),
    ] {
        let response = w.import(&w.member, &request(&unique("bad_url"), url)).await;
        assert_eq!(
            w.code_of(response, 400).await,
            "expression_invalid",
            "{url}"
        );
    }
    assert!(
        w.mock.calls().is_empty(),
        "no refused link was ever fetched"
    );
    assert_eq!(w.drafts_of(&w.member).await, 0, "and none left a row");

    // Body shape: strict, every field required.
    let good = request(&unique("shape"), "https://files.example.test/a.png");
    let mut extra = good.clone();
    extra["extra"] = json!(1);
    let mut no_url = good.clone();
    no_url.as_object_mut().unwrap().remove("url");
    let mut no_subject = good.clone();
    no_subject
        .as_object_mut()
        .unwrap()
        .remove("subjectMemberId");
    let mut shouting = good.clone();
    shouting["name"] = json!("Shouting");
    let mut many_tags = good.clone();
    many_tags["tags"] = json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    let mut markup = good.clone();
    markup["displayName"] = json!("<b>hi</b>");
    let mut non_canonical_subject = good.clone();
    non_canonical_subject["subjectMemberId"] =
        json!(w.member.actor.member.to_string().to_uppercase());
    for (why, body) in [
        ("unknown field", extra),
        ("missing url", no_url),
        ("missing subjectMemberId", no_subject),
        ("uppercase name", shouting),
        ("nine tags", many_tags),
        ("markup in the display name", markup),
        ("non-canonical subject uuid", non_canonical_subject),
    ] {
        let response = w.import(&w.member, &body).await;
        assert_eq!(
            w.code_of(response, 400).await,
            "expression_invalid",
            "{why}"
        );
    }
    let reserved = request(GRINNING, "https://files.example.test/a.png");
    assert_eq!(
        w.code_of(w.import(&w.member, &reserved).await, 409).await,
        "expression_name_reserved"
    );
    assert!(
        w.mock.calls().is_empty(),
        "bad bodies are refused before any fetch too"
    );
    assert_eq!(w.drafts_of(&w.member).await, 0);
}

/// Who may import, in which tenant, under which policy, for whose face, up to what quota,
/// and in every case before the server makes a request for them.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn authority_tenant_policy_subject_and_quota_are_proved_before_any_fetch() {
    let w = boot().await;
    w.mock.set(|_| Reply::Body {
        content_type: "image/png",
        bytes: png(),
    });
    let url = "https://files.example.test/a.png";

    // No bearer.
    let anonymous = w
        .http
        .post(format!("{}/expressions/import", w.prefix))
        .json(&request(&unique("anon"), url))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    // Guest, agent: refused (guests cannot add; agents only ever PROPOSE through the action).
    assert_eq!(
        w.code_of(
            w.import(&w.guest, &request(&unique("guest"), url)).await,
            403
        )
        .await,
        "expression_role_required"
    );
    let agent = w
        .http
        .post(format!("{}/expressions/import", w.prefix))
        .bearer_auth(&w.agent_token)
        .json(&request(&unique("agent"), url))
        .send()
        .await
        .unwrap();
    assert_eq!(
        agent.status(),
        403,
        "an agent bearer cannot register directly"
    );
    // Another tenant's bearer on this tenant's path is a 404, as for every expression route.
    assert_eq!(
        w.code_of(
            w.import(&w.foreign, &request(&unique("alien"), url)).await,
            404
        )
        .await,
        "not_found"
    );
    assert!(
        w.mock.calls().is_empty(),
        "none of the refusals fetched anything"
    );

    // Admin-only policy: a member is refused, an owner is not.
    e::set_policy(&w.api, w.owner.actor, "admins".into())
        .await
        .unwrap();
    assert_eq!(
        w.code_of(
            w.import(&w.member, &request(&unique("policy"), url)).await,
            403
        )
        .await,
        "expression_role_required"
    );
    assert!(w.mock.calls().is_empty());
    let by_owner = w
        .json(
            w.import(&w.owner, &request(&unique("admin_ok"), url)).await,
            201,
        )
        .await;
    assert_eq!(by_owner["state"], "ready");
    e::set_policy(&w.api, w.owner.actor, "members".into())
        .await
        .unwrap();
    assert_eq!(w.mock.calls().len(), 1);

    // A face is registered by its owner only (D6): another member's id is refused unfetched.
    let before = w.mock.calls().len();
    let mut elsewhere = request(&unique("face_other"), url);
    elsewhere["subjectMemberId"] = json!(w.owner.actor.member.to_string());
    assert_eq!(
        w.code_of(w.import(&w.member, &elsewhere).await, 403).await,
        "expression_role_required"
    );
    assert_eq!(w.mock.calls().len(), before, "refused before the fetch");
    let mut own = request(&unique("face_own"), url);
    own["subjectMemberId"] = json!(w.member.actor.member.to_string());
    let faced = w.json(w.import(&w.member, &own).await, 201).await;
    assert_eq!(faced["subjectMemberId"], w.member.actor.member.to_string());

    // The quota: 4 live drafts per person. The fifth is refused BEFORE it is fetched.
    for n in 0..3 {
        w.json(
            w.import(&w.member, &request(&unique(&format!("quota{n}")), url))
                .await,
            201,
        )
        .await;
    }
    assert_eq!(w.drafts_of(&w.member).await, 4);
    let fetched = w.mock.calls().len();
    let fifth = w.import(&w.member, &request(&unique("quota_x"), url)).await;
    assert_eq!(w.code_of(fifth, 409).await, "expression_quota");
    assert_eq!(
        w.mock.calls().len(),
        fetched,
        "a person at quota cannot make the server fetch"
    );
    // Someone else is unaffected, and the foreign tenant's own import works on its own path.
    w.json(
        w.import(&w.other_member, &request(&unique("other_ok"), url))
            .await,
        201,
    )
    .await;
    let foreign = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/expressions/import",
            w.base, w.foreign_ws
        ))
        .bearer_auth(&w.foreign.token)
        .json(&request(&unique("foreign_ok"), url))
        .send()
        .await
        .unwrap();
    let foreign_draft = w.json(foreign, 201).await;
    // …and that draft is invisible across the tenant line in both directions.
    let id = foreign_draft["draftId"].as_str().unwrap();
    assert_eq!(w.get_draft(&w.owner, id).await.status(), 404);
    let crossed = w
        .http
        .get(format!(
            "{}/v1/workspaces/{}/expression-drafts/{id}",
            w.base, w.foreign_ws
        ))
        .bearer_auth(&w.owner.token)
        .send()
        .await
        .unwrap();
    assert_eq!(crossed.status(), 404);
}

/// Imports in flight are capped; at the cap the next request is a 503 with Retry-After
/// before anything is fetched or written, and the slots come back.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn imports_in_flight_are_capped_and_the_slots_are_returned() {
    let w = Arc::new(boot().await);
    let gate = Arc::new(Semaphore::new(0));
    let hold = gate.clone();
    w.mock.set(move |_| {
        Reply::Hold(
            hold.clone(),
            Box::new(Reply::Body {
                content_type: "image/png",
                bytes: png(),
            }),
        )
    });
    let mut tasks = Vec::new();
    for n in 0..8 {
        let w = w.clone();
        tasks.push(tokio::spawn(async move {
            let who = if n % 2 == 0 { &w.owner } else { &w.member };
            w.import(
                who,
                &request(
                    &unique(&format!("held{n}")),
                    "https://files.example.test/a.png",
                ),
            )
            .await
            .status()
            .as_u16()
        }));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while w.mock.calls().len() < 8 {
        assert!(
            Instant::now() < deadline,
            "eight imports should be in flight"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let refused = w
        .import(
            &w.other_member,
            &request(&unique("ninth"), "https://files.example.test/a.png"),
        )
        .await;
    assert_eq!(refused.status(), 503, "the ninth is refused at the door");
    assert!(refused.headers().contains_key("retry-after"));
    assert_eq!(w.mock.calls().len(), 8, "and was never fetched");
    assert_eq!(w.drafts_of(&w.other_member).await, 0, "nor stored");
    gate.add_permits(8);
    // All eight finish together, but the decoder has two slots and admits without queuing
    // (#4676, by design). A busy decoder is the SERVER's retryable state, never the
    // picture's: the overflow answers 503 with `Retry-After` and writes no draft (planner
    // decision 5, 10-30) instead of a `source_timeout` card. None is lost or mislabelled.
    let (mut ready, mut busy) = (0, 0);
    for task in tasks {
        match task.await.unwrap() {
            201 => ready += 1,
            503 => busy += 1,
            other => panic!("an in-flight import ended as {other}"),
        }
    }
    eprintln!("in-flight burst: ready={ready} busy={busy}");
    assert!(ready >= 1 && ready + busy == 8, "ready={ready} busy={busy}");
    assert!(
        busy >= 1,
        "two decoder slots cannot take eight simultaneous finishes: the overflow must be a 503"
    );
    assert_eq!(
        w.drafts_of(&w.owner).await + w.drafts_of(&w.member).await,
        ready,
        "only the pictures that were decoded left a draft; a busy decoder wrote nothing"
    );
    let cards: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression_draft WHERE workspace_id=$1 AND state='manual_upload_required'",
    )
    .bind(w.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(
        cards, 0,
        "a busy decoder is not a card and not a source_timeout"
    );
    // The slots are back.
    let again = w
        .import(
            &w.other_member,
            &request(&unique("after"), "https://files.example.test/a.png"),
        )
        .await;
    assert_eq!(again.status(), 201, "a finished import gives its slot back");
}

/// The route's own 5 s deadline covers a transport that would keep going.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn one_deadline_turns_a_slow_origin_into_a_timeout_card() {
    let w = boot().await;
    w.mock.set(|_| {
        Reply::After(
            Duration::from_secs(60),
            Box::new(Reply::Body {
                content_type: "image/png",
                bytes: png(),
            }),
        )
    });
    let started = Instant::now();
    let draft = w
        .json(
            w.import(
                &w.member,
                &request(&unique("slow"), "https://slow.example.test/a.png"),
            )
            .await,
            200,
        )
        .await;
    let took = started.elapsed();
    assert_eq!(draft["code"], "source_timeout");
    assert!(
        took >= Duration::from_millis(4500) && took < Duration::from_secs(9),
        "5 s deadline, took {took:?}"
    );
}

// ── no database needed ──────────────────────────────────────────────────────

/// Two crates each know the stored-link shape (the producer in momo-unfurl, the checker
/// where it is stored). They must agree on everything the producer can emit.
#[test]
fn what_the_parser_emits_is_what_the_store_accepts() {
    for raw in [
        "https://media.giphy.com/media/abc/giphy.gif",
        "https://Example.COM/Path/a.GIF?token=SECRET&x=1",
        "https://example.com",
        "https://example.com?x=1",
        "https://example.com:443/x.png",
        "https://例え.jp/猫.gif",
        "https://[2606:4700::1111]/x.gif",
        "https://93.184.216.34/x.gif",
        "https://example.com/a%20b.png",
        "https://example.com/a@b.png",
    ] {
        let parsed = momo_unfurl::parse_source_url(raw).unwrap_or_else(|e| panic!("{raw}: {e:?}"));
        assert!(
            e::valid_source_url(parsed.origin()),
            "{raw} -> {}",
            parsed.origin()
        );
    }
}

/// The reasons the transport side can produce are exactly some of the closed set the
/// draft table and the store accept.
#[test]
fn every_transport_failure_code_is_one_of_the_closed_source_codes() {
    use momo_unfurl::SourceFailure::*;
    for failure in [Blocked, Unavailable, TooLarge, Timeout] {
        assert!(e::SOURCE_CODES.contains(&failure.code()), "{failure:?}");
    }
}

// ── #4829 stage 2: the planner's decisions on the stage-1 route (10-30) ───────────────

/// Decision 2: a name that resolves private at the FIRST hop is a 400 with no row and no card;
/// the same refusal after a redirect is the `source_blocked` card. Decision 4: only port 443.
/// Decision 1: the reason of a failed receive is in the `staged` audit row and survives the
/// TTL sweep that clears the draft's own `code`.
#[tokio::test]
#[ignore = "real PG"]
async fn a_private_first_hop_is_a_400_a_blocked_redirect_is_a_card_and_the_reason_is_audited() {
    let w = boot().await;
    // First hop private (a name that resolves to an inside address): 400, nothing stored.
    w.mock.set(|_| Reply::Err(FetchError::OriginBlocked));
    let before = w.drafts_of(&w.member).await;
    let refused = w
        .import(
            &w.member,
            &request(&unique("inside"), "https://inside.example.test/a.gif"),
        )
        .await;
    assert_eq!(w.code_of(refused, 400).await, "expression_invalid");
    assert_eq!(w.drafts_of(&w.member).await, before, "no draft row");
    // A non-443 port never reaches the transport.
    let calls = w.mock.calls().len();
    let ported = w
        .import(
            &w.member,
            &request(&unique("ported"), "https://files.example.test:8443/a.gif"),
        )
        .await;
    assert_eq!(w.code_of(ported, 400).await, "expression_invalid");
    assert_eq!(
        w.mock.calls().len(),
        calls,
        "a refused port is never fetched"
    );
    // The guard refused AFTER a redirect from a public origin: a manual card.
    w.mock.set(|_| Reply::Err(FetchError::Blocked));
    let card = w
        .json(
            w.import(
                &w.member,
                &request(
                    &unique("hopped"),
                    "https://files.example.test/a.gif?token=Q-SECRET",
                ),
            )
            .await,
            200,
        )
        .await;
    assert_eq!(card["state"], "manual_upload_required");
    assert_eq!(card["code"], "source_blocked");
    let draft = card["draftId"].as_str().unwrap().to_string();
    let staged: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='expression.staged' AND detail->>'draft_id'=$2",
    )
    .bind(w.ws)
    .bind(&draft)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(staged["code"], "source_blocked");
    assert_eq!(staged["origin_kind"], "url");
    assert_eq!(staged["origin_domain"], "files.example.test");
    assert!(!staged.to_string().contains("Q-SECRET"), "{staged}");
    // The TTL sweep clears the row's own reason; the audit row keeps it.
    // `expires_at` is part of the draft's immutable identity: the fixture lifts the trigger
    // for one statement, as the storage suite does.
    let mut clock = w.su.begin().await.unwrap();
    sqlx::query("ALTER TABLE expression_draft DISABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock)
        .await
        .unwrap();
    sqlx::query("UPDATE expression_draft SET expires_at = clock_timestamp() - interval '1 minute' WHERE workspace_id=$1 AND id=$2::uuid")
        .bind(w.ws)
        .bind(&draft)
        .execute(&mut *clock)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE expression_draft ENABLE TRIGGER expression_draft_identity")
        .execute(&mut *clock)
        .await
        .unwrap();
    clock.commit().await.unwrap();
    momo_expressions::sweep_expired(&w.su, &w.api)
        .await
        .unwrap();
    let (state, code): (String, Option<String>) = sqlx::query_as(
        "SELECT state, code FROM expression_draft WHERE workspace_id=$1 AND id=$2::uuid",
    )
    .bind(w.ws)
    .bind(&draft)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!((state.as_str(), code), ("expired", None));
    let kept: String = sqlx::query_scalar(
        "SELECT detail->>'code' FROM audit_log WHERE workspace_id=$1 AND action='expression.staged' AND detail->>'draft_id'=$2",
    )
    .bind(w.ws)
    .bind(&draft)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(
        kept, "source_blocked",
        "the reason outlives the sweep in the audit trail"
    );
}

/// Decision 3: `MOMO_UNFURL_ENABLED` off means this server makes no outbound request for an
/// import; the link is kept on a manual card the person finishes by hand.
#[tokio::test]
#[ignore = "real PG"]
async fn an_instance_with_outgoing_requests_off_never_fetches_an_import() {
    let w = boot_with(false).await;
    w.mock
        .set(|_| Reply::Err(FetchError::Failed("must not be called".into())));
    let card = w
        .json(
            w.import(
                &w.member,
                &request(&unique("off"), "https://files.example.test/a.gif?token=Q"),
            )
            .await,
            200,
        )
        .await;
    assert_eq!(card["state"], "manual_upload_required");
    assert_eq!(card["code"], "source_unavailable");
    assert_eq!(
        card["origin"]["sourceUrl"],
        "https://files.example.test/a.gif"
    );
    assert!(w.mock.calls().is_empty(), "no outbound request was made");
}

/// #4900: both decoder slots taken is the SERVER's retryable state. A person's own upload and a
/// replacement answer it the way the link import does (503 with `Retry-After`, nothing written),
/// never as a 415 that says their picture is the wrong format. A picture that really is the wrong
/// format is still a 415, so the 503 is the busy state and not "every refusal".
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_busy_decoder_is_a_503_for_an_upload_and_a_replacement_never_a_415() {
    let w = boot().await;
    // A draft to replace, made while the decoder is free.
    let draft = w
        .json(w.upload_new(&w.member, &unique("first"), &png()).await, 201)
        .await;
    let id = draft["draftId"].as_str().unwrap().to_string();
    let drafts_before = w.drafts_of(&w.member).await;
    assert_eq!(drafts_before, 1);

    let slots = momo_expressions::media::decoder_slots();
    let held = (
        slots.clone().acquire_owned().await.unwrap(),
        slots.clone().acquire_owned().await.unwrap(),
    );
    // A new upload.
    let busy = w.upload_new(&w.member, &unique("busy"), &png()).await;
    assert_eq!(busy.status(), 503, "an upload met a busy decoder");
    assert_eq!(
        busy.headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok()),
        Some("2"),
        "and is told when to come back"
    );
    let body: Value = busy.json().await.unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("busy")),
        "{body}"
    );
    assert_ne!(body["error"]["code"], "expression_media_invalid", "{body}");
    assert_eq!(
        w.drafts_of(&w.member).await,
        drafts_before,
        "nothing written"
    );
    // A replacement.
    let busy = w.upload_over(&w.member, &id, &png()).await;
    assert_eq!(busy.status(), 503, "a replacement met a busy decoder");
    assert!(busy.headers().contains_key("retry-after"));
    let unchanged = w.json(w.get_draft(&w.member, &id).await, 200).await;
    assert_eq!(
        unchanged["revision"], "1",
        "a refused replacement changed nothing"
    );
    drop(held);

    // The slots are free again: the same two requests go through.
    w.json(w.upload_new(&w.member, &unique("again"), &png()).await, 201)
        .await;
    let replaced = w
        .json(w.upload_over(&w.member, &id, &png()).await, 200)
        .await;
    assert_eq!(replaced["revision"], "2");
    // And a picture that really is the wrong format is still a 415 with the decoder free: the
    // 503 above is the busy state, not "every refusal".
    let wrong = w.upload_new(&w.member, &unique("heic"), &heic()).await;
    assert_eq!(
        w.code_of(wrong, 415).await,
        "expression_media_invalid",
        "a real format problem is still a 415"
    );
}

/// #4900: a video source is a card because of what it IS, decided from its first bytes, so it is a
/// card even when every decoder slot is taken: not a "busy", for something no slot could make.
/// The control in the same breath: a picture meeting the same two taken slots IS busy (503).
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn a_video_is_a_card_even_when_every_decoder_slot_is_taken() {
    let w = boot().await;
    let slots = momo_expressions::media::decoder_slots();
    let held = (
        slots.clone().acquire_owned().await.unwrap(),
        slots.clone().acquire_owned().await.unwrap(),
    );
    // A link whose body is a video: the card, immediately, with the link kept.
    for (what, bytes) in [("mp4", mp4()), ("webm", webm())] {
        w.clear_drafts(&w.member).await;
        w.mock.set(move |_| Reply::Body {
            content_type: "video/mp4",
            bytes: bytes.clone(),
        });
        let started = Instant::now();
        let card = w
            .json(
                w.import(
                    &w.member,
                    &request(&unique("clip"), "https://files.example.test/clip"),
                )
                .await,
                200,
            )
            .await;
        assert_eq!(card["state"], "manual_upload_required", "{what}");
        assert_eq!(card["code"], "video_processing_unavailable", "{what}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{what}: a card is not a wait for a slot: {:?}",
            started.elapsed()
        );
    }
    // The same video as a person's own upload.
    w.clear_drafts(&w.member).await;
    let card = w
        .json(
            w.upload_new(&w.member, &unique("own_clip"), &mp4()).await,
            200,
        )
        .await;
    assert_eq!(card["state"], "manual_upload_required");
    assert_eq!(card["code"], "video_processing_unavailable");
    assert_eq!(card["media"], Value::Null);
    // The control: a picture meets the same two taken slots and IS told to come back.
    let picture = w.upload_new(&w.member, &unique("ctrl_pic"), &png()).await;
    assert_eq!(
        picture.status(),
        503,
        "control: a picture meets the busy decoder"
    );
    drop(held);
    // Replacing a draft's file with a video is not a card and not retryable: 415, as ever.
    let draft = w
        .json(
            w.upload_new(&w.member, &unique("to_replace"), &png()).await,
            201,
        )
        .await;
    let id = draft["draftId"].as_str().unwrap().to_string();
    let held = (
        slots.clone().acquire_owned().await.unwrap(),
        slots.clone().acquire_owned().await.unwrap(),
    );
    let refused = w.upload_over(&w.member, &id, &mp4()).await;
    assert_eq!(
        w.code_of(refused, 415).await,
        "expression_media_invalid",
        "a video cannot replace a picture, and waiting would not help it"
    );
    drop(held);
}

/// Removes its directory when the test ends, pass or fail. The directory is this test's own
/// (a name made from the process and a fresh id under the system temp dir).
struct OwnDir(std::path::PathBuf);
impl Drop for OwnDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run the OpenAPI gate's expression sampler against `w` as `w.member`, in `out`.
async fn run_gate_sampler(w: &World, channel: Uuid, out: &std::path::Path) -> std::process::Output {
    let auth = out.join("auth.conf");
    std::fs::write(
        &auth,
        format!("header = \"Authorization: Bearer {}\"\n", w.member.token),
    )
    .unwrap();
    // Not `std::process::Command`: the server under test runs on this very runtime, and a blocked
    // test thread would be a server that never answers the sampler.
    tokio::process::Command::new("python3")
        .arg("-I")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../scripts/sample_expression_contract.py"
        ))
        .args(["--base-url", &w.base])
        .args(["--workspace", &w.ws.to_string()])
        .args(["--channel", &channel.to_string()])
        .arg("--auth-config")
        .arg(&auth)
        .arg("--out-dir")
        .arg(out.join("samples"))
        .arg("--manifest")
        .arg(out.join("manifest.jsonl"))
        .output()
        .await
        .expect("python3 runs the sampler")
}

async fn channel_of(w: &World) -> Uuid {
    momo_messaging::create_channel(
        &w.api,
        w.ws,
        momo_messaging::NewChannel {
            kind: momo_messaging::ChannelKind::Public,
            name: unique("sampler"),
            topic: None,
            created_by: w.member.actor.member,
        },
    )
    .await
    .expect("a channel the sampler's person belongs to")
    .id
}

/// #4900: the OpenAPI gate's runtime sample (`scripts/sample_expression_contract.py`) runs to its
/// end on the Drive the gate stack is given. The stack's own lines are read out of
/// `scripts/verify_openapi_contract_rust.sh` and turned into the server's configuration the way
/// `main` does it, so changing those lines changes this test. The control is the stack as it was:
/// without a Drive the sample ended at the first attachment, with a 503, and the operations after
/// it were never measured by the gate.
#[tokio::test]
#[ignore = "real PG; security-nightly workspace ignored pass"]
async fn the_gates_expression_sampler_runs_to_its_end_on_the_drive_the_gate_stack_is_given() {
    let gate_script = include_str!("../../../../scripts/verify_openapi_contract_rust.sh");
    let gate_setting = |key: &str| {
        let prefix = format!("{key}=");
        let found: Vec<&str> = gate_script
            .lines()
            .filter_map(|line| line.strip_prefix(prefix.as_str()))
            .collect();
        assert_eq!(found.len(), 1, "the gate's env block sets {key} once");
        found[0].to_string()
    };
    assert_eq!(
        gate_setting("MOMO_DRIVE_ARCHIVE_BACKEND"),
        "local",
        "the gate stack runs the local archive: no credential, allowed in a deployed environment"
    );
    assert!(
        gate_setting("MOMO_DRIVE_LOCAL_DIR").starts_with('/'),
        "a path inside the container"
    );
    let advertised = gate_setting("MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL");

    let work = std::env::temp_dir().join(format!(
        "oort-gate-sampler-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&work).unwrap();
    let _work = OwnDir(work.clone());

    // The gate stack's Drive: the sample goes all the way through.
    let drive_dir = work.join("drive");
    let w = boot_on(
        false,
        Drive::Local {
            dir: drive_dir,
            base: advertised,
        },
    )
    .await;
    let channel = channel_of(&w).await;
    let out = work.join("with-drive");
    std::fs::create_dir_all(&out).unwrap();
    let ran = run_gate_sampler(&w, channel, &out).await;
    let (stdout, stderr) = (
        String::from_utf8_lossy(&ran.stdout).to_string(),
        String::from_utf8_lossy(&ran.stderr).to_string(),
    );
    assert!(
        ran.status.success(),
        "the sampler ran to its end: {stdout} {stderr}"
    );
    assert!(
        stdout.contains("15 live storage operations passed"),
        "every operation was measured: {stdout}"
    );
    // The gate checks the list both ways; this is that check for the expression operations.
    let recorded: std::collections::BTreeSet<String> =
        std::fs::read_to_string(out.join("manifest.jsonl"))
            .unwrap()
            .lines()
            .map(|line| {
                let sample: Value = serde_json::from_str(line).unwrap();
                format!(
                    "{} {}",
                    sample["method"].as_str().unwrap().to_uppercase(),
                    sample["path"].as_str().unwrap()
                )
            })
            .collect();
    let listed: std::collections::BTreeSet<String> =
        include_str!("../../../../scripts/openapi_sampled_on_rust.txt")
            .lines()
            .filter(|line| !line.starts_with('#') && line.contains("/expression"))
            .map(str::to_string)
            .collect();
    assert_eq!(
        recorded, listed,
        "the sampler measures exactly the expression operations the gate lists"
    );

    // The control: the same sampler on a stack with no Drive ends at the first attachment.
    let bare = boot_on(false, Drive::Unset).await;
    let channel = channel_of(&bare).await;
    let out = work.join("without-drive");
    std::fs::create_dir_all(&out).unwrap();
    let ran = run_gate_sampler(&bare, channel, &out).await;
    let stderr = String::from_utf8_lossy(&ran.stderr).to_string();
    assert!(!ran.status.success(), "no Drive, no sample: {stderr}");
    assert!(
        stderr.contains("attachments/uploads expected 201, got 503"),
        "it ends where the gate used to end: {stderr}"
    );
}
