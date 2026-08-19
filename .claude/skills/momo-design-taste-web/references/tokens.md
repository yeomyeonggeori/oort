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
| `--accent-soft` | `#f4e7d6` | `#33261a` | selected row (sidebar, work console, ⌘K) |
| `--on-accent` | `#fffefb` | `#17161a` | label on a filled accent |
| `--agent` | `#4a6785` | `#7fa0c4` | agent identity: predawn slate-blue |
| `--agent-soft` | `#e6ebf2` | `#1e2836` | agent avatar/badge backing |
| `--muted-soft` | `#f3efe8` | `#302e36` | **chip vessel**, tone-free: the pale fill a status chip stands in (§2a) |
| `--danger` | `#b3261e` | `#ff796b` | risk **tone**: destructive/failure text, chips, dots, bars |
| `--danger-fill` | `#8c393d` | `#dc817e` | destructive button **fill** (never the tone above: §3a table B) |
| `--on-danger-fill` | `#fffefb` | `#17161a` | label on a destructive fill |
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

## 2a. A chip vessel is never an interaction state (#1515)

**A state switches on and off; a vessel is always there. Share one value between
them and the vessel goes dark exactly while the state is on.** The lifecycle chip
was built that way: its fill was `--surface-hover`, which is also what a list row
wears on hover and when expanded, so the chip lost its container **only on the row
the reader was pointing at** (measured 1.00:1). A vessel that disappears while it
is being read is worse than no vessel.

So the two axes have separate names, and the split is mechanical:

| axis | tokens | behaviour |
|---|---|---|
| interaction state | `--surface-hover`, `--accent-soft` | hovered row, selected row. **Toggles** |
| chip vessel | `--muted-soft` | the pale fill a chip stands in. **Always on** |

**"Just pick another gray" is arithmetic, not taste.** In light, `--ink-muted`
needs a background luminance of at least 0.769 to hold AA, and `--surface-hover`
sits at 0.7704 — already on the floor. The band a chip vessel can occupy is
therefore [0.769, 0.9911 (paper)], five surfaces already divide it, and **the best
worst-case separation a sixth neutral can reach is 1.06:1**. Luminance runs out, so
the second ruler is the OKLab distance §3a already uses for the risk hierarchy. A
vessel survives only if it clears **both**: contrast >= 1.05 **and** OKLab distance
>= 0.02. Either alone lets "passes the ratio, reads as the same gray" through.

Measured (`--muted-soft` vs every row background it can stand on, both schemes):
light `--surface` 1.061 / 0.0207 · `--surface-hover` 1.117 / 0.0366 ·
`--accent-soft` 1.062 / 0.0256; dark 1.346 / 0.1036 · 1.135 / 0.0380 ·
1.095 / 0.0470. Before the fix the worst pair was 1.000 / 0.0000.

The surfaces a chip may stand on are a **closed table** (`CHIP_ROW_SURFACES`),
the same discipline as `CONTROL_SURFACES`: put a chip on a new surface and the
list has to grow, or the defect goes quiet again.

And the vessel carries no tone — all six lifecycle cells share one fill.
**Colour is earned by measurement, not by naming**: the ledger chip only says what
the ledger calls the session, so the tone stays in the ink. The chip that carries a
measurement is the one that gets a tone-tinted vessel (#1516).

## 3. Measured contrast (from `tokens.contrast.test.ts`)

Worst case across every foreground x every surface, both schemes:

| scheme | worst pair | ratio | floor |
|---|---|---|---|
| light | `--ink-muted` on `--surface-hover` | **4.51:1** | 4.5 (AA) |
| dark | `--ok` on `--accent-soft` | **5.15:1** | 4.5 (AA) |
| light | `--line-strong` on `--surface-hover` | **3.03:1** | 3.0 (non-text) |
| dark | `--line-strong` on `--surface-hover` | **3.00:1** | 3.0 (non-text) |

Filled controls: `--on-accent` on `--accent` is 5.72 (light) / 8.94 (dark);
`--on-danger-fill` on `--danger-fill` is 7.52 / 6.42. The destructive fill is a
token of its own, not `--danger` painted as a background: see §3a table B.

Body text (`--ink`) never drops below 12.4:1 in either scheme, which is the
point of a warm-paper base rather than a gray one.

The test also asserts two things that are taste, not accessibility, because
taste regresses just as quietly:

- **hue separation** between `--agent` and `--accent` is >= 90 degrees in OKLab
  (measured 159 light / 178 dark). Human and agent identity can never converge
  into the same color by a well-meant tweak.
- **the indigo/violet AI-tell band** (OKLab hue 265..330) is asserted empty for
  both `--accent` and `--agent`. Measured: accent 49/69, agent 250/251.

### 3a. Risk hierarchy: `--danger` > `--warn` > `--ink-muted`

The status tokens carry an **order**, and it is measured (MOMO-641). Where two
of them stand on one surface, the more dangerous one has to arrive at the eye
first, in both schemes.

**The ruler is OKLab chroma, not contrast.** Contrast stops discriminating once
every token clears AA by a wide margin, and it actively lies at that point: the
dark `--danger` that shipped until MOMO-641 measured **10.55:1** on `--surface`
against `--warn`'s 8.03:1 and still read as the quieter of the two, because it
was a pale pink (C 0.068) next to a saturated yellow (C 0.141). Light had the
order right all along for the same reason (0.178 > 0.108 > 0.011), which is why
the inversion only ever showed after dark. Measured now:

| scheme | `--danger` | `--warn` | `--ink-muted` | danger / warn |
|---|---|---|---|---|
| light | 0.178 | 0.108 | 0.011 | 1.65x |
| dark | 0.166 | 0.141 | 0.016 | 1.18x |

The test asserts the ratios (>= 1.15x and >= 2x), not a bare `>`, so a token
that merely ties cannot pass; the old dark danger sat at 0.48x.

**Contrast stays as the floor, and it is a floor with teeth**: `--danger`
outreads `--ink-muted` on every surface in both schemes, so a louder red can
never be bought by making it a dimmer one. What it may NOT be asked to do is
outread `--warn` in dark: sRGB has no red that is both more colorful than
`#d4a72c` and as luminous, so requiring both would have made the order
unreachable rather than merely unmet. Dark danger now measures 5.72:1 at its
worst surface (`--accent-soft`), above the AA floor and above muted's 5.17.

**The ruler measures two different classes of surface, and each has its own
order.** Naming only the first is how MOMO-641's fix produced MOMO-642 R1 H-2:
the tables below are the complete list, and a surface that is in neither is a
surface the ruler has not been extended to yet.

**Table A — risk tones competing with each other.** Foreground marks (text,
chips, dots) plus the bar fills that are themselves a risk read. Order:
`--danger` > `--warn` > `--ink-muted`.

| surface | file |
|---|---|
| app consent dialog scope badges | `features/plugins/PluginSection.tsx` |
| `ToolRow` chips, 설정 > 앱 | `features/plugins/PluginSection.tsx` |
| quota chips, 설정 > 사용량 | `features/settings/SettingsFields.tsx` |
| quota bars (`progress-bar[data-tone]`) | `design/tokens.css` |
| 상태 lines, AI 연결 체인 | `features/settings/` |
| workspace rail connection dot (`bg-danger`) | `features/sidebar/WorkspaceRail.tsx` |

A bar is in table A and not table B because a bar competes with the other bars
beside it, which are all risk reads. It never stands next to the primary action.

**Table B — action fills competing with the primary action.** Every filled
button, i.e. every `<Button variant="default">` against every
`<Button variant="destructive">`. Order: `--accent` > `--danger-fill`. A
destructive secondary may not outrank the action the reader came for.

| surface | file |
|---|---|
| 설정 > 앱 상세 행: `설치 해제` beside `내 사용 허용` / `권한 추가` | `features/plugins/PluginSection.tsx` |
| 앱 설치 해제 확인 | `features/plugins/PluginSection.tsx` |
| 에이전트 `메모리 무효화` 확인 | `features/agentHub/AgentHubRoute.tsx` |
| 작업 세션 `종료 확정` | `features/work/WorkSessionDetail.tsx` |
| 관전 `관전 닫기` | `features/work/ObserverTerminal.tsx` |
| 설정 2단 확인 (`ConfirmInline`) | `features/settings/SettingsFields.tsx` |
| 승인 카드 `승인 확정` / `거부 확정` (one button, both variants) | `features/timeline/AgentCard.tsx` |

Only the first row puts the two fills on screen together today; the rest are the
same variant and would invert the moment they did. Measured:

| scheme | `--accent` | `--danger-fill` | accent / fill | before (`--danger` as fill) |
|---|---|---|---|---|
| light | 0.136 | 0.113 | 1.20x | 0.178 = **1.31x the wrong way** |
| dark | 0.134 | 0.113 | 1.18x | 0.166 = **1.24x the wrong way** |

**Why two tokens and not one retune.** In dark, table A needs the danger tone to
clear `--warn` (C 0.141) by 1.15x, so C >= 0.162; table B needs it to sit under
`--accent` (C 0.134), so C <= 0.116. The interval is empty. No single red can
hold both orders, so the tone that *states* risk and the fill that *executes* it
have separate names. Light would have admitted a compromise value; it uses the
same split, because one surface class per token beats two schemes with different
structures.

**Quieter, not merged.** Dropping the fill's chroma moves it toward the accent
along the very axis the order is read on, so the split is measured a second way:
OKLab deltaE between the two fills is 0.092 (light) / 0.131 (dark), *wider* than
the 0.073 / 0.122 the two had before. The fill also stays inside the danger hue
family (gap to `--danger` 9 / 6 degrees, asserted <= 15) and at least 2x as
colorful as `--ink-muted`, so "quieter" can never decay into "neutral" or into
"some other color that happens to pass".

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
body cap. A terminal is measured in rows and xterm sizes its own viewport from
the box it is handed, so this is a FIXED height while the stream is alive:
measured 2026-07-26 the cell is 14px, so 320px draws 22 rows, the smallest
window in which a command and the output it produced are visible together.

Three corrections from the MOMO-619 R1 review, the first two the same bug.
`FitAddon` measures its parent with `getComputedStyle().height`, which on a
`box-sizing: border-box` element resolves to the BORDER box. With `p-2` and a
hairline on the mount every fit proposed one row and two columns more than the
box could show, and against a content height the box grew about twelve rows per
frame without stopping. **The mount carries no padding and no border**; the
frame around it does. Any surface handing a box to a self-sizing library
inherits that rule.

- A DEAD stream hugs its output instead of holding the cap. A host that closed
  after one line left a 300px empty band (R1 M7, the same regression the mac
  diff card fixed in MOMO-518 R2 H1): the failed body resizes the terminal to
  the rows it actually used and drops the fixed height. Measured: 320px/22 rows
  live becomes 42px/3 rows for a two line transcript, and back on reconnect.
- Inside the 320px work pane the terminal is **35 columns** (the review's 37
  counted the two clipped ones). Host output is written for 80, so the surface
  says so and offers 넓게 보기: `work-pane[data-wide]` is the same full-surface
  geometry the media query already applied below 900px, available at any width,
  and at 1280 it makes the pane 1040px and the terminal 120 columns. Both widen
  controls carry `pane-wide-toggle`, which hides them below 900px where the pane
  is already the whole surface (79 columns at 880): a control whose only effect
  has already happened is not a control.

`min-w-action` 144px (MOMO-642) is the last width name: the minimum a dialog's
primary button holds. It exists because a button that states the decision state
in its LABEL ("권한을 하나 이상 선택" -> "선택한 권한 허용") changes width when
that state changes, and a trailing-aligned footer then slides its sibling 24px
sideways under the pointer on every checkbox toggle. Pinning a minimum wide
enough for the longest label (measured 127px) leaves only the text inside the
button moving. It is a MINIMUM: a footer whose labels outgrow it still fits them.

`min-w-action-sm` 96px (MOMO-676) is the same rule at the other end, and the two
names together encode it: **one footer, one width**, measured from the longest
label THAT footer can show. Borrowing the other dialog's number is what the
second name prevents. 144px beside a 47px 취소 made the 설치 해제 confirmation a
3:1 footer measured off a label that dialog never renders. Measured in Chromium
against the built CSS at `size="sm"`: 취소 47px, 설치 해제 69px, and the busy
"변경 중" with its spinner 82px, so 96px holds every label with 14px to spare and
stands the pair at equal width. Both buttons in a footer carry the minimum, which
is the system-down form: emphasis belongs to the fill, never to the width.

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

**Korean prose wraps at word boundaries, not syllables** (MOMO-676 M-5).
CSS `word-break: normal` treats every Hangul syllable as a break opportunity, so
"변경할 수 없습니다" splits mid-word wherever the line happens to end, and a
narrow measure (a banner beside its 오류 닫기 button, a dialog at 760px) reaches
that state on nearly every line. `break-keep` (`word-break: keep-all`) is the
fix, and it is applied to the ROOT of a prose surface, never globally: the
property inherits, ASCII is unaffected by it (`keep-all` only forbids breaks
between CJK), and identifier children (`break-all` on scope ids, URLs, egress
domains) override it in the cascade. Two constraints go with it. It must not
land on the same element as `break-words` — tailwind-merge files both under one
`break` group and silently keeps the last one, dropping the
`overflow-wrap: break-word` that catches an unbreakable run — so the pair lives
on parent and child. And it is a prose rule: code, ids, and `data-numeric`
columns are not prose and do not get it.

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

It carries three declarations that make it the window rather than a document,
and the third is the one that is easy to delete as decoration. `minmax(0, 1fr)`
sizes the row from a definite height instead of from its content; `overflow:
clip` is the hard boundary (`clip`, not `hidden`: a hidden box is still a scroll
container, so focusing something below the fold would scroll the sidebar away
with no scrollbar to bring it back); and **`position: relative`** makes the box
the containing block for what it promises to clip. Overflow clipping does not
apply to an absolutely positioned descendant whose containing block is an
ancestor of the clipping box, and a static grid is nobody's containing block, so
every `sr-only` live region in the shell (`position: absolute`) was laid out
against the initial containing block. Harmless while those positions sat inside
the viewport, and a document 222px taller than the window the moment a panel grew
enough to push one below the fold: measured on 설정 > 사용량 at 760x480 while
adding 구독 잔여량 (MOMO-628), where `gate:shell` caught it as the MOMO-610
regression it was written for. Any box that promises to clip needs all three.

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
| `accent` | `--accent` | 구독 잔여량 게이지, 평시 (사용량 > 구독 잔여량) |
| `neutral` | `--line-strong` | a share of the largest row (사용량 > 모델별/에이전트별), and a 잔여량 게이지 too old to be a live measure |
| `ok` | `--ok` | 예산 한도 안 |
| `warn` | `--warn` | 예산 소프트 한도, 잔여량 주의 |
| `danger` | `--danger` | 예산 하드 한도, 잔여량 임박 |

A state bar takes the same token as the status chip next to it, **in every
state**. A full bar in the accent colour beside a red "한도 도달" chip reads as
a finished download, which is the opposite of what it means; an amber bar beside
a green "한도 안" chip is the same mistake in the state that is on screen most
of the time, so `ok` is a listed tone rather than a fall-through to the default.

**Where a block draws MANY bars, the calm state gets no status token at all**
(사용량 > 구독 잔여량, MOMO-628). The rule above was written for 예산, which is
one bar; this block draws up to two per provider, and a column of 여유 chips over
green bars is a status board reporting that nothing is happening. So the calm
gauge gets no chip, and its bar takes `accent` rather than a status colour. The
invariant §5a protects is intact, because the chip and the bar are still driven
by one value and status colour still only ever means "look at this one".

`accent` is written down rather than left to fall through, for the reason the
`ok` row exists: the fall-through is invisible until it is wrong. It also has to
be `accent` and not `neutral`. `neutral` is what the share bars in the same panel
draw, and the two fill in **opposite directions**: a full share bar is the
largest spender, a full remaining bar is a subscription barely touched. Two bars
that mean opposite things must not be the same pixels (MOMO-628 R1 M10). What
`neutral` means on a 잔여량 게이지 instead is "this is not a live measure": a
reading past its freshness deadline, or one whose window has already reset,
keeps rendering with no status colour and a grey bar.

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
