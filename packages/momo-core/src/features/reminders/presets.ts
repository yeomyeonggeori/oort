// =============================================================================
// Message reminder due-time presets (ADR-0175 / A-41).
//
// Five named offsets plus a custom local date+time. Every calculation is in the
// caller's local timezone; tests inject `nowMs` so "tomorrow 09:00" and "next
// Monday 09:00" boundaries do not depend on the wall clock.
// =============================================================================

export type ReminderPresetId =
  | "30m"
  | "1h"
  | "3h"
  | "tomorrow-9"
  | "next-monday-9";

export interface ReminderPreset {
  id: ReminderPresetId;
  label: string;
}

export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  { id: "30m", label: "30분 후" },
  { id: "1h", label: "1시간 후" },
  { id: "3h", label: "3시간 후" },
  { id: "tomorrow-9", label: "내일 오전 9시" },
  { id: "next-monday-9", label: "다음 주 월요일 오전 9시" },
];

/** Relative offsets stay relative. Calendar presets land on local 09:00. */
export function reminderPresetDueAtMs(
  id: ReminderPresetId,
  nowMs: number
): number {
  if (id === "30m") return nowMs + 30 * 60_000;
  if (id === "1h") return nowMs + 60 * 60_000;
  if (id === "3h") return nowMs + 3 * 60 * 60_000;
  if (id === "tomorrow-9") return localHourOnOffsetDay(nowMs, 1, 9);
  return nextMondayLocalHour(nowMs, 9);
}

/**
 * Monday of the following week, never "today if today is Monday".
 *
 * Week is Monday-Sunday. Sunday 23:00 therefore lands on tomorrow (the Monday
 * that opens next week), which is the same instant as "tomorrow 09:00".
 * Monday 00:30 does NOT pick today's 09:00: that would be this week's Monday.
 */
export function nextMondayLocalHour(nowMs: number, hour: number): number {
  const now = new Date(nowMs);
  const day = now.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  return localHourOnOffsetDay(nowMs, daysUntilMonday, hour);
}

export function localHourOnOffsetDay(
  nowMs: number,
  dayOffset: number,
  hour: number
): number {
  const date = new Date(nowMs);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Local calendar date + clock. `YYYY-MM-DD` and `HH:MM` as the native
 * `type="date"` / `type="time"` values. Invalid pieces return null rather than
 * a guessed Date.
 */
export function customDueAtMs(date: string, time: string): number | null {
  const dateMatch = DATE_RE.exec(date);
  const timeMatch = TIME_RE.exec(time);
  if (dateMatch === null || timeMatch === null) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const value = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(value) ? value : null;
}

/** `type="date"` value in the local timezone. */
export function localDateInputValue(atMs: number): string {
  const date = new Date(atMs);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `type="time"` value in the local timezone. */
export function localTimeInputValue(atMs: number): string {
  const date = new Date(atMs);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}
