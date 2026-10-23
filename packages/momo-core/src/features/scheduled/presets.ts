import {
  customDueAtMs,
  localDateInputValue,
  localHourOnOffsetDay,
  localTimeInputValue,
  nextMondayLocalHour,
} from "../reminders/presets";
import { SCHEDULED_COPY } from "./copy";
import { SCHEDULED_MAX_LEAD_MS, SCHEDULED_MIN_LEAD_MS } from "./types";

// =============================================================================
// 예약 시각: 프리셋·직접 고르기 값·검증·표기 (UI 명세 0.2·0.6, ADR-0208 D2, #4237).
//
// 모든 계산은 **기기의 시간대**다. 예약은 절대 시각(`sendAtMs`, UTC 에포크
// 밀리초)이고 시간대는 저장하지 않는다. 그래서 같은 예약이 다른 기기에서는 그 기기의
// 시계로 그려진다. 모든 함수가 `nowMs`를 받아서(시계를 직접 읽지 않는다) 경계 시험이
// 벽시계와 무관하다.
//
// 시각 계산은 리마인더의 `localHourOnOffsetDay`·`nextMondayLocalHour`·`customDueAtMs`를
// 그대로 쓴다(복사하지 않는다): 날짜를 달력으로 더한 뒤 그 날의 9시로 맞추므로
// 서머타임 전환일(23시간·25시간인 날)에도 「다음 날 현지 9시」가 맞다.
// =============================================================================

/** 프리셋이 걸리는 현지 시각. */
export const SCHEDULED_PRESET_HOUR = 9;

const WEEKDAY_SHORT = ["일", "월", "화", "수", "목", "금", "토"] as const;
const WEEKDAY_LONG = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"] as const;
const DAY_MS = 86_400_000;

/** 현지 달력의 날짜 번호. 시간대와 무관한 정수라서 「며칠 뒤」를 24시간 곱으로 세지 않는다. */
function localDayNumber(ms: number): number {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** 「오전 9:00」·「오후 3:05」: 12시간제, 분은 두 자리, 시는 한 자리도 된다(명세 0.2). */
function timeLabel(atMs: number): string {
  const date = new Date(atMs);
  const hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const period = hour < 12 ? "오전" : "오후";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${period} ${hour12}:${minute}`;
}

function yearPrefix(atMs: number, nowMs: number): string {
  const year = new Date(atMs).getFullYear();
  return year === new Date(nowMs).getFullYear() ? "" : `${year}년 `;
}

/** 「10월 26일 (월)」, 다른 해는 「2027년 1월 4일 (월)」. 「오늘·내일」 같은 말이 아닌 날짜 표기다. */
export function formatScheduledDate(atMs: number, nowMs: number): string {
  const date = new Date(atMs);
  return `${yearPrefix(atMs, nowMs)}${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAY_SHORT[date.getDay()]})`;
}

/** 「10월 23일 금요일」, 다른 해는 연도 포함. 낭독용으로 요일을 푼다. */
function dateAria(atMs: number, nowMs: number): string {
  const date = new Date(atMs);
  return `${yearPrefix(atMs, nowMs)}${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAY_LONG[date.getDay()]}`;
}

/**
 * 시각 표기의 부품(명세 0.2). 한 문자열이 아니라 부품이다: 웹은 `full`을, 폰은 두 줄
 * 행에 `day`와 `time`을 나눠 그린다.
 *
 * - 오늘·내일·모레는 말로(`오늘 오후 3:00`). 어제를 비롯한 그 밖의 날은 날짜로
 *   (`10월 22일 (수) 오전 9:00`): 명세가 말로 쓰는 날을 셋으로 정했다.
 * - 「목요일 오후 3:00」처럼 요일만 쓰는 표기는 없다.
 * - `aria`는 요일까지 푼 문장이다. 말로 쓴 날은 뒤에 날짜를 붙인다
 *   (`내일 오전 9:00, 10월 23일 금요일`), 날짜로 쓴 날은 요일을 푼다
 *   (`10월 26일 월요일 오전 9:00`).
 */
export interface ScheduledAtParts {
  day: string;
  time: string;
  full: string;
  aria: string;
}

export function formatScheduledAt(atMs: number, nowMs: number): ScheduledAtParts {
  const diffDays = localDayNumber(atMs) - localDayNumber(nowMs);
  const time = timeLabel(atMs);
  const spoken = diffDays === 0 ? "오늘" : diffDays === 1 ? "내일" : diffDays === 2 ? "모레" : null;
  const day = spoken ?? formatScheduledDate(atMs, nowMs);
  const full = `${day} ${time}`;
  const aria = spoken === null ? `${dateAria(atMs, nowMs)} ${time}` : `${full}, ${dateAria(atMs, nowMs)}`;
  return { day, time, full, aria };
}

// ---- 시간대 줄 ------------------------------------------------------------------

/** 기기의 시간대 이름(`Asia/Seoul`). 읽지 못하는 호스트는 빈 문자열이다. */
function deviceZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * 그 시각의 UTC 오프셋 표기(`UTC+9`, `UTC+5:30`, `UTC-4`, `UTC+0`). **고른 날짜 기준**이다:
 * 서머타임이 있는 시간대는 지금과 고른 날의 오프셋이 다를 수 있다(명세 0.2).
 */
export function utcOffsetLabel(atMs: number): string {
  const minutes = -new Date(atMs).getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(rest).padStart(2, "0")}`;
}

/**
 * 시각을 고르는 자리의 시간대 부분: 「Asia/Seoul (UTC+9)」. 목록 행에는 적지 않는다.
 * `zoneName`을 주입하면 시험이 호스트와 무관하다. 이름을 읽지 못하면 오프셋만 쓴다.
 */
export function scheduledZoneLabel(atMs: number, zoneName: string = deviceZoneName()): string {
  const offset = utcOffsetLabel(atMs);
  return zoneName === "" ? offset : `${zoneName} (${offset})`;
}

/** 메뉴·대화상자의 안내 줄 한 문장: 「Asia/Seoul (UTC+9) 기준이에요」. */
export function scheduledZoneLine(atMs: number, zoneName?: string): string {
  return SCHEDULED_COPY.menu.zone(scheduledZoneLabel(atMs, zoneName));
}

// ---- 프리셋 -----------------------------------------------------------------------

export type ScheduledPresetId = "tomorrow" | "next-monday";

export interface ScheduledPreset {
  id: ScheduledPresetId;
  /** 이름: 「내일」·「다음 주 월요일」. */
  label: string;
  atMs: number;
  /** 「오전 9:00」. */
  time: string;
  /** 보조 날짜: 「10월 23일 (금)」. 「내일」처럼 말로 쓰는 날도 날짜를 함께 적는다(명세 1.3). */
  date: string;
  /** 낭독: 「내일 오전 9:00, 10월 23일 금요일」. */
  aria: string;
}

function presetFor(id: ScheduledPresetId, atMs: number, nowMs: number): ScheduledPreset {
  const parts = formatScheduledAt(atMs, nowMs);
  return {
    id,
    label: id === "tomorrow" ? SCHEDULED_COPY.preset.tomorrow : SCHEDULED_COPY.preset.nextMonday,
    atMs,
    time: parts.time,
    date: formatScheduledDate(atMs, nowMs),
    aria: parts.aria,
  };
}

/**
 * 메뉴의 프리셋. 「내일 오전 9:00」과 「다음 주 월요일 오전 9:00」 둘이다. 일요일에는 두 값이
 * 같은 시각이라(다음 주 월요일이 곧 내일) 둘째를 숨긴다. 요일이 아니라 **시각이 같은지**로
 * 판정해서, 같은 시각 두 줄이 서는 길 자체가 없다.
 */
export function scheduledPresets(nowMs: number): ScheduledPreset[] {
  const tomorrow = localHourOnOffsetDay(nowMs, 1, SCHEDULED_PRESET_HOUR);
  const nextMonday = nextMondayLocalHour(nowMs, SCHEDULED_PRESET_HOUR);
  const presets = [presetFor("tomorrow", tomorrow, nowMs)];
  if (nextMonday !== tomorrow) presets.push(presetFor("next-monday", nextMonday, nowMs));
  return presets;
}

// ---- 직접 고르기 ---------------------------------------------------------------------

export type SendAtProblem = "invalid" | "soon" | "far";

/**
 * 확인 전 검증(명세 1.4). 지금 + 60초 미만(과거 포함)은 `soon`, 120일 초과는 `far`, 값이
 * 없거나 유한하지 않으면 `invalid`다. 서버가 DB 시계로 다시 판정하고 같은 이유로 400을
 * 주므로(`send_at_too_soon`·`send_at_too_far`) 이 함수는 사전 안내다. 경계 값(정확히
 * 60초·120일)은 통과한다: 서버가 「이상」·「이하」다.
 */
export function validateSendAt(atMs: number | null, nowMs: number): SendAtProblem | null {
  if (atMs === null || !Number.isFinite(atMs)) return "invalid";
  const lead = atMs - nowMs;
  if (lead < SCHEDULED_MIN_LEAD_MS) return "soon";
  if (lead > SCHEDULED_MAX_LEAD_MS) return "far";
  return null;
}

/** 검증 결과의 오류 줄 문장. */
export function sendAtProblemSentence(problem: SendAtProblem): string {
  switch (problem) {
    case "soon":
      return SCHEDULED_COPY.dialog.errSoon;
    case "far":
      return SCHEDULED_COPY.dialog.errFar;
    case "invalid":
      return SCHEDULED_COPY.dialog.errInvalid;
  }
}

/** 새 예약의 직접 고르기 처음 값: **내일 오전 9:00**(프리셋과 같아 이미 미래다, 명세 0.6). */
export function defaultSendAtMs(nowMs: number): number {
  return localHourOnOffsetDay(nowMs, 1, SCHEDULED_PRESET_HOUR);
}

/**
 * 「시간 바꾸기」·「다시 예약」의 처음 값: **그 행의 `sendAtMs`**. 그 값이 지금 걸 수 없는
 * 시각이면(이미 지났거나 60초 안이어서 보내면 `send_at_too_soon`이다) 내일 오전 9:00이다.
 */
export function initialSendAtMs(rowSendAtMs: number | undefined, nowMs: number): number {
  if (rowSendAtMs !== undefined && validateSendAt(rowSendAtMs, nowMs) === null) return rowSendAtMs;
  return defaultSendAtMs(nowMs);
}

/**
 * `type="date"`·`type="time"` 두 칸의 값에서 실제로 걸릴 시각. 비었거나 없는 날짜(`2026-02-31`)면
 * `null`이다. 서머타임 시작의 빈 현지 시각(02:30 → 03:30)은 **앞으로 밀려** 계산되므로,
 * 결과 문장은 사람이 입력한 칸이 아니라 이 값에서 그려야 한다(명세 0.2).
 */
export function sendAtFromInputs(date: string, time: string): number | null {
  const atMs = customDueAtMs(date, time);
  if (atMs === null) return null;
  // `new Date(2026, 1, 31)`는 3월 3일로 넘어간다. 날짜가 같아야 입력한 날이다.
  return localDateInputValue(atMs) === date ? atMs : null;
}

/** 시각 → 두 칸의 초기 값. */
export function sendAtInputs(atMs: number): { date: string; time: string } {
  return { date: localDateInputValue(atMs), time: localTimeInputValue(atMs) };
}
