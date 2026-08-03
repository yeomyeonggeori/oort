// =============================================================================
// The push contract, mirrored from Swift (goal RN-N1, ADR-0137 이행 순서 5).
//
// Every constant here has a counterpart in
// `clients/mobile/ios/MomoPushKit/PushNotification.swift`, which is itself a
// byte-for-byte copy of the frozen kit's `MomoiOSPushKit`. Two processes agree on
// these strings or the feature does not work:
//
//   - The APP (this JS) writes the fetch session into the keychain.
//   - The EXTENSION (Swift, separate binary) reads it while the phone is locked.
//
// There is no shared type system across that boundary and no error if they
// disagree — the extension just fails open and ships the relay's placeholder
// ("momo / 새 알림") forever (NotificationService.swift:26-30). That is the
// quietest failure in this feature, so `__tests__/pushContract.test.ts` parses
// the Swift source and asserts every value below still matches it.
// =============================================================================

/** `MomoPushContract.secureSessionService` — PushNotification.swift:7. */
export const PUSH_KEYCHAIN_SERVICE = 'app.momo.ios.session';

/** `MomoPushContract.pushFetchSessionAccount` — PushNotification.swift:9. */
export const PUSH_FETCH_SESSION_ACCOUNT = 'push-fetch-session';

/** `MomoPushContract.keychainAccessGroupInfoKey` — PushNotification.swift:6.
 *  The Info.plist key both processes read to learn the access group. */
export const KEYCHAIN_ACCESS_GROUP_INFO_KEY = 'MomoKeychainAccessGroup';

/** `MomoPushRegistrationClient.topic` — MomoiOSKit/PushRegistration.swift:34.
 *  The APNs topic is the APP's bundle id, never the extension's. */
export const PUSH_TOPIC = 'app.momo.ios';

/** `MomoPushCategory` — PushNotification.swift:78-85. The category decides which
 *  action buttons the notification carries. */
export const PUSH_CATEGORY = {
  message: 'momo.message',
  mention: 'momo.mention',
  approval: 'momo.approval',
  work: 'momo.work',
} as const;

export type PushCategory = (typeof PUSH_CATEGORY)[keyof typeof PUSH_CATEGORY];

/** `MomoPushActionIdentifier` — PushNotification.swift:87-91.
 *
 *  These are the identifiers that must survive the trip to JS. RNFirebase was
 *  disqualified precisely because it does not forward them (ADR-0137 D7 정오 5);
 *  expo-notifications passes `response.actionIdentifier` through untouched
 *  (NotificationRecords.swift:457), remapping only the system default action. */
export const PUSH_ACTION = {
  quickReply: 'momo.action.quick-reply',
  approve: 'momo.action.approve',
  reject: 'momo.action.reject',
} as const;

export type PushAction = (typeof PUSH_ACTION)[keyof typeof PUSH_ACTION];

/** Payload schema gate — PushNotification.swift:180. The extension refuses any
 *  envelope whose schema string is not exactly this, so JS must not be laxer. */
export const PUSH_ENVELOPE_SCHEMA = 'momo.push.notification.v2';

/** Accepted `reason` values — PushNotification.swift:188. */
export const PUSH_REASONS = [
  'dm',
  'mention',
  'approval_request',
  'resume_offer',
] as const;

export type PushReason = (typeof PUSH_REASONS)[number];
