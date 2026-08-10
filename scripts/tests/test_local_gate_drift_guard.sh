#!/usr/bin/env bash
# Static/isolated MOMO-353 regression scenarios. No Docker daemon or DB access.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/runtime_process_guard.sh"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/momo-drift-guard-test.XXXXXX")"

cleanup() {
  rm -rf "$SANDBOX"
}
trap cleanup EXIT INT TERM
cd "$REPO_ROOT"

fail() {
  echo "[drift-guard-test] FAIL: $*" >&2
  exit 1
}

FAKE_REPO="$SANDBOX/repo"
STATE_ROOT="$SANDBOX/state"
stale_marker="$STATE_ROOT/run-stale-owned-run"
mkdir -p "$FAKE_REPO/.build/debug" "$stale_marker"
printf 'repo_root=%s\nrun_id=%s\ngate_pid=%s\ngate_start=%s\n' \
  "$FAKE_REPO" "stale-owned-run" "99999" "Mon Jan  1 00:00:00 2001" \
  >"$stale_marker/owner"

export MOMO_RUNTIME_GUARD_REPO_ROOT="$FAKE_REPO"
export MOMO_RUNTIME_GUARD_STATE_ROOT="$STATE_ROOT"
unset MOMO_GATE_RUN_MARKER
# shellcheck source=scripts/runtime_process_guard.sh
. "$GUARD"

# Deterministic process table: 101 is a stale gate-owned verifier, 102 is an
# unmarked dogfood server using the same repo executable, and 103 is a user
# process. This avoids real process inspection/kill and works in restricted CI.
ps() {
  if [ "${1:-}" = "ax" ]; then
    printf '101\n102\n103\n104\n'
    return 0
  fi
  if [ "${1:-}" = "eww" ]; then
    case "${3:-}" in
      101) printf '%s MOMO_GATE_RUN_MARKER=%s\n' "$FAKE_REPO/.build/debug/MomoServer" "$stale_marker" ;;
      102) printf '%s\n' "$FAKE_REPO/.build/debug/MomoServer" ;;
      103) printf '/usr/bin/sleep 30\n' ;;
      104) printf '%s MOMO_GATE_RUN_MARKER=%s\n' "$FAKE_REPO/.build/debug/MomoServer" "$STATE_ROOT/run-current-failed-run" ;;
    esac
    return 0
  fi
  if [ "${1:-}" = "-p" ]; then
    case "${2:-}" in
      101|102|104) printf '%s\n' "$FAKE_REPO/.build/debug/MomoServer" ;;
      103) printf '/usr/bin/sleep 30\n' ;;
      *) return 1 ;;
    esac
    return 0
  fi
  return 1
}
kill() {
  # Marker gate_pid is intentionally stale. No real signal may be sent here.
  return 1
}
lsof() {
  printf '102\n'
}
KILL_LOG="$SANDBOX/killed"
: >"$KILL_LOG"
momo_kill_tree() {
  printf '%s\n' "$1" >>"$KILL_LOG"
}

momo_cleanup_stale_gate_runs "isolated stale verifier"
[ "$(cat "$KILL_LOG")" = "101" ] || fail "cleanup target set was not exactly the marker-owned verifier"

current_marker="$STATE_ROOT/run-current-failed-run"
mkdir -p "$current_marker"
printf 'repo_root=%s\nrun_id=%s\ngate_pid=%s\ngate_start=%s\n' \
  "$FAKE_REPO" "current-failed-run" "99998" "Mon Jan  1 00:00:01 2001" \
  >"$current_marker/owner"
export MOMO_GATE_RUN_MARKER="$current_marker"
momo_cleanup_gate_marker "$current_marker" "synthetic failed gate EXIT"
[ "$(cat "$KILL_LOG")" = $'101\n104' ] || fail "failed-gate final cleanup did not reap its owned verifier"

if momo_cleanup_port_listener "28180" "synthetic dogfood non-gate port"; then
  fail "unmarked dogfood listener was accepted as gate-owned"
fi
[ "$(cat "$KILL_LOG")" = $'101\n104' ] || fail "dogfood/user process entered the kill set"
echo "[drift-guard-test] PASS marker ownership reaps stale verifier only"

FAKE_BIN="$SANDBOX/bin"
FAKE_DOCKER_STATE="$SANDBOX/docker.digest"
ENV_FIXTURE="$SANDBOX/runtime.env"
mkdir -p "$FAKE_BIN"
cat >"$ENV_FIXTURE" <<'EOF'
COMPOSE_PROJECT_NAME=momo_guard_test
PORT=18080
CENT_PORT=18081
POSTGRES_PORT=15432
HERMES_PORT=18083
DATABASE_URL=postgresql://momo:momo@127.0.0.1:15432/momo
CENT_TOKEN_HMAC=test-token-hmac
CENT_API_KEY=test-api-key
CENT_PROXY_SECRET=test-proxy-secret
CENT_API_URL=http://127.0.0.1:18081/api
JWT_HMAC=test-jwt-hmac
HERMES_BASE_URL=http://127.0.0.1:18083/v1
HERMES_API_KEY=test-hermes-key
EOF
cat >"$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "inspect" ]; then
  printf 'MOMO_CENTRIFUGO_CONFIG_SHA256=%s\n' "$(cat "$FAKE_DOCKER_STATE")"
  exit 0
fi
case " $* " in
  *" ps -q centrifugo "*) echo "fake-centrifugo-container" ;;
  *" up -d --wait --force-recreate centrifugo "*)
    printf '%s\n' "$MOMO_CENTRIFUGO_CONFIG_SHA256" >"$FAKE_DOCKER_STATE"
    ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 90 ;;
esac
SH
chmod +x "$FAKE_BIN/docker"
export FAKE_DOCKER_STATE

desired_digest="$(shasum -a 256 "$REPO_ROOT/infra/centrifugo.json" | awk '{ print $1 }')"
printf '%s\n' "$desired_digest" >"$FAKE_DOCKER_STATE"
PATH="$FAKE_BIN:$PATH" ENV_FILE="$ENV_FIXTURE" \
  bash "$REPO_ROOT/scripts/ensure_runtime_env.sh" >/dev/null

printf '%s\n' "stale-fingerprint" >"$FAKE_DOCKER_STATE"
if PATH="$FAKE_BIN:$PATH" ENV_FILE="$ENV_FIXTURE" \
  bash "$REPO_ROOT/scripts/ensure_runtime_env.sh" >/dev/null 2>&1; then
  fail "stale Centrifugo fingerprint did not fail closed"
fi

PATH="$FAKE_BIN:$PATH" ENV_FILE="$ENV_FIXTURE" MOMO_CENTRIFUGO_AUTO_RECREATE=1 \
  bash "$REPO_ROOT/scripts/ensure_runtime_env.sh" >/dev/null
[ "$(cat "$FAKE_DOCKER_STATE")" = "$desired_digest" ] \
  || fail "opt-in recreate did not apply current config fingerprint"
echo "[drift-guard-test] PASS Centrifugo match/drift/opt-in recreate scenarios (fake Docker only)"

# MOMO-450 (재조준, W-S1 #1215): 이 자리는 원래 `macos-ui` 프로파일이 runtime-*
# 와 같은 런타임 부트스트랩을 스스로 조립하는지 재는 정적 계획 검사였다. 그
# 프로파일은 `clients/macOS` 삭제와 함께 은퇴했으므로, 남은 주장 — **런타임
# Compose 를 켜는 프로파일은 부하 가드와 teardown 가드를 함께 가진다** — 만
# 남긴다. 이건 프로파일 이름이 아니라 incident class 에 붙은 계약이다.
LOCAL_GATE="$REPO_ROOT/scripts/local_gate.sh"
load_guard_block="$(awk '/^RUNTIME_COMPOSE_PROFILE=0$/,/^if \[ "\$RUNTIME_COMPOSE_PROFILE" -eq 1 \]; then/' "$LOCAL_GATE")"
grep -Fq 'runtime-agent|all' <<<"$load_guard_block" \
  || fail "runtime compose profiles omitted the host load guard"
grep -Fq 'add_cmd "docker compose up (--wait healthy)" "make up"' "$LOCAL_GATE" \
  || fail "runtime bootstrap evidence label omitted compose up step"
grep -Fq 'if [ "$RUNTIME_COMPOSE_STARTED" -eq 1 ] && [ "$KEEP_STACK" -eq 0 ]' "$LOCAL_GATE" \
  || fail "default runtime Compose teardown guard is missing"
echo "[drift-guard-test] PASS runtime-compose load-guard/teardown plan (Docker not invoked)"

# W-S1 (#1215): `clients/macOS`·`clients/iOS`·`clients/Core` 가 삭제되면서
# MOMO-462 의 iOS 자동분류·`ios` 프로파일 검사도 함께 은퇴했다. 대신 남은
# 계약을 잰다 — **분류가 없는 `clients/*` 는 좁히지 않고 넓힌다.** 이걸 잃으면
# 새 클라 트리가 조용히 잘못된(좁은) 프로파일로 초록을 받는다.
clients_case_block="$(awk "/^    clients\\/\\*\\)\$/,/;;/" "$LOCAL_GATE")"
grep -Fq 'AUTO_NEED_ALL=1' <<<"$clients_case_block" \
  || fail "unclassified clients/* no longer widens to the all profile"
grep -Fq "clients/iOS/*)" "$LOCAL_GATE" \
  && fail "clients/iOS auto classification came back after the tree was deleted"
echo "[drift-guard-test] PASS unclassified clients/* widening (no simulator lane left)"
