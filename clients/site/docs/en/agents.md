---
title: Connecting agents
description: How to bring an agent into oort as a member, how Claude Code and Codex on your Mac fit in, and what is not built yet.
status: partial
checked: 2026-11-09
sources:
- server-rust/bins/momo-agent-worker/src/provider.rs
- server-rust/bins/momo-agent-worker/src/anthropic.rs
- server-rust/bins/momo-agent-worker/src/partial.rs
- server-rust/crates/momo-provider-probe/src/cohosted.rs
- server-rust/bins/momo-server/src/routes/cohosted_agent.rs
- docs/adr/0203-cohosted-agent-detection.md
- scripts/self_host_env.sh
- infra/hermes/lockgate.py
- server-rust/bins/momo-server/src/routes/agent_credentials.rs
- server-rust/crates/momo-auth/src/agent_bearer.rs
- server-rust/bins/momo-server/src/dto.rs
- server-rust/bins/momo-server/src/routes/agent_gateway.rs
- server-rust/bins/momo-server/src/lib.rs
- server-rust/bins/momo-server/src/routes/agent_port.rs
- server-rust/bins/momo-server/src/routes/agent_port_oauth.rs
- server-rust/bins/momo-server/src/config.rs
- docs/adr/0162-external-agent-reception-agent-port.md
- packages/momo-core/src/features/hostedAgents/presets.ts
- docs/adr/0198-agents-vs-harnesses-work-request-routing.md
- packages/momo-core/src/features/onboarding/aiConnect.ts
- packages/momo-core/src/features/auth/personalAgentCall.ts
- server-rust/crates/momo-agent/src/subscription.rs
- packages/momo-core/src/features/ai/aiHubModel.ts
- server-rust/bins/momo-workd/src/acp.rs
- server-rust/bins/momo-workd/src/policy.rs
- docs/adr/0130-external-coding-agent-membership.md
- docs/adr/0183-codebase-docs-lightening.md
---

However an agent connects, it becomes a member of the workspace (`member.kind = 'agent'`), and you can mention it with `@handle` only in channels it has been added to.

| Agent | How it connects | Who can call it | Status |
|---|---|---|---|
| An agent backed by an OpenAI-compatible or Anthropic API key | [Model backends](#model-backends) | The team | {done} |
| Hermes on the same server | [Hermes](#hermes) | The team | {done} |
| Your own program that writes messages over HTTP | [REST agent members](#rest-agent-members) | The team | {done} |
| An external agent that can register a remote MCP server, such as the Grok bot | [Agent Port](#agent-port) | The team | {partial} |
| Claude Code or Codex on your Mac | [My tools and personal agents](#my-tools-and-personal-agents) | Only you | {partial} |

## Model backends {done}

oort's agent worker calls the model API itself. The server operator adds the key under AI › 팀 AI 키 (team AI keys), and the server stores it only as ciphertext.

| Key type | Endpoint | How the answer arrives |
|---|---|---|
| OpenAI-compatible key (Bearer) | `POST {base}/chat/completions` | All at once (`"stream": false`) |
| Anthropic key | `POST {base}/messages` | In pieces (streamed) |

- The OpenAI-compatible path does not stream. The answer appears in the channel in one piece once it is complete.
- The Anthropic path sends the `x-api-key` and `anthropic-version: 2023-06-01` headers, and the message in the channel fills in as the answer arrives.
- The kind of key stored picks the path, not the address.

## Hermes {done}

Hermes is an agent runtime. When the server operator runs Hermes on the same server and points oort at it with `HERMES_BASE_URL`, oort checks that address with two requests.

| Step | Request | What it checks |
|---|---|---|
| 1 | `GET /health` | Something answers at that address |
| 2 | `GET /v1/models` | It is an OpenAI-compatible server and the key is right |

If both pass, the operator sees a card asking whether to connect Hermes. Connecting creates Hermes as an agent member, and the agent worker calls Hermes's `/v1/chat/completions` without streaming (`"stream": false`).

- The check runs only when the operator opens the screen or checks again. oort does not scan the internal network or guess addresses.
- Hermes must have its terminal, code execution and browser tools turned off before it can be connected. The oort server cannot check this over the network, so a server setting, `OORT_COHOSTED_AGENT_TOOLS_LOCKED`, says so. The self-host settings generator sets it, and Hermes starts only after passing its lock check.
- Connecting does not grant any channel or tool access on its own. You add the agent to channels separately.

## REST agent members {done}

The simplest way to bring your own program in as an agent member. A workspace owner or admin issues a token for each agent, and the program uses that token to call the same REST API people use.

1. Create the agent member and add it to a channel.
2. Issue a token for that agent. Tokens start with `momo_agent_v1.` and are shown only once, when issued. The server keeps only a hash.
3. Your program sends the token in the `Authorization: Bearer` header.

```http
POST /v1/workspaces/<workspace id>/channels/<channel id>/messages
Authorization: Bearer <agent token>
Content-Type: application/json

{"clientMsgId": "<new UUID>", "body": "The deploy is done."}
```

- Keep the same `clientMsgId` when you resend a message. That way it is stored only once.
- Unknown fields are rejected with a 400.
- You can revoke a token at any time.

A runtime that works on mentions picks up the jobs the server creates (`…/gateway/jobs/pending`) and returns results to `…/gateway/complete`. This path is open only when the server runs with `AGENT_GATEWAY_MODE=gateway`.

## Agent Port {partial}

Agent Port is a remote MCP server that oort runs. It lives at `/v1/mcp/agent-port` and speaks MCP Streamable HTTP. An external agent adds this address as a remote server in its own MCP connector settings, and then connects to oort as an MCP client. The Grok bot connects this way.

- The address and connection value are issued under AI › 외부 연결 › 외부 에이전트 연결 (external connections › external agents). The connection value goes in the authorization header as the bearer value.
- OAuth 2.1 (PKCE S256) is built too, but it is off by default. Until the operator turns on `MOMO_AGENT_PORT_OAUTH_ENABLED`, every OAuth address answers 404.
- Every request is authenticated on its own, and no session state is kept.

Why it is Partial: there is a record of the Grok bot picking up jobs and reporting progress through this address on the oort team's own server. But the app's Grok bot guide still says it has not been confirmed whether the Grok bot actually sends the authorization header, and OAuth 2.1 is off.

## My tools and personal agents {partial}

Claude Code and Codex, signed in through their official CLIs on your Mac, are not members. They are "my tools" (내 도구 in the app). Your subscription is for you alone and is never shared with teammates.

If you want, you can turn one of your tools on as a personal agent. That creates an agent member with an alias (handle), but only its owner can call it. When a teammate mentions it, oort leaves a note saying it is someone's personal agent, and no job starts.

- The work host on your Mac (`momo-workd`) starts the CLI over ACP (Agent Client Protocol) and exchanges one JSON-RPC message per line over standard input and output.
- It answers only while your Mac is on. When the Mac is off, you see "내 맥이 꺼져 있어요" (my Mac is off), and the request is not queued.
- When you call it from the desktop or phone app, a work request signed with that device's key goes along with the message. In a browser, which has no signing key, only the message is posted and you see "데스크탑·폰에서 불러 주세요" (call it from the desktop or phone app).
- The work host runs only programs on the allowlist in its settings. Codex starts in a read-only mode that asks for approval. When a session ends, every process the agent started is cleaned up too.

Why it is Partial: only two CLIs connect this way today, Claude Code and Codex.

## Not built yet {planned}

- There is no way to register an agent from an A2A Agent Card. The old registration path (`agents/from-card`) has been removed.
- There is no agent SDK yet. For now, use the REST API or MCP above directly.
