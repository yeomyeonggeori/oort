//! ADR-0218 증보 13 §19 (#6069) — an agent a person approved once registers its own team expressions
//! without a card: the standing grant (Y2.1), the register call's record (Y2.3), the re-proof at every
//! registration (Y2.4), the ceilings (Y3) and what the registered row carries (Y2.5).
//!
//! Two transactions around one decode (D2): [`begin_in_tx`] proves the standing, answers a replay,
//! judges the ceilings **before the decoder** (the attempt ceiling included, YA16) and commits a
//! `pending` call row that counts as an attempt; the caller decodes outside any transaction; then
//! [`finish_in_tx`] proves the standing and the ceilings again under the same lock, registers through
//! the same name, quota and kind rules as every other road (Y4-6) and settles the row.
//!
//! The agent learns one closed word for every closed condition ([`Refusal::NotAllowed`], Y2.4); the
//! operator reads which one in the `expression.self.refused` audit row (one row per agent and reason
//! per hour). Nothing here writes a byte, a name, a prompt or a tag to the call record or the audit
//! log (YA14 · YA16).
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::media::Processed;
use crate::store::{catalog, changed, expression_json, put_images, Effect};
use crate::{Actor, Error, Kind, Metadata, Origin, QUOTA};

/// Y3 하루 개수: an agent's registrations without a card plus the `expression.create` cards it raised on
/// its own, in the last 24 hours.
pub const DAILY_CAP: i64 = 2;
/// Y3 하루 시도: calls that reached the decoder (failures included) in the last 24 hours.
pub const ATTEMPT_CAP: i64 = 6;
/// Y3 누적 상한: registrations without a card in the last 30 days, **deleted ones included** (the name
/// stays taken, D1).
pub const PERIOD_CAP: i64 = 20;
/// Y3 보관 상한: self-registered expressions that are active or hidden, per agent and per workspace.
pub const AGENT_STORE_CAP: i64 = 50;
pub const WORKSPACE_STORE_CAP: i64 = 200;
/// Y2.3: the call record is kept longer than the 30-day window it is counted over.
pub const CALL_RETENTION_DAYS: i32 = 45;
/// Y2.2: the request body of the register tool (one picture of at most 1 MiB in base64 plus its
/// envelope) and of an unasked `expression.create` card.
pub const REQUEST_BYTES: usize = 2 * 1024 * 1024;
/// Y2.3: a generated picture, decoded from base64.
pub const PICTURE_BYTES: usize = 1024 * 1024;
/// A `pending` call row is the attempt of a call that reached the decoder and has not settled. A call
/// lives seconds (the 15-second body deadline, then [`crate::action::PREPARE_DEADLINE`]); a row still
/// `pending` once the attempt window (24 hours) is over belongs to a call that died between its two
/// transactions (a process that stopped, a request dropped mid-decode). It counts for nothing any more,
/// so [`begin_in_tx`] deletes it and its `clientRequestId` can be used again. Inside the window it
/// stays and keeps counting as the attempt it was: deleting it sooner would let a caller that drops its
/// own requests mid-decode buy decodes the attempt ceiling is there to bound.
pub const DEAD_PENDING_HOURS: i32 = 24;
/// Y3 워크스페이스 스위치 (absent = on, a non-boolean = off). Spelled the same in `momo-settings`.
pub const SWITCH_SETTING: &str = "agent_self_expressions";

/// Why a closed door is closed (Y2.4 1 ~ 5, 7) — the audit's `reason`, never the agent's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    SwitchOff,
    ServerSettingOff,
    NoGrant,
    GranterInvalid,
    AgentPaused,
    ConnectionMismatch,
}

impl Closed {
    pub fn reason(self) -> &'static str {
        match self {
            Closed::SwitchOff => "switch_off",
            Closed::ServerSettingOff => "server_setting_off",
            Closed::NoGrant => "no_grant",
            Closed::GranterInvalid => "granter_invalid",
            Closed::AgentPaused => "agent_paused",
            Closed::ConnectionMismatch => "connection_mismatch",
        }
    }
}

/// A register call refused (Y2.4 · Y3 · Y2.3). The ceilings are said as themselves (nothing to hide);
/// every closed condition is one [`Refusal::NotAllowed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotAllowed(Closed),
    DailyCap,
    AttemptCap,
    PeriodCap,
    StoreCap,
    InvalidArguments,
    MediaInvalid,
    NameReserved,
    Quota,
    /// The same `clientRequestId` is still being registered by another call.
    InFlight,
}

impl Refusal {
    /// The word the agent receives (`error.data.code`).
    pub fn code(self) -> &'static str {
        match self {
            Refusal::NotAllowed(_) => "not_allowed",
            Refusal::DailyCap => "daily_cap",
            Refusal::AttemptCap => "attempt_cap",
            Refusal::PeriodCap => "period_cap",
            Refusal::StoreCap => "store_cap",
            Refusal::InvalidArguments => "invalid_arguments",
            Refusal::MediaInvalid => "expression_media_invalid",
            Refusal::NameReserved => "expression_name_reserved",
            Refusal::Quota => "expression_quota",
            Refusal::InFlight => "in_flight",
        }
    }

    /// The audit's closed `reason` word (Y2.5) and the call row's `reason`.
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::NotAllowed(closed) => closed.reason(),
            Refusal::DailyCap => "daily_cap",
            Refusal::AttemptCap => "attempt_cap",
            Refusal::PeriodCap => "period_cap",
            Refusal::StoreCap => "store_cap",
            Refusal::InvalidArguments => "invalid_arguments",
            Refusal::MediaInvalid => "media_invalid",
            Refusal::NameReserved => "name_reserved",
            Refusal::Quota => "quota",
            Refusal::InFlight => "in_flight",
        }
    }

    /// The call row's `reason` (migration 192's closed list): a closed door is one word there too.
    fn recorded(self) -> &'static str {
        match self {
            Refusal::NotAllowed(_) | Refusal::InFlight => "not_allowed",
            other => other.reason(),
        }
    }

    fn from_recorded(word: &str) -> Refusal {
        match word {
            "daily_cap" => Refusal::DailyCap,
            "attempt_cap" => Refusal::AttemptCap,
            "period_cap" => Refusal::PeriodCap,
            "store_cap" => Refusal::StoreCap,
            "invalid_arguments" => Refusal::InvalidArguments,
            "media_invalid" => Refusal::MediaInvalid,
            "name_reserved" => Refusal::NameReserved,
            "quota" => Refusal::Quota,
            _ => Refusal::NotAllowed(Closed::NoGrant),
        }
    }
}

/// Who calls, as the Agent Port proved it in this same transaction.
#[derive(Debug, Clone, Copy)]
pub struct Caller {
    pub workspace: Uuid,
    pub agent: Uuid,
    /// The connection the calling credential belongs to (`HostedToolIdentity::connection_id`).
    pub connection: Uuid,
    pub token: Uuid,
}

/// The grant a call stands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Standing {
    pub grant: Uuid,
    pub granted_by: Uuid,
}

/// The workspace switch (Y3): absent = on, a boolean as it is, anything else = off. `None` (the
/// workspace row is not visible) = off.
pub fn switch_is_on(settings: Option<&Value>) -> bool {
    match settings {
        None => false,
        Some(bag) => match bag.get(SWITCH_SETTING) {
            None => true,
            Some(Value::Bool(on)) => *on,
            Some(_) => false,
        },
    }
}

/// Y2.4 1 ~ 5 and 7, read in this transaction with the agent's member row locked (every count and every
/// registration of this agent queues behind this lock). The first closed condition wins.
pub async fn standing_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    server_setting_on: bool,
) -> Result<Result<Standing, Closed>, Error> {
    standing_with(conn, caller, server_setting_on, true).await
}

/// [`standing_in_tx`] without the lock: the listing's and the body budget's question, asked on every Agent
/// Port request, must not queue behind (or hold) the agent's row. Writes and locks nothing.
pub async fn standing_unlocked_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    server_setting_on: bool,
) -> Result<Result<Standing, Closed>, Error> {
    standing_with(conn, caller, server_setting_on, false).await
}

async fn standing_with(
    conn: &mut PgConnection,
    caller: Caller,
    server_setting_on: bool,
    lock: bool,
) -> Result<Result<Standing, Closed>, Error> {
    // `FOR NO KEY UPDATE`: serializes this agent's registrations without blocking the `FOR KEY SHARE` a
    // foreign key check on the member row takes (a card approval writing `proposed_by`).
    let agent = sqlx::query(&format!(
        "SELECT (m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
                 AND NOT COALESCE(p.paused, false)) AS live \
           FROM member m \
           LEFT JOIN agent_profile p ON p.workspace_id = m.workspace_id AND p.agent_member_id = m.id \
          WHERE m.workspace_id = $1 AND m.id = $2 {}",
        if lock { "FOR NO KEY UPDATE OF m" } else { "" }
    ))
    .bind(caller.workspace)
    .bind(caller.agent)
    .fetch_optional(&mut *conn)
    .await?;
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(caller.workspace)
            .fetch_optional(&mut *conn)
            .await?;
    if !switch_is_on(settings.as_ref()) {
        return Ok(Err(Closed::SwitchOff));
    }
    if !server_setting_on {
        return Ok(Err(Closed::ServerSettingOff));
    }
    let Some(grant) = live_grant_in_tx(conn, caller.workspace, caller.agent).await? else {
        return Ok(Err(Closed::NoGrant));
    };
    if !active_admin_in_tx(conn, caller.workspace, grant.granted_by).await? {
        return Ok(Err(Closed::GranterInvalid));
    }
    let live = match agent {
        Some(row) => row.try_get::<Option<bool>, _>("live")?.unwrap_or(false),
        None => false,
    };
    if !live {
        return Ok(Err(Closed::AgentPaused));
    }
    if grant.connection != caller.connection {
        return Ok(Err(Closed::ConnectionMismatch));
    }
    Ok(Ok(Standing {
        grant: grant.id,
        granted_by: grant.granted_by,
    }))
}

struct LiveGrant {
    id: Uuid,
    granted_by: Uuid,
    connection: Uuid,
}

async fn live_grant_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
) -> Result<Option<LiveGrant>, Error> {
    let row = sqlx::query(
        "SELECT id, granted_by, connection_id FROM expression_agent_grant \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some(row) => Some(LiveGrant {
            id: row.try_get("id")?,
            granted_by: row.try_get("granted_by")?,
            connection: row.try_get("connection_id")?,
        }),
        None => None,
    })
}

/// An active human member of the workspace, not a guest, whose role is owner or admin — **now**
/// (Y2.1 「누가 승인하나」, Y2.4 3).
pub async fn active_admin_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    member: Uuid,
) -> Result<bool, Error> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member m \
                  JOIN workspace_membership wm ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
                 WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'human' AND m.status = 'active' \
                   AND m.deleted_at IS NULL AND wm.role IN ('owner', 'admin'))",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(&mut *conn)
    .await?)
}

/// The numbers the ceilings are judged on (Y3), all from the database.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// Registrations without a card + unasked `expression.create` cards, last 24 hours.
    pub daily: i64,
    /// Calls that reached the decoder, last 24 hours.
    pub attempts: i64,
    /// Registrations without a card, last 30 days (deleted ones included).
    pub period: i64,
    /// This agent's self-registered expressions, active or hidden.
    pub agent_store: i64,
    /// The workspace's self-registered expressions, active or hidden.
    pub workspace_store: i64,
}

pub async fn counts_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
) -> Result<Counts, Error> {
    let row = sqlx::query(
        "SELECT \
           (SELECT count(*) FROM expression_agent_call c WHERE c.workspace_id = $1 AND c.agent_member_id = $2 \
               AND c.outcome = 'registered' AND c.created_at > clock_timestamp() - interval '24 hours') \
         + (SELECT count(*) FROM approval a WHERE a.workspace_id = $1 AND a.requested_by = $2 \
               AND a.action_type = 'workspace_action' AND a.payload->>'origin' = 'agent_initiated' \
               AND a.payload #>> '{action,id}' = 'expression.create' \
               AND a.created_at > clock_timestamp() - interval '24 hours') AS daily, \
           (SELECT count(*) FROM expression_agent_call c WHERE c.workspace_id = $1 AND c.agent_member_id = $2 \
               AND c.decoded AND c.created_at > clock_timestamp() - interval '24 hours') AS attempts, \
           (SELECT count(*) FROM expression_agent_call c WHERE c.workspace_id = $1 AND c.agent_member_id = $2 \
               AND c.outcome = 'registered' AND c.created_at > clock_timestamp() - interval '30 days') AS period, \
           (SELECT count(*) FROM expression e WHERE e.workspace_id = $1 AND e.proposed_by = $2 \
               AND e.grant_id IS NOT NULL AND e.status IN ('active', 'hidden')) AS agent_store, \
           (SELECT count(*) FROM expression e WHERE e.workspace_id = $1 \
               AND e.grant_id IS NOT NULL AND e.status IN ('active', 'hidden')) AS workspace_store",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Counts {
        daily: row.try_get("daily")?,
        attempts: row.try_get("attempts")?,
        period: row.try_get("period")?,
        agent_store: row.try_get("agent_store")?,
        workspace_store: row.try_get("workspace_store")?,
    })
}

/// The ceiling a registration would cross, if any. `attempts` is judged only before the decoder.
fn ceiling(counts: Counts, before_decode: bool) -> Option<Refusal> {
    if before_decode && counts.attempts >= ATTEMPT_CAP {
        Some(Refusal::AttemptCap)
    } else if counts.daily >= DAILY_CAP {
        Some(Refusal::DailyCap)
    } else if counts.period >= PERIOD_CAP {
        Some(Refusal::PeriodCap)
    } else if counts.agent_store >= AGENT_STORE_CAP || counts.workspace_store >= WORKSPACE_STORE_CAP
    {
        Some(Refusal::StoreCap)
    } else {
        None
    }
}

/// `expression.self.refused` (Y2.5), one row per agent and reason per hour. Ids and the closed word
/// only.
async fn refused_audit_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    refusal: Refusal,
) -> Result<(), Error> {
    let reason = refusal.reason();
    let seen: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'expression.self.refused' \
                  AND actor_member_id = $2 AND detail->>'reason' = $3 \
                  AND created_at >= date_trunc('hour', now()))",
    )
    .bind(caller.workspace)
    .bind(caller.agent)
    .bind(reason)
    .fetch_one(&mut *conn)
    .await?;
    if seen {
        return Ok(());
    }
    write_audit(
        conn,
        &AuditEntry::new(caller.workspace, "expression.self.refused")
            .by(caller.agent)
            .via_token(Some(caller.token))
            .target("member", caller.agent)
            .with_schema(
                "momo.expression.self.v1",
                json!({"reason": reason, "connection_id": caller.connection.to_string()}),
            ),
    )
    .await?;
    Ok(())
}

async fn settle_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    call: Uuid,
    outcome: Result<Uuid, Refusal>,
) -> Result<(), Error> {
    let (word, reason, expression) = match outcome {
        Ok(id) => ("registered", None, Some(id)),
        Err(refusal) => ("refused", Some(refusal.recorded()), None),
    };
    let settled = sqlx::query(
        "UPDATE expression_agent_call SET outcome = $3, reason = $4, expression_id = $5, settled_at = clock_timestamp() \
          WHERE workspace_id = $1 AND agent_member_id = $6 AND id = $2 AND outcome = 'pending'",
    )
    .bind(caller.workspace)
    .bind(call)
    .bind(word)
    .bind(reason)
    .bind(expression)
    .bind(caller.agent)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    // The row this call began is the one it settles: a row that is gone or already settled (swept, or
    // settled by someone else) means this registration would stand uncounted, so the whole transaction
    // rolls back instead (review L6).
    if settled != 1 {
        return Err(Error::from(sqlx::Error::RowNotFound));
    }
    Ok(())
}

/// What [`begin_in_tx`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Begin {
    /// Decode, then [`finish_in_tx`] with this call row.
    Proceed { call: Uuid },
    /// The same `clientRequestId` was answered before: the same answer, nothing counted again (YA9).
    Replay(Result<Uuid, Refusal>),
    /// Refused before the decoder; recorded (and audited) in this transaction, which the caller commits.
    Refused(Refusal),
}

/// The first half of a register call: standing, replay, ceilings, then a `pending` row that counts as an
/// attempt — all before a byte is decoded.
pub async fn begin_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    client_request_id: Uuid,
    server_setting_on: bool,
) -> Result<Begin, Error> {
    let standing = match standing_in_tx(conn, caller, server_setting_on).await? {
        Ok(standing) => standing,
        Err(closed) => {
            let refusal = Refusal::NotAllowed(closed);
            refused_audit_in_tx(conn, caller, refusal).await?;
            return Ok(Begin::Refused(refusal));
        }
    };
    // The record's own sweep (Y2.3): rows past the 30-day window and a margin.
    sqlx::query(
        "DELETE FROM expression_agent_call WHERE workspace_id = $1 \
            AND created_at < clock_timestamp() - make_interval(days => $2)",
    )
    .bind(caller.workspace)
    .bind(CALL_RETENTION_DAYS)
    .execute(&mut *conn)
    .await?;
    // A call that died between its two transactions (#6137, review L1): once the attempt window is over
    // its `pending` row counts for nothing, so it goes and its `clientRequestId` is free again
    // ([`DEAD_PENDING_HOURS`]).
    sqlx::query(
        "DELETE FROM expression_agent_call WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND outcome = 'pending' AND created_at < clock_timestamp() - make_interval(hours => $3)",
    )
    .bind(caller.workspace)
    .bind(caller.agent)
    .bind(DEAD_PENDING_HOURS)
    .execute(&mut *conn)
    .await?;
    let earlier = sqlx::query(
        "SELECT outcome, reason, expression_id FROM expression_agent_call \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND client_request_id = $3",
    )
    .bind(caller.workspace)
    .bind(caller.agent)
    .bind(client_request_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(row) = earlier {
        let outcome: String = row.try_get("outcome")?;
        return Ok(Begin::Replay(match outcome.as_str() {
            "registered" => Ok(row.try_get::<Uuid, _>("expression_id")?),
            "refused" => Err(Refusal::from_recorded(
                row.try_get::<Option<String>, _>("reason")?
                    .as_deref()
                    .unwrap_or_default(),
            )),
            _ => Err(Refusal::InFlight),
        }));
    }
    let counts = counts_in_tx(conn, caller.workspace, caller.agent).await?;
    if let Some(refusal) = ceiling(counts, true) {
        sqlx::query(
            "INSERT INTO expression_agent_call(workspace_id, agent_member_id, grant_id, client_request_id, \
                                               decoded, outcome, reason, settled_at) \
             VALUES($1, $2, $3, $4, false, 'refused', $5, clock_timestamp())",
        )
        .bind(caller.workspace)
        .bind(caller.agent)
        .bind(standing.grant)
        .bind(client_request_id)
        .bind(refusal.recorded())
        .execute(&mut *conn)
        .await?;
        refused_audit_in_tx(conn, caller, refusal).await?;
        return Ok(Begin::Refused(refusal));
    }
    let call: Uuid = sqlx::query_scalar(
        "INSERT INTO expression_agent_call(workspace_id, agent_member_id, grant_id, client_request_id, decoded) \
         VALUES($1, $2, $3, $4, true) RETURNING id",
    )
    .bind(caller.workspace)
    .bind(caller.agent)
    .bind(standing.grant)
    .bind(client_request_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Begin::Proceed { call })
}

/// The decoder was busy and the attempt never reached it: its `pending` row goes, so it counts nothing
/// (Y3 하루 시도 counts calls that **reached** the decoder).
pub async fn forget_unreached_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    call: Uuid,
) -> Result<(), Error> {
    sqlx::query(
        "DELETE FROM expression_agent_call WHERE workspace_id = $1 AND agent_member_id = $2 AND id = $3 \
            AND outcome = 'pending'",
    )
    .bind(caller.workspace)
    .bind(caller.agent)
    .bind(call)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What the decoder made of a register call's picture.
pub struct Prepared {
    pub meta: Metadata,
    pub prompt: String,
    pub media: Processed,
}

/// The second half: the same standing and ceilings again under the same lock (Y2.4 「디코드 뒤 등록 tx에서
/// 1~7을 다시 본다」), the registration through the rules every road shares, and the row settled. A
/// refusal is settled and audited here too; the caller commits either way.
///
/// `credential_stands` is the caller's proof, **in this transaction**, that the calling credential and
/// its connection still stand (Y2.4 5: active, proved, not revoked, and still the connection the first
/// transaction proved — review M2): the decode sits between the two transactions, and a connection cut
/// while the picture was decoded closes this registration like any other closed door.
pub async fn finish_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    call: Uuid,
    server_setting_on: bool,
    credential_stands: bool,
    picture: Result<Prepared, Refusal>,
) -> Result<Result<Value, Refusal>, Error> {
    let outcome = register_in_tx(
        conn,
        caller,
        call,
        server_setting_on,
        credential_stands,
        picture,
    )
    .await?;
    match outcome {
        Ok((id, value)) => {
            settle_in_tx(conn, caller, call, Ok(id)).await?;
            Ok(Ok(value))
        }
        Err(refusal) => {
            settle_in_tx(conn, caller, call, Err(refusal)).await?;
            refused_audit_in_tx(conn, caller, refusal).await?;
            Ok(Err(refusal))
        }
    }
}

async fn register_in_tx(
    conn: &mut PgConnection,
    caller: Caller,
    call: Uuid,
    server_setting_on: bool,
    credential_stands: bool,
    picture: Result<Prepared, Refusal>,
) -> Result<Result<(Uuid, Value), Refusal>, Error> {
    let standing = match standing_in_tx(conn, caller, server_setting_on).await? {
        Ok(standing) => standing,
        Err(closed) => return Ok(Err(Refusal::NotAllowed(closed))),
    };
    if !credential_stands {
        return Ok(Err(Refusal::NotAllowed(Closed::ConnectionMismatch)));
    }
    let prepared = match picture {
        Ok(prepared) => prepared,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let ws = caller.workspace;
    // The same catalog lock, name rule, permanent name and quota as every other registration (D1 · D2).
    // Taken **before** the ceilings are counted (review M3): the workspace total of 200 is shared by
    // every agent, and only this lock serialises two agents' registrations — counted before it, two
    // agents that finish together would both read 199 and both register.
    catalog(conn, ws).await?;
    if let Some(refusal) = ceiling(
        counts_in_tx(conn, caller.workspace, caller.agent).await?,
        false,
    ) {
        return Ok(Err(refusal));
    }
    match prepared.meta.validate() {
        Ok(()) => {}
        Err(Error::NameReserved) => return Ok(Err(Refusal::NameReserved)),
        Err(_) => return Ok(Err(Refusal::InvalidArguments)),
    }
    if prepared.meta.subject_member_id.is_some() {
        return Ok(Err(Refusal::InvalidArguments));
    }
    let reserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM expression WHERE workspace_id=$1 AND name=$2)",
    )
    .bind(ws)
    .bind(&prepared.meta.name)
    .fetch_one(&mut *conn)
    .await?;
    if reserved {
        return Ok(Err(Refusal::NameReserved));
    }
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression WHERE workspace_id=$1 AND status <> 'deleted'",
    )
    .bind(ws)
    .fetch_one(&mut *conn)
    .await?;
    if live >= QUOTA {
        return Ok(Err(Refusal::Quota));
    }
    // §10 J4 on the stored large picture: an agent does not choose the kind (Y2.3).
    let kind = Kind::recommended_for(&prepared.media.large.info);
    let id = Uuid::new_v4();
    let origin = Origin {
        kind: "generated".into(),
        source_url: None,
        prompt: Some(prepared.prompt),
    };
    let agent_actor = Actor {
        workspace: ws,
        member: caller.agent,
    };
    let version = changed(
        conn,
        agent_actor,
        id,
        Some(json!({
            "grant_id": standing.grant.to_string(),
            "granted_by": standing.granted_by.to_string(),
            "proposed_by": caller.agent.to_string(),
            "self_registered": true,
            "origin_kind": "generated",
            "sha256_prefix": prepared.media.large.info.sha256.chars().take(12).collect::<String>(),
        })),
        Effect::Created(&[id]),
    )
    .await?;
    let row = sqlx::query(
        "INSERT INTO expression(workspace_id,id,name,display_name,tags,subject_member_id,origin,created_by, \
                                proposed_by,approval_id,grant_id,version,origin_source_attachment_id,kind) \
         VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,$9,$10,NULL,$11) RETURNING *",
    )
    .bind(ws)
    .bind(id)
    .bind(&prepared.meta.name)
    .bind(&prepared.meta.display_name)
    .bind(json!(prepared.meta.tags))
    .bind(json!(origin))
    .bind(standing.granted_by)
    .bind(caller.agent)
    .bind(standing.grant)
    .bind(version)
    .bind(kind.as_str())
    .fetch_one(&mut *conn)
    .await?;
    put_images(conn, ws, id, None, &prepared.media).await?;
    let expression = expression_json(conn, &row).await?;
    let _ = call;
    Ok(Ok((
        id,
        json!({
            "expressionId": id,
            "name": expression["name"],
            "version": version.to_string(),
        }),
    )))
}

// ---------------------------------------------------------------------------
// the grant, on a person's session (Y2.1)
// ---------------------------------------------------------------------------

/// Where a grant was given (`expression_agent_grant.granted_via`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Settings,
    Card,
}

impl Via {
    fn word(self) -> &'static str {
        match self {
            Via::Settings => "settings",
            Via::Card => "card",
        }
    }
}

async fn is_agent_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
) -> Result<bool, Error> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
                   AND deleted_at IS NULL)",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(&mut *conn)
    .await?)
}

async fn owns_agent_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    person: Uuid,
    agent: Uuid,
) -> Result<bool, Error> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM agent a JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.owner_human_id \
                 WHERE a.workspace_id = $1 AND a.member_id = $3 AND a.owner_human_id = $2 \
                   AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL)",
    )
    .bind(workspace)
    .bind(person)
    .bind(agent)
    .fetch_one(&mut *conn)
    .await?)
}

/// Give the standing grant (Y2.1). `admin` must be an active human administrator **now**
/// ([`Error::Role`] otherwise); `agent` an agent of the workspace ([`Error::NotFound`]). A live grant is
/// answered as it is (the request is idempotent). `connection` is the agent's live connection the caller
/// read in this transaction (settings) or the card's pin (card).
pub async fn give_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    admin: Uuid,
    agent: Uuid,
    connection: Uuid,
    via: Via,
) -> Result<Value, Error> {
    if !active_admin_in_tx(conn, workspace, admin).await? {
        return Err(Error::Role);
    }
    if !is_agent_in_tx(conn, workspace, agent).await? {
        return Err(Error::NotFound);
    }
    // One grant at a time per agent: the agent's row is the lock (the register path takes the same one).
    sqlx::query("SELECT 1 FROM member WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE")
        .bind(workspace)
        .bind(agent)
        .execute(&mut *conn)
        .await?;
    insert_grant_in_tx(conn, workspace, admin, agent, connection, via).await?;
    grant_json_in_tx(conn, workspace, agent).await
}

/// 「승인하고 계속 허용」 (Y2.1 ②, #6137): the grant a person gives by approving that agent's
/// `expression.create` card with `keepAllowing: true`, in the decision's own transaction, after the
/// picture was registered. `admin` must be an active human administrator **now** ([`Error::Role`]
/// otherwise); `connection` is the connection the card was raised through (the card's pin). Takes no
/// lock on the agent's row — the decision has already share-locked rows an agent's own calls wait on, so
/// the one live grant is kept by the partial unique index instead — and answers whether a new grant was
/// written (`false`: one was already live and stays as it is).
pub async fn give_on_card_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    admin: Uuid,
    agent: Uuid,
    connection: Uuid,
) -> Result<bool, Error> {
    if !active_admin_in_tx(conn, workspace, admin).await? {
        return Err(Error::Role);
    }
    if !is_agent_in_tx(conn, workspace, agent).await? {
        return Err(Error::NotFound);
    }
    insert_grant_in_tx(conn, workspace, admin, agent, connection, Via::Card).await
}

/// Write one live grant unless one is live already (the partial unique index decides), with its
/// `expression.grant.given` row. `true` when a row was written.
async fn insert_grant_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    admin: Uuid,
    agent: Uuid,
    connection: Uuid,
    via: Via,
) -> Result<bool, Error> {
    let written: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO expression_agent_grant(workspace_id, agent_member_id, granted_by, connection_id, granted_via) \
         VALUES($1, $2, $3, $4, $5) \
         ON CONFLICT (workspace_id, agent_member_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(admin)
    .bind(connection)
    .bind(via.word())
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(id) = written {
        write_audit(
            conn,
            &AuditEntry::new(workspace, "expression.grant.given")
                .by(admin)
                .about(agent)
                .target("expression_agent_grant", id)
                .with_schema(
                    "momo.expression.grant.v1",
                    json!({"via": via.word(), "agent_member_id": agent.to_string(),
                           "connection_id": connection.to_string()}),
                ),
        )
        .await?;
    }
    Ok(written.is_some())
}

/// Revoke (Y2.1 「거두기」): any administrator, the person who gave it, or the agent's owner. A person who
/// is none of those gets [`Error::Role`]; an agent with no live grant is answered as it is.
pub async fn revoke_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    person: Uuid,
    agent: Uuid,
) -> Result<Value, Error> {
    if !is_agent_in_tx(conn, workspace, agent).await? {
        return Err(Error::NotFound);
    }
    sqlx::query("SELECT 1 FROM member WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE")
        .bind(workspace)
        .bind(agent)
        .execute(&mut *conn)
        .await?;
    let admin = active_admin_in_tx(conn, workspace, person).await?;
    let owner = owns_agent_in_tx(conn, workspace, person, agent).await?;
    let grant = live_grant_in_tx(conn, workspace, agent).await?;
    let granter = grant.as_ref().is_some_and(|g| g.granted_by == person);
    if !(admin || owner || granter) {
        return Err(Error::Role);
    }
    if let Some(grant) = grant {
        sqlx::query(
            "UPDATE expression_agent_grant SET revoked_by = $3, revoked_at = clock_timestamp() \
              WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
        )
        .bind(workspace)
        .bind(grant.id)
        .bind(person)
        .execute(&mut *conn)
        .await?;
        write_audit(
            conn,
            &AuditEntry::new(workspace, "expression.grant.revoked")
                .by(person)
                .about(agent)
                .target("expression_agent_grant", grant.id)
                .with_schema(
                    "momo.expression.grant.v1",
                    json!({"via": "settings", "agent_member_id": agent.to_string()}),
                ),
        )
        .await?;
    }
    grant_json_in_tx(conn, workspace, agent).await
}

/// Read one agent's grant (Y2.1 「읽는 길」): administrators and the agent's owner.
pub async fn read_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    person: Uuid,
    agent: Uuid,
) -> Result<Value, Error> {
    if !is_agent_in_tx(conn, workspace, agent).await? {
        return Err(Error::NotFound);
    }
    if !(active_admin_in_tx(conn, workspace, person).await?
        || owns_agent_in_tx(conn, workspace, person, agent).await?)
    {
        return Err(Error::Role);
    }
    grant_json_in_tx(conn, workspace, agent).await
}

/// The live grants (Y2.1 「읽는 길」): every one for an administrator, an owner's own agents' for an
/// owner, and [`Error::Role`] for anybody else.
pub async fn list_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    person: Uuid,
) -> Result<Value, Error> {
    let admin = active_admin_in_tx(conn, workspace, person).await?;
    let agents: Vec<Uuid> = if admin {
        sqlx::query_scalar(
            "SELECT agent_member_id FROM expression_agent_grant WHERE workspace_id = $1 AND revoked_at IS NULL \
              ORDER BY granted_at, agent_member_id",
        )
        .bind(workspace)
        .fetch_all(&mut *conn)
        .await?
    } else {
        let owned: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent a JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.owner_human_id \
              WHERE a.workspace_id = $1 AND a.owner_human_id = $2 \
                AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL",
        )
        .bind(workspace)
        .bind(person)
        .fetch_one(&mut *conn)
        .await?;
        if owned == 0 {
            return Err(Error::Role);
        }
        sqlx::query_scalar(
            "SELECT g.agent_member_id FROM expression_agent_grant g \
               JOIN agent a ON a.workspace_id = g.workspace_id AND a.member_id = g.agent_member_id \
              WHERE g.workspace_id = $1 AND g.revoked_at IS NULL AND a.owner_human_id = $2 \
              ORDER BY g.granted_at, g.agent_member_id",
        )
        .bind(workspace)
        .bind(person)
        .fetch_all(&mut *conn)
        .await?
    };
    let mut items = Vec::with_capacity(agents.len());
    for agent in agents {
        items.push(grant_json_in_tx(conn, workspace, agent).await?);
    }
    Ok(json!({"workspaceId": workspace, "items": items}))
}

/// One agent's grant state and what is left of its ceilings (the same counts [`begin_in_tx`] judges).
async fn grant_json_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
) -> Result<Value, Error> {
    let row = sqlx::query(
        "SELECT id, granted_by, granted_at, granted_via FROM expression_agent_grant \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_optional(&mut *conn)
    .await?;
    let counts = counts_in_tx(conn, workspace, agent).await?;
    let remaining = json!({
        "today": (DAILY_CAP - counts.daily).max(0),
        "period": (PERIOD_CAP - counts.period).max(0),
    });
    Ok(match row {
        Some(row) => {
            let at: chrono::DateTime<chrono::Utc> = row.try_get("granted_at")?;
            json!({
                "agentMemberId": agent,
                "granted": true,
                "grantedBy": row.try_get::<Uuid, _>("granted_by")?,
                "grantedAtMs": at.timestamp_millis(),
                "grantedVia": row.try_get::<String, _>("granted_via")?,
                "remaining": remaining,
            })
        }
        None => json!({
            "agentMemberId": agent,
            "granted": false,
            "grantedBy": null,
            "grantedAtMs": null,
            "grantedVia": null,
            "remaining": remaining,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_reads_absent_as_on_and_anything_but_a_boolean_as_off() {
        assert!(switch_is_on(Some(&json!({}))));
        assert!(switch_is_on(Some(&json!({SWITCH_SETTING: true}))));
        assert!(!switch_is_on(Some(&json!({SWITCH_SETTING: false}))));
        for odd in [json!("true"), json!(1), json!(null), json!({})] {
            assert!(!switch_is_on(Some(&json!({SWITCH_SETTING: odd}))), "{odd}");
        }
        assert!(!switch_is_on(None));
    }

    #[test]
    fn every_closed_door_is_one_word_for_the_agent_and_its_own_word_for_the_audit() {
        let closed = [
            Closed::SwitchOff,
            Closed::ServerSettingOff,
            Closed::NoGrant,
            Closed::GranterInvalid,
            Closed::AgentPaused,
            Closed::ConnectionMismatch,
        ];
        let mut reasons: Vec<&str> = closed
            .iter()
            .map(|c| Refusal::NotAllowed(*c).reason())
            .collect();
        reasons.dedup();
        assert_eq!(reasons.len(), closed.len());
        for c in closed {
            assert_eq!(Refusal::NotAllowed(c).code(), "not_allowed");
        }
    }

    #[test]
    fn the_attempt_ceiling_is_judged_only_before_the_decoder() {
        let at_attempts = Counts {
            attempts: ATTEMPT_CAP,
            ..Counts::default()
        };
        assert_eq!(ceiling(at_attempts, true), Some(Refusal::AttemptCap));
        assert_eq!(ceiling(at_attempts, false), None);
        let under = Counts {
            attempts: ATTEMPT_CAP - 1,
            daily: DAILY_CAP - 1,
            period: PERIOD_CAP - 1,
            agent_store: AGENT_STORE_CAP - 1,
            workspace_store: WORKSPACE_STORE_CAP - 1,
        };
        assert_eq!(ceiling(under, true), None);
    }
}
