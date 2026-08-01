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

## Viewports: one shell, two shapes (goal B6)

The shell is a two-pane grid down to 600px, and a single pane with an overlay
drawer below it. **600px is one number living in two places** and they must not
drift: the `@media (width < 600px)` blocks in `src/design/tokens.css` and
`MOBILE_SHELL_QUERY` in `src/app/shellNav.tsx`. The stylesheet decides the
shape; the script decides what is focusable and what each header draws, and a
mismatch means a hamburger beside a sidebar that is already standing.

Why 600 and not 640/768: the narrowest board the existing gates measure as a
desktop starts at 600 (`gate:workstream` reads its picker inside a 600x800
window whose detail column is `600 - 240`), and every phone this targets is
390~430 wide in portrait. A phone in landscape (844) keeps the two-pane shell,
which is right there: a 240px column still leaves 604px of channel.

What changes below 600px:

| surface | wide | phone |
|---|---|---|
| sidebar | 240px column | 280px overlay drawer, `inert` while closed |
| 스레드 패널 | 320px column | covers the channel surface |
| 작업 세션 패널 | 320px column (already full-surface below 900) | covers it |
| 설정 | 192px nav + body | nav on top, body below |
| touch targets | 28~32px controls | 44px minimum (`tap-target`) |
| composer | last row of the column | same, plus `env(safe-area-inset-bottom)` |
| shell height | `100%` | `--app-viewport-height` (goal B9, below) |
| shell top | `0` | `env(safe-area-inset-top)` |
| form controls | `--text-body` (14px) | `--text-title` (16px), or iOS zooms in |

`npm run capture:design` shoots both: 1280x800 first (the frames that must not
change), then 390x844 (`mobile-*.png`) in light and dark, at
`deviceScaleFactor: 3` under an iPhone user agent. `CAPTURE_PROFILE=mobile`
(or `desktop`) runs one of the two while working on it. The phone pass is also
a check, so a broken board fails the run instead of shipping as a screenshot:

- no horizontal overflow on any phone screen — of the **document** and of
  **every scroll container on it**,
- the drawer sits at x=0, leaves a visible strip of the surface behind it, puts
  the caret inside itself, and marks the covered surface `inert`,
- 채널 목록 열기 / 컴포저 / 전송 measure at least 44px tall,
- the header row is at least 44px and `.app-shell` declares
  `env(safe-area-inset-top)`,
- the composer stays inside the visible viewport, including with the iOS bottom
  toolbar emulated,
- a 74-character unbroken token appended to every server-written string in the
  channel surface still does not make anything drag sideways.

### The phone is not a small desktop (goal B9)

Three things a 390px Chromium window does NOT reproduce, each measured against
성재's iPhone captures (2026-08-02) and each now carried by the capture:

- **The visible viewport is not the layout viewport.** iOS Safari's bottom
  toolbar covers ~100px without shrinking the layout viewport, so `height: 100%`
  and `100dvh` both answer 844px on an 844px screen while 744px is what the
  reader can see; the composer sat 88px behind the toolbar (measured). Resizing
  a desktop window shrinks both together and can never show this. The shell now
  takes its height from `--app-viewport-height`, written by
  `src/app/viewportHeight.ts` from `visualViewport`, and the capture reproduces
  the mismatch by making `VisualViewport.prototype.height` answer 100px short —
  the platform's behaviour, not ours, so an implementation that ignores
  `visualViewport` fails the assertion.
- **The document cannot overflow, so measuring the document proves nothing.**
  `.app-shell` is `overflow: clip`, so a leak inside the shell never reaches
  `document.scrollWidth`; it turns the timeline scroller into something you can
  drag sideways instead (measured at +781px with long tokens, while the document
  read 0). The assertion now covers every box whose computed `overflow-x` is
  `auto`/`scroll`, and names the widest descendant that pushed it.
- **Short fixture sentences do not exercise line breaking.** `overflow-wrap:
  break-word` does not lower a flex item's automatic minimum size, so a token
  with no break opportunity — a gateway URL, a digest, a path — sizes its box to
  itself. `tokens.css` now sets `overflow-wrap: anywhere` on the text elements
  (`:where(...)`, zero specificity, so `truncate` still truncates), and the
  capture ends with a stress frame that appends such a token to every
  server-written string in the timeline and the channel list.

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

The desktop shell's Content-Security-Policy has its own gate (MOMO-640), which
reads the policy out of `clients/desktop/src-tauri/tauri.conf.json` instead of
repeating it, serves the built bundle behind that exact header, and requires
zero `securitypolicyviolation` events through login → shell → xterm observer:

```sh
npm run build && npm run gate:csp
CSP_GATE_PROVE_RED_STYLE=1 npm run gate:csp   # red proof: MUST fail (xterm needs style-src)
```

The huddle browser gate uses REST and Centrifugo protocol fixtures, without a
backend, credentials, microphone, or LiveKit server. Its `huddle-gate` build
mode replaces only the audio connector while preserving the production lazy
import in normal builds. It locks the two absent-capability shapes (503
configured-off and 404 not-built-yet, goal B6), active badge/participant names,
the `huddle_ended` transition, the joined 760x480 header width contract, and
joined exit controls across an injected projection 500:

```sh
npm run build && npm run gate:huddle
HUDDLE_GATE_PROVE_RED_503=1 npm run gate:huddle     # MUST fail
HUDDLE_GATE_PROVE_RED_ENDED=1 npm run gate:huddle   # MUST fail
```

`HUDDLE_GATE_PROVE_RED_503=1` inverts the absent-capability count: it expects
one leftover huddle node, which is what appears the moment 404/503 stops being
read as "this server has no huddles"
(`huddleModel.isHuddleUnsupportedStatus`). Width red proof: temporarily remove
`max-w-pane` from `HuddleHeaderControl.tsx`; the 760px title/toggle geometry
assertion must fail with a long participant fixture. Projection-isolation red
proof: restore the old `status === "error"` early return above the joined
branch; the joined microphone/leave assertions after the injected 500 must fail.

A server without huddles renders **nothing**: no control, no banner, no error.
The 미구성 banner that used to sit under every channel header said one
unchanging sentence forever, and on the servers that answer 404 the same state
was drawn in `--danger` as an outage. Both are gone; a 503 answered to a
start/join the reader actually pressed still gets a sentence, because there the
person did something and silence would not say whether it landed.

The gate writes the five fixture captures to `artifacts/huddle/`:
`unconfigured.png`, `unimplemented.png`, `idle.png`, `active.png`, and
`error.png`. A joined capture requires a real LiveKit room and browser
microphone grant; the orchestrator records it as `artifacts/huddle/joined.png`.

The my-session continuity gate also needs no backend or credentials. Its long
DM fixture locks `전체` and `내 세션` at full width while only the channel chip
truncates. It deliberately returns sessions before hosts and checks that both
the default channel scope and `내 세션` wait without claiming `실행 중`, then
checks the final `online:false + running` presentation, detail/thread entry,
focus return, member filter, host-empty rows with neutral host metadata, and
the separate no-session/load-error states:

```sh
npm run gate:my-sessions
MY_SESSIONS_GATE_PROVE_RED_OFFLINE=1 npm run gate:my-sessions  # MUST fail
MY_SESSIONS_GATE_PROVE_RED_FILTER=1 npm run gate:my-sessions   # MUST fail
```

The three 2R regression assertions are direct reversal proofs:

1. Restore `min-w-0 truncate` on every `ScopeButton`; the fixed-label geometry
   assertion fails because the long DM clips `전체` or `내 세션`.
2. Restore the mine-only host loading condition around `SkeletonRows` and the
   non-mine list; the default channel assertion sees `실행 중` before the
   delayed host response.
3. Restore `(hostsQuery.data?.length ?? 0) > 0` on the mine list; the
   `hosts-empty` scenario times out waiting for its two ledger-backed rows.

The two existing environment red proofs remain mandatory and must exit nonzero.

The agent-hub gate is also fixture-only and needs no credentials or backend.
It runs three response schedules (`roster → memory → history`, `history →
roster → memory`, `memory → history → roster`) and asserts that lower-cased
agent keys keep late data on the right detail surface. The first schedule also
walks the four product writes/reads: roster selection, memory invalidation and
refetch, agent-global run cursor pagination plus detail, and pause projection.
Playwright execution belongs to the orchestrator:

```sh
npm run gate:agent-hub
AGENT_HUB_GATE_PROVE_RED_INVALIDATE=1 npm run gate:agent-hub  # MUST fail: memory invalidate round-trip
AGENT_HUB_GATE_PROVE_RED_HISTORY=1 npm run gate:agent-hub     # MUST fail: history cursor page
AGENT_HUB_GATE_PROVE_RED_PAUSE=1 npm run gate:agent-hub       # MUST fail: pause projection
```

되돌림 증명은 이름 있는 환경변수 하나만 켜서 실행한다. 제품 행이나 단정을
삭제하지 않는다. 각 실행은 위에 적힌 이름(`memory invalidate round-trip`,
`history cursor page`, `pause projection`)으로 실패해야 하며, 환경변수를 끈
정상 실행은 다시 PASS해야 한다.

These red proofs change named fixture seams instead of deleting a product or
assertion line, so the failure remains repeatable in a clean throwaway
worktree.

The workstream gate (MOMO-677 / ADR-0143) is fixture-only as well. It locks the
four claims 작업 흐름 makes that a screenshot cannot check: the list rows plus
the fact that the status filter reaches the SERVER (`?status=` is read off the
request, not assumed); one goal's run history carrying BOTH actors, with the
agent Run keeping its identity token and the continued Run saying it continued
one; the takeover POSTing the existing lineage resume with the chosen host, and
the reader's own Run then joining that history; and the 404/403 asymmetry, where
a workstream outside the reader's channels answers 404 and the surface says
"찾을 수 없습니다" with no word about permission, while the resume path's 403 is
the only place membership is named. It also writes list/detail captures in both
schemes to `artifacts/workstream/` for the design review.

```sh
npm run gate:workstream
WORKSTREAM_GATE_PROVE_RED_RUNS=1 npm run gate:workstream    # MUST fail: 실행 이력 A·B 병기
WORKSTREAM_GATE_PROVE_RED_RESUME=1 npm run gate:workstream  # MUST fail: 이어받기 왕복
WORKSTREAM_GATE_PROVE_RED_DENIAL=1 npm run gate:workstream  # MUST fail: 비멤버 404/403 분기
```

각 되돌림은 픽스처 행동만 바꾼다. `_RUNS`는 이력 투영이 첫 실행자 말고 전부
잊게 만들고(= ADR-0143이 대체한 "소유권 이전" 원장), `_RESUME`은 재개 POST가
200을 주면서 새 Run을 원장에 기록하지 않게 하며, `_DENIAL`은 비멤버 상세를
404 대신 403으로 답하게 한다. 실패 문구는 전부 이름을 갖는다: 게이트의 모든
대기가 `claim(이름, ...)`을 지나므로, 만료된 대기도 `Timeout 10000ms exceeded`가
아니라 어떤 주장이 깨졌는지로 출력된다.

The Tauri WKWebView microphone prompt is deliberately not inferred from browser
success. After the browser gate, the orchestrator must open the packaged shell,
join once, verify bidirectional audio, deny microphone once, and record whether
the shell needs `NSMicrophoneUsageDescription` or another entitlement/config
change. That shell change is outside MOMO-643.

`gate:csp` walks one path. To put the same packaged policy in front of the much
wider route walks the other two gates already do — `vite.config.ts` reads the
header from the environment:

```sh
CSP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(
  "../desktop/src-tauri/tauri.conf.json","utf8")).app.security.csp)')
MOMO_CSP_GATE_HEADER="$CSP" npm run gate:wire
MOMO_CSP_GATE_HEADER="$CSP" npm run gate:shell
```

Both pass under the packaged policy and both fail under
`MOMO_CSP_GATE_HEADER="default-src 'none'"` (measured 2026-07-27), which is how
you confirm the header is really being served rather than quietly ignored.

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

## 홈 화면 앱 (goal B10, RN 앞의 임시 다리)

**이것은 ADR-0137(RN 채택)을 대체하지 않는다.** 네이티브 클라이언트가 나오기
전까지 폰에서 쓰는 사람의 체감을 메우는 다리다. 발단은 구체적이다: 사파리
주소창이 컴포저를 가려서, 메시지를 쓰는 동안 자기가 친 글자가 보이지 않았다.

네 조각이고, 각각 다른 파일이 갖고 있다.

| 조각 | 어디 | 요점 |
|---|---|---|
| 매니페스트 | `public/manifest.json` | `display: standalone`, 아이콘 192/512/maskable |
| iOS 메타 | `index.html` | `apple-mobile-web-app-capable`, 상태바 `default` |
| 서비스 워커 | `src/features/pwa/sw.js` + `vite.config.ts` | 셸만 캐시, 데이터는 캐시하지 않음 |
| 안내 한 줄 | `src/features/pwa/*` + `src/main.tsx` | 설치 안내(기기당 1회), 새 버전 알림 |

**오프라인 정직성이 이 배치의 계약이다.** 워커는 `/v1`과 `/health`를 손대지
않고 그대로 통과시킨다. 그래서 네트워크가 없을 때 뜨는 것은 캐시된 셸 + 각
표면의 오프라인 상태이지, 어제 받아 둔 메시지가 아니다. 낡은 목록을 최신인 척
보여주면 그 화면에서 사람이 내리는 판단("아무도 답을 안 했네")이 틀리게 되고,
그 판단은 되돌릴 수 없다. 오프라인 동기화는 RN이 세션·읽음 상태와 함께 설계할
몫이다. 푸시 알림도 같은 이유로 없다(ADR-0120의 경로는 NSE).

캐시 세대는 빌드 하나다. `vite.config.ts`의 `momoServiceWorker` 플러그인이
번들 파일 이름(내용 해시 포함)에서 빌드 아이디를 뽑아 `sw.js`에 새겨 넣으므로,
배포하면 워커의 바이트가 바뀌고 브라우저가 업데이트를 알아본다. `public/`에 정적
파일로 두면 바이트가 영원히 같아서 그 일이 일어나지 않는다. 새 워커는 즉시
활성화되지만(낡은 셸 고착 금지) 화면을 몰래 바꾸지는 않는다: 앱이 "새 버전이
준비됐습니다" 한 줄을 띄우고, 새로고침을 누르는 것은 사람이다.

**워커는 https에서만 등록된다**(`store.ts serviceWorkerEligible`). Tauri 셸은
패키징 CSP가 `worker-src 'none'`이고 자기 업데이터를 갖고 있으며, dev/캡처/게이트
빌드는 모의한 `/v1` 위에 워커가 끼어들면 실패 원인이 두 겹이 된다. 로컬 preview
에서 같은 경로를 걸으려면 `?pwa`를 붙인다(`?stress`, `?agentwork`과 같은 종류의
seam). iOS의 홈 화면 추가 자체는 워커와 무관하므로 http에서도 전체 화면으로 뜬다.

```bash
npm run icons:pwa           # favicon.svg -> public/icon-*.png (마크를 고쳤을 때만)
npm run capture:standalone  # 실측 + artifacts/pwa/*.png
```

`capture:standalone`은 스크린샷 전에 먼저 잰다: 매니페스트가 JSON MIME으로 오고
크로미움 파서를 통과하는가, 아이콘이 선언한 크기 그대로인가, 워커가 셸을 미리
받아 두는가, **캐시에 `/v1` 응답이 하나도 없는가**, 끊었을 때 셸이 뜨는가,
그리고 홈 화면 모드에서 `#root`가 상단 안전 영역만큼 물러나고도 문서가 창보다
커지지 않는가. 하나라도 어긋나면 캡처 전에 실패한다.

한계 하나는 적어 둔다: 크로미움은 `display-mode`를 흉내 내지 못한다(CDP
`Emulation.setEmulatedMedia`가 아는 미디어 기능 목록에 없다). 그래서 그 규칙은
두 조각으로 나눠 잰다 — 배포되는 스타일시트 안에 `@media (display-mode:
standalone)` 규칙이 있는가, 그리고 그 선언이 기기가 준 안전 영역 값으로 풀리는가
(`Emulation.setSafeAreaInsetsOverride`는 실측 가능하다).
