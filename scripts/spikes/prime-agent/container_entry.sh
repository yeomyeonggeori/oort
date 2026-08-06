#!/usr/bin/env bash
# Spike #1120 — in-container driver. Runs ONLY inside prime-spike:0.7.0.
#
# Sets up the credential-free provider (loopback mock), then runs one scenario
# of rpc_adapter.py. Never reads a provider credential; ~/.prime/agent/auth.json
# is deliberately never created.
set -euo pipefail

SCENARIO="${1:?usage: container_entry.sh <scenario> [extra rpc_adapter args...]}"
shift || true

OUT="${SPIKE_OUT:-/work/out}"
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

  export MOCK_REQUEST_LOG="$OUT/mock-requests-$SCENARIO.jsonl"
  : > "$MOCK_REQUEST_LOG"
  MOCK_SCENARIO="${MOCK_SCENARIO:-text}" python3 /spike/mock_provider.py &
  MOCK_PID=$!
  trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://127.0.0.1:8099/v1/models" >/dev/null 2>&1; then break; fi
    sleep 0.25
  done
fi

exec python3 /spike/rpc_adapter.py --scenario "$SCENARIO" --out "$OUT" "$@"
