//! #4820 C2b 2부 — the hosted expression door (ADR-0218 증보 G3.7 (b), G3.8, G4, G6), end to end.
//!
//! DB-backed and `#[ignore]`d like its siblings; run against an isolated PG18 with the child programs
//! built next to the test binary (`cargo build -p momo-expressions --bins`):
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26824/postgres \
//!   cargo test -p momo-agent-worker --test hosted_door_pg -- --ignored --test-threads=1
//! ```
//!
//! Real worker iterations (the `momo_worker` role) against a scripted provider that answers the way
//! Hermes' API server does — a `data:image/…;base64,…` picture and one fenced request block in one
//! non-streamed answer — and every result read back as the non-bypass `momo_app` under each of two
//! tenants.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_still_photo_turn_becomes_one_generated_candidate_card_and_commits_no_picture` | stream the door turn / commit the raw answer / drop the cleaning / lose the pointer or the ledger row |
//! | `a_motion_photo_turn_keeps_assembler_outputs_in_order_and_a_hole_on_the_card` | re-encode or reorder the outputs / lose the hole's code |
//! | `every_failure_is_one_closed_card_with_the_golden_line` | any code mapped to another / a body that is not the golden line / a card that stays pending |
//! | `an_assembler_that_cannot_run_is_a_retry_and_never_a_card` | map an outage to a card code |
//! | `no_valid_request_block_is_an_ordinary_answer_without_picture_marker_or_block` | commit the raw answer / open the door on a malformed or doubled block |
//! | `a_turn_without_a_photo_is_unchanged_and_the_requesters_own_photo_rule_holds` | apply the door to a turn without a photo, or to a photo the rule refuses |
//! | `the_cheap_refusals_come_before_the_model` | judge the ceiling after the model call |
//! | `without_the_operators_strict_attestation_the_door_is_shut_and_the_turn_is_an_ordinary_one` | open the door without the attestation (or raise a card / look for the photo while shut) |
//! | `the_source_pointer_is_recorded_only_when_the_model_was_given_the_photo` | record the pointer for a turn that handed no address |
//! | `the_directive_is_exactly_one_more_message_on_a_photo_turn` | a second block / a block on a turn without a photo |
//! | `a_third_card_that_lands_while_the_model_works_is_refused_by_the_proposal` | drop the proposal transaction's own re-proof of the ceiling of three waiting cards |
//! | `a_run_that_is_not_live_is_refused_before_the_model_is_called` | judge the run's state after the model call (or not at all) |
//! | `a_resume_turn_never_opens_the_door` | drop the `!payload.is_resume()` guard: an approved card's resume turn would open the door again on the same photo |
//! | `an_assembler_that_cannot_run_gets_two_attempts_and_ends_as_one_closed_card` | let the door retry past two attempts / lose the first attempt's tokens / raise a card twice |
//! | `a_provider_deadline_gets_two_attempts_but_an_outage_keeps_its_budget` | cap every retryable failure instead of the deadline / never cap the deadline |
//! | `an_answer_over_the_size_limit_is_one_closed_card_on_a_door_turn_and_the_ordinary_failure_elsewhere` | retry an over-long answer / answer a door turn with the generic failure / change an ordinary turn |

use std::collections::VecDeque;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{
    ChatCompletion, ChatMessage, ChatProvider, ChatRequest, ChatUsage, ProviderEndpoint,
    ProviderError,
};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_provider_link_admin_tx, with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{upsert_agent_pin, PinKind, ProviderConfig, ProviderMode};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use tokio::sync::Notify;
use uuid::Uuid;

const ENV_URL: &str = "http://hermes.railway.internal:8642/v1";
const ENV_BEARER: &str = "hermes-env-4820-c2b2-j1k2l3";
const ORIGIN: &str = "https://oort.example.com";

/// The six neutral sentences, written out here on purpose: the card's `body` is the server's reading of
/// the client's golden file, and this is an independent copy to hold it against.
const GOLDEN: [(&str, &str); 6] = [
    ("generation_failed", "그림을 만들지 못했어요"),
    (
        "assembly_source_invalid",
        "이 그림에는 움직임을 입힐 수 없어요",
    ),
    (
        "assembly_source_too_large",
        "그림이 너무 커서 움직임을 입힐 수 없어요",
    ),
    ("assembly_output_too_large", "움직이는 그림이 너무 커요"),
    ("assembly_timeout", "움직임을 입히다가 시간이 다 됐어요"),
    (
        "assembly_busy",
        "지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요",
    ),
];

fn golden_line(code: &str) -> &'static str {
    GOLDEN
        .iter()
        .find(|(c, _)| *c == code)
        .expect("a golden code")
        .1
}

// --- harness -----------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated pgvector/pg18 DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn pool_as(role: &str, password_env: &str, fallback: &str) -> PgPool {
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(
            opts.username(role)
                .password(&std::env::var(password_env).unwrap_or_else(|_| fallback.to_string())),
        )
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

fn env_link() -> ProviderConfig {
    ProviderConfig {
        mode: ProviderMode::ExternalHermes,
        base_url: ENV_URL.to_string(),
        bearer: ENV_BEARER.to_string(),
        allow_local_loopback: false,
    }
}

/// The claim is global and the link/rows are instance-global: start from empty.
async fn reset_instance(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual agent_jobs");
    for table in [
        "agent_provider_pin",
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty instance table");
    }
}

#[derive(Clone)]
struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

async fn seed(su: &PgPool) -> Tenant {
    let t = Tenant {
        workspace_id: Uuid::new_v4(),
        human_id: Uuid::new_v4(),
        agent_id: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(t.workspace_id)
        .bind(t.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display) in [
        (t.human_id, "human", "성재"),
        (t.agent_id, "agent", "hermes"),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(t.workspace_id)
        .bind(kind)
        .bind(display)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(t.workspace_id)
        .bind(id)
        .execute(su)
        .await
        .expect("workspace_membership");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', $3, 4, 50)",
    )
    .bind(t.agent_id)
    .bind(t.workspace_id)
    .bind(t.human_id)
    .execute(su)
    .await
    .expect("agent");
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .bind(format!(
            "c4820b-{}",
            &t.channel_id.simple().to_string()[..8]
        ))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in [t.human_id, t.agent_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(t.workspace_id)
        .bind(t.channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    t
}

/// Pin `agent` to the operator's env link — the co-hosted Hermes.
async fn pin_env(su: &PgPool, t: &Tenant) {
    let (ws, by, agent) = (t.workspace_id, t.human_id, t.agent_id);
    with_provider_link_admin_tx(su, ws, move |conn| {
        Box::pin(async move {
            upsert_agent_pin(conn, ws, agent, PinKind::OperatorEnv, None, None, by).await?;
            Ok(())
        })
    })
    .await
    .expect("pin env");
}

/// What the test stages as the trigger's picture.
#[derive(Clone, Copy)]
struct Photo {
    size_bytes: i64,
}

const PHOTO: Photo = Photo { size_bytes: 4096 };

/// A mention turn exactly as the send route freezes it, written by the human requester with `body`.
/// With `photo` a complete PNG row is bound to that very message. Returns `(run id, trigger message id,
/// attachment id)`.
async fn enqueue_mention(
    su: &PgPool,
    pool: &PgPool,
    t: &Tenant,
    body: &str,
    photo: Option<Photo>,
) -> (Uuid, Uuid, Option<Uuid>) {
    let (workspace_id, channel_id, human, agent) =
        (t.workspace_id, t.channel_id, t.human_id, t.agent_id);
    let body = body.to_string();
    let (run, message) = with_tenant_tx(pool, workspace_id, move |conn| {
        let body = body.clone();
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, human, body.clone()),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: agent,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": body, "depth": 0}),
                },
            )
            .await?;
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &json!({
                    "run_id": created.id,
                    "workspace_id": workspace_id,
                    "channel_id": channel_id,
                    "agent_member_id": agent,
                    "author_member_id": human,
                    "trigger_message_id": sent.message.id,
                    "trigger_message_seq": sent.message.seq,
                    "model": "hermes-agent",
                    "model_source": "agent",
                    "prompt": body,
                    "recent_messages": [{
                        "message_id": sent.message.id, "channel_id": channel_id,
                        "seq": sent.message.seq, "author_member_id": human,
                        "author_kind": "human", "author_display": "성재",
                        "type": "text", "body": body,
                    }],
                    "max_output_tokens": 256,
                    "depth": 0,
                    "delivery": "worker",
                    "created_from": "server.message_send.agent_mention.v0",
                }),
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok((created.id, sent.message.id))
        })
    })
    .await
    .expect("enqueue mention");
    let attachment = if let Some(photo) = photo {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
             drive_file_id, name, mime, size_bytes, status) \
             VALUES ($1, $2, $3, $4, $5, $6, 'photo', 'image/png', $7, 'complete')",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(human)
        .bind(message)
        .bind(format!("drive-file-{id}"))
        .bind(photo.size_bytes)
        .execute(su)
        .await
        .expect("photo attachment");
        Some(id)
    } else {
        None
    };
    (run, message, attachment)
}

/// Answers every call with the staged text, and remembers how it was called: `plain` is the
/// non-streaming `complete`, `streaming` the `complete_streaming` an ordinary turn uses.
struct Scripted {
    answer: Mutex<String>,
    plain: AtomicUsize,
    streaming: AtomicUsize,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
    /// Errors the next calls return (one per call, in order) before the staged answer comes back.
    failures: Mutex<VecDeque<ProviderError>>,
    /// A one-shot stop inside the next non-streaming call: the model is "working" until released.
    hold: Mutex<Option<Arc<Hold>>>,
}

/// The two ends of a stop inside a model call: the call says it is in, the test lets it go.
#[derive(Default)]
struct Hold {
    entered: Notify,
    release: Notify,
}

impl Scripted {
    fn new() -> Arc<Scripted> {
        Arc::new(Scripted {
            answer: Mutex::new("알겠어요".to_string()),
            plain: AtomicUsize::new(0),
            streaming: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
            failures: Mutex::new(VecDeque::new()),
            hold: Mutex::new(None),
        })
    }

    fn say(&self, answer: impl Into<String>) {
        *self.answer.lock().unwrap() = answer.into();
    }

    /// The next `errors.len()` calls fail with these, in order; the call after them answers as staged.
    fn fail_next(&self, errors: Vec<ProviderError>) {
        *self.failures.lock().unwrap() = errors.into();
    }

    /// The next non-streaming call stops inside the model until `hold.release` is notified.
    fn hold_next_call(&self, hold: &Arc<Hold>) {
        *self.hold.lock().unwrap() = Some(hold.clone());
    }

    async fn hold_if_asked(&self) {
        let hold = self.hold.lock().unwrap().take();
        if let Some(hold) = hold {
            hold.entered.notify_one();
            hold.release.notified().await;
        }
    }

    fn reply(&self, request: &ChatRequest) -> Result<ChatCompletion, ProviderError> {
        self.seen.lock().unwrap().push(request.messages.clone());
        if let Some(error) = self.failures.lock().unwrap().pop_front() {
            return Err(error);
        }
        Ok(ChatCompletion {
            text: self.answer.lock().unwrap().clone(),
            usage: Some(ChatUsage {
                prompt_tokens: 120,
                completion_tokens: 40,
                cached_tokens: 0,
                reasoning_tokens: 0,
            }),
            tool_calls: Vec::new(),
            web_search_requests: 0,
        })
    }

    fn calls(&self) -> (usize, usize) {
        (
            self.plain.load(Ordering::SeqCst),
            self.streaming.load(Ordering::SeqCst),
        )
    }

    fn requests(&self) -> Vec<Vec<ChatMessage>> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl ChatProvider for Scripted {
    async fn complete(
        &self,
        _endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        self.plain.fetch_add(1, Ordering::SeqCst);
        self.hold_if_asked().await;
        self.reply(request)
    }

    async fn complete_streaming(
        &self,
        _endpoint: &ProviderEndpoint,
        request: &ChatRequest,
        _sink: &dyn momo_agent_worker::provider::DeltaSink,
    ) -> Result<ChatCompletion, ProviderError> {
        self.streaming.fetch_add(1, Ordering::SeqCst);
        self.reply(request)
    }
}

#[derive(Clone, Default)]
struct Opts {
    /// The photo address origin (`None`: no address is ever minted).
    origin: Option<&'static str>,
    /// The operator's strict-media attestation.
    strict: bool,
    /// An assembler program standing in for the real one.
    assembler: Option<PathBuf>,
}

async fn worker(provider: &Arc<Scripted>, opts: &Opts) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some("conformance-4820-b2-master".to_string());
    config.provider = env_link();
    config = config.with_hosted_media_strict(opts.strict);
    if let Some(origin) = opts.origin {
        config = config.with_self_media_origin(origin);
    }
    if let Some(program) = &opts.assembler {
        config = config.with_assembler_program(program.clone());
    }
    AgentWorker::new(
        pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    )
}

async fn drain(worker: &AgentWorker) -> DrainStats {
    let mut total = DrainStats::default();
    for _ in 0..8 {
        let stats = worker.drain_once().await.expect("drain");
        total.claimed += stats.claimed;
        total.answered += stats.answered;
        total.requeued += stats.requeued;
        total.skipped += stats.skipped;
        total.failed += stats.failed;
        if stats.claimed == 0 {
            break;
        }
    }
    total
}

// --- pictures and answers ------------------------------------------------------

fn picture(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        if x < width / 2 {
            image::Rgba([220, 30, 30, 255])
        } else if y < height / 2 {
            image::Rgba([30, 30, 220, 255])
        } else {
            image::Rgba([30, 180, 60, 255])
        }
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// 256 px of 16-level noise: at 240 `pulse` and `bounce` fit under their caps, `sparkle` is built under
/// 1 MiB but breaks the 256 KiB cap of the small rendition → `assembly_output_too_large`.
fn noise() -> Vec<u8> {
    let mut state = 0x9E37_79B9u32 ^ 1;
    let image = image::RgbaImage::from_fn(256, 256, |_, _| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let b = state.to_le_bytes();
        let level = |v: u8| ((u32::from(v) % 16) * 15) as u8;
        image::Rgba([level(b[0]), level(b[1]), level(b[2]), 255])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn markdown_of(png: &[u8]) -> String {
    format!(
        "![그림](data:image/png;base64,{})",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

fn fenced(json: &str) -> String {
    format!("```oort-expression\n{json}\n```")
}

fn request_json(motion: Value, size: u32, candidates: &[(&str, &str)]) -> String {
    json!({
        "v": 1,
        "motion": motion,
        "size": size,
        "prompt": "웃는 얼굴로 그렸어요",
        "subjectMemberId": null,
        "candidates": candidates.iter().map(|(name, display)| json!({
            "name": name, "displayName": display, "tags": ["웃음"],
        })).collect::<Vec<_>>(),
    })
    .to_string()
}

fn still_request() -> String {
    request_json(json!({"kind": "still"}), 360, &[("smile-me", "웃는 나")])
}

fn preset_request(presets: &[&str], size: u32, names: &[(&str, &str)]) -> String {
    request_json(json!({"kind": "preset", "presets": presets}), size, names)
}

/// What Hermes' API server hands back for a turn that made a picture: the person-facing words, the
/// picture as a markdown image, and the model's own request block.
fn answer(words: &str, png: Option<&[u8]>, block: Option<&str>) -> String {
    let mut text = words.to_string();
    if let Some(png) = png {
        text.push_str("\n\n");
        text.push_str(&markdown_of(png));
    }
    if let Some(block) = block {
        text.push_str("\n\n");
        text.push_str(&fenced(block));
    }
    text
}

fn script(name: &str, body: &str) -> PathBuf {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("assembler-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

// --- reading the result back (as the non-bypass role, under a tenant) -------------

#[derive(Debug, Clone)]
struct Msg {
    kind: String,
    body: Option<String>,
    props: Value,
}

async fn agent_messages(app: &PgPool, t: &Tenant) -> Vec<Msg> {
    let (ws, channel, agent) = (t.workspace_id, t.channel_id, t.agent_id);
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT type::text AS kind, body, props FROM message \
                  WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
                  ORDER BY seq",
            )
            .bind(ws)
            .bind(channel)
            .bind(agent)
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows
                .iter()
                .map(|row| Msg {
                    kind: row.get("kind"),
                    body: row.get("body"),
                    props: row.get("props"),
                })
                .collect::<Vec<_>>())
        })
    })
    .await
    .expect("read messages")
}

#[derive(Debug)]
struct Approval {
    status: String,
    decided_by: Option<Uuid>,
    reason: Option<String>,
    payload: Value,
}

async fn approvals_of(app: &PgPool, t: &Tenant, run: Uuid) -> Vec<Approval> {
    let ws = t.workspace_id;
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT status::text AS status, decided_by, decision_reason, payload \
                   FROM approval WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at",
            )
            .bind(ws)
            .bind(run)
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows
                .iter()
                .map(|row| Approval {
                    status: row.get("status"),
                    decided_by: row.get("decided_by"),
                    reason: row.get("decision_reason"),
                    payload: row.get("payload"),
                })
                .collect::<Vec<_>>())
        })
    })
    .await
    .expect("read approvals")
}

#[derive(Debug)]
struct Draft {
    index: i32,
    state: String,
    code: Option<String>,
    name: String,
    pointer: Option<Uuid>,
}

async fn drafts_of(app: &PgPool, t: &Tenant) -> Vec<Draft> {
    let ws = t.workspace_id;
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let rows = sqlx::query(
                "SELECT candidate_index, state, code, name, origin_source_attachment_id \
                   FROM expression_draft WHERE workspace_id = $1 \
                  ORDER BY approval_id, candidate_index",
            )
            .bind(ws)
            .fetch_all(&mut *conn)
            .await?;
            Ok(rows
                .iter()
                .map(|row| Draft {
                    index: row.get("candidate_index"),
                    state: row.get("state"),
                    code: row.get("code"),
                    name: row.get("name"),
                    pointer: row.get("origin_source_attachment_id"),
                })
                .collect::<Vec<_>>())
        })
    })
    .await
    .expect("read drafts")
}

async fn run_status(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .unwrap()
}

async fn ledger_rows(su: &PgPool, run: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .unwrap()
}

/// Nothing a person's channel, the outbox or the broadcast rail carries may hold a picture, a
/// `MEDIA:` mark or the request block (MiB of base64 must never ride them).
async fn assert_no_picture_anywhere(su: &PgPool, t: &Tenant) {
    let ws = t.workspace_id;
    for needle in ["data:image", "base64,", "MEDIA:", "oort-expression"] {
        let like = format!("%{needle}%");
        let in_messages: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM message WHERE workspace_id = $1 \
               AND (body LIKE $2 OR props::text LIKE $2)",
        )
        .bind(ws)
        .bind(&like)
        .fetch_one(su)
        .await
        .unwrap();
        let in_outbox: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND payload::text LIKE $2",
        )
        .bind(ws)
        .bind(&like)
        .fetch_one(su)
        .await
        .unwrap();
        assert_eq!(in_messages, 0, "{needle} in a message");
        assert_eq!(in_outbox, 0, "{needle} in an outbox payload");
    }
}

/// The last request the provider saw for a turn whose trigger text contains `body`.
fn request_for<'a>(requests: &'a [Vec<ChatMessage>], body: &str) -> &'a Vec<ChatMessage> {
    requests
        .iter()
        .find(|messages| messages.iter().any(|m| m.content.contains(body)))
        .unwrap_or_else(|| panic!("no request carried {body:?}"))
}

fn is_card(msg: &Msg) -> bool {
    msg.kind == "approval_request"
}

/// One more `expression.create` card of the agent that waits for a decision: the requester's message,
/// a finished earlier run of the agent and its pending approval (what the agent's ceiling of three
/// counts).
async fn add_waiting_card(worker_pool: &PgPool, t: &Tenant, words: &str) {
    let (workspace_id, channel_id, human, agent) =
        (t.workspace_id, t.channel_id, t.human_id, t.agent_id);
    let words = words.to_string();
    with_tenant_tx(worker_pool, workspace_id, move |conn| {
        let words = words.clone();
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, human, words.clone()),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: agent,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": words, "depth": 0}),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE agent_run SET status = 'succeeded', finished_at = now() WHERE id = $1",
            )
            .bind(created.id)
            .execute(&mut *conn)
            .await?;
            momo_agent::create_pending_approval_in_tx(
                conn,
                workspace_id,
                momo_agent::NewApproval {
                    run_id: created.id,
                    channel_id,
                    requested_by: agent,
                    action_type: "workspace_action".to_string(),
                    payload: json!({"action": {"id": "expression.create"}}),
                    expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
                },
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("a waiting card");
}

/// How many cards of the agent wait for a decision.
async fn waiting_cards(su: &PgPool, t: &Tenant) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM approval \
          WHERE workspace_id = $1 AND requested_by = $2 AND status = 'pending'",
    )
    .bind(t.workspace_id)
    .bind(t.agent_id)
    .fetch_one(su)
    .await
    .unwrap()
}

/// The outbox row of a run's agent job, with its settled state and the reason it was settled for.
async fn job_of(su: &PgPool, run: Uuid) -> (i64, String, Option<String>) {
    let row = sqlx::query(
        "SELECT id, status::text AS status, last_error FROM outbox \
          WHERE kind = 'agent_job' AND (payload->>'run_id')::uuid = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(run)
    .fetch_one(su)
    .await
    .expect("the run's job");
    (row.get("id"), row.get("status"), row.get("last_error"))
}

/// Let a requeued job's backoff end now, so the next `drain_once` claims it.
async fn let_the_backoff_end(su: &PgPool, job_id: i64) {
    sqlx::query("UPDATE outbox SET available_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(su)
        .await
        .expect("let the backoff end");
}

/// `(prompt tokens, completion tokens, was_estimated)` of the run's ledger rows.
async fn ledger_of(su: &PgPool, run: Uuid) -> Vec<(i32, i32, bool)> {
    sqlx::query(
        "SELECT prompt_tokens, completion_tokens, was_estimated FROM usage_ledger WHERE run_id = $1",
    )
    .bind(run)
    .fetch_all(su)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        (
            row.get("prompt_tokens"),
            row.get("completion_tokens"),
            row.get("was_estimated"),
        )
    })
    .collect()
}

// --- behaviour ---------------------------------------------------------------

/// The whole happy loop for a still picture, across two tenants: the door is opened by the photo, the
/// model is called **without streaming**, the picture becomes one `generated` candidate carrying the
/// requester's photo as its source, the run is parked on the card, the ledger row is written, and no
/// picture, `MEDIA:` mark or request block is committed anywhere.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_still_photo_turn_becomes_one_generated_candidate_card_and_commits_no_picture() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let a = seed(&su).await;
    let b = seed(&su).await;
    pin_env(&su, &a).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;

    let png = picture(300, 200);
    provider.say(answer(
        "웃는 얼굴로 만들었어요!\nMEDIA:/opt/data/cache/images/abc.png",
        Some(&png),
        Some(&still_request()),
    ));
    let (run, _, attachment) = enqueue_mention(
        &su,
        &worker_pool,
        &a,
        "@hermes 이 사진으로 새 이모티콘 만들어 줘 (still-4820)",
        Some(PHOTO),
    )
    .await;
    let stats = drain(&w).await;
    assert_eq!(stats.claimed, 1, "{stats:?}");

    // Not streamed: one plain call, no streaming call.
    assert_eq!(provider.calls(), (1, 0));
    // One card, an approval request, and nothing else from the agent.
    let messages = agent_messages(&app, &a).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    let card = &messages[0];
    assert!(is_card(card));
    assert_eq!(card.body.as_deref(), Some("승인 요청: 팀 표현 추가"));
    assert_eq!(card.props["status"], "pending");
    let candidates = card.props["action"]["expression"]["candidates"]
        .as_array()
        .expect("candidates on the card");
    assert_eq!(candidates.len(), 1);
    let candidate = &candidates[0];
    assert_eq!(candidate["state"], "ready");
    assert_eq!(candidate["origin"]["kind"], "generated");
    assert_eq!(candidate["origin"]["prompt"], "웃는 얼굴로 그렸어요");
    assert_eq!(
        candidate["origin"]["sourceAttachmentId"],
        json!(attachment.unwrap().to_string())
    );
    assert!(candidate["media"].is_object(), "a ready picture");
    // The approval, its draft and the run.
    let approvals = approvals_of(&app, &a, run).await;
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].status, "pending");
    assert_eq!(approvals[0].payload["action"]["id"], "expression.create");
    let drafts = drafts_of(&app, &a).await;
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].state, "ready");
    assert_eq!(drafts[0].pointer, attachment);
    assert_eq!(run_status(&su, run).await, "awaiting_approval");
    assert_eq!(ledger_rows(&su, run).await, 1, "the tokens were spent");
    let reason: Option<String> = sqlx::query_scalar(
        "SELECT last_error FROM outbox WHERE kind = 'agent_job' AND (payload->>'run_id')::uuid = $1",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .unwrap();
    let _ = reason;
    assert_no_picture_anywhere(&su, &a).await;
    // The other tenant sees none of it.
    assert!(agent_messages(&app, &b).await.is_empty());
    assert!(drafts_of(&app, &b).await.is_empty());
    assert!(approvals_of(&app, &b, run).await.is_empty());
}

/// A job re-claimed after a transient failure finds its run `failed` (the between-attempts mark): the
/// door still opens, and the card parks the run again — the retry is not silently skipped.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_retried_attempt_whose_run_reads_failed_still_raises_the_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    provider.say(answer(
        "다시 만들었어요",
        Some(&picture(48, 48)),
        Some(&still_request()),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 이 사진으로 (retry-4820)",
        Some(PHOTO),
    )
    .await;
    sqlx::query(
        "UPDATE agent_run SET status = 'failed', finished_at = now(), \
                error = '{\"code\":\"provider_failed\"}'::jsonb WHERE id = $1",
    )
    .bind(run)
    .execute(&su)
    .await
    .unwrap();
    let stats = drain(&w).await;
    assert_eq!(stats.claimed, 1, "{stats:?}");
    assert_eq!(provider.calls(), (1, 0), "the model was called");
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(is_card(&messages[0]));
    assert_eq!(messages[0].props["status"], "pending");
    assert_eq!(run_status(&su, run).await, "awaiting_approval");
    let error: Option<Value> = sqlx::query_scalar("SELECT error FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(
        error.is_none(),
        "the failed attempt's error went with its mark: {error:?}"
    );
}

/// A motion turn: the assembler's outputs are the candidates, in order, each one a `generated` draft of
/// the card; one built too large stays a hole in its own place with its code.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_motion_photo_turn_keeps_assembler_outputs_in_order_and_a_hole_stays_on_the_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;

    // Two presets that both fit.
    provider.say(answer(
        "움직이게 했어요",
        Some(&picture(512, 512)),
        Some(&preset_request(
            &["bounce", "pulse"],
            240,
            &[("jump-me", "통통"), ("beat-me", "두근")],
        )),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 움직이는 걸로 (motion-4820)",
        Some(PHOTO),
    )
    .await;
    drain(&w).await;
    let drafts = drafts_of(&app, &t).await;
    let mine: Vec<&Draft> = drafts.iter().filter(|d| d.name.ends_with("-me")).collect();
    assert_eq!(mine.len(), 2, "{drafts:?}");
    assert_eq!(
        (mine[0].index, mine[0].name.as_str(), mine[0].state.as_str()),
        (0, "jump-me", "ready")
    );
    assert_eq!(
        (mine[1].index, mine[1].name.as_str(), mine[1].state.as_str()),
        (1, "beat-me", "ready")
    );
    let card = &agent_messages(&app, &t).await[0];
    let candidates = card.props["action"]["expression"]["candidates"]
        .as_array()
        .unwrap();
    assert_eq!(candidates.len(), 2);
    for candidate in candidates {
        assert_eq!(
            candidate["media"]["large"]["mime"], "image/gif",
            "{candidate}"
        );
    }
    assert_eq!(candidates[0]["media"]["large"]["frameCount"], 16);
    assert_eq!(candidates[1]["media"]["large"]["frameCount"], 12);
    assert_eq!(approvals_of(&app, &t, run).await.len(), 1);
    assert_eq!(run_status(&su, run).await, "awaiting_approval");

    // A hole: `sparkle` on noise breaks the small rendition's cap while the other two fit.
    let t2 = seed(&su).await;
    pin_env(&su, &t2).await;
    provider.say(answer(
        "세 가지 해 봤어요",
        Some(&noise()),
        Some(&preset_request(
            &["pulse", "bounce", "sparkle"],
            240,
            &[("a-pulse", "하나"), ("a-bounce", "둘"), ("a-sparkle", "셋")],
        )),
    ));
    let (run2, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t2,
        "@hermes 세 가지 (hole-4820)",
        Some(PHOTO),
    )
    .await;
    drain(&w).await;
    let drafts = drafts_of(&app, &t2).await;
    assert_eq!(drafts.len(), 3, "{drafts:?}");
    assert_eq!(
        drafts
            .iter()
            .map(|d| (d.state.as_str(), d.code.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("ready", None),
            ("ready", None),
            ("manual_upload_required", Some("assembly_output_too_large")),
        ]
    );
    let card = &agent_messages(&app, &t2).await[0];
    let candidates = card.props["action"]["expression"]["candidates"]
        .as_array()
        .unwrap();
    assert_eq!(candidates[2]["code"], "assembly_output_too_large");
    assert!(candidates[2]["media"].is_null());
    assert_eq!(run_status(&su, run2).await, "awaiting_approval");
}

/// Every way the picture or the motion can fail, as a table: exactly one **closed** card — an
/// approval-shaped message with the closed status, `props.code` and the golden sentence as its body —
/// no draft, the approval ended `cancelled` with no decider, the run delivered, the tokens recorded.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn every_failure_is_one_closed_card_with_the_golden_line() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();

    // A real file Hermes could not have turned into a picture: a `MEDIA:` line and a `file://` image
    // that name it must be ignored, never opened.
    let on_disk = std::path::Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("local-{}.png", Uuid::new_v4()));
    std::fs::write(&on_disk, picture(64, 64)).unwrap();
    let local_path = on_disk.display().to_string();

    let svg = "![](data:image/svg+xml;base64,PHN2Zy8+)";
    let not_an_image = "![](data:image/png;base64,AAAAAAAA)";
    let too_big = format!(
        "![](data:image/png;base64,{})",
        "A".repeat(momo_workspace_actions::hosted_expression::PICTURE_B64_MAX_CHARS + 1)
    );
    let two = format!(
        "{}\n{}",
        markdown_of(&picture(32, 32)),
        markdown_of(&picture(32, 32))
    );
    let sparkle_only = preset_request(&["sparkle"], 240, &[("big-star", "별")]);
    let one_preset = preset_request(&["bounce"], 240, &[("jump-me", "통통")]);

    struct Case {
        what: &'static str,
        text: String,
        code: &'static str,
        opts: Opts,
        busy: bool,
    }
    let strict = Opts {
        origin: Some(ORIGIN),
        strict: true,
        ..Opts::default()
    };
    let cases = vec![
        Case {
            what: "no picture at all",
            text: format!("만들지 못했어요\n\n{}", fenced(&still_request())),
            code: "generation_failed",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "a MEDIA line and a file address naming a REAL local file are never opened",
            text: format!(
                "MEDIA:{local_path}\n![x](file://{local_path})\n![y]({local_path})\n\n{}",
                fenced(&still_request())
            ),
            code: "generation_failed",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "two pictures",
            text: format!("{two}\n\n{}", fenced(&still_request())),
            code: "assembly_source_invalid",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "another format",
            text: format!("{svg}\n\n{}", fenced(&still_request())),
            code: "assembly_source_invalid",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "base64 that is not a picture",
            text: format!("{not_an_image}\n\n{}", fenced(&one_preset)),
            code: "assembly_source_invalid",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "longer than five MiB",
            text: format!("{too_big}\n\n{}", fenced(&still_request())),
            code: "assembly_source_too_large",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "every candidate built too large",
            text: format!("{}\n\n{}", markdown_of(&noise()), fenced(&sparkle_only)),
            code: "assembly_output_too_large",
            opts: strict.clone(),
            busy: false,
        },
        Case {
            what: "the assembler is killed by a limit",
            text: format!(
                "{}\n\n{}",
                markdown_of(&picture(64, 64)),
                fenced(&one_preset)
            ),
            code: "assembly_timeout",
            opts: Opts {
                assembler: Some(script("signalled", "kill -9 $$")),
                ..strict.clone()
            },
            busy: false,
        },
        Case {
            what: "both decoder slots taken",
            text: format!(
                "{}\n\n{}",
                markdown_of(&picture(64, 64)),
                fenced(&one_preset)
            ),
            code: "assembly_busy",
            opts: strict.clone(),
            busy: true,
        },
    ];
    let mut seen_codes = std::collections::BTreeSet::new();
    for case in cases {
        let t = seed(&su).await;
        pin_env(&su, &t).await;
        let w = worker(&provider, &case.opts).await;
        provider.say(case.text.clone());
        let (run, _, _) = enqueue_mention(
            &su,
            &worker_pool,
            &t,
            &format!("@hermes 만들어 줘 ({})", case.code),
            Some(PHOTO),
        )
        .await;
        // Holding both slots of the process-wide semaphore is what a busy server looks like.
        let held = if case.busy {
            Some(
                momo_expressions::media::decoder_slots()
                    .acquire_many_owned(2)
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let stats = drain(&w).await;
        drop(held);
        assert_eq!(stats.answered, 1, "{}: {stats:?}", case.what);

        let messages = agent_messages(&app, &t).await;
        assert_eq!(messages.len(), 1, "{}: {messages:?}", case.what);
        let card = &messages[0];
        assert!(is_card(card), "{}", case.what);
        assert_eq!(
            card.body.as_deref(),
            Some(golden_line(case.code)),
            "{}",
            case.what
        );
        assert_eq!(card.props["code"], case.code, "{}", case.what);
        assert_eq!(card.props["status"], "cancelled", "{}", case.what);
        assert_eq!(card.props["approval_status"], "cancelled", "{}", case.what);
        assert_eq!(card.props["decision_reason"], case.code, "{}", case.what);
        assert_eq!(
            card.props["summary"],
            golden_line(case.code),
            "{}",
            case.what
        );
        assert!(card.props["decided_by"].is_null(), "{}", case.what);
        if case.code == "assembly_output_too_large" {
            assert!(
                card.props["bytes"].as_u64().is_some_and(|bytes| bytes > 0),
                "the measured size rides the card: {}",
                card.props
            );
        }
        let approvals = approvals_of(&app, &t, run).await;
        assert_eq!(approvals.len(), 1, "{}", case.what);
        assert_eq!(approvals[0].status, "cancelled", "{}", case.what);
        assert_eq!(approvals[0].decided_by, None, "{}", case.what);
        assert_eq!(
            approvals[0].reason.as_deref(),
            Some(case.code),
            "{}",
            case.what
        );
        assert!(drafts_of(&app, &t).await.is_empty(), "{}", case.what);
        assert_eq!(run_status(&su, run).await, "succeeded", "{}", case.what);
        assert_eq!(ledger_rows(&su, run).await, 1, "{}", case.what);
        assert_no_picture_anywhere(&su, &t).await;
        seen_codes.insert(case.code);
    }
    // All six card codes were produced by something real.
    let all: std::collections::BTreeSet<&str> = GOLDEN.iter().map(|(code, _)| *code).collect();
    assert_eq!(seen_codes, all);
}

/// An assembler that cannot run (no limit killed it, it simply failed) is the operator's fault: no
/// card, no code dressed up as the picture's — the turn is retried.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_assembler_that_cannot_run_is_a_retry_and_never_a_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            assembler: Some(script("broken", "exit 3")),
        },
    )
    .await;
    provider.say(answer(
        "움직이게 했어요",
        Some(&picture(64, 64)),
        Some(&preset_request(&["bounce"], 240, &[("jump-me", "통통")])),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 움직이게 (outage-4820)",
        Some(PHOTO),
    )
    .await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.requeued), (1, 1), "{stats:?}");
    assert!(
        agent_messages(&app, &t).await.iter().all(|m| !is_card(m)),
        "no card for an operator fault"
    );
    assert!(approvals_of(&app, &t, run).await.is_empty());
    assert!(drafts_of(&app, &t).await.is_empty());
}

/// No block, two blocks, a malformed block, a block that names the photo itself: the door stays shut
/// and the turn ends as an ordinary answer — whose text has no picture, no `MEDIA:` line and no block.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn no_valid_request_block_is_an_ordinary_answer_without_picture_marker_or_block() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    let png = picture(80, 80);
    let valid = still_request();
    let two = format!("{}\n\n{}", fenced(&valid), fenced(&valid));
    let pointer = valid.replacen(
        "\"v\":1",
        "\"v\":1,\"sourceAttachmentId\":\"00000000-0000-4000-8000-000000000009\"",
        1,
    );
    let cases: Vec<(&str, String)> = vec![
        ("no block", answer("그림만 만들었어요", Some(&png), None)),
        (
            "two blocks",
            format!("두 번 썼어요\n\n{}\n\n{}", markdown_of(&png), two),
        ),
        (
            "malformed block",
            answer("깨졌어요", Some(&png), Some("{not json")),
        ),
        (
            "a block that names the photo",
            answer("원본을 적었어요", Some(&png), Some(&pointer)),
        ),
    ];
    for (what, text) in cases {
        let t = seed(&su).await;
        pin_env(&su, &t).await;
        provider.say(format!("{text}\nMEDIA:/opt/data/cache/images/x.png"));
        let (run, _, _) = enqueue_mention(
            &su,
            &worker_pool,
            &t,
            &format!("@hermes 만들어 ({what})"),
            Some(PHOTO),
        )
        .await;
        drain(&w).await;
        let messages = agent_messages(&app, &t).await;
        assert_eq!(messages.len(), 1, "{what}: {messages:?}");
        assert_eq!(messages[0].kind, "text", "{what}");
        let body = messages[0].body.clone().unwrap_or_default();
        assert!(
            !body.is_empty() && body.len() < 200,
            "{what}: {} bytes",
            body.len()
        );
        assert!(approvals_of(&app, &t, run).await.is_empty(), "{what}");
        assert!(drafts_of(&app, &t).await.is_empty(), "{what}");
        assert_eq!(run_status(&su, run).await, "succeeded", "{what}");
        assert_no_picture_anywhere(&su, &t).await;
    }
}

/// A turn without a photo is byte-for-byte what it was — even when its answer happens to carry a picture
/// and a request block, which are then plain text — and so is a photo turn of an agent that is not the
/// co-hosted one, and a photo the requester's rule refuses (here: over the 5 MiB ceiling).
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_turn_without_a_photo_is_unchanged_and_the_requesters_own_photo_rule_holds() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    let verbatim = answer(
        "그냥 답이에요",
        Some(&picture(16, 16)),
        Some(&still_request()),
    );

    // 1. Pinned to the co-hosted Hermes, no photo.
    let plain = seed(&su).await;
    pin_env(&su, &plain).await;
    provider.say(verbatim.clone());
    enqueue_mention(
        &su,
        &worker_pool,
        &plain,
        "@hermes 사진 없이 (nophoto-4820)",
        None,
    )
    .await;
    drain(&w).await;
    assert_eq!(provider.calls(), (0, 1), "an ordinary turn streams");
    let messages = agent_messages(&app, &plain).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].kind, "text");
    assert_eq!(
        messages[0].body.as_deref(),
        Some(verbatim.as_str()),
        "verbatim"
    );
    let request = request_for(&provider.requests(), "nophoto-4820").clone();
    assert!(
        request
            .iter()
            .all(|m| !m.content.contains("oort-expression")),
        "no directive on a turn without a photo"
    );

    // 2. A photo, but the agent is not pinned to the co-hosted Hermes.
    let unpinned = seed(&su).await;
    provider.say(verbatim.clone());
    let before = provider.calls();
    enqueue_mention(
        &su,
        &worker_pool,
        &unpinned,
        "@hermes 핀 없이 (nopin-4820)",
        Some(PHOTO),
    )
    .await;
    drain(&w).await;
    let after = provider.calls();
    let messages = agent_messages(&app, &unpinned).await;
    assert!(
        messages.iter().all(|m| !is_card(m)),
        "an unpinned agent never opens the door: {messages:?}"
    );
    // Whatever the unpinned turn did, it did not take the door's non-streaming call.
    assert_eq!(after.0, before.0, "no plain call: {before:?} -> {after:?}");

    // 3. The co-hosted agent and a photo the requester's rule refuses: six MiB is over the ceiling.
    let big = seed(&su).await;
    pin_env(&su, &big).await;
    provider.say(verbatim.clone());
    let before = provider.calls();
    enqueue_mention(
        &su,
        &worker_pool,
        &big,
        "@hermes 큰 사진 (bigphoto-4820)",
        Some(Photo {
            size_bytes: 6 * 1024 * 1024,
        }),
    )
    .await;
    drain(&w).await;
    let after = provider.calls();
    assert_eq!(
        after.0, before.0,
        "the door did not open for a photo the rule refuses"
    );
    let messages = agent_messages(&app, &big).await;
    assert!(messages.iter().all(|m| !is_card(m)), "{messages:?}");

    // 4. The requester asked and then left the conversation before the turn ran: the rule that the
    //    person who asked is **in** the conversation is the door's, not a courtesy.
    let left = seed(&su).await;
    pin_env(&su, &left).await;
    provider.say(verbatim.clone());
    enqueue_mention(
        &su,
        &worker_pool,
        &left,
        "@hermes 떠난 사람 (left-4820)",
        Some(PHOTO),
    )
    .await;
    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(left.workspace_id)
    .bind(left.channel_id)
    .bind(left.human_id)
    .execute(&su)
    .await
    .expect("the requester leaves");
    let before = provider.calls();
    drain(&w).await;
    let after = provider.calls();
    assert_eq!(
        after.0, before.0,
        "the door did not open for a requester who left"
    );
    let messages = agent_messages(&app, &left).await;
    assert!(messages.iter().all(|m| !is_card(m)), "{messages:?}");
}

/// The ceiling of waiting cards is judged **before** the model is called: with all three waiting, the
/// provider is never asked, the person is told in one sentence, and nothing new is written.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_cheap_refusals_come_before_the_model() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    // Three cards of this agent already wait.
    for n in 0..3 {
        add_waiting_card(&worker_pool, &t, &format!("앞선 요청 {n}")).await;
    }
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 또 만들어 (capped-4820)",
        Some(PHOTO),
    )
    .await;
    drain(&w).await;
    assert_eq!(provider.calls(), (0, 0), "the model was never called");
    assert!(provider.requests().is_empty());
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert_eq!(messages[0].kind, "text");
    assert_eq!(
        messages[0].body.as_deref(),
        Some("승인을 기다리는 카드가 이미 많아요. 먼저 처리해 주세요.")
    );
    assert!(
        approvals_of(&app, &t, run).await.is_empty(),
        "no new approval"
    );
    assert!(drafts_of(&app, &t).await.is_empty());
    assert_eq!(
        ledger_rows(&su, run).await,
        1,
        "one ledger row, from the ordinary commit"
    );
}

/// Without the operator's attestation the door is **shut and the turn is an ordinary one** (planner
/// 10-31): the model is called the way it always was — streaming, once, without the door's instruction —
/// nothing in the answer is read as a picture or a request (no card, no approval, no draft), the answer
/// is committed as it is, and the run succeeds. A shut door does not even look for the photo: with the
/// attachment table out of the way (and no origin, so no address is minted either) the shut door answers
/// while the attested one cannot — the attested door is the positive control that the missing table
/// really would have stopped a probe.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn without_the_operators_strict_attestation_the_door_is_shut_and_the_turn_is_an_ordinary_one()
{
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: false,
            ..Opts::default()
        },
    )
    .await;
    // Exactly what an open door would take apart into a card: a picture and one request block.
    let door_style = answer("만들었어요", Some(&picture(32, 32)), Some(&still_request()));
    provider.say(door_style.clone());
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 이 사진으로 (shut-4820)",
        Some(PHOTO),
    )
    .await;
    let stats = drain(&w).await;
    assert_eq!(
        (stats.claimed, stats.answered, stats.failed),
        (1, 1, 0),
        "{stats:?}"
    );
    assert_eq!(
        provider.calls(),
        (0, 1),
        "the model is called the ordinary way: streaming, once"
    );
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(!is_card(&messages[0]), "no failure card: {:?}", messages[0]);
    assert_eq!(
        messages[0].body.as_deref(),
        Some(door_style.as_str()),
        "committed as it is: a shut door reads nothing in the answer"
    );
    assert!(approvals_of(&app, &t, run).await.is_empty(), "no approval");
    assert!(drafts_of(&app, &t).await.is_empty(), "no draft");
    assert_eq!(run_status(&su, run).await, "succeeded");
    assert_eq!(
        ledger_rows(&su, run).await,
        1,
        "one ledger row, the ordinary commit's"
    );
    let requests = provider.requests();
    let request = request_for(&requests, "shut-4820");
    assert!(
        !request
            .iter()
            .any(|m| m.content.contains("oort-expression")),
        "the door's instruction is not in a shut door's request"
    );
    // C2a's photo address is the self-media variable's, not the door's: with the origin set it still
    // rides the turn (the door is the only thing that is off).
    assert!(
        request
            .iter()
            .any(|m| m.content.contains("/v1/self-media/")),
        "the address line is C2a's and unchanged"
    );

    // A turn without a photo is the same ordinary turn as before.
    provider.say("그냥 답이에요");
    enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 사진 없이 (shut-text-4820)",
        None,
    )
    .await;
    drain(&w).await;
    assert_eq!(provider.calls(), (0, 2), "an ordinary turn streams");
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].body.as_deref(), Some("그냥 답이에요"));

    // The shut door does not look for the photo. A second tenant, no origin (nothing else reads the
    // attachment table for this turn), the table renamed away while the worker runs.
    let t2 = seed(&su).await;
    pin_env(&su, &t2).await;
    let (run2, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t2,
        "@hermes 사진을 안 찾아요 (shut-probe-4820)",
        Some(PHOTO),
    )
    .await;
    async fn without_attachments<T>(su: &PgPool, work: impl std::future::Future<Output = T>) -> T {
        sqlx::query("ALTER TABLE attachment RENAME TO attachment_away")
            .execute(su)
            .await
            .unwrap();
        let out = work.await;
        sqlx::query("ALTER TABLE attachment_away RENAME TO attachment")
            .execute(su)
            .await
            .unwrap();
        out
    }
    let shut_provider = Scripted::new();
    shut_provider.say("사진을 찾지 않고 평소처럼 답했어요");
    let shut_worker = worker(&shut_provider, &Opts::default()).await;
    let shut = without_attachments(&su, shut_worker.drain_once())
        .await
        .expect("drain");
    assert_eq!(
        (shut.claimed, shut.answered, shut.requeued),
        (1, 1, 0),
        "a shut door answers without the attachment table: {shut:?}"
    );
    assert_eq!(shut_provider.calls(), (0, 1));
    assert_eq!(run_status(&su, run2).await, "succeeded");

    // Positive control: the same missing table does stop the attested door's probe (the turn is retried
    // and the model is not called), so the shut door above really did not read it.
    let (run3, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t2,
        "@hermes 사진을 찾아요 (open-probe-4820)",
        Some(PHOTO),
    )
    .await;
    let open_provider = Scripted::new();
    let open_worker = worker(
        &open_provider,
        &Opts {
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    let open = without_attachments(&su, open_worker.drain_once())
        .await
        .expect("drain");
    assert_eq!(
        (open.claimed, open.requeued, open.answered),
        (1, 1, 0),
        "the attested door probes the photo and cannot: {open:?}"
    );
    assert_eq!(open_provider.calls(), (0, 0), "no model call");
    assert_ne!(run_status(&su, run3).await, "succeeded");
}

/// The photo is recorded as the picture's source **only** when the model was handed the address of
/// it this turn: with no origin configured no address is minted, the model never saw the photo, and a
/// pointer would claim a lineage that is not true.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_source_pointer_is_recorded_only_when_the_model_was_given_the_photo() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    for (origin, expects_pointer) in [(Some(ORIGIN), true), (None, false)] {
        let t = seed(&su).await;
        pin_env(&su, &t).await;
        let w = worker(
            &provider,
            &Opts {
                origin,
                strict: true,
                ..Opts::default()
            },
        )
        .await;
        provider.say(answer(
            "만들었어요",
            Some(&picture(48, 48)),
            Some(&still_request()),
        ));
        let (_, _, attachment) = enqueue_mention(
            &su,
            &worker_pool,
            &t,
            &format!("@hermes 이 사진으로 (pointer-{expects_pointer}-4820)"),
            Some(PHOTO),
        )
        .await;
        drain(&w).await;
        let drafts = drafts_of(&app, &t).await;
        assert_eq!(drafts.len(), 1, "{drafts:?}");
        assert_eq!(
            drafts[0].pointer,
            expects_pointer.then(|| attachment.unwrap())
        );
        let card = &agent_messages(&app, &t).await[0];
        let shown = &card.props["action"]["expression"]["candidates"][0]["origin"];
        assert!(
            shown.get("sourceAttachmentId").is_some(),
            "the key is always there: {shown}"
        );
        assert_eq!(
            shown["sourceAttachmentId"],
            match expects_pointer {
                true => json!(attachment.unwrap().to_string()),
                false => Value::Null,
            }
        );
    }
}

/// A photo turn's request has exactly one message more than an otherwise identical turn without a
/// photo once the C2a address line is set aside — the directive — and the directive is the only
/// difference.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_directive_is_exactly_one_more_message_on_a_photo_turn() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let with = seed(&su).await;
    let without = seed(&su).await;
    pin_env(&su, &with).await;
    pin_env(&su, &without).await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    enqueue_mention(
        &su,
        &worker_pool,
        &with,
        "@hermes 같은 말 (same-with-4820)",
        Some(PHOTO),
    )
    .await;
    provider.say("답이에요");
    enqueue_mention(
        &su,
        &worker_pool,
        &without,
        "@hermes 같은 말 (same-without-4820)",
        None,
    )
    .await;
    drain(&w).await;
    let requests = provider.requests();
    let photo_turn = request_for(&requests, "same-with-4820").clone();
    let text_turn = request_for(&requests, "same-without-4820").clone();
    let mut photo_turn: Vec<ChatMessage> = photo_turn
        .into_iter()
        .filter(|m| !m.content.contains("/v1/self-media/"))
        .collect();
    let directive: Vec<&ChatMessage> = photo_turn
        .iter()
        .filter(|m| m.content.contains("oort-expression"))
        .collect();
    assert_eq!(directive.len(), 1, "exactly one directive message");
    assert_eq!(
        photo_turn.len(),
        text_turn.len() + 1,
        "exactly one more message"
    );
    photo_turn.retain(|m| !m.content.contains("oort-expression"));
    let text_bodies = |messages: &[ChatMessage]| -> Vec<String> {
        messages
            .iter()
            .map(|m| {
                m.content
                    .replace("same-with-4820", "same")
                    .replace("same-without-4820", "same")
            })
            .collect()
    };
    assert_eq!(
        text_bodies(&photo_turn),
        text_bodies(&text_turn),
        "the directive is the only difference"
    );
}

// --- #4820 C2b review: guards that had no test, retries that cost, an answer too long to hold -------

/// The ceiling of waiting cards is judged before the model **and again inside the proposal**. With two
/// waiting the gate before the model sees room and the model is called; while it works, a third card of
/// the agent lands (the model call is held open here, so the order is not a race). The proposal's own
/// proof of the ceiling refuses: no card, no draft, never a fourth waiting — and the person is told in
/// one sentence.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_third_card_that_lands_while_the_model_works_is_refused_by_the_proposal() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    for n in 0..2 {
        add_waiting_card(&worker_pool, &t, &format!("앞선 요청 {n}")).await;
    }
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 하나 더 (landing-4820)",
        Some(PHOTO),
    )
    .await;
    assert_eq!(waiting_cards(&su, &t).await, 2, "room for exactly one more");

    let hold = Arc::new(Hold::default());
    provider.hold_next_call(&hold);
    let landing = async {
        // The worker is inside the model call now: the third card lands behind its back.
        hold.entered.notified().await;
        add_waiting_card(&worker_pool, &t, "끼어든 요청").await;
        hold.release.notify_one();
    };
    let (stats, ()) = tokio::join!(drain(&w), landing);
    assert_eq!(stats.claimed, 1, "{stats:?}");

    assert_eq!(
        provider.calls(),
        (1, 0),
        "the gate before the model saw room, so the model was called"
    );
    assert!(
        approvals_of(&app, &t, run).await.is_empty(),
        "the proposal's own proof refused: no card for this run"
    );
    assert!(drafts_of(&app, &t).await.is_empty());
    assert_eq!(
        waiting_cards(&su, &t).await,
        3,
        "the ceiling of three held: no fourth card"
    );
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(!is_card(&messages[0]));
    assert_eq!(
        messages[0].body.as_deref(),
        Some("승인을 기다리는 카드가 이미 많아요. 먼저 처리해 주세요."),
        "told in one sentence"
    );
    assert_eq!(run_status(&su, run).await, "succeeded");
    assert_eq!(ledger_rows(&su, run).await, 1, "the tokens were spent");
    assert_no_picture_anywhere(&su, &t).await;
}

/// A run that is not a live, running one is refused **before** the model is called. The table is every
/// state a job can find its run in once the run is over or parked: the model call is the one thing that
/// costs, and the proposal (or the commit) would refuse such a run afterwards in any case — so the
/// *only* thing that tells the gate from its absence is whether the model was asked.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_run_that_is_not_live_is_refused_before_the_model_is_called() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    for status in ["cancelled", "succeeded", "awaiting_approval"] {
        let t = seed(&su).await;
        pin_env(&su, &t).await;
        let (run, _, _) = enqueue_mention(
            &su,
            &worker_pool,
            &t,
            &format!("@hermes 이 사진으로 ({status}-gate-4820)"),
            Some(PHOTO),
        )
        .await;
        // Written directly, not through the cancel route: the job stays claimable, as the race of a
        // person cancelling while the job is claimed leaves it.
        sqlx::query(
            "UPDATE agent_run \
                SET status = $2::text::run_status, \
                    finished_at = CASE WHEN $2::text IN ('succeeded', 'cancelled') THEN now() END, \
                    deadline_at = CASE WHEN $2::text = 'awaiting_approval' \
                                       THEN now() + interval '1 hour' END \
              WHERE id = $1",
        )
        .bind(run)
        .bind(status)
        .execute(&su)
        .await
        .unwrap();
        let before = provider.calls();
        let stats = drain(&w).await;
        assert_eq!(stats.claimed, 1, "{status}: {stats:?}");
        assert_eq!(
            provider.calls(),
            before,
            "{status}: the model was not called for a run that is not live"
        );
        let messages = agent_messages(&app, &t).await;
        assert!(
            messages.is_empty(),
            "{status}: nothing was said, nothing raised: {messages:?}"
        );
        assert!(approvals_of(&app, &t, run).await.is_empty(), "{status}");
        assert!(drafts_of(&app, &t).await.is_empty(), "{status}");
        assert_eq!(
            run_status(&su, run).await,
            status,
            "{status}: the run was left as it was"
        );
        let (_, job_status, reason) = job_of(&su, run).await;
        assert_eq!(job_status, "done", "{status}");
        assert_eq!(
            reason.as_deref(),
            Some("hosted_door_run_not_usable"),
            "{status}: settled by the door's own refusal"
        );
        assert_eq!(ledger_rows(&su, run).await, 0, "{status}: no tokens spent");
    }
}

/// The turn that continues a run after a person approved a card is a **resume** turn; its run's trigger
/// is still the photo message. The door must not open for it: it would harvest and propose again — a
/// card about a card — for every approval. A resume is an ordinary streamed turn (the directive is not
/// even in its context), and nothing is raised.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_resume_turn_never_opens_the_door() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    // What the model would say if the door were open: a picture and a valid request.
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 이 사진으로 (resume-4820)",
        Some(PHOTO),
    )
    .await;
    // The job an approval's 승인 enqueues for this run: `resume_approval`, carrying the approval it
    // resumes from. (The run itself is `queued` again, which is what the approval route leaves.)
    let resumed = sqlx::query(
        "UPDATE outbox SET method = 'resume_approval', \
                payload = payload || jsonb_build_object('resume_from_approval_id', gen_random_uuid()::text) \
          WHERE kind = 'agent_job' AND (payload->>'run_id')::uuid = $1",
    )
    .bind(run)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(resumed.rows_affected(), 1);

    let stats = drain(&w).await;
    assert_eq!(stats.claimed, 1, "{stats:?}");
    assert_eq!(
        provider.calls(),
        (0, 1),
        "a resume is an ordinary streamed turn: the door's non-streaming call was not made"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]
            .iter()
            .all(|m| !m.content.contains("oort-expression")),
        "no directive in a resume turn's context"
    );
    assert!(
        approvals_of(&app, &t, run).await.is_empty(),
        "no card, no failure card"
    );
    assert!(drafts_of(&app, &t).await.is_empty());
    let messages = agent_messages(&app, &t).await;
    assert!(messages.iter().all(|m| !is_card(m)), "{messages:?}");
    assert_eq!(run_status(&su, run).await, "succeeded");
}

/// An assembler that cannot run is retried **once**, not seven times: every attempt asks Hermes for a
/// new picture. The first attempt is requeued (its tokens already on the ledger, no card); the second is
/// the last and ends as one closed `generation_failed` card with the run delivered; a third attempt
/// never happens — and the run has one card, one approval and one ledger row throughout.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_assembler_that_cannot_run_gets_two_attempts_and_ends_as_one_closed_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            assembler: Some(script("broken-twice", "exit 3")),
        },
    )
    .await;
    provider.say(answer(
        "움직이게 했어요",
        Some(&picture(64, 64)),
        Some(&preset_request(&["bounce"], 240, &[("jump-me", "통통")])),
    ));
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "@hermes 움직이게 (twice-4820)",
        Some(PHOTO),
    )
    .await;
    let (job_id, _, _) = job_of(&su, run).await;

    // Attempt 1: no card for an operator fault; requeued; the tokens that paid for the picture are
    // on the ledger already.
    let stats = w.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.requeued), (1, 1), "{stats:?}");
    assert!(agent_messages(&app, &t).await.iter().all(|m| !is_card(m)));
    assert!(approvals_of(&app, &t, run).await.is_empty());
    assert_eq!(
        ledger_of(&su, run).await,
        vec![(120, 40, false)],
        "the first attempt's measured tokens"
    );
    assert_eq!(
        run_status(&su, run).await,
        "failed",
        "the between-attempts mark"
    );

    // Attempt 2: the last. One closed card, the run delivered, still one ledger row.
    let_the_backoff_end(&su, job_id).await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.answered), (1, 1), "{stats:?}");
    assert_eq!(
        provider.calls(),
        (2, 0),
        "exactly two attempts asked the model"
    );
    let messages = agent_messages(&app, &t).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    let card = &messages[0];
    assert!(is_card(card));
    assert_eq!(card.props["code"], "generation_failed");
    assert_eq!(card.body.as_deref(), Some(golden_line("generation_failed")));
    assert_eq!(card.props["status"], "cancelled");
    assert!(card.props["decided_by"].is_null());
    let approvals = approvals_of(&app, &t, run).await;
    assert_eq!(approvals.len(), 1, "one approval, one card");
    assert_eq!(approvals[0].status, "cancelled");
    assert_eq!(approvals[0].decided_by, None);
    assert!(drafts_of(&app, &t).await.is_empty());
    assert_eq!(run_status(&su, run).await, "succeeded");
    assert_eq!(
        ledger_of(&su, run).await,
        vec![(120, 40, false)],
        "still the one row: a retry never double-charges"
    );
    let (_, job_status, reason) = job_of(&su, run).await;
    assert_eq!(job_status, "done");
    assert_eq!(reason.as_deref(), Some("generation_failed"));

    // Attempt 3 does not exist: even with every backoff ended there is nothing to claim.
    let_the_backoff_end(&su, job_id).await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 0, "{stats:?}");
    assert_eq!(provider.calls(), (2, 0));
    assert_eq!(agent_messages(&app, &t).await.len(), 1);
    assert_no_picture_anywhere(&su, &t).await;
}

/// The provider's deadline is the other failure that costs a picture per attempt: two attempts, then
/// one closed card. An **outage** (the provider refusing connections) is not that: it never produced a
/// picture, so it keeps the ordinary budget — three failures in a row still end in a card of the answer.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_provider_deadline_gets_two_attempts_but_an_outage_keeps_its_budget() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;

    // 1. A deadline, twice.
    let slow = seed(&su).await;
    pin_env(&su, &slow).await;
    provider.say(answer(
        "만들었어요",
        Some(&picture(32, 32)),
        Some(&still_request()),
    ));
    provider.fail_next(vec![
        ProviderError::TimedOut("operation timed out".into()),
        ProviderError::TimedOut("operation timed out".into()),
    ]);
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &slow,
        "@hermes 이 사진으로 (slow-4820)",
        Some(PHOTO),
    )
    .await;
    let (job_id, _, _) = job_of(&su, run).await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.requeued), (1, 1), "{stats:?}");
    assert!(agent_messages(&app, &slow).await.is_empty(), "no card yet");
    assert!(
        ledger_of(&su, run).await.is_empty(),
        "nothing came back, so there is nothing to record"
    );
    let_the_backoff_end(&su, job_id).await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.answered), (1, 1), "{stats:?}");
    assert_eq!(provider.calls(), (2, 0), "two attempts, no third");
    let messages = agent_messages(&app, &slow).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(is_card(&messages[0]));
    assert_eq!(messages[0].props["code"], "generation_failed");
    assert_eq!(messages[0].props["status"], "cancelled");
    assert_eq!(approvals_of(&app, &slow, run).await.len(), 1);
    assert_eq!(run_status(&su, run).await, "succeeded");
    assert_eq!(
        ledger_of(&su, run).await,
        vec![(0, 0, true)],
        "one estimated row: the model was asked and reported nothing"
    );
    let_the_backoff_end(&su, job_id).await;
    let stats = w.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 0, "{stats:?}");
    assert_eq!(provider.calls(), (2, 0));

    // 2. An outage, twice, and then the provider is back: the third attempt raises the card.
    let down = seed(&su).await;
    pin_env(&su, &down).await;
    provider.fail_next(vec![
        ProviderError::Unreachable("connection refused".into()),
        ProviderError::Unreachable("connection refused".into()),
    ]);
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &down,
        "@hermes 이 사진으로 (down-4820)",
        Some(PHOTO),
    )
    .await;
    let (job_id, _, _) = job_of(&su, run).await;
    let before = provider.calls().0;
    for attempt in 1..=2 {
        let stats = w.drain_once().await.expect("drain");
        assert_eq!(
            (stats.claimed, stats.requeued),
            (1, 1),
            "attempt {attempt} of an outage is requeued: {stats:?}"
        );
        assert!(agent_messages(&app, &down).await.is_empty());
        let_the_backoff_end(&su, job_id).await;
    }
    w.drain_once().await.expect("drain");
    assert_eq!(provider.calls().0 - before, 3, "the outage kept its budget");
    let messages = agent_messages(&app, &down).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(is_card(&messages[0]));
    assert_eq!(
        messages[0].props["status"], "pending",
        "the third attempt raised the card of the answer"
    );
    assert_eq!(run_status(&su, run).await, "awaiting_approval");
}

/// An answer over the size limit is not read (the provider layer says so); for a door turn that is one
/// closed `generation_failed` card — no retry, the run delivered, one estimated ledger row, nothing of
/// the answer anywhere. Anywhere else it is the ordinary, non-retried provider failure, exactly as it
/// is for any other non-retryable error.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_answer_over_the_size_limit_is_one_closed_card_on_a_door_turn_and_the_ordinary_failure_elsewhere(
) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let provider = Scripted::new();
    let w = worker(
        &provider,
        &Opts {
            origin: Some(ORIGIN),
            strict: true,
            ..Opts::default()
        },
    )
    .await;
    let too_large = || ProviderError::BodyTooLarge {
        limit: momo_agent_worker::provider::RESPONSE_BODY_MAX_BYTES,
    };

    // A door turn.
    let door = seed(&su).await;
    pin_env(&su, &door).await;
    provider.fail_next(vec![too_large()]);
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &door,
        "@hermes 이 사진으로 (huge-door-4820)",
        Some(PHOTO),
    )
    .await;
    let stats = drain(&w).await;
    assert_eq!((stats.claimed, stats.answered), (1, 1), "{stats:?}");
    assert_eq!(
        provider.calls(),
        (1, 0),
        "not retried: the same answer would come back"
    );
    let messages = agent_messages(&app, &door).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    let card = &messages[0];
    assert!(is_card(card));
    assert_eq!(card.props["code"], "generation_failed");
    assert_eq!(card.body.as_deref(), Some(golden_line("generation_failed")));
    assert_eq!(card.props["status"], "cancelled");
    assert_eq!(card.props["decision_reason"], "generation_failed");
    let approvals = approvals_of(&app, &door, run).await;
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].status, "cancelled");
    assert!(drafts_of(&app, &door).await.is_empty());
    assert_eq!(run_status(&su, run).await, "succeeded");
    assert_eq!(ledger_of(&su, run).await, vec![(0, 0, true)]);
    let (_, job_status, reason) = job_of(&su, run).await;
    assert_eq!(
        (job_status.as_str(), reason.as_deref()),
        ("done", Some("generation_failed"))
    );
    assert_no_picture_anywhere(&su, &door).await;

    // An ordinary turn (no photo): the same error is the generic provider failure, not a card.
    let plain = seed(&su).await;
    pin_env(&su, &plain).await;
    provider.fail_next(vec![too_large()]);
    let before = provider.calls();
    let (run, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &plain,
        "@hermes 사진 없이 (huge-plain-4820)",
        None,
    )
    .await;
    let stats = drain(&w).await;
    assert_eq!((stats.claimed, stats.failed), (1, 1), "{stats:?}");
    let after = provider.calls();
    assert_eq!(
        (after.0 - before.0, after.1 - before.1),
        (0, 1),
        "one streamed attempt, no retry"
    );
    let messages = agent_messages(&app, &plain).await;
    assert!(messages.iter().all(|m| !is_card(m)), "{messages:?}");
    assert_eq!(run_status(&su, run).await, "failed");
    let (_, job_status, _) = job_of(&su, run).await;
    assert_eq!(job_status, "failed");
}
