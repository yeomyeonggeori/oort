#!/bin/sh
# =============================================================================
# WH-1 (MOMO-579 / ADR-0114 증보1 C) work host sidecar entrypoint.
#
# Starts the selected embedded engine server (only opencode runs a long-lived
# server; goose is spawned per-session over ACP stdio by momo-workd, and
# codex-local is never bundled) and then execs momo-workd as PID-adjacent main.
#
# ADR-0004: no provider key / OAuth token is read or injected here. opencode
# boots WITHOUT a model key (keys are only needed at model-run time, supplied by
# the user host); the sidecar is a credential consumer, not a store.
# =============================================================================
set -eu

ENGINE="${MOMO_WORKD_ENGINE:-opencode}"

case "$ENGINE" in
  opencode)
    if command -v opencode >/dev/null 2>&1; then
      OPENCODE_PORT="${OPENCODE_SERVER_PORT:-4096}"
      OPENCODE_HOST="${OPENCODE_SERVER_HOSTNAME:-127.0.0.1}"
      echo "[workhost] starting opencode serve on ${OPENCODE_HOST}:${OPENCODE_PORT}"
      # Runs in the background; momo-workd connects over HTTP+SSE. Auth is opt-in
      # via OPENCODE_SERVER_PASSWORD (HTTP basic, user=opencode).
      opencode serve --port "$OPENCODE_PORT" --hostname "$OPENCODE_HOST" &
    else
      echo "[workhost] WARN: opencode binary not found on PATH" >&2
    fi
    ;;
  goose)
    echo "[workhost] engine=goose (ACP spawned per-session by momo-workd)"
    ;;
  codex-local)
    echo "[workhost] engine=codex-local (connects to user host Codex; not bundled)"
    ;;
  *)
    echo "[workhost] WARN: unknown MOMO_WORKD_ENGINE='$ENGINE', defaulting to opencode behavior" >&2
    ;;
esac

echo "[workhost] exec momo-workd"
exec momo-workd "$@"
