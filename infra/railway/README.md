# oort on Railway (SH-5a)

Template for the shipped Rust stack on Railway. Same image, same commands,
same public-edge contract as `infra/rust/docker-compose.rust.yml` +
`caddy.override.yml`. This is **not** a new compose file.

Image pin: `releases/latest.json` (`images.app.ref` + `images.app.digest_list`).
`railway.json` copies that digest so a template deploy is immutable; when
`latest.json` moves, update both in the same change.

## Services

| Service | Image / build | Command | Public |
|---|---|---|---|
| **caddy** | `infra/railway/Dockerfile.caddy` (Caddy 2 + SPA from the oort image) | `caddy run --config /etc/caddy/Caddyfile` | yes (Railway TLS) |
| **api** | `ghcr.io/yeomyeonggeori/oort@sha256:…` | `api` | no — Caddy reverse-proxies `api.railway.internal:8080` |
| **relay** | same image | `relay` | no |
| **webhook-sender** | same image | `webhook-sender` | no |
| **agent-worker** | same image | `agent-worker` | no |
| **centrifugo** | `centrifugo/centrifugo:v6@sha256:…` (compose digest) | `centrifugo` | no — Caddy `/connection/*` |
| **Postgres** | Railway plugin | — | no |

LiveKit / huddle is not in this template.

Caddy is the public service because the API must not be the TLS edge:
`/v1/centrifugo/*` is an exclusive 403 in `Caddyfile.railway`, the same
shape as `infra/rust/Caddyfile`. Putting api on the public domain would
require the server to emit that 403 (out of scope).

Dockerfile.caddy is the Railway stand-in for compose `web-init` (copy
`/opt/momo/web` into the volume Caddy serves). Railway volumes are
per-service, so the copy happens at image build.

## Postgres plugin → runtime URLs

The plugin provides `DATABASE_URL` / `PGHOST` / `PGPORT` / `PGUSER` /
`PGPASSWORD` / `PGDATABASE` (superuser). Compose maps those through
`MIGRATE_DATABASE_URL` and three role URLs.

`scripts/self_host_env.sh --platform railway` (alias `--railway`; the two
are byte-identical) reads `RAILWAY_PUBLIC_DOMAIN` and `DATABASE_URL` and
prints the **canonical generator key set** (heredoc keys +
`oort_public_edge_env_keys`). Do not type `OORT_SITE_ADDRESS` /
`OORT_CSP_CONNECT_SRC` by hand.

```sh
export RAILWAY_PUBLIC_DOMAIN='<the caddy service public host>'
export DATABASE_URL='<plugin DATABASE_URL>'
scripts/self_host_env.sh --platform railway > railway.env
# apply railway.env as shared / per-service variables; never commit it
```

Missing `RAILWAY_PUBLIC_DOMAIN` or `DATABASE_URL` is a hard fail (the
compose `:?` equivalent). `MOMO_CENTRIFUGO_WS_URL=same-origin`.

Keys compose interpolates that are **not** in the generator file (so
`--platform railway` does not print them — key-set equality):

- `CENT_API_URL=http://centrifugo.railway.internal:8000/api` (relay + api)
- `WORKER_DATABASE_URL=postgres://momo_worker:<WORKER_POSTGRES_PASSWORD>@<PGHOST>:<PGPORT>/<PGDATABASE>` (agent-worker)
- api `PORT=8080`, centrifugo `CENTRIFUGO_PORT=8000`
- `CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS` from `CENT_PROXY_SECRET` (same JSON as compose)

api must keep `DATABASE_URL` = `MOMO_APP_DATABASE_URL` (role `momo_app`,
NOBYPASSRLS). preDeploy prefixes `DATABASE_URL=$MIGRATE_DATABASE_URL` only
for the two migrate processes.

## preDeploy (roles then migrate)

Measured in `server-rust/bins/momo-migrate/src/main.rs`: one `migrate`
process is either runtime-roles **or** migrations, not both.

```
MOMO_RUNTIME_ROLE_PROVISION=1 → bootstrap_runtime_roles.sql, exit
MOMO_BOOTSTRAP_RUNTIME_ROLES=0 → verify the three roles, apply 001..NNN
```

`api.preDeployCommand` is those two invocations in order, calling
`/usr/local/bin/momo-migrate` (not the role entrypoint) so a shell `&&`
can sequence them. Image `ENTRYPOINT` is `momo-rust-entrypoint`; a
preDeploy that is passed as entrypoint argv would treat `sh` as a role
and exit 2. If the platform invokes preDeploy as `sh -c <string>`, the
command in `railway.json` is that string.

## Centrifugo (env, no file mount)

`infra/centrifugo.json` is not mounted. Equivalent settings are
`CENTRIFUGO_*` in `railway.json` `services.centrifugo.environment`
(namespaces + subscribe proxy to the api private hostname, port 8080,
path `/v1/centrifugo/subscribe`). HMAC / API key / allowed origins /
proxy static header come from the generator, same names as compose.

## Public edge

Railway TLS → HTTP to Caddy (`Caddyfile.railway`: `{ http_port {$PORT} }`
and `http://{$OORT_SITE_ADDRESS}`). Same handle order as the public
Caddyfile (`/v1/centrifugo/*` 403 before `/v1/*`). Contract proof:
`scripts/tests/test_railway_template.sh` (adapt + 403 order + gate fixture).

## Deploy (planner, when `RAILWAY_TOKEN` is set)

1. Create a Railway project; add the Postgres plugin.
2. Create the six services from `railway.json` (image/startCommand/preDeploy as tabled). Give **caddy** the public domain.
3. Run `--platform railway` (alias `--railway`) with the plugin `DATABASE_URL` and caddy `RAILWAY_PUBLIC_DOMAIN`; load the output as variables; add the three extra keys above.
4. Deploy. Wait until api preDeploy has finished and caddy `/healthz` is 200.
5. `scripts/oort doctor --json` against an env that contains the public origin — `public.healthz` and `public.websocket` must PASS.
6. `railway down` (or delete the project) when the measurement is recorded.

Do not paste platform secrets into chat, issues, or the tree. Fixture host
in tests is `example.test`.
