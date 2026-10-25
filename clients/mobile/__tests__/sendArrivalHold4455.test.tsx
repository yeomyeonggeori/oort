import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage, TimelineItem} from '@momo/core/features/timeline/model';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, Dimensions, StyleSheet} from 'react-native';

import {
  SEND_ARRIVE_EASE,
  SEND_ARRIVE_HOLD_SLACK_MS,
  SEND_ARRIVE_MS,
} from '../src/design/motion';
import {CONV} from '../src/features/conversation/convDesign';
import {line} from '../src/design/tokens';
import {CONV_ICON_SIZE} from '../src/design/icons';
import {FixedScheme} from '../src/design/theme';
import {ReduceMotionRefContext} from '../src/features/conversation/LandedTintFade';
import {PendingRow, slowMarkGutterTop} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {
  arrivalsInFlight,
  holdArrival,
  holdSettledArrivals,
  markArrived,
  resetArrivedForTest,
  subscribeArrivals,
} from '../src/features/conversation/sendArrival';
import {SEND_SLOW_MS} from '../src/features/conversation/sendSlow';

// =============================================================================
// #4455 design-review r1 H1 — 확정본이 등장 도중에 와도 메아리를 자리에 둔다.
//
// 메아리의 오름은 메아리 자신의 transform 이고, 서버 사본이 오면 키가 `p-<clientMsgId>` → `m-<seq>` 로
// 바뀌어 메아리가 언마운트된다. 등장이 끝나기 전에 확정본이 오면 남은 오름이 한 번에 사라지므로(r1 이 이
// 면을 짚었다: 확정이 131ms 에 온 보내기가 이미 20회 원본에 있었다), 오름이 도는 동안은 확정본 자리에
// 같은 키의 메아리를 그대로 둔다(`sendArrival.ts`). 여기서 재는 것:
//   - 순수 함수 `holdSettledArrivals` 의 짝 짓기 규칙(한 번씩·보낸 순서·채널·미정착은 건드리지 않음)
//   - 장부 `holdArrival` 의 시계(보류는 시간으로만 끝난다)와 구독 참조
//   - `PendingRow` 가 **오름이 도는 행만** 적는다
//   - `Timeline` 에서 같은 인스턴스가 이어진다(애니메이션 한 번, 확정본은 보류가 끝난 뒤에 선다)
// 그리고 같은 리뷰의 M2(시계 상자 줄바꿈 방지)·M3(글자 배율)·L2(곡선 고정)를 **관계**로 단정한다.
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
const NOW = 1_700_000_000_000;

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

const flat = (style: unknown): Record<string, any> =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, any>;

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
// 순수 함수: 확정본 자리에 메아리를 되돌려 세운다
// -----------------------------------------------------------------------------
describe('holdSettledArrivals — 짝 짓기', () => {
  const arrival = (pending: PendingMessage, startsGroup = true) => ({
    pending,
    startsGroup,
    untilMs: NOW + SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS,
  });

  it('오름이 도는 메아리가 없으면 받은 배열을 그대로 돌려준다(참조 동일 — memo 를 지킨다)', () => {
    const items = [item(message(1)), item(message(2))];
    expect(holdSettledArrivals(items, [])).toBe(items);
  });

  it('확정본 항목을 같은 키(`p-<clientMsgId>`)의 메아리 항목으로 바꾼다 — 자리·머리 행 여부 그대로', () => {
    const items = [item(message(1)), item(message(2)), item(mine(3))];
    const out = holdSettledArrivals(items, [arrival(echo(), false)]);
    expect(out).not.toBe(items);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
    expect(out[2]).toEqual({
      kind: 'pending',
      key: 'p-c-1',
      pending: echo(),
      // 메아리가 마운트될 때의 모양이다(확정본의 값이 아니다).
      startsGroup: false,
    });
    // 원본 배열은 건드리지 않는다.
    expect(items[2].kind).toBe('message');
  });

  it('메아리가 아직 자기 키로 서 있으면(미정착) 건드리지 않는다', () => {
    const own: TimelineItem = {kind: 'pending', key: 'p-c-1', pending: echo(), startsGroup: true};
    const items = [item(message(1)), item(message(2)), own];
    expect(holdSettledArrivals(items, [arrival(echo())])).toBe(items);
  });

  it('짝이 아닌 확정본은 그대로다 — 다른 사람·다른 글·sinceSeq 이하·다른 채널', () => {
    for (const other of [
      mine(3, {authorMemberId: OTHER}),
      mine(3, {body: '다른 글'}),
      mine(2),
      mine(3, {channelId: 'other-channel'}),
    ]) {
      const items = [item(message(1)), item(other)];
      expect(holdSettledArrivals(items, [arrival(echo())])).toBe(items);
    }
  });

  it('메아리 하나는 확정본 하나만 대신한다 — 같은 글을 두 번 보내도 보낸 순서대로 하나씩', () => {
    const first = echo({clientMsgId: 'c-1'});
    const second = echo({clientMsgId: 'c-2', createdAtMs: NOW + 50});
    const items = [item(message(1)), item(message(2)), item(mine(3)), item(mine(4), false)];
    const out = holdSettledArrivals(items, [arrival(first), arrival(second, false)]);
    expect(out.map(i => i.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'p-c-2']);
    // 확정본이 하나뿐이면 둘째 메아리는 자리를 못 얻는다.
    const single = holdSettledArrivals(items.slice(0, 3), [arrival(first), arrival(second)]);
    expect(single.map(i => i.key)).toEqual(['m-1', 'm-2', 'p-c-1']);
  });

  it('첨부가 붙은 전송은 첨부 id 까지 맞아야 짝이다(코어 `confirmsPending`)', () => {
    const file = {id: 'att-1', name: 'a.png', mime: 'image/png', sizeBytes: 1};
    const withFile = echo({body: '', attachments: [file]});
    const items = [item(message(1)), item(message(2)), item(mine(3, {body: ''}))];
    // 확정본에 첨부가 없으면 짝이 아니다.
    expect(holdSettledArrivals(items, [arrival(withFile)])).toBe(items);
    const matched = [item(message(1)), item(message(2)), item(mine(3, {body: '', attachments: [file]}))];
    expect(holdSettledArrivals(matched, [arrival(withFile)])[2].key).toBe('p-c-1');
  });
});

// -----------------------------------------------------------------------------
// 장부: 보류는 시간으로만 끝난다
// -----------------------------------------------------------------------------
describe('holdArrival — 장부의 시계와 구독', () => {
  it('SEND_ARRIVE_MS + 여유 동안만 적혀 있고, 그 뒤에는 저절로 풀린다', () => {
    expect(arrivalsInFlight()).toHaveLength(0);
    holdArrival(echo(), true, NOW);
    expect(arrivalsInFlight()).toHaveLength(1);
    expect(arrivalsInFlight()[0].untilMs).toBe(NOW + SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS);
    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - 1);
    });
    expect(arrivalsInFlight()).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(arrivalsInFlight()).toHaveLength(0);
  });

  it('여유는 한 프레임(≈17ms)보다 길다 — 네이티브 구동이 마운트보다 늦게 시작하고 마지막 프레임이 걸린다', () => {
    expect(SEND_ARRIVE_HOLD_SLACK_MS).toBeGreaterThanOrEqual(17);
  });

  it('바뀔 때만 새 참조다 — 구독자는 적을 때와 풀릴 때 한 번씩 불린다', () => {
    const listener = jest.fn();
    const off = subscribeArrivals(listener);
    const before = arrivalsInFlight();
    expect(arrivalsInFlight()).toBe(before);
    holdArrival(echo(), true, NOW);
    expect(listener).toHaveBeenCalledTimes(1);
    const during = arrivalsInFlight();
    expect(during).not.toBe(before);
    expect(arrivalsInFlight()).toBe(during);
    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS);
    });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    holdArrival(echo({clientMsgId: 'c-9'}), true, NOW);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('같은 메아리를 다시 적으면 시계가 새로 시작한다(타이머가 둘 쌓이지 않는다)', () => {
    holdArrival(echo(), true, NOW);
    act(() => {
      jest.advanceTimersByTime(200);
    });
    holdArrival(echo(), true, NOW + 200);
    expect(jest.getTimerCount()).toBe(1);
    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - 1);
    });
    expect(arrivalsInFlight()).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// PendingRow: 오름이 도는 행만 적는다
// -----------------------------------------------------------------------------
describe('PendingRow — 장부에 적는 조건', () => {
  const row = (pending: PendingMessage) => (
    <FixedScheme scheme="dark">
      <PendingRow pending={pending} startsGroup directory={DIRECTORY} />
    </FixedScheme>
  );

  it('등장이 도는 행은 마운트 때 적고, 그 사본의 머리 행 여부를 함께 든다', () => {
    spyTiming();
    render(row(echo()));
    expect(arrivalsInFlight()).toHaveLength(1);
    expect(arrivalsInFlight()[0]).toMatchObject({startsGroup: true, pending: {clientMsgId: 'c-1'}});
  });

  it.each([
    ['동작 줄이기', () => ({reduce: true, pending: echo()})],
    ['자격 창 밖(보낸 지 1초 넘음)', () => ({reduce: false, pending: echo({createdAtMs: NOW - 5_000})})],
    ['이미 실패한 행', () => ({reduce: false, pending: echo({status: 'failed'})})],
  ] as const)('%s: 움직이지 않으니 적지 않는다(적으면 확정본이 괜히 가려진다)', (_name, make) => {
    spyTiming();
    const {reduce, pending} = make();
    render(
      <ReduceMotionRefContext.Provider value={{current: reduce}}>
        {row(pending)}
      </ReduceMotionRefContext.Provider>,
    );
    expect(arrivalsInFlight()).toHaveLength(0);
  });

  it('이미 올라온 적이 있는 메아리(가상화 재마운트)는 다시 적지 않는다', () => {
    spyTiming();
    markArrived('c-1');
    render(row(echo()));
    expect(arrivalsInFlight()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Timeline: 같은 인스턴스가 이어진다
// -----------------------------------------------------------------------------
describe('Timeline — 확정본이 등장 도중에 와도 오름이 끊기지 않는다', () => {
  const history = [message(1), message(2)];
  const tl = (messages: Message[], pending: PendingMessage[]) => (
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={NOW + 60_000}
      pending={pending}
    />
  );
  /** 보이는 확정본 행(남의 글 2개 + 확정된 내 글) 개수. */
  const confirmedRows = () => screen.queryAllByTestId('message-press').length;
  const echoRows = () => screen.queryAllByTestId('pending-row').length;

  it.each([
    ['POST 응답 경로 — 확정본과 pending 제거가 한 렌더', 30],
    ['등장 중간', 150],
    ['등장 끝 무렵', 280],
  ] as const)('%s (%dms): 확정본이 와도 메아리가 그 자리에 있고 오름은 한 번만 돈다', (_name, arrivesAt) => {
    const timing = spyTiming();
    const view = render(tl(history, [echo()]));
    expect(echoRows()).toBe(1);
    expect(confirmedRows()).toBe(2);
    expect(timing).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(arrivesAt);
    });
    // 확정본이 들어오고 훅의 pending 도 같은 틱에 비었다(`useTimeline.post`).
    view.rerender(tl([...history, mine(3)], []));
    expect(echoRows()).toBe(1);
    expect(confirmedRows()).toBe(2);
    expect(screen.getByText('내일 오전에 봐요')).toBeTruthy();
    // 같은 인스턴스다 — 등장을 다시 시작하지 않았다.
    expect(timing).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('내일 오전에 봐요')).toHaveLength(1);

    // 보류가 끝나는 순간 서버 사본이 선다.
    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS - arrivesAt);
    });
    expect(echoRows()).toBe(0);
    expect(confirmedRows()).toBe(3);
    expect(screen.queryAllByText('내일 오전에 봐요')).toHaveLength(1);
    expect(timing).toHaveBeenCalledTimes(1);
  });

  it('확정본이 오기 전에 보류 시간이 지났으면 평소처럼 바로 바뀐다(되돌려 세울 것이 없다)', () => {
    spyTiming();
    const view = render(tl(history, [echo()]));
    act(() => {
      jest.advanceTimersByTime(SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS + 40);
    });
    view.rerender(tl([...history, mine(3)], []));
    expect(echoRows()).toBe(0);
    expect(confirmedRows()).toBe(3);
  });

  it('등장이 안 도는 행(이미 올라온 적이 있음)은 확정본이 오면 바로 바뀐다', () => {
    spyTiming();
    markArrived('c-1');
    const view = render(tl(history, [echo()]));
    view.rerender(tl([...history, mine(3)], []));
    expect(echoRows()).toBe(0);
    expect(confirmedRows()).toBe(3);
  });

  it('보류 중에 상대 메시지가 더 와도 내 글의 자리(seq 순서)는 그대로다', () => {
    spyTiming();
    const view = render(tl(history, [echo()]));
    act(() => {
      jest.advanceTimersByTime(100);
    });
    view.rerender(tl([...history, mine(3), message(4)], []));
    const keys = screen
      .getByTestId('timeline-list')
      .props.data.map((entry: {key: string}) => entry.key);
    // m-3 자리에 같은 키의 메아리, 뒤에 상대의 m-4.
    expect(keys.slice(-2)).toEqual(['p-c-1', 'm-4']);
  });
});

// -----------------------------------------------------------------------------
// M2 · M3 · L2 — 같은 리뷰의 나머지를 관계로
// -----------------------------------------------------------------------------
describe('느린 전송 시계 — 줄바꿈 방지(M2)·글자 배율(M3)', () => {
  const slowEcho = (startsGroup: boolean) =>
    render(
      <FixedScheme scheme="dark">
        <PendingRow
          pending={echo({createdAtMs: NOW - SEND_SLOW_MS})}
          startsGroup={startsGroup}
          directory={DIRECTORY}
        />
      </FixedScheme>,
    );

  /** 요소에서 위로 올라가며 `match` 를 만족하는 첫 조상(자기 포함)의 펼친 스타일. */
  function ancestorStyle(
    element: {parent: unknown; props: {style?: unknown}} | null,
    match: (style: Record<string, any>) => boolean,
  ): Record<string, any> | null {
    let node = element;
    for (let hops = 0; node !== null && hops < 8; hops += 1) {
      const style = flat(node.props?.style);
      if (match(style)) return style;
      node = node.parent as typeof element;
    }
    return null;
  }

  it('M2: 시계 상자의 줄 안 몫(폭 + 마진 + 앞 간격)이 0 이라 혼자 줄바꿈되지 않는다', () => {
    slowEcho(true);
    const host = ancestorStyle(
      screen.getByTestId('pending-slow') as never,
      style => style.width === 0 && style.height === 0,
    );
    expect(host).not.toBeNull();
    // Yoga(`FlexLine.cpp`): 줄에 넣을지는 `쓴 폭 + 항목 폭 + 항목 마진 + 앞 간격 > 줄 폭` 이다.
    expect((host as {width: number}).width + (host as {marginLeft: number}).marginLeft + CONV.whoGap).toBe(0);
  });

  it('M2: 시계가 서는 자리(시각 오른쪽 끝에서 whoGap)는 그대로다 — 마진이 당긴 만큼 시계가 띄워 선다', () => {
    slowEcho(true);
    const host = ancestorStyle(
      screen.getByTestId('pending-slow') as never,
      style => style.width === 0 && style.height === 0,
    ) as {marginLeft: number};
    const clock = flat(screen.getByTestId('pending-slow').props.style);
    // 시각 끝 → (앞 간격 whoGap + 음수 마진) → 상자 → 시계 left.
    expect(CONV.whoGap + host.marginLeft + clock.left).toBe(CONV.whoGap);
  });

  it('M3: 이어지는 행 시계의 높이는 글자 배율을 곱한 첫 줄 가운데다', () => {
    // 배율이 2 면 첫 줄 중심은 line.body / 2 만큼 더 아래다.
    expect(slowMarkGutterTop(2) - slowMarkGutterTop(1)).toBeCloseTo(line.body / 2, 5);
    // 시계의 중심 = 말풍선 안쪽 위 여백 + 첫 줄의 가운데(+ 행 위 여백).
    for (const scale of [1, 1.35, 2]) {
      const center = slowMarkGutterTop(scale) + CONV_ICON_SIZE.clock / 2;
      const firstLineCenter = 3 + CONV.bubblePadY + (line.body * scale) / 2;
      expect(center).toBeCloseTo(firstLineCenter, 5);
    }
  });

  it('M3: 화면의 글자 배율(useWindowDimensions)이 실제 행에 반영된다', () => {
    slowEcho(false);
    const mark = screen.getByTestId('pending-slow');
    const gutter = ancestorStyle(
      mark.parent as never,
      style => style.position === 'absolute' && style.width !== undefined,
    ) as {top: number};
    expect(gutter.top).toBeCloseTo(slowMarkGutterTop(Dimensions.get('window').fontScale), 5);
  });
});

describe('곡선 — 제어점을 고정한다(L2)', () => {
  /** Flutter `Curves.easeOutCubic` = `Cubic(0.215, 0.61, 0.355, 1.0)` 를 따로 푼 기준값. */
  function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
    const at = (a: number, b: number, s: number) =>
      3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i += 1) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  }

  it.each([0.1, 0.25, 0.5, 0.75, 0.9])('x=%s 에서 Buzz easeOutCubic 과 같다', x => {
    expect(SEND_ARRIVE_EASE(x)).toBeCloseTo(cubicBezier(0.215, 0.61, 0.355, 1, x), 2);
    // 기준값이 곡선 밖(예: 선형)으로 흘러가지 않았다는 짝 단정.
    expect(cubicBezier(0.215, 0.61, 0.355, 1, x)).toBeGreaterThan(x);
  });
});
