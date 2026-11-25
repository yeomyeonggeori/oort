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
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
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
  reminderFailureKey,
  reminderIsOverdue,
  REMINDER_LOAD_FAILURE_KEY,
  reminderPreviewText,
  REMINDER_COMPLETE_CONFIRM_DETAIL_KEY,
  REMINDER_COMPLETE_CONFIRM_TITLE_KEY,
  REMINDER_COMPLETE_KEY,
  REMINDER_CUSTOM_KEY,
  REMINDER_DELETE_KEY,
  REMINDER_EMPTY_DETAIL_KEY,
  REMINDER_EMPTY_HEADLINE_KEY,
  REMINDER_SNOOZE_KEY,
  REMINDER_UNKNOWN_CHANNEL_KEY,
  type ReminderPlainKey,
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
import { Tooltip } from "@/design/ui/tooltip";
import { useFormatMessage } from "@/i18n/useFormatMessage";

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
  const formatMessage = useFormatMessage();
  // 실패는 키로 쥔다: 띄워 둔 줄이 언어를 바꾸면 따라 바뀐다.
  const [actionErrorKey, setActionErrorKey] = useState<ReminderPlainKey | null>(null);
  const actionError = actionErrorKey === null ? null : formatMessage(actionErrorKey);
  const nowMs = Date.now();

  const channels = useMemo(
    () => [...groups.channels, ...groups.dms],
    [groups]
  );
  const labelFor = (channelId: string) => {
    const channel = channels.find((item) => uuidEq(item.id, channelId));
    if (!channel) return formatMessage(REMINDER_UNKNOWN_CHANNEL_KEY);
    return channelLabel(channel, directory, session.member.id);
  };

  const dialogOpen =
    snoozeTarget !== null || deleteTarget !== null || completeTarget !== null;

  const run = async (
    work: () => Promise<unknown>,
    verb: ReminderFailureVerb
  ): Promise<boolean> => {
    setActionErrorKey(null);
    try {
      await work();
      return true;
    } catch (error: unknown) {
      setActionErrorKey(reminderFailureKey(error, verb));
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

  if (query.isError) {
    return (
      <InlineBanner
        message={formatMessage(REMINDER_LOAD_FAILURE_KEY)}
        actionLabel="다시 시도"
        onAction={() => void query.refetch()}
        testId="reminders-error"
      />
    );
  }

  const reminders = query.data?.reminders ?? [];
  if (!query.isLoading && reminders.length === 0) {
    return (
      <EmptyInvite
        headline={formatMessage(REMINDER_EMPTY_HEADLINE_KEY)}
        detail={formatMessage(REMINDER_EMPTY_DETAIL_KEY)}
        testId="reminders-empty"
      />
    );
  }

  return (
    <Skeleton ready={!query.isLoading} rows={3} className="p-4">
      {query.isLoading ? null : (
        <div data-testid="reminders-panel">
          {actionError && !dialogOpen && (
            <InlineBanner
              message={actionError}
              actionLabel="닫기"
              onAction={() => setActionErrorKey(null)}
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
                  setActionErrorKey(null);
                  setCompleteTarget(reminder);
                }}
                onSnoozePreset={(id) => snoozePreset(reminder, id)}
                onSnoozeCustom={() => {
                  setActionErrorKey(null);
                  setSnoozeTarget(reminder);
                }}
                onDelete={() => {
                  setActionErrorKey(null);
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
                setActionErrorKey(null);
              }
            }}
            mode="snooze"
            preview={snoozeTarget ? reminderPreviewText(formatMessage, snoozeTarget) : undefined}
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
                setActionErrorKey(null);
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
                    setActionErrorKey(null);
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
                  {mutations.remove.isPending ? "지우는 중…" : formatMessage(REMINDER_DELETE_KEY)}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog
            open={completeTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setCompleteTarget(null);
                setActionErrorKey(null);
              }
            }}
          >
            <DialogContent
              data-testid="reminder-complete-dialog"
              className="gap-3 p-4"
            >
              <DialogTitle>{formatMessage(REMINDER_COMPLETE_CONFIRM_TITLE_KEY)}</DialogTitle>
              <DialogDescription>{formatMessage(REMINDER_COMPLETE_CONFIRM_DETAIL_KEY)}</DialogDescription>
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
                    setActionErrorKey(null);
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
                  {mutations.complete.isPending ? "완료 중…" : formatMessage(REMINDER_COMPLETE_KEY)}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </Skeleton>
  );
}

const overflowBowlClass =
  "rounded-md border border-line-strong bg-surface-raised p-px shadow-lg";
const overflowTriggerClass =
  "tap-target flex size-control items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring data-[state=open]:bg-surface-hover data-[state=open]:text-ink";

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
  const formatMessage = useFormatMessage();
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
      className="relative border-b border-line hover:bg-surface-hover focus-within:bg-surface-hover"
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
          className="flex w-full min-w-0 flex-1 gap-3 hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
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
                {reminderPreviewText(formatMessage, reminder)}
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
            {reminderDueLabel(formatMessage, reminder.dueAtMs, nowMs)}
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
                  <Tooltip label="알림 메뉴" side="bottom">
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label="알림 메뉴"
                        data-testid="reminder-row-menu"
                        data-row-action="primary"
                        className={overflowTriggerClass}
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                  </Tooltip>
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
                      {formatMessage(REMINDER_DELETE_KEY)}
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
          {formatMessage(REMINDER_COMPLETE_KEY)}
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
              {formatMessage(REMINDER_SNOOZE_KEY)}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="reminder-snooze-menu">
            {REMINDER_PRESETS.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                data-testid={`reminder-snooze-${preset.id}`}
                onSelect={() => onSnoozePreset(preset.id)}
              >
                {formatMessage(preset.labelKey)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="reminder-snooze-custom"
              onSelect={onSnoozeCustom}
            >
              {formatMessage(REMINDER_CUSTOM_KEY)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
