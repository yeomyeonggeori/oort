# Cloudflare DNS examples (SH-11d)

Fixture host: `app.example.test`. Never a live zone, token, or operator
hostname in this tree.

Tokens live in the operator's environment only (`CLOUDFLARE_API_TOKEN` as
a name — no `=` value in this file). Issuing the token is a human approval
point.

## Mode A — DNS in front of a T1 with a public IP

Record shape (RFC 5737 TEST-NET-1 is the example address, not a live
origin):

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `app` | `203.0.113.10` | DNS only (grey) while origin Caddy issues an ACME cert |
| A | `app` | `203.0.113.10` | Proxied (orange) after the origin cert exists |

AAAA is the same shape if the T1 has a public IPv6.

When the record is proxied, SSL/TLS mode is **Full (strict)**. Flexible and
Full (not strict) are forbidden — they would talk HTTP or an unverified
cert to origin Caddy.

HTTP-01 through an orange-cloud record is **unmeasured** in this recipe.
Measure `/.well-known/acme-challenge/` from the public hostname. If it does
not reach origin Caddy, grey-cloud the record for issuance, then orange-cloud
again. Do not add a Caddy DNS plugin; `infra/rust/Caddyfile*` stays
unmodified.

WebSocket: measure `GET /connection/websocket` Upgrade → 101 on
`https://app.example.test` after `scripts/self_host_env.sh --public-origin
https://app.example.test`.

## Mode B — named tunnel (no public IP, no open port)

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `app` | `<TUNNEL_UUID>.cfargotunnel.com` | Proxied |

Created by `cloudflared tunnel route dns <TUNNEL_UUID> app.example.test`
(or the equivalent DNS write via MCP `mcp.cloudflare.com` / API token).
TLS terminates at Cloudflare. Origin is loopback Caddy
(`http://127.0.0.1:<MOMO_WEB_PORT>`, `Caddyfile.local`).

`--public-origin https://app.example.test` is mandatory before
`scripts/oort doctor --json`. Omitting it makes doctor print
`public.websocket` skip (doctor function `oort_doctor_check_public`,
「--public-origin 흔적 없음」). On a T3 front that skip is a **user error**,
not PASS.

## Nameserver delegation

If the domain is not already on Cloudflare, stop. The operator delegates
nameservers at the registrar (human approval). The agent does not operate
the registrar dashboard.

## Cleanup

Delete the tunnel and the DNS record. The operator confirms (human
approval).
