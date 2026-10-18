//! 「막힘」 notice — the reported half of `message.props.app_notice`
//! (ADR-0113 증보 2 E8, #4054). The wire and who-may-say-what live in
//! [`momo_agent::app_notice`]; this file validates what an execution site
//! *reports* on completion, next to [`crate::routes::apps_used`].
//!
//! ```text
//! appNotice: { "kind": "login_lost" | "grant_revoked" | "rate_limited"
//!                    | "egress_blocked" | "not_allowed",
//!              "pluginId"?: "gmail", "host"?: "api.example.com" }
//! ```
//!
//! * **A self-report.** The server checks the shape, not the truth, and the
//!   screen labels the sentence as the site's (it never calls it a measurement).
//! * **Closed.** An unknown key, an unknown or server-only kind (`site_off`,
//!   `site_silent`), a malformed `pluginId`, a `host` that is not a bare DNS
//!   name, or a `host` on any kind but `egress_blocked` refuses the **whole**
//!   notice. There is no key for free text, so no sentence rides along.
//! * **`site` is not a key.** The server adds it from the door the completion
//!   came through ([`AppNoticeSite`]); a site that could name itself could claim
//!   to be somebody else.
//! * **Same asymmetry as `appsUsed`.** The Agent Port refuses a malformed notice
//!   (the agent can fix its call); the Hermes REST door drops it (telemetry must
//!   not cost the answer).

use momo_agent::{is_notice_host, AppNotice, AppNoticeKind, AppNoticeSite};
use serde_json::Value;

use crate::plugin_manifest::is_plugin_id;

/// The only keys a reported notice has.
pub(crate) const REPORT_KEYS: [&str; 3] = ["kind", "pluginId", "host"];

/// The one refusal. It names no field and carries no value the sender sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AppNoticeRefused;

/// A reported notice, or `Ok(None)` for an absent / `null` one. `site` is the
/// server's own knowledge of the door; `None` when it cannot tell.
pub(crate) fn validated_app_notice(
    raw: Option<&Value>,
    site: Option<AppNoticeSite>,
) -> Result<Option<AppNotice>, AppNoticeRefused> {
    let object = match raw {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => return Err(AppNoticeRefused),
    };
    if object
        .keys()
        .any(|key| !REPORT_KEYS.contains(&key.as_str()))
    {
        return Err(AppNoticeRefused);
    }
    let kind = match object.get("kind") {
        Some(Value::String(wire)) => AppNoticeKind::reportable(wire).ok_or(AppNoticeRefused)?,
        _ => return Err(AppNoticeRefused),
    };
    let plugin_id = match object.get("pluginId") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if is_plugin_id(value) => Some(value.clone()),
        _ => return Err(AppNoticeRefused),
    };
    let host = match object.get("host") {
        None | Some(Value::Null) => None,
        Some(Value::String(value))
            if kind == AppNoticeKind::EgressBlocked && is_notice_host(value) =>
        {
            Some(value.clone())
        }
        _ => return Err(AppNoticeRefused),
    };
    Ok(Some(AppNotice {
        kind,
        plugin_id,
        site,
        host,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(value: Value) -> AppNotice {
        validated_app_notice(Some(&value), Some(AppNoticeSite::Hermes))
            .expect("accepted")
            .expect("present")
    }

    #[test]
    fn absent_and_null_are_no_notice() {
        assert_eq!(validated_app_notice(None, None), Ok(None));
        assert_eq!(validated_app_notice(Some(&Value::Null), None), Ok(None));
    }

    #[test]
    fn a_report_takes_the_servers_site_never_its_own() {
        // `site` is not a key: naming one refuses the whole notice.
        for site in ["mac", "hermes", "other"] {
            assert_eq!(
                validated_app_notice(
                    Some(&json!({"kind": "login_lost", "site": site})),
                    Some(AppNoticeSite::Hermes)
                ),
                Err(AppNoticeRefused),
                "{site}"
            );
        }
        let notice = ok(json!({"kind": "login_lost", "pluginId": "gmail"}));
        assert_eq!(notice.site, Some(AppNoticeSite::Hermes));
        assert_eq!(notice.plugin_id.as_deref(), Some("gmail"));
        // A door that cannot tell where it runs leaves the key off.
        let bare = validated_app_notice(Some(&json!({"kind": "not_allowed"})), None)
            .unwrap()
            .unwrap();
        assert_eq!(bare.site, None);
        assert!(bare.to_json().get("site").is_none());
    }

    #[test]
    fn only_the_five_site_facts_are_reportable() {
        for kind in [
            "login_lost",
            "grant_revoked",
            "rate_limited",
            "egress_blocked",
            "not_allowed",
        ] {
            assert_eq!(ok(json!({"kind": kind})).kind.as_str(), kind);
        }
        for kind in ["site_off", "site_silent", "working", "", "x"] {
            assert_eq!(
                validated_app_notice(Some(&json!({"kind": kind})), None),
                Err(AppNoticeRefused),
                "{kind}"
            );
        }
    }

    #[test]
    fn the_shape_is_closed() {
        let host = |kind: &str, host: &str| json!({"kind": kind, "host": host});
        for bad in [
            json!("login_lost"),
            json!([]),
            json!({}),
            json!({"kind": 1}),
            json!({"kind": "login_lost", "sentence": "free text"}),
            json!({"kind": "login_lost", "since_ms": 1}),
            json!({"kind": "login_lost", "pluginId": "ab"}),
            json!({"kind": "login_lost", "pluginId": "Gmail!"}),
            json!({"kind": "login_lost", "pluginId": 7}),
            // `host` belongs to egress_blocked alone, and is a bare name.
            host("login_lost", "api.example.com"),
            host("egress_blocked", "https://api.example.com"),
            host("egress_blocked", "api.example.com/x"),
            host("egress_blocked", "API.example.com"),
            host("egress_blocked", ""),
            json!({"kind": "egress_blocked", "host": 5}),
        ] {
            assert_eq!(
                validated_app_notice(Some(&bad), None),
                Err(AppNoticeRefused),
                "{bad}"
            );
        }
        let egress = ok(host("egress_blocked", "gmailmcp.googleapis.com"));
        assert_eq!(egress.host.as_deref(), Some("gmailmcp.googleapis.com"));
    }

    /// The Agent Port publishes the same closed set this validator enforces, so
    /// an agent that follows the schema is never refused, and one that does not
    /// is refused by both.
    #[test]
    fn the_published_schema_and_the_validator_name_the_same_keys_and_kinds() {
        assert_eq!(momo_mcp::APP_NOTICE_KEYS, REPORT_KEYS);
        for kind in momo_mcp::APP_NOTICE_REPORTABLE_KINDS {
            assert!(AppNoticeKind::reportable(kind).is_some(), "{kind}");
        }
        let published: Vec<&str> = momo_mcp::APP_NOTICE_REPORTABLE_KINDS.to_vec();
        for kind in ["site_off", "site_silent", "working"] {
            assert!(!published.contains(&kind), "{kind} is not reportable");
        }
        assert_eq!(published.len(), 5);
    }
}
