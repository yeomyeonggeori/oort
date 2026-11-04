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
// ("oort / 새 알림") forever (NotificationService.swift:26-30). That is the
// quietest failure in this feature, so `__tests__/pushContract.test.ts` parses
// the Swift source and asserts every value below still matches it.
// =============================================================================

/** `MomoPushContract.secureSessionService` — PushNotification.swift:7. */
export const PUSH_KEYCHAIN_SERVICE = 'app.momo.ios.session';

/** `MomoPushContract.pushFetchSessionAccount` — PushNotification.swift:9. */
export const PUSH_FETCH_SESSION_ACCOUNT = 'push-fetch-session';

/** `MomoPushActionContract.keychainService` — modules/momo-push-action-native/ios/
 *  MomoPushActionCore.swift (#3931, ADR-0204 D6). The lock screen's 승인/거절 is
 *  answered by native code with a `push_action` token this app parks here. A
 *  DIFFERENT service from the extension's on purpose, and written only into the
 *  APP-ONLY access group: see `pushActionSession.ts`. */
export const PUSH_ACTION_KEYCHAIN_SERVICE = 'app.momo.ios.pushaction';

/** `MomoPushActionContract.sessionAccount` — the same file. */
export const PUSH_ACTION_SESSION_ACCOUNT = 'push-action-session';

/** The name the native handler's Expo module answers to
 *  (`MomoPushActionNativeModule`, `Name("MomoPushAction")`). */
export const PUSH_ACTION_NATIVE_MODULE = 'MomoPushAction';

/** `MomoPushContract.keychainAccessGroupInfoKey` — PushNotification.swift:6.
 *  The Info.plist key both processes read to learn the access group. */
export const KEYCHAIN_ACCESS_GROUP_INFO_KEY = 'MomoKeychainAccessGroup';

/** `MomoPushRegistrationClient.topic` — MomoiOSKit/PushRegistration.swift:34.
 *  The APNs topic is the APP's bundle id, never the extension's. */
export const PUSH_TOPIC = 'app.momo.ios';

/** `MomoPushCategory` — PushNotification.swift:108-121. The category decides which
 *  action buttons the notification carries.
 *
 *  `approvalOpen` is ADR-0204 D7 (#3928): an approval the lock screen must NOT
 *  decide — it mints a value shown once, or it asks the approver to pick a host.
 *  Its one button opens the card (after Face ID); there is no 승인 or 거절 on it.
 *  The server chooses between the two (`momo_agent::actions::opens_in_app`); an
 *  app build that predates this value cannot decode it and shows the notification
 *  without buttons, which is the safe way to fail. Both approval categories carry
 *  an `approval_id`. */
export const PUSH_CATEGORY = {
  message: 'momo.message',
  mention: 'momo.mention',
  approval: 'momo.approval',
  approvalOpen: 'momo.approval.open',
  work: 'momo.work',
  /** ADR-0206 D14·D15 (#4341): a push that names no conversation — today the 시험 알림.
   *  No buttons (nothing to reply to or decide). An app build without this value fails
   *  open to the relay's static text. */
  system: 'momo.system',
} as const;

export type PushCategory = (typeof PUSH_CATEGORY)[keyof typeof PUSH_CATEGORY];

/** `MomoPushActionIdentifier` — PushNotification.swift:123-129.
 *
 *  These are the identifiers that must survive the trip to JS. RNFirebase was
 *  disqualified precisely because it does not forward them (ADR-0137 D7 정오 5);
 *  expo-notifications passes `response.actionIdentifier` through untouched
 *  (NotificationRecords.swift:457), remapping only the system default action.
 *
 *  `openApproval` is the single 「열어서 결정」 button of `approvalOpen` (ADR-0204
 *  D7): it opens the app on the approval's card. It decides nothing. */
export const PUSH_ACTION = {
  quickReply: 'momo.action.quick-reply',
  approve: 'momo.action.approve',
  reject: 'momo.action.reject',
  openApproval: 'momo.action.open-approval',
} as const;

export type PushAction = (typeof PUSH_ACTION)[keyof typeof PUSH_ACTION];

/** Payload schema gate — PushNotification.swift:218. The extension refuses any
 *  envelope whose schema string is not exactly this, so JS must not be laxer. */
export const PUSH_ENVELOPE_SCHEMA = 'momo.push.notification.v2';

/** Accepted `reason` values — PushNotification.swift:226 (the `contains` gate).
 *
 *  Five since ADR-0120 부록 A (Accepted 2026-10-02, #3341): `work_session_idle`
 *  is the 「작업 끝남」 push. The server only sends it to the member who started
 *  the session, for turns of 60 s or more, when they were not just looking at it
 *  — the app only validates the label and never branches on it (the screen it
 *  opens follows `category`, which stays `momo.work`).
 *
 *  Six since ADR-0162 증보 3 D14 (#3517): `work_run_done` is the same push for a
 *  hosted agent's work run, sent to the person who asked for it. Same category,
 *  same label-only validation; a build without it fails open to the static
 *  placeholder (relay ships first, the app follows).
 *
 *  Seven since ADR-0206 증보 1 F5 (#4889): `thread_reply` is a new reply in a thread
 *  the member follows. Category `momo.message` (the reply button stays), and the
 *  envelope's `thread-id` is the thread's root — the tap opens that thread through
 *  the existing `thread-id !== channel_id` rule, so nothing here branches on it.
 *
 *  Eight since ADR-0206 D11·D14 (#4341): `test_notification` is the test push a member
 *  sends to their own devices, category `momo.system`. Its channel, message and thread
 *  ids are the nil-UUID sentinel (the envelope names no conversation), so the tap lands
 *  on no channel — the tap destination is the notification settings screen (#4342). */
export const PUSH_REASONS = [
  'dm',
  'mention',
  'approval_request',
  'resume_offer',
  'work_session_idle',
  'work_run_done',
  'thread_reply',
  'test_notification',
] as const;

export type PushReason = (typeof PUSH_REASONS)[number];
