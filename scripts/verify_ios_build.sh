#!/usr/bin/env bash
# MOMO-462 IOS-1: build and test MomoiOS on an available iPhone simulator.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
PROJECT="$REPO_ROOT/clients/iOS/MomoiOS.xcodeproj"
DERIVED_DATA="$REPO_ROOT/build"
DEVICE_ID=""
BOOTED_BY_SCRIPT=0

cleanup() {
  if [ "$BOOTED_BY_SCRIPT" -eq 1 ] && [ -n "$DEVICE_ID" ]; then
    xcrun simctl shutdown "$DEVICE_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

command -v xcodebuild >/dev/null 2>&1 || {
  echo "xcodebuild is required for the iOS gate" >&2
  exit 1
}

common_base=(
  -project "$PROJECT"
  -scheme MomoiOS
  -derivedDataPath "$DERIVED_DATA"
  CODE_SIGNING_ALLOWED=NO
)

DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
  xcodebuild build "${common_base[@]}" -destination 'generic/platform=iOS Simulator'

device_list="$(xcrun simctl list devices available)"
device_line="$(grep -E -m 1 'iPhone .*[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}.*\((Booted|Shutdown)\)' <<<"$device_list")"
[ -n "$device_line" ] || {
  echo "no available iPhone simulator was found" >&2
  exit 1
}

DEVICE_ID="$(grep -Eo -m 1 '[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}' <<<"$device_line")"
[ -n "$DEVICE_ID" ] || {
  echo "could not parse the selected iPhone simulator identifier" >&2
  exit 1
}

if ! printf '%s\n' "$device_line" | grep -Fq '(Booted)'; then
  xcrun simctl boot "$DEVICE_ID"
  BOOTED_BY_SCRIPT=1
fi
xcrun simctl bootstatus "$DEVICE_ID" -b

destination="platform=iOS Simulator,id=$DEVICE_ID"
common=(
  "${common_base[@]}"
  -destination "$destination"
)

DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
  xcodebuild build-for-testing "${common[@]}"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
  xcodebuild test-without-building "${common[@]}"

echo "[ios-gate] PASS MomoiOS build-for-testing and test-without-building on $DEVICE_ID"
