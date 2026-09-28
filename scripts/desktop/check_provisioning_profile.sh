#!/usr/bin/env bash
# Developer ID provisioning profile guard for the signed desktop app (#3025)
# and its momo-workd helper bundle (#3084).
#
#   check_provisioning_profile.sh --profile <file> --identity "<Developer ID Application: … (TEAM)>"
#                                 [--target app|workd] [--cert-sha1 <hex>]
#       Before a signed build. Fails unless the profile can authorize the
#       target's entitlements file for this identity:
#         app    clients/desktop/src-tauri/Entitlements.app.plist    (oort.app)
#         workd  clients/desktop/src-tauri/Entitlements.workd.plist  (Contents/Helpers/momo-workd.app)
#
#   check_provisioning_profile.sh --verify-app <oort.app> --profile <file> --workd-profile <file>
#       After signing. Fails unless the app and the helper each embed their own
#       profile and carry exactly their own restricted entitlements, the app
#       never holds workd's keychain group, the helper never holds the
#       device-key group (ADR-0146 D-3), and no bare Contents/MacOS/momo-workd
#       is left in the bundle.
#
# Why it exists: both plists ask for keychain-access-groups and
# application-identifier. Signed without a matching embedded profile, macOS
# refuses to launch the code. The build would still succeed, so nothing else
# would notice before a person double-clicks it. Both profiles allow
# <TEAM>.*, so the group split between the app and workd is held here and by
# the desktop Rust tests, not by Apple.
#
# Pre-build checks (all must hold):
#   - the file exists and decodes (security cms -D)
#   - UUID is the target's pinned one (PINNED_UUID / PINNED_WORKD_UUID below;
#     a renewed profile is a commit)
#   - Platform has OSX, ProvisionsAllDevices is true (a Developer ID profile)
#   - TeamIdentifier has the team in the identity's parentheses
#   - Entitlements.com.apple.application-identifier = <TEAM>.<bundle id>
#     (app: the tauri.conf identifier; workd: that + ".workd") and
#     com.apple.developer.team-identifier = <TEAM>
#   - the target's plist asks for exactly that id and team, and for exactly
#     the target's one keychain group (app: <TEAM>.app.momo.desktop.devicekey,
#     workd: <TEAM>.app.momo.desktop.workd), which the profile's patterns allow
#   - DeveloperCertificates has the identity's certificate (SHA-1 from
#     `security find-identity`, or --cert-sha1): the profile authorizes only
#     the certificates it names
#   - expiry: the earlier of the profile's ExpirationDate and that
#     certificate's notAfter is in the future (fail) and more than 30 days
#     away (otherwise a warning)
#
# Nothing here signs, builds or uploads, and nothing secret is printed (a
# profile holds public certificates and ids only).
set -euo pipefail

PINNED_UUID="bd2fdf42-52d3-48f8-a8c4-2d4722cdb057"       # momo desktop Developer ID
PINNED_WORKD_UUID="a8144372-6b25-4d98-b456-3998d660a444" # momo desktop workd Developer ID
WARN_DAYS=30

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
TAURI_DIR="$ROOT/clients/desktop/src-tauri"
APP_ENTITLEMENTS="${MOMO_APP_ENTITLEMENTS:-$TAURI_DIR/Entitlements.app.plist}"
WORKD_ENTITLEMENTS="${MOMO_WORKD_ENTITLEMENTS:-$TAURI_DIR/Entitlements.workd.plist}"
TAURI_CONF="$TAURI_DIR/tauri.conf.json"
HELPER_REL="Contents/Helpers/momo-workd.app"

die() { echo "check_provisioning_profile: $*" >&2; exit 1; }

PROFILE=""
IDENTITY=""
CERT_SHA1=""
VERIFY_APP=""
WORKD_PROFILE=""
TARGET="app"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --cert-sha1) CERT_SHA1="${2:-}"; shift 2 ;;
    --verify-app) VERIFY_APP="${2:-}"; shift 2 ;;
    --workd-profile) WORKD_PROFILE="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$PROFILE" ] || die "usage: --profile <file> (--identity <name> [--target app|workd] | --verify-app <oort.app> --workd-profile <file>)"
[ -f "$PROFILE" ] || die "provisioning profile not found: $PROFILE"
[ -s "$PROFILE" ] || die "provisioning profile is empty: $PROFILE"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/momo-profile-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

decode() { # <cms file> <out plist>
  security cms -D -i "$1" >"$2" 2>"$WORK/cms.err" || {
    sed -n '1,3p' "$WORK/cms.err" >&2
    return 1
  }
  [ -s "$2" ]
}
decode "$PROFILE" "$WORK/profile.plist" || die "cannot decode provisioning profile (not CMS?): $PROFILE"

if [ -n "$VERIFY_APP" ]; then
  app="$VERIFY_APP"
  [ -d "$app" ] || die "no bundle at $app"
  [ -n "$WORKD_PROFILE" ] || die "usage: --verify-app <oort.app> --profile <file> --workd-profile <file>"
  [ -f "$WORKD_PROFILE" ] || die "workd provisioning profile not found: $WORKD_PROFILE"
  decode "$WORKD_PROFILE" "$WORK/workd-profile.plist" \
    || die "cannot decode workd provisioning profile (not CMS?): $WORKD_PROFILE"
  embedded="$app/Contents/embedded.provisionprofile"
  [ -f "$embedded" ] || die "the app has no Contents/embedded.provisionprofile"
  cmp -s "$embedded" "$PROFILE" || die "Contents/embedded.provisionprofile differs from $PROFILE"
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$exe" ] || die "bundle Info.plist has no CFBundleExecutable"
  codesign -d --entitlements - --xml "$app" >"$WORK/app-ent.plist" 2>/dev/null \
    || die "cannot read the app's signed entitlements (unsigned?)"
  [ ! -e "$app/Contents/MacOS/momo-workd" ] \
    || die "a bare Contents/MacOS/momo-workd is in the app (it cannot carry a profile; workd ships as $HELPER_REL)"
  helper="$app/$HELPER_REL"
  [ -d "$helper" ] || die "the app has no $HELPER_REL"
  [ -f "$helper/Contents/embedded.provisionprofile" ] \
    || die "the helper has no $HELPER_REL/Contents/embedded.provisionprofile"
  cmp -s "$helper/Contents/embedded.provisionprofile" "$WORKD_PROFILE" \
    || die "$HELPER_REL/Contents/embedded.provisionprofile differs from $WORKD_PROFILE"
  codesign -d --entitlements - --xml "$helper" >"$WORK/helper-ent.plist" 2>/dev/null \
    || die "cannot read the momo-workd helper's signature"
  python3 - "$WORK/profile.plist" "$WORK/app-ent.plist" "$APP_ENTITLEMENTS" \
    "$WORK/workd-profile.plist" "$WORK/helper-ent.plist" "$WORKD_ENTITLEMENTS" <<'PY'
import fnmatch, plistlib, sys

RESTRICTED = ("keychain-access-groups", "com.apple.application-identifier",
              "com.apple.developer.team-identifier")
def load(path):
    data = open(path, "rb").read().strip()
    return plistlib.loads(data) if data else {}
errors = []
def check(name, profile_path, signed_path, wanted_path, wanted_name):
    profile, signed, wanted = load(profile_path), load(signed_path), load(wanted_path)
    allowed = profile.get("Entitlements", {})
    for key, value in wanted.items():
        if signed.get(key) != value:
            errors.append("signed %s entitlement %s = %r, %s wants %r" % (name, key, signed.get(key), wanted_name, value))
    for key in RESTRICTED:
        if key in signed and key not in wanted:
            errors.append("signed %s carries %s, which %s does not ask for" % (name, key, wanted_name))
    app_id = signed.get("com.apple.application-identifier")
    if app_id != allowed.get("com.apple.application-identifier"):
        errors.append("signed %s application-identifier %r is not its profile's %r" % (name, app_id, allowed.get("com.apple.application-identifier")))
    patterns = allowed.get("keychain-access-groups", [])
    for group in signed.get("keychain-access-groups", []):
        if not any(fnmatch.fnmatchcase(group, p) for p in patterns):
            errors.append("signed %s keychain group %r is not allowed by its profile %r" % (name, group, patterns))
    return signed
app = check("app", sys.argv[1], sys.argv[2], sys.argv[3], "Entitlements.app.plist")
helper = check("momo-workd helper", sys.argv[4], sys.argv[5], sys.argv[6], "Entitlements.workd.plist")
for group in helper.get("keychain-access-groups", []):
    if group.endswith(".app.momo.desktop.devicekey"):
        errors.append("momo-workd helper holds the device-key group %r (ADR-0146 D-3: the app only)" % group)
for group in app.get("keychain-access-groups", []):
    if group.endswith(".app.momo.desktop.workd"):
        errors.append("the app holds workd's keychain group %r (the host key is workd's alone)" % group)
if errors:
    for e in errors:
        print("check_provisioning_profile: " + e, file=sys.stderr)
    sys.exit(1)
print("ok  signed app and momo-workd helper: each embeds its own profile and carries exactly its own restricted entitlements; keychain groups split")
PY
  exit 0
fi

case "$TARGET" in
  app) ENTITLEMENTS="$APP_ENTITLEMENTS"; PINNED="$PINNED_UUID"; SUFFIX=""; GROUP_SUFFIX="app.momo.desktop.devicekey" ;;
  workd) ENTITLEMENTS="$WORKD_ENTITLEMENTS"; PINNED="$PINNED_WORKD_UUID"; SUFFIX=".workd"; GROUP_SUFFIX="app.momo.desktop.workd" ;;
  *) die "--target is app or workd, not '$TARGET'" ;;
esac

[ -n "$IDENTITY" ] || die "usage: --profile <file> --identity \"Developer ID Application: … (TEAM)\""
TEAM="$(printf '%s' "$IDENTITY" | sed -n -E 's/.*\(([A-Z0-9]{10})\)[[:space:]]*$/\1/p')"
[ -n "$TEAM" ] || die "cannot read a 10-character team id from the identity: $IDENTITY"

if [ -z "$CERT_SHA1" ]; then
  # `security find-identity` prints `N) <SHA-1> "<name>"`. Exactly one valid
  # identity must carry the name, or the bundler's pick is ambiguous.
  hashes="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -v name="\"$IDENTITY\"" 'index($0, name) { print $2 }' | sort -u)"
  count="$(printf '%s' "$hashes" | grep -c . || true)"
  [ "$count" = 1 ] || die "expected exactly one valid codesigning identity named '$IDENTITY' in the keychain, found $count"
  CERT_SHA1="$hashes"
fi

python3 - "$WORK/profile.plist" "$ENTITLEMENTS" "$TAURI_CONF" "$PINNED" "$TEAM" "$CERT_SHA1" "$WARN_DAYS" \
  "$SUFFIX" "$GROUP_SUFFIX" <<'PY'
import datetime, fnmatch, hashlib, json, os, plistlib, subprocess, sys

profile_path, ent_path, conf_path, pinned, team, cert_sha1, warn_days, suffix, group_suffix = sys.argv[1:10]
profile = plistlib.load(open(profile_path, "rb"))
wanted = plistlib.load(open(ent_path, "rb"))
ent_name = os.path.basename(ent_path)
identifier = json.load(open(conf_path, encoding="utf-8"))["identifier"] + suffix
errors = []

def fail(msg):
    errors.append(msg)

if profile.get("UUID") != pinned:
    fail("profile UUID %r is not the pinned %s (a renewed profile needs the pinned UUID updated in a commit)" % (profile.get("UUID"), pinned))
if "OSX" not in profile.get("Platform", []):
    fail("profile Platform %r has no OSX" % (profile.get("Platform"),))
if profile.get("ProvisionsAllDevices") is not True:
    fail("profile is not a Developer ID profile (ProvisionsAllDevices is not true)")
if team not in profile.get("TeamIdentifier", []):
    fail("profile TeamIdentifier %r does not include %s" % (profile.get("TeamIdentifier"), team))

allowed = profile.get("Entitlements", {})
want_app_id = "%s.%s" % (team, identifier)
if allowed.get("com.apple.application-identifier") != want_app_id:
    fail("profile application-identifier %r != %s" % (allowed.get("com.apple.application-identifier"), want_app_id))
if allowed.get("com.apple.developer.team-identifier") != team:
    fail("profile team-identifier %r != %s" % (allowed.get("com.apple.developer.team-identifier"), team))
if wanted.get("com.apple.application-identifier") != want_app_id:
    fail("%s application-identifier %r != %s" % (ent_name, wanted.get("com.apple.application-identifier"), want_app_id))
if wanted.get("com.apple.developer.team-identifier") != team:
    fail("%s team-identifier %r != %s" % (ent_name, wanted.get("com.apple.developer.team-identifier"), team))
patterns = allowed.get("keychain-access-groups", [])
groups = wanted.get("keychain-access-groups", [])
want_groups = ["%s.%s" % (team, group_suffix)]
if groups != want_groups:
    fail("%s keychain-access-groups %r != %r (ADR-0146 D-3: the app and workd never share a group)" % (ent_name, groups, want_groups))
for group in groups:
    if not any(fnmatch.fnmatchcase(group, p) for p in patterns):
        fail("keychain group %r is not allowed by the profile's %r" % (group, patterns))

cert_sha1 = cert_sha1.replace(":", "").upper()
cert_end = None
for der in profile.get("DeveloperCertificates", []):
    if hashlib.sha1(der).hexdigest().upper() == cert_sha1:
        out = subprocess.run(["openssl", "x509", "-inform", "DER", "-noout", "-enddate"],
                             input=der, capture_output=True).stdout.decode()
        value = out.strip().split("=", 1)[-1]
        cert_end = datetime.datetime.strptime(value, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
        break
if cert_end is None:
    fail("profile DeveloperCertificates does not include the signing certificate %s" % cert_sha1)

expiry = profile.get("ExpirationDate")
if not isinstance(expiry, datetime.datetime):
    fail("profile has no ExpirationDate")
else:
    expiry = expiry.replace(tzinfo=datetime.timezone.utc)
    if cert_end is not None and cert_end < expiry:
        expiry = cert_end
    now = datetime.datetime.now(datetime.timezone.utc)
    if expiry <= now:
        fail("profile or its certificate expired at %s" % expiry.isoformat())
    elif expiry - now < datetime.timedelta(days=int(warn_days)):
        print("check_provisioning_profile: WARN profile or its certificate expires at %s (under %s days): renew it now" % (expiry.isoformat(), warn_days), file=sys.stderr)

if errors:
    for e in errors:
        print("check_provisioning_profile: " + e, file=sys.stderr)
    sys.exit(1)
print("ok  profile %s: team %s, %s, keychain groups %s, usable until %s" % (pinned, team, want_app_id, groups, expiry.date().isoformat()))
PY
