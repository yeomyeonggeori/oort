import { useEffect, useRef } from "react";
import { useSession } from "@/app/session";
import { dueArrivalPlan } from "@momo/core/features/reminders/model";
import { fireReminderNotification } from "./dueNotify";
import { useReminders } from "./useReminders";
import { readReminderWatermark, writeReminderWatermark } from "./watermark";

/**
 * Renders nothing. Consumes the same 30s reminders query the inbox list uses
 * (no second loop) and fires A4-aligned local notifications when a row becomes
 * due after the last check.
 */
export function ReminderDueWatcher() {
  const { workspaceId } = useSession();
  const query = useReminders(workspaceId);
  const announcedRef = useRef(new Set<string>());
  const lastStampRef = useRef<number>(0);

  useEffect(() => {
    const page = query.data;
    if (!page) return;
    if (query.dataUpdatedAt === lastStampRef.current) return;
    lastStampRef.current = query.dataUpdatedAt;
    const nowMs = Date.now();
    const plan = dueArrivalPlan({
      reminders: page.reminders,
      nowMs,
      watermarkMs: readReminderWatermark(workspaceId),
      announcedIds: announcedRef.current,
    });
    writeReminderWatermark(workspaceId, plan.nextWatermarkMs);
    for (const id of plan.notifyIds) {
      const reminder = page.reminders.find((row) => row.id === id);
      if (!reminder) continue;
      void fireReminderNotification(reminder, announcedRef.current);
    }
  }, [query.data, query.dataUpdatedAt, workspaceId]);

  return null;
}
