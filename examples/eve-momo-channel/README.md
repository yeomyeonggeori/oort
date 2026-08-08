# eve → oort channel reference

This example lets an eve-hosted agent consume oort's existing gateway BYOA contract. It does not add a server route and never publishes to Centrifugo directly.

## Architecture

```text
momo message / @agent
  -> Postgres agent_run + agent_job outbox (momo is SoT)
  -> GET gateway/jobs/pending (per-agent bearer claims a lease)
  -> eve custom POST /poll
       routeAuth -> send(prompt, continuationToken, state)
  -> eve message.completed
  -> POST gateway/complete (job_id + lease_id + final body)
  -> momo message INSERT + outbox in the server transaction
  -> momo clients receive message.new
```

`continuationToken` is a stable oort workspace/channel/thread key:

```text
momo:<workspace_id>:<channel_id>:<root_or_trigger_message_id>
```

eve namespaces this raw token with the channel file name, so follow-up jobs for the same oort conversation resume the same eve session.

## Install and place the channel

This directory intentionally owns its npm graph; do not add these packages to oort's root.

```bash
cd examples/eve-momo-channel
npm ci
npm test
```

The custom channel is [agent/channels/momo.ts](agent/channels/momo.ts). The
minimal [agent/instructions.md](agent/instructions.md) makes the preset a
buildable eve application while leaving persona/model customization to the
self-host operator. Copy the `agent/` and `src/` files into an eve agent project
with the same relative layout, then invoke the channel's authenticated
`POST /poll` route from your scheduler.

The example pins **eve 0.27.0** because eve is beta and its channel API changes frequently. The authored surface is deliberately limited to `defineChannel`, `POST`, `send()`, `continuationToken`, channel state, `message.completed`, and `routeAuth`. Review eve's custom-channel changelog before changing the pin.

The self-host compose preset also pins `@workflow/world-postgres` to
**5.0.0-beta.27**. It sets `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and
uses the isolated `eve_world` database; it never receives oort's application,
relay, worker, or database-owner connection URL.

## Environment

| Variable | Required | Purpose |
|---|---:|---|
| `MOMO_BASE_URL` | yes | oort API origin, for example `https://momo.example.com` |
| `MOMO_WORKSPACE_ID` | yes | Workspace UUID encoded in the gateway route |
| `MOMO_AGENT_MEMBER_ID` | yes | oort `member(kind=agent)` UUID targeted by pending jobs |
| `MOMO_AGENT_TOKEN` | yes | Scoped per-agent bearer minted by oort; outbound gateway calls only |
| `MOMO_CHANNEL_ROUTE_TOKEN` | yes | Separate bearer protecting eve's `/poll` route |

Inject all credentials as runtime environment variables. Do not commit them, serialize them into eve state, include them in request bodies, or print them. The client emits only a generic HTTP status on failure, consistent with ADR-0004.

The oort paths consumed here are:

- `GET /v1/workspaces/{workspaceId}/agents/{agentId}/gateway/jobs/pending`
- `POST /v1/workspaces/{workspaceId}/agent-runs/{runId}/gateway/events`
- `POST /v1/workspaces/{workspaceId}/agent-runs/{runId}/gateway/complete`

They match `adapters/hermes/momo_adapter.py` and the live server routes. At this baseline, `docs/api/openapi.yaml` explicitly leaves agent credential/run routes undocumented, so this contract-consuming example does not change OpenAPI.

## Limits

- This is a minimal polling reference, not a production scheduler. Add bounded retry/backoff and lease renewal for turns that can exceed oort's lease duration.
- The route claims one job at a time. Scale-out callers must preserve the lease returned by oort; never synthesize or share it.
- eve's real runtime remains `runtime-unverified` in MOMO-534. The repository verifier uses a small mock eve `send()` runtime to exercise the same pending → message → callback logic.
- Approval cards and approval decisions round-trip in the oort app. This adapter must stop on an approval request; it does not render or approve cards inside eve.
- Provider/model credentials belong to eve. They must not enter oort payloads, logs, state, or this adapter.
