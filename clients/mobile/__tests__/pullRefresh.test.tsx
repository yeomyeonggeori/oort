import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {AccessibilityInfo, Animated, FlatList, StyleSheet, Text} from 'react-native';

import {onlineManager, QueryClient, QueryObserver} from '@tanstack/react-query';
import {withPullScroll, usePullRefresh} from '../src/design/refresh';
import {invalidateAndReport} from '../src/query/invalidateReport';
import {PULL_FILL, PULL_TRIGGER} from '../src/design/pullRefresh';
import {OPTICAL, PHASE} from '../src/design/brand/oortLoaderTimeline';
import {BAR_CONTROL_MAX_SCALE, EmptyState} from '../src/design/atoms';
import {FixedScheme} from '../src/design/theme';

// =============================================================================
// 당겨서 새로고침 + 햅틱 (#3962). `usePullRefresh` 가 표준 `RefreshControl`(역학) 위에 얹는 것:
//   · 당기는 동안 목록 위 넘친 자리에 오르트 로더 머리가 서고, 새로고침이 서면 당긴 자세에서 이어 돈다
//   · 임계 통과의 가벼운 햅틱 1회: 표준 컨트롤이 새로고침을 세우는 순간(`onRefresh`)에 낸다. 이 컨트롤은
//     손가락이 닿은 채로 임계를 넘는 순간 `onRefresh` 를 부른다(iOS 26.5 시뮬레이터에서 잰 것). 한 번의
//     새로고침에 한 번이고, 스크롤 이벤트로는 울리지 않는다(`lib/haptics.ts` 계약)
//   · 완료 success, 실패 warning
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
  // 로더의 감소된 동작 훅은 초기값이 true 다. 시험 대역이 false 로 답하면 비동기 응답이 act 밖에서
  // 상태를 바꿔 소음이 된다. 움직이는 쪽을 보는 시험만 `reduceMotion(false)` 로 바꾸고 응답을 비운다.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

function Harness({
  onRefresh,
  empty = false,
}: {
  onRefresh: () => Promise<unknown> | void;
  empty?: boolean;
}): React.JSX.Element {
  const {refreshControl, scrollProps} = usePullRefresh(onRefresh, 'harness-refresh');
  if (empty) {
    return (
      <EmptyState
        headline="비어 있어요."
        refreshControl={refreshControl}
        scrollProps={scrollProps}
        testID="harness-list"
      />
    );
  }
  return (
    <FlatList
      data={['a', 'b', 'c']}
      keyExtractor={item => item}
      renderItem={({item}) => <Text>{item}</Text>}
      refreshControl={refreshControl}
      {...scrollProps}
      testID="harness-list"
    />
  );
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

  it('햅틱이 먼저, 완료가 나중이다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(haptic.__calls).toEqual(['impact:light', 'notification:success']);
  });

  it('평소 스크롤(양수 오프셋)은 햅틱도 머리도 건드리지 않는다', () => {
    render(<Harness onRefresh={() => undefined} />);
    for (const y of [0, 40, 400, 1200]) scrollTo(y);
    expect(haptic.__calls).toEqual([]);
    expect(header()).toBeNull();
  });
});

describe('완료와 실패 햅틱', () => {
  it('재조회가 끝나 표시가 물러나는 순간 success 한 번', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(0);
    // 최소 표시 창(450ms) 안에서는 아직이다.
    expect(notifications()).toEqual([]);
    await flush(460);
    expect(notifications()).toEqual(['notification:success']);
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

  it('결과를 모르는(void) 재조회는 실패라고 단정하지 않는다: success', async () => {
    render(<Harness onRefresh={() => undefined} />);
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:success']);
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

  it('당기는 동안 위성이 당긴 거리만큼 튀어나온다(스크럽): 임계에서 궤도, 그 너머도 궤도', async () => {
    reduceMotion(false);
    render(<Harness onRefresh={() => undefined} />);
    scrollTo(-1);
    await flush(0); // 머리가 서고 감소된 동작 응답(false)이 도착한다
    const x = () =>
      ((flatten(screen.getByTestId('pull-refresh-loader-satellite', HIDDEN).props.style).transform as Array<
        Record<string, number>
      >)[1]!).translateX!;
    const {units, home, out} = OPTICAL.display;
    const size = 40;
    expect(x()).toBeGreaterThanOrEqual((home / units) * size - 1e-6);
    scrollTo(-PULL_TRIGGER / 2);
    const mid = x();
    expect(mid).toBeGreaterThan((home / units) * size);
    expect(mid).toBeLessThan((out / units) * size);
    scrollTo(-PULL_TRIGGER);
    expect(x()).toBeCloseTo((out / units) * size, 4);
    scrollTo(-PULL_TRIGGER * 2);
    expect(x()).toBeCloseTo((out / units) * size, 4);
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

const FAILED = '새로고침하지 못했어요. 다시 당겨 보세요.';
const OFFLINE = '연결이 없어요. 연결되면 다시 당겨 보세요.';
const failedNotice = () => screen.queryByTestId('pull-refresh-failed', HIDDEN);

describe('실패는 시각으로도 선다', () => {
  it('실패하면 머리의 로더가 한 줄로 바뀐다: 경고 햅틱과 같은 순간, 낭독도 한다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    render(<Harness onRefresh={() => Promise.resolve([{status: 'error', isError: true}])} />);
    release();
    await flush(0);
    // 최소 표시 창 안에서는 아직 로더다.
    expect(failedNotice()).toBeNull();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).not.toBeNull();
    await flush(460);
    expect(notifications()).toEqual(['notification:warning']);
    expect(failedNotice()).not.toBeNull();
    expect(screen.getByText(FAILED, HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).toBeNull();
    expect(announce).toHaveBeenLastCalledWith(FAILED);
  });

  it('성공하면 실패 안내가 서지 않는다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(failedNotice()).toBeNull();
    expect(notifications()).toEqual(['notification:success']);
  });

  it('안내는 열린 채 잠깐 머문 뒤 물러난다: 그동안 새 당김은 막힌다', async () => {
    const onRefresh = jest.fn(() => Promise.reject(new Error('boom')));
    render(<Harness onRefresh={onRefresh} />);
    release();
    await flush(460); // 안내가 섰다
    expect(control().props.refreshing).toBe(true);
    release(); // 안내가 떠 있는 동안의 당김은 무시된다
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await flush(1000);
    expect(control().props.refreshing).toBe(true); // 아직 머문다
    await flush(700);
    expect(control().props.refreshing).toBe(false);
    release(); // 끝난 뒤의 새 당김은 선다
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await flush(0);
  });

  it('물러나는 동안(머리가 걷힐 때까지) 로더로 되돌아가지 않고, 새 당김이 서면 안내가 지워진다', async () => {
    const results = [Promise.reject(new Error('boom')), new Promise(() => undefined)];
    const onRefresh = jest.fn(() => results.shift() as Promise<unknown>);
    render(<Harness onRefresh={onRefresh} />);
    scrollTo(-PULL_TRIGGER - 5);
    release();
    await flush(460);
    await flush(1700); // 안내가 끝나고 내용이 돌아오는 중
    scrollTo(-30);
    expect(failedNotice()).not.toBeNull();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).toBeNull();
    scrollTo(0); // 제자리로 돌아왔다: 머리가 걷힌다
    expect(header()).toBeNull();
    scrollTo(-PULL_TRIGGER - 5);
    release(); // 새 당김: 안내 없이 로더로 시작한다
    expect(failedNotice()).toBeNull();
    expect(screen.queryByTestId('pull-refresh-loader', HIDDEN)).not.toBeNull();
  });

  it('실패 안내는 Dynamic Type 에 상한이 있고 두 줄까지 접힌다(머리 64pt 안에 선다)', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await flush(460);
    const text = screen.getByTestId('pull-refresh-failed', HIDDEN);
    expect(text.props.maxFontSizeMultiplier).toBe(BAR_CONTROL_MAX_SCALE);
    expect(text.props.numberOfLines).toBe(2);
    // 줄 높이를 고정하지 않는다: 글자가 상한까지 자라도 줄이 겹치거나 잘리지 않고 글자 크기를 따른다.
    expect(flatten(text.props.style).lineHeight).toBeUndefined();
  });

  it('실패 안내의 접근성: role alert, 이름은 안내 문장, busy 가 아니다', async () => {
    render(<Harness onRefresh={() => Promise.reject(new Error('boom'))} />);
    release();
    await flush(460);
    const node = screen.getByTestId('pull-refresh-header', HIDDEN);
    expect(node.props.accessible).toBe(true);
    expect(node.props.accessibilityRole).toBe('alert');
    expect(node.props.accessibilityLabel).toBe(FAILED);
    expect(node.props.accessibilityState).toEqual({busy: false});
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
    await flush(460);
    expect(notifications()).toEqual(['notification:warning']);
    expect(failedNotice()).not.toBeNull();
    // 오프라인의 안내는 같은 처방(다시 당겨 보세요)이 아니라 연결을 말한다.
    expect(screen.getByText(OFFLINE, HIDDEN)).toBeTruthy();
    expect(screen.queryByText(FAILED, HIDDEN)).toBeNull();
    await flush(1700);
    expect(control().props.refreshing).toBe(false);
    onlineManager.setOnline(true);
    release(); // 연결이 돌아오면 다시 당길 수 있다
    expect(onRefresh).toHaveBeenCalledTimes(1);
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
    expect(failedNotice()).not.toBeNull();
    answer([{status: 'success'}]); // 늦게 온 성공
    await flush(5_000);
    expect(notifications()).toEqual(['notification:warning']); // success 가 뒤따르지 않는다
    expect(control().props.refreshing).toBe(false);
  });

  it('정상 응답은 상한 타이머를 남기지 않는다: 20초가 지나도 경고가 나가지 않는다', async () => {
    render(<Harness onRefresh={() => Promise.resolve([{status: 'success'}])} />);
    release();
    await flush(500);
    expect(notifications()).toEqual(['notification:success']);
    await flush(25_000);
    expect(notifications()).toEqual(['notification:success']);
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
  /** gcTime 무한: 기본 5분 가비지 타이머를 세우지 않는다. */
  const newClient = () => new QueryClient({defaultOptions: {queries: {gcTime: Infinity}}});
  /** 관찰자가 붙은(활성) 쿼리. 실패하거나 성공하는 queryFn 을 준다. */
  function activeQuery(client: QueryClient, key: string, ok: boolean) {
    const observer = new QueryObserver(client, {
      queryKey: [key, 'ws'],
      queryFn: () => (ok ? Promise.resolve('data') : Promise.reject(new Error('down'))),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return unsubscribe;
  }
  async function queriesSettle() {
    await act(async () => {
      for (let i = 0; i < 40; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(0);
      for (let i = 0; i < 40; i += 1) await Promise.resolve();
    });
  }

  it('invalidateAndReport: 쿼리가 실패하면 warning 이다', async () => {
    const client = newClient();
    const stop = activeQuery(client, 'bad', false);
    await queriesSettle();
    render(<Harness onRefresh={() => invalidateAndReport(client, [['bad', 'ws']])} />);
    release();
    await queriesSettle();
    await flush(500);
    expect(notifications()).toEqual(['notification:warning']);
    expect(failedNotice()).not.toBeNull();
    stop();
  });

  it('invalidateAndReport: 쿼리가 성공하면 success 이다', async () => {
    const client = newClient();
    const stop = activeQuery(client, 'good', true);
    await queriesSettle();
    render(<Harness onRefresh={() => invalidateAndReport(client, [['good', 'ws']])} />);
    release();
    await queriesSettle();
    await flush(500);
    expect(notifications()).toEqual(['notification:success']);
    expect(failedNotice()).toBeNull();
    stop();
  });

  it('결과를 버리는 옛 모양(invalidateQueries 만)은 실패를 못 본다: 그래서 이 모양을 쓰지 않는다', async () => {
    const client = newClient();
    const stop = activeQuery(client, 'bad', false);
    await queriesSettle();
    render(<Harness onRefresh={() => client.invalidateQueries({queryKey: ['bad', 'ws']})} />);
    release();
    await queriesSettle();
    await flush(500);
    // 쿼리는 오류 상태인데도 당김은 성공으로 끝난다. 이 시험은 그 한계를 못 박아 둔다(고치는 길은 invalidateAndReport).
    expect(client.getQueryState(['bad', 'ws'])?.status).toBe('error');
    expect(notifications()).toEqual(['notification:success']);
    stop();
  });

  it('여러 쿼리 중 하나만 실패해도 실패다(묶음 재조회)', async () => {
    const client = newClient();
    const stops = [activeQuery(client, 'a', true), activeQuery(client, 'b', false)];
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
    'src/design/atoms.tsx',
  ];

  it('스캔이 알려진 아홉 곳을 모두 찾는다', () => {
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

  it('일곱 화면은 refreshControl 바로 다음 줄에 scrollProps 를 둔다(모양을 하나로 둔다)', () => {
    for (const rel of KNOWN.filter(f => f.startsWith('src/screens/'))) {
      const lines = users.find(u => u.rel === rel)!.text.split('\n');
      lines.forEach((line, i) => {
        if (line.trim() !== SITE) return;
        expect(`${rel}:${i + 1} ${lines[i + 1]!.trim()}`).toMatch(/ (\{\.\.\.scrollProps\}|scrollProps=\{scrollProps\})$/);
      });
    }
  });

  it('옛 훅 이름(useRefreshControl)은 어디에도 남지 않았다', () => {
    for (const {rel, text} of sources) {
      expect(`${rel}:${text.includes('useRefreshControl')}`).toBe(`${rel}:false`);
    }
  });
});
