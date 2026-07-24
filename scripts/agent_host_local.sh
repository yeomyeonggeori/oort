#!/usr/bin/env bash
# =============================================================================
# scripts/agent_host_local.sh: MOMO-592 (ADR-0125 D2 / ADR-0114 증보1)
#
# 내부 알파(momowebqa, 기본 http://127.0.0.1:28000) 대상 momo-workd 원커맨드
# 기동. 이 Mac을 코드 실행 호스트로 등록해 GUI(WH-2)에서 페어링을 확인하고,
# codex-local/opencode/goose 엔진으로 세션을 몰 수 있게 한다.
#
#   # 최초 등록: 운영자 계정으로 로그인해 1회용 등록 토큰을 얻고 데몬을 띄운다
#   AGENT_HOST_LOGIN_EMAIL=you@example.com \
#   AGENT_HOST_LOGIN_PASSWORD='...' \
#     scripts/agent_host_local.sh
#
#   # 등록 후 재기동(로컬 host-id가 있으면 토큰 불필요)
#   scripts/agent_host_local.sh
#
#   # 환경 점검만(데몬을 띄우지 않음)
#   scripts/agent_host_local.sh --preflight
#
#   # 등록만 하고 종료(CI/스모크용, momo-workd --bootstrap-only 위임)
#   AGENT_HOST_LOGIN_EMAIL=... AGENT_HOST_LOGIN_PASSWORD=... \
#     scripts/agent_host_local.sh --bootstrap-only
#
# 토큰 대안: 이미 access token이 있으면 로그인 대신 아래 중 하나로 넘긴다.
#   MOMO_WORKD_REGISTRATION_TOKEN='<access-token>'      (env, 프로세스 노출 주의)
#   MOMO_WORKD_REGISTRATION_TOKEN_FILE=/path/to/token   (mode 0600 파일 권장)
#
# 이 스크립트는 loopback http 대상에만 MOMO_WORKD_ALLOW_INSECURE_HTTP=1을 켠다.
# 원격/공개 배포판은 https + docs/WORK_HOST_QUICKSTART.md 절차를 쓴다.
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- 조정 가능한 입력(모두 env override) ------------------------------------
API_PORT="${INTERNAL_ALPHA_API_PORT:-28000}"
SERVER_URL="${MOMO_WORKD_SERVER_URL:-http://127.0.0.1:${API_PORT}}"
WORKSPACE_ID="${MOMO_WORKD_WORKSPACE_ID:-00000000-0000-7000-8000-000000000001}"
# WH-1 부팅 엔진 라벨(선택). 미설정이면 데몬 기본(opencode). 앱 설정(DB)이 이기므로
# 여기 값은 GUI에서 엔진을 아직 고르지 않았을 때의 폴백일 뿐이다.
ENGINE="${MOMO_WORKD_ENGINE:-}"
LOGIN_EMAIL="${AGENT_HOST_LOGIN_EMAIL:-}"
LOGIN_PASSWORD="${AGENT_HOST_LOGIN_PASSWORD:-}"

MOMO_HOME="${MOMO_WORKD_HOME:-$HOME/.momo}"
HOST_ID_FILE="${MOMO_WORKD_HOST_ID_PATH:-$MOMO_HOME/workd.host-id}"
TOKEN_FILE="${MOMO_WORKD_REGISTRATION_TOKEN_FILE:-}"
TOKEN_VALUE="${MOMO_WORKD_REGISTRATION_TOKEN:-}"
WORKD_BIN="$REPO_ROOT/workers/WorkHostDaemon/.build/debug/momo-workd"

MODE="run"          # run | preflight | bootstrap-only
PASSTHROUGH=()

note() { printf '[agent-host] %s\n' "$*"; }
fail() { printf '[agent-host] FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --preflight)      MODE="preflight" ;;
    --bootstrap-only) MODE="bootstrap-only"; PASSTHROUGH+=("--bootstrap-only") ;;
    -h|--help)        usage 0 ;;
    *)                PASSTHROUGH+=("$arg") ;;
  esac
done

# --- preflight 1: 필수 도구 --------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "curl가 필요합니다."
command -v swift >/dev/null 2>&1 || fail "swift 툴체인이 필요합니다(.swift-version=6.2)."
PYTHON_BIN=""
for candidate in python3 python3.13 python3.12 python3.11; do
  command -v "$candidate" >/dev/null 2>&1 && { PYTHON_BIN="$candidate"; break; }
done
[ -n "$PYTHON_BIN" ] || fail "python3가 필요합니다(로그인 응답 파싱용)."

# --- preflight 2: 대상 URL 검증 + loopback http 정책 -------------------------
scheme="${SERVER_URL%%://*}"
rest="${SERVER_URL#*://}"
host="${rest%%[:/]*}"
case "$scheme" in
  https) : ;;
  http)
    case "$host" in
      127.0.0.1|localhost|::1)
        # 데몬은 loopback이 아닌 http를 거부한다. 내부 알파는 loopback이므로 opt-in.
        export MOMO_WORKD_ALLOW_INSECURE_HTTP=1
        ;;
      *)
        fail "http 대상은 loopback(127.0.0.1/localhost/::1)만 허용됩니다. 원격은 https를 쓰세요: $SERVER_URL"
        ;;
    esac
    ;;
  *) fail "MOMO_WORKD_SERVER_URL 스킴은 http 또는 https여야 합니다: $SERVER_URL" ;;
esac

# --- preflight 3: 워크스페이스 UUID 형식 ------------------------------------
"$PYTHON_BIN" - "$WORKSPACE_ID" <<'PY' >/dev/null 2>&1 || fail "MOMO_WORKD_WORKSPACE_ID가 UUID가 아닙니다: $WORKSPACE_ID"
import sys, uuid
uuid.UUID(sys.argv[1])
PY

# --- preflight 4: 엔진 라벨(설정된 경우) -------------------------------------
if [ -n "$ENGINE" ]; then
  case "$ENGINE" in
    opencode|goose|codex-local) : ;;
    *) fail "MOMO_WORKD_ENGINE는 opencode|goose|codex-local 중 하나여야 합니다: $ENGINE" ;;
  esac
fi

# --- preflight 5: 내부 알파 health ------------------------------------------
if ! curl -fsS --max-time 5 "${SERVER_URL%/}/health" >/dev/null 2>&1; then
  fail "내부 알파 health에 도달할 수 없습니다: ${SERVER_URL%/}/health
       (재배포: scripts/internal_alpha_stack.sh redeploy · 상태: ... status)"
fi
note "health OK: ${SERVER_URL%/}/health"

# --- preflight 6: 데몬 빌드 --------------------------------------------------
if [ ! -x "$WORKD_BIN" ]; then
  note "momo-workd 빌드 중(최초 1회)"
  swift build --package-path workers/WorkHostDaemon
fi
[ -x "$WORKD_BIN" ] || fail "빌드 후에도 momo-workd 실행파일이 없습니다: $WORKD_BIN"
note "momo-workd 준비됨: $WORKD_BIN"

# --- preflight 7: 등록 자격(토큰) 확보 --------------------------------------
# 이미 이 Mac이 등록됐으면(host-id 파일 존재) 토큰 없이 재기동한다. 그 외에는
# 명시 토큰/토큰파일 또는 운영자 로그인으로 1회용 access token을 확보한다.
ALREADY_REGISTERED=0
[ -s "$HOST_ID_FILE" ] && ALREADY_REGISTERED=1

CREATED_TOKEN_FILE=""
if [ "$ALREADY_REGISTERED" = "1" ]; then
  note "기존 호스트 등록 감지: $HOST_ID_FILE (토큰 불필요, heartbeat 재개)"
elif [ -n "$TOKEN_FILE" ]; then
  [ -s "$TOKEN_FILE" ] || fail "MOMO_WORKD_REGISTRATION_TOKEN_FILE이 비어 있습니다: $TOKEN_FILE"
  note "등록 토큰 파일 사용: $TOKEN_FILE"
elif [ -n "$TOKEN_VALUE" ]; then
  note "등록 토큰(env) 사용"
elif [ -n "$LOGIN_EMAIL" ] && [ -n "$LOGIN_PASSWORD" ]; then
  note "운영자 로그인으로 1회용 등록 토큰 발급: $LOGIN_EMAIL"
  mkdir -p "$MOMO_HOME"; chmod 700 "$MOMO_HOME"
  # 자격 증명은 argv(ps 노출)가 아니라 env로 python에 전달한다.
  LOGIN_BODY="$(AH_E="$LOGIN_EMAIL" AH_P="$LOGIN_PASSWORD" AH_W="$WORKSPACE_ID" \
    "$PYTHON_BIN" -c 'import json, os; print(json.dumps({"email": os.environ["AH_E"], "password": os.environ["AH_P"], "workspace": os.environ["AH_W"]}))')"
  LOGIN_JSON="$(curl -fsS --max-time 10 -X POST "${SERVER_URL%/}/v1/auth/login" \
    -H 'Content-Type: application/json' --data "$LOGIN_BODY" 2>/dev/null)" \
    || fail "로그인 실패(HTTP 오류). 이메일/비밀번호/워크스페이스를 확인하세요."
  # 응답은 stdin으로 파싱한다(따옴표/주입 안전).
  ACCESS_TOKEN="$(printf '%s' "$LOGIN_JSON" | "$PYTHON_BIN" -c 'import json, sys;
try:
    print(json.load(sys.stdin).get("accessToken", ""))
except Exception:
    print("")')"
  [ -n "$ACCESS_TOKEN" ] || fail "로그인 응답에 accessToken이 없습니다. 자격 증명을 확인하세요."
  CREATED_TOKEN_FILE="$MOMO_HOME/workd-registration.token"
  printf '%s\n' "$ACCESS_TOKEN" >"$CREATED_TOKEN_FILE"
  chmod 600 "$CREATED_TOKEN_FILE"
  TOKEN_FILE="$CREATED_TOKEN_FILE"
  note "등록 토큰 저장(0600): $CREATED_TOKEN_FILE (등록 성공 시 데몬이 삭제)"
else
  fail "등록 자격이 없습니다. 아래 중 하나를 제공하세요:
       - AGENT_HOST_LOGIN_EMAIL + AGENT_HOST_LOGIN_PASSWORD (운영자 계정)
       - MOMO_WORKD_REGISTRATION_TOKEN 또는 MOMO_WORKD_REGISTRATION_TOKEN_FILE
       - (재기동이면) 기존 $HOST_ID_FILE"
fi

if [ "$MODE" = "preflight" ]; then
  note "preflight PASS: server=$SERVER_URL workspace=$WORKSPACE_ID engine=${ENGINE:-<데몬기본>}"
  note "데몬을 띄우려면 --preflight 없이 다시 실행하세요."
  exit 0
fi

# --- 데몬 기동 --------------------------------------------------------------
export MOMO_WORKD_SERVER_URL="$SERVER_URL"
export MOMO_WORKD_WORKSPACE_ID="$WORKSPACE_ID"
[ -n "$ENGINE" ] && export MOMO_WORKD_ENGINE="$ENGINE"
[ -n "$TOKEN_FILE" ] && export MOMO_WORKD_REGISTRATION_TOKEN_FILE="$TOKEN_FILE"
[ -n "$TOKEN_VALUE" ] && [ -z "$TOKEN_FILE" ] && export MOMO_WORKD_REGISTRATION_TOKEN="$TOKEN_VALUE"

note "momo-workd 기동: server=$SERVER_URL workspace=$WORKSPACE_ID engine=${ENGINE:-<데몬기본>} mode=$MODE"
note "로그의 'momo-workd host ready'(workspace_id·host_id·engine)로 등록을 확인하세요."
# 빈 배열 확장은 bash 3.2(macOS 기본)의 set -u에서 unbound로 죽으므로 가드한다.
exec "$WORKD_BIN" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
