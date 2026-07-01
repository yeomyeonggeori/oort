# Local Hermes GPT Provider Contract

> Status: Accepted for MOMO-238
> Scope: local-only development and smoke verification.

For the provider-neutral MOMO-242 smoke contract, start with
[`README.md`](README.md). This document is the local loopback specialization.

## Decision

`AGENT_PROVIDER_MODE=external-hermes` may point at a local Hermes process only
when the operator explicitly opts in:

```sh
MOMO_ENV=local \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
HERMES_BASE_URL=http://127.0.0.1:<port>/v1 \
HERMES_API_KEY=<local-hermes-bearer> \
AGENT_MODEL=<hermes-model-label> \
scripts/local_gate.sh --profile external-agent-provider
```

`http://localhost:<port>/v1` is equivalent. This exception is local-only and is
intended for a developer-run Hermes process that owns the GPT/OpenAI provider
credential.

momo still never owns GPT/OpenAI credentials. OpenAI API keys, Codex/OpenAI OAuth
access tokens, refresh tokens, provider account secrets, and provider refresh
state belong in the Hermes process or its provider-owned secret store. momo only
sees the Hermes-facing OpenAI-compatible `/v1/chat/completions` boundary plus the
opaque `HERMES_API_KEY` used to authenticate to Hermes.

## Allowed

- `MOMO_ENV=local`
- `AGENT_PROVIDER_MODE=external-hermes`
- `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`
- `HERMES_BASE_URL=http://127.0.0.1:<port>/v1`
- `HERMES_BASE_URL=http://localhost:<port>/v1`
- `HERMES_API_KEY=<local Hermes bearer>` where the value is not an OpenAI/GPT
  provider key and is not committed or copied into evidence
- no provider credentials in the current shell, which produces explicit
  `runtime-unverified(external provider credentials)` SKIP/PASS evidence

## Rejected

- non-loopback `http://...` external Hermes URLs
- any loopback or mock URL in `staging`, `prod`, `production`, or `internal-host`
- `http://0.0.0.0:<port>/v1`
- `mock-hermes` with `AGENT_PROVIDER_MODE=external-hermes`
- placeholder `HERMES_API_KEY` values for credentialed external-provider smoke
- `CODEX_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`,
  `OPENAI_OAUTH_TOKEN`, `OPENAI_ACCESS_TOKEN`, `OPENAI_API_KEY`, or equivalent
  provider credential env vars in the momo verifier process
- any momo app/API/DB/evidence path that stores or prints GPT/OpenAI provider
  credentials

## Smoke Behavior

`scripts/verify_external_agent_provider.sh` is the contract gate.

- If `AGENT_PROVIDER_MODE` is unset or not `external-hermes`, it exits 0 with
  explicit SKIP/PASS evidence and does not touch Docker/provider side effects.
- If `AGENT_PROVIDER_MODE=external-hermes` and no valid Hermes-facing config is
  present, it fails fast unless the run is simply the default no-credential skip.
- If local loopback is requested, both `MOMO_ENV=local` and
  `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` must be present.
- If credentialed config is valid, it checks the OpenAI-compatible SSE provider,
  boots local MomoServer/OutboxRelay/AgentWorker, verifies redacted
  `/v1/agent-runtime/status`, proves Kim Intern is an active `#agent-lab` agent
  member, and sends one `@김인턴` roundtrip.

## Boundary

Hermes owns:

- GPT/OpenAI API keys
- Codex/OpenAI OAuth authorization code exchange
- access/refresh token storage and refresh
- provider account unlink/revoke
- provider-specific audit needed to rotate those credentials

momo owns:

- workspace/member/channel identity
- message order and `message.seq`
- Context Packet projection and redaction
- approval/cost/audit ledgers
- outbox and Centrifugo publish path
- redacted provider availability/status projection

The provider must not publish directly to Centrifugo or mutate momo DB state.
All user-visible writes still enter through momo REST, Postgres, and outbox.

## Local Example

Run Hermes separately with its provider credential in that process only:

```sh
# Terminal A: Hermes owns OPENAI_API_KEY or Codex OAuth internally.
OPENAI_API_KEY=... hermes --host 127.0.0.1 --port 22683
```

Run momo smoke without exporting the OpenAI key:

```sh
unset OPENAI_API_KEY OPENAI_OAUTH_TOKEN OPENAI_ACCESS_TOKEN OPENAI_REFRESH_TOKEN

MOMO_ENV=local \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
HERMES_BASE_URL=http://127.0.0.1:22683/v1 \
HERMES_API_KEY=local-hermes-bearer \
AGENT_MODEL=gpt-via-local-hermes \
scripts/local_gate.sh --profile external-agent-provider
```

The evidence may contain the redacted endpoint label
`http://127.0.0.1:22683/v1`; it must not contain the Hermes bearer or any
GPT/OpenAI credential.

## References

- `docs/adr/0004-codex-oauth-hermes-provider-boundary.md`
- `docs/LOCAL_PR_GATE.md`
- `docs/RUN.md`
- `scripts/verify_external_agent_provider.sh`
