#!/usr/bin/env bash
# #5606 — 남은 자원 검사 (leftover check). Warn-only: it never fails a gate.
#
#   scripts/lib/leftover_check.sh snapshot <state-file>   before the run's docker steps
#   scripts/lib/leftover_check.sh report   <state-file>   after the run's final cleanup
#
# `report` lists the same scope again and names what appeared after `snapshot` and is
# still there: containers, volumes and temp paths this run (or a lane running at the
# same time) left behind. It prints exactly one line and exits 0.
#
# Scope — never an unscoped listing (other projects' Docker resources are not ours to
# look at):
#   containers  docker ps -a      --filter name=<n> / --filter label=<l>
#   volumes     docker volume ls  --filter name=<n> / --filter label=<l>
#   temp paths  ${TMPDIR:-/tmp}/momo* and /oort*, and <LEFTOVER_REPO_ROOT>/.tmp-*
#
# Environment:
#   LEFTOVER_NAMES           name substrings to watch (default: "momo oort")
#   LEFTOVER_LABELS          space-separated key=value labels to watch (optional)
#   LEFTOVER_REPO_ROOT       repo whose .tmp-* sandboxes are watched (optional)
#   LEFTOVER_DOCKER_TIMEOUT  seconds per docker call (default 15); a hung daemon
#                            skips the docker part instead of hanging the gate
#
# Anonymous volumes have random names, so they are outside any name/label scope: the
# cleanup rule (`docker run --rm` for a container that exits by itself, `docker rm -v`
# for every removal) is what keeps them from piling up. See
# docs/runbooks/development-validation.md, 「작업 끝 뒤처리」.
set -u

LEFTOVER_NAMES="${LEFTOVER_NAMES:-momo oort}"
LEFTOVER_LABELS="${LEFTOVER_LABELS:-}"
LEFTOVER_REPO_ROOT="${LEFTOVER_REPO_ROOT:-}"
LEFTOVER_DOCKER_TIMEOUT="${LEFTOVER_DOCKER_TIMEOUT:-15}"
case "$LEFTOVER_DOCKER_TIMEOUT" in ''|*[!0-9]*) LEFTOVER_DOCKER_TIMEOUT=15 ;; esac

# Run docker with a deadline. perl's alarm survives exec, so a hung daemon gets
# SIGALRM instead of holding the gate; without perl the call is made as-is.
lc_docker() {
  if command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$LEFTOVER_DOCKER_TIMEOUT" docker "$@"
  else
    docker "$@"
  fi
}

lc_docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  lc_docker info >/dev/null 2>&1
}

# One "kind<TAB>name" line per watched resource, sorted and unique.
lc_list() {
  local docker_ok="$1" n l tmp_root
  {
    if [ "$docker_ok" = 1 ]; then
      for n in $LEFTOVER_NAMES; do
        lc_docker ps -a --filter "name=$n" --format '{{.Names}}' 2>/dev/null | sed 's/^/container	/'
        lc_docker volume ls --filter "name=$n" --format '{{.Name}}' 2>/dev/null | sed 's/^/volume	/'
      done
      for l in $LEFTOVER_LABELS; do
        lc_docker ps -a --filter "label=$l" --format '{{.Names}}' 2>/dev/null | sed 's/^/container	/'
        lc_docker volume ls --filter "label=$l" --format '{{.Name}}' 2>/dev/null | sed 's/^/volume	/'
      done
    fi
    tmp_root="${TMPDIR:-/tmp}"
    tmp_root="${tmp_root%/}"
    (
      shopt -s nullglob
      for p in "$tmp_root"/momo* "$tmp_root"/oort*; do printf 'tmp\t%s\n' "$p"; done
      if [ -n "$LEFTOVER_REPO_ROOT" ] && [ -d "$LEFTOVER_REPO_ROOT" ]; then
        for p in "$LEFTOVER_REPO_ROOT"/.tmp-*; do printf 'tmp\t%s\n' "$p"; done
      fi
    )
  } | LC_ALL=C sort -u
}

lc_snapshot() {
  local state="$1" docker_ok=0
  lc_docker_ready && docker_ok=1
  mkdir -p "$(dirname -- "$state")" 2>/dev/null || true
  {
    printf '#docker\t%s\n' "$docker_ok"
    lc_list "$docker_ok"
  } >"$state" 2>/dev/null || true
}

lc_report() {
  local state="$1" docker_ok=0 before_docker=0 new containers volumes temps names
  if [ ! -f "$state" ]; then
    printf 'leftover-check: no snapshot at %s — skipped\n' "$state"
    return 0
  fi
  lc_docker_ready && docker_ok=1
  before_docker="$(sed -n 's/^#docker	//p' "$state" | head -n 1)"
  # Docker resources are only compared when both ends could see the daemon; a
  # daemon that came up mid-run would otherwise report every momo container.
  [ "$before_docker" = 1 ] || docker_ok=0
  new="$(LC_ALL=C comm -13 <(grep -v '^#' "$state" | LC_ALL=C sort -u) <(lc_list "$docker_ok"))"
  containers="$(printf '%s\n' "$new" | grep -c '^container	' || true)"
  volumes="$(printf '%s\n' "$new" | grep -c '^volume	' || true)"
  temps="$(printf '%s\n' "$new" | grep -c '^tmp	' || true)"
  local scope="컨테이너·볼륨·임시"
  [ "$docker_ok" = 1 ] || scope="임시만(docker 없음·응답 없음 — 컨테이너·볼륨 검사 건너뜀)"
  if [ -z "$new" ]; then
    printf 'leftover-check: 남은 자원 0 (%s, 이 실행 중 새로 생긴 momo/oort 것 기준)\n' "$scope"
    return 0
  fi
  names="$(printf '%s\n' "$new" | cut -f2 | head -n 8 | tr '\n' ' ')"
  printf 'leftover-check: WARNING 이 실행 중 새로 생겨 남은 자원 — 컨테이너 %s · 볼륨 %s · 임시 %s: %s(같은 때 도는 다른 칸 것일 수 있어요; 이 실행 것이면 docker rm -f -v / trap 정리를 확인)\n' \
    "$containers" "$volumes" "$temps" "$names"
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    snapshot) [ -n "${2:-}" ] && lc_snapshot "$2" ;;
    report) [ -n "${2:-}" ] && lc_report "$2" ;;
    *) printf 'usage: scripts/lib/leftover_check.sh snapshot|report <state-file>\n' >&2 ;;
  esac
  exit 0
fi
