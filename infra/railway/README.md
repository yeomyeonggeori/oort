# oort on Railway — team instance (SH-11a / #2205)

This is the catalog for the team's always-on oort instance (ADR-0187 D2): the
shipped Rust stack, the same image and commands as
`infra/rust/docker-compose.rust.yml` + `caddy.override.yml`, plus the push path
(`push-relay` + `notifier`, ADR-0187 D4). It is **not** a measure-and-delete
run: there is no `railway down` step, and upgrades and backups keep the data.

`railway.json` is a service catalog, not Railway config-as-code. Every value
in it is typed into Railway (UI, CLI or MCP) by hand, service by service.
`scripts/tests/test_railway_template.sh` checks it against what Railway does
with those values (`scripts/tests/check_railway_catalog.py`): every start
command must parse to its canonical command list, and every variable name must
be one its compose twin sets.

Image pin: `releases/latest.json` (`images.app.ref` + `images.app.digest_list`).
`railway.json` (every oort-image service) and `Dockerfile.caddy` (`ARG
OORT_IMAGE`) copy that digest so a deploy is immutable; when `latest.json`
moves, update all of them in the same change
(`scripts/tests/check_railway_release_pins.py`).

## Services

| Service | Source | Start command | Volume | Public |
|---|---|---|---|---|
| **postgres** | `pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c9302…` (compose pin) | image default | `/var/lib/postgresql` | no |
| **centrifugo** | `centrifugo/centrifugo:v6@sha256:8ba0c944…` (compose pin) | `centrifugo` | — | no — Caddy `/connection/*` |
| **api** | `ghcr.io/yeomyeonggeori/oort@sha256:…` | `/bin/sh -c '… exec setpriv … momo-rust-entrypoint api'` + pre-deploy | `/var/lib/oort/drive` | no — Caddy `/v1/*`, `/hooks/*`, `/__momo_stub/*`, `/healthz` |
| **relay** | same image | `momo-rust-entrypoint relay` | — | no |
| **webhook-sender** | same image | `momo-rust-entrypoint webhook-sender` | — | no |
| **agent-worker** | same image | `momo-rust-entrypoint agent-worker` | — | no |
| **hermes** | `nousresearch/hermes-agent@sha256:36099926…` (official image, v0.22.2, same pin as compose) | `/bin/sh -c '… lockgate.py gate …; lockgate.py report & exec …entrypoint-dispatch.sh gateway run'` | `/opt/data` | no — `hermes.railway.internal:8642` only |
| **notifier** | same image | `/bin/sh -c '… exec momo-rust-entrypoint notifier'` | — | no |
| **push-relay** | same image | `/bin/sh -c '… exec momo-rust-entrypoint push-relay'` | — | no |
| **caddy** | `infra/railway/Dockerfile.caddy` (Caddy 2 + SPA from the oort image), build context = repo root | `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile` | — | **yes** (Railway TLS) |

Paste each start command decoded, not as the JSON text: the file escapes quotes
as `\"`, and a pasted `[ \"$(id -u)\" = 0 ]` compares `"0"` with `0`, so api
exits 78 with a misleading `RAILWAY_RUN_UID` message. Decode with
`jq -r '.services.api.startCommand' infra/railway/railway.json` (likewise every
service, and `.services.api.preDeployCommand[0]`). The table abbreviates.
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
(superuser, pre-deploy only) and three runtime-role URLs:
`MOMO_APP_DATABASE_URL`, `RELAY_DATABASE_URL`, `NOTIFIER_DATABASE_URL`. The
fourth role's URL, agent-worker's `WORKER_DATABASE_URL`, is assembled by hand
from `WORKER_POSTGRES_PASSWORD` and `POSTGRES_DB` (hand-mapped table below).

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
   `check_railway_catalog.py` compares each service's names with its compose
   twin's `environment` keys plus the Railway-only extras it names.

### Hand-mapped variables

Compose renames, composes or hard-codes these; Railway does not, and the
generator does not print them (it names only three on stderr). Apart from this
table, the push table below and five Centrifugo literals, every value in
`services.<name>.variables` is an identity reference
(`JWT_HMAC` = `${{shared.JWT_HMAC}}`). Four of the literals stand in for the
mounted `infra/centrifugo.json` (`CENTRIFUGO_CLIENT_SUBSCRIPTION_TOKEN_ENABLED`,
`CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_ENDPOINT`,
`CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_INCLUDE_CONNECTION_META`,
`CENTRIFUGO_CHANNEL_NAMESPACES`); the fifth, `CENTRIFUGO_LOG_LEVEL=info`, is
compose's default (`${CENTRIFUGO_LOG_LEVEL:-info}`). Paste them decoded, e.g.
`jq -r '.services.centrifugo.variables.CENTRIFUGO_CHANNEL_NAMESPACES' infra/railway/railway.json`.

| Service | Variable | Value |
|---|---|---|
| api | `DATABASE_URL` | `${{shared.MOMO_APP_DATABASE_URL}}` — role `momo_app`, NOBYPASSRLS. Never the superuser URL. |
| api | `HOST` | `0.0.0.0` (a *legacy* IPv6-only Railway environment needs `[::]` with the brackets; bare `::` fails the `host:port` parse) |
| api | `PORT` | `8080` |
| api | `RAILWAY_RUN_UID` | `0` — the start command drops to uid 10001 itself (see Drive) |
| api | `MOMO_ATTACHMENT_RECLAIM` | (선택, 기본 꺼짐) 로컬 볼륨 첨부 청소(#4443, ADR-0151 증보 2)를 켠다. **정확히 `1`일 때만 지운다**(`true`·`yes`·빈 값은 꺼짐). 꺼진 채로도 틱마다 지울 수 있는 파일 수·바이트를 로그 한 줄로 남긴다. 켜기 전에 `infra/rust/sql/attachment_reclaim_check.sql`로 대조한다(위 Drive 절). 주기 `MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS`(기본 600000, 최소 10000), 틱당 `MOMO_ATTACHMENT_RECLAIM_BATCH`(기본 50, 1..500). `local` 백엔드에서만 도는 api 프로세스의 잡이고 Google Drive는 notifier가 한다 |
| api | `CENT_API_URL` | `http://centrifugo.railway.internal:8000/api` |
| api | `MOMO_PUBLIC_BASE_URL` | `https://${{shared.OORT_SITE_ADDRESS}}` — the address GitHub is told to call (ADR-0205 D2) and the origin of the invite links an approval decision answers with (ADR-0186); api only. The generator does not write this key: the scheme is typed here, the host is the one already declared for this edge (see "GitHub App on this instance") |
| relay | `CENT_API_URL` | `http://centrifugo.railway.internal:8000/api` |
| agent-worker | `WORKER_DATABASE_URL` | `postgres://momo_worker:${{shared.WORKER_POSTGRES_PASSWORD}}@postgres.railway.internal:5432/${{shared.POSTGRES_DB}}` |
| agent-worker | `OORT_SELF_MEDIA_ORIGIN` | `https://${{shared.OORT_SITE_ADDRESS}}` — this edge's own public origin under the worker's own name (`MOMO_PUBLIC_BASE_URL` stays api only, ADR-0205 D1). With it the worker hands a co-hosted-Hermes turn whose request message carries a photo ONE short-lived (5 min), single-use address of that photo (`/v1/self-media/{workspace}/{token}`); without it no address is minted (#4820 C2a). The same value goes to `hermes` |
| hermes | `OORT_SELF_MEDIA_ORIGIN` | `https://${{shared.OORT_SITE_ADDRESS}}` — the ONE origin the oort image guard lets `image_url` carry. `lockgate.py` refuses a value that is not `https://<lowercase host>[:port]` (no trailing slash, no `:443`) and refuses the name in the volume's `.env` (the file has an allow-list, #4950); unset or empty means the exception is off and every address stays refused (#4820 C2a). The same value as agent-worker |
| agent-worker | `OORT_API_INTERNAL_ORIGIN` | `http://api.railway.internal:8080` — the api's own private address (`privateHostname` + `port` of the api service above), plain `http` on Railway's private network and **never the public edge**. With it the worker reads the picture a person sent (the one the team AI turns into their profile image) **through the api**: it mints a single-use, 60-second address for that one attachment in the database and spends it itself at `{origin}/v1/self-media/{workspace}/{token}`; the api re-judges ownership (the requester's own complete image in that conversation) and answers the bytes. A Railway volume attaches to one service, so the worker cannot mount api's drive volume, and no `MOMO_DRIVE_*` variable is needed on it (#4934, ADR-0151 증보 3). Unset or not a bare `http(s)://host[:port]` the worker reads its own `MOMO_DRIVE_*` archive as before (on Railway that means it cannot, and the proposal falls back to a plain answer). agent-worker only |
| agent-worker | `OORT_HOSTED_MEDIA_STRICT` | _(empty)_ — the operator's attestation that the hosted expression door may open (#4820 C2b, ADR-0218 G3.7 (b)): only an exact `1` opens it, and the template ships it EMPTY so the door is shut and a photo turn of the co-hosted Hermes is an ordinary turn (no failure card). Set `1` on this service only together with the `hermes` row below — and on an existing project last, in the order that row gives. Never a guess: the worker cannot see Hermes, so `1` is your statement that the Hermes it dials is this template's strict one |
| hermes | `HERMES_MEDIA_DELIVERY_STRICT` | `1` — Hermes' own strict media delivery flag: without it Hermes turns a `MEDIA:` line of an answer into the bytes of any readable file it names. `lockgate.py` requires exactly `1` in the process environment on every start, in every mode (it refuses to start otherwise; #4935) and refuses the name in the volume's `.env` whatever its value (the file has an allow-list, #4950); `report` re-checks both after start. A literal in the template, not an operator choice (#4820 C2b 3부). The hosted door opens only when this AND the `agent-worker` row above are on. **Updating an existing project, in this order:** (1) add `HERMES_MEDIA_DELIVERY_STRICT=1` to hermes first; (2) then replace `HERMES_LOCKGATE_B64` and the lockgate sha256 in the start command (one change) — the new gate refuses to start Hermes without (1), so doing (2) alone stops the agent; (3) when the `LOCKGATE` line of the deploy log shows `"media_strict": true`, last of all set `OORT_HOSTED_MEDIA_STRICT=1` on agent-worker |
| api | `HERMES_BASE_URL` | `http://hermes.railway.internal:8642/v1` |
| api | `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` | `1` — a plain `http://` internal host is refused without this opt-in |
| api | `AGENT_PROVIDER_LOCAL_HOSTS` | `hermes.railway.internal` — the exact host, never a wildcard |
| api | `OORT_COHOSTED_AGENT_TOOLS_LOCKED` | `1` — your own declaration that the tool lock holds; the hermes service cannot listen unless the gate exits 0 (see Hermes). api only |
| api | `HERMES_LOGIN_RELAY_URL` | `http://hermes.railway.internal:8643` — the login relay sidecar inside hermes (api only; empty/absent = `409 login_relay_off`) |
| api | `HERMES_LOGIN_RELAY_KEY` | `${{shared.HERMES_LOGIN_RELAY_KEY}}` — the same shared secret hermes holds (api only) |
| api | `HERMES_APP_LOGIN_GOOGLE_PUBLISHING` | optional. `testing` declares that the Google OAuth project is External and in Testing, so the app list shows an estimated 7-day re-login date for the three Google apps (#4081). oort cannot read the project's real status; absent = no such claim |
| api | `TEAM_AI_DAILY_TOKEN_CAP` | optional (#4944, ADR-0201 증보 v3 B9), **not in the template**. The server operator's ceiling on the team AI's tokens per UTC day. Unset or empty = no ceiling (BYOK: an administrator sets any limit in Settings › AI); a positive number = a ceiling no workspace value gets past; `0` = the helper is off. Set the same value on api and agent-worker — agent-worker enforces it, api only reads it to say so on the settings screen |
| api | `TEAM_AI_DAILY_SEARCH_CAP` | optional, **not in the template**. The same ceiling for provider web searches per UTC day (`0` turns off web search only, not the helper). Same value on api and agent-worker |
| agent-worker | `TEAM_AI_DAILY_TOKEN_CAP` | optional, **not in the template** — the same value as on api; this is the process that enforces it |
| agent-worker | `TEAM_AI_DAILY_SEARCH_CAP` | optional, **not in the template** — the same value as on api |
| agent-worker | `HERMES_BASE_URL` | `http://hermes.railway.internal:8642/v1` |
| agent-worker | `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK` | `1` |
| agent-worker | `AGENT_PROVIDER_LOCAL_HOSTS` | `hermes.railway.internal` |
| hermes | `API_SERVER_ENABLED` | `true` |
| hermes | `API_SERVER_HOST` | `0.0.0.0` (environments created after 2025-10-16; a legacy IPv6-only environment would need `::`, which is runtime-unverified) |
| hermes | `API_SERVER_PORT` | `8642` |
| hermes | `API_SERVER_KEY` | `${{shared.HERMES_API_KEY}}` — the shared variable you create by hand, see Hermes |
| hermes | `HERMES_CONFIG_B64` | `base64 < infra/hermes/config.yaml \| tr -d '\n'` (one line). A connector-mode Hermes (Gmail, calendar, drive read-only) takes the connector-mode config instead: `python3 infra/hermes/render_model_config.py --auth <method> [--fallback <method>] --connector-base infra/hermes/google-connectors.config.yaml \| base64 \| tr -d '\n'`. The start command accepts exactly the five configs of `render_model_config.py --catalog` (#4935); compare with `--sha256`, never print a value |
| hermes | `HERMES_LOCKGATE_B64` | `base64 < infra/hermes/lockgate.py \| tr -d '\n'` (one line) |
| hermes | `HERMES_IMAGE_GUARD_B64` | `base64 < infra/hermes/plugins/oort-image-guard/__init__.py \| tr -d '\n'` (one line) — the oort guard that refuses every `image_generate` address, path and non-inline value before the tool runs (#4820, ADR-0203 I2) |
| hermes | `HERMES_IMAGE_GUARD_MANIFEST_B64` | `base64 < infra/hermes/plugins/oort-image-guard/plugin.yaml \| tr -d '\n'` (one line) |
| hermes | `HERMES_LOGIN_RELAY_KEY` | `${{shared.HERMES_LOGIN_RELAY_KEY}}` — the login relay sidecar's own shared secret (`openssl rand -hex 32`, never the chat key); leave the shared variable out and the sidecar does not start (oort answers `login_relay_off`) |
| hermes | `HERMES_LOGIN_RELAY_B64` | `base64 < infra/hermes/login_relay.py \| tr -d '\n'` (one line; needed only with the relay key) |
| hermes | `HERMES_LOGIN_PROBE_B64` | `base64 < infra/hermes/mcp_login_probe.py \| tr -d '\n'` (one line; needed only with the relay key) |
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
the default port is 8000. `scripts/tests/check_railway_catalog.py` holds the
literals to `infra/centrifugo.json` (namespaces, subscribe endpoint path on the
api private host, connection meta, subscription tokens, proxy header name).

## Hermes: the same-server agent (#4072, ADR-0203)

The template carries a **hermes** service so the install ends with 설정 › AI 연결
showing 「같은 서버의 Hermes」 without hand-editing env. It is private (no
domain, `hermes.railway.internal:8642`), the image is the official
`nousresearch/hermes-agent` pinned by index digest (the same value as compose
`hermes`; `check_railway_catalog.py` compares them), and it holds **no oort
variable**: not `DATABASE_URL`, not `PROVIDER_LINK_MASTER_KEY`, not a JWT key.

1. **One shared variable by hand.** The generator does not print it:
   `HERMES_API_KEY=$(openssl rand -hex 32)` as a project shared variable. hermes
   reads it as `API_SERVER_KEY`; api and agent-worker as `HERMES_API_KEY`
   (the gate refuses a key under 32 characters).
2. **Four base64 variables on hermes** (hand-mapped table): `HERMES_CONFIG_B64`
   from `infra/hermes/config.yaml` (22 toolsets off, Codex subscription search and
   image generation on, the image guard enabled, approvals manual/deny, no model, no connector),
   `HERMES_LOCKGATE_B64` from `infra/hermes/lockgate.py`, and the two files of the oort image guard
   plugin, `HERMES_IMAGE_GUARD_B64` (`plugins/oort-image-guard/__init__.py`) and
   `HERMES_IMAGE_GUARD_MANIFEST_B64` (`plugins/oort-image-guard/plugin.yaml`).
3. **Start order.** The start command writes the config, the gate and the guard plugin
   (into `/opt/data/plugins/oort-image-guard`), checks the gate and the plugin files against the sha256 of the repo files and
   the config against a LIST of sha256 values (an empty, stale or swapped variable stops the service; the five accepted
   configs are the default config and a connector-mode config for each model fragment, `render_model_config.py --catalog`;
   `check_railway_catalog.py` recomputes the hashes, so changing `config.yaml`, `google-connectors.config.yaml`, a model fragment,
   `lockgate.py` or a plugin file means updating the command in the same change), runs `lockgate.py gate` and only then `exec`s the Hermes
   dispatcher. A non-zero gate (`set -e`) means the service never listens. When image generation is
   exposed the gate also hashes the installed plugin again, requires it as the only entry of
   `plugins.enabled`, refuses the switches that turn Hermes' private-address filter or the plugin off
   (private-URL settings, proxies, safe mode, project plugins) and runs a canary through the real
   dispatch path: refused examples must be blocked before the tool runs, an allowed one must reach it.
   **Login relay (#4078, ADR-0203 증보 2026-10-19):** with `HERMES_LOGIN_RELAY_KEY` set, the start
   command also decodes `login_relay.py` and `mcp_login_probe.py` (pinned by sha256 the same way) and,
   after the gate, starts the sidecar in the background on `:8643` (private, no domain). The sidecar
   moves the key into a `0400` file of its own uid, runs the fixed `hermes` login commands as the
   `hermes` uid in a new process group, and the key variables are unset before the dispatcher, so the
   gateway and the agent hold no copy. Whether Railway lets the start command do that uid separation
   is `runtime-unverified`; if it cannot, the sidecar logs `relay off` and Hermes starts unchanged. The deploy log shows one
   `LOCKGATE {"ok": true, …}` line and, after start, one `LOCKREPORT` line with
   six checks. Read them before you trust the card.

   **The volume's `.env` has an allow-list (#4950, ADR-0203 증보 2026-11-01).** Hermes loads
   `/opt/data/.env` after the gate and applies every name in it, so the gate lets the file hold only
   the names its comments list (`VOLUME_ENV_SECRETS`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, any value) and the eleven template lines
   Hermes' own first boot copies into a fresh volume (`VOLUME_ENV_SEEDED`, those values only). Any other
   name stops the start by name (never by value), and so does a `.op.env` beside it; `report` judges the
   same file with the same function after start. **Before replacing `HERMES_LOCKGATE_B64` on a project
   that already runs Hermes, read the NAMES in its `.env`** (never the values) and remove what is not on
   the list, or the next start is refused: the check is in `docs/RELEASING.md`, "Hermes step".
4. api and agent-worker get the wiring from the hand-mapped table (host,
   loopback opt-in with the exact host, and on api the lock declaration).
   `OORT_COHOSTED_AGENT_TOOLS_LOCKED=1` is **your own declaration**; here it is
   backed by the gate above. If you edit the config, the gate, or the start
   command, you are taking that backing back on yourself.
5. As the instance operator (`PLATFORM_ADMIN_EMAILS`) open 설정 › AI 연결: the
   card appears, one click connects. Model authentication (API key or OAuth
   login) is a separate step: until it is done the card still appears and a
   chat turn answers that Hermes is not connected to a provider.

Bind address (ADR-0203 D9): `API_SERVER_HOST=0.0.0.0`. The Railway environment
creation date decides whether that is enough; the production environment of the
team instance was created 2026-09-23 (after 2025-10-16), and the `hermes-kwak`
service (#3952) ran this way. `::` is not used and stays runtime-unverified.

Local opt-in, read this once: `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` is the
switch the exact-host list hangs on, and it also admits physical loopback
(`localhost`, `127.0.0.1`, `::1`) for provider URLs the instance operator sets.
That is the existing ADR-0004 증보 behavior of the manual §3.4.1 path, not new
here; narrowing it to the listed host alone needs a server change (follow-up).

Data: Hermes keeps sessions, memories and `state.db` on its own volume
(`/opt/data`), outside oort's database and `oort backup`. Enable volume backups
on **hermes** yourself; removing the agent in oort does not delete the volume.

## Public edge: `X-Forwarded-Proto` and client IP

Railway terminates TLS and hands Caddy plain HTTP (`Caddyfile.railway`:
`{ http_port {$PORT} }` and `http://{$OORT_SITE_ADDRESS}`). Caddy without
`trusted_proxies` overwrites the incoming `X-Forwarded-Proto` with the scheme it
received (`http`), and the api derives `realtimeWebSocketUrl` and the QR
device-link origin from that header (ADR-0167). So the four
`reverse_proxy api.railway.internal:8080` blocks set `header_up
X-Forwarded-Proto https` — deterministic, because a Railway public domain is
always TLS. Do not "fix" realtime with an absolute
`MOMO_CENTRIFUGO_WS_URL=wss://…`: it leaves the QR origin on `http://` and turns
off the device-link SAS requirement (`is_public_origin_mode()` is true only for
`same-origin`). Same handle order as the public Caddyfile (`/v1/centrifugo/*`
403 before `/v1/*`).

### Client IP: the per-IP limits and what feeds them

The same four blocks set `header_up X-Forwarded-For {http.request.header.X-Real-IP}`.
The api keys its per-IP limits on `rate_limit::client_ip`: the first
`X-Forwarded-For` value, or else the socket peer.

| Surface | Default limit (per 60 s) | Keyed on |
|---|---|---|
| `POST /v1/claim` | 30 | client IP |
| `POST /v1/auth/device-link/redeem` | 30 (claim budget) | client IP |
| `POST /v1/join` | 1200 | client IP |
| password change | 10 per member, 30 per IP | member always; IP only when `X-Forwarded-For` has a value — it calls `client_ip(headers, None)`, so an empty value turns the IP axis off |

Caddy has no `trusted_proxies`, so it replaces the edge's `X-Forwarded-For`
with its own peer, Railway's edge. Without the `header_up` line every request
would carry that one address: a single bucket that one anonymous caller can
exhaust, locking everyone out of claim and device linking. With it, the api
gets whatever Railway's edge puts in `X-Real-IP`, and a client-sent
`X-Forwarded-For` never reaches it. If `X-Real-IP` is missing the value is
empty and `client_ip` falls back to its socket peer — the caddy container's
address, which is again one bucket for everybody.

**Unproven until measured.** Whether `X-Real-IP` is the real client is
Railway's behaviour, not this repo's, and the only sources are staff answers on
Railway's forum, not documentation:

- 2026-03: on the CDN path `X-Real-IP` is currently the CDN edge's address, a
  bug they are tracking; they advised the first `X-Forwarded-For` value.
- 2026-06: the edge strips `X-Forwarded-For`, and its first value is the
  connecting IP.
- Routing paths were reported to change every week or two.
- Since 2024-08 a client cannot forge `X-Real-IP` through the edge.

A forged-header test alone would pass on the CDN path while every client
behind one CDN address still shares a bucket, so the gate below measures the
property itself: distinct clients get distinct buckets.

### Client-IP gate

Run it after the deploy and before anyone but the owner uses the instance.
**Until it passes, do not share the claim link and do not invite the team.**
It needs two networks with different public IPs, A and B (for example office
Wi-Fi and a phone hotspot); bogus claims only ever get 400 or 429.

1. On network A, note the public IP: `curl -s https://checkip.amazonaws.com`.
2. From A, send 31 bogus claims:
   ```sh
   for i in $(seq 31); do
     curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
       --data '{"token":"not-a-claim-token","password":"bogus-claim-password"}' "https://$RAILWAY_PUBLIC_DOMAIN/v1/claim"
   done | sort | uniq -c        # expect 30 × 400 and 1 × 429
   ```
3. In the api logs (`railway logs --service api`, or the api service's Deploy
   Logs in the dashboard) the throttle line `rate limit exceeded (per-ip)`
   must name A's IP: `ip=<address> … surface="/v1/claim"`. **FAIL** if the address is not A's
   public IP — a `100.x.y.z` address (Railway's internal range) or a Fastly
   address means the edge, not the client, is being counted.
4. Within 60 s, from network B, send one bogus claim: it must get **400**, not
   429.
5. Wait 60 s and repeat 2–4 with forged headers on every request
   (`-H 'X-Real-IP: 192.0.2.1' -H 'X-Forwarded-For: 192.0.2.1'`): the logged
   `ip=` must still be A's IP and B must still get 400.
6. Repeat the whole gate about two weeks later; the edge's routing path changes.

PASS is steps 2–5 all as stated. On FAIL, keep the claim link and invites
closed and switch the edge configuration as below.

### If the gate fails: trust the edge instead

1. Find the edge's peer addresses. Temporarily add to the site block of
   `Caddyfile.railway`
   ```
   	log {
   		output stdout
   		format filter {
   			wrap json
   			fields {
   				request>uri delete
   			}
   		}
   	}
   ```
   The filter drops the request URI: upload capability URLs
   (`/__momo_stub/drive/uploads/<capability>`) and `/hooks/<token>` are
   secrets, and this step needs only `remote_ip` (#2609 — measured: a plain
   `format json` access log wrote the capability on every request; with the
   filter the access log has no `uri` field and still has `remote_ip`).
   Redeploy caddy, send a few requests, and read `"remote_ip"` (the
   `{remote_host}` of each request) in the caddy logs, e.g.
   `railway logs --service caddy | grep -o '"remote_ip":"[^"]*"' | sort | uniq -c`.
   Community reports say `100.0.0.0/8` (unofficial). Remove the `log` block
   afterwards.
2. If the forged `X-Forwarded-For` in step 5 never won (the edge strips it and
   its first value is the client — Railway's own advice), trust the edge and
   drop the four `header_up X-Forwarded-For` lines:
   ```
   {
   	http_port {$PORT}
   	servers {
   		trusted_proxies static 100.0.0.0/8
   	}
   }
   ```
   Caddy then keeps the edge's `X-Forwarded-For` and appends the peer, and the
   api reads the first value. Verified locally: the api receives
   `203.0.113.7, <peer>` for an edge-set `203.0.113.7`. Do not use this form if
   the edge appends: then a forged first value is what the api reads.
3. If the edge appends to a client-sent `X-Forwarded-For`, parse it right to
   left and hand the api only the address the edge saw:
   ```
   {
   	http_port {$PORT}
   	servers {
   		trusted_proxies static 100.0.0.0/8
   		trusted_proxies_strict
   	}
   }
   ```
   and in each of the four api blocks
   `header_up X-Forwarded-For {client_ip}`. Verified locally: for both
   `203.0.113.7` and a forged `198.51.100.9, 203.0.113.7` the api receives
   exactly `203.0.113.7`.
4. If step 3 of the gate logged a Fastly address (the CDN path), add Fastly's
   published ranges (`https://api.fastly.com/public-ip-list`) to the same
   `trusted_proxies static` list and use form 3.

Re-run the gate after any of these; the peer range is only as good as the
measurement behind it.

## api: pre-deploy, drive volume, privileges

Pre-deploy (`api.preDeployCommand`) is one `/bin/sh -c '…'` string, because
`VAR=… cmd && …` needs a shell. It runs `momo-migrate` twice against
`MIGRATE_DATABASE_URL` — `MOMO_RUNTIME_ROLE_PROVISION=1` (roles, then exit),
then `MOMO_BOOTSTRAP_RUNTIME_ROLES=0` (verify roles, apply `001..NNN`) — measured
in `server-rust/bins/momo-migrate/src/main.rs`: one process is roles **or**
migrations. Pre-deploy has the private network and the service variables but no
volumes. That is why api carries `MIGRATE_DATABASE_URL` and the role passwords;
the api start command removes them with `env -u` before the server starts, so
the running api holds only `DATABASE_URL` = `momo_app` (`POSTGRES_PASSWORD` is
dropped too, in case every shared variable was shared with api).

`RAILWAY_RUN_UID=0` is a service variable, so pre-deploy runs as root as well.
`momo-migrate` needs no root (it reads the baked SQL and talks to Postgres), so
the pre-deploy string defines `run()`: as root it runs each `momo-migrate`
through `setpriv --reuid=momo --regid=momo --init-groups`, as any other user it
runs it as is.

Drive (attachments): the generator sets `MOMO_DRIVE_ARCHIVE_BACKEND=local` and
`MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive`. Give api a volume at
`/var/lib/oort/drive`; without it attachments disappear on every redeploy.
The client uploads with a same-origin `PUT` to
`https://<domain>/__momo_stub/drive/uploads/<capability>` (ADR-0169), so
`Caddyfile.railway` proxies `/__momo_stub/*` to the api; without that handle
the SPA handle takes the `PUT` and answers 405, and the upload never completes
(measured on Railway: upload 405 → complete 404 → message send 409).
Railway volumes mount root-owned and the image runs as uid 10001, which fails
the drive check at boot (`MOMO_DRIVE_LOCAL_DIR could not be created or is not
writable`). Pre-deploy cannot fix it (no volumes there). So api runs with
`RAILWAY_RUN_UID=0`, and its start command creates and chowns the directory,
then `exec setpriv --reuid=momo --regid=momo --init-groups … momo-rust-entrypoint
api` — the server itself runs as uid 10001. The chown is recursive (`chown -R`),
so files a root one-off left behind (a restore, say) are handed back to momo;
it walks the whole volume on every start, which is cheap at team scale. Without `RAILWAY_RUN_UID=0` the start
command refuses with exit 78 and says so. The long-term fix is the same
init-and-drop step in the image entrypoint (#2574).

Attachment cleanup (#4443, ADR-0151 amendment 2): an upload that no message,
scheduled message, huddle transcription or avatar holds is deleted 30 days after
the later of its upload and the last release of a hold. Only the api process can
open this volume, so **on the local backend the api runs the cleanup** (the
notifier does it for a Google Drive). **It ships off.** Until `MOMO_ATTACHMENT_RECLAIM`
is exactly `1` on the api service it deletes nothing; switched off it still writes one
line per tick (every `MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS`, default 600000):
`attachment reclaim dry-run: delete_enabled=false scope=touched looked_at=N workspaces=W
candidates=C bytes=B …`. Before turning it on, run
`psql "$DATABASE_URL" -X -f infra/rust/sql/attachment_reclaim_check.sql` as a superuser (read
only; its header says how to compare with the log line: the log may be smaller than the
SQL's `candidates`, never larger, and a `UNKNOWN` foreign key in section 4 means stop). The
api looks only at workspaces **whose uploads it has served since it started** (it has no
cross-tenant read, and no new `SECURITY DEFINER` was made for it), so an old draft in a
workspace nobody has uploaded to since the last restart stays until somebody does.

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
(`MOMO_APNS_KEY_PATH`, `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`). Unless `/dev/shm`
is a writable tmpfs (`stat -f -c %T /dev/shm` = `tmpfs`) the start command
refuses (exit 78) rather than write a key to disk. Holding the `.p8` as a sealed
variable departs from the PushRelay runbook ("a file on the host"); the owner
approved it on 2026-09-23 (ADR-0187 §5, 2차 결재: 「Railway 배포 + APNs 키 변수」).

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
| notifier | `MOMO_HUDDLE_SWEEP_DATABASE_URL` | `${{shared.MOMO_APP_DATABASE_URL}}` — the huddle ghost sweep (#2758, ADR-0122 증보 D-H4) writes only through this RLS-bound `momo_app` connection; its own `NOTIFIER_DATABASE_URL` (BYPASSRLS) only reads. The sweep refuses a BYPASSRLS URL here |
| notifier | `MOMO_LIVEKIT_API_KEY` | the api's value (#2759). All three `MOMO_LIVEKIT_*` or none: without them the sweep does not run (and huddles are not configured on the api either) |
| notifier | `MOMO_LIVEKIT_API_SECRET` | sealed: the api's value (#2759) |
| notifier | `MOMO_LIVEKIT_URL` | the api's value (#2759). The sweep calls LiveKit RoomService there (server → LiveKit HTTPS only) |
| notifier | `MOMO_AVATAR_RECLAIM_DATABASE_URL` | (선택) 아바타 Drive 회수 잡(#3284, ADR-0161 증보 2)의 쓰기 연결 — 기본은 위 `MOMO_HUDDLE_SWEEP_DATABASE_URL`(같은 RLS-bound `momo_app`). BYPASSRLS URL 은 거절한다 |
| notifier | `MOMO_ATTACHMENT_RECLAIM_DATABASE_URL` | (선택) 첨부 Drive 회수 잡(#4443, ADR-0151 증보 2)의 쓰기 연결 — 기본은 `MOMO_AVATAR_RECLAIM_DATABASE_URL`, 그다음 위 `MOMO_HUDDLE_SWEEP_DATABASE_URL`(같은 RLS-bound `momo_app`). 후보 목록·건수 집계·삭제가 모두 이 연결의 워크스페이스별 트랜잭션이고(notifier 자신의 연결은 워크스페이스 id만 읽는다), BYPASSRLS URL 은 거절한다. 어떤 메시지·예약·huddle 전사·아바타 객체도 쥐지 않고 업로드(또는 마지막 점유 해제)로부터 30일이 지난 완료 첨부의 Drive 객체와 행을 지운다. **기본 꺼짐**: `MOMO_ATTACHMENT_RECLAIM`이 정확히 `1`일 때만 지우고, 꺼진 채로는 틱마다 dry-run 한 줄만 남긴다(켜기 전 대조는 `infra/rust/sql/attachment_reclaim_check.sql`). 위 Drive 두 값과 같은 조건(Google 백엔드)에서만 돈다 — 기본 `local` 백엔드는 api 프로세스가 같은 일을 한다(api 의 `MOMO_ATTACHMENT_RECLAIM`). 주기 `MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS`(기본 600000), 틱당 `MOMO_ATTACHMENT_RECLAIM_BATCH`(기본 50). 30일은 환경변수가 아니라 상수다. 켠 뒤 끄려면 변수를 `1`이 아닌 값으로 돌린다(아바타 잡과 Drive 값을 공유하므로 Drive 값은 지우지 않는다) |
| notifier | `MOMO_SHARE_RETENTION_DATABASE_URL` | (선택) 공유 세션 보존 잡(#2862, #3377)의 삭제 연결 — 기본은 위 `MOMO_HUDDLE_SWEEP_DATABASE_URL`(같은 RLS-bound `momo_app`). notifier 역할(`NOTIFIER_DATABASE_URL`)에는 DELETE 가 없어 후보 읽기만 하고, 둘 다 없으면 잡을 켜지 않는다. BYPASSRLS URL 은 거절한다. `MOMO_SHARE_RETENTION_INTERVAL_MS`(기본 600000) 로 주기를 바꾼다 |
| notifier | `MOMO_DRIVE_SA_KEY_PATH` / `MOMO_DRIVE_SHARED_DRIVE_ID` | (선택) **Google Drive 백엔드에서만** 회수 잡(아바타, 첨부)이 돈다(api 와 같은 값). 기본 `local` 백엔드(위 Drive 절)는 api 볼륨을 notifier 가 마운트할 수 없어 notifier 는 회수하지 않는다 — 첨부는 api 프로세스가 청소하고(위 Drive 절), 아바타 미디어는 아직 후속 이슈다. 주기 `MOMO_AVATAR_RECLAIM_INTERVAL_MS`(기본 600000), 틱당 `MOMO_AVATAR_RECLAIM_BATCH`(기본 50) |

Check in the Apple Developer portal that the APNs key's environment scope
includes Production.

## Deploy order

The generator needs the public host, and every other service needs the
generator's output, so the domain comes first:

1. Create the project and only the **caddy** service (Dockerfile build). In its
   settings generate the public domain (custom or `*.up.railway.app`) on port
   8080. It does not have to deploy yet.
2. Pick the Postgres password, compose `DATABASE_URL`, run the generator with
   that host as `RAILWAY_PUBLIC_DOMAIN`, paste the output as shared variables
   (Shared variables above), then give caddy its `variables`.
3. Create the other services from `railway.json` (image, start command,
   pre-deploy, volume, `variables`) and deploy them in this order:
4. **postgres** → wait until it accepts connections.
5. **centrifugo**.
6. **api** — pre-deploy runs roles then migrations; the deploy fails if either
   does. Wait for api `/healthz`.
7. **relay**, **webhook-sender**, **agent-worker**, and **hermes** (create the
   `HERMES_API_KEY` shared variable first; read `LOCKGATE ok` in its deploy log).
   - **Upgrading an install that already ran** (#2066): `export
     JWT_HMAC='<the value in use>'` before generating. The generator then emits
     `WEBHOOK_INGRESS_MASTER_KEY` / `OUTBOUND_WEBHOOK_MASTER_KEY` as an explicit
     copy of it (ADR-0004 증보 4 D2(a) — re-issues nothing) and says so on
     stderr. Without it they are fresh randoms and every issued native ingress /
     event-subscription / doorbell secret dies.
   - `GITHUB_APP_MASTER_KEY` (ADR-0205, #3947) reaches **api only** (one shared
     reference, optional: empty ⇒ only the GitHub 알림 surface is 503). Do not add
     it to agent-worker, relay or any Hermes service. The owner sets the value;
     the generator emits a fresh random for a new project. `MOMO_PUBLIC_BASE_URL`
     (#4221) is api only as well. An install that predates #3947 adds both by
     hand: see "GitHub App on this instance".
   - `OUTBOUND_WEBHOOK_MASTER_KEY` must reach **webhook-sender as well as api**,
     with the same value (the same shared reference). #2066 deleted the
     binary's `JWT_HMAC` fallback: a sender without it refuses to boot, and one
     with a *different* value signs deliveries no subscriber can verify.
8. **push-relay**, then **notifier**. Boot logs name the mode and the registry
   size, never a key: push-relay `starting PushRelay … sender_mode="live"`.
9. **caddy** (re)deploy last; then `https://<domain>/healthz` is the api's JSON.
10. **Client-IP gate** (Public edge → Client-IP gate). Until it passes, do not
    share the claim link and do not invite the team.

## First owner claim

With `--claim`, pre-deploy's second `momo-migrate` issues a one-time owner claim
and prints `MOMO_CLAIM_PATH=/claim/<token>` in the **api pre-deploy log** of
that deployment. The owner opens `https://<domain>/claim/<token>` and sets
their password. The token is a credential: never paste it into chat, issues or
this tree. It lives 24 hours. Later deploys print `bootstrap claim skipped — a
live claim already exists (not reprinted)` while it is live; after it expires,
the next deploy's pre-deploy issues a fresh one. The owner may claim before the
client-IP gate passes; nobody else gets the link until it does.

## Verify

1. Health and doctor:
   ```sh
   curl -fsS "https://$RAILWAY_PUBLIC_DOMAIN/healthz"
   scripts/oort doctor --tier t2 --env ~/.momo-secrets/railway-oort.env --json
   ```
   `public.websocket` sends `Origin: https://<domain>` over HTTP/1.1, so an
   empty or wrong Centrifugo `allowed_origins` fails it (403). From a machine
   outside the project, `public.*`, `stack.healthz` and `stack.agent_port` are
   the meaningful rows: `stack.outbox`, `stack.migrate_idempotency` and
   `roles.momo_notifier` read Postgres at `postgres.railway.internal` and fail
   on the connection there. Run the full doctor as the image one-off inside the
   project (`docs/SELF_HOST_AGENT.md` §3.4 Day-2). An image's own
   `scripts/oort` is that image's version: the Origin-sending
   `public.websocket` is in images built after #2205.
2. After the owner claim, by hand — the doctor cannot see these, because every
   response that carries them needs a signed-in session:
   - the sign-in response's `realtimeWebSocketUrl` is
     `wss://<domain>/connection/websocket` (not `ws://`);
   - a new device-link QR (`deepLink` `server=`) is `https://<domain>`.
3. A WebSocket upgrade with `Origin: https://<domain>` returns 101, a message
   typed in one browser tab arrives in a second tab in real time, and an
   attachment uploaded before a redeploy still opens after it.
4. **Client-IP gate** (Public edge → Client-IP gate). It must PASS before the
   claim link is shared or the team is invited; repeat it about two weeks
   later.

## GitHub App on this instance (ADR-0205, #4221)

The GitHub surface (`/v1/integrations/github/*`) reads two **api** variables.
No other service holds either: `check_railway_catalog.py` walks every service
of the catalog, by name and by `${{shared.GITHUB_APP_MASTER_KEY}}` reference.

- `GITHUB_APP_MASTER_KEY` = `${{shared.GITHUB_APP_MASTER_KEY}}`: the key that
  seals the App's private key and webhook secret in the database. Absent, the
  GitHub routes answer 503 (an unsigned webhook is refused with 401 first) and
  every other route is untouched. It must differ from `JWT_HMAC`, both webhook
  master keys and `PROVIDER_LINK_MASTER_KEY` (the api refuses to boot
  otherwise). It never reaches agent-worker, relay, webhook-sender, notifier or
  the Hermes service (ADR-0205 D1, ADR-0203 D6-2).
- `MOMO_PUBLIC_BASE_URL` = `https://${{shared.OORT_SITE_ADDRESS}}`: what the
  App manifest tells GitHub to call (webhook, redirect, setup URL), and the
  origin of the invite links an approval decision answers with (ADR-0186). The
  api reads it only as an absolute `https://` origin with a host; anything else
  is ignored with one startup warning and the App registration answers 409
  `public_address_required`. A wrong host behind a correct prefix is not
  detected by the api at all, which is why the catalog pins the exact
  reference. `OORT_SITE_ADDRESS` is the host the generator derived from
  `RAILWAY_PUBLIC_DOMAIN` (scheme stripped), the one host Caddy serves, so the
  two cannot drift. `MOMO_T3_ENABLED` is not part of this catalog, so the address
  is not handed to a workd (`ready_t3` answers 503 before it reads the URL);
  setting that flag by hand changes this.

**An install that predates #3947** has no `GITHUB_APP_MASTER_KEY` among its
shared variables. Add that one variable by hand. Do not re-render the generator
over live variables: every secret key that is not exported is minted fresh
(`JWT_HMAC`, the Centrifugo secrets, `PROVIDER_LINK_MASTER_KEY`, the two
webhook master keys, the database role passwords), which rotates them under a
running instance once pasted. The generator is for a new project.

1. **Key**, in the generator's own shape (`gen()` in
   `scripts/self_host_env.sh`). Nothing can re-derive it and a lost key means
   registering the App again, so keep the file:
   ```sh
   umask 077; mkdir -p ~/.momo-secrets
   openssl rand -hex 24 > ~/.momo-secrets/railway-github-app-master-key
   ```
2. **Shared variable**: Project Settings → Shared Variables → new variable
   `GITHUB_APP_MASTER_KEY` with the file's content. `railway variable set` is
   service-scoped (CLI 4.27 has no shared flag), so this step is the dashboard.
   `pbcopy < ~/.momo-secrets/railway-github-app-master-key` fills the clipboard
   without printing the value; `pbcopy < /dev/null` clears it afterwards.
3. **api references**, single-quoted so the shell leaves `${{ }}` alone, with
   `--skip-deploys` so setting them does not redeploy the running image. Run it
   from a directory linked to the team project; `railway status` names the
   project and environment it will change (`-s api` assumes the service is
   named `api`):
   ```sh
   railway variable set 'GITHUB_APP_MASTER_KEY=${{shared.GITHUB_APP_MASTER_KEY}}' \
     'MOMO_PUBLIC_BASE_URL=https://${{shared.OORT_SITE_ADDRESS}}' -s api --skip-deploys
   ```
   They take effect with the next api deployment, the one that carries the
   image with the GitHub routes. That the CLI stores `${{shared.…}}` as a live
   reference is not verifiable from the repo; the api service's Variables tab
   takes the same two values. If `OORT_SITE_ADDRESS` is not the bare host,
   type `https://<domain>` for `MOMO_PUBLIC_BASE_URL` instead.
4. **After that deployment** (`<domain>` is the caddy public host):
   - As the instance operator, `GET /v1/integrations/github/app` answers 200
     with `masterKeyConfigured` and `publicAddressConfigured` both `true`. The
     second only proves an `https://` prefix and a host.
   - The value itself, with no bearer and nothing written:
     ```sh
     curl -si "https://<domain>/v1/integrations/github/setup" | grep -i '^location:'
     ```
     is `location: https://<domain>/?githubInstall=invalid_request` (status 303).
     503 means no key, 409 means no usable address.
   - An unsigned request is refused before the key is consulted:
     ```sh
     curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://<domain>/v1/integrations/github/webhook"
     ```
     prints `401`.
5. Registering the App itself (GitHub's manifest screen) is the owner's step in
   oort, not part of this catalog.

## Backups and upgrades

- Volumes: enable Railway volume backups on **postgres**, **api** and **hermes**
  (plan permitting). Hermes' volume is not in `oort backup`.
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
- The hermes start command on a fresh Railway service (the `hermes-kwak`
  service of #3952 ran the same shape; this template's `hermes` was checked only
  against the catalog rules and the local compose twin), and `::` binding.
- That `/dev/shm` is present and writable on Railway (the start commands refuse
  without it).
- What Railway's edge puts in `X-Real-IP` (on the CDN path it is reported to
  be the CDN edge's address) and the edge's peer ranges. The client-IP gate
  measures the first; the temporary access log under "If the gate fails" shows
  the second.

Do not paste platform secrets into chat, issues, or the tree. Fixture host in
tests is `example.test`.
