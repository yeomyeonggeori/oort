import {localDateInputValue} from '@momo/core/features/presence/customStatus';

// =============================================================================
// 「직접 고르기」의 달력과 시계 — 순수 함수 (ADR-0204 D2, #2899).
//
// 폰에는 날짜·시각 입력 컨트롤이 없고, 새 네이티브 의존(datetimepicker)을 들이면
// `pod install`·Podfile.lock·NOTICE·재빌드가 따라온다(상태 글 장이 같은 이유로 「시각
// 고르기」를 싣지 않았다, `StatusPage`). 그래서 이 장은 JS 만으로 서는 달력 한 달과 시계
// 칩으로 고른다. 이 파일은 그 계산만 둔다 — 그리는 일은 `PauseUntilCustom` 의 몫이다.
//
// 고른 값은 `customPauseUntil(날짜, 시각, 지금)` 으로 끝 시각이 된다(웹의 날짜·시간 칸과
// 같은 검증). 그래서 이 파일은 `YYYY-MM-DD` 와 `HH:MM` 문자열을 만드는 데서 멈춘다.
// =============================================================================

export type Meridiem = 'am' | 'pm';

export interface DayPick {
  year: number;
  monthIndex: number;
  day: number;
}

export interface TimePick {
  meridiem: Meridiem;
  /** 1~12. */
  hour12: number;
  /** 0~55, `MINUTE_STEP` 단위. */
  minute: number;
}

export interface MonthView {
  year: number;
  monthIndex: number;
}

/** 분 칩의 간격. 12칸이라 한 줄에 여섯, 두 줄이다. */
export const MINUTE_STEP = 5;
export const MINUTES: readonly number[] = Array.from(
  {length: 60 / MINUTE_STEP},
  (_, index) => index * MINUTE_STEP,
);
export const HOURS12: readonly number[] = Array.from(
  {length: 12},
  (_, index) => index + 1,
);

/** 한국 달력은 일요일부터 시작한다. */
export const WEEKDAY_HEADS = ['일', '월', '화', '수', '목', '금', '토'] as const;

const WEEKDAY_LONG = [
  '일요일',
  '월요일',
  '화요일',
  '수요일',
  '목요일',
  '금요일',
  '토요일',
] as const;

/**
 * 한 달의 주 목록. 칸은 날짜이거나(`1`~) 앞뒤를 채우는 빈 칸(`null`)이고, 모든 주가 7칸이다.
 */
export function monthWeeks(
  year: number,
  monthIndex: number,
): (number | null)[][] {
  const leading = new Date(year, monthIndex, 1).getDay();
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({length: leading}, () => null),
    ...Array.from({length: days}, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let at = 0; at < cells.length; at += 7) weeks.push(cells.slice(at, at + 7));
  return weeks;
}

export function addMonths(view: MonthView, delta: number): MonthView {
  const at = new Date(view.year, view.monthIndex + delta, 1);
  return {year: at.getFullYear(), monthIndex: at.getMonth()};
}

/** 「2026년 10월」. */
export function monthTitle(view: MonthView): string {
  return `${view.year}년 ${view.monthIndex + 1}월`;
}

/** 읽어 주는 이름 — 「10월 17일 토요일」. */
export function dayAccessibilityLabel(pick: DayPick): string {
  const weekday = new Date(pick.year, pick.monthIndex, pick.day).getDay();
  return `${pick.monthIndex + 1}월 ${pick.day}일 ${WEEKDAY_LONG[weekday]}`;
}

/** `YYYY-MM-DD` — 웹의 날짜 칸과 같은 모양이다. */
export function dayKey(pick: DayPick): string {
  return localDateInputValue(
    new Date(pick.year, pick.monthIndex, pick.day).getTime(),
  );
}

/** `HH:MM`(24시간). 12시는 오전이면 0시, 오후면 12시다. */
export function timeKey(pick: TimePick): string {
  const hour24 = (pick.hour12 % 12) + (pick.meridiem === 'pm' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${String(pick.minute).padStart(2, '0')}`;
}

/** 이 날이 오늘보다 앞인가(고를 수 없는 칸). 시각은 보지 않고 달력의 날만 센다. */
export function isBeforeToday(pick: DayPick, nowMs: number): boolean {
  const today = new Date(nowMs);
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  return new Date(pick.year, pick.monthIndex, pick.day).getTime() < todayStart;
}

export function isSameDay(a: DayPick, b: DayPick): boolean {
  return (
    a.year === b.year && a.monthIndex === b.monthIndex && a.day === b.day
  );
}

export function todayPick(nowMs: number): DayPick {
  const today = new Date(nowMs);
  return {
    year: today.getFullYear(),
    monthIndex: today.getMonth(),
    day: today.getDate(),
  };
}

/**
 * 처음 놓이는 값 — 지금 다음의 정각. 고르기를 열면 바로 미래의 값이라 확인이 눌리고,
 * 사람은 거기서 날짜나 시각만 고친다. 23시 반이면 다음 날 0시다.
 */
export function nextWholeHour(nowMs: number): {day: DayPick; time: TimePick} {
  const at = new Date(nowMs);
  at.setMinutes(0, 0, 0);
  at.setHours(at.getHours() + 1);
  const hour24 = at.getHours();
  return {
    day: {year: at.getFullYear(), monthIndex: at.getMonth(), day: at.getDate()},
    time: {
      meridiem: hour24 < 12 ? 'am' : 'pm',
      hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
      minute: 0,
    },
  };
}
