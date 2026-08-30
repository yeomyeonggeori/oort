import { useMemo, useState, type FocusEvent } from "react";
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
import { CHIP_CLASS } from "@/features/common/chip";
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
  REMINDER_COMPLETE_CONFIRM_DETAIL,
  REMINDER_COMPLETE_CONFIRM_TITLE,
  REMINDER_COMPLETE_LABEL,
  REMINDER_CUSTOM_LABEL,
  REMINDER_DELETE_LABEL,
  REMINDER_EMPTY_DETAIL,
  REMINDER_EMPTY_HEADLINE,
  REMINDER_SNOOZE_LABEL,
  REMINDER_UNKNOWN_CHANNEL_LABEL,
  type MessageReminder,
  type ReminderFailureVerb,
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
  const [completeTarget, setCompleteTarget] = useState<MessageReminder | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const nowMs = Date.now();

  const channels = useMemo(
    () => [...groups.channels, ...groups.dms],
    [groups]
  );
  const labelFor = (channelId: string) => {
    const channel = channels.find((item) => uuidEq(item.id, channelId));
    if (!channel) return REMINDER_UNKNOWN_CHANNEL_LABEL;
    return channelLabel(channel, directory, session.member.id);
  };

  const dialogOpen =
    snoozeTarget !== null || deleteTarget !== null || completeTarget !== null;

  const run = async (
    work: () => Promise<unknown>,
    verb: ReminderFailureVerb
  ): Promise<boolean> => {
    setActionError(null);
    try {
      await work();
      return true;
    } catch (error: unknown) {
      setActionError(reminderFailureMessage(error, verb));
      return false;
    }
  };

  const snoozePreset = (reminder: MessageReminder, id: ReminderPresetId) => {
    if (offline) return;
    void run(
      () =>
        mutations.snooze.mutateAsync({
          id: reminder.id,
          dueAtMs: reminderPresetDueAtMs(id, Date.now()),
        }),
      "snooze"
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
      {actionError && !dialogOpen && (
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
            onComplete={() => {
              setActionError(null);
              setCompleteTarget(reminder);
            }}
            onSnoozePreset={(id) => snoozePreset(reminder, id)}
            onSnoozeCustom={() => {
              setActionError(null);
              setSnoozeTarget(reminder);
            }}
            onDelete={() => {
              setActionError(null);
              setDeleteTarget(reminder);
            }}
          />
        ))}
      </ul>
      <RemindDialog
        open={snoozeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSnoozeTarget(null);
            setActionError(null);
          }
        }}
        mode="snooze"
        preview={snoozeTarget ? reminderPreviewText(snoozeTarget) : undefined}
        pending={mutations.snooze.isPending}
        error={actionError}
        onCommit={(dueAtMs) => {
          if (snoozeTarget === null) return;
          const id = snoozeTarget.id;
          void run(
            () => mutations.snooze.mutateAsync({ id, dueAtMs }),
            "snooze"
          ).then((ok) => {
            if (ok) setSnoozeTarget(null);
          });
        }}
      />
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent data-testid="reminder-delete-dialog" className="gap-3 p-4">
          <DialogTitle>이 알림을 지울까요?</DialogTitle>
          <DialogDescription>
            지운 알림은 되돌릴 수 없습니다. 원문 메시지는 그대로 있습니다.
          </DialogDescription>
          {actionError && (
            <InlineBanner message={actionError} testId="reminder-delete-error" />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              data-testid="reminder-delete-cancel"
              onClick={() => {
                setDeleteTarget(null);
                setActionError(null);
              }}
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
                void run(() => mutations.remove.mutateAsync(id), "delete").then(
                  (ok) => {
                    if (ok) setDeleteTarget(null);
                  }
                );
              }}
            >
              {mutations.remove.isPending ? "지우는 중…" : REMINDER_DELETE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={completeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCompleteTarget(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent
          data-testid="reminder-complete-dialog"
          className="gap-3 p-4"
        >
          <DialogTitle>{REMINDER_COMPLETE_CONFIRM_TITLE}</DialogTitle>
          <DialogDescription>{REMINDER_COMPLETE_CONFIRM_DETAIL}</DialogDescription>
          {actionError && (
            <InlineBanner
              message={actionError}
              testId="reminder-complete-error"
            />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              data-testid="reminder-complete-cancel"
              onClick={() => {
                setCompleteTarget(null);
                setActionError(null);
              }}
            >
              취소
            </Button>
            <Button
              data-testid="reminder-complete-commit"
              disabled={mutations.complete.isPending || offline}
              onClick={() => {
                if (completeTarget === null) return;
                const id = completeTarget.id;
                void run(
                  () => mutations.complete.mutateAsync(id),
                  "complete"
                ).then((ok) => {
                  if (ok) setCompleteTarget(null);
                });
              }}
            >
              {mutations.complete.isPending ? "완료 중…" : REMINDER_COMPLETE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const overflowBowlClass =
  "rounded-md border border-line-strong bg-surface-raised p-px shadow-lg";
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
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const overdue = reminderIsOverdue(reminder, nowMs);
  const showOverflow = hoverNone || hovered || focusWithin || menuOpen;
  const to = reminderPath(reminder);

  const onFocus = (event: FocusEvent<HTMLLIElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.matches(":focus-visible")
    ) {
      setFocusWithin(true);
    }
  };
  const onBlur = (event: FocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  };

  return (
    <li
      className="relative border-b border-line transition-colors hover:bg-surface-hover focus-within:bg-surface-hover"
      data-testid="reminder-row"
      data-due={overdue ? "overdue" : "upcoming"}
      data-reminder-id={reminder.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      <div className="flex items-start gap-2 py-2 pl-4 pr-2">
        <Link
          to={to}
          onClick={() => {
            if (reminder.messageSeq !== undefined) {
              watchForMessage(reminder.messageSeq);
            }
          }}
          className="flex min-w-0 flex-1 gap-3 focus-visible:focus-ring"
          data-testid="reminder-row-link"
        >
          <span className="shrink-0 pt-1" aria-hidden="true">
            <Bell
              className={cn("size-4", overdue ? "text-warn" : "text-ink-muted")}
            />
          </span>
          <span
            className="flex min-w-0 flex-1 flex-col"
            data-reminder-row-body=""
          >
            <span className="flex min-w-0 items-baseline gap-2">
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
            </span>
            {reminder.note ? (
              <span className="truncate text-body text-ink-muted">
                {reminder.note}
              </span>
            ) : null}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              overdue
                ? cn(CHIP_CLASS, "bg-warn-soft text-warn")
                : "shrink-0 text-timestamp text-ink-muted"
            )}
            data-numeric
            data-testid="reminder-row-due"
          >
            {reminderDueLabel(reminder.dueAtMs, nowMs)}
          </span>
          <div
            className="flex w-overflow-bowl shrink-0 justify-end"
            data-testid="reminder-overflow-bowl"
          >
            {showOverflow ? (
              <div className={overflowBowlClass}>
                <DropdownMenu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  modal={false}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="알림 메뉴"
                      title="알림 메뉴"
                      data-testid="reminder-row-menu"
                      data-row-action="primary"
                      className={overflowTriggerClass}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    data-testid="reminder-row-menu-panel"
                  >
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
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <Button
          size="sm"
          variant="secondary"
          className="tap-target"
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
              className="tap-target"
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
    </li>
  );
}
