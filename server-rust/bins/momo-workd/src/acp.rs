//! ACP client transport (ADR-0130 D1): JSON-RPC 2.0, one JSON object per line,
//! over an agent adapter's stdin/stdout.
//!
//! This module is transport only. It starts the child exactly as a
//! [`LaunchSpec`] says (the spec is built by [`crate::policy::launch_spec`] from
//! the host allowlist), correlates responses to requests, and hands every
//! agent→client message — `session/update` notifications and requests such as
//! `session/request_permission` — to the session task, which decides.
//!
//! Three properties the rest of the host relies on:
//! * **stderr is drained and dropped.** It may carry terminal output or
//!   credentials, and nothing here forwards it anywhere (ADR-0125 D10).
//! * **A line over [`MAX_LINE_BYTES`] ends the connection.** An agent cannot make
//!   the host buffer without bound.
//! * **The child runs in its own process group**, so terminating a session also
//!   terminates whatever the adapter spawned (`claude`, `codex`, their tools).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

/// Longest JSON-RPC line accepted from an agent.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// JSON-RPC "method not found".
pub const METHOD_NOT_FOUND: i64 = -32601;

/// How to start one agent adapter. Built only by `policy::launch_spec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The complete child environment (the parent's is cleared first).
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RpcFailure {
    #[error("agent answered error {code}: {message}")]
    Error { code: i64, message: String },
    #[error("agent transport closed")]
    TransportClosed,
    #[error("agent did not answer in time")]
    Timeout,
}

pub type RpcResult = Result<Value, RpcFailure>;

/// An agent→client message the session task must handle.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<RpcResult>>>>;

pub struct AcpConnection {
    child: Child,
    pid: Option<u32>,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next_id: AtomicI64,
    incoming: mpsc::Receiver<Incoming>,
}

impl AcpConnection {
    pub fn spawn(spec: &LaunchSpec) -> std::io::Result<Self> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(
                spec.env
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn()?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = outbound_rx.recv().await {
                if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            // Dropping stdin closes the agent's input: its cue to exit.
        });

        tokio::spawn(async move {
            let mut stderr = stderr;
            let mut sink = tokio::io::sink();
            let _ = tokio::io::copy(&mut stderr, &mut sink).await;
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (incoming_tx, incoming) = mpsc::channel(256);
        tokio::spawn(read_loop(stdout, pending.clone(), incoming_tx));

        Ok(Self {
            child,
            pid,
            outbound,
            pending,
            next_id: AtomicI64::new(1),
            incoming,
        })
    }

    fn write(&self, message: &Value) -> Result<(), RpcFailure> {
        let mut line = serde_json::to_vec(message).expect("JSON-RPC message serialises");
        line.push(b'\n');
        self.outbound
            .send(line)
            .map_err(|_| RpcFailure::TransportClosed)
    }

    /// Send a request and return the receiver for its answer.
    pub fn start_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<RpcResult>, RpcFailure> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map lock")
            .insert(id, sender);
        let sent = self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        if let Err(failure) = sent {
            self.pending.lock().expect("pending map lock").remove(&id);
            return Err(failure);
        }
        Ok(receiver)
    }

    /// Request and wait, bounded by `timeout`.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        let receiver = self.start_request(method, params)?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcFailure::TransportClosed),
            Err(_) => Err(RpcFailure::Timeout),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), RpcFailure> {
        self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), RpcFailure> {
        self.write(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcFailure> {
        self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": code, "message": message},
        }))
    }

    /// Next agent→client message; `None` once the agent's stdout closed.
    pub async fn next_incoming(&mut self) -> Option<Incoming> {
        self.incoming.recv().await
    }

    /// An agent→client message that is already queued, without waiting.
    ///
    /// The reader queues every message **before** it resolves a later
    /// response, so once a response has arrived, everything the agent wrote
    /// ahead of it is available here.
    pub fn try_next_incoming(&mut self) -> Option<Incoming> {
        self.incoming.try_recv().ok()
    }

    /// Stop the agent: close its stdin, then SIGTERM its process group, then
    /// SIGKILL if it is still there. Returns a shell-style exit code
    /// (`128 + signal` for a signal death).
    pub async fn terminate(&mut self, grace: Duration) -> i32 {
        if let Ok(Some(status)) = self.child.try_wait() {
            return exit_code(status);
        }
        self.signal_group(libc::SIGTERM);
        if let Ok(Ok(status)) = tokio::time::timeout(grace, self.child.wait()).await {
            return exit_code(status);
        }
        self.signal_group(libc::SIGKILL);
        match self.child.wait().await {
            Ok(status) => exit_code(status),
            Err(_) => 128 + libc::SIGKILL,
        }
    }

    /// Wait for a child that is exiting on its own (stdout already closed).
    pub async fn wait_exit(&mut self, grace: Duration) -> i32 {
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => exit_code(status),
            _ => self.terminate(grace).await,
        }
    }

    fn signal_group(&self, signal: i32) {
        if let Some(pid) = self.pid {
            // SAFETY: plain syscall; a stale pgid only yields ESRCH.
            unsafe {
                libc::killpg(pid as libc::pid_t, signal);
            }
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt as _;
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(-1)
}

async fn read_line_bounded<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    buffer: &mut Vec<u8>,
) -> std::io::Result<Option<()>> {
    buffer.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if buffer.is_empty() { None } else { Some(()) });
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            buffer.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return Ok(Some(()));
        }
        let length = available.len();
        buffer.extend_from_slice(available);
        reader.consume(length);
        if buffer.len() > MAX_LINE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ACP line exceeds the host limit",
            ));
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    stdout: R,
    pending: Pending,
    incoming: mpsc::Sender<Incoming>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        match read_line_bounded(&mut reader, &mut buffer).await {
            Ok(Some(())) => {}
            Ok(None) | Err(_) => break,
        }
        if buffer.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&buffer) else {
            // Not JSON-RPC: this is not an agent we can talk to safely.
            break;
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned().filter(|id| !id.is_null());
        match (method, id) {
            (Some(method), Some(id)) => {
                let request = Incoming::Request {
                    id,
                    method: method.to_string(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                };
                if incoming.send(request).await.is_err() {
                    break;
                }
            }
            (Some(method), None) => {
                let notification = Incoming::Notification {
                    method: method.to_string(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                };
                if incoming.send(notification).await.is_err() {
                    break;
                }
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { continue };
                let Some(sender) = pending.lock().expect("pending map lock").remove(&id) else {
                    continue;
                };
                let result = match message.get("error") {
                    Some(error) => Err(RpcFailure::Error {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .chars()
                            .take(200)
                            .collect(),
                    }),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(result);
            }
            (None, None) => {}
        }
    }
    // Transport gone: fail every request still waiting, then let the session
    // task observe `None` from `next_incoming`.
    let waiting: Vec<_> = pending
        .lock()
        .expect("pending map lock")
        .drain()
        .map(|(_, sender)| sender)
        .collect();
    for sender in waiting {
        let _ = sender.send(Err(RpcFailure::TransportClosed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_oversized_line_is_an_error_not_an_allocation() {
        let big = vec![b'x'; MAX_LINE_BYTES + 10];
        let mut reader = BufReader::new(&big[..]);
        let mut buffer = Vec::new();
        assert!(read_line_bounded(&mut reader, &mut buffer).await.is_err());
    }

    #[tokio::test]
    async fn lines_are_split_on_newlines_and_eof_ends_cleanly() {
        let data = b"{\"a\":1}\n{\"b\":2}";
        let mut reader = BufReader::new(&data[..]);
        let mut buffer = Vec::new();
        assert!(read_line_bounded(&mut reader, &mut buffer)
            .await
            .unwrap()
            .is_some());
        assert_eq!(buffer, b"{\"a\":1}");
        assert!(read_line_bounded(&mut reader, &mut buffer)
            .await
            .unwrap()
            .is_some());
        assert_eq!(buffer, b"{\"b\":2}");
        assert!(read_line_bounded(&mut reader, &mut buffer)
            .await
            .unwrap()
            .is_none());
    }
}
