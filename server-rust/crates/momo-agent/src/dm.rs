//! Implicit addressing in a 1:1 DM — "the person you are alone with is the
//! person you are talking to" (QA H7, batch B13).
//!
//! ## What this module is
//!
//! [`crate::mention`] answers *who was named*. This module answers *who was
//! addressed without being named*, and it answers it for exactly one shape: a
//! `channel.kind = 'dm'` whose only counterpart is a single agent. In that room
//! there is nobody else an utterance could be for, so requiring `@handle` is
//! ceremony — the QA note that opened this batch.
//!
//! ## Why it is a routing rule and not a trigger
//!
//! `agent_profile.triggers` is validated as `{"mention": true}` plus an optional
//! `schedule` and **rejects every other key**
//! (`provisioning::validate_agent_profile`, pinned by
//! `triggers_must_keep_mention_on_and_invent_nothing`). Widening that schema
//! would make "does this agent answer in a DM" a per-agent configuration
//! surface — one more thing an operator can leave in a state nobody predicted,
//! and one more thing a prompt-injected profile write could try to flip. The
//! rule below is a property of *the room*, so it lives with the routing.
//!
//! ## The gate is fail-closed, and one clause is not negotiable
//!
//! [`resolve_dm_addressing`] returns [`DmAddressing::Addressed`] only when every
//! condition holds, and returns the **reason** otherwise so the caller can audit
//! a refusal instead of guessing at a silence. The clause that must never be
//! relaxed is [`DmAddressing::AuthorIsNotHuman`]:
//!
//! > Two agents alone in a DM, each auto-answering the other, is a loop with no
//! > human in it and no natural end. Every A2A gate that would normally stop one
//! > (G1/G2/G3, `a2a_depth`, the chain budget) lives on the *agent-authored*
//! > path in `momo-agent-worker`; an HTTP send by an agent bearer does not pass
//! > through them, which is exactly why `routes::agent_mentions` already refuses
//! > agent-authored mentions with `a2a_source_run_unavailable`. Auto-replying
//! > there would open the door that refusal closes.
//!
//! So the author is checked **twice**: once as a credential (the caller passes
//! `author_credential_is_agent` from `PrincipalKind`) and once as data (the
//! author must appear in the channel's roster as `member.kind = 'human'`). One
//! is about who asked; the other is about who they are. Neither implies the
//! other, and a mis-issued token must not be enough.
//!
//! ## What it deliberately does not own
//!
//! No `INSERT`, like [`crate::mention`] and [`crate::a2a`]: it reads the room,
//! returns a verdict, and the route layer composes the run, the job and the
//! audit row inside the send's own transaction.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// How an agent came to be addressed by one message. Recorded on the run input
/// and on the audit row so "why did this agent run" is answerable from SQL
/// without re-deriving the rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Addressing {
    /// The body named the agent (`@handle` / display name / id).
    Mention,
    /// A 1:1 DM with exactly one agent counterpart — this module's rule.
    DirectMessage,
}

impl Addressing {
    /// The durable label. `dm_implicit` rather than `dm`, because the fact worth
    /// recording is that nobody typed a mention.
    pub fn as_label(self) -> &'static str {
        match self {
            Addressing::Mention => "mention",
            Addressing::DirectMessage => "dm_implicit",
        }
    }
}

/// One active member of the channel a message landed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelParticipant {
    pub member_id: Uuid,
    /// `member.kind = 'agent'`. Read from the roster, never inferred from the
    /// credential that sent the message.
    pub is_agent: bool,
}

/// The room, as the DM rule needs to see it.
///
/// `is_dm` is a fact about the channel and `participants` is the *active* roster
/// (`membership.left_at IS NULL`, `member.status = 'active'`,
/// `member.deleted_at IS NULL`) — the same three predicates
/// `run::is_active_human_channel_member_in_tx` uses, so the two cannot disagree
/// about who is in a channel.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DmAudience {
    pub is_dm: bool,
    pub participants: Vec<ChannelParticipant>,
}

/// The verdict, with its reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmAddressing {
    /// A 1:1 DM, a human author, exactly one agent counterpart: that agent was
    /// addressed even though nobody typed its handle.
    Addressed(Uuid),
    /// Not a DM — a group channel still requires an explicit mention, or every
    /// message in a channel an agent happens to be in would start a run.
    NotDirectMessage,
    /// The author is an agent (by credential or by roster). **The loop gate.**
    AuthorIsNotHuman,
    /// Zero agents, more than one agent, or more than one counterpart of any
    /// kind. A human↔human DM lands here too.
    NoSingleAgentCounterpart,
}

/// Does this message implicitly address an agent? — the whole rule, as a pure
/// function of the room and the author.
///
/// Pure on purpose: every clause below is a property somebody could relax by
/// accident, and a pure function is the only kind this repo can pin without a
/// database (the docker gate is not part of `cargo test`).
///
/// | clause | why it is there |
/// |---|---|
/// | `is_dm` | in a group channel there are other people the utterance could be for |
/// | `!author_credential_is_agent` | an agent bearer's send never auto-triggers anything |
/// | author is a **human** participant | the roster is the authority on who someone is; a mis-issued credential must not be enough |
/// | exactly one counterpart, and it is an agent | 0 → nobody to answer; 2+ → back to "who did you mean"; a human counterpart is not a thing that runs |
pub fn resolve_dm_addressing(
    audience: &DmAudience,
    author_member_id: Uuid,
    author_credential_is_agent: bool,
) -> DmAddressing {
    if !audience.is_dm {
        return DmAddressing::NotDirectMessage;
    }
    // Credential first: it is the cheaper half of the two-sided author check and
    // it is the one an agent gateway would be holding.
    if author_credential_is_agent {
        return DmAddressing::AuthorIsNotHuman;
    }
    let author_is_human_participant = audience
        .participants
        .iter()
        .any(|participant| participant.member_id == author_member_id && !participant.is_agent);
    if !author_is_human_participant {
        return DmAddressing::AuthorIsNotHuman;
    }

    let counterparts: Vec<&ChannelParticipant> = audience
        .participants
        .iter()
        .filter(|participant| participant.member_id != author_member_id)
        .collect();
    match counterparts.as_slice() {
        [only] if only.is_agent => DmAddressing::Addressed(only.member_id),
        _ => DmAddressing::NoSingleAgentCounterpart,
    }
}

/// Read the room — the channel's kind and, **only if it is a DM**, its active
/// roster.
///
/// Two statements rather than one join, and the order is the point: the first is
/// a primary-key lookup, so a message sent into a 500-member public channel pays
/// for one indexed row instead of a 500-row participant scan it would then throw
/// away. A DM has two participants, so the second statement is bounded by the
/// same fact that makes the rule safe.
///
/// An unknown channel reads as "not a DM" — fail closed, like every other
/// missing input on this path.
pub async fn load_dm_audience_in_tx(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<DmAudience, DbError> {
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind::text FROM channel WHERE id = $1 LIMIT 1")
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?;
    if kind.as_deref() != Some("dm") {
        return Ok(DmAudience::default());
    }

    let rows = sqlx::query(
        "SELECT m.id AS member_id, (m.kind = 'agent') AS is_agent \
           FROM membership ms \
           JOIN member m \
             ON m.id = ms.member_id \
            AND m.workspace_id = ms.workspace_id \
          WHERE ms.channel_id = $1 \
            AND ms.left_at IS NULL \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          ORDER BY m.id",
    )
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut participants = Vec::with_capacity(rows.len());
    for row in &rows {
        participants.push(ChannelParticipant {
            member_id: row.try_get("member_id").map_err(DbError::from)?,
            is_agent: row.try_get("is_agent").map_err(DbError::from)?,
        });
    }
    Ok(DmAudience {
        is_dm: true,
        participants,
    })
}

/// Stamp `addressing` onto a run input or an audit detail object.
///
/// The same shape `momo-agent-worker`'s A2A path uses for `detail.a2a`: the
/// builders in [`crate::mention`] stay a pure function of the trigger, and the
/// composing layer adds the one fact only it knows.
pub fn stamp_addressing(value: &mut serde_json::Value, addressing: Addressing) {
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "addressing".into(),
            serde_json::Value::String(addressing.as_label().to_string()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUMAN: Uuid = Uuid::from_u128(1);
    const AGENT: Uuid = Uuid::from_u128(2);
    const OTHER_AGENT: Uuid = Uuid::from_u128(3);
    const OTHER_HUMAN: Uuid = Uuid::from_u128(4);

    fn human(member_id: Uuid) -> ChannelParticipant {
        ChannelParticipant {
            member_id,
            is_agent: false,
        }
    }

    fn agent(member_id: Uuid) -> ChannelParticipant {
        ChannelParticipant {
            member_id,
            is_agent: true,
        }
    }

    fn dm(participants: Vec<ChannelParticipant>) -> DmAudience {
        DmAudience {
            is_dm: true,
            participants,
        }
    }

    /// (a) The whole point of the batch: a human alone with one agent does not
    /// have to type a handle.
    #[test]
    fn a_human_alone_with_one_agent_addresses_it_without_a_mention() {
        assert_eq!(
            resolve_dm_addressing(&dm(vec![human(HUMAN), agent(AGENT)]), HUMAN, false),
            DmAddressing::Addressed(AGENT)
        );
    }

    /// **(b) The clause that must never be relaxed.**
    ///
    /// Two agents alone in a DM, each auto-answering the other, is an unbounded
    /// loop: the A2A gates (G1/G2/G3, `a2a_depth`, the chain budget) only guard
    /// the agent-authored path inside the worker, and an HTTP send by an agent
    /// bearer never reaches them. Both halves of the author check are asserted
    /// here — the credential and the roster — because either one alone would let
    /// the loop open under a mis-issued token or a mislabelled member row.
    #[test]
    fn an_agent_never_auto_triggers_another_agent_in_a_dm() {
        let agent_to_agent = dm(vec![agent(AGENT), agent(OTHER_AGENT)]);

        // The credential says agent → refused before anything else is consulted.
        assert_eq!(
            resolve_dm_addressing(&agent_to_agent, AGENT, true),
            DmAddressing::AuthorIsNotHuman
        );
        // …and even if a credential claimed to be human, the roster refuses:
        // the author is not a human participant of this channel.
        assert_eq!(
            resolve_dm_addressing(&agent_to_agent, AGENT, false),
            DmAddressing::AuthorIsNotHuman,
            "the roster is the authority on who the author is, not the token"
        );
        // The same refusal protects the human↔agent DM from an agent bearer.
        assert_eq!(
            resolve_dm_addressing(&dm(vec![human(HUMAN), agent(AGENT)]), AGENT, true),
            DmAddressing::AuthorIsNotHuman
        );
    }

    /// (e) A group channel is untouched: without a mention, nothing runs. Every
    /// message in every channel an agent sits in would otherwise start a turn.
    #[test]
    fn a_group_channel_still_needs_an_explicit_mention() {
        let group = DmAudience {
            is_dm: false,
            participants: vec![human(HUMAN), agent(AGENT)],
        };
        assert_eq!(
            resolve_dm_addressing(&group, HUMAN, false),
            DmAddressing::NotDirectMessage
        );
        // An unknown/unreadable channel is not a DM either — fail closed.
        assert_eq!(
            resolve_dm_addressing(&DmAudience::default(), HUMAN, false),
            DmAddressing::NotDirectMessage
        );
    }

    /// "Exactly one agent counterpart" is the literal rule. A group DM, a
    /// human↔human DM and a DM whose counterpart already left all fall back to
    /// requiring a mention rather than guessing.
    #[test]
    fn anything_other_than_one_agent_counterpart_falls_back_to_mentions() {
        for participants in [
            vec![human(HUMAN), agent(AGENT), agent(OTHER_AGENT)],
            vec![human(HUMAN), agent(AGENT), human(OTHER_HUMAN)],
            vec![human(HUMAN), human(OTHER_HUMAN)],
            vec![human(HUMAN)],
        ] {
            assert_eq!(
                resolve_dm_addressing(&dm(participants.clone()), HUMAN, false),
                DmAddressing::NoSingleAgentCounterpart,
                "{participants:?} is not a 1:1 DM with a single agent"
            );
        }
    }

    /// A member who is not in the room cannot address anyone in it. This is the
    /// roster half of the author check standing alone: the send route's own
    /// membership gate is upstream, and this must not depend on it.
    #[test]
    fn a_non_participant_addresses_nobody() {
        assert_eq!(
            resolve_dm_addressing(&dm(vec![human(HUMAN), agent(AGENT)]), OTHER_HUMAN, false),
            DmAddressing::AuthorIsNotHuman
        );
    }

    /// The durable labels are a contract with `audit_log` and `agent_run.input`.
    /// A rename would silently orphan every row written before it.
    #[test]
    fn the_addressing_labels_are_stable() {
        assert_eq!(Addressing::Mention.as_label(), "mention");
        assert_eq!(Addressing::DirectMessage.as_label(), "dm_implicit");

        let mut detail = serde_json::json!({"reason": "queued"});
        stamp_addressing(&mut detail, Addressing::DirectMessage);
        assert_eq!(detail["addressing"], serde_json::json!("dm_implicit"));
        assert_eq!(
            detail["reason"],
            serde_json::json!("queued"),
            "stamping adds a fact, it does not rewrite one"
        );
    }
}
