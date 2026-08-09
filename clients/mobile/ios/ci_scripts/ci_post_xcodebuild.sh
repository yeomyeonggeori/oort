#!/bin/bash
#
# Xcode Cloud — post-xcodebuild verification of the notification-service embed.
#
# ## What this is for
#
# `docs/cicd/11-ios-push-device-check.md` §1 lists six things "the simulator
# cannot prove" and hands them to a person holding a phone. Two of them — A (the
# extension's **signed** entitlements still carry the shared keychain group) and
# half of C (the APNs environment the build was actually signed for) — stop being
# device-only the moment a build is signed with a real provisioning profile,
# which is exactly what Xcode Cloud does. So they move here, where they run on
# every build instead of whenever someone has 20 minutes and a cable.
#
# `scripts/build-sim.sh` already performs the simulator-provable subset (embed,
# bundle identifiers, Info.plist expansion) on every local build. This is
# deliberately its profile-signed sibling and not a copy: the checks that matter
# most below are the ones build-sim.sh documents as impossible for itself
# (build-sim.sh:137-141 — "an ad-hoc simulator signature embeds an empty
# entitlements dictionary").
#
# The failure this defends against is the runbook's worst one: nothing crashes,
# the build ships, and notifications simply arrive as "oort / 새 알림" forever.
#
# ## When it runs
#
# After every `xcodebuild` invocation in the workflow. Actions that produce no
# archive (test, analyze) are a deliberate no-op — asserting on an artifact the
# action never creates would turn a green test run red for an unrelated reason.
set -euo pipefail

APP_BUNDLE_ID="app.momo.ios"
NSE_BUNDLE_ID="app.momo.ios.NotificationService"
KEYCHAIN_GROUP_SUFFIX="app.momo.ios.shared"
EXPECTED_TEAM="YWQQFQM38J"

log()  { printf '\n=== [ci_post_xcodebuild] %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

ARCHIVE="${CI_ARCHIVE_PATH:-}"
if [ -z "$ARCHIVE" ] || [ ! -d "$ARCHIVE" ]; then
  log "no archive for action '${CI_XCODEBUILD_ACTION:-<unset>}' — nothing to verify (normal for test/analyze)"
  exit 0
fi

APP="$ARCHIVE/Products/Applications/MomoMobile.app"
APPEX="$APP/PlugIns/MomoMobileNotificationService.appex"
WORK="$(mktemp -d -t momo-ci-post-xcodebuild)"
trap 'rm -rf "$WORK"' EXIT

log "archive=$ARCHIVE action=${CI_XCODEBUILD_ACTION:-<unset>}"
[ -d "$APP" ] || fail "$APP is missing from the archive."

# ---- 1. the extension is EMBEDDED, not merely built -------------------------
#
# The app builds, signs, uploads and launches perfectly well with the .appex
# absent. What breaks is visible only on a device, as content that never fills in.
[ -d "$APPEX" ] || fail "$APPEX is missing — this archive embedded no notification extension.
       Check the 'Embed Foundation Extensions' phase and the target dependency."

# ---- 2. each half is signed under its own identifier ------------------------
#
# An app that embeds an extension is signed twice, not once (docs/cicd/10 §0).
# An archive whose .appex was signed with the app's profile is accepted by
# xcodebuild and rejected by App Store Connect an hour later.
assert_signed_as() {
  local path="$1" expected="$2" out
  out="$(codesign -dv "$path" 2>&1)" || fail "codesign could not read $path"
  if grep -q 'linker-signed' <<<"$out"; then
    fail "$(basename "$path") is only linker-signed — no codesign pass ran on it."
  fi
  if ! grep -qx "Identifier=$expected" <<<"$out"; then
    fail "$(basename "$path") is signed under the wrong identifier (expected $expected):
$out"
  fi
  echo "ok: $(basename "$path") Identifier=$expected"
}
assert_signed_as "$APP" "$APP_BUNDLE_ID"
assert_signed_as "$APPEX" "$NSE_BUNDLE_ID"

# ---- 3. the Info.plist substitutions actually expanded ----------------------
#
# An unexpanded `$(AppIdentifierPrefix)` ships as the literal string; the
# keychain lookup then finds nothing, and MomoKeychainValueStore reads a miss as
# "no session" and fails open (build-sim.sh:108-115).
plist_value() { plutil -extract "$2" raw -o - "$1/Info.plist" 2>/dev/null || true; }

app_group="$(plist_value "$APP" MomoKeychainAccessGroup)"
nse_group="$(plist_value "$APPEX" MomoKeychainAccessGroup)"
for pair in "app:$app_group" "extension:$nse_group"; do
  case "${pair#*:}" in
    *'$('*|'') fail "MomoKeychainAccessGroup did not resolve in the ${pair%%:*} (got '${pair#*:}')." ;;
  esac
done
[ "$app_group" = "$nse_group" ] ||
  fail "MomoKeychainAccessGroup differs between the two processes ('$app_group' vs '$nse_group').
       They address one keychain item; a divergence fails open, silently."
echo "ok: MomoKeychainAccessGroup=$app_group in both processes"

# ---- 4. the SIGNED entitlements — the part only a real profile can show ------
#
# docs/cicd/11 §1 item A, and the reason this script exists. Declaring
# `keychain-access-groups` in a .entitlements file is not the same as being
# GRANTED it: the grant comes from the provisioning profile, and a profile
# missing the capability yields a build that installs, launches, and returns
# -34018 from every SecItemAdd — on device only.
#
# Written to a file per bundle rather than piped, because `plutil` is asked
# several different questions about the same document and `fail` inside a
# command substitution would only kill the subshell.
dump_entitlements() {
  # macOS 13+ prints an XML plist on stdout; anything ahead of the declaration is
  # codesign's own chatter and would make plutil reject the document. Chatter can
  # also FOLLOW the plist (first real Xcode Cloud run, build 2035: every extract
  # came back empty while the file was non-empty) — cut at </plist>, not EOF.
  codesign -d --entitlements - --xml "$1" 2>/dev/null | sed -n '/<?xml/,/<\/plist>/p' >"$2"
}
entitlement() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }

assert_keychain_grant() {
  local plist="$1" label="$2" app_id prefix want
  [ -s "$plist" ] || fail "$label carries NO entitlements at all.
       An ad-hoc signature does exactly this; a profile-signed one never does.
       If this fires on Xcode Cloud, the workflow is not signing with a profile."

  app_id="$(entitlement "$plist" application-identifier)"
  if [ -z "$app_id" ]; then
    # Before dying, say what the document actually was — a red assertion that
    # hides its evidence costs a 12-minute cloud round-trip per guess.
    log "diagnostic($label): plutil -lint => $(plutil -lint "$plist" 2>&1 || true)"
    log "diagnostic($label): dumped entitlements (head):"
    head -c 1200 "$plist" >&2 || true
    printf '\n' >&2
    fail "$label has no application-identifier entitlement."
  fi
  prefix="${app_id%%.*}"
  [ "$prefix" = "$EXPECTED_TEAM" ] ||
    fail "$label is signed under team prefix '$prefix', not $EXPECTED_TEAM.
       The App IDs, the App Group and the APNs key all live in $EXPECTED_TEAM
       (docs/cicd/10 §0)."

  want="$prefix.$KEYCHAIN_GROUP_SUFFIX"
  plutil -extract keychain-access-groups xml1 -o - "$plist" 2>/dev/null |
    grep -qF "<string>$want</string>" ||
    fail "$label was signed WITHOUT the shared keychain group $want.
       The profile does not carry keychain-access-groups. On device the extension
       then cannot read the push-fetch session, and every notification stays the
       relay placeholder (docs/cicd/11 §3-1)."
  echo "ok: $label was granted $want"
}

dump_entitlements "$APP" "$WORK/app.plist"
dump_entitlements "$APPEX" "$WORK/appex.plist"
assert_keychain_grant "$WORK/app.plist" "the app"
assert_keychain_grant "$WORK/appex.plist" "the extension"

# The extension must NOT declare aps-environment: it is woken to rewrite a
# notification the HOST app registered for, and declaring it would demand a Push
# capability on an App ID that never uses one
# (NotificationService/MomoMobileNotificationService.entitlements).
[ -z "$(entitlement "$WORK/appex.plist" aps-environment)" ] ||
  fail "the extension was signed WITH aps-environment. It is not an APNs client;
       this is a signing-time surprise waiting at submission."
echo "ok: the extension carries no aps-environment"

# ---- 5. the APNs environment agrees with itself -----------------------------
#
# docs/cicd/11 §3-2: a build whose token is minted against one APNs host and
# delivered from the other produces notifications that simply never arrive, and
# the runbook's stop rule is "the environment must match what it was signed for".
# `src/push/native.ts` refuses to register at all when the Info.plist value is
# missing or unexpanded — so the mismatch is silent in the other direction too.
aps_plist="$(plist_value "$APP" MomoAPNSEnvironment)"
aps_signed="$(entitlement "$WORK/app.plist" aps-environment)"
case "$aps_plist" in
  development|production) ;;
  *) fail "MomoAPNSEnvironment is '${aps_plist:-<missing>}'; the app refuses to register for push in that state (src/push/native.ts)." ;;
esac
[ -n "$aps_signed" ] || fail "the app was signed without aps-environment — its APNs registration cannot work."
[ "$aps_signed" = "$aps_plist" ] ||
  fail "the APNs environment disagrees with itself: the signed entitlement says
       '$aps_signed', Info.plist says '$aps_plist'. The token would be minted
       against one host and pushed from the other."
echo "ok: MomoAPNSEnvironment=$aps_plist, signed aps-environment=$aps_signed"

log "notification-service embed verified on a profile-signed archive"
