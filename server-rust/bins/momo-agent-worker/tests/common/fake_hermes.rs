//! A fake Hermes for the delegation tests (ADR-0201 증보 v4, #5370): a real HTTP/1.1 server on a loopback
//! port that speaks just enough of `POST /v1/chat/completions` to be called by the worker's real
//! chat/completions adapter — and that **counts the connections that reach it and keeps what it was sent**.
//!
//! It exists because a count of connections to a bare listener is worth something only if the worker's
//! egress policy lets the call through: with the loopback shut a call that *was* made also leaves the count at
//! zero, so a "0 connections" assertion was green for the wrong reason (#5369 handoff, h8). Every test that
//! says "one request reached Hermes" uses this server behind the **real guarded provider with the loopback
//! allowed**, and the one test that says "none did" shows the same server reached under the same setup by the
//! allowed case, so the zero is a measurement and not an absence.
//!
//! What it records for each request: the header block (lower-cased), the body, the status of every run in
//! the workspace **at the moment the request arrived** (the run-state measurement two sibling slots wait
//! for), and the seconds the task row's claim still had to live.

// a test file takes the parts of this server it needs; the others are another file's
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// What the fake does with a request.
#[derive(Clone, Debug)]
pub enum Behavior {
    /// `200` with this assistant text and, when given, the `usage` Hermes reports.
    Answer {
        text: String,
        usage: Option<(i32, i32)>,
    },
    /// Wait, then do the inner behaviour.
    Delay(Duration, Box<Behavior>),
    /// This HTTP status with an empty JSON error body.
    Status(u16),
    /// Never answer.
    Hang,
}

/// One request the fake received.
#[derive(Clone, Debug)]
pub struct Seen {
    /// Request line and headers, lower-cased.
    pub head: String,
    pub body: String,
    /// `agent_run.status` of every run of the workspace when the request arrived, in `created_at` order,
    /// joined by `,`.
    pub run_statuses: String,
    /// Seconds the (single) active task row's claim still had to live when the request arrived.
    pub claim_secs_left: Option<f64>,
}

pub struct FakeHermes {
    pub addr: SocketAddr,
    connections: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: JoinHandle<()>,
}

impl Drop for FakeHermes {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeHermes {
    /// Bind a loopback port and serve `behavior`. `su` and `workspace_id` are how each request measures the
    /// database at the instant it arrives.
    pub async fn start(su: PgPool, workspace_id: Uuid, behavior: Behavior) -> FakeHermes {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port for the fake Hermes");
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
                    let behavior = behavior.clone();
                    let seen = seen.clone();
                    let su = su.clone();
                    tokio::spawn(async move {
                        let Some((head, body)) = read_request(&mut socket).await else {
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
                        seen.lock().unwrap().push(Seen {
                            head,
                            body,
                            run_statuses,
                            claim_secs_left,
                        });
                        respond(&mut socket, behavior).await;
                    });
                }
            })
        };
        FakeHermes {
            addr,
            connections,
            seen,
            task,
        }
    }

    /// `http://127.0.0.1:<port>/v1` — what `HERMES_BASE_URL` is set to.
    pub fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    /// How many TCP connections have reached the server.
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// What it was sent, in order.
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Wait until `n` connections have arrived (or `within` passes). Returns whether they did.
    pub async fn wait_for_connections(&self, n: usize, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while tokio::time::Instant::now() < deadline {
            if self.connections() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.connections() >= n
    }
}

/// Read one HTTP/1.1 request: the head up to the blank line, then `content-length` bytes of body.
async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<(String, String)> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
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
    Some((head, String::from_utf8_lossy(&body).into_owned()))
}

async fn respond(socket: &mut tokio::net::TcpStream, behavior: Behavior) {
    let mut behavior = behavior;
    loop {
        match behavior {
            Behavior::Delay(wait, inner) => {
                tokio::time::sleep(wait).await;
                behavior = *inner;
            }
            Behavior::Hang => {
                tokio::time::sleep(Duration::from_secs(3600)).await;
                return;
            }
            Behavior::Status(code) => {
                write(socket, code, "{\"error\":{\"message\":\"nope\"}}").await;
                return;
            }
            Behavior::Answer { text, usage } => {
                let mut body = serde_json::json!({
                    "choices": [{"message": {"role": "assistant", "content": text}}],
                });
                if let Some((prompt, completion)) = usage {
                    body["usage"] = serde_json::json!({
                        "prompt_tokens": prompt,
                        "completion_tokens": completion,
                    });
                }
                write(socket, 200, &body.to_string()).await;
                return;
            }
        }
    }
}

async fn write(socket: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "ERR" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}
