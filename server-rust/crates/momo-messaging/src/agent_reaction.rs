//! The agent's **own** reactions — the ones it chooses through the Agent Port tool `oort_reaction_set`
//! (ADR-0162 증보 8, #6068).
//!
//! Beside the status reactions the server derives from a run ([`crate::status_reaction`], ADR-0200 증보
//! 8) there is one narrow door through which an agent picks a reaction itself. It writes the **same**
//! `reaction` row and the **same** `reaction.added` / `reaction.removed` frame a person's tap writes,
//! through the REST path's own statement ([`crate::interaction::set_reaction_in_tx`]), so a shipped client
//! draws it unchanged and nothing notifies anyone (R11: no `seq`, push candidate, inbox row or unread —
//! the reaction path's own invariants). What this module adds is only the judgement in front of it:
//!
//! * **what** (R6) — [`judge_agent_reaction`]: one emoji of the picker's catalog, **normalised to the
//!   exact spelling a person's picker sends** (NFC, the variation selectors folded, then the catalog's
//!   spelling — [`picker_spelling`]), or `:name:` of an expression an agent may use
//!   ([`AGENT_USABLE_EXPRESSION`]). The eye, the check and every emoji of the closed set that reads as a
//!   work state ([`STATUS_LIKE_EMOJI`]) are refused on the folded form, so no other spelling of them
//!   gets through and the server's own 👀 / ✅ (L11) can never be confused with one the agent chose;
//! * **where** (R5) — [`set_agent_reaction_in_tx`]: a message of the run's own channel, written by a
//!   person, not deleted, that the agent can read (the read is under the request's agent, so the
//!   agent read boundary of migration 156 hides what `oort_conversation_read` would hide), with the agent
//!   still in the channel. Every miss is one answer, [`AgentReactionRefused::Target`];
//! * **how many** (R7) — one self-chosen reaction of the agent per message (its rows on the message that
//!   are not the server's 👀 / ✅), and three adds per run counted on the run row
//!   (`agent_run.agent_reaction_count`, migration 191), which a removal never gives back;
//! * **the record** (R11) — one audit row per add and per removal, with `via: "agent_port"`, the run
//!   and the token. A refusal writes nothing here: the caller's call trace keeps its closed code.
//!
//! The caller is the Agent Port handler: it has re-proved the connection, the sealed handle, the lease,
//! the run (live, not parked, started by a person's message — R4) and the agent's effective setting
//! (「자유롭게」, R3), and it **holds the run row lock** (`momo_agent::lock_gateway_run_in_tx`) for the
//! whole transaction, which is what makes the per-run count exact. Lock order: run → message, the same
//! as every terminal path that also touches the status reactions.

use std::collections::HashMap;
use std::sync::OnceLock;

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
use sqlx::PgConnection;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::agent_reaction_emoji::PICKER_GLYPHS;
use crate::identity::is_channel_member;
use crate::interaction::{
    lock_message_in_tx, set_reaction_in_tx, InteractionRefused, ReactionAction,
};
use crate::status_reaction::{STATUS_CHECK, STATUS_EYE};

/// R7 (owner 값 ①, 2026-11-23): the agent's self-chosen reactions on one message.
pub const AGENT_REACTIONS_PER_MESSAGE: i64 = 1;
/// R7: adds per run. Migration 191's CHECK holds the same number.
pub const AGENT_REACTIONS_PER_RUN: i16 = 3;
/// R10: the most names `oort_expression_names` hands over; more is said with `truncated`.
pub const AGENT_EXPRESSION_NAMES_LIMIT: i64 = 200;
/// `detail.via` of every audit row this module writes (R11).
pub const VIA_AGENT_PORT: &str = "agent_port";

/// ADR-0162 증보 8 R6 2 — the emoji that read as a work state, which only the server says (L11).
/// **A code constant: changing it is changing the addendum.** In the picker's spelling; judged on the
/// folded form ([`fold_emoji`]), so a spelling with or without a variation selector is the same entry.
pub const STATUS_LIKE_EMOJI: [&str; 14] = [
    // taken · seen
    "\u{1F440}",
    "\u{1F441}\u{FE0F}",
    "\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}",
    // done · approved
    "\u{2705}\u{FE0F}",
    "\u{2714}\u{FE0F}",
    "\u{2611}\u{FE0F}",
    "\u{1F197}",
    // failed · refused
    "\u{274C}\u{FE0F}",
    "\u{274E}\u{FE0F}",
    "\u{1F6AB}",
    "\u{26D4}\u{FE0F}",
    // in progress
    "\u{23F3}\u{FE0F}",
    "\u{231B}\u{FE0F}",
    "\u{1F504}",
];

/// The one definition of "an expression an agent may react with", over a row aliased `e` (R6 · R10).
/// Today: active (a hidden or deleted one is neither listed nor usable). ADR-0218 증보 13 §19 adds the
/// card-less registrations (an `expression.grant_id`, #6069): that clause goes **here** and both the
/// name list and the add path follow it.
pub const AGENT_USABLE_EXPRESSION: &str = "e.status = 'active'";

/// NFC, then without U+FE0F / U+FE0E: two spellings of one emoji fold to one string.
pub fn fold_emoji(raw: &str) -> String {
    raw.nfc()
        .filter(|c| *c != '\u{FE0F}' && *c != '\u{FE0E}')
        .collect()
}

fn picker_index() -> &'static HashMap<String, &'static str> {
    static INDEX: OnceLock<HashMap<String, &'static str>> = OnceLock::new();
    INDEX.get_or_init(|| {
        PICKER_GLYPHS
            .iter()
            .map(|glyph| (fold_emoji(glyph), *glyph))
            .collect()
    })
}

/// The spelling a person's picker sends for the emoji `raw` is, or `None` when `raw` is not exactly
/// one emoji of the picker's catalog (text, two emoji, a space around one, an unknown sequence).
pub fn picker_spelling(raw: &str) -> Option<&'static str> {
    picker_index().get(&fold_emoji(raw)).copied()
}

/// What the agent asked to react with, once judged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentReactionChoice {
    /// One emoji, in the picker's spelling.
    Emoji(&'static str),
    /// A team expression's name (without the colons), still to be looked up in the transaction.
    Expression(String),
}

impl AgentReactionChoice {
    /// The `reaction.emoji` value — what a person's tap stores for the same choice.
    pub fn stored(&self) -> String {
        match self {
            AgentReactionChoice::Emoji(glyph) => (*glyph).to_string(),
            AgentReactionChoice::Expression(name) => format!(":{name}:"),
        }
    }
}

/// Why an `emoji` argument was refused before any row was read (R6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChoiceRefused {
    NotEmoji,
    StatusEmoji,
}

/// ADR-0218's fixed name rule (`[a-z0-9_-]{2,30}`, migration 158's CHECK).
fn expression_name_shape(name: &str) -> bool {
    (2..=30).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Judge the `emoji` argument (R6): `:name:` of the expression name shape, or exactly one emoji of the
/// picker's catalog that is not in [`STATUS_LIKE_EMOJI`].
pub fn judge_agent_reaction(raw: &str) -> Result<AgentReactionChoice, ChoiceRefused> {
    if let Some(name) = raw
        .strip_prefix(':')
        .and_then(|rest| rest.strip_suffix(':'))
    {
        return if expression_name_shape(name) {
            Ok(AgentReactionChoice::Expression(name.to_string()))
        } else {
            Err(ChoiceRefused::NotEmoji)
        };
    }
    let glyph = picker_spelling(raw).ok_or(ChoiceRefused::NotEmoji)?;
    let folded = fold_emoji(glyph);
    if STATUS_LIKE_EMOJI
        .iter()
        .any(|status| fold_emoji(status) == folded)
    {
        return Err(ChoiceRefused::StatusEmoji);
    }
    Ok(AgentReactionChoice::Emoji(glyph))
}

/// R10: the names of the expressions an agent may react with, by name, at most
/// [`AGENT_EXPRESSION_NAMES_LIMIT`]; the flag says whether there were more. Names only — no picture,
/// address, tag, description, author or count is read.
pub async fn agent_expression_names_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<(Vec<String>, bool), DbError> {
    let mut names: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT e.name FROM expression e \
          WHERE e.workspace_id = $1 AND {AGENT_USABLE_EXPRESSION} \
          ORDER BY e.name \
          LIMIT $2"
    ))
    .bind(workspace_id)
    .bind(AGENT_EXPRESSION_NAMES_LIMIT + 1)
    .fetch_all(&mut *conn)
    .await?;
    let truncated = names.len() as i64 > AGENT_EXPRESSION_NAMES_LIMIT;
    names.truncate(AGENT_EXPRESSION_NAMES_LIMIT as usize);
    Ok((names, truncated))
}

async fn agent_expression_usable_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    name: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM expression e \
          WHERE e.workspace_id = $1 AND e.name = $2 AND {AGENT_USABLE_EXPRESSION})"
    ))
    .bind(workspace_id)
    .bind(name)
    .fetch_one(&mut *conn)
    .await?)
}

/// One call of the tool, as the handler proved it.
#[derive(Debug, Clone)]
pub struct AgentReactionWrite {
    pub workspace_id: Uuid,
    /// The run of the caller's handle; its row is locked by the caller.
    pub run_id: Uuid,
    /// The run's channel (the handle's): the only channel whose messages this call may touch.
    pub run_channel_id: Uuid,
    pub agent_member_id: Uuid,
    /// The Agent Port credential, for the audit row (R11).
    pub token_id: Uuid,
    pub message_id: Uuid,
    pub choice: AgentReactionChoice,
    pub action: ReactionAction,
}

/// Why the write was refused. Nothing was written for any of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentReactionRefused {
    /// R5: not a message this call may touch — absent, another workspace's or channel's, below the
    /// agent's read floor, deleted, written by an agent, or the agent is no longer in the channel. One
    /// answer for all of them, so a reaction cannot tell which messages exist.
    Target,
    /// `:name:` is not an expression an agent may use ([`AGENT_USABLE_EXPRESSION`]).
    ExpressionUnavailable,
    /// R7: the agent already has its self-chosen reaction on this message.
    MessageLimit,
    /// R7: this run already added [`AGENT_REACTIONS_PER_RUN`].
    RunLimit,
    /// The message's 200-reaction cap (the REST path's own limit).
    MessageFull,
}

/// What a write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentReactionOutcome {
    /// The stored emoji (the picker's spelling, or `:name:`).
    pub emoji: String,
    /// `false` for a removal of a reaction that was not there (nothing written, nothing recorded).
    pub changed: bool,
}

/// Add or remove the agent's own reaction (module docs). The caller holds the run row lock.
pub async fn set_agent_reaction_in_tx(
    conn: &mut PgConnection,
    write: &AgentReactionWrite,
) -> Result<Result<AgentReactionOutcome, AgentReactionRefused>, DbError> {
    // R5 — read under the request's agent, so the agent read boundary applies; the lock serialises a
    // second call on the same message (another run of the same agent) behind this one.
    let Some(locked) = lock_message_in_tx(&mut *conn, write.message_id).await? else {
        return Ok(Err(AgentReactionRefused::Target));
    };
    if locked.channel_id != write.run_channel_id || locked.is_deleted() {
        return Ok(Err(AgentReactionRefused::Target));
    }
    let author_is_person: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member \
          WHERE workspace_id = $1 AND id = $2 AND kind = 'human')",
    )
    .bind(write.workspace_id)
    .bind(locked.author_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if !author_is_person
        || !is_channel_member(&mut *conn, locked.channel_id, write.agent_member_id).await?
    {
        return Ok(Err(AgentReactionRefused::Target));
    }
    // Only a new reaction needs a usable expression: taking one off never does (R8, and the REST
    // path's own rule — a hidden expression can still be withdrawn).
    if let (AgentReactionChoice::Expression(name), ReactionAction::Added) =
        (&write.choice, write.action)
    {
        if !agent_expression_usable_in_tx(&mut *conn, write.workspace_id, name).await? {
            return Ok(Err(AgentReactionRefused::ExpressionUnavailable));
        }
    }
    let emoji = write.choice.stored();

    if write.action == ReactionAction::Added {
        // R7 — the agent's rows on this message that are not the server's status reactions are the
        // ones it chose (the tool refuses 👀 / ✅, and no other door writes an agent's reaction).
        let chosen: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM reaction \
              WHERE message_id = $1 AND member_id = $2 AND emoji <> ALL($3)",
        )
        .bind(write.message_id)
        .bind(write.agent_member_id)
        .bind([STATUS_EYE, STATUS_CHECK])
        .fetch_one(&mut *conn)
        .await?;
        if chosen >= AGENT_REACTIONS_PER_MESSAGE {
            return Ok(Err(AgentReactionRefused::MessageLimit));
        }
        let added: i16 = sqlx::query_scalar(
            "SELECT agent_reaction_count FROM agent_run WHERE workspace_id = $1 AND id = $2",
        )
        .bind(write.workspace_id)
        .bind(write.run_id)
        .fetch_one(&mut *conn)
        .await?;
        if added >= AGENT_REACTIONS_PER_RUN {
            return Ok(Err(AgentReactionRefused::RunLimit));
        }
    }

    // The REST path's own statement: the same row, the same frame, the same 200 cap.
    let delta = match set_reaction_in_tx(
        &mut *conn,
        write.workspace_id,
        write.message_id,
        write.agent_member_id,
        &emoji,
        write.action,
    )
    .await?
    {
        Ok(delta) => delta,
        Err(InteractionRefused::ReactionLimit) => {
            return Ok(Err(AgentReactionRefused::MessageFull))
        }
        // Between the lookup above and this statement's `FOR SHARE` (same transaction): the
        // expression was hidden. Nothing was written.
        Err(InteractionRefused::NotFound) if write.choice.is_expression() => {
            return Ok(Err(AgentReactionRefused::ExpressionUnavailable))
        }
        Err(_) => return Ok(Err(AgentReactionRefused::Target)),
    };
    if !delta.changed {
        // An add cannot meet its own row (the per-message count above saw none); a removal of a
        // reaction that is not there changes nothing and records nothing.
        return Ok(Ok(AgentReactionOutcome {
            emoji,
            changed: false,
        }));
    }
    if write.action == ReactionAction::Added {
        // Under the caller's run lock, so the check above still holds; a miss means it did not, and
        // the error rolls the whole transaction back (the row and the frame with it).
        let counted: Option<i16> = sqlx::query_scalar(
            "UPDATE agent_run SET agent_reaction_count = agent_reaction_count + 1 \
              WHERE workspace_id = $1 AND id = $2 AND agent_reaction_count < $3 \
            RETURNING agent_reaction_count",
        )
        .bind(write.workspace_id)
        .bind(write.run_id)
        .bind(AGENT_REACTIONS_PER_RUN)
        .fetch_optional(&mut *conn)
        .await?;
        if counted.is_none() {
            return Err(DbError::from(sqlx::Error::RowNotFound));
        }
    }
    let event = format!("reaction.{}", delta.action.as_wire_label());
    write_audit(
        &mut *conn,
        &AuditEntry::new(write.workspace_id, event.clone())
            .by(write.agent_member_id)
            .about_optional(None)
            .target("message", write.message_id)
            .via_token(Some(write.token_id))
            .run(write.run_id)
            .with_schema(
                "momo.message_interaction.v1",
                json!({
                    "channel_id": delta.channel_id,
                    "event_type": event,
                    "via": VIA_AGENT_PORT,
                    "run_id": write.run_id,
                }),
            ),
    )
    .await?;
    Ok(Ok(AgentReactionOutcome {
        emoji,
        changed: true,
    }))
}

impl AgentReactionChoice {
    fn is_expression(&self) -> bool {
        matches!(self, AgentReactionChoice::Expression(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn core_file(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/momo-core/src/features/emoji")
            .join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&text).expect("the core file is JSON")
    }

    /// R6 1 — the table is the person's picker, glyph for glyph and in its spelling: a catalog update
    /// that this table does not follow, or a hand edit that drops or respells a line, is red here.
    #[test]
    fn the_table_is_the_pickers_catalog() {
        let catalog = core_file("emojiCatalog.json");
        let mut glyphs: Vec<String> = Vec::new();
        for row in catalog["items"].as_array().expect("items") {
            glyphs.push(row[0].as_str().expect("glyph").to_string());
            if let Some(skins) = row.get(5).and_then(Value::as_array) {
                glyphs.extend(
                    skins
                        .iter()
                        .map(|skin| skin.as_str().expect("skin").to_string()),
                );
            }
        }
        assert_eq!(
            glyphs,
            PICKER_GLYPHS
                .iter()
                .map(|g| g.to_string())
                .collect::<Vec<_>>()
        );
        // Folding is one-to-one over the catalog, and every spelling a picker could send comes back
        // as itself — with or without its variation selectors.
        assert_eq!(picker_index().len(), PICKER_GLYPHS.len());
        for glyph in PICKER_GLYPHS {
            assert_eq!(picker_spelling(glyph), Some(glyph), "{glyph:?}");
            assert_eq!(
                picker_spelling(&fold_emoji(glyph)),
                Some(glyph),
                "{glyph:?}"
            );
        }
        // The catalog's other spellings (an emoji-presentation emoji with a selector) are one emoji.
        for alias in core_file("presentationAliases.json")
            .as_array()
            .expect("aliases")
        {
            let alias = alias.as_str().expect("alias");
            let spelled = picker_spelling(alias).unwrap_or_else(|| panic!("{alias:?}"));
            assert_eq!(fold_emoji(spelled), fold_emoji(alias));
        }
    }

    /// R6 1 · RA4 — two spellings of one emoji are one stored value, the picker's.
    #[test]
    fn a_second_spelling_is_stored_as_the_pickers() {
        for (sent, stored) in [
            ("\u{2764}", "\u{2764}\u{FE0F}"),         // ❤ without the selector
            ("\u{2764}\u{FE0F}", "\u{2764}\u{FE0F}"), // ❤️ as the picker sends it
            // 👍: the catalog keeps the selector the picker always stored (#4322's identities), so the
            // bare spelling is respelled to it.
            ("\u{1F44D}", "\u{1F44D}\u{FE0F}"),
            ("\u{1F44D}\u{FE0F}", "\u{1F44D}\u{FE0F}"),
            ("\u{1F600}\u{FE0F}", "\u{1F600}"), // 😀 takes none
            ("\u{1F6E0}", "\u{1F6E0}\u{FE0F}"), // 🛠
            ("\u{1F44D}\u{1F3FD}", "\u{1F44D}\u{1F3FD}"), // a skin tone
        ] {
            assert_eq!(
                judge_agent_reaction(sent),
                Ok(AgentReactionChoice::Emoji(stored)),
                "{sent:?}"
            );
        }
    }

    /// R6 2 · RA4 — each of the fourteen, written out here rather than read from the constant, is
    /// refused in the picker's spelling, without its selectors and with an extra one; the constant holds
    /// exactly these (dropping one from it is red), and every one is a picker emoji (so it is the
    /// status rule, not "not an emoji", that refuses it).
    #[test]
    fn the_work_state_emoji_are_refused_in_every_spelling() {
        let written = [
            "👀",
            "👁️",
            "👁️‍🗨️",
            "✅",
            "✔️",
            "☑️",
            "🆗",
            "❌",
            "❎",
            "🚫",
            "⛔",
            "⏳",
            "⌛",
            "🔄",
        ];
        assert_eq!(
            written
                .iter()
                .map(|e| fold_emoji(e))
                .collect::<std::collections::BTreeSet<_>>(),
            STATUS_LIKE_EMOJI
                .iter()
                .map(|e| fold_emoji(e))
                .collect::<std::collections::BTreeSet<_>>(),
        );
        for status in STATUS_LIKE_EMOJI {
            assert_eq!(
                picker_spelling(status),
                Some(status),
                "the picker's spelling"
            );
        }
        for emoji in written {
            assert!(
                picker_spelling(emoji).is_some(),
                "{emoji} is a picker emoji"
            );
            for spelling in [
                emoji.to_string(),
                fold_emoji(emoji),
                format!("{}\u{FE0F}", fold_emoji(emoji)),
            ] {
                assert_eq!(
                    judge_agent_reaction(&spelling),
                    Err(ChoiceRefused::StatusEmoji),
                    "{spelling:?}"
                );
            }
        }
        // Ordinary acknowledgement and feeling stay open (R12's use).
        for open in ["👍", "🙏", "🎉", "😄", "❤️", "💯"] {
            assert!(judge_agent_reaction(open).is_ok(), "{open}");
        }
    }

    /// R6 · RA4 — words, two emoji, a padded emoji and a name of the wrong shape are not one emoji.
    #[test]
    fn what_is_not_one_emoji_is_refused() {
        for text in [
            "승인됨",
            "ok",
            "a",
            "",
            " ",
            "👍👍",
            " 👍",
            "👍 ",
            "\u{FE0F}",
            "::",
            ":A:",
            ":승인:",
            ":a:",
            ":party",
            "party:",
            ":party-time-is-much-longer-than-30:",
        ] {
            assert_eq!(
                judge_agent_reaction(text),
                Err(ChoiceRefused::NotEmoji),
                "{text:?}"
            );
        }
        assert_eq!(
            judge_agent_reaction(":party_1-x:"),
            Ok(AgentReactionChoice::Expression("party_1-x".into()))
        );
        assert_eq!(
            AgentReactionChoice::Expression("party".into()).stored(),
            ":party:"
        );
    }
}
