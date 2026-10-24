import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, Dimensions, Keyboard, StyleSheet} from 'react-native';

import {
  Composer,
  composerCollapsedHeight,
  INPUT_CHROME,
} from '../src/features/conversation/Composer';
import {line, TOUCH_TARGET} from '../src/design/tokens';

// =============================================================================
// 입력창 두 상태 (#4305) — 접힘(한 줄 알약) ↔ 펼침(글 칸 + 도구 줄)
//
// 펼침의 조건은 **글이 있다** 하나다(포커스가 아니다): 보내서 비는 순간 같은 렌더에서 접힘 높이로 돌아와야
// 하고(owner 10-24, iOS 3053: 보낸 직후 두 줄 높이가 남던 결함), 그것은 키보드가 떠 있어도 — 포커스가 그대로여도 —
// 성립해야 한다.
//
// 이 파일의 단정은 전부 **렌더 결과**(도구 줄이 있나, 입력창의 명시 높이, 햅틱 대역의 호출, `Animated.timing`
// 호출, `Keyboard.dismiss` 호출)를 읽는다. 사보타주 표는 PR 본문.
// =============================================================================

const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;
const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};

const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

function mount(onSend: (body: string) => void = () => {}) {
  return render(
    <Composer
      recipient="place"
      channelLabel="배포"
      directory={makeDirectory([])}
      attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
      onSend={onSend}
    />,
  );
}

const input = () => screen.getByTestId('composer-input');
const inputHeight = () => flat(input().props.style).height;
const hasTools = () => screen.queryByTestId('composer-tools') !== null;
/** 시험이 독립적으로 도출한 접힘 높이 — 글자 배수 곱한 한 줄 + 세로 크롬, 엄지 바닥 이상. */
const collapsed = () =>
  Math.max(TOUCH_TARGET, Math.ceil(line.body * Dimensions.get('window').fontScale) + INPUT_CHROME);

beforeEach(() => {
  hapticCalls.length = 0;
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('접힘 ↔ 펼침', () => {
  it('처음(빈 칸)은 접힘이다: 도구 줄이 없고 입력창 높이가 한 줄로 명시돼 있다', () => {
    mount();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    expect(composerCollapsedHeight(Dimensions.get('window').fontScale)).toBe(collapsed());
  });

  it('글을 치면 펼침이다: 도구 줄과 「@」가 서고 높이는 콘텐츠가 정한다(명시 높이 없음)', () => {
    mount();
    fireEvent.changeText(input(), '가');
    expect(hasTools()).toBe(true);
    expect(screen.getByTestId('composer-tool-mention')).toBeTruthy();
    expect(inputHeight()).toBeUndefined();
  });

  it('두 줄을 쳐서 펼친 뒤 보내면 **같은 렌더에서** 접힘 높이로 돌아온다 (owner 10-24)', () => {
    const sent: string[] = [];
    mount(body => sent.push(body));
    fireEvent.changeText(input(), '첫 줄\n둘째 줄');
    expect(inputHeight()).toBeUndefined();
    expect(hasTools()).toBe(true);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual(['첫 줄\n둘째 줄']);
    expect(input().props.value).toBe('');
    expect(inputHeight()).toBe(collapsed());
    expect(hasTools()).toBe(false);
  });

  it('지워서 비어도 접힘으로 돌아온다', () => {
    mount();
    fireEvent.changeText(input(), '첫 줄\n둘째 줄');
    fireEvent.changeText(input(), '');
    expect(inputHeight()).toBe(collapsed());
    expect(hasTools()).toBe(false);
  });

  it('다시 치면 다시 펼쳐진다(보낸 뒤에도 한 번 접힌 채 굳지 않는다)', () => {
    mount();
    fireEvent.changeText(input(), '하나');
    fireEvent.press(screen.getByTestId('composer-send'));
    fireEvent.changeText(input(), '둘');
    expect(hasTools()).toBe(true);
    expect(inputHeight()).toBeUndefined();
  });

  it('「@」 도구는 끝에 @ 를 붙인다 — 공백 뒤면 그대로, 낱말 뒤면 한 칸 띄운다', () => {
    mount();
    fireEvent.changeText(input(), '안녕 ');
    fireEvent.press(screen.getByTestId('composer-tool-mention'));
    expect(input().props.value).toBe('안녕 @');
    fireEvent.changeText(input(), '안녕');
    fireEvent.press(screen.getByTestId('composer-tool-mention'));
    expect(input().props.value).toBe('안녕 @');
  });
});

describe('햅틱 — 전이 1회 = selection 1회, 보내기 = light 1회', () => {
  it('첫 글자에서 selection 한 번, 펼친 채 치는 동안은 0번', () => {
    mount();
    fireEvent.changeText(input(), '가');
    expect(hapticCalls).toEqual(['selection']);
    fireEvent.changeText(input(), '가나');
    fireEvent.changeText(input(), '가나\n다');
    expect(hapticCalls).toEqual(['selection']);
  });

  it('지워서 비면 selection 한 번 더(접힘 전이)', () => {
    mount();
    fireEvent.changeText(input(), '가');
    fireEvent.changeText(input(), '');
    expect(hapticCalls).toEqual(['selection', 'selection']);
  });

  it('보내기는 light 한 번뿐이다 — 접힘 전이의 selection 이 겹치지 않는다', () => {
    mount();
    fireEvent.changeText(input(), '가');
    hapticCalls.length = 0;
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(hapticCalls).toEqual(['impact:light']);
  });

  it('빈 칸에서는 보내기가 안 울린다', () => {
    mount();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(hapticCalls).toEqual([]);
  });
});

describe('애니메이션 — 펼침 160ms easeOutCubic, 동작 줄이기면 즉시', () => {
  // 화면의 다른 부품(유리 면 등)도 `Animated.timing` 을 부른다 — 이 입력창의 것(160ms · JS 구동)만 센다.
  const ours = (timing: jest.SpyInstance) =>
    timing.mock.calls.filter(
      call => call[1]?.duration === 160 && call[1]?.useNativeDriver === false,
    );
  it('평소: 펼칠 때 Animated.timing 이 160ms 로 한 번 돈다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    mount();
    await act(async () => {});
    fireEvent.changeText(input(), '가');
    expect(ours(timing)).toHaveLength(1);
    expect(ours(timing)[0]?.[1]).toMatchObject({toValue: 1, duration: 160, useNativeDriver: false});
  });

  it('동작 줄이기: 움직임 없이 즉시다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const timing = jest.spyOn(Animated, 'timing');
    mount();
    await act(async () => {}); // 설정의 답이 도착한다
    fireEvent.changeText(input(), '가');
    expect(hasTools()).toBe(true);
    expect(ours(timing)).toHaveLength(0);
  });

  it('접힘은 애니메이션이 아니다: 보내도 timing 이 안 돈다', async () => {
    mount();
    await act(async () => {});
    fireEvent.changeText(input(), '가');
    const timing = jest.spyOn(Animated, 'timing');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(ours(timing)).toHaveLength(0);
  });
});

describe('아래로 끌어 자판 내리기', () => {
  const touch = (pageX: number, pageY: number) => ({nativeEvent: {pageX, pageY}});
  const bar = () => screen.getByTestId('composer-bar');

  it('충분히 아래로 끌면 자판이 한 번 내려간다(더 끌어도 한 번)', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    fireEvent(bar(), 'touchStart', touch(100, 100));
    fireEvent(bar(), 'touchMove', touch(101, 120));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent(bar(), 'touchMove', touch(101, 140));
    fireEvent(bar(), 'touchMove', touch(101, 180));
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent(bar(), 'touchEnd', touch(101, 180));
  });

  it('옆으로 끌거나 위로 끌면 내려가지 않는다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    fireEvent(bar(), 'touchStart', touch(100, 100));
    fireEvent(bar(), 'touchMove', touch(190, 140));
    fireEvent(bar(), 'touchMove', touch(100, 40));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('글자 범위를 잡은 채 끌면(선택 손잡이) 내려가지 않는다 — 글자 선택을 뺏지 않는다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    fireEvent.changeText(input(), '선택할 글');
    fireEvent(input(), 'selectionChange', {nativeEvent: {selection: {start: 0, end: 3}}});
    fireEvent(bar(), 'touchStart', touch(100, 100));
    fireEvent(bar(), 'touchMove', touch(100, 200));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('글이 상한을 넘겨 안에서 스크롤되는 중이면 내려가지 않는다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    fireEvent.changeText(input(), '긴 글');
    fireEvent(input(), 'contentSizeChange', {nativeEvent: {contentSize: {width: 200, height: 4000}}});
    fireEvent(bar(), 'touchStart', touch(100, 100));
    fireEvent(bar(), 'touchMove', touch(100, 200));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('한 번 끌고 뗀 뒤 다시 끌면 또 내려간다', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    for (let i = 0; i < 2; i += 1) {
      fireEvent(bar(), 'touchStart', touch(100, 100));
      fireEvent(bar(), 'touchMove', touch(100, 160));
      fireEvent(bar(), 'touchEnd', touch(100, 160));
    }
    expect(dismiss).toHaveBeenCalledTimes(2);
  });
});
