---
name: momo-design-taste-web
description: Anti-slop design taste for the momo web client (TS/React + Tailwind + shadcn/ui + Tauri shell). Use WHENEVER creating or modifying React components, Tailwind styles, tokens, or user-visible strings in clients/web. Web translation of momo-design-taste (macOS/SwiftUI): Dawn palette CSS tokens, fixed Tailwind scale, web AI-tell bans, mandatory four states, keyboard/focus rules, and a mechanical grep-able pre-flight. Adapted from momo-design-taste (mac) + ADR-0133 stack decision.
---

# momo Design Taste (Web / React + Tailwind + shadcn)

momo-web is the canonical UI (ADR-0133): TS + React + Vite, Tailwind + shadcn/ui(Radix), react-virtuoso, cmdk, wrapped by Tauri 2 for desktop. The bar is the same as the mac client:
**it must feel like a native-grade work tool with the information density of Slack and the calm confidence of Codex, not a marketing web app.** Landing-page patterns transplanted into the product surface are the #1 slop signature to avoid. This is the web sibling of `momo-design-taste`; the hard rules are identical in intent, translated to CSS/Tailwind/React.

## 0. Design Read (mandatory, before any code)

Output one line before writing UI code:

> Reading this as: <surface: message timeline / composer / sidebar / inbox / agent card / settings / onboarding> for <internal team users on web+Tauri>, density <N>/10, motion <M>/10.

Defaults for momo: **density 6-7** (work tool, not a landing page), **motion 2-3** (motion is feedback, never theater).

Do NOT default to: purple/blue/indigo AI gradients, glassy hero cards, three-equal-card feature rows, oversized rounded "web cards" wrapping every list row, centered empty states with illustrations, toast stacks. These are LLM defaults, not choices.

## 1. Platform constraints (web-specific, load-bearing)

- **CSP is `style-src 'self'`** (verified in current `clients/web`). No inline `style={{...}}`, no `style=` attributes, no styled-components runtime injection. Every style lives in Tailwind classes compiled to a served stylesheet or in `src/styles.css`. This is not a preference; violating it breaks rendering.
- **Self-contained assets**: system font stack only, no `fonts.googleapis.com`, no external CDN, no remote fonts/images. Same-origin only.
- **Tauri shell parity**: keyboard shortcuts, deep links, and native integrations (keychain, mDNS, updater) live in the Rust plugin layer (ADR-0133 §2), not the React tree. Do not reimplement OS behavior in JS.
- **System-first (web translation)**: reach for the shadcn/Radix primitive before a custom control (`DropdownMenu`, `Dialog`, `Popover`, `Tabs`, `Command`, `ContextMenu`, `Sheet`, `Collapsible`, `Form`). react-virtuoso for the timeline, cmdk for Cmd+K. Every custom-drawn control needs a one-line comment stating what the primitive could not do. No justification means use the primitive.

## 2. Dawn palette tokens (the only source of color)

Colors come from CSS variables, referenced through Tailwind semantic classes. **Zero raw hex / rgb() / hsl() literals in component files.** The palette is the "Dawn" identity (night to first light), calm and warm, with a single amber accent. The current v0 indigo accent (`#4f46e5`) is provisional and is replaced by amber here (indigo/purple reads as an AI-tell).

Define once in `src/styles.css` (or `@theme` for Tailwind v4):

```css
:root {
  color-scheme: light dark;

  /* surfaces (warm paper, "동튼 직후") */
  --bg:          #f7f6f3;
  --bg-raised:   #ffffff;
  --bg-sidebar:  #efece6;
  --border:      #dcd8d0;

  /* text */
  --text:        #24211c;
  --text-muted:  #77716a;

  /* single accent = 호박(amber horizon), AA on --bg */
  --accent:          #b45309;
  --accent-contrast: #ffffff;

  /* agent identity = predawn slate-blue, distinct from human accent, NOT neon AI purple */
  --agent-accent:    #4a6785;

  /* status (tokens only, never raw) */
  --danger: #b3261e;
  --ok:     #1a7f37;
  --warn:   #9a6700;

  /* radius scale (fixed, no other values) */
  --radius-sm: 6px;   /* controls: buttons, chips, inputs */
  --radius-md: 10px;  /* cards, list groups */
  --radius-lg: 14px;  /* dialogs, sheets */

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    /* surfaces (near-night sky, dark is the base tone) */
    --bg:          #17161a;
    --bg-raised:   #201f24;
    --bg-sidebar:  #1b1a1f;
    --border:      #34323b;

    --text:        #ececf1;
    --text-muted:  #9b98a3;

    --accent:          #f0a850;  /* lighter amber, AA on --bg */
    --accent-contrast: #17161a;

    --agent-accent:    #7fa0c4;

    --danger: #f2b8b5;
    --ok:     #57ab5a;
    --warn:   #d4a72c;
  }
}
```

Rules:
- **ONE accent per surface** = `--accent`. Agent identity uses `--agent-accent` on avatar/badge only, never a different bubble shape or row background tint. Status colors from `--danger/--ok/--warn` only.
- **Color Consistency Lock**: once a surface accent is set, the whole surface uses it. Sections do not invert theme. One theme per color scheme.
- **No pure `#000000` / `#ffffff` backgrounds** (except `--bg-raised` white on light, which is warm-paper white). Use the surface tokens; they adapt to scheme.
- **Real translucency via `backdrop-filter` + token overlay**, never a semi-transparent solid pretending to be glass, and never as decoration.

## 3. Tailwind scale (fixed, grep-enforced)

- **Spacing only from {4, 8, 12, 16, 24, 32}px** = Tailwind `1, 2, 3, 4, 6, 8`. `p-[13px]`, `w-[237px]`, `gap-[15px]` and other arbitrary values are violations. Configure `theme.spacing` to expose only these steps so arbitrary values stand out.
- **Radius only from the token scale** (`rounded-sm/md/lg` bound to `--radius-*`). No `rounded-[12px]`, no mixing 6/10/14 by feel.
- **Typography via semantic roles, not size inflation.** Define text roles (`text-body`, `text-timestamp`, `text-channel`, `text-mono-payload`) mapped to system text sizes. No `text-[13px]`, no `font-[...]`, no external font. Hierarchy via weight + `--text-muted`, max 2 weights per component.
- **Numbers** (counters, costs, seq, token counts) use `tabular-nums` + `font-mono` + right-align. Never animate faster than the data changes; no count-up theater.

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

- **Keyboard path for every action** (P11): cmdk Cmd+K switcher, Cmd+N, arrow navigation, unread traversal. Row-level actions live in `ContextMenu`, not always-visible button rows.
- **Focus ring is mandatory and visible.** If you set `outline-none`, you must add a `focus-visible:` ring in the same class list. Never remove focus indication without replacing it.
- **Destructive and approval actions require confirmation** (`AlertDialog`), never fire on a single unguarded click or a bare hover.
- **Hover uses subtle background change**, not scale transforms.
- **Contrast AA**: body text and interactive labels meet WCAG AA against their surface. Amber accent as text only on surfaces where it passes AA (verify both schemes). Icon-only controls carry `aria-label`.
- **Semantic HTML + roles**: real headings hierarchy, `nav/ul/li` for lists, `dl` for key-value rows, `button` for actions (never a clickable `div`).

## 7. Copy (user-visible strings)

- **Verb-first buttons** ("변경 저장", "메시지 보내기", never bare "확인"/"Submit" where a verb fits).
- **ZERO em-dashes** (`—`, `–`) in any user-visible string. Binary: one em-dash = pre-flight fail. Use commas, colons, parentheses, or line breaks.
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
| Count-up / animated number theater | Numbers change at data speed, `tabular-nums` |
| Custom titlebar breaking OS window controls | Tauri standard window chrome |

## 9. Agent-native surfaces (momo-specific)

- Agent messages share the human message anatomy (same grid, same typography); agent identity is expressed ONLY via `--agent-accent` on avatar/badge, plus "managed by {owner}" attribution. Never a different bubble shape or full-row background tint.
- Tool-call / approval / diff / cost cards are **structured, calm, dense**: title row (icon + name + status chip) then typed fields then a disclosure for raw payload. Status lifecycle chips (`queued / thinking / streaming / awaiting-approval / done / error`) use token status colors, text-first, no pulsing. Approval status maps to the real model (`pending / approved / rejected / expired / cancelled`).
- Render only server-provided public fields; tool arguments, paths, credentials, and cost internals stay opaque even behind disclosure (matches `approvalCardModel` basic-mode contract).
- Agent activity reads as "the agent did {verb} to {object} → {outcome}". Frame absence (timeout, silence, cache miss) as `stalled`, never promote it to `error` or a false story (agent-interaction-safety, ADR-0132).

## 10. Mechanical Pre-Flight Check (run before claiming done)

Run from `clients/web`. ALL must pass; any hit is a fail unless it is inside the token/theme definition (`src/styles.css`, tailwind config).

```sh
# 10.1 em-dash in any source string (user-visible), zero hits
grep -rn '—\|–' src --include='*.tsx' --include='*.ts'

# 10.2 raw color literals in components, zero hits outside styles.css/config
grep -rnE '#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(' src --include='*.tsx' \
  | grep -v 'styles.css'

# 10.3 inline styles (CSP forbids; also a slop vector), zero hits
grep -rn 'style={{\|style={' src --include='*.tsx'

# 10.4 arbitrary Tailwind values (spacing/size/color), inspect every hit
grep -rnE 'className=.*\[[0-9#]' src --include='*.tsx'

# 10.5 AI-tell gradients on product surfaces, inspect (allow only landing)
grep -rnE 'bg-gradient|from-(purple|indigo|violet|fuchsia|blue)|via-(purple|indigo|violet)' src --include='*.tsx'

# 10.6 toast stacks, inspect (prefer inline banners)
grep -rniE 'sonner|useToast|toast\(' src --include='*.tsx'

# 10.7 focus removed without replacement, every outline-none needs focus-visible nearby
grep -rn 'outline-none' src --include='*.tsx'

# 10.8 external fonts/CDN (breaks CSP + self-contained), zero hits
grep -rniE 'fonts.googleapis|cdn\.|@font-face|<link[^>]+href="http' src

# 10.9 filler-hype vocabulary in copy, zero hits
grep -rniE 'seamless|effortless|unleash|elevate|원활한|손쉽게|매끄러운' src --include='*.tsx'

# 10.10 pure black/white backgrounds, inspect
grep -rniE 'bg-black|bg-white|#000000|#ffffff' src --include='*.tsx'
```

Manual checklist:
- [ ] Design Read line was produced and the result matches it
- [ ] Light AND dark scheme checked (both render correctly, AA holds in both)
- [ ] Empty / loading / error / offline states exist for the touched surface
- [ ] All spacing ∈ {4,8,12,16,24,32}; radius from token scale only
- [ ] One accent (`--accent`); agent uses `--agent-accent`; status from tokens only
- [ ] Keyboard path exists for every new action; visible focus ring on every interactive element
- [ ] No banned Web AI-Tells (§8 table)
- [ ] Long Korean + English mixed strings do not truncate/overflow (test a 3-line Korean message)
- [ ] `prefers-reduced-motion` respected for any new animation
- [ ] No raw JSON in cards; sensitive payload fields stay opaque

## 11. Review loop

After implementation, request the `design-review` agent with screenshots (Playwright captures in both schemes). Blockers loop back automatically; only High-Priority-and-below findings go to a human. Rubric mirrors the mac skill (`references/review-rubric.md` web variant). Gate target (ADR-0133 parity): design-review Blocker 0, High 0.
