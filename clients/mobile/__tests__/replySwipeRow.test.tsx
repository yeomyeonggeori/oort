import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, Text} from 'react-native';

import {__resetHapticClockForTests, setHapticMode, type HapticMode} from '../src/lib/haptics';
import {ReduceMotionRefContext} from '../src/features/conversation/LandedTintFade';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {ReplySwipeContainer} from '../src/features/conversation/ReplySwipeContainer';
import {
  REPLY_ACTIVATE_PX,
  REPLY_COMMIT_PX,
  replySwipeOffset,
} from '../src/features/conversation/replySwipe';
import {finger} from './fixtures/finger';

// =============================================================================
// 밀어서 답글 (#4869) — **배선**: 판정(`replySwipe.test.ts`)이 실제 응답자·행·시트에 옳게 묶여 있는가.
//
// 1부는 컨테이너를 직접 재생한다(손가락 하나가 응답자 플러그인에게 하는 호출 그대로 — `edgeSwipeBack.test.tsx` 와 같은
// `finger`). 2부는 진짜 `MessageRow` 위에서: 어떤 행이 밀리는지, 길게 눌러 시트가 열린 손가락은 안 미는지, 시트의 「답글 달기」가
// 같은 입력칸을 여는지. 세로 스크롤과의 경합(iOS 가 터치를 거두는 것)은 jest 가 못 보여 준다 — `runtime-unverified`.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPLY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;

const hapticCalls = (jest.requireMock('expo-haptics') as {__calls: string[]}).__calls;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '이서준', handle: 'seojun'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '그건 배포 뒤에 봅시다',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  hapticCalls.length = 0;
  // 기본 모드: 헬퍼의 100ms 창(풍부 모드의 중복 방어)이 **없다** — 이 시험의 「한 번」은 헬퍼가 아니라 컨테이너가 지킨다. 풍부 모드에서는
  // 창이 둘째 호출을 삼켜 컨테이너의 중복 방어가 죽어도 초록이 된다(사보타주로 확인했다).
  setHapticMode('basic');
  __resetHapticClockForTests();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
  cleanup();
});

const host = () =>
  screen.getByTestId('reply-swipe') as unknown as {
    props: Record<string, (event: unknown) => unknown>;
  };

/**
 * 아이콘 자리. 접근성에서 숨겨 둔 것이라(VoiceOver 의 길은 시트다) RNTL 기본 질의가 **못 본다** — 숨은 요소까지 물어야 「없다」 단정이
 * 언제나 참이 되지 않는다.
 */
const glyph = () =>
  screen.queryByTestId('reply-swipe-glyph', {includeHiddenElements: true});

/** 손가락 하나가 (300, 400)에서 시작한다. */
const X0 = 300;
const Y0 = 400;

describe('컨테이너 — 밀기', () => {
  function mount(
    options: {enabled?: boolean; reduced?: boolean} = {},
  ): {offset: {current: number | null}; onCommit: jest.Mock; unmount: () => void} {
    const offset = {current: null as number | null};
    const onCommit = jest.fn();
    const view = render(
      <ReduceMotionRefContext.Provider value={{current: options.reduced === true}}>
        <ReplySwipeContainer
          enabled={options.enabled ?? true}
          onCommit={onCommit}
          offsetRef={offset}>
          <Text>행</Text>
        </ReplySwipeContainer>
      </ReduceMotionRefContext.Provider>,
    );
    return {offset, onCommit, unmount: view.unmount};
  }

  it('손가락을 따라가고, 문턱을 처음 넘는 순간 햅틱 한 번, 놓으면 답글이 열리고 행은 제자리로 돌아온다', () => {
    const {offset, onCommit} = mount();
    const touch = finger(host());
    // 아이콘 자리는 끌기 동안만 선다 — 행마다 상시 노드를 지지 않는다.
    expect(glyph()).toBeNull();
    touch.down(X0, Y0);
    expect(offset.current).toBeNull(); // 시작에서는 아무 데도 안 갔다
    expect(glyph()).toBeNull();

    expect(touch.move(X0 - REPLY_ACTIVATE_PX, Y0)).toBe(true);
    expect(glyph()).not.toBeNull();
    // 가져온 순간부터 손가락과 같이 간다 — 순간이동이 아니라 따라오는 것이다.
    for (const pulled of [REPLY_ACTIVATE_PX, 30, 50, REPLY_COMMIT_PX - 1]) {
      touch.move(X0 - pulled, Y0);
      expect(offset.current).toBe(pulled);
    }
    expect(hapticCalls).toEqual([]); // 문턱 전에는 울리지 않는다

    touch.move(X0 - REPLY_COMMIT_PX, Y0);
    expect(offset.current).toBe(REPLY_COMMIT_PX);
    expect(hapticCalls).toEqual(['impact:light']); // 문턱을 넘은 그 순간 한 번

    touch.move(X0 - 140, Y0); // 문턱 뒤는 고무줄
    expect(offset.current).toBe(replySwipeOffset(-140));
    expect(offset.current).toBeGreaterThan(REPLY_COMMIT_PX);
    expect(hapticCalls).toHaveLength(1); // 더 밀어도 다시 울리지 않는다

    expect(onCommit).not.toHaveBeenCalled(); // 놓기 전에는 열리지 않는다
    touch.up();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(offset.current).toBe(0);
    expect(glyph()).toBeNull(); // 놓으면 걷힌다
  });

  it('문턱 전에 놓으면 아무 일도 없다 — 문턱을 넘었다 되돌아와서 놓아도 열리지 않고 햅틱은 제스처당 한 번이다', () => {
    const early = mount();
    let touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 40, Y0);
    touch.up();
    expect(early.onCommit).not.toHaveBeenCalled();
    expect(early.offset.current).toBe(0);
    expect(hapticCalls).toEqual([]);
    early.unmount();

    const back = mount();
    touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 100, Y0); // 문턱을 넘었다(울린다)
    touch.move(X0 - 30, Y0); // 되돌아왔다
    touch.move(X0 - 110, Y0); // 다시 넘었다 — 이 제스처에서는 다시 울리지 않는다
    touch.move(X0 - 30, Y0);
    touch.up();
    expect(hapticCalls).toEqual(['impact:light']);
    expect(back.onCommit).not.toHaveBeenCalled();
  });

  it.each([
    ['basic', 1],
    ['rich', 1],
    ['off', 0],
  ] as const)('햅틱은 앱 설정을 따른다 — %s 모드에서 문턱 최초 통과는 %i번', (mode: HapticMode, count: number) => {
    setHapticMode(mode);
    __resetHapticClockForTests();
    mount();
    const touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 30, Y0);
    touch.move(X0 - 90, Y0);
    touch.up();
    expect(hapticCalls).toHaveLength(count);
    if (count > 0) expect(hapticCalls).toEqual(['impact:light']);
  });

  it('잡지 않는 손: 시작에서 응답자를 쥐지 않고, 세로·왼→오·짧은 이동·밀 수 없는 행은 잡지 않는다', () => {
    const open = mount();
    const target = host();
    // 시작 응답자를 쥐면 iOS(Fabric)가 그 터치의 네이티브 스크롤을 못 시작하게 막는다(#4645) — 어느 길로도 쥐지 않는다.
    const start = {
      nativeEvent: {pageX: X0, pageY: Y0, touches: [{identifier: 0}]},
      touchHistory: {numberActiveTouches: 1, touchBank: [], mostRecentTimeStamp: 1, indexOfSingleActiveTouch: 0},
    };
    expect(target.props.onStartShouldSetResponder(start)).toBeFalsy();
    expect(target.props.onStartShouldSetResponderCapture(start)).toBe(false);

    const scenarios: Array<[string, Array<[number, number]>]> = [
      ['세로 스크롤', [[X0 - 3, Y0 + 40], [X0 - 12, Y0 + 90]]],
      ['왼→오(iOS 뒤로 가기)', [[X0 + 40, Y0], [X0 + 160, Y0]]],
      ['짧은 이동(탭 떨림)', [[X0 - 4, Y0 + 2], [X0 - 5, Y0 - 3]]],
      ['세로로 먼저 간 대각선', [[X0 - 2, Y0 + 30], [X0 - 200, Y0 + 30]]],
    ];
    for (const [, moves] of scenarios) {
      const touch = finger(host());
      touch.down(X0, Y0);
      for (const [x, y] of moves) expect(touch.move(x, y)).toBe(false);
      touch.up();
    }
    expect(open.onCommit).not.toHaveBeenCalled();
    expect(hapticCalls).toEqual([]);
    open.unmount();

    const closed = mount({enabled: false});
    const touch = finger(host());
    touch.down(X0, Y0);
    expect(touch.move(X0 - 90, Y0)).toBe(false);
    touch.up();
    expect(closed.onCommit).not.toHaveBeenCalled();
    expect(glyph()).toBeNull(); // 밀 수 없는 행에는 아이콘 자리도 없다
  });

  it('스크롤이 터치를 거두면(terminate) 답글 없이 제자리로 돌아온다 — 동작 줄이기면 미끄러지지 않고 바로 선다', () => {
    const spring = jest.spyOn(Animated, 'spring');
    const normal = mount();
    let touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 100, Y0);
    act(() => {
      host().props.onResponderTerminate({nativeEvent: {pageX: X0 - 100, pageY: Y0, touches: []}});
    });
    expect(normal.onCommit).not.toHaveBeenCalled();
    expect(normal.offset.current).toBe(0);
    expect(spring).toHaveBeenCalledTimes(1); // 대조: 보통은 미끄러져 돌아온다
    normal.unmount();
    spring.mockClear();

    const reduced = mount({reduced: true});
    touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 100, Y0);
    touch.up();
    expect(reduced.onCommit).toHaveBeenCalledTimes(1);
    expect(reduced.offset.current).toBe(0);
    expect(spring).not.toHaveBeenCalled();
  });
});

describe('행 — 어떤 행이 밀리고, 시트의 「답글 달기」는 어디로 가는가', () => {
  function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
    return {
      myMemberId: SELF,
      onToggleReaction: async () => {},
      onEdit: async () => {},
      onDelete: async () => {},
      ...over,
    };
  }

  function mountRow(row: Message, rowActions: MessageRowActions, standby?: boolean) {
    render(
      <MessageRow
        message={row}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS + 60_000}
        actions={rowActions}
        standby={standby}
      />,
    );
  }

  const swipe = () => {
    const touch = finger(host());
    touch.down(X0, Y0);
    touch.move(X0 - 40, Y0);
    touch.move(X0 - 90, Y0);
    touch.up();
    return touch;
  };

  it('밀 수 있는 행: 문턱을 넘겨 놓으면 그 메시지로 onReplyInline 이 한 번 — 스레드 화면은 열리지 않는다', () => {
    const onReplyInline = jest.fn();
    const onOpenThread = jest.fn();
    mountRow(message(), actions({onReplyInline, onOpenThread}));
    swipe();
    expect(onReplyInline).toHaveBeenCalledTimes(1);
    expect(onReplyInline.mock.calls[0][0].id).toBe(ROOT_ID);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it.each([
    ['시스템 줄', message({type: 'system', body: '김인턴님이 들어왔어요'}), true, false],
    ['삭제된 메시지', message({state: 'deleted', body: undefined, deletedAtMs: BASE_MS}), true, false],
    ['승인 카드', message({type: 'approval_request'}), true, false],
    ['대기 중인 서버 사본', message(), true, true],
    ['핸들러가 없는 표면(스레드 안·계측 하네스)', message(), false, false],
  ] as const)('%s 은 밀리지 않는다', (_label, row, withHandler, standby) => {
    const onReplyInline = jest.fn();
    mountRow(row, actions(withHandler ? {onReplyInline} : {}), standby);
    const touch = finger(host());
    touch.down(X0, Y0);
    expect(touch.move(X0 - 90, Y0)).toBe(false);
    touch.up();
    expect(onReplyInline).not.toHaveBeenCalled();
  });

  it('길게 눌러 시트가 열린 손가락은 그 뒤에 움직여도 밀지 않고, 새 터치는 다시 민다', () => {
    const onReplyInline = jest.fn();
    mountRow(message(), actions({onReplyInline}));
    const touch = finger(host());
    touch.down(X0, Y0);
    fireEvent(screen.getByTestId('message-row'), 'touchStart', {
      nativeEvent: {pageX: X0, pageY: Y0, locationX: X0, locationY: Y0},
    });
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(touch.move(X0 - 90, Y0)).toBe(false);
    touch.up();
    expect(onReplyInline).not.toHaveBeenCalled();

    // 다음 터치는 시트가 열려 있지 않은 새 제스처다.
    const next = finger(host());
    next.down(X0, Y0);
    expect(next.move(X0 - 90, Y0)).toBe(true);
    next.up();
    expect(onReplyInline).toHaveBeenCalledTimes(1);
  });

  async function pressSheetReply(row: Message, rowActions: MessageRowActions) {
    mountRow(row, rowActions);
    fireEvent(screen.getByTestId('message-row'), 'touchStart', {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    });
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    fireEvent.press(screen.getByTestId('sheet-reply'));
    // 행동은 시트가 미끄러져 내린 뒤에 불린다(#4318).
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
  }

  it('시트의 「답글 달기」는 같은 입력칸을 연다(VoiceOver 의 길) — 이미 답글인 행에도 서고 스레드 화면은 열지 않는다', async () => {
    const onReplyInline = jest.fn();
    const onOpenThread = jest.fn();
    const reply = message({id: REPLY_ID, rootId: ROOT_ID, seq: 11});
    await pressSheetReply(reply, actions({onReplyInline, onOpenThread}));
    expect(onReplyInline).toHaveBeenCalledTimes(1);
    expect(onReplyInline.mock.calls[0][0].id).toBe(REPLY_ID); // 민 행 — 루트 계산은 대상이 한다
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it('입력칸으로 열 수 없는 행(승인 카드)의 「답글 달기」는 예전처럼 스레드를 연다', async () => {
    const onReplyInline = jest.fn();
    const onOpenThread = jest.fn();
    await pressSheetReply(message({type: 'approval_request'}), actions({onReplyInline, onOpenThread}));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onReplyInline).not.toHaveBeenCalled();
  });
});
