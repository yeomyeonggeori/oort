//! Identity (minimal) — the member/workspace/membership lookups the write path
//! and a route layer need, nothing more.
//!
//! **Invariant #5 (agent = member).** Humans and agents are the *same* `member`
//! table; [`MemberKind`] is the only discriminator (`member.kind`, a
//! `member_kind` enum — `001_init.sql:11,48`). There is no separate bot table and
//! no separate lookup path: an agent author resolves through [`get_member`] and
//! sends through the identical write path as a human (see [`crate::message`]).
//! Special-casing agents anywhere here would break that invariant.
//!
//! Every query in this module runs on a connection whose `app.workspace_id` GUC
//! was set by [`momo_db::with_tenant_tx`]; the RLS `ws_isolation` policy
//! (`001_init.sql:395`) therefore scopes each read to the caller's workspace
//! (invariant #6) without this code passing `workspace_id` as a filter.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::presence::{decode_optional_presence, PresenceStatus};

/// `member_kind` enum (`001_init.sql:11`). Humans and agents share one table;
/// this is the sole discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberKind {
    Human,
    Agent,
}

impl MemberKind {
    /// The `text` label matching the `member_kind` Postgres enum.
    pub fn as_db_label(self) -> &'static str {
        match self {
            MemberKind::Human => "human",
            MemberKind::Agent => "agent",
        }
    }

    /// Parse the `member_kind` label back to the enum.
    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "human" => Some(MemberKind::Human),
            "agent" => Some(MemberKind::Agent),
            _ => None,
        }
    }
}

/// A principal in a workspace — human or agent, symmetric (`member`,
/// `001_init.sql:45`). Only the columns the messaging spine needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: MemberKind,
    pub status: String,
    pub display_name: String,
    pub handle: String,
}

/// A workspace (tenant root, `001_init.sql:28`). Minimal projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
}

fn decode_member(row: &sqlx::postgres::PgRow) -> Result<Member, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = MemberKind::from_db_label(&kind_label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown member_kind '{kind_label}'").into()))?;
    Ok(Member {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        status: row.try_get("status")?,
        display_name: row.try_get("display_name")?,
        handle: row.try_get("handle")?,
    })
}

/// Look up one member by id, workspace-scoped by the ambient RLS GUC. `None` if
/// the member does not exist in the caller's workspace (or is filtered by RLS).
pub async fn get_member(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<Member>, DbError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, kind::text AS kind, status::text AS status, \
                display_name, handle \
           FROM member \
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_member(&row)?)),
        None => Ok(None),
    }
}

/// Look up the caller's workspace by id (RLS-scoped). `None` if absent/soft-deleted.
pub async fn get_workspace(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Workspace>, DbError> {
    let row = sqlx::query(
        "SELECT id, slug, name FROM workspace \
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(Workspace {
            id: row.try_get("id")?,
            slug: row.try_get("slug")?,
            name: row.try_get("name")?,
        })),
        None => Ok(None),
    }
}

/// Whether `member_id` is a current (not-left) member of `channel_id`
/// (`membership`, `001_init.sql:122`). The route layer uses this to authorize a
/// send; the write path itself stays a pure spine.
pub async fn is_channel_member(
    conn: &mut PgConnection,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM membership \
            WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(exists)
}

/// May `observer_member_id` watch `agent_member_id`'s progress inside
/// `channel_id`? Ports Swift `CentrifugoRoutes.canObserveAgent`
/// (`CentrifugoRoutes.swift:131-168`) clause for clause.
///
/// The rule is **exact-channel co-membership**, and every part of it earns its
/// place: the target must be an active `agent` member, the observer must be an
/// active member of the workspace, and BOTH must currently be members of that
/// one unarchived channel. Weakening it to "the observer is in the channel"
/// would leak an agent's live tool calls to a channel it was removed from;
/// weakening it to "they share some channel" would make the `agent:` namespace's
/// per-channel granularity decorative.
///
/// `conn` must already carry the tenant GUC (`momo_db::with_tenant_tx`);
/// `workspace_id` is still bound explicitly because Swift's predicate names it,
/// and defence in depth on a subscribe callback is worth one bound parameter.
pub async fn can_observe_agent(
    conn: &mut PgConnection,
    observer_member_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    workspace_id: Uuid,
) -> Result<bool, DbError> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 \
             FROM member agent_member \
             JOIN member observer_member \
               ON observer_member.id = $1 \
              AND observer_member.workspace_id = $4 \
              AND observer_member.status = 'active' \
            WHERE agent_member.id = $2 \
              AND agent_member.workspace_id = $4 \
              AND agent_member.kind = 'agent' \
              AND agent_member.status = 'active' \
              AND EXISTS ( \
                SELECT 1 \
                  FROM channel progress_channel \
                  JOIN membership observer_ms \
                    ON observer_ms.channel_id = progress_channel.id \
                   AND observer_ms.member_id = observer_member.id \
                   AND observer_ms.left_at IS NULL \
                  JOIN membership agent_ms \
                    ON agent_ms.channel_id = progress_channel.id \
                   AND agent_ms.member_id = agent_member.id \
                   AND agent_ms.left_at IS NULL \
                 WHERE progress_channel.id = $3 \
                   AND progress_channel.workspace_id = $4 \
                   AND progress_channel.archived_at IS NULL \
              ))",
    )
    .bind(observer_member_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(allowed)
}

/// Is `agent_member_id` an active **agent** member of `workspace_id`? Ports
/// Swift `CentrifugoRoutes.isActiveAgent` (:170-188).
///
/// Used only by the private `agentwork:` job stream, where the subscriber and
/// the subject are the same member: there is nothing to co-check, only whether
/// the agent still exists as an active member.
pub async fn is_active_agent(
    conn: &mut PgConnection,
    agent_member_id: Uuid,
    workspace_id: Uuid,
) -> Result<bool, DbError> {
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM member \
            WHERE id = $1 \
              AND workspace_id = $2 \
              AND kind = 'agent' \
              AND status = 'active')",
    )
    .bind(agent_member_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(active)
}

/// A member's authority **in the workspace** (`workspace_membership.role`,
/// migration 026 / ADR-0128). Channel roles never imply workspace authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Member,
    Guest,
}

impl WorkspaceRole {
    pub fn as_db_label(self) -> &'static str {
        match self {
            WorkspaceRole::Owner => "owner",
            WorkspaceRole::Admin => "admin",
            WorkspaceRole::Member => "member",
            WorkspaceRole::Guest => "guest",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "owner" => Some(WorkspaceRole::Owner),
            "admin" => Some(WorkspaceRole::Admin),
            "member" => Some(WorkspaceRole::Member),
            "guest" => Some(WorkspaceRole::Guest),
            _ => None,
        }
    }

    pub fn is_admin(self) -> bool {
        matches!(self, WorkspaceRole::Owner | WorkspaceRole::Admin)
    }
}

/// The caller's active workspace role, or `None` when they are not an active
/// member of it (Swift `WorkspaceAuthorization.activeRole`, :34-78 — the
/// single workspace-role authority every route shares).
///
/// "Active" is two conditions, and both matter: a `workspace_membership` row
/// **and** a member that is `status='active'` and not soft-deleted. Checking
/// only the membership row would let a suspended account keep reading, since
/// suspension is recorded on `member`, not on the membership.
///
/// The B1.2 surfaces (DM, read-state, search) call this for their 403 gate,
/// exactly like their Swift counterparts, before any tenant read.
pub async fn active_workspace_role(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<WorkspaceRole>, DbError> {
    let label: Option<String> = sqlx::query_scalar(
        "SELECT wm.role::text \
           FROM workspace_membership wm \
           JOIN member m \
             ON m.workspace_id = wm.workspace_id \
            AND m.id = wm.member_id \
          WHERE wm.workspace_id = $1 \
            AND wm.member_id = $2 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(label.as_deref().and_then(WorkspaceRole::from_db_label))
}

/// Outcome of [`verify_password_login`] — the three states Swift
/// `AuthRoutes.LoginResolution` distinguishes, kept distinct because they map to
/// different HTTP codes (401 vs 403).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordLogin {
    /// Credentials verified and the member is `active`.
    Active(Member),
    /// Credentials verified but the member is `suspended` → 403, not 401.
    Suspended,
    /// Unknown email, wrong password, or a non-active/non-suspended status.
    /// Deliberately one bucket so the response cannot enumerate accounts.
    Invalid,
}

/// Resolve a human member by email and verify the submitted password.
///
/// Ports Swift `AuthRoutes.login`'s resolution query (`AuthRoutes.swift:61-83`)
/// exactly, including where the password check happens: **inside Postgres**, via
/// the `momo_password_verify(raw, stored_hash)` pgcrypto helper added by
/// `005_auth_password_hash.sql`. Keeping the algorithm in the DB is what makes
/// the Rust and Swift servers accept the same bcrypt hashes without porting a
/// crypto stack — and the function is `STABLE`/NULL-safe, so an SSO-only human
/// (`password_hash IS NULL`) simply fails to verify.
///
/// The connection must already carry the tenant GUC (open it with
/// [`momo_db::with_tenant_tx`]); the RLS policies then scope the lookup to the
/// workspace being logged into. Neither the raw password nor the stored hash is
/// ever returned or logged by this function.
///
/// ## The address is normalised on the **input** side only (#1234)
///
/// Every write path stores `lower(btrim(...))` — `create_workspace.sql`,
/// `bootstrap_owner_if_absent.sql`, `set_initial_owner.sql` and
/// `momo_settings::normalized_join_email` all agree — and migration 064 turns
/// that convention into `human_email_normalized_ck`, so a stored address is a
/// normalised address. This lookup used to compare `h.email = $2` verbatim,
/// which meant an owner created from `Owner@Example.com` existed but could
/// never sign in: the row said `owner@example.com` and the login said
/// `Owner@Example.com`. A healthy stack nobody can enter.
///
/// Normalising the **parameter** rather than the column is deliberate, and
/// measured rather than assumed:
///
/// * `lower(btrim(h.email)) = lower(btrim($2))` would fold the column too, and
///   at the time this was written the only uniqueness on the table was
///   case-**sensitive**, so a workspace could hold both `Twin@Example.com` and
///   `twin@example.com` (verified by insert). That shape matches *both* rows, and
///   with no `ORDER BY` the winner is whatever the plan yields — signing someone
///   into an arbitrary one of two accounts. That is the failure
///   `resolve_login_workspace` already refuses by name. Migration 065's
///   `human_email_norm_uniq` has since made the pair unstorable, so the column
///   form is no longer *ambiguous* — but it is still slower (below) and still
///   states the comparison in a second dialect.
/// * The parameter form constant-folds and keeps a plain `(workspace_id, email)`
///   b-tree — `human_email_uniq` before 065, `human_email_idx` after it, which is
///   why 065 leaves that index behind when it retires the constraint — as an
///   `Index Cond`; the column form degrades to a `Filter` over the whole index.
///   A functional index on `lower(btrim(email))` does not help here: the planner
///   cannot derive `email = lower(btrim(email))` from 064's CHECK.
///
/// Using SQL's own `lower(btrim(...))` rather than Rust's `trim().to_lowercase()`
/// keeps this comparison byte-identical to what the write paths produced —
/// `btrim` and Rust's `trim` do not agree on non-space whitespace, and that
/// disagreement is exactly how this bug class comes back.
pub async fn verify_password_login(
    conn: &mut PgConnection,
    email: &str,
    password: &str,
) -> Result<PasswordLogin, DbError> {
    if password.is_empty() {
        // Swift rejects an empty password before touching the DB.
        return Ok(PasswordLogin::Invalid);
    }
    let row = sqlx::query(
        "SELECT m.id, m.workspace_id, m.kind::text AS kind, m.status::text AS status, \
                m.display_name, m.handle, \
                momo_password_verify($1, h.password_hash) AS password_ok \
           FROM human h \
           JOIN member m ON m.id = h.member_id \
          WHERE h.email = lower(btrim($2))",
    )
    .bind(password)
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(PasswordLogin::Invalid);
    };
    let password_ok: Option<bool> = row.try_get("password_ok")?;
    if password_ok != Some(true) {
        return Ok(PasswordLogin::Invalid);
    }
    let member = decode_member(&row)?;
    match member.status.as_str() {
        "suspended" => Ok(PasswordLogin::Suspended),
        "active" => Ok(PasswordLogin::Active(member)),
        _ => Ok(PasswordLogin::Invalid),
    }
}

// ---------------------------------------------------------------------------
// the workspace roster (B4.1 — Swift `RosterRoutes.fetchRoster`, :86-191)
// ---------------------------------------------------------------------------

/// Swift `RosterRoutes.validatedLimit`: default 200, floor 1, ceiling 500.
pub const ROSTER_LIMIT_DEFAULT: i64 = 200;
pub const ROSTER_LIMIT_MAX: i64 = 500;

/// Clamp a requested roster page into `1..=500`, defaulting to 200 for anything
/// absent or unparseable (`min(max(Int($0) ?? 200, 1), 500)`).
pub fn clamp_roster_limit(requested: Option<i64>) -> i64 {
    requested
        .unwrap_or(ROSTER_LIMIT_DEFAULT)
        .clamp(1, ROSTER_LIMIT_MAX)
}

/// `?kind=` on the roster — the ONLY two values Swift accepts
/// (`validatedKindFilter`, :72-80). Anything else is a 400, not a silent
/// full-roster read: a client that asked to see only agents and got everyone
/// would render humans as agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterKindFilterInvalid;

impl std::fmt::Display for RosterKindFilterInvalid {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("kind must be human or agent")
    }
}

/// Parse the `kind`/`member_kind` query value. An absent or blank value means
/// "no filter" (Swift trims, lowercases, and treats empty as nil).
pub fn parse_roster_kind_filter(
    raw: Option<&str>,
) -> Result<Option<MemberKind>, RosterKindFilterInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    MemberKind::from_db_label(&value)
        .map(Some)
        .ok_or(RosterKindFilterInvalid)
}

/// One row of `GET /v1/workspaces/{ws}/roster` (Swift `RosterMemberDTO`,
/// `DTOs.swift:332-352`).
///
/// This is the projection that turns a `author_member_id` uuid into a name. The
/// timeline, the sidebar and the mention picker all read it, which is why it is
/// a superset of [`Member`] rather than a second identity concept: humans and
/// agents are the same table (invariant #5) and the per-kind columns simply
/// stay `None` for the other kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterMember {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: MemberKind,
    pub status: String,
    pub display_name: String,
    pub handle: String,
    pub avatar_url: Option<String>,
    /// Workspace role (`workspace_membership.role`), not a channel role.
    pub role: Option<WorkspaceRole>,
    /// How many channels this member is currently in — **as the viewer may see
    /// it**: a guest counts only the channels it shares with them.
    pub channel_count: i32,
    pub channel_ids: Vec<Uuid>,
    /// Agent capability labels declared in `agent.config->'capabilities'`.
    pub capabilities: Vec<String>,
    /// `card` for an agent with a confirmed A2A card registration, `local` for
    /// any other agent, `None` for a human.
    pub origin: Option<String>,
    pub email: Option<String>,
    pub time_zone: Option<String>,
    pub agent_model: Option<String>,
    pub owner_human_id: Option<Uuid>,
    pub max_concurrent_runs: Option<i32>,
    pub max_run_steps: Option<i32>,
    /// `agent_profile.paused` — is this agent asleep? `None` for a human, and
    /// `Some(false)` for an agent nobody has configured (no profile row is not a
    /// paused agent).
    ///
    /// **goal SRV-R2, and the one field here Swift's roster does not have.** It
    /// is added because without it an agent list cannot draw pause state at all:
    /// the only other reader is `GET …/agents/{agent}/profile`, which is an
    /// owner/agent-owner gate, so a plain member asking "is 김인턴 재워져 있나"
    /// got a 403 — and a list would have needed one such request per agent
    /// anyway.
    ///
    /// It discloses nothing new. `paused` is *already* visible to every channel
    /// member: mentioning a sleeping agent posts a **public system line** saying
    /// so (`momo_agent::paused_mention_body`). Putting it on the roster is the
    /// same fact in list form, not a new exposure. The rest of the profile —
    /// `instructions`, `enabled_tools`, `triggers` — stays behind its gate, which
    /// is why this is one boolean rather than an embedded profile.
    pub paused: Option<bool>,
    /// `member.presence_status` — the declared presence ③ of ADR-0160, **human
    /// only**. `None` for an agent (프레즌스 is 사람 전용, D4) and for a server
    /// too old to carry the column, so the field is omitted from the wire exactly
    /// like `paused` is for a human. A booting client reads its co-members'
    /// declared status from here without a re-fetch (ADR-0160 D2), and computes
    /// the effective dot as `f(this, availability)` at the render edge.
    pub presence_status: Option<PresenceStatus>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

fn decode_roster_member(row: &sqlx::postgres::PgRow) -> Result<RosterMember, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = MemberKind::from_db_label(&kind_label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown member_kind '{kind_label}'").into()))?;
    let role_label: Option<String> = row.try_get("role")?;
    Ok(RosterMember {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        status: row.try_get("status")?,
        display_name: row.try_get("display_name")?,
        handle: row.try_get("handle")?,
        avatar_url: row.try_get("avatar_url")?,
        role: role_label.as_deref().and_then(WorkspaceRole::from_db_label),
        channel_count: row.try_get("channel_count")?,
        channel_ids: row.try_get("channel_ids")?,
        capabilities: row.try_get("capabilities")?,
        origin: row.try_get("origin")?,
        email: row.try_get("email")?,
        time_zone: row.try_get("time_zone")?,
        agent_model: row.try_get("agent_model")?,
        owner_human_id: row.try_get("owner_human_id")?,
        max_concurrent_runs: row.try_get("max_concurrent_runs")?,
        max_run_steps: row.try_get("max_run_steps")?,
        paused: row.try_get("paused")?,
        presence_status: decode_optional_presence(
            row.try_get::<Option<String>, _>("presence_status")?.as_deref(),
        ),
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

/// The workspace's active members, humans and agents alike (Swift
/// `RosterRoutes.fetchRoster`).
///
/// Three properties this statement carries, each of which is the whole point of
/// the query rather than a detail:
///
/// 1. **A guest sees only what it shares.** `viewer_is_guest` narrows three
///    different things — which members appear, how many channels each is
///    reported to be in, and which channel ids are listed. Narrowing the row set
///    but not the counts would still disclose the shape of the workspace to
///    someone invited into one channel.
/// 2. **`workspace_membership` is the join, not a filter.** A `member` row with
///    no workspace membership is not on the roster at all, which is what makes
///    the projection agree with every other workspace-scoped read (ADR-0128).
/// 3. **Ordering is `kind` then `handle`** — Swift's `json_agg(… ORDER BY
///    row_json->>'kind', row_json->>'handle')`. Applied here in SQL *before*
///    `LIMIT` rather than after, so a truncated page is the first N of a stable
///    order instead of an arbitrary N that is then sorted.
///
/// goal SRV-R2 adds the `agent_profile` join for [`RosterMember::paused`]. It is
/// a `LEFT JOIN` and the projection is `CASE WHEN m.kind = 'agent' THEN
/// COALESCE(ap.paused, false) END`, which encodes two separate facts rather than
/// one: a **human** has no pause state at all (NULL → the field is omitted from
/// the wire), and an **agent without a profile row** is not paused (false). One
/// `COALESCE` over both would have told the client every human is awake, which
/// is not a thing a human can be.
pub async fn list_workspace_roster(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    viewer_is_guest: bool,
    kind_filter: Option<MemberKind>,
    limit: i64,
) -> Result<Vec<RosterMember>, DbError> {
    let rows = sqlx::query(
        "SELECT m.id, \
                m.workspace_id, \
                m.kind::text AS kind, \
                m.status::text AS status, \
                m.display_name, \
                m.handle, \
                m.avatar_url, \
                wm.role::text AS role, \
                COALESCE(cc.channel_count, 0) AS channel_count, \
                COALESCE(ch.channel_ids, '{}'::uuid[]) AS channel_ids, \
                COALESCE(( \
                  SELECT array_agg(capability.value #>> '{}' ORDER BY capability.ordinality) \
                    FROM jsonb_array_elements( \
                           CASE WHEN jsonb_typeof(a.config->'capabilities') = 'array' \
                                THEN a.config->'capabilities' \
                                ELSE '[]'::jsonb \
                           END \
                         ) WITH ORDINALITY AS capability(value, ordinality) \
                   WHERE jsonb_typeof(capability.value) = 'string' \
                ), '{}'::text[]) AS capabilities, \
                CASE \
                  WHEN m.kind = 'agent' AND EXISTS ( \
                    SELECT 1 FROM agent_card_registration acr \
                     WHERE acr.workspace_id = m.workspace_id \
                       AND acr.agent_member_id = m.id \
                       AND acr.status = 'confirmed' \
                  ) THEN 'card' \
                  WHEN m.kind = 'agent' THEN 'local' \
                  ELSE NULL \
                END AS origin, \
                h.email, \
                h.tz AS time_zone, \
                a.model AS agent_model, \
                a.owner_human_id, \
                a.max_concurrent_runs, \
                a.max_run_steps, \
                CASE WHEN m.kind = 'agent' THEN COALESCE(ap.paused, false) END AS paused, \
                CASE WHEN m.kind = 'human' THEN m.presence_status::text END AS presence_status, \
                floor(extract(epoch from m.created_at) * 1000)::bigint AS created_at_ms, \
                floor(extract(epoch from m.updated_at) * 1000)::bigint AS updated_at_ms \
           FROM member m \
           JOIN workspace_membership wm \
             ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
           LEFT JOIN human h ON h.member_id = m.id \
           LEFT JOIN agent a ON a.member_id = m.id \
           LEFT JOIN agent_profile ap \
             ON ap.workspace_id = m.workspace_id AND ap.agent_member_id = m.id \
           LEFT JOIN LATERAL ( \
             SELECT count(*)::int AS channel_count \
               FROM membership ms \
              WHERE ms.member_id = m.id \
                AND ms.left_at IS NULL \
                AND (NOT $4 OR EXISTS ( \
                  SELECT 1 FROM membership viewer_ms \
                   WHERE viewer_ms.channel_id = ms.channel_id \
                     AND viewer_ms.member_id = $2 \
                     AND viewer_ms.left_at IS NULL)) \
           ) cc ON true \
           LEFT JOIN LATERAL ( \
             SELECT COALESCE( \
                      array_agg(ms.channel_id ORDER BY ms.joined_at, ms.channel_id), \
                      '{}'::uuid[]) AS channel_ids \
               FROM membership ms \
              WHERE ms.member_id = m.id \
                AND ms.left_at IS NULL \
                AND (NOT $4 OR EXISTS ( \
                  SELECT 1 FROM membership viewer_ms \
                   WHERE viewer_ms.channel_id = ms.channel_id \
                     AND viewer_ms.member_id = $2 \
                     AND viewer_ms.left_at IS NULL)) \
           ) ch ON true \
          WHERE m.workspace_id = $1 \
            AND m.deleted_at IS NULL \
            AND m.status = 'active' \
            AND ($3::text IS NULL OR m.kind::text = $3::text) \
            AND (NOT $4 OR m.id = $2 OR EXISTS ( \
              SELECT 1 \
                FROM membership target_ms \
                JOIN membership viewer_ms \
                  ON viewer_ms.channel_id = target_ms.channel_id \
                 AND viewer_ms.member_id = $2 \
                 AND viewer_ms.left_at IS NULL \
               WHERE target_ms.member_id = m.id \
                 AND target_ms.left_at IS NULL)) \
          ORDER BY m.kind::text, m.handle, m.id \
          LIMIT $5",
    )
    .bind(workspace_id)
    .bind(viewer_member_id)
    .bind(kind_filter.map(MemberKind::as_db_label))
    .bind(viewer_is_guest)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_roster_member)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// workspace identity read (B4.1 — Swift `WorkspaceRoutes.get`, :259-286)
// ---------------------------------------------------------------------------

/// The workspace as the settings panel reads it (Swift `WorkspaceDTO`,
/// `DTOs.swift:770-775`). `updated_at_ms` is not decoration: the rename endpoint
/// takes it as an optimistic-concurrency token, so the read must hand out the
/// exact value a later write will compare against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceIdentity {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub updated_at_ms: i64,
    /// The current avatar media (ADR-0161 D5), or `None` for the initial
    /// fallback. Carried on this read so the settings panel and the rail get the
    /// avatar in the same round trip that already fetches the name — the rail's
    /// `avatarUrl` is derived from it (`GET …/avatar/content?v={media}`), and its
    /// change on replacement is what busts the client's immutable cache.
    pub avatar_media_id: Option<Uuid>,
}

/// Why a workspace read produced no workspace — the distinction Swift's
/// `ReadResult` keeps and the reason it costs an extra `EXISTS`.
///
/// A non-member must not be able to tell "this workspace does not exist" from
/// "you are not in it" by *guessing ids*, but a member of workspace A asking for
/// workspace B already knows B is not theirs. Swift resolves this by answering
/// **403 when the workspace exists** and **404 when it does not**, which is
/// exactly enough to distinguish a stale bookmark from a permissions problem in
/// the UI without turning the endpoint into an existence oracle for outsiders —
/// the credential's own workspace is checked first by the route layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceRead {
    /// No such (live) workspace.
    NotFound,
    /// It exists, but the caller is not an active member.
    NotMember,
    Found(WorkspaceIdentity),
}

/// Read a workspace's identity for an active member, in one round trip (Swift
/// `readWorkspaceForActiveMember`, :422-475).
///
/// One statement rather than two so existence and membership are answered from
/// the same snapshot: with two reads, a member removed between them would
/// produce "exists, and you are a member" for a workspace they had just left.
pub async fn read_workspace_for_active_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<WorkspaceRead, DbError> {
    let row = sqlx::query(
        "SELECT EXISTS ( \
                  SELECT 1 FROM workspace existing \
                   WHERE existing.id = $1 AND existing.deleted_at IS NULL \
                ) AS workspace_exists, \
                w.id AS workspace_id, \
                w.slug, \
                w.name, \
                w.avatar_media_id, \
                floor(extract(epoch from w.updated_at) * 1000)::bigint AS updated_at_ms \
           FROM (SELECT 1) AS anchor \
           LEFT JOIN workspace w \
             ON w.id = $1 \
            AND w.deleted_at IS NULL \
            AND EXISTS ( \
              SELECT 1 \
                FROM workspace_membership wm \
                JOIN member m \
                  ON m.id = wm.member_id AND m.workspace_id = wm.workspace_id \
               WHERE wm.workspace_id = w.id \
                 AND wm.member_id = $2 \
                 AND m.status = 'active' \
                 AND m.deleted_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;

    let found_id: Option<Uuid> = row.try_get("workspace_id")?;
    match found_id {
        Some(id) => Ok(WorkspaceRead::Found(WorkspaceIdentity {
            id,
            slug: row.try_get("slug")?,
            name: row.try_get("name")?,
            updated_at_ms: row.try_get("updated_at_ms")?,
            avatar_media_id: row.try_get("avatar_media_id")?,
        })),
        None => {
            let exists: bool = row.try_get("workspace_exists")?;
            Ok(if exists {
                WorkspaceRead::NotMember
            } else {
                WorkspaceRead::NotFound
            })
        }
    }
}

/// Resolve the Ed25519 signing key registered for a member (ADR-0146).
///
/// # Measured: no such registry exists in this schema
///
/// `public_key` appears on exactly one table — `work_host`
/// (`021_work_host.sql:17`) — and a work host is not a member. `member`,
/// `agent`, `device` and `agent_card_registration` carry no key column, and the
/// Swift `AgentCredentialRoutes` mints bearer tokens, not keypairs. So today this
/// resolves to `None` for **every** member, and a signed send is refused rather
/// than recorded.
///
/// That refusal is the point. The alternative — trusting a public key the request
/// supplied — would let any caller mint a keypair, sign its own message, and
/// produce an `action_signature` row that verifies perfectly and attests to
/// nothing. A provenance log forgeable by its own subject is worse than none,
/// because it is believed.
///
/// The function is real rather than inlined so the gap has one name, one call
/// site, and one thing to change: the fast-follow adds a member signing-key
/// registration surface (migration + route) and this body becomes its lookup.
/// Everything above it — `send_signed_message_in_tx`, the route's refusal, the
/// conformance tests — is already written against the final shape.
pub async fn resolve_member_signing_key(
    _conn: &mut PgConnection,
    _member_id: Uuid,
) -> Result<Option<String>, DbError> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_kind_labels_round_trip() {
        for kind in [MemberKind::Human, MemberKind::Agent] {
            assert_eq!(MemberKind::from_db_label(kind.as_db_label()), Some(kind));
        }
        assert_eq!(MemberKind::from_db_label("robot"), None);
    }

    #[test]
    fn workspace_role_labels_round_trip() {
        for role in [
            WorkspaceRole::Owner,
            WorkspaceRole::Admin,
            WorkspaceRole::Member,
            WorkspaceRole::Guest,
        ] {
            assert_eq!(WorkspaceRole::from_db_label(role.as_db_label()), Some(role));
        }
        assert_eq!(WorkspaceRole::from_db_label("superuser"), None);
    }

    /// ADR-0128: only owner/admin carry workspace authority. A `guest` reading
    /// as an admin would be the exact privilege confusion the role split exists
    /// to prevent.
    #[test]
    fn only_owner_and_admin_are_admins() {
        assert!(WorkspaceRole::Owner.is_admin());
        assert!(WorkspaceRole::Admin.is_admin());
        assert!(!WorkspaceRole::Member.is_admin());
        assert!(!WorkspaceRole::Guest.is_admin());
    }

    #[test]
    fn the_roster_limit_is_clamped_not_trusted() {
        assert_eq!(clamp_roster_limit(None), ROSTER_LIMIT_DEFAULT);
        assert_eq!(clamp_roster_limit(Some(0)), 1, "Swift's floor is 1, not 0");
        assert_eq!(clamp_roster_limit(Some(-9)), 1);
        assert_eq!(clamp_roster_limit(Some(37)), 37);
        assert_eq!(
            clamp_roster_limit(Some(10_000)),
            ROSTER_LIMIT_MAX,
            "a client cannot ask for an unbounded roster"
        );
    }

    /// A filter the server does not understand must be a 400. Accepting it as
    /// "no filter" would answer an agents-only question with the whole roster.
    #[test]
    fn an_unknown_roster_kind_is_refused_rather_than_widened() {
        assert_eq!(parse_roster_kind_filter(None), Ok(None));
        assert_eq!(parse_roster_kind_filter(Some("   ")), Ok(None));
        assert_eq!(
            parse_roster_kind_filter(Some(" Agent ")),
            Ok(Some(MemberKind::Agent)),
            "Swift trims and lowercases before comparing"
        );
        assert_eq!(
            parse_roster_kind_filter(Some("human")),
            Ok(Some(MemberKind::Human))
        );
        assert_eq!(
            parse_roster_kind_filter(Some("bot")),
            Err(RosterKindFilterInvalid)
        );
        assert_eq!(
            RosterKindFilterInvalid.to_string(),
            "kind must be human or agent"
        );
    }
}
