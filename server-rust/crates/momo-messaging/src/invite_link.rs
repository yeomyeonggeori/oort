//! The one conversation message that carries a **live invite link**: the one the team AI
//! ("oort 도우미") posts after an admin approves its `invite.create` card (ADR-0201 증보 v3 B4-2,
//! #4965).
//!
//! The owner chose to let the helper hand the link to the conversation (Q1 B). The cost is that
//! the link is now text in a channel, and a channel is something agents read. This module is where
//! that cost is bounded, in the two layers every consumer shares:
//!
//! * **the marker** — the message is written with [`props`] (`{"kind": "team_ai_invite_link"}`,
//!   no link in it). A projection that feeds a *model* ([`crate::context_message_body`], the helper's
//!   read tools) replaces the message by [`PLACEHOLDER`]; a notification surface reads
//!   `props.preview` ([`PREVIEW`]) instead of the body;
//! * **the quiet line** — [`props`] also carries `announce: true`, the server-owned key the push
//!   judgment reads first (`momo_push` judgment: a quiet line pushes **nobody**). Without it a DM's
//!   other human is a `Dm` candidate, and an app installed before the notification text became
//!   `props.preview` prints the whole body — the link — on a lock screen (the r1 security review of
//!   #4965, Medium-1). The people in the conversation still see the link where it was posted;
//!   it just never rides a push. No client reads `props.announce`, so nothing is drawn differently;
//! * **the shape** — [`mask_links`] replaces any whitespace-delimited token that looks like a join
//!   link (`…join?code=…`) by [`PLACEHOLDER`], marker or not. The helper's read tools run it on
//!   everything they return, so a link a person pasted, or one whose message was never marked,
//!   does not ride to the team key's provider either (B13-I2).
//!
//! The message body is **line 1: [`PREVIEW`], line 2: the link**. A banner that shows only the first
//! line of a body (`packages/momo-core` `notificationBody`) shows the sentence and never the link.

use std::borrow::Cow;

use serde_json::{json, Value};

/// `message.props.kind` of the helper's invite-link message.
pub const PROPS_KIND: &str = "team_ai_invite_link";

/// What a notification, a preview and a quoted line say instead of the body — and the body's
/// first line.
pub const PREVIEW: &str = "초대 링크를 올렸어요";

/// What a model-bound projection says where a link was.
pub const PLACEHOLDER: &str = "[초대 링크]";

/// The marker props: a closed object with **no** link in it. `announce` is a JSON **boolean**
/// `true` — the push judgment compares it as `'true'::jsonb`, so the string `"true"` would not do —
/// and a server-owned key a REST send or a webhook strips, so only this function can set it.
pub fn props() -> Value {
    json!({"kind": PROPS_KIND, "preview": PREVIEW, "announce": true})
}

/// The message body: the fixed sentence, then the link on its own line. The server writes it; a
/// model never sees or composes it.
pub fn body(link: &str) -> String {
    format!("{PREVIEW}\n{link}")
}

/// Does this message carry the marker?
pub fn is_marked(props: &Value) -> bool {
    props.get("kind").and_then(Value::as_str) == Some(PROPS_KIND)
}

/// Does this token spell a join link (the server's `{origin}/join?code=…`, the `oort://` /
/// `momo://` deep links, or a percent-encoded copy)?
fn is_link_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.contains("join?code=") || lower.contains("join%3fcode%3d")
}

/// `text` with every join-link token replaced by [`PLACEHOLDER`]. Whitespace is kept as it was.
/// Borrows when there is nothing to mask.
pub fn mask_links(text: &str) -> Cow<'_, str> {
    let any = text.split_whitespace().any(is_link_token);
    if !any {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        if is_link_token(token) {
            out.push_str(PLACEHOLDER);
        } else {
            out.push_str(token);
        }
        token.clear();
    };
    for ch in text.chars() {
        if ch.is_whitespace() {
            flush(&mut token, &mut out);
            out.push(ch);
        } else {
            token.push(ch);
        }
    }
    flush(&mut token, &mut out);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "https://oort.example/join?code=Ab3-_xQ7zK9";

    #[test]
    fn the_body_is_the_sentence_then_the_link_and_the_props_hold_no_link() {
        let body = body(LINK);
        let mut lines = body.lines();
        assert_eq!(lines.next(), Some(PREVIEW));
        assert_eq!(lines.next(), Some(LINK));
        assert_eq!(lines.next(), None);
        let props = props();
        assert!(is_marked(&props));
        assert!(!props.to_string().contains("join?code"));
        assert!(!props.to_string().contains("Ab3"));
        // The quiet-line marker is the JSON boolean the push judgment reads (`= 'true'::jsonb`),
        // not the string a client could write.
        assert_eq!(props["announce"], json!(true));
        assert!(props["announce"].is_boolean());
        assert!(!is_marked(&json!({})));
        assert!(!is_marked(&json!({"kind": "tool_result"})));
    }

    #[test]
    fn a_join_link_is_masked_in_every_spelling_and_other_text_is_not() {
        for spelling in [
            LINK.to_string(),
            "oort://join?code=Ab3-_xQ7zK9&server=https%3A%2F%2Fx".to_string(),
            "momo:join?code=Ab3-_xQ7zK9".to_string(),
            "https://oort.example/JOIN?CODE=Ab3-_xQ7zK9".to_string(),
            "https://oort.example/join%3Fcode%3DAb3-_xQ7zK9".to_string(),
            "링크:https://oort.example/join?code=Ab3-_xQ7zK9".to_string(),
        ] {
            let said = format!("들어와요 {spelling} 감사해요");
            let masked = mask_links(&said);
            assert_eq!(
                masked,
                format!("들어와요 {PLACEHOLDER} 감사해요"),
                "{spelling}"
            );
            assert!(!masked.contains("Ab3"), "{spelling}");
        }
        // Whitespace (newlines included) survives; text without a link is borrowed untouched.
        let two_lines = format!("{PREVIEW}\n{LINK}\n끝");
        assert_eq!(
            mask_links(&two_lines),
            format!("{PREVIEW}\n{PLACEHOLDER}\n끝")
        );
        for plain in [
            "https://oort.example/join",
            "join the channel",
            "code=1234",
            "https://oort.example/docs?code=1",
            "",
        ] {
            assert!(matches!(mask_links(plain), Cow::Borrowed(_)), "{plain}");
        }
    }
}
