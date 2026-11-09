#!/usr/bin/env bash
# #5606 — 남은 자원 검사 (leftover check). Warn-only: it never fails a gate.
#
#   scripts/lib/leftover_check.sh snapshot <state-file>   before the run's first step
#   scripts/lib/leftover_check.sh report   <state-file>   after the run's final cleanup
#
# Each prints exactly one line and exits 0. `report` names what appeared after
# `snapshot` inside the scope below and is still there.
#
# Scope — only what this run can own; never an unscoped listing (other lanes' and
# other projects' Docker resources are not ours to look at):
#   containers  docker ps -a      --filter label=<l>  for each LEFTOVER_LABELS entry
#   volumes     docker volume ls  --filter label=<l>  (same labels)
#               --filter name=<n> is added only for LEFTOVER_NAMES (manual use; the
#               gate leaves it empty because names are shared by every lane)
#   temp paths  the LEFTOVER_TMP_GLOBS patterns (the gate passes this worktree's
#               .tmp-* sandboxes; the shared ${TMPDIR} is not attributable to a run)
#
# Environment:
#   LEFTOVER_LABELS          space-separated key=value labels (default: none)
#   LEFTOVER_NAMES           space-separated name substrings (default: none)
#   LEFTOVER_TMP_GLOBS       space-separated glob patterns (default: none)
#   LEFTOVER_DOCKER          0 skips the docker part (default 1)
#   LEFTOVER_DOCKER_TIMEOUT  seconds per docker call (default 10). The call runs in
#                            the background and its exact PID gets TERM, then KILL,
#                            at the deadline: a daemon that accepts and never answers
#                            cannot hold the gate. (perl `alarm` is not enough: the Go
#                            docker CLI ignores SIGALRM.)
#
# Anonymous volumes have random names and no labels, so they are outside any scope:
# the cleanup rule (`docker run --rm` for a container that exits by itself,
# `docker rm -f -v` for every removal, enforced by scripts/check_docker_rm_volumes.sh)
# keeps them from piling up. See docs/runbooks/development-validation.md,
# 「작업 끝 뒤처리」.
set -u

LEFTOVER_LABELS="${LEFTOVER_LABELS-}"
LEFTOVER_NAMES="${LEFTOVER_NAMES-}"
LEFTOVER_TMP_GLOBS="${LEFTOVER_TMP_GLOBS-}"
LEFTOVER_DOCKER="${LEFTOVER_DOCKER:-1}"
LEFTOVER_DOCKER_TIMEOUT="${LEFTOVER_DOCKER_TIMEOUT:-10}"
case "$LEFTOVER_DOCKER_TIMEOUT" in ''|*[!0-9]*|0) LEFTOVER_DOCKER_TIMEOUT=10 ;; esac
LC_WORK=""

# docker with a hard deadline. Output goes through a private file next to the state
# file (no shared temp path); a call that outlives the deadline returns 124.
lc_docker() {
  local out pid rc ticks=0 limit=$((LEFTOVER_DOCKER_TIMEOUT * 10))
  [ -n "$LC_WORK" ] || return 125
  out="$LC_WORK/.leftover-docker.$$.$RANDOM"
  docker "$@" </dev/null >"$out" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null
      sleep 1
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      rm -f -- "$out"
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
  rc=$?
  cat -- "$out" 2>/dev/null
  rm -f -- "$out"
  return "$rc"
}

# 1 when docker should be listed: wanted, on PATH, and the daemon answers in time.
# Sets LC_DOCKER_WHY for the result line.
lc_docker_probe() {
  LC_DOCKER_WHY=""
  if [ "$LEFTOVER_DOCKER" = 0 ]; then LC_DOCKER_WHY="docker 건너뜀(이 프로필은 docker를 쓰지 않아요)"; return 1; fi
  if [ -z "$LEFTOVER_LABELS$LEFTOVER_NAMES" ]; then LC_DOCKER_WHY="docker 범위 없음"; return 1; fi
  if ! command -v docker >/dev/null 2>&1; then LC_DOCKER_WHY="docker 없음 — 건너뜀"; return 1; fi
  local rc=0
  lc_docker version --format '{{.Server.Version}}' >/dev/null || rc=$?
  case "$rc" in
    0) return 0 ;;
    124) LC_DOCKER_WHY="docker 응답 없음(${LEFTOVER_DOCKER_TIMEOUT}초) — 건너뜀" ;;
    *) LC_DOCKER_WHY="docker 데몬에 닿지 않음 — 건너뜀" ;;
  esac
  return 1
}

# One "kind<TAB>name" line per watched resource, sorted and unique.
lc_list() {
  local docker_ok="$1" n l g
  {
    if [ "$docker_ok" = 1 ]; then
      for l in $LEFTOVER_LABELS; do
        lc_docker ps -a --filter "label=$l" --format '{{.Names}}' | sed 's/^/container	/'
        lc_docker volume ls --filter "label=$l" --format '{{.Name}}' | sed 's/^/volume	/'
      done
      for n in $LEFTOVER_NAMES; do
        lc_docker ps -a --filter "name=$n" --format '{{.Names}}' | sed 's/^/container	/'
        lc_docker volume ls --filter "name=$n" --format '{{.Name}}' | sed 's/^/volume	/'
      done
    fi
    (
      shopt -s nullglob
      # shellcheck disable=SC2086 # the patterns are meant to expand here
      for g in $LEFTOVER_TMP_GLOBS; do printf 'tmp\t%s\n' "$g"; done
    )
  } | grep -v '	$' | LC_ALL=C sort -u
}

lc_scope_text() {
  local parts=""
  [ -n "$LEFTOVER_LABELS" ] && parts="라벨 $LEFTOVER_LABELS"
  [ -n "$LEFTOVER_NAMES" ] && parts="${parts:+$parts · }이름 $LEFTOVER_NAMES"
  [ -n "$LEFTOVER_TMP_GLOBS" ] && parts="${parts:+$parts · }임시 $LEFTOVER_TMP_GLOBS"
  printf '%s' "${parts:-범위 없음}"
}

lc_snapshot() {
  local state="$1" docker_ok=0
  LC_WORK="$(dirname -- "$state")"
  mkdir -p -- "$LC_WORK" 2>/dev/null || true
  lc_docker_probe && docker_ok=1
  if ! { printf '#docker\t%s\n' "$docker_ok"; lc_list "$docker_ok"; } >"$state" 2>/dev/null; then
    printf 'leftover-check: snapshot 못 씀(%s) — report는 건너뛰어요\n' "$state"
    return 0
  fi
  if [ "$docker_ok" = 1 ]; then
    printf 'leftover-check: snapshot 찍음 (%s)\n' "$(lc_scope_text)"
  else
    printf 'leftover-check: snapshot 찍음, %s (%s)\n' "$LC_DOCKER_WHY" "$(lc_scope_text)"
  fi
}

lc_report() {
  local state="$1" docker_ok=0 before_docker new containers volumes temps names note=""
  if [ ! -f "$state" ]; then
    printf 'leftover-check: no snapshot at %s — skipped\n' "$state"
    return 0
  fi
  LC_WORK="$(dirname -- "$state")"
  before_docker="$(sed -n 's/^#docker	//p' "$state" | head -n 1)"
  # Docker resources are compared only when both ends could see the daemon; one that
  # came up mid-run would otherwise report everything that already carried the label.
  if [ "$before_docker" = 1 ]; then
    lc_docker_probe && docker_ok=1
  else
    LC_DOCKER_WHY="docker 건너뜀(snapshot 때 docker를 보지 못했어요)"
  fi
  [ "$docker_ok" = 1 ] || note=", ${LC_DOCKER_WHY}"
  new="$(LC_ALL=C comm -13 <(grep -v '^#' "$state" | LC_ALL=C sort -u) <(lc_list "$docker_ok"))"
  if [ -z "$new" ]; then
    printf 'leftover-check: 남은 자원 0 (%s%s)\n' "$(lc_scope_text)" "$note"
    return 0
  fi
  containers="$(printf '%s\n' "$new" | grep -c '^container	' || true)"
  volumes="$(printf '%s\n' "$new" | grep -c '^volume	' || true)"
  temps="$(printf '%s\n' "$new" | grep -c '^tmp	' || true)"
  names="$(printf '%s\n' "$new" | cut -f2 | head -n 8 | tr '\n' ' ')"
  printf 'leftover-check: WARNING 이 실행이 남긴 자원 — 컨테이너 %s · 볼륨 %s · 임시 %s: %s(%s%s; 컨테이너는 docker rm -f -v 로, 임시는 trap으로 지워요)\n' \
    "$containers" "$volumes" "$temps" "$names" "$(lc_scope_text)" "$note"
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
