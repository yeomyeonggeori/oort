//! Who is worth waking for an approval — the decision route's rule, asked of one
//! person (ADR-0204 D7, #3928).
//!
//! An `approval_request` card used to push every human in its channel, including
//! the ones the decision route would refuse. On the lock screen that is a 승인
//! button that answers 403. The audience is now the people who **may approve**.
//!
//! ## One rule, two readers
//!
//! This module does not hold the rule. The rule is the decision route's
//! (`bins/momo-server/src/routes/approvals.rs`), and the part of it that is a
//! *choice* — which condition an approval puts on its decider — is a pure
//! function in `momo-agent` that the route itself dispatches on. The part that is
//! *evaluation* — is this person an admin, does that person own the agent — is
//! answered by **the function the route's own gate calls**, gate by gate:
//!
//! | what the route asks | where it is decided | what this module calls |
//! |---|---|---|
//! | active human member, in the room | the judgment SQL's own joins (`member.kind='human'`, `status='active'`, `membership.left_at IS NULL`) — the same predicates as `is_active_human_member_in_tx` / `is_active_channel_member_in_tx` | — |
//! | the role/owner condition | [`momo_agent::decider_gate`] | the same function, `approve = true` |
//! | an `agent_editor` card's subject | [`momo_agent::pinned_target_agent`] | the same function |
//! | a `requesting_member` card's person (`member.avatar.set`) | [`momo_agent::pinned_target_member`] | the same function |
//! | whose machine a spawn is about | [`momo_agent::approval::reference_execution_host`] | the same function |
//! | an admin gate (`require_admin`) | `momo_auth::active_workspace_role` → `is_admin()` | the same two calls |
//! | an agent-editor gate (`require_profile_editor_in_tx`) | `momo_messaging::active_workspace_role` → `is_admin()`, then `agent_owner_in_tx` | the same calls, in the same order |
//! | does this person own that host | `momo_t3::remote_host_owner_in_tx` | the same function |
//!
//! The two role lookups are twins (the routes themselves use one for the admin
//! gate and the other for the editor gate, with identical SQL); each arm below
//! calls the one **its** route gate calls, so "the same function" is literal.
//! What is *choice* is data both sides read; what is *evaluation* lives behind
//! functions both sides call. The agreement between this audience and the route's
//! refusals is measured, not asserted: `approval_push_audience_conformance_pg`
//! drives the real decision route and the real judgment over the same fixtures
//! and fails if they ever disagree about a person.
//!
//! ## Resolved once per card, asked once per person
//!
//! Everything that depends on the card alone — the gate it puts on its decider,
//! the machine it is about and that machine's owner — is resolved **once**
//! ([`CardAudience::resolve`]), not once per person in the room. Only what depends
//! on the person (their workspace role, whether they own the target agent) is
//! asked per person ([`CardAudience::allows`]).
//!
//! ## The approve half is the audience
//!
//! A notification exists to ask for an 승인. A person who could only say no (a
//! room member looking at an admin-gated action) is not who it is for, so the
//! gate is [`decider_gate`] with `approve = true`.
//!
//! ## Two honest approximations
//!
//! * [`GatePlan::Operator`] is "a workspace admin **or** a principal carrying the
//!   platform operator scope". The scope is a property of the caller's token; no
//!   row records it, so a judgment that reads rows can only see the admin half.
//!   An operator who is not a workspace admin still sees the card in the channel.
//! * The route judges a spawn against the host the *decider* picks. This module
//!   judges it against the host the card pre-selected, the only one it can know:
//!   when that host is somebody's own machine, its owner is who is asked — the
//!   person ADR-0188 D3 names, and the only one who may even reject it. A member
//!   who would approve by redirecting to a workspace host is not woken.

use momo_agent::approval::reference_execution_host;
use momo_agent::provisioning::agent_owner_in_tx;
use momo_agent::{
    decider_gate, pinned_expression_subject, pinned_target_agent, pinned_target_member, GatePlan,
};
use momo_db::DbError;
use momo_t3::{remote_host_owner_in_tx, T3Error};
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

/// The approval a push candidate is the card of, as the judgment read it.
///
/// `payload` is the **routing projection** of `approval.payload` — only the paths
/// the shared functions read (`action.id`, `action.pins`, `execution`, `origin`, and for
/// `opens_in_app` the tool's name and a bare avatar marker), never the card's arguments
/// or rationale. See `judgment.rs`.
#[derive(Debug, Clone)]
pub struct ApprovalCard {
    pub approval_id: Uuid,
    pub action_type: String,
    pub payload: Value,
}

/// What an approval card puts on whoever decides it, resolved once.
#[derive(Debug, Clone)]
pub struct CardAudience {
    plan: GatePlan,
    /// The `agent_editor` card's subject (`action.pins.target`).
    target_agent: Option<Uuid>,
    /// The `requesting_member` card's person (`action.pins.target`, `member.avatar.set`).
    target_member: Option<Uuid>,
    /// The face an `expression.create` card names (`action.pins.subject`), if any.
    expression_subject: Option<Uuid>,
    /// ADR-0188 D3: the owner of the member-scoped machine this card is about — set
    /// only when the card's host is somebody's own. A workspace host, no host at
    /// all, or a host this workspace does not have say nothing here.
    host_owner: Option<Uuid>,
}

impl CardAudience {
    /// Resolve the card-level half of the decision route's gates. Reads at most one
    /// row (the host's owner).
    pub async fn resolve(
        conn: &mut PgConnection,
        workspace_id: Uuid,
        card: &ApprovalCard,
    ) -> Result<CardAudience, DbError> {
        let host_owner = match reference_execution_host(&card.payload) {
            None => None,
            Some(host) => remote_host_owner_in_tx(conn, workspace_id, host)
                .await
                .map_err(t3_to_db)?,
        };
        Ok(CardAudience {
            plan: decider_gate(&card.action_type, &card.payload, true),
            target_agent: pinned_target_agent(&card.payload),
            target_member: pinned_target_member(&card.payload),
            expression_subject: pinned_expression_subject(&card.payload),
            host_owner,
        })
    }

    /// May `member_id` approve this card — i.e. would the decision route's gates let
    /// them through? Read-only.
    ///
    /// The caller has already established that the member is an active human in the
    /// approval's channel (the judgment's own joins); this is everything after that.
    pub async fn allows(
        &self,
        conn: &mut PgConnection,
        workspace_id: Uuid,
        member_id: Uuid,
    ) -> Result<bool, DbError> {
        // ---- ADR-0188 D3: work headed to somebody's own machine is theirs -------
        // Answered by the card alone, so it goes first and costs no query.
        if self.host_owner.is_some_and(|owner| owner != member_id) {
            return Ok(false);
        }

        // ---- the role / owner condition ----------------------------------------
        match self.plan {
            GatePlan::ChannelMember => Ok(true),
            // Admin: `require_admin`, which calls `momo_auth::active_workspace_role`.
            // Operator: its admin half (see the module docs).
            GatePlan::Admin | GatePlan::Operator => {
                Ok(
                    momo_auth::active_workspace_role(conn, workspace_id, member_id)
                        .await
                        .map_err(DbError::from)?
                        .is_some_and(|role| role.is_admin()),
                )
            }
            // `member.avatar.set`: the person the card was drawn for, and only them. The
            // route's gate compares the decider with the same pin; a card that pinned
            // nobody has nobody to wake (and the route fails it closed).
            GatePlan::RequestingMember => Ok(self.target_member == Some(member_id)),
            // `expression.create`: the ONE predicate the decision route also asks
            // (`momo_expressions::adder_allows_in_tx`): a human, not a guest, within the add
            // policy as it is now and, for a face, that very person. No admin proxy.
            GatePlan::ExpressionAdder => momo_expressions::store::adder_allows_in_tx(
                conn,
                workspace_id,
                member_id,
                self.expression_subject,
            )
            .await
            .map_err(|error| match error {
                momo_expressions::Error::Db(error) => error,
                other => DbError::Sqlx(sqlx::Error::Protocol(format!(
                    "expression adder judgment failed: {other}"
                ))),
            }),
            // `require_profile_editor_in_tx`: an active workspace member who is an
            // admin or the target agent's owner. The target is the card's pin; a
            // card that pinned none has nobody to judge the owner arm against, so
            // only an admin passes (the route fails such a card closed).
            GatePlan::TargetAgent => {
                match momo_messaging::active_workspace_role(conn, workspace_id, member_id).await? {
                    None => Ok(false),
                    Some(role) if role.is_admin() => Ok(true),
                    Some(_) => match self.target_agent {
                        Some(agent) => Ok(agent_owner_in_tx(conn, workspace_id, agent).await?
                            == Some(Some(member_id))),
                        None => Ok(false),
                    },
                }
            }
        }
    }
}

/// May `member_id` approve this card? One-shot form of [`CardAudience`] for a caller
/// with a single person to ask; the judgment, which asks many, resolves the card once.
pub async fn may_approve_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    card: &ApprovalCard,
    member_id: Uuid,
) -> Result<bool, DbError> {
    CardAudience::resolve(conn, workspace_id, card)
        .await?
        .allows(conn, workspace_id, member_id)
        .await
}

/// `remote_host_owner_in_tx` can only fail with a database error; anything else
/// would be a new `T3Error` variant this read cannot produce, surfaced as one.
fn t3_to_db(error: T3Error) -> DbError {
    match error {
        T3Error::Db(error) => error,
        other => DbError::Sqlx(sqlx::Error::Protocol(format!(
            "remote_host_owner_in_tx failed: {other}"
        ))),
    }
}
