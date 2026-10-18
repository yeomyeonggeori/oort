//! 「커넥터 시험」 — a co-hosted Hermes that reads its single human's apps
//! (#3948 K-S2, ADR-0203 증보 2026-10-16 K2·K4, ADR-0113 증보 2 E3·E5).
//!
//! The mark itself is #3938's `agent.connector_owner_human_id`. What this module
//! adds is the **trial** layer on top of it: an agent that is pinned to the
//! operator's own link (`agent_provider_pin.kind = 'operator_env'`, i.e. the
//! co-hosted Hermes) and carries the mark runs **one person's** apps on a runtime
//! that has no per-person token isolation (ADR-0203 K1). So at every delivery the
//! server re-measures three things, none of them remembered from the moment the
//! trial was turned on:
//!
//! 1. the operator's two attestations are still in the environment,
//! 2. the workspace still has **exactly one** active human member,
//! 3. every app the operator says is switched on in Hermes is still in the
//!    owner's active grants (an enabled install and an active grant).
//!
//! The decision is a pure function over facts the candidate query already
//! carries ([`ConnectorTrialFacts`]) and the attestation the server holds
//! ([`ConnectorTrialAttest`]), the same shape as `owner_only_gate`: it has no
//! database and no environment, which is what lets a test flip each input alone
//! and count the rows that result.
//!
//! **An attestation is the operator's own statement, not oort's verification.**
//! The server cannot see Hermes's tools, its `mcp_servers` or its token volume.
//! Every sentence this module produces or documents says so.

use sqlx::PgConnection;
use uuid::Uuid;

use momo_db::DbError;

/// `OORT_COHOSTED_AGENT_TOOLS_LOCKED` (ADR-0203 D6-5): the operator followed the
/// tool-lock checklist.
pub const ENV_TOOLS_LOCKED: &str = "OORT_COHOSTED_AGENT_TOOLS_LOCKED";
/// `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED` (K4): the operator followed the
/// connector checklist (`trust: untrusted`, `sampling` off, `tools.include`
/// allow-list, no write tools).
pub const ENV_CONNECTORS_LOCKED: &str = "OORT_COHOSTED_AGENT_CONNECTORS_LOCKED";
/// `OORT_COHOSTED_AGENT_CONNECTOR_APPS` (K4): the app ids the operator switched
/// on in Hermes, comma separated.
pub const ENV_CONNECTOR_APPS: &str = "OORT_COHOSTED_AGENT_CONNECTOR_APPS";

/// What the operator declared about Hermes's connectors. Built from the server's
/// environment; held by the server, never stored in the database.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectorTrialAttest {
    /// The D6 tool-lock attestation.
    pub tools_locked: bool,
    /// The K4 connector attestation.
    pub connectors_locked: bool,
    /// The app ids switched on in Hermes. Empty when the list was not given or
    /// any entry was malformed (a half-read list is never trusted).
    pub apps: Vec<String>,
}

impl ConnectorTrialAttest {
    /// Read the three variables through `env` (so a test needs no process
    /// environment). A variable counts as set for `1` / `true` / `yes` / `on`.
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Self {
        let truthy = |name: &str| {
            matches!(
                env(name)
                    .map(|value| value.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1") | Some("true") | Some("yes") | Some("on")
            )
        };
        ConnectorTrialAttest {
            tools_locked: truthy(ENV_TOOLS_LOCKED),
            connectors_locked: truthy(ENV_CONNECTORS_LOCKED),
            apps: env(ENV_CONNECTOR_APPS)
                .and_then(|raw| parse_connector_apps(&raw))
                .unwrap_or_default(),
        }
    }

    /// Both attestations and at least one app. Anything less is "not attested".
    pub fn is_complete(&self) -> bool {
        self.tools_locked && self.connectors_locked && !self.apps.is_empty()
    }
}

/// `plugin_registry_id_ck` (`^[a-z0-9][a-z0-9._-]{2,127}$`) without a regex crate.
fn is_plugin_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if !(3..=128).contains(&bytes.len()) {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes[1..].iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// Split the comma list into distinct plugin ids. `None` when any entry is not a
/// plugin id: the operator's list is all-or-nothing, so one typo reads as "not
/// attested" rather than as a shorter list.
pub fn parse_connector_apps(raw: &str) -> Option<Vec<String>> {
    let mut apps: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if !is_plugin_id(part) {
            return None;
        }
        if !apps.iter().any(|existing| existing == part) {
            apps.push(part.to_string());
        }
    }
    Some(apps)
}

/// The two facts about the workspace that change without anyone touching the
/// agent. Present on a candidate exactly when the agent is a trial agent (marked
/// and pinned to the operator's env link).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorTrialFacts {
    /// `member.kind = 'human'`, `status = 'active'`, not deleted — counted live,
    /// whatever path added the member (invite, admin add, a direct row).
    pub active_humans: i64,
    /// The owner's active grants whose install is enabled and not revoked.
    pub granted_apps: Vec<String>,
}

/// Why a trial agent is not delivered to right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorTrialStop {
    /// An attestation (or the app list) is no longer in the server's environment.
    Attest,
    /// The workspace does not have exactly one active human.
    Members,
    /// An app the operator switched on in Hermes is no longer in the owner's
    /// active grants.
    Apps,
}

impl ConnectorTrialStop {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attest => "attest",
            Self::Members => "members",
            Self::Apps => "apps",
        }
    }

    /// The `agent.mention.skipped` / `agent.thread_wake.skipped` audit reason.
    pub fn skip_reason(self) -> &'static str {
        match self {
            Self::Attest => "connector_trial_attest",
            Self::Members => "connector_trial_members",
            Self::Apps => "connector_trial_apps",
        }
    }
}

/// The apps the operator switched on that the owner no longer has an active
/// grant for, in the operator's order.
pub fn ungranted_apps(attest: &ConnectorTrialAttest, granted: &[String]) -> Vec<String> {
    attest
        .apps
        .iter()
        .filter(|app| !granted.iter().any(|g| g == *app))
        .cloned()
        .collect()
}

/// The pure delivery decision. `None` = nothing here stops the delivery (also the
/// answer for an agent that is not a trial agent: `facts` is `None`).
///
/// The order is the order of cheapness to repair: attestations (an env line),
/// then people (cannot be repaired by the operator alone), then grants.
pub fn connector_trial_stop(
    facts: Option<&ConnectorTrialFacts>,
    attest: &ConnectorTrialAttest,
) -> Option<ConnectorTrialStop> {
    let facts = facts?;
    if !attest.is_complete() {
        return Some(ConnectorTrialStop::Attest);
    }
    if facts.active_humans != 1 {
        return Some(ConnectorTrialStop::Members);
    }
    if !ungranted_apps(attest, &facts.granted_apps).is_empty() {
        return Some(ConnectorTrialStop::Apps);
    }
    None
}

/// Said to the owner, in the agent's name, when the workspace grew (K2-3). The
/// sentence is the ADR's, word for word.
pub const NOTICE_MEMBERS: &str = "워크스페이스에 사람이 늘어서 Hermes 앱 시험을 멈췄어요. Hermes의 앱 연결을 지우거나, 사람별 분리가 생길 때까지 기다려 주세요.";
/// Said when an app the operator switched on lost the owner's grant (ADR-0113
/// 증보 2 E5's sentence, with the operator's way out).
pub const NOTICE_APPS: &str = "실행 중에 허용이 회수돼서 Hermes 앱 시험을 멈췄어요. 허용을 되돌리거나, Hermes에서 그 앱 연결을 지워 주세요.";
/// Said when an attestation is missing from the server's environment.
pub const NOTICE_ATTEST: &str = "서버에 앱 시험 선언이 없어서 Hermes 앱 시험을 멈췄어요. 운영자가 체크리스트를 다시 확인하고 선언을 넣어 주세요.";

/// The sentence for `stop`.
pub fn connector_trial_notice_body(stop: ConnectorTrialStop) -> &'static str {
    match stop {
        ConnectorTrialStop::Attest => NOTICE_ATTEST,
        ConnectorTrialStop::Members => NOTICE_MEMBERS,
        ConnectorTrialStop::Apps => NOTICE_APPS,
    }
}

/// The SQL that reads [`ConnectorTrialFacts`] for the agent row aliased `a` and
/// member row aliased `m` in a query over `agent a JOIN member m`. Both fragments
/// are `NULL` unless the agent is marked **and** pinned to the operator's env
/// link, so an ordinary connector agent (a workd or hosted vendor agent) never
/// pays for, or is judged by, the trial.
pub const TRIAL_FACTS_SQL: &str = "\
  CASE WHEN a.connector_owner_human_id IS NOT NULL \
        AND EXISTS (SELECT 1 FROM agent_provider_pin pin \
                     WHERE pin.workspace_id = a.workspace_id \
                       AND pin.agent_member_id = a.member_id \
                       AND pin.kind = 'operator_env') \
       THEN (SELECT count(*) FROM member h \
              WHERE h.workspace_id = a.workspace_id AND h.kind = 'human' \
                AND h.status = 'active' AND h.deleted_at IS NULL) END \
    AS connector_trial_active_humans, \
  CASE WHEN a.connector_owner_human_id IS NOT NULL \
        AND EXISTS (SELECT 1 FROM agent_provider_pin pin \
                     WHERE pin.workspace_id = a.workspace_id \
                       AND pin.agent_member_id = a.member_id \
                       AND pin.kind = 'operator_env') \
       THEN COALESCE((SELECT array_agg(DISTINCT pg.plugin_id) \
                        FROM plugin_grant pg \
                        JOIN workspace_plugin_install wpi \
                          ON wpi.workspace_id = pg.workspace_id AND wpi.plugin_id = pg.plugin_id \
                         AND wpi.enabled AND wpi.revoked_at IS NULL \
                       WHERE pg.workspace_id = a.workspace_id \
                         AND pg.member_id = a.connector_owner_human_id \
                         AND pg.status = 'active' AND pg.revoked_at IS NULL), \
                     ARRAY[]::text[]) END \
    AS connector_trial_granted_apps";

/// The facts for one agent (the work-request route and the enable route hold only
/// an agent id). `None` = not a trial agent: unmarked, or not pinned to the
/// operator's env link.
pub async fn connector_trial_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<ConnectorTrialFacts>, DbError> {
    let row: Option<(Option<i64>, Option<Vec<String>>)> = sqlx::query_as(&format!(
        "SELECT {TRIAL_FACTS_SQL} FROM agent a WHERE a.workspace_id = $1 AND a.member_id = $2"
    ))
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(|(humans, granted)| {
        humans.map(|active_humans| ConnectorTrialFacts {
            active_humans,
            granted_apps: granted.unwrap_or_default(),
        })
    }))
}

/// The facts the **enable** route needs before the mark exists: it cannot read
/// them through [`connector_trial_facts_in_tx`] (that is `NULL` until the agent is
/// marked). Counts and grants for `owner`, whatever the mark says.
pub async fn trial_candidate_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
) -> Result<ConnectorTrialFacts, DbError> {
    let active_humans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member \
          WHERE workspace_id = $1 AND kind = 'human' AND status = 'active' AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    let granted_apps: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT pg.plugin_id \
           FROM plugin_grant pg \
           JOIN workspace_plugin_install wpi \
             ON wpi.workspace_id = pg.workspace_id AND wpi.plugin_id = pg.plugin_id \
            AND wpi.enabled AND wpi.revoked_at IS NULL \
          WHERE pg.workspace_id = $1 AND pg.member_id = $2 \
            AND pg.status = 'active' AND pg.revoked_at IS NULL \
          ORDER BY pg.plugin_id",
    )
    .bind(workspace_id)
    .bind(owner_member_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(ConnectorTrialFacts {
        active_humans,
        granted_apps,
    })
}

/// Is this agent pinned to the operator's own env link — the co-hosted Hermes?
pub async fn agent_is_operator_env_pinned_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    let pinned: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM agent_provider_pin \
                         WHERE workspace_id = $1 AND agent_member_id = $2 AND kind = 'operator_env')",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(pinned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attest(tools: bool, connectors: bool, apps: &[&str]) -> ConnectorTrialAttest {
        ConnectorTrialAttest {
            tools_locked: tools,
            connectors_locked: connectors,
            apps: apps.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn facts(humans: i64, granted: &[&str]) -> ConnectorTrialFacts {
        ConnectorTrialFacts {
            active_humans: humans,
            granted_apps: granted.iter().map(|a| a.to_string()).collect(),
        }
    }

    #[test]
    fn an_agent_that_is_not_a_trial_agent_is_never_stopped() {
        assert_eq!(connector_trial_stop(None, &attest(false, false, &[])), None);
    }

    #[test]
    fn each_input_alone_stops_the_trial_and_the_healthy_state_does_not() {
        let apps = ["com.momo.plugins.gmail", "com.momo.plugins.google-calendar"];
        let healthy = attest(true, true, &apps);
        let granted = facts(1, &apps);
        assert_eq!(connector_trial_stop(Some(&granted), &healthy), None);

        assert_eq!(
            connector_trial_stop(Some(&facts(2, &apps)), &healthy),
            Some(ConnectorTrialStop::Members),
            "a second person stops it"
        );
        assert_eq!(
            connector_trial_stop(Some(&facts(0, &apps)), &healthy),
            Some(ConnectorTrialStop::Members),
            "no active person is not 'exactly one' either"
        );
        for broken in [
            attest(false, true, &apps),
            attest(true, false, &apps),
            attest(true, true, &[]),
        ] {
            assert_eq!(
                connector_trial_stop(Some(&granted), &broken),
                Some(ConnectorTrialStop::Attest)
            );
        }
        assert_eq!(
            connector_trial_stop(Some(&facts(1, &apps[..1])), &healthy),
            Some(ConnectorTrialStop::Apps),
            "an app still on in Hermes whose grant was revoked"
        );
    }

    #[test]
    fn a_grant_the_operator_did_not_switch_on_does_not_matter() {
        let healthy = attest(true, true, &["com.momo.plugins.gmail"]);
        let extra = facts(1, &["com.momo.plugins.gmail", "com.momo.plugins.github"]);
        assert_eq!(connector_trial_stop(Some(&extra), &healthy), None);
    }

    #[test]
    fn the_app_list_is_all_or_nothing() {
        assert_eq!(
            parse_connector_apps(" com.momo.plugins.gmail , com.momo.plugins.gmail,,x "),
            None,
            "one malformed entry voids the list"
        );
        assert_eq!(
            parse_connector_apps("com.momo.plugins.gmail, com.momo.plugins.google-calendar"),
            Some(vec![
                "com.momo.plugins.gmail".to_string(),
                "com.momo.plugins.google-calendar".to_string()
            ])
        );
        assert_eq!(parse_connector_apps(" , "), Some(vec![]));
        let env = |name: &str| match name {
            ENV_TOOLS_LOCKED | ENV_CONNECTORS_LOCKED => Some("1".to_string()),
            ENV_CONNECTOR_APPS => Some("com.momo.plugins.gmail,BAD ID".to_string()),
            _ => None,
        };
        let read = ConnectorTrialAttest::from_env(env);
        assert!(read.tools_locked && read.connectors_locked);
        assert!(read.apps.is_empty() && !read.is_complete());
    }

    #[test]
    fn the_stop_sentences_are_the_adrs() {
        assert!(connector_trial_notice_body(ConnectorTrialStop::Members)
            .starts_with("워크스페이스에 사람이 늘어서 Hermes 앱 시험을 멈췄어요."));
        assert!(connector_trial_notice_body(ConnectorTrialStop::Members)
            .ends_with("사람별 분리가 생길 때까지 기다려 주세요."));
    }
}
