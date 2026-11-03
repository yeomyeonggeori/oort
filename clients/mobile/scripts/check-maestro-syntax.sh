#!/usr/bin/env bash
# =============================================================================
# clients/mobile/scripts/check-maestro-syntax.sh — `maestro check-syntax` over every flow
#
# `npm run check:maestro-syntax` (from clients/mobile). PR CI runs the same file in
# the `node_mobile` job of .github/workflows/pr-ci.yml, with Maestro pinned there.
#
# ## Why this exists
#
# A Maestro flow's mistakes stay hidden until a simulator reaches the step:
#
#   * #4869 shipped without the `---` line between the config block and the
#     commands. Nothing read the file again until a verification run, hours after
#     the PR had landed (#5045 found it).
#   * #5081: `duration: ${FLICK_MS}` in the three sheet-drag flows. `swipe.duration`
#     is a number field, and `check-syntax` does not substitute `${...}` the way a
#     run does. The driver (measure/sheet-drag-run.mjs) pasted the text in before
#     Maestro ever saw the file, so every run was fine and the folder was broken.
#
# `maestro check-syntax <file>` parses one flow with Maestro's own YAML reader. It
# needs no device, no app and no server: about 2 s a file, nearly all of it JVM
# start-up, so the files are checked a few at a time.
#
# ## What it covers, and what it does not
#
# Covers: every *.yaml under clients/mobile/maestro, subflows/ included — the
# structure, the header, and the TYPE of every field.
#
# Does not cover: that a testID or a sentence exists in the app, that a `-e`
# value is passed, or that a step proves what its comment says. Those are
# runtime facts and stay with the phone lane (`npm run lane:phone`).
#
# ## It cannot pass blind
#
# Before the real files it runs a NEGATIVE CONTROL: a minimal valid flow must be
# accepted, and a flow without its `---` header and a flow with a `${...}`
# placeholder in a number field must each be REJECTED. If any of the three is
# answered wrongly the checker is not measuring anything (a Maestro update that
# turned lenient, a JVM that cannot start), and the script fails saying so —
# a green from a blind check is worse than no check. It also refuses to report a
# pass on zero files.
#
# ## Usage
#
#   bash clients/mobile/scripts/check-maestro-syntax.sh               every flow
#   bash clients/mobile/scripts/check-maestro-syntax.sh FILE...       just these
#   --jobs N        files checked in parallel (default 4; env MAESTRO_CHECK_JOBS)
#   --no-control    skip the negative control (only for debugging the checker)
#
#   MAESTRO_FLOW_DIR=<dir>   check another folder (default clients/mobile/maestro)
#   MAESTRO_CHECK_VERBOSE=1  also print a line for every flow that passes
#
# Exit: 0 every file ok · 1 a flow (or the control) failed · 2 usage, no maestro,
# or no files.
# =============================================================================
set -euo pipefail

APP_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
SELF="$APP_ROOT/scripts/check-maestro-syntax.sh"
FLOW_DIR="${MAESTRO_FLOW_DIR:-$APP_ROOT/maestro}"

# Maestro phones home (usage analytics) and asks GitHub for a newer release on
# start. A checker needs neither, and a runner with no network or no terminal
# should not be able to stall on them. These are the names maestro-cli 2.8.0
# reads (checked in its jar), not guesses.
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_DISABLE_UPDATE_CHECK=true

# Appended, not prepended: a `maestro` that the caller put on PATH first (CI's
# pinned install) must win over whatever an older ~/.maestro happens to hold.
case ":$PATH:" in
  *":$HOME/.maestro/bin:"*) ;;
  *) export PATH="$PATH:$HOME/.maestro/bin" ;;
esac

# One JVM per file, each alive about two seconds, nearly all of it start-up. A C1-only
# JIT and the serial collector spend less CPU on that start-up and change nothing about
# what is parsed: the 84 files took 77-84 s on 4 vCPU (Linux, Java 17) and 50 s with
# them. Appended to whatever MAESTRO_OPTS the caller already has; the launcher passes
# it to the JVM next to its own defaults.
case "${MAESTRO_OPTS:-}" in
  *TieredStopAtLevel=1*) ;; # already added: the parallel runner re-enters this file once per flow
  *) export MAESTRO_OPTS="${MAESTRO_OPTS:+$MAESTRO_OPTS }-XX:TieredStopAtLevel=1 -XX:+UseSerialGC" ;;
esac

say() { printf '[maestro-check] %s\n' "$*"; }

# One file. Prints nothing on success (unless MAESTRO_CHECK_VERBOSE=1) and ONE
# block on failure, written in a single printf so parallel files cannot
# interleave their lines.
check_one() {
  local file="$1" rel out rc=0 pos detail msg
  rel="${file#"$APP_ROOT"/}"
  out="$(maestro check-syntax "$file" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    if [ "${MAESTRO_CHECK_VERBOSE:-0}" = "1" ]; then
      printf 'ok   %s\n' "$rel"
    fi
    return 0
  fi
  # JVM chatter ("WARNING: Final field parent ...") is not the diagnosis — but if
  # that is ALL there is, show it rather than a failure with no reason.
  detail="$(printf '%s\n' "$out" | grep -v -E '^WARNING: |^$' | head -n 6)" || detail=""
  if [ -z "$detail" ]; then
    detail="$(printf '%s\n' "$out" | head -n 6)"
  fi
  msg="FAIL $rel
$(printf '%s\n' "$detail" | sed 's/^/       /')"
  # Maestro words the position as `/syntax-checker:<line>:<col>`: the line of the
  # first token it could not take, which for a bad VALUE is the line after it.
  # Show that line and the two above so the reader does not have to count.
  pos="$(printf '%s\n' "$out" | sed -n 's|.*/syntax-checker:\([0-9][0-9]*\):.*|\1|p' | head -n 1)"
  if [ -n "$pos" ]; then
    msg="$msg
$(awk -v s="$((pos > 3 ? pos - 3 : 1))" -v e="$pos" 'NR >= s && NR <= e { printf "       %5d| %s\n", NR, $0 }' "$file")"
  fi
  printf '%s\n' "$msg"
  return 1
}

# Re-entry point for the parallel runner below (xargs starts `bash SELF --one FILE`).
if [ "${1:-}" = "--one" ]; then
  one_rc=0
  check_one "${2:?--one needs a file}" || one_rc=$?
  exit "$one_rc"
fi

JOBS="${MAESTRO_CHECK_JOBS:-4}"
RUN_CONTROL=1
FILES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jobs)       JOBS="${2:-}"; shift 2 ;;
    --no-control) RUN_CONTROL=0; shift ;;
    -h|--help)
      # The header comment, between its two `# ====` rules.
      awk '/^# =+$/ { n++; next } n == 1 { sub(/^# ?/, ""); print } n == 2 { exit }' "$0"
      exit 0 ;;
    -*) say "unknown argument: $1" >&2; exit 2 ;;
    *)  FILES+=("$1"); shift ;;
  esac
done

case "$JOBS" in
  ''|*[!0-9]*|0) say "--jobs needs a positive integer, got '$JOBS'" >&2; exit 2 ;;
esac

if ! command -v maestro >/dev/null 2>&1; then
  say "maestro is not on PATH." >&2
  say "  locally: bash clients/mobile/scripts/install_maestro.sh" >&2
  say "  in CI:   the pinned install step in the node_mobile job of pr-ci.yml" >&2
  exit 2
fi
MAESTRO_VERSION_LINE="$(maestro --version 2>/dev/null | tail -n 1)" || MAESTRO_VERSION_LINE="unknown"

# ---- which files ------------------------------------------------------------
if [ "${#FILES[@]}" -eq 0 ]; then
  [ -d "$FLOW_DIR" ] || { say "no such directory: $FLOW_DIR" >&2; exit 2; }
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$FLOW_DIR" -type f -name '*.yaml' -print0 | sort -z)
fi
if [ "${#FILES[@]}" -eq 0 ]; then
  say "found no *.yaml under $FLOW_DIR — refusing to report a pass on nothing" >&2
  exit 2
fi
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { say "no such file: $f" >&2; exit 2; }
done

# ---- negative control -------------------------------------------------------
control() {
  local dir good no_header numeric ok=1
  dir="$(mktemp -d "${TMPDIR:-/tmp}/maestro-syntax-control.XXXXXX")"
  good="$dir/good.yaml"
  no_header="$dir/no-header.yaml"
  numeric="$dir/numeric-placeholder.yaml"
  cat > "$good" <<'YAML'
appId: app.momo.ios
---
- launchApp
YAML
  # #4869: the config block runs straight into the commands.
  cat > "$no_header" <<'YAML'
appId: app.momo.ios
- launchApp
YAML
  # #5081: a placeholder in a field that is a number.
  cat > "$numeric" <<'YAML'
appId: app.momo.ios
---
- swipe:
    start: "10, 10"
    end: "10, 20"
    duration: ${FLICK_MS}
YAML

  verdict() { # <file> <pass|fail> <what a wrong answer means>
    local file="$1" want="$2" meaning="$3" out rc=0
    out="$(maestro check-syntax "$file" 2>&1)" || rc=$?
    if [ "$want" = "pass" ] && [ "$rc" -ne 0 ]; then
      say "control FAILED: a minimal valid flow was rejected — $meaning" >&2
      printf '%s\n' "$out" | grep -v -E '^WARNING: |^$' | head -n 4 | sed 's/^/[maestro-check]   /' >&2
      return 1
    fi
    if [ "$want" = "fail" ] && [ "$rc" -eq 0 ]; then
      say "control FAILED: $meaning" >&2
      return 1
    fi
    return 0
  }
  verdict "$good" pass "maestro itself cannot run (Java 17+ missing? broken install?)" || ok=0
  verdict "$no_header" fail "a flow with no '---' header was ACCEPTED, so the check no longer catches #4869" || ok=0
  verdict "$numeric" fail "a '\${...}' placeholder in a number field was ACCEPTED, so the check no longer catches #5081" || ok=0

  rm -f "$good" "$no_header" "$numeric"
  rmdir "$dir" 2>/dev/null || true
  [ "$ok" = "1" ]
}

if [ "$RUN_CONTROL" = "1" ]; then
  if ! control; then
    say "the checker is blind or broken; no verdict on the real flows is worth reading" >&2
    exit 1
  fi
fi

# ---- the files --------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/maestro-syntax.XXXXXX")"
RESULTS="$WORK/results.txt"
trap 'rm -f "$RESULTS"; rmdir "$WORK" 2>/dev/null' EXIT

xrc=0
printf '%s\0' "${FILES[@]}" | xargs -0 -n 1 -P "$JOBS" bash "$SELF" --one >"$RESULTS" || xrc=$?

failed=0
failed="$(grep -c '^FAIL ' "$RESULTS")" || failed=0
cat "$RESULTS"

total="${#FILES[@]}"
say "$total flow files · $((total - failed)) ok · $failed failed · ${SECONDS}s (jobs=$JOBS, maestro $MAESTRO_VERSION_LINE)"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
if [ "$xrc" -ne 0 ]; then
  say "the parallel runner exited $xrc but no file reported FAIL — the runner itself broke, so this is not a pass" >&2
  exit 1
fi
exit 0
