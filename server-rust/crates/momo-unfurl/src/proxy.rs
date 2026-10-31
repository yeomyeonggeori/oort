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
//! ## The cache is the proxy's memory and its brake (amendment D13, #4881 review M-2)
//!
//! Nearly every card has an icon address (a page with none falls back to `/favicon.ico`), and each
//! request for one that the cache cannot answer is up to four GETs from this server to a site the
//! requester chose. So the in-process [`ImageCache`] holds three things:
//!
//! * what was fetched, least recently used out first, bounded in entries **and** in bytes;
//! * what failed lately (a 404, a refusal by the guard, a timeout, a body of the wrong type), for
//!   [`ProxyLimits::failure_ttl`], so a site with no favicon is asked once and not on every render.
//!   Failures live apart from pictures, with a bound of their own, so a stream of bad addresses
//!   cannot push good pictures out;
//! * how many fetches from remote sites run at once, process-wide ([`ProxyError::Busy`]).
//!
//! A request the cache can answer, or a failure it remembers, costs the remote site nothing, and
//! the server spends no member budget on it: the per-member budget (`rate_limit.rs` in the server)
//! is asked only when [`proxy_goes_outbound`] says the request would leave the building.
//!
//! The cache is shared by every workspace. That is safe because a key is the hash of the remote
//! address: a tenant can only read or fill an entry by already knowing the address.
//!
//! Drive archive reuse was considered and rejected as over-design for v0.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use momo_db::DbError;
use sqlx::PgConnection;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::dimensions::image_dimensions;
use crate::fetch::{FetchKind, UnfurlHttp};
use crate::store::{load_unfurl_in_tx, UnfurlRecord};

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

/// What the proxy may keep and start at once. `Default` is what production runs; tests build
/// smaller ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProxyLimits {
    /// Pictures and icons kept at once (default 256: icons are small, and 64 filled up in a busy
    /// channel). The least recently used goes first.
    pub max_entries: usize,
    /// Their bytes together (default 32 MiB). A body larger than this is served but never kept.
    /// Before this bound the cache could hold 64 pictures of 5 MiB each, 320 MiB.
    pub max_bytes: usize,
    /// How long an address that just failed is left alone (default 10 minutes).
    pub failure_ttl: Duration,
    /// Failed addresses remembered at once (default 1024, a few dozen bytes each).
    pub max_failures: usize,
    /// Fetches from remote sites in flight at once, across every member and workspace (default
    /// 16). Past it a request that must fetch is refused with [`ProxyError::Busy`].
    pub max_in_flight: usize,
}

impl Default for ProxyLimits {
    fn default() -> Self {
        ProxyLimits {
            max_entries: 256,
            max_bytes: 32 * 1024 * 1024,
            failure_ttl: Duration::from_secs(10 * 60),
            max_failures: 1024,
            max_in_flight: 16,
        }
    }
}

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

/// A map that forgets the entry used longest ago. The caches here hold a few hundred entries at
/// most, so finding the oldest by a scan is simpler than a linked list and cheap enough.
#[derive(Debug)]
struct Lru<V> {
    entries: HashMap<String, (u64, V)>,
    clock: u64,
}

impl<V> Lru<V> {
    fn new() -> Lru<V> {
        Lru {
            entries: HashMap::new(),
            clock: 0,
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The value; it becomes the most recently used.
    fn get(&mut self, key: &str) -> Option<&V> {
        let stamp = self.tick();
        let (used, value) = self.entries.get_mut(key)?;
        *used = stamp;
        Some(value)
    }

    /// Insert as the most recently used. Returns what the key held before.
    fn put(&mut self, key: String, value: V) -> Option<V> {
        let stamp = self.tick();
        self.entries.insert(key, (stamp, value)).map(|(_, old)| old)
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        self.entries.remove(key).map(|(_, value)| value)
    }

    /// Remove and return the entry used longest ago.
    fn pop_oldest(&mut self) -> Option<V> {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, (used, _))| *used)
            .map(|(key, _)| key.clone())?;
        self.remove(&oldest)
    }
}

#[derive(Debug)]
struct Pictures {
    lru: Lru<CachedImage>,
    bytes: usize,
}

/// The proxy's in-process state: what it fetched, what failed lately, and how many fetches may
/// run at once. See the module docs.
#[derive(Debug)]
pub struct ImageCache {
    limits: ProxyLimits,
    pictures: Mutex<Pictures>,
    /// Address key -> when the failure stops counting.
    failures: Mutex<Lru<Instant>>,
    in_flight: Arc<Semaphore>,
}

impl Default for ImageCache {
    fn default() -> Self {
        ImageCache::with_limits(ProxyLimits::default())
    }
}

impl ImageCache {
    pub fn with_limits(limits: ProxyLimits) -> ImageCache {
        ImageCache {
            limits,
            pictures: Mutex::new(Pictures {
                lru: Lru::new(),
                bytes: 0,
            }),
            failures: Mutex::new(Lru::new()),
            in_flight: Arc::new(Semaphore::new(limits.max_in_flight)),
        }
    }

    pub fn get(&self, key: &str) -> Option<CachedImage> {
        self.pictures.lock().ok()?.lru.get(key).cloned()
    }

    /// Keep `image`, dropping the least recently used entries until both bounds hold. A body
    /// larger than the whole byte budget is not kept at all: it would only empty the cache for
    /// itself.
    pub fn put(&self, key: String, image: CachedImage) {
        let size = image.bytes.len();
        if size > self.limits.max_bytes || self.limits.max_entries == 0 {
            return;
        }
        let Ok(mut pictures) = self.pictures.lock() else {
            return;
        };
        if let Some(previous) = pictures.lru.put(key, image) {
            pictures.bytes -= previous.bytes.len();
        }
        pictures.bytes += size;
        while pictures.lru.len() > self.limits.max_entries || pictures.bytes > self.limits.max_bytes
        {
            let Some(evicted) = pictures.lru.pop_oldest() else {
                break;
            };
            pictures.bytes -= evicted.bytes.len();
        }
    }

    /// Remember that `key` just failed, for [`ProxyLimits::failure_ttl`].
    pub fn remember_failure(&self, key: &str) {
        let now = Instant::now();
        let until = now.checked_add(self.limits.failure_ttl).unwrap_or(now);
        let Ok(mut failures) = self.failures.lock() else {
            return;
        };
        failures.put(key.to_string(), until);
        while failures.len() > self.limits.max_failures {
            if failures.pop_oldest().is_none() {
                break;
            }
        }
    }

    /// Did `key` fail so recently that it is left alone? A failure that has run out is forgotten
    /// here.
    pub fn failed_recently(&self, key: &str) -> bool {
        let Ok(mut failures) = self.failures.lock() else {
            return false;
        };
        let Some(&until) = failures.get(key) else {
            return false;
        };
        if Instant::now() < until {
            return true;
        }
        failures.remove(key);
        false
    }

    fn holds(&self, key: &str) -> bool {
        self.pictures
            .lock()
            .map(|pictures| pictures.lru.contains(key))
            .unwrap_or(false)
    }

    /// A place among the fetches in flight, held until the fetch ends (success, failure or the
    /// caller going away). `None` when the process is already doing as many as it may.
    fn try_start_fetch(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.in_flight).try_acquire_owned().ok()
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
    /// The process is already fetching as many remote images as it allows at once
    /// ([`ProxyLimits::max_in_flight`]). Not a verdict on this card: the caller asks again soon.
    #[error("too many remote fetches in flight")]
    Busy,
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

/// What the proxy needs to know about one of a card's two remote images.
struct SlotTarget<'a> {
    source: &'a str,
    key: String,
    kind: FetchKind,
    allowed: &'static [&'static str],
}

impl<'a> SlotTarget<'a> {
    /// `None` when there is nothing to fetch: the card is not `ok`, or has no address for the slot.
    fn of(record: &'a UnfurlRecord, slot: ProxySlot) -> Option<SlotTarget<'a>> {
        if record.status != "ok" {
            return None;
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
        let source = source?;
        let key = format!(
            "{}:{}",
            slot.cache_namespace(),
            stored_key
                .map(str::to_string)
                .unwrap_or_else(|| crate::store::image_proxy_key(source))
        );
        Some(SlotTarget {
            source,
            key,
            kind,
            allowed,
        })
    }
}

/// Would serving this card's picture or icon make the server fetch from the remote site?
///
/// No when there is nothing to fetch, when the cache already holds the answer, and when the
/// address failed so recently that it is left alone: none of those costs the remote site a
/// request. The server spends a member's fetch budget only for a request this says yes to.
pub fn proxy_goes_outbound(record: &UnfurlRecord, cache: &ImageCache, slot: ProxySlot) -> bool {
    SlotTarget::of(record, slot)
        .is_some_and(|target| !cache.holds(&target.key) && !cache.failed_recently(&target.key))
}

async fn fetch_slot(
    record: &UnfurlRecord,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
    slot: ProxySlot,
) -> Result<ProxyImage, ProxyError> {
    let Some(target) = SlotTarget::of(record, slot) else {
        return Err(ProxyError::Unavailable);
    };
    if let Some(hit) = cache.get(&target.key) {
        return Ok(ProxyImage {
            bytes: hit.bytes,
            content_type: hit.content_type,
            size: hit.size,
        });
    }
    if cache.failed_recently(&target.key) {
        return Err(ProxyError::Unavailable);
    }
    // From here the server really goes to the remote site. The permit is held until this
    // function returns, whichever way it does.
    let Some(_permit) = cache.try_start_fetch() else {
        return Err(ProxyError::Busy);
    };
    match fetch_remote(&target, http, slot).await {
        Some(image) => {
            cache.put(
                target.key,
                CachedImage {
                    bytes: image.bytes.clone(),
                    content_type: image.content_type.clone(),
                    size: image.size,
                },
            );
            Ok(image)
        }
        None => {
            cache.remember_failure(&target.key);
            Err(ProxyError::Unavailable)
        }
    }
}

/// One trip to the remote site. `None` is any failure: the guard refused it, the site answered
/// with an error or too much or too slowly, or the body is not a type this slot serves.
async fn fetch_remote(
    target: &SlotTarget<'_>,
    http: &dyn UnfurlHttp,
    slot: ProxySlot,
) -> Option<ProxyImage> {
    let fetched = http.fetch(target.source, target.kind).await.ok()?;
    let content_type = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or(&fetched.content_type)
        .trim()
        .to_ascii_lowercase();
    if !target
        .allowed
        .iter()
        .any(|allowed| content_type == *allowed)
    {
        return None;
    }
    let size = match slot {
        ProxySlot::Image => image_dimensions(&fetched.body),
        ProxySlot::Icon => None,
    };
    Some(ProxyImage {
        bytes: fetched.body,
        content_type,
        size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::guard_fixtures::{GuardedScript, ScriptedReply};
    use crate::fetch::{FetchError, Fetched};
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::sync::mpsc;

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

    // ── #4881 security review r1, M-1 at the proxy ───────────────────────────────────────────

    /// The stored icon address is a NAME (it passed the literal checks when the card was built)
    /// and the name resolves inward: the proxy refuses it and nothing is dialled. The same check
    /// at the guard is `fetch::tests::an_icon_name_that_resolves_to_an_inward_address_is_...`.
    #[tokio::test]
    async fn an_icon_name_that_resolves_inward_is_refused_by_the_proxy_and_never_dialled() {
        for answer in [
            "169.254.169.254",
            "127.0.0.1",
            "10.0.0.7",
            "::1",
            "::ffff:7f00:1",
            "64:ff9b::a9fe:a9fe",
            "fd00:ec2::254",
        ] {
            let guard = GuardedScript::resolving_to(answer, vec![]);
            let cache = ImageCache::default();
            assert_eq!(
                fetch_record_icon(&record(), &guard, &cache)
                    .await
                    .unwrap_err(),
                ProxyError::Unavailable,
                "{answer}"
            );
            assert_eq!(guard.hops(), 0, "{answer} must not reach the socket");
        }
        // Control: the same card, a public answer, is served.
        let guard = GuardedScript::resolving_to(
            "93.184.216.34",
            vec![ScriptedReply::Body {
                content_type: "image/x-icon",
                body: vec![0, 0, 1, 0],
            }],
        );
        fetch_record_icon(&record(), &guard, &ImageCache::default())
            .await
            .expect("a public answer");
        assert_eq!(guard.hops(), 1);
    }

    // ── #4881 security review r1, M-2: the cache is a memory and a brake ─────────────────────

    /// Fails every request the same way and counts them.
    struct Failing {
        calls: AtomicU32,
        error: FetchError,
    }

    impl Failing {
        fn new(error: FetchError) -> Failing {
            Failing {
                calls: AtomicU32::new(0),
                error,
            }
        }
        fn calls(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Failing {
        async fn fetch(&self, _url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(self.error.clone())
        }
    }

    /// Answers once the test opens the gate, and says when a request has reached it.
    struct Gated {
        entered: mpsc::UnboundedSender<()>,
        gate: Arc<Semaphore>,
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Gated {
        async fn fetch(&self, url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
            let _ = self.entered.send(());
            self.gate.acquire().await.expect("gate open").forget();
            Ok(Fetched {
                final_url: url.to_string(),
                content_type: "image/png".into(),
                body: png_of(10, 10),
            })
        }
    }

    /// A card whose icon lives at its own address, so two of them never share a cache key.
    fn icon_record(n: u128) -> UnfurlRecord {
        let address = format!("https://site{n}.example/favicon.ico");
        let mut card = record();
        card.id = Uuid::from_u128(1000 + n);
        card.icon_proxy_key = Some(crate::store::image_proxy_key(&address));
        card.icon_source_url = Some(address);
        card
    }

    fn small_image(fill: u8, len: usize) -> CachedImage {
        CachedImage {
            bytes: vec![fill; len],
            content_type: "image/png".into(),
            size: None,
        }
    }

    fn held(cache: &ImageCache) -> (usize, usize) {
        let pictures = cache.pictures.lock().unwrap();
        (pictures.lru.len(), pictures.bytes)
    }

    #[tokio::test]
    async fn a_failed_fetch_is_remembered_and_the_address_is_not_asked_again() {
        for error in [
            FetchError::Failed("HTTP 404".into()),
            FetchError::Failed("dns".into()),
            FetchError::Blocked,
            FetchError::TooManyRedirects,
            FetchError::Timeout,
            FetchError::TooLarge,
        ] {
            let http = Failing::new(error.clone());
            let cache = ImageCache::default();
            for attempt in 1..=3 {
                assert_eq!(
                    fetch_record_icon(&record(), &http, &cache)
                        .await
                        .unwrap_err(),
                    ProxyError::Unavailable,
                    "{error:?}, attempt {attempt}"
                );
            }
            assert_eq!(
                http.calls(),
                1,
                "{error:?}: only the first request left the building"
            );
            // The card's picture is another address: it is tried on its own, once.
            for _ in 0..2 {
                fetch_record_image(&record(), &http, &cache)
                    .await
                    .unwrap_err();
            }
            assert_eq!(http.calls(), 2, "{error:?}: the picture is its own key");
        }
        // A body of a type the slot does not serve is a failure and is remembered the same way.
        let svg = Recorder::new("image/svg+xml", b"<svg/>".to_vec());
        let cache = ImageCache::default();
        for _ in 0..3 {
            fetch_record_icon(&record(), &svg, &cache)
                .await
                .unwrap_err();
        }
        assert_eq!(svg.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_remembered_failure_runs_out_and_the_address_is_asked_again() {
        let cache = ImageCache::with_limits(ProxyLimits {
            failure_ttl: Duration::ZERO,
            ..ProxyLimits::default()
        });
        let http = Failing::new(FetchError::Failed("HTTP 404".into()));
        for _ in 0..3 {
            fetch_record_icon(&record(), &http, &cache)
                .await
                .unwrap_err();
        }
        assert_eq!(
            http.calls(),
            3,
            "a failure that has run out is not a memory"
        );
        // The site mends: the next request is served and kept.
        let healthy = Recorder::new("image/x-icon", vec![0, 0, 1, 0]);
        fetch_record_icon(&record(), &healthy, &cache)
            .await
            .expect("served once nothing is remembered against it");
        fetch_record_icon(&record(), &healthy, &cache)
            .await
            .expect("and kept");
        assert_eq!(healthy.calls().len(), 1);
    }

    #[test]
    fn the_least_recently_used_picture_goes_first_and_the_cache_is_never_emptied_at_once() {
        let cache = ImageCache::with_limits(ProxyLimits {
            max_entries: 3,
            ..ProxyLimits::default()
        });
        for key in ["a", "b", "c"] {
            cache.put(key.into(), small_image(1, 4));
        }
        // Reading `a` makes it the most recently used, so `b` is the oldest.
        assert!(cache.get("a").is_some());
        cache.put("d".into(), small_image(1, 4));
        assert!(cache.get("b").is_none(), "the entry used longest ago went");
        for key in ["a", "c", "d"] {
            assert!(cache.get(key).is_some(), "{key} is still there");
        }
        // A full cache stays full: it is never wiped to make room.
        for n in 0..50 {
            cache.put(format!("k{n}"), small_image(2, 4));
            assert_eq!(held(&cache).0, 3, "after {n} more");
        }
    }

    #[tokio::test]
    async fn the_byte_budget_bounds_the_cache_and_a_body_over_it_is_served_but_not_kept() {
        let cache = ImageCache::with_limits(ProxyLimits {
            max_bytes: 100,
            ..ProxyLimits::default()
        });
        for key in ["a", "b", "c"] {
            cache.put(key.into(), small_image(1, 40));
        }
        assert!(cache.get("a").is_none(), "the oldest went to make room");
        assert!(cache.get("b").is_some() && cache.get("c").is_some());
        assert_eq!(held(&cache), (2, 80));
        // Replacing an entry replaces its bytes, it does not add to them.
        cache.put("b".into(), small_image(2, 10));
        assert_eq!(held(&cache), (2, 50));
        // A body larger than the whole budget is not kept and evicts nobody.
        cache.put("big".into(), small_image(3, 101));
        assert!(cache.get("big").is_none());
        assert_eq!(held(&cache), (2, 50));
        // Through the proxy: it is still served, and asked for again next time.
        let http = Recorder::new("image/png", vec![7u8; 101]);
        let served = fetch_record_icon(&record(), &http, &cache).await.unwrap();
        assert_eq!(served.bytes.len(), 101);
        fetch_record_icon(&record(), &http, &cache).await.unwrap();
        assert_eq!(http.calls().len(), 2);
    }

    #[test]
    fn failures_have_a_bound_of_their_own_and_never_push_pictures_out() {
        let cache = ImageCache::with_limits(ProxyLimits {
            max_entries: 2,
            max_failures: 2,
            ..ProxyLimits::default()
        });
        cache.put("p1".into(), small_image(1, 4));
        cache.put("p2".into(), small_image(1, 4));
        for n in 0..50 {
            cache.remember_failure(&format!("bad{n}"));
        }
        assert!(cache.get("p1").is_some() && cache.get("p2").is_some());
        assert!(cache.failed_recently("bad49") && cache.failed_recently("bad48"));
        assert!(!cache.failed_recently("bad47"), "the oldest failures went");
        assert_eq!(cache.failures.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn at_most_the_limit_of_fetches_run_at_once_and_the_next_is_busy_until_one_ends() {
        let cache = Arc::new(ImageCache::with_limits(ProxyLimits {
            max_in_flight: 2,
            ..ProxyLimits::default()
        }));
        let (entered, mut reached) = mpsc::unbounded_channel();
        let gate = Arc::new(Semaphore::new(0));
        let http = Arc::new(Gated {
            entered,
            gate: gate.clone(),
        });
        let start = |n: u128| {
            let (http, cache) = (http.clone(), cache.clone());
            tokio::spawn(async move {
                fetch_record_icon(&icon_record(n), http.as_ref(), cache.as_ref()).await
            })
        };
        let first = start(1);
        let second = start(2);
        // Both are inside the transport now: both hold a place.
        reached.recv().await.unwrap();
        reached.recv().await.unwrap();
        // The third is turned away without reaching the transport. The outer timeout makes a
        // regression that lets it through fail here instead of waiting on the gate for ever.
        let third = tokio::time::timeout(
            Duration::from_secs(5),
            fetch_record_icon(&icon_record(3), http.as_ref(), cache.as_ref()),
        )
        .await
        .expect("the third request must be refused at once, not wait for a place");
        assert_eq!(third.unwrap_err(), ProxyError::Busy);
        assert!(
            reached.try_recv().is_err(),
            "the refused request never reached the transport"
        );
        // Busy says nothing about the card: it is not remembered as a failure.
        let key = SlotTarget::of(&icon_record(3), ProxySlot::Icon)
            .unwrap()
            .key;
        assert!(!cache.failed_recently(&key));
        // Let the two finish; their places come back.
        gate.add_permits(2);
        first.await.unwrap().expect("first");
        second.await.unwrap().expect("second");
        gate.add_permits(1);
        fetch_record_icon(&icon_record(3), http.as_ref(), cache.as_ref())
            .await
            .expect("a place is free again");
    }

    #[tokio::test]
    async fn a_failed_fetch_gives_its_place_back() {
        let cache = ImageCache::with_limits(ProxyLimits {
            max_in_flight: 1,
            ..ProxyLimits::default()
        });
        let http = Failing::new(FetchError::Timeout);
        for n in 1..=4 {
            assert_eq!(
                fetch_record_icon(&icon_record(n), &http, &cache)
                    .await
                    .unwrap_err(),
                ProxyError::Unavailable,
                "request {n} was never turned away as busy"
            );
        }
        assert_eq!(http.calls(), 4);
        // A request refused before it fetches (nothing to fetch) takes no place either.
        let mut no_icon = record();
        no_icon.icon_source_url = None;
        no_icon.icon_proxy_key = None;
        for _ in 0..3 {
            assert_eq!(
                fetch_record_icon(&no_icon, &http, &cache)
                    .await
                    .unwrap_err(),
                ProxyError::Unavailable
            );
        }
    }

    #[tokio::test]
    async fn only_a_request_that_would_leave_the_building_goes_outbound() {
        let cache = ImageCache::default();
        let card = record();
        assert!(proxy_goes_outbound(&card, &cache, ProxySlot::Icon));
        assert!(proxy_goes_outbound(&card, &cache, ProxySlot::Image));
        // Served and kept: the next request for it is answered from memory.
        let healthy = Recorder::new("image/x-icon", vec![0, 0, 1, 0]);
        fetch_record_icon(&card, &healthy, &cache).await.unwrap();
        assert!(!proxy_goes_outbound(&card, &cache, ProxySlot::Icon));
        assert!(
            proxy_goes_outbound(&card, &cache, ProxySlot::Image),
            "the picture is its own request"
        );
        // Failed lately: left alone.
        let failing = Failing::new(FetchError::Failed("HTTP 404".into()));
        fetch_record_image(&card, &failing, &cache)
            .await
            .unwrap_err();
        assert!(!proxy_goes_outbound(&card, &cache, ProxySlot::Image));
        // Nothing to fetch is never outbound.
        let mut no_icon = record();
        no_icon.icon_source_url = None;
        no_icon.icon_proxy_key = None;
        assert!(!proxy_goes_outbound(
            &no_icon,
            &ImageCache::default(),
            ProxySlot::Icon
        ));
        for status in ["pending", "failed", "blocked"] {
            let mut not_ok = record();
            not_ok.status = status.into();
            assert!(!proxy_goes_outbound(
                &not_ok,
                &ImageCache::default(),
                ProxySlot::Icon
            ));
        }
    }
}
