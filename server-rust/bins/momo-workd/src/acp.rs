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
//! * **Ending a session ends the whole tree the adapter started.** The child
//!   runs in its own process group, and because a tool can leave that group
//!   (codex runs commands after `setsid()`), the host also keeps a census of
//!   every descendant ([`crate::proctree`]) and signals each of them. SIGKILL
//!   follows SIGTERM for whatever is left, whether or not the adapter itself
//!   exited in time (#2602 L-1).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::proctree::ProcessTree;

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
    /// Set once the child has been waited for: its pid, and so its process
    /// group id, may then be reused and is never signalled again.
    reaped: bool,
    tree: ProcessTree,
    outbound: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next_id: AtomicI64,
    incoming: mpsc::Receiver<Incoming>,
    /// Messages taken off `incoming` and handed back ([`Self::unread`]).
    unread: VecDeque<Incoming>,
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
            tree: ProcessTree::new(pid.map_or(-1, |pid| pid as i32)),
            pid,
            reaped: false,
            outbound,
            pending,
            next_id: AtomicI64::new(1),
            incoming,
            unread: VecDeque::new(),
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
        if let Some(message) = self.unread.pop_front() {
            return Some(message);
        }
        self.incoming.recv().await
    }

    /// An agent→client message that is already queued, without waiting.
    ///
    /// The reader queues every message **before** it resolves a later
    /// response, so once a response has arrived, everything the agent wrote
    /// ahead of it is available here.
    pub fn try_next_incoming(&mut self) -> Option<Incoming> {
        if let Some(message) = self.unread.pop_front() {
            return Some(message);
        }
        self.incoming.try_recv().ok()
    }

    /// Hand messages back, in order, ahead of anything not yet read.
    pub fn unread(&mut self, messages: impl IntoIterator<Item = Incoming>) {
        let mut messages: Vec<Incoming> = messages.into_iter().collect();
        while let Some(message) = messages.pop() {
            self.unread.push_front(message);
        }
    }

    /// Record the agent's current process tree ([`ProcessTree::census`]). The
    /// session task calls this on every tick, so a tool that leaves the
    /// adapter's group is known before the adapter can exit and orphan it.
    pub fn observe_tree(&mut self) {
        self.tree.census();
    }

    /// Stop the agent and everything it started: close its stdin, SIGTERM
    /// its process group and every descendant the census has seen, and after
    /// `grace` SIGKILL whatever is left — also when the adapter itself exited
    /// in time, since its tools may not have. Returns a shell-style exit code
    /// (`128 + signal` for a signal death).
    pub async fn terminate(&mut self, grace: Duration) -> i32 {
        // While the adapter is alive it is the root of its tree: take the
        // census now, before an exit re-parents its children to launchd.
        self.tree.census();
        if let Some(code) = self.try_reap() {
            self.end_leftovers(grace).await;
            return code;
        }
        self.signal_group(libc::SIGTERM);
        self.tree.signal_members(libc::SIGTERM);
        let exited = match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => {
                self.reaped = true;
                Some(exit_code(status))
            }
            _ => None,
        };
        // Anything started meanwhile, from the members still alive.
        self.tree.census();
        if exited.is_none() {
            self.signal_group(libc::SIGKILL);
        }
        self.tree.signal_members(libc::SIGKILL);
        match exited {
            Some(code) => code,
            None => {
                let code = match self.child.wait().await {
                    Ok(status) => exit_code(status),
                    Err(_) => 128 + libc::SIGKILL,
                };
                self.reaped = true;
                code
            }
        }
    }

    /// Wait for a child that is exiting on its own (stdout already closed),
    /// then end what it left running.
    pub async fn wait_exit(&mut self, grace: Duration) -> i32 {
        self.tree.census();
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => {
                self.reaped = true;
                self.end_leftovers(grace).await;
                exit_code(status)
            }
            _ => self.terminate(grace).await,
        }
    }

    /// The adapter is gone; its descendants get SIGTERM, then SIGKILL.
    async fn end_leftovers(&mut self, grace: Duration) {
        self.tree.census();
        if self.tree.running().is_empty() {
            return;
        }
        self.tree.signal_members(libc::SIGTERM);
        let deadline = tokio::time::Instant::now() + grace;
        while tokio::time::Instant::now() < deadline && !self.tree.running().is_empty() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.tree.census();
        self.tree.signal_members(libc::SIGKILL);
    }

    fn try_reap(&mut self) -> Option<i32> {
        if self.reaped {
            return Some(-1);
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.reaped = true;
                Some(exit_code(status))
            }
            _ => None,
        }
    }

    fn signal_group(&self, signal: i32) {
        // Only while the child is unreaped: its pid is then still its own and
        // no other process group can have taken the same id.
        if self.reaped {
            return;
        }
        if let Some(pid) = self.pid {
            // SAFETY: plain syscall on our own child's process group.
            unsafe {
                libc::killpg(pid as libc::pid_t, signal);
            }
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
}

impl Drop for AcpConnection {
    /// A connection dropped without [`AcpConnection::terminate`] (the host is
    /// shutting down around it) still takes the agent's whole tree with it.
    fn drop(&mut self) {
        self.tree.census();
        if self.try_reap().is_none() {
            self.signal_group(libc::SIGKILL);
        }
        self.tree.signal_members(libc::SIGKILL);
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
