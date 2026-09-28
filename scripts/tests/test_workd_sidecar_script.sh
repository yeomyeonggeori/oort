#!/bin/sh
# scripts/desktop/build_workd_sidecar.sh --verify-bundle (#2778, helper bundle
# #3084): a bundle without the workd helper, with a bare Contents/MacOS
# sidecar, with an unsealed or misnamed helper, or with a non-Mach-O inside it
# is refused; a bundle with a sealed helper around the real momo-workd passes
# (unsigned: signing checks noted, not run).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/desktop/build_workd_sidecar.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# The real momo-workd, built by cargo (a freshly linked or renamed system
# binary is held or killed by the first-launch checks, which is not what this
# test is about). Missing binary = failure, not a skip.
WORKD_BIN="${MOMO_WORKD_BIN:-$ROOT/server-rust/target/debug/momo-workd}"
[ -x "$WORKD_BIN" ] || { echo "FAIL build momo-workd first: cargo build -p momo-workd --manifest-path server-rust/Cargo.toml"; exit 1; }

bundle() {
  # Not named *.app: exec inside an unsigned .app triggers a Gatekeeper
  # assessment that can wait on a dialog. The checks read paths only.
  app="$TMP/$1/oort-bundle"
  mkdir -p "$app/Contents/MacOS"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>momo-desktop</string></dict></plist>
PLIST
  cp /usr/bin/true "$app/Contents/MacOS/momo-desktop"
  echo "$app"
}

helper() { # <app> <CFBundleIdentifier> <executable source> seal|noseal
  h="$1/Contents/Helpers/momo-workd.app"
  mkdir -p "$h/Contents/MacOS"
  cat > "$h/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$2</string>
<key>CFBundleExecutable</key><string>momo-workd</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
  cp "$3" "$h/Contents/MacOS/momo-workd"
  chmod +x "$h/Contents/MacOS/momo-workd"
  [ "$4" = noseal ] || codesign --force -s - --identifier "$2" "$h" >/dev/null 2>&1
}

expect() { # name want(0|1) args...
  name="$1"; want="$2"; shift 2
  if "$SCRIPT" "$@" >"$TMP/out" 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name (exit $got)"; cat "$TMP/out"; fail=1; fi
}
expect_reason() { # name fragment args...
  name="$1"; frag="$2"; shift 2
  if "$SCRIPT" "$@" >"$TMP/out" 2>&1; then echo "FAIL $name: expected RED, passed"; fail=1
  elif grep -qF "$frag" "$TMP/out"; then echo "ok   $name (RED: $(grep -F "$frag" "$TMP/out" | head -1))"
  else echo "FAIL $name: RED for the wrong reason"; cat "$TMP/out"; fail=1; fi
}

app="$(bundle missing)"
expect_reason "no helper is refused" "has no Contents/Helpers/momo-workd.app" --verify-bundle "$app"

app="$(bundle bare)"
helper "$app" app.momo.desktop.workd "$WORKD_BIN" seal
cp "$WORKD_BIN" "$app/Contents/MacOS/momo-workd"
expect_reason "a bare Contents/MacOS/momo-workd is refused" "a bare Contents/MacOS/momo-workd" --verify-bundle "$app"

app="$(bundle placeholder)"
printf '#!/bin/sh\nexit 78\n' > "$TMP/placeholder.sh"
helper "$app" app.momo.desktop.workd "$TMP/placeholder.sh" seal
expect_reason "a non-Mach-O inside the helper is refused" "is not a Mach-O" --verify-bundle "$app"

app="$(bundle unsealed)"
helper "$app" app.momo.desktop.workd "$WORKD_BIN" noseal
expect_reason "an unsealed helper is refused" "not sealed" --verify-bundle "$app"

app="$(bundle misnamed)"
helper "$app" app.momo.desktop "$WORKD_BIN" seal
expect_reason "a helper with the app's identifier is refused" "CFBundleIdentifier" --verify-bundle "$app"

app="$(bundle real)"
helper "$app" app.momo.desktop.workd "$WORKD_BIN" seal
expect "a sealed helper around the real momo-workd passes unsigned" 0 --verify-bundle "$app"
expect "unsigned fails --require-signed" 1 --verify-bundle "$app" --require-signed
expect "dry-run-sign executes nothing and exits 0" 0 --dry-run-sign "$app"
grep -q "nothing below is executed" "$TMP/out" || { echo "FAIL dry-run banner"; fail=1; }
exit "$fail"
