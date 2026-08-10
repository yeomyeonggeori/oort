#!/usr/bin/env bash
# #1254 — the design review loop must point at surfaces that exist.
#
# When `clients/macOS`, `clients/iOS` and `clients/Core` were deleted, the
# `design-review` agent and the `momo-design-taste` skill kept aiming at them.
# CLAUDE.md names that pair as a hard rule for every UI change, so the effect was
# not a stale document: a reviewer invoked on a web PR was being told to read a
# SwiftUI rulebook and screenshot a window that no longer builds. It survived
# because nothing ever read those two files.
#
# Two things are checked, and the split matters:
#
#   1. The files the loop is made of exist. A rename that leaves the router
#      pointing at a missing dialect breaks the loop silently — the agent simply
#      reviews with less than it was supposed to.
#   2. Every `clients/<tree>` named in an agent's or skill's **frontmatter
#      description** exists. The description is the routing surface: it is what
#      decides when the thing is invoked and on what. Body prose is deliberately
#      NOT checked — saying "clients/macOS was deleted" is the correct sentence
#      to write, and a guard that forbade it would push the history out of the
#      document that most needs it.
set -euo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "[design-review-wiring] not inside a git worktree" >&2
  exit 1
fi
cd "$REPO_ROOT"

failures=0
fail() { echo "[design-review-wiring] FAIL: $*" >&2; failures=$((failures + 1)); }

# 1) the loop's parts
for f in \
  .claude/agents/design-review.md \
  .claude/skills/momo-design-taste/SKILL.md \
  .claude/skills/momo-design-taste/references/review-rubric.md \
  .claude/skills/momo-design-taste-web/SKILL.md \
  .claude/skills/momo-design-taste-web/references/tokens.md \
  docs/design-system/README.md \
  scripts/design_preflight_web.sh \
  clients/web/src/design/tokens.css \
  clients/mobile/src/design/tokens.ts; do
  [ -s "$f" ] || fail "the design review loop names a file that is not here: $f"
done

# 2) the routing surface
for f in .claude/agents/*.md .claude/skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  description="$(sed -n '2,/^---$/p' "$f" | sed -n '/^description:/,$p')"
  for tree in $(printf '%s' "$description" | grep -oE 'clients/[A-Za-z0-9_-]+' | LC_ALL=C sort -u); do
    [ -d "$tree" ] ||
      fail "$f frontmatter routes work to $tree, which does not exist — re-aim the description or restore the tree"
  done
done

# 3) the delegations the router and the agent are FOR. Without these two lines the
#    files can pass (1) and (2) while having quietly become unrelated documents.
grep -Fq 'momo-design-taste-web' .claude/skills/momo-design-taste/SKILL.md ||
  fail "the router must delegate the web/desktop surface to momo-design-taste-web"
grep -Fq 'docs/design-system/README.md' .claude/agents/design-review.md ||
  fail "design-review must read the canonical design system page (오르트 구름) first"
grep -Fq 'clients/mobile' .claude/skills/momo-design-taste/SKILL.md ||
  fail "the router must say what governs the phone surface, including that it has no dialect skill"

if [ "$failures" -ne 0 ]; then
  echo "[design-review-wiring] $failures check(s) failed" >&2
  exit 1
fi

echo "[design-review-wiring] PASS: the review loop names only surfaces that exist"
