import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, Dimensions, StyleSheet} from 'react-native';

import {COMPOSER_EXPAND_SPRING} from '../src/design/motion';
import {line, TOUCH_TARGET} from '../src/design/tokens';
import {Composer, INPUT_CHROME} from '../src/features/conversation/Composer';
import {createDockFollow, DockFollowContext, type DockFollow} from '../src/features/conversation/dockFollow';
import {channelDraftKey, saveDraft} from '../src/features/conversation/drafts';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// 대화 목록을 눌러 입력창을 쉬게 한다 (#4614) — 입력창 쪽의 몫.
//
// 이 규칙은 #4456 이 정한 「글이 남아 있으면 포커스를 잃어도 펼친 채다」를 **한 길에서만** 깬다(owner 10-26): 목록을 눌러 쉬게 하면 글이 있어도 접힌다. 접힌 알약은 같은 입력창이
// 첫 줄 하나만 보이는 모양이고, 글은 지워지지도 옮겨지지도 않는다. 그 글에 **한해서**다 — 한 글자라도 바뀌면 이 규칙이다. 포커스가 오면(다시 누르면) 같은 자리에서 펼친다.
//
// 목록 쪽(탭 판정 → `Keyboard.dismiss()` → `dockFollow.rest()`)은 `listTapDismiss4614.test.tsx` 다. 여기서는 그 알림(`bridge.rest()`)을 직접 보낸다. 실제 길에서는 자판을 내리는
// `Keyboard.dismiss()` 가 먼저 불리고 네이티브 `onBlur` 가 JS 에 닿는 것이 알림보다 **앞일 수도 뒤일 수도 있다**(행 탭은 손 뗌에서 이미 내렸다) — 두 순서를 다 잰다.
//
// 이 파일의 단정은 전부 **렌더 결과**(도구 줄이 있나, 입력창의 높이·여백·`scrollEnabled`, 값, `Animated.spring` 호출)를 읽는다. 사보타주 표는 PR 본문.
// =============================================================================

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};

const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;

const fontScale = () => Dimensions.get('window').fontScale;
/** 시험이 독립적으로 도출한 접힘 높이(엄지 바닥 이상의 한 줄 + 세로 크롬). */
const collapsed = () => Math.max(TOUCH_TARGET, Math.ceil(line.body * fontScale()) + INPUT_CHROME);
/** 첫 줄의 아랫선까지: 위 여백(패딩 + 테두리 = 크롬의 절반) + 한 줄. */
const firstLineBox = () => INPUT_CHROME / 2 + Math.ceil(line.body * fontScale());

const input = () => screen.getByTestId('composer-input');
const inputStyle = () => flat(input().props.style);
const hasTools = () => screen.queryByTestId('composer-tools') !== null;
const toolsHeight = () => Number(flat(screen.getByTestId('composer-tools').props.style).height);
const focus = () => fireEvent(input(), 'focus');
const blur = () => fireEvent(input(), 'blur');
const settle = () =>
  act(() => {
    jest.advanceTimersByTime(500);
  });
const advance = (frames = 1) =>
  act(() => {
    jest.advanceTimersByTime(16 * frames);
  });

let bridge: DockFollow;
/** 목록이 입력창에 보내는 알림(`Timeline.onListTap` 의 `dockFollow.rest()`). */
const rest = () => act(() => bridge.rest());

function tree(over: Partial<React.ComponentProps<typeof Composer>> = {}, dock: DockFollow | null = bridge) {
  const composer = (
    <Composer
      recipient="place"
      channelLabel="배포"
      directory={makeDirectory([])}
      attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
      onSend={() => {}}
      {...over}
    />
  );
  return dock === null ? composer : <DockFollowContext.Provider value={dock}>{composer}</DockFollowContext.Provider>;
}

function mount(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(tree(over));
}

/** 「동작 줄이기」의 답(프라미스)이 도착할 때까지 진짜 타이머로 기다린 뒤 가짜 타이머로 돌아온다(`composerTwoState.test.tsx` 와 같은 이유). */
async function mountSettled(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  jest.useRealTimers();
  const view = mount(over);
  await act(async () => {});
  jest.useFakeTimers();
  return view;
}

/** `jest.setup.js` 의 전역 MMKV 목은 파일 안의 케이스 사이에 상태를 이어 간다 — 초안을 쓰는 케이스는 자기 저장소로 시작한다. */
function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

beforeEach(() => {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  jest.useFakeTimers();
  bridge = createDockFollow();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** 포커스를 쥔 채 글을 쓴 입력창을 끝값(펼침)에 앉힌다. 대조 단정이 여기서 선다 — 펼침이 아니면 아래 「접힘」 단정은 쉬라는 알림 없이도 통과한다. */
function typeAndSettle(text = '쓰던 글') {
  focus();
  fireEvent.changeText(input(), text);
  settle();
  expect(hasTools()).toBe(true);
  expect(inputStyle().height).toBeUndefined();
  expect(input().props.scrollEnabled).not.toBe(false);
}

describe('쉬라는 알림 — 글이 있어도 접힌다 (#4456 의 「글이 남으면 펼친 채」를 이 한 길에서만 깬다)', () => {
  it('알림 → 블러: 도구 줄이 사라지고 입력창은 첫 줄 하나, 글은 그대로, 알약 높이는 안 변한다', () => {
    mount();
    typeAndSettle();
    rest();
    blur();
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글');
    // 첫 줄의 아랫선까지만: 둘째 줄의 윗부분이 알약에 걸려 잘려 보이지 않는다(시뮬레이터 실측).
    expect(inputStyle().height).toBe(firstLineBox());
    expect(inputStyle().paddingBottom).toBe(0);
    // 남는 높이는 입력창 **밖**이다 — 알약은 빈 접힘과 같은 높이이고 첫 줄은 그 가운데에 선다.
    const {marginTop = 0, marginBottom = 0} = inputStyle() as {marginTop?: number; marginBottom?: number};
    expect(Number(marginTop) + Number(inputStyle().height) + Number(marginBottom)).toBe(collapsed());
    expect(Math.abs(Number(marginTop) + INPUT_CHROME / 2 + Math.ceil(line.body * fontScale()) / 2 - collapsed() / 2)).toBeLessThanOrEqual(0.5);
    // 입력창 안의 스크롤은 쉰다: 끝 쪽으로 스크롤된 채 줄면 첫 줄이 아니라 중간 줄이 알약에 보였다(시뮬레이터 실측).
    expect(input().props.scrollEnabled).toBe(false);
  });

  it('블러 → 알림 순서여도 같다 — 행 탭은 손 뗌에서 이미 자판을 내려서 네이티브 블러가 알림보다 먼저 올 수 있다', () => {
    mount();
    typeAndSettle();
    blur();
    settle();
    // 알림 전에는 #4456 그대로다: 글이 있으니 포커스를 잃어도 펼친 채다. 이 대조가 없으면 아래 「접힘」이 알림 때문인지 알 수 없다.
    expect(hasTools()).toBe(true);
    rest();
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰던 글');
    expect(inputStyle().height).toBe(firstLineBox());
  });

  it('포커스 없이 글만 있어 펼쳐진 입력창(초안 복원)도 알림 한 번에 접힌다 — 블러가 안 와도', () => {
    mount();
    fireEvent.changeText(input(), '쓰다 만 글');
    settle();
    expect(hasTools()).toBe(true); // 전제: 글만으로 펼쳐 있다
    rest();
    settle();
    expect(hasTools()).toBe(false);
    expect(input().props.value).toBe('쓰다 만 글');
    expect(inputStyle().height).toBe(firstLineBox());
  });

  it('글이 없으면 알려도 아무 일도 없다 — 빈 펼침은 포커스를 놓는 블러가 접는다(알림이 접는 것이 아니다)', () => {
    mount();
    focus();
    settle();
    expect(hasTools()).toBe(true);
    rest();
    settle();
    expect(hasTools()).toBe(true); // 아직 포커스를 쥐고 있다 — 자판을 내리는 것은 목록의 `Keyboard.dismiss` 이고 그 블러가 와야 접힌다
    blur();
    settle();
    expect(hasTools()).toBe(false);
    expect(inputStyle().height).toBe(collapsed());
  });

  it('쉬는 글을 보내면 나가고 빈 접힘으로 돌아온다 — 접힌 알약의 보내기 단추가 살아 있다', () => {
    const sent: string[] = [];
    mount({onSend: body => sent.push(body)});
    typeAndSettle('보낼 글');
    rest();
    blur();
    settle();
    expect(hasTools()).toBe(false); // 전제: 접힌 채다
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual(['보낼 글']);
    expect(input().props.value).toBe('');
    expect(hasTools()).toBe(false);
    expect(inputStyle().height).toBe(collapsed());
  });
});

describe('그 글에 한해서다 · 다시 누르면 같은 자리에서 펼친다', () => {
  it('쉰 뒤 글이 한 글자라도 바뀌면 다시 펼침이다 — 쉬는 상태가 다른 글로 새지 않는다', () => {
    mount();
    typeAndSettle();
    rest();
    blur();
    settle();
    expect(hasTools()).toBe(false); // 전제
    fireEvent.changeText(input(), '쓰던 글!');
    expect(hasTools()).toBe(true);
    expect(inputStyle().height).toBeUndefined();
    expect(input().props.scrollEnabled).not.toBe(false);
  });

  it('쉰 뒤 글이 바뀌었다가 같은 글자로 돌아와도 다시 쉬는 초안이 되지 않는다 — 「그 글」의 표식이 낡은 채 남지 않는다', () => {
    mount();
    typeAndSettle();
    rest();
    blur();
    settle();
    expect(hasTools()).toBe(false); // 전제: 쉬는 중
    fireEvent.changeText(input(), '쓰던 글!'); // 포커스 이벤트 없이 글이 바뀐다(초안 복원·붙여넣기 같은 길)
    settle();
    expect(hasTools()).toBe(true);
    fireEvent.changeText(input(), '쓰던 글'); // 같은 글자로 돌아왔다
    settle();
    // 낡은 표식이 남아 있으면 이 글은 쉬는 초안으로 되살아나 접힌 높이·스크롤 잠금으로 선다.
    expect(hasTools()).toBe(true);
    expect(inputStyle().height).toBeUndefined();
    expect(input().props.scrollEnabled).not.toBe(false);
  });

  it('다시 눌러 포커스가 오면 같은 자리에서 펼친다 — 글 그대로, 안의 스크롤도 다시 된다', () => {
    mount();
    typeAndSettle();
    rest();
    blur();
    settle();
    expect(hasTools()).toBe(false); // 전제: 접힌 알약
    focus();
    settle();
    expect(hasTools()).toBe(true);
    expect(input().props.value).toBe('쓰던 글');
    expect(inputStyle().height).toBeUndefined();
    expect(input().props.scrollEnabled).not.toBe(false);
  });

  it('쉬었다 다시 쓴 입력창은 이제 지금처럼이다 — 다른 길(끌어 내리기)로 포커스를 잃으면 글이 있으니 펼친 채다', () => {
    mount();
    typeAndSettle();
    rest();
    blur();
    settle();
    focus();
    settle();
    blur(); // 알림 없이 포커스만 잃는다(끌어서 자판을 내림)
    settle();
    expect(hasTools()).toBe(true);
    expect(inputStyle().height).toBeUndefined();
  });

  it('알림이 없으면 #4456 그대로다: 글이 남은 채 포커스를 잃으면 펼친 채다 — 규칙을 깨는 것은 목록의 알림 하나뿐이다', () => {
    mount();
    typeAndSettle();
    blur();
    settle();
    expect(hasTools()).toBe(true);
    expect(inputStyle().height).toBeUndefined();
  });

  describe('방이 바뀌면 쉬던 초안도 풀린다', () => {
    beforeEach(() => __setNonSecretStore(memoryStore()));
    afterEach(() => __setNonSecretStore(null));

    it('같은 글자의 초안이 다른 방에서 복원돼도 접힌 채 오지 않는다 — 그 방은 그 방의 규칙이다', () => {
      const keyA = channelDraftKey('ch-a');
      const keyB = channelDraftKey('ch-b');
      saveDraft(keyA, '같은 글');
      saveDraft(keyB, '같은 글');
      const view = mount({draftKey: keyA});
      settle();
      expect(input().props.value).toBe('같은 글');
      expect(hasTools()).toBe(true); // 전제: 복원된 초안은 펼침이다(#4456)
      rest();
      settle();
      expect(hasTools()).toBe(false); // 전제: 쉰다
      view.rerender(tree({draftKey: keyB}));
      settle();
      expect(input().props.value).toBe('같은 글');
      expect(hasTools()).toBe(true);
    });
  });
});

describe('접히는 움직임 — 포커스를 잃어서 접힐 때와 같은 스프링이 거꾸로 한 번 돈다 (한 프레임에 알약이 줄지 않는다)', () => {
  const ours = (spring: jest.SpyInstance) =>
    spring.mock.calls.filter(
      call => call[1]?.stiffness === COMPOSER_EXPAND_SPRING.stiffness && call[1]?.useNativeDriver === false,
    );

  it.each([
    ['알림 → 블러', () => { rest(); blur(); }],
    ['블러 → 알림', () => { blur(); rest(); }],
  ] as const)('%s: toValue 0 스프링이 한 번 돌고, 끝나기 전에는 도구 줄이 아직 서 있다', async (_name, play) => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    fireEvent.changeText(input(), '쓰던 글');
    settle();
    expect(ours(spring)).toHaveLength(1); // 전제: 펼침이 한 번 걸었다
    play();
    expect(ours(spring)).toHaveLength(2);
    expect(ours(spring)[1]?.[1]).toMatchObject({toValue: 0, ...COMPOSER_EXPAND_SPRING, overshootClamping: true, useNativeDriver: false});
    // 쉬라는 알림이 온 그 렌더는 아직 펼친 모양이다 — 접힌 모양이 한 프레임 그려졌다 되살아나지 않는다.
    expect(hasTools()).toBe(true);
    expect(toolsHeight()).toBe(TOUCH_TARGET);
    settle();
    expect(hasTools()).toBe(false);
    expect(ours(spring)).toHaveLength(2); // 끝난 뒤에는 더 안 건다
  });

  it('프레임마다: 도구 줄 높이는 TOUCH_TARGET 에서 0 으로 단조롭게 내려가고 음수가 없다(대화 목록이 출렁일 길이 없다)', async () => {
    await mountSettled();
    focus();
    fireEvent.changeText(input(), '쓰던 글');
    settle();
    rest();
    blur();
    const heights: number[] = [];
    for (let frame = 0; frame < 40; frame += 1) {
      advance();
      heights.push(hasTools() ? toolsHeight() : 0);
    }
    expect(heights[0]).toBeLessThan(TOUCH_TARGET); // 움직인다(즉시 접히면 아래 단조가 아무것도 안 잰다)
    expect(heights[0]).toBeGreaterThan(0);
    heights.forEach((height, index) => {
      if (index > 0) expect(height).toBeLessThanOrEqual(heights[index - 1] as number);
    });
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
    expect(heights[heights.length - 1]).toBe(0);
  });

  it('동작 줄이기: 움직임 없이 같은 렌더에서 접힌다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    fireEvent.changeText(input(), '쓰던 글');
    expect(hasTools()).toBe(true); // 전제: 즉시 펼쳐졌다
    rest();
    blur();
    expect(hasTools()).toBe(false);
    expect(ours(spring)).toHaveLength(0);
    expect(input().props.value).toBe('쓰던 글');
  });
});
