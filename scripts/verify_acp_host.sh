#!/usr/bin/env bash
# MOMO-531 deterministic ACP host verifier. Docker execution remains owned by
# the orchestrator; this worker gate exercises the real stdio subprocess path.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

API_PORT=28110
CENTRIFUGO_PORT=28111
POSTGRES_PORT=28112
MOCK_AGENT_PORT=28113

COLLISIONS=$(grep -rn '2811[0-3]' "$REPO_ROOT/scripts" "$REPO_ROOT/infra" \
  --exclude='verify_acp_host.sh' --exclude='local_gate.sh' 2>/dev/null || true)
if [ -n "$COLLISIONS" ]; then
  echo "[acp-host] reserved port collision detected" >&2
  printf '%s\n' "$COLLISIONS" >&2
  exit 1
fi

echo "[acp-host] reserved ports: api=$API_PORT centrifugo=$CENTRIFUGO_PORT postgres=$POSTGRES_PORT mock=$MOCK_AGENT_PORT"
PYTHONPYCACHEPREFIX="${TMPDIR:-/tmp}/momo-acp-pycache" \
  python3 -m py_compile "$REPO_ROOT/scripts/mock_acp_agent.py"
bash -n "$REPO_ROOT/scripts/verify_acp_host.sh"

MOMO_ACP_MOCK_AGENT="$REPO_ROOT/scripts/mock_acp_agent.py" \
  swift test --disable-sandbox \
  --package-path "$REPO_ROOT/workers/WorkHostDaemon" \
  --filter ACPHostTests

if grep -R -F 'mock progress' "$REPO_ROOT/server" "$REPO_ROOT/relay" >/dev/null 2>&1; then
  echo "[acp-host] raw ACP marker leaked into server/relay source" >&2
  exit 1
fi

echo "[acp-host] PASS: initialize -> session/new -> session/prompt, update/card projection, approval allow/reject, terminal PTY delegation"

if [ "${MOMO_ACP_REQUIRE_REAL:-0}" = "1" ]; then
  command -v opencode >/dev/null 2>&1 || {
    echo "[acp-host] opencode is required for real ACP smoke" >&2
    exit 1
  }
  command -v claude-agent-acp >/dev/null 2>&1 || {
    echo "[acp-host] claude-agent-acp is required for real ACP smoke" >&2
    exit 1
  }
  echo "[acp-host] real agents are installed; run the credentialed prompts from docs/RUN.md"
else
  echo "[acp-host] SKIP: runtime-unverified(external ACP agent credentials) - set MOMO_ACP_REQUIRE_REAL=1 after opencode and claude-agent-acp login"
fi
