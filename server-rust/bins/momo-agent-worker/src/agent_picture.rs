//! #5371 — the worker's half of the picture write (ADR-0151 증보 8, the mirror of the worker's read in
//! [`crate::self_media`]).
//!
//! The picture Hermes drew is bytes in this process, and on Railway this process cannot write to the
//! api's archive. [`PictureWriter::write`] therefore does exactly three things:
//!
//! 1. **refuses what the api would refuse, before it spends anything** — more than 5 MiB, bytes that
//!    do not start like a png, jpeg or webp, nothing at all. The api asks again (it does not trust
//!    this process); this only saves a token and a round trip;
//! 2. **mints one write token** in a tenant transaction (`momo_messaging::mint_agent_picture_in_tx`:
//!    the run must be in flight with this agent, its requester a live human, both in a channel that is
//!    not archived, and the run's picture slot free) and commits it **before** any network call;
//! 3. **spends it itself, once**, with one `PUT` to the api's private address, and reads the three
//!    fields the api answers.
//!
//! What it never does: put the token or the address into a log line, a message, an audit row, an error
//! or a model's context (the only things it logs are the run id and a fixed word); follow a redirect or
//! a proxy; retry (a failed write is the caller's failure sentence, not a second token); fall back to
//! writing the archive itself (unlike the read, there is no archive here to fall back to); or decide
//! whether a picture is wanted — that is the caller's gate (ADR-0201 G1~G10). Its **one caller** is the
//! delegation of a picture to Hermes (S4, #5372: `team_ai/delegate.rs` writes, `team_ai.rs`'s finishing
//! transaction posts); the conversation that asks for one (#5334) brings its own, in its own PR, and
//! `tests/agent_picture_static_guards.rs` turns red until it adds its row.
//!
//! **Where a caller puts the write** (ADR-0151 증보 8 W9, review L3): *after* the model call that combines
//! the answer and right before the transaction that posts it. A person who stops the run while the
//! combining call is still going finds no row yet — and the row-write's own check (the run is still in
//! flight) refuses it if the stop lands later — whereas a picture written *before* that call and never
//! bound would sit unbound (readable by nobody, swept by the 30-day sweep only when it is switched
//! on). The picture must come out of the image tool's own output (the one `data:image/…` address Hermes
//! turns a `MEDIA:` line into), never out of free text a web search brought in (review I3); both are the
//! caller's (S4, #5372: `momo_workspace_actions::team_ai_hermes_exec::picture_of`).
//!
//! [`send_answer_with_run_pictures_in_tx`] is the other half of the caller's job: the one transaction
//! that posts the run's final answer **with** the pictures this run wrote, and — if the binding is
//! refused for any reason — posts the same answer **without** them and says so in one fixed sentence,
//! never silently and never twice.

use std::time::Duration;

use momo_db::{sqlx, with_tenant_tx, PgConnection, PgPool};
use momo_messaging::{
    bytes_match_mime, mint_agent_picture_in_tx, send_thread_notice_in_tx,
    send_thread_notice_with_run_pictures_in_tx, NewMessage, SentMessage, AGENT_MEDIA_PATH_PREFIX,
    AGENT_PICTURE_MAX_INPUT_BYTES,
};
use uuid::Uuid;

use crate::self_media::internal_origin;

/// The longest the whole write may take: the api's own worst case is about 33 s (read 10 + line 3 +
/// decode 10 + archive 10, ADR-0151 증보 8 W7), and a worker that gave up first would learn nothing.
pub const WRITE_DEADLINE: Duration = Duration::from_secs(40);
/// How long dialling the api may take.
const CONNECT_DEADLINE: Duration = Duration::from_secs(3);

/// What the person is told when a picture was made and could not be posted (ADR-0201 P9
/// `picture_failed`). One sentence for every cause: the cause is the audit line's closed word.
pub const PICTURE_UPLOAD_FAILED_SENTENCE: &str = "그림은 만들어졌지만 올리지 못했어요.";

/// Why no picture was written. Every variant is a fixed word or a number, **never anything a transport
/// or a server said**, so nothing it holds can carry the token, the workspace or the api's private
/// origin (and deriving `Debug` is as safe as `Display`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureRefusal {
    /// Not a png, jpeg or webp, or nothing at all. Nothing was minted.
    NotAPicture,
    /// More than 5 MiB. Nothing was minted.
    TooLarge,
    /// No token: the run is over, someone left, the channel is archived or the run's picture slot is
    /// already used. Nothing was written.
    NoToken,
    /// The request or the api failed, with the fixed word that says how. The token is spent.
    Failed(&'static str),
}

/// What [`send_answer_with_run_pictures_in_tx`] posted.
#[derive(Debug, Clone)]
pub struct PostedAnswer {
    pub sent: SentMessage,
    /// `false`: binding the run's pictures was refused and the answer went **without** them, with
    /// [`PICTURE_UPLOAD_FAILED_SENTENCE`] appended (one message, never two).
    pub pictures_bound: bool,
}

/// A picture the api stored and recorded as an attachment of this run's agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenPicture {
    pub attachment_id: Uuid,
    pub mime: String,
    pub size_bytes: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    attachment_id: String,
    mime: String,
    size_bytes: i64,
}

/// The one client the write is made with: **no redirect** (a 3xx is an answer, not a place to go), **no
/// proxy**, a connect limit and a total limit. `None` only if the TLS backend cannot start.
fn write_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_DEADLINE)
        .timeout(WRITE_DEADLINE)
        .build()
        .ok()
}

/// The kind of a failed request as a fixed word. reqwest's own text carries the request URL — the
/// api's private origin, the workspace id and the token — so none of it is kept, scrubbed or not.
fn kind_of(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() || error.is_decode() {
        "body"
    } else {
        "request"
    }
}

/// The closed word for the status the api answered with (its body is never read as text).
fn word_for_status(status: u16) -> &'static str {
    match status {
        400 => "length_mismatch",
        404 => "refused",
        409 => "run_over",
        411 | 413 => "too_large",
        422 => "unsupported_or_invalid",
        429 => "cap_reached",
        502 => "storage_failed",
        503 => "busy",
        504 => "timeout",
        _ => "status",
    }
}

/// What a picture's first bytes say it is — the same three types the api accepts, and nothing else.
fn is_a_picture_the_api_takes(bytes: &[u8]) -> bool {
    ["image/png", "image/jpeg", "image/webp"]
        .iter()
        .any(|mime| bytes_match_mime(mime, bytes))
}

/// The worker's writer: the api's private origin and the one client that dials it.
pub struct PictureWriter {
    origin: String,
    client: reqwest::Client,
}

impl PictureWriter {
    /// `None` — the write path is closed — when `origin` is missing, is not a well-formed private
    /// origin ([`internal_origin`]) or the client cannot be built. There is no archive to fall back to.
    pub fn new(origin: Option<&str>) -> Option<Self> {
        let origin = internal_origin(origin?)?.to_string();
        Some(PictureWriter {
            origin,
            client: write_client()?,
        })
    }

    /// Write one picture as this run's agent (ADR-0151 증보 8 W11). See the module docs for what this
    /// does and never does. `bytes` is the picture exactly as Hermes drew it; the api re-encodes it.
    pub async fn write(
        &self,
        pool: &PgPool,
        workspace_id: Uuid,
        run_id: Uuid,
        agent_member_id: Uuid,
        bytes: Vec<u8>,
    ) -> Result<WrittenPicture, PictureRefusal> {
        // 1. What the api would refuse, before a token is spent on it.
        if bytes.is_empty() || !is_a_picture_the_api_takes(&bytes) {
            return Err(PictureRefusal::NotAPicture);
        }
        if bytes.len() > AGENT_PICTURE_MAX_INPUT_BYTES {
            return Err(PictureRefusal::TooLarge);
        }
        // 2. Mint, and commit before the network is touched (a transaction is not held open across
        //    a round trip to another service).
        let minted = with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move {
                mint_agent_picture_in_tx(conn, workspace_id, run_id, agent_member_id).await
            })
        })
        .await;
        let grant = match minted {
            Ok(Some(grant)) => grant,
            Ok(None) => return Err(PictureRefusal::NoToken),
            Err(_) => {
                // a fixed word, never the database's own text (S3 implementation review I-3, closed by S4)
                tracing::warn!(%run_id, cause = "database", "agent picture: the write token could not be minted");
                return Err(PictureRefusal::Failed("database"));
            }
        };
        // 3. Spend it, once. The address is built here and goes nowhere but this one request.
        let url = format!(
            "{}{}{}/{}",
            self.origin, AGENT_MEDIA_PATH_PREFIX, workspace_id, grant.token
        );
        let response = match self
            .client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let word = kind_of(&error);
                tracing::warn!(%run_id, cause = word, "agent picture: the write did not complete");
                return Err(PictureRefusal::Failed(word));
            }
        };
        let status = response.status().as_u16();
        if status != 201 {
            let word = word_for_status(status);
            tracing::warn!(%run_id, status, cause = word, "agent picture: the api refused the write");
            return Err(PictureRefusal::Failed(word));
        }
        let wire: Wire = match response.json().await {
            Ok(wire) => wire,
            Err(_) => {
                tracing::warn!(%run_id, cause = "shape", "agent picture: the api's answer was not the three fields");
                return Err(PictureRefusal::Failed("shape"));
            }
        };
        let Ok(attachment_id) = Uuid::parse_str(&wire.attachment_id) else {
            return Err(PictureRefusal::Failed("shape"));
        };
        Ok(WrittenPicture {
            attachment_id,
            mime: wire.mime,
            size_bytes: wire.size_bytes,
        })
    }
}

/// Post the run's **final answer with the pictures it wrote** (ADR-0151 증보 8 W9), in the caller's
/// transaction. The pictures are not named by the caller: they are the ones this run's write tokens
/// recorded (`input.run_id`), in slot order. If binding them is refused for any reason the answer is
/// posted again **without** them and with [`PICTURE_UPLOAD_FAILED_SENTENCE`] appended — a savepoint
/// takes the first attempt back, so there is never a half-bound message and never two answers. The
/// result says which of the two happened ([`PostedAnswer::pictures_bound`]) so the caller's audit line can
/// tell a delegation that delivered a picture from one that could not.
pub async fn send_answer_with_run_pictures_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: NewMessage,
) -> Result<PostedAnswer, momo_db::DbError> {
    sqlx::query("SAVEPOINT agent_picture_answer")
        .execute(&mut *conn)
        .await?;
    match send_thread_notice_with_run_pictures_in_tx(conn, workspace_id, input.clone()).await? {
        Ok(sent) => {
            sqlx::query("RELEASE SAVEPOINT agent_picture_answer")
                .execute(&mut *conn)
                .await?;
            Ok(PostedAnswer {
                sent,
                pictures_bound: true,
            })
        }
        Err(rejected) => {
            tracing::warn!(cause = %rejected, "agent picture: the pictures could not be bound; the answer goes without them");
            sqlx::query("ROLLBACK TO SAVEPOINT agent_picture_answer")
                .execute(&mut *conn)
                .await?;
            sqlx::query("RELEASE SAVEPOINT agent_picture_answer")
                .execute(&mut *conn)
                .await?;
            let mut plain = input;
            plain.body = Some(match plain.body.take() {
                Some(text) if !text.trim().is_empty() => {
                    format!("{text}\n\n{PICTURE_UPLOAD_FAILED_SENTENCE}")
                }
                _ => PICTURE_UPLOAD_FAILED_SENTENCE.to_string(),
            });
            let sent = send_thread_notice_in_tx(conn, workspace_id, plain).await?;
            Ok(PostedAnswer {
                sent,
                pictures_bound: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::AGENT_PICTURES_PER_RUN;

    /// WA17 (the half that needs no database): the writer closes without a well-formed private
    /// origin, and a picture the api would refuse never gets as far as a token.
    #[test]
    fn the_writer_is_closed_without_a_private_origin() {
        assert!(PictureWriter::new(None).is_none());
        assert!(PictureWriter::new(Some("")).is_none());
        assert!(PictureWriter::new(Some("api.railway.internal:8080")).is_none());
        assert!(PictureWriter::new(Some("http://API:8080")).is_none());
        assert!(PictureWriter::new(Some("http://api:8080/")).is_none());
        assert!(PictureWriter::new(Some("http://api.railway.internal:8080")).is_some());
    }

    #[test]
    fn only_the_three_picture_types_are_taken() {
        assert!(is_a_picture_the_api_takes(b"\x89PNG\r\n\x1a\nrest"));
        assert!(is_a_picture_the_api_takes(b"\xff\xd8\xffrest"));
        assert!(!is_a_picture_the_api_takes(b"GIF89a\x01\x00\x01\x00"));
        assert!(!is_a_picture_the_api_takes(
            b"<svg xmlns='http://www.w3.org/2000/svg'/>"
        ));
        assert!(!is_a_picture_the_api_takes(b"%PDF-1.7"));
        assert!(!is_a_picture_the_api_takes(b""));
    }

    #[test]
    fn a_status_is_a_fixed_word_and_never_a_sentence() {
        for status in [
            400u16, 404, 409, 411, 413, 422, 429, 502, 503, 504, 500, 301,
        ] {
            let word = word_for_status(status);
            assert!(!word.is_empty() && word.chars().all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }

    #[test]
    fn the_failed_sentence_is_the_one_adr_0201_p9_gave() {
        assert_eq!(
            PICTURE_UPLOAD_FAILED_SENTENCE,
            "그림은 만들어졌지만 올리지 못했어요."
        );
        assert_eq!(AGENT_PICTURES_PER_RUN, 1);
    }
}
