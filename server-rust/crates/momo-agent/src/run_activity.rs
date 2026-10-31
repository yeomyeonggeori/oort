//! The agent's own activity report — `activity` and `plan` rows of the run event ledger
//! (migration 167, ADR-0200 증보 7, #4656).
//!
//! **One vocabulary, one validator, one writer.** The closed words (seven kinds, three
//! statuses, the numbers) live here and nowhere else on the server; the Agent Port tool
//! (`oort_run_event`) and any in-server recorder (ADR-0201 B5-7's helper) reach the ledger
//! through [`ActivityReport::validate`] and [`record_run_activity_in_tx`], so the two paths
//! cannot refuse, fold, cap or total differently (7-A15). `momo-mcp` has no dependency on
//! this crate and publishes the same words in its schema; a server test pins the two lists
//! together.
//!
//! **What is judged here and what is not.** Length, characters and the closed words are
//! judged (the text rule is `momo_wire::report_text::checked_report_text`, the very function a
//! stage marker passes through: copy-free, 7-3). Meaning is not: a label that *says* a file name
//! or a secret passes, and the defence is the short limits, the closed kinds, the tool text,
//! the reader's "agent-reported" label and the audience (7-3 "정직한 한계"). A report that
//! fails is refused **whole**: the server never trims or repairs it, because a silent
//! repair is a silent forgery.
//!
//! **No thinking.** There is no field for it (7-4). `label` names the work, `stage` is the
//! one-line progress note, and the server cannot tell them apart — the tool text does.

use momo_db::DbError;
use momo_wire::report_text::{checked_report_text, ReportTextFault};
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

/// The seven activity kinds. The first six share names and meaning with the end-of-run
/// `artifacts.toolCounts` categories; `delegate` is activities-only (7-1, 7-Q3).
pub const ACTIVITY_KINDS: [&str; 7] = ["run", "edit", "read", "search", "web", "other", "delegate"];
/// An activity is `in_progress` until it ends as `completed` or `failed` (ACP spelling).
pub const ACTIVITY_STATUSES: [&str; 3] = ["in_progress", "completed", "failed"];
/// A plan step (ACP spelling).
pub const PLAN_STATUSES: [&str; 3] = ["pending", "in_progress", "completed"];

/// Activities in one call.
pub const MAX_ACTIVITIES_PER_CALL: usize = 8;
/// Steps in a plan.
pub const MAX_PLAN_ITEMS: usize = 12;
/// `activities[].id`: characters (the alphabet is [`id_alphabet_ok`]).
pub const MAX_ACTIVITY_ID_CHARS: usize = 32;
/// `activities[].label`: characters.
pub const MAX_ACTIVITY_LABEL_CHARS: usize = 40;
/// `plan[].text`: characters.
pub const MAX_PLAN_TEXT_CHARS: usize = 60;
/// `activities[].n`: the same ceiling as `artifacts.toolCounts`.
pub const MAX_ACTIVITY_N: i64 = 100_000;
/// `activity` ledger rows a run keeps before the roll (migration 167).
pub const ACTIVITY_ROWS_PER_RUN: i64 = 100;
/// `plan` ledger rows a run keeps before the roll.
pub const PLAN_ROWS_PER_RUN: i64 = 10;

/// One activity as the caller sent it, before any judgement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawActivity {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub status: String,
    pub n: Option<i64>,
}

/// One plan step as the caller sent it, before any judgement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPlanItem {
    pub text: String,
    pub status: String,
}

/// The closed list of fields a refusal may name (7-2). A field outside it cannot be said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportField {
    Activities,
    ActivityId,
    ActivityKind,
    ActivityLabel,
    ActivityStatus,
    ActivityN,
    Plan,
    PlanText,
    PlanStatus,
}

impl ReportField {
    /// Every field, in the order the wire lists them.
    pub const ALL: [ReportField; 9] = [
        ReportField::Activities,
        ReportField::ActivityId,
        ReportField::ActivityKind,
        ReportField::ActivityLabel,
        ReportField::ActivityStatus,
        ReportField::ActivityN,
        ReportField::Plan,
        ReportField::PlanText,
        ReportField::PlanStatus,
    ];

    /// The dotted path the agent sees (`activities.label`), a fixed string.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Activities => "activities",
            Self::ActivityId => "activities.id",
            Self::ActivityKind => "activities.kind",
            Self::ActivityLabel => "activities.label",
            Self::ActivityStatus => "activities.status",
            Self::ActivityN => "activities.n",
            Self::Plan => "plan",
            Self::PlanText => "plan.text",
            Self::PlanStatus => "plan.status",
        }
    }

    /// The closed audit reason (`agent.run.report_rejected`) of a refusal on this field.
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Plan | Self::PlanText | Self::PlanStatus => "plan_invalid",
            _ => "activities_invalid",
        }
    }
}

/// The closed rule a field broke (the names `ArtifactRule` uses on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportRule {
    /// Not one of the closed words.
    Enum,
    /// A control, invisible, direction or path-separator character.
    Forbidden,
    /// A length or a number out of bounds.
    Range,
    /// Wrong characters for an identifier.
    Format,
}

impl ReportRule {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Enum => "enum",
            Self::Forbidden => "forbidden",
            Self::Range => "range",
            Self::Format => "format",
        }
    }
}

/// Why a report was refused: which field, which rule and, for an item, which one (0-based —
/// a position, so it tells the agent nothing it did not send). Never the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReportFault {
    pub field: ReportField,
    pub rule: ReportRule,
    pub index: Option<usize>,
}

impl ReportFault {
    const fn new(field: ReportField, rule: ReportRule, index: Option<usize>) -> Self {
        Self { field, rule, index }
    }
}

/// The characters an activity id may contain: `A-Z a-z 0-9 _ -`.
pub fn id_alphabet_ok(id: &str) -> bool {
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A text field's refusal: a length is a `range`, any forbidden character a `forbidden`.
const fn text_rule(fault: ReportTextFault) -> ReportRule {
    match fault {
        ReportTextFault::Length => ReportRule::Range,
        ReportTextFault::UnsafeChar | ReportTextFault::PathSeparator => ReportRule::Forbidden,
    }
}

fn closed_word(raw: &str, words: &'static [&'static str]) -> Option<&'static str> {
    words.iter().copied().find(|word| *word == raw)
}

/// One validated activity (private fields: only [`ActivityReport::validate`] makes one).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Activity {
    id: String,
    kind: &'static str,
    label: Option<String>,
    status: &'static str,
    n: i64,
}

/// One validated plan step.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlanItem {
    text: String,
    status: &'static str,
}

/// One agent report that has passed every rule of 7-2/7-3. The fields are private and there
/// is no other constructor, so [`record_run_activity_in_tx`] cannot be handed text that
/// skipped the judgement.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ActivityReport {
    /// One entry per id, the later entry of a repeated id winning (7-2), in call order.
    activities: Vec<Activity>,
    /// `None` leaves the plan as it is; `Some` replaces it whole (`Some([])` clears).
    plan: Option<Vec<PlanItem>>,
}

impl ActivityReport {
    /// Judge a report. `activities` and `plan` are `None` when the call did not carry them.
    /// The first fault wins (activities before plan, items in order).
    pub fn validate(
        activities: Option<&[RawActivity]>,
        plan: Option<&[RawPlanItem]>,
    ) -> Result<Self, ReportFault> {
        let mut kept: Vec<Activity> = Vec::new();
        if let Some(items) = activities {
            if items.len() > MAX_ACTIVITIES_PER_CALL {
                return Err(ReportFault::new(
                    ReportField::Activities,
                    ReportRule::Range,
                    None,
                ));
            }
            for (index, item) in items.iter().enumerate() {
                let at = Some(index);
                let id = validated_id(&item.id)
                    .map_err(|(field, rule)| ReportFault::new(field, rule, at))?;
                let kind = closed_word(&item.kind, &ACTIVITY_KINDS).ok_or(ReportFault::new(
                    ReportField::ActivityKind,
                    ReportRule::Enum,
                    at,
                ))?;
                let label = match item.label.as_deref() {
                    None => None,
                    Some(raw) => Some(checked_report_text(raw, MAX_ACTIVITY_LABEL_CHARS).map_err(
                        |fault| ReportFault::new(ReportField::ActivityLabel, text_rule(fault), at),
                    )?),
                };
                let status = closed_word(&item.status, &ACTIVITY_STATUSES).ok_or(
                    ReportFault::new(ReportField::ActivityStatus, ReportRule::Enum, at),
                )?;
                let n = match item.n {
                    None => 1,
                    Some(n) if (1..=MAX_ACTIVITY_N).contains(&n) => n,
                    Some(_) => {
                        return Err(ReportFault::new(
                            ReportField::ActivityN,
                            ReportRule::Range,
                            at,
                        ))
                    }
                };
                // The later report of one id wins: drop the earlier entry, keep the new one
                // where it was said.
                kept.retain(|earlier| earlier.id != id);
                kept.push(Activity {
                    id,
                    kind,
                    label,
                    status,
                    n,
                });
            }
        }
        let plan = match plan {
            None => None,
            Some(items) => {
                if items.len() > MAX_PLAN_ITEMS {
                    return Err(ReportFault::new(ReportField::Plan, ReportRule::Range, None));
                }
                let mut steps = Vec::with_capacity(items.len());
                for (index, item) in items.iter().enumerate() {
                    let at = Some(index);
                    let text =
                        checked_report_text(&item.text, MAX_PLAN_TEXT_CHARS).map_err(|fault| {
                            ReportFault::new(ReportField::PlanText, text_rule(fault), at)
                        })?;
                    let status = closed_word(&item.status, &PLAN_STATUSES).ok_or(
                        ReportFault::new(ReportField::PlanStatus, ReportRule::Enum, at),
                    )?;
                    steps.push(PlanItem { text, status });
                }
                Some(steps)
            }
        };
        Ok(Self {
            activities: kept,
            plan,
        })
    }

    /// Nothing to write (no activity, no plan).
    pub fn is_empty(&self) -> bool {
        self.activities.is_empty() && self.plan.is_none()
    }

    /// How many activities the call carried after the repeat of an id was folded away.
    pub fn activity_count(&self) -> usize {
        self.activities.len()
    }

    /// How many plan steps the call carried, `None` when it did not carry a plan.
    pub fn plan_steps(&self) -> Option<usize> {
        self.plan.as_ref().map(Vec::len)
    }

    fn activities_json(&self) -> Option<Value> {
        (!self.activities.is_empty()).then(|| {
            Value::Array(
                self.activities
                    .iter()
                    .map(|activity| {
                        let mut object = serde_json::Map::new();
                        object.insert("id".into(), json!(activity.id));
                        object.insert("kind".into(), json!(activity.kind));
                        if let Some(label) = &activity.label {
                            object.insert("label".into(), json!(label));
                        }
                        object.insert("status".into(), json!(activity.status));
                        object.insert("n".into(), json!(activity.n));
                        Value::Object(object)
                    })
                    .collect(),
            )
        })
    }

    fn plan_json(&self) -> Option<Value> {
        self.plan.as_ref().map(|steps| {
            Value::Array(
                steps
                    .iter()
                    .map(|step| json!({"text": step.text, "status": step.status}))
                    .collect(),
            )
        })
    }
}

/// An id: 1..=32 characters of the closed alphabet, with no trimming (a space is refused,
/// not stripped), and the text rule on top so one function judges every agent text.
fn validated_id(raw: &str) -> Result<String, (ReportField, ReportRule)> {
    checked_report_text(raw, MAX_ACTIVITY_ID_CHARS)
        .map_err(|fault| (ReportField::ActivityId, text_rule(fault)))?;
    if !id_alphabet_ok(raw) {
        return Err((ReportField::ActivityId, ReportRule::Format));
    }
    Ok(raw.to_string())
}

/// Record one validated report on the caller agent's own run: activities as changes (a
/// repeat folds, a change is a row), the plan as a whole replacement, the ended-unit total
/// moved, the roll applied — all in the caller's transaction. Returns the ledger rows
/// written (0 for a folded repeat, an empty report, or a run that is not this agent's in this
/// tenant).
///
/// **Precondition (every caller).** The caller is inside the tenant transaction
/// (`app.workspace_id` set; RLS rejects a foreign workspace) and has ALREADY locked the run row
/// (`FOR UPDATE` or `FOR NO KEY UPDATE`): the Agent Port path has (`lock_gateway_run_in_tx`).
/// The SQL function takes a per-run advisory lock but not the row lock, so it does not enforce
/// the order itself: a caller that has not locked the row can deadlock with a concurrent
/// tool-path call on the same run (the total table's foreign key needs KEY SHARE on a row the
/// tool path holds `FOR UPDATE`, while the tool path waits for the advisory lock). The in-server
/// helper (ADR-0201 B5-7, #4968) must lock the run row first; see migration 167, "LOCKS".
///
/// This writes **no** `output.stages` entry and spends **no** step: it never goes through
/// `record_stage_in_tx` (7-A14).
pub async fn record_run_activity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    actor: Uuid,
    report: &ActivityReport,
) -> Result<i32, DbError> {
    if report.is_empty() {
        return Ok(0);
    }
    let written: i32 = sqlx::query_scalar("SELECT agent_run_activity_record($1, $2, $3, $4, $5)")
        .bind(workspace_id)
        .bind(run_id)
        .bind(actor)
        .bind(report.activities_json())
        .bind(report.plan_json())
        .fetch_one(&mut *conn)
        .await?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(
        id: &str,
        kind: &str,
        label: Option<&str>,
        status: &str,
        n: Option<i64>,
    ) -> RawActivity {
        RawActivity {
            id: id.into(),
            kind: kind.into(),
            label: label.map(str::to_string),
            status: status.into(),
            n,
        }
    }

    fn plan_item(text: &str, status: &str) -> RawPlanItem {
        RawPlanItem {
            text: text.into(),
            status: status.into(),
        }
    }

    fn fault_of(activities: &[RawActivity]) -> ReportFault {
        ActivityReport::validate(Some(activities), None).expect_err("must be refused")
    }

    #[test]
    fn a_well_formed_report_is_kept_whole() {
        let report = ActivityReport::validate(
            Some(&[
                activity("a1", "read", Some("  파일 읽기 "), "completed", Some(12)),
                activity("r2", "delegate", None, "in_progress", None),
            ]),
            Some(&[
                plan_item("계획", "pending"),
                plan_item("실행", "in_progress"),
            ]),
        )
        .expect("valid");
        assert_eq!(report.activity_count(), 2);
        assert_eq!(report.plan_steps(), Some(2));
        let json = report.activities_json().expect("activities");
        assert_eq!(
            json[0]["label"],
            json!("파일 읽기"),
            "trimmed like a stage marker"
        );
        assert_eq!(json[0]["n"], json!(12));
        assert_eq!(json[1]["n"], json!(1), "n defaults to 1");
        assert!(json[1].get("label").is_none(), "no label stays no label");
    }

    #[test]
    fn the_limits_are_inclusive_at_forty_and_sixty_characters() {
        // exactly the limit passes, one more is a range fault, and the count is of
        // characters, not bytes.
        let forty = "가".repeat(MAX_ACTIVITY_LABEL_CHARS);
        assert!(ActivityReport::validate(
            Some(&[activity("a1", "read", Some(&forty), "completed", None)]),
            None
        )
        .is_ok());
        let over = "가".repeat(MAX_ACTIVITY_LABEL_CHARS + 1);
        let fault = fault_of(&[activity("a1", "read", Some(&over), "completed", None)]);
        assert_eq!(
            (fault.field, fault.rule, fault.index),
            (ReportField::ActivityLabel, ReportRule::Range, Some(0))
        );
        let sixty = "나".repeat(MAX_PLAN_TEXT_CHARS);
        assert!(ActivityReport::validate(None, Some(&[plan_item(&sixty, "pending")])).is_ok());
        let fault = ActivityReport::validate(
            None,
            Some(&[
                plan_item("ok", "pending"),
                plan_item(&"나".repeat(61), "pending"),
            ]),
        )
        .expect_err("61 characters");
        assert_eq!(
            (fault.field, fault.rule, fault.index),
            (ReportField::PlanText, ReportRule::Range, Some(1))
        );
    }

    #[test]
    fn forbidden_characters_in_a_label_or_a_step_are_refused() {
        for bad in [
            "a/b",
            "a\\b",
            "bad\u{7}",
            "\u{202E}rtl",
            "tab\there",
            "zero\u{200B}width",
        ] {
            let fault = fault_of(&[activity("a1", "run", Some(bad), "in_progress", None)]);
            assert_eq!(
                (fault.field, fault.rule),
                (ReportField::ActivityLabel, ReportRule::Forbidden),
                "{bad:?}"
            );
            let fault = ActivityReport::validate(None, Some(&[plan_item(bad, "pending")]))
                .expect_err("plan text");
            assert_eq!(
                (fault.field, fault.rule),
                (ReportField::PlanText, ReportRule::Forbidden),
                "{bad:?}"
            );
        }
        // an empty label is a length fault, not "no label"
        let fault = fault_of(&[activity("a1", "run", Some("   "), "in_progress", None)]);
        assert_eq!(
            (fault.field, fault.rule),
            (ReportField::ActivityLabel, ReportRule::Range)
        );
    }

    #[test]
    fn an_id_keeps_to_its_closed_alphabet_and_is_never_trimmed() {
        for ok in ["a1", "r-2", "Read_3", &"x".repeat(32)] {
            assert!(
                ActivityReport::validate(
                    Some(&[activity(ok, "read", None, "completed", None)]),
                    None
                )
                .is_ok(),
                "{ok}"
            );
        }
        for (bad, rule) in [
            ("a.b", ReportRule::Format),
            ("a b", ReportRule::Format),
            (" a1", ReportRule::Format),
            ("a1 ", ReportRule::Format),
            ("가나", ReportRule::Format),
            ("a/b", ReportRule::Forbidden),
            ("a\\b", ReportRule::Forbidden),
            ("", ReportRule::Range),
        ] {
            let fault = fault_of(&[activity(bad, "read", None, "completed", None)]);
            assert_eq!(
                (fault.field, fault.rule),
                (ReportField::ActivityId, rule),
                "{bad:?}"
            );
        }
        let fault = fault_of(&[activity(&"x".repeat(33), "read", None, "completed", None)]);
        assert_eq!(
            (fault.field, fault.rule),
            (ReportField::ActivityId, ReportRule::Range)
        );
    }

    #[test]
    fn the_words_and_the_counts_are_closed() {
        let ok = |kind: &str, status: &str, n: Option<i64>| {
            ActivityReport::validate(Some(&[activity("a1", kind, None, status, n)]), None)
        };
        for kind in ACTIVITY_KINDS {
            assert!(ok(kind, "completed", None).is_ok(), "{kind}");
        }
        assert_eq!(
            ok("think", "completed", None).unwrap_err().field,
            ReportField::ActivityKind
        );
        assert_eq!(
            ok("READ", "completed", None).unwrap_err().rule,
            ReportRule::Enum
        );
        for status in ACTIVITY_STATUSES {
            assert!(ok("read", status, None).is_ok(), "{status}");
        }
        assert_eq!(
            ok("read", "pending", None).unwrap_err().field,
            ReportField::ActivityStatus
        );
        assert!(ok("read", "completed", Some(1)).is_ok());
        assert!(ok("read", "completed", Some(MAX_ACTIVITY_N)).is_ok());
        for n in [0, -1, MAX_ACTIVITY_N + 1] {
            let fault = ok("read", "completed", Some(n)).unwrap_err();
            assert_eq!(
                (fault.field, fault.rule),
                (ReportField::ActivityN, ReportRule::Range),
                "{n}"
            );
        }
        let bad_step = ActivityReport::validate(None, Some(&[plan_item("x", "completed ")]));
        assert_eq!(bad_step.unwrap_err().field, ReportField::PlanStatus);
        assert_eq!(
            ActivityReport::validate(None, Some(&[plan_item("x", "failed")]))
                .unwrap_err()
                .rule,
            ReportRule::Enum,
            "a plan step has no `failed`"
        );
    }

    #[test]
    fn the_per_call_counts_are_bounded() {
        let many: Vec<RawActivity> = (0..9)
            .map(|i| activity(&format!("a{i}"), "read", None, "completed", None))
            .collect();
        let fault = ActivityReport::validate(Some(&many), None).unwrap_err();
        assert_eq!(
            (fault.field, fault.rule, fault.index),
            (ReportField::Activities, ReportRule::Range, None)
        );
        assert!(ActivityReport::validate(Some(&many[..8]), None).is_ok());
        let steps: Vec<RawPlanItem> = (0..13)
            .map(|i| plan_item(&format!("s{i}"), "pending"))
            .collect();
        let fault = ActivityReport::validate(None, Some(&steps)).unwrap_err();
        assert_eq!(
            (fault.field, fault.rule),
            (ReportField::Plan, ReportRule::Range)
        );
        assert!(ActivityReport::validate(None, Some(&steps[..12])).is_ok());
    }

    #[test]
    fn the_later_report_of_a_repeated_id_wins_and_keeps_its_position() {
        let report = ActivityReport::validate(
            Some(&[
                activity("a1", "read", Some("먼저"), "in_progress", None),
                activity("b2", "edit", None, "in_progress", None),
                activity("a1", "read", Some("나중"), "completed", Some(3)),
            ]),
            None,
        )
        .unwrap();
        let json = report.activities_json().unwrap();
        assert_eq!(report.activity_count(), 2);
        assert_eq!(json[0]["id"], json!("b2"));
        assert_eq!(json[1]["id"], json!("a1"));
        assert_eq!(json[1]["label"], json!("나중"));
        assert_eq!(json[1]["status"], json!("completed"));
    }

    #[test]
    fn an_empty_plan_clears_and_a_missing_plan_leaves_it() {
        let cleared = ActivityReport::validate(None, Some(&[])).unwrap();
        assert_eq!(cleared.plan_steps(), Some(0));
        assert!(!cleared.is_empty(), "a clearing plan is still a write");
        assert_eq!(cleared.plan_json(), Some(json!([])));
        let left = ActivityReport::validate(None, None).unwrap();
        assert!(left.is_empty());
        assert_eq!(left.plan_json(), None);
    }

    #[test]
    fn a_fault_names_only_closed_words_and_a_position() {
        // the reason code and the field list are fixed strings, whatever the input was.
        let fault = fault_of(&[activity(
            "a1",
            "run",
            Some("SECRET/value"),
            "in_progress",
            None,
        )]);
        let said = format!(
            "{} {} {:?}",
            fault.field.as_str(),
            fault.rule.as_str(),
            fault.index
        );
        assert!(!said.contains("SECRET"), "{said}");
        assert_eq!(fault.field.reason(), "activities_invalid");
        assert_eq!(ReportField::PlanText.reason(), "plan_invalid");
        assert!(ReportField::ALL
            .iter()
            .all(|f| f.as_str().starts_with("activities") || f.as_str().starts_with("plan")));
    }
}
