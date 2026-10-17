import type {NotificationRequest, NotificationResponse} from 'expo-notifications';

import {
  PUSH_CATEGORY,
  PUSH_ENVELOPE_SCHEMA,
  PUSH_REASONS,
  type PushCategory,
  type PushReason,
} from './contract';

// =============================================================================
// The id-only envelope, parsed on the JS side (goal RN-N1).
//
// This is a deliberate second implementation of `MomoPushParser`
// (PushNotification.swift:136-212), not a shortcut around it. The two run in
// different processes for different reasons:
//
//   - Swift parses to decide what to FETCH and DISPLAY, before the app is awake.
//   - JS parses to decide what to DO when the person taps an action button.
//
// The guards are reproduced rather than relaxed because they are the security
// boundary, not validation hygiene. In particular the workspace check exists so
// a push for workspace A can never drive an approval in workspace B; the frozen
// kit checked it in three separate places (audit §7.3) and losing that as a
// side effect of moving to JS is the regression this file is written to avoid.
// =============================================================================

export interface PushEnvelope {
  serverId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
  collapseId: string;
  reason: PushReason;
  approvalId: string | null;
  threadId: string;
  category: PushCategory;
  badge: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES: readonly string[] = Object.values(PUSH_CATEGORY);

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse an APNs `userInfo` payload into an envelope, or null if it is not one of
 * ours or does not satisfy every guard the extension applies.
 *
 * Returning null must always mean "do nothing but open the app" — never
 * "assume defaults and act".
 */
export function parsePushEnvelope(payload: unknown): PushEnvelope | null {
  const root = record(payload);
  if (!root) return null;

  const aps = record(root.aps);
  const momo = record(root.momo);
  if (!aps || !momo) return null;

  // PushNotification.swift:180 — an exact string, not a prefix or a range.
  if (str(momo, 'schema') !== PUSH_ENVELOPE_SCHEMA) return null;

  const workspaceId = str(momo, 'workspace_id');
  const channelId = str(momo, 'channel_id');
  const messageId = str(momo, 'message_id');
  const threadId = str(aps, 'thread-id');
  if (!workspaceId || !UUID.test(workspaceId)) return null;
  if (!channelId || !UUID.test(channelId)) return null;
  if (!messageId || !UUID.test(messageId)) return null;
  if (!threadId || !UUID.test(threadId)) return null;

  const serverId = str(momo, 'server_id');
  const collapseId = str(momo, 'collapse_id');
  if (!serverId || !collapseId) return null;

  const reason = str(momo, 'reason');
  if (!reason || !(PUSH_REASONS as readonly string[]).includes(reason)) {
    return null;
  }

  const category = str(aps, 'category');
  if (!category || !CATEGORIES.includes(category)) return null;

  const badge = aps.badge;
  if (typeof badge !== 'number' || !Number.isFinite(badge) || badge < 0) {
    return null;
  }

  const rawApprovalId = str(momo, 'approval_id')?.toLowerCase() ?? null;
  const approvalId = rawApprovalId && UUID.test(rawApprovalId) ? rawApprovalId : null;

  // PushNotification.swift:227-228, kept as one biconditional rather than two
  // loose checks: an approval push MUST carry a usable approval id, and a
  // non-approval push must NOT carry one. Splitting these lets an approval id
  // ride along on a plain message and be acted on by the wrong branch.
  //
  // Both approval categories name their approval (ADR-0204 D7): the open one needs
  // the id to land on the card, and to clear the notification once it is decided.
  // Naming the approval is NOT permission to decide it from here — only the inline
  // category's buttons may (`handlePushResponse` checks the category again).
  const isApproval =
    category === PUSH_CATEGORY.approval ||
    category === PUSH_CATEGORY.approvalOpen;
  if (isApproval !== (approvalId !== null)) return null;

  return {
    serverId,
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    collapseId,
    reason: reason as PushReason,
    approvalId,
    threadId: threadId.toLowerCase(),
    category: category as PushCategory,
    badge,
  };
}

/**
 * 알림 응답이 들고 온 봉투 원문 (#3931).
 *
 * 원격 푸시는 `trigger.payload` 에 APNs `userInfo` 를 들고 온다. 잠금 화면 승인을 네이티브
 * 처리기가 받은 뒤 원래 알림을 대신해 올리는 **한 줄짜리 로컬 알림**(`승인했어요 · …`,
 * `승인하지 못했어요` + 본문 `눌러서 앱에서 마무리해 주세요`)에는 푸시 트리거가 없다. 그 줄을 눌러도 카드로
 * 가려면 원문이 어딘가에 있어야 해서, 처리기가 `content.data.origin` 에 그대로 실어 둔다
 * (`MomoPushActionContract.originKey`).
 *
 * 순서가 보안 경계다: 푸시 트리거의 원문이 있으면 **그것만** 읽는다. 원격 푸시의 본문이
 * `origin` 이라는 키를 싣고 있어도 이 함수는 그쪽을 보지 않는다 — 로컬 알림을 만들 수 있는
 * 것은 이 앱뿐이고, 원격 입력이 로컬 입력으로 둔갑하는 길은 없어야 한다.
 */
export function pushPayloadOf(response: NotificationResponse): unknown {
  return pushPayloadOfRequest(response.notification.request);
}

/**
 * 같은 규칙을, 응답이 아니라 알림 센터에 **배달돼 있는** 알림에 쓴다 (`approvalNotifications.ts`).
 * 결정된 승인의 알림을 걷을 때 처리기가 올린 결과 줄(트리거 없음, 원문은 `content.data.origin`)도
 * 그 승인의 것으로 알아봐야 한다 — 안 그러면 앱에서 마무리한 뒤에도 「눌러서 앱에서 마무리해
 * 주세요」가 잠금 화면에 남는다.
 */
export function pushPayloadOfRequest(request: NotificationRequest): unknown {
  const trigger = request.trigger as {payload?: unknown} | null;
  if (trigger?.payload !== undefined) {
    return trigger.payload;
  }
  const data = request.content?.data as {origin?: unknown} | null | undefined;
  return data?.origin;
}

/** The thread root, or null when the notification is not in a thread.
 *  Mirrors `MomoPushEnvelope.threadRootID` (PushNotification.swift:118-120). */
export function threadRootId(envelope: PushEnvelope): string | null {
  return envelope.threadId === envelope.channelId ? null : envelope.threadId;
}

/**
 * May this notification's 승인·거절 buttons decide its approval (ADR-0204 D7)?
 *
 * Only the inline category may. `momo.approval.open` names its approval too (so the
 * app can land on the card and clear the notification once it is decided) but it is
 * decided in the app, behind a card that can show what a banner cannot. An allow
 * list of one, on purpose: a future approval category that is not added here is
 * not decidable from a notification until someone decides that it should be.
 */
export function isLockScreenDecidable(envelope: PushEnvelope): boolean {
  return envelope.category === PUSH_CATEGORY.approval;
}
