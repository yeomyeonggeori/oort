#!/usr/bin/env bash
# 내부 알파(도커 기반 호스트) 스택 수명주기 — 재배포/수거 단일 진입 (2026-07-23 성재 지시).
#
#   scripts/internal_alpha_stack.sh redeploy   # 데이터 보존 재배포: postgres 이미지
#                                              # 드리프트 수렴 -> migrate -> api/relay
#                                              # 재컴파일 재시작 -> health+안전 라우트 스모크
#   scripts/internal_alpha_stack.sh status     # 컨테이너/포트/마이그레이션 수준 요약
#   scripts/internal_alpha_stack.sh reclaim    # 컨테이너 수거(볼륨 보존)
#   scripts/internal_alpha_stack.sh reclaim --volumes  # 데이터 볼륨까지 완전 수거
#   scripts/internal_alpha_stack.sh mdns [status|advertise|withdraw]  # Bonjour _momo._tcp 광고(macOS 전용)
#
# 실 AWS 호스트는 이 도커 기반 호스트가 검증된 이후에만 진행한다(성재 2026-07-23).
set -euo pipefail

PROJECT="${INTERNAL_ALPHA_PROJECT:-momowebqa}"
API_PORT="${INTERNAL_ALPHA_API_PORT:-28000}"
CENT_PORT="${INTERNAL_ALPHA_CENT_PORT:-28001}"
PG_PORT="${INTERNAL_ALPHA_POSTGRES_PORT:-28002}"
HERMES_PORT="${INTERNAL_ALPHA_HERMES_PORT:-28003}"
BOOT_TIMEOUT="${INTERNAL_ALPHA_BOOT_TIMEOUT:-2400}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "[internal-alpha] must run inside the repository" >&2
  exit 1
}
cd "$REPO_ROOT"
COMPOSE_FILE="infra/docker-compose.e2e.yml"

# --- mDNS 서비스 광고 설정 (Bonjour _momo._tcp) — W-O2 서버측(MOMO-586) ----------
# 587 클라가 브라우징할 서비스를 내부알파 호스트(macOS)가 광고한다. dns-sd는 macOS
# 내장(mDNSResponder)이라 그 외 호스트(Linux)는 미지원 -> skip+로그. 광고는 등록을
# 유지하는 상시 백그라운드 프로세스라 pid 파일로 관리해 재배포 반복 시 누수를 막는다.
MDNS_SERVICE_NAME="${INTERNAL_ALPHA_MDNS_NAME:-momo}"
MDNS_SERVICE_TYPE="_momo._tcp"
MDNS_STATE_DIR="${REPO_ROOT}/.momo"          # 프로젝트 상태 위치(.gitignore 대상, TMPDIR 아님)
MDNS_PID_FILE="${MDNS_STATE_DIR}/internal-alpha-mdns-${PROJECT}.pid"
MDNS_LOG_FILE="${MDNS_STATE_DIR}/internal-alpha-mdns-${PROJECT}.log"

fail() { echo "[internal-alpha] FAIL: $*" >&2; exit 1; }
note() { echo "[internal-alpha] $*"; }

mdns_supported() {
  # dns-sd 광고는 macOS 내장 mDNSResponder에 의존한다. 그 외 호스트는 미지원.
  [ "$(uname -s)" = "Darwin" ] && command -v dns-sd >/dev/null 2>&1
}

mdns_base_url() {
  # TXT base = 587 클라가 접속할 API base URL. Bonjour .local 호스트명을 쓴다
  # (예: http://MacBook-Pro-2.local:28000).
  local host
  host="$(scutil --get LocalHostName 2>/dev/null || true)"
  [ -n "$host" ] || host="$(hostname -s 2>/dev/null || echo momo-host)"
  echo "http://${host}.local:${API_PORT}"
}

mdns_running() {
  # pid 파일이 가리키는 광고 프로세스가 살아 있으면 0.
  local pid
  [ -f "$MDNS_PID_FILE" ] || return 1
  pid="$(cat "$MDNS_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

mdns_advertise() {
  if ! mdns_supported; then
    note "mDNS 광고 skip: 비 macOS 호스트($(uname -s)) — dns-sd 미지원, 광고 없음"
    return 0
  fi
  if mdns_running; then
    note "mDNS 광고 이미 실행 중(pid=$(cat "$MDNS_PID_FILE" 2>/dev/null || echo '?')) — 재등록 생략"
    return 0
  fi
  mkdir -p "$MDNS_STATE_DIR"
  local base
  base="$(mdns_base_url)"
  # dns-sd -R는 등록을 유지하는 상시 프로세스 — 백그라운드로 띄우고 pid를 남긴다.
  dns-sd -R "$MDNS_SERVICE_NAME" "$MDNS_SERVICE_TYPE" . "$API_PORT" "base=${base}" \
    >"$MDNS_LOG_FILE" 2>&1 &
  echo "$!" >"$MDNS_PID_FILE"
  note "mDNS 광고 등록: ${MDNS_SERVICE_NAME}.${MDNS_SERVICE_TYPE} :${API_PORT} (TXT base=${base}, pid=$!)"
}

mdns_withdraw() {
  if ! mdns_running; then
    rm -f "$MDNS_PID_FILE"   # 스테일/부재 pid 파일 정리(rm -f는 부재해도 0)
    return 0
  fi
  local pid
  pid="$(cat "$MDNS_PID_FILE" 2>/dev/null || true)"
  kill "$pid" 2>/dev/null || true
  rm -f "$MDNS_PID_FILE"
  note "mDNS 광고 해제(pid=${pid})"
}

mdns_status_line() {
  if ! mdns_supported; then
    note "mDNS 광고: skip(비 macOS 호스트=$(uname -s))"
    return 0
  fi
  if mdns_running; then
    note "mDNS 광고: 활성 — ${MDNS_SERVICE_NAME}.${MDNS_SERVICE_TYPE} :${API_PORT} (TXT base=$(mdns_base_url), pid=$(cat "$MDNS_PID_FILE" 2>/dev/null || echo '?'))"
  else
    note "mDNS 광고: 비활성(pid 파일 없음 또는 스테일)"
  fi
}

cmd_mdns() {
  case "${1:-status}" in
    advertise|up|register)    mdns_withdraw; mdns_advertise ;;
    withdraw|down|unregister) mdns_withdraw ;;
    status)                   mdns_status_line ;;
    *) fail "mdns 하위명령: status | advertise | withdraw (받은 값: '${1:-}')" ;;
  esac
}

compose() {
  # 포트 4종은 매 호출에 고정 주입한다 — 미주입 재생성은 호스트 포트 매핑을
  # compose 기본값으로 되돌리는 함정(pgvector 전례)이 있다.
  # INTERNAL_ALPHA_WS_URL: Tailscale 등으로 원격 노출 시 로그인 응답이 건넬
  # 실시간 WS 주소(예: wss://<host>.ts.net:8443/connection/websocket).
  # 미설정이면 compose 기본(ws://127.0.0.1:<CENT_PORT>) — 단독 도그푸드용.
  # PLATFORM_ADMIN_EMAILS(MOMO-583): provider_link("AI 연결")는 이 목록에 등재된
  # 인스턴스 운영자(owner/admin + 검증된 이메일)만 편집 가능. 요청 시점 판정이라
  # 재로그인 불필요. 기본=성재. 미등재 워크스페이스 owner는 403(크로스테넌트 차단).
  # MOMO_CORS_ALLOWED_ORIGINS(MOMO-605/P2): Tauri 데스크톱(tauri://localhost)과
  # dev preview가 REST에 닿도록 기본 허용. 완전일치 목록, 와일드카드 불가.
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    MOMO_E2E_REALTIME_WS_URL="${INTERNAL_ALPHA_WS_URL:-ws://127.0.0.1:${CENT_PORT}/connection/websocket}" \
    PLATFORM_ADMIN_EMAILS="${INTERNAL_ALPHA_PLATFORM_ADMIN_EMAILS:-gkffhdnls13@gmail.com}" \
    MOMO_CORS_ALLOWED_ORIGINS="${INTERNAL_ALPHA_CORS_ORIGINS:-tauri://localhost,http://tauri.localhost,http://localhost:5173,http://127.0.0.1:5173}" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

require_stack() {
  # 정지 상태(재배포 도중 중단 등)도 관리 대상 — 컨테이너 또는 데이터 볼륨이
  # 존재하면 이 프로젝트의 스택으로 인정한다.
  docker ps -a --format '{{.Names}}' | grep -q "^${PROJECT}-postgres-1$" && return 0
  docker volume ls -q | grep -q "^${PROJECT}_" && return 0
  fail "project '$PROJECT'의 컨테이너/볼륨이 없다. 신규 기동은 이 스크립트 범위 밖(운영 결정)."
}

wait_health() {
  local deadline
  deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  until curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      compose logs --tail 60 api >&2 || true
      fail "api /health가 ${BOOT_TIMEOUT}s 안에 살아나지 않았다"
    fi
    sleep 5
  done
}

safety_route_smoke() {
  # ADR-0132 표면이 실제로 서빙되는지: 미인증 호출이 404(라우트 부재)가 아니라
  # 401(인증 요구)로 답해야 신 코드다.
  local ws="00000000-0000-7000-8000-000000000001"
  local zero="00000000-0000-7000-8000-000000000000"
  local cancel_code pause_code
  cancel_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:${API_PORT}/v1/workspaces/${ws}/agent-runs/${zero}/cancel")"
  pause_code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H 'Content-Type: application/json' --data '{"paused":true}' \
    "http://127.0.0.1:${API_PORT}/v1/workspaces/${ws}/agents/${zero}/pause")"
  [ "$cancel_code" = "401" ] || fail "cancel 라우트 스모크: 기대 401, 실제 $cancel_code"
  [ "$pause_code" = "401" ] || fail "pause 라우트 스모크: 기대 401, 실제 $pause_code"
  note "안전 라우트 스모크 PASS: cancel=401, pause=401 (라우트 존재+인증 강제)"
}

cmd_status() {
  require_stack
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep "^${PROJECT}-" || true
  local level
  level="$(docker exec "${PROJECT}-postgres-1" psql -U momo -d momo -qAt \
    -c "SELECT coalesce(max(filename),'(none)') FROM schema_migrations;" 2>/dev/null || echo unknown)"
  note "마이그레이션 수준: $level"
  note "api: http://127.0.0.1:${API_PORT}/health"
  mdns_status_line
}

cmd_redeploy() {
  # 부분 수렴(--no-deps 단일 서비스 up)은 compose 네트워크/라벨 구성이 바뀐 경우
  # "network has active endpoints"로 죽는다 — 전체 down(볼륨 보존) 후 up이 정본.
  # restart도 금지: 컨테이너 생성 시점의 낡은 command를 재사용한다(625 전례 변주).
  note "1/4 전체 스택 down(--remove-orphans, 볼륨 보존) 후 기반 서비스 up"
  compose down --remove-orphans || true
  compose up -d --wait --wait-timeout 180 postgres centrifugo mock-hermes
  local deadline
  deadline=$(( $(date +%s) + 120 ))
  until docker exec "${PROJECT}-postgres-1" pg_isready -U momo >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "postgres가 120s 안에 ready 되지 않았다"
    sleep 2
  done

  note "2/4 마이그레이션(전방향 전용)"
  compose run --rm --no-deps migrate

  note "3/4 api/relay/worker 기동 — 현행 compose command로 소스 재컴파일"
  # worker(AgentWorker) 미기동이면 에이전트 멘션 응답이 라이브에서 안 나간다
  # (MOMO-592 런북 걷기에서 발견된 갭, 2026-07-24).
  compose up -d api relay worker

  note "4/4 health 대기(콜드 컴파일 최대 ${BOOT_TIMEOUT}s) + 안전 라우트 스모크"
  wait_health
  safety_route_smoke

  # 상시 서비스에 restart=unless-stopped를 걸어 맥 재부팅/Docker Desktop 재시작 시
  # 자동 복구되게 한다(성재 출근 시 서버가 이미 떠 있어야 함 — 이동식 호스트 요건).
  # e2e compose 기본은 restart:no라 실행 중 컨테이너에 직접 적용한다.
  docker update --restart unless-stopped \
    "${PROJECT}-postgres-1" "${PROJECT}-centrifugo-1" "${PROJECT}-mock-hermes-1" \
    "${PROJECT}-api-1" "${PROJECT}-relay-1" >/dev/null 2>&1 || true

  # mDNS 서비스 광고 갱신 — 기존 광고 해제 후 현행 포트로 재등록(중복/누수 방지).
  # 587 클라가 LAN에서 이 호스트를 자동 발견하도록(macOS 전용, 그 외 호스트는 skip).
  mdns_withdraw
  mdns_advertise

  note "PASS: '$PROJECT' 재배포 완료 — api=127.0.0.1:${API_PORT}, restart=unless-stopped, 데이터 볼륨 보존"
}

cmd_reclaim() {
  require_stack
  mdns_withdraw   # 스택 수거 시 mDNS 광고도 함께 해제(광고 프로세스 누수 방지)
  local with_volumes=0
  [ "${1:-}" = "--volumes" ] && with_volumes=1
  if [ "$with_volumes" = "1" ]; then
    note "완전 수거: 컨테이너+네트워크+볼륨 제거 ('$PROJECT')"
    compose down --remove-orphans --volumes
  else
    note "수거: 컨테이너+네트워크 제거, 데이터 볼륨은 보존 ('$PROJECT')"
    compose down --remove-orphans
  fi
  note "수거 완료. 잔여 볼륨: $(docker volume ls -q | grep "^${PROJECT}_" | tr '\n' ' ' || true)"
}

case "${1:-}" in
  redeploy) cmd_redeploy ;;
  status)   cmd_status ;;
  reclaim)  shift; cmd_reclaim "${1:-}" ;;
  mdns)     shift; cmd_mdns "${1:-status}" ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
