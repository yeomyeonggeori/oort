#!/bin/bash
#
# Xcode Cloud — post-clone bootstrap for the React Native client.
#
# ## Why this file is HERE and not at the repository root
#
# Xcode Cloud looks for `ci_scripts/` **next to the Xcode project or workspace it
# was pointed at**, not at the root of the repository. This is a monorepo whose
# workspace is `clients/mobile/ios/MomoMobile.xcworkspace`, so the only directory
# Xcode Cloud will ever read scripts from is `clients/mobile/ios/ci_scripts/`.
# A copy at the repo root would be silently ignored — the build would go straight
# to `xcodebuild` with no `node_modules` and fail inside the Podfile.
#
# ## Why the order below is not negotiable
#
# `ios/Podfile` is not a self-contained Ruby file. Its first statement shells out
# to **node** to `require.resolve('react-native/scripts/react_native_pods.rb')`
# (Podfile:1-6), and the second does the same for `expo/package.json`
# (Podfile:12-21). So:
#
#     node  →  npm ci  →  bundle install  →  pod install
#     │        │           │                 └─ needs the two above to exist
#     │        │           └─ CocoaPods itself is pinned in Gemfile
#     │        └─ puts react-native/ and expo/ in node_modules
#     └─ without it `pod install` dies on line 2 of the Podfile
#
# Reordering any pair of these produces a failure whose message points at
# CocoaPods rather than at the missing step, which is why it is spelled out.
#
# The repo root is deliberately NOT `npm ci`-ed: this client consumes
# `@momo/core` **by source path** through Metro (`metro.config.js:38,59,66`), so
# `packages/momo-core/src` being checked out is the whole dependency.
#
# ## Running this locally
#
# It is written to be path-independent (everything derives from this file's own
# location) precisely so the Xcode Cloud path can be rehearsed on a laptop:
#
#     git clone <repo> /tmp/clean && /tmp/clean/clients/mobile/ios/ci_scripts/ci_post_clone.sh
#
# Nothing here reads a secret or touches an Apple account. Signing on Xcode Cloud
# is Apple-managed (docs/cicd/10 §8) and needs no `match`, no keychain unlock and
# no credentials in the repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(dirname "$SCRIPT_DIR")"   # clients/mobile/ios
APP_DIR="$(dirname "$IOS_DIR")"      # clients/mobile

log() { printf '\n=== [ci_post_clone] %s\n' "$*"; }

log "ios=$IOS_DIR"
log "app=$APP_DIR"
log "runner=$(sw_vers -productVersion 2>/dev/null || echo '?') xcodebuild=$(xcodebuild -version 2>/dev/null | head -1 || echo '?')"

# ---- 1. node ---------------------------------------------------------------
#
# `.node-version` is the pin, and it is read as a FLOOR rather than as an exact
# match. Xcode Cloud's image preinstalls the current Node 22 LTS (and 24), so a
# floor passes without downloading anything, while an exact pin would force a
# Homebrew install on every single build for no gain. What the floor actually
# defends is the other direction: an image whose default silently rolls back to
# a Node below what `package.json` `engines` declares, where the failure appears
# much later as a Metro or Hermes error.
PIN_FILE="$APP_DIR/.node-version"
NODE_PIN="$(tr -d ' \tv\r\n' <"$PIN_FILE")"
[ -n "$NODE_PIN" ] || { echo "error: $PIN_FILE is empty" >&2; exit 1; }

# `sort -V` rather than hand-rolled integer comparison: three-component versions
# with two-digit minors (22.9 vs 22.11) are exactly where a string compare lies.
version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    version_at_least "$(node --version | tr -d 'v')" "$NODE_PIN"
}

if node_ok; then
  log "node $(node --version) satisfies the >= $NODE_PIN pin"
else
  log "node is missing or below $NODE_PIN (found: $(node --version 2>/dev/null || echo none)) — installing node@22 via Homebrew"
  brew install node@22
  # Versioned Homebrew formulae are keg-only: installing them does not put them
  # on PATH, so this export is the install, not a nicety.
  PATH="$(brew --prefix node@22)/bin:$PATH"
  export PATH
  node_ok || {
    echo "error: still no node >= $NODE_PIN after installing node@22 (found: $(node --version 2>/dev/null || echo none))" >&2
    exit 1
  }
  log "node $(node --version) after install"
fi

# The "Bundle React Native code and images" build phase resolves node through
# `ios/.xcode.env`, which does `command -v node` in ITS OWN shell — a
# non-interactive shell whose PATH is Xcode's, not this script's. If node came
# from a keg-only formula above, that lookup finds nothing and the phase fails
# with `node: command not found` long after this script reported success.
# `.xcode.env.local` is the sanctioned override (RN ships `.xcode.env` reading
# it) and is gitignored, so writing it here pollutes no checkout.
printf 'export NODE_BINARY="%s"\n' "$(command -v node)" >"$IOS_DIR/.xcode.env.local"
log "pinned NODE_BINARY=$(command -v node) into ios/.xcode.env.local"

# ---- 2. JS dependencies ----------------------------------------------------
log "npm ci"
cd "$APP_DIR"
# `ci`, never `install`: a build that may rewrite package-lock.json is a build
# whose dependency graph is not the one that was reviewed.
npm ci --no-audit --no-fund

# ---- 3. Ruby / CocoaPods ---------------------------------------------------
#
# Gemfile pins CocoaPods away from the versions that break iOS builds
# (Gemfile:7-9), and `.bundle/config` sends gems to `vendor/bundle`. Both live in
# clients/mobile, so BUNDLE_GEMFILE is set explicitly rather than relying on
# Bundler's upward search from whatever directory it is invoked in.
export BUNDLE_GEMFILE="$APP_DIR/Gemfile"
log "bundle install"
bundle check >/dev/null 2>&1 || bundle install

# ---- 4. Pods ---------------------------------------------------------------
log "pod install"
cd "$IOS_DIR"
bundle exec pod install

# The workspace is committed (see clients/mobile/.gitignore) so that Xcode Cloud
# can offer it when the workflow is created, but `pod install` is still what
# makes it BUILDABLE — it generates Pods/, the two xcconfigs the app target's
# build configurations reference by name (project.pbxproj:412,446) and the Pods
# project the workspace's second entry points at. Assert the generated half is
# present rather than letting xcodebuild report it as a missing base xcconfig.
for required in \
  "$IOS_DIR/MomoMobile.xcworkspace/contents.xcworkspacedata" \
  "$IOS_DIR/Pods/Pods.xcodeproj" \
  "$IOS_DIR/Pods/Target Support Files/Pods-MomoMobile/Pods-MomoMobile.release.xcconfig"
do
  [ -e "$required" ] || { echo "error: pod install did not produce $required" >&2; exit 1; }
done

log "done — workspace is ready for xcodebuild"
