# momo web-spike — MOMO-595 P0 (ADR-0133)

Tauri 2 + React 18 canonical-UI stack probe. **Spike quality, not production.**
Proves the ADR-0133 stack against live momowebqa: login → channel list → timeline
→ realtime receive, with hard performance gates measured on real data.

## Why `clients/web-spike` and not `clients/web`

The plan (`docs/planning/2026-07-24-tauri-migration-plan.md` §1) names `clients/web`
as the canonical UI. **That path is already occupied** by the committed ADR-0119
alpha web client, which is load-bearing infra (`infra/prod/Dockerfile.web`, the
Caddyfile static-serve, `infra/docker-compose.e2e.yml`, `scripts/local_gate.sh`).
Clobbering it inside a non-mergeable spike would be destructive, so the spike lives
alongside at `clients/web-spike` with the **exact §1 internal structure**. Promoting
this to `clients/web` (replacing the v0) is a merge-time decision for 성재.

## Structure (matches plan §1)

```
src/app/          # App shell, router seam, TanStack Query client, runtime badge
src/features/     # auth, channels, timeline (react-virtuoso + seq model), chat
src/design/       # tokens.css (여명 placeholder palette) + shadcn/ui primitives
src/lib/          # api (REST, contract-faithful), realtime (Centrifugo), env
gates/            # measurement runners (seq / resume / scroll+coldstart / inject)
```

Stack: TS + React 18 + Vite 6 + Tailwind v4 + shadcn/ui (vendored) + react-virtuoso
+ TanStack Query + centrifuge-js. Same bundle runs in the browser and inside the
Tauri shell (`clients/desktop`) — that is the "one codebase" proof.

## Run

```sh
cp .env.local.example .env.local     # optional dev prefill; NEVER commit creds
npm install
npm run dev                          # http://localhost:5173 (proxies /v1 → momowebqa)
```

- Same-origin REST by design: the dev/preview server proxies `/v1` to momowebqa
  (`MOMO_PROXY_TARGET`, default `http://127.0.0.1:28000`) so there is no CORS
  (the momowebqa REST server emits none — matches ADR-0119 D1-A / prod Caddy).
- Serve on **5173** — the origin Centrifugo whitelists for local dev
  (`infra/centrifugo.json`), so the realtime WS handshake is accepted.
- Credentials come from the login form (or `VITE_MOMO_DEV_*` in `.env.local`),
  never from source.

## Gates (measured on live momowebqa, 2026-07-25 — honest numbers)

Set creds in the env, run the preview on 5173, then the runners:

```sh
export MOMO_EMAIL=... MOMO_PASSWORD=...
node gates/inject.mjs 120           # seed the spike-745-gate channel (never #general)
node gates/gate-seq.mjs             # GATE 1
node gates/gate-resume.mjs 25       # GATE 2
npm run preview -- --host 127.0.0.1 # then, in another shell:
node gates/gate-scroll.mjs          # GATE 3 (+ web cold start), headless Chromium
```

| Gate | Result |
|---|---|
| **seq order** | PASS — 121 msgs fetched, folded (shuffled to mimic out-of-order realtime), strictly ascending, 0 gaps in range |
| **reconnect resume** | PASS — 25 msgs injected while WS down; 25 replayed via Centrifugo positioned recovery **and** 25 via REST `?after` backfill; **missing = 0** |
| **1k scroll** | PASS — react-virtuoso: **avg 8.35 ms/frame, p95 10.3 ms, 0 frames > 33 ms**, max **39 DOM rows for 1000 msgs**, scrolled through to seq 1000, JS heap ~10 MB |
| **cold start (web)** | FCP 72 ms · time-to-first-row 181 ms (production build) |
| **cold start (desktop, release)** | 537 ms launch → WebKit content process (< 2 s gate) |
| **idle memory (desktop, release)** | ~196 MB (main 98.8 + WebContent 48.7 + GPU 33.0 + Networking 15.4); debug ~230 MB — under the 400 MB gate |

## Spike findings (carry into P1/P2)

1. **momowebqa returns an mDNS realtime host** (`ws://<machine>.local:28001`).
   Chrome's WebSocket resolver **hangs** on the `.local` name (raw connect:
   `127.0.0.1` opens ~270 ms, `<machine>.local` never resolves). node/ping/curl
   resolve it fine — a webview-specific gap. `resolveSpikeRealtimeUrl` works
   around it **only on a loopback page origin** (ADR-0110 preserved in prod).
   *Proper fix is server-side: return a browser-resolvable host per environment.*
2. **react-virtuoso needs `initialItemCount`** to paint rows independent of the
   ResizeObserver pass (an embedded/second-tick layout can otherwise leave the
   list empty). Fixed in `Timeline.tsx`.
3. **REST has no CORS** → the same-origin proxy is mandatory for the web build;
   the **Tauri release** app loads `tauri://localhost` (no proxy), so P2 must
   route REST via the dev proxy equivalent or a Rust HTTP command / server CORS.
4. Automated **background** browser tabs throttle rAF/timers — scroll FPS must be
   measured headless (visible) or in the foreground Tauri window, not a bg tab.
