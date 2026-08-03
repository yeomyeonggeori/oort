import {
  decideApproval,
  newDecisionId,
} from '@momo/core/features/timeline/approvalDecision';
import {sendMessage, sendThreadReply} from '@momo/core/lib/api';
import {
  DEFAULT_ACTION_IDENTIFIER,
  getDevicePushTokenAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  type NotificationResponse,
} from 'expo-notifications';

import {PUSH_ACTION} from './contract';
import {parsePushEnvelope, threadRootId, type PushEnvelope} from './envelope';

// =============================================================================
// expo-notifications wiring (goal RN-N1, ADR-0137 D7 정오 5항).
//
// ## Why the delegate is never touched here
//
// expo-notifications installs `NotificationCenterManager` as the
// UNUserNotificationCenter delegate and fans out to registered delegates. Its
// own `EmitterModule` attaches through the SAME public seam the audit flagged as
// undocumented — `NotificationCenterManager.shared.addDelegate(self)`, in
// `EmitterModule.definition()`'s OnCreate. That is what forwards responses to
// this file. Verified in 57.0.8 sources; see the PR for the full note.
//
// Because the emitter already delivers `actionIdentifier` to JS, this client
// needs NO native delegate of its own, and adding one would be actively worse:
// `NotificationCenterManager.userNotificationCenter(_:didReceive:)` calls the
// system completion handler UNCONDITIONALLY after polling delegates
// (NotificationCenterManager.swift:116-124), so a second delegate that also
// completes would double-call it.
//
// ## getDevicePushTokenAsync, never getExpoPushTokenAsync
//
// `getExpoPushTokenAsync()` mints a token bound to Expo's push service, which
// requires an Expo account and routes our notifications through EPNS. Our relay
// signs its own ES256 JWT and talks to api.push.apple.com directly
// (relay/PushRelay/Sources/PushRelay/APNSSender.swift), and ADR-0004's principle
// is that credentials stay with their owner. `getDevicePushTokenAsync()` returns
// the raw APNs token and involves no third party.
// =============================================================================

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** Ask for notification permission, or report what was already decided.
 *  iOS only ever shows the prompt once; after that this reports the standing
 *  answer and the person has to change it in Settings. */
export async function ensurePushPermission(): Promise<PushPermission> {
  const current = await getPermissionsAsync();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'denied';

  const requested = await requestPermissionsAsync({
    ios: {allowAlert: true, allowBadge: true, allowSound: true},
  });
  if (requested.granted) return 'granted';
  return requested.canAskAgain ? 'undetermined' : 'denied';
}

/**
 * The native APNs token as lowercase hex.
 *
 * Lowercased because the Swift client registered it that way
 * (PushRegistration.swift:94-101) and the server stores the string it is given;
 * a case flip would look like a new token and orphan the old registration.
 */
export async function fetchApnsToken(): Promise<string | null> {
  const token = await getDevicePushTokenAsync();
  if (token.type !== 'ios' || typeof token.data !== 'string') return null;
  const hex = token.data.trim().toLowerCase();
  return hex === '' ? null : hex;
}

export type PushActionResult =
  | {kind: 'opened'; envelope: PushEnvelope | null}
  | {
      kind: 'decided';
      /** 이 사람이 **누른** 방향. 원장에 그대로 적혔다는 뜻은 아니다. */
      approved: boolean;
      /**
       * 원장에 **실제로 적힌** 결과 (goal M-AP1 2R H5).
       *
       * `pressed`면 이 탭이 그 결정을 기록했다. `settled`면 원장은 이미 다른 답을
       * 들고 있었고(다른 기기의 결정, 또는 기한 만료), `recordedApproved`가 그
       * 답이다 — `undefined`면 만료·취소처럼 승인도 거부도 아닌 상태다.
       *
       * 이 칸이 없던 동안 잠금화면의 거부 탭은 원장이 승인을 들고 있어도
       * "거부됨"으로 보고됐다. 되돌릴 수 없는 축에서 사용자에게 **반대 사실**을
       * 말하는 것이라, 두 갈래를 한 값에 접어 두면 안 된다.
       */
      record: 'pressed' | 'settled';
      /** `record: 'settled'`일 때 원장이 답한 방향. */
      recordedApproved?: boolean;
    }
  | {kind: 'replied'}
  | {kind: 'ignored'; reason: string}
  | {kind: 'failed'; reason: string};

export interface PushActionContext {
  /** The workspace this device is signed into RIGHT NOW. */
  signedInWorkspaceId: string;
}

/**
 * Turn a notification response into the action it stands for.
 *
 * The workspace equality check is the security boundary, not a sanity check.
 * The frozen kit asserted it in three separate layers (PushNotification.swift:245,
 * IOSPushActionExecutor.swift:31, PushNotificationCoordinator.swift:169) and the
 * audit warned that collapsing those layers into one JS function is exactly how
 * the check disappears (§7.3). It is therefore made once, here, before any
 * branch can act — a notification queued for a workspace the person has since
 * left must never drive a write into the one they are in now.
 */
export async function handlePushResponse(
  response: NotificationResponse,
  context: PushActionContext,
): Promise<PushActionResult> {
  const trigger = response.notification.request.trigger as
    | {type?: string; payload?: unknown}
    | null;
  const envelope = parsePushEnvelope(trigger?.payload);
  const action = response.actionIdentifier;

  if (action === DEFAULT_ACTION_IDENTIFIER) {
    // Body tap. Opening the app is always safe, even for an envelope we could
    // not parse or one from another workspace — navigation is the caller's.
    return {kind: 'opened', envelope};
  }

  if (!envelope) {
    return {kind: 'ignored', reason: 'unparseable envelope'};
  }
  if (envelope.workspaceId !== context.signedInWorkspaceId.toLowerCase()) {
    return {kind: 'ignored', reason: 'workspace mismatch'};
  }

  switch (action) {
    case PUSH_ACTION.approve:
    case PUSH_ACTION.reject: {
      // `parsePushEnvelope` already guarantees approvalId is non-null exactly
      // when the category is `approval`, so this is a type narrowing, not a
      // second policy.
      if (!envelope.approvalId) {
        return {kind: 'ignored', reason: 'no approval on this notification'};
      }
      const approved = action === PUSH_ACTION.approve;
      const outcome = await decideApproval(
        envelope.workspaceId,
        envelope.approvalId,
        approved,
        newDecisionId(),
      );
      if (outcome.kind === 'error') {
        return {kind: 'failed', reason: outcome.errorCopy ?? 'decision failed'};
      }
      // `superseded` counts as decided: the approval was already settled
      // elsewhere (another device, or it expired). Reporting that as a failure
      // would invite a retry against something that can no longer change.
      //
      // But it is NOT the same event as "this tap recorded the decision", and
      // collapsing the two was a lie in the dangerous direction (2R H5): a
      // rejection tapped from the lock screen was reported as a rejection even
      // when the ledger held an APPROVAL. So the two are reported apart, and a
      // settled one carries the direction the ledger actually holds.
      if (outcome.kind === 'superseded') {
        const settled: PushActionResult = {
          kind: 'decided',
          approved,
          record: 'settled',
        };
        if (outcome.status === 'approved') settled.recordedApproved = true;
        if (outcome.status === 'rejected') settled.recordedApproved = false;
        return settled;
      }
      return {kind: 'decided', approved, record: 'pressed'};
    }

    case PUSH_ACTION.quickReply: {
      const text = (response.userText ?? '').trim();
      if (text === '') return {kind: 'ignored', reason: 'empty reply'};
      const root = threadRootId(envelope);
      try {
        if (root) {
          await sendThreadReply(
            envelope.workspaceId,
            envelope.channelId,
            root,
            crypto.randomUUID(),
            text,
          );
        } else {
          await sendMessage(
            envelope.workspaceId,
            envelope.channelId,
            crypto.randomUUID(),
            text,
          );
        }
        return {kind: 'replied'};
      } catch (cause) {
        return {
          kind: 'failed',
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }

    default:
      return {kind: 'ignored', reason: `unknown action ${action}`};
  }
}
