#!/usr/bin/env bash
# =============================================================================
# clients/mobile/scripts/devtools-shell.sh — close the React Native DevTools
# windows a phone run opened (#5531). SOURCED by lane-phone.sh and measure.sh;
# nothing runs when it is sourced.
#
# ## Why
#
# React Native 0.86 opens its debugger as a standalone Electron app
# (`@react-native/debugger-shell`, started by Metro's dev-middleware through a
# dotslash launcher), not as a Chrome window. A tap that lands on the debug
# build's LogBox strip ("Open debugger to view warnings.") asks Metro to open the
# debugger, and the window it opens outlives the run: on 11-07 one such app was
# still holding five windows fifteen hours later. `CHROME_PATH=/usr/bin/false`
# (#5083) only blocks Metro's Chrome FALLBACK, and `react-native start` has no
# switch for the shell. `measure/automation.ts` now keeps the strip from being
# drawn in a run a test tool launched; this file is the backstop that leaves
# nothing behind if a window opens anyway.
#
# ## What it closes
#
# Only a process whose command line carries
#
#     --frontendUrl=<scheme>://<host>:<PORT>/...
#
# for the Metro port of THIS run, and only one that was not already there when
# the run began (a baseline PID list, taken once Metro is up): a window a person
# had open before the run is not this run's to close, and that holds when the run
# reused a Metro that was already serving the checkout. Another port is never
# touched.
#
# `--frontendUrl=` is how dev-middleware hands the shell its page (see
# `dev-middleware/dist/utils/DefaultToolLauncher.js`). Electron's helper
# processes carry `--type=...` instead and exit with the main one. The match is
# on the arguments and not on the launcher's path: the dotslash file
# `debugger-shell/bin/react-native-devtools` execs the real binary, so `ps` is
# not guaranteed to show that path. The Chrome fallback's `--app=<url>` is not
# matched either.
#
# ## How
#
# `kill -TERM <pid>` for each, a short wait, then `kill -KILL <pid>` for the ones
# TERM did not take. The leftovers are matched again first, so a PID that has
# been reused by something else is not signalled. Exact PIDs only: no pkill, no
# killall, no name patterns.
#
# ## Use
#
#   . "$APP_ROOT/scripts/devtools-shell.sh"
#   DEVTOOLS_BASELINE="$(devtools_baseline_for_port "$METRO_PORT")"   # once Metro is up
#   ...
#   devtools_shells_close "$METRO_PORT" "$DEVTOOLS_BASELINE"          # from the exit trap
#
# The close runs only after a baseline was taken. A run that died before Metro
# was up cannot have opened a window, and without a baseline every window on the
# port would look like its own.
#
# The tests (`__tests__/devtoolsShell.test.ts`) shadow `ps`, `kill` and `sleep`
# with functions, so no real process is listed or signalled there.
# =============================================================================

# A function of its own so a test can shadow `ps` with a fixed listing.
# `<pid> <full command line>`, one process per line. `-A` (every process; macOS's
# `ps` and procps both take it, where `-ax` is BSD-only) and `-ww` (no width limit,
# so a long `--frontendUrl=` is not cut off) are what make it the same on both.
devtools_ps_listing() {
  ps -A -ww -o pid=,command= 2>/dev/null || true
}

# One line to the run's own log, in its own voice when it has one (`say` in
# lane-phone.sh), on stderr otherwise.
devtools_note() {
  if declare -F say >/dev/null 2>&1; then
    say "$*"
  else
    printf '[devtools] %s\n' "$*" >&2
  fi
}

# <port> -> the PIDs, one per line, of the DevTools shells opened for the Metro
# on that port. `:PORT/` is anchored on both sides, so `:18081/` is not `:8081/`
# and `:80810/` is not either; the host is not pinned (dev-middleware builds the
# URL from its own base URL, which may say `localhost` or `127.0.0.1`).
devtools_pids_for_port() {
  local port="${1:-}"
  case "$port" in
    '' | *[!0-9]*) return 2 ;;
  esac
  devtools_ps_listing | awk -v port="$port" '
    $1 ~ /^[0-9]+$/ && $0 ~ ("[ ]--frontendUrl=https?://[^/? ]*:" port "/") { print $1 }
  ' || true
}

# <port> -> the same PIDs on ONE line, space-separated: the baseline a run keeps.
devtools_baseline_for_port() {
  devtools_pids_for_port "${1:-}" | tr '\n' ' ' || true
}

# <port> <baseline PIDs, space-separated> -> closes the DevTools shells that were
# opened for that port after the baseline was taken. Always returns 0: it runs
# from an exit trap and must not turn a finished run into a failed one.
devtools_shells_close() {
  local port="${1:-}" baseline="${2:-}" now pid ours="" left="" tries=0
  now="$(devtools_pids_for_port "$port")" || now=""
  # shellcheck disable=SC2086 # `now` is a list of PIDs: splitting is the point
  for pid in $now; do
    case " $baseline " in
      *" $pid "*) continue ;;
    esac
    [ "$pid" -gt 1 ] 2>/dev/null || continue
    [ "$pid" != "$$" ] && [ "$pid" != "${PPID:-0}" ] || continue
    ours="$ours $pid"
  done
  if [ -z "$ours" ]; then
    devtools_note "no DevTools window left open by this run (Metro :$port)"
    return 0
  fi
  # shellcheck disable=SC2086
  for pid in $ours; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # About three seconds for the app to quit on its own.
  while [ "$tries" -lt 15 ]; do
    now="$(devtools_pids_for_port "$port")" || now=""
    left=""
    # shellcheck disable=SC2086
    for pid in $ours; do
      case " $now " in
        *" $pid "*) left="$left $pid" ;;
      esac
    done
    [ -z "$left" ] && break
    sleep 0.2
    tries=$((tries + 1))
  done
  # shellcheck disable=SC2086
  for pid in $left; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  devtools_note "closed the DevTools window(s) this run opened (Metro :$port), pid:$ours${left:+ — needed SIGKILL:$left}"
  return 0
}
