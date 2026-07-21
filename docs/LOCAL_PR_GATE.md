# Local PR Gate

> Purpose: keep PR quality high while GitHub Actions are not the primary merge gate.
> Scope: local developer/Codex validation before PR, after review, and after merge to `main`.

## 0. Current Status

As of 2026-06-26, GitHub Actions are disabled manually for `Dawn-kim-official/momo`
because the organization is seeing billing/payment failures and should not spend
paid macOS runner minutes during active development.

- Remote workflow state must stay `disabled_manually` unless the owner explicitly approves re-enabling it.
- Repo workflow files are manual-only (`workflow_dispatch`) so a future re-enable cannot start jobs from every push, PR, or tag.
- The merge gate during this period is local evidence + review pass + no unrelated dirty files.
- Workers use local evidence to open a PR and hand it off; workers do not merge. `momo-main` owns review, final local gate, merge, issue close, and post-merge `main` verification.
- Do not wait for GitHub Actions green during this period; record `Actions disabled by policy` in PR evidence when relevant.

## 1. Rule

Every PR needs local evidence in the PR body:

- date and machine/toolchain summary,
- commands executed,
- pass/fail result,
- runtime scope that was actually exercised,
- anything intentionally not covered.

Do not mark runtime work complete if the runtime script was not run.

## 2. Standard Script

Run from repo root:

```bash
scripts/local_gate.sh --profile docs
```

`scripts/local_gate.sh --auto` picks the profile from changed paths
(`git diff --name-only <base>...HEAD` + uncommitted changes, base =
`LOCAL_GATE_BASE_REF`/`origin/main`, falling back to local `main`) with a
conservative mapping — ambiguous paths widen to `all`, never narrow — and
records the suggested profile plus per-path reasons in the evidence markdown.
An explicit `--profile` always wins over `--auto`.

The script writes a log and Markdown evidence file under
`${TMPDIR:-/tmp}/momo-local-gate` by default, then prints a PR-ready
`## Local Gate` block to stdout. Filenames include the profile, UTC second,
process id, nanosecond timestamp, worktree hash, and random suffix, for example
`local-gate-docs-20260629T120000Z-pid1234-ns1780000000000000000-wtab12cd34ef56-r98ab76cd54ef.md`.
This keeps evidence paths collision-safe when the same profile runs in parallel
from multiple worktrees. Use `--output-dir <dir>` or `LOCAL_GATE_OUT_DIR=<dir>`
when you need a stable parent directory for local evidence files.

Before `runtime-db`, `runtime-relay`, `runtime-live`, or `runtime-agent`
starts, the script enforces the host resource threshold defined in
[`MULTI_SESSION_OPS.md` §9](MULTI_SESSION_OPS.md#9-resource-governance-호스트-부하-규칙--2026-07-17-발열-사고-후-정본):
load(1min) greater than 12 stops the run with a warning. After checking the
host and accepting the risk, an operator may explicitly override that stop
with `LOCAL_GATE_FORCE=1`.

Those runtime profiles also take down the main worktree Compose project on
success, failure, or interruption after `make up` starts. Use `--keep-stack`
only when the stack is intentionally needed for debugging; the evidence format
and PASS criteria are unchanged by this resource cleanup.

Profiles:

| Profile | Use when | What it runs |
|---|---|---|
| `docs` | docs/spec/script-only changes, including internal alpha runbook/feedback/AWS topology updates | whitespace diff, workflow YAML parse, actionlint if installed, e2e compose config, AWS internal alpha topology preflight fixture, JSON syntax, shell syntax, Python syntax, Hermes adapter smoke |
| `swift` | Swift package/model/view changes | `docs` profile + design pre-flight ratchet (`scripts/verify_design_preflight.sh`) + `make build` + `make test` |
| `diagnostics` | diagnostics/observability bundle changes | `docs` profile + `scripts/collect_diagnostics.sh --smoke` redaction check |
| `staging-smoke` | staging/prod/internal-hosting config or runbook changes that do not have real VPS secrets | `docs` profile + `scripts/verify_staging_smoke.sh` + `scripts/verify_internal_hosting_smoke.sh` for prod compose config, internal single-node smoke overlay, Caddyfile structure, Centrifugo Redis config, API health route wiring, relay/worker enablement, secret-template guard, public/staging preflight evidence markdown/json, and SOPS/pgBackRest checklist |
| `backup` | backup/PITR runbook or internal hosting changes that must prove restore rehearsal evidence before review | `docs` profile + `scripts/verify_backup_restore_rehearsal.sh` for temporary PostgreSQL 18 source DB marker writes, `pg_dump -Fc`, separate restore DB `pg_restore`, marker checksum equality, and markdown/json evidence generation |
| `host-runtime` | internal single-node host-runtime smoke before internal test hosting | `docs` profile + `scripts/verify_internal_host_runtime.sh` + `scripts/verify_backup_restore_rehearsal.sh`; proves local image prod+internal-smoke boot/health/agent-runtime-status redaction/migrate/message/relay/mock-agent and repo-local restore evidence |
| `local-alpha` | AWS 전 1인 local Docker alpha RC gate | `docs` profile + host-runtime boot/health/migrate/message/relay/mock Kim Intern + backup restore rehearsal + macOS real-backend smoke + redacted diagnostics bundle in one `local-alpha-<run-id>/` packet; add `LOCAL_GATE_LAUNCH_UI=1` for foreground MomoMacDevApp process/window/log evidence |
| `internal-alpha` | internal alpha evidence packet before reviewer handoff | `docs` profile + host-runtime image boot/health/migrate/message/relay/mock Kim Intern evidence + backup restore rehearsal + `LOCAL_GATE_LAUNCH_UI=1` MomoMacDevApp real-backend process/window evidence + redacted diagnostics bundle |
| `runtime-db` | migrations/server/RLS/join changes | `swift` profile + `make up` (compose `--wait`) + `make migrate` (single run: apply + idempotency verify pass with `IDEMPOTENCY_OK` marker) + `scripts/verify_rls.sh` + `scripts/verify_join.sh` + `scripts/verify_push_registration.sh` + `scripts/verify_push_notifier.sh` + `scripts/verify_plugin_registry.sh` + `scripts/verify_signed_webhook_ingress.sh` + `scripts/verify_drive_mcp.sh` + `scripts/verify_attachment_upload.sh` (both stub-only; no Google call) |
| `runtime-relay` | outbox/relay/realtime changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_relay.sh` for server send, outbox pending, relay claim, Centrifugo history, outbox done, and `version=message.seq` evidence |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `swift` profile + Docker/migration bootstrap + host MomoServer/OutboxRelay + compose-network `api:8080` proxy + `scripts/verify_realtime_live.sh` for token issuance, subscribe, REST send, live `message.new`, `payload.message.seq`, and invalid token rejection evidence |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_agent_worker.sh` + `scripts/verify_agent_live_channel.sh` |
| `external-agent-provider` | real external agent runtime credentialed smoke, opt-in only | `docs` profile + `scripts/verify_local_hermes_credentialed_smoke.sh`; with credentials it delegates to the external verifier, checks OpenAI-compatible SSE, `/v1/agent-runtime/status` redaction/degraded reason, Hermes active agent + `#agent-lab` invite precondition, and one local MomoServer/AgentWorker/OutboxRelay `@hermes` roundtrip; without credentials it writes `NEEDS_USER_CREDENTIAL` / `runtime-unverified(external provider credentials)` evidence |
| `macos-ui` | MomoMac UI/run changes | `swift` profile + `MomoMacSmoke`; set `LOCAL_GATE_LAUNCH_UI=1` to run `scripts/macos_dev_run.sh --verify --logs --terminate` |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `swift` profile + Docker/migration bootstrap + `verify_agent_worker.sh` D/B evidence + `verify_approval_decision.sh` C evidence + `verify_macos_real_backend_ui.sh` |
| `web-serving` | `infra/prod/Dockerfile.web`, prod Caddy/compose, or APP_DOMAIN serving verifier changes | `docs` static checks + `scripts/verify_web_serving.sh`; isolated e2e `web` profile on ports 28070-28074, real Vite dist via web-init named volume, HTTP SPA/proxy/security-header six-assertion gate. Public DNS/ACME/TLS is excluded. |
| `web` | `clients/web`, `docs/api/openapi.yaml`, or web serving/smoke script changes | worktree-clean + `npm ci` + `npm run lint` + `npm run test` (Vitest) + `npm run typecheck` + generated-types sync check (openapi-typescript output vs committed `src/api/schema.d.ts`) + `npm run build` + permissive-only license gate (full transitive inventory markdown) + `scripts/web_serving_smoke.sh` + `scripts/verify_web_login_smoke.sh` (e2e compose Chromium login→timeline→realtime) + `scripts/verify_openapi_contract.sh` runtime drift gate |
| `all` | merge-critical/runtime-wide changes | broad static/Swift/runtime DB/relay/agent/macOS gate in one run, with shared bootstrap deduped except migration idempotency; run `runtime-live` separately for WebSocket live evidence because it starts host API/relay processes and a compose-network proxy |

Examples:

```bash
scripts/local_gate.sh --profile swift
scripts/local_gate.sh --profile diagnostics
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile backup
scripts/local_gate.sh --profile host-runtime
scripts/local_gate.sh --profile local-alpha
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile local-alpha
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha
scripts/local_gate.sh --profile runtime-live
scripts/local_gate.sh --profile runtime-agent
scripts/local_gate.sh --profile external-agent-provider
scripts/verify_local_hermes_credentialed_smoke.sh
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui
scripts/local_gate.sh --profile m3-dbc
scripts/local_gate.sh --profile web-serving
scripts/local_gate.sh --profile web
scripts/local_gate.sh --profile docs --output-dir /tmp/momo-local-gate
```

### OpenAPI contract drift gate (MOMO-389)

`docs/api/openapi.yaml` is the canonical web v0 client contract (ADR-0119
D4-A): login/refresh/logout, `/v1/join`, realtime-token, roster (+`/members`
alias), channels (list/create), messages (send/history incl. `?after=<seq>`
backfill), read-state (bulk GET + cursor PUT), dms (list/open), and approvals
(list/decision). Any PR that touches `docs/api/openapi.yaml`, the DTOs or
handlers behind that surface, or a client generated from the spec must run:

```bash
scripts/verify_openapi_contract.sh
```

The gate boots an isolated e2e compose stack (`infra/docker-compose.e2e.yml`)
under its own compose project (default `momo389gate`) on non-default host
ports (`18980`-`18983`), installs disposable fixtures (a dedicated gate
member, one invite code, one pending approval — seed rows are not mutated),
samples **every operation documented in the spec** against the live server,
and validates each response with `scripts/openapi_shape_check.py`: required
keys, types, enums, UUID format, no unexpected `null`s, and a closed-world
key check — a response key the spec does not declare fails as drift, and a
spec operation without a live sample fails operation coverage. The intended
workflow is spec-first: a PR that adds or changes a response field on a
documented route must update `docs/api/openapi.yaml` in the same PR, or this
gate fails. The stack is
torn down afterwards; it never touches containers from other compose
projects. Overrides: `OPENAPI_GATE_PORT` / `OPENAPI_GATE_POSTGRES_PORT` /
`OPENAPI_GATE_CENT_PORT` / `OPENAPI_GATE_HERMES_PORT` (host port conflicts),
`OPENAPI_GATE_COMPOSE_PROJECT`, `OPENAPI_GATE_BOOT_TIMEOUT` (the api
container cold-builds MomoServer on first run; allow many minutes),
`OPENAPI_GATE_KEEP=1` (keep the stack for debugging).

To verify an already-running **disposable** stack instead of booting one
(fixtures write rows into it):

```bash
BASE_URL=http://127.0.0.1:18980 \
OPENAPI_GATE_DATABASE_URL=postgres://momo:...@127.0.0.1:18981/momo \
scripts/verify_openapi_contract.sh
```

The `docs` profile statically checks the spec parse and both gate scripts.
The runtime drift gate is wired into the `web` profile (MOMO-391) and also
runs standalone with the command above.

### Push device registration gate (MOMO-403, ADR-0120 P-1)

`scripts/verify_push_registration.sh` is the runtime gate for the APNs
device/push_token registration REST (`DeviceRoutes.swift`). It boots an
isolated e2e compose stack (project `momo403push`, loopback ports
`19500`-`19503`, `api` service only — a single in-container cold Swift build,
inheriting the MOMO-401 staggered-boot memory guard), installs disposable
member fixtures in the demo workspace plus a second fixture tenant, and
asserts: register 201 with suffix-only receipt (the raw hex `apns_token`
never appears in any response body or `audit_log.detail`), idempotent
re-registration with token rotation (exactly one ACTIVE token per
device+env — 010 partial unique index; invalidated rows preserved for
`push_dispatch_log`), own-devices-only listing, actor-binding 403s (another
member's device or active token), cross-tenant 403 (workspace scope
mismatch) and 409 (RLS-invisible token conflict), revoke as
`invalidated_at` (no row deletion; idempotent; 404 unknown),
invalidated-token reclaim (account switch), same-transaction audit rows,
and `momo_app` RLS isolation for `device`/`push_token`. Wired into the
`runtime-db` profile; also runs standalone. Overrides: `PUSH_GATE_PORT` /
`PUSH_GATE_POSTGRES_PORT` / `PUSH_GATE_CENT_PORT` / `PUSH_GATE_HERMES_PORT`,
`PUSH_GATE_PROJECT`, `PUSH_GATE_BOOT_TIMEOUT`, `PUSH_GATE_KEEP=1`.

### Push notifier gate (MOMO-404, ADR-0120 P-2)

`scripts/verify_push_notifier.sh` is the runtime gate for the server-side
push pipeline: the 011 message trigger (durable `outbox
kind='push_candidate'` rows in the same tenant transaction), the
`workers/NotifierWorker` consumer (judgment v0 = every DM message +
server-recomputed mention projection + approval requests — the only place
judgment lives), `push_dispatch_log` idempotent dispatch records, and the
id-only relay payload (ADR-0120 D2). It boots an isolated e2e compose stack
(project `momo404notif`, loopback ports `19600`-`19604`, `--profile push` +
`infra/e2e/push-notifier.overlay.yml` for `AGENT_GATEWAY_MODE=gateway`)
with three staggered cold Swift builds (api → relay → notifier; MOMO-401
memory guard), registers devices through the MOMO-403 REST (no SQL-inserted
devices), raises one DM, one mention, and one gateway-REST approval request,
and asserts: dispatch-log contract rows (`member`/`push_token`/
`collapse_id`/`apns_status`), author and agent-recipient exclusion, the
id-only hard contract on every mock-relay payload (message bodies, display
names, handles, and approval summaries are absent; only the allowed
routing/identity key set appears), restart sweep + live redelivery with zero
duplicate dispatches, relay `broadcast` / gateway `agent_job` lifecycles
untouched (kind-scoped consumer mutual exclusion), the `momo_notifier`
BYPASSRLS session, and 011 enum/trigger/index presence. Wired into the
`runtime-db` profile; also runs standalone. Overrides: `PUSH_NOTIF_PORT` /
`PUSH_NOTIF_POSTGRES_PORT` / `PUSH_NOTIF_CENT_PORT` /
`PUSH_NOTIF_HERMES_PORT` / `PUSH_NOTIF_RELAY_PORT`, `PUSH_NOTIF_PROJECT`,
`PUSH_NOTIF_BOOT_TIMEOUT`, `PUSH_NOTIF_WAIT_TIMEOUT`, `PUSH_NOTIF_KEEP=1`.

### Plugin registry gate (MOMO-410, ADR-0113 SE-04A)

`scripts/verify_plugin_registry.sh` boots an isolated e2e API stack (project
`momo410plugins`, loopback ports `19800`-`19803`) and verifies the official
GitHub/Notion/Linear manifest seeds plus the `external_webhook` registry marker,
D6 three-layer manifest fields and
`egressDomains`, whitelist validator failures (unknown protocol/risk/approval
policy, GPL, malformed document, digest mismatch, revoked catalog entry),
active-member catalog reads, owner/admin install policy, delegated user's
`(workspace, member, plugin, scope)` grant, same-transaction audit rows, and
immediate Capability Cache projection removal on grant/install revocation. It
also injects a raw credential-shaped marker and proves it appears in no plugin
table, response, or `audit_log.detail`, then checks cross-workspace 403 and
FORCE RLS isolation. Wired into `runtime-db`; also runs standalone. Overrides:
`PLUGIN_GATE_PORT` / `PLUGIN_GATE_POSTGRES_PORT` / `PLUGIN_GATE_CENT_PORT` /
`PLUGIN_GATE_HERMES_PORT`, `PLUGIN_GATE_PROJECT`, `PLUGIN_GATE_BOOT_TIMEOUT`,
`PLUGIN_GATE_KEEP=1`.

### Hosted Drive MCP gate (MOMO-457, ADR-0113 SE-04D)

`scripts/verify_drive_mcp.sh` boots an isolated e2e API stack with the explicit
local-only stub backend. It verifies Drive manifest seeding, hosted endpoint
absolute descriptor assembly, agent bearer + delegated channel binding,
install/grant, MCP initialize/tools.list and all three read-only tools.call
operations, revoke fail-closed behavior, success/denial audit rows, and
credential-shaped response redaction. It never calls Google; real SA smoke is
the manual evidence in `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`. Wired into
`runtime-db`; also runs standalone.

### Attachment archive gate (MOMO-474/521, ADR-0127)

`scripts/verify_attachment_upload.sh` defaults to the existing isolated Drive
stub stack. `ATTACHMENT_GATE_BACKEND=s3` enables the compose MinIO profile on
the reserved 28040–28044 band. Both modes verify session issuance, direct
client PUT, HEAD/Drive metadata completion, uploader-only attachment binding
inside the canonical message transaction, audit rows, authorized streaming
content or presigned GET redirect, non-member 403, URL/credential absence from
logs and ledgers, an abandoned pending row, the 100 MB ceiling, and FORCE RLS
isolation. It never receives a Google SA key. Real shared-drive smoke remains
an orchestrator-only step. Both modes are wired into `runtime-db`; also run
standalone. Overrides: `ATTACHMENT_GATE_BACKEND=drive|s3`, `ATTACHMENT_GATE_PORT` /
`ATTACHMENT_GATE_POSTGRES_PORT` / `ATTACHMENT_GATE_CENT_PORT` /
`ATTACHMENT_GATE_HERMES_PORT` / `ATTACHMENT_GATE_MINIO_PORT`, `ATTACHMENT_GATE_PROJECT`,
`ATTACHMENT_GATE_BOOT_TIMEOUT`, `ATTACHMENT_GATE_KEEP=1`.

### Signed webhook ingress gate (MOMO-412, ADR-0115 SE-04B)

`scripts/verify_signed_webhook_ingress.sh` boots an isolated e2e API stack
(project `momo412webhook`, loopback ports `19900`-`19903`) and verifies native
HMAC forgery/replay/stale timestamp/cross-workspace rejection, deterministic
receipt idempotency, old/new key overlap and zero-overlap rotation, revoke, and
the single tenant transaction from receipt through `message.seq` and outbox.
It also round-trips the Mattermost-compatible Slack `text` + legacy attachment
fixture (`<url|text>`, member mention, `<!channel>`), asserts `blocks` and `ts`
return explicit 400 errors, and proves raw native/URL secrets are absent from
tables, list/ingress/revoke responses, audit detail, and request logs. All three
new tables are checked for FORCE RLS isolation. Wired into `runtime-db`; also
runs standalone. Overrides: `WEBHOOK_GATE_PORT` /
`WEBHOOK_GATE_POSTGRES_PORT` / `WEBHOOK_GATE_CENT_PORT` /
`WEBHOOK_GATE_HERMES_PORT`, `WEBHOOK_GATE_PROJECT`,
`WEBHOOK_GATE_BOOT_TIMEOUT`, `WEBHOOK_GATE_KEEP=1`.

### Web client gate (`web` profile, MOMO-391 + MOMO-400 + MOMO-401)

`scripts/local_gate.sh --profile web` is the merge gate for `clients/web`
and web-serving changes (ADR-0119 W-2/W-4). Steps, in order:

1. worktree-clean guard, `npm ci`, `eslint`, `tsc --noEmit` inside
   `clients/web`.
2. Generated-types sync: `npm run generate:types` re-renders
   `src/api/schema.d.ts` from `docs/api/openapi.yaml` and the gate fails if
   the committed file differs — spec changes and client types cannot drift
   apart in one PR.
3. `vite build` (production bundle must stay CSP-safe: no inline script;
   ADR-0119 permits inline style, and the browser smoke enforces the policy).
4. License gate: `clients/web/scripts/check-licenses.mjs` walks the full
   installed transitive closure from `package-lock.json`, fails on anything
   outside the permissive allowlist (MIT/Apache-2.0/ISC/BSD family;
   dev-only reviewed exceptions BlueOak-1.0.0 and Python-2.0), and writes a
   Markdown license inventory to the gate output dir — attach it to the PR.
5. `scripts/web_serving_smoke.sh` — MOMO-390 regression: Caddyfile parse
   matrix, SPA fallback, `/v1` proxy wiring, centrifugo edge 403, strict
   CSP headers, and the APP_DOMAIN-unset sentinel fail-closed ordering
   (guard evaluated before the proxy — PR #403 review Medium-1).
6. `scripts/verify_web_login_smoke.sh` — boots an isolated e2e compose
   stack (project `momo391web`, loopback ports `18990`-`18995`), serves the
   built SPA through the real prod Caddyfile, and drives headless Chromium
   (playwright) through login (workspace empty → demo fallback) → channel
   list → timeline display of REST-seeded messages → wss realtime subscribe
   under the strict CSP → a REST-sent message rendered live through
   REST → PG → outbox → relay → Centrifugo → browser, plus REST `?after=`
   catch-up evidence and zero CSP console violations. MOMO-400 extends the
   same run with: composer `clientMsgId` idempotency (first send forwarded
   to the server but answered 500; the retry must reuse the SAME
   `clientMsgId` and leave exactly one DOM render and one committed row),
   the read-state rail (bulk GET badge init; an EXTERNAL cursor PUT clears
   the badge through the `user:read-state#<member-id>` push with zero
   further read-state GETs; browser cursor PUTs asserted strictly
   monotonic), ADR-0112 approval cards (no tool JSON/cost leakage;
   in-browser approve → receipt 200; an externally pre-decided approval →
   409 receipt handled as a card state transition, not an error), and DM
   open via `POST /dms` + composer round-trip + `GET /dms` listing.
   MOMO-401 extends the same run with the invite web join (ADR-0121 D2-B):
   a disposable admin issues invites over REST
   (`POST /v1/workspaces/:ws/invites` — smoke tooling, not web-client
   surface), one invite is expired by fixture SQL and one exhausted through
   a real `POST /v1/join`; a fresh browser context then opens
   `/join/<code>`, asserts the code is stripped from the address bar
   (history.replaceState) and never appears in any non-document request URL
   or console line, joins through the form (session established from the
   JoinResponse token pair — the spec'd join-login path), enters the
   #general timeline, logs out and re-logs-in with the join-created
   credentials, and finally checks that expired / exhausted / invalid codes
   each render their own Korean error copy (`data-error-kind`). First
   run downloads the playwright Chromium build (cached) and cold-builds
   the api/relay Swift containers — allow many minutes. Overrides:
   `WEB_LOGIN_SMOKE_PORT`/`..._POSTGRES_PORT`/`..._CENT_PORT`/
   `..._HERMES_PORT`/`..._EDGE_HTTPS`/`..._EDGE_HTTP` (port conflicts),
   `WEB_LOGIN_SMOKE_PROJECT`, `WEB_LOGIN_SMOKE_BOOT_TIMEOUT`,
   `WEB_LOGIN_SMOKE_KEEP=1`.
7. `scripts/verify_openapi_contract.sh` — the MOMO-389 runtime drift gate
   (its own isolated stack, see above).

CSP contract note: the web client uses centrifuge-js in websocket-only
transport mode. The serving CSP allows `connect-src 'self'` plus
`wss://REALTIME_DOMAIN` and `https://REALTIME_DOMAIN`. Adding another fallback
transport requires updating the Caddyfile CSP and the
`scripts/web_serving_smoke.sh` expectations in the same PR.

`staging-smoke` now exercises `scripts/prod_env_preflight.sh --evidence-dir` in
two ways: tracked example staging env must fail-fast on placeholders, while a
synthetic non-placeholder public/staging env shape must pass and write
`prod-env-preflight-staging.md` plus `.json`. This proves DNS/TLS/registry/
SOPS/volume/pgBackRest required env coverage for PR review without touching a
real host.

MOMO-406 adds `scripts/verify_prod_install_upgrade.sh` to the same profile. It
uses a fake Docker command and synthetic non-secret env to cover the
non-interactive argument matrix, strict per-service `@sha256` pins, preflight
wiring, compose-config invocation, install/migrate ordering, backup-evidence
gate, sequential upgrade, and previous-image app rollback. It does not start a
container. `scripts/verify_staging_smoke.sh` still performs the real
`docker compose config --quiet` render; the orchestrator records that Docker
gate separately.

For the external provider profile, keep stack ports in `.env.worktree` and pass
only momo-facing provider endpoint/key values through the shell or, preferably,
a separate untracked file. Codex/OpenAI OAuth login and provider API keys stay
inside the provider runtime:

```bash
AGENT_PROVIDER_MODE=external-hermes \
HERMES_BASE_URL=https://hermes.example.com/v1 \
HERMES_API_KEY=... \
scripts/local_gate.sh --profile external-agent-provider

EXTERNAL_AGENT_PROVIDER_ENV_FILE=/secure/momo/external-hermes.env \
scripts/local_gate.sh --profile external-agent-provider

# preferred local Hermes/Codex-OAuth dogfood wrapper
scripts/verify_local_hermes_credentialed_smoke.sh
LOCAL_HERMES_PROVIDER_ENV_FILE="$HOME/.momo/local-hermes-provider.env" \
  scripts/verify_local_hermes_credentialed_smoke.sh

scripts/local_alpha_runner.sh execute \
  --hermes external \
  --external-smoke \
  --secret-env /secure/momo/external-hermes.env

# local-only OpenAI-compatible provider loopback smoke
MOMO_ENV=local \
AGENT_PROVIDER_MODE=external-hermes \
AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1 \
HERMES_BASE_URL=http://127.0.0.1:${HERMES_PORT:-8088}/v1 \
HERMES_API_KEY=local-hermes-bearer \
AGENT_MODEL=gpt-via-local-hermes \
scripts/local_gate.sh --profile external-agent-provider
```

The wrapper/verifier never prints the API key. If no out-of-repo provider env
file or inline momo-facing endpoint/key is configured, the profile exits
successfully with explicit `NEEDS_USER_CREDENTIAL` /
`runtime-unverified(external provider credentials)` evidence so default mock
runtime gates remain deterministic. If `AGENT_PROVIDER_MODE=external-hermes` is
set but the URL/key is missing, placeholder-like, mock, or a non-loopback
`http://...` URL, the profile fails fast because that is a misconfigured
credentialed smoke. `http://127.0.0.1:<port>/v1` and
`http://localhost:<port>/v1` are allowed only with
`MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`; staging/prod/internal-host
still reject loopback. In the credentialed path, `/v1/agent-runtime/status`
must report `available` with no `degradedReason`; failures keep a redacted
category/reason in evidence. The same verifier creates its own isolated Hermes
member/channel fixture and proves the invite precondition there. It does not
depend on or mutate persistent dogfood roster data.

Codex OAuth tokens are intentionally not part of this profile. If Hermes/Kim
Intern uses Codex OAuth, configure authorization code exchange, access/refresh
token storage, refresh, unlink, and rotation inside the provider host. The momo
smoke process accepts only `HERMES_API_KEY` for the provider SSE boundary and
fails fast if known Codex/OpenAI OAuth token or API key env var names are
present. The MOMO-257 local setup runbook is
[`docs/external-agent-provider/local-hermes-codex-oauth-setup.md`](external-agent-provider/local-hermes-codex-oauth-setup.md),
the local loopback provider contract is
[`docs/external-agent-provider/local-hermes-gpt.md`](external-agent-provider/local-hermes-gpt.md),
and the credential boundary ADR is
[`docs/adr/0004-codex-oauth-hermes-provider-boundary.md`](adr/0004-codex-oauth-hermes-provider-boundary.md).

The default script is strict: PR evidence should come from a clean worktree and
checks committed whitespace against `${LOCAL_GATE_BASE_REF:-origin/main}` plus
staged/unstaged diffs. For exploratory pre-commit runs only, use
`LOCAL_GATE_ALLOW_DIRTY=1`; do not paste that as final merge evidence.

Backup/PITR PRs must use `backup` or a profile that includes it. The local
profile proves only the repo-local dump/restore contract and writes separate
restore evidence markdown/json; production pgBackRest stanza/check/full backup,
WAL archive push, SOPS decrypt, object-store repo, and time-target PITR remain
`runtime-unverified(public host)` until a real restore host/volume rehearsal is
attached.

For internal alpha incident handoff, collect a redacted diagnostics bundle:

```bash
scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m
```

The collector writes a directory, `summary.md`, and a `.tar.gz` archive. It is
best-effort by design: stopped Docker services, missing macOS logs, or absent
local gate evidence are recorded in the bundle instead of failing collection.
Secrets, passwords, API keys, bearer/JWT-shaped tokens, and database URL
credentials are redacted before files are written.

For raw internal alpha feedback, file GitHub's `Internal alpha feedback`
template or normalize the report with
[`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md). Feedback intake
issues start at `status:needs-triage`; momo-main adds severity, evidence,
labels, milestone, and a buildable goal before a worker claims them.

Before creating AWS resources for a one-person alpha RC, use the local Docker
RC packet:

```bash
scripts/local_gate.sh --profile local-alpha
```

This profile does not call AWS APIs or require public DNS/TLS. It writes a
run-specific `local-alpha-<run-id>/` packet with host-runtime boot/health/
migrate/message/relay/mock Kim Intern evidence, backup restore rehearsal,
macOS real-backend smoke, and a redacted diagnostics bundle. The default keeps
foreground GUI launch optional so it can run from a background Codex session.
Add `LOCAL_GATE_LAUNCH_UI=1` when the gate must prove `MomoMacDevApp`
process/window/log launch against the local MomoServer too.

For internal alpha reviewer handoff, use the stricter combined packet instead
of pasting separate host/runtime/UI/diagnostics snippets:

```bash
LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha
```

The profile requires foreground GUI permission because it must launch
`MomoMacDevApp` against a real local MomoServer and record process/window
evidence. It writes verifier artifacts under a run-specific directory below the
local gate output directory:
`internal-alpha-<run-id>/{host-runtime,backup-restore,macos-real-backend,diagnostics}/`.
The final `## Local Gate` block includes those paths plus the top-level local
gate markdown/log. It is the preferred evidence packet when a PR needs to show
host-runtime boot/health/migrate/message/relay/mock Kim Intern, backup restore
rehearsal, macOS real-backend UI, and diagnostics bundle coverage together.

For internal alpha runbook, feedback packet, one-person dogfood checklist, or
AWS promotion threshold updates, use:

```bash
scripts/local_gate.sh --profile docs
```

For AWS internal alpha topology/runbook updates, the same docs profile runs:

```bash
scripts/aws_internal_alpha_preflight.sh \
  --env-file infra/prod/aws-internal-alpha.env.example \
  --mode recommended \
  --evidence-dir "$LOCAL_GATE_OUTPUT_DIR/aws-internal-alpha-preflight"
```

This preflight validates provider/topology, public DNS/TLS shape, security-group
intent, encrypted volume intent, immutable image deploy, backup/restore, and
rollback acknowledgement. It does not create AWS resources or prove live host
runtime; attach real AWS evidence separately when the host exists.

Docs gate PASS for the one-person alpha checklist means the runbook and static
preflight are internally consistent. It does not by itself mark the product
`AWS_READY`. AWS promotion still requires the operational threshold in
[`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md): local one-person gate PASS,
1-person soak, credentialed external agent runtime smoke, zero open P0/P1, and
redacted diagnostics evidence.

If the change modifies diagnostics collection or expected bundle shape, use
`scripts/local_gate.sh --profile diagnostics`. If the change claims macOS app
launch evidence, add `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile macos-ui`.
The human-facing alpha path lives in [`docs/INTERNAL_ALPHA.md`](INTERNAL_ALPHA.md);
feedback intake and triage live in
[`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md).

`runtime-relay` is now automated by `scripts/verify_relay.sh`. Relay/history
PRs must use this profile unless the machine cannot run Docker/psql. WebSocket
live subscribe PRs must use `runtime-live`, which starts host MomoServer and
OutboxRelay plus a small `api:8080` proxy container because Centrifugo's
subscribe proxy must reach the API service on the Docker network. If Docker/psql
is unavailable, record the blocker and keep the affected runtime scope
unverified.

After parallel runtime gates or after removing old worktrees, audit leftover
worktree Docker Compose resources with:

```bash
scripts/compose_janitor.sh
```

This command is dry-run by default. It lists only stale `momo_` and `momo240_` worktree Compose
projects, containers, and networks; it protects `momo_default`, the root `momo`
project, `supabase`, active worktree projects, and non-momo resources. Removal
requires an explicit cleanup flag. Volumes remain untouched. See
[`MULTI_SESSION_OPS.md` §9](MULTI_SESSION_OPS.md#9-resource-governance-호스트-부하-규칙--2026-07-17-발열-사고-후-정본)
for the host-wide load and stale-stack policy:

```bash
scripts/compose_janitor.sh --cleanup
```

For macOS UI PRs, the default `macos-ui` profile stays GUI-safe for headless or
background Codex runs: it executes `MomoMacSmoke` only. Opt-in GUI evidence uses
`LOCAL_GATE_LAUNCH_UI=1`, which stages `dist/MomoMacDevApp.app`, launches it with
`open -n`, verifies the process and System Events window count, captures unified
logs under `${TMPDIR:-/tmp}/momo-macos-dev-run`, then terminates the app.

For M3 D/B/C exit PRs, use:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc
```

This composed profile records one PR-ready evidence block for:
D Live Tool-Call (`agent.partial` mock OpenAI-compatible SSE tool_call progress
and final `tool_result`/`message.new` with `version=message.seq`), B Cost
Projection (`usage_ledger`/`budget_window` reserve/reconcile plus
`/cost-snapshots` and MomoMac `CostSnapshot` binding), and C Approval Inbox
(`/approvals` pending projection plus approve/reject/idempotency/audit/resume
effects). Add `LOCAL_GATE_LAUNCH_UI=1` when a foreground macOS dev app
process/window smoke is wanted; by default the profile keeps GUI launch opt-in
and still verifies the real-backend REST/UI data path.

## 3. Manual Fallback

Run from repo root:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make test
python3 -m py_compile adapters/hermes/momo_adapter.py
python3 adapters/hermes/tests/smoke_momo_adapter.py
jq empty .github/labels.json infra/centrifugo.json
```

If shell scripts changed:

```bash
for f in scripts/*.sh scripts/github/*.sh; do
  [ -e "$f" ] || continue
  bash -n "$f"
done
```

If GitHub workflows changed and `actionlint` is installed:

```bash
actionlint .github/workflows/*.yml
```

If `actionlint` is missing and workflows changed, install it or record the exact blocker before merge. `scripts/local_gate.sh` fails workflow-changing PRs when `actionlint` is unavailable.

## 4. Runtime Profiles

Use the profile that matches the changed surface.

| Profile | Use when | Commands |
|---|---|---|
| `docs` | docs/spec only | `scripts/local_gate.sh --profile docs` |
| `swift` | Swift package/model/view changes | `scripts/local_gate.sh --profile swift` (includes design pre-flight ratchet + snapshot tests) |
| `diagnostics` | diagnostics/observability bundle changes | `scripts/local_gate.sh --profile diagnostics` |
| `staging-smoke` | MOMO-005/006/007/229/406 deploy config, Caddy/Centrifugo, install/upgrade matrix, public host preflight, secret/backup runbooks | `scripts/local_gate.sh --profile staging-smoke` |
| `backup` | backup/PITR restore rehearsal evidence | `scripts/local_gate.sh --profile backup` |
| `host-runtime` | internal single-node runtime smoke, Kim Intern provider status/redaction, plus restore rehearsal evidence | `scripts/local_gate.sh --profile host-runtime` |
| `local-alpha` | AWS-free local Docker alpha RC packet | `scripts/local_gate.sh --profile local-alpha`; add `LOCAL_GATE_LAUNCH_UI=1` for MomoMacDevApp process/window/log launch evidence |
| `internal-alpha` | internal alpha combined evidence packet | `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha` |
| `runtime-db` | migrations/server/RLS/join/push-registration/push-notifier/work-session tier-fallback/plugin-registry/webhook-ingress changes | `scripts/local_gate.sh --profile runtime-db` |
| `runtime-relay` | outbox/relay/realtime changes | `scripts/local_gate.sh --profile runtime-relay` |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `scripts/local_gate.sh --profile runtime-live` |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `scripts/local_gate.sh --profile runtime-agent` |
| `external-agent-provider` | opt-in credentialed external agent runtime smoke | `scripts/local_gate.sh --profile external-agent-provider`; set `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, and `HERMES_API_KEY` for PASS evidence |
| `macos-ui` | MomoMac UI/run changes | `scripts/local_gate.sh --profile macos-ui`; add `LOCAL_GATE_LAUNCH_UI=1` for dev `.app` launch, process/window smoke, logs, and termination |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc`; add `LOCAL_GATE_LAUNCH_UI=1` for GUI process/window evidence |
| `web` | `clients/web`, `docs/api/openapi.yaml`, web serving/login smoke changes | `scripts/local_gate.sh --profile web` (install/lint/typecheck/types-sync/build/license gate + serving smoke + Chromium login→timeline e2e smoke + OpenAPI runtime drift gate) |

## 5. PR Body Evidence

Paste the block printed by `scripts/local_gate.sh`. Shape:

```md
## Local Gate
- Result:
- Profile:
- Started:
- Finished:
- Run ID:
- Evidence markdown:
- Evidence log:
- Commands:
- Runtime coverage:
- Not covered:
```

## 6. Design Pre-Flight (Ratchet) And UI PR Evidence

Every `swift`-inclusive profile now runs `scripts/verify_design_preflight.sh`, the
mechanical grep half of `.claude/skills/momo-design-taste/SKILL.md` §5, before
`make build`. It scans view code (`clients/macOS/Sources` + `clients/Core/Sources`;
Theme/Tokens definition files and `Tests/` are excluded) for four banned patterns:

| Category (baseline key) | Banned in view code | Use instead |
|---|---|---|
| `color_red` | raw `Color(red:…)` | a MomoDS semantic token |
| `font_custom` | `Font.custom(…)` | a semantic text style / role |
| `font_system_size` | `.font(.system(size: N))` fixed points | a text style (keeps Dynamic Type) |
| `emdash_string` | em-dash (`—`/`–`) inside a user-visible string literal | rewrite the copy (SKILL §2, binary rule) |

**Ratchet, not a wall.** The v0 demo surface already carries pre-existing
violations, so the gate compares against per-category counts in
`scripts/design_preflight_baseline.txt` instead of demanding zero:

- **current > baseline → FAIL.** A new violation leaked in; the offenders are
  printed as `file:line` evidence. Fix it with a token / text role.
- **current < baseline → PASS**, with a hint to lock the win by lowering the
  baseline (`scripts/verify_design_preflight.sh --update-baseline`).
- **current == baseline → PASS.**

This is a deliberate change from the SKILL's "zero hits" phrasing: a hard zero
gate would block every unrelated PR until the whole v0 surface is migrated to
MomoDS (that migration is MOMO-303). The ratchet blocks *new* debt now and lets
the baseline tighten as tokens land. If a new violation is a reviewed, deliberate
exception, regenerate the baseline and justify it in the PR body.

`scripts/verify_design_preflight.sh --list` prints every current violation without
gating; use it while migrating a surface to tokens.

**UI PR evidence (design-review agent).** Per `AGENTS.md` §5, a macOS/Core UI PR
must include a `design-review` agent report (`.claude/agents/design-review.md`)
with **zero Blockers** in the PR body, alongside the `## Local Gate` block.
Screenshots for the review come from the snapshot tests
(`clients/macOS/Tests/MomoMacTests/__Snapshots__/`) or from
`LOCAL_GATE_LAUNCH_UI=1` + `screencapture -l <windowid>`. The mechanical
pre-flight and the snapshot tests are the automated floor; the design-review
report (Blocker 0) is the human/agent taste gate on top of them. Only
High-priority-and-below findings reach the human reviewer.

**Snapshot tests.** `MessageBubbleSnapshotTests` records deterministic light/dark
PNG references under `__Snapshots__/`. They are committed and compared on re-run
(recording a *new* reference fails, so a leaked/undecided snapshot is caught).
Comparison uses `perceptualPrecision: 0.98` to tolerate sub-pixel font rendering
differences across macOS point releases; it is macOS-local evidence only (this
repo phase runs no CI). `Package.resolved` stays uncommitted (`AGENTS.md` §5).

## 7. Worker Handoff And Merge Cycle

1. Claim issue and work in a separate worktree.
   - `momo-main` checks `scripts/goal_status.sh`.
   - worker runs `scripts/goal_claim.sh <issue>` when available.
2. Implement from the issue plan.
3. Worker runs the relevant `scripts/local_gate.sh --profile ...` in a clean worktree.
4. Commit, push, and open PR.
5. Worker moves the issue to review with `scripts/goal_release.sh <issue> --review --pr <PR URL>`, hands off to `momo-main`, and stops.
6. Worker must not merge, close the issue, run the post-merge `main` gate, or adjust roadmap/backlog state.
7. `momo-main` reviews for security, correctness, and scope.
8. `momo-main` runs the final local gate after review fixes.
9. `momo-main` merges only if the local gate passes and no blocker remains.
10. `momo-main` updates `main` locally and reruns the relevant local gate on `main`.
11. `momo-main` updates issue status, `STATUS.md`, roadmap/backlog if decisions changed, and recommends the next goal.
12. If Actions are intentionally disabled, `momo-main` confirms workflow state remains `disabled_manually` instead of waiting for remote CI.
