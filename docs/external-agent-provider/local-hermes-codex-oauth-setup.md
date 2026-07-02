# Local Hermes/Codex OAuth Provider Setup

> Status: Accepted for MOMO-257.
> Scope: local MacBook + Docker Desktop dogfood setup for a user-operated
> Hermes-compatible runtime. This document does not implement Codex OAuth inside
> momo, does not store provider credentials in momo, and does not replace the
> deterministic repo-local mock Hermes gates.

## Goal

Run a real local Hermes-compatible provider that may authenticate to Codex,
OpenAI, or another GPT provider, then let momo prove one safe `@hermes`
roundtrip through:

```text
macOS app -> MomoServer -> agent_job -> AgentWorker -> local Hermes-compatible SSE provider -> channel timeline
```

The user performs OAuth login/token entry in the provider. Codex and momo only
prepare the boundary, scripts, and evidence.

## Ownership Boundary

| Item | Owner | Where it may live |
|---|---|---|
| Codex/OpenAI OAuth login, authorization code, access token, refresh token | User-operated Hermes-compatible provider | Provider UI, provider secret store, keychain, or provider runtime memory |
| GPT/OpenAI provider API key | User-operated Hermes-compatible provider | Provider-only env/secret store, never momo |
| Hermes-facing bearer used by momo | Operator/runtime config | Out-of-repo momo provider env file or host secret |
| Workspace, channel, member, context packet, cost, approval, audit | momo | Postgres + outbox + redacted status/evidence |

momo must not read, log, store, or copy Codex/OpenAI OAuth tokens or GPT/OpenAI
provider API keys. If those variables are present in the momo smoke process,
the verifier fails before contacting the provider.

## Safe Local Topology

```text
User browser/provider UI
  performs OAuth/login/token setup
        |
        v
Local Hermes-compatible provider
  127.0.0.1:<provider-port>/v1/chat/completions
  owns provider credentials
        ^
        | HERMES_BASE_URL + HERMES_API_KEY only
        |
momo AgentWorker
  Docker Postgres/Centrifugo + host Swift server/relay/worker
```

Non-loopback `http://` provider URLs are rejected. Loopback `http://127.0.0.1`
or `http://localhost` is allowed only with `MOMO_ENV=local` and
`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`.

## User Steps

1. Start the local Hermes-compatible provider.

   The exact command depends on the provider. Complete any Codex OAuth, OpenAI
   API key, or GPT provider login inside that provider process. Do not export
   Codex/OpenAI credentials into the momo shell.

2. Confirm the provider exposes an OpenAI-compatible SSE endpoint.

   The expected boundary is:

   ```text
   http://127.0.0.1:<provider-port>/v1/chat/completions
   ```

3. Create the momo-facing env file outside this repository.

   ```bash
   mkdir -p "$HOME/.momo"
   cp docs/external-agent-provider/local-hermes-provider.env.example \
     "$HOME/.momo/local-hermes-provider.env"
   chmod 600 "$HOME/.momo/local-hermes-provider.env"
   ```

   Edit only the momo-facing values:

   ```bash
   MOMO_ENV=local
   AGENT_PROVIDER_MODE=external-hermes
   AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1
   AGENT_MODEL=<provider-model-label>
   HERMES_BASE_URL=http://127.0.0.1:<provider-port>/v1
   HERMES_API_KEY=<local-hermes-facing-bearer>
   ```

   Do not put `OPENAI_API_KEY`, `CODEX_OAUTH_TOKEN`, refresh tokens, or provider
   account secrets in this file.

4. Run the credentialed smoke.

   ```bash
   scripts/verify_local_hermes_credentialed_smoke.sh
   ```

   If the env file is missing, the script exits successfully with
   `NEEDS_USER_CREDENTIAL` evidence so the local dogfood packet can say exactly
   what is still human-owned. If you want the command to fail until the provider
   is configured, run:

   ```bash
   LOCAL_HERMES_REQUIRE_CREDENTIALS=1 scripts/verify_local_hermes_credentialed_smoke.sh
   ```

5. Use the app.

   Start momo, open `#agent-lab`, and send:

   ```text
   @hermes summarize this channel in one paragraph.
   ```

   A passing smoke means the response appears as a durable channel message and
   the provider evidence records the redacted endpoint label, run id, final
   message id, and relay publication.

## What PASS Means

- Provider SSE preflight returned `data:` stream chunks.
- `/v1/agent-runtime/status` reported `external-hermes`, `available`,
  `keyConfigured=true`, and a redacted endpoint label.
- Seeded Hermes is an active `member.kind='agent'` with `#agent-lab`
  membership.
- `@hermes` created an `agent_run`/`agent_job`, AgentWorker called the provider,
  usage/cost records were written, and the final agent response appeared in the
  same channel timeline.
- Evidence contains no raw `HERMES_API_KEY`, bearer token, database password,
  app token, Codex OAuth token, or OpenAI provider API key.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `NEEDS_USER_CREDENTIAL` | No out-of-repo env file | Create `$HOME/.momo/local-hermes-provider.env` from the example |
| `credential-boundary` fail | OpenAI/Codex token exported in momo shell | Unset it and configure it inside the provider runtime only |
| `HERMES_BASE_URL must not point at localhost` | Missing local opt-in | Set `MOMO_ENV=local` and `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` |
| `provider/network` fail | Provider is not running or wrong port/path | Check provider `/v1/chat/completions` endpoint and port |
| `provider/protocol` fail | Provider did not stream SSE data | Enable streaming or choose an OpenAI-compatible endpoint |
| `runtime/status` degraded | Server/worker rejected provider config | Open Command Center, copy the redacted reason, and rerun the script |
| `runtime/timeout` | Provider responded too slowly or worker failed | Check redacted worker/server logs from the evidence block |

## References

- `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`
- `docs/external-agent-provider/README.md`
- `docs/external-agent-provider/local-hermes-gpt.md`
- `docs/external-agent-provider/local-hermes-provider.env.example`
- `scripts/verify_local_hermes_credentialed_smoke.sh`
- `scripts/verify_external_agent_provider.sh`
