//! #5823 / ADR-0177 증보 2026-11-14 D17·D22 — the copies of a 1:1 conversation that the `message`
//! read policy does not hold by itself, on a real Postgres.
//!
//! Every row of D17's copy table, with what the table says to prove. Reads run as the
//! **NOBYPASSRLS** `momo_app` role through the real router; two workspaces where it matters.
//!
//! | D17 copy row | proof | test |
//! |---|---|---|
//! | 첨부 내용·썸네일 | a file of a message below the floor (GET, HEAD, Range, poster) answers exactly like an id that never existed; the other participant still reads it | `files_below_the_floor_answer_like_an_unknown_id` |
//! | 링크 카드 그림·아이콘 · 링크 카드 목록 | a card of a message below the floor: picture, icon and the card list answer like an unknown id; a card above the floor and the other participant are served | `link_cards_below_the_floor_answer_like_an_unknown_id` |
//! | 반응·고정·받은함 · 안 읽음·멘션 숫자 · 사람의 인증 길(MCP) | right after leaving the projection's unread and mention counts are 0, the inbox list and count hold nothing below the floor, the human MCP read returns nothing below it | `counts_and_lists_hold_nothing_below_the_floor` |
//! | 푸시 | activity on old messages after leaving (reaction, pin, edit, a mention added to an old message) makes no push candidate, no unread inbox frame and no listed inbox item for the leaver; a new message still does (D19) | `activity_on_old_messages_makes_no_push_or_inbox_for_the_leaver` |
//! | 실시간 서버 보관분 | the subscribe proxy turns recovery off for a subscriber with a floor in that channel, and answers everyone else byte for byte as before | `the_subscribe_proxy_turns_recovery_off_for_a_floor_only` |
//! | 팀 AI 읽기 · 팀 기억 | an agent requester reads none of a human 1:1; a human 1:1 is not memory-eligible | `team_ai_and_team_memory_do_not_reach_a_human_one_to_one` |
//! | (r1 M1 · 잠금 차례) | leaving while the room's own schedule is sent now and by the background loop never ends in a deadlock: 30 rounds, every leave 204, no 5xx | `leaving_while_a_schedule_is_sent_never_deadlocks` |
//! | (r1 L1 · 참여 확인 먼저) | a leave sent to a DM the caller is not in answers 404 without waiting on that room's locks | `a_leave_for_someone_elses_dm_takes_no_lock_there` |
//! | (길 전수 표, catalog leg) | every table with a foreign key to `message` and every definer function that reads it has a row | `every_copy_of_message_in_the_catalog_is_classified` |
//!
//! Rows proven elsewhere: reminders and thread follows by row count, pins and reactions lists,
//! history, thread, search and push fetch (`dm_leave_conformance_pg.rs`). The source leg of the
//! inventory is `dm_leave_read_paths.rs`.
//!
//! **Assertions are values with controls.** Every hidden answer is compared with the answer for
//! an id that never existed (status, headers, body), and has a positive control (the same read
//! before leaving, or by the other participant).
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pg18). Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dm_leave_copies_pg -- --ignored --test-threads=1
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_drive::{DriveArchive, StubDriveArchive};
use momo_server::config::{RealtimeSettings, SchedulerSettings};
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::scheduler::{run_tick, TickMemory};
use momo_server::{build_app, AppState};
use momo_unfurl::{FetchError, FetchKind, Fetched, UnfurlHttp};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const JWT_SIGNING: &str = "dm-leave-copies-signing";
const CENT_SIGNING: &str = "dm-leave-copies-cent";
const PROXY_HEADER_VALUE: &str = "dm-leave-copies-proxy";
const LOGIN_WORD: &str = "dm-leave-copies-login";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// Every remote picture and icon is one small PNG; pages are never fetched here.
struct PictureHttp;

#[async_trait::async_trait]
impl UnfurlHttp for PictureHttp {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        match kind {
            FetchKind::Html => Err(FetchError::Failed("no pages in this test".into())),
            _ => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "image/png".into(),
                body: encoded(ImageFormat::Png),
            }),
        }
    }
}

fn encoded(format: ImageFormat) -> Vec<u8> {
    let buffer = ImageBuffer::from_pixel(8, 8, Rgb([20u8, 120, 220]));
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(buffer)
        .write_to(&mut out, format)
        .expect("encode");
    out.into_inner()
}

fn mp4() -> Vec<u8> {
    let mut bytes = b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom".to_vec();
    bytes.extend(std::iter::repeat_n(0u8, 64));
    bytes
}

struct World {
    su: PgPool,
    app: PgPool,
    state: AppState,
    base: String,
    http: reqwest::Client,
}

#[derive(Clone)]
struct Person {
    id: Uuid,
    token: String,
    handle: String,
}

/// One HTTP answer, without the `date` header.
#[derive(Debug, PartialEq, Eq)]
struct Answer {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl Answer {
    async fn of(response: reqwest::Response) -> Answer {
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| name.as_str() != "date")
            .map(|(name, value)| {
                (
                    name.to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let body = response.bytes().await.expect("body").to_vec();
        Answer {
            status,
            headers,
            body,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

impl World {
    async fn new() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind momo-server");
        let address: SocketAddr = listener.local_addr().expect("server address");
        let base = format!("http://{address}");
        let archive: Arc<dyn DriveArchive> = Arc::new(StubDriveArchive::new(&base));
        let state = AppState::new(
            app.clone(),
            JWT_SIGNING.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_drive(archive)
        .with_unfurl_http(Arc::new(PictureHttp))
        .with_realtime(RealtimeSettings {
            cent_token_hmac: Some(CENT_SIGNING.to_string()),
            cent_proxy_secret: Some(PROXY_HEADER_VALUE.to_string()),
            connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
        });
        let router = build_app(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        World {
            su,
            app,
            state,
            base,
            http: reqwest::Client::new(),
        }
    }

    async fn workspace(&self, hint: &str) -> Uuid {
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(workspace)
            .bind(format!("{hint}-{workspace}"))
            .execute(&self.su)
            .await
            .expect("seed workspace");
        workspace
    }

    async fn member_row(&self, workspace: Uuid, kind: &str, label: &str) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let handle = format!("{label}{}", &id.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $4)",
        )
        .bind(id)
        .bind(workspace)
        .bind(kind)
        .bind(&handle)
        .execute(&self.su)
        .await
        .expect("seed member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(workspace)
        .bind(id)
        .execute(&self.su)
        .await
        .expect("seed workspace membership");
        (id, handle)
    }

    async fn human(&self, workspace: Uuid, label: &str) -> Person {
        let (id, handle) = self.member_row(workspace, "human", label).await;
        let email = format!("{id}@dm-leave-copies.test");
        sqlx::query(
            "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
             VALUES ($1, $2, $3, true, momo_password_hash($4))",
        )
        .bind(id)
        .bind(workspace)
        .bind(&email)
        .bind(LOGIN_WORD)
        .execute(&self.su)
        .await
        .expect("seed human auth");
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({ "email": email, "password": LOGIN_WORD, "workspace": workspace }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200, "seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        Person {
            id,
            token: body["accessToken"].as_str().expect("access").to_string(),
            handle,
        }
    }

    async fn channel(&self, workspace: Uuid, kind: &str, members: &[Uuid]) -> Uuid {
        let channel = Uuid::new_v4();
        if kind == "dm" {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, dm_key, created_by) \
                 VALUES ($1, $2, 'dm', $3, $4)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(format!("t5823-{channel}"))
            .bind(members[0])
            .execute(&self.su)
            .await
            .expect("seed dm");
        } else {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
                 VALUES ($1, $2, $3::channel_kind, $4, '', $5)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(kind)
            .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
            .bind(members[0])
            .execute(&self.su)
            .await
            .expect("seed channel");
        }
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(channel)
        .bind(workspace)
        .execute(&self.su)
        .await
        .expect("seed channel_seq");
        for member in members {
            sqlx::query(
                "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
            )
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(&self.su)
            .await
            .expect("seed membership");
        }
        channel
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn send(&self, who: &Person, ws: Uuid, ch: Uuid, body: Value) -> (Uuid, i64) {
        let response = self
            .http
            .post(self.url(&format!("/v1/workspaces/{ws}/channels/{ch}/messages")))
            .bearer_auth(&who.token)
            .json(&body)
            .send()
            .await
            .expect("send");
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(json!({}));
        assert_eq!(status, 201, "send is 201: {body}");
        (
            Uuid::parse_str(body["id"].as_str().expect("id")).expect("uuid"),
            body["seq"].as_i64().expect("seq"),
        )
    }

    async fn say(&self, who: &Person, ws: Uuid, ch: Uuid, text: &str) -> (Uuid, i64) {
        self.send(
            who,
            ws,
            ch,
            json!({ "clientMsgId": Uuid::new_v4(), "body": text }),
        )
        .await
    }

    async fn leave(&self, who: &Person, ws: Uuid, ch: Uuid, seen: i64) {
        let response = self
            .http
            .put(self.url(&format!("/v1/workspaces/{ws}/channels/{ch}/dm-leave")))
            .bearer_auth(&who.token)
            .json(&json!({ "seenSeq": seen }))
            .send()
            .await
            .expect("PUT dm-leave");
        assert_eq!(response.status(), 204, "leave");
    }

    async fn get(&self, bearer: &str, path: &str) -> Answer {
        Answer::of(
            self.http
                .get(self.url(path))
                .bearer_auth(bearer)
                .send()
                .await
                .expect("GET"),
        )
        .await
    }

    async fn request(
        &self,
        bearer: &str,
        method: reqwest::Method,
        path: &str,
        range: Option<&str>,
    ) -> Answer {
        let mut request = self
            .http
            .request(method, self.url(path))
            .bearer_auth(bearer);
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        Answer::of(request.send().await.expect("request")).await
    }

    async fn json(&self, bearer: &str, path: &str) -> Value {
        let answer = self.get(bearer, path).await;
        assert_eq!(answer.status, 200, "{path}: {}", answer.text());
        serde_json::from_slice(&answer.body).expect("json")
    }

    async fn read_row(&self, who: &Person, ws: Uuid, ch: Uuid) -> Value {
        let body = self
            .json(&who.token, &format!("/v1/workspaces/{ws}/read-state"))
            .await;
        body["read_states"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["channel_id"].as_str().map(str::to_lowercase) == Some(ch.to_string()))
            .cloned()
            .unwrap_or_else(|| panic!("no read-state row for {ch}: {body}"))
    }

    /// Upload, complete and (for a video) give it a poster; returns the attachment id.
    async fn file(&self, who: &Person, ws: Uuid, ch: Uuid, name: &str, mime: &str) -> String {
        let bytes = if mime == "video/mp4" {
            mp4()
        } else {
            b"a small file of an old conversation".to_vec()
        };
        let base = format!("/v1/workspaces/{ws}/channels/{ch}/attachments");
        let response = self
            .http
            .post(self.url(&format!("{base}/uploads")))
            .bearer_auth(&who.token)
            .json(&json!({"name": name, "mime": mime, "size": bytes.len()}))
            .send()
            .await
            .expect("create upload");
        assert_eq!(response.status(), 201, "upload session");
        let created: Value = response.json().await.expect("upload body");
        let id = created["id"].as_str().expect("id").to_string();
        let uploaded = self
            .http
            .put(created["uploadUrl"].as_str().expect("uploadUrl"))
            .header(reqwest::header::CONTENT_TYPE, mime)
            .body(bytes)
            .send()
            .await
            .expect("stub upload");
        assert_eq!(uploaded.status(), 200, "bytes reach the archive");
        let completed = self
            .http
            .post(self.url(&format!("{base}/{id}/complete")))
            .bearer_auth(&who.token)
            .send()
            .await
            .expect("complete");
        assert_eq!(completed.status(), 200, "complete");
        if mime == "video/mp4" {
            let poster =
                base64::engine::general_purpose::STANDARD.encode(encoded(ImageFormat::Jpeg));
            let media = self
                .http
                .put(self.url(&format!("{base}/{id}/media")))
                .bearer_auth(&who.token)
                .json(&json!({"durationMs": 4200, "width": 1280, "height": 720,
                              "poster": {"mime": "image/jpeg", "dataBase64": poster}}))
                .send()
                .await
                .expect("media");
            assert_eq!(media.status(), 200, "poster is set before the send");
        }
        id
    }

    async fn outbox_mark(&self) -> i64 {
        sqlx::query_scalar("SELECT COALESCE(max(id), 0) FROM outbox")
            .fetch_one(&self.su)
            .await
            .expect("outbox mark")
    }
}

fn ids_in(text: &str, ids: &[Uuid]) -> usize {
    let lower = text.to_lowercase();
    ids.iter()
        .filter(|id| lower.contains(&id.to_string()))
        .count()
}

// ---------------------------------------------------------------------------
// 첨부 내용·썸네일
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn files_below_the_floor_answer_like_an_unknown_id() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("files").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let theirs = w.file(&b, ws, dm, "옛 문서.txt", "text/plain").await;
    let clip = w.file(&b, ws, dm, "옛 영상.mp4", "video/mp4").await;
    w.send(
        &b,
        ws,
        dm,
        json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": "파일", "attachmentIds": [theirs, clip]}),
    )
    .await;
    let mine = w.file(&a, ws, dm, "내 문서.txt", "text/plain").await;
    let (_, head) = w
        .send(
            &a,
            ws,
            dm,
            json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": "내 파일", "attachmentIds": [mine]}),
        )
        .await;

    let base = format!("/v1/workspaces/{ws}/channels/{dm}/attachments");
    let unknown = Uuid::new_v4().to_string();
    let reads = |id: &str| -> Vec<(&'static str, reqwest::Method, String, Option<&'static str>)> {
        vec![
            (
                "GET",
                reqwest::Method::GET,
                format!("{base}/{id}/content"),
                None,
            ),
            (
                "HEAD",
                reqwest::Method::HEAD,
                format!("{base}/{id}/content"),
                None,
            ),
            (
                "Range",
                reqwest::Method::GET,
                format!("{base}/{id}/content"),
                Some("bytes=0-3"),
            ),
            (
                "poster",
                reqwest::Method::GET,
                format!("{base}/{id}/poster"),
                None,
            ),
        ]
    };
    let served = |what: &str, file: &str| -> u16 {
        match (what, file == clip) {
            ("Range", _) => 206,
            ("poster", false) => 404,
            _ => 200,
        }
    };
    // Controls: before leaving, the leaver reads every file.
    for file in [&theirs, &clip, &mine] {
        for (what, method, path, range) in reads(file) {
            let answer = w.request(&a.token, method, &path, range).await;
            assert_eq!(
                answer.status,
                served(what, file),
                "{what} {path}: {}",
                answer.text()
            );
        }
    }

    w.leave(&a, ws, dm, head).await;

    for file in [&theirs, &clip, &mine] {
        for ((what, method, path, range), (_, unknown_method, unknown_path, _)) in
            reads(file).into_iter().zip(reads(&unknown))
        {
            let hidden = w.request(&a.token, method, &path, range).await;
            let nothing = w
                .request(&a.token, unknown_method, &unknown_path, range)
                .await;
            assert_eq!(hidden.status, 404, "{what} {path}: {}", hidden.text());
            assert_eq!(
                hidden, nothing,
                "{what}: a file below the floor is an id that never existed"
            );
        }
    }
    // The other participant still reads every file.
    for file in [&theirs, &clip, &mine] {
        for (what, method, path, range) in reads(file) {
            let answer = w.request(&b.token, method, &path, range).await;
            assert_eq!(
                answer.status,
                served(what, file),
                "{what} {path}: {}",
                answer.text()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 링크 카드 그림·아이콘 · 링크 카드 목록
// ---------------------------------------------------------------------------

async fn card(w: &World, ws: Uuid, ch: Uuid, message: Uuid, page: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message_unfurl (workspace_id, channel_id, message_id, url_key, source_url, \
                                     status, title, domain, image_url, icon_source_url, \
                                     icon_proxy_key) \
         VALUES ($1, $2, $3, $4, $4, 'ok', '옛 카드', 'news.example', $5, $6, $6) RETURNING id",
    )
    .bind(ws)
    .bind(ch)
    .bind(message)
    .bind(format!("https://news.example/{page}"))
    .bind(format!("https://news.example/{page}/hero.png"))
    .bind(format!("https://news.example/{page}/icon.png"))
    .fetch_one(&w.su)
    .await
    .expect("seed card")
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn link_cards_below_the_floor_answer_like_an_unknown_id() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("cards").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let (old, head) = w.say(&b, ws, dm, "https://news.example/old").await;
    let old_card = card(&w, ws, dm, old, "old").await;
    let pictures = |id: Uuid| {
        [
            ("picture", format!("/v1/workspaces/{ws}/unfurls/{id}/image")),
            ("icon", format!("/v1/workspaces/{ws}/unfurls/{id}/icon")),
        ]
    };
    let list = |message: Uuid| format!("/v1/workspaces/{ws}/messages/{message}/unfurls");
    for (what, path) in pictures(old_card) {
        let answer = w.get(&a.token, &path).await;
        assert_eq!(answer.status, 200, "control {what}: {}", answer.text());
    }
    let answer = w.get(&a.token, &list(old)).await;
    assert_eq!(
        (answer.status, ids_in(&answer.text(), &[old_card])),
        (200, 1),
        "control list: {}",
        answer.text()
    );

    w.leave(&a, ws, dm, head).await;
    let (new, _) = w.say(&b, ws, dm, "https://news.example/new").await;
    let new_card = card(&w, ws, dm, new, "new").await;

    let unknown_card = Uuid::new_v4();
    for ((what, path), (_, unknown)) in pictures(old_card).into_iter().zip(pictures(unknown_card)) {
        let hidden = w.get(&a.token, &path).await;
        let nothing = w.get(&a.token, &unknown).await;
        assert_eq!(hidden.status, 404, "{what}: {}", hidden.text());
        assert_eq!(hidden, nothing, "{what} below the floor is an unknown card");
        let theirs = w.get(&b.token, &path).await;
        assert_eq!(theirs.status, 200, "{what} for the other participant");
    }
    let hidden = w.get(&a.token, &list(old)).await;
    let nothing = w.get(&a.token, &list(Uuid::new_v4())).await;
    assert_eq!(hidden.status, 404, "{}", hidden.text());
    assert_eq!(
        hidden, nothing,
        "the card list of a message below the floor"
    );
    let theirs = w.get(&b.token, &list(old)).await;
    assert_eq!(
        (theirs.status, ids_in(&theirs.text(), &[old_card])),
        (200, 1)
    );
    // A card on a message above the floor is served to the leaver.
    for (what, path) in pictures(new_card) {
        let answer = w.get(&a.token, &path).await;
        assert_eq!(
            answer.status,
            200,
            "{what} above the floor: {}",
            answer.text()
        );
    }
}

// ---------------------------------------------------------------------------
// 안 읽음·멘션 숫자 · 받은함 · 사람 MCP
// ---------------------------------------------------------------------------

async fn dev_card(w: &World, who: &Person, ws: Uuid) -> String {
    sqlx::query(
        "UPDATE workspace_membership SET role = 'admin' WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(ws)
    .bind(who.id)
    .execute(&w.su)
    .await
    .expect("admin role");
    let response = w
        .http
        .post(w.url(&format!("/v1/workspaces/{ws}/dev-access/credentials")))
        .bearer_auth(&who.token)
        .json(&json!({"name": "도현 맥북", "tool": "claude_code", "currentPassword": LOGIN_WORD}))
        .send()
        .await
        .expect("issue card");
    let status = response.status();
    let body: Value = response.json().await.expect("card body");
    assert_eq!(status, 201, "issue a developer card: {body}");
    body["token"].as_str().expect("card").to_string()
}

async fn mcp_read(w: &World, card: &str, channel: Uuid) -> String {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": "oort_me_read", "arguments": {"channelId": channel}}});
    let response = w
        .http
        .post(w.url("/v1/mcp/me"))
        .bearer_auth(card)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25")
        .header("mcp-method", "tools/call")
        .header("mcp-name", "oort_me_read")
        .json(&body)
        .send()
        .await
        .expect("mcp");
    let answer = Answer::of(response).await;
    assert_eq!(answer.status, 200, "{}", answer.text());
    let reply: Value = serde_json::from_slice(&answer.body).expect("json-rpc");
    assert_eq!(reply["result"]["isError"], json!(false), "{reply}");
    reply["result"]["structuredContent"].to_string()
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn counts_and_lists_hold_nothing_below_the_floor() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("counts").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let card = dev_card(&w, &a, ws).await;
    let mut old = Vec::new();
    for text in [
        format!("@{} 옛 글 하나", a.handle),
        "옛 글 둘".to_string(),
        format!("@{} 옛 글 셋", a.handle),
    ] {
        old.push(w.say(&b, ws, dm, &text).await);
    }
    let head = old.last().unwrap().1;
    let old_ids: Vec<Uuid> = old.iter().map(|(id, _)| *id).collect();
    let inbox = format!("/v1/workspaces/{ws}/inbox");

    let row = w.read_row(&a, ws, dm).await;
    assert_eq!(row["unread_count"], json!(3), "control: {row}");
    assert_eq!(row["mention_count"], json!(2), "control: {row}");
    let listed = w.json(&a.token, &inbox).await;
    assert!(
        ids_in(&listed.to_string(), &old_ids) == 3 && listed["unreadCount"].as_i64() >= Some(3),
        "control inbox: {listed}"
    );
    assert_eq!(
        ids_in(&mcp_read(&w, &card, dm).await, &old_ids),
        3,
        "control: the human MCP reads the conversation"
    );

    let theirs_before = w.read_row(&b, ws, dm).await;
    w.leave(&a, ws, dm, head).await;

    let row = w.read_row(&a, ws, dm).await;
    assert_eq!(row["unread_count"], json!(0), "{row}");
    assert_eq!(row["mention_count"], json!(0), "{row}");
    let listed = w.json(&a.token, &inbox).await;
    assert_eq!(ids_in(&listed.to_string(), &old_ids), 0, "{listed}");
    assert_eq!(listed["unreadCount"], json!(0), "{listed}");
    assert_eq!(
        ids_in(&mcp_read(&w, &card, dm).await, &old_ids),
        0,
        "the human MCP door returns nothing below the floor"
    );
    // The other participant's numbers are theirs and unchanged.
    let theirs = w.read_row(&b, ws, dm).await;
    assert_eq!(
        theirs, theirs_before,
        "the other participant's row is unchanged"
    );
}

// ---------------------------------------------------------------------------
// 푸시 — activity on old messages after leaving
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn activity_on_old_messages_makes_no_push_or_inbox_for_the_leaver() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("activity").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let (root, _) = w.say(&b, ws, dm, "옛 글").await;
    let (other, head) = w.say(&b, ws, dm, "옛 글 둘").await;
    w.leave(&a, ws, dm, head).await;
    let mark = w.outbox_mark().await;
    let old = [root, other];

    for (method, path, body) in [
        (
            reqwest::Method::PUT,
            format!("/v1/workspaces/{ws}/messages/{root}/reactions/%F0%9F%91%8D"),
            None,
        ),
        (
            reqwest::Method::PUT,
            format!("/v1/workspaces/{ws}/messages/{root}/pin"),
            None,
        ),
        (
            reqwest::Method::PATCH,
            format!("/v1/workspaces/{ws}/messages/{other}"),
            Some(json!({"body": "고친 옛 글"})),
        ),
    ] {
        let mut request = w.http.request(method, w.url(&path)).bearer_auth(&b.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let status = request.send().await.expect("activity").status();
        assert!(status.is_success(), "{path}: {status}");
    }
    // A mention of the leaver added to an old message (the inbox projection's UPDATE OF props
    // trigger; no REST route rewrites mentions today, so the row is changed directly).
    sqlx::query(
        "UPDATE message SET props = jsonb_set(props, '{mention_member_ids}', to_jsonb(ARRAY[$2::text])) \
          WHERE id = $1",
    )
    .bind(other)
    .bind(a.id.to_string())
    .execute(&w.su)
    .await
    .expect("add a mention to an old message");

    let push_for_old = "SELECT count(*) FROM outbox WHERE id > $1 AND kind = 'push_candidate' \
                          AND (payload->>'message_id')::uuid = ANY($2)";
    let n: i64 = sqlx::query_scalar(push_for_old)
        .bind(mark)
        .bind(&old[..])
        .fetch_one(&w.su)
        .await
        .expect("push candidates");
    assert_eq!(n, 0, "no push candidate about an old message");
    let leaver_frames = "SELECT count(*) FROM outbox WHERE id > $1 AND kind = 'broadcast' \
                           AND payload->>'channel' = $2 \
                           AND payload->'data'->>'type' = 'inbox_item.created'";
    let channel = format!("user:read-state#{}", a.id.to_string().to_uppercase());
    let frames = |mark: i64| {
        let channel = channel.clone();
        let su = w.su.clone();
        async move {
            sqlx::query_scalar::<_, i64>(leaver_frames)
                .bind(mark)
                .bind(channel)
                .fetch_one(&su)
                .await
                .expect("frames")
        }
    };
    assert_eq!(frames(mark).await, 0, "no unread inbox frame to the leaver");
    let listed = w
        .json(&a.token, &format!("/v1/workspaces/{ws}/inbox"))
        .await;
    assert_eq!(ids_in(&listed.to_string(), &old), 0, "{listed}");
    assert_eq!(listed["unreadCount"], json!(0), "{listed}");

    // Control (D19 · owner D-2): a new message still makes a push candidate and an inbox frame.
    let before_new = w.outbox_mark().await;
    let (new, _) = w.say(&b, ws, dm, "새 글").await;
    let n: i64 = sqlx::query_scalar(push_for_old)
        .bind(before_new)
        .bind(&[new][..])
        .fetch_one(&w.su)
        .await
        .expect("push candidates");
    assert_eq!(n, 1, "a new message is a push candidate as before");
    assert_eq!(
        frames(before_new).await,
        1,
        "and an unread inbox frame to the leaver"
    );
    let listed = w
        .json(&a.token, &format!("/v1/workspaces/{ws}/inbox"))
        .await;
    assert_eq!(ids_in(&listed.to_string(), &[new]), 1, "{listed}");
}

// ---------------------------------------------------------------------------
// 실시간 서버 보관분 — the subscribe proxy
// ---------------------------------------------------------------------------

async fn proxy(w: &World, who: &Person, channel: &str) -> String {
    let response = w
        .http
        .post(w.url("/v1/auth/realtime-token"))
        .bearer_auth(&who.token)
        .send()
        .await
        .expect("realtime token");
    assert_eq!(response.status(), 200, "connection token");
    let body: Value = response.json().await.expect("token body");
    let claims = jsonwebtoken::decode::<momo_auth::CentrifugoConnectionClaims>(
        body["token"].as_str().expect("token"),
        &jsonwebtoken::DecodingKey::from_secret(CENT_SIGNING.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .expect("verify connection token")
    .claims;
    let response = w
        .http
        .post(w.url("/v1/centrifugo/subscribe"))
        .header(PROXY_SECRET_HEADER, PROXY_HEADER_VALUE)
        .json(&json!({
            "client": Uuid::new_v4().to_string(),
            "user": claims.sub,
            "channel": channel,
            "meta": { "schema": claims.meta.schema, "token_id": claims.meta.token_id },
        }))
        .send()
        .await
        .expect("subscribe proxy");
    assert_eq!(response.status(), 200, "a proxy decision is HTTP 200");
    response.text().await.expect("proxy body")
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_subscribe_proxy_turns_recovery_off_for_a_floor_only() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("proxy").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let open = w.channel(ws, "public", &[a.id, b.id]).await;
    let (_, head) = w.say(&b, ws, dm, "옛 글").await;
    let name = |ns: &str, ch: Uuid| {
        format!(
            "{ns}:ws{}.{}",
            ws.to_string().to_uppercase(),
            ch.to_string().to_uppercase()
        )
    };
    const ALLOW: &str = r#"{"result":{}}"#;
    const WITHOUT_RECOVERY: &str = r#"{"result":{"override":{"force_recovery":{"value":false}}}}"#;
    assert_eq!(
        proxy(&w, &a, &name("ch", dm)).await,
        ALLOW,
        "control: before leaving"
    );

    w.leave(&a, ws, dm, head).await;

    assert_eq!(
        proxy(&w, &a, &name("ch", dm)).await,
        WITHOUT_RECOVERY,
        "the leaver's message rail"
    );
    assert_eq!(
        proxy(&w, &a, &name("typing", dm)).await,
        WITHOUT_RECOVERY,
        "the same rule"
    );
    assert_eq!(
        proxy(&w, &b, &name("ch", dm)).await,
        ALLOW,
        "the other participant"
    );
    assert_eq!(
        proxy(&w, &a, &name("ch", open)).await,
        ALLOW,
        "the leaver elsewhere"
    );
    let outsider = w.human(ws, "park").await;
    let refused: Value =
        serde_json::from_str(&proxy(&w, &outsider, &name("ch", dm)).await).expect("deny json");
    assert_eq!(
        refused["error"]["code"],
        json!(403),
        "a non-member is still refused"
    );
}

// ---------------------------------------------------------------------------
// 팀 AI 읽기 · 팀 기억 — scope lines
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn team_ai_and_team_memory_do_not_reach_a_human_one_to_one() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("scope").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let (helper, _) = w.member_row(ws, "agent", "helper").await;
    let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
    let open = w.channel(ws, "public", &[a.id, b.id]).await;
    let with_agent = w.channel(ws, "dm", &[a.id, helper]).await;
    w.say(&b, ws, dm, "사람끼리").await;
    w.say(&b, ws, open, "공개").await;

    let read_as_agent = |ch: Uuid| {
        momo_db::tenant::REQUEST_AGENT_MEMBER.scope(
            helper,
            with_tenant_tx(&w.app, ws, move |conn| {
                Box::pin(async move {
                    let n: i64 =
                        sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                            .bind(ch)
                            .fetch_one(&mut *conn)
                            .await
                            .map_err(DbError::from)?;
                    Ok(n)
                })
            }),
        )
    };
    assert_eq!(
        read_as_agent(dm).await.unwrap(),
        0,
        "an agent reads none of a human 1:1"
    );
    assert_eq!(
        read_as_agent(open).await.unwrap(),
        1,
        "control: the same agent reads a channel"
    );

    // The memory worker's eligibility predicate (`102_mem_worker.sql`), asked as its owner would.
    let eligible = |ch: Uuid| {
        with_tenant_tx(&w.su, ws, move |conn| {
            Box::pin(async move {
                let ok: bool = sqlx::query_scalar("SELECT mem_channel_eligible($1)")
                    .bind(ch)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(DbError::from)?;
                Ok(ok)
            })
        })
    };
    assert!(
        !eligible(dm).await.unwrap(),
        "a human 1:1 is not memory-eligible"
    );
    assert!(
        eligible(with_agent).await.unwrap(),
        "control: one person and one agent is"
    );
    assert!(eligible(open).await.unwrap(), "control: a channel is");
}

// ---------------------------------------------------------------------------
// 길 전수 표 — catalog leg
// ---------------------------------------------------------------------------

/// Every table with a foreign key to `message`: how a person who left a 1:1 is kept from what it
/// holds of the messages below their floor.
const COPY_TABLES: &[(&str, &str)] = &[
    (
        "agent_run",
        "agent runs; no agent sits in a human 1:1 (D20)",
    ),
    (
        "approval",
        "approval cards are messages; lists join message",
    ),
    (
        "attachment",
        "content and poster load through message (this file)",
    ),
    (
        "dm_agent_admission",
        "a pending request is cancelled by the leave (D16-2); its card is a message",
    ),
    ("file", "legacy table; no reader in the server"),
    ("hosted_agent_inbox_event", "hosted agents only (D20)"),
    (
        "huddle_recording",
        "recording state only; transcripts are messages",
    ),
    (
        "inbox_item",
        "list and count join message; the leaver's rows below the floor are deleted (D16-1)",
    ),
    (
        "mem_digest",
        "team memory; a human 1:1 is not memory-eligible (this file)",
    ),
    (
        "mem_evidence",
        "team memory; a human 1:1 is not memory-eligible",
    ),
    (
        "mem_suppress_msg",
        "team memory; a human 1:1 is not memory-eligible",
    ),
    (
        "message",
        "replies and quotes are messages under the same policy",
    ),
    ("message_pin", "pin list joins message"),
    (
        "message_reminder",
        "the leaver's rows below the floor are deleted (D16-1, row count)",
    ),
    (
        "message_unfurl",
        "card list, picture and icon load through message (this file)",
    ),
    (
        "message_unfurl_tombstone",
        "ids only; the unfurl worker reads it",
    ),
    (
        "push_dispatch_log",
        "delivery status only; a push carries ids",
    ),
    ("reaction", "reaction list joins message"),
    (
        "scheduled_message",
        "the leaver's schedules in the room are cancelled (D16-1); a sent one is a message",
    ),
    ("thread", "thread summary read beside its root message"),
    (
        "thread_follow",
        "the leaver's rows below the floor are deleted (D16-1, row count)",
    ),
    ("unfurl_job", "the unfurl worker's queue"),
    ("webhook_receipt", "inbound webhook dedupe; no human read"),
    (
        "work_control",
        "work session controls; the session's thread is messages",
    ),
    (
        "work_session",
        "work sessions; the session's thread is messages",
    ),
    (
        "workstream",
        "workstream rows point at messages read through the policy",
    ),
];

/// Every function in `public` that reads `message`: invoker functions run as their caller under
/// the policy; the definers are the team memory plane, which a human 1:1 never enters.
const MESSAGE_FUNCTIONS: &[(&str, &str)] = &[
    (
        "inbox_item_guard_insert",
        "inbox trigger, runs as the writer",
    ),
    (
        "inbox_item_project_message",
        "inbox trigger, runs as the writer",
    ),
    (
        "inbox_item_reasons_consistent",
        "inbox check, runs as the writer",
    ),
    ("mem_accept_proposal", "team memory"),
    ("mem_add_item", "team memory"),
    ("mem_apply_digest", "team memory"),
    ("mem_cons_accept", "team memory"),
    ("mem_cons_apply", "team memory"),
    ("mem_cons_retire_dead", "team memory"),
    ("mem_digest_evidence_ok", "team memory"),
    ("mem_digest_live", "team memory"),
    ("mem_edit_item", "team memory"),
    ("mem_item_guest_authored", "team memory"),
    ("mem_item_live", "team memory"),
    ("mem_item_readable_by", "team memory"),
    ("mem_proposal_evidence_ok", "team memory"),
    ("mem_propose_item", "team memory"),
    ("mem_serve_candidates", "team memory"),
    ("mem_serve_gate", "team memory"),
    ("mem_serve_requester", "team memory"),
];

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn every_copy_of_message_in_the_catalog_is_classified() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tables: BTreeSet<String> = sqlx::query_scalar(
        "SELECT DISTINCT c.conrelid::regclass::text FROM pg_constraint c \
          WHERE c.contype = 'f' AND c.confrelid = 'public.message'::regclass",
    )
    .fetch_all(&su)
    .await
    .expect("foreign keys")
    .into_iter()
    .collect();
    let listed: BTreeSet<String> = COPY_TABLES.iter().map(|(t, _)| t.to_string()).collect();
    assert_eq!(
        tables.difference(&listed).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "a table that references message needs a row in COPY_TABLES (ADR-0177 D17)"
    );
    assert_eq!(
        listed.difference(&tables).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "stale rows in COPY_TABLES"
    );

    let functions: BTreeSet<String> = sqlx::query_scalar(
        "SELECT DISTINCT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
          WHERE n.nspname = 'public' AND p.prosrc ~* '(from|join)\\s+(public\\.)?message\\M'",
    )
    .fetch_all(&su)
    .await
    .expect("functions")
    .into_iter()
    .collect();
    let listed: BTreeSet<String> = MESSAGE_FUNCTIONS
        .iter()
        .map(|(f, _)| f.to_string())
        .collect();
    assert_eq!(
        functions.symmetric_difference(&listed).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "every function that reads message needs a row in MESSAGE_FUNCTIONS (and no stale row)"
    );
    let views: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') \
            AND pg_get_viewdef(c.oid) ~* '(from|join)\\s+(public\\.)?message\\M'",
    )
    .fetch_one(&su)
    .await
    .expect("views");
    assert_eq!(
        views, 0,
        "a view over message would need a row and a reason"
    );
}

// ---------------------------------------------------------------------------
// 잠금 차례 (#5822 검수 r1 M1·L1)
// ---------------------------------------------------------------------------

async fn insert_schedule(w: &World, ws: Uuid, ch: Uuid, author: Uuid, offset_secs: f64) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO scheduled_message (workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
         VALUES ($1, $2, $3, '예약', now() + make_interval(secs => $4), $5) RETURNING id",
    )
    .bind(ws)
    .bind(ch)
    .bind(author)
    .bind(offset_secs)
    .bind(Uuid::new_v4())
    .fetch_one(&w.su)
    .await
    .expect("seed schedule")
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn leaving_while_a_schedule_is_sent_never_deadlocks() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("locks").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let settings = SchedulerSettings::default();
    let (_stop_tx, stop) = tokio::sync::watch::channel(false);
    let mut outcomes: BTreeMap<String, usize> = BTreeMap::new();
    for round in 0..30 {
        let dm = w.channel(ws, "dm", &[a.id, b.id]).await;
        let (_, head) = w.say(&b, ws, dm, "옛 글").await;
        let now = insert_schedule(&w, ws, dm, a.id, 3600.0).await;
        let due = insert_schedule(&w, ws, dm, a.id, -1.0).await;
        let leave = async {
            w.http
                .put(w.url(&format!("/v1/workspaces/{ws}/channels/{dm}/dm-leave")))
                .bearer_auth(&a.token)
                .json(&json!({ "seenSeq": head }))
                .send()
                .await
                .expect("leave")
                .status()
                .as_u16()
        };
        let send_now = async {
            w.http
                .post(w.url(&format!(
                    "/v1/workspaces/{ws}/scheduled-messages/{now}/send-now"
                )))
                .bearer_auth(&a.token)
                .send()
                .await
                .expect("send now")
                .status()
                .as_u16()
        };
        let tick = async {
            let mut memory = TickMemory::default();
            run_tick(&w.app, &w.state, &settings, &mut memory, &stop)
                .await
                .map(|report| {
                    // The tick sweeps the whole database: only this round's rows are judged.
                    report
                        .deferred
                        .iter()
                        .chain(report.panicked.iter())
                        .filter(|id| **id == due || **id == now)
                        .count()
                })
        };
        let (left, sent, ticked) = tokio::join!(leave, send_now, tick);
        assert_eq!(left, 204, "round {round}: the leave never fails");
        assert!(sent < 500, "round {round}: send-now answered {sent}");
        let troubled = ticked.unwrap_or_else(|e| panic!("round {round}: tick: {e:?}"));
        assert_eq!(troubled, 0, "round {round}: the loop deferred or panicked");
        *outcomes.entry(format!("send-now {sent}")).or_insert(0) += 1;
        let open: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM scheduled_message WHERE channel_id = $1 AND status IN ('pending', 'failed')",
        )
        .bind(dm)
        .fetch_one(&w.su)
        .await
        .expect("open schedules");
        assert_eq!(
            open, 0,
            "round {round}: every schedule was sent or cancelled"
        );
    }
    eprintln!("send-now outcomes over 30 rounds: {outcomes:?}");
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn a_leave_for_someone_elses_dm_takes_no_lock_there() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("gate").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let c = w.human(ws, "park").await;
    let theirs = w.channel(ws, "dm", &[b.id, c.id]).await;
    w.say(&b, ws, theirs, "둘만의 글").await;
    // A send in flight in that room holds its channel_seq row.
    let mut held = w.su.begin().await.expect("begin");
    sqlx::query("SELECT last_seq FROM channel_seq WHERE channel_id = $1 FOR UPDATE")
        .bind(theirs)
        .execute(&mut *held)
        .await
        .expect("hold the room");
    let leave = w
        .http
        .put(w.url(&format!("/v1/workspaces/{ws}/channels/{theirs}/dm-leave")))
        .bearer_auth(&a.token)
        .json(&json!({ "seenSeq": 0 }))
        .send();
    let answered = tokio::time::timeout(std::time::Duration::from_secs(3), leave).await;
    held.rollback().await.expect("release");
    let response = answered
        .expect(
            "a stranger's leave must not wait on the room's lock (ADR-0177 D16: participant first)",
        )
        .expect("leave");
    assert_eq!(
        response.status(),
        404,
        "someone else's DM is the unknown id"
    );
    // Control: the participant's own leave in the same room does wait for that lock.
    let mut held = w.su.begin().await.expect("begin");
    sqlx::query("SELECT last_seq FROM channel_seq WHERE channel_id = $1 FOR UPDATE")
        .bind(theirs)
        .execute(&mut *held)
        .await
        .expect("hold the room");
    let own = w
        .http
        .put(w.url(&format!("/v1/workspaces/{ws}/channels/{theirs}/dm-leave")))
        .bearer_auth(&b.token)
        .json(&json!({ "seenSeq": 0 }))
        .send();
    let waited = tokio::time::timeout(std::time::Duration::from_millis(800), own).await;
    assert!(
        waited.is_err(),
        "control: a participant's leave takes the room lock"
    );
    held.rollback().await.expect("release");
}
