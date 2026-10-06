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
HOSTED_PROBE="clients/web/src/features/hostedAgents/toneGateProbe.ts"
HOSTED_CORE_PROBE="packages/momo-core/src/features/hostedAgents/toneGateProbe.ts"
SETTINGS_PROBE="clients/web/src/features/settings/toneGateProbe.ts"
SETTINGS_CORE_PROBE="packages/momo-core/src/features/settings/toneGateProbe.ts"
OUT="$(mktemp "${TMPDIR:-/tmp}/momo-legacy-gate.XXXXXX")"
cleanup() { rm -f "$WEB_PROBE" "$CORE_PROBE" "$PHONE_PROBE" "$HOSTED_PROBE" "$HOSTED_CORE_PROBE" "$SETTINGS_PROBE" "$SETTINGS_CORE_PROBE" "$OUT"; }
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

# 2c. 호스티드 화면 어투·용어(#3479): 합쇼체·영문 provider 는 RED(legacy_term), 호스티드 밖 합쇼체는 GREEN.
for probe in "$HOSTED_PROBE" "$HOSTED_CORE_PROBE"; do
  [ ! -e "$probe" ] || fail "probe file already exists: $probe"
  printf 'export const PROBE = "이 항목을 어떻게 했습니까";\n' >"$probe"
  rc="$(run_gate)"
  [ "$rc" != "0" ] || fail "hosted tone: 합쇼체 in $probe but the gate stayed GREEN"
  grep -q "legacy_term" "$OUT" || fail "hosted tone: RED but not by legacy_term ($probe)"
  grep -q "toneGateProbe.ts" "$OUT" || fail "hosted tone: RED but the probe file is not named ($probe)"
  printf 'export const PROBE = "provider 설정에 붙여 넣어요.";\n' >"$probe"
  rc="$(run_gate)"
  [ "$rc" != "0" ] || fail "hosted tone: English provider in $probe but the gate stayed GREEN"
  printf 'export const PROBE = "이 항목을 어떻게 했나요? AI 회사 설정에서 지웠어요.";\n' >"$probe"
  [ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "hosted tone: 해요체 sentence must stay GREEN ($probe)"; }
  rm -f "$probe"
done
printf 'export const PROBE = "지금은 보낼 수 없습니다";\n' >"$WEB_PROBE"
[ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "합쇼체 outside hosted surfaces is out of this rule's scope and must stay GREEN"; }
rm -f "$WEB_PROBE"

# 2d. 설정 화면 어투·용어(#3573): 합쇼체·「뿌리」·「지시 기기」는 RED(legacy_term), 해요체·쉬운 말은 GREEN.
for probe in "$SETTINGS_PROBE" "$SETTINGS_CORE_PROBE"; do
  [ ! -e "$probe" ] || fail "probe file already exists: $probe"
  for bad in "이 맥을 뿌리로 등록해야 폰을 승인할 수 있습니다." "승인할 폰이 없습니다" "지시 기기" "QR로 붙인 세션이에요"; do
    printf 'export const PROBE = "%s";\n' "$bad" >"$probe"
    rc="$(run_gate)"
    [ "$rc" != "0" ] || fail "settings tone: 「$bad」 in $probe but the gate stayed GREEN"
    grep -q "legacy_term" "$OUT" || fail "settings tone: RED but not by legacy_term (「$bad」, $probe)"
    grep -q "toneGateProbe.ts" "$OUT" || fail "settings tone: RED but the probe file is not named ($probe)"
  done
  printf 'export const PROBE = "이 맥을 서명 기기로 등록해야 폰이 지시를 보낼 수 있어요.";\n' >"$probe"
  [ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "settings tone: 해요체 sentence must stay GREEN ($probe)"; }
  rm -f "$probe"
done

# 3. 기계 값은 통과한다 (와이어 코드는 바꾸지 않는다).
printf 'export const SCOPE = "owner_only";\n' >"$WEB_PROBE"
[ "$(run_gate)" = "0" ] || { cat "$OUT" >&2; fail "bare machine code owner_only must stay GREEN"; }
rm -f "$WEB_PROBE"

echo "[legacy-term-gate-test] PASS: web/core/phone RED/GREEN, machine code allowed"
