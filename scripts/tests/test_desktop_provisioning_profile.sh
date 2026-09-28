#!/usr/bin/env bash
# scripts/desktop/check_provisioning_profile.sh (#3025) against generated
# fixtures: CMS-signed profiles from a throwaway self-signed certificate, and
# ad-hoc signed fake bundles. No keychain identity, no Developer ID signing, no
# network. Needs macOS (security, codesign, PlistBuddy) and openssl 3.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/desktop/check_provisioning_profile.sh"
PINNED="$(sed -n 's/^PINNED_UUID="\(.*\)"$/\1/p' "$CHECK")"
TEAM="YWQQFQM38J"
IDENTITY="Developer ID Application: Fixture (${TEAM})"

[ "$(uname)" = Darwin ] || { echo "[provisioning-profile] skip: needs macOS"; exit 0; }

W="$(mktemp -d "${TMPDIR:-/tmp}/momo-profile-test.XXXXXX")"
trap 'rm -rf "$W"' EXIT INT TERM

fails=0
pass() { echo "[provisioning-profile] ok: $*"; }
bad() { echo "[provisioning-profile] FAIL: $*" >&2; fails=$((fails + 1)); }

cert() { # <name> <openssl req date args...>
  local name="$1"; shift
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$W/$name.key" -out "$W/$name.pem" -subj "/CN=$IDENTITY/OU=$TEAM" "$@" 2>/dev/null
  openssl x509 -in "$W/$name.pem" -outform DER -out "$W/$name.der"
}
cert good -days 3650
cert soon -days 10
cert gone -not_before 20200101000000Z -not_after 20200102000000Z
cert other -days 3650
sha1() { shasum -a 1 "$W/$1.der" | cut -d' ' -f1; }

# profile <out> [key=value ...]: a Developer ID profile, then the overrides.
profile() {
  local out="$1"; shift
  python3 - "$W" "$out" "$PINNED" "$TEAM" "$@" <<'PY'
import datetime, plistlib, sys
w, out, pinned, team, *overrides = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None, microsecond=0)
p = {
    "UUID": pinned,
    "Name": "fixture",
    "Platform": ["OSX"],
    "ProvisionsAllDevices": True,
    "TeamIdentifier": [team],
    "ExpirationDate": now + datetime.timedelta(days=3650),
    "DeveloperCertificates": [open(w + "/good.der", "rb").read()],
    "Entitlements": {
        "com.apple.application-identifier": team + ".app.momo.desktop",
        "com.apple.developer.team-identifier": team,
        "keychain-access-groups": [team + ".*"],
    },
}
for item in overrides:
    key, value = item.split("=", 1)
    if key == "days":
        p["ExpirationDate"] = now + datetime.timedelta(days=float(value))
    elif key == "cert":
        p["DeveloperCertificates"] = [open(w + "/" + value + ".der", "rb").read()]
    elif key == "drop":
        p.pop(value)
    elif key.startswith("ent."):
        p["Entitlements"][key[4:]] = [value] if key.endswith("groups") else value
    elif key == "team":
        p["TeamIdentifier"] = [value]
    else:
        p[key] = value
plistlib.dump(p, open(w + "/" + out + ".plist", "wb"))
PY
  openssl cms -sign -nodetach -binary -outform DER -in "$W/$out.plist" \
    -signer "$W/good.pem" -inkey "$W/good.key" -out "$W/$out.provisionprofile"
}

run() { # <profile> [cert name]: prints output, returns the checker's status
  "$CHECK" --profile "$W/$1.provisionprofile" --identity "$IDENTITY" \
    --cert-sha1 "$(sha1 "${2:-good}")" >"$W/out" 2>&1
}
expect_ok() { # <label> <profile> [cert]
  if run "$2" "${3:-}"; then
    if grep -q WARN "$W/out"; then bad "$1: unexpected warning: $(cat "$W/out")"; else pass "$1"; fi
  else bad "$1: expected pass, got: $(cat "$W/out")"; fi
}
expect_warn() {
  if run "$2" "${3:-}" && grep -q "WARN" "$W/out"; then pass "$1"
  else bad "$1: expected pass with a 30-day warning, got: $(cat "$W/out")"; fi
}
expect_red() { # <label> <profile> <message fragment> [cert]
  if run "$2" "${4:-}"; then bad "$1: expected RED, the check passed"
  elif grep -qF "$3" "$W/out"; then pass "$1 (RED: $(grep -F "$3" "$W/out" | head -1))"
  else bad "$1: RED for the wrong reason: $(cat "$W/out")"; fi
}

profile good
expect_ok "a Developer ID profile for this app, team and certificate" good

if "$CHECK" --profile "$W/absent.provisionprofile" --identity "$IDENTITY" --cert-sha1 00 >"$W/out" 2>&1; then
  bad "a missing profile passed"
else grep -q "not found" "$W/out" && pass "missing profile (RED)" || bad "missing profile: $(cat "$W/out")"; fi

cp "$W/good.plist" "$W/plain.provisionprofile"
expect_red "a profile that is not CMS" plain "cannot decode"

profile uuid UUID=00000000-0000-0000-0000-000000000000
expect_red "another profile's UUID" uuid "not the pinned"

profile expired days=-1
expect_red "an expired profile" expired "expired at"

profile d29 days=29
expect_warn "29 days left warns and passes" d29

profile d31 days=31
expect_ok "31 days left passes quietly" d31

profile certsoon cert=soon
expect_warn "the certificate expires first (10 days) and warns" certsoon soon

profile certgone cert=gone
expect_red "the certificate expired" certgone "expired at" gone

profile appid ent.com.apple.application-identifier=${TEAM}.app.momo.other
expect_red "a profile for another App ID" appid "profile application-identifier"

profile team team=ABCDE12345
expect_red "a profile for another team" team "TeamIdentifier"

profile groups "ent.keychain-access-groups=${TEAM}.app.momo.desktop.shared"
expect_red "a profile that does not allow the device-key group" groups "is not allowed by the profile"

profile nocert
expect_red "the signing certificate is not in the profile" nocert "does not include the signing certificate" other

profile devprofile drop=ProvisionsAllDevices
expect_red "a development profile (no ProvisionsAllDevices)" devprofile "not a Developer ID profile"

profile ios Platform=iOS
expect_red "an iOS profile" ios "has no OSX"

if "$CHECK" --profile "$W/good.provisionprofile" --identity "Developer ID Application: No Team" \
  --cert-sha1 "$(sha1 good)" >"$W/out" 2>&1; then bad "an identity without a team passed"
else pass "identity without a team (RED)"; fi

# --verify-app on ad-hoc signed fake bundles. Ad-hoc signatures carry readable
# entitlements, which is all this mode reads.
ENT_APP="$ROOT/clients/desktop/src-tauri/Entitlements.app.plist"
ENT_BASE="$ROOT/clients/desktop/src-tauri/Entitlements.plist"
bundle() { # <name> <app entitlements> <sidecar entitlements> [embed profile]
  local app="$W/$1/oort.app"
  mkdir -p "$app/Contents/MacOS"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string oort' \
    -c 'Add :CFBundleIdentifier string app.momo.desktop' "$app/Contents/Info.plist" >/dev/null
  cp /usr/bin/true "$app/Contents/MacOS/oort"
  cp /usr/bin/true "$app/Contents/MacOS/momo-workd"
  [ -z "${4:-}" ] || cp "$W/$4.provisionprofile" "$app/Contents/embedded.provisionprofile"
  codesign --force -s - --entitlements "$3" "$app/Contents/MacOS/momo-workd" 2>/dev/null
  codesign --force -s - --entitlements "$2" "$app" 2>/dev/null
}
verify() { "$CHECK" --verify-app "$W/$1/oort.app" --profile "$W/good.provisionprofile" >"$W/out" 2>&1; }
expect_app() { # <label> <bundle> ok|<fragment>
  if verify "$2"; then
    [ "$3" = ok ] && pass "$1" || bad "$1: expected RED, the check passed"
  elif [ "$3" != ok ] && grep -qF "$3" "$W/out"; then pass "$1 (RED: $(grep -F "$3" "$W/out" | head -1))"
  else bad "$1: $(cat "$W/out")"; fi
}

bundle signed "$ENT_APP" "$ENT_BASE" good
expect_app "signed app: profile embedded, app has the group, sidecar has none" signed ok

bundle sidecar "$ENT_APP" "$ENT_APP" good
expect_app "the sidecar signed with the device-key group" sidecar "momo-workd sidecar is signed with"

bundle base "$ENT_BASE" "$ENT_BASE" good
expect_app "the app signed without the restricted entitlements (bundler plist only)" base "wants"

bundle noprofile "$ENT_APP" "$ENT_BASE"
expect_app "no embedded profile" noprofile "no Contents/embedded.provisionprofile"

profile other2 UUID=11111111-1111-1111-1111-111111111111
bundle otherprofile "$ENT_APP" "$ENT_BASE" other2
expect_app "a different embedded profile" otherprofile "differs from"

# publish_next_build.sh wiring: the profile is checked before the build, then
# embedded, the outer .app re-signed with Entitlements.app.plist (never --deep,
# which would re-sign the sidecar too), then checked again before notarization.
if python3 - "$ROOT/scripts/publish_next_build.sh" >"$W/out" 2>&1 <<'PY'
import re, sys
lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines()
         if not l.lstrip().startswith("#")]
text = "\n".join(lines)
def at(pattern):
    m = re.search(pattern, text)
    if not m:
        raise SystemExit("publish_next_build.sh: missing %s" % pattern)
    return m.start()
pre = at(r'"\$PROFILE_CHECK" --profile "\$PROVISIONING_PROFILE" --identity "\$SIGN_IDENTITY"')
build = at(r"cargo tauri build")
embed = at(r'install -m 0644 "\$PROVISIONING_PROFILE" "\$APP_PATH/Contents/embedded\.provisionprofile"')
resign = at(r'--entitlements "\$APP_ENTITLEMENTS" --sign "\$SIGN_IDENTITY" "\$APP_PATH"')
verify = at(r'"\$PROFILE_CHECK" --verify-app "\$APP_PATH"')
notary = at(r"notarytool submit")
if not pre < build < embed < resign < verify < notary:
    raise SystemExit("publish_next_build.sh: order is not check < build < embed < re-sign < verify < notarize")
start = text.rfind("codesign", 0, resign)
stmt = text[start:text.find('"$APP_PATH"', resign)]
if "--deep" in stmt:
    raise SystemExit("publish_next_build.sh: the app re-sign uses --deep (would re-sign the sidecar)")
if not re.search(r'APP_ENTITLEMENTS="clients/desktop/src-tauri/Entitlements\.app\.plist"', text):
    raise SystemExit("publish_next_build.sh: APP_ENTITLEMENTS is not Entitlements.app.plist")
print("ok")
PY
then pass "publish_next_build.sh: check before build, embed, re-sign (no --deep), verify before notarization"
else bad "$(cat "$W/out")"; fi

if [ "$fails" -gt 0 ]; then
  echo "[provisioning-profile] $fails failure(s)" >&2
  exit 1
fi
echo "[provisioning-profile] all checks passed"
