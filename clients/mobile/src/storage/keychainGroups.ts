// =============================================================================
// The two keychain access groups the app declares (#3121, ADR-0188 §8.7).
//
//   shared    `$(AppIdentifierPrefix)app.momo.ios.shared` — in BOTH entitlement
//             files. The notification extension (NSE) reads the push-fetch item
//             from it while the phone is locked. Anything in this group is
//             readable by that second binary.
//   app-only  `$(AppIdentifierPrefix)app.momo.ios.devicekey` — the app's
//             entitlements alone. The Secure Enclave key handle lived here
//             first (#3026); since #3121 the refresh token does too.
//
// This file holds only names and the one derivation between them, so both
// `push/native.ts` (which resolves the shared group from Info.plist) and
// `storage/secureSession.ts` (which needs the app-only one) can import it
// without importing each other.
// =============================================================================

/**
 * The access group the notification extension reads from, WITHOUT the team
 * prefix — the prefix is injected at build time and only the native side knows
 * it (`src/push/native.ts`).
 *
 * `keychainAccessGroup()` refuses to hand out a group that does not end with
 * this string, so a divergence between the entitlements files and this codebase
 * fails loudly instead of writing to a group nobody reads.
 */
export const NSE_KEYCHAIN_ACCESS_GROUP = 'app.momo.ios.shared';

/**
 * The app-only group, WITHOUT the team prefix. Same string as
 * `DEVICE_KEY_ACCESS_GROUP` (`deviceKey/native.ts`) and
 * `MomoDeviceKeyStore.accessGroupSuffix`; `__tests__/keychainGroups.test.ts`
 * pins all of them together and against the entitlements.
 */
export const APP_ONLY_KEYCHAIN_ACCESS_GROUP = 'app.momo.ios.devicekey';

/**
 * The team-prefixed app-only group, derived from the team-prefixed shared one
 * the native side reports. Same prefix by construction: both groups are the
 * app's own `$(AppIdentifierPrefix)`. Null when the shared group did not
 * resolve (a simulator without the plist key, Jest) — callers then write
 * without a group, exactly as before #3121.
 */
export function appOnlyGroupFrom(sharedGroup: string | null): string | null {
  if (!sharedGroup) {
    return null;
  }
  const suffix = `.${NSE_KEYCHAIN_ACCESS_GROUP}`;
  if (!sharedGroup.endsWith(suffix)) {
    return null;
  }
  return `${sharedGroup.slice(0, -suffix.length)}.${APP_ONLY_KEYCHAIN_ACCESS_GROUP}`;
}
