import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PinnedMessageWire} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  applyPinned,
  emptyPins,
  PIN_ROW_MARK,
  type PinMap,
} from '@momo/core/features/timeline/pins';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 답글은 **읽는 자리에서** 고정된다 (이슈 #1146 M1).
//
// #1112 는 웹 스레드 패널에 그 문장을 적어 두고 실행했다 —
// *"a reply is pinned from where it is read, like every other action."* 폰은
// 같은 날 그것을 빠뜨렸고, 그래서 한 제품의 두 화면이 같은 행에 대해 다른 액션
// 목록을 내놓았다. 스레드에서 고정하려면 패널을 닫고 채널에서 그 답글을 찾아야
// 했는데, 답글은 **채널 목록에서 잘 안 보이는 것**이 존재 이유의 절반이다.
//
// 이 파일이 지키는 것은 배선 두 가닥이다: 핸들러(`onTogglePin`)와 지도(`pins`).
// 둘 중 하나만 있으면 조용히 틀린다 — 지도 없이 핸들러만 주면 이미 고정된 답글이
// 「고정하기」라고 말하고, 누르는 순간 고정을 **푼다**.
//
// `onQuote` 의 부재는 여전히 부재다. 그것은 잊은 것이 아니라 판정이고, 근거는
// `ThreadPanel` 머리말에 있다(결과가 이 패널 뒤의 컴포저로 떨어진다). 마지막
// describe 가 그 판정이 이 배선에 휩쓸려 뒤집히지 않았는지 본다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPLY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE_MS = 1_700_000_000_000;

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
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

const ROOT = message(10, {id: ROOT_ID, body: '배포 순서를 정리했습니다.'});
const REPLY = message(11, {
  id: REPLY_ID,
  rootId: ROOT_ID,
  authorMemberId: SELF,
  body: '롤백 절차도 여기 있습니다.',
});

function pinnedReply(): PinMap {
  const wire: PinnedMessageWire = {
    messageId: REPLY_ID,
    channelId: 'ch',
    seq: REPLY.seq,
    authorMemberId: SELF,
    type: 'text',
    state: 'sent',
    body: REPLY.body ?? null,
    createdAtMs: REPLY.createdAtMs,
    pinnedBy: SELF,
    pinnedAtMs: BASE_MS + 60_000,
  };
  return applyPinned(emptyPins(), wire);
}

/** `ThreadPanel` 이 실제로 읽는 만큼의 `useTimeline`. */
function renderThread(pins: PinMap) {
  const togglePin = jest.fn(async (_message: Message) => {});
  const timeline = {
    state: {messages: [ROOT, REPLY], oldestSeq: ROOT.seq, newestSeq: REPLY.seq},
    status: 'ready',
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => {},
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
    pins,
    pinsStatus: 'ready',
    reloadPins: () => {},
    togglePin,
  } as unknown as UseTimelineResult;
  render(
    <ThreadPanel
      root={ROOT}
      timeline={timeline}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      onClose={() => {}}
    />,
  );
  return {togglePin};
}

/** 답글 행의 시트를 연다. 행은 길게 눌러야 자기 액션을 내놓는다. */
function longPressReply(): void {
  const rows = screen.getAllByTestId('message-row');
  // 루트가 첫 줄이고 답글이 그 다음이다 (`[liveRoot, ...replies]`).
  const reply = rows[rows.length - 1];
  fireEvent(reply, 'touchStart', {
    nativeEvent: {touches: [{pageX: 100, pageY: 200}]},
  });
  fireEvent(screen.getAllByTestId('message-press').at(-1)!, 'longPress');
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  cleanup();
});

describe('스레드의 답글도 고정할 수 있다', () => {
  it('시트에 고정 항목이 선다 — 웹이 #1112 부터 하던 그대로', async () => {
    const {togglePin} = renderThread(emptyPins());
    await act(async () => {});
    longPressReply();
    const item = screen.getByTestId('sheet-pin');
    expect(item.props.accessibilityLabel).toBe('고정하기');
    fireEvent.press(item);
    expect(togglePin).toHaveBeenCalledTimes(1);
    expect(togglePin.mock.calls[0][0]).toMatchObject({id: REPLY_ID});
  });

  /**
   * 지도 없이 핸들러만 넘기면 **조용히 틀린다**: 이미 고정된 답글이 「고정하기」라고
   * 말하고, 누르면 고정을 푼다. 그래서 이 단언은 낱말 하나를 재는 것이 아니라 두
   * 가닥이 함께 배선됐는지를 잰다.
   */
  it('이미 고정된 답글은 「고정 해제하기」라고 말한다', async () => {
    renderThread(pinnedReply());
    await act(async () => {});
    longPressReply();
    expect(screen.getByTestId('sheet-pin').props.accessibilityLabel).toBe(
      '고정 해제하기',
    );
  });

  /** 그리고 그 사실이 행에 남는다 (#1146 M3) — 시트를 열지 않아도 보인다. */
  it('고정된 답글의 꼬리에 흔적이 선다', async () => {
    renderThread(pinnedReply());
    await act(async () => {});
    const marks = screen.getAllByTestId('pin-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].props.children).toBe(PIN_ROW_MARK);
  });
});

describe('그리고 인용의 부재는 여전히 판정이다', () => {
  /**
   * 고정을 이었다고 인용까지 딸려 들어오면 안 된다. 그 부재의 근거는 컴포저가
   * 이 패널 뒤에 있다는 것이고, 이 배선은 그 사실을 아무것도 바꾸지 않았다.
   */
  it('스레드 행에는 인용 항목이 없다', async () => {
    renderThread(emptyPins());
    await act(async () => {});
    longPressReply();
    expect(screen.queryByTestId('sheet-quote')).toBeNull();
  });
});
