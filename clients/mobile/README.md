# `clients/mobile` — the oort iOS app

Bare React Native, New Architecture, Hermes. This is **the app** (ADR-0137,
goal RN-C2). Two neighbours are easy to confuse it with:

| | what it is |
|---|---|
| `f399e417:clients/mobile-spike` | the disposable #837 harness (deleted #2166). It answered five questions and is not shipped. Do not copy patterns out of git history without reading why they were there — several exist only because it deliberately compiled `clients/web/src`. |
| `clients/iOS` | the SwiftUI kit, **frozen** (ADR-0137 D8). Bug fixes only, retired when this app reaches parity. Its `MomoiOSPushKit` is inherited later, in 이행 순서 5. |

This batch delivered the scaffold and the wiring. The v0 UI (auth, sidebar,
timeline, chat, inbox) is 이행 순서 4; the NSE and TestFlight are 순서 5.

---

## The point of this client: it does not own its logic

`@momo/core` holds the decision logic — seq-ordered merge, approval state,
deep links, wire decoding — and `clients/web` already consumes it. This app
consumes **the same source files**, resolved by path in three places that must
agree:

| | |
|---|---|
| `metro.config.js` | `watchFolders` + `resolveRequest` for the bundler |
| `tsconfig.json` | `paths` for the typechecker |
| `jest.config.js` | `moduleNameMapper` for the tests |

Resolution is by path rather than through `node_modules`, the same choice
`clients/web` documents on its Vite alias: an alias cannot drift with a
lockfile, and there is exactly one copy on disk that both clients compile.

**The core must stay pure.** If something here fails to resolve or typecheck,
the fix is in this directory — never a React Native import in
`packages/momo-core`. `__tests__/projectShape.test.ts` runs the core's own
`gate:purity` so this client cannot land a change that breaks it unnoticed.

### What the host supplies

Everything platform-shaped arrives through `@momo/core/runtime/host`, installed
by `src/boot/coreHost.ts` — the sibling of `clients/web/src/lib/coreHost.ts`.

| port | here |
|---|---|
| `apiBase` / `absoluteApiBase` | `src/storage/serverBase.ts`, MMKV-backed |
| `buildMode` | `__DEV__` (`import.meta` does not exist under Metro/Hermes) |
| `SessionPort` | `src/storage/secureSession.ts`, iOS keychain |

---

## Storage is split by secrecy (ADR-0137 D7)

| what | where | why |
|---|---|---|
| access token | memory only | lives 15 minutes, re-minted by rotation |
| **refresh token** | **iOS keychain** | `react-native-keychain`, `AfterFirstUnlockThisDeviceOnly` |
| server base, session metadata | MMKV | not secret, and MMKV reads synchronously |

**MMKV is not a secret store.** Its encryption takes an `encryptionKey` that
then has to be kept safely somewhere — the same problem one layer down, with the
appearance of having solved it. `src/storage/kv.ts` carries an allow-list of the
keys that may be written there, and `__tests__/coreRoundTrip.test.ts` asserts
that no value in it ever contains the refresh token.

MMKV is used at all because `SessionPort` and `apiBase()` are **synchronous** —
`@momo/core/lib/api.ts` reads them inline on every request. The keychain is
async, so `initSessionStore()` hydrates once before the first render and writes
are serialised behind a queue; two overlapping rotations landing out of order
would leave the revoked token stored.

---

## Constraints paid for on a real device — do not undo these

### 1. A composer's value is updated synchronously

Spike gate 1 case D: one `setTimeout(() => setValue(next), 0)` between keystroke
and rendered value severs the iOS IME. Korean jamo stop combining entirely —
`안녕하세요` came out as `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ`. **Never route an input value
through a store, a query or the network and back.**
`__tests__/connectScreen.test.tsx` asserts the value is readable with nothing
awaited.

### 2. The timeline is not `inverted`

Gate 5, real device: with `inverted`, a message arriving while the reader was
scrolled back moved their position **46–91px**; forward measured **0px**.
`__tests__/projectShape.test.ts` fails on the word `inverted` anywhere in `src`.
The guard exists before the list does, because `inverted` is the default thing
to reach for when building a chat view.

### 3. Custom-scheme URLs need the polyfill

React Native's built-in `URL` is regex-based, not WHATWG, and cannot parse
`oort://join?…` — 0/19 on it, 19/19 on `react-native-url-polyfill`.
`src/boot/polyfills.ts` installs it, first, in `index.js`.

What makes this dangerous is that the built-in gets many http(s) cases *right*
(`normalizeServerUrl` passes on it completely), so the symptom reads as "deep
links are broken" rather than "the URL parser is wrong".
`__tests__/urlPolyfill.test.ts` pins both halves against React Native's real
implementation.

### 4. (new, this batch) React Native has no `crypto`

Not from the spike. The core calls `crypto.randomUUID()` in
`features/timeline/approvalDecision.ts` — the approval flow, a v0 feature — and
in `lib/api.ts`. React Native supplies no `crypto` global at all, so this would
have thrown `ReferenceError` the first time anyone approved anything.
`src/boot/polyfills.ts` composes it over `react-native-get-random-values`
(`SecRandomCopyBytes`), never `Math.random`.

---

## Known blocker, not fixable here: Centrifugo `Origin`

React Native's WebSocket **sends an `Origin` header**, valued as the websocket
URL's own origin. Pre-spike research assumed it did not; measurement disproved
that. Against this repo's `infra/centrifugo.json` `client.allowed_origins`:

| connection | Origin sent | current list |
|---|---|---|
| `wss://app.oor7.com/…` | `https://app.oor7.com` | **accepted** |
| `ws://<machine>.local:28001/…` | `http://<machine>.local:28001` | **rejected** |
| `ws://127.0.0.1:<port>/…` | `http://127.0.0.1:<port>` | **rejected** |

A rejected handshake looks like `{"code":2,"message":"transport closed"}`
repeating forever, with the socket never once open. Self-hosting on a LAN is a
product property, so this is real — but the fix is a server configuration and
security decision and is out of scope here. See
`src/realtime/centrifugeTransport.ts`.

**The lane now measures this rather than assuming it (#1051).** Nothing in the
lane's Maestro flows distinguishes a frame that arrived over the socket from a row
a re-fetch drew, so a lane could be green with the realtime rail entirely shut —
which is how the QA stack rejected every phone handshake for weeks without one
red run. `scripts/lane-realtime-probe.mjs` closes that: it drives the app's own
`centrifuge` client, presents the Origin React Native presents, and fails unless
a live publication lands on the channel. Its red proof
(`LANE_PHONE_REALTIME_RED_PROOF=1`) boots the same stack with that origin removed
and passes only if the rail refuses — reproducing the exact
`{"code":2,"message":"transport closed"}` above.

---

## Commands

```
npm test                    # jest
npm run typecheck           # tsc --noEmit
npm run lint                # eslint
npm run gate:project-shape  # the mechanical guards, alone, for CI
npm start                   # Metro
npm run ios                 # run on a simulator
npm run build:sim           # xcodebuild for the simulator, ad-hoc signed
npm run gate:session        # does a session survive a restart? (below)
npm run install:maestro     # Maestro CLI into ~/.maestro (once)
npm run lane:phone          # the whole phone check, unattended (below)
npm run check:maestro-syntax  # `maestro check-syntax` over every flow file, no device (below)
```

`ios/` requires `pod install` once (`cd ios && pod install`).

**Metro started by a script or an agent** runs with `CHROME_PATH=/usr/bin/false`
(the lane, `measure.sh` and `gate/run.mjs` already do; by hand:
`CHROME_PATH=/usr/bin/false npm start`). Otherwise a tap on the dev build's
"Open debugger" toast makes Metro launch the real Google Chrome from that shell,
where it aborts at once and macOS shows "Google Chrome quit unexpectedly" (#5083).
Run `npm start` without it only when you want the debugger window.

### Writing a test

Import the shared tools from `__tests__/testkit` instead of declaring them again in the file
(`member`, `message`, `jsonResponse`, `installFetch`, `mmkvStore`, `resetSession`/`signIn`,
`makeQueryClient`, `flat`, `settle` ...; the header of `testkit/index.ts` lists them). Find things
on screen by accessibility role and label (`control('button', copy.SAVE)`), not by a Korean sentence
typed into the test: `control`/`labelled` throw on an empty label instead of matching every node.
Add a case to the file that already tests the same component or module, and name a new file after
its target, never after an issue number (the issue goes in the `describe` title or a comment).
A test that wraps its body in `describe` and has its own `afterEach` should start that hook with
`await drainRender()` (see `testkit/render.tsx` for why).

### `Podfile.lock` 이 경로에 안 흔들리는 이유 (건드리기 전에 읽을 것)

`ios/Podfile` 맨 위에는 hermes-engine 체크섬을 정규화하는 짧은 CocoaPods 훅이 있다.
장식이 아니다 — 그게 없으면 **체크아웃 절대경로마다 `Podfile.lock` 이 달라진다.**

RN 0.86 의 `hermes-engine.podspec` 은 hermesc 를 `require.resolve` 로 찾아 그 절대경로를
`HERMES_CLI_PATH` 로 박고(podspec:91-97), CocoaPods 는 직렬화한 podspec JSON 의 SHA1 을
lock 의 SPEC CHECKSUM 으로 쓴다(cocoapods-core/specification.rb:685). 그래서 체크섬이
작업 디렉터리의 함수가 되고, 워크트리·머신·CI 러너가 바뀔 때마다 lock 이 다시 쓰인다.
락을 강제 검증하는 `pod install --deployment` 는 그 자리에서 실패한다.

함정은 **같은 경로에서 두 번 돌리면 값이 안정적**이라는 것이다. "`pod install` 2회 연속
diff 0" 으로는 절대 안 잡힌다. 결정성을 확인하려면 축을 경로로 잡아라:

```bash
# 다른 경로에 체크아웃해서 같은 체크섬이 나오는지 본다 — 이게 진짜 게이트다
git worktree add --detach /tmp/lockcheck HEAD
cd /tmp/lockcheck/clients/mobile && npm ci && cd ios && pod install
git diff --stat Podfile.lock      # 비어 있어야 한다
pod install --deployment          # exit 0 이어야 한다
```

`Podfile.lock` 의 hermes 줄이 이유 없이 흔들리기 시작하면 훅이 죽었는지부터 확인하고,
`Pods/Local Podspecs/*.json` 에 `/Users/` 가 새로 생겼는지 본다(정상이면 96개 전부 0건).

---

## The session gate — the one question jest cannot ask

`__tests__/restoreOffline.test.ts` mocks `react-native-keychain`, so it pins the
DECISION ("a launch with no signal must not cost the session") and can never
reach the MECHANISM, which is `SecItemAdd`. That gap is not theoretical:

> **A `CODE_SIGNING_ALLOWED=NO` build cannot use the keychain at all.** It gets
> only the linker's signature — `Sealed Resources=none`, `Info.plist=not bound`,
> identity `MomoMobile` rather than `app.momo.ios` — and every keychain call
> comes back `errSecMissingEntitlement (-34018)`. `secureSession.ts` catches that
> on purpose (a failed keychain write must not take down a sign-in that is
> succeeding), so the app runs, looks fine, and never remembers anyone.

`build:sim` used to pass exactly that flag. So until goal RN-G1 this project
could not have caught a session-restore regression by any means it owned: the
build gate does not run the app, and the test gate does not reach the keychain.

`npm run gate:session` runs the real app on a simulator across **five real
relaunches**, because "survives a restart" cannot be asserted without restarting:

| step | what it proves |
|---|---|
| `login` | `SecItemAdd` is accepted — the raw OSStatus is reported, uncaught — and the refresh token lands in the keychain |
| `restore-online` | a NEW PROCESS finds the session, resumes it, and stores the rotated token instead of the spent one |
| `restore-offline` | a NEW PROCESS whose server is unreachable **keeps** the credentials: the regression guard for the defect fixed in `844407fb` |
| `restore-rejected` | a refused refresh token erases the keychain item, the metadata and the session, and lands on sign-in |
| `signed-out-sticks` | the erasure survived the restart too |

A mock oort API and a control channel (`gate/server.mjs`, zero dependencies) sit
on ephemeral ports and `gate/run.mjs` drives `simctl`. About **7 seconds** for
the five launches, plus 10–40s for the build; `--no-build` reuses `build/sim`.

Two habits it deliberately does not have. It never retries a step — a step that
has not answered inside its one hard deadline has failed. And it never takes port
8081 by force: if your Metro is serving another checkout it starts its own and
points that launch at it with `-RCT_jsLocation`. The first draft of this gate
"passed" against a different worktree's JavaScript, which is why that check is
there.

**What an ad-hoc simulator signature still cannot prove.** It is not a device
signature, so anything needing a real provisioning profile stays invisible here —
above all the shared keychain ACCESS GROUP the NSE will read
(`kSecAttrAccessGroup`), which fails with this same `-34018` **on device only**.
이행 순서 5 has to verify that on hardware.

### Never run in this directory

- **`expo prebuild`.** Without `--platform android` it regenerates `ios/` and
  deletes the NSE target that 이행 순서 5 attaches — the same accident that
  killed the Tauri path (#15663). There is no script here that invokes it, and a
  test asserts there never is.
- **Anything that creates `android/`.** Android is on hold (성재 결정 6). It is
  not cancelled; it resumes after iOS v0 reaches TestFlight, because the
  expensive half is FCM and that chain is still Swift-only.
- **EAS.** oort already owns fastlane + match + `momo-signing` (D1).

## The phone lane — `npm run lane:phone` (MAESTRO-1)

One command, no person driving it: an isolated stack on its own ports with the
**mock** provider, a disposable fixture member, a realtime proof made with the
phone's own Origin, the app built and installed on a simulator, six Maestro flows
against the real UI, a PASS/FAIL table, and the stack torn down with its volumes.
`npm run install:maestro` once first (`~/.maestro`; the lane puts it on PATH
itself, so nothing is added to your shell profile).

```
npm run lane:phone                              # build, boot, the six flows, tear down
npm run lane:phone -- --no-build                # reuse build/sim (needs an existing build)
npm run lane:phone -- --flow 20-stop            # one flow only
npm run lane:phone -- --device "iPhone 17"      # the simulator, by name (default iPhone 17 Pro)
npm run lane:phone -- --keep                    # leave the stack up to debug
npm run lane:phone -- --skip-flows              # stack + realtime proof only
```

| flow | what it proves about the SCREEN, not the API |
|---|---|
| `00-login` | 서버 주소 입력 → 로그인 → 채널 목록 + 탭 바, from cleared state |
| `10-mention-working` | a turn in flight is **visible as one** — 「작업 중」 is on screen WHILE it runs (#839), then the reply lands |
| `20-stop` | 중단 is two-tap and the confirm step says what it costs; the receipt AND the channel's system line both appear (the line is the server's own sentence; the flow accepts 「중지했어요」 and 「중단했어요」, #5079) |
| `30-approval` | 결정 대기 → 승인 한 번(확정 단계 없음, #3819) → 영수증, and the approved call actually resumes and finishes |
| `40-agents-tab` | the agent list opens from + 메뉴 → 「AI」 → 「에이전트 부르기」 and its profile screen is the fixture agent's (the 재우기 card left the phone in #3902, so the flow no longer pauses anything) |
| `45-work-console` | + 메뉴 → 「작업」 opens the work list (`WorkJobsScreen`, ADR-0202 D6): 내 것 and 팀 전체 both list the fixture member's session, and a row opens the read-only detail sheet |

When last measured (#5045) the six took 118 + 60 + 68 + 79 + 52 + 52 seconds of flow
time; the first is the slowest because it starts from cleared state. Read that as a
scale — the table every run prints is the measurement.

**The simulator's system language has to be Korean.** The flows dismiss iOS's own
sheets by their Korean labels (`지금 안 함`, `허용 안 함`, `열기`), and the one that
matters is the keychain's 「암호를 저장하겠습니까?」: it rises as the first sign-in
submits and hides the app's accessibility tree until someone dismisses it. A clone of
the stock iPhone 17 Pro is English, so that sheet reads 「Save Password?」 / 「Not Now」,
nothing taps it, and the run dies in `pass-notify-primer` ("Assert that id:
notify-primer-continue|sidebar-list is visible... FAILED") with a screenshot of a
healthy app under a dialog. Set the language once, on the clone, with the device shut
down: in `~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Library/Preferences/.GlobalPreferences.plist`
run `plutil -replace AppleLanguages -json '["ko"]' <that file>` and
`plutil -replace AppleLocale -string ko_KR <that file>`.

**Not every flow in `maestro/` is a lane flow.** The lane runs the six above. The
rest are measurement and capture flows for the app's `-momoMeasure` surfaces
(`measure/`): each file's header says how its surface is launched, `measure/*.sh`
and `measure/sheet-drag-run.mjs` wrap some of them, and the verification line runs
them at each stack. The sheet-drag flows (115–118) are **templates**: the driver
reads the live view hierarchy, pastes the geometry into every `${NAME}` and only
then hands Maestro the result — which is why a value that never varies (the 60 ms
flick) is a plain number there, not a placeholder (see the syntax check below).
`4869-reply-swipe` does run through the lane, with `--flow 4869-reply-swipe`: the
lane passes every flow `-e CHANNEL_ID` (#agent-lab) and `-e PEER_TEXT` (the one line
the lane's second member, "Lane Peer", writes in that channel's main flow — the
mock's reply no longer works as a peer row since #4646 puts it in a thread), so
that flow has a peer's row to swipe. After a stack is replaced the
app still holds the old stack's login; with `--flow` the first flow signs in again
before it starts (slower, still works) — `--flow 00-login` first gives a clean start.

**A capture script asks the harness whether it knows the name first (#5172).** `-momoMeasure <NAME>`
accepts any name, and a name the harness does not know renders the 「알 수 없는 표면」 page — which a
screenshot records like any other. `measure.sh` kept capturing `WORK-CONSOLE` (deleted by #2864) that
way, and the verification line took two `APPROVED` photos of that page as evidence of an approved card.
`node measure/known-surface.cjs <NAME>…` exits 2 on an unknown name. It reads the top-level dispatch of
`Surface()` in `measure/surfaces.tsx` (there is no second list to keep), `measure.sh` runs it for every
`capture_surface` name before it touches the simulator, and any other capture script should run it
before `xcrun simctl launch`. It cannot see inside a prefix family (`sheetkit-…`): the family judges its
own `which`. `__tests__/measureSurfaces.test.tsx` checks the tool against what the harness really draws.

**「작업 중」 is only observable because the mock is asked to be slow.** A default
mock turn is about two tenths of a second end to end, so the indicator would be
gone before Maestro could look and the flow would assert nothing while passing.
The lane steers `scripts/mock_hermes.py` **per request**, through markers in the
message body (`MAESTRO SLOW`, `MAESTRO TEXT`) rather than process-wide env vars,
because one run needs a slow text turn and a tool-call turn in the same stack.
`LANE_PHONE_SLOW_SECONDS=0.05 npm run lane:phone -- --flow 10-mention-working`
takes that away and the flow must go RED at the 「작업 중」 assertion — that is the
proof the assertion is load-bearing, and it is worth re-running if you ever
change the mock.

**The server under this lane is the deploy image.** Every run builds
`server-rust/Dockerfile` and boots it from `infra/rust/docker-compose.rust.yml`
(the deploy compose itself) plus one overlay, `infra/rust/docker-compose.lane-phone.yml`,
that points the agent worker at the mock provider. So a green table is evidence
about the app's UI mechanics against the same api, relay and worker a deployment
runs; the one real difference is the mock provider — what a real model would answer
is not proven here, and the runner prints that every time. `LANE_PHONE_RUST_IMAGE=<tag>`
skips the build and boots a prebuilt image instead; the table is then evidence about
THAT image, not about the server in this checkout, so say which one when you quote a
result. (The Swift server this lane used to boot is gone.)

**What a green table here does NOT cover.** The simulator has no APNs, so the
lock-screen approval path — the one where a person decides without opening the
app — is not exercised at all. The runner prints that as an explicit 실기기
파이널 체크 block rather than letting the PASSes imply it. Same for the shared
keychain access group (device signature only).

**Isolation.** One dedicated compose project (`momo_maestro1`) on loopback ports
nothing else uses (api 24330, Centrifugo 24331, mock Hermes 24333),
`down -v --remove-orphans` in a trap so teardown runs on failure and Ctrl-C too,
and the same teardown at startup because the way stacks accumulate is a run that
died before its own trap ([[momo-docker-resource-accumulation]]). Two lanes at once
(two workers) each set their own `LANE_PHONE_PROJECT`, `LANE_PHONE_API_PORT`,
`LANE_PHONE_CENT_PORT` and `LANE_PHONE_HERMES_PORT`. A `mkdir` lock keyed on the
project keeps two lanes off the same project — and the lock is taken **before** the
trap is armed, because with that order reversed a second run that correctly refused
the lock still ran cleanup on its way out and deleted the holder's stack.

**Nothing committed is a credential.** Every secret the stack needs — including
the three `infra/rust/docker-compose.rust.yml` refuses to start without
(`NOTIFIER_POSTGRES_PASSWORD`, `WEBHOOK_INGRESS_MASTER_KEY`,
`OUTBOUND_WEBHOOK_MASTER_KEY`) — is drawn fresh per run into a 0600 file and goes
with it. The compose file's two bind mounts (the mock provider's script and
`infra/centrifugo.json`) are first copied to a staging folder under
`~/.cache/momo-lane-phone/<project>` (`LANE_PHONE_STAGE_DIR` moves it), because
Colima's VM does not see every host path (`/private/tmp` is one) and a checkout
there would otherwise boot a stack with empty mounts. The staging folder is removed
with the stack, unless `--keep`.

**Metro and the watchdog.** The lane starts Metro on 8081 — the app's own default,
since `launchApp.arguments` cannot take a `${...}` — with `CHROME_PATH=/usr/bin/false`,
so a tap on the dev build's "Open debugger" toast cannot launch the real Chrome (#5083).
It reuses a Metro that already serves THIS checkout and refuses one that serves
another (it asks Metro for its project root): a Metro from another tree would hand
the app that tree's JavaScript and the table would report on code it never built.
Each flow also runs under a watchdog (`LANE_PHONE_FLOW_TIMEOUT`, 1800 s), because
Maestro 2.8 sometimes sits in its own teardown after every step passed; a flow that
blows the bound is a FAIL like any other. And `30-approval` is checked from outside
the screen: the screen looks the same whether the approved tool ran or came back
"this server cannot execute it", so after the flow the lane reads the work session's
row and downgrades a screen-green run to FAIL unless it is `ended`.

### Flow syntax check — `npm run check:maestro-syntax` (#5081)

`maestro check-syntax <file>` parses a flow with Maestro's own reader: no device, no
app, no stack. The script runs it over every `*.yaml` under `maestro/` (subflows
included), four files at a time — about 2 s a file, nearly all of it JVM start-up, so
the whole folder is a minute or less. PR CI runs the same script in the `node_mobile`
job, with Maestro pinned there (`.github/workflows/pr-ci.yml`).

It exists for what a simulator run only finds hours later: a missing `---` header
(#4869, the config block running into the commands) and a `${...}` placeholder in a
number field (#5081: `swipe.duration` in the three sheet-drag templates — `check-syntax`
does not substitute the way a run does). Keep placeholders out of number fields; a
value that never varies belongs in the file as a number. It does **not** know whether
a testID still exists or a sentence still reads that way — only a run does (the lane
for its six flows, the verification line for the rest).

It cannot pass blind. Before the real files it runs a negative control — a minimal
valid flow must be accepted, a flow with no `---` and a flow with a placeholder in a
number field must be rejected — and fails if any of the three is answered wrongly
(a Maestro that turned lenient, a JVM that cannot start). It also refuses to report
a pass on zero files.

## iOS identity

`app.momo.ios`, team `YWQQFQM38J`. These are not arbitrary: the Developer Portal
App ID and its capabilities (App Group `group.app.momo.ios`, `aps-environment`,
keychain group `YWQQFQM38J.*`) already exist under exactly this string, and the
push inheritance in ADR-0137 D7 depends on the match. Changing it discards those
assets.

`NSAllowsLocalNetworking` is on and `NSAllowsArbitraryLoads` is off: the former
is Apple's sanctioned exception for `.local` and local address ranges, which a
self-hosted product needs; the latter is the switch that demands a justification
at review.
