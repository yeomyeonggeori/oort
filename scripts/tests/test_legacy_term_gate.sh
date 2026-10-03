#!/usr/bin/env bash
# 옛 용어 grep 게이트의 변조 시험 (AIH-10, #3445).
#
# 옛 말 한 줄을 화면 문자열로 일부러 넣으면 design_preflight_web.sh 가 RED(legacy_term),
# 지우면 GREEN 인 것을 web·core 두 단계에서 실제로 돌려 증명한다. 기계 값
# (맨 "owner_only")은 통과하는 것도 함께 고정한다.
#
# 작업 트리를 바꾸는 것은 임시 파일 두 개뿐이고 trap 으로 반드시 지운다
# (stash/reset 을 쓰지 않는다 — 다른 세션의 dirty 파일을 건드리지 않는다).
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

WEB_PROBE="clients/web/src/legacyTermGateProbe.ts"
CORE_PROBE="packages/momo-core/src/legacyTermGateProbe.ts"
PHONE_PROBE="clients/mobile/src/legacyTermGateProbe.ts"
OUT="$(mktemp "${TMPDIR:-/tmp}/momo-legacy-gate.XXXXXX")"
cleanup() { rm -f "$WEB_PROBE" "$CORE_PROBE" "$PHONE_PROBE" "$OUT"; }
trap cleanup EXIT INT TERM

fail() { echo "[legacy-term-gate-test] FAIL: $*" >&2; exit 1; }

run_gate() { bash scripts/design_preflight_web.sh >"$OUT" 2>&1 && echo 0 || echo $?; }

[ ! -e "$WEB_PROBE" ] && [ ! -e "$CORE_PROBE" ] && [ ! -e "$PHONE_PROBE" ] || fail "probe file already exists"

# 0. 기준선: 변조 없이 GREEN 이어야 이 시험이 의미 있다.
[ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "baseline is not GREEN before sabotage"; }

# 1. 웹: 옛 위치 이름 한 줄 → RED, legacy_term 이름으로.
printf 'export const PROBE = "나중에 설정 › AI 연결에서 이어가요.";\n' >"$WEB_PROBE"
rc="$(run_gate)"
[ "$rc" != "0" ] || fail "web: legacy term inserted but the gate stayed GREEN"
grep -q "legacy_term" "$OUT" || fail "web: RED but not by legacy_term"
grep -q "legacyTermGateProbe.ts" "$OUT" || fail "web: RED but the probe file is not named"
rm -f "$WEB_PROBE"
[ "$(run_gate)" = "0" ] || fail "web: removing the legacy term did not return to GREEN"

# 2. 코어: 두 클라가 렌더하는 문장도 같다.
printf 'export const PROBE = "오너에게 요청하세요.";\n' >"$CORE_PROBE"
rc="$(run_gate)"
[ "$rc" != "0" ] || fail "core: legacy term inserted but the gate stayed GREEN"
grep -q "legacy_term" "$OUT" || fail "core: RED but not by legacy_term"
rm -f "$CORE_PROBE"
[ "$(run_gate)" = "0" ] || fail "core: removing the legacy term did not return to GREEN"

# 2b. 폰: 폰 전용 문자열 단계(design_preflight_phone_strings.mjs, 병합 트리의 phone suite 가 부른다).
printf 'export const PROBE = "오너에게 요청하세요.";\n' >"$PHONE_PROBE"
if node scripts/design_preflight_phone_strings.mjs >"$OUT" 2>&1; then fail "phone: legacy term inserted but the gate stayed GREEN"; fi
grep -q "legacy_term" "$OUT" || fail "phone: RED but not by legacy_term"
rm -f "$PHONE_PROBE"
node scripts/design_preflight_phone_strings.mjs >"$OUT" 2>&1 || { cat "$OUT" >&2; fail "phone: removing the legacy term did not return to GREEN"; }

# 3. 기계 값은 통과한다 (와이어 코드는 바꾸지 않는다).
printf 'export const SCOPE = "owner_only";\n' >"$WEB_PROBE"
[ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "bare machine code owner_only must stay GREEN"; }
rm -f "$WEB_PROBE"

echo "[legacy-term-gate-test] PASS: web/core/phone RED/GREEN, machine code allowed"
