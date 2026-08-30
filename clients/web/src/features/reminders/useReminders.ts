import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createReminder,
  deleteReminder,
  listReminders,
  patchReminder,
} from "@momo/core/features/reminders/api";
import {
  REMINDERS_POLL_MS,
  type CreateReminderInput,
  type MessageReminder,
} from "@momo/core/features/reminders/model";

/**
 * Reminder list for this workspace.
 *
 * Cadence is the same 30s as `useReadStates` (A-41: no new loop). The queries
 * stay separate rather than sharing one `queryFn`: a reminders 404 must not
 * blank the sidebar unread counts, and invalidating a completed reminder must
 * not refetch every channel cursor.
 */
export function remindersQueryKey(workspaceId: string) {
  return ["reminders", workspaceId, "pending"] as const;
}

export function useReminders(workspaceId: string) {
  return useQuery({
    queryKey: remindersQueryKey(workspaceId),
    queryFn: () => listReminders(workspaceId, { state: "pending" }),
    refetchInterval: REMINDERS_POLL_MS,
    // Mentions/approvals fire while the window is hidden. This list is the
    // due-arrival detector, so the 30s cadence must keep walking there too.
    refetchIntervalInBackground: true,
    // Global queryClient turns window-focus refetch off. Coming back from a
    // minimized/covered window must not wait another 30s for the first check.
    refetchOnWindowFocus: "always",
    retry: false,
  });
}

export function useReminderMutations(workspaceId: string) {
  const client = useQueryClient();
  const key = remindersQueryKey(workspaceId);

  const invalidate = () => client.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (input: CreateReminderInput & { messagePreview?: string }) =>
      createReminder(workspaceId, input).then((row) => {
        const preview = row.messagePreview ?? input.messagePreview;
        return preview === undefined ? row : { ...row, messagePreview: preview };
      }),
    onSuccess: (row) => {
      client.setQueryData(key, (page: { reminders: MessageReminder[] } | undefined) => {
        const reminders = page?.reminders ?? [];
        if (reminders.some((item) => item.id === row.id)) return page;
        return { reminders: [...reminders, row] };
      });
      void invalidate();
    },
  });

  const complete = useMutation({
    mutationFn: (id: string) =>
      patchReminder(workspaceId, id, { completed: true }),
    onSuccess: () => invalidate(),
  });

  const snooze = useMutation({
    mutationFn: ({ id, dueAtMs }: { id: string; dueAtMs: number }) =>
      patchReminder(workspaceId, id, { dueAtMs }),
    onSuccess: () => invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReminder(workspaceId, id),
    onSuccess: () => invalidate(),
  });

  return { create, complete, snooze, remove };
}
