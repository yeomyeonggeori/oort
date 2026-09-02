import {
  notifyDecision,
  type NotifyContext,
  type NotifyDecision,
} from "@momo/core/features/notifications/model";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import { desktopNotificationKinds } from "./preference";

/**
 * The desktop fire path, with this device's kind toggles applied.
 *
 * `notifyDecision` still owns every other suppression rule. This is the one
 * extra question the settings panel answers: did this origin turn that kind off.
 */
export function notifyThisDevice(
  event: MessageNewEvent,
  context: Omit<NotifyContext, "kindEnabled">
): NotifyDecision {
  const kinds = desktopNotificationKinds();
  return notifyDecision(event, {
    ...context,
    kindEnabled: (kind) => kinds[kind],
  });
}
