# Cloudflare Agent → momo reference

This example is the Cloudflare Agents SDK equivalent of the eve momo channel. A Durable Object-backed `Agent` uses `fetch` to claim momo gateway work, executes platform-owned agent logic, and completes the leased momo run.

## Architecture

```text
momo message / @agent
  -> Postgres agent_run + gateway agent_job outbox
  -> Cloudflare Agent instance authenticated POST /poll
       -> GET gateway/jobs/pending with per-agent bearer
       -> handleMomoJob(job) on the Agent instance
       -> POST gateway/events { status: running, job_id, lease_id }
       -> POST gateway/complete { final body, job_id, lease_id }
  -> momo server commits final message + outbox
  -> momo clients receive message.new
```

The Agent instance can be named with the momo workspace/channel key when routing it, which gives the Durable Object the same stable conversation identity as the eve `continuationToken` example.

## Install and adapt

Dependencies are isolated to this example directory.

```bash
cd examples/cloudflare-agent-momo
npm ci
npm test
```

The package pins **Cloudflare `agents` 0.3.10** and overrides its unused Node/MCP transitives to advisory-fixed `@modelcontextprotocol/sdk` 1.26.0 and `@hono/node-server` 2.0.11. This reviewed line keeps the minimal API surface free of the later Babel/browser-compatibility CC-BY data dependency. `src/index.ts` uses only `Agent`, `onRequest`, state, and `routeAgentRequest`. Override `handleMomoJob()` with your existing model/tool loop; the reference response is intentionally deterministic. Re-run API, license, and audit checks before changing any pin.

`wrangler.jsonc` contains the Durable Object binding and SQLite migration. Add a deploy command only in the consuming project; this reference does not deploy external infrastructure.

## Environment and secrets

| Variable | Required | Purpose |
|---|---:|---|
| `MOMO_BASE_URL` | yes | Public HTTPS momo API origin |
| `MOMO_WORKSPACE_ID` | yes | Workspace UUID for the agent membership |
| `MOMO_AGENT_MEMBER_ID` | yes | momo agent member UUID |
| `MOMO_AGENT_TOKEN` | yes | Scoped per-agent bearer for pending/event/complete calls |
| `MOMO_CHANNEL_ROUTE_TOKEN` | yes | Separate bearer protecting the Cloudflare Agent `/poll` trigger |

Set non-secret IDs as Worker vars and inject both tokens with `wrangler secret put` (or the equivalent deployment secret store). Never put either bearer in `wrangler.jsonc`, Durable Object state, source, request bodies, or logs. Failures expose only HTTP status codes, following ADR-0004.

The fetch client consumes the same gateway endpoints as `adapters/hermes/momo_adapter.py`. At this baseline, `docs/api/openapi.yaml` explicitly leaves agent credential/run routes undocumented; the example therefore follows the live server/Hermes contract and does not alter OpenAPI, momo core routes, or Centrifugo.

## Limits

- `/poll` is an explicit reference trigger. Production deployments should schedule it or push a signal, apply bounded backoff, and renew leases for long work.
- WebSocket input is intentionally omitted. Add it only with equivalent connection authentication; the momo write path must remain REST.
- One Agent instance should own one logical momo conversation or agent partition. Do not share a claimed lease across instances.
- Approval cards and human decisions remain in the momo app. The adapter does not approve work from Cloudflare.
- Provider credentials stay in the Cloudflare runtime and must never be copied into momo callbacks or state.
