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
| `--scrim` | `rgb(36 33 28 / 0.24)` | `rgb(9 8 11 / 0.62)` | the layer under a dialog or the ⌘K palette |

`--scrim` is the one token that is not opaque, and the only one whose two
schemes are not the same color at different lightness. It exists because a
scrim is a **direction**, not a color: it must darken whatever it covers so the
panel above it comes forward. Painting it as `--ink` at 20% looked right in
light and inverted in dark, where `--ink` is nearly white (`#ececf1`): the
overlay brightened the app to `rgb(74 73 78)` while the panel stayed
`--surface-raised` `#201f24`, so the focused panel was **darker** than its
scrimmed surroundings and the dialog read as receding (MOMO-614 R1). The alphas
differ per scheme for the same reason: pressing warm paper down 24% buys the
separation that near-night sky only gets at 62%.

Both values are measured, not chosen by eye. `tokens.contrast.test.ts`
composites the scrim over every surface with sRGB source-over blending and
asserts two things in both schemes: the result is at most 0.7x the surface
luminance (it darkens), and `--surface-raised` stays brighter than anything the
scrim covers (the panel comes forward).

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
`w-pane` / `max-h-pane` 320px (thread panel, command list), `max-w-pane-md`
512px (the overlay measure: dialog panel and ⌘K palette), `max-w-pane-lg` 640px
(agent card measure, R-1 §4). The card measure is a token for the same reason as
the others: let an agent card run the full timeline width and its right-aligned
numeric column ends up a screen away from its label, at which point it stops
reading as a card and starts reading as a banner.

`pane-md` was added last (MOMO-614 R2) because width was the one axis where a
new surface could still take an unnamed dimension. The dialog and the palette
both sat on Tailwind's stock `max-w-lg`, the same 512px wearing no name, so the
token file had never heard of the measure the two overlays share. They alternate
at the same anchor, so it is one measure and it gets one name.

Body caps are a fifth axis: `max-h-diff-body` 400px (MOMO-620), the height a
diff scrolls inside its card. It is not a pane (a pane is a width) and the rhythm
scale has no step near 400, so the measure gets a name rather than
`max-h-[400px]`. The number is the mac diff card's cap, so the same change reads
at the same size on both clients. It is a MAXIMUM, not a fixed height: a short
diff hugs its content, which is the empty-band regression the mac card had to
fix separately (MOMO-518 R2 H1) and CSS gets for free.

`h-terminal-body` 320px (MOMO-619, the read-only 관전 terminal) is the second
body cap and the one place a cap is a FIXED height rather than a maximum: a
terminal is measured in rows (320px is 20 rows at the 12px monospace role), and
xterm sizes its own viewport from the box it is handed, so a box that hugged its
content would report zero rows before the first byte arrived. Measured inside the
320px work pane that is 37 columns; below 900px, where the pane takes the whole
chat surface, it is about 95, which is the width host output is written for.

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

A role and a color share the `text-` prefix but are **different axes**, and the
class merge has to be told so. `cn()` (`src/design/lib/cn.ts`) extends
tailwind-merge with the five roles as its `font-size` group; without that,
tailwind-merge's font-size validator rejects the role names, both axes collapse
into `text-color`, and a class list naming a role and a color keeps only the
last one. That is not hypothetical: it shipped the dialog title at 14px next to
its own 14px description, and it painted every filled `size="sm"` button label
in `--ink` instead of `--on-accent` (2.78:1 light, 1.71:1 dark). Adding a sixth
role means adding it to that list too, and `cn.test.ts` is the check.

Fonts are system stacks only (`--font-sans` includes `Apple SD Gothic Neo` and
`Noto Sans KR` so Korean does not fall back to a metric-mismatched face). No
webfont, no CDN: CSP forbids it and the desktop shell must render offline.

**Numbers.** `[data-numeric]` applies `font-variant-numeric: tabular-nums` in
the base layer, so counters, seq values, costs, and dates/clocks do not jitter
as they change or fail to line up down a column. Put `data-numeric` on the
element rather than repeating a utility class.

It marks **figures**, not every value in a figure-shaped list. Korean prose set
in `font-mono` with tabular-nums renders with visibly stretched gaps between
syllables ("워크스페이스  전체"), so a key-value list that mixes the two
(사용량 > 예산: 사용 / 예약 / 한도 versus 적용 범위) tags the figures and leaves
the phrase in the sans stack. A component that renders both takes a flag
(`numeric?: boolean`) instead of forcing one answer on every row.

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

## 5a. Bars

`progress-bar` styles a native `<progress>` (CSP `style-src 'self'` rules out a
div with a computed width, so the length has to come from `value`/`max`). Its
fill defaults to `--accent`, and `data-tone` on the element selects a different
one, because a bar carries two unrelated meanings in this client:

| `data-tone` | fill | used for |
|---|---|---|
| (absent) | `--accent` | determinate progress (설정 > 업데이트) |
| `neutral` | `--line-strong` | a share of the largest row (사용량 > 모델별/에이전트별) |
| `ok` | `--ok` | 예산 한도 안 |
| `warn` | `--warn` | 예산 소프트 한도 |
| `danger` | `--danger` | 예산 하드 한도 |

A state bar takes the same token as the status chip next to it, **in every
state**. A full bar in the accent colour beside a red "한도 도달" chip reads as
a finished download, which is the opposite of what it means; an amber bar beside
a green "한도 안" chip is the same mistake in the state that is on screen most
of the time, so `ok` is a listed tone rather than a fall-through to the default.

A share bar is a comparison device, so its **track** is the same length in every
row of the list: the length carries the meaning, and a track that shortens
because the metadata beside it grew a digit is a rescaled axis per row. Give the
bar its own line at the row's full width, or fix the width of whatever sits
beside it.

## 5b. Motion utilities

There is exactly one, and it is feedback rather than decoration: `caret-stream`
(R-1 §4) blinks the streaming caret with `steps(1)` so it reads as a text cursor
and not as a fade. It carries its own `prefers-reduced-motion: reduce` branch
inside the `@utility` block, so a reduced-motion viewer gets a **steady** caret
rather than none: the caret is information about a stream still being open, and
removing it would remove the information along with the motion. There is no
shimmer utility and there must not be one (SKILL §4).

`spinner-busy` (MOMO-614) is the second, and it follows the same rule for the
same reason: a submit that is in flight shows a spinner **inside the button**
(R-1 §5 "연결 검증 중 인라인 스피너(버튼 내부), 폼은 락"), and under
`prefers-reduced-motion: reduce` it slows to `steps(8)` rather than stopping,
because the rotation is the information that the request is still open. Note
that a busy button is not a disabled one: `disabled:opacity-50` would drop the
in-flight label to 2.2:1 exactly when it is the only progress signal, so a busy
control keeps full contrast and carries `aria-busy`, while a control that
genuinely cannot act (offline) is really `disabled` and says why.

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
