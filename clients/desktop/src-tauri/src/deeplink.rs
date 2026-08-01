// oort:// deep link intake (ADR-0133 P2, MOMO-603; scheme renamed in goal B13).
//
// Contract source of truth: `docs/onboarding-deeplink.md`.
//   oort://join?server=<percent-encoded base URL>&code=<invite code>
// Two parameters, order-independent, unknown parameters ignored. This is a
// straight port of the macOS parser (`clients/macOS/Sources/MomoMac/MomoDeepLink.swift`)
// so the two shells prefill identically from the same link — including the parts
// that look like details but are contract: the action may be the authority
// (`oort://join`) or the first path segment (`oort:join`), parameter names are
// matched case-insensitively, the FIRST occurrence of a name wins, and a link
// carrying only one of the two values is still worth surfacing because it still
// saves the person typing.
//
// Deliberately NOT validated here: whether `server` is a usable base URL. The
// macOS side re-validates downstream (`validatedBaseURL()`), and so does the web
// join surface, so a single owner keeps that rule instead of two drifting copies.
//
// Percent-decoding is done by hand rather than through `Url::query_pairs()`,
// because that applies `application/x-www-form-urlencoded` rules and would turn a
// literal `+` into a space. The contract is RFC 3986 percent-encoding, which the
// macOS `URLComponents` path follows, so `+` must survive as `+`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use url::Url;

/// Emitted to the webview for every accepted join link.
///
/// This is a Tauri IPC channel name, not a URL scheme, and it is NOT part of the
/// momo -> oort rebrand: renaming it would only have to be renamed in lockstep
/// in `lib/tauri.ts` for no one's benefit. Nobody outside the shell sees it.
pub const DEEP_LINK_EVENT: &str = "momo:deep-link";

/// The scheme links are minted with (goal B13, momo -> oort).
const JOIN_SCHEME: &str = "oort";

/// Every scheme a link is accepted under. The old name is absorbed rather than
/// dropped: an invite link lives in someone's inbox for days after it is sent,
/// and it was correct when it was sent. `tauri.conf.json` registers both with
/// the OS so both actually reach this parser.
const ACCEPTED_SCHEMES: [&str; 2] = [JOIN_SCHEME, "momo"];
const JOIN_ACTION: &str = "join";

/// A join link the webview can prefill from.
///
/// `server` and `code` are percent-decoded and trimmed; either may be empty, but
/// never both (a link with nothing usable is dropped rather than delivered).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinLink {
    /// The raw link as received, for logging and for the "opened from a link"
    /// affordance. Carries the invite code, so it is never logged at info level.
    pub url: String,
    pub server: String,
    pub code: String,
}

/// Parses a join link under any accepted scheme, or `None` for anything else.
pub fn parse_join(url: &Url) -> Option<JoinLink> {
    if !ACCEPTED_SCHEMES.contains(&url.scheme()) {
        return None;
    }
    if resolved_action(url)? != JOIN_ACTION {
        return None;
    }

    let mut server: Option<String> = None;
    let mut code: Option<String> = None;
    for (name, value) in query_pairs(url.query().unwrap_or("")) {
        match name.to_ascii_lowercase().as_str() {
            "server" if server.is_none() => server = Some(value),
            "code" if code.is_none() => code = Some(value),
            _ => {} // Unknown parameters are ignored per the shared contract.
        }
    }

    let server = server.unwrap_or_default().trim().to_string();
    let code = code.unwrap_or_default().trim().to_string();
    if server.is_empty() && code.is_empty() {
        return None;
    }
    Some(JoinLink {
        url: url.as_str().to_string(),
        server,
        code,
    })
}

/// The action is the authority (`oort://join`) or, when the link omits the
/// authority (`oort:join`), the first non-empty path segment. Case-insensitive.
fn resolved_action(url: &Url) -> Option<String> {
    if let Some(host) = url.host_str() {
        if !host.is_empty() {
            return Some(host.to_ascii_lowercase());
        }
    }
    url.path()
        .split('/')
        .find(|segment| !segment.is_empty())
        .map(|segment| {
            percent_decode_str(segment)
                .decode_utf8_lossy()
                .to_ascii_lowercase()
        })
}

/// RFC 3986 percent-decoding of a raw query string. No `+` to space.
fn query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(name), decode(value))
        })
        .collect()
}

fn decode(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

/// Buffers links that arrive before the webview can hear them.
///
/// macOS delivers the launch URL while the app is still starting, well before
/// React has mounted and subscribed, so a pure event bridge would drop exactly
/// the case that matters most: clicking an invite link with the app closed. The
/// handshake is one-shot — `deep_link_take_pending` marks the webview ready and
/// drains the buffer, and everything after that is delivered as events only, so
/// a link is never both replayed and emitted.
#[derive(Default)]
pub struct DeepLinkState {
    pending: Mutex<Vec<JoinLink>>,
    webview_ready: AtomicBool,
}

impl DeepLinkState {
    /// Route one incoming link: emit it if the webview is listening, buffer it
    /// otherwise. Links that are not a join link are dropped silently.
    pub fn deliver<R: Runtime>(&self, app: &AppHandle<R>, url: &Url) {
        let Some(link) = parse_join(url) else {
            return;
        };
        if self.webview_ready.load(Ordering::SeqCst) {
            let _ = app.emit(DEEP_LINK_EVENT, &link);
        } else if let Ok(mut pending) = self.pending.lock() {
            pending.push(link);
        }
    }
}

/// Drains links that arrived before the webview subscribed, and marks it ready.
///
/// Call once, immediately after attaching the `momo:deep-link` listener.
#[tauri::command]
pub fn deep_link_take_pending(state: State<'_, DeepLinkState>) -> Vec<JoinLink> {
    state.webview_ready.store(true, Ordering::SeqCst);
    state
        .pending
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Option<JoinLink> {
        parse_join(&Url::parse(raw).expect("test link parses as a URL"))
    }

    #[test]
    fn parses_the_canonical_link() {
        let link = parse("oort://join?server=http%3A%2F%2FMacBook.local%3A28000&code=abc-123")
            .expect("canonical link is accepted");
        assert_eq!(link.server, "http://MacBook.local:28000");
        assert_eq!(link.code, "abc-123");
    }

    #[test]
    fn parameter_order_does_not_matter() {
        let reversed = parse("oort://join?code=abc-123&server=https%3A%2F%2Fapi.example.com")
            .expect("reversed order is accepted");
        assert_eq!(reversed.server, "https://api.example.com");
        assert_eq!(reversed.code, "abc-123");
    }

    #[test]
    fn unknown_parameters_are_ignored() {
        let link = parse("oort://join?utm=mail&code=abc&server=https%3A%2F%2Fa.example&x=1")
            .expect("extra parameters do not invalidate the link");
        assert_eq!(link.server, "https://a.example");
        assert_eq!(link.code, "abc");
    }

    #[test]
    fn accepts_the_authority_free_form() {
        assert!(parse("oort:join?code=abc").is_some());
    }

    #[test]
    fn rejects_other_schemes_and_actions() {
        assert!(parse("https://join?code=abc").is_none());
        assert!(parse("oort://invite?code=abc").is_none());
        assert!(parse("slack://join?code=abc").is_none());
    }

    /// **The old scheme still opens.**
    ///
    /// goal B13 renamed the minted scheme `momo://` -> `oort://`, and dropping
    /// the old one would have broken every invite already sitting in somebody's
    /// inbox — links that were correct when they were sent. Both are registered
    /// with the OS (`tauri.conf.json`) so both actually arrive here, and this
    /// test is what stops the second entry from being "tidied up" later.
    #[test]
    fn still_opens_a_link_minted_under_the_old_scheme() {
        let link = parse("momo://join?server=https%3A%2F%2Fa.example&code=abc")
            .expect("a momo:// invite from before the rename");
        assert_eq!(link.server, "https://a.example");
        assert_eq!(link.code, "abc");
        assert!(parse("momo:join?code=abc").is_some());
    }

    #[test]
    fn rejects_a_link_with_nothing_to_prefill() {
        assert!(parse("oort://join").is_none());
        assert!(parse("oort://join?server=&code=").is_none());
        assert!(parse("oort://join?utm=mail").is_none());
    }

    #[test]
    fn keeps_a_partial_link_because_it_still_saves_typing() {
        let server_only = parse("oort://join?server=https%3A%2F%2Fa.example").expect("server only");
        assert_eq!(server_only.code, "");
        let code_only = parse("oort://join?code=abc").expect("code only");
        assert_eq!(code_only.server, "");
    }

    #[test]
    fn a_plus_in_a_value_is_not_a_space() {
        // base64url codes never contain '+', but form-urlencoded decoding would
        // silently corrupt one that did; RFC 3986 is the contract.
        let link = parse("oort://join?code=a%2Bb").expect("link parses");
        assert_eq!(link.code, "a+b");
    }

    #[test]
    fn parameter_names_are_case_insensitive_and_first_wins() {
        let link =
            parse("oort://join?SERVER=https%3A%2F%2Fa.example&server=https%3A%2F%2Fb.example")
                .expect("link parses");
        assert_eq!(link.server, "https://a.example");
    }
}
