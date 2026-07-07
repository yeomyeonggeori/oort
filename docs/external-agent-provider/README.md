# External Agent Runtime Provider Smoke

> Status: Accepted for MOMO-242; updated by MOMO-257 for local
> Hermes/Codex-OAuth setup evidence and by MOMO-326 for real Hermes gateway
> plugin/readiness smoke evidence.
> Scope: local/internal-alpha smoke for an external agent runtime. This is not
> provider account setup, billing setup, long-term memory, or AWS deployment.

## Integration Paths

External Hermes can connect to momo through two product-supported paths:

- **AgentWorker SSE path**: momo owns the worker loop and calls a
  Hermes/OpenAI-compatible `/v1/chat/completions` endpoint. This remains the
  deterministic default for local gates.
- **Hermes gateway native platform path**: Hermes treats momo like a
  Slack/Telegram-style messaging platform, receives momo `agent.job` events,
  and reports status/results back to momo REST. See
  [`hermes-gateway-native-platform.md`](hermes-gateway-native-platform.md).
  Real readiness is checked with `scripts/momo hermes-gateway-smoke --real`;
  the actual provider OAuth/login still happens inside Hermes and is user-owned.

Both paths keep momo as the source of truth for channel messages, approval,
usage, and audit.

## Boundary

momo treats an agent as a first-class `member.kind='agent'`. The external agent
runtime is the provider process behind that member. In v0 the concrete boundary
is an OpenAI-compatible `/v1/chat/completions` endpoint, usually Hermes, but the
smoke is intentionally provider-layer oriented:

- momo owns workspace, channel, membership, Context Packet projection, approval,
  cost, audit, message order, and the REST -> Postgres -> outbox write path.
- the provider runtime owns GPT/OpenAI API keys, Codex/OpenAI OAuth
  authorization, access/refresh token storage, provider account refresh, and
  provider-specific revocation.
- momo receives only a Hermes-facing `HERMES_API_KEY` and a redacted endpoint
  label. That key is never stored in momo DB and must not appear in logs,
  diagnostics, local gate evidence, message props, or status responses.
- the provider must not publish directly to Centrifugo or mutate momo DB state.
  User-visible writes still enter through momo REST, Postgres, and outbox.

## Secret Env Format

Create the provider env file outside the repository, for example
`$HOME/.momo/external-agent.env`:

```sh
# Provider smoke mode.
MOMO_ENV=staging
AGENT_PROVIDER_MODE=external-hermes
AGENT_MODEL=hermes-agent

# Hermes/OpenAI-compatible boundary seen by momo.
HERMES_BASE_URL=https://hermes.example.com/v1
HERMES_API_KEY=<hermes-facing-bearer>
```

For a local developer-run Hermes process, loopback is allowed only with an
explicit local opt-in:

```sh
MOMO_ENV=local
AGENT_PROVIDER_MODE=external-hermes
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1
AGENT_MODEL=gpt-via-local-hermes
HERMES_BASE_URL=http://127.0.0.1:22683/v1
HERMES_API_KEY=<local-hermes-bearer>
```

Do not put `OPENAI_API_KEY`, Codex OAuth access/refresh tokens, or provider
account secrets in this env file. Those belong inside the external runtime.

## Mock vs External Runtime

| Path | Runtime | Credential | Coverage |
|---|---|---|---|
| repo-local mock | `scripts/mock_hermes.py` | dev-only local bearer | deterministic AgentWorker, tool-call, cost, status, and timeline smoke |
| internal-host mock | compose `mock-hermes` image | internal smoke placeholder | image-based host-runtime smoke without real provider side effects |
| external runtime | Hermes/OpenAI-compatible provider | out-of-repo `HERMES_API_KEY` only | provider SSE preflight plus one `@hermes` channel roundtrip through MomoServer, AgentWorker, OutboxRelay, and timeline |

## Smoke Commands

Default no-secret local gate stays deterministic and exits successfully with
explicit `NEEDS_USER_CREDENTIAL` / `runtime-unverified(external provider credentials)` evidence:

```sh
scripts/local_gate.sh --profile external-agent-provider
```

Credentialed local Hermes/Codex-OAuth runtime smoke, preferred for dogfood:

```sh
scripts/verify_local_hermes_credentialed_smoke.sh
LOCAL_HERMES_PROVIDER_ENV_FILE="$HOME/.momo/local-hermes-provider.env" \
  scripts/verify_local_hermes_credentialed_smoke.sh
```

Credentialed external runtime smoke, lower-level equivalent:

```sh
EXTERNAL_AGENT_PROVIDER_REQUIRE_CREDENTIALS=1 \
EXTERNAL_AGENT_PROVIDER_ENV_FILE="$HOME/.momo/external-agent.env" \
scripts/verify_external_agent_provider.sh
```

Equivalent local-alpha runner option:

```sh
scripts/local_alpha_runner.sh execute \
  --hermes external \
  --external-smoke \
  --secret-env "$HOME/.momo/external-agent.env"
```

Expected credentialed coverage:

1. OpenAI-compatible SSE preflight against `${HERMES_BASE_URL}/chat/completions`.
2. Local MomoServer, OutboxRelay, AgentWorker, PostgreSQL, and Centrifugo boot.
3. `/v1/agent-runtime/status` reports `mode=external-hermes`,
   `availability=available`, `keyConfigured=true`, a redacted `endpointLabel`,
   and no `degradedReason`.
4. Seeded Hermes is verified as an active `member.kind='agent'` in `#agent-lab`.
5. A channel message mentioning `@hermes` creates an `agent_run`, calls the
   external runtime, writes a durable agent response message, and publishes the
   final `message.new` through OutboxRelay.

On failure, evidence records a redacted failure category/reason. If status is
reachable but degraded, `/v1/agent-runtime/status` includes `degradedReason`
without provider tokens or raw secrets.

## References

- `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`
- `docs/external-agent-provider/hermes-gateway-native-platform.md`
- `docs/external-agent-provider/local-hermes-codex-oauth-setup.md`
- `docs/external-agent-provider/local-hermes-gpt.md`
- `docs/INTERNAL_ALPHA.md`
- `docs/LOCAL_PR_GATE.md`
- `scripts/verify_external_agent_provider.sh`
