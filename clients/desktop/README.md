# momo desktop — Tauri 2 shell (ADR-0133)

Tauri 2 shell that wraps the **exact `clients/web` bundle** — no forked UI.
Proves web/desktop run one codebase (plan §1). Originated as the MOMO-595 P0
spike; the wrapped bundle was promoted to `clients/web` by MOMO-596.

The shell's job is the part a webview cannot do. MOMO-603 landed the four native
integrations of plan §2 B-group — **deep link, mDNS discovery, notification,
keychain** — as plain app commands and two events. Everything else stays in the
web bundle: what to prefill, when to notify and how a discovered server is
offered are product decisions, and none of them live in Rust.

Still not here: the **updater** (Tauri updater vs Sparkle #736 is undecided).

## Layout

```
src-tauri/
  Cargo.toml          # momo-desktop (tauri 2, release: LTO + strip + opt-level=s)
  tauri.conf.json     # devUrl → clients/web dev; frontendDist → ../../web/dist
                      # plugins.deep-link.desktop.schemes = ["momo"]
  Info.plist          # macOS keys the bundler does NOT generate (mDNS, ATS)
  src/main.rs         # thin entry → lib.rs run()
  src/lib.rs          # plugin registration, command table, deep-link wiring
  src/deeplink.rs     # momo://join parsing + pre-webview buffer
  src/discovery.rs    # _momo._tcp browse
  src/notification.rs # permission + show
  src/keychain.rs     # refresh token in the OS credential store
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
| `momo:deep-link` | `{ url: string, server: string, code: string }` | A `momo://join` link arrived while the app was running. |
| `momo:discovery` | `{ servers: DiscoveredServer[], scanning: boolean }` | The known server set changed, and once more when a scan ends (`scanning: false`). |

```ts
interface DiscoveredServer {
  baseUrl: string      // as advertised, e.g. "http://MacBook-Pro-2.local:28000"
  displayHost: string  // "MacBook-Pro-2.local:28000"
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

## Deep link (`momo://join`)

Format is owned by [`docs/onboarding-deeplink.md`](../../docs/onboarding-deeplink.md);
this is a port of the macOS parser (`clients/macOS/Sources/MomoMac/MomoDeepLink.swift`)
so both shells prefill identically from the same link.

- `momo://join?server=<percent-encoded base URL>&code=<invite code>`
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

The internal-alpha stack advertises the API over Bonjour with a TXT `base` key
holding the API base URL (`scripts/internal_alpha_stack.sh`, MOMO-586). Ported
from `clients/macOS/Sources/MomoMac/MomoServerDiscovery.swift` (MOMO-587).

- Only advertisements whose `base` is `http(s)` **with a host** are offered.
  Deduped by that URL, discovery order preserved.
- `baseUrl` is the raw advertised string — never normalised, because it is what
  gets prefilled. `displayHost` keeps the advertised casing for the same reason.
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
- `clients/web/src/lib/session.ts` decides at runtime: keychain when the shell
  has one, the pre-existing `momo.web.session.v1` localStorage record otherwise.
  In keychain mode the token is in the credential store and only the non-secret
  metadata (member + `realtimeWebSocketUrl`) is in `momo.desktop.session.v1`.
  A session created before this build is migrated on first launch, and the web
  copy is deleted only after the keychain write lands.
- `getSessionStorageMode()` reports which path is in force, so a degraded run
  (Linux with no Secret Service) can be honest rather than imply a guarantee it
  is not delivering.

## Notification

Wrapped as app commands rather than the plugin's own JS bindings, so the web side
needs exactly one npm dependency (`@tauri-apps/api`) for the whole bridge.

`ensureNotificationPermission()` asks at most once per run, and is meant to be
called at the moment a notification is first worth showing — an OS permission
dialog at boot, before anyone has a reason to want notifications, is the fastest
way to earn a permanent "no". **Wiring which events notify (mention, approval
request) is the web layer's job and is not done yet** — the bridge is the seam.

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
default `momo://` handler (which the macOS client also registers):

```sh
open -a src-tauri/target/release/bundle/macos/momo-spike.app \
  "momo://join?server=http%3A%2F%2FMacBook-Pro-2.local%3A28000&code=<code>"
```

`cargo tauri dev` produces a bare binary, not a bundle, so on macOS it has no
`CFBundleURLTypes` and cannot receive `momo://` at all — deep links must be
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

- **Deep link, cold start**: app not running, `open -a … "momo://join?server=…&code=COLDSTART-1"`
  → launched, parsed, buffered (`ready=false`) for the webview to drain.
- **Deep link, running app**: `momo://join?code=WARM-2&server=…&utm=mail` → parsed
  with the parameters reversed and the unknown one ignored. `momo://not-join?…`
  dropped silently.
- **Discovery**: found the live stack — `{"baseUrl":"http://MacBook-Pro-2.local:28000",
  "displayHost":"MacBook-Pro-2.local:28000","instanceName":"momo"}`, one
  `scanning: true` event then the terminal `scanning: false`. Cross-checked
  against `dns-sd -B _momo._tcp`.
- **Keychain**: `available → true`, store → load returns the same token → clear →
  load returns null. No residue (`security find-generic-password -s app.momo.desktop`).
- **Notification**: permission `Granted`, `show → true`, banner displayed.

## Known gaps

- The **release** app loads `tauri://localhost`, so the web build's dev proxy for
  `/v1` does not exist — REST calls need a Rust HTTP command, an embedded proxy,
  or server-side CORS. The **dev** path (pointing at the proxied preview) does the
  full round-trip today. See `clients/web/README.md` findings.
- Bundle identity is still the spike's (`app.momo.spike`, product `momo-spike`).
  The `momo://` registration and the keychain item are filed under it, so renaming
  later is a migration, not a rename.
- Unsigned builds: macOS ties keychain ACLs to the binary's signature, so a
  rebuilt dev binary can re-prompt for access to an item an earlier build created.
  Signing (the 0.0.5+ certificate path) removes this.
