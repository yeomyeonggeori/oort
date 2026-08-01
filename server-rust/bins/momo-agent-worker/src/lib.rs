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
//! ## Deliberately not in B5.1
//!
//! Mention→run routing (B5.2 — nothing in the Rust server enqueues a
//! `method='publish'` job yet), streaming/`agent.partial`, tool calls and the
//! approval gate, the §3.3 loop-safety gates (G1/G2/G3, a2a depth), the §8.5
//! budget reserve/trip, the memory plane, and ACP/coding agents. Each is named
//! in the PR body's deviation list with what it costs.

pub mod config;
pub mod context;
pub mod oauth;
pub mod payload;
pub mod provider;
pub mod responses;

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use momo_agent::{
    finish_run_in_tx, lock_gateway_run_in_tx, mark_run_started_in_tx, record_run_usage_in_tx,
    GatewayRunSnapshot, RunStatus, RunUsageReport,
};
use momo_db::sqlx::postgres::PgListener;
use momo_db::{with_tenant_tx, DbError, PgPool};
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
use context::assemble;
use oauth::{relogin_message, HttpTokenRefresher, RefreshError, TokenRefresher, EXPIRY_SKEW_MS};
use payload::AgentJobPayload;
use provider::{
    http_provider, ChatProvider, ChatRequest, ChatUsage, ProviderEndpoint, ProviderError,
    ProviderWire,
};

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
}

/// The message a user sees when the provider could not answer. Swift
/// `WorkerService.degradedProviderMessage` (:2748-2752), kept verbatim: a turn
/// that fails silently is indistinguishable from an agent that ignored you.
pub fn degraded_provider_message(reason: &str) -> String {
    let trimmed = reason.trim();
    let detail = if trimmed.is_empty() {
        "provider did not return a usable response"
    } else {
        trimmed
    };
    format!(
        "Hermes could not complete this request yet. Check the local provider \
         endpoint/token and try again. Details: {detail}"
    )
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
                Settlement::Answered => stats.answered += 1,
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
        let started = with_tenant_tx(&self.pool, job.workspace_id, move |conn| {
            Box::pin(async move { mark_run_started_in_tx(conn, run_id).await })
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

        let assembled = assemble(
            &payload.recent_messages,
            payload.agent_member_id,
            payload.trigger_message_id,
            &payload.prompt,
            payload.system_prompt.as_deref(),
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

        let request = ChatRequest {
            model: payload.model_or(&self.config.default_model).to_string(),
            messages: assembled.messages,
            max_tokens: Some(
                payload
                    .max_output_tokens
                    .unwrap_or(self.config.max_output_tokens)
                    .max(1),
            ),
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

        let mut attempt = self.provider.complete(&transport.endpoint, &request).await;

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
                Ok(()) => attempt = self.provider.complete(&transport.endpoint, &request).await,
                Err(error) => {
                    return self
                        .settle_refresh_failure(&job, &payload, run_id, &error, &transport)
                        .await
                }
            }
        }

        let completion = match attempt {
            Ok(completion) if completion.text.trim().is_empty() => {
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
            )
            .await;
        match outcome {
            Ok(TurnCommit::Committed) => {
                tracing::info!(outbox_id = job.id, run_id = %run_id, "agent turn committed");
                self.settle_done(job.id, None).await;
                Settlement::Answered
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
    ) -> Result<TurnCommit, DbError> {
        let workspace_id = job.workspace_id;
        let agent_member_id = payload.agent_member_id;
        let channel_id = payload.channel_id;
        let effort = payload.effort.clone();
        let fallback_model = payload.model_or(&self.config.default_model).to_string();

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
                        reply_to_id: None,
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
                let error = outcome.failure_code().map(|code| {
                    json!({
                        "code": code,
                        "reason": sent.message.body.clone().unwrap_or_default(),
                    })
                });
                finish_run_in_tx(conn, run_id, outcome.succeeded(), &output, error.as_ref())
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

                Ok(TurnCommit::Committed)
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
                    let body = degraded_provider_message(&reason);
                    self.write_failure_turn(job, &payload, run_id, &reason, body, PROVIDER_FAILED)
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
        let body = degraded_provider_message(&reason);
        self.write_failure_turn(job, payload, run_id, &reason, body, PROVIDER_FAILED)
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
        let body = relogin_message(&reason);
        self.write_failure_turn(job, payload, run_id, &reason, body, PROVIDER_AUTH_FAILED)
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
        body: String,
        code: &'static str,
    ) {
        let props = failure_props(payload, run_id, reason, code);
        if let Err(error) = self
            .commit_turn(
                job,
                payload,
                run_id,
                body,
                props,
                None,
                TurnOutcome::Failed(code),
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
    Answered,
    Requeued,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnCommit {
    Committed,
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
fn now_ms() -> i64 {
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
    matches!(result, Err(ProviderError::HttpStatus(401 | 403)))
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
/// plus the (already redacted) reason so support can read one row instead of
/// correlating logs.
///
/// A credential failure gets its own `source`, not just its own text: a client
/// that wants to surface "reconnect your account" needs to branch on something
/// stable, and matching on a Korean sentence is not that.
fn failure_props(payload: &AgentJobPayload, run_id: Uuid, reason: &str, code: &str) -> Value {
    let mut props = success_props(payload, run_id);
    let object = props.as_object_mut().expect("json object");
    let source = if code == PROVIDER_AUTH_FAILED {
        "agent_worker.provider_auth_failure.v0"
    } else {
        "agent_worker.provider_failure.v0"
    };
    object.insert("source".into(), json!(source));
    object.insert("error".into(), json!(reason));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Swift's text, verbatim. A user who gets nothing cannot tell an outage
    /// from an agent that ignored them, so this string is the contract.
    #[test]
    fn the_degraded_message_names_the_thing_to_check() {
        let message = degraded_provider_message("provider answered with HTTP 401");
        assert!(message.contains("Check the local provider endpoint/token"));
        assert!(message.ends_with("Details: provider answered with HTTP 401"));
        assert!(
            degraded_provider_message("   ").ends_with("provider did not return a usable response"),
            "a blank reason still says something actionable"
        );
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

        let failure = failure_props(&payload, run_id, "HTTP 500", PROVIDER_FAILED);
        assert_eq!(failure["source"], json!("agent_worker.provider_failure.v0"));
        assert_eq!(failure["error"], json!("HTTP 500"));
        assert_eq!(failure["error_code"], json!(PROVIDER_FAILED));
        assert_eq!(failure["trigger_message_seq"], json!(42));

        // A dead credential is a different thing from a broken provider, and a
        // client that wants to say "reconnect your account" has to be able to
        // branch on something stable rather than on a Korean sentence.
        let auth = failure_props(&payload, run_id, "invalid_grant", PROVIDER_AUTH_FAILED);
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
            401
        ))));
        assert!(is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            403
        ))));
        assert!(!is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            400
        ))));
        assert!(!is_auth_rejection::<()>(&Err(ProviderError::HttpStatus(
            429
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
