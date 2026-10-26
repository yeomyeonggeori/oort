import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage, TimelineItem} from '@momo/core/features/timeline/model';
import {act, cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {Animated, View} from 'react-native';

import {SEND_ARRIVE_HOLD_SLACK_MS, SEND_ARRIVE_MS} from '../src/design/motion';
import {FixedScheme} from '../src/design/theme';
import {PendingRow} from '../src/features/conversation/MessageRow';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {Timeline} from '../src/features/conversation/Timeline';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';
import {
  ARRIVAL_SURFACE_CHANNEL,
  arrivalsInFlight,
  holdArrival,
  holdSettledArrivals,
  resetArrivedForTest,
  threadArrivalSurface,
} from '../src/features/conversation/sendArrival';

// =============================================================================
// #4455 design-review r2 M4 — 보류는 메아리를 그린 표면에서만 읽는다.
//
// 보낸 메시지의 등장 보류(`sendArrival.ts`)는 모듈 전역 장부다. 스레드 답글의 메아리는 **스레드 목록에만** 서지만(코어
// `useTimeline` 의 `channelPending` 이 채널 목록에서 거른다) 확정되면 채널 목록에도 평범한 행으로 선다. 보류가 표면을 가리지
// 않으면 아래 깔린 채널 목록이 스레드에서 적힌 항목을 읽어, 확정된 답글을 약 360ms 동안 메아리로 한 번 더 그렸다(패널 뒤라
// 안 보이지만 코어가 지킨다고 적은 불변식을 깨고, 패널을 360ms 안에 닫으면 채널 꼬리의 높이 변화가 보일 수 있다).
//
// 여기서 재는 것(바깥에서 안으로):
//   1. 순수 함수 `holdSettledArrivals` 가 자기 표면의 항목만 읽는다(채널·스레드 루트 둘)
//   2. 장부 `holdArrival` 이 표면을 적는다(기본: 채널 목록)
//   3. `PendingRow` 가 받은 `arrivalSurface` 를 장부에 적는다
//   4. `Timeline` 둘(채널·스레드 표면)을 함께 세워 스레드 답글이 확정될 때 채널 목록에 메아리가 마운트되지 않는다
//   5. 진짜 `ThreadPanel` 이 자기 루트의 표면 이름을 `Timeline` 에 준다(배선)
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ROOT_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const NOW = 1_700_000_000_000;
const HOLD_MS = SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS;

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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
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
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: NOW - 600_000 + seq * 1000,
    ...over,
  };
}

function echo(over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '내일 오전에 봐요',
    createdAtMs: NOW,
    sinceSeq: 2,
    status: 'sending',
    ...over,
  };
}

/** 내가 보낸 글의 확정본. */
const mine = (seq: number, over: Partial<Message> = {}): Message =>
  message(seq, {authorMemberId: SELF, body: '내일 오전에 봐요', createdAtMs: NOW + 100, ...over});

const item = (m: Message, startsGroup = true): TimelineItem => ({
  kind: 'message',
  key: `m-${m.seq}`,
  message: m,
  startsGroup,
});

function spyTiming() {
  return jest
    .spyOn(Animated, 'timing')
    .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
}

beforeEach(() => {
  resetArrivedForTest();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetArrivedForTest();
});

// -----------------------------------------------------------------------------
// 1. 순수 함수
// -----------------------------------------------------------------------------
describe('holdSettledArrivals — 자기 표면의 항목만 읽는다', () => {
  const arrival = (pending: PendingMessage, surface: string) => ({
    pending,
    startsGroup: true,
    untilMs: NOW + HOLD_MS,
    surface,
  });
  const list = () => [item(message(1)), item(message(2)), item(mine(3))];

  it('표면 이름은 채널 목록과 스레드 루트마다 다르다', () => {
    expect(ARRIVAL_SURFACE_CHANNEL).toBe('channel');
    expect(threadArrivalSurface('root-A')).toBe('thread:root-A');
    expect(threadArrivalSurface('root-A')).not.toBe(threadArrivalSurface('root-B'));
    expect(threadArrivalSurface('root-A')).not.toBe(ARRIVAL_SURFACE_CHANNEL);
  });

  it('스레드에서 적힌 메아리를 채널 목록(기본 표면)은 읽지 않는다 — 받은 배열 그대로', () => {
    const items = list();
    expect(holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))])).toBe(items);
    expect(
      holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))], ARRIVAL_SURFACE_CHANNEL),
    ).toBe(items);
  });

  it('같은 스레드 표면은 읽는다 — 확정본 자리에 같은 키의 메아리', () => {
    const items = list();
    const out = holdSettledArrivals(
      items,
      [arrival(echo(), threadArrivalSurface('root-A'))],
      threadArrivalSurface('root-A'),
    );
    expect(out).not.toBe(items);
    expect(out.map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1']);
  });

  it('다른 스레드 루트의 표면은 읽지 않는다', () => {
    const items = list();
    expect(
      holdSettledArrivals(items, [arrival(echo(), threadArrivalSurface('root-A'))], threadArrivalSurface('root-B')),
    ).toBe(items);
  });

  it('채널에서 적힌 메아리를 스레드 목록은 읽지 않는다', () => {
    const items = list();
    expect(
      holdSettledArrivals(items, [arrival(echo(), ARRIVAL_SURFACE_CHANNEL)], threadArrivalSurface('root-A')),
    ).toBe(items);
  });

  it('두 표면에 각자 적힌 항목이 섞여 있어도 각자 자기 것만 대신한다', () => {
    // 같은 글을 채널(c-1)과 스레드(c-2)에서 따로 보냈다 — 확정본이 둘이다.
    const channelEcho = echo({clientMsgId: 'c-1'});
    const threadEcho = echo({clientMsgId: 'c-2', createdAtMs: NOW + 50});
    const items = [item(message(1)), item(message(2)), item(mine(3)), item(mine(4), false)];
    const ledger = [arrival(channelEcho, ARRIVAL_SURFACE_CHANNEL), arrival(threadEcho, threadArrivalSurface('root-A'))];
    expect(holdSettledArrivals(items, ledger).map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'm-4']);
    expect(holdSettledArrivals(items, ledger, threadArrivalSurface('root-A')).map(entry => entry.key)).toEqual([
      'm-1',
      'm-2',
      'p-c-2',
      'm-4',
    ]);
  });
});

// -----------------------------------------------------------------------------
// 2·3. 장부와 PendingRow
// -----------------------------------------------------------------------------
describe('장부는 그린 표면을 적는다', () => {
  it('holdArrival: 표면을 안 주면 채널 목록이고, 주면 그 표면이다', () => {
    holdArrival(echo({clientMsgId: 'c-1'}), true, NOW);
    holdArrival(echo({clientMsgId: 'c-2'}), true, NOW, threadArrivalSurface('root-A'));
    expect(arrivalsInFlight().map(entry => [entry.pending.clientMsgId, entry.surface])).toEqual([
      ['c-1', ARRIVAL_SURFACE_CHANNEL],
      ['c-2', 'thread:root-A'],
    ]);
  });

  it('PendingRow: 받은 arrivalSurface 를 장부에 적는다(안 받으면 채널 목록)', () => {
    spyTiming();
    render(
      <FixedScheme scheme="dark">
        <PendingRow
          pending={echo({clientMsgId: 'c-thread'})}
          startsGroup
          directory={DIRECTORY}
          arrivalSurface={threadArrivalSurface('root-A')}
        />
        <PendingRow pending={echo({clientMsgId: 'c-channel'})} startsGroup directory={DIRECTORY} />
      </FixedScheme>,
    );
    const bySurface = Object.fromEntries(arrivalsInFlight().map(entry => [entry.pending.clientMsgId, entry.surface]));
    expect(bySurface).toEqual({'c-thread': 'thread:root-A', 'c-channel': ARRIVAL_SURFACE_CHANNEL});
  });
});

// -----------------------------------------------------------------------------
// 4. Timeline 둘 — 채널 목록이 스레드 답글의 메아리를 또 그리지 않는다
// -----------------------------------------------------------------------------
describe('Timeline 둘 — 스레드 답글이 확정될 때 채널 목록에 메아리가 마운트되지 않는다', () => {
  const history = [message(1), message(2)];
  const replyFor = (seq: number) => mine(seq, {rootId: ROOT_ID});

  const pair = (messages: Message[], threadPending: PendingMessage[]) => (
    <View>
      <View testID="channel-surface">
        <Timeline
          messages={messages}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={NOW + 60_000}
          // 채널 목록은 답글의 메아리를 받지 않는다(코어 `channelPending`).
          pending={[]}
        />
      </View>
      <View testID="thread-surface">
        <Timeline
          messages={messages}
          directory={DIRECTORY}
          status="ready"
          myMemberId={SELF}
          nowMs={NOW + 60_000}
          pending={threadPending}
          markReplies={false}
          showRollup={false}
          arrivalSurface={threadArrivalSurface(ROOT_ID)}
        />
      </View>
    </View>
  );

  const surface = (id: 'channel-surface' | 'thread-surface') => within(screen.getByTestId(id));
  /** 목록 항목 키 중 메시지(`m-`)·메아리(`p-`)만 — 날짜 구분선은 거른다. */
  const keys = (id: 'channel-surface' | 'thread-surface') =>
    (surface(id)
      .getByTestId('timeline-list')
      .props.data.map((entry: {key: string}) => entry.key) as string[]).filter(key => /^[mp]-/.test(key));

  it.each([
    ['POST 응답 경로 — 확정본과 pending 제거가 한 렌더', 30],
    ['등장 중간', 150],
  ] as const)('%s (%dms): 채널 목록은 확정된 답글을 바로 확정본으로 그리고, 스레드는 보류한다', (_name, arrivesAt) => {
    const timing = spyTiming();
    const view = render(pair(history, [echo()]));
    // 마운트: 메아리는 스레드 목록에만 서고, 오름은 한 번만 돈다.
    expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(1);
    expect(surface('channel-surface').queryAllByTestId('pending-row')).toHaveLength(0);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(arrivalsInFlight().map(entry => entry.surface)).toEqual([threadArrivalSurface(ROOT_ID)]);

    act(() => {
      jest.advanceTimersByTime(arrivesAt);
    });
    // 확정본이 두 목록 모두에 들어오고 스레드의 pending 도 같은 틱에 비었다.
    view.rerender(pair([...history, replyFor(3)], []));

    // 채널 목록: 메아리를 한 번 더 그리지 않는다(이 PR 이전에는 약 360ms 동안 `p-c-1`).
    expect(surface('channel-surface').queryAllByTestId('pending-row')).toHaveLength(0);
    expect(keys('channel-surface')).toEqual(['m-1', 'm-2', 'm-3']);
    // 스레드 목록: 오름이 도는 동안 확정본 자리를 메아리가 지킨다.
    expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(1);
    expect(keys('thread-surface')).toEqual(['m-1', 'm-2', 'p-c-1']);
    // 두 목록 어디서도 오름이 다시 시작하지 않았다.
    expect(timing).toHaveBeenCalledTimes(1);

    // 보류가 끝나면 스레드도 확정본이 서고, 채널 목록은 그대로다.
    act(() => {
      jest.advanceTimersByTime(HOLD_MS - arrivesAt);
    });
    expect(surface('thread-surface').queryAllByTestId('pending-row')).toHaveLength(0);
    expect(keys('thread-surface')).toEqual(['m-1', 'm-2', 'm-3']);
    expect(keys('channel-surface')).toEqual(['m-1', 'm-2', 'm-3']);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('채널에서 보낸 글의 보류는 채널 목록이 읽는다(표면을 나눈 것이 보류를 끈 것이 아니다)', () => {
    spyTiming();
    const channelOnly = (messages: Message[], pending: PendingMessage[]) => (
      <Timeline
        messages={messages}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={NOW + 60_000}
        pending={pending}
      />
    );
    const view = render(channelOnly(history, [echo()]));
    expect(arrivalsInFlight().map(entry => entry.surface)).toEqual([ARRIVAL_SURFACE_CHANNEL]);
    act(() => {
      jest.advanceTimersByTime(100);
    });
    view.rerender(channelOnly([...history, mine(3)], []));
    expect(screen.queryAllByTestId('pending-row')).toHaveLength(1);
    expect(
      (screen.getByTestId('timeline-list').props.data.map((entry: {key: string}) => entry.key) as string[]).filter(
        key => /^[mp]-/.test(key),
      ),
    ).toEqual(['m-1', 'm-2', 'p-c-1']);
  });
});

// -----------------------------------------------------------------------------
// 5. 진짜 ThreadPanel 의 배선
// -----------------------------------------------------------------------------
describe('ThreadPanel — 자기 루트의 표면 이름을 목록에 준다', () => {
  const ROOT = message(1, {id: ROOT_ID});
  const OTHER_LINE = message(2);

  // 패널은 `loadReplies` 의 동일성이 바뀌면 답글을 다시 읽는다 — 확정으로 `timeline` 객체가 바뀌어도 읽기가 다시 돌지 않게 한 함수를 쓴다.
  const loadReplies = async () => {};

  /** `threadSelfSend.test.tsx` 의 하니스와 같은 만큼의 `useTimeline` — 답글 메아리와 확정만 움직인다. */
  const timelineOf = (confirmed: boolean): UseTimelineResult => {
    const reply = mine(3, {rootId: ROOT_ID});
    const messages = confirmed ? [ROOT, OTHER_LINE, reply] : [ROOT, OTHER_LINE];
    return {
      state: {messages, oldestSeq: 1, newestSeq: messages[messages.length - 1].seq},
      status: 'ready',
      resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
      recoveryMarkers: [],
      pending: [],
      send: async () => {},
      resend: async () => {},
      toggleReaction: async () => {},
      editBody: async () => {},
      removeMessage: async () => {},
      loadReplies,
      sendReply: async () => {},
      repliesPending: () => (confirmed ? [] : [echo()]),
      loadOlder: async () => {},
      reload: () => {},
      loadingOlder: false,
      reachedStart: true,
      reactions: {},
    } as unknown as UseTimelineResult;
  };

  const stack = (confirmed: boolean) => {
    const timeline = timelineOf(confirmed);
    return (
      <View>
        <View testID="channel-surface">
          <Timeline
            messages={timeline.state.messages}
            directory={DIRECTORY}
            status="ready"
            myMemberId={SELF}
            nowMs={NOW + 60_000}
            pending={[]}
          />
        </View>
        <View testID="thread-surface">
          <ThreadPanel
            root={ROOT}
            timeline={timeline}
            directory={DIRECTORY}
            myMemberId={SELF}
            nowMs={NOW + 60_000}
            onClose={() => {}}
          />
        </View>
      </View>
    );
  };

  it('패널의 메아리는 스레드 표면으로 적히고, 확정된 뒤에도 채널 목록은 메아리를 그리지 않는다', async () => {
    spyTiming();
    const view = render(stack(false));
    // 패널이 마운트 때 시작하는 답글 읽기(`loadReplies`)가 끝나도록 act 안에서 비운다.
    await act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });
    expect(arrivalsInFlight()).toHaveLength(1);
    expect(arrivalsInFlight()[0].surface).toBe(threadArrivalSurface(ROOT_ID));
    expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    view.rerender(stack(true));
    // 패널은 보류하고, 아래 깔린 채널 목록은 확정본을 그대로 그린다.
    expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(1);
    expect(within(screen.getByTestId('channel-surface')).queryAllByTestId('pending-row')).toHaveLength(0);
    expect(
      (within(screen.getByTestId('channel-surface'))
        .getByTestId('timeline-list')
        .props.data.map((entry: {key: string}) => entry.key) as string[]).filter(key => /^[mp]-/.test(key)),
    ).toEqual(['m-1', 'm-2', 'm-3']);

    act(() => {
      jest.advanceTimersByTime(HOLD_MS);
    });
    expect(within(screen.getByTestId('thread-surface')).queryAllByTestId('pending-row')).toHaveLength(0);
  });
});
