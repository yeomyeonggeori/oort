# oort on Fly.io (SH-11b)

T1 recipe: **one Machine + one volume** runs the compose canon this repo
already ships. Same images, same public-edge contract as
`infra/rust/docker-compose.rust.yml` + `local.override.yml` (service `web`,
the T1 `--compose` set doctor `stack.compose_ps` requires) +
`caddy.override.yml` + `Caddyfile`. This directory is **not** a new compose
file.

Image pin: `releases/latest.json` (`images.app.ref` + `images.app.digest_list`),
read by `entrypoint.sh` at first boot. Do not type a digest into `fly.toml`
or `Dockerfile.host`.

Fly Machines are Firecracker VMs, not nested Docker. `dockerd` is a process
in the VM; compose runs against that daemon. Docker's `data-root` is
`/data/docker` on the mounted volume so a Machine restart restores images
and named volumes (Postgres, drive archive, Caddy ACME data).

## Edge (A) — canonical, chosen

TLS passthrough on 443 (`handlers = []`) and HTTP on 80 (`handlers = ["http"]`).
Caddy inside the VM uses the **canonical** `caddy.override.yml` + `Caddyfile`
(`{$OORT_SITE_ADDRESS}`), so ACME and `/v1/centrifugo/*` 403 order are
unchanged. No new Caddyfile.

Dedicated IPv4 (`fly ips allocate-v4`) is required for passthrough on Fly's
shared anycast HTTP/TLS proxy. That address is billed; it is a human
approval point.

## Edge (B) — not taken

Fly-terminated TLS (443 `handlers = ["tls"]`) would leave only HTTP inside
the VM. That needs an `http://{$OORT_SITE_ADDRESS}` site file of the same
shape as `infra/railway/Caddyfile.railway`, and it would extend
`scripts/verify_public_edge_centrifugo_contract.sh` fixtures (SH-11f list).
(A) keeps the canon Caddyfile, so (B) stays unused unless a later live run
proves passthrough impossible.

## Env

On the volume only (`/data/oort/infra/rust/local.secrets.env`). Never in the
host image, never in this tree, never `fly secrets import` of that file.

```sh
scripts/self_host_env.sh --platform fly --published-image "$IMAGE_REF" --public-origin https://<host>
```

`$IMAGE_REF` is `jq -er '"\(.images.app.ref)@\(.images.app.digest_list)"' releases/latest.json`.
Do not type `OORT_SITE_ADDRESS` / `OORT_CSP_CONNECT_SRC`. Custom domain:
set `OORT_PUBLIC_ORIGIN=https://<host>` as a Fly secret (the origin URL is
not one of the nine openssl secrets) **or** pass `--public-origin` over
`fly ssh` before first boot; DNS is human.

The nine openssl secrets live in the volume env file
(`POSTGRES_PASSWORD`, `MOMO_APP_POSTGRES_PASSWORD`, `RELAY_POSTGRES_PASSWORD`,
`WORKER_POSTGRES_PASSWORD`, `JWT_HMAC`, `CENT_TOKEN_HMAC`, `CENT_API_KEY`,
`CENT_PROXY_SECRET`, `PROVIDER_LINK_MASTER_KEY`). If you use `fly secrets set`,
set **those nine only** — never the env file. T1 first boot does not need
Fly secrets: the generator mints them onto the volume.

## Procedure

Run `flyctl` from **this directory** (`infra/fly/`) so `fly.toml` and
`Dockerfile.host` are the build context. Commands assume the official
`flyctl` in the user's login (ADR-0184 D2). Do not paste tokens.

1. **Approval point 1 — browser.** `fly auth login`
2. **Approval point 2 — billing** (volume + dedicated IPv4 are paid). Owner
   adds a payment method in the Fly dashboard if the account has none.
3. `fly launch --no-deploy --copy-config`  
   Fills `app` and `primary_region`. Do not deploy yet.
4. `fly volumes create oort_data --size 10`  
   Must match `[[mounts]].source` in `fly.toml`.
5. `fly ips allocate-v4`  
   Required for (A). Monthly cost is recorded on the live E2E, not here.
6. `fly deploy`  
   Builds `Dockerfile.host` (not `fly deploy --image`). First boot clones
   the repo onto `/data/oort`, writes env, compose-up the public overlay.
7. Gate, from the volume checkout:

```sh
fly ssh console -C "bash -lc 'cd /data/oort && scripts/oort doctor --json'"
```

   `public.healthz` 200 and `public.websocket` 101. Public
   `/v1/centrifugo/subscribe` is 403 (canonical Caddyfile).
8. Restart proof: `fly machine restart`, then doctor again and a message
   count that matches the count before restart (volume `data-root`).
9. **Approval point 4 — data destruction.** `fly apps destroy`  
   Fly warns that the volume is deleted. Owner confirms. Do not destroy
   an instance that should stay up.

**(Optional) Approval point 3 — custom domain.** `fly certs add` is **not**
used for (A): Caddy ACME issues the cert. The owner points DNS A/AAAA at
the dedicated IPv4.

## Human approval points

The agent stops at these; the owner uses a browser. Packet §4:

1. Account / billing — `fly auth login`, then a payment method (volume and dedicated IPv4 are paid).
2. Org / app creation — `fly launch --no-deploy --copy-config`.
3. DNS / certs — optional custom-domain DNS A/AAAA. Caddy ACME issues the cert on edge (A); `fly certs add` is not used for (A).
4. Data destruction — `fly apps destroy` (volume wipe confirmation).

## Day-2 (T1, inside the VM)

SSH, then the same CLI as a VPS:

```sh
fly ssh console -C "bash -lc 'cd /data/oort && scripts/oort backup'"
fly ssh console -C "bash -lc 'cd /data/oort && scripts/oort upgrade'"
fly ssh console -C "bash -lc 'cd /data/oort && scripts/oort restore <dump>'"
fly ssh console -C "bash -lc 'cd /data/oort && scripts/oort doctor --json'"
```

`scripts/oort backup` / `restore` / `upgrade` inspect Docker volumes
(`oort_require_volumes`). That is why this recipe is T1: the compose
project lives in the VM.

## Alternative (not implemented here)

If `dockerd` cannot run in the Machine, or both (A) and (B) fail, the
honest re-tier is **T2**: six apps (api · relay · webhook-sender ·
agent-worker · centrifugo · caddy) + Fly Postgres. Record the command and
the error text, then stop (`--blocked`). Do not invent a compose file
this repo does not ship.

Live `flyctl` deploy is **not** part of the recipe-first landing. Evidence
below stays empty until the owner completes approval point 1.

| Measurement | Value |
|---|---|
| doctor JSON pass / skip | runtime-unverified (no owner login this run) |
| restart message count | runtime-unverified |
| deploy → doctor PASS (minutes) | runtime-unverified |
| volume GiB | 10 (template `initial_size`) |
| dedicated IPv4 / monthly cost | runtime-unverified |
| approval count | target ≤ 3 plus destroy-confirm |

Do not paste platform secrets into chat, issues, or the tree. Fixture host
in tests is `example.test`.
