#!/usr/bin/env bash
# 내부 알파(도커 기반 호스트) 스택 수명주기 — 재배포/수거 단일 진입 (2026-07-23 성재 지시).
#
#   scripts/internal_alpha_stack.sh redeploy   # 데이터 보존 재배포: postgres 이미지
#                                              # 드리프트 수렴 -> migrate -> api/relay
#                                              # 재컴파일 재시작 -> health+안전 라우트 스모크
#   scripts/internal_alpha_stack.sh status     # 컨테이너/포트/마이그레이션 수준 요약
#   scripts/internal_alpha_stack.sh reclaim    # 컨테이너 수거(볼륨 보존)
#   scripts/internal_alpha_stack.sh reclaim --volumes  # 데이터 볼륨까지 완전 수거
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

fail() { echo "[internal-alpha] FAIL: $*" >&2; exit 1; }
note() { echo "[internal-alpha] $*"; }

compose() {
  # 포트 4종은 매 호출에 고정 주입한다 — 미주입 재생성은 호스트 포트 매핑을
  # compose 기본값으로 되돌리는 함정(pgvector 전례)이 있다.
  # INTERNAL_ALPHA_WS_URL: Tailscale 등으로 원격 노출 시 로그인 응답이 건넬
  # 실시간 WS 주소(예: wss://<host>.ts.net:8443/connection/websocket).
  # 미설정이면 compose 기본(ws://127.0.0.1:<CENT_PORT>) — 단독 도그푸드용.
  PORT="$API_PORT" CENT_PORT="$CENT_PORT" POSTGRES_PORT="$PG_PORT" HERMES_PORT="$HERMES_PORT" \
    MOMO_E2E_REALTIME_WS_URL="${INTERNAL_ALPHA_WS_URL:-ws://127.0.0.1:${CENT_PORT}/connection/websocket}" \
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

  note "3/4 api/relay 기동 — 현행 compose command로 소스 재컴파일"
  compose up -d api relay

  note "4/4 health 대기(콜드 컴파일 최대 ${BOOT_TIMEOUT}s) + 안전 라우트 스모크"
  wait_health
  safety_route_smoke
  note "PASS: '$PROJECT' 재배포 완료 — api=127.0.0.1:${API_PORT}, 데이터 볼륨 보존"
}

cmd_reclaim() {
  require_stack
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
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
