import {
  addMonths,
  dayAccessibilityLabel,
  dayKey,
  HOURS12,
  isBeforeToday,
  MINUTES,
  monthTitle,
  monthWeeks,
  nextWholeHour,
  timeKey,
} from '../src/features/profile/pauseCalendar';

// 「직접 고르기」(#2899)의 달력·시계 계산. 시각은 전부 로컬 생성자로 만들어 시간대와 무관하다.
// 2026-10-01 은 목요일, 2026-11-01 은 일요일, 2026-02-01 은 일요일이다.

const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

describe('monthWeeks', () => {
  it('시월은 목요일에 시작해 다섯 주이고, 모든 주가 7칸이다', () => {
    const weeks = monthWeeks(2026, 9);
    expect(weeks).toHaveLength(5);
    for (const week of weeks) expect(week).toHaveLength(7);
    expect(weeks[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(weeks[4]).toEqual([25, 26, 27, 28, 29, 30, 31]);
  });

  it('일요일에 시작하는 30일 달은 마지막 주를 빈 칸으로 채운다', () => {
    const weeks = monthWeeks(2026, 10);
    expect(weeks[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weeks[weeks.length - 1]).toEqual([29, 30, null, null, null, null, null]);
  });

  it('일요일에 시작하는 28일 달은 정확히 네 주다', () => {
    const weeks = monthWeeks(2026, 1);
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().filter(cell => cell !== null)).toHaveLength(28);
  });

  it('윤년의 2월은 29일이다', () => {
    const days = monthWeeks(2028, 1)
      .flat()
      .filter((cell): cell is number => cell !== null);
    expect(Math.max(...days)).toBe(29);
  });
});

describe('addMonths', () => {
  it('해를 넘나든다', () => {
    expect(addMonths({year: 2026, monthIndex: 11}, 1)).toEqual({year: 2027, monthIndex: 0});
    expect(addMonths({year: 2027, monthIndex: 0}, -1)).toEqual({year: 2026, monthIndex: 11});
    expect(addMonths({year: 2026, monthIndex: 9}, 14)).toEqual({year: 2027, monthIndex: 11});
  });

  it('제목은 「2026년 10월」이다', () => {
    expect(monthTitle({year: 2026, monthIndex: 9})).toBe('2026년 10월');
  });
});

describe('dayKey · timeKey — 웹의 날짜·시간 칸과 같은 모양', () => {
  it('날짜는 0을 채운 YYYY-MM-DD 다', () => {
    expect(dayKey({year: 2026, monthIndex: 9, day: 5})).toBe('2026-10-05');
    expect(dayKey({year: 2027, monthIndex: 0, day: 31})).toBe('2027-01-31');
  });

  it('12시는 오전이면 0시, 오후면 낮 12시다', () => {
    expect(timeKey({meridiem: 'am', hour12: 12, minute: 0})).toBe('00:00');
    expect(timeKey({meridiem: 'pm', hour12: 12, minute: 0})).toBe('12:00');
    expect(timeKey({meridiem: 'am', hour12: 9, minute: 5})).toBe('09:05');
    expect(timeKey({meridiem: 'pm', hour12: 11, minute: 55})).toBe('23:55');
    expect(timeKey({meridiem: 'pm', hour12: 1, minute: 30})).toBe('13:30');
  });

  it('시는 1~12 열두 칸, 분은 5분 단위 열두 칸이다', () => {
    expect(HOURS12).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(MINUTES).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });
});

describe('isBeforeToday', () => {
  const day = (monthIndex: number, d: number) => ({year: 2026, monthIndex, day: d});

  it('어제까지는 지난 날이고 오늘은 하루 종일 아니다', () => {
    expect(isBeforeToday(day(9, 15), at(10, 16, 0, 0))).toBe(true);
    expect(isBeforeToday(day(9, 16), at(10, 16, 0, 0))).toBe(false);
    expect(isBeforeToday(day(9, 16), at(10, 16, 23, 59))).toBe(false);
    expect(isBeforeToday(day(9, 17), at(10, 16, 23, 59))).toBe(false);
  });

  it('달과 해가 달라도 센다', () => {
    expect(isBeforeToday(day(8, 30), at(10, 1))).toBe(true);
    expect(isBeforeToday({year: 2025, monthIndex: 11, day: 31}, at(1, 1))).toBe(true);
  });
});

describe('nextWholeHour', () => {
  it('지금 다음의 정각이다', () => {
    expect(nextWholeHour(at(10, 16, 21, 7))).toEqual({
      day: {year: 2026, monthIndex: 9, day: 16},
      time: {meridiem: 'pm', hour12: 10, minute: 0},
    });
  });

  it('정각에 열어도 한 시간 뒤다 (지금과 같은 시각은 미래가 아니다)', () => {
    expect(nextWholeHour(at(10, 16, 21, 0)).time).toEqual({
      meridiem: 'pm',
      hour12: 10,
      minute: 0,
    });
  });

  it('자정을 넘으면 다음 날 오전 12시다, 월말이어도', () => {
    expect(nextWholeHour(at(10, 31, 23, 30))).toEqual({
      day: {year: 2026, monthIndex: 10, day: 1},
      time: {meridiem: 'am', hour12: 12, minute: 0},
    });
  });

  it('낮 12시를 오후 12시로 읽는다', () => {
    expect(nextWholeHour(at(10, 16, 11, 59)).time).toEqual({
      meridiem: 'pm',
      hour12: 12,
      minute: 0,
    });
  });
});

describe('dayAccessibilityLabel', () => {
  it('요일까지 읽어 준다', () => {
    expect(dayAccessibilityLabel({year: 2026, monthIndex: 9, day: 17})).toBe('10월 17일 토요일');
    expect(dayAccessibilityLabel({year: 2026, monthIndex: 9, day: 19})).toBe('10월 19일 월요일');
  });
});
