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
    pub image_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CacheHit {
    pub status: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub domain: Option<String>,
    pub image_proxy_key: Option<String>,
    pub image_url: Option<String>,
}

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
        "SELECT status, title, description, domain, image_proxy_key, image_url \
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
                image_proxy_key, image_url, fetched_at, expires_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9) \
             ON CONFLICT (workspace_id, url_key) DO UPDATE SET \
               status = EXCLUDED.status, \
               title = EXCLUDED.title, \
               description = EXCLUDED.description, \
               domain = EXCLUDED.domain, \
               image_proxy_key = EXCLUDED.image_proxy_key, \
               image_url = EXCLUDED.image_url, \
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
        .bind(expires_at)
        .execute(&mut *conn)
        .await?;
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO message_unfurl \
           (workspace_id, channel_id, message_id, url_key, source_url, status, \
            title, description, domain, image_proxy_key, image_url, fetched_at, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12) \
         ON CONFLICT (message_id, url_key) DO UPDATE SET \
           status = EXCLUDED.status, \
           title = EXCLUDED.title, \
           description = EXCLUDED.description, \
           domain = EXCLUDED.domain, \
           image_proxy_key = EXCLUDED.image_proxy_key, \
           image_url = EXCLUDED.image_url, \
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
    .bind(expires_at)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

pub async fn list_unfurls_in_tx(
    conn: &mut PgConnection,
    message_id: Uuid,
) -> Result<Vec<UnfurlRecord>, DbError> {
    let rows = sqlx::query(
        "SELECT id, workspace_id, channel_id, message_id, url_key, source_url, \
                status, title, description, domain, image_proxy_key, image_url \
           FROM message_unfurl \
          WHERE message_id = $1 \
          ORDER BY created_at",
    )
    .bind(message_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(decode_record).collect())
}

pub async fn load_unfurl_in_tx(
    conn: &mut PgConnection,
    unfurl_id: Uuid,
) -> Result<Option<UnfurlRecord>, DbError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, channel_id, message_id, url_key, source_url, \
                status, title, description, domain, image_proxy_key, image_url \
           FROM message_unfurl WHERE id = $1",
    )
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
    }
}

pub fn cent_channel(workspace_id: Uuid, channel_id: Uuid) -> String {
    format!(
        "ch:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        channel_id.to_string().to_uppercase()
    )
}
