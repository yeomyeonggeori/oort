import {
  notifyDecision,
  type NotifyContext,
  type NotifyDecision,
} from "@momo/core/features/notifications/model";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import { desktopNotificationKinds } from "./preference";
import { serverPauseActive } from "./serverPause";

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
  return notifyDecision(event, {
    ...context,
    kindEnabled: (kind) => kinds[kind],
    paused: serverPauseActive(),
  });
}
