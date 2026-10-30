import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {AccessibilityInfo, AppState, Animated, Platform, FlatList, LayoutAnimation, StyleSheet, Text} from 'react-native';

import {ApiError} from '@momo/core/lib/api';
import {onlineManager, QueryClient, QueryClientProvider, QueryObserver} from '@tanstack/react-query';
import {withPullScroll, usePullRefresh} from '../src/design/refresh';
import {haptics, hapticScope, getHapticMode, setHapticMode, type HapticEvent} from '../src/lib/haptics';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';
import {invalidateAndReport} from '../src/query/invalidateReport';
import {PULL_FILL, PULL_TRIGGER} from '../src/design/pullRefresh';
import {HOME_ANGLE, OPTICAL, PHASE, SCRUB_FILL_MIN} from '../src/design/brand/oortLoaderTimeline';
import {EmptyState} from '../src/design/atoms';
import {FixedScheme} from '../src/design/theme';
import {lightPalette} from '../src/design/tokens';

// =============================================================================
// 당겨서 새로고침 + 햅틱 (#3962) + 실패 안내의 지속과 궤도 당김 (#3992). `usePullRefresh` 가 표준 `RefreshControl`(역학) 위에 얹는 것:
//   · 당기는 동안 목록 위 넘친 자리에 오르트 로더 머리가 서고(위성이 당긴 만큼 궤도를 돈다), 새로고침이 서면 당긴 자세에서 이어 돈다
//   · 임계 통과의 가벼운 햅틱 1회: 표준 컨트롤이 새로고침을 세우는 순간(`onRefresh`)에 낸다. 이 컨트롤은
//     손가락이 닿은 채로 임계를 넘는 순간 `onRefresh` 를 부른다(iOS 26.5 시뮬레이터에서 잰 것). 한 번의
//     새로고침에 한 번이고, 스크롤 이벤트로는 울리지 않는다(`lib/haptics.ts` 계약)
//   · 기본은 기존 success/warning, 풍부는 성공 무음·실패 warning. 실패하면 「새로고침하지 못했어요. 다시 당겨 보세요.」 한 줄이 목록 위에 서고
//     **시간으로 사라지지 않는다**: 다음 당김이 서거나, 실패한 쿼리가 다시 읽히거나, 화면을 떠날 때까지 남는다
//   · 시스템 스피너를 감췄으므로 「새로고침 중」을 접근성으로 낭독하고 머리가 이름을 진다
//   · 실제 재조회(onRefresh)는 한 당김에 한 번이고, 끝나면 표시가 물러난다
//
// 햅틱은 `expo-haptics` 대역(`jest.setup.js`)이 **무엇을 몇 번 요청했는가**만 기록한다. 실제 진동의
// 세기·타이밍은 실기기에서만 잰다(PR 본문 「미검증」).
//
// red proof (이 파일이 지키는 것):
//   - 훅의 `haptics.light()` 를 지우면 → 「새로고침이 서는 순간 햅틱 한 번」이 붉다
//   - `busyRef` 가드를 지우면 → 「두 번 안 울림」과 「요청은 하나」가 붉다
//   - 스크롤 핸들러에서 햅틱을 부르면 → 「스크롤만으로는 울리지 않는다」가 붉다
//   - 완료 햅틱을 실패와 구분하지 않으면 → 「실패는 warning」이 붉다
//   - `announceForAccessibility` 를 지우면 → 「새로고침 중을 낭독한다」가 붉다
//   - 화면의 목록에서 `{...scrollProps}` 를 빼면 → 「모든 화면이 scrollProps 를 펼친다」(소스 스캔)가 붉다
//   - 머리를 음수 top 으로 되돌리면 → 「레이아웃은 내용 맨 위(top 0)이고 transform 으로 올린다」가 붉다
//   - 목록·빈 상태가 PULL_FILL 을 빠뜨리면 → 「빈 자리에서도 당겨진다」와 소스 스캔이 붉다
//   - 실패 안내에 고정 lineHeight 를 다시 넣으면 → 「실패 안내는 Dynamic Type 에 상한이 있고」가 붉다
//   - 돌아오는 동안의 래치(spun)를 지우면 → 「끝난 뒤 내용이 돌아오는 동안에도 위성은 계속 돈다」가 붉다
//   - 실패 안내에 1.6초 타이머를 되돌리면(#3992) → 「안내는 시간으로 사라지지 않는다」가 붉다
//   - 당김 시작(handleRefresh)이 안내를 거두지 않으면 → 「다음 당김이 서면 안내가 사라진다」가 붉다
//   - 성공 재조회 구독을 지우면 → 「실패한 쿼리가 다시 읽히면 안내가 사라진다」가 붉다
//   - 안내를 컨트롤이 닫히기 전에 세우면(기다림 제거) → 「컨트롤이 닫히기 전에는 안내가 서지 않는다」가 붉다
//   - 넘침을 보지 않고 세우면 → 「손가락이 잡고 있는 동안은 서지 않는다」가 붉다
//   - 걷을 때 틀을 바로 지우면(접지 않으면) → 「한 번에 지워지지 않고 잰 높이에서 0 으로 접힌다」가 붉다
//   - 다시 읽은 쿼리 대신 캐시 전체의 오류를 기다리면 → 「당김과 무관한 쿼리의 오류는 기다리지 않는다」가 붉다
//   - `active` 효과를 지우면 → 「화면을 떠나면 안내가 사라진다」가 붉다
//   - 당김의 각도 표를 상수로 바꾸면 → 「당김이 위성의 궤도 각도로 보인다」가 붉다
//   - 동작 줄이기의 당김에서 회전을 허용하면 → 「동작 줄이기: 당겨도 위성은 돌지 않는다」가 붉다
// =============================================================================

jest.useFakeTimers();

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  onlineManager.setOnline(true);
});

const HIDDEN = {includeHiddenElements: true} as const;
const flatten = (style: unknown) =>
  StyleSheet.flatten(style as never) as Record<string, unknown>;

const haptic = jest.requireMock('expo-haptics') as {__calls: string[]};
beforeEach(() => {
  haptic.__calls.length = 0;
  setHapticMode('rich');
  // 로더의 감소된 동작 훅은 초기값이 true 다. 시험 대역이 false 로 답하면 비동기 응답이 act 밖에서
  // 상태를 바꿔 소음이 된다. 움직이는 쪽을 보는 시험만 `reduceMotion(false)` 로 바꾸고 응답을 비운다.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

function Harness({
  onRefresh,
  empty = false,
  active,
  resetKey,
}: {
  onRefresh: () => Promise<unknown> | void;
  empty?: boolean;
  active?: boolean;
  resetKey?: unknown;
}): React.JSX.Element {
  const {refreshControl, scrollProps, notice} = usePullRefresh(onRefresh, 'harness-refresh', {
    active,
    resetKey,
  });
  // 화면이 하는 대로: 안내는 목록 바로 위, 레이아웃 안에 둔다.
  if (empty) {
    return (
      <>
        {notice}
        <EmptyState
          headline="비어 있어요."
          refreshControl={refreshControl}
          scrollProps={scrollProps}
          testID="harness-list"
        />
      </>
    );
  }
  return (
    <>
      {notice}
      <FlatList
        data={['a', 'b', 'c']}
        keyExtractor={item => item}
        renderItem={({item}) => <Text>{item}</Text>}
        refreshControl={refreshControl}
        {...scrollProps}
        testID="harness-list"
      />
    </>
  );
}

/** 실제 QueryClient 를 거는 하니스(훅이 캐시를 읽어 「성공 재조회」를 안다). */
function withClient(client: QueryClient, ui: React.ReactElement): React.JSX.Element {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** gcTime 무한: 기본 5분 가비지 타이머를 세우지 않는다. */
const newClient = () => new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}});

/** 관찰자가 붙은(활성) 쿼리. `state.ok` 를 바꾸면 다음 읽기가 성공하거나 실패한다. */
function controlledQuery(
  client: QueryClient,
  key: string,
  state: {ok: boolean; error?: Error},
): () => void {
  const observer = new QueryObserver(client, {
    queryKey: [key, 'ws'],
    queryFn: () => (state.ok ? Promise.resolve('data') : Promise.reject(state.error ?? new Error('down'))),
    retry: false,
  });
  return observer.subscribe(() => undefined);
}

/** 쿼리 읽기·알림(setTimeout 0)이 모두 흐르게 한다. */
async function queriesSettle() {
  await act(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    jest.advanceTimersByTime(0);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
}

function scrollEvent(y: number) {
  return {
    nativeEvent: {
      contentOffset: {x: 0, y},
      contentSize: {width: 320, height: 2000},
      layoutMeasurement: {width: 320, height: 600},
      velocity: {x: 0, y: 0},
    },
  };
}

const list = () => screen.getByTestId('harness-list');
const scrollTo = (y: number) => fireEvent.scroll(list(), scrollEvent(y));
const control = () => screen.getByTestId('harness-list').props.refreshControl as React.ReactElement<{
  onRefresh: () => void;
  refreshing: boolean;
}>;
const header = () => screen.queryByTestId('pull-refresh-header', HIDDEN);
const FAILED = '새로고침하지 못했어요. 다시 당겨 보세요.';
const OFFLINE = '연결이 없어요. 연결되면 다시 당겨 보세요.';
/** 목록 위의 실패 안내(레이아웃 안). 머리(로더 자리)의 것이 아니다. */
const notice = () => screen.queryByTestId('pull-refresh-notice', HIDDEN);
const impacts = () => haptic.__calls.filter(c => c.startsWith('impact:'));
const notifications = () => haptic.__calls.filter(c => c.startsWith('notification:'));

/** 놓았다: 새로고침을 시작한다(표준 컨트롤이 임계 너머에서 놓였을 때 부르는 것과 같은 입구). */
function release() {
  act(() => {
    control().props.onRefresh();
  });
}

/** 마이크로태스크를 비우고(재조회 약속이 풀리고 최소 표시 타이머가 서게) 시간을 ms 만큼 보낸다. */
async function flush(ms = 0) {
  const drain = async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  await act(async () => {
    await drain();
    jest.advanceTimersByTime(ms);
    await drain();
    // 방금 풀린 약속이 세운 0ms 타이머까지.
    jest.advanceTimersByTime(0);
    await drain();
  });
}

function reduceMotion(value: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(value);
}

/**
 * 실패한 당김이 끝나고 안내가 서기까지(ms), 넘치지 않은 목록 기준: 최소 표시 창 450 + 컨트롤이 닫히기를 기다림 350
 * (`NOTICE_FIRST_MS`) + 닫힘을 본 뒤 한 번 더 100(`NOTICE_POLL_MS`). 시험이 이 숫자를 따로 적어 두는 것은 의도다:
 * 훅의 상수가 바뀌면(특히 기다림이 사라지면) 「컨트롤이 닫히기 전에는 안내가 서지 않는다」가 붉어야 한다.
 */
const NOTICE_READY_MS = 450 + 350 + 100 + 20;

/**
 * 실패한 당김 하나를 안내가 설 때까지 보낸다: 최소 표시 창 → (넘쳐 있었다면 컨트롤이 닫히며 스크롤이 제자리로 돌아온다)
 * → 닫히기를 기다림 → 안내. `overscrolled` 는 목록이 넘친 채 당겨졌다는 뜻이다(`scrollTo(-임계)` 로 당긴 시험).
 */
async function runFailure(overscrolled = false) {
  await flush(460); // 새로고침이 끝난다(경고 햅틱)
  if (overscrolled) scrollTo(0); // 컨트롤이 닫히며 스크롤이 돌아온다
  await flush(NOTICE_READY_MS - 460);
}

describe('임계 햅틱 (표준 컨트롤이 새로고침을 세우는 순간)', () => {
  it('새로고침이 서는 순간 가벼운 햅틱 한 번 — 데이터가 오기 전, 같은 프레임에서', () => {
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    expect(impacts()).toEqual([]);
    release();
    expect(impacts()).toEqual(['impact:light']);
  });

  it('한 번의 새로고침에 한 번이다: 진행 중에 임계 신호가 또 와도 두 번 안 울린다', () => {
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release();
    release();
    release();
    expect(impacts()).toEqual(['impact:light']);
  });

  it('끝난 뒤의 새 당김은 새로 한 번 울린다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([])} />);
    release();
    await flush(500);
    release();
    expect(impacts()).toEqual(['impact:light', 'impact:light']);
    await flush(500);
  });

  it('스크롤 이벤트만으로는 울리지 않는다: 얼마를 당겨도 새로고침이 서지 않았으면 햅틱 0', () => {
    render(<Harness onRefresh={() => undefined} />);
    for (const y of [0, -30, -PULL_TRIGGER + 5, -PULL_TRIGGER - 40, -PULL_TRIGGER - 120, 0, 400]) scrollTo(y);
    expect(haptic.__calls).toEqual([]);
  });

  it('문턱만 울리고 성공은 무음이다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(haptic.__calls).toEqual(['impact:light']);
  });

  it('평소 스크롤(양수 오프셋)은 햅틱도 머리도 건드리지 않는다', () => {
    render(<Harness onRefresh={() => undefined} />);
    for (const y of [0, 40, 400, 1200]) scrollTo(y);
    expect(haptic.__calls).toEqual([]);
    expect(header()).toBeNull();
  });
});

describe('완료와 실패 햅틱', () => {
  it('재조회가 끝나 표시가 물러나도 성공 햅틱은 없다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(0);
    // 최소 표시 창(450ms) 안에서는 아직이다.
    expect(notifications()).toEqual([]);
    await flush(460);
    expect(notifications()).toEqual([]);
  });

  it('던진 재조회는 warning 이다(success 가 아니다)', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
  });

  it('던지지 않고 오류 결과로 답한 재조회(react-query refetch)도 warning 이다', async () => {
    render(<Harness onRefresh={() => Promise.resolve({isError: true, status: 'error'})} />);
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
  });

  it('묶음 재조회에서 하나라도 오류면 warning 이다', async () => {
    render(
      <Harness
        onRefresh={() => Promise.all([Promise.resolve({status: 'success'}), Promise.resolve({status: 'error'})])}
      />,
    );
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
  });

  it('결과를 모르는(void) 재조회는 실패라고 단정하지 않는다: 무음', async () => {
    render(<Harness onRefresh={() => undefined} />);
    release();
    await flush(500);
    expect(notifications()).toEqual([]);
  });

  it('끝나기 전에 화면이 닫히면 햅틱도 상태 갱신도 없다', async () => {
    const view = render(<Harness onRefresh={() => Promise.resolve([])} />);
    release();
    await flush(0);
    view.unmount();
    await flush(1000);
    expect(notifications()).toEqual([]);
  });
});

describe('실제 재조회와 표시', () => {
  it('당김 한 번 = 재조회 한 번, 진행 중에 또 당겨도 요청은 하나다', async () => {
    const onRefresh = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 600)));
    render(<Harness onRefresh={onRefresh} />);
    release();
    release();
    release();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await flush(700);
    // 끝난 뒤의 새 당김은 다시 부른다.
    release();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await flush(700);
  });

  it('표준 컨트롤은 시스템 스피너를 감춘다(투명 tint) — 그 자리는 로더 머리가 쓴다', () => {
    render(<Harness onRefresh={() => undefined} />);
    const props = control().props as unknown as {tintColor?: string};
    // 요소는 우리 컨트롤이고, 그 안의 표준 RefreshControl 이 투명 tint 를 받는다.
    expect(props).toBeDefined();
    const native = screen.UNSAFE_getByType(require('react-native').RefreshControl);
    expect(native.props.tintColor).toBe('transparent');
    expect(native.props.onRefresh).toBe(control().props.onRefresh);
  });

  it('머리는 넘칠 때만 선다: 넘기면 마운트, 제자리로 돌아오면 걷힌다', () => {
    render(<Harness onRefresh={() => undefined} />);
    expect(header()).toBeNull();
    scrollTo(-12);
    expect(header()).not.toBeNull();
    scrollTo(0);
    expect(header()).toBeNull();
  });

  it('머리는 목록 위로 넘친 자리에 서되, 레이아웃은 내용 맨 위(top 0)이고 transform 으로 올린다', () => {
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-10);
    const style = flatten(screen.getByTestId('pull-refresh-header', HIDDEN).props.style);
    expect(style.position).toBe('absolute');
    // 음수 top 은 내용 경계 상자 원점을 음수로 만들어 UIRefreshControl 이 손놓은 뒤 자리를 붙들지 못한다
    // (iOS 26.5 시뮬레이터 실측, refresh.tsx `layout.header`). 레이아웃에 안 들어가는 transform 으로만 올린다.
    expect(style.top).toBe(0);
    const lift = (style.transform as Array<Record<string, number>>).find(t => 'translateY' in t);
    expect(lift!.translateY).toBe(-(style.height as number));
  });

  /** 머리의 로더가 그린 위성의 자세: 각도(도)와 중심 거리(pt). */
  const satellitePose = () => {
    const transform = flatten(screen.getByTestId('pull-refresh-loader-satellite', HIDDEN).props.style)
      .transform as Array<Record<string, string | number>>;
    return {angle: parseFloat(String(transform[0]!.rotate)), radial: transform[1]!.translateX as number};
  };
  const loaderOpacity = () => flatten(screen.getByTestId('pull-refresh-loader', HIDDEN).props.style).opacity as number;

  it('당김이 위성의 궤도 각도로 보인다: 25·50·75·100% 가 홈에서 90° 씩 돌아간 자리다', async () => {
    reduceMotion(false);
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-1);
    await flush(0); // 머리가 서고 감소된 동작 응답(false)이 도착한다
    const {units, home, out} = OPTICAL.display;
    const size = 40;
    scrollTo(-0.5);
    expect(satellitePose().radial).toBeGreaterThanOrEqual((home / units) * size - 1e-6);
    const spots: Array<{x: number; y: number}> = [];
    for (const p of [0.25, 0.5, 0.75, 1]) {
      scrollTo(-PULL_TRIGGER * p);
      const {angle, radial} = satellitePose();
      expect(angle).toBeCloseTo(HOME_ANGLE + 360 * p, 3);
      expect(radial).toBeCloseTo((out / units) * size, 3); // 궤도 위에서 돈다(링을 긁지 않는다)
      const rad = (angle * Math.PI) / 180;
      spots.push({x: radial * Math.cos(rad), y: radial * Math.sin(rad)});
    }
    // 어느 두 진행도도 위성이 20pt 이상 떨어진 자리에 있다(지름 7pt 의 약 3배): 손가락 아래에서 눈이 구분한다.
    for (let i = 0; i < spots.length; i += 1) {
      for (let j = i + 1; j < spots.length; j += 1) {
        expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThan(20);
      }
    }
    // 임계 너머로 더 당겨도 한 바퀴를 넘지 않는다.
    scrollTo(-PULL_TRIGGER * 2);
    expect(satellitePose().angle).toBeCloseTo(HOME_ANGLE + 360, 3);
    // 손가락을 되돌리면 위성이 거꾸로 감겨 돌아간다(진행도를 그대로 따른다).
    scrollTo(-PULL_TRIGGER * 0.25);
    expect(satellitePose().angle).toBeCloseTo(HOME_ANGLE + 90, 3);
  });

  it('동작 줄이기: 당겨도 위성은 돌지 않는다 — 홈에 꽂힌 채 투명도만 차오른다', async () => {
    reduceMotion(true);
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-1);
    await flush(0);
    const {units, home} = OPTICAL.display;
    const seen: number[] = [];
    for (const p of [0.25, 0.5, 0.75, 1, 2]) {
      scrollTo(-PULL_TRIGGER * p);
      const {angle, radial} = satellitePose();
      expect(angle).toBe(HOME_ANGLE); // 회전이 없다
      expect(radial).toBeCloseTo((home / units) * 40, 3); // 이동도 없다
      seen.push(loaderOpacity());
    }
    expect(seen.slice(0, 4)).toEqual([0.4, 0.6, 0.8, 1].map(v => expect.closeTo(v, 5)));
    expect(seen[4]).toBeCloseTo(1, 5);
    expect(SCRUB_FILL_MIN).toBe(0.2);
  });

  it('손가락이 닿은 채 임계를 넘으면 위성은 한 바퀴를 다 돌아 이어 돌 자세(홈 각도, 궤도)에 서 있다', async () => {
    reduceMotion(false);
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    scrollTo(-1);
    await flush(0);
    scrollTo(-PULL_TRIGGER);
    const before = satellitePose();
    release(); // 임계에서 컨트롤이 새로고침을 세운다
    await flush(0);
    const after = satellitePose();
    expect(after.radial).toBeCloseTo(before.radial, 3);
    expect((((after.angle - before.angle) % 360) + 360) % 360).toBeCloseTo(0, 3);
  });

  it('놓으면 당긴 자세(14%)에서 이어 돈다: 로더 반복이 하나 서고 시작 위상이 14% 다', async () => {
    reduceMotion(false);
    const timings: Array<{value: Animated.Value; toValue: number}> = [];
    const realTiming = Animated.timing;
    jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
      timings.push({value: value as Animated.Value, toValue: (config as {toValue: number}).toValue});
      return realTiming(value, config);
    });
    const loops: Array<{start: jest.Mock; stop: jest.Mock}> = [];
    jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const handle = {start: jest.fn(), stop: jest.fn(), reset: jest.fn()};
      loops.push(handle);
      return handle as never;
    });
    render(
      <FixedScheme scheme="light">
        <Harness onRefresh={() => new Promise(() => undefined)} />
      </FixedScheme>,
    );
    scrollTo(-PULL_TRIGGER - 5);
    await flush(0);
    expect(loops).toHaveLength(0); // 당기는 동안은 돌지 않는다
    release();
    await flush(0);
    const live = loops.filter(h => h.start.mock.calls.length > 0 && h.stop.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(timings.at(-1)!.toValue).toBeCloseTo(PHASE.popEnd + 1, 6);
  });

  it('끝난 뒤 내용이 돌아오는 동안에도 위성은 계속 돈다(당김 자세로 튀어 돌아가지 않는다)', async () => {
    reduceMotion(false);
    const loops: Array<{start: jest.Mock; stop: jest.Mock}> = [];
    jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const handle = {start: jest.fn(), stop: jest.fn(), reset: jest.fn()};
      loops.push(handle);
      return handle as never;
    });
    render(<Harness onRefresh={() => Promise.resolve([])} />);
    scrollTo(-PULL_TRIGGER - 5);
    await flush(0);
    release();
    await flush(500); // 새로고침이 끝났다
    scrollTo(-40); // 내용이 돌아오는 중: 오프셋이 줄어 진행도가 내려간다
    await flush(0);
    const live = loops.filter(h => h.start.mock.calls.length > 0 && h.stop.mock.calls.length === 0);
    expect(live).toHaveLength(1);
  });

  it('끝나면 머리가 물러난다: 최소 표시 뒤 새로고침이 끝나고 내용이 돌아오면 사라진다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([])} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    expect(header()).not.toBeNull();
    await flush(500);
    // 표준 컨트롤이 열어 둔 자리에 머문 채 끝났다: 아직 넘쳐 있으면 내용과 함께 올라간다.
    scrollTo(-30);
    expect(header()).not.toBeNull();
    scrollTo(0);
    expect(header()).toBeNull();
  });

  it('스크롤 이벤트가 안 오는 목록(펼침을 빠뜨린 곳)도 끝나면 머리가 걷힌다', async () => {
    function Bare() {
      const {refreshControl} = usePullRefresh(() => Promise.resolve([]), 'bare-refresh');
      return <FlatList data={['a']} renderItem={() => <Text>a</Text>} refreshControl={refreshControl} testID="bare" />;
    }
    render(<Bare />);
    const control_ = screen.getByTestId('bare').props.refreshControl as React.ReactElement<{onRefresh: () => void}>;
    act(() => control_.props.onRefresh());
    expect(screen.queryByTestId('pull-refresh-header', HIDDEN)).not.toBeNull();
    await flush(600);
    expect(screen.queryByTestId('pull-refresh-header', HIDDEN)).toBeNull();
  });
});

describe('실패는 시각으로도 서고, 시간으로 사라지지 않는다 (#3992)', () => {
  it('실패하면 목록 위에 안내 한 줄이 선다: 경고 햅틱은 응답이 도착한 순간, 안내와 낭독은 컨트롤이 닫힌 뒤', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    render(<Harness onRefresh={() => Promise.resolve([{status: 'error', isError: true}])} />);
    release();
    await flush(0);
    // 최소 표시 창 안에서는 아직 로더다.
    expect(notice()).toBeNull();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).not.toBeNull();
    await flush(460);
    // 응답이 손에 닿는다: 경고 햅틱과 낭독. 안내 상자는 아직이다(컨트롤이 닫히는 중이다).
    expect(notifications()).toEqual(['notification:warning']);
    expect(announce).not.toHaveBeenCalledWith(FAILED); // 낭독은 안내가 서는 커밋과 같이 나간다
    expect(notice()).toBeNull();
    await flush(NOTICE_READY_MS - 460);
    expect(notice()).not.toBeNull();
    expect(announce).toHaveBeenLastCalledWith(FAILED);
    expect(announce.mock.calls.filter(c => c[0] === FAILED)).toHaveLength(1); // 낭독은 한 번
    // 문구는 오너 확정 그대로다(2026-10-17).
    expect(screen.getByText(FAILED, HIDDEN)).toBeTruthy();
  });

  it('컨트롤이 닫히기 전에는 안내가 서지 않는다: 닫히는 시간(350ms)이 지나기 전에는 상자가 없다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await flush(460);
    for (const ms of [100, 100, 100]) {
      await flush(ms);
      expect(notice()).toBeNull(); // 560, 660, 760
    }
    await flush(NOTICE_READY_MS - 760);
    expect(notice()).not.toBeNull();
  });

  it('손가락이 잡고 있는 동안은 서지 않는다: 스크롤이 넘침에서 돌아온 뒤 한 박자 쉬고 선다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await flush(460);
    await flush(2_050); // 손가락이 아직 잡고 있다(컨트롤은 손가락이 떨어져야 닫힌다). 확인은 100ms 마다 돌고 있다
    expect(notice()).toBeNull();
    expect(control().props.refreshing).toBe(false); // 새로고침은 끝났다: 안내만 기다린다
    scrollTo(0); // 놓았고 컨트롤이 닫혔다
    await flush(50);
    expect(notice()).toBeNull(); // 다음 확인까지
    await flush(100);
    expect(notice()).toBeNull(); // 닫힘을 한 번 봤다: 한 번 더 쉰다
    await flush(100);
    expect(notice()).not.toBeNull();
  });

  it('손가락이 3초가 지나도 놓지 않으면 안내는 그냥 선다(보이지 않는 실패가 영영 서지 않는 것이 더 나쁘다)', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await flush(460);
    await flush(2_900);
    expect(notice()).toBeNull();
    await flush(300);
    expect(notice()).not.toBeNull();
  });

  it('안내를 기다리는 동안 다음 당김이 서면 기다리던 안내는 취소된다: 옛 실패가 뒤늦게 서지 않는다', async () => {
    const results = [Promise.reject(new Error('boom')), new Promise(() => undefined)];
    const onRefresh = jest.fn(() => results.shift() as Promise<unknown>);
    render(<Harness onRefresh={onRefresh} />);
    release();
    await flush(460);
    await flush(200); // 컨트롤이 닫히기를 기다리는 중
    expect(notice()).toBeNull();
    release(); // 새 당김이 선다(진행 중이 아니므로 받아들여진다)
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await flush(5_000);
    expect(notice()).toBeNull(); // 옛 실패는 서지 않는다
    expect(control().props.refreshing).toBe(true);
  });

  it('실패 안내는 머리(로더가 서는 자리)의 것이 아니다: 머리는 실패 중에도 로더만 그리고, 안내는 따로 선다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await flush(460); // 실패했다. 컨트롤은 아직 열려 있다(넘친 채): 머리가 서 있다
    const head = screen.getByTestId('pull-refresh-header', HIDDEN);
    expect(within(head).queryByText(FAILED, HIDDEN)).toBeNull();
    expect(within(head).queryByTestId('pull-refresh-failed', HIDDEN)).toBeNull();
    expect(within(head).queryByTestId('pull-refresh-loader', HIDDEN)).not.toBeNull();
    // 머리의 이름은 「새로고침 중」 하나다(실패는 안내가 진다).
    expect(head.props.accessibilityRole).toBe('progressbar');
    expect(notice()).toBeNull();
    // 컨트롤이 닫히면 머리가 걷히고, 안내가 목록 위에 선다.
    await flush(NOTICE_READY_MS - 460);
    scrollTo(0);
    await flush(300);
    expect(header()).toBeNull();
    expect(notice()).not.toBeNull();
  });

  it('성공하면 실패 안내가 서지 않는다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(notice()).toBeNull();
    expect(notifications()).toEqual([]);
  });

  it('실패하면 새로고침이 끝난다: 컨트롤이 닫혀(refreshing 거짓) 안내가 떠 있어도 다음 당김이 선다', async () => {
    const onRefresh = jest.fn(() => Promise.reject(new Error('boom')));
    render(<Harness onRefresh={onRefresh} />);
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    // 옛 판은 안내가 머리에 머무느라 컨트롤을 1.6초 열어 두었고 그동안 새 당김이 막혔다.
    expect(control().props.refreshing).toBe(false);
    release();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await flush(0);
  });

  it('안내는 시간으로 사라지지 않는다: 1.6초가 한참 지나도(10초, 1분) 서 있다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    for (const ms of [1_700, 10_000, 60_000]) {
      await flush(ms);
      expect(notice()).not.toBeNull();
      expect(screen.getByText(FAILED, HIDDEN)).toBeTruthy();
      expect(control().props.refreshing).toBe(false);
    }
  });

  it('다음 당김이 서면(onRefresh) 안내가 사라지고, 로더가 안내 없이 새로 시작한다', async () => {
    const results = [Promise.reject(new Error('boom')), new Promise(() => undefined)];
    const onRefresh = jest.fn(() => results.shift() as Promise<unknown>);
    render(<Harness onRefresh={onRefresh} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await runFailure(true);
    expect(notice()).not.toBeNull();
    await flush(5_000);
    expect(notice()).not.toBeNull(); // 아직 서 있다
    scrollTo(0);
    scrollTo(-PULL_TRIGGER - 5);
    release(); // 새 당김
    expect(notice()).toBeNull();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).not.toBeNull();
    expect(control().props.refreshing).toBe(true);
  });

  it('손가락만 대고 임계 전에 놓은 당김은 안내를 거두지 않는다(새로고침이 서지 않았다)', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    for (const y of [-10, -60, -PULL_TRIGGER + 20, -30, 0]) scrollTo(y);
    expect(notice()).not.toBeNull();
  });

  it('목록 스크롤(내용이 제자리로 돌아와도)이 안내를 거두지 않는다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await runFailure(true);
    scrollTo(-30);
    scrollTo(0);
    scrollTo(400);
    scrollTo(0);
    await flush(5_000);
    expect(notice()).not.toBeNull();
  });

  it('안내는 Dynamic Type 에 줄 높이가 묶이지 않고, 한글은 어절 단위로 줄바꿈한다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await runFailure();
    const text = screen.getByTestId('pull-refresh-failed', HIDDEN);
    // 줄 높이를 고정하지 않는다: 글자가 커져도 줄이 겹치거나 잘리지 않고 글자 크기를 따른다.
    expect(flatten(text.props.style).lineHeight).toBeUndefined();
    expect(text.props.lineBreakStrategyIOS).toBe('hangul-word');
    // 줄 수를 막지 않는다: 안내는 레이아웃 안에 서서 필요한 만큼 접힌다(머리의 64pt 에 갇히지 않는다).
    expect(text.props.numberOfLines).toBeUndefined();
  });

  it('안내의 접근성: alert 역할, 이름은 안내 문장 그대로', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await runFailure();
    const node = screen.getByTestId('pull-refresh-notice', HIDDEN);
    expect(node.props.accessible).toBe(true);
    expect(node.props.accessibilityRole).toBe('alert');
    expect(node.props.accessibilityLabel).toBe(FAILED);
  });

  it('모양은 지속 실패 배너(FailureBanner)와 같은 어휘다: 바탕·테두리·글자가 danger 계열 토큰이다', async () => {
    render(
      <FixedScheme scheme="light">
        <Harness onRefresh={() => Promise.reject(new Error('boom'))} />
      </FixedScheme>,
    );
    release();
    await runFailure();
    const palette = lightPalette;
    const text = screen.getByTestId('pull-refresh-failed', HIDDEN);
    expect(flatten(text.props.style).color).toBe(palette.dangerText);
    // 글자의 바로 바깥 상자가 안내 상자다.
    const box = flatten(screen.UNSAFE_getByProps({testID: 'pull-refresh-failed'}).parent!.props.style);
    expect(box.backgroundColor).toBe(palette.dangerSurface);
    expect(box.borderColor).toBe(palette.dangerBorder);
  });

  describe('성공 재조회 — 실패한 쿼리가 다시 읽히면 안내는 거짓이 되어 사라진다', () => {
    /** 실패한 쿼리 하나를 가진 하니스를 세우고 안내가 선 데까지 간다. */
    async function failedPull(client: QueryClient, keys: string[]) {
      const view = render(
        withClient(
          client,
          <Harness onRefresh={() => invalidateAndReport(client, keys.map(key => [key, 'ws']))} />,
        ),
      );
      release();
      await queriesSettle();
      await runFailure();
      expect(notice()).not.toBeNull();
      return view;
    }

    it('실패한 쿼리가 다시 읽히면(소켓 재연결 뒤 재조회·다시 시도·백그라운드) 안내가 사라진다', async () => {
      const client = newClient();
      const state = {ok: false};
      const stop = controlledQuery(client, 'feed', state);
      await queriesSettle();
      await failedPull(client, ['feed']);
      await flush(60_000);
      expect(notice()).not.toBeNull(); // 아직 실패한 채라 서 있다
      // 화면 바깥에서(소켓이 다시 붙어 재조회가 돈다) 같은 쿼리가 성공한다.
      state.ok = true;
      await act(async () => {
        void client.invalidateQueries({queryKey: ['feed', 'ws']});
      });
      await queriesSettle();
      expect(notice()).toBeNull();
      stop();
    });

    it('실패하지 않은 다른 쿼리의 성공은 안내를 지우지 않는다', async () => {
      const client = newClient();
      const state = {ok: false};
      const stops = [controlledQuery(client, 'feed', state), controlledQuery(client, 'other', {ok: true})];
      await queriesSettle();
      await failedPull(client, ['feed']);
      await act(async () => {
        void client.invalidateQueries({queryKey: ['other', 'ws']});
      });
      await queriesSettle();
      expect(client.getQueryState(['other', 'ws'])?.status).toBe('success');
      expect(notice()).not.toBeNull();
      stops.forEach(stop => stop());
    });

    it('당김과 무관한 쿼리의 오류는 기다리지 않는다: 이 당김이 다시 읽은 쿼리만 본다', async () => {
      const client = newClient();
      const feed = {ok: false};
      // 같은 캐시의 다른 화면 쿼리: 오류 상태로 남아 있고 이 당김은 건드리지 않는다.
      const stops = [controlledQuery(client, 'feed', feed), controlledQuery(client, 'unrelated', {ok: false})];
      await queriesSettle();
      await failedPull(client, ['feed']);
      expect(client.getQueryState(['unrelated', 'ws'])?.status).toBe('error');
      feed.ok = true;
      await act(async () => {
        void client.invalidateQueries({queryKey: ['feed', 'ws']});
      });
      await queriesSettle();
      // 무관한 쿼리는 여전히 실패지만 안내는 이 화면의 데이터가 다시 읽히면 거짓이 된다.
      expect(client.getQueryState(['unrelated', 'ws'])?.status).toBe('error');
      expect(notice()).toBeNull();
      stops.forEach(stop => stop());
    });

    it('실패한 쿼리가 둘이면 둘 다 읽혀야 사라진다', async () => {
      const client = newClient();
      const a = {ok: false};
      const b = {ok: false};
      const stops = [controlledQuery(client, 'a', a), controlledQuery(client, 'b', b)];
      await queriesSettle();
      await failedPull(client, ['a', 'b']);
      a.ok = true;
      await act(async () => {
        void client.invalidateQueries({queryKey: ['a', 'ws']});
      });
      await queriesSettle();
      expect(notice()).not.toBeNull(); // b 는 아직 실패다
      b.ok = true;
      await act(async () => {
        void client.invalidateQueries({queryKey: ['b', 'ws']});
      });
      await queriesSettle();
      expect(notice()).toBeNull();
      stops.forEach(stop => stop());
    });

    it('서버가 그 경로를 모른다고 답한(404) 쿼리는 기다리지 않는다: 낫지 않는 알려진 상태다', async () => {
      const client = newClient();
      const real = {ok: false};
      const absent = {ok: false, error: new ApiError(404, 'no such route')};
      const stops = [controlledQuery(client, 'real', real), controlledQuery(client, 'absent', absent)];
      await queriesSettle();
      await failedPull(client, ['real', 'absent']);
      real.ok = true;
      await act(async () => {
        void client.invalidateQueries({queryKey: ['real', 'ws']});
      });
      await queriesSettle();
      // 404 쿼리는 영영 성공하지 않지만 안내를 붙들지 않는다.
      expect(client.getQueryState(['absent', 'ws'])?.status).toBe('error');
      expect(notice()).toBeNull();
      stops.forEach(stop => stop());
    });

    it('안내가 서기 전에(최소 표시 창 안에) 이미 다시 읽힌 쿼리는 바로 거둔다', async () => {
      const client = newClient();
      const state = {ok: false};
      const stop = controlledQuery(client, 'feed', state);
      await queriesSettle();
      render(withClient(client, <Harness onRefresh={() => invalidateAndReport(client, [['feed', 'ws']])} />));
      release();
      await queriesSettle(); // 쿼리는 실패했고 최소 표시 창이 아직 열려 있다
      expect(notice()).toBeNull();
      state.ok = true; // 창이 닫히기 전에 백그라운드 재조회가 성공한다
      await act(async () => {
        void client.invalidateQueries({queryKey: ['feed', 'ws']});
      });
      await queriesSettle();
      await flush(NOTICE_READY_MS);
      expect(notifications()).toEqual(['notification:warning']); // 당김 자체는 실패였다
      expect(notice()).toBeNull(); // 그러나 안내를 세울 이유는 이미 없다
      stop();
    });

    it('상한(20초)에 걸려 끝난 당김은 늦게 도착한 성공이 안내를 거둔다', async () => {
      const client = newClient();
      let resolveData: (value: string) => void = () => undefined;
      const observer = new QueryObserver(client, {
        queryKey: ['slow', 'ws'],
        queryFn: () => new Promise<string>(resolve => (resolveData = resolve)),
        retry: false,
      });
      const stop = observer.subscribe(() => undefined);
      render(withClient(client, <Harness onRefresh={() => client.invalidateQueries({queryKey: ['slow', 'ws']})} />));
      release();
      await flush(20_500);
      expect(notice()).not.toBeNull(); // 상한이 실패로 끝냈다
      expect(client.getQueryState(['slow', 'ws'])?.fetchStatus).toBe('fetching');
      await flush(60_000);
      expect(notice()).not.toBeNull();
      resolveData('late');
      await queriesSettle();
      expect(notice()).toBeNull(); // 데이터가 늦게나마 들어왔다
      stop();
    });

    it('당김이 끝나면 캐시 구독이 풀린다: 진행 중에 화면이 닫혀도 새지 않는다', async () => {
      const client = newClient();
      const stop = controlledQuery(client, 'feed', {ok: true});
      await queriesSettle();
      const listeners = () =>
        (client.getQueryCache() as unknown as {listeners: Set<unknown>}).listeners.size;
      const base = listeners();
      const view = render(
        withClient(client, <Harness onRefresh={() => new Promise(() => undefined)} />),
      );
      release();
      expect(listeners()).toBe(base + 1); // 당김이 다시 읽는 쿼리를 모으는 구독
      view.unmount(); // 끝나지 않은 채 닫힌다
      expect(listeners()).toBe(base);
      stop();
    });

    it('캐시된 데이터가 있는 쿼리가 상한(20초)에 걸리면 안내가 서고 남는다: 읽는 중인 쿼리는 「읽힘」이 아니다', async () => {
      const client = newClient();
      client.setQueryData(['cached', 'ws'], 'old');
      let resolveData: (value: string) => void = () => undefined;
      const observer = new QueryObserver(client, {
        queryKey: ['cached', 'ws'],
        queryFn: () => new Promise<string>(resolve => (resolveData = resolve)),
        retry: false,
        staleTime: 0,
      });
      const stop = observer.subscribe(() => undefined);
      render(withClient(client, <Harness onRefresh={() => client.invalidateQueries({queryKey: ['cached', 'ws']})} />));
      release();
      await flush(20_500);
      await flush(NOTICE_READY_MS);
      expect(client.getQueryState(['cached', 'ws'])?.status).toBe('success'); // 캐시가 있어 상태는 성공이다
      expect(notice()).not.toBeNull();
      await flush(5_000);
      expect(notice()).not.toBeNull();
      resolveData('new');
      await queriesSettle();
      expect(notice()).toBeNull();
      stop();
    });

    it('안내가 서 있는 동안 캐시 구독이 하나 있고, 안내가 사라지거나 화면이 닫히면 풀린다(새는 구독이 없다)', async () => {
      const client = newClient();
      const state = {ok: false};
      const stop = controlledQuery(client, 'feed', state);
      await queriesSettle();
      const listeners = () =>
        (client.getQueryCache() as unknown as {listeners: Set<unknown>}).listeners.size;
      const base = listeners();
      const view = await failedPull(client, ['feed']);
      expect(listeners()).toBe(base + 1);
      view.unmount();
      expect(listeners()).toBe(base);
      stop();
    });
  });

  describe('화면을 떠나면 사라진다', () => {
    it('active 가 거짓이 되면(탭이 숨는다) 안내가 사라진다 — 돌아와도 옛 실패가 서 있지 않다', async () => {
      const onRefresh = () => Promise.reject(new Error('boom'));
      const view = render(<Harness onRefresh={onRefresh} active />);
      release();
      await runFailure();
      expect(notice()).not.toBeNull();
      view.rerender(<Harness onRefresh={onRefresh} active={false} />);
      expect(notice()).toBeNull();
      view.rerender(<Harness onRefresh={onRefresh} active />);
      expect(notice()).toBeNull();
    });

    it('보이는 동안(active 참)에는 서 있다', async () => {
      const onRefresh = () => Promise.reject(new Error('boom'));
      const view = render(<Harness onRefresh={onRefresh} active />);
      release();
      await runFailure();
      view.rerender(<Harness onRefresh={onRefresh} active />);
      await flush(30_000);
      expect(notice()).not.toBeNull();
    });

    it('응답이 오기 전에 떠났으면 안내를 세우지 않는다(돌아왔을 때 옛 실패가 서 있게 된다)', async () => {
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
      let fail: (reason: unknown) => void = () => undefined;
      const onRefresh = () => new Promise<never>((_, reject) => (fail = reject));
      const view = render(<Harness onRefresh={onRefresh} active />);
      release();
      announce.mockClear();
      view.rerender(<Harness onRefresh={onRefresh} active={false} />);
      fail(new Error('late boom'));
      await flush(NOTICE_READY_MS);
      expect(notice()).toBeNull();
      expect(announce).not.toHaveBeenCalled(); // 안 보이는 화면의 실패를 낭독하지 않는다
      view.rerender(<Harness onRefresh={onRefresh} active />);
      expect(notice()).toBeNull();
    });

    it('언마운트하면 안내도 함께 사라진다(다시 마운트한 화면에 옛 실패가 서지 않는다)', async () => {
      const onRefresh = () => Promise.reject(new Error('boom'));
      const view = render(<Harness onRefresh={onRefresh} />);
      release();
      await runFailure();
      expect(notice()).not.toBeNull();
      view.unmount();
      render(<Harness onRefresh={onRefresh} />);
      expect(notice()).toBeNull();
    });

    it('언마운트한 화면에서는 상한(20초) 타이머도 햅틱을 내지 않는다', async () => {
      const view = render(<Harness onRefresh={() => new Promise(() => undefined)} />);
      release();
      await flush(0);
      view.unmount();
      await flush(25_000);
      expect(notifications()).toEqual([]);
    });

    it('다루는 목록이 바뀌면(resetKey) 이전 목록의 실패는 거둔다', async () => {
      const onRefresh = () => Promise.reject(new Error('boom'));
      const view = render(<Harness onRefresh={onRefresh} resetKey="all" />);
      release();
      await runFailure();
      expect(notice()).not.toBeNull();
      view.rerender(<Harness onRefresh={onRefresh} resetKey="all" />);
      expect(notice()).not.toBeNull(); // 같은 목록이면 서 있다
      view.rerender(<Harness onRefresh={onRefresh} resetKey="mentions" />);
      expect(notice()).toBeNull();
    });
  });
});

describe('안내가 서고 걷히는 움직임 (#3992)', () => {
  /** 안내 상자의 레이아웃 이벤트(화면이 알려 주는 높이). 이 높이가 접히는 움직임의 시작이다. */
  const measure = (height: number) =>
    fireEvent(screen.getByTestId('pull-refresh-notice', HIDDEN), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 358, height}},
    });
  const collapsing = () => screen.queryByTestId('pull-refresh-notice-collapsing', HIDDEN);
  /** 실패 안내가 선 하니스. 감소된 동작 응답이 도착해 있다(`reduceMotion` 값대로). */
  async function withNotice() {
    const onRefresh = jest.fn(() => Promise.reject(new Error('boom')));
    render(<Harness onRefresh={onRefresh} />);
    await flush(0);
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    return onRefresh;
  }

  it('세울 때 네이티브 레이아웃 전환을 한 번 건다 — 목록이 안내 높이만큼 미끄러져 내려온다', async () => {
    reduceMotion(false);
    const configure = jest.spyOn(LayoutAnimation, 'configureNext');
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    await flush(0);
    configure.mockClear();
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('동작 줄이기에서는 전환을 걸지 않는다: 바로 선다', async () => {
    reduceMotion(true);
    const configure = jest.spyOn(LayoutAnimation, 'configureNext');
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    await flush(0);
    configure.mockClear();
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    expect(configure).not.toHaveBeenCalled();
  });

  it('다음 당김이 서면 안내는 한 번에 지워지지 않고 잰 높이에서 0 으로 접힌다(목록이 손 아래에서 뛰지 않는다)', async () => {
    reduceMotion(false);
    await withNotice();
    measure(57);
    release(); // 다음 당김: 손가락이 목록을 끌고 있는 순간
    // 틀은 접히는 틀로 바뀌었고 첫 그림은 잰 높이 그대로다(눈에는 이어진다).
    expect(notice()).toBeNull();
    const node = collapsing();
    expect(node).not.toBeNull();
    expect(flatten(node!.props.style).height).toBe(57);
    expect(flatten(node!.props.style).overflow).toBe('hidden');
    await flush(80);
    const mid = flatten(collapsing()!.props.style).height as number;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(57);
    await flush(200);
    expect(collapsing()).toBeNull(); // 접힘이 끝나면 틀을 치운다
    expect(notice()).toBeNull();
  });

  it('접히는 동안은 보조기술에서 숨는다(곧 사라질 문장을 읽지 않는다)', async () => {
    reduceMotion(false);
    await withNotice();
    measure(57);
    release();
    const node = collapsing()!;
    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('접히는 안내를 걷을 때는 레이아웃 전환을 걸지 않는다: 당기는 동안의 커밋이 그 전환을 먹는다', async () => {
    reduceMotion(false);
    await withNotice();
    measure(57);
    const configure = jest.spyOn(LayoutAnimation, 'configureNext');
    configure.mockClear();
    release();
    await flush(300);
    expect(configure).not.toHaveBeenCalled();
  });

  it('동작 줄이기에서는 접힘 없이 바로 지워진다', async () => {
    reduceMotion(true);
    await withNotice();
    measure(57);
    release();
    expect(notice()).toBeNull();
    expect(collapsing()).toBeNull();
  });

  it('높이를 잰 적이 없으면(레이아웃 이벤트가 안 왔다) 접을 것이 없어 바로 지워진다', async () => {
    reduceMotion(false);
    await withNotice();
    release();
    expect(notice()).toBeNull();
    expect(collapsing()).toBeNull();
  });

  it('접히는 도중에 화면을 떠나도(언마운트) 타이머·구독이 남지 않는다', async () => {
    reduceMotion(false);
    const onRefresh = jest.fn(() => Promise.reject(new Error('boom')));
    const view = render(<Harness onRefresh={onRefresh} />);
    await flush(0);
    release();
    await runFailure();
    measure(57);
    release();
    expect(collapsing()).not.toBeNull();
    view.unmount();
    await flush(1_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('오프라인과 늦은 응답', () => {
  it('오프라인이면 재조회를 세우지 않고 실패로 끝낸다(로더가 영영 돌지 않는다)', async () => {
    onlineManager.setOnline(false);
    const onRefresh = jest.fn(() => new Promise(() => undefined));
    render(<Harness onRefresh={onRefresh} />);
    release();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(impacts()).toEqual(['impact:light']); // 당김의 임계 햅틱은 그대로다
    expect(control().props.refreshing).toBe(true);
    await runFailure();
    expect(notifications()).toEqual(['notification:warning']);
    expect(notice()).not.toBeNull();
    // 오프라인의 안내는 같은 처방(다시 당겨 보세요)이 아니라 연결을 말한다. 문구는 오너 확정 그대로다.
    expect(screen.getByText(OFFLINE, HIDDEN)).toBeTruthy();
    expect(screen.queryByText(FAILED, HIDDEN)).toBeNull();
    // 시간으로는 사라지지 않고, 컨트롤은 닫혀 있다.
    await flush(60_000);
    expect(notice()).not.toBeNull();
    expect(control().props.refreshing).toBe(false);
    // 연결이 돌아오면 다시 당길 수 있다.
    act(() => onlineManager.setOnline(true));
    release();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('연결이 돌아오면 오프라인 안내는 사라진다: 「연결이 없어요」는 연결이 있으면 거짓이다', async () => {
    onlineManager.setOnline(false);
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release();
    await runFailure();
    expect(notice()).not.toBeNull();
    act(() => onlineManager.setOnline(true));
    expect(notice()).toBeNull();
  });

  it('안내가 서기 전에 연결이 돌아오면 서지 않는다', async () => {
    onlineManager.setOnline(false);
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release();
    await flush(460);
    act(() => onlineManager.setOnline(true));
    await flush(NOTICE_READY_MS);
    expect(notice()).toBeNull();
  });

  it('연결이 돌아오기 전에는 서 있다: 다른 쪽 연결 신호(offline 유지)로는 사라지지 않는다', async () => {
    onlineManager.setOnline(false);
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release();
    await runFailure();
    act(() => onlineManager.setOnline(false));
    await flush(30_000);
    expect(notice()).not.toBeNull();
  });

  it('응답이 상한(20초) 안에 안 오면 실패로 끝내고, 늦게 온 답은 무시한다', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const onRefresh = jest.fn(
      () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    );
    render(<Harness onRefresh={onRefresh} />);
    release();
    await flush(19_000);
    expect(notifications()).toEqual([]); // 아직 기다린다
    expect(control().props.refreshing).toBe(true);
    await flush(1_500);
    expect(notifications()).toEqual(['notification:warning']);
    expect(notice()).not.toBeNull();
    answer([{status: 'success'}]); // 늦게 온 성공
    await flush(5_000);
    expect(notifications()).toEqual(['notification:warning']); // success 가 뒤따르지 않는다
    expect(control().props.refreshing).toBe(false);
  });

  it('정상 응답은 상한 타이머를 남기지 않는다: 20초가 지나도 경고가 나가지 않는다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(notifications()).toEqual([]);
    await flush(25_000);
    expect(notifications()).toEqual([]);
  });

  it('동기로 던지는 재조회도 실패로 끝난다(핸들러가 터지지 않는다)', async () => {
    render(
      <Harness
        onRefresh={() => {
          throw new Error('sync boom');
        }}
      />,
    );
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
  });
});

describe('실제 react-query 실패 경로 (결과를 버리는 무효화 모양이 성공으로 읽히지 않는다)', () => {
  it('invalidateAndReport: 쿼리가 실패하면 warning 이다', async () => {
    const client = newClient();
    const stop = controlledQuery(client, 'bad', {ok: false});
    await queriesSettle();
    render(<Harness onRefresh={() => invalidateAndReport(client, [['bad', 'ws']])} />);
    release();
    await queriesSettle();
    await runFailure();
    expect(notifications()).toEqual(['notification:warning']);
    expect(notice()).not.toBeNull();
    stop();
  });

  it('invalidateAndReport: 쿼리가 성공하면 무음이다', async () => {
    const client = newClient();
    const stop = controlledQuery(client, 'good', {ok: true});
    await queriesSettle();
    render(<Harness onRefresh={() => invalidateAndReport(client, [['good', 'ws']])} />);
    release();
    await queriesSettle();
    await flush(500);
    expect(notifications()).toEqual([]);
    expect(notice()).toBeNull();
    stop();
  });

  it('결과를 버리는 옛 모양(invalidateQueries 만)은 실패를 못 본다: 그래서 이 모양을 쓰지 않는다', async () => {
    const client = newClient();
    const stop = controlledQuery(client, 'bad', {ok: false});
    await queriesSettle();
    render(<Harness onRefresh={() => client.invalidateQueries({queryKey: ['bad', 'ws']})} />);
    release();
    await queriesSettle();
    await flush(500);
    // 쿼리는 오류 상태인데도 당김은 성공으로 끝난다. 이 시험은 그 한계를 못 박아 둔다(고치는 길은 invalidateAndReport).
    expect(client.getQueryState(['bad', 'ws'])?.status).toBe('error');
    expect(notifications()).toEqual([]);
    stop();
  });

  it('여러 쿼리 중 하나만 실패해도 실패다(묶음 재조회)', async () => {
    const client = newClient();
    const stops = [controlledQuery(client, 'a', {ok: true}), controlledQuery(client, 'b', {ok: false})];
    await queriesSettle();
    render(
      <Harness
        onRefresh={() =>
          Promise.all([invalidateAndReport(client, [['a', 'ws']]), invalidateAndReport(client, [['b', 'ws']])])
        }
      />,
    );
    release();
    await queriesSettle();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
    stops.forEach(stop => stop());
  });
});

describe('머리가 보인다 (시험이 눈 대신 재는 것)', () => {
  const opacityOf = () => flatten(screen.getByTestId('pull-refresh-header', HIDDEN).props.style).opacity as number;

  it('당김이 작으면 거의 투명하고, 조금(25%) 당기면 온전히 보이며, 임계 너머도 그대로다', () => {
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-2);
    expect(opacityOf()).toBeLessThan(0.2);
    scrollTo(-PULL_TRIGGER * 0.25);
    expect(opacityOf()).toBeCloseTo(1, 5);
    scrollTo(-PULL_TRIGGER * 3);
    expect(opacityOf()).toBe(1);
  });

  it('새로고침 중에는 당김(진행도)이 0 에 가까워져도 사라지지 않는다', () => {
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    scrollTo(-1); // 스프링백으로 오프셋이 거의 0 이다
    expect(opacityOf()).toBe(1);
  });

  it('머리는 터치를 가로채지 않고 로더는 40pt, 머리는 64pt 높이다', () => {
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-20);
    const node = screen.getByTestId('pull-refresh-header', HIDDEN);
    expect(node.props.pointerEvents).toBe('none');
    expect(flatten(node.props.style).height).toBe(64);
    const loader = flatten(screen.getByTestId('pull-refresh-loader', HIDDEN).props.style);
    expect(loader.width).toBe(40);
    expect(loader.height).toBe(40);
  });
});

describe('접근성', () => {
  it('새로고침이 시작되면 「새로고침 중」을 한 번 낭독한다', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    // RN 의 jest 대역은 이미 jest.fn 이라 호출 기록이 앞 시험에서 이어진다.
    announce.mockClear();
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release();
    release(); // 진행 중의 두 번째 당김은 다시 낭독하지 않는다
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('새로고침 중');
  });

  it('새로고침 중에는 머리가 이름(「새로고침 중」)과 busy 를 진다, 당기는 동안은 장식이다', () => {
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    scrollTo(-20);
    let node = screen.getByTestId('pull-refresh-header', HIDDEN);
    expect(node.props.accessible).toBe(false);
    release();
    node = screen.getByTestId('pull-refresh-header', HIDDEN);
    expect(node.props.accessible).toBe(true);
    expect(node.props.accessibilityLabel).toBe('새로고침 중');
    expect(node.props.accessibilityRole).toBe('progressbar');
    expect(node.props.accessibilityState).toEqual({busy: true});
  });

  it('머리의 로더 자신은 장식이다(접근성 트리에서 숨김)', () => {
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-20);
    const loader = screen.getByTestId('pull-refresh-loader', HIDDEN);
    expect(loader.props.accessibilityElementsHidden).toBe(true);
    expect(loader.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

describe('빈 자리에서도 당겨진다 (내용 컨테이너가 뷰포트를 채운다)', () => {
  // 내용이 뷰포트보다 짧으면 iOS(Fabric)에서 내용 밖 빈 자리를 눌러 끄는 제스처가 시작되지 않는다(`PULL_FILL` 주석,
  // 시뮬레이터 실측). 단위 시험은 손가락을 못 대므로 스타일이 걸려 있는지를 잰다.
  it('PULL_FILL 은 flexGrow 1 이다', () => {
    expect(PULL_FILL).toEqual({flexGrow: 1});
  });

  it('EmptyState 의 스크롤뷰 내용 컨테이너가 flexGrow 1 을 가진다', () => {
    render(<EmptyState headline="비어 있어요." refreshControl={<></> as never} testID="e" />);
    const style = flatten(screen.getByTestId('e').props.contentContainerStyle);
    expect(style.flexGrow).toBe(1);
  });

  it('당김이 없는 EmptyState(스크롤뷰가 아닌 뷰)는 늘어나지 않는다', () => {
    render(<EmptyState headline="비어 있어요." testID="plain" />);
    const style = flatten(screen.getByTestId('plain').props.style);
    expect(style.flexGrow).toBeUndefined();
  });
});

describe('빈 목록에서도 같다 (EmptyState 가 scrollProps 를 받는다)', () => {
  it('빈 상태 스크롤뷰에서도 넘치면 머리가 서고 위성이 당김을 따라간다', () => {
    render(<Harness onRefresh={() => undefined} empty />);
    fireEvent.scroll(list(), scrollEvent(-PULL_TRIGGER / 2));
    expect(header()).not.toBeNull();
    // 빈 상태의 컨트롤도 같은 요소다: 새로고침이 서면 햅틱 한 번.
    release();
    expect(impacts()).toEqual(['impact:light']);
  });
});

describe('withPullScroll — 목록 자신의 onScroll 과 합친다', () => {
  it('목록의 것이 먼저, 당김의 것이 뒤에 불린다', () => {
    const order: string[] = [];
    const merged = withPullScroll(() => order.push('own'), {
      scrollEventThrottle: 16,
      onScroll: () => order.push('pull'),
    });
    merged.onScroll?.({} as never);
    expect(order).toEqual(['own', 'pull']);
    expect(merged.scrollEventThrottle).toBe(16);
  });

  it('당김이 없으면 목록 자신의 것 그대로다', () => {
    const own = jest.fn();
    const merged = withPullScroll(own, undefined);
    merged.onScroll?.({} as never);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('목록에 onScroll 이 없어도 당김은 돈다', () => {
    const pull = jest.fn();
    const merged = withPullScroll(undefined, {scrollEventThrottle: 16, onScroll: pull});
    merged.onScroll?.({} as never);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('훅이 돌려주는 scrollProps 는 onScroll 과 throttle 둘뿐이다(필요한 것만 펼친다)', () => {
    let seen: Record<string, unknown> = {};
    function Probe() {
      seen = usePullRefresh(() => undefined).scrollProps as Record<string, unknown>;
      return null;
    }
    render(<Probe />);
    expect(Object.keys(seen).sort()).toEqual(['onScroll', 'scrollEventThrottle']);
    expect(seen.scrollEventThrottle).toBe(16);
  });
});

describe('모든 화면이 scrollProps 를 펼친다 (소스 스캔, src 전수)', () => {
  // 빠뜨려도 새로고침은 되지만(머리는 새로고침이 서면 돈다) 당김을 따라가는 위성이 없다. 사람이 눈으로 찾기
  // 어려운 빠짐이라 소스를 읽어 막는다. 손으로 적은 목록이 아니라 `src` 를 훑는다: 여덟 번째 화면이
  // `refreshControl={refreshControl}` 을 걸고 `scrollProps` 를 빼먹어도 여기서 붉다.
  const SRC = path.join(__dirname, '..', 'src');
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(tsx|ts)$/.test(entry.name) ? [full] : [];
    });
  }
  const SITE = 'refreshControl={refreshControl}';
  const SPREAD = /\{\.\.\.scrollProps\}|scrollProps=\{scrollProps\}|withPullScroll\(/g;
  const sources = walk(SRC).map(file => ({
    rel: path.relative(path.join(__dirname, '..'), file),
    text: fs.readFileSync(file, 'utf8'),
  }));
  // `refreshControl={refreshControl}` 리터럴뿐 아니라 훅을 부르는 모든 파일이 대상이다(변수 이름을 바꿔도 빠지지 않게).
  const users = sources.filter(
    ({rel, text}) => rel !== 'src/design/refresh.tsx' && (text.includes(SITE) || /\busePullRefresh\(/.test(text)),
  );

  // 바닥: 지금 걸려 있는 곳이 스캔에서 빠지지 않는다(스캔이 헛돌아 0건을 찾는 일을 막는다).
  const KNOWN = [
    'src/screens/InboxScreen.tsx',
    'src/screens/SidebarScreen.tsx',
    'src/screens/AgentsScreen.tsx',
    'src/screens/WorkJobsScreen.tsx',
    'src/screens/TeamBoardScreen.tsx',
    'src/screens/HostedConnectionsScreen.tsx',
    'src/screens/WorkSessionDetailScreen.tsx',
    'src/features/work/WorkConversation.tsx',
    'src/features/conversation/Timeline.tsx',
    'src/design/atoms.tsx',
  ];

  it('스캔이 알려진 열 곳을 모두 찾는다', () => {
    expect(users.map(u => u.rel).sort()).toEqual(expect.arrayContaining([...KNOWN].sort()));
  });

  it.each(users.map(u => u.rel))('%s: refreshControl 을 거는 곳마다 scrollProps 를 같이 건다', rel => {
    const text = users.find(u => u.rel === rel)!.text;
    const sites = text.split(SITE).length - 1;
    const spreads = (text.match(SPREAD) ?? []).length;
    expect(`${rel} sites=${sites} spreads=${spreads}`).toBe(`${rel} sites=${sites} spreads=${Math.max(spreads, sites)}`);
    expect(spreads).toBeGreaterThanOrEqual(sites);
    expect(spreads).toBeGreaterThan(0); // 훅을 부르는 파일은 `scrollProps` 를 어딘가에 펼친다
    // 내용 컨테이너가 뷰포트를 채워야 짧은 목록의 빈 자리에서도 당겨진다(`PULL_FILL`). 빠뜨리면 눈에 띄지 않는 먹통이 된다.
    // 가져오기만 하고 쓰지 않는 것을 잡으려고 두 번 이상(가져오기 + 사용)을 요구한다.
    const fills = (text.match(/PULL_FILL/g) ?? []).length;
    expect(`${rel} PULL_FILL x${fills >= 2 ? '2+' : fills}`).toBe(`${rel} PULL_FILL x2+`);
  });

  // 실패 안내(#3992)는 목록 위 레이아웃 안에 **화면이** 놓는다(훅은 요소만 돌려준다). 빠뜨리면 실패해도 haptics 만 울리고
  // 화면에는 아무 흔적이 없다 — 이 안내가 고치려는 결함과 같은 모양이라 소스를 읽어 막는다.
  // 호출은 인수가 있다(`usePullRefresh(onRefresh, …)`). 머리말·주석의 `usePullRefresh()` 언급은 호출이 아니다.
  const callers = users.filter(u => /\busePullRefresh\((?!\))/.test(u.text));
  const RENDERS_NOTICE = /\{notice\}|:\s*\(?\s*notice\s*\)?\s*\}|notice=\{notice\}/;

  // Owner 2026-10-30 (#4783): 「대화 화면 당겨서 새로고침 = 다시 맞추기」.
  // 기존 대화 화면 제외 결정을 뒤집었으므로 Timeline 이 아홉 번째 호출 화면이다.
  it('스캔이 훅을 부르는 아홉 화면을 모두 찾는다', () => {
    expect(callers.map(u => u.rel).sort()).toEqual(
      [
        'src/screens/InboxScreen.tsx',
        'src/screens/SidebarScreen.tsx',
        'src/screens/AgentsScreen.tsx',
        'src/screens/WorkJobsScreen.tsx',
        'src/screens/TeamBoardScreen.tsx',
        'src/screens/HostedConnectionsScreen.tsx',
        'src/screens/WorkSessionDetailScreen.tsx',
        'src/screens/AppsScreen.tsx', // U-4 #3951
        'src/features/conversation/Timeline.tsx', // owner 10-30 #4783
      ].sort(),
    );
  });

  it.each(callers.map(u => u.rel))('%s: 훅이 돌려준 notice 를 받아 목록 위에 그린다', rel => {
    const text = callers.find(u => u.rel === rel)!.text;
    expect(`${rel} destructures=${/\{[^}]*\bnotice\b[^}]*\}\s*=\s*usePullRefresh\(/.test(text)}`).toBe(`${rel} destructures=true`);
    expect(`${rel} renders=${RENDERS_NOTICE.test(text)}`).toBe(`${rel} renders=true`);
  });

  it('일곱 화면은 refreshControl 바로 다음 줄에 scrollProps 를 둔다(모양을 하나로 둔다)', () => {
    for (const rel of KNOWN.filter(f => f.startsWith('src/screens/'))) {
      const lines = users.find(u => u.rel === rel)!.text.split('\n');
      lines.forEach((line, i) => {
        if (line.trim() !== SITE) return;
        expect(`${rel}:${i + 1} ${lines[i + 1]!.trim()}`).toMatch(/ (\{\.\.\.scrollProps\}|scrollProps=\{scrollProps\})$/);
      });
    }
  });

  const shellSrc = fs.readFileSync(path.join(SRC, 'shell', 'AppShell.tsx'), 'utf8');
  it.each([
    ['SidebarScreen', /<SidebarScreen\s+active=\{nav\.tab === 'home'\}/],
    ['AgentsScreen', /<AgentsScreen\s+active=\{nav\.agentList && nav\.agent === null && nav\.hosted === null\}/],
    ['HostedConnectionsScreen', /<HostedConnectionsScreen\s+active=\{nav\.hosted\.kind === 'list'\}/],
  ])('AppShell 이 %s 에 보이는지(active)를 넘긴다: 빠지면 숨은 탭에 옛 실패가 남는다', (_name, pattern) => {
    expect(shellSrc).toMatch(pattern);
  });

  it.each([
    'src/screens/SidebarScreen.tsx',
    'src/screens/AgentsScreen.tsx',
    'src/screens/HostedConnectionsScreen.tsx',
    'src/screens/InboxScreen.tsx',
  ])('%s: 보이는지(active)를 usePullRefresh 의 옵션으로 넘긴다(검수 M5)', rel => {
    const text = users.find(u => u.rel === rel)!.text;
    expect(text).toMatch(/usePullRefresh\((?:[^;]|\n)*?\{active\b[^}]*\}\s*,?\s*\)/);
  });

  it('호스팅 연결 목록 래퍼가 notice 를 보기에 넘긴다', () => {
    const text = users.find(u => u.rel === 'src/screens/HostedConnectionsScreen.tsx')!.text;
    expect(text).toMatch(/notice=\{notice\}/);
  });

  it.each([
    ['src/screens/WorkJobsScreen.tsx'],
    ['src/screens/TeamBoardScreen.tsx'],
  ])('%s: 필터(목록)가 바뀌면 안내를 거두도록 resetKey 를 넘긴다', rel => {
    const text = users.find(u => u.rel === rel)!.text;
    expect(text).toMatch(/\{active, resetKey: filter\}/);
  });

  it('옛 훅 이름(useRefreshControl)은 어디에도 남지 않았다', () => {
    for (const {rel, text} of sources) {
      expect(`${rel}:${text.includes('useRefreshControl')}`).toBe(`${rel}:false`);
    }
  });
});

// #4298: native call map; tactile quality remains owner-device verification.
describe('사건 햅틱 공통 정책 (#4298)', () => {
  it('설정이 없으면 기본이고 첫 누름부터 기존 light·selection을 횟수 그대로 낸다', () => {
    nonSecretStore().remove(NON_SECRET_KEYS.hapticMode);
    expect(getHapticMode()).toBe('basic');
    haptics.light(); haptics.light(); haptics.selection();
    expect(haptic.__calls).toEqual(['impact:light', 'impact:light', 'selection']);
  });

  it('기본 당김은 문턱 light와 성공 success를 각각 한 번 보존한다', async () => {
    setHapticMode('basic');
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    expect(haptic.__calls).toEqual(['impact:light']);
    await flush(500);
    expect(haptic.__calls).toEqual(['impact:light', 'notification:success']);
  });

  it('기본 모드도 당김 문턱에서 즉시 한 번 울리고 진행 중 반복 신호는 무음이다', () => {
    setHapticMode('basic');
    render(<Harness onRefresh={() => new Promise(() => undefined)} />);
    release(); release(); release();
    expect(haptic.__calls).toEqual(['impact:light']);
  });

  it('사건마다 해당 패턴 한 번이고, legacy API와도 99ms는 버리고 100ms는 허용한다', () => {
    const map: [HapticEvent, string][] = [
      ['messageMenu', 'impact:medium'], ['reactionChanged', 'selection'],
      ['reactionCandidateChanged', 'selection'], ['profileOpened', 'impact:light'],
      ['jumpToLatest', 'impact:light'], ['tabChanged', 'selection'],
      ['filterChanged', 'selection'], ['deleteConfirmed', 'impact:medium'],
      ['recordingStarted', 'impact:light'], ['recordingStopped', 'impact:medium'],
      ['refreshThreshold', 'impact:light'], ['refreshFailed', 'notification:warning'],
    ];
    for (const [event, pattern] of map) {
      jest.advanceTimersByTime(100);
      haptic.__calls.length = 0;
      haptics.event(event);
      expect(haptic.__calls).toEqual([pattern]);
      jest.advanceTimersByTime(99);
      jest.setSystemTime(Date.now() + 100_000); // wall-clock correction must not bypass the window
      haptics.light();
      expect(haptic.__calls).toEqual([pattern]);
      jest.advanceTimersByTime(1);
      haptics.selection();
      expect(haptic.__calls).toEqual([pattern, 'selection']);
    }
  });

  it('기본은 기존 호출을 보존하고 추가 사건은 무음, 끔은 앱 호출 0회이며 선택은 저장된다', () => {
    setHapticMode('basic');
    expect(getHapticMode()).toBe('basic');
    for (const event of ['tabChanged', 'filterChanged', 'jumpToLatest', 'deleteConfirmed'] as const) {
      haptics.event(event);
    }
    expect(haptic.__calls).toEqual([]);
    // CI 수리: legacy light/selection도 기본에서 보존한다. 옛 0회 기대는 #3580 계약을 깼다.
    haptics.light(); haptics.selection();
    expect(haptic.__calls).toEqual(['impact:light', 'selection']);
    haptic.__calls.length = 0;
    for (const event of ['messageMenu', 'reactionChanged', 'profileOpened', 'refreshThreshold'] as const) {
      jest.advanceTimersByTime(100);
      haptics.event(event);
    }
    expect(haptic.__calls).toEqual(['impact:medium', 'selection', 'impact:light', 'impact:light']);
    setHapticMode('off');
    haptic.__calls.length = 0;
    jest.advanceTimersByTime(100);
    haptics.event('messageMenu'); haptics.medium(); haptics.warning();
    expect(haptic.__calls).toEqual([]);
  });

  it('앱 비활성은 무음이고, 화면을 떠난 비동기 사건도 무음이다', () => {
    AppState.currentState = 'background';
    haptics.event('messageMenu'); haptics.error();
    expect(haptic.__calls).toEqual([]);
    AppState.currentState = 'active';
    const departed = hapticScope(() => false);
    departed('refreshFailed');
    expect(haptic.__calls).toEqual([]);
    haptics.event('messageMenu');
    expect(haptic.__calls).toEqual(['impact:medium']);
  });

  it('화면을 떠났다가 돌아와도 옛 당김의 실패는 울리지 않는다', async () => {
    let answer!: (value: unknown) => void;
    const onRefresh = () => new Promise(resolve => { answer = resolve; });
    const view = render(<Harness active onRefresh={onRefresh} />);
    release();
    view.rerender(<Harness active={false} onRefresh={onRefresh} />);
    view.rerender(<Harness active onRefresh={onRefresh} />);
    answer({isError: true});
    await flush(500);
    expect(haptic.__calls).toEqual(['impact:light']);
  });
});


describe('Android 사건 경로 (#4298)', () => {
  it('시스템 설정을 따르는 semantic API만 부르고 Vibrator 경로는 쓰지 않는다', () => {
    const native = jest.requireMock('expo-haptics');
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    native.AndroidHaptics = {Segment_Tick: 'tick', Context_Click: 'click', Long_Press: 'hold', Confirm: 'confirm', Reject: 'reject'};
    native.performAndroidHapticsAsync = jest.fn().mockResolvedValue(undefined);
    try {
      for (const event of ['reactionChanged', 'profileOpened', 'messageMenu', 'refreshFailed'] as const) {
        jest.advanceTimersByTime(100);
        haptics.event(event);
      }
      expect(native.performAndroidHapticsAsync.mock.calls).toEqual([['tick'], ['click'], ['hold'], ['reject']]);
      expect(haptic.__calls).toEqual([]);
    } finally {
      os.restore();
      delete native.AndroidHaptics;
      delete native.performAndroidHapticsAsync;
    }
  });
});
