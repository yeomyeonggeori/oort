# momo desktop — MOMO-595 P0 (ADR-0133)

Tauri 2 shell that wraps the **exact `clients/web-spike` bundle** — no forked UI.
Proves web/desktop run one codebase (plan §1). **Spike quality, not production.**

Native integrations (deep-link, mDNS, keychain, notification, updater) are
deliberately **not** here — they are P2 (migration plan §2 B-group). This shell is
core-only: it opens a window and loads the web bundle.

## Layout

```
src-tauri/
  Cargo.toml          # momo-desktop (tauri 2, release: LTO + strip + opt-level=s)
  tauri.conf.json     # devUrl → web-spike dev; frontendDist → web-spike/dist
  src/main.rs         # thin entry → lib.rs run()
  src/lib.rs          # tauri::Builder::default().run(...)  (no plugins yet)
  capabilities/       # core:default only
  icons/              # generated via `cargo tauri icon app-icon.png`
```

## Run

Normal dev (spawns the web-spike Vite dev server on 5173, then opens the window):

```sh
cd clients/desktop
cargo tauri dev
```

For the spike round-trip we pointed the shell at the already-running preview so the
desktop app got the same-origin proxy + whitelisted WS origin (5173 was held by a
sibling worktree on IPv6, so preview bound IPv4 `127.0.0.1:5173`):

```sh
# web-spike preview already up on http://127.0.0.1:5173
cargo tauri dev --config '{"build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:5173"}}'
```

Release app (self-contained, loads bundled dist):

```sh
cargo tauri build --bundles app
open src-tauri/target/release/bundle/macos/momo-spike.app
```

## Measured (2026-07-25, mac, release build)

- **Same code proof**: the Tauri window (title "momo — spike (Tauri)") renders the
  identical login/chat UI as the browser from the same bundle.
- **Cold start**: 537 ms from launch to WebKit content process (< 2 s gate).
- **Idle memory**: ~196 MB total (main 98.8 + WebContent 48.7 + GPU 33.0 +
  Networking 15.4 MB) — under the 400 MB gate. Debug build ~230 MB.
- Compile: debug 34 s, release (LTO) 53 s.

## Known gap for P2

The **release** app loads `tauri://localhost`, so the web build's dev proxy for
`/v1` does not exist — REST calls need a Rust HTTP command, an embedded proxy, or
server-side CORS. The **dev** path (pointing at the proxied preview) does the full
round-trip today. See `clients/web-spike/README.md` findings.
