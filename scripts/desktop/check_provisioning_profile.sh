#!/usr/bin/env bash
# Developer ID provisioning profile guard for the signed desktop app (#3025).
#
#   check_provisioning_profile.sh --profile <file> --identity "<Developer ID Application: … (TEAM)>"
#                                 [--cert-sha1 <hex>]
#       Before a signed build. Fails unless the profile can authorize
#       clients/desktop/src-tauri/Entitlements.app.plist for this identity.
#
#   check_provisioning_profile.sh --verify-app <oort.app> --profile <file>
#       After signing. Fails unless the app carries that profile and the
#       restricted entitlements, and the momo-workd sidecar carries none.
#
# Why it exists: Entitlements.app.plist asks for keychain-access-groups and
# application-identifier. Signed without a matching embedded profile, macOS
# refuses to launch the app. The build would still succeed, so nothing else
# would notice before a person double-clicks it.
#
# Pre-build checks (all must hold):
#   - the file exists and decodes (security cms -D)
#   - UUID is the pinned one (PINNED_UUID below; a renewed profile is a commit)
#   - Platform has OSX, ProvisionsAllDevices is true (a Developer ID profile)
#   - TeamIdentifier has the team in the identity's parentheses
#   - Entitlements.com.apple.application-identifier = <TEAM>.<tauri.conf identifier>
#     and com.apple.developer.team-identifier = <TEAM>
#   - Entitlements.app.plist asks for exactly that id and team, and each of its
#     keychain-access-groups matches a pattern the profile allows
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

PINNED_UUID="bd2fdf42-52d3-48f8-a8c4-2d4722cdb057"
WARN_DAYS=30

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
TAURI_DIR="$ROOT/clients/desktop/src-tauri"
APP_ENTITLEMENTS="${MOMO_APP_ENTITLEMENTS:-$TAURI_DIR/Entitlements.app.plist}"
TAURI_CONF="$TAURI_DIR/tauri.conf.json"

die() { echo "check_provisioning_profile: $*" >&2; exit 1; }

PROFILE=""
IDENTITY=""
CERT_SHA1=""
VERIFY_APP=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --cert-sha1) CERT_SHA1="${2:-}"; shift 2 ;;
    --verify-app) VERIFY_APP="${2:-}"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$PROFILE" ] || die "usage: --profile <file> (--identity <name> | --verify-app <oort.app>)"
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
  embedded="$app/Contents/embedded.provisionprofile"
  [ -f "$embedded" ] || die "the app has no Contents/embedded.provisionprofile"
  cmp -s "$embedded" "$PROFILE" || die "Contents/embedded.provisionprofile differs from $PROFILE"
  exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$exe" ] || die "bundle Info.plist has no CFBundleExecutable"
  codesign -d --entitlements - --xml "$app" >"$WORK/app-ent.plist" 2>/dev/null \
    || die "cannot read the app's signed entitlements (unsigned?)"
  sidecar="$app/Contents/MacOS/momo-workd"
  [ -f "$sidecar" ] || die "the app has no Contents/MacOS/momo-workd"
  codesign -d --entitlements - --xml "$sidecar" >"$WORK/side-ent.plist" 2>/dev/null \
    || die "cannot read the momo-workd sidecar's signature"
  python3 - "$WORK/profile.plist" "$WORK/app-ent.plist" "$WORK/side-ent.plist" "$APP_ENTITLEMENTS" <<'PY'
import fnmatch, plistlib, sys

profile = plistlib.load(open(sys.argv[1], "rb"))
def load(path):
    data = open(path, "rb").read().strip()
    return plistlib.loads(data) if data else {}
signed, sidecar, wanted = load(sys.argv[2]), load(sys.argv[3]), load(sys.argv[4])
allowed = profile.get("Entitlements", {})
errors = []
for key, value in wanted.items():
    if signed.get(key) != value:
        errors.append("signed app entitlement %s = %r, Entitlements.app.plist wants %r" % (key, signed.get(key), value))
app_id = signed.get("com.apple.application-identifier")
if app_id != allowed.get("com.apple.application-identifier"):
    errors.append("signed application-identifier %r is not the profile's %r" % (app_id, allowed.get("com.apple.application-identifier")))
patterns = allowed.get("keychain-access-groups", [])
for group in signed.get("keychain-access-groups", []):
    if not any(fnmatch.fnmatchcase(group, p) for p in patterns):
        errors.append("signed keychain group %r is not allowed by the profile %r" % (group, patterns))
for key in ("keychain-access-groups", "com.apple.application-identifier", "com.apple.developer.team-identifier"):
    if key in sidecar:
        errors.append("momo-workd sidecar is signed with %s (ADR-0146 D-3: app only; a bare binary has no profile)" % key)
if errors:
    for e in errors:
        print("check_provisioning_profile: " + e, file=sys.stderr)
    sys.exit(1)
print("ok  signed app: embedded profile matches, restricted entitlements present and allowed; sidecar has none")
PY
  exit 0
fi

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

python3 - "$WORK/profile.plist" "$APP_ENTITLEMENTS" "$TAURI_CONF" "$PINNED_UUID" "$TEAM" "$CERT_SHA1" "$WARN_DAYS" <<'PY'
import datetime, fnmatch, hashlib, json, plistlib, subprocess, sys

profile_path, ent_path, conf_path, pinned, team, cert_sha1, warn_days = sys.argv[1:8]
profile = plistlib.load(open(profile_path, "rb"))
wanted = plistlib.load(open(ent_path, "rb"))
identifier = json.load(open(conf_path, encoding="utf-8"))["identifier"]
errors = []

def fail(msg):
    errors.append(msg)

if profile.get("UUID") != pinned:
    fail("profile UUID %r is not the pinned %s (a renewed profile needs PINNED_UUID updated in a commit)" % (profile.get("UUID"), pinned))
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
    fail("Entitlements.app.plist application-identifier %r != %s" % (wanted.get("com.apple.application-identifier"), want_app_id))
if wanted.get("com.apple.developer.team-identifier") != team:
    fail("Entitlements.app.plist team-identifier %r != %s" % (wanted.get("com.apple.developer.team-identifier"), team))
patterns = allowed.get("keychain-access-groups", [])
groups = wanted.get("keychain-access-groups", [])
if not groups:
    fail("Entitlements.app.plist asks for no keychain-access-groups")
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
