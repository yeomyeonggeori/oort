//! From a fetched page to the fields of one link card (ADR-0170 amendment D6–D12).
//!
//! Pure: bytes in, fields out. No network and no database, so every rule here is a unit test.
//! The worker fetches the HTML under [`crate::fetch::SafeUnfurlTransport`], hands the response to
//! [`build_card`], and stores whatever comes back.
//!
//! Two layers keep a hostile page from aiming the server at an address it should not dial:
//! * here, **before anything is stored**: a resolved picture or icon address must pass the
//!   literal half of the outbound policy ([`momo_webhook::validated_url`]: http(s) only, no
//!   credentials, no private/loopback/link-local literal, https only in production), and an icon
//!   must also be on port 443. A candidate that fails is dropped and the next one is tried. No
//!   DNS happens here.
//! * at **fetch time**, the transport's guard, unchanged: every hop, public addresses only, the
//!   connection pinned to the checked address, redirects re-checked.

use crate::charset::decode_html;
use crate::normalize::normalize_url;
use crate::parse::parse_card;
use crate::store::domain_of;

/// Longest stored address; the migration's CHECK says the same.
const MAX_ADDRESS_BYTES: usize = 2048;

/// What the worker stores for one fetched page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardFields {
    pub title: Option<String>,
    pub description: Option<String>,
    pub domain: Option<String>,
    pub site_name: Option<String>,
    /// Remote picture address, resolved and checked. Never sent to a client.
    pub image_url: Option<String>,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    /// Remote icon address, resolved and checked. Never sent to a client.
    pub icon_url: Option<String>,
    pub is_video: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AssetKind {
    Image,
    Icon,
}

/// Decode, parse and resolve one fetched page. `None` means the page gave nothing a card can show
/// (no title and no picture): the caller records a quiet `failed` row instead of a card (D11).
pub fn build_card(
    final_url: &str,
    content_type: &str,
    body: &[u8],
    allow_development_http: bool,
) -> Option<CardFields> {
    let html = decode_html(content_type, body);
    let parsed = parse_card(&html);
    let resolve =
        |raw: &str, kind: AssetKind| resolve_asset(final_url, raw, kind, allow_development_http);

    let image_url = parsed
        .image_url
        .as_deref()
        .and_then(|raw| resolve(raw, AssetKind::Image));
    // A size describes the picture it was declared for. If that picture is not usable the size
    // goes with it.
    let (image_width, image_height) =
        match (image_url.is_some(), parsed.image_width, parsed.image_height) {
            (true, Some(width), Some(height)) => {
                (i32::try_from(width).ok(), i32::try_from(height).ok())
            }
            _ => (None, None),
        };
    if parsed.title.is_none() && image_url.is_none() {
        return None;
    }
    // apple-touch-icon, then icon (the parser already ordered them), then the site's own
    // /favicon.ico. The first one that passes the checks wins.
    let icon_url = parsed
        .icon_hrefs
        .iter()
        .find_map(|href| resolve(href, AssetKind::Icon))
        .or_else(|| resolve("/favicon.ico", AssetKind::Icon));
    Some(CardFields {
        title: parsed.title,
        description: parsed.description,
        domain: domain_of(final_url),
        site_name: parsed.site_name,
        image_url,
        image_width,
        image_height,
        icon_url,
        is_video: parsed.is_video,
    })
}

/// Resolve `raw` against the final page address and refuse it unless it is a public-looking
/// http(s) address the fetch guard would accept the shape of. `None` means "not usable".
pub(crate) fn resolve_asset(
    page_url: &str,
    raw: &str,
    kind: AssetKind,
    allow_development_http: bool,
) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let joined = url::Url::parse(page_url).ok()?.join(raw).ok()?;
    let normalized = normalize_url(joined.as_str()).ok()?;
    if normalized.len() > MAX_ADDRESS_BYTES {
        return None;
    }
    // The literal half of the outbound policy, on the address **after** resolution: this is where
    // `//169.254.169.254/x.png` and `/../..` tricks that change the host are caught.
    let checked = momo_webhook::validated_url(&normalized, allow_development_http).ok()?;
    if kind == AssetKind::Icon && checked.port.is_some_and(|port| port != 443) {
        return None;
    }
    Some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://news.example/a/b/story?id=7";

    fn card_of(html: &str) -> Option<CardFields> {
        build_card(PAGE, "text/html; charset=utf-8", html.as_bytes(), false)
    }

    #[test]
    fn a_full_page_fills_every_field() {
        let html = r#"<head>
          <title>Fallback</title>
          <meta property="og:title" content="Headline">
          <meta property="og:description" content="Lead sentence.">
          <meta property="og:site_name" content="News Example">
          <meta property="og:image" content="https://cdn.example/hero.png">
          <meta property="og:image:width" content="1200">
          <meta property="og:image:height" content="630">
          <meta property="og:type" content="video.other">
          <link rel="icon" href="/favicon-32.png">
          <link rel="apple-touch-icon" href="/touch.png">
        </head>"#;
        let card = card_of(html).expect("a card");
        assert_eq!(card.title.as_deref(), Some("Headline"));
        assert_eq!(card.description.as_deref(), Some("Lead sentence."));
        assert_eq!(card.domain.as_deref(), Some("news.example"));
        assert_eq!(card.site_name.as_deref(), Some("News Example"));
        assert_eq!(
            card.image_url.as_deref(),
            Some("https://cdn.example/hero.png")
        );
        assert_eq!(
            (card.image_width, card.image_height),
            (Some(1200), Some(630))
        );
        assert_eq!(
            card.icon_url.as_deref(),
            Some("https://news.example/touch.png"),
            "apple-touch-icon beats icon"
        );
        assert!(card.is_video);
    }

    /// The contract's 「빠진 항목 조합별」 table at the card level: a card exists exactly when
    /// there is a title or a picture. Description, site name, icon alone never make one.
    #[test]
    fn a_card_needs_a_title_or_a_picture() {
        let og =
            |name: &str, content: &str| format!(r#"<meta property="{name}" content="{content}">"#);
        let title = og("og:title", "T");
        let image = og("og:image", "/hero.png");
        let description = og("og:description", "D");
        let site = og("og:site_name", "S");
        let icon = r#"<link rel="icon" href="/i.png">"#;

        assert!(card_of(&format!("{title}{image}{description}{site}{icon}")).is_some());
        assert!(
            card_of(&format!("{title}{description}")).is_some(),
            "title only"
        );
        assert!(card_of(&image).is_some(), "picture only");
        for (label, html) in [
            ("nothing", String::new()),
            ("description only", description.clone()),
            ("site name only", site.clone()),
            ("icon only", icon.to_string()),
            (
                "description, site name and icon",
                format!("{description}{site}{icon}"),
            ),
            (
                "a picture that is not usable",
                og("og:image", "//127.0.0.1/x.png"),
            ),
            ("an empty title", og("og:title", "   ")),
        ] {
            assert!(card_of(&html).is_none(), "{label} must end quietly");
        }
        // A title makes a card even when every optional piece is missing.
        let only = card_of(&title).unwrap();
        assert_eq!(only.title.as_deref(), Some("T"));
        assert_eq!(
            (only.description, only.site_name, only.image_url),
            (None, None, None)
        );
        assert!(!only.is_video);
    }

    #[test]
    fn relative_pictures_and_icons_resolve_against_the_final_page_address() {
        let html = r#"
          <meta property="og:title" content="T">
          <meta property="og:image" content="../img/hero.png?x=1&amp;y=2">
          <link rel="icon" href="../../static/icon.png">"#;
        let card = card_of(html).unwrap();
        assert_eq!(
            card.image_url.as_deref(),
            Some("https://news.example/a/img/hero.png?x=1&y=2")
        );
        assert_eq!(
            card.icon_url.as_deref(),
            Some("https://news.example/static/icon.png")
        );
        for (raw, expected) in [
            ("/root.png", "https://news.example/root.png"),
            ("sibling.png", "https://news.example/a/b/sibling.png"),
            ("//cdn.example/p.png", "https://cdn.example/p.png"),
            (
                "https://other.example/abs.png#frag",
                "https://other.example/abs.png",
            ),
            ("  /padded.png ", "https://news.example/padded.png"),
        ] {
            assert_eq!(
                resolve_asset(PAGE, raw, AssetKind::Image, false).as_deref(),
                Some(expected),
                "{raw}"
            );
        }
        // After a redirect the base is the page where we ended up, not the link in the message.
        let moved = build_card(
            "https://moved.example/new/place",
            "text/html",
            br#"<meta property="og:title" content="T"><meta property="og:image" content="pic.png">"#,
            false,
        )
        .unwrap();
        assert_eq!(
            moved.image_url.as_deref(),
            Some("https://moved.example/new/pic.png")
        );
    }

    /// 「상대 주소 풀이 뒤 검사」: a value that LOOKS relative can still change the host. The check
    /// runs on the resolved address, so each of these is dropped.
    #[test]
    fn a_resolved_address_that_lands_on_a_private_host_is_dropped() {
        for raw in [
            "//127.0.0.1/x.png",
            "//127.0.0.1:8080/x.png",
            "//169.254.169.254/latest/meta-data/",
            "//10.0.0.7/x.png",
            "//192.168.1.1/x.png",
            "//172.16.0.9/x.png",
            "//[::1]/x.png",
            "//[fe80::1]/x.png",
            "//[fd00::1]/x.png",
            "//[::ffff:7f00:1]/x.png",
            "//localhost/x.png",
            "http://127.0.0.1/x.png",
            "https://127.0.0.1/x.png",
            "https://[::1]/x.png",
            "https://user:secret@news.example/x.png",
            "http://news.example/downgrade.png",
            "ftp://news.example/x.png",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "file:///etc/passwd",
            "mailto:a@b.example",
            "",
            "   ",
        ] {
            assert_eq!(
                resolve_asset(PAGE, raw, AssetKind::Image, false),
                None,
                "{raw} must not be stored as a picture address"
            );
            assert_eq!(
                resolve_asset(PAGE, raw, AssetKind::Icon, false),
                None,
                "{raw} must not be stored as an icon address"
            );
        }
        // Through the whole card: the card stands on its title, the bad picture is simply absent.
        let html = r#"<meta property="og:title" content="T">
            <meta property="og:image" content="//169.254.169.254/latest/meta-data/">"#;
        let card = card_of(html).unwrap();
        assert_eq!(card.image_url, None);
        // And a size declared for a dropped picture is dropped with it.
        let html = r#"<meta property="og:title" content="T">
            <meta property="og:image" content="//10.0.0.7/x.png">
            <meta property="og:image:width" content="100"><meta property="og:image:height" content="50">"#;
        let card = card_of(html).unwrap();
        assert_eq!(
            (card.image_url, card.image_width, card.image_height),
            (None, None, None)
        );
    }

    #[test]
    fn plain_http_is_only_a_development_allowance() {
        let page = "http://dev.example/page";
        assert_eq!(
            resolve_asset(page, "/a.png", AssetKind::Image, false),
            None,
            "production never stores an http address"
        );
        assert_eq!(
            resolve_asset(page, "/a.png", AssetKind::Image, true).as_deref(),
            Some("http://dev.example/a.png")
        );
        // The development allowance never reaches a private literal.
        assert_eq!(
            resolve_asset(page, "//127.0.0.1/a.png", AssetKind::Image, true),
            None
        );
        assert_eq!(
            resolve_asset(page, "//169.254.169.254/a", AssetKind::Image, true),
            None
        );
    }

    #[test]
    fn an_icon_is_on_port_443_a_picture_may_not_be() {
        assert_eq!(
            resolve_asset(
                PAGE,
                "https://cdn.example:8443/p.png",
                AssetKind::Image,
                false
            )
            .as_deref(),
            Some("https://cdn.example:8443/p.png"),
            "pictures keep their current rule"
        );
        assert_eq!(
            resolve_asset(
                PAGE,
                "https://cdn.example:8443/i.png",
                AssetKind::Icon,
                false
            ),
            None
        );
        assert_eq!(
            resolve_asset(
                PAGE,
                "https://cdn.example:443/i.png",
                AssetKind::Icon,
                false
            )
            .as_deref(),
            Some("https://cdn.example/i.png"),
            "an explicit 443 is the default port"
        );
        // The bad candidate is skipped and the next one is used; with none left, /favicon.ico.
        let html = r#"<meta property="og:title" content="T">
            <link rel="apple-touch-icon" href="https://cdn.example:8443/touch.png">
            <link rel="icon" href="//127.0.0.1/i.png">
            <link rel="icon" href="data:image/png;base64,AAAA">
            <link rel="shortcut icon" href="/real.ico">"#;
        assert_eq!(
            card_of(html).unwrap().icon_url.as_deref(),
            Some("https://news.example/real.ico")
        );
        let html = r#"<meta property="og:title" content="T">
            <link rel="icon" href="//127.0.0.1/i.png">"#;
        assert_eq!(
            card_of(html).unwrap().icon_url.as_deref(),
            Some("https://news.example/favicon.ico"),
            "no declared icon is usable: the site's own /favicon.ico"
        );
        // A page that itself lives on another port has no usable /favicon.ico either.
        let on_8443 = build_card(
            "https://news.example:8443/page",
            "text/html",
            br#"<meta property="og:title" content="T">"#,
            false,
        )
        .unwrap();
        assert_eq!(on_8443.icon_url, None);
    }

    #[test]
    fn the_favicon_fallback_and_svg_skipping() {
        let html = r#"<meta property="og:title" content="T">"#;
        assert_eq!(
            card_of(html).unwrap().icon_url.as_deref(),
            Some("https://news.example/favicon.ico")
        );
        let html = r#"<meta property="og:title" content="T">
            <link rel="icon" type="image/svg+xml" href="/icon.svg">
            <link rel="icon" href="/icon.png">"#;
        assert_eq!(
            card_of(html).unwrap().icon_url.as_deref(),
            Some("https://news.example/icon.png")
        );
    }

    #[test]
    fn an_euc_kr_page_reads_in_korean() {
        use encoding_rs::EUC_KR;
        let (title, _, _) = EUC_KR.encode("한글 제목");
        let (description, _, _) = EUC_KR.encode("본문 요약입니다");
        let (site, _, _) = EUC_KR.encode("오르트 뉴스");
        let mut body = br#"<html><head><meta http-equiv="Content-Type" content="text/html; charset=euc-kr"><meta property="og:title" content=""#.to_vec();
        body.extend_from_slice(&title);
        body.extend_from_slice(br#"" /><meta property="og:description" content=""#);
        body.extend_from_slice(&description);
        body.extend_from_slice(br#"" /><meta property="og:site_name" content=""#);
        body.extend_from_slice(&site);
        body.extend_from_slice(br#"" /></head></html>"#);
        for content_type in ["text/html; charset=euc-kr", "text/html"] {
            let card = build_card(PAGE, content_type, &body, false).unwrap();
            assert_eq!(card.title.as_deref(), Some("한글 제목"), "{content_type}");
            assert_eq!(card.description.as_deref(), Some("본문 요약입니다"));
            assert_eq!(card.site_name.as_deref(), Some("오르트 뉴스"));
        }
    }

    #[test]
    fn a_long_address_that_the_column_could_not_hold_is_dropped() {
        let long = format!("/{}", "a".repeat(2100));
        assert_eq!(resolve_asset(PAGE, &long, AssetKind::Image, false), None);
        let fits = format!("/{}", "a".repeat(1900));
        assert!(resolve_asset(PAGE, &fits, AssetKind::Image, false).is_some());
    }
}
