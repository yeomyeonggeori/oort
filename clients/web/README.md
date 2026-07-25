# momo web — canonical UI (ADR-0133 §1)

TS + React 18 + Vite. The same bundle runs in the browser and inside the Tauri
shell (`clients/desktop`). Origin: the MOMO-595 P0 spike, promoted to this path
by MOMO-596 (P1 foundation). Code below the promotion line is still **spike
quality** — P1 feature work replaces it surface by surface.

## Path history (MOMO-596)

`clients/web` used to hold the ADR-0119 alpha (v0). That client is **not deleted**:
it moved to **`clients/web-legacy`** and remains the live serving/e2e target
(`infra/prod/Dockerfile.web`, `infra/prod/docker/momo.Dockerfile` web-build stage,
the prod Caddy static-serve, `infra/docker-compose.e2e.yml` web-init, and the
`web`/`web-serving` profiles in `scripts/local_gate.sh` all point at
`clients/web-legacy`). Per ADR-0133 §5, the default alpha download stays on the
existing stack until the parity gate passes; this directory is where new UXUI
surfaces land in the meantime.

Serving/deploy wiring is **not** repointed at this directory yet. That is a
separate gated step (ADR-0133 parity appendix), not part of the promotion.

## Structure (matches plan §1)

```
src/app/          # App shell (realtime rail + sidebar frame), routes, ⌘K switcher
src/features/     # auth, sidebar, workspace reads, timeline, chat, inbox/activity/settings
src/design/       # tokens.css (여명 placeholder palette) + shadcn/ui primitives
src/lib/          # api (REST, contract-faithful), realtime (Centrifugo), env
gates/            # measurement runners (seq / resume / scroll+coldstart / inject)
e2e/              # smoke.mjs: login → channel → timeline → send → live receipt
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

## Connect surface + dynamic API base (MOMO-604, P2)

`src/features/auth/ConnectPage.tsx` replaced the same-origin login form. Three
additions, each of which also has to work when the answer is "nothing to show":

- **Server selection.** The address is a runtime value now, resolved by
  `apiBase()` in `src/lib/serverBase.ts`: the server chosen on the connect
  screen (localStorage `momo.web.server.v1`) → `VITE_MOMO_API_BASE` → `""` =
  same-origin. **The existing web deployment and the dev proxy are unchanged**:
  a blank field IS the same-origin path. Inside the Tauri shell there is no
  same-origin API, so the field is required there.
- **Invite deep link.** `momo://join?server=…&code=…`
  (`docs/onboarding-deeplink.md`) is consumed from the desktop shell event, and
  in a browser from the page query (`?server=&code=`, `?code=`, or a whole link
  as `?join=`). The code is stripped from the address bar as soon as it is read.
  Submitting redeems it through `POST /v1/join`, with display name and handle
  derived from the email exactly as the mac client derives them.
- **LAN discovery card.** `_momo._tcp` sightings reported by the shell, offered
  only when the advertised `baseUrl` is a usable http(s) URL. Browsers have no
  mDNS, so the card never renders there; nothing found is silence, not an error
  state.

The shell contract this consumes (web half of MOMO-603, `src/lib/tauri.ts`).
**The Rust side owns it** — `clients/desktop/README.md` "Bridge contract" is the
canonical statement and `src-tauri/src/{deeplink,discovery}.rs` the source:

| direction | name | payload |
|---|---|---|
| event | `momo:deep-link` | `{ url, server, code }` — one accepted link |
| event | `momo:discovery` | `{ servers: [{ baseUrl, displayHost, instanceName }], scanning }` — the FULL current set every time |
| command | `deep_link_take_pending` | `-> DeepLinkJoin[]`, drains the cold-start buffer |
| command | `discovery_start({ timeoutMs })` / `discovery_stop` | never rejects to the UI; the shell stops itself at the timeout |

Order matters for both: **subscribe first, then drain/start.** A cold start
delivers the URL long before React mounts, so the shell buffers it and
`takePendingDeepLinks()` is the handshake that releases it — draining before
`onDeepLink()` resolves releases the buffer to nobody, and draining twice
returns nothing the second time.

The shell deliberately does **not** validate `server`; the connect surface
re-validates it (`features/auth/deepLink.ts`) so that rule keeps a single owner,
exactly as the mac client does it.

**Still open (spike finding 3 below, not changed by this ticket):** the REST
server sends no CORS headers and does not answer preflight (verified: `OPTIONS
/v1/auth/login` → 404). A browser therefore cannot address a *different* origin
directly, and the desktop shell needs either server-side CORS for the app origin
or a Rust HTTP command. The connect screen stores and uses whatever base it is
given; making a cross-origin base reachable is a shell/server change.

```sh
npm run build && npm run preview -- --host 127.0.0.1
export MOMO_EMAIL=... MOMO_PASSWORD=...
npm run smoke:connect     # deep-link prefill, validation, dynamic base, offline
```

## Smoke (MOMO-598)

One browser run over the whole P1 loop against a live momowebqa. It signs in,
opens the ⌘K switcher, picks a channel from the sidebar, waits for the timeline
and a connected rail, sends a message, and waits for that row to appear.

```sh
npm run build && npm run preview -- --host 127.0.0.1   # or npm run dev
export MOMO_EMAIL=... MOMO_PASSWORD=...                # never hardcode
npm run smoke                                          # optional: MOMO_CHANNEL=<uuid>
```

The receipt assertion is a realtime assertion: the composer does no optimistic
insert, so a sent row can only reach the timeline through the Centrifugo
publication merged by `seq`. The report prints `resubscribesDuringRun`, which is
`0` when the row arrived live rather than through a reconnect backfill.

## Gates (measured on live momowebqa at MOMO-595, 2026-07-25 — honest numbers)

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
