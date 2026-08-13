#!/usr/bin/env bash
# =============================================================================
# scripts/verify_openapi_contract_rust.sh — SRV-B7 / #1042
# openapi 계약 게이트의 **2차 샘플 패스: 스펙 ↔ Rust**
#
# 1차 패스(scripts/verify_openapi_contract.sh)는 e2e 컴포즈의 swift:6.2 서버를
# 띄워 docs/api/openapi.yaml 의 전 연산을 샘플한다. 그런데 스펙이 서술하는 대상은
# 이제 Rust 배포본이다(#1040). 그래서 정본이 Rust 로 넘어간 경로에서는 1차 패스의
# 초록이 "스펙대로 배포된다"를 증명하지 못한다 — Swift 가 스펙을 지킨다는 사실만
# 증명한다. 이 스크립트가 그 간극을 닫는다:
#
#   scripts/openapi_sampled_on_rust.txt 에 등재된 연산을,
#   server-rust/Dockerfile 이 만드는 **배포와 동일한 이미지**로,
#   infra/rust/docker-compose.rust.yml 의 **부분집합 스택**(postgres·centrifugo·api)
#   위에서 실제로 왕복시켜, 응답 모양을 같은 스펙과 대조한다.
#
# 매니페스트와 샘플은 양방향으로 강제된다: 등재됐는데 미샘플이면 실패하고,
# 샘플인데 미등재여도 실패한다. "목록에만 있는 경로"도 "목록에 없는 초록"도 없다.
#
# ── 세 자격증명 ─────────────────────────────────────────────────────────────
# 등재 목록이 승인 계열 3개에서 자라면서(#1132 이탈 6 / #1143 잔여) 이 패스는
# **사람 bearer 하나로는 닿을 수 없는 표면**을 갖게 됐다. 그래서 호출자가 셋이다:
#
#   * App JWT (`Authorization: Bearer …`) — 로그인이 준다. 대부분의 표본.
#   * agent bearer (`momo_agent_v1.{ws}.{secret}`) — `POST …/work-controls`와
#     POST-only Agent Port가 각각 닫힌 scope로 요구한다(momo_auth::agent_scope).
#     이 검증기는 #1358 lifecycle의 랜딩 순서와 무관하게 scope를 정확히 고정하려고
#     전용 SQL fixture를 사용한다.
#   * work-host 서명 (`Authorization: MomoHost {hostId}` + v2 서명 3 헤더) —
#     데몬이 `pending-controls` 를 읽고 `…/ack` 로 「실행했다」를 보고하는 경로.
#     ack 을 요청자와 **다른** 자격증명이 하는 것이 #1143 이 연 그 문장이므로,
#     이 패스도 서명 arm 으로 샘플한다. 사람 arm 으로 바꾸면 초록의 뜻이 달라진다.
#
# 그래서 openssl 은 Ed25519 를 할 줄 알아야 한다(macOS 기본 LibreSSL 은 못 한다) —
# 부팅 전에 그 능력을 실제로 시험해 고른다.
#
# 실행:
#   scripts/verify_openapi_contract_rust.sh          # 단독 실행(이미지 빌드 포함)
#   scripts/verify_openapi_contract.sh               # 1차 패스 뒤 자동으로 이 패스
#
# 환경:
#   MOMO_RUST_IMAGE                    이미 빌드된 이미지를 재사용(빌드 건너뜀).
#                                      비우면 infra/rust/docker-compose.rust.build.yml
#                                      로 checkout 에서 빌드한다 — 배포 이미지
#                                      빌드 경로를 그대로 실측하기 위해서다.
#   OPENAPI_RUST_GATE_COMPOSE_PROJECT  컴포즈 프로젝트명(기본 momo1042rustgate).
#                                      janitor 가 라벨로 회수할 수 있어야 하므로
#                                      infra/rust 의 라벨 세트를 그대로 쓴다.
#   OPENAPI_RUST_GATE_API_PORT         api 호스트 포트(기본 18990).
#   OPENAPI_RUST_GATE_CENT_PORT        centrifugo 호스트 포트(기본 18991).
#   OPENAPI_RUST_GATE_BOOT_TIMEOUT     헬스 대기 상한 초(기본 900).
#   OPENAPI_RUST_GATE_KEEP=1           보안상 금지: 컨테이너 환경에 live secret이 남는다.
#   OPENAPI_SPEC                       스펙 경로 override.
#
# 자원 회수: 스택은 고유 프로젝트명으로 뜨고, EXIT 트랩이 반드시
# `down -v --remove-orphans` 한다. pgdata 볼륨은 게이트 전용 이름으로 덮어쓴다.
# #1238 이후 이 덮어쓰기는 **유일한** 방어선이 아니다 — base compose 의 기본
# 볼륨명이 프로젝트 스코프(`${COMPOSE_PROJECT_NAME}-pgdata`)로 바뀌었으므로 고유
# 프로젝트명만으로도 격리된다. 그래도 명시 이름을 유지하는 이유는 이 게이트가
# 남의 볼륨을 `down -v` 로 지운 사고(#1058 실측)의 당사자였기 때문이다:
# 격리를 compose 기본값 하나에만 의존시키지 않는다.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# 스펙 YAML -> JSON 변환은 1차 패스와 공유하는 한 벌이다(#1185).
# shellcheck source=scripts/openapi_spec_to_json.sh
. "$SCRIPT_DIR/openapi_spec_to_json.sh"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[openapi-rust] missing required command: $1" >&2
    exit 1
  }
}
need curl
need jq
need uuidgen
need docker
need openssl
need xxd

owned_binding_matches() {
  local expected_id="$1" actual_id="$2" expected_name="$3" actual_name="$4"
  local expected_nonce="$5" actual_nonce="$6" expected_project="$7" actual_project="$8"
  [ -n "$expected_id" ] && [ "$actual_id" = "$expected_id" ] &&
    [ "$actual_name" = "$expected_name" ] &&
    [ "$actual_nonce" = "$expected_nonce" ] &&
    [ "$actual_project" = "$expected_project" ]
}

valid_object_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
valid_image_id() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }
DOCKER_BIN="${DOCKER_BIN:-docker}"
GREP_BIN="${GREP_BIN:-grep}"

# Pipe-free exact membership: with pipefail, an early `grep -q` match can make
# an upstream printf exit 141 and turn "present" into a false absence.
# Return 0=found, 1=not found, 2=grep/read failure.
exact_ref_membership() {
  local refs="$1" ref="$2" grep_rc=0
  "$GREP_BIN" -Fqx -- "$ref" <<<"$refs" || grep_rc=$?
  case "$grep_rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) return 2 ;;
  esac
}

docker_full_refs() {
  case "$1" in
    container) "$DOCKER_BIN" ps -aq --no-trunc ;;
    network) "$DOCKER_BIN" network ls -q --no-trunc ;;
    volume) "$DOCKER_BIN" volume ls -q ;;
    image) "$DOCKER_BIN" image ls -aq --no-trunc ;;
    *) return 2 ;;
  esac
}

# 0=present/readable, 1=absence proved by a successful full listing,
# 2=inspect/list/daemon ambiguity. Never collapse a daemon read error into
# "already absent", because that would let cleanup report a false PASS.
docker_query_state() {
  local kind="$1" ref="$2" format="$3" output_var="$4" output refs membership_rc=0
  case "$kind" in
    container) output="$("$DOCKER_BIN" inspect --format "$format" "$ref" 2>/dev/null)" && { printf -v "$output_var" '%s' "$output"; return 0; } ;;
    network) output="$("$DOCKER_BIN" network inspect --format "$format" "$ref" 2>/dev/null)" && { printf -v "$output_var" '%s' "$output"; return 0; } ;;
    volume) output="$("$DOCKER_BIN" volume inspect --format "$format" "$ref" 2>/dev/null)" && { printf -v "$output_var" '%s' "$output"; return 0; } ;;
    image) output="$("$DOCKER_BIN" image inspect --format "$format" "$ref" 2>/dev/null)" && { printf -v "$output_var" '%s' "$output"; return 0; } ;;
    *) return 2 ;;
  esac
  refs="$(docker_full_refs "$kind" 2>/dev/null)" || return 2
  exact_ref_membership "$refs" "$ref" || membership_rc=$?
  case "$membership_rc" in
    0) return 2 ;;
    1) ;;
    *) return 2 ;;
  esac
  printf -v "$output_var" '%s' ''
  return 1
}

docker_image_ref_query_state() {
  local ref="$1" format="$2" output_var="$3" output ids
  output="$("$DOCKER_BIN" image inspect --format "$format" "$ref" 2>/dev/null)" && {
    printf -v "$output_var" '%s' "$output"
    return 0
  }
  ids="$("$DOCKER_BIN" image ls -q --no-trunc "$ref" 2>/dev/null)" || return 2
  [ -z "$ids" ] || return 2
  printf -v "$output_var" '%s' ''
  return 1
}

docker_require_absent() {
  local kind="$1" ref="$2" ignored='' rc=0 format='{{.Id}}'
  [ "$kind" = volume ] && format='{{.Name}}'
  docker_query_state "$kind" "$ref" "$format" ignored || rc=$?
  [ "$rc" -eq 1 ]
}

docker_remove_and_verify() {
  local kind="$1" ref="$2"
  case "$kind" in
    container) "$DOCKER_BIN" rm -f "$ref" >/dev/null 2>&1 || return 1 ;;
    network) "$DOCKER_BIN" network rm "$ref" >/dev/null 2>&1 || return 1 ;;
    volume) "$DOCKER_BIN" volume rm "$ref" >/dev/null 2>&1 || return 1 ;;
    image) "$DOCKER_BIN" image rm "$ref" >/dev/null 2>&1 || return 1 ;;
    *) return 1 ;;
  esac
  docker_require_absent "$kind" "$ref"
}

# 0=clean, 1=needle found, 2=scan/read error.
needle_scan_state() {
  local needles="$1" candidate="$2" rc=0
  grep -Fq -f "$needles" -- "$candidate" 2>/dev/null || rc=$?
  case "$rc" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 2 ;;
  esac
}

if [ "${1:-}" = "--verify-cleanup-contract" ]; then
  owned_binding_matches id1 id1 /name /name nonce nonce project project || exit 1
  for mutation in id name nonce project; do
    case "$mutation" in
      id) args=(id1 id2 /name /name nonce nonce project project) ;;
      name) args=(id1 id1 /name /other nonce nonce project project) ;;
      nonce) args=(id1 id1 /name /name nonce foreign project project) ;;
      project) args=(id1 id1 /name /name nonce nonce project foreign) ;;
    esac
    if owned_binding_matches "${args[@]}"; then
      echo "[openapi-rust] cleanup contract accepted foreign $mutation" >&2
      exit 1
    fi
  done
  safe_bearer_fixture='aaa.bbb.ccc_~-'
  unsafe_bearer_fixture=$'aaa.bbb.ccc"\noutput=/tmp/exfil'
  [[ "$safe_bearer_fixture" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9._~-]+$ ]] || exit 1
  if [[ "$unsafe_bearer_fixture" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9._~-]+$ ]]; then
    echo "[openapi-rust] bearer validator accepted curl-config directive injection" >&2
    exit 1
  fi
  valid_fixture_id="$(printf 'a%.0s' {1..64})"
  selftest_dir="$(mktemp -d "${TMPDIR:-/tmp}/momo-openapi-docker-selftest.XXXXXX")"
  large_refs="$valid_fixture_id"$'\n'"$(awk 'BEGIN { line=""; for (j=0; j<64; j++) line=line "b"; for (i=1; i<200000; i++) print line }')"
  exact_ref_membership "$large_refs" "$valid_fixture_id" || {
    echo "[openapi-rust] pipe-free membership missed an early match in a 200k-line listing" >&2
    exit 1
  }
  unset large_refs
  grep_error_bin="$selftest_dir/grep-error"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 2' >"$grep_error_bin"
  chmod 700 "$grep_error_bin"
  original_grep_bin="$GREP_BIN"
  GREP_BIN="$grep_error_bin"
  membership_rc=0
  exact_ref_membership "$valid_fixture_id" "$valid_fixture_id" || membership_rc=$?
  [ "$membership_rc" -eq 2 ] || {
    echo "[openapi-rust] membership grep/read error was not fail-closed" >&2
    exit 1
  }
  GREP_BIN="$original_grep_bin"
  fake_docker="$selftest_dir/docker"
  fake_state="$selftest_dir/state"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -u' \
    'state="$(cat "$FAKE_DOCKER_STATE")"' \
    'case "$1" in' \
    '  inspect)' \
    '    [ "${FAKE_INSPECT:-ok}" = ok ] && [ "$state" = present ] && { printf "%s\n" "$FAKE_DOCKER_REF"; exit 0; }' \
    '    exit 1 ;;' \
    '  ps)' \
    '    [ "${FAKE_LIST:-ok}" = ok ] || exit 9' \
    '    [ "$state" = present ] && printf "%s\n" "$FAKE_DOCKER_REF"' \
    '    exit 0 ;;' \
    '  rm)' \
    '    case "${FAKE_REMOVE:-ok}" in' \
    '      fail) exit 8 ;;' \
    '      lie) exit 0 ;;' \
    '      ok) printf "%s\n" absent >"$FAKE_DOCKER_STATE"; exit 0 ;;' \
    '    esac ;;' \
    '  *) exit 9 ;;' \
    'esac' >"$fake_docker"
  chmod 700 "$fake_docker"
  original_docker_bin="$DOCKER_BIN"
  DOCKER_BIN="$fake_docker"
  FAKE_DOCKER_STATE="$fake_state" FAKE_DOCKER_REF="$valid_fixture_id"
  FAKE_INSPECT=ok FAKE_LIST=ok
  export FAKE_DOCKER_STATE FAKE_DOCKER_REF FAKE_INSPECT FAKE_LIST
  printf '%s\n' present >"$fake_state"
  query_output=''
  docker_query_state container "$valid_fixture_id" '{{.Id}}' query_output || exit 1
  [ "$query_output" = "$valid_fixture_id" ] || exit 1
  printf '%s\n' absent >"$fake_state"
  FAKE_INSPECT=fail; export FAKE_INSPECT
  query_rc=0; docker_query_state container "$valid_fixture_id" '{{.Id}}' query_output || query_rc=$?
  [ "$query_rc" -eq 1 ] || { echo "[openapi-rust] fake Docker absence classifier failed" >&2; exit 1; }
  printf '%s\n' present >"$fake_state"
  query_rc=0; docker_query_state container "$valid_fixture_id" '{{.Id}}' query_output || query_rc=$?
  [ "$query_rc" -eq 2 ] || { echo "[openapi-rust] inspect error for listed object was hidden" >&2; exit 1; }
  printf '%s\n' absent >"$fake_state"
  FAKE_LIST=fail; export FAKE_LIST
  query_rc=0; docker_query_state container "$valid_fixture_id" '{{.Id}}' query_output || query_rc=$?
  [ "$query_rc" -eq 2 ] || { echo "[openapi-rust] daemon/list error was treated as absence" >&2; exit 1; }
  FAKE_INSPECT=ok FAKE_LIST=ok; export FAKE_INSPECT FAKE_LIST
  printf '%s\n' present >"$fake_state"
  FAKE_REMOVE=fail; export FAKE_REMOVE
  ! docker_remove_and_verify container "$valid_fixture_id" || { echo "[openapi-rust] removal error was swallowed" >&2; exit 1; }
  printf '%s\n' present >"$fake_state"
  FAKE_REMOVE=lie; export FAKE_REMOVE
  ! docker_remove_and_verify container "$valid_fixture_id" || { echo "[openapi-rust] survivor check was false-green" >&2; exit 1; }
  printf '%s\n' present >"$fake_state"
  FAKE_REMOVE=ok; export FAKE_REMOVE
  docker_remove_and_verify container "$valid_fixture_id" || exit 1
  printf '%s\n' 'live-secret-fixture' >"$selftest_dir/needles"
  printf '%s\n' 'HTTP/1.1 200 OK' 'Cache-Control: private, no-store' >"$selftest_dir/headers-clean"
  printf '%s\n' 'HTTP/1.1 500' 'X-Debug: live-secret-fixture' >"$selftest_dir/headers-leak"
  needle_scan_state "$selftest_dir/needles" "$selftest_dir/headers-clean" || {
    echo "[openapi-rust] clean response-header scan was rejected" >&2; exit 1;
  }
  header_scan_rc=0
  needle_scan_state "$selftest_dir/needles" "$selftest_dir/headers-leak" || header_scan_rc=$?
  [ "$header_scan_rc" -eq 1 ] || { echo "[openapi-rust] response-header leak was not detected" >&2; exit 1; }
  header_scan_rc=0
  needle_scan_state "$selftest_dir/needles" "$selftest_dir/missing-headers" || header_scan_rc=$?
  [ "$header_scan_rc" -eq 2 ] || { echo "[openapi-rust] response-header read error was false-clean" >&2; exit 1; }
  DOCKER_BIN="$original_docker_bin"
  unset FAKE_DOCKER_STATE FAKE_DOCKER_REF FAKE_INSPECT FAKE_LIST FAKE_REMOVE
  rm -r -- "$selftest_dir"
  forbidden_static='compose d''own|docker volume rm -f|Authorization: Bearer \$|--data "\$|--arg (signature|p|r|c) "\$(signature|GATE_PASSWORD|REFRESH|INVITE_CODE|JOIN_PASSWORD)"'
  if grep -v 'forbidden_static=' "$0" | grep -E "$forbidden_static" >/dev/null; then
    echo "[openapi-rust] static cleanup/secret argv contract drifted" >&2
    exit 1
  fi
  # macOS still ships Bash 3.2, where expanding an empty indexed array with
  # `${array[@]}` or `${array[*]}` under `set -u` aborts the process.  The
  # runtime cleanup must therefore iterate by a nounset-safe length/index,
  # including when compose fails before the first immutable ID is acquired.
  empty_ids=()
  empty_iterations=0
  for ((empty_index = 0; empty_index < ${#empty_ids[@]}; empty_index++)); do
    empty_iterations=$((empty_iterations + 1))
  done
  [ "$empty_iterations" -eq 0 ] || exit 1
  if grep -E '\$\{ACQUIRED_(CONTAINER|NETWORK|VOLUME)_[A-Z_]+\[(\*|@)\]\}' "$0" >/dev/null; then
    echo "[openapi-rust] cleanup contract contains a nounset-unsafe array expansion" >&2
    exit 1
  fi
  grep -q 'if \[ "$MUTATION_STARTED" -eq 1 \]; then' "$0" || {
    echo "[openapi-rust] cleanup contract lost early-mutation acquisition" >&2
    exit 1
  }
  grep -q 'capture_owned_resources || cleanup_failed=1' "$0" || {
    echo "[openapi-rust] cleanup contract does not fail closed on acquisition errors" >&2
    exit 1
  }
  grep -q 'capture_owned_image || cleanup_failed=1' "$0" || {
    echo "[openapi-rust] cleanup contract lost interrupted-build image acquisition" >&2
    exit 1
  }
  echo "[openapi-rust] PASS daemon-free foreign-resource and secret-argv contract"
  exit 0
fi
[ "$#" -eq 0 ] || {
  echo "usage: scripts/verify_openapi_contract_rust.sh [--verify-cleanup-contract]" >&2
  exit 1
}

# Ed25519 는 이 패스의 **자격증명**이다 — 서명 데몬 픽스처(#1114/#1143)가
# `pending-controls` 폴링과 `work-controls/{id}/ack` 를 그 키로 서명한다.
# macOS 기본 `/usr/bin/openssl` 은 LibreSSL 이고 `genpkey -algorithm ED25519` 를
# 못 하므로, PYTHON_BIN 과 같은 방식으로 **할 수 있는 구현을 찾아** 고정한다.
# 못 찾으면 여기서 멈춘다: 서명 없는 초록은 데몬 경로를 증명하지 않는다.
OPENSSL_BIN=""
for cand in "${OPENSSL:-}" openssl /opt/homebrew/opt/openssl@3/bin/openssl \
  /usr/local/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/bin/openssl; do
  [ -n "$cand" ] || continue
  command -v "$cand" >/dev/null 2>&1 || continue
  if "$cand" genpkey -algorithm ED25519 -out /dev/null >/dev/null 2>&1; then
    OPENSSL_BIN="$cand"; break
  fi
done
[ -n "$OPENSSL_BIN" ] || {
  echo "[openapi-rust] no openssl with Ed25519 support (need OpenSSL 3.x; LibreSSL cannot sign the work-host requests)" >&2
  exit 1
}

PYTHON_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON_BIN="$cand"; break
  fi
done
[ -n "$PYTHON_BIN" ] || { echo "[openapi-rust] missing python >= 3.10" >&2; exit 1; }

SPEC_YAML="${OPENAPI_SPEC:-$REPO_ROOT/docs/api/openapi.yaml}"
[ -f "$SPEC_YAML" ] || { echo "[openapi-rust] spec not found: $SPEC_YAML" >&2; exit 1; }

SAMPLED_ON_RUST="$SCRIPT_DIR/openapi_sampled_on_rust.txt"
[ -f "$SAMPLED_ON_RUST" ] || {
  echo "[openapi-rust] manifest not found: $SAMPLED_ON_RUST" >&2
  exit 1
}

COMPOSE_BASE="$REPO_ROOT/infra/rust/docker-compose.rust.yml"
COMPOSE_BUILD="$REPO_ROOT/infra/rust/docker-compose.rust.build.yml"
RUN_EPOCH="$(date -u +%s)"
RUN_NONCE="$("$OPENSSL_BIN" rand -hex 16)"
RUN_ID="${RUN_EPOCH}-$$-$RUN_NONCE"
PROJECT="${OPENAPI_RUST_GATE_COMPOSE_PROJECT:-momo-openapi-${RUN_EPOCH}-$$-${RUN_NONCE:0:12}}"
case "$PROJECT" in
  ''|[!a-z0-9]*|*[!a-z0-9_-]*|????????????????????????????????????????????????????????????????*)
    echo "[openapi-rust] invalid compose project name: $PROJECT" >&2
    exit 1
    ;;
esac

pick_loopback_port() {
  "$PYTHON_BIN" - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

API_PORT="${OPENAPI_RUST_GATE_API_PORT:-$(pick_loopback_port)}"
CENT_PORT="${OPENAPI_RUST_GATE_CENT_PORT:-$(pick_loopback_port)}"
[ "$API_PORT" != "$CENT_PORT" ] || CENT_PORT="$(pick_loopback_port)"
BOOT_TIMEOUT="${OPENAPI_RUST_GATE_BOOT_TIMEOUT:-900}"
for numeric_name in API_PORT CENT_PORT BOOT_TIMEOUT; do
  numeric_value="${!numeric_name}"
  case "$numeric_value" in ''|*[!0-9]*)
    echo "[openapi-rust] $numeric_name must be an unsigned decimal integer" >&2
    exit 1
    ;;
  esac
  # Reject ambiguous leading-zero arithmetic and normalize only after syntax.
  [ "$numeric_value" = "0" ] || [ "${numeric_value#0}" = "$numeric_value" ] || {
    echo "[openapi-rust] $numeric_name must use canonical decimal notation" >&2
    exit 1
  }
done
[ "$API_PORT" -ge 1 ] && [ "$API_PORT" -le 65535 ] || { echo "[openapi-rust] invalid API port" >&2; exit 1; }
[ "$CENT_PORT" -ge 1 ] && [ "$CENT_PORT" -le 65535 ] || { echo "[openapi-rust] invalid Centrifugo port" >&2; exit 1; }
[ "$BOOT_TIMEOUT" -ge 1 ] && [ "$BOOT_TIMEOUT" -le 3600 ] || { echo "[openapi-rust] boot timeout must be 1..3600 seconds" >&2; exit 1; }
if [ "${OPENAPI_RUST_GATE_KEEP:-0}" = "1" ]; then
  echo "[openapi-rust] OPENAPI_RUST_GATE_KEEP=1 is disabled: live containers retain secret environment values" >&2
  exit 1
fi

TMP_DIR="${TMPDIR:-/tmp}/momo-openapi-rust-gate-$RUN_ID"
mkdir -p "$TMP_DIR"
chmod 700 "$TMP_DIR"
path_identity() {
  stat -f '%d:%i:%u:%Lp' -- "$1" 2>/dev/null ||
    stat -c '%d:%i:%u:%a' -- "$1" 2>/dev/null
}
PROJECT_LOCK_DIR="${TMPDIR:-/tmp}/momo-openapi-project-${PROJECT}.lock"
if ! mkdir "$PROJECT_LOCK_DIR" 2>/dev/null; then
  echo "[openapi-rust] compose project is already locked by another invocation: $PROJECT" >&2
  exit 1
fi
early_lock_cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  rmdir "$PROJECT_LOCK_DIR" 2>/dev/null || true
  exit "$rc"
}
trap early_lock_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$PROJECT_LOCK_DIR"
PROJECT_LOCK_IDENTITY="$(path_identity "$PROJECT_LOCK_DIR")"
# Arm a narrow early trap immediately after acquiring the private directory.
# The full immutable Docker cleanup replaces it below; this one exists solely
# so a failure while constructing secret files cannot leave them behind.
early_secret_cleanup() {
  local rc=$? path
  trap - EXIT INT TERM
  for path in \
    "$TMP_DIR/rust-gate.env" "$TMP_DIR/work-host.pem" \
    "$TMP_DIR/curl-auth.conf" "$TMP_DIR/curl-body.json" \
    "$TMP_DIR/secret-needles.txt" "$TMP_DIR/last-response.json" \
    "$TMP_DIR/last-response.headers" "$TMP_DIR/startup.log.raw"; do
    case "$path" in "$TMP_DIR"/*) ;; *) continue ;; esac
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ ! -L "$path" ] && [ -f "$path" ] &&
        [ "$(stat -f '%u' -- "$path" 2>/dev/null || stat -c '%u' -- "$path" 2>/dev/null)" = "$(id -u)" ] &&
        rm -f -- "$path"
    fi
  done
  if [ -d "$PROJECT_LOCK_DIR" ] && [ "$(path_identity "$PROJECT_LOCK_DIR")" = "$PROJECT_LOCK_IDENTITY" ]; then
    rmdir "$PROJECT_LOCK_DIR" 2>/dev/null || true
  fi
  exit "$rc"
}
trap early_secret_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
SPEC_JSON="$TMP_DIR/openapi.json"
MANIFEST="$TMP_DIR/manifest.jsonl"
: >"$MANIFEST"

# ---- Failure accumulation (1차 패스와 같은 규율: 모으고 계속) ----------------
FAILURE_LOG="$TMP_DIR/failures.txt"
: >"$FAILURE_LOG"
FAILURE_COUNT=0

gate_fail() {
  local name="$1" detail="$2" body="${3:-}"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  printf '%s\n' "[$FAILURE_COUNT] $name: $detail" >>"$FAILURE_LOG"
  echo "[openapi-rust] FAIL $name: $detail" >&2
  [ -n "$body" ] && printf '%s\n' "$body" >&2
  return 0
}

print_failure_summary() {
  [ "$FAILURE_COUNT" -gt 0 ] || return 0
  echo "" >&2
  echo "[openapi-rust] ===== $FAILURE_COUNT failed assertion(s) =====" >&2
  cat "$FAILURE_LOG" >&2
  echo "[openapi-rust] ============================================" >&2
}

redact_json() {
  local input
  input="$(cat)"
  if [ -z "$input" ]; then
    return 0
  fi
  printf '%s' "$input" |
  jq -c --rawfile secret_needles "$SECRET_NEEDLES" '
  ($secret_needles | split("\n") | map(select(length > 0))) as $needles |
  def contains_secret:
    . as $value | any($needles[]; . as $needle | $value | contains($needle));
  walk(
    if type == "object" then
      with_entries(
        if (.key | test("(?i)^(accessToken|refreshToken|token|password|secret|signature)$"))
        then .value = "[REDACTED]"
        else . end
      )
    elif type == "string" and contains_secret then "[REDACTED]"
    else . end
  )' 2>/dev/null || printf '%s' '[non-json response redacted]'
}

redacted_body() { printf '%s' "${1:-$RESPONSE_BODY}" | redact_json; }

# ---- Run-scoped secrets ------------------------------------------------------
# 커밋된 자리표시자(change-me-*)는 절대 쓰지 않는다. 이 값들은 런과 함께 나고
# 죽으며, 파일은 TMP_DIR(0700) 안에 0600 으로만 존재한다.
rand_hex() { "$OPENSSL_BIN" rand -hex 24; }

lower_uuid() { uuidgen | tr '[:upper:]' '[:lower:]'; }

DEMO_WORKSPACE_ID="00000000-0000-7000-8000-000000000001"
GENERAL_CHANNEL_ID="00000000-0000-7000-8000-000000000201"
KIM_INTERN_MEMBER_ID="00000000-0000-7000-8000-000000000102"
GATE_MEMBER_ID="$(lower_uuid)"
GATE_EMAIL="rust-gate-$RUN_ID@momo.local"
GATE_PASSWORD="rust-gate-$(lower_uuid)"
GATE_HANDLE="rust-gate-$RUN_EPOCH"
RUN_UUID="$(lower_uuid)"
APPROVAL_UUID="$(lower_uuid)"

# 승인 계열 밖의 픽스처(#1132 이탈 6 / #1143 잔여를 닫는 데 필요한 것들).
GATE_PEER_ID="$(lower_uuid)"          # DM 상대. 자기 자신과는 DM 이 열리지 않는다.
GATE_PEER_EMAIL="rust-gate-peer-$RUN_ID@momo.local"
GATE_AGENT_ID="$(lower_uuid)"         # work-control 을 요청하는 에이전트.
GATE_AGENT_HANDLE="rust-gate-agent-$RUN_EPOCH"
# agent bearer 형식은 `momo_agent_v1.{ws}.{secret}` 이고 저장되는 것은 sha256
# 다이제스트뿐이다(momo_auth::agent_bearer). 이 gate는 #1358 lifecycle을 호출하지
# 않고 SQL fixture로 exact scope를 심어 두 goal의 실행·랜딩 순서를 독립시킨다.
# 첫 토큰은 work-control과 Agent Port를 각각 실제 scope로 왕복시키며, 둘째는
# Agent Port의 insufficient_scope 경계를 증명하는 대조군이다.
GATE_AGENT_TOKEN="momo_agent_v1.$DEMO_WORKSPACE_ID.$(rand_hex)$(rand_hex)"
GATE_AGENT_NO_PORT_TOKEN="momo_agent_v1.$DEMO_WORKSPACE_ID.$(rand_hex)$(rand_hex)"
GATE_AGENT_SECRET="${GATE_AGENT_TOKEN##*.}"
GATE_AGENT_NO_PORT_SECRET="${GATE_AGENT_NO_PORT_TOKEN##*.}"
GATE_AGENT_TOKEN_HASH="$(printf '%s' "$GATE_AGENT_TOKEN" | "$OPENSSL_BIN" dgst -sha256 -binary | xxd -p -c 256)"
GATE_AGENT_NO_PORT_TOKEN_HASH="$(printf '%s' "$GATE_AGENT_NO_PORT_TOKEN" | "$OPENSSL_BIN" dgst -sha256 -binary | xxd -p -c 256)"
CONTROL_RUN_UUID="$(lower_uuid)"      # work-control 이 붙을 running 런.
CANCEL_RUN_UUID="$(lower_uuid)"       # 사람의 「멈춰라」 표본용 queued 런.
INVITE_CODE="rust-gate-invite-$RUN_ID"
JOIN_EMAIL="rust-gate-join-$RUN_ID@momo.local"
JOIN_PASSWORD="rust-gate-join-$(lower_uuid)"
JOIN_HANDLE="rust-gate-join-$RUN_EPOCH"

PG_DB="momo"
PG_USER="momo"
PG_PASSWORD="$(rand_hex)"
APP_PASSWORD="$(rand_hex)"
RELAY_PASSWORD="$(rand_hex)"
WORKER_PASSWORD="$(rand_hex)"
JWT_HMAC="$(rand_hex)"
CENT_TOKEN_HMAC="$(rand_hex)"
CENT_API_KEY="$(rand_hex)"
CENT_PROXY_SECRET="$(rand_hex)"
PROVIDER_LINK_MASTER_KEY="$(rand_hex)"

# 볼륨 이름은 프로젝트명에서 파생한다: infra/rust 의 기본값은 고정 이름이라
# 게이트가 실제 스모크 스택의 데이터를 붙잡을 수 있다(그리고 down -v 로 지운다).
GATE_DB_VOLUME="${PROJECT}-pgdata"

# 이미지: 주어지면 재사용, 아니면 checkout 에서 배포 빌드 경로로 만든다.
RUST_IMAGE="${MOMO_RUST_IMAGE:-}"
BUILD_IMAGE=0
if [ -z "$RUST_IMAGE" ]; then
  RUST_IMAGE="momo-rust:openapi-gate-${RUN_EPOCH}-$$-${RUN_NONCE:0:12}"
  BUILD_IMAGE=1
fi
case "$RUST_IMAGE" in
  *[$'\r\n\t ']*|'')
    echo "[openapi-rust] image reference must be one non-empty line without whitespace" >&2
    exit 1
    ;;
esac

OWNERSHIP_LABEL="com.momo.openapi-rust-gate"
OWNERSHIP_OVERRIDE="$TMP_DIR/ownership.override.yml"
cat >"$OWNERSHIP_OVERRIDE" <<YAML
services:
  postgres:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
  centrifugo:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
  runtime-roles:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
  migrate:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
  api:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
networks:
  private:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
volumes:
  pgdata:
    labels:
      $OWNERSHIP_LABEL: "$RUN_NONCE"
YAML

OWNERSHIP_BUILD_OVERRIDE=""
if [ "$BUILD_IMAGE" -eq 1 ]; then
  OWNERSHIP_BUILD_OVERRIDE="$TMP_DIR/ownership-build.override.yml"
  cat >"$OWNERSHIP_BUILD_OVERRIDE" <<YAML
services:
  api:
    build:
      labels:
        $OWNERSHIP_LABEL: "$RUN_NONCE"
YAML
fi

file_identity() {
  path_identity "$1"
}

SECRET_FILES=()
SECRET_IDENTITIES=()
register_secret_file() {
  local path="$1" identity
  case "$path" in "$TMP_DIR"/*) ;; *) return 1 ;; esac
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  chmod 600 "$path" || return 1
  identity="$(file_identity "$path")" || return 1
  [ "$(printf '%s' "$identity" | cut -d: -f3)" = "$(id -u)" ] || return 1
  [ "${identity##*:}" = "600" ] || return 1
  SECRET_FILES+=("$path")
  SECRET_IDENTITIES+=("$identity")
}

SECRET_NEEDLES="$TMP_DIR/secret-needles.txt"
CURL_AUTH_CONFIG="$TMP_DIR/curl-auth.conf"
CURL_BODY_FILE="$TMP_DIR/curl-body.json"
RAW_RESPONSE_FILE="$TMP_DIR/last-response.json"
RAW_HEADERS_FILE="$TMP_DIR/last-response.headers"
STARTUP_LOG_FILE="$TMP_DIR/startup.log.raw"
(umask 077; : >"$SECRET_NEEDLES"; : >"$CURL_AUTH_CONFIG"; : >"$CURL_BODY_FILE"; : >"$RAW_RESPONSE_FILE"; : >"$RAW_HEADERS_FILE"; : >"$STARTUP_LOG_FILE")
register_secret_file "$SECRET_NEEDLES" || {
  echo "[openapi-rust] could not register private secret needle file" >&2
  exit 1
}
register_secret_file "$CURL_AUTH_CONFIG" || {
  echo "[openapi-rust] could not register private curl config" >&2
  exit 1
}
register_secret_file "$CURL_BODY_FILE" || {
  echo "[openapi-rust] could not register private curl body file" >&2
  exit 1
}
register_secret_file "$RAW_RESPONSE_FILE" || {
  echo "[openapi-rust] could not register private raw response scratch" >&2
  exit 1
}
register_secret_file "$RAW_HEADERS_FILE" || {
  echo "[openapi-rust] could not register private raw header scratch" >&2
  exit 1
}
register_secret_file "$STARTUP_LOG_FILE" || {
  echo "[openapi-rust] could not register private startup log scratch" >&2
  exit 1
}

append_secret_needle() {
  local value="$1"
  [ -n "$value" ] || return 0
  [ "$(file_identity "$SECRET_NEEDLES")" = "${SECRET_IDENTITIES[0]}" ] || return 1
  printf '%s\n' "$value" >>"$SECRET_NEEDLES"
}

append_secret_with_derivatives() {
  local value="$1" digest
  [ -n "$value" ] || return 0
  append_secret_needle "$value" || return 1
  if [ "${#value}" -ge 24 ]; then
    append_secret_needle "${value:0:24}" || return 1
  fi
  digest="$(printf '%s' "$value" | "$OPENSSL_BIN" dgst -sha256 -binary | xxd -p -c 256)" || return 1
  append_secret_needle "$digest"
}

set_curl_bearer() {
  local token="$1"
  if [ -n "$token" ]; then
    [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9._~-]+$ ]] || return 1
    [ "${#token}" -le 8192 ] || return 1
  fi
  [ "$(file_identity "$CURL_AUTH_CONFIG")" = "${SECRET_IDENTITIES[1]}" ] || return 1
  : >"$CURL_AUTH_CONFIG"
  [ -z "$token" ] || printf 'header = "Authorization: Bearer %s"\n' "$token" >"$CURL_AUTH_CONFIG"
}

canonical_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

set_curl_body() {
  local body="$1"
  [ "$(file_identity "$CURL_BODY_FILE")" = "${SECRET_IDENTITIES[2]}" ] || return 1
  printf '%s' "$body" >"$CURL_BODY_FILE"
}


refresh_request_body() {
  # `printf` is a shell builtin and the raw token reaches jq only on stdin.
  printf '%s' "$1" | jq -Rsc '{refreshToken:.}'
}

for secret_value in \
  "$GATE_AGENT_TOKEN" "$GATE_AGENT_NO_PORT_TOKEN" \
  "$GATE_AGENT_SECRET" "$GATE_AGENT_NO_PORT_SECRET" "$GATE_PASSWORD" \
  "$JOIN_PASSWORD" "$PG_PASSWORD" "$APP_PASSWORD" "$RELAY_PASSWORD" \
  "$WORKER_PASSWORD" "$INVITE_CODE" "$JWT_HMAC" "$CENT_TOKEN_HMAC" \
  "$CENT_API_KEY" "$CENT_PROXY_SECRET" "$PROVIDER_LINK_MASTER_KEY"; do
  append_secret_with_derivatives "$secret_value" || {
    echo "[openapi-rust] could not initialize secret leak needles" >&2
    exit 1
  }
done

ENV_FILE="$TMP_DIR/rust-gate.env"
(umask 077; : >"$ENV_FILE")
register_secret_file "$ENV_FILE" || {
  echo "[openapi-rust] rust gate env is not a private owned 0600 regular file" >&2
  exit 1
}
cat >"$ENV_FILE" <<ENV
MOMO_RUST_IMAGE=$RUST_IMAGE
MOMO_ENV=local
LOG_LEVEL=info

POSTGRES_DB=$PG_DB
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASSWORD
MIGRATE_DATABASE_URL=postgres://$PG_USER:$PG_PASSWORD@postgres:5432/$PG_DB

MOMO_APP_POSTGRES_PASSWORD=$APP_PASSWORD
RELAY_POSTGRES_PASSWORD=$RELAY_PASSWORD
WORKER_POSTGRES_PASSWORD=$WORKER_PASSWORD
MOMO_APP_DATABASE_URL=postgres://momo_app:$APP_PASSWORD@postgres:5432/$PG_DB
RELAY_DATABASE_URL=postgres://momo_relay:$RELAY_PASSWORD@postgres:5432/$PG_DB

JWT_HMAC=$JWT_HMAC
CENT_TOKEN_HMAC=$CENT_TOKEN_HMAC
CENT_API_KEY=$CENT_API_KEY
CENT_PROXY_SECRET=$CENT_PROXY_SECRET
PROVIDER_LINK_MASTER_KEY=$PROVIDER_LINK_MASTER_KEY

MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:$CENT_PORT/connection/websocket

MOMO_RUST_API_PORT=$API_PORT
CENT_HOST_PORT=$CENT_PORT

# 게이트 픽스처는 시드된 김인턴 에이전트 위에 얹힌다(1차 패스와 동일한 전제).
MOMO_AGENT_SEED_MODE=e2e
MIGRATE_IDEMPOTENCY_CHECK=1
MOMO_INITIAL_OWNER_EMAIL=
MOMO_INITIAL_OWNER_PASSWORD=

DB_VOLUME_NAME=$GATE_DB_VOLUME
ENV

COMPOSE_ARGS=(--env-file "$ENV_FILE" -p "$PROJECT" -f "$COMPOSE_BASE")
[ "$BUILD_IMAGE" -eq 1 ] && COMPOSE_ARGS+=(-f "$COMPOSE_BUILD")
COMPOSE_ARGS+=(-f "$OWNERSHIP_OVERRIDE")
[ -z "$OWNERSHIP_BUILD_OVERRIDE" ] || COMPOSE_ARGS+=(-f "$OWNERSHIP_BUILD_OVERRIDE")

# 프로세스 환경은 --env-file 을 **이깁니다**. 문서가 권하는 `MOMO_RUST_IMAGE=`
# (빈 값 = 빌드하라) 로 호출하면 그 빈 값이 그대로 이겨서
# `x-rust-image: ${MOMO_RUST_IMAGE:?…}` 가 보간 단계에서 죽는다. 여기서
# 해석된 태그를 다시 export 해 두 층이 같은 값을 보게 한다.
export MOMO_RUST_IMAGE="$RUST_IMAGE"

compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

secret_needles_are_safe() {
  [ -s "$SECRET_NEEDLES" ] && [ ! -L "$SECRET_NEEDLES" ] &&
    [ "$(file_identity "$SECRET_NEEDLES")" = "${SECRET_IDENTITIES[0]}" ]
}

load_scanned_response_headers() {
  local scan_rc=0
  [ "$(file_identity "$RAW_HEADERS_FILE")" = "${SECRET_IDENTITIES[4]}" ] || {
    echo "[openapi-rust] candidate response header scratch ownership changed" >&2
    return 1
  }
  secret_needles_are_safe || {
    echo "[openapi-rust] candidate response header needle file is unsafe" >&2
    return 1
  }
  needle_scan_state "$SECRET_NEEDLES" "$RAW_HEADERS_FILE" || scan_rc=$?
  case "$scan_rc" in
    1)
      echo "[openapi-rust] candidate response headers contained a verifier credential; headers withheld" >&2
      return 1
      ;;
    0) ;;
    *)
      echo "[openapi-rust] candidate response header secret scan failed; headers withheld" >&2
      return 1
      ;;
  esac
  RESPONSE_HEADERS="$(cat "$RAW_HEADERS_FILE")" || return 1
}

redacted_headers() {
  printf '[candidate response headers withheld; status=%s]\n' "${RESPONSE_STATUS:-unknown}"
}

print_safe_startup_logs() {
  local log_rc=0 grep_rc=0
  [ "$(file_identity "$STARTUP_LOG_FILE")" = "${SECRET_IDENTITIES[5]}" ] || return 1
  secret_needles_are_safe || return 1
  : >"$STARTUP_LOG_FILE"
  compose logs --no-color --tail 120 api migrate >"$STARTUP_LOG_FILE" 2>&1 || log_rc=$?
  grep -Fq -f "$SECRET_NEEDLES" -- "$STARTUP_LOG_FILE" 2>/dev/null || grep_rc=$?
  case "$grep_rc" in
    0) echo "[openapi-rust] startup logs withheld because they contain a verifier credential" >&2 ;;
    1) tail -120 "$STARTUP_LOG_FILE" >&2 ;;
    *) echo "[openapi-rust] startup log secret scan failed; logs withheld" >&2; return 1 ;;
  esac
  [ "$log_rc" -eq 0 ]
}

MANAGED_STACK=0
MUTATION_STARTED=0
CLEANUP_DONE=0
BUILT_IMAGE_ID=""
ACQUIRED_CONTAINER_IDS=()
ACQUIRED_CONTAINER_NAMES=()
ACQUIRED_NETWORK_IDS=()
ACQUIRED_NETWORK_NAMES=()
ACQUIRED_VOLUME_NAMES=()
ACQUIRED_VOLUME_IDENTITIES=()

capture_owned_image() {
  local binding rc=0 candidate_id candidate_label
  [ "$BUILD_IMAGE" -eq 1 ] || return 0
  docker_image_ref_query_state "$RUST_IMAGE" '{{.Id}}|{{ index .Config.Labels "com.momo.openapi-rust-gate" }}' binding || rc=$?
  case "$rc" in 1) return 0 ;; 0) ;; *) return 1 ;; esac
  IFS='|' read -r candidate_id candidate_label <<EOF
$binding
EOF
  valid_image_id "$candidate_id" || return 1
  [ "$candidate_label" = "$RUN_NONCE" ] || return 1
  if [ -n "$BUILT_IMAGE_ID" ] && [ "$BUILT_IMAGE_ID" != "$candidate_id" ]; then
    return 1
  fi
  BUILT_IMAGE_ID="$candidate_id"
}

capture_owned_resources() {
  local id name label project_label volume ids volumes created mountpoint index seen binding rc
  ids="$(docker ps -aq --no-trunc --filter "label=$OWNERSHIP_LABEL=$RUN_NONCE")" || return 1
  for id in $ids; do
    valid_object_id "$id" || return 1
    rc=0
    docker_query_state container "$id" '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.momo.openapi-rust-gate" }}|{{ index .Config.Labels "com.docker.compose.project" }}' binding || rc=$?
    [ "$rc" -eq 0 ] || return 1
    IFS='|' read -r actual_id name label project_label <<EOF
$binding
EOF
    [ "$actual_id" = "$id" ] && [ "$label" = "$RUN_NONCE" ] && [ "$project_label" = "$PROJECT" ] && [ -n "$name" ] || return 1
    seen=0
    for ((index = 0; index < ${#ACQUIRED_CONTAINER_IDS[@]}; index++)); do
      [ "${ACQUIRED_CONTAINER_IDS[$index]}" = "$id" ] && seen=1
    done
    if [ "$seen" -eq 0 ]; then
      ACQUIRED_CONTAINER_IDS+=("$id")
      ACQUIRED_CONTAINER_NAMES+=("$name")
    fi
  done
  ids="$(docker network ls -q --no-trunc --filter "label=$OWNERSHIP_LABEL=$RUN_NONCE")" || return 1
  for id in $ids; do
    valid_object_id "$id" || return 1
    rc=0
    docker_query_state network "$id" '{{.Id}}|{{.Name}}|{{ index .Labels "com.momo.openapi-rust-gate" }}|{{ index .Labels "com.docker.compose.project" }}' binding || rc=$?
    [ "$rc" -eq 0 ] || return 1
    IFS='|' read -r actual_id name label project_label <<EOF
$binding
EOF
    [ "$actual_id" = "$id" ] && [ "$label" = "$RUN_NONCE" ] && [ "$project_label" = "$PROJECT" ] && [ -n "$name" ] || return 1
    seen=0
    for ((index = 0; index < ${#ACQUIRED_NETWORK_IDS[@]}; index++)); do
      [ "${ACQUIRED_NETWORK_IDS[$index]}" = "$id" ] && seen=1
    done
    if [ "$seen" -eq 0 ]; then
      ACQUIRED_NETWORK_IDS+=("$id")
      ACQUIRED_NETWORK_NAMES+=("$name")
    fi
  done
  volumes="$(docker volume ls -q --filter "label=$OWNERSHIP_LABEL=$RUN_NONCE")" || return 1
  for volume in $volumes; do
    rc=0
    docker_query_state volume "$volume" '{{.Name}}|{{ index .Labels "com.momo.openapi-rust-gate" }}|{{ index .Labels "com.docker.compose.project" }}|{{.CreatedAt}}|{{.Mountpoint}}' binding || rc=$?
    [ "$rc" -eq 0 ] || return 1
    IFS='|' read -r name label project_label created mountpoint <<EOF
$binding
EOF
    [ "$label" = "$RUN_NONCE" ] && [ "$project_label" = "$PROJECT" ] && [ "$name" = "$volume" ] || return 1
    seen=0
    for ((index = 0; index < ${#ACQUIRED_VOLUME_NAMES[@]}; index++)); do
      [ "${ACQUIRED_VOLUME_NAMES[$index]}" = "$volume" ] && seen=1
    done
    if [ "$seen" -eq 0 ]; then
      ACQUIRED_VOLUME_NAMES+=("$volume")
      ACQUIRED_VOLUME_IDENTITIES+=("$created|$mountpoint")
    fi
  done
}

remove_owned_resources() {
  local index id expected_name actual_id actual_name label project_label volume created mountpoint expected_identity binding rc
  for ((index = 0; index < ${#ACQUIRED_CONTAINER_IDS[@]}; index++)); do
    id="${ACQUIRED_CONTAINER_IDS[$index]}"
    expected_name="${ACQUIRED_CONTAINER_NAMES[$index]}"
    rc=0
    docker_query_state container "$id" '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.momo.openapi-rust-gate" }}|{{ index .Config.Labels "com.docker.compose.project" }}' binding || rc=$?
    case "$rc" in 1) continue ;; 0) ;; *) return 1 ;; esac
    IFS='|' read -r actual_id actual_name label project_label <<EOF
$binding
EOF
    if owned_binding_matches \
      "$id" "$actual_id" "$expected_name" "$actual_name" \
      "$RUN_NONCE" "$label" "$PROJECT" "$project_label"; then
      docker_remove_and_verify container "$id" || return 1
    else
      echo "[openapi-rust] refusing foreign/replaced container cleanup: $expected_name" >&2
      return 1
    fi
  done
  for ((index = 0; index < ${#ACQUIRED_NETWORK_IDS[@]}; index++)); do
    id="${ACQUIRED_NETWORK_IDS[$index]}"
    expected_name="${ACQUIRED_NETWORK_NAMES[$index]}"
    rc=0
    docker_query_state network "$id" '{{.Id}}|{{.Name}}|{{ index .Labels "com.momo.openapi-rust-gate" }}|{{ index .Labels "com.docker.compose.project" }}' binding || rc=$?
    case "$rc" in 1) continue ;; 0) ;; *) return 1 ;; esac
    IFS='|' read -r actual_id actual_name label project_label <<EOF
$binding
EOF
    if owned_binding_matches \
      "$id" "$actual_id" "$expected_name" "$actual_name" \
      "$RUN_NONCE" "$label" "$PROJECT" "$project_label"; then
      docker_remove_and_verify network "$id" || return 1
    else
      echo "[openapi-rust] refusing foreign/replaced network cleanup: $expected_name" >&2
      return 1
    fi
  done
  for ((index = 0; index < ${#ACQUIRED_VOLUME_NAMES[@]}; index++)); do
    volume="${ACQUIRED_VOLUME_NAMES[$index]}"
    expected_identity="${ACQUIRED_VOLUME_IDENTITIES[$index]}"
    rc=0
    docker_query_state volume "$volume" '{{.Name}}|{{ index .Labels "com.momo.openapi-rust-gate" }}|{{ index .Labels "com.docker.compose.project" }}|{{.CreatedAt}}|{{.Mountpoint}}' binding || rc=$?
    case "$rc" in 1) continue ;; 0) ;; *) return 1 ;; esac
    IFS='|' read -r actual_name label project_label created mountpoint <<EOF
$binding
EOF
    if owned_binding_matches \
      "$expected_identity" "$created|$mountpoint" "$volume" "$actual_name" \
      "$RUN_NONCE" "$label" "$PROJECT" "$project_label"; then
      docker_remove_and_verify volume "$volume" || return 1
    else
      echo "[openapi-rust] refusing foreign/replaced volume cleanup: $volume" >&2
      return 1
    fi
  done
  if [ "$BUILD_IMAGE" -eq 1 ] && [ -n "$BUILT_IMAGE_ID" ]; then
    rc=0
    docker_query_state image "$BUILT_IMAGE_ID" '{{.Id}}|{{ index .Config.Labels "com.momo.openapi-rust-gate" }}' binding || rc=$?
    case "$rc" in 1) return 0 ;; 0) ;; *) return 1 ;; esac
    IFS='|' read -r actual_id label <<EOF
$binding
EOF
    if owned_binding_matches \
      "$BUILT_IMAGE_ID" "$actual_id" "$BUILT_IMAGE_ID" "$actual_id" \
      "$RUN_NONCE" "$label" "$PROJECT" "$PROJECT"; then
      docker_remove_and_verify image "$BUILT_IMAGE_ID" || return 1
    else
      echo "[openapi-rust] refusing foreign/replaced image cleanup: $RUST_IMAGE" >&2
      return 1
    fi
  fi
}

remove_registered_secrets() {
  local index path identity failed=0
  for ((index = 0; index < ${#SECRET_FILES[@]}; index++)); do
    path="${SECRET_FILES[$index]}"
    identity="${SECRET_IDENTITIES[$index]}"
    case "$path" in "$TMP_DIR"/*) ;; *) continue ;; esac
    if [ -f "$path" ] && [ ! -L "$path" ] && [ "$(file_identity "$path")" = "$identity" ]; then
      rm -f -- "$path" || failed=1
    elif [ -e "$path" ] || [ -L "$path" ]; then
      echo "[openapi-rust] refusing replaced secret-file cleanup: $path" >&2
      failed=1
    fi
  done
  [ "$failed" -eq 0 ]
}

perform_cleanup() {
  local run_rc="$1" cleanup_failed=0 survivor index
  print_failure_summary
  # Remove host-side credentials before any daemon operation that can hang.
  remove_registered_secrets || cleanup_failed=1
  if [ "$run_rc" -ne 0 ]; then
    # A failing shape/guard may have retained an unexpected secret under an
    # unrecognized response key. Evidence from a failed run is not trustworthy;
    # delete only this invocation's private high-entropy directory rather than
    # risk turning a verifier failure into a credential-retention sink.
    case "$TMP_DIR" in
      "${TMPDIR:-/tmp}"/momo-openapi-rust-gate-"$RUN_ID") rm -r -- "$TMP_DIR" || cleanup_failed=1 ;;
      *) echo "[openapi-rust] refusing unexpected failure-evidence cleanup path" >&2; cleanup_failed=1 ;;
    esac
  fi
  if [ "$MANAGED_STACK" -eq 1 ]; then
    echo "[openapi-rust] tearing down compose project '$PROJECT'"
    # compose build/up can be interrupted after Docker mutates state but before
    # the foreground command returns and assigns immutable IDs.  While this
    # invocation still holds its canonical project lock, reacquire only exact
    # project+high-entropy nonce bindings (and the exact build tag+nonce) so a
    # signal cannot strand a credential-bearing partial stack.
    if [ "$MUTATION_STARTED" -eq 1 ]; then
      capture_owned_resources || cleanup_failed=1
      capture_owned_image || cleanup_failed=1
    fi
    remove_owned_resources || cleanup_failed=1
    for ((index = 0; index < ${#ACQUIRED_CONTAINER_IDS[@]}; index++)); do
      survivor="${ACQUIRED_CONTAINER_IDS[$index]}"
      docker_require_absent container "$survivor" || cleanup_failed=1
    done
    for ((index = 0; index < ${#ACQUIRED_NETWORK_IDS[@]}; index++)); do
      survivor="${ACQUIRED_NETWORK_IDS[$index]}"
      docker_require_absent network "$survivor" || cleanup_failed=1
    done
    for ((index = 0; index < ${#ACQUIRED_VOLUME_NAMES[@]}; index++)); do
      survivor="${ACQUIRED_VOLUME_NAMES[$index]}"
      docker_require_absent volume "$survivor" || cleanup_failed=1
    done
    if [ "$BUILD_IMAGE" -eq 1 ] && [ -n "$BUILT_IMAGE_ID" ]; then
      docker_require_absent image "$BUILT_IMAGE_ID" || cleanup_failed=1
    fi
  fi
  if [ -d "$PROJECT_LOCK_DIR" ] && [ "$(path_identity "$PROJECT_LOCK_DIR")" = "$PROJECT_LOCK_IDENTITY" ]; then
    rmdir "$PROJECT_LOCK_DIR" 2>/dev/null || cleanup_failed=1
  elif [ -e "$PROJECT_LOCK_DIR" ]; then
    echo "[openapi-rust] refusing replaced project-lock cleanup" >&2
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" -ne 0 ]; then
    echo "[openapi-rust] cleanup failed or an owned resource survived" >&2
    return 1
  fi
  CLEANUP_DONE=1
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$CLEANUP_DONE" -eq 0 ]; then
    perform_cleanup "$rc" || [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 1) 스펙 YAML -> JSON (1차 패스와 **같은 함수**) -------------------------
# "같은 변환"이라고 적어 두고 사본을 뒀던 자리다(#1185). 사본에는 psych 3 재시도가
# 없어서, 로그인 셸이 /usr/bin/ruby 2.6 을 먼저 잡는 기계에서는 이 줄이 곧장 python
# 갈래로 떨어졌고 그 python 에 PyYAML 이 없어 여기서 죽었다 — 직접 실주행은 초록인
# 채로. 이제 두 패스가 한 함수를 부른다.
momo_openapi_spec_to_json "$SPEC_YAML" "$SPEC_JSON" openapi-rust "$PYTHON_BIN" || exit 1

# ---- 2) 매니페스트 적재 ------------------------------------------------------
EXPECTED_OPS="$TMP_DIR/expected-ops.txt"
sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$SAMPLED_ON_RUST" \
  | awk 'NF { print tolower($1) " " $2 }' | sort -u >"$EXPECTED_OPS"
EXPECTED_COUNT="$(wc -l <"$EXPECTED_OPS" | tr -d ' ')"
[ "$EXPECTED_COUNT" -gt 0 ] || {
  echo "[openapi-rust] $SAMPLED_ON_RUST lists no operations — nothing to prove" >&2
  exit 1
}
echo "[openapi-rust] sampled-on-rust manifest: $EXPECTED_COUNT operation(s)"

# 등재된 경로가 스펙에 실재하는지 먼저 본다. 오타 한 글자가 "샘플은 초록인데
# 아무것도 검증하지 않는" 상태를 만들 수 있기 때문이다.
"$PYTHON_BIN" - "$SPEC_JSON" "$EXPECTED_OPS" <<'PY' || exit 1
import json, sys
spec_path, ops_path = sys.argv[1], sys.argv[2]
with open(spec_path, encoding="utf-8") as handle:
    spec = json.load(handle)
documented = {
    (method.lower(), path)
    for path, item in (spec.get("paths") or {}).items()
    for method in item
    if method.lower() in {"get", "put", "post", "delete", "patch", "head", "options", "trace"}
}
missing = []
with open(ops_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        method, _, path = line.partition(" ")
        if (method.lower(), path) not in documented:
            missing.append(f"{method.upper()} {path}")
if missing:
    print(
        "[openapi-rust] FAIL sampled-on-rust manifest lists operations the spec "
        "does not document:",
        file=sys.stderr,
    )
    for entry in missing:
        print(f"    - {entry}", file=sys.stderr)
    sys.exit(1)

# HAP-E2's public security boundary is static contract, not merely a route
# that happens to return 200 in this fixture. Keep the POST-only shape,
# dedicated non-OAuth bearer scheme, conditional MCP headers, exact status
# vocabulary, and body-less notification/auth responses reviewable before a
# Docker build starts.
errors = []
agent_port = (spec.get("paths") or {}).get("/v1/mcp/agent-port")
if not isinstance(agent_port, dict):
    errors.append("missing /v1/mcp/agent-port Path Item")
else:
    methods = {
        key.lower()
        for key in agent_port
        if key.lower() in {"get", "put", "post", "delete", "patch", "head", "options", "trace"}
    }
    if methods != {"post"}:
        errors.append(f"Agent Port methods must be exactly POST, got {sorted(methods)}")
    post = agent_port.get("post") or {}
    if post.get("security") != [{"agentPortBearerAuth": []}]:
        errors.append("Agent Port must use only agentPortBearerAuth")
    expected_parameters = {
        "#/components/parameters/MCPProtocolVersion",
        "#/components/parameters/MCPMethod",
        "#/components/parameters/MCPName",
    }
    actual_parameters = {
        item.get("$ref")
        for item in (post.get("parameters") or [])
        if isinstance(item, dict)
    }
    if actual_parameters != expected_parameters:
        errors.append(
            "Agent Port conditional protocol header set drifted: "
            f"{sorted(str(value) for value in actual_parameters)}"
        )
    content = ((post.get("requestBody") or {}).get("content") or {})
    if set(content) != {"application/json"}:
        errors.append("Agent Port request media type must be exactly application/json")
    responses = post.get("responses") or {}
    expected_statuses = {"200", "202", "400", "401", "403", "413", "415", "429", "500"}
    if set(responses) != expected_statuses:
        errors.append(
            "Agent Port response status set drifted: "
            f"expected {sorted(expected_statuses)}, got {sorted(responses)}"
        )
    if (responses.get("202") or {}).get("content"):
        errors.append("Agent Port 202 notification response must be body-less")
    if (responses.get("401") or {}).get("$ref") != "#/components/responses/AgentPortUnauthorized":
        errors.append("Agent Port 401 must use the dedicated empty bearer challenge")
    if (responses.get("403") or {}).get("$ref") != "#/components/responses/AgentPortForbidden":
        errors.append("Agent Port 403 must use the dedicated insufficient-scope challenge")
    success_ref = (
        (((responses.get("200") or {}).get("content") or {}).get("application/json") or {})
        .get("schema", {}).get("$ref")
    )
    if success_ref != "#/components/schemas/AgentPortJSONRPCSuccessResponse":
        errors.append("Agent Port 200 must permit only the exact success envelope")
    for error_status in ("400", "413", "415"):
        error_ref = (
            (((responses.get(error_status) or {}).get("content") or {}).get("application/json") or {})
            .get("schema", {}).get("$ref")
        )
        if error_ref != "#/components/schemas/AgentPortJSONRPCErrorResponse":
            errors.append(f"Agent Port {error_status} must permit only the exact error envelope")
    response_500 = responses.get("500") or {}
    if response_500.get("content"):
        errors.append("Agent Port 500 must be the opaque body-less transaction failure")
    rate_ref = (responses.get("429") or {}).get("$ref")
    if rate_ref != "#/components/responses/AgentPortRateLimited":
        errors.append("Agent Port 429 must use the dedicated rate response")

components = spec.get("components") or {}
scheme = (components.get("securitySchemes") or {}).get("agentPortBearerAuth") or {}
if scheme.get("type") != "http" or scheme.get("scheme") != "bearer":
    errors.append("agentPortBearerAuth must be an HTTP bearer scheme")
if any(key in scheme for key in ("flows", "openIdConnectUrl")):
    errors.append("static Agent Port wave must not advertise OAuth/OIDC metadata")
versions = (
    (((components.get("parameters") or {}).get("MCPProtocolVersion") or {}).get("schema") or {}).get("enum")
    or []
)
if versions != ["2026-07-28", "2025-11-25"]:
    errors.append(f"Agent Port supported version list drifted: {versions!r}")

schemas = components.get("schemas") or {}
rate_schema_ref = (
    ((((components.get("responses") or {}).get("AgentPortRateLimited") or {}).get("content") or {})
     .get("application/json") or {}).get("schema", {}).get("$ref")
)
if rate_schema_ref != "#/components/schemas/AgentPortJSONRPCErrorResponse":
    errors.append("Agent Port rate response must permit only the exact error envelope")
request_union = (schemas.get("AgentPortJSONRPCRequest") or {}).get("oneOf") or []
expected_requests = {
    "#/components/schemas/AgentPortModernDiscoverRequest",
    "#/components/schemas/AgentPortModernToolsListRequest",
    "#/components/schemas/AgentPortModernToolsCallRequest",
    "#/components/schemas/AgentPortLegacyInitializeRequest",
    "#/components/schemas/AgentPortLegacyInitializedNotification",
    "#/components/schemas/AgentPortLegacyPingRequest",
    "#/components/schemas/AgentPortLegacyToolsListRequest",
    "#/components/schemas/AgentPortLegacyToolsCallRequest",
}
if len(request_union) != len(expected_requests) or any(set(item) != {"$ref"} for item in request_union if isinstance(item, dict)) or {item.get("$ref") for item in request_union if isinstance(item, dict)} != expected_requests:
    errors.append("Agent Port request must remain the exact eight-variant era/method union")
result_union = (schemas.get("AgentPortResult") or {}).get("oneOf") or []
expected_results = {
    "#/components/schemas/AgentPortModernDiscoverResult",
    "#/components/schemas/AgentPortModernToolsListResult",
    "#/components/schemas/AgentPortLegacyInitializeResult",
    "#/components/schemas/AgentPortLegacyToolsListResult",
    "#/components/schemas/AgentPortPingResult",
}
if len(result_union) != len(expected_results) or any(set(item) != {"$ref"} for item in result_union if isinstance(item, dict)) or {item.get("$ref") for item in result_union if isinstance(item, dict)} != expected_results:
    errors.append("Agent Port result must remain the exact five-variant closed union")
response_union = (schemas.get("AgentPortJSONRPCResponse") or {}).get("oneOf") or []
expected_responses = {
    "#/components/schemas/AgentPortJSONRPCSuccessResponse",
    "#/components/schemas/AgentPortJSONRPCErrorResponse",
}
if len(response_union) != len(expected_responses) or any(set(item) != {"$ref"} for item in response_union if isinstance(item, dict)) or {item.get("$ref") for item in response_union if isinstance(item, dict)} != expected_responses:
    errors.append("Agent Port response must require exactly one of result or error")
success_schema = schemas.get("AgentPortJSONRPCSuccessResponse") or {}
error_schema = schemas.get("AgentPortJSONRPCErrorResponse") or {}
if success_schema.get("additionalProperties") is not False or set(success_schema.get("required") or []) != {"jsonrpc", "id", "result"}:
    errors.append("Agent Port success envelope must be closed and require jsonrpc/id/result")
if error_schema.get("additionalProperties") is not False or set(error_schema.get("required") or []) != {"jsonrpc", "id", "error"}:
    errors.append("Agent Port error envelope must be closed and require jsonrpc/id/error")
success_id_ref = ((success_schema.get("properties") or {}).get("id") or {}).get("$ref")
if success_id_ref != "#/components/schemas/AgentPortJSONRPCRequestId":
    errors.append("Agent Port success id must be a non-null request id")

if errors:
    print("[openapi-rust] FAIL Agent Port static contract:", file=sys.stderr)
    for error in errors:
        print(f"    - {error}", file=sys.stderr)
    sys.exit(1)
print(f"[openapi-rust] PASS manifest entries all exist in the spec")
print("[openapi-rust] PASS Agent Port POST-only static bearer contract")
PY

# ---- 3) Rust 부분집합 스택 ---------------------------------------------------
EXISTING_CONTAINERS="$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$PROJECT")" || {
  echo "[openapi-rust] could not prove compose-project container absence" >&2
  exit 1
}
EXISTING_NETWORKS="$(docker network ls -q --no-trunc --filter "label=com.docker.compose.project=$PROJECT")" || {
  echo "[openapi-rust] could not prove compose-project network absence" >&2
  exit 1
}
EXISTING_VOLUMES="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" || {
  echo "[openapi-rust] could not prove compose-project volume absence" >&2
  exit 1
}
EXISTING_NAMED_VOLUME="$(docker volume ls -q --filter "name=^${GATE_DB_VOLUME}$")" || {
  echo "[openapi-rust] could not prove exact gate volume-name absence" >&2
  exit 1
}
if [ -n "$EXISTING_CONTAINERS" ] || [ -n "$EXISTING_NETWORKS" ] || [ -n "$EXISTING_VOLUMES" ] || [ -n "$EXISTING_NAMED_VOLUME" ]; then
  echo "[openapi-rust] project/volume already exists; refusing to adopt foreign resources: $PROJECT" >&2
  exit 1
fi
EXISTING_IMAGE_IDS="$(docker image ls -q --no-trunc "$RUST_IMAGE")" || {
  echo "[openapi-rust] could not inspect the requested image reference" >&2
  exit 1
}
if [ "$BUILD_IMAGE" -eq 1 ] && [ -n "$EXISTING_IMAGE_IDS" ]; then
  echo "[openapi-rust] build tag already exists; refusing to retarget foreign image: $RUST_IMAGE" >&2
  exit 1
fi
if [ "$BUILD_IMAGE" -eq 0 ]; then
  [ -n "$EXISTING_IMAGE_IDS" ] || {
    echo "[openapi-rust] reusable image reference is absent" >&2
    exit 1
  }
  REUSED_IMAGE_BINDING=''
  REUSED_IMAGE_QUERY_RC=0
  docker_image_ref_query_state "$RUST_IMAGE" '{{.Id}}' REUSED_IMAGE_BINDING || REUSED_IMAGE_QUERY_RC=$?
  [ "$REUSED_IMAGE_QUERY_RC" -eq 0 ] || {
    echo "[openapi-rust] reusable image inspect failed or became absent" >&2
    exit 1
  }
  REUSED_IMAGE_ID="$REUSED_IMAGE_BINDING"
  valid_image_id "$REUSED_IMAGE_ID" || {
    echo "[openapi-rust] reusable image does not resolve to an exact immutable image id" >&2
    exit 1
  }
  RUN_IMAGE_ID="$REUSED_IMAGE_ID"
  export MOMO_RUST_IMAGE="$RUN_IMAGE_ID"
fi

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
for p in "$API_PORT" "$CENT_PORT"; do
  if port_in_use "$p"; then
    echo "[openapi-rust] host port $p is already busy; refusing to adopt any listener" >&2
    echo "[openapi-rust] Override with OPENAPI_RUST_GATE_API_PORT / OPENAPI_RUST_GATE_CENT_PORT." >&2
    exit 1
  fi
done

BASE_URL="http://127.0.0.1:$API_PORT"
MANAGED_STACK=1

if [ "$BUILD_IMAGE" -eq 1 ]; then
  # 배포 이미지 빌드 경로 그대로(server-rust/Dockerfile, context=repo root).
  # 커밋된 build 오버레이를 쓰므로 그 배선이 썩으면 여기서 먼저 드러난다.
  echo "[openapi-rust] building $RUST_IMAGE from the checkout (server-rust/Dockerfile)"
  MUTATION_STARTED=1
  compose build api
  capture_owned_image || {
    echo "[openapi-rust] build image ownership/read query failed" >&2
    exit 1
  }
  valid_image_id "$BUILT_IMAGE_ID" || {
    echo "[openapi-rust] build did not return an exact immutable image id" >&2
    exit 1
  }
  RUN_IMAGE_ID="$BUILT_IMAGE_ID"
  # `compose up` must consume the immutable snapshot, never the tag that a
  # concurrent process can retarget after our provenance check.
  export MOMO_RUST_IMAGE="$RUN_IMAGE_ID"
else
  echo "[openapi-rust] reusing prebuilt image $RUST_IMAGE (MOMO_RUST_IMAGE)"
fi

# 부분집합: api 만 올린다. depends_on 이 postgres·centrifugo·runtime-roles·migrate
# 를 끌고 오고, relay/agent-worker 는 뜨지 않는다 — 등재된 연산의 응답은 전부
# 같은 트랜잭션 안에서 나오고, 브로드캐스트는 `outbox` 행으로 끝나기 때문이다.
# (relay 가 그 행을 언제 빼 가는지는 이 패스가 대조하는 모양이 아니다.)
echo "[openapi-rust] booting rust subset stack '$PROJECT' (api on $BASE_URL)"
MUTATION_STARTED=1
if ! compose up -d api; then
  capture_owned_resources || true
  echo "[openapi-rust] compose up failed" >&2
  exit 1
fi
capture_owned_resources
[ "${#ACQUIRED_CONTAINER_IDS[@]}" -gt 0 ] || {
  echo "[openapi-rust] compose created no verifiably owned containers" >&2
  exit 1
}
[ "${#ACQUIRED_NETWORK_IDS[@]}" -eq 1 ] || {
  echo "[openapi-rust] expected exactly one verifiably owned network" >&2
  exit 1
}
[ "${#ACQUIRED_VOLUME_NAMES[@]}" -eq 1 ] || {
  echo "[openapi-rust] expected exactly one verifiably owned volume" >&2
  exit 1
}
API_CONTAINER_ID="$(compose ps -q --no-trunc api)"
valid_object_id "$API_CONTAINER_ID" || {
  echo "[openapi-rust] compose did not return one exact API container id" >&2
  exit 1
}
API_CONTAINER_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER_ID")"
[ "$API_CONTAINER_IMAGE_ID" = "$RUN_IMAGE_ID" ] || {
  echo "[openapi-rust] API container did not start from the captured immutable image id" >&2
  exit 1
}

echo "[openapi-rust] waiting for $BASE_URL/health (timeout ${BOOT_TIMEOUT}s)"
deadline=$(( $(date -u +%s) + BOOT_TIMEOUT ))
until curl -fsS "$BASE_URL/health" >/dev/null 2>&1; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "[openapi-rust] timed out waiting for server health" >&2
    print_safe_startup_logs || true
    exit 1
  fi
  if [ -n "$(compose ps -aq --status exited api 2>/dev/null)" ]; then
    echo "[openapi-rust] api container exited before health became green" >&2
    print_safe_startup_logs || true
    exit 1
  fi
  sleep 2
done
echo "[openapi-rust] server health is green"

# ---- 4) 픽스처 --------------------------------------------------------------
# 등재된 연산이 **왕복하는 데 실제로 필요한 행만** 심는다. 규칙은 하나다:
# HTTP 로 만들 수 있는 일반 제품 데이터는 HTTP 로 만들고(그건 픽스처가 아니라
# 표본이다), 다른 goal의 lifecycle이나 미등재 route에 의존하면 이 gate가 순서에
# 묶이는 행만 SQL 로 심는다:
#
#   * 사람 멤버 둘 — 로그인할 비밀번호를 아는 계정이 필요하고(가입 라우트는
#     초대 코드가 있어야 하며 그건 아래 코드가 준다), DM 은 상대가 있어야 열린다.
#   * agent 멤버 + `agent` 행 + **agent bearer 토큰** — #1358 credential lifecycle과
#     독립적으로 work-control/Agent Port의 서로 다른 scope를 이 gate가 직접 고정한다.
#     `POST …/work-controls` 는 agent bearer 전용이라(momo_auth::agent_scope), 이 행이
#     없으면 #1132 이탈 6 이 가리킨 5 개 연산 중 어느 것도 왕복하지 않는다.
#   * `agent_run` 세 개 — 승인 하나(awaiting_approval), work-control 이 붙을
#     running 하나, 사람의 「멈춰라」가 끝낼 queued 하나. 상태가 곧 자격이라
#     한 행을 돌려 쓸 수 없다(control_run_binding_in_tx 는 queued|running 만 받는다).
#   * pending 승인 하나 — 생산자는 agent worker 이고 이 부분집합엔 없다.
#   * 초대 코드 하나 — `POST /v1/workspaces/{ws}/invites` 는 **스펙에 없는 라우트**라
#     표본이 될 수 없다. 등재 대상 밖의 라우트를 픽스처로 쓰면 매니페스트가
#     그것을 「샘플인데 미등재」로 잡으므로, 발급은 SQL 로 한다.
run_sql() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"
}

echo "[openapi-rust] installing gate fixtures (members/agent-bearer/runs/approval/invite)"
run_sql <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$DEMO_WORKSPACE_ID';
SET LOCAL row_security = off;

-- Raw login/invite credentials travel only as PostgreSQL CopyData on stdin;
-- they never appear in psql argv, SQL statement text/pg_stat_activity, or a
-- retained fixture file. The temp table is transaction-local and dropped.
CREATE TEMP TABLE gate_secret (name text PRIMARY KEY, value text NOT NULL) ON COMMIT DROP;
COPY gate_secret (name, value) FROM STDIN;
login_password	$GATE_PASSWORD
invite_code	$INVITE_CODE
\.

DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent WHERE member_id = '$KIM_INTERN_MEMBER_ID'
  ) THEN
    RAISE EXCEPTION
      'agent seed missing — the rust stack must migrate with MOMO_AGENT_SEED_MODE=e2e';
  END IF;
END \$\$;

INSERT INTO member (id, workspace_id, kind, status, display_name, handle)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'OpenAPI Rust Gate', '$GATE_HANDLE'),
       ('$GATE_PEER_ID', '$DEMO_WORKSPACE_ID', 'human', 'active',
        'OpenAPI Rust Gate Peer', '$GATE_HANDLE-peer'),
       ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'agent', 'active',
        'OpenAPI Rust Gate Agent', '$GATE_AGENT_HANDLE');

INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz)
VALUES ('$GATE_MEMBER_ID', '$DEMO_WORKSPACE_ID', '$GATE_EMAIL', true,
        momo_password_hash((SELECT value FROM gate_secret WHERE name = 'login_password')), 'UTC'),
       ('$GATE_PEER_ID', '$DEMO_WORKSPACE_ID', '$GATE_PEER_EMAIL', true,
        momo_password_hash((SELECT value FROM gate_secret WHERE name = 'login_password')), 'UTC');

INSERT INTO membership (workspace_id, channel_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_PEER_ID', 'member'),
       ('$DEMO_WORKSPACE_ID', '$GENERAL_CHANNEL_ID', '$GATE_AGENT_ID', 'member');

INSERT INTO workspace_membership (workspace_id, member_id, role)
VALUES ('$DEMO_WORKSPACE_ID', '$GATE_MEMBER_ID', 'admin'),
       ('$DEMO_WORKSPACE_ID', '$GATE_PEER_ID', 'member'),
       ('$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID', 'member');

-- owner_human_id 가 게이트 사람인 것이 요점이다. spawn 자동승인은 요청자
-- 에이전트의 **owner human** 에 대해 조회되므로(spawn_is_auto_approved_in_tx),
-- 게이트가 PUT …/work-auto-approvals/codex 로 쓴 그 행이 곧 이 에이전트의
-- 자동승인이 된다. 다른 사람 소유로 심으면 control 이 pending_approval 에
-- 머물러 ack 표본이 성립하지 않는다.
INSERT INTO agent (member_id, workspace_id, model, base_url, system_prompt, owner_human_id)
VALUES ('$GATE_AGENT_ID', '$DEMO_WORKSPACE_ID', 'hermes-agent',
        'https://hermes.openapi.example.test/v1',
        'openapi rust sample pass', '$GATE_MEMBER_ID');

-- 원문 토큰은 이 셸에만 있고 PostgreSQL 에는 sha256 다이제스트만 들어간다.
INSERT INTO token
  (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label)
VALUES ('$DEMO_WORKSPACE_ID', 'agent_bearer', '$GATE_AGENT_ID', NULL,
        decode('$GATE_AGENT_TOKEN_HASH', 'hex'),
        ARRAY['work:control', 'agent:port:connect'], 'openapi rust gate'),
       ('$DEMO_WORKSPACE_ID', 'agent_bearer', '$GATE_AGENT_ID', NULL,
        decode('$GATE_AGENT_NO_PORT_TOKEN_HASH', 'hex'),
        ARRAY['work:control'], 'openapi rust gate no agent port');

-- /v1/join 표본의 코드. 원문은 이 런에만 있고 저장되는 것은 해시다.
INSERT INTO invite_code
  (workspace_id, code_hash, code_preview, role, max_uses, expires_at, created_by)
VALUES ('$DEMO_WORKSPACE_ID', momo_invite_code_hash(
          (SELECT value FROM gate_secret WHERE name = 'invite_code')), '',
        'member', 5, now() + interval '1 day', '$GATE_MEMBER_ID');

INSERT INTO agent_run
  (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key)
VALUES ('$RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'awaiting_approval',
        '{"prompt":"openapi rust sample pass"}'::jsonb, 'openapi-rust-gate-$RUN_ID'),
       ('$CONTROL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$GATE_AGENT_ID',
        '$GENERAL_CHANNEL_ID', 'running',
        '{"prompt":"openapi rust work control"}'::jsonb,
        'openapi-rust-control-$RUN_ID'),
       ('$CANCEL_RUN_UUID', '$DEMO_WORKSPACE_ID', '$KIM_INTERN_MEMBER_ID',
        '$GENERAL_CHANNEL_ID', 'queued',
        '{"prompt":"openapi rust cancel"}'::jsonb,
        'openapi-rust-cancel-$RUN_ID');

INSERT INTO approval
  (id, workspace_id, run_id, channel_id, requested_by, action_type, payload,
   status, expires_at)
VALUES ('$APPROVAL_UUID', '$DEMO_WORKSPACE_ID', '$RUN_UUID',
        '$GENERAL_CHANNEL_ID', '$KIM_INTERN_MEMBER_ID', 'tool_call',
        '{"tool_call":{"call_id":"rust-gate-1","name":"github.search_issues","arguments":{}},"estimated_micro_usd":4200,"is_reversible":true,"on_behalf_of":"$GATE_MEMBER_ID"}'::jsonb,
        'pending', now() + interval '1 hour');

COMMIT;
SQL

# ---- 5) 매니페스트 등재 연산 샘플 -------------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""
RESPONSE_HEADERS=""
SAMPLE_INDEX=0

api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local out="$RAW_RESPONSE_FILE" headers="$RAW_HEADERS_FILE" verb
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  local -a args=(-sS -o "$out" -D "$headers" -w "%{http_code}" -X "$verb" -H "Content-Type: application/json")
  set_curl_bearer "$token" || return 1
  args+=(--config "$CURL_AUTH_CONFIG")
  if [ -n "$body" ]; then
    set_curl_body "$body" || return 1
    args+=(--data-binary "@$CURL_BODY_FILE")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  load_scanned_response_headers
}

# Agent Port는 일반 REST와 다른 transport headers 및 전용 bearer challenge를
# 가진다. 이 helper는 secret을 URL/query에 넣지 않고 Authorization에만 둔다.
agent_port_api() {
  local verb="$1" body="${2:-}" token="${3:-}" version="${4:-}"
  local mcp_method="${5:-}" mcp_name="${6:-}"
  local out="$RAW_RESPONSE_FILE" headers="$RAW_HEADERS_FILE"
  local -a args=(-sS -o "$out" -D "$headers" -w "%{http_code}" -X "$verb"
    -H 'Content-Type: application/json'
    -H 'Accept: application/json, text/event-stream')
  set_curl_bearer "$token" || return 1
  args+=(--config "$CURL_AUTH_CONFIG")
  [ -n "$version" ] && args+=(-H "MCP-Protocol-Version: $version")
  [ -n "$mcp_method" ] && args+=(-H "Mcp-Method: $mcp_method")
  [ -n "$mcp_name" ] && args+=(-H "Mcp-Name: $mcp_name")
  if [ -n "$body" ]; then
    set_curl_body "$body" || return 1
    args+=(--data-binary "@$CURL_BODY_FILE")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL/v1/mcp/agent-port")"
  RESPONSE_BODY="$(cat "$out")"
  load_scanned_response_headers
}

response_header() {
  local wanted="$1"
  printf '%s\n' "$RESPONSE_HEADERS" | tr -d '\r' | awk -F ': *' -v wanted="$wanted" '
    tolower($1) == tolower(wanted) {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      value = line
    }
    END { print value }
  '
}

sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5" body="${6:-}" token="${7:-}"
  api "$method" "$path" "$body" "$token"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    # 잘못된 상태의 본문은 매니페스트에 넣지 않는다 — 그러면 커버리지 검사가
    # 그 연산을 '미샘플'로 잡아 초록이 될 수 없다.
    gate_fail "$name" "expected HTTP $expected, got $RESPONSE_STATUS" "$(redacted_body)"
    return 0
  fi
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  local file
  file="$(printf '%s/sample-%02d-%s.json' "$TMP_DIR" "$SAMPLE_INDEX" "$name")"
  printf '%s' "$RESPONSE_BODY" | redact_json >"$file"
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$file" \
    '{name:$name, method:$method, path:$path, status:$status, body_file:$body_file}' \
    >>"$MANIFEST"
  echo "[openapi-rust] SAMPLE $name -> $expected"
}

sample_agent_port() {
  local name="$1" expected="$2" body="$3" token="$4" version="${5:-}"
  local mcp_method="${6:-}" mcp_name="${7:-}"
  agent_port_api POST "$body" "$token" "$version" "$mcp_method" "$mcp_name"
  # One OpenAPI operation can have multiple era/response samples, but the
  # sampled-on-Rust coverage comparison is a set of operations. Record both
  # distinct response statuses once so 200 JSON and 202 empty are shape-checked;
  # the other same-status calls are exact jq guards.
  local marker="post /v1/mcp/agent-port $expected"
  if ! grep -Fqx "$marker" "$MANIFEST.agent-port-samples" 2>/dev/null; then
    record_sample "$name" post "/v1/mcp/agent-port" "$expected"
    printf '%s\n' "$marker" >>"$MANIFEST.agent-port-samples"
  elif [ "$RESPONSE_STATUS" != "$expected" ]; then
    gate_fail "$name" "expected HTTP $expected, got $RESPONSE_STATUS" "$(redacted_body)"
  fi
}

expect_agent_port() {
  local name="$1" expected="$2" body="$3" token="$4" version="${5:-}"
  local mcp_method="${6:-}" mcp_name="${7:-}"
  agent_port_api POST "$body" "$token" "$version" "$mcp_method" "$mcp_name"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    gate_fail "$name" "expected HTTP $expected, got $RESPONSE_STATUS" "$(redacted_body)"
  fi
}

guard_jq() {
  local label="${*: -1}"
  set -- "${@:1:$(($# - 1))}"
  printf '%s' "$RESPONSE_BODY" | jq -e "$@" >/dev/null \
    || gate_fail "guard" "$label" "$(redacted_body)"
  return 0
}

# 사람 자격증명으로는 도달할 수 없는 호출자가 하나 있다: **서명 데몬**.
# `Authorization: MomoHost {hostId}` + v2 서명 3 헤더가 그 자격증명이고, 서명이
# 덮는 바이트는 메서드·**원문 경로**·워크스페이스·호스트·시각·본문 SHA-256·요청
# id 다(momo_wire::request_payload). 요청 id 는 한 번만 소비되므로 매 호출이
# 새 id 를 만든다 — 재사용은 401 이고, 그건 재생 방벽이 살아 있다는 뜻이다.
now_ms() { "$PYTHON_BIN" -c 'import time; print(time.time_ns() // 1_000_000)'; }

work_host_signed_sample() {
  local name="$1" method="$2" template="$3" path="$4" expected="$5"
  local host_id="$6" private_key="$7" body="${8:-}"
  local sent_at request_id body_hash payload signature verb
  local out="$RAW_RESPONSE_FILE" auth_config="$TMP_DIR/work-host-curl.conf"
  sent_at="$(now_ms)"
  request_id="$(lower_uuid)"
  body_hash="$(printf '%s' "$body" | "$OPENSSL_BIN" dgst -sha256 | awk '{print $NF}')"
  verb="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
  payload="$TMP_DIR/work-host-request-$name.bin"
  printf 'momo.work_host.request.v2\n%s\n%s\n%s\n%s\n%s\n%s\n%s' \
    "$verb" "$path" \
    "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" "$body_hash" "$request_id" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$private_key" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  (umask 077; : >"$auth_config")
  register_secret_file "$auth_config" || return 1
  append_secret_with_derivatives "$signature" || return 1
  printf 'header = "Authorization: MomoHost %s"\n' "$host_id" >"$auth_config"
  printf 'header = "X-Momo-Work-Host-Sent-At: %s"\n' "$sent_at" >>"$auth_config"
  printf 'header = "X-Momo-Work-Host-Signature: %s"\n' "$signature" >>"$auth_config"
  printf 'header = "X-Momo-Work-Host-Request-ID: %s"\n' "$request_id" >>"$auth_config"
  local -a args=(-sS -o "$out" -w "%{http_code}" -X "$verb"
    --config "$auth_config"
    -H 'Content-Type: application/json'
  )
  if [ -n "$body" ]; then
    set_curl_body "$body" || return 1
    args+=(--data-binary "@$CURL_BODY_FILE")
  fi
  RESPONSE_STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
  RESPONSE_BODY="$(cat "$out")"
  record_sample "$name" "$method" "$template" "$expected"
}

# `sample` 의 기록 절반만: 요청을 이미 다른 자격증명으로 보낸 호출자가 쓴다.
record_sample() {
  local name="$1" method="$2" template="$3" expected="$4"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    gate_fail "$name" "expected HTTP $expected, got $RESPONSE_STATUS" "$(redacted_body)"
    return 0
  fi
  SAMPLE_INDEX=$((SAMPLE_INDEX + 1))
  local file
  file="$(printf '%s/sample-%02d-%s.json' "$TMP_DIR" "$SAMPLE_INDEX" "$name")"
  printf '%s' "$RESPONSE_BODY" | redact_json >"$file"
  jq -cn --arg name "$name" --arg method "$method" --arg path "$template" \
    --arg status "$expected" --arg body_file "$file" \
    '{name:$name, method:$method, path:$path, status:$status, body_file:$body_file}' \
    >>"$MANIFEST"
  echo "[openapi-rust] SAMPLE $name -> $expected"
}

# `sample_agent_port` / `expect_agent_port` are defined before this generic
# recorder because Bash resolves function bodies at call time; every call
# happens only after the whole script has been parsed.

# 픽스처 호출: 상태만 단정하고 매니페스트에는 넣지 않는다. 등재 연산을 준비
# 단계로 한 번 더 부르는 경우(스레드 루트의 답글, ack 이 묶일 세션 …)와 스펙에
# 아예 없는 라우트는 여기로 간다 — 표본이 아니라 전제이기 때문이다.
expect() {
  local label="$1" method="$2" path="$3" expected="$4" body="${5:-}" token="${6:-}"
  api "$method" "$path" "$body" "$token"
  [ "$RESPONSE_STATUS" = "$expected" ] && return 0
  echo "[openapi-rust] FAIL fixture $label: expected HTTP $expected, got $RESPONSE_STATUS" >&2
  redacted_body >&2
  exit 1
}

WS="$DEMO_WORKSPACE_ID"

# 데몬의 서명 키. 등록은 HTTP 로 하고(그 자체가 표본이다), 개인키는 TMP_DIR
# (0700) 안에만 존재한다.
HOST_KEY="$TMP_DIR/work-host.pem"
(umask 077; : >"$HOST_KEY")
register_secret_file "$HOST_KEY" || {
  echo "[openapi-rust] work-host private key is not an owned 0600 regular file" >&2
  exit 1
}
"$OPENSSL_BIN" genpkey -algorithm ED25519 -out "$HOST_KEY" >/dev/null 2>&1
HOST_PUBLIC_KEY="$("$OPENSSL_BIN" pkey -in "$HOST_KEY" -pubout -outform DER 2>/dev/null \
  | tail -c 32 | "$OPENSSL_BIN" base64 -A)"

heartbeat_body() {
  local host_id="$1" sent_at payload signature
  sent_at="$(now_ms)"
  payload="$TMP_DIR/work-host-heartbeat-$host_id.bin"
  printf 'momo.work_host.heartbeat.v1\n%s\n%s\n%s' \
    "$(printf '%s' "$WS" | tr '[:upper:]' '[:lower:]')" \
    "$(printf '%s' "$host_id" | tr '[:upper:]' '[:lower:]')" \
    "$sent_at" >"$payload"
  signature="$("$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$HOST_KEY" \
    -in "$payload" | "$OPENSSL_BIN" base64 -A)"
  append_secret_with_derivatives "$signature" || return 1
  printf '%s' "$signature" | jq -Rsc --argjson sent "$sent_at" \
    '{sentAtMs:$sent,signature:.}'
}

# ---------------------------------------------------------------------------
# auth — 아래 모든 표본의 자격증명 출처.
# ---------------------------------------------------------------------------
LOGIN_PASSWORD_FILE="$TMP_DIR/login-password.txt"
(umask 077; : >"$LOGIN_PASSWORD_FILE")
register_secret_file "$LOGIN_PASSWORD_FILE"
printf '%s' "$GATE_PASSWORD" >"$LOGIN_PASSWORD_FILE"
sample login post "/v1/auth/login" "/v1/auth/login" 200 \
  "$(jq -cn --arg e "$GATE_EMAIL" --rawfile p "$LOGIN_PASSWORD_FILE" --arg w "$WS" \
      '{email:$e,password:$p,workspace:$w}')"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken // empty')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -r '.refreshToken // empty')"
append_secret_with_derivatives "$ACCESS"
append_secret_with_derivatives "$REFRESH"
[ -n "$ACCESS" ] || {
  echo "[openapi-rust] login produced no accessToken — nothing below can be sampled" >&2
  redacted_body >&2
  exit 1
}

# refresh 는 **단일 사용 회전**이다: 제시한 토큰은 원자적으로 revoke 되고 새 쌍이
# 나온다. 그러므로 한 번만 부르고, 이후 전부 새 쌍을 쓴다.
sample refresh post "/v1/auth/refresh" "/v1/auth/refresh" 200 \
  "$(refresh_request_body "$REFRESH")"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.accessToken')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -er '.refreshToken')"
append_secret_with_derivatives "$ACCESS"
append_secret_with_derivatives "$REFRESH"

sample realtime-token post "/v1/auth/realtime-token" "/v1/auth/realtime-token" 200 \
  "" "$ACCESS"
REALTIME_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -r '.token // empty')"
append_secret_with_derivatives "$REALTIME_SECRET"
guard_jq '.tokenType == "centrifugo.connection.jwt" and (.expiresAtMs | type == "number")' \
  "realtime token is a centrifugo connection jwt"

# ---------------------------------------------------------------------------
# hosted-agent Agent Port — 한 POST operation의 modern/legacy 양 시대 계약.
# ---------------------------------------------------------------------------
MODERN_DISCOVER_ID="openapi-modern-discover-$RUN_ID"
MODERN_DISCOVER_BODY="$(jq -cn --arg id "$MODERN_DISCOVER_ID" '
  {
    jsonrpc:"2.0",
    id:$id,
    method:"server/discover",
    params:{
      _meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{
          name:"oort-openapi-rust-gate",
          version:"1.0.0"
        }
      }
    }
  }')"
sample_agent_port agent-port-modern-discover 200 "$MODERN_DISCOVER_BODY" \
  "$GATE_AGENT_TOKEN" "2026-07-28" "server/discover"
guard_jq --arg id "$MODERN_DISCOVER_ID" '
  .jsonrpc == "2.0"
  and .id == $id
  and .result.protocolVersion == "2026-07-28"
  and .result.capabilities == {tools:{listChanged:false}}
  and .result.serverInfo.name == "oort-agent-port"
  and .result.serverInfo.title == "oort Agent Port"
  and (.result.serverInfo.version | type == "string")
  and .result.resultType == "server/discover"
  and .result.cache == {ttlSeconds:300,scope:"private"}
  and (.error | not)' \
  "modern discovery returns the pinned sessionless Agent Port contract"
if [ -n "$(response_header Mcp-Session-Id)" ]; then
  gate_fail agent-port-modern-discover \
    "stateless modern response must not issue Mcp-Session-Id" "$(redacted_headers)"
fi
if [ "$(response_header Cache-Control)" != "private, no-store" ]; then
  gate_fail agent-port-modern-discover \
    "expected Cache-Control: private, no-store" "$(redacted_headers)"
fi

MODERN_LIST_ID="openapi-modern-list-$RUN_ID"
MODERN_LIST_BODY="$(jq -cn --arg id "$MODERN_LIST_ID" '
  {
    jsonrpc:"2.0",
    id:$id,
    method:"tools/list",
    params:{
      _meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }')"
sample_agent_port agent-port-modern-tools-list 200 "$MODERN_LIST_BODY" \
  "$GATE_AGENT_TOKEN" "2026-07-28" "tools/list"
guard_jq --arg id "$MODERN_LIST_ID" '
  .jsonrpc == "2.0"
  and .id == $id
  and .result == {
    tools:[],
    resultType:"tools/list",
    cache:{ttlSeconds:0,scope:"private"}
  }
  and (.error | not)' \
  "modern foundation lists no product tools and is not cacheable"

MODERN_UNKNOWN_METHOD_ID="openapi-modern-unknown-method-$RUN_ID"
MODERN_UNKNOWN_METHOD_BODY="$(jq -cn --arg id "$MODERN_UNKNOWN_METHOD_ID" '
  {
    jsonrpc:"2.0",
    id:$id,
    method:"resources/list",
    params:{
      _meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }')"
expect_agent_port agent-port-modern-unknown-method 400 "$MODERN_UNKNOWN_METHOD_BODY" \
  "$GATE_AGENT_TOKEN" "2026-07-28" "resources/list"
guard_jq --arg id "$MODERN_UNKNOWN_METHOD_ID" '
  .jsonrpc == "2.0"
  and .id == $id
  and .error.code == -32601
  and (.result | not)' \
  "recognized modern unknown method fails in-era without legacy downgrade"

MODERN_MISMATCH_BODY="$(printf '%s' "$MODERN_LIST_BODY" | jq -c '
  .params._meta["io.modelcontextprotocol/protocolVersion"] = "2025-11-25"')"
expect_agent_port agent-port-modern-version-mismatch 400 "$MODERN_MISMATCH_BODY" \
  "$GATE_AGENT_TOKEN" "2026-07-28" "tools/list"
guard_jq '.error.code == -32020' \
  "recognized modern metadata/header mutation returns the pinned mismatch code"

expect_agent_port agent-port-unsupported-version 400 "$MODERN_LIST_BODY" \
  "$GATE_AGENT_TOKEN" "2099-01-01" "tools/list"
guard_jq '
  .error.code == -32022
  and (.error.data.received | not)
  and .error.data.supported == ["2026-07-28","2025-11-25"]' \
  "unsupported version reports only the exact closed supported list without echoing input"

LEGACY_INITIALIZE_ID="openapi-legacy-initialize-$RUN_ID"
LEGACY_INITIALIZE_BODY="$(jq -cn --arg id "$LEGACY_INITIALIZE_ID" '
  {
    jsonrpc:"2.0",
    id:$id,
    method:"initialize",
    params:{
      protocolVersion:"2025-11-25",
      capabilities:{},
      clientInfo:{name:"oort-openapi-rust-gate",version:"1.0.0"}
    }
  }')"
# 첫 legacy initialize는 version header를 일부러 생략한다. 이 예외 뒤의 모든
# legacy call은 exact 2025-11-25 header를 다시 요구한다.
sample_agent_port agent-port-legacy-initialize 200 "$LEGACY_INITIALIZE_BODY" \
  "$GATE_AGENT_TOKEN" "" "initialize"
guard_jq --arg id "$LEGACY_INITIALIZE_ID" '
  .jsonrpc == "2.0"
  and .id == $id
  and .result.protocolVersion == "2025-11-25"
  and .result.capabilities == {tools:{listChanged:false}}
  and .result.serverInfo.name == "oort-agent-port"
  and (.result.serverInfo.version | type == "string")
  and (.result | has("resultType") | not)
  and (.result | has("cache") | not)
  and (.error | not)' \
  "legacy initialize is exact, sessionless, and does not borrow modern cache metadata"
if [ -n "$(response_header Mcp-Session-Id)" ]; then
  gate_fail agent-port-legacy-initialize \
    "sessionless legacy initialize must not issue Mcp-Session-Id" "$(redacted_headers)"
fi

LEGACY_LIST_ID="openapi-legacy-list-$RUN_ID"
LEGACY_LIST_BODY="$(jq -cn --arg id "$LEGACY_LIST_ID" '
  {jsonrpc:"2.0",id:$id,method:"tools/list",params:{}}')"
sample_agent_port agent-port-legacy-tools-list 200 "$LEGACY_LIST_BODY" \
  "$GATE_AGENT_TOKEN" "2025-11-25" "tools/list"
guard_jq --arg id "$LEGACY_LIST_ID" '
  .jsonrpc == "2.0"
  and .id == $id
  and .result == {tools:[]}
  and (.error | not)' \
  "legacy foundation lists no product tools or modern-only cache fields"

LEGACY_INITIALIZED_BODY='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
sample_agent_port agent-port-legacy-initialized 202 "$LEGACY_INITIALIZED_BODY" \
  "$GATE_AGENT_TOKEN" "2025-11-25" "notifications/initialized"
if [ -n "$(printf '%s' "$RESPONSE_BODY" | tr -d '[:space:]')" ]; then
  gate_fail agent-port-legacy-initialized \
    "expected an empty 202 response body" "$RESPONSE_BODY"
fi

# Missing and insufficient credentials are HTTP bearer challenges, not
# JSON-RPC errors. app JWT is never materialized as an Agent Port principal.
agent_port_api POST "$MODERN_DISCOVER_BODY" "" "2026-07-28" "server/discover"
if [ "$RESPONSE_STATUS" != "401" ]; then
  gate_fail agent-port-missing-bearer "expected HTTP 401, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi
if [ -n "$(printf '%s' "$RESPONSE_BODY" | tr -d '[:space:]')" ]; then
  gate_fail agent-port-missing-bearer "401 body must be empty" "$RESPONSE_BODY"
fi
MISSING_CHALLENGE="$(response_header WWW-Authenticate)"
case "$MISSING_CHALLENGE" in
  *Bearer*'scope="agent:port:connect"'*) ;;
  *) gate_fail agent-port-missing-bearer \
       "missing exact agent:port:connect Bearer challenge" "$MISSING_CHALLENGE" ;;
esac
case "$MISSING_CHALLENGE" in
  *error=*) gate_fail agent-port-missing-bearer \
    "missing credential challenge must not carry an error parameter" "$MISSING_CHALLENGE" ;;
esac

agent_port_api POST "$MODERN_DISCOVER_BODY" "$GATE_AGENT_NO_PORT_TOKEN" \
  "2026-07-28" "server/discover"
if [ "$RESPONSE_STATUS" != "403" ]; then
  gate_fail agent-port-insufficient-scope "expected HTTP 403, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi
if [ -n "$(printf '%s' "$RESPONSE_BODY" | tr -d '[:space:]')" ]; then
  gate_fail agent-port-insufficient-scope "403 body must be empty" "$RESPONSE_BODY"
fi
INSUFFICIENT_CHALLENGE="$(response_header WWW-Authenticate)"
case "$INSUFFICIENT_CHALLENGE" in
  *Bearer*'error="insufficient_scope"'*) ;;
  *) gate_fail agent-port-insufficient-scope \
       "missing insufficient_scope Agent Port challenge" "$INSUFFICIENT_CHALLENGE" ;;
esac
case "$INSUFFICIENT_CHALLENGE" in
  *'scope="agent:port:connect"'*) ;;
  *) gate_fail agent-port-insufficient-scope \
       "missing agent:port:connect scope in challenge" "$INSUFFICIENT_CHALLENGE" ;;
esac

agent_port_api POST "$MODERN_DISCOVER_BODY" "$ACCESS" \
  "2026-07-28" "server/discover"
if [ "$RESPONSE_STATUS" != "401" ]; then
  gate_fail agent-port-human-jwt "expected HTTP 401, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi
if [ -n "$(printf '%s' "$RESPONSE_BODY" | tr -d '[:space:]')" ]; then
  gate_fail agent-port-human-jwt "human JWT rejection body must be empty" "$RESPONSE_BODY"
fi

# Re-run without the required event-stream media type through a one-off call;
# the helper intentionally always sends the valid pair.
set_curl_bearer "$GATE_AGENT_TOKEN"
set_curl_body "$MODERN_DISCOVER_BODY"
RESPONSE_STATUS="$(curl -sS -o "$RAW_RESPONSE_FILE" -w "%{http_code}" \
  --config "$CURL_AUTH_CONFIG" \
  -X POST "$BASE_URL/v1/mcp/agent-port" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data-binary "@$CURL_BODY_FILE")"
RESPONSE_BODY="$(cat "$RAW_RESPONSE_FILE")"
if [ "$RESPONSE_STATUS" != "415" ]; then
  gate_fail agent-port-invalid-accept "expected HTTP 415, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi
guard_jq '.error.code == -32600' \
  "Agent Port requires both JSON and event-stream response media types"

# Standalone stream/session methods are not OpenAPI operations and stay 405.
agent_port_api GET "" "$GATE_AGENT_TOKEN"
if [ "$RESPONSE_STATUS" != "405" ]; then
  gate_fail agent-port-get "expected HTTP 405, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi
agent_port_api DELETE "" "$GATE_AGENT_TOKEN"
if [ "$RESPONSE_STATUS" != "405" ]; then
  gate_fail agent-port-delete "expected HTTP 405, got $RESPONSE_STATUS" "$RESPONSE_BODY"
fi

# ---------------------------------------------------------------------------
# 승인 계열 (#1042 최초 등재분)
# ---------------------------------------------------------------------------
sample approvals-list get "/v1/workspaces/{workspaceId}/approvals" \
  "/v1/workspaces/$WS/approvals?status=pending" 200 "" "$ACCESS"
guard_jq --arg id "$APPROVAL_UUID" '.approvals | map(select(.id == $id)) | length == 1' \
  "pending approvals include the rust gate fixture"

sample approval-decision post \
  "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision" \
  "/v1/workspaces/$WS/approvals/$APPROVAL_UUID/decision" 200 \
  "$(jq -cn --arg a "$APPROVAL_UUID" --arg d "$(uuidgen)" \
      '{approval_id:$a,approve:true,reason:"openapi rust sample pass",client_decision_id:$d}')" \
  "$ACCESS"
guard_jq '.status == "approved"' "decision receipt reports approved"

# ---------------------------------------------------------------------------
# 로스터 · 채널
# ---------------------------------------------------------------------------
sample roster get "/v1/workspaces/{workspaceId}/roster" \
  "/v1/workspaces/$WS/roster" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MEMBER_ID" 'any(.members[]; (.id | ascii_downcase) == $id)' \
  "roster contains the gate member"
sample members-alias get "/v1/workspaces/{workspaceId}/members" \
  "/v1/workspaces/$WS/members" 200 "" "$ACCESS"

sample channels-list get "/v1/workspaces/{workspaceId}/channels" \
  "/v1/workspaces/$WS/channels" 200 "" "$ACCESS"
guard_jq --arg id "$GENERAL_CHANNEL_ID" 'any(.channels[]; (.id | ascii_downcase) == $id)' \
  "channel list contains #general"

sample channel-create post "/v1/workspaces/{workspaceId}/channels" \
  "/v1/workspaces/$WS/channels" 201 \
  "$(jq -cn --arg n "rust-gate-$RUN_EPOCH" \
      '{kind:"public",name:$n,topic:"openapi rust sample pass"}')" "$ACCESS"
GATE_CHANNEL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.channel.id')"
canonical_uuid "$GATE_CHANNEL_ID" || { echo "[openapi-rust] candidate returned a non-canonical channel id" >&2; exit 1; }

# 갓 만든 채널에 건다 — #general 의 상태를 게이트가 바꾸면 뒤따르는 read-state
# 표본이 자기가 만든 부작용을 읽게 된다.
sample notification-pref put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/notification-pref" \
  "/v1/workspaces/$WS/channels/$GATE_CHANNEL_ID/notification-pref" 200 \
  '{"muted":true}' "$ACCESS"
guard_jq '.muted == true' "notification preference echoes the effective mute state"

# ---------------------------------------------------------------------------
# 메시지 · 스레드 · 반응 · 고정 · 검색 · 읽음
# ---------------------------------------------------------------------------
sample message-send post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" 201 \
  "$(jq -cn --arg c "$(lower_uuid)" \
      '{clientMsgId:$c,body:"openapi rust sample pass"}')" "$ACCESS"
GATE_MESSAGE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.id')"

sample message-history get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages?limit=50" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" 'any(.messages[]; (.id | ascii_downcase) == $id)' \
  "history projects the message that was just sent"
GATE_MESSAGE_SEQ="$(printf '%s' "$RESPONSE_BODY" \
  | jq -er --arg id "$GATE_MESSAGE_ID" '.messages[] | select((.id|ascii_downcase) == $id) | .seq')"

# 답글은 같은 쓰기 경로를 `rootId` 로 부를 뿐 두 번째 경로가 아니다 — 그래서
# 표본이 아니라 스레드 읽기의 전제다.
expect thread-root post "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" 201 \
  "$(jq -cn --arg c "$(lower_uuid)" --arg r "$GATE_MESSAGE_ID" \
      '{clientMsgId:$c,rootId:$r,body:"openapi rust sample reply"}')" "$ACCESS"

sample thread-replies get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/messages/{rootId}/replies" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages/$GATE_MESSAGE_ID/replies?limit=50" \
  200 "" "$ACCESS"
guard_jq --arg root "$GATE_MESSAGE_ID" \
  '(.messages | length) >= 1 and all(.messages[]; (.rootId | ascii_downcase) == $root)' \
  "thread page carries only replies of the requested root"

sample message-edit patch "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID" 200 \
  '{"body":"openapi rust sample pass (edited)"}' "$ACCESS"
guard_jq '.state == "edited"' "edit records the tombstone-free edited state"

# 이모지는 경로 세그먼트라 퍼센트 인코딩해 보낸다(👍 = U+1F44D).
THUMBS_UP="%F0%9F%91%8D"
sample reaction-add put \
  "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/reactions/$THUMBS_UP" 200 "" "$ACCESS"
# `ReactionDelta` 는 고정 델타와 달리 `changed` 를 싣지 않는다(스펙 required 4개).
# 그러니 여기서 볼 수 있는 사실은 「어느 멤버가 어느 메시지에 무엇을 달았나」다.
guard_jq --arg id "$GATE_MESSAGE_ID" --arg m "$GATE_MEMBER_ID" \
  '.action == "added" and (.messageId | ascii_downcase) == $id
   and (.memberId | ascii_downcase) == $m and .emoji == "👍"' \
  "the add delta names the member, the message and the emoji"

sample reaction-snapshot get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/reactions" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/reactions" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  'to_entries | map(select((.key | ascii_downcase) == $id)) | length == 1' \
  "reaction snapshot carries the reacted message"

sample reaction-remove delete \
  "/v1/workspaces/{workspaceId}/messages/{messageId}/reactions/{emoji}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/reactions/$THUMBS_UP" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  '.action == "removed" and (.messageId | ascii_downcase) == $id and .emoji == "👍"' \
  "the remove delta names the same reaction"

sample pin-add put "/v1/workspaces/{workspaceId}/messages/{messageId}/pin" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/pin" 200 "" "$ACCESS"
guard_jq '.action == "pinned" and .changed == true' "first pin is a change"

sample pin-list get "/v1/workspaces/{workspaceId}/channels/{channelId}/pins" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/pins" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MESSAGE_ID" \
  'any(.pins[]; (.messageId | ascii_downcase) == $id)' \
  "pin list carries the pinned message"

sample pin-remove delete "/v1/workspaces/{workspaceId}/messages/{messageId}/pin" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID/pin" 200 "" "$ACCESS"
guard_jq '.action == "unpinned" and .changed == true' "unpinning is a change"

sample message-search get "/v1/workspaces/{workspaceId}/search/messages" \
  "/v1/workspaces/$WS/search/messages?q=openapi&limit=20" 200 "" "$ACCESS"
guard_jq '(.hits | length) >= 1' "search finds the messages this run wrote"

sample read-state-put put \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/read-state" \
  "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/read-state" 200 \
  "$(jq -cn --argjson s "$GATE_MESSAGE_SEQ" '{last_read_seq:$s}')" "$ACCESS"
guard_jq --argjson s "$GATE_MESSAGE_SEQ" '.last_read_seq == $s' \
  "read cursor records the requested seq"

sample read-state-list get "/v1/workspaces/{workspaceId}/read-state" \
  "/v1/workspaces/$WS/read-state" 200 "" "$ACCESS"
guard_jq --arg id "$GENERAL_CHANNEL_ID" \
  'any(.read_states[]; (.channel_id | ascii_downcase) == $id)' \
  "read-state projection contains #general"

# 삭제는 마지막이다 — 위의 모든 표본이 이 메시지를 필요로 한다.
sample message-delete delete "/v1/workspaces/{workspaceId}/messages/{messageId}" \
  "/v1/workspaces/$WS/messages/$GATE_MESSAGE_ID" 200 "" "$ACCESS"
guard_jq '.state == "deleted"' "delete leaves a tombstone, not a hole"

# ---------------------------------------------------------------------------
# DM · 가입
# ---------------------------------------------------------------------------
sample dm-open post "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 201 \
  "$(jq -cn --arg m "$GATE_PEER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == true and .channel.kind == "dm"' "first open creates the DM"

# 같은 쌍을 다시 열면 200 이다. 두 상태코드는 서로 다른 문장이라 둘 다 대조한다.
sample dm-reopen post "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 200 \
  "$(jq -cn --arg m "$GATE_PEER_ID" '{memberId:$m}')" "$ACCESS"
guard_jq '.created == false' "reopening the same pair is idempotent"

sample dms-list get "/v1/workspaces/{workspaceId}/dms" \
  "/v1/workspaces/$WS/dms" 200 "" "$ACCESS"
guard_jq '(.channels | length) >= 1' "DM list contains the opened conversation"

INVITE_CODE_FILE="$TMP_DIR/invite-code.txt"
JOIN_PASSWORD_FILE="$TMP_DIR/join-password.txt"
(umask 077; : >"$INVITE_CODE_FILE"; : >"$JOIN_PASSWORD_FILE")
register_secret_file "$INVITE_CODE_FILE"
register_secret_file "$JOIN_PASSWORD_FILE"
printf '%s' "$INVITE_CODE" >"$INVITE_CODE_FILE"
printf '%s' "$JOIN_PASSWORD" >"$JOIN_PASSWORD_FILE"
sample join post "/v1/join" "/v1/join" 201 \
  "$(jq -cn --rawfile c "$INVITE_CODE_FILE" --arg e "$JOIN_EMAIL" --rawfile p "$JOIN_PASSWORD_FILE" \
      --arg h "$JOIN_HANDLE" \
      '{code:$c,email:$e,password:$p,displayName:"OpenAPI Rust Gate Join",
        handle:$h,timeZone:"UTC"}')"
JOIN_ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -r '.accessToken // empty')"
append_secret_with_derivatives "$JOIN_ACCESS"
guard_jq --arg ws "$WS" '(.workspaceId | ascii_downcase) == $ws
  and (.accessToken | type == "string")' \
  "join mints a member of the invited workspace"

# ---------------------------------------------------------------------------
# provider(자격증명 없는 읽기) · tier 정책
# ---------------------------------------------------------------------------
sample provider-effort-table get "/v1/provider/effort-table" \
  "/v1/provider/effort-table" 200 "" "$ACCESS"
guard_jq '.schema == "momo.provider.effort_table.v0" and (.levels | length) > 0' \
  "effort table projects the canonical level superset"

# 두 정책 다 `ask` 로 둔다 — `auto` 는 아래 resume 표본을 한 호스트에 못 박아
# 무관한 호스트 변경을 가짜 드리프트로 만든다(1차 패스와 같은 이유).
sample work-tier-policy-get get "/v1/workspaces/{workspaceId}/work-tier-policy" \
  "/v1/workspaces/$WS/work-tier-policy" 200 "" "$ACCESS"
sample work-tier-policy-put put "/v1/workspaces/{workspaceId}/work-tier-policy" \
  "/v1/workspaces/$WS/work-tier-policy" 200 '{"mode":"ask"}' "$ACCESS"
guard_jq '.workTierPolicy.mode == "ask"' "workspace default records the ask policy"
sample work-tier-policy-me-get get "/v1/workspaces/{workspaceId}/work-tier-policy/me" \
  "/v1/workspaces/$WS/work-tier-policy/me" 200 "" "$ACCESS"
sample work-tier-policy-me-put put "/v1/workspaces/{workspaceId}/work-tier-policy/me" \
  "/v1/workspaces/$WS/work-tier-policy/me" 200 '{"mode":"ask"}' "$ACCESS"
guard_jq '.workTierPolicy.mode == "ask" and .workTierPolicy.inherited == false' \
  "member override stops inheriting the workspace default"

# ---------------------------------------------------------------------------
# 에이전트 — 초대·프로필·정지·모델 어휘, 그리고 사람의 「멈춰라」
# ---------------------------------------------------------------------------
sample agent-create post "/v1/workspaces/{workspaceId}/agents" \
  "/v1/workspaces/$WS/agents" 201 \
  "$(jq -cn --arg h "rust-gate-created-$RUN_EPOCH" \
      '{displayName:"OpenAPI Rust Gate Created",handle:$h,model:"hermes-agent",
        baseUrl:"https://hermes.openapi.example.test/v1",
        systemPrompt:"openapi rust sample pass"}')" "$ACCESS"
guard_jq --arg h "rust-gate-created-$RUN_EPOCH" '.agent.handle == $h' \
  "agent creation returns the created member identity"

# PUT 이 먼저다: `agent_profile` 행은 이 쓰기가 만들고, GET 도 pause 도 그 행이
# 없으면 404 다.
sample agent-profile-put put \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/profile" 200 \
  '{"instructions":"openapi rust sample pass"}' "$ACCESS"
sample agent-profile-get get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/profile" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/profile" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_AGENT_ID" '(.profile.agentMemberId | ascii_downcase) == $id' \
  "profile read answers for the agent that was named"
sample agent-pause put "/v1/workspaces/{workspaceId}/agents/{agentId}/pause" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/pause" 200 '{"paused":false}' "$ACCESS"
guard_jq '.profile.paused == false' "pause write returns the effective state"
sample agent-allowed-models get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/allowed-models" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/allowed-models" 200 "" "$ACCESS"
guard_jq '(.allowedAgentModels | length) >= 1' "picker vocabulary is non-empty"

sample agent-run-cancel post \
  "/v1/workspaces/{workspaceId}/agent-runs/{runId}/cancel" \
  "/v1/workspaces/$WS/agent-runs/$CANCEL_RUN_UUID/cancel" 200 "" "$ACCESS"
guard_jq '.status == "cancelled"' "a person's stop ends the run"

# ---------------------------------------------------------------------------
# work host 레지스트리 — 등록 · 서명 하트비트 · 폴링 목록
# ---------------------------------------------------------------------------
sample work-host-register post "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 201 \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
      '{scope:"member",type:"app",displayName:"OpenAPI rust gate host",publicKey:$key,
        capabilities:{"tool.codex":true}}')" "$ACCESS"
WORK_HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id')"
canonical_uuid "$WORK_HOST_ID" || { echo "[openapi-rust] candidate returned a non-canonical work-host id" >&2; exit 1; }

sample work-host-heartbeat post \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/heartbeat" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/heartbeat" 200 \
  "$(heartbeat_body "$WORK_HOST_ID")"
guard_jq '.workHost.online == true and (.workHost.lastSeenAtMs | type == "number")' \
  "signed heartbeat marks the host online"

sample work-host-list get "/v1/workspaces/{workspaceId}/work-hosts" \
  "/v1/workspaces/$WS/work-hosts" 200 "" "$ACCESS"
guard_jq --arg host "$(printf '%s' "$WORK_HOST_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workHosts[]; (.id | ascii_downcase) == $host and .online == true)' \
  "polling list contains the signed-online host"

# 데몬의 첫 폴링: 아직 아무 지시도 없다. 빈 목록도 왕복이고, 무엇보다 이 서명
# 경로가 열려 있다는 증거다(#1143 이 연 자리).
work_host_signed_sample work-host-pending-controls-empty get \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/pending-controls" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/pending-controls" 200 \
  "$WORK_HOST_ID" "$HOST_KEY"
guard_jq '.workControls == []' "a fresh host has nothing dispatched to it"

# ---------------------------------------------------------------------------
# work session 원장 — 생성 · 활성 목록 · 소유자의 종료
# ---------------------------------------------------------------------------
sample work-session-create post "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust gate"}')" "$ACCESS"
WORK_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
canonical_uuid "$WORK_SESSION_ID" || { echo "[openapi-rust] candidate returned a non-canonical work-session id" >&2; exit 1; }

sample work-session-list get "/v1/workspaces/{workspaceId}/work-sessions" \
  "/v1/workspaces/$WS/work-sessions?active=1" 200 "" "$ACCESS"
guard_jq --arg id "$(printf '%s' "$WORK_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workSessions[]; (.id | ascii_downcase) == $id and .status == "running")' \
  "active list contains the created session"

sample work-session-end patch \
  "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}" \
  "/v1/workspaces/$WS/work-sessions/$WORK_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"
guard_jq '.workSession.status == "ended" and .workSession.exitCode == 0' \
  "the session ends with an exit status"

# ---------------------------------------------------------------------------
# work control 원장 (#1132) + 서명 데몬 폐곡선 (#1143)
#
# 다섯 연산이 한 문장으로 이어진다: 사람이 도구를 미리 허가하고 → 에이전트가
# 자기 bearer 로 spawn 을 요청하면 카드 없이 dispatched 가 되고 → **데몬이**
# 자기 서명으로 그 지시를 읽고 → 자기 서명으로 「실행했다」를 보고한다.
# ack 의 자격증명이 요청자와 다른 것이 요점이다 — 요청과 보고를 한 자격증명이
# 다 하면 호스트가 본 적 없는 세션을 있다고 보고할 수 있다.
# ---------------------------------------------------------------------------
sample work-auto-approval-enable put \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == true' "auto-approval enables codex"

sample work-auto-approvals-list get \
  "/v1/workspaces/{workspaceId}/work-auto-approvals" \
  "/v1/workspaces/$WS/work-auto-approvals" 200 "" "$ACCESS"
guard_jq '(.tools | index("codex")) != null' "the snapshot contains the enabled tool"

sample work-control-create post "/v1/workspaces/{workspaceId}/work-controls" \
  "/v1/workspaces/$WS/work-controls" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg run "$CONTROL_RUN_UUID" \
      --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,runId:$run,targetHostId:$host,kind:"spawn",
        payload:{tool:"codex",label:"OpenAPI rust control"}}')" "$GATE_AGENT_TOKEN"
WORK_CONTROL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workControl.id')"
canonical_uuid "$WORK_CONTROL_ID" || { echo "[openapi-rust] candidate returned a non-canonical work-control id" >&2; exit 1; }
guard_jq '.workControl.kind == "spawn" and .workControl.status == "dispatched"' \
  "a pre-authorised spawn dispatches without a card"

# ack 이 묶을 세션. `spawn_ack_session_matches_in_tx` 는 요청자가 에이전트일 때
# **그 에이전트의 owner human 이 소유한** running 세션만 받으므로, 게이트 사람이
# 같은 채널·같은 호스트로 여는 이 세션이 정확히 그 행이다. 표본이 아니라 전제다
# (POST …/work-sessions 는 이미 위에서 등재됐다).
expect ack-session post "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust control"}')" "$ACCESS"
ACK_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
canonical_uuid "$ACK_SESSION_ID" || { echo "[openapi-rust] candidate returned a non-canonical ack session id" >&2; exit 1; }

work_host_signed_sample work-host-pending-controls get \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}/pending-controls" \
  "/v1/workspaces/$WS/work-hosts/$WORK_HOST_ID/pending-controls" 200 \
  "$WORK_HOST_ID" "$HOST_KEY"
guard_jq --arg id "$(printf '%s' "$WORK_CONTROL_ID" | tr '[:upper:]' '[:lower:]')" \
  'any(.workControls[]; (.id | ascii_downcase) == $id and .status == "dispatched")' \
  "the daemon reads the instruction addressed to it"

work_host_signed_sample work-control-ack post \
  "/v1/workspaces/{workspaceId}/work-controls/{workControlId}/ack" \
  "/v1/workspaces/$WS/work-controls/$WORK_CONTROL_ID/ack" 200 \
  "$WORK_HOST_ID" "$HOST_KEY" \
  "$(jq -cn --arg session "$ACK_SESSION_ID" '{ok:true,sessionId:$session}')"
guard_jq --arg session "$(printf '%s' "$ACK_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  '.workControl.status == "acked" and (.workControl.sessionId | ascii_downcase) == $session' \
  "the signing host binds the session it actually opened"

sample work-auto-approval-disable delete \
  "/v1/workspaces/{workspaceId}/work-auto-approvals/{tool}" \
  "/v1/workspaces/$WS/work-auto-approvals/codex" 200 "" "$ACCESS"
guard_jq '.tool == "codex" and .enabled == false' "auto-approval disables codex"

expect ack-session-end patch "/v1/workspaces/$WS/work-sessions/$ACK_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"

# ---------------------------------------------------------------------------
# resume — 고아가 된 세션만 다른 호스트에서 이어진다
#
# `orphaned` 를 만드는 것은 호스트 유실 sweep(NotifierWorker)이고 이 부분집합은
# 그 프로필을 띄우지 않는다. 그래서 전제만 SQL 로 심고 resume 자체는 실 HTTP 다
# — 1차 패스가 같은 자리에서 하는 것과 같은 분업이다.
# ---------------------------------------------------------------------------
expect resume-source post "/v1/workspaces/$WS/work-sessions" 201 \
  "$(jq -cn --arg ch "$GENERAL_CHANNEL_ID" --arg host "$WORK_HOST_ID" \
      '{channelId:$ch,hostId:$host,tool:"codex",label:"OpenAPI rust resume source"}')" \
  "$ACCESS"
RESUME_SOURCE_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
canonical_uuid "$RESUME_SOURCE_SESSION_ID" || { echo "[openapi-rust] candidate returned a non-canonical source session id" >&2; exit 1; }

# 이어받을 호스트는 소스와 **달라야** 한다(resume_target_rejection_in_tx).
expect resume-target-host post "/v1/workspaces/$WS/work-hosts" 201 \
  "$(jq -cn --arg key "$HOST_PUBLIC_KEY" \
      '{scope:"member",type:"app",displayName:"OpenAPI rust gate host 2",publicKey:$key,
        capabilities:{"tool.codex":true}}')" "$ACCESS"
RESUME_HOST_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workHost.id')"
canonical_uuid "$RESUME_HOST_ID" || { echo "[openapi-rust] candidate returned a non-canonical resume host id" >&2; exit 1; }
expect resume-target-heartbeat post \
  "/v1/workspaces/$WS/work-hosts/$RESUME_HOST_ID/heartbeat" 200 \
  "$(heartbeat_body "$RESUME_HOST_ID")"

run_sql <<SQL
UPDATE work_session SET status = 'orphaned', idle_at = NULL
 WHERE workspace_id = '$WS' AND id = '$RESUME_SOURCE_SESSION_ID';
SQL

sample work-session-resume post \
  "/v1/workspaces/{workspaceId}/work-sessions/{workSessionId}/resume" \
  "/v1/workspaces/$WS/work-sessions/$RESUME_SOURCE_SESSION_ID/resume" 201 \
  "$(jq -cn --arg host "$RESUME_HOST_ID" '{targetHostId:$host}')" "$ACCESS"
guard_jq --arg source "$(printf '%s' "$RESUME_SOURCE_SESSION_ID" | tr '[:upper:]' '[:lower:]')" \
  '.workSession.status == "running"
   and (.workSession.resumedFromSessionId | ascii_downcase) == $source' \
  "resume opens a new Run with durable lineage"
RESUMED_SESSION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.workSession.id')"
canonical_uuid "$RESUMED_SESSION_ID" || { echo "[openapi-rust] candidate returned a non-canonical resumed session id" >&2; exit 1; }
expect resumed-session-end patch "/v1/workspaces/$WS/work-sessions/$RESUMED_SESSION_ID" 200 \
  '{"status":"ended","exitCode":0}' "$ACCESS"

# 해지는 마지막이다: 해지된 호스트는 서명할 수도, 폴링될 수도 없다.
sample work-host-revoke delete \
  "/v1/workspaces/{workspaceId}/work-hosts/{workHostId}" \
  "/v1/workspaces/$WS/work-hosts/$RESUME_HOST_ID" 200 "" "$ACCESS"
guard_jq '.workHost.online == false and (.workHost.revokedAtMs | type == "number")' \
  "a revoked host is durably offline"

# 로그아웃은 자기가 쓴 자격증명을 죽이므로 정말 마지막이다.
sample logout post "/v1/auth/logout" "/v1/auth/logout" 200 \
  "$(refresh_request_body "$REFRESH")" "$ACCESS"
guard_jq '.status == "ok" and .revokedAccess == true' "logout revokes the presented pair"

# ---- 6) 스펙 대조 + 매니페스트 양방향 커버리지 ------------------------------
jq -s '{samples: .}' "$MANIFEST" >"$TMP_DIR/manifest.json"
SAMPLE_COUNT="$(jq '.samples | length' "$TMP_DIR/manifest.json")"
echo "[openapi-rust] validating $SAMPLE_COUNT sample(s) against the spec"

SHAPE_RC=0
if [ "$SAMPLE_COUNT" -gt 0 ]; then
  "$PYTHON_BIN" "$SCRIPT_DIR/openapi_shape_check.py" \
    --spec "$SPEC_JSON" \
    --manifest "$TMP_DIR/manifest.json" || SHAPE_RC=$?
else
  echo "[openapi-rust] no samples were recorded" >&2
  SHAPE_RC=1
fi

# 양방향: 등재됐는데 미샘플 → 실패, 샘플인데 미등재 → 실패.
ACTUAL_OPS="$TMP_DIR/actual-ops.txt"
jq -r '.method + " " + .path' "$MANIFEST" \
  | awk 'NF { print tolower($1) " " $2 }' | sort -u >"$ACTUAL_OPS"

COVERAGE_RC=0
UNSAMPLED="$(comm -23 "$EXPECTED_OPS" "$ACTUAL_OPS")"
UNLISTED="$(comm -13 "$EXPECTED_OPS" "$ACTUAL_OPS")"
report_ops() {
  # 한 줄 = "method /path" — 공백이 있으므로 while read 로 그대로 흘린다.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '    - %s %s\n' \
      "$(printf '%s' "${line%% *}" | tr '[:lower:]' '[:upper:]')" "${line#* }" >&2
  done
}
if [ -n "$UNSAMPLED" ]; then
  COVERAGE_RC=1
  echo "[openapi-rust] FAIL sampled-on-rust coverage — listed but never sampled on Rust:" >&2
  printf '%s\n' "$UNSAMPLED" | report_ops
fi
if [ -n "$UNLISTED" ]; then
  COVERAGE_RC=1
  echo "[openapi-rust] FAIL sampled-on-rust coverage — sampled on Rust but not listed" >&2
  echo "[openapi-rust]      (add it to scripts/openapi_sampled_on_rust.txt — the list only grows):" >&2
  printf '%s\n' "$UNLISTED" | report_ops
fi
[ "$COVERAGE_RC" -eq 0 ] && \
  echo "[openapi-rust] PASS sampled-on-rust coverage ($EXPECTED_COUNT operation(s) round-tripped on the Rust stack)"

# Retained evidence is intentionally useful after the stack is gone, but it
# must never retain any live credential. Search non-secret evidence before the
# registered secret scratch files are unlinked by cleanup.
API_LOG_EVIDENCE="$TMP_DIR/api.log.raw"
(umask 077; : >"$API_LOG_EVIDENCE")
register_secret_file "$API_LOG_EVIDENCE" || {
  echo "[openapi-rust] FAIL could not register API log scratch for cleanup" >&2
  exit 1
}
if ! compose logs --no-color api >"$API_LOG_EVIDENCE"; then
  echo "[openapi-rust] FAIL could not capture complete API logs for secret scanning" >&2
  exit 1
fi
# Secret-bearing request-builder files are scratch, not evidence. Remove them
# with the same inode/owner binding before enumerating retained evidence; the
# global cleanup still owns all remaining registered secrets and signal paths.
for request_secret in "$LOGIN_PASSWORD_FILE" "$INVITE_CODE_FILE" "$JOIN_PASSWORD_FILE"; do
  request_secret_index=-1
  for ((index = 0; index < ${#SECRET_FILES[@]}; index++)); do
    if [ "${SECRET_FILES[$index]}" = "$request_secret" ]; then
      request_secret_index=$index
      break
    fi
  done
  if [ "$request_secret_index" -lt 0 ] ||
    [ ! -f "$request_secret" ] || [ -L "$request_secret" ] ||
    [ "$(file_identity "$request_secret")" != "${SECRET_IDENTITIES[$request_secret_index]}" ]; then
    echo "[openapi-rust] FAIL request secret scratch ownership changed before cleanup" >&2
    exit 1
  fi
  rm -f -- "$request_secret"
done
LEAK_SCAN_LIST="$TMP_DIR/nonsecret-evidence-files.txt"
find "$TMP_DIR" -type f \
  ! -path "$ENV_FILE" \
  ! -path "$HOST_KEY" \
  ! -path "$CURL_AUTH_CONFIG" \
  ! -path "$CURL_BODY_FILE" \
  ! -path "$RAW_RESPONSE_FILE" \
  ! -path "$RAW_HEADERS_FILE" \
  ! -path "$SECRET_NEEDLES" \
  ! -path "$API_LOG_EVIDENCE" \
  ! -name 'work-host-curl.conf' \
  ! -name 'work-host-curl.conf*' \
  ! -name 'work-host-request-*.bin' \
  ! -name 'work-host-heartbeat-*.bin' \
  -print >"$LEAK_SCAN_LIST"
LEAK_FOUND=0
: >"$TMP_DIR/secret-leaks.txt"
while IFS= read -r evidence_file; do
  [ -n "$evidence_file" ] || continue
  evidence_grep_rc=0
  grep -Fq -f "$SECRET_NEEDLES" -- "$evidence_file" 2>/dev/null || evidence_grep_rc=$?
  case "$evidence_grep_rc" in
    0)
      printf '%s\n' "$evidence_file" >>"$TMP_DIR/secret-leaks.txt"
      register_secret_file "$evidence_file" || {
        echo "[openapi-rust] FAIL could not register leaked evidence for secure cleanup: $evidence_file" >&2
        exit 1
      }
      LEAK_FOUND=1
      ;;
    1) ;;
    *)
      register_secret_file "$evidence_file" 2>/dev/null || true
      echo "[openapi-rust] FAIL retained evidence secret scan could not read: $evidence_file" >&2
      exit 1
      ;;
  esac
done <"$LEAK_SCAN_LIST"
# The registered API log scratch is scanned explicitly: it is intentionally
# excluded from the retained-evidence enumeration because a failed/partial
# capture must always be deleted by cleanup.
api_log_grep_rc=0
grep -Fq -f "$SECRET_NEEDLES" -- "$API_LOG_EVIDENCE" 2>/dev/null || api_log_grep_rc=$?
case "$api_log_grep_rc" in
  0) printf '%s\n' "$API_LOG_EVIDENCE" >>"$TMP_DIR/secret-leaks.txt"; LEAK_FOUND=1 ;;
  1) ;;
  *) echo "[openapi-rust] FAIL API log secret scan failed" >&2; exit 1 ;;
esac
if [ "$LEAK_FOUND" -ne 0 ]; then
  echo "[openapi-rust] FAIL retained evidence contains a live secret" >&2
  sed 's/^/    - /' "$TMP_DIR/secret-leaks.txt" >&2
  exit 1
fi

# The complete log proved secret-free, so it can become retained non-secret
# evidence. Remove its secret registration by deleting and copying to a new
# inode; cleanup will ignore the old, now-absent identity.
API_LOG_RETAINED="$TMP_DIR/api.log"
cp "$API_LOG_EVIDENCE" "$API_LOG_RETAINED"
chmod 600 "$API_LOG_RETAINED"
rm -f -- "$API_LOG_EVIDENCE"

if [ "$FAILURE_COUNT" -gt 0 ] || [ "$SHAPE_RC" -ne 0 ] || [ "$COVERAGE_RC" -ne 0 ]; then
  echo "[openapi-rust] FAIL spec↔Rust sample pass — $FAILURE_COUNT assertion failure(s), shape rc=$SHAPE_RC, coverage rc=$COVERAGE_RC (evidence: $TMP_DIR)" >&2
  exit 1
fi

perform_cleanup 0 || {
  echo "[openapi-rust] FAIL explicit normal teardown/absence verification" >&2
  exit 1
}
trap - EXIT INT TERM
echo "[openapi-rust] PASS spec↔Rust sample pass (evidence: $TMP_DIR)"
