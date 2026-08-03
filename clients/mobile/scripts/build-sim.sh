#!/usr/bin/env bash
#
# Build the app for the iOS Simulator.
#
# Simulator only, deliberately: installing on a device is the orchestrator's
# step, and a device build additionally needs provisioning this repo does not set
# up here (see `src/storage/secureSession.ts` on the keychain access group).
#
# ## Why this signs, when a simulator build does not need a signature to RUN
#
# It needs one to reach the KEYCHAIN. `CODE_SIGNING_ALLOWED=NO` — what this
# script passed until goal RN-G1 — leaves the product with only the linker's
# ad-hoc signature: `Sealed Resources=none`, `Info.plist=not bound`, and no
# entitlements at all. simulated securityd resolves a keychain request through
# the caller's `application-identifier` / `keychain-access-groups` entitlements,
# so with none present every `SecItemAdd` comes back errSecMissingEntitlement
# (-34018).
#
# `secureSession.ts` catches that (correctly — a failed keychain write must not
# take down a sign-in that is succeeding), so the app kept running and simply
# never remembered anyone. RN-C3 measured it: session restore does not work at
# all in a build produced by the old version of this script, which means the
# `build:sim` gate could never have caught a session-restore regression.
#
# Ad-hoc (`CODE_SIGN_IDENTITY=-`) is enough and needs no Apple account, no
# `match`, and no profile: for the simulator SDK Xcode synthesises the
# entitlements from DEVELOPMENT_TEAM + PRODUCT_BUNDLE_IDENTIFIER rather than
# reading them out of a provisioning profile.
#
# **What this still does not prove.** An ad-hoc simulator signature is not a
# device signature. Anything whose failure needs a real profile stays invisible
# here — most importantly the shared keychain ACCESS GROUP the NSE will read
# (`kSecAttrAccessGroup`), which fails with this same -34018 on device only.
# 이행 순서 5 has to verify that on hardware; this script cannot.
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME="MomoMobile"
WORKSPACE="ios/MomoMobile.xcworkspace"
DESTINATION="${1:-platform=iOS Simulator,name=iPhone 17 Pro}"
PRODUCT="build/sim/Build/Products/Debug-iphonesimulator/MomoMobile.app"

if [ ! -d "$WORKSPACE" ]; then
  echo "error: $WORKSPACE is missing. Run 'pod install' in ios/ first." >&2
  exit 1
fi

xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath build/sim \
  CODE_SIGNING_ALLOWED=YES \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual \
  PROVISIONING_PROFILE_SPECIFIER="" \
  build

# The point of the flags above is the shape of one signature, so check it here
# rather than three launches into `gate:session` as "the session did not
# survive". Measured difference between the two builds:
#
#   CODE_SIGNING_ALLOWED=NO   flags=0x20002(adhoc,linker-signed)
#                             Identifier=MomoMobile   (the executable's name)
#                             Info.plist=not bound · Sealed Resources=none
#   this script               flags=0x2(adhoc)
#                             Identifier=app.momo.ios (the bundle id)
#                             Info.plist entries=33 · Sealed Resources version=2
#
# `linker-signed` is what the linker emits so the binary can run at all; it is
# not a codesign pass, it binds no identity, and it is the state in which the
# keychain refuses to serve the process.
signature="$(codesign -dv "$PRODUCT" 2>&1)"
if grep -q 'linker-signed' <<<"$signature"; then
  echo "error: $PRODUCT is only linker-signed — no codesign pass ran." >&2
  echo "       Every keychain call in it will fail; see the note at the top." >&2
  exit 1
fi
if ! grep -q 'Identifier=app.momo.ios' <<<"$signature"; then
  echo "error: $PRODUCT is signed under the wrong identifier:" >&2
  echo "$signature" >&2
  exit 1
fi

# ---- the notification service extension (goal RN-N1) ------------------------
#
# The app builds and runs perfectly well with the extension missing, so nothing
# above would notice its absence — and the symptom on a device is not "no
# notifications" but "notifications that always say 새 알림", which reads as a
# server problem. Checked here, where a person is already looking at output.
APPEX="$PRODUCT/PlugIns/MomoMobileNotificationService.appex"
if [ ! -d "$APPEX" ]; then
  echo "error: $APPEX is missing — the app did not embed the notification extension." >&2
  echo "       Check the 'Embed Foundation Extensions' phase and the target dependency." >&2
  exit 1
fi

appex_signature="$(codesign -dv "$APPEX" 2>&1)"
if ! grep -q 'Identifier=app.momo.ios.NotificationService' <<<"$appex_signature"; then
  echo "error: $APPEX is signed under the wrong identifier:" >&2
  echo "$appex_signature" >&2
  exit 1
fi

# Both processes build kSecAttrAccessGroup by reading this Info.plist key
# (MomoPushKit/PushNotification.swift:30-32). $(AppIdentifierPrefix) is expanded
# by Xcode at build time; if it does not expand, the shipped value is the literal
# "$(AppIdentifierPrefix)..." and the keychain lookup finds nothing — silently,
# because MomoKeychainValueStore treats a miss as "no session" and fails open.
#
# This IS provable on the simulator, and it is worth proving: it is the one part
# of the access-group story that does not need hardware.
for target_plist in "$PRODUCT/Info.plist" "$APPEX/Info.plist"; do
  group="$(plutil -extract MomoKeychainAccessGroup raw -o - "$target_plist" 2>/dev/null || true)"
  case "$group" in
    *'$('*|'')
      echo "error: MomoKeychainAccessGroup did not resolve in $target_plist (got '${group:-<missing>}')." >&2
      echo "       The extension would fail open and every notification would show the placeholder." >&2
      exit 1
      ;;
  esac
  echo "ok: MomoKeychainAccessGroup=$group in $(basename "$(dirname "$target_plist")")"
done

# Same reasoning for the APNs environment: a build that cannot say which APNs
# host its token belongs to must not register at all (src/push/native.ts).
aps_env="$(plutil -extract MomoAPNSEnvironment raw -o - "$PRODUCT/Info.plist" 2>/dev/null || true)"
if [ "$aps_env" != 'development' ]; then
  echo "error: MomoAPNSEnvironment is '${aps_env:-<missing>}' in this Debug build; expected 'development'." >&2
  exit 1
fi
echo "ok: MomoAPNSEnvironment=$aps_env"

# NOT proved here, on purpose (see the header): that the SIGNED entitlements
# carry the keychain access group. An ad-hoc simulator signature embeds an empty
# entitlements dictionary — verified: `codesign -d --entitlements` on this .appex
# returns `<dict></dict>`. Only a profile-signed device build can show it, which
# is why docs/cicd/20-ios-push-device-check.md exists.
