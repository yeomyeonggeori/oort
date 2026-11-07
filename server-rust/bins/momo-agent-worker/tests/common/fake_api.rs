//! A fake **api** for the picture's upload (ADR-0201 증보 v4 P6, #5372 = P14-S4): a real HTTP/1.1 server on
//! a loopback port that answers `PUT /v1/agent-media/{workspace}/{token}` the way the api's route does —
//! with the **same functions** the route calls, not a stub of them — so what the worker's `PictureWriter`
//! really does is measured end to end against a real database:
//!
//! * [`ApiBehavior::Store`] spends the single-use token (`redeem_agent_picture_in_tx`, as the non-bypass
//!   `momo_app` role, tenant-scoped), then writes the `complete` attachment row (`write_picture_in_tx`,
//!   asked a third time whether the run may still write) and answers `201` with the three fields. What it
//!   does **not** do is the route's decoder child and archive: the bytes that came in are recorded as they
//!   are (the route's own refusals — a decode bomb, a slot that stays busy, a pixel ceiling — are proved by
//!   `momo-server`'s `agent_picture_conformance_pg` against the real decoder; here they are the statuses
//!   [`ApiBehavior::Status`] answers).
//! * [`ApiBehavior::Status`] answers any status with an empty JSON body.
//! * [`ApiBehavior::StatusFreeSlot`] does the same **and gives the run's token slot back** (the token rows
//!   are deleted before the answer goes out): a second `mint` would then succeed, so a worker that retried
//!   would reach this server twice — the count of connections measures the worker's own "one write, no
//!   retry", not the table's one-slot-per-run rule that would stop a retry anyway.
//!
//! It counts the connections that reach it and keeps what it was sent (head, path, body bytes), the status
//! of every run of the workspace **at the moment the request arrived** (the state the writer's token is
//! judged by) and the seconds the task row's claim still had to live.

// a test file takes the parts of this server it needs; the others are another file's
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use momo_db::with_tenant_tx;
use momo_messaging::{
    picture_name, redeem_agent_picture_in_tx, write_picture_in_tx, PictureWriteRefused,
    StoredPicture, AGENT_MEDIA_PATH_PREFIX, AGENT_PICTURES_DAILY_CEILING,
};
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// What happens right after the picture's row is written (to arrange a state the finishing transaction
/// meets afterwards).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AfterStore {
    Nothing,
    /// The attachment is found already bound to another message (the run's trigger): binding it to the answer
    /// is then refused (`AlreadyLinked`) — a stand-in for any reason the finishing transaction's binding is
    /// refused after the row was written.
    LinkedElsewhere,
}

#[derive(Clone, Debug)]
pub enum ApiBehavior {
    Store { after: AfterStore },
    Status(u16),
    StatusFreeSlot(u16),
}

/// One `PUT` the fake received.
#[derive(Clone, Debug)]
pub struct SeenPut {
    /// Request line and headers, lower-cased.
    pub head: String,
    /// The request path (`/v1/agent-media/{workspace}/{token}`).
    pub path: String,
    pub body: Vec<u8>,
    /// `agent_run.status` of every run of the workspace when the request arrived, joined by `,`.
    pub run_statuses: String,
    /// Seconds the (single) active task row's claim still had to live when the request arrived.
    pub claim_secs_left: Option<f64>,
}

pub struct FakeApi {
    pub addr: SocketAddr,
    connections: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<SeenPut>>>,
    task: JoinHandle<()>,
}

impl Drop for FakeApi {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeApi {
    /// Bind a loopback port and serve `behavior`. `su` measures the database; `app` is the api's own role
    /// (`momo_app`), the one that spends tokens and writes rows.
    pub async fn start(
        su: PgPool,
        app: PgPool,
        workspace_id: Uuid,
        behavior: ApiBehavior,
    ) -> FakeApi {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port for the fake api");
        let addr = listener.local_addr().expect("local addr");
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let task = {
            let connections = connections.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (behavior, seen) = (behavior.clone(), seen.clone());
                    let (su, app) = (su.clone(), app.clone());
                    tokio::spawn(async move {
                        let Some((head, path, body)) = read_request(&mut socket).await else {
                            return;
                        };
                        let run_statuses: String = sqlx::query_scalar(
                            "SELECT COALESCE(string_agg(status::text, ',' ORDER BY created_at), '') \
                               FROM agent_run WHERE workspace_id = $1",
                        )
                        .bind(workspace_id)
                        .fetch_one(&su)
                        .await
                        .unwrap_or_default();
                        let claim_secs_left: Option<f64> = sqlx::query_scalar(
                            "SELECT extract(epoch FROM (claim_until - clock_timestamp()))::float8 \
                               FROM team_ai_task \
                              WHERE workspace_id = $1 AND state = 'active' AND claim_until IS NOT NULL \
                              LIMIT 1",
                        )
                        .bind(workspace_id)
                        .fetch_optional(&su)
                        .await
                        .ok()
                        .flatten()
                        .flatten();
                        seen.lock().unwrap().push(SeenPut {
                            head,
                            path: path.clone(),
                            body: body.clone(),
                            run_statuses,
                            claim_secs_left,
                        });
                        match behavior {
                            ApiBehavior::Status(code) => respond(&mut socket, code, "{}").await,
                            ApiBehavior::StatusFreeSlot(code) => {
                                sqlx::query(
                                    "DELETE FROM attachment_write_token WHERE workspace_id = $1",
                                )
                                .bind(workspace_id)
                                .execute(&su)
                                .await
                                .expect("the slot is given back");
                                respond(&mut socket, code, "{}").await
                            }
                            ApiBehavior::Store { after } => {
                                let (code, text) =
                                    store(&su, &app, workspace_id, after, &path, &body).await;
                                respond(&mut socket, code, &text).await;
                            }
                        }
                    });
                }
            })
        };
        FakeApi {
            addr,
            connections,
            seen,
            task,
        }
    }

    /// `http://127.0.0.1:<port>` — what `OORT_API_INTERNAL_ORIGIN` is set to.
    pub fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// How many TCP connections have reached the server.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// What it was sent, in order.
    pub fn seen(&self) -> Vec<SeenPut> {
        self.seen.lock().unwrap().clone()
    }
}

/// A loopback origin nothing listens on: the connection is refused.
pub async fn dead_origin() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    let addr = listener.local_addr().expect("local addr");
    drop(listener);
    format!("http://{addr}")
}

/// What the route does with a valid picture: spend the token, write the row, answer with the three fields —
/// the refusals are the route's own statuses (404 for every token refusal, 409 run over, 429 daily ceiling).
async fn store(
    su: &PgPool,
    app: &PgPool,
    workspace_id: Uuid,
    after: AfterStore,
    path: &str,
    body: &[u8],
) -> (u16, String) {
    let prefix = format!("{AGENT_MEDIA_PATH_PREFIX}{workspace_id}/");
    let Some(token) = path.strip_prefix(&prefix).map(str::to_string) else {
        return (404, "{}".to_string());
    };
    let redeemed = with_tenant_tx(app, workspace_id, {
        let token = token.clone();
        move |conn| {
            let token = token.clone();
            Box::pin(async move { redeem_agent_picture_in_tx(conn, workspace_id, &token).await })
        }
    })
    .await;
    let Ok(Some(target)) = redeemed else {
        return (404, "{}".to_string());
    };
    let size = body.len() as i64;
    let stored = StoredPicture {
        drive_file_id: format!("fake-drive-{}", Uuid::new_v4()),
        name: picture_name(target.slot, "image/png"),
        mime: "image/png".to_string(),
        size_bytes: size,
        mime_in: "image/png",
        bytes_in: size,
        decode_ms: 0,
        backend: "stub",
    };
    let written = with_tenant_tx(app, workspace_id, move |conn| {
        let stored = stored.clone();
        Box::pin(async move {
            write_picture_in_tx(
                conn,
                workspace_id,
                &target,
                &stored,
                AGENT_PICTURES_DAILY_CEILING,
            )
            .await
        })
    })
    .await;
    let mut stored_id: Option<Uuid> = None;
    let (code, text) = match written {
        Ok(Ok(attachment_id)) => {
            stored_id = Some(attachment_id);
            (
                201,
                serde_json::json!({
                    "attachmentId": attachment_id.to_string(),
                    "mime": "image/png",
                    "sizeBytes": size,
                })
                .to_string(),
            )
        }
        Ok(Err(PictureWriteRefused::RunOver)) => (409, "{}".to_string()),
        Ok(Err(PictureWriteRefused::CapReached)) => (429, "{}".to_string()),
        Err(_) => (500, "{}".to_string()),
    };
    if let (Some(attachment_id), AfterStore::LinkedElsewhere) = (stored_id, after) {
        // bind it to the run's trigger message, the way another path could have
        sqlx::query(
            "UPDATE attachment SET message_id = \
                (SELECT r.trigger_message_id FROM agent_run r \
                  WHERE r.workspace_id = $1 AND r.id = $3) \
              WHERE workspace_id = $1 AND id = $2",
        )
        .bind(workspace_id)
        .bind(attachment_id)
        .bind(target.run_id)
        .execute(su)
        .await
        .expect("the attachment is found bound elsewhere");
    }
    (code, text)
}

/// Read one HTTP/1.1 request: the head up to the blank line, then `content-length` bytes of body.
async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let head_end = loop {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        if buffer.len() > 1 << 20 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_lowercase();
    // the path keeps its case (the token is case-sensitive): read it from the original bytes
    let request_line = String::from_utf8_lossy(&buffer[..head_end])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let mut body: Vec<u8> = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some((head, path, body))
}

async fn respond(socket: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status == 201 { "Created" } else { "Status" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}
