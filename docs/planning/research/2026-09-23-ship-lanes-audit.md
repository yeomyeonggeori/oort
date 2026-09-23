> **레포 사본(2026-09-23).** 목표 A W1 배포 레인(Railway·데스크탑·iOS)의 읽기 전용 감사 원본이다. Opus 5.5 서브에이전트가 작성했다. 레포에 올리면서 세션 로컬 경로와 미상 키의 식별자를 가렸다. 결정은 ADR-0187, 게이트는 `docs/cicd/03-store-readiness-gate.md`, 원격 작업은 ADR-0188이 정본이다. 이 문서는 근거 자료다.
>
> **2026-09-23 개정 M7이 대체하는 권고:**
> - 대상 절: B.4-1, B.5, C.4-1, C.6, D.1, D.4. 감사는 개정 전 M7을 전제로 썼다.
> - next 게시는 M7-I PASS와 건별 승인 뒤에만 한다.
> - 증거 빌드는 `--public` 무업로드와 스테이징 매니페스트로 한다.
> - ASC 자동 배포와 Xcode Cloud TestFlight 액션은 끈다.

# oort ship-lanes audit: Railway / Desktop (Tauri) / iOS (RN)

- Date: 2026-09-23. Audited checkout: root `main` @ `21f8c8a4` (clean before and after the audit).
- Mode: read-only. Nothing was deployed, uploaded, notarized, or pushed. No `pod install` was run. No tracked file was modified.
- Local probes: throwaway `docker run --rm` containers, most with `--network none`, using the **published v0.1.5 image** already in the Colima cache, plus an unsigned Tauri build from a `git archive HEAD` export. Every probe container and network was removed afterwards.
- Evidence files (build/probe logs) stayed in the auditor's session scratch and are not committed. Fixture secrets used in probes were random throwaway values.
- Tags: **[owner]** = needs an owner action (account, console, approval, decision). **[fix]** = code or config change in the repo or in the Railway settings. **[unknown]** = not verifiable from here.

---

## 0. Summary

| Lane | Can ship today? | Blocking items (short form) | Rough effort |
|---|---|---|---|
| **A. Railway** | **No.** The template has never booted on Railway, and at least 5 problems break it as written. | start commands (exec form) · Postgres must be PG18 + pgvector · the drive volume/UID failure (reproduced) · Centrifugo env names · `X-Forwarded-Proto` rewrite (`ws://` advertised) · catalog documents post-#2066 behavior but pins pre-#2066/#2498 v0.1.5 · Railway login | Config PR 0.5–1 day, plus a v0.1.6 image publish (~1–2 h). Owner first deploy 1–2 h, expect 1–2 iterations. |
| **B. Desktop** | **Yes, mechanically.** Every credential is present and works on this Mac. | owner decision on M7 scope for internal notarized builds · `npm ci` in `clients/web` first · actual republish (#1281) | Owner 1–2 h, plus 5–60 min notarization wait. No code needed. |
| **C. iOS TestFlight (internal)** | **Nearly.** Signing assets are complete. | Pods not installed (not run here) · [unknown] whether HEAD compiles: nothing has been archived since 2026-08-11, and expo-camera, device-link and pickers all landed after · likely ITMS-90683 (missing photo/microphone purpose strings) · build-number policy · choosing an upload path (Xcode Cloud state unknown) · relay must be `production` | Code 30–60 min. Owner 1–2 h to reach TestFlight, +~2 h for push end to end. |
| **C'. App Store / external TestFlight** | **No.** | M7 gate (the doc is stale and cannot PASS as written) plus #20/#21/#22/#30/#31 | Weeks |

The two findings with the widest effect, both new and both Railway-only:
1. **`railway.json` start commands cannot boot any app service.** Railway's start command *replaces the ENTRYPOINT in exec form*, so the container runs `api` and there is no binary named `api` (reproduced: exit 127).
2. **`Caddyfile.railway` rewrites `X-Forwarded-Proto: https` to `http`.** The api then advertises `ws://…` as the realtime URL and `http://…` as the device-link (QR) origin. `oort doctor public.websocket` still PASSes, so the check is falsely green.

---

## A. Railway team instance

### A.1 Current state
- Template: `infra/railway/{railway.json, README.md, Dockerfile.caddy, Caddyfile.railway}` (SH-5a #2205, pins fixed by #2499/PR #2500). This is a **custom service catalog, not Railway config-as-code**. Every setting has to be entered by hand in the UI or CLI.
- `scripts/tests/test_railway_template.sh` **PASSes** on HEAD (session scratch log). It covers key-set equality, the pin digest, `caddy adapt`, and the 403 order. It does **not** cover start-command semantics, Centrifugo env names, volumes, the PG version, or header forwarding.
- #2205 (SH-11a real deploy) is OPEN / `status:ready`, waiting for the owner's Railway login. The Railway CLI 4.27.4 is installed and returns `Unauthorized`.
- Pinned image: `ghcr.io/yeomyeonggeori/oort@sha256:5481c14e…` = v0.1.5 (2026-09-11), image revision `803ae7d5`. `main` has **14 server-rust commits** since then, including #2498 (the device refresh/revoke race fix, which is security relevant), #2066 (webhook master-key separation), #2029 (device list/revoke routes), and #2508/#2509 (AX invite actions). All were checked with `git merge-base --is-ancestor` and none is in the image (A.4-7).
- The Railway catalog has no push services (`push-relay`/`notifier`). No volumes are declared for any service.

### A.2 Services, volumes and env: what is needed vs what the template says

| Service | Source | Start command (Railway, exec form) | Volume | Notes |
|---|---|---|---|---|
| **postgres** | **`pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7…`** (the compose pin). Alternative: release `oort-postgres@sha256:c6a5bb84…` (PG 18.4). | (image default) | `/var/lib/postgresql` (PGDATA=`/var/lib/postgresql/18/docker`; the entrypoint runs as root, so a root-owned Railway volume is fine) | The template says "Postgres plugin". **That will fail**, see A.4-2. |
| **centrifugo** | `centrifugo/centrifugo:v6@sha256:8ba0c944…` (image CMD is `centrifugo`, no ENTRYPOINT) | leave empty, or `centrifugo` | none | Needs 4 native env names that are not in the catalog, see A.4-4. |
| **api** | oort image | `momo-rust-entrypoint api` (see the A.3 wrapper) | **`/var/lib/oort/drive`** (attachments) | `RAILWAY_RUN_UID=0` plus the wrapper, see A.3. Pre-deploy must be wrapped in `sh -c`. |
| **relay** | oort image | `momo-rust-entrypoint relay` | none | |
| **webhook-sender** | oort image | `momo-rust-entrypoint webhook-sender` | none | Needs `OUTBOUND_WEBHOOK_MASTER_KEY`, the same value as api. |
| **agent-worker** | oort image | `momo-rust-entrypoint agent-worker` | none | |
| **caddy** (public) | repo Dockerfile `infra/railway/Dockerfile.caddy`, build context = repo root (the repo is PUBLIC) | leave empty (the `caddy:2-alpine` CMD already runs caddy) | none | Set `PORT=8080` explicitly and point the domain at 8080. Needs the Caddyfile fix in A.4-5. |
| *(push)* **push-relay** | oort image | shell wrapper, see A.6 | none | Internal only. |
| *(push)* **notifier** | oort image | shell wrapper, see A.6 | none | |

Env (probed with fixture values; stdout only, no file):
`RAILWAY_PUBLIC_DOMAIN=… DATABASE_URL=… scripts/self_host_env.sh --platform railway [--claim]` prints **46 keys**: `CENTRIFUGO_ALLOWED_ORIGINS CENT_API_KEY CENT_HOST_PORT CENT_PROXY_SECRET CENT_TOKEN_HMAC COMPOSE_PROJECT_NAME DB_VOLUME_NAME DRIVE_VOLUME_NAME JWT_HMAC LOG_LEVEL MIGRATE_DATABASE_URL MIGRATE_IDEMPOTENCY_CHECK MOMO_AGENT_SEED_MODE MOMO_APP_DATABASE_URL MOMO_APP_POSTGRES_PASSWORD MOMO_CENTRIFUGO_WS_URL MOMO_CORS_ALLOWED_ORIGINS MOMO_DRIVE_ARCHIVE_BACKEND MOMO_DRIVE_ARCHIVE_LOCAL_BASE_URL MOMO_DRIVE_LOCAL_DIR MOMO_ENV MOMO_INITIAL_OWNER_EMAIL MOMO_INITIAL_OWNER_PASSWORD MOMO_LIVEKIT_NODE_IP MOMO_MIGRATE_ENV MOMO_PITR_BOOTSTRAP_EMPTY MOMO_PITR_EVIDENCE_REQUIRED MOMO_RUST_API_PORT MOMO_RUST_IMAGE MOMO_SELF_HOST_MODE MOMO_WEB_PORT NOTIFIER_DATABASE_URL NOTIFIER_POSTGRES_PASSWORD OORT_CSP_CONNECT_SRC OORT_SITE_ADDRESS OUTBOUND_WEBHOOK_MASTER_KEY PLATFORM_ADMIN_EMAILS POSTGRES_DB POSTGRES_PASSWORD POSTGRES_USER PROVIDER_LINK_MASTER_KEY RELAY_DATABASE_URL RELAY_POSTGRES_PASSWORD WEBHOOK_INGRESS_MASTER_KEY WORKER_POSTGRES_PASSWORD MOMO_SELF_HOST_PLATFORM`. On stderr it names 3 hand keys: `CENT_API_URL, WORKER_DATABASE_URL, CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS`.

The real hand-mapped set is **at least 9 keys, not 3**, because compose did these renames and Railway does not:

| Service | Variable to set | Value |
|---|---|---|
| api | `DATABASE_URL` | `${{shared.MOMO_APP_DATABASE_URL}}` (momo_app, NOBYPASSRLS) |
| api | `PORT` / `HOST` | `8080` / `0.0.0.0` (on a *legacy* IPv6-only env use `[::]` with the brackets; plain `::` fails the `format!("{host}:{port}")` parse) |
| api, relay | `CENT_API_URL` | `http://centrifugo.railway.internal:8000/api` |
| agent-worker | `WORKER_DATABASE_URL` | `postgres://momo_worker:${{shared.WORKER_POSTGRES_PASSWORD}}@postgres.railway.internal:5432/<db>` |
| centrifugo | `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` | `${{shared.CENT_TOKEN_HMAC}}` |
| centrifugo | `CENTRIFUGO_HTTP_API_KEY` | `${{shared.CENT_API_KEY}}` |
| centrifugo | `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS` | `${{shared.CENTRIFUGO_ALLOWED_ORIGINS}}` (space-separated; includes the tauri origins and the public https/wss) |
| centrifugo | `CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS` | `{"X-Centrifugo-Proxy-Secret":"${{shared.CENT_PROXY_SECRET}}"}` |
| caddy | `PORT` | `8080`. The generator emits `OORT_CSP_CONNECT_SRC` wrapped in double quotes (dotenv style). Check that Railway's raw editor strips them [unknown]; if it does not, paste the value unquoted, or the CSP header will carry literal quotes. |

### A.3 What failed ("drive permission" boot failure), cause, fix
- Recorded in the planning notes: `docs/planning/handoffs/2026-09-12-shared-agent-pipeline-brief.md` ("Railway volume/UID default causes drive dir permission boot failure") and the Codex probe `a Codex probe note (local, not committed)`.
- **Reproduced today** with the v0.1.5 image (uid `10001(momo)`, gid 999, Debian 12; `/var/lib/oort` does not exist in the image). The generator sets `MOMO_DRIVE_ARCHIVE_BACKEND=local` and `MOMO_DRIVE_LOCAL_DIR=/var/lib/oort/drive`:
  - (a) default uid, no volume, gives `Error: InvalidSecurity("MOMO_DRIVE_LOCAL_DIR could not be created or is not writable")` and exits.
  - (b) default uid with a fresh root-owned volume at that path (what a Railway volume looks like) gives **the same error**.
  - (c) `--user 0` (= `RAILWAY_RUN_UID=0`) with a volume passes the drive check and reaches the DB connect.
  - (d) `--user 0`, a volume, and the wrapper below pass the drive check, and **api runs as uid 10001**.
  - relay, webhook-sender, agent-worker and notifier with the full shared env pass config and reach the DB connect. **Only api needs the fix.**
- Cause: compose has a root one-shot, `drive-init` (`infra/rust/local.override.yml`), that runs `mkdir` + `chown 10001` on the named volume. Railway has no equivalent. Its volumes mount as root, and Railway's docs say: "Docker images that run as a non-root UID by default will have permissions issues … set `RAILWAY_RUN_UID=0`". Pre-deploy cannot fix it either: "volumes are not mounted" in pre-deploy.
- **Fix [fix], config only, verified locally.** On the api service: add a volume mounted at `/var/lib/oort/drive`, set `RAILWAY_RUN_UID=0`, and use this start command:
  ```
  /bin/sh -c 'mkdir -p "$MOMO_DRIVE_LOCAL_DIR" && chown 10001:999 "$MOMO_DRIVE_LOCAL_DIR" && exec setpriv --reuid=10001 --regid=999 --init-groups env HOME=/home/momo momo-rust-entrypoint api'
  ```
  The simpler Railway-documented option is `RAILWAY_RUN_UID=0` with `momo-rust-entrypoint api`, but then api runs as root. Without the volume, attachments are lost on every redeploy. The long-term fix is the same init-and-drop-privileges step in the image entrypoint, which needs its own issue.

### A.4 Other blockers found (none of these were known before)
1. **Start commands [fix], certain.** Railway docs, verbatim: "Dockerfile / Image: the start command overrides the image's `ENTRYPOINT` in exec form." The image has `ENTRYPOINT ["momo-rust-entrypoint"]` and `CMD ["migrate"]`, and there is no `api` binary. Local reproduction: `docker run --entrypoint api <v0.1.5>` gives `exec: "api": executable file not found in $PATH`, exit 127 (session scratch log). All four app services must use `momo-rust-entrypoint <role>`.
2. **Postgres must be PG18 with pgvector [fix] + [unknown default version].** `001_init.sql` "Targets PG18 (native uuidv7())", and `uuidv7()` is used from 001 onward. `028_memory_search.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`. Railway's docs say of the default Postgres templates: "we do not plan to add extensions". So migrations in pre-deploy fail and api never deploys. Use the pinned `pgvector/pgvector:…-pg18` image with a volume (A.2), or the marketplace "pgvector-pg18" template. Railway's DB templates provide `DATABASE_URL`; an image service does not, so compose `postgres://<user>:<pw>@postgres.railway.internal:5432/<db>` for the generator.
3. **Pre-deploy command form [unknown] → wrap it [fix].** The catalog's `preDeployCommand` uses `VAR=… cmd && …` and `$MIGRATE_DATABASE_URL`, which only work inside a shell. Railway's docs do not say how pre-deploy is executed. Use:
   `/bin/sh -c 'DATABASE_URL="$MIGRATE_DATABASE_URL" MOMO_RUNTIME_ROLE_PROVISION=1 /usr/local/bin/momo-migrate && DATABASE_URL="$MIGRATE_DATABASE_URL" MOMO_BOOTSTRAP_RUNTIME_ROLES=0 MOMO_ENV="${MOMO_MIGRATE_ENV:-development}" /usr/local/bin/momo-migrate'`
   Pre-deploy does have private networking and variables, per the Railway docs.
4. **Centrifugo env names [fix] (docs + catalog).** The README says the secrets "come from the generator, same names as compose". In practice the generator emits compose *variable* names (`CENT_TOKEN_HMAC`, `CENT_API_KEY`, `CENTRIFUGO_ALLOWED_ORIGINS`), and Centrifugo reads only its own names. Probe with exactly the `railway.json` centrifugo env: Centrifugo boots silently. A relay-style publish then gets **HTTP 401** ("API key is empty"), and a WS upgrade with `Origin: tauri://localhost` gets **HTTP 403** ("request Origin is not authorized due to empty allowed_origins"). Browsers always send `Origin`, so web, desktop and phone realtime all fail. Map the 4 keys in A.2.
5. **`X-Forwarded-Proto` is dropped [fix], Railway only.** Railway terminates TLS and Caddy receives plain HTTP. Caddy has no `trusted_proxies`, so it overwrites the incoming XFP. Probe: the Railway Caddy with an echo upstream at `api.railway.internal`, request sent with `X-Forwarded-Proto: https`, shows the upstream seeing **`xfp=http`**. Consequences traced in code:
   - `realtime_advert.rs::websocket_scheme` takes the first XFP hop, so `realtimeWebSocketUrl = ws://<domain>/connection/websocket`. Clients use *only* this URL (`packages/momo-core/src/lib/realtimeEvents.ts:12`, ADR-0110). `ws://<domain>` goes to port 80, which Railway's edge serves only as an https redirect (expected, not probed), so the WS upgrade fails for **every** client. On top of that, the browser blocks ws:// from an https page as mixed content. Whether ATS also governs RN's WebSocket is [unknown] and does not matter here.
   - `device_link.rs::request_public_origin` and `approvals.rs` use `derive_same_origin_http_base`, so the **QR device-link origin becomes `http://…`**. The phone then talks plain http to a public host, which ATS (`NSAllowsArbitraryLoads=false`) blocks for URLSession traffic.
   - Fix: add `header_up X-Forwarded-Proto https` to the three `reverse_proxy api…` blocks in `Caddyfile.railway`. This is deterministic because Railway always terminates TLS. The alternative is `servers { trusted_proxies static … }`, but Railway's edge IP ranges are [unknown]. Extend `test_railway_template.sh` to check it.
   - Do not work around it with an absolute `MOMO_CENTRIFUGO_WS_URL=wss://…`. That only fixes realtime, and it turns off the device-link SAS requirement, because `is_public_origin_mode()` is true only for `same-origin`.
6. **Doctor is falsely green [fix]** (the "guard that cannot fail" pattern). `oort_doctor.sh` `public.websocket` builds `wss://` from the configured origin and sends **no Origin header**. It passes while the app is broken by (4) and (5). Railway's own caddy healthcheck (`Host: healthcheck.railway.app`) matches no site, and Caddy answers an **empty 200** (probed), so it proves nothing either. Until this is fixed, verify by hand: the login response's `realtimeWebSocketUrl` must start with `wss://`, a WS upgrade with `Origin: https://<domain>` must return 101, and a two-tab browser message must arrive in real time.
7. **The catalog does not match the pinned image. [fix] recommended: publish v0.1.6 before the first Railway deploy.** `railway.json` notes and the README describe post-#2066 behavior ("#2066 deleted the binary's JWT_HMAC fallback"; the sender *must* get `OUTBOUND_WEBHOOK_MASTER_KEY`). They pin v0.1.5, which predates #2066. Verified: `git merge-base --is-ancestor` gives `096f3362`/`d075ca28` (#2066), `16fcf007`/`67bf223e` (#2498 device refresh/revoke race, security) and `1246b409` (#2029 device routes) **all not in the image**. The v0.1.5 webhook-sender still boots without `OUTBOUND_WEBHOOK_MASTER_KEY`. The `momo_notifier` role (#2193) *is* in the image (`/opt/momo/sql/bootstrap_runtime_roles.sql`), so push is not blocked by the version. Path: `gh workflow run publish-images.yml --ref main` [owner approves the `release` environment], then bump `releases/latest.json`, `railway.json` and the `Dockerfile.caddy` ARG in one PR (`test_railway_template.sh` enforces this). If v0.1.5 is used anyway, export `JWT_HMAC` before generating (the D2(a) transition copy) so webhook/doorbell secrets survive the later upgrade.
8. **Railway account [owner].** `railway login` (browser), create the project, choose a plan with volumes, attach the caddy domain (custom or `*.up.railway.app`), and hold the secrets in shared or sealed variables.
9. Minor. The generator's `OORT_CSP_CONNECT_SRC` includes `ws://127.0.0.1:7880` (LiveKit default) even though LiveKit is excluded; harmless. `CENTRIFUGO_PORT` is not a v6 key, but the default port is 8000 anyway. New Railway environments (created after 2025-10-16) have IPv4 plus IPv6 private networking, so the `0.0.0.0` binds are fine.

### A.5 Steps to ship (after the config PR, or entered by hand)
```sh
# 0 [owner, optional] publish v0.1.6 and bump the pins (A.4-7)
# 1 [owner]
railway login && railway init            # project "oort-team"
# 2  postgres service: pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7… + volume /var/lib/postgresql
#    POSTGRES_USER=postgres POSTGRES_PASSWORD=<random> POSTGRES_DB=oort (private only)
# 3  env (local, never committed; zero-base onboarding → --claim)
export RAILWAY_PUBLIC_DOMAIN='<caddy domain>'
export DATABASE_URL='postgres://postgres:<pw>@postgres.railway.internal:5432/oort'
umask 077; scripts/self_host_env.sh --platform railway --claim > ~/.momo-secrets/railway-oort.env
#    → Railway shared variables (Raw Editor), then the per-service mappings in A.2
# 4  services per A.2/A.3/A.4 (start commands, api pre-deploy sh -c, api volume + RAILWAY_RUN_UID=0)
# 5  deploy order: postgres → centrifugo → api (pre-deploy migrates) → relay / webhook-sender / agent-worker → caddy
# 6  verify
curl -fsS https://$RAILWAY_PUBLIC_DOMAIN/healthz
scripts/oort doctor --env ~/.momo-secrets/railway-oort.env --json      # necessary, NOT sufficient (A.4-6)
#    + manual: login JSON realtimeWebSocketUrl starts wss:// ; WS 101 with Origin header ; 2-tab realtime ; attachment survives a redeploy
```

### A.6 Push relay in the same Railway project: feasible
- Code inventory: `momo-push-relay` reads the key **only from a file** (`MOMO_APNS_KEY_PATH`). The notifier reads its Ed25519 identity from `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`. Railway has no file secrets or bind mounts.
- **Verified locally:** the push-relay boots in **live** mode as uid 10001, with the key materialized from an env var through a start-command wrapper. The test used a throwaway P-256 key and never contacted Apple. Log: `starting PushRelay host=0.0.0.0 port=28195 registered_servers=1 … sender_mode="live"`, and `/health` returned `{"ok":true,"service":"PushRelay"}`.
- push-relay service (no public domain):
  ```
  start: /bin/sh -c 'umask 077; printf %s "$APNS_KEY_P8_B64" | base64 -d > /tmp/apns.p8 && export MOMO_APNS_KEY_PATH=/tmp/apns.p8 && exec momo-rust-entrypoint push-relay'
  vars:  APNS_KEY_P8_B64=<sealed: base64 of AuthKey_4SSR3XS7WZ.p8>  MOMO_APNS_KEY_ID=4SSR3XS7WZ  MOMO_APNS_TEAM_ID=YWQQFQM38J
         MOMO_APNS_SENDER=live  MOMO_APNS_ENV=production  MOMO_PUSH_RELAY_HOST=0.0.0.0  MOMO_PUSH_RELAY_PORT=28195
         MOMO_RELAY_SERVERS={"oort-team":"<raw Ed25519 pubkey b64 from scripts/push_relay_keygen.sh>"}
  ```
- notifier service: the same wrapper pattern with `RELAY_SIGNING_KEY_B64`, then `export MOMO_PUSH_RELAY_PRIVATE_KEY_PATH=/tmp/relay-signing-key.pem && exec momo-rust-entrypoint notifier`. Variables: `NOTIFIER_DATABASE_URL` (from the generator; the `momo_notifier` role is present in the v0.1.5 image's `bootstrap_runtime_roles.sql`, checked directly), `MOMO_ENV`, `MOMO_PUSH_NOTIFIER_ENABLED=1`, `PUSH_RELAY_URL=http://push-relay.railway.internal:28195/v1/push`, `PUSH_RELAY_SERVER_ID=oort-team`. The notifier was not booted against a DB here, so it is runtime-unverified.
- Key custody: `AuthKey_4SSR3XS7WZ.p8` is the APNs key. It is byte-identical (hash compared) to `~/.momo-secrets/momo-apns.p8` and is recorded in `docs/planning/archive/JOURNAL-2026-07.md:787`. Holding it as a sealed Railway env var **departs from the runbook** ("`.p8` is a file on the host, never in env") and needs **[owner] acceptance** or an ADR-0120 note. The only alternative is a code change for an inline-key env var.
- **APNs environment:** TestFlight and App Store builds are Release (`APS_ENVIRONMENT = production`, pbxproj:448, and the store profile has `aps-environment=production`), so the relay must use **`MOMO_APNS_ENV=production`**. The local, gitignored note `claudedocs/resume-2026-09-07/checklist-apns-real-device.md` §3 says "TestFlight … sandbox". **That is wrong.** Only builds installed from Xcode or by cable (Debug) use sandbox. If both are needed, run a second relay instance with `sandbox`; the relay refuses dispatches whose env does not match.
- [unknown] Since 2025, Apple lets an APNs key be restricted to one environment. Check in the Developer portal that key `4SSR3XS7WZ` allows **Production**. The only earlier proof was a July smoke test.
- There is no Dawn-operated relay today; the old NCP Swift relay is retired. The team relay is therefore the relay for this instance.

### A.7 Effort
- Config PR: 0.5–1 day. Scope: `railway.json` start commands and pre-deploy, `Caddyfile.railway` XFP, README hand-key table and Centrifugo names, the Postgres choice, the api volume and UID, the push-relay and notifier entries, and test updates.
- Owner first deploy: 1–2 h, likely 1–2 iterations.
- Push relay wiring: about 1 h, plus a device test (see C).

---

## B. Desktop (Tauri 2, `clients/desktop`)

### B.1 Current state
- `tauri.conf.json`: `identifier app.momo.desktop`, baseline `version 0.1.0-next.1` (the real version is injected with `--config`), bundle `app, dmg`, macOS minimum 14.0. The updater endpoint is `https://yeomyeonggeori.github.io/momo-alpha/update-next.json`. The **`pubkey` matches `~/.momo-secrets/momo-updater.key.pub`** (compared byte for byte).
- The live manifest is **`0.1.0-next.10`**, `pub_date 2026-07-26T15:24:36Z`, `darwin-aarch64` only. Its tarball URL is on the old org (`Dawn-kim-official`), and it still resolves: 301, then 302, then 200. #1281 is OPEN; the fix is a republish of `next.11`.
- The distribution repo `yeomyeonggeori/momo-alpha` is **PUBLIC**, with Pages built from `main`. `gh` is logged in with admin/push on it. **Anything published to the next channel can be downloaded by anyone.**
- **`cargo tauri build` works.** An unsigned `--bundles app --ci` build from a clean `git archive HEAD` export plus `npm ci` in `clients/web` succeeded in **93 s** (Rust 1m20s). Output: `oort.app`, **arm64 thin**, ad-hoc signature, `CFBundleShortVersionString 0.1.0-next.1` (session scratch log). Intel Macs are not served.
- **The root checkout's `clients/web/node_modules` is stale** (installed 2026-08-28). `tsc -b` fails with `TS2307 'motion/react'` and `'@testing-library/react'`. Running the publish script from the root checkout today would fail at step 1/6.

### B.2 How the signed and notarized DMG and the updater manifest are produced
`scripts/publish_next_build.sh` (canonical; `docs/NEXT_CHANNEL.md` §8, `docs/RELEASING.md` §데스크탑 dmg):
1. `cargo tauri build --bundles app,dmg --ci --config {"version":…}` with `APPLE_SIGNING_IDENTITY="Developer ID Application: Kwak Seongjae (YWQQFQM38J)"` and `MOMO_CHANNEL_BUILD=1`. Without that flag the app never checks for updates (`build.rs`, #1281).
2. `codesign --verify --strict` on the `.app` and `.dmg`. If the bundler did not sign the dmg, the script signs it.
3. `xcrun notarytool submit --keychain-profile momo-notary --wait --timeout 120m` (a zip of the .app), then `stapler staple`.
4. Re-tar the stapled `.app` into `momo-next-<v>-darwin-aarch64.app.tar.gz` (`COPYFILE_DISABLE=1`), then a round-trip `codesign --verify` and `stapler validate`, then `cargo tauri signer sign -f ~/.momo-secrets/momo-updater.key`.
5. `gh release create next-v<v> --repo yeomyeonggeori/momo-alpha` with the tar.gz and a first-install zip.
6. Clone the Pages repo, update `update-next.json` (per-arch merge), commit and push.

`--public --version 0.1.0` instead produces a notarized, stapled `oort-macos-aarch64.dmg` for the oort `v0.x` Release. It does not upload it; a person runs `gh release upload`.

CI alternative: `.github/workflows/release-desktop.yml` (dispatch only; self-hosted macOS runner; defaults `MOMO_NOTARY_PROFILE=momo-notary`, `MOMO_DIST_REPO=yeomyeonggeori/momo-alpha`). **No runner is installed** (`~/actions-runner` is absent and the repo has 0 runners), and the repo and `release` environment have **0 secrets**. Run the script by hand.

### B.3 Credentials verified on this Mac
| Asset | Status |
|---|---|
| `Developer ID Application: Kwak Seongjae (YWQQFQM38J)` | valid. Issued under the **G1** "Developer ID Certification Authority", so notAfter is **2027-02-01**. **[owner] renew under G2 before then.** Stapled builds remain valid after expiry. |
| notarytool profile `momo-notary` | `xcrun notarytool history --keychain-profile momo-notary` exits 0. 72 past submissions (71 Accepted); most recent 2026-09-17. |
| minisign updater key `~/.momo-secrets/momo-updater.key` | present. **Since 2026-09-23 the key is password-protected** (same key pair; password in the login keychain item `momo-updater-key`, every read prompts). Export `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the keychain before publishing (`docs/NEXT_CHANNEL.md` §8.1). |
| `gh` authentication to `momo-alpha` | admin/push |
| `cargo-tauri` | 2.11.2 (rustc 1.95.0, Xcode 26.5) |

### B.4 Blockers
1. **M7 gate scope [owner] decision.** `docs/cicd/03-store-readiness-gate.md` covers "스토어·공증·external TestFlight 공개 배포" (store, notarized, and external TestFlight public distribution). Its checklist is still Swift-era, and the doc says not to treat it as PASS until it is rewritten for Tauri/RN, **so it cannot PASS today.** `RELEASING.md` explicitly requires an M7 PASS plus owner approval to notarize the **public** `--public` dmg. The internal next channel has precedent (next.1–10 were notarized in July), and NEXT_CHANNEL §8 plans next.11 with no M7 precondition. `AGENTS.md`, however, lists "공증 배포" (notarized distribution) under M7, and the next channel's repo is public. The owner must confirm that internal next-channel republishes are within standing authorization. **This audit does not decide it.**
2. **Stale web deps [fix, env]:** run `npm --prefix clients/web ci` before publishing, or add it to the script.
3. **#1607 [owner/verify]:** PR #1614 wired the CORS default (`MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost`), and the Railway generator emits it. What remains is a real login from the release bundle plus a realtime round trip. On Railway that also depends on A.4-4 (Centrifugo allowed origins) and A.4-5 (`wss://` advertisement).
4. Architecture: arm64 only. Any Intel teammate needs an x86_64 or universal build [fix, if needed].

### B.5 Steps to ship to the team
```sh
cd ~/projects/momo && git switch main && git pull     # or the track the owner designates (NEXT_CHANNEL §8.1)
npm --prefix clients/web ci
# §8.1 prerequisites (all were OK on this Mac today)
scripts/publish_next_build.sh --version 0.1.0-next.11 --dry-run --notes "…"   # sign only
scripts/publish_next_build.sh --version 0.1.0-next.11 --notes "…"             # [owner] notarize + publish (after the M7 scope decision)
curl -sS https://yeomyeonggeori.github.io/momo-alpha/update-next.json | python3 -m json.tool   # version next.11, new org URL
```
Teammates install the zip from the release once. After that the in-app updater takes over. They log in by entering the Railway `https://` domain as the server.

### B.6 Effort
No code required. Owner: 1–2 h of hands-on time plus 5–60 min waiting on notarization. Optional: 15 min to add `npm ci` to the script.

---

## C. iOS (React Native 0.86.2, `app.momo.ios` + `app.momo.ios.NotificationService`)

### C.1 Current state
- `clients/mobile/node_modules` is present and current (2026-09-04; expo-camera 57.0.4, expo-notifications 57.0.8, react-native 0.86.2).
- **`ios/Pods` is absent** (no `Pods/Manifest.lock`). **The simulator build was not run**, per the instruction. The team's path is `npm --prefix clients/mobile run build:sim`; `scripts/build-sim.sh:78` runs `pod install` automatically and writes `ios/Pods` into the checkout.
  - The system `pod` 1.17.0 matches `Podfile.lock` (`COCOAPODS: 1.17.0`).
  - `bundle exec pod install` resolves to 1.15.2 through the Gemfile pin `xcodeproj < 1.26` and rewrites the lock. This is the known trap documented in the deleted runbook §8-6.
  - Ruby is 4.0.7; whether the gem set is compatible with it is [unknown].
- Toolchain: Xcode 26.5 (17F42), macOS 26.5, node 24.14 (≥ `.node-version` 22.11.0); an iPhone 17 Pro simulator is available.
- Entitlements are correct:
  - The app has `aps-environment=$(APS_ENVIRONMENT)` (Debug `development`, Release `production`), App Group `group.app.momo.ios`, and keychain group `$(AppIdentifierPrefix)app.momo.ios.shared`.
  - The NSE has no aps-environment and the same group and keychain group.
  - `ci_post_xcodebuild.sh` asserts all of this on a profile-signed archive. It can be run locally with `CI_ARCHIVE_PATH=<xcarchive> bash clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh`.
- `PUSH_TOPIC='app.momo.ios'` (`src/push/contract.ts`). `MomoAPNSEnvironment` maps to sandbox/production at registration. `PrivacyInfo.xcprivacy` has the required-reason APIs (FileTimestamp, UserDefaults, DiskSpace, SystemBootTime) and tracking false.
- Runbooks: `docs/cicd/10-ios-signing-identity-runbook.md` and `docs/IOS_TESTFLIGHT_RUNBOOK.md` were **deleted** in `ab0f0ca6` (#2182). They are readable with `git show ab0f0ca6^:<path>`; §8 (Xcode Cloud) is still accurate, the rest is Swift-era. **No RN TestFlight runbook exists**; `2026-09-08-remaining-work-map.md` lists it as to-do.
- #1115 is still OPEN even though its repository work landed (`2ba26f0b`/#1122) and the console retarget was done on 2026-08-09. Close it or relabel it.

### C.2 Signing assets on this Mac (no certificates printed)
- Identities:
  - Apple Distribution: **1 valid** (issued 2026-06-29 14:31 UTC, expires 2027-06-29; it appears twice, same certificate) and **1 revoked** (14:22 UTC, `CSSMERR_TP_CERT_REVOKED`).
  - Developer ID Application: expires 2027-02-01.
- **[owner]** delete the revoked Distribution identity from the login keychain. It makes signing *by name* ambiguous.
- Profiles (`~/Library/Developer/Xcode/UserData/Provisioning Profiles`):
  | Name | App ID | Expires | aps | Notes |
  |---|---|---|---|---|
  | iOS Team Store Provisioning Profile: app.momo.ios | YWQQFQM38J.app.momo.ios | 2027-07-09 | production | group.app.momo.ios, keychain `YWQQFQM38J.*`. **Embeds the valid Distribution cert.** |
  | iOS Team Store Provisioning Profile: app.momo.ios.NotificationService | …NotificationService | 2027-07-09 | — | same group and keychain; valid cert embedded |
  | iOS Team Provisioning Profile: app.momo.ios | dev | 2027-07-17 | development | 2 devices |
  | iOS Team Provisioning Profile: …NotificationService | dev | 2027-07-17 | — | 2 devices |
  | iOS Team Provisioning Profile: * | wildcard dev | 2027-08-02 | — | |
- Xcode: `IDEProvisioningTeamByIdentifier` holds team `YWQQFQM38J` (Individual, paid), so an account is configured. Whether the session token is still valid is [unknown]; check Xcode › Settings › Accounts.
- `a local key folder`:
  - `AuthKey_4SSR3XS7WZ.p8` is the **APNs key** (see A.6).
  - `the second .p8 key` (2026-07-13) is **not referenced anywhere** in the repo, git history, `~/.codex`, or `~/.claude`, so its type is **[unknown]**. It could be an App Store Connect API key, but **no Issuer ID is recorded anywhere** and the repo has 0 GitHub secrets. The owner can check ASC › Users and Access › Integrations; a key listed there is ASC API, otherwise it is an APNs or other key. An Individual key cannot run provisioning.
  - Both files are **mode 644** in a local folder. **[owner]** `chmod 400` them and move them to `~/.momo-secrets/`.

### C.3 Xcode Cloud (the existing lane)
- ASC app record "momo" `6792002019`. Workflow "Default", retargeted 2026-08-09 to `clients/mobile/ios/MomoMobile.xcworkspace` with scheme `MomoMobile`.
- Archive plus 3 exports went green after #1219 and #1221 (builds 2035/2039). The last Xcode Cloud check-run success was on **2026-08-11** (PR #1294).
- **There are no Xcode Cloud checks** on the mobile PRs #1683, #1702 and #1715 (2026-08-23) or #2009 (2026-09-03). The workflow is disabled, or the C-1 path filter from #1561 is mis-set. **[unknown]; owner to check ASC.** Everything that has landed since (expo-camera, expo-device, pickers) has never been archived in the cloud.
- A TestFlight post-action was never configured, and there is no evidence that **any** build (Swift or RN) was ever uploaded to ASC.

### C.4 How a TestFlight upload can be done from here (pick one)
1. **Xcode Cloud (recommended).** No local credentials; Apple-managed signing (already proven for both targets); Xcode Cloud sets `CFBundleVersion` itself. [owner] ASC › Xcode Cloud › Manage Workflows › Default › Edit: set an Archive action with deployment "TestFlight (Internal Testing Only)", add the post-action "TestFlight Internal Testing" with a group, fix the start conditions, then Start Build on `main`.
2. **Xcode Organizer (local GUI).** Uses the Xcode account session: `pod install`, open the workspace, set Any iOS Device, Product › Archive, Distribute App › App Store Connect › Upload. "Manage version and build number" can auto-increment the build.
3. **CLI (local).**
   ```sh
   cd clients/mobile && npm ci && (cd ios && pod install)
   xcodebuild -workspace ios/MomoMobile.xcworkspace -scheme MomoMobile -configuration Release \
     -destination 'generic/platform=iOS' -archivePath "$SCRATCH/MomoMobile.xcarchive" \
     -allowProvisioningUpdates CURRENT_PROJECT_VERSION=<N> archive
   CI_ARCHIVE_PATH="$SCRATCH/MomoMobile.xcarchive" bash ios/ci_scripts/ci_post_xcodebuild.sh   # local entitlement/NSE check
   xcodebuild -exportArchive -archivePath "$SCRATCH/MomoMobile.xcarchive" -exportPath "$SCRATCH/export" \
     -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
     # ExportOptions: method=app-store-connect, destination=upload, teamID=YWQQFQM38J, signingStyle=automatic
     # auth: the Xcode account session, OR -authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID
     #       (needs an ASC Team API key + Issuer ID — not available today, see C.2)
   ```

### C.5 Blockers for internal TestFlight
1. **Pods not installed [owner/env].** Run `(cd clients/mobile/ios && pod install)`, then discard any lock drift. Xcode Cloud does this itself in `ci_post_clone.sh`.
2. **Likely ITMS-90683 rejection at upload [fix], unverified until the first upload.**
   - Info.plist has only `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription`.
   - `expo-image-picker` (`launchImageLibraryAsync` in `src/features/attachments/picker.ts`) links PHPhotoLibrary APIs, so **`NSPhotoLibraryUsageDescription`** is required.
   - `expo-camera` links microphone APIs, so **`NSMicrophoneUsageDescription`** is probably required.
   - ADR-0168 anticipated this ("필요 시 NSPhotoLibraryUsageDescription"). Xcode Cloud archives do not run App Store Connect validation, so their green status does not cover it.
   - About 15 min of Info.plist work. The copy follows the ux-bible, so it needs a light review.
3. **Build numbers [fix].** `CURRENT_PROJECT_VERSION = 1` and `MARKETING_VERSION = 1.0` are the same for both targets. Choose one upload path. If both Xcode Cloud (which numbers in the 2000s) and local uploads are used, local builds must use a higher number, or the upload is rejected with ITMS-90062.
4. **Export compliance [fix, optional].** `ITSAppUsesNonExemptEncryption` is absent, so every build asks the compliance question in ASC before testers can install. Add `false` if accurate (the app uses only HTTPS/TLS).
5. **Relay environment and phone connection [fix/owner].** The relay must be `MOMO_APNS_ENV=production` (A.6). On Railway, the QR device link is broken until A.4-5 is fixed; the workaround is typing the `https://` server URL by hand in ConnectScreen.
6. **Xcode account session and the second key's type [unknown/owner]**, as noted in C.2.

### C.6 App Store / external TestFlight
Blocked by M7, whose doc must be rewritten to RN and Tauri criteria and then PASSed. Also blocked by the remaining-work-map items: #20 in-app account deletion (5.1.1(v)), #21 privacy manifest and encryption declaration, #22 UGC moderation (report, block, filter, contact) plus EULA, #30 store metadata and screenshots, and #31 upload and review. Also needed: the RN TestFlight runbook, and a real-device APNs receipt proven end to end (checklist §4-1: a fake token gets `400 BadDeviceToken` first, then a real device).

### C.7 Effort
- Code: 30–60 min (purpose strings, encryption key, build-number approach).
- Owner: 15–30 min to configure Xcode Cloud, or 1–2 h for a local archive and upload.
- TestFlight processing: 10–30 min.
- Push end to end: +2 h once the A.6 services are running.
- App Store: weeks.

---

## D. Owner action checklist (in dependency order)
1. Decide whether internal next-channel notarization falls under M7 (B.4-1). Approve publishing v0.1.6 from `main` before the Railway deploy (recommended; A.4-7).
2. Railway: `railway login`, create the project, choose the plan, set up the domain. Approve holding the APNs `.p8` as a sealed env var (A.6).
3. Land the Railway config PR (A.4-1…6 plus the push services), then deploy and verify with the manual checks in A.5.
4. Desktop: `npm --prefix clients/web ci`, then `publish_next_build.sh --version 0.1.0-next.11`.
5. iOS: add the purpose strings and choose the upload path (Xcode Cloud or local), upload, add the internal group. Check that the second .p8 key / the Issuer ID exist if you want the CLI path.
6. APNs key `4SSR3XS7WZ`: confirm the environment scope includes Production. Delete the revoked Distribution identity. Move the `a local key folder/*.p8` files into `~/.momo-secrets` with mode 0400. Plan the Developer ID G2 renewal before 2027-02-01.
7. Housekeeping: close or relabel #1115. Correct the sandbox/production line in the `claudedocs` APNs checklist. Record that `doctor public.websocket` is falsely green (A.4-6).

## E. Sources
- Railway docs: [start command](https://docs.railway.com/guides/start-command) ("overrides the image's ENTRYPOINT in exec form") · [pre-deploy](https://docs.railway.com/guides/pre-deploy-command) (private network yes, volumes not mounted) · [volumes](https://docs.railway.com/reference/volumes) (`RAILWAY_RUN_UID=0`) · [private networking](https://docs.railway.com/networking/private-networking/how-it-works) (IPv4 + IPv6 for environments created after 2025-10-16) · [PostgreSQL](https://docs.railway.com/databases/postgresql) (no extensions in the default templates).
- ITMS-90683 purpose strings: [Apple forum thread 744965](https://developer.apple.com/forums/thread/744965), [Expo forum](https://forums.expo.dev/t/itms-90683-missing-purpose-string-in-info-plist/62763).
