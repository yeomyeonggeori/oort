//! OG tags first, Twitter card second, `<title>` / `name=description` last
//! (ADR-0170 + the 2026-10-31 amendment D6/D7/D9/D12).
//!
//! This is a small forgiving tag scanner, not an HTML parser. It finds `<meta>`, `<link>` and the
//! first `<title>`, skips comments and `<script>`/`<style>` bodies, and reads attributes with
//! quotes honoured, so a `>` inside `content="Q > A"` does not cut the tag. One forward pass: the
//! cursor only ever moves ahead, so a hostile page cannot make it quadratic.
//!
//! Everything here is text in, text out. Resolving addresses, the safety checks and the charset
//! live next to it ([`crate::card`], [`crate::charset`]).

pub const TITLE_MAX: usize = 180;
pub const DESC_MAX: usize = 280;
pub const SITE_NAME_MAX: usize = 100;
/// Largest picture side the card will carry (the migration's CHECK says the same).
pub const IMAGE_DIMENSION_MAX: u32 = 16_384;
/// Icon links kept per class. A page with a thousand `<link>`s is not an icon list.
const MAX_ICON_CANDIDATES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedCard {
    pub title: Option<String>,
    pub description: Option<String>,
    /// Raw, unresolved. The card layer resolves it against the final page address.
    pub image_url: Option<String>,
    pub site_name: Option<String>,
    /// og:image:width / height of the first og:image, as a valid pair or not at all.
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub is_video: bool,
    /// Raw `href`s in preference order: every apple-touch-icon in document order, then every
    /// icon. SVG icons are left out (the icon proxy does not serve SVG).
    pub icon_hrefs: Vec<String>,
}

/// Parse a decoded HTML document for a link card.
pub fn parse_card(html: &str) -> ParsedCard {
    let mut scan = Scan::default();
    for_each_tag(html, &["meta", "link", "title"], |tag| match tag.name {
        "meta" => scan.meta(tag),
        "link" => scan.link(tag),
        "title" if scan.html_title.is_none() => scan.html_title = title_text(tag.rest),
        _ => {}
    });
    scan.finish()
}

#[derive(Default)]
struct Scan {
    og_title: Option<String>,
    og_description: Option<String>,
    og_site_name: Option<String>,
    og_image: Option<String>,
    og_image_groups: u32,
    og_width: Option<u32>,
    og_height: Option<u32>,
    og_type_video: bool,
    twitter_title: Option<String>,
    twitter_description: Option<String>,
    twitter_image: Option<String>,
    twitter_player: bool,
    named_description: Option<String>,
    html_title: Option<String>,
    apple_icons: Vec<String>,
    icons: Vec<String>,
}

impl Scan {
    fn meta(&mut self, tag: &Tag<'_>) {
        let key = tag.attr("property").or_else(|| tag.attr("name"));
        let (Some(key), Some(content)) = (key, tag.attr("content")) else {
            return;
        };
        let key = key.trim().to_ascii_lowercase();
        match key.as_str() {
            // Text: the last non-empty value wins (unchanged since ADR-0170).
            "og:title" => set_text(&mut self.og_title, content),
            "og:description" => set_text(&mut self.og_description, content),
            "og:site_name" => set_text(&mut self.og_site_name, content),
            "twitter:title" => set_text(&mut self.twitter_title, content),
            "twitter:description" => set_text(&mut self.twitter_description, content),
            "description" => set_text(&mut self.named_description, content),
            // Addresses: the first non-empty value wins.
            "og:image" => {
                self.og_image_groups += 1;
                set_first_address(&mut self.og_image, content);
            }
            "og:image:secure_url" => set_first_address(&mut self.og_image, content),
            "twitter:image" | "twitter:image:src" => {
                set_first_address(&mut self.twitter_image, content)
            }
            // The size belongs to the first picture's group: before the second og:image.
            "og:image:width" if self.og_image_groups <= 1 && self.og_width.is_none() => {
                self.og_width = dimension(content);
            }
            "og:image:height" if self.og_image_groups <= 1 && self.og_height.is_none() => {
                self.og_height = dimension(content);
            }
            "og:type"
                if decode_entities(content)
                    .trim()
                    .to_ascii_lowercase()
                    .starts_with("video.") =>
            {
                self.og_type_video = true;
            }
            "twitter:card"
                if decode_entities(content)
                    .trim()
                    .eq_ignore_ascii_case("player") =>
            {
                self.twitter_player = true;
            }
            _ => {}
        }
    }

    fn link(&mut self, tag: &Tag<'_>) {
        let (Some(rel), Some(href)) = (tag.attr("rel"), tag.attr("href")) else {
            return;
        };
        let href = decode_entities(href);
        let href = href.trim();
        if href.is_empty() || looks_like_svg(tag.attr("type"), href) {
            return;
        }
        let (mut apple, mut icon) = (false, false);
        for token in rel.split_ascii_whitespace() {
            match token.to_ascii_lowercase().as_str() {
                "apple-touch-icon" | "apple-touch-icon-precomposed" => apple = true,
                "icon" => icon = true,
                _ => {}
            }
        }
        if apple {
            if self.apple_icons.len() < MAX_ICON_CANDIDATES {
                self.apple_icons.push(href.to_string());
            }
        } else if icon && self.icons.len() < MAX_ICON_CANDIDATES {
            self.icons.push(href.to_string());
        }
    }

    fn finish(self) -> ParsedCard {
        let title = self.og_title.or(self.twitter_title).or(self.html_title);
        // D7: a description that repeats the title says nothing. Compared after cleaning, before
        // the cut, so a long title that is also the description is still recognised.
        let description = self
            .og_description
            .or(self.twitter_description)
            .or(self.named_description)
            .filter(|description| title.as_deref() != Some(description.as_str()));
        let from_og = self.og_image.is_some();
        let image_url = self.og_image.or(self.twitter_image);
        let (image_width, image_height) = match (from_og, self.og_width, self.og_height) {
            (true, Some(width), Some(height)) => (Some(width), Some(height)),
            _ => (None, None),
        };
        let mut icon_hrefs = self.apple_icons;
        icon_hrefs.extend(self.icons);
        ParsedCard {
            title: title.map(|value| clip(&value, TITLE_MAX)),
            description: description.map(|value| clip(&value, DESC_MAX)),
            image_url,
            site_name: self.og_site_name.map(|value| clip(&value, SITE_NAME_MAX)),
            image_width,
            image_height,
            is_video: self.og_type_video || self.twitter_player,
            icon_hrefs,
        }
    }
}

fn set_text(slot: &mut Option<String>, raw: &str) {
    let cleaned = clean_text(raw);
    if !cleaned.is_empty() {
        *slot = Some(cleaned);
    }
}

fn set_first_address(slot: &mut Option<String>, raw: &str) {
    if slot.is_some() {
        return;
    }
    let decoded = decode_entities(raw);
    let trimmed = decoded.trim();
    if !trimmed.is_empty() {
        *slot = Some(trimmed.to_string());
    }
}

/// A positive whole number no larger than [`IMAGE_DIMENSION_MAX`], digits only.
fn dimension(raw: &str) -> Option<u32> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number: u32 = value.parse().ok()?;
    (1..=IMAGE_DIMENSION_MAX)
        .contains(&number)
        .then_some(number)
}

fn looks_like_svg(type_attr: Option<&str>, href: &str) -> bool {
    if type_attr.is_some_and(|value| value.to_ascii_lowercase().contains("svg")) {
        return true;
    }
    let path = href.split(['?', '#']).next().unwrap_or(href);
    path.to_ascii_lowercase().ends_with(".svg")
}

/// Entities decoded once, control characters and whitespace runs collapsed to one space, ends
/// trimmed. Empty means "no value".
pub(crate) fn clean_text(raw: &str) -> String {
    let decoded = decode_entities(raw);
    let mut out = String::with_capacity(decoded.len());
    let mut pending_space = false;
    for c in decoded.chars() {
        if c.is_whitespace() || c.is_control() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Cut to `max` characters (not bytes), no ellipsis, then drop a space the cut may leave.
pub(crate) fn clip(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let cut: String = value.chars().take(max).collect();
    cut.trim_end().to_string()
}

/// One pass: `&amp;lt;` is `&lt;`, not `<`. Named: amp lt gt quot apos nbsp. Numeric: `&#N;` and
/// `&#xH;`. Anything else, and a reference with no `;` close by, stays as written.
pub(crate) fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        match decode_one_entity(tail) {
            Some((decoded, consumed)) => {
                out.push(decoded);
                rest = &tail[consumed..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_one_entity(tail: &str) -> Option<(char, usize)> {
    let bytes = tail.as_bytes();
    let window = &bytes[..bytes.len().min(12)];
    let semi = window.iter().position(|&byte| byte == b';')?;
    let body = &tail[1..semi];
    let decoded = match body {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        _ => {
            let number = body.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse::<u32>().ok()?,
            };
            char::from_u32(code)?
        }
    };
    Some((decoded, semi + 1))
}

/// The text of the first `<title>`, cleaned. `rest` is the document after the opening tag.
fn title_text(rest: &str) -> Option<String> {
    let end = find_ci(rest, "</title", 0)?;
    let cleaned = clean_text(&rest[..end]);
    (!cleaned.is_empty()).then_some(cleaned)
}

// ---------------------------------------------------------------------------
// tag scanner
// ---------------------------------------------------------------------------

/// A tag the scanner stopped at.
pub(crate) struct Tag<'a> {
    /// The entry of the wanted list this tag matched (lowercase).
    pub name: &'static str,
    attrs: Vec<(String, String)>,
    /// The document after the tag's closing `>`.
    pub rest: &'a str,
}

impl Tag<'_> {
    /// The first attribute of that lowercase name, entities not decoded. A bare attribute is `""`.
    pub(crate) fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Call `on_tag` for every `wanted` tag in document order. Comments and `<script>`/`<style>`
/// bodies are skipped; a tag that never closes ends the scan.
pub(crate) fn for_each_tag<'a>(
    html: &'a str,
    wanted: &[&'static str],
    mut on_tag: impl FnMut(&Tag<'a>),
) {
    let mut at = 0;
    while let Some(relative) = html[at..].find('<') {
        let start = at + relative;
        let from_lt = &html[start..];
        if let Some(body) = from_lt.strip_prefix("<!--") {
            match body.find("-->") {
                Some(end) => {
                    at = start + 4 + end + 3;
                    continue;
                }
                None => return,
            }
        }
        let name_len = from_lt[1..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric())
            .count();
        let after_name = 1 + name_len;
        let at_boundary = match from_lt.as_bytes().get(after_name) {
            None => false,
            Some(byte) => byte.is_ascii_whitespace() || *byte == b'/' || *byte == b'>',
        };
        if name_len == 0 || !at_boundary {
            at = start + 1;
            continue;
        }
        let name = &from_lt[1..after_name];
        if name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style") {
            let closing = format!("</{}", name.to_ascii_lowercase());
            match find_ci(html, &closing, start + after_name) {
                Some(end) => {
                    at = end + closing.len();
                    continue;
                }
                None => return,
            }
        }
        let Some(&matched) = wanted.iter().find(|w| w.eq_ignore_ascii_case(name)) else {
            at = start + after_name;
            continue;
        };
        let Some(end) = tag_end(from_lt) else {
            return;
        };
        let attrs = parse_attrs(&from_lt[after_name..end]);
        on_tag(&Tag {
            name: matched,
            attrs,
            rest: &from_lt[end + 1..],
        });
        at = start + end + 1;
    }
}

/// Offset of the `>` that closes the tag starting at `from_lt[0] == '<'`: the first one outside a
/// quoted attribute value. A quote opens only right after `=`, so an apostrophe in a bare word
/// does not swallow the document.
fn tag_end(from_lt: &str) -> Option<usize> {
    let mut quote: Option<u8> = None;
    let mut previous = 0u8;
    for (offset, &byte) in from_lt.as_bytes().iter().enumerate().skip(1) {
        match quote {
            Some(open) => {
                if byte == open {
                    quote = None;
                    previous = byte;
                }
            }
            None => match byte {
                b'>' => return Some(offset),
                b'"' | b'\'' if previous == b'=' => quote = Some(byte),
                _ if byte.is_ascii_whitespace() => {}
                _ => previous = byte,
            },
        }
    }
    None
}

fn parse_attrs(text: &str) -> Vec<(String, String)> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < len {
        while i < len && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        if i >= len {
            break;
        }
        let name_start = i;
        while i < len && !bytes[i].is_ascii_whitespace() && bytes[i] != b'=' && bytes[i] != b'/' {
            i += 1;
        }
        let name = text[name_start..i].to_ascii_lowercase();
        let mut j = i;
        while j < len && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < len && bytes[j] == b'=' {
            j += 1;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < len && (bytes[j] == b'"' || bytes[j] == b'\'') {
                let quote = bytes[j];
                let value_start = j + 1;
                let value_end = bytes[value_start..]
                    .iter()
                    .position(|&byte| byte == quote)
                    .map_or(len, |found| value_start + found);
                out.push((name, text[value_start..value_end].to_string()));
                i = (value_end + 1).min(len);
            } else {
                let value_start = j;
                while j < len && !bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                out.push((name, text[value_start..j].to_string()));
                i = j;
            }
        } else {
            out.push((name, String::new()));
            i = j;
        }
    }
    out
}

/// ASCII case-insensitive `find` starting at byte offset `from`.
fn find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let needle = needle.as_bytes();
    haystack
        .as_bytes()
        .get(from..)?
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
        .map(|found| from + found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_og_over_twitter_over_title() {
        let html = r#"
        <html><head>
          <title>Fallback</title>
          <meta name="twitter:title" content="Twitter">
          <meta property="og:title" content="OG &amp; friends">
          <meta property="og:description" content="hello">
          <meta property="og:image" content="https://cdn.example/a.png">
        </head></html>
        "#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("OG & friends"));
        assert_eq!(card.description.as_deref(), Some("hello"));
        assert_eq!(card.image_url.as_deref(), Some("https://cdn.example/a.png"));
    }

    #[test]
    fn twitter_fills_gaps() {
        let html = r#"
        <meta name="twitter:title" content="Tw">
        <meta name="twitter:description" content="td">
        <meta name="twitter:image" content="https://cdn.example/t.png">
        "#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("Tw"));
        assert_eq!(card.description.as_deref(), Some("td"));
        assert_eq!(card.image_url.as_deref(), Some("https://cdn.example/t.png"));
    }

    #[test]
    fn empty_html_is_an_empty_card() {
        let card = parse_card("<html></html>");
        assert_eq!(card, ParsedCard::default());
    }

    /// D7 / "빠진 항목 조합별 결과": every present-or-missing combination of title, description and
    /// picture, each from the og source (so the fallbacks never fill the gap) — and the same
    /// three fed by the lower-priority sources.
    #[test]
    fn every_missing_item_combination_yields_exactly_what_is_there() {
        for mask in 0u8..8 {
            let (has_title, has_description, has_image) =
                (mask & 1 != 0, mask & 2 != 0, mask & 4 != 0);
            let mut html = String::from("<head>");
            if has_title {
                html.push_str(r#"<meta property="og:title" content="T">"#);
            }
            if has_description {
                html.push_str(r#"<meta property="og:description" content="D">"#);
            }
            if has_image {
                html.push_str(r#"<meta property="og:image" content="/i.png">"#);
            }
            let card = parse_card(&html);
            assert_eq!(
                card.title.as_deref(),
                has_title.then_some("T"),
                "mask {mask}"
            );
            assert_eq!(
                card.description.as_deref(),
                has_description.then_some("D"),
                "mask {mask}"
            );
            assert_eq!(
                card.image_url.as_deref(),
                has_image.then_some("/i.png"),
                "mask {mask}"
            );
        }
        // The lower sources fill the same three slots, in order.
        let html = r#"<title>From title tag</title>
            <meta name="description" content="From name description">
            <meta name="twitter:image:src" content="/t.png">"#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("From title tag"));
        assert_eq!(card.description.as_deref(), Some("From name description"));
        assert_eq!(card.image_url.as_deref(), Some("/t.png"));
        // An og value that is empty after cleaning is a missing value, not a winner.
        let html = r#"<meta property="og:title" content="  ">
            <meta property="og:image" content="">
            <meta name="twitter:title" content="Tw">
            <meta name="twitter:image" content="/t.png">"#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("Tw"));
        assert_eq!(card.image_url.as_deref(), Some("/t.png"));
    }

    #[test]
    fn the_caps_are_180_280_and_100_characters_and_whitespace_collapses() {
        let long = |n: usize| "가".repeat(n);
        let html = format!(
            r#"<meta property="og:title" content="{}">
               <meta property="og:description" content="{}">
               <meta property="og:site_name" content="{}">"#,
            long(181),
            long(281),
            long(101)
        );
        let card = parse_card(&html);
        assert_eq!(card.title.unwrap().chars().count(), 180);
        assert_eq!(card.description.unwrap().chars().count(), 280);
        assert_eq!(card.site_name.unwrap().chars().count(), 100);
        // Exactly at the cap is untouched.
        let html = format!(r#"<meta property="og:title" content="{}">"#, long(180));
        assert_eq!(parse_card(&html).title.unwrap().chars().count(), 180);

        let html = "<meta property=\"og:title\" content=\"  a \n\t b\u{a0}\u{a0}c  \">\
                    <meta property=\"og:description\" content=\"x\u{0}y\u{7}z\">";
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("a b c"));
        assert_eq!(
            card.description.as_deref(),
            Some("x y z"),
            "controls are separators"
        );
        // A cut that lands after a space leaves no trailing space.
        let html = format!(
            r#"<meta property="og:title" content="{} {}">"#,
            "a".repeat(179),
            "b".repeat(10)
        );
        assert_eq!(parse_card(&html).title.unwrap(), "a".repeat(179));
    }

    #[test]
    fn a_description_that_repeats_the_title_is_dropped() {
        let html = r#"<meta property="og:title" content="Same   words">
                      <meta property="og:description" content=" Same words ">"#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("Same words"));
        assert_eq!(card.description, None);
        // A different description stays; so does one that merely contains the title.
        let html = r#"<meta property="og:title" content="Same">
                      <meta property="og:description" content="Same and more">"#;
        assert_eq!(
            parse_card(html).description.as_deref(),
            Some("Same and more")
        );
        // A long title that is also the description is recognised before the cut.
        let long = "x".repeat(300);
        let html = format!(
            r#"<meta property="og:title" content="{long}">
               <meta property="og:description" content="{long}">"#
        );
        let card = parse_card(&html);
        assert_eq!(card.title.unwrap().chars().count(), 180);
        assert_eq!(card.description, None);
    }

    #[test]
    fn entities_are_decoded_once() {
        let html = r#"<meta property="og:title" content="&amp;lt; &lt;b&gt; &#44032;&#xB098; &#39;q&#39; &quot;x&quot; &bogus; &amp">"#;
        let card = parse_card(html);
        assert_eq!(
            card.title.as_deref(),
            Some("&lt; <b> 가나 'q' \"x\" &bogus; &amp"),
            "&amp;lt; is the text &lt;, never <"
        );
    }

    #[test]
    fn a_greater_than_inside_a_quoted_value_does_not_cut_the_tag() {
        let html = r#"<meta property="og:title" content="홈 > 뉴스 > 오늘">
                      <meta property='og:site_name' content='A > B'>
                      <meta property=og:image content=https://cdn.example/a/b.png>"#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("홈 > 뉴스 > 오늘"));
        assert_eq!(card.site_name.as_deref(), Some("A > B"));
        assert_eq!(
            card.image_url.as_deref(),
            Some("https://cdn.example/a/b.png"),
            "an unquoted address keeps its slashes"
        );
    }

    #[test]
    fn comments_scripts_and_styles_do_not_feed_the_card() {
        let html = r#"<!-- <meta property="og:title" content="Commented out"> -->
            <script>var s = '<meta property="og:title" content="In script">';</script>
            <style>/* <link rel="icon" href="/in-style.ico"> */</style>
            <meta property="og:title" content="Real">"#;
        let card = parse_card(html);
        assert_eq!(card.title.as_deref(), Some("Real"));
        assert!(card.icon_hrefs.is_empty());
        // A tag that never closes ends the scan quietly.
        let card = parse_card(r#"<meta property="og:title" content="Kept"><meta property="og:de"#);
        assert_eq!(card.title.as_deref(), Some("Kept"));
    }

    #[test]
    fn video_is_og_type_video_dot_something_or_a_twitter_player() {
        for (html, expected) in [
            (r#"<meta property="og:type" content="video.other">"#, true),
            (r#"<meta property="og:type" content="Video.Movie">"#, true),
            (r#"<meta property="og:type" content="video.episode">"#, true),
            (r#"<meta property="og:type" content="video.tv_show">"#, true),
            (r#"<meta name="twitter:card" content="player">"#, true),
            (r#"<meta name="twitter:card" content="PLAYER">"#, true),
            (r#"<meta property="og:type" content="article">"#, false),
            (r#"<meta property="og:type" content="website">"#, false),
            (r#"<meta property="og:type" content="video">"#, false),
            (r#"<meta property="og:type" content="videogame.x">"#, false),
            (
                r#"<meta name="twitter:card" content="summary_large_image">"#,
                false,
            ),
            ("<title>x</title>", false),
        ] {
            assert_eq!(parse_card(html).is_video, expected, "{html}");
        }
    }

    #[test]
    fn icons_come_apple_touch_first_then_icon_and_never_svg() {
        let html = r##"
          <link rel="icon" type="image/svg+xml" href="/icon.svg">
          <link rel="shortcut icon" href="/favicon-32.png">
          <link rel="mask-icon" href="/mask.svg" color="#000">
          <link rel="apple-touch-icon-precomposed" href="/touch-pre.png">
          <link rel="Apple-Touch-Icon" sizes="180x180" href="/touch.png">
          <link rel="icon" href="/second.ico?v=2&amp;x=1">
          <link rel="icon" href="/also.svg?x=1">
          <link rel="icon" href="">
          <link rel="stylesheet" href="/site.css">"##;
        let card = parse_card(html);
        assert_eq!(
            card.icon_hrefs,
            [
                "/touch-pre.png",
                "/touch.png",
                "/favicon-32.png",
                "/second.ico?v=2&x=1"
            ]
        );
    }

    #[test]
    fn the_size_is_the_first_og_images_valid_pair() {
        let og = |body: &str| parse_card(body);
        let card = og(r#"<meta property="og:image" content="/a.png">
            <meta property="og:image:width" content="1200">
            <meta property="og:image:height" content="630">
            <meta property="og:image" content="/b.png">
            <meta property="og:image:width" content="800">
            <meta property="og:image:height" content="400">"#);
        assert_eq!(
            (card.image_width, card.image_height),
            (Some(1200), Some(630))
        );
        // Sloppy order (size before the picture) still belongs to the first picture.
        let card = og(r#"<meta property="og:image:width" content="640">
            <meta property="og:image:height" content="480">
            <meta property="og:image" content="/a.png">"#);
        assert_eq!(
            (card.image_width, card.image_height),
            (Some(640), Some(480))
        );
        // The first picture declares none: the second one's size is not ours.
        let card = og(r#"<meta property="og:image" content="/a.png">
            <meta property="og:image" content="/b.png">
            <meta property="og:image:width" content="800">
            <meta property="og:image:height" content="400">"#);
        assert_eq!((card.image_width, card.image_height), (None, None));
        // Half a pair, junk, zero and too large are not a size.
        for (w, h) in [
            ("1200", ""),
            ("", "630"),
            ("0", "630"),
            ("1200", "-5"),
            ("1200px", "630"),
            ("16385", "630"),
            ("12.5", "630"),
        ] {
            let body = format!(
                r#"<meta property="og:image" content="/a.png">
                   <meta property="og:image:width" content="{w}">
                   <meta property="og:image:height" content="{h}">"#
            );
            let card = og(&body);
            assert_eq!(
                (card.image_width, card.image_height),
                (None, None),
                "{w}x{h}"
            );
        }
        // The edges of the range are valid.
        let card = og(r#"<meta property="og:image" content="/a.png">
            <meta property="og:image:width" content="1">
            <meta property="og:image:height" content="16384">"#);
        assert_eq!(
            (card.image_width, card.image_height),
            (Some(1), Some(16384))
        );
        // A size with no og:image (the picture came from twitter) is not that picture's size.
        let card = og(r#"<meta name="twitter:image" content="/t.png">
            <meta property="og:image:width" content="1200">
            <meta property="og:image:height" content="630">"#);
        assert_eq!(card.image_url.as_deref(), Some("/t.png"));
        assert_eq!((card.image_width, card.image_height), (None, None));
    }

    #[test]
    fn a_title_in_the_title_tag_is_cleaned_and_the_first_one_wins() {
        let html = "<head><TITLE>\n  Hello\t&amp;  World \n</TITLE><title>second</title>";
        assert_eq!(parse_card(html).title.as_deref(), Some("Hello & World"));
        // A closing tag that never comes is no title.
        assert_eq!(parse_card("<title>never closed").title, None);
    }

    #[test]
    fn site_name_is_og_site_name_only() {
        let card = parse_card(r#"<meta property="og:site_name" content="  Oort   News ">"#);
        assert_eq!(card.site_name.as_deref(), Some("Oort News"));
        assert_eq!(parse_card("<title>Only a title</title>").site_name, None);
        assert_eq!(
            parse_card(r#"<meta property="og:site_name" content="   ">"#).site_name,
            None
        );
    }
}
