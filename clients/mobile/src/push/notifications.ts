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

import {shouldAskNotifications} from '../features/onboarding/phoneFlow';
import {dismissApprovalNotifications} from './approvalNotifications';
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

/**
 * 알림 권한이 지금 어디에 서 있는가. **읽기만** 한다 (#2820).
 *
 *   granted  허용됨. 토큰을 받고 등록한다.
 *   ask      아무도 묻지 않았다. M3 알림 미리 안내가 설 자리다.
 *   settled  그 밖(거부, provisional·ephemeral). 묻지 않는다.
 *
 * 이 파일에는 「안 물었으면 묻는」 함수가 없다. 예전의 `ensurePushPermission()`은
 * 세션이 서자마자 설명 없이 iOS 창을 띄웠고, iOS는 그 창을 한 번만 띄운다
 * (ADR-0193 D8). 창은 M3의 [계속]과 설정 › 알림에서만 `askPushPermission()`으로 뜬다.
 */
export type PushGate = 'granted' | 'ask' | 'settled';

export function pushGateFrom(
  settings: Parameters<typeof shouldAskNotifications>[0],
): PushGate {
  if (settings.granted) return 'granted';
  return shouldAskNotifications(settings) ? 'ask' : 'settled';
}

export async function readPushGate(): Promise<PushGate> {
  return pushGateFrom(await getPermissionsAsync());
}

/**
 * iOS 알림 허용 창을 띄운다. **사람이 누른 버튼에서만** 부른다(M3 [계속],
 * 설정 › 알림). 이미 정해진 권한이면 iOS가 창 없이 서 있는 답을 돌려준다.
 */
export async function askPushPermission(): Promise<PushGate> {
  const requested = await requestPermissionsAsync({
    ios: {allowAlert: true, allowBadge: true, allowSound: true},
  });
  const gate = pushGateFrom(requested);
  // 창을 닫고도 「아직 안 물음」으로 읽히면(창이 뜨지 못한 경우) 다시 묻지 않는다.
  // M3에 사람을 가두는 것보다 설정 › 알림으로 보내는 편이 낫다.
  return gate === 'ask' ? 'settled' : gate;
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
 * 알림의 「승인」·「거절」 한 번이 뜻하는 일의 전부 (#3926).
 *
 * 결정을 보내고, 원장이 답한 대로 결과를 해석하고, 승인이 결정됐으면 그 승인의
 * 알림을 걷는다. `handlePushResponse`는 봉투와 워크스페이스를 확인한 **뒤에** 이
 * 함수를 부른다(보안 경계는 그쪽 한 곳이다). 이 함수에는 인자 말고는 알림도,
 * 화면도, 상태도 없다. iOS 네이티브 처리기(#3931, ADR-0204 D6)가 이 두 버튼을
 * 넘겨받는 날 JS 쪽에서 바뀌는 것은 이 함수를 부르는 한 줄이고, 네이티브 쪽은 이
 * 함수가 하는 일(보내기, 원장 답 해석, 걷기)을 그대로 따라 하면 된다.
 *
 * ## 걷는 때
 *
 * 결정이 기록됐거나(`committed`) 이미 결정돼 있을 때(`superseded`: 다른 기기의
 * 결정, 만료) 걷는다. 두 경우 모두 그 승인의 버튼은 이제 아무것도 바꾸지 못한다.
 * 오류일 때는 **걷지 않는다** — 결정이 기록되지 않았고 승인은 여전히 대기다.
 * 알림이 남아 있어야 사람이 다시 누르거나 눌러서 앱에서 마무리할 수 있다.
 *
 * `clientDecisionId`는 호출자가 정할 수 있다. 같은 키로 같은 판정을 다시 보내면
 * 서버가 원래 영수증을 재생하므로(두 번 눌러도 한 번의 결정), 키를 알림 요청
 * 식별자에서 결정적으로 만드는 쪽(네이티브 처리기)이 같은 모양으로 부를 수 있다.
 */
export async function decideFromNotification(
  workspaceId: string,
  approvalId: string,
  approved: boolean,
  clientDecisionId: string = newDecisionId(),
): Promise<PushActionResult> {
  const outcome = await decideApproval(
    workspaceId,
    approvalId,
    approved,
    clientDecisionId,
  );
  if (outcome.kind === 'error') {
    return {kind: 'failed', reason: outcome.errorCopy ?? 'decision failed'};
  }
  // 기록됐든 이미 결정돼 있든 이 승인은 끝났다. 걷는 일이 실패해도 결정의 결과는
  // 바뀌지 않으므로(`dismissApprovalNotifications`는 던지지 않는다) 기다리되 묻지 않는다.
  await dismissApprovalNotifications(approvalId);
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
      // 결정 로직은 아래 한 함수다. iOS 네이티브 처리기(#3931)가 이 두 버튼을
      // 넘겨받는 날, 바꿀 곳은 이 호출 하나다.
      return decideFromNotification(
        envelope.workspaceId,
        envelope.approvalId,
        action === PUSH_ACTION.approve,
      );
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
