//! 「요청한 앱」 marker — the send request's `apps` field and the server-owned
//! `message.props.requestedApps` it becomes (ADR-0113 증보 3 F5, #4313).
//!
//! ```text
//! POST …/channels/{ch}/messages   { …, "apps": ["com.momo.plugins.gmail", …] }
//!   → 201  message.props.requestedApps = ["com.momo.plugins.gmail", …]
//!   → 400  { "error": { "code": "apps_unavailable", … } }
//! ```
//!
//! The composer's 「앱」 chip (#4315) says **which apps the requester picked**. The
//! server records that next to the message so every client can draw the same logo
//! chips, and judges it once, when the message is written.
//!
//! ## What the marker is — and is not
//!
//! * **A marker, not a grant.** Delivery (`agent_mentions::delivery_gate`), the
//!   `owner_only` / connector-owner guards and `tool_grants` assembly never read
//!   it: a message carrying `requestedApps` is delivered, refused and granted
//!   exactly like the same message without it. A static guard test
//!   (`tests/requested_apps_static_guards.rs`) pins that no delivery file names
//!   the key, so "the chip made it deliverable" cannot be written by accident.
//! * **A dedicated field, never the `props` map.** The send `props` map is flat
//!   string→string (`dto.rs`) and cannot carry an array, and a client-writable
//!   key would let anyone print a chip under a message that never asked for it.
//!   The key is on [`momo_agent::SERVER_OWNED_APP_PROPS_KEYS`], so the REST
//!   props map, an external webhook and the gateway's answer all lose it; this
//!   module is its only writer.
//! * **Judged on a real insert only.** The check runs inside the send
//!   transaction, after the insert, and only when the insert was new. A retry
//!   with the same `clientMsgId` (`deduped`) answers the stored message with 201
//!   whatever `apps` says now, so an app uninstalled after the first request
//!   cannot turn a harmless retry into a refusal that invites a duplicate send.
//!   A refusal rolls the message back with it.
//! * **One refusal.** `apps_unavailable` names no id and no reason: not a person,
//!   more than three, not an official app id, not installed or switched off all
//!   look the same to the caller, who clears the chips and re-reads the catalog.
//!   It is never silently dropped — a dropped chip would hide a client bug.

use momo_db::sqlx;
use momo_db::{DbError, PgConnection};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::plugin_manifest::is_plugin_id;
use crate::routes::plugins::OFFICIAL_PLUGIN_IDS;

/// The machine code of the one refusal (`ApiError::coded`).
pub(crate) const REFUSAL_CODE: &str = "apps_unavailable";
/// The sentence of the refusal. Names no id, and — on purpose — nothing the web
/// composer's `routing` probe could mistake for a routing refusal.
pub(crate) const REFUSAL_MESSAGE: &str =
    "one or more of the requested apps are not available to this sender in this workspace";

/// Why a request was refused. Every variant is the same 400 on the wire; the
/// split exists so the tests can say which rule fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppsRefusal {
    /// The author is not a person (an agent, a work host, a system author).
    NotAPerson,
    /// More than [`momo_agent::MAX_REQUESTED_APPS`] distinct ids.
    TooMany,
    /// Not shaped like a plugin id, or not one of the official apps.
    NotAnOfficialApp,
    /// An official app, but not installed (or switched off) in this workspace.
    NotInstalled,
}

/// The request list as it will be stored: distinct ids in first-seen order.
/// Exact strings — `Com.Momo.Plugins.GitHub` is not `com.momo.plugins.github`, so
/// a client that spells an id differently is refused by [`judge_shape`] rather
/// than quietly corrected.
pub(crate) fn normalize(requested: &[String]) -> Vec<String> {
    let mut distinct: Vec<String> = Vec::with_capacity(requested.len());
    for id in requested {
        if !distinct.contains(id) {
            distinct.push(id.clone());
        }
    }
    distinct
}

/// Everything about a request that needs no database: a person wrote it, at most
/// three distinct ids, each shaped like an official plugin id.
pub(crate) fn judge_shape(author_is_human: bool, ids: &[String]) -> Result<(), AppsRefusal> {
    if !author_is_human {
        return Err(AppsRefusal::NotAPerson);
    }
    if ids.len() > momo_agent::MAX_REQUESTED_APPS {
        return Err(AppsRefusal::TooMany);
    }
    if ids
        .iter()
        .any(|id| !is_plugin_id(id) || !OFFICIAL_PLUGIN_IDS.contains(&id.as_str()))
    {
        return Err(AppsRefusal::NotAnOfficialApp);
    }
    Ok(())
}

/// The distinct ids of `ids` that are an official, unrevoked registry row **and**
/// installed and enabled in `workspace_id` (an install row that is not revoked).
/// Read under the caller's tenant transaction, so RLS scopes the install rows.
pub(crate) async fn installed_official_apps_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    ids: &[String],
) -> Result<Vec<String>, DbError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT pr.plugin_id \
           FROM plugin_registry pr \
           JOIN workspace_plugin_install wpi \
             ON wpi.workspace_id = $1 \
            AND wpi.plugin_id = pr.plugin_id \
            AND wpi.enabled \
            AND wpi.revoked_at IS NULL \
          WHERE pr.official \
            AND pr.revoked_at IS NULL \
            AND pr.plugin_id = ANY($2) \
          ORDER BY pr.plugin_id",
    )
    .bind(workspace_id)
    .bind(ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// The whole judgement, inside the send transaction: [`judge_shape`], then every id
/// must be installed and enabled in this workspace.
pub(crate) async fn judge_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    author_is_human: bool,
    ids: &[String],
) -> Result<Result<(), AppsRefusal>, DbError> {
    if let Err(refusal) = judge_shape(author_is_human, ids) {
        return Ok(Err(refusal));
    }
    let installed = installed_official_apps_in_tx(conn, workspace_id, ids).await?;
    if installed.len() != ids.len() {
        return Ok(Err(AppsRefusal::NotInstalled));
    }
    Ok(Ok(()))
}

/// Write the marker into the message's props — the one writer of the key. No
/// requested app, no key: an absent `apps` and an empty one are the same request,
/// and "nothing requested" is never an empty array on the wire.
pub(crate) fn stamp_props(props: &mut Value, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    if !props.is_object() {
        *props = Value::Object(serde_json::Map::new());
    }
    if let Some(object) = props.as_object_mut() {
        object.insert(momo_agent::PROP_REQUESTED_APPS.to_string(), json!(ids));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GMAIL: &str = "com.momo.plugins.gmail";
    const GITHUB: &str = "com.momo.plugins.github";
    const DRIVE: &str = "com.momo.plugins.drive";
    const CALENDAR: &str = "com.momo.plugins.google-calendar";

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn duplicates_collapse_in_first_seen_order() {
        assert_eq!(
            normalize(&ids(&[GMAIL, GITHUB, GMAIL, GITHUB, DRIVE])),
            ids(&[GMAIL, GITHUB, DRIVE])
        );
        assert!(normalize(&[]).is_empty());
    }

    /// 수용 5 (the limit, counted **after** de-duplication): three distinct apps are fine however many
    /// times they are repeated, a fourth distinct one is refused.
    #[test]
    fn the_limit_is_three_distinct_apps() {
        let three = normalize(&ids(&[GMAIL, GITHUB, DRIVE, GMAIL, GITHUB, DRIVE, GMAIL]));
        assert_eq!(three.len(), 3);
        assert_eq!(judge_shape(true, &three), Ok(()));
        let four = normalize(&ids(&[GMAIL, GITHUB, DRIVE, CALENDAR]));
        assert_eq!(judge_shape(true, &four), Err(AppsRefusal::TooMany));
        assert_eq!(
            judge_shape(true, &[]),
            Ok(()),
            "an empty list needs no judgement"
        );
    }

    /// 수용 5: only a person's message may carry the marker — an agent's, a work host's or a system
    /// author's request is refused whatever the ids are (and before anything is read).
    #[test]
    fn only_a_person_may_request_apps() {
        assert_eq!(
            judge_shape(false, &ids(&[GMAIL])),
            Err(AppsRefusal::NotAPerson)
        );
        assert_eq!(judge_shape(true, &ids(&[GMAIL])), Ok(()));
    }

    /// 수용 5: an id that is not an official app is refused — wrong grammar, a case variant, an unknown
    /// app, a non-official-looking id, or an injection-shaped string.
    #[test]
    fn only_official_app_ids_pass_the_shape_check() {
        for bad in [
            "",
            "gmail",
            "Com.Momo.Plugins.Gmail",
            "com.momo.plugins.nonexistent",
            "com.evil.plugins.gmail",
            "com.momo.plugins.gmail ",
            "com.momo.plugins.gmail'; DROP TABLE message;--",
            "../com.momo.plugins.gmail",
        ] {
            assert_eq!(
                judge_shape(true, &ids(&[bad])),
                Err(AppsRefusal::NotAnOfficialApp),
                "{bad:?}"
            );
        }
        // One bad id among good ones refuses the whole request (nothing is silently dropped).
        assert_eq!(
            judge_shape(true, &ids(&[GMAIL, "com.momo.plugins.nonexistent"])),
            Err(AppsRefusal::NotAnOfficialApp)
        );
        // Every official id passes the shape check.
        for official in OFFICIAL_PLUGIN_IDS {
            assert_eq!(judge_shape(true, &ids(&[official])), Ok(()), "{official}");
        }
    }

    /// The marker is written as a JSON array under the server-owned key, replaces nothing else, and is
    /// absent — not `[]` — when nothing was requested.
    #[test]
    fn the_marker_is_a_json_array_under_the_owned_key() {
        let mut props = json!({ "harness": "x" });
        stamp_props(&mut props, &ids(&[GMAIL, DRIVE]));
        assert_eq!(props["requestedApps"], json!([GMAIL, DRIVE]));
        assert_eq!(props["harness"], json!("x"), "other props survive");

        let mut untouched = json!({ "harness": "x" });
        stamp_props(&mut untouched, &[]);
        assert!(untouched.get("requestedApps").is_none(), "{untouched}");

        // The key is the one momo-agent owns, so the stripping lists and this writer cannot drift.
        assert_eq!(momo_agent::PROP_REQUESTED_APPS, "requestedApps");
        assert!(momo_agent::SERVER_OWNED_APP_PROPS_KEYS.contains(&momo_agent::PROP_REQUESTED_APPS));
    }

    /// The refusal sentence never contains the word the web composer's `routing` probe reads refusals by
    /// (`thread_root_rejection` documents the probe), and names no id.
    #[test]
    fn the_refusal_stays_out_of_the_routing_probes_vocabulary() {
        assert!(!REFUSAL_MESSAGE.contains("routing"));
        assert!(!REFUSAL_MESSAGE.contains("com.momo"));
        assert_eq!(REFUSAL_CODE, "apps_unavailable");
    }
}
