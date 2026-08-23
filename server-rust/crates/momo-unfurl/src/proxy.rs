//! Image proxy: the client never contacts a remote host (ADR-0170 D5 / CSP).
//!
//! Cache is a small in-process map. Drive archive reuse was considered and
//! rejected as over-design for v0.

use std::collections::HashMap;
use std::sync::Mutex;

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::fetch::{FetchError, FetchKind, UnfurlHttp};
use crate::store::{load_unfurl_in_tx, UnfurlRecord};

const CACHE_CAP: usize = 64;
const ALLOWED_PREFIX: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
];

#[derive(Debug, Clone)]
pub struct CachedImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
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

pub async fn fetch_record_image(
    record: &UnfurlRecord,
    http: &dyn UnfurlHttp,
    cache: &ImageCache,
) -> Result<ProxyImage, ProxyError> {
    if record.status != "ok" {
        return Err(ProxyError::Unavailable);
    }
    let Some(image_url) = record.image_url.as_deref() else {
        return Err(ProxyError::Unavailable);
    };
    let key = record
        .image_proxy_key
        .clone()
        .unwrap_or_else(|| crate::store::image_proxy_key(image_url));
    if let Some(hit) = cache.get(&key) {
        return Ok(ProxyImage {
            bytes: hit.bytes,
            content_type: hit.content_type,
        });
    }
    let fetched = match http.fetch(image_url, FetchKind::Image).await {
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
    if !ALLOWED_PREFIX.iter().any(|prefix| content_type == *prefix) {
        return Err(ProxyError::Unavailable);
    }
    cache.put(
        key,
        CachedImage {
            bytes: fetched.body.clone(),
            content_type: content_type.clone(),
        },
    );
    Ok(ProxyImage {
        bytes: fetched.body,
        content_type,
    })
}
