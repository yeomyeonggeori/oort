//! The link card of a link that is still in the composer (ADR-0170 amendment 2026-11-01, #4884).
//!
//! Before a message is sent there is no message, so there is no card row, and so there is no
//! `…/unfurls/{id}` to hang a picture on. This module is everything that exists in that gap, and it
//! is small on purpose:
//!
//! * [`fetch_preview`] asks the **same transport** the worker and the picture proxy use
//!   ([`UnfurlHttp`], in production [`crate::SafeUnfurlTransport`]) for the page, as
//!   [`FetchKind::Preview`], and reads the answer into the same [`CardFields`] the worker stores.
//!   It builds no HTTP client and resolves no name of its own: the guard, the redirect re-checks,
//!   the size and time limits, the pinned address and the lookup ceiling are all the transport's.
//!   The one thing `Preview` adds to that guard is port 443 on every hop (see [`FetchKind`]).
//! * [`PreviewCache`] keeps the answer **in this process**, for the member who asked, for a while.
//!   Nothing here touches Postgres, so a link somebody typed and never sent is not stored anywhere
//!   and nothing accumulates (nothing deletes `unfurl_url_cache` rows, so writing there would turn
//!   a member's typing into permanent rows).
//! * A preview's picture and icon are not served here. [`PreviewEntry::as_record`] hands the entry
//!   to the existing proxy in the shape of a card row, so the bytes come through
//!   [`crate::proxy::fetch_record_image`] / [`crate::proxy::fetch_record_icon`] and the same
//!   [`ImageCache`] (the same guard, type allow-list, failure memory and fetch places).
//!
//! ## Every way not to have a preview is the same `failed`
//!
//! The guard refused it, the name resolves inward, the site is down, too slow, too big, not HTML, or
//! the page has nothing a card can show (ADR-0170 D11): all of them are [`Previewed::Failed`]. The
//! member who asks names the address and the answer comes straight back, so telling "refused" from
//! "not there" would tell a member which private names this server's resolver knows. The one
//! outcome that is **not** a verdict on the address is [`Previewed::Busy`] (no place to fetch from):
//! it is never remembered.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::card::CardFields;
use crate::fetch::{FetchError, FetchKind, UnfurlHttp};
use crate::proxy::ImageCache;
use crate::store::{image_proxy_key, UnfurlRecord};
use crate::worker::build_card_off_thread;

/// What the preview cache may keep, and for how long. `Default` is what production runs; tests
/// build smaller ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewLimits {
    /// Previews and failures kept at once, across every member and workspace (default 512). The
    /// least recently used goes first. 0 keeps nothing: every ask fetches, and no id can be served.
    pub max_entries: usize,
    /// How many of those one member may hold (default 64, an eighth of the whole). Past it the
    /// member's **own** least recently used go first, so one member asking about a great many
    /// addresses cannot push everyone else's previews out (the share the fetch places have, for
    /// the same reason). 0 keeps nothing, like `max_entries`.
    pub max_entries_per_member: usize,
    /// How long a preview that has a card is kept (default 30 minutes): long enough to compose a
    /// message around it. When it runs out the composer asks again and gets a new id.
    pub ttl: Duration,
    /// How long a `failed` answer is kept (default 2 minutes). It spares the remote site the same
    /// failing request from a composer that asks again, and is short because a site that was down
    /// a moment ago may be up now.
    pub failure_ttl: Duration,
}

impl Default for PreviewLimits {
    fn default() -> Self {
        PreviewLimits {
            max_entries: 512,
            max_entries_per_member: 64,
            ttl: Duration::from_secs(30 * 60),
            failure_ttl: Duration::from_secs(2 * 60),
        }
    }
}

/// What a preview is kept under: the workspace, the member who asked and the normalized address.
///
/// All three are part of the key. The workspace keeps two tenants apart, and the member keeps one
/// member's unsent draft from showing up as a cache hit (speed, budget) for a colleague.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PreviewKey {
    workspace_id: Uuid,
    member_id: Uuid,
    url_key: String,
}

impl PreviewKey {
    /// `url_key` is the address as [`crate::normalize_url`] returns it.
    pub fn new(workspace_id: Uuid, member_id: Uuid, url_key: impl Into<String>) -> PreviewKey {
        PreviewKey {
            workspace_id,
            member_id,
            url_key: url_key.into(),
        }
    }

    pub fn member_id(&self) -> Uuid {
        self.member_id
    }
}

/// One preview that has a card.
#[derive(Debug, Clone)]
pub struct PreviewEntry {
    /// The handle of the picture and icon paths ([`preview_image_path`], [`preview_icon_path`]): a
    /// random UUID, so it cannot be guessed, and good only for the member it was made for.
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    /// The normalized address the member asked about.
    pub url: String,
    /// What the card shows. The picture and icon addresses in here are remote and **never leave
    /// the server**: a client is only given the two paths.
    pub card: CardFields,
}

impl PreviewEntry {
    /// The entry in the shape the picture proxy reads a card row in. It has no channel and no
    /// message, which the proxy never looks at.
    pub fn as_record(&self) -> UnfurlRecord {
        UnfurlRecord {
            id: self.id,
            workspace_id: self.workspace_id,
            channel_id: Uuid::nil(),
            message_id: Uuid::nil(),
            url_key: self.url.clone(),
            source_url: self.url.clone(),
            status: "ok".into(),
            title: self.card.title.clone(),
            description: self.card.description.clone(),
            domain: self.card.domain.clone(),
            image_proxy_key: self.card.image_url.as_deref().map(image_proxy_key),
            image_url: self.card.image_url.clone(),
            site_name: self.card.site_name.clone(),
            icon_proxy_key: self.card.icon_url.as_deref().map(image_proxy_key),
            icon_source_url: self.card.icon_url.clone(),
            image_width: self.card.image_width,
            image_height: self.card.image_height,
            is_video: self.card.is_video,
        }
    }
}

/// The only address of a preview's picture a client is ever given.
pub fn preview_image_path(workspace_id: Uuid, preview_id: Uuid) -> String {
    format!("/v1/workspaces/{workspace_id}/unfurl-previews/{preview_id}/image")
}

/// The only address of a preview's site icon a client is ever given.
pub fn preview_icon_path(workspace_id: Uuid, preview_id: Uuid) -> String {
    format!("/v1/workspaces/{workspace_id}/unfurl-previews/{preview_id}/icon")
}

/// What the cache holds for one key.
#[derive(Debug, Clone)]
pub enum PreviewOutcome {
    Entry(Arc<PreviewEntry>),
    Failed,
}

#[derive(Debug)]
enum Kept {
    Ok(Arc<PreviewEntry>),
    Failed,
}

#[derive(Debug)]
struct Slot {
    /// The cache's clock when the slot was last used; the smallest goes first when full.
    used: u64,
    until: Instant,
    kept: Kept,
}

#[derive(Debug, Default)]
struct Inner {
    slots: HashMap<PreviewKey, Slot>,
    /// Preview id -> the key it lives under. An id exists only while its slot does.
    ids: HashMap<Uuid, PreviewKey>,
    clock: u64,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn remove_slot(&mut self, key: &PreviewKey) {
        if let Some(Slot {
            kept: Kept::Ok(entry),
            ..
        }) = self.slots.remove(key)
        {
            self.ids.remove(&entry.id);
        }
    }

    fn sweep_expired(&mut self, now: Instant) {
        let expired: Vec<PreviewKey> = self
            .slots
            .iter()
            .filter(|(_, slot)| slot.until <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_slot(&key);
        }
    }

    /// Keep one member to its share: past `cap`, what has run out goes first, then what **that
    /// member** used longest ago. Nobody else's is touched.
    fn evict_member_to(&mut self, member: Uuid, cap: usize, now: Instant) {
        let held = |slots: &HashMap<PreviewKey, Slot>| {
            slots.keys().filter(|key| key.member_id == member).count()
        };
        if held(&self.slots) <= cap {
            return;
        }
        let expired: Vec<PreviewKey> = self
            .slots
            .iter()
            .filter(|(key, slot)| key.member_id == member && slot.until <= now)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_slot(&key);
        }
        while held(&self.slots) > cap {
            let Some(oldest) = self
                .slots
                .iter()
                .filter(|(key, _)| key.member_id == member)
                .min_by_key(|(_, slot)| slot.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.remove_slot(&oldest);
        }
    }

    /// Make room: what has run out goes first, then what was used longest ago.
    fn evict_to(&mut self, max: usize, now: Instant) {
        if self.slots.len() <= max {
            return;
        }
        self.sweep_expired(now);
        while self.slots.len() > max {
            let Some(oldest) = self
                .slots
                .iter()
                .min_by_key(|(_, slot)| slot.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.remove_slot(&oldest);
        }
    }
}

/// The previews this process is holding. See the module docs.
#[derive(Debug)]
pub struct PreviewCache {
    limits: PreviewLimits,
    inner: Mutex<Inner>,
}

impl Default for PreviewCache {
    fn default() -> Self {
        PreviewCache::with_limits(PreviewLimits::default())
    }
}

impl PreviewCache {
    pub fn with_limits(limits: PreviewLimits) -> PreviewCache {
        PreviewCache {
            limits,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Plain maps and counters: a lock poisoned by someone else's panic still holds a map that
        // can be read and written, and losing the cache would turn that panic into an outage.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// What is held for `key` and has not run out. A hit becomes the most recently used.
    pub fn get(&self, key: &PreviewKey) -> Option<PreviewOutcome> {
        let now = Instant::now();
        let mut inner = self.lock();
        let stamp = inner.tick();
        let slot = inner.slots.get_mut(key)?;
        if slot.until > now {
            slot.used = stamp;
            return Some(match &slot.kept {
                Kept::Ok(entry) => PreviewOutcome::Entry(Arc::clone(entry)),
                Kept::Failed => PreviewOutcome::Failed,
            });
        }
        inner.remove_slot(key);
        None
    }

    /// Keep a card for `key` and give it its id. If a live one is already there (two asks for the
    /// same address raced) that one is kept and returned, so the first asker's id stays good.
    pub fn keep_ok(&self, key: PreviewKey, card: CardFields) -> Arc<PreviewEntry> {
        let now = Instant::now();
        let mut inner = self.lock();
        let stamp = inner.tick();
        if let Some(slot) = inner.slots.get_mut(&key) {
            if slot.until > now {
                if let Kept::Ok(entry) = &slot.kept {
                    slot.used = stamp;
                    return Arc::clone(entry);
                }
            }
        }
        let entry = Arc::new(PreviewEntry {
            id: Uuid::new_v4(),
            workspace_id: key.workspace_id,
            member_id: key.member_id,
            url: key.url_key.clone(),
            card,
        });
        if self.limits.max_entries == 0 || self.limits.max_entries_per_member == 0 {
            return entry;
        }
        // A failed or run-out slot for the same key goes, and its id with it.
        inner.remove_slot(&key);
        let member = key.member_id;
        inner.ids.insert(entry.id, key.clone());
        inner.slots.insert(
            key,
            Slot {
                used: stamp,
                until: now.checked_add(self.limits.ttl).unwrap_or(now),
                kept: Kept::Ok(Arc::clone(&entry)),
            },
        );
        inner.evict_member_to(member, self.limits.max_entries_per_member, now);
        inner.evict_to(self.limits.max_entries, now);
        entry
    }

    /// Remember that `key` just failed, for [`PreviewLimits::failure_ttl`]. A live card is never
    /// replaced by a failure.
    pub fn keep_failed(&self, key: PreviewKey) {
        if self.limits.max_entries == 0 || self.limits.max_entries_per_member == 0 {
            return;
        }
        let now = Instant::now();
        let mut inner = self.lock();
        if inner
            .slots
            .get(&key)
            .is_some_and(|slot| slot.until > now && matches!(slot.kept, Kept::Ok(_)))
        {
            return;
        }
        inner.remove_slot(&key);
        let stamp = inner.tick();
        let member = key.member_id;
        inner.slots.insert(
            key,
            Slot {
                used: stamp,
                until: now.checked_add(self.limits.failure_ttl).unwrap_or(now),
                kept: Kept::Failed,
            },
        );
        inner.evict_member_to(member, self.limits.max_entries_per_member, now);
        inner.evict_to(self.limits.max_entries, now);
    }

    /// The live preview `id` of `member_id` in `workspace_id`, or `None`: unknown, run out, made
    /// for another member, or made in another workspace. The four are the same answer on purpose.
    pub fn entry(
        &self,
        workspace_id: Uuid,
        member_id: Uuid,
        id: Uuid,
    ) -> Option<Arc<PreviewEntry>> {
        let now = Instant::now();
        let mut inner = self.lock();
        let key = inner.ids.get(&id)?.clone();
        if key.workspace_id != workspace_id || key.member_id != member_id {
            return None;
        }
        let stamp = inner.tick();
        let slot = inner.slots.get_mut(&key)?;
        if slot.until <= now {
            inner.remove_slot(&key);
            return None;
        }
        slot.used = stamp;
        match &slot.kept {
            Kept::Ok(entry) if entry.id == id => Some(Arc::clone(entry)),
            _ => None,
        }
    }

    /// `(slots, ids)` held right now, so a test can see that an id leaves with its slot.
    #[cfg(test)]
    fn held(&self) -> (usize, usize) {
        let inner = self.lock();
        (inner.slots.len(), inner.ids.len())
    }
}

/// The answer to one ask for a preview that the cache could not give.
#[derive(Debug, Clone)]
pub enum Previewed {
    /// The page has a card. It is already in the cache under its id.
    Entry(Arc<PreviewEntry>),
    /// No preview, whatever the reason (see the module docs). Remembered for a short while.
    Failed,
    /// This server had no place for the fetch: the member's own share of the fetches in flight,
    /// the process's, or a name lookup's. Says nothing about the address, so it is **not**
    /// remembered, and the caller gives the member's budget back and asks again soon.
    Busy,
}

/// Fetch `key`'s address as a [`FetchKind::Preview`], read it into a card and keep the answer.
///
/// `places` is the picture proxy's [`ImageCache`]: the process-wide and per-member **places among
/// the fetches in flight** are one pool, so one member's previews, pictures and icons together
/// never hold more than its share. The place is held for the fetch itself and let go before the
/// page is read (reading is CPU work on the blocking pool, not a socket).
///
/// The caller has already authorized the member, checked both switches, looked in the cache and
/// spent the member's budget; this is only the trip. `allow_development_http` is what the card
/// builder needs to judge the picture and icon addresses it finds (it is `false` wherever the
/// transport is [`crate::SafeUnfurlTransport::production`]`(false)`, which is the server).
pub async fn fetch_preview(
    http: &dyn UnfurlHttp,
    places: &ImageCache,
    previews: &PreviewCache,
    key: PreviewKey,
    allow_development_http: bool,
) -> Previewed {
    let Some(place) = places.try_start_fetch(key.member_id) else {
        return Previewed::Busy;
    };
    let fetched = http.fetch(&key.url_key, FetchKind::Preview).await;
    drop(place);
    let fetched = match fetched {
        Ok(fetched) => fetched,
        // This server's load, not the address's.
        Err(FetchError::Capacity) => return Previewed::Busy,
        Err(_) => {
            previews.keep_failed(key);
            return Previewed::Failed;
        }
    };
    match build_card_off_thread(fetched, allow_development_http).await {
        Some(card) => Previewed::Entry(previews.keep_ok(key, card)),
        None => {
            previews.keep_failed(key);
            Previewed::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::guard_fixtures::{GuardedScript, ScriptedReply};
    use crate::fetch::Fetched;
    use crate::proxy::ProxyLimits;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::sync::{Notify, Semaphore};

    const WS: Uuid = Uuid::from_u128(0xA);
    const MEMBER: Uuid = Uuid::from_u128(0xB);

    fn key(url: &str) -> PreviewKey {
        PreviewKey::new(WS, MEMBER, url)
    }

    fn page_with(html: &str) -> Fetched {
        Fetched {
            final_url: "https://news.example/story".into(),
            content_type: "text/html; charset=utf-8".into(),
            body: html.as_bytes().to_vec(),
        }
    }

    const STORY: &str = r#"<meta property="og:title" content="Story">
        <meta property="og:site_name" content="News Example">
        <meta property="og:image" content="/hero.png">
        <link rel="apple-touch-icon" href="/touch.png">"#;

    fn html_reply(html: &str) -> ScriptedReply {
        ScriptedReply::Body {
            content_type: "text/html; charset=utf-8",
            body: html.as_bytes().to_vec(),
        }
    }

    /// A transport that answers with `answer()` and counts how often it was asked.
    struct Scripted {
        asked: AtomicU32,
        answer: Box<dyn Fn() -> Result<Fetched, FetchError> + Send + Sync>,
    }

    impl Scripted {
        fn new(
            answer: impl Fn() -> Result<Fetched, FetchError> + Send + Sync + 'static,
        ) -> Scripted {
            Scripted {
                asked: AtomicU32::new(0),
                answer: Box::new(answer),
            }
        }

        fn asked(&self) -> u32 {
            self.asked.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Scripted {
        async fn fetch(&self, _url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
            assert_eq!(kind, FetchKind::Preview, "a preview asks as a preview");
            self.asked.fetch_add(1, Ordering::SeqCst);
            (self.answer)()
        }
    }

    async fn ask(http: &dyn UnfurlHttp, url: &str) -> (Previewed, PreviewCache) {
        let previews = PreviewCache::default();
        let outcome = fetch_preview(http, &ImageCache::default(), &previews, key(url), false).await;
        (outcome, previews)
    }

    // ---- the guard is the transport's, and a preview goes through it -------------------------

    #[tokio::test]
    async fn the_preview_fetch_is_refused_for_private_loopback_link_local_and_metadata_before_any_connect(
    ) {
        for url in [
            "https://127.0.0.1/",
            "https://127.1.2.3/x",
            "https://10.0.0.5/x",
            "https://172.16.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://100.64.0.1/",
            "https://[::1]/",
            "https://[fe80::1]/",
            "https://[::ffff:10.0.0.1]/",
            "https://localhost/",
            "https://printer.localhost/",
        ] {
            // The script would happily answer a page, so only the guard can be what refuses.
            let script = GuardedScript::new(vec![html_reply(STORY)]);
            let (outcome, previews) = ask(&script, url).await;
            assert!(matches!(outcome, Previewed::Failed), "{url}");
            assert_eq!(script.hops(), 0, "{url} reached a socket");
            assert!(
                matches!(previews.get(&key(url)), Some(PreviewOutcome::Failed)),
                "{url} is remembered as a plain failure"
            );
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_inward_is_a_failed_preview_and_never_dialled() {
        for answer in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.9",
            "169.254.169.254",
            "100.100.100.200",
            "::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            let script = GuardedScript::resolving_to(answer, vec![html_reply(STORY)]);
            let (outcome, _) = ask(&script, "https://intranet.example/").await;
            assert!(matches!(outcome, Previewed::Failed), "{answer}");
            assert_eq!(
                script.hops(),
                0,
                "a name that points at {answer} was dialled"
            );
        }
    }

    #[tokio::test]
    async fn a_preview_is_https_on_443_only_on_every_hop() {
        // An explicit port that is not 443, and plain http: refused before a socket.
        for url in [
            "https://news.example:8443/story",
            "https://news.example:80/story",
            "https://news.example:22/",
            "http://news.example/story",
        ] {
            let script = GuardedScript::new(vec![html_reply(STORY)]);
            let (outcome, _) = ask(&script, url).await;
            assert!(matches!(outcome, Previewed::Failed), "{url}");
            assert_eq!(script.hops(), 0, "{url} reached a socket");
        }

        // The default port and an explicit 443 are fine.
        for url in [
            "https://news.example/story",
            "https://news.example:443/story",
        ] {
            let script = GuardedScript::new(vec![html_reply(STORY)]);
            let (outcome, _) = ask(&script, url).await;
            assert!(matches!(outcome, Previewed::Entry(_)), "{url}");
            assert_eq!(script.hops(), 1, "{url}");
        }

        // A redirect to another port is refused at that hop: the first hop was dialled, the
        // second never is. A public host cannot be used to map ports by redirecting.
        for location in ["https://other.example:8443/b", "https://other.example:25/"] {
            let script = GuardedScript::new(vec![
                ScriptedReply::Redirect(location.into()),
                html_reply(STORY),
            ]);
            let (outcome, _) = ask(&script, "https://news.example/story").await;
            assert!(matches!(outcome, Previewed::Failed), "{location}");
            assert_eq!(script.hops(), 1, "{location} was followed");
        }
    }

    #[tokio::test]
    async fn a_preview_redirect_into_a_private_destination_stops_after_the_public_hop() {
        for location in [
            "https://169.254.169.254/latest/meta-data/",
            "https://127.0.0.1/",
            "https://10.0.0.5/admin",
            "https://[::1]/",
            "http://news.example/downgraded",
        ] {
            let script = GuardedScript::new(vec![
                ScriptedReply::Redirect(location.into()),
                html_reply(STORY),
            ]);
            let (outcome, _) = ask(&script, "https://news.example/story").await;
            assert!(matches!(outcome, Previewed::Failed), "{location}");
            assert_eq!(
                script.hops(),
                1,
                "only the public first hop may be dialled, not {location}"
            );
        }
        // And a redirect that stays public is followed: the guard is a guard, not a wall.
        let script = GuardedScript::new(vec![
            ScriptedReply::Redirect("https://www.news.example/story".into()),
            html_reply(STORY),
        ]);
        let (outcome, _) = ask(&script, "https://news.example/story").await;
        assert!(matches!(outcome, Previewed::Entry(_)));
        assert_eq!(script.hops(), 2);
    }

    // ---- what a card is, and what failure looks like -----------------------------------------

    #[tokio::test]
    async fn every_way_to_fail_is_the_same_failed_preview() {
        for error in [
            FetchError::Blocked,
            FetchError::OriginBlocked,
            FetchError::TooManyRedirects,
            FetchError::TooLarge,
            FetchError::Timeout,
            FetchError::Failed("dns".into()),
            FetchError::Failed("HTTP 404".into()),
        ] {
            let label = format!("{error:?}");
            let http = Scripted::new(move || Err(error.clone()));
            let (outcome, previews) = ask(&http, "https://news.example/story").await;
            assert!(matches!(outcome, Previewed::Failed), "{label}");
            // What is remembered is the same bare failure too.
            assert!(
                matches!(
                    previews.get(&key("https://news.example/story")),
                    Some(PreviewOutcome::Failed)
                ),
                "{label}"
            );
        }
    }

    #[tokio::test]
    async fn a_page_with_nothing_to_show_is_a_failed_preview() {
        for html in [
            "<html><body>no card in here</body></html>",
            r#"<meta property="og:site_name" content="Only A Name">"#,
            "",
        ] {
            let http = Scripted::new({
                let html = html.to_string();
                move || Ok(page_with(&html))
            });
            let (outcome, _) = ask(&http, "https://news.example/story").await;
            assert!(matches!(outcome, Previewed::Failed), "{html:?}");
        }
        // A title alone is enough, and the card is the worker's card.
        let http = Scripted::new(|| Ok(page_with(STORY)));
        let (outcome, previews) = ask(&http, "https://news.example/story").await;
        let Previewed::Entry(entry) = outcome else {
            panic!("a page with a title is a preview");
        };
        assert_eq!(entry.card.title.as_deref(), Some("Story"));
        assert_eq!(entry.card.site_name.as_deref(), Some("News Example"));
        assert_eq!(
            entry.card.image_url.as_deref(),
            Some("https://news.example/hero.png")
        );
        assert_eq!(
            entry.card.icon_url.as_deref(),
            Some("https://news.example/touch.png")
        );
        assert_eq!(entry.url, "https://news.example/story");
        // It is held under its id for the member who asked, and for nobody else.
        assert!(previews.entry(WS, MEMBER, entry.id).is_some());
    }

    // ---- the cache --------------------------------------------------------------------------

    #[test]
    fn the_cache_key_names_workspace_member_and_address() {
        let url = "https://news.example/story";
        let (other_ws, other_member) = (Uuid::from_u128(0xC), Uuid::from_u128(0xD));
        let a = PreviewKey::new(WS, MEMBER, url);
        assert_eq!(a, PreviewKey::new(WS, MEMBER, url));
        assert_ne!(a, PreviewKey::new(other_ws, MEMBER, url), "workspace");
        assert_ne!(a, PreviewKey::new(WS, other_member, url), "member");
        assert_ne!(a, PreviewKey::new(WS, MEMBER, "https://news.example/other"));

        // And the cache really keeps them apart: what one holds, the others do not see.
        let cache = PreviewCache::default();
        let card = CardFields {
            title: Some("T".into()),
            description: None,
            domain: None,
            site_name: None,
            image_url: None,
            image_width: None,
            image_height: None,
            icon_url: None,
            is_video: false,
        };
        let held = cache.keep_ok(a.clone(), card);
        assert!(cache.get(&a).is_some());
        assert!(cache.get(&PreviewKey::new(other_ws, MEMBER, url)).is_none());
        assert!(cache.get(&PreviewKey::new(WS, other_member, url)).is_none());
        assert!(cache.entry(other_ws, MEMBER, held.id).is_none());
        assert!(cache.entry(WS, other_member, held.id).is_none());
    }

    fn bare_card(title: &str) -> CardFields {
        CardFields {
            title: Some(title.into()),
            description: None,
            domain: None,
            site_name: None,
            image_url: None,
            image_width: None,
            image_height: None,
            icon_url: None,
            is_video: false,
        }
    }

    #[test]
    fn an_ok_preview_is_kept_for_its_ttl_and_a_failed_one_for_a_shorter_while() {
        let cache = PreviewCache::with_limits(PreviewLimits {
            max_entries: 8,
            ttl: Duration::from_millis(300),
            failure_ttl: Duration::from_millis(50),
            ..PreviewLimits::default()
        });
        let (good, bad) = (key("https://a.example/"), key("https://b.example/"));
        let entry = cache.keep_ok(good.clone(), bare_card("A"));
        cache.keep_failed(bad.clone());
        assert!(matches!(cache.get(&bad), Some(PreviewOutcome::Failed)));
        assert_eq!(cache.held(), (2, 1));

        std::thread::sleep(Duration::from_millis(100));
        assert!(cache.get(&bad).is_none(), "the failure ran out first");
        assert!(cache.get(&good).is_some(), "the card is still kept");
        assert!(cache.entry(WS, MEMBER, entry.id).is_some());

        std::thread::sleep(Duration::from_millis(250));
        assert!(cache.get(&good).is_none(), "the card ran out");
        assert!(
            cache.entry(WS, MEMBER, entry.id).is_none(),
            "an id does not outlive its card"
        );
        assert_eq!(cache.held(), (0, 0), "nothing is left behind");
    }

    #[test]
    fn the_least_recently_used_preview_goes_first_and_its_id_goes_with_it() {
        let cache = PreviewCache::with_limits(PreviewLimits {
            max_entries: 2,
            ..PreviewLimits::default()
        });
        let (a, b, c) = (
            key("https://a.example/"),
            key("https://b.example/"),
            key("https://c.example/"),
        );
        let first = cache.keep_ok(a.clone(), bare_card("A"));
        let second = cache.keep_ok(b.clone(), bare_card("B"));
        // `a` is used again, so `b` is the one used longest ago.
        assert!(cache.get(&a).is_some());
        let third = cache.keep_ok(c.clone(), bare_card("C"));
        assert!(cache.get(&b).is_none());
        assert!(
            cache.entry(WS, MEMBER, second.id).is_none(),
            "its id went too"
        );
        assert!(cache.entry(WS, MEMBER, first.id).is_some());
        assert!(cache.entry(WS, MEMBER, third.id).is_some());
        assert_eq!(
            cache.held(),
            (2, 2),
            "never more than the bound, ids included"
        );

        // A failure counts toward the same bound and cannot push the cards out for good.
        for n in 0..10 {
            cache.keep_failed(key(&format!("https://bad{n}.example/")));
        }
        assert_eq!(cache.held().0, 2);
    }

    #[test]
    fn one_member_cannot_fill_the_cache_and_push_out_another_members_previews() {
        let cache = PreviewCache::with_limits(PreviewLimits {
            max_entries: 6,
            max_entries_per_member: 2,
            ..PreviewLimits::default()
        });
        let other = Uuid::from_u128(0xEE);
        let theirs = PreviewKey::new(WS, other, "https://theirs.example/");
        let their_entry = cache.keep_ok(theirs.clone(), bare_card("theirs"));

        // One member asks about many addresses: it holds two, and its own oldest go.
        let mine: Vec<PreviewKey> = (0..5)
            .map(|n| key(&format!("https://mine{n}.example/")))
            .collect();
        let entries: Vec<_> = mine
            .iter()
            .map(|k| cache.keep_ok(k.clone(), bare_card("mine")))
            .collect();
        for (n, (asked, entry)) in mine.iter().zip(&entries).enumerate() {
            if n < 3 {
                assert!(cache.get(asked).is_none(), "mine{n} went");
                assert!(
                    cache.entry(WS, MEMBER, entry.id).is_none(),
                    "and so did its id"
                );
            } else {
                assert!(cache.get(asked).is_some(), "mine{n} stayed");
            }
        }
        // The other member's preview was never in the way.
        assert!(cache.get(&theirs).is_some());
        assert!(cache.entry(WS, other, their_entry.id).is_some());
        // Failures count toward the same share.
        for n in 0..5 {
            cache.keep_failed(key(&format!("https://bad{n}.example/")));
        }
        assert!(
            cache.get(&theirs).is_some(),
            "failures did not push it out either"
        );
        let mine_held = cache
            .lock()
            .slots
            .keys()
            .filter(|k| k.member_id() == MEMBER)
            .count();
        assert_eq!(mine_held, 2, "never more than the member's share");
        assert_eq!(cache.held().0, 3, "its two and the other member's one");
    }

    #[test]
    fn a_preview_belongs_to_the_member_who_asked() {
        let cache = PreviewCache::default();
        let entry = cache.keep_ok(key("https://a.example/"), bare_card("A"));
        assert!(cache.entry(WS, MEMBER, entry.id).is_some());
        assert!(cache.entry(WS, Uuid::from_u128(0x99), entry.id).is_none());
        assert!(cache
            .entry(Uuid::from_u128(0x98), MEMBER, entry.id)
            .is_none());
        assert!(cache.entry(WS, MEMBER, Uuid::new_v4()).is_none());
        // Two asks that raced for the same address share the first one's id.
        let again = cache.keep_ok(key("https://a.example/"), bare_card("A, again"));
        assert_eq!(again.id, entry.id);
        assert_eq!(again.card.title.as_deref(), Some("A"));
        // A failure does not replace a card that is still good.
        cache.keep_failed(key("https://a.example/"));
        assert!(matches!(
            cache.get(&key("https://a.example/")),
            Some(PreviewOutcome::Entry(_))
        ));
    }

    // ---- places ------------------------------------------------------------------------------

    #[tokio::test]
    async fn a_place_shortage_is_busy_and_is_never_remembered() {
        // The member has no share at all: the transport is never asked and nothing is kept.
        let http = Scripted::new(|| Ok(page_with(STORY)));
        let previews = PreviewCache::default();
        let places = ImageCache::with_limits(ProxyLimits {
            max_in_flight_per_member: 0,
            ..ProxyLimits::default()
        });
        let outcome = fetch_preview(
            &http,
            &places,
            &previews,
            key("https://news.example/story"),
            false,
        )
        .await;
        assert!(matches!(outcome, Previewed::Busy));
        assert_eq!(http.asked(), 0, "no place, no request");
        assert_eq!(previews.held(), (0, 0));

        // The process is full: the same.
        let places = ImageCache::with_limits(ProxyLimits {
            max_in_flight: 0,
            ..ProxyLimits::default()
        });
        let outcome = fetch_preview(
            &http,
            &places,
            &previews,
            key("https://news.example/story"),
            false,
        )
        .await;
        assert!(matches!(outcome, Previewed::Busy));
        assert_eq!(http.asked(), 0);

        // The transport had no room for a name lookup: busy, and not a verdict on the address.
        let no_room = Scripted::new(|| Err(FetchError::Capacity));
        let outcome = fetch_preview(
            &no_room,
            &ImageCache::default(),
            &previews,
            key("https://news.example/story"),
            false,
        )
        .await;
        assert!(matches!(outcome, Previewed::Busy));
        assert_eq!(no_room.asked(), 1);
        assert_eq!(previews.held(), (0, 0), "a busy moment is not remembered");
    }

    /// A transport that does not answer until it is given a permit, and says when it was asked.
    struct Parked {
        asked: AtomicU32,
        entered: Notify,
        release: Semaphore,
    }

    #[async_trait::async_trait]
    impl UnfurlHttp for Parked {
        async fn fetch(&self, _url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            self.release.acquire().await.expect("open").forget();
            Ok(page_with(STORY))
        }
    }

    /// Everything this test waits for happens at once or never: a wait that is not over in seconds
    /// is a failure (a share that does not hold would park the second ask behind the first).
    async fn at_once<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(3), wait)
            .await
            .unwrap_or_else(|_| panic!("{what}"))
    }

    #[tokio::test]
    async fn one_member_cannot_hold_more_places_than_its_share_while_another_is_served() {
        let http = Arc::new(Parked {
            asked: AtomicU32::new(0),
            entered: Notify::new(),
            release: Semaphore::new(0),
        });
        let previews = Arc::new(PreviewCache::default());
        // One place each; the process has room for both members.
        let places = Arc::new(ImageCache::with_limits(ProxyLimits {
            max_in_flight_per_member: 1,
            max_in_flight: 4,
            ..ProxyLimits::default()
        }));
        let first = tokio::spawn({
            let (http, places, previews) = (http.clone(), places.clone(), previews.clone());
            async move {
                fetch_preview(
                    http.as_ref(),
                    &places,
                    &previews,
                    key("https://news.example/one"),
                    false,
                )
                .await
            }
        });
        at_once(
            "the first ask never reached the transport",
            http.entered.notified(),
        )
        .await;

        // The same member's second ask is turned away at once, without a request.
        let second = at_once(
            "the member's second ask was parked behind its first instead of being turned away",
            fetch_preview(
                http.as_ref(),
                &places,
                &previews,
                key("https://news.example/two"),
                false,
            ),
        )
        .await;
        assert!(matches!(second, Previewed::Busy));
        assert_eq!(http.asked.load(Ordering::SeqCst), 1);

        // Another member is served meanwhile.
        let other = tokio::spawn({
            let (http, places, previews) = (http.clone(), places.clone(), previews.clone());
            async move {
                fetch_preview(
                    http.as_ref(),
                    &places,
                    &previews,
                    PreviewKey::new(WS, Uuid::from_u128(0xEE), "https://news.example/three"),
                    false,
                )
                .await
            }
        });
        at_once(
            "the other member's ask was not served",
            http.entered.notified(),
        )
        .await;
        assert_eq!(http.asked.load(Ordering::SeqCst), 2);

        http.release.add_permits(2);
        assert!(matches!(
            at_once("the first ask never finished", first)
                .await
                .unwrap(),
            Previewed::Entry(_)
        ));
        assert!(matches!(
            at_once("the other ask never finished", other)
                .await
                .unwrap(),
            Previewed::Entry(_)
        ));

        // The share came back when the fetch ended.
        http.release.add_permits(1);
        let third = at_once(
            "the share did not come back when the fetches ended",
            fetch_preview(
                http.as_ref(),
                &places,
                &previews,
                key("https://news.example/four"),
                false,
            ),
        )
        .await;
        assert!(matches!(third, Previewed::Entry(_)));
    }
}
