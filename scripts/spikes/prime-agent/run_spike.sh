#!/usr/bin/env bash
# Spike #1120 — host-side runner. Reproduces every measurement in
# docs/planning/research/2026-08-06-prime-agent-spike.md.
#
#   scripts/spikes/prime-agent/run_spike.sh build
#   scripts/spikes/prime-agent/run_spike.sh nocreds        # login wall, exact text
#   scripts/spikes/prime-agent/run_spike.sh text           # prompt → delta → relay
#   scripts/spikes/prime-agent/run_spike.sh long           # delta-buffering ratio
#   scripts/spikes/prime-agent/run_spike.sh steer          # steer lands mid-run
#   scripts/spikes/prime-agent/run_spike.sh approve        # extension_ui → approval card
#   scripts/spikes/prime-agent/run_spike.sh reject         # red proof: denial blocks
#   scripts/spikes/prime-agent/run_spike.sh kernel         # cold/warm cell latency
#   scripts/spikes/prime-agent/run_spike.sh all
#
# Real relay to a LOCAL stack (never production). Set these and the scenarios
# POST for real instead of writing out/relay.jsonl; the container then needs a
# network, so SPIKE_NETWORK must not be `none`:
#
#   export SPIKE_NETWORK=bridge
#   export SPIKE_RELAY="--relay rest --api-base http://host.docker.internal:22930 \
#     --workspace <ws-uuid> --channel <ch-uuid> --token momo_agent_v1.<ws>.<secret>"
#
# Getting that token on the local Rust stack: there is no mint route — insert an
# `agent_bearer` row whose token_hash is digest('<token>','sha256') with scopes
# ARRAY['messages:write'] for an active agent member. See the spike doc §5.5.
# Note the scope list is closed: the same token gets 403 on message history.
#
# Nothing here touches production, and no provider credential is read or
# injected — the model is a loopback mock inside the container.
# The container is the isolation boundary: prime-agent is NOT a sandbox.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SPIKE_IMAGE:-prime-spike:0.7.0}"
OUT="${SPIKE_OUT_DIR:-${TMPDIR:-/tmp}/prime-spike-out}"
mkdir -p "$OUT"

run() { # run <mock-scenario> <adapter-scenario> [args...]
  local mock="$1" scen="$2"; shift 2
  echo "── [$scen] mock=$mock ─────────────────────────────────" >&2
  docker run --rm --network "${SPIKE_NETWORK:-none}" \
    -v "$HERE:/spike:ro" \
    -v "$OUT:/work/out" \
    -e "MOCK_SCENARIO=$mock" \
    -e "MOCK_TOOL_SLEEP=${MOCK_TOOL_SLEEP:-1}" \
    --add-host=host.docker.internal:host-gateway \
    "$IMAGE" bash /spike/container_entry.sh "$scen" "$@" ${SPIKE_RELAY:-}
}

case "${1:-all}" in
  build)
    docker build -t "$IMAGE" "$HERE"
    ;;
  nocreds)
    # No models.json, no mock. Records the exact refusal so the "who has to
    # run /login, and where" question is answered from evidence.
    run none nocreds --timeout 40 --prompt "hello"
    ;;
  text)
    run text text --timeout 90 --prompt "hello from oort"
    ;;
  long)
    run long text --timeout 120 --prompt "write a long answer"
    ;;
  steer)
    MOCK_TOOL_SLEEP=6 run tool steer --timeout 150 --prompt "run a slow cell then report"
    ;;
  approve)
    cp "$HERE/approval_gate.ts" "$OUT/approval_gate.ts"
    run tool extension-ui --timeout 180 --extension /work/out/approval_gate.ts --ui-policy approve --prompt "run a cell"
    ;;
  reject)
    cp "$HERE/approval_gate.ts" "$OUT/approval_gate.ts"
    run tool extension-ui --timeout 180 --extension /work/out/approval_gate.ts --ui-policy deny --prompt "run a cell"
    ;;
  kernel)
    run tool2 text --timeout 240 --prompt "run two cells"
    ;;
  all)
    for s in nocreds text long steer approve reject kernel; do
      rm -f "$OUT/relay.jsonl"
      "$0" "$s" || echo "!! $s failed" >&2
    done
    ;;
  *)
    echo "unknown scenario: $1" >&2; exit 2
    ;;
esac

echo "artifacts: $OUT" >&2
