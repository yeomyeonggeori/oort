//! OG tags first, Twitter card second, `<title>` / `name=description` last.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedCard {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
}

const TITLE_MAX: usize = 200;
const DESC_MAX: usize = 300;

/// Parse a HTML document for a link card. Image URLs stay raw here; the
/// fetch layer resolves them against the page URL.
pub fn parse_card(html: &str) -> ParsedCard {
    let mut og = ParsedCard::default();
    let mut twitter = ParsedCard::default();
    let mut named_description = None;
    scan_meta(html, |key, value| match key {
        "og:title" => og.title = Some(clip(&value, TITLE_MAX)),
        "og:description" => og.description = Some(clip(&value, DESC_MAX)),
        "og:image" | "og:image:secure_url" if og.image_url.is_none() => {
            og.image_url = Some(value);
        }
        "twitter:title" => twitter.title = Some(clip(&value, TITLE_MAX)),
        "twitter:description" => twitter.description = Some(clip(&value, DESC_MAX)),
        "twitter:image" | "twitter:image:src" if twitter.image_url.is_none() => {
            twitter.image_url = Some(value);
        }
        "description" => named_description = Some(clip(&value, DESC_MAX)),
        _ => {}
    });
    let title = og
        .title
        .or(twitter.title)
        .or_else(|| html_title(html).map(|t| clip(&t, TITLE_MAX)));
    let description = og.description.or(twitter.description).or(named_description);
    let image_url = og.image_url.or(twitter.image_url);
    ParsedCard {
        title,
        description,
        image_url,
    }
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        trimmed.chars().take(max).collect()
    }
}

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after = html[start..].find('>')? + start + 1;
    let end_rel = lower[after..].find("</title>")?;
    Some(decode_entities(html[after..after + end_rel].trim()))
}

fn scan_meta(html: &str, mut on_tag: impl FnMut(&str, String)) {
    let lower = html.to_ascii_lowercase();
    let mut search = 0;
    while let Some(rel) = lower[search..].find("<meta") {
        let start = search + rel;
        let Some(gt) = html[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + gt];
        search = start + gt + 1;
        let property = attr(tag, "property").or_else(|| attr(tag, "name"));
        let content = attr(tag, "content");
        if let (Some(property), Some(content)) = (property, content) {
            on_tag(&property.to_ascii_lowercase(), decode_entities(&content));
        }
    }
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let idx = lower.find(&key)?;
    let rest = tag[idx + key.len()..].trim_start();
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)?;
        Some(rest[1..1 + end].to_string())
    } else {
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
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
        assert!(card.title.is_none());
        assert!(card.description.is_none());
        assert!(card.image_url.is_none());
    }
}
