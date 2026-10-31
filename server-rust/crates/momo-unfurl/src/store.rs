//! `message_unfurl` / cache / job SQL. Every statement takes a caller-supplied
//! connection so [`momo_db::with_tenant_tx`] stays the GUC seam.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgExecutor, Row};
use uuid::Uuid;

pub const CACHE_TTL: chrono::Duration = chrono::Duration::hours(24);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfurlRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub url_key: String,
    pub source_url: String,
    pub status: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub domain: Option<String>,
    pub image_proxy_key: Option<String>,
    /// Remote picture address. Only the authenticated proxy reads it; never sent to a client.
    pub image_url: Option<String>,
    pub site_name: Option<String>,
    pub icon_proxy_key: Option<String>,
    /// Remote icon address. Only the authenticated icon proxy reads it; never sent to a client.
    pub icon_source_url: Option<String>,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub is_video: bool,
}

#[derive(Debug, Clone)]
pub struct CacheHit {
    pub status: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub domain: Option<String>,
    pub image_proxy_key: Option<String>,
    pub image_url: Option<String>,
    pub site_name: Option<String>,
    pub icon_proxy_key: Option<String>,
    pub icon_source_url: Option<String>,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub is_video: bool,
}

/// The columns of a card row, in the order [`decode_record`] reads them.
const RECORD_COLUMNS: &str = "id, workspace_id, channel_id, message_id, url_key, source_url, \
     status, title, description, domain, image_proxy_key, image_url, \
     site_name, icon_proxy_key, icon_source_url, image_width, image_height, is_video";

#[derive(Debug, Clone)]
pub struct ClaimedJob {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub attempts: i32,
}

#[derive(Debug, Clone)]
pub struct MessageRef {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub seq: i64,
    pub author_member_id: Uuid,
    pub body: Option<String>,
}

pub fn image_proxy_key(image_url: &str) -> String {
    let digest = Sha256::digest(image_url.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn domain_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
}

pub async fn claim_job_batch(
    pool: &momo_db::PgPool,
    batch: i64,
) -> Result<Vec<ClaimedJob>, sqlx::Error> {
    let rows = sqlx::query(
        "WITH claimed AS ( \
             SELECT id FROM unfurl_job \
              WHERE status = 'pending' \
              ORDER BY created_at \
              FOR UPDATE SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE unfurl_job j \
            SET status = 'processing', claimed_at = now(), attempts = j.attempts + 1 \
           FROM claimed c \
          WHERE j.id = c.id \
          RETURNING j.id, j.workspace_id, j.channel_id, j.message_id, j.attempts",
    )
    .bind(batch)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ClaimedJob {
            id: row.get("id"),
            workspace_id: row.get("workspace_id"),
            channel_id: row.get("channel_id"),
            message_id: row.get("message_id"),
            attempts: row.get("attempts"),
        })
        .collect())
}

pub async fn finish_job<'e, E: PgExecutor<'e>>(
    executor: E,
    job_id: Uuid,
    status: &str,
    last_error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE unfurl_job SET status = $2, last_error = $3 WHERE id = $1")
        .bind(job_id)
        .bind(status)
        .bind(last_error)
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn requeue_job<'e, E: PgExecutor<'e>>(
    executor: E,
    job_id: Uuid,
    last_error: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE unfurl_job SET status = 'pending', last_error = $2, claimed_at = NULL \
          WHERE id = $1",
    )
    .bind(job_id)
    .bind(last_error)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn load_message(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Option<MessageRef>, DbError> {
    let row = sqlx::query(
        "SELECT id, channel_id, seq, author_member_id, body \
           FROM message WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| MessageRef {
        id: row.get("id"),
        channel_id: row.get("channel_id"),
        seq: row.get("seq"),
        author_member_id: row.get("author_member_id"),
        body: row.get("body"),
    }))
}

pub async fn tombstone_exists(conn: &mut PgConnection, message_id: Uuid) -> Result<bool, DbError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_unfurl_tombstone WHERE message_id = $1)",
    )
    .bind(message_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(exists)
}

pub async fn cache_lookup(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    url_key: &str,
) -> Result<Option<CacheHit>, DbError> {
    let row = sqlx::query(
        "SELECT status, title, description, domain, image_proxy_key, image_url, \
                site_name, icon_proxy_key, icon_source_url, image_width, image_height, is_video \
           FROM unfurl_url_cache \
          WHERE workspace_id = $1 AND url_key = $2 AND expires_at > now()",
    )
    .bind(workspace_id)
    .bind(url_key)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|row| CacheHit {
        status: row.get("status"),
        title: row.get("title"),
        description: row.get("description"),
        domain: row.get("domain"),
        image_proxy_key: row.get("image_proxy_key"),
        image_url: row.get("image_url"),
        site_name: row.get("site_name"),
        icon_proxy_key: row.get("icon_proxy_key"),
        icon_source_url: row.get("icon_source_url"),
        image_width: row.get("image_width"),
        image_height: row.get("image_height"),
        is_video: row.get("is_video"),
    }))
}

pub struct UpsertSpec<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub url_key: &'a str,
    pub source_url: &'a str,
    pub status: &'a str,
    pub title: Option<&'a str>,
    pub description: Option<&'a str>,
    pub domain: Option<&'a str>,
    pub image_proxy_key: Option<&'a str>,
    pub image_url: Option<&'a str>,
    pub site_name: Option<&'a str>,
    pub icon_proxy_key: Option<&'a str>,
    pub icon_source_url: Option<&'a str>,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub is_video: bool,
}

pub async fn upsert_unfurl_and_cache(
    conn: &mut PgConnection,
    spec: UpsertSpec<'_>,
) -> Result<Uuid, DbError> {
    let expires_at: DateTime<Utc> = Utc::now() + CACHE_TTL;
    if spec.status != "pending" {
        sqlx::query(
            "INSERT INTO unfurl_url_cache \
               (workspace_id, url_key, status, title, description, domain, \
                image_proxy_key, image_url, site_name, icon_proxy_key, icon_source_url, \
                image_width, image_height, is_video, fetched_at, expires_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15) \
             ON CONFLICT (workspace_id, url_key) DO UPDATE SET \
               status = EXCLUDED.status, \
               title = EXCLUDED.title, \
               description = EXCLUDED.description, \
               domain = EXCLUDED.domain, \
               image_proxy_key = EXCLUDED.image_proxy_key, \
               image_url = EXCLUDED.image_url, \
               site_name = EXCLUDED.site_name, \
               icon_proxy_key = EXCLUDED.icon_proxy_key, \
               icon_source_url = EXCLUDED.icon_source_url, \
               image_width = EXCLUDED.image_width, \
               image_height = EXCLUDED.image_height, \
               is_video = EXCLUDED.is_video, \
               fetched_at = now(), \
               expires_at = EXCLUDED.expires_at",
        )
        .bind(spec.workspace_id)
        .bind(spec.url_key)
        .bind(spec.status)
        .bind(spec.title)
        .bind(spec.description)
        .bind(spec.domain)
        .bind(spec.image_proxy_key)
        .bind(spec.image_url)
        .bind(spec.site_name)
        .bind(spec.icon_proxy_key)
        .bind(spec.icon_source_url)
        .bind(spec.image_width)
        .bind(spec.image_height)
        .bind(spec.is_video)
        .bind(expires_at)
        .execute(&mut *conn)
        .await?;
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO message_unfurl \
           (workspace_id, channel_id, message_id, url_key, source_url, status, \
            title, description, domain, image_proxy_key, image_url, \
            site_name, icon_proxy_key, icon_source_url, image_width, image_height, is_video, \
            fetched_at, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18) \
         ON CONFLICT (message_id, url_key) DO UPDATE SET \
           status = EXCLUDED.status, \
           title = EXCLUDED.title, \
           description = EXCLUDED.description, \
           domain = EXCLUDED.domain, \
           image_proxy_key = EXCLUDED.image_proxy_key, \
           image_url = EXCLUDED.image_url, \
           site_name = EXCLUDED.site_name, \
           icon_proxy_key = EXCLUDED.icon_proxy_key, \
           icon_source_url = EXCLUDED.icon_source_url, \
           image_width = EXCLUDED.image_width, \
           image_height = EXCLUDED.image_height, \
           is_video = EXCLUDED.is_video, \
           fetched_at = now(), \
           expires_at = EXCLUDED.expires_at, \
           updated_at = now() \
         RETURNING id",
    )
    .bind(spec.workspace_id)
    .bind(spec.channel_id)
    .bind(spec.message_id)
    .bind(spec.url_key)
    .bind(spec.source_url)
    .bind(spec.status)
    .bind(spec.title)
    .bind(spec.description)
    .bind(spec.domain)
    .bind(spec.image_proxy_key)
    .bind(spec.image_url)
    .bind(spec.site_name)
    .bind(spec.icon_proxy_key)
    .bind(spec.icon_source_url)
    .bind(spec.image_width)
    .bind(spec.image_height)
    .bind(spec.is_video)
    .bind(expires_at)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

pub async fn list_unfurls_in_tx(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Vec<UnfurlRecord>, DbError> {
    // Rows written in one transaction share `created_at`; the uuidv7 id (monotonic within the
    // writing session) keeps them in the order the links appeared in the message.
    let rows = sqlx::query(&format!(
        "SELECT {RECORD_COLUMNS} FROM message_unfurl \
          WHERE message_id = $1 \
          ORDER BY created_at, id"
    ))
    .bind(message_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(decode_record).collect())
}

pub async fn load_unfurl_in_tx(
    conn: &mut PgConnection,
    unfurl_id: Uuid,
) -> Result<Option<UnfurlRecord>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {RECORD_COLUMNS} FROM message_unfurl WHERE id = $1"
    ))
    .bind(unfurl_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(decode_record))
}

fn decode_record(row: sqlx::postgres::PgRow) -> UnfurlRecord {
    UnfurlRecord {
        id: row.get("id"),
        workspace_id: row.get("workspace_id"),
        channel_id: row.get("channel_id"),
        message_id: row.get("message_id"),
        url_key: row.get("url_key"),
        source_url: row.get("source_url"),
        status: row.get("status"),
        title: row.get("title"),
        description: row.get("description"),
        domain: row.get("domain"),
        image_proxy_key: row.get("image_proxy_key"),
        image_url: row.get("image_url"),
        site_name: row.get("site_name"),
        icon_proxy_key: row.get("icon_proxy_key"),
        icon_source_url: row.get("icon_source_url"),
        image_width: row.get("image_width"),
        image_height: row.get("image_height"),
        is_video: row.get("is_video"),
    }
}

/// Record the size the image proxy measured from the bytes it received, **once** (D12). Only a
/// card that has no size yet is touched, and the 24 h cache row for the same page and picture is
/// brought along so the next message that links the page starts with it. Returns whether the
/// card row was written. Runs under the caller's tenant transaction, so RLS decides whose rows.
pub async fn record_measured_size(
    conn: &mut PgConnection,
    record: &UnfurlRecord,
    width: i32,
    height: i32,
) -> Result<bool, DbError> {
    let written = sqlx::query(
        "UPDATE message_unfurl SET image_width = $2, image_height = $3 \
          WHERE id = $1 AND image_width IS NULL AND image_height IS NULL",
    )
    .bind(record.id)
    .bind(width)
    .bind(height)
    .execute(&mut *conn)
    .await?
    .rows_affected()
        > 0;
    if written {
        sqlx::query(
            "UPDATE unfurl_url_cache SET image_width = $4, image_height = $5 \
              WHERE workspace_id = $1 AND url_key = $2 AND image_proxy_key = $3 \
                AND image_width IS NULL AND image_height IS NULL",
        )
        .bind(record.workspace_id)
        .bind(&record.url_key)
        .bind(&record.image_proxy_key)
        .bind(width)
        .bind(height)
        .execute(&mut *conn)
        .await?;
    }
    Ok(written)
}

pub fn cent_channel(workspace_id: Uuid, channel_id: Uuid) -> String {
    format!(
        "ch:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        channel_id.to_string().to_uppercase()
    )
}
