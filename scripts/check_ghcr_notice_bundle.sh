#!/usr/bin/env bash
# Stale-bundle + Dockerfile COPY gate for the GHCR notice files (#1332).
#
# Role boundary vs #1225:
#   scripts/check_cargo_licenses.sh / scripts/check_npm_licenses.mjs
#     = allow/deny POLICY over cargo + npm graphs
#   this script
#     = ATTRIBUTION artifact freshness (lockfile hashes, committed bundle
#       bytes, Docker COPY of LICENSE/NOTICE/index/generated bundle, hash file)
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

exec python3 "$SCRIPT_DIR/generate_ghcr_notice_bundle.py" check "$@"
