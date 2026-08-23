---
name: momo-design-taste
description: Entry point for oort UI work — routes a change to the design dialect that governs its surface. Use WHENEVER creating or modifying UI, components, tokens, or user-visible strings in clients/web, clients/desktop or clients/mobile, and before requesting the design-review agent. Names the canonical design system (오르트 구름), delegates web/desktop to momo-design-taste-web, and states what the phone surface is governed by and what nothing measures.
---

# oort Design Taste — surface router

This skill used to be the macOS/SwiftUI rulebook. That surface is gone: `clients/macOS`,
`clients/iOS` and `clients/Core` were deleted (ADR-0145 증보 1~2 / ADR-0159 D4), and a
rulebook for a tree that does not exist is worse than no rulebook — it answers questions
about pixels nobody will ever render. So this file no longer holds rules. It holds the
one thing that cannot live in a per-surface skill: **which document governs the change in
front of you.**

## 0. Route first (10 seconds)

| Touched | Read, in this order |
|---|---|
| `clients/web/**` · `clients/desktop/**` | `docs/design-system/README.md` → `.claude/skills/momo-design-taste-web/SKILL.md` |
| `clients/mobile/**` (bare React Native) | `docs/design-system/README.md` → `clients/mobile/src/design/tokens.ts` → §2 below |
| `packages/momo-core/**` user-visible strings | `docs/design-system/README.md` §4 + the copy rules of whichever client renders them (both do) |
| A rule you want to *change* rather than follow | `docs/design-system/README.md` §6, then ADR-0159 |

**`clients/desktop` is not a third surface.** Tauri's `frontendDist` is `../../web/dist` and
`clients/web/src` carries zero style branches on runtime, so a desktop change is a web
change (`docs/design-system/README.md` §1, 주1).

## 1. The canonical page is `docs/design-system/README.md` (오르트 구름)

Everything a review can be argued from lives there, with an origin next to each rule:
the token layers and the web→phone translation direction (§2), the hierarchy rule
destructive > primary > secondary stated as an *order between two values* rather than a
value (§3), the four mandatory states (§4), and — the section to open before claiming a
rule is "checked" — the **enforcement map** (§5), which says for every axis what machine
measures it and, in §5.3, **what nothing measures at all**.

That last part is why this router exists and why it is short. The design audit's second
most common defect pattern was "a machine should have caught this and did not" (17 findings
across 10 reports), and it was mostly caused by nobody knowing which axes are unmeasured.
A skill that restates rules invites a reader to believe the restatement is the rule; the
canonical page is versioned with the code that enforces it, and this file is not.

The root `DESIGN.md` and `.omd/system/*` are OmD Core v2 **non-authoritative mirrors**
of that page. They make the same system portable and browsable; they do not add a third
dialect or outrank this router. The exact coexistence contract is
`docs/design-system/OMD.md`.

## 2. The phone surface has no dialect skill, and that is stated rather than papered over

`momo-design-taste-web` is a real dialect: it translates the shared rules into Tailwind
classes, CSP constraints and shadcn/Radix primitives, and `scripts/design_preflight_web.sh`
is its executable half. **There is no equivalent for `clients/mobile`.** Until one exists,
a phone change is governed by:

- **Tokens** — `clients/mobile/src/design/tokens.ts`, which *translates* the web tokens.
  The web file is canonical; the phone file follows. Adding a phone-only value is the §6
  procedure on the canonical page, not a local decision.
- **Machine checks that do exist** — `clients/mobile/__tests__/designSystem.test.ts` and
  `clients/mobile/__tests__/paletteContrast.test.ts` (palette saturation order, the `--line`
  premise, the count of hand-written touch-target numbers), plus the capture lane
  `clients/mobile/measure/states.tsx`.
- **Machine checks that do not** — fill order and outline order have no phone token to
  measure yet, and no systematic check says which component uses which side
  (canonical page §3.3). On the phone those axes are carried by human review and by the
  `design-review` agent, and by nothing else.

Do not read the web skill's Tailwind-specific sections as phone rules. The intent is shared;
`p-3` is not.

## 3. What survives here from the mac skill

Two things, because they are surface-independent and the review agent needs them:

- **`references/review-rubric.md`** — the phases and the output format the `design-review`
  agent scores with, and the ADR-0112 D6 always-Blocker list. Re-aimed to web and phone.
- **The refusal to accept a green that proves nothing.** A pre-flight that skips because its
  tool is missing, a screenshot of a surface that was never interacted with, and a rule
  asserted from a document rather than measured on the render are all the same failure.

The mac token reference and the iOS rubric were deleted with their surfaces. If you are
looking for `references/tokens.md`, the token canon is `clients/web/src/design/tokens.css`
plus `.claude/skills/momo-design-taste-web/references/tokens.md`.

## 4. Review loop

Implement against the dialect for your surface, run its mechanical pre-flight
(`scripts/design_preflight_web.sh` for web; the phone has none — say so in the report rather
than implying a clean run), capture evidence, then request the `design-review` agent
(`.claude/agents/design-review.md`) in a **fresh context**. Blockers loop back to the
implementer automatically; only High-and-below findings go to a human.

Gate target (ADR-0133 parity, CLAUDE.md 하드 룰): **Blocker 0.**
