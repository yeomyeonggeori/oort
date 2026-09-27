#!/bin/sh
# scripts/desktop/build_workd_sidecar.sh --verify-bundle (#2778): a bundle
# without the sidecar, or with the build.rs placeholder, is refused; a bundle
# with a real Mach-O sidecar passes (unsigned: signing checks noted, not run).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/desktop/build_workd_sidecar.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

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

expect() { # name want(0|1) args...
  name="$1"; want="$2"; shift 2
  if "$SCRIPT" "$@" >"$TMP/out" 2>&1; then got=0; else got=1; fi
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name (exit $got)"; cat "$TMP/out"; fail=1; fi
}

app="$(bundle missing)"
expect "no sidecar is refused" 1 --verify-bundle "$app"

app="$(bundle placeholder)"
printf '#!/bin/sh\nexit 78\n' > "$app/Contents/MacOS/momo-workd"; chmod +x "$app/Contents/MacOS/momo-workd"
expect "the build.rs placeholder is refused" 1 --verify-bundle "$app"

app="$(bundle real)"
# The real momo-workd, built by cargo (a freshly linked or renamed system
# binary is held or killed by the first-launch checks, which is not what this
# test is about). Missing binary = failure, not a skip.
WORKD_BIN="${MOMO_WORKD_BIN:-$ROOT/server-rust/target/debug/momo-workd}"
[ -x "$WORKD_BIN" ] || { echo "FAIL build momo-workd first: cargo build -p momo-workd --manifest-path server-rust/Cargo.toml"; exit 1; }
cp "$WORKD_BIN" "$app/Contents/MacOS/momo-workd"
expect "a real Mach-O sidecar passes unsigned" 0 --verify-bundle "$app"
expect "unsigned fails --require-signed" 1 --verify-bundle "$app" --require-signed
expect "dry-run-sign executes nothing and exits 0" 0 --dry-run-sign "$app"
grep -q "nothing below is executed" "$TMP/out" || { echo "FAIL dry-run banner"; fail=1; }
exit "$fail"
