//! Pull at most [`MAX_URLS_PER_MESSAGE`] http(s) URLs out of a message body.
//!
//! Code fences, inline code, and email addresses are excluded (AC). This is
//! string picking, not body comprehension — see the crate-level P9 note.

pub const MAX_URLS_PER_MESSAGE: usize = 3;

/// Extract unique normalised http(s) URLs, in order of appearance, capped at 3.
pub fn extract_urls(body: &str) -> Vec<String> {
    let scanned = strip_code(body);
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let bytes = scanned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &scanned[i..];
        let Some(rel) = find_scheme(rest) else {
            break;
        };
        i += rel;
        let candidate = take_url(&scanned[i..]);
        i += candidate.len().max(1);
        let trimmed = trim_trailing_punct(candidate);
        let Ok(key) = crate::normalize::normalize_url(trimmed) else {
            continue;
        };
        if seen.insert(key.clone()) {
            found.push(key);
            if found.len() >= MAX_URLS_PER_MESSAGE {
                break;
            }
        }
    }
    found
}

fn find_scheme(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let http = lower.find("http://");
    let https = lower.find("https://");
    match (http, https) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn take_url(s: &str) -> &str {
    let end = s
        .char_indices()
        .find(|(_, c)| c.is_whitespace() || "<>\"'[]{}|\\".contains(*c))
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    &s[..end]
}

fn trim_trailing_punct(url: &str) -> &str {
    url.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']'])
}

fn strip_code(body: &str) -> String {
    let without_fences = strip_fences(body);
    strip_inline(&without_fences)
}

fn strip_fences(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 3..];
        match rest.find("```") {
            Some(end) => rest = &rest[end + 3..],
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn strip_inline(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '`' {
            for next in chars.by_ref() {
                if next == '`' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_three_and_drops_the_fourth() {
        let body = "\
a https://one.example/a \
b https://two.example/b \
c https://three.example/c \
d https://four.example/d";
        let urls = extract_urls(body);
        assert_eq!(urls.len(), 3);
        assert!(urls.iter().all(|u| !u.contains("four")));
    }

    #[test]
    fn skips_fenced_and_inline_code() {
        let body =
            "see ```\nhttps://secret.example/in-fence\n``` and `https://secret.example/inline` \
plus https://public.example/ok";
        let urls = extract_urls(body);
        assert_eq!(urls, vec!["https://public.example/ok".to_string()]);
    }

    #[test]
    fn skips_bare_emails() {
        let body = "write me at person@company.example or https://company.example/about";
        let urls = extract_urls(body);
        assert_eq!(urls, vec!["https://company.example/about".to_string()]);
        assert!(!urls.iter().any(|u| u.contains("person@")));
    }

    #[test]
    fn strips_trailing_punctuation_and_dedupes() {
        let body = "link https://Example.COM/Path. and again https://example.com/Path";
        let urls = extract_urls(body);
        assert_eq!(urls, vec!["https://example.com/Path".to_string()]);
    }
}
