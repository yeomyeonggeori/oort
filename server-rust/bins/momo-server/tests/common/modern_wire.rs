#![allow(dead_code)]
//! A 「grok-like」 Agent Port client for the two #4618 PostgreSQL suites
//! (`grok_like_agent_flow_pg.rs`, `agent_port_call_trace_pg.rs`).
//!
//! It speaks the wire the production routine tells a hosted runtime to speak
//! (`docs/SELF_HOST_AGENT.ko.md` §3.3.17.4, 「Agent Port 호출 형태」): the **modern**
//! `2026-07-28` era, stateless, one POST per call, `mcp-method` / `mcp-name` headers,
//! `params._meta` carrying the protocol version and an empty `clientCapabilities`, a
//! static `momo_agent_v1.*` bearer. No `initialize`, no session, no cursor kept by the
//! server — exactly what a `curl` in a vendor VM sends.
//!
//! It also keeps a log of what it sent, so a suite can compare **what the client did**
//! with **what the server wrote down about it**.

use std::sync::Mutex;

use momo_db::sqlx;
use momo_db::PgPool;
use serde_json::{json, Value};
use uuid::Uuid;

pub const MODERN: &str = "2026-07-28";
pub const LEGACY: &str = "2025-11-25";
pub const PATH: &str = "/v1/mcp/agent-port";
pub const ACCEPT: &str = "application/json, text/event-stream";

/// One answer from the Agent Port.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    /// The tool's machine result (`result.structuredContent`).
    pub fn structured(&self) -> &Value {
        &self.body["result"]["structuredContent"]
    }

    /// The JSON-RPC `error.code`, when the call was refused.
    pub fn rpc_code(&self) -> Option<i64> {
        self.body["error"]["code"].as_i64()
    }

    pub fn is_ok(&self) -> bool {
        self.status == 200 && self.body.get("error").is_none()
    }
}

/// What the client sent, in the closed terms the server's trace uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub method: String,
    pub tool: Option<String>,
    pub status: u16,
    pub rpc_code: Option<i64>,
}

pub struct Wire {
    pub client: reqwest::Client,
    pub base: String,
    pub bearer: String,
    sent: Mutex<Vec<Sent>>,
}

impl Wire {
    pub fn new(base: &str, bearer: &str) -> Wire {
        Wire {
            client: reqwest::Client::new(),
            base: base.to_string(),
            bearer: bearer.to_string(),
            sent: Mutex::new(Vec::new()),
        }
    }

    /// The same client with another credential (a second agent).
    pub fn with_bearer(&self, bearer: &str) -> Wire {
        Wire {
            client: self.client.clone(),
            base: self.base.clone(),
            bearer: bearer.to_string(),
            sent: Mutex::new(Vec::new()),
        }
    }

    /// Everything this client has sent, oldest first.
    pub fn log(&self) -> Vec<Sent> {
        self.sent.lock().expect("log lock").clone()
    }

    fn modern_params(extra: Value) -> Value {
        let mut params = json!({"_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {}
        }});
        if let (Some(target), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                target.insert(key.clone(), value.clone());
            }
        }
        params
    }

    /// `tools/call` of one tool, the way the routine's `curl` does.
    pub async fn tool(&self, name: &str, arguments: Value) -> Reply {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": Self::modern_params(json!({"name": name, "arguments": arguments}))
        });
        self.post(
            &serde_json::to_vec(&body).expect("body"),
            &[
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/call"),
                ("mcp-name", name),
            ],
            Some(("tools/call", Some(name))),
        )
        .await
    }

    /// The routine's once-per-wake `tools/list`.
    pub async fn list(&self) -> Reply {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/list",
            "params": Self::modern_params(json!({}))
        });
        self.post(
            &serde_json::to_vec(&body).expect("body"),
            &[
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/list"),
            ],
            Some(("tools/list", None)),
        )
        .await
    }

    /// Any bytes, any extra headers (the broken calls a real client can make).
    /// `extra` replaces nothing: a header named twice is sent twice.
    pub async fn raw(&self, body: &[u8], extra: &[(&str, &str)]) -> Reply {
        self.post(body, extra, None).await
    }

    async fn post(
        &self,
        body: &[u8],
        extra: &[(&str, &str)],
        record: Option<(&str, Option<&str>)>,
    ) -> Reply {
        let mut request = self
            .client
            .post(format!("{}{PATH}", self.base))
            .bearer_auth(&self.bearer)
            .body(body.to_vec());
        let mut has_content_type = false;
        let mut has_accept = false;
        for (name, value) in extra {
            has_content_type |= name.eq_ignore_ascii_case("content-type");
            has_accept |= name.eq_ignore_ascii_case("accept");
            request = request.header(*name, *value);
        }
        if !has_content_type {
            request = request.header("content-type", "application/json");
        }
        if !has_accept {
            request = request.header("accept", ACCEPT);
        }
        let response = request.send().await.expect("agent port POST");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let reply = Reply { status, body };
        if let Some((method, tool)) = record {
            self.sent.lock().expect("log lock").push(Sent {
                method: method.to_string(),
                tool: tool.map(str::to_string),
                status,
                rpc_code: reply.rpc_code(),
            });
        }
        reply
    }

    // ---- the routine's own steps, as named helpers --------------------------------

    /// Step 0: `oort_ping {state:"idle"}`.
    pub async fn ping(&self) -> Reply {
        self.tool("oort_ping", json!({"state": "idle"})).await
    }

    /// Step 1: `oort_inbox_read`, with the saved cursor when there is one.
    pub async fn inbox(&self, cursor: Option<&str>) -> Reply {
        match cursor {
            Some(cursor) => {
                self.tool("oort_inbox_read", json!({"cursor": cursor}))
                    .await
            }
            None => self.tool("oort_inbox_read", json!({})).await,
        }
    }

    /// Step 3a: `oort_job_start {}` — claim the next job, send the start report and read the
    /// conversation in one call.
    pub async fn job_start(&self) -> Reply {
        self.tool("oort_job_start", json!({})).await
    }

    pub async fn run_event(&self, handle: &str, stage: &str) -> Reply {
        self.tool(
            "oort_run_event",
            json!({"leaseHandle": handle, "status": "running", "stage": stage,
                   "eventId": Uuid::new_v4()}),
        )
        .await
    }

    pub async fn run_complete(&self, handle: &str, body: &str) -> Reply {
        self.tool(
            "oort_run_complete",
            json!({"leaseHandle": handle, "status": "succeeded", "body": body}),
        )
        .await
    }
}

/// `(kind, channelId)` of every event of an `oort_inbox_read` answer.
pub fn events(reply: &Reply) -> Vec<(String, String)> {
    reply.structured()["events"]
        .as_array()
        .map(|events| {
            events
                .iter()
                .map(|event| {
                    (
                        event["kind"].as_str().unwrap_or_default().to_string(),
                        event["channelId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_lowercase(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn next_cursor(reply: &Reply) -> String {
    reply.structured()["nextCursor"]
        .as_str()
        .expect("nextCursor is always present")
        .to_string()
}

/// The `detail` of every `agent_port.call` audit row of one agent, oldest first.
pub async fn trace_rows(su: &PgPool, workspace: Uuid, agent: Uuid) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'agent_port.call' AND actor_member_id = $2 \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_all(su)
    .await
    .expect("read the call trace")
}

/// What the server wrote down about each call, in the shape of [`Sent`].
pub fn trace_as_sent(rows: &[Value]) -> Vec<Sent> {
    rows.iter()
        .map(|row| Sent {
            method: row["method"].as_str().unwrap_or_default().to_string(),
            tool: row["tool"].as_str().map(str::to_string),
            status: row["status"].as_u64().unwrap_or_default() as u16,
            rpc_code: row["rpc_code"].as_i64(),
        })
        .collect()
}
