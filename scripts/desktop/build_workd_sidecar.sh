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
# target triple and copies it to
# clients/desktop/src-tauri/binaries/momo-workd-<triple>, which
# `bundle.externalBin` puts next to the app executable (Contents/MacOS).
# Release profile unless Tauri says the build is a debug one.
#
# Signing and notarization are NOT done here. The bundler signs the sidecar
# with the app's identity when a signing identity is configured, and
# notarization covers the whole .app. Both happen only in the owner-approved
# release paths (publish_next_build.sh, release-desktop.yml; M7). This script
# only verifies the result.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
TAURI_DIR="$ROOT/clients/desktop/src-tauri"
APP_ID="app.momo.desktop"

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
  sidecar="$app/Contents/MacOS/momo-workd"
  main="$app/Contents/MacOS/oort"
  [ -d "$app" ] || die "no bundle at $app"
  [ -f "$sidecar" ] || die "bundle has no Contents/MacOS/momo-workd"
  [ -x "$sidecar" ] || die "Contents/MacOS/momo-workd is not executable"
  is_mach_o "$sidecar" || die "Contents/MacOS/momo-workd is not a Mach-O (the build.rs placeholder?)"
  "$sidecar" --version >/dev/null 2>&1 || die "momo-workd --version failed"
  echo "ok  sidecar present, Mach-O, runs: $("$sidecar" --version)"
  app_team="$(team_of "$app")"
  side_team="$(team_of "$sidecar")"
  if [ -z "$app_team" ] || [ "$app_team" = "not set" ]; then
    [ "$require_signed" = 1 ] && die "the app is not team-signed"
    echo "note unsigned bundle: the signing checks below are skipped (runtime-unverified)"
    echo "note an unsigned momo-workd answers no control-socket peer unless started with --dev-unsigned-peer"
    return 0
  fi
  [ "$side_team" = "$app_team" ] || die "sidecar team '$side_team' != app team '$app_team'"
  codesign -dv "$sidecar" 2>&1 | grep -q 'flags=.*runtime' || die "sidecar lacks the hardened runtime"
  codesign --verify --strict "$sidecar" || die "sidecar fails codesign --verify --strict"
  codesign --verify --strict --deep "$app" || die "app fails codesign --verify --strict --deep"
  ident="$(codesign -dv "$main" 2>&1 | sed -n 's/^Identifier=//p')"
  [ "$ident" = "$APP_ID" ] || die "app identifier '$ident' != $APP_ID (workd's peer rule names it)"
  req="anchor apple generic and identifier \"$APP_ID\" and certificate leaf[subject.OU] = \"$app_team\""
  codesign --verify -R="$req" "$main" || die "the app does not satisfy workd's peer requirement: $req"
  echo "ok  signed by team $app_team; sidecar same team, hardened runtime; app satisfies: $req"
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
  1. cargo tauri build (beforeBuildCommand builds binaries/momo-workd-<triple>)
     with APPLE_SIGNING_IDENTITY set: the bundler signs Contents/MacOS/momo-workd
     and then the app (hardened runtime, Entitlements.plist).
  2. $0 --verify-bundle "$app" --require-signed
     sidecar Mach-O · same TeamIdentifier as the app · hardened runtime ·
     codesign --verify --strict (--deep for the app) · the app satisfies
     anchor apple generic and identifier "$APP_ID" and certificate leaf[subject.OU] = "<team>"
  3. xcrun notarytool submit … --wait ; xcrun stapler staple "$app"
     (publish_next_build.sh / release-desktop.yml; owner approval per build, M7)
  runtime-unverified until an owner-approved signed build runs step 2:
    - the sidecar's keychain-access-groups entitlement for the ThisDeviceOnly host key
    - workd accepting the signed app on the control socket (SecCodeCheckValidity)
PLAN
    if [ -d "$app" ]; then
      echo "[dry-run] current bundle:"
      verify_bundle "$app" 0 || true
    fi
    exit 0
    ;;
  "") ;;
  *) die "unknown argument $1" ;;
esac

triple="${TAURI_ENV_TARGET_TRIPLE:-$(host_triple)}"
profile=release
[ "${TAURI_ENV_DEBUG:-false}" = true ] && profile=debug
out="$TAURI_DIR/binaries/momo-workd-$triple"
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
mkdir -p "$TAURI_DIR/binaries"
cp "$built" "$out.tmp.$$"
chmod 0755 "$out.tmp.$$"
mv -f "$out.tmp.$$" "$out"
echo "build_workd_sidecar: $out" >&2
