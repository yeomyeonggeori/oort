# `clients/mobile` — the oort iOS app

Bare React Native, New Architecture, Hermes. This is **the app** (ADR-0137,
goal RN-C2). Two neighbours are easy to confuse it with:

| | what it is |
|---|---|
| `clients/mobile-spike` | the disposable #837 harness. It answered five questions and is not shipped. Do not copy patterns out of it without reading why they were there — several exist only because it deliberately compiled `clients/web/src`. |
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
five Maestro flows distinguishes a frame that arrived over the socket from a row
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
```

`ios/` requires `pod install` once (`cd ios && pod install`).

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
- **EAS.** momo already owns fastlane + match + `momo-signing` (D1).

## The phone lane — `npm run lane:phone` (MAESTRO-1)

One command, no person driving it: an isolated stack on its own ports with the
**mock** provider, a disposable fixture member, the app installed on a simulator,
five Maestro flows against the real UI, a PASS/FAIL table, and the stack torn
down with its volumes. `npm run install:maestro` once first (`~/.maestro`; the
lane puts it on PATH itself, so nothing is added to your shell profile).

| flow | what it proves about the SCREEN, not the API |
|---|---|
| `00-login` | 서버 주소 입력 → 로그인 → 채널 목록 + 탭 바, from cleared state |
| `10-mention-working` | a turn in flight is **visible as one** — 「작업 중」 is on screen WHILE it runs (#839), then the reply lands |
| `20-stop` | 중단 is two-tap and the confirm step says what it costs; the receipt AND the channel's system line both appear |
| `30-approval` | 결정 대기 → 무장 → "되돌릴 수 없습니다" → 승인 → 영수증, and the approved call actually resumes and finishes |
| `40-agents-tab` | 재우기 warns before it acts, and a mention to a sleeping agent gets a system line instead of silence |

Measured here, all five green: 90 + 46 + 37 + 49 + 42 seconds of flow time.

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

**The server under this lane is Swift, not the live one.**
`infra/docker-compose.e2e.yml` builds `server/` (the port's original) for
api/relay/worker; `server-rust` never enters this stack. So a green table is
evidence about **the app's UI mechanics** — login, the working signal, the stop
and approval controls, the agents tab — and not evidence that the two servers
emit the same wire: frame patterns and card props can differ. When Swift is
deleted at parity, this lane has to be moved onto a `server-rust` e2e stack.
The runner prints this next to the 실기기 block every run so a green table is
never read as "same as live".

**What a green table here does NOT cover.** The simulator has no APNs, so the
lock-screen approval path — the one where a person decides without opening the
app — is not exercised at all. The runner prints that as an explicit 실기기
파이널 체크 block rather than letting five PASSes imply it. Same for the shared
keychain access group (device signature only).

**Isolation.** One dedicated compose project (`momo_maestro1`) on loopback ports
nothing else uses, `down -v --remove-orphans` in a trap so teardown runs on
failure and Ctrl-C too, and the same teardown at startup because the way stacks
accumulate is a run that died before its own trap ([[momo-docker-resource-accumulation]]).
A `mkdir` lock keeps two lanes off the same project — and the lock is taken
**before** the trap is armed, because with that order reversed a second run that
correctly refused the lock still ran cleanup on its way out and deleted the
holder's stack.

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
