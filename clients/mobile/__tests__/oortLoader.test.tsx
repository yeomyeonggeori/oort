import {act, cleanup, render, screen} from '@testing-library/react-native';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import NetInfo from '@react-native-community/netinfo';
import {AccessibilityInfo, Animated, StyleSheet} from 'react-native';

import {OortLoader} from '../src/design/brand/OortLoader';
import {
  CURVES,
  DIP_UNITS,
  HOME_ANGLE,
  LOADER_PERIOD_MS,
  OPTICAL,
  opticalFor,
  PHASE,
  poseAt,
  readKnots,
  tablesFor,
  TRAILS,
} from '../src/design/brand/oortLoaderTimeline';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {Booting} from '../App';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {
  connectionBannerText,
  ConversationHeader,
} from '../src/features/conversation/ConversationHeader';

// =============================================================================
// 오르트 로더 (#3961, 시안 A 「공전」) — 폰.
//
// 웹은 CSS 키프레임, 폰은 `Animated` 라서 두 표면이 **같은 움직임**임을 손으로 믿을 수
// 없다. 이 파일이 지키는 것:
//   1. 시간표(순수): 모든 표가 늘어나기만 하고, 주기 함수이며, 시안의 자세(홈·나옴·한 바퀴·꽂기)를 낸다.
//   2. 웹 대조: 구간 경계(14·86·94%)·곡선·주기·비율이 웹 `tokens.css` 와 같다(그 파일을 읽는다).
//   3. 컴포넌트: 링·위성의 색·크기·그리는 순서, 장식(접근성 숨김), 세 갈래(움직임·동작 줄이기·정지),
//      당김(progress)·이어 돌기, 언마운트에서 반복이 멈춘다.
//   4. 래스터: 링 PNG 여섯 장의 크기·구멍, 그리고 마크 정본이 바뀌면 빨개지는 트립와이어.
//
// red proof (이 파일이 지키는 것):
//   - OortLoader 의 effect 에서 `return () => loop.stop()` 을 지우면 → 「언마운트에서 멈춘다」가 붉다
//   - 시간표 표 하나에서 끝점을 어긋나게 하면 → 「늘어나기만」·「주기」 단정이 붉다
//   - 웹 키프레임 퍼센트를 바꾸면(또는 PHASE 를 바꾸면) → 웹 대조가 붉다
//   - 위성 층을 링 뒤(그리는 순서)로 옮기면 → 「링이 위성 위」가 붉다
//   - `useReduceMotion` 분기를 지우면 → 「동작 줄이기」 단정들이 붉다
//
// 래스터를 다시 만드는 법(rsvg-convert): 마크 정본 링 path(`clients/web/src/design/brand/
// OortMark.tsx` GEOMETRY.*.ring, 위성 제외)를 `fill="#000000" fill-rule="evenodd"` 로 그린
// SVG 를 무대 viewBox 로 연다 — small `-4 -2 30 30`(32pt: 32·64·96px), display `-3 -1 68 68`
// (64pt: 64·128·192px). 파일은 `oort-loader-ring-{small,display}{,@2x,@3x}.png`.
// =============================================================================

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const HIDDEN = {includeHiddenElements: true} as const;
const flatten = (style: unknown) =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

const REPO = path.join(__dirname, '../../..');
const WEB_CSS = fs.readFileSync(
  path.join(REPO, 'clients/web/src/design/tokens.css'),
  'utf8',
);
const WEB_MARK = fs.readFileSync(
  path.join(REPO, 'clients/web/src/design/brand/OortMark.tsx'),
  'utf8',
);

// ---- 1. 시간표 -------------------------------------------------------------------

describe('시간표(순수) — 한 시계에서 읽는 표', () => {
  const tables = {small: tablesFor('small'), display: tablesFor('display')};

  it.each(['small', 'display'] as const)(
    '%s: 모든 표의 입력이 [0, 2] 에서 늘어나기만 한다(Animated 입력 범위 규칙)',
    optical => {
      const t = tables[optical];
      const all = [t.radial, t.angle, t.ring, t.trail(0.5), t.breathe];
      for (const knots of all) {
        expect(knots[0]![0]).toBe(0);
        expect(knots[knots.length - 1]![0]).toBe(2);
        for (let i = 1; i < knots.length; i += 1) {
          expect(knots[i]![0]).toBeGreaterThanOrEqual(knots[i - 1]![0]);
          expect(Number.isFinite(knots[i]![1])).toBe(true);
        }
      }
    },
  );

  it.each(['small', 'display'] as const)(
    '%s: 주기 함수다 — 두 번째 주기가 첫 주기의 반복이고(각도만 360 더 간다) 이음새에서 뛰지 않는다',
    optical => {
      for (let i = 0; i <= 40; i += 1) {
        const t = i / 40;
        const a = poseAt(optical, t);
        const b = poseAt(optical, t + 1);
        expect(b.radial).toBeCloseTo(a.radial, 6);
        expect(b.ringScale).toBeCloseTo(a.ringScale, 6);
        expect(b.breatheOpacity).toBeCloseTo(a.breatheOpacity, 6);
        expect(b.angle).toBeCloseTo(a.angle + 360, 6);
      }
      // 이음새(t = 1)의 앞뒤가 이어진다: 거꾸로 감기는 구간이 없다.
      const before = poseAt(optical, 1 - 1e-4);
      const after = poseAt(optical, 1 + 1e-4);
      expect(Math.abs(after.angle - before.angle)).toBeLessThan(1);
      expect(Math.abs(after.radial - before.radial)).toBeLessThan(0.01);
    },
  );

  it('시안 A 의 자세: 홈에서 나와 한 바퀴 돌고 홈 안쪽까지 들어갔다가 꽂힌다 (small)', () => {
    const {units, home, out} = OPTICAL.small;
    const h = home / units;
    const o = out / units;
    // t = 0: 홈(링 중심에서 33%), 오른쪽 위 -45도, 링은 그대로.
    expect(poseAt('small', 0)).toMatchObject({radial: h, angle: HOME_ANGLE, ringScale: 1});
    // 14%: 궤도(40.7%)까지 나왔고 아직 돌기 전이다.
    expect(poseAt('small', PHASE.popEnd)).toMatchObject({radial: o, angle: HOME_ANGLE});
    // 도는 동안 궤도에 있고 각도가 늘기만 한다.
    let last = HOME_ANGLE;
    for (let i = 0; i <= 50; i += 1) {
      const t = PHASE.popEnd + ((PHASE.spinEnd - PHASE.popEnd) * i) / 50;
      const pose = poseAt('small', t);
      expect(pose.radial).toBeCloseTo(o, 6);
      expect(pose.angle).toBeGreaterThanOrEqual(last);
      last = pose.angle;
    }
    // 86%: 한 바퀴(315 = -45 + 360)를 다 돌았다.
    expect(poseAt('small', PHASE.spinEnd).angle).toBeCloseTo(HOME_ANGLE + 360, 6);
    // 94%: 홈보다 안쪽(0.9칸)까지 들어갔다.
    expect(poseAt('small', PHASE.dipAt).radial).toBeCloseTo((home - DIP_UNITS) / units, 6);
    // 100%: 홈에 꽂혔다.
    expect(poseAt('small', 1).radial).toBeCloseTo(h, 6);
    // 링은 꽂히는 때(95%)에 한 번 1.05배로 숨 쉰다.
    expect(poseAt('small', PHASE.ringPeak).ringScale).toBeCloseTo(1.05, 6);
    expect(poseAt('small', PHASE.ringStart).ringScale).toBe(1);
    expect(poseAt('small', 1).ringScale).toBeCloseTo(1, 6);
  });

  it('회전은 한가운데에서 한 번에 휙 돌지 않는다: 느리게 시작해 빨라졌다 느려진다(ease-in-out)', () => {
    const span = PHASE.spinEnd - PHASE.popEnd;
    const angleAt = (f: number) => poseAt('small', PHASE.popEnd + span * f).angle - HOME_ANGLE;
    // 처음 10% 시간에 도는 각도가 평균(36°)보다 적고, 가운데 20% 에서는 평균(72°)보다 많다.
    expect(angleAt(0.1)).toBeLessThan(36);
    expect(angleAt(0.6) - angleAt(0.4)).toBeGreaterThan(72);
    expect(360 - angleAt(0.9)).toBeLessThan(36);
  });

  it('동작 줄이기: 한 주기에 투명도 1 → 0.5 → 1', () => {
    expect(poseAt('small', 0).breatheOpacity).toBe(1);
    expect(poseAt('small', 0.5).breatheOpacity).toBeCloseTo(0.5, 6);
    expect(poseAt('small', 1).breatheOpacity).toBeCloseTo(1, 6);
  });

  it('꼬리 점은 도는 동안만 보이고 나오고 꽂히는 동안은 숨는다', () => {
    const table = tables.display.trail(0.5);
    expect(readKnots(table, 0)).toBe(0);
    expect(readKnots(table, 0.5)).toBeCloseTo(0.5, 6);
    expect(readKnots(table, 1)).toBe(0);
    expect(readKnots(tables.display.trail(0.26), 0.5)).toBeCloseTo(0.26, 6);
  });

  it('광학 판: 32pt 이하는 small, 그보다 크면 display 다', () => {
    expect([opticalFor(20), opticalFor(24), opticalFor(32), opticalFor(33), opticalFor(56)]).toEqual([
      'small',
      'small',
      'small',
      'display',
      'display',
    ]);
  });

  it('궤도는 링 바깥이다: 위성 안쪽 가장자리가 링 바깥 반지름보다 멀다 (두 판)', () => {
    // small 링 바깥 반지름 8(24 격자), display 20(64 격자).
    const ringOuter = {small: 8, display: 20};
    for (const optical of ['small', 'display'] as const) {
      const {out, satelliteRadius} = OPTICAL[optical];
      expect(out - satelliteRadius).toBeGreaterThan(ringOuter[optical]);
    }
  });
});

// ---- 2. 웹 대조 ----------------------------------------------------------------------

describe('웹 tokens.css 와 같은 움직임이다 (정본은 웹)', () => {
  /** `@keyframes name { ... }` 의 안쪽. */
  function keyframes(name: string): string {
    const start = WEB_CSS.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    if (start < 0) throw new Error(`웹 tokens.css 에 @keyframes ${name} 이 없다`);
    const open = WEB_CSS.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < WEB_CSS.length; i += 1) {
      if (WEB_CSS[i] === '{') depth += 1;
      if (WEB_CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) return WEB_CSS.slice(open + 1, i);
      }
    }
    throw new Error(`@keyframes ${name} 이 닫히지 않는다`);
  }
  /** 키프레임 선택자의 퍼센트들(0~1). */
  const percents = (body: string): number[] =>
    [...body.matchAll(/([\d.]+)%/g)].map(m => Number(m[1]) / 100);

  it('읽기 경로가 조용히 실패하지 않는다: 없는 키프레임을 물으면 터진다', () => {
    expect(() => keyframes('oort-loader-does-not-exist')).toThrow(/없다/);
  });

  it('주기는 웹 --oort-loader-period 와 같다(1.8초)', () => {
    expect(WEB_CSS).toMatch(/--oort-loader-period:\s*1\.8s;/);
    expect(LOADER_PERIOD_MS).toBe(1800);
  });

  it('반지름 키프레임의 구간 경계가 폰 PHASE 와 같다 (0·14·86·94·100%)', () => {
    expect(percents(keyframes('oort-loader-radial'))).toEqual([
      0,
      PHASE.popEnd,
      PHASE.spinEnd,
      PHASE.dipAt,
      1,
    ]);
  });

  it('회전·링 숨 키프레임의 경계가 같다', () => {
    expect(percents(keyframes('oort-loader-orbit'))).toEqual([
      0,
      PHASE.popEnd,
      PHASE.spinEnd,
      1,
    ]);
    expect(percents(keyframes('oort-loader-ring'))).toEqual([
      0,
      PHASE.ringStart,
      1,
      PHASE.ringPeak,
    ]);
  });

  it('곡선이 같다: 웹 cubic-bezier 값이 폰 CURVES 와 한 글자도 다르지 않다', () => {
    const css = (c: readonly number[]) => `cubic-bezier(${c.join(', ')})`;
    expect(keyframes('oort-loader-radial')).toContain(css(CURVES.pop));
    expect(keyframes('oort-loader-radial')).toContain(css(CURVES.settleIn));
    expect(keyframes('oort-loader-radial')).toContain('animation-timing-function: ease-out');
    expect(CURVES.settleOut).toEqual([0, 0, 0.58, 1]); // CSS ease-out
    expect(keyframes('oort-loader-orbit')).toContain(css(CURVES.spin));
    // 링 숨은 곡선을 적지 않는다(CSS 기본 ease), 숨은 ease-in-out.
    expect(CURVES.ring).toEqual([0.25, 0.1, 0.25, 1]); // CSS ease
    expect(CURVES.breathe).toEqual([0.42, 0, 0.58, 1]); // CSS ease-in-out
    expect(WEB_CSS).toMatch(/oort-loader-breathe var\(--oort-loader-period\) ease-in-out infinite/);
  });

  it('small 의 비율이 웹과 같다: 홈 33%·궤도 40.667%·지름 20%·꽂기 3%', () => {
    const {units, home, out, satelliteRadius} = OPTICAL.small;
    const pct = (v: number) => (v / units) * 100;
    expect(WEB_CSS).toMatch(new RegExp(`--oort-loader-home:\\s*${Math.round(pct(home))}%;`));
    expect(Number(/--oort-loader-out:\s*([\d.]+)%;/.exec(WEB_CSS)![1])).toBeCloseTo(pct(out), 2);
    expect(Number(/--oort-loader-dot:\s*([\d.]+)%;/.exec(WEB_CSS)![1])).toBeCloseTo(
      pct(satelliteRadius * 2),
      6,
    );
    expect(Number(/--oort-loader-dip:\s*([\d.]+)%;/.exec(WEB_CSS)![1])).toBeCloseTo(
      pct(DIP_UNITS),
      6,
    );
  });

  it('꼬리 점 둘: 머리 뒤 15°·30°, 0.72·0.5배, 투명도 0.5·0.26 (웹 큰 자리와 같은 모양)', () => {
    expect(TRAILS.map(t => t.offset)).toEqual([15, 30]);
    expect(WEB_CSS).toMatch(/\.oort-loader-trail-near\s*\{\s*transform:\s*rotate\(-60deg\)/);
    expect(WEB_CSS).toMatch(/\.oort-loader-trail-far\s*\{\s*transform:\s*rotate\(-75deg\)/);
    expect(WEB_CSS).toMatch(/\.oort-loader-trail-near \.oort-loader-dot\s*\{[^}]*opacity:\s*0\.5/);
    expect(WEB_CSS).toMatch(/\.oort-loader-trail-far \.oort-loader-dot\s*\{[^}]*opacity:\s*0\.26/);
    expect(TRAILS.map(t => t.opacity)).toEqual([0.5, 0.26]);
  });

  it('마크 정본의 위성 원(중심 18,6 반지름 3)과 홈 거리·각도가 맞다', () => {
    const small = /small: \{[\s\S]*?satellite: "([^"]+)"/.exec(WEB_MARK)![1]!;
    const ring = /small: \{[\s\S]*?ring: "([^"]+)"/.exec(WEB_MARK)![1]!;
    const sat = /M(-?[\d.]+) (-?[\d.]+)A([\d.]+) /.exec(small)!;
    const satCenter = {x: Number(sat[1]) - Number(sat[3]), y: Number(sat[2])};
    const holes = [...ring.matchAll(/M(-?[\d.]+) (-?[\d.]+)A([\d.]+) /g)];
    const hole = holes[holes.length - 1]!;
    const ringCenter = {x: Number(hole[1]) - Number(hole[3]), y: Number(hole[2])};
    const dx = satCenter.x - ringCenter.x;
    const dy = satCenter.y - ringCenter.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(OPTICAL.small.home, 1);
    expect(Number(sat[3])).toBe(OPTICAL.small.satelliteRadius);
    expect((Math.atan2(dy, dx) * 180) / Math.PI).toBeCloseTo(HOME_ANGLE, 5);
  });
});

// ---- 3. 컴포넌트 -------------------------------------------------------------------------

type LoopHandle = {start: jest.Mock; stop: jest.Mock; reset: jest.Mock};

/** `Animated.loop` 을 가짜로 바꿔 시작·정지를 센다. 감싼 timing 의 시계(Animated.Value)와 설정도 잡는다. */
function spyOnLoop() {
  const handles: LoopHandle[] = [];
  const timings: Array<{value: Animated.Value; config: Animated.TimingAnimationConfig}> = [];
  const realTiming = Animated.timing;
  jest
    .spyOn(Animated, 'timing')
    .mockImplementation((value, config) => {
      timings.push({value: value as Animated.Value, config: config as Animated.TimingAnimationConfig});
      return realTiming(value, config);
    });
  jest.spyOn(Animated, 'loop').mockImplementation(() => {
    const handle: LoopHandle = {start: jest.fn(), stop: jest.fn(), reset: jest.fn()};
    handles.push(handle);
    return handle as never;
  });
  return {handles, timings};
}

/** 시작됐고 아직 멈추지 않은 반복. */
const live = (handles: LoopHandle[]) =>
  handles.filter(h => h.start.mock.calls.length > 0 && h.stop.mock.calls.length === 0);

function reduceMotion(value: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(value);
}

/** `useReduceMotion` 의 첫 답(비동기)을 흘려보낸다. 이것을 빼면 첫 상태(켜짐 취급)만 본다. */
async function settle() {
  await act(async () => {});
}

describe('컴포넌트 — 모양', () => {
  it.each([
    ['light', lightPalette],
    ['dark', darkPalette],
  ] as const)('%s: 링은 본문 잉크, 위성은 신호색(accent) 원이다', async (scheme, palette) => {
    reduceMotion(false);
    render(
      <FixedScheme scheme={scheme}>
        <OortLoader size={24} />
      </FixedScheme>,
    );
    await settle();
    const ring = screen.getByTestId('oort-loader-ring', HIDDEN);
    expect(flatten(ring.props.style).tintColor).toBe(palette.text);
    const satellite = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style);
    expect(satellite.backgroundColor).toBe(palette.accent);
    // 마크 정본: 위성 지름 = 무대의 20%(small, 24pt → 4.8pt), 원이다.
    expect(satellite.width).toBeCloseTo(4.8, 6);
    expect(satellite.height).toBeCloseTo(4.8, 6);
    expect(satellite.borderRadius).toBeCloseTo(2.4, 6);
  });

  it('링 색을 호출자가 바꿀 수 있다(위성은 그대로 신호색)', async () => {
    reduceMotion(false);
    render(<OortLoader color="#123456" />);
    await settle();
    expect(flatten(screen.getByTestId('oort-loader-ring', HIDDEN).props.style).tintColor).toBe(
      '#123456',
    );
  });

  it('무대는 정사각이고 링 래스터가 무대를 채운다', async () => {
    reduceMotion(false);
    render(<OortLoader size={40} />);
    await settle();
    expect(flatten(screen.getByTestId('oort-loader', HIDDEN).props.style)).toMatchObject({
      width: 40,
      height: 40,
    });
    expect(flatten(screen.getByTestId('oort-loader-ring', HIDDEN).props.style)).toMatchObject({
      width: 40,
      height: 40,
    });
  });

  it('32pt 이하는 small 래스터, 그보다 크면 display 래스터다', async () => {
    reduceMotion(false);
    const small = render(<OortLoader size={32} />);
    await settle();
    const smallSource = screen.getByTestId('oort-loader-ring', HIDDEN).props.source;
    expect(smallSource).toBe(require('../src/design/brand/oort-loader-ring-small.png'));
    small.unmount();
    render(<OortLoader size={33} />);
    await settle();
    const displaySource = screen.getByTestId('oort-loader-ring', HIDDEN).props.source;
    expect(displaySource).toBe(require('../src/design/brand/oort-loader-ring-display.png'));
    expect(displaySource).not.toBe(smallSource);
  });

  it('위성 층이 링보다 먼저 그려진다: 링이 위에 서서 위성이 꼬리 뒤로 지나간다', async () => {
    reduceMotion(false);
    render(<OortLoader size={24} />);
    await settle();
    const root = screen.getByTestId('oort-loader', HIDDEN);
    const order = root.children.map((child: string | {props: {testID?: string}}) =>
      typeof child === 'string' ? child : child.props.testID,
    );
    expect(order).toEqual(['oort-loader-satellite', 'oort-loader-ring']);
  });

  it('장식이다: 접근성 트리에서 숨는다(이름은 곁의 문장이 진다)', async () => {
    reduceMotion(false);
    render(<OortLoader />);
    await settle();
    const root = screen.getByTestId('oort-loader', HIDDEN);
    expect(root.props.accessible).toBe(false);
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
    // 기본 조회(숨은 것 제외)로는 아예 안 잡힌다.
    expect(screen.queryByTestId('oort-loader')).toBeNull();
  });

  it('꼬리 점은 40pt 부터, 움직임일 때만 선다', async () => {
    reduceMotion(false);
    const small = render(<OortLoader size={24} />);
    await settle();
    expect(screen.queryByTestId('oort-loader-trail-0', HIDDEN)).toBeNull();
    small.unmount();

    const big = render(<OortLoader size={56} />);
    await settle();
    expect(screen.getByTestId('oort-loader-trail-0', HIDDEN)).toBeTruthy();
    expect(screen.getByTestId('oort-loader-trail-1', HIDDEN)).toBeTruthy();
    // 뒤로 갈수록 작다.
    const near = flatten(screen.getByTestId('oort-loader-trail-0', HIDDEN).props.style).width as number;
    const far = flatten(screen.getByTestId('oort-loader-trail-1', HIDDEN).props.style).width as number;
    const head = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style).width as number;
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThan(head);
    big.unmount();

    // 정지·동작 줄이기에서는 꼬리가 없다.
    render(<OortLoader size={56} still />);
    await settle();
    expect(screen.queryByTestId('oort-loader-trail-0', HIDDEN)).toBeNull();
  });
});

describe('컴포넌트 — 세 갈래와 반복', () => {
  it('움직임: 살아 있는 반복이 하나이고, 한 주기 1.8초 선형 시계를 네이티브 드라이버로 돈다', async () => {
    reduceMotion(false);
    const {handles, timings} = spyOnLoop();
    render(<OortLoader />);
    await settle();
    expect(live(handles)).toHaveLength(1);
    expect(live(handles)[0]!.start).toHaveBeenCalledTimes(1);
    expect(timings.at(-1)!.config).toMatchObject({
      toValue: 1,
      duration: LOADER_PERIOD_MS,
      useNativeDriver: true,
    });
  });

  it('동작 줄이기 첫 답이 늦게 와 모드가 숨에서 돎으로 바뀌면 바디가 갈린다: 앞 반복이 멈추고 새 반복이 선다', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    render(<OortLoader />);
    // 첫 답 전: 켜진 것으로 보고 투명도 숨의 반복이 선다.
    expect(handles).toHaveLength(1);
    expect(handles[0]!.start).toHaveBeenCalledTimes(1);
    await settle();
    // 답(꺼짐) 뒤: 앞 반복은 멈추고 새 바디의 반복이 하나 선다. 같은 그래프를 갈아타지 않는다.
    expect(handles).toHaveLength(2);
    expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
    expect(handles[1]!.start).toHaveBeenCalledTimes(1);
    expect(handles[1]!.stop).not.toHaveBeenCalled();
  });

  it('언마운트하면 살아 있던 반복이 멈춘다 (시작한 그 반복을 한 번)', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    const view = render(<OortLoader />);
    await settle();
    const running = live(handles)[0]!;
    expect(running.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(live(handles)).toHaveLength(0);
  });

  it('여러 번 다시 그려도 반복은 하나다: 같은 모드에서는 다시 시작하지 않는다', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    const view = render(<OortLoader size={24} />);
    await settle();
    const before = handles.length;
    view.rerender(<OortLoader size={24} />);
    await settle();
    view.rerender(<OortLoader size={24} testID="oort-loader" />);
    await settle();
    expect(handles).toHaveLength(before);
    expect(live(handles)).toHaveLength(1);
  });

  it('정지(still): 반복이 시작되지 않고 위성은 홈에 선다', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    render(<OortLoader still />);
    await settle();
    expect(handles).toHaveLength(0);
    const satellite = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style);
    expect(satellite.transform).toEqual([
      {rotate: '-45deg'},
      {translateX: expect.closeTo((OPTICAL.small.home / OPTICAL.small.units) * 24, 5)},
    ]);
    // 투명도도 1 그대로다.
    expect(flatten(screen.getByTestId('oort-loader', HIDDEN).props.style).opacity).toBe(1);
  });

  it('동작 줄이기: 반복(투명도 숨)은 돌지만 위성은 홈에 선 채이고 꼬리가 없다', async () => {
    reduceMotion(true);
    const {handles, timings} = spyOnLoop();
    render(<OortLoader size={56} />);
    await settle();
    expect(handles).toHaveLength(1);
    expect(live(handles)).toHaveLength(1);
    expect(screen.queryByTestId('oort-loader-trail-0', HIDDEN)).toBeNull();
    // 시계를 중간으로 옮겨도 위성의 자세는 홈이다(투명도만 시계를 읽는다).
    act(() => timings.at(-1)!.value.setValue(0.5));
    const satellite = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style);
    expect((satellite.transform as Array<Record<string, unknown>>)[0]).toEqual({rotate: '-45deg'});
    expect(flatten(screen.getByTestId('oort-loader', HIDDEN).props.style).opacity).toBeCloseTo(0.5, 6);
  });

  it('움직임: 시계를 옮기면 위성이 돌고 링이 숨 쉰다(투명도는 그대로 1)', async () => {
    reduceMotion(false);
    const {timings} = spyOnLoop();
    render(<OortLoader size={24} />);
    await settle();
    const clock = timings.at(-1)!.value;
    act(() => clock.setValue(PHASE.popEnd));
    const popped = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style);
    const out = (OPTICAL.small.out / OPTICAL.small.units) * 24;
    expect((popped.transform as Array<Record<string, number>>)[1]).toEqual({translateX: expect.closeTo(out, 4)});
    act(() => clock.setValue(0.5));
    const spinning = flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style);
    const angle = parseFloat(((spinning.transform as Array<Record<string, string>>)[0]!).rotate!);
    expect(angle).toBeGreaterThan(-45);
    expect(angle).toBeLessThan(315);
    expect(flatten(screen.getByTestId('oort-loader', HIDDEN).props.style).opacity).toBe(1);
    act(() => clock.setValue(PHASE.ringPeak));
    const ring = flatten(screen.getByTestId('oort-loader-ring', HIDDEN).props.style);
    expect((ring.transform as Array<Record<string, number>>)[0]!.scale).toBeCloseTo(1.05, 5);
  });
});

describe('컴포넌트 — 당김(progress) · #3962 가 쓴다', () => {
  it('progress 만 주면 돌지 않고 거리에 따라 위성이 튀어나온다 (0 홈, 1 궤도)', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    const progress = new Animated.Value(0);
    render(<OortLoader size={40} progress={progress} />);
    await settle();
    expect(handles).toHaveLength(0);
    const readX = () =>
      ((flatten(screen.getByTestId('oort-loader-satellite', HIDDEN).props.style).transform as Array<
        Record<string, number>
      >)[1]!).translateX!;
    const {units, home, out} = OPTICAL.display;
    expect(readX()).toBeCloseTo((home / units) * 40, 4);
    act(() => progress.setValue(1));
    expect(readX()).toBeCloseTo((out / units) * 40, 4);
    act(() => progress.setValue(0.5));
    const mid = readX();
    expect(mid).toBeGreaterThan((home / units) * 40);
    expect(mid).toBeLessThan((out / units) * 40);
    // 당긴 것보다 더 당겨도 궤도 밖으로 나가지 않는다.
    act(() => progress.setValue(3));
    expect(readX()).toBeCloseTo((out / units) * 40, 4);
  });

  it('spinning 이 켜지면 당긴 자세(14%)에서 이어 돈다: 시작 위상 14%, 한 주기 뒤 114%', async () => {
    reduceMotion(false);
    const {handles, timings} = spyOnLoop();
    const progress = new Animated.Value(1);
    const view = render(<OortLoader size={40} progress={progress} />);
    await settle();
    expect(handles).toHaveLength(0);
    view.rerender(<OortLoader size={40} progress={progress} spinning />);
    await settle();
    expect(live(handles)).toHaveLength(1);
    expect(live(handles)[0]!.start).toHaveBeenCalledTimes(1);
    const resumed = timings.at(-1)!;
    expect(resumed.config.toValue).toBeCloseTo(PHASE.popEnd + 1, 6);
    expect((resumed.value as unknown as {_value: number})._value).toBeCloseTo(PHASE.popEnd, 6);
  });

  it('당김에서 돌던 로더를 놓으면(spinning 해제) 반복이 멈춘다', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    const progress = new Animated.Value(1);
    const view = render(<OortLoader size={40} progress={progress} spinning />);
    await settle();
    expect(live(handles)).toHaveLength(1);
    view.rerender(<OortLoader size={40} progress={progress} />);
    await settle();
    expect(live(handles)).toHaveLength(0);
  });
});

// ---- 3b. 배선: 연결 띠와 첫 로딩 ---------------------------------------------------------

describe('배선 — 연결 띠(대화 머리)와 첫 로딩(Booting)', () => {
  const header = (railStatus: 'connected' | 'connecting' | 'disconnected') =>
    render(
      <ConversationHeader
        title="agent-lab"
        kind="public"
        directory={makeDirectory([])}
        onBack={() => {}}
        menu={[]}
        railStatus={railStatus}
      />,
    );

  it.each(['connecting', 'disconnected'] as const)(
    '연결 띠(%s): 문장은 그대로이고 곁에서 로더가 돈다 — 옛 8pt 점은 없다',
    async status => {
      reduceMotion(false);
      const {handles} = spyOnLoop();
      header(status);
      await settle();
      const banner = screen.getByTestId('connection-banner');
      expect(banner).toHaveTextContent(connectionBannerText(status) as string);
      const loader = screen.getByTestId('connection-loader', HIDDEN);
      expect(loader).toBeTruthy();
      // 띠 안에 있고, 20pt 정사각이다.
      expect(flatten(loader.props.style)).toMatchObject({width: 20, height: 20});
      expect(live(handles)).toHaveLength(1);
    },
  );

  it('기기가 오프라인이면(NetInfo) 같은 마크가 멈춘다 — 웹 browser-offline 과 같은 규칙, 문장은 그대로', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    header('disconnected');
    await settle();
    expect(live(handles)).toHaveLength(1);
    act(() => {
      (NetInfo as unknown as {__emit: (state: unknown) => void}).__emit({
        isConnected: false,
        isInternetReachable: false,
      });
    });
    await settle();
    // 도는 반복은 멈췄고(정지), 띠의 문장은 그대로다.
    expect(live(handles)).toHaveLength(0);
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('연결이 끊겼습니다');
    const satellite = flatten(screen.getByTestId('connection-loader-satellite', HIDDEN).props.style);
    expect((satellite.transform as Array<Record<string, unknown>>)[0]).toEqual({rotate: '-45deg'});
    // 다시 온라인이면 다시 돈다.
    act(() => {
      (NetInfo as unknown as {__emit: (state: unknown) => void}).__emit({
        isConnected: true,
        isInternetReachable: true,
      });
    });
    await settle();
    expect(live(handles)).toHaveLength(1);
  });

  it('연결됐으면 띠도 로더도 없다', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    header('connected');
    await settle();
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.queryByTestId('connection-loader', HIDDEN)).toBeNull();
    expect(handles).toHaveLength(0);
  });

  it('연결되면 띠가 사라지면서 로더의 반복이 멈춘다(떠 있는 반복이 남지 않는다)', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    const view = header('connecting');
    await settle();
    expect(live(handles)).toHaveLength(1);
    view.rerender(
      <ConversationHeader
        title="agent-lab"
        kind="public"
        directory={makeDirectory([])}
        onBack={() => {}}
        menu={[]}
        railStatus="connected"
      />,
    );
    await settle();
    expect(live(handles)).toHaveLength(0);
  });

  it('첫 로딩(Booting): 로더가 서고(56pt, 꼬리 점 포함), 문장·testID 는 그대로다', async () => {
    reduceMotion(false);
    spyOnLoop();
    render(
      <FixedScheme scheme="light">
        <Booting label="로그인 상태를 확인하는 중입니다." testID="session-restoring" />
      </FixedScheme>,
    );
    await settle();
    expect(screen.getByTestId('session-restoring')).toBeTruthy();
    expect(screen.getByText('로그인 상태를 확인하는 중입니다.')).toBeTruthy();
    const loader = screen.getByTestId('boot-loader', HIDDEN);
    expect(flatten(loader.props.style)).toMatchObject({width: 56, height: 56});
    expect(screen.getByTestId('boot-loader-trail-0', HIDDEN)).toBeTruthy();
  });

  it('다시 시도 화면(서버에 못 닿음)에는 돌 것이 없다: 로더 대신 버튼', async () => {
    reduceMotion(false);
    const {handles} = spyOnLoop();
    render(
      <FixedScheme scheme="light">
        <Booting label="서버에 닿지 못했습니다." onRetry={() => {}} testID="session-unreachable" />
      </FixedScheme>,
    );
    await settle();
    expect(screen.queryByTestId('boot-loader', HIDDEN)).toBeNull();
    expect(screen.getByTestId('restore-retry')).toBeTruthy();
    expect(handles).toHaveLength(0);
  });

  it('로그인 전 첫 화면(booting): 라벨 없이 로더만 선다', async () => {
    reduceMotion(false);
    spyOnLoop();
    render(
      <FixedScheme scheme="dark">
        <Booting testID="booting" />
      </FixedScheme>,
    );
    await settle();
    expect(screen.getByTestId('booting')).toBeTruthy();
    expect(screen.getByTestId('boot-loader', HIDDEN)).toBeTruthy();
  });
});

// ---- 4. 래스터 ----------------------------------------------------------------------------

describe('링 래스터 여섯 장', () => {
  const dir = path.join(__dirname, '../src/design/brand');
  /** IHDR 의 가로·세로(PNG 머리 8바이트 + 청크 길이/이름 8바이트 뒤). */
  const size = (file: string) => {
    const buf = fs.readFileSync(path.join(dir, file));
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    return {w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25]};
  };

  it.each([
    ['small', 32],
    ['display', 64],
  ] as const)('%s: 1·2·3배가 설계 크기 %ipt 의 정확히 1·2·3배고 정사각이다', (name, base) => {
    for (const [suffix, scale] of [
      ['', 1],
      ['@2x', 2],
      ['@3x', 3],
    ] as const) {
      expect(size(`oort-loader-ring-${name}${suffix}.png`)).toEqual({
        w: base * scale,
        h: base * scale,
        colorType: 6, // RGBA
      });
    }
  });

  it('마크 정본의 링 path 가 바뀌면 빨개진다: 래스터를 다시 떠서 이 해시를 고친다', () => {
    const ring = (optical: string) =>
      new RegExp(`${optical}: \\{[\\s\\S]*?ring: "([^"]+)"`).exec(WEB_MARK)![1]!;
    const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
    // 이 두 값은 래스터를 뜬 정본 path 의 지문이다(위 머리말의 다시 만드는 법).
    expect([sha(ring('small')), sha(ring('display'))]).toEqual([
      'bae9abe124c76b1e',
      'b8d3194cf7b2e3bf',
    ]);
  });
});
