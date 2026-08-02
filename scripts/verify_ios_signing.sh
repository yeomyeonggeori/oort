#!/usr/bin/env bash
# =============================================================================
# scripts/verify_ios_signing.sh — 서명 레인 식별자 정합 게이트 (P1)
#
# fastlane이 프로비저닝하는 app identifier 집합과 Xcode 프로젝트의
# PRODUCT_BUNDLE_IDENTIFIER 집합이 갈라지면 실패한다.
#
# 왜 필요한가:
#   fastlane은 `com.dawnkim.momo`(= macOS 번들 ID) 하나만 프로비저닝하고 있었고,
#   iOS 앱(app.momo.ios)과 알림 확장(app.momo.ios.NotificationService)은
#   어디에도 없었다. 로컬 게이트(scripts/verify_ios_build.sh)는
#   CODE_SIGNING_ALLOWED=NO 로 돌기 때문에 서명이 한 번도 실행되지 않고,
#   불일치는 CI가 실제로 아카이브를 서명할 때에야 드러난다.
#   → 그 드러남을 여기로 앞당긴다.
#
# 규율: 순수 텍스트 검사다. 네트워크·Apple 자격증명·`match`/`fastlane` 실행이 전혀
#       없으므로 아무 머신에서나, 계정 없이, CI에서도 그대로 돈다.
#
# 정본은 Xcode 프로젝트다. 이 게이트가 실패하면 고쳐야 할 쪽은 원칙적으로
# fastlane이다(프로젝트 번들 ID를 바꾸면 등록된 App ID·푸시 인증서·App Group·
# keychain access group이 전부 흔들린다).
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[ios-signing] $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { log "missing $1"; exit 1; }; }

need awk
need sed
need grep
need sort

IOS_PBXPROJ='clients/iOS/MomoiOS.xcodeproj/project.pbxproj'
MAC_PBXPROJ='clients/macOS/MomoMac.xcodeproj/project.pbxproj'
FASTFILE='fastlane/Fastfile'
APPFILE='fastlane/Appfile'
MATCHFILE='fastlane/Matchfile'

for required in "$IOS_PBXPROJ" "$MAC_PBXPROJ" "$FASTFILE" "$APPFILE" "$MATCHFILE"; do
  [ -f "$required" ] || { log "missing required file: $required"; exit 1; }
done

FAILURES=0
fail() { FAILURES=$((FAILURES + 1)); log "FAIL: $*"; }

# -----------------------------------------------------------------------------
# 추출기
# -----------------------------------------------------------------------------

# pbxproj에서 "프로비저닝이 필요한" PRODUCT_BUNDLE_IDENTIFIER만 뽑는다.
#
# 제외 규칙(근거):
#   - TEST_HOST / BUNDLE_LOADER 가 있는 빌드설정 = 테스트 번들. 배포 산출물(.ipa/.app)에
#     포함되지 않으므로 프로비저닝 프로파일이 필요 없다.
#   - CODE_SIGNING_ALLOWED = NO 인 빌드설정 = 애초에 서명되지 않는다. 서명되지 않는
#     타깃에 프로파일을 요구하면 존재하지 않아도 되는 App ID를 만들게 된다.
#   두 조건은 현재 테스트 타깃에 모두 걸려 있다(중복이지만 어느 한쪽만 바뀌어도
#   규칙이 무너지지 않도록 둘 다 본다).
# 확장(app-extension)의 SKIP_INSTALL=YES 는 제외 사유가 아니다 — 확장은 앱에
# 임베드되어 함께 배포되고 자기 프로파일이 반드시 필요하다.
pbx_provisioned_ids() {
  awk '
    /buildSettings = \{/ { inb = 1; depth = 1; bid = ""; skip = 0; next }
    inb {
      opens = gsub(/\{/, "{"); closes = gsub(/\}/, "}");
      depth += opens - closes;
      if ($0 ~ /PRODUCT_BUNDLE_IDENTIFIER[[:space:]]*=/) {
        value = $0;
        sub(/.*PRODUCT_BUNDLE_IDENTIFIER[[:space:]]*=[[:space:]]*/, "", value);
        sub(/;.*$/, "", value);
        gsub(/"/, "", value);
        gsub(/[[:space:]]/, "", value);
        bid = value;
      }
      if ($0 ~ /TEST_HOST[[:space:]]*=/ || $0 ~ /BUNDLE_LOADER[[:space:]]*=/) skip = 1;
      if ($0 ~ /CODE_SIGNING_ALLOWED[[:space:]]*=[[:space:]]*NO/) skip = 1;
      if (depth <= 0) {
        if (bid != "" && skip == 0) print bid;
        inb = 0;
      }
    }
  ' "$1" | sort -u
}

# Ruby 설정 파일에서 app_identifier 로 넘어가는 문자열을 뽑는다.
# 주석(#)은 먼저 제거한다 — 주석 안의 예시 번들 ID가 실제 프로비저닝 대상으로
# 오인되면 안 된다. (이 파일들에는 문자열 리터럴 안에 '#'가 없다.)
# 배열이 여러 줄에 걸쳐도 ']' 가 닫힐 때까지 이어 읽는다.
ruby_app_identifiers() {
  sed 's/#.*$//' | awk '
    /app_identifier/ {
      buf = $0;
      if (index(buf, "[") > 0 && index(buf, "]") == 0) {
        while ((getline nextline) > 0) {
          buf = buf " " nextline;
          if (index(nextline, "]") > 0) break;
        }
      }
      while (match(buf, /"[^"]+"/)) {
        token = substr(buf, RSTART + 1, RLENGTH - 2);
        # 번들 ID 형태만 채택 — ENV["MATCH_GIT_URL"] 같은 것을 걸러낸다.
        if (token ~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ && index(token, ".") > 0) print token;
        buf = substr(buf, RSTART + RLENGTH);
      }
    }
  ' | sort -u
}

# Fastfile을 platform 블록으로 잘라낸다(col 0의 `platform :x do` ~ col 0의 `end`).
fastfile_platform_section() {
  awk -v want="$1" '
    /^platform :ios do/ { p = "ios"; next }
    /^platform :mac do/ { p = "mac"; next }
    /^end[[:space:]]*$/ { p = ""; next }
    p == want { print }
  ' "$FASTFILE"
}

# Appfile의 for_platform :mac 블록 안/밖을 나눈다.
appfile_section() {
  awk -v want="$1" '
    /^for_platform :mac do/ { p = "mac"; next }
    /^end[[:space:]]*$/ { p = "default"; next }
    { if (p == "") p = "default"; if (p == want) print }
  ' "$APPFILE"
}

set_str() { tr '\n' ' ' | sed 's/[[:space:]]*$//'; }

# -----------------------------------------------------------------------------
# 0. Fastfile 구조 확인 — 플랫폼 블록을 못 찾으면 아래 검사가 조용히 무의미해진다.
# -----------------------------------------------------------------------------
grep -q '^platform :ios do' "$FASTFILE" || fail "$FASTFILE: 'platform :ios do' 블록을 찾지 못했다(파서 전제 붕괴)"
grep -q '^platform :mac do' "$FASTFILE" || fail "$FASTFILE: 'platform :mac do' 블록을 찾지 못했다(파서 전제 붕괴)"

# -----------------------------------------------------------------------------
# 1. 자리표시자 잔존 — 값을 채운 뒤 주석을 지우지 않으면 다음 사람이 또 자리표시자로 읽는다.
#    (주석 제거 전 원문에서 검사한다.)
# -----------------------------------------------------------------------------
for f in "$MATCHFILE" "$APPFILE" "$FASTFILE"; do
  if grep -qF '⚠️' "$f"; then
    fail "$f: 자리표시자 경고 주석(⚠️)이 남아 있다"
  fi
  if grep -qF '실제 Bundle ID로 교체' "$f" || grep -qF '실제 등록한 Bundle ID로 교체' "$f"; then
    fail "$f: '실제 Bundle ID로 교체' 자리표시자 주석이 남아 있다"
  fi
done

# -----------------------------------------------------------------------------
# 2. 기대 집합(정본 = Xcode 프로젝트)
# -----------------------------------------------------------------------------
IOS_EXPECTED="$(pbx_provisioned_ids "$IOS_PBXPROJ")"
MAC_EXPECTED="$(pbx_provisioned_ids "$MAC_PBXPROJ")"

[ -n "$IOS_EXPECTED" ] || fail "$IOS_PBXPROJ: 프로비저닝 대상 번들 ID를 하나도 못 뽑았다(파서 전제 붕괴)"
[ -n "$MAC_EXPECTED" ] || fail "$MAC_PBXPROJ: 프로비저닝 대상 번들 ID를 하나도 못 뽑았다(파서 전제 붕괴)"

log "Xcode 정본 — iOS: $(printf '%s' "$IOS_EXPECTED" | set_str)"
log "Xcode 정본 — macOS: $(printf '%s' "$MAC_EXPECTED" | set_str)"

# -----------------------------------------------------------------------------
# 3. iOS: Matchfile 기본값 == 정본, Fastfile iOS 레인 == 정본
# -----------------------------------------------------------------------------
MATCH_IDS="$(ruby_app_identifiers <"$MATCHFILE")"
FAST_IOS_IDS="$(fastfile_platform_section ios | ruby_app_identifiers)"
FAST_MAC_IDS="$(fastfile_platform_section mac | ruby_app_identifiers)"
APP_DEFAULT_IDS="$(appfile_section default | ruby_app_identifiers)"
APP_MAC_IDS="$(appfile_section mac | ruby_app_identifiers)"

compare_set() {
  local label="$1" expected="$2" actual="$3" hint="$4"
  if [ "$expected" != "$actual" ]; then
    fail "$label 불일치
        정본(Xcode): $(printf '%s' "$expected" | set_str)
        실제(fastlane): $(printf '%s' "$actual" | set_str)
        → $hint"
  fi
}

compare_set "Matchfile 기본 app_identifier" "$IOS_EXPECTED" "$MATCH_IDS" \
  "fastlane/Matchfile 의 app_identifier 목록을 iOS 정본에 맞춰라"
compare_set "Fastfile iOS 레인 app_identifier" "$IOS_EXPECTED" "$FAST_IOS_IDS" \
  "fastlane/Fastfile 의 platform :ios 레인(match 호출)을 iOS 정본에 맞춰라"
compare_set "Fastfile mac 레인 app_identifier" "$MAC_EXPECTED" "$FAST_MAC_IDS" \
  "fastlane/Fastfile 의 platform :mac 레인(match 호출)을 macOS 정본에 맞춰라"

# -----------------------------------------------------------------------------
# 4. NSE(알림 확장)가 프로비저닝 대상에 있는가 — 이름을 붙여 따로 본다.
#    3번의 집합 동치에 이미 포함되지만, 이게 이 배치의 발단이라 실패 메시지를 분리한다.
#    확장이 빠지면 앱만 서명되고 확장은 서명되지 않아 CI 아카이브에서만 터진다.
# -----------------------------------------------------------------------------
NSE_ID="$(printf '%s\n' "$IOS_EXPECTED" | grep -E 'NotificationService$' || true)"
if [ -z "$NSE_ID" ]; then
  fail "$IOS_PBXPROJ 에서 NotificationService 확장 번들 ID를 못 찾았다(확장이 사라졌거나 이름이 바뀌었다)"
else
  for where in "Matchfile:$MATCH_IDS" "Fastfile(ios):$FAST_IOS_IDS"; do
    label="${where%%:*}"
    ids="${where#*:}"
    printf '%s\n' "$ids" | grep -qxF "$NSE_ID" \
      || fail "$label 의 프로비저닝 대상에 NSE 식별자($NSE_ID)가 없다 — 확장은 앱과 별도 프로파일이 필요하다"
  done
fi

# -----------------------------------------------------------------------------
# 5. Appfile — pilot/deliver가 찾는 ASC 앱 레코드 식별자.
#    확장은 ASC 레코드가 없으므로 Appfile에는 "앱"만 있어야 한다.
# -----------------------------------------------------------------------------
IOS_APP_ID="$(printf '%s\n' "$IOS_EXPECTED" | grep -vE 'NotificationService$' | head -n 1)"
if [ "$APP_DEFAULT_IDS" != "$IOS_APP_ID" ]; then
  fail "Appfile 기본 app_identifier 불일치
        기대(iOS 앱): $IOS_APP_ID
        실제: $(printf '%s' "$APP_DEFAULT_IDS" | set_str)
        → Appfile 기본값은 TestFlight/App Store 업로드 대상인 iOS 앱 하나여야 한다"
fi
if [ "$APP_MAC_IDS" != "$MAC_EXPECTED" ]; then
  fail "Appfile for_platform :mac app_identifier 불일치
        기대(macOS 앱): $(printf '%s' "$MAC_EXPECTED" | set_str)
        실제: $(printf '%s' "$APP_MAC_IDS" | set_str)"
fi

# -----------------------------------------------------------------------------
# 6. 앱 ↔ NSE 공유 entitlement 정합.
#    App Group / keychain access group 은 프로파일에 구워지는 값이라 한쪽만 바뀌면
#    서명은 통과하고 런타임에 공유 저장소만 조용히 갈라진다(푸시 토큰·세션 경로).
# -----------------------------------------------------------------------------
APP_ENT='clients/iOS/XcodeHost/MomoiOS.entitlements'
NSE_ENT='clients/iOS/NotificationService/MomoiOSNotificationService.entitlements'
ent_values() {
  # <key>NAME</key> 다음 <array> 안의 <string> 값들
  awk -v key="$2" '
    $0 ~ "<key>" key "</key>" { grab = 1; next }
    grab && /<\/array>/ { grab = 0 }
    grab && /<string>/ {
      line = $0;
      sub(/.*<string>/, "", line);
      sub(/<\/string>.*/, "", line);
      gsub(/[[:space:]]/, "", line);
      print line;
    }
  ' "$1" | sort -u
}
if [ -f "$APP_ENT" ] && [ -f "$NSE_ENT" ]; then
  for key in 'com.apple.security.application-groups' 'keychain-access-groups'; do
    app_vals="$(ent_values "$APP_ENT" "$key")"
    nse_vals="$(ent_values "$NSE_ENT" "$key")"
    if [ -z "$app_vals" ] || [ -z "$nse_vals" ]; then
      fail "entitlements: '$key' 가 앱 또는 NSE 한쪽에서 비어 있다(app='$(printf '%s' "$app_vals" | set_str)' nse='$(printf '%s' "$nse_vals" | set_str)')"
    elif [ "$app_vals" != "$nse_vals" ]; then
      fail "entitlements '$key' 가 앱과 NSE에서 다르다
        app: $(printf '%s' "$app_vals" | set_str)
        nse: $(printf '%s' "$nse_vals" | set_str)
        → 공유 저장소가 갈라진다. 두 타깃은 같은 그룹을 선언해야 한다"
    fi
  done
else
  fail "entitlements 파일을 찾지 못했다: $APP_ENT / $NSE_ENT"
fi

# -----------------------------------------------------------------------------
# 7. 비치명 경고 — 지금 고치지 않지만 CI에서 물릴 지점.
# -----------------------------------------------------------------------------
if grep -qE 'DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*"";' "$MAC_PBXPROJ"; then
  log "WARN(비치명): $MAC_PBXPROJ 의 DEVELOPMENT_TEAM 이 비어 있다 — 자동 서명 CI에서 팀을 못 고른다. docs/cicd/10-ios-signing-identity-runbook.md 참조"
fi

# -----------------------------------------------------------------------------
if [ "$FAILURES" -ne 0 ]; then
  log "FAIL: $FAILURES 건 — fastlane과 Xcode 프로젝트의 서명 식별자가 갈라졌다"
  exit 1
fi

log 'PASS: fastlane 프로비저닝 대상 == Xcode 정본(앱+확장), 자리표시자 없음, 공유 entitlement 일치'
