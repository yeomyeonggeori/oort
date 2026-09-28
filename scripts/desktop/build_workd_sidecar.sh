#!/bin/sh
# momo-workd sidecar for the desktop bundle (ADR-0188 D2 · R1, #2778).
#
#   build_workd_sidecar.sh                  build and place the sidecar
#   build_workd_sidecar.sh --verify-bundle <oort.app> [--require-signed]
#                                           read-only checks on a built bundle
#   build_workd_sidecar.sh --dry-run-sign <oort.app>
#                                           print what the signed release path
#                                           checks and runs; executes nothing
#
# Build: `cargo tauri build` runs this first (tauri.conf.json
# beforeBuildCommand). It builds `momo-workd` from server-rust for the Tauri
# target triple and wraps it in a helper bundle,
# clients/desktop/src-tauri/binaries/momo-workd.app (#3084), which
# `bundle.macOS.files` copies to oort.app/Contents/Helpers/momo-workd.app.
# Release profile unless Tauri says the build is a debug one.
#
# Why a bundle: workd keeps the host key in the data-protection keychain, which
# needs keychain-access-groups, a restricted entitlement that needs a
# provisioning profile, which only a bundle can carry
# (Contents/embedded.provisionprofile). Its own App ID
# (<TEAM>.app.momo.desktop.workd) keeps its keychain group apart from the
# app's device-key group (ADR-0146 D-3).
#
# The helper is sealed here with an ad-hoc signature, identifier
# app.momo.desktop.workd: the bundler does not sign `files`, and an outer app
# signed over an unsealed nested bundle fails `codesign --verify --deep`
# (measured, #3084). Developer ID signing, the helper's profile and
# Entitlements.workd.plist happen only in the owner-approved release path
# (publish_next_build.sh, inside out: helper, then the app; M7). This script
# only verifies the result.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
TAURI_DIR="$ROOT/clients/desktop/src-tauri"
APP_ID="app.momo.desktop"
HELPER_ID="app.momo.desktop.workd"
HELPER_REL="Contents/Helpers/momo-workd.app"

host_triple() {
  rustc -vV | sed -n 's/^host: //p'
}

die() { echo "build_workd_sidecar: $*" >&2; exit 1; }

is_mach_o() {
  file -b "$1" 2>/dev/null | grep -q '^Mach-O'
}

team_of() {
  codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'
}

verify_bundle() {
  app="$1"; require_signed="$2"
  helper="$app/$HELPER_REL"
  sidecar="$helper/Contents/MacOS/momo-workd"
  [ -d "$app" ] || die "no bundle at $app"
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$exe" ] || die "bundle Info.plist has no CFBundleExecutable"
  main="$app/Contents/MacOS/$exe"
  [ ! -e "$app/Contents/MacOS/momo-workd" ] \
    || die "a bare Contents/MacOS/momo-workd is in the bundle (workd ships as $HELPER_REL)"
  [ -d "$helper" ] || die "bundle has no $HELPER_REL"
  hid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$helper/Contents/Info.plist" 2>/dev/null || true)"
  [ "$hid" = "$HELPER_ID" ] || die "helper CFBundleIdentifier '$hid' != $HELPER_ID"
  hexe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$helper/Contents/Info.plist" 2>/dev/null || true)"
  [ "$hexe" = momo-workd ] || die "helper CFBundleExecutable '$hexe' != momo-workd"
  [ -f "$sidecar" ] || die "bundle has no $HELPER_REL/Contents/MacOS/momo-workd"
  [ -x "$sidecar" ] || die "$HELPER_REL/Contents/MacOS/momo-workd is not executable"
  is_mach_o "$sidecar" || die "$HELPER_REL/Contents/MacOS/momo-workd is not a Mach-O"
  "$sidecar" --version >/dev/null 2>&1 || die "momo-workd --version failed"
  codesign --verify --strict "$helper" 2>/dev/null \
    || die "the helper bundle is not sealed (codesign --verify --strict $HELPER_REL)"
  hsig="$(codesign -dv "$helper" 2>&1 | sed -n 's/^Identifier=//p')"
  [ "$hsig" = "$HELPER_ID" ] || die "helper signing identifier '$hsig' != $HELPER_ID"
  echo "ok  helper $HELPER_REL present, sealed as $HELPER_ID, Mach-O, runs: $("$sidecar" --version)"
  app_team="$(team_of "$app")"
  side_team="$(team_of "$helper")"
  if [ -z "$app_team" ] || [ "$app_team" = "not set" ]; then
    [ "$require_signed" = 1 ] && die "the app is not team-signed"
    echo "note unsigned bundle: the signing checks below are skipped (runtime-unverified)"
    echo "note an unsigned momo-workd answers no control-socket peer unless started with --dev-unsigned-peer"
    return 0
  fi
  [ "$side_team" = "$app_team" ] || die "helper team '$side_team' != app team '$app_team'"
  codesign -dv "$helper" 2>&1 | grep -q 'flags=.*runtime' || die "helper lacks the hardened runtime"
  [ -f "$helper/Contents/embedded.provisionprofile" ] \
    || die "helper has no embedded.provisionprofile (its keychain-access-groups would be refused)"
  codesign --verify --strict --deep "$app" || die "app fails codesign --verify --strict --deep"
  ident="$(codesign -dv "$main" 2>&1 | sed -n 's/^Identifier=//p')"
  [ "$ident" = "$APP_ID" ] || die "app identifier '$ident' != $APP_ID (workd's peer rule names it)"
  req="anchor apple generic and identifier \"$APP_ID\" and certificate leaf[subject.OU] = \"$app_team\""
  codesign --verify -R="$req" "$main" || die "the app does not satisfy workd's peer requirement: $req"
  # The helper must NOT satisfy the app's requirement: the identifier rule is
  # exact, so workd can never pass itself off as the app to another workd.
  ! codesign --verify -R="$req" "$helper" 2>/dev/null \
    || die "the helper satisfies the app's peer requirement ($req)"
  echo "ok  signed by team $app_team; helper same team, hardened runtime, embedded profile; app satisfies: $req"
}

case "${1:-}" in
  --verify-bundle)
    [ $# -ge 2 ] || die "usage: --verify-bundle <oort.app> [--require-signed]"
    verify_bundle "$2" "$([ "${3:-}" = --require-signed ] && echo 1 || echo 0)"
    exit 0
    ;;
  --dry-run-sign)
    [ $# -ge 2 ] || die "usage: --dry-run-sign <oort.app>"
    app="$2"
    cat <<PLAN
[dry-run] signed release path for $app — nothing below is executed.
  1. cargo tauri build (beforeBuildCommand builds binaries/momo-workd.app, sealed
     ad-hoc as $HELPER_ID) with APPLE_SIGNING_IDENTITY set: the bundler copies it
     to $HELPER_REL and signs the app (Entitlements.plist).
     publish_next_build.sh then, inside out:
       a. embeds the workd profile in the helper and signs it with
          Entitlements.workd.plist (<TEAM>.app.momo.desktop.workd only)
       b. embeds the app profile and re-signs the outer app only with
          Entitlements.app.plist (device-key group only; no --deep)
     checked by check_provisioning_profile.sh --verify-app … --workd-profile ….
  2. $0 --verify-bundle "$app" --require-signed
     helper sealed as $HELPER_ID · same TeamIdentifier as the app · hardened
     runtime · embedded profile · codesign --verify --strict --deep for the app ·
     the app satisfies, and the helper does not satisfy,
     anchor apple generic and identifier "$APP_ID" and certificate leaf[subject.OU] = "<team>"
  3. xcrun notarytool submit … --wait ; xcrun stapler staple "$app"
     (publish_next_build.sh / release-desktop.yml; owner approval per build, M7)
  runtime-unverified until an owner-approved signed build runs step 2:
    - AMFI accepting the helper's embedded profile (workd launches)
    - the helper's keychain-access-groups entitlement for the ThisDeviceOnly host key
    - workd accepting the signed app on the control socket (SecCodeCheckValidity)
PLAN
    if [ -d "$app" ]; then
      echo "[dry-run] current bundle:"
      ( verify_bundle "$app" 0 ) || true
    fi
    exit 0
    ;;
  "") ;;
  *) die "unknown argument $1" ;;
esac

triple="${TAURI_ENV_TARGET_TRIPLE:-$(host_triple)}"
profile=release
[ "${TAURI_ENV_DEBUG:-false}" = true ] && profile=debug
helper="$TAURI_DIR/binaries/momo-workd.app"
echo "build_workd_sidecar: momo-workd ($profile, $triple)" >&2
if [ "$profile" = release ]; then
  cargo build --locked --release -p momo-workd --bin momo-workd \
    --manifest-path "$ROOT/server-rust/Cargo.toml" --target "$triple"
else
  cargo build --locked -p momo-workd --bin momo-workd \
    --manifest-path "$ROOT/server-rust/Cargo.toml" --target "$triple"
fi
built="$ROOT/server-rust/target/$triple/$profile/momo-workd"
is_mach_o "$built" || die "cargo did not produce a Mach-O at $built"
version="$("$built" --version 2>/dev/null | awk '{print $NF}')"
[ -n "$version" ] || version=0
mkdir -p "$TAURI_DIR/binaries"
stage="$TAURI_DIR/binaries/.momo-workd.app.tmp.$$"
rm -rf "$stage"
mkdir -p "$stage/Contents/MacOS"
cp "$built" "$stage/Contents/MacOS/momo-workd"
chmod 0755 "$stage/Contents/MacOS/momo-workd"
cat > "$stage/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$HELPER_ID</string>
	<key>CFBundleExecutable</key>
	<string>momo-workd</string>
	<key>CFBundleName</key>
	<string>momo-workd</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSMinimumSystemVersion</key>
	<string>14.0</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST
# Seal the bundle (ad-hoc). The release path re-signs it with Developer ID.
codesign --force --sign - --identifier "$HELPER_ID" "$stage" >/dev/null 2>&1 \
  || die "ad-hoc sealing the helper bundle failed"
rm -rf "$helper"
mv "$stage" "$helper"
rm -f "$TAURI_DIR/binaries/momo-workd-$triple"
echo "build_workd_sidecar: $helper" >&2
