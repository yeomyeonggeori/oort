# oort self-host — clone to sign-in (SELF_HOST.md)

> **English is the canon.** Korean: [`SELF_HOST.ko.md`](SELF_HOST.ko.md).
>
> **This document is enough.** Follow it to the end and you sign in, in a
> browser, to oort running on your machine, and you send a message.
> At the start you pick one image source: a **local build** of the current
> checkout, or a **digest pull** of the published image pinned to an
> immutable digest. Both bring up the same Rust stack; the script refuses to
> mix the two paths.
> This quickstart's PostgreSQL named volume is **not a production backup**.
> Public operation and upgrades require a separate pgBackRest/WAL/PITR
> procedure and fresh signed evidence
> ([ops runbook](runbooks/pgbackrest-pitr.md)).
> To take data as a file from a Grok Bot VM or a personal instance, use
> [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md)
> (`scripts/self_host_pg_dump.sh`) — it is not a substitute for PITR.
> Attachment bytes live outside Postgres. Take the dump **and** the archive
> volume (`DRIVE_VOLUME_NAME`, default `oort-drive`) together (see
> [Attachment archive](#attachment-archive) below).
>
> Time is not a promise. Local mode bakes the image from scratch; digest mode
> fetches it from the registry. What this document promises is the
> **result**: after 1–4 the screen is there, and after
> [5](#5-make-an-agent-answer-ai-link) an agent answers. External tools such
> as Claude Code or CI use agent credentials from
> [6](#6-external-tools-claude-code--ci), not a human login token.
>
> Evidence: re-measured 2026-08-10 (#1229). A clean clone, this document
> followed as written, reached a browser round-trip, and **ad-lib steps not
> in the document: 0**. The prior measurement that same day
> (`docs/planning/research/2026-08-10-buzz-audit-C.md`) was 6.
>
> After sign-in — create a workspace, issue a web GUI invite, join a second
> user (web + `oort://join`), AI link GUI, first mention — is
> [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md) (#1608). This document
> is the clone→sign-in (+ the two keys) canon. The path where an agent
> installs on the user's own VM (that user's account only) is
> [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md).

---

## Prerequisites

| You need | Check |
|---|---|
| Docker Engine + Compose v2 | `docker compose version` |
| git | `git --version` |

**Nothing else.** Do not install Rust, Node, or `psql` — the server, relay,
worker, migration runner, and web UI all live in one image, and compose
brings PostgreSQL and Centrifugo. No domain, TLS certificate, or external
API key is required on this path (attaching a domain is
[§Open on a public origin](#open-on-a-public-origin), a separate
procedure).

---

## 1. Clone

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
```

> The repository is public today, so clone needs neither a GitHub login nor
> a personal access token. First publication of the public container still
> sits behind a separate owner-approval gate.

## 2. Choose an image mode and write env

Run **exactly one** of the following.

### A. Local build

```sh
scripts/self_host_env.sh --local-build
```

This builds `oort:local` from this checkout's `server-rust/Dockerfile`.
Rust and Node do not need to be installed on the host; they run only inside
the Docker build stages.

### B. Published digest pull

The latest immutable digest is the committed
[`releases/latest.json`](../releases/latest.json); GitHub
[Releases](https://github.com/yeomyeonggeori/oort/releases) is the source.
Do not take a `latest` or `sha-<commit>` tag. **Receive only**
`ghcr.io/yeomyeonggeori/oort` pinned to an immutable digest (`sha256:`
prefix + 64 hex); a bad shape fails before env is written. If the manifest
is missing, use A.

Read the app list digest from the manifest — do not write hex into prose
again.

```sh
IMAGE_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

Without a checkout, the raw URL:

```sh
IMAGE_REF="$(curl -fsSL https://raw.githubusercontent.com/yeomyeonggeori/oort/main/releases/latest.json | jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"')"
```

The postgres list digest for the same publication is the manifest
`images.postgres` row. Pass only the app row to `--published-image`. The
postgres row is for the Release table and the ops/PITR path; it is not a
value this document's compose postgres service consumes.

```sh
jq -r '
  "app\t\(.images.app.ref)@\(.images.app.digest_list)",
  "PostgreSQL 18 + pgBackRest\t\(.images.postgres.ref)@\(.images.postgres.digest_list)"
' releases/latest.json
```

A public publication is a `linux/amd64`+`linux/arm64` **manifest list**.
The manifest `digest_list` is that list digest; one pin covers both
architectures. Apple Silicon and ARM servers native-pull this pin. The
first public publication v0.1.0 (`main=45a154d2`) was amd64-only, and a
native Apple Silicon pull of that digest was impossible (measured
2026-08-21). The operator pin is the list digest.

The publish workflow allows only a manual run of the `main` ref, and after
owner approval of the GitHub `release` Environment it attaches SLSA v1
provenance as OCI referrers on **per-arch digests and the manifest list
digest**. An attended setup/readback on 2026-08-12 confirmed the required
reviewer is `kwakseongjae` (user id `87296259`), `prevent_self_review=false`,
and the deployment branch policy is a single custom `main` branch. `sha-*`
tags are movable markers for finding a commit, not an immutable identity.
The operator pin is the list digest. Verify the digest itself like this
(optional step for operators who have `gh`):

```sh
gh attestation verify "oci://$IMAGE_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

The first multi-arch publication and the public GHCR round-trip (publish ·
anonymous inspect · two attestations) is measured complete against the
**v0.1.1 list digest**. Coordinates: Release
[v0.1.1](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.1),
build commit `main=1b79bc65`, anonymous inspect PASS, amd64+arm64 included,
two attestations PASS (orchestrator 2026-08-23). (Former `SELF_HOST.md:88`
`runtime-unverified` wording.) Procedure canon:
[`RELEASING.md`](RELEASING.md). This document does not grant release
authority.

It writes `infra/rust/local.secrets.env` — a file with **no blanks to fill
in**. It creates nine secrets with `openssl`, writes values that must match
(runtime-role passwords and the passwords inside connection URLs) the same,
and if a port is already taken it picks the next free one and tells you.
It also records the **first login account** and the chosen
`MOMO_SELF_HOST_MODE`.

Every value that goes from environment to file is first checked as a
one-line scalar. A value containing LF/CR, a duplicate env key, or a port
outside 1..65535 or not ASCII decimal fails before the file is written or
any shell arithmetic runs. Email and password accept only a literal form
that Compose dotenv will not re-interpret as interpolation, quoting, or
comment, and the password is 12..128 characters. An existing env must pass
the same checks again. The boundary that POSIX argv/env cannot express NUL
is pinned in the script comments and the contract tests. Errors and stdout
never print the password.

At the end it prints something like this — the next two steps are all here:

```
[self-host] infra/rust/local.secrets.env 를 만들었다 (권한 600).

[self-host] 준비됐다. 모드: 로컬 빌드 — 현재 checkout을 server-rust/Dockerfile로 짓는다.
[self-host] 다음 한 줄이 스택을 띄운다:

  scripts/self_host_env.sh --compose up -d --build --wait

[self-host] --wait 가 붙어 있으므로 그 명령이 끝나면 준비가 끝난 것이다.
[self-host] 주의: 이 quickstart는 로컬 named volume만 사용하며 production 백업/PITR가 아니다.
[self-host] 브라우저에서 열고 아래로 로그인한다:

  http://localhost:8088
  email    owner@oort.local
  password infra/rust/local.secrets.env 의 MOMO_INITIAL_OWNER_PASSWORD 값
```

The password is not on stdout; it lives only in the file
(`infra/rust/local.secrets.env`, mode 600, not a commit target). This
script **never overwrites the file if it already exists** — regenerating
secrets against an already-migrated DB would desync from that DB. Run it
again and it only re-shows the path of the file that already holds the
email and password. Duplicate keys in an existing file, or a different
mode/digest than the existing env, fail instead of changing quietly.

## 3. Bring-up

Paste the command step 2 printed, as-is. Going through `--compose` is
required. It strips every real key of the generated env, every
interpolation key of the canonical Compose files, and control keys such as
`COMPOSE_FILE`·`COMPOSE_PROFILES` from the process env, then invokes the
canon env/file set. Caller config-source override arguments and Compose
global control arguments are also rejected fail-closed. `DOCKER_HOST`·
`DOCKER_CONTEXT` are the operator-chosen daemon authority and are
preserved. This launcher's canon files are
`infra/rust/docker-compose.rust.yml`,
`infra/rust/docker-compose.rust.build.yml`,
`infra/rust/local.override.yml`. Local mode looks like this.

```sh
scripts/self_host_env.sh --compose up -d --build --wait
```

Digest mode has neither the build overlay nor `--build`. The script prints
this command:

```sh
scripts/self_host_env.sh --compose up -d --pull missing --wait
```

`--wait` is attached, so **the command having finished means ready**. In
order, what happens in between: image build or pull → PostgreSQL up →
least-privilege runtime roles created → all migrations applied (+ a 2-pass
idempotence check) → first login account created → api·relay·agent-worker·
web edge up.

This path **explicitly** records `MOMO_MIGRATE_ENV=development` and
evidence-gate-off in the generated env, and migrate logs the same fact as a
warning. The API's `MOMO_ENV=staging` security posture is unchanged. Do not
copy this local exception into operations: staging/production migrate fails
unless exactly one of signed PITR evidence not older than 15 minutes, or a
one-shot bootstrap probe of a truly empty DB, is present.

## 4. Sign in

Open the address step 2 printed — default **`http://localhost:8088`** — in
a browser. The sign-in screen shows three fields; fill two of them.

| Field on screen | Put this |
|---|---|
| **서버 주소** (optional) | **Leave it empty.** The address that served this page *is* this server — the hint under the field says so: 「비워 두면 이 페이지를 제공한 주소로 연결합니다」 |
| **이메일** (required) | The address step 2 told you (default `owner@oort.local`) |
| **비밀번호** (required) | `MOMO_INITIAL_OWNER_PASSWORD` in `infra/rust/local.secrets.env` — the script never prints this value, so read it from the file |

**You do not need to find a workspace field.** It is not open on the
screen — it sits behind the folded line `다른 워크스페이스로 로그인`, and
there is no reason to expand it on a self-host first run (expanding it and
leaving it empty is the same result). The label when expanded is
`워크스페이스 ID`, and the only value it accepts is **one UUID**. That
field is for after a server has several workspaces; the UUID to put in then
is on **설정 › 계정** after you sign in.

Press `로그인` and a screen with the channel list (`agent-lab` · `general`
— the list shows the name without `#`) appears. Pick any channel, send a
message, and it shows up in place. **You're in.**

## 5. Make an agent answer (AI link)

Through step 4 this is a **messenger among people**. If you create an agent
and mention it and get no answer, that is not a break — **you have not given
it a key yet**. This section is that one step.

### You are this instance's operator

The env step 2 wrote contains this line:

```
PLATFORM_ADMIN_EMAILS=owner@oort.local     # = MOMO_INITIAL_OWNER_EMAIL
```

That is the declaration 「the first owner of this instance is this
instance's operator」, and it is why **설정 › AI 연결** and workspace
creation open. The authorization rule itself is unchanged (MOMO-583:
instance-global surfaces open only to a `platform:read` token **or** an
owner/admin whose verified email is listed here). The self-host stack has
no way to issue a `platform:read` token, so without this line that surface
opens to **nobody** — including the person who installed it. What the
screen shows then is a single 403, and the agent stays quietly silent.

To add operators, join addresses with commas (`a@example.com,b@example.com`).
Each address must be a real owner/admin on this instance, and the email
must be **verified**.

### Put the key in

In the browser open **설정 › AI 연결** and put in the OpenAI-compatible
endpoint URL and the key. The same work can be done over REST (`<port>` is
the value step 2 told you):

```sh
TOKEN=$(curl -sS -X POST http://localhost:8088/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@oort.local","password":"<MOMO_INITIAL_OWNER_PASSWORD>"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

curl -sS -X PUT http://localhost:8088/v1/provider/link \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.example.com/v1","bearer":"<키>"}'
```

The key is stored **encrypted** in this server's DB
(`PROVIDER_LINK_MASTER_KEY`); the response and the screen return only the
last four digits. The endpoint today must be an **external `https://`**
address — the path that attaches a local model on the laptop
(`http://127.0.0.1:...`) is not open yet.

Then create an agent (agent directory → new agent), invite it to a channel,
and call it with `@handle`. When an answer arrives, that is everything this
document promised.

### What takes effect immediately and what needs a restart

It splits on one line. **The key is a row; the allowlist is process env.**

| What you changed | Takes effect | Why |
|---|---|---|
| provider key (the PUT / GUI above) | **Immediately** — from the next job, within 2 seconds at latest | It is a DB row and the worker re-reads it on a 2 s cache. **Restart is not forbidden; it is unnecessary** |
| `PLATFORM_ADMIN_EMAILS` | **api restart** (`oort up -d`) | Read from process env at boot |

An env made before step 2 has no that line. For such a file,
`scripts/self_host_env.sh` **appends only that line** on the next run — it
does not regenerate any secret (doing so would desync from an already
migrated DB). After the append, restart api with `oort up -d`.

## 6. External tools (Claude Code · CI)

Do not put a human login token into Claude Code or CI. That token dies in
**15 minutes**, and a refresh is discarded after one use — it is for a
browser session. Put the external tool in as an **agent member**, issue a
long-lived credential once, and let the tool keep it (ADR-0101). The
recommendation is this section's generic credential, not hosted pairing
(Grok Bot).

Prerequisite: [4](#4-sign-in) is done and you are in as workspace owner.
If you have not created an agent yet, create one from the directory
(display name · handle · model · gateway URL). There is no API-key field
on the form — that is correct (ADR-0004). Invite that agent to a channel.
If you only need the **tool to write**, the invite is enough; no mention
required.

`<port>` below is the value step 2 told you (default web `8088`). Keep
passwords and tokens in shell variables, not on the screen.

```sh
OORT=http://localhost:<port>
WS='<설정 › 계정에 있는 워크스페이스 UUID>'
AGENT='<에이전트 멤버 UUID>'
CHANNEL='<글을 올릴 채널 UUID>'

HUMAN=$(curl -sS -X POST "$OORT/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"owner@oort.local\",\"password\":\"<MOMO_INITIAL_OWNER_PASSWORD>\",\"workspace\":\"$WS\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

# The plaintext exists only in this response. The list API returns metadata only.
curl -sS -X POST "$OORT/v1/workspaces/$WS/agents/$AGENT/credentials" \
  -H "Authorization: Bearer $HUMAN" -H 'Content-Type: application/json' \
  -d '{"label":"claude-code","scopes":["messages:write","messages:read"]}'
```

Put the response `token` line in the tool env, and drop the human `HUMAN`
variable. Example of writing a message with that credential:

```sh
curl -sS -X POST "$OORT/v1/workspaces/$WS/channels/$CHANNEL/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"clientMsgId\":\"$(uuidgen | tr '[:upper:]' '[:lower:]')\",\"type\":\"text\",\"body\":\"hello from an external tool\"}"
```

A 201 leaves a post in that channel under the agent's name. If you also
included `messages:read`, history `GET` and thread replies `GET` for
channels that agent is a member of are 200. This scope is non-default, so
omitting it at issue time makes reads 403 (ADR-0173). Credentials are
long-lived if you do not set an expiry; re-issuing kills the previous
value after a one-day grace (default). Revoke with
`POST …/credentials/{id}/revoke`.

**What does not work today.** Single-message `GET` · replies `POST` ·
search are closed. A hosted credential is 403 for the entire REST surface
— Agent Port MCP isolation (ADR-0162) is unchanged. Hitting generic issue
on a hosted-connection-only member returns `409 hosted_connection_managed`
— that member mints credentials only from the pairing screen.

Evidence and ruling: [EXT-1 credential research](planning/research/2026-08-27-ext1-agent-credential-external-tools.md)
(#1797) · [ADR-0173](adr/0173-external-tool-message-read.md).

---

## What just came up

```text
browser ── http://localhost:8088 ──> web (Caddy, same-origin edge)
                                        ├── /            SPA (bundle inside the image)
                                        ├── /v1/*        ──> api
                                        └── /connection  ──> centrifugo
api ── transaction ──> PostgreSQL 18 (source of truth: message + seq + outbox)
                                          │
centrifugo (transport only) <── publish ── relay ┘
```

There is one write path: `REST → PostgreSQL commit → transactional outbox →
relay publish`. What defines channel order is `message.seq`, not a
transport offset. The full contract is the
[architecture overview](architecture/overview.md).

That the browser knows **one port only** is this path's design — SPA, REST,
and realtime all come from the same origin, so CORS has no room to arise,
and the realtime URL is the value the login response returns, which the
client uses as-is (ADR-0110).

## Using two checkouts at once

The default compose project name is `oort`, and the PostgreSQL named volume
is `oort-pgdata`. Those names are **bound to the project name, not the
checkout path.** After bringing a stack up from clone A, `--compose up`
from clone B with the same defaults used to recreate A's containers with
no warning, and even renaming the project to `oort-b` still started
PostgreSQL **twice against the same data directory** if the volume string
matched (#1613).

Now, before bring-up, the live container's
`com.docker.compose.project.working_dir` label is compared with this
checkout path. If another directory's stack is using the same project or
the same `DB_VOLUME_NAME`, `--compose up` / `down` is refused and the
cause and the fix are printed. **`up` again from the same checkout**
(resuming your stack) still works with no warning.

To separate, change **both lines** in env together. Changing only the
project name keeps sharing the volume:

```sh
# infra/rust/local.secrets.env — example. If the file already exists, do not
# regenerate secrets; edit only these two lines, confirm the other checkout's
# stack is down, then up.
COMPOSE_PROJECT_NAME=oort-lab
DB_VOLUME_NAME=oort-lab-pgdata
```

For this clone to inherit existing `oort-pgdata` data, keep the default
names (`oort` / `oort-pgdata`) and **`down` the other checkout first**
(leave the volume). An upgrade does not delete the volume or swap in a
new empty one. The meaning of `down -v` is unchanged: it deletes **the
volume this env points at**. The attachment archive volume
(`DRIVE_VOLUME_NAME`, default `oort-drive`) follows the same rule —
change it when you change the project name.

## Attachment archive

A generated self-host env defaults to `MOMO_DRIVE_ARCHIVE_BACKEND=local`
and `MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive` (ADR-0169). Attachment
bytes live not in Postgres but in that directory (compose named volume
`DRIVE_VOLUME_NAME`, default `oort-drive`). The filename is metadata only;
the disk path is an opaque id the server made. A Google Workspace SA is
not needed on this path. `stub` is refused at boot when
`MOMO_ENV=staging`.

If an existing env is missing these keys, `scripts/self_host_env.sh`
**appends only those lines** — it does not regenerate secrets. Taking
effect needs an api restart
(`scripts/self_host_env.sh --compose up -d`). Leave the values empty and
attachments are 503 `Drive archive is not configured`, as before. A fresh
named volume is created root-owned. `drive-init` in `local.override.yml`
chowns the mount point to uid 10001 on first start — it does not ignore a
write failure; api comes up only after permissions are fixed.

**Backup target.** `pg_dump` takes messages and members only. To keep
attachment files, copy the archive volume at the same moment. One-line
procedure:
[`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

## Link previews (unfurl)

The server fetches title · description · image of http(s) links on a
message and advertises them as a card (ADR-0170). **Default is off.** Leave
it that way if you want conservative self-host egress.

To turn it on, put one line in env and restart `webhook-sender`:

```sh
MOMO_UNFURL_ENABLED=1
```

A workspace admin can turn fetch itself off per tenant with
`PUT /v1/workspaces/{id}/unfurl-settings` (this is not render-only). The
author deletes the card on their own message with
`DELETE …/messages/{id}/unfurls` — a deleted card is not made again.

**P9 boundary.** The server reads only the link *target*. This is not a
path that reads the message body for notification decisions or agent
context. It takes the URL string and fetches OG/Twitter tags; human
authors and agent authors share the same path. Private networks,
link-local, and loopback are refused every hop by the existing
OutboundHTTPPolicy. Preview images pass only through the server proxy —
the browser does not attach directly to an arbitrary host.

## Huddle (voice)

When the huddle profile (`huddle`) is on, the IP LiveKit advertises for ICE
is `MOMO_LIVEKIT_NODE_IP`. A local browser uses `127.0.0.1` (generated-env
default); a LAN or remote client uses that host's client-reachable IP;
unset, the container auto-detects a bridge IP that is usually unreachable
from outside.

## Phone push

Dawn-operated APNs (the App Store app) needs three keys on the self-host
server. The server never holds Apple's `.p8`. Generate the identity with
`scripts/push_relay_keygen.sh`, give Dawn the server id plus the public
key, and set:

| key | where |
|---|---|
| `PUSH_RELAY_URL` | Dawn's `/v1/push` |
| `PUSH_RELAY_SERVER_ID` | the id Dawn registered |
| `MOMO_RELAY_SIGNING_KEY_HOST_PATH` | host path of the Ed25519 private key |

Own Apple account / own app build uses the same image with
`infra/rust/docker-compose.push.yml` (`command: ["push-relay"]`) and a
mounted `.p8`. Local stub never contacts Apple and refuses to boot without
`MOMO_APNS_ALLOW_STUB=1`. Contract: [docs/PUSH_RELAY_RUNBOOK.md](PUSH_RELAY_RUNBOOK.md).

`scripts/oort doctor` treats the overlay as configured when compose lists
`push-relay`/`notifier` or the overlay keys are set; pending `push_candidate`
rows then fail the outbox check instead of being ignored.

## Stop · wipe

The argument bundle from step 3 is long, so from here it is written as one
function. From the repo root, paste **only the one line for the mode you
chose** (it is a function, not a variable, on purpose — zsh does not split
variables into words):

```sh
# Shared by both modes — env MOMO_SELF_HOST_MODE picks the canonical file set.
oort() { scripts/self_host_env.sh --compose "$@"; }
```

```sh
# Stop (data stays)
oort down

# Bring it back
oort up -d --wait

# See what happened
oort logs api
oort logs migrate

# Wipe the data too — messages, accounts, and the volume go. This cannot be undone.
oort down -v
```

After a `down -v` wipe, to start over, also delete
`infra/rust/local.secrets.env` and walk from step 2 again (a new DB matches
new secrets). Do not try to wipe another checkout's stack with this tree's
`--compose down -v` — a live other checkout using the same project/volume
is refused ([two checkouts](#using-two-checkouts-at-once)).

## When stuck

| Symptom | Cause and action |
|---|---|
| Judge first whether the install is stuck | `scripts/oort doctor` (`--json` if you need it). Tools, env, and stack as one verdict. If the stack is not up yet those checks skip and only the env side is judged. |
| Day-2: is this stack healthy, current, behind? | `scripts/oort status` (`--json` if you need it). Same exit codes as doctor, plus image digest vs `releases/latest.json`. |
| Day-2: read service logs without leaking secrets | `scripts/oort logs` `[service] [--since 10m] [--follow]`. Env secret keys, Bearer tokens, and postgres URL passwords are `***`. |
| Day-2: replace the image (Update / new digest) | `scripts/oort upgrade` (`--to <image ref pinned by its list digest, read from releases/latest.json>` or `--manifest URL` or `--local-build`). Backs up first, refuses missing env/volumes, waits for `IDEMPOTENCY_OK`, then doctor PASS. Prints a rollback command on failure; never auto-rolls back; never `down -v`. |
| Day-2: take or restore a dump | `scripts/oort backup` (`--out DIR`) and `scripts/oort restore <dump>`. Restore refuses a non-empty stack. If `momo_app`/`momo_relay`/`momo_worker` are absent it runs the stack's `runtime-roles` one-shot first, then `scripts/self_host_pg_restore.sh`. |
| Day-2: invite a human or issue an agent bearer | `scripts/oort member invite` and `scripts/oort member credential --agent <handle>`. The invite code and agent token print once. |
| Step 3 fails with `port is already allocated` | Something grabbed that port after step 2. `down`, change `MOMO_WEB_PORT` in `local.secrets.env`, `up` again. |
| Sign-in says `invalid credentials` | Use the values step 2 told you (`grep MOMO_INITIAL_OWNER infra/rust/local.secrets.env`). To change the password, the rotate command below. |
| The screen comes up but messages do not arrive in realtime | Check outbox first (query below). `broadcast \| done` means the server side is finished; look at the browser (`oort logs api`). `pending`/`failed` is relay (`oort logs relay`). |
| 설정 › AI 연결 is **403** | This instance has no listed operator. `grep PLATFORM_ADMIN_EMAILS infra/rust/local.secrets.env` — if the line is missing, re-run `scripts/self_host_env.sh --local-build` (or the mode you chose) and it appends only that line. Then restart api with `oort up -d`. [§5](#5-make-an-agent-answer-ai-link). |
| 설정 › AI 연결 is **503** | api came up without `PROVIDER_LINK_MASTER_KEY`. The env step 2 wrote has it — if you are using a hand-made env, fill that line and `oort up -d`. |
| You created an agent and it does not answer | You have not put the key in yet (§5), or the endpoint you put in does not respond. If the channel shows a 「응답하지 못했습니다」-style message, it is the latter (`oort logs agent-worker`). |
| `--compose up` refuses because another checkout uses the same project/volume | `down` on that checkout (leave the volume), or change this clone's `COMPOSE_PROJECT_NAME` and `DB_VOLUME_NAME` **together**. [Two checkouts](#using-two-checkouts-at-once). |
| After an upgrade, sign-in fails and the DB looks empty | The new env may be pointing at a volume that is not `oort-pgdata`. The data was not deleted — confirm `oort-pgdata` with `docker volume ls`, then adopt `DB_VOLUME_NAME=oort-pgdata` or recreate env with the default project name `oort`. |
| An ACME order appears (Let's Encrypt) | `OORT_SITE_ADDRESS` is someone else's host, not this one. The public template refuses to start if that key is unset. On local, do not name `caddy.override.yml`. |
| You want to start from scratch | `down -v` + `rm infra/rust/local.secrets.env` + from step 2. |

Query to see whether a message actually reached the rail (`broadcast | done`
is healthy):

```sh
oort exec postgres psql -U momo -d momo \
  -c "SELECT kind, status, count(*) FROM outbox GROUP BY 1,2;"
```

Relay does **not log** a successful publish (the happy path is quiet). So
the answer to 「did relay work」 is the query above, not the logs.

Password rotate (intentional change — every session is signed out):

```sh
MOMO_INITIAL_OWNER_EMAIL=owner@oort.local \
MOMO_INITIAL_OWNER_PASSWORD='<새 비밀번호>' \
  oort run --rm -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD migrate set-owner
```

Deeper (how to read migration logs, proving a round-trip with Centrifugo
history, the env-parity table, troubleshooting) lives in
[`infra/rust/README.md`](../infra/rust/README.md). This document is 「the
first time」; that document is 「everything after」.

## Tunnels and external exposure

This document's edge is loopback. When a remote client attaches through a
tunnel such as Tailscale or cloudflared, the symptom that login REST works
but only realtime dies is that the generator used to advertise the old
default `ws://localhost:<port>/connection/websocket` (ADR-0167). A new env
has `MOMO_CENTRIFUGO_WS_URL=same-origin`, so the login response derives
`wss://<public-host>/connection/websocket` from the request `Host`.

Idempotently add the public origin to the Centrifugo allowlist, then
restart the stack. The default localhost / 127.0.0.1 / tauri Origin stay.

```sh
scripts/self_host_env.sh --public-origin https://<공개호스트>
scripts/self_host_env.sh --compose up -d
```

Verify: login response `realtimeWebSocketUrl` ==
`wss://<공개호스트>/connection/websocket`. If an already-made env still
holds a loopback URL, change that one line to `same-origin`. Regenerating
the secrets file is forbidden.

## Open on a public origin

The edge on the path above is loopback (`Caddyfile.local`, `:80`, no ACME).
To attach TLS on a public host, **the same generator** derives the site
address and the CSP connect-src. The canon key names are
`oort_public_edge_env_keys` in `scripts/self_host_env.sh`
(`OORT_SITE_ADDRESS` · `OORT_CSP_CONNECT_SRC`). Do not type them by hand.

```sh
scripts/self_host_env.sh --public-origin https://<host>
```

The same call also updates the Centrifugo allowlist and the drive base URL
(existing rules). A wildcard origin (`https://*.example.test` and the like)
is refused (#1792). Run without `--public-origin` and the two keys are not
written — the local loopback path stays as-is.

The public overlay passes that env into the container. Empty env makes
compose/`caddy validate` fail. That is the actual ACME misfire block. Start
this overlay **only on a machine that holds DNS for that host**. Do not
name it on local. `--compose` cannot change the canonical file set, so on
the deploy host call compose directly for the public overlay:

```sh
docker compose --env-file infra/rust/local.secrets.env \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/caddy.override.yml up -d
```

The public template is verified only with `caddy adapt` / `caddy validate`.
Do not bring containers up against a real host that is not a fixture host
and order ACME.

| | Local (this document's default) | Public origin |
|---|---|---|
| Edge | `local.override.yml` + `Caddyfile.local` (`:80`) | `caddy.override.yml` + `Caddyfile` (`{$OORT_SITE_ADDRESS}`) |
| Address | `http://localhost:<port>` | Operator-declared `https://<host>` |
| CSP connect-src | loopback `ws://localhost:*` / `ws://127.0.0.1:*` | `OORT_CSP_CONNECT_SRC` derived by `--public-origin` |

Hardening, backup, upgrade, and multi-workspace operations:
[`docs/DEPLOY.md`](DEPLOY.md); the pgBackRest closed loop and migrate gate:
[`docs/runbooks/pgbackrest-pitr.md`](runbooks/pgbackrest-pitr.md).
The retired NCP runbook remains as historical record only in
[`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md).
