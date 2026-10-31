//! The scheduled-message tick (ADR-0208 D5 · D7 · D8 · D14), and the one function that
//! turns a schedule into a message ([`deliver_schedule_in_tx`], which the tick and
//! `POST …/send-now` both call).
//!
//! ## Where it runs, and why there
//!
//! In the **api process** (D5): the canonical send's mention → agent-run step is a
//! `pub(crate)` function of this crate that reads `AppState` gates, and a second
//! implementation in another binary would be a quiet copy of the write path. The tick uses
//! its **own two-connection pool**, so it never competes with requests, connected as
//! `momo_app` (NOBYPASSRLS): every write it makes is filtered by the same tenant policies a
//! request's is. There is no cross-tenant write anywhere here — the only cross-tenant read
//! is the pair of id-only definer functions ([`momo_messaging::due_schedules`]).
//!
//! ## One schedule = two transactions (D7)
//!
//! ```text
//!  decision tx   close it (workspace deleted → cancelled · grace over → failed)
//!                or ATTEMPT: attempts + 1, next_attempt_at = now() + backoff   ── COMMIT
//!  send tx       lock `attempts = k` · SAVEPOINT · canonical send ·
//!                refusal → ROLLBACK TO SAVEPOINT + failed (same tx, same lock)
//!                success → sent, body erased                                    ── COMMIT
//!                transient error → ROLLBACK (the backoff the decision wrote is still there)
//! ```
//!
//! `attempts` is raised by the decision transaction and by nothing else. That is what makes
//! "was this ever tried" (`missed` vs `send_error`) a fact the database holds, and what makes a
//! row whose send hangs or panics back off instead of holding the tick.
//!
//! ## What keeps one bad row from stopping the rest
//!
//! Each row runs in its own spawned task, so a panic is a `JoinError` for that row alone. A row
//! whose **decision** transaction fails (so `attempts` cannot rise — a poison row) is skipped in
//! memory for five minutes; if it still will not close, `oort doctor` raises it (D15).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::Duration;

use momo_db::{DbError, PgConnection, PgPool};
use momo_messaging::{
    begin_attempt_in_tx, bind_owner_guc, cancel_schedule_in_tx, clear_owner_guc, due_schedules,
    expired_schedules, get_member, get_workspace, lock_attempt_for_send_in_tx,
    lock_due_for_decision_in_tx, mark_failed_in_tx, mark_sent_in_tx, purge_expired_schedule_in_tx,
    reserved_attachment_ids_in_tx, MemberKind, MessageType, NewMessage, ScheduleActor,
    ScheduleFailure, ScheduleRef, ScheduledMessage, SendRejected, SentMessage,
};
use serde_json::json;
use tokio::sync::watch;
use tokio::time::Instant;
use uuid::Uuid;

use crate::config::SchedulerSettings;
use crate::routes::deliver::{deliver_message_in_tx, DeliverGates, DeliverRefusal, DeliverRequest};
use crate::routes::shared::futures_box::BoxFuture;
use crate::AppState;

/// One look at the due list may work this long (D7). A tick that would run longer leaves the
/// rest for the next look.
pub const TICK_BUDGET: Duration = Duration::from_secs(20);
/// A row whose decision transaction fails is left alone this long, in this process's memory.
pub const POISON_SKIP: Duration = Duration::from_secs(300);
/// What each tick transaction may wait for a lock / run for (D7).
const LOCK_TIMEOUT: &str = "3s";
const STATEMENT_TIMEOUT: &str = "15s";

#[derive(Debug, thiserror::Error)]
pub enum SchedulerError {
    /// The write pool connects as a role that skips row-level security.
    #[error("the scheduler's pool connects as a role that bypasses row-level security (superuser or BYPASSRLS)")]
    PoolBypassesRls,
    #[error(transparent)]
    Db(#[from] DbError),
}

/// Refuse a pool whose role is a superuser or BYPASSRLS: the tick's writes must be filtered by
/// the tenant policies like a request's, so the GUCs its transactions bind are binding rather
/// than decorative (ADR-0208 D5, the `avatar_reclaim` precedent). This is the "no BYPASSRLS on a
/// write path" contract of AGENTS.md, held in code.
pub async fn ensure_write_pool_rls_bound(pool: &PgPool) -> Result<(), SchedulerError> {
    let bypasses: bool = momo_db::sqlx::query_scalar(
        "SELECT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(pool)
    .await
    .map_err(DbError::from)?;
    if bypasses {
        return Err(SchedulerError::PoolBypassesRls);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// the delivery both the tick and send-now use
// ---------------------------------------------------------------------------

/// What the canonical send said about one schedule.
#[derive(Debug)]
pub(crate) enum Delivery {
    /// It went out. The caller closes the row (`mark_sent_in_tx`) in the same transaction. Boxed:
    /// a sent message is large next to the one-byte refusal (`clippy::large_enum_variant`).
    Sent(Box<SentMessage>),
    /// It was refused, and the transaction is healthy (the savepoint was rolled back). The
    /// caller closes the row `failed` with this reason in the same transaction.
    Refused(ScheduleFailure),
}

/// The refusals of the canonical send, as the reasons of D8. The variants a schedule cannot
/// reach (it carries no quote, run, signature or routing) are `not_allowed`: "a policy the send
/// path adds later".
fn failure_of_refusal(refusal: &DeliverRefusal) -> ScheduleFailure {
    match refusal {
        DeliverRefusal::NotMember => ScheduleFailure::NotMember,
        DeliverRefusal::ThreadRoot(_) => ScheduleFailure::RootUnavailable,
        DeliverRefusal::Send(SendRejected::Attachment(_)) => ScheduleFailure::AttachmentUnavailable,
        DeliverRefusal::Send(SendRejected::Provenance(_))
        | DeliverRefusal::QuoteTarget(_)
        | DeliverRefusal::RunBinding(_)
        | DeliverRefusal::NoSigningKey
        | DeliverRefusal::Routing(_)
        | DeliverRefusal::Apps(_) => ScheduleFailure::NotAllowed,
    }
}

/// Send one schedule through the canonical send, **inside a savepoint**.
///
/// The judgments of D8, in order: the author must still be an active member
/// (`author_inactive`), then the canonical send decides membership (`not_member`), the thread
/// root (`root_unavailable`) and the attachments (`attachment_unavailable`). The canonical call
/// is **exactly** [`deliver_message_in_tx`] — the function `POST …/messages` calls — with
/// `client_msg_id` = the schedule's id, so the send is idempotent on its own and "once" does not
/// depend on this function being careful.
///
/// `app.member_id` is **unbound** for the call (REST does not bind it, and both paths run the
/// canonical send in the same GUC state); the domain functions that close the row bind the author
/// again before their own statements.
///
/// A refusal leaves a healthy transaction (`ROLLBACK TO SAVEPOINT`), so the caller can write the
/// `failed` row under the lock it still holds. A database error is returned as an error and the
/// caller's transaction rolls back whole.
pub(crate) async fn deliver_schedule_in_tx(
    conn: &mut PgConnection,
    gates: &DeliverGates,
    row: &ScheduledMessage,
    via_token_id: Option<Uuid>,
) -> Result<Delivery, DbError> {
    let author = match get_member(conn, row.author_member_id).await? {
        Some(member) if member.status == "active" => member,
        _ => return Ok(Delivery::Refused(ScheduleFailure::AuthorInactive)),
    };
    let attachment_ids = reserved_attachment_ids_in_tx(conn, author.id, row.id).await?;
    // A schedule always carries text or an attachment (create and edit both refuse an empty one).
    // If it carries neither now, its attachments are gone — a hard-deleted file takes its
    // reservation with it — and an empty message is not something its author wrote. Say what
    // happened (`attachment_unavailable`) rather than send nothing.
    if row.body.as_deref().is_none_or(str::is_empty) && attachment_ids.is_empty() {
        return Ok(Delivery::Refused(ScheduleFailure::AttachmentUnavailable));
    }
    clear_owner_guc(conn).await?;

    momo_db::sqlx::query("SAVEPOINT scheduled_send")
        .execute(&mut *conn)
        .await?;
    let request = DeliverRequest {
        workspace_id: row.workspace_id,
        message: NewMessage {
            channel_id: row.channel_id,
            author_member_id: author.id,
            message_type: MessageType::Text,
            body: Some(row.body.clone().unwrap_or_default()),
            props: json!({}),
            root_id: row.root_id,
            reply_to_id: None,
            // The schedule's id is the idempotency key: the canonical send's own
            // `(channel, author, client_msg_id)` uniqueness is what makes "once" true.
            client_msg_id: Some(row.id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
        requested_run_id: None,
        signature_b64: None,
        attachment_ids,
        via_token_id,
        opens_stream: false,
        // Derived from who the author is, not a constant: the in-place channel-grant card, for
        // one, is raised for a person's explicit call and for nothing else (agent_mentions.rs).
        author_is_agent: author.kind == MemberKind::Agent,
        author_is_human: author.kind == MemberKind::Human,
        requested_routing: None,
        // A schedule is closed to `apps` like it is to `props` and `routing` (ADR-0113 증보 3 F5).
        requested_apps: Vec::new(),
        // ADR-0148 증보 (#4887): a timed thread reply does not carry 「대화에도 보내기」 yet (the
        // schedule row has no such column) — it lands in the thread only, as before.
        also_in_channel: false,
        gates: gates.clone(),
    };
    let outcome = deliver_message_in_tx(conn, request).await?;
    match outcome {
        // The author used the schedule's id as a REST `clientMsgId` for another message in this
        // channel. Do not report that message as this schedule's send (D7).
        Ok(sent) if sent.deduped => {
            rollback_to_savepoint(conn).await?;
            Ok(Delivery::Refused(ScheduleFailure::SendError))
        }
        Ok(sent) => {
            momo_db::sqlx::query("RELEASE SAVEPOINT scheduled_send")
                .execute(&mut *conn)
                .await?;
            Ok(Delivery::Sent(Box::new(sent)))
        }
        Err(refusal) => {
            rollback_to_savepoint(conn).await?;
            Ok(Delivery::Refused(failure_of_refusal(&refusal)))
        }
    }
}

async fn rollback_to_savepoint(conn: &mut PgConnection) -> Result<(), DbError> {
    momo_db::sqlx::query("ROLLBACK TO SAVEPOINT scheduled_send")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// one tick
// ---------------------------------------------------------------------------

/// A seam for the conformance suite and nothing else: runs **between** a row's decision
/// transaction (committed) and its send transaction, so a test can put a request in that gap —
/// a cancel, a send-now, a panic — deterministically instead of by luck. Production never sets it.
pub type AfterDecisionHook = std::sync::Arc<
    dyn Fn(Uuid, i32) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// Build an [`AfterDecisionHook`] from an async closure (the conformance suite's way in).
pub fn after_decision_hook<F, Fut>(hook: F) -> AfterDecisionHook
where
    F: Fn(Uuid, i32) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    std::sync::Arc::new(
        move |id, attempts| -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
            Box::pin(hook(id, attempts))
        },
    )
}

/// What the tick remembers between looks: only the rows it is leaving alone for a while.
#[derive(Default)]
pub struct TickMemory {
    skip_until: HashMap<Uuid, Instant>,
    /// See [`AfterDecisionHook`].
    pub after_decision: Option<AfterDecisionHook>,
}

impl TickMemory {
    fn forget_expired(&mut self, now: Instant) {
        self.skip_until.retain(|_, until| *until > now);
    }

    fn is_skipped(&self, id: Uuid, now: Instant) -> bool {
        self.skip_until.get(&id).is_some_and(|until| *until > now)
    }

    fn skip(&mut self, id: Uuid, now: Instant) {
        self.skip_until.insert(id, now + POISON_SKIP);
    }

    /// How many rows are being left alone right now.
    pub fn skipped_count(&self) -> usize {
        self.skip_until.len()
    }
}

/// What happened to one due schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowOutcome {
    /// Sent as a message; the milliseconds between the schedule's time and the send.
    Sent { message_id: Uuid, late_ms: i64 },
    /// Closed `failed`: the grace window was over, or the canonical send refused it.
    Failed(ScheduleFailure),
    /// The workspace was deleted: closed `cancelled`.
    Cancelled,
    /// A transient error in the send transaction. The attempt is recorded and so is its backoff.
    Deferred,
    /// Nothing to do: another replica or a request holds the row, or it is no longer due.
    Skipped,
    /// The decision transaction failed (a poison row): left alone for [`POISON_SKIP`].
    DecisionFailed,
    /// The row's task panicked.
    Panicked,
}

/// What one tick did — ids and counts, never a body (D15).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TickReport {
    pub sent: Vec<Uuid>,
    pub failed: Vec<(Uuid, ScheduleFailure)>,
    pub cancelled: Vec<Uuid>,
    pub deferred: Vec<Uuid>,
    pub skipped: Vec<Uuid>,
    pub decision_failed: Vec<Uuid>,
    pub panicked: Vec<Uuid>,
    /// Rows the memory kept this tick from being tried again.
    pub left_alone: usize,
    pub purged: usize,
    /// For each sent row, how late it went out (ms past its time).
    pub late_ms: Vec<i64>,
    /// The tick stopped for its budget or for shutdown, with work left.
    pub cut_short: bool,
}

impl TickReport {
    fn record(&mut self, id: Uuid, outcome: RowOutcome) {
        match outcome {
            RowOutcome::Sent {
                message_id: _,
                late_ms,
            } => {
                self.sent.push(id);
                self.late_ms.push(late_ms);
            }
            RowOutcome::Failed(reason) => self.failed.push((id, reason)),
            RowOutcome::Cancelled => self.cancelled.push(id),
            RowOutcome::Deferred => self.deferred.push(id),
            RowOutcome::Skipped => self.skipped.push(id),
            RowOutcome::DecisionFailed => self.decision_failed.push(id),
            RowOutcome::Panicked => self.panicked.push(id),
        }
    }

    /// Anything worth a log line.
    pub fn is_quiet(&self) -> bool {
        self.sent.is_empty()
            && self.failed.is_empty()
            && self.cancelled.is_empty()
            && self.deferred.is_empty()
            && self.decision_failed.is_empty()
            && self.panicked.is_empty()
            && self.purged == 0
    }
}

/// The SQLSTATE of a database error, for a log line that must not carry row data.
fn sqlstate(error: &DbError) -> String {
    match error {
        DbError::Sqlx(momo_db::sqlx::Error::Database(db)) => {
            db.code().map(|code| code.to_string()).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn invariant<T>(value: Option<T>, what: &'static str) -> Result<T, DbError> {
    // Row-level security turns a wrong GUC into "zero rows", not an error; a transition that
    // matched nothing under a lock it holds is therefore a broken invariant, and the transaction
    // must not commit around it.
    value.ok_or_else(|| {
        DbError::from(momo_db::sqlx::Error::Protocol(format!(
            "scheduled message invariant: {what} matched no row"
        )))
    })
}

/// One tick transaction: the tenant GUC (by `with_tenant_tx_prelude`, the one seam) + the
/// author's owner scope + the D7 timeouts.
async fn scheduler_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    author_member_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, DbError>> + Send,
{
    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        move |conn| {
            Box::pin(async move {
                momo_db::sqlx::query(
                    "SELECT set_config('lock_timeout', $1, true), \
                            set_config('statement_timeout', $2, true)",
                )
                .bind(LOCK_TIMEOUT)
                .bind(STATEMENT_TIMEOUT)
                .execute(&mut *conn)
                .await?;
                // The tick speaks as the author of the row it is sending: outside the rule that
                // only the three lifecycle hooks bind someone else's scope (D14 point 4).
                bind_owner_guc(conn, author_member_id).await?;
                Ok(())
            })
        },
        body,
    )
    .await
}

enum Decision {
    /// Nothing to do for this row now.
    Skip,
    /// The decision transaction closed the row.
    Closed(RowOutcome),
    /// Go and send: the row now carries this `attempts`.
    Attempt(i32),
}

/// The decision transaction (D7), in the order of D8: the workspace first, then the grace
/// window, and only then the attempt that is counted.
async fn decide(
    pool: &PgPool,
    settings: &SchedulerSettings,
    target: ScheduleRef,
) -> Result<Decision, DbError> {
    let grace = settings.grace_seconds;
    scheduler_tx(
        pool,
        target.workspace_id,
        target.author_member_id,
        move |conn| {
            Box::pin(async move {
                let author = target.author_member_id;
                let id = target.scheduled_message_id;
                let workspace_alive = get_workspace(conn, target.workspace_id).await?.is_some();
                let Some(due) = lock_due_for_decision_in_tx(conn, author, id, grace).await? else {
                    return Ok(Decision::Skip);
                };
                if !workspace_alive {
                    // A soft-deleted workspace has no FK cascade; the tick closes what is left.
                    invariant(
                        cancel_schedule_in_tx(conn, author, id, ScheduleActor::System).await?,
                        "cancelling the schedule of a deleted workspace",
                    )?;
                    return Ok(Decision::Closed(RowOutcome::Cancelled));
                }
                if due.past_grace {
                    // `attempts` has not been raised for this look yet: 0 means nobody ever tried.
                    let reason = if due.row.attempts == 0 {
                        ScheduleFailure::Missed
                    } else {
                        ScheduleFailure::SendError
                    };
                    invariant(
                        mark_failed_in_tx(conn, author, id, reason, ScheduleActor::System).await?,
                        "closing a schedule past its grace window",
                    )?;
                    return Ok(Decision::Closed(RowOutcome::Failed(reason)));
                }
                let attempts = invariant(
                    begin_attempt_in_tx(conn, author, id, due.row.attempts).await?,
                    "recording an attempt",
                )?;
                Ok(Decision::Attempt(attempts))
            })
        },
    )
    .await
}

enum SendOutcome {
    Skipped,
    Sent { message_id: Uuid, late_ms: i64 },
    Failed(ScheduleFailure),
}

/// The send transaction (D7): lock the attempt the decision just wrote, send inside a
/// savepoint, close the row in the same transaction.
async fn send(
    pool: &PgPool,
    gates: &DeliverGates,
    target: ScheduleRef,
    attempts: i32,
) -> Result<SendOutcome, DbError> {
    let gates = gates.clone();
    scheduler_tx(
        pool,
        target.workspace_id,
        target.author_member_id,
        move |conn| {
            Box::pin(async move {
                let author = target.author_member_id;
                let id = target.scheduled_message_id;
                let Some(row) = lock_attempt_for_send_in_tx(conn, author, id, attempts).await?
                else {
                    // Cancelled, sent now, re-armed or edited in between: not ours any more.
                    return Ok(SendOutcome::Skipped);
                };
                match deliver_schedule_in_tx(conn, &gates, &row, None).await? {
                    Delivery::Sent(sent) => {
                        // `mark_sent_in_tx` binds the author again before its own statement, and a
                        // miss (zero rows) is an error, not a quiet `pending` left behind a
                        // committed message.
                        let closed = invariant(
                            mark_sent_in_tx(
                                conn,
                                author,
                                id,
                                sent.message.id,
                                ScheduleActor::System,
                                None,
                            )
                            .await?,
                            "closing a sent schedule",
                        )?;
                        let late_ms = closed
                            .sent_at
                            .map(|at| (at - closed.send_at).num_milliseconds().max(0))
                            .unwrap_or(0);
                        Ok(SendOutcome::Sent {
                            message_id: sent.message.id,
                            late_ms,
                        })
                    }
                    Delivery::Refused(reason) => {
                        invariant(
                            mark_failed_in_tx(conn, author, id, reason, ScheduleActor::System)
                                .await?,
                            "closing a refused schedule",
                        )?;
                        Ok(SendOutcome::Failed(reason))
                    }
                }
            })
        },
    )
    .await
}

async fn process_row(
    pool: PgPool,
    gates: DeliverGates,
    settings: SchedulerSettings,
    after_decision: Option<AfterDecisionHook>,
    target: ScheduleRef,
) -> RowOutcome {
    let id = target.scheduled_message_id;
    let decision = match decide(&pool, &settings, target).await {
        Ok(decision) => decision,
        Err(error) => {
            tracing::warn!(schedule = %id, sqlstate = %sqlstate(&error), "scheduler decision failed");
            return RowOutcome::DecisionFailed;
        }
    };
    match decision {
        Decision::Skip => RowOutcome::Skipped,
        Decision::Closed(outcome) => outcome,
        Decision::Attempt(attempts) => {
            if let Some(hook) = &after_decision {
                hook(id, attempts).await;
            }
            match send(&pool, &gates, target, attempts).await {
                Ok(SendOutcome::Skipped) => RowOutcome::Skipped,
                Ok(SendOutcome::Sent {
                    message_id,
                    late_ms,
                }) => RowOutcome::Sent {
                    message_id,
                    late_ms,
                },
                Ok(SendOutcome::Failed(reason)) => RowOutcome::Failed(reason),
                Err(error) => {
                    // A transient error: the transaction rolled back, the row is still `pending`,
                    // and the backoff the decision wrote is what brings it back.
                    tracing::warn!(schedule = %id, attempts, sqlstate = %sqlstate(&error), "scheduler send deferred");
                    RowOutcome::Deferred
                }
            }
        }
    }
}

/// Run one row in its own task, so a panic is that row's `JoinError` and nothing else's.
async fn process_isolated(
    pool: &PgPool,
    gates: &DeliverGates,
    settings: &SchedulerSettings,
    after_decision: Option<AfterDecisionHook>,
    target: ScheduleRef,
) -> RowOutcome {
    let task = tokio::spawn(process_row(
        pool.clone(),
        gates.clone(),
        *settings,
        after_decision,
        target,
    ));
    match task.await {
        Ok(outcome) => outcome,
        Err(join_error) => {
            tracing::error!(
                schedule = %target.scheduled_message_id,
                panicked = join_error.is_panic(),
                "scheduler row task did not finish"
            );
            RowOutcome::Panicked
        }
    }
}

fn stopped(stop: &watch::Receiver<bool>) -> bool {
    *stop.borrow()
}

/// One look: take the due list, work it for at most [`TICK_BUDGET`], then sweep what is past
/// retention. `pool` is the scheduler's own pool (`momo_app`); the cross-tenant lists are read on
/// a plain connection **outside any tenant transaction** (that connection may have run one, so
/// its `app.workspace_id` is `''`, which the policy reads through `NULLIF`).
pub async fn run_tick(
    pool: &PgPool,
    state: &AppState,
    settings: &SchedulerSettings,
    memory: &mut TickMemory,
    stop: &watch::Receiver<bool>,
) -> Result<TickReport, SchedulerError> {
    // The mention pass reads the same gates a REST send reads, from the same `AppState`.
    let gates = &DeliverGates::from_state(state);
    let started = Instant::now();
    memory.forget_expired(started);
    let mut report = TickReport::default();
    let mut attempted: HashSet<Uuid> = HashSet::new();

    'looks: loop {
        if stopped(stop) || started.elapsed() >= TICK_BUDGET {
            report.cut_short = true;
            break;
        }
        let due = {
            let mut conn = pool.acquire().await.map_err(DbError::from)?;
            due_schedules(&mut conn, settings.batch).await?
        };
        let mut fresh = Vec::new();
        for target in due {
            let id = target.scheduled_message_id;
            if attempted.contains(&id) {
                continue;
            }
            if memory.is_skipped(id, Instant::now()) {
                report.left_alone += 1;
                attempted.insert(id);
                continue;
            }
            fresh.push(target);
        }
        if fresh.is_empty() {
            break;
        }
        for target in fresh {
            if stopped(stop) || started.elapsed() >= TICK_BUDGET {
                report.cut_short = true;
                break 'looks;
            }
            let id = target.scheduled_message_id;
            attempted.insert(id);
            let outcome =
                process_isolated(pool, gates, settings, memory.after_decision.clone(), target)
                    .await;
            if matches!(outcome, RowOutcome::DecisionFailed | RowOutcome::Panicked) {
                memory.skip(id, Instant::now());
            }
            report.record(id, outcome);
        }
    }

    // Retention (D14): the rows past their keep, each deleted in its own author's transaction.
    if !stopped(stop) && started.elapsed() < TICK_BUDGET {
        let expired = {
            let mut conn = pool.acquire().await.map_err(DbError::from)?;
            expired_schedules(&mut conn, settings.batch).await?
        };
        for target in expired {
            if stopped(stop) || started.elapsed() >= TICK_BUDGET {
                report.cut_short = true;
                break;
            }
            let id = target.scheduled_message_id;
            let author = target.author_member_id;
            let purged = scheduler_tx(pool, target.workspace_id, author, move |conn| {
                Box::pin(async move { purge_expired_schedule_in_tx(conn, author, id).await })
            })
            .await;
            match purged {
                Ok(true) => report.purged += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(schedule = %id, sqlstate = %sqlstate(&error), "scheduler purge failed")
                }
            }
        }
    }
    Ok(report)
}

/// Log what a tick did, as ids and counts and the lateness distribution (D15). Never a body.
pub fn log_report(report: &TickReport) {
    if report.is_quiet() {
        return;
    }
    let mut late = report.late_ms.clone();
    late.sort_unstable();
    let p50 = late.get(late.len() / 2).copied().unwrap_or(0);
    let max = late.last().copied().unwrap_or(0);
    tracing::info!(
        sent = report.sent.len(),
        failed = report.failed.len(),
        cancelled = report.cancelled.len(),
        deferred = report.deferred.len(),
        decision_failed = report.decision_failed.len(),
        panicked = report.panicked.len(),
        purged = report.purged,
        late_ms_p50 = p50,
        late_ms_max = max,
        cut_short = report.cut_short,
        "scheduled messages tick"
    );
}

/// What asking the pool which role it connects as finally came to.
#[derive(Debug, PartialEq, Eq)]
enum RoleVerdict {
    /// The role is subject to row-level security: the tick may run.
    Bound,
    /// The role skips it (superuser or `BYPASSRLS`): a configuration answer that no retry changes.
    Bypasses,
    /// The process is stopping.
    Stopped,
}

/// Ask `check` until the answer is **definite** — a database that could not be asked (down for a
/// moment at boot) is "not yet", not "no" — pausing `retry_every` between asks and giving up when
/// `stop` turns true. A closure rather than the pool, so the retry is testable without one.
async fn settle_role<F, Fut>(
    check: F,
    retry_every: Duration,
    stop: &mut watch::Receiver<bool>,
) -> RoleVerdict
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), SchedulerError>>,
{
    loop {
        match check().await {
            Ok(()) => return RoleVerdict::Bound,
            Err(SchedulerError::PoolBypassesRls) => return RoleVerdict::Bypasses,
            Err(SchedulerError::Db(error)) => {
                tracing::warn!(
                    sqlstate = %sqlstate(&error),
                    "scheduler could not ask its database role; asking again"
                );
            }
        }
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || stopped(stop) {
                    return RoleVerdict::Stopped;
                }
            }
            _ = tokio::time::sleep(retry_every) => {}
        }
        if stopped(stop) {
            return RoleVerdict::Stopped;
        }
    }
}

/// Start the tick in this process (ADR-0208 D5), or say why it did not start.
///
/// The one entry `main` uses. It first asks the tick's pool which role it connects as and
/// **refuses a role that skips row-level security** ([`ensure_write_pool_rls_bound`]). A refusal
/// is not silent: it sets [`AppState::scheduler_blocked`], so creating, editing or sending-now a
/// schedule answers 503 `scheduler_disabled` exactly as if the operator had switched the scheduler
/// off — a server that will not send a schedule must not accept one (D15). Listing and deleting
/// keep working.
///
/// A question the database could not answer (down for a moment at boot) is not a refusal: the
/// routes answer 503 meanwhile, the question is asked again every tick interval, and the tick
/// starts when it is answered — a server that booted a second before its database does not stay
/// switched off until somebody restarts it.
///
/// Returns the task to await at shutdown, or `None` when the tick was refused for good.
pub async fn start(
    state: AppState,
    pool: PgPool,
    settings: SchedulerSettings,
    stop: watch::Receiver<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    match ensure_write_pool_rls_bound(&pool).await {
        Ok(()) => {
            state.scheduler_blocked.store(false, Ordering::SeqCst);
            Some(tokio::spawn(run_loop(state, pool, settings, stop)))
        }
        Err(SchedulerError::PoolBypassesRls) => {
            state.scheduler_blocked.store(true, Ordering::SeqCst);
            tracing::error!(
                error = %SchedulerError::PoolBypassesRls,
                "scheduled messages are NOT being sent: the scheduler refused its database role; \
                 creating, editing or sending one now answers 503 scheduler_disabled"
            );
            None
        }
        Err(SchedulerError::Db(error)) => {
            state.scheduler_blocked.store(true, Ordering::SeqCst);
            tracing::warn!(
                sqlstate = %sqlstate(&error),
                "scheduled messages are NOT being sent yet: the scheduler could not ask its \
                 database role; asking again, and creating, editing or sending one answers 503 \
                 scheduler_disabled until it is answered"
            );
            Some(tokio::spawn(async move {
                let mut stop = stop;
                let retry_every = Duration::from_millis(settings.tick_ms);
                let verdict = settle_role(
                    || ensure_write_pool_rls_bound(&pool),
                    retry_every,
                    &mut stop,
                )
                .await;
                match verdict {
                    RoleVerdict::Bound => {
                        state.scheduler_blocked.store(false, Ordering::SeqCst);
                        run_loop(state, pool, settings, stop).await;
                    }
                    RoleVerdict::Bypasses => tracing::error!(
                        "scheduled messages are NOT being sent: the scheduler refused its \
                         database role; creating, editing or sending one answers 503 scheduler_disabled"
                    ),
                    RoleVerdict::Stopped => {}
                }
            }))
        }
    }
}

/// Look every `tick_ms`; stop when `stop` turns true **or its sender is gone** (a loop that kept
/// running with nobody left to stop it would spin). A look in progress finishes the row it is on
/// (the rest stays `pending` and a later tick, here or on another replica, sends it).
async fn run_loop(
    state: AppState,
    pool: PgPool,
    settings: SchedulerSettings,
    mut stop: watch::Receiver<bool>,
) {
    tracing::info!(
        tick_ms = settings.tick_ms,
        batch = settings.batch,
        grace_seconds = settings.grace_seconds,
        "scheduled messages tick started"
    );
    let mut memory = TickMemory::default();
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(settings.tick_ms)) => {}
        }
        if stopped(&stop) {
            break;
        }
        match run_tick(&pool, &state, &settings, &mut memory, &stop).await {
            Ok(report) => log_report(&report),
            Err(error) => tracing::warn!(%error, "scheduled messages tick failed"),
        }
    }
    tracing::info!("scheduled messages tick stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::{AttachmentLinkRejected, ProvenanceRejected, ThreadRootInvalid};

    /// D8: each refusal the canonical send can make names the reason a person is shown.
    #[test]
    fn every_refusal_of_the_canonical_send_has_a_reason_of_the_closed_set() {
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::NotMember),
            ScheduleFailure::NotMember
        );
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::ThreadRoot(ThreadRootInvalid::Deleted)),
            ScheduleFailure::RootUnavailable
        );
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::Send(SendRejected::Attachment(
                AttachmentLinkRejected::AlreadyLinked
            ))),
            ScheduleFailure::AttachmentUnavailable
        );
        // A schedule carries no signature, quote, run or routing, so these cannot happen; if a
        // later change makes one reachable it is "a policy the send path adds later".
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::Send(SendRejected::Provenance(
                ProvenanceRejected::SignatureRejected
            ))),
            ScheduleFailure::NotAllowed
        );
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::NoSigningKey),
            ScheduleFailure::NotAllowed
        );
        assert_eq!(
            failure_of_refusal(&DeliverRefusal::Routing("effort".into())),
            ScheduleFailure::NotAllowed
        );
    }

    #[test]
    fn a_left_alone_row_comes_back_after_five_minutes_and_not_before() {
        let mut memory = TickMemory::default();
        let id = Uuid::from_u128(7);
        let now = Instant::now();
        assert!(!memory.is_skipped(id, now));
        memory.skip(id, now);
        assert!(memory.is_skipped(id, now + Duration::from_secs(299)));
        assert!(!memory.is_skipped(id, now + Duration::from_secs(300)));
        memory.forget_expired(now + Duration::from_secs(301));
        assert_eq!(memory.skipped_count(), 0);
    }

    #[test]
    fn a_report_is_quiet_until_something_happened() {
        let mut report = TickReport::default();
        assert!(report.is_quiet());
        report.record(Uuid::from_u128(1), RowOutcome::Skipped);
        assert!(report.is_quiet(), "skipping is not news");
        report.record(
            Uuid::from_u128(2),
            RowOutcome::Sent {
                message_id: Uuid::from_u128(3),
                late_ms: 12,
            },
        );
        assert!(!report.is_quiet());
        assert_eq!(report.late_ms, vec![12]);
    }

    fn unreachable() -> SchedulerError {
        SchedulerError::Db(DbError::from(momo_db::sqlx::Error::PoolTimedOut))
    }

    /// A role question the database could not answer is asked again until it can — and a
    /// definite answer ends the asking either way.
    #[tokio::test]
    async fn a_role_check_the_database_could_not_answer_is_asked_again() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let (_keep, mut stop) = watch::channel(false);

        let asked = Arc::new(AtomicUsize::new(0));
        let counter = asked.clone();
        let verdict = settle_role(
            move || {
                let counter = counter.clone();
                async move {
                    if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                        Err(unreachable())
                    } else {
                        Ok(())
                    }
                }
            },
            Duration::from_millis(1),
            &mut stop,
        )
        .await;
        assert_eq!(verdict, RoleVerdict::Bound);
        assert_eq!(
            asked.load(Ordering::SeqCst),
            3,
            "two unanswered asks, then the answer"
        );

        let asked = Arc::new(AtomicUsize::new(0));
        let counter = asked.clone();
        let verdict = settle_role(
            move || {
                let counter = counter.clone();
                async move {
                    if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                        Err(unreachable())
                    } else {
                        Err(SchedulerError::PoolBypassesRls)
                    }
                }
            },
            Duration::from_millis(1),
            &mut stop,
        )
        .await;
        assert_eq!(
            verdict,
            RoleVerdict::Bypasses,
            "a role that skips RLS is an answer, not a retry"
        );
        assert_eq!(asked.load(Ordering::SeqCst), 2);
    }

    /// Shutting down ends the asking, and so does the sender going away (nobody left to stop it).
    #[tokio::test]
    async fn asking_for_the_role_ends_when_the_process_is_stopping() {
        let (stop_tx, mut stop) = watch::channel(false);
        let waiting = tokio::spawn(async move {
            settle_role(
                || async { Err(unreachable()) },
                Duration::from_millis(5),
                &mut stop,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        stop_tx.send(true).expect("stop");
        let verdict = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("the asking stops")
            .expect("task");
        assert_eq!(verdict, RoleVerdict::Stopped);

        let (gone, mut stop) = watch::channel(false);
        drop(gone);
        let verdict = settle_role(
            || async { Err(unreachable()) },
            Duration::from_millis(5),
            &mut stop,
        )
        .await;
        assert_eq!(
            verdict,
            RoleVerdict::Stopped,
            "a stop channel with no sender stops the asking"
        );
    }

    #[test]
    fn a_zero_row_transition_is_an_invariant_violation_not_a_quiet_success() {
        assert!(invariant(Some(1), "x").is_ok());
        let error = invariant::<i32>(None, "closing a sent schedule").unwrap_err();
        assert!(error.to_string().contains("closing a sent schedule"));
    }
}
