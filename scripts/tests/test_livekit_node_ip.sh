#!/usr/bin/env bash
# #1856a — LiveKit advertised ICE IP knob (MOMO_LIVEKIT_NODE_IP).
#
# Proves compose passthrough + entrypoint argv, and when Docker can run the
# pinned image, that `--node-ip` is accepted by livekit-server v1.13.3 and
# lands in the boot log as rtc.node_ip / "nodeIP".
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/rust/docker-compose.rust.yml"
EXAMPLE_ENV="$ROOT/infra/rust/rust-smoke.env.example"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/oort-livekit-node-ip.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

fail() { printf '[livekit-node-ip] %s\n' "$*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || fail "missing $COMPOSE_FILE"
[ -f "$EXAMPLE_ENV" ] || fail "missing $EXAMPLE_ENV"
command -v jq >/dev/null 2>&1 || fail "jq required"

# ---------------------------------------------------------------------------
# Entrypoint script from the compose YAML ($$ already compose-escaped).
# Used when `docker compose config` is unavailable, and as the executable
# contract either way.
# ---------------------------------------------------------------------------
extract_entrypoint_from_yaml() {
  awk '
    $0 ~ /^  livekit:/ { in_svc = 1 }
    in_svc && $0 ~ /^    entrypoint:/ { in_ep = 1 }
    in_ep && $0 ~ /^[[:space:]]*- \|$/ { grab = 1; next }
    grab && $0 ~ /^    [A-Za-z]/ { exit }
    grab {
      sub(/^        /, "")
      gsub(/\$\$/, "$")
      print
    }
  ' "$COMPOSE_FILE"
}

run_entrypoint() {
  local node_ip="$1" argv_file="$2"
  local mock="$TMP/mock-bin"
  mkdir -p "$mock"
  cat >"$mock/livekit-server" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >"$argv_file"
exit 0
EOF
  chmod +x "$mock/livekit-server"

  local script="$TMP/entrypoint.sh"
  extract_entrypoint_from_yaml >"$script"
  grep -Fq -- '--node-ip' "$script" || fail "entrypoint YAML is missing --node-ip branch"
  # Absolute /livekit-server would ignore PATH. Rewrite only that exec target.
  script_run="$TMP/entrypoint.run.sh"
  sed "s#/livekit-server#$mock/livekit-server#g" "$script" >"$script_run"

  (
    export MOMO_LIVEKIT_API_KEY="devkey"
    export MOMO_LIVEKIT_API_SECRET="devsecret"
    export MOMO_LIVEKIT_NODE_IP="$node_ip"
    /bin/sh -ec "$(cat "$script_run")"
  )
}

# ---------------------------------------------------------------------------
# 1. Entrypoint argv: set → --node-ip present; empty → absent
# ---------------------------------------------------------------------------
run_entrypoint "127.0.0.1" "$TMP/argv-set"
grep -Fxq -- '--node-ip' "$TMP/argv-set" || fail "set NODE_IP did not add --node-ip"
grep -Fxq -- '127.0.0.1' "$TMP/argv-set" || fail "set NODE_IP did not pass 127.0.0.1"
awk '
  $0 == "--config=/etc/livekit/livekit.yaml" { cfg = 1 }
  END { if (!cfg) exit 1 }
' "$TMP/argv-set" || fail "config flag dropped when NODE_IP is set"

run_entrypoint "" "$TMP/argv-empty"
if grep -Fq -- '--node-ip' "$TMP/argv-empty"; then
  fail "empty NODE_IP still passed --node-ip"
fi
awk '
  $0 == "--config=/etc/livekit/livekit.yaml" { cfg = 1 }
  END { if (!cfg) exit 1 }
' "$TMP/argv-empty" || fail "config flag dropped when NODE_IP is empty"

printf '[livekit-node-ip] entrypoint argv: set includes --node-ip 127.0.0.1; empty omits it\n'

# ---------------------------------------------------------------------------
# 2. compose config render (docker compose, no container)
# ---------------------------------------------------------------------------
DOCKER_BIN="$(command -v docker || true)"
compose_config() {
  local node_ip="$1" out="$2"
  if [ -n "$node_ip" ]; then
    MOMO_LIVEKIT_NODE_IP="$node_ip" \
      "$DOCKER_BIN" compose --env-file "$EXAMPLE_ENV" \
      -f "$COMPOSE_FILE" --profile huddle config --format json >"$out"
  else
    env -u MOMO_LIVEKIT_NODE_IP \
      "$DOCKER_BIN" compose --env-file "$EXAMPLE_ENV" \
      -f "$COMPOSE_FILE" --profile huddle config --format json >"$out"
  fi
}

livekit_env_value() {
  local json="$1" key="$2"
  jq -er --arg key "$key" '
    .services.livekit.environment
    | if type == "object" then (.[$key] // "")
      elif type == "array" then
        (map(select(startswith($key + "="))) | first // ""
         | sub("^[^=]+="; ""))
      else ""
      end
  ' "$json"
}

if [ -z "$DOCKER_BIN" ] || ! "$DOCKER_BIN" compose version >/dev/null 2>&1; then
  printf '[livekit-node-ip] docker compose unavailable — config render skipped; entrypoint unit proof above stands\n'
else
  compose_config "127.0.0.1" "$TMP/config-set.json"
  jq -e '.services.livekit' "$TMP/config-set.json" >/dev/null \
    || fail "huddle profile render missing livekit service"
  test "$(livekit_env_value "$TMP/config-set.json" MOMO_LIVEKIT_NODE_IP)" = "127.0.0.1" \
    || fail "compose config with env set did not pass MOMO_LIVEKIT_NODE_IP=127.0.0.1"
  entrypoint_set="$(jq -r '
    .services.livekit.entrypoint
    | if type == "array" then .[-1]
      else .
      end
  ' "$TMP/config-set.json")"
  printf '%s\n' "$entrypoint_set" | grep -Fq -- '--node-ip' \
    || fail "rendered entrypoint missing --node-ip branch"
  printf '%s\n' "$entrypoint_set" | grep -Fq -- 'MOMO_LIVEKIT_NODE_IP' \
    || fail "rendered entrypoint lost container-shell NODE_IP expansion"
  # `docker compose config` keeps $$ escapes so the YAML can be re-applied.
  # The running container sees a single $. Unescape before docker run.
  entrypoint_run="$(printf '%s\n' "$entrypoint_set" | sed 's/\$\$/$/g')"
  printf '%s\n' "$entrypoint_run" | grep -Fq -- '${MOMO_LIVEKIT_NODE_IP' \
    || fail "unescaped entrypoint lost \${MOMO_LIVEKIT_NODE_IP}"

  compose_config "" "$TMP/config-empty.json"
  test "$(livekit_env_value "$TMP/config-empty.json" MOMO_LIVEKIT_NODE_IP)" = "" \
    || fail "compose config without env still set MOMO_LIVEKIT_NODE_IP"
  printf '[livekit-node-ip] compose config: env set → 127.0.0.1; unset → empty\n'

  # ---------------------------------------------------------------------------
  # 3. Real image boot — --node-ip ≡ rtc.node_ip in the log
  # ---------------------------------------------------------------------------
  if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    printf '[livekit-node-ip] docker daemon unavailable — boot log proof skipped; entrypoint + config render stand\n'
  else
    IMAGE="$(jq -r '.services.livekit.image' "$TMP/config-set.json")"
    [ -n "$IMAGE" ] && [ "$IMAGE" != "null" ] || fail "livekit image missing from compose config"
    name="oort-1856a-nodeip-$$"
    log="$TMP/livekit-boot.log"
    "$DOCKER_BIN" rm -f "$name" >/dev/null 2>&1 || true
    set +e
    "$DOCKER_BIN" run -d --name "$name" \
      -e MOMO_LIVEKIT_API_KEY=devkey \
      -e MOMO_LIVEKIT_API_SECRET=devsecret-1856a-nodeip-32chars \
      -e MOMO_LIVEKIT_NODE_IP=127.0.0.1 \
      -v "$ROOT/infra/livekit.yaml:/etc/livekit/livekit.yaml:ro" \
      --entrypoint /bin/sh \
      "$IMAGE" \
      -ec "$entrypoint_run" >"$TMP/cid" 2>"$TMP/run.err"
    run_rc=$?
    set -e
    if [ "$run_rc" -ne 0 ]; then
      printf '[livekit-node-ip] docker run failed (image pull/start) — boot log proof skipped:\n' >&2
      cat "$TMP/run.err" >&2 || true
    else
      cleanup_boot() {
        "$DOCKER_BIN" logs "$name" >"$log" 2>&1 || true
        "$DOCKER_BIN" rm -f "$name" >/dev/null 2>&1 || true
      }
      trap 'cleanup_boot; rm -rf "$TMP"' EXIT INT TERM
      deadline=$(( $(date -u +%s) + 45 ))
      found=0
      while [ "$(date -u +%s)" -lt "$deadline" ]; do
        "$DOCKER_BIN" logs "$name" >"$log" 2>&1 || true
        if grep -Eq '"nodeIP"[[:space:]]*:[[:space:]]*"127\.0\.0\.1"' "$log" \
          || grep -Fq 'nodeIP: 127.0.0.1' "$log" \
          || grep -Fq '"nodeIP":"127.0.0.1"' "$log" \
          || grep -Fq 'nodeIP": "127.0.0.1"' "$log"; then
          found=1
          break
        fi
        if grep -Eqi 'unknown flag|flag provided but not defined|no such option' "$log"; then
          cleanup_boot
          fail "--node-ip rejected by $IMAGE — rtc.node_ip templating fallback required"
        fi
        sleep 1
      done
      cleanup_boot
      trap 'rm -rf "$TMP"' EXIT INT TERM
      if [ "$found" -ne 1 ]; then
        printf '[livekit-node-ip] boot log did not show nodeIP=127.0.0.1\n' >&2
        tail -n 80 "$log" >&2 || true
        fail "livekit boot did not reflect --node-ip 127.0.0.1 as nodeIP"
      fi
      printf '[livekit-node-ip] boot log: nodeIP=127.0.0.1 (--node-ip ≡ rtc.node_ip) via %s\n' "$IMAGE"
    fi
  fi
fi

printf '[livekit-node-ip] PASS\n'
