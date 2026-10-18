//! The `tool_grants` evidence a mention job carries for the apps (plugins) its
//! agent may use on a person's behalf — ADR-0113 증보 2 E5 (#3945, C-S3).
//!
//! **Evidence and audit, not enforcement.** Enforcement belongs to the path
//! that runs the tool: workd intersects the signed bundle with this list
//! (#3957), Hermes is held by its static `tools.include` (#3948), a vendor's
//! hosted path gets a reference field only. What this module guarantees is
//! narrower and checkable: the list is built from the delegated user's *live*
//! rows and from nothing else, and a host that is handed no list loads no app
//! tool.
//!
//! * **Delegated user = the trigger's author.** An agent author, a deleted or
//!   suspended member and a guest-less/unknown id all yield zero rows because
//!   the query joins `member.kind = 'human'` and active.
//! * **Live rows only.** A grant counts while `plugin_grant.status = 'active'`,
//!   its install is `enabled` and not revoked, and the registry row is
//!   `official` and not revoked. Revoking a grant, uninstalling, disabling the
//!   install or revoking the registry row each drop the entry from the *next*
//!   job. A job already written is never rewritten ("이미 끝난 호출은 되돌리지
//!   않는다"): the list is a snapshot at enqueue time.
//! * **No credential.** An entry is exactly `{grantId, pluginId, scope,
//!   tools}`. No token, MCP URL, OAuth value or manifest text is read by the
//!   query, so none can be written.
//! * **Old server, old host.** The key is absent from a job an old server
//!   wrote; [`host_app_tools`] gives such a job zero app tools, which is the
//!   contract every host implements.

use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The payload key. Shares its name with the oort worker's per-tool G6
/// projection (`{tool_name, approval_policy, …}`); the two shapes never meet
/// because an E5 entry has no `tool_name`, so the worker's decoder drops it and
/// its approval gate stays fail-closed (pinned by a test below).
pub const TOOL_GRANTS_KEY: &str = "tool_grants";

/// One consent: a member's active scope on an installed app, with the tool
/// names that scope projected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppToolGrant {
    pub grant_id: Uuid,
    pub plugin_id: String,
    pub scope: String,
    pub tools: Vec<String>,
}

impl AppToolGrant {
    /// The wire object. `grantId` is upper-case like every other id on a
    /// mention job payload.
    pub fn to_json(&self) -> Value {
        json!({
            "grantId": self.grant_id.to_string().to_uppercase(),
            "pluginId": self.plugin_id,
            "scope": self.scope,
            "tools": self.tools,
        })
    }
}

/// The member's live app consents, grouped by grant. See the module docs for
/// what "live" means; this is the only place the list is built.
pub async fn load_app_tool_grants_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    delegated_member_id: Uuid,
) -> Result<Vec<AppToolGrant>, DbError> {
    let rows = sqlx::query(
        "SELECT pg.id AS grant_id, pg.plugin_id, pg.scope, \
                array_agg(pcp.tool_name ORDER BY pcp.tool_name) AS tools \
           FROM plugin_grant pg \
           JOIN member m \
             ON m.workspace_id = pg.workspace_id \
            AND m.id = pg.member_id \
            AND m.kind = 'human' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
           JOIN workspace_plugin_install wpi \
             ON wpi.workspace_id = pg.workspace_id \
            AND wpi.plugin_id = pg.plugin_id \
            AND wpi.enabled \
            AND wpi.revoked_at IS NULL \
           JOIN plugin_registry pr \
             ON pr.plugin_id = pg.plugin_id \
            AND pr.official \
            AND pr.revoked_at IS NULL \
           JOIN plugin_capability_projection pcp \
             ON pcp.grant_id = pg.id \
            AND pcp.workspace_id = pg.workspace_id \
            AND pcp.member_id = pg.member_id \
            AND pcp.plugin_id = pg.plugin_id \
            AND pcp.scope = pg.scope \
          WHERE pg.workspace_id = $1 \
            AND pg.member_id = $2 \
            AND pg.status = 'active' \
            AND pg.revoked_at IS NULL \
          GROUP BY pg.id, pg.plugin_id, pg.scope \
          ORDER BY pg.plugin_id, pg.scope",
    )
    .bind(workspace_id)
    .bind(delegated_member_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(AppToolGrant {
                grant_id: row.try_get("grant_id").map_err(DbError::from)?,
                plugin_id: row.try_get("plugin_id").map_err(DbError::from)?,
                scope: row.try_get("scope").map_err(DbError::from)?,
                tools: row.try_get("tools").map_err(DbError::from)?,
            })
        })
        .collect()
}

/// Write the evidence onto a job payload. Called only for an agent that has
/// apps attached (`agent.connector_owner_human_id`): an ordinary agent's job
/// carries no key at all, so a person's consents are not copied into jobs that
/// can never use them. An empty list is still written — "evaluated, none" is
/// different from "an old server never looked".
pub fn attach_tool_grants(payload: &mut Value, grants: &[AppToolGrant]) {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            TOOL_GRANTS_KEY.to_string(),
            Value::Array(grants.iter().map(AppToolGrant::to_json).collect()),
        );
    }
}

/// Decode a job's E5 list. Absent, `null`, a non-array, and entries missing a
/// field or of the wrong type all decode to nothing — a host must never
/// invent a grant from a malformed one.
pub fn granted_apps_from_payload(payload: &Value) -> Vec<(String, String, Vec<String>)> {
    payload
        .get(TOOL_GRANTS_KEY)
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let object = entry.as_object()?;
                    object.get("grantId")?.as_str()?;
                    let plugin = object.get("pluginId")?.as_str()?.to_string();
                    let scope = object.get("scope")?.as_str()?.to_string();
                    let tools = object
                        .get("tools")?
                        .as_array()?
                        .iter()
                        .filter_map(|tool| tool.as_str().map(str::to_string))
                        .collect();
                    Some((plugin, scope, tools))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The contract a host applies (ADR-0113 증보 2 E5): of the app tools in its
/// own signed bundle (`(pluginId, toolName)`), load only those the job's
/// `tool_grants` also names under the same app. The server can narrow the
/// bundle, never widen it, and a job with no `tool_grants` loads **zero**.
pub fn host_app_tools(bundle: &[(String, String)], payload: &Value) -> Vec<(String, String)> {
    let granted = granted_apps_from_payload(payload);
    bundle
        .iter()
        .filter(|(plugin, tool)| {
            granted.iter().any(|(granted_plugin, _scope, tools)| {
                granted_plugin == plugin && tools.iter().any(|name| name == tool)
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(plugin: &str, scope: &str, tools: &[&str]) -> AppToolGrant {
        AppToolGrant {
            grant_id: Uuid::from_u128(0xabc),
            plugin_id: plugin.to_string(),
            scope: scope.to_string(),
            tools: tools.iter().map(|tool| (*tool).to_string()).collect(),
        }
    }

    fn bundle() -> Vec<(String, String)> {
        [
            ("github", "search_issues"),
            ("github", "create_issue"),
            ("drive", "read_file"),
        ]
        .iter()
        .map(|(plugin, tool)| ((*plugin).to_string(), (*tool).to_string()))
        .collect()
    }

    #[test]
    fn an_entry_is_exactly_the_four_documented_keys() {
        let value = grant("github", "github:read", &["search_issues"]).to_json();
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["grantId", "pluginId", "scope", "tools"]);
        assert_eq!(value["grantId"], "00000000-0000-0000-0000-000000000ABC");
    }

    #[test]
    fn a_job_without_tool_grants_loads_zero_app_tools() {
        // The old-server / old-host contract (수용 5). A bundle of three tools
        // yields none when the key is absent, null, or not an array.
        for payload in [
            json!({"run_id": "R"}),
            json!({"tool_grants": null}),
            json!({"tool_grants": "github"}),
            json!({"tool_grants": {"pluginId": "github"}}),
        ] {
            assert!(
                host_app_tools(&bundle(), &payload).is_empty(),
                "{payload} must load no app tool"
            );
        }
    }

    #[test]
    fn the_host_loads_the_intersection_and_the_server_cannot_widen_it() {
        let mut payload = json!({});
        attach_tool_grants(
            &mut payload,
            &[
                grant("github", "github:read", &["search_issues", "not_in_bundle"]),
                // Names a bundle tool of ANOTHER app: must not leak across apps.
                grant("slack", "slack:read", &["read_file"]),
            ],
        );
        assert_eq!(
            host_app_tools(&bundle(), &payload),
            vec![("github".to_string(), "search_issues".to_string())]
        );
    }

    #[test]
    fn an_empty_list_is_written_and_loads_nothing() {
        let mut payload = json!({});
        attach_tool_grants(&mut payload, &[]);
        assert_eq!(payload["tool_grants"], json!([]));
        assert!(host_app_tools(&bundle(), &payload).is_empty());
    }

    #[test]
    fn a_malformed_entry_grants_nothing() {
        let payload = json!({"tool_grants": [
            {"pluginId": "github", "scope": "github:read", "tools": ["search_issues"]},
            {"grantId": "G", "pluginId": "github", "scope": "github:read", "tools": "search_issues"},
            {"grantId": "G", "pluginId": 7, "scope": "github:read", "tools": ["search_issues"]},
            "github",
        ]});
        assert!(host_app_tools(&bundle(), &payload).is_empty());
    }

    #[test]
    fn the_worker_gate_ignores_an_app_entry_so_it_stays_fail_closed() {
        // The same key carries the oort worker's per-tool projection. An E5
        // entry has no `tool_name`: the decoder must drop it, so no tool is
        // ever exempted from approval by an app consent.
        let mut payload = json!({});
        attach_tool_grants(
            &mut payload,
            &[grant("github", "github:read", &["search_issues"])],
        );
        let decoded = crate::tool_grants_from_payload(&payload).expect("array decodes");
        assert!(decoded.is_empty(), "E5 entries are not G6 grants");
        assert_eq!(
            crate::tools::approval_reason("search_issues", Some(&decoded)),
            crate::tools::ApprovalReason::GrantMissingOrAmbiguous
        );
    }
}
