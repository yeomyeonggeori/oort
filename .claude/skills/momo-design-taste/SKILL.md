---
name: momo-design-taste
description: Anti-slop design taste for the oort macOS SwiftUI client. Use WHENEVER creating or modifying SwiftUI views, components, themes, or user-visible strings in clients/macOS or clients/Core. Encodes MomoDS token rules, native-macOS AI-tells bans, and a mechanical pre-flight check. Adapted from Leonxlnx/taste-skill (MIT) + anthropics frontend-design + Apple HIG for native macOS product UI.
---

# oort Design Taste (macOS / SwiftUI)

oort is a native macOS messenger where AI agents are first-class members. The bar:
**it must feel like software Apple could have shipped, with the information density of Slack and the calm confidence of Codex.** Web-app patterns transplanted into a Mac window are the #1 slop signature to avoid.

## 0. Design Read (mandatory, before any code)

Output one line before writing UI code:

> Reading this as: <surface: message timeline / composer / sidebar / approval inbox / settings / onboarding> for <internal team users on macOS>, HIG-first, density <N>/10, motion <M>/10.

Defaults for oort: **density 6–7** (Mac users expect information density; this is a work tool, not a landing page), **motion 2–3** (motion is feedback, never theater).

Do NOT default to: purple/blue AI gradients, glassy hero cards, three-equal-card rows, oversized rounded-rect "web cards" inside lists, centered empty states with illustrations. These are LLM defaults, not choices.

## 1. System-first rule (inversion of web taste-skill)

Reach for the **native control first**: `List`, `Table`, `NavigationSplitView`, `.searchable`, `Menu`, `.contextMenu`, `Form`, `LabeledContent`, `Toolbar`, `.popover`, `Settings` scene.
Every custom-drawn control requires a one-line justification comment stating what the system control could not do. No justification → use the system control.

## 2. Hard rules (binary, not "sparingly")

**Color**
- Semantic colors only in view code: `Color.primary/.secondary`, `.tint`, material backgrounds, or MomoDS semantic tokens (`references/tokens.md`). Zero raw `Color(red:green:blue:)` or hex literals in views.
- ONE accent per surface = the app tint. Agent identity uses `agent.accent` token only. Status colors (danger/warning/success) come from tokens only.
- Color Consistency Lock: once a surface's accent is set, the whole surface uses it. Sections do not invert theme. The app has ONE theme per color scheme.
- Real materials over fake translucency: `.ultraThinMaterial`/`.regularMaterial`/`NSVisualEffectView` — never a semi-transparent fill pretending to be glass.

**Typography**
- SF Pro via semantic text styles only: `.font(.body)`, `.title3`, `.caption` or MomoDS text roles (`.messageBody`, `.timestamp`, `.channelName`, `.agentPayloadMono`). Zero `Font.custom` and zero fixed `.font(.system(size: N))` in view code (breaks Dynamic Type).
- Hierarchy via weight and secondary color, not size inflation. Max 2 weights per component.
- Counters/costs/seq numbers use `.monospacedDigit()`.

**Spacing & shape**
- Spacing values come from the scale: 4 / 8 / 12 / 16 / 24 / 32. `.padding(13)`, `.frame(width: 237)` and other magic numbers are violations.
- Shape Consistency Lock: ONE corner-radius scale app-wide (tokens define it). No mixing 6/10/14 by feel.

**Motion**
- Every animation is feedback for a state change (`.snappy`, `.spring` short). No perpetual/decorative loops. Always guard long animations with `accessibilityReduceMotion`.

**States (mandatory, per surface)**
- Every surface ships empty / loading / error / offline states. An empty state is an invitation to act (one line + one action), not an illustration poster. See `references/tokens.md` §states.

**Interaction**
- Every action reachable by keyboard; primary surfaces get shortcuts (Cmd+K palette, Cmd+N, arrow navigation). Context menus for row-level actions (edit/delete/react), not always-visible button rows.
- Hover states use system conventions (subtle background, not scale transforms).

**Copy (user-visible strings)**
- Verb-first buttons ("Save changes", "메시지 보내기" — never "Submit"/"확인" alone where a verb fits). Errors state what happened and what to do next; they never apologize and are never vague.
- ZERO em-dashes (`—`, `–`) in any user-visible string. This is binary: one em-dash = pre-flight fail.
- No filler-hype vocabulary: "seamless/effortless/unleash/elevate/원활한/손쉽게" banned in UI copy.
- Fixtures/previews use realistic Korean+English mixed team content, never "John Doe"/"Acme"/"테스트 메시지 1".

## 3. Mac AI-Tells (banned patterns)

| Banned | Instead |
|---|---|
| Gradient-splash or illustration-centric empty views | One line of copy + one action button |
| Emoji as functional icons | SF Symbols, one rendering mode + weight per surface |
| Oversized rounded "web cards" wrapping every list row | Flat list rows with separators/hover; cards only when elevation means grouping |
| iOS-style full-width filled buttons in Mac dialogs | Standard bordered buttons, trailing-aligned, default action highlighted |
| Custom title bars breaking traffic-light spacing | Standard `.toolbar` / titlebar APIs |
| Raw JSON dumps in user-facing cards | Typed key-value rows (`LabeledContent`); raw payload behind a disclosure or inspector |
| Decorative status dots without meaning | Status indicators only when bound to real state |
| Section-number eyebrows, "001 · SETTINGS" labels | Plain section headers |
| Uppercase-tracking micro-labels more than 1 per surface | Sentence-case labels |
| Pure `#000000` / `#FFFFFF` backgrounds | System background colors (they adapt to appearance/contrast settings) |
| Toast/snackbar stacks (web pattern) | Inline banners in context, or system notifications |

## 4. Agent-native surfaces (oort-specific)

- Agent messages share the human message anatomy (same grid, same typography); the agent identity is expressed ONLY through the `agent.accent` token on avatar/badge, never a different bubble shape or background tint on the whole row.
- Tool-call / approval / diff / cost cards are **structured, calm, and dense**: title row (SF Symbol + name + status chip) → typed fields → disclosure for raw payload. Status lifecycle chips (queued/thinking/streaming/awaiting-approval/done/error) use the token status colors, text-first, no pulsing.
- Streaming text gets a caret, not a shimmer skeleton. Cost figures are `.monospacedDigit()`, right-aligned, and never animate faster than the data changes.
- Internal vocabulary ("Context Packet", "Memory Plane", "Capability Cache", run IDs, seq numbers) never appears as user-facing copy outside developer/diagnostic surfaces.

## 5. Mechanical Pre-Flight Check (run before claiming done)

Run these; ALL must pass. Any failure = the change is not done.

```sh
# from clients/ — zero hits allowed in view code (Theme/token definition files excluded)
grep -rn 'Color(red:' macOS/Sources Core/Sources | grep -v 'Theme\|Tokens' ; \
grep -rn 'Font\.custom\|\.font(.system(size' macOS/Sources | grep -v 'Theme\|Tokens' ; \
grep -rn '—\|–' macOS/Sources Core/Sources --include='*.swift' | grep -i 'Text(\|String(\|label\|title\|message'
```

Manual checklist:
- [ ] Design Read line was produced and the result matches it
- [ ] Light AND dark mode checked (screenshot or preview both)
- [ ] Empty/loading/error/offline states exist for the touched surface
- [ ] All padding/spacing values ∈ {4,8,12,16,24,32}
- [ ] One accent color; status colors from tokens only
- [ ] Keyboard path exists for every new action
- [ ] No banned Mac AI-Tells (§3 table)
- [ ] Long Korean + English mixed strings don't truncate/overflow (test with a 3-line Korean message)
- [ ] `reduceMotion` respected for any new animation

## 6. Review loop

After implementation, request the `design-review` agent (`.claude/agents/design-review.md`) with screenshots (snapshot tests or `LOCAL_GATE_LAUNCH_UI=1` + `screencapture -l <windowid>`). Blockers loop back automatically; only High-Priority-and-below findings go to a human. Rubric: `references/review-rubric.md`.
