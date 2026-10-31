//! `AgentRunProgress.bundle` — one approval of a run, read for the viewer
//! (ADR-0186 v6 R-f, #4763).
//!
//! The channel's status chip and the thread's summary line cannot read the approval
//! card (a chip has no card in hand), so the run progress read carries the part of the
//! card they need: which approval, what it reads as now, where it may be decided, whether
//! **this viewer** may decide it, and its one sentence.
//!
//! ## Which approval
//!
//! The one the run is parked on (the newest `pending`), else the newest it asked, whatever
//! its status (`momo_agent::approval::run_approval_facts_in_tx`). A run that never asked
//! has no bundle.
//!
//! ## What it says, and to whom
//!
//! * **The room decides who is told.** The bundle of an approval raised in a channel the
//!   viewer is not an active member of is left out, as if the run had none: the read has
//!   already shown the viewer the run, never that room's approval.
//! * **`status` is as of now.** A `pending` approval past its deadline reads `expired`
//!   before the notifier's sweep writes it down (ADR-0186 증보 v5 U-f), and says nothing
//!   about the question it was still asking.
//! * **`canDecide` is the viewer's.** It is the decision route's own answer asked of this
//!   person: an active human member, in the approval's room, with the approval still
//!   `pending` and in time, and past the role / owner / pinned-person condition the
//!   approval puts on its decider (`momo_push::may_approve_in_tx`, the function the push
//!   audience already asks, held equal to the route by
//!   `approval_push_audience_conformance_pg`). Only a `pending` approval is ever asked
//!   (a settled one cannot be decided, and the answer costs queries). A platform
//!   operator who is not a workspace admin reads `false`: that scope is a property of a
//!   token and no row records it, the same approximation the push audience makes.
//! * **`decisionMode`** is [`decision_mode`]: the existing `opens_in_app` judgment,
//!   asked of the whole stored payload as the decision route asks it.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use momo_agent::approval::{
    effective_status, is_active_human_member_in_tx, run_approval_facts_in_tx,
};
use momo_agent::visible_channels_in_tx;
use momo_db::{DbError, PgConnection};
use momo_push::{may_approve_in_tx, ApprovalCard};
use uuid::Uuid;

use crate::dto::AgentRunBundleDto;
use crate::routes::approvals::decision_mode;

/// The bundle of each run in `run_ids` that has one the `viewer` may be told about,
/// keyed by run id. `now` is the route's clock, taken once: the status a bundle reads
/// as and the `canDecide` beside it are judged against the same instant.
pub(crate) async fn run_bundles_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer: Uuid,
    run_ids: &[Uuid],
    now: DateTime<Utc>,
) -> Result<HashMap<Uuid, AgentRunBundleDto>, DbError> {
    let facts = run_approval_facts_in_tx(conn, workspace_id, run_ids).await?;
    if facts.is_empty() {
        return Ok(HashMap::new());
    }
    let channels: Vec<Uuid> = facts
        .iter()
        .map(|fact| fact.channel_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let visible = visible_channels_in_tx(conn, workspace_id, viewer, &channels).await?;

    // Asked once, and only if some approval still pending needs it.
    let mut viewer_is_human_member: Option<bool> = None;
    let mut bundles = HashMap::with_capacity(facts.len());
    for fact in facts {
        if !visible.contains(&fact.channel_id) {
            continue;
        }
        let status = effective_status(&fact.status, fact.expires_at, now).to_string();
        let pending = status == "pending";
        let can_decide = if pending {
            let human = match viewer_is_human_member {
                Some(known) => known,
                None => {
                    let asked = is_active_human_member_in_tx(conn, viewer).await?;
                    viewer_is_human_member = Some(asked);
                    asked
                }
            };
            human
                && may_approve_in_tx(
                    conn,
                    workspace_id,
                    &ApprovalCard {
                        approval_id: fact.approval_id,
                        action_type: fact.action_type.clone(),
                        payload: fact.payload.clone(),
                    },
                    viewer,
                )
                .await?
        } else {
            false
        };
        // The sentence is read for the status that is **stored**. An approval that only
        // reads `expired` (pending, past its deadline) still has its question as its
        // sentence, and a question is no outcome.
        let line = if status == fact.status {
            fact.line.clone()
        } else {
            None
        };
        let intent = if pending { line.clone() } else { None };
        bundles.insert(
            fact.run_id,
            AgentRunBundleDto {
                approval_id: fact.approval_id.to_string(),
                decision_mode: decision_mode(&fact.action_type, &fact.payload),
                status,
                can_decide,
                line,
                intent,
                action_type: fact.action_type,
            },
        );
    }
    Ok(bundles)
}
