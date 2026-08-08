#!/usr/bin/env bash
# oort prime adapter — host-side launcher.
#
#   adapters/prime/run.sh build                 # build the pinned image
#   adapters/prime/run.sh session [args...]     # one relayed session
#   adapters/prime/run.sh mock-session [args...]# same, with the loopback provider
#   adapters/prime/run.sh tenancy-leak          # red proof: isolation off -> leak
#   adapters/prime/run.sh tenancy               # isolation full -> no leak
#
# `session` needs the four oort settings in the environment (see adapter.yaml):
#
#   export OORT_PRIME_API_URL=http://127.0.0.1:8080
#   export OORT_PRIME_WORKSPACE_ID=... OORT_PRIME_CHANNEL_ID=...
#   export OORT_PRIME_AGENT_TOKEN=...            # an oort bearer, never a provider key
#   export OORT_PRIME_RUN_ID=...                 # optional, ADR-0158 D5
#
# The container's network is `none` by default because the adapter's provider is
# a loopback mock in the test scenarios. A real relay needs to reach oort, so
# `session` uses `bridge` and maps `host.docker.internal`. Nothing here points at
# production and nothing here reads a provider credential — the harness's own
# provider login lives inside the container (ADR-0004).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${OORT_PRIME_IMAGE:-oort-prime-adapter:0.7.0}"
OUT="${OORT_PRIME_OUT_DIR:-${TMPDIR:-/tmp}/oort-prime-out}"
WORKSPACE="${OORT_PRIME_WORKSPACE_ID:-ws-local}"
mkdir -p "$OUT"

# The oort settings are forwarded by name, never printed. A token on a command
# line is a token in `ps` output.
forward_env() {
  local names=(
    OORT_PRIME_API_URL OORT_PRIME_WORKSPACE_ID OORT_PRIME_CHANNEL_ID
    OORT_PRIME_AGENT_TOKEN OORT_PRIME_RUN_ID OORT_PRIME_AGENT_HANDLE
    OORT_PRIME_SEND_RUN_ID_FIELD OORT_PRIME_ALLOW_INSECURE_HTTP
    OORT_PRIME_UI_POLICY OORT_PRIME_FLUSH_CHARS OORT_PRIME_FLUSH_INTERVAL
    OORT_PRIME_MODEL
  )
  local name
  for name in "${names[@]}"; do
    if [ -n "${!name:-}" ]; then printf -- '-e\n%s\n' "$name"; fi
  done
}

docker_run() { # docker_run <network> <extra-env-file> -- <command...>
  local network="$1"; shift
  local -a env_args=()
  while IFS= read -r line; do [ -n "$line" ] && env_args+=("$line"); done < <(forward_env)
  docker run --rm --network "$network" \
    -v "$OUT:/work/out" \
    --add-host=host.docker.internal:host-gateway \
    -e "OORT_PRIME_WORKSPACE_ID=$WORKSPACE" \
    "${env_args[@]}" \
    "$@"
}

case "${1:-help}" in
  build)
    docker build -t "$IMAGE" -f "$HERE/container/Dockerfile" "$HERE"
    ;;
  session)
    shift
    docker_run "${OORT_PRIME_NETWORK:-bridge}" "$IMAGE" \
      python3 -m prime.adapter --transcript /work/out/transcript.json "$@"
    ;;
  mock-session)
    shift
    docker_run "${OORT_PRIME_NETWORK:-bridge}" \
      -e OORT_PRIME_MOCK_PROVIDER=1 \
      -e "MOCK_SCENARIO=${MOCK_SCENARIO:-text}" \
      -e "MOCK_TOOL_SLEEP=${MOCK_TOOL_SLEEP:-1}" \
      "$IMAGE" \
      python3 -m prime.adapter --model oort-mock/oort-mock-1 \
        --transcript /work/out/transcript.json "$@"
    ;;
  tenancy-leak|tenancy-home|tenancy)
    # #1130 ③ — two workspaces inside ONE container, as a shared worker host
    # would run them. `tenancy-leak` is the red proof: with isolation off, ws-b
    # must be able to read ws-a's global harness memory, and the probe exits
    # non-zero the day that stops being true.
    case "$1" in
      tenancy-leak) iso=off;  expect=expect-leak ;;
      tenancy-home) iso=home; expect=expect-isolated ;;
      tenancy)      iso=full; expect=expect-isolated ;;
    esac
    docker run --rm --network "${OORT_PRIME_NETWORK:-none}" \
      -v "$OUT:/work/out" \
      -e OORT_PRIME_ALLOW_UNSAFE_ISOLATION=1 \
      --entrypoint bash \
      "$IMAGE" /opt/oort/prime/tests/tenancy_probe.sh "$iso" "$expect"
    ;;
  help|*)
    sed -n '2,20p' "${BASH_SOURCE[0]}"
    ;;
esac

echo "artifacts: $OUT" >&2
