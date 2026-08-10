//! `POST /v1/join` — spending an invite code (B4.3).
//!
//! Port of Swift `Routes/JoinRoutes.swift` (:24-846). B4.2 opened the issuing
//! half (`momo_settings::invite`); this is the half that spends what it minted,
//! and until it existed an operator could create a link nobody could redeem.
//!
//! ## Why the redemption SQL lives beside the issuance SQL
//!
//! `invite_code` has exactly one owner crate. Redemption reads it, locks it and
//! increments it; putting that anywhere else would give one table two owners and
//! two ideas of what "exhausted" means. The member/human rows a join creates are
//! written here for the same reason the tenant-provisioning seed is written in
//! [`crate::workspace`] rather than in `momo-messaging`: they are the *effect* of
//! an operator-surface action, not part of the message spine.
//!
//! ## The locked lookup, and why it is a crate function
//!
//! `POST /v1/join` is mounted outside the auth middleware — the caller holds only
//! a high-entropy code, so there is no credential to name a workspace with, and
//! the tenant GUC cannot be set before the workspace is known. Migration 009
//! answers exactly that chicken-and-egg with one primitive:
//!
//! ```text
//! momo_join_private.invite_workspace_id(text) RETURNS uuid
//!   SECURITY DEFINER, STABLE, STRICT, SET search_path = pg_catalog
//!   EXECUTE granted to momo_app ONLY
//!   (revoked from PUBLIC/momo_relay/momo_worker/momo_notifier — 009 + bootstrap_roles.sql)
//! ```
//!
//! It hashes one already-normalized code and returns one uuid. It returns **no
//! tenant row**, so it is not an RLS bypass: every read and every write after it
//! runs inside `momo_db::with_tenant_tx` under that workspace's `SET LOCAL`
//! scope, and a code that resolves to workspace A can never touch workspace B —
//! [`redeem_invite_in_tx`] re-checks the invite's own `workspace_id` against the
//! transaction's before it does anything else.
//!
//! [`resolve_invite_workspace`] is therefore in **this** crate, not in the route:
//! it is a statement against `invite_code` (through a definer wrapper), and the
//! rule that routes own no SQL does not get an exception for the one statement
//! that happens to run before the GUC. The route calls it with a pool connection
//! it never binds a GUC on, which is the only way this call can be made and the
//! only place in the tree that makes it.
//!
//! ## One transaction, not four connections
//!
//! Swift runs the ban / duplicate / escalation pre-checks on separate
//! connections *before* opening the join transaction and then repeats them
//! inside it (`JoinRoutes.swift:40-54` then :64-113). This port keeps every one
//! of those checks — same order, same statuses, same wording — but runs them all
//! inside the single tenant transaction, ahead of the first write. That closes
//! the window between the pre-check and the transaction, and it is why the
//! invite row is read `FOR UPDATE` in the *first* statement instead of being
//! resolved once unlocked and locked again by id.
//!
//! **Every refusal rolls the transaction back.** They are [`JoinError::Rejected`],
//! not the `Ok(Err(_))` shape the settings routes use — that shape commits, which
//! is safe only when no rejection can follow a write, and here several can
//! (a lost redemption race is detected after the member row is inserted).
//!
//! ## The lookups normalise their own argument (#1248)
//!
//! Four pre-flight reads are keyed by the joining address — the ban check, the
//! duplicate-redemption check, the role-escalation check and the create-or-reuse
//! read. They used to compare the argument verbatim (`h.email = $1`,
//! `email_norm = lower($1)`), which was safe only because every caller ran
//! [`normalized_join_email`] first. That is a rule living in the callers rather
//! than in the statement, and #1234 is what it looks like when one caller forgets
//! it: `verify_password_login` skipped exactly this step and an account that
//! existed could not sign in.
//!
//! So each of the four now normalises **in SQL**, the same way
//! `momo_messaging::verify_password_login` does after #1234:
//!
//! * The **parameter** is folded, never the column. When this was written the
//!   only uniqueness on `human` was case-sensitive, so a workspace could hold
//!   `Twin@Example.com` beside `twin@example.com`; folding the column would match
//!   both rows and the `LIMIT 1` would pick whichever the plan yielded. #1252's
//!   migration 065 (`human_email_norm_uniq`) has since made that pair unstorable,
//!   but the parameter form stays: it constant-folds and keeps a plain
//!   `(workspace_id, email)` b-tree (`human_email_idx` after 065, which is why
//!   065 leaves one behind) / `workspace_ban_email_uniq` as an `Index Cond`,
//!   where the column form falls to a `Filter`.
//! * The fold is SQL's `lower(btrim(...))`, not Rust's `trim().to_lowercase()`.
//!   Every write path — `create_workspace.sql`, `bootstrap_owner_if_absent.sql`,
//!   `set_initial_owner.sql`, migration 064's `human_email_normalized_ck` and
//!   026's `workspace_ban_email_norm_ck` — produced its bytes with those two
//!   functions, and `btrim` and Rust's `trim` disagree about non-space
//!   whitespace. Comparing with the same functions that wrote the row is what
//!   closes the disagreement rather than moving it.
//!
//! [`normalized_join_email`] stays where it is: it still validates shape (a 400
//! for an address with no `@`) and it still decides what a *new* row stores. What
//! changed is that the reads no longer depend on it having run.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::invite::{read_invite, InviteCode};

// ---------------------------------------------------------------------------
// request-shape validation (Swift `JoinRoutes` :724-819 + `InviteRoutes.normalizedCode`)
// ---------------------------------------------------------------------------

/// A 400 the request never gets past. Messages are Swift's verbatim, because a
/// client that already renders the Swift server's errors must not have to learn
/// a second vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JoinSpecInvalid {
    #[error("invite code is invalid")]
    Code,
    #[error("email is invalid")]
    Email,
    #[error("displayName is required")]
    DisplayName,
    #[error("handle must be 2-32 chars of a-z, 0-9, _ or -")]
    Handle,
    #[error("handle could not be derived from email")]
    DerivedHandle,
    #[error("timeZone is too long")]
    TimeZone,
    #[error("password is required")]
    PasswordMissing,
    #[error("password is too long")]
    PasswordTooLong,
}

/// Swift `InviteRoutes.normalizedCode` (:492-498). Trimmed, non-empty, ≤256.
///
/// The ceiling is not decoration: this string is the argument to a `digest()`
/// call, and an unbounded body field would be an unbounded hash input.
pub fn normalized_invite_code(raw: &str) -> Result<String, JoinSpecInvalid> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > 256 {
        return Err(JoinSpecInvalid::Code);
    }
    Ok(value.to_string())
}

/// Swift `normalizedEmail` (:724-734): trimmed, lowercased, 3..=320 characters,
/// contains an `@` that is neither the first nor the last character.
///
/// Lowercasing here is load-bearing rather than cosmetic: this is the value a
/// *new* `human` row stores, and migration 064's `human_email_normalized_ck`
/// refuses anything else.
///
/// It is no longer what makes the pre-flight lookups find their rows — since
/// #1248 those fold their own argument in SQL (see this module's "the lookups
/// normalise their own argument"). Dropping this call would still be a bug, but
/// it would now be caught by the constraint instead of silently creating a
/// second account for someone who already had one.
pub fn normalized_join_email(raw: &str) -> Result<String, JoinSpecInvalid> {
    let value = raw.trim().to_lowercase();
    let length = value.chars().count();
    let shaped = (3..=320).contains(&length)
        && value.contains('@')
        && !value.starts_with('@')
        && !value.ends_with('@');
    if shaped {
        Ok(value)
    } else {
        Err(JoinSpecInvalid::Email)
    }
}

/// Swift `normalizedDisplayName` (:736-742): trimmed, non-empty, ≤100 chars.
pub fn normalized_join_display_name(raw: &str) -> Result<String, JoinSpecInvalid> {
    let value = raw.trim();
    let length = value.chars().count();
    if length == 0 || length > 100 {
        return Err(JoinSpecInvalid::DisplayName);
    }
    Ok(value.to_string())
}

/// Swift `normalizedRequestedHandle` (:744-751). `None` stays `None` — the
/// caller then falls back to [`fallback_handle`].
pub fn normalized_requested_handle(raw: Option<&str>) -> Result<Option<String>, JoinSpecInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim().to_lowercase();
    if is_valid_handle(&value) {
        Ok(Some(value))
    } else {
        Err(JoinSpecInvalid::Handle)
    }
}

/// Swift `fallbackHandle` (:753-779): the email's local part, reduced to
/// `[a-z0-9]` with every other run collapsed to a single `-`, trimmed of edge
/// `-`/`_`, capped at 32, and replaced by `member` if fewer than 2 characters
/// survive.
///
/// The derivation can still fail (`isValidHandle` at the end) and that failure is
/// a 400 rather than a silently invented handle: a handle is what the workspace
/// will call this person forever, so a request that cannot produce a valid one
/// must be told, not guessed at.
pub fn fallback_handle(email: &str) -> Result<String, JoinSpecInvalid> {
    let local = email.split('@').next().unwrap_or("member").to_lowercase();
    let mut output = String::with_capacity(local.len());
    let mut previous_was_dash = false;
    for character in local.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            output.push(character);
            previous_was_dash = false;
        } else if !previous_was_dash {
            output.push('-');
            previous_was_dash = true;
        }
    }
    let mut value = trim_handle_edges(&output);
    if value.chars().count() > 32 {
        let truncated: String = value.chars().take(32).collect();
        value = trim_handle_edges(&truncated);
    }
    if value.chars().count() < 2 {
        value = "member".to_string();
    }
    if is_valid_handle(&value) {
        Ok(value)
    } else {
        Err(JoinSpecInvalid::DerivedHandle)
    }
}

fn trim_handle_edges(value: &str) -> String {
    value.trim_matches(|c| c == '-' || c == '_').to_string()
}

/// Swift `normalizedTimeZone` (:781-788): absent or blank ⇒ `UTC`, ≤64 chars.
///
/// The value is stored verbatim (`human.tz`) rather than validated against the
/// tz database, exactly like Swift — the column is advisory display data, and
/// rejecting an unknown-but-well-formed zone would break a client shipped before
/// a tzdata update.
pub fn normalized_join_time_zone(raw: Option<&str>) -> Result<String, JoinSpecInvalid> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok("UTC".to_string());
    };
    if value.chars().count() > 64 {
        return Err(JoinSpecInvalid::TimeZone);
    }
    Ok(value.to_string())
}

/// Swift `normalizedPassword` (:790-798): required, non-empty, ≤1024 characters.
///
/// The ceiling matters for a bcrypt-backed column: `momo_password_hash` runs
/// `crypt()` inside Postgres, so an unbounded password field would be an
/// unbounded amount of DB CPU an unauthenticated caller can ask for.
pub fn normalized_join_password(raw: Option<&str>) -> Result<String, JoinSpecInvalid> {
    let Some(value) = raw.filter(|value| !value.is_empty()) else {
        return Err(JoinSpecInvalid::PasswordMissing);
    };
    if value.chars().count() > 1024 {
        return Err(JoinSpecInvalid::PasswordTooLong);
    }
    Ok(value.to_string())
}

/// Swift `isValidHandle` (:800-804): 2..=32 characters of `[a-z0-9_-]`.
pub fn is_valid_handle(value: &str) -> bool {
    let length = value.chars().count();
    (2..=32).contains(&length)
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

/// Every way a well-formed join request can be refused, with Swift's status and
/// wording (`JoinRoutes.swift` :227, :290, :327, :428, :491, :512, :550, :598,
/// :623, :647, :806-836).
///
/// This is a closed set on purpose. A join is the one write an unauthenticated
/// caller can perform, so "which refusals exist" is a security surface: a new
/// variant is a deliberate decision, not something a handler can invent inline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JoinRejection {
    /// `404` — the code hashes to nothing, or to an invite in another
    /// workspace. Deliberately indistinguishable from "no such code": a distinct
    /// answer would turn this route into an oracle for which codes exist.
    #[error("invite code is invalid")]
    InviteInvalid,
    /// `410` — the link is gone, not merely refused, so a client can stop
    /// retrying and ask for a new one instead.
    #[error("invite code is expired")]
    InviteExpired,
    /// `410`, same reasoning.
    #[error("invite code is revoked")]
    InviteRevoked,
    /// `409` — a *state* conflict: the link was valid and someone else spent it.
    #[error("invite code is exhausted")]
    InviteExhausted,
    /// `403` — an `owner` invite cannot exist (migration 003's
    /// `invite_code_role_ck`). This is the API half of that constraint, kept so
    /// a future migration that relaxed the column would still meet a refusal
    /// here rather than mint an owner over a public route.
    #[error("public join cannot grant owner or platform admin")]
    RoleNotPubliclyJoinable,
    /// `403`.
    #[error("member is banned from this workspace")]
    Banned,
    /// `409`.
    #[error("invite code was already redeemed by this member")]
    AlreadyRedeemed,
    /// `403` — a public link may not **raise** the role someone already holds.
    /// An `admin` invite handed to an existing `member` is refused, because
    /// otherwise anyone able to forward a link could promote an account. The
    /// reverse direction is allowed and is a no-op: an admin who redeems a
    /// `member` link keeps admin (the workspace upsert is `DO NOTHING`).
    #[error("public join cannot escalate an existing member role")]
    RoleEscalation,
    /// `403`.
    #[error("invite can only join human members")]
    NotHuman,
    /// `403` — suspended, or any status outside active/invited/deleted.
    #[error("human is not eligible to join")]
    HumanIneligible,
    /// `409`.
    #[error("handle is already in use")]
    HandleTaken,
    /// `409` — a workspace with no public channel has nothing to join *into*,
    /// so the join is refused rather than committing a member who can see
    /// nothing.
    #[error("workspace has no joinable public channels")]
    NoPublicChannels,
}

impl JoinRejection {
    /// The HTTP status Swift answers with. Kept beside the message so the two
    /// cannot drift, and so the route layer needs no table of its own.
    pub fn status_code(self) -> u16 {
        match self {
            JoinRejection::InviteInvalid => 404,
            JoinRejection::InviteExpired | JoinRejection::InviteRevoked => 410,
            JoinRejection::InviteExhausted
            | JoinRejection::AlreadyRedeemed
            | JoinRejection::HandleTaken
            | JoinRejection::NoPublicChannels => 409,
            JoinRejection::RoleNotPubliclyJoinable
            | JoinRejection::Banned
            | JoinRejection::RoleEscalation
            | JoinRejection::NotHuman
            | JoinRejection::HumanIneligible => 403,
        }
    }
}

/// The join transaction's error channel.
///
/// `Rejected` is a client-caused refusal and `Db` is a failure, but **both roll
/// the transaction back** — which is the difference from the settings surfaces'
/// `Ok(Err(_))` convention and the reason this type exists. Several refusals are
/// only detectable after a write (a lost redemption race, an exhausted counter),
/// so a rejection channel that committed would leave a member row behind for a
/// join that answered 409.
#[derive(Debug, thiserror::Error)]
pub enum JoinError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Rejected(#[from] JoinRejection),
}

impl From<sqlx::Error> for JoinError {
    fn from(error: sqlx::Error) -> Self {
        JoinError::Db(DbError::from(error))
    }
}

// ---------------------------------------------------------------------------
// the locked pre-flight (migration 009)
// ---------------------------------------------------------------------------

/// Resolve one **already normalized** raw invite code to its workspace, or
/// `None` when it hashes to nothing.
///
/// Runs on a connection with **no** tenant GUC bound, because there is nothing
/// to bind it to yet — that is the whole reason migration 009 created the
/// definer function. Pass a plain pool connection; do not call this inside a
/// tenant transaction, where it would be redundant.
///
/// Only `momo_app` may execute it (009 + `infra/e2e/bootstrap_roles.sql`), so if
/// this call ever starts failing with `permission denied`, the API is running
/// under the wrong role — which is precisely the alarm that grant exists to
/// raise. The conformance test asserts both halves of it.
pub async fn resolve_invite_workspace(
    conn: &mut PgConnection,
    code: &str,
) -> Result<Option<Uuid>, DbError> {
    let workspace_id: Option<Uuid> =
        sqlx::query_scalar("SELECT momo_join_private.invite_workspace_id($1)")
            .bind(code)
            .fetch_one(&mut *conn)
            .await?;
    Ok(workspace_id)
}

// ---------------------------------------------------------------------------
// the join transaction
// ---------------------------------------------------------------------------

/// The validated request, bundled so the redemption entry point stays one
/// argument wide rather than eight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequestValues {
    pub email: String,
    pub display_name: String,
    /// The handle the caller asked for, if any. `None` means "derive one".
    pub requested_handle: Option<String>,
    /// The handle derived from the email, used when `requested_handle` is `None`
    /// and — in both cases — as the second key of the ban check.
    pub fallback_handle: String,
    pub password: String,
    pub time_zone: String,
}

impl JoinRequestValues {
    /// The handle this join will actually use.
    pub fn handle(&self) -> &str {
        self.requested_handle
            .as_deref()
            .unwrap_or(&self.fallback_handle)
    }
}

/// The member this join resolved to — created or reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinedMember {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
    pub status: String,
    pub display_name: String,
    pub handle: String,
}

/// One public-channel membership the join granted (Swift `JoinMembershipDTO`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinedMembership {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub role: String,
}

/// Everything the response needs, and nothing the response must not have — there
/// is no field here that could carry the raw code or a password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinOutcome {
    pub member: JoinedMember,
    pub memberships: Vec<JoinedMembership>,
    pub invite: InviteCode,
    pub invite_id: Uuid,
    /// The role the invite granted, read under the row lock.
    pub invite_role: String,
    pub redemption_id: Uuid,
    /// `true` ⇒ 201, `false` ⇒ 200 (Swift `JoinRoutes` :212).
    pub created_member: bool,
}

/// Spend one invite code inside the caller's already-open tenant transaction.
///
/// The transaction MUST have been opened on the workspace
/// [`resolve_invite_workspace`] returned. Every refusal is an `Err`, so the
/// caller's transaction rolls back on all of them.
///
/// Order is Swift's, and the order is the contract — a caller reading the
/// response cannot tell a "banned" refusal from an "expired" one unless they are
/// evaluated in the same sequence on both servers.
pub async fn redeem_invite_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    code: &str,
    values: &JoinRequestValues,
    user_agent: Option<&str>,
) -> Result<JoinOutcome, JoinError> {
    // 1) Resolve AND lock in one statement. Swift resolves unlocked
    //    (`findInvite` :216-267) and re-reads `FOR UPDATE` by id inside the
    //    transaction (`lockInvite` :333-359); one locked read by `code_hash`
    //    (UNIQUE, migration 003) reaches the same row with no window in between.
    let locked: Option<(Uuid, Uuid, String, String)> = sqlx::query_as(
        "SELECT i.id, \
                i.workspace_id, \
                i.role::text, \
                CASE \
                  WHEN i.role::text = 'owner' THEN 'role_escalation' \
                  WHEN i.revoked_at IS NOT NULL THEN 'revoked' \
                  WHEN i.expires_at <= now() THEN 'expired' \
                  WHEN i.used_count >= i.max_uses THEN 'exhausted' \
                  ELSE 'valid' \
                END \
           FROM invite_code i \
          WHERE i.code_hash = momo_invite_code_hash($1) \
          LIMIT 1 \
            FOR UPDATE",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await?;

    // No row is 404 and so is a row belonging to someone else. The second case
    // is unreachable through the definer lookup (it returns the invite's own
    // workspace) and is checked anyway: this is the assertion that the GUC the
    // transaction runs under is the invite's tenant, and it costs one comparison.
    let Some((invite_id, invite_workspace_id, invite_role, status)) = locked else {
        return Err(JoinRejection::InviteInvalid.into());
    };
    if invite_workspace_id != workspace_id {
        return Err(JoinRejection::InviteInvalid.into());
    }
    reject_invite_status(&status)?;

    // 2) Belt and braces on the role (Swift `assertPublicJoinRole` :815-819).
    //    The status CASE above already refuses `owner`; this refuses anything
    //    that is not one of the three publicly joinable roles, so a future
    //    `membership_role` value cannot become self-service by default.
    if !matches!(invite_role.as_str(), "admin" | "member" | "guest") {
        return Err(JoinRejection::RoleNotPubliclyJoinable.into());
    }

    // 3) Bans, by email OR handle (Swift `requireNotBanned` :533-552).
    if is_banned(conn, &values.email, values.handle()).await? {
        return Err(JoinRejection::Banned.into());
    }

    // 4) This code, already spent by this email (Swift `assertNotDuplicateJoin`
    //    :269-292). Keyed by email rather than member id because the member row
    //    may not exist yet.
    if redeemed_by_email(conn, invite_id, &values.email).await? {
        return Err(JoinRejection::AlreadyRedeemed.into());
    }

    // 5) A link may not raise the role an existing member already holds (Swift
    //    `assertNoPublicRoleEscalation` :306-329, the email-keyed arm). Keyed by
    //    email because the member row may not exist yet.
    if let Some(current_role) = workspace_role_for_email(conn, &values.email).await? {
        if role_rank(&invite_role) < role_rank(&current_role) {
            return Err(JoinRejection::RoleEscalation.into());
        }
    }

    // 6) Create or reuse the human (Swift :71-99).
    let existing = find_human_by_email(conn, &values.email).await?;
    let (member, created_member) = match existing {
        Some(member) => {
            if member.kind != "human" {
                return Err(JoinRejection::NotHuman.into());
            }
            match member.status.as_str() {
                // A soft-deleted account rejoining is a re-activation, not a
                // second row: `human_email_norm_uniq` (065) would refuse the
                // second row anyway, and a new member id would orphan every
                // message the person already wrote.
                "deleted" => (
                    reactivate_deleted_human(conn, &member, values).await?,
                    false,
                ),
                "active" | "invited" => (member, false),
                _ => return Err(JoinRejection::HumanIneligible.into()),
            }
        }
        None => (create_human_member(conn, workspace_id, values).await?, true),
    };

    // 7) The member-keyed twins of (4) and (5), now that there is a member id
    //    (Swift :102-113).
    if redeemed_by_member(conn, invite_id, member.id).await? {
        return Err(JoinRejection::AlreadyRedeemed.into());
    }
    if let Some(current_role) = workspace_role_for_member(conn, member.id).await? {
        if role_rank(&invite_role) < role_rank(&current_role) {
            return Err(JoinRejection::RoleEscalation.into());
        }
    }

    // 8) Workspace authority (ADR-0128) then per-channel membership. The
    //    workspace row is upserted with DO NOTHING: a returning member keeps the
    //    role they already hold, and (5)/(7) already refused any link that would
    //    have raised it.
    ensure_workspace_membership(conn, workspace_id, member.id, &invite_role).await?;
    let memberships = join_public_channels(conn, workspace_id, member.id, &invite_role).await?;
    if memberships.is_empty() {
        return Err(JoinRejection::NoPublicChannels.into());
    }

    // 9) Spend the code. The guarded UPDATE is the authoritative exhaustion
    //    check — the row is locked, so exactly one concurrent join can be the
    //    one that takes the last use (Swift `incrementInviteUsage` :603-625).
    let spent = sqlx::query(
        "UPDATE invite_code \
            SET used_count = used_count + 1, \
                last_used_at = now(), \
                updated_at = now() \
          WHERE id = $1 \
            AND revoked_at IS NULL \
            AND expires_at > now() \
            AND used_count < max_uses",
    )
    .bind(invite_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if spent == 0 {
        return Err(JoinRejection::InviteExhausted.into());
    }

    // 10) The durable record of who spent it. The address is folded here for the
    //     same reason the four pre-flight reads fold theirs (#1248): this is the
    //     one write that took `values.email` verbatim, so a caller that skipped
    //     `normalized_join_email` left an audit row spelled differently from the
    //     `human` row the same join created or reused — the redemption history
    //     and the account it belongs to would disagree about who joined.
    let redemption_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO invite_code_redemption \
           (workspace_id, invite_code_id, member_id, email, user_agent) \
         VALUES ($1, $2, $3, lower(btrim($4)), $5) \
         ON CONFLICT (invite_code_id, member_id) DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(invite_id)
    .bind(member.id)
    .bind(&values.email)
    .bind(user_agent)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(redemption_id) = redemption_id else {
        return Err(JoinRejection::AlreadyRedeemed.into());
    };

    // 11) The invite as the client will see it, read AFTER the increment so the
    //     response's `usedCount` is the value this join produced.
    let invite = read_invite(conn, invite_id)
        .await?
        .ok_or_else(|| DbError::from(sqlx::Error::RowNotFound))?;

    Ok(JoinOutcome {
        member,
        memberships,
        invite,
        invite_id,
        invite_role,
        redemption_id,
        created_member,
    })
}

/// Swift `throwIfInviteStatusFailed` (:821-836).
fn reject_invite_status(status: &str) -> Result<(), JoinRejection> {
    match status {
        "valid" => Ok(()),
        "expired" => Err(JoinRejection::InviteExpired),
        "revoked" => Err(JoinRejection::InviteRevoked),
        "exhausted" => Err(JoinRejection::InviteExhausted),
        "role_escalation" => Err(JoinRejection::RoleNotPubliclyJoinable),
        _ => Err(JoinRejection::InviteInvalid),
    }
}

/// Swift `roleRank` (:838-845). Lower is stronger; anything unknown ranks below
/// `member`, so an unrecognised stored role can never be *escalated into*.
pub fn role_rank(role: &str) -> i32 {
    match role {
        "owner" => 0,
        "admin" => 1,
        "member" => 2,
        _ => 3,
    }
}

/// Is this **handle** banned from the workspace? — Swift
/// `JoinRoutes.requireNotBanned(email: nil, handle:)`, the spelling
/// `AgentRoutes.createAgentIdentity` (:113-115) uses.
///
/// Exported (unlike [`is_banned`]) because agent creation has no email to check
/// and needs the handle half on its own. It stays in this crate rather than
/// being re-written in `momo-agent`: `workspace_ban` has one owner, so "may this
/// handle exist" has one answer.
pub async fn is_handle_banned_in_tx(
    conn: &mut PgConnection,
    handle: &str,
) -> Result<bool, DbError> {
    let banned: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM workspace_ban WHERE handle_norm = lower(btrim($1::text)) \
         )",
    )
    .bind(handle)
    .fetch_one(&mut *conn)
    .await?;
    Ok(banned)
}

async fn is_banned(conn: &mut PgConnection, email: &str, handle: &str) -> Result<bool, DbError> {
    // The `::text` casts are Swift's (`requireNotBanned` :543-544) and they are
    // load-bearing here for a different reason: `lower` is overloaded on
    // `anyrange`/`anymultirange` as well as `text`, and an untyped bind
    // parameter would leave the resolution ambiguous.
    //
    // `btrim` joins `lower` for the reason in this module's "the lookups
    // normalise their own argument" section: 026's `workspace_ban_email_norm_ck`
    // and `workspace_ban_handle_norm_ck` store `lower(btrim(...))`, so a
    // `lower()`-only comparison cannot reach a ban row whenever the argument
    // still carries edge whitespace.
    let banned: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM workspace_ban \
            WHERE email_norm = lower(btrim($1::text)) \
               OR handle_norm = lower(btrim($2::text)) \
         )",
    )
    .bind(email)
    .bind(handle)
    .fetch_one(&mut *conn)
    .await?;
    Ok(banned)
}

/// Has this invite already been spent by this address? — keyed by email because
/// the member row may not exist yet.
///
/// The parameter carries `lower(btrim(...))` for the reason in this module's
/// "the lookups normalise their own argument" section: a miss here is a second
/// redemption of a single-use link.
async fn redeemed_by_email(
    conn: &mut PgConnection,
    invite_id: Uuid,
    email: &str,
) -> Result<bool, DbError> {
    let redeemed: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 \
             FROM invite_code_redemption r \
             JOIN human h ON h.member_id = r.member_id \
            WHERE r.invite_code_id = $1 \
              AND h.email = lower(btrim($2)) \
         )",
    )
    .bind(invite_id)
    .bind(email)
    .fetch_one(&mut *conn)
    .await?;
    Ok(redeemed)
}

async fn redeemed_by_member(
    conn: &mut PgConnection,
    invite_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let redeemed: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM invite_code_redemption \
            WHERE invite_code_id = $1 \
              AND member_id = $2 \
         )",
    )
    .bind(invite_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(redeemed)
}

/// The role this address already holds in the transaction's workspace, if any.
///
/// The parameter carries `lower(btrim(...))` for the reason in this module's
/// "the lookups normalise their own argument" section: a miss here reads as
/// "holds no role", which is the answer that lets an `admin` link through.
async fn workspace_role_for_email(
    conn: &mut PgConnection,
    email: &str,
) -> Result<Option<String>, DbError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT wm.role::text \
           FROM human h \
           JOIN workspace_membership wm \
             ON wm.workspace_id = h.workspace_id \
            AND wm.member_id = h.member_id \
          WHERE h.email = lower(btrim($1)) \
          LIMIT 1",
    )
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(role)
}

async fn workspace_role_for_member(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<String>, DbError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role::text FROM workspace_membership WHERE member_id = $1 LIMIT 1",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(role)
}

type MemberRow = (Uuid, Uuid, String, String, String, String);

fn member_from_row(row: MemberRow) -> JoinedMember {
    JoinedMember {
        id: row.0,
        workspace_id: row.1,
        kind: row.2,
        status: row.3,
        display_name: row.4,
        handle: row.5,
    }
}

/// The member this address already belongs to, if any — "create or reuse".
///
/// The parameter carries `lower(btrim(...))` for the reason in this module's
/// "the lookups normalise their own argument" section: a miss here sends the
/// join down the *create* arm for somebody who already exists.
async fn find_human_by_email(
    conn: &mut PgConnection,
    email: &str,
) -> Result<Option<JoinedMember>, DbError> {
    let row: Option<MemberRow> = sqlx::query_as(
        "SELECT m.id, m.workspace_id, m.kind::text, m.status::text, \
                m.display_name, m.handle \
           FROM human h \
           JOIN member m ON m.id = h.member_id \
          WHERE h.email = lower(btrim($1)) \
          LIMIT 1",
    )
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(member_from_row))
}

/// Swift `createHumanMember` (:390-440), one CTE.
///
/// The `NOT EXISTS` guard rather than a pre-read is deliberate: a pre-read then
/// insert would report a free handle to two concurrent joins. When the guard
/// suppresses the insert the CTE yields no row, which is the 409 — and the
/// unique index is caught too, so a race that slips between the guard and the
/// index still answers 409 rather than 500.
async fn create_human_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    values: &JoinRequestValues,
) -> Result<JoinedMember, JoinError> {
    let handle = values.handle();
    let row: Result<Option<MemberRow>, sqlx::Error> = sqlx::query_as(
        "WITH inserted_member AS ( \
           INSERT INTO member (workspace_id, kind, status, display_name, handle) \
           SELECT $1, 'human', 'active', $2, $3 \
            WHERE NOT EXISTS ( \
              SELECT 1 FROM member WHERE handle = $3 AND deleted_at IS NULL \
            ) \
           RETURNING id, workspace_id, kind::text AS kind, status::text AS status, \
                     display_name, handle \
         ), \
         inserted_human AS ( \
           INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz) \
           SELECT id, workspace_id, $4, false, momo_password_hash($5), $6 \
             FROM inserted_member \
           RETURNING member_id \
         ) \
         SELECT m.id, m.workspace_id, m.kind, m.status, m.display_name, m.handle \
           FROM inserted_member m \
           JOIN inserted_human h ON h.member_id = m.id",
    )
    .bind(workspace_id)
    .bind(&values.display_name)
    .bind(handle)
    .bind(&values.email)
    .bind(&values.password)
    .bind(&values.time_zone)
    .fetch_optional(&mut *conn)
    .await;

    match row {
        Ok(Some(row)) => Ok(member_from_row(row)),
        Ok(None) => Err(JoinRejection::HandleTaken.into()),
        Err(error) if is_handle_unique_violation(&error) => Err(JoinRejection::HandleTaken.into()),
        Err(error) => Err(JoinError::from(error)),
    }
}

/// `23505` on `member_handle_uniq` specifically. Any *other* unique violation
/// (an email racing itself into `human_email_norm_uniq`) stays a 500, because Swift
/// has no wording for it and inventing one here would be a wire change.
fn is_handle_unique_violation(error: &sqlx::Error) -> bool {
    let Some(db_error) = error.as_database_error() else {
        return false;
    };
    db_error.code().as_deref() == Some("23505")
        && db_error
            .constraint()
            .is_some_and(|name| name == "member_handle_uniq")
}

/// Swift `reactivateDeletedHuman` (:442-470). The password and timezone from
/// *this* request win — the person is proving control of the address again, and
/// a stale hash would leave them unable to log in to the account they just
/// rejoined.
async fn reactivate_deleted_human(
    conn: &mut PgConnection,
    member: &JoinedMember,
    values: &JoinRequestValues,
) -> Result<JoinedMember, DbError> {
    sqlx::query(
        "UPDATE member \
            SET status = 'active', display_name = $2, updated_at = now() \
          WHERE id = $1 AND status = 'deleted'",
    )
    .bind(member.id)
    .bind(&values.display_name)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE human \
            SET password_hash = momo_password_hash($2), tz = $3 \
          WHERE member_id = $1",
    )
    .bind(member.id)
    .bind(&values.password)
    .bind(&values.time_zone)
    .execute(&mut *conn)
    .await?;
    Ok(JoinedMember {
        status: "active".to_string(),
        display_name: values.display_name.clone(),
        ..member.clone()
    })
}

async fn ensure_workspace_membership(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    role: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(role)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Swift `createPublicChannelMemberships` (:554-601).
///
/// `DO UPDATE` rather than `DO NOTHING` so a member who *left* a channel is
/// brought back in with the invite's role, while a member who never left keeps
/// the role they already have — `membership.left_at IS NULL` is the test, and
/// getting it backwards would let a public link rewrite a channel owner's role.
async fn join_public_channels(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    role: &str,
) -> Result<Vec<JoinedMembership>, DbError> {
    let rows: Vec<(Uuid, Uuid, String)> = sqlx::query_as(
        "WITH public_channels AS ( \
           SELECT id \
             FROM channel \
            WHERE workspace_id = $1 \
              AND kind = 'public' \
              AND archived_at IS NULL \
         ), \
         inserted AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT $1, id, $2, $3::membership_role \
             FROM public_channels \
           ON CONFLICT (channel_id, member_id) DO UPDATE \
              SET left_at = NULL, \
                  role = CASE \
                           WHEN membership.left_at IS NULL \
                           THEN membership.role \
                           ELSE EXCLUDED.role \
                         END \
           RETURNING id, channel_id, role::text \
         ) \
         SELECT id, channel_id, role FROM inserted ORDER BY channel_id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(role)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, channel_id, role)| JoinedMembership {
            id,
            channel_id,
            role,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_is_trimmed_bounded_and_never_empty() {
        assert_eq!(normalized_invite_code("  abc123  ").expect("ok"), "abc123");
        assert_eq!(
            normalized_invite_code(&"a".repeat(256)).expect("at the ceiling"),
            "a".repeat(256)
        );
        for bad in ["", "   ", "\n\t"] {
            assert_eq!(normalized_invite_code(bad), Err(JoinSpecInvalid::Code));
        }
        assert_eq!(
            normalized_invite_code(&"a".repeat(257)),
            Err(JoinSpecInvalid::Code),
            "an unbounded body field would be an unbounded digest() input"
        );
    }

    #[test]
    fn the_email_is_lowercased_because_that_is_the_form_a_new_row_stores() {
        assert_eq!(
            normalized_join_email("  Ada@Example.COM ").expect("ok"),
            "ada@example.com"
        );
        for bad in ["", "a@", "@a", "nobody", &"a".repeat(319)] {
            assert_eq!(
                normalized_join_email(bad),
                Err(JoinSpecInvalid::Email),
                "{bad:?}"
            );
        }
        let long = format!("{}@example.com", "a".repeat(320));
        assert_eq!(normalized_join_email(&long), Err(JoinSpecInvalid::Email));
    }

    #[test]
    fn a_display_name_is_required_and_bounded_in_characters() {
        assert_eq!(
            normalized_join_display_name("  곽성재  ").expect("ok"),
            "곽성재"
        );
        assert_eq!(
            normalized_join_display_name(&"모".repeat(100)).expect("100 chars"),
            "모".repeat(100),
            "the bound is characters, not bytes"
        );
        assert_eq!(
            normalized_join_display_name(&"모".repeat(101)),
            Err(JoinSpecInvalid::DisplayName)
        );
        for bad in ["", "   "] {
            assert_eq!(
                normalized_join_display_name(bad),
                Err(JoinSpecInvalid::DisplayName)
            );
        }
    }

    #[test]
    fn a_requested_handle_is_lowercased_or_refused() {
        assert_eq!(
            normalized_requested_handle(Some(" Ada_Lovelace-1 ")).expect("ok"),
            Some("ada_lovelace-1".to_string())
        );
        assert_eq!(normalized_requested_handle(None).expect("absent"), None);
        for bad in ["a", "", "ada lovelace", "ada@lovelace", &"a".repeat(33)] {
            assert_eq!(
                normalized_requested_handle(Some(bad)),
                Err(JoinSpecInvalid::Handle),
                "{bad:?}"
            );
        }
    }

    /// Swift's derivation, case by case — this is the handle a workspace will
    /// call someone forever, so every rule of it is pinned.
    #[test]
    fn the_fallback_handle_is_derived_the_way_swift_derives_it() {
        assert_eq!(fallback_handle("ada@example.com").expect("ok"), "ada");
        assert_eq!(
            fallback_handle("ada.lovelace@example.com").expect("ok"),
            "ada-lovelace",
            "a run of non-alphanumerics collapses to one dash"
        );
        assert_eq!(
            fallback_handle("ada...lovelace@example.com").expect("ok"),
            "ada-lovelace"
        );
        assert_eq!(
            fallback_handle(".ada.@example.com").expect("ok"),
            "ada",
            "edge dashes are trimmed"
        );
        assert_eq!(
            fallback_handle("a@example.com").expect("ok"),
            "member",
            "fewer than two surviving characters falls back to a fixed handle"
        );
        assert_eq!(
            fallback_handle("모모@example.com").expect("ok"),
            "member",
            "a non-ascii local part collapses to a single dash, then to `member`"
        );
        let long = format!("{}@example.com", "a".repeat(40));
        assert_eq!(
            fallback_handle(&long).expect("ok").chars().count(),
            32,
            "the derived handle is capped at the column's own limit"
        );
        assert_eq!(
            fallback_handle("ada.lovelace.the.first.of.her.name.x@example.com")
                .expect("ok")
                .chars()
                .count(),
            32
        );
    }

    /// The truncation runs BEFORE the two-character floor, so a 33rd character
    /// that leaves a trailing dash cannot produce a handle ending in `-`.
    #[test]
    fn truncation_never_leaves_a_trailing_dash() {
        let email = format!("{}.x@example.com", "a".repeat(32));
        let handle = fallback_handle(&email).expect("ok");
        assert!(!handle.ends_with('-'), "{handle}");
        assert!(is_valid_handle(&handle), "{handle}");
    }

    #[test]
    fn the_time_zone_defaults_to_utc_and_is_bounded() {
        assert_eq!(normalized_join_time_zone(None).expect("absent"), "UTC");
        assert_eq!(normalized_join_time_zone(Some("  ")).expect("blank"), "UTC");
        assert_eq!(
            normalized_join_time_zone(Some(" Asia/Seoul ")).expect("ok"),
            "Asia/Seoul"
        );
        assert_eq!(
            normalized_join_time_zone(Some(&"a".repeat(65))),
            Err(JoinSpecInvalid::TimeZone)
        );
    }

    #[test]
    fn the_password_is_required_and_capped_because_bcrypt_runs_in_postgres() {
        assert_eq!(
            normalized_join_password(Some("hunter2")).expect("ok"),
            "hunter2"
        );
        assert_eq!(
            normalized_join_password(None),
            Err(JoinSpecInvalid::PasswordMissing)
        );
        assert_eq!(
            normalized_join_password(Some("")),
            Err(JoinSpecInvalid::PasswordMissing)
        );
        assert_eq!(
            normalized_join_password(Some(&"a".repeat(1025))),
            Err(JoinSpecInvalid::PasswordTooLong),
            "an unauthenticated caller must not be able to ask for unbounded crypt() work"
        );
    }

    /// The status table is the contract a client retries (or stops retrying) on.
    #[test]
    fn the_invite_status_table_matches_swift() {
        assert_eq!(reject_invite_status("valid"), Ok(()));
        for (status, expected) in [
            ("expired", JoinRejection::InviteExpired),
            ("revoked", JoinRejection::InviteRevoked),
            ("exhausted", JoinRejection::InviteExhausted),
            ("role_escalation", JoinRejection::RoleNotPubliclyJoinable),
            ("something-new", JoinRejection::InviteInvalid),
        ] {
            assert_eq!(reject_invite_status(status), Err(expected), "{status}");
        }
    }

    #[test]
    fn every_refusal_carries_swifts_status_and_wording() {
        let cases = [
            (JoinRejection::InviteInvalid, 404, "invite code is invalid"),
            (JoinRejection::InviteExpired, 410, "invite code is expired"),
            (JoinRejection::InviteRevoked, 410, "invite code is revoked"),
            (
                JoinRejection::InviteExhausted,
                409,
                "invite code is exhausted",
            ),
            (
                JoinRejection::RoleNotPubliclyJoinable,
                403,
                "public join cannot grant owner or platform admin",
            ),
            (
                JoinRejection::Banned,
                403,
                "member is banned from this workspace",
            ),
            (
                JoinRejection::AlreadyRedeemed,
                409,
                "invite code was already redeemed by this member",
            ),
            (
                JoinRejection::RoleEscalation,
                403,
                "public join cannot escalate an existing member role",
            ),
            (
                JoinRejection::NotHuman,
                403,
                "invite can only join human members",
            ),
            (
                JoinRejection::HumanIneligible,
                403,
                "human is not eligible to join",
            ),
            (JoinRejection::HandleTaken, 409, "handle is already in use"),
            (
                JoinRejection::NoPublicChannels,
                409,
                "workspace has no joinable public channels",
            ),
        ];
        for (rejection, status, message) in cases {
            assert_eq!(rejection.status_code(), status, "{rejection:?}");
            assert_eq!(rejection.to_string(), message, "{rejection:?}");
        }
        assert_eq!(
            cases.len(),
            12,
            "a new refusal is a security decision: add it to this table too"
        );
    }

    /// The escalation predicate is `rank(invite) < rank(current)`, and the
    /// direction is the whole point: a link may not RAISE a role, and the
    /// reverse is a permitted no-op.
    #[test]
    fn role_rank_orders_the_ladder_and_only_upward_moves_are_refused() {
        assert!(role_rank("owner") < role_rank("admin"));
        assert!(role_rank("admin") < role_rank("member"));
        assert!(role_rank("member") < role_rank("guest"));
        assert_eq!(
            role_rank("guest"),
            role_rank("platform_admin"),
            "an unrecognised stored role ranks last, so it can never be escalated into"
        );

        let escalates = |invite: &str, current: &str| role_rank(invite) < role_rank(current);
        assert!(
            escalates("admin", "member"),
            "an admin link handed to an existing member is the attack this refuses"
        );
        assert!(escalates("member", "guest"));
        assert!(
            !escalates("member", "admin"),
            "an admin redeeming a member link keeps admin — allowed, and a no-op"
        );
        assert!(!escalates("member", "member"), "an equal role is no change");
    }

    #[test]
    fn the_used_handle_prefers_the_requested_one() {
        let values = JoinRequestValues {
            email: "ada@example.com".into(),
            display_name: "Ada".into(),
            requested_handle: Some("ada-l".into()),
            fallback_handle: "ada".into(),
            password: "hunter2".into(),
            time_zone: "UTC".into(),
        };
        assert_eq!(values.handle(), "ada-l");
        let derived = JoinRequestValues {
            requested_handle: None,
            ..values
        };
        assert_eq!(derived.handle(), "ada");
    }
}
