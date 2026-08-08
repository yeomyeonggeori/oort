import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Keyboard, Text, View} from 'react-native';

import {ConversationLayout} from '../src/features/conversation/ConversationLayout';

// =============================================================================
// 컴포저를 밀어 올리는 것이 **레이아웃 속성이 아니고, 이제 JavaScript 도 아니다.**
//
// 취향이 아니라 스레드 문제다. `paddingBottom` 은 Yoga 로 들어가는 레이아웃
// 속성이라 네이티브 드라이버를 못 쓴다 — RN 0.86 의
// `src/private/animated/createAnimatedPropsHook.js` 가 적어 둔 대로 JS 드라이버는
// 콜백을 매 프레임 부르고, Fabric 에서는 그것이 매 프레임 `setNativeProps` 와
// 48ms 마다 React 커밋이 된다. 게다가 padding 은 위에 얹힌 `FlatList` 까지 매
// 프레임 다시 재게 만든다. 그래서 goal RN-P2 가 transform 으로 옮겼다.
//
// 그때 남은 절반이 **점화**였다. transform 은 네이티브 드라이버가 굴렸지만 시작
// 신호는 여전히 `keyboardWillShow` 라는 JS 콜백이었고, 키보드가 올라오는 순간은
// 하필 이 클라가 제일 바쁜 순간이다(멘션 재필터 + 리스트 리렌더). goal RN-P3 이
// 그 절반을 `modules/momo-keyboard-native` 로 내렸다 — 팬이 UIKit 알림을 직접
// 듣고 자기 transform 을 메인 스레드에서 애니메이션한다.
//
// 그래서 이 파일이 지키는 것은 셋이고, 하나라도 어기면 결함이 그대로 돌아온다:
//
//   1. 안 움직이는 것(패딩)은 상수다.
//   2. **JS 는 transform 스타일을 걸지 않는다.** 걸면 RN 이
//      (`RCTViewComponentView.mm:350-360`) 그 prop 이 바뀔 때마다
//      `layer.transform` 을 도로 써 버리고, 네이티브가 올려 둔 리프트를 지운다.
//   3. 키보드 이벤트는 이 레이아웃에서 **아무 JS 작업도 일으키지 않는다.**
//
// 시뮬레이터·실기기 수치(첫 이동 ms, 컴포저–키보드 간격 0px)는 여기서 못 잰다 —
// `measure/` 가 네이티브 계측기로 잰다. 여기서 지키는 것은 그 수치가 나올 수 있는
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

/** The style array the pane was given, flattened into one object. */
function paneStyle(): Record<string, unknown> {
  const style = screen.getByTestId('conversation-layout').props.style;
  const parts: unknown[] = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...parts.filter(part => part && typeof part === 'object'));
}

afterEach(cleanup);

it('패딩은 상수다 — 애니메이션 값이 레이아웃으로 새지 않는다', () => {
  mount();
  // 이 테스트 환경의 안전영역 인셋은 0. 중요한 것은 값이 아니라 **숫자라는
  // 것**이다: `Animated.Value` 나 그 보간이 여기 있으면 매 프레임 JS 를 태우는 그
  // 결함이 되돌아온 것이다.
  expect(typeof paneStyle().paddingBottom).toBe('number');
});

it('JS 는 transform 을 걸지 않는다 — 리프트는 네이티브의 것이다', () => {
  // 이것이 이 배치의 계약이다. RN 은 `transform` prop 이 바뀔 때만
  // `layer.transform` 을 쓰는데, 여기서 한 번이라도 걸면 그 prop 은 더 이상 비어
  // 있지 않고, 이후 커밋이 네이티브가 올려 둔 리프트를 지울 수 있게 된다.
  mount();
  expect(paneStyle().transform).toBeUndefined();
});

it('네이티브가 계산할 수 있도록 안전영역 인셋을 넘긴다', () => {
  // 리프트는 `키보드 높이 - bottomInset` 이다. 이 값이 안 넘어가면 이미 홈
  // 인디케이터를 덮고 있는 키보드 위에 그 여백이 한 번 더 쌓인다.
  mount();
  expect(
    typeof screen.getByTestId('conversation-layout').props.bottomInset,
  ).toBe('number');
});

it('키보드 이벤트는 이 레이아웃에서 아무 일도 일으키지 않는다', () => {
  // 점화가 네이티브로 갔다는 것의 JS 쪽 증거. 예전 판본은 이 이벤트로
  // `useKeyboard` 의 상태를 바꿨고, 그 상태 변화가 곧 렌더였다. 지금은 스타일이
  // **글자 그대로 같은 객체**여야 한다 — 다시 만들어졌다면 렌더가 돈 것이다.
  mount();
  const before = screen.getByTestId('conversation-layout').props.style;

  act(() => {
    emitter().emit('keyboardWillShow', frame(336));
  });

  expect(screen.getByTestId('conversation-layout').props.style).toBe(before);
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
