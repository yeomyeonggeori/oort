#!/usr/bin/env bash
# =============================================================================
# scripts/verify_push_kit_inheritance.sh — 승계 소스 드리프트 게이트 (goal RN-N1)
#
# `clients/mobile/ios` 의 NSE 소스 2개는 동결된 `clients/iOS` 킷에서 **복사**한
# 것이다(ADR-0137 이행 순서 5). 참조가 아니라 복사를 고른 이유는 복사본 헤더에
# 적혀 있고, 복사의 유일한 대가는 **드리프트**다. 이 스크립트가 그 대가를 받는다.
#
# 왜 자동 검사가 아니면 못 잡는가:
#   두 파일은 서로 다른 타깃에서 컴파일되고 서로를 import 하지 않는다. 한쪽만
#   고쳐도 **양쪽 다 정상 빌드된다.** 어긋난 사실은 런타임에, 그것도 확장이
#   조용히 fail-open 하는 형태로만 드러난다(감사 2026-08-02 §2.3).
#
# 규율: 순수 텍스트 비교다. 네트워크·빌드·Xcode 가 필요 없고 아무 머신에서나 돈다.
#
# 킷이 은퇴하면(ADR-0137 D8) 원본이 사라진다. 그때는 **SKIP** 으로 떨어지되
# 조용히 지나가지 않고 그 사실을 출력한다 — 게이트가 무의미해진 것과 게이트가
# 통과한 것은 다른 사건이다.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[push-inherit] $*"; }

SENTINEL='===== SENTINEL: INHERITED BYTES BEGIN ====='

FAILURES=0
fail() { FAILURES=$((FAILURES + 1)); log "FAIL: $*"; }

# 복사본에서 provenance 헤더를 떼어 낸 나머지(= 승계 바이트)를 낸다.
inherited_bytes() {
  local file="$1"
  if ! grep -qF "$SENTINEL" "$file"; then
    log "FAIL: $file 에 SENTINEL 주석이 없다 — 헤더가 지워졌거나 파일이 교체됐다"
    return 1
  fi
  awk -v sentinel="$SENTINEL" '
    seen { print; next }
    index($0, sentinel) > 0 { seen = 1 }
  ' "$file"
}

compare() {
  local label="$1" copy="$2" origin="$3" strip_import="$4"

  if [ ! -f "$origin" ]; then
    log "SKIP: $label — 원본이 없다($origin). 동결 킷이 은퇴했다면 이 게이트와 복사본 헤더를 함께 정리해라"
    return 0
  fi
  if [ ! -f "$copy" ]; then
    fail "$label — 복사본이 없다($copy)"
    return 0
  fi

  local a b
  a="$(inherited_bytes "$copy")" || { FAILURES=$((FAILURES + 1)); return 0; }
  if [ "$strip_import" = 'yes' ]; then
    # 복사 시 삭제한 단 한 줄. 원본에서도 같은 줄을 빼고 비교한다 —
    # "한 줄만 다르다"를 주장으로 두지 않고 기계가 강제한다.
    b="$(grep -v '^import MomoiOSPushKit$' "$origin")"
  else
    b="$(cat "$origin")"
  fi

  if [ "$a" != "$b" ]; then
    fail "$label — 복사본이 원본과 다르다
        복사본: $copy
        원본:   $origin
        → 원본은 동결(ADR-0137 D8, 버그픽스 전용)이다. 고쳐야 할 쪽을 먼저 정하고,
          원본을 고쳤다면 복사본에 그대로 반영해라. 아래가 차이다:"
    diff <(printf '%s\n' "$b") <(printf '%s\n' "$a") | head -40 || true
  else
    log "OK: $label ($(printf '%s\n' "$a" | wc -l | tr -d ' ') 줄 일치)"
  fi
}

compare 'MomoiOSPushKit/PushNotification.swift' \
  'clients/mobile/ios/MomoPushKit/PushNotification.swift' \
  'clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift' \
  'no'

compare 'NotificationService/NotificationService.swift' \
  'clients/mobile/ios/NotificationService/NotificationService.swift' \
  'clients/iOS/NotificationService/NotificationService.swift' \
  'yes'

if [ "$FAILURES" -ne 0 ]; then
  log "FAIL: $FAILURES 건 — 승계 소스가 동결 원본과 갈라졌다"
  exit 1
fi

log 'PASS: 승계 소스가 동결 킷과 바이트 단위로 일치한다'
