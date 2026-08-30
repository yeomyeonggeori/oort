import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, MoreHorizontal, Trash2 } from "lucide-react";
import { uuidEq } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import { messageAnchorPath, searchHitPath, watchForMessage } from "@/features/inbox/anchor";
import {
  channelLabel,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import {
  reminderDueLabel,
  reminderFailureMessage,
  reminderIsOverdue,
  reminderLoadFailureMessage,
  reminderPreviewText,
  REMINDER_COMPLETE_LABEL,
  REMINDER_CUSTOM_LABEL,
  REMINDER_DELETE_LABEL,
  REMINDER_EMPTY_DETAIL,
  REMINDER_EMPTY_HEADLINE,
  REMINDER_SNOOZE_LABEL,
  type MessageReminder,
} from "@momo/core/features/reminders/model";
import {
  reminderPresetDueAtMs,
  REMINDER_PRESETS,
  type ReminderPresetId,
} from "@momo/core/features/reminders/presets";
import { RemindDialog } from "./RemindDialog";
import { useReminderMutations, useReminders } from "./useReminders";

// Reading this as: inbox docked reminder list for internal team users on
// web+Tauri, density 7/10, motion 2/10. A5 draft-row grammar: flat rows,
// overflow ⋯ in a raised bowl, mutating actions as siblings of the jump link.

function reminderPath(reminder: MessageReminder): string {
  if (reminder.messageSeq !== undefined) {
    return searchHitPath(
      reminder.channelId,
      reminder.messageId,
      reminder.messageSeq
    );
  }
  return messageAnchorPath(reminder.channelId, reminder.messageId);
}

export function RemindersPanel() {
  const { session, workspaceId } = useSession();
  const query = useReminders(workspaceId);
  const mutations = useReminderMutations(workspaceId);
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);
  const offline = useOffline();
  const [snoozeTarget, setSnoozeTarget] = useState<MessageReminder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageReminder | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const nowMs = Date.now();

  const channels = useMemo(
    () => [...groups.channels, ...groups.dms],
    [groups]
  );
  const labelFor = (channelId: string) => {
    const channel = channels.find((item) => uuidEq(item.id, channelId));
    if (!channel) return channelId.slice(0, 8);
    return channelLabel(channel, directory, session.member.id);
  };

  const run = async (work: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await work();
    } catch (error: unknown) {
      setActionError(reminderFailureMessage(error));
    }
  };

  const snoozePreset = (reminder: MessageReminder, id: ReminderPresetId) => {
    if (offline) return;
    void run(() =>
      mutations.snooze.mutateAsync({
        id: reminder.id,
        dueAtMs: reminderPresetDueAtMs(id, Date.now()),
      })
    );
  };

  if (query.isLoading) {
    return <SkeletonRows rows={3} className="p-4" />;
  }
  if (query.isError) {
    return (
      <InlineBanner
        message={reminderLoadFailureMessage()}
        actionLabel="다시 시도"
        onAction={() => void query.refetch()}
        testId="reminders-error"
      />
    );
  }

  const reminders = query.data?.reminders ?? [];
  if (reminders.length === 0) {
    return (
      <EmptyInvite
        headline={REMINDER_EMPTY_HEADLINE}
        detail={REMINDER_EMPTY_DETAIL}
        testId="reminders-empty"
      />
    );
  }

  return (
    <div data-testid="reminders-panel">
      {actionError && (
        <InlineBanner
          message={actionError}
          actionLabel="닫기"
          onAction={() => setActionError(null)}
          testId="reminders-action-error"
        />
      )}
      <ul data-testid="reminders-list">
        {reminders.map((reminder) => (
          <ReminderRow
            key={reminder.id}
            reminder={reminder}
            channelLabel={labelFor(reminder.channelId)}
            nowMs={nowMs}
            offline={offline}
            pending={
              mutations.complete.isPending ||
              mutations.snooze.isPending ||
              mutations.remove.isPending
            }
            onComplete={() =>
              void run(() => mutations.complete.mutateAsync(reminder.id))
            }
            onSnoozePreset={(id) => snoozePreset(reminder, id)}
            onSnoozeCustom={() => setSnoozeTarget(reminder)}
            onDelete={() => setDeleteTarget(reminder)}
          />
        ))}
      </ul>
      <RemindDialog
        open={snoozeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSnoozeTarget(null);
        }}
        mode="snooze"
        preview={snoozeTarget ? reminderPreviewText(snoozeTarget) : undefined}
        pending={mutations.snooze.isPending}
        error={actionError}
        onCommit={(dueAtMs) => {
          if (snoozeTarget === null) return;
          const id = snoozeTarget.id;
          void run(() => mutations.snooze.mutateAsync({ id, dueAtMs })).then(
            () => setSnoozeTarget(null)
          );
        }}
      />
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent data-testid="reminder-delete-dialog" className="gap-3 p-4">
          <DialogTitle>이 알림을 지울까요?</DialogTitle>
          <DialogDescription>
            지운 알림은 되돌릴 수 없습니다. 원문 메시지는 그대로 있습니다.
          </DialogDescription>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              data-testid="reminder-delete-cancel"
              onClick={() => setDeleteTarget(null)}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              data-testid="reminder-delete-commit"
              disabled={mutations.remove.isPending || offline}
              onClick={() => {
                if (deleteTarget === null) return;
                const id = deleteTarget.id;
                void run(() => mutations.remove.mutateAsync(id)).then(() =>
                  setDeleteTarget(null)
                );
              }}
            >
              {mutations.remove.isPending ? "지우는 중…" : REMINDER_DELETE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const overflowBowlClass =
  "absolute right-2 top-2 z-20 rounded-md border border-line-strong bg-surface-raised p-px shadow-lg";
const overflowTriggerClass =
  "tap-target flex size-control items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring data-[state=open]:bg-surface-hover data-[state=open]:text-ink";

function ReminderRow({
  reminder,
  channelLabel: sourceLabel,
  nowMs,
  offline,
  pending,
  onComplete,
  onSnoozePreset,
  onSnoozeCustom,
  onDelete,
}: {
  reminder: MessageReminder;
  channelLabel: string;
  nowMs: number;
  offline: boolean;
  pending: boolean;
  onComplete: () => void;
  onSnoozePreset: (id: ReminderPresetId) => void;
  onSnoozeCustom: () => void;
  onDelete: () => void;
}) {
  const hoverNone = useHoverNone();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const overdue = reminderIsOverdue(reminder, nowMs);
  const showOverflow = hoverNone || hovered || menuOpen;
  const to = reminderPath(reminder);

  return (
    <li
      className={cn(
        "relative border-b border-line transition-colors hover:bg-surface-hover focus-within:bg-surface-hover",
        overdue && "bg-warn-soft"
      )}
      data-testid="reminder-row"
      data-due={overdue ? "overdue" : "upcoming"}
      data-reminder-id={reminder.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        to={to}
        onClick={() => {
          if (reminder.messageSeq !== undefined) {
            watchForMessage(reminder.messageSeq);
          }
        }}
        className="flex gap-3 py-2 pl-4 pr-8 focus-visible:focus-ring"
        data-testid="reminder-row-link"
      >
        <span className="shrink-0 pt-1" aria-hidden="true">
          <Bell className={cn("size-4", overdue ? "text-warn" : "text-ink-muted")} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <span
              className="min-w-0 truncate text-body font-semibold text-ink"
              data-testid="reminder-row-preview"
            >
              {reminderPreviewText(reminder)}
            </span>
            <span
              className="min-w-0 truncate text-meta text-ink-muted"
              data-testid="reminder-row-channel"
            >
              {sourceLabel}
            </span>
            <span
              className={cn(
                "shrink-0 text-timestamp",
                overdue ? "text-warn" : "text-ink-muted"
              )}
              data-numeric
              data-testid="reminder-row-due"
            >
              {reminderDueLabel(reminder.dueAtMs, nowMs)}
            </span>
          </span>
          {reminder.note ? (
            <span className="truncate text-body text-ink-muted">
              {reminder.note}
            </span>
          ) : null}
        </span>
      </Link>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={offline || pending}
          onClick={onComplete}
          data-testid="reminder-complete"
        >
          {REMINDER_COMPLETE_LABEL}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={offline || pending}
              data-testid="reminder-snooze"
            >
              {REMINDER_SNOOZE_LABEL}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="reminder-snooze-menu">
            {REMINDER_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                data-testid={`reminder-snooze-${preset.id}`}
                onSelect={() => onSnoozePreset(preset.id)}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="reminder-snooze-custom"
              onSelect={onSnoozeCustom}
            >
              {REMINDER_CUSTOM_LABEL}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {showOverflow ? (
        <div className={overflowBowlClass}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="알림 메뉴"
                title="알림 메뉴"
                data-testid="reminder-row-menu"
                className={overflowTriggerClass}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="reminder-row-menu-panel">
              <DropdownMenuItem
                tone="danger"
                data-testid="reminder-row-delete"
                disabled={offline || pending}
                onSelect={onDelete}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                {REMINDER_DELETE_LABEL}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </li>
  );
}
