//! #4820 C2a — the short-lived, single-use address of the requester's **own** picture
//! (ADR-0218 증보 G4·G8, ADR-0203 증보 I2·I4; owner 10-30 결정 ①).
//!
//! The co-hosted Hermes' picture tool reads its source through `image_url`, so oort hands it
//! one address: `{origin}/v1/self-media/{workspace}/{token}`. This module is both halves of
//! that address and nothing else:
//!
//! * [`mint_for_run_in_tx`] — the agent-worker, inside a tenant transaction, right before it
//!   builds the hosted request. The picture is the first complete image of the run's **trigger
//!   message**, written by the run's requester in the run's conversation
//!   ([`find_requester_attachment_in_tx`]'s rule, the one the avatar flow uses). The token is
//!   32 random bytes; only its SHA-256 is stored.
//! * [`redeem_in_tx`] — the api's public route, inside a tenant transaction the **path's**
//!   workspace binds. One `UPDATE … WHERE used_at IS NULL AND expires_at > now() AND the run is
//!   still in flight` spends the token; the binding is then re-proved at redeem time (the
//!   message may have been deleted since). Every refusal is the same `None`: unknown, other
//!   workspace, expired, spent, run over, somebody else's file, deleted — the caller answers one
//!   404 and learns nothing from which it was.
//!
//! What is deliberately not here: any Drive URL (the route proxies the bytes itself), any
//! token or Drive id in a log line, an audit row or the outbox (the token table is the record,
//! hash only; [`redact_self_media_urls`] is the scrub every error string passes), and any way
//! to name an attachment that is not the trigger message's (no attachment id comes from a
//! caller — not from the agent, not from the model, not from a request).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use momo_db::DbError;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::agent_avatar::{find_requester_attachment_in_tx, requester_of_run_in_tx};
use crate::identity::is_channel_member;

/// The fixed path prefix of the address. The Hermes guard plugin pins the same literal.
pub const SELF_MEDIA_PATH_PREFIX: &str = "/v1/self-media/";
/// How long a minted address lives. The table's own ceiling is ten minutes.
pub const SELF_MEDIA_TTL_SECS: i64 = 300;
/// The same input ceiling a picture moved inside the server has (ADR-0218 G3.2).
pub const SELF_MEDIA_MAX_BYTES: i64 = 5 * 1024 * 1024;
/// 32 random bytes in unpadded URL-safe base64.
pub const SELF_MEDIA_TOKEN_CHARS: usize = 43;
/// Spent and expired rows stay a day (they are the record), then the next mint in that workspace drops them.
const CLEANUP_AFTER_SECS: f64 = 86_400.0;

/// A freshly minted address: the token (shown once, never stored) and when it dies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfMediaGrant {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

/// What a redeemed token lets the route read: one Drive file, its declared size and mime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfMediaSource {
    pub drive_file_id: String,
    pub size_bytes: i64,
    pub mime: String,
}

/// The configured public origin, accepted only in the one canonical form the guard plugin and the
/// lock gate accept (`infra/hermes/self_media_vectors.json` holds the shared accept/reject list):
/// `https://` + a lowercase ASCII host of at least two dot-separated labels (letters, digits,
/// inner hyphens; the last label starts with a letter, so no numeric/IP-looking host) + an
/// optional explicit port that is 1..=65535 without leading zeros and is not the default 443.
/// No userinfo, path, slash, query, fragment, whitespace, uppercase or non-ASCII. The bytes are
/// compared as written, so anything that merely *normalizes* to the same origin is not it.
pub fn canonical_origin(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix("https://")?;
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if let Some(port) = port {
        if port.is_empty()
            || port.len() > 5
            || port.starts_with('0')
            || !port.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let number: u32 = port.parse().ok()?;
        if number == 0 || number > 65_535 || number == 443 {
            return None;
        }
    }
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    for (index, label) in labels.iter().enumerate() {
        let bytes = label.as_bytes();
        if bytes.is_empty() || bytes.len() > 63 {
            return None;
        }
        if !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        {
            return None;
        }
        if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
            return None;
        }
        if index == labels.len() - 1 && !bytes[0].is_ascii_lowercase() {
            return None;
        }
    }
    Some(raw)
}

/// `{origin}/v1/self-media/{workspace}/{token}`. The caller passes a [`canonical_origin`].
pub fn self_media_url(origin: &str, workspace_id: Uuid, token: &str) -> String {
    format!("{origin}{SELF_MEDIA_PATH_PREFIX}{workspace_id}/{token}")
}

/// Exactly the token alphabet and length [`new_token`] produces. Nothing else reaches the database.
pub fn token_is_well_formed(token: &str) -> bool {
    token.len() == SELF_MEDIA_TOKEN_CHARS
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The SHA-256 of the token's own text (the string is the credential, not its decoded bytes, so two
/// spellings of the same bytes are two different, mostly never-minted, tokens).
pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn new_token() -> Option<String> {
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).ok()?;
    Some(URL_SAFE_NO_PAD.encode(secret))
}

/// Does `bytes` start like the image its row says it is? The route serves what an uploader chose
/// to store, from the api's own origin, so it refuses bytes that are not the declared picture.
pub fn bytes_match_mime(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// Mint the address for a run (production TTL). `None` — no picture to hand over, or any rule not
/// met — means the hosted request simply carries no address.
pub async fn mint_for_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<SelfMediaGrant>, DbError> {
    mint_with_ttl_in_tx(
        conn,
        workspace_id,
        run_id,
        agent_member_id,
        SELF_MEDIA_TTL_SECS,
    )
    .await
}

/// [`mint_for_run_in_tx`] with an explicit TTL (seconds). The table refuses anything over ten
/// minutes or not positive, so a wrong value here is an error, not a long-lived token.
pub async fn mint_with_ttl_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    ttl_secs: i64,
) -> Result<Option<SelfMediaGrant>, DbError> {
    // Who asked: the author of the run's trigger message, a live human (the avatar flow's rule).
    let Some((requester, channel_id)) =
        requester_of_run_in_tx(conn, workspace_id, run_id, agent_member_id).await?
    else {
        return Ok(None);
    };
    if !is_channel_member(conn, channel_id, agent_member_id).await?
        || !is_channel_member(conn, channel_id, requester).await?
    {
        return Ok(None);
    }
    // The picture: the first complete image of the trigger message itself. No id comes from outside.
    let attachment_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT a.id FROM attachment a \
           JOIN agent_run r ON r.workspace_id = a.workspace_id AND r.trigger_message_id = a.message_id \
          WHERE r.workspace_id = $1 AND r.id = $2 AND a.status = 'complete' \
            AND a.mime IN ('image/png', 'image/jpeg', 'image/webp') \
          ORDER BY a.created_at ASC, a.id ASC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(attachment_id) = attachment_id else {
        return Ok(None);
    };
    // The one ownership rule every requester-attachment read follows: complete, an image, within the
    // size ceiling, on a live message the requester wrote, in this conversation.
    if find_requester_attachment_in_tx(
        conn,
        workspace_id,
        requester,
        channel_id,
        attachment_id,
        SELF_MEDIA_MAX_BYTES,
    )
    .await?
    .is_none()
    {
        return Ok(None);
    }
    let Some(token) = new_token() else {
        return Ok(None);
    };
    sqlx::query(
        "DELETE FROM self_media_token \
          WHERE workspace_id = $1 AND expires_at < clock_timestamp() - make_interval(secs => $2)",
    )
    .bind(workspace_id)
    .bind(CLEANUP_AFTER_SECS)
    .execute(&mut *conn)
    .await?;
    let expires_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO self_media_token \
            (workspace_id, token_hash, run_id, agent_member_id, requester_member_id, channel_id, \
             attachment_id, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), \
                 clock_timestamp() + make_interval(secs => $8)) \
         RETURNING expires_at",
    )
    .bind(workspace_id)
    .bind(token_hash(&token).to_vec())
    .bind(run_id)
    .bind(agent_member_id)
    .bind(requester)
    .bind(channel_id)
    .bind(attachment_id)
    .bind(ttl_secs as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Some(SelfMediaGrant { token, expires_at }))
}

/// Spend a token and name the file it was minted for. `None` is every refusal alike.
///
/// The spend is one statement, so two requests with the same token can never both win. It commits
/// even when a later rule refuses (the token is gone either way). The binding is proved again here:
/// the requester must still be in the conversation, the agent too, and the file must still be a
/// complete image on a live message the requester wrote ([`find_requester_attachment_in_tx`]).
pub async fn redeem_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token: &str,
) -> Result<Option<SelfMediaSource>, DbError> {
    if !token_is_well_formed(token) {
        return Ok(None);
    }
    let bound: Option<(Uuid, Uuid, Uuid, Uuid)> = sqlx::query_as(
        "UPDATE self_media_token t SET used_at = clock_timestamp() \
          WHERE t.workspace_id = $1 AND t.token_hash = $2 \
            AND t.used_at IS NULL AND t.expires_at > clock_timestamp() \
            AND EXISTS (SELECT 1 FROM agent_run r \
                         WHERE r.workspace_id = t.workspace_id AND r.id = t.run_id \
                           AND r.agent_member_id = t.agent_member_id \
                           AND r.status IN ('queued', 'running')) \
          RETURNING t.requester_member_id, t.channel_id, t.attachment_id, t.agent_member_id",
    )
    .bind(workspace_id)
    .bind(token_hash(token).to_vec())
    .fetch_optional(&mut *conn)
    .await?;
    let Some((requester, channel_id, attachment_id, agent_member_id)) = bound else {
        return Ok(None);
    };
    if !is_channel_member(conn, channel_id, agent_member_id).await?
        || !is_channel_member(conn, channel_id, requester).await?
    {
        return Ok(None);
    }
    let Some(source) = find_requester_attachment_in_tx(
        conn,
        workspace_id,
        requester,
        channel_id,
        attachment_id,
        SELF_MEDIA_MAX_BYTES,
    )
    .await?
    else {
        return Ok(None);
    };
    let mime: Option<String> =
        sqlx::query_scalar("SELECT mime FROM attachment WHERE workspace_id = $1 AND id = $2")
            .bind(workspace_id)
            .bind(attachment_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some(mime) = mime else {
        return Ok(None);
    };
    Ok(Some(SelfMediaSource {
        drive_file_id: source.drive_file_id,
        size_bytes: source.size_bytes,
        mime,
    }))
}

/// Scrub every `…self-media/{workspace}/{token}` from a string that is about to be logged, stored
/// (`outbox.last_error`, `agent_run.error`) or shown: the token part becomes `<redacted>`, the rest
/// of the string is untouched. A provider may echo the address inside an error body; the scrub
/// also understands the JSON-escaped (`\/`) and percent-encoded (`%2F`) separators.
pub fn redact_self_media_urls(text: &str) -> String {
    const MARK: &str = "self-media";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(MARK) {
        let after_mark = at + MARK.len();
        out.push_str(&rest[..after_mark]);
        rest = &rest[after_mark..];
        let Some(workspace_at) = skip_separator(rest) else {
            continue;
        };
        let workspace_len = rest[workspace_at..]
            .bytes()
            .take_while(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
            .count();
        if workspace_len == 0 {
            continue;
        }
        let after_workspace = workspace_at + workspace_len;
        let Some(token_offset) = skip_separator(&rest[after_workspace..]) else {
            continue;
        };
        let token_at = after_workspace + token_offset;
        let token_len = rest[token_at..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
            .count();
        if token_len == 0 {
            continue;
        }
        out.push_str(&rest[..token_at]);
        out.push_str("<redacted>");
        rest = &rest[token_at + token_len..];
    }
    out.push_str(rest);
    out
}

/// The length of one path separator at the start of `text` — `/`, JSON's `\/`, or `%2F` — or `None`.
fn skip_separator(text: &str) -> Option<usize> {
    if text.starts_with('/') {
        Some(1)
    } else if text.starts_with("\\/") {
        Some(2)
    } else if text.len() >= 3 && text.is_char_boundary(3) && text[..3].eq_ignore_ascii_case("%2f") {
        Some(3)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        origin: OriginVectors,
    }
    #[derive(serde::Deserialize)]
    struct OriginVectors {
        accept: Vec<String>,
        reject: Vec<String>,
    }

    fn vectors() -> Vectors {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/hermes/self_media_vectors.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("shared vector file"))
            .expect("vector file parses")
    }

    /// The Rust half of the origin grammar agrees with the shared list the Python half (the lock
    /// gate and the plugin) is held to: a worker must never emit an address the guard would refuse,
    /// and must never accept an origin the gate would refuse to start with.
    #[test]
    fn the_origin_grammar_matches_the_shared_vectors() {
        let vectors = vectors();
        assert!(vectors.origin.accept.len() >= 4);
        assert!(vectors.origin.reject.len() >= 25);
        for good in &vectors.origin.accept {
            assert_eq!(canonical_origin(good), Some(good.as_str()), "{good:?}");
        }
        for bad in &vectors.origin.reject {
            assert_eq!(canonical_origin(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_token_is_43_url_safe_characters_and_nothing_else() {
        let token = new_token().expect("entropy");
        assert_eq!(token.len(), SELF_MEDIA_TOKEN_CHARS);
        assert!(token_is_well_formed(&token));
        assert_ne!(token, new_token().unwrap(), "two mints never repeat");
        for bad in [
            "",
            "short",
            &"A".repeat(42),
            &"A".repeat(44),
            &format!("{}=", "A".repeat(42)),
            &format!("{}/", "A".repeat(42)),
            &format!("{}.", "A".repeat(42)),
            &format!("{}%", "A".repeat(42)),
            &format!("{}\n", "A".repeat(42)),
            &format!("{}é", "A".repeat(41)),
        ] {
            assert!(!token_is_well_formed(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_address_is_origin_prefix_workspace_token() {
        let ws = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        let token = "A".repeat(43);
        assert_eq!(
            self_media_url("https://oort.example.com", ws, &token),
            format!("https://oort.example.com/v1/self-media/{ws}/{token}")
        );
    }

    #[test]
    fn the_hash_is_of_the_text_and_is_32_bytes() {
        let digest = token_hash("abc");
        assert_eq!(digest.len(), 32);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_scrub_replaces_only_the_token_in_every_spelling() {
        let uuid = "01234567-89ab-cdef-0123-456789abcdef";
        let token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
        let plain = format!("GET https://oort.example.com/v1/self-media/{uuid}/{token} failed");
        let cleaned = redact_self_media_urls(&plain);
        assert!(!cleaned.contains(token), "{cleaned}");
        assert!(cleaned.contains(&format!("/v1/self-media/{uuid}/<redacted> failed")));
        let escaped = format!(
            "{{\"url\":\"https:\\/\\/o.example.com\\/v1\\/self-media\\/{uuid}\\/{token}\"}}"
        );
        assert!(!redact_self_media_urls(&escaped).contains(token));
        let encoded = format!("https://o.example.com/v1/self-media%2F{uuid}%2f{token}?x=1");
        let cleaned = redact_self_media_urls(&encoded);
        assert!(!cleaned.contains(token), "{cleaned}");
        assert!(cleaned.ends_with("<redacted>?x=1"), "{cleaned}");
        // twice in one string, and text without the mark is returned as it was
        let twice = format!("{plain} / {plain}");
        assert!(!redact_self_media_urls(&twice).contains(token));
        assert_eq!(redact_self_media_urls("nothing to see"), "nothing to see");
        assert_eq!(
            redact_self_media_urls("self-media is a word"),
            "self-media is a word"
        );
    }

    #[test]
    fn the_sniff_checks_the_declared_image_type() {
        assert!(bytes_match_mime("image/png", b"\x89PNG\r\n\x1a\nxxxx"));
        assert!(bytes_match_mime("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0, 0]));
        assert!(bytes_match_mime("image/webp", b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!bytes_match_mime("image/png", b"<html>"));
        assert!(!bytes_match_mime("image/jpeg", b"\x89PNG\r\n\x1a\n"));
        assert!(!bytes_match_mime("image/webp", b"RIFF\0\0\0\0WAVE"));
        assert!(!bytes_match_mime("image/gif", b"GIF89a"));
        assert!(!bytes_match_mime("text/html", b"<html>"));
    }
}
