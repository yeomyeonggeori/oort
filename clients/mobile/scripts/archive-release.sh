#!/usr/bin/env bash
#
# 로컬 TestFlight 업로드용 Release 아카이브를 만들고 검사한다(#2568).
# 절차 전체와 업로드는 docs/runbooks/ios-testflight.md 가 정본이다.
#
# ## 하는 일(순서대로)
#
#   1. 작업 트리가 커밋과 같은지 본다. 증거 빌드는 커밋에서 나와야 한다(M7-I I-1).
#   2. Pods 를 시스템 `pod`(Podfile.lock 의 COCOAPODS 버전)으로 맞춘다.
#   3. 빌드 번호를 아래 규칙으로 정해 Release 아카이브를 만든다(개발 서명).
#   4. IPA 를 로컬에 내보낸다(destination=export). 여기서 배포 서명이 입혀진다.
#   5. 내보낸 앱에 ios/ci_scripts/ci_post_xcodebuild.sh 를 돌려 NSE 임베드·서명된
#      엔타이틀먼트·aps-environment=production 을 검사하고, 업로드용 ExportOptions 와
#      빌드 사실(build-info.txt)을 남긴다.
#
# ## 하지 않는 일
#
# **업로드하지 않는다.** App Store Connect 에 닿는 명령이 이 파일에 없다.
# 업로드는 owner 승인 뒤 사람이 런북대로 한다.
#
# **Apple Developer 사이트와 통신하지 않는다.** `-allowProvisioningUpdates` 를 일부러
# 넘기지 않는다. xcodebuild 도움말대로 그 플래그는 자동 서명 타깃에 대해 프로파일·
# App ID·인증서를 "만들고 갱신한다". 이 스크립트는 이 Mac 에 이미 설치된 프로파일만
# 쓴다. 없으면 만들지 않고 멈춘다.
#
# ## 서명 — Xcode 관리형 프로파일, 자동 서명(2026-09-23 실측)
#
# 이 Mac 의 momo 프로파일은 개발용·App Store 용 모두 Xcode 관리형(IsXcodeManaged=true)
# 이다. 그래서 두 가지가 막혀 있다.
#   - 수동 서명: "Provisioning profile … is Xcode managed, but signing settings require a
#     manually managed profile." 수동 프로파일을 새로 만드는 것은 범위 밖이다.
#   - 자동 서명 + CODE_SIGN_IDENTITY="Apple Distribution": "… is automatically signed for
#     development, but a conflicting code signing identity Apple Distribution has been
#     manually specified."
# 남는 길은 Xcode 의 표준 흐름이다. 아카이브는 자동 서명 그대로(Apple Development +
# 개발 프로파일, 서명된 aps-environment=development) 만들고, 내보내기
# (signingStyle=automatic)가 설치된 App Store 프로파일과 Apple Distribution 인증서로
# 다시 서명한다(aps-environment=production). 둘 다 네트워크 없이 된다.
# 그래서 검사는 아카이브가 아니라 내보낸 앱에 한다. 실제로 올라가는 것이 그것이다.
#
# 프로젝트 파일에는 서명 설정을 넣지 않는다(__tests__/projectShape.test.ts 가 지킨다.
# Xcode Cloud 의 Apple 관리형 서명이 기본값 상태를 기대한다, #1115).
#
# ## 빌드 번호 규칙
#
#   BUILD = 3000 + (한국 시간 기준 날짜 − 2026-09-01) 일수
#   같은 날 다시 올리면 --seq N 으로 BUILD.N (N = 1, 2, …)
#
# Xcode Cloud 는 2000번대를 쓴다(빌드 2035·2039). 로컬 번호는 3000 에서 시작해 그와
# 겹치지 않고, 날짜와 함께만 커지므로 카운터 파일이 필요 없다. ASC 는 같은
# MARKETING_VERSION 안에서 이전 업로드보다 큰 번호만 받는다. 3022 < 3022.1 < 3023 이다.
# 규칙과 다른 번호가 꼭 필요하면 MOMO_IOS_BUILD_NUMBER 로 직접 준다(3000 이상).
# 명령줄 CURRENT_PROJECT_VERSION 은 앱과 NSE 에 같은 값으로 걸린다. 둘의 번호가
# 다르면 ASC 가 경고하므로 이것이 원하는 동작이다.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # clients/mobile
SCHEME="MomoMobile"
WORKSPACE="$APP_DIR/ios/MomoMobile.xcworkspace"
TEAM_ID="YWQQFQM38J"
APP_BUNDLE_ID="app.momo.ios"
NSE_BUNDLE_ID="app.momo.ios.NotificationService"
# Xcode 관리형 프로파일의 이름. Xcode 가 다시 받아도 이름은 같다.
APP_STORE_PROFILE="iOS Team Store Provisioning Profile: $APP_BUNDLE_ID"
NSE_STORE_PROFILE="iOS Team Store Provisioning Profile: $NSE_BUNDLE_ID"
APP_DEV_PROFILE="iOS Team Provisioning Profile: $APP_BUNDLE_ID"
NSE_DEV_PROFILE="iOS Team Provisioning Profile: $NSE_BUNDLE_ID"
# 규칙의 기준일 2026-09-01 을 1970-01-01 부터 센 일수. `date -d`/`date -j` 를 쓰지 않고
# 산수로만 날짜를 다뤄야 리눅스 CI 의 jest 에서도 같은 답이 나온다.
BUILD_EPOCH_DAY=20697
BUILD_BASE=3000
KST_OFFSET_SECONDS=32400

usage() {
  cat <<'EOF'
Usage: clients/mobile/scripts/archive-release.sh [--seq N] [--out DIR]
       clients/mobile/scripts/archive-release.sh --print-build-number [--seq N]

  --seq N               같은 날 N번째 재업로드용 번호(BUILD.N). 기본은 그날 첫 번호.
  --out DIR             아카이브·IPA·로그를 둘 디렉터리. 기본은 새 임시 디렉터리.
                        레포 안은 거부한다.
  --print-build-number  빌드 번호만 출력하고 끝낸다.

환경 변수:
  MOMO_IOS_BUILD_NUMBER  규칙 대신 쓸 빌드 번호(3000 이상).
  MOMO_IOS_BUILD_NOW     규칙이 쓰는 현재 시각(epoch 초). 시험용.

업로드는 하지 않는다. 다음 단계는 docs/runbooks/ios-testflight.md 를 본다.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

SEQ=0
OUT=""
PRINT_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --seq)
      [ $# -ge 2 ] || die "--seq 에 값이 없다"
      SEQ="$2"
      shift 2
      ;;
    --out)
      [ $# -ge 2 ] || die "--out 에 값이 없다"
      OUT="$2"
      shift 2
      ;;
    --print-build-number) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "알 수 없는 인자: $1" ;;
  esac
done

case "$SEQ" in
  ''|*[!0-9]*) die "--seq 는 0 이상의 정수다(받은 값: '$SEQ')" ;;
esac
SEQ=$((10#$SEQ))

build_number() {
  if [ -n "${MOMO_IOS_BUILD_NUMBER:-}" ]; then
    [ "$SEQ" -eq 0 ] || die "MOMO_IOS_BUILD_NUMBER 와 --seq 는 함께 쓸 수 없다"
    # 점은 하나까지. VERSIONING_SYSTEM=apple-generic 이 이 값을 C double 리터럴로도
    # 적기 때문에(`*_vers.c`) 3022.1.1 같은 값은 컴파일을 깨뜨린다.
    case "$MOMO_IOS_BUILD_NUMBER" in
      *[!0-9.]*|.*|*.|*.*.*) die "MOMO_IOS_BUILD_NUMBER 형식이 틀렸다: '$MOMO_IOS_BUILD_NUMBER'" ;;
    esac
    local head="${MOMO_IOS_BUILD_NUMBER%%.*}"
    [ "$((10#$head))" -ge "$BUILD_BASE" ] ||
      die "MOMO_IOS_BUILD_NUMBER 는 $BUILD_BASE 이상이어야 한다(Xcode Cloud 2000번대와 겹치지 않게)"
    printf '%s\n' "$MOMO_IOS_BUILD_NUMBER"
    return
  fi
  local now="${MOMO_IOS_BUILD_NOW:-$(date -u +%s)}"
  case "$now" in
    ''|*[!0-9]*) die "MOMO_IOS_BUILD_NOW 는 epoch 초여야 한다(받은 값: '$now')" ;;
  esac
  local day=$(( (now + KST_OFFSET_SECONDS) / 86400 - BUILD_EPOCH_DAY ))
  [ "$day" -ge 0 ] || die "시계가 규칙 기준일(2026-09-01 KST)보다 이르다"
  local base=$((BUILD_BASE + day))
  if [ "$SEQ" -eq 0 ]; then
    printf '%s\n' "$base"
  else
    printf '%s.%s\n' "$base" "$SEQ"
  fi
}

BUILD="$(build_number)"
if [ "$PRINT_ONLY" -eq 1 ]; then
  printf '%s\n' "$BUILD"
  exit 0
fi

# ---- 여기부터는 macOS 전용 ---------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "iOS 아카이브는 macOS 에서만 만든다"
command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild 가 없다"
command -v node >/dev/null 2>&1 || die "node 가 없다(Podfile 과 번들 단계가 node 를 부른다)"
REPO_ROOT="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
cd "$APP_DIR"

# ---- 1. 커밋과 같은 트리 ------------------------------------------------------
#
# 앱 번들에 들어가는 것은 이 클라이언트와, Metro 가 소스 경로로 묶는 공유 코어다.
# 둘 중 하나라도 커밋과 다르면 빌드 사실(커밋 해시)이 산출물을 설명하지 못한다.
tree_state() {
  git -C "$REPO_ROOT" status --porcelain -- clients/mobile packages/momo-core
}
dirty="$(tree_state)"
[ -z "$dirty" ] || die "커밋되지 않은 변경이 있다. 커밋하거나 되돌린 뒤 다시 돌린다:
$dirty"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
log "commit $COMMIT, build $BUILD"

# ---- 출력 위치(레포 밖) ------------------------------------------------------
if [ -z "$OUT" ]; then
  OUT="$(mktemp -d -t oort-ios-release)"
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
case "$OUT/" in
  "$(cd "$REPO_ROOT" && pwd -P)/"*) die "--out 은 레포 밖이어야 한다(받은 값: $OUT)" ;;
esac
ARCHIVE="$OUT/MomoMobile-$BUILD.xcarchive"
[ ! -e "$ARCHIVE" ] || die "$ARCHIVE 가 이미 있다. 다른 --out 을 쓴다"

# ---- 2. JS 의존성과 Pods -----------------------------------------------------
if [ ! -d node_modules ]; then
  log "node_modules 가 없어 npm ci 를 돌린다(package-lock.json 고정)"
  npm ci --no-audit --no-fund
fi

# 번들 단계는 Xcode 의 셸에서 `command -v node` 로 node 를 찾는다. 명령줄 빌드는 PATH 를
# 물려받지만, 같은 체크아웃을 Xcode 앱에서 열어 아카이브할 때를 위해 ci_post_clone.sh
# 와 같은 방식으로 고정한다. 이 파일은 gitignore 대상이다.
if [ ! -f ios/.xcode.env.local ]; then
  printf 'export NODE_BINARY="%s"\n' "$(command -v node)" >ios/.xcode.env.local
  log "ios/.xcode.env.local 에 NODE_BINARY=$(command -v node) 를 적었다"
fi

# `bundle exec pod install` 은 쓰지 않는다. Gemfile 의 xcodeproj < 1.26 핀 때문에
# CocoaPods 1.15.2 가 서고, 커밋된 lock(시스템 1.17.0 이 씀)을 다시 쓴다.
command -v pod >/dev/null 2>&1 || die "시스템 pod 이 없다(brew install cocoapods)"
LOCK_POD="$(awk '/^COCOAPODS:/ {print $2}' ios/Podfile.lock)"
SYSTEM_POD="$(pod --version)"
[ "$SYSTEM_POD" = "$LOCK_POD" ] ||
  die "시스템 pod $SYSTEM_POD 가 Podfile.lock 의 COCOAPODS $LOCK_POD 와 다르다. lock 을 다시 쓰게 되므로 멈춘다"

if [ ! -f ios/Pods/Manifest.lock ] || ! cmp -s ios/Podfile.lock ios/Pods/Manifest.lock; then
  log "pod install (시스템 pod $SYSTEM_POD)"
  (cd ios && pod install)
  dirty="$(tree_state)"
  [ -z "$dirty" ] || die "pod install 이 추적 파일을 바꿨다. 커밋된 상태를 재현하지 못한 것이다:
$dirty
Podfile.lock 이 바뀌었으면 git checkout -- clients/mobile/ios/Podfile.lock 로 되돌리고
원인(다른 CocoaPods, bundle exec)을 고친 뒤 다시 돌린다. lock 변경은 커밋하지 않는다."
fi
cmp -s ios/Podfile.lock ios/Pods/Manifest.lock || die "ios/Pods 가 Podfile.lock 과 맞지 않는다"

# ---- 서명 자산: 이름과 존재만 본다 --------------------------------------------
#
# 아카이브는 개발 프로파일로, 내보내기는 App Store 프로파일로 서명된다(헤더). 네 개가
# 모두 있어야 Apple 과 통신하지 않고 끝까지 간다. 없으면 만들지 않고 여기서 멈춘다.
profile_installed() {
  local want="$1" dir file name
  for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" \
             "$HOME/Library/MobileDevice/Provisioning Profiles"; do
    [ -d "$dir" ] || continue
    for file in "$dir"/*.mobileprovision; do
      [ -e "$file" ] || continue
      name="$(security cms -D -i "$file" 2>/dev/null | plutil -extract Name raw -o - - 2>/dev/null || true)"
      [ "$name" = "$want" ] && return 0
    done
  done
  return 1
}
for profile in "$APP_STORE_PROFILE" "$NSE_STORE_PROFILE" "$APP_DEV_PROFILE" "$NSE_DEV_PROFILE"; do
  profile_installed "$profile" || die "프로파일 '$profile' 이 이 Mac 에 없다.
       이 스크립트는 프로파일을 만들지 않는다. 런북의 준비물 절을 본다."
done
valid_identity() {
  local count
  count="$(security find-identity -v -p codesigning 2>/dev/null |
    grep "\"$1: " | grep -cv 'CSSMERR\|REVOKED\|EXPIRED' || true)"
  [ "${count:-0}" -ge 1 ]
}
valid_identity "Apple Development" || die "유효한 Apple Development 인증서가 키체인에 없다"
valid_identity "Apple Distribution" || die "유효한 Apple Distribution 인증서가 키체인에 없다"
log "서명 자산: 개발·App Store 프로파일 각 2개, 유효한 Apple Development·Distribution identity 있음"

plist_value() { plutil -extract "$2" raw -o - "$1/Info.plist" 2>/dev/null || true; }
profile_name_of() {
  security cms -D -i "$1/embedded.mobileprovision" 2>/dev/null | plutil -extract Name raw -o - - 2>/dev/null || echo '-'
}
# 첫 Authority 줄이 서명한 인증서의 이름이다. awk 가 입력을 끝까지 읽어야 codesign 이
# SIGPIPE 를 받지 않는다(pipefail).
signer_of() {
  codesign -dv --verbose=2 "$1" 2>&1 | awk -F= '/^Authority=/ && !seen {print $2; seen = 1}'
}
aps_of() {
  codesign -d --entitlements - --xml "$1" 2>/dev/null | sed -n '/<?xml/,/<\/plist>/p' |
    plutil -extract aps-environment raw -o - - 2>/dev/null || echo '-'
}

# ---- 3. 아카이브(개발 서명) ----------------------------------------------------
mkdir -p build
log "archive → $ARCHIVE (log: $OUT/archive.log)"
if ! xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath build/release \
  CURRENT_PROJECT_VERSION="$BUILD" \
  >"$OUT/archive.log" 2>&1; then
  grep -E 'error:|\*\* ARCHIVE FAILED' "$OUT/archive.log" | tail -20 >&2 || true
  die "아카이브 실패. 전체 로그: $OUT/archive.log"
fi
grep -F '** ARCHIVE SUCCEEDED **' "$OUT/archive.log" >/dev/null || die "성공 표지가 로그에 없다: $OUT/archive.log"

ARCHIVED_APP="$ARCHIVE/Products/Applications/MomoMobile.app"
ARCHIVED_APPEX="$ARCHIVED_APP/PlugIns/MomoMobileNotificationService.appex"
[ -d "$ARCHIVED_APPEX" ] || die "아카이브에 알림 확장이 없다: $ARCHIVED_APPEX"
# 아카이브 단계 서명은 사실로 적기만 한다. 개발 서명이라 aps-environment 가 development
# 이고, 그래서 ci_post_xcodebuild.sh 는 5단계(APNs 환경 일치)에서 이 아카이브를 거부한다.
# 검사는 아래에서 실제로 올라갈 배포 서명본에 한다.
ARCHIVE_SIGNER="$(signer_of "$ARCHIVED_APP")"
ARCHIVE_APS="$(aps_of "$ARCHIVED_APP")"
echo "archive-stage: signer='$ARCHIVE_SIGNER' app_profile='$(profile_name_of "$ARCHIVED_APP")' aps-environment=$ARCHIVE_APS"

# ---- 4. 로컬 내보내기(배포 서명, 업로드 없음) ------------------------------------
#
# 두 plist 는 destination 만 다르다. testFlightInternalTestingOnly 는 이 빌드가
# external TestFlight 나 App Store 로 가지 못하게 한다(M7-I 증거 빌드는 내부 전용).
# manageAppVersionAndBuildNumber=false 가 없으면 업로드 때 Xcode 가 위 규칙의 번호를
# 바꿀 수 있다(기본값 YES).
#
# signingStyle=automatic 이다. 프로파일이 Xcode 관리형이라 manual 은 쓸 수 없다(헤더).
# 자동 서명 내보내기에는 provisioningProfiles·signingCertificate 를 넣지 않는다 —
# Xcode 가 signingCertificate 를 거부한다("Remove the "signingCertificate" entry …").
write_export_options() {
  cat >"$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key>
	<string>$2</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>method</key>
	<string>app-store-connect</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>$TEAM_ID</string>
	<key>testFlightInternalTestingOnly</key>
	<true/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
EOF
  plutil -lint "$1" >/dev/null
}
write_export_options "$OUT/ExportOptions-export.plist" export
write_export_options "$OUT/ExportOptions-upload.plist" upload

log "export (로컬 IPA, 업로드 없음) → $OUT/export (log: $OUT/export.log)"
if ! xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions-export.plist" \
  >"$OUT/export.log" 2>&1; then
  grep -E 'error' "$OUT/export.log" | tail -20 >&2 || true
  die "내보내기 실패. 전체 로그: $OUT/export.log"
fi
IPA=""
for candidate in "$OUT/export"/*.ipa; do
  [ -e "$candidate" ] && IPA="$candidate" && break
done
[ -n "$IPA" ] || die "IPA 가 만들어지지 않았다: $OUT/export"

# ---- 5. 검사 — 올라갈 배포 서명본에 ---------------------------------------------
#
# IPA 를 풀어 ci_post_xcodebuild.sh 가 읽는 아카이브 모양
# (<dir>/Products/Applications/MomoMobile.app)으로 놓고 그대로 돌린다. Xcode Cloud 가
# 빌드마다 돌리는 검사와 같은 스크립트, 같은 기준이다. 실패하면 여기서 멈춘다.
EXPORTED="$OUT/export-as-archive"
rm -rf "$OUT/export-unzipped" "$EXPORTED"
mkdir -p "$OUT/export-unzipped" "$EXPORTED/Products/Applications"
ditto -x -k "$IPA" "$OUT/export-unzipped"
cp -R "$OUT/export-unzipped/Payload/MomoMobile.app" "$EXPORTED/Products/Applications/"
APP="$EXPORTED/Products/Applications/MomoMobile.app"
APPEX="$APP/PlugIns/MomoMobileNotificationService.appex"
log "ci_post_xcodebuild.sh — 내보낸 IPA 의 앱 (log: $OUT/ci_post_xcodebuild.log)"
CI_ARCHIVE_PATH="$EXPORTED" CI_XCODEBUILD_ACTION=archive \
  bash ios/ci_scripts/ci_post_xcodebuild.sh 2>&1 | tee "$OUT/ci_post_xcodebuild.log"

for bundle in "$APP" "$APPEX"; do
  got="$(plist_value "$bundle" CFBundleVersion)"
  [ "$got" = "$BUILD" ] || die "$(basename "$bundle") CFBundleVersion 이 '$got' 이다(기대 $BUILD)"
done
MARKETING_VERSION="$(plist_value "$APP" CFBundleShortVersionString)"
[ "$(plist_value "$APPEX" CFBundleShortVersionString)" = "$MARKETING_VERSION" ] ||
  die "앱과 NSE 의 CFBundleShortVersionString 이 다르다"
[ "$(plist_value "$APP" ITSAppUsesNonExemptEncryption)" = "false" ] ||
  die "내보낸 앱에 ITSAppUsesNonExemptEncryption=false 가 없다"
for key in NSCameraUsageDescription NSMicrophoneUsageDescription NSPhotoLibraryUsageDescription; do
  [ -n "$(plist_value "$APP" "$key")" ] || die "내보낸 앱에 $key 가 없다(ITMS-90683)"
done
# testFlightInternalTestingOnly=true 로 내보내면 Xcode 가 앱 Info.plist 에 이 키를 넣는다
# (아카이브에는 없다, 2026-09-23 실측). 서명된 번들 안에 있으므로 이 IPA 를 어떤 경로로
# 올려도 external TestFlight·App Store 로 가지 못한다. M7-I 증거 빌드는 내부 전용이다.
[ "$(plist_value "$APP" TFInternalTestingOnly)" = "true" ] ||
  die "내보낸 앱에 TFInternalTestingOnly=true 가 없다. 내부 테스트 전용이 아닌 빌드는 만들지 않는다"
EXPORT_SIGNER="$(signer_of "$APP")"
case "$EXPORT_SIGNER" in
  "Apple Distribution: "*) ;;
  *) die "내보낸 앱이 배포 인증서로 서명되지 않았다(서명: '$EXPORT_SIGNER')" ;;
esac
[ "$(profile_name_of "$APP")" = "$APP_STORE_PROFILE" ] || die "내보낸 앱의 프로파일이 '$APP_STORE_PROFILE' 이 아니다"
[ "$(profile_name_of "$APPEX")" = "$NSE_STORE_PROFILE" ] || die "내보낸 NSE 의 프로파일이 '$NSE_STORE_PROFILE' 이 아니다"
echo "ok: CFBundleVersion=$BUILD (앱·NSE), CFBundleShortVersionString=$MARKETING_VERSION, 수출 신고·권한 문구 3개, 내부 테스트 전용, 배포 서명·App Store 프로파일"

# ---- 빌드 사실(M7-I I-1) -----------------------------------------------------
{
  echo "commit: $COMMIT"
  echo "marketing_version: $MARKETING_VERSION"
  echo "build: $BUILD"
  echo "signer: $EXPORT_SIGNER"
  echo "app_profile: $(profile_name_of "$APP")"
  echo "nse_profile: $(profile_name_of "$APPEX")"
  echo "aps_environment: $(aps_of "$APP")"
  echo "testflight_internal_only: $(plist_value "$APP" TFInternalTestingOnly)"
  echo "archive_stage_signer: $ARCHIVE_SIGNER"
  echo "archive_stage_aps_environment: $ARCHIVE_APS"
  echo "package_lock_sha256: $(shasum -a 256 package-lock.json | awk '{print $1}')"
  echo "podfile_lock_sha256: $(shasum -a 256 ios/Podfile.lock | awk '{print $1}')"
  echo "ipa_sha256: $(shasum -a 256 "$IPA" | awk '{print $1}')"
  echo "xcode: $(xcodebuild -version | tr '\n' ' ' | sed 's/ *$//')"
  echo "cocoapods: $SYSTEM_POD"
  echo "node: $(node --version)"
  echo "archive: $ARCHIVE"
  echo "ipa: $IPA"
} >"$OUT/build-info.txt"

log "완료 — 업로드는 하지 않았다"
cat "$OUT/build-info.txt"
cat <<EOF

업로드용 ExportOptions: $OUT/ExportOptions-upload.plist
업로드는 owner 승인 뒤에만 docs/runbooks/ios-testflight.md 의 업로드 절대로 한다.
EOF
