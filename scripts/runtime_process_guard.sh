#!/usr/bin/env bash
# Shared runtime verifier process/port cleanup helpers.
#
# These helpers are intentionally conservative. A repo-looking command is not
# ownership proof: a local gate may only stop a process that inherited a valid
# gate-run marker. This keeps dogfood/user MomoServer processes untouched even
# when they use the same checkout and executable names as verifiers.

momo_guard_repo_root() {
  local root="${MOMO_RUNTIME_GUARD_REPO_ROOT:-${REPO_ROOT:-}}"
  if [ -z "$root" ] && command -v git >/dev/null 2>&1; then
    root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  printf '%s' "$root"
}

momo_guard_state_root() {
  if [ -n "${MOMO_RUNTIME_GUARD_STATE_ROOT:-}" ]; then
    printf '%s' "$MOMO_RUNTIME_GUARD_STATE_ROOT"
    return 0
  fi

  local root hash
  root="$(momo_guard_repo_root)"
  [ -n "$root" ] || return 1
  hash="$(printf '%s' "$root" | shasum -a 256 2>/dev/null | awk '{ print substr($1, 1, 16) }')"
  if [ -z "$hash" ]; then
    hash="$(printf '%s' "$root" | cksum | awk '{ print $1 }')"
  fi
  printf '%s/momo-runtime-guard/%s' "${TMPDIR:-/tmp}" "$hash"
}

momo_guard_file_uid() {
  stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1" 2>/dev/null || true
}

momo_guard_marker_value() {
  local marker="${1:-}"
  local key="${2:-}"
  [ -n "$marker" ] && [ -n "$key" ] || return 1
  sed -n "s/^${key}=//p" "$marker/owner" 2>/dev/null | sed -n '1p'
}

momo_guard_validate_marker() {
  local marker="${1:-}"
  local state_root root marker_uid current_uid run_id
  [ -n "$marker" ] || return 1
  state_root="$(momo_guard_state_root)" || return 1
  root="$(momo_guard_repo_root)"
  case "$marker" in
    "$state_root"/run-*) ;;
    *) return 1 ;;
  esac
  [ -d "$marker" ] && [ ! -L "$marker" ] && [ -f "$marker/owner" ] && [ ! -L "$marker/owner" ] || return 1
  marker_uid="$(momo_guard_file_uid "$marker")"
  current_uid="$(id -u)"
  [ -n "$marker_uid" ] && [ "$marker_uid" = "$current_uid" ] || return 1
  [ "$(momo_guard_marker_value "$marker" repo_root)" = "$root" ] || return 1
  run_id="$(momo_guard_marker_value "$marker" run_id)"
  [ -n "$run_id" ] && [ "$(basename "$marker")" = "run-$run_id" ] || return 1
}

momo_guard_pid_marker() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  if [ -r "/proc/$pid/environ" ]; then
    tr '\000' '\n' <"/proc/$pid/environ" 2>/dev/null \
      | sed -n 's/^MOMO_GATE_RUN_MARKER=//p' \
      | sed -n '1p'
    return 0
  fi
  ps eww -p "$pid" -o command= 2>/dev/null \
    | tr ' ' '\n' \
    | sed -n 's/^MOMO_GATE_RUN_MARKER=//p' \
    | sed -n '1p'
}

momo_guard_marker_active() {
  local marker="${1:-}"
  local gate_pid expected_start actual_start
  momo_guard_validate_marker "$marker" || return 1
  gate_pid="$(momo_guard_marker_value "$marker" gate_pid)"
  case "$gate_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$gate_pid" 2>/dev/null || return 1
  expected_start="$(momo_guard_marker_value "$marker" gate_start)"
  actual_start="$(LC_ALL=C ps -p "$gate_pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -n "$expected_start" ] && [ "$actual_start" = "$expected_start" ]
}

momo_guard_begin_gate_run() {
  local run_id="${1:-}"
  local state_root marker root gate_start
  case "$run_id" in
    ''|*[!A-Za-z0-9._-]*)
      echo "[runtime-guard] invalid gate run id" >&2
      return 1
      ;;
  esac
  root="$(momo_guard_repo_root)"
  [ -n "$root" ] || return 1
  gate_start="$(LC_ALL=C ps -p $$ -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -z "$gate_start" ]; then
    echo "[runtime-guard] cannot capture gate process start identity" >&2
    return 1
  fi
  state_root="$(momo_guard_state_root)" || return 1
  marker="$state_root/run-$run_id"
  umask 077
  mkdir -p "$state_root"
  if [ -e "$marker" ]; then
    echo "[runtime-guard] refusing existing gate marker: $marker" >&2
    return 1
  fi
  mkdir "$marker"
  printf 'repo_root=%s\nrun_id=%s\ngate_pid=%s\ngate_start=%s\ncreated_at_utc=%s\n' \
    "$root" \
    "$run_id" \
    "$$" \
    "$gate_start" \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    >"$marker/owner"
  export MOMO_GATE_RUN_MARKER="$marker"
  printf '%s' "$marker"
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

momo_guard_process_owned_by_marker() {
  local pid="${1:-}"
  local expected_marker="${2:-}"
  local cmd actual_marker
  [ -n "$pid" ] || return 1
  cmd="$(momo_guard_pid_command "$pid")"
  momo_guard_command_matches "$cmd" || return 1
  actual_marker="$(momo_guard_pid_marker "$pid")"
  [ -n "$actual_marker" ] || return 1
  momo_guard_validate_marker "$actual_marker" || return 1
  if [ -n "$expected_marker" ]; then
    [ "$actual_marker" = "$expected_marker" ] || return 1
  fi
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
  local expected_marker="${4:-}"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  local pids
  pids="$(momo_guard_collect_tree "$pid" | awk '!seen[$0]++')"
  local killable="" blocked=0 target cmd name
  for target in $pids; do
    kill -0 "$target" 2>/dev/null || continue
    cmd="$(momo_guard_pid_command "$target")"
    if [ "$trusted_root" = "1" ] || { momo_guard_command_matches "$cmd" && { [ -z "$expected_marker" ] || momo_guard_process_owned_by_marker "$target" "$expected_marker"; }; }; then
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
      if [ -n "$expected_marker" ]; then
        momo_guard_process_owned_by_marker "$target" "$expected_marker" || continue
      fi
    fi
    name="$(momo_guard_command_label "$cmd")"
    echo "[runtime-guard] stopping ${label} pid=${target} process=${name}"
    kill "$target" 2>/dev/null || true
  done
  sleep 1

  for target in $killable; do
    kill -0 "$target" 2>/dev/null || continue
    cmd="$(momo_guard_pid_command "$target")"
    if [ "$trusted_root" = "1" ] || { momo_guard_command_matches "$cmd" && { [ -z "$expected_marker" ] || momo_guard_process_owned_by_marker "$target" "$expected_marker"; }; }; then
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

  local pids pid cmd marker blocked=0 cleaned=0
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    echo "[runtime-guard] no listener for ${label} port=${port}"
    return 0
  fi

  for pid in $pids; do
    cmd="$(momo_guard_pid_command "$pid")"
    marker="$(momo_guard_pid_marker "$pid")"
    if momo_guard_command_matches "$cmd" && momo_guard_validate_marker "$marker"; then
      if [ "$marker" != "${MOMO_GATE_RUN_MARKER:-}" ] && momo_guard_marker_active "$marker"; then
        echo "[runtime-guard] leaving active gate ${label} listener pid=${pid} port=${port} process=$(momo_guard_command_label "$cmd")" >&2
        blocked=1
        continue
      fi
      echo "[runtime-guard] stopping stale ${label} listener pid=${pid} port=${port} process=$(momo_guard_command_label "$cmd")"
      momo_kill_tree "$pid" "$label listener" 0 "$marker" || true
      cleaned=$((cleaned + 1))
    else
      echo "[runtime-guard] leaving unowned ${label} listener pid=${pid} port=${port} process=$(momo_guard_command_label "$cmd")" >&2
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
  momo_cleanup_stale_gate_runs "${1:-repo-process}"
}

momo_cleanup_gate_marker() {
  local marker="${1:-}"
  local label="${2:-gate-run}"
  local tmp pid pid_list found=0 failed=0
  momo_guard_validate_marker "$marker" || {
    echo "[runtime-guard] refusing invalid gate marker cleanup" >&2
    return 1
  }
  tmp="${TMPDIR:-/tmp}/momo-runtime-guard-owned-$$.txt"
  : >"$tmp"
  if ! pid_list="$(ps ax -o pid= 2>/dev/null)"; then
    echo "[runtime-guard] cannot inspect process table; keeping marker for ${label}" >&2
    rm -f "$tmp"
    return 1
  fi
  for pid in $pid_list; do
    [ -n "$pid" ] || continue
    if momo_guard_process_owned_by_marker "$pid" "$marker"; then
      printf '%s\n' "$pid" >>"$tmp"
    fi
  done
  awk '!seen[$0]++' "$tmp" >"$tmp.unique"
  while read -r pid; do
    [ -n "$pid" ] || continue
    found=1
    momo_kill_tree "$pid" "$label" 0 "$marker" || failed=1
  done <"$tmp.unique"
  rm -f "$tmp" "$tmp.unique"

  if [ "$failed" -eq 0 ]; then
    rmdir "$marker" 2>/dev/null || {
      rm -f "$marker/owner"
      rmdir "$marker" 2>/dev/null || true
    }
  fi
  if [ "$found" -eq 0 ]; then
    echo "[runtime-guard] no owned processes for ${label}"
  fi
  return "$failed"
}

momo_cleanup_stale_gate_runs() {
  local label="${1:-stale-gate-run}"
  local state_root marker failed=0
  state_root="$(momo_guard_state_root)" || return 0
  [ -d "$state_root" ] || return 0
  for marker in "$state_root"/run-*; do
    [ -d "$marker" ] || continue
    [ "$marker" = "${MOMO_GATE_RUN_MARKER:-}" ] && continue
    if momo_guard_marker_active "$marker"; then
      echo "[runtime-guard] leaving active gate marker: $(basename "$marker")"
      continue
    fi
    momo_cleanup_gate_marker "$marker" "$label" || failed=1
  done
  return "$failed"
}
