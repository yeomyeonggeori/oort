//! Cache key for a URL: lowercase host, no fragment, no default port, no
//! trailing slash on a bare path. Query strings stay — two URLs that differ
//! only by `?ref=` are different pages.

use momo_webhook::parse_outbound_url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum NormalizeError {
    #[error("not an absolute http(s) URL")]
    Invalid,
}

/// Normalise for the cache key and for SSRF input. `http` is accepted here
/// (shape only); the fetch guard still refuses it in production.
pub fn normalize_url(raw: &str) -> Result<String, NormalizeError> {
    // Fragments never hit the wire. Strip them before the outbound parser,
    // which refuses `#` so a stored destination stays honest.
    let trimmed = raw
        .trim()
        .split_once('#')
        .map(|(head, _)| head)
        .unwrap_or(raw.trim());
    let parsed = parse_outbound_url(trimmed, true).map_err(|_| NormalizeError::Invalid)?;
    if parsed.host.is_empty() {
        return Err(NormalizeError::Invalid);
    }
    let path = trim_trailing_slash_on_path(&parsed.path_and_query);
    let host = display_host(&parsed.host);
    let default_port = parsed.scheme == "https" && parsed.port == Some(443)
        || parsed.scheme == "http" && parsed.port == Some(80);
    let absolute = match parsed.port {
        Some(port) if !default_port => {
            format!("{}://{host}:{port}{path}", parsed.scheme)
        }
        _ => format!("{}://{host}{path}", parsed.scheme),
    };
    Ok(absolute)
}

fn trim_trailing_slash_on_path(path_and_query: &str) -> String {
    match path_and_query.split_once('?') {
        Some((path, query)) if path != "/" && path.ends_with('/') => {
            format!("{}?{query}", path.trim_end_matches('/'))
        }
        None if path_and_query.ends_with('/') && path_and_query != "/" => {
            path_and_query.trim_end_matches('/').to_string()
        }
        _ => path_and_query.to_string(),
    }
}

fn display_host(host: &str) -> String {
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_host_and_drops_fragment_and_default_port() {
        assert_eq!(
            normalize_url("HTTPS://Example.COM:443/a/b#frag").unwrap(),
            "https://example.com/a/b"
        );
        assert_eq!(
            normalize_url("https://example.com/").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_url("https://example.com/path/").unwrap(),
            "https://example.com/path"
        );
    }

    #[test]
    fn keeps_query_string() {
        assert_eq!(
            normalize_url("https://example.com/a?x=1&y=2").unwrap(),
            "https://example.com/a?x=1&y=2"
        );
    }

    #[test]
    fn refuses_non_http() {
        assert!(normalize_url("ftp://example.com/a").is_err());
        assert!(normalize_url("/relative").is_err());
        assert!(normalize_url("mailto:a@b.com").is_err());
    }
}
