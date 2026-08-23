//! Link unfurl — derived Open Graph / Twitter-card metadata (ADR-0170 / #1698).
//!
//! ## P9 boundary (ADR-0170 D2)
//!
//! The worker reads **link targets**, not message bodies as content. URL
//! extraction is a mechanical pick of `http(s)://` tokens (the same class of
//! work as `@mention` parsing) and the bytes that leave the process are a GET
//! of those URLs under [`crate::fetch::SafeUnfurlTransport`]. Notification
//! judgment (ux-bible P9, ADR-0124) still does not read `message.body`. Agent
//! and human authors are the same path — there is no `member.kind` branch.
//!
//! ## What this crate owns
//!
//! * URL extract / normalise / OG+Twitter parse
//! * the SSRF-guarded GET (OutboundHTTPPolicy reused, redirect ≤3 re-checked)
//! * `message_unfurl` / cache / job / tombstone / workspace setting SQL
//! * the drain loop the webhook-sender binary runs
//!
//! It owns no Axum types. The route layer translates HTTP.

pub mod config;
pub mod extract;
pub mod fetch;
pub mod normalize;
pub mod parse;
pub mod proxy;
pub mod remove;
pub mod settings;
pub mod store;
pub mod worker;

pub use config::UnfurlConfig;
pub use extract::{extract_urls, MAX_URLS_PER_MESSAGE};
pub use fetch::{
    FetchError, FetchKind, Fetched, SafeUnfurlTransport, UnfurlHttp, HTML_MAX_BYTES,
    IMAGE_MAX_BYTES, MAX_REDIRECTS, UNFURL_USER_AGENT,
};
pub use normalize::normalize_url;
pub use parse::parse_card;
pub use proxy::{
    fetch_record_image, proxy_image_in_tx, CachedImage, ImageCache, ProxyError, ProxyImage,
};
pub use remove::{remove_unfurls_in_tx, RemoveOutcome};
pub use settings::{load_setting_in_tx, upsert_setting_in_tx, UnfurlSetting};
pub use store::{list_unfurls_in_tx, load_unfurl_in_tx, UnfurlRecord};
pub use worker::{DrainStats, UnfurlWorker, NOTIFY_CHANNEL};

/// `MOMO_UNFURL_ENABLED` is exactly the character `1`. Anything else — unset,
/// `0`, `true`, `yes` — is off. Self-host egress stays opt-in (ADR-0170 D3).
pub fn enabled_from_env() -> bool {
    std::env::var("MOMO_UNFURL_ENABLED")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

#[cfg(test)]
mod tests {
    #[test]
    fn instance_switch_is_opt_in_one() {
        assert!(!super::enabled_from_env());
    }
}
