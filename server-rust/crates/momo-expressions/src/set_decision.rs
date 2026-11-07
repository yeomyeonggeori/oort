//! ADR-0218 증보 6 §12 L5.4 · L6 (#5461 S2): the decision on a set card — one approval registers
//! the pictures a person kept, item by item.
//!
//! Three things live here, in the order a request meets them:
//!
//! 1. [`parse_choices`] — the request's `expressionChoices` as the contract's shape, before any row
//!    is read (a malformed list is a 400 of the request, not a verdict on the card).
//! 2. [`decide_set`] — the **pure rule** of L6.1 steps 3-5: which kept pictures register and which are
//!    skipped, in slot order whatever the request order, and when the whole decision refuses. It is
//!    the Rust form of the core's `decideExpressionSet`, and `docs/api/expression-set.vectors.json`
//!    (a byte-equal copy of the core's `set.vectors.json`) is what both are tested against.
//! 3. [`decide_in_tx`] — the transaction around it: every proof is a read and happens before the
//!    first write (the role under the catalog lock, the card's drafts, each kept draft's revision and
//!    TTL, the **stored bytes hashed again** against the row and against what the person was shown),
//!    then one catalogue version for the whole decision, one registration per kept picture, the
//!    per-picture receipt, the reclaim of every picture nobody registered, and the head's move
//!    `proposed → decided`.
//!
//! # Two kinds of "no"
//!
//! A *refusal* ([`Error::Stale`], [`Error::NameReserved`], [`Error::Quota`], [`Error::Role`]) is
//! returned **before the first write**: the caller answers a 409/403 receipt that commits and spends
//! nothing. A *fault* after the first write is an [`Error::Db`] — the caller's transaction rolls back
//! with it — and is never one of those, because a refusal the caller commits would commit a
//! half-done registration. Every `?` after the first write below is one of the second kind.
//!
//! Lock order is the ADR's (L6.1): the approval (the caller's), the catalogue, the card's drafts in
//! slot order, the head, then the names — which are read under the catalogue lock every registration
//! in the workspace takes, so no one else can take a name between the read and the write.

use std::collections::{BTreeMap, BTreeSet};

use momo_db::{DbError, PgConnection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::set::{audit_decided_in_tx, DecidedCounts};
use crate::store::{
    adder_allows, authorize, catalog, changed_each, expression_json, metadata, unexpired, Effect,
};
use crate::{hash, version, Actor, Choice, Error, Kind, Metadata, QUOTA};

/// Most pictures one decision may keep (L4: one set has at most 40 slots).
pub const CHOICES_MAX: usize = 40;

/// `^(0|[1-9][0-9]*)$`, at most 19 characters: the contract's shape of a revision. (Whether it names
/// a revision a draft really has is the transaction's question, and a number past `i64` simply names
/// none.)
fn revision_shape(revision: &str) -> bool {
    (1..=19).contains(&revision.len())
        && revision.bytes().all(|byte| byte.is_ascii_digit())
        && (revision == "0" || !revision.starts_with('0'))
}

/// The `expressionChoices` of a decision request (`SetDecision`, L5.4): an array of 1 to
/// [`CHOICES_MAX`] `Choice` objects — closed keys, a revision and a hash of the contract's shape, a
/// `kind` from the closed two — whose `draftId`s are all different. `None` is every way of not being
/// that, and the caller answers the one 400 `expression_choice_invalid`. Nothing is read from the
/// database here, so a malformed request spends no lock and says nothing about any card.
pub fn parse_choices(value: &Value) -> Option<Vec<Choice>> {
    let items = value.as_array()?;
    if items.is_empty() || items.len() > CHOICES_MAX {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut choices = Vec::with_capacity(items.len());
    for item in items {
        let choice: Choice = serde_json::from_value(item.clone()).ok()?;
        if !revision_shape(&choice.revision)
            || !hash(&choice.sha256)
            || !seen.insert(choice.draft_id)
        {
            return None;
        }
        choices.push(choice);
    }
    Some(choices)
}

/// A ready slot of the card: a picture with a draft behind it. A gray slot has no draft and no
/// entry here, so no choice can name it (L7.3-2: a made-up id is "not a ready draft of this card").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadySlot {
    /// The slot order: the order registrations are visited in.
    pub index: u8,
    pub draft_id: Uuid,
    pub name: String,
}

/// One kept picture as the proofs found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub draft_id: Uuid,
    /// The kind the person picked, if they did; else the recommendation (J3) for [`Self::large`].
    pub kind: Option<Kind>,
    /// Every proof of this picture held: a ready draft of this card, made by this proposer, for this
    /// face, at the revision the person saw, unexpired, its stored bytes hashed again equal to the
    /// row and to the large hash the person saw. One `false` refuses the **whole** decision.
    pub holds: bool,
    /// The stored large picture's `(width, height, frames)`, for the recommendation (J4).
    pub large: (u32, u32, u32),
}

/// Why a kept picture was left out of an otherwise good decision (L6.1-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The workspace already has this name — or had it: a deleted name stays taken (D1).
    NameTaken,
    /// The library already holds its 1,000 live registrations (D2).
    Quota,
}

impl SkipReason {
    /// The word of the wire (`SetSkip.reason`).
    pub const fn as_str(self) -> &'static str {
        match self {
            SkipReason::NameTaken => "name_taken",
            SkipReason::Quota => "quota",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub index: u8,
    pub draft_id: Uuid,
    pub name: String,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skip {
    pub index: u8,
    pub draft_id: Uuid,
    pub name: String,
    pub reason: SkipReason,
}

/// Why the whole decision refuses (nothing registered, the approval not spent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 409 `expression_preview_stale`: a kept picture is not what the person saw (or is no picture
    /// of this card at all, a gray slot's made-up id included).
    Stale,
    /// 409 `expression_name_reserved`: nothing registers and some kept name was taken.
    NameReserved,
    /// 409 `expression_quota`: nothing registers and no kept name was taken.
    Quota,
}

impl Refusal {
    /// The refusal as the error the decision route already maps to its 409 receipts.
    pub fn into_error(self) -> Error {
        match self {
            Refusal::Stale => Error::Stale,
            Refusal::NameReserved => Error::NameReserved,
            Refusal::Quota => Error::Quota,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// `registered` and `skipped` are both in slot order.
    Registered {
        registered: Vec<Registration>,
        skipped: Vec<Skip>,
    },
    Refused(Refusal),
}

/// L6.1 steps 3-5 as a pure rule, the Rust form of the core's `decideExpressionSet`.
///
/// - A kept picture that is not a ready slot of this card, or whose proofs do not hold, refuses the
///   **whole** decision as [`Refusal::Stale`]. Nothing registers.
/// - The kept pictures are visited in **slot order**, whatever order the request named them in, so
///   the same card and the same workspace always give the same answer.
/// - A name in `taken` is skipped ([`SkipReason::NameTaken`]); past `quota` live registrations (the
///   ones already live plus the ones this decision has registered so far) every later picture is
///   skipped ([`SkipReason::Quota`]). A taken name does not use a place under the ceiling, and a
///   skip never stops the others.
/// - Nothing registered at all is a refusal: [`Refusal::NameReserved`] if any skip was a name, else
///   [`Refusal::Quota`]. An empty `picks` (the caller proved the list is not) is [`Refusal::Stale`],
///   never a decision that registers nothing and spends the approval.
pub fn decide_set(
    slots: &[ReadySlot],
    picks: &[Pick],
    taken: &BTreeSet<String>,
    live: i64,
    quota: i64,
) -> Verdict {
    if picks.is_empty() {
        return Verdict::Refused(Refusal::Stale);
    }
    let by_draft: BTreeMap<Uuid, &ReadySlot> =
        slots.iter().map(|slot| (slot.draft_id, slot)).collect();
    let mut kept = Vec::with_capacity(picks.len());
    for pick in picks {
        match by_draft.get(&pick.draft_id) {
            Some(slot) if pick.holds => kept.push((*slot, pick)),
            _ => return Verdict::Refused(Refusal::Stale),
        }
    }
    kept.sort_by_key(|(slot, _)| slot.index);
    let mut live = live;
    let mut registered = Vec::new();
    let mut skipped = Vec::new();
    for (slot, pick) in kept {
        if taken.contains(&slot.name) {
            skipped.push(Skip {
                index: slot.index,
                draft_id: slot.draft_id,
                name: slot.name.clone(),
                reason: SkipReason::NameTaken,
            });
        } else if live >= quota {
            skipped.push(Skip {
                index: slot.index,
                draft_id: slot.draft_id,
                name: slot.name.clone(),
                reason: SkipReason::Quota,
            });
        } else {
            live += 1;
            let (width, height, frames) = pick.large;
            registered.push(Registration {
                index: slot.index,
                draft_id: slot.draft_id,
                name: slot.name.clone(),
                kind: pick
                    .kind
                    .unwrap_or_else(|| Kind::recommended(width, height, frames)),
            });
        }
    }
    if registered.is_empty() {
        return Verdict::Refused(
            if skipped
                .iter()
                .any(|skip| skip.reason == SkipReason::NameTaken)
            {
                Refusal::NameReserved
            } else {
                Refusal::Quota
            },
        );
    }
    Verdict::Registered {
        registered,
        skipped,
    }
}

/// One registered picture of a decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    /// The expression's id — the draft's, as in `expression.create` (a registration keeps the id of
    /// the draft it was made from).
    pub id: Uuid,
    pub name: String,
    pub kind: Kind,
}

/// What a decision on a set card registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decided {
    pub set_id: Uuid,
    /// The ONE catalogue version every registration of this decision carries (L6.3).
    pub version: i64,
    /// In slot order.
    pub registered: Vec<Registered>,
    /// In slot order.
    pub skipped: Vec<Skip>,
}

/// A failure after the first write: the caller's transaction must roll back, so it is a database
/// error and never one of the refusals a caller commits.
fn fault(message: &str) -> Error {
    Error::Db(DbError::Sqlx(sqlx::Error::Protocol(message.to_string())))
}

/// What a failure in the write phase becomes: a database error stays one, and anything else (a
/// helper that answers `NotFound` or `Invalid` — the caller maps those to a 409 it **commits**) is
/// turned into a fault, because by then rows have been written.
fn into_fault(error: Error) -> Error {
    match error {
        Error::Db(_) => error,
        other => fault(&format!(
            "the set decision failed after its first write: {other}"
        )),
    }
}

/// A registration with everything its writes need, read before the first write.
struct Made<'a> {
    registration: &'a Registration,
    choice: &'a Choice,
    revision: i64,
    meta: Metadata,
    origin: Value,
    source_attachment_id: Option<Uuid>,
}

/// Prove one kept picture against its stored draft. `(holds, large)`: `holds` is false for every way
/// the picture is not what the person was shown; the rows read here are the draft's own.
async fn prove_pick(
    conn: &mut PgConnection,
    workspace: Uuid,
    row: &sqlx::postgres::PgRow,
    proposer: Uuid,
    subject_pin: Option<Uuid>,
    choice: &Choice,
) -> Result<(bool, (u32, u32, u32)), Error> {
    let no = Ok((false, (0, 0, 0)));
    let Ok(revision) = version(&choice.revision) else {
        return no;
    };
    if row.try_get::<Uuid, _>("creator")? != proposer
        || row.try_get::<Option<Uuid>, _>("subject_member_id")? != subject_pin
        || row.try_get::<String, _>("state")? != "ready"
        || row.try_get::<i64, _>("revision")? != revision
    {
        return no;
    }
    match unexpired(row) {
        Ok(()) => {}
        Err(Error::Expired) => return no,
        Err(other) => return Err(other),
    }
    let stored = sqlx::query(
        "SELECT variant, bytes, sha256, width, height, frame_count FROM expression_draft_image \
          WHERE workspace_id = $1 AND draft_id = $2",
    )
    .bind(workspace)
    .bind(choice.draft_id)
    .fetch_all(&mut *conn)
    .await?;
    if stored.len() != 3 {
        return no;
    }
    let mut large = None;
    for image in &stored {
        let bytes: Vec<u8> = image.try_get("bytes")?;
        let recorded: String = image.try_get("sha256")?;
        let actual = hex::encode(Sha256::digest(&bytes));
        // The bytes themselves, hashed again: the row's own hash is only a claim until it is read
        // back (X8-2: what the person was shown must be what is stored).
        if actual != recorded {
            return no;
        }
        if image.try_get::<String, _>("variant")? == "large" {
            if actual != choice.sha256 {
                return no;
            }
            let edge = |column: &str| -> Result<u32, Error> {
                u32::try_from(image.try_get::<i32, _>(column)?).map_err(|_| Error::Invalid)
            };
            large = Some((edge("width")?, edge("height")?, edge("frame_count")?));
        }
    }
    Ok(match large {
        Some(large) => (true, large),
        None => (false, (0, 0, 0)),
    })
}

/// Register the pictures a person kept on a set card, inside the **decision's** transaction
/// (L6.1). `choices` is what [`parse_choices`] returned; `set_id` and `subject_pin` come from the
/// resolved card (the head's own face, never the payload's), `proposer` is the approval's agent.
///
/// Refusals, all before the first write, all spending nothing: [`Error::Role`] (the add policy as it
/// is *now*, and for a face the person shown), [`Error::Stale`] (a kept draft that is not a ready
/// draft of this approval, a revision or a hash that is not the one shown, an expired card, a head
/// that is no longer `proposed` under this approval), [`Error::NameReserved`] and [`Error::Quota`]
/// (nothing at all registers, L6.1-5). Then the writes: one version, an `expression.created` audit
/// row per picture, one detail notice and one plain notice, the registrations (`created_by` the
/// decider, `proposed_by` the agent, the card's `approval_id`), their renditions, the drafts
/// `activated` with their receipts, the bytes of every other draft reclaimed, the head `decided`.
pub async fn decide_in_tx(
    conn: &mut PgConnection,
    decider: Actor,
    approval_id: Uuid,
    proposer: Uuid,
    set_id: Uuid,
    subject_pin: Option<Uuid>,
    choices: &[Choice],
) -> Result<Decided, Error> {
    if choices.is_empty() || choices.len() > CHOICES_MAX {
        return Err(Error::Invalid);
    }
    let ws = decider.workspace;
    // ---- proofs: reads only ---------------------------------------------------------------------
    let (_, policy) = catalog(conn, ws).await?;
    let who = authorize(conn, decider).await?;
    if !adder_allows(&policy, &who, subject_pin, decider.member) {
        return Err(Error::Role);
    }
    // Every picture of the card, locked in slot order (the reclaim and the sweep take the same
    // order), so a sweep cannot slip between the proofs and the writes.
    let rows = sqlx::query(
        "SELECT * FROM expression_draft WHERE workspace_id = $1 AND approval_id = $2 \
          ORDER BY candidate_index FOR UPDATE",
    )
    .bind(ws)
    .bind(approval_id)
    .fetch_all(&mut *conn)
    .await?;
    // The head: this agent's set, `proposed` under this very approval, of this face.
    let head_face: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT subject_member_id FROM expression_set \
          WHERE workspace_id = $1 AND id = $2 AND approval_id = $3 AND agent_member_id = $4 \
            AND state = 'proposed' FOR UPDATE",
    )
    .bind(ws)
    .bind(set_id)
    .bind(approval_id)
    .bind(proposer)
    .fetch_optional(&mut *conn)
    .await?;
    if head_face != Some(subject_pin) {
        return Err(Error::Stale);
    }
    let mut slots = Vec::with_capacity(rows.len());
    let mut by_draft = BTreeMap::new();
    for row in &rows {
        let id: Uuid = row.try_get("id")?;
        by_draft.insert(id, row);
        if row.try_get::<String, _>("state")? == "ready" {
            slots.push(ReadySlot {
                index: u8::try_from(row.try_get::<i32, _>("candidate_index")?)
                    .map_err(|_| Error::Invalid)?,
                draft_id: id,
                name: row.try_get("name")?,
            });
        }
    }
    let mut picks = Vec::with_capacity(choices.len());
    for choice in choices {
        let (holds, large) = match by_draft.get(&choice.draft_id) {
            Some(row) => prove_pick(conn, ws, row, proposer, subject_pin, choice).await?,
            None => (false, (0, 0, 0)),
        };
        picks.push(Pick {
            draft_id: choice.draft_id,
            kind: choice.kind,
            holds,
            large,
        });
    }
    // The names a kept picture would take, read under the catalogue lock: a name taken is skipped.
    let kept_names: Vec<String> = slots
        .iter()
        .filter(|slot| {
            choices
                .iter()
                .any(|choice| choice.draft_id == slot.draft_id)
        })
        .map(|slot| slot.name.clone())
        .collect();
    let taken: BTreeSet<String> = sqlx::query_scalar(
        "SELECT name FROM expression WHERE workspace_id = $1 AND name = ANY($2)",
    )
    .bind(ws)
    .bind(&kept_names)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM expression WHERE workspace_id = $1 AND status <> 'deleted'",
    )
    .bind(ws)
    .fetch_one(&mut *conn)
    .await?;
    let (registrations, skipped) = match decide_set(&slots, &picks, &taken, live, QUOTA) {
        Verdict::Registered {
            registered,
            skipped,
        } => (registered, skipped),
        Verdict::Refused(refusal) => return Err(refusal.into_error()),
    };
    // What each registration is made of, read and proved before anything is written.
    let choice_of: BTreeMap<Uuid, &Choice> = choices
        .iter()
        .map(|choice| (choice.draft_id, choice))
        .collect();
    let mut made = Vec::with_capacity(registrations.len());
    for registration in &registrations {
        let (Some(row), Some(choice)) = (
            by_draft.get(&registration.draft_id),
            choice_of.get(&registration.draft_id),
        ) else {
            return Err(Error::Stale);
        };
        let meta = metadata(row)?;
        meta.validate()?;
        made.push(Made {
            registration,
            choice,
            revision: version(&choice.revision)?,
            meta,
            origin: row.try_get("origin")?,
            source_attachment_id: row.try_get("origin_source_attachment_id")?,
        });
    }

    // ---- proofs done: writes only from here; a failure from here is a fault, never a refusal ----
    let ids: Vec<Uuid> = registrations
        .iter()
        .map(|registration| registration.draft_id)
        .collect();
    let audits: Vec<(Uuid, Option<Value>)> = made
        .iter()
        .map(|item| {
            (
                item.registration.draft_id,
                Some(json!({
                    "approval_id": approval_id.to_string(),
                    "set_id": set_id.to_string(),
                    "proposed_by": proposer.to_string(),
                    "origin_kind": item.origin.get("kind"),
                    "origin_domain": Value::Null,
                    "sha256_prefix": item.choice.sha256.chars().take(12).collect::<String>(),
                })),
            )
        })
        .collect();
    // The write phase is one block whose every failure leaves as a fault (see [`into_fault`]).
    let written: Result<i64, Error> = async {
        // ONE version for the whole decision (L6.3): one detail notice naming every id, one plain notice.
        let version_after = changed_each(conn, decider, &audits, Effect::Created(&ids)).await?;
        for item in &made {
            let id = item.registration.draft_id;
            let created = sqlx::query(
                "INSERT INTO expression(workspace_id,id,name,display_name,tags,subject_member_id,origin,\
                    created_by,proposed_by,approval_id,version,origin_source_attachment_id,kind) \
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
            )
            .bind(ws)
            .bind(id)
            .bind(&item.meta.name)
            .bind(&item.meta.display_name)
            .bind(json!(item.meta.tags))
            .bind(item.meta.subject_member_id)
            .bind(&item.origin)
            .bind(decider.member)
            .bind(proposer)
            .bind(approval_id)
            .bind(version_after)
            .bind(item.source_attachment_id)
            .bind(item.registration.kind.as_str())
            .fetch_one(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO expression_image(workspace_id,expression_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) \
                 SELECT workspace_id,draft_id,variant,mime,bytes,sha256,width,height,frame_count,duration_ms \
                   FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2",
            )
            .bind(ws)
            .bind(id)
            .execute(&mut *conn)
            .await?;
            // The picture's own receipt, written once with the draft's activation (A17).
            let receipt = json!({
                "workspaceId": ws,
                "version": version_after.to_string(),
                "expression": expression_json(conn, &created).await?,
            });
            sqlx::query("DELETE FROM expression_draft_image WHERE workspace_id=$1 AND draft_id=$2")
                .bind(ws)
                .bind(id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(
                "UPDATE expression_draft SET state='activated',submitted_by=$3,submitted_revision=$4,\
                    submitted_sha256=$5,receipt=$6 WHERE workspace_id=$1 AND id=$2",
            )
            .bind(ws)
            .bind(id)
            .bind(decider.member)
            .bind(item.revision)
            .bind(&item.choice.sha256)
            .bind(&receipt)
            .execute(&mut *conn)
            .await?;
        }
        // Every picture nobody registered — the ones left unkept, the ones a skip left out — loses its
        // bytes (and the agent's words) in this same transaction (A13).
        crate::action::reclaim_in_tx(conn, ws, approval_id).await?;
        // The head is decided: its pictures are expressions now, and the agent may start its next set.
        let moved = sqlx::query(
            "UPDATE expression_set SET state = 'decided' \
              WHERE workspace_id = $1 AND id = $2 AND approval_id = $3 AND state = 'proposed'",
        )
        .bind(ws)
        .bind(set_id)
        .bind(approval_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if moved != 1 {
            return Err(fault("a locked proposed set head did not move to decided"));
        }
        let count = |reason: SkipReason| skipped.iter().filter(|skip| skip.reason == reason).count();
        audit_decided_in_tx(
            conn,
            ws,
            decider.member,
            set_id,
            approval_id,
            DecidedCounts {
                approved: true,
                registered: registrations.len(),
                skipped_name_taken: count(SkipReason::NameTaken),
                skipped_quota: count(SkipReason::Quota),
            },
        )
        .await?;
        Ok(version_after)
    }
    .await;
    let version_after = written.map_err(into_fault)?;
    Ok(Decided {
        set_id,
        version: version_after,
        registered: registrations
            .into_iter()
            .map(|registration| Registered {
                id: registration.draft_id,
                name: registration.name,
                kind: registration.kind,
            })
            .collect(),
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(draft: u128, holds: bool) -> Pick {
        Pick {
            draft_id: Uuid::from_u128(draft),
            kind: None,
            holds,
            large: (64, 64, 1),
        }
    }

    fn slot(index: u8, name: &str) -> ReadySlot {
        ReadySlot {
            index,
            draft_id: Uuid::from_u128(u128::from(index) + 1),
            name: name.to_string(),
        }
    }

    #[test]
    fn the_revision_shape_is_the_contracts_and_a_number_past_i64_is_not_a_shape_error() {
        for good in ["0", "1", "10", "9223372036854775807", "9999999999999999999"] {
            assert!(revision_shape(good), "{good}");
        }
        for bad in ["", "01", "-1", "1.0", "1a", " 1", "10000000000000000000"] {
            assert!(!revision_shape(bad), "{bad:?}");
        }
        // 19 digits that do not fit an i64 pass the shape and then simply match no revision
        assert!(version("9999999999999999999").is_err());
    }

    #[test]
    fn a_decision_with_nothing_kept_is_never_a_registration() {
        let slots = [slot(0, "cat_a")];
        assert_eq!(
            decide_set(&slots, &[], &BTreeSet::new(), 0, QUOTA),
            Verdict::Refused(Refusal::Stale)
        );
    }

    #[test]
    fn a_pick_that_is_no_ready_slot_refuses_the_whole_decision_even_beside_good_ones() {
        let slots = [slot(0, "cat_a"), slot(1, "cat_b")];
        let picks = [pick(1, true), pick(99, true), pick(2, true)];
        assert_eq!(
            decide_set(&slots, &picks, &BTreeSet::new(), 0, QUOTA),
            Verdict::Refused(Refusal::Stale)
        );
    }
}
