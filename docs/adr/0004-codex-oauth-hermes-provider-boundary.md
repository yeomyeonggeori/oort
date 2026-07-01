# ADR 0004: Codex OAuth Boundary for Hermes/Kim Intern Provider

> Status: Accepted for MOMO-234
> Date: 2026-07-01

## Decision

momo does not own, store, proxy, log, or persist Codex/OpenAI OAuth access
tokens, refresh tokens, or GPT/OpenAI provider API keys.

When Kim Intern uses a Hermes or provider-hosted Codex runtime, the Codex OAuth
credential boundary is outside the momo app, API, worker, database, diagnostics,
and local gate evidence. momo talks only to the Hermes/Kim Intern provider over
the existing OpenAI-compatible `/v1/chat/completions` SSE boundary by using an
opaque Hermes-facing bearer configured as `HERMES_API_KEY`.

The provider owns any Codex/OpenAI OAuth flow, token exchange, token refresh,
GPT/OpenAI API key storage, provider account unlink, and OAuth storage. momo owns
workspace identity, membership, Context Packet projection, approval, cost, audit,
message ordering, and realtime delivery.

## Boundary

| Item | Owner | Storage | momo visibility |
|---|---|---|---|
| Codex OAuth authorization code | Hermes/Kim Intern provider | Provider-only transient exchange | Never sent to momo |
| Codex OAuth access token | Hermes/Kim Intern provider | Provider secret store or memory, according to provider policy | Never sent to momo |
| Codex OAuth refresh token | Hermes/Kim Intern provider | Provider secret store, encrypted by provider | Never sent to momo |
| GPT/OpenAI API key | Hermes/Kim Intern provider | Provider secret store, encrypted file, local shell, or memory according to provider policy | Never sent to momo |
| Hermes-facing bearer for momo worker | Operator/momo runtime env | Untracked env, SOPS/host secret, or local shell | Used only as Bearer key to Hermes; redacted from evidence |
| momo app access/refresh token | momo API | momo auth tables/JWT boundary | Not accepted as provider credential |
| Context Packet and tool grants | momo | Postgres/source projections | Sent to provider as bounded non-secret work context |
| Agent result, cost, audit | momo | Postgres + outbox + Centrifugo transport | Source of truth for momo user-visible work |

## Rules

1. momo must not introduce `codex_oauth_*`, `codex_access_token`,
   `codex_refresh_token`, `openai_oauth_*`, or equivalent columns.
2. momo app/API/DB must not accept Codex OAuth tokens in request bodies, env
   files, logs, diagnostics, local gate evidence, Context Packets, Memory Plane,
   Capability Cache, or audit payloads.
3. `scripts/verify_external_agent_provider.sh` fails fast when known Codex OAuth
   token or OpenAI API key env var names are present. Those values belong in the
   provider host, not in the momo smoke process.
4. Provider endpoint labels may be shown only after removing userinfo, query,
   fragment, and secrets.
5. Provider secrets are never copied into generated evidence. Redacted artifact
   paths are acceptable; raw provider logs are deleted after sanitization.
6. User-visible messages still enter through momo REST/DB/outbox. The provider
   must never publish directly to Centrifugo or mutate momo DB state.

## Credentialed Smoke

The momo-side credentialed smoke requires only:

- `AGENT_PROVIDER_MODE=external-hermes`
- `HERMES_BASE_URL=https://<provider>/v1`
- `HERMES_API_KEY=<provider-api-key>`
- `AGENT_MODEL=<provider model label>`
- optional `EXTERNAL_AGENT_PROVIDER_ENV_FILE=<untracked provider env file>`

If the provider itself uses Codex OAuth, the provider operator configures that
inside Hermes/Kim Intern. The momo smoke verifies only that the provider exposes
an OpenAI-compatible SSE surface and that momo can complete one Kim Intern
roundtrip without seeing Codex OAuth tokens.

For local-only development, MOMO-238 permits an explicit loopback exception:

- `MOMO_ENV=local`
- `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`
- `HERMES_BASE_URL=http://127.0.0.1:<port>/v1` or
  `http://localhost:<port>/v1`

This exception is only for a developer-run Hermes process. Non-loopback
`http://` URLs still fail fast, and loopback/mock URLs still fail fast in
`staging`, `prod`, `production`, and `internal-host`.

## Rotation and Revocation

- Rotate `HERMES_API_KEY` in the operator secret store and restart the provider
  consumer processes. momo treats the key as opaque.
- Rotate or revoke Codex OAuth credentials only in the provider control plane.
  momo records provider availability degradation, not token values.
- If provider auth fails with 401/403, AgentWorker must fail the run or retry
  according to worker retry policy, leaving an audit/status reason such as
  `provider_auth_failed` without including credential material.
- If a user unlinks Codex in the provider, future momo runs should degrade or
  fail closed until the provider reports availability again.

## Redaction

Evidence and diagnostics must redact:

- `HERMES_API_KEY`
- `Authorization: Bearer ...`
- database URL passwords
- momo app access/refresh tokens
- any key whose name contains Codex/OpenAI OAuth token or refresh token markers
- any `OPENAI_API_KEY`/`CODEX_API_KEY` style provider key env var

`/v1/agent-runtime/status` may expose `mode`, `availability`, `model`,
`keyConfigured`, and a redacted `endpointLabel`; it must not expose token bodies
or provider account identifiers.

## Failure Modes

| Failure | momo behavior |
|---|---|
| No external provider env | Safe PASS/SKIP with `runtime-unverified(external provider credentials)` evidence |
| Placeholder/local/mock external provider env | Fail fast as misconfigured credentialed smoke |
| Codex/OpenAI OAuth token or API key env passed to momo smoke | Fail fast and tell operator to move it to provider host |
| Local loopback Hermes without explicit opt-in | Fail fast unless `MOMO_ENV=local` and `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` |
| Non-loopback `http://` provider URL | Fail fast; use HTTPS or a local loopback opt-in |
| Provider SSE unavailable or malformed | Fail with provider/network or provider/protocol category |
| Provider auth rejected | Fail/degrade without printing credential material |
| momo roundtrip timeout | Fail with runtime timeout and redacted server/worker/relay logs |

## Audit

momo audit records must identify the provider mode, redacted endpoint label,
agent run, trigger message, tool/approval decisions, usage ledger, and final
message ids. Audit must not record Codex/OpenAI OAuth subject ids, access tokens,
refresh tokens, authorization codes, GPT/OpenAI provider API keys, or provider
raw account secrets unless a future explicit privacy/security review introduces a
separate encrypted provider-link table.

## References

- `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`
- `docs/external-agent-provider/local-hermes-gpt.md`
- `docs/RUN.md` section "Kim Intern/Hermes provider mode"
- `docs/LOCAL_PR_GATE.md` profile `external-agent-provider`
- `scripts/verify_external_agent_provider.sh`
