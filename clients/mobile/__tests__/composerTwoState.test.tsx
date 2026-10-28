import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, Dimensions, Keyboard, StyleSheet} from 'react-native';

import {
  Composer,
  composerCollapsedHeight,
  INPUT_CHROME,
  PRESS_DRAG_LOCK_RELEASE_MS,
  PRESS_FOCUS_GRACE_MS,
} from '../src/features/conversation/Composer';
import {COMPOSER_EXPAND_SPRING} from '../src/design/motion';
import {createDockFollow, DockFollowContext} from '../src/features/conversation/dockFollow';
import {line, TOUCH_TARGET} from '../src/design/tokens';
import {CONV} from '../src/features/conversation/convDesign';
import {channelDraftKey} from '../src/features/conversation/drafts';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// 입력창 두 상태 (#4305 → #4456) — 접힘(한 줄 알약) ↔ 펼침(글 칸 + 도구 줄)
//
// 펼침의 조건은 **포커스가 있다 또는 글이 있다**다(`focused || text !== ''`, #4456 — owner 10-25 가 #4305 의
// 「포커스만이면 접힘 유지」를 뒤집었다). 옛 판은 글만이었고 그 이유는 owner 10-24(iOS 3053)의 「보낸 뒤 두 줄
// 높이가 남던」 결함이었다. 그 결함을 고친 것은 펼침 조건이 아니라 **글이 비면 글 칸을 한 줄로 못 박는 것**이다 —
// 두 축이 갈라져 있으므로 포커스가 남은 채 보내도 여러 줄 높이는 남지 않고 「한 줄 + 도구 줄」(빈 펼침 높이)이다.
//
// 포커스 없는 쪽(자판을 내린 채 글이 생기고 사라지는 길 — 초안 복원·보내기)은 #4305 의 시험 그대로 남아 있다:
// 이 파일에서 `focus()` 를 부르지 않는 시험이 그 길이다.
//
// 접힘의 **움직임**은 이유에 따라 갈린다(#4456 D1): 포커스를 잃어서 접힐 때는 펼침과 같은 스프링이 거꾸로 돌고(자판이 내려가기 시작하는
// 프레임에 알약이 44pt 한 번에 줄어 대화가 튀지 않게), 포커스 없이 글이 비어서 접힐 때는 같은 프레임이다(owner 10-24 결함을 애니메이션으로 가리지
// 않게). 「동작 줄이기」면 둘 다 즉시다.
//
// 펼침은 **손이 닿는 순간** 시작한다(#4518, owner 10-25 「누르는 순간 바로」): 조건은 `pressing || focused || text !== ''` 다. 그 탭이 포커스로
// 이어지지 않으면(끌기·취소·손을 뗀 뒤 유예 안에 포커스가 안 옴) 같은 스프링으로 되돌린다. 이 파일 아래쪽 「누름」 절의 시험은 **`touchStart` 등 터치를
// 실제로 입력창에 쏘고**(RN 이 터치 대상에서 위로 올리는 그 이벤트) 렌더 결과를 읽는다 — 포커스 이벤트는 쏘지 않거나 따로 쏜다. 그래서 누름 핸들러를 빼면 붉어진다.
//
// 이 파일의 단정은 전부 **렌더 결과**(도구 줄이 있나, 입력창의 명시 높이, 햅틱 대역의 호출, `Animated.spring`
// 호출, 프레임마다 읽은 도구 줄 높이·글 칸 여백, `Keyboard.dismiss` 호출)를 읽는다. 사보타주 표는 PR 본문.
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
/**
 * 네이티브가 포커스·블러를 알릴 때 RN 이 부르는 그 `onFocus`/`onBlur` 를 부른다. 「포커스 이벤트가 실제로 핸들러에
 * 닿는가」는 이 헬퍼가 아니라 각 시험의 **전/후 대조**가 잠근다 — 포커스 전에는 접힘이고 후에는 펼침이어야 한다.
 */
const focus = () => fireEvent(input(), 'focus');
const blur = () => fireEvent(input(), 'blur');
const sendButton = () => screen.getByTestId('composer-send');
/** 스프링이 끝나도록 시간을 흘린다(넘침 잠금이면 ≈245ms 에 끝난다). */
const settle = () =>
  act(() => {
    jest.advanceTimersByTime(500);
  });
const FRAME_MS = 16;
/** 16ms 한 프레임(여럿)을 흘린다. */
const advance = (count = 1) =>
  act(() => {
    jest.advanceTimersByTime(FRAME_MS * count);
  });
/** Buzz 스프링(220ms · bounce 0.08, 질량 1)의 해석해 — 0 에서 정지 출발해 1 로. 시험이 상수에서 읽지 않고 따로 도출한다. */
const buzzSpring = (seconds: number) => {
  const zeta = 1 - 0.08;
  const omega = (2 * Math.PI) / 0.22;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  return (
    1 -
    Math.exp(-zeta * omega * seconds) *
      (Math.cos(damped * seconds) + ((zeta * omega) / damped) * Math.sin(damped * seconds))
  );
};
const toolsStyle = () => flat(screen.getByTestId('composer-tools').props.style);
const fieldStyle = () => flat(screen.getByTestId('composer-field').props.style);
/** 시험이 독립적으로 도출한 접힘 높이 — 글자 배수 곱한 한 줄 + 세로 크롬, 엄지 바닥 이상. */
const collapsed = () =>
  Math.max(TOUCH_TARGET, Math.ceil(line.body * Dimensions.get('window').fontScale) + INPUT_CHROME);

beforeEach(() => {
  hapticCalls.length = 0;
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  // 펼치는 스프링은 진짜 타이머에서 시험이 끝난 **뒤에도** 갱신을 새어 보낸다(act 밖 경고가 쌓인다). 가짜 타이머는 그 꼬리를
  // 버리고, 프레임을 시험이 직접 흘릴 수 있게 한다. 「동작 줄이기」의 답은 진짜 타이머에서 받는다(`mountSettled`).
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
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

  // 포커스가 없는 쪽 — 자판을 내린 채 글이 남아 있다가 보낸다(포커스가 남은 쪽은 아래 「포커스 (#4456)」).
  it('포커스 없이 두 줄을 쳐서 펼친 뒤 보내면 **같은 렌더에서** 접힘 높이로 돌아온다 (owner 10-24)', () => {
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

describe('포커스 (#4456) — 포커스만으로 펼치고, 포커스를 잃으면 접고, 글이 남으면 펼친 채다', () => {
  it('포커스만으로 펼친다: 글이 없어도 도구 줄이 서고 글 칸은 한 줄로 못 박힌 그대로다(빈 펼침 높이)', () => {
    mount();
    // 대조: 포커스 전에는 접힘이다. 처음부터 펼침이면 아래 단정은 포커스 이벤트가 닿았는지와 무관하게 통과한다.
    expect(hasTools()).toBe(false);
    focus();
    expect(input().props.value).toBe('');
    expect(hasTools()).toBe(true);
    expect(screen.getByTestId('composer-tool-mention')).toBeTruthy();
    expect(inputHeight()).toBe(collapsed());
  });

  it('포커스를 잃으면 접힌다: 움직임이 끝나면 도구 줄이 사라지고 글 칸은 한 줄 그대로다', () => {
    mount();
    focus();
    settle();
    // 전제: 접힐 펼침이 실제로 끝값으로 서 있다 — 없으면 아래 단정은 블러 없이도 통과한다.
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    blur();
    settle();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
  });

  it('포커스를 잃는 그 렌더는 아직 펼친 모양이다 — 접힌 모양이 한 프레임 그려졌다 되살아나지 않는다 (#4456 D1)', () => {
    mount();
    focus();
    settle();
    blur();
    // 시간을 흘리기 전, 블러가 끝난 직후의 렌더. 여기서 도구 줄이 없거나 여백이 접힌 값이면 키보드가 내려가기 시작하는 프레임에 알약이
    // 44pt 한 번에 줄고 다음 프레임에 되살아나는 모양이다(처리기가 `collapsing` 을 `focused` 와 한 묶음으로 올리지 않았다는 뜻).
    expect(hasTools()).toBe(true);
    expect(toolsStyle()).toMatchObject({height: TOUCH_TARGET, opacity: 1});
    expect(fieldStyle()).toMatchObject({marginLeft: 0, marginRight: 0});
    settle();
    expect(hasTools()).toBe(false);
  });

  it('글이 남아 있으면 포커스를 잃어도 펼친 채다 — 그 글을 비우면 그때 접힌다', () => {
    mount();
    focus();
    fireEvent.changeText(input(), '쓰던 글');
    blur();
    settle();
    expect(hasTools()).toBe(true);
    expect(inputHeight()).toBeUndefined();
    // 포커스 없이 글이 비는 접힘은 **같은 프레임**이다(움직임 없음, 시간을 흘리지 않았다).
    fireEvent.changeText(input(), '');
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
  });

  it('보낸 뒤 포커스가 남아 있으면 빈 펼침 높이(한 줄 + 도구 줄)다 — 여러 줄 높이가 남지 않는다 (owner 10-24)', () => {
    const sent: string[] = [];
    mount(body => sent.push(body));
    focus();
    fireEvent.changeText(input(), '첫 줄\n둘째 줄\n셋째 줄');
    // 전제: 여러 줄이 서 있다 — 콘텐츠가 높이를 정하고 못 박힌 높이가 없다.
    expect(inputHeight()).toBeUndefined();
    fireEvent.press(sendButton());
    expect(sent).toEqual(['첫 줄\n둘째 줄\n셋째 줄']);
    expect(input().props.value).toBe('');
    // 포커스가 남아 있다 → 펼침이 남는다(한 줄 알약으로 접히지 않는다).
    expect(hasTools()).toBe(true);
    // 글 칸은 한 줄로 못 박힌다. 이 줄이 owner 10-24 결함(보낸 뒤 두 줄 높이가 남던 것)의 회귀 잠금이다.
    expect(inputHeight()).toBe(collapsed());
  });

  it('빈 펼침에서 다시 치면 이어서 자란다(한 번 못 박힌 채 굳지 않는다)', () => {
    mount();
    focus();
    fireEvent.changeText(input(), '하나');
    fireEvent.press(sendButton());
    expect(inputHeight()).toBe(collapsed());
    fireEvent.changeText(input(), '둘\n셋');
    expect(hasTools()).toBe(true);
    expect(inputHeight()).toBeUndefined();
  });

  it('포커스 → 블러 → 포커스: 다시 펼쳐진다(한 번 접힌 채 굳지 않는다)', () => {
    mount();
    focus();
    settle();
    blur();
    settle();
    expect(hasTools()).toBe(false);
    focus();
    settle();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(inputHeight()).toBe(collapsed());
  });

  describe('다른 화면에 갔다 와도 상태가 맞다 — 다시 마운트되면 포커스는 없고 글은 초안에서 돌아온다', () => {
    beforeEach(() => __setNonSecretStore(memoryStore()));
    afterEach(() => __setNonSecretStore(null));

    it('글이 없던 입력창은 포커스를 쥔 채 떠나도 돌아오면 접힌 알약이다 — 이전 포커스가 새지 않는다', () => {
      const first = mount();
      focus();
      expect(hasTools()).toBe(true);
      first.unmount();
      mount();
      expect(hasTools()).toBe(false);
      expect(inputHeight()).toBe(collapsed());
    });

    it('쓰던 글(초안)이 있으면 돌아온 첫 프레임이 이미 펼침이다 — 펼치는 움직임 없이 끝값에서 시작한다', () => {
      const key = channelDraftKey('ch-4456');
      const first = render(
        <Composer
          recipient="place"
          channelLabel="배포"
          directory={makeDirectory([])}
          onSend={() => {}}
          draftKey={key}
        />,
      );
      focus();
      fireEvent.changeText(input(), '쓰던 글');
      blur();
      first.unmount();
      render(
        <Composer
          recipient="place"
          channelLabel="배포"
          directory={makeDirectory([])}
          onSend={() => {}}
          draftKey={key}
        />,
      );
      expect(input().props.value).toBe('쓰던 글');
      expect(hasTools()).toBe(true);
      expect(toolsStyle().height).toBe(TOUCH_TARGET);
      expect(fieldStyle().marginLeft).toBe(0);
    });
  });
});

describe('큰 글자 — 「@」 도구 글리프는 36pt 원 안에 머문다 (실측: accessibility-extra-large 에서 아래가 잘렸다)', () => {
  it('글리프는 글자 배수를 따르지 않는다', () => {
    mount();
    fireEvent.changeText(input(), '가');
    const tool = screen.getByTestId('composer-tool-mention');
    const glyph = tool.findByType(require('react-native').Text);
    expect(glyph.props.allowFontScaling).toBe(false);
  });
});

describe('햅틱 — 전이는 0번, 보내기 = light 1회', () => {
  it('첫 글자·펼친 채 치기·지워서 비기까지 0번(전이 햅틱 없음)', () => {
    mount();
    fireEvent.changeText(input(), '가');
    fireEvent.changeText(input(), '가나');
    fireEvent.changeText(input(), '가나\n다');
    fireEvent.changeText(input(), '');
    expect(hapticCalls).toEqual([]);
  });

  it('보내기는 light 한 번뿐이다 — 접힘 전이는 소리가 없다', () => {
    mount();
    fireEvent.changeText(input(), '가');
    hapticCalls.length = 0;
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(hapticCalls).toEqual(['impact:light']);
  });

  it('포커스·블러·포커스로 펼치고 접는 동안 0번이다(#4456) — 같은 대역이 보내기에서는 울린다', () => {
    mount();
    focus();
    // 전제: 포커스로 실제로 펼쳐졌다 — 안 펼쳐졌다면 「울리지 않는다」는 아무것도 안 잰 것이다.
    expect(hasTools()).toBe(true);
    blur();
    settle();
    expect(hasTools()).toBe(false);
    focus();
    fireEvent.changeText(input(), '가');
    blur();
    fireEvent.changeText(input(), '');
    expect(hapticCalls).toEqual([]);
    // 대조: 이 대역은 울림을 센다.
    fireEvent.changeText(input(), '보낼 글');
    fireEvent.press(sendButton());
    expect(hapticCalls).toEqual(['impact:light']);
  });

  it('빈 칸에서는 보내기가 안 울린다', () => {
    mount();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(hapticCalls).toEqual([]);
  });
});

/**
 * 마운트하고 「동작 줄이기」의 답이 도착할 때까지 **진짜 타이머로** 기다린 뒤 가짜 타이머로 돌아온다. 가짜 타이머를 켠 채
 * `await act` 하면 그 답(프라미스)이 흘러오지 않아, 「동작 줄이기」를 켠 시험이 조용히 꺼진 채로 돈다.
 */
async function mountSettled(onSend?: (body: string) => void) {
  jest.useRealTimers();
  const view = mount(onSend);
  await act(async () => {});
  jest.useFakeTimers();
  return view;
}

describe('애니메이션 — 펼침과 포커스를 잃어서 접히는 것은 Buzz 스프링, 포커스 없이 비는 접힘은 같은 프레임, 동작 줄이기면 즉시', () => {
  // 화면의 다른 부품(첨부 메뉴의 380/680 스프링 등)도 `Animated.spring` 을 부른다 — 이 입력창의 것(강성 816 · JS 구동)만 센다.
  const ours = (spring: jest.SpyInstance) =>
    spring.mock.calls.filter(
      call =>
        call[1]?.stiffness === COMPOSER_EXPAND_SPRING.stiffness &&
        call[1]?.useNativeDriver === false,
    );

  it('스프링 값은 Buzz 의 220ms · bounce 0.08 을 옮긴 것이다: 고유 주기 220ms, 감쇠비 0.92', () => {
    const {stiffness, damping, mass} = COMPOSER_EXPAND_SPRING;
    const periodMs = ((2 * Math.PI) / Math.sqrt(stiffness / mass)) * 1000;
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    expect(Math.abs(periodMs - 220)).toBeLessThan(1);
    expect(Math.abs(zeta - 0.92)).toBeLessThan(0.005);
  });

  it('포커스가 서면 스프링이 한 번 돈다 — 진행값 0→1, 넘침 잠금, 레이아웃을 움직이므로 JS 구동', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    // 대조: 포커스 전에는 돌지 않는다.
    expect(ours(spring)).toHaveLength(0);
    focus();
    expect(ours(spring)).toHaveLength(1);
    expect(ours(spring)[0]?.[1]).toMatchObject({
      toValue: 1,
      ...COMPOSER_EXPAND_SPRING,
      overshootClamping: true,
      useNativeDriver: false,
    });
    settle();
  });

  it('포커스 없이 글이 생겨 펼칠 때도(초안 복원·붙여넣기) 같은 스프링이다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    fireEvent.changeText(input(), '가');
    expect(ours(spring)).toHaveLength(1);
    settle();
  });

  it('펼침은 한 번만 움직인다: 펼친 채 치고·보내고·다시 쳐도 다시 안 건다(보낸 뒤에도 포커스가 남아 펼침 그대로다)', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    expect(ours(spring)).toHaveLength(1); // 전제: 포커스가 한 번 걸었다
    fireEvent.changeText(input(), '가');
    fireEvent.press(sendButton());
    fireEvent.changeText(input(), '나');
    expect(ours(spring)).toHaveLength(1);
    settle();
  });

  it('글이 먼저 있고 포커스가 나중에 와도 이미 펼침이라 다시 안 건다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    fireEvent.changeText(input(), '가');
    expect(ours(spring)).toHaveLength(1); // 전제: 글이 한 번 걸었다
    focus();
    expect(ours(spring)).toHaveLength(1);
    settle();
  });

  it('동작 줄이기: 포커스에도 움직임 없이 즉시 펼쳐진다 — 첫 프레임이 끝값이다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled(); // 설정의 답이 도착한 뒤
    focus();
    expect(hasTools()).toBe(true);
    expect(ours(spring)).toHaveLength(0);
    expect(toolsStyle()).toMatchObject({height: TOUCH_TARGET, opacity: 1});
    expect(fieldStyle()).toMatchObject({marginLeft: 0, marginRight: 0});
  });

  it('(대조) 동작 줄이기가 아니면 같은 순간 도구 줄은 0 에서 출발한다 — 위 「즉시」가 원래 끝값이어서 통과한 것이 아니다', async () => {
    await mountSettled();
    focus();
    expect(hasTools()).toBe(true);
    expect(toolsStyle()).toMatchObject({height: 0, opacity: 0});
    expect(fieldStyle()).toMatchObject({
      marginLeft: CONV.composerCircle,
      marginRight: CONV.composerCircle,
    });
    settle();
  });

  it('글을 쳐서 펼칠 때도 동작 줄이기면 즉시다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    fireEvent.changeText(input(), '가');
    expect(hasTools()).toBe(true);
    expect(ours(spring)).toHaveLength(0);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
  });

  it('포커스를 잃어서 접힐 때는 **같은 스프링이 거꾸로** 한 번 돈다 — toValue 0, 넘침 잠금, JS 구동 (#4456 D1)', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    settle();
    expect(ours(spring)).toHaveLength(1); // 전제: 펼침이 한 번 걸었다
    blur();
    expect(ours(spring)).toHaveLength(2);
    expect(ours(spring)[1]?.[1]).toMatchObject({
      toValue: 0,
      ...COMPOSER_EXPAND_SPRING,
      overshootClamping: true,
      useNativeDriver: false,
    });
    settle();
    // 끝난 뒤에는 더 안 건다(접힘이 끝났다고 다시 펼침을 걸지 않는다).
    expect(ours(spring)).toHaveLength(2);
  });

  it('포커스 없이 글이 비어서 접힐 때(포커스 없이 보냄)는 스프링이 안 돌고 같은 렌더에서 접힌다 (owner 10-24)', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    // 포커스 없이 글이 생겨 펼침(자판을 내린 채 남은 글).
    fireEvent.changeText(input(), '가');
    settle();
    expect(ours(spring)).toHaveLength(1);
    fireEvent.press(sendButton());
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    expect(ours(spring)).toHaveLength(1);
  });

  it('글이 남은 채 포커스를 잃으면 접히지도 스프링이 돌지도 않는다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    settle();
    fireEvent.changeText(input(), '쓰던 글');
    blur();
    settle();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(ours(spring)).toHaveLength(1);
  });

  it('동작 줄이기: 포커스를 잃어도 움직임 없이 즉시 접힌다 — 같은 렌더에서', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    expect(hasTools()).toBe(true); // 전제: 즉시 펼쳐졌다
    blur();
    expect(hasTools()).toBe(false);
    expect(ours(spring)).toHaveLength(0);
  });
});

describe('펼치는 동안 — 프레임마다 읽은 값 (대화 목록이 출렁이지 않는 길의 컴포넌트 몫)', () => {
  /** 포커스를 세우고 16ms 씩 `frames` 번 흘리며 도구 줄 높이·글 칸 왼쪽 여백·도구 줄 불투명도를 읽는다. */
  async function sample(frames: number) {
    await mountSettled();
    focus();
    const heights: number[] = [];
    const insets: number[] = [];
    const opacities: number[] = [];
    for (let frame = 0; frame < frames; frame += 1) {
      act(() => {
        jest.advanceTimersByTime(FRAME_MS);
      });
      heights.push(Number(toolsStyle().height));
      insets.push(Number(fieldStyle().marginLeft));
      opacities.push(Number(toolsStyle().opacity));
    }
    return {heights, insets, opacities};
  }

  it('도구 줄 높이는 0 에서 TOUCH_TARGET 까지 단조롭게 오르고 한 번도 넘치지 않는다 · 글 칸 여백은 36 에서 0 으로 내려가 음수가 없다', async () => {
    const {heights, insets, opacities} = await sample(40);
    // 움직인다: 첫 프레임은 끝값이 아니고 중간을 지난다(즉시 끝값이면 아래 「넘치지 않는다」가 아무것도 안 잰다).
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[0]).toBeLessThan(TOUCH_TARGET);
    expect(heights.some(height => height > 0 && height < TOUCH_TARGET)).toBe(true);
    // 단조 증가.
    heights.forEach((height, index) => {
      if (index > 0) expect(height).toBeGreaterThanOrEqual(heights[index - 1] as number);
    });
    // 넘침 0 — 대화 목록이 알약 윗면을 따라 출렁일 길이 없다.
    expect(Math.max(...heights)).toBeLessThanOrEqual(TOUCH_TARGET);
    expect(Math.min(...insets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...opacities)).toBeLessThanOrEqual(1);
    // 끝값에 정확히 앉는다.
    expect(heights[heights.length - 1]).toBe(TOUCH_TARGET);
    expect(insets[insets.length - 1]).toBe(0);
    expect(opacities[opacities.length - 1]).toBe(1);
  });

  it('곡선은 Buzz 스프링의 해석해를 따른다 — 160ms ease-out(첫 프레임에 이미 27%)이 아니다', async () => {
    const {heights} = await sample(10);
    heights.slice(0, 8).forEach((height, index) => {
      const expected = TOUCH_TARGET * buzzSpring(((index + 1) * FRAME_MS) / 1000);
      expect(Math.abs(height - expected)).toBeLessThan(0.75);
    });
    // 스프링은 속도 0 에서 출발한다: 첫 프레임이 해석해의 ~8%(3.5pt)이지 ease-out 의 27%(11.9pt)가 아니다.
    expect(heights[0]).toBeLessThan(TOUCH_TARGET * 0.15);
  });
});

describe('접히는 동안 — 프레임마다 읽은 값 (포커스를 잃어서 접힐 때, #4456 D1)', () => {
  /** 펼침을 끝값에 앉히고 블러한 뒤 16ms 씩 `frames` 번 흘리며 읽는다. 도구 줄이 내려간 뒤는 높이 0 · 불투명 0 · 여백 36 이다. */
  async function sample(frames: number) {
    await mountSettled();
    focus();
    settle();
    blur();
    const heights: number[] = [];
    const insets: number[] = [];
    const opacities: number[] = [];
    const mounted: boolean[] = [];
    for (let index = 0; index < frames; index += 1) {
      advance();
      mounted.push(hasTools());
      heights.push(hasTools() ? Number(toolsStyle().height) : 0);
      opacities.push(hasTools() ? Number(toolsStyle().opacity) : 0);
      insets.push(Number(fieldStyle().marginLeft));
    }
    return {heights, insets, opacities, mounted};
  }

  it('도구 줄 높이는 TOUCH_TARGET 에서 0 까지 단조롭게 내려가고 음수가 없다 · 글 칸 여백은 0 에서 36 으로 올라 넘지 않는다', async () => {
    const {heights, insets, opacities, mounted} = await sample(40);
    // 움직인다: 첫 프레임은 끝값(0)이 아니고 처음값(44)도 아니다 — 즉시 접히면 아래 「음수 없음」이 아무것도 안 잰다.
    expect(heights[0]).toBeLessThan(TOUCH_TARGET);
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights.some(height => height > 0 && height < TOUCH_TARGET)).toBe(true);
    // 단조 감소.
    heights.forEach((height, index) => {
      if (index > 0) expect(height).toBeLessThanOrEqual(heights[index - 1] as number);
    });
    insets.forEach((inset, index) => {
      if (index > 0) expect(inset).toBeGreaterThanOrEqual(insets[index - 1] as number);
    });
    // 넘침 0 — 알약 윗면이 목표 아래로 내려갔다 올라올 길이 없다(대화 목록이 출렁일 길도 없다).
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...insets)).toBeLessThanOrEqual(CONV.composerCircle);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0);
    // 끝: 도구 줄이 내려가고(0 에 닿은 뒤 한 번 더 렌더) 여백은 접힘 값, 글 칸은 한 줄로 못 박힌 채다.
    expect(mounted[mounted.length - 1]).toBe(false);
    expect(heights[heights.length - 1]).toBe(0);
    expect(insets[insets.length - 1]).toBe(CONV.composerCircle);
    expect(inputHeight()).toBe(collapsed());
    // 움직이는 동안은 도구 줄이 서 있다(0 에 닿기 전에 내려가지 않는다).
    const lastMounted = mounted.lastIndexOf(true);
    expect(lastMounted).toBeGreaterThan(5);
    expect(heights[lastMounted]).toBeLessThan(1);
  });

  it('곡선은 펼침의 거울이다 — Buzz 스프링의 해석해 1 − x(t) 를 따른다(스냅이 아니다)', async () => {
    const {heights} = await sample(10);
    heights.slice(0, 8).forEach((height, index) => {
      const expected = TOUCH_TARGET * (1 - buzzSpring(((index + 1) * FRAME_MS) / 1000));
      expect(Math.abs(height - expected)).toBeLessThan(0.75);
    });
    // 첫 프레임이 44 에서 ~3.5pt 만 내려왔다(스냅이면 44pt 가 한 번에 0 으로 간다).
    expect(heights[0]).toBeGreaterThan(TOUCH_TARGET * 0.85);
  });

  it('접히는 도중에 다시 포커스가 오면 그 자리에서 이어 펼친다 — 0 이나 끝값으로 튀지 않는다', async () => {
    await mountSettled();
    focus();
    settle();
    blur();
    advance(4); // 접히는 중간(64ms)
    const before = Number(toolsStyle().height);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(TOUCH_TARGET);
    focus();
    advance();
    const after = Number(toolsStyle().height);
    // 한 프레임에 스프링이 움직이는 몫 안이다(0 으로 튀거나 44 로 튀지 않는다).
    expect(Math.abs(after - before)).toBeLessThan(6);
    settle();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(fieldStyle().marginLeft).toBe(0);
    // 접히는 중이라는 표지가 다시 펼친 뒤에도 남지 않는다: 글을 쓰고 포커스 없이 비우면 **같은 렌더에** 접힌다(움직이며 접히지 않는다).
    fireEvent.changeText(input(), '가');
    blur();
    settle();
    fireEvent.changeText(input(), '');
    expect(hasTools()).toBe(false);
  });

  it('접히는 도중에 재는 글 칸 폭은 자리표시 폭이 되지 않는다 — 접힌 폭에 닿은 뒤에만 잰다', async () => {
    await mountSettled();
    const layout = (width: number) =>
      fireEvent(input(), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width, height: 44}}});
    const probeWidth = () =>
      flat(
        screen.queryAllByTestId('composer-placeholder-probe', {includeHiddenElements: true})[0]?.props.style,
      ).width;
    layout(358); // 접힌 폭
    const base = probeWidth();
    expect(base).toBeDefined();
    focus();
    settle();
    blur();
    advance(4); // 접히는 중간 — 글 칸 폭이 접힌 폭이 아니다
    layout(300);
    expect(probeWidth()).toBe(base);
    settle(); // 접힘이 끝났다
    layout(340);
    expect(probeWidth()).toBe(Number(base) - 18);
  });
});

describe('접히는 도중의 폭 가드는 Animated 의 리스너 정리에 기대지 않는다 (#4518)', () => {
  // RN `AnimatedNode.__detach` 는 값에 달린 마지막 자식(도구 줄 · 글 칸 여백)이 떨어질 때 그 값의 리스너를 **모두 지운다**. 시뮬레이터에서 첫 접힘이 끝난 뒤 진행값 사본(옛 가드가 읽던
  // `progress.addListener`)이 0 에 멈췄고, 그 뒤 접힘마다 넓은 폭이 자리표시 폭으로 새어 자리표시 문장이 몇 프레임 길게 바뀌었다(폭 281→247 동안 16→25자). jest 의 Animated 는 같은
  // 정리를 하지 않아서(리스너가 계속 산다) 옛 가드도 jest 에서는 통과한다 — 그래서 이 시험은 그 정리를 **그대로 모사한다**: 입력창의 진행값에 달린 리스너를 `removeAllListeners` 로 지운 채
  // 같은 흐름을 돈다. 가드가 리스너에 기대면 붉어진다.
  const layout = (width: number) =>
    fireEvent(input(), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width, height: 44}}});
  const probeWidth = () =>
    flat(
      screen.queryAllByTestId('composer-placeholder-probe', {includeHiddenElements: true})[0]?.props.style,
    ).width;
  /** 마운트하는 동안 리스너가 붙는 모든 `Animated.Value` 를 모은다 — 입력창의 진행값도 그중 하나다. */
  async function mountCollectingValues() {
    const values: Animated.Value[] = [];
    const original = Animated.Value.prototype.addListener;
    jest.spyOn(Animated.Value.prototype, 'addListener').mockImplementation(function (
      this: Animated.Value,
      callback: (state: {value: number}) => void,
    ) {
      values.push(this);
      return original.call(this, callback);
    });
    await mountSettled();
    return values;
  }
  const detachLikeAnimated = (values: Animated.Value[]) =>
    act(() => {
      values.forEach(value => value.removeAllListeners());
    });

  it('리스너가 지워진 뒤에도 접히는 도중의 폭은 안 잰다 — 포커스를 잃어 접힐 때', async () => {
    const values = await mountCollectingValues();
    // (지금 코드에는 입력창의 진행값 리스너가 없어 모을 것이 없다 — 옛 가드(사보타주 S38)에서는 진행값이 잡혀 아래 `detachLikeAnimated` 가 그 리스너를 지운다.)
    layout(358); // 접힌 폭
    const base = probeWidth();
    expect(base).toBeDefined();
    detachLikeAnimated(values);
    focus();
    settle();
    blur();
    advance(4); // 접히는 중간 — 글 칸 폭이 접힌 폭이 아니다
    layout(300);
    expect(probeWidth()).toBe(base);
    settle(); // 접힘이 끝났다
    layout(340); // 접힌 폭에 닿은 뒤에는 잰다
    expect(probeWidth()).toBe(Number(base) - 18);
  });

  it('리스너가 지워진 뒤에도 접히는 도중의 폭은 안 잰다 — 펼치는 도중에 누름이 되돌려질 때(끌기)', async () => {
    const values = await mountCollectingValues();
    layout(358);
    const base = probeWidth();
    detachLikeAnimated(values);
    touchDown(100, 100);
    advance(6); // 펼치는 도중
    touchMoveTo(100, 125); // 끌기로 되돌림
    advance(4); // 접히는 중간
    layout(300);
    expect(probeWidth()).toBe(base);
    settle();
    layout(340);
    expect(probeWidth()).toBe(Number(base) - 18);
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

  it('포커스된 채 끌어 내리면 자판이 내려가고, 포커스가 빠지면(`onBlur`) 글이 없을 때 접힌다 (#4456)', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    mount();
    focus();
    expect(hasTools()).toBe(true);
    fireEvent(bar(), 'touchStart', touch(100, 100));
    fireEvent(bar(), 'touchMove', touch(101, 140));
    expect(dismiss).toHaveBeenCalledTimes(1);
    // `Keyboard.dismiss` 가 `onBlur` 를 일으키는 잇기는 iOS 의 몫이다 — jest 에는 포커스 추적이 없어 여기서는 일어나지
    // 않는다(#4456 2단계 실기 확인 항목). 이 시험은 그 `onBlur` 가 오면 접히는 데까지를 잠근다.
    expect(hasTools()).toBe(true);
    blur();
    settle();
    expect(hasTools()).toBe(false);
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

// =============================================================================
// 누름 (#4518) — 손이 닿는 순간 펼치고, 그 탭이 포커스로 이어지지 않으면 되돌린다
//
// 아래 시험은 터치를 **실제로 입력창에** 쏜다: RN 이 터치 대상(`TextInput`)에서 위로 올려 보내는 `touchStart`·`touchMove`·`touchEnd`·`touchCancel` 이고,
// `composer-field` 의 처리기가 그것을 받는다. 포커스 이벤트(`focus()`)는 **따로** 쏜다 — 실기에서 포커스는 손을 뗀 뒤 RN `onPress → focus()` 를 돌아 오기
// 때문이다. 포커스가 안 오는 길은 그냥 안 쏘면 된다. 단정은 렌더 결과(도구 줄·스프링 호출·프레임 값·렌더 횟수·타이머 수)를 읽으므로 처리기를 빼거나 숫자를
// 바꾸면 붉어진다(사보타주 표는 PR 본문).
// =============================================================================

const finger = (pageX: number, pageY: number) => ({nativeEvent: {pageX, pageY}});
/**
 * 터치를 쏘는 자리. 실기에서 RN 은 날 터치를 입력창에서 위로 올려 보낸다 — 입력창이 편집 불가(`editable={false}`, 끌기 잠금)여도 그대로 올라와서 잠긴 동안에도
 * `touchEnd` 가 와야 잠금이 풀린다. 그런데 RNTL 은 편집 불가 입력창으로 쏜 이벤트를 **그 위 처리기까지** 막는다(`fire-event.js` `isEventEnabled`). 그래서 잠긴 동안만
 * 같은 처리기를 가진 `composer-field` 에 쏜다(그 위는 입력창을 거치지 않으니 막히지 않는다).
 */
const touchSurface = () =>
  input().props.editable === false ? screen.getByTestId('composer-field') : input();
/** 손가락이 입력창에 닿는다. 포커스 이벤트는 **쏘지 않는다**. */
const touchDown = (x = 100, y = 100) => fireEvent(touchSurface(), 'touchStart', finger(x, y));
const touchMoveTo = (x: number, y: number) => fireEvent(touchSurface(), 'touchMove', finger(x, y));
const touchUp = (x = 100, y = 100) => fireEvent(touchSurface(), 'touchEnd', finger(x, y));
const touchCancelled = () => fireEvent(touchSurface(), 'touchCancel', finger(100, 100));
/** 시간을 `ms` 만큼 흘린다. */
const wait = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
/** 이 입력창의 스프링(강성 816 · JS 구동)만 센다 — 위 애니메이션 절의 `ours` 와 같은 거름이다. */
const ourSprings = (spring: jest.SpyInstance) =>
  spring.mock.calls.filter(
    call =>
      call[1]?.stiffness === COMPOSER_EXPAND_SPRING.stiffness && call[1]?.useNativeDriver === false,
  );

/**
 * `mountSettled` 에 **커밋 횟수를 세는** `Profiler` 를 더한 것 — 「아무것도 하지 않는다」는 다시 그리지도 않는다는 뜻이다. 동작 줄이기의 답이 도착한 뒤 가짜
 * 타이머로 돌아온다.
 */
async function mountProfiled() {
  const commits = {count: 0};
  jest.useRealTimers();
  const view = render(
    <React.Profiler
      id="composer"
      onRender={() => {
        commits.count += 1;
      }}>
      <Composer
        recipient="place"
        channelLabel="배포"
        directory={makeDirectory([])}
        attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
        onSend={() => {}}
      />
    </React.Profiler>,
  );
  await act(async () => {});
  jest.useFakeTimers();
  return {view, commits};
}

describe('누름 (#4518) — 손이 닿는 순간 펼친다', () => {
  it('닿는 순간 펼친다: 포커스 이벤트가 오기 전에 도구 줄이 서고 스프링이 한 번 돈다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    // 대조: 닿기 전에는 접힘이고 스프링도 없다.
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    expect(ourSprings(spring)).toHaveLength(0);
    touchDown();
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    expect(ourSprings(spring)[0]?.[1]).toMatchObject({
      toValue: 1,
      ...COMPOSER_EXPAND_SPRING,
      overshootClamping: true,
      useNativeDriver: false,
    });
    // 손이 닿은 채 시간이 흘러도(포커스는 아직 안 왔다) 펼침은 끝값에 앉아 서 있다.
    settle();
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(fieldStyle().marginLeft).toBe(0);
  });

  it('빠른 탭(닿음 → 뗌 → 포커스): 포커스가 와도 스프링을 다시 걸지도 접지도 않는다 — 누름이 건 스프링이 이어진다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    advance(3);
    const before = Number(toolsStyle().height);
    // 전제: 포커스가 오기 전에 이미 펼치는 중이다.
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(TOUCH_TARGET);
    touchUp();
    advance(2);
    focus();
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    // 이어서 단조롭게 끝값까지 오른다 — 접혔다 되살아나지도 멈추지도 않는다.
    let previous = Number(toolsStyle().height);
    for (let frame = 0; frame < 20; frame += 1) {
      advance();
      const height = Number(toolsStyle().height);
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
    expect(previous).toBe(TOUCH_TARGET);
    // 유예 시계는 포커스가 멈췄다: 오래 지나도 펼친 채고 스프링은 한 번 그대로다.
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
  });

  it('느린 탭(길게 누른 뒤 뗌): 손이 닿아 있는 동안은 시간이 흘러도 되돌리지 않고, 포커스가 뗄 때 와도 접히지 않는다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    wait(PRESS_FOCUS_GRACE_MS * 4); // 손이 닿아 있다 — 유예 시계는 아직 돌지 않는다
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(ourSprings(spring)).toHaveLength(1);
    touchUp();
    advance(2);
    focus();
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(ourSprings(spring)).toHaveLength(1);
  });

  it('정상 경로의 포커스 지연에도 접혔다 되살아나지 않는다 — 손을 뗀 뒤 300ms(실측 39~120ms 의 2.5배)에 포커스가 와도 스프링은 한 번이다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    touchUp();
    wait(300);
    // 아직 되돌리지 않았다 — 기다리는 중이다.
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    focus();
    settle();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(ourSprings(spring)).toHaveLength(1);
  });

  it('포커스가 오면 누름이 풀린다 — 곧 블러하면 유예 시계를 기다리지 않고 접힌다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    touchUp(); // 유예 시계가 선다
    focus(); // 포커스가 넘겨받는다 — 시계도 멈춘다
    advance(2);
    blur();
    // 블러가 거꾸로 스프링을 건다 — 누름이 아직 쥐고 있다면 펼친 채라 걸릴 것이 없다.
    expect(ourSprings(spring)).toHaveLength(2);
    expect(ourSprings(spring)[1]?.[1]).toMatchObject({toValue: 0});
    wait(300); // 접히는 스프링이 끝난 뒤(≈245ms), 유예(500ms)보다는 앞
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    // 포커스가 유예 시계를 멈췄다: 스프링도 끝난 지금 기다리는 타이머가 하나도 없다. (스프링이 끝난 직후에는 act 스케줄러의 잔재가 잠깐 남는다 — 1ms 를
    // 흘려 비운 뒤에 센다.)
    wait(1);
    expect(jest.getTimerCount()).toBe(0);
    // 멈춘 시계가 되살아나 다시 건드리지 않는다.
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(hasTools()).toBe(false);
    expect(ourSprings(spring)).toHaveLength(2);
  });

  it('접히는 도중에 다시 누르면 그 자리에서 이어 펼친다 — 아직 보이는 중이어도 새 누름이다(0 이나 끝값으로 튀지 않는다)', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    settle();
    blur();
    advance(4); // 접히는 중간(64ms)
    const before = Number(toolsStyle().height);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(TOUCH_TARGET);
    expect(ourSprings(spring)).toHaveLength(2); // 펼침 한 번 + 접힘 한 번
    touchDown();
    advance();
    expect(ourSprings(spring)).toHaveLength(3);
    expect(ourSprings(spring)[2]?.[1]).toMatchObject({toValue: 1});
    const after = Number(toolsStyle().height);
    expect(Math.abs(after - before)).toBeLessThan(6);
    settle();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
  });
});

describe('누름 (#4518) — 탭이 포커스로 이어지지 않으면 같은 스프링으로 되돌린다', () => {
  it('포커스가 안 오면: 손을 뗀 뒤 유예가 끝나는 때 거꾸로 돌아 접힌다 — 그 전에는 기다린다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    settle(); // 펼침이 끝값에 앉았다
    touchUp();
    wait(PRESS_FOCUS_GRACE_MS - 20);
    expect(hasTools()).toBe(true); // 아직 기다리는 중이다
    expect(ourSprings(spring)).toHaveLength(1);
    wait(40); // 유예가 끝났다
    expect(ourSprings(spring)).toHaveLength(2);
    expect(ourSprings(spring)[1]?.[1]).toMatchObject({
      toValue: 0,
      ...COMPOSER_EXPAND_SPRING,
      overshootClamping: true,
      useNativeDriver: false,
    });
    expect(hasTools()).toBe(true); // 움직이며 접힌다 — 같은 프레임이 아니다
    settle();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    expect(ourSprings(spring)).toHaveLength(2); // 끝난 뒤 다시 걸지 않는다
  });

  it('끌기: 문턱 안의 떨림은 탭이고, 문턱을 넘으면 손을 떼기 전에 되돌린다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown(100, 100);
    settle();
    touchMoveTo(104, 103); // 5pt — 손떨림
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    touchMoveTo(100, 125); // 25pt — 끌기
    expect(ourSprings(spring)).toHaveLength(2);
    expect(ourSprings(spring)[1]?.[1]).toMatchObject({toValue: 0});
    settle();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    // 되돌린 뒤에는 더 끌거나 손을 떼도, 시간이 흘러도 다시 펼치거나 또 거두지 않는다.
    touchMoveTo(100, 160);
    touchUp();
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(hasTools()).toBe(false);
    expect(ourSprings(spring)).toHaveLength(2);
  });

  it('취소: 시스템이 터치를 가져가면 손을 떼기를 기다리지 않고 되돌린다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    settle();
    touchCancelled();
    expect(ourSprings(spring)).toHaveLength(2);
    expect(ourSprings(spring)[1]?.[1]).toMatchObject({toValue: 0});
    settle();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(ourSprings(spring)).toHaveLength(2);
  });

  it('되돌림은 펼치는 도중에도 현재 값에서 이어진다 — 0 이나 끝값으로 튀지 않는다', async () => {
    await mountSettled();
    touchDown();
    advance(4); // 펼치는 중간(64ms)
    const before = Number(toolsStyle().height);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(TOUCH_TARGET);
    touchCancelled();
    advance();
    // 같은 스프링이 거꾸로 돈다 — 접힌 모양으로 스냅하지 않았다.
    expect(hasTools()).toBe(true);
    const after = Number(toolsStyle().height);
    expect(Math.abs(after - before)).toBeLessThan(6);
    settle();
    expect(hasTools()).toBe(false);
  });

  it('유예 중에 다시 누르면 유예가 멈춘다 — 손이 닿아 있는 동안은 되돌리지 않는다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    touchDown();
    touchUp();
    wait(PRESS_FOCUS_GRACE_MS - 100); // 유예가 거의 찼다
    touchDown(); // 포커스가 안 와서 한 번 더 누른다
    wait(PRESS_FOCUS_GRACE_MS * 2); // 첫 유예였다면 이미 끝났다
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    touchUp();
    focus(); // 이번에는 포커스가 온다
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
  });

  it('언마운트하면 기다리던 유예 시계도 사라진다 — 사라진 화면을 되돌리려 하지 않는다', async () => {
    const view = await mountSettled();
    const idle = jest.getTimerCount();
    touchDown();
    settle();
    touchUp();
    // 전제: 유예 시계가 실제로 섰다.
    expect(jest.getTimerCount()).toBe(idle + 1);
    view.unmount();
    // 언마운트 직후에는 act 스케줄러의 잔재가 잠깐 남는다(터치 없이 언마운트해도 같다) — 1ms 를 흘려 비운 뒤에 남은 시계가 유예 시계다.
    wait(1);
    expect(jest.getTimerCount()).toBe(idle);
  });
});

describe('누름 (#4518) — 이미 펼쳐져 있으면 아무것도 하지 않는다', () => {
  it('이미 포커스면: 렌더도 타이머도 스프링도 없고, 끌기·취소·유예가 지나도 펼친 채다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const {commits} = await mountProfiled();
    focus();
    settle();
    // 전제: 포커스가 펼쳤고 스프링이 한 번 걸렸다 — 안 펼쳤다면 아래 「그대로」는 아무것도 안 잰 것이다.
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    const renders = commits.count;
    const timers = jest.getTimerCount();
    touchDown();
    touchMoveTo(100, 140); // 끌기 문턱을 넘는다
    touchUp();
    touchDown();
    touchCancelled();
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(commits.count).toBe(renders);
    expect(jest.getTimerCount()).toBe(timers);
    expect(ourSprings(spring)).toHaveLength(1);
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
  });

  it('포커스 이벤트와 같은 틱에 닿아도(렌더·효과가 아직 안 돈 때) 이미 포커스로 본다 — 유예 시계를 만들지 않는다', async () => {
    await mountSettled();
    const timers = jest.getTimerCount();
    act(() => {
      focus(); // `onFocus` 가 포커스를 동기로 적어 둔다 — 렌더·효과는 이 act 가 끝나야 돈다
      touchDown();
      touchUp(); // 누름이 섰다면 여기서 유예 시계가 선다
    });
    wait(PRESS_FOCUS_GRACE_MS - 100); // 스프링은 끝났고 유예는 아직 안 끝난 때
    expect(hasTools()).toBe(true);
    expect(jest.getTimerCount()).toBe(timers);
  });

  it('글이 있어 이미 펼쳐져 있으면: 렌더도 타이머도 스프링도 없다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const {commits} = await mountProfiled();
    fireEvent.changeText(input(), '쓰던 글');
    settle();
    // 전제: 글이 펼쳤고 스프링이 한 번 걸렸다.
    expect(hasTools()).toBe(true);
    expect(ourSprings(spring)).toHaveLength(1);
    const renders = commits.count;
    const timers = jest.getTimerCount();
    touchDown();
    touchUp();
    wait(PRESS_FOCUS_GRACE_MS * 2);
    expect(commits.count).toBe(renders);
    expect(jest.getTimerCount()).toBe(timers);
    expect(ourSprings(spring)).toHaveLength(1);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
  });
});

describe('누름 (#4518 D2) — 끌기는 포커스로 이어지지 않는다: 문턱을 넘어 끌린 손이 닿아 있는 동안 입력창을 잠근다', () => {
  // iOS 는 입력창을 누른 손을 **뗄 때** 포커스를 준다 — 끌었어도(시뮬레이터 실측, 네 방향 모두). 그래서 접힌 빈 입력창에서 문턱을 넘긴 끌기는
  // 되돌린 입력창이 손을 뗄 때 다시 포커스돼 펼침이 깜빡였다. 네이티브가 포커스를 줄지 정하는 때에 입력창이 편집 불가(`editable={false}`)여야 막힌다.
  // 이 시험은 그 **구성**(언제 잠기고 언제 풀리나)을 잠근다 — 실제로 포커스가 안 서는지는 시뮬레이터 실측이다(PR 본문).
  const editable = () => input().props.editable as boolean;

  it('문턱을 넘어 끌면 잠기고, 손을 뗀 뒤 PRESS_DRAG_LOCK_RELEASE_MS 가 지나서야 풀린다 — 닿기 전·손떨림은 잠그지 않는다', async () => {
    await mountSettled();
    expect(editable()).toBe(true); // 대조: 닿기 전
    touchDown(100, 100);
    expect(editable()).toBe(true); // 닿은 직후
    touchMoveTo(104, 103); // 5pt — 손떨림은 탭이다
    expect(editable()).toBe(true);
    touchMoveTo(100, 125); // 25pt — 끌기
    expect(editable()).toBe(false);
    touchMoveTo(100, 160); // 더 끌어도 잠긴 채
    expect(editable()).toBe(false);
    touchUp();
    wait(PRESS_DRAG_LOCK_RELEASE_MS - 1);
    expect(editable()).toBe(false); // 손을 뗀 순간을 네이티브가 정하는 동안은 잠긴 채다
    wait(2);
    expect(editable()).toBe(true);
  });

  it('시스템이 터치를 가져가도(취소) 같다: 손이 떨어진 뒤에 풀린다', async () => {
    await mountSettled();
    touchDown(100, 100);
    touchMoveTo(100, 125);
    expect(editable()).toBe(false);
    touchCancelled();
    wait(PRESS_DRAG_LOCK_RELEASE_MS - 1);
    expect(editable()).toBe(false);
    wait(2);
    expect(editable()).toBe(true);
  });

  it('끌고 뗀 직후에 다시 누르면 그 순간 풀린다 — 잠금이 다음 탭을 먹지 않는다', async () => {
    await mountSettled();
    touchDown(100, 100);
    touchMoveTo(100, 125);
    touchUp();
    settle(); // 되돌림이 끝난다(500ms) — 잠금은 이미 풀렸으니 다시 잠글 수 있게 한 번 더 끈다
    touchDown(100, 100);
    touchMoveTo(100, 125);
    expect(editable()).toBe(false);
    touchUp();
    wait(PRESS_DRAG_LOCK_RELEASE_MS / 2);
    expect(editable()).toBe(false); // 아직 안 풀렸다
    touchDown(100, 100); // 새 손
    expect(editable()).toBe(true); // 닿는 그 순간 풀렸고
    expect(hasTools()).toBe(true); // 새 누름은 새 누름으로 펼친다
    wait(PRESS_DRAG_LOCK_RELEASE_MS * 2); // 옛 시계가 새 손 위에서 다시 잠그거나 푸는 일도 없다
    expect(editable()).toBe(true);
  });

  it('이미 포커스면 잠그지 않는다 — 끌어 내리기·글자 선택은 지금 그대로 입력창이 받는다', async () => {
    await mountSettled();
    focus();
    settle();
    touchDown(100, 100);
    touchMoveTo(100, 140); // 문턱을 넘는다
    expect(editable()).toBe(true);
    touchUp();
    wait(PRESS_DRAG_LOCK_RELEASE_MS * 2);
    expect(editable()).toBe(true);
  });

  it('글이 있어 이미 펼쳐져 있으면 잠그지 않는다', async () => {
    await mountSettled();
    fireEvent.changeText(input(), '쓰던 글');
    settle();
    touchDown(100, 100);
    touchMoveTo(100, 140);
    expect(editable()).toBe(true);
    touchUp();
    wait(PRESS_DRAG_LOCK_RELEASE_MS * 2);
    expect(editable()).toBe(true);
  });

  it('언마운트하면 잠금을 풀 시계도 사라진다', async () => {
    const view = await mountSettled();
    const idle = jest.getTimerCount();
    touchDown(100, 100);
    touchMoveTo(100, 125);
    touchUp();
    settle(); // 되돌림의 스프링은 끝났다
    // 전제: 잠금이 실제로 걸렸다가 풀렸다 — 아니면 아래 「시계 0」은 아무것도 안 잰 것이다.
    expect(editable()).toBe(true);
    touchDown(100, 100);
    touchMoveTo(100, 125);
    touchUp(); // 잠금을 풀 시계가 선다
    expect(jest.getTimerCount()).toBeGreaterThan(idle);
    view.unmount();
    wait(1);
    expect(jest.getTimerCount()).toBe(idle);
  });
});

describe('도크가 자라는 프레임에 목록에게 알린다 (#4518, design-review R2 B1)', () => {
  // 펼침은 JS 가 프레임마다 도크 높이를 정해 넘기고, 목록이 그 높이를 따라가는 길(`onLayout` → `scrollToEnd`)은 네이티브 → JS → 네이티브를 한 바퀴 돌아서 키보드 준비로 메인 스레드가
  // 막혔다 풀리면 2~3프레임 늦는다 — 그 사이 마지막 말풍선의 아랫줄이 도크에 가려졌다 돌아왔다(짧은 탭: 틈 편차 −22pt·3프레임). 그래서 컴포저는 자라거나 주는 **프레임마다**
  // 컨텍스트의 다리(`dockFollow`)로 목록에게 바닥을 따라가라고 알린다. 목록의 답은 `dockFollow.test.tsx` 가 잠근다.
  function mountWithBridge() {
    const bridge = createDockFollow();
    const follow = jest.fn();
    bridge.register(follow);
    const view = render(
      <DockFollowContext.Provider value={bridge}>
        <Composer
          recipient="place"
          channelLabel="배포"
          directory={makeDirectory([])}
          attachmentTarget={{workspaceId: 'ws', channelId: 'ch'}}
          onSend={() => {}}
        />
      </DockFollowContext.Provider>,
    );
    return {view, follow};
  }
  async function mountWithBridgeSettled() {
    jest.useRealTimers();
    const mounted = mountWithBridge();
    await act(async () => {});
    jest.useFakeTimers();
    return mounted;
  }

  /**
   * 이 입력창의 진행값(`Animated.Value`)에 **시험이 따로 세는 리스너**를 건다 — 값이 바뀐 횟수다. 다리의 알림이 「값이 바뀔 때마다 정확히 한 번」인지(빠짐도 겹침도 없는지) 이 숫자와 맞대어 본다.
   * (jest 의 가짜 타이머에서는 한 프레임에 값이 여러 번 바뀌어서 프레임 수로는 못 센다.)
   */
  function countValueUpdates(spring: jest.SpyInstance) {
    const value = ourSprings(spring).at(-1)?.[0] as Animated.Value;
    expect(value).toBeDefined(); // 전제: 입력창의 스프링이 실제로 걸렸다
    let updates = 0;
    value.addListener(() => {
      updates += 1;
    });
    return () => updates;
  }

  it('닿아서 펼치는 동안 값이 바뀔 때마다 한 번씩 알리고, 스프링이 끝나면 멈춘다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const {follow} = await mountWithBridgeSettled();
    expect(follow).not.toHaveBeenCalled();
    touchDown();
    follow.mockClear(); // 스프링이 걸리는 첫 값은 시험의 리스너가 붙기 전에 지나갔다 — 여기서부터 같이 센다
    const updates = countValueUpdates(spring);
    advance(4);
    expect(updates()).toBeGreaterThan(0); // 전제: 실제로 자라고 있다
    expect(follow).toHaveBeenCalledTimes(updates());
    settle();
    expect(follow).toHaveBeenCalledTimes(updates());
    const total = follow.mock.calls.length;
    wait(500);
    expect(follow.mock.calls.length).toBe(total); // 끝난 뒤에는 더 안 부른다
  });

  it('포커스를 잃어 접히는 동안에도 값이 바뀔 때마다 알린다 — 줄어드는 도크 위로 목록이 따라 내려오게', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const {follow} = await mountWithBridgeSettled();
    focus();
    settle();
    follow.mockClear();
    blur();
    follow.mockClear();
    const updates = countValueUpdates(spring);
    advance(4);
    expect(updates()).toBeGreaterThan(0);
    expect(follow).toHaveBeenCalledTimes(updates());
  });

  it('앞 스프링의 리스너가 남아 겹쳐 부르지 않는다 — 두 번째 스프링도 값이 바뀔 때마다 정확히 한 번이다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const {follow} = await mountWithBridgeSettled();
    touchDown();
    settle(); // 첫 스프링이 끝났다(그 리스너는 거둬졌다)
    touchMoveTo(100, 140); // 끌기로 되돌림 → 두 번째 스프링
    follow.mockClear();
    const updates = countValueUpdates(spring);
    advance(4);
    expect(updates()).toBeGreaterThan(0);
    // 앞 스프링의 리스너가 새면 값이 바뀔 때마다 두 번씩 불러 숫자가 두 배가 된다.
    expect(follow).toHaveBeenCalledTimes(updates());
  });

  // 동작 줄이기: 값이 한 번에 바뀌어 스프링의 프레임별 알림이 없다. 앱을 켜고 처음 누른 짧은 탭에서는 키보드 준비가 메인 스레드를 막는 동안 목록의 `onLayout` 길이 늦어서 마지막 말풍선의
  // 아랫줄이 가려졌다(시뮬레이터: 알림 없는 코드 8/8번 잘림 1~8프레임, 값을 바꾼 직후 한 번 알리면 28번 중 2번(한가할 때 1번 68ms · 부하 속 1번 30ms) — 리뷰 R3 M3 를 측정으로 줄인 것).
  it('동작 줄이기: 스프링이 없으니 프레임별 알림은 없고, 값이 한 번에 바뀐 직후 한 번 알린다 — 목록이 onLayout 길만 기다리지 않게', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    const {follow} = await mountWithBridgeSettled();
    expect(follow).not.toHaveBeenCalled();
    touchDown();
    expect(hasTools()).toBe(true); // 전제: 같은 틱에 펼쳐졌다
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
    expect(follow).toHaveBeenCalledTimes(1);
    settle();
    wait(500);
    expect(follow).toHaveBeenCalledTimes(1); // 움직임이 없으니 프레임별로는 안 부른다
    expect(ourSprings(spring)).toHaveLength(0);
  });

  it('동작 줄이기: 알림은 값을 바꾼 뒤에 간다 — 목록의 명령이 레이아웃 커밋 뒤에 줄을 서도록', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const order: string[] = [];
    const realSetValue = Animated.Value.prototype.setValue;
    jest.spyOn(Animated.Value.prototype, 'setValue').mockImplementation(function (
      this: Animated.Value,
      value: number,
    ) {
      order.push(`값 ${value}`);
      realSetValue.call(this, value);
    });
    const {follow} = await mountWithBridgeSettled();
    follow.mockImplementation(() => {
      order.push('알림');
    });
    order.length = 0; // 마운트가 남긴 기록은 버린다
    touchDown();
    const notified = order.indexOf('알림');
    expect(notified).toBeGreaterThan(0); // 전제: 알렸다
    expect(order[notified - 1]).toBe('값 1'); // 바로 앞이 펼침 값이다
    expect(order.filter(entry => entry === '알림')).toHaveLength(1);
  });

  it('동작 줄이기: 접힘은 목록에게 알리지 않는다 — 줄어드는 도크 위로 목록은 늘기만 하고(가려질 줄이 없고), 같은 프레임 접힘은 보낸 말의 활강과 겹칠 수 있다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const {follow} = await mountWithBridgeSettled();
    touchDown();
    expect(hasTools()).toBe(true); // 전제: 펼쳤다
    follow.mockClear(); // 펼침의 알림 한 번은 위 시험이 잠근다
    touchMoveTo(100, 130); // 끌기로 되돌림 — 동작 줄이기라 같은 렌더에서 즉시 접힌다
    settle();
    wait(500);
    expect(hasTools()).toBe(false); // 전제: 접혔다
    expect(follow).not.toHaveBeenCalled();
  });

  it('동작 줄이기여도 다리가 없는 곳에서는 그대로 펼친다 — 알릴 곳이 없다고 터지지 않는다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    await mountSettled();
    touchDown();
    expect(hasTools()).toBe(true);
    expect(toolsStyle().height).toBe(TOUCH_TARGET);
  });

  it('다리가 없는 곳에서도 그대로 돈다 — 컨텍스트가 비어 있어도 펼치고 접힌다', async () => {
    await mountSettled();
    touchDown();
    settle();
    expect(hasTools()).toBe(true);
    touchMoveTo(100, 140);
    settle();
    expect(hasTools()).toBe(false);
  });
});

describe('누름 (#4518) — 동작 줄이기는 즉시, 햅틱은 0', () => {
  it('동작 줄이기: 닿는 순간 움직임 없이 펼쳐지고, 되돌림의 세 길(끌기·취소·유예)도 움직임 없이 같은 렌더에서 접힌다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled(); // 설정의 답이 도착한 뒤
    // (대조) 같은 세 길에서 동작 줄이기가 아니면 스프링이 돈다 — 위 「끌기」「취소」「유예」 시험이 그것이다.
    const revertPaths: Array<[string, () => void]> = [
      ['끌기', () => touchMoveTo(100, 130)],
      ['취소', () => touchCancelled()],
      [
        '유예',
        () => {
          touchUp();
          wait(PRESS_FOCUS_GRACE_MS + 20);
        },
      ],
    ];
    for (const [name, revert] of revertPaths) {
      touchDown();
      expect([name, hasTools()]).toEqual([name, true]); // 닿는 순간 즉시 펼침
      expect([name, toolsStyle().height]).toEqual([name, TOUCH_TARGET]);
      expect(toolsStyle().opacity).toBe(1);
      expect(fieldStyle()).toMatchObject({marginLeft: 0, marginRight: 0});
      revert();
      expect([name, hasTools()]).toEqual([name, false]); // 같은 렌더에서 접힘
      expect(inputHeight()).toBe(collapsed());
    }
    expect(ourSprings(spring)).toHaveLength(0);
  });

  it('동작 줄이기: 글 칸 양옆 여백은 진행값이 아니라 상태가 정한다 — 진행값이 영영 안 따라와도 펼치고 되돌린 뒤 접힌 자리로 돌아온다', async () => {
    a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(true));
    // 시뮬레이터에서는 JS 구동 값이 `setNativeProps` 로 네이티브를 직접 고친다. 누름이 펼침 직후 되돌려지면(끌기·취소·유예) 리액트가 기억하는 여백(접힌 값)과 네이티브에 써 둔 여백(펼친 값)이 어긋나고
    // 접힌 쪽 렌더가 「같은 값」이라며 아무것도 안 보내서 자리표시가 + 버튼 위에 겹쳐 남았다(16 Pro: 끌기 8번 모두). jest 는 그 어긋남을 못 만든다 — 대신 최악을 만든다: 진행값이
    // 아예 안 바뀐다. 여백이 상태에서만 나오면(진행값을 안 거치면) 어긋날 곳이 없어서 이 시험이 선다.
    jest.spyOn(Animated.Value.prototype, 'setValue').mockImplementation(() => {});
    await mountSettled();
    expect(fieldStyle()).toMatchObject({marginLeft: CONV.composerCircle, marginRight: CONV.composerCircle});
    touchDown();
    expect(hasTools()).toBe(true); // 전제: 상태는 펼침이다
    expect(fieldStyle()).toMatchObject({marginLeft: 0, marginRight: 0});
    touchMoveTo(100, 130); // 끌기로 되돌림
    expect(hasTools()).toBe(false); // 전제: 접혔다
    expect(fieldStyle()).toMatchObject({marginLeft: CONV.composerCircle, marginRight: CONV.composerCircle});
  });

  it('햅틱 0 — 닿고 · 떨고 · 끌고 · 취소하고 · 유예가 지나고 · 포커스가 넘겨받는 동안 한 번도 안 울린다(#4331)', async () => {
    await mountSettled();
    touchDown();
    // 전제: 닿는 것만으로 실제로 펼쳐졌다 — 안 펼쳐졌다면 「울리지 않는다」는 아무것도 안 잰 것이다.
    expect(hasTools()).toBe(true);
    touchMoveTo(100, 130); // 끌기로 되돌림
    touchDown();
    touchCancelled(); // 취소로 되돌림
    touchDown();
    touchUp();
    wait(PRESS_FOCUS_GRACE_MS + 20); // 유예로 되돌림
    touchDown();
    touchUp();
    focus(); // 포커스가 넘겨받음
    settle();
    expect(hasTools()).toBe(true);
    expect(hapticCalls).toEqual([]);
    // 대조: 같은 대역이 보내기에서는 울린다.
    fireEvent.changeText(input(), '보낼 글');
    fireEvent.press(sendButton());
    expect(hapticCalls).toEqual(['impact:light']);
  });
});
