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
gates/            # measurement runners (seq / resume / scroll+coldstart / shell layout / inject)
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

## Desktop notifications (MOMO-607, P2)

`src/features/notifications/` closes the seam MOMO-603 left open: the shell knows
how to show a banner, and this decides when one is worth showing.

- **Two events, both addressed to a person.** A mention the SERVER recorded
  (`props.mention_member_ids`, never a client-side scan of the body) and an
  approval request whose ledger status is still `pending` — the agent card's
  `awaiting-approval` state, the one row in the product actively waiting on a
  human.
- **The window having focus suppresses everything.** momo in front means the
  message is already on screen or one keystroke away, so a banner would be pure
  noise. Also suppressed: one's own writing, a muted channel (server truth,
  `Channel.muted`), an edit of a message that already had its chance, a repeat of
  something already announced, and a burst replayed by a reconnect (judged on
  `hlc_ts`, since the broadcast envelope carries no `created_at_ms`).
- **Copy is thin on purpose.** Sender as the title, one truncated line as the
  body. Fenced and inline code is replaced rather than quoted, and a short list of
  secret-shaped tokens (bearer, JWT, `sk-`, `gh*_`, `xox*-`, `AKIA`) is redacted:
  a banner is rendered by the OS, kept by the notification centre, and readable by
  anyone glancing at the screen.
- **A browser does nothing** — no notification, and no Centrifugo subscription
  either, so the web build pays nothing for a desktop capability.
- **Click landing is an approximation, and says so.** The shell cannot report a
  click (`clients/desktop/README.md`), so the target channel is armed when the
  banner is shown and consumed by the next window focus, expiring after 20s.

All of it is decided in `model.ts`, which is pure and unit-tested (35 cases,
including three VERBATIM momowebqa publications captured off the live rail).
`DesktopNotifications.tsx` is the impure half: subscriptions, focus, the OS call.

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

The shell layout gate needs neither creds nor a backend (it mocks `/v1` the way
`scripts/capture-screens.mjs` does) and brings up its own preview server:

```sh
npm run build && npm run gate:shell      # SHELL_GATE_SCHEME=light for the paper scheme
```

It asserts that the window never becomes a scrolling document: on every
signed-in route at 1280x800 / 900x600 / 760x480 the document scroll offset stays
0, the sidebar nav stays at its resting y, `.app-shell` is not itself a scroll
container, a long 설정 section still scrolls its own body pane down to the last
control, the composer stays inside the window, and the 1k-row timeline still
windows to ~24 DOM rows. The connect screen is checked the other way round: it
has no shell, so a short window must still reach the sign-in button.

| Gate | Result |
|---|---|
| **seq order** | PASS — 121 msgs fetched, folded (shuffled to mimic out-of-order realtime), strictly ascending, 0 gaps in range |
| **reconnect resume** | PASS — 25 msgs injected while WS down; 25 replayed via Centrifugo positioned recovery **and** 25 via REST `?after` backfill; **missing = 0** |
| **1k scroll** | PASS — react-virtuoso: **avg 8.35 ms/frame, p95 10.3 ms, 0 frames > 33 ms**, max **39 DOM rows for 1000 msgs**, scrolled through to seq 1000, JS heap ~10 MB |
| **cold start (web)** | FCP 72 ms · time-to-first-row 181 ms (production build) |
| **cold start (desktop, release)** | 537 ms launch → WebKit content process (< 2 s gate) |
| **idle memory (desktop, release)** | ~196 MB (main 98.8 + WebContent 48.7 + GPU 33.0 + Networking 15.4); debug ~230 MB — under the 400 MB gate |
| **shell layout** (MOMO-610) | PASS — 31 checks, 3 window sizes × 8 routes: document overflow 0 everywhere, sidebar nav held at y=45. Fails 10 checks on the pre-fix bundle (설정 > 멤버와 초대 pushed the nav to y=-487 at 1280x800, y=-1163 at 760x480) |

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

## Read-only terminal observation (MOMO-619, ADR-0126 D1)

`src/features/work/ObserverTerminal.tsx` + `observerStream.ts`. The capability
call is REST (`POST .../work-sessions/{id}/terminal-attach {"mode":"observer"}`),
the bytes are a **direct** WebSocket to the host: momo servers carry no terminal
stream, by design. xterm.js is bundled locally and code split
(`terminalRuntime.ts`, 334 kB js + 5 kB css, loaded on the first 관전 시작).

Two deployment facts measured on 2026-07-26 (live momowebqa + a local WSS PTY
host), both about `infra/prod/Caddyfile`:

- **`connect-src` blocks the host socket.** The prod policy is
  `connect-src 'self' wss://{$REALTIME_DOMAIN} https://{$REALTIME_DOMAIN}`, which
  does not cover an arbitrary host `attach_endpoint`. Chrome refuses the socket,
  logs the violation, and — this is the trap — fires **no error and no close
  event on the socket**, so the page carries its own deadline
  (`HOST_CONNECT_TIMEOUT_MS`).
  The refusal is still observable: it raises `securitypolicyviolation` on the
  document, and `cspBlockedHost` matches it against the endpoint being dialled
  (R1 M6). Re-measured behind the prod header on 2026-07-26 the panel now names
  the policy in **tens of milliseconds** (38 and 51 ms measured) instead of waiting 15 seconds to blame the host for a
  question it was never asked, and offers no retry, because a retry cannot
  change a policy the page is carrying.
  **This is a deployment prerequisite, not a client bug, and it is still open.**
  D1 in a browser needs the web client served with a `connect-src` that permits
  the workspace's host endpoints; ADR-0126 D1 owns that decision and the host
  PTY adapter it depends on (`observerStream.ts`: no host implementation exists
  in this repo yet). Until then the Tauri shell is the supported path for 관전
  (`tauri.conf.json csp: null`, unaffected), and the browser says so in the
  banner rather than failing silently.
- **`style-src` already allows what xterm needs.** xterm's DOM renderer writes
  `<style>` elements and one `setAttribute("style", …)` per truecolor cell. Under
  a hypothetical `style-src 'self'` the terminal still streams and prints text
  but loses colour, cell positioning and its dimensions (measured). The shipped
  policy carries `'unsafe-inline'`, so **no relaxation is needed** — but the
  directive can no longer be tightened without breaking this surface.
  Re-measured with a census on 2026-07-26 (R2 M3): a plain channel view already
  carries 5 inline-style nodes from react-virtuoso, and a streaming terminal
  carries 40 plus 3 injected `<style>` elements, 35 of them xterm's. The
  dependency is therefore older and wider than this ticket, and it is now
  recorded where the RULE lives (`momo-design-taste-web` SKILL §1 and
  `scripts/design_preflight_web.sh`), which until R2 still said the policy was
  `style-src 'self'`. The house rule is unchanged and still gated: components
  author no inline styles.

The liveness claim, and the two things a terminal costs:

- **관전 중 is bound to three facts, not to `readyState`.** The socket must be
  OPEN, `navigator.onLine` must be true, and nothing may have reported an outage
  since the last byte (`observerStream.observerLink`). R2 H1 measured why: with
  the network cut under a live stream no `onclose` ever arrives, so the phase
  stays `watching` and 관전 중 froze over a dead screen while the panel above it
  said the connection had dropped. There is no ping to send (the observer grade
  has no encoder for any frame but `connect`), so the surface reports what it
  can observe: 네트워크 끊김 while the browser has no network, 연결 확인 필요 with
  a 다시 연결 control after it comes back and before the stream proves itself,
  and `마지막 출력 N초 전` once the bytes have been silent for 10 seconds.
  Measured against the live host: 13.5 s offline held `data-link="offline"` on
  every sample with the age of the last byte counting up, and one arriving byte
  returns the surface to 관전 중 on its own.

- **xterm eats keys on behalf of a program that is not listening.** `disableStdin`
  drops the byte in `CoreService`, long after `preventDefault()` has already run,
  so Tab and Escape never left the helper textarea and a keyboard reader could
  not get back out of the terminal at all (WCAG 2.1.2). `terminalOwnsKey` is
  attached through `attachCustomKeyEventHandler` and returns the two navigation
  keys, plus the copy chords, to the browser. Verified against the live build:
  from inside the terminal, four Tabs walk out to 패널 넓게 보기 → 관전 중단 →
  세션 종료 → 발췌 공유, and Escape reaches the panel's step-back handler.
- **The viewport is not the host's width.** This client sends no resize frame by
  design, so the host keeps writing at its pty's own width (80) however narrow
  the pane is. The surface publishes the column count while it differs and
  offers the pane's 넓게 보기 state; see `references/tokens.md` in the
  design-taste-web skill for the measured numbers and the `getComputedStyle`
  border-box trap that made both axes over-report. Below 900px that control is
  hidden, because the pane is already the whole chat surface and widening it has
  nothing left to do, so the notice names the window instead of pointing at a
  button that is not there (R2 M2: measured at 880px, 79 columns against the
  host's 80, with both 넓게 보기 controls correctly absent).
