//! Decode a fetched page into text (ADR-0170 amendment D8).
//!
//! The order is BOM, then the Content-Type `charset`, then `<meta charset>`, then
//! `<meta http-equiv="Content-Type" content="…; charset=…">`, then UTF-8. Labels go through
//! `encoding_rs` (the WHATWG table), so `euc-kr`, `ks_c_5601-1987` and `windows-949` all mean the
//! same decoder. A label it does not know is skipped, not an error. Decoding never fails: bytes
//! the encoding cannot read become U+FFFD.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252, X_USER_DEFINED};

use crate::parse::for_each_tag;

/// How many leading bytes are searched for a `<meta>` charset. The HTML standard's prescan reads
/// 1024; a longer head in front of the declaration is common enough to widen it.
pub const META_SNIFF_BYTES: usize = 4096;

/// `content_type` is the response header as received (or the default the fetch layer filled in).
pub fn decode_html(content_type: &str, body: &[u8]) -> String {
    let encoding = header_charset(content_type)
        .or_else(|| meta_charset(body))
        .unwrap_or(UTF_8);
    // `decode` sniffs a BOM first and lets it override `encoding`, as browsers do.
    let (text, _, _) = encoding.decode(body);
    text.into_owned()
}

fn header_charset(content_type: &str) -> Option<&'static Encoding> {
    content_type.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("charset") {
            return None;
        }
        Encoding::for_label(value.trim().trim_matches(['"', '\'']).trim().as_bytes())
    })
}

fn meta_charset(body: &[u8]) -> Option<&'static Encoding> {
    let head = String::from_utf8_lossy(&body[..body.len().min(META_SNIFF_BYTES)]);
    let mut declared = None;
    let mut equiv = None;
    for_each_tag(&head, &["meta"], |tag| {
        if declared.is_none() {
            declared = tag.attr("charset").and_then(meta_label);
        }
        if equiv.is_none()
            && tag
                .attr("http-equiv")
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("content-type"))
        {
            equiv = tag.attr("content").and_then(charset_in_content);
        }
    });
    declared.or(equiv)
}

/// `text/html; charset=euc-kr` → the label after `charset=`.
fn charset_in_content(content: &str) -> Option<&'static Encoding> {
    let lower = content.to_ascii_lowercase();
    let after = &content[lower.find("charset")? + "charset".len()..];
    let value = after.trim_start().strip_prefix('=')?.trim_start();
    let value = value.trim_start_matches(['"', '\'']);
    let end = value
        .find(|c: char| c == ';' || c == '"' || c == '\'' || c.is_whitespace())
        .unwrap_or(value.len());
    meta_label(&value[..end])
}

/// A label found in the page itself. A page we can read as ASCII is not UTF-16, so a meta that
/// says so means UTF-8 (WHATWG); `x-user-defined` reads as windows-1252.
fn meta_label(label: &str) -> Option<&'static Encoding> {
    let encoding = Encoding::for_label(label.trim().as_bytes())?;
    Some(if encoding == UTF_16LE || encoding == UTF_16BE {
        UTF_8
    } else if encoding == X_USER_DEFINED {
        WINDOWS_1252
    } else {
        encoding
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::EUC_KR;

    const TITLE: &str = "한글 제목 — 오르트";

    fn euc_kr(text: &str) -> Vec<u8> {
        let (bytes, _, unmappable) = EUC_KR.encode(text);
        assert!(
            !unmappable,
            "the fixture text must be representable in EUC-KR"
        );
        bytes.into_owned()
    }

    fn page(head: &str, title: &str) -> Vec<u8> {
        let mut out = format!("<html><head>{head}</head><body><h1>").into_bytes();
        out.extend(euc_kr(title));
        out.extend_from_slice(b"</h1></body></html>");
        out
    }

    #[test]
    fn the_content_type_charset_decodes_euc_kr() {
        // Only the Korean title: the em dash is not in EUC-KR, so use plain hangul here.
        let title = "한글 제목";
        let body = page("", title);
        let text = decode_html("text/html; charset=euc-kr", &body);
        assert!(text.contains(title), "{text}");
        assert!(!text.contains('\u{fffd}'));
        // Quoted, upper-case, padded and an alias label all find the same decoder.
        for header in [
            r#"text/html; charset="EUC-KR""#,
            "text/html;charset=EUC-KR",
            "text/html; CHARSET = ks_c_5601-1987",
            "text/html; charset=windows-949",
        ] {
            assert!(decode_html(header, &body).contains(title), "{header}");
        }
        // Without the declaration the same bytes are not Korean.
        let blind = decode_html("text/html", &body);
        assert!(!blind.contains(title));
        assert!(blind.contains('\u{fffd}'));
    }

    #[test]
    fn meta_charset_and_http_equiv_fill_in_when_the_header_is_silent() {
        let title = "한글 제목";
        for head in [
            r#"<meta charset="euc-kr">"#,
            r#"<meta charset=euc-kr>"#,
            r#"<META CHARSET='EUC-KR'/>"#,
            r#"<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">"#,
            r#"<meta content="text/html; charset=EUC-KR" http-equiv="content-type">"#,
        ] {
            let body = page(head, title);
            for header in ["text/html", "text/html; charset=", ""] {
                assert!(
                    decode_html(header, &body).contains(title),
                    "{head} / {header}"
                );
            }
        }
    }

    #[test]
    fn the_order_is_header_then_meta_charset_then_http_equiv_then_utf8() {
        let title = "한글 제목";
        // The header beats a meta that says something else.
        let body = page(r#"<meta charset="utf-8">"#, title);
        assert!(decode_html("text/html; charset=euc-kr", &body).contains(title));
        // <meta charset> beats http-equiv even when http-equiv comes first.
        let body = page(
            r#"<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta charset="euc-kr">"#,
            title,
        );
        assert!(decode_html("text/html", &body).contains(title));
        // http-equiv alone is enough; a meta that is not Content-Type is ignored.
        let body = page(
            r#"<meta http-equiv="refresh" content="0; charset=utf-8"><meta http-equiv="Content-Type" content="text/html; charset=euc-kr">"#,
            title,
        );
        assert!(decode_html("text/html", &body).contains(title));
        // Nothing declared: UTF-8, and a UTF-8 page decodes as itself.
        let utf8 = format!("<html><body>{TITLE}</body></html>");
        assert!(decode_html("text/html", utf8.as_bytes()).contains(TITLE));
    }

    #[test]
    fn a_label_we_do_not_know_is_skipped_not_fatal() {
        let title = "한글 제목";
        // An unknown header label falls through to the meta.
        let body = page(r#"<meta charset="euc-kr">"#, title);
        assert!(decode_html("text/html; charset=martian-9", &body).contains(title));
        // Nothing usable anywhere: UTF-8 (the bytes are not UTF-8, so U+FFFD, and no panic).
        let body = page(r#"<meta charset="martian-9">"#, title);
        let text = decode_html("text/html; charset=also-unknown", &body);
        assert!(text.contains('\u{fffd}'));
        // A meta that says UTF-16 in a document we can read as ASCII means UTF-8.
        let text = decode_html("text/html", b"<meta charset=\"utf-16\"><p>caf\xc3\xa9</p>");
        assert!(text.contains("café"), "{text}");
    }

    #[test]
    fn a_byte_order_mark_beats_the_header() {
        let mut body = vec![0xEF, 0xBB, 0xBF];
        body.extend_from_slice(TITLE.as_bytes());
        let text = decode_html("text/html; charset=euc-kr", &body);
        assert!(text.contains(TITLE), "{text}");
    }

    #[test]
    fn the_meta_is_only_looked_for_in_the_first_4096_bytes() {
        let title = "한글 제목";
        let filler = format!("<!-- {} -->", "x".repeat(META_SNIFF_BYTES - 200));
        // Inside the window: found.
        let near = page(&format!(r#"{filler}<meta charset="euc-kr">"#), title);
        assert!(decode_html("text/html", &near).contains(title));
        // Past the window: not found, so UTF-8.
        let far_filler = format!("<!-- {} -->", "x".repeat(META_SNIFF_BYTES + 100));
        let far = page(&format!(r#"{far_filler}<meta charset="euc-kr">"#), title);
        let text = decode_html("text/html", &far);
        assert!(!text.contains(title));
    }

    #[test]
    fn garbage_in_any_encoding_never_panics() {
        for body in [
            &b""[..],
            b"\xff\xfe\x00",
            b"<meta charset=",
            b"\x80\x81\x82<meta charset=euc-kr>",
        ] {
            let _ = decode_html("text/html; charset=euc-kr", body);
            let _ = decode_html("", body);
        }
    }
}
