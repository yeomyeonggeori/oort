# Cloudflare T3 edge recipe (SH-11d)

「Cloudflare에 oort를 배포」는 없다. api·PG·Centrifugo는 Workers/Pages/Containers에 올리지 않는다(D1 — 유휴 정지·영속 디스크 미문서·compose 미지원). 이 레시피는 **이미 doctor PASS인 T1(VPS/Fly/AWS) 또는 T2(Railway) 설치 앞에** DNS·Tunnel·TLS를 붙이는 것이며, 사용자가 「Cloudflare로」라고 하면 에이전트는 먼저 컴퓨트 tier를 고르게 한다(D7 판정문 1줄을 설치 보고에).

There is no “deploy oort to Cloudflare.” api, Postgres, and Centrifugo do
not go on Workers, Pages, or Containers (ADR-0184 D1 — idle stop, no
documented persistent disk, no compose). This recipe attaches DNS · Tunnel
· TLS **in front of** a T1 or T2 install that already has doctor PASS. If
the user says “on Cloudflare,” pick a compute tier first. Install-report
line (D7): **여기엔 컴퓨트를 올릴 수 없다, T1/T2를 고르자.**

Same shape for any unnamed platform where persist-volume (D7 ②) and
always-on long WebSocket (D7 ③) are no: it is T3. Tell the user that, then
use this recipe's general form — DNS or named tunnel → loopback/public
Caddy → `scripts/self_host_env.sh --public-origin` → doctor `public.*`.

Playbook row: [`docs/SELF_HOST_AGENT.md`](../../docs/SELF_HOST_AGENT.md) §1
· §3.8. Human walkthrough: [`docs/SELF_HOST.md`](../../docs/SELF_HOST.md)
Platforms. Config: [`cloudflared.config.example.yml`](cloudflared.config.example.yml).
DNS/token: [`dns.example.md`](dns.example.md).

cloudflared is a **host systemd service**. Do not invent a compose file or
an override that “ships” it. Do not edit `infra/rust/Caddyfile*`.

## What wrangler is not for

`wrangler` is the Workers/Pages CLI. This recipe does not use it for DNS or
tunnels. Named tunnels are `cloudflared`; DNS writes are MCP
`mcp.cloudflare.com` (OAuth consent = approval) or REST with a
user-issued API token (`Zone:DNS:Edit` + Cloudflare Tunnel, env only, never
the tree or chat).

## Human approval points (owner account only)

1. Cloudflare login / MCP OAuth consent, **or** API token issue in the
   dashboard. The agent does not click consent.
2. Nameserver delegation at the registrar, if the domain is not already on
   Cloudflare. The agent does not operate the registrar dashboard.
3. (Tunnel mode) Put the tunnel token in the host environment. The agent
   may write it over SSH; it must not print the value.
4. Cleanup (delete tunnel and DNS record) — owner confirms.

No other human steps. Fixture host in this tree: `app.example.test`.

## Mode A — DNS (T1 with a public IP)

1. T1 doctor PASS on the origin (VPS / Fly / AWS). Public Caddy
   (`infra/rust/Caddyfile` + `caddy.override.yml`), not loopback.
2. DNS A/AAAA for `app.example.test` → that public IP. Start **DNS only
   (grey cloud)** so origin Caddy can complete ACME HTTP-01.
3. After the origin cert exists, orange-cloud the record. SSL/TLS mode:
   **Full (strict)** (required when proxied).
4. Measure HTTP-01 through the proxy (`/.well-known/acme-challenge/`). If
   it does not reach origin Caddy, grey-cloud for issuance, then
   orange-cloud again. Do not add a Caddy DNS plugin.
5. Register the Cloudflare hostname and measure the edge:

```sh
scripts/self_host_env.sh --public-origin https://app.example.test
scripts/oort doctor --json
```

   `public.healthz` 200 and `public.websocket` **101** must PASS. A
   `public.*` skip here is a user error, not PASS
   (doctor function `oort_doctor_check_public` — missing
   `CENTRIFUGO_ALLOWED_ORIGINS` is the 「흔적 없음」 branch).
6. `GET https://app.example.test/v1/centrifugo/subscribe` → **403**. Origin
   Caddy already has that handle (`infra/rust/Caddyfile`); do not add a
   second copy.
7. Header diff (origin vs Cloudflare edge) for
   `Strict-Transport-Security`, `X-Content-Type-Options`,
   `Content-Security-Policy`. List anything Cloudflare adds or rewrites.

WebSocket through the orange-cloud record is a measured 101, not an
assumption.

## Mode B — named tunnel (no public IP, no open port)

Closest shape to a Grok Bot VM / NAT VPS. Loopback Caddy
(`infra/rust/Caddyfile.local` via `local.override.yml`).

**Standing install is a named tunnel.** The §3.3.11 quick-tunnel fallback
is temporary/dev only (1015). It is not this recipe.

1. T1/T2 (or Grok Bot loopback) doctor PASS on loopback.
2. Approval 1 (token or MCP OAuth). Approval 2 if the domain is new.
3. On the host, install `cloudflared` (official package or GitHub release
   binary). Create a named tunnel and DNS route — values stay on the host:

```sh
cloudflared tunnel create oort
cloudflared tunnel route dns TUNNEL_UUID app.example.test
```

   Copy [`cloudflared.config.example.yml`](cloudflared.config.example.yml)
   to `/etc/cloudflared/config.yml`. `ingress.service` is
   `http://127.0.0.1:<MOMO_WEB_PORT>` (loopback Caddy). Last rule is
   `http_status:404`. Approval 3: tunnel token / credentials file on the
   host, mode 0600, not printed.
4. systemd unit (host service, not compose):

```
[Unit]
Description=cloudflared named tunnel for oort
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
Restart=on-failure
RestartSec=5s
User=cloudflared

[Install]
WantedBy=multi-user.target
```

   Token-from-dashboard variant: `EnvironmentFile=-/etc/cloudflared/tunnel.env`
   (0600) and `tunnel run --token` reading that file. Still not compose.
5. `--public-origin` is **required**. Omitting it is a failed install:

```sh
scripts/self_host_env.sh --public-origin https://app.example.test
scripts/oort doctor --json
```

   `public.healthz` 200 · `public.websocket` **101**. Skip on 「흔적 없음」
   is a user error on this front, not PASS.
6. `GET https://app.example.test/v1/centrifugo/subscribe` → **403**.
   Loopback Caddy already has the exclusive deny
   (`infra/rust/Caddyfile.local` `handle /v1/centrifugo/*` / `respond 403`).
   If that handle were missing, stop and report to planner — do not patch
   Caddy in this recipe; that would be an edge-contract defect.
7. Header diff (loopback origin vs Cloudflare edge). TLS ends at
   Cloudflare. `Caddyfile.local` does **not** emit HSTS (http loopback on
   purpose) and emits CSP only on the SPA catch-all handle. If the edge
   response therefore lacks origin HSTS/CSP, record that as an SH-11f
   list-constant candidate — do not change `Caddyfile.local` here.
8. Reboot the host once. Measure tunnel reconnect seconds (`Restart=`
   above). Doctor `public.*` must PASS again.

## Edge contract (both modes)

| Probe | Expect |
|---|---|
| `GET https://<host>/healthz` | 200 (`public.healthz`) |
| `GET https://<host>/connection/websocket` Upgrade | 101 (`public.websocket`) |
| `GET https://<host>/v1/centrifugo/subscribe` | 403 |
| `--public-origin` omitted | operator error; doctor skip is not PASS |

Contract proof (static): `scripts/tests/test_cloudflare_recipe.sh`.

## Cleanup

Delete the named tunnel and the DNS record. Approval 4: owner confirms.
Do not leave an orange-cloud record pointing at a torn-down origin.
