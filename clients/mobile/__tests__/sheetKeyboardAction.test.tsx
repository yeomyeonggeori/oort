import type {ChannelActionItem} from '@momo/core/features/channels/actionModel';
import {QUICK_REACTIONS} from '@momo/core/features/timeline/reactions';
import type {Message} from '@momo/core/lib/api';
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
  StyleSheet,
  Text,
} from 'react-native';

import {REACTION_GLYPH_MAX_SCALE} from '../src/design/atoms';
import {PageSheet, usePageSheetAction} from '../src/design/PageSheet';
import {SheetHeader} from '../src/design/SheetChrome';
import {sheetFrame, sheetTop, type SheetHeight} from '../src/design/sheetModel';
import {
  ActionTile,
  InputPill,
  ListRow,
  SheetScroll,
} from '../src/design/sheetParts';
import {FixedScheme} from '../src/design/theme';
import {font, SAFE_GUTTER, space, TOUCH_TARGET} from '../src/design/tokens';
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
const HEIGHTS: SheetHeight[] = ['fit', 'medium', 'large'];

let releaseReduceMotion: (() => void) | null = null;

afterEach(() => {
  cleanup();
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

async function mount(ui: React.ReactElement, reduceMotion = false) {
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(reduceMotion));
  releaseReduceMotion ??= retainReduceMotion();
  await act(async () => {});
  const utils = render(<FixedScheme scheme="light">{ui}</FixedScheme>);
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

  describe.each(DEVICES)('$name', device => {
    it.each(HEIGHTS)('%s: 시트 바닥 = 키보드 윗면 - 입력 칸은 시트 안이라 키보드 위다', height => {
      const {frame, bottomY} = box(height, device, device.keyboard);
      expect(frame.bottom).toBe(device.keyboard);
      expect(bottomY).toBe(device.height - device.keyboard);
    });

    it.each(HEIGHTS)('%s: 시트가 큰 단의 위 끝보다 높이 올라가 머리가 시계 뒤로 가지 않는다', height => {
      const {topY} = box(height, device, device.keyboard);
      expect(topY).toBeGreaterThanOrEqual(sheetTop(device.insetTop));
    });

    it.each(HEIGHTS)('%s: 키보드가 없으면 옛 상자 그대로다 - bottom 이 아예 없다', height => {
      const frame = sheetFrame(height, device.height, device.insetTop, 0);
      expect(frame).not.toHaveProperty('bottom');
      expect(frame).toEqual(sheetFrame(height, device.height, device.insetTop));
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

  it('큰 단은 위 끝이 그대로고 바닥만 올라간다', () => {
    const se = DEVICES[1];
    expect(sheetFrame('large', se.height, se.insetTop, se.keyboard)).toEqual({
      top: sheetTop(se.insetTop),
      bottom: se.keyboard,
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

  it('큰 단: 위 끝은 그대로고 바닥만 올라간다', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="large" onClose={() => {}} />, true);
    const before = flat('page-sheet').top;
    act(() => {
      emitter().emit('keyboardWillShow', keyboardFrame(se.keyboard, se.height));
    });
    expect(flat('page-sheet').top).toBe(before);
    expect(flat('page-sheet').bottom).toBe(se.keyboard);
  });

  it('did 쌍이 높이가 다르다고 말하면 따른다(하드웨어 키보드·예측 줄), 내려가면 0', async () => {
    const se = DEVICES[1];
    setWindow(se.width, se.height);
    useInsets(se.insetTop, 0);
    await mount(<Sheet height="large" onClose={() => {}} />, true);
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

  it('몸의 스크롤은 키보드가 올라오면 홈 인디케이터 여백을 걷는다 - 키보드가 그 자리를 이미 덮는다', async () => {
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
    expect(padding()).toBe(space.lg + space.lg);
    act(() => {
      emitter().emit('keyboardWillHide', keyboardFrame(0, BASE_WINDOW.height));
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
// ChannelActionSheet - 닫는 길로 보내지 않는다 + 앞 아이콘은 복사 무리만
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

describe('대화 행 시트의 앞 아이콘: 맞는 글리프가 이미 있는 무리만, 한 카드는 전부 아니면 전무', () => {
  it('복사 무리는 셋 다 앞 아이콘을 갖고, 알림·나가기는 갖지 않는다', async () => {
    await mount(channelSheet(ITEMS, {onRun: jest.fn(), onClose: jest.fn()}), true);
    for (const key of ['copy-name', 'copy-link', 'copy-id']) {
      expect(screen.queryByTestId(`channel-sheet-${key}-lead`)).not.toBeNull();
    }
    expect(screen.queryByTestId('channel-sheet-mute-toggle-lead')).toBeNull();
    expect(screen.queryByTestId('channel-sheet-leave-lead')).toBeNull();
  });

  it('글리프가 있는 줄과 없는 줄이 한 카드에 섞이면 아무도 아이콘을 갖지 않는다 (글자 열이 어긋나지 않게)', async () => {
    const mixed: ChannelActionItem[] = [
      {key: 'copy-name', cluster: 'copy', testKey: 'copy-name', label: '이름 복사하기'},
      // 같은 무리 안에 글리프가 없는 항목이 끼었다.
      {key: 'mute', cluster: 'copy', testKey: 'mute-toggle', label: '알림 끄기'},
    ];
    await mount(channelSheet(mixed, {onRun: jest.fn(), onClose: jest.fn()}), true);
    expect(screen.queryByTestId('channel-sheet-copy-name-lead')).toBeNull();
    expect(screen.queryByTestId('channel-sheet-mute-toggle-lead')).toBeNull();
  });
});
