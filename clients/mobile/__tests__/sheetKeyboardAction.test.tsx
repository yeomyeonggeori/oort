import {contrast} from '@momo/core/design/color';
import type {ChannelActionItem} from '@momo/core/features/channels/actionModel';
import {channelLeaveFailureMessage} from '@momo/core/features/channels/model';
import {QUICK_REACTIONS} from '@momo/core/features/timeline/reactions';
import {ApiError, type Message} from '@momo/core/lib/api';
import {NetworkError, REQUEST_TIMEOUT_MS} from '@momo/core/lib/http';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
} from 'react-native';

import {REACTION_GLYPH_MAX_SCALE, ROW_GLYPH_MAX_SCALE} from '../src/design/atoms';
import {PageSheet, usePageSheetAction, usePageSheetClose} from '../src/design/PageSheet';
import {SheetHeader} from '../src/design/SheetChrome';
import {sheetFrame, sheetTop, type SheetHeight} from '../src/design/sheetModel';
import {
  ActionTile,
  ConfirmStep,
  InputPill,
  ListRow,
  RowEmoji,
  SheetScroll,
} from '../src/design/sheetParts';
import {THEME_IDS} from '../src/design/ds2Tokens';
import {FixedScheme, paletteFor} from '../src/design/theme';
import {
  font,
  paletteFrom,
  SAFE_GUTTER,
  SHEET,
  space,
  TOUCH_TARGET,
} from '../src/design/tokens';
import {DeviceKeyPanel} from '../src/features/deviceKey/DeviceKeyPanel';
import {LinkSheetBody} from '../src/features/deviceKey/DeviceKeyLinkSheet';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {ChannelActionSheet} from '../src/features/sidebar/ChannelActionSheet';
import {retainReduceMotion} from '../src/lib/useReduceMotion';

// =============================================================================
// 시트의 키보드 올림과 「행동은 닫은 뒤에」 (#4318 2단계).
//
// 둘 다 **배선**이라 순수 규칙(`sheetModel.sheetFrame`)과 실제 렌더를 같이 잰다. Jest 에는 레이아웃
// 엔진이 없다 - 「입력 칸의 아래 끝이 키보드 위」는 시트 상자의 바닥이 키보드 윗면(이벤트의 `screenY`)
// 위에 있다는 것으로 잰다(입력은 시트 안에 있으므로 시트 바닥보다 아래일 수 없다). 입력이 실제로 안 가려
// 지는지는 시뮬레이터 캡처(`measure/captures/4318/`)가 증거다.
// =============================================================================

const a11y = AccessibilityInfo as unknown as {isReduceMotionEnabled: jest.Mock};
const BASE_WINDOW = Dimensions.get('window');

/**
 * 대표 기기. 키보드 높이는 시뮬레이터 실측이다(iOS 26.5, 예측 줄 포함: 16 Pro 336 · SE 260). 규칙은 어떤 값이어도
 * 같은 관계(바닥 = 키보드 윗면)를 말한다.
 */
const DEVICES = [
  {name: '16 Pro', width: 402, height: 874, insetTop: 62, keyboard: 336},
  {name: 'SE', width: 375, height: 667, insetTop: 20, keyboard: 260},
] as const;

let releaseReduceMotion: (() => void) | null = null;

afterEach(() => {
  cleanup();
  // Keyboard 모듈은 `keyboardDidShow` 로 「보이는 중」을 **파일 안에서 계속** 기억한다 — 실패한 시험이 남긴 키보드가 뒤 시험을
  // 연쇄로 무너뜨리지 않게 매번 내린다.
  emitter().emit('keyboardDidHide', keyboardFrame(0, BASE_WINDOW.height));
  releaseReduceMotion?.();
  releaseReduceMotion = null;
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
  jest.restoreAllMocks();
});

function setWindow(width: number, height: number) {
  const window = {...BASE_WINDOW, width, height};
  act(() => {
    Dimensions.set({window, screen: window});
  });
}

function useInsets(top: number, bottom: number) {
  const safeArea = require('react-native-safe-area-context');
  return jest
    .spyOn(safeArea, 'useSafeAreaInsets')
    .mockReturnValue({top, left: 0, right: 0, bottom});
}

async function mount(ui: React.ReactElement, reduceMotion = false, scheme: 'light' | 'dark' = 'light') {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(reduceMotion));
  releaseReduceMotion ??= retainReduceMotion();
  await act(async () => {});
  const utils = render(<FixedScheme scheme={scheme}>{ui}</FixedScheme>);
  await act(async () => {});
  return utils;
}

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, {includeHiddenElements: true}).props.style);

type Emitter = {emit: (event: string, payload: unknown) => void};
const emitter = () => (Keyboard as unknown as {_emitter: Emitter})._emitter;

/** iOS 가 보내는 키보드 틀. `screenY` 가 키보드 윗면이다. */
function keyboardFrame(height: number, windowHeight: number) {
  return {
    endCoordinates: {height, screenX: 0, screenY: windowHeight - height, width: 390},
    duration: 250,
    easing: 'keyboard',
  };
}

function Sheet({
  onClose,
  height,
  children,
}: {
  onClose: () => void;
  height?: SheetHeight;
  children?: React.ReactNode;
}) {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="시험 시트" height={height} testID="sheet">
      <SheetHeader title="시험 시트" closeLabel="시험 시트 닫기" closeTestID="close" />
      {children}
    </PageSheet>
  );
}

/** 시트 안의 행동 하나 - `usePageSheetAction` 의 배선을 그대로 쓴다. */
function RunAfterClose({action}: {action: () => void}) {
  const run = usePageSheetAction();
  return (
    <Pressable testID="run" onPress={() => run(action)}>
      <Text>행동</Text>
    </Pressable>
  );
}

type Handlers = Record<string, (event: unknown) => unknown>;

/** `sheetKit.test.tsx` 의 응답자 이벤트와 같은 모양 — 손잡이 띠가 실제로 받는 것. */
function touch(y: number, at: number, previousY: number = y) {
  return {
    nativeEvent: {touches: [{}], changedTouches: [{}], timestamp: at},
    touchHistory: {
      touchBank: [
        {
          touchActive: true,
          startPageX: 0,
          startPageY: 0,
          startTimeStamp: 0,
          currentPageX: 0,
          currentPageY: y,
          currentTimeStamp: at,
          previousPageX: 0,
          previousPageY: previousY,
          previousTimeStamp: at - 16,
        },
      ],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: at,
    },
  };
}

// ---------------------------------------------------------------------------
// 키보드 — 순수 상자
// ---------------------------------------------------------------------------

describe('키보드가 올라오면 시트의 바닥이 키보드 윗면에 앉는다 (순수 상자)', () => {
  /** 화면 위에서 잰 시트 상자의 위·아래. 내용 맞춤은 최대 높이가 위 끝의 가장 나쁜 경우다. */
  function box(height: SheetHeight, device: (typeof DEVICES)[number], keyboard: number) {
    const frame = sheetFrame(height, device.height, device.insetTop, keyboard);
    const bottomY = device.height - (frame.bottom ?? 0);
    const topY = frame.top ?? bottomY - (frame.height ?? frame.maxHeight ?? 0);
    return {frame, topY, bottomY};
  }
  /** 키보드가 올리는 단. 큰 단은 올리지 않는다(아래 별도). */
  const LIFTED: SheetHeight[] = ['fit', 'medium'];

  describe.each(DEVICES)('$name', device => {
    it.each(LIFTED)('%s: 시트 바닥 = 키보드 윗면 - 입력 칸은 시트 안이라 키보드 위다', height => {
      const {frame, bottomY} = box(height, device, device.keyboard);
      expect(frame.bottom).toBe(device.keyboard);
      expect(bottomY).toBe(device.height - device.keyboard);
    });

    it.each(LIFTED)('%s: 시트가 큰 단의 위 끝보다 높이 올라가 머리가 시계 뒤로 가지 않는다', height => {
      const {topY} = box(height, device, device.keyboard);
      expect(topY).toBeGreaterThanOrEqual(sheetTop(device.insetTop));
    });

    it('큰 단은 키보드가 올라와도 올리지 않는다 - 위 끝만 있고 bottom 이 없다 (제 키보드 처리를 가진 시트와 이중 보정을 피한다)', () => {
      const frame = sheetFrame('large', device.height, device.insetTop, device.keyboard);
      expect(frame).toEqual({top: sheetTop(device.insetTop)});
      expect(frame).not.toHaveProperty('bottom');
    });

    // 키보드 0 의 옛 상자는 **이 함수의 기본 인자와 비교하지 않고** 옛 식(상수)으로 대조한다.
    it('키보드가 없으면 옛 상자 그대로다 - 단별 옛 식과 같고 bottom 이 아예 없다', () => {
      expect(sheetFrame('large', device.height, device.insetTop, 0)).toEqual({
        top: Math.max(58, device.insetTop + 4),
      });
      expect(sheetFrame('medium', device.height, device.insetTop, 0)).toEqual({
        height: Math.floor(device.height * (9 / 16)),
      });
      expect(sheetFrame('fit', device.height, device.insetTop, 0)).toEqual({
        maxHeight: Math.floor(device.height * 0.85),
      });
    });
  });

  it('SE 의 중간 단: 9/16 = 375 가 키보드 위 칸(349)보다 커서 그 칸으로 줄어든다', () => {
    const se = DEVICES[1];
    expect(Math.floor(se.height * (9 / 16)) + se.keyboard).toBeGreaterThan(se.height - sheetTop(se.insetTop));
    expect(sheetFrame('medium', se.height, se.insetTop, se.keyboard)).toEqual({
      height: se.height - se.keyboard - sheetTop(se.insetTop),
      bottom: se.keyboard,
    });
  });

  it('16 Pro 의 중간 단: 키보드 위 칸이 9/16 보다 작아 줄어든다', () => {
    const pro = DEVICES[0];
    expect(sheetFrame('medium', pro.height, pro.insetTop, pro.keyboard)).toEqual({
      height: pro.height - pro.keyboard - sheetTop(pro.insetTop),
      bottom: pro.keyboard,
    });
  });

  it('칸이 넉넉하면 줄이지 않는다 - 작은 키보드에서 중간 단은 9/16 그대로', () => {
    const pro = DEVICES[0];
    expect(sheetFrame('medium', pro.height, pro.insetTop, 100)).toEqual({
      height: Math.floor(pro.height * (9 / 16)),
      bottom: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// 키보드 - 시트에 배선
// ---------------------------------------------------------------------------

describe('키보드 - 시트에 배선', () => {
  const input = (
    <InputPill accessibilityLabel="상태 한 줄" icon={undefined} placeholder="무엇을 하고 있나요?" testID="status-input" />
  );

  it('중간 단 + 입력: 키보드 이벤트로 시트 바닥이 키보드 윗면에 앉고, 내려가면 제자리로 돌아온다', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(
      <Sheet height="medium" onClose={() => {}}>
        {input}
      </Sheet>,
      true,
    );
    expect(flat('page-sheet').bottom).toBe(0);
    expect(flat('page-sheet').height).toBe(Math.floor(se.height * (9 / 16)));

    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    const lifted = flat('page-sheet');
    // 입력 칸의 아래 끝은 시트 바닥보다 아래일 수 없고, 시트 바닥은 키보드 윗면(screenY)보다 아래일 수 없다.
    expect(se.height - (lifted.bottom as number)).toBeLessThanOrEqual(
      keyboardFrame(se.keyboard, se.height).endCoordinates.screenY,
    );
    expect(lifted.bottom).toBe(se.keyboard);
    expect(lifted.height).toBe(se.height - se.keyboard - sheetTop(se.insetTop));

    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, se.height));
    });
    expect(flat('page-sheet').bottom).toBe(0);
    expect(flat('page-sheet').height).toBe(Math.floor(se.height * (9 / 16)));
  });

  it('내용 맞춤 단: 키보드가 올라오면 바닥이 뜨고 최대 높이가 키보드 위 칸 안으로 줄어든다', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="fit" onClose={() => {}} />, true);
    expect(flat('page-sheet').maxHeight).toBe(Math.floor(se.height * 0.85));
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    expect(flat('page-sheet').bottom).toBe(se.keyboard);
    expect(flat('page-sheet').maxHeight).toBe(se.height - se.keyboard - sheetTop(se.insetTop));
  });

  it('큰 단: 키보드가 올라와도 시트는 그대로다 - 올리지 않는다(몸 스크롤이 제 키보드 처리를 한다)', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="large" onClose={() => {}} />, true);
    const before = flat('page-sheet');
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    const after = flat('page-sheet');
    expect(after.top).toBe(before.top);
    expect(after.bottom).toBe(0);
  });

  it('did 쌍이 높이가 다르다고 말하면 따른다(하드웨어 키보드·예측 줄), 내려가면 0', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    act(() => {
      emitter().emit('keyboardDidShow', keyboardFrame(64, se.height));
    });
    expect(flat('page-sheet').bottom).toBe(64);
    act(() => {
      emitter().emit('keyboardDidHide', keyboardFrame(0, se.height));
    });
    expect(flat('page-sheet').bottom).toBe(0);
  });

  it('몸의 스크롤은 키보드가 올라오면 홈 인디케이터 여백을 걷고 끝 카드 아래 숨 쉴 틈 16 만 남긴다 - 키보드가 그 자리를 이미 덮는다', async () => {
    useInsets(0, 34);
    await mount(
      <Sheet height="medium" onClose={() => {}}>
        <SheetScroll testID="scroll">
          <Text>내용</Text>
        </SheetScroll>
      </Sheet>,
      true,
    );
    const padding = () =>
      StyleSheet.flatten(screen.getByTestId('scroll').props.contentContainerStyle).paddingBottom;
    expect(padding()).toBe(34 + space.lg);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    // 「안전 영역 또는 16 중 큰 값 + 16」(32)이 남으면 내용이 다 보이는 SE 의 「상태 설정」(카드 아랫선 383.5 + 32 >
    // 키보드 윗면 407)이 9pt 헛스크롤한다(design-review r4 L1). 키보드 위에는 숨 쉴 틈 16 만 남는다.
    expect(padding()).toBe(space.lg);
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, BASE_WINDOW.height));
    });
    expect(padding()).toBe(34 + space.lg);
  });

  it('홈 인디케이터가 없는 기기(안전 영역 0)는 키보드가 없어도 16 + 16 이다 - 키보드 규칙이 이 값을 줄이지 않는다', async () => {
    useInsets(20, 0);
    await mount(
      <Sheet height="medium" onClose={() => {}}>
        <SheetScroll testID="scroll">
          <Text>내용</Text>
        </SheetScroll>
      </Sheet>,
      true,
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('scroll').props.contentContainerStyle).paddingBottom,
    ).toBe(space.lg + space.lg);
  });

  it('시트가 키보드에 앉으면 키보드 모서리 뒤로 시트 바탕이 더 깔린다 - 스크림 쐐기를 가린다 (design-review r3 L1·r4 L2)', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    expect(screen.queryByTestId('page-sheet-keyboard-corner')).toBeNull();
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    const corner = flat('page-sheet-keyboard-corner');
    // 시트 바닥 아래(키보드 뒤)로 나가 있고, 시트와 같은 바탕이며, 키보드의 둥근 모서리(실측 쐐기 24)보다 깊다.
    expect(corner.bottom).toBe(-SHEET.keyboardCorner);
    expect(corner.height).toBe(SHEET.keyboardCorner);
    expect(SHEET.keyboardCorner).toBeGreaterThanOrEqual(24);
    expect(corner.backgroundColor).toBe(paletteFor('light').sheet);
    expect(screen.getByTestId('page-sheet-keyboard-corner').props.pointerEvents).toBe('none');
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, se.height));
    });
    expect(screen.queryByTestId('page-sheet-keyboard-corner')).toBeNull();
  });

  it('큰 단은 올라가지 않으니 모서리 바탕도 깔지 않는다 - 시트가 키보드 아래까지 이어져 쐐기가 없다', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="large" onClose={() => {}} />, true);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    expect(screen.queryByTestId('page-sheet-keyboard-corner')).toBeNull();
  });

  it('큰 단의 몸 스크롤은 키보드가 올라와도 안전 영역 여백을 그대로 둔다 - 시트가 올라가지 않았으니 걷을 이유가 없다', async () => {
    useInsets(0, 34);
    await mount(
      <Sheet height="large" onClose={() => {}}>
        <SheetScroll testID="scroll">
          <Text>내용</Text>
        </SheetScroll>
      </Sheet>,
      true,
    );
    const padding = () =>
      StyleSheet.flatten(screen.getByTestId('scroll').props.contentContainerStyle).paddingBottom;
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    expect(padding()).toBe(34 + space.lg);
  });

  it('키보드가 올라온 채 닫으면 키보드도 같이 내린다 - 시트가 다 나간 뒤에야 혼자 내려가지 않는다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    fireEvent.press(screen.getByTestId('close'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('시트가 서기 전에 올라와 있던 키보드(대화 입력창의 것)는 닫아도 접지 않는다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    // 키보드가 이미 올라온 채 시트가 선다 — Keyboard 모듈은 did 이벤트로 「보이는 중」을 기억한다.
    act(() => {
      emitter().emit('keyboardDidShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    // 처음부터 키보드 위에 선다(올라온 뒤에 따라 올리지 않는다).
    expect(flat('page-sheet').bottom).toBe(336);
    fireEvent.press(screen.getByTestId('close'));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => {
      emitter().emit('keyboardDidHide', keyboardFrame(0, BASE_WINDOW.height));
    });
  });

  it('시트가 선 뒤에 키보드가 한 번 내려갔다 시트 안 입력으로 다시 올라오면 그것은 시트의 것이다 - 닫을 때 같이 내린다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    act(() => {
      emitter().emit('keyboardDidShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    // 처음엔 대화 입력창의 키보드(시트 것이 아니다). 그것이 내려갔다가
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, BASE_WINDOW.height));
    });
    act(() => {
      emitter().emit('keyboardDidHide', keyboardFrame(0, BASE_WINDOW.height));
    });
    // 시트 안의 입력이 새로 부른 키보드가 올라온다.
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    fireEvent.press(screen.getByTestId('close'));
    expect(dismiss).toHaveBeenCalledTimes(1);
    act(() => {
      emitter().emit('keyboardDidHide', keyboardFrame(0, BASE_WINDOW.height));
    });
  });

  it('키보드가 없으면 닫을 때 키보드를 건드리지 않는다', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await mount(<Sheet height="medium" onClose={() => {}} />, true);
    fireEvent.press(screen.getByTestId('close'));
    expect(dismiss).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 행동은 닫은 뒤에 - 그릇의 배선
// ---------------------------------------------------------------------------

describe('행동은 시트가 미끄러져 내린 뒤에 한 번 불린다 (usePageSheetAction)', () => {
  it('동작 줄이기를 켜면 바로 - onClose 가 먼저, 행동이 나중, 각각 한 번', async () => {
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push('close'));
    const action = jest.fn(() => calls.push('action'));
    await mount(
      <Sheet onClose={onClose}>
        <RunAfterClose action={action} />
      </Sheet>,
      true,
    );
    fireEvent.press(screen.getByTestId('run'));
    expect(calls).toEqual(['close', 'action']);
  });

  it('동작 줄이기가 꺼져 있으면 화면 높이만큼 미끄러져 나간 뒤에야 불린다', async () => {
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push('close'));
    const action = jest.fn(() => calls.push('action'));
    const timing = jest.spyOn(Animated, 'timing');
    await mount(
      <Sheet onClose={onClose}>
        <RunAfterClose action={action} />
      </Sheet>,
      false,
    );
    expect(timing).toHaveBeenCalledTimes(1); // 올라올 때
    fireEvent.press(screen.getByTestId('run'));
    // 누른 그 순간에는 아무것도 불리지 않았고, 내려가는 애니메이션이 시작됐다.
    expect(action).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(timing).toHaveBeenCalledTimes(2);
    expect(timing.mock.calls[1][1]).toMatchObject({toValue: BASE_WINDOW.height});
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1), {timeout: 8000});
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['close', 'action']);
  }, 15000);

  it('두 번 눌러도 행동은 한 번이다', async () => {
    const action = jest.fn();
    const onClose = jest.fn();
    await mount(
      <Sheet onClose={onClose}>
        <RunAfterClose action={action} />
      </Sheet>,
      false,
    );
    fireEvent.press(screen.getByTestId('run'));
    fireEvent.press(screen.getByTestId('run'));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1), {timeout: 8000});
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  }, 15000);

  it('이미 X 로 닫는 중이면 행동은 불리지 않는다 - 닫는 길이 하나라 먼저 시작한 쪽이 이긴다', async () => {
    const action = jest.fn();
    const onClose = jest.fn();
    await mount(
      <Sheet onClose={onClose}>
        <RunAfterClose action={action} />
      </Sheet>,
      true,
    );
    fireEvent.press(screen.getByTestId('close'));
    fireEvent.press(screen.getByTestId('run'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it('시트 밖에서는 바로 부른다 - 닫을 시트가 없다', async () => {
    const action = jest.fn();
    await mount(<RunAfterClose action={action} />, false);
    fireEvent.press(screen.getByTestId('run'));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('X 는 누름 이벤트를 인자로 받아도 행동으로 오해하지 않는다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    // Pressable 은 첫 인자로 이벤트를 넘긴다. 닫는 함수가 그것을 `after` 로 받으면 객체를 함수로 부르다 터진다.
    fireEvent.press(screen.getByTestId('close'), {nativeEvent: {}});
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });

  it('스크림도 누름 이벤트를 인자로 받아도 행동으로 오해하지 않는다', async () => {
    const onClose = jest.fn();
    await mount(<Sheet onClose={onClose} />, true);
    fireEvent.press(screen.getByTestId('page-sheet-scrim', {includeHiddenElements: true}), {
      nativeEvent: {},
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });
});

describe('ListRow · ActionTile 의 closesSheet', () => {
  it('ListRow closesSheet: 누르면 시트가 먼저 닫히고 그 뒤에 onPress 가 한 번', async () => {
    const calls: string[] = [];
    const onPress = jest.fn(() => calls.push('press'));
    const onClose = jest.fn(() => calls.push('close'));
    await mount(
      <Sheet onClose={onClose}>
        <ListRow title="답글 달기" onPress={onPress} closesSheet testID="row" />
      </Sheet>,
      false,
    );
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).not.toHaveBeenCalled();
    await waitFor(() => expect(onPress).toHaveBeenCalledTimes(1), {timeout: 8000});
    expect(calls).toEqual(['close', 'press']);
  }, 15000);

  it('closesSheet 가 없으면 시트를 닫지 않고 바로 부른다 (진행을 시트가 보이는 행)', async () => {
    const onPress = jest.fn();
    const onClose = jest.fn();
    await mount(
      <Sheet onClose={onClose}>
        <ListRow title="알림 끄기" onPress={onPress} testID="row" />
      </Sheet>,
      false,
    );
    fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('토글 행은 closesSheet 를 줘도 닫지 않는다 - 켜고 끄는 일이다', async () => {
    const onValueChange = jest.fn();
    const onClose = jest.fn();
    await mount(
      <Sheet onClose={onClose}>
        <ListRow
          title="푸시"
          accessory="toggle"
          toggle={{value: false, onValueChange}}
          onPress={() => {}}
          closesSheet
          testID="row"
        />
      </Sheet>,
      true,
    );
    fireEvent.press(screen.getByTestId('row'));
    expect(onValueChange).toHaveBeenCalledWith(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ActionTile closesSheet: 시트가 먼저 닫히고 그 뒤에 onPress 가 한 번', async () => {
    const calls: string[] = [];
    const onPress = jest.fn(() => calls.push('press'));
    const onClose = jest.fn(() => calls.push('close'));
    await mount(
      <Sheet onClose={onClose}>
        <ActionTile icon={<Text>아이콘</Text>} label="메시지" onPress={onPress} closesSheet testID="tile" />
      </Sheet>,
      true,
    );
    fireEvent.press(screen.getByTestId('tile'));
    expect(calls).toEqual(['close', 'press']);
  });
});

// ---------------------------------------------------------------------------
// 닫는 길의 정체성·끼어들기 (코드 검수 L1·L2·L3)
// ---------------------------------------------------------------------------

describe('닫는 길은 부모가 리렌더돼도 키보드가 오르내려도 같은 함수다', () => {
  it('usePageSheetClose() 의 정체성이 onClose 교체·키보드 이벤트에도 바뀌지 않는다', async () => {
    const seen: Array<(() => void) | null> = [];
    function Capture() {
      seen.push(usePageSheetClose());
      return null;
    }
    const first = jest.fn();
    const utils = await mount(
      <Sheet height="medium" onClose={first}>
        <Capture />
      </Sheet>,
      true,
    );
    // 부모가 렌더마다 새 화살표를 준다(MessageRow 의 `onClose={() => setSheetOpen(false)}` 처럼).
    utils.rerender(
      <FixedScheme scheme="light">
        <Sheet height="medium" onClose={() => {}}>
          <Capture />
        </Sheet>
      </FixedScheme>,
    );
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(336, BASE_WINDOW.height));
    });
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, BASE_WINDOW.height));
    });
    const distinct = new Set(seen.filter(Boolean));
    // 정체성이 바뀌면 끌기 응답자가 새 인스턴스로 갈려 끄는 도중의 제스처가 리셋되고, 이 함수를 의존성으로 든 소비자의
    // 효과(`AskMacSheet` 의 대기 타이머)가 다시 돈다.
    expect(distinct.size).toBe(1);
  });

  it('슬라이드가 도는 동안 부모가 새 onClose 로 리렌더하면 끝에서 부르는 것은 최신이다', async () => {
    const stale = jest.fn();
    const latest = jest.fn();
    const utils = await mount(<Sheet onClose={stale} />, false);
    fireEvent.press(screen.getByTestId('close'));
    utils.rerender(
      <FixedScheme scheme="light">
        <Sheet onClose={latest} />
      </FixedScheme>,
    );
    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1), {timeout: 8000});
    expect(stale).not.toHaveBeenCalled();
  }, 15000);
});

describe('닫는 중에는 손잡이를 잡아도 시트가 끼어들지 않는다', () => {
  it('슬라이드가 도는 중의 세로 끌기는 응답자를 가져가지 않는다 (끌기가 슬라이드를 끊어 행동을 앞당기지 않게)', async () => {
    await mount(<Sheet onClose={() => {}} />, false);
    fireEvent.press(screen.getByTestId('close')); // 슬라이드가 도는 중
    const handlers = screen.getByTestId('page-sheet-handle').props as Handlers;
    const drag = touch(20, 50, 0); // 세로로 6pt 를 넘는 첫 이동
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1));
      handlers.onMoveShouldSetResponderCapture(drag);
    });
    expect(handlers.onMoveShouldSetResponder(drag)).toBe(false);
  });

  it('대조: 닫는 중이 아니면 같은 끌기를 잡는다', async () => {
    await mount(<Sheet onClose={() => {}} />, false);
    const handlers = screen.getByTestId('page-sheet-handle').props as Handlers;
    const drag = touch(20, 50, 0);
    act(() => {
      handlers.onStartShouldSetResponderCapture(touch(0, 1));
      handlers.onMoveShouldSetResponderCapture(drag);
    });
    expect(handlers.onMoveShouldSetResponder(drag)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 공용 부품의 기본값 — 접근성 이름·문장·토글·머리 아래 여백 (design-review r1/r2)
// ---------------------------------------------------------------------------

describe('ListRow 의 기본 이름·보조 줄·토글 트랙', () => {
  it('눌리는 행의 기본 이름은 제목·보조 줄·값을 이어 읽는다 (값 행이 낭독에서 빠지지 않게)', async () => {
    await mount(
      <ListRow
        title="상태"
        detail="회의 중에만 보여요"
        value="회의 중"
        accessory="chevron"
        onPress={() => {}}
        testID="row"
      />,
      true,
    );
    expect(screen.getByTestId('row').props.accessibilityLabel).toBe('상태, 회의 중에만 보여요, 회의 중');
  });

  it('값도 보조 줄도 없으면 제목뿐이고, 이름을 직접 주면 그것이 이긴다', async () => {
    await mount(
      <>
        <ListRow title="로그아웃" onPress={() => {}} testID="plain" />
        <ListRow
          title="상태"
          value="회의 중"
          accessibilityLabel="내 상태 바꾸기"
          onPress={() => {}}
          testID="named"
        />
      </>,
      true,
    );
    expect(screen.getByTestId('plain').props.accessibilityLabel).toBe('로그아웃');
    expect(screen.getByTestId('named').props.accessibilityLabel).toBe('내 상태 바꾸기');
  });

  it('보조 줄이 `hangul-word` 줄바꿈 전략을 든다 (옛 GroupRow.detail 은 Sentence 였다 — 렌더된 줄바꿈은 캡처가 잰다)', async () => {
    await mount(<ListRow title="방해 금지" detail="정해 둔 시간에는 알림을 받지 않아요" testID="row" />, true);
    expect(screen.getByTestId('row-detail').props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('토글의 꺼짐 트랙은 컨트롤 경계라 카드 위에서 비텍스트 3:1 을 넘는다 — 모든 테마·모드', () => {
    const weak: string[] = [];
    for (const theme of THEME_IDS) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = paletteFrom(theme, mode);
        for (const ground of ['surface', 'sheet'] as const) {
          const ratio = contrast(palette.textFaint, palette[ground]);
          if (ratio < 3) weak.push(`${theme}/${mode}/${ground}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(weak).toEqual([]);
  });

  it('렌더된 토글이 그 색을 쓴다 (꺼짐 = textFaint, 켜짐 = ok)', async () => {
    await mount(
      <ListRow
        title="푸시"
        accessory="toggle"
        toggle={{value: false, onValueChange: () => {}}}
        testID="row"
      />,
      true,
    );
    const palette = paletteFor('light');
    const track = screen.UNSAFE_getByType(Switch).props.trackColor;
    expect(track).toEqual({false: palette.textFaint, true: palette.ok});
  });
});

describe('SheetScroll · InputPill 의 기본값', () => {
  it('SheetScroll 은 머리 줄 아래 숨 쉴 틈을 준다 (원 아래 6 + 12 = 18)', async () => {
    await mount(
      <Sheet height="medium" onClose={() => {}}>
        <SheetScroll testID="scroll">
          <Text>내용</Text>
        </SheetScroll>
      </Sheet>,
      true,
    );
    expect(StyleSheet.flatten(screen.getByTestId('scroll').props.contentContainerStyle).paddingTop).toBe(
      SHEET.bodyTop,
    );
    // 머리 줄(52)에서 원(40)이 위아래로 남기는 6 과 더해 Buzz 의 약 19 에 닿는다.
    expect((SHEET.headerRow - SHEET.circle) / 2 + SHEET.bodyTop).toBe(18);
  });

  describe('내용이 시트를 넘치면 스크롤 막대를 한 번 보인다 (접힌 행의 단서, design-review r4 M1)', () => {
    // RN 의 jest ScrollView 는 `flashScrollIndicators` 를 프로토타입에 공유 jest.fn 으로 갖는다 — 호출 수의 증가분을 본다.
    const flashCalls = () =>
      (ScrollView.prototype as unknown as {flashScrollIndicators: jest.Mock}).flashScrollIndicators.mock
        .calls.length;
    const layout = (viewport: number) =>
      fireEvent(screen.getByTestId('scroll'), 'layout', {
        nativeEvent: {layout: {x: 0, y: 0, width: 375, height: viewport}},
      });
    const content = (height: number) =>
      fireEvent(screen.getByTestId('scroll'), 'contentSizeChange', 375, height);
    const sheet = (props: React.ComponentProps<typeof SheetScroll> = {children: null}) => (
      <Sheet height="medium" onClose={() => {}}>
        <SheetScroll testID="scroll" {...props}>
          <Text>내용</Text>
        </SheetScroll>
      </Sheet>
    );

    it('넘치면 한 번만 보인다 - 크기가 다시 와도 되풀이하지 않는다', async () => {
      await mount(sheet(), true);
      const before = flashCalls();
      layout(400);
      expect(flashCalls()).toBe(before);
      content(700);
      expect(flashCalls()).toBe(before + 1);
      content(900);
      layout(380);
      expect(flashCalls()).toBe(before + 1);
    });

    it('내용이 먼저 와도 같다 - 두 크기가 모두 알려진 순간에 한 번', async () => {
      await mount(sheet(), true);
      const before = flashCalls();
      content(700);
      expect(flashCalls()).toBe(before);
      layout(400);
      expect(flashCalls()).toBe(before + 1);
    });

    it('내용이 시트 안에 들어가면 보이지 않는다 - 넘치지 않는 시트에 막대를 깜빡이지 않는다', async () => {
      await mount(sheet(), true);
      const before = flashCalls();
      layout(400);
      content(400);
      content(401); // 1pt 의 반올림 오차는 넘침이 아니다
      expect(flashCalls()).toBe(before);
    });

    it.each(['light', 'dark'] as const)(
      '막대 색이 시스템이 아니라 앱의 %s 모양을 따른다 — 시스템 모양과 엇갈려도 시트 바탕 위에서 보인다 (design-review r6 M1)',
      async scheme => {
        await mount(sheet(), true, scheme);
        // UIKit 은 막대 색을 시스템 모양으로 정한다 — 앱 다크 + 시스템 라이트면 검은 막대가 어두운 시트 위에 서 대비 1.07 이었다.
        expect(screen.getByTestId('scroll').props.indicatorStyle).toBe(scheme === 'light' ? 'black' : 'white');
      },
    );

    it('호출자가 indicatorStyle 을 주면 그것이 이긴다', async () => {
      await mount(sheet({indicatorStyle: 'default', children: null}), true, 'dark');
      expect(screen.getByTestId('scroll').props.indicatorStyle).toBe('default');
    });

    it('호출자가 준 onLayout·onContentSizeChange 도 그대로 불린다', async () => {
      const onLayout = jest.fn();
      const onContentSizeChange = jest.fn();
      await mount(sheet({onLayout, onContentSizeChange, children: null}), true);
      layout(400);
      content(700);
      expect(onLayout).toHaveBeenCalledTimes(1);
      expect(onContentSizeChange).toHaveBeenCalledWith(375, 700);
    });
  });

  it('InputPill 은 호출자의 style 을 덮지 않고 이어 붙인다 (알약 입력 스타일의 flex 가 남는다)', async () => {
    await mount(
      <InputPill accessibilityLabel="이름" style={{color: 'red'}} testID="pill" />,
      true,
    );
    const input = StyleSheet.flatten(screen.getByLabelText('이름').props.style);
    expect(input.color).toBe('red');
    expect(input.flex).toBe(1);
  });
});

describe('RowEmoji — 앞 칸 이모지는 22pt 칸을 넘지 않는다 (design-review r4 M2)', () => {
  it('글자 배율을 따라가지 않고, 그 상한의 이모지 폭이 아이콘 칸 안이다', async () => {
    await mount(<RowEmoji emoji="📅" />, true);
    const glyph = screen.getByText('📅', {includeHiddenElements: true});
    expect(glyph.props.maxFontSizeMultiplier).toBe(ROW_GLYPH_MAX_SCALE);
    // 이모지의 폭은 글리프 크기의 1.25배쯤이다(어림이고, 상한을 올리면 이 부등식이 먼저 깨진다). AX5 캡처에서 상한이 없던
    // 때 「📅 회의 중」의 이모지가 22pt 칸 오른쪽에서 잘려 조각만 남았다.
    expect(Math.ceil(font.heading * ROW_GLYPH_MAX_SCALE * 1.25)).toBeLessThanOrEqual(SHEET.iconSlot);
    // 대조: 글자 배율 1.5 를 허용했다면 칸을 넘는다.
    expect(Math.ceil(font.heading * 1.5 * 1.25)).toBeGreaterThan(SHEET.iconSlot);
  });
});

describe('ConfirmStep — 시트 안의 확인 단계', () => {
  const step = (override: Partial<React.ComponentProps<typeof ConfirmStep>> = {}) => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    const ui = (
      <ConfirmStep
        testID="confirm"
        headline="메시지를 지울까요?"
        detail="지운 메시지는 되돌릴 수 없습니다."
        confirmLabel="지우기"
        pendingLabel="지우는 중…"
        onCancel={onCancel}
        onConfirm={onConfirm}
        cancelTestID="cancel"
        confirmTestID="ok"
        errorTestID="err"
        {...override}
      />
    );
    return {ui, onCancel, onConfirm};
  };

  it('머리말·설명·단추 둘이 서고 각 단추가 제 일을 부른다', async () => {
    const {ui, onCancel, onConfirm} = step();
    await mount(ui, true);
    expect(screen.getByText('메시지를 지울까요?')).toBeTruthy();
    // 머리말도 설명도 어절 단위 줄바꿈 전략을 든다(렌더된 줄바꿈은 캡처가 잰다 - 아래 문구 훑기가 못 잡는 것).
    expect(screen.getByTestId('confirm-headline').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(screen.getByTestId('confirm-detail').props.lineBreakStrategyIOS).toBe('hangul-word');
    fireEvent.press(screen.getByTestId('cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('ok'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('두 단추의 라벨은 어절 단위로 접히고(`hangul-word`) 가운데 정렬이며 단추에 가로 여백이 있다 — AX5 에서 어절이 가운데서 끊기고 글자가 테두리에 붙던 것 (design-review #4318 r6-M2)', async () => {
    const {ui} = step({cancelLabel: '취소', confirmLabel: '채널 나가기'});
    await mount(ui, true);
    for (const [label, testID] of [
      ['취소', 'cancel'],
      ['채널 나가기', 'ok'],
    ] as const) {
      // 라벨은 문장 부품(`Sentence`)이라 줄바꿈이 어절 단위다 — 「채널 나/가기」로 어절 가운데서 끊기지 않는다.
      const text = screen.getByText(label);
      expect([label, text.props.lineBreakStrategyIOS]).toEqual([label, 'hangul-word']);
      expect([label, StyleSheet.flatten(text.props.style).textAlign]).toEqual([label, 'center']);
      // 단추 상자가 가로 여백을 준다 — 글자가 테두리에 붙지 않는다(두 줄이 되어도).
      expect([testID, flat(testID).paddingHorizontal]).toEqual([testID, space.sm]);
    }
  });

  it('실패 문장은 확인 단계 안에 alert 로 서고 `hangul-word` 줄바꿈 전략을 든다', async () => {
    const {ui} = step({error: '지우지 못했습니다.'});
    await mount(ui, true);
    expect(screen.getByTestId('err').props.accessibilityRole).toBe('alert');
    expect(screen.getByTestId('err').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(screen.getByTestId('err')).toHaveTextContent('지우지 못했습니다.');
  });

  it('실패가 새로 서면 보조기술이 읽어 준다 - 같은 문장이 남아 있는 동안은 되풀이하지 않고, 없으면 읽을 것도 없다 (iOS 는 alert 역할만으로는 낭독하지 않는다)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    // RN 의 jest 목은 이미 `jest.fn()` 이라 앞 시험의 호출이 남아 있다 - 이 시험의 호출만 센다.
    announce.mockClear();
    const view = await mount(step({error: null}).ui, true);
    const show = (error: string | null) =>
      view.rerender(<FixedScheme scheme="light">{step({error}).ui}</FixedScheme>);
    expect(announce).not.toHaveBeenCalled();
    show('지우지 못했습니다.');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('지우지 못했습니다.');
    show('지우지 못했습니다.');
    expect(announce).toHaveBeenCalledTimes(1);
    show(null);
    expect(announce).toHaveBeenCalledTimes(1);
    show('연결이 끊겼습니다. 잠시 뒤에 다시 시도하세요.');
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith('연결이 끊겼습니다. 잠시 뒤에 다시 시도하세요.');
  });

  it('실패가 없으면 그 줄도 없다', async () => {
    const {ui} = step({error: null});
    await mount(ui, true);
    expect(screen.queryByTestId('err')).toBeNull();
  });

  it('왕복 중에는 위험 단추가 잠기고 낱말과 busy 가 진행을 말한다', async () => {
    const {ui, onConfirm} = step({pending: true});
    await mount(ui, true);
    expect(screen.getByText('지우는 중…')).toBeTruthy();
    expect(screen.getByTestId('ok').props.accessibilityState).toMatchObject({busy: true, disabled: true});
    fireEvent.press(screen.getByTestId('ok'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('지시 기기 패널의 카드는 바깥 가로 여백을 스스로 진다', () => {
  it('GroupCard 는 폭 전체로 서므로, 호스트(날 ScrollView)가 안 주는 패널이 SAFE_GUTTER 를 든다', async () => {
    await mount(
      <DeviceKeyPanel
        state={{
          view: {kind: 'unsupported'},
          enroll: () => {},
          replace: () => {},
          refresh: () => {},
          busy: false,
          failure: null,
        }}
      />,
      true,
    );
    // 이 PR 이 `GroupSection`(스스로 16 을 졌다) → `GroupCard`(안 진다)로 바꾸며 카드만 화면 가장자리까지 번졌다.
    expect(flat('device-key-card').paddingHorizontal).toBe(SAFE_GUTTER);
  });

  it('호스트(지시 기기 시트의 몸)는 가로 여백을 더하지 않는다 - 패널과 호스트가 둘 다 지면 카드가 32pt 로 이중 인셋된다 (design-review r3 L9)', async () => {
    useInsets(0, 0);
    await mount(
      <LinkSheetBody
        onClose={() => {}}
        state={{
          view: {kind: 'unsupported'},
          enroll: () => {},
          replace: () => {},
          refresh: () => {},
          busy: false,
          failure: null,
        }}
      />,
      true,
    );
    const content = StyleSheet.flatten(
      screen.getByTestId('device-key-link-scroll').props.contentContainerStyle,
    );
    // 카드의 16 은 패널이 진다. 호스트가 또 주면 패널 단독 시험(위)은 초록인 채 화면만 32 로 좁아진다.
    expect(content.paddingHorizontal).toBeUndefined();
    expect(content.paddingLeft).toBeUndefined();
    expect(content.paddingRight).toBeUndefined();
    expect(flat('device-key-card').paddingHorizontal).toBe(SAFE_GUTTER);
  });
});

// ---------------------------------------------------------------------------
// MessageActionSheet - 닫는 길로 보내는 행동과 보내지 않는 행동
// ---------------------------------------------------------------------------

const MESSAGE = {
  id: 'm-4318',
  channelId: 'ch-4318',
  seq: 7,
  hlcTs: 7,
  hlcCount: 0,
  authorMemberId: 'member-a',
  type: 'text',
  body: '금요일 배포는 오전 10시예요.',
  state: 'sent',
  createdAtMs: Date.UTC(2026, 9, 25, 1, 0),
} as unknown as Message;

const AVAILABILITY = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  edit: true,
  delete: true,
} as never;

function messageSheet(calls: string[]) {
  const record = (name: string) => jest.fn(() => calls.push(name));
  const handlers = {
    onClose: record('close'),
    onToggleReaction: record('react'),
    onReply: record('reply'),
    onQuote: record('quote'),
    onCopy: record('copy'),
    onPin: record('pin'),
    onEdit: record('edit'),
    onDelete: record('delete'),
  };
  const ui = (
    <MessageActionSheet
      message={MESSAGE}
      chips={[]}
      availability={AVAILABILITY}
      authorLabel="이도현"
      {...handlers}
    />
  );
  return {handlers, ui};
}

describe('메시지 행동 시트: 고르면 곧 닫히는 행동은 슬라이드 뒤에 불린다', () => {
  const CLOSING: [label: string, testID: string, handler: keyof ReturnType<typeof messageSheet>['handlers'], name: string][] = [
    ['답글 달기', 'sheet-reply', 'onReply', 'reply'],
    ['인용하기', 'sheet-quote', 'onQuote', 'quote'],
    ['복사하기', 'sheet-copy', 'onCopy', 'copy'],
    ['고정하기', 'sheet-pin', 'onPin', 'pin'],
    ['고치기', 'sheet-edit', 'onEdit', 'edit'],
    ['빠른 반응', `quick-reaction-${QUICK_REACTIONS[0]}`, 'onToggleReaction', 'react'],
  ];

  it.each(CLOSING)('%s: 누른 순간엔 아무것도 안 불리고, 슬라이드가 끝나면 onClose → 행동이 한 번', async (_label, testID, handler, name) => {
    const calls: string[] = [];
    const {handlers, ui} = messageSheet(calls);
    const timing = jest.spyOn(Animated, 'timing');
    await mount(ui, false);
    fireEvent.press(screen.getByTestId(testID));
    expect(handlers[handler]).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(timing.mock.calls.at(-1)?.[1]).toMatchObject({toValue: BASE_WINDOW.height});
    await waitFor(() => expect(handlers[handler]).toHaveBeenCalledTimes(1), {timeout: 8000});
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['close', name]);
  }, 15000);

  it.each(CLOSING)('%s: 동작 줄이기를 켜면 바로 불린다', async (_label, testID, handler, name) => {
    const calls: string[] = [];
    const {handlers, ui} = messageSheet(calls);
    await mount(ui, true);
    fireEvent.press(screen.getByTestId(testID));
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['close', name]);
  });

  it('미리보기와 삭제 확인의 머리말·설명이 `hangul-word` 줄바꿈 전략을 든다 (렌더된 줄바꿈과 조사 고아는 캡처와 아래 문구 훑기가 잰다)', async () => {
    const calls: string[] = [];
    const {ui} = messageSheet(calls);
    await mount(ui, true);
    expect(screen.getByTestId('sheet-preview-body').props.lineBreakStrategyIOS).toBe('hangul-word');
    fireEvent.press(screen.getByTestId('sheet-delete'));
    expect(screen.getByTestId('delete-confirm-headline').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(screen.getByTestId('delete-confirm-detail').props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('「지우기」 행은 시트를 닫지 않고 확인 단계로 넘어갈 뿐이다', async () => {
    const calls: string[] = [];
    const {handlers, ui} = messageSheet(calls);
    await mount(ui, false);
    fireEvent.press(screen.getByTestId('sheet-delete'));
    expect(screen.getByTestId('delete-confirm')).toBeTruthy();
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('확인의 「지우기」는 바로 부른다 - 왕복 중 시트가 「지우는 중…」을 말해야 하므로 닫는 길로 보내지 않는다', async () => {
    const calls: string[] = [];
    const {handlers, ui} = messageSheet(calls);
    await mount(ui, false);
    fireEvent.press(screen.getByTestId('sheet-delete'));
    fireEvent.press(screen.getByTestId('delete-confirm-button'));
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});

describe('메시지 시트의 빠른 반응은 접근성 가장 큰 글씨에서도 한 줄에 닿는다', () => {
  it('이모지 글리프가 배율 상한을 갖고, 그 상한에서 여섯이 SE 카드 안쪽 폭에 들어간다', async () => {
    const {ui} = messageSheet([]);
    await mount(ui, true);
    for (const emoji of QUICK_REACTIONS) {
      const glyph = within(screen.getByTestId(`quick-reaction-${emoji}`)).getByText(emoji);
      expect(glyph.props.maxFontSizeMultiplier).toBe(REACTION_GLYPH_MAX_SCALE);
    }
    // AX5 캡처에서 상한이 없던 때 5·6번째가 카드 밖으로 밀려 닿지 않았다. 이모지의 폭은 글리프 크기의 1.25배쯤이다
    // (어림이고, 상한을 올리면 아래 부등식이 먼저 깨진다). 눌림 상자는 44 아래로 줄지 않는다.
    const glyphWidth = Math.ceil(font.title * REACTION_GLYPH_MAX_SCALE * 1.25);
    const buttonWidth = Math.max(TOUCH_TARGET, glyphWidth);
    const seCardInner = 375 - 2 * SAFE_GUTTER - 2 * space.sm;
    expect(QUICK_REACTIONS.length * buttonWidth).toBeLessThanOrEqual(seCardInner);
  });
});

// ---------------------------------------------------------------------------
// ChannelActionSheet - 닫는 길로 보내지 않는다 · 앞 아이콘 없음
// ---------------------------------------------------------------------------

const TARGET = {
  channel: {id: 'ch-4318', kind: 'public' as const, topic: ''},
  title: '배포',
  muted: false,
  selfRole: 'member' as const,
  readState: null,
};

const ITEMS: ChannelActionItem[] = [
  {key: 'copy-name', cluster: 'copy', testKey: 'copy-name', label: '이름 복사하기'},
  {key: 'copy-link', cluster: 'copy', testKey: 'copy-link', label: '링크 복사하기'},
  {key: 'copy-id', cluster: 'copy', testKey: 'copy-id', label: 'ID 복사하기'},
  {key: 'mute', cluster: 'state', testKey: 'mute-toggle', label: '알림 끄기', separatorBefore: true},
  {
    key: 'leave',
    cluster: 'danger',
    testKey: 'leave',
    label: '채널 나가기',
    tone: 'danger',
    separatorBefore: true,
  },
];

function channelSheet(items: ChannelActionItem[], handlers: {onRun: jest.Mock; onClose: jest.Mock}) {
  return (
    <ChannelActionSheet
      target={TARGET}
      items={items}
      confirmingLeave={false}
      isPending={() => false}
      error={null}
      leave={{pending: false, error: null}}
      onRun={handlers.onRun}
      onConfirmLeave={() => {}}
      onCancelLeave={() => {}}
      onClose={handlers.onClose}
    />
  );
}

describe('대화 행 시트: 행동을 닫는 길로 보내지 않는다 - 시트가 진행·영수증·실패를 스스로 보인다', () => {
  it.each(['copy-name', 'mute-toggle', 'leave'])('%s: 누르면 바로 onRun, 시트는 그대로 떠 있다', async testKey => {
    const onRun = jest.fn();
    const onClose = jest.fn();
    const timing = jest.spyOn(Animated, 'timing');
    await mount(channelSheet(ITEMS, {onRun, onClose}), false);
    const slides = timing.mock.calls.length; // 올라올 때 한 번
    fireEvent.press(screen.getByTestId(`channel-sheet-${testKey}`));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(timing.mock.calls.length).toBe(slides); // 내려가는 애니메이션이 시작되지 않았다
    expect(screen.getByTestId('channel-action-sheet')).toBeTruthy();
  });
});

describe('대화 행 시트에는 앞 아이콘이 없다 — 글리프 여덟이 구워질 때 두 시트의 모든 카드에 한 번에 준다', () => {
  it('복사 무리에도 앞 칸이 없어 글자 열이 시트 전체에서 한 줄로 선다 (design-review r1 M2)', async () => {
    await mount(channelSheet(ITEMS, {onRun: jest.fn(), onClose: jest.fn()}), true);
    for (const key of ['copy-name', 'copy-link', 'copy-id', 'mute-toggle', 'leave']) {
      expect(screen.queryByTestId(`channel-sheet-${key}-lead`)).toBeNull();
    }
  });

  it('나가기 확인의 머리말·설명이 `hangul-word` 줄바꿈 전략을 든다 (렌더된 줄바꿈은 캡처가 잰다)', async () => {
    await mount(
      <ChannelActionSheet
        target={TARGET}
        items={ITEMS}
        confirmingLeave
        isPending={() => false}
        error={null}
        leave={{pending: false, error: null}}
        onRun={() => {}}
        onConfirmLeave={() => {}}
        onCancelLeave={() => {}}
        onClose={() => {}}
      />,
      true,
    );
    expect(screen.getByTestId('channel-leave-confirm-headline').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(screen.getByTestId('channel-leave-confirm-detail').props.lineBreakStrategyIOS).toBe('hangul-word');
  });

  it('행 시트의 오류 띠가 alert 이고 `hangul-word` 줄바꿈 전략을 든다 (design-review r4 M3)', async () => {
    await mount(
      <ChannelActionSheet
        target={TARGET}
        items={ITEMS}
        confirmingLeave={false}
        isPending={() => false}
        error="읽음 처리를 하지 못했습니다. 잠시 뒤에 다시 시도하세요."
        leave={{pending: false, error: null}}
        onRun={() => {}}
        onConfirmLeave={() => {}}
        onCancelLeave={() => {}}
        onClose={() => {}}
      />,
      true,
    );
    expect(screen.getByTestId('channel-sheet-error').props.lineBreakStrategyIOS).toBe('hangul-word');
    expect(screen.getByTestId('channel-sheet-error').props.accessibilityRole).toBe('alert');
  });
});

// ---------------------------------------------------------------------------
// 문구 훑기 — 「닫는 괄호 + 조사」 조합이 확인 단계 어디에도 없다 (design-review r4 H1)
//
// `hangul-word` 줄바꿈은 어절 **가운데** 끊김을 막지만 닫는 괄호 뒤의 조사는 못 붙잡는다(UAX #14 가 괄호 뒤를 끊김
// 자리로 본다): SE 폭(글자 열 311pt)에서 「…「삭제된 메시지」」 줄 다음 줄이 「가 남고, …」 로 시작했다. 그래서 이
// 단정은 prop 이 아니라 **렌더된 문장**을 훑는다 - 문구가 바뀌면 줄바꿈 위치가 다 바뀌므로 이 조합이 다시 생기는 날
// 가장 먼저 빨개져야 한다. 렌더된 폭에서 실제로 접히는 모양은 여전히 캡처만이 잰다.
// ---------------------------------------------------------------------------

/** 줄 머리로 떨어질 수 있는 닫는 괄호 바로 뒤의 한글(조사). 따옴표 `'`·`”` 는 줄을 끊지 않으므로 넣지 않는다. */
const BRACKET_PARTICLE = /[」』)\]）］〉》】〕｝][가-힣]/;

function sentencesOf(root: ReturnType<typeof within> | typeof screen): string[] {
  return root
    .UNSAFE_getAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children as React.ReactNode)
        .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
        .join(''),
    )
    .filter(text => text !== '');
}

describe('확인 단계의 문구에는 닫는 괄호 바로 뒤의 조사가 없다', () => {
  it('규칙 자체: 옛 삭제 확인 문장을 잡고, 고친 문장·괄호 없는 문장·따옴표 뒤 조사는 지나간다', () => {
    // 이 정규식이 아무것도 못 잡으면 아래 훑기는 영원히 초록이다 - 옛 문장으로 먼저 증명한다.
    expect(BRACKET_PARTICLE.test('자리에는 「삭제된 메시지」가 남고, 달려 있던 반응도')).toBe(true);
    expect(BRACKET_PARTICLE.test('이름(선택)을 적어요')).toBe(true);
    expect(BRACKET_PARTICLE.test('자리에는 「삭제된 메시지」 표시가 남고, 달려 있던 반응도')).toBe(false);
    expect(BRACKET_PARTICLE.test("'서연'에 맞는 사람이 없습니다.")).toBe(false);
    expect(BRACKET_PARTICLE.test('채널에서 나가지 못했습니다.')).toBe(false);
  });

  it('메시지 시트: 목록 상태와 삭제 확인 단계 모두', async () => {
    const calls: string[] = [];
    const {ui} = messageSheet(calls);
    await mount(ui, true);
    const listing = sentencesOf(screen);
    expect(listing.length).toBeGreaterThan(3);
    expect(listing.filter(text => BRACKET_PARTICLE.test(text))).toEqual([]);
    fireEvent.press(screen.getByTestId('sheet-delete'));
    const confirm = sentencesOf(within(screen.getByTestId('delete-confirm')));
    // 머리말·설명·「취소」·「지우기」 - 훑은 문장에 설명이 실제로 들어 있다.
    expect(confirm.some(text => text.includes('되돌릴 수 없습니다'))).toBe(true);
    expect(confirm.filter(text => BRACKET_PARTICLE.test(text))).toEqual([]);
  });

  // 코어가 나가기 실패에 주는 문장 전부 — 실제 문구가 훑기 대상이다(문구가 늘면 이 표도 는다).
  const LEAVE_FAILURES: [name: string, error: unknown][] = [
    ['403 권한 없음', new ApiError(403, 'forbidden')],
    ['404 이미 멤버가 아님', new ApiError(404, 'gone')],
    ['시간 초과', new NetworkError('timeout', REQUEST_TIMEOUT_MS)],
    ['연결 불가', new NetworkError('unreachable', REQUEST_TIMEOUT_MS)],
    ['그 밖의 실패', new Error('boom')],
  ];

  it('표의 실패 문장은 서로 다르다 - 같은 문장을 다섯 번 훑는 표가 아니다', () => {
    const texts = LEAVE_FAILURES.map(([, error]) => channelLeaveFailureMessage(error));
    expect(new Set(texts).size).toBe(LEAVE_FAILURES.length);
  });

  it.each(LEAVE_FAILURES)('대화 행 시트: 나가기 확인 + 코어의 실패 문장(%s)', async (_name, error) => {
    const failure = channelLeaveFailureMessage(error);
    await mount(
      <ChannelActionSheet
        target={TARGET}
        items={ITEMS}
        confirmingLeave
        isPending={() => false}
        error={null}
        leave={{pending: false, error: failure}}
        onRun={() => {}}
        onConfirmLeave={() => {}}
        onCancelLeave={() => {}}
        onClose={() => {}}
      />,
      true,
    );
    const confirm = sentencesOf(within(screen.getByTestId('channel-leave-confirm')));
    expect(confirm).toContain(failure);
    expect(confirm.filter(text => BRACKET_PARTICLE.test(text))).toEqual([]);
  });
});
