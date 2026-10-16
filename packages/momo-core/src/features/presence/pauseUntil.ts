import {
  customExpiryAtMs,
  localDateInputValue,
} from "./customStatus";
import { PRESENCE_DND_HINT } from "./model";

// =============================================================================
// 알림 일시 중지·방해 금지의 기한 (ADR-0204 D2, #2899).
//
// 멈춤에는 **항상 기한이 있다.** 두 스위치(알림 일시 중지, 방해 금지)는 기한을 고르고
// 나서야 켜지고, 「직접 끌 때까지」는 고를 수 없다. 서버 계약은 그대로다
// (`dndUntilMs`, `null` = 기한 없음) — 이미 있는 기한 없는 행은 판정을 바꾸지 않고
// 화면에서 「기한 없음 · 기한 정하기」로 보일 뿐이다.
//
// 이 파일은 순수 함수와 낱말만 둔다. 폰과 웹이 같은 목록·같은 시각 계산·같은 문장을
// 쓰도록 한 곳에 있다(`presence/model.ts` 가 낱말을 코어에 두는 이유와 같다). 모든
// 함수는 `nowMs` 를 받는다 — 지금 시각을 안에서 읽지 않으니 시험이 시계를 고정한다.
//
// ## 시각은 로컬 시계로 읽는다
//
// 「내일 오전 9시」는 이 기기의 달력과 시계로 센다. 서버는 에폭 ms 만 받으므로 어느
// 시간대의 9시인지는 서버가 알 필요가 없다. 날짜를 더할 때는 `setDate` 로 하루를 더한 뒤
// `setHours` 로 9시를 맞춘다 — 24시간을 더하면 서머타임이 있는 날 8시나 10시가 된다.
//
// ## 「다음 주 월요일」 = 오늘보다 **뒤의** 첫 월요일
//
// 월요일에 고르면 7일 뒤, 일요일에 고르면 내일이다. 그래서 일요일에는 이 선택이
// 「내일 오전 9시까지」와 같은 시각이 되고, 같은 시각을 두 줄로 세우지 않으려고
// `pauseUntilOptions` 가 뒤의 것을 뺀다.
//
// ## 「내일」은 달력의 내일이다
//
// 새벽 1시에 「내일 오전 9시까지」를 고르면 32시간이다. 오늘 아침 9시를 뜻했다면 짧은
// 선택(30분·1시간·2시간) 또는 「직접 고르기」가 있다. 줄에 고른 시각이 날짜와 함께
// 보이므로(`pauseUntilHint`) 틀린 선택은 누르기 전에 읽힌다.
// =============================================================================

export type PauseUntilPreset = "30m" | "1h" | "2h" | "tomorrow" | "nextMonday";

/** 목록의 한 줄. `custom` 은 시각을 직접 고르는 길이다. */
export type PauseUntilChoice = PauseUntilPreset | "custom";

export interface PauseUntilOption {
  id: PauseUntilChoice;
  label: string;
}

/**
 * 기한 목록의 **차례와 낱말**. 「직접 끌 때까지」는 없다 — 목록에 넣는 순간 15일 동안
 * 풀리지 않은 일시 중지가 다시 생긴다.
 */
export const PAUSE_UNTIL_OPTIONS: readonly PauseUntilOption[] = [
  { id: "30m", label: "30분" },
  { id: "1h", label: "1시간" },
  { id: "2h", label: "2시간" },
  { id: "tomorrow", label: "내일 오전 9시까지" },
  { id: "nextMonday", label: "다음 주 월요일 오전 9시까지" },
  { id: "custom", label: "직접 고르기" },
];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MORNING_HOUR = 9;

/** 오늘로부터 `addDays` 일 뒤, 이 기기 시계의 오전 9시. */
function morningAtMs(nowMs: number, addDays: number): number {
  const at = new Date(nowMs);
  at.setDate(at.getDate() + addDays);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  return at.getTime();
}

/** 오늘보다 뒤의 첫 월요일까지 남은 날수. 월 7 · 화 6 · … · 토 2 · 일 1. */
function daysUntilNextMonday(nowMs: number): number {
  const weekday = new Date(nowMs).getDay();
  return ((8 - weekday) % 7) || 7;
}

/** 고른 선택이 끝나는 시각(에폭 ms). `custom` 은 여기서 다루지 않는다. */
export function pauseUntilAtMs(
  preset: PauseUntilPreset,
  nowMs: number
): number {
  switch (preset) {
    case "30m":
      return nowMs + 30 * MINUTE_MS;
    case "1h":
      return nowMs + 60 * MINUTE_MS;
    case "2h":
      return nowMs + 120 * MINUTE_MS;
    case "tomorrow":
      return morningAtMs(nowMs, 1);
    case "nextMonday":
      return morningAtMs(nowMs, daysUntilNextMonday(nowMs));
  }
}

/**
 * 지금 보여 줄 기한 목록. 일요일에는 「다음 주 월요일」이 「내일」과 같은 시각이라 뺀다.
 */
export function pauseUntilOptions(nowMs: number): readonly PauseUntilOption[] {
  const sameMorning =
    pauseUntilAtMs("tomorrow", nowMs) === pauseUntilAtMs("nextMonday", nowMs);
  return sameMorning
    ? PAUSE_UNTIL_OPTIONS.filter((option) => option.id !== "nextMonday")
    : PAUSE_UNTIL_OPTIONS;
}

const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 12시간제 시계 — 「오후 9:30」, 자정은 「오전 12:05」, 정오는 「오후 12:00」. */
function clock12(at: Date): string {
  const hour = at.getHours();
  const minute = String(at.getMinutes()).padStart(2, "0");
  const meridiem = hour < 12 ? "오전" : "오후";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${meridiem} ${hour12}:${minute}`;
}

/** 이 기기 달력으로 `at` 이 `now` 보다 며칠 뒤인가(서머타임에 흔들리지 않게 날짜로 센다). */
function calendarDaysAhead(at: Date, now: Date): number {
  const atDay = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((atDay - nowDay) / DAY_MS);
}

/** 「10월 19일(월)」 — 해가 다르면 「2027년 1월 3일(일)」. */
function absoluteDate(at: Date, now: Date): string {
  const year = at.getFullYear() === now.getFullYear() ? "" : `${at.getFullYear()}년 `;
  return `${year}${at.getMonth() + 1}월 ${at.getDate()}일(${WEEKDAY_NAMES[at.getDay()]})`;
}

/**
 * 기한의 이름 — 「오후 9:30까지」. 오늘이면 시계만, 내일이면 「내일 오전 9:00까지」,
 * 그 뒤로는 날짜가 붙는다(「10월 19일(월) 오전 9:00까지」).
 *
 * 12시간제인 것은 ADR-0204 D3 이 이 줄을 「오후 9:30까지」로 적었기 때문이다. 상태 글의
 * 만료(`statusExpiryShortLabel`, 24시간제)와 다른 기능의 다른 문장이다.
 */
export function pauseUntilLabel(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const ahead = calendarDaysAhead(at, now);
  const clock = clock12(at);
  if (ahead <= 0) return `${clock}까지`;
  if (ahead === 1) return `내일 ${clock}까지`;
  return `${absoluteDate(at, now)} ${clock}까지`;
}

/** 기한 없는 행의 이름 — 「기한 없음」. */
export const PAUSE_UNTIL_NONE_LABEL = "기한 없음";

/** 기한 없는 행에서 기한을 거는 길의 낱말. */
export const PAUSE_UNTIL_SET_ACTION = "기한 정하기";

/** 기한이 있는 행에서 기한을 다시 고르는 길의 낱말. */
export const PAUSE_UNTIL_CHANGE_ACTION = "기한 바꾸기";

/** 알림 일시 중지가 켜져 있는 동안 스위치 줄이 말하는 것. 기한은 따로 줄이 말한다. */
export const PAUSE_ACTIVE_NOTE = "이 워크스페이스의 알림을 받지 않아요.";

/** ADR-0204 D2 의 줄: 「기한 없음 · 기한 정하기」. */
export const PAUSE_UNTIL_NONE_ACTION_LABEL = `${PAUSE_UNTIL_NONE_LABEL} · ${PAUSE_UNTIL_SET_ACTION}`;

/** 진행 중인 기한의 이름: 값이 있으면 「오후 9:30까지」, 없으면 「기한 없음」. */
export function pauseUntilStateLabel(
  untilMs: number | undefined,
  nowMs: number
): string {
  return untilMs === undefined
    ? PAUSE_UNTIL_NONE_LABEL
    : pauseUntilLabel(untilMs, nowMs);
}

/**
 * 기한 행에 곁들이는 구체적인 끝 시각. 짧은 선택(30분·1시간·2시간)은 「오후 9:30까지」,
 * 날짜로 이름 붙은 선택은 줄 이름에 「오전 9시까지」가 이미 있으므로 날짜만 말한다 —
 * 「내일 오전 9시까지 / 내일 오전 9:00까지」처럼 같은 말을 두 번 읽히지 않는다.
 */
export function pauseUntilHint(
  preset: PauseUntilPreset,
  nowMs: number
): string {
  const atMs = pauseUntilAtMs(preset, nowMs);
  if (preset === "tomorrow" || preset === "nextMonday") {
    return absoluteDate(new Date(atMs), new Date(nowMs));
  }
  return pauseUntilLabel(atMs, nowMs);
}

export type CustomPauseUntil =
  | { ok: true; atMs: number }
  | { ok: false; reason: "invalid" | "past" };

/**
 * 「직접 고르기」의 날짜(`YYYY-MM-DD`)와 시각(`HH:MM`)을 끝 시각으로 바꾼다.
 *
 * `customExpiryAtMs` 는 「2월 31일」을 3월 3일로 말없이 굴린다. 입력 칸이 만들 수 없는
 * 날짜지만, 거절이 아니라 다른 날 오전에 멈추는 쪽이 사고라서 되읽어 같은지 본다.
 * 서버는 미래가 아니면 400 이므로 지난 시각은 보내기 전에 막는다.
 */
export function customPauseUntil(
  date: string,
  time: string,
  nowMs: number
): CustomPauseUntil {
  const atMs = customExpiryAtMs(date, time);
  if (atMs === null || localDateInputValue(atMs) !== date) {
    return { ok: false, reason: "invalid" };
  }
  if (atMs <= nowMs) return { ok: false, reason: "past" };
  return { ok: true, atMs };
}

// ---- 문장 ---------------------------------------------------------------------

export const PAUSE_UNTIL_INVALID_MESSAGE = "날짜와 시각을 확인하세요.";
export const PAUSE_UNTIL_PAST_MESSAGE =
  "지난 시각은 고를 수 없어요. 다른 시각을 고르세요.";

export function customPauseUntilMessage(
  reason: "invalid" | "past"
): string {
  return reason === "past"
    ? PAUSE_UNTIL_PAST_MESSAGE
    : PAUSE_UNTIL_INVALID_MESSAGE;
}

/** 어떤 스위치의 기한을 고르는가: 알림 일시 중지, 또는 방해 금지(알림도 함께 멈춘다). */
export type PauseUntilKind = "pause" | "dnd";

export const PAUSE_UNTIL_PAUSE_TITLE = "알림을 언제까지 멈출까요?";
export const PAUSE_UNTIL_DND_TITLE = "방해 금지를 언제까지 켤까요?";

export const PAUSE_UNTIL_PAUSE_DESCRIPTION =
  "이 워크스페이스의 알림을 고른 시각까지 받지 않아요. 멘션과 승인 요청도 멈춰요. 시각이 지나면 저절로 다시 와요.";

export const PAUSE_UNTIL_DND_DESCRIPTION = `${PRESENCE_DND_HINT} 시각이 지나면 저절로 풀려요.`;

export const PAUSE_UNTIL_PAUSE_CONFIRM_LABEL = "알림 멈추기";
export const PAUSE_UNTIL_DND_CONFIRM_LABEL = "방해 금지 켜기";

/**
 * 짧은 선택 줄을 읽어 주는 힌트 — 이 줄은 **누르면 곧바로 켜진다**(확인 단계가 없다).
 * 시각을 직접 정하는 「직접 고르기」 줄은 펼치기만 하므로 이 힌트를 달지 않는다.
 */
export const PAUSE_UNTIL_PAUSE_PRESET_HINT = "누르면 이 시각까지 알림을 멈춰요.";
export const PAUSE_UNTIL_DND_PRESET_HINT = "누르면 이 시각까지 방해 금지를 켜요.";

export function pauseUntilTitle(kind: PauseUntilKind): string {
  return kind === "dnd" ? PAUSE_UNTIL_DND_TITLE : PAUSE_UNTIL_PAUSE_TITLE;
}

export function pauseUntilDescription(kind: PauseUntilKind): string {
  return kind === "dnd"
    ? PAUSE_UNTIL_DND_DESCRIPTION
    : PAUSE_UNTIL_PAUSE_DESCRIPTION;
}

export function pauseUntilConfirmLabel(kind: PauseUntilKind): string {
  return kind === "dnd"
    ? PAUSE_UNTIL_DND_CONFIRM_LABEL
    : PAUSE_UNTIL_PAUSE_CONFIRM_LABEL;
}

export function pauseUntilPresetHint(kind: PauseUntilKind): string {
  return kind === "dnd"
    ? PAUSE_UNTIL_DND_PRESET_HINT
    : PAUSE_UNTIL_PAUSE_PRESET_HINT;
}
