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
#   * agent bearer (`momo_agent_v1.{ws}.{secret}`) — HAP-E1 관리 API가 한 번만
#     반환하고 `POST …/work-controls`와 POST-only Agent Port가 각각 닫힌 scope로
#     요구한다. 발급 API부터 두 consumer까지 실제 한 경로로 왕복한다.
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

# Envelope-shaped agent bearers are secrets regardless of JSON key, response
# status, or whether the exact value has already been registered as a needle.
# This is the final guard used by every diagnostic output path.
redact_private_envelopes() {
  sed -E \
    -e 's/momo_agent_v1\.[A-Za-z0-9._~-]+/[REDACTED_AGENT_BEARER]/g' \
    -e 's/momo_pair_v1\.[A-Za-z0-9._~-]+/[REDACTED_PAIRING_CREDENTIAL]/g'
}

private_envelopes_in_file() {
  LC_ALL=C grep -Eo 'momo_(agent|pair)_v1\.[A-Za-z0-9._~-]+' -- "$1"
}

# Shared by daemon-free regression and the live gate. The secret itself travels
# only over stdin/files; argv receives the private needle-file path alone.
redact_with_needles_file() {
  local needles_file="$1"
  if [ ! -f "$needles_file" ] || [ ! -r "$needles_file" ] || [ -L "$needles_file" ]; then
    cat >/dev/null
    printf '%s' '[diagnostic withheld: secret registry unavailable]'
    return
  fi
  python3 -c '
import pathlib, re, sys
needles = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
text = sys.stdin.read()
for needle in sorted({value for value in needles if value}, key=len, reverse=True):
    text = text.replace(needle, "[REDACTED_REGISTERED_SECRET]")
text = re.sub(r"momo_agent_v1\.[A-Za-z0-9._~-]+", "[REDACTED_AGENT_BEARER]", text)
text = re.sub(r"momo_pair_v1\.[A-Za-z0-9._~-]+", "[REDACTED_PAIRING_CREDENTIAL]", text)
sys.stdout.write(text)
' "$needles_file"
}

render_safe_failure() {
  local needles_file="$1" count="$2" name="$3" detail="$4" body="${5:-}"
  printf '[%s] %s: %s\n' "$count" "$name" "$detail" | redact_with_needles_file "$needles_file"
  [ -z "$body" ] || printf '%s\n' "$body" | redact_with_needles_file "$needles_file"
}

private_envelope_valid() {
  local value="$1" prefix="$2"
  [ "${#value}" -le 8192 ] &&
    [[ "$value" =~ ^${prefix}\.[0-9a-f-]{36}\.[A-Za-z0-9._~-]+$ ]]
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
  malicious_envelope=$'momo_agent_v1.00000000-0000-7000-8000-000000000001.good"\noutput=/tmp/exfil'
  ! private_envelope_valid "$malicious_envelope" momo_agent_v1 || {
    echo "[openapi-rust] private envelope validator accepted curl-config injection" >&2
    exit 1
  }
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
  unknown_key_fixture='{"unexpectedDebug":"momo_agent_v1.00000000-0000-7000-8000-000000000001.unknownSecret"}'
  non_201_fixture='HTTP 500 echoed momo_pair_v1.00000000-0000-7000-8000-000000000001.non201Secret'
  redacted_fixture="$(printf '%s\n%s' "$unknown_key_fixture" "$non_201_fixture" | redact_private_envelopes)"
  ! printf '%s' "$redacted_fixture" | grep -Eq 'momo_(agent|pair)_v1\.' || {
    echo "[openapi-rust] unknown-key/non-201 private envelope escaped global redaction" >&2; exit 1;
  }
  printf '%s\n' 'HTTP/1.1 418' 'X-Debug: momo_pair_v1.00000000-0000-7000-8000-000000000001.headerSecret' >"$selftest_dir/headers-private"
  [ "$(private_envelopes_in_file "$selftest_dir/headers-private")" = 'momo_pair_v1.00000000-0000-7000-8000-000000000001.headerSecret' ] || {
    echo "[openapi-rust] unknown-status response-header private envelope was not detected" >&2; exit 1;
  }
  # Assemble at runtime so the committed verifier fixture is not itself a
  # credential-shaped gitleaks finding.
  arbitrary_jwt='eyJhbGciOiJIUzI1NiJ9.'
  arbitrary_jwt+='eyJzdWIiOiJkYWVtb24tZnJlZSJ9.'
  arbitrary_jwt+='arbitraryRegisteredJwtValue123'
  arbitrary_prefix="${arbitrary_jwt:0:24}"
  arbitrary_digest="$(printf '%s' "$arbitrary_jwt" | shasum -a 256 | awk '{print $1}')"
  printf '%s\n%s\n%s\n' "$arbitrary_jwt" "$arbitrary_prefix" "$arbitrary_digest" >"$selftest_dir/registered-needles"
  render_safe_failure "$selftest_dir/registered-needles" 1 reflected-jwt \
    "detail=$arbitrary_jwt header=$arbitrary_prefix" \
    "body=$arbitrary_jwt digest=$arbitrary_digest" >"$selftest_dir/redacted-output" 2>&1
  ! grep -Fq -f "$selftest_dir/registered-needles" -- "$selftest_dir/redacted-output" || {
    echo "[openapi-rust] registered JWT or derivative escaped daemon-free redaction" >&2; exit 1;
  }
  [ "$(grep -Fo '[REDACTED_REGISTERED_SECRET]' "$selftest_dir/redacted-output" | wc -l | tr -d ' ')" -ge 4 ] || {
    echo "[openapi-rust] daemon-free reflected JWT fixture did not traverse the shared redactor" >&2; exit 1;
  }
  render_safe_failure "$selftest_dir/missing-needles" 2 read-error \
    "detail=$arbitrary_jwt" "body=$arbitrary_jwt" >"$selftest_dir/read-error-output" 2>&1
  ! grep -Fq "$arbitrary_jwt" "$selftest_dir/read-error-output" && \
    grep -Fq '[diagnostic withheld: secret registry unavailable]' "$selftest_dir/read-error-output" || {
      echo "[openapi-rust] redactor registry read error was not fail-closed" >&2; exit 1;
    }
  signal_secret="$selftest_dir/signal-secret"
  set +e
  sh -c 'trap '\''rm -f -- "$1"; exit 143'\'' TERM
    umask 077
    : >"$1"
    printf "%s" "momo_agent_v1.signal.fixture" >"$1"
    kill -TERM $$' sh "$signal_secret"
  signal_rc=$?
  set -e
  [ "$signal_rc" -eq 143 ] && [ ! -e "$signal_secret" ] || {
    echo "[openapi-rust] TERM cleanup retained registered-style secret scratch" >&2
    exit 1
  }
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
  local name="$1" detail="$2" body="${3:-}" safe_render safe_line safe_body
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
  safe_render="$(render_safe_failure "$SECRET_NEEDLES" "$FAILURE_COUNT" "$name" "$detail" "$body")"
  safe_line="${safe_render%%$'\n'*}"
  safe_body="${safe_render#"$safe_line"}"
  printf '%s\n' "$safe_line" >>"$FAILURE_LOG"
  printf '%s\n' "[openapi-rust] FAIL ${safe_line#*] }" >&2
  [ -z "$safe_body" ] || printf '%s\n' "${safe_body#$'\n'}" >&2
  return 0
}

print_failure_summary() {
  [ "$FAILURE_COUNT" -gt 0 ] || return 0
  echo "" >&2
  echo "[openapi-rust] ===== $FAILURE_COUNT failed assertion(s) =====" >&2
  redact_registered_secrets <"$FAILURE_LOG" >&2
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
        if (.key | test("(?i)^(accessToken|refreshToken|token|password|secret|signature|claimPath)$"))
        then .value = "[REDACTED]"
        else . end
      )
    elif type == "string" and (contains_secret or test("momo_(agent|pair)_v1\\.[A-Za-z0-9._~-]+")) then "[REDACTED]"
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
# HAP-E1 관리 API에서 런타임에 발급한다. 둘 다 원문은 프로세스의 private
# scratch에서만 읽고 즉시 secret needle로 등록한다.
GATE_AGENT_TOKEN=""
GATE_AGENT_NO_PORT_TOKEN=""
GATE_AGENT_CREDENTIAL_ID=""
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
LIVEKIT_API_KEY="$(rand_hex)"
LIVEKIT_API_SECRET="$(rand_hex)"
GATEWAY_SECRET="$(rand_hex)"

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
    environment:
      AGENT_GATEWAY_MODE: \${AGENT_GATEWAY_MODE}
      AGENT_GATEWAY_SECRET: \${AGENT_GATEWAY_SECRET}
      MOMO_ALLOW_LEGACY_GATEWAY_SECRET: \${MOMO_ALLOW_LEGACY_GATEWAY_SECRET}
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

# Diagnostic text is untrusted too: candidates may reflect any already-known
# credential (including a human JWT) in a body, header or error string. Read the
# needle file by path—not argv—and replace longest values first before the
# envelope-shaped fallback runs.
redact_registered_secrets() {
  if ! secret_needles_are_safe; then
    # Consume potentially sensitive input but never echo it when the registry
    # cannot itself be trusted.
    cat >/dev/null
    printf '%s' '[diagnostic withheld: secret registry unavailable]'
    return
  fi
  redact_with_needles_file "$SECRET_NEEDLES"
}

load_private_response_body() {
  local matches='' scan_rc=0 match
  [ "$(file_identity "$RAW_RESPONSE_FILE")" = "${SECRET_IDENTITIES[3]}" ] || return 1
  matches="$(private_envelopes_in_file "$RAW_RESPONSE_FILE")" || scan_rc=$?
  case "$scan_rc" in
    0)
      while IFS= read -r match; do
        append_secret_with_derivatives "$match" || return 1
      done <<<"$matches"
      ;;
    1) ;;
    *) return 1 ;;
  esac
  RESPONSE_BODY="$(cat "$RAW_RESPONSE_FILE")"
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

require_private_envelope() {
  local value="$1" prefix="$2"
  private_envelope_valid "$value" "$prefix" || {
      echo "[openapi-rust] candidate returned an invalid credential envelope" >&2
      exit 1
    }
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
  "$GATE_PASSWORD" \
  "$JOIN_PASSWORD" "$PG_PASSWORD" "$APP_PASSWORD" "$RELAY_PASSWORD" \
  "$WORKER_PASSWORD" "$INVITE_CODE" "$JWT_HMAC" "$CENT_TOKEN_HMAC" \
  "$CENT_API_KEY" "$CENT_PROXY_SECRET" "$PROVIDER_LINK_MASTER_KEY" \
  "$LIVEKIT_API_KEY" "$LIVEKIT_API_SECRET"; do
  append_secret_with_derivatives "$secret_value" || {
    echo "[openapi-rust] could not initialize secret leak needles" >&2
    exit 1
  }
done
append_secret_with_derivatives "$GATEWAY_SECRET"

ENV_FILE="$TMP_DIR/rust-gate.env"
(umask 077; : >"$ENV_FILE")
register_secret_file "$ENV_FILE" || {
  echo "[openapi-rust] rust gate env is not a private owned 0600 regular file" >&2
  exit 1
}
cat >"$ENV_FILE" <<ENV
MOMO_RUST_IMAGE=$RUST_IMAGE
MOMO_ENV=local
MOMO_MIGRATE_ENV=development
MOMO_PITR_EVIDENCE_REQUIRED=0
MOMO_PITR_BOOTSTRAP_EMPTY=0
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
MOMO_LIVEKIT_API_KEY=$LIVEKIT_API_KEY
MOMO_LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
MOMO_LIVEKIT_URL=ws://livekit.invalid:7880
AGENT_GATEWAY_MODE=gateway
AGENT_GATEWAY_SECRET=$GATEWAY_SECRET
MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1

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
  local matches='' envelope_rc=0 match scan_rc=0
  [ "$(file_identity "$RAW_HEADERS_FILE")" = "${SECRET_IDENTITIES[4]}" ] || {
    echo "[openapi-rust] candidate response header scratch ownership changed" >&2
    return 1
  }
  secret_needles_are_safe || {
    echo "[openapi-rust] candidate response header needle file is unsafe" >&2
    return 1
  }
  # A candidate may reflect a newly minted private envelope in any header and
  # on any status. Register it before headers can reach any diagnostic path.
  matches="$(private_envelopes_in_file "$RAW_HEADERS_FILE")" || envelope_rc=$?
  case "$envelope_rc" in
    0)
      while IFS= read -r match; do
        append_secret_with_derivatives "$match" || return 1
      done <<<"$matches"
      ;;
    1) ;;
    *)
      echo "[openapi-rust] candidate response header envelope scan failed; headers withheld" >&2
      return 1
      ;;
  esac
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
#   * 초대 코드 하나 — `/v1/join` 표본용. admin 표면(#1769)은 아래 REST 로
#     따로 발급하고, 그 원문은 needle 로 등록한 뒤에만 표본 파일에 쓴다.
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
  load_private_response_body || {
    echo "[openapi-rust] candidate response secret scan failed; response withheld" >&2
    return 1
  }
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
  load_private_response_body || {
    echo "[openapi-rust] candidate Agent Port response secret scan failed; response withheld" >&2
    return 1
  }
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
  load_private_response_body || {
    echo "[openapi-rust] candidate work-host response secret scan failed; response withheld" >&2
    return 1
  }
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
# ADR-0166: unknown token is 404 ErrorResponse. Happy-path consume is
# claim_conformance_pg / verify_owner_claim.sh (this gate's owner already has
# a password, so a 200 here would require a second tenant). Capture the
# login pair first — sample() overwrites RESPONSE_BODY, and this 404 body
# has no accessToken.
sample claim-unknown post "/v1/claim" "/v1/claim" 404 \
  '{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","password":"unused-claim-password"}'

# refresh 는 **단일 사용 회전**이다: 제시한 토큰은 원자적으로 revoke 되고 새 쌍이
# 나온다. 그러므로 한 번만 부르고, 이후 전부 새 쌍을 쓴다.
sample refresh post "/v1/auth/refresh" "/v1/auth/refresh" 200 \
  "$(refresh_request_body "$REFRESH")"
ACCESS="$(printf '%s' "$RESPONSE_BODY" | jq -er '.accessToken')"
REFRESH="$(printf '%s' "$RESPONSE_BODY" | jq -er '.refreshToken')"
append_secret_with_derivatives "$ACCESS"
append_secret_with_derivatives "$REFRESH"

# #1767 — wrong current password keeps this session alive (403). Happy-path
# rotation is password_reset_conformance_pg. Issue a reset for the peer so
# the 201 shape is sampled; register the raw token immediately.
sample change-own-password patch \
  "/v1/workspaces/{workspaceId}/members/me/password" \
  "/v1/workspaces/$WS/members/me/password" 403 \
  '{"currentPassword":"not-the-gate-password","newPassword":"unused-new-password"}' \
  "$ACCESS"
sample issue-password-reset post \
  "/v1/workspaces/{workspaceId}/members/{memberId}/password-reset" \
  "/v1/workspaces/$WS/members/$GATE_PEER_ID/password-reset" 201 \
  "" "$ACCESS"
RESET_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -r '.token // empty')"
append_secret_with_derivatives "$RESET_TOKEN"
[ -n "$RESET_TOKEN" ] || {
  echo "[openapi-rust] password-reset 201 produced no token" >&2
  redacted_body >&2
  exit 1
}
# sample() redacts the `token` key by name, but claimPath embeds the raw
# token. Rewrite the evidence file now that the needle exists.
RESET_SAMPLE="$(jq -rs --arg name issue-password-reset \
  'map(select(.name==$name)) | last | .body_file // empty' "$MANIFEST")"
[ -n "$RESET_SAMPLE" ] && [ -f "$RESET_SAMPLE" ] && [ ! -L "$RESET_SAMPLE" ] || {
  echo "[openapi-rust] password-reset sample file missing after 201" >&2
  exit 1
}
RESET_SAMPLE_REDACTED="$RESET_SAMPLE.redacted"
(umask 077; : >"$RESET_SAMPLE_REDACTED")
redact_json <"$RESET_SAMPLE" >"$RESET_SAMPLE_REDACTED"
mv "$RESET_SAMPLE_REDACTED" "$RESET_SAMPLE"

# #1800/#1770 — operator bag. Empty GET then a two-key PATCH so both 200
# shapes are sampled. role_labels is accepted and replaced whole.
sample workspace-settings-get get \
  "/v1/workspaces/{workspaceId}/settings" \
  "/v1/workspaces/$WS/settings" 200 \
  "" "$ACCESS"
sample workspace-settings-patch patch \
  "/v1/workspaces/{workspaceId}/settings" \
  "/v1/workspaces/$WS/settings" 200 \
  '{"allowed_agent_models":["hermes-agent"],"role_labels":{"owner":"마스터"}}' \
  "$ACCESS"

# A malicious Agent Port may reflect the human bearer in an unexpected error
# header and body. Exercise the exact gate_fail path and require zero registered
# secret needles in both its persisted failure line and emitted diagnostics.
REFLECTED_FAILURE_LOG="$TMP_DIR/reflected-access-failure.log"
REFLECTED_OUTPUT="$TMP_DIR/reflected-access-output.log"
(umask 077; : >"$REFLECTED_FAILURE_LOG"; : >"$REFLECTED_OUTPUT")
register_secret_file "$REFLECTED_FAILURE_LOG"
register_secret_file "$REFLECTED_OUTPUT"
(
  FAILURE_COUNT=0
  FAILURE_LOG="$REFLECTED_FAILURE_LOG"
  gate_fail agent-port-reflected-access \
    "unexpected status 418; X-Debug: $ACCESS" \
    "{\"error\":\"reflected bearer $ACCESS\"}"
) >"$REFLECTED_OUTPUT" 2>&1
needle_scan_state "$SECRET_NEEDLES" "$REFLECTED_FAILURE_LOG" || {
  echo "[openapi-rust] reflected Agent Port access bearer reached failure storage" >&2
  exit 1
}
needle_scan_state "$SECRET_NEEDLES" "$REFLECTED_OUTPUT" || {
  echo "[openapi-rust] reflected Agent Port access bearer reached diagnostics" >&2
  exit 1
}
grep -Fq '[REDACTED_REGISTERED_SECRET]' "$REFLECTED_OUTPUT" || {
  echo "[openapi-rust] reflected Agent Port fixture did not exercise registered-secret redaction" >&2
  exit 1
}

sample realtime-token post "/v1/auth/realtime-token" "/v1/auth/realtime-token" 200 \
  "" "$ACCESS"
REALTIME_SECRET="$(printf '%s' "$RESPONSE_BODY" | jq -r '.token // empty')"
append_secret_with_derivatives "$REALTIME_SECRET"
guard_jq '.tokenType == "centrifugo.connection.jwt" and (.expiresAtMs | type == "number")' \
  "realtime token is a centrifugo connection jwt"

# ---------------------------------------------------------------------------
# generic per-agent bearer — issue from the real HAP-E1 API, then consume the
# same credential through both the Agent Port and work-control surfaces.
# ---------------------------------------------------------------------------
api post "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials" \
  '{"scopes":["work:control"],"label":"openapi rust no-port control"}' "$ACCESS"
if [ "$RESPONSE_STATUS" != "201" ]; then
  gate_fail agent-credential-no-port-fixture \
    "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
fi
GATE_AGENT_NO_PORT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token' 2>/dev/null || true)"
append_secret_with_derivatives "$GATE_AGENT_NO_PORT_TOKEN" || {
  echo "[openapi-rust] could not register no-port credential secret" >&2
  exit 1
}
[ -n "$GATE_AGENT_NO_PORT_TOKEN" ] || {
  echo "[openapi-rust] no-port credential response contained no token" >&2
  exit 1
}

api post "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials" \
  '{"scopes":["work:control","agent:port:connect"],"label":"openapi rust gate"}' "$ACCESS"
if [ "$RESPONSE_STATUS" != "201" ]; then
  gate_fail agent-credential-create \
    "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
fi
GATE_AGENT_TOKEN="$(printf '%s' "$RESPONSE_BODY" | jq -er '.token' 2>/dev/null || true)"
GATE_AGENT_CREDENTIAL_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential.id' 2>/dev/null || true)"
append_secret_with_derivatives "$GATE_AGENT_TOKEN" || {
  echo "[openapi-rust] could not register agent credential secret" >&2
  exit 1
}
[ -n "$GATE_AGENT_TOKEN" ] && canonical_uuid "$GATE_AGENT_CREDENTIAL_ID" || {
  echo "[openapi-rust] credential response omitted a token or canonical id" >&2
  exit 1
}
guard_jq '.tokenType == "Bearer"
  and .credential.scopes == ["work:control","agent:port:connect"]
  and .rotatedCredentialCount >= 1' \
  "agent credential create returns the explicitly scoped successor"
if [ "$(response_header Cache-Control)" != "no-store" ] || \
  [ "$(response_header Pragma)" != "no-cache" ]; then
  gate_fail agent-credential-create \
    "missing one-time response cache headers" "$(redacted_headers)"
fi
record_sample agent-credential-create post \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/credentials" 201

sample agent-credential-list get \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/credentials" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_AGENT_CREDENTIAL_ID" '
  any(.credentials[]; (.id | ascii_downcase) == ($id | ascii_downcase))
  and (tostring | contains("momo_agent_v1.") | not)
  and (has("token") | not) and (has("tokenHash") | not)' \
  "credential list is metadata-only and contains the issued row"

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

# HAP-E3 dedicated identity: create -> foundation detection -> confirm ->
# active proof. Every secret is registered before another command can print it.
HOSTED_HANDLE="hosted-gate-$RUN_EPOCH"
# An audit failure at the tail of create must roll back the dedicated member,
# agent/profile, connection and audit as one transaction. Retrying the exact
# handle after removing the fault proves there was no hidden orphan.
HOSTED_CREATE_ZERO_BEFORE="$(run_sql -Atc "SELECT count(*) FROM member WHERE workspace_id='$WS' AND handle='$HOSTED_HANDLE';")"
run_sql <<'SQL'
CREATE OR REPLACE FUNCTION test_fail_hosted_create_audit() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action = 'hosted_agent.connection.created' THEN
    RAISE EXCEPTION 'injected hosted create audit failure';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_fail_hosted_create_audit ON audit_log;
CREATE TRIGGER test_fail_hosted_create_audit BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION test_fail_hosted_create_audit();
SQL
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "$HOSTED_HANDLE" '{displayName:"Hosted Gate",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "500" ] || gate_fail hosted-create-rollback-status "injected create failure was not 500" "$(redacted_body)"
run_sql -Atc "SELECT \
  ((SELECT count(*) FROM member WHERE workspace_id='$WS' AND handle='$HOSTED_HANDLE')=$HOSTED_CREATE_ZERO_BEFORE)::text || ':' || \
  ((SELECT count(*) FROM agent a JOIN member m ON m.workspace_id=a.workspace_id AND m.id=a.member_id WHERE m.workspace_id='$WS' AND m.handle='$HOSTED_HANDLE')=0)::text || ':' || \
  ((SELECT count(*) FROM hosted_agent_connection hc JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id WHERE m.workspace_id='$WS' AND m.handle='$HOSTED_HANDLE')=0)::text || ':' || \
  ((SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND action='hosted_agent.connection.created' AND detail->>'schema'='momo.hosted_agent.connection.created.v1')=0)::text;" | \
  grep -qx 'true:true:true:true' || gate_fail hosted-create-rollback-delta0 "failed create left a member/agent/connection/audit orphan" "database evidence withheld"
run_sql -c "DROP TRIGGER test_fail_hosted_create_audit ON audit_log; DROP FUNCTION test_fail_hosted_create_audit();"
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "$HOSTED_HANDLE" '{displayName:"Hosted Gate",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
if [ "$RESPONSE_STATUS" != "201" ]; then
  gate_fail hosted-agent-create "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
fi
HOSTED_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
HOSTED_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
HOSTED_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$HOSTED_PAIRING"
record_sample hosted-agent-create post "/v1/workspaces/{workspaceId}/hosted-agent-connections" 201
CONCURRENT_DIR="$TMP_DIR/hosted-concurrency"
mkdir -m 700 "$CONCURRENT_DIR"
# Register every concurrency scratch inode before a bearer or one-time response
# is written. This makes EXIT/INT/TERM cleanup complete even when a worker or
# assertion fails midway through a race.
for concurrency_name in \
  one.auth one.body one.headers one.response one.status \
  two.auth two.body two.headers two.response two.status \
  proof-one.auth proof-one.body proof-one.response proof-one.status \
  proof-two.auth proof-two.body proof-two.response proof-two.status \
  gateway-secret.auth gateway-claim.response gateway-claim.status \
  redetect.auth redetect.body redetect.response redetect.status \
  regenerate.auth regenerate.response regenerate.status \
  reconfirm.auth reconfirm.body reconfirm.response reconfirm.status \
  rereg.auth rereg.response rereg.status \
  proof-reg-proof.auth proof-reg-proof.body proof-reg-proof.response proof-reg-proof.status \
  proof-reg-admin.auth proof-reg-admin.response proof-reg-admin.status; do
  concurrency_path="$CONCURRENT_DIR/$concurrency_name"
  (umask 077; : >"$concurrency_path")
  register_secret_file "$concurrency_path" || {
    echo "[openapi-rust] FAIL could not register concurrency scratch" >&2
    exit 1
  }
done
# New-table RLS is asserted directly under momo_app rather than inferred from
# HTTP path scoping or the global table list.
run_sql -Atc "SELECT (NOT rolbypassrls)::text FROM pg_roles WHERE rolname='momo_app'; \
  SELECT relforcerowsecurity::text FROM pg_class WHERE oid='public.hosted_agent_connection'::regclass;" | \
  grep -qx $'true\ntrue' || gate_fail hosted-rls-flags "momo_app bypass or FORCE RLS invariant failed" "database evidence withheld"
RLS_FOREIGN_WS="$(lower_uuid)"
run_sql -Atc "BEGIN; SET LOCAL ROLE momo_app; \
  SELECT count(*) FROM public.hosted_agent_connection WHERE id='$HOSTED_CONNECTION_ID'; ROLLBACK;" | \
  grep -qx '0' || gate_fail hosted-rls-select "unset GUC exposed hosted connection" "database evidence withheld"
run_sql -Atc "BEGIN; SET LOCAL ROLE momo_app; SET LOCAL app.workspace_id='$RLS_FOREIGN_WS'; \
  SELECT count(*) FROM public.hosted_agent_connection WHERE id='$HOSTED_CONNECTION_ID'; ROLLBACK;" | \
  grep -qx '0' || gate_fail hosted-rls-select "wrong GUC exposed hosted connection" "database evidence withheld"
RLS_INSERT_ID="$(lower_uuid)"
set +e
run_sql >/dev/null 2>&1 <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$RLS_FOREIGN_WS';
INSERT INTO public.hosted_agent_connection(
 id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at,created_by
) VALUES (
 '$RLS_INSERT_ID','$WS','$HOSTED_AGENT_ID','pairing_pending',digest('rls-red','sha256'),now()+interval '1 hour','$GATE_MEMBER_ID'
);
COMMIT;
SQL
rls_insert_rc=$?
set -e
[ "$rls_insert_rc" -ne 0 ] || gate_fail hosted-rls-insert "wrong GUC insert unexpectedly succeeded" "database evidence withheld"
run_sql -Atc "SELECT count(*) FROM hosted_agent_connection WHERE id='$RLS_INSERT_ID';" | grep -qx '0' || \
  gate_fail hosted-rls-insert "wrong GUC insert left a row" "database evidence withheld"
# A temp relation named agent must never influence the trigger's lookup. The
# managed non-sentinel agent has a valid composite FK, so trigger rejection is
# the only acceptable failure.
SHADOW_INSERT_ID="$(lower_uuid)"
set +e
run_sql >/dev/null 2>&1 <<SQL
BEGIN;
SET LOCAL ROLE momo_app;
SET LOCAL app.workspace_id='$WS';
CREATE TEMP TABLE agent (LIKE public.agent INCLUDING ALL);
INSERT INTO agent SELECT * FROM public.agent WHERE workspace_id='$WS' AND member_id='$GATE_AGENT_ID';
UPDATE agent SET model='hosted-agent',base_url='https://hosted-agent.invalid/disabled',config=jsonb_build_object('execution_mode','hosted_dial_in');
INSERT INTO public.hosted_agent_connection(
 id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at,created_by
) VALUES (
 '$SHADOW_INSERT_ID','$WS','$GATE_AGENT_ID','pairing_pending',digest('shadow-red','sha256'),now()+interval '1 hour','$GATE_MEMBER_ID'
);
COMMIT;
SQL
shadow_insert_rc=$?
set -e
[ "$shadow_insert_rc" -ne 0 ] || gate_fail hosted-trigger-shadow "temp agent shadow bypassed sentinel trigger" "database evidence withheld"
run_sql -Atc "SELECT count(*) FROM hosted_agent_connection WHERE id='$SHADOW_INSERT_ID';" | grep -qx '0' || \
  gate_fail hosted-trigger-shadow "shadow bypass left a connection" "database evidence withheld"
run_sql -c "INSERT INTO membership(workspace_id,channel_id,member_id,role) VALUES ('$WS','$GENERAL_CHANNEL_ID','$HOSTED_AGENT_ID','member') ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;"
assert_hosted_mention_disabled() {
  local phase="$1" handle="$2" agent_id="$3" run_before job_before client_id
  run_before="$(run_sql -Atc "SELECT count(*) FROM agent_run WHERE workspace_id='$WS' AND agent_member_id='$agent_id';")"
  job_before="$(run_sql -Atc "SELECT count(*) FROM outbox WHERE workspace_id='$WS' AND kind='agent_job' AND partition_key='$agent_id';")"
  client_id="$(lower_uuid)"
  api post "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" \
    "$(jq -cn --arg id "$client_id" --arg body "@$handle must remain disabled" '{clientMsgId:$id,body:$body}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "201" ] || gate_fail "hosted-mention-$phase" "mention send failed" "$(redacted_body)"
  run_sql -Atc "SELECT \
    ((SELECT count(*) FROM agent_run WHERE workspace_id='$WS' AND agent_member_id='$agent_id')=$run_before)::text || ':' || \
    ((SELECT count(*) FROM outbox WHERE workspace_id='$WS' AND kind='agent_job' AND partition_key='$agent_id')=$job_before)::text;" | \
    grep -qx 'true:true' || gate_fail "hosted-mention-$phase" "mention produced hosted run/job" "database evidence withheld"
}
assert_hosted_mention_disabled pending "$HOSTED_HANDLE" "$HOSTED_AGENT_ID"
assert_hosted_resume_denied() {
  local phase="$1" agent_id="${2:-$HOSTED_AGENT_ID}" before
  before="$(run_sql -Atc "SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND target_id='$agent_id' AND action='hosted_agent.connection.resume_denied';")"
  api put "/v1/workspaces/$WS/agents/$agent_id/pause" '{"paused":false}' "$ACCESS"
  [ "$RESPONSE_STATUS" = "409" ] || gate_fail "hosted-resume-$phase" "pre-proof resume was not 409" "$(redacted_body)"
  run_sql -Atc "SELECT ap.paused::text || ':' || \
    ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=ap.workspace_id AND a.target_id=ap.agent_member_id \
      AND a.action='hosted_agent.connection.resume_denied')=$((before + 1)))::text \
    FROM agent_profile ap WHERE ap.workspace_id='$WS' AND ap.agent_member_id='$agent_id';" | \
    grep -qx 'true:true' || gate_fail "hosted-resume-$phase" "resume denial mutated profile or audit cardinality" "database evidence withheld"
}
assert_hosted_resume_denied pending
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/pairing-challenge/regenerate" "" "$ACCESS"
if [ "$RESPONSE_STATUS" != "200" ]; then
  gate_fail hosted-agent-regenerate "expected HTTP 200, got $RESPONSE_STATUS" "$(redacted_body)"
fi
HOSTED_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$HOSTED_PAIRING"
record_sample hosted-agent-regenerate post "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/pairing-challenge/regenerate" 200

sample hosted-agent-list get "/v1/workspaces/{workspaceId}/hosted-agent-connections" \
  "/v1/workspaces/$WS/hosted-agent-connections" 200 "" "$ACCESS"
sample hosted-agent-get get "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}" \
  "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID" 200 "" "$ACCESS"

expect_agent_port hosted-agent-non-foundation-does-not-detect 401 \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  "$HOSTED_PAIRING" "2025-11-25" "notifications/initialized"
api get "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "pairing_pending"' \
  "non-foundation request leaves pairing pending"

# Even ordinary-looking provider clientInfo is raw third-party text and must be
# absent from persistence; only server-owned finite booleans may survive.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-clientinfo-${RUN_ID:0:8}" '{displayName:"Hosted ClientInfo",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-clientinfo-create "expected 201" "$(redacted_body)"
CLIENTINFO_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
CLIENTINFO_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$CLIENTINFO_PAIRING"
expect_agent_port hosted-clientinfo-normal-detect 200 "$MODERN_DISCOVER_BODY" \
  "$CLIENTINFO_PAIRING" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (detected_client_name IS NULL)::text || ':' || \
  (detected_client_version IS NULL)::text FROM hosted_agent_connection \
  WHERE workspace_id='$WS' AND id='$CLIENTINFO_CONNECTION_ID';" | \
  grep -qx 'true:true' || gate_fail hosted-clientinfo-raw-null "normal raw clientInfo was persisted" "database evidence withheld"

HOSTED_ADVERSARIAL_DISCOVER_BODY="$(printf '%s' "$MODERN_DISCOVER_BODY" | jq -c '
  .params._meta["io.modelcontextprotocol/clientInfo"] = {
    name:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    version:"v11111111111111111111111"
  }
  | .params._meta["io.modelcontextprotocol/clientCapabilities"] = {
      tools:{listChanged:true,tokenEndpoint:true,note:"momo_agent_v1.00000000-0000-7000-8000-000000000001.capLeak"},
      authorization:{enabled:true},sampling:false,telemetry:true,
      experimental:{safeLookingUnknown:true,numericVersion:"123456789012345678901234"},
      values:["secret"],count:7
    }')"
sample_agent_port hosted-agent-detect 200 "$HOSTED_ADVERSARIAL_DISCOVER_BODY" \
  "$HOSTED_PAIRING" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (detected_client_name IS NULL)::text || ':' || \
  (detected_client_version IS NULL)::text || ':' || \
  (detected_capabilities = '{\"sampling\": false, \"tools\": {\"listChanged\": true}}'::jsonb)::text || ':' || \
  (detected_capabilities::text !~ 'momo_(agent|pair)_v1|token|secret|authorization|telemetry|experimental')::text \
  FROM hosted_agent_connection WHERE workspace_id='$WS' AND id='$HOSTED_CONNECTION_ID';" | \
  grep -qx 'true:true:true:true' || gate_fail hosted-observation-sanitizer "untrusted client metadata survived the closed projection" "database evidence withheld"
api get "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "detected"
  and (tostring | contains("oort-openapi-rust-gate") | not)' \
  "foundation detection never projects provider metadata"
assert_hosted_mention_disabled detected "$HOSTED_HANDLE" "$HOSTED_AGENT_ID"
assert_hosted_resume_denied detected
expect_agent_port hosted-agent-pairing-replay-denied 401 "$MODERN_DISCOVER_BODY" \
  "$HOSTED_PAIRING" "2026-07-28" "server/discover"
for rejected_scope in messages:write work:control future:hosted:scope; do
  scope_audit_before="$(run_sql -Atc "SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND target_id='$HOSTED_CONNECTION_ID' AND action='hosted_agent.connection.confirm_scope_denied';")"
  scope_membership_before="$(run_sql -Atc "SELECT count(*) FROM membership WHERE workspace_id='$WS' AND member_id='$HOSTED_AGENT_ID';")"
  api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
    "$(jq -cn --arg agent "$HOSTED_AGENT_ID" --arg scope "$rejected_scope" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:(if $scope=="messages:write" then [$scope] else ["agent:port:connect",$scope] end),authMode:"static_bearer"}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "400" ] || \
    gate_fail hosted-agent-confirm-scope-denied "expected HTTP 400 for excluded/future scope, got $RESPONSE_STATUS" "$(redacted_body)"
  run_sql -Atc "SELECT (hc.status='detected')::text || ':' || (hc.active_token_id IS NULL)::text || ':' || \
    ((SELECT count(*) FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id)=0)::text || ':' || \
    ((SELECT count(*) FROM membership ms WHERE ms.workspace_id=hc.workspace_id AND ms.member_id=hc.agent_member_id)=$scope_membership_before)::text || ':' || \
    ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id \
      AND a.action='hosted_agent.connection.confirm_scope_denied')=$((scope_audit_before + 1)))::text || ':' || \
    ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id \
      AND a.action='hosted_agent.connection.confirm_scope_denied' AND a.detail ?& ARRAY['schema','code','requested_scope_count'] \
      AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(a.detail) k WHERE k NOT IN ('schema','code','requested_scope_count')))=$((scope_audit_before + 1)))::text \
    FROM hosted_agent_connection hc WHERE hc.workspace_id='$WS' AND hc.id='$HOSTED_CONNECTION_ID';" | \
    grep -qx 'true:true:true:true:true:true' || gate_fail hosted-confirm-scope-zero-partial "scope denial mutated issuance or emitted unbounded audit" "database evidence withheld"
done
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"oauth"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "400" ] || \
  gate_fail hosted-agent-confirm-oauth-denied "expected HTTP 400, got $RESPONSE_STATUS" "$(redacted_body)"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$GATE_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-agent-confirm-wrong-member "wrong detected member was not rejected" "response withheld"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/messages",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "400" ] || gate_fail hosted-agent-confirm-wrong-audience "wrong audience was not rejected" "$(redacted_body)"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,approvedChannelIds:[],approvedScopes:["agent:port:connect"]}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "422" ] || gate_fail hosted-agent-confirm-omission "approval omission was not rejected" "$(redacted_body)"
ARCHIVED_CHANNEL_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
DM_CHANNEL_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
run_sql -c "INSERT INTO channel(id,workspace_id,kind,name,archived_at) VALUES \
  ('$ARCHIVED_CHANNEL_ID','$WS','private','archived-hosted',now()); \
  INSERT INTO channel(id,workspace_id,kind,dm_key) VALUES \
  ('$DM_CHANNEL_ID','$WS','dm','hosted-dm-$RUN_EPOCH');"
for rejected_channel in "$ARCHIVED_CHANNEL_ID" "$DM_CHANNEL_ID"; do
  api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
    "$(jq -cn --arg agent "$HOSTED_AGENT_ID" --arg channel "$rejected_channel" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[$channel],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "400" ] || gate_fail hosted-agent-confirm-channel "archived/DM channel was not rejected" "$(redacted_body)"
done
# Confirm's active bearer, memberships, state transition and audit are one
# commit. A failing terminal audit must leave an exact delta of zero.
HOSTED_CONFIRM_ZERO_BEFORE="$(run_sql -Atc "SELECT \
  (SELECT count(*) FROM token WHERE workspace_id='$WS' AND hosted_connection_id='$HOSTED_CONNECTION_ID')::text || ':' || \
  (SELECT count(*) FROM membership WHERE workspace_id='$WS' AND member_id='$HOSTED_AGENT_ID')::text || ':' || \
  (SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND target_id='$HOSTED_CONNECTION_ID' AND action='hosted_agent.connection.confirmed')::text;")"
run_sql <<'SQL'
CREATE OR REPLACE FUNCTION test_fail_hosted_confirm_audit() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action = 'hosted_agent.connection.confirmed' THEN
    RAISE EXCEPTION 'injected hosted confirm audit failure';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_fail_hosted_confirm_audit ON audit_log;
CREATE TRIGGER test_fail_hosted_confirm_audit BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION test_fail_hosted_confirm_audit();
SQL
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "500" ] || gate_fail hosted-confirm-rollback-status "injected confirm failure was not 500" "$(redacted_body)"
HOSTED_CONFIRM_ZERO_AFTER="$(run_sql -Atc "SELECT \
  (SELECT count(*) FROM token WHERE workspace_id='$WS' AND hosted_connection_id='$HOSTED_CONNECTION_ID')::text || ':' || \
  (SELECT count(*) FROM membership WHERE workspace_id='$WS' AND member_id='$HOSTED_AGENT_ID')::text || ':' || \
  (SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND target_id='$HOSTED_CONNECTION_ID' AND action='hosted_agent.connection.confirmed')::text;")"
[ "$HOSTED_CONFIRM_ZERO_AFTER" = "$HOSTED_CONFIRM_ZERO_BEFORE" ] || gate_fail hosted-confirm-rollback-delta0 "failed confirm changed token/membership/audit counts" "database evidence withheld"
run_sql -Atc "SELECT (status='detected')::text || ':' || (confirmed_at IS NULL)::text || ':' || (active_token_id IS NULL)::text FROM hosted_agent_connection WHERE workspace_id='$WS' AND id='$HOSTED_CONNECTION_ID';" | \
  grep -qx 'true:true:true' || gate_fail hosted-confirm-rollback-state "failed confirm left a transition" "database evidence withheld"
run_sql -c "DROP TRIGGER test_fail_hosted_confirm_audit ON audit_log; DROP FUNCTION test_fail_hosted_confirm_audit();"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect","agent:inbox:read","messages:read","messages:write","agent:jobs:read","agent:runs:callback"],authMode:"static_bearer"}')" "$ACCESS"
if [ "$RESPONSE_STATUS" != "201" ]; then
  gate_fail hosted-agent-confirm "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
fi
HOSTED_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
HOSTED_ACTIVE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credentialId')"
append_secret_with_derivatives "$HOSTED_ACTIVE"
record_sample hosted-agent-confirm post "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/confirm" 201
expect_agent_port hosted-agent-pre-proof-non-foundation-denied 401 \
  '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}' \
  "$HOSTED_ACTIVE" "2025-11-25" "ping"
api get "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/gateway/jobs/pending" "" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-pre-proof-gateway-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
api get "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "detected" and .connection.activeCredentialId != null' \
  "pre-proof non-foundation call preserves detected state"
assert_hosted_mention_disabled confirmed "$HOSTED_HANDLE" "$HOSTED_AGENT_ID"
assert_hosted_resume_denied confirmed
sample_agent_port hosted-agent-proof 200 "$MODERN_DISCOVER_BODY" \
  "$HOSTED_ACTIVE" "2026-07-28" "server/discover"
api get "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "active"' \
  "first active foundation call proves binding"

# Detection TTL remains authoritative through confirm and proof. Expiration
# always closes the lifecycle, pauses the member and leaves no live token.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-exp-confirm-${RUN_ID:0:8}" '{displayName:"Hosted Expired Confirm",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-exp-confirm-create "expected 201" "$(redacted_body)"
EXP_CONFIRM_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
EXP_CONFIRM_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
EXP_CONFIRM_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$EXP_CONFIRM_PAIR"
expect_agent_port hosted-exp-confirm-detect 200 "$MODERN_DISCOVER_BODY" \
  "$EXP_CONFIRM_PAIR" "2026-07-28" "server/discover"
run_sql -c "UPDATE hosted_agent_connection SET pairing_expires_at=now()-interval '1 second' WHERE workspace_id='$WS' AND id='$EXP_CONFIRM_ID';"
api post "/v1/workspaces/$WS/hosted-agent-connections/$EXP_CONFIRM_ID/confirm" \
  "$(jq -cn --arg agent "$EXP_CONFIRM_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-exp-confirm-denied "expired detected confirm was not 409" "$(redacted_body)"
run_sql -Atc "SELECT (hc.status='expired')::text || ':' || ap.paused::text || ':' || \
  (hc.active_token_id IS NULL)::text || ':' || \
  (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text \
  FROM hosted_agent_connection hc JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$EXP_CONFIRM_ID';" | grep -qx 'true:true:true:true' || \
  gate_fail hosted-exp-confirm-state "expired confirm retained authority" "database evidence withheld"

api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-exp-proof-${RUN_ID:0:8}" '{displayName:"Hosted Expired Proof",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-exp-proof-create "expected 201" "$(redacted_body)"
EXP_PROOF_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
EXP_PROOF_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
EXP_PROOF_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$EXP_PROOF_PAIR"
expect_agent_port hosted-exp-proof-detect 200 "$MODERN_DISCOVER_BODY" \
  "$EXP_PROOF_PAIR" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$EXP_PROOF_ID/confirm" \
  "$(jq -cn --arg agent "$EXP_PROOF_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-exp-proof-confirm "expected 201" "$(redacted_body)"
EXP_PROOF_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
append_secret_with_derivatives "$EXP_PROOF_ACTIVE"
run_sql -c "UPDATE hosted_agent_connection SET pairing_expires_at=now()-interval '1 second' WHERE workspace_id='$WS' AND id='$EXP_PROOF_ID';"
expect_agent_port hosted-exp-proof-denied 401 "$MODERN_DISCOVER_BODY" \
  "$EXP_PROOF_ACTIVE" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (hc.status='expired')::text || ':' || ap.paused::text || ':' || \
  (hc.active_token_id IS NULL)::text || ':' || \
  (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text \
  FROM hosted_agent_connection hc JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$EXP_PROOF_ID';" | grep -qx 'true:true:true:true' || \
  gate_fail hosted-exp-proof-state "expired proof retained authority" "database evidence withheld"

# Loss of the active member/workspace authority invalidates the lifecycle, and
# restoring the row never resurrects the old pairing/active credential.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-live-detect-${RUN_ID:0:8}" '{displayName:"Hosted Liveness Detect",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-live-detect-create "expected 201" "$(redacted_body)"
LIVE_DETECT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
LIVE_DETECT_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
LIVE_DETECT_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$LIVE_DETECT_PAIR"
run_sql -c "UPDATE member SET status='suspended' WHERE workspace_id='$WS' AND id='$LIVE_DETECT_AGENT';"
expect_agent_port hosted-live-detect-denied 401 "$MODERN_DISCOVER_BODY" \
  "$LIVE_DETECT_PAIR" "2026-07-28" "server/discover"
run_sql -c "UPDATE member SET status='active' WHERE workspace_id='$WS' AND id='$LIVE_DETECT_AGENT';"
expect_agent_port hosted-live-detect-not-restored 401 "$MODERN_DISCOVER_BODY" \
  "$LIVE_DETECT_PAIR" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (status='expired')::text FROM hosted_agent_connection WHERE workspace_id='$WS' AND id='$LIVE_DETECT_ID';" | \
  grep -qx 'true' || gate_fail hosted-live-detect-state "identity restoration resurrected pairing" "database evidence withheld"

api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-live-confirm-${RUN_ID:0:8}" '{displayName:"Hosted Liveness Confirm",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-live-confirm-create "expected 201" "$(redacted_body)"
LIVE_CONFIRM_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
LIVE_CONFIRM_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
LIVE_CONFIRM_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$LIVE_CONFIRM_PAIR"
expect_agent_port hosted-live-confirm-detect 200 "$MODERN_DISCOVER_BODY" \
  "$LIVE_CONFIRM_PAIR" "2026-07-28" "server/discover"
run_sql -c "DELETE FROM workspace_membership WHERE workspace_id='$WS' AND member_id='$LIVE_CONFIRM_AGENT';"
api post "/v1/workspaces/$WS/hosted-agent-connections/$LIVE_CONFIRM_ID/confirm" \
  "$(jq -cn --arg agent "$LIVE_CONFIRM_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-live-confirm-denied "missing workspace authority confirm was not 409" "$(redacted_body)"
run_sql -c "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES ('$WS','$LIVE_CONFIRM_AGENT','member');"
api post "/v1/workspaces/$WS/hosted-agent-connections/$LIVE_CONFIRM_ID/confirm" \
  "$(jq -cn --arg agent "$LIVE_CONFIRM_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-live-confirm-not-restored "restored workspace authority reused confirm" "$(redacted_body)"
run_sql -Atc "SELECT (status='expired')::text || ':' || (active_token_id IS NULL)::text || ':' || \
  (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hosted_agent_connection.workspace_id AND t.hosted_connection_id=hosted_agent_connection.id AND t.revoked_at IS NULL))::text \
  FROM hosted_agent_connection WHERE workspace_id='$WS' AND id='$LIVE_CONFIRM_ID';" | grep -qx 'true:true:true' || \
  gate_fail hosted-live-confirm-state "workspace authority restoration resurrected confirm" "database evidence withheld"

api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-live-proof-${RUN_ID:0:8}" '{displayName:"Hosted Liveness Proof",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-live-proof-create "expected 201" "$(redacted_body)"
LIVE_PROOF_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
LIVE_PROOF_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
LIVE_PROOF_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$LIVE_PROOF_PAIR"
expect_agent_port hosted-live-proof-detect 200 "$MODERN_DISCOVER_BODY" \
  "$LIVE_PROOF_PAIR" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$LIVE_PROOF_ID/confirm" \
  "$(jq -cn --arg agent "$LIVE_PROOF_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-live-proof-confirm "expected 201" "$(redacted_body)"
LIVE_PROOF_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
append_secret_with_derivatives "$LIVE_PROOF_ACTIVE"
run_sql -c "DELETE FROM workspace_membership WHERE workspace_id='$WS' AND member_id='$LIVE_PROOF_AGENT';"
expect_agent_port hosted-live-proof-denied 401 "$MODERN_DISCOVER_BODY" \
  "$LIVE_PROOF_ACTIVE" "2026-07-28" "server/discover"
run_sql -c "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES ('$WS','$LIVE_PROOF_AGENT','member');"
expect_agent_port hosted-live-proof-not-restored 401 "$MODERN_DISCOVER_BODY" \
  "$LIVE_PROOF_ACTIVE" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (hc.status='expired')::text || ':' || ap.paused::text || ':' || \
  (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text \
  FROM hosted_agent_connection hc JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$LIVE_PROOF_ID';" | grep -qx 'true:true:true' || \
  gate_fail hosted-live-proof-state "workspace authority restoration resurrected proof" "database evidence withheld"

# Missing profile row is an injected zero-row UPDATE. The internal failure must
# roll back token touch/status/audit rather than treating it as an activation.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-profile-zero-${RUN_ID:0:8}" '{displayName:"Hosted Profile Zero",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-profile-zero-create "expected 201" "$(redacted_body)"
PROFILE_ZERO_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
PROFILE_ZERO_AGENT="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
PROFILE_ZERO_PAIR="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$PROFILE_ZERO_PAIR"
expect_agent_port hosted-profile-zero-detect 200 "$MODERN_DISCOVER_BODY" \
  "$PROFILE_ZERO_PAIR" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$PROFILE_ZERO_ID/confirm" \
  "$(jq -cn --arg agent "$PROFILE_ZERO_AGENT" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-profile-zero-confirm "expected 201" "$(redacted_body)"
PROFILE_ZERO_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
append_secret_with_derivatives "$PROFILE_ZERO_ACTIVE"
run_sql -c "DELETE FROM agent_profile WHERE workspace_id='$WS' AND agent_member_id='$PROFILE_ZERO_AGENT';"
expect_agent_port hosted-profile-zero-proof 500 "$MODERN_DISCOVER_BODY" \
  "$PROFILE_ZERO_ACTIVE" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (hc.status='detected')::text || ':' || (hc.proved_at IS NULL)::text || ':' || \
  (t.last_used_at IS NULL)::text || ':' || \
  ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id AND a.action='hosted_agent.connection.activated')=0)::text \
  FROM hosted_agent_connection hc JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$PROFILE_ZERO_ID';" | grep -qx 'true:true:true:true' || \
  gate_fail hosted-profile-zero-rollback "zero profile update left partial proof state" "database evidence withheld"
# Expired ledgers are delivery-disabled too. Build a distinct dedicated identity
# so the primary active connection remains available for the audience matrix.
EXPIRED_HANDLE="hosted-expired-${RUN_ID:0:8}"
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "$EXPIRED_HANDLE" '{displayName:"Hosted Expired",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-expired-create "expected 201" "$(redacted_body)"
EXPIRED_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
EXPIRED_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
run_sql -c "UPDATE hosted_agent_connection SET status='expired',pairing_expires_at=now()-interval '1 second',updated_at=now() WHERE workspace_id='$WS' AND id='$EXPIRED_CONNECTION_ID'; \
 INSERT INTO membership(workspace_id,channel_id,member_id,role) VALUES ('$WS','$GENERAL_CHANNEL_ID','$EXPIRED_AGENT_ID','member') ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL;"
assert_hosted_mention_disabled expired "$EXPIRED_HANDLE" "$EXPIRED_AGENT_ID"
assert_hosted_resume_denied expired "$EXPIRED_AGENT_ID"
# Make every pre-existing run eligibility predicate explicit. The API-created
# dedicated identity remains the subject; this only removes fixture ambiguity.
run_sql -c "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES ('$WS','$HOSTED_AGENT_ID','member') ON CONFLICT (workspace_id,member_id) DO NOTHING; \
  INSERT INTO membership(workspace_id,channel_id,member_id,role) VALUES ('$WS','$GENERAL_CHANNEL_ID','$HOSTED_AGENT_ID','member') \
  ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at=NULL; \
  UPDATE member SET status='active',deleted_at=NULL WHERE workspace_id='$WS' AND id='$HOSTED_AGENT_ID'; \
  UPDATE agent_profile SET paused=false WHERE workspace_id='$WS' AND agent_member_id='$HOSTED_AGENT_ID';"
# The connection ledger, never mutable sentinel strings, is the delivery
# authority. Corrupting both sentinel columns must not bypass the route guard.
run_sql -c "ALTER TABLE hosted_agent_connection DISABLE TRIGGER hosted_agent_connection_sentinel_guard; \
  UPDATE agent SET model='mutated-hosted-sentinel',base_url='https://mutated.invalid/v1' WHERE workspace_id='$WS' AND member_id='$HOSTED_AGENT_ID'; \
  ALTER TABLE hosted_agent_connection ENABLE TRIGGER hosted_agent_connection_sentinel_guard;"
HOSTED_RUN_CLIENT_ID="$(lower_uuid)"
HOSTED_RUN_BEFORE="$(run_sql -Atc "SELECT count(*) FROM agent_run WHERE workspace_id='$WS';")"
HOSTED_OUTBOX_BEFORE="$(run_sql -Atc "SELECT count(*) FROM outbox WHERE workspace_id='$WS';")"
HOSTED_JOB_BEFORE="$(run_sql -Atc "SELECT count(*) FROM outbox WHERE workspace_id='$WS' AND kind='agent_job';")"
HOSTED_MESSAGE_BEFORE="$(run_sql -Atc "SELECT count(*) FROM message WHERE workspace_id='$WS';")"
api post "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/agent-runs" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" --arg client "$HOSTED_RUN_CLIENT_ID" '{agent_member_id:$agent,client_run_id:$client,input:{type:"work",title:"deny hosted",brief:"must not enqueue"}}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-run-denied "expected HTTP 409, got $RESPONSE_STATUS" "$(redacted_body)"
run_sql -Atc "SELECT ((SELECT count(*) FROM agent_run WHERE workspace_id='$WS')=$HOSTED_RUN_BEFORE)::text || ':' || \
  ((SELECT count(*) FROM outbox WHERE workspace_id='$WS')=$HOSTED_OUTBOX_BEFORE)::text || ':' || \
  ((SELECT count(*) FROM outbox WHERE workspace_id='$WS' AND kind='agent_job')=$HOSTED_JOB_BEFORE)::text || ':' || \
  ((SELECT count(*) FROM message WHERE workspace_id='$WS')=$HOSTED_MESSAGE_BEFORE)::text;" | grep -qx 'true:true:true:true' || \
  gate_fail hosted-agent-run-zero-partial "hosted run changed run/job/outbox/message counts" "database evidence withheld"
run_sql -c "UPDATE agent SET model='hosted-agent',base_url='https://hosted-agent.invalid/disabled' WHERE workspace_id='$WS' AND member_id='$HOSTED_AGENT_ID';"

GATEWAY_DUMMY_ID="$(lower_uuid)"
GATEWAY_AUDIT_BEFORE="$(run_sql -Atc "SELECT count(*) FROM audit_log WHERE workspace_id='$WS';")"
api get "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/gateway/jobs/pending" "" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-gateway-pending-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/gateway/jobs/1/lease/renew" \
  "$(jq -cn --arg lease "$GATEWAY_DUMMY_ID" '{job_id:1,lease_id:$lease}')" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-gateway-lease-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
api post "/v1/workspaces/$WS/agent-runs/$GATEWAY_DUMMY_ID/gateway/events" \
  "$(jq -cn --arg event "$GATEWAY_DUMMY_ID" '{event_id:$event,status:"running"}')" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-gateway-event-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
api post "/v1/workspaces/$WS/agent-runs/$GATEWAY_DUMMY_ID/gateway/complete" \
  '{"status":"succeeded","body":"must not persist"}' "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-gateway-complete-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
run_sql -Atc "SELECT ((SELECT count(*) FROM agent_run WHERE workspace_id='$WS')=$HOSTED_RUN_BEFORE)::text || ':' || \
 ((SELECT count(*) FROM outbox WHERE workspace_id='$WS')=$HOSTED_OUTBOX_BEFORE)::text || ':' || \
 ((SELECT count(*) FROM message WHERE workspace_id='$WS')=$HOSTED_MESSAGE_BEFORE)::text || ':' || \
 ((SELECT count(*) FROM audit_log WHERE workspace_id='$WS')=$GATEWAY_AUDIT_BEFORE)::text;" | grep -qx 'true:true:true:true' || \
 gate_fail hosted-gateway-zero-partial "gateway negative matrix changed durable state/audit cardinality" "database evidence withheld"
HOSTED_CLAIM_OUTBOX_ID="$(run_sql -Atc "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
 VALUES ('$WS','agent_job','pending','gateway',jsonb_build_object('agent_member_id','$HOSTED_AGENT_ID'),'$HOSTED_AGENT_ID') RETURNING id;")"
# Exercise the real gateway route and therefore claim_gateway_jobs_in_tx with
# the legacy process credential. The hosted row must stay pending/unleased; a
# copied eligibility predicate is not accepted as runtime evidence.
(umask 077
 printf 'header = "X-Momo-Agent-Gateway-Secret: %s"\n' "$GATEWAY_SECRET" >"$CONCURRENT_DIR/gateway-secret.auth"
 curl -sS -o "$CONCURRENT_DIR/gateway-claim.response" -w '%{http_code}' \
   --config "$CONCURRENT_DIR/gateway-secret.auth" \
   "$BASE_URL/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/gateway/jobs/pending" \
   >"$CONCURRENT_DIR/gateway-claim.status")
[ "$(cat "$CONCURRENT_DIR/gateway-claim.status")" = "200" ] || \
  gate_fail hosted-claim-defense "legacy gateway claim did not reach the real claim route" "response withheld"
jq -e '.jobs == []' "$CONCURRENT_DIR/gateway-claim.response" >/dev/null || \
  gate_fail hosted-claim-defense "real gateway claim admitted a hosted job" "response withheld"
run_sql -Atc "SELECT (status='pending')::text || ':' || (lease_owner IS NULL)::text || ':' || \
  (lease_acquired_at IS NULL)::text || ':' || (lease_expires_at IS NULL)::text \
  FROM outbox WHERE workspace_id='$WS' AND id=$HOSTED_CLAIM_OUTBOX_ID;" | \
 grep -qx 'true:true:true:true' || gate_fail hosted-claim-defense "real gateway claim mutated hosted job lease" "database evidence withheld"
run_sql -c "DELETE FROM outbox WHERE workspace_id='$WS' AND id=$HOSTED_CLAIM_OUTBOX_ID;"
HOSTED_CLASSIFICATION_BEFORE="$(run_sql -Atc "SELECT COALESCE(last_used_at::text,'') || ':' || \
  (SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND via_token_id='$HOSTED_ACTIVE_ID')::text \
  FROM token WHERE workspace_id='$WS' AND id='$HOSTED_ACTIVE_ID';")"
api post "/v1/auth/realtime-token" "" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || \
  gate_fail hosted-agent-generic-rest-denied "expected HTTP 403, got $RESPONSE_STATUS" "$(redacted_body)"
HOSTED_FORBIDDEN_MESSAGE_ID="$(lower_uuid)"
api post "/v1/workspaces/$WS/channels/$GENERAL_CHANNEL_ID/messages" \
  "$(jq -cn --arg id "$(lower_uuid)" '{clientMsgId:$id,body:"must not persist"}')" "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-agent-message-post-denied "hosted bearer reached message POST" "$(redacted_body)"
api patch "/v1/workspaces/$WS/messages/$HOSTED_FORBIDDEN_MESSAGE_ID" \
  '{"body":"must not persist"}' "$HOSTED_ACTIVE"
[ "$RESPONSE_STATUS" = "403" ] || gate_fail hosted-agent-message-patch-denied "hosted bearer reached message PATCH" "$(redacted_body)"
HOSTED_CLASSIFICATION_AFTER="$(run_sql -Atc "SELECT COALESCE(last_used_at::text,'') || ':' || \
  (SELECT count(*) FROM audit_log WHERE workspace_id='$WS' AND via_token_id='$HOSTED_ACTIVE_ID')::text \
  FROM token WHERE workspace_id='$WS' AND id='$HOSTED_ACTIVE_ID';")"
[ "$HOSTED_CLASSIFICATION_AFTER" = "$HOSTED_CLASSIFICATION_BEFORE" ] || \
  gate_fail hosted-classification-select-only "closed generic routes touched hosted last_used/audit" "database evidence withheld"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-agent-confirm-replay-denied "expected HTTP 409, got $RESPONSE_STATUS" "$(redacted_body)"
api post "/v1/workspaces/$WS/hosted-agent-connections/$HOSTED_CONNECTION_ID/pairing-challenge/regenerate" "" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-regenerate-active "active regenerate was not 409" "$(redacted_body)"
ABSENT_HOSTED_CONNECTION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
api post "/v1/workspaces/$WS/hosted-agent-connections/$ABSENT_HOSTED_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$HOSTED_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "404" ] || gate_fail hosted-agent-confirm-absent "absent confirm was not 404" "$(redacted_body)"

# Actual HTTP concurrency: two confirmations race on one detected row. Each
# worker owns private 0600 config/body/response/status files, so neither bearer
# nor one-time response can enter argv or another worker's scratch.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-race-$RUN_EPOCH" '{displayName:"Hosted Race",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-race-create "expected 201" "$(redacted_body)"
RACE_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
RACE_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
RACE_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$RACE_PAIRING"
expect_agent_port hosted-race-detect 200 "$MODERN_DISCOVER_BODY" \
  "$RACE_PAIRING" "2026-07-28" "server/discover"

concurrent_confirm() {
  local worker="$1" auth="$CONCURRENT_DIR/$1.auth" body="$CONCURRENT_DIR/$1.body"
  local response="$CONCURRENT_DIR/$1.response" headers="$CONCURRENT_DIR/$1.headers"
  local status="$CONCURRENT_DIR/$1.status"
  (umask 077
   printf 'header = "Authorization: Bearer %s"\n' "$ACCESS" >"$auth"
   jq -cn --arg agent "$RACE_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}' >"$body"
   curl -sS -o "$response" -D "$headers" -w '%{http_code}' -X POST \
     -H 'Content-Type: application/json' --config "$auth" --data-binary "@$body" \
     "$BASE_URL/v1/workspaces/$WS/hosted-agent-connections/$RACE_CONNECTION_ID/confirm" >"$status")
}
concurrent_confirm one & confirm_one_pid=$!
concurrent_confirm two & confirm_two_pid=$!
wait "$confirm_one_pid"; wait "$confirm_two_pid"
confirm_statuses="$(sort "$CONCURRENT_DIR/one.status" "$CONCURRENT_DIR/two.status" | tr '\n' ' ')"
[ "$confirm_statuses" = "201 409 " ] || \
  gate_fail hosted-race-confirm "expected one 201 and one 409, got $confirm_statuses" "responses withheld"
RACE_ACTIVE="$(for response in "$CONCURRENT_DIR"/*.response; do jq -er '.credential // empty' "$response" 2>/dev/null || true; done)"
[ "$(printf '%s\n' "$RACE_ACTIVE" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" ] || \
  gate_fail hosted-race-confirm-secret "expected exactly one active bearer" "responses withheld"
require_private_envelope "$RACE_ACTIVE" momo_agent_v1
append_secret_with_derivatives "$RACE_ACTIVE"
run_sql -Atc "SELECT (count(DISTINCT t.id) = 1)::text || ':' || \
  (count(*) FILTER (WHERE action = 'hosted_agent.connection.confirmed') = 1)::text \
  FROM token t LEFT JOIN audit_log a ON a.workspace_id=t.workspace_id \
    AND a.target_id=t.hosted_connection_id \
  WHERE t.workspace_id='$WS' AND t.hosted_connection_id='$RACE_CONNECTION_ID' \
    AND t.credential_class='hosted_active';" | grep -qx 'true:true' || \
  gate_fail hosted-race-confirm-db "confirm did not create exactly one bearer/audit" "database evidence withheld"

# Two proof calls race on the same active bearer. Both may receive the normal
# foundation response after serialization, but only one transition/unpause and
# one proved timestamp/audit outcome may exist.
parallel_agent_port() {
  local worker="$1" auth="$CONCURRENT_DIR/proof-$1.auth" body="$CONCURRENT_DIR/proof-$1.body"
  local response="$CONCURRENT_DIR/proof-$1.response" status="$CONCURRENT_DIR/proof-$1.status"
  (umask 077
   printf 'header = "Authorization: Bearer %s"\n' "$RACE_ACTIVE" >"$auth"
   printf '%s' "$MODERN_DISCOVER_BODY" >"$body"
   curl -sS -o "$response" -w '%{http_code}' -X POST \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
     --config "$auth" --data-binary "@$body" "$BASE_URL/v1/mcp/agent-port" >"$status")
}
parallel_agent_port one & proof_one_pid=$!
parallel_agent_port two & proof_two_pid=$!
wait "$proof_one_pid"; wait "$proof_two_pid"
proof_statuses="$(sort "$CONCURRENT_DIR/proof-one.status" "$CONCURRENT_DIR/proof-two.status" | tr '\n' ' ')"
[ "$proof_statuses" = "200 200 " ] || \
  gate_fail hosted-race-proof "concurrent proofs returned unexpected statuses: $proof_statuses" "responses withheld"
run_sql -Atc "SELECT (hc.status='active')::text || ':' || (NOT ap.paused)::text || ':' || \
  (ap.version = 2)::text || ':' || (hc.proved_at IS NOT NULL)::text || ':' || \
  ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id \
     AND a.target_id=hc.id AND a.action='hosted_agent.connection.activated') = 1)::text \
  FROM hosted_agent_connection hc JOIN agent_profile ap \
    ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$RACE_CONNECTION_ID';" | grep -qx 'true:true:true:true:true' || \
  gate_fail hosted-race-proof-db "proof was not exactly-one active/unpause transition" "database evidence withheld"

# Inject the activation-audit failure at the database boundary. Because proof,
# unpause, status, last_used and audit share one tenant transaction, the HTTP
# 500 must leave every transition column untouched and zero partial audit rows.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-rollback-$RUN_EPOCH" '{displayName:"Hosted Rollback",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-rollback-create "expected 201" "$(redacted_body)"
ROLLBACK_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
ROLLBACK_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
ROLLBACK_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$ROLLBACK_PAIRING"
expect_agent_port hosted-rollback-detect 200 "$MODERN_DISCOVER_BODY" \
  "$ROLLBACK_PAIRING" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$ROLLBACK_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$ROLLBACK_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-rollback-confirm "expected 201" "$(redacted_body)"
ROLLBACK_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
append_secret_with_derivatives "$ROLLBACK_ACTIVE"
run_sql <<'SQL'
CREATE OR REPLACE FUNCTION test_fail_hosted_activation_audit() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action = 'hosted_agent.connection.activated' THEN
    RAISE EXCEPTION 'injected hosted activation audit failure';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS test_fail_hosted_activation_audit ON audit_log;
CREATE TRIGGER test_fail_hosted_activation_audit BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION test_fail_hosted_activation_audit();
SQL
expect_agent_port hosted-rollback-proof 500 "$MODERN_DISCOVER_BODY" \
  "$ROLLBACK_ACTIVE" "2026-07-28" "server/discover"
run_sql -Atc "SELECT (hc.status='detected')::text || ':' || ap.paused::text || ':' || \
  (hc.proved_at IS NULL)::text || ':' || (t.last_used_at IS NULL)::text || ':' || \
  ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id \
     AND a.target_id=hc.id AND a.action='hosted_agent.connection.activated') = 0)::text \
  FROM hosted_agent_connection hc JOIN agent_profile ap \
    ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$ROLLBACK_CONNECTION_ID';" | \
  grep -qx 'true:true:true:true:true' || \
  gate_fail hosted-rollback-zero-partial "failed proof left partial state" "database evidence withheld"
run_sql -c "DROP TRIGGER test_fail_hosted_activation_audit ON audit_log; DROP FUNCTION test_fail_hosted_activation_audit();"

# A competing authority mutation that obtains its row lock first must make the
# blocked proof fail closed. No touch/unpause/activation/audit is allowed after
# either token revocation or workspace-membership removal wins the race.
for authority_loss in revoke membership; do
  api post "/v1/workspaces/$WS/hosted-agent-connections" \
    "$(jq -cn --arg h "ha-$authority_loss-${RUN_ID:0:8}" '{displayName:"Hosted Authority Race",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-authority-create "expected 201" "$(redacted_body)"
  AUTHORITY_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
  AUTHORITY_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
  AUTHORITY_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
  append_secret_with_derivatives "$AUTHORITY_PAIRING"
  expect_agent_port "hosted-authority-$authority_loss-detect" 200 "$MODERN_DISCOVER_BODY" \
    "$AUTHORITY_PAIRING" "2026-07-28" "server/discover"
  api post "/v1/workspaces/$WS/hosted-agent-connections/$AUTHORITY_CONNECTION_ID/confirm" \
    "$(jq -cn --arg agent "$AUTHORITY_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-authority-confirm "expected 201" "$(redacted_body)"
  AUTHORITY_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
  AUTHORITY_TOKEN_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credentialId')"
  append_secret_with_derivatives "$AUTHORITY_ACTIVE"
  if [ "$authority_loss" = revoke ]; then AUTHORITY_LOCK_KEY=1; else AUTHORITY_LOCK_KEY=2; fi
  AUTHORITY_FIFO="$CONCURRENT_DIR/authority-$authority_loss.fifo"
  mkfifo "$AUTHORITY_FIFO"
  ( { printf '%s\n' "SELECT pg_advisory_lock(1364, $AUTHORITY_LOCK_KEY);";
      cat "$AUTHORITY_FIFO"; } | run_sql >/dev/null ) & authority_holder_pid=$!
  for _ in $(seq 1 500); do
    [ "$(run_sql -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1364 AND objid=$AUTHORITY_LOCK_KEY AND granted;")" = 1 ] && break
    sleep 0.02
  done
  [ "$(run_sql -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1364 AND objid=$AUTHORITY_LOCK_KEY AND granted;")" = 1 ] || gate_fail "hosted-authority-$authority_loss-holder" "advisory holder did not signal readiness" "database evidence withheld"
  if [ "$authority_loss" = "revoke" ]; then
    authority_mutation="UPDATE token SET revoked_at=now() WHERE workspace_id='$WS' AND id='$AUTHORITY_TOKEN_ID';"
  else
    authority_mutation="DELETE FROM workspace_membership WHERE workspace_id='$WS' AND member_id='$AUTHORITY_AGENT_ID';"
  fi
  (run_sql >/dev/null <<SQL
BEGIN;
SET LOCAL app.workspace_id='$WS';
$authority_mutation
SELECT pg_advisory_xact_lock(1364, $AUTHORITY_LOCK_KEY);
COMMIT;
SQL
  ) & authority_pid=$!
  for _ in $(seq 1 500); do
    [ "$(run_sql -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1364 AND objid=$AUTHORITY_LOCK_KEY AND NOT granted;")" = 1 ] && break
    sleep 0.02
  done
  [ "$(run_sql -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1364 AND objid=$AUTHORITY_LOCK_KEY AND NOT granted;")" = 1 ] || gate_fail "hosted-authority-$authority_loss-mutation" "row-lock owner did not signal readiness" "database evidence withheld"
  (expect_agent_port "hosted-authority-$authority_loss-proof-denied" 401 "$MODERN_DISCOVER_BODY" \
    "$AUTHORITY_ACTIVE" "2026-07-28" "server/discover") & authority_proof_pid=$!
  authority_proof_blocked=0
  for _ in $(seq 1 500); do
    kill -0 "$authority_proof_pid" 2>/dev/null || break
    if [ "$(run_sql -Atc "SELECT count(*) FROM pg_stat_activity WHERE usename='momo_app' AND state='active' AND wait_event_type='Lock';")" -ge 1 ]; then
      authority_proof_blocked=1
      break
    fi
    sleep 0.02
  done
  if [ "$authority_proof_blocked" -ne 1 ] || ! kill -0 "$authority_proof_pid" 2>/dev/null; then
    gate_fail "hosted-authority-$authority_loss-proof-barrier" \
      "proof process was not observably blocked behind the authority row lock" \
      "database evidence withheld"
  fi
  printf '%s\n' "SELECT pg_advisory_unlock(1364, $AUTHORITY_LOCK_KEY);" '\q' >"$AUTHORITY_FIFO"
  wait "$authority_pid"
  wait "$authority_holder_pid"
  wait "$authority_proof_pid"
  run_sql -Atc "SELECT (hc.status='expired')::text || ':' || ap.paused::text || ':' || \
    (hc.proved_at IS NULL)::text || ':' || (hc.active_token_id IS NULL)::text || ':' || \
    (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text || ':' || \
    ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id \
      AND a.action='hosted_agent.connection.activated')=0)::text \
    FROM hosted_agent_connection hc JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
    WHERE hc.workspace_id='$WS' AND hc.id='$AUTHORITY_CONNECTION_ID';" | grep -qx 'true:true:true:true:true:true' || \
    gate_fail "hosted-authority-$authority_loss-zero-partial" "authority loss left partial proof state" "database evidence withheld"
done

# Regenerate and detection race on the old challenge. Regenerate is the sole
# surviving authority regardless of lock order: final state is pending under a
# new hash, and the old challenge can no longer authenticate.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-redetect-$RUN_EPOCH" '{displayName:"Hosted Redetect",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-redetect-create "expected 201" "$(redacted_body)"
REDETECT_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
REDETECT_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
require_private_envelope "$REDETECT_PAIRING" momo_pair_v1
append_secret_with_derivatives "$REDETECT_PAIRING"
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$REDETECT_PAIRING" >"$CONCURRENT_DIR/redetect.auth"
 printf '%s' "$MODERN_DISCOVER_BODY" >"$CONCURRENT_DIR/redetect.body"
 curl -sS -o "$CONCURRENT_DIR/redetect.response" -w '%{http_code}' -X POST \
   -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
   -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
   --config "$CONCURRENT_DIR/redetect.auth" --data-binary "@$CONCURRENT_DIR/redetect.body" \
   "$BASE_URL/v1/mcp/agent-port" >"$CONCURRENT_DIR/redetect.status") & redetect_pid=$!
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$ACCESS" >"$CONCURRENT_DIR/regenerate.auth"
 curl -sS -o "$CONCURRENT_DIR/regenerate.response" -w '%{http_code}' -X POST \
   -H 'Content-Type: application/json' --config "$CONCURRENT_DIR/regenerate.auth" \
   "$BASE_URL/v1/workspaces/$WS/hosted-agent-connections/$REDETECT_CONNECTION_ID/pairing-challenge/regenerate" \
   >"$CONCURRENT_DIR/regenerate.status") & regenerate_pid=$!
wait "$redetect_pid"; wait "$regenerate_pid"
[ "$(cat "$CONCURRENT_DIR/regenerate.status")" = "200" ] || \
  gate_fail hosted-redetect-regenerate "regenerate lost its serialized outcome" "response withheld"
case "$(cat "$CONCURRENT_DIR/redetect.status")" in 200|401) ;; *)
  gate_fail hosted-redetect-detect "detect returned an unexpected race outcome" "response withheld";; esac
api get "/v1/workspaces/$WS/hosted-agent-connections/$REDETECT_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "pairing_pending"' "regenerate wins detect race"
expect_agent_port hosted-redetect-old-pairing-denied 401 "$MODERN_DISCOVER_BODY" \
  "$REDETECT_PAIRING" "2026-07-28" "server/discover"

# Confirm and regenerate race from detected. Regenerate serializes after or
# before confirm, revokes any just-created bearer, and returns the connection to
# pending. Any captured losing active bearer must fail proof.
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-reconfirm-$RUN_EPOCH" '{displayName:"Hosted Reconfirm",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-reconfirm-create "expected 201" "$(redacted_body)"
RECONFIRM_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
RECONFIRM_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
RECONFIRM_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$RECONFIRM_PAIRING"
expect_agent_port hosted-reconfirm-detect 200 "$MODERN_DISCOVER_BODY" \
  "$RECONFIRM_PAIRING" "2026-07-28" "server/discover"
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$ACCESS" >"$CONCURRENT_DIR/reconfirm.auth"
 jq -cn --arg agent "$RECONFIRM_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}' >"$CONCURRENT_DIR/reconfirm.body"
 curl -sS -o "$CONCURRENT_DIR/reconfirm.response" -w '%{http_code}' -X POST \
   -H 'Content-Type: application/json' --config "$CONCURRENT_DIR/reconfirm.auth" \
   --data-binary "@$CONCURRENT_DIR/reconfirm.body" \
   "$BASE_URL/v1/workspaces/$WS/hosted-agent-connections/$RECONFIRM_CONNECTION_ID/confirm" \
   >"$CONCURRENT_DIR/reconfirm.status") & reconfirm_pid=$!
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$ACCESS" >"$CONCURRENT_DIR/rereg.auth"
 curl -sS -o "$CONCURRENT_DIR/rereg.response" -w '%{http_code}' -X POST \
   -H 'Content-Type: application/json' --config "$CONCURRENT_DIR/rereg.auth" \
   "$BASE_URL/v1/workspaces/$WS/hosted-agent-connections/$RECONFIRM_CONNECTION_ID/pairing-challenge/regenerate" \
   >"$CONCURRENT_DIR/rereg.status") & rereg_pid=$!
wait "$reconfirm_pid"; wait "$rereg_pid"
[ "$(cat "$CONCURRENT_DIR/rereg.status")" = "200" ] || \
  gate_fail hosted-reconfirm-regenerate "regenerate lost confirm race" "response withheld"
case "$(cat "$CONCURRENT_DIR/reconfirm.status")" in 201|409) ;; *)
  gate_fail hosted-reconfirm-confirm "confirm returned an unexpected race outcome" "response withheld";; esac
RECONFIRM_ACTIVE="$(jq -er '.credential // empty' "$CONCURRENT_DIR/reconfirm.response" 2>/dev/null || true)"
if [ -n "$RECONFIRM_ACTIVE" ]; then
  require_private_envelope "$RECONFIRM_ACTIVE" momo_agent_v1
  append_secret_with_derivatives "$RECONFIRM_ACTIVE"
  expect_agent_port hosted-reconfirm-proof-denied 401 "$MODERN_DISCOVER_BODY" \
    "$RECONFIRM_ACTIVE" "2026-07-28" "server/discover"
fi
reconfirm_db_state="$(run_sql -Atc "SELECT (hc.status='pairing_pending')::text || ':' || \
  (count(t.id) FILTER (WHERE t.revoked_at IS NULL) = 0)::text \
  FROM hosted_agent_connection hc LEFT JOIN token t \
    ON t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id \
  WHERE hc.workspace_id='$WS' AND hc.id='$RECONFIRM_CONNECTION_ID' GROUP BY hc.status;")"
[ "$reconfirm_db_state" = "true:true" ] || gate_fail hosted-reconfirm-db "race left live authority ($reconfirm_db_state)" "database evidence withheld"

# Proof and regeneration contend from the confirmed/detected state using the
# shared connection->token lock order. Exactly two serialized outcomes are
# valid: proof wins (200/409, active) or regeneration wins (401/200, pending).
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg h "hosted-proof-reg-${RUN_ID:0:8}" '{displayName:"Hosted Proof Regenerate",handle:$h,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-proof-reg-create "expected 201" "$(redacted_body)"
PROOF_REG_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
PROOF_REG_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
PROOF_REG_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$PROOF_REG_PAIRING"
expect_agent_port hosted-proof-reg-detect 200 "$MODERN_DISCOVER_BODY" \
  "$PROOF_REG_PAIRING" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$PROOF_REG_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$PROOF_REG_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-proof-reg-confirm "expected 201" "$(redacted_body)"
PROOF_REG_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
require_private_envelope "$PROOF_REG_ACTIVE" momo_agent_v1
append_secret_with_derivatives "$PROOF_REG_ACTIVE"
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$PROOF_REG_ACTIVE" >"$CONCURRENT_DIR/proof-reg-proof.auth"
 printf '%s' "$MODERN_DISCOVER_BODY" >"$CONCURRENT_DIR/proof-reg-proof.body"
 curl -sS -o "$CONCURRENT_DIR/proof-reg-proof.response" -w '%{http_code}' -X POST \
   -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
   -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: server/discover' \
   --config "$CONCURRENT_DIR/proof-reg-proof.auth" --data-binary "@$CONCURRENT_DIR/proof-reg-proof.body" \
   "$BASE_URL/v1/mcp/agent-port" >"$CONCURRENT_DIR/proof-reg-proof.status") & proof_reg_proof_pid=$!
(umask 077
 printf 'header = "Authorization: Bearer %s"\n' "$ACCESS" >"$CONCURRENT_DIR/proof-reg-admin.auth"
 curl -sS -o "$CONCURRENT_DIR/proof-reg-admin.response" -w '%{http_code}' -X POST \
   --config "$CONCURRENT_DIR/proof-reg-admin.auth" \
   "$BASE_URL/v1/workspaces/$WS/hosted-agent-connections/$PROOF_REG_CONNECTION_ID/pairing-challenge/regenerate" \
   >"$CONCURRENT_DIR/proof-reg-admin.status") & proof_reg_admin_pid=$!
wait "$proof_reg_proof_pid"; wait "$proof_reg_admin_pid"
proof_reg_pair="$(cat "$CONCURRENT_DIR/proof-reg-proof.status"):$(cat "$CONCURRENT_DIR/proof-reg-admin.status")"
case "$proof_reg_pair" in 200:409|401:200) ;; *)
  gate_fail hosted-proof-reg-race "unexpected proof/regenerate outcome $proof_reg_pair" "responses withheld";; esac
case "$proof_reg_pair" in
  200:409) expected_proof_reg='active:true:true' ;;
  401:200) expected_proof_reg='pairing_pending:false:false' ;;
esac
run_sql -Atc "SELECT hc.status::text || ':' || (hc.proved_at IS NOT NULL)::text || ':' || \
  (EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text \
  FROM hosted_agent_connection hc WHERE hc.workspace_id='$WS' AND hc.id='$PROOF_REG_CONNECTION_ID';" | \
  grep -qx "$expected_proof_reg" || gate_fail hosted-proof-reg-db "race state did not match serialized HTTP winner" "database evidence withheld"

# The live-lifecycle uniqueness contract used to be asserted here against a
# terminal state planted by SQL. Migration 072 (#1367) refuses exactly that
# bypass, so the assertion moved to the end of this section, where the HAP-E6
# chain has produced a `disconnected` ledger through the product's own
# transition — which is the state the contract was always about.

# A caller whose JWT is pinned to this workspace receives the same bounded
# denial for a real foreign workspace and a nonexistent one; no connection
# lookup becomes a tenant enumeration oracle.
FOREIGN_WS="$(uuidgen | tr '[:upper:]' '[:lower:]')"
run_sql -Atc "INSERT INTO workspace(id,slug,name) VALUES ('$FOREIGN_WS','foreign-$RUN_EPOCH','foreign');"
api get "/v1/workspaces/$FOREIGN_WS/hosted-agent-connections/$RACE_CONNECTION_ID" "" "$ACCESS"
foreign_status="$RESPONSE_STATUS"; foreign_body="$RESPONSE_BODY"
api get "/v1/workspaces/00000000-0000-0000-0000-000000000001/hosted-agent-connections/$RACE_CONNECTION_ID" "" "$ACCESS"
[ "$foreign_status:$foreign_body" = "$RESPONSE_STATUS:$RESPONSE_BODY" ] || \
  gate_fail hosted-cross-workspace "foreign and absent workspace responses differed" "response withheld"

api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" \
  '{"scopes":["agent:port:connect"]}' "$ACCESS"
if [ "$RESPONSE_STATUS" != "409" ]; then
  gate_fail hosted-agent-generic-credential-denied \
    "expected HTTP 409, got $RESPONSE_STATUS" "$(redacted_body)"
fi
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" \
  '{"scopes":["work:control"]}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-excluded-scope-stable "hosted excluded scope did not return stable 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" \
  '{"scopes":["future:generic:scope"]}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-future-scope-stable "hosted future scope did not return stable 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials/$HOSTED_ACTIVE_ID/revoke" '{}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-generic-revoke-denied "hosted generic revoke was not 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" \
  "$(jq -cn --arg label "$(printf 'x%.0s' {1..300})" '{label:$label}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-malformed-label-stable "hosted malformed label was not 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" '{"expiresAtMs":1}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-past-expiry-stable "hosted past expiry was not 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials" '{"rotationGraceSeconds":999999999}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-bad-grace-stable "hosted bad grace was not 409" "$(redacted_body)"
api post "/v1/workspaces/$WS/agents/$HOSTED_AGENT_ID/credentials/$HOSTED_ACTIVE_ID/revoke" \
  "$(jq -cn --arg reason "$(printf 'r%.0s' {1..2000})" '{reason:$reason}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || gate_fail hosted-agent-bad-reason-stable "hosted bad revoke reason was not 409" "$(redacted_body)"
run_sql -Atc "SELECT count(*) FROM audit_log WHERE workspace_id='$WS' \
  AND subject_member_id='$HOSTED_AGENT_ID' AND action='agent.credential.hosted_managed_denied';" | \
  grep -qx '8' || gate_fail hosted-agent-denial-audit-cardinality "expected eight bounded issue/revoke denial audits" "database evidence withheld"

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
load_private_response_body || {
  echo "[openapi-rust] invalid-accept response secret scan failed; response withheld" >&2
  exit 1
}
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
# HAP-E6 해체 lifecycle (ADR-0162 / #1367, 등재 #1385)
#
# 세 연산이 한 체인으로만 성립한다: disconnect 는 **살아 있는** credential 을
# 회수하는 것이 존재 이유고, acknowledge 는 `cleanup_pending` 에서만 열리며,
# complete 는 required 아티팩트가 전부 resolve 된 뒤에만 열린다. 그래서 여기서
# 전용 identity 를 하나 더 세워 pairing → confirm → proof(active) 까지 올린 다음
# 그것만 해체한다 — 위의 감사/게이트웨이 매트릭스가 쓰는 주 연결을 죽이면 그
# 표본들이 자기 부작용을 읽게 되기 때문이다.
# ---------------------------------------------------------------------------
E6_HANDLE="hosted-e6-${RUN_ID:0:8}"
api post "/v1/workspaces/$WS/hosted-agent-connections" \
  "$(jq -cn --arg handle "$E6_HANDLE" '{displayName:"Hosted Disconnect",handle:$handle,authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-e6-create "expected 201" "$(redacted_body)"
E6_CONNECTION_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.id')"
E6_AGENT_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.connection.agentMemberId')"
E6_PAIRING="$(printf '%s' "$RESPONSE_BODY" | jq -er '.pairingCredential')"
append_secret_with_derivatives "$E6_PAIRING"
expect_agent_port hosted-e6-detect 200 "$MODERN_DISCOVER_BODY" \
  "$E6_PAIRING" "2026-07-28" "server/discover"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/confirm" \
  "$(jq -cn --arg agent "$E6_AGENT_ID" '{agentMemberId:$agent,audience:"/v1/mcp/agent-port",approvedChannelIds:[],approvedScopes:["agent:port:connect"],authMode:"static_bearer"}')" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail hosted-e6-confirm "expected 201" "$(redacted_body)"
E6_ACTIVE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.credential')"
append_secret_with_derivatives "$E6_ACTIVE"
expect_agent_port hosted-e6-proof 200 "$MODERN_DISCOVER_BODY" \
  "$E6_ACTIVE" "2026-07-28" "server/discover"
api get "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID" "" "$ACCESS"
guard_jq '.connection.status == "active" and (.cleanupArtifacts | length) == 0' \
  "an unstarted connection answers with an empty manifest, not a missing one"
# The terminal state has exactly one predecessor. Reaching for it before a
# disconnect ever started must be refused rather than answered vacuously.
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect/complete" "" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-e6-complete-before-start "terminal transition was reachable without a disconnect" "$(redacted_body)"
# Work already handed out is part of the same transaction, so give the identity
# one leased gateway job to lose.
E6_JOB_LEASE="$(lower_uuid)"
E6_JOB_ID="$(run_sql -Atc "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key,lease_owner,lease_acquired_at,lease_expires_at) \
  VALUES ('$WS','agent_job','pending','gateway',jsonb_build_object('agent_member_id','$E6_AGENT_ID'),'$E6_AGENT_ID','$E6_JOB_LEASE',now(),now()+interval '5 minutes') RETURNING id;")"

E6_ARTIFACT_REF="gate-connector-$RUN_EPOCH"
sample hosted-agent-disconnect post \
  "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/disconnect" \
  "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect" 200 \
  "$(jq -cn --arg ref "$E6_ARTIFACT_REF" '{artifacts:[{kind:"connector",externalRef:$ref}]}')" "$ACCESS"
# Six seeded per-kind rows plus the one named item; the only row this server may
# close by itself is the credential it just revoked, and it closes exactly that.
guard_jq --arg ref "$E6_ARTIFACT_REF" '
  .startedNow == true
  and .connection.status == "cleanup_pending"
  and (.connection | has("activeCredentialId") | not)
  and .remainingRequired == 6
  and (.cleanupArtifacts | length) == 7
  and any(.cleanupArtifacts[];
        .kind == "secret" and (has("externalRef") | not)
        and .source == "server_verified" and .resolved == true and .disposition == "revoked")
  and any(.cleanupArtifacts[];
        .kind == "connector" and .externalRef == $ref and .resolved == false)' \
  "the disconnect seeds one row per kind plus the named item and closes only its own credential"
E6_MANIFEST="$(printf '%s' "$RESPONSE_BODY" | jq -c '.cleanupArtifacts')"
run_sql -Atc "SELECT (hc.status='cleanup_pending')::text || ':' || ap.paused::text || ':' || \
  (NOT EXISTS(SELECT 1 FROM token t WHERE t.workspace_id=hc.workspace_id AND t.hosted_connection_id=hc.id AND t.revoked_at IS NULL))::text || ':' || \
  (o.status='done' AND o.lease_owner IS NULL AND o.processed_at IS NOT NULL)::text || ':' || \
  ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id \
     AND a.action='hosted_agent.connection.disconnect_started')=1)::text \
  FROM hosted_agent_connection hc \
  JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  JOIN outbox o ON o.workspace_id=hc.workspace_id AND o.id=$E6_JOB_ID \
  WHERE hc.workspace_id='$WS' AND hc.id='$E6_CONNECTION_ID';" | \
  grep -qx 'true:true:true:true:true' || \
  gate_fail hosted-e6-disconnect-atomic "revoke/pause/suppression/audit did not land as one commit" "database evidence withheld"
expect_agent_port hosted-e6-revoked-denied 401 "$MODERN_DISCOVER_BODY" \
  "$E6_ACTIVE" "2026-07-28" "server/discover"
# A retry answers the same thing and writes nothing — including no second audit.
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect" '{}' "$ACCESS"
[ "$RESPONSE_STATUS" = "200" ] || \
  gate_fail hosted-e6-disconnect-retry "retried disconnect was not 200, got $RESPONSE_STATUS" "$(redacted_body)"
guard_jq '.startedNow == false and .remainingRequired == 6 and (.cleanupArtifacts | length) == 7' \
  "a retried disconnect repeats the answer instead of re-opening the manifest"
run_sql -Atc "SELECT (count(*)=1)::text FROM audit_log WHERE workspace_id='$WS' \
  AND target_id='$E6_CONNECTION_ID' AND action='hosted_agent.connection.disconnect_started';" | \
  grep -qx 'true' || gate_fail hosted-e6-disconnect-retry "retried disconnect amplified the audit" "database evidence withheld"

E6_ROUTINE_ARTIFACT="$(printf '%s' "$E6_MANIFEST" | jq -er 'map(select(.kind == "routine")) | .[0].id')"
E6_PLUGIN_ARTIFACT="$(printf '%s' "$E6_MANIFEST" | jq -er 'map(select(.kind == "plugin")) | .[0].id')"
# A decision needs evidence, and the kind decides which decisions are legal.
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$E6_ROUTINE_ARTIFACT/acknowledge" \
  '{"currentStatus":"absent","disposition":"delete"}' "$ACCESS"
[ "$RESPONSE_STATUS" = "400" ] || \
  gate_fail hosted-e6-ack-evidence "a resolution without evidence was accepted" "$(redacted_body)"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$E6_PLUGIN_ARTIFACT/acknowledge" \
  '{"currentStatus":"absent","disposition":"preserve","evidence":"preserve is a bot answer"}' "$ACCESS"
[ "$RESPONSE_STATUS" = "400" ] || \
  gate_fail hosted-e6-ack-disposition "preserve was accepted for a non-bot kind" "$(redacted_body)"
run_sql -Atc "SELECT (count(*)=0)::text FROM hosted_agent_connection_artifact \
  WHERE workspace_id='$WS' AND connection_id='$E6_CONNECTION_ID' AND id IN ('$E6_ROUTINE_ARTIFACT','$E6_PLUGIN_ARTIFACT') \
    AND (resolved OR source IS NOT NULL);" | grep -qx 'true' || \
  gate_fail hosted-e6-ack-refusal-zero-partial "a refused acknowledgement still touched the row" "database evidence withheld"
# #1344 made structural: an inactive routine is an observation. `currentStatus`
# moves, `disposition` does not, and the row stays unresolved and unattributed.
sample hosted-agent-cleanup-acknowledge post \
  "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/cleanup-artifacts/{artifactId}/acknowledge" \
  "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$E6_ROUTINE_ARTIFACT/acknowledge" 200 \
  '{"currentStatus":"inactive"}' "$ACCESS"
guard_jq '.changed == true and .remainingRequired == 6
  and .artifact.currentStatus == "inactive" and .artifact.disposition == "pending"
  and .artifact.resolved == false and (.artifact | has("source") | not)' \
  "switching a routine off is an observation and resolves nothing"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$E6_ROUTINE_ARTIFACT/acknowledge" \
  '{"currentStatus":"inactive"}' "$ACCESS"
[ "$RESPONSE_STATUS" = "200" ] || \
  gate_fail hosted-e6-ack-repeat "repeated observation was not 200, got $RESPONSE_STATUS" "$(redacted_body)"
guard_jq '.changed == false' "the same observation twice writes nothing"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect/complete" "" "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-e6-complete-unresolved "terminal transition ran with an unresolved manifest" "$(redacted_body)"

# Every remaining row is answered on its own: acknowledging `connector` never
# reaches `local_plugin_files`, and the named item is a separate answer again.
while IFS='|' read -r e6_artifact e6_kind; do
  [ -n "$e6_artifact" ] || continue
  case "$e6_kind" in
    bot) e6_disposition="preserve"; e6_observed="present" ;;
    secret) e6_disposition="revoke"; e6_observed="absent" ;;
    *) e6_disposition="delete"; e6_observed="absent" ;;
  esac
  api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$e6_artifact/acknowledge" \
    "$(jq -cn --arg observed "$e6_observed" --arg disposition "$e6_disposition" \
        --arg evidence "handled in the provider UI during the openapi rust sample pass" \
        '{currentStatus:$observed,disposition:$disposition,evidence:$evidence}')" "$ACCESS"
  [ "$RESPONSE_STATUS" = "200" ] || \
    gate_fail hosted-e6-ack "expected HTTP 200 for $e6_kind, got $RESPONSE_STATUS" "$(redacted_body)"
  guard_jq '.artifact.resolved == true' "an acknowledged artifact carries its own resolution"
  if [ "$e6_kind" = "secret" ]; then
    # The one row this server closed itself: a manual replay of the same answer
    # is accepted and changes nothing, least of all the provenance.
    guard_jq '.changed == false and .artifact.source == "server_verified"' \
      "a manual replay cannot promote itself over the server-verified row"
  else
    guard_jq '.changed == true and .artifact.source == "manual"' \
      "a provider-owned artifact resolves as manual with an actor"
  fi
done < <(printf '%s' "$E6_MANIFEST" | jq -r '.[] | "\(.id)|\(.kind)"')
api get "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID" "" "$ACCESS"
guard_jq '(.cleanupArtifacts | length) == 7 and all(.cleanupArtifacts[]; .resolved == true)' \
  "the manifest is fully resolved before the terminal transition is attempted"

sample hosted-agent-disconnect-complete post \
  "/v1/workspaces/{workspaceId}/hosted-agent-connections/{connectionId}/disconnect/complete" \
  "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect/complete" 200 "" "$ACCESS"
guard_jq '.disconnectedNow == true and .connection.status == "disconnected"
  and (.connection | has("activeCredentialId") | not)
  and (.cleanupArtifacts | length) == 7' \
  "the terminal transition carries the manifest it was gated on"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect/complete" "" "$ACCESS"
[ "$RESPONSE_STATUS" = "200" ] || \
  gate_fail hosted-e6-complete-replay "replayed completion was not 200, got $RESPONSE_STATUS" "$(redacted_body)"
guard_jq '.disconnectedNow == false and .connection.status == "disconnected"' \
  "a replayed completion answers the same thing and writes no audit row"
# Terminal is terminal in both directions: nothing restarts and nothing reopens.
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/disconnect" '{}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-e6-disconnect-terminal "a disconnected connection restarted a disconnect" "$(redacted_body)"
api post "/v1/workspaces/$WS/hosted-agent-connections/$E6_CONNECTION_ID/cleanup-artifacts/$E6_ROUTINE_ARTIFACT/acknowledge" \
  '{"currentStatus":"present","evidence":"reopen attempt"}' "$ACCESS"
[ "$RESPONSE_STATUS" = "409" ] || \
  gate_fail hosted-e6-ack-terminal "a disconnected connection accepted a new acknowledgement" "$(redacted_body)"
run_sql -Atc "SELECT (hc.status='disconnected')::text || ':' || ap.paused::text || ':' || \
  (hc.active_token_id IS NULL)::text || ':' || \
  ((SELECT count(*) FROM hosted_agent_connection_artifact x WHERE x.workspace_id=hc.workspace_id \
     AND x.connection_id=hc.id AND x.required AND NOT x.resolved)=0)::text || ':' || \
  ((SELECT count(*) FROM audit_log a WHERE a.workspace_id=hc.workspace_id AND a.target_id=hc.id \
     AND a.action='hosted_agent.connection.disconnected')=1)::text \
  FROM hosted_agent_connection hc \
  JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
  WHERE hc.workspace_id='$WS' AND hc.id='$E6_CONNECTION_ID';" | \
  grep -qx 'true:true:true:true:true' || \
  gate_fail hosted-e6-terminal-state "the terminal state or its audit cardinality is not what the transition claims" "database evidence withheld"

# The identity uniqueness contract is live-lifecycle scoped: a disconnected
# ledger may reconnect, while a second simultaneous live ledger is rejected.
# The terminal ledger is the one the operation above actually produced — before
# #1367 this fixture minted `disconnected` with a bare UPDATE, which migration
# 072's guard now refuses precisely because a repair script must not be able to.
RECONNECT_NEW_ID="$(lower_uuid)"
RECONNECT_DUP_ID="$(lower_uuid)"
run_sql -c "INSERT INTO hosted_agent_connection(id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at,created_by) \
 VALUES ('$RECONNECT_NEW_ID','$WS','$E6_AGENT_ID','pairing_pending',digest('reconnect-live','sha256'),now()+interval '1 hour','$GATE_MEMBER_ID');"
set +e
run_sql -c "INSERT INTO hosted_agent_connection(id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at,created_by) \
 VALUES ('$RECONNECT_DUP_ID','$WS','$E6_AGENT_ID','pairing_pending',digest('duplicate-live','sha256'),now()+interval '1 hour','$GATE_MEMBER_ID');" >/dev/null 2>&1
duplicate_live_rc=$?
set -e
[ "$duplicate_live_rc" -ne 0 ] || gate_fail hosted-live-unique "second live connection for one agent succeeded" "database evidence withheld"
run_sql -Atc "SELECT \
 ((SELECT count(*) FROM hosted_agent_connection WHERE workspace_id='$WS' AND agent_member_id='$E6_AGENT_ID' AND status='disconnected')=1)::text || ':' || \
 ((SELECT count(*) FROM hosted_agent_connection WHERE workspace_id='$WS' AND agent_member_id='$E6_AGENT_ID' AND status NOT IN ('expired','disconnected'))=1)::text || ':' || \
 ((SELECT count(*) FROM hosted_agent_connection WHERE id='$RECONNECT_DUP_ID')=0)::text;" | \
 grep -qx 'true:true:true' || gate_fail hosted-live-unique "partial live uniqueness state mismatch" "database evidence withheld"

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
# 허들 — LiveKit media server 없이도 lifecycle + grant 응답 모양은 완결된다.
# 실제 grant 수용은 scripts/verify_huddle_livekit.sh가 pinned server로 잇는다.
# ---------------------------------------------------------------------------
sample huddle-start post \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/huddles" \
  "/v1/workspaces/$WS/channels/$GATE_CHANNEL_ID/huddles" 201 "" "$ACCESS"
HUDDLE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.huddle.id')"
canonical_uuid "$HUDDLE_ID" || {
  echo "[openapi-rust] candidate returned a non-canonical huddle id" >&2
  exit 1
}
guard_jq --arg ch "$GATE_CHANNEL_ID" \
  '(.huddle.channelId | ascii_downcase) == ($ch | ascii_downcase)
   and .huddle.participants == []' \
  "new huddle belongs to the channel and starts empty"

sample huddle-active get \
  "/v1/workspaces/{workspaceId}/channels/{channelId}/huddles/active" \
  "/v1/workspaces/$WS/channels/$GATE_CHANNEL_ID/huddles/active" 200 "" "$ACCESS"
guard_jq --arg id "$HUDDLE_ID" \
  '(.huddle.id | ascii_downcase) == ($id | ascii_downcase)' \
  "active projection returns the started huddle"

sample huddle-join post "/v1/workspaces/{workspaceId}/huddles/{huddleId}/join" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/join" 200 "" "$ACCESS"
guard_jq --arg id "$GATE_MEMBER_ID" '
  .ttlSeconds == 600 and (.token | type == "string")
  and (.expiresAtMs | type == "number")
  and any(.huddle.participants[]; (.memberId | ascii_downcase) == $id)' \
  "join returns the current participant and a ten-minute grant"

sample huddle-leave post "/v1/workspaces/{workspaceId}/huddles/{huddleId}/leave" \
  "/v1/workspaces/$WS/huddles/$HUDDLE_ID/leave" 200 "" "$ACCESS"
guard_jq '.ended == true and (.huddle.endedAtMs | type == "number")' \
  "last leave atomically ends the huddle"

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

# ---------------------------------------------------------------------------
# 초대 admin (#1769) — create/list/status/revoke/regenerate/redeem
# 원문 코드는 needle 등록 후에만 표본으로 남긴다.
# ---------------------------------------------------------------------------
register_invite_code() {
  local raw
  raw="$(printf '%s' "$RESPONSE_BODY" | jq -er '.code // empty')" || return 1
  [ -n "$raw" ] || return 1
  append_secret_with_derivatives "$raw"
}

api post "/v1/workspaces/$WS/invites" '{"role":"member","maxUses":3}' "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail invite-create "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
register_invite_code || {
  echo "[openapi-rust] invite create omitted a one-time code" >&2
  exit 1
}
INVITE_ADMIN_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.invite.id')"
canonical_uuid "$INVITE_ADMIN_ID" || {
  echo "[openapi-rust] invite create omitted a canonical id" >&2
  exit 1
}
record_sample invite-create post "/v1/workspaces/{workspaceId}/invites" 201
guard_jq --arg id "$INVITE_ADMIN_ID" '
  (.invite.id | ascii_downcase) == ($id | ascii_downcase)
  and (.code | type == "string")
  and (has("codeHash") | not)' \
  "invite create returns metadata plus a one-time code"

sample invite-list get "/v1/workspaces/{workspaceId}/invites" \
  "/v1/workspaces/$WS/invites?limit=20" 200 "" "$ACCESS"
guard_jq --arg id "$INVITE_ADMIN_ID" '
  any(.invites[]; (.id | ascii_downcase) == ($id | ascii_downcase))
  and (tostring | test("\"code\"") | not)' \
  "invite list is preview-only"

sample invite-get get "/v1/workspaces/{workspaceId}/invites/{inviteId}" \
  "/v1/workspaces/$WS/invites/$INVITE_ADMIN_ID" 200 "" "$ACCESS"
guard_jq --arg id "$INVITE_ADMIN_ID" '
  (.invite.id | ascii_downcase) == ($id | ascii_downcase)
  and (.redemptions | type == "array")
  and (has("code") | not) and (.invite | has("code") | not)' \
  "invite status is metadata plus redemptions"

api post "/v1/workspaces/$WS/invites/$INVITE_ADMIN_ID/regenerate" "" "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail invite-regenerate "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
register_invite_code || {
  echo "[openapi-rust] invite regenerate omitted a one-time code" >&2
  exit 1
}
INVITE_REGEN_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.invite.id')"
record_sample invite-regenerate post \
  "/v1/workspaces/{workspaceId}/invites/{inviteId}/regenerate" 201

api post "/v1/workspaces/$WS/invites" '{"role":"member","maxUses":1}' "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail invite-revoke-fixture "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
register_invite_code || exit 1
INVITE_REVOKE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.invite.id')"
sample invite-revoke post "/v1/workspaces/{workspaceId}/invites/{inviteId}/revoke" \
  "/v1/workspaces/$WS/invites/$INVITE_REVOKE_ID/revoke" 200 \
  '{"reason":"openapi rust gate"}' "$ACCESS"
guard_jq '.revokedAtMs != null and .revocationReason == "openapi rust gate"' \
  "POST revoke stamps revokedAtMs"

api post "/v1/workspaces/$WS/invites" '{"role":"guest","maxUses":1}' "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail invite-delete-fixture "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
register_invite_code || exit 1
INVITE_DELETE_ID="$(printf '%s' "$RESPONSE_BODY" | jq -er '.invite.id')"
sample invite-delete delete "/v1/workspaces/{workspaceId}/invites/{inviteId}" \
  "/v1/workspaces/$WS/invites/$INVITE_DELETE_ID" 200 "" "$ACCESS"
guard_jq '.revokedAtMs != null' "DELETE revoke stamps revokedAtMs"

api post "/v1/workspaces/$WS/invites" '{"role":"member","maxUses":2}' "$ACCESS"
[ "$RESPONSE_STATUS" = "201" ] || gate_fail invite-redeem-fixture "expected HTTP 201, got $RESPONSE_STATUS" "$(redacted_body)"
INVITE_REDEEM_CODE="$(printf '%s' "$RESPONSE_BODY" | jq -er '.code')"
register_invite_code || exit 1
INVITE_REDEEM_FILE="$TMP_DIR/invite-redeem-code.txt"
(umask 077; : >"$INVITE_REDEEM_FILE")
register_secret_file "$INVITE_REDEEM_FILE"
printf '%s' "$INVITE_REDEEM_CODE" >"$INVITE_REDEEM_FILE"
sample invite-redeem post "/v1/workspaces/{workspaceId}/invites/redeem" \
  "/v1/workspaces/$WS/invites/redeem" 200 \
  "$(jq -cn --rawfile c "$INVITE_REDEEM_FILE" '{code:$c}')" "$ACCESS"
guard_jq '
  (.redemptionId | type == "string")
  and (.invite.usedCount == 1)
  and (.invite | has("code") | not)' \
  "member redeem increments usedCount and never echoes the code"

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

# Revoke only after Agent Port and work-control have consumed the credential.
# Replay stays 200 and must not create a second revoke audit.
sample agent-credential-revoke post \
  "/v1/workspaces/{workspaceId}/agents/{agentId}/credentials/{credentialId}/revoke" \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials/$GATE_AGENT_CREDENTIAL_ID/revoke" \
  200 '{"reason":"openapi rust gate complete"}' "$ACCESS"
guard_jq '.revokedNow == true and .alreadyRevoked == false
  and .credential.status == "revoked"
  and (tostring | contains("momo_agent_v1.") | not)' \
  "first credential revoke is metadata-only and records the transition"
expect agent-credential-revoke-replay post \
  "/v1/workspaces/$WS/agents/$GATE_AGENT_ID/credentials/$GATE_AGENT_CREDENTIAL_ID/revoke" \
  200 '{"reason":"openapi rust gate complete"}' "$ACCESS"
guard_jq '.revokedNow == false and .alreadyRevoked == true' \
  "credential revoke replay is idempotent"

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
# Concurrent HTTP scratch contains one-time credentials by construction. Adopt
# every exact regular file into the existing immutable-identity cleanup ledger,
# then delete only those registered files before retained-evidence scanning.
if [ -d "${CONCURRENT_DIR:-}" ] && [ ! -L "$CONCURRENT_DIR" ]; then
  while IFS= read -r concurrency_secret; do
    register_secret_file "$concurrency_secret" || {
      echo "[openapi-rust] FAIL concurrent scratch ownership changed before cleanup" >&2
      exit 1
    }
    concurrency_secret_index=$((${#SECRET_FILES[@]} - 1))
    [ "$(file_identity "$concurrency_secret")" = "${SECRET_IDENTITIES[$concurrency_secret_index]}" ] || {
      echo "[openapi-rust] FAIL concurrent scratch identity changed before cleanup" >&2
      exit 1
    }
    rm -f -- "$concurrency_secret"
  done < <(find "$CONCURRENT_DIR" -type f -maxdepth 1 -print)
fi

for request_secret in \
  "$LOGIN_PASSWORD_FILE" \
  "$INVITE_CODE_FILE" \
  "$JOIN_PASSWORD_FILE" \
  "$INVITE_REDEEM_FILE"; do
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
