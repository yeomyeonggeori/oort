#!/usr/bin/env bash
#
# verify_design_preflight.sh — mechanical design pre-flight for the momo macOS/Core
# SwiftUI client (MOMO-318, EP-DESIGN-SYSTEM).
#
# Encodes the grep half of `.claude/skills/momo-design-taste/SKILL.md` §5 as a
# gate command wired into `scripts/local_gate.sh --profile swift`. It fails when a
# NEW banned pattern is introduced, using a *ratchet* baseline so the pre-existing
# violations in the v0 demo surface (e.g. MessageBubble.swift `.font(.system(size:8))`)
# do not block unrelated PRs. See docs/LOCAL_PR_GATE.md §"Design pre-flight (ratchet)".
#
# Ratchet contract:
#   - Per-category violation counts are stored in scripts/design_preflight_baseline.txt.
#   - current > baseline  -> FAIL (a new violation leaked in; offenders are printed).
#   - current < baseline  -> PASS + guidance to lower the baseline (ratchet tightens).
#   - current == baseline -> PASS.
#
# Categories (view code only; Theme/Tokens definition files and Tests are excluded):
#   (a) color_red        : raw Color(red:...) instead of a semantic token
#   (b) font_custom      : Font.custom(...) instead of a semantic text style
#   (c) font_system_size : .font(.system(size: N)) fixed points (breaks Dynamic Type)
#   (d) emdash_string    : em-dash (— / –) inside a user-visible string literal
#
# Compatible with /bin/bash 3.2 (macOS system bash): no associative arrays, no
# `mapfile`, no process substitution in the hot path. LC_ALL=C keeps grep byte-
# oriented so counts are locale-independent and deterministic.

set -u
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to repo root $REPO_ROOT" >&2; exit 2; }

BASELINE_FILE="$REPO_ROOT/scripts/design_preflight_baseline.txt"

# View-code roots. Structured-type test fixtures live under Tests/ and are naturally
# excluded because we only scan Sources/.
SRC_DIRS=("clients/macOS/Sources" "clients/Core/Sources")

# Token-definition files (their whole job is to hold the raw color/size values that
# view code must not). Matched on the path segment (…/Theme*.swift: / …/Tokens*.swift:)
# so they are excluded without also swallowing view lines that merely mention a token.
TOKEN_FILE_RE='/(Theme|Tokens)[^/]*\.swift:'

# Ordered category keys (space-separated for bash 3.2 for-loops).
KEYS="color_red font_custom font_system_size emdash_string"

label_for() {
  case "$1" in
    color_red)        echo "raw Color(red:...) in view code (use a MomoDS semantic token)" ;;
    font_custom)      echo "Font.custom(...) in view code (use a semantic text style / role)" ;;
    font_system_size) echo ".font(.system(size: N)) fixed points (breaks Dynamic Type)" ;;
    emdash_string)    echo "em-dash (—/–) in a user-visible string literal (banned by SKILL §2)" ;;
    *)                echo "$1" ;;
  esac
}

# scan_category KEY -> emits `path:line:content` for every current offender.
scan_category() {
  case "$1" in
    color_red)
      grep -rn -F 'Color(red:' "${SRC_DIRS[@]}" --include='*.swift' 2>/dev/null \
        | grep -vE "$TOKEN_FILE_RE"
      ;;
    font_custom)
      grep -rn -F 'Font.custom' "${SRC_DIRS[@]}" --include='*.swift' 2>/dev/null \
        | grep -vE "$TOKEN_FILE_RE"
      ;;
    font_system_size)
      grep -rn -F '.font(.system(size:' "${SRC_DIRS[@]}" --include='*.swift' 2>/dev/null \
        | grep -vE "$TOKEN_FILE_RE"
      ;;
    emdash_string)
      # em-dash inside a double-quoted string literal, excluding whole-line comments
      # (path:line:<optional ws>//...). Comment-only em-dashes are not user-visible.
      grep -rnE '"[^"]*(—|–)[^"]*"' "${SRC_DIRS[@]}" --include='*.swift' 2>/dev/null \
        | grep -vE "$TOKEN_FILE_RE" \
        | grep -vE '^[^:]*:[0-9]+:[[:space:]]*//'
      ;;
  esac
}

count_category() {
  # grep -c . prints 0 (and exits 1) on empty input; we only read stdout.
  scan_category "$1" | grep -c . || true
}

baseline_for() {
  awk -v k="$1" '/^[[:space:]]*#/ { next } $1 == k { print $2; exit }' "$BASELINE_FILE" 2>/dev/null
}

write_baseline() {
  {
    echo "# scripts/design_preflight_baseline.txt"
    echo "# MOMO-318 design pre-flight ratchet baseline (per-category violation counts)."
    echo "# Format: <key> <count>. New violations above these counts FAIL the swift gate."
    echo "# Regenerate after an intentional change with:"
    echo "#   scripts/verify_design_preflight.sh --update-baseline"
    for key in $KEYS; do
      echo "$key $(count_category "$key")"
    done
  } > "$BASELINE_FILE"
  echo "wrote baseline: $BASELINE_FILE"
  echo "---"
  cat "$BASELINE_FILE"
}

list_all() {
  echo "== design pre-flight — current violations (all categories) =="
  for key in $KEYS; do
    local n
    n="$(count_category "$key")"
    echo "-- $key ($n): $(label_for "$key")"
    scan_category "$key" | sed 's/^/   /'
  done
}

MODE="check"
case "${1:-}" in
  --update-baseline) MODE="update" ;;
  --list)            MODE="list" ;;
  --help|-h)
    echo "usage: scripts/verify_design_preflight.sh [--list | --update-baseline]"
    echo "  (no args)          ratchet check against $BASELINE_FILE (gate mode)"
    echo "  --list             print every current violation, no pass/fail gating"
    echo "  --update-baseline  recompute and rewrite the baseline counts"
    exit 0
    ;;
  "") ;;
  *)
    echo "unknown argument: $1 (see --help)" >&2
    exit 2
    ;;
esac

if [ "$MODE" = "update" ]; then
  write_baseline
  exit 0
fi

if [ "$MODE" = "list" ]; then
  list_all
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "design pre-flight: baseline file missing ($BASELINE_FILE)." >&2
  echo "  create it with: scripts/verify_design_preflight.sh --update-baseline" >&2
  exit 2
fi

echo "== design pre-flight (ratchet) — SKILL momo-design-taste §5 =="
echo "   scanned: ${SRC_DIRS[*]} (Theme/Tokens definition files + Tests excluded)"
echo "   baseline: $BASELINE_FILE"
echo ""

overall=0
tighten=0
for key in $KEYS; do
  cur="$(count_category "$key")"
  base="$(baseline_for "$key")"
  if [ -z "$base" ]; then
    echo "FAIL  $key: no baseline entry — run --update-baseline"
    overall=1
    continue
  fi
  if [ "$cur" -gt "$base" ]; then
    echo "FAIL  $key: $cur > baseline $base  (+$((cur - base)) new violation(s))"
    echo "        rule: $(label_for "$key")"
    echo "        current offenders (file:line):"
    scan_category "$key" | sed 's/^/          /'
    overall=1
  elif [ "$cur" -lt "$base" ]; then
    echo "OK    $key: $cur < baseline $base  (ratchet can tighten to $cur)"
    tighten=1
  else
    echo "OK    $key: $cur == baseline $base"
  fi
done

echo ""
if [ "$overall" -ne 0 ]; then
  echo "RESULT: FAIL — a new design-taste violation was introduced."
  echo "  Fix it with a MomoDS semantic token / text role, or (if the added"
  echo "  violation is a deliberate, reviewed exception) update the baseline via"
  echo "  scripts/verify_design_preflight.sh --update-baseline and justify it in the PR."
  exit 1
fi

if [ "$tighten" -ne 0 ]; then
  echo "RESULT: PASS — no new violations. One or more categories dropped below the"
  echo "  baseline; lock the win with: scripts/verify_design_preflight.sh --update-baseline"
else
  echo "RESULT: PASS — no new violations (counts at baseline)."
fi
exit 0
