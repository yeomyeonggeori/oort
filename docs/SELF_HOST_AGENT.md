# oort agent self-host playbook (SELF_HOST_AGENT.md)

> **English is the canon.** Korean: [`SELF_HOST_AGENT.ko.md`](SELF_HOST_AGENT.ko.md).
>
> **This document is the product.** An agent working on the **user's own
> machine**, under the **user's own instruction**, reads this file and brings
> oort up without a human at the terminal. The human opens a browser.
>
> Readers of this playbook are operators, not a particular product. Example
> harnesses (a list, not a dependency): Claude Code, Codex, Grok Bot, any
> OpenAI-compatible operator. A sentence that only works on one of those names
> does not belong outside §3.3.
>
> A human walking a laptop themselves uses [`SELF_HOST.md`](SELF_HOST.md).
> The day after login (workspace, invites, AI link, first mention) is
> [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md). Dump and restore:
> [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

This document is not legal advice. Do not paste passwords, pairing/claim
secrets, `DATABASE_URL`, or doorbell sender keys into chat, issues, or
screenshots (ADR-0004). A claim URL is sent to the user **once**.

---

## 0. Contract

Do this work **only on the user's own machine and account**. Do not use a
shared team or demo host. The agent is the operator following this playbook
in a shell on that machine.

**Never:**

- leave the user's machine or account
- paste secrets into chat (passwords, pairing/active credentials, claim
  tokens, doorbell keys, session tokens, `DATABASE_URL`)
- control apps by automation (selectors, remote debugging, scripted UI)
- run ACME / Let's Encrypt against a host this machine does not own
- name `caddy.override.yml` or the production `Caddyfile` on a loopback
  install (that overlay orders certificates)
- set `DOCKER_DEFAULT_PLATFORM=linux/amd64` globally (V-1: the local
  Centrifugo index refuses that pin)
- run `down -v` against a volume that still holds data you need
- bypass a failed claim with `MOMO_INITIAL_OWNER_PASSWORD` (ADR-0004, ADR-0166)
- treat a web browser on a tunnel URL as the standing v1 client (v1 is the
  desktop app; Local machine loopback in a browser is the exception in §3.1)
- write `MOMO_DOORBELL_ENABLED` or `MOMO_HOSTED_DELIVERY_ENABLED` as `True` /
  `1` / `yes` / `on` (only lowercase `true` opens those gates)

**Always:** pin images by reading [`releases/latest.json`](../releases/latest.json)
with a command. Never paste a digest or a version number into this file or
into chat. `latest` and `sha-*` tags are not an identity.

Doctor is the install verdict. Exit codes: **0** pass, **1** major-only,
**2** any blocker. `--strict` promotes major to 2. JSON shape:

```sh
scripts/oort doctor --json
```

The machine report is `{ "summary": { "pass", "fail", "skip", "verdict" },
"checks": [ { "id", "severity", "status", "detail", "fix" } ] }`.
**PASS** means `summary.verdict` is `PASS` (no blocker fail, no major fail).
`skip` does not fail the verdict. Secrets are never printed.

Human playbook (same stack, longer prose): [`SELF_HOST.md`](SELF_HOST.md).

---

## 1. Choose your environment

Pick **one** row. Then do §2 (shared core). Then the matching §3 branch.
Do not mix edges (loopback `Caddyfile.local` vs public `Caddyfile`).

| | Local machine | VPS with own domain | Grok Bot VM (Tailscale Funnel) | Railway | Fly | AWS | GCP |
|---|---|---|---|---|---|---|---|
| **Prerequisites** | Docker Engine + Compose v2, git, jq, openssl, curl. ≥ 1 GiB free (2 GiB better). | Same, plus DNS for a host this machine owns. | curl, tar, Docker Engine + Compose v2, openssl, jq. git is not required. Durable dir `/workspace`. Tailscale account (one). | Docker-capable runtime. Template lands in SH-5a; until then follow §3.2. | Same as VPS until SH-5b `fly.toml`. | VM + compose + domain (SH-5b). | Same as AWS. |
| **Edge** | `local.override.yml` + `Caddyfile.local` (`:80`, no ACME). | `caddy.override.yml` + `Caddyfile` (`{$OORT_SITE_ADDRESS}`). Keys `OORT_SITE_ADDRESS` and `OORT_CSP_CONNECT_SRC` are derived by `scripts/self_host_env.sh --public-origin` — do not type them by hand. | Loopback Caddy + Tailscale Funnel to the web port. **Do not** start `caddy.override.yml` here (ACME). `--public-origin` still registers the Funnel URL in Centrifugo. | Public origin of the platform domain, same two env keys as VPS. | Same as VPS. | Same as VPS. | Same as VPS. |
| **URL model** | `http://127.0.0.1:<MOMO_WEB_PORT>` (generator default 8088 if free). | Operator-declared `https://<host>`. | `https://<machine>.<tailnet>.ts.net` while Funnel state under `/workspace` lives. | Platform hostname. | Fly hostname or custom domain. | Operator domain. | Operator domain. |
| **Accounts** | None beyond this machine. | DNS for the domain. | Tailscale (one). Zero-account + stable URL is **not** something this playbook delivers (RA-7). | Platform account (SH-5a). | Fly account (SH-5b). | Cloud account (SH-5b). | Same. |
| **Doctor** | `scripts/oort doctor --json` after up. `public.*` skip is OK. | Same, then again after the public overlay: `public.healthz` and `public.websocket` must pass. | Same after Funnel + `--public-origin`. `public.*` must pass against the Funnel origin. | Same as VPS once a public origin exists. | Same. | Same. | Same. |
| **Done means** | Doctor `summary.verdict=PASS` and a browser (or login API) session as `owner@oort.local`. | Doctor PASS including public checks, HTTPS login. | Doctor PASS including public checks, one-time claim URL sent to the user, first-day dump on `/workspace`. | Doctor PASS on the deployed origin (SH-5a). | Same. | Same. | Same. |

Desktop Tauri Origins (`tauri://localhost`, `http://tauri.localhost`) are on the
self-host allow list. Opening the **public** URL from a browser or RN needs
that origin in Centrifugo (§3.2 / §3.3.9). Login responses advertise
`realtimeWebSocketUrl` from `MOMO_CENTRIFUGO_WS_URL=same-origin` (ADR-0167)
via request `Host` / `X-Forwarded-Proto`.

---

## 2. Core install

Every phase ends with a gate. If the gate fails, **stop**. Do not invent a
password and send it to chat.

Password login (§2.6) is the default. Claim bootstrap is **only** the Grok
Bot VM branch (§3.3.3) — it is mutually exclusive with
`MOMO_INITIAL_OWNER_PASSWORD` (ADR-0166).

### 2.1 Get the tree

If this file is already at the repo root of the working directory, use that
directory. Otherwise:

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
```

Put the clone where Docker can bind-mount files. On Docker Desktop (macOS),
that is almost always a path under the user's home — not `/tmp`. A `/tmp`
checkout fails later when compose bind-mounts `infra/rust/Caddyfile.local`.

This playbook lands on `track/engine` until it is promoted. If the default
clone does not yet contain `scripts/oort`, check out `track/engine`.

**Gate:** `test -x scripts/oort && test -f releases/latest.json`.

```sh
scripts/oort doctor --json
```

Before env exists, `env.exists` is skip (preflight). `tool.docker`,
`tool.compose`, `tool.jq`, `tool.openssl` must **pass**. Disk under 1 GiB is
a blocker. Do not continue on doctor exit 2.

### 2.2 Choose image mode

Exactly one. Both consume the same Rust stack; the generator refuses to mix
them.

**Published digest (default for a paste-in agent).** Canon is
[`releases/latest.json`](../releases/latest.json) (GitHub Releases is the
source). Do not pull `latest` or `sha-*`. Pin only an immutable
`ghcr.io/yeomyeonggeori/oort` digest (`sha256:` prefix + 64 hex) — the
generator rejects a bad form before writing env. Read the list digest with a
command; do not copy hex into prose.

```sh
jq -r '
  "app\t\(.images.app.ref)@\(.images.app.digest_list)",
  "PostgreSQL 18 + pgBackRest\t\(.images.postgres.ref)@\(.images.postgres.digest_list)"
' releases/latest.json
```

The postgres row is for the Release table and ops/PITR. **This playbook's
compose postgres service does not consume it.** Pin the app only.

Public images are a `linux/amd64`+`linux/arm64` **manifest list**.
`digest_list` is that list digest. Apple Silicon and amd64 pull native. Do not
set global `DOCKER_DEFAULT_PLATFORM`.

```sh
IMAGE_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
docker pull "$IMAGE_REF"
```

**Gate:** `docker image inspect "$IMAGE_REF"` succeeds.

If there is no checkout yet, the same JSON is on the default branch:

```sh
IMAGE_REF="$(curl -fsSL https://raw.githubusercontent.com/yeomyeonggeori/oort/main/releases/latest.json | jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"')"
```

Optional (operator with `gh`):

```sh
gh attestation verify "oci://$IMAGE_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

The exact `verify_cmd` string also lives in `releases/latest.json` under
`attestation.verify_cmd`. Doctor records `env.attestation` as present, and
does not run it.

**Local build** — only when this checkout is the image you intend to run:

```sh
scripts/self_host_env.sh --local-build
```

That bakes `oort:local` from `server-rust/Dockerfile`. Rust and Node stay
inside the Docker build; they are not host packages.

### 2.3 Generate env

Published-image path (after §2.2 pull):

```sh
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

Local-build path is the `--local-build` line in §2.2 (it writes env too).
**Do not run both.**

The generator writes `infra/rust/local.secrets.env` (mode 600). There is
nothing to fill in. Nine secrets come from `openssl`. Role passwords and the
passwords inside `DATABASE_URL` values are written equal. If a default port
is taken, the next free port is chosen and printed. The first login account
and `MOMO_SELF_HOST_MODE` are recorded.

If this machine already has a live compose project named `oort`, generate with
a distinct project name so pgdata and the drive volume are not shared (#1613).
The generator derives `DB_VOLUME_NAME` and `DRIVE_VOLUME_NAME` from
`COMPOSE_PROJECT_NAME`:

```sh
COMPOSE_PROJECT_NAME=oort-local \
  scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

**Do not regenerate secrets** if the file already exists — a migrated DB will
not match new passwords. A second run reprints the file location only.

Never `cat` or `grep` the env file to stdout. Read a single key in the shell
when login needs it, and keep the value in a variable.

**Gate:**

```sh
scripts/oort doctor --json
```

`env.exists`, `env.mode` (0600), `env.required_keys`, `env.role_passwords`,
`env.platform_admin_emails`, `env.provider_link_master_key` must pass.
Stack checks skip until §2.4. Exit 2 → stop.

### 2.4 Up

Use the line the generator printed. `--compose` is required on the password
path. Typical published-image:

```sh
scripts/self_host_env.sh --compose up -d --pull missing --wait
```

Local-build:

```sh
scripts/self_host_env.sh --compose up -d --build --wait
```

`--wait` returning is "containers healthy", not the product gate. That is
§2.5.

This edge binds `127.0.0.1` (no TLS). A public IP on the box does not make
this stack reachable; VPS and Grok Bot branches add an edge in §3.

If `up` fails **after** postgres has initialized the volume, **keep this
env** and retry `--compose up -d --wait`. Do not generate a second env
against the same `COMPOSE_PROJECT_NAME` / `DB_VOLUME_NAME`. Leftover
pgdata plus new secrets is `password authentication failed for user "momo"`
and `runtime-roles` exit 1. To start over: `--compose down -v`, delete
`infra/rust/local.secrets.env`, then §2.3 again.

**Claim-mode exception:** `--compose` refuses an env with
`MOMO_BOOTSTRAP_CLAIM=1` and no password key. Only §3.3 uses that shape, and
it calls `docker compose` directly.

### 2.5 Gate: doctor PASS

```sh
scripts/oort doctor --json
```

**Gate:** `summary.verdict` is `PASS` and the process exit is 0.
`stack.healthz` is HTTP 200 with `database:ok`. `stack.agent_port` is POST
`/v1/mcp/agent-port` → 401 with `WWW-Authenticate: Bearer scope="agent:port:connect"`.
`stack.migrate_idempotency` sees `IDEMPOTENCY_OK`. `stack.outbox` has no
non-`done` rows.

If healthz is not 200, `scripts/self_host_env.sh --compose logs api` and stop.
If agent-port is not that 401, this image has no join surface — do not invent
a password.

### 2.6 Login

Open the URL the generator printed — default **`http://localhost:<MOMO_WEB_PORT>`**.

| Field on the login screen | What to put |
|---|---|
| **Server address** (optional) | **Leave empty.** The page already came from this server. |
| **Email** (required) | The address the generator printed (default `owner@oort.local`) |
| **Password** (required) | `MOMO_INITIAL_OWNER_PASSWORD` in `infra/rust/local.secrets.env`. Read the file; do not print the value to chat. |

There is no workspace field until you expand **Log in to another workspace**.
Skip that on a first self-host.

**Headless operator gate** (do not print the token or password):

```sh
ENV_FILE=infra/rust/local.secrets.env
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
OWNER_PASSWORD=$(awk -F= '$1=="MOMO_INITIAL_OWNER_PASSWORD"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
code=$(curl -sS -o /tmp/oort-login.body -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"owner@oort.local\",\"password\":\"${OWNER_PASSWORD}\"}" \
  "http://127.0.0.1:${WEB_PORT}/v1/auth/login")
unset OWNER_PASSWORD
test "$code" = 200
```

**Gate:** HTTP 200 and the body has `accessToken`. Discard the body. Channel
list after a browser login: `agent-lab` and `general`.

Claim login (`/claim/<token>`) is §3.3.5, not this section.

### 2.7 Send via webhook

Create an installation in **Settings → Webhooks** (`native` or `slack_compatible`). Native ingress is `POST /v1/webhooks/{workspace}/{installation}` with the HMAC headers on the one-time secret (ADR-0115). Slack-compatible ingress is `POST /hooks/{token}` with `{"text":"…"}` (`blocks` is 400). Unknown or revoked credentials return **404** with the same sentence on both routes; a bad HMAC is **401**. Body cap is 262144 bytes (413); per-installation rate limit is 429. The Slack-compatible public URL is `https://<origin>/hooks/<token>` (ADR-0115 D2).

---

## 3. Per-environment branches

Do §2 first unless a branch says otherwise (Grok Bot snapshot + claim).

### 3.1 Local machine

This is the D-4 default (paste into an agent on the user's laptop).

1. §2.1 clone (or this tree) → doctor preflight. On Docker Desktop, the
   clone must be a path the engine can bind-mount (usually under the
   user's home). `/tmp` on macOS is often **not** shared with the VM —
   compose then fails mounting `infra/rust/Caddyfile.local` ("not a
   directory"). Clone into `~/oort` (or another home path) instead.
2. §2.2 published digest (or `--local-build` if this checkout is the image).
3. §2.3 env. If `--compose up` later refuses because another checkout owns
   `oort`, re-generate only when the env file does **not** exist yet, with
   `COMPOSE_PROJECT_NAME` set as in §2.3. If the file already exists, set
   `COMPOSE_PROJECT_NAME`, `DB_VOLUME_NAME`, and `DRIVE_VOLUME_NAME`
   together without regenerating secrets ([SELF_HOST.md](SELF_HOST.md)
   "두 체크아웃을 같이 쓸 때").
4. §2.4 up.
5. **Gate:** `scripts/oort doctor --json` → `summary.verdict=PASS`.
6. §2.6 login in a browser. Loopback HTTP is the standing client here.

Do not start `caddy.override.yml`. Do not run `--public-origin` unless you
are leaving loopback (then you are in §3.2, not here).

**Done:** doctor PASS + login.

### 3.2 VPS with own domain

Own domain means the URL problem is gone. The agent does not pick a tunnel.

1. §2 on this VM (published digest). **Gate:** doctor PASS on loopback.
2. Point DNS A/AAAA at **this** machine. Do not order certificates for a
   name you do not control.
3. Register the origin **without regenerating secrets**. The same call
   derives `OORT_SITE_ADDRESS` and `OORT_CSP_CONNECT_SRC` (SH-2). Do not
   type those keys by hand. Wildcards (`https://*.example.test`) are
   rejected (#1792). `--public-origin` does not rewrite
   `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin` — that sentinel already
   covers a public host from request Host (#1788).

```sh
scripts/self_host_env.sh --public-origin https://<host>
```

4. `--compose` cannot change the canonical file set. Start the **public**
   overlay only on the machine that owns that DNS. Empty `OORT_SITE_ADDRESS`
   makes compose / `caddy validate` fail — that is the ACME misfire brake.
   Do not bring this overlay up on a laptop.

```sh
ENV_FILE=infra/rust/local.secrets.env
docker compose --env-file "$ENV_FILE" \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/caddy.override.yml up -d
```

5. **Gate:** `scripts/oort doctor --json` — `public.healthz` 200 and
   `public.websocket` 101. Login `realtimeWebSocketUrl` must be
   `wss://<host>/connection/websocket`. If it is `ws://localhost`, set
   `MOMO_CENTRIFUGO_WS_URL=same-origin` on the existing env (one line) and
   restart; **do not regenerate secrets**.

**Done:** doctor PASS including public checks.

### 3.3 Grok Bot VM (Tailscale Funnel)

Personal try-out on **this user's** vendor VM. Not a team server. Work and
standing use: take a dump (§3.3.18) onto a VPS.

Persistence is **durable-but-resettable** (RA-4): `/workspace` files survive;
Docker images and packages may vanish on Update. Reset is a snapshot
rollback. Postgres therefore bind-mounts under `/workspace` before first
`up`.

v1 reachability = **Tailscale Funnel** (the user's own tailnet, RA-7 M1).
Public address `https://<machine>.<tailnet>.ts.net`. If state under
`/workspace` lives, the URL survives re-provision. The invariant is "the URL
does not change" (interview). The agent runs the steps; the human only uses
a browser.

**M1 only.** The node joins the user's tailnet. Putting customer nodes on
an oort tailnet (RA-7 M2/M3) is a Tailscale ToS §2.1 / §2.3 hazard and
breaks self-host independence. Do not adopt it.

Success bar (interview → RA-7): **zero human terminal commands**, cold 15
minutes, recover 5 minutes. **Zero accounts is not achieved.** Funnel needs
a tailnet. The human clicks 4–5 times in a browser (sign-up / login / node
and Funnel approval; Disable key expiry is a recommended extra). Claim
password + app login are the §3.3.14 budget.

A public IP is informational. This stack's web edge is loopback, so Funnel
is not skipped because an IP exists.

```sh
curl -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace || true
```

Even if `ip=` is not RFC1918/link-local, continue at §3.3.6. Measured VMs
have no public inbound.

#### 3.3.1 Snapshot (no git)

git clone is not required. **curl + tar + Docker Engine + Compose v2 +
openssl + jq**. The public snapshot tarball includes
`scripts/self_host_env.sh`, which is required for secret consistency — four
of twelve values must match URL and password or the stack is healthy and
login never works.

```sh
docker compose version
openssl version
curl --version
jq --version
```

If this file is already at repo root, use that directory. Else:

```sh
curl -fsSL -o oort.tar.gz \
  https://github.com/yeomyeonggeori/oort/archive/refs/heads/track/engine.tar.gz
tar -xzf oort.tar.gz
cd oort-track-engine
```

`track/engine` is the landing branch. After promotion, `refs/heads/main` /
directory `oort-main`.

**Gate:** `scripts/oort doctor --json` — tools pass (env skip is OK).

Then §2.2 published digest (pull + inspect). Do not use `--local-build` on
this VM.

#### 3.3.2 Postgres on `/workspace`

RA-4 §8.3 conservative default. A Docker named volume alone can vanish with
`/var/lib/docker` on Update. Create the bind **before** first `up`.

```sh
mkdir -p /workspace/oort-pgdata /workspace/oort-backups
if docker volume inspect oort-pgdata >/dev/null 2>&1; then
  docker volume inspect oort-pgdata
else
  docker volume create \
    --driver local \
    --opt type=none \
    --opt o=bind \
    --opt device=/workspace/oort-pgdata \
    oort-pgdata
fi
```

If a volume already exists and is **not** a bind to `/workspace/oort-pgdata`,
**stop**. Do not delete someone else's volume. Restore is §4 / §3.3.18.

**Gate:** `docker volume inspect oort-pgdata` Options show
`device=/workspace/oort-pgdata`.

#### 3.3.3 Claim-mode env

```sh
scripts/self_host_env.sh --published-image \
  "$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
```

The generator always writes `MOMO_INITIAL_OWNER_PASSWORD`. ADR-0166 claim
mode is **mutually exclusive** (`MOMO_BOOTSTRAP_CLAIM=1` + email only).
`--compose` requires the password key, so claim boot calls `docker compose`
directly on the same canonical files.

```sh
ENV_FILE=infra/rust/local.secrets.env
umask 077
tmp="${ENV_FILE}.claim"
awk '
  index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { next }
  index($0, "MOMO_BOOTSTRAP_CLAIM=") == 1 { next }
  { print }
  END { print "MOMO_BOOTSTRAP_CLAIM=1" }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

Do not cat/grep the env to stdout. The same awk is idempotent on an already
claimed file.

**Scope of "do not re-run the generator" (#1790).**

- **Applies — secret regeneration and `--compose` bring-up.** Without the
  password key, `--compose` and the missing-file recreate path refuse
  (ADR-0166). Bring-up is `oort_compose` below.
- **Does not apply — maintenance of an existing env.** `--public-origin`
  after a public address exists (§3.3.9) does not mint secrets.
  `MOMO_BOOTSTRAP_CLAIM=1` with no password key is the one path that skips
  password validation and updates `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL` and
  `CENTRIFUGO_ALLOWED_ORIGINS`. An env that **has** a password still enforces
  12–128 dotenv-safe chars.

```sh
oort_compose() {
  docker compose --env-file "$ENV_FILE" \
    -f infra/rust/docker-compose.rust.yml \
    -f infra/rust/local.override.yml \
    "$@"
}

oort_compose up -d --pull missing --wait
```

`--wait` = containers healthy. Product gate is doctor. This edge binds
`127.0.0.1` only (no TLS).

**Gate:** `scripts/oort doctor --json` — stack must PASS. If doctor's fix
text says `--compose` and this env is claim mode, use `oort_compose`
instead.

#### 3.3.4 Health and join surface (loopback)

Doctor already measures these (`stack.healthz`, `stack.agent_port`). If you
must curl by hand:

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
code=$(curl -sS -o /tmp/oort-healthz.body -w '%{http_code}' \
  "http://127.0.0.1:${WEB_PORT}/healthz")
test "$code" = 200
```

Body is `{"status":"ok",...}` with no secrets. 200 missing →
`oort_compose logs api` and stop.

```sh
curl -sS -D - -o /dev/null -X POST \
  "http://127.0.0.1:${WEB_PORT}/v1/mcp/agent-port"
```

**Gate:** `401` and `WWW-Authenticate: Bearer scope="agent:port:connect"`.
Otherwise this image has no join surface — do not invent a password.

#### 3.3.5 Claim path

Migrate prints the secret **once** on stdout. Restarts print
`MOMO_BOOTSTRAP_CLAIM=skipped`. Capture immediately after first `up`.

```sh
umask 077
oort_compose logs migrate | sed -n 's/.*\(MOMO_CLAIM_PATH=\/claim\/[A-Za-z0-9_-]\{43\}\).*/\1/p' \
  | tail -n 1 > /workspace/oort-claim.env
chmod 600 /workspace/oort-claim.env
```

**Gate:** `/workspace/oort-claim.env` is non-empty and starts with
`MOMO_CLAIM_PATH=/claim/`. Empty → **stop**. The current
`releases/latest.json` pin is the image that must print this path. An empty
file means a different image or migrate did not print. Restoring a password
key is an ADR-0004 violation.

Do not reprint the token. Read it only when concatenating the tunnel URL in
§3.3.14.

#### 3.3.6 Funnel invariants — state

**Not a preference.** On Tailscale the node identity is neither account nor
hostname; it is the node key inside state. ServeConfig (funnel) and the TLS
certificate live in the same state dir, so they restore as one bundle and
Let's Encrypt re-issue is **zero** times (RA-7 RQ-1).

Lose state and the URL changes, **irreversibly** — no automatic name
reclaim, deleted names not reusable (#1200), another node inheriting the
name breaks existing visitor browsers with CT errors (#15702, closed as
not planned).

Canon path: **`/workspace/oort/ts-state`**. A Docker named volume or
`/var/lib/tailscale` can vanish with packages/images on Update (RA-4).
`/workspace` bind is the conservative default.

```sh
mkdir -p /workspace/oort/ts-state
```

**Gate:** the directory exists and is writable. On every re-provision
(vendor Settings → Updates → Update, or Reset), check this path **before
any other command**. Empty or missing → stop and tell the user the URL is
lost. Do not recreate a new node under the same name.

#### 3.3.7 Funnel install, login, serve

The package evaporates on Update (RA-4 replaceable). Identity lives only
in state. Reinstall walks the same block and **does not wipe state**.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

The installer starts the daemon with default
`--state=/var/lib/tailscale/tailscaled.state`. That path is not durable.
Userspace networking assumes no `/dev/net/tun` / `NET_ADMIN` (RA-7).

```sh
# systemd drop-in when systemd exists. Otherwise start tailscaled with the
# same arguments.
mkdir -p /etc/systemd/system/tailscaled.service.d
printf '%s\n' '[Service]' 'ExecStart=' \
  'ExecStart=/usr/sbin/tailscaled --statedir=/workspace/oort/ts-state --socket=/run/tailscale/tailscaled.sock --tun=userspace-networking' \
  > /etc/systemd/system/tailscaled.service.d/oort.conf
systemctl daemon-reload
systemctl restart tailscaled
```

If there is no `systemctl`, stop the installer daemon and:

```sh
# do not run this block when systemctl exists
tailscaled --statedir=/workspace/oort/ts-state \
  --tun=userspace-networking \
  --socket=/run/tailscale/tailscaled.sock
```

Keep it in the background. Do not pass `--statedir` together with default
`--state=file`.

Login (M1). Fix `--hostname`. Unspecified OS hostname drift changes the URL
(RA-7 P3). Turn off the console "Auto-generate from OS hostname".

```sh
# Interactive: send the printed login URL to the user. There is no secret
# in that URL's path that belongs in logs.
tailscale up --hostname=oort-server
```

Wait until the user finishes sign-up / login / node approval.
`tailscale status` must show this node before §3.3.10.

If the user pastes an auth key once, `--auth-key` replaces the browser URL.
Do not echo the key.

```sh
# When TS_AUTHKEY is an OAuth client secret (tskey-client-…),
# ?ephemeral=false is mandatory. Missing it, the node is ephemeral by
# default and the URL evaporates in 30–60 minutes (RA-7 §2.1, kb/1111).
# If a query string already exists, append &ephemeral=false.
# Console reusable auth keys (tskey-auth-…) turn ephemeral off on the
# create screen.
tailscale up --hostname=oort-server --auth-key="$TS_AUTHKEY"
```

Funnel. `--bg` writes ServeConfig into state so it resumes after restart.
`--yes` skips prompts. **Do not treat exit code as success.** Without
HTTPS+funnel nodeAttr on the tailnet, the CLI prints a human browser URL or,
non-interactively, **exits 0 quietly** (RA-7 §1.9).

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
tailscale funnel --bg --yes "${WEB_PORT}"
```

If a management-console URL is printed, send it to the user (first Funnel
activation, one click). Local `tailscale funnel status` / `serve status`
being active is **not** proof of external reach (RA-7 P8 — control plane
desync drops TLS silently, Open #19508).

Public address = `https://` + `tailscale status` Self DNSName (strip trailing
`.`). A `-1` suffix is already a collision — stop; do not force a new name.

Equivalent shape (official container): bind `TS_STATE_DIR` to
`/workspace/oort/ts-state`, `TS_HOSTNAME=oort-server`, `TS_AUTH_ONCE=true`,
`TS_USERSPACE=true`, `--network host` to reach host loopback. CLI via
`docker exec` is the same. That image digest is not our release — **do not
pin it**.

Unattended servers should disable node-key expiry (default 180 days).
Tagless M1: console **Disable key expiry** on that node (recommended one
click). Otherwise the URL dies on expiry day (RA-7 P6). Do not enable
Tailnet Lock (v1, RA-7 C7).

**Gate:** `tailscale status` shows this node. DNSName has no `-1`.
`/workspace/oort/ts-state` is non-empty. This gate is not external reach —
§3.3.10 is.

#### 3.3.8 After Update / Reset

1. Confirm `/workspace/oort/ts-state` remains. If not, stop.
2. If the tailscale package/image is gone, reinstall §3.3.7 only. Do not
   format state or `tailscale logout`.
3. Start the daemon with the same `--statedir` / `TS_STATE_DIR`. `--bg`
   config auto-resumes funnel. Re-running the command is usually harmless;
   leave "Background configuration already exists" alone.
4. Pass §3.3.10 again. If the URL differs **character-for-character** from
   baseline, tell the user it is lost and send the new address (rare
   fallback). Do not attach the old name to a different node.

Idempotent image restore after Update (images gone, env must not be
recreated):

```sh
APP_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
docker pull "$APP_REF"
# if the bind volume is missing, walk §3.3.2 again (do not rm an existing volume)
# if Funnel state (/workspace/oort/ts-state) is missing, walk §3.3.6 — the URL changes
oort_compose up -d --pull missing --wait
```

Then doctor (§2.5) again. The claim file may already have been consumed — do
not re-issue.

#### 3.3.9 Register the public origin

After the public address exists, **do not regenerate secrets**. One line.
Browser Origin (`https://…`) and RN socket Origin (`wss://…`) go in
together. New installs use `MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL=same-origin`
so the request Host is the source (ADR-0169 amendment 1).
`--public-origin` does not touch that sentinel. Running twice keeps one
entry. Claim-surgery env (`MOMO_BOOTSTRAP_CLAIM=1`, no password key) is
allowed on this maintenance path — "do not re-run the generator" (§3.3.3)
applies to secret minting and `--compose` only.

```sh
scripts/self_host_env.sh --public-origin https://<public-host>
oort_compose up -d
```

Restart is `oort_compose`. `scripts/self_host_env.sh --compose` in claim
mode refuses (password key required). A human laptop env **with** a
password uses `--compose` as in [`SELF_HOST.md`](SELF_HOST.md).

**Legacy env one-liner (#1790 restore).** If the generator warns
`MOMO_CENTRIFUGO_WS_URL points at loopback` — it warns and does not fix —
change that one line on the existing env to
`MOMO_CENTRIFUGO_WS_URL=same-origin` and restart (ADR-0167). That stops a
remote client from opening WS to its own localhost. **No secret
regeneration.**

**Check:** a login response (including right after claim) has
`realtimeWebSocketUrl` equal to `wss://<public-host>/connection/websocket`.
`ws://localhost` means same-origin and api restart need another look.

`--public-origin` also derives `OORT_SITE_ADDRESS` and
`OORT_CSP_CONNECT_SRC`. This branch still must **not** start
`caddy.override.yml`.

**Gate:** `scripts/oort doctor --json` — after Funnel is live, `public.*`
must not fail.

#### 3.3.10 External reachability

**Success is neither `tailscale funnel` exit code nor local `funnel
status`.** Only HTTP 200 + WebSocket 101 from the outside (RA-7 C5 · §1.9 ·
P8). Do not send the handoff before both.

`TUNNEL_URL` is `https://<machine>.<tailnet>.ts.net` (placeholder — do not
write a real value in docs). Resolving the same name inside the VM via
MagicDNS (100.x) is Serve, not Funnel ingress. 200/101 there can still fail
TLS for an external visitor. Prefer public DNS; otherwise one user-browser
hit is the external measurement.

Doctor's `public.healthz` / `public.websocket` are the same two probes when
`CENTRIFUGO_ALLOWED_ORIGINS` contains the Funnel origin. Prefer:

```sh
scripts/oort doctor --json
```

Manual equivalent:

```sh
# TUNNEL_URL = https://<machine>.<tailnet>.ts.net
code=$(curl -sS --max-time 20 -o /tmp/oort-tunnel-healthz.body -w '%{http_code}' \
  "${TUNNEL_URL}/healthz")
test "$code" = 200

ws_key=$(openssl rand -base64 16)
curl -sS --max-time 20 -D /tmp/oort-tunnel-ws.hdr -o /dev/null \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: ${ws_key}" \
  "${TUNNEL_URL}/connection/websocket"
ws_code=$(awk 'NR==1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9][0-9][0-9]$/) { print $i; exit } }' \
  /tmp/oort-tunnel-ws.hdr)
test "$ws_code" = 101
```

WS does not send Origin (R-2: no Origin → 101). 403 → revisit §3.3.9.
Login tokens are not an input to this gate.

**Gate:**

| Call | Expect |
|---|---|
| `GET ${TUNNEL_URL}/healthz` | 200 |
| `GET ${TUNNEL_URL}/connection/websocket` (Upgrade) | 101 |

If either fails: restart tailscaled **once** and repeat both probes (P8
workaround). If the restart fixes it, this environment needs "one restart
after provision + external verify" in the bootstrap. If still failing, do
not send the handoff. If the CLI printed a Funnel approval URL, ask the
user for that click and measure again.

Loopback `POST /v1/mcp/agent-port` 401 is §3.3.4 / doctor. It is not part of
tunnel success.

The public URL is **in effect a public address**. Anyone who knows it reaches
the login screen. Ownership is the claim token (ADR-0166). There is no
initial password.

#### 3.3.11 Fallback — cloudflared quick tunnel

Only when Funnel cannot be enabled. **Temporary / development.** The URL is
volatile per process. This VM's egress shares Cloudflare address space, so
quick tunnel 1015 rate limit is a **structural** exposure (RA-5).
Cloudflare themselves forbid production and offer no SLA. **An address
handed off on this path is not production.** Tell the user about volatility
and 1015 together. Stable URL → Funnel or §3.2.

```sh
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${WEB_PORT}"
```

The log's `https://<id>.trycloudflare.com` is the address. It changes on
restart. §3.3.9 and §3.3.10 (200+101) still apply. 1015/429 → stop; do not
extend the limit by retrying.

#### 3.3.12 Expert matrix

If the user already has a domain, skip tunnels. This table is not the
default path.

| Path | Domain | Stable URL | WS | Account |
|---|---|---|---|---|
| Tailscale Funnel | not required | yes (state durable) | yes — #18827 unmeasured | Tailscale |
| Cloudflare named tunnel | **required** | yes | long-session unmeasured | Cloudflare |
| Own reverse proxy | **required** | yes | own infra | own infra |
| quick tunnel | not required | no | yes (R-2 measured) | none |

**CF-origin on a CF named tunnel is unconfirmed** (RA-6 §2.3). This document
does not claim that vendor-VM egress (Cloudflare space) avoids 1015 on its
own zone named tunnel. Custom-domain CNAME in front of Funnel is officially
unsupported · #16478 closed as not planned (RA-6 §1.10) — do not add only a
CNAME as an "expert" path.

#### 3.3.13 Known risks

- **Funnel WebSocket `1001 Going Away` drop** (GH #18827, Open, 2026-02-27~,
  staff silent). Serve sees 10–40s periodicity. Funnel shares that
  reverse-proxy path (RA-6 — estimate). Can hit the Centrifugo realtime
  rail **directly**. Our 1h+ soak is **unmeasured**. Symptom: desktop
  realtime drops repeatedly. Check: (1) does
  `127.0.0.1:${WEB_PORT}/connection/websocket` loopback hold (2) is 1001
  only on the public URL (3) Centrifugo/client disconnect code. Loopback
  alive + Funnel-only drop → #18827 candidate — do not silently switch to
  quick tunnel; report to the user. If reproduction is confirmed, Funnel
  as default is not established on this instance.
- Funnel has been **beta for 3 years 9 months** after 2022-11 alpha
  (RA-6). Bandwidth cap unpublished, no SLA. Do not use it as capacity
  planning evidence.
- Let's Encrypt duplicate-certificate limits (5 / 7 days, refill ≈ 34h)
  matter **only** when state is lost. Live state → zero re-issue calls.

#### 3.3.14 User handoff

Reply only after the §3.3.10 gate. Do not send a password. The claim token
exists only inside the URL, once. TTL 24h, single use.

Fill the brackets with real values. Do not rewrite `<token>` into this
file; append `MOMO_CLAIM_PATH` from `/workspace/oort-claim.env` to the
tunnel address.

```text
oort is running on this computer (your vendor VM). It is not a team server.
This VM is for personal try-out. For work / standing use, take a dump to your
own server (VPS or similar).

1) Desktop app
   https://github.com/yeomyeonggeori/oort/releases/latest
   A macOS dmg appears on that page when a public release is ready
   (T-3). If there is no dmg yet, set a password with the claim link
   below and connect after the dmg ships. A web browser as the standing
   client of the tunnel URL is not v1.

2) Server address (desktop "Server address" field)
   <TUNNEL_URL>

3) First owner registration (this link once, 24 hours)
   <TUNNEL_URL><MOMO_CLAIM_PATH>
   The email field is owner@oort.local. You choose the password.
   Do not send the password to me.

4) First-day use
   Workspace · inviting people · AI link · first mention:
   https://raw.githubusercontent.com/yeomyeonggeori/oort/track/engine/docs/SELF_HOST_FIRST_DAY.md

5) Where data lives
   This VM is durable-but-resettable. On app Update, Docker images go
   away; /workspace files are the side that remains. The public
   address does not change while /workspace/oort/ts-state lives. Lose
   that path and the address cannot be restored — only then I send a
   new one.

6) Today's backup (important)
   If the vendor trial locks, you cannot enter the VM itself (B7).
   Cancelling a subscription is the same. I wrote a dump under
   /workspace/oort-backups before the first message. Attachments live
   outside Postgres on the archive volume (default oort-drive).
   Download the dump and that volume together. Restore:
   https://raw.githubusercontent.com/yeomyeonggeori/oort/track/engine/docs/runbooks/selfhost-pg-dump-restore.md

7) To put me on the team
   After desktop login: Agents → hosted agent connection. Create me,
   then paste the on-screen "connection value" (shown once) into this
   chat. I join from inside the VM. You do not put an address into the
   vendor app connector.
```

#### 3.3.15 First-day backup

Before the reply:

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

**Gate:** a `.dump` file exists under `/workspace/oort-backups`, and the
script stdout has no password. Tell the user to download that folder from
the workspace (§3.3.14-6). Do not paste dump bytes into chat. Attachment
bytes live in `DRIVE_VOLUME_NAME` (default `oort-drive`); a dump alone
does not restore them — follow the runbook's archive companion line.

#### 3.3.16 Agent join (loopback curl, static bearer)

Do **not** use the vendor app connector, plugins, or routines for join.
#1361 connector-header unknowns are not a premise of this path. Consume
ADR-0162 static bearer on VM loopback. Realtime wake after join is §3.3.17.

Order: the user consumes claim first. The agent does not know the user's
password. Connection create/approve is the desktop wizard.

1. User sets a password at the §3.3.14-3 claim URL and logs into
   `<TUNNEL_URL>` from the desktop.
2. **Settings → Connections → Agent credentials** (or **Agents** → **Hosted agent connection**)
   → create with a display name/handle.
3. Paste the wizard's one-time **connection value** into this chat (15 min
   TTL).
4. Receive it only as an environment variable. Do not echo/log/reply it.
5. **Inside the VM**, handshake on loopback (not the tunnel URL):

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
EP="http://127.0.0.1:${WEB_PORT}/v1/mcp/agent-port"
curl -sS -X POST "$EP" \
  -H "authorization: Bearer ${PAIRING_VALUE}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"oort-operator","version":"0.0.0"}}}}'
```

**Gate:** a successful handshake moves the wizard to detected. Failure
(401): do not ask for the same value again; tell them to **re-issue the
connection value**. A wrong era/body does not consume the value.

6. User confirms channel/permissions. Paste the **active credential** shown
   once. It is a different secret from pairing.
7. Handshake again on the same `EP` with the active credential, using the
   same `server/discover` curl as step 5. Only a foundation request
   (`server/discover` or `tools/list`) proves `active` / unpause. A
   `tools/call` (including the §3.3.17.4 `oort_inbox_read` bytes) against a
   pairing bearer, or against an unproved `detected` credential, is HTTP 401
   with an empty body. Do not store or reprint it.

**Gate:** unauthenticated POST stays 401. An agent badge on a mention means
join is complete. First mention round-trip is T-6; detect one-click is
T-5 — this playbook stops at the curl round-trip.

Re-join after Update/Reset: wizard **re-issue connection value**
(`POST …/pairing-challenge/regenerate`) is allowed only from
`pairing_pending`, `detected`, or `expired` — it resets to `pairing_pending`
and the same pairing curl. An `active` connection cannot regenerate (409).
If the active credential is lost, the human disconnects and creates a new
connection.

Route table (2026-09-08 #2230, measured against the Rust handlers; document
lines are this section):

| Step | Doc | Route | Auth | Status |
|---|---|---|---|---|
| 1 Create | `:961` step 2 | `hosted_agent_connections.rs:127` `lib.rs:1045` | human workspace-admin JWT | → `pairing_pending` (paused agent) |
| 2 Pairing handshake | `:966` step 5 curl | `agent_port.rs:33` `lib.rs:1225` | pairing bearer (`momo_pair_v1`, 15 min TTL) | `pairing_pending` → `detected` |
| 3 Confirm | `:984` step 6 | `hosted_agent_connections.rs:714` `lib.rs:1057` | human workspace-admin JWT | stays `detected`; mints active credential |
| 4 Active re-handshake | `:986` step 7 `server/discover` | `agent_port.rs:33` + `prove_hosted_binding_in_tx` | hosted-active bearer | `detected` → `active` (unpause) |
| 5 Regenerate | `:997` re-join | `hosted_agent_connections.rs:653` `lib.rs:1053` | human workspace-admin JWT | `pairing_pending`/`detected`/`expired` → `pairing_pending`; `active` → 409 |

Do not drive the vendor chat app with CDP, scripts, or selectors. The human
speaks; the agent runs this file in the VM shell.

#### 3.3.17 Doorbell (realtime wake)

Accelerator after join (§3.3.16). Durable inbox remains the canon delivery
(ADR-0171 D5). oort POSTs a body-less wake to the vendor routine webhook; the
agent pulls work on authenticated Agent Port. Doorbell body is the constant
`{"kind":"oort.doorbell.v1"}`. Message content, ids, and workspace
identifiers are not included, and **no field is trusted input** (ADR-0171
D2).

Drain watches `hosted_agent_inbox_counter`. If join is not `active` or
the channel is not approved, the bell does not ring and the sweep has
nothing to reclaim.

**This instance is this user's vendor account/VM only.** Do not put
someone else's routine URL/key here, and do not use a team VM as a shared
doorbell proxy.

Agent Hub UI registration is WD-2 (#1735); until that lands, WD-1 REST is
canon.

This section assumes an image that includes ADR-0171 (#1734). If the
§2.2 pin predates that release, webhook-sender logs have no
`doorbell drain` string and the register PUT is an empty 404. Do not run
this section then.

##### 3.3.17.1 Vendor side — webhook routine

Standard text the user pastes into vendor chat. The agent performing this
playbook uses the same text when creating its own routine. Do not rephrase
the trigger type (this is the measured webhook wording).

```text
Create a routine. Name oort-doorbell / trigger: webhook (external system starts it with HTTP POST) / body: (the production instructions in §3.3.17.4, verbatim) / afterwards tell me the webhook URL, sender key, and whether it is enabled.
```

**Gate:** the routine is enabled, and you received an https webhook URL and
sender key. Do not rewrite URL/key into this file. Take them as env vars
for §3.3.17.3 only; do not repeat them in later replies or logs.

##### 3.3.17.2 oort side — open the gates

Register REST and sender drain open only when `MOMO_DOORBELL_ENABLED` is
lowercase **`true`** (ADR-0171 D6). The **prior** gate is
`MOMO_HOSTED_DELIVERY_ENABLED` — same spelling, default off. Doorbell-only
without that value (or not `true`) means mentions never reach hosted inbox
(`hosted_delivery_not_enabled` skip) so there is nothing to ring. Looks on,
nothing happens. `True` / `TRUE` / `1` / `yes` / `on` are closed for both.
Do not regenerate secrets; add those two lines only. api **and**
webhook-sender both read both variables — restarting one side registers
without firing, or the reverse.

```sh
ENV_FILE=infra/rust/local.secrets.env
umask 077
tmp="${ENV_FILE}.doorbell"
awk '
  index($0, "MOMO_DOORBELL_ENABLED=") == 1 { next }
  index($0, "MOMO_HOSTED_DELIVERY_ENABLED=") == 1 { next }
  { print }
  END {
    print "MOMO_HOSTED_DELIVERY_ENABLED=true"
    print "MOMO_DOORBELL_ENABLED=true"
  }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
oort_compose up -d
```

**Gate:** `oort_compose exec api env` and
`oort_compose exec webhook-sender env` show both lines `=true` (if compose
did not pass the values, they exist only on the host).
`oort_compose logs --tail 30 webhook-sender` shows `doorbell drain starting`.
`doorbell drain idle (MOMO_DOORBELL_ENABLED!=true)` means the spelling is
wrong — stop. A human admin session PUT that returns **empty 404** is the
same (closed gate and unknown path share that empty 404).

Doctor: `env.bool.doorbell` and `env.bool.hosted_delivery` pass when the
value is unset/closed **or** lowercase `true`. A wrong truthy string is
**fail** (silent close).

##### 3.3.17.3 oort side — REST register

Paths (OpenAPI `registerHostedAgentDoorbell` /
`unregisterHostedAgentDoorbell`):

```
PUT    /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/doorbell
DELETE /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/doorbell
GET    /v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}
```

There is no dedicated GET doorbell route. Masking is confirmed on PUT
response and connection GET.

Request JSON (`RegisterHostedDoorbellRequest`, additionalProperties rejected):
`url` (https, 1..2048) + `secret` (write-only, 1..4096). Response
(`HostedDoorbellResponse`): `connectionId`, `url`, `secretMasked`,
`registeredAtMs`. After fire, `lastFiredAtMs` · `lastStatus` may appear.
Secret plaintext is not in responses, logs, or DB. PUT/DELETE response
headers include `Cache-Control: no-store` and `Pragma: no-cache`.

Connection GET projection names: `doorbellUrl` / `doorbellSecretMasked` /
`doorbellLastFiredAtMs` / `doorbellLastStatus`. Unregistered or gate-closed
**omits the fields** (flag-off GET is byte-identical to pre-doorbell).

URL is https only (self-host `MOMO_ENV=staging` has the HTTP-dev exception
closed). OutboundHTTPPolicy rejects private/loopback/link-local/userinfo/
fragment (400). The sender does not follow redirects. Connection not
`active` → 409 (`doorbell requires an active hosted connection`). Not a human
workspace admin → 403. Empty secret or over 4096 bytes → 400
(`doorbell secret must not be empty` / `doorbell secret exceeds the
sealed-box bound`). Missing connection → 404 (`hosted connection not found`).

`ACCESS_TOKEN` is a human workspace-admin session. The user pastes login
response `accessToken` (TTL 15 min) and `member.workspaceId` once. The agent
does not run login curl — it does not know the password. Agent
pairing/active credentials are not this path. Do not repeat the token in
replies.

`CONN` is the hosted connection id after join. List:

```sh
WEB_PORT=$(awk -F= '$1=="MOMO_WEB_PORT"{print substr($0, index($0,"=")+1); exit}' "$ENV_FILE")
curl -sS -o /tmp/oort-hosted-conns.body -w '%{http_code}' \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections"
```

**Gate:** HTTP 200. An item in `connections[]` with `status` `active` has
`id` = `CONN`. Do not paste the body into chat.

Register (PUT to the same URL replaces/reseals; fire timestamps reset):

```sh
curl -sS -o /tmp/oort-doorbell.body -w '%{http_code}' \
  -X PUT \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/doorbell" \
  -d '{"url":"<DOORBELL_URL>","secret":"<DOORBELL_SECRET>"}'
```

**Gate:** HTTP 200. Body has `secretMasked` and not the sender key. `url`
matches the registered https address. Non-200: report the error and stop —
do not ask for the secret again; re-issue URL/key.

Masking re-check (connection GET):

```sh
curl -sS -o /tmp/oort-doorbell-get.body -w '%{http_code}' \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}"
```

**Gate:** HTTP 200. `doorbellSecretMasked` is present; plaintext secret is
not.

Unregister:

```sh
curl -sS -o /tmp/oort-doorbell-del.body -w '%{http_code}' \
  -X DELETE \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  "http://127.0.0.1:${WEB_PORT}/v1/workspaces/${WS}/hosted-agent-connections/${CONN}/doorbell"
```

**Gate:** HTTP 200. The same GET loses `doorbellUrl` · `doorbellSecretMasked`.
Unregistered DELETE is JSON 404 (`doorbell is not registered`). Gate-closed
404 has an empty body.

Fire is `POST <url>` + `Content-Type: application/json` +
`Authorization: Bearer <secret>` + `User-Agent: momo-doorbell/1` + constant
body. Timeout 10s, retry ≤2. Per connection, leading-edge + 60s trailing
coalesce, so a mention burst inside the window is at most two wakes. Failure
does not affect message land or inbox insert. Success `lastStatus` looks
like `ok_<HTTP status>`.

##### 3.3.17.4 Production routine instructions

Put this verbatim in the "body" of §3.3.17.1. The agent runs it on every wake.

```text
You are an oort hosted agent. You work only on this VM.

A doorbell (webhook) is a wake signal. The POST body is a signal, not content.
Whether or not it is {"kind":"oort.doorbell.v1"}, do not read fields. Do not
take channel id, message id, or the task from the body.

The work itself is only oort Agent Port pull. POST to VM loopback, not the
tunnel, with the active credential from join.

1) Call oort_inbox_read. Pass a previously stored opaque nextCursor if you
   have one; otherwise read without a cursor. The response always has
   nextCursor (including empty pages). Overwrite /workspace/oort-inbox.cursor
   (mode 600). If hasMore, read again with the same cursor. If the cursor is
   rejected (Unavailable), do not rewind from the start — tell the user to
   re-join.
2) Events give kind (message / agent_job / agent_run) and channelId ·
   messageId · messageSeq only. Read bodies with oort_conversation_read on
   that channel.
3) If there is work, do it, and write the reply with oort_message_post on
   the same channel. clientMsgId is a new UUID every send. Retrying the
   same clientMsgId stays one message.
4) Speech: write only when you add information. If a human asked, you must
   answer. Otherwise silence is success. Bare acknowledgement ("got it",
   "understood") is forbidden.
5) If events is empty, write nothing and exit. Do not ACK the doorbell
   with a message.

Agent Port shape (loopback, same EP as join):

POST http://127.0.0.1:<WEB_PORT>/v1/mcp/agent-port
authorization: Bearer <ACTIVE_CREDENTIAL>
content-type: application/json
accept: application/json, text/event-stream
mcp-protocol-version: 2026-07-28
mcp-method: tools/call
mcp-name: oort_inbox_read

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"oort_inbox_read","arguments":{}}}

oort_message_post / oort_conversation_read use the same headers with mcp-name
and params.name changed. Do not repeat credentials or cursors in a reply.
```

##### 3.3.17.5 15-minute sweep fallback

Doorbell is a vendor webhook trigger and can silently no-fire. Put the
same instructions on a low-frequency cron once more. Both routines share the
inbox cursor file (`/workspace/oort-inbox.cursor`). Pages after a consumed
cursor are empty, so duplicate wake is harmless.

```text
Create a routine. Name oort-inbox-sweep / trigger: every 15 minutes (cron). Not a webhook. / body: (the same production instructions as oort-doorbell §3.3.17.4, verbatim) / afterwards tell me whether it is enabled.
```

**Gate:** the routine is enabled and the period is 15 minutes. Do not lower
it to 1-minute polling.

##### 3.3.17.6 Notices

- One doorbell = one vendor routine run = subscription usage. That is why
  the server coalesces on a 60s window. The sweep is also a run. Do not
  replace the doorbell with a high-frequency cron.
- Webhook triggers are a vendor beta surface. They can change without
  documentation. The 15-minute sweep is the safety net.
- This user's vendor account/VM only. No shared proxy.
- Do not commit sender key, doorbell secret, active credential, or session
  tokens. Do not paste plaintext into `.env`, issues, PRs, or screenshots.
  A doorbell secret is not a model-provider credential; handling is the
  same (ADR-0171).

Live E2E (mention → doorbell → reply, target p50 ≤ 90s) is not a gate of
this document. That acceptance run is a separate natural-language relay.

#### 3.3.18 Take the data with you

Canon: [`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md).

```sh
scripts/self_host_pg_dump.sh --output-dir /workspace/oort-backups
```

The user must copy this folder off the VM before vendor churn, subscription
cancel, or B7 trial lock. An app-UI export button is a later ticket (not
issued this wave).

Restore:

```sh
scripts/self_host_pg_restore.sh --dump /workspace/oort-backups/oort-pg.dump
```

The script refuses a missing `--dump` path. After restore: `oort_compose up
-d --wait` and doctor (§2.5).

If Postgres looks empty or login fails, data is gone. Restore from
`/workspace/oort-backups` if a dump exists. If not, tell the user; do not
invent a password.

#### 3.3.19 Do not

- use a team VM as a shared host
- CDP / automation of the vendor chat app
- the CDP prohibition above is for users and public surfaces; the
  developer-local verification harness follows
  `scripts/dev/grokbot_cdp/README.md`
- repeat password · pairing/active plaintext in a reply
- bypass claim failure via `MOMO_INITIAL_OWNER_PASSWORD`
- send people to a web browser as the standing client of the tunnel URL
  (v1 is desktop)
- name `caddy.override.yml` / production Caddyfile on this VM (ACME)
- global `DOCKER_DEFAULT_PLATFORM=linux/amd64`
- `down -v` on a volume that still has data
- repeat doorbell sender key · doorbell secret in replies, issues, commits
- open `MOMO_DOORBELL_ENABLED` or `MOMO_HOSTED_DELIVERY_ENABLED` with
  `True` / `1` / `yes` (only lowercase `true`). Doorbell without
  hosted-delivery means mentions never reach inbox.

Live E2E (D7) is not a gate of this document. Gates here decide whether the
agent may climb the next layer.

### 3.4 Railway

Catalog: [`infra/railway/README.md`](../../infra/railway/README.md) ·
[`infra/railway/railway.json`](../../infra/railway/railway.json).
Same GHCR image as compose (`releases/latest.json`), four commands
(`api` · `relay` · `webhook-sender` · `agent-worker`), Caddy as the public
edge, Centrifugo via `CENTRIFUGO_*` (no file mount), Postgres plugin.
LiveKit is not in this template. Do not invent a compose stack this repo
does not ship. Do not paste platform secrets into chat.

1. Railway account + project. Add the Postgres plugin. Create the six
   services in `railway.json` (image, `startCommand`, api `preDeployCommand`).
   Give **caddy** the public domain. Api stays internal.
2. After the plugin URL and the caddy hostname exist:

```sh
scripts/self_host_env.sh --railway
```

   Requires `RAILWAY_PUBLIC_DOMAIN` and `DATABASE_URL` in the environment
   (explicit fail if either is missing — not a doctor `public.*` skip).
   Apply the KEY=value stdout as Railway variables. Also set the three keys
   compose interpolates that are not in the generator file (`CENT_API_URL`,
   `WORKER_DATABASE_URL`, Centrifugo proxy header) — listed in the README.
3. Deploy. Wait until api preDeploy finished (runtime-roles then migrate)
   and caddy answers `/healthz`.
4. Gate:

```sh
scripts/oort doctor --json
```

   `public.healthz` and `public.websocket` must PASS. Then stop/delete the
   project unless this instance is meant to stay up.

**Gate after the platform URL exists:** `scripts/oort doctor --json` with
`public.healthz` pass.

### 3.5 Fly

SH-5b lands `fly.toml` + volume. Until then, follow §3.2 on a Fly VM.
**Gate:** `scripts/oort doctor --json` after the public origin is registered.

### 3.6 AWS

SH-5b is "VM + compose + domain" (minimal Terraform later). Until then:
provision a VM you own, §2 + §3.2. ACME only for a hostname this VM's DNS
owns.

**Gate:** `scripts/oort doctor --json` including public checks.

### 3.7 GCP

Same contract as §3.6. **Gate:** `scripts/oort doctor --json` including
public checks.

---

## 4. Day-2

Canon:

```sh
scripts/oort status
scripts/oort logs
scripts/oort upgrade
scripts/oort backup
scripts/oort restore <dump>
scripts/oort member invite
scripts/oort member credential --agent <handle>
```

**Upgrade (images gone, env must stay):** `scripts/oort upgrade`.
That is the command. The prose below is explanation, not a second
procedure.

It compares the running/env digest with `releases/latest.json`
(`digest_list`, regex `sha256:` + 64 lowercase hex; list ≠ arch), takes
`scripts/oort backup` first (`--no-backup` to skip), re-checks that env
and the named volumes/`Caddyfile.local` bind exist (it will not create
or delete a volume), `compose pull` + `up -d`, waits for migrate
`IDEMPOTENCY_OK`, waits for `/healthz`, then `scripts/oort doctor` PASS.
On failure it **prints** the rollback command (`scripts/oort upgrade
--to <previous> --no-backup --yes`) and does not run it.

```sh
APP_REF="$(jq -r '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json)"
scripts/oort upgrade --to "$APP_REF" --yes
```

Claim-mode: `oort_compose` instead of `--compose` (§3.3.3). Grok Bot VM
also re-checks `/workspace` binds and Funnel state (§3.3.8).

**Backup / restore** (not PITR; see
[`runbooks/selfhost-pg-dump-restore.md`](runbooks/selfhost-pg-dump-restore.md)):
`scripts/oort backup` and `scripts/oort restore <dump>`. Restore refuses
a stack that already has messages. If the dest lacks runtime roles
(`momo_app`/`momo_relay`/`momo_worker`) it runs the compose service
`runtime-roles` (`MOMO_RUNTIME_ROLE_PROVISION=1`) before
`scripts/self_host_pg_restore.sh` — it does not hand-write GRANT SQL.
The wrappers call the two scripts below (no second `pg_dump`/`pg_restore`
call site):

```sh
scripts/oort backup --out ./oort-backups
scripts/oort restore ./oort-backups/oort-pg.dump --yes
```

Attachments live on `DRIVE_VOLUME_NAME` (default `oort-drive`). Take that
volume with the dump. `down -v` deletes the volume this env names.

**Logs:** `scripts/oort logs api` (secret values are `***`). Direct
compose remains valid for claim-mode:

```sh
scripts/self_host_env.sh --compose logs api
scripts/self_host_env.sh --compose logs migrate
scripts/self_host_env.sh --compose logs relay
```

---

## 5. When stuck

Run `scripts/oort doctor --json` first. Map `checks[].id` to the fix
string (doctor already prints `fix` on fail). Summary of ids:

| id | Typical fail | Fix |
|---|---|---|
| `tool.docker` / `tool.compose` | missing Engine or Compose v2 | Install Docker Engine + Compose v2 plugin (not hyphen `docker-compose` v1). |
| `tool.jq` / `tool.openssl` | missing binary | Install jq / openssl. |
| `tool.disk` | < 1 GiB (blocker) or < 2 GiB (major) | Free space for pull + volumes. |
| `env.exists` | no `infra/rust/local.secrets.env` | `scripts/self_host_env.sh --published-image` or `--local-build`. |
| `env.mode` | not 0600 | `chmod 600 infra/rust/local.secrets.env` |
| `env.duplicate_keys` | duplicated key | Leave one line. |
| `env.scalars` | CR in a value | Docker env is a one-line scalar. |
| `env.required_keys` | generator key missing | Use a generator-made env. |
| `env.bool.doorbell` / `env.bool.hosted_delivery` | not lowercase `true` while intending on | Only `true` opens. `True`/`1`/`yes` silently close. |
| `env.bool.unfurl` | not character `1` while intending on | Unfurl opens only on `1`. |
| `env.platform_admin_emails` | missing/empty → AI link 403 | Re-run the generator on the existing file (appends that line only), restart api. |
| `env.provider_link_master_key` | missing/empty → AI link 503 | Generator key. `openssl rand -hex 24` if you must fill by hand; restart api and agent-worker. |
| `env.drive_archive_backend` | missing/empty → attach 503; `stub` refused on staging | `MOMO_DRIVE_ARCHIVE_BACKEND=local`. |
| `env.centrifugo_ws_url` | missing, or loopback behind a tunnel | `MOMO_CENTRIFUGO_WS_URL=same-origin`, restart api. |
| `env.role_passwords` | role password ≠ URL password | Do not mint a new env. Align URL passwords with `*_POSTGRES_PASSWORD`, or regenerate only with `down -v`. |
| `env.digest` | published image not list-digest-pinned, or ≠ `releases/latest.json` | Pin from the manifest. Do not regenerate secrets to upgrade. |
| `port.web` / `port.api` / `port.centrifugo` | port taken while stack is down | Stop the occupant or change the env port, then up. |
| `stack.compose_ps` | missing/unhealthy service | `--compose ps` / `logs` for that service. Claim-mode: `oort_compose`. `runtime-roles` exit 1 with `password authentication failed for user "momo"` means leftover pgdata vs a newly generated env — `down -v`, delete env, §2.3 again (or retry `up` with the **original** env). |
| `stack.healthz` | not 200 `database:ok` | `logs api`. |
| `stack.agent_port` | not 401 + Bearer scope | Wrong image; check `releases/latest.json`. |
| `stack.outbox` | non-`done` rows | `push_candidate` pending is **info** (count) when no push relay is configured (no `PUSH_RELAY_URL` / `docker-compose.push.yml` `push-relay`/`notifier`). `agent_job` pending younger than 5 minutes is info; older is major (kind/status/count/max age listed). Other kinds: `logs relay` if pending/failed. |
| `stack.migrate_idempotency` | no `IDEMPOTENCY_OK` | `logs migrate`. |
| `public.healthz` / `public.websocket` | public origin registered but 200/101 missing | Tunnel/Caddy and `CENTRIFUGO_ALLOWED_ORIGINS`. Funnel: §3.3.10 restart-once. |

Doctor exit **2** (blocker) → do not hand off. Exit **1** (major-only) →
do not hand off on Local/VPS/Grok Bot install; fix then re-run. Preflight
`skip` on stack before first `up` is expected.

Login `invalid credentials`: use the generator's email and the password
key in the env file. Read it in the shell; do not paste it into chat.
Password rotation (every session logs out) is in
[`SELF_HOST.md`](SELF_HOST.md) — do not invent a new password in chat.

ACME orders appearing on a loopback install: you named the public overlay
or `OORT_SITE_ADDRESS` is some other host. Local and Grok Bot VM must not
start `caddy.override.yml`.
)
