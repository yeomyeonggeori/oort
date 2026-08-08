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
#
# 검사 단위는 **프로비저닝 호출 지점 하나하나**다(레인 합집합이 아니다). 이유는
# fastfile_match_sites() 주석 참조 — 합집합으로 보면 이 게이트가 막으려는 실패
# 형태가 그대로 통과한다.
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
# RN 클라이언트(ADR-0137). 2026-08-03 goal RN-N1 에서 NSE 타깃이 붙으면서
# **프로비저닝 대상 iOS 프로젝트가 둘**이 됐다. 둘은 같은 식별자 쌍을 쓴다 —
# RN 이 킷의 자리를 그대로 물려받는 중이고(D8: 킷은 parity 후 은퇴), fastlane 의
# app_identifier 목록 하나가 양쪽을 다 덮어야 하기 때문이다.
RN_PBXPROJ='clients/mobile/ios/MomoMobile.xcodeproj/project.pbxproj'
FASTFILE='fastlane/Fastfile'
APPFILE='fastlane/Appfile'
MATCHFILE='fastlane/Matchfile'

for required in "$IOS_PBXPROJ" "$MAC_PBXPROJ" "$RN_PBXPROJ" "$FASTFILE" "$APPFILE" "$MATCHFILE"; do
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

# Ruby 설정 파일에서 app_identifier 로 넘어가는 문자열을 뽑는다(단일 지점 파일용:
# Matchfile / Appfile). Fastfile은 호출 지점이 여럿이라 아래 전용 파서를 쓴다.
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

# Fastfile 안의 **모든 match(...) 호출**을 지점별 레코드로 뽑는다.
#   출력 1줄 = 프로비저닝 지점 1개: `platform|lane|줄번호|id1 id2 ...`
#
# 왜 레인 합집합이 아니라 호출 지점별인가 (중요):
#   프로비저닝은 레인마다 따로 일어난다. beta 레인에서만 확장 식별자가 빠져도
#   release 레인에 남아 있으면 "iOS 블록 전체의 합집합"은 정본과 여전히 동치라
#   게이트가 통과한다. 그런데 beta는 TestFlight 레인 — 가장 자주 도는 레인이고,
#   로컬에서는 CODE_SIGNING_ALLOWED=NO 라 안 보이며, CI의 확장 서명 단계에서만
#   터진다. 합집합 검사는 이 게이트가 존재하는 이유인 실패 형태를 그대로
#   통과시킨다. 그래서 호출 지점마다 개별 판정한다.
#
# 검사 대상을 넓히려면:
#   프로파일을 고르는 호출이 match 말고 더 생기면(예: gym 의
#   `export_options.provisioningProfiles` 매핑 — CODE_SIGN_STYLE 을 Manual 로
#   돌리면 필요해진다. docs/cicd/10-ios-signing-identity-runbook.md §6)
#   ① 아래 START 정규식에 호출명을 추가하고(`(match|gym)\(`)
#   ② site_ids() 에 그 옵션의 키 목록(provisioningProfiles 의 해시 키) 추출을 더하면
#   같은 지점별 판정이 그대로 적용된다. 지금 Fastfile 의 gym 호출에는 그 옵션이 없다.
fastfile_match_sites() {
  sed 's/#.*$//' "$FASTFILE" | awk -v want="$1" '
    # buf 안에서 app_identifier 에 넘어가는 번들 ID들을 공백으로 이어 반환.
    function site_ids(buf,   part, tok, out) {
      out = "";
      if (match(buf, /app_identifier:[[:space:]]*\[[^]]*\]/)) {
        part = substr(buf, RSTART, RLENGTH);
      } else if (match(buf, /app_identifier:[[:space:]]*"[^"]*"/)) {
        part = substr(buf, RSTART, RLENGTH);
      } else {
        return "";     # app_identifier 자체가 없는 호출 → 빈 집합으로 불일치 처리
      }
      while (match(part, /"[^"]+"/)) {
        tok = substr(part, RSTART + 1, RLENGTH - 2);
        if (tok ~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ && index(tok, ".") > 0)
          out = out (out == "" ? "" : " ") tok;
        part = substr(part, RSTART + RLENGTH);
      }
      return out;
    }
    function emit() {
      if (plat == want) print plat "|" (lane == "" ? "(레인밖)" : lane) "|" startline "|" site_ids(buf);
    }
    /^platform :ios do/ { plat = "ios"; lane = ""; next }
    /^platform :mac do/ { plat = "mac"; lane = ""; next }
    /^end[[:space:]]*$/ { plat = ""; lane = ""; next }
    {
      line = $0;
      if (line ~ /^[[:space:]]+lane[[:space:]]+:/) {
        l = line; sub(/.*lane[[:space:]]+:/, "", l); sub(/[^A-Za-z0-9_].*/, "", l); lane = l;
      }
      if (capturing == 0 && line ~ /(^|[^A-Za-z0-9_])match\(/) {
        capturing = 1; buf = line; startline = NR;
        tmp = line; depth = gsub(/\(/, "(", tmp) - gsub(/\)/, ")", tmp);
        if (depth <= 0) { emit(); capturing = 0 }
        next;
      }
      if (capturing == 1) {
        buf = buf " " line;
        tmp = line; depth += gsub(/\(/, "(", tmp) - gsub(/\)/, ")", tmp);
        if (depth <= 0) { emit(); capturing = 0 }
      }
    }
  '
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
norm_set() { printf '%s' "$1" | tr ' ' '\n' | grep -v '^$' | sort -u; }

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

NSE_ID="$(printf '%s\n' "$IOS_EXPECTED" | grep -E 'NotificationService$' || true)"
if [ -z "$NSE_ID" ]; then
  fail "$IOS_PBXPROJ 에서 NotificationService 확장 번들 ID를 못 찾았다(확장이 사라졌거나 이름이 바뀌었다)"
fi

# -----------------------------------------------------------------------------
# 2b. RN 프로젝트도 같은 식별자 집합이어야 한다 (goal RN-N1).
#
#     fastlane 은 app_identifier 목록을 **하나** 들고 두 프로젝트를 다 서명한다.
#     RN 쪽이 다른 식별자를 쓰기 시작하면 아래 3~5번 검사는 여전히 통과하는데
#     (그것들은 킷을 정본으로 본다) 정작 출하되는 앱의 프로파일이 없다.
#     즉 **이 게이트가 존재하는 이유인 실패가 게이트를 통과해서 지나간다.**
#     RN 이 킷을 대체하는 중이므로(ADR-0137 D8) 두 집합은 동치여야 한다.
# -----------------------------------------------------------------------------
RN_EXPECTED="$(pbx_provisioned_ids "$RN_PBXPROJ")"
[ -n "$RN_EXPECTED" ] || fail "$RN_PBXPROJ: 프로비저닝 대상 번들 ID를 하나도 못 뽑았다(파서 전제 붕괴)"
log "Xcode 정본 — RN(iOS): $(printf '%s' "$RN_EXPECTED" | set_str)"

if [ "$IOS_EXPECTED" != "$RN_EXPECTED" ]; then
  fail "RN 프로젝트와 동결 킷의 프로비저닝 대상이 다르다
        킷($IOS_PBXPROJ): $(printf '%s' "$IOS_EXPECTED" | set_str)
        RN($RN_PBXPROJ):  $(printf '%s' "$RN_EXPECTED" | set_str)
        → 둘은 같은 App ID 쌍을 물려받는 관계다. 한쪽만 바꾸면 fastlane 의
          app_identifier 목록이 다른 쪽을 서명하지 못한다"
fi
if ! printf '%s\n' "$RN_EXPECTED" | grep -qE 'NotificationService$'; then
  fail "$RN_PBXPROJ 에 NotificationService 확장 타깃이 없다 — 푸시 승계(ADR-0120 D2-A)가 빠진 빌드다"
fi

# -----------------------------------------------------------------------------
# 3. Matchfile 기본값 == iOS 정본
#    (Matchfile은 프로비저닝 지점이 하나뿐이다. 성재가 `fastlane match appstore`를
#     맨손으로 돌릴 때 실제로 쓰이는 값이라 Fastfile과 별개로 본다.)
# -----------------------------------------------------------------------------
MATCH_IDS="$(ruby_app_identifiers <"$MATCHFILE")"
if [ "$IOS_EXPECTED" != "$MATCH_IDS" ]; then
  fail "Matchfile 기본 app_identifier 불일치
        정본(Xcode): $(printf '%s' "$IOS_EXPECTED" | set_str)
        실제(fastlane): $(printf '%s' "$MATCH_IDS" | set_str)
        → fastlane/Matchfile 의 app_identifier 목록을 iOS 정본에 맞춰라"
fi
if [ -n "$NSE_ID" ] && ! printf '%s\n' "$MATCH_IDS" | grep -qxF "$NSE_ID"; then
  fail "Matchfile 의 프로비저닝 대상에 NSE 식별자($NSE_ID)가 없다 — 확장은 앱과 별도 프로파일이 필요하다"
fi

# -----------------------------------------------------------------------------
# 4. Fastfile — match 호출 **지점마다** 개별 판정.
#    한 레인만 확장을 잃어도 잡아야 한다(합집합 검사로는 못 잡는다).
#
#    macOS도 동일하게 지점별로 본다. mac은 최초 생성 시 CLI에서
#    `--app_identifier com.dawnkim.momo`를 명시하는 규약이지만, Fastfile의
#    match 호출은 CI가 실제로 실행하는 프로비저닝 지점이므로 성질이 같다.
#    다른 점은 "기대 집합이 macOS 정본"이라는 것뿐이라 같은 로직에 기대값만 바꿔 쓴다.
# -----------------------------------------------------------------------------
check_match_sites() {
  local platform="$1" expected="$2" sites="$3" require_nse="$4"
  local count=0 plat lane lineno ids actual

  while IFS='|' read -r plat lane lineno ids; do
    [ -n "$plat" ] || continue
    count=$((count + 1))
    actual="$(norm_set "$ids")"
    if [ "$expected" != "$actual" ]; then
      fail "Fastfile:$lineno ($platform 플랫폼, lane :$lane) 의 match 호출 app_identifier 불일치
        정본(Xcode): $(printf '%s' "$expected" | set_str)
        실제(이 호출): $(printf '%s' "$actual" | set_str)
        → 이 호출 지점 하나만 어긋나도 해당 레인의 서명이 CI에서 깨진다"
    fi
    if [ "$require_nse" = 'yes' ] && [ -n "$NSE_ID" ] && ! printf '%s\n' "$actual" | grep -qxF "$NSE_ID"; then
      fail "Fastfile:$lineno (lane :$lane) 의 프로비저닝 대상에 NSE 식별자($NSE_ID)가 없다 — 확장은 앱과 별도 프로파일이 필요하다"
    fi
  done <<<"$sites"

  if [ "$count" -eq 0 ]; then
    fail "$FASTFILE: $platform 플랫폼 블록에서 match 호출을 하나도 찾지 못했다(파서 전제 붕괴 또는 프로비저닝 누락)"
  else
    log "$platform: match 호출 지점 ${count}개 개별 검사"
  fi
}

check_match_sites 'ios' "$IOS_EXPECTED" "$(fastfile_match_sites ios)" 'yes'
check_match_sites 'mac' "$MAC_EXPECTED" "$(fastfile_match_sites mac)" 'no'

# -----------------------------------------------------------------------------
# 5. Appfile — pilot/deliver가 찾는 ASC 앱 레코드 식별자.
#    확장은 ASC 레코드가 없으므로 Appfile에는 "앱"만 있어야 한다.
# -----------------------------------------------------------------------------
APP_DEFAULT_IDS="$(appfile_section default | ruby_app_identifiers)"
APP_MAC_IDS="$(appfile_section mac | ruby_app_identifiers)"
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
# XML 주석을 걷어낸 본문만 낸다.
#
# entitlements 파일에는 "여기에 왜 aps-environment 를 두지 않는가" 같은 설명이
# 주석으로 들어간다. 주석 속의 키 이름을 선언으로 오독하면 이 게이트는 설명이
# 잘 붙은 파일을 실패시키고, 그 결과 다음 사람은 설명을 지우게 된다 — 게이트가
# 문서를 깎아 내는 방향으로 압력을 거는 셈이다. 구조만 본다.
ent_body() {
  awk '
    {
      line = $0
      while (1) {
        if (inc) {
          e = index(line, "-->")
          if (e == 0) { line = ""; break }
          line = substr(line, e + 3); inc = 0
        }
        s = index(line, "<!--")
        if (s == 0) break
        rest = substr(line, s + 4)
        e = index(rest, "-->")
        if (e == 0) { line = substr(line, 1, s - 1); inc = 1; break }
        line = substr(line, 1, s - 1) substr(rest, e + 3)
      }
      print line
    }
  ' "$1"
}

# 선언된 <key>NAME</key> 가 있는가 (주석 제외).
ent_has_key() {
  ent_body "$1" | grep -q "<key>$2</key>"
}

ent_values() {
  # <key>NAME</key> 다음 <array> 안의 <string> 값들
  ent_body "$1" | awk -v key="$2" '
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
check_entitlement_pair() {
  local label="$1" app_ent="$2" nse_ent="$3"
  local key app_vals nse_vals

  if [ ! -f "$app_ent" ] || [ ! -f "$nse_ent" ]; then
    fail "[$label] entitlements 파일을 찾지 못했다: $app_ent / $nse_ent"
    return 0
  fi

  for key in 'com.apple.security.application-groups' 'keychain-access-groups'; do
    app_vals="$(ent_values "$app_ent" "$key")"
    nse_vals="$(ent_values "$nse_ent" "$key")"
    if [ -z "$app_vals" ] || [ -z "$nse_vals" ]; then
      fail "[$label] entitlements: '$key' 가 앱 또는 NSE 한쪽에서 비어 있다(app='$(printf '%s' "$app_vals" | set_str)' nse='$(printf '%s' "$nse_vals" | set_str)')"
    elif [ "$app_vals" != "$nse_vals" ]; then
      fail "[$label] entitlements '$key' 가 앱과 NSE에서 다르다
        app: $app_vals
        nse: $nse_vals
        → 공유 저장소가 갈라진다. 두 타깃은 같은 그룹을 선언해야 한다"
    fi
  done

  # aps-environment 의 비대칭은 오타가 아니라 설계다. 확장은 APNs 클라이언트가
  # 아니라 호스트가 받은 알림을 가공할 뿐이라 이 capability 가 필요 없고,
  # 선언하면 확장 App ID 에 쓰지도 않을 Push Notifications capability 를 요구하게
  # 된다. 반대로 앱에서 빠지면 등록 자체가 안 된다.
  if ! ent_has_key "$app_ent" 'aps-environment'; then
    fail "[$label] 앱 entitlements 에 aps-environment 가 없다 — APNs 등록이 불가능한 빌드다"
  fi
  if ent_has_key "$nse_ent" 'aps-environment'; then
    fail "[$label] NSE entitlements 에 aps-environment 가 선언돼 있다 — 확장은 푸시를 받지 않는다(가공만 한다)"
  fi
}

check_entitlement_pair '동결 킷' \
  'clients/iOS/XcodeHost/MomoiOS.entitlements' \
  'clients/iOS/NotificationService/MomoiOSNotificationService.entitlements'

check_entitlement_pair 'RN' \
  'clients/mobile/ios/MomoMobile/MomoMobile.entitlements' \
  'clients/mobile/ios/NotificationService/MomoMobileNotificationService.entitlements'

# 두 프로젝트가 같은 App ID 쌍을 쓰므로 **공유 그룹 문자열도 같아야** 한다.
# 다르면 프로파일은 발급되는데 킷과 RN 이 서로 다른 키체인 그룹을 보게 되고,
# 그 차이는 기기에서만, 그것도 조용히 드러난다.
for key in 'com.apple.security.application-groups' 'keychain-access-groups'; do
  kit_vals="$(ent_values 'clients/iOS/XcodeHost/MomoiOS.entitlements' "$key" 2>/dev/null || true)"
  rn_vals="$(ent_values 'clients/mobile/ios/MomoMobile/MomoMobile.entitlements' "$key" 2>/dev/null || true)"
  if [ -n "$kit_vals" ] && [ -n "$rn_vals" ] && [ "$kit_vals" != "$rn_vals" ]; then
    fail "'$key' 가 동결 킷과 RN 에서 다르다
        kit: $kit_vals
        rn:  $rn_vals
        → 같은 App ID 를 쓰는 두 빌드가 서로 다른 공유 그룹을 선언하고 있다"
  fi
done

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

log 'PASS: 모든 프로비저닝 호출 지점 == Xcode 정본(앱+확장), 자리표시자 없음, 공유 entitlement 일치'
