//! GitHub App webhook ingress — the pure half (#3954 E-GH2 / ADR-0205 D4·D6).
//!
//! Three things live here, none of which touches a database:
//!
//! 1. **The signature.** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`. The
//!    HMAC runs over the **raw bytes** GitHub sent (not a canonical base like ADR-0115's native
//!    mode) and the compare is constant time. The legacy SHA-1 `X-Hub-Signature` is never read.
//! 2. **The vocabulary** of the events oort understands and the repository feature each one maps
//!    to (ADR-0205 D6). Anything outside it renders to `None`, which the receiver answers with a
//!    200 and no message.
//! 3. **The copy.** Messages are written in the third person about the GitHub login that acted
//!    (`@alice님이 PR을 열었어요`); the author the message is posted under is the workspace's
//!    dedicated 「GitHub」 member, so nothing pretends to be a person (ADR-0115 D3).
//!
//! Everything that reaches a message body from the payload is single-line, length-bounded and
//! has Markdown link delimiters neutralised, and only `https://` URLs become links.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// The GitHub-mode body ceiling (ADR-0205 D4: 초안 5 MiB; GitHub itself caps a delivery at
/// 25 MB). The measured size distribution is still `runtime-unverified`.
pub const GITHUB_MAXIMUM_BODY_BYTES: usize = 5 * 1024 * 1024;

/// `github_receipt.delivery_id` is `length BETWEEN 1 AND 100`; GitHub sends a GUID (36 chars).
pub fn valid_github_delivery_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// `HMAC-SHA256(secret, body)` as lowercase hex (no `sha256=` prefix).
pub fn github_signature(secret: &str, body: &[u8]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Does the `X-Hub-Signature-256` header value authenticate `body` under `secret`?
///
/// The header must be `sha256=` followed by the digest; any other shape (including the SHA-1
/// `sha1=` form) is a mismatch. The digest compare is constant time and its length is fixed by the
/// algorithm, so a short or long header returns `false` without comparing.
pub fn github_signature_matches(secret: &str, body: &[u8], header: &str) -> bool {
    let Some(presented) = header.strip_prefix("sha256=") else {
        return false;
    };
    let Ok(presented) = hex::decode(presented) else {
        return false;
    };
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(body);
    // `verify_slice` is the constant-time comparison.
    mac.verify_slice(&presented).is_ok()
}

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/// The repository features a channel subscription can switch on
/// (`github_channel_subscription.features`' CHECK list).
pub const GITHUB_FEATURES: [&str; 7] = [
    "pulls", "issues", "reviews", "comments", "checks", "commits", "releases",
];

/// What a new subscription turns on (ADR-0205 D6: PR and issue lifecycle; the rest is opt-in).
pub const GITHUB_DEFAULT_FEATURES: [&str; 2] = ["pulls", "issues"];

pub fn is_known_feature(value: &str) -> bool {
    GITHUB_FEATURES.contains(&value)
}

/// The `props` key whose value `"github"` marks a message as a GitHub notification line.
pub const GITHUB_SOURCE_PROP: &str = "source";
/// The value of [`GITHUB_SOURCE_PROP`] on a notification.
pub const GITHUB_SOURCE_VALUE: &str = "github";
/// Every GitHub-notification props key starts with this (`github_event`, `github_url`, ...).
pub const GITHUB_PROP_PREFIX: &str = "github_";
/// The workspace's 「GitHub」 author member id, written next to the notification so a client can
/// check that the line was authored by the system member and not by a namesake.
pub const GITHUB_AUTHOR_PROP: &str = "github_author_member_id";

/// ADR-0205 H-1 (#4084): GitHub notification props are **server-owned**. A person, an agent or an
/// external webhook sender that could write `source: "github"` or a `github_*` key could draw a
/// notification line (a link, a headline) under any author, so every door that copies
/// caller-supplied props drops the pair this returns `true` for. Only the signed receiver
/// ([`render_notification`]) writes them, through `send_message_in_tx`, never through those doors.
pub fn is_github_owned_prop(key: &str, value: &str) -> bool {
    let key = key.trim().to_ascii_lowercase();
    key.starts_with(GITHUB_PROP_PREFIX)
        || (key == GITHUB_SOURCE_PROP && value.trim().eq_ignore_ascii_case(GITHUB_SOURCE_VALUE))
}

/// One rendered notification, before it is addressed to any channel.
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    /// One of [`GITHUB_FEATURES`]; a channel receives it only if its subscription lists it.
    pub feature: &'static str,
    pub repo_id: Option<i64>,
    pub repo_full_name: String,
    pub body: String,
    /// Message `props` (source, event, action, repository, url).
    pub props: Value,
}

/// The installation an event is about (`payload.installation` + `payload.installation.account`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationInfo {
    pub id: i64,
    pub account_login: String,
    /// `User` or `Organization` (GitHub also says `Bot`; it is stored as `User`).
    pub account_type: String,
    /// `all` or `selected`.
    pub repository_selection: String,
}

/// A repository named by an installation payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryRef {
    pub id: i64,
    pub full_name: String,
    pub private: bool,
}

/// Just the installation id — present on every event the App receives.
pub fn installation_id(payload: &Value) -> Option<i64> {
    payload
        .get("installation")?
        .get("id")?
        .as_i64()
        .filter(|id| *id > 0)
}

pub fn installation_info(payload: &Value) -> Option<InstallationInfo> {
    let installation = payload.get("installation")?;
    let id = installation.get("id")?.as_i64().filter(|id| *id > 0)?;
    let account = installation.get("account")?;
    let login = account.get("login")?.as_str()?.trim();
    if login.is_empty() || login.len() > 200 {
        return None;
    }
    let account_type = match account.get("type").and_then(Value::as_str) {
        Some("Organization") => "Organization",
        _ => "User",
    };
    let repository_selection = match installation
        .get("repository_selection")
        .or_else(|| payload.get("repository_selection"))
        .and_then(Value::as_str)
    {
        Some("all") => "all",
        _ => "selected",
    };
    Some(InstallationInfo {
        id,
        account_login: login.to_string(),
        account_type: account_type.to_string(),
        repository_selection: repository_selection.to_string(),
    })
}

/// The repositories under `key` (`repositories`, `repositories_added`, `repositories_removed`).
/// Entries without an id or a name are skipped; the list is capped so a pathological payload
/// cannot fan out into an unbounded number of rows.
pub const MAX_REPOSITORIES_PER_EVENT: usize = 5000;

pub fn repositories(payload: &Value, key: &str) -> Vec<RepositoryRef> {
    let Some(list) = payload.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_i64()?;
            let full_name = entry.get("full_name")?.as_str()?.trim();
            if full_name.is_empty() || full_name.len() > 300 {
                return None;
            }
            Some(RepositoryRef {
                id,
                full_name: full_name.to_string(),
                private: entry
                    .get("private")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
        })
        .take(MAX_REPOSITORIES_PER_EVENT)
        .collect()
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

const TITLE_MAX_CHARS: usize = 120;
const QUOTE_MAX_CHARS: usize = 200;

/// Single line, bounded, no Markdown link delimiters or control characters.
fn inline_text(raw: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    let mut last_space = true;
    for ch in raw.chars() {
        let ch = match ch {
            '[' => '(',
            ']' => ')',
            '\r' | '\n' | '\t' => ' ',
            c if c.is_control() => continue,
            c => c,
        };
        if ch == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        if count >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
        count += 1;
    }
    out.trim().to_string()
}

fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

/// A link target GitHub gave us, accepted only if it is an `https://` URL.
fn https_url<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    text(value, path).filter(|url| url.starts_with("https://") && url.len() <= 500)
}

fn actor(payload: &Value) -> String {
    let login = text(payload, &["sender", "login"])
        .map(|login| inline_text(login, 60))
        .filter(|login| !login.is_empty())
        .unwrap_or_else(|| "알 수 없는 사용자".to_string());
    format!("@{login}님")
}

fn linked(label: &str, url: Option<&str>) -> String {
    match url {
        Some(url) => format!("[{label}]({url})"),
        None => label.to_string(),
    }
}

fn repo_of(payload: &Value) -> Option<(Option<i64>, String)> {
    let repository = payload.get("repository")?;
    let full_name = repository.get("full_name")?.as_str()?.trim();
    if full_name.is_empty() || full_name.len() > 300 {
        return None;
    }
    Some((
        repository.get("id").and_then(Value::as_i64),
        full_name.to_string(),
    ))
}

fn notification(
    feature: &'static str,
    event: &str,
    action: &str,
    payload: &Value,
    headline: String,
    detail: Option<String>,
    url: Option<&str>,
) -> Option<Notification> {
    let (repo_id, repo_full_name) = repo_of(payload)?;
    let mut body = format!("{} · {headline}", inline_text(&repo_full_name, 300));
    if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
        body.push('\n');
        body.push_str(&detail);
    }
    let mut props = json!({
        "source": "github",
        "github_event": event,
        "github_action": action,
        "github_repository": repo_full_name,
    });
    if let Some(url) = url {
        props["github_url"] = json!(url);
    }
    Some(Notification {
        feature,
        repo_id,
        repo_full_name,
        body,
        props,
    })
}

/// Render a repository event, or `None` when oort does not announce it (ADR-0205 D6).
///
/// `ping`, `installation` and `installation_repositories` are not repository notifications and
/// also return `None`; the receiver handles them before it gets here.
pub fn render_notification(event: &str, payload: &Value) -> Option<Notification> {
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
    match event {
        "pull_request" => render_pull_request(action, payload),
        "pull_request_review" => render_review(action, payload),
        "issues" => render_issue(action, payload),
        "issue_comment" => render_comment(action, payload),
        "check_suite" => render_check_suite(action, payload),
        "push" => render_push(payload),
        "release" => render_release(action, payload),
        _ => None,
    }
}

fn pull_label(pull: &Value) -> Option<(String, Option<String>)> {
    let number = pull.get("number")?.as_i64()?;
    let title = inline_text(
        pull.get("title").and_then(Value::as_str).unwrap_or(""),
        TITLE_MAX_CHARS,
    );
    let url = https_url(pull, &["html_url"]).map(str::to_string);
    let label = if title.is_empty() {
        format!("#{number}")
    } else {
        format!("#{number} {title}")
    };
    Some((label, url))
}

fn render_pull_request(action: &str, payload: &Value) -> Option<Notification> {
    let pull = payload.get("pull_request")?;
    let who = actor(payload);
    let draft = pull.get("draft").and_then(Value::as_bool).unwrap_or(false);
    let merged = pull.get("merged").and_then(Value::as_bool).unwrap_or(false);
    let verb = match action {
        "opened" if draft => "PR을 초안으로 열었어요",
        "opened" => "PR을 열었어요",
        "reopened" => "PR을 다시 열었어요",
        "ready_for_review" => "PR을 리뷰 준비 상태로 바꿨어요",
        "closed" if merged => "PR을 병합했어요",
        "closed" => "PR을 닫았어요",
        _ => return None,
    };
    let (label, url) = pull_label(pull)?;
    notification(
        "pulls",
        "pull_request",
        action,
        payload,
        format!("{who}이 {verb}"),
        Some(linked(&label, url.as_deref())),
        url.as_deref(),
    )
}

fn render_review(action: &str, payload: &Value) -> Option<Notification> {
    if action != "submitted" {
        return None;
    }
    let review = payload.get("review")?;
    let who = actor(payload);
    let verb = match review.get("state").and_then(Value::as_str)? {
        "approved" => "PR을 승인했어요",
        "changes_requested" => "PR에 수정을 요청했어요",
        "commented" => "PR에 리뷰를 남겼어요",
        _ => return None,
    };
    let (label, pull_url) = pull_label(payload.get("pull_request")?)?;
    let url = https_url(review, &["html_url"])
        .map(str::to_string)
        .or(pull_url);
    let quote = review
        .get("body")
        .and_then(Value::as_str)
        .map(|body| inline_text(body, QUOTE_MAX_CHARS))
        .filter(|body| !body.is_empty());
    let mut detail = linked(&label, url.as_deref());
    if let Some(quote) = quote {
        detail.push_str("\n> ");
        detail.push_str(&quote);
    }
    notification(
        "reviews",
        "pull_request_review",
        action,
        payload,
        format!("{who}이 {verb}"),
        Some(detail),
        url.as_deref(),
    )
}

fn render_issue(action: &str, payload: &Value) -> Option<Notification> {
    let issue = payload.get("issue")?;
    // GitHub delivers PR-backed issue events too; the PR itself is announced under `pull_request`.
    if issue.get("pull_request").is_some() {
        return None;
    }
    let who = actor(payload);
    let verb = match action {
        "opened" => "이슈를 열었어요",
        "reopened" => "이슈를 다시 열었어요",
        "closed" => "이슈를 닫았어요",
        _ => return None,
    };
    let number = issue.get("number")?.as_i64()?;
    let title = inline_text(
        issue.get("title").and_then(Value::as_str).unwrap_or(""),
        TITLE_MAX_CHARS,
    );
    let label = if title.is_empty() {
        format!("#{number}")
    } else {
        format!("#{number} {title}")
    };
    let url = https_url(issue, &["html_url"]);
    notification(
        "issues",
        "issues",
        action,
        payload,
        format!("{who}이 {verb}"),
        Some(linked(&label, url)),
        url,
    )
}

fn render_comment(action: &str, payload: &Value) -> Option<Notification> {
    if action != "created" {
        return None;
    }
    let issue = payload.get("issue")?;
    let comment = payload.get("comment")?;
    let who = actor(payload);
    let target = if issue.get("pull_request").is_some() {
        "PR에"
    } else {
        "이슈에"
    };
    let number = issue.get("number")?.as_i64()?;
    let title = inline_text(
        issue.get("title").and_then(Value::as_str).unwrap_or(""),
        TITLE_MAX_CHARS,
    );
    let label = if title.is_empty() {
        format!("#{number}")
    } else {
        format!("#{number} {title}")
    };
    let url = https_url(comment, &["html_url"]).or_else(|| https_url(issue, &["html_url"]));
    let quote = comment
        .get("body")
        .and_then(Value::as_str)
        .map(|body| inline_text(body, QUOTE_MAX_CHARS))
        .filter(|body| !body.is_empty());
    let mut detail = linked(&label, url);
    if let Some(quote) = quote {
        detail.push_str("\n> ");
        detail.push_str(&quote);
    }
    notification(
        "comments",
        "issue_comment",
        action,
        payload,
        format!("{who}이 {target} 댓글을 남겼어요"),
        Some(detail),
        url,
    )
}

fn render_check_suite(action: &str, payload: &Value) -> Option<Notification> {
    if action != "completed" {
        return None;
    }
    let suite = payload.get("check_suite")?;
    let verdict = match suite.get("conclusion").and_then(Value::as_str)? {
        "failure" => "실패했어요",
        "timed_out" => "시간 초과로 끝났어요",
        _ => return None,
    };
    let branch = inline_text(
        suite
            .get("head_branch")
            .and_then(Value::as_str)
            .unwrap_or(""),
        100,
    );
    let sha = suite.get("head_sha").and_then(Value::as_str).unwrap_or("");
    let short: String = sha.chars().take(7).collect();
    let repo_url = https_url(payload, &["repository", "html_url"]);
    let url = match (repo_url, sha.is_empty()) {
        (Some(repo), false) if sha.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Some(format!("{repo}/commit/{sha}"))
        }
        _ => None,
    };
    let app = inline_text(text(suite, &["app", "name"]).unwrap_or("체크"), 60);
    let where_ = if branch.is_empty() {
        short.clone()
    } else {
        format!("{branch} @ {short}")
    };
    notification(
        "checks",
        "check_suite",
        action,
        payload,
        format!("{app} 체크가 {verdict}"),
        Some(linked(&where_, url.as_deref())),
        url.as_deref(),
    )
}

fn render_push(payload: &Value) -> Option<Notification> {
    if payload
        .get("deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let reference = payload.get("ref")?.as_str()?;
    let branch = reference.strip_prefix("refs/heads/")?;
    let default_branch = text(payload, &["repository", "default_branch"])?;
    if branch != default_branch {
        return None;
    }
    let commits = payload.get("commits")?.as_array()?;
    if commits.is_empty() {
        return None;
    }
    let pusher = text(payload, &["pusher", "name"])
        .or_else(|| text(payload, &["sender", "login"]))
        .map(|name| inline_text(name, 60))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "알 수 없는 사용자".to_string());
    let head_message = commits
        .last()
        .and_then(|commit| commit.get("message"))
        .and_then(Value::as_str)
        .map(|message| inline_text(message.lines().next().unwrap_or(""), TITLE_MAX_CHARS))
        .filter(|message| !message.is_empty());
    let url = https_url(payload, &["compare"]);
    let detail = match head_message {
        Some(message) => linked(&message, url),
        None => String::new(),
    };
    let headline = format!(
        "@{pusher}님이 {} 브랜치에 커밋 {}개를 올렸어요",
        inline_text(branch, 100),
        commits.len()
    );
    notification(
        "commits",
        "push",
        "pushed",
        payload,
        headline,
        Some(detail),
        url,
    )
}

fn render_release(action: &str, payload: &Value) -> Option<Notification> {
    if action != "published" {
        return None;
    }
    let release = payload.get("release")?;
    if release
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let who = actor(payload);
    let tag = inline_text(release.get("tag_name").and_then(Value::as_str)?, 100);
    let name = inline_text(
        release.get("name").and_then(Value::as_str).unwrap_or(""),
        TITLE_MAX_CHARS,
    );
    let label = if name.is_empty() || name == tag {
        tag
    } else {
        format!("{tag} {name}")
    };
    let url = https_url(release, &["html_url"]);
    notification(
        "releases",
        "release",
        action,
        payload,
        format!("{who}이 릴리스를 게시했어요"),
        Some(linked(&label, url)),
        url,
    )
}

#[cfg(test)]
mod tests {
    /// #4084 (ADR-0205 H-1): the pair every caller-props door drops.
    #[test]
    fn github_notification_props_are_server_owned() {
        use super::is_github_owned_prop;
        for (key, value) in [
            ("source", "github"),
            ("source", " GitHub "),
            ("Source", "GITHUB"),
            ("github_event", "x"),
            ("github_url", "https://github.com/a/b"),
            ("GitHub_Author_Member_Id", "x"),
            ("github_", ""),
        ] {
            assert!(is_github_owned_prop(key, value), "{key}={value}");
        }
        for (key, value) in [
            ("source", "prime"),
            ("source", "external_webhook"),
            ("source", "githubx"),
            ("note", "github"),
            ("githubby", "x"),
        ] {
            assert!(!is_github_owned_prop(key, value), "{key}={value}");
        }
    }

    use super::*;

    const SECRET: &str = "whsec-test-secret";

    fn signed(body: &[u8]) -> String {
        format!("sha256={}", github_signature(SECRET, body))
    }

    #[test]
    fn the_signature_is_the_hmac_of_the_raw_bytes() {
        // RFC 4231-style vector for the construction GitHub documents.
        let digest = github_signature("It's a Secret to Everybody", b"Hello, World!");
        assert_eq!(
            digest,
            "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        );
    }

    #[test]
    fn a_wrong_prefix_length_or_flipped_nibble_does_not_authenticate() {
        let body = br#"{"zen":"x"}"#;
        let good = signed(body);
        assert!(github_signature_matches(SECRET, body, &good));
        // upper-case hex is the same digest
        assert!(github_signature_matches(
            SECRET,
            body,
            &format!("sha256={}", github_signature(SECRET, body).to_uppercase())
        ));
        // wrong secret, wrong body
        assert!(!github_signature_matches("other", body, &good));
        assert!(!github_signature_matches(SECRET, b"{}", &good));
        // the legacy SHA-1 form and a bare digest are never accepted
        assert!(!github_signature_matches(
            SECRET,
            body,
            &good.replace("sha256=", "sha1=")
        ));
        assert!(!github_signature_matches(
            SECRET,
            body,
            good.trim_start_matches("sha256=")
        ));
        assert!(!github_signature_matches(
            SECRET,
            body,
            &format!("v1={}", &good[7..])
        ));
        // truncated / extended / non-hex / empty
        assert!(!github_signature_matches(
            SECRET,
            body,
            &good[..good.len() - 2]
        ));
        assert!(!github_signature_matches(
            SECRET,
            body,
            &format!("{good}00")
        ));
        assert!(!github_signature_matches(SECRET, body, "sha256=zz"));
        assert!(!github_signature_matches(SECRET, body, "sha256="));
        assert!(!github_signature_matches(SECRET, body, ""));
        // one flipped nibble
        let mut flipped = good.clone().into_bytes();
        let last = flipped.len() - 1;
        flipped[last] = if flipped[last] == b'0' { b'1' } else { b'0' };
        assert!(!github_signature_matches(
            SECRET,
            body,
            &String::from_utf8(flipped).unwrap()
        ));
    }

    #[test]
    fn delivery_ids_fit_the_receipt_column() {
        assert!(valid_github_delivery_id(
            "72d3162e-cc78-11e3-81ab-4c9367dc0958"
        ));
        for bad in ["", "a b", "a/b", "id;drop", &"x".repeat(101)] {
            assert!(!valid_github_delivery_id(bad), "{bad}");
        }
    }

    fn pr(action: &str, extra: Value) -> Value {
        let mut base = json!({
            "action": action,
            "sender": {"login": "alice"},
            "repository": {"id": 7, "full_name": "acme/widgets", "html_url": "https://github.com/acme/widgets", "default_branch": "main"},
            "pull_request": {
                "number": 12, "title": "Fix [the] bug\nnow", "html_url": "https://github.com/acme/widgets/pull/12",
                "draft": false, "merged": false
            },
        });
        for (key, value) in extra.as_object().unwrap() {
            base["pull_request"][key] = value.clone();
        }
        base
    }

    #[test]
    fn pull_request_lifecycle_maps_to_the_pulls_feature() {
        let opened = render_notification("pull_request", &pr("opened", json!({}))).unwrap();
        assert_eq!(opened.feature, "pulls");
        assert_eq!(opened.repo_full_name, "acme/widgets");
        assert_eq!(opened.repo_id, Some(7));
        assert!(
            opened.body.contains("@alice님이 PR을 열었어요"),
            "{}",
            opened.body
        );
        // markdown delimiters and the newline in the title are neutralised
        assert!(opened
            .body
            .contains("[#12 Fix (the) bug now](https://github.com/acme/widgets/pull/12)"));
        let merged =
            render_notification("pull_request", &pr("closed", json!({"merged": true}))).unwrap();
        assert!(merged.body.contains("병합했어요"));
        let closed = render_notification("pull_request", &pr("closed", json!({}))).unwrap();
        assert!(closed.body.contains("닫았어요"));
        let ready =
            render_notification("pull_request", &pr("ready_for_review", json!({}))).unwrap();
        assert!(ready.body.contains("리뷰 준비"));
        // actions oort does not announce
        for quiet in [
            "synchronize",
            "labeled",
            "edited",
            "assigned",
            "review_requested",
        ] {
            assert!(
                render_notification("pull_request", &pr(quiet, json!({}))).is_none(),
                "{quiet}"
            );
        }
    }

    #[test]
    fn only_https_urls_become_links() {
        let mut payload = pr("opened", json!({}));
        payload["pull_request"]["html_url"] = json!("javascript:alert(1)");
        let rendered = render_notification("pull_request", &payload).unwrap();
        assert!(!rendered.body.contains("javascript:"), "{}", rendered.body);
        assert!(rendered.props.get("github_url").is_none());
    }

    #[test]
    fn issues_exclude_pr_backed_events() {
        let issue = json!({
            "action": "opened", "sender": {"login": "bob"},
            "repository": {"id": 7, "full_name": "acme/widgets"},
            "issue": {"number": 3, "title": "Crash", "html_url": "https://github.com/acme/widgets/issues/3"}
        });
        let rendered = render_notification("issues", &issue).unwrap();
        assert_eq!(rendered.feature, "issues");
        assert!(rendered.body.contains("이슈를 열었어요"));
        let mut backed = issue.clone();
        backed["issue"]["pull_request"] = json!({"url": "x"});
        assert!(render_notification("issues", &backed).is_none());
        let mut labeled = issue.clone();
        labeled["action"] = json!("labeled");
        assert!(render_notification("issues", &labeled).is_none());
    }

    #[test]
    fn reviews_comments_checks_commits_and_releases_each_map_to_their_own_feature() {
        let review = json!({
            "action": "submitted", "sender": {"login": "carol"},
            "repository": {"id": 7, "full_name": "acme/widgets"},
            "review": {"state": "approved", "body": "LGTM", "html_url": "https://github.com/acme/widgets/pull/12#r1"},
            "pull_request": {"number": 12, "title": "T", "html_url": "https://github.com/acme/widgets/pull/12"}
        });
        assert_eq!(
            render_notification("pull_request_review", &review)
                .unwrap()
                .feature,
            "reviews"
        );

        let comment = json!({
            "action": "created", "sender": {"login": "dave"},
            "repository": {"id": 7, "full_name": "acme/widgets"},
            "issue": {"number": 3, "title": "T", "html_url": "https://github.com/acme/widgets/issues/3"},
            "comment": {"body": "hello", "html_url": "https://github.com/acme/widgets/issues/3#c1"}
        });
        assert_eq!(
            render_notification("issue_comment", &comment)
                .unwrap()
                .feature,
            "comments"
        );

        let suite = |conclusion: &str| {
            json!({
                "action": "completed", "sender": {"login": "ci"},
                "repository": {"id": 7, "full_name": "acme/widgets", "html_url": "https://github.com/acme/widgets"},
                "check_suite": {"conclusion": conclusion, "head_branch": "feat", "head_sha": "abcdef0123456789", "app": {"name": "CI"}}
            })
        };
        assert_eq!(
            render_notification("check_suite", &suite("failure"))
                .unwrap()
                .feature,
            "checks"
        );
        assert!(render_notification("check_suite", &suite("success")).is_none());

        let push = |reference: &str, deleted: bool| {
            json!({
                "ref": reference, "deleted": deleted, "sender": {"login": "erin"},
                "pusher": {"name": "erin"},
                "compare": "https://github.com/acme/widgets/compare/a...b",
                "repository": {"id": 7, "full_name": "acme/widgets", "default_branch": "main"},
                "commits": [{"message": "first\nbody"}, {"message": "second line\nbody"}]
            })
        };
        let pushed = render_notification("push", &push("refs/heads/main", false)).unwrap();
        assert_eq!(pushed.feature, "commits");
        assert!(pushed.body.contains("커밋 2개"));
        assert!(pushed.body.contains("second line"));
        assert!(render_notification("push", &push("refs/heads/feature", false)).is_none());
        assert!(render_notification("push", &push("refs/heads/main", true)).is_none());
        assert!(render_notification("push", &push("refs/tags/v1", false)).is_none());

        let release = json!({
            "action": "published", "sender": {"login": "fay"},
            "repository": {"id": 7, "full_name": "acme/widgets"},
            "release": {"tag_name": "v1.0.0", "name": "First", "draft": false, "html_url": "https://github.com/acme/widgets/releases/tag/v1.0.0"}
        });
        assert_eq!(
            render_notification("release", &release).unwrap().feature,
            "releases"
        );
    }

    #[test]
    fn unknown_events_and_lifecycle_events_render_nothing() {
        let payload = json!({"zen": "Keep it logically awesome.", "repository": {"id": 1, "full_name": "a/b"}});
        for event in [
            "ping",
            "installation",
            "installation_repositories",
            "star",
            "fork",
            "workflow_run",
            "",
        ] {
            assert!(render_notification(event, &payload).is_none(), "{event}");
        }
    }

    #[test]
    fn installation_payloads_parse_defensively() {
        let payload = json!({
            "action": "created",
            "installation": {"id": 99, "account": {"login": "acme", "type": "Organization"}, "repository_selection": "selected"},
            "repositories": [
                {"id": 1, "full_name": "acme/a", "private": true},
                {"id": 2, "full_name": "acme/b", "private": false},
                {"id": 3},
                {"full_name": "acme/c"}
            ]
        });
        let info = installation_info(&payload).unwrap();
        assert_eq!(info.id, 99);
        assert_eq!(info.account_login, "acme");
        assert_eq!(info.account_type, "Organization");
        assert_eq!(info.repository_selection, "selected");
        let repos = repositories(&payload, "repositories");
        assert_eq!(repos.len(), 2);
        assert!(repos[0].private && !repos[1].private);
        assert!(repositories(&payload, "repositories_added").is_empty());
        assert_eq!(installation_id(&payload), Some(99));
        assert_eq!(installation_id(&json!({"installation": {"id": 0}})), None);
        assert_eq!(installation_id(&json!({})), None);
        // a missing `private` flag is treated as private (the conservative reading)
        let unknown = json!({"repositories": [{"id": 5, "full_name": "acme/x"}]});
        assert!(repositories(&unknown, "repositories")[0].private);
    }

    #[test]
    fn inline_text_is_single_line_and_bounded() {
        assert_eq!(inline_text("a\r\nb\t c", 50), "a b c");
        assert_eq!(inline_text("[x](y)", 50), "(x)(y)");
        let long = "가".repeat(300);
        let out = inline_text(&long, 10);
        assert_eq!(out.chars().count(), 11);
        assert!(out.ends_with('…'));
    }
}
