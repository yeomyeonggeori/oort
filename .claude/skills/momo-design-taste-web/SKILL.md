---
name: momo-design-taste-web
description: Anti-slop design taste for the oort web client (TS/React + Tailwind + shadcn/ui + Tauri shell). Use WHENEVER creating or modifying React components, Tailwind styles, tokens, or user-visible strings in clients/web or clients/desktop. The web dialect of the oort design system (docs/design-system/README.md), reached through the momo-design-taste router: Dawn palette CSS tokens, fixed Tailwind scale, web AI-tell bans, mandatory four states, keyboard/focus rules, and a mechanical grep-able pre-flight. Adapted from the retired macOS/SwiftUI taste skill + ADR-0133 stack decision.
---

# oort Design Taste (Web / React + Tailwind + shadcn)

oort web is the canonical UI (ADR-0133): TS + React + Vite, Tailwind + shadcn/ui(Radix), react-virtuoso, cmdk, wrapped by Tauri 2 for desktop. The bar is the same as the mac client:
**it must feel like a native-grade work tool with the information density of Slack and the calm confidence of Codex, not a marketing web app.** Landing-page patterns transplanted into the product surface are the #1 slop signature to avoid. This is the web dialect the `momo-design-taste` router sends web and desktop work to (the mac rulebook it was translated from retired with `clients/macOS`); the hard rules are the canonical system's, translated to CSS/Tailwind/React.

Three files carry the load, and they are checked in, not aspirational:

| what | where |
|---|---|
| token definition | `clients/web/src/design/tokens.css` (semantic) + `clients/web/src/design/themes/` (accent bindings, ADR-0174) |
| token reference + measured contrast | `references/tokens.md` |
| mechanical pre-flight | `scripts/design_preflight_web.sh` |

> **The system has a name and one canonical page: 오르트 구름 (Oort Cloud) — `docs/design-system/README.md`** (ADR-0159).
> This skill is the *web dialect*: how to write the code. The canonical page is the *system*: the token layer and its web↔phone relationships, the hierarchy rule (destructive > primary > secondary), the four states, and — most usefully — the **enforcement map**, which says for every axis what machine measures it and **what nothing measures at all**. Read its §5.3 before claiming a rule is "checked".

## 0. Design Read (mandatory, before any code)

Output one line before writing UI code:

> Reading this as: <surface: message timeline / composer / sidebar / inbox / agent card / settings / onboarding> for <internal team users on web+Tauri>, density <N>/10, motion <M>/10.

Defaults for oort: **density 6-7** (work tool, not a landing page), **motion 2-3** (motion is feedback, never theater).

Do NOT default to: purple/blue/indigo AI gradients, glassy hero cards, three-equal-card feature rows, oversized rounded "web cards" wrapping every list row, centered empty states with illustrations, toast stacks. These are LLM defaults, not choices.

## 1. Platform constraints (web-specific, load-bearing)

- **CSP: this codebase writes no inline styles.** The shipped header (`infra/prod/Caddyfile`) is `default-src 'self'; connect-src 'self' wss://{$REALTIME_DOMAIN} https://{$REALTIME_DOMAIN}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`. Read the two directives separately:
  - `style-src` carries `'unsafe-inline'`, and it is load-bearing for the VENDORED libraries that style at runtime, not for anything this codebase writes. Measured on the built bundle behind the prod header, 2026-07-26: a plain channel view carries 5 inline-style nodes (react-virtuoso's virtualized rows), and a streaming 관전 터미널 carries 40 plus 3 injected `<style>` elements, 35 of them xterm.js writing one `setAttribute("style", ...)` per truecolor cell (MOMO-619). Under a hypothetical `style-src 'self'` the terminal still streams text but loses colour, cell positioning and its own dimensions. That allowance belongs to the libraries and is not a licence for components: no inline `style={{...}}`, no `style=` attributes, no styled-components runtime injection. §10.3 still fails them, and every style this codebase authors lives in Tailwind classes compiled to a served stylesheet or in `src/design/tokens.css`. If a value must be dynamic, drive it with a `data-*` attribute and a CSS rule, or a named `@utility`. The directive can no longer be tightened without breaking the timeline and the terminal, so changing it is a review item and not a config tweak.
  - `connect-src` is the one that bites feature work: it covers this origin plus the realtime domain and nothing else, so a surface that dials a third address (a work host's own terminal endpoint, ADR-0126 D1) is refused by the browser, with **no error and no close event on the socket**. That is a deployment decision rather than a client bug, and the client's job is to name it (`observerStream.cspBlockedHost`) instead of blaming the host or hanging on a busy state.
- **Self-contained assets**: system font stack only, no `fonts.googleapis.com`, no external CDN, no remote fonts/images. Same-origin only.
- **Tauri shell parity**: keyboard shortcuts, deep links, and native integrations (keychain, mDNS, updater) live in the Rust plugin layer (ADR-0133 §2), not the React tree. Do not reimplement OS behavior in JS.
- **System-first (web translation)**: reach for the shadcn/Radix primitive before a custom control (`DropdownMenu`, `Dialog`, `Popover`, `Tabs`, `Command`, `ContextMenu`, `Sheet`, `Collapsible`, `Form`). react-virtuoso for the timeline, cmdk for Cmd+K. Every custom-drawn control needs a one-line comment stating what the primitive could not do. No justification means use the primitive.

## 2. Dawn palette tokens (the only source of color)

Full palette, measured contrast, spacing/radius/text scales, and the procedure for adding a token: **`references/tokens.md`**. Do not restate hex values anywhere else, and do not copy them into a component.

The identity is "Dawn" (night to first light): warm paper surfaces, a single amber accent (호박, the horizon at first light) as the **default** binding, and a predawn slate-blue reserved for agents. Indigo/violet is not merely discouraged: Tailwind's stock palette is cleared in `tokens.css`, so `bg-indigo-500` does not compile.

Components still consume **semantic tokens only**. A curated accent rebinds `--accent` / `--accent-soft` / `--on-accent` via `:root[data-accent=…]` in `src/design/themes/`. That directory is the only other place raw hex may live, and only as a pre-validated binding (ADR-0174 D5). Arbitrary color pickers and hex in components stay forbidden.

Rules:
- **Zero raw hex / `rgb()` / `hsl()` literals in component files.** Color reaches a component only as a token utility (`bg-surface`, `text-ink-muted`, `border-line-strong`).
- **ONE accent per surface** = `--accent`. Agent identity uses `--agent` on avatar/badge only, never a different bubble shape or row background tint. Status colors from `--danger` / `--ok` / `--warn` only.
- **Color Consistency Lock**: once a surface accent is set, the whole surface uses it. Sections do not invert theme. One theme per color scheme.
- **No pure `#000000` / `#ffffff`.** The light "paper" white is `#fffefb`. Use the surface tokens; they adapt to scheme via `light-dark()`.
- **Contrast is verified, not eyeballed.** `clients/web/src/design/tokens.contrast.test.ts` measures every foreground against every surface in both schemes (AA 4.5:1, control borders 3:1) and asserts the agent/accent hue gap and the empty indigo band. Accent bindings are measured the same way in `src/design/themes/catalog.contrast.test.ts` (adding a theme file without a passing pair fails closed). Retuning a hex without running `npm test` is not a change, it is a guess.
- **S0 and the brand lockup are outside custom accent** (ADR-0174 D4). They keep the Dawn pair.
- **Real translucency via `backdrop-filter` + token overlay**, never a semi-transparent solid pretending to be glass, and never as decoration.

## 3. Tailwind scale (fixed, compiler-enforced)

The scales are closed sets in `tokens.css`: the dynamic spacing multiplier, the stock radius scale, and the stock text sizes are all cleared. An off-grid class does not silently render at the wrong size, it fails to compile.

- **Spacing only from {4, 8, 12, 16, 24, 32}px** = Tailwind `1, 2, 3, 4, 6, 8` (plus `0` and the 1px `px` hairline). `p-5`, `py-1.5`, `p-[13px]`, `gap-[15px]` are violations. Control heights are a separate axis: `h-control-sm` / `h-control` / `h-control-lg`.
- **Radius only from the token scale**: `rounded-sm` (6, controls) / `rounded-md` (10, cards) / `rounded-lg` (14, dialogs). No `rounded-[12px]`, no mixing by feel.
- **Typography via semantic roles, not size inflation**: `text-timestamp` / `text-meta` / `text-body` / `text-title` / `text-display`. No `text-sm`, no `text-[13px]`, no external font. Hierarchy via weight + `text-ink-muted`, max 2 weights per component.
- **Numbers** (counters, costs, seq, token counts) carry `data-numeric` (tabular-nums from the base layer) plus `font-mono` and right-alignment where they form a column. Never animate faster than the data changes; no count-up theater.
- **Shell geometry** comes from named utilities (`app-shell`), not arbitrary grid values.

## 4. Motion

- Every animation is feedback for a state change (short spring/ease, <200ms typical). No perpetual or decorative loops. Streaming text gets a caret, not a shimmer skeleton. Loading uses height-preserving neutral bars, not shimmer.
- **Always guard non-trivial motion** with `@media (prefers-reduced-motion: reduce)` and/or the `useReducedMotion` hook. Floating/parallax motion is banned in the product surface (it belongs only on the landing site, one place, per alpha-site-direction).

## 5. States (mandatory, per surface)

Every surface ships **empty / loading / error / offline**:
- **empty** = an invitation to act: one line of copy + one action. Not an illustration poster, not centered art. A quiet inbox is framed as designed ("조용한 게 정상입니다"), not as failure.
- **loading** = height-preserving neutral skeleton bars (no shimmer), or an in-button spinner for actions.
- **error** = states what happened and what to do next, inline in context. Never a toast, never an apology, never vague.
- **offline** = a single inline banner (WS disconnect), cached content keeps rendering (durability layer, P15). On reconnect, show the seq recovery marker where relevant ("seq N까지 복구").

## 6. Interaction, keyboard, focus, a11y

- **Keyboard path for every action** (P11): cmdk Cmd+K switcher, Cmd+N, arrow navigation, unread traversal. Mutating row actions (고치기/지우기) live in `ContextMenu` and the overflow menu, never as always-visible buttons. Pointer rows may mount a hover/focus-within **toolbar** (`role="toolbar"`) with one-click reactions, React, Reply, and overflow. Toolbar items join the row's one roving group. The toolbar DOM is not mounted on a row that is not hovered, not focused, and has no open overlay: no `opacity-0` / `visibility` trick (that was B11 R1, reverted). Touch (`hover: none`) does not render it. Own-row body text must not intersect the toolbar (B11 R2 Blocker). See `MessageActions.tsx` and #1743.
- **Focus ring is mandatory and visible.** The house pattern is `focus-visible:focus-ring`: a 2px accent outline inset by its width (`outline-offset: -2px`). Filled accent controls additionally use `focus-ring-on-fill`. If you set `outline-none`, you must add a `focus-visible:` ring in the same class list; the pre-flight fails a naked `outline-none`.
- **Destructive and approval actions require confirmation** (`AlertDialog`), never fire on a single unguarded click or a bare hover.
- **Hover uses subtle background change** (`hover:bg-surface-hover`), not scale transforms.
- **Contrast AA**: guaranteed by the token test for token pairs. What the test cannot see is your composition: check that accent-on-accent-soft combinations you invent are in the measured table, and give icon-only controls an `aria-label`.
- **Semantic HTML + roles**: real heading hierarchy, `nav/ul/li` for lists, `dl` for key-value rows, `button` for actions (never a clickable `div`).

## 7. Copy (user-visible strings)

- **Verb-first buttons** ("변경 저장", "메시지 보내기", never bare "확인"/"Submit" where a verb fits).
- **ZERO em-dashes** (`—`, `–`) in any user-visible string. Binary: one em-dash = pre-flight fail. Use commas, colons, parentheses, or line breaks. This includes `index.html` `<title>` and Tauri window titles.
- **No filler-hype vocabulary**: "seamless / effortless / unleash / elevate / 원활한 / 손쉽게 / 매끄러운" banned in UI copy.
- Errors say what happened and the next step; they never apologize and are never vague.
- **Internal vocabulary** ("Context Packet", "Memory Plane", "Capability Cache", run IDs, seq numbers) never appears as user-facing copy outside developer/diagnostic surfaces.
- Fixtures/previews use realistic Korean+English mixed team content, never "John Doe" / "Acme" / "테스트 메시지 1".

## 8. Web AI-Tells (banned patterns)

| Banned | Instead |
|---|---|
| Purple/indigo/blue AI gradient hero or `bg-gradient` splash on product surfaces | Flat token surfaces; gradient only on the landing site, never in-app |
| Toast/snackbar stacks (`sonner`, `useToast` stacks) | Inline banners in context, or OS notifications via Tauri |
| Oversized rounded "web cards" wrapping every list row | Flat rows with separators/hover; `Card` only when elevation means grouping |
| Centered empty state with illustration | One line of copy + one action button |
| Emoji as functional icons | lucide icons, one style/weight per surface |
| Full-width filled iOS-style buttons in dialogs | Standard bordered buttons, trailing-aligned, default action emphasized |
| Raw JSON dumps in user-facing cards | Typed key-value rows (`dl`); raw payload behind a `Collapsible` disclosure |
| Decorative status dots / pulsing dots without meaning | Status indicators only when bound to real state, text-first, no pulse |
| Section-number eyebrows ("001 · SETTINGS"), uppercase-tracking micro-labels (>1 per surface) | Sentence-case plain headers |
| Pure `#000`/`#fff` backgrounds | Surface tokens that adapt to scheme |
| Shimmer skeletons | Height-preserving neutral bars |
| Count-up / animated number theater | Numbers change at data speed, `data-numeric` |
| Custom titlebar breaking OS window controls | Tauri standard window chrome |

## 9. Agent-native surfaces (oort-specific)

- Agent messages share the human message anatomy (same grid, same typography); agent identity is expressed ONLY via `--agent` on avatar/badge, plus "{owner} 님이 관리" attribution (the term the mac client already ships, `MomoAgentOwnerLabel.swift`). Never a different bubble shape or full-row background tint. The token test asserts a >= 90 degree hue gap from `--accent`, so human and agent identity cannot converge by a well-meant tweak.
- Tool-call / approval / diff / cost cards are **structured, calm, dense**: title row (icon + name + status chip) then typed fields then a disclosure for raw payload. Status lifecycle chips (`queued / thinking / streaming / awaiting-approval / done / error`) use token status colors, text-first, no pulsing. Approval status maps to the real model (`pending / approved / rejected / expired / cancelled`).
- Render only server-provided public fields; tool arguments, paths, credentials, and cost internals stay opaque even behind disclosure (matches `approvalCardModel` basic-mode contract).
- Agent activity reads as "the agent did {verb} to {object} → {outcome}". Frame absence (timeout, silence, cache miss) as `stalled`, never promote it to `error` or a false story (agent-interaction-safety, ADR-0132).

## 10. Mechanical Pre-Flight Check (run before claiming done)

```sh
scripts/design_preflight_web.sh          # exit 0 pass, 1 violation
scripts/design_preflight_web.sh --list   # every hit per category, no gating
```

Fourteen categories (ten grep + four AST/grep, see 10.1), **hard zero** (unlike the mac ratchet: `clients/web` was converted to the Dawn tokens in one pass, MOMO-597, so there is no legacy debt to grandfather):

| # | key | catches |
|---|---|---|
| 1 | `emdash` | em-dash in a string literal or JSX text (**AST**, see 10.1), and anything in `index.html` |
| 2 | `raw_color` | hex / `rgb()` / `hsl()` outside the token definition |
| 3 | `inline_style` | `style={{...}}` or `style=` (house rule, §1: the `'unsafe-inline'` in the shipped `style-src` is for xterm.js, not for components) |
| 4 | `arbitrary_tw` | `className="... [13px] ..."` arbitrary values |
| 5 | `ai_gradient` | `bg-gradient`, indigo/violet/fuchsia family |
| 6 | `toast` | `sonner` / `useToast` / `toast(` |
| 7 | `naked_focus` | `outline-none` with no `focus-visible:` in the same class list |
| 8 | `external_font` | webfont / CDN / `<link href="http` |
| 9 | `hype` | filler-hype vocabulary |
| 10 | `pure_bw` | `bg-black` / `bg-white` / `#000000` / `#ffffff` |
| 11 | `progress_word` | 「명사 + 중」 진행 낱말 (**AST**, #1511) |
| 12 | `latin_particle` | 라틴 낱말과 조사 사이 공백 (**AST**, #1511) |
| 13 | `raw_motion` | 사다리 밖 `\d+ms` · `duration-[0-9]+` (ADR-0179 D10; 온보딩 블록·`motion.css`·`motion.ts` allowlist) |
| 14 | `motion_lib_scope` | `import … from "motion/react"` 허용 3파일 외 hard-zero (ADR-0179 D8 / UX-R1b: QuickSwitcher · ThreadPanel · Sidebar) |

`src/design/tokens.css`, `tokens.contrast.test.ts`, and `src/design/themes/` are excluded (defining, measuring, and rebinding raw values is their job). The themes directory is **pre-validated bindings only**, not a general raw-color exemption: a hex in a component is still a fail. A deliberate, reviewed exception is marked with the comment marker `design-preflight-allow` and justified in the PR body — on the offending line, or (for the two AST categories) in the leading comment of the field, attribute or `throw` that owns the string.

### 10.1 The AST stage: core, and the web `emdash` category (issue #1141)

The fourteen categories above scan `clients/web/src` only — but a large share of what this client puts on screen is not there. It lives in `packages/momo-core`, and both TS clients render it verbatim. That gap is what carried em-dashes to the edge of a release in #1138 B2.

So the same command runs a second stage over the core. The core is pure TS with no markup, which means there is no syntactic marker separating "text that gets rendered" from "prose written for a reader" (comments, docstrings, test names) — line-based grep does not survive there. The separation rule is therefore an AST one, held with its evidence in `scripts/design_preflight_core.mjs`:

- only **string-literal nodes** in shipped code are checked; the parser never hands a comment to the scan, so "how do I recognise a comment" stops being a question
- `*.test.ts` is excluded whole: a test quotes the surface, it does not produce it (measured — 70 of 72 core em-dash hits were `describe`/`it` names)
- categories are `emdash`, `raw_color`, `hype`. The other seven are markup/CSS checks and the core cannot hold markup (`packages/momo-core/scripts/purity.mjs` rejects `.tsx`/`.css` outright)
- the same `design-preflight-allow` marker applies, and may sit either on the literal's own line or in the leading comment of the field it belongs to

Core is **hard zero** as well, with no ratchet file: applying the separation rule dropped #1141's measured backlog from em-dash 73 / raw_color 47 to em-dash 2 / raw_color 0, and both survivors are strings their own docstrings describe as never rendered.

**The web `emdash` category uses the same scanner** (`scripts/design_preflight_web_strings.mjs`; the rule itself lives once, in `scripts/design_preflight_ast.mjs`). It was line-based until #1141, and its 12-hit backlog turned out to be 10 `describe`/`it` names, 1 JSX comment, and 1 developer-facing `throw` — 11 of 12 were false positives that the AST simply does not see. Moving closed a miss at the same time: web text is often written **without quotes**, between tags (`<p>… — …</p>`), which the quoted-literal grep had never once looked at. JSX text is a node, a JSX comment is not.

The other ten grep categories stay line-based on purpose. They ask about class names, CSS and markup — questions a string-literal node cannot answer — and `raw_color` has to read `.css`, where there is no TS AST at all.

```sh
scripts/design_preflight_web.sh --selftest   # all three discriminators, as cases
npm run gate:copy                            # the core stage alone
```

Both stages are gated rather than remembered: `scripts/verify_merge_tree.sh` runs the copy scan as a lane on the **merge result**, and `scripts/local_gate.sh --profile web` runs the whole pre-flight.

Two more mechanical checks that are not grep:

```sh
cd clients/web && npm run lint    # eslint also bans JSX style= and hex literals
cd clients/web && npm test        # tokens.contrast.test.ts measures AA in both schemes
```

Manual checklist (nothing here is grep-able, so it is on you):
- [ ] Design Read line was produced and the result matches it
- [ ] Light AND dark scheme checked (`npm run capture:design` renders both)
- [ ] Empty / loading / error / offline states exist for the touched surface
- [ ] Keyboard path exists for every new action; visible focus ring on every interactive element
- [ ] No banned Web AI-Tells (§8 table)
- [ ] Long Korean + English mixed strings do not truncate/overflow (test a 3-line Korean message)
- [ ] `prefers-reduced-motion` respected for any new animation
- [ ] No raw JSON in cards; sensitive payload fields stay opaque

## 11. Review loop

Capture both schemes, then hand off:

```sh
cd clients/web && npm run build && npm run capture:design   # -> artifacts/design/*.png
```

The capture mocks `/v1` with realistic Korean+English team fixtures, emulates `prefers-color-scheme` at the browser level (so it exercises the same `light-dark()` path the product uses), and shoots login / chat shell / composer focus / dense timeline in light and dark.

Then request the `design-review` agent (`.claude/agents/design-review.md`) with those screenshots attached. Blockers loop back automatically; only High-Priority-and-below findings go to a human. Rubric: `.claude/skills/momo-design-taste/references/review-rubric.md` — it is written for this surface directly now (#1254), so the two substitutions this section used to describe are the rubric's phases as written rather than translations you apply while reading: phase 2 is viewport behavior (1280 and 900 wide, sidebar collapsed, long channel names) and phase 4 is keyboard-only completion with a visible focus ring at every stop plus `aria-label` on icon-only controls.

Gate target (ADR-0133 parity): design-review Blocker 0, High 0.
