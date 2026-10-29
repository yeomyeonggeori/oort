// composer — 입력창 (Composer)
// 합친 원본: composerHaptics4331.test.tsx, composerRest4614.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import {makeDirectory} from '@momo/core/features/workspace/directory';
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
  Animated,
  Dimensions,
  type TextInput,
} from 'react-native';

import {Composer, INPUT_CHROME} from '../src/features/conversation/Composer';
import {COMPOSER_EXPAND_SPRING} from '../src/design/motion';
import {line, TOUCH_TARGET} from '../src/design/tokens';
import {createDockFollow, DockFollowContext, type DockFollow} from '../src/features/conversation/dockFollow';
import {channelDraftKey, saveDraft} from '../src/features/conversation/drafts';
import {__setNonSecretStore} from '../src/storage/kv';
import {drainRender, flat} from './testkit';

// =============================================================================
// 합친 시험: 원래 composerHaptics4331.test.tsx (#4331)
// =============================================================================
describe('composerHaptics (#4331)', () => {
  // =============================================================================
  // 입력하는 동안 햅틱이 울리지 않는다 (#4331)
  //
  // 실기(3053): 「채팅을 치면 진동하면서 …」. 대화 화면에서 햅틱을 부르는 코드는 `Composer` 의 **첨부 + 누름** 하나뿐이다
  // (`haptics.light()`, 누르는 순간 한 번). 글자를 치고 줄을 바꾸고 보내는 길에는 없다 — 그래서 입력 중의 진동은 앱이 낸 것이 아니라
  // iOS 의 키보드 햅틱(설정 ▸ 소리 및 햅틱 ▸ 키보드 피드백)이거나 화면 떨림이다.
  //
  // 이 시험은 그 사실을 **빨개질 수 있게** 잠근다: 같은 대역(`expo-haptics`)이 첨부 누름에서는 정확히 한 번 울리는 것을 먼저 보인 뒤,
  // 치고·줄을 바꾸고·보내는 동안에는 한 번도 울리지 않음을 단정한다. 입력 길에 햅틱 호출이 생기면 붉어진다.
  // =============================================================================

  const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;

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

  beforeEach(() => {
    hapticCalls.length = 0;
  });

  afterEach(drainRender);

  describe('입력 길의 햅틱은 보내기 light 한 번뿐이다 (#4331 → #4305)', () => {
    it('대조: 첨부 + 를 누르면 햅틱이 정확히 한 번 울린다 — 이 대역이 울림을 셀 수 있다', () => {
      mount();
      fireEvent.press(screen.getByTestId('composer-attach'));
      expect(hapticCalls).toHaveLength(1);
    });

    it('치고 · 줄을 바꾸고 · 지우고 · 접고 펴는 동안 0번, 보내기만 light 한 번', () => {
      const sent: string[] = [];
      mount(body => sent.push(body));
      const input = screen.getByTestId('composer-input');
      // #4305: 접힘 ↔ 펼침 전이(첫 글자·비움)에도 울리지 않는다 — 입력 중 진동은 0번이다.
      fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요');
      expect(hapticCalls).toHaveLength(0);
      fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n그 전에 시안부터 확인해 주세요');
      fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n그 전에 시안부터 확인해 주세요\n끝나면 여기에 남겨 둘게요');
      fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요');
      fireEvent.changeText(input, '금요일 배포는 오후로 미룰게요\n한 줄 더');
      expect(hapticCalls).toHaveLength(0);
      fireEvent.press(screen.getByTestId('composer-send'));
      expect(sent).toEqual(['금요일 배포는 오후로 미룰게요\n한 줄 더']);
      // 보내기 = light 한 번뿐.
      expect(hapticCalls).toEqual(['impact:light']);
    });
  });
});

// =============================================================================
// 합친 시험: 원래 composerRest4614.test.tsx (#4614)
// =============================================================================
describe('composerRest (#4614)', () => {
  // =============================================================================
  // 대화 목록을 눌러 입력창을 쉬게 한다 (#4614) — 입력창 쪽의 몫.
  //
  // 이 규칙은 #4456 이 정한 「글이 남아 있으면 포커스를 잃어도 펼친 채다」를 **한 길에서만** 깬다(owner 10-26): 목록을 눌러 쉬게 하면 글이 있어도 접힌다. 접힌 알약은 같은 입력창이
  // 첫 줄 하나만 보이는 모양이고, 글은 지워지지도 옮겨지지도 않는다. 쉬는 상태는 **사용자가 다시 닿을 때까지**다 — 포커스가 오면(다시 누르면) 같은 자리에서 펼치고, 글이 그 사이에 바뀌어도(자판을
  // 내리며 iOS 가 확정하는 자동 고침·조합: 시뮬레이터 실측 「Teh」→「The」가 쉬라는 알림 **뒤에** 도착해, 글이 같아야 쉬는 걸로 보던 첫 판에서는 입력창이 도로 펼쳐졌다) 이어진다.
  //
  // 목록 쪽(탭 판정 → `Keyboard.dismiss()` → `dockFollow.rest()`)은 `timelineTapDismiss.test.tsx` 의 `listTapDismiss` 묶음이다. 여기서는 그 알림(`bridge.rest()`)을 직접 보낸다. 실제 길에서는 자판을 내리는
  // `Keyboard.dismiss()` 가 먼저 불리고 네이티브 `onBlur` 가 JS 에 닿는 것이 알림보다 **앞일 수도 뒤일 수도 있다**(행 탭은 손 뗌에서 이미 내렸다) — 두 순서를 다 잰다.
  //
  // 이 파일의 단정은 전부 **렌더 결과**(도구 줄이 있나, 입력창의 높이·여백·`scrollEnabled`, 값, `Animated.spring` 호출)를 읽는다. 사보타주 표는 PR 본문.
  // =============================================================================

  const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};

  const fontScale = () => Dimensions.get('window').fontScale;
  /** 시험이 독립적으로 도출한 접힘 높이(엄지 바닥 이상의 한 줄 + 세로 크롬). */
  const collapsed = () => Math.max(TOUCH_TARGET, Math.ceil(line.body * fontScale()) + INPUT_CHROME);
  /** 첫 줄의 아랫선까지: 위 여백(패딩 + 테두리 = 크롬의 절반) + 한 줄 + 아래 테두리(1pt — 한 줄 상자보다 낮으면 라틴 g·y·p 의 아랫부분이 걸린다, design-review r1 N1). */
  const firstLineBox = () => INPUT_CHROME / 2 + Math.ceil(line.body * fontScale()) + 1;

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

  afterEach(async () => {
    await drainRender();
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

  describe('쉬는 상태는 사용자가 다시 닿을 때까지다 · 다시 누르면 같은 자리에서 펼친다', () => {
    // 자판을 내리면 iOS 는 대기 중인 자동 고침 후보·조합 중인 글자를 **그 자리에서 확정**하고, 그 `onChangeText` 는 쉬라는 알림 뒤에 온다(시뮬레이터 실측). 두 도착 순서를 다 잰다.
    it('쉬는 중에 글이 바뀌어도(자동 고침 확정이 알림 뒤에 도착) 접힌 채다 — 도로 펼쳐지지 않는다', () => {
      mount();
      typeAndSettle('Teh');
      rest();
      fireEvent.changeText(input(), 'The'); // 포커스 이벤트 없이 글이 바뀐다: 블러보다 먼저 도착한 확정
      blur();
      settle();
      expect(hasTools()).toBe(false);
      expect(input().props.value).toBe('The');
      expect(inputStyle().height).toBe(firstLineBox());
      expect(input().props.scrollEnabled).toBe(false);
    });

    it('확정이 블러 **뒤에** 도착해도 같다', () => {
      mount();
      typeAndSettle('Teh');
      rest();
      blur();
      settle();
      expect(hasTools()).toBe(false); // 전제: 이미 접혔다
      fireEvent.changeText(input(), 'The'); // 블러 뒤에 도착한 확정
      settle();
      expect(hasTools()).toBe(false);
      expect(input().props.value).toBe('The');
      expect(inputStyle().height).toBe(firstLineBox());
    });

    it('글이 비면(쉬는 입력창에서 보냄) 쉬는 상태가 풀린다 — 포커스 없이 글이 다시 채워져도 낡은 표식이 접힌 채 세우지 않는다', () => {
      mount();
      typeAndSettle('보낼 글');
      rest();
      blur();
      settle();
      fireEvent.press(screen.getByTestId('composer-send')); // 글이 빈다
      settle();
      expect(input().props.value).toBe('');
      fireEvent.changeText(input(), '새 글'); // 포커스 없이 다시 채워진다
      settle();
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

  // =============================================================================
  // 여러 줄 초안이 쉬러 가고 돌아올 때 글 칸이 **한 프레임에** 줄거나 자라지 않는다 (#4614, 계측 `DM-STEADY-FOCUS+actions+draft<N>` 의 `dismiss`·`focus` 창).
  //
  // 글 칸이 자라는 빌드(#4615 가 고치는 중 — 이 빌드의 입력창은 `flex: 1` 에 갇혀 글이 몇 줄이든 한 줄 높이다)에서 쉬는 알약으로 접는 순간 글 칸이 쉬는 알약의 한 줄로 **한 프레임에** 줄었다:
  // 시뮬레이터 16 Pro · 세 줄 초안 · `flex: 0` 으로 키운 입력창에서 도크가 43pt 줄고 목록이 1~2프레임 늦게 따라와 틈 편차가 +43pt(46ms)였다. 다시 펼칠 때도 같은 크기로 한 번에 자랐다
  // (포커스가 스프링 한가운데 닿으면서 못 박힘이 풀렸다). 이 블록은 그 높이 변화가 도구 줄과 **같은 스프링**으로 이어지는지 잰다.
  //
  // 제스트에는 레이아웃이 없다: 글 칸의 자연 높이는 시험이 입력창의 `onLayout` 으로 알려 준다(실기에서 입력창이 알리는 값과 같은 경로). 읽는 것은 글 칸이 차지하는 높이(= 높이 + 위·아래 여백)다 —
  // 움직이는 동안은 감싼 상자(`composer-field`)가, 쉬는 알약으로 못 박힌 뒤에는 입력창이, 자연 높이로 서 있을 때는 시험이 알려 준 값이 그 값이다.
  // =============================================================================
  describe.each([[1], [2]])('쉬러 가고 돌아오는 동안 글 칸이 한 프레임에 줄거나 자라지 않는다 (#4614 단차) — 글자 배수 %s', scale => {
    // 글자 배수 2 는 제스트 기본값이다. 이 배수에서는 쉬는 알약의 위 여백이 0 이라(첫 줄 상자 46 이 알약 64 의 한가운데 가까이 선다) 위 여백의 보간이 비어 보인다 — 배수 1 은 위 여백 1, 아래 여백 11 이다.
    beforeEach(() => {
      if (scale !== 2) jest.spyOn(Dimensions, 'get').mockReturnValue({...Dimensions.get('window'), fontScale: scale});
    });
    const NATURAL = 110; // 다섯 줄쯤의 글 칸(5 × 22 + 크롬 18)

    const fieldBox = () => screen.getByTestId('composer-field');
    const outerStyle = () => flat(fieldBox().props.style);
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);
    /** 글 칸이 알약 안에서 차지하는 높이. 어느 모양(움직이는 중 · 못 박힌 쉼 · 자연 높이)이든 같은 자로 잰다. */
    const footprint = (natural = NATURAL) => {
      // 보간 세 줄(높이·위·아래 여백)의 합은 부동소수점 오차(1e-14)를 낸다 — 1000분의 1pt 로 자른다.
      const thousandth = (value: number) => Math.round(value * 1000) / 1000;
      const outer = outerStyle();
      if (typeof outer.height === 'number') return thousandth(outer.height + num(outer.marginTop) + num(outer.marginBottom));
      const inner = inputStyle();
      if (typeof inner.height === 'number') return thousandth(inner.height + num(inner.marginTop) + num(inner.marginBottom));
      return natural;
    };
    const reportLayout = (height: number) =>
      fireEvent(input(), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 280, height}}});
    /** 입력창이 자연 높이로 서 있다고 알리고(여러 줄 글), 펼친 끝값에 앉힌다. */
    function mountMultiline(natural = NATURAL) {
      mount();
      reportLayout(natural);
      typeAndSettle('첫 줄\n둘째 줄\n셋째 줄');
      expect(footprint(natural)).toBe(natural); // 대조: 서 있는 동안은 자연 높이다 — 아래 「줄어든다」가 알림 없이도 통과하지 않는다
    }
    const frames = (count: number, natural = NATURAL) => {
      const boxes: number[] = [];
      for (let frame = 0; frame < count; frame += 1) {
        advance();
        boxes.push(footprint(natural));
      }
      return boxes;
    };
    const steps = (boxes: number[]) => boxes.slice(1).map((box, index) => box - (boxes[index] as number));

    it('접힘: 알림이 온 렌더는 자연 높이 그대로이고, 프레임마다 단조롭게 쉬는 알약 높이로 내려간다 — 한 프레임에 줄지 않는다', () => {
      mountMultiline();
      rest();
      blur();
      const boxes = [footprint(), ...frames(40)];
      expect(boxes[0]).toBe(NATURAL); // 첫 렌더가 이미 줄어 있으면 그 위 대화가 그 프레임에 통째로 뛴다
      boxes.forEach((box, index) => {
        if (index > 0) expect(box).toBeLessThanOrEqual(boxes[index - 1] as number);
      });
      expect(boxes[boxes.length - 1]).toBe(collapsed());
      // 한 걸음이 전체 변화의 반을 넘지 않는다: 한 프레임 단차(전체)는 여기서 걸린다. 스프링이면 프레임당 한 자릿수 퍼센트다.
      const total = NATURAL - collapsed();
      expect(Math.max(...steps(boxes).map(Math.abs))).toBeLessThan(total / 2);
      expect(steps(boxes).filter(step => step < -0.5).length).toBeGreaterThanOrEqual(5); // 여러 프레임에 걸쳐 움직인다
    });

    it('움직이는 동안은 상자가 안을 자르고 입력창은 못 박히지 않는다 — 못 박힘의 여백과 상자의 여백이 겹쳐 첫 줄이 밀리지 않는다', () => {
      mountMultiline();
      rest();
      blur();
      advance(5);
      expect(hasTools()).toBe(true); // 전제: 아직 움직이는 중이다
      expect(outerStyle().overflow).toBe('hidden');
      expect(typeof outerStyle().height).toBe('number');
      expect(inputStyle().height).toBeUndefined();
      expect(inputStyle().marginTop).toBeUndefined();
      expect(inputStyle().marginBottom).toBeUndefined();
    });

    it('블러 → 알림 순서여도 같다', () => {
      mountMultiline();
      blur();
      rest();
      const boxes = [footprint(), ...frames(40)];
      expect(boxes[0]).toBe(NATURAL);
      expect(Math.max(...steps(boxes).map(Math.abs))).toBeLessThan((NATURAL - collapsed()) / 2);
      expect(boxes[boxes.length - 1]).toBe(collapsed());
    });

    it('움직임이 끝나면 쉬는 알약의 못 박힘이 넘겨받고 상자의 높이·여백은 걷힌다 — 같은 높이로 바톤을 넘긴다', () => {
      mountMultiline();
      rest();
      blur();
      settle();
      expect(outerStyle().height).toBeUndefined();
      expect(outerStyle().overflow).toBeUndefined();
      expect(inputStyle().height).toBe(firstLineBox());
      expect(footprint()).toBe(collapsed());
    });

    it('돌아옴: 다시 누르면 알약 높이에서 자연 높이로 프레임마다 단조롭게 자란다 — 포커스가 스프링 한가운데 닿아도 한 번에 자라지 않는다', () => {
      mountMultiline();
      rest();
      blur();
      settle();
      expect(footprint()).toBe(collapsed()); // 전제: 쉬는 알약
      focus();
      const boxes = [footprint(), ...frames(40)];
      expect(boxes[0]).toBe(collapsed());
      boxes.forEach((box, index) => {
        if (index > 0) expect(box).toBeGreaterThanOrEqual(boxes[index - 1] as number);
      });
      expect(Math.max(...steps(boxes).map(Math.abs))).toBeLessThan((NATURAL - collapsed()) / 2);
      expect(boxes[boxes.length - 1]).toBe(NATURAL);
      expect(steps(boxes).filter(step => step > 0.5).length).toBeGreaterThanOrEqual(5);
      // 끝나면 상자가 걷히고 입력창은 자연 높이다(못 박힘 없음).
      expect(outerStyle().height).toBeUndefined();
      expect(inputStyle().height).toBeUndefined();
      expect(input().props.scrollEnabled).not.toBe(false);
    });

    it('왕복을 되풀이해도 시작값은 늘 자연 높이다 — 잘려 있는 동안 입력창이 알려 온 높이는 자연 높이로 적히지 않는다', () => {
      mountMultiline();
      rest();
      blur();
      reportLayout(50); // 상자가 입력창을 자르는 동안 입력창이 알려 온 줄어든 높이
      settle();
      reportLayout(31); // 못 박힌 쉼 높이
      focus();
      reportLayout(70); // 펼치는 도중의 높이
      settle();
      expect(footprint()).toBe(NATURAL); // 전제: 다시 자연 높이
      blur(); // 알림 없이 포커스만 잃는다 — 글이 있으니 펼친 채
      rest();
      const boxes = [footprint(), ...frames(40)];
      expect(boxes[0]).toBe(NATURAL); // 두 번째 접힘도 자연 높이에서 시작한다(50·31·70 이 아니라)
      expect(boxes[boxes.length - 1]).toBe(collapsed());
    });

    it('자연 높이가 쉬는 글 상자보다 낮아도(접근성 큰 글씨의 펼친 칸) 시작은 자연 높이 그대로이고 한 걸음이 반을 넘지 않는다 (design-review r2 L4)', () => {
      // 글자 배수 2(jest 기본)에서 쉬는 글 상자는 56pt, 알약은 64pt 다 — 자연 높이 40 은 둘 다보다 낮다.
      const natural = 40;
      mountMultiline(natural);
      rest();
      blur();
      const boxes = [footprint(natural), ...frames(40, natural)];
      expect(boxes[0]).toBe(natural); // 끝값을 쉬는 글 상자로 올리면 첫 렌더가 그만큼 뛴다
      boxes.forEach((box, index) => {
        if (index > 0) expect(box).toBeGreaterThanOrEqual(boxes[index - 1] as number);
      });
      expect(boxes[boxes.length - 1]).toBe(collapsed());
      expect(Math.max(...steps(boxes).map(Math.abs))).toBeLessThan((collapsed() - natural) / 2 + 0.01);
    });

    it('한 줄 초안은 높이가 변하지 않는다 — 알약 높이와 자연 높이가 같다', () => {
      mountMultiline(collapsed());
      rest();
      blur();
      const boxes = [footprint(collapsed()), ...frames(40, collapsed())];
      expect(new Set(boxes)).toEqual(new Set([collapsed()]));
    });

    it('자연 높이를 아직 모르면(입력창이 한 번도 안 알렸다) 움직임 없이 바로 쉬는 알약으로 못 박힌다 — 이전과 같다', () => {
      mount();
      typeAndSettle('첫 줄\n둘째 줄');
      rest();
      blur();
      expect(outerStyle().height).toBeUndefined();
      expect(outerStyle().overflow).toBeUndefined();
      advance();
      expect(inputStyle().height).toBe(firstLineBox());
    });

    it('동작 줄이기: 움직임 없이 한 번에 쉬는 알약이 되고, 다시 누르면 한 번에 펼쳐지며 상자는 걷힌다', async () => {
      a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
      await mountSettled();
      reportLayout(NATURAL);
      focus();
      fireEvent.changeText(input(), '첫 줄\n둘째 줄\n셋째 줄');
      expect(hasTools()).toBe(true);
      rest();
      blur();
      expect(hasTools()).toBe(false);
      expect(outerStyle().height).toBeUndefined();
      expect(footprint()).toBe(collapsed());
      focus();
      expect(hasTools()).toBe(true);
      expect(outerStyle().height).toBeUndefined();
      expect(inputStyle().height).toBeUndefined();
    });

    describe('쉬던 초안의 높이 기억은 쉬는 상태와 함께 풀린다', () => {
      beforeEach(() => __setNonSecretStore(memoryStore()));
      afterEach(() => __setNonSecretStore(null));

      it('방이 바뀌면 걷힌다 — 다른 방의 복원된 초안이 이 방의 자연 높이 상자에 갇히지 않는다', () => {
        const keyA = channelDraftKey('ch-a');
        const keyB = channelDraftKey('ch-b');
        saveDraft(keyA, '첫 줄\n둘째 줄');
        saveDraft(keyB, '다른 방의\n초안');
        const view = mount({draftKey: keyA});
        settle();
        reportLayout(NATURAL);
        rest();
        settle();
        expect(hasTools()).toBe(false); // 전제: 쉬는 알약
        view.rerender(tree({draftKey: keyB}));
        // 펼치는 스프링이 **끝나기 전에** 읽는다 — 끝나면 어느 쪽이든 낡은 기억이 걷힌다. 낡은 기억이 남았다면 이 순간 상자가 새 방의 복원된 초안을 쉬는 알약 높이에 가둔다.
        expect(hasTools()).toBe(true); // 복원된 초안은 펼침이다
        expect(outerStyle().height).toBeUndefined();
        expect(outerStyle().overflow).toBeUndefined();
        settle();
        expect(outerStyle().height).toBeUndefined();
      });
    });

    it('쉬는 초안을 보내면 걷힌다 — 다음에 쓰는 글이 낡은 높이 상자에 갇히지 않는다', () => {
      mountMultiline();
      rest();
      blur();
      settle();
      fireEvent.press(screen.getByTestId('composer-send'));
      settle();
      expect(input().props.value).toBe('');
      focus(); // 빈 입력창을 포커스로 펼친다 — 이제 쉬는 초안이 아니다
      // 펼치는 스프링이 도는 중에 읽는다(끝나면 어느 쪽이든 낡은 기억이 걷힌다): 낡은 기억이 남았다면 상자가 이 빈 입력창을 쉬는 알약 높이에 가둔다.
      expect(hasTools()).toBe(true);
      expect(outerStyle().height).toBeUndefined();
      expect(outerStyle().overflow).toBeUndefined();
      fireEvent.changeText(input(), '새 글\n두 줄');
      settle();
      expect(hasTools()).toBe(true);
      expect(outerStyle().height).toBeUndefined();
      expect(outerStyle().overflow).toBeUndefined();
    });
  });

  // =============================================================================
  // 쉬는 알약 **전체**가 누르는 면이다 (#4614, design-review r1 H1 — 눌리는 면 30pt).
  //
  // 쉬는 글 칸은 둘째 줄이 안 걸리게 첫 줄 높이(32pt)로 줄어 있어서 알약 52pt 중 글 칸 30pt 만 입력창이 받았다. 알약 아래 16pt 를 누르면 `composer-field` 의 누름 표식만 켜져 알약이 열렸다 포커스가 안 와서
  // 500ms 뒤 도로 닫혔다. 그래서 글 칸 위에 알약 높이만큼 투명한 면(`composer-rested-target`)을 얹고 그 면의 `onPress` 가 포커스를 준다.
  //
  // 이 파일이 재는 것은 **구조**다(면이 서는 때·사라지는 때·포커스를 부르는가·끌기 잠금이 이기는가). 눌리는 크기(44 이상)는 jest 에 레이아웃이 없어 못 잰다 — 시뮬레이터 Maestro 가 알약 아래 띠를 눌러 자판이 오르는 것으로
  // 잰다(`maestro/115-list-tap-dismiss.yaml` 의 `reopen-edge`).
  //
  // **실기에서 처음 짠 판이 실패한 모양을 시험으로 잠근다**: 면을 「움직이는 중이 아닐 때만」 세웠더니 손이 닿는 순간(#4518 펼침 시작) 면이 사라져 눌리던 손의 `onPress` 가 오지 않았다(`pressIn` 만 오고 포커스 없음).
  // =============================================================================
  describe('쉬는 알약 전체가 누르는 면이다 (#4614 H1)', () => {
    // 면은 접근성 트리에서 숨겨져 있어서(`accessibilityElementsHidden`) RNTL 의 기본 조회가 건너뛴다 — 숨은 요소까지 찾는다.
    const target = () => screen.getByTestId('composer-rested-target', {includeHiddenElements: true});
    const hasTarget = () => screen.queryByTestId('composer-rested-target', {includeHiddenElements: true}) !== null;
    const finger = (pageX: number, pageY: number) => ({nativeEvent: {pageX, pageY}});

    /** 외부 ref 를 준 컴포저 — 면이 부르는 `focus()` 를 엿본다. */
    function mountWithRef() {
      const ref = {current: null as TextInput | null};
      render(tree({inputRef: ref}));
      // RN 의 `TextInput` 목은 `focus` 를 **프로토타입의 공용 `jest.fn`** 으로 갖는다 — `jest.spyOn` 은 이미 목인 함수를 그대로 돌려줘서 시험 사이에 호출이 쌓인다. 이 입력창 하나에만 새 함수를 단다.
      const focusSpy = jest.fn();
      (ref.current as unknown as {focus: () => void}).focus = focusSpy;
      return {ref, focusSpy};
    }
    /** 글을 쓴 입력창을 목록 탭으로 쉬게 해 **정적인 쉬는 알약**에 앉힌다. */
    function rested() {
      const view = mountWithRef();
      typeAndSettle();
      rest();
      blur();
      settle();
      expect(hasTools()).toBe(false); // 전제: 쉬는 알약
      return view;
    }

    it('쉬는 알약에서 면이 서고 누르면 입력창에 포커스를 준다', () => {
      const {focusSpy} = rested();
      expect(hasTarget()).toBe(true);
      expect(focusSpy).not.toHaveBeenCalled();
      fireEvent.press(target());
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('면은 글 칸이 아니라 글 칸을 감싼 상자 전체를 덮는다(absoluteFill) — 글 칸 밖의 위·아래 여백도 같은 면이다', () => {
      rested();
      const style = flat(target().props.style) as Record<string, unknown>;
      expect(style).toMatchObject({position: 'absolute', top: 0, left: 0, right: 0, bottom: 0});
      // 글 칸 **안**이 아니라 글 칸을 감싼 상자(`composer-field`) 안의 형제다 — 상자는 글 칸과 그 위·아래 여백을 함께 품는다.
      const field = screen.getByTestId('composer-field');
      expect(within(field).queryByTestId('composer-rested-target', {includeHiddenElements: true})).not.toBeNull();
      expect(within(input()).queryByTestId('composer-rested-target', {includeHiddenElements: true})).toBeNull();
    });

    it('면은 접근성 요소가 아니다 — 읽어 주는 것은 글 칸 하나뿐이다', () => {
      rested();
      expect(target().props.accessible).toBe(false);
      expect(target().props.importantForAccessibility).toBe('no');
      expect(target().props.accessibilityElementsHidden).toBe(true);
    });

    it('쉬지 않을 때는 서지 않는다: 펼친 입력창 · 빈 접힘 · 글이 있어 펼친 입력창(알림 없음)', () => {
      mountWithRef();
      expect(hasTarget()).toBe(false); // 빈 접힘
      typeAndSettle();
      expect(hasTarget()).toBe(false); // 포커스를 쥔 펼침
      blur();
      settle();
      expect(hasTools()).toBe(true); // 대조: 글이 남아 펼친 채(#4456) — 쉬라는 알림이 없었다
      expect(hasTarget()).toBe(false);
    });

    it('손이 닿아 펼침이 시작돼도(포커스 전) 면이 서 있다 — 눌리던 손의 `onPress` 가 와야 한다(실기에서 처음 판이 실패한 모양)', () => {
      const {focusSpy} = rested();
      fireEvent(target(), 'touchStart', finger(100, 100)); // 누름 표식: 손이 닿는 순간 펼침이 시작된다(#4518)
      advance(2);
      expect(hasTools()).toBe(true); // 전제: 펼침이 시작됐다(`shown`)
      expect(hasTarget()).toBe(true);
      fireEvent(target(), 'touchEnd', finger(100, 100));
      fireEvent.press(target());
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });

    it('포커스가 오면 면이 사라진다 — 이제 입력창이 손을 받는다(캐럿·글자 선택)', () => {
      rested();
      fireEvent.press(target());
      focus();
      settle();
      expect(hasTarget()).toBe(false);
      expect(hasTools()).toBe(true);
    });

    it('끌기로 알아챈 손(끌기 잠금)은 포커스로 잇지 않는다 — 면의 `onPress` 가 와도', () => {
      const {focusSpy} = rested();
      fireEvent(target(), 'touchStart', finger(100, 100));
      fireEvent(target(), 'touchMove', finger(100, 140)); // 40pt — 끌기 문턱(10pt)을 넘는다 → 잠금
      expect(input().props.editable).toBe(false); // 전제: 잠겼다
      fireEvent.press(target());
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('쉬라는 알림이 왔는데 포커스가 그대로면(블러 없음) 면이 서지 않는다 — 입력창이 캐럿과 글자 선택을 못 받는 길을 만들지 않는다', () => {
      mountWithRef();
      typeAndSettle();
      rest(); // 블러를 안 보낸다
      expect(hasTarget()).toBe(false);
    });

    it('쉬던 입력창이 다시 쉬러 가면 면이 다시 선다 — 한 번 쓰고 사라지지 않는다', () => {
      const {focusSpy} = rested();
      fireEvent.press(target());
      focus();
      settle();
      rest();
      blur();
      settle();
      expect(hasTarget()).toBe(true);
      fireEvent.press(target());
      expect(focusSpy).toHaveBeenCalledTimes(2);
    });
  });
});
