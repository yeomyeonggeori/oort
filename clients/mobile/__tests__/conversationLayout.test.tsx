import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Keyboard, Text, View} from 'react-native';

import {ConversationLayout} from '../src/features/conversation/ConversationLayout';

// =============================================================================
// 컴포저를 밀어 올리는 것이 **레이아웃 속성이 아니다.**
//
// 이것은 취향이 아니라 스레드 문제다. `paddingBottom` 은 Yoga 로 들어가는 레이아웃
// 속성이라 네이티브 드라이버를 못 쓴다 — RN 0.86 의
// `src/private/animated/createAnimatedPropsHook.js` 가 적어 둔 대로 JS 드라이버는
// 콜백을 매 프레임 부르고, Fabric 에서는 그것이 매 프레임 `setNativeProps` 와
// 48ms 마다 React 커밋이 된다. 게다가 padding 은 위에 얹힌 `FlatList` 까지 매
// 프레임 다시 재게 만든다.
//
// `transform: translateY` 는 레이아웃 속성이 아니다. 그래서 이 파일이 지키는 것은
// 두 가지다: 움직이는 것이 transform 이라는 것과, 안 움직이는 것(패딩)이 상수라는
// 것. 둘 중 하나만 어겨도 결함이 그대로 돌아온다.
//
// 실기기 수치(첫 이동/도착 ms, 컴포저–키보드 간격 0px)는 여기서 못 잰다 —
// `measure/` 가 시뮬레이터에서 잰다. 여기서 지키는 것은 그 수치가 나올 수 있는
// **구조**다.
// =============================================================================

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

function mount() {
  return render(
    <ConversationLayout
      list={<Text testID="list-slot">목록</Text>}
      composer={<View testID="composer-slot" />}
    />,
  );
}

/** The style array `Animated.View` was given, flattened into one object. */
function layoutStyle(): Record<string, unknown> {
  const style = screen.getByTestId('conversation-layout').props.style;
  const parts: unknown[] = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...parts.filter(part => part && typeof part === 'object'));
}

afterEach(cleanup);

it('움직이는 것은 transform 이다', () => {
  mount();
  const style = layoutStyle();
  expect(style.transform).toBeDefined();
  const [entry] = style.transform as {translateY: unknown}[];
  expect(entry).toHaveProperty('translateY');
});

it('패딩은 상수다 — 애니메이션 값이 레이아웃으로 새지 않는다', () => {
  mount();
  const style = layoutStyle();
  // 이 테스트 환경의 안전영역 인셋은 0(jest.setup.js 가 그렇게 두는 이유는 거기에
  // 적혀 있다). 중요한 것은 값이 아니라 **숫자라는 것**이다: `Animated.Value` 나
  // 그 보간이 여기 있으면 매 프레임 JS 를 태우는 그 결함이 되돌아온 것이다.
  expect(typeof style.paddingBottom).toBe('number');
});

it('키보드가 올라와도 패딩은 여전히 상수다', () => {
  mount();
  act(() => {
    emitter().emit('keyboardWillShow', frame(336));
  });
  expect(typeof layoutStyle().paddingBottom).toBe('number');
});

it('올라간 패널의 위쪽은 잘린다 — 헤더 위로 대화가 흐르지 않는다', () => {
  // transform 은 부모 경계를 넘어 그려진다. 키보드 높이만큼 들어 올리는 패널의
  // 위쪽을 아무도 자르지 않으면, 그 대화는 자기 위의 헤더를 덮는다.
  mount();
  const clip = screen.getByTestId('conversation-clip').props.style;
  const parts: unknown[] = Array.isArray(clip) ? clip.flat(Infinity) : [clip];
  const flat: Record<string, unknown> = Object.assign(
    {},
    ...parts.filter(part => part && typeof part === 'object'),
  );
  expect(flat.overflow).toBe('hidden');
});

it('컴포저와 목록은 둘 다 그 안에 있다', () => {
  // 패널이 통째로 움직인다는 것의 다른 쪽 절반: 목록이 밖에 남으면 컴포저만
  // 올라가고 목록의 마지막 줄은 키보드 뒤로 들어간다.
  mount();
  expect(screen.getByTestId('list-slot')).toBeTruthy();
  expect(screen.getByTestId('composer-dock')).toBeTruthy();
  expect(screen.getByTestId('composer-slot')).toBeTruthy();
});
