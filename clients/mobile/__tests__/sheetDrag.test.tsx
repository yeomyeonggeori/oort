import {
  SCROLL_TOP_EPSILON,
  SHEET_CLAIM_SLOP,
  SHEET_DISMISS_MIN_DISTANCE,
  SHEET_DISMISS_RATIO,
  SHEET_DISMISS_VELOCITY,
  SHEET_RUBBER_MAX,
  VELOCITY_HORIZON_MS,
  VELOCITY_STOPPED_MS,
  claimsSheetDrag,
  estimatedSheetHeight,
  isScrolledToTop,
  releaseVelocity,
  rubberBand,
  scrimOpacity,
  sheetDismissDistance,
  sheetFollow,
  sheetFrame,
  shouldDismissSheet,
  type DragSample,
} from '../src/design/sheetModel';

// =============================================================================
// 바텀시트 끌어 내려 닫기 (#4612). 1부는 `sheetModel.ts` 의 순수 판정(문턱·고무줄·넘겨받기·속도·스크림)을
// 경계 ±1 로 잰다. 2부(컴포넌트)는 이 파일 아래에서 실제 응답자 핸들러를 불러 재생한다.
// 각 단정은 일부러 되돌려 본 사보타주 표가 있다(scratchpad `4612/sabotage.txt`, PR 본문).
// =============================================================================

describe('거리 문턱 — 시트 높이의 25%, 작은 시트는 64 바닥', () => {
  it.each([
    // [시트 높이, 문턱]
    [808, 202], // 16 Pro 큰 단
    [400, 100],
    [256, 64], // 25% 가 바닥과 같아지는 높이
    [200, 64], // 25% 는 50 이지만 바닥이 이긴다
    [0, 64],
  ])('높이 %i → 문턱 %f', (height, expected) => {
    expect(sheetDismissDistance(height)).toBe(expected);
  });

  it('상수는 이슈 수용기준(25~30%) 안이고 바닥은 눌림 영역(44)보다 크다', () => {
    expect(SHEET_DISMISS_RATIO).toBeGreaterThanOrEqual(0.25);
    expect(SHEET_DISMISS_RATIO).toBeLessThanOrEqual(0.3);
    expect(SHEET_DISMISS_MIN_DISTANCE).toBeGreaterThan(44);
  });

  it('경계 ±1: 문턱 자체와 1pt 모자람은 닫지 않고, 1pt 넘으면 닫는다 (높이 400 → 100)', () => {
    expect(shouldDismissSheet(99, 0, 400)).toBe(false);
    expect(shouldDismissSheet(100, 0, 400)).toBe(false);
    expect(shouldDismissSheet(101, 0, 400)).toBe(true);
  });

  it('작은 시트의 바닥: 높이 200 은 50 이 아니라 64 를 넘어야 닫힌다', () => {
    expect(shouldDismissSheet(60, 0, 200)).toBe(false);
    expect(shouldDismissSheet(64, 0, 200)).toBe(false);
    expect(shouldDismissSheet(65, 0, 200)).toBe(true);
  });

  it('같은 거리라도 시트가 크면 닫히지 않는다(비율이지 고정 pt 가 아니다)', () => {
    expect(shouldDismissSheet(150, 0, 400)).toBe(true);
    expect(shouldDismissSheet(150, 0, 808)).toBe(false);
  });
});

describe('속도 문턱 — px/ms, Buzz(Flutter) 700px/s = 0.7', () => {
  it('상수는 0.7 px/ms 다(단위: px/s 가 아니다)', () => {
    expect(SHEET_DISMISS_VELOCITY).toBe(0.7);
  });

  it('경계: 0.7 자체는 닫지 않고 그보다 빠르면 거리가 0 이어도 닫는다', () => {
    expect(shouldDismissSheet(10, 0.69, 400)).toBe(false);
    expect(shouldDismissSheet(10, 0.7, 400)).toBe(false);
    expect(shouldDismissSheet(10, 0.71, 400)).toBe(true);
  });

  it('둘 다 모자라면 제자리 — 거리 99·속도 0.69', () => {
    expect(shouldDismissSheet(99, 0.69, 400)).toBe(false);
  });

  it('위로 끄는 것(음수 거리·음수 속도)은 닫지 않는다', () => {
    expect(shouldDismissSheet(-500, -5, 400)).toBe(false);
  });
});

describe('고무줄 — 아래는 1:1, 위는 저항과 상한', () => {
  it('아래로는 손가락 이동 = 시트 이동(±1pt 이내가 아니라 정확히 1:1)', () => {
    for (const dy of [0, 1, 37, 120, 400, 900]) {
      expect(sheetFollow(dy)).toBe(dy);
    }
  });

  it('위로는 저항이 걸린다: 같은 거리를 당겨도 시트는 그보다 덜 움직인다', () => {
    for (const up of [1, 10, 50, 200]) {
      const moved = -sheetFollow(-up);
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(up);
    }
  });

  it('상한: 아무리 당겨도 상한을 넘지 않고, 당길수록 늘어나기는 한다(단조)', () => {
    let previous = 0;
    for (let up = 1; up <= 5000; up += 7) {
      const moved = rubberBand(up);
      expect(moved).toBeLessThan(SHEET_RUBBER_MAX);
      expect(moved).toBeGreaterThanOrEqual(previous);
      previous = moved;
    }
    expect(-sheetFollow(-1e9)).toBeLessThan(SHEET_RUBBER_MAX);
    expect(-sheetFollow(-1e9)).toBeGreaterThan(SHEET_RUBBER_MAX - 0.01);
  });

  it('0 과 모르는 값은 움직이지 않는다', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-5)).toBe(0);
    expect(rubberBand(Number.NaN)).toBe(0);
  });
});

describe('스크롤 넘겨받기 — 맨 위인가', () => {
  it('오프셋 0 과 허용 오차 안은 맨 위, 그 밖은 아니다', () => {
    expect(isScrolledToTop(0)).toBe(true);
    expect(isScrolledToTop(SCROLL_TOP_EPSILON)).toBe(true);
    expect(isScrolledToTop(SCROLL_TOP_EPSILON + 0.01)).toBe(false);
    expect(isScrolledToTop(40)).toBe(false);
    expect(isScrolledToTop(-30)).toBe(true);
  });

  it('모르는 값(NaN)은 맨 위가 아니다 — 모르면 본문이 스크롤하게 둔다', () => {
    expect(isScrolledToTop(Number.NaN)).toBe(false);
  });
});

describe('누가 끌기를 가져가는가 — 머리·본문·스크롤', () => {
  const base = {dx: 0, dy: SHEET_CLAIM_SLOP + 1, touches: 1, closing: false} as const;

  it('머리는 스크롤이 어디든 아래로 끌면 가져간다', () => {
    expect(claimsSheetDrag({...base, zone: 'header', scrollOffsets: []})).toBe(true);
    expect(claimsSheetDrag({...base, zone: 'header', scrollOffsets: [300]})).toBe(true);
  });

  it('본문: 스크롤이 맨 위면 가져가고, 중간이면 가져가지 않는다', () => {
    expect(claimsSheetDrag({...base, zone: 'body', scrollOffsets: [0]})).toBe(true);
    expect(claimsSheetDrag({...base, zone: 'body', scrollOffsets: [40]})).toBe(false);
  });

  it('본문: 등록된 스크롤이 하나라도 중간이면 가져가지 않는다(모두 맨 위여야)', () => {
    expect(claimsSheetDrag({...base, zone: 'body', scrollOffsets: [0, 0]})).toBe(true);
    expect(claimsSheetDrag({...base, zone: 'body', scrollOffsets: [0, 40]})).toBe(false);
  });

  it('본문: 등록된 스크롤이 없으면 가져가지 않는다 — 알려진 것만 가져간다(fail-closed)', () => {
    expect(claimsSheetDrag({...base, zone: 'body', scrollOffsets: []})).toBe(false);
  });

  it('문턱 ±1: 6pt 자체는 가져가지 않고 7pt 부터 가져간다', () => {
    const at = (dy: number) => claimsSheetDrag({...base, dy, zone: 'header', scrollOffsets: []});
    expect(at(SHEET_CLAIM_SLOP)).toBe(false);
    expect(at(SHEET_CLAIM_SLOP + 1)).toBe(true);
  });

  it('위로 가거나 가로가 앞서면 가져가지 않는다', () => {
    expect(claimsSheetDrag({...base, dy: -40, zone: 'header', scrollOffsets: []})).toBe(false);
    expect(claimsSheetDrag({...base, dx: 40, dy: 30, zone: 'header', scrollOffsets: []})).toBe(false);
    expect(claimsSheetDrag({...base, dx: 30, dy: 30, zone: 'header', scrollOffsets: []})).toBe(false);
    expect(claimsSheetDrag({...base, dx: 29, dy: 30, zone: 'header', scrollOffsets: []})).toBe(true);
  });

  it('손가락이 둘이거나 닫는 중이면 가져가지 않는다', () => {
    expect(claimsSheetDrag({...base, touches: 2, zone: 'header', scrollOffsets: []})).toBe(false);
    expect(claimsSheetDrag({...base, closing: true, zone: 'header', scrollOffsets: []})).toBe(false);
  });
});

describe('놓는 순간의 속도 — 100ms 창, 40ms 멈춤, 최소제곱 기울기', () => {
  /** `perMs` px/ms 로 `count` 개를 `step`ms 간격으로. */
  const line = (perMs: number, count: number, step = 16, from = 1000): DragSample[] =>
    Array.from({length: count}, (_, i) => ({y: perMs * step * i, t: from + step * i}));

  it('등속이면 그 속도를 돌려준다', () => {
    const samples = line(1.0, 6);
    expect(releaseVelocity(samples, samples[5].t + 8)).toBeCloseTo(1.0, 6);
    expect(releaseVelocity(line(-0.4, 6), 1000 + 16 * 5 + 8)).toBeCloseTo(-0.4, 6);
  });

  it('창 상수는 Flutter VelocityTracker 의 100ms · 40ms 다', () => {
    expect(VELOCITY_HORIZON_MS).toBe(100);
    expect(VELOCITY_STOPPED_MS).toBe(40);
  });

  it('멈췄다 놓으면 0 이다: 마지막 표본에서 40ms 까지는 쓰고 41ms 부터는 0', () => {
    const samples = line(1.0, 6);
    const last = samples[5].t;
    expect(releaseVelocity(samples, last + VELOCITY_STOPPED_MS)).toBeCloseTo(1.0, 6);
    expect(releaseVelocity(samples, last + VELOCITY_STOPPED_MS + 1)).toBe(0);
  });

  it('표본이 3개 미만이면 0 이다(믿을 수 없다)', () => {
    expect(releaseVelocity([], 1000)).toBe(0);
    expect(releaseVelocity(line(2, 1), 1008)).toBe(0);
    expect(releaseVelocity(line(2, 2), 1024)).toBe(0);
    expect(releaseVelocity(line(2, 3), 1048)).toBeCloseTo(2, 6);
  });

  it('100ms 보다 오래된 표본은 쓰지 않는다: 느리게 끌다 막판에 튕겼으면 막판 쪽의 속도다', () => {
    // 1000~1096ms: 멈춰 있다시피(y=0) 하다가 1112~1144ms 에 1.5px/ms 로 튕겼다. 창(100ms)은 1044 부터라 느린 표본이 넷뿐이다.
    const samples: DragSample[] = [
      ...[1000, 1016, 1032, 1048, 1064, 1080, 1096].map(t => ({y: 0, t})),
      {y: 24, t: 1112},
      {y: 48, t: 1128},
      {y: 72, t: 1144},
    ];
    const v = releaseVelocity(samples, 1152);
    expect(v).toBeGreaterThan(SHEET_DISMISS_VELOCITY); // 창이 없으면 열 표본 전부로 재서 ≈0.42 라 닫히지 않는다
    expect(v).toBeCloseTo(0.75, 2);
  });

  it('표본 사이가 40ms 넘게 끊기면 그 앞은 쓰지 않는다', () => {
    // 앞의 빠른 세 표본(2px/ms)과 뒤의 느린 세 표본(0.03125px/ms) 사이가 45ms 비었다. 셋 다 100ms 창 안이다.
    const samples: DragSample[] = [
      {y: 0, t: 1000},
      {y: 20, t: 1010},
      {y: 40, t: 1020},
      {y: 41, t: 1065},
      {y: 41.5, t: 1081},
      {y: 42, t: 1097},
    ];
    expect(releaseVelocity(samples, 1105)).toBeCloseTo(0.03125, 6); // 끊김을 무시하면 ≈0.33
  });

  it('PanResponder 의 마지막 한 구간 속도라면 닫혔을 몰림(1ms 에 1pt)을 창이 눌러 준다', () => {
    // 16ms 마다 1pt(0.0625 px/ms)로 느리게 끌다 마지막에 이벤트가 1ms 간격으로 몰려 왔다.
    const samples: DragSample[] = [
      {y: 0, t: 1000},
      {y: 1, t: 1016},
      {y: 2, t: 1032},
      {y: 3, t: 1048},
      {y: 4, t: 1064},
      {y: 5, t: 1065},
    ];
    const lastSegment = (samples[5].y - samples[4].y) / (samples[5].t - samples[4].t); // PanResponder vy
    expect(lastSegment).toBeGreaterThan(SHEET_DISMISS_VELOCITY); // 이것이면 잘못 닫혔을 것이다
    expect(releaseVelocity(samples, 1066)).toBeLessThan(SHEET_DISMISS_VELOCITY);
  });
});

describe('스크림 — 끈 거리에 비례해 옅어진다', () => {
  it('0 에서 1, 시트 높이만큼 내려가면 0, 사이는 선형', () => {
    expect(scrimOpacity(0, 400)).toBe(1);
    expect(scrimOpacity(100, 400)).toBeCloseTo(0.75, 10);
    expect(scrimOpacity(200, 400)).toBeCloseTo(0.5, 10);
    expect(scrimOpacity(400, 400)).toBe(0);
    expect(scrimOpacity(900, 400)).toBe(0);
  });

  it('고무줄로 위로 늘어난 때는 더 짙어지지 않고, 높이를 모르면 그대로다', () => {
    expect(scrimOpacity(-20, 400)).toBe(1);
    expect(scrimOpacity(50, 0)).toBe(1);
  });

  it('시트 높이로 나눈다 — 같은 거리라도 짧은 시트가 더 빨리 옅어진다', () => {
    expect(scrimOpacity(100, 300)).toBeLessThan(scrimOpacity(100, 800));
  });
});

describe('시트 높이 어림 — 레이아웃을 재기 전', () => {
  it('큰 단은 위 끝에서 바닥까지, 중간·내용 맞춤은 고정 높이·상한', () => {
    expect(estimatedSheetHeight(sheetFrame('large', 800, 0), 800)).toBe(800 - 58);
    expect(estimatedSheetHeight(sheetFrame('medium', 800, 0), 800)).toBe(Math.floor(800 * (9 / 16)));
    expect(estimatedSheetHeight(sheetFrame('fit', 800, 0), 800)).toBe(Math.floor(800 * 0.85));
  });
});
