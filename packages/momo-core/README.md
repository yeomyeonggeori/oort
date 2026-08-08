# `@momo/core`

The part of oort that is the same on every screen it will ever run on.

Extracted by goal **RN-C1** under **ADR-0137 D3**. It exists for one reason: iOS
is being rewritten in React Native, and the decision logic this product has spent
months getting right — seq-ordered message merge, approval state, quota
staleness, work-session lifecycle, deep links, wire decoding — must not be
written a second time in a second language and drift.

The web client consumes it **first**, before any mobile code exists. That
ordering is the ADR's verification rule (D3): if the extraction changed
behaviour, the web client's own gates say so while there is still only one
consumer to fix.

---

## The rule

**No UI. No platform API.** Not `window`, not `document`, not `localStorage`,
not `navigator`, not a React component, not a React Native import, not
`import.meta`, not `process`. Not one line.

This is not maintained by discipline. Two mechanisms enforce it, deliberately
different:

| | what | why both |
|---|---|---|
| `npm run gate:purity` | `scripts/purity.mjs` — parses with the TypeScript compiler, checks imports, globals, file extensions, and that `package.json` declares **zero runtime dependencies** | runs with nothing installed but `typescript`; sees things a lint rule cannot (file extensions, the dependency list) |
| `npm run lint` | `no-restricted-globals` / `no-restricted-imports` in `eslint.config.js` | scope-aware (a local variable named `window` is fine, a free reference is not) and fires in the editor |

A grep would not have worked: this codebase's comments discuss `window`,
`document` and React by name constantly, so a text search either drowns in false
positives or gets tuned until it catches nothing. Both gates read the AST.

### Why this is even possible

Because the code was already written this way. The decision functions take
platform facts as **parameters** instead of reading them:
`features/notifications/model.ts` does not consult `window.focus` — it accepts
`windowFocused: boolean`. On RN, `AppState` supplies that value and nothing else
changes.

**Do not break that property.** A function that reaches for a global instead of
accepting an argument is the whole extraction unravelling.

---

## What a host must provide

Everything platform-shaped arrives through one injected port,
[`src/runtime/host.ts`](src/runtime/host.ts):

- **`apiBase()` / `absoluteApiBase()`** — which server this device talks to.
  Stored per device: `localStorage` on web, MMKV on RN.
- **`buildMode()`** — Vite's `import.meta.env.MODE` on web; `import.meta` does
  not exist under Metro/Hermes.
- **`SessionPort`** — where the refresh token lives and the in-memory access
  token beside it. Browser `localStorage`, the desktop OS keychain, or
  `react-native-keychain` on RN. **Never MMKV for the token** — MMKV's optional
  encryption needs its own key kept safely somewhere, which is the same problem
  again (ADR-0137 D7).

The **realtime transport** is the fourth adapter and its interface lives in
`src/lib/realtimeEvents.ts` as `RealtimeHandle`, next to the frame vocabulary it
hands back. The centrifuge implementation stays in the host
(`clients/web/src/lib/realtime.ts`).

The web host is a single file: [`clients/web/src/lib/coreHost.ts`](../../clients/web/src/lib/coreHost.ts),
imported first in `main.tsx`, with `coreHost.test.ts` asserting it happened.

---

## Constraints the spike paid for in real-device time

These came out of **#837** (`docs/planning/2026-08-02-rn-spike-report.md`), run
on a physical iPhone 17. They are recorded here because they are invisible from
the code and the next person will otherwise re-derive them the expensive way.

### 1. A composer's `value` must be updated **synchronously**

> Reflecting the input value asynchronously breaks Korean input.

Gate 1, case D: a single `setTimeout(() => setValue(next), 0)` was enough. The
iOS IME's composition state is severed in that tick and the jamo **stop combining
at all** — 표준 keyboard produced `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ`, 10키 produced
`ㅇ|·ㄴㄴ··|ㅇㅎ|·ㅅ·`, where the target was `안녕하세요`. Cases A/B/C (including
controlled input re-rendering a 60-item mention list on every keystroke) were all
perfect.

**So: never route the composer's value through the network, a store or a queue
and back.** Keep optimistic local state synchronous; the server round trip is a
separate path. `features/chat/composerKeys.ts` is written for that shape — keep
it.

Note also that case D reported **zero** composition-invariant violations while
being completely broken: there was nothing to roll back. "No violations" does not
mean "fine" — the primary check is always the final string.

### 2. The timeline is **not** `inverted`

Gate 5, real device: with `inverted`, a message arriving while the reader was
scrolled back moved their reading position by **46–91px**. In the forward
direction the same measurement was **0px**.

The problem was never React Native's list virtualisation — it was the `inverted`
premise inherited from other chat clients. Mattermost patched RN core
(`RCTScrollViewComponentView.mm`) to live with it; we do not have to, because we
do not need it.

### 3. Custom-scheme URLs need `react-native-url-polyfill`

Gate 2: React Native's built-in `URL` is regex-based, not WHATWG, and cannot
parse `oort://join?...` — 19/19 cases failed on it and 19/19 passed on
`react-native-url-polyfill@4.0.0`. **`deepLink.ts` itself needed no changes.**

Anything in this package that constructs `new URL(...)` — `lib/serverUrl.ts`,
`features/auth/deepLink.ts`, `features/timeline/artifacts.ts` — assumes the host
installed that polyfill before first use.

---

## What is deliberately NOT here

- **React hooks** (`useTimeline`, `useInbox`, `useWorkspace`, …). react-query is
  host wiring; RN binds the same queries to `AppState`/NetInfo (ADR-0137 D3 C군).
- **Anything DOM-shaped**: `inbox/anchor.ts`, `work/observerStream.ts`,
  `app/viewportHeight.ts`, `timeline/rowFocus.ts`.
- **Styling.** `features/common/chip.ts` is a Tailwind class string; it stays a
  web fact. Only the filter *vocabulary* (`features/common/filterTabs.ts`) is
  shared, not the control.
- **Routing paths.** `sidebar/openChannel.ts` reads a HashRouter pathname; RN
  navigation has no equivalent.
- **Transport and storage implementations.** Interfaces only — see above.

---

## Commands

```
npm run test        # vitest, node environment
npm run typecheck   # tsc --noEmit
npm run lint        # eslint, incl. the purity rules
npm run gate:purity # the standalone purity gate
```

From the repo root, `npm test` / `npm run lint` / `npm run typecheck` run the
core **and** the web client, which is the pair that has to stay green together.
