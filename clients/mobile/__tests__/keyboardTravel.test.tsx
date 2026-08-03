import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, Keyboard, Text} from 'react-native';

import {useKeyboard} from '../src/lib/useKeyboard';

// =============================================================================
// 컴포저가 키보드와 **함께** 올라오는가.
//
// 성재, iPhone 17 / iOS 26.5.1: "채팅창을 누르면 올라오긴 하는데, 키보드보다
// 늦게 올라오는 딜레이가 있어."
//
// 이전 판본은 `keyboardWillShow` + `LayoutAnimation` 이었고, 그것으로 충분하지
// 않았다. 이유는 `LayoutAnimation` 이 New Architecture 에서 무시되기 때문이
// **아니다** — 이 버전의 `ReactNativeFeatureFlagsDefaults.h` 는
// `enableLayoutAnimationsOnIOS() -> true` 이고 `RCTScheduler.mm` 이 그 플래그
// 아래에서 `LayoutAnimationDriver` 를 만든다. 애니메이션은 돈다.
//
// 늦은 것은 **시작 시점**이다. `configureNext` 는 다음 커밋을 무장시킬 뿐이라
// 실제 순서가 이랬다:
//
//     keyboardWillShow → setState → render → commit → 그제서야 애니메이션
//
// 그 줄 전체가 iOS 가 이미 키보드를 밀고 있는 동안 벌어진다. 그래서 이 파일이
// 재는 것은 도착지가 아니라 **출발**이다: 이벤트가 도착한 그 순간, 커밋을
// 기다리지 않고 이동이 시작됐는가.
//
// (도착지 0px 은 이미 `measure/` 가 재고 있었고, 그것만 재던 것이 이 결함을
// 놓친 이유다. 여정을 재지 않으면 여정의 버그는 영원히 보이지 않는다.)
// =============================================================================

function Probe(): React.JSX.Element {
  const keyboard = useKeyboard();
  return (
    <>
      <Text testID="height">{String(keyboard.height)}</Text>
      <Text testID="visible">{String(keyboard.visible)}</Text>
    </>
  );
}

type Emitter = {emit: (event: string, payload: unknown) => void};

function emitter(): Emitter {
  return (Keyboard as unknown as {_emitter: Emitter})._emitter;
}

function frame(height: number, duration = 250) {
  return {
    endCoordinates: {height, screenX: 0, screenY: 0, width: 390},
    duration,
    easing: 'keyboard',
  };
}

let timing: jest.SpyInstance;

beforeEach(() => {
  // Inert: what is under test is that the animation is STARTED, with which
  // config, and at which moment. Letting a real one run would keep driving
  // `requestAnimationFrame` after the test environment is torn down, which
  // reports as a teardown error rather than as anything about this file.
  timing = jest.spyOn(Animated, 'timing').mockImplementation(
    () =>
      ({
        start: jest.fn(),
        stop: jest.fn(),
        reset: jest.fn(),
      } as unknown as Animated.CompositeAnimation),
  );
});

afterEach(() => {
  timing.mockRestore();
  cleanup();
});

describe('이동은 이벤트에서 시작한다 — 커밋을 기다리지 않는다', () => {
  it('willShow 가 도착한 그 순간 애니메이션이 시작된다', () => {
    render(<Probe />);
    timing.mockClear();

    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });

    // 렌더가 아니라 리스너에서 시작됐다는 것을, 호출이 이미 있었다는 사실로 본다.
    expect(timing).toHaveBeenCalledTimes(1);
    const [, config] = timing.mock.calls[0];
    expect(config.toValue).toBe(336);
    // 지속시간은 지어내지 않는다 — iOS 가 준 값을 그대로 탄다.
    expect(config.duration).toBe(250);
  });
});

// =============================================================================
// 그리고 **이동 자체가 JS 스레드를 안 탄다** (성재 두 번째 보고: "1 여전히 느려")
//
// 위의 것은 출발을 고쳤고, 그것만으로는 부족했다. RN 0.86 의
// `src/private/animated/createAnimatedPropsHook.js` 가 스스로 적어 둔 대로, JS
// 드라이버는 콜백을 **매 프레임** 부르고 Fabric 호스트에서는 그 콜백이 매 프레임
// `setNativeProps` + 48ms 마다 React 커밋이다. 키보드가 올라오는 순간은 하필
// 이 클라가 제일 바쁜 순간(멘션 재필터 + 리스트 리렌더)이라 그 큐가 그대로
// 지연이 된다.
//
// 네이티브 드라이버로 넘기면 같은 콜백이 **끝날 때 한 번** 불린다. 그래서 이
// 파일이 지키는 것은 플래그 하나가 아니라 그 계약이다 — 되돌리면 여기가 빨개진다.
// =============================================================================

describe('이동은 UI 스레드에서 돈다', () => {
  it('네이티브 드라이버로 시작한다', () => {
    render(<Probe />);
    timing.mockClear();

    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });

    expect(timing.mock.calls[0][1].useNativeDriver).toBe(true);
  });

  it('내려갈 때도 마찬가지다 — 한쪽만 네이티브면 값이 두 드라이버를 오간다', () => {
    // `Animated.Value` 는 한 번 네이티브로 올라가면 네이티브에 산다. 숨길 때만
    // JS 드라이버로 돌리면 다음 애니메이션에서 RN 이 예외를 던진다 — 느린 게
    // 아니라 크래시다.
    render(<Probe />);
    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });
    timing.mockClear();

    act(() => {
      emitter().emit('keyboardWillHide', frame(0));
    });
    expect(timing.mock.calls[0][1].useNativeDriver).toBe(true);
  });

  it('키보드가 준 duration 을 그대로 쓴다', () => {
    render(<Probe />);
    timing.mockClear();
    act(() => {
      emitter().emit('keyboardWillShow', frame(300, 420));
    });
    expect(timing.mock.calls[0][1].duration).toBe(420);
  });

  it('duration 이 0 이어도 한 프레임은 준다', () => {
    render(<Probe />);
    timing.mockClear();
    act(() => {
      emitter().emit('keyboardWillShow', frame(300, 0));
    });
    expect(timing.mock.calls[0][1].duration).toBeGreaterThan(0);
  });
});

describe('did 짝은 다를 때만 말한다', () => {
  it('willShow 와 같은 높이의 didShow 는 아무것도 다시 시작하지 않는다', () => {
    // 같은 값으로 한 번 더 세팅하면 바뀐 것 없이 커밋만 한 번 더 예약된다 —
    // 한 프레임 늦을 기회를 한 번 더 만드는 것이다.
    render(<Probe />);
    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });
    timing.mockClear();

    act(() => {
      emitter().emit('keyboardDidShow', frame(336));
    });
    expect(timing).not.toHaveBeenCalled();
  });

  it('높이가 실제로 달라지면 따라간다 (하드웨어 키보드)', () => {
    render(<Probe />);
    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });
    timing.mockClear();

    act(() => {
      emitter().emit('keyboardDidShow', frame(64));
    });
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0][1].toValue).toBe(64);
  });
});

describe('올라온 상태는 즉시 참이다', () => {
  it('visible 은 도착이 아니라 출발에서 뒤집힌다', () => {
    // 안전영역 인셋 결정이 이 값에 달려 있다. 애니메이션이 끝난 뒤에 뒤집히면
    // 이동하는 250ms 내내 홈 인디케이터 여백을 이중으로 낸다.
    render(<Probe />);
    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });
    expect(screen.getByTestId('visible').props.children).toBe('true');
    expect(screen.getByTestId('height').props.children).toBe('336');
  });

  it('내려갈 때도 마찬가지다', () => {
    render(<Probe />);
    act(() => {
      emitter().emit('keyboardWillShow', frame(336));
    });
    act(() => {
      emitter().emit('keyboardWillHide', frame(0));
    });
    expect(screen.getByTestId('visible').props.children).toBe('false');
  });
});
