import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Animated, Dimensions, Keyboard, StyleSheet} from 'react-native';

import {
  Composer,
  composerCollapsedHeight,
  INPUT_CHROME,
} from '../src/features/conversation/Composer';
import {COMPOSER_EXPAND_SPRING} from '../src/design/motion';
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

  it('포커스를 잃으면 접힌다: 도구 줄이 사라지고 글 칸은 한 줄 그대로다', () => {
    mount();
    focus();
    // 전제: 접힐 펼침이 실제로 서 있다 — 없으면 아래 단정은 블러 없이도 통과한다.
    expect(hasTools()).toBe(true);
    blur();
    expect(hasTools()).toBe(false);
    expect(inputHeight()).toBe(collapsed());
  });

  it('글이 남아 있으면 포커스를 잃어도 펼친 채다 — 그 글을 비우면 그때 접힌다', () => {
    mount();
    focus();
    fireEvent.changeText(input(), '쓰던 글');
    blur();
    expect(hasTools()).toBe(true);
    expect(inputHeight()).toBeUndefined();
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
    blur();
    expect(hasTools()).toBe(false);
    focus();
    expect(hasTools()).toBe(true);
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

describe('애니메이션 — 펼침은 Buzz 스프링, 접힘은 같은 프레임, 동작 줄이기면 즉시', () => {
  // 화면의 다른 부품(첨부 메뉴의 380/680 스프링 등)도 `Animated.spring` 을 부른다 — 이 입력창의 것(강성 816 · JS 구동)만 센다.
  const ours = (spring: jest.SpyInstance) =>
    spring.mock.calls.filter(
      call =>
        call[1]?.stiffness === COMPOSER_EXPAND_SPRING.stiffness &&
        call[1]?.useNativeDriver === false,
    );
  /** 스프링이 끝나도록 시간을 흘린다(넘침 잠금이면 ≈245ms 에 끝난다). */
  const settle = () =>
    act(() => {
      jest.advanceTimersByTime(500);
    });

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

  it('접힘은 애니메이션이 아니다: 포커스를 잃어도 · 포커스 없이 보내도 스프링이 안 돌고 같은 렌더에서 접힌다', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    await mountSettled();
    focus();
    settle();
    expect(ours(spring)).toHaveLength(1);
    blur();
    expect(hasTools()).toBe(false);
    expect(ours(spring)).toHaveLength(1);
    // 포커스 없이 보낸다(자판을 내린 채 남은 글).
    fireEvent.changeText(input(), '가');
    settle();
    expect(ours(spring)).toHaveLength(2);
    fireEvent.press(sendButton());
    expect(hasTools()).toBe(false);
    expect(ours(spring)).toHaveLength(2);
  });
});

describe('펼치는 동안 — 프레임마다 읽은 값 (대화 목록이 출렁이지 않는 길의 컴포넌트 몫)', () => {
  const FRAME_MS = 16;
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
