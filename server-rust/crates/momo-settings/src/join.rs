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
//! ## An existing account is resumed only with proof (#4625)
//!
//! An invite code names a workspace and a role. It does **not** name a person, so
//! it cannot vouch for whoever types an address. The create-or-reuse step is
//! therefore a gate, and it sits **before** every read that talks about the
//! account (the duplicate-redemption and role-escalation checks), so nothing about
//! an existing account is said to a caller who has not shown they hold it:
//!
//! | the address belongs to | answer |
//! |---|---|
//! | nobody | a new account is created (unchanged) |
//! | an `active` account | the request's password is checked, and only a match resumes the account — [`JoinRejection::InvalidCredentials`] (401) otherwise. The password, the name and the time zone are **never written** |
//! | a `suspended` account | [`JoinRejection::HumanIneligible`] (403), the rule that was already here |
//! | `invited`, `deleted`, or any status this table does not list | [`JoinRejection::EmailUnavailable`] (409): no session, no resumption, nothing changed, and the same answer for every one of them |
//!
//! "A match" is the verdict login reaches: the SQL predicate is
//! `momo_password_verify(<sent>, human.password_hash)`, the function
//! `momo_messaging::verify_password_login` calls (this crate cannot depend on
//! `momo-messaging`, which depends on it, so the predicate is restated here and a
//! conformance test holds the two to the same verdicts). An account with no stored
//! password never matches.
//!
//! **Guesses are budgeted before they are made.** The check runs bcrypt inside the
//! database for a caller who holds nothing but a code, so each one is first spent
//! from a [`PasswordGuessBudget`] the transport layer supplies; a spent budget is
//! [`JoinRejection::PasswordGuessLimited`] and bcrypt never runs. The budget is
//! keyed by the account, not by the code or the address the request came from, so
//! trying another code or another address does not buy a fresh one.
//!
//! **The order is enforced where a test cannot reach it.** The comparison takes a
//! `guess::Permit` (private), which only a successful spend from the budget can produce, so
//! "compare first, count afterwards" does not compile. The other two orders — the
//! invite's own state and a ban before the gate — are held by conformance tests.
//!
//! **The join stands in line with every membership change.** The transaction's
//! first statement takes the workspace's membership lock in shared mode
//! ([`crate::share_membership_state`]), the lock every suspend, reinstatement,
//! removal, self-leave and role change already takes exclusively as *its* first
//! statement. A join therefore sees a workspace wholly before such a change or
//! wholly after it: an operator who is first makes the join read the new state (and
//! refuse it), and a join that is first makes the operator wait, then revoke the
//! session the join just recorded and delete the rows it wrote. Without the lock a
//! removal could land between the gate and the role-escalation check and leave the
//! invite's role on the removed member. (A row lock on the member was tried first
//! and deadlocked with self-leave, which deletes the membership rows before it
//! touches the member; the advisory lock has no row order to get wrong.)
//!
//! **The session is recorded in this same transaction** (the route does it, on the
//! connection that holds the lock). If it were minted afterwards, a suspension or
//! removal that arrives between the commit and the recording would have revoked only
//! the tokens that existed and the pair minted next would escape it.
//!
//! This is a gate on **state and proof**, not a way to hide that an account exists:
//! a join with an unused address creates an account, so "created" against "refused"
//! tells an invite holder which addresses are taken, and no wording can change that
//! while the same door both registers and resumes.
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

use momo_auth::{normalized_new_password, NewPasswordInvalid};
use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::invite::{read_invite, InviteCode};
use crate::workspace::share_membership_state;

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
    /// No password at all (absent or empty): the sentence this route has always
    /// answered, with no `error.code`.
    #[error("password is required")]
    PasswordMissing,
    /// A password that is present but breaks the ADR-0215 D2 rule: too short,
    /// too long, or holding a NUL. Never [`NewPasswordInvalid::Missing`] (that is
    /// [`Self::PasswordMissing`]): the route puts the wire `error.code` on it.
    #[error(transparent)]
    NewPassword(NewPasswordInvalid),
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

/// Swift `normalizedPassword` (:790-798), tightened by ADR-0215 D2 (#4593): the
/// joining human is *choosing* a password, so it must be at least 10 characters
/// and at most 72 bytes of UTF-8 — the one rule
/// [`momo_auth::normalized_new_password`] holds for every path that sets one.
///
/// The ceiling matters for a bcrypt-backed column: `momo_password_hash` runs
/// `crypt()` inside Postgres, so an unbounded password field would be an
/// unbounded amount of DB CPU an unauthenticated caller can ask for. 72 bytes
/// is also all bcrypt reads, and is far below the 1024 characters this used to
/// allow.
///
/// Absent and empty stay the code-less "password is required" they always were.
pub fn normalized_join_password(raw: Option<&str>) -> Result<String, JoinSpecInvalid> {
    let Some(value) = raw.filter(|value| !value.is_empty()) else {
        return Err(JoinSpecInvalid::PasswordMissing);
    };
    normalized_new_password(value).map_err(|invalid| match invalid {
        NewPasswordInvalid::Missing => JoinSpecInvalid::PasswordMissing,
        other => JoinSpecInvalid::NewPassword(other),
    })
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
    /// `403` — a suspended account. (It used to be "any status outside
    /// active/invited/deleted"; suspended is the only such value, and a status the
    /// enum gains later is [`JoinRejection::EmailUnavailable`].)
    #[error("human is not eligible to join")]
    HumanIneligible,
    /// `401` — the address belongs to a live account and the password sent with
    /// the request is not that account's. The sentence is login's own, because the
    /// two doors ask the same question and a client must not learn a second way to
    /// hear "no". Its machine code is `invalid_credentials` (login's 401 carries
    /// none yet).
    #[error("invalid credentials")]
    InvalidCredentials,
    /// `409` — the address belongs to an account a public code may never resume:
    /// `invited`, `deleted`, or a status this crate does not know. One answer for
    /// all of them, so the refusal does not say which one the account is in. Its
    /// machine code is `join_email_unavailable`.
    #[error("email is unavailable for this invite")]
    EmailUnavailable,
    /// `429` — the account's password-guess budget is spent
    /// ([`PasswordGuessBudget`]). The sentence is the one every other limiter
    /// answers with; `retry_after_seconds` is what the transport turns into
    /// `Retry-After`.
    #[error("rate limit exceeded")]
    PasswordGuessLimited { retry_after_seconds: u64 },
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
    /// The HTTP status Swift answers with (and, for the refusals #4625 added, the
    /// status this server chose). Kept beside the message so the two cannot drift,
    /// and so the route layer needs no table of its own.
    pub fn status_code(self) -> u16 {
        match self {
            JoinRejection::InvalidCredentials => 401,
            JoinRejection::InviteInvalid => 404,
            JoinRejection::InviteExpired | JoinRejection::InviteRevoked => 410,
            JoinRejection::InviteExhausted
            | JoinRejection::AlreadyRedeemed
            | JoinRejection::EmailUnavailable
            | JoinRejection::HandleTaken
            | JoinRejection::NoPublicChannels => 409,
            JoinRejection::PasswordGuessLimited { .. } => 429,
            JoinRejection::RoleNotPubliclyJoinable
            | JoinRejection::Banned
            | JoinRejection::RoleEscalation
            | JoinRejection::NotHuman
            | JoinRejection::HumanIneligible => 403,
        }
    }

    /// The stable machine code (`error.code` on the wire) of the refusals a client
    /// branches on, `None` for the ones that have always been told by status and
    /// sentence alone. Listed variant by variant — no catch-all — so a refusal added
    /// later has to decide whether it names itself.
    pub fn code(self) -> Option<&'static str> {
        match self {
            JoinRejection::InvalidCredentials => Some("invalid_credentials"),
            JoinRejection::EmailUnavailable => Some("join_email_unavailable"),
            JoinRejection::InviteInvalid
            | JoinRejection::InviteExpired
            | JoinRejection::InviteRevoked
            | JoinRejection::InviteExhausted
            | JoinRejection::RoleNotPubliclyJoinable
            | JoinRejection::Banned
            | JoinRejection::AlreadyRedeemed
            | JoinRejection::RoleEscalation
            | JoinRejection::NotHuman
            | JoinRejection::HumanIneligible
            | JoinRejection::PasswordGuessLimited { .. }
            | JoinRejection::HandleTaken
            | JoinRejection::NoPublicChannels => None,
        }
    }
}

/// A password guess the transport layer refused: how long until the account's
/// budget has room again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuessRefused {
    /// Whole seconds, at least 1 (a client told to retry immediately would just be
    /// refused again).
    pub retry_after_seconds: u64,
}

/// The transport layer's say over how many password guesses one account may be
/// asked to judge — the one decision this crate cannot make for itself, because
/// the counters live in the server process, not in the database.
///
/// [`redeem_invite_in_tx`] calls [`spend`](Self::spend) **immediately before** it
/// asks the database to compare a password, and only for an account whose state
/// lets the comparison matter (`active`). An `Err` ends the join with
/// [`JoinRejection::PasswordGuessLimited`] and the comparison is never run, so a
/// spent budget costs the caller no bcrypt work and answers nothing about the
/// password.
///
/// The arguments are the account as the database holds it — the member id and the
/// **stored** address, not the spelling the caller typed — so a budget keyed on
/// them cannot be sidestepped by spelling the same address another way (the lesson
/// of #1248). A caller that wants the comparison unbudgeted has to say so by
/// writing an implementation that always allows; there is no default.
pub trait PasswordGuessBudget: Sync {
    /// Spend one guess at this account's password, or refuse it.
    fn spend(&self, workspace_id: Uuid, member_id: Uuid, email: &str) -> Result<(), GuessRefused>;
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
/// Only `momo_app` may execute it (009 + `infra/rust/sql/bootstrap_roles.sql`), so if
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
    /// For an address with no account: the password the new account is created
    /// with. For an address that has one: the proof that the caller holds it — it
    /// is compared with the stored password and **never written**.
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
/// Order is Swift's, with one deliberate insertion (3b, #4625), and the order is
/// the contract — a caller reading the response cannot tell a "banned" refusal
/// from an "expired" one unless they are evaluated in the same sequence on both
/// servers. What the insertion fixes is *where the account is first discussed*:
/// the invite's own state and the ban come first (neither says anything about an
/// account), then the existing-account gate, then every check that does.
///
/// `guess_budget` is how the transport layer limits password guesses (see
/// [`PasswordGuessBudget`]); it is a required argument, with no unbudgeted default.
///
/// The transaction holds the workspace's membership lock in shared mode from its
/// first statement to its commit (see the module docs). A caller that goes on to
/// mint a session for the member should record it **on this connection**, inside
/// the same transaction, so that a suspension or removal that follows revokes it.
pub async fn redeem_invite_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    code: &str,
    values: &JoinRequestValues,
    user_agent: Option<&str>,
    guess_budget: &dyn PasswordGuessBudget,
) -> Result<JoinOutcome, JoinError> {
    // 0) Stand in line with the membership mutations (see the module's "the join
    //    stands in line" paragraph). First, before any read the rest relies on.
    share_membership_state(conn, workspace_id).await?;

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

    // 3b) An account that already has this address is resumed only with proof, and
    //     nothing about it is said before that (#4625). This sits ahead of (4) and
    //     (5) on purpose: both of them answer a question about the account — "did
    //     it already spend this code", "what role does it hold" — and a caller who
    //     has not shown they hold the account is owed neither answer.
    let existing = find_human_by_email(conn, workspace_id, &values.email).await?;
    let resumed = match existing {
        Some(account) => {
            Some(admit_existing_account(conn, workspace_id, account, values, guess_budget).await?)
        }
        None => None,
    };

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

    // 6) Create the human, or resume the one 3b admitted (Swift :71-99). There is
    //    no re-activation arm any more: a `deleted` account is refused at 3b, and a
    //    second row for its address would be refused by `human_email_norm_uniq`
    //    (065) anyway.
    let (member, created_member) = match resumed {
        Some(member) => (member, false),
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

/// Email-or-handle ban check used by public join and member-self redeem.
pub async fn is_identity_banned_in_tx(
    conn: &mut PgConnection,
    email: &str,
    handle: &str,
) -> Result<bool, DbError> {
    is_banned(conn, email, handle).await
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

/// The account this address already belongs to: the member, and the address as the
/// database **stores** it (which is what a per-account budget must be keyed on —
/// not the spelling the caller typed).
struct ExistingAccount {
    member: JoinedMember,
    stored_email: String,
}

/// The account this address already belongs to in `workspace_id`, if any.
///
/// The parameter carries `lower(btrim(...))` for the reason in this module's
/// "the lookups normalise their own argument" section: a miss here sends the
/// join down the *create* arm for somebody who already exists — and, since #4625,
/// past the gate that only an existing account has to clear. The workspace is named
/// in the statement as well as by the tenant GUC: the row-level policy is what
/// keeps another tenant out, and this makes the statement say so too.
///
/// A plain read: what stops the answer from going stale before commit is the shared
/// membership lock this transaction already holds, not a lock on the row.
async fn find_human_by_email(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    email: &str,
) -> Result<Option<ExistingAccount>, DbError> {
    let row: Option<(Uuid, Uuid, String, String, String, String, String)> = sqlx::query_as(
        "SELECT m.id, m.workspace_id, m.kind::text, m.status::text, \
                m.display_name, m.handle, h.email \
           FROM human h \
           JOIN member m ON m.id = h.member_id \
          WHERE h.workspace_id = $2 \
            AND h.email = lower(btrim($1)) \
          LIMIT 1",
    )
    .bind(email)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(
        |(id, workspace_id, kind, status, display_name, handle, stored_email)| ExistingAccount {
            member: member_from_row((id, workspace_id, kind, status, display_name, handle)),
            stored_email,
        },
    ))
}

/// Spending a guess, and the proof that one was spent.
///
/// `Permit` has no constructor outside this module, and
/// [`password_matches`] will not run without one, so the order the ADR promises —
/// the budget is asked **before** the comparison — is a property of the types
/// rather than of a line order a later edit could swap.
mod guess {
    use super::{JoinRejection, PasswordGuessBudget, Uuid};

    /// A guess that was spent from the budget and has not been used yet.
    #[must_use = "a spent guess is only worth something when the comparison it paid for runs"]
    pub(super) struct Permit(());

    /// Ask the budget for one guess at this account's password.
    pub(super) fn spend(
        budget: &dyn PasswordGuessBudget,
        workspace_id: Uuid,
        member_id: Uuid,
        stored_email: &str,
    ) -> Result<Permit, JoinRejection> {
        budget
            .spend(workspace_id, member_id, stored_email)
            .map(|()| Permit(()))
            .map_err(|refused| JoinRejection::PasswordGuessLimited {
                retry_after_seconds: refused.retry_after_seconds,
            })
    }
}

/// The gate an existing account has to clear before the join may go on (see the
/// module's "an existing account is resumed only with proof" section).
///
/// * not a human → [`JoinRejection::NotHuman`] (unchanged; a `human` row cannot
///   belong to anything else, so this is a defensive refusal);
/// * `suspended` → [`JoinRejection::HumanIneligible`], the refusal that was here
///   before the gate, and — like login — without a comparison;
/// * anything but `active` (`invited`, `deleted`, a status added later) →
///   [`JoinRejection::EmailUnavailable`], the same answer for all of them;
/// * `active` → one guess is spent from `guess_budget`, **then** the password is
///   compared; a mismatch is [`JoinRejection::InvalidCredentials`].
///
/// Nothing here writes. A caller that clears the gate gets the account back
/// exactly as it was, and every refusal rolls the transaction back.
async fn admit_existing_account(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    account: ExistingAccount,
    values: &JoinRequestValues,
    guess_budget: &dyn PasswordGuessBudget,
) -> Result<JoinedMember, JoinError> {
    let ExistingAccount {
        member,
        stored_email,
    } = account;
    if member.kind != "human" {
        return Err(JoinRejection::NotHuman.into());
    }
    match member.status.as_str() {
        "active" => {}
        "suspended" => return Err(JoinRejection::HumanIneligible.into()),
        _ => return Err(JoinRejection::EmailUnavailable.into()),
    }
    let permit = guess::spend(guess_budget, workspace_id, member.id, &stored_email)?;
    if !password_matches(conn, member.id, &values.password, permit).await? {
        return Err(JoinRejection::InvalidCredentials.into());
    }
    Ok(member)
}

/// Does `password` match what this member's `human` row stores? The predicate is
/// `momo_messaging::verify_password_login`'s own — `momo_password_verify(raw,
/// stored_hash)` (migration 005), which is false for an empty password, for no
/// stored hash and for a stored value that is not a bcrypt string — so the join
/// door and the login door cannot disagree about who holds an account. A row that
/// is not there matches nothing.
///
/// The permit is the proof that the budget was asked first; it is consumed here.
async fn password_matches(
    conn: &mut PgConnection,
    member_id: Uuid,
    password: &str,
    _permit: guess::Permit,
) -> Result<bool, DbError> {
    let matched: Option<Option<bool>> = sqlx::query_scalar(
        "SELECT momo_password_verify($1, h.password_hash) \
           FROM human h \
          WHERE h.member_id = $2",
    )
    .bind(password)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(matched.flatten() == Some(true))
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
pub fn is_handle_unique_violation(error: &sqlx::Error) -> bool {
    let Some(db_error) = error.as_database_error() else {
        return false;
    };
    db_error.code().as_deref() == Some("23505")
        && db_error
            .constraint()
            .is_some_and(|name| name == "member_handle_uniq")
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
    fn the_password_is_required_and_held_to_the_new_password_rule() {
        assert_eq!(
            normalized_join_password(Some("hunter2-hunter2")).expect("ok"),
            "hunter2-hunter2"
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
            Err(JoinSpecInvalid::NewPassword(NewPasswordInvalid::TooLong)),
            "an unauthenticated caller must not be able to ask for unbounded crypt() work"
        );
    }

    /// ADR-0215 D2 on the join path: nine characters are refused, ten pass;
    /// 72 bytes pass and 73 do not, even when those 73 bytes are only 25
    /// characters. The shared rule is tested in `momo_auth::password_rules`;
    /// this pins that join actually asks it.
    #[test]
    fn join_holds_the_new_password_to_ten_characters_and_seventy_two_bytes() {
        assert_eq!(
            normalized_join_password(Some("abcdefghi")),
            Err(JoinSpecInvalid::NewPassword(NewPasswordInvalid::TooShort))
        );
        assert_eq!(
            normalized_join_password(Some("abcdefghij")).expect("ten characters pass"),
            "abcdefghij"
        );
        let seventy_two = "\u{D55C}".repeat(24);
        assert_eq!(seventy_two.len(), 72);
        assert_eq!(
            normalized_join_password(Some(&seventy_two)).expect("72 bytes pass"),
            seventy_two
        );
        assert_eq!(
            normalized_join_password(Some(&format!("{seventy_two}a"))),
            Err(JoinSpecInvalid::NewPassword(NewPasswordInvalid::TooLong)),
            "73 bytes, 25 characters: the ceiling is bytes"
        );
        // Ten characters, the tenth a NUL: long enough and short enough, refused
        // for the NUL alone.
        assert_eq!(
            normalized_join_password(Some("abcdefghi\0")),
            Err(JoinSpecInvalid::NewPassword(
                NewPasswordInvalid::InvalidChar
            ))
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
            (
                JoinRejection::InvalidCredentials,
                401,
                "invalid credentials",
            ),
            (
                JoinRejection::EmailUnavailable,
                409,
                "email is unavailable for this invite",
            ),
            (
                JoinRejection::PasswordGuessLimited {
                    retry_after_seconds: 7,
                },
                429,
                "rate limit exceeded",
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
            15,
            "a new refusal is a security decision: add it to this table too"
        );
    }

    /// Only the two refusals #4625 added name themselves. The rest have always been
    /// told by status and sentence, and a code appearing on one of them is a wire
    /// change that has to be decided, not inherited.
    #[test]
    fn exactly_the_two_account_refusals_carry_a_machine_code() {
        assert_eq!(
            JoinRejection::InvalidCredentials.code(),
            Some("invalid_credentials")
        );
        assert_eq!(
            JoinRejection::EmailUnavailable.code(),
            Some("join_email_unavailable")
        );
        for rejection in [
            JoinRejection::InviteInvalid,
            JoinRejection::InviteExpired,
            JoinRejection::InviteRevoked,
            JoinRejection::InviteExhausted,
            JoinRejection::RoleNotPubliclyJoinable,
            JoinRejection::Banned,
            JoinRejection::AlreadyRedeemed,
            JoinRejection::RoleEscalation,
            JoinRejection::NotHuman,
            JoinRejection::HumanIneligible,
            JoinRejection::PasswordGuessLimited {
                retry_after_seconds: 1,
            },
            JoinRejection::HandleTaken,
            JoinRejection::NoPublicChannels,
        ] {
            assert_eq!(rejection.code(), None, "{rejection:?}");
        }
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
            password: "hunter2-hunter2".into(),
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
