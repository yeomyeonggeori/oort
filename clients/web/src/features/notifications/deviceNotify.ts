import {
  notifyDecision,
  notificationBody,
  type NotifyContext,
  type NotifyDecision,
} from "@momo/core/features/notifications/model";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import { desktopNotificationKinds } from "./preference";
import { serverPauseActive } from "./serverPause";
import { requestLoopCopyViolations } from "@momo/core/features/timeline/requestBundle";

/**
 * The desktop fire path, with this device's kind toggles applied and the
 * server's 알림 일시 중지 read.
 *
 * `notifyDecision` still owns every other suppression rule. These are the two
 * extra questions only this layer can answer: did this origin turn that kind
 * off (the settings panel), and is the member's pause on right now (the server's
 * answer, `serverPause.ts` — #4197). Both are read at decision time, so a toggle
 * or a re-read lands on the very next event.
 */
export function notifyThisDevice(
  event: MessageNewEvent,
  context: Omit<NotifyContext, "kindEnabled" | "paused">
): NotifyDecision {
  const kinds = desktopNotificationKinds();
  const decision = notifyDecision(event, {
    ...context,
    kindEnabled: (kind) => kinds[kind],
    paused: serverPauseActive(),
  });
  if (!decision.show || decision.notification.kind !== "approval") return decision;
  if (event.payload.props?.can_decide === false) return { show: false, skip: "not-notifiable" };
  const question = event.payload.body?.trim();
  // 서버 질문이 없는 옛 카드는 현재 제목을 본문으로 읽어요. 문구를 새로 짓지 않아요.
  const body = question && /[?？]/.test(question) && requestLoopCopyViolations(question).length === 0
    ? notificationBody(question) : decision.notification.body;
  return { ...decision, notification: {
    ...decision.notification,
    title: context.actorFor(event.payload.author_member_id),
    ...(body === undefined ? {} : { body }),
  } };
}
