# Internal Alpha Runbook

> Purpose: one teammate should be able to start momo locally, attach the macOS dev app, exercise invite/join, Kim Intern, diagnostics, and file a useful bug report without reading the whole repo.
> Scope: internal alpha on a developer Mac. This is not the M7 release gate and not a public/staging production launch.
> Cloud host: for a one-week AWS team alpha, use `docs/AWS_INTERNAL_ALPHA.md` first. The local runbook below still applies to app behavior and smoke scenarios.

## 0. Read This First

- Work from a dedicated worktree. Do not run alpha smoke tests from a dirty root checkout.
- Never commit `.env`, diagnostics archives, app logs, or screenshots with secrets.
- Raw invite codes are bearer secrets. momo stores only hashes, so an invite code must be copied when it is created.
- The durable write path is still REST -> Postgres transaction -> outbox -> relay publish. The macOS app must not publish directly to Centrifugo.
- Internal alpha can use repo-local mock Hermes. External Hermes/provider side effects remain `runtime-unverified` unless a real gateway is explicitly attached.
- "Kim Intern invited" and "Kim Intern connected" are separate checks: invited means the agent is an active `member.kind='agent'` with channel membership; connected means the provider status chip or `/v1/agent-runtime/status` reports mock/available instead of degraded.

## 1. Tooling Checklist

| Tool | Check | Used for |
|---|---|---|
| Swift 6.2.x | `swift --version` | server/worker/relay/macOS build and run |
| Xcode app toolchain | `xcodebuild -version` | macOS dev app build, optional Swift gate |
| Docker Desktop + Compose v2 | `docker compose version` | PostgreSQL 18 + Centrifugo v6 |
| PostgreSQL client | `psql --version` | migrations and verifier SQL |
| jq | `jq --version` | curl examples and local gates |
| Python 3 | `python3 --version` | mock Hermes, diagnostics, adapter smoke |

Recommended start in a claimed worktree:

```bash
bash .conductor/setup.sh
git status --short --branch
```

`.conductor/setup.sh` writes `.env.worktree` with unique `PORT`, `CENT_PORT`, `POSTGRES_PORT`, `HERMES_PORT`, `DATABASE_URL`, and `COMPOSE_PROJECT_NAME`. Use those values instead of hard-coding 8080/8000/5432 when several Codex sessions are running.

## 2. Alpha Boot Sequence

Run from the worktree root:

```bash
make up
make migrate
```

Open three long-running terminals:

```bash
# terminal 1
set -a; . ./.env.worktree; set +a
swift run --package-path server MomoServer

# terminal 2
set -a; . ./.env.worktree; set +a
swift run --package-path relay/OutboxRelay OutboxRelay

# terminal 3, only when testing Kim Intern against the repo-local mock
set -a; . ./.env.worktree; set +a
python3 scripts/mock_hermes.py --host 127.0.0.1 --port "${HERMES_PORT:-8088}"

# terminal 4, only when testing Kim Intern
set -a; . ./.env.worktree; set +a
swift run --package-path workers/AgentWorker AgentWorker
```

If a port is already occupied, stop the older momo process or rerun `.conductor/setup.sh` in a clean worktree. Do not change `infra/centrifugo.json` during alpha testing just to work around a local port conflict.

Quick API health check:

```bash
set -a; . ./.env.worktree; set +a
curl -fsS "http://127.0.0.1:${PORT:-8080}/health"
```

## 3. Seeded Alpha Assumptions

`server/Migrations/002_seed.sql` creates the deterministic demo world:

| Object | Value |
|---|---|
| Workspace | `momo Demo Workspace` |
| Workspace id | `00000000-0000-7000-8000-000000000001` |
| Workspace slug | `demo` |
| Human owner | `데모 사용자` / handle `demo` |
| Login email | `demo@momo.local` |
| Login password | `dev-password` |
| Agent member | `김인턴` / handle `kim-intern` |
| Agent model | `hermes-agent` |
| Channels | `#general`, `#agent-lab` |
| `#general` id | `00000000-0000-7000-8000-000000000201` |
| `#agent-lab` id | `00000000-0000-7000-8000-000000000202` |

Both the demo user and Kim Intern are active members of both seeded channels. First message seq in each seeded channel starts at `1` after the first send.

Kim Intern internal alpha contract:

| Check | Expected |
|---|---|
| Workspace invitation | `member.kind='agent'`, `member.status='active'`, display name `김인턴`, handle `kim-intern` |
| Agent profile | `agent.member_id` = Kim Intern member id, model `hermes-agent`, owner = seeded demo user |
| Channel invitation | active `membership` in `#agent-lab`; `#general` is also seeded for broad smoke |
| Status visibility | macOS sidebar Local AI chip or `GET /v1/agent-runtime/status` shows `Mock`, `Available`, or `Degraded` with redacted endpoint/key details |
| Send path | only REST `POST /messages` creates the mention; clients do not publish directly to Centrifugo |

If a later workspace seed omits Kim Intern from `#agent-lab`, an owner/admin must add the existing agent member through the channel membership API before the `@김인턴` smoke:

```bash
curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels/00000000-0000-7000-8000-000000000202/members" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"memberId":"00000000-0000-7000-8000-000000000102","role":"member"}'
```

This is a channel invite/activation path for an existing agent member, not a human `/v1/join` invite code. Do not create a new human member for Kim Intern.

There is no fixed raw invite code in seed data. Create a fresh one through the authenticated invite API and copy the returned `code` immediately.

## 4. Login, Invite, Join

Set environment and log in as the seeded owner:

```bash
set -a; . ./.env.worktree; set +a
BASE_URL="http://127.0.0.1:${PORT:-8080}"
WORKSPACE_ID="00000000-0000-7000-8000-000000000001"

ACCESS_TOKEN="$(
  curl -fsS -X POST "$BASE_URL/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"demo@momo.local","password":"dev-password","workspace":"00000000-0000-7000-8000-000000000001"}' \
  | jq -r '.accessToken'
)"
```

Create an invite:

```bash
EXPIRES_AT_MS="$(( ($(date +%s) + 86400) * 1000 ))"
INVITE_JSON="$(
  jq -cn --arg role member --argjson maxUses 5 --argjson expiresAtMs "$EXPIRES_AT_MS" \
    '{role:$role,maxUses:$maxUses,expiresAtMs:$expiresAtMs}'
)"

curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/invites" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$INVITE_JSON" | tee /tmp/momo-alpha-invite.json

INVITE_CODE="$(jq -r '.code' /tmp/momo-alpha-invite.json)"
```

Join with that invite:

```bash
JOIN_BODY="$(
  jq -cn --arg code "$INVITE_CODE" \
    '{code:$code,email:"alpha-joiner@momo.local",displayName:"Alpha Joiner",handle:"alpha-joiner",password:"dev-password",timeZone:"Asia/Seoul"}'
)"

curl -fsS -X POST "$BASE_URL/v1/join" \
  -H 'Content-Type: application/json' \
  -d "$JOIN_BODY" | jq .
```

Expected result: HTTP 201 for a new member, access token returned, public channel memberships returned, and subsequent `/v1/auth/login` with the joined email + `dev-password` succeeds.

## 5. Launch MomoMacDevApp

Demo-only mode, no server needed:

```bash
scripts/macos_dev_run.sh --verify --logs
```

Real local server mode:

```bash
set -a; . ./.env.worktree; set +a

MOMO_SERVER_BASE_URL="http://127.0.0.1:${PORT:-8080}" \
MOMO_CENTRIFUGO_WS_URL="ws://127.0.0.1:${CENT_PORT:-8000}/connection/websocket" \
MOMO_LOGIN_EMAIL="demo@momo.local" \
MOMO_LOGIN_PASSWORD="dev-password" \
MOMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001" \
MOMO_CHANNEL_ID="00000000-0000-7000-8000-000000000202" \
MACOS_DEV_RUN_DIRECT_EXEC=1 \
scripts/macos_dev_run.sh --verify --logs
```

Use `#agent-lab` for Kim Intern and D/B/C testing. The app first shows the session chooser. Use server mode with the seeded email/password above, or paste an invite code and join as a new user.

Internal alpha usability notes:

- In real-server mode, use the top `Invites` popover to create/list/revoke owner/admin invites. Create/revoke/refresh buttons disable while a request is in flight and failed invite operations show a `Retry` button.
- When a new invite is created, click `Copy Code` before closing the popover. Existing invite rows only show the masked preview; the raw invite code cannot be recovered later.
- Use the top `Updates` popover to inspect alpha update-channel readiness. During this skeleton phase it is a placeholder/status checklist, not an installer; the operator runbook is [`docs/MACOS_ALPHA_UPDATE_CHANNEL.md`](MACOS_ALPHA_UPDATE_CHANNEL.md).
- `Switch` and `Log Out` return to the chooser and clear the previous channel/member/message/realtime/invite state. `Log Out` also clears the saved-password preference and Keychain password.
- Login, join, channel load, and message send errors are recoverable: the chooser, sidebar, or timeline keeps the app interactive and offers retry/dismiss instead of leaving a blank session.
- The sidebar Members list shows Kim Intern as an `AGENT` when he is in the selected channel. The `+`/`-` member action is the admin path for inviting/removing an existing agent from a channel.
- The sidebar Kim Intern chip distinguishes `Local mock`, `Internal host mock`, and `External Hermes`, plus key/endpoint/degraded diagnostics. The same redacted provider summary appears in session details. `Mock` is connected enough for local alpha; `Available` means credentialed external provider is configured; `Degraded` means invited may still be true but provider connectivity is not usable.

Cleanup:

```bash
scripts/macos_dev_run.sh --terminate-only
make down
```

## 6. Alpha Smoke Scenarios

### A. Basic Chat

1. Open `#general`.
2. Send a short human message.
3. Expected: message appears in the timeline with increasing `message.seq`.
4. If relay is running and live mode is configured, another client should receive the `message.new` publication.

### B. Invite/Join

1. Create a member invite through the owner API or the app's `Invites` popover.
2. Copy the raw code immediately from the create response or `Copy Code` button.
3. Join from the app session chooser or `POST /v1/join`.
4. Expected: joined user can log in, sees public channels, and cannot escalate to owner/platform admin through a public invite.
5. If the code is lost, revoke that invite and create a new one; only masked previews are durable.

### C. Kim Intern

1. Confirm Kim Intern is invited: select `#agent-lab`, verify the Members list includes `김인턴` with the `AGENT` badge, or call `/v1/workspaces/$WORKSPACE_ID/members?kind=agent` and check `channelIds` includes `00000000-0000-7000-8000-000000000202`.
2. Confirm provider connectivity: check the sidebar Kim Intern chip or `curl -fsS "$BASE_URL/v1/agent-runtime/status" | jq .`.
3. For local mock smoke, ensure mock Hermes and AgentWorker are running, then send `@김인턴 상태 알려줘` or `@kim-intern summarize this channel` in `#agent-lab`.
4. Expected: an `agent_run`/`agent_job` is created, `agent.status` or `agent.partial` progress may appear, and final durable output returns as a channel timeline message.
5. Ordering authority remains the final channel `message.seq`; `agent:` events are progress only.
6. For real-provider smoke, put credentials only in an untracked provider env file and run `scripts/local_gate.sh --profile external-agent-provider`. Without credentials, the profile must PASS as an explicit `runtime-unverified(external provider credentials)` skip; with credentials, its evidence includes the Kim Intern invite precondition and one external-provider roundtrip.
7. Check the sidebar Kim Intern chip before filing bugs: `Mock` is expected for repo-local mock Hermes, `Available` indicates a configured external path, and `Degraded` should include a redacted diagnostic hint.

### D. Diagnostics

Run after a failure, before restarting everything:

```bash
scripts/collect_diagnostics.sh --output-dir /tmp/momo-diagnostics --since 15m
```

The collector writes a directory, `summary.md`, and a `.tar.gz`. It redacts secrets, passwords, API keys, bearer/JWT-shaped tokens, and database URL credentials before writing files. Still inspect `summary.md` and file names before sharing outside the team.

### E. Local Gate

For alpha docs/runbook changes:

```bash
scripts/local_gate.sh --profile docs
```

For diagnostics tooling:

```bash
scripts/local_gate.sh --profile diagnostics
```

For app smoke without foreground launch:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui
```

For app smoke with foreground process/window/log evidence:

```bash
LOCAL_GATE_LAUNCH_UI=1 DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile macos-ui
```

For D/B/C combined runtime evidence:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer scripts/local_gate.sh --profile m3-dbc
```

Paste the `## Local Gate` block from the script into the PR or issue comment.

## 7. Feedback Intake

Canonical intake and triage rules live in
[`docs/INTERNAL_ALPHA_FEEDBACK.md`](INTERNAL_ALPHA_FEEDBACK.md). Use GitHub's
`Internal alpha feedback` issue template for raw tester reports. Those issues
start as `type:feedback`, `area:alpha`, `status:needs-triage` and become
`status:ready` only after momo-main turns them into a buildable
`## Goal / ## Context / ## Acceptance / ## Out of scope` contract.

## 8. AWS Team Alpha Host

Use [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md) when the team needs a
shared one-week host instead of each tester running Docker locally. The v0
recommendation is EC2 `t4g.large` single-node with Caddy/API/OutboxRelay/
AgentWorker/Centrifugo/Redis/Postgres in image-based compose, encrypted `gp3`
data volume, pgBackRest to S3, and daily EBS snapshots.

Before provisioning or handoff:

```bash
scripts/aws_internal_alpha_preflight.sh \
  --env-file infra/prod/aws-internal-alpha.env.example \
  --mode recommended \
  --evidence-dir /tmp/momo-aws-alpha-preflight
```

The preflight is static. It verifies topology and safety intent, not real AWS
creation, DNS/TLS, registry pull, SOPS decrypt, backup execution, or restore
rehearsal. Those remain `runtime-unverified(aws-host)` until the host evidence
packet is attached.

Use this shape for quick GitHub issues or alpha feedback notes:

```md
## Summary
- One sentence:
- Severity: P0/P1/P2/P3
- Repro rate: always / often / once / unknown

## Environment
- Commit:
- Worktree:
- macOS:
- Swift:
- Docker:
- App mode: demo / local server / local server + live / Xcode host
- Server URL:

## Workspace Context
- Workspace:
- Channel:
- Member/user:
- Agent involved: none / Kim Intern / other

## Steps
1.
2.
3.

## Expected

## Actual

## Evidence
- Local gate profile:
- Local gate evidence path or PR URL:
- Diagnostics bundle:
- Screenshots or screen recording:
- Relevant log excerpt:

## Scope Notes
- Did this involve invite/join?
- Did this involve Kim Intern/mock Hermes/external Hermes?
- Did this involve approval/cost/realtime reconnect?
- Any secrets removed before sharing?
```

Severity guide:

| Severity | Meaning |
|---|---|
| P0 | Data loss/security: cross-tenant leak, secret exposure, destructive corruption, or launch/login impossible for every tester. |
| P1 | Core alpha flow blocked: send, invite/join, Kim Intern, approval/cost, realtime, diagnostics, or local gate unusable. |
| P2 | Usability friction: flow works but is confusing, brittle, stale, missing expected feedback, or requires an undocumented workaround. |
| P3 | Polish: copy, layout, visual fit, minor papercut, or non-blocking affordance issue. |

momo-main triages feedback with `scripts/goal_status.sh --repo Dawn-kim-official/momo`.
Rows in `status:needs-triage` are not claimable worker goals until severity,
evidence, labels, milestone, and acceptance are fixed.

## 8. Known Limitations

- `MomoMacDevApp` is a development app. It is not signed/notarized and is separate from the M4 release `MomoMac.app` packaging path.
- The `Updates` popover is an alpha-channel placeholder until Sparkle 2 is wired into a signed/notarized release app and a signed appcast exists.
- iOS is not present yet. iOS/App Store/TestFlight work remains M5/M7/M8.
- External Hermes/provider side effects are not covered by default alpha. Repo-local mock Hermes is the normal deterministic path.
- Public staging DNS/TLS, real registry image pull, SOPS production secret injection, and real pgBackRest WAL/PITR rehearsal are still `runtime-unverified(public host)` unless a host-specific evidence packet is attached.
- APNs, production presence polish, enterprise SSO, directory sync, and full channel settings/search/archive are out of scope for this alpha packet.
- Invite raw codes cannot be recovered after creation. Revoke and create a new invite if the code is lost.
- Diagnostics are best-effort. Missing Docker logs, stopped Swift processes, or absent macOS unified logs should be reported as missing evidence, not as collector failure.
- GitHub Actions are disabled/manual-only by policy during this period. Local gate evidence plus review is the PR gate.
