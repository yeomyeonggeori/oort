//! Image and icon proxy: the client never contacts a remote host (ADR-0170 D5 / CSP).
//!
//! A card has two things to show that live on someone else's server: the preview picture and the
//! site icon (ADR-0170 amendment 2026-10-31 D9). Both come through here, by the same function and
//! the same transport guard, and the remote address of either one stays in the database: the
//! client only ever holds a path on this origin ([`image_path`], [`icon_path`]).
//!
//! The picture is fetched as [`FetchKind::Image`]; the icon as [`FetchKind::Icon`], which is the
//! same guard with port 443 only and a smaller body cap. An icon may be an ICO; a picture may not,
//! and neither may be an SVG (a format that can carry script). The in-process cache keeps the two
//! apart so a body accepted as an icon is never served as a picture.
//!
//! Cache is a small in-process map. Drive archive reuse was considered and rejected as
//! over-design for v0.

use std::collections::HashMap;
use std::sync::Mutex;

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::dimensions::image_dimensions;
use crate::fetch::{FetchError, FetchKind, UnfurlHttp};
use crate::store::{load_unfurl_in_tx, UnfurlRecord};

const CACHE_CAP: usize = 64;
const PICTURE_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
];
/// The picture types plus the two names an ICO goes by.
const ICON_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

/// Which of a card's two remote images is being proxied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxySlot {
    Image,
    Icon,
}

impl ProxySlot {
    fn cache_namespace(self) -> &'static str {
        match self {
            ProxySlot::Image => "image",
            ProxySlot::Icon => "icon",
        }
    }
}

/// The only address of a card's picture a client is ever given.
pub fn image_path(workspace_id: Uuid, unfurl_id: Uuid) -> String {
    format!("/v1/workspaces/{workspace_id}/unfurls/{unfurl_id}/image")
}

/// The only address of a card's site icon a client is ever given.
pub fn icon_path(workspace_id: Uuid, unfurl_id: Uuid) -> String {
    format!("/v1/workspaces/{workspace_id}/unfurls/{unfurl_id}/icon")
}

#[derive(Debug, Clone)]
pub struct CachedImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// Measured from the header when the picture was received (pictures only).
    pub size: Option<(u32, u32)>,
}

#[derive(Debug, Default)]
pub struct ImageCache {
    inner: Mutex<HashMap<String, CachedImage>>,
}

impl ImageCache {
    pub fn get(&self, key: &str) -> Option<CachedImage> {
        self.inner.lock().ok()?.get(key).cloned()
    }

    pub fn put(&self, key: String, image: CachedImage) {
        if let Ok(mut guard) = self.inner.lock() {
            if guard.len() >= CACHE_CAP {
                guard.clear();
            }
            guard.insert(key, image);
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProxyImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// `(width, height)` read from the bytes. Only the picture slot measures.
    pub size: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProxyError {
    #[error("unfurl not found")]
    NotFound,
    #[error("image not available")]
    Unavailable,
}

pub async fn proxy_image_in_tx(
    conn: &mut PgConnection,
    unfurl_id: Uuid,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
) -> Result<Result<ProxyImage, ProxyError>, DbError> {
    let Some(record) = load_unfurl_in_tx(conn, unfurl_id).await? else {
        return Ok(Err(ProxyError::NotFound));
    };
    Ok(fetch_record_image(&record, http, cache).await)
}

/// The card's preview picture.
pub async fn fetch_record_image(
    record: &UnfurlRecord,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
) -> Result<ProxyImage, ProxyError> {
    fetch_slot(record, http, cache, ProxySlot::Image).await
}

/// The card's site icon.
pub async fn fetch_record_icon(
    record: &UnfurlRecord,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
) -> Result<ProxyImage, ProxyError> {
    fetch_slot(record, http, cache, ProxySlot::Icon).await
}

async fn fetch_slot(
    record: &UnfurlRecord,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
    slot: ProxySlot,
) -> Result<ProxyImage, ProxyError> {
    if record.status != "ok" {
        return Err(ProxyError::Unavailable);
    }
    let (source, stored_key, kind, allowed) = match slot {
        ProxySlot::Image => (
            record.image_url.as_deref(),
            record.image_proxy_key.as_deref(),
            FetchKind::Image,
            PICTURE_TYPES,
        ),
        ProxySlot::Icon => (
            record.icon_source_url.as_deref(),
            record.icon_proxy_key.as_deref(),
            FetchKind::Icon,
            ICON_TYPES,
        ),
    };
    let Some(source) = source else {
        return Err(ProxyError::Unavailable);
    };
    let key = format!(
        "{}:{}",
        slot.cache_namespace(),
        stored_key
            .map(str::to_string)
            .unwrap_or_else(|| crate::store::image_proxy_key(source))
    );
    if let Some(hit) = cache.get(&key) {
        return Ok(ProxyImage {
            bytes: hit.bytes,
            content_type: hit.content_type,
            size: hit.size,
        });
    }
    let fetched = match http.fetch(source, kind).await {
        Ok(fetched) => fetched,
        Err(FetchError::Blocked | FetchError::TooManyRedirects) => {
            return Err(ProxyError::Unavailable);
        }
        Err(_) => return Err(ProxyError::Unavailable),
    };
    let content_type = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or(&fetched.content_type)
        .trim()
        .to_ascii_lowercase();
    if !allowed.iter().any(|prefix| content_type == *prefix) {
        return Err(ProxyError::Unavailable);
    }
    let size = match slot {
        ProxySlot::Image => image_dimensions(&fetched.body),
        ProxySlot::Icon => None,
    };
    cache.put(
        key,
        CachedImage {
            bytes: fetched.body.clone(),
            content_type: content_type.clone(),
            size,
        },
    );
    Ok(ProxyImage {
        bytes: fetched.body,
        content_type,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::guard_fixtures::{GuardedScript, ScriptedReply};
    use crate::fetch::Fetched;

    const IMAGE_ADDRESS: &str = "https://cdn.example/hero.png";
    const ICON_ADDRESS: &str = "https://news.example/favicon.ico";

    fn record() -> UnfurlRecord {
        UnfurlRecord {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            message_id: Uuid::from_u128(4),
            url_key: "https://news.example/story".into(),
            source_url: "https://news.example/story".into(),
            status: "ok".into(),
            title: Some("T".into()),
            description: None,
            domain: Some("news.example".into()),
            image_proxy_key: Some(crate::store::image_proxy_key(IMAGE_ADDRESS)),
            image_url: Some(IMAGE_ADDRESS.into()),
            site_name: None,
            icon_proxy_key: Some(crate::store::image_proxy_key(ICON_ADDRESS)),
            icon_source_url: Some(ICON_ADDRESS.into()),
            image_width: None,
            image_height: None,
            is_video: false,
        }
    }

    /// Answers whatever it is told to and remembers what it was asked for.
    struct Recorder {
        calls: Mutex<Vec<(String, FetchKind)>>,
        content_type: String,
        body: Vec<u8>,
    }

    impl Recorder {
        fn new(content_type: &str, body: Vec<u8>) -> Recorder {
            Recorder {
                calls: Mutex::new(Vec::new()),
                content_type: content_type.to_string(),
                body,
            }
        }
        fn calls(&self) -> Vec<(String, FetchKind)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Recorder {
        async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
            self.calls.lock().unwrap().push((url.to_string(), kind));
            Ok(Fetched {
                final_url: url.to_string(),
                content_type: self.content_type.clone(),
                body: self.body.clone(),
            })
        }
    }

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0]);
        out
    }

    #[test]
    fn a_client_is_only_ever_given_a_path_on_this_origin() {
        let (workspace, unfurl) = (Uuid::from_u128(7), Uuid::from_u128(9));
        assert_eq!(
            image_path(workspace, unfurl),
            format!("/v1/workspaces/{workspace}/unfurls/{unfurl}/image")
        );
        assert_eq!(
            icon_path(workspace, unfurl),
            format!("/v1/workspaces/{workspace}/unfurls/{unfurl}/icon")
        );
    }

    #[tokio::test]
    async fn each_slot_fetches_its_own_address_as_its_own_kind() {
        let http = Recorder::new("image/png", png_of(10, 10));
        let cache = ImageCache::default();
        fetch_record_image(&record(), &http, &cache).await.unwrap();
        fetch_record_icon(&record(), &http, &cache).await.unwrap();
        assert_eq!(
            http.calls(),
            [
                (IMAGE_ADDRESS.to_string(), FetchKind::Image),
                (ICON_ADDRESS.to_string(), FetchKind::Icon),
            ],
            "the icon is asked for as an icon (443 only), never as a picture, and never by the picture's address"
        );
    }

    #[tokio::test]
    async fn an_icon_may_be_an_ico_a_picture_may_not_and_nothing_may_be_svg_or_html() {
        for (content_type, icon_ok, picture_ok) in [
            ("image/png", true, true),
            ("image/jpeg", true, true),
            ("image/gif", true, true),
            ("image/webp", true, true),
            ("image/avif", true, true),
            ("image/x-icon", true, false),
            ("image/vnd.microsoft.icon", true, false),
            ("IMAGE/X-ICON; charset=binary", true, false),
            ("image/svg+xml", false, false),
            ("image/svg+xml; charset=utf-8", false, false),
            ("text/html", false, false),
            ("text/plain", false, false),
            ("application/octet-stream", false, false),
            ("application/javascript", false, false),
            ("", false, false),
        ] {
            let http = Recorder::new(content_type, png_of(10, 10));
            // A fresh cache per case: this is about the allow-list, not the cache.
            let fresh = ImageCache::default();
            assert_eq!(
                fetch_record_icon(&record(), &http, &fresh).await.is_ok(),
                icon_ok,
                "icon as {content_type:?}"
            );
            assert_eq!(
                fetch_record_image(&record(), &http, &fresh).await.is_ok(),
                picture_ok,
                "picture as {content_type:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_picture_and_an_icon_at_one_address_never_share_a_cache_entry() {
        // One address is both the card's picture and its icon (some sites do that).
        let mut shared = record();
        shared.icon_source_url = shared.image_url.clone();
        shared.icon_proxy_key = shared.image_proxy_key.clone();
        let http = Recorder::new("image/x-icon", png_of(10, 10));
        let cache = ImageCache::default();
        // Accepted as an icon, and cached.
        fetch_record_icon(&shared, &http, &cache).await.unwrap();
        // The picture slot must not be handed that cached ICO: it asks again and refuses it.
        assert_eq!(
            fetch_record_image(&shared, &http, &cache)
                .await
                .unwrap_err(),
            ProxyError::Unavailable
        );
        assert_eq!(
            http.calls().len(),
            2,
            "the second request was not answered from the icon's cache entry"
        );
        // Each slot does hit its own entry.
        fetch_record_icon(&shared, &http, &cache).await.unwrap();
        assert_eq!(http.calls().len(), 2);
    }

    #[tokio::test]
    async fn a_card_without_the_address_or_not_ok_never_reaches_the_transport() {
        let http = Recorder::new("image/png", png_of(10, 10));
        let cache = ImageCache::default();
        let mut no_icon = record();
        no_icon.icon_source_url = None;
        no_icon.icon_proxy_key = None;
        assert_eq!(
            fetch_record_icon(&no_icon, &http, &cache)
                .await
                .unwrap_err(),
            ProxyError::Unavailable
        );
        let mut no_image = record();
        no_image.image_url = None;
        assert_eq!(
            fetch_record_image(&no_image, &http, &cache)
                .await
                .unwrap_err(),
            ProxyError::Unavailable
        );
        for status in ["pending", "failed", "blocked"] {
            let mut not_ok = record();
            not_ok.status = status.into();
            assert!(fetch_record_icon(&not_ok, &http, &cache).await.is_err());
            assert!(fetch_record_image(&not_ok, &http, &cache).await.is_err());
        }
        assert!(http.calls().is_empty());
    }

    /// 「아이콘 프록시가 사설 주소를 거절하는지」: with the REAL guard in the loop (no network:
    /// private literals are refused before DNS, everything else is scripted), a stored icon
    /// address that points inward is refused and never reaches a socket.
    #[tokio::test]
    async fn the_icon_proxy_refuses_private_loopback_and_link_local_addresses() {
        for address in [
            "https://127.0.0.1/favicon.ico",
            "https://127.0.0.1:443/favicon.ico",
            "https://10.0.0.7/favicon.ico",
            "https://192.168.1.1/favicon.ico",
            "https://172.16.0.9/favicon.ico",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/favicon.ico",
            "https://[fe80::1]/favicon.ico",
            "https://[fd00::1]/favicon.ico",
            "https://localhost/favicon.ico",
            "http://news.example/favicon.ico",
        ] {
            let mut stored = record();
            stored.icon_source_url = Some(address.into());
            stored.icon_proxy_key = Some(crate::store::image_proxy_key(address));
            let guard = GuardedScript::new(vec![]);
            let cache = ImageCache::default();
            assert_eq!(
                fetch_record_icon(&stored, &guard, &cache)
                    .await
                    .unwrap_err(),
                ProxyError::Unavailable,
                "{address}"
            );
            assert_eq!(guard.hops(), 0, "{address} must not reach the socket");
        }
        // Another port is refused for an icon (443 only) and not for the picture next to it.
        let mut odd_port = record();
        odd_port.icon_source_url = Some("https://news.example:8443/i.png".into());
        odd_port.icon_proxy_key = Some(crate::store::image_proxy_key(
            "https://news.example:8443/i.png",
        ));
        odd_port.image_url = Some("https://news.example:8443/p.png".into());
        let guard = GuardedScript::new(vec![]);
        let cache = ImageCache::default();
        assert!(fetch_record_icon(&odd_port, &guard, &cache).await.is_err());
        assert_eq!(guard.hops(), 0);
        assert!(fetch_record_image(&odd_port, &guard, &cache).await.is_ok());
        assert_eq!(guard.hops(), 1, "the picture kind keeps its rule");
        // Control: a public https icon is served.
        let guard = GuardedScript::new(vec![ScriptedReply::Body {
            content_type: "image/x-icon",
            body: vec![0, 0, 1, 0],
        }]);
        let served = fetch_record_icon(&record(), &guard, &ImageCache::default())
            .await
            .expect("a public icon");
        assert_eq!(served.content_type, "image/x-icon");
        assert_eq!(guard.hops(), 1);
    }

    #[tokio::test]
    async fn an_icon_redirect_into_a_private_address_is_refused_after_the_public_hop() {
        for location in [
            "https://127.0.0.1/i.ico",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.5/i.ico",
            "https://[::1]/i.ico",
            "https://news.example:8443/i.ico",
        ] {
            let guard = GuardedScript::new(vec![ScriptedReply::Redirect(location.into())]);
            let cache = ImageCache::default();
            assert_eq!(
                fetch_record_icon(&record(), &guard, &cache)
                    .await
                    .unwrap_err(),
                ProxyError::Unavailable,
                "{location}"
            );
            assert_eq!(
                guard.hops(),
                1,
                "{location}: only the public first hop connected"
            );
        }
    }

    #[tokio::test]
    async fn the_picture_slot_measures_what_it_proxies_and_the_icon_slot_does_not() {
        let http = Recorder::new("image/png", png_of(40, 30));
        let cache = ImageCache::default();
        let first = fetch_record_image(&record(), &http, &cache).await.unwrap();
        assert_eq!(first.size, Some((40, 30)));
        // The second answer comes from the cache and still carries the size.
        let second = fetch_record_image(&record(), &http, &cache).await.unwrap();
        assert_eq!(second.size, Some((40, 30)));
        assert_eq!(http.calls().len(), 1, "the second request was a cache hit");
        // Same bytes through the icon slot: no measuring.
        let icon = fetch_record_icon(&record(), &http, &cache).await.unwrap();
        assert_eq!(icon.size, None);
        // Bytes with no readable header are an unmeasured picture, still served.
        let mut other = record();
        other.image_url = Some("https://cdn.example/other.png".into());
        other.image_proxy_key = Some(crate::store::image_proxy_key(
            "https://cdn.example/other.png",
        ));
        let plain = Recorder::new("image/png", b"not really a png".to_vec());
        assert_eq!(
            fetch_record_image(&other, &plain, &cache)
                .await
                .unwrap()
                .size,
            None
        );
    }
}
