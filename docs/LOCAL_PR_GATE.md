# Local PR Gate

> Purpose: keep PR quality high while GitHub Actions are not the primary merge gate.
> Scope: local developer/Codex validation before PR, after review, and after merge to `main`.

## 0. Current Status

As of 2026-08-12, public-repository `pr-ci` is active for PRs into `main`,
`track/engine`, and `track/uxui`; `track-alignment` watches canonical topology.
Release and paid macOS workflows remain manual and owner-gated.

- `PR CI gate` and base-trusted `Policy integrity gate` are the two stable branch-protection contexts (ADR-0153 D5). Rust, Node, and generated-contract jobs may skip by path, while the PR CI aggregator itself always reports one result.
- Local evidence remains the primary runtime merge gate because PR CI intentionally does not boot PostgreSQL/Centrifugo/Docker e2e or external providers.
- Workers use local evidence to open a PR and hand it off; workers do not merge. `momo-main` owns review, final local gate, merge, issue close, and post-merge `main` verification.
- Release workflow activation and M7/M8 gates are unchanged; green PR CI is not release authorization.

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

Full profiles include the static repository checks below. Independently of the
selected profile, canonical local track wiring is always added before the
profile switch, so focused `web` and `secrets` runs cannot bypass it:

- `scripts/check_branch_skew.sh` computes the merge-base with
  `${MOMO_GATE_SKEW_REF:-origin/main}` and fails when upstream and the current
  branch changed any of the same paths after that point. Rebase and resolve the
  listed paths before rerunning. A reviewed exceptional run may set
  `MOMO_GATE_SKIP_SKEW='specific reason'`; the reason is printed and embedded in
  the final evidence. Blank or reasonless overrides are rejected.
- `scripts/check_track_alignment.sh --local-existing` validates exact upstream
  and no-behind/no-divergence state for installed canonical local branches.
  Track/local ahead is allowed. Global remote topology is monitored separately
  so a repair PR is not blocked by the drift it is intended to repair.
- `scripts/check_migration_numbers.sh server/Migrations` rejects duplicate
  numeric prefixes before any database connection. `037_name.sql` and
  `37_other.sql` are treated as the same number. `scripts/migrate.sh` runs the
  same check before psql discovery, so a missing psql cannot hide a collision.

To enable the same skew check before every push, explicitly install the optional
hook:

```bash
scripts/install_branch_skew_hook.sh
```

The installer is maintainer-only: it first normalizes `origin` and proves it is
exactly `yeomyeonggeori/oort`, then proves that remote exposes all three
canonical refs. Supported canonical URL forms are `git@github.com:...`,
`ssh://git@github.com/...`, and `https://github.com/...`, with an optional
`.git` suffix. It writes an absent/identical hook, safely upgrades the exact
previous oort-managed version with a `.pre-1297.bak`, and refuses every unknown
hook. It does not modify the shared worktree `post-checkout` bootstrap hook.

The pre-push hook uses Git's remote-name **and** remote-URL arguments, so a
canonical alias or direct canonical URL receives the same candidate/deletion
protection as `origin`. Before a canonical push it re-verifies that `origin` is
still the canonical trust anchor used to refresh comparison refs. A recognized
noncanonical GitHub fork receives only the ordinary branch-skew check. If the
destination URL cannot be normalized, an update or deletion of a canonical
branch name fails closed; diagnostics never echo the raw URL because it may
contain credentials.

The script writes a log, Markdown evidence file, and `.sha256` manifest under
`${TMPDIR:-/tmp}/momo-local-gate` by default, then prints a PR-ready
`## Local Gate` block to stdout. Filenames include the profile, UTC second,
process id, nanosecond timestamp, worktree hash, and random suffix, for example
`local-gate-docs-20260629T120000Z-pid1234-ns1780000000000000000-wtab12cd34ef56-r98ab76cd54ef.md`.
This keeps evidence paths collision-safe when the same profile runs in parallel
from multiple worktrees. Use `--output-dir <dir>` or `LOCAL_GATE_OUT_DIR=<dir>`
when you need a stable parent directory for local evidence files.

Each run also gets `artifacts-<run-id>/`; commands that consume
`LOCAL_GATE_OUTPUT_DIR` write there instead of a shared directory. After the log
is finalized, the manifest records SHA-256 for the evidence Markdown, log, and
every file in that run artifact directory. Verify it from any working directory
with `shasum -a 256 -c <manifest>` on macOS or
`sha256sum -c <manifest>` on Linux. The manifest does not hash itself.

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
| `docs` | docs/spec/script-only changes, including internal alpha runbook/feedback/AWS topology updates | whitespace diff, **secret scan over all refs (#1236)**, workflow YAML parse, actionlint if installed, e2e compose config, AWS internal alpha topology preflight fixture, **Rust publish + self-host image-mode contracts (#1266)**, JSON syntax, shell syntax, Python syntax, Hermes adapter smoke, prime adapter contract tests + closed-loop smoke (`adapters/prime/tests/`, no docker/network/credential) |
| `swift` | 잔존 Swift 트리(`server`·`relay/*`·`workers/*`·`services/*`) 변경 | `docs` profile + `make swift-build` + `make swift-test`. **mac 디자인 pre-flight 래칫과 SwiftPM 라이선스 게이트는 W-S1(#1215/#1201)에서 은퇴** — 후속은 각각 `design_preflight_web.sh`(web/병합 트리)와 `--profile license`(cargo+npm) |
| `diagnostics` | diagnostics/observability bundle changes | `docs` profile + `scripts/collect_diagnostics.sh --smoke` redaction check |
| `staging-smoke` | staging/prod/internal-hosting config or runbook changes that do not have real VPS secrets | `docs` profile + `scripts/verify_staging_smoke.sh` + `scripts/verify_internal_hosting_smoke.sh` for prod compose config, internal single-node smoke overlay, Caddyfile structure, Centrifugo Redis config, API health route wiring, relay/worker enablement, secret-template guard, public/staging preflight evidence markdown/json, and SOPS/pgBackRest checklist |
| `backup` | backup/PITR runbook or internal hosting changes that must prove restore rehearsal evidence before review | `docs` profile + `scripts/verify_backup_restore_rehearsal.sh` for temporary PostgreSQL 18 source DB marker writes, `pg_dump -Fc`, separate restore DB `pg_restore`, marker checksum equality, and markdown/json evidence generation |
| `host-runtime` | internal single-node host-runtime smoke before internal test hosting | `docs` profile + `scripts/verify_internal_host_runtime.sh` + `scripts/verify_backup_restore_rehearsal.sh`; proves local image prod+internal-smoke boot/health/agent-runtime-status redaction/migrate/message/relay/mock-agent and repo-local restore evidence |
| `local-alpha` | AWS 전 1인 local Docker alpha RC gate | `docs` profile + host-runtime boot/health/migrate/message/relay/mock Kim Intern + backup restore rehearsal + redacted diagnostics bundle in one `local-alpha-<run-id>/` packet |
| `internal-alpha` | internal alpha evidence packet before reviewer handoff | `docs` profile + host-runtime image boot/health/migrate/message/relay/mock Kim Intern evidence + backup restore rehearsal + redacted diagnostics bundle |
| `runtime-db` | migrations/server/RLS/join changes | `swift` profile + `make up` (compose `--wait`) + `make migrate` (single run: apply + idempotency verify pass with `IDEMPOTENCY_OK` marker) + `scripts/verify_rls.sh` + `scripts/verify_join.sh` + `scripts/verify_push_registration.sh` + `scripts/verify_push_notifier.sh` + `scripts/verify_plugin_registry.sh` + `scripts/verify_signed_webhook_ingress.sh` + `scripts/verify_drive_mcp.sh` + `scripts/verify_attachment_upload.sh` (both stub-only; no Google call) |
| `runtime-relay` | outbox/relay/realtime changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_relay.sh` for server send, outbox pending, relay claim, Centrifugo history, outbox done, and `version=message.seq` evidence |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `swift` profile + Docker/migration bootstrap + host MomoServer/OutboxRelay + compose-network `api:8080` proxy + `scripts/verify_realtime_live.sh` for token issuance, subscribe, REST send, live `message.new`, `payload.message.seq`, and invalid token rejection evidence |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `swift` profile + Docker/migration bootstrap + `scripts/verify_agent_worker.sh` + `scripts/verify_agent_live_channel.sh` |
| `external-agent-provider` | real external agent runtime credentialed smoke, opt-in only | `docs` profile + `scripts/verify_local_hermes_credentialed_smoke.sh`; with credentials it delegates to the external verifier, checks OpenAI-compatible SSE, `/v1/agent-runtime/status` redaction/degraded reason, Hermes active agent + `#agent-lab` invite precondition, and one local MomoServer/AgentWorker/OutboxRelay `@hermes` roundtrip; without credentials it writes `NEEDS_USER_CREDENTIAL` / `runtime-unverified(external provider credentials)` evidence |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `swift` profile + Docker/migration bootstrap + `verify_agent_worker.sh` D/B evidence + `verify_approval_decision.sh` C evidence |
| `web-serving` | `infra/prod/Dockerfile.web`, prod Caddy/compose, LinkShort, or APP_DOMAIN serving verifier changes | `docs` static checks + `scripts/verify_web_serving.sh`; isolated e2e `web` profile on ports 28070-28074, real Vite dist via web-init named volume, `/join` fallback and `/i/*` LinkShort proxy included in the eight-assertion HTTP gate. Public DNS/ACME/TLS and the full invite round-trip are excluded. |
| `web` | `clients/web-legacy` (ADR-0119 v0), `docs/api/openapi.yaml`, or web serving/smoke script changes | worktree-clean + `npm ci` + `npm run lint` + `npm run test` (Vitest) + `npm run typecheck` + `scripts/verify_web_generated_types.sh` (openapi-typescript output vs committed `src/api/schema.d.ts`; `generator-failed` and `types-stale` are distinct named failures) + `npm run build` + permissive-only license gate (full transitive inventory markdown) + `scripts/web_serving_smoke.sh` + `scripts/verify_web_login_smoke.sh` (e2e compose Chromium login→timeline→realtime) + `scripts/verify_openapi_contract.sh` runtime drift gate |
| `license` | dependency changes in any cargo/npm tree — `Cargo.lock`, `package-lock.json`, `deny.toml`, or the gate scripts themselves | `docs` profile + `scripts/tests/test_license_gate.sh` (red proofs) + `scripts/check_cargo_licenses.sh` (`cargo deny check licenses` over `server-rust` and `clients/desktop/src-tauri` with the root `deny.toml`) + `scripts/check_npm_licenses.mjs` over the canonical npm trees (workspace root incl. `packages/momo-core`, `clients/web`, `clients/mobile`; inventory markdown to the gate output dir). Requires `cargo-deny`; fails closed with install guidance when absent. Licenses only — no RUSTSEC advisories, no `npm audit` |
| `secrets` | fast standalone "did I just commit a credential" lane, or `.gitleaksignore` / secret-gate script changes | `scripts/tests/test_secrets_gate.sh` (red proofs) + `scripts/check_secrets.sh` — gitleaks over every ref with the `.gitleaksignore` triage baseline applied. ~3s, no static checks. The same two steps already run inside **every** other profile through the static block, so this profile is a convenience lane, not extra coverage. Requires `gitleaks`; fails closed with install guidance when absent, with no override env |
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
scripts/local_gate.sh --profile m3-dbc
scripts/local_gate.sh --profile web-serving
scripts/local_gate.sh --profile web
scripts/local_gate.sh --profile license
scripts/local_gate.sh --profile secrets
scripts/local_gate.sh --profile docs --output-dir /tmp/momo-local-gate
```

### Rust image publication + self-host modes (#1266)

Every profile's static block runs both contracts:

```bash
python3 scripts/tests/test_publish_images_contract.py
scripts/tests/test_self_host_env_modes.sh
```

The first parses the workflow and keeps it on `server-rust/Dockerfile`, native
`linux/amd64`, exact `MOMO_BUILD_SHA`, one seven-command image, embedded
LICENSE/NOTICE, provenance, and SBOM. It behaviorally exercises the `main` ref
guard and mutates full-SHA action pins, registry push, and the attestation
subject name/digest/OCI-referrer bindings to prove each removal turns red. A fake
`gh` also proves the deploy library verifies the selected OCI digest against the
`yeomyeonggeori/oort` repository and SLSA provenance v1.

The second executes isolated fixtures and proves the two quickstart modes do
not cross: local-build includes the build overlay and `--build`;
published-digest requires the canonical full sha256 ref and omits both. It also
rejects LF/CR and dotenv-metachar credential injection, duplicate keys,
config-source argv replacement, and non-decimal arithmetic input before
modifying an env file. The canonical `--compose` launcher derives its unset
boundary from every actual env-file key and canonical Compose interpolation,
adds explicit Compose control keys, and preserves Docker daemon/context
selection. A real `docker compose config` fixture proves ambient secret, DB/WS
URL, three ports, project, image, and file/profile controls cannot replace the
generated authority while all seven application consumers use the exact
digest. Neither test dispatches a workflow nor pulls from GHCR.

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

**2026-08-06 강등 — 1차(Swift) 패스는 기본 off (ADR-0145 증보 2-② / #1089).**
Swift 서버는 삭제 전이라도 상시 빌드·테스트 대상이 아니다. 스펙이 서술하는 대상은
Rust 배포본이므로(#1040), 1차 패스는 죽을 서버를 스펙과 대조하며 매 실행 40분짜리
콜드 Swift 빌드를 태우는 일이었다. **기본 실행은 2차(스펙 ↔ Rust) 패스 하나다.**

- `OPENAPI_GATE_SWIFT_PASS=1` — 1차 패스를 되살린다(아래가 그 패스의 동작이다).
- 1차가 꺼지면 `scripts/openapi_sampled_on_rust.txt` **밖**의 연산은 어느 패스도
  보지 않는다. 그래서 게이트가 그 목록을 매 실행 **경고로 전부 출력한다**
  (2026-08-06 실측 125/128). 과도기 부채이지 면제가 아니다.
- 두 패스를 동시에 끄는 조합(`SWIFT_PASS=0` + `RUST_PASS=0`)은 거부한다 —
  아무도 샘플하지 않는 초록은 게이트가 아니다.
- `known-unsampled`의 의미는 불변이다: 1차 패스만의 부채 장부이고, 1차가 꺼진
  실행에서는 참조되지 않는다. 줄 추가는 여전히 금지.

아래는 `OPENAPI_GATE_SWIFT_PASS=1` 일 때의 1차 패스 동작이다.
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

### 병합 트리 크로스-클라 게이트 (#1108)

```bash
scripts/verify_merge_tree.sh                     # HEAD 를 origin/track/engine 에
scripts/verify_merge_tree.sh --base main --head feat/xxx
scripts/verify_merge_tree.sh --typecheck-only    # 빠른 사전 확인
```

**코어(`packages/momo-core`)를 만진 PR을 트랙에 머지하기 전에 필수다.** 재는 것은
브랜치가 아니라 **병합 결과**다: `git merge-tree --write-tree` 로 병합 트리를 만들고
임시 워크트리에 실체화한 뒤 거기서 여덟 레인을 돌린다 — 웹·폰·코어 3종 typecheck,
같은 3종 스위트, 카피 스캔(웹+코어), 그리고 정본 웹 클라의 ESLint. 브랜치 HEAD 는
한 번도 체크아웃되지 않는다 — 그것이 이미 초록인 판이기 때문이다.

여덟 번째 레인(`web lint`)은 #1210 에서 붙었다. `clients/web/eslint.config.js` 의 두
디자인 규칙(JSX 인라인 `style=` 금지 · `#rrggbb` 리터럴 금지)을 **어느 게이트도
실행하지 않고** 있었기 때문이다 — `web` 프로파일의 lint 단계가 도는 것은 동결된
`clients/web-legacy` 다. 그동안 손실이 없었던 것은 `design_preflight_web.sh` 의 그렙
분류가 같은 두 규칙을 중복 커버한 덕이고, 중복이 유일한 안전망인 상태였다. 문턱은
error 이고 경고는 통과한다(base 12건).

같은 실패 양식이 두 번 왔기 때문에 세운다: ①U4-4 W-1(게이트 증거를 버려질 판에서
수집) ②U4-6 B1(웹 PR이 코어 API를 재편, 폰 PR이 옛 API 소비 — 각 브랜치는 초록,
병합 트리에서만 폰 `tsc TS2353`. 런타임에서는 오프라인 승인 버튼이 되살아났다).

기본은 이 체크아웃의 `node_modules` 를 심볼릭 링크로 빌려 쓴다(실측 20초). 병합
결과의 락파일이 다르면 자동으로 `npm ci` 모드로 전환하고, `--install` 로 강제할 수
있다. 워킹 트리의 커밋되지 않은 변경은 병합 트리에 들어가지 않으므로 게이트가 그
사실을 경고로 말한다.

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

`scripts/local_gate.sh --profile web` is the merge gate for `clients/web-legacy`
and web-serving changes (ADR-0119 W-2/W-4). Steps, in order:

> **Path note (MOMO-596 / ADR-0133):** the v0 client this profile builds moved
> from `clients/web` to `clients/web-legacy`. The new `clients/web` (canonical
> React/Tauri UI) and `clients/desktop` are **not** covered by this profile —
> `--auto` widens them to `all` until a dedicated profile exists.

1. worktree-clean guard, `npm ci`, `eslint`, `tsc --noEmit` inside
   `clients/web-legacy`.
2. Generated-types sync — `scripts/verify_web_generated_types.sh`:
   `npm run generate:types` re-renders `src/api/schema.d.ts` from
   `docs/api/openapi.yaml` and the step fails if the committed file differs —
   spec changes and client types cannot drift apart in one PR. Failures are
   named: `generator-failed` (unparseable spec or missing/broken
   openapi-typescript) is reported separately from `types-stale`, and the
   regenerated file is restored on every exit path so a drift failure never
   resurfaces as a worktree-clean failure on the next run. MOMO-678 repaired
   this step after it sat permanently red (64 committed paths vs 101
   documented) — a step that always fails carries no signal.
3. `vite build` (production bundle must stay CSP-safe: no inline script;
   ADR-0119 permits inline style, and the browser smoke enforces the policy).
4. License gate: `scripts/check_npm_licenses.mjs --root clients/web-legacy`
   walks the full transitive closure from `package-lock.json`, fails on
   anything outside the shared permissive allowlist, and writes a Markdown
   license inventory to the gate output dir — attach it to the PR.
   #1225 moved this script out of `clients/web-legacy/scripts/` and pointed
   its defaults at the canonical trees, so this profile now names the tree it
   builds. The policy itself (including the reviewed MPL-2.0/BlueOak-1.0.0/
   Python-2.0/CC-BY-4.0 entries and their reasons) lives in the script's
   `ALLOWED` map and mirrors `deny.toml`; see the `license` profile.
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
   `/join?code=<code>`, asserts the code is stripped from browser history after
   success (history.replaceState) and never appears in any non-document request URL
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

MOMO-561 adds `scripts/verify_owner_bootstrap.sh` to `runtime-db`. It builds the
pinned migrate image and verifies the env-only `set-owner` command on reserved
port 28200, including exact bootstrap-owner selection, secret non-disclosure,
idempotent credential rotation, and active-session revocation. Worker handoff
leaves this Docker verifier `runtime-unverified` for the orchestrator.

For the external provider profile, keep stack ports in `.env.worktree` and pass
only oort-facing provider endpoint/key values through the shell or, preferably,
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
file or inline oort-facing endpoint/key is configured, the profile exits
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
token storage, refresh, unlink, and rotation inside the provider host. The oort
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
migrate/message/relay/mock Kim Intern evidence, backup restore rehearsal, and a
redacted diagnostics bundle. The SwiftUI macOS app evidence this packet used to
carry was removed with the client trees (W-S1 / #1215); product-surface evidence
now comes from the web/desktop/RN lanes.

For internal alpha reviewer handoff, use the stricter combined packet instead
of pasting separate host/runtime/UI/diagnostics snippets:

```bash
scripts/local_gate.sh --profile internal-alpha
```

It writes verifier artifacts under a run-specific directory below the
local gate output directory:
`internal-alpha-<run-id>/{host-runtime,backup-restore,diagnostics}/`.
The final `## Local Gate` block includes those paths plus the top-level local
gate markdown/log. It is the preferred evidence packet when a PR needs to show
host-runtime boot/health/migrate/message/relay/mock Kim Intern, backup restore
rehearsal, and diagnostics bundle coverage together.

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
`scripts/local_gate.sh --profile diagnostics`.
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

For M3 D/B/C exit PRs, use:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc
```

This composed profile records one PR-ready evidence block for:
D Live Tool-Call (`agent.partial` mock OpenAI-compatible SSE tool_call progress
and final `tool_result`/`message.new` with `version=message.seq`), B Cost
Projection (`usage_ledger`/`budget_window` reserve/reconcile plus
`/cost-snapshots` projection), and C Approval Inbox
(`/approvals` pending projection plus approve/reject/idempotency/audit/resume
effects).

### Secret scan gate (#1236)

`.gitleaksignore` landed in #1224 with 61 hand-triaged false positives pinned by
fingerprint. Nothing executed it: gitleaks appeared in three planning documents
and in no gate. `scripts/check_secrets.sh` is that executor, and it runs in the
static block, so **every** profile carries it.

```bash
scripts/check_secrets.sh            # or: scripts/local_gate.sh --profile secrets
```

It runs exactly the command the baseline documents as the range it guarantees —
`gitleaks detect --source <root> --log-opts "--all" --redact=90` — and four
properties of that choice are load-bearing:

- **Git mode, not `--no-git`.** Fingerprints are `<commit>:<file>:<rule>:<line>`,
  so a commit-less scan cannot read the baseline and the same false positives
  come straight back. `scripts/tests/test_secrets_gate.sh` measures that
  divergence rather than asserting it, so the rationale stays falsifiable.
- **All refs.** A credential committed on any local branch is a credential in the
  repository.
- **Committed history only.** Uncommitted work has no commit, hence no
  fingerprint. The `worktree clean` static check is what closes that gap; the two
  checks are complementary.
- **No findings report file**, even into the gate artifact directory: a gitleaks
  JSON report carries the matched values while `--redact` covers only stdout.

Missing `gitleaks` fails the gate (`brew install gitleaks`). There is
deliberately no override env — unlike the branch-skew guard, "skip the secret
scan" is not a reviewable exception.

**When it goes red on a line you did not write:** fingerprints are pinned to a
commit, so a new commit touching a baselined line produces a new fingerprint and
a new finding. That is intended — it forces a fresh look. Add the new fingerprint
with a reason that *describes* the value instead of quoting it; quoting it
creates another finding (#1224 did this to itself three times).

Rule coverage is stock gitleaks. No repo-specific `gitleaks.toml` exists yet, so
a credential shape gitleaks does not know is still invisible.

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
| `local-alpha` | AWS-free local Docker alpha RC packet | `scripts/local_gate.sh --profile local-alpha` |
| `internal-alpha` | internal alpha combined evidence packet | `LOCAL_GATE_LAUNCH_UI=1 scripts/local_gate.sh --profile internal-alpha` |
| `runtime-db` | migrations/server/RLS/join/push-registration/push-notifier/work-session tier-fallback/plugin-registry/webhook-ingress changes | `scripts/local_gate.sh --profile runtime-db` |
| `runtime-relay` | outbox/relay/realtime changes | `scripts/local_gate.sh --profile runtime-relay` |
| `runtime-live` | realtime-token/WebSocket live subscribe changes | `scripts/local_gate.sh --profile runtime-live` |
| `runtime-agent` | AgentWorker/hermes/cost/projection/agent live-channel changes | `scripts/local_gate.sh --profile runtime-agent` |
| `external-agent-provider` | opt-in credentialed external agent runtime smoke | `scripts/local_gate.sh --profile external-agent-provider`; set `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, and `HERMES_API_KEY` for PASS evidence |
| `m3-dbc` | M3 D/B/C exit evidence or MOMO-020/021/022 close-readiness review | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc`; add `LOCAL_GATE_LAUNCH_UI=1` for GUI process/window evidence |
| `web` | `clients/web-legacy` (ADR-0119 v0), `docs/api/openapi.yaml`, web serving/login smoke changes | `scripts/local_gate.sh --profile web` (install/lint/typecheck/types-sync/build/license gate + serving smoke + Chromium login→timeline e2e smoke + OpenAPI runtime drift gate) |

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

## 6. Design Pre-Flight And UI PR Evidence

**은퇴(2026-08-10, W-S1 / #1215).** 이 절이 문서화하던 mac 래칫
`scripts/verify_design_preflight.sh` + `scripts/design_preflight_baseline.txt`은
스캔 대상이 `clients/macOS/Sources`와 `clients/Core/Sources` 둘뿐이었고, 그 두
트리가 삭제되면서 함께 폐기됐다. 래칫이 실제로 무엇을 재고 있었는지의 원문은
git 이력에 있다 — 삭제 직전 판본은 `git show <이 PR의 부모 SHA>:scripts/verify_design_preflight.sh`.

**현행 승계자는 `scripts/design_preflight_web.sh`다.** 같은 SKILL §5 규율을 정본 UI에
적용하며, 두 자리에서 돈다:

- `scripts/local_gate.sh --profile web` — 판별자 3종(`--selftest`) + `clients/web`
  10/10 카테고리 · `packages/momo-core` 3/3, **하드 제로**(래칫 아님).
- `scripts/verify_merge_tree.sh` 여덟 레인 중 "copy scan (web + core)" — 병합
  **결과** 트리에서 다시 잰다.

색·인라인 스타일 규칙은 `clients/web/eslint.config.js`의 `no-restricted-syntax`가
중복으로 지고, 그 lint는 병합 트리 8번째 레인이 실행한다(#1210).

**UI PR 증거(design-review 에이전트).** `AGENTS.md` §5대로 UI PR은 PR 본문에
`design-review` 리포트(Blocker 0)를 `## Local Gate` 블록과 함께 담는다. 스크린샷은
이제 웹/데스크톱/RN 표면에서 온다 — macOS 스냅샷 테스트
(`clients/macOS/Tests/MomoMacTests/__Snapshots__/`)는 클라 트리와 함께 삭제됐다.
기계 pre-flight가 자동 바닥이고, design-review(Blocker 0)가 그 위의 취향 게이트다.

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
9. `momo-main` merges only if the local gate passes, the current PR head has successful required `PR CI gate` **and** `Policy integrity gate`, and no blocker remains (ADR-0153 D5).
   - After #1302 lands, run `scripts/verify_policy_integrity_from_base.sh --repo yeomyeonggeori/oort --pr <PR>` immediately before merge from a checkout whose current branch/HEAD is the PR's **exact canonical base and whose wrapper bytes match that base**; never execute the candidate checkout's verifier. The wrapper extracts the verifier from the PR API exact base commit, so unrelated worktree dirt does not become authority and worktree/candidate verifier bytes are ignored. It binds current head/base and current default-main workflow authority to the exact workflow ID/path, `pull_request_target` event, run attempt, base-controlled run-name, GitHub Actions check-suite app and evaluator job, re-evaluates live changed-files/comment/label evidence, then rereads the API. A green status with the same App/name alone is insufficient. The trusted workflow never checks out, executes, or installs dependencies from the candidate.
   - For a policy-file PR, require designated policy owner `kwakseongjae`/GitHub user id `87296259` as author, the same designated owner's exact `Policy-Integrity-Audit: <40sha>` comment, and a current label whose latest transition is the same owner applying `policy-change-approved` after that comment; GitHub `author_association=OWNER` is not used because this org member reports `MEMBER`. Any head/comment/label transition requires reapproval. `scripts/local_gate.sh` fixtures pin these RED cases.
   - Workflow가 base에 없던 #1302의 track/engine→main 최초 랜딩 체인과 기존 exact-base verifier의 live status-user/App identity 결함을 고치는 #1307의 track/engine→main 수리 체인만 reviewed bootstrap exception이다. #1307은 독립 리뷰·두 required context·focused/static/docs local gate·후보 구현을 이용한 read-only live 진단을 요구하되 후보 verifier를 merge 권위로 쓰지 않는다. #1307 main 랜딩 직후 갱신된 exact-base wrapper로 대기 PR을 재검증하고 예외를 폐쇄한다.
   - 이후 bootstrap은 one docs-only, unmerged PR per equal canonical target using `scripts/github_track_guardrails.sh --repo yeomyeonggeori/oort --apply --policy-pr 'main=N,track/engine=N,track/uxui=N'` followed by `--check`, never workflow_dispatch seeding. Default main이 전진하면 old-authority run은 거부되므로 label toggle 등 새 event/run을 만든다.
   - 2026-08-12 live capture: commit status creator는 exact `github-actions[bot]`/user id `41898282`/type `Bot`이며 run/check-suite/job은 별도 GitHub Actions App id `15368`/slug `github-actions`다. exact-base verifier는 두 신원 축을 따로 결속한다. 첫 PR에서 bare workflow path와 PR-head run/suite/job 내부 SHA 형상을 확인했다. 아직 관측하지 않은 대체 API 형상은 의미를 추정하지 않고 내부 SHA 일치로 fail-closed하며, 원격 branch-protection apply/readback은 bootstrap 완료 전까지 `runtime-unverified`다.
10. `momo-main` updates `main` locally and reruns the relevant local gate on `main`.
11. `momo-main` updates issue status, `STATUS.md`, roadmap/backlog if decisions changed, and recommends the next goal.
12. If a non-required release/manual workflow is intentionally disabled, `momo-main` confirms that workflow remains `disabled_manually`; this exception never substitutes for the active required PR gates in step 9.
