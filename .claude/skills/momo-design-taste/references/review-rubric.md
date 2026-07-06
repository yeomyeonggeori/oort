# Design Review Rubric (for the design-review agent)

Adapted from OneRedOak/claude-code-workflows design-review for native macOS.
Evidence rule: every visual finding ships with a screenshot reference. Communication rule:
**problems over prescriptions** — describe impact, not pixel fixes.

## Phases

0. **Prep** — build the change, launch app or render snapshot previews. Capture: light, dark,
   increased-contrast, and one large-Dynamic-Type variant of every touched surface.
1. **Interaction** — walk the primary flow of the change. Clicks, hover, context menus,
   keyboard path (tab order, shortcuts, Esc/Enter semantics in dialogs).
2. **Window behavior** (replaces web viewports) — min window size, sidebar collapsed,
   inspector open+narrow, full screen. Nothing truncates meaninglessly or overlaps.
3. **Visual polish** — token compliance (colors/typography/spacing from MomoDS only),
   alignment to the 4pt grid, hierarchy readable at a squint, one accent per surface,
   Mac AI-Tells table (SKILL.md §3) violations.
4. **Accessibility** — VoiceOver labels on new controls, keyboard-only completion of the flow,
   AA contrast in both schemes, reduceMotion respected.
5. **Robustness** — empty channel, 200+ message channel, offline/REST-fallback, streaming
   mid-state, 3-line Korean+English mixed message, very long channel/member names.
6. **Code health** — no magic numbers, no raw colors/fonts in views, components reused not
   re-inlined, mechanical pre-flight (SKILL.md §5) output attached.
7. **Copy** — verb-first actions, no em-dashes, no hype vocabulary, consistent terminology
   with existing surfaces (channel/멤버/승인/에이전트).

## Output format

```
### Design Review — <surface> (<commit/branch>)
Screenshots: <paths>

[Blocker]      — must fix before merge; loops back to implementer automatically
[High]         — fix in this PR unless justified
[Medium]       — follow-up ticket acceptable
[Nitpick]      — note only
Verdict: PASS / FAIL(blockers: N)
```

A change with zero Blockers and ≤2 High findings may proceed to human review;
otherwise it returns to the implementer with this report.
