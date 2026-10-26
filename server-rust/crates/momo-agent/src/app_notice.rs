//! `message.props.app_notice` and the 「쓴 앱」 marker on an answer — the server's
//! side of the wire #4052 (#3950) fixed on the client (ADR-0113 증보 2 E8·E10,
//! #4054).
//!
//! ```text
//! message.props.app_notice = {
//!   kind: "site_off" | "site_silent" | "login_lost" | "grant_revoked"
//!       | "rate_limited" | "egress_blocked" | "not_allowed",
//!   plugin_id?: string,     // the blocked app (a registry id, never a name)
//!   site?: "mac" | "hermes",// where it ran — authored by the SERVER, see below
//!   host?: string,          // egress_blocked only: the refused host name
//! }
//! message.props.appsUsed = [ { pluginId, tool, calls }, … ]   // present only when reported
//! message.props.requestedApps = [ "<pluginId>", … ]           // a PERSON's message only
//! ```
//!
//! ## Who may say what
//!
//! * **All three keys are server-owned.** A caller-supplied props map (REST send,
//!   webhook) has them stripped ([`SERVER_OWNED_APP_PROPS_KEYS`]); only the
//!   completion transaction and the two sweeps write `app_notice` / `appsUsed`,
//!   and only the REST send writes `requestedApps` — from its validated `apps`
//!   field, never from the props map. A person or an agent that could write
//!   `app_notice` could put a sentence under another agent's name, one that could
//!   write `appsUsed` could print a receipt for work that never ran, and one that
//!   could write `requestedApps` could draw 「요청한 앱」 chips under a message
//!   that never asked for them — the same forged-claim case the other
//!   server-owned keys guard.
//! * **`requestedApps` is a marker, not a grant** (ADR-0113 증보 3 F5, #4313). It
//!   says which apps the *requester picked* in the composer. No delivery gate and
//!   no `tool_grants` computation reads it (a static guard test pins that), so a
//!   message carrying it is delivered, refused and granted exactly like the same
//!   message without it.
//! * **`site` is never reported.** The server knows which door a completion came
//!   through; a site that could name itself could claim to be somebody else.
//!   Hermes' REST door is `hermes`; a hosted (Agent Port) connection cannot be
//!   told to be a Mac from here, so it carries no `site` at all and the client
//!   falls back to its unnamed sentence.
//! * **The kind comes from one of two places.** `site_off` and `site_silent` are
//!   facts the *server* observes (no live connection; a lease nobody renewed),
//!   so a site can never report them. The other five are what only the
//!   execution site can know, so they arrive as the site's own report
//!   ([`AppNoticeKind::reportable`]) and are shown as such: the server checks the
//!   shape, not the truth.
//! * **`working` is not emitted.** It is a progress hint, not a blocked state.

use serde_json::{json, Map, Value};

/// `message.props.app_notice`.
pub const PROP_APP_NOTICE: &str = "app_notice";
/// `message.props.appsUsed` — the validated 「쓴 앱」 report of the run that wrote
/// the answer, the same array `agent_run.appsUsed` carries.
pub const PROP_APPS_USED: &str = "appsUsed";
/// The snake spelling the client also reads as an alias; stripped as well so a
/// forged value cannot ride under the spelling the server does not write.
pub const PROP_APPS_USED_ALIAS: &str = "apps_used";

/// `message.props.requestedApps` — the apps the requester picked in the composer
/// (ADR-0113 증보 3 F5, #4313): a JSON array of distinct official plugin ids, at
/// most [`MAX_REQUESTED_APPS`]. Written by the REST send from the validated
/// `apps` request field; a **marker** for the clients' logo chips, never read by
/// delivery or by `tool_grants`.
pub const PROP_REQUESTED_APPS: &str = "requestedApps";
/// The most apps one message may request (ADR-0113 증보 3 F5), after de-duplication.
pub const MAX_REQUESTED_APPS: usize = 3;
/// The longest `apps` list a send request may carry **as received**, repeats included. The limit
/// above counts distinct ids, so the server has to de-duplicate before it can count - and a list of
/// any length is work a single request could multiply (#4313 review r1 H1: tens of thousands of ids
/// held a worker for seconds). Past this bound the request is refused, with the same coded 400 as any
/// other `apps` refusal, before the list is normalised and before a connection is taken. Chips are
/// distinct and at most three, so no client sends more than a handful; the room above three is for a
/// retrying client that repeats itself.
pub const MAX_REQUESTED_APPS_INPUT: usize = 16;
// A ceiling over the distinct limit, never below it - checked when the crate compiles.
const _: () = assert!(MAX_REQUESTED_APPS_INPUT > MAX_REQUESTED_APPS);

/// Every props key this module owns. A caller-supplied props map loses these.
pub const SERVER_OWNED_APP_PROPS_KEYS: [&str; 4] = [
    PROP_APP_NOTICE,
    PROP_APPS_USED,
    PROP_APPS_USED_ALIAS,
    PROP_REQUESTED_APPS,
];

/// The job-payload key carrying the 「요약만」 instruction (ADR-0113 증보 2 E10).
pub const APP_RESULT_POLICY_KEY: &str = "app_result_policy";

/// Longest `host` the notice carries (a DNS name).
pub const MAX_NOTICE_HOST_BYTES: usize = 253;

/// The closed set of blocked states. `working` is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppNoticeKind {
    SiteOff,
    SiteSilent,
    LoginLost,
    GrantRevoked,
    RateLimited,
    EgressBlocked,
    NotAllowed,
}

impl AppNoticeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SiteOff => "site_off",
            Self::SiteSilent => "site_silent",
            Self::LoginLost => "login_lost",
            Self::GrantRevoked => "grant_revoked",
            Self::RateLimited => "rate_limited",
            Self::EgressBlocked => "egress_blocked",
            Self::NotAllowed => "not_allowed",
        }
    }

    /// The kinds an execution site may *report*. `site_off` / `site_silent` are
    /// server observations and are refused here, as is anything unknown.
    pub fn reportable(wire: &str) -> Option<Self> {
        match wire {
            "login_lost" => Some(Self::LoginLost),
            "grant_revoked" => Some(Self::GrantRevoked),
            "rate_limited" => Some(Self::RateLimited),
            "egress_blocked" => Some(Self::EgressBlocked),
            "not_allowed" => Some(Self::NotAllowed),
            _ => None,
        }
    }
}

/// Where the work ran, as the **server** knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppNoticeSite {
    Mac,
    Hermes,
}

impl AppNoticeSite {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mac => "mac",
            Self::Hermes => "hermes",
        }
    }
}

/// One notice, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppNotice {
    pub kind: AppNoticeKind,
    pub plugin_id: Option<String>,
    pub site: Option<AppNoticeSite>,
    pub host: Option<String>,
}

impl AppNotice {
    /// A notice with a kind and nothing else — what a server observation says.
    pub fn bare(kind: AppNoticeKind) -> Self {
        Self {
            kind,
            plugin_id: None,
            site: None,
            host: None,
        }
    }

    /// The wire object. Absent fields are absent keys (the client reads "not
    /// there" as "do not guess").
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".into(), json!(self.kind.as_str()));
        if let Some(plugin_id) = &self.plugin_id {
            object.insert("plugin_id".into(), json!(plugin_id));
        }
        if let Some(site) = self.site {
            object.insert("site".into(), json!(site.as_str()));
        }
        if let Some(host) = &self.host {
            object.insert("host".into(), json!(host));
        }
        Value::Object(object)
    }
}

/// `host` as a bare lowercase DNS **name**: at least two dot-joined labels of
/// `[a-z0-9-]`, a top label that contains a letter (so a dotted-quad IP is not a name),
/// no scheme, port, path, userinfo or whitespace. The client only *shows* a host its app
/// list already knows, so this bounds the shape, not the meaning.
pub fn is_notice_host(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_NOTICE_HOST_BYTES {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let well_formed = labels.iter().all(|label| {
        let b = label.as_bytes();
        !b.is_empty()
            && b.len() <= 63
            && b[0] != b'-'
            && b[b.len() - 1] != b'-'
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    });
    well_formed
        && labels
            .last()
            .is_some_and(|top| top.bytes().any(|c| c.is_ascii_lowercase()))
}

/// The notice on the line a stalled hosted run ends with, when the agent has apps
/// attached (an agent without apps keeps its line as it was: this key is the *apps*
/// surface and says nothing about it). `code` is the stall's closed code:
///
/// * `lease_abandoned` — a lease nobody renewed: the site went quiet, `site_silent`;
/// * `unclaimed_expired` — a job no site took for a day: no site was there to answer,
///   `site_off`.
///
/// * `woken_not_collected` (ADR-0200 증보 3 E3) — the doorbell reached the site and it
///   did not take the job: it is up and silent, `site_silent`. `site_off` ("no site
///   there") would be false.
///
/// All are the SERVER's observation. None names a `site`: a hosted connection is
/// not known to be a Mac or Hermes.
pub fn stall_app_notice(code: &str, agent_has_apps: bool) -> Option<AppNotice> {
    if !agent_has_apps {
        return None;
    }
    match code {
        "lease_abandoned" => Some(AppNotice::bare(AppNoticeKind::SiteSilent)),
        "unclaimed_expired" => Some(AppNotice::bare(AppNoticeKind::SiteOff)),
        "woken_not_collected" => Some(AppNotice::bare(AppNoticeKind::SiteSilent)),
        _ => None,
    }
}

/// The notice on the 「연결이 없어 전달하지 못했어요」 line of a mention a hosted
/// agent with apps attached could not be handed.
pub fn connection_unavailable_app_notice(agent_has_apps: bool) -> Option<AppNotice> {
    agent_has_apps.then(|| AppNotice::bare(AppNoticeKind::SiteOff))
}

// ---------------------------------------------------------------------------
// E10 — 「요약만」 on the job
// ---------------------------------------------------------------------------

/// Apps whose results are a person's own data read with that person's token
/// (ADR-0113 증보 2 E10). The same three ids the clients' 「요약만」 line is keyed
/// on; a result of any other app is not asked to be summarized.
pub const PERSONAL_APP_PLUGIN_IDS: [&str; 3] = ["gmail", "google-calendar", "google-drive"];

/// The fixed sentence the execution site is handed. Server-authored, nothing in
/// it is user-controlled.
pub const SUMMARY_ONLY_INSTRUCTION: &str =
    "채널에 올리는 답은 요약만 쓰고, 개인 앱에서 읽은 본문을 그대로 인용하지 마세요.";

/// The instruction a job carries when its granted apps include a personal one:
/// `{ "channel_reply": "summary_only", "plugin_ids": [...], "instruction": "..." }`.
/// `None` (the key is left off) when no personal app is granted.
///
/// **Not enforcement.** It rides on a self-reporting execution site and oort
/// cannot check that the answer obeys it (E10); the screens say so.
pub fn app_result_policy<'a>(
    granted_plugin_ids: impl IntoIterator<Item = &'a str>,
) -> Option<Value> {
    let mut personal: Vec<&str> = Vec::new();
    for id in granted_plugin_ids {
        if PERSONAL_APP_PLUGIN_IDS.contains(&id) && !personal.contains(&id) {
            personal.push(id);
        }
    }
    if personal.is_empty() {
        return None;
    }
    personal.sort_unstable();
    Some(json!({
        "channel_reply": "summary_only",
        "plugin_ids": personal,
        "instruction": SUMMARY_ONLY_INSTRUCTION,
    }))
}

/// Write the instruction onto a job payload (no-op when there is none).
pub fn attach_app_result_policy(payload: &mut Value, policy: Option<Value>) {
    if let (Some(policy), Some(object)) = (policy, payload.as_object_mut()) {
        object.insert(APP_RESULT_POLICY_KEY.to_string(), policy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_five_site_facts_can_be_reported() {
        for wire in [
            "login_lost",
            "grant_revoked",
            "rate_limited",
            "egress_blocked",
            "not_allowed",
        ] {
            assert_eq!(
                AppNoticeKind::reportable(wire).map(AppNoticeKind::as_str),
                Some(wire)
            );
        }
        // Server observations and the progress hint cannot be reported.
        for wire in [
            "site_off",
            "site_silent",
            "working",
            "",
            "LOGIN_LOST",
            "boom",
        ] {
            assert_eq!(AppNoticeKind::reportable(wire), None, "{wire}");
        }
    }

    #[test]
    fn the_wire_object_omits_what_it_does_not_know() {
        assert_eq!(
            AppNotice::bare(AppNoticeKind::SiteSilent).to_json(),
            json!({"kind": "site_silent"})
        );
        let full = AppNotice {
            kind: AppNoticeKind::EgressBlocked,
            plugin_id: Some("github".into()),
            site: Some(AppNoticeSite::Hermes),
            host: Some("api.github.com".into()),
        };
        assert_eq!(
            full.to_json(),
            json!({"kind": "egress_blocked", "plugin_id": "github", "site": "hermes", "host": "api.github.com"})
        );
    }

    #[test]
    fn a_host_is_a_bare_lowercase_name() {
        for ok in ["api.github.com", "gmailmcp.googleapis.com", "x-1.y", "a.b"] {
            assert!(is_notice_host(ok), "{ok}");
        }
        for bad in [
            "",
            "https://a.com",
            "a.com/path",
            "a.com:443",
            "user@a.com",
            "A.com",
            "a..com",
            "-a.com",
            "a-.com",
            "a b.com",
            ".a.com",
            "a.com.",
            // a single label and a dotted-quad IP are not names
            "localhost",
            "10.0.0.1",
            "192.168.1.1",
        ] {
            assert!(!is_notice_host(bad), "{bad}");
        }
        assert!(!is_notice_host(&"a".repeat(MAX_NOTICE_HOST_BYTES + 1)));
    }

    #[test]
    fn the_sweeps_say_site_facts_only_for_an_agent_with_apps() {
        assert_eq!(
            stall_app_notice("lease_abandoned", true),
            Some(AppNotice::bare(AppNoticeKind::SiteSilent))
        );
        assert_eq!(stall_app_notice("lease_abandoned", false), None);
        // A job nobody took for a day is no site there to answer, not a quiet one.
        assert_eq!(
            stall_app_notice("unclaimed_expired", true),
            Some(AppNotice::bare(AppNoticeKind::SiteOff))
        );
        assert_eq!(stall_app_notice("unclaimed_expired", false), None);
        // the bell reached the site and it took nothing: silent, NOT "off"
        assert_eq!(
            stall_app_notice("woken_not_collected", true),
            Some(AppNotice::bare(AppNoticeKind::SiteSilent))
        );
        assert_eq!(stall_app_notice("woken_not_collected", false), None);
        assert_eq!(stall_app_notice("something_else", true), None);
        assert_eq!(
            connection_unavailable_app_notice(true),
            Some(AppNotice::bare(AppNoticeKind::SiteOff))
        );
        assert_eq!(connection_unavailable_app_notice(false), None);
    }

    #[test]
    fn a_personal_app_grant_carries_the_summary_only_instruction() {
        let policy = app_result_policy(["github", "gmail", "gmail", "google-drive"]).unwrap();
        assert_eq!(policy["channel_reply"], json!("summary_only"));
        assert_eq!(policy["plugin_ids"], json!(["gmail", "google-drive"]));
        assert_eq!(policy["instruction"], json!(SUMMARY_ONLY_INSTRUCTION));
        // No personal app, no instruction: nothing is asked of a GitHub-only job.
        assert_eq!(app_result_policy(["github", "drive"]), None);
        assert_eq!(app_result_policy([]), None);

        let mut payload = json!({"tool_grants": []});
        attach_app_result_policy(&mut payload, None);
        assert!(payload.get(APP_RESULT_POLICY_KEY).is_none());
        attach_app_result_policy(&mut payload, Some(policy));
        assert!(payload.get(APP_RESULT_POLICY_KEY).is_some());
    }

    #[test]
    fn the_owned_keys_name_both_spellings_of_the_receipt() {
        assert!(SERVER_OWNED_APP_PROPS_KEYS.contains(&"appsUsed"));
        assert!(SERVER_OWNED_APP_PROPS_KEYS.contains(&"apps_used"));
        assert!(SERVER_OWNED_APP_PROPS_KEYS.contains(&"app_notice"));
    }

    /// ADR-0113 증보 3 F5 (#4313): the requested-apps marker is on the one list the send, the webhook
    /// ingress and the gateway read, under exactly the spelling the clients parse. A key missing from this
    /// list is a key a caller can forge, so the list is also pinned as a set (a fifth entry is a decision).
    #[test]
    fn the_requested_apps_marker_is_a_server_owned_key() {
        assert_eq!(PROP_REQUESTED_APPS, "requestedApps");
        assert!(SERVER_OWNED_APP_PROPS_KEYS.contains(&PROP_REQUESTED_APPS));
        let mut keys: Vec<&str> = SERVER_OWNED_APP_PROPS_KEYS.to_vec();
        keys.sort_unstable();
        let mut expected = vec!["app_notice", "appsUsed", "apps_used", "requestedApps"];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(MAX_REQUESTED_APPS, 3);
        // The input bound (a compile-time `const _` asserts it stays above the distinct limit).
        assert_eq!(MAX_REQUESTED_APPS_INPUT, 16);
    }
}
