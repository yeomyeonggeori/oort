import { notificationBody } from "@momo/core/features/notifications/model";
import {
  reminderBacklogNotificationBody,
  reminderPreviewText,
  REMINDER_NOTIFY_TITLE,
  type MessageReminder,
} from "@momo/core/features/reminders/model";
import { isDesktop, showNotification } from "@/lib/tauri";
import { desktopNotificationKinds } from "@/features/notifications/preference";

/**
 * Local due-arrival fire path, aligned with A4's kind surface.
 *
 * Mentions and approvals ride `message.new`. Reminders have no outbox, so this
 * is a poll-time decision. The rules that still apply:
 *   - browser tab stays silent (`isDesktop`)
 *   - this-device kind toggle (`momo.web.notifications.v1` reminder key)
 *   - no duplicate in this session
 *
 * Window-focus suppression does NOT apply: a reminder is due because the
 * source message is not already the thing on screen.
 */
export type ReminderNotifySkip = "browser" | "kind-disabled" | "duplicate";

export type ReminderNotifyDecision =
  | { show: true }
  | { show: false; skip: ReminderNotifySkip };

export function reminderNotifyDecision(args: {
  isDesktop: boolean;
  kindEnabled: boolean;
  announced: boolean;
}): ReminderNotifyDecision {
  if (!args.isDesktop) return { show: false, skip: "browser" };
  if (!args.kindEnabled) return { show: false, skip: "kind-disabled" };
  if (args.announced) return { show: false, skip: "duplicate" };
  return { show: true };
}

export function reminderNotificationBody(reminder: MessageReminder): string | undefined {
  return notificationBody(reminderPreviewText(reminder));
}

export async function fireReminderNotification(
  reminder: MessageReminder,
  announcedIds: Set<string>
): Promise<boolean> {
  const decision = reminderNotifyDecision({
    isDesktop: isDesktop(),
    kindEnabled: desktopNotificationKinds().reminder,
    announced: announcedIds.has(reminder.id),
  });
  announcedIds.add(reminder.id);
  if (!decision.show) return false;
  return showNotification(
    REMINDER_NOTIFY_TITLE,
    reminderNotificationBody(reminder)
  );
}

export async function fireReminderBacklogNotification(
  count: number,
  announcedIds: Set<string>,
  ids: readonly string[]
): Promise<boolean> {
  for (const id of ids) announcedIds.add(id);
  const decision = reminderNotifyDecision({
    isDesktop: isDesktop(),
    kindEnabled: desktopNotificationKinds().reminder,
    announced: false,
  });
  if (!decision.show) return false;
  return showNotification(
    REMINDER_NOTIFY_TITLE,
    reminderBacklogNotificationBody(count)
  );
}
