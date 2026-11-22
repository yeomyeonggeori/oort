#!/usr/bin/env bash
# #5606 — every container removal under scripts/ carries `-v`.
#
#   scripts/check_docker_rm_volumes.sh [repo-root]
#
# Images that declare a VOLUME (postgres/pgvector, Hermes, caddy) leave one nameless
# volume per run when the container goes with a bare `docker rm -f` — including a
# container started with `docker run --rm`, because a forced removal skips the
# auto-remove path. 197 such volumes (~9GB) piled up on 11-09. `-v` removes only the
# container's anonymous volumes; named volumes are never touched by it.
#
# A removal line is `docker rm …` / `docker container rm …` / `"$DOCKER_BIN" rm …`
# outside a comment (a trailing ` # …` comment is cut off before judging). It passes
# when it carries `-v`, a short-flag cluster with `v` (`-fv`), or `--volumes`.
# Exit 1 lists every line that does not.
set -euo pipefail

ROOT="${1:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
cd "$ROOT"

# Operator tools that stop or recycle stacks whose data must survive: their removals
# stay without `-v` on purpose. Keep this list short and give each a reason.
ALLOW_FILES=(
  "scripts/momo"                     # dev stack stop: keeps the worktree stack's data
  "scripts/compose_janitor.sh"       # "Volumes are intentionally left untouched"
  "scripts/run_pitr_gated_migrate.sh" # production deploy-lock container; its test pins the argv
)

is_allowed() {
  local f="$1" a
  for a in "${ALLOW_FILES[@]}"; do [ "$f" = "$a" ] && return 0; done
  return 1
}

# shellcheck disable=SC2016 # literal $ in the regex, not an expansion
DOCKER_WORD='(docker|"\$DOCKER_BIN"|\$DOCKER_BIN|"\$\{DOCKER_BIN\}"|\$\{DOCKER_BIN\})'
RM_RE="(^|[^A-Za-z0-9_./-])${DOCKER_WORD}[[:space:]]+(container[[:space:]]+)?rm([[:space:]]|\$)"
V_RE='[[:space:]](-[a-uw-z]*v[a-z]*|--volumes)([[:space:]=]|$)'

files=()
while IFS= read -r f; do files+=("$f"); done < <(
  find scripts -type f \( -name '*.sh' -o -name momo -o -name oort \) -not -path '*/fixtures/*' | LC_ALL=C sort
)

bad=0
checked=0
for f in "${files[@]}"; do
  while IFS= read -r hit; do
    line="${hit#*:}"
    case "$line" in [[:space:]]*'#'*|'#'*)
      stripped="${line#"${line%%[![:space:]]*}"}"
      [ "${stripped:0:1}" = '#' ] && continue ;;
    esac
    # Judge the command, not a trailing comment: "rm -f "$x"  # -v …" must not pass.
    code="${line%% #*}"
    printf '%s\n' "$code" | grep -Eq -- "$RM_RE" || continue
    checked=$((checked + 1))
    if printf '%s\n' "$code" | grep -Eq -- "$V_RE"; then continue; fi
    if is_allowed "$f"; then continue; fi
    printf '%s:%s\n' "$f" "$hit" | cut -c1-220
    bad=$((bad + 1))
  done < <(grep -nE -- "$RM_RE" "$f" 2>/dev/null || true)
done

if [ "$bad" -ne 0 ]; then
  printf '[docker-rm-volumes] FAIL: %d container removal line(s) without -v (add -v; a forced rm skips --rm cleanup)\n' "$bad" >&2
  exit 1
fi
printf '[docker-rm-volumes] PASS: %d container removal line(s) carry -v (allow-listed operator tools: %d)\n' "$checked" "${#ALLOW_FILES[@]}"
