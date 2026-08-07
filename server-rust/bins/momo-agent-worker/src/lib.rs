//! `momo-agent-worker` — `agent_job` → LLM → the agent's reply (ADR-0145 B안,
//! batch B5.1).
//!
//! Semantic parity with Swift `workers/AgentWorker/.../WorkerService.swift`.
//! One turn is:
//!
//! 1. **claim** — [`momo_outbox::claim_agent_job_batch`] takes pending
//!    `kind='agent_job' AND method='publish'` rows `FOR UPDATE SKIP LOCKED`,
//!    at most one per `partition_key` (= `agent_member_id`), and flips them to
//!    `processing` in the same statement. Loss-free (it depends only on commit
//!    visibility); a high-water-mark cursor is forbidden (L4 §3.5).
//! 2. **resolve the provider** — the operator's `provider_link` row when it is
//!    present, decryptable and usable, else the env transport (ADR-0004 증보 1
//!    P-1b, Swift `ProviderLinkResolution`). The bearer exists in memory only
//!    between the decrypt and the request.
//! 3. **call** — one POST to the wire the resolved credential names: the
//!    OpenAI-compatible `/chat/completions` for a bearer link (and for the env
//!    fallback), the OpenAI `/responses` wire for an ADR-0147 subscription OAuth
//!    link (see [`provider::ProviderWire`], [`responses`]).
//! 4. **write the answer through the message spine** —
//!    [`momo_messaging::send_message_in_tx`], authored by the agent's own
//!    `member.id`. There is no agent branch in that path: an agent is a member
//!    (invariant #5), so its reply gets a `channel_seq` bump, a `message.seq`,
//!    and a broadcast outbox row exactly like a human's. The reply reaches
//!    clients through relay → Centrifugo; **this binary publishes nothing**
//!    (invariant #2).
//! 5. **transition + bill** — [`momo_agent::finish_run_in_tx`] and
//!    [`momo_agent::record_run_usage_in_tx`], in the **same transaction** as
//!    the message, so a run can never be `succeeded` without the answer that
//!    justifies it, and can never be billed twice.
//! 6. **settle** — `done`; a retryable provider failure → `pending` with
//!    exponential backoff; exhaustion or a non-retryable failure → `failed`,
//!    with a user-visible message in the channel first (Swift
//!    `degradedProviderMessage`).
//!
//! Wakeups are `LISTEN outbox` (the schema's `outbox_notify_trg` fires
//! `pg_notify('outbox', kind)` AFTER INSERT) with a poll ticker as the fallback,
//! so a missed NOTIFY costs latency, never delivery.
//!
//! ## Scope guards this crate keeps
//!
//! * **No SQL of its own.** The claim/settle statements are `momo-outbox`'s, the
//!   message is `momo-messaging`'s, the run and the ledger are `momo-agent`'s,
//!   the `provider_link` read is `momo-settings`'. Invariant #3 and invariant #6
//!   both stay single-chokepoint.
//! * **Outbound HTTP to the LLM provider only.** That call is this binary's
//!   whole purpose (the Swift AgentWorker does the same). It never calls
//!   momo-server, and it never publishes to Centrifugo.
//! * **No credential in a log, a row, or a message.** See [`redact_secrets`].
//!
//! ## B7.2 — the turn can now delegate
//!
//! Step 4 grew a fifth statement in the same transaction: if the answer the
//! agent just wrote **mentions another agent**, [`a2a`] creates that agent's run
//! with `parent_run_id` = this run and `depth` = this run's + 1, and enqueues
//! its job. That is the piece B5.2 could not have — the HTTP send path has no
//! source run, so it refuses an agent-authored mention outright
//! (`a2a_source_run_unavailable`) rather than create a depth-0 child the hop cap
//! could not bound.
//!
//! Everything that makes it safe is in [`momo_agent::a2a`] and is evaluated
//! *before* the child exists: the §3.3 gates G1/G2/G3, the §3.4 `a2a_depth` hop
//! cap, and a per-root-trigger spend ceiling summed over the whole delegation
//! tree. A refusal is a system line in the channel plus an audit row — never a
//! failed turn, because the answer is already written and the person who asked
//! for it is not the one who misconfigured a third agent.
//!
//! ## Deliberately not in B5.1/B7.2
//!
//! Streaming/`agent.partial`, tool calls and the approval gate, G4's SimHash
//! semantic-loop detector (a stub in Swift too), the §8.5 budget reserve/trip,
//! the memory plane, and ACP/coding agents. Each is named in the PR body's
//! deviation list with what it costs.

pub mod a2a;
pub mod config;
pub mod context;
pub mod oauth;
pub mod partial;
pub mod payload;
pub mod provider;
pub mod responses;
pub mod stream;
pub mod tool_exec;

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use a2a::{route_a2a_mentions_in_tx, A2aSend};
use momo_agent::approval::{
    approval_payload, approval_request_body, approval_request_props, attach_request_message_in_tx,
    create_pending_approval_in_tx, default_expires_at, NewApproval,
};
use momo_agent::tools::{
    ApprovalReason, ToolCall, ACTION_TYPE_TOOL_CALL, TOOL_AUDIT_SCHEMA, WORK_SESSION_SPAWN,
};
use momo_agent::{
    approval_reason, consume_run_step_in_tx, finish_run_in_tx, lock_gateway_run_in_tx,
    mark_run_started_in_tx, park_run_for_approval_in_tx, record_run_usage_in_tx,
    GatewayRunSnapshot, RunStatus, RunUsageReport, AUDIT_APPROVAL_REQUESTED,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx::postgres::PgListener;
use momo_db::{with_tenant_tx, DbError, PgConnection, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{
    backoff_seconds, claim_agent_job_batch, mark_done, mark_failed, requeue, ClaimedAgentJob,
    NOTIFY_CHANNEL,
};
use momo_settings::{
    decrypt_link, read_link, reseal_link_credential, resolve_link, seal_bearer, LinkCredential,
    OpenAiOAuthCredential, ProviderSource,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

pub use config::WorkerConfig;
use context::{assemble, now_context_block};
use oauth::{relogin_message, HttpTokenRefresher, RefreshError, TokenRefresher, EXPIRY_SKEW_MS};
use payload::AgentJobPayload;
use provider::{
    http_provider, ChatProvider, ChatRequest, ChatUsage, ProviderEndpoint, ProviderError,
    ProviderToolCall, ProviderWire,
};
use tool_exec::ToolContext;

/// What the producer transaction decided about one tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolDisposition {
    /// An approval exists and the run is parked on it.
    Parked { approval_id: Uuid },
    /// G6 exempted the call, or ADR-0114 D5's `work_auto_approve` pre-authorised
    /// it; run it now.
    ///
    /// `authorized_by` is the human whose standing permission opened the gate,
    /// and `host_id` the host their default resolved to — both `None` for a G6
    /// read-only exemption, where no human was involved at all and the agent's
    /// own membership is the only authority that exists.
    RunNow {
        authorized_by: Option<Uuid>,
        host_id: Option<Uuid>,
    },
    /// G3's budget is spent. The loop stops here.
    StepExhausted,
}

/// What a `work.session.spawn` approval needs to know before it is raised.
#[derive(Debug, Clone)]
struct SpawnExecution {
    /// The `execution` object the approval payload and card carry.
    execution: serde_json::Value,
    /// The human the agent acts for — the session's owner, and the member the
    /// candidate list was judged for.
    owner_member_id: Uuid,
    default_host_id: Option<Uuid>,
    /// ADR-0114 D5 opened the gate; no card is raised.
    auto_approved: bool,
}

/// Carry a `T3Error` across into the worker's `DbError` channel.
///
/// Only the `Db` arm is a database failure; the rest are domain refusals that
/// cannot arise on these reads (they are pure `SELECT`s). Mapping them to a
/// protocol error keeps the transaction rolling back rather than committing a
/// half-raised approval.
fn t3_as_db(error: momo_t3::T3Error) -> DbError {
    match error {
        momo_t3::T3Error::Db(inner) => inner,
        other => DbError::Sqlx(momo_db::sqlx::Error::Protocol(other.to_string())),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("database error: {0}")]
    Db(#[from] DbError),
    #[error("outbox claim failed: {0}")]
    Claim(#[from] momo_db::sqlx::Error),
    #[error("provider client build failed: {0}")]
    Http(#[from] reqwest::Error),
}

/// What one drain iteration did — the unit the conformance tests assert on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DrainStats {
    pub claimed: usize,
    /// Turns that committed an agent reply + a succeeded run + a ledger row.
    pub answered: usize,
    /// Jobs handed back to `pending` with a backoff (retryable provider failure).
    pub requeued: usize,
    /// Jobs settled `failed` — poison payload, exhausted retries, or a
    /// non-retryable provider answer.
    pub failed: usize,
    /// Jobs settled `done` without an answer: no run, a cancelled run, or an
    /// agent that is no longer eligible in the channel.
    pub skipped: usize,
    /// B7.2: child runs this drain created because an answer mentioned another
    /// agent. Counted separately from `answered` because one turn can delegate
    /// to several agents, or to none.
    pub delegated: usize,
    /// B7.2: delegations a cap refused — the number that must stop growing when
    /// a loop is running.
    pub a2a_blocked: usize,
}

/// The message a user sees when the provider could not answer.
///
/// Swift `WorkerService.degradedProviderMessage` (:2748-2752) was ported
/// verbatim in B5.1, and the QA sweep found what it actually reads like inside
/// a channel: an English sentence naming an internal codename ("Hermes"), an
/// operator instruction handed to someone who does not run the server, and the
/// provider's raw error pasted onto the end. On a 401 that tail was
/// `provider answered with HTTP 401 {"error":{"message":...}}`: raw JSON, in a
/// chat, addressed to nobody who could act on it.
///
/// The sentence is now one Korean line. The provider's own words are not
/// deleted, they are MOVED: the redacted reason goes to `agent_run.error.reason`
/// (the run record) and to `outbox.last_error`, which is where support reads it.
/// Keeping it out of the channel is the whole of goal B8 H2.
///
/// A turn that fails silently is still worse than one that says so, so this is
/// written on the timeline exactly where the answer would have been.
pub fn degraded_provider_message() -> &'static str {
    "지금은 답변을 만들지 못했습니다. 잠시 뒤에 다시 멘션해 주세요."
}

/// Strip anything credential-shaped out of a string that is about to be
/// persisted (`outbox.last_error`), shown to a user (the degraded message), or
/// logged.
///
/// Two shapes are removed, because both can genuinely appear in a provider
/// error string:
///
/// * **the resolved bearer itself** — `reqwest`'s `Display` does not print
///   headers, but a gateway is free to echo the token in its own error body,
///   which then rides `ProviderError::ErrorEnvelope` straight into a channel;
/// * **URL userinfo** (`scheme://user:pass@host`) — `reqwest`'s transport errors
///   *do* print the request URL, and an operator may have pasted credentials
///   into `provider_link.base_url`.
///
/// This is the last line of defence, not the only one: nothing upstream ever
/// puts the bearer in a payload, a row, or a log field (ADR-0004 Rules #2/#5).
pub fn redact_secrets(text: &str, bearer: &str) -> String {
    let mut out = text.to_string();
    let bearer = bearer.trim();
    if bearer.len() >= 4 {
        out = out.replace(bearer, "<redacted>");
    }
    redact_url_userinfo(&out)
}

/// Rewrite every `scheme://user:pass@host` to `scheme://<redacted>@host`.
fn redact_url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_at) = rest.find("://") {
        let after_scheme = scheme_at + 3;
        // Userinfo ends at the first '@' before the authority terminator.
        let authority_end = rest[after_scheme..]
            .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace())
            .map(|offset| after_scheme + offset)
            .unwrap_or(rest.len());
        match rest[after_scheme..authority_end].find('@') {
            Some(offset) => {
                out.push_str(&rest[..after_scheme]);
                out.push_str("<redacted>@");
                rest = &rest[after_scheme + offset + 1..];
            }
            None => {
                out.push_str(&rest[..authority_end]);
                rest = &rest[authority_end..];
                // Nothing more to redact in this authority; keep scanning after it.
                if rest.is_empty() {
                    break;
                }
                let step = rest.chars().next().map(char::len_utf8).unwrap_or(1);
                out.push_str(&rest[..step]);
                rest = &rest[step..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Short-TTL cache in front of the per-job `provider_link` read + decrypt
/// (Swift `ProviderLinkCache`).
///
/// Reading and — especially — AES-GCM-decrypting the singleton on *every* job
/// would put a SHA-256 + AEAD open on the hot path. So: serve a cached answer
/// for the TTL; after it, issue one cheap `SELECT` and skip the decrypt entirely
/// when `updated_at` is unchanged. An operator's GUI change is picked up on the
/// first job after the window, never on a restart. A transient DB error keeps
/// the last-known value (fail safe, not fail blank).
struct ProviderLinkCache {
    entry: Mutex<Option<CachedLink>>,
    ttl: Duration,
}

struct CachedLink {
    /// `None` ⇒ absent / unusable / undecryptable ⇒ use env.
    resolved: Option<ResolvedLink>,
    updated_at_ms: Option<i64>,
    fetched_at: Instant,
}

/// The operator's link as this process resolved it: where to call, and what the
/// vault actually holds.
#[derive(Clone)]
struct ResolvedLink {
    endpoint: ProviderEndpoint,
    credential: LinkCredential,
}

/// Everything one turn needs to authenticate itself — and, for an ADR-0147 OAuth
/// link, to re-authenticate itself mid-turn.
///
/// The env fallback produces one of these too (a [`LinkCredential::Bearer`] with
/// no `link_updated_at_ms`), so the turn loop has exactly one shape to handle and
/// the OAuth path is not a second code path bolted alongside it.
pub struct ResolvedTransport {
    pub endpoint: ProviderEndpoint,
    credential: LinkCredential,
    /// The `provider_link.updated_at` this credential was read at — the guard a
    /// re-seal writes against. `None` when the credential came from env, which
    /// is also what makes "env links are never written back" structural.
    link_updated_at_ms: Option<i64>,
}

impl ResolvedTransport {
    fn oauth(&self) -> Option<&OpenAiOAuthCredential> {
        self.credential.as_openai_oauth()
    }

    pub fn is_oauth(&self) -> bool {
        self.oauth().is_some()
    }

    /// Which wire this turn will speak (B5.4b) — the endpoint's, so there is one
    /// answer rather than a second derivation that could disagree with it.
    pub fn wire(&self) -> ProviderWire {
        self.endpoint.wire
    }

    /// Is the access token missing or (nearly) dead? Always `false` for a legacy
    /// bearer, which has no lifetime to reason about.
    pub fn needs_refresh(&self, now_ms: i64) -> bool {
        self.oauth()
            .is_some_and(|credential| credential.needs_refresh(now_ms, EXPIRY_SKEW_MS))
    }
}

pub struct AgentWorker {
    pool: PgPool,
    provider: Arc<dyn ChatProvider>,
    /// The OAuth token endpoint client (ADR-0147 결정 2). A seam, so the
    /// conformance suite can point it at its own server rather than the internet.
    refresher: Arc<dyn TokenRefresher>,
    config: WorkerConfig,
    link_cache: ProviderLinkCache,
}

impl AgentWorker {
    /// Build a worker with its own pool. The connection string must be the
    /// BYPASSRLS `momo_worker` role: the worker drains every tenant, which is
    /// exactly why it is a separate credential from the API's `momo_app`.
    pub async fn connect(config: WorkerConfig) -> Result<AgentWorker, WorkerError> {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.database_url)
            .await?;
        // Both wires, routed by the sealed envelope kind (B5.4b). A binary that
        // built only one adapter would answer every OAuth turn with a 404 from
        // the wrong path, which reads as "the model is missing".
        let provider = http_provider(config.request_timeout)?;
        let refresher = Arc::new(HttpTokenRefresher::new(config.request_timeout));
        Ok(AgentWorker::with_refresher(
            pool, provider, refresher, config,
        ))
    }

    /// Build from an existing pool + provider (conformance tests), with the real
    /// token endpoint client.
    pub fn new(pool: PgPool, provider: Arc<dyn ChatProvider>, config: WorkerConfig) -> AgentWorker {
        let refresher = Arc::new(HttpTokenRefresher::new(config.request_timeout));
        AgentWorker::with_refresher(pool, provider, refresher, config)
    }

    /// Build with both outbound seams supplied — the shape the OAuth conformance
    /// suite uses to point the refresh at its own in-test token endpoint.
    pub fn with_refresher(
        pool: PgPool,
        provider: Arc<dyn ChatProvider>,
        refresher: Arc<dyn TokenRefresher>,
        config: WorkerConfig,
    ) -> AgentWorker {
        let ttl = Duration::from_millis(2_000);
        AgentWorker {
            pool,
            provider,
            refresher,
            config,
            link_cache: ProviderLinkCache {
                entry: Mutex::new(None),
                ttl,
            },
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn config(&self) -> &WorkerConfig {
        &self.config
    }

    /// Claim one batch and run every job in it. Returns what happened.
    pub async fn drain_once(&self) -> Result<DrainStats, WorkerError> {
        let claimed = claim_agent_job_batch(
            &self.pool,
            self.config.claim_batch_size,
            self.config.lease_seconds,
        )
        .await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for job in claimed {
            match self.process(job).await {
                Settlement::Answered { delegated, blocked } => {
                    stats.answered += 1;
                    stats.delegated += delegated;
                    stats.a2a_blocked += blocked;
                }
                Settlement::Requeued => stats.requeued += 1,
                Settlement::Failed => stats.failed += 1,
                Settlement::Skipped => stats.skipped += 1,
            }
        }
        Ok(stats)
    }

    /// Drain until a claim comes back short of a full batch (nothing runnable
    /// right now). Errors are logged, not propagated: the next tick retries.
    pub async fn drain_to_empty(&self) -> DrainStats {
        let mut total = DrainStats::default();
        loop {
            match self.drain_once().await {
                Ok(stats) => {
                    total.claimed += stats.claimed;
                    total.answered += stats.answered;
                    total.requeued += stats.requeued;
                    total.failed += stats.failed;
                    total.skipped += stats.skipped;
                    total.delegated += stats.delegated;
                    total.a2a_blocked += stats.a2a_blocked;
                    if (stats.claimed as i64) < self.config.claim_batch_size {
                        return total;
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "agent worker drain iteration failed");
                    return total;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // one job
    // -----------------------------------------------------------------------

    async fn process(&self, job: ClaimedAgentJob) -> Settlement {
        let payload: AgentJobPayload = match serde_json::from_str(&job.payload) {
            Ok(payload) => payload,
            Err(error) => {
                // A malformed payload can never succeed. Failing it permanently
                // is what stops one poison row from being re-claimed forever —
                // and, with per-agent serialization, from blocking every other
                // job for that agent behind it.
                tracing::error!(outbox_id = job.id, error = %error, "agent_job payload decode failed");
                self.settle_failed(job.id, &format!("payload decode: {error}"))
                    .await;
                return Settlement::Failed;
            }
        };

        tracing::info!(
            outbox_id = job.id,
            attempts = job.attempts,
            run_id = ?payload.run_id,
            agent_member_id = %payload.agent_member_id,
            channel_id = %payload.channel_id,
            "processing agent_job"
        );

        // A job without a run has no state machine to move and no ledger row to
        // write; Swift's `finalizeStreamingMessage` returns early on exactly
        // this condition (:2218), so an answer would be written into a channel
        // that nothing can attribute. Retire it instead.
        let Some(run_id) = payload.run_id else {
            tracing::warn!(outbox_id = job.id, "agent_job carries no run_id; skipping");
            self.settle_done(job.id, Some("no run_id")).await;
            return Settlement::Skipped;
        };

        let mut transport = self.resolve_transport().await;

        // queued → running. `false` is not an error: a run being retried after a
        // transient failure is still `failed` at this point, and its terminal
        // write below is what moves it. (Swift's claim UPDATE also admits
        // `failed`; the difference is only which status the row shows mid-turn.)
        let job_workspace_id = job.workspace_id;
        let started_address = momo_agent::AgentRunAddress {
            workspace_id: job.workspace_id,
            channel_id: payload.channel_id,
            agent_member_id: payload.agent_member_id,
            run_id,
        };
        let started = with_tenant_tx(&self.pool, job.workspace_id, move |conn| {
            Box::pin(async move {
                let started = mark_run_started_in_tx(conn, run_id).await?;
                // The rail learns the turn was picked up (goal SRV-B3d). Only
                // when the transition actually happened: a job re-claimed after
                // its lease expired finds the run already `running`, and
                // publishing a second `thinking` for it would reset the client's
                // liveness clock for work that has been going for minutes.
                if started {
                    emit_rail_frame(
                        conn,
                        job_workspace_id,
                        started_address.channel_id,
                        &momo_agent::progress_agent_status_payload(
                            started_address,
                            momo_agent::AgentPhase::Thinking,
                            now_ms(),
                            "thinking",
                        ),
                    )
                    .await?;
                }
                Ok(started)
            })
        })
        .await;
        match started {
            Ok(started) => tracing::debug!(run_id = %run_id, started, "run start transition"),
            Err(error) => {
                // A DB error here is transient by nature: do not run the turn.
                return self
                    .settle_retryable(
                        &job,
                        &format!("run start failed: {error}"),
                        &transport.endpoint,
                    )
                    .await;
            }
        }

        // goal B8 L7: the model is told what day it is, every turn, from this
        // process's clock plus the workspace offset. Computed here rather than
        // inside `assemble` so the assembler stays a pure function of its
        // arguments and its tests stay date-independent.
        // goal SRV-T1 — the resume half. This job exists because a human tapped
        // 승인; the tool runs first, its `tool_result` lands in the channel, and
        // the same turn then continues with that result in front of the model.
        // Running it here (before the context is assembled) is what lets the
        // answer be *about* what the tool did.
        let mut resumed_tool_note: Option<String> = None;
        if payload.is_resume() {
            match self.execute_approved_tool(&job, &payload, run_id).await {
                Ok(note) => resumed_tool_note = Some(note),
                Err(error) => {
                    return self
                        .settle_retryable(
                            &job,
                            &format!("approved tool execution failed: {error}"),
                            &transport.endpoint,
                        )
                        .await;
                }
            }
        }

        let now_context = now_context_block(now_ms(), self.config.utc_offset_minutes);
        let assembled = assemble(
            &payload.recent_messages,
            payload.agent_member_id,
            payload.trigger_message_id,
            &payload.prompt,
            payload.system_prompt.as_deref(),
            Some(now_context.as_str()),
            self.config.max_context_chars,
        );
        if assembled.dropped_count > 0 {
            // Count only — never log message bodies (redaction, L4 §7).
            tracing::info!(
                run_id = %run_id,
                dropped_count = assembled.dropped_count,
                max_chars = self.config.max_context_chars,
                "context window trimmed to budget"
            );
        }

        let mut messages = assembled.messages;
        if let Some(note) = &resumed_tool_note {
            // The tool's own words, handed back as the last thing the model saw.
            // A `user` turn rather than a bespoke `tool` role because this
            // worker's transcript vocabulary is system/user/assistant, and the
            // Responses wire maps a `tool` role to nothing at all.
            messages.push(provider::ChatMessage::user(note.clone()));
        }

        let request = ChatRequest {
            model: payload.model_or(&self.config.default_model).to_string(),
            messages,
            max_tokens: Some(
                payload
                    .max_output_tokens
                    .unwrap_or(self.config.max_output_tokens)
                    .max(1),
            ),
            // B5.2 has shipped `agent.tool_schema` on the payload since the
            // mention path was written; this is the batch that finally sends it.
            tools: payload.tool_schema(),
            // goal SRV-B3f: and the tools the profile turned on, resolved
            // against THIS build's catalog. Until this line `enabled_tools` was
            // a column nothing read — an operator could switch a tool on and the
            // only effect was a profile version bump.
            momo_tools: payload.enabled_tools(),
        };

        // ADR-0147 결정 2: a subscription OAuth link presents an access token
        // that dies on a timer. Minting it *before* the call — rather than
        // waiting for the 401 — is what keeps a turn that starts after the
        // deadline from costing the user a wasted round trip.
        let mut refreshed_this_turn = false;
        if transport.needs_refresh(now_ms()) {
            if let Err(error) = self.refresh_and_reseal(&mut transport).await {
                return self
                    .settle_refresh_failure(&job, &payload, run_id, &error, &transport)
                    .await;
            }
            refreshed_this_turn = true;
        }

        // goal SRV-B3e: the turn streams into a pump that publishes one
        // coalesced `agent.partial` per window. The sink is handed to the
        // provider; everything about batching, transactions and failure belongs
        // to the pump (see `partial`'s module header).
        let (sink, deltas) = partial::delta_channel();
        let pump = tokio::spawn(partial::run_partial_pump(
            self.pool.clone(),
            started_address,
            deltas,
            partial::PARTIAL_WINDOW,
        ));
        let mut attempt = self
            .provider
            .complete_streaming(&transport.endpoint, &request, &sink)
            .await;

        // A rejection on a token whose deadline still looked fine means the
        // provider retired it early — revoked, rotated elsewhere, or our clock
        // disagreed. Refresh and replay **at most once per turn**, and never
        // after the pre-flight refresh already ran: a token minted seconds ago
        // and rejected anyway is not an expiry problem, so spending a second
        // rotation on it would burn the subscription's budget to arrive at the
        // same 401. The rejection is reported instead, which is the honest answer.
        if transport.is_oauth() && !refreshed_this_turn && is_auth_rejection(&attempt) {
            tracing::info!(
                outbox_id = job.id,
                run_id = %run_id,
                "provider rejected the oauth access token; refreshing once and replaying"
            );
            match self.refresh_and_reseal(&mut transport).await {
                // Replayed WITHOUT the sink. The first attempt's slices are
                // already on the rail, and streaming the same answer twice
                // would make a reader watch it be typed out, erased and typed
                // again. The retry's text still becomes the durable message.
                Ok(()) => attempt = self.provider.complete(&transport.endpoint, &request).await,
                Err(error) => {
                    return self
                        .settle_refresh_failure(&job, &payload, run_id, &error, &transport)
                        .await
                }
            }
        }

        // The sink is dropped BEFORE the pump is awaited: closing the channel
        // is what tells the pump the stream is over and to flush its tail.
        drop(sink);
        let streamed_frames = pump.await.unwrap_or(0);
        if streamed_frames > 0 {
            tracing::debug!(run_id = %run_id, streamed_frames, "published agent.partial frames");
        }

        let completion = match attempt {
            // goal SRV-T1 narrows this arm by one word: no text **and no tool
            // calls**. A turn that only asks to run something is the normal
            // shape of a tool call, and before the tool channel existed this
            // check reported it as a provider outage.
            Ok(completion)
                if completion.text.trim().is_empty() && completion.tool_calls.is_empty() =>
            {
                // A 200 with no text is not an answer. Treating it as one would
                // commit an empty message and a `succeeded` run, which reads as
                // "the agent chose to say nothing".
                let reason = "provider returned no text";
                tracing::warn!(outbox_id = job.id, run_id = %run_id, reason, "empty completion");
                return self
                    .settle_terminal_failure(&job, &payload, run_id, reason, &transport.endpoint)
                    .await;
            }
            Ok(completion) => completion,
            Err(error) => {
                let reason = redact_secrets(&error.to_string(), &transport.endpoint.bearer);
                tracing::warn!(
                    outbox_id = job.id,
                    run_id = %run_id,
                    endpoint = %transport.endpoint.label(),
                    retryable = error.is_retryable(),
                    reason,
                    "provider call failed"
                );
                if error.is_retryable() {
                    return self
                        .settle_retryable(&job, &reason, &transport.endpoint)
                        .await;
                }
                return self
                    .settle_terminal_failure(&job, &payload, run_id, &reason, &transport.endpoint)
                    .await;
            }
        };

        // goal SRV-T1 — the producer. A turn that asked for a tool does not
        // write a text answer; it records the call, and either parks on a human
        // or runs it. This is where `INSERT INTO approval` finally happens.
        if let Some(call) = completion.tool_calls.first().cloned() {
            // goal SRV-B3e: name the tool on the rail before the approval lands.
            // A turn that asks for a tool writes no text, so without this the
            // badge would sit on 작업 중 with no headline through the whole
            // approval round trip — the reader can see *that* something is
            // happening and not *what*.
            let frame = momo_agent::agent_partial_tool_call_payload(
                started_address,
                &call.id,
                &call.name,
                now_ms(),
                "toolcall",
            );
            let workspace_id = job.workspace_id;
            let channel_id = started_address.channel_id;
            if let Err(error) = with_tenant_tx(&self.pool, workspace_id, move |conn| {
                Box::pin(
                    async move { emit_rail_frame(conn, workspace_id, channel_id, &frame).await },
                )
            })
            .await
            {
                // Same policy as every other partial: a lost hint is nothing,
                // and the approval this turn is about must not fail for it.
                tracing::debug!(run_id = %run_id, error = %error, "tool-call partial failed");
            }
            return self
                .handle_tool_call(&job, &payload, run_id, call, completion.usage, &transport)
                .await;
        }

        let usage = completion.usage;
        let body = completion.text;
        let props = success_props(&payload, run_id);

        // The message, the run transition and the ledger row commit together or
        // not at all: a `succeeded` run whose answer rolled back would be a lie
        // the user can see, and a ledger row without a run would be an unbilled
        // charge.
        let outcome = self
            .commit_turn(
                &job,
                &payload,
                run_id,
                body,
                props,
                usage,
                TurnOutcome::Succeeded,
                None,
            )
            .await;
        match outcome {
            Ok(TurnCommit::Committed { delegated, blocked }) => {
                tracing::info!(
                    outbox_id = job.id,
                    run_id = %run_id,
                    delegated,
                    a2a_blocked = blocked,
                    "agent turn committed"
                );
                self.settle_done(job.id, None).await;
                Settlement::Answered { delegated, blocked }
            }
            Ok(TurnCommit::Suppressed(reason)) => {
                tracing::info!(outbox_id = job.id, run_id = %run_id, reason, "agent turn suppressed");
                self.settle_done(job.id, Some(reason)).await;
                Settlement::Skipped
            }
            Err(error) => {
                // The provider was already paid for; a DB failure here is
                // transient, so retry rather than losing the turn.
                let reason = format!("turn commit failed: {error}");
                tracing::error!(outbox_id = job.id, run_id = %run_id, reason, "turn commit failed");
                self.settle_retryable(&job, &reason, &transport.endpoint)
                    .await
            }
        }
    }

    // -----------------------------------------------------------------------
    // goal SRV-T1 — tool calls and the approval gate
    // -----------------------------------------------------------------------

    /// The model asked to run a tool.
    ///
    /// Order matters and is the same in both arms:
    ///
    /// 1. **record the call** as a `type='tool_call'` message, through the
    ///    message spine — so it takes a real `channel_seq` bump, a real
    ///    `message.seq` and a real broadcast, like every other message
    ///    (invariants #2/#3/#4). A person watching the channel sees the agent
    ///    ask *before* anything is decided about it.
    /// 2. **spend a step** (`consume_run_step_in_tx`). This is G3's write half
    ///    and it is what bounds the tool loop: a run may make at most
    ///    `min(max_steps, MAX_STEPS)` tool calls, whatever the model wants,
    ///    because each resume comes back through here. Without it a model that
    ///    always answers with a tool call would loop until the lease died.
    /// 3. **judge it** with G6 ([`momo_agent::approval_reason`]), which fails
    ///    closed on missing or ambiguous grant metadata.
    ///
    /// Then either park the run on a human, or run it now.
    ///
    /// Only the **first** tool call of a turn is served. Parallel tool calls are
    /// a real provider feature and a real ordering problem — two approvals for
    /// one run, resumed independently, would need a join this batch has no
    /// design for — so the rest are refused by name in the `tool_result` rather
    /// than silently dropped.
    async fn handle_tool_call(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        call: ProviderToolCall,
        usage: Option<ChatUsage>,
        transport: &ResolvedTransport,
    ) -> Settlement {
        let tool_call = ToolCall {
            call_id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments_json(),
        };
        let reason = approval_reason(&call.name, payload.grants().as_deref());

        tracing::info!(
            outbox_id = job.id,
            run_id = %run_id,
            tool = %call.name,
            call_id = %call.id,
            approval_reason = reason.as_str(),
            requires_approval = reason.requires_approval(),
            "tool call from provider"
        );

        // (1) + (2) + (3): the record, the step, and — when a human is needed —
        // the approval, all in ONE transaction. A `tool_call` message with no
        // approval behind it would be an agent that appears to have asked for
        // permission nobody can grant.
        let outcome = self
            .record_tool_call(job, payload, run_id, &tool_call, &call.arguments, reason)
            .await;

        match outcome {
            Ok(ToolDisposition::Parked { approval_id }) => {
                tracing::info!(
                    outbox_id = job.id,
                    run_id = %run_id,
                    approval_id = %approval_id,
                    "run parked awaiting human approval"
                );
                self.settle_done(job.id, Some("awaiting approval")).await;
                Settlement::Skipped
            }
            Ok(ToolDisposition::StepExhausted) => {
                // G3 said no. The run ends rather than looping, and the channel
                // is told by the `tool_result` the same transaction wrote.
                self.mark_run_failed(job.workspace_id, run_id, "tool step cap reached")
                    .await;
                self.settle_done(job.id, Some("tool step cap reached"))
                    .await;
                Settlement::Skipped
            }
            Ok(ToolDisposition::RunNow {
                authorized_by,
                host_id,
            }) => {
                let context = ToolContext {
                    workspace_id: job.workspace_id,
                    run_id,
                    channel_id: payload.channel_id,
                    agent_member_id: payload.agent_member_id,
                    // A G6-exempt tool has no approver; it runs with the agent's
                    // own membership, which is the only authority that exists
                    // when no human was asked, and G6 only exempts read-only
                    // grants so that arm cannot reach a write. An
                    // auto-approved spawn is different: a **person** granted it
                    // in advance (`work_auto_approve`), and the row names them.
                    approved_by: authorized_by.unwrap_or(payload.agent_member_id),
                    approved_host_id: host_id,
                };
                match tool_exec::execute(&self.pool, &context, &tool_call).await {
                    Ok(result) => {
                        self.finish_tool_turn(job, payload, run_id, &result.output, usage)
                            .await
                    }
                    Err(error) => {
                        self.settle_retryable(
                            job,
                            &format!("tool execution failed: {error}"),
                            &transport.endpoint,
                        )
                        .await
                    }
                }
            }
            Err(error) => {
                let reason = format!("tool call record failed: {error}");
                tracing::error!(outbox_id = job.id, run_id = %run_id, reason, "tool call record failed");
                self.settle_retryable(job, &reason, &transport.endpoint)
                    .await
            }
        }
    }

    /// The producer transaction: `tool_call` message → step → (approval +
    /// `approval_request` message + `awaiting_approval` + audit).
    ///
    /// Port of Swift `WorkerService.recordApprovalPause` (:1607-1760), which
    /// states the protocol this keeps: "tool_call -> approval(status=pending) ->
    /// approval_request message -> agent_run(status=awaiting_approval) ->
    /// audit_log, all in one DB tx".
    async fn record_tool_call(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        call: &ToolCall,
        raw_arguments: &str,
        reason: ApprovalReason,
    ) -> Result<ToolDisposition, DbError> {
        let workspace_id = job.workspace_id;
        let channel_id = payload.channel_id;
        let agent_member_id = payload.agent_member_id;
        let call = call.clone();
        let raw_arguments = raw_arguments.to_string();
        let step_ceiling = self.config.a2a.clamped().max_steps;
        let ttl = self.config.approval_ttl_seconds;
        let grant = payload
            .tool_grants
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .and_then(|grants| {
                grants.iter().find(|entry| {
                    entry
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .map(momo_agent::tools::normalize)
                        == Some(momo_agent::tools::normalize(&call.name))
                })
            })
            .cloned();

        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // (1) the call itself, on the spine. `client_msg_id` from the
                // provider's `call_id` makes a re-claimed turn re-post nothing.
                // Its *result* takes `tool_exec::result_message_id`, a separate
                // key space on purpose (#1133): the guard this key buys is
                // `(channel, author, client_msg_id)`, and the card and the
                // result already agree on the first two.
                send_message_in_tx(
                    conn,
                    workspace_id,
                    NewMessage {
                        channel_id,
                        author_member_id: agent_member_id,
                        message_type: MessageType::ToolCall,
                        body: Some(call.message_body()),
                        props: call.message_props(),
                        root_id: None,
                        // ADR-0148 규칙 6, and the answer here is `None` on
                        // purpose. A `tool_call` card is a trace of the agent's
                        // own work — it addresses nobody and points at no
                        // utterance. Filling it with the trigger would stamp the
                        // same quote block onto every step of a multi-tool turn,
                        // which is how a device for pointing becomes noise.
                        reply_to_id: None,
                        client_msg_id: Some(tool_exec::call_message_id(run_id, &call.call_id)),
                        run_id: Some(run_id),
                        hlc_ts: None,
                        hlc_count: None,
                    },
                )
                .await?;

                // (2) G3. `rows_affected() > 0` IS the verdict — a read-then-write
                // would race the run's other consumers.
                if !consume_run_step_in_tx(conn, run_id, step_ceiling).await? {
                    return Ok(ToolDisposition::StepExhausted);
                }

                if !reason.requires_approval() {
                    return Ok(ToolDisposition::RunNow {
                        authorized_by: None,
                        host_id: None,
                    });
                }

                // ADR-0125 D6-A + ADR-0114 D5 (#1114). A spawn is the one call
                // whose approval carries a **question** as well as a request, so
                // it is the one call that needs the picker's rows — and the one
                // whose gate a person may have opened in advance.
                let spawn =
                    Self::spawn_execution(conn, workspace_id, agent_member_id, &call).await?;
                if let Some(spawn) = spawn.as_ref() {
                    if spawn.auto_approved {
                        // The gate opened without a card. `authorized_by` names
                        // the human whose standing permission did it, so the
                        // session the executor creates belongs to them and the
                        // audit trail can answer "who allowed this" without a
                        // second table.
                        return Ok(ToolDisposition::RunNow {
                            authorized_by: Some(spawn.owner_member_id),
                            host_id: spawn.default_host_id,
                        });
                    }
                }
                let execution = spawn.as_ref().map(|spawn| spawn.execution.clone());

                // (3) the approval, its card, the hold, and the audit row.
                let now = chrono::Utc::now();
                let expires_at = default_expires_at(now, ttl);
                let approval_payload = approval_payload(
                    run_id,
                    ACTION_TYPE_TOOL_CALL,
                    &call,
                    &raw_arguments,
                    grant.as_ref(),
                    reason.as_str(),
                    execution.as_ref(),
                );
                let approval_id = create_pending_approval_in_tx(
                    conn,
                    workspace_id,
                    NewApproval {
                        run_id,
                        channel_id,
                        requested_by: agent_member_id,
                        action_type: ACTION_TYPE_TOOL_CALL.to_string(),
                        payload: approval_payload.clone(),
                        expires_at,
                    },
                )
                .await?;

                let card = send_message_in_tx(
                    conn,
                    workspace_id,
                    NewMessage {
                        channel_id,
                        author_member_id: agent_member_id,
                        message_type: MessageType::ApprovalRequest,
                        body: Some(approval_request_body(&call.name)),
                        props: approval_request_props(
                            approval_id,
                            run_id,
                            channel_id,
                            ACTION_TYPE_TOOL_CALL,
                            &call,
                            &raw_arguments,
                            expires_at,
                            execution.as_ref(),
                        ),
                        root_id: None,
                        // `None`, like the call card above. What this message
                        // points at is an `approval` row, not a message: the
                        // decision buttons, the tool name and the arguments are
                        // all in `props`, and a quote block would re-state the
                        // adjacent `tool_call` card the reader is already
                        // looking at.
                        reply_to_id: None,
                        client_msg_id: Some(approval_id),
                        run_id: Some(run_id),
                        hlc_ts: None,
                        hlc_count: None,
                    },
                )
                .await?;
                attach_request_message_in_tx(conn, workspace_id, approval_id, card.message.id)
                    .await?;

                // The hold. Guarded on `running`, so a re-claimed turn that
                // finds the run already parked cannot raise a second approval.
                if !park_run_for_approval_in_tx(conn, run_id, expires_at).await? {
                    return Err(DbError::from(momo_db::sqlx::Error::RowNotFound));
                }

                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_APPROVAL_REQUESTED)
                        .by(agent_member_id)
                        .target("approval", approval_id)
                        .run(run_id)
                        .with_schema(TOOL_AUDIT_SCHEMA, approval_payload),
                )
                .await?;

                Ok(ToolDisposition::Parked { approval_id })
            })
        })
        .await
    }

    /// The spawn-specific half of the approval decision (#1114).
    ///
    /// Answers three things in one read, because they are one question — *may
    /// this spawn happen, where, and does anyone still have to be asked?*
    ///
    /// Returning `None` for every other tool is what keeps this out of the
    /// general path: `work.session.end` and any future tool go on producing the
    /// same approval they always did, with no `execution` key at all.
    async fn spawn_execution(
        conn: &mut PgConnection,
        workspace_id: Uuid,
        agent_member_id: Uuid,
        call: &ToolCall,
    ) -> Result<Option<SpawnExecution>, DbError> {
        if momo_agent::tools::normalize(&call.name)
            != momo_agent::tools::normalize(WORK_SESSION_SPAWN)
        {
            return Ok(None);
        }
        // Arguments that do not validate produce no candidates: the call will be
        // refused by the executor's own validator with a sentence the model can
        // act on, and drawing a host picker for a spawn that cannot run would
        // ask a person to choose between hosts for nothing.
        let Ok(arguments) = tool_exec::spawn_arguments(&call.arguments) else {
            return Ok(None);
        };
        let Some(owner_member_id) =
            momo_t3::work_control::agent_owner_human_in_tx(conn, workspace_id, agent_member_id)
                .await
                .map_err(t3_as_db)?
        else {
            return Ok(None);
        };
        let candidates =
            momo_t3::work_control::spawn_host_candidates_in_tx(conn, workspace_id, owner_member_id)
                .await
                .map_err(t3_as_db)?;
        // ADR-0125 D6-A's "마지막 사용" (migration 061), read for the owner the
        // candidates were judged for. The tool path and the REST path build the
        // same card, so they read the same preference.
        let last_used =
            momo_t3::work_control::last_used_spawn_host_in_tx(conn, workspace_id, owner_member_id)
                .await
                .map_err(t3_as_db)?;
        let default_host_id = momo_t3::work_control::default_spawn_host(&candidates, last_used)
            // The model's proposal is the default only when it is a host the
            // picker would actually offer — otherwise the card would open
            // pre-set to a row it also greys out.
            .or_else(|| {
                arguments.host_id.filter(|proposed| {
                    candidates
                        .iter()
                        .any(|candidate| candidate.selectable && candidate.id == *proposed)
                })
            });
        // ADR-0114 D5: the host owner may have pre-authorised this tool. The
        // permission is theirs and it is per-tool, so it opens the gate for a
        // spawn of `codex` and says nothing about `shell`.
        let auto_approved = momo_t3::work_control::spawn_is_auto_approved_in_tx(
            conn,
            workspace_id,
            owner_member_id,
            &arguments.tool,
        )
        .await
        .map_err(t3_as_db)?
            // An auto-approval with nowhere to run is not an approval. Falling
            // through to the card is the honest answer: it shows the person why
            // (every candidate greyed, with its reason) instead of failing in
            // the executor with nobody watching.
            && default_host_id.is_some();

        Ok(Some(SpawnExecution {
            execution: momo_t3::work_control::spawn_execution_object(
                &arguments.tool,
                &arguments.label,
                arguments.host_id,
                default_host_id,
                &candidates,
            ),
            owner_member_id,
            default_host_id,
            auto_approved,
        }))
    }

    /// Run the tool a human approved, and return its output for the model.
    async fn execute_approved_tool(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
    ) -> Result<String, DbError> {
        let Some(approved) = payload.approved_tool_call.as_ref() else {
            return Ok("Tool result: the approved call was missing from the job.".to_string());
        };
        let context = ToolContext {
            workspace_id: job.workspace_id,
            run_id,
            channel_id: payload.channel_id,
            agent_member_id: payload.agent_member_id,
            // The tool runs with the approver's authority — see `tool_exec`.
            // Falling back to the agent would be a privilege *escalation* on a
            // malformed payload, so a payload with no approver runs as nobody:
            // `Uuid::nil()` matches no member and the executor refuses.
            approved_by: payload.approved_by.unwrap_or_else(Uuid::nil),
            approved_host_id: payload.approved_host_id,
        };
        let call = ToolCall {
            call_id: approved.call_id.clone(),
            name: approved.name.clone(),
            arguments: approved.arguments.clone(),
        };
        let result = tool_exec::execute(&self.pool, &context, &call).await?;
        tracing::info!(
            outbox_id = job.id,
            run_id = %run_id,
            tool = %call.name,
            is_error = result.is_error,
            "approved tool executed"
        );
        Ok(format!("Tool result ({}): {}", call.name, result.output))
    }

    /// Close a turn whose answer was a tool result rather than model text.
    ///
    /// Uses the same [`commit_turn`](Self::commit_turn) as an ordinary turn, so
    /// the run transition, the ledger row and the A2A pass are identical — the
    /// only difference is where the body came from.
    async fn finish_tool_turn(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        body: &str,
        usage: Option<ChatUsage>,
    ) -> Settlement {
        let props = success_props(payload, run_id);
        match self
            .commit_turn(
                job,
                payload,
                run_id,
                body.to_string(),
                props,
                usage,
                TurnOutcome::Succeeded,
                None,
            )
            .await
        {
            Ok(TurnCommit::Committed { delegated, blocked }) => {
                self.settle_done(job.id, None).await;
                Settlement::Answered { delegated, blocked }
            }
            Ok(TurnCommit::Suppressed(reason)) => {
                self.settle_done(job.id, Some(reason)).await;
                Settlement::Skipped
            }
            Err(error) => {
                let reason = format!("tool turn commit failed: {error}");
                self.settle_failed(job.id, &reason).await;
                Settlement::Failed
            }
        }
    }

    /// One transaction: (optionally) the reply, the run's terminal transition,
    /// and the immutable ledger row.
    #[allow(clippy::too_many_arguments)]
    async fn commit_turn(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        body: String,
        props: Value,
        usage: Option<ChatUsage>,
        outcome: TurnOutcome,
        // The redacted provider text for `agent_run.error.reason`. `None` on a
        // success. It is a separate argument rather than the message body
        // because those two stopped being the same string in goal B8 H2: the
        // channel gets one Korean sentence, the run record gets what the
        // provider actually said.
        failure_reason: Option<&str>,
    ) -> Result<TurnCommit, DbError> {
        let failure_reason = failure_reason.map(str::to_string);
        let workspace_id = job.workspace_id;
        let agent_member_id = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let effort = payload.effort.clone();
        let fallback_model = payload.model_or(&self.config.default_model).to_string();
        // B7.2: the same text the channel gets is the text the mention parser
        // reads. Cloned rather than re-derived, so "what the agent said" and
        // "who the agent addressed" can never be two different strings.
        let mention_body = body.clone();
        let delegates = outcome.succeeded();
        let a2a_limits = self.config.a2a;
        let gateway_enabled = self.config.gateway_enabled;
        let context_max_messages = self.config.context_max_messages;

        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // `FOR UPDATE` on the run is what makes the ledger's
                // `NOT EXISTS` a decision rather than a TOCTOU window, and its
                // `None` is an authorization: it is absent when the agent is no
                // longer an active member of the run's channel.
                let Some(snapshot): Option<GatewayRunSnapshot> =
                    lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(TurnCommit::Suppressed("run missing or agent ineligible"));
                };
                if snapshot.status == RunStatus::Cancelled {
                    // A human cancelled between enqueue and commit. Never revive
                    // it, and never post the answer they cancelled (Swift
                    // `finalizeStreamingMessage` :2229-2236).
                    return Ok(TurnCommit::Suppressed("run cancelled"));
                }

                // `client_msg_id = run_id` makes the reply exactly-once through
                // the spine's own `(channel, author, client_msg_id)` idempotency
                // guard: a re-claimed job (crash, lease takeover, retry) returns
                // the message already in the channel instead of posting a second
                // answer. Swift needs a bespoke "does a text message for this run
                // exist" pre-read (:2241-2261) because it has no such key.
                let sent = send_message_in_tx(
                    conn,
                    workspace_id,
                    NewMessage {
                        channel_id,
                        author_member_id: agent_member_id,
                        message_type: MessageType::Text,
                        body: Some(body),
                        props,
                        // See the PR body: Swift answers inside the trigger's
                        // thread; momo-messaging exposes no reader for a
                        // message's own root, and this crate owns no message
                        // SQL, so B5.1 answers at channel top level and records
                        // the linkage in props.
                        root_id: None,
                        // ADR-0148 규칙 6 — agent = member, no branch. "This
                        // answers that message" is the one thing an agent turn
                        // always means, and `reply_to_id` is the column the
                        // schema kept for it; `props.trigger_message_id` has
                        // been carrying the same fact in a place only this
                        // worker and its tests ever read.
                        //
                        // Taken from the **locked run row**, not from the job
                        // payload: the run row is the durable record, it is
                        // already locked in this transaction, and it is the only
                        // source that survives a resume (`resume_job_payload`
                        // writes no trigger, so a payload read would silently
                        // stop quoting after every approval). `None` when the
                        // run was raised by nobody — a work run has no utterance
                        // to point at, and inventing one would be worse than
                        // pointing at nothing.
                        //
                        // Quoting, not threading: the answer stays in the
                        // channel's main flow with the question attached, which
                        // is the distinction the ADR exists to draw.
                        reply_to_id: snapshot.trigger_message_id,
                        client_msg_id: Some(run_id),
                        run_id: Some(run_id),
                        hlc_ts: None,
                        hlc_count: None,
                    },
                )
                .await?;

                let output = json!({
                    "schema": "momo.agent_run.output.v0",
                    "source": "agent_worker.turn.v0",
                    "message_id": sent.message.id,
                    "seq": sent.message.seq,
                });
                // ADR-0004 §Rotation: a 401/403 leaves the reason
                // `provider_auth_failed`, distinct from a generic provider
                // failure, so an operator reading the run can tell "the token is
                // dead" from "the provider is down" without correlating logs.
                //
                // `reason` is the provider's redacted text, NOT the message
                // body: since goal B8 H2 the body is a fixed Korean sentence, so
                // reading it back here would have made every failed run record
                // say the same thing and lost the only copy of what went wrong.
                let error = outcome.failure_code().map(|code| {
                    json!({
                        "code": code,
                        "reason": failure_reason
                            .clone()
                            .or_else(|| sent.message.body.clone())
                            .unwrap_or_default(),
                    })
                });
                finish_run_in_tx(conn, run_id, outcome.succeeded(), &output, error.as_ref())
                    .await?;

                // The progress rail is told the turn is over (goal SRV-B3c).
                // THIS is the path a default deployment takes — `AGENT_GATEWAY_MODE`
                // is `worker` unless an operator chose otherwise — so a fix that
                // only covered the gateway callback would have left every real
                // run ending in silence.
                emit_terminal_agent_status(
                    conn,
                    workspace_id,
                    snapshot.channel_id,
                    snapshot.agent_member_id,
                    run_id,
                    if outcome.succeeded() {
                        RunStatus::Succeeded
                    } else {
                        RunStatus::Failed
                    },
                )
                .await?;

                let report = RunUsageReport {
                    model: Some(snapshot.model.clone()),
                    effort: effort.clone(),
                    prompt_tokens: usage.map(|usage| usage.prompt_tokens),
                    completion_tokens: usage.map(|usage| usage.completion_tokens),
                    cached_tokens: usage.map(|usage| usage.cached_tokens),
                    reasoning_tokens: usage.map(|usage| usage.reasoning_tokens),
                    // No price table reader exists on this server yet, so the
                    // honest value is 0 rather than an invented rate — the token
                    // counts are the measured part. See the PR body.
                    cost_micro_usd: None,
                    // A turn whose provider reported no usage object has not
                    // been measured; the summary surfaces that as
                    // `totals.estimatedMicroUsd`.
                    was_estimated: Some(usage.is_none()),
                };
                let resolved = RunUsageReport::resolve(
                    Some(&report),
                    &fallback_model,
                    snapshot.requested_effort.as_deref(),
                    snapshot.profile_effort_pref.as_deref(),
                );
                record_run_usage_in_tx(
                    conn,
                    workspace_id,
                    run_id,
                    snapshot.agent_member_id,
                    snapshot.channel_id,
                    &resolved,
                )
                .await?;

                // B7.2 — A2A. Last in the transaction, and that position is the
                // argument: the ledger row above is part of this chain's spend,
                // so a ceiling evaluated before it would always be one turn
                // stale and could be overshot by the very hop it is meant to
                // stop. `deduped` is the other guard — a re-claimed job returns
                // the message already in the channel, and re-running the routing
                // on it would spend a second step and write a second audit row
                // for a delegation that already happened.
                let (delegated, blocked) = if delegates && !sent.deduped {
                    let routed = route_a2a_mentions_in_tx(
                        conn,
                        A2aSend {
                            workspace_id,
                            channel_id: snapshot.channel_id,
                            message_id: sent.message.id,
                            message_seq: sent.message.seq,
                            author_agent_member_id: snapshot.agent_member_id,
                            source_run_id: run_id,
                            body: &mention_body,
                            hlc_ts: sent.message.hlc_ts,
                            gateway_enabled,
                            context_max_messages,
                            limits: a2a_limits,
                        },
                    )
                    .await?;
                    (routed.delegated.len(), routed.blocked.len())
                } else {
                    (0, 0)
                };

                Ok(TurnCommit::Committed { delegated, blocked })
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // settlement
    // -----------------------------------------------------------------------

    /// A transient failure: hand the job back with a backoff, or — once the
    /// attempt budget is spent — tell the user and stop (Swift `requeueJob`
    /// :2706-2735, including the "write the degraded message on the last
    /// attempt, not on every one" rule).
    async fn settle_retryable(
        &self,
        job: &ClaimedAgentJob,
        reason: &str,
        endpoint: &ProviderEndpoint,
    ) -> Settlement {
        let reason = redact_secrets(reason, &endpoint.bearer);
        // Swift `updateRunStatus(.error)` runs before the requeue decision
        // (:555), so a run that is between attempts reads as `failed` rather
        // than `running`. That is not cosmetic: G1's live-run count
        // (`live_run_count_in_tx`) treats `running` as occupying the agent's
        // concurrency slot, so a run left `running` across a backoff would hold
        // the semaphore for a turn that is not executing. The retry re-claims it
        // because `failed` is in the claimable set.
        if let Ok(payload) = serde_json::from_str::<AgentJobPayload>(&job.payload) {
            if let Some(run_id) = payload.run_id {
                self.mark_run_failed(job.workspace_id, run_id, &reason)
                    .await;
            }
        }
        if job.attempts >= self.config.max_attempts {
            tracing::error!(
                outbox_id = job.id,
                attempts = job.attempts,
                reason,
                "max attempts reached"
            );
            if let Ok(payload) = serde_json::from_str::<AgentJobPayload>(&job.payload) {
                if let Some(run_id) = payload.run_id {
                    self.write_failure_turn(
                        job,
                        &payload,
                        run_id,
                        &reason,
                        degraded_provider_message(),
                        PROVIDER_FAILED,
                    )
                    .await;
                }
            }
            self.settle_failed(job.id, &format!("max attempts: {reason}"))
                .await;
            return Settlement::Failed;
        }
        let backoff = backoff_seconds(job.attempts);
        tracing::warn!(
            outbox_id = job.id,
            attempts = job.attempts,
            backoff_seconds = backoff,
            reason,
            "transient job failure; requeueing"
        );
        if let Err(error) = requeue(&self.pool, job.id, backoff, &reason).await {
            tracing::error!(outbox_id = job.id, error = %error, "requeue failed");
        }
        Settlement::Requeued
    }

    /// A non-retryable failure: say so in the channel, fail the run, bill the
    /// (zero-token) turn, and settle the job `failed`.
    async fn settle_terminal_failure(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        reason: &str,
        endpoint: &ProviderEndpoint,
    ) -> Settlement {
        let reason = redact_secrets(reason, &endpoint.bearer);
        self.write_failure_turn(
            job,
            payload,
            run_id,
            &reason,
            degraded_provider_message(),
            PROVIDER_FAILED,
        )
        .await;
        self.settle_failed(job.id, &reason).await;
        Settlement::Failed
    }

    /// A refresh that did not produce a token (ADR-0147 결정 2: "갱신 실패 = run
    /// 실패 + 사용자 가시 오류(재로그인 안내)").
    ///
    /// A transient shape (no answer, 5xx) still goes through the ordinary retry
    /// budget — the grant is probably fine and the endpoint is having a moment.
    /// Everything else is terminal, and the message says the one thing that
    /// repairs it, because nobody can re-authorise an OAuth grant from inside a
    /// chat channel.
    async fn settle_refresh_failure(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        error: &RefreshError,
        transport: &ResolvedTransport,
    ) -> Settlement {
        // Redacted against the grant as well as the presented bearer: an OAuth
        // error body can quote the token it refused.
        let reason = redact_secrets(&error.to_string(), &transport.endpoint.bearer);
        let reason = match transport.oauth() {
            Some(credential) => redact_secrets(&reason, &credential.refresh_token),
            None => reason,
        };
        if error.is_retryable() {
            return self
                .settle_retryable(
                    job,
                    &format!("token refresh failed: {reason}"),
                    &transport.endpoint,
                )
                .await;
        }
        self.write_failure_turn(
            job,
            payload,
            run_id,
            &reason,
            relogin_message(),
            PROVIDER_AUTH_FAILED,
        )
        .await;
        self.settle_failed(job.id, &format!("token refresh failed: {reason}"))
            .await;
        Settlement::Failed
    }

    /// The user-visible half of a failed turn. Best effort by design: if this
    /// write fails the job still settles, because leaving the row `processing`
    /// would block every later job for this agent behind a turn that is already
    /// over.
    async fn write_failure_turn(
        &self,
        job: &ClaimedAgentJob,
        payload: &AgentJobPayload,
        run_id: Uuid,
        reason: &str,
        body: &'static str,
        code: &'static str,
    ) {
        let props = failure_props(payload, run_id, code);
        if let Err(error) = self
            .commit_turn(
                job,
                payload,
                run_id,
                body.to_string(),
                props,
                None,
                TurnOutcome::Failed(code),
                // The provider's own words, redacted, going to the run record
                // rather than to the channel (goal B8 H2).
                Some(reason),
            )
            .await
        {
            tracing::error!(
                outbox_id = job.id,
                run_id = %run_id,
                error = %error,
                "failure notice commit failed"
            );
        }
    }

    /// Move the run to `failed` without writing a message — the between-attempts
    /// state. Best effort: the durable progress marker is the job's own status,
    /// and a run-status write that fails must not strand the job `processing`.
    async fn mark_run_failed(&self, workspace_id: Uuid, run_id: Uuid, reason: &str) {
        let reason = reason.to_string();
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // A human's cancellation outranks a provider's failure, and
                // `finish_run_in_tx` carries no status guard of its own.
                let Some(snapshot) = lock_gateway_run_in_tx(conn, workspace_id, run_id).await?
                else {
                    return Ok(());
                };
                if snapshot.status == RunStatus::Cancelled {
                    return Ok(());
                }
                let error = json!({"code": PROVIDER_FAILED, "reason": reason});
                finish_run_in_tx(conn, run_id, false, &json!({}), Some(&error)).await?;
                // A turn that died before it could answer still ended, and the
                // badge has to learn that from somewhere (goal SRV-B3c). This is
                // the path where it matters most: there is no message in the
                // channel to imply it either.
                emit_terminal_agent_status(
                    conn,
                    workspace_id,
                    snapshot.channel_id,
                    snapshot.agent_member_id,
                    run_id,
                    RunStatus::Failed,
                )
                .await?;
                Ok(())
            })
        })
        .await;
        if let Err(error) = result {
            tracing::warn!(run_id = %run_id, error = %error, "run failure transition failed");
        }
    }

    async fn settle_done(&self, id: i64, reason: Option<&str>) {
        if let Err(error) = mark_done(&self.pool, id, reason).await {
            // At-least-once: a lost status write means the job is re-claimed
            // after its lease expires, and the run_id-keyed message idempotency
            // makes that harmless.
            tracing::error!(outbox_id = id, error = %error, "mark_done failed");
        }
    }

    async fn settle_failed(&self, id: i64, reason: &str) {
        if let Err(error) = mark_failed(&self.pool, id, reason).await {
            tracing::error!(outbox_id = id, error = %error, "mark_failed failed");
        }
    }

    // -----------------------------------------------------------------------
    // provider resolution (ADR-0004 증보 1 P-1b)
    // -----------------------------------------------------------------------

    /// The transport for this turn: the operator's `provider_link` when it is
    /// present, decryptable and usable; else the env transport.
    ///
    /// The read sets **no** `app.provider_link_admin` GUC, matching Swift
    /// `WorkerProviderLinkStore` (:56-59): the worker connects as the BYPASSRLS
    /// `momo_worker` role and bypasses the operator-only RLS policy by design —
    /// migration 039 §RLS explicitly anticipates "a future worker-side resolver
    /// reads+decrypts the row locally". No RLS change is required.
    pub async fn resolve_endpoint(&self) -> ProviderEndpoint {
        self.resolve_transport().await.endpoint
    }

    /// [`resolve_endpoint`](AgentWorker::resolve_endpoint) plus the credential
    /// behind it, which is what an OAuth turn needs in order to refresh itself.
    pub async fn resolve_transport(&self) -> ResolvedTransport {
        let env_transport = || ResolvedTransport {
            endpoint: ProviderEndpoint {
                base_url: self.config.provider.base_url.clone(),
                bearer: self.config.provider.bearer.clone(),
                source: ProviderSource::Environment.as_str(),
                // The env transport is `HERMES_API_KEY` against a gateway; it has
                // no envelope, so it keeps the wire it has always spoken.
                wire: ProviderWire::ChatCompletions,
                account_id: None,
            },
            credential: LinkCredential::Bearer(self.config.provider.bearer.clone()),
            // Env credentials are never written back: there is nothing to write
            // them to, and the absent guard makes that structural rather than a
            // rule someone has to remember.
            link_updated_at_ms: None,
        };

        let Some(master_key) = self.config.provider_link_master_key.as_deref() else {
            // No master key ⇒ nothing to open. Backward compatible with
            // deployments that predate the provider_link GUI.
            return env_transport();
        };

        {
            let entry = self.link_cache.entry.lock().expect("provider link cache");
            if let Some(cached) = entry.as_ref() {
                if cached.fetched_at.elapsed() < self.link_cache.ttl {
                    return transport_or_env(
                        cached.resolved.clone(),
                        cached.updated_at_ms,
                        env_transport,
                    );
                }
            }
        }

        let stored = {
            let mut conn = match self.pool.acquire().await {
                Ok(conn) => conn,
                Err(error) => {
                    tracing::warn!(error = %error, "provider_link read failed; retaining last-known/env");
                    return self.cached_or_env(env_transport);
                }
            };
            match read_link(&mut conn).await {
                Ok(stored) => stored,
                Err(error) => {
                    // Fail safe, not fail blank: a struggling DB must not silently
                    // move every turn onto a different provider.
                    tracing::warn!(error = %error, "provider_link read failed; retaining last-known/env");
                    return self.cached_or_env(env_transport);
                }
            }
        };

        let Some(stored) = stored else {
            self.store_cache(None, None);
            return env_transport();
        };

        // Unchanged since the last decrypt ⇒ reuse without paying SHA-256 +
        // AES-GCM again. The decrypt is the real cost, and it only matters when
        // the operator actually changed the link.
        {
            let entry = self.link_cache.entry.lock().expect("provider link cache");
            if let Some(cached) = entry.as_ref() {
                if cached.updated_at_ms == Some(stored.updated_at_ms) {
                    let resolved = cached.resolved.clone();
                    drop(entry);
                    self.touch_cache();
                    return transport_or_env(resolved, Some(stored.updated_at_ms), env_transport);
                }
            }
        }

        let decrypted = match decrypt_link(&stored, master_key) {
            Ok(decrypted) => Some(decrypted),
            Err(error) => {
                tracing::warn!(
                    updated_at_ms = stored.updated_at_ms,
                    error = %error,
                    "provider_link present but could not be decrypted \
                     (PROVIDER_LINK_MASTER_KEY mismatch?); using env"
                );
                None
            }
        };
        let credential = decrypted
            .as_ref()
            .filter(|link| link.is_usable())
            .map(|link| link.credential.clone());
        let resolved = resolve_link(&self.config.provider, decrypted.as_ref());
        let link = match (resolved.source, credential) {
            (ProviderSource::Database, Some(credential)) => Some(ResolvedLink {
                endpoint: ProviderEndpoint {
                    base_url: resolved.config.base_url,
                    // For an OAuth link this is the access token, and it is empty
                    // until the first refresh mints one — which the turn loop
                    // does before it calls anything.
                    bearer: resolved.config.bearer,
                    source: ProviderSource::Database.as_str(),
                    // B5.4b: the sealed envelope kind is what selects the wire.
                    // It is read from the SAME decrypted credential that supplies
                    // the bearer, so the token and the protocol it is entitled to
                    // can never come from two different rows.
                    wire: ProviderWire::for_credential(&credential),
                    account_id: credential.account_id().map(str::to_string),
                },
                credential,
            }),
            _ => None,
        };
        self.store_cache(link.clone(), Some(stored.updated_at_ms));
        transport_or_env(link, Some(stored.updated_at_ms), env_transport)
    }

    fn cached_or_env(&self, env_transport: impl Fn() -> ResolvedTransport) -> ResolvedTransport {
        let mut entry = self.link_cache.entry.lock().expect("provider link cache");
        match entry.as_mut() {
            Some(cached) => {
                // Throttle the retry to the TTL cadence so a struggling DB is
                // not hammered once per job.
                cached.fetched_at = Instant::now();
                transport_or_env(cached.resolved.clone(), cached.updated_at_ms, env_transport)
            }
            None => env_transport(),
        }
    }

    fn store_cache(&self, resolved: Option<ResolvedLink>, updated_at_ms: Option<i64>) {
        *self.link_cache.entry.lock().expect("provider link cache") = Some(CachedLink {
            resolved,
            updated_at_ms,
            fetched_at: Instant::now(),
        });
    }

    /// Drop the cached link entirely, so the **next** job re-reads the vault.
    ///
    /// Called after every refresh attempt. That is deliberate and load-bearing:
    /// the durable record of a rotated grant is the `provider_link` row, not this
    /// process's memory. Keeping a refreshed credential in RAM would paper over a
    /// failed re-seal — the instance would keep working until it restarted, and
    /// then present a grant the provider had already retired.
    fn invalidate_cache(&self) {
        *self.link_cache.entry.lock().expect("provider link cache") = None;
    }

    // -----------------------------------------------------------------------
    // OAuth refresh + re-seal (ADR-0147 결정 2)
    // -----------------------------------------------------------------------

    /// Exchange the stored grant for a fresh access token, put the result back
    /// in the vault, and point `transport` at the new token.
    ///
    /// The order matters. The token endpoint is called first, because a refresh
    /// that fails must leave the stored credential exactly as it was — a
    /// write-then-call order would blank a working link on a network blip. The
    /// re-seal then happens *before* the provider call, so a turn that crashes
    /// mid-flight has already durably recorded the rotation; a rotated grant that
    /// existed only in memory is a grant the next process cannot use.
    async fn refresh_and_reseal(
        &self,
        transport: &mut ResolvedTransport,
    ) -> Result<(), RefreshError> {
        let Some(credential) = transport.oauth() else {
            return Err(RefreshError::MissingGrant);
        };
        let token_endpoint = credential.token_endpoint_or_default().to_string();
        let client_id = credential.client_id.clone();
        let refresh_token = credential.refresh_token.clone();
        let account_label = credential.account_label.clone();

        let outcome = self
            .refresher
            .refresh(&token_endpoint, client_id.as_deref(), &refresh_token)
            .await;

        // Whatever happened, this process's cached copy is now suspect: either
        // the grant rotated (so the cache is stale) or it was refused (so the
        // cache holds something dead). Re-read on the next job either way.
        self.invalidate_cache();

        let tokens = match outcome {
            Ok(tokens) => tokens,
            Err(error) => {
                tracing::warn!(
                    // The endpoint LABEL only, and never the grant (ADR-0004 §Redaction).
                    token_endpoint = %momo_settings::redacted_endpoint_label(&token_endpoint),
                    account_label = ?account_label,
                    retryable = error.is_retryable(),
                    // An OAuth `error_description` is provider-authored text and
                    // is free to quote the token it just refused, so the grant is
                    // stripped before this reaches a log sink.
                    error = %redact_secrets(&error.to_string(), &refresh_token),
                    "oauth token refresh failed"
                );
                return Err(error);
            }
        };

        let expires_at_ms = tokens.expires_at_ms(now_ms());
        let rotated = tokens.refresh_token.clone();
        if let Some(credential) = transport.credential.as_openai_oauth_mut() {
            credential.apply_refresh(tokens.access_token, rotated.clone(), expires_at_ms);
        }
        transport.endpoint.bearer = transport.credential.presentable_bearer().to_string();
        tracing::info!(
            token_endpoint = %momo_settings::redacted_endpoint_label(&token_endpoint),
            rotated_grant = rotated.is_some(),
            expires_at_ms = ?expires_at_ms,
            "oauth access token refreshed"
        );

        self.reseal_link(transport).await;
        Ok(())
    }

    /// Write the refreshed credential back into `provider_link`.
    ///
    /// Best effort **by design**, and the failure is loud rather than fatal: the
    /// token in hand is valid, so failing the turn here would deny the user an
    /// answer the provider already agreed to give. The cost of the failure is
    /// bounded by [`invalidate_cache`](AgentWorker::invalidate_cache) — the next
    /// job re-reads the vault, finds the pre-rotation grant, and either refreshes
    /// again (provider does not rotate) or fails with the re-login message
    /// (provider rotates). Both are honest; silently keeping an unrecorded token
    /// is not.
    async fn reseal_link(&self, transport: &ResolvedTransport) {
        let (Some(master_key), Some(expected_updated_at_ms)) = (
            self.config.provider_link_master_key.as_deref(),
            transport.link_updated_at_ms,
        ) else {
            return;
        };
        let sealed = match seal_bearer(&transport.credential.to_sealed_plaintext(), master_key) {
            Ok(sealed) => sealed,
            Err(error) => {
                tracing::error!(error = %error, "refreshed credential could not be sealed");
                return;
            }
        };

        let mut conn = match self.pool.acquire().await {
            Ok(conn) => conn,
            Err(error) => {
                tracing::error!(error = %error, "provider_link re-seal could not acquire a connection");
                return;
            }
        };
        match reseal_link_credential(&mut conn, &sealed, expected_updated_at_ms).await {
            Ok(Some(stored)) => tracing::info!(
                updated_at_ms = stored.updated_at_ms,
                "refreshed oauth credential re-sealed into provider_link"
            ),
            // The guard did not match: the operator replaced the link while this
            // turn was in flight. Their write is the newer truth, so this one is
            // correctly dropped.
            Ok(None) => tracing::info!(
                expected_updated_at_ms,
                "provider_link changed during the turn; refreshed credential not written"
            ),
            Err(error) => tracing::error!(
                error = %error,
                "provider_link re-seal failed; the rotated grant is not durable"
            ),
        }
    }

    fn touch_cache(&self) {
        if let Some(cached) = self
            .link_cache
            .entry
            .lock()
            .expect("provider link cache")
            .as_mut()
        {
            cached.fetched_at = Instant::now();
        }
    }

    // -----------------------------------------------------------------------
    // loop
    // -----------------------------------------------------------------------

    /// Run until `shutdown` resolves: NOTIFY-driven drains with a poll fallback.
    pub async fn run(&self, shutdown: impl Future<Output = ()>) {
        tracing::info!(
            poll_interval_ms = self.config.poll_interval.as_millis() as u64,
            claim_batch = self.config.claim_batch_size,
            max_attempts = self.config.max_attempts,
            provider_mode = self.config.provider.mode.as_str(),
            provider_endpoint = %self.config.provider.endpoint_label(),
            "agent worker starting"
        );

        // Capacity 1 + `try_send` coalesces a NOTIFY burst into "one drain
        // pending"; each drain runs to empty, so nothing is left behind.
        let (wake_tx, mut wake_rx) = mpsc::channel::<()>(1);
        let listener = tokio::spawn(listen_loop(self.config.database_url.clone(), wake_tx));

        let mut ticker = tokio::time::interval(self.config.poll_interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = ticker.tick() => {}
                wake = wake_rx.recv() => {
                    if wake.is_none() { /* listener gone; poll keeps us alive */ }
                }
            }
            self.drain_to_empty().await;
        }

        listener.abort();
        tracing::info!("agent worker stopped");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Settlement {
    Answered { delegated: usize, blocked: usize },
    Requeued,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnCommit {
    Committed { delegated: usize, blocked: usize },
    Suppressed(&'static str),
}

/// `agent_run.error.code` for a provider that answered badly.
const PROVIDER_FAILED: &str = "provider_failed";
/// `agent_run.error.code` for a credential the provider would not accept —
/// ADR-0004 §Rotation names this reason explicitly for 401/403.
const PROVIDER_AUTH_FAILED: &str = "provider_auth_failed";

/// How a turn ended, and — when it failed — under which name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnOutcome {
    Succeeded,
    Failed(&'static str),
}

impl TurnOutcome {
    fn succeeded(self) -> bool {
        matches!(self, TurnOutcome::Succeeded)
    }

    fn failure_code(self) -> Option<&'static str> {
        match self {
            TurnOutcome::Succeeded => None,
            TurnOutcome::Failed(code) => Some(code),
        }
    }
}

/// Wall clock in epoch milliseconds — the unit `provider_link` and the OAuth
/// deadline both speak. A clock before the epoch is not a time this process can
/// reason about, so it reads as 0 rather than as a negative deadline that would
/// make every token look expired.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Did the provider refuse the credential, as opposed to the request?
///
/// 401 is the literal answer; 403 is included because gateways in front of the
/// model routinely return it for an expired token rather than a permission
/// problem. Both are non-retryable in the ordinary cascade, which is exactly why
/// the OAuth path has to intercept them *before* that classification runs.
fn is_auth_rejection<T>(result: &Result<T, ProviderError>) -> bool {
    matches!(result, Err(ProviderError::HttpStatus(401 | 403, _)))
}

/// Turn a cached link into a transport, or fall back to env.
fn transport_or_env(
    resolved: Option<ResolvedLink>,
    updated_at_ms: Option<i64>,
    env_transport: impl Fn() -> ResolvedTransport,
) -> ResolvedTransport {
    match resolved {
        Some(link) => ResolvedTransport {
            endpoint: link.endpoint,
            credential: link.credential,
            link_updated_at_ms: updated_at_ms,
        },
        None => env_transport(),
    }
}

/// `props` on a successful reply — Swift `finalMessageProps` (:2336-2354).
fn success_props(payload: &AgentJobPayload, run_id: Uuid) -> Value {
    let mut props = json!({
        "run_id": run_id,
        "source": "agent_worker.final_text.v0",
    });
    let object = props.as_object_mut().expect("json object");
    if let Some(trigger_message_id) = payload.trigger_message_id {
        object.insert("trigger_message_id".into(), json!(trigger_message_id));
    }
    if let Some(trigger_message_seq) = payload.trigger_message_seq {
        object.insert("trigger_message_seq".into(), json!(trigger_message_seq));
    }
    if let Some(author_member_id) = payload.author_member_id {
        object.insert("author_member_id".into(), json!(author_member_id));
    }
    if let Some(attribution) = payload.source_attribution.clone() {
        object.insert("source_attribution".into(), attribution);
    }
    props
}

/// `props` on the user-visible failure notice. Same shape, different `source`,
/// plus the machine code for the failure.
///
/// A credential failure gets its own `source` and its own `error_code`, not
/// just its own text: a client that wants to surface "reconnect your account"
/// needs to branch on something stable, and matching on a Korean sentence is not
/// that.
///
/// It no longer carries `error` (goal B8 H2). That key held the provider's raw
/// reason, and `props` travels to every client over the relay, where the web
/// timeline rendered it verbatim under an 오류 label. The reason now lives in
/// `agent_run.error.reason` and `outbox.last_error` only. Support reads a row;
/// the channel reads a sentence.
fn failure_props(payload: &AgentJobPayload, run_id: Uuid, code: &str) -> Value {
    let mut props = success_props(payload, run_id);
    let object = props.as_object_mut().expect("json object");
    let source = if code == PROVIDER_AUTH_FAILED {
        "agent_worker.provider_auth_failure.v0"
    } else {
        "agent_worker.provider_failure.v0"
    };
    object.insert("source".into(), json!(source));
    object.insert("error_code".into(), json!(code));
    props
}

/// Hold a dedicated `LISTEN outbox` connection and nudge the drain loop. A
/// dropped connection degrades to poll-only (Swift parity): latency suffers,
/// delivery does not.
async fn listen_loop(database_url: String, wake: mpsc::Sender<()>) {
    loop {
        match PgListener::connect(&database_url).await {
            Ok(mut listener) => match listener.listen(NOTIFY_CHANNEL).await {
                Ok(()) => loop {
                    match listener.recv().await {
                        Ok(notification) => {
                            // The trigger sends the row's `kind`; a broadcast
                            // wake is harmless (the claim filters by kind) but
                            // skipping it avoids churning the claim query.
                            if notification.payload() == "agent_job" {
                                let _ = wake.try_send(());
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "LISTEN connection lost; poll fallback");
                            break;
                        }
                    }
                },
                Err(error) => {
                    tracing::warn!(error = %error, "LISTEN registration failed; poll fallback");
                }
            },
            Err(error) => {
                tracing::warn!(error = %error, "LISTEN connect failed; poll fallback");
            }
        }
        if wake.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Publish the terminal `agent.status` frame for a run this worker just ended
/// (goal SRV-B3c) — the worker-side twin of `momo-server`'s
/// `routes::shared::emit_terminal_agent_status`, and deliberately the same six
/// lines around the same builder.
///
/// Two copies exist because `momo-agent` is a payload crate with no `momo-outbox`
/// dependency (invariant #3 keeps the single outbox INSERT in one place, and the
/// frame's *shape* in another). What must not be duplicated is the shape, and it
/// is not: both callers ask `momo_agent::terminal_agent_status_payload`.
async fn emit_terminal_agent_status(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    agent_member_id: Uuid,
    run_id: Uuid,
    status: RunStatus,
) -> Result<(), DbError> {
    let Some(frame) = momo_agent::terminal_agent_status_payload(
        workspace_id,
        channel_id,
        agent_member_id,
        run_id,
        status,
        now_ms(),
    ) else {
        return Ok(());
    };
    emit_rail_frame(conn, workspace_id, channel_id, &frame).await
}

/// Put one already-shaped rail frame on the outbox — the worker's twin of
/// `momo-server`'s `routes::shared::emit_rail_frame`, partitioned on the channel
/// so every frame of a turn shares one FIFO with that turn's messages.
async fn emit_rail_frame(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    frame: &Value,
) -> Result<(), DbError> {
    momo_outbox::emit_outbox(
        conn,
        workspace_id,
        momo_outbox::OutboxKind::Broadcast,
        "publish",
        frame,
        Some(channel_id),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// goal B8 H2. A user who gets nothing cannot tell an outage from an agent
    /// that ignored them, so the notice still has to exist; what it must NOT do
    /// is hand them the provider's own words. These assertions are the ones that
    /// fail if somebody re-appends a `Details:` tail "just for debugging".
    #[test]
    fn the_degraded_message_is_one_korean_sentence_with_no_provider_text() {
        let message = degraded_provider_message();
        assert!(message.contains("다시 멘션"), "{message}");
        assert!(!message.contains("Details"), "{message}");
        assert!(!message.contains("Hermes"), "{message}");
        assert!(
            !message.chars().any(|c| c.is_ascii_alphabetic()),
            "no English internal vocabulary reaches the channel: {message}"
        );
    }

    /// The provider's words are moved, not deleted. `props` rides the relay to
    /// every client, so the reason must not be in it; the run record keeps it.
    #[test]
    fn the_failure_notice_props_carry_a_code_and_never_the_reason() {
        let run_id = Uuid::from_u128(3);
        let payload: AgentJobPayload = serde_json::from_value(json!({
            "agent_member_id": Uuid::from_u128(1),
            "channel_id": Uuid::from_u128(2),
        }))
        .expect("decode");
        let props = failure_props(&payload, run_id, PROVIDER_FAILED);
        assert!(props.get("error").is_none(), "{props}");
        assert_eq!(props["error_code"], json!(PROVIDER_FAILED));
    }

    /// The last line of defence before a provider's own error text reaches a
    /// channel, `outbox.last_error`, and the log.
    #[test]
    fn a_bearer_echoed_by_the_provider_never_reaches_the_user() {
        let leaked = "invalid api key: sk-live-abcdefgh (rotate it)";
        assert_eq!(
            redact_secrets(leaked, "sk-live-abcdefgh"),
            "invalid api key: <redacted> (rotate it)"
        );
        // A too-short "bearer" must not turn every occurrence of a common
        // substring into <redacted> noise.
        assert_eq!(redact_secrets("abc def", "abc"), "abc def");
    }

    /// `reqwest` transport errors print the request URL, and an operator may
    /// have pasted credentials into `provider_link.base_url`.
    #[test]
    fn url_userinfo_is_stripped_from_a_transport_error() {
        let error = "error sending request for url (https://key:secret@gw.example/v1/chat)";
        assert_eq!(
            redact_secrets(error, "unrelated-bearer"),
            "error sending request for url (https://<redacted>@gw.example/v1/chat)"
        );
        // A URL without userinfo is left exactly as it was.
        let clean = "error sending request for url (https://gw.example/v1/chat)";
        assert_eq!(redact_secrets(clean, "unrelated-bearer"), clean);
        // Two URLs in one string: both are handled.
        let two = "https://a:b@x.test/1 and https://c:d@y.test/2";
        assert_eq!(
            redact_url_userinfo(two),
            "https://<redacted>@x.test/1 and https://<redacted>@y.test/2"
        );
    }

    #[test]
    fn success_props_carry_the_trigger_linkage_swift_records() {
        let run_id = Uuid::from_u128(3);
        let payload: AgentJobPayload = serde_json::from_value(json!({
            "agent_member_id": Uuid::from_u128(1),
            "channel_id": Uuid::from_u128(2),
            "trigger_message_id": Uuid::from_u128(6),
            "trigger_message_seq": 42,
            "author_member_id": Uuid::from_u128(5),
        }))
        .expect("decode");
        let props = success_props(&payload, run_id);
        assert_eq!(props["run_id"], json!(run_id));
        assert_eq!(props["source"], json!("agent_worker.final_text.v0"));
        assert_eq!(props["trigger_message_seq"], json!(42));
        assert_eq!(props["author_member_id"], json!(Uuid::from_u128(5)));

        let failure = failure_props(&payload, run_id, PROVIDER_FAILED);
        assert_eq!(failure["source"], json!("agent_worker.provider_failure.v0"));
        assert_eq!(failure["error_code"], json!(PROVIDER_FAILED));
        assert_eq!(failure["trigger_message_seq"], json!(42));

        // A dead credential is a different thing from a broken provider, and a
        // client that wants to say "reconnect your account" has to be able to
        // branch on something stable rather than on a Korean sentence.
        let auth = failure_props(&payload, run_id, PROVIDER_AUTH_FAILED);
        assert_eq!(
            auth["source"],
            json!("agent_worker.provider_auth_failure.v0")
        );
        assert_eq!(auth["error_code"], json!(PROVIDER_AUTH_FAILED));
    }

    /// The 401/403 interception. Widening it to every 4xx would make a malformed
    /// request burn a refresh; narrowing it to 401 alone would miss the gateways
    /// that answer 403 for an expired token.
    #[test]
    fn only_a_credential_rejection_triggers_the_oauth_replay() {
        let ok: Result<(), ProviderError> = Ok(());
        assert!(!is_auth_rejection(&ok));
        assert!(is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            401,
            String::new()
        ))));
        assert!(is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            403,
            String::new()
        ))));
        assert!(!is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            400,
            String::new()
        ))));
        assert!(!is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            429,
            String::new()
        ))));
        assert!(!is_auth_rejection::<()>(&Err(ProviderError::Unreachable(
            "x".into()
        ))));
    }

    /// A legacy bearer link must never enter the OAuth path: it has no grant, and
    /// asking it to refresh would fail every turn on a link that works fine.
    #[test]
    fn a_bearer_transport_never_asks_for_a_refresh() {
        let transport = ResolvedTransport {
            endpoint: ProviderEndpoint::default(),
            credential: LinkCredential::Bearer("sk-live-abcdefgh".into()),
            link_updated_at_ms: Some(1),
        };
        assert!(!transport.is_oauth());
        assert!(!transport.needs_refresh(i64::MAX));
    }

    /// B5.4b: the transport reports one wire, and it is the endpoint's. A second
    /// derivation (say, "is_oauth() ⇒ Responses") could disagree with the
    /// endpoint the request is actually built from, and the request would then
    /// be assembled for one wire and posted to the other's path.
    #[test]
    fn the_transport_reports_the_wire_its_endpoint_will_actually_post_to() {
        let transport = |wire| ResolvedTransport {
            endpoint: ProviderEndpoint {
                base_url: "https://gw.example/v1".into(),
                wire,
                ..ProviderEndpoint::default()
            },
            credential: LinkCredential::Bearer("sk".into()),
            link_updated_at_ms: None,
        };
        assert_eq!(
            transport(ProviderWire::ChatCompletions).wire(),
            ProviderWire::ChatCompletions
        );
        assert_eq!(
            transport(ProviderWire::Responses).endpoint.url(),
            "https://gw.example/v1/responses"
        );
    }

    /// The env fallback carries no `link_updated_at_ms`, and that absence is what
    /// makes "a refresh never writes to a link that did not supply it"
    /// structural rather than a rule someone has to remember.
    #[test]
    fn an_oauth_transport_refreshes_on_a_missing_token_and_near_its_deadline() {
        let mut credential = OpenAiOAuthCredential::from_refresh_token("rt");
        let transport = |credential: &OpenAiOAuthCredential, updated_at| ResolvedTransport {
            endpoint: ProviderEndpoint::default(),
            credential: LinkCredential::OpenAiOAuth(Box::new(credential.clone())),
            link_updated_at_ms: updated_at,
        };

        let fresh_link = transport(&credential, Some(7));
        assert!(fresh_link.is_oauth());
        assert!(
            fresh_link.needs_refresh(0),
            "a grant with no access token must mint one before the first call"
        );

        credential.access_token = Some("at".into());
        credential.expires_at_ms = Some(10_000_000);
        assert!(!transport(&credential, Some(7)).needs_refresh(9_000_000));
        assert!(
            transport(&credential, Some(7)).needs_refresh(10_000_000 - EXPIRY_SKEW_MS),
            "the skew window counts as expired"
        );
        assert_eq!(transport(&credential, None).link_updated_at_ms, None);
    }
}
