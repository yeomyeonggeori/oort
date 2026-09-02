import type { PresenceStatus } from "../../lib/api";

// =============================================================================
// Custom member status (ADR-0176 / A-42). Orthogonal to declared presence
// auto/away/dnd. Wire: the same PUT /presence body, per-key patch
// (omit = keep, JSON null = clear). Visibility is a read-edge fact: a reached
// expiry is not drawn, even if a stale roster row still carries the stamp.
// =============================================================================

export const CUSTOM_STATUS_TEXT_MAX = 80;
export const CUSTOM_STATUS_EMOJI_MAX = 32;

export const CUSTOM_STATUS_PRESETS = [
  { id: "meeting", label: "회의 중", emoji: "📅" },
  { id: "commute", label: "이동 중", emoji: "🚶" },
  { id: "sick", label: "병가", emoji: "🤒" },
  { id: "vacation", label: "휴가", emoji: "🌴" },
  { id: "wfh", label: "재택", emoji: "🏠" },
] as const;

export type CustomStatusPresetId = (typeof CUSTOM_STATUS_PRESETS)[number]["id"];

export type StatusExpiryChoice = "none" | "30m" | "1h" | "today" | "custom";

export const STATUS_EXPIRY_OPTIONS: readonly {
  id: StatusExpiryChoice;
  label: string;
}[] = [
  { id: "none", label: "지우지 않음" },
  { id: "30m", label: "30분" },
  { id: "1h", label: "1시간" },
  { id: "today", label: "오늘까지" },
  { id: "custom", label: "시각 고르기" },
];

export const CUSTOM_STATUS_DIALOG_TITLE = "상태 설정";
export const CUSTOM_STATUS_MENU_LABEL = "상태 설정";
export const CUSTOM_STATUS_SAVE_LABEL = "상태 저장";
export const CUSTOM_STATUS_SAVING_LABEL = "저장 중…";
export const CUSTOM_STATUS_CLEAR_LABEL = "상태 지우기";
export const CUSTOM_STATUS_CANCEL_LABEL = "취소";
export const CUSTOM_STATUS_TEXT_LABEL = "상태 글";
export const CUSTOM_STATUS_TEXT_PLACEHOLDER = "지금 하는 일";
export const CUSTOM_STATUS_EMOJI_LABEL = "상태 이모지 고르기";
export const CUSTOM_STATUS_EMOJI_CLEAR_LABEL = "이모지 지우기";
export const CUSTOM_STATUS_EXPIRY_LABEL = "만료";
export const CUSTOM_STATUS_DIALOG_DESCRIPTION =
  "이모지와 짧은 글로 지금 하는 일을 알립니다.";

export interface PresenceWrite {
  status: PresenceStatus;
  /**
   * Present = patch. `null` clears. Omitted leaves the stored value.
   * A present key is `string | null` only: `undefined` is not a wire
   * value and must not be read as a clear (design-review #1889 N-1).
   */
  statusEmoji?: string | null;
  statusText?: string | null;
  statusExpiresAtMs?: number | null;
}

export interface PresenceSnapshot {
  status: PresenceStatus;
  statusEmoji?: string;
  statusText?: string;
  statusExpiresAtMs?: number;
}

export interface VisibleCustomStatus {
  emoji?: string;
  text?: string;
}

export interface CustomStatusFields {
  statusEmoji?: string;
  statusText?: string;
  statusExpiresAtMs?: number;
}

export function clampStatusText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= CUSTOM_STATUS_TEXT_MAX) return trimmed;
  return trimmed.slice(0, CUSTOM_STATUS_TEXT_MAX);
}

export function clampStatusEmoji(raw: string): string {
  const trimmed = raw.trim();
  const scalars = [...trimmed];
  if (scalars.length <= CUSTOM_STATUS_EMOJI_MAX) return trimmed;
  return scalars.slice(0, CUSTOM_STATUS_EMOJI_MAX).join("");
}

function optionalStringForWire(value: string | null): string | null {
  if (value === null) return null;
  const clamped = clampStatusText(value);
  return clamped === "" ? null : clamped;
}

function optionalEmojiForWire(value: string | null): string | null {
  if (value === null) return null;
  const clamped = clampStatusEmoji(value);
  return clamped === "" ? null : clamped;
}

/**
 * PUT JSON body. Keys that are absent on `write` stay absent (keep). Keys that
 * are present, including `null`, are serialized so `JSON.stringify` emits
 * `null` rather than dropping them (clear). `undefined` is omit, not clear.
 */
export function presenceWriteBody(write: PresenceWrite): Record<string, unknown> {
  const body: Record<string, unknown> = { status: write.status };
  if (write.statusEmoji !== undefined) {
    body.statusEmoji = optionalEmojiForWire(write.statusEmoji);
  }
  if (write.statusText !== undefined) {
    body.statusText = optionalStringForWire(write.statusText);
  }
  if (write.statusExpiresAtMs !== undefined) {
    body.statusExpiresAtMs = write.statusExpiresAtMs;
  }
  return body;
}

export function clearCustomStatusWrite(status: PresenceStatus): PresenceWrite {
  return {
    status,
    statusEmoji: null,
    statusText: null,
    statusExpiresAtMs: null,
  };
}

export function visibleCustomStatus(
  row: CustomStatusFields,
  nowMs: number
): VisibleCustomStatus | null {
  if (
    row.statusExpiresAtMs !== undefined &&
    row.statusExpiresAtMs < nowMs
  ) {
    return null;
  }
  const emoji = row.statusEmoji?.trim() ?? "";
  const text = row.statusText?.trim() ?? "";
  if (emoji === "" && text === "") return null;
  const visible: VisibleCustomStatus = {};
  if (emoji !== "") visible.emoji = emoji;
  if (text !== "") visible.text = text;
  return visible;
}

/**
 * Accessible name fragment for a visible custom status.
 *
 * Text is the fact when it is present (emoji stays decorative next to it).
 * An emoji-only status has no other words, so the emoji itself is the name
 * (design-review #1889 M-2).
 */
export function customStatusAccessibleText(
  row: CustomStatusFields,
  nowMs: number
): string | null {
  const visible = visibleCustomStatus(row, nowMs);
  if (!visible) return null;
  if (visible.text) return visible.text;
  return visible.emoji ?? null;
}

export function statusExpiryAtMs(
  id: Exclude<StatusExpiryChoice, "none" | "custom">,
  nowMs: number
): number {
  if (id === "30m") return nowMs + 30 * 60_000;
  if (id === "1h") return nowMs + 60 * 60_000;
  const end = new Date(nowMs);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function customExpiryAtMs(date: string, time: string): number | null {
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

export function localDateInputValue(atMs: number): string {
  const date = new Date(atMs);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTimeInputValue(atMs: number): string {
  const date = new Date(atMs);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

export function customStatusFailureMessage(): string {
  return "상태를 저장하지 못했습니다. 다시 시도하세요.";
}

export function customStatusClearFailureMessage(): string {
  return "상태를 지우지 못했습니다. 다시 시도하세요.";
}
