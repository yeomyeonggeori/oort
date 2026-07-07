#!/usr/bin/env bash
# Shared runtime verifier process/port cleanup helpers.
#
# These helpers are intentionally conservative: they only stop processes that
# look like momo verifier-owned services, and they leave unrelated listeners
# untouched so local gates cannot kill arbitrary developer processes.

momo_guard_repo_root() {
  local root="${MOMO_RUNTIME_GUARD_REPO_ROOT:-${REPO_ROOT:-}}"
  if [ -z "$root" ] && command -v git >/dev/null 2>&1; then
    root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  printf '%s' "$root"
}

momo_guard_command_matches() {
  local cmd="${1:-}"
  local root
  root="$(momo_guard_repo_root)"
  [ -n "$cmd" ] || return 1
  [ -n "$root" ] || return 1

  case "$cmd" in
    *"$root/"*scripts/mock_hermes.py*|*"$root/"*.build/*MomoServer*|*"$root/"*.build/*AgentWorker*|*"$root/"*.build/*OutboxRelay*)
      return 0
      ;;
    *"$root/"*MomoServer*|*"$root/"*AgentWorker*|*"$root/"*OutboxRelay*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

momo_guard_command_label() {
  local cmd="${1:-unknown}"
  case "$cmd" in
    *mock_hermes.py*) echo "mock_hermes.py" ;;
    *MomoServer*) echo "MomoServer" ;;
    *AgentWorker*) echo "AgentWorker" ;;
    *OutboxRelay*) echo "OutboxRelay" ;;
    *) echo "unknown" ;;
  esac
}

momo_guard_pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

momo_guard_collect_tree() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  echo "$pid"
  if command -v pgrep >/dev/null 2>&1; then
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      momo_guard_collect_tree "$child"
    done
  fi
}

momo_kill_tree() {
  local pid="${1:-}"
  local label="${2:-process}"
  local trusted_root="${3:-0}"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local pids
  pids="$(momo_guard_collect_tree "$pid" | awk '!seen[$0]++')"
  local killable="" blocked=0 target cmd name
  for target in $pids; do
    kill -0 "$target" 2>/dev/null || continue
    cmd="$(momo_guard_pid_command "$target")"
    if [ "$trusted_root" = "1" ] || momo_guard_command_matches "$cmd"; then
      killable="${killable}${target} "
    else
      echo "[runtime-guard] refusing to stop ${label} pid=${target}; command not repo-verifier-owned (${cmd:+$(momo_guard_command_label "$cmd")})" >&2
      blocked=1
    fi
  done
  [ "$blocked" -eq 0 ] || return 1

  for target in $killable; do
    cmd="$(momo_guard_pid_command "$target")"
    if [ "$trusted_root" != "1" ]; then
      momo_guard_command_matches "$cmd" || continue
    fi
    name="$(momo_guard_command_label "$cmd")"
    echo "[runtime-guard] stopping ${label} pid=${target} process=${name}"
    kill "$target" 2>/dev/null || true
  done
  sleep 1

  for target in $killable; do
    kill -0 "$target" 2>/dev/null || continue
    cmd="$(momo_guard_pid_command "$target")"
    if [ "$trusted_root" = "1" ] || momo_guard_command_matches "$cmd"; then
      name="$(momo_guard_command_label "$cmd")"
      echo "[runtime-guard] force stopping ${label} pid=${target} process=${name}"
      kill -9 "$target" 2>/dev/null || true
    else
      echo "[runtime-guard] refusing to force stop ${label} pid=${target}; command no longer matches repo verifier ownership" >&2
      return 1
    fi
  done
}

momo_cleanup_tracked_pids() {
  local label="$1"
  shift
  local pid
  for pid in "$@"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[runtime-guard] stopping ${label} pid=${pid}"
      momo_kill_tree "$pid" "$label" 1 || true
    fi
  done
}

momo_cleanup_port_listener() {
  local port="${1:-}"
  local label="${2:-port-listener}"
  [ -n "$port" ] || return 0
  case "$port" in
    *[!0-9]*)
      echo "[runtime-guard] invalid port for ${label}: ${port}" >&2
      return 1
      ;;
  esac

  if ! command -v lsof >/dev/null 2>&1; then
    echo "[runtime-guard] lsof unavailable; skip ${label} port=${port}"
    return 0
  fi

  local pids pid cmd blocked=0 cleaned=0
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "[runtime-guard] no listener for ${label} port=${port}"
    return 0
  fi

  for pid in $pids; do
    cmd="$(momo_guard_pid_command "$pid")"
    if momo_guard_command_matches "$cmd"; then
      echo "[runtime-guard] stopping stale ${label} listener pid=${pid} port=${port} process=$(momo_guard_command_label "$cmd")"
      momo_kill_tree "$pid" "$label listener" || true
      cleaned=$((cleaned + 1))
    else
      echo "[runtime-guard] leaving non-verifier ${label} listener pid=${pid} port=${port} process=$(momo_guard_command_label "$cmd")" >&2
      blocked=1
    fi
  done

  if [ "$blocked" -ne 0 ]; then
    return 1
  fi
  [ "$cleaned" -eq 0 ] || sleep 1
  return 0
}

momo_cleanup_runtime_ports() {
  local label="$1"
  shift
  local port failed=0
  for port in "$@"; do
    [ -n "${port:-}" ] || continue
    momo_cleanup_port_listener "$port" "$label" || failed=1
  done
  return "$failed"
}

momo_cleanup_repo_processes() {
  local label="${1:-repo-process}"
  local root
  root="$(momo_guard_repo_root)"
  [ -n "$root" ] || return 0
  local tmp="${TMPDIR:-/tmp}/momo-runtime-guard-pids-$$.txt"
  ps ax -o pid= -o command= 2>/dev/null | while read -r pid cmd; do
    [ -n "${pid:-}" ] || continue
    case "$cmd" in
      *"$root/"*)
        if momo_guard_command_matches "$cmd"; then
          printf '%s\n' "$pid"
        fi
        ;;
    esac
  done | awk '!seen[$0]++' >"$tmp"
  local pid
  while read -r pid; do
    [ -n "$pid" ] || continue
    momo_kill_tree "$pid" "$label" || true
  done <"$tmp"
  rm -f "$tmp"
}
