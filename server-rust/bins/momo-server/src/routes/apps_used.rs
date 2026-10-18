//! 「쓴 앱」 meta — the execution site's own report of which connector apps a
//! run used (ADR-0113 증보 2 E8 / D5-③, #3946).
//!
//! An execution site (Hermes, workd, a hosted agent) reports, together with the
//! run's result, **which app, which tool, how many calls** — nothing else. The
//! server stores the report next to the result and leaves one
//! `connector.tool_used` audit row.
//!
//! ## What this is not
//!
//! * **Not proof.** It is the execution site's self-report. A vendor path may
//!   report nothing at all. The server does not check it against `plugin_grant`
//!   or the registry (that is the `tool_grants` producer's concern, E5), and
//!   every reader — screen, audit document — says so.
//! * **Not a body.** The wire carries three keys per entry, each a bounded
//!   identifier or a count. There is no key for an argument, a result, a URL, a
//!   token or an OAuth value, and an unknown key refuses the **whole** report
//!   (nothing stored, nothing audited): a payload cannot ride along under a key
//!   the contract never named.
//! * **Not required.** No report means no `appsUsed` key on the run and no audit
//!   row — no empty tail.
//!
//! ## Shape
//!
//! ```text
//! appsUsed: [ { "pluginId": "google-calendar", "tool": "list_events", "calls": 3 } , … ]
//! ```
//!
//! at most [`MAX_ENTRIES`] entries, one per `(pluginId, tool)` pair.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::plugin_manifest::is_plugin_id;

/// The audit `action` (E8).
pub(crate) const AUDIT_ACTION: &str = "connector.tool_used";
/// The audit `detail.schema`.
pub(crate) const AUDIT_SCHEMA: &str = "momo.connector.tool_used.v0";
/// The wire keys of one entry (request, stored output and read projection alike).
pub(crate) const ENTRY_KEYS: [&str; 3] = momo_mcp::APPS_USED_ENTRY_KEYS;
/// The `detail.source` value: whose word this is.
pub(crate) const SOURCE_AGENT_REPORTED: &str = "agent_reported";
/// Most entries one completion may report.
pub(crate) const MAX_ENTRIES: usize = momo_mcp::MAX_APPS_USED_ENTRIES as usize;
/// Longest tool name, in bytes (ASCII only).
pub(crate) const MAX_TOOL_BYTES: usize = momo_mcp::MAX_APPS_USED_TOOL_BYTES as usize;
/// Ceiling of one `calls` value — the same ceiling every other reported count has.
pub(crate) const MAX_CALLS: i64 = momo_mcp::MAX_REPORTED_COUNT;

/// One `(app, tool)` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppUse {
    pub plugin_id: String,
    pub tool: String,
    pub calls: i64,
}

/// A validated, non-empty report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppsUsed(Vec<AppUse>);

/// The one refusal. It names no field and carries no value the sender sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AppsUsedRefused;

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — a vendor tool name as an identifier,
/// never free text (no whitespace, no `/`, no `:`, no `=`, no quotes).
///
/// This bounds the *shape* only. A self-report cannot be proven free of a secret
/// that happens to look like an identifier; what the server guarantees is that
/// nothing longer, richer or differently keyed than this can be stored.
fn is_tool_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=MAX_TOOL_BYTES).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
}

fn entry_of(raw: &Value) -> Result<AppUse, AppsUsedRefused> {
    let Value::Object(object) = raw else {
        return Err(AppsUsedRefused);
    };
    if object.keys().any(|key| !ENTRY_KEYS.contains(&key.as_str())) {
        return Err(AppsUsedRefused);
    }
    let plugin_id = match object.get("pluginId") {
        Some(Value::String(value)) if is_plugin_id(value) => value.clone(),
        _ => return Err(AppsUsedRefused),
    };
    let tool = match object.get("tool") {
        Some(Value::String(value)) if is_tool_name(value) => value.clone(),
        _ => return Err(AppsUsedRefused),
    };
    let calls = match object.get("calls") {
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value) if (1..=MAX_CALLS).contains(&value) => value,
            _ => return Err(AppsUsedRefused),
        },
        _ => return Err(AppsUsedRefused),
    };
    Ok(AppUse {
        plugin_id,
        tool,
        calls,
    })
}

/// The report as the request carried it. `Ok(None)` for an absent, `null` or
/// empty list (nothing to say is not a refusal); anything malformed refuses the
/// whole report.
pub(crate) fn validated_apps_used(
    raw: Option<&Value>,
) -> Result<Option<AppsUsed>, AppsUsedRefused> {
    let items = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(AppsUsedRefused),
    };
    if items.is_empty() {
        return Ok(None);
    }
    if items.len() > MAX_ENTRIES {
        return Err(AppsUsedRefused);
    }
    let mut entries: Vec<AppUse> = Vec::with_capacity(items.len());
    for item in items {
        let entry = entry_of(item)?;
        // One line per pair: a duplicate is a malformed report, not a sum.
        if entries
            .iter()
            .any(|seen| seen.plugin_id == entry.plugin_id && seen.tool == entry.tool)
        {
            return Err(AppsUsedRefused);
        }
        entries.push(entry);
    }
    Ok(Some(AppsUsed(entries)))
}

impl AppsUsed {
    fn entries_json(&self) -> Vec<Value> {
        self.0
            .iter()
            .map(|entry| {
                json!({
                    "pluginId": entry.plugin_id,
                    "tool": entry.tool,
                    "calls": entry.calls,
                })
            })
            .collect()
    }

    /// The stored / wire shape (`agent_run.output.appsUsed`).
    pub(crate) fn to_json(&self) -> Value {
        Value::Array(self.entries_json())
    }

    pub(crate) fn total_calls(&self) -> i64 {
        self.0.iter().map(|entry| entry.calls).sum()
    }

    /// The audit `detail` — the closed key set, no more.
    pub(crate) fn audit_detail(&self, run_id: Uuid) -> Value {
        let mut detail = Map::new();
        detail.insert("run_id".into(), json!(run_id.to_string()));
        detail.insert("source".into(), json!(SOURCE_AGENT_REPORTED));
        detail.insert("apps".into(), self.to_json());
        detail.insert("total_calls".into(), json!(self.total_calls()));
        Value::Object(detail)
    }
}

/// The read projection of a stored `output.appsUsed`: only entries that still
/// pass the write-side rules (a row is data, not proof). `None` when the run
/// reported nothing, so the key is simply absent on the wire.
pub(crate) fn of_output(output: Option<&Value>) -> Option<Value> {
    let stored = output?.get("appsUsed")?;
    validated_apps_used(Some(stored))
        .ok()
        .flatten()
        .map(|apps| apps.to_json())
}

/// The run's `output` as the read side may show it: a stored `appsUsed` that no
/// longer passes the write-side rules is removed, so the top-level field and
/// the raw `output` copy agree and a tampered row is never echoed either way.
pub(crate) fn scrubbed_output(output: Option<&Value>) -> Option<Value> {
    let mut copy = output?.clone();
    if let Value::Object(map) = &mut copy {
        if map.contains_key("appsUsed") && of_output(output).is_none() {
            map.remove("appsUsed");
        }
    }
    Some(copy)
}

/// One `connector.tool_used` row for a completion that carried a report, written
/// in the completion's own transaction (it rolls back with it).
pub(crate) async fn write_tool_used_audit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    via_token_id: Option<Uuid>,
    apps: &AppsUsed,
) -> Result<(), momo_db::DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_ACTION)
            .by(agent_member_id)
            .target("agent_run", run_id)
            .via_token(via_token_id)
            .run(run_id)
            .with_schema(AUDIT_SCHEMA, apps.audit_detail(run_id)),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only keys the audit `detail` may carry.
    const AUDIT_DETAIL_KEYS: [&str; 5] = ["schema", "run_id", "source", "apps", "total_calls"];

    fn one() -> Value {
        json!([{"pluginId": "google-calendar", "tool": "list_events", "calls": 3}])
    }

    #[test]
    fn absent_null_and_empty_are_no_report() {
        assert_eq!(validated_apps_used(None), Ok(None));
        assert_eq!(validated_apps_used(Some(&Value::Null)), Ok(None));
        assert_eq!(validated_apps_used(Some(&json!([]))), Ok(None));
    }

    #[test]
    fn a_well_formed_report_round_trips_with_only_the_three_keys() {
        let apps = validated_apps_used(Some(&one())).unwrap().unwrap();
        assert_eq!(apps.to_json(), one());
        assert_eq!(apps.total_calls(), 3);
        let detail = apps.audit_detail(Uuid::nil());
        let keys: Vec<&str> = detail
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(
            keys.iter().all(|key| AUDIT_DETAIL_KEYS.contains(key)),
            "{keys:?}"
        );
        assert_eq!(detail["source"], json!("agent_reported"));
    }

    #[test]
    fn every_malformed_shape_refuses_the_whole_report() {
        for bad in [
            json!("x"),
            json!({"pluginId": "google-calendar"}),
            json!([1]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": 1, "body": "m"}]),
            json!([{"pluginId": "google-calendar", "tool": "t"}]),
            json!([{"pluginId": "Google Calendar", "tool": "t", "calls": 1}]),
            json!([{"pluginId": "ab", "tool": "t", "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "has space", "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "a=b", "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "a:b", "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "", "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "t".repeat(65), "calls": 1}]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": 0}]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": -1}]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": 1.5}]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": MAX_CALLS + 1}]),
            json!([{"pluginId": "google-calendar", "tool": "t", "calls": "3"}]),
            json!([
                {"pluginId": "google-calendar", "tool": "t", "calls": 1},
                {"pluginId": "google-calendar", "tool": "t", "calls": 2}
            ]),
        ] {
            assert_eq!(
                validated_apps_used(Some(&bad)),
                Err(AppsUsedRefused),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_entry_count_is_capped() {
        let many = |n: usize| {
            Value::Array(
                (0..n)
                    .map(|i| json!({"pluginId": "google-calendar", "tool": format!("t{i}"), "calls": 1}))
                    .collect(),
            )
        };
        assert!(validated_apps_used(Some(&many(MAX_ENTRIES)))
            .unwrap()
            .is_some());
        assert_eq!(
            validated_apps_used(Some(&many(MAX_ENTRIES + 1))),
            Err(AppsUsedRefused)
        );
    }

    #[test]
    fn the_scrubbed_output_keeps_a_good_report_and_drops_a_tampered_one() {
        let good = json!({"body": "x", "appsUsed": one()});
        assert_eq!(scrubbed_output(Some(&good)), Some(good.clone()));
        let tampered = json!({"body": "x", "appsUsed": [{"pluginId": "gmail", "tool": "t", "calls": 1, "token": "m"}]});
        assert_eq!(scrubbed_output(Some(&tampered)), Some(json!({"body": "x"})));
        assert_eq!(scrubbed_output(None), None);
        let quiet = json!({"body": "x"});
        assert_eq!(scrubbed_output(Some(&quiet)), Some(quiet.clone()));
    }

    #[test]
    fn the_read_projection_drops_a_stored_row_that_fails_the_write_rules() {
        assert_eq!(of_output(None), None);
        assert_eq!(of_output(Some(&json!({"body": "x"}))), None);
        assert_eq!(of_output(Some(&json!({"appsUsed": one()}))), Some(one()));
        let tampered = json!({"appsUsed": [{"pluginId": "google-calendar", "tool": "t", "calls": 1, "token": "m"}]});
        assert_eq!(of_output(Some(&tampered)), None);
    }
}
