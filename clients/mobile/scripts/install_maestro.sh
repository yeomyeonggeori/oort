#!/usr/bin/env bash
# =============================================================================
# clients/mobile/scripts/install_maestro.sh — Maestro CLI for the phone lane
#
# Installs to ~/.maestro (the vendor installer's own layout) and verifies the
# binary answers. It does NOT edit any shell profile: lane-phone.sh puts
# ~/.maestro/bin on PATH itself, precisely so the lane works in a fresh
# non-interactive shell where a profile edit would never have been sourced.
#
# Idempotent — an existing install is reported and left alone unless --force.
# =============================================================================
set -euo pipefail

MAESTRO_HOME="$HOME/.maestro"
MAESTRO_BIN="$MAESTRO_HOME/bin/maestro"
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "[maestro] unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Maestro is a JVM tool; the installer will pull a JDK if none is present, but
# failing here is a clearer message than failing inside it.
command -v curl >/dev/null 2>&1 || { echo "[maestro] curl is required" >&2; exit 1; }

if [ -x "$MAESTRO_BIN" ] && [ "$FORCE" = "0" ]; then
  echo "[maestro] already installed: $("$MAESTRO_BIN" --version 2>/dev/null | tail -1)"
  echo "[maestro] re-install with: bash clients/mobile/scripts/install_maestro.sh --force"
  exit 0
fi

echo "[maestro] installing to $MAESTRO_HOME"
curl -fsSL "https://get.maestro.mobile.dev" | bash

[ -x "$MAESTRO_BIN" ] || {
  echo "[maestro] installer finished but $MAESTRO_BIN is not executable" >&2
  exit 1
}

version="$("$MAESTRO_BIN" --version 2>/dev/null | tail -1)"
[ -n "$version" ] || { echo "[maestro] installed binary did not report a version" >&2; exit 1; }
echo "[maestro] ok: $version"
echo "[maestro] the lane finds it on its own; nothing to add to your PATH."
