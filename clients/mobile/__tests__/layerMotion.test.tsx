import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, Dimensions, StyleSheet, Text} from 'react-native';

import {
  EASE_OUT,
  LAYER_POP_MS,
  LAYER_PUSH_MS,
  LAYER_RISE_MS,
  LAYER_SINK_MS,
} from '../src/design/motion';
import {EdgeSwipeBack, useLayerClose} from '../src/nav/EdgeSwipeBack';
import {ACTIVATE_PX} from '../src/nav/edgeSwipe';
import {finger, pane} from './fixtures/finger';
import {pinReduceMotion} from './fixtures/reduceMotion';

// =============================================================================
// #4457 (planner 결정 4) — 층의 들어오고 나가는 움직임.
//
// 설정 첫 장은 모달 페이지처럼 아래에서 올라오고(`rise`), 안쪽 장은 스택처럼 오른쪽에서 밀려 들어온다(`push`).
// 나감은 올라온 길의 반대다(`useLayerClose`). 이 파일이 지는 약속:
//   1. `enter` 를 안 준 층은 **한 줄도 달라지지 않는다**(앱의 나머지 층 전부).
//   2. 움직이라고 시킨 값: 어디서 시작하고, 어디로 가며, 얼마나 걸리고, 어떤 곡선인가 — 전부 사다리 안의 상수다.
//   3. 「동작 줄이기」면 움직임이 0 이다: 처음부터 자리에 서고, 누르면 바로 걷힌다.
//   4. 나가는 약속(`onBack`)은 애니메이션 완료가 아니라 타이머가 부른다 — 한 번만, 언마운트하면 부르지 않는다.
//   5. 나가는 동안에는 가장자리 밀기가 두 번째 `onBack` 을 만들지 못한다.
//
// **재지 않는 것**: 곡선이 손에 어떻게 느껴지는지(실기기). `Animated.timing` 은 가짜로 갈아 끼워 설정만 관찰한다 —
// 네이티브 구동 애니메이션은 시험 환경에서 끝나지 않기 때문이고(`edgeSwipeBack.test.tsx` 머리말), 그래서 시험이
// 보는 것은 「어떤 움직임을 시켰는가」다.
// =============================================================================

const {width: WIDTH, height: HEIGHT} = Dimensions.get('window');

let release: (() => void) | null = null;
let timing: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  // 시킨 설정만 본다 — 가짜 애니메이션은 아무것도 돌리지 않는다.
  timing = jest
    .spyOn(Animated, 'timing')
    .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
});

afterEach(() => {
  cleanup();
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
  release?.();
  release = null;
});

/** `n` 번째로 만든 애니메이션이 **시작됐는가** — 설정만 만들고 `.start()` 를 빼먹은 층은 움직이지 않는다. */
const startedCount = (n: number): number => timing.mock.results[n].value.start.mock.calls.length;

/** 층 안에서 `useLayerClose()` 가 돌려주는 것을 시험이 붙든다. */
let layerClose: (() => void) | null = null;
function Probe(): React.JSX.Element {
  layerClose = useLayerClose();
  return <Text>층</Text>;
}

async function mount(props: {enter?: 'rise' | 'push'}, reduceMotion = false) {
  release = await pinReduceMotion(reduceMotion);
  const onBack = jest.fn();
  const utils = render(
    <EdgeSwipeBack onBack={onBack} enter={props.enter}>
      <Probe />
    </EdgeSwipeBack>,
  );
  return {onBack, ...utils};
}

/** 층이 지금 그려지는 변환 — 호스트 뷰에 풀려 내려온 숫자다. */
const transformOf = () =>
  Object.assign(
    {},
    ...(StyleSheet.flatten(screen.getByTestId('edge-swipe-pane').props.style).transform as object[]),
  ) as {translateX?: number; translateY?: number};

describe('사다리 안의 값', () => {
  it('시간은 사다리 칸이고 사라짐이 나타남보다 짧다', () => {
    // 200 = modal-open · 150 = modal-close · 240 = standard · 180 = fast (README §2.6).
    expect([LAYER_RISE_MS, LAYER_SINK_MS, LAYER_PUSH_MS, LAYER_POP_MS]).toEqual([200, 150, 240, 180]);
    expect(LAYER_SINK_MS).toBeLessThan(LAYER_RISE_MS);
    expect(LAYER_POP_MS).toBeLessThan(LAYER_PUSH_MS);
  });
});

describe('들어옴', () => {
  it('enter 를 안 준 층은 움직이지 않는다 — 변환은 가장자리 밀기의 translateX 하나뿐이다', async () => {
    await mount({});
    expect(timing).not.toHaveBeenCalled();
    expect(transformOf()).toEqual({translateX: 0});
  });

  it('rise: 화면 아래(화면 높이)에서 시작해 0 으로 올라온다 — 200ms, 강한 ease-out', async () => {
    await mount({enter: 'rise'});
    // 첫 프레임은 화면 밖이다 — 올라오기 전에 자리에 한 프레임 서 있지 않는다.
    expect(transformOf()).toEqual({translateX: 0, translateY: HEIGHT});
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: LAYER_RISE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    expect(startedCount(0)).toBe(1); // 시킨 것이 실제로 시작됐다
  });

  it('push: 화면 오른쪽 밖(화면 너비)에서 시작해 0 으로 밀려 들어온다 — 240ms, 세로로는 움직이지 않는다', async () => {
    await mount({enter: 'push'});
    expect(transformOf()).toEqual({translateX: WIDTH});
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: 0,
      duration: LAYER_PUSH_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    expect(startedCount(0)).toBe(1);
  });

  it.each(['rise', 'push'] as const)('동작 줄이기(%s): 처음부터 자리에 서고 애니메이션이 하나도 없다', async enter => {
    await mount({enter}, true);
    expect(timing).not.toHaveBeenCalled();
    expect(transformOf().translateX).toBe(0);
    expect(transformOf().translateY ?? 0).toBe(0);
  });
});

describe('나감 — 들어온 길의 반대', () => {
  it('rise: 화면 높이만큼 내려가고(150ms), onBack 은 타이머가 한 번 부른다', async () => {
    const {onBack} = await mount({enter: 'rise'});
    timing.mockClear();
    act(() => layerClose?.());
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: HEIGHT,
      duration: LAYER_SINK_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    expect(startedCount(timing.mock.calls.length - 1)).toBe(1);
    // 움직이는 동안에는 아직 걷히지 않는다.
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(LAYER_SINK_MS - 1);
    });
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('push: 화면 너비만큼 오른쪽으로 물러나고(180ms) 그 뒤에 onBack 이다', async () => {
    const {onBack} = await mount({enter: 'push'});
    timing.mockClear();
    act(() => layerClose?.());
    expect(timing.mock.calls[0][1]).toMatchObject({
      toValue: WIDTH,
      duration: LAYER_POP_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    expect(startedCount(timing.mock.calls.length - 1)).toBe(1);
    act(() => {
      jest.advanceTimersByTime(LAYER_POP_MS - 1);
    });
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('두 번 불러도 한 번만 나간다 — 움직임도 onBack 도 한 번', async () => {
    const {onBack} = await mount({enter: 'rise'});
    timing.mockClear();
    act(() => {
      layerClose?.();
      layerClose?.();
    });
    act(() => {
      jest.advanceTimersByTime(LAYER_SINK_MS * 3);
    });
    expect(timing).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each(['rise', 'push'] as const)('동작 줄이기(%s): 부르는 즉시 onBack 이고 움직임이 없다', async enter => {
    const {onBack} = await mount({enter}, true);
    act(() => layerClose?.());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(timing).not.toHaveBeenCalled();
  });

  it('enter 를 안 준 층: 부르는 즉시 onBack 이다 — 지금까지와 같다', async () => {
    const {onBack} = await mount({});
    act(() => layerClose?.());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(timing).not.toHaveBeenCalled();
  });

  it('나가는 도중에 언마운트되면 onBack 을 부르지 않는다 — 타이머가 새지 않는다', async () => {
    const {onBack, unmount} = await mount({enter: 'rise'});
    act(() => layerClose?.());
    unmount();
    act(() => {
      jest.advanceTimersByTime(LAYER_SINK_MS * 3);
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('층 밖에서는 useLayerClose 가 null 이다 — 부르는 쪽이 제 onBack 으로 물러선다', () => {
    let seen: unknown = 'unset';
    function Outside() {
      seen = useLayerClose();
      return <Text>밖</Text>;
    }
    render(<Outside />);
    expect(seen).toBeNull();
  });
});

describe('나가는 동안 가장자리 밀기는 두 번째 onBack 을 만들지 못한다', () => {
  it('평소에는 가장자리에서 밀면 잡히고, 나가는 중에는 잡히지 않는다', async () => {
    const {onBack} = await mount({enter: 'push'});
    // 대조군: 아무 일 없을 때는 같은 손동작이 층을 잡는다 — 이게 없으면 아래 「안 잡힌다」는 헛단정이다.
    const first = finger(pane());
    first.down(6, 400);
    expect(first.move(6 + ACTIVATE_PX, 400)).toBe(true);
    first.up();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    onBack.mockClear();

    act(() => layerClose?.());
    const second = finger(pane());
    second.down(6, 400);
    expect(second.move(6 + ACTIVATE_PX, 400)).toBe(false);
    act(() => {
      jest.advanceTimersByTime(LAYER_POP_MS * 3);
    });
    expect(onBack).toHaveBeenCalledTimes(1); // 나가는 한 번뿐
  });
});
