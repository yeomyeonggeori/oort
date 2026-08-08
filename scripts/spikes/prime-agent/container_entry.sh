#!/usr/bin/env bash
# Spike #1120/#1130 — in-container driver. Runs ONLY inside prime-spike:0.7.0.
#
# Sets up the credential-free provider (loopback mock), then runs one scenario
# of rpc_adapter.py. Never reads a provider credential; ~/.prime/agent/auth.json
# is deliberately never populated.
#
# ── Workspace isolation (#1130 ③) ────────────────────────────────────────────
# The harness's *global* state lives in the agent dir, which prime-agent resolves
# as `$PRIME_AGENT_CODING_AGENT_DIR` else `$HOME/.prime/agent` (measured:
# `dist/config.js:getAgentDir`, and `rlm/harness.py:_agent_dir` does the same on
# the kernel side). So one container serving two workspaces shares one harness
# store unless something moves that path.
#
#   SPIKE_WORKSPACE=<id>            per-workspace HOME under /work/homes/<id>
#   SPIKE_ISOLATION=off|home|full   `off` reproduces the leak on purpose
#
# HOME is the chosen lever rather than PRIME_AGENT_CODING_AGENT_DIR because the
# agent dir is not the only tenant surface under $HOME — sessions, auth.json,
# models.json, `~/.prime/config.json` (prime-inference-auth.js) and the shell's
# own dotfiles all sit there, and the kernel runs arbitrary code as this user.
# Moving one env var would isolate the harness and leave the rest co-tenant.
#
# `full` adds TMPDIR, and measurement says `full` is the one to use. RPC mode is
# daemon-backed and the daemon socket dir is `join(tmpdir(), "prime-agent-" +
# getuid())` (`daemon-socket.js:195`) — keyed by **uid, not by HOME**. Measured
# with two workspaces at the same uid:
#   home  → both meet at one /tmp/prime-agent-0; ws-b never gets its own
#           `daemon-workers/` registry because ws-a already owns the supervisor
#   full  → /work/tmp/<ws>/prime-agent-0 each, one registry each
# Harness state stayed separate under `home` too, so `home` is enough for the
# #1130 ③ question as literally asked — but it leaves the daemon control plane
# co-tenant, and that is a second tenancy surface, not a cosmetic one.
#
# What is deliberately NOT isolated: the kernel venv. It is a package install
# (ipykernel + the eight bundled skills), it holds no tenant data, and it costs
# 80.3s and eight broken skills to rebuild offline (spike doc §5-⑴). It is
# pinned to the image's copy via PRIME_AGENT_KERNEL_VENV, which exists exactly
# for this (`dist/core/kernel/bootstrap.js:getKernelVenvDir`).
set -euo pipefail

SCENARIO="${1:?usage: container_entry.sh <scenario> [extra rpc_adapter args...]}"
shift || true

OUT="${SPIKE_OUT:-/work/out}"
SHARED_AGENT_DIR="${SPIKE_SHARED_AGENT_DIR:-/root/.prime/agent}"
WS="${SPIKE_WORKSPACE:-}"
ISOLATION="${SPIKE_ISOLATION:-off}"
TAG="$SCENARIO${WS:+-$WS}"

if [ -n "$WS" ] && [ "$ISOLATION" != "off" ]; then
  export HOME="/work/homes/$WS"
  mkdir -p "$HOME/.prime/agent"
  # Share only the immutable, credential-free parts of the image's agent dir.
  export PRIME_AGENT_KERNEL_VENV="$SHARED_AGENT_DIR/kernel-venv"
  # `bin/` is the vendored rg/fd the agent shells out to — same reasoning.
  [ -d "$SHARED_AGENT_DIR/bin" ] && ln -sfn "$SHARED_AGENT_DIR/bin" "$HOME/.prime/agent/bin"
  if [ "$ISOLATION" = "full" ]; then
    export TMPDIR="/work/tmp/$WS"
    mkdir -p "$TMPDIR"
  fi
fi

mkdir -p "$OUT" "$HOME/.prime/agent"

if [ "$SCENARIO" != "nocreds" ]; then
  cat > "$HOME/.prime/agent/models.json" <<'JSON'
{
  "providers": {
    "spike-mock": {
      "baseUrl": "http://127.0.0.1:8099/v1",
      "api": "openai-completions",
      "apiKey": "not-a-secret-loopback-mock",
      "authHeader": true,
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          "id": "spike-mock-1",
          "name": "Spike Mock 1",
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

  export MOCK_REQUEST_LOG="$OUT/mock-requests-$TAG.jsonl"
  : > "$MOCK_REQUEST_LOG"
  MOCK_SCENARIO="${MOCK_SCENARIO:-text}" python3 /spike/mock_provider.py &
  MOCK_PID=$!
  # NOT `exec` below, and this trap is why. The tenancy probe runs two
  # workspaces back to back in ONE container; an exec'd adapter orphans the mock
  # on port 8099, and workspace B then silently answers off workspace A's turn
  # counter instead of getting its own scripted cell. Measured that once — the
  # run looked green and produced no probe line at all.
  trap 'kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:8099/v1/models" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
fi

python3 /spike/rpc_adapter.py --scenario "$SCENARIO" --out "$OUT" --tag "$TAG" "$@"
