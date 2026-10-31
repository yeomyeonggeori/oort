//! #4820 C2a — the photo address in the co-hosted Hermes' request (ADR-0218 증보 G4·G8).
//!
//! DB-backed and `#[ignore]`d like its siblings; run against an isolated PG18:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26821/postgres \
//!   cargo test -p momo-agent-worker --test self_media_context_pg -- --ignored --test-threads=1
//! ```
//!
//! Real worker iterations (the BYPASSRLS `momo_worker` role, a tenant tx for the mint) against a
//! recording provider; the address is then redeemed as the non-bypass `momo_app`.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_turn_with_a_photo_gets_one_address_line_and_a_turn_without_does_not` | no line / a line for a text-only turn / a second line / a token in the outbox payload |
//! | `only_the_co_hosted_pin_with_a_canonical_origin_gets_the_line` | mint for an unpinned agent; mint with no or a non-canonical origin |
//! | `a_provider_error_that_echoes_the_address_leaves_no_token_anywhere` | drop `redact_self_media_urls` from `redact_secrets` |
//! | `a_mint_database_error_retries_the_turn_and_never_runs_it_without_the_photo` | swallow the mint error and call the model without the photo |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{
    ChatCompletion, ChatMessage, ChatProvider, ChatRequest, MockChatProvider, ProviderEndpoint,
    ProviderError,
};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_provider_link_admin_tx, with_tenant_tx, PgPool};
use momo_messaging::{redeem_in_tx, send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{upsert_agent_pin, PinKind, ProviderConfig, ProviderMode};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const ENV_URL: &str = "http://hermes.railway.internal:8642/v1";
const ENV_BEARER: &str = "hermes-env-4820-g7h8i9";
const ORIGIN: &str = "https://oort.example.com";
const LINE_HEAD: &str = "첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, 5분 뒤 만료: ";

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
        .bind(format!("c4820-{}", &t.channel_id.simple().to_string()[..8]))
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

/// A mention turn exactly as the send route freezes it, written by the human requester with `body`.
/// With `photo` a complete PNG is bound to that very message (the request's own picture).
/// Returns `(run id, trigger message id, drive file id of the photo if any)`.
async fn enqueue_mention(
    su: &PgPool,
    pool: &PgPool,
    t: &Tenant,
    body: &str,
    photo: bool,
) -> (Uuid, Uuid, Option<String>) {
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
    let drive_file = if photo {
        let id = Uuid::new_v4();
        let drive_file = format!("drive-file-{id}");
        sqlx::query(
            "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
             drive_file_id, name, mime, size_bytes, status) \
             VALUES ($1, $2, $3, $4, $5, $6, 'photo', 'image/png', 4096, 'complete')",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(human)
        .bind(message)
        .bind(&drive_file)
        .execute(su)
        .await
        .expect("photo attachment");
        Some(drive_file)
    } else {
        None
    };
    (run, message, drive_file)
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

/// Records every request; either answers like the echo mock or fails with an error body that
/// echoes the photo address it was handed (what a picture tool's error text may do).
struct Probe {
    inner: MockChatProvider,
    fail_echoing_the_address: bool,
    seen: Mutex<Vec<Vec<ChatMessage>>>,
}

impl Probe {
    fn answering() -> Arc<Probe> {
        Arc::new(Probe {
            inner: MockChatProvider::echo(),
            fail_echoing_the_address: false,
            seen: Mutex::new(Vec::new()),
        })
    }

    fn failing_with_the_address() -> Arc<Probe> {
        Arc::new(Probe {
            inner: MockChatProvider::echo(),
            fail_echoing_the_address: true,
            seen: Mutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> Vec<Vec<ChatMessage>> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl ChatProvider for Probe {
    async fn complete(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ChatRequest,
    ) -> Result<ChatCompletion, ProviderError> {
        self.seen.lock().unwrap().push(request.messages.clone());
        if self.fail_echoing_the_address {
            let address = request
                .messages
                .iter()
                .find_map(|m| m.content.strip_prefix(LINE_HEAD))
                .unwrap_or("no address in the request");
            return Err(ProviderError::HttpStatus(
                502,
                format!("image tool could not fetch {address} (status 404)"),
            ));
        }
        self.inner.complete(endpoint, request).await
    }
}

async fn worker(provider: &Arc<Probe>, origin: Option<&str>) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some("conformance-4820-master".to_string());
    config.provider = env_link();
    // #4820 C2b 2부: these tests are about the photo address, and a photo turn of the co-hosted Hermes is a
    // hosted-door turn. The operator's strict-media attestation is what lets such a turn run at all (without
    // it the door answers with one failure card and calls no model — `hosted_door_pg` measures that).
    config = config.with_hosted_media_strict(true);
    if let Some(origin) = origin {
        config = config.with_self_media_origin(origin);
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

/// The request that answered the trigger message with `body` (each test's bodies are unique).
fn request_for<'a>(requests: &'a [Vec<ChatMessage>], body: &str) -> &'a Vec<ChatMessage> {
    requests
        .iter()
        .find(|messages| messages.iter().any(|m| m.content.contains(body)))
        .unwrap_or_else(|| panic!("no request carried {body:?}"))
}

fn address_lines(messages: &[ChatMessage]) -> Vec<&ChatMessage> {
    messages
        .iter()
        .filter(|m| m.content.contains("/v1/self-media/"))
        .collect()
}

async fn token_rows(su: &PgPool, run: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM self_media_token WHERE run_id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .unwrap()
}

// --- behaviour ---------------------------------------------------------------

/// The comparison the contract asks for: the request of a turn whose trigger message carries a photo
/// has exactly one more line than an otherwise identical text-only turn, and that line is the
/// sentence, the configured origin, the run's workspace and a live token bound to that photo. The
/// token never reaches the outbox payload.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_turn_with_a_photo_gets_one_address_line_and_a_turn_without_does_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;

    let (run_with, _, drive_file) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "이 사진으로 이모티콘 만들어줘 P4820",
        true,
    )
    .await;
    let (run_without, _, _) = enqueue_mention(
        &su,
        &worker_pool,
        &t,
        "텍스트만으로 이모티콘 만들어줘 N4820",
        false,
    )
    .await;
    let provider = Probe::answering();
    let w = worker(&provider, Some(ORIGIN)).await;
    assert_eq!(drain(&w).await.answered, 2);

    let requests = provider.requests();
    let with = request_for(&requests, "P4820");
    let without = request_for(&requests, "N4820");
    let lines = address_lines(with);
    assert_eq!(lines.len(), 1, "exactly one address line: {with:?}");
    assert_eq!(lines[0].role, "system");
    let prefix = format!("{LINE_HEAD}{ORIGIN}/v1/self-media/{}/", t.workspace_id);
    let token = lines[0].content.strip_prefix(&prefix).unwrap_or_else(|| {
        panic!(
            "the line is the sentence + origin + workspace: {}",
            lines[0].content
        )
    });
    assert_eq!(token.len(), 43, "a 43-character token ends the line");
    assert!(
        address_lines(without).is_empty(),
        "a text-only turn carries no address"
    );
    // C2b 2부: a photo turn of the co-hosted Hermes also carries the hosted door's directive (one more
    // `system` block, measured in `hosted_door_pg`). Set it aside and the C2a rule is what it was.
    let without_directive = with
        .iter()
        .filter(|m| !m.content.contains("oort-expression"))
        .count();
    assert_eq!(
        without_directive,
        without.len() + 1,
        "the photo turn has exactly one more message than the text-only turn (the address line)"
    );
    assert_eq!(token_rows(&su, run_with).await, 1);
    assert_eq!(token_rows(&su, run_without).await, 0);

    // The address is live and bound to that very photo: the non-bypass role redeems it once. (The
    // run has already finished, so the in-flight rule would refuse it now — re-open the run first.)
    sqlx::query("UPDATE agent_run SET status = 'running'::run_status WHERE id = $1")
        .bind(run_with)
        .execute(&su)
        .await
        .unwrap();
    let ws = t.workspace_id;
    let token_owned = token.to_string();
    let redeemed = with_tenant_tx(&app, ws, move |conn| {
        let token = token_owned.clone();
        Box::pin(async move { redeem_in_tx(conn, ws, &token).await })
    })
    .await
    .unwrap()
    .expect("the minted address redeems");
    assert_eq!(Some(redeemed.drive_file_id), drive_file);

    // The token is nowhere in the outbox (payload or error) and not in the run record.
    let leaks: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 \
           AND (payload::text LIKE '%self-media%' OR payload::text LIKE '%' || $2 || '%' \
                OR coalesce(last_error, '') LIKE '%' || $2 || '%')",
    )
    .bind(t.workspace_id)
    .bind(token)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(leaks, 0, "no token and no address in any outbox row");
}

/// Only the agent pinned to the operator's env link (the co-hosted Hermes) is handed an address, and
/// only when the origin is configured in the canonical shape: every other turn mints nothing.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn only_the_co_hosted_pin_with_a_canonical_origin_gets_the_line() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;

    for (label, pinned, origin) in [
        (
            "an agent that is not pinned to the co-hosted Hermes",
            false,
            Some(ORIGIN),
        ),
        ("no origin configured", true, None),
        ("a trailing slash", true, Some("https://oort.example.com/")),
        ("an uppercase host", true, Some("https://OORT.example.com")),
        (
            "a default port written out",
            true,
            Some("https://oort.example.com:443"),
        ),
        ("a plain http origin", true, Some("http://oort.example.com")),
    ] {
        reset_instance(&su).await;
        let t = seed(&su).await;
        if pinned {
            pin_env(&su, &t).await;
        }
        let (run, _, _) =
            enqueue_mention(&su, &worker_pool, &t, "사진으로 만들어줘 X4820", true).await;
        let provider = Probe::answering();
        let w = worker(&provider, origin).await;
        assert_eq!(drain(&w).await.answered, 1, "{label}");
        let requests = provider.requests();
        assert_eq!(requests.len(), 1, "{label}");
        assert!(
            address_lines(&requests[0]).is_empty(),
            "{label}: no address line"
        );
        assert_eq!(token_rows(&su, run).await, 0, "{label}: nothing minted");
    }

    // and the positive control for the same fixture shape
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let (run, _, _) = enqueue_mention(&su, &worker_pool, &t, "사진으로 만들어줘 Y4820", true).await;
    let provider = Probe::answering();
    let w = worker(&provider, Some("https://oort.example.com:8443")).await;
    assert_eq!(drain(&w).await.answered, 1);
    let requests = provider.requests();
    let lines = address_lines(&requests[0]);
    assert_eq!(lines.len(), 1);
    assert!(lines[0]
        .content
        .contains("https://oort.example.com:8443/v1/self-media/"));
    assert_eq!(token_rows(&su, run).await, 1);
    reset_instance(&su).await;
}

/// A picture tool's error body may echo the address it could not fetch. The sentence that reaches
/// `outbox.last_error`, the run's error and the log keeps its words and loses the token.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_provider_error_that_echoes_the_address_leaves_no_token_anywhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let (run, _, _) = enqueue_mention(&su, &worker_pool, &t, "사진으로 만들어줘 E4820", true).await;

    let captured = CapturedLogs::install();
    let provider = Probe::failing_with_the_address();
    let w = worker(&provider, Some(ORIGIN)).await;
    let stats = drain(&w).await;
    assert_eq!(stats.answered, 0, "the provider failed: {stats:?}");

    let requests = provider.requests();
    assert!(!requests.is_empty(), "the model was called");
    let line = address_lines(&requests[0])[0].content.clone();
    let token = line.rsplit('/').next().unwrap().to_string();
    assert_eq!(token.len(), 43);

    let errors: Vec<String> = sqlx::query_scalar(
        "SELECT coalesce(last_error, '') FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND payload->>'run_id' = $2",
    )
    .bind(t.workspace_id)
    .bind(run.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    let run_error: String =
        sqlx::query_scalar("SELECT coalesce(error::text, '') FROM agent_run WHERE id = $1")
            .bind(run)
            .fetch_one(&su)
            .await
            .unwrap();
    let logs = captured.text();
    assert!(!errors.is_empty());
    for (what, text) in [
        ("outbox.last_error", errors.join("\n")),
        ("agent_run.error", run_error),
        ("the worker log", logs),
    ] {
        assert!(!text.contains(&token), "{what} carries the token: {text}");
    }
    assert!(
        errors
            .iter()
            .any(|e| e.contains("/v1/self-media/") && e.contains("<redacted>")),
        "the scrub kept the sentence and replaced only the token: {errors:?}"
    );
}

/// A database error while minting is transient: the turn is requeued and the model is never called
/// without the photo it was asked about; once the table is back the same job runs with the line.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_mint_database_error_retries_the_turn_and_never_runs_it_without_the_photo() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    pin_env(&su, &t).await;
    let worker_pool = pool_as("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await;
    let (run, _, _) = enqueue_mention(&su, &worker_pool, &t, "사진으로 만들어줘 D4820", true).await;

    sqlx::query("ALTER TABLE self_media_token RENAME TO self_media_token_away")
        .execute(&su)
        .await
        .unwrap();
    let provider = Probe::answering();
    let w = worker(&provider, Some(ORIGIN)).await;
    let first = w.drain_once().await;
    sqlx::query("ALTER TABLE self_media_token_away RENAME TO self_media_token")
        .execute(&su)
        .await
        .unwrap();
    let first = first.expect("drain");
    assert_eq!(first.claimed, 1);
    assert_eq!(first.requeued, 1, "the turn is requeued: {first:?}");
    assert!(
        provider.requests().is_empty(),
        "the model was not called without the photo"
    );
    let last_error: Option<String> = sqlx::query_scalar(
        "SELECT last_error FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job' \
          AND payload->>'run_id' = $2",
    )
    .bind(t.workspace_id)
    .bind(run.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        last_error
            .unwrap_or_default()
            .contains("self media address not minted"),
        "the retry names why"
    );

    // the job becomes claimable again after its backoff: make it so, then it runs with the line
    sqlx::query(
        "UPDATE outbox SET available_at = now() - interval '1 second', status = 'pending' \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND payload->>'run_id' = $2",
    )
    .bind(t.workspace_id)
    .bind(run.to_string())
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(drain(&w).await.answered, 1);
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(address_lines(&requests[0]).len(), 1, "now with the line");
    reset_instance(&su).await;
}

// --- a capturing log sink (a real subscriber, not a grep over files) -----------

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct CapturedLogs {
    sink: Sink,
    _guard: tracing::subscriber::DefaultGuard,
}

impl CapturedLogs {
    fn install() -> CapturedLogs {
        let sink = Sink::default();
        let writer = sink.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        CapturedLogs {
            sink,
            _guard: tracing::subscriber::set_default(subscriber),
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.sink.0.lock().unwrap()).to_string()
    }
}
