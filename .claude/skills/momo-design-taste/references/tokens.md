# MomoDS Token Contract (seed — Track A of research/13-redesign/01)

Until `clients/Core/Sources/.../MomoDSTokens.swift` lands, this file IS the token spec.
When the Swift token layer exists, it must match this file; update both together.

## Layers

Views may ONLY touch the Semantic and Component layers. Primitive values never appear in view code.

### Primitive (definition-only)

- Neutral ramp: `gray.50 … gray.900` (asset catalog, light+dark variants)
- Brand ramp: derived from workspace theme seed (server-provided theme JSON, Compass-style)
- Spacing: 4pt base grid → `{4, 8, 12, 16, 24, 32}`
- Radius scale: `small=6, medium=10, large=14` (pick per component ONCE)
- Type scale: SF Pro text styles only (Dynamic Type compatible)

### Semantic (what views use)

| Token | Maps to | Notes |
|---|---|---|
| `background.primary` | window background | system `windowBackgroundColor` |
| `background.secondary` | sidebar/inspector | material or `controlBackgroundColor` |
| `background.raised` | cards that mean grouping | sparing |
| `background.hover` | row hover | subtle, system-convention |
| `text.primary` / `text.muted` / `text.link` | `.primary` / `.secondary` / tint | |
| `accent` | app tint / workspace theme seed | ONE per surface |
| `agent.accent` | agent identity (avatar ring, badge, caret) | today's `MomoTheme.agentAccent`; the ONLY visual marker of agent-ness |
| `agent.surface` | agent card field background | low-chroma tint of agent.accent |
| `status.success` / `status.warning` / `status.danger` | reversible / cost-soft-limit / irreversible | absorbs `reversibleGreen`, `costAmber`, `irreversibleRed` |
| `presence.online/away/dnd` | member presence dots | |

### Text roles

| Role | Base style | Modifiers |
|---|---|---|
| `.messageBody` | `.body` | |
| `.messageAuthor` | `.body` | `.weight(.semibold)` |
| `.timestamp` | `.caption` | `text.muted` |
| `.channelName` | `.body` | sidebar selected = `.semibold` |
| `.sectionHeader` | `.subheadline` | `.weight(.semibold)`, sentence case |
| `.agentPayloadMono` | `.callout` | `.monospaced()` — tool args, diffs, code |
| `.costFigure` | `.caption` | `.monospacedDigit()` |

### Density (token dimension, not per-view hacks)

`Density ∈ {compact, default, spacious}` scales: row vertical padding (4/6/10), message group spacing (8/12/16), sidebar row height. Stored per-user in settings.

## Required states per surface

| Surface | empty | loading | error | offline |
|---|---|---|---|---|
| Message timeline | "첫 메시지를 보내보세요" + composer focus | history skeleton (static, no shimmer) | inline banner + retry | REST-fallback banner (exists) |
| Sidebar/channels | "채널을 만들어 시작하세요" + create action | — | connection banner (exists) | same |
| Approval inbox | "대기 중인 승인이 없습니다" (calm, positive) | — | inline banner | queued note |
| Search (Cmd+K) | recent channels/jumps | spinner ≤300ms then results-so-far | "검색을 완료하지 못했습니다" + retry | local-only note |
| Agent run card | n/a | status chip lifecycle | error card w/ redacted reason + retry | n/a |
