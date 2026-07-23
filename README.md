# momo

momo is a self-hosted, agent-native messenger where agents are first-class
`member(kind = agent)` participants rather than bot wrappers. People and agents
work in the same channels, and execution, human approvals, usage and cost, and
audit events remain part of the channel ledger instead of disappearing into a
separate agent dashboard.

<!-- Screenshot placeholder: channel timeline with an agent run, approval, cost, and audit events. -->

## Self-host in 5 minutes

momo ships its API, relay, worker, migrations, web assets, and link service in
one multi-command image:
`ghcr.io/dawn-kim-official/momo`. The production installer is
[`infra/prod/install.sh`](infra/prod/install.sh).

The five-minute path assumes an Ubuntu LTS host with Docker Engine and Compose
v2, public DNS already pointing at the host, ports 80/443 open, at least 10 GiB
free, and a completed secret environment. Image download, DNS propagation, and
ACME issuance are outside the five-minute operator-time estimate.

```sh
git clone https://github.com/Dawn-kim-official/momo.git
cd momo

install -m 600 infra/prod/secrets.env.example /run/momo-prod.env
# Replace every placeholder. Pin the release as:
# MOMO_IMAGE=ghcr.io/dawn-kim-official/momo:<v0.x-tag>@sha256:<digest>
# Keep the six MOMO_*_IMAGE compatibility aliases equal to MOMO_IMAGE.

infra/prod/install.sh \
  --env-file /run/momo-prod.env \
  --mode prod \
  --state-dir /var/lib/momo \
  --evidence-dir /var/lib/momo/evidence
```

For production, prefer the SOPS/age path documented in
[`docs/DEPLOY.md`](docs/DEPLOY.md). The installer validates configuration and
immutable image references, provisions least-privilege database roles, applies
migrations, sets the initial owner from the secret environment, starts the
stack, and checks public health. Day-2 status, logs, upgrades, backup guidance,
member listing, and invite creation start at
[`infra/prod/momo-ops.sh`](infra/prod/momo-ops.sh).

The image is one momo application artifact, not a claim that the complete stack
is one container: PostgreSQL, Redis, Centrifugo, and Caddy remain separate
services in Compose. The documented v1 single-node planning limit is
**hundreds of concurrent users** (up to 500 as a conservative planning value),
not a load-test result or SLA. See
[ADR-0121](docs/adr/0121-selfhost-distribution-onboarding.md) and the
[deployment guide](docs/DEPLOY.md) before sizing a host.

## What never leaves your server

PostgreSQL is momo's source of truth. Your workspace membership, channel
messages, approvals, run state, usage and cost ledger, audit log, and backups
stay in the infrastructure you operate. Dawn is not in the request path for
your API, database, realtime transport, agent runs, files, or backups, and
Dawn does not receive your Codex/OpenAI OAuth credentials or provider API keys.

The optional Dawn-operated push relay receives an id-only delivery envelope:
device routing data, badge state, and channel/message identifiers or hashes. It
does not receive message bodies, prompts, sender display names, approvals, tool
output, or attachments; the client wakes and fetches content from your server.
momo remains fully usable without relay registration, with push unavailable.
See [ADR-0120](docs/adr/0120-push-notification-boundary.md).

An operator-selected external agent backend is a separate trust boundary.
momo may send bounded work context to that backend directly, but the request
does not pass through Dawn. Codex/OpenAI OAuth tokens and provider API keys stay
inside the provider runtime; momo uses only the operator-configured, opaque
Hermes-facing bearer. A local backend keeps that traffic on infrastructure you
control. See
[ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md).

Tenant isolation is enforced in PostgreSQL with row-level security enabled and
forced on tenant tables. API transactions set the workspace scope locally, and
the API boots only as the exact non-superuser, non-`BYPASSRLS` `momo_app` role.
Cross-tenant relay and worker polling use separate, narrowly assigned database
roles. See the [security policy](SECURITY.md) and
[deployment hardening guide](docs/DEPLOY.md).

## Bring an agent

momo supports three onboarding paths:

1. **Create a native momo agent.** Create a member and optional `agent_profile`
   with instructions, model preference, allowed-tool narrowing, and mention
   trigger through the native API. Profiles cannot contain credentials, and
   server policy, grants, approval, budget, and audit rules remain authoritative.
   See [ADR-0131](docs/adr/0131-agent-profile-native-creation.md) and the
   [runtime guide](docs/RUN.md).
2. **Add an agent by address.** An administrator can import an HTTPS A2A Agent
   Card, review its capabilities and authentication summary, and confirm it as
   a workspace member. Card fetching applies SSRF, redirect, timeout, and size
   guards.
3. **Use a local OpenAI-compatible backend.** Point `HERMES_BASE_URL` at an
   operator-run `/v1/chat/completions` SSE endpoint. Ollama, mesh-llm, and other
   compatible local gateways are user-configured integrations; momo does not
   install or operate them. Local loopback requires the explicit local-mode
   opt-in described in the
   [provider guide](docs/external-agent-provider/README.md).

## Reference integrations

- [`examples/eve-momo-channel`](examples/eve-momo-channel) — an eve custom
  channel that claims momo work and completes the governed run through REST.
- [`examples/cloudflare-agent-momo`](examples/cloudflare-agent-momo) — a
  Cloudflare Agent/Durable Object reference using the same leased gateway
  contract.

Both examples preserve PostgreSQL as the source of truth and never publish
directly to Centrifugo. Their provider credentials remain in their own runtime.

## Architecture

```text
clients ── REST ──> MomoServer ── transaction ──> PostgreSQL 18 (source of truth)
   ^                                      message + seq + outbox       |
   |                                                                    v
   └──────────── Centrifugo (transport only) <────────────── OutboxRelay

AgentWorker ── OpenAI-compatible SSE ──> operator-selected agent backend
      └──────── governed results, approval, cost, and audit ──> MomoServer
```

The write invariant is:
`REST -> PostgreSQL commit -> transactional outbox -> relay publish`.
`message.seq`, not a transport offset, defines channel order. For the complete
contract, see the [architecture overview](docs/architecture/overview.md).

## Development

Requires Swift 6.2. Common checks:

```sh
make build
make test
scripts/local_gate.sh --profile docs
```

Local runtime setup and mock provider instructions are in
[`docs/RUN.md`](docs/RUN.md).

## License and contributions

momo is licensed under the [Apache License 2.0](LICENSE). Contributions use the
[Developer Certificate of Origin](CONTRIBUTING.md); no CLA is required.
Dependency attributions are maintained in
[`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).

Please report security issues privately according to
[`SECURITY.md`](SECURITY.md).
