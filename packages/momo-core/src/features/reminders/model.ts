import type { LocaleService } from "../../i18n/context";
import type { PlainMessageKey } from "../../i18n/keys";
import { arrayField, num, record, str, WireShapeError } from "../../lib/wire";

/** 알림 칸의 값 없는 문장의 키(#6058). */
export type ReminderPlainKey = Extract<PlainMessageKey, `reminders.${string}`>;

type FormatMessage = LocaleService["formatMessage"];

// =============================================================================
// Message reminder domain (ADR-0175 / A-41). Pure: wire parse, copy, watermark
// plan. Transport lives in ./api.ts; storage of the watermark is a host job.
//
// The list is owner-only on the server (foreign rows 404, agents 403). The
// client does not surface those statuses as product features.
// =============================================================================

/** UI cap. The server check is 500; the form never offers more than this. */
export const REMINDER_NOTE_MAX = 200;

export const REMINDERS_POLL_MS = 30_000;

/**
 * Hidden-window / return-from-background due arrivals fire one OS banner
 * apiece until this many. Above it, a single "밀린 알림 n건" summary.
 */
export const DUE_NOTIFY_BURST_CAP = 3;

export type ReminderListState = "pending" | "all";

export interface MessageReminder {
  id: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  messageId: string;
  dueAtMs: number;
  note?: string;
  completedAtMs?: number;
  createdAtMs: number;
  updatedAtMs?: number;
  /** First line of the source message, when the list projection carries it. */
  messagePreview?: string;
  /** Channel seq of the source message, when the list projection carries it. */
  messageSeq?: number;
}

export interface ReminderPage {
  reminders: MessageReminder[];
  nextCursor?: string;
}

export interface CreateReminderInput {
  channelId: string;
  messageId: string;
  dueAtMs: number;
  note?: string;
}

export interface PatchReminderInput {
  dueAtMs?: number;
  completed?: true;
}

export function clampReminderNote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= REMINDER_NOTE_MAX) return trimmed;
  return trimmed.slice(0, REMINDER_NOTE_MAX);
}

export function reminderNoteForWire(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const clamped = clampReminderNote(raw);
  return clamped === "" ? undefined : clamped;
}

export function reminderIsPending(reminder: MessageReminder): boolean {
  return reminder.completedAtMs === undefined;
}

export function reminderIsOverdue(
  reminder: MessageReminder,
  nowMs: number
): boolean {
  return reminderIsPending(reminder) && reminder.dueAtMs <= nowMs;
}

export function reminderPreviewText(formatMessage: FormatMessage, reminder: MessageReminder): string {
  const preview = reminder.messagePreview?.replace(/\s+/g, " ").trim();
  if (preview) return preview;
  const note = reminder.note?.replace(/\s+/g, " ").trim();
  if (note) return note;
  return formatMessage("reminders.item.fallbackPreview");
}

/**
 * Relative due copy. Past due is a status, not a countdown; future values
 * count forward so a list of upcoming reminders is not all "방금".
 */
export function reminderDueLabel(formatMessage: FormatMessage, dueAtMs: number, nowMs: number): string {
  if (dueAtMs <= nowMs) return formatMessage("reminders.due.overdue");
  const minutes = Math.round((dueAtMs - nowMs) / 60_000);
  if (minutes < 1) return formatMessage("reminders.due.soon");
  if (minutes < 60) return formatMessage("reminders.due.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatMessage("reminders.due.hours", { count: hours });
  return formatMessage("reminders.due.days", { count: Math.round(hours / 24) });
}

export interface DueArrivalPlan {
  /** Newly due since the last check. Fire a local notification for these. */
  notifyIds: string[];
  /** Every currently overdue pending row. List badge / highlight. */
  badgeIds: string[];
  nextWatermarkMs: number;
  /**
   * When more than `DUE_NOTIFY_BURST_CAP` rows crossed due at once, fire one
   * summary instead of a stack. `notifyIds` is empty in that case.
   */
  backlogCount?: number;
  /** Rows that would have been notified, so the session can mark them announced. */
  backlogIds?: string[];
}

/**
 * First-entry past-due bomb prevention (A-41, buzz rule).
 *
 * A missing watermark is the first look at this workspace: overdue rows become
 * list badges and never a stack of arrival notifications. Later polls notify
 * only rows whose `dueAtMs` is after the last check (and not already announced
 * this session).
 */
export function dueArrivalPlan(args: {
  reminders: readonly MessageReminder[];
  nowMs: number;
  watermarkMs: number | null;
  announcedIds: ReadonlySet<string>;
}): DueArrivalPlan {
  const overdue = args.reminders.filter((row) =>
    reminderIsOverdue(row, args.nowMs)
  );
  const badgeIds = overdue.map((row) => row.id);
  if (args.watermarkMs === null) {
    return {
      notifyIds: [],
      badgeIds,
      nextWatermarkMs: args.nowMs,
    };
  }
  const crossed = overdue.filter(
    (row) => row.dueAtMs > args.watermarkMs! && !args.announcedIds.has(row.id)
  );
  if (crossed.length > DUE_NOTIFY_BURST_CAP) {
    return {
      notifyIds: [],
      badgeIds,
      nextWatermarkMs: args.nowMs,
      backlogCount: crossed.length,
      backlogIds: crossed.map((row) => row.id),
    };
  }
  return {
    notifyIds: crossed.map((row) => row.id),
    badgeIds,
    nextWatermarkMs: args.nowMs,
  };
}

export type ReminderFailureVerb = "create" | "snooze" | "complete" | "delete";

export function reminderFailureKey(
  error: unknown,
  verb: ReminderFailureVerb = "create"
): ReminderPlainKey {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  if (status === 400) return "reminders.error.pastTime";
  if (status === 404) return "reminders.error.notFound";
  if (status === 403) {
    return verb === "create" ? "reminders.error.forbiddenCreate" : "reminders.error.forbiddenChange";
  }
  if (verb === "snooze") return "reminders.error.snoozeFailed";
  if (verb === "complete") return "reminders.error.completeFailed";
  if (verb === "delete") return "reminders.error.deleteFailed";
  return "reminders.error.saveFailed";
}

export function reminderBacklogNotificationBody(formatMessage: FormatMessage, count: number): string {
  return formatMessage("reminders.notify.backlog", { count });
}

export const REMINDER_LOAD_FAILURE_KEY = "reminders.error.loadFailed" satisfies ReminderPlainKey;

export const REMINDER_EMPTY_HEADLINE_KEY = "reminders.empty.headline" satisfies ReminderPlainKey;
export const REMINDER_EMPTY_DETAIL_KEY = "reminders.empty.detail" satisfies ReminderPlainKey;
export const REMINDER_MENU_KEY = "reminders.menu.remind" satisfies ReminderPlainKey;
export const REMINDER_TAB_KEY = "reminders.tab.later" satisfies ReminderPlainKey;
export const REMINDER_NOTIFY_TITLE_KEY = "reminders.notify.title" satisfies ReminderPlainKey;
export const REMINDER_COMPLETE_KEY = "reminders.action.complete" satisfies ReminderPlainKey;
export const REMINDER_SNOOZE_KEY = "reminders.action.snooze" satisfies ReminderPlainKey;
export const REMINDER_DELETE_KEY = "reminders.action.delete" satisfies ReminderPlainKey;
export const REMINDER_CUSTOM_KEY = "reminders.action.custom" satisfies ReminderPlainKey;
export const REMINDER_SNOOZE_COMMIT_KEY = "reminders.action.snoozeCommit" satisfies ReminderPlainKey;
export const REMINDER_UNKNOWN_CHANNEL_KEY = "reminders.channel.unknown" satisfies ReminderPlainKey;
export const REMINDER_COMPLETE_CONFIRM_TITLE_KEY = "reminders.confirm.title" satisfies ReminderPlainKey;
export const REMINDER_COMPLETE_CONFIRM_DETAIL_KEY = "reminders.confirm.detail" satisfies ReminderPlainKey;

function optionalMs(source: unknown, key: string): number | undefined {
  const value = num(source, key);
  return value === undefined ? undefined : value;
}

export function parseReminder(value: unknown): MessageReminder | null {
  const id = str(value, "id");
  const workspaceId = str(value, "workspaceId");
  const memberId = str(value, "memberId");
  const channelId = str(value, "channelId");
  const messageId = str(value, "messageId");
  const dueAtMs = num(value, "dueAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    memberId === undefined ||
    channelId === undefined ||
    messageId === undefined ||
    dueAtMs === undefined
  ) {
    return null;
  }
  const createdAtMs = num(value, "createdAtMs") ?? 0;
  const note = str(value, "note");
  const completedAtMs = optionalMs(value, "completedAtMs");
  const updatedAtMs = optionalMs(value, "updatedAtMs");
  const messagePreview = str(value, "messagePreview") ?? str(value, "body");
  const messageSeq = num(value, "messageSeq") ?? num(value, "seq");
  const reminder: MessageReminder = {
    id,
    workspaceId,
    memberId,
    channelId,
    messageId,
    dueAtMs,
    createdAtMs,
  };
  if (note !== undefined && note !== "") reminder.note = note;
  if (completedAtMs !== undefined) reminder.completedAtMs = completedAtMs;
  if (updatedAtMs !== undefined) reminder.updatedAtMs = updatedAtMs;
  if (messagePreview !== undefined && messagePreview !== "") {
    reminder.messagePreview = messagePreview;
  }
  if (messageSeq !== undefined) reminder.messageSeq = messageSeq;
  return reminder;
}

export function parseReminderPage(value: unknown): ReminderPage {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const wrapped = arrayField(source, "reminders");
  if (wrapped === null) throw new WireShapeError();
  const reminders: MessageReminder[] = [];
  for (const row of wrapped) {
    const parsed = parseReminder(row);
    if (parsed === null) throw new WireShapeError();
    reminders.push(parsed);
  }
  const nextCursor = str(source, "nextCursor");
  return nextCursor === undefined ? { reminders } : { reminders, nextCursor };
}

export function parseReminderResponse(value: unknown): MessageReminder {
  const source = record(value) ?? {};
  const nested = source.reminder;
  const parsed = parseReminder(nested === undefined ? value : nested);
  if (parsed === null) throw new WireShapeError();
  return parsed;
}

export function isReminderListState(value: string): value is ReminderListState {
  return value === "pending" || value === "all";
}
