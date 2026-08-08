#!/usr/bin/env bash
# oort prime adapter — container entrypoint. Draws the isolation boundary, then
# runs whatever it was told to run.
#
# ## Why this file exists at all
#
# prime-agent is **not a sandbox**: it runs shell commands and a persistent
# IPython kernel with the privileges of whoever launched it
# (`research/2026-08-06-prime-agent-ade-herdr.md` §①). So the container is the
# boundary, and inside the container this script is what keeps two workspaces
# from becoming one tenant.
#
# ## The isolation contract (#1130 ③, measured)
#
#   HOME    = /work/homes/<workspace>     per-workspace agent dir, sessions,
#                                         auth.json, models.json, dotfiles
#   TMPDIR  = /work/tmp/<workspace>       per-workspace daemon socket dir
#
# `HOME` rather than `PRIME_AGENT_CODING_AGENT_DIR` because the agent dir is not
# the only tenant surface under `$HOME` — sessions, `auth.json`, `models.json`,
# `~/.prime/config.json` and the shell's dotfiles all sit there, and the kernel
# runs arbitrary code as this user. Moving one env var would isolate the harness
# and leave the rest co-tenant.
#
# `TMPDIR` as well because the daemon socket directory is
# `join(tmpdir(), "prime-agent-" + getuid())` — keyed by **uid, not HOME**.
# Measured with two workspaces at one uid: with HOME alone they meet at one
# `/tmp/prime-agent-0` and the second never gets its own worker registry. Harness
# state was already separate at that point, so `home` answers #1130 ③ as asked —
# but it leaves the daemon control plane jointly owned, and that is a second
# tenancy surface, not a cosmetic one.
#
# What is deliberately shared: the kernel venv and the vendored `bin/` (rg, fd).
# They are package installs, hold no tenant data, and rebuilding them offline
# costs 80.3s and eight dead bundled skills (spike §5-⑴). `PRIME_AGENT_KERNEL_VENV`
# exists for exactly this.
#
# ## The unsafe lever
#
# `OORT_PRIME_ISOLATION=off|home` reproduces the pre-isolation world. It is the
# red proof's only door and it refuses to open without
# `OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1`, because a leak that can be switched on
# by a typo is not a boundary.
set -euo pipefail

WORKSPACE="${OORT_PRIME_WORKSPACE_ID:-${MOMO_PRIME_WORKSPACE_ID:-}}"
ISOLATION="${OORT_PRIME_ISOLATION:-full}"
ALLOW_UNSAFE="${OORT_PRIME_ALLOW_UNSAFE_ISOLATION:-0}"
SHARED_AGENT_DIR="${OORT_PRIME_SHARED_AGENT_DIR:-/opt/oort/agent-template}"
MOCK="${OORT_PRIME_MOCK_PROVIDER:-0}"
MOCK_PORT="${OORT_PRIME_MOCK_PORT:-8099}"

if [ -z "$WORKSPACE" ]; then
  echo "[oort-prime] OORT_PRIME_WORKSPACE_ID is required — isolation is named per workspace" >&2
  exit 2
fi

case "$ISOLATION" in
  full) ;;
  home|off)
    if [ "$ALLOW_UNSAFE" != "1" ]; then
      echo "[oort-prime] isolation=$ISOLATION is a red-proof lever; set OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1 to use it" >&2
      exit 2
    fi
    echo "[oort-prime] WARNING isolation=$ISOLATION — workspace state is NOT fully separated" >&2
    ;;
  *)
    echo "[oort-prime] unknown OORT_PRIME_ISOLATION: $ISOLATION (full|home|off)" >&2
    exit 2
    ;;
esac

if [ "$ISOLATION" != "off" ]; then
  export HOME="/work/homes/$WORKSPACE"
  mkdir -p "$HOME/.prime/agent"
  # Share only the immutable, credential-free parts of the image's agent dir.
  [ -d "$SHARED_AGENT_DIR/kernel-venv" ] && export PRIME_AGENT_KERNEL_VENV="$SHARED_AGENT_DIR/kernel-venv"
  [ -d "$SHARED_AGENT_DIR/bin" ] && ln -sfn "$SHARED_AGENT_DIR/bin" "$HOME/.prime/agent/bin"
  if [ "$ISOLATION" = "full" ]; then
    export TMPDIR="/work/tmp/$WORKSPACE"
    mkdir -p "$TMPDIR"
  fi
fi

mkdir -p "$HOME/.prime/agent"

if [ "$MOCK" = "1" ]; then
  # Credential-free provider for tests and for the image's own prewarm. A real
  # deployment does NOT take this branch: its provider credential is established
  # inside this container by the operator (ADR-0004 — provider credentials never
  # enter oort's servers, images, or ledger).
  cat > "$HOME/.prime/agent/models.json" <<JSON
{
  "providers": {
    "oort-mock": {
      "baseUrl": "http://127.0.0.1:${MOCK_PORT}/v1",
      "api": "openai-completions",
      "apiKey": "not-a-secret-loopback-mock",
      "authHeader": true,
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          "id": "oort-mock-1",
          "name": "oort mock 1",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
JSON
  MOCK_PORT="$MOCK_PORT" MOCK_MODEL_ID="oort-mock-1" \
    python3 "${OORT_PRIME_HOME:-/opt/oort/prime}/tests/mock_provider.py" &
  MOCK_PID=$!
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:${MOCK_PORT}/v1/models" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
fi

# One cleanup, one trap. Two `trap ... EXIT` lines would look like two jobs and
# behave as one — the second silently replaces the first.
#
# The mock has to die with us because the tenancy probe runs two workspaces back
# to back in ONE container: an orphan on the port makes the second workspace
# answer off the first one's turn counter. Measured once; the run looked green
# and produced no probe line at all.
#
# The daemon has to be reclaimed because it outlives the RPC client (spike §6) —
# stdin closes, sessions drop to 0, the daemon stays. `--force` is required or a
# non-interactive shutdown fails with "Shutdown requires confirmation in an
# interactive terminal" and the daemon survives silently.
cleanup() {
  prime-agent shutdown --force >/dev/null 2>&1 || true
  if [ -n "${MOCK_PID:-}" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# `exec` would skip the cleanup above, so the payload runs as a child and this
# shell forwards the stop signal to it. That forwarding is not ceremony: SIGTERM
# is how the adapter learns to close its open answer as `cancelled` rather than
# leaving a half sentence that looks finished (ADR-0155).
"$@" &
PAYLOAD_PID=$!
forward() { kill -TERM "$PAYLOAD_PID" 2>/dev/null || true; }
trap forward TERM INT
set +e
wait "$PAYLOAD_PID"
STATUS=$?
set -e
exit "$STATUS"
