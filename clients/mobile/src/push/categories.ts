import * as Notifications from 'expo-notifications';

import {PUSH_ACTION, PUSH_CATEGORY} from './contract';

// =============================================================================
// Notification categories and their action buttons (goal RN-N1).
//
// A rewrite of `IOSNotificationCategoryRegistry`
// (clients/iOS/MomoiOSKit/Sources/MomoiOSKit/IOSNotificationPreferences.swift:66-118)
// rather than a port, which is the right call for this piece: the Swift version
// is thin and its only real content is the option flags, while everything it
// hands off to lives in JS now. The 2026-08-02 audit reached the same
// conclusion (§2.2 item 1) — the file was already almost free of MomoCore, its
// one entanglement being an App Group `UserDefaults` read for per-category
// toggles, which v0 does not have.
//
// The expo API maps 1:1 onto the UNNotificationAction options the kit used
// (audit §5.1, "알림 액션" row), so nothing is lost in translation.
// =============================================================================

/**
 * `.authenticationRequired` on both approval buttons — kit lines 78-87.
 *
 * This is a security control, not a nicety, and it is the asset the audit
 * singled out as easiest to drop in a rewrite (§7.3): it forces Face ID or the
 * passcode before an approval is recorded from the lock screen. Without it a
 * found phone can approve an agent's action from a banner without ever
 * unlocking. If this flag is ever removed, that downgrade is invisible — the
 * button still works, it just stops asking.
 */
const REQUIRES_AUTH = {
  isAuthenticationRequired: true,
  opensAppToForeground: false,
} as const;

const REPLY_ACTION: Notifications.NotificationAction = {
  identifier: PUSH_ACTION.quickReply,
  buttonTitle: '답장',
  textInput: {submitButtonTitle: '보내기', placeholder: '메시지'},
  options: {opensAppToForeground: false},
};

const APPROVE_ACTION: Notifications.NotificationAction = {
  identifier: PUSH_ACTION.approve,
  buttonTitle: '승인',
  options: {...REQUIRES_AUTH},
};

const REJECT_ACTION: Notifications.NotificationAction = {
  identifier: PUSH_ACTION.reject,
  buttonTitle: '거부',
  options: {...REQUIRES_AUTH, isDestructive: true},
};

/**
 * 「열어서 결정」 — the one button of an approval the lock screen must not decide
 * (ADR-0204 D7).
 *
 * It asks for the same Face ID / passcode the inline buttons do, and then OPENS the
 * app on the card: `opensAppToForeground: true`, the opposite of the two buttons
 * above. That is the whole point of the category — a one-time value (an invite
 * link, a pairing code) has nowhere to be shown on a banner, and a spawn that asks
 * which machine to run on cannot be answered by a button that carries no choice.
 * The button decides nothing; `tapArrival` treats its response as a tap on the
 * notification and lands on the card.
 */
const OPEN_APPROVAL_ACTION: Notifications.NotificationAction = {
  identifier: PUSH_ACTION.openApproval,
  buttonTitle: '열어서 결정',
  options: {isAuthenticationRequired: true, opensAppToForeground: true},
};

/** Category id → its buttons. `work` intentionally has none: it reports that an
 *  agent moved, and there is no one-tap answer to that. `system` has none either. */
export const PUSH_CATEGORY_ACTIONS: ReadonlyArray<
  readonly [string, Notifications.NotificationAction[]]
> = [
  [PUSH_CATEGORY.message, [REPLY_ACTION]],
  [PUSH_CATEGORY.mention, [REPLY_ACTION]],
  [PUSH_CATEGORY.approval, [APPROVE_ACTION, REJECT_ACTION]],
  [PUSH_CATEGORY.approvalOpen, [OPEN_APPROVAL_ACTION]],
  [PUSH_CATEGORY.work, []],
  // ADR-0206 D14·D15 (#4341): the test push names no conversation — nothing to reply to or decide.
  [PUSH_CATEGORY.system, []],
];

/**
 * Register every category with the system.
 *
 * Must run before the first notification arrives, not on demand: iOS resolves a
 * payload's `aps.category` against the categories registered AT DELIVERY TIME.
 * A notification that lands before this call shows with no buttons at all, and
 * there is no retroactive fix for one already in the shade.
 */
export async function registerPushCategories(): Promise<void> {
  await Promise.all(
    PUSH_CATEGORY_ACTIONS.map(([identifier, actions]) =>
      Notifications.setNotificationCategoryAsync(identifier, [...actions]),
    ),
  );
}
