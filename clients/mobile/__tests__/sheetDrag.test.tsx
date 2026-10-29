import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Animated,
  Dimensions,
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {EASE_OUT, FLING_OUT} from '../src/design/motion';
import {PageSheet, usePageSheetAction, usePageSheetScroll, usePageSheetScrollProps} from '../src/design/PageSheet';
import {SheetHeader} from '../src/design/SheetChrome';
import {SheetScroll} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';
import {retainReduceMotion} from '../src/lib/useReduceMotion';
import {
  SCROLL_FIT_SLACK,
  SCROLL_TOP_EPSILON,
  SHEET_CLAIM_SLOP,
  SHEET_DISMISS_MIN_DISTANCE,
  SHEET_DISMISS_RATIO,
  SHEET_DISMISS_VELOCITY,
  SHEET_RELEASE_MIN_MS,
  SHEET_RUBBER_MAX,
  SHEET_SLIDE_MS,
  VELOCITY_HORIZON_MS,
  VELOCITY_STOPPED_MS,
  claimsSheetDrag,
  claimsSheetTouchStart,
  estimatedSheetHeight,
  isScrolledToTop,
  releaseSlideMs,
  releaseVelocity,
  rubberBand,
  scrimOpacity,
  scrollOverflows,
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

describe('위로 튕기며 놓기 — 속도 방향이 이긴다 (planner 결정, #4612 코멘트)', () => {
  // 높이 400 의 문턱은 100. 아래의 거리 150 은 속도가 없으면 닫는 자리다(위 「경계 ±1」 가 그 사실을 잰다).
  it('거리 문턱을 넘게 내려 놓았어도 위로 문턱보다 빠르게 튕겼으면 닫지 않는다', () => {
    expect(shouldDismissSheet(150, 0, 400)).toBe(true); // 대조: 튕김이 없으면 거리로 닫는다
    expect(shouldDismissSheet(150, -0.71, 400)).toBe(false);
    expect(shouldDismissSheet(150, -3, 400)).toBe(false);
    expect(shouldDismissSheet(900, -1.5, 400)).toBe(false); // 아무리 멀리 내려 놓았어도
  });

  it('경계는 닫는 쪽과 대칭이다 — 정확히 −0.7 은 튕김이 아니라 거리가 정한다', () => {
    expect(shouldDismissSheet(150, -0.7, 400)).toBe(true);
    expect(shouldDismissSheet(150, -0.69, 400)).toBe(true);
    expect(shouldDismissSheet(150, -0.71, 400)).toBe(false);
  });

  it('문턱 안쪽의 작은 위쪽 속도(손가락 떨림)는 거리 판정을 뒤집지 못한다', () => {
    expect(shouldDismissSheet(150, -0.1, 400)).toBe(true);
    expect(shouldDismissSheet(150, -0.5, 400)).toBe(true);
  });

  it('아래로 튕김은 그대로 닫는다 — 방향이 이기는 것은 위쪽만이다', () => {
    expect(shouldDismissSheet(10, 2, 400)).toBe(true);
    expect(shouldDismissSheet(10, 0.71, 400)).toBe(true);
  });
});

describe('놓고 닫는 슬라이드 — 놓은 속도를 잇는다 (속도 기반 길이, 상하한)', () => {
  it('상한은 옛 고정 길이 260, 하한은 모션 사다리 instant 120 이다', () => {
    expect(SHEET_SLIDE_MS).toBe(260);
    expect(SHEET_RELEASE_MIN_MS).toBe(120);
  });

  it.each([
    // [남은 거리, 놓은 속도(px/ms), 길이(ms)]
    [600, 3, 200], // 600 ÷ 3
    [600, 2.5, 240],
    [600, 5, 120], // 정확히 하한
    [600, 10, 120], // 60 → 하한으로 올린다
    [700, 3.5, 200],
    [600, 2, 260], // 300 → 상한으로 내린다
    [600, 0.8, 260], // 750 → 상한
    [780, 3, 260], // 정확히 상한
    [770, 3, 257], // 256.67 → 반올림
    [100, 0.7, 143], // 거의 다 내려온 시트는 문턱 속도로도 짧다
  ])('남은 %i pt · 속도 %f px/ms → %i ms', (remaining, velocity, expected) => {
    expect(releaseSlideMs(remaining, velocity)).toBe(expected);
  });

  it('이을 속도가 없으면 기본 길이다 — 거리로만 닫은 끌기·멈췄다 놓음·위쪽·모르는 값', () => {
    expect(releaseSlideMs(600, 0)).toBe(SHEET_SLIDE_MS);
    expect(releaseSlideMs(600, -2)).toBe(SHEET_SLIDE_MS);
    expect(releaseSlideMs(600, Number.NaN)).toBe(SHEET_SLIDE_MS);
  });

  it('남은 거리가 없거나 모르면 하한이다', () => {
    expect(releaseSlideMs(0, 2)).toBe(SHEET_RELEASE_MIN_MS);
    expect(releaseSlideMs(-5, 2)).toBe(SHEET_RELEASE_MIN_MS);
    expect(releaseSlideMs(Number.NaN, 2)).toBe(SHEET_RELEASE_MIN_MS);
  });

  it('빠를수록 길어지지 않는다(단조) — 그리고 늘 상하한 안이다', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let velocity = 0.1; velocity <= 12; velocity += 0.1) {
      const ms = releaseSlideMs(650, velocity);
      expect(ms).toBeLessThanOrEqual(previous);
      expect(ms).toBeGreaterThanOrEqual(SHEET_RELEASE_MIN_MS);
      expect(ms).toBeLessThanOrEqual(SHEET_SLIDE_MS);
      previous = ms;
    }
  });
});

describe('던진 시트의 곡선 — 시작 기울기 1 이라 놓은 속도에서 끊김 없이 이어진다', () => {
  // 곡선의 y 가 진행률(0→1)이고 x 가 시간 비율이다. 시간을 `거리 ÷ 속도`로 잡으면 첫 순간의 속도 = 거리 × 시작 기울기 ÷ 시간 = 속도.
  const startSlope = (curve: (t: number) => number) => curve(0.005) / 0.005;

  it('FLING_OUT 의 시작 기울기는 1 이다(±5%)', () => {
    expect(startSlope(FLING_OUT)).toBeGreaterThan(0.95);
    expect(startSlope(FLING_OUT)).toBeLessThan(1.05);
  });

  it('대조: 옛 강한 ease-out 은 4 배 빠르게 출발한다 — 그래서 속도를 잇는 슬라이드에 쓰지 않는다', () => {
    expect(startSlope(EASE_OUT)).toBeGreaterThan(4);
  });

  it('0 에서 시작해 1 에서 끝나고 거꾸로 가지 않으며 가운데서 기울기가 1.3 을 넘지 않는다', () => {
    expect(FLING_OUT(0)).toBe(0);
    expect(FLING_OUT(1)).toBe(1);
    let previous = 0;
    let steepest = 0;
    for (let t = 0.01; t <= 1.0001; t += 0.01) {
      const y = FLING_OUT(Math.min(1, t));
      expect(y).toBeGreaterThanOrEqual(previous);
      steepest = Math.max(steepest, (y - previous) / 0.01);
      previous = y;
    }
    expect(steepest).toBeLessThan(1.3);
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

describe('시작 응답자 — 터치가 시작되는 순간 시트가 응답자를 잡는가 (RN Modal 이 시작 응답자를 쥐므로)', () => {
  const START = {closing: false, scrollsOverflow: false};

  it('머리(손잡이 띠·제목 줄)는 스크롤이 어떻든·스크롤이 없어도 늘 잡는다', () => {
    expect(claimsSheetTouchStart({zone: 'header', ...START, scrollOffsets: []})).toBe(true);
    expect(claimsSheetTouchStart({zone: 'header', ...START, scrollOffsets: [0]})).toBe(true);
    expect(claimsSheetTouchStart({zone: 'header', ...START, scrollOffsets: [400]})).toBe(true);
  });

  it('본문은 스크롤이 맨 위일 때만 잡는다 — 중간이면 잡지 않아 스크롤과 간섭하지 않는다', () => {
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: [0]})).toBe(true);
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: [SCROLL_TOP_EPSILON]})).toBe(true);
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: [SCROLL_TOP_EPSILON + 1]})).toBe(false);
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: [0, 120]})).toBe(false); // 하나라도 중간이면
  });

  it('본문은 등록된 스크롤이 없으면 잡지 않는다 — 알려진 것만 잡는다(fail-closed)', () => {
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: []})).toBe(false);
  });

  it('닫는 중에는 머리도 본문도 잡지 않는다(슬라이드를 끊으면 행동이 앞당겨 불린다)', () => {
    expect(claimsSheetTouchStart({zone: 'header', closing: true, scrollsOverflow: false, scrollOffsets: [0]})).toBe(false);
    expect(claimsSheetTouchStart({zone: 'body', closing: true, scrollsOverflow: false, scrollOffsets: [0]})).toBe(false);
  });

  // 시뮬레이터가 잡은 결함: 본문 뿌리는 스크롤 뷰의 조상이라, 거기서 응답자를 잡으면 iOS 가 그 터치의 네이티브 스크롤을 시작도 못 하게 막는다
  // (맨 위에서 눌리지 않는 자리를 짚고 위로 올리는 스크롤이 죽는다). 내용이 넘치는 스크롤은 막히면 잃는 것이 있다.
  it('내용이 넘치는 스크롤이 있으면 본문은 맨 위에서도 잡지 않는다 — 잡으면 iOS 가 그 스크롤을 막는다', () => {
    expect(claimsSheetTouchStart({zone: 'body', closing: false, scrollsOverflow: true, scrollOffsets: [0]})).toBe(false);
    expect(claimsSheetTouchStart({zone: 'body', closing: false, scrollsOverflow: true, scrollOffsets: [0, 0]})).toBe(false);
  });

  it('머리는 스크롤이 넘쳐도 잡는다 — 머리는 스크롤 뷰의 조상이 아니라 막을 스크롤이 없다', () => {
    expect(claimsSheetTouchStart({zone: 'header', closing: false, scrollsOverflow: true, scrollOffsets: [0]})).toBe(true);
    expect(claimsSheetTouchStart({zone: 'header', closing: false, scrollsOverflow: true, scrollOffsets: []})).toBe(true);
  });

  it('모르는 값(NaN)은 맨 위가 아니다 — 모르면 잡지 않는다', () => {
    expect(claimsSheetTouchStart({zone: 'body', ...START, scrollOffsets: [Number.NaN]})).toBe(false);
  });
});

describe('넘침 — 스크롤이 실제로 스크롤될 수 있는가', () => {
  it('내용이 뷰포트에 들어가면 넘치지 않는다 — 같거나 1pt 이내로만 크면 아직 들어간 것이다', () => {
    expect(scrollOverflows(300, 500)).toBe(false);
    expect(scrollOverflows(500, 500)).toBe(false);
    expect(scrollOverflows(500 + SCROLL_FIT_SLACK, 500)).toBe(false);
  });

  it('1pt 를 넘게 크면 넘친다', () => {
    expect(scrollOverflows(500 + SCROLL_FIT_SLACK + 0.5, 500)).toBe(true);
    expect(scrollOverflows(2000, 500)).toBe(true);
  });

  it('크기를 모르면 넘친다고 본다 — 모르면 스크롤을 막지 않는 쪽이 안전하다(fail-closed)', () => {
    expect(scrollOverflows(Number.NaN, 500)).toBe(true);
    expect(scrollOverflows(300, Number.NaN)).toBe(true);
    expect(scrollOverflows(300, 0)).toBe(true); // 뷰포트 0 = 아직 레이아웃 전
    expect(scrollOverflows(0, 0)).toBe(true); // 내용도 0 이어도 레이아웃 전이면 모르는 것이다(「0 ≤ 0 + 1 이라 들어간다」가 아니다)
    expect(scrollOverflows(1, 0)).toBe(true);
    expect(scrollOverflows(-1, 500)).toBe(true);
    expect(scrollOverflows(0, 500)).toBe(false); // 빈 내용은 확실히 들어간다
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

// =============================================================================
// 2부 — 실제 렌더에서 응답자 핸들러를 불러 끌기를 재생한다. 핸들러는 PanResponder 가 만든 것이고, 이벤트는
// `touchHistory` 까지 갖춘 모양이다(`sheetKit.test.tsx` 의 `dragHandle` 과 같은 방식).
// =============================================================================

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
const WINDOW = Dimensions.get('window');
/** 큰 단의 높이(상태 막대 0 → 위 58) — Jest 는 레이아웃을 재지 않으니 상자에서 어림한 값이다. */
const LARGE_HEIGHT = WINDOW.height - 58;

let releaseReduceMotion: (() => void) | null = null;

afterEach(() => {
  cleanup();
  emitter().emit('keyboardDidHide', keyboardFrame(0));
  releaseReduceMotion?.();
  releaseReduceMotion = null;
  jest.restoreAllMocks();
});

async function mount(ui: React.ReactElement, reduceMotion = true) {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(reduceMotion));
  releaseReduceMotion ??= retainReduceMotion();
  await act(async () => {});
  const utils = render(<FixedScheme scheme="light">{ui}</FixedScheme>);
  await act(async () => {});
  return utils;
}

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.style);

/** 시트가 가 있는 곳(pt, 아래가 양수). */
const sheetY = (): number => flat('page-sheet').transform[0].translateY;
const scrimAlpha = (): number => flat('page-sheet-scrim-fade').opacity;

type Emitter = {emit: (event: string, payload: unknown) => void};
const emitter = () => (Keyboard as unknown as {_emitter: Emitter})._emitter;
const keyboardFrame = (height: number) => ({
  endCoordinates: {height, screenX: 0, screenY: WINDOW.height - height, width: 390},
  duration: 250,
  easing: 'keyboard',
});

type Handlers = Record<string, (event: unknown) => unknown>;

function touch(y: number, at: number, previousY: number = y, touches = 1) {
  return {
    nativeEvent: {touches: Array.from({length: touches}, () => ({})), changedTouches: [{}], timestamp: at},
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          startPageX: 0,
          startPageY: 0,
          startTimeStamp: 0,
          currentPageX: 0,
          currentPageY: y,
          currentTimeStamp: at,
          previousPageX: 0,
          previousPageY: previousY,
          previousTimeStamp: at - 16,
        },
      ],
      numberActiveTouches: touches,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: at,
    },
  };
}

/**
 * `testID` 의 응답자를 잡고 `steps`(y, 시각)를 따라 끈다. 첫 걸음이 가져가는 문턱을 넘는다 — 가져가지 못하면(응답자 시스템이
 * 거절) 거기서 멈추고 `false` 를 돌려준다. `release: false` 면 손을 떼지 않는다. `releaseAt` 은 놓는 시각이다.
 */
function drag(
  testID: string,
  steps: Array<[number, number]>,
  options: {release?: boolean; releaseAt?: number; touches?: number; downAt?: number} = {},
): boolean {
  const handlers = screen.getByTestId(testID).props as Handlers;
  let claimed = false;
  act(() => {
    handlers.onStartShouldSetResponderCapture(touch(0, options.downAt ?? 1));
    const [firstY, firstAt] = steps[0];
    const first = touch(firstY, firstAt, 0, options.touches);
    // 응답자 시스템처럼 캡처 길이 먼저, 버블 길이 다음이다.
    claimed = Boolean(handlers.onMoveShouldSetResponderCapture(first)) || Boolean(handlers.onMoveShouldSetResponder(first));
    if (!claimed) return;
    handlers.onResponderGrant(first);
    let previous = firstY;
    for (const [y, at] of steps.slice(1)) {
      handlers.onResponderMove(touch(y, at, previous));
      previous = y;
    }
    if (options.release === false) return;
    const [lastY, lastAt] = steps[steps.length - 1];
    handlers.onResponderRelease(touch(lastY, options.releaseAt ?? lastAt + 1, lastY));
  });
  return claimed;
}

/**
 * **시작 응답자 길**로 `testID` 의 끌기를 재생한다 — 응답자 시스템과 같은 순서다. 터치(y=0)가 시작될 때 캡처 → 버블 순으로 응답자를
 * 묻고(RN `Modal` 이 시작 응답자를 쥐므로 눌리지 않는 자리의 터치는 시트가 여기서 잡아야 닿는다), 잡았으면 바로 grant 한 뒤 걸음을 이동
 * 이벤트로 흘린다. 잡지 못하면 `armed: false` — 응답자는 Modal 호스트이고 시트에는 아무것도 오지 않는다. `drag()` 는 반대 길(후손이 응답자라
 * 시트가 이동에서 가로채는 터치)이다.
 */
function dragFromStart(
  testID: string,
  steps: Array<[number, number]>,
  options: {release?: boolean; releaseAt?: number; touches?: number; downAt?: number} = {},
): {armed: boolean} {
  const handlers = screen.getByTestId(testID).props as Handlers;
  let armed = false;
  act(() => {
    const down = touch(0, options.downAt ?? 1, 0, options.touches);
    handlers.onStartShouldSetResponderCapture(down);
    armed = Boolean(handlers.onStartShouldSetResponder(down));
    if (!armed) return;
    handlers.onResponderGrant(down);
    let previous = 0;
    for (const [y, at] of steps) {
      handlers.onResponderMove(touch(y, at, previous, options.touches));
      previous = y;
    }
    if (options.release === false) return;
    const [lastY, lastAt] = steps[steps.length - 1];
    handlers.onResponderRelease(touch(lastY, options.releaseAt ?? lastAt + 1, lastY));
  });
  return {armed};
}

const scrollTo = (testID: string, y: number) =>
  act(() => {
    fireEvent.scroll(screen.getByTestId(testID), {nativeEvent: {contentOffset: {x: 0, y}}});
  });

/** 스크롤의 크기 사건을 흘린다(jest 는 레이아웃을 하지 않는다): 뷰포트 높이(`onLayout`)와 내용 높이(`onContentSizeChange`). */
const sizeScroll = (testID: string, content: number, viewport: number) =>
  act(() => {
    const node = screen.getByTestId(testID);
    fireEvent(node, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: viewport}}});
    fireEvent(node, 'contentSizeChange', 390, content);
  });

function Host({
  onClose,
  height,
  dirty,
  onDiscardPrompt,
  children,
}: {
  onClose: () => void;
  height?: 'fit' | 'medium' | 'large';
  dirty?: boolean;
  onDiscardPrompt?: (discard: () => void) => void;
  children?: React.ReactNode;
}) {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel="시험 시트"
      height={height}
      dirty={dirty}
      onDiscardPrompt={onDiscardPrompt}
      testID="sheet">
      <SheetHeader title="시험 시트" closeLabel="시험 시트 닫기" closeTestID="close" testID="hdr" />
      {children ?? (
        <SheetScroll testID="sheet-scroll">
          <View style={{height: 2000}} />
        </SheetScroll>
      )}
    </PageSheet>
  );
}

/** 놓았을 때 시트가 닫히는, 느리지만 먼 끌기(문턱 25% 를 넘는다). 표본이 500ms 간격이라 속도는 0 이다. */
const FAR_SLOW: Array<[number, number]> = [[20, 100], [120, 600], [220, 1100], [360, 1600]];
/** 문턱에 못 미치는 느린 끌기(60pt). */
const SHORT_SLOW: Array<[number, number]> = [[20, 100], [50, 400], [80, 800]];
/** 짧지만 빠른 튕김(92pt, 마지막 64ms 동안 ≈1.4px/ms). */
const FLICK: Array<[number, number]> = [[20, 100], [40, 116], [62, 132], [86, 148], [112, 164]];

describe('머리 — 손잡이 띠뿐 아니라 제목 줄 어디서든 끌린다', () => {
  it('제목 줄(머리 뿌리)에도 끌기 응답자가 있고, 손잡이 띠와 같은 시트를 움직인다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(typeof screen.getByTestId('hdr').props.onMoveShouldSetResponderCapture).toBe('function');
    expect(drag('hdr', [[20, 100], [70, 116], [120, 132]], {release: false})).toBe(true);
    expect(sheetY()).toBe(100); // 끌기가 시작된 뒤 손가락이 100 움직였고 시트도 100
  });

  it('손가락 이동 = 시트 이동 (±1pt) — 걸음마다', async () => {
    await mount(<Host onClose={() => {}} />);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1));
      const first = touch(20, 100, 0);
      handlers.onMoveShouldSetResponderCapture(first);
      handlers.onResponderGrant(first);
    });
    let previous = 20;
    let finger = 0;
    for (const [i, y] of [31, 55, 90, 140, 190].entries()) {
      act(() => {
        handlers.onResponderMove(touch(y, 116 + i * 16, previous));
      });
      finger += y - previous;
      previous = y;
      expect(Math.abs(sheetY() - finger)).toBeLessThanOrEqual(1);
    }
  });

  it('스크롤이 중간(40)이어도 머리는 끌린다', async () => {
    await mount(<Host onClose={() => {}} />);
    scrollTo('sheet-scroll', 40);
    expect(drag('hdr', [[20, 100], [60, 116]], {release: false})).toBe(true);
    expect(sheetY()).toBe(40);
  });

  it('먼 끌기는 닫는다 / 모자란 끌기는 닫지 않고 제자리다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    drag('hdr', SHORT_SLOW);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    drag('hdr', FAR_SLOW);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('짧아도 빠르게 튕기면 닫는다 — 속도 문턱', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    drag('hdr', FLICK);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('빠르게 끌다 멈춰 있다 놓으면 닫지 않는다 — PanResponder 의 마지막 구간 속도가 아니라 창으로 잰다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    // FLICK 과 같은 끌기인데 마지막 이동 뒤 200ms 를 쉬었다 놓는다.
    drag('hdr', FLICK, {releaseAt: 164 + 200});
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });

  it('위로는 고무줄이다: 끈 만큼보다 덜 올라가고 상한을 넘지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    drag('hdr', [[300, 100], [330, 116], [250, 132], [100, 148]], {release: false});
    // 끌기가 시작된 뒤 손가락은 위로 200 갔다(330→100 중 시작점 300 기준 −200).
    expect(sheetY()).toBeLessThan(0);
    expect(sheetY()).toBeGreaterThan(-SHEET_RUBBER_MAX);
    expect(sheetY()).toBeCloseTo(sheetFollow(100 - 300), 6);
  });

  it('가로가 앞서면 / 손가락이 둘이면 가져가지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    const sideways = touch(10, 50, 0);
    sideways.touchHistory.touchBank[0].currentPageX = 40;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1));
    });
    expect(handlers.onMoveShouldSetResponderCapture(sideways)).toBe(false);
    expect(drag('hdr', [[20, 100], [60, 116]], {touches: 2, release: false})).toBe(false);
    expect(sheetY()).toBe(0);
  });

  it('시스템이 끌기를 거둬 가면(terminate) 어중간한 자리에 남지 않고 제자리로 돌아온다', async () => {
    await mount(<Host onClose={() => {}} />);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    drag('hdr', [[20, 100], [90, 116], [160, 132]], {release: false});
    expect(sheetY()).toBe(140);
    act(() => {
      handlers.onResponderTerminate(touch(160, 140));
    });
    expect(sheetY()).toBe(0);
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
  });

  it('끌기를 쥔 동안에는 다른 응답자가 가져가지 못하게 한다', async () => {
    await mount(<Host onClose={() => {}} />);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    expect(handlers.onResponderTerminationRequest(touch(0, 1))).toBe(false);
  });
});

describe('본문 — 스크롤이 맨 위일 때만 시트가 따라온다(스크롤 넘겨받기)', () => {
  it('맨 위(오프셋 0)에서 아래로 끌면 시트가 손가락을 따라온다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(drag('page-sheet-body', [[20, 100], [70, 116], [120, 132]], {release: false})).toBe(true);
    expect(sheetY()).toBe(100);
  });

  it('맨 위에서 멀리 끌면 닫히고, 모자라면 제자리다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    drag('page-sheet-body', SHORT_SLOW);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    drag('page-sheet-body', FAR_SLOW);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('스크롤이 중간(40)이면 시트가 가져가지 않는다 — 본문이 스크롤한다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    scrollTo('sheet-scroll', 40);
    expect(drag('page-sheet-body', FAR_SLOW)).toBe(false);
    expect(sheetY()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('다시 맨 위로 돌아오면 가져간다', async () => {
    await mount(<Host onClose={() => {}} />);
    scrollTo('sheet-scroll', 120);
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(false);
    scrollTo('sheet-scroll', 0);
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(true);
  });

  it('스크롤이 끝났을 때(드래그를 놓음·관성이 멈춤)의 오프셋도 시트가 안다', async () => {
    await mount(<Host onClose={() => {}} />);
    const scroll = screen.getByTestId('sheet-scroll');
    act(() => {
      scroll.props.onScrollEndDrag({nativeEvent: {contentOffset: {x: 0, y: 80}}});
    });
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(false);
    act(() => {
      screen.getByTestId('sheet-scroll').props.onMomentumScrollEnd({nativeEvent: {contentOffset: {x: 0, y: 0}}});
    });
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(true);
  });

  it('등록된 스크롤이 하나라도 중간이면 가져가지 않고, 그 스크롤이 사라지면 가져간다', async () => {
    function Two({second}: {second: boolean}) {
      return (
        <Host onClose={() => {}}>
          <SheetScroll testID="a"><View /></SheetScroll>
          {second ? <SheetScroll testID="b"><View /></SheetScroll> : null}
        </Host>
      );
    }
    const utils = await mount(<Two second />);
    scrollTo('b', 50);
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(false);
    utils.rerender(
      <FixedScheme scheme="light">
        <Two second={false} />
      </FixedScheme>,
    );
    await act(async () => {});
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(true);
  });

  it('시트에 알리지 않은 스크롤(날 FlatList)만 있으면 본문은 가져가지 않는다 — 머리는 끌린다', async () => {
    await mount(
      <Host onClose={() => {}}>
        <FlatList data={[1, 2, 3]} renderItem={({item}) => <Text>{item}</Text>} testID="raw-list" />
      </Host>,
    );
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(false);
    expect(drag('hdr', [[20, 100], [70, 116]], {release: false})).toBe(true);
  });

  it('끌기를 쥐는 동안 본문 스크롤을 얼리고, 놓으면 푼다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
    drag('page-sheet-body', [[20, 100], [70, 116]], {release: false});
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(false);
    const handlers = screen.getByTestId('page-sheet-body').props as Handlers;
    act(() => {
      handlers.onResponderRelease(touch(70, 120, 70));
    });
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
  });

  it('호출자가 준 onScroll·scrollEnabled 를 지우지 않는다 — 시트의 배선을 겹쳐 쓴다', async () => {
    const onScroll = jest.fn();
    await mount(
      <Host onClose={() => {}}>
        <SheetScroll testID="mine" onScroll={onScroll} scrollEnabled={false}>
          <View />
        </SheetScroll>
      </Host>,
    );
    scrollTo('mine', 30);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mine').props.scrollEnabled).toBe(false);
    expect(screen.getByTestId('mine').props.scrollEventThrottle).toBe(16);
    // 시트도 그 오프셋을 알았다
    expect(drag('page-sheet-body', [[20, 100], [70, 116]], {release: false})).toBe(false);
  });

  it('시트의 스크롤에는 고무줄이 없다 — 맨 위에서 아래로 끄는 손가락이 네이티브 스크롤을 당겨 이중으로 움직이지 않는다(iOS)', async () => {
    await mount(<Host onClose={() => {}} />);
    // 맨 위의 UIScrollView 는 고무줄이 없으면 아래로 끄는 손가락에 움직일 곳이 없다. JS 가 응답자를 가져가도 네이티브 스크롤은 멈추지
    // 않는다(시뮬레이터 계측: PR 본문) — 그래서 끌기를 쥐는 동안의 얼림(scrollEnabled)에 더해 이것이 구조적 방어다.
    expect(screen.getByTestId('sheet-scroll').props.bounces).toBe(false);
  });

  it('시트 밖에서도 부를 수 있다 — 알릴 곳이 없으니 호출자의 값 그대로 동작한다(날 FlatList·ScrollView 가 시트 밖에서 재사용돼도 안전)', async () => {
    const onScroll = jest.fn();
    function Outside() {
      const wired = usePageSheetScrollProps({onScroll});
      return (
        <ScrollView testID="outside" {...wired}>
          <View />
        </ScrollView>
      );
    }
    await mount(<Outside />);
    scrollTo('outside', 25);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('outside').props.scrollEnabled).toBe(true); // 얼릴 시트가 없다
    expect(screen.getByTestId('outside').props.bounces).toBe(false);
  });

  it('호출자가 고무줄을 따로 주면 그쪽이 이긴다 — 시트의 기본이 막지 않는다', async () => {
    await mount(
      <Host onClose={() => {}}>
        <SheetScroll testID="mine" bounces>
          <View />
        </SheetScroll>
      </Host>,
    );
    expect(screen.getByTestId('mine').props.bounces).toBe(true);
  });
});

describe('스크림 — 끌면 실제 렌더의 스크림이 따라서 옅어진다', () => {
  it('끌수록 옅어지고(시트 높이만큼 내리면 0), 위로 늘어난 때는 더 짙어지지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(scrimAlpha()).toBe(1);
    const half = Math.round(LARGE_HEIGHT / 2);
    drag('hdr', [[0 + 20, 100], [20 + half, 116]], {release: false});
    expect(sheetY()).toBe(half);
    expect(scrimAlpha()).toBeCloseTo(scrimOpacity(half, LARGE_HEIGHT), 3);
    expect(scrimAlpha()).toBeCloseTo(0.5, 2);
  });

  it('위로 끌어 늘어나도 1 을 넘지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    drag('hdr', [[300, 100], [200, 116]], {release: false});
    expect(sheetY()).toBeLessThan(0);
    expect(scrimAlpha()).toBe(1);
  });
});

describe('저장 안 한 입력 — 끌어 닫기 전에 「버릴까요?」', () => {
  it('dirty 인 시트를 먼 끌기로 닫으려 하면 닫지 않고 제자리로 돌아온 뒤 묻는다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} dirty onDiscardPrompt={prompt} />);
    drag('hdr', FAR_SLOW);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('「버리기」(discard)를 부르면 그때 닫는다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} dirty onDiscardPrompt={prompt} />);
    drag('hdr', FAR_SLOW);
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      prompt.mock.calls[0][0]();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('깨끗하면(dirty 아님) 묻지 않고 바로 닫는다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} onDiscardPrompt={prompt} />);
    drag('hdr', FAR_SLOW);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('모자란 끌기는 dirty 여도 묻지 않는다 — 닫으려던 것이 아니다', async () => {
    const prompt = jest.fn();
    await mount(<Host onClose={() => {}} dirty onDiscardPrompt={prompt} />);
    drag('hdr', SHORT_SLOW);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('스크림·VoiceOver escape·X 도 같은 문이다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} dirty onDiscardPrompt={prompt} />);
    fireEvent.press(screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}));
    act(() => {
      screen.getByTestId('page-sheet').props.onAccessibilityEscape();
    });
    fireEvent.press(screen.getByTestId('close'));
    expect(onClose).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('행동 누름(usePageSheetAction)은 묻지 않는다 — 저장·확정이 끝난 뒤의 닫기다', async () => {
    const onClose = jest.fn();
    const action = jest.fn();
    const prompt = jest.fn();
    function Save() {
      const afterClose = usePageSheetAction();
      return <Text onPress={() => afterClose(action)} testID="save">저장</Text>;
    }
    await mount(
      <Host onClose={onClose} dirty onDiscardPrompt={prompt}>
        <Save />
      </Host>,
    );
    fireEvent.press(screen.getByTestId('save'));
    expect(prompt).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('기본 묻기는 iOS 액션 시트다: 「버리기」를 고르면 닫고 「계속 편집」이면 그대로다', async () => {
    const show = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} dirty />);
    drag('hdr', FAR_SLOW);
    expect(show).toHaveBeenCalledTimes(1);
    const [options, callback] = show.mock.calls[0];
    expect(options).toMatchObject({title: '버릴까요?', options: ['버리기', '계속 편집'], destructiveButtonIndex: 0, cancelButtonIndex: 1});
    act(() => callback(1));
    expect(onClose).not.toHaveBeenCalled();
    act(() => callback(0));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('동작 줄이기 · 키보드', () => {
  it('동작 줄이기 켜짐: 끌어 닫아도 미끄러지지 않고 바로 닫히고, 모자란 끌기는 스프링 없이 바로 제자리다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const spring = jest.spyOn(Animated, 'spring');
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />, true);
    drag('hdr', SHORT_SLOW);
    expect(spring).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    drag('hdr', FAR_SLOW);
    expect(timing).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('동작 줄이기 꺼짐: 모자란 끌기는 스프링으로 제자리, 닫는 끌기는 화면 높이까지 미끄러지는 던진 곡선', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const spring = jest.spyOn(Animated, 'spring');
    await mount(<Host onClose={() => {}} />, false);
    timing.mockClear();
    drag('hdr', SHORT_SLOW);
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0][1]).toMatchObject({toValue: 0});
    drag('hdr', FLICK);
    const slide = timing.mock.calls[timing.mock.calls.length - 1][1];
    expect(slide).toMatchObject({toValue: WINDOW.height});
    expect(slide.easing).toBe(FLING_OUT); // X·스크림의 닫기는 기본 곡선이다(아래 대조)
  });

  it('X 로 닫을 때는 기본 곡선·기본 길이다(대조)', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Host onClose={() => {}} />, false);
    timing.mockClear();
    fireEvent.press(screen.getByTestId('close'));
    expect(timing.mock.calls[0][1].easing).toBeUndefined();
    expect(timing.mock.calls[0][1].duration).toBe(SHEET_SLIDE_MS);
  });

  it('시트 안의 입력이 부른 키보드는 끌어 닫을 때 같이 내려간다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await mount(<Host onClose={() => {}} height="medium" />);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336));
    });
    drag('hdr', FAR_SLOW);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('닫는 중에는 끌기를 가져가지 않는다', async () => {
    await mount(<Host onClose={() => {}} />, false);
    fireEvent.press(screen.getByTestId('close'));
    expect(drag('hdr', [[20, 100], [70, 116]], {release: false})).toBe(false);
  });
});

describe('시작 응답자 길 — 눌리지 않는 자리에서 시작한 끌기 (시뮬레이터가 잡은 결함: Modal 호스트가 응답자를 쥐면 시트에 이동이 닿지 않는다)', () => {
  it('머리의 눌리지 않는 자리(제목)에서 시작해도 시트가 손가락을 따라온다 (±1pt)', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(dragFromStart('hdr', [[20, 100], [70, 116], [120, 132]], {release: false}).armed).toBe(true);
    expect(sheetY()).toBe(100); // 쥔 순간(첫 걸음 20)을 흡수하고 손가락이 100 더 움직였다
  });

  it('머리의 눌리지 않는 자리에서 시작한 먼 끌기는 닫고, 모자란 끌기는 제자리로 돌아온다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', SHORT_SLOW).armed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    expect(dragFromStart('hdr', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('손잡이 띠도 같다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('page-sheet-handle', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('머리는 스크롤이 중간이어도 잡는다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    scrollTo('sheet-scroll', 300);
    expect(dragFromStart('hdr', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('본문의 눌리지 않는 자리는 스크롤이 맨 위일 때만 잡는다 — 중간이면 응답자가 시트에 오지 않는다(스크롤과 간섭 없음)', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    sizeScroll('sheet-scroll', 300, 500); // 내용이 뷰포트에 들어간다 — 넘치면 잡지 않는다(아래 「넘치는 스크롤」)
    scrollTo('sheet-scroll', 40);
    expect(dragFromStart('page-sheet-body', FAR_SLOW).armed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    scrollTo('sheet-scroll', 0);
    expect(dragFromStart('page-sheet-body', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('잡고도 얌전히 기다린다 — 탭은 시트가 할 일이 없다(움직이지도, 스프링도, 얼림도 없다)', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />, false);
    spring.mockClear();
    expect(dragFromStart('hdr', [[2, 40]]).armed).toBe(true); // 2pt 움직인 탭
    expect(spring).not.toHaveBeenCalled(); // 쥐지 않았으니 「제자리로」의 스프링도 없다(애니메이션이 켜져 있어야 스프링이 보인다)
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
  });

  it('기다리는 동안 시스템이 터치를 거둬 가도(terminate) 시트는 아무것도 하지 않는다 — 쥔 끌기만 제자리로 돌아간다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mount(<Host onClose={() => {}} />, false);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    spring.mockClear();
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1, 0));
      expect(handlers.onStartShouldSetResponder(touch(0, 1, 0))).toBe(true);
      handlers.onResponderGrant(touch(0, 1, 0));
      handlers.onResponderTerminate(touch(2, 20, 0)); // 쥐지 않은 채 거둬졌다(알림·제스처)
    });
    expect(spring).not.toHaveBeenCalled();
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
    // 대조: 쥔 끌기가 거둬지면 제자리로 돌아간다.
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 100, 0));
      handlers.onStartShouldSetResponder(touch(0, 100, 0));
      handlers.onResponderGrant(touch(0, 100, 0));
      handlers.onResponderMove(touch(40, 116, 0)); // 쥔다
      handlers.onResponderTerminate(touch(40, 132, 40));
    });
    expect(spring).toHaveBeenCalledTimes(1);
    expect(spring.mock.calls[0][1]).toMatchObject({toValue: 0});
  });

  it('잡고도 얌전히 기다린다 — 문턱 안의 떨림·위로 쓸기·가로 쓸기는 시트를 움직이지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    for (const steps of [
      [[4, 20], [5, 40]] as Array<[number, number]>, // 6pt 문턱 안
      [[-30, 20], [-80, 40]] as Array<[number, number]>, // 위로
    ]) {
      expect(dragFromStart('hdr', steps, {release: false}).armed).toBe(true);
      expect(sheetY()).toBe(0);
      act(() => {
        (screen.getByTestId('hdr').props as Handlers).onResponderRelease(touch(0, 90, 0));
      });
    }
    expect(sheetY()).toBe(0);
  });

  it('스크롤은 시트가 끌기를 **쥔 뒤에야** 얼린다 — 기다리는 동안은 그대로 스크롤된다', async () => {
    await mount(<Host onClose={() => {}} />);
    sizeScroll('sheet-scroll', 300, 500); // 내용이 뷰포트에 들어가야 본문이 시작 응답자를 잡는다(넘치면 잡지 않는다)
    const scroll = () => screen.getByTestId('sheet-scroll').props.scrollEnabled;
    const handlers = screen.getByTestId('page-sheet-body').props as Handlers;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1, 0));
      expect(handlers.onStartShouldSetResponder(touch(0, 1, 0))).toBe(true);
      handlers.onResponderGrant(touch(0, 1, 0));
    });
    expect(scroll()).toBe(true); // 잡았지만 아직 기다린다
    act(() => {
      handlers.onResponderMove(touch(3, 16, 0));
    });
    expect(scroll()).toBe(true); // 문턱 안
    act(() => {
      handlers.onResponderMove(touch(30, 32, 3));
    });
    expect(scroll()).toBe(false); // 쥐었다
    act(() => {
      handlers.onResponderRelease(touch(30, 33, 30));
    });
    expect(scroll()).toBe(true); // 놓으면 푼다
  });

  it('닫는 중에는 시작에서도 잡지 않는다', async () => {
    await mount(<Host onClose={() => {}} />, false);
    fireEvent.press(screen.getByTestId('close'));
    expect(dragFromStart('hdr', FAR_SLOW).armed).toBe(false);
    expect(dragFromStart('page-sheet-body', FAR_SLOW).armed).toBe(false);
  });

  it('둘째 손가락이 내려앉아도 쥔 끌기가 끊기지 않는다 — 새 터치(첫 손가락)만 상태를 비운다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(dragFromStart('hdr', [[20, 100], [120, 132]], {release: false}).armed).toBe(true);
    expect(sheetY()).toBe(100);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(120, 140, 120, 2)); // 둘째 손가락의 시작
      handlers.onResponderMove(touch(170, 156, 120));
    });
    expect(sheetY()).toBe(150); // 여전히 쥐고 있고 따라온다
  });

  it('새 터치(첫 손가락)는 지난 끌기가 남긴 상태를 비운다 — 쥐지 못한 채 끝난 터치 뒤의 터치가 곧바로 쥐지 않는다', async () => {
    await mount(<Host onClose={() => {}} />);
    const handlers = screen.getByTestId('hdr').props as Handlers;
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1, 0));
      handlers.onMoveShouldSetResponderCapture(touch(20, 16, 0)); // 가로채기가 참 — 곧 grant 가 올 터였다
      // …그러나 현재 응답자가 내주지 않아 grant 는 오지 않았고, 「가로채기 참」이 상태에 남았다.
    });
    expect(dragFromStart('hdr', [[3, 40]], {release: false}).armed).toBe(true);
    expect(sheetY()).toBe(0); // 기다린다 — 옛 「가로채기 참」이 남아 곧바로 쥐지 않았다
    expect(screen.getByTestId('sheet-scroll').props.scrollEnabled).toBe(true);
  });

  it('저장 안 한 입력이 있으면 이 길로 먼 끌기를 해도 닫지 않고 묻는다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} dirty onDiscardPrompt={prompt} />);
    expect(dragFromStart('hdr', FAR_SLOW).armed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('짧아도 빠르게 튕기면 닫는다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', FLICK).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('아래로 문턱을 넘게 내렸다가 위로 튕기며 놓으면 열린 채다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', DOWN_THEN_FLICK_UP).armed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });
});

/** 이 자리의 터치가 시작될 때 시트가 응답자를 잡는가 — 이동 없이 시작 협상만 묻는다(캡처 → 버블, 응답자 플러그인과 같은 순서). */
const claimsStart = (testID: string): boolean => {
  const handlers = screen.getByTestId(testID).props as Handlers;
  let claimed = false;
  act(() => {
    handlers.onStartShouldSetResponderCapture(touch(0, 1, 0));
    claimed = Boolean(handlers.onStartShouldSetResponder(touch(0, 1, 0)));
  });
  return claimed;
};

describe('넘치는 스크롤 — 본문은 시작 응답자를 잡지 않는다 (시뮬레이터가 잡은 둘째 결함: 맨 위에서 눌리지 않는 자리를 짚고 위로 올리는 스크롤이 죽었다)', () => {
  // 본문 뿌리는 스크롤 뷰의 조상이다. iOS(Fabric)는 스크롤 뷰의 조상 중 하나라도 JS 응답자이면 그 터치의 네이티브 스크롤을 시작도 못 하게 막는다
  // (`_shouldDisableScrollInteraction`). 그래서 내용이 넘쳐 실제로 스크롤되는 본문은 시작 응답자를 잡으면 안 된다.
  it('내용이 뷰포트를 넘치면 본문의 눌리지 않는 자리는 맨 위에서도 잡지 않는다 — 스크롤이 막히지 않는다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    sizeScroll('sheet-scroll', 2000, 500);
    expect(dragFromStart('page-sheet-body', FAR_SLOW).armed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });

  it('내용이 뷰포트에 들어가면 같은 자리를 잡는다 — 짧은 시트는 본문 어디서든 끌린다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    sizeScroll('sheet-scroll', 300, 500);
    expect(dragFromStart('page-sheet-body', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('크기 사건이 오는 대로 따라간다 — 내용이 늘어 넘치면 놓고, 줄어 들어가면 다시 잡는다', async () => {
    await mount(<Host onClose={() => {}} />);
    sizeScroll('sheet-scroll', 300, 500);
    expect(claimsStart('page-sheet-body')).toBe(true);
    sizeScroll('sheet-scroll', 900, 500);
    expect(claimsStart('page-sheet-body')).toBe(false);
    sizeScroll('sheet-scroll', 400, 500);
    expect(claimsStart('page-sheet-body')).toBe(true);
  });

  it('크기를 알리기 전(레이아웃 전)은 넘친다고 본다 — 잡지 않는다(fail-closed)', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(claimsStart('page-sheet-body')).toBe(false);
  });

  it('뷰포트만, 또는 내용 크기만 알려서는 판정하지 못한다 — 둘 다 알아야 한다', async () => {
    await mount(<Host onClose={() => {}} />);
    act(() => {
      fireEvent(screen.getByTestId('sheet-scroll'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 500}}});
    });
    expect(claimsStart('page-sheet-body')).toBe(false); // 내용 크기를 모른다
    act(() => {
      fireEvent(screen.getByTestId('sheet-scroll'), 'contentSizeChange', 390, 300);
    });
    expect(claimsStart('page-sheet-body')).toBe(true);
  });

  it('스크롤이 둘이면 하나라도 넘치면 잡지 않고, 그 스크롤이 사라지면 잡는다', async () => {
    function Two({second}: {second: boolean}) {
      return (
        <Host onClose={() => {}}>
          <SheetScroll testID="a"><View /></SheetScroll>
          {second ? <SheetScroll testID="b"><View /></SheetScroll> : null}
        </Host>
      );
    }
    const utils = await mount(<Two second />);
    sizeScroll('a', 200, 500);
    sizeScroll('b', 3000, 500);
    expect(claimsStart('page-sheet-body')).toBe(false);
    utils.rerender(
      <FixedScheme scheme="light">
        <Two second={false} />
      </FixedScheme>,
    );
    await act(async () => {});
    expect(claimsStart('page-sheet-body')).toBe(true);
  });

  it('언마운트 뒤에 늦게 온 크기 사건이 지워진 스크롤을 되살려 시트를 영영 막지 않는다', async () => {
    let handle: ReturnType<typeof usePageSheetScroll> = null;
    function Late() {
      handle = usePageSheetScroll();
      return null;
    }
    function Two({late}: {late: boolean}) {
      return (
        <Host onClose={() => {}}>
          <SheetScroll testID="a"><View /></SheetScroll>
          {late ? <Late /> : null}
        </Host>
      );
    }
    const utils = await mount(<Two late />);
    sizeScroll('a', 200, 500);
    expect(claimsStart('page-sheet-body')).toBe(false); // `Late` 는 크기를 모르는 스크롤로 등록돼 있다
    utils.rerender(
      <FixedScheme scheme="light">
        <Two late={false} />
      </FixedScheme>,
    );
    await act(async () => {});
    expect(claimsStart('page-sheet-body')).toBe(true);
    act(() => {
      handle?.reportContentHeight(5000);
      handle?.reportViewportHeight(300);
    });
    expect(claimsStart('page-sheet-body')).toBe(true); // 늦은 사건이 `Late` 를 되살리지 못했다
  });

  it('넘치는 스크롤에서도 머리는 잡는다 — 머리는 스크롤 뷰의 조상이 아니라 막을 스크롤이 없다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    sizeScroll('sheet-scroll', 2000, 500);
    expect(dragFromStart('hdr', FAR_SLOW).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('넘치는 스크롤의 맨 위에서도, 행·단추처럼 후손이 응답자인 터치는 시트가 이동에서 가로챈다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    sizeScroll('sheet-scroll', 2000, 500);
    expect(drag('page-sheet-body', FAR_SLOW)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('`usePageSheetScrollProps` 를 펼친 날 FlatList 도 크기를 알린다', async () => {
    function List() {
      const sheetScroll = usePageSheetScrollProps();
      return <FlatList {...sheetScroll} data={[1, 2, 3]} renderItem={({item}) => <Text>{item}</Text>} testID="own-list" />;
    }
    await mount(
      <Host onClose={() => {}}>
        <List />
      </Host>,
    );
    expect(claimsStart('page-sheet-body')).toBe(false); // 크기를 모른다
    sizeScroll('own-list', 120, 500);
    expect(claimsStart('page-sheet-body')).toBe(true);
    sizeScroll('own-list', 4000, 500);
    expect(claimsStart('page-sheet-body')).toBe(false);
  });

  it('호출자가 준 onLayout·onContentSizeChange 는 지워지지 않고 같이 불린다', async () => {
    const onLayout = jest.fn();
    const onContentSizeChange = jest.fn();
    await mount(
      <Host onClose={() => {}}>
        <SheetScroll testID="own" onLayout={onLayout} onContentSizeChange={onContentSizeChange}>
          <View />
        </SheetScroll>
      </Host>,
    );
    sizeScroll('own', 300, 500);
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onContentSizeChange).toHaveBeenCalledWith(390, 300);
    expect(claimsStart('page-sheet-body')).toBe(true);
  });
});

describe('놓는 속도의 표본은 터치 시작부터 모은다 — 쥐는 첫 이벤트가 전체의 상당수인 짧은 튕김 (시뮬레이터가 잡은 결함)', () => {
  // 터치가 y=0 에서 84ms 에 내려앉고, 16ms 뒤 30pt, 다시 16ms 뒤 75pt — 두 번의 이동뿐인 아주 짧은 튕김(2.3px/ms). 쥐는 것은 첫 이동(30pt > 6)이라
  // 쥔 뒤의 표본만 모으면 둘(쥔 이동·마지막 이동)뿐이라 속도가 0 으로 읽혀(`VELOCITY_MIN_SAMPLES` 3) 닫히지 않았다. 문턱 거리에는 한참 못 미친다(45pt).
  const SHORT_FLICK: Array<[number, number]> = [[30, 100], [75, 116]];

  it('시작 응답자 길: 쥔 뒤의 이동이 둘뿐인 튕김도 속도로 닫는다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', SHORT_FLICK, {downAt: 84}).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('이동 가로채기 길: 같다 — 쥐기 전의 이동도 표본이다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(drag('hdr', SHORT_FLICK, {downAt: 84})).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('대조: 같은 거리를 느리게(표본이 40ms 보다 벌어짐) 끌면 닫지 않는다 — 속도가 닫은 것이다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', [[30, 100], [75, 300]], {downAt: 84}).armed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('시작 응답자 길: 쥐기 전의 이동 때문에 따라오기가 어긋나지 않는다 — 시트는 쥔 자리부터 손가락과 1:1 이다', async () => {
    await mount(<Host onClose={() => {}} />);
    // 첫 이동(30pt)에서 쥐고 그 30 은 흡수한다 → 75 까지 갔으면 시트는 45.
    expect(dragFromStart('hdr', SHORT_FLICK, {downAt: 84, release: false}).armed).toBe(true);
    expect(sheetY()).toBe(45);
  });

  it('이동 가로채기 길: 같은 45 다 — grant 가 dy 를 0 으로 되돌려도 이미 움직인 30 을 기준에 더해 둔다', async () => {
    await mount(<Host onClose={() => {}} />);
    expect(drag('hdr', SHORT_FLICK, {downAt: 84, release: false})).toBe(true);
    expect(sheetY()).toBe(45);
  });
});

describe('속도 표본의 기준은 어느 길로 쥐었든 같다 — 터치 시작부터의 누적 이동', () => {
  // 처음 16ms 에 60pt 를 휙 내리고 이어서 2pt 씩 기어간다. 마지막 100ms 창의 기울기는 (0·60·62·64 @ 0·16·32·48ms) ≈ 1.2px/ms 라 속도로 닫힌다.
  // 이동 가로채기 길은 grant 가 `g.dy` 를 0 으로 되돌리므로, 이미 움직인 60 을 기준에 더해 두지 않으면 쥔 뒤의 표본이 (2·4)로 내려앉아
  // 기울기가 뒤집힌다 — 눈에 보이는 따라오기는 같아서 이 시험만이 잡는다.
  const BURST_THEN_CRAWL: Array<[number, number]> = [[60, 100], [62, 116], [64, 132]];

  it('시작 응답자 길', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(dragFromStart('hdr', BURST_THEN_CRAWL, {downAt: 84}).armed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('이동 가로채기 길', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(drag('hdr', BURST_THEN_CRAWL, {downAt: 84})).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// 거리 문턱(큰 단 1276 의 25% = 319)을 넘게 천천히 내려 놓은 뒤(dy 400) 마지막 48ms 에 위로 쳐올리며 놓는다 — 놓는 순간 시트는
// 아직 문턱 아래(dy 342 > 319)이고 속도는 −1.2px/ms 다. 놓은 자리만 보면 닫는 자리이고 속도 방향만 보면 열어 두는 자리다.
const DOWN_THEN_FLICK_UP: Array<[number, number]> = [
  [20, 100],
  [170, 600],
  [270, 1100],
  [420, 1600],
  [405, 1616],
  [385, 1632],
  [362, 1648],
];
/** 아주 빠른 내려치기(6px/ms): 64ms 에 384pt. 남은 거리는 화면 높이 − 384. */
const FAST_DOWN: Array<[number, number]> = [[20, 100], [116, 116], [212, 132], [308, 148], [404, 164]];

describe('놓을 때 — 속도 방향이 이기고, 놓고 닫는 슬라이드는 놓은 속도를 잇는다', () => {
  it('문턱을 넘게 내려 놓았어도 위로 튕기며 놓으면 열린 채 제자리로 돌아온다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(drag('hdr', DOWN_THEN_FLICK_UP)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });

  it('대조: 같은 자리에서 튕김 없이 멈췄다 놓으면 닫는다 — 위의 열림은 속도 방향이 만든 것이다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    // 같은 마지막 자리(dy 342)에 닿되 마지막 표본이 40ms 보다 오래 전이라 속도는 0 이다.
    drag('hdr', [[20, 100], [170, 600], [270, 1100], [362, 1600]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('위로 튕기며 놓으면 dirty 여도 묻지 않는다 — 닫으려던 것이 아니다', async () => {
    const onClose = jest.fn();
    const prompt = jest.fn();
    await mount(<Host onClose={onClose} dirty onDiscardPrompt={prompt} />);
    drag('hdr', DOWN_THEN_FLICK_UP);
    expect(prompt).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });

  it('본문 끌기(스크롤 맨 위)도 같다 — 위로 튕기며 놓으면 열린 채다', async () => {
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />);
    expect(drag('page-sheet-body', DOWN_THEN_FLICK_UP)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(sheetY()).toBe(0);
  });

  it('아주 빠르게 내려쳐 놓으면 그 속도로 남은 거리를 나간다 — 길이는 남은 거리 ÷ 놓은 속도', async () => {
    // 아래의 158 은 Jest 의 창 높이(RN 프리셋 1334)에 기댄 숫자다 — 창이 바뀌면 이 단정이 먼저 말한다.
    expect(WINDOW.height).toBe(1334);
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Host onClose={() => {}} />, false);
    timing.mockClear();
    drag('hdr', FAST_DOWN);
    const slide = timing.mock.calls[timing.mock.calls.length - 1][1];
    // 384pt 를 64ms 에 내려갔으니 6px/ms, 남은 거리는 목적지(창 높이 1334) − 384 = 950 → 950 ÷ 6 = 158.3.
    expect(slide.duration).toBe(158);
    expect(slide.easing).toBe(FLING_OUT);
    expect(slide.toValue).toBe(WINDOW.height);
  });

  it('느리게 놓아 닫으면(속도 0) 옛 길이 그대로다 — 속도 기반 길이의 상한', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Host onClose={() => {}} />, false);
    timing.mockClear();
    drag('hdr', FAR_SLOW);
    const slide = timing.mock.calls[timing.mock.calls.length - 1][1];
    expect(slide.duration).toBe(SHEET_SLIDE_MS);
    expect(slide.easing).toBe(FLING_OUT);
  });

  /**
   * 같은 간격의 표본 넷(grant + 이동 셋)으로 `stepPt`/`stepMs` px/ms 로 내려 놓고, 그때 시트가 잡은 슬라이드 길이를 돌려준다.
   * 시험 하나에 한 번만 부른다 — 한 시험 안에서 `cleanup()` 하고 다시 마운트하면 act 범위가 겹친다.
   */
  async function releaseDurationOf(stepPt: number, stepMs: number): Promise<number> {
    const timing = jest.spyOn(Animated, 'timing');
    await mount(<Host onClose={() => {}} />, false);
    timing.mockClear();
    drag('hdr', [
      [20, 100],
      [20 + stepPt, 100 + stepMs],
      [20 + 2 * stepPt, 100 + 2 * stepMs],
      [20 + 3 * stepPt, 100 + 3 * stepMs],
    ]);
    return timing.mock.calls[timing.mock.calls.length - 1][1].duration as number;
  }

  it('슬라이드 길이 — 느리게 놓으면(1px/ms, 문턱 0.7 은 넘는다) 상한이다: 남은 거리 ÷ 1 은 어느 창에서나 상한을 넘는다', async () => {
    expect(await releaseDurationOf(40, 40)).toBe(SHEET_SLIDE_MS);
  });

  it('슬라이드 길이 — 가운데 속도면 상하한 사이다: 남은 거리 ÷ 속도 ≈ 190ms 가 되게 표본 간격을 골랐다(창 높이와 무관)', async () => {
    const duration = await releaseDurationOf(100, Math.round(19000 / (WINDOW.height - 300)));
    expect(duration).toBeGreaterThan(SHEET_RELEASE_MIN_MS);
    expect(duration).toBeLessThan(SHEET_SLIDE_MS);
  });

  it('슬라이드 길이 — 아주 빠르게 놓으면(33px/ms) 하한이다: 남은 거리 ÷ 33 은 하한보다 짧다', async () => {
    expect(await releaseDurationOf(100, 3)).toBe(SHEET_RELEASE_MIN_MS);
  });

  it('동작 줄이기 켜짐: 놓고 닫아도 슬라이드 없이 즉시다(속도와 무관)', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const onClose = jest.fn();
    await mount(<Host onClose={onClose} />, true);
    timing.mockClear();
    drag('hdr', FAST_DOWN);
    expect(timing).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('위로 늘어나는 고무줄 밑의 바탕', () => {
  it('시트 바닥 밑에 상한만큼의 바탕이 깔려 있다(키보드가 시트를 올렸을 때는 키보드 쐐기가 대신한다)', async () => {
    await mount(<Host onClose={() => {}} height="medium" />);
    const skirt = flat('page-sheet-skirt');
    expect(skirt.height).toBe(SHEET_RUBBER_MAX);
    expect(skirt.bottom).toBe(-SHEET_RUBBER_MAX);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336));
    });
    expect(screen.queryByTestId('page-sheet-skirt')).toBeNull();
    expect(within(screen.getByTestId('page-sheet')).getByTestId('page-sheet-keyboard-corner')).toBeTruthy();
  });
});
