# ADR 0002: Docker Compose Layering for Dev, E2E, Prod, Install, and Backup

> Status: Accepted for roadmap guidance.
> Date: 2026-06-29.
> Related: MOMO-005, MOMO-006, MOMO-007, MOMO-111, MOMO-112, MOMO-115, MOMO-180, MOMO-182, MOMO-186.

## Context

oort now has three deployment-adjacent surfaces that can easily collide if their ownership is not fixed:

- `infra/docker-compose.yml`: current local development/runtime verification stack for PostgreSQL 18 and Centrifugo v6.
- `scripts/local_gate.sh`: local PR gate runner while GitHub Actions remain disabled/manual-only.
- `infra/prod/docker-compose.prod.yml`: staging/prod skeleton with Caddy, PostgreSQL 18, Redis, Centrifugo v6, api, relay, and worker services.

MOMO-005/006/007 prepared the production skeleton, SOPS/age secret lifecycle, pgBackRest PITR skeleton, and `staging-smoke` gate. MOMO-180 then recommended separating Docker/deploy layers into dev/e2e/prod/install/backup. This ADR turns that recommendation into the operating contract for future implementation tickets.

This ADR does not deploy production, publish images, enter real secrets, or rehearse pgBackRest restore. Those remain out of scope for MOMO-182.

## Decision

oort will use five explicit layers:

| Layer | Canonical path | Responsibility | Must not do |
|---|---|---|---|
| dev | `infra/docker-compose.yml` now; future alias `infra/docker-compose.dev.yml` only if useful | Human/Codex local development with worktree-scoped env, host ports, PostgreSQL 18, Centrifugo memory engine, optional mock Hermes. | Do not become the prod deploy file. Do not require image registry access. Do not hide local ports needed by runtime gates. |
| e2e | `infra/docker-compose.e2e.yml` | Deterministic local gate stack for api/relay/worker plus PG/Centrifugo/mock external services, test-only roles, worktree-scoped project/ports, and disposable data. | Do not contain production domains, ACME, host secrets, long-lived volumes, or external billing services by default. |
| prod | `infra/prod/docker-compose.prod.yml` | Image-based self-host staging/prod stack without source checkout on the host. Caddy default TLS, Redis-backed Centrifugo, api/relay/worker images, optional bundled PostgreSQL. | Do not `build:` from repo source on host. Do not expose Postgres/Centrifugo/api ports directly except through Caddy. Do not use dev-insecure secrets. |
| install/upgrade | future `infra/prod/install.sh` and `infra/prod/upgrade.sh` | Host bootstrap, preflight, secret generation/import, compose env creation, image tag pinning, migration, restart, rollback handoff. | Do not commit secrets. Do not perform destructive DB changes without preflight backup and explicit operator confirmation. |
| backup/PITR | `infra/prod/pgbackrest*.example`, `docs/SECRETS_BACKUP_RUNBOOK.md`; future wrapper scripts only around pgBackRest | Scheduled backup, WAL archive, restore rehearsal, PITR evidence. | Do not treat `docker volume` snapshots as sufficient production backup. Do not call backup verified until restore rehearsal passes on a real host. |

`infra/docker-compose.yml` remains the current dev compose file. A future `infra/docker-compose.dev.yml` may be introduced as a rename or thin wrapper, but it must not change the dev contract without a separate migration ticket and docs update.

## Layer Boundaries

### Dev Compose

`infra/docker-compose.yml` is for local iteration and local runtime verification.

Required properties:

- Uses official base services: `postgres:18` and `centrifugo/centrifugo:v6`.
- Exposes host ports through `.env.worktree` / `.conductor/setup.sh` so parallel worktrees do not collide.
- Uses Centrifugo memory engine.
- Keeps api/relay/worker outside compose by default so Swift packages can be run with `swift run` during development.
- May add optional profiles later for mock Hermes or convenience services, but those profiles must remain dev-only.

Validation:

- `make up`, `make migrate`, runtime gate profiles such as `runtime-db`, `runtime-relay`, and `runtime-agent`.
- No production secret or domain is allowed in this layer.

### E2E Compose

`infra/docker-compose.e2e.yml` is the MOMO-186 local gate layer. Its purpose is reproducible local-gate runtime evidence, not day-to-day development and not production. It keeps the source-checkout-based Swift build path legal for local verification while preserving the production rule that hosts pull images instead of building from repo source.

Implemented properties:

- Runs the intended full product boundary locally: api, relay, worker, PostgreSQL, Centrifugo, deterministic mock OpenAI-compatible/Hermes gateway, migration job, and e2e DB role bootstrap.
- Uses `.env.worktree`/`COMPOSE_PROJECT_NAME` for worktree-scoped project names and host ports.
- Uses deterministic test-only roles: `momo_app` for tenant API traffic and `momo_relay`/`momo_worker` as BYPASSRLS background pollers.
- Allows source checkout + local Swift build caches in named volumes for e2e only; prod remains image-based.
- Keeps external network calls disabled by default. The mock Hermes service is repo-local `scripts/mock_hermes.py`.

Static validation:

```sh
docker compose --env-file .env.worktree -f infra/docker-compose.e2e.yml config
```

Expected runtime validation profiles:

- `runtime-db`: migrate, RLS, roster, join, platform admin, approval decision.
- `runtime-relay`: REST send, outbox pending, relay claim, Centrifugo history, outbox done.
- `runtime-agent`: mock SSE, `agent.partial`, cost reserve/reconcile, approval resume.

### Prod Compose

`infra/prod/docker-compose.prod.yml` is the staging/prod skeleton. Its default target is a single VPS, but it must be compatible with later split-managed services.

Required properties:

- Uses `image:` for `api`, `relay`, and `worker`. Production hosts pull pinned images; they do not build from source checkouts.
- Exposes only Caddy HTTP/HTTPS ports to the public network. Postgres, Redis, Centrifugo, api, relay, and worker stay on compose private networks.
- Uses Caddy as the default TLS termination layer.
- Uses Redis-backed Centrifugo for production presence/history/recovery.
- Uses SOPS/age or host-local secret injection. `infra/prod/.env.example` is only a shape file.
- Runs migrations as an explicit operator step before or during upgrade, not as a hidden side effect of every app boot.

Image tags must be pinned by release version plus immutable digest when the publish pipeline exists, for example:

```text
ghcr.io/dawn-kim-official/momo-api:0.1.0@sha256:...
ghcr.io/dawn-kim-official/momo-relay:0.1.0@sha256:...
ghcr.io/dawn-kim-official/momo-worker:0.1.0@sha256:...
```

The mutable tags `latest`, branch names, and local `build:` blocks are acceptable for dev/e2e only.

### Install And Upgrade

Future install/upgrade scripts are operational wrappers around the prod compose contract.

`infra/prod/install.sh` should eventually:

- Verify Docker Compose v2, DNS, ports 80/443, disk space, and required commands.
- Ask the operator to choose bundled PostgreSQL or external PostgreSQL.
- Ask the operator to choose Caddy-managed TLS or externally terminated TLS.
- Generate high-entropy secrets or import SOPS-managed secrets.
- Write a host-local env file outside the repo checkout, or run via `sops exec-env`.
- Pull pinned images and run `docker compose config --quiet`.
- Run migrations explicitly and start services.
- Print post-install checks without claiming full runtime PASS until host health, TLS, backup, and external Hermes choices are verified.

`infra/prod/upgrade.sh` should eventually:

- Capture current image tags, env fingerprint, and compose config.
- Require a successful pre-upgrade backup or an explicit dry-run-only mode.
- Pull new pinned images.
- Run migrations once with `scripts/migrate.sh` or the eventual migration image.
- Restart api/relay/worker with minimal downtime.
- Provide rollback instructions to the previous pinned image set.

The first implementation should prefer simple bash with strict preflight over a large installer framework.

### Backup And PITR

Production backup is pgBackRest PITR, not a convenience volume copy.

Required properties:

- Continuous WAL archive plus scheduled full/differential backups.
- Encrypted backup repository.
- Restore rehearsal evidence before backup is called production-verified.
- Explicit status language: `runtime-unverified` until a real host performs stanza/check/full backup/PITR restore.

The current skeleton lives in:

- `infra/prod/pgbackrest.conf.example`
- `infra/prod/postgresql.pgbackrest.conf.example`
- `infra/prod/pgbackrest-cron.example`
- `docs/SECRETS_BACKUP_RUNBOOK.md`

Future wrapper scripts may improve ergonomics, but pgBackRest remains the source of truth for backup/PITR behavior.

## Optional Production Choices

### External PostgreSQL

Default self-host prod uses the bundled `postgres` service. External PostgreSQL is allowed when the operator wants managed backups, higher availability, or a preexisting database boundary.

Rules:

- `DATABASE_URL` and `RELAY_DATABASE_URL` point at the external database.
- The bundled `postgres` service is disabled by a compose profile or alternate override, not by editing the canonical prod file in place.
- RLS invariants remain unchanged: api uses ordinary app role with `SET LOCAL app.workspace_id`; relay/worker use BYPASSRLS role only for background polling.
- Migration and backup responsibility must be reassigned in the install checklist.

### External TLS Or Load Balancer

Caddy-managed TLS is the default because it keeps the single-VPS path simple. External TLS is allowed for enterprise or cloud deployments.

Rules:

- The external proxy terminates TLS and forwards to Caddy or directly to api/Centrifugo on the private network.
- WebSocket/SSE upgrade behavior for Centrifugo must be preserved.
- Public routes remain `api.<domain>` for REST and `rt.<domain>` for realtime unless a later ADR changes the client contract.
- Subscribe proxy stays internal: Centrifugo calls `http://api:8080/v1/centrifugo/subscribe`.

### Agent Runtime

The product default remains:

- `AgentWorker` inside oort prod compose.
- External OpenAI-compatible/Hermes gateway configured by `HERMES_BASE_URL` and `HERMES_API_KEY`.

Optional local or separately hosted agent runtimes are allowed later if they preserve the same OpenAI-compatible streaming contract and approval/cost/audit semantics. They must not publish directly to Centrifugo or bypass the canonical Postgres/outbox write path.

## Follow-Up Implementation Tickets

- `MOMO-186`: introduce `infra/docker-compose.e2e.yml` with api/relay/worker/mock-Hermes deterministic local gate stack.
- `MOMO-187`: image build/publish plan for api/relay/worker with pinned tags and digest recording.
- `MOMO-188`: prod `install.sh` preflight and host-local env/SOPS integration.
- `MOMO-189`: prod `upgrade.sh` with pre-upgrade backup check, migration, restart, rollback notes.
- `MOMO-190`: backup/PITR restore rehearsal evidence path for staging host.
- `MOMO-191`: optional external PostgreSQL/TLS compose override and documentation.

Ticket numbers are planning placeholders until GitHub issues are created.

## Consequences

Positive:

- Dev, e2e, and prod can evolve without hidden assumptions leaking across layers.
- Production self-hosting can be image-based and source-checkout-free.
- Runtime gates remain deterministic and cheap while GitHub Actions are disabled/manual-only.
- Backup claims are tied to restore evidence instead of config presence.

Tradeoffs:

- There are more compose surfaces to maintain once e2e is introduced.
- Install/upgrade scripts become real product surfaces and need careful review.
- External DB/TLS choices add matrix complexity, so they remain optional until the default single-VPS path is stable.

## Non-Goals

- Implement production deployment.
- Publish container images.
- Implement `install.sh` or `upgrade.sh`.
- Run pgBackRest full restore rehearsal.
- Enter staging/prod secrets.
- Reactivate GitHub Actions.
