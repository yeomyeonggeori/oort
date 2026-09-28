#!/usr/bin/env bash
# scripts/desktop/check_provisioning_profile.sh (#3025, workd helper #3084) against generated
# fixtures: CMS-signed profiles from a throwaway self-signed certificate, and
# ad-hoc signed fake bundles. No keychain identity, no Developer ID signing, no
# network. Needs macOS (security, codesign, PlistBuddy) and openssl 3.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/desktop/check_provisioning_profile.sh"
PINNED="$(sed -n 's/^PINNED_UUID="\([^"]*\)".*$/\1/p' "$CHECK")"
PINNED_WORKD="$(sed -n 's/^PINNED_WORKD_UUID="\([^"]*\)".*$/\1/p' "$CHECK")"
[ -n "$PINNED" ] && [ -n "$PINNED_WORKD" ] || { echo "[provisioning-profile] FAIL: cannot read the pinned UUIDs" >&2; exit 1; }
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
  # TARGET=workd checks the helper's profile; MOMO_*_ENTITLEMENTS pass through.
  "$CHECK" --target "${TARGET:-app}" --profile "$W/$1.provisionprofile" --identity "$IDENTITY" \
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

# --target workd: the helper's own profile (#3084).
WORKD_ID="${TEAM}.app.momo.desktop.workd"
profile workd UUID="$PINNED_WORKD" "ent.com.apple.application-identifier=$WORKD_ID"
TARGET=workd expect_ok "workd: a Developer ID profile for the helper's App ID" workd
TARGET=workd expect_red "workd: the app's profile is not the helper's" good "not the pinned"
profile workdappid UUID="$PINNED_WORKD"
TARGET=workd expect_red "workd: a profile with the app's App ID" workdappid "profile application-identifier"
expect_red "app: the helper's profile is not the app's" workd "not the pinned"

# The plists themselves: each side asks for exactly its own group.
ENT_APP="$ROOT/clients/desktop/src-tauri/Entitlements.app.plist"
ENT_WORKD="$ROOT/clients/desktop/src-tauri/Entitlements.workd.plist"
ENT_BASE="$ROOT/clients/desktop/src-tauri/Entitlements.plist"
with_group() { # <in plist> <out> <extra group>
  python3 - "$1" "$2" "$3" <<'PY'
import plistlib, sys
p = plistlib.load(open(sys.argv[1], "rb"))
p["keychain-access-groups"] = p.get("keychain-access-groups", []) + [sys.argv[3]]
plistlib.dump(p, open(sys.argv[2], "wb"))
PY
}
with_group "$ENT_WORKD" "$W/workd-devicekey.plist" "${TEAM}.app.momo.desktop.devicekey"
MOMO_WORKD_ENTITLEMENTS="$W/workd-devicekey.plist" TARGET=workd \
  expect_red "workd: Entitlements.workd.plist also asks for the device-key group" workd "never share a group"
with_group "$ENT_APP" "$W/app-workd.plist" "$WORKD_ID"
MOMO_APP_ENTITLEMENTS="$W/app-workd.plist" \
  expect_red "app: Entitlements.app.plist also asks for workd's group" good "never share a group"

# --verify-app on ad-hoc signed fake bundles. Ad-hoc signatures carry readable
# entitlements, which is all this mode reads.
bundle() { # <name> <app entitlements> <helper entitlements> [app profile] [helper profile] [bare]
  local app="$W/$1/oort.app"
  local helper="$app/Contents/Helpers/momo-workd.app"
  mkdir -p "$app/Contents/MacOS" "$helper/Contents/MacOS"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string oort' \
    -c 'Add :CFBundleIdentifier string app.momo.desktop' "$app/Contents/Info.plist" >/dev/null
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string momo-workd' \
    -c 'Add :CFBundleIdentifier string app.momo.desktop.workd' "$helper/Contents/Info.plist" >/dev/null
  cp /usr/bin/true "$app/Contents/MacOS/oort"
  cp /usr/bin/true "$helper/Contents/MacOS/momo-workd"
  [ -z "${6:-}" ] || cp /usr/bin/true "$app/Contents/MacOS/momo-workd"
  [ -z "${4:-}" ] || cp "$W/$4.provisionprofile" "$app/Contents/embedded.provisionprofile"
  [ -z "${5:-}" ] || cp "$W/$5.provisionprofile" "$helper/Contents/embedded.provisionprofile"
  [ -z "${6:-}" ] || codesign --force -s - "$app/Contents/MacOS/momo-workd" 2>/dev/null
  codesign --force -s - --entitlements "$3" "$helper" 2>/dev/null
  codesign --force -s - --entitlements "$2" "$app" 2>/dev/null
}
verify() {
  "$CHECK" --verify-app "$W/$1/oort.app" --profile "$W/good.provisionprofile" \
    --workd-profile "$W/workd.provisionprofile" >"$W/out" 2>&1
}
expect_app() { # <label> <bundle> ok|<fragment>
  if verify "$2"; then
    [ "$3" = ok ] && pass "$1" || bad "$1: expected RED, the check passed"
  elif [ "$3" != ok ] && grep -qF "$3" "$W/out"; then pass "$1 (RED: $(grep -F "$3" "$W/out" | head -1))"
  else bad "$1: $(cat "$W/out")"; fi
}

bundle signed "$ENT_APP" "$ENT_WORKD" good workd
expect_app "signed app + helper: each embeds its profile and holds exactly its own group" signed ok

bundle helperdevice "$ENT_APP" "$W/workd-devicekey.plist" good workd
expect_app "the helper signed with the device-key group" helperdevice "holds the device-key group"

bundle appworkd "$W/app-workd.plist" "$ENT_WORKD" good workd
expect_app "the app signed with workd's group" appworkd "the app holds workd's keychain group"

bundle helperapp "$ENT_APP" "$ENT_APP" good workd
expect_app "the helper signed with the app's entitlements" helperapp "momo-workd helper"

bundle helperbase "$ENT_APP" "$ENT_BASE" good workd
expect_app "the helper signed without its restricted entitlements (bundler plist)" helperbase "Entitlements.workd.plist wants"

bundle base "$ENT_BASE" "$ENT_WORKD" good workd
expect_app "the app signed without the restricted entitlements (bundler plist only)" base "Entitlements.app.plist wants"

bundle noprofile "$ENT_APP" "$ENT_WORKD" "" workd
expect_app "no embedded app profile" noprofile "no Contents/embedded.provisionprofile"

bundle nohelperprofile "$ENT_APP" "$ENT_WORKD" good
expect_app "the helper has no embedded profile" nohelperprofile "the helper has no"

bundle helperwrong "$ENT_APP" "$ENT_WORKD" good good
expect_app "the helper embeds the app's profile" helperwrong "differs from"

profile other2 UUID=11111111-1111-1111-1111-111111111111
bundle otherprofile "$ENT_APP" "$ENT_WORKD" other2 workd
expect_app "a different embedded app profile" otherprofile "differs from"

bundle bare "$ENT_APP" "$ENT_WORKD" good workd bare
expect_app "a bare Contents/MacOS/momo-workd left in the app" bare "a bare Contents/MacOS/momo-workd"

if "$CHECK" --verify-app "$W/signed/oort.app" --profile "$W/good.provisionprofile" >"$W/out" 2>&1; then
  bad "--verify-app without --workd-profile passed"
else pass "--verify-app without --workd-profile (RED)"; fi

# publish_next_build.sh wiring: both profiles are checked before the build;
# then inside out: the workd profile embedded in the helper and the helper
# signed with Entitlements.workd.plist, the app profile embedded and the outer
# .app re-signed with Entitlements.app.plist (never --deep, which would
# re-sign the helper with the app's entitlements), then both checked again
# before notarization.
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
pre_workd = at(r'"\$PROFILE_CHECK" --target workd --profile "\$WORKD_PROVISIONING_PROFILE" --identity "\$SIGN_IDENTITY"')
build = at(r"cargo tauri build")
helper_embed = at(r'install -m 0644 "\$WORKD_PROVISIONING_PROFILE" "\$HELPER_PATH/Contents/embedded\.provisionprofile"')
helper_sign = at(r'--entitlements "\$WORKD_ENTITLEMENTS" --sign "\$SIGN_IDENTITY" "\$HELPER_PATH"')
embed = at(r'install -m 0644 "\$PROVISIONING_PROFILE" "\$APP_PATH/Contents/embedded\.provisionprofile"')
resign = at(r'--entitlements "\$APP_ENTITLEMENTS" --sign "\$SIGN_IDENTITY" "\$APP_PATH"')
verify = at(r'"\$PROFILE_CHECK" --verify-app "\$APP_PATH" --profile "\$PROVISIONING_PROFILE" \\\n\s*--workd-profile "\$WORKD_PROVISIONING_PROFILE"')
verify_helper = at(r'build_workd_sidecar\.sh --verify-bundle "\$APP_PATH" --require-signed')
notary = at(r"notarytool submit")
if not max(pre, pre_workd) < build < helper_embed < helper_sign < embed < resign < verify < verify_helper < notary:
    raise SystemExit("publish_next_build.sh: order is not checks < build < helper embed < helper sign < app embed < app re-sign < verify < verify helper < notarize")
if not re.search(r'HELPER_PATH="\$APP_PATH/Contents/Helpers/momo-workd\.app"', text):
    raise SystemExit("publish_next_build.sh: HELPER_PATH is not Contents/Helpers/momo-workd.app")
if not re.search(r'WORKD_ENTITLEMENTS="clients/desktop/src-tauri/Entitlements\.workd\.plist"', text):
    raise SystemExit("publish_next_build.sh: WORKD_ENTITLEMENTS is not Entitlements.workd.plist")
start = text.rfind("codesign", 0, resign)
stmt = text[start:text.find('"$APP_PATH"', resign)]
if "--deep" in stmt:
    raise SystemExit("publish_next_build.sh: the app re-sign uses --deep (would re-sign the helper)")
if not re.search(r'APP_ENTITLEMENTS="clients/desktop/src-tauri/Entitlements\.app\.plist"', text):
    raise SystemExit("publish_next_build.sh: APP_ENTITLEMENTS is not Entitlements.app.plist")
print("ok")
PY
then pass "publish_next_build.sh: both checks before build, helper then app (no --deep), both verified before notarization"
else bad "$(cat "$W/out")"; fi

if [ "$fails" -gt 0 ]; then
  echo "[provisioning-profile] $fails failure(s)" >&2
  exit 1
fi
echo "[provisioning-profile] all checks passed"
