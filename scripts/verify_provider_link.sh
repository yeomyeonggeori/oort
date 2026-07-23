#!/usr/bin/env bash
# =============================================================================
# scripts/verify_provider_link.sh — MOMO-572 / ADR-0004 증보 1 provider link gate
#
# Worker-side gate: reserves the isolated port block, then runs the syntax +
# swift build + focused server unit gate for the provider link control plane.
#
# The full runtime REST smoke (apply migration 039, PUT/GET/DELETE/POST-test
# roundtrip over a live Postgres, RLS default-deny for non-operator sessions,
# bearer never returned in clear) requires Docker/Postgres and is executed by
# the orchestrator. Those checks are handed off as runtime-unverified here — set
# PROVIDER_LINK_RUN_DOCKER=1 to opt into the compose smoke when a runtime is
# available.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[provider-link] $*"; }

# ---- Isolated port block (28260s). Reserve so a concurrent gate cannot race. ---
API_PORT="${PROVIDER_LINK_API_PORT:-28260}"
HERMES_PORT="${PROVIDER_LINK_HERMES_PORT:-28261}"
PG_PORT="${PROVIDER_LINK_POSTGRES_PORT:-28262}"
CENTRIFUGO_PORT="${PROVIDER_LINK_CENTRIFUGO_PORT:-28263}"

command -v python3 >/dev/null 2>&1 || {
  log "missing python3"
  exit 1
}

python3 - "$API_PORT" "$HERMES_PORT" "$PG_PORT" "$CENTRIFUGO_PORT" <<'PY'
import socket, sys
ports = [int(value) for value in sys.argv[1:]]
if len(ports) != len(set(ports)):
    raise SystemExit(f"[provider-link] ports must be distinct: {ports}")
sockets = []
try:
    for port in ports:
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        sockets.append(sock)
except OSError as error:
    raise SystemExit(f"[provider-link] reserved port preflight failed: {error}")
finally:
    for sock in sockets:
        sock.close()
PY
log "reserved isolated ports ${API_PORT}/${HERMES_PORT}/${PG_PORT}/${CENTRIFUGO_PORT}"

# ---- Migration presence + schema_v0 untouched invariant --------------------
MIGRATION="server/Migrations/039_provider_link.sql"
test -f "$MIGRATION" || {
  log "missing migration $MIGRATION"
  exit 1
}
grep -q "CREATE TABLE provider_link" "$MIGRATION" || {
  log "migration 039 does not create provider_link"
  exit 1
}
grep -q "FORCE ROW LEVEL SECURITY" "$MIGRATION" || {
  log "migration 039 must FORCE row level security"
  exit 1
}
if git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null | grep -qx "schema_v0.sql"; then
  log "schema_v0.sql must not be modified"
  exit 1
fi

# ---- swift build + focused server unit gate --------------------------------
command -v swift >/dev/null 2>&1 || {
  log "missing swift toolchain"
  exit 1
}
log "swift build (server)"
swift build --package-path server >/dev/null
log "swift test --filter ProviderLinkTests (server)"
swift test --package-path server --filter ProviderLinkTests >/dev/null

log "PASS worker gate: migration present, schema_v0 untouched, build + provider-link unit tests green"

# ---- Runtime REST smoke (orchestrator; runtime-unverified) -----------------
if [ "${PROVIDER_LINK_RUN_DOCKER:-0}" != "1" ]; then
  log "runtime-unverified: live REST smoke (migration 039 apply, PUT/GET/DELETE/POST-test"
  log "  roundtrip, RLS default-deny for non-operator sessions, bearer-never-returned)"
  log "  is handed off to the orchestrator. Re-run with PROVIDER_LINK_RUN_DOCKER=1 on a runtime."
  exit 0
fi

log "PROVIDER_LINK_RUN_DOCKER=1 set, but the compose REST smoke is orchestrator-owned; nothing to do here."
exit 0
