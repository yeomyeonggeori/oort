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
```

`ios/` requires `pod install` once (`cd ios && pod install`).

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
