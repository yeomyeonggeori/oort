import {requireOptionalNativeModule} from 'expo-modules-core';

import {NSE_KEYCHAIN_ACCESS_GROUP} from '../storage/secureSession';

// =============================================================================
// The two values only the native build knows (goal RN-N1).
//
// `modules/momo-push-native` reads them from Info.plist; the long-form reasoning
// for why neither can be a JS constant is in MomoPushNativeModule.swift. In
// short: one is per build CONFIGURATION and the other carries the Apple team
// prefix injected at signing time.
//
// `requireOptionalNativeModule` rather than `requireNativeModule`: the latter
// throws at import time when the native side is absent, which would take down
// every Jest suite that transitively imports this file. Returning null lets the
// callers below answer "this build cannot say", which is the honest answer under
// test and the loud one in a misconfigured build.
// =============================================================================

interface MomoPushNativeConstants {
  /** Raw `MomoAPNSEnvironment` — "development" | "production" | "". */
  readonly apnsEnvironment: string;
  /** Raw `MomoKeychainAccessGroup`, team-prefixed. "" when unresolved. */
  readonly keychainAccessGroup: string;
}

const nativeModule =
  requireOptionalNativeModule<MomoPushNativeConstants>('MomoPushNative');

/** What the devices REST call puts in `env`. Mirrors
 *  `APNSRegistrationEnvironment.from` (MomoiOSKit/PushRegistration.swift:21-31). */
export type ApnsEnvironment = 'sandbox' | 'production';

/**
 * The APNs environment this binary is actually entitled to, or null if the build
 * cannot say.
 *
 * Null is NOT translated into a `__DEV__` guess here, and that is the whole
 * point. The frozen kit fell back to `#if DEBUG` and the 2026-08-02 audit
 * (§7.2 #9) flagged it: a Release build signed with a development profile
 * carries aps-environment=development while the DEBUG flag is false, so the
 * guess registers a sandbox token as production and every push is dropped by
 * APNs with no error anywhere. Callers must treat null as "do not register".
 */
export function apnsEnvironment(): ApnsEnvironment | null {
  switch (nativeModule?.apnsEnvironment?.trim().toLowerCase()) {
    case 'development':
      return 'sandbox';
    case 'production':
      return 'production';
    default:
      return null;
  }
}

/**
 * The team-prefixed keychain access group shared with the notification
 * extension (`YWQQFQM38J.app.momo.ios.shared`), or null if unresolved.
 *
 * Read from the same Info.plist key the extension reads
 * (PushNotification.swift:30-32), so writer and reader cannot disagree about
 * where the item lives.
 */
export function keychainAccessGroup(): string | null {
  const value = nativeModule?.keychainAccessGroup?.trim();
  if (!value) return null;

  // Cross-check against the group name this codebase believes in. The native
  // value carries a team prefix JS cannot know, so only the suffix can be
  // compared — but that is the half that changes when someone edits an
  // entitlements file, and a mismatch here means the app would write to a group
  // the extension does not read. Refusing is the only safe answer: writing to
  // the wrong group looks exactly like success.
  if (!value.endsWith(`.${NSE_KEYCHAIN_ACCESS_GROUP}`)) {
    console.error(
      `[push] keychain access group "${value}" does not end with "${NSE_KEYCHAIN_ACCESS_GROUP}" — entitlements and JS disagree`,
    );
    return null;
  }
  return value;
}

/** True when the native push module is linked at all. Used by diagnostics and
 *  by tests that need to skip device-only paths. */
export function pushNativeModuleAvailable(): boolean {
  return nativeModule != null;
}
