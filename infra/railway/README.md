# oort on Railway — team instance (SH-11a / #2205)

This is the catalog for the team's always-on oort instance (ADR-0187 D2): the
shipped Rust stack, the same image and commands as
`infra/rust/docker-compose.rust.yml` + `caddy.override.yml`, plus the push path
(`push-relay` + `notifier`, ADR-0187 D4). It is **not** a measure-and-delete
run: there is no `railway down` step, and upgrades and backups keep the data.

`railway.json` is a service catalog, not Railway config-as-code. Every value
in it is typed into Railway (UI, CLI or MCP) by hand, service by service.
`scripts/tests/test_railway_template.sh` checks it against what Railway does
with those values (`scripts/tests/check_railway_catalog.py`).

Image pin: `releases/latest.json` (`images.app.ref` + `images.app.digest_list`).
`railway.json` (every oort-image service) and `Dockerfile.caddy` (`ARG
OORT_IMAGE`) copy that digest so a deploy is immutable; when `latest.json`
moves, update all of them in the same change
(`scripts/tests/check_railway_release_pins.py`).

## Services

| Service | Source | Start command | Volume | Public |
|---|---|---|---|---|
| **postgres** | `pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7…` (compose pin) | image default | `/var/lib/postgresql` | no |
| **centrifugo** | `centrifugo/centrifugo:v6@sha256:8ba0c944…` (compose pin) | `centrifugo` | — | no — Caddy `/connection/*` |
| **api** | `ghcr.io/yeomyeonggeori/oort@sha256:…` | `/bin/sh -c '… exec setpriv … momo-rust-entrypoint api'` + pre-deploy | `/var/lib/oort/drive` | no — Caddy `/v1/*`, `/hooks/*`, `/healthz` |
| **relay** | same image | `momo-rust-entrypoint relay` | — | no |
| **webhook-sender** | same image | `momo-rust-entrypoint webhook-sender` | — | no |
| **agent-worker** | same image | `momo-rust-entrypoint agent-worker` | — | no |
| **notifier** | same image | `/bin/sh -c '… exec momo-rust-entrypoint notifier'` | — | no |
| **push-relay** | same image | `/bin/sh -c '… exec momo-rust-entrypoint push-relay'` | — | no |
| **caddy** | `infra/railway/Dockerfile.caddy` (Caddy 2 + SPA from the oort image), build context = repo root | `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile` | — | **yes** (Railway TLS) |

Copy the start commands from `railway.json` verbatim; the table abbreviates.
LiveKit / huddle is not in this template.

- **Start commands.** Railway's start command *replaces* the image
  `ENTRYPOINT` in exec form. The oort image is `ENTRYPOINT
  ["momo-rust-entrypoint"]` and has no binary named `api`, so a bare `api`
  exits 127. Every oort-image service names `momo-rust-entrypoint <role>`.
- **Caddy is the only public service.** `/v1/centrifugo/*` is an exclusive 403
  in `Caddyfile.railway`, the same shape as `infra/rust/Caddyfile`; the api must
  not be the edge. `Dockerfile.caddy` stands in for compose `web-init`: Railway
  volumes are per service, so the SPA is copied at image build.
- **Healthchecks.** caddy's Railway healthcheck arrives with `Host:
  healthcheck.railway.app`, matches no site and gets an empty 200 — it only
  proves Caddy listens. The api healthcheck (`/healthz`, 200 only with
  `database: ok`) is the real one.

## Postgres: image service, and the `DATABASE_URL` you compose

Not the Railway Postgres template: migrations need PG18 (`uuidv7()` from
`001_init.sql`) and pgvector (`028_memory_search.sql`), and Railway's default
Postgres templates add no extensions. Use the compose pin as an image service
with a volume at `/var/lib/postgresql` (PGDATA is `/var/lib/postgresql/18/docker`,
a subdirectory, so the volume's `lost+found` does not trouble `initdb`; the image
entrypoint runs as root and owns the data dir itself).

An image service provides no `DATABASE_URL`. Compose it before running the
generator, with a URL-safe password:

```sh
PG_PASSWORD="$(openssl rand -hex 24)"
export DATABASE_URL="postgres://postgres:${PG_PASSWORD}@postgres.railway.internal:5432/oort"
```

The generator parses it and writes `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB` (the postgres service's own variables), `MIGRATE_DATABASE_URL`
(superuser, pre-deploy only) and the four runtime-role URLs.

## Shared variables (generator) and per-service variables

`scripts/self_host_env.sh --platform railway` (alias `--railway`; the two are
byte-identical) reads `RAILWAY_PUBLIC_DOMAIN` and `DATABASE_URL` and prints the
canonical generator key set (heredoc keys + `oort_public_edge_env_keys`, 45)
plus `MOMO_SELF_HOST_PLATFORM=railway` outside the heredoc (46). The team
instance uses `--claim` (zero-base onboarding: the first owner sets their own
password). Write it outside the repo and outside any scratch directory:

```sh
export RAILWAY_PUBLIC_DOMAIN='<the caddy service public host>'
export MOMO_INITIAL_OWNER_EMAIL='<first owner email>'   # also PLATFORM_ADMIN_EMAILS
umask 077; scripts/self_host_env.sh --platform railway --claim > ~/.momo-secrets/railway-oort.env
```

Missing `RAILWAY_PUBLIC_DOMAIN` or `DATABASE_URL` is a hard fail (the compose
`:?` equivalent). `MOMO_CENTRIFUGO_WS_URL=same-origin`. Do not type
`OORT_SITE_ADDRESS` / `OORT_CSP_CONNECT_SRC` by hand.

| Key | Source |
|---|---|
| heredoc + `OORT_SITE_ADDRESS` + `OORT_CSP_CONNECT_SRC` | generator (45) |
| `MOMO_SELF_HOST_PLATFORM=railway` | stamp outside the heredoc (#2328). `railway.json` `notes.platformStamp`. |
| `NOTIFIER_POSTGRES_PASSWORD` / `NOTIFIER_DATABASE_URL` | generator (#2193). Role `momo_notifier`, BYPASSRLS, table-scoped GRANTs. |

1. Paste the file into **Project Settings → Shared Variables** (Raw Editor).
   Then open `OORT_CSP_CONNECT_SRC` and `CENTRIFUGO_ALLOWED_ORIGINS` and check
   the stored values: the generator writes `OORT_CSP_CONNECT_SRC` inside
   dotenv double quotes, and whether the Raw Editor strips them is unmeasured.
   Literal quotes in the CSP header break the SPA; remove them if present.
   `CENTRIFUGO_ALLOWED_ORIGINS` is space separated and must keep every origin.
2. Give each service exactly `services.<name>.variables` from `railway.json`.
   `${{shared.KEY}}` is Railway's reference to a shared variable. Each service
   gets only what its compose twin gets — do not share every variable with
   every service (webhook-sender, for one, must not hold `CENT_API_KEY`).

### Hand-mapped variables

Compose renames, composes or hard-codes these; Railway does not, and the
generator does not print them (it names only three on stderr). Everything else
in `services.<name>.variables` is an identity reference
(`JWT_HMAC` = `${{shared.JWT_HMAC}}`).

| Service | Variable | Value |
|---|---|---|
| api | `DATABASE_URL` | `${{shared.MOMO_APP_DATABASE_URL}}` — role `momo_app`, NOBYPASSRLS. Never the superuser URL. |
| api | `HOST` | `0.0.0.0` (a *legacy* IPv6-only Railway environment needs `[::]` with the brackets; bare `::` fails the `host:port` parse) |
| api | `PORT` | `8080` |
| api | `RAILWAY_RUN_UID` | `0` — the start command drops to uid 10001 itself (see Drive) |
| api | `CENT_API_URL` | `http://centrifugo.railway.internal:8000/api` |
| relay | `CENT_API_URL` | `http://centrifugo.railway.internal:8000/api` |
| agent-worker | `WORKER_DATABASE_URL` | `postgres://momo_worker:${{shared.WORKER_POSTGRES_PASSWORD}}@postgres.railway.internal:5432/${{shared.POSTGRES_DB}}` |
| centrifugo | `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` | `${{shared.CENT_TOKEN_HMAC}}` |
| centrifugo | `CENTRIFUGO_HTTP_API_KEY` | `${{shared.CENT_API_KEY}}` |
| centrifugo | `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS` | `${{shared.CENTRIFUGO_ALLOWED_ORIGINS}}` (space separated: tauri origins + the public https/wss) |
| centrifugo | `CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS` | `{"X-Centrifugo-Proxy-Secret":"${{shared.CENT_PROXY_SECRET}}"}` |
| caddy | `PORT` | `8080` — point the public domain at 8080 |

`MOMO_SELF_HOST_PLATFORM=railway` stays a shared variable; `scripts/oort
doctor --tier t2` reads it from the env file.

### Centrifugo (env, no file mount)

`infra/centrifugo.json` is not mounted. `services.centrifugo.variables` carries
the same settings as `CENTRIFUGO_*` env (namespaces, subscribe proxy to
`http://api.railway.internal:8080/v1/centrifugo/subscribe`, subscription
tokens). The generator writes the **compose variable names** (`CENT_TOKEN_HMAC`,
`CENT_API_KEY`, `CENTRIFUGO_ALLOWED_ORIGINS`, `CENT_PROXY_SECRET`); Centrifugo v6
reads only its own names, so the four rows above map them. Without the mapping
Centrifugo boots silently, a relay publish gets 401 ("API key is empty"), and
every WebSocket upgrade that carries an `Origin` — every browser, the desktop
app — gets 403 ("empty allowed_origins"). `CENTRIFUGO_PORT` is not a v6 key;
the default port is 8000.

## Public edge and `X-Forwarded-Proto`

Railway terminates TLS and hands Caddy plain HTTP (`Caddyfile.railway`:
`{ http_port {$PORT} }` and `http://{$OORT_SITE_ADDRESS}`). Caddy without
`trusted_proxies` overwrites the incoming `X-Forwarded-Proto` with the scheme it
received (`http`), and the api derives `realtimeWebSocketUrl` and the QR
device-link origin from that header (ADR-0167). So the three
`reverse_proxy api.railway.internal:8080` blocks set `header_up
X-Forwarded-Proto https` — deterministic, because a Railway public domain is
always TLS. Do not "fix" realtime with an absolute
`MOMO_CENTRIFUGO_WS_URL=wss://…`: it leaves the QR origin on `http://` and turns
off the device-link SAS requirement (`is_public_origin_mode()` is true only for
`same-origin`). Same handle order as the public Caddyfile (`/v1/centrifugo/*`
403 before `/v1/*`).

## api: pre-deploy, drive volume, privileges

Pre-deploy (`api.preDeployCommand`) is one `/bin/sh -c '…'` string, because
`VAR=… cmd && …` needs a shell. It runs `momo-migrate` twice against
`MIGRATE_DATABASE_URL` — `MOMO_RUNTIME_ROLE_PROVISION=1` (roles, then exit),
then `MOMO_BOOTSTRAP_RUNTIME_ROLES=0` (verify roles, apply `001..NNN`) — measured
in `server-rust/bins/momo-migrate/src/main.rs`: one process is roles **or**
migrations. Pre-deploy has the private network and the service variables but no
volumes. That is why api carries `MIGRATE_DATABASE_URL` and the role passwords;
the api start command removes them with `env -u` before the server starts, so
the running api holds only `DATABASE_URL` = `momo_app`.

Drive (attachments): the generator sets `MOMO_DRIVE_ARCHIVE_BACKEND=local` and
`MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive`. Give api a volume at
`/var/lib/oort/drive`; without it attachments disappear on every redeploy.
Railway volumes mount root-owned and the image runs as uid 10001, which fails
the drive check at boot (`MOMO_DRIVE_LOCAL_DIR could not be created or is not
writable`). Pre-deploy cannot fix it (no volumes there). So api runs with
`RAILWAY_RUN_UID=0`, and its start command creates and chowns the directory,
then `exec setpriv --reuid=momo --regid=momo --init-groups … momo-rust-entrypoint
api` — the server itself runs as uid 10001. Without `RAILWAY_RUN_UID=0` the start
command refuses with exit 78 and says so. The long-term fix is the same
init-and-drop step in the image entrypoint (#2574).

relay, webhook-sender, agent-worker, notifier and push-relay write no volume and
run as the image user.

## Push: push-relay + notifier (ADR-0120, ADR-0187 D4)

Both run in this project. push-relay has no public domain; notifier reaches it
at `http://push-relay.railway.internal:28195/v1/push`. push-relay is the only
service that holds the APNs key; notifier holds only this server's Ed25519
signing key.

Railway has no file secrets or bind mounts, and both binaries read their key
from a file. Each start command decodes one **sealed** base64 variable into
`/dev/shm` (tmpfs) under `umask 077`, unsets the variable, and passes the path
(`MOMO_APNS_KEY_PATH`, `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`). If the platform has
no writable `/dev/shm` the start command refuses (exit 78) rather than write a
key to disk. Holding the `.p8` as a sealed variable departs from the
PushRelay runbook ("a file on the host") and needs owner acceptance.

```sh
# APNs key (the .p8 in ~/.momo-secrets) → sealed variable on push-relay only
base64 < ~/.momo-secrets/<apns-key>.p8 | tr -d '\n'
# this server's relay identity; the private half never leaves this machine + notifier
umask 077; scripts/push_relay_keygen.sh ~/.momo-secrets/railway-relay-key
base64 < ~/.momo-secrets/railway-relay-key/server-ed25519-private.pem | tr -d '\n'
```

| Service | Variable | Value |
|---|---|---|
| push-relay | `APNS_KEY_P8_B64` | sealed: base64 of the APNs AuthKey `.p8` |
| push-relay | `MOMO_APNS_KEY_ID` | the APNs key ID (not in this repo) |
| push-relay | `MOMO_APNS_TEAM_ID` | the Apple Developer team ID (not in this repo) |
| push-relay | `MOMO_RELAY_SERVERS` | `{"oort-team":"<raw Ed25519 public key base64, last line of push_relay_keygen.sh>"}` |
| push-relay | `MOMO_APNS_ENV` | `production` — TestFlight/App Store builds register production tokens; only Xcode/cable (Debug) builds use sandbox, which needs a second relay |
| push-relay | `MOMO_APNS_SENDER` | `live` |
| push-relay | `MOMO_PUSH_RELAY_HOST` | `0.0.0.0` (the compiled default `127.0.0.1` is green to itself and unreachable to notifier) |
| push-relay | `MOMO_PUSH_RELAY_PORT` | `28195` |
| notifier | `RELAY_SIGNING_KEY_B64` | sealed: base64 of `server-ed25519-private.pem` |
| notifier | `PUSH_RELAY_URL` | `http://push-relay.railway.internal:28195/v1/push` |
| notifier | `PUSH_RELAY_SERVER_ID` | `oort-team` — must be the key in `MOMO_RELAY_SERVERS`, or every dispatch is 401 |
| notifier | `MOMO_PUSH_NOTIFIER_ENABLED` | `1` |

Check in the Apple Developer portal that the APNs key's environment scope
includes Production.

## Deploy order

1. Create the project and the services from `railway.json` (image, start
   command, pre-deploy, volumes, variables as tabled). Give **caddy** the public
   domain (custom or `*.up.railway.app`) on port 8080 first: the generator needs
   it as `RAILWAY_PUBLIC_DOMAIN`, and the shared variables come from that run.
2. **postgres** → wait until it accepts connections.
3. **centrifugo**.
4. **api** — pre-deploy runs roles then migrations; the deploy fails if either
   does. Wait for api `/healthz`.
5. **relay**, **webhook-sender**, **agent-worker**.
   - **Upgrading an install that already ran** (#2066): `export
     JWT_HMAC='<the value in use>'` before generating. The generator then emits
     `WEBHOOK_INGRESS_MASTER_KEY` / `OUTBOUND_WEBHOOK_MASTER_KEY` as an explicit
     copy of it (ADR-0004 증보 4 D2(a) — re-issues nothing) and says so on
     stderr. Without it they are fresh randoms and every issued native ingress /
     event-subscription / doorbell secret dies.
   - `OUTBOUND_WEBHOOK_MASTER_KEY` must reach **webhook-sender as well as api**,
     with the same value (the same shared reference). #2066 deleted the
     binary's `JWT_HMAC` fallback: a sender without it refuses to boot, and one
     with a *different* value signs deliveries no subscriber can verify.
6. **push-relay**, then **notifier**. Boot logs name the mode and the registry
   size, never a key: push-relay `starting PushRelay … sender_mode="live"`.
7. **caddy** last; then `https://<domain>/healthz` is the api's JSON.

## First owner claim

With `--claim`, pre-deploy's second `momo-migrate` issues a one-time owner claim
and prints `MOMO_CLAIM_PATH=/claim/<token>` in the **api pre-deploy log** of
that deployment. The owner opens `https://<domain>/claim/<token>` and sets
their password. The token is a credential: never paste it into chat, issues or
this tree. It lives 24 hours. Later deploys print `bootstrap claim skipped — a
live claim already exists (not reprinted)` while it is live; after it expires,
the next deploy's pre-deploy issues a fresh one.

## Verify

```sh
curl -fsS "https://$RAILWAY_PUBLIC_DOMAIN/healthz"
scripts/oort doctor --tier t2 --env ~/.momo-secrets/railway-oort.env --json
```

`public.websocket` sends `Origin: https://<domain>` over HTTP/1.1, so an empty
or wrong Centrifugo `allowed_origins` fails it (403). From a machine outside
the project, `public.*`, `stack.healthz` and `stack.agent_port` are the
meaningful rows: `stack.outbox`, `stack.migrate_idempotency` and
`roles.momo_notifier` read Postgres at `postgres.railway.internal` and fail on
the connection there. Run the full doctor as the image one-off inside the
project (`docs/SELF_HOST_AGENT.md` §3.4 Day-2). An image's own `scripts/oort`
is that image's version: the Origin-sending `public.websocket` is in images
built after #2205.

Two things the doctor cannot see, because every response that carries them
needs a signed-in session:

- the sign-in response's `realtimeWebSocketUrl` must be
  `wss://<domain>/connection/websocket` (not `ws://`), and
- a new device-link QR (`deepLink` `server=`) must be `https://<domain>`.

Check both by hand after the owner claim, then: a WebSocket upgrade with
`Origin: https://<domain>` returns 101, a message typed in one browser tab
arrives in a second tab in real time, and an attachment uploaded before a
redeploy still opens after it.

## Backups and upgrades

- Volumes: enable Railway volume backups on **postgres** and **api** (plan
  permitting).
- Logical dump: `scripts/oort backup --tier t2 --env <env>` as a one-off from
  the image (dump uses `MIGRATE_DATABASE_URL` only); restore one into an
  isolated local PG and compare row counts.
- Upgrade: move the digest in `releases/latest.json`, then every oort-image
  service and `Dockerfile.caddy` in one change, redeploy (pre-deploy migrates),
  re-run Verify. Roll back by redeploying the previous digest; migrations are
  forward-only, so restore the dump if a migration must be undone.

## Not verifiable from the repo

- How Railway splits a start command into argv (the commands assume shell-word
  splitting with single quotes kept).
- Whether the Raw Editor strips dotenv quotes (see Shared variables).
- That `/dev/shm` is present and writable on Railway (the start commands refuse
  without it).
- Railway's edge IP ranges (why `header_up`, not `trusted_proxies`).

Do not paste platform secrets into chat, issues, or the tree. Fixture host in
tests is `example.test`.
