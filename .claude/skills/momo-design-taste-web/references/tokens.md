# Dawn tokens (web): implemented reference

Implementation of record: **`clients/web/src/design/tokens.css`**. This file
documents it; it does not define it. When the two disagree, the CSS wins and
this file is stale, so update both in the same commit.

Mechanical verifier: `clients/web/src/design/tokens.contrast.test.ts` (runs in
`npm test`). Every ratio quoted below is produced by that test, not estimated.

## 1. Why the values differ from the R-2 draft

The R-2 skill draft proposed a palette that was never measured. Implementing it
against the real surfaces (MOMO-597) showed the accent and three status colors
pass AA on `--bg` but fail on the sidebar and hover surfaces, which is where
half the muted text actually lands. Measured, then adjusted:

| token | R-2 draft | shipped | why |
|---|---|---|---|
| `--accent` (light) | `#b45309` | `#a54c08` | draft was 4.65:1 on `--surface` but **4.26:1 on `--surface-sidebar`**, below AA. Darkened one step: 5.34 / 4.90 / 4.51 across all surfaces. |
| `--text-muted` -> `--ink-muted` (light) | `#77716a` | `#6a655f` | draft was **4.46:1 even on `--surface`**, and 4.09:1 on the sidebar. Now 5.34 / 4.89 / 4.51. |
| `--ok` (light) | `#1a7f37` | `#187533` | draft 4.31:1 on the sidebar. Now 4.91. |
| `--warn` (light) | `#9a6700` | `#8a5c00` | draft 4.13:1 on the sidebar. Now 4.93. |
| `--bg-raised` (light) | `#ffffff` | `#fffefb` | pure white is banned by SKILL §2. Warm paper white keeps the Dawn cast. |
| `--border` | one token `#dcd8d0` | split `--line` + `--line-strong` | `#dcd8d0` is **1.32:1** on `--surface`. Fine as a separator, far below the 3:1 minimum for a control outline. Input and outline-button borders now use `--line-strong` (>= 3.0:1 everywhere). |
| dark scheme | as drafted | as drafted | `#f0a850` amber and `#7fa0c4` slate-blue measured 8.94:1 and 6.63:1. No change needed. |

Renames (semantic, so a component never reads like a raw color): `--bg` ->
`--surface`, `--text` -> `--ink`, `--text-muted` -> `--ink-muted`,
`--accent-contrast` -> `--on-accent`, `--agent-accent` -> `--agent`.

## 2. Palette

One declaration per token via CSS `light-dark()`. There is no second copy of the
palette for dark mode, so the two schemes cannot drift apart.

| token | light | dark | role |
|---|---|---|---|
| `--surface` | `#f7f6f3` | `#17161a` | app background: warm paper by day, near-night sky after dark |
| `--surface-raised` | `#fffefb` | `#201f24` | cards, dialogs, inputs |
| `--surface-sidebar` | `#efece6` | `#1b1a1f` | sidebar, rail |
| `--surface-hover` | `#e7e3db` | `#26252c` | row hover, pressed |
| `--line` | `#dcd8d0` | `#34323b` | separators, card edges (decorative, no contrast floor) |
| `--line-strong` | `#84817d` | `#6f6e73` | control outlines: input, outline button (>= 3:1) |
| `--ink` | `#24211c` | `#ececf1` | body text |
| `--ink-muted` | `#6a655f` | `#9b98a3` | timestamps, meta, secondary |
| `--accent` | `#a54c08` | `#f0a850` | **the** accent: 호박(amber horizon) |
| `--accent-soft` | `#f4e7d6` | `#33261a` | selected row, accent-tinted chip |
| `--on-accent` | `#fffefb` | `#17161a` | label on a filled accent |
| `--agent` | `#4a6785` | `#7fa0c4` | agent identity: predawn slate-blue |
| `--agent-soft` | `#e6ebf2` | `#1e2836` | agent avatar/badge backing |
| `--danger` | `#b3261e` | `#f2b8b5` | destructive, failure |
| `--on-danger` | `#fffefb` | `#17161a` | label on filled danger |
| `--ok` | `#187533` | `#57ab5a` | connected, done |
| `--warn` | `#8a5c00` | `#d4a72c` | connecting, stalled |

Tailwind reaches these as `bg-surface`, `text-ink-muted`, `border-line-strong`,
`bg-accent`, `text-agent`, and so on. Tailwind's stock palette is **cleared**
(`--color-*: initial`), so `bg-indigo-500` and friends do not compile at all.
That is the enforcement: the indigo AI-tell is unreachable, not merely
discouraged.

## 3. Measured contrast (from `tokens.contrast.test.ts`)

Worst case across every foreground x every surface, both schemes:

| scheme | worst pair | ratio | floor |
|---|---|---|---|
| light | `--ink-muted` on `--surface-hover` | **4.51:1** | 4.5 (AA) |
| dark | `--ok` on `--accent-soft` | **5.15:1** | 4.5 (AA) |
| light | `--line-strong` on `--surface-hover` | **3.03:1** | 3.0 (non-text) |
| dark | `--line-strong` on `--surface-hover` | **3.00:1** | 3.0 (non-text) |

Filled controls: `--on-accent` on `--accent` is 5.72 (light) / 8.94 (dark);
`--on-danger` on `--danger` is 6.48 / 10.55.

Body text (`--ink`) never drops below 12.4:1 in either scheme, which is the
point of a warm-paper base rather than a gray one.

The test also asserts two things that are taste, not accessibility, because
taste regresses just as quietly:

- **hue separation** between `--agent` and `--accent` is >= 90 degrees in OKLab
  (measured 159 light / 178 dark). Human and agent identity can never converge
  into the same color by a well-meant tweak.
- **the indigo/violet AI-tell band** (OKLab hue 265..330) is asserted empty for
  both `--accent` and `--agent`. Measured: accent 49/69, agent 250/251.

## 4. Non-color scales

**Spacing is a closed set.** Tailwind's dynamic multiplier is disabled
(`--spacing: initial`), so only these steps exist and an off-grid class such as
`p-5` or `py-1.5` fails to compile rather than silently rendering:

| class | px |
|---|---|
| `0` | 0 |
| `px` | 1 (hairline) |
| `1` | 4 |
| `2` | 8 |
| `3` | 12 |
| `4` | 16 |
| `6` | 24 |
| `8` | 32 |

Control heights are a separate axis from spacing: `h-control-sm` 28px,
`h-control` 32px, `h-control-lg` 40px.

Panes are a third axis. A secondary column is wider than any rhythm step, so it
gets a **name** rather than an off-grid number, and `w-[320px]` still does not
compile: `w-pane-sm` 192px (settings section nav, mention and dropdown lists),
`w-pane` / `max-h-pane` 320px (thread panel, command list), `max-w-pane-lg`
640px (agent card measure, R-1 §4). The card measure is a token for the same
reason as the others: let an agent card run the full timeline width and its
right-aligned numeric column ends up a screen away from its label, at which
point it stops reading as a card and starts reading as a banner.

Markers are a fourth axis: `w-marker` 2px, the current-workspace accent bar
(R-1 §1). The rhythm scale has no 2px step and `w-0.5` does not compile, so the
bar gets a named token instead of widening the closed set.

**Radius: three steps, nothing else.** `--radius-*: initial` clears the stock
scale first.

| class | px | use |
|---|---|---|
| `rounded-sm` | 6 | buttons, chips, inputs |
| `rounded-md` | 10 | cards, list groups |
| `rounded-lg` | 14 | dialogs, sheets |

**Text roles, not sizes.** `--text-*: initial` clears `text-sm`/`text-xs`, so a
component must name a role and cannot reach for size inflation:

| class | size | use |
|---|---|---|
| `text-timestamp` | 11px | seq, clock, counters |
| `text-meta` | 12px | secondary and meta rows |
| `text-body` | 14px | message body, controls |
| `text-title` | 16px | surface titles |
| `text-display` | 20px | at most one per surface |

Fonts are system stacks only (`--font-sans` includes `Apple SD Gothic Neo` and
`Noto Sans KR` so Korean does not fall back to a metric-mismatched face). No
webfont, no CDN: CSP forbids it and the desktop shell must render offline.

**Numbers.** `[data-numeric]` applies `font-variant-numeric: tabular-nums` in
the base layer, so counters, seq values, and costs do not jitter as they change.
Put `data-numeric` on the element rather than repeating a utility class.

## 5. Shell geometry

`app-shell` is a named utility (`grid-template-columns: var(--w-sidebar) 1fr`,
sidebar 240px) so no component needs an arbitrary `grid-cols-[240px_1fr]`, which
the pre-flight would flag. `AppShell` renders exactly two children into it, the
sidebar and `<main>`; the ⌘K switcher is a portalled dialog and stays outside
the grid. Inside the sidebar column the workspace rail is `w-8` (32px), so the
channel list keeps the remaining 208px.

`dialog-panel` is the second named geometry utility (MOMO-614): a dialog sits one
32px step below the top of the window, so its own ceiling is
`calc(100dvh - var(--spacing-8) * 2)`. The rhythm scale has no viewport-relative
step and `max-h-[calc(...)]` does not compile, so the measure gets a name for the
same reason `app-shell` does. The panel is a flex column whose middle box carries
`min-h-0 overflow-y-auto`: at 760x480 the form scrolls inside the panel while the
title and the action row stay put, and the document still does not scroll
(MOMO-610).

## 5b. Motion utilities

There is exactly one, and it is feedback rather than decoration: `caret-stream`
(R-1 §4) blinks the streaming caret with `steps(1)` so it reads as a text cursor
and not as a fade. It carries its own `prefers-reduced-motion: reduce` branch
inside the `@utility` block, so a reduced-motion viewer gets a **steady** caret
rather than none: the caret is information about a stream still being open, and
removing it would remove the information along with the motion. There is no
shimmer utility and there must not be one (SKILL §4).

## 6. Scheme selection

`color-scheme: light dark` follows the OS. `:root[data-theme="light"|"dark"]`
pins one scheme; the screenshot capture uses browser-level
`prefers-color-scheme` emulation instead, so captures exercise the same
`light-dark()` path the product uses and nothing is themed specially for the
shot.

## 7. Adding a token

1. Add it to `tokens.css` as `light-dark(<light>, <dark>)`, both schemes in one
   declaration.
2. Expose it in the `@theme inline` block so a Tailwind utility exists.
3. Add it to the relevant list in `tokens.contrast.test.ts` (`SURFACES`,
   `FOREGROUNDS`, or `CONTROL_SURFACES`) and run `npm test`. A token that no
   list mentions is unverified, which is the same as unsafe.
4. Update the table in §2 of this file.
