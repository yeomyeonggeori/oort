# oort desktop — Tauri 2 shell (ADR-0133)

Tauri 2 shell that wraps the **exact `clients/web` bundle** — no forked UI.
Proves web/desktop run one codebase (plan §1). Originated as the MOMO-595 P0
spike; the wrapped bundle was promoted to `clients/web` by MOMO-596.

The shell's job is the part a webview cannot do. MOMO-603 landed the four native
integrations of plan §2 B-group — **deep link, mDNS discovery, notification,
keychain** — as plain app commands and two events. MOMO-606 added the fifth,
the **updater**, and with it the bundle identity this app ships under. Everything
else stays in the web bundle: what to prefill, when to notify and how a
discovered server is offered are product decisions, and none of them live in
Rust.

## Identity (MOMO-606)

| | |
| --- | --- |
| bundle identifier | `app.momo.desktop` (was the spike's `app.momo.spike`) |
| product / app name | `momo` → `momo.app` (the SwiftUI client is `MomoMac.app`, so both can sit in /Applications) |
| version | `0.1.0-next.N`, the pre-release train to the `0.1.0` open beta |
| keychain service | `app.momo.desktop`, account `refresh-token` |
| updater manifest | `https://yeomyeonggeori.github.io/momo-alpha/update-next.json` |

`oort://` is registered by this bundle **and** by the SwiftUI client. macOS
LaunchServices picks one handler for the scheme, so on a machine with both
installed an invite link may open either. Test deep links against a specific
build with `open -a <path> "oort://join?..."` (below) rather than trusting the
default handler.

## Layout

```
src-tauri/
  Cargo.toml          # momo-desktop (tauri 2, release: LTO + strip + opt-level=s)
  tauri.conf.json     # devUrl → clients/web dev; frontendDist → ../../web/dist
                      # plugins.deep-link.desktop.schemes = ["momo"]
  Info.plist          # macOS keys the bundler does NOT generate (mDNS, ATS)
  src/main.rs         # thin entry → lib.rs run()
  src/lib.rs          # plugin registration, command table, deep-link wiring
  src/deeplink.rs     # oort://join parsing + pre-webview buffer
  src/discovery.rs    # _momo._tcp browse
  src/notification.rs # permission + show
  src/opener.rs       # hand one https URL to the OS browser
  src/keychain.rs     # refresh token in the OS credential store
  src/updater.rs      # check / install / relaunch over the minisign manifest
  capabilities/       # core:default only (app commands need no permission entry)
  icons/              # generated via `cargo tauri icon app-icon.png`
```

# Bridge contract

**This section is the contract `clients/web` codes against.** The web half lives
in `clients/web/src/lib/tauri.ts` (typed wrappers, browser-safe fallbacks) and
`clients/web/src/lib/session.ts` (keychain consumer). A renamed command or event
fails at runtime, not at compile time — change all three together.

All payloads are camelCase. Commands are invoked by the exact names below.

## Events

| Event | Payload | When |
| --- | --- | --- |
| `momo:deep-link` | `{ url: string, server: string, code: string }` | A `oort://join` link arrived while the app was running. |
| `momo:discovery` | `{ servers: DiscoveredServer[], scanning: boolean }` | The known server set changed, and once more when a scan ends (`scanning: false`). |
| `momo:update-progress` | `{ downloaded: number, total: number \| null }` | Bytes moved while `updater_install` runs. `total` is null when the server sent no Content-Length. |

```ts
interface DiscoveredServer {
  baseUrl: string      // the address to dial, as advertised, e.g. "http://192.168.35.57:28000"
  displayHost: string  // the machine's name, e.g. "MacBook-Pro-2.local:28000"
  instanceName: string // "momo"
}
```

## Commands

| Command | Args | Returns | Notes |
| --- | --- | --- | --- |
| `deep_link_take_pending` | — | `DeepLinkJoin[]` | Drains links buffered before the webview subscribed **and** marks it ready. Call once. |
| `discovery_start` | `{ timeoutMs?: number }` | `void` \| error | Default 4000 ms, capped at 30000. Results arrive as events. |
| `discovery_stop` | — | `void` | Idempotent. |
| `notification_permission` | — | `"granted" \| "denied" \| "default"` | No prompt. |
| `notification_request_permission` | — | same | Prompts if the platform needs it. Desktop always grants. |
| `notification_show` | `{ title: string, body?: string }` | `boolean` | `false` = not shown because permission is not granted. |
| `keychain_available` | — | `boolean` | Probes the credential store. |
| `keychain_load_refresh_token` | — | `string \| null` | |
| `keychain_store_refresh_token` | `{ token: string }` | `void` \| error | Rejects an empty token. |
| `keychain_clear_refresh_token` | — | `void` \| error | Succeeds when there was nothing to delete. |
| `open_external_url` | `{ url: string }` | `void` \| error | Opens one **https** URL in the OS browser. Rejects anything else. Desktop only. |
| `app_version` | — | `string` | The running build, e.g. `0.1.0-next.1`. |
| `updater_check` | — | `AvailableUpdate \| null` \| error | `null` = already newest. **Rejects** on a failed check; see below. |
| `updater_install` | — | `void` \| error | Downloads, verifies minisign, swaps the bundle. Does not restart. |
| `updater_relaunch` | — | never returns | Restarts into the installed build. |

```ts
interface AvailableUpdate {
  version: string         // "0.1.0-next.2"
  currentVersion: string  // "0.1.0-next.1"
  notes: string | null    // manifest `notes`
  publishedAt: string | null  // manifest `pub_date`, verbatim RFC 3339
}
```

## Deep link (`oort://join`)

> goal B13 (momo → oort 리브랜딩): 링크는 `oort://`로만 **발급**하고, `oort://`와
> `momo://` 둘 다 **수용**한다. 이미 보낸 초대 링크는 며칠씩 살아 있고 보낼 때는
> 올바른 링크였으므로, 구 스킴은 무시가 아니라 흡수한다. OS 등록(`tauri.conf.json`
> `schemes`)도 두 개를 유지한다. 리포·크레이트·바이너리 이름은 계속 `momo`다.


Format is owned by [`docs/onboarding-deeplink.md`](../../docs/onboarding-deeplink.md);
this is a port of the macOS parser (`clients/macOS/Sources/MomoMac/MomoDeepLink.swift`)
so both shells prefill identically from the same link.

- `oort://join?server=<percent-encoded base URL>&code=<invite code>`
- Order-independent, unknown parameters ignored, names case-insensitive, first
  occurrence of a name wins.
- RFC 3986 percent-decoding — **not** form-urlencoded, so a literal `+` stays a
  `+` rather than becoming a space.
- `server` or `code` may be empty (a partial link still saves typing), never both
  — a link with nothing usable is dropped rather than delivered.
- `server` is **not** validated as a base URL here. The join surface re-validates
  it, exactly as macOS does, so that rule keeps one owner.
- `url` carries the invite code. Do not log it.

### The one-shot handshake

Clicking an invite link with the app closed launches it, and the OS delivers the
URL long before React mounts. Links that arrive before the webview says it is
listening are **buffered**, not emitted; `deep_link_take_pending` releases them
and flips the shell to event-only delivery. So the consumer does:

```ts
const stop = await onDeepLink(handle)   // 1. subscribe
for (const link of await takePendingDeepLinks()) handle(link)  // 2. drain, once
```

Subscribe first, drain second, drain once — a link is then never both replayed
and emitted, and never dropped.

Registration is per-platform: macOS reads `CFBundleURLTypes` from the bundle
(generated by the bundler from `tauri.conf.json`), Windows/Linux register at
runtime and deliver the launch URL as an argv entry instead.

## Discovery (`_momo._tcp`)

The internal-alpha stack advertises the API over Bonjour
(`scripts/internal_alpha_stack.sh`, MOMO-586). Ported from
`clients/macOS/Sources/MomoMac/MomoServerDiscovery.swift` (MOMO-587).

**TXT contract, two keys** (advertiser and consumer changed together, MOMO-609):

| key | holds | example |
| --- | --- | --- |
| `base` | the machine's Bonjour **name** | `http://MacBook-Pro-2.local:28000` |
| `ipv4` | the same API as a LAN **address** | `http://192.168.35.57:28000` |

- **Dial priority: `ipv4`, then `base`.** The webview was measured resolving the
  advertised `.local` name to a link-local IPv6 address it could not dial, so a
  login against the name produced no request at all: 70 s of "로그인 중…" with
  zero entries in the server's access log (parity gate G-1, 2026-07-25). Whether
  that name resolves depends on the responder cache and the local-network grant,
  so it is not something a client can rely on. The name stays advertised because
  it survives a DHCP lease change and consumers that can resolve it (the SwiftUI
  client, `curl`) still use it.
- Each key is validated on its own, so a malformed `ipv4` falls back to `base`
  instead of taking the sighting down with it, and an advertiser that predates
  `ipv4` behaves exactly as it did before.
- Only an advertisement that is `http(s)` **with a host** is offered. Deduped by
  the dialed URL, discovery order preserved.
- `baseUrl` is the raw advertised string of the **winning** key — never
  normalised, because it is what gets prefilled. `displayHost` names the machine
  (from `base` when present, advertised casing kept), so the card shows the name
  above the address it will actually connect to.
- **Silence is the contract.** Nothing found, permission denied, no responder on
  the host: all three end as an empty list. Discovery is an offer, not a step,
  and someone who already knows their address must never see a failed search.
  `discovery_start` still rejects on a dead responder so the cause reaches the
  console; `startDiscovery()` on the web side swallows it after logging.
- Each event carries the **full** current set, so the consumer is a pure render
  with no accumulation to get wrong.

macOS gates browsing behind the local-network permission prompt. `src-tauri/Info.plist`
supplies `NSLocalNetworkUsageDescription` and `NSBonjourServices`, plus
`NSAppTransportSecurity.NSAllowsLocalNetworking` — without the last one the
webview would be handed a `http://…local:28000` address it is then forbidden to
dial. Check the merged result:

```sh
plutil -p src-tauri/target/release/bundle/macos/momo-spike.app/Contents/Info.plist
```

## Keychain

One secret, one name, no free-form key: `keychain_get(key)` would let any script
in the webview enumerate whatever else the shell ever stores, which throws away
most of what the credential store was for.

- Service `app.momo.desktop`, account `refresh-token`. **Stable across builds** —
  changing either silently orphans every stored session.
- macOS binds an item's ACL to the **signature** of the binary that wrote it, so
  an item left by the unsigned spike (or an ad-hoc dev build) is one this signed
  build may not read. macOS does not answer that with an error: it puts up a
  **login keychain password dialog**. Measured 2026-07-25 against the signed
  `0.1.0-next.2` bundle: a modal appeared over the window on launch, before the
  person had signed in. `keyring`'s `delete_credential` prompted a second time
  for the same item, so an automatic delete-and-retry doubles the dialogs rather
  than recovering.
- The fix is therefore a rule at the call site, not a recovery in Rust: the
  credential store is touched **only when there is a session to resume or a token
  to move**. A first launch never asks, because the answer is not used until
  sign-in. If a write is then refused, the run demotes to web storage with the
  session intact and `getSessionStorageMode()` reports `web`.
- Developer machine with an orphaned item, once:
  `security delete-generic-password -s app.momo.desktop -a refresh-token`
  (that path deletes without a prompt).
- `clients/web/src/lib/session.ts` decides at runtime: keychain when the shell
  has one, the pre-existing `momo.web.session.v1` localStorage record otherwise.
  In keychain mode the token is in the credential store and only the non-secret
  metadata (member + `realtimeWebSocketUrl`) is in `momo.desktop.session.v1`.
  A session created before this build is migrated on first launch, and the web
  copy is deleted only after the keychain write lands.
- `getSessionStorageMode()` reports which path is in force, so a degraded run
  (Linux with no Secret Service) can be honest rather than imply a guarantee it
  is not delivering.

## Updater

Tauri updater, not Sparkle (#736 closed by ADR-0133). It is the difference
between "download a zip, drag it over the old app, relaunch" and one button, and
three manual steps is three chances to end up running a build nobody can
identify from the bug report that follows.

Trust chain, both halves needed:

- **minisign** — the manifest names a `.app.tar.gz` and its detached signature.
  The public key is in `tauri.conf.json` and compiled into the binary; the
  private key lives in `~/.momo-secrets/momo-updater.key` (0600) and is not in
  this repo. A tampered payload fails verification before anything is unpacked,
  so a compromised Pages host still cannot ship code to a tester.
- **Developer ID** — the `.app` inside that tarball is the same signed, notarized
  and **stapled** bundle the download page serves. `scripts/publish_next_build.sh`
  re-creates the tarball *after* stapling and proves it with a tar round trip
  (`codesign --verify` + `stapler validate` on the extracted copy), because the
  bundler's own updater artifact is written before notarization runs.

Three commands rather than one "update now", because each is a different
decision for the person at the keyboard: is there one, download it, restart into
it. The last one is separate on purpose — `download_and_install` replaces the
bundle under the running process, which keeps executing the old image until it
exits, so restarting is user-timed. Yanking the app out from under someone
mid-sentence is the one thing an auto-updater must never do.

`updater_check` **rejects** on failure instead of degrading quietly, which is the
opposite of `discovery_start`. Discovery finding nothing and discovery being
broken look the same to the person and both mean "type the address". An update
check is not like that: "I could not reach the update server" and "you are on
the latest build" must never render identically, or a stalled channel stays
invisible until someone reports a bug that was fixed a week ago.

Web half: `clients/web/src/features/updates/`. Three surfaces, one store:

- the connect screen, **before any login** — the internal alpha guide says the
  server is unreachable whenever the operator is away from their desk, so being
  stuck there is a normal state, and announcing the fix only to people who got
  in makes the channel useless exactly when it matters;
- a one-line badge in the sidebar footer, shown only when there is something to
  act on;
- the full state in 설정 > 업데이트, deep-linked as `/settings?section=updates`.

Publishing: `scripts/publish_next_build.sh --version 0.1.0-next.N`.

## Notification

Wrapped as app commands rather than the plugin's own JS bindings, so the web side
needs exactly one npm dependency (`@tauri-apps/api`) for the whole bridge.

`ensureNotificationPermission()` asks at most once per run, and is meant to be
called at the moment a notification is first worth showing — an OS permission
dialog at boot, before anyone has a reason to want notifications, is the fastest
way to earn a permanent "no".

**Which events notify is the web layer's decision, and it now has an owner:**
`clients/web/src/features/notifications/` (MOMO-607). The shell is told to show a
banner for exactly two things — a mention the server recorded, and an approval
request still waiting on a human — and only while this window does not have
focus. Every other rule (mute, de-duplication, replay suppression, copy
redaction) lives in that module's pure half and is unit-tested there. Nothing
about that policy belongs in Rust.

**Gap the bridge still has: the click.** `notification_show` is fire-and-forget —
`tauri-plugin-notification`'s desktop path spawns the notification and drops the
handle, so there is no way for the shell to report that a banner was clicked, and
therefore no way for the web layer to know *which* one was. The web side
approximates it (arm the channel at show time, consume it on the next window
focus, expire after 20s) and says so in `notifications/model.ts`. Closing it
properly means a Rust notification path that keeps the handle and emits an event
with the app-supplied target.

## External links (MOMO-620)

`<a target="_blank">` is correct in a browser tab and does **nothing** here: wry
leaves WKWebView's `createWebViewWith` unimplemented, so a new-window request is
dropped and a labelled action becomes a dead control in the desktop build only.
That is how `브라우저에서 열기` on a commit/PR artifact card shipped broken on
desktop while working everywhere else.

`open_external_url` is the fix, and it is an app command rather than
`tauri-plugin-opener` on purpose: the plugin's surface is "open a path, a file or
a URL with any handler", and the only thing this product needs is "hand one https
URL to the default browser". A command that can do exactly that cannot be talked
into doing anything else by a compromised webview.

The URL is re-validated in Rust (https only, no whitespace, no control
characters, none of `" ' & | < > ^`, 2048 byte ceiling) even though `clients/web`
already refuses anything else. A native command must not inherit its caller's
discipline: this is where webview-supplied data becomes an OS process argument.
Every refused character has to be percent-encoded in a valid URL anyway, so the
filter costs no real link, and `%` is deliberately allowed because percent
encoding is the shape most real links arrive in.

The launcher is `/usr/bin/open` on macOS, `xdg-open` on other unixes, and
`rundll32.exe url.dll,FileProtocolHandler` on Windows. Windows does **not** go
through `cmd /C start`: a command interpreter parses the URL a second time, where
`%…%` pairs expand as environment variables and quietly corrupt percent-encoded
links. The wait for the launcher runs on `spawn_blocking`, so a slow handler
parks neither the main thread nor an async runtime worker.

Web half: `openExternalUrl()` in `clients/web/src/lib/tauri.ts`, called from
`ArtifactCard`'s link row, which falls back to the plain anchor in a browser and
shows an inline failure with the address when the shell could not open it.

## Run

Normal dev (spawns the `clients/web` Vite dev server on 5173, then opens the window):

```sh
cd clients/desktop
cargo tauri dev
```

For the spike round-trip we pointed the shell at the already-running preview so the
desktop app got the same-origin proxy + whitelisted WS origin (5173 was held by a
sibling worktree on IPv6, so preview bound IPv4 `127.0.0.1:5173`):

```sh
# clients/web preview already up on http://127.0.0.1:5173
cargo tauri dev --config '{"build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:5173"}}'
```

Release app (self-contained, loads bundled dist):

```sh
cargo tauri build --bundles app
open src-tauri/target/release/bundle/macos/momo-spike.app
```

Deep links can be driven at a specific build without touching the system's
default `oort://` handler (which the macOS client also registers):

```sh
open -a src-tauri/target/release/bundle/macos/momo-spike.app \
  "oort://join?server=http%3A%2F%2FMacBook-Pro-2.local%3A28000&code=<code>"
```

`cargo tauri dev` produces a bare binary, not a bundle, so on macOS it has no
`CFBundleURLTypes` and cannot receive `oort://` at all — deep links must be
tested against the **release bundle**.

## Measured

### 2026-07-25, mac, release build (MOMO-595 spike)

- **Same code proof**: the Tauri window (title "momo — spike (Tauri)") renders the
  identical login/chat UI as the browser from the same bundle.
- **Cold start**: 537 ms from launch to WebKit content process (< 2 s gate).
- **Idle memory**: ~196 MB total (main 98.8 + WebContent 48.7 + GPU 33.0 +
  Networking 15.4 MB) — under the 400 MB gate. Debug build ~230 MB.
- Compile: debug 34 s, release (LTO) 53 s.

### 2026-07-25, mac, release bundle (MOMO-603 native integrations)

All four verified against the real `momo-spike.app`, not a unit-test double:

- **Deep link, cold start**: app not running, `open -a … "oort://join?server=…&code=COLDSTART-1"`
  → launched, parsed, buffered (`ready=false`) for the webview to drain.
- **Deep link, running app**: `oort://join?code=WARM-2&server=…&utm=mail` → parsed
  with the parameters reversed and the unknown one ignored. `oort://not-join?…`
  dropped silently.
- **Discovery**: found the live stack — `{"baseUrl":"http://MacBook-Pro-2.local:28000",
  "displayHost":"MacBook-Pro-2.local:28000","instanceName":"momo"}`, one
  `scanning: true` event then the terminal `scanning: false`. Cross-checked
  against `dns-sd -B _momo._tcp`.
- **Keychain**: `available → true`, store → load returns the same token → clear →
  load returns null. No residue (`security find-generic-password -s app.momo.desktop`).
- **Notification**: permission `Granted`, `show → true`, banner displayed.

### 2026-07-25, mac aarch64, published bundles (MOMO-606 updater)

Four real publishes (`0.1.0-next.1` .. `.4`) and two self-updates, starting from
the **release-page zip** installed into `/Applications`, not a local build:

- Install: `spctl -a -t exec` → `accepted, source=Notarized Developer ID`.
- `0.1.0-next.2` offered `0.1.0-next.3` on the connect screen; **one Tab** from
  window entry focuses `지금 업데이트` with a visible ring, Space installs.
- ~4 s later the row read `재시작하면 적용` and the bundle on disk was already
  `0.1.0-next.3` while the running window still reported `next.2` — the macOS
  "old image until exit" behaviour, visible on screen.
- `지금 재시작` relaunched as `0.1.0-next.3`, which immediately offered `.4`.
  Second hop landed on `0.1.0-next.4`, and the row disappeared (silent when current).
- The **self-updated** `/Applications/momo.app`: `spctl` → `accepted, source=
  Notarized Developer ID`, `xcrun stapler validate` → `The validate action worked!`
  Same Gatekeeper answer as a manual install, which is the whole point of
  re-creating the tarball after stapling.
- mDNS discovery worked in the packaged build (`MacBook-Pro-2.local:28000`).

## Known gaps

- The **release** app loads `tauri://localhost`, so the web build's dev proxy for
  `/v1` does not exist and REST is cross-origin. The server side of that landed on
  `main` as the CORS origin allowlist (MOMO-605, #768) and is **not in this
  branch's base** (`track/uxui` P2), so the `0.1.0-next.*` builds published so far
  install and self-update cleanly but cannot yet sign in against momowebqa. Taking
  `main` into the track closes it; nothing in the updater depends on it.
- `oort://` is registered by this bundle and by the SwiftUI client, and macOS
  picks one handler. Drive a specific build with `open -a <path> "oort://…"`.
- Unsigned or differently-signed builds: macOS ties keychain ACLs to the binary's
  signature, so an item left by one identity makes another put up a login-keychain
  password dialog. The shell no longer touches the credential store when there is
  nothing to resume (see Keychain above), which removes it from a first launch;
  a developer machine carrying an old item clears it once with
  `security delete-generic-password -s app.momo.desktop -a refresh-token`.
- Notification click routing: see the Notification section. The shell cannot
  report a click, so "click the banner, land on the channel" is an approximation
  on the web side rather than an OS-reported event.
