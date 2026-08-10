# Design Review Rubric (for the design-review agent)

Adapted from OneRedOak/claude-code-workflows design-review. Originally written for the
native macOS client; re-aimed to the two surfaces that exist — **web** (`clients/web`,
shipped to desktop unchanged via Tauri) and **phone** (`clients/mobile`, bare React Native).

Evidence rule: every visual finding ships with a screenshot reference. Communication rule:
**problems over prescriptions** — describe impact, not pixel fixes.
Argue findings from `docs/design-system/README.md`; open its §5.3 before writing "the gate
should have caught this", because for several axes nothing does.

## Phases

0. **Prep** — build the change and capture evidence for every touched surface.
   - web: `cd clients/web && npm run build && npm run capture:design` → `artifacts/design/*.png`
     (mocks `/v1` with Korean+English fixtures, emulates both schemes at browser level).
   - phone: `clients/mobile/measure/` renders real components with state props.
   Capture **light and dark** at minimum. If no runtime evidence is obtainable, run phases
   3/6/7 only and mark the visual phases SKIPPED — never guess about pixels you have not seen.
1. **Interaction** — walk the primary flow. Pointer, hover, context menu, and the keyboard
   path (tab order, shortcuts, Esc/Enter semantics in dialogs). On phone: tap, long-press,
   and the back gesture.
2. **Viewport behavior** (this replaces the mac client's window-chrome phase) — web at 1280
   and 900 wide, sidebar collapsed, long channel and member names; phone at the narrowest
   supported width with the largest system font scale. Nothing truncates meaninglessly or
   overlaps, and no control leaves the viewport.
3. **Visual polish** — token compliance (color/type/spacing from the token layer only:
   `clients/web/src/design/tokens.css`, `clients/mobile/src/design/tokens.ts`), alignment to
   the 4px rhythm, hierarchy readable at a squint, one accent per surface, and the
   **hierarchy order** (destructive > primary > secondary as an order between two values —
   canonical page §3). Web AI-Tells: `momo-design-taste-web` §8.
4. **Accessibility** — keyboard-only completion of the flow with a visible focus ring at
   every stop, `aria-label` on icon-only controls (web) / accessibility labels (phone), AA
   contrast in both schemes, control borders 3:1, touch targets 44 (24 for inline links on
   web), `prefers-reduced-motion` respected.
5. **Robustness** — empty channel, 200+ message channel, offline/REST fallback, streaming
   mid-state, a 3-line Korean+English mixed message, very long channel/member names.
6. **Code health** — no magic numbers, no raw color/font literals in components, primitives
   reused rather than re-inlined, and the mechanical pre-flight output attached:
   `scripts/design_preflight_web.sh` for web. **The phone has no mechanical pre-flight** —
   write that sentence in the report rather than leaving the row blank, which reads as a
   clean run.
7. **Copy** — verb-first actions, no em-dashes, no hype vocabulary, terminology consistent
   with existing surfaces (channel/멤버/승인/에이전트), internal vocabulary (run ids, seq,
   Context Packet) never surfacing outside diagnostic screens.

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
ADR-0133 parity target for the web surface is stricter: Blocker 0, High 0.

**Detail SLA (ADR-0112 D6) — the following are always [Blocker], never lower:**
- A visible control that does not respond to pointer/keyboard/tap (dead button, unreachable
  close).
- A control that leaves the viewport at a supported size, or that the keyboard can reach
  while the eye cannot see it. (This is the web/phone form of the original window-chrome
  clause; it has caught the same defect twice — #838 and #839.)
- Clipped, overlapping, or truncated user-facing text at default sizes.
- Reviewers must attempt interaction checks (hit-test reasoning from code plus any runtime
  evidence available) — "the snapshot looks fine" does not clear this class.
