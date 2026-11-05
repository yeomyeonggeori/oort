import { describe, expect, it } from "vitest";
import { createLocaleService, type LocaleService } from "../../i18n/context";
import { catalog as en } from "../../i18n/generated/en-US";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { resolveLocaleContext } from "../../i18n/locale";
import { editedAtLabel, editedMark, type EditedLabelLocale } from "./editedLabel";

// 24시간제로 고정한다: 오전·오후 글자는 ICU(CLDR) 판마다 다르다(Node 24는 한국어를 「AM」으로 낸다). 이 시험이 재는 것은 날을 가르는
// 계산과 문장의 틀이고, 시계 글자는 서비스(`formatTime`)가 문맥의 시계 방식으로 짓는 것을 그대로 믿는다. 영어 12시간제는 글자가
// 안정돼 따로 한 칸 잰다(좁은 줄바꿈 없는 공백만 일반 공백으로 맞춘다).
function locale(
  language: "ko-KR" | "en-US",
  timeZone: string,
  hourCycle: "h23" | "h12" = "h23"
): LocaleService {
  return createLocaleService({
    ...resolveLocaleContext(language, { languages: [language], timeZone, hourCycle }),
    catalog: language === "ko-KR" ? ko : en,
  });
}
const plain = (text: string) => text.replace(/\u202f/g, " ");

const SEOUL = locale("ko-KR", "Asia/Seoul");
// 한국 시간 2026-11-05 14:30.
const NOW = Date.UTC(2026, 10, 5, 5, 30);
const kst = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m - 1, d, hh - 9, mm);

describe("editedAtLabel: 오늘 · 어제 · 다른 날 · 다른 해", () => {
  it("오늘 고친 글은 시각만 말한다", () => {
    expect(editedAtLabel(SEOUL, kst(2026, 11, 5, 14, 5), NOW)).toBe("14:05에 수정됨");
    // 오늘 새벽도 시각만이다: 날을 가르는 것은 24시간 차가 아니라 달력이다.
    expect(editedAtLabel(SEOUL, kst(2026, 11, 5, 0, 1), NOW)).toBe("00:01에 수정됨");
  });

  it("어제는 「어제」가 앞에 붙는다", () => {
    expect(editedAtLabel(SEOUL, kst(2026, 11, 4, 23, 50), NOW)).toBe("어제 23:50에 수정됨");
    expect(editedAtLabel(SEOUL, kst(2026, 11, 4, 0, 5), NOW)).toBe("어제 00:05에 수정됨");
  });

  it("그보다 전은 날짜까지, 해가 같으면 연도는 뺀다", () => {
    expect(editedAtLabel(SEOUL, kst(2026, 11, 3, 14, 5), NOW)).toBe("11월 3일 14:05에 수정됨");
    expect(editedAtLabel(SEOUL, kst(2026, 1, 2, 9, 0), NOW)).toBe("1월 2일 09:00에 수정됨");
  });

  it("다른 해는 연도도 말한다", () => {
    expect(editedAtLabel(SEOUL, kst(2025, 12, 31, 21, 10), NOW)).toBe("2025년 12월 31일 21:10에 수정됨");
  });

  it("자정을 건너면 4분 전에 고친 글도 어제다(24시간 차로 세지 않는다)", () => {
    const edited = kst(2026, 11, 4, 23, 58);
    expect(editedAtLabel(SEOUL, edited, kst(2026, 11, 4, 23, 59))).toBe("23:58에 수정됨");
    expect(editedAtLabel(SEOUL, edited, kst(2026, 11, 5, 0, 2))).toBe("어제 23:58에 수정됨");
  });

  it("보는 사람의 시간대로 센다: 같은 두 순간이 서울에서는 어제, 로스앤젤레스에서는 오늘이다", () => {
    const edited = kst(2026, 11, 4, 23, 50);
    const now = kst(2026, 11, 5, 0, 30);
    expect(editedAtLabel(SEOUL, edited, now)).toBe("어제 23:50에 수정됨");
    expect(editedAtLabel(locale("ko-KR", "America/Los_Angeles"), edited, now)).toBe("06:50에 수정됨");
  });

  it("서머타임이 낀 달력도 날로 센다(미국 가을 되돌림 날의 25시간)", () => {
    const newYork = locale("en-US", "America/New_York", "h23");
    // 2026-11-01 은 25시간인 날이다. 11월 2일 00:30 에서 본 11월 1일 오후는 어제, 10월 31일 오후는 그제 이전이다.
    const now = Date.UTC(2026, 10, 2, 5, 30);
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 10, 1, 21, 0), now))).toBe("Edited yesterday at 16:00");
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 9, 31, 21, 0), now))).toBe("Edited on October 31 at 17:00");
  });

  it("서버 시계가 내 시계보다 앞서도(미래) 오늘로 말한다", () => {
    expect(editedAtLabel(SEOUL, NOW + 10 * 60_000, NOW)).toBe("14:40에 수정됨");
  });

  it("영어: 같은 틀이 영어 사전에서 나온다(12시간제)", () => {
    const newYork = locale("en-US", "America/New_York", "h12");
    const now = Date.UTC(2026, 10, 5, 19, 30); // 2:30 PM EST
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 10, 5, 19, 5), now))).toBe("Edited at 2:05 PM");
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 10, 4, 19, 5), now))).toBe("Edited yesterday at 2:05 PM");
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 10, 3, 19, 5), now))).toBe("Edited on November 3 at 2:05 PM");
    expect(plain(editedAtLabel(newYork, Date.UTC(2026, 0, 1, 2, 10), now))).toBe("Edited on December 31, 2025 at 9:10 PM");
  });

  it("시간대 값이 깨져 날을 못 가르면 오늘이라 하지 않고 날짜까지 말한다", () => {
    const broken: EditedLabelLocale = { ...SEOUL, context: { ...SEOUL.context, timeZone: "Not/AZone" } };
    expect(editedAtLabel(broken, kst(2026, 11, 5, 14, 5), NOW)).toBe("2026년 11월 5일 14:05에 수정됨");
  });

  it("스페인어·일본어 같은 사전 없는 언어도 영어 틀에 그 지역의 시각이 들어간다", () => {
    const ja = createLocaleService({
      ...resolveLocaleContext("ja-JP", { languages: ["ja-JP"], timeZone: "Asia/Tokyo", hourCycle: "h23" }),
    });
    expect(plain(editedAtLabel(ja, Date.UTC(2026, 10, 5, 5, 5), Date.UTC(2026, 10, 5, 5, 30)))).toBe("Edited at 14:05");
  });
});

describe("editedMark: 표지가 서는 줄과 그 문장", () => {
  it("고친 글은 낱말과 시각 문장을 함께 낸다", () => {
    const mark = editedMark(SEOUL, { state: "edited", editedAtMs: kst(2026, 11, 5, 14, 5) }, NOW);
    expect(mark).toEqual({ mark: "수정됨", full: "14:05에 수정됨", hasTime: true });
  });

  it("고친 시각을 모르는 줄은 낱말만 말한다(시각 장치가 없다)", () => {
    expect(editedMark(SEOUL, { state: "edited" }, NOW)).toEqual({ mark: "수정됨", full: "수정됨", hasTime: false });
    expect(editedMark(SEOUL, { state: "edited", editedAtMs: Number.NaN }, NOW)?.hasTime).toBe(false);
  });

  it("고치지 않은 글·지워진 글·보내지 못한 글에는 표지가 없다", () => {
    for (const state of ["sent", "deleted", "failed"] as const) {
      expect(editedMark(SEOUL, { state, editedAtMs: NOW - 1000 }, NOW), state).toBeNull();
    }
    expect(editedMark(SEOUL, {}, NOW)).toBeNull();
  });

  it("영어 사전에서는 낱말이 Edited다", () => {
    const newYork = locale("en-US", "America/New_York", "h12");
    expect(editedMark(newYork, { state: "edited" }, NOW)?.mark).toBe("Edited");
  });
});
