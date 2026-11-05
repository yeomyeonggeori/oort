// =============================================================================
// 「수정됨」과 고친 시각의 문장 (#5326, #5191 후속) — 웹·데스크탑·폰이 같은 한 함수를 쓴다.
//
// 메시지를 고치면 서버가 `edited_at` 을 찍고(`edit_message_in_tx`), 그 값이 `editedAtMs` 로 모든 읽기(기록 페이지·
// PATCH 응답)와 `message.edited` 프레임에 실린다. 화면은 그 값을 두 곳에서 말한다.
//
//   표지   본문 밑 꼬리의 「수정됨」 한 낱말(`mark`). 웹은 이 낱말에 가리키거나 초점이 가면 시각 문장을 띄우고,
//          폰은 이 낱말을 누르거나 길게 누르기 시트 머리에서 시각 문장을 보여 준다(`full`).
//   문장   「오후 2:05에 수정됨」(오늘) · 「어제 오후 2:05에 수정됨」 · 「11월 3일 오후 2:05에 수정됨」 ·
//          「2025년 12월 31일 오후 2:05에 수정됨」(다른 해). 오래된 날일수록 시각 앞의 말이 길어진다.
//
// 문구는 i18n 사전(`timeline.edited.*`)에서만 나온다. 시각은 언어 서비스의 `formatTime`·`formatDate`(문맥의 시간대·
// 시계 방식·지역 형식)로 지어 문자열 인자로 넘긴다 — ICU 시각 인자는 시계 방식을 따르지 않는 알려진 빈틈이 있다
// (`teamAiLimitsView.resetLine` 과 같은 길). 그래서 일곱 언어의 시각 모양은 사전이 아니라 `Intl` 이 정하고, 사전은
// 「~에 수정됨」 틀만 갖는다.
//
// **「오늘」은 보는 사람의 시간대의 달력 날짜다.** 24시간 차가 아니다: 자정 직전에 고친 글은 두 시간 뒤에 「어제」이고,
// 서머타임이 낀 날도 달력으로 센다. 시계는 호출자가 넘기는 `nowMs` 하나다(이 파일은 `Date.now()` 를 읽지 않는다):
// 시험이 자정을 건너는 시계를 그대로 줄 수 있고, 화면은 자기가 쓰는 시계를 하나로 둔다.
// 서버 시계와 내 시계가 어긋나 「고친 시각」이 내 지금보다 앞서도(미래) 「오늘」이다 — 그 글은 이미 고쳐진 글이고, 없는
// 시각을 내밀 이유가 없다.
//
// 이 파일에는 DOM·React·fetch가 없다.
// =============================================================================

import type { LocaleService } from "../../i18n/context";
import type { Message } from "../../lib/api";

/** 문장 조립에 필요한 언어 서비스의 일부. 화면은 설치된 서비스를 통째로 넘긴다. */
export type EditedLabelLocale = Pick<
  LocaleService,
  "formatMessage" | "formatTime" | "formatDate" | "formatRelativeTime" | "context"
>;

interface ZonedDay {
  year: number;
  /** 1970-01-01 부터 센 달력 날짜 번호. 두 날의 차는 시간대 안의 날 수다. */
  dayNumber: number;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** `epochMs` 가 `timeZone` 의 달력으로 어느 해 어느 날인가. 정확한 날 수를 내기 위해 UTC 로 접어 센다. */
function zonedDay(epochMs: number, timeZone: string): ZonedDay | null {
  try {
    let formatter = dayFormatters.get(timeZone);
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
      });
      // 시간대 문자열은 문맥이 검증한 값이라 종류가 적다. 그래도 한도를 둔다.
      if (dayFormatters.size >= 16) dayFormatters.clear();
      dayFormatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(epochMs);
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    const year = part("year");
    const month = part("month");
    const day = part("day");
    if (![year, month, day].every(Number.isFinite)) return null;
    return { year, dayNumber: Date.UTC(year, month - 1, day) / 86_400_000 };
  } catch {
    return null;
  }
}

/**
 * 「오후 2:05에 수정됨」 한 문장. 날을 가리지 못하면(시간대 값이 깨졌다) 날짜까지 말한다: 모를 때는 더 말하는 쪽이
 * 「오늘」이라고 잘못 말하는 쪽보다 낫다.
 */
export function editedAtLabel(locale: EditedLabelLocale, editedAtMs: number, nowMs: number): string {
  const time = locale.formatTime(editedAtMs);
  const edited = zonedDay(editedAtMs, locale.context.timeZone);
  const today = zonedDay(nowMs, locale.context.timeZone);
  if (edited !== null && today !== null) {
    const daysAgo = today.dayNumber - edited.dayNumber;
    if (daysAgo <= 0) return locale.formatMessage("timeline.edited.atTime", { time });
    if (daysAgo === 1) {
      const day = locale.formatRelativeTime(editedAtMs, nowMs, "day");
      return locale.formatMessage("timeline.edited.atDay", { day, time });
    }
  }
  const sameYear = edited !== null && today !== null && edited.year === today.year;
  const date = locale.formatDate(
    editedAtMs,
    sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" }
  );
  return locale.formatMessage("timeline.edited.atDate", { date, time });
}

export interface EditedMark {
  /** 꼬리에 서는 낱말: 「수정됨」. */
  mark: string;
  /**
   * 고친 시각을 아는 글이면 「오후 2:05에 수정됨」, 모르면 낱말 그대로다(옛 캐시·시각 없는 줄). 호버·초점 툴팁, 폰 시트 머리,
   * 낭독 라벨이 모두 이 한 문장을 쓴다.
   */
  full: string;
  /** 시각을 알고 있는가. 거짓이면 `full` 은 `mark` 와 같고 화면은 시각 장치(툴팁·누르기)를 내지 않는다. */
  hasTime: boolean;
}

/**
 * 이 메시지가 「수정됨」을 달아야 하는가, 달면 무엇을 말하는가. 고친 적 없는 글·지워진 글은 `null`.
 *
 * 판정은 `state === "edited"` 하나다: 서버는 고칠 때 `state` 를 `edited` 로 바꾸고(`edit_message_in_tx`) 지울 때는
 * `deleted` 로 바꾼다. 스트림 조각·props 만 바꾼 갱신은 `state` 를 건드리지 않아 표지가 서지 않는다. `editedAtMs` 가 있어도
 * `state` 가 `sent` 인 줄(스트림 되돌림)은 고친 글이 아니다.
 */
export function editedMark(
  locale: EditedLabelLocale,
  message: Pick<Message, "state" | "editedAtMs">,
  nowMs: number
): EditedMark | null {
  if (message.state !== "edited") return null;
  const mark = locale.formatMessage("timeline.edited.mark");
  const at = message.editedAtMs;
  if (typeof at !== "number" || !Number.isFinite(at)) return { mark, full: mark, hasTime: false };
  return { mark, full: editedAtLabel(locale, at, nowMs), hasTime: true };
}
